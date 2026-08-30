/**
 * One client session: a WebSocket to a browser, a pool of TCP sockets to peers, and a pump.
 *
 * This is cf-stream's Durable Object with its storage half removed. What is gone: R2 segments,
 * Postgres over Hyperdrive, SHA-1 verification, and the HTTP `Range` surface. What replaces them
 * is a single `ws.send()` per piece, which costs nothing — outgoing WebSocket messages are not
 * billed as requests — and no CPU beyond the copy.
 *
 * ## The cost model, which shapes everything below
 *
 * On the Workers Free plan the binding constraint is Durable Object **duration**: 13,000 GB-s a
 * day, billed as wall-clock × 128 MB for as long as the object cannot hibernate. Two facts follow.
 *
 *  1. **An open outbound TCP socket makes the object ineligible to hibernate.** So the peers are
 *     what cost money, and dropping them when nobody is watching is the single biggest lever.
 *     `nextAction` returning `"idle"` is that lever being pulled.
 *  2. **Duration is proportional to how long the download takes, not to how long the film runs.**
 *     The client holds the buffer, so the right thing is to race: take bytes as fast as the client
 *     grants credit, finish, and let go — not to pace delivery to playback and hold sockets open
 *     for ninety minutes.
 *
 * Alarms are billed 1:1 *and* cost a SQLite row write each, so `#arm` is the only place `setAlarm`
 * is called and it de-duplicates. Inbound WebSocket messages are billed 20:1, which makes them the
 * cheapest possible wake-up — so a credit message runs the pump inline rather than arming anything.
 *
 * ## The pump
 *
 * `#tick` is re-entrant and idempotent, and every piece of state it touches lives in a field
 * rather than a closure. That is not tidiness: a Durable Object invocation killed for exceeding
 * CPU never runs its `finally`, so liveness is decided by wall-clock staleness rather than by a
 * boolean nobody got to clear. Whatever the free plan's real CPU ceiling turns out to be — the
 * docs say 30 s per Durable Object request, the Workers page says 10 ms and does not carve
 * Durable Objects out — a killed tick costs a resumption, never data.
 */

import { DurableObject } from "cloudflare:workers";
import { settings, tailBytesFor, type Bindings, type Settings } from "./config.ts";
import {
  pieceLengthAt,
  pieceOfFileOffset,
  pieceRangeOfFile,
  pieceRangeOfWindow,
  resolveFile,
  type FileView,
  type TorrentLayout,
} from "./layout.ts";
import { PieceStore } from "./pieces.ts";
import {
  fetchRecords,
  peerKey,
  rankPeers,
  RecordsError,
  type PeerEntry,
  type PeerHealth,
} from "./records.ts";
import { nextAction, Scheduler, type SchedulerSnapshot } from "./schedule.ts";
import { DialSlots } from "./swarm/dials.ts";
import { PeerBlame, shouldRefreshSwarm, starvedPeers } from "./swarm/health.ts";
import { PeerSession } from "./swarm/peer.ts";
import { probePeers } from "./swarm/probe.ts";
import { generatePeerId } from "./wire/handshake.ts";
import { fromHex } from "./bytes.ts";
import {
  encodeControl,
  encodePiece,
  parseClientControl,
  type ServerControl,
} from "./wsproto.ts";

/** Sockets allowed to be connecting at once. A platform limit, not a tuning knob. */
const MAX_CONNECTING = 6;

/**
 * How long to let a batch of dials settle before looking again.
 *
 * Worth being brisk: a failed connect now releases its slot at the connect deadline, so the six
 * slots turn over about five times a second and a slow poll would waste them.
 */
const DIAL_SETTLE_MS = 250;

/**
 * Grace before judging a peer on its bitfield.
 *
 * A peer sends its bitfield (or BEP-6 `have all`) immediately after the handshake — measured at
 * ~340 bytes arriving in the same breath — so anything longer than this is generous.
 */
const BITFIELD_GRACE_MS = 2_500;

/** Rejected or unanswered blocks tolerated from a peer that has never delivered one. */
const MAX_MISSED_BEFORE_DROP = 24;

/** How often to tell the client what the swarm is doing. Outbound frames are free. */
const STAT_INTERVAL_MS = 5_000;

/** Identity, so a hibernated object can rebuild itself from the socket that woke it. */
interface SessionAttachment {
  readonly v: 1;
  readonly infoHash: string;
  readonly fileIndex: number | null;
}

/** What is worth keeping in storage between wakes. */
interface StoredRecords {
  readonly layout: TorrentLayout;
  readonly peers: readonly PeerEntry[];
  readonly health: readonly [string, PeerHealth][];
  readonly webseeds: readonly string[];
  readonly resolvedAt: number;
}

export class Session extends DurableObject<Bindings> {
  readonly #config: Settings;
  readonly #peerId = generatePeerId();

  #infoHash: string | null = null;
  #fileIndex: number | null = null;
  #layout: TorrentLayout | null = null;
  #file: FileView | null = null;
  #scheduler: Scheduler | null = null;

  readonly #peers = new Map<string, PeerSession>();
  readonly #pendingReads = new Map<
    string,
    Promise<{ peer: PeerSession; block: { index: number; begin: number; block: Uint8Array } | null }>
  >();
  #candidates: PeerEntry[] = [];
  #health = new Map<string, PeerHealth>();
  #store: PieceStore;
  #blame: PeerBlame;
  #dialSlots: DialSlots;
  /** Cancels every socket this generation owns. Replaced whenever the pool is torn down. */
  #era = new AbortController();

  #swarmResolvedAt = 0;
  #lastRefreshAt = 0;
  #failureStreak = 0;
  readonly #deadPeers = new Set<string>();
  readonly #goodPeers = new Set<string>();
  /**
   * Addresses `probe/` reported unreachable, kept separate from `#deadPeers`.
   *
   * `#deadPeers` is first-party evidence — this Worker actually tried the dial — and
   * `#reportHealth` posts it to bstream as `fail`. What the probe service saw is second-hand and
   * must not contaminate a table whose entire value is that every entry was independently
   * measured. It still gates `#dial`, same as `#deadPeers`; it is just never reported.
   */
  readonly #probeDead = new Set<string>();
  #probeInFlight = false;
  /** For `/debug` only — `#kickOffProbe` is fire-and-forget and otherwise logs nothing on success,
   * so without this there is no external way to tell a probe ever ran. */
  #lastProbe:
    | {
      at: number;
      sent: number;
      probed: number;
      truncated: boolean;
      useful: number;
      alive: number;
      dead: number;
      note?: string;
    }
    | null = null;
  /** How many times a peer has been requeued after going quiet. Bounded, so it cannot cycle. */
  readonly #silent = new Map<string, number>();

  /** Pieces the client has room for. Pre-granted once so the first bytes need no round trip. */
  #credit = 0;
  #lastDemandAt = Date.now();

  // Pump liveness. `#pumpStartedAt` is a timestamp rather than a flag because a killed invocation
  // cannot clear a flag, and a stuck flag would wedge the session forever.
  #pumpStartedAt = 0;
  #pumpQueued = false;
  #dirtyExit = false;
  #alarmArmedFor: number | null = null;

  #bytesOut = 0;
  #piecesOut = 0;
  #alarms = 0;
  #inbound = 0;
  #lastStatAt = 0;
  #lastNoPeersAt = 0;
  #closing = false;
  /**
   * Whether the *current* connection has been greeted.
   *
   * Not a property of the scheduler: a reconnect to a still-warm object finds the scheduler already
   * built, so a greeting tied to construction is sent once and never again — and a client that never
   * receives `ready` has no layout, no piece range, and nothing to do but wait.
   */
  #greeted = false;
  /** Whether this connection has already been told the session is finished. */
  #eofAnnounced = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.#config = settings(env);
    // Pieces assembled at once — the width of the request window.
    //
    // Thirty-two. Widening it to 64 measured worse, but repeat runs of the *same* configuration
    // varied by a factor of two on the public swarm, so treat that as unproven rather than a
    // result. It is kept narrow on the argument rather than the measurement: a piece is the unit
    // the client waits for, and spreading the same outstanding blocks over twice as many pieces
    // makes each one complete more slowly, which is the wrong trade for a sequential stream.
    this.#store = new PieceStore(
      Math.max(2, Math.min(this.#config.creditWindow, 32)),
      this.#config.assemblyBudgetBytes,
    );
    this.#blame = new PeerBlame(this.#config.nakBanThreshold);
    this.#dialSlots = new DialSlots(
      MAX_CONNECTING,
      this.#config.maxPeers,
      this.#config.connectTimeoutMs + this.#config.handshakeTimeoutMs + 1_300,
    );
    // Deliberately no work here: on a wake from hibernation the runtime re-runs the constructor
    // before delivering the event, so anything expensive would be paid on every wake.
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const infoHash = (url.searchParams.get("ih") ?? "").toLowerCase();
    const rawFile = url.searchParams.get("file");
    const fileIndex = rawFile === null ? null : Number(rawFile);

    if (!/^[0-9a-f]{40}$/.test(infoHash)) {
      return new Response("bad infohash", { status: 400 });
    }
    if (fileIndex !== null && !Number.isInteger(fileIndex)) {
      return new Response("bad file index", { status: 400 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    // One viewer per session, so a reconnect **takes over** rather than joining.
    //
    // `getWebSockets()` is ordered oldest-first and a closed page's socket can outlive it for a
    // while, so without this a reload lands behind a corpse: every frame — including `ready` — goes
    // to the dead socket and the live client sits at whatever it had already stored, looking for all
    // the world like a swarm with no peers.
    for (const stale of this.ctx.getWebSockets()) {
      try {
        stale.close(1012, "replaced by a newer connection");
      } catch {
        // Already gone, which is the outcome being aimed at.
      }
    }

    const pair = new WebSocketPair();
    const server = pair[1];

    // The hibernation API, not `server.accept()`: accepting a socket directly bills duration for
    // the entire time it stays connected, whether or not anything is happening on it.
    this.ctx.acceptWebSocket(server);
    // Keepalives answered by the runtime cost no wall-clock and do not wake a hibernated object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    this.#greeted = false;
    this.#eofAnnounced = false;
    const attachment: SessionAttachment = { v: 1, infoHash, fileIndex };
    server.serializeAttachment(attachment);
    this.#infoHash = infoHash;
    this.#fileIndex = fileIndex;

    this.#credit = this.#config.creditWindow;
    this.#lastDemandAt = Date.now();
    // Run the opening pass inline: this invocation already exists and already has a CPU budget,
    // so arming an alarm to do the same work would cost a billed request and a row write.
    void this.#pump("open");

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.#inbound += 1;
    this.#restoreIdentity();

    const control = parseClientControl(message);
    if (control === null) {
      this.#send({ t: "error", code: "bad_message", message: "unparseable control frame" });
      return;
    }

    switch (control.t) {
      case "credit": {
        this.#credit += control.n;
        this.#lastDemandAt = Date.now();
        break;
      }
      case "nak": {
        this.#onNak(control.p);
        this.#lastDemandAt = Date.now();
        break;
      }
      case "seek": {
        this.#onSeek(control);
        this.#lastDemandAt = Date.now();
        break;
      }
      case "bye": {
        await this.#teardown("bye");
        try {
          ws.close(1000, "bye");
        } catch {
          // Already gone; nothing to close.
        }
        return;
      }
    }

    // Inline again. An inbound message is the cheapest wake-up available — billed 20:1 — so the
    // work it implies belongs in the same invocation.
    await this.#pump("message");
  }

  override async webSocketClose(): Promise<void> {
    await this.#teardown("closed");
  }

  override async webSocketError(): Promise<void> {
    await this.#teardown("error");
  }

  override async alarm(): Promise<void> {
    this.#alarms += 1;
    this.#alarmArmedFor = null;
    this.#restoreIdentity();
    await this.#pump("alarm");
  }

  // ---------------------------------------------------------------------------------------------
  // Client messages

  #onNak(pieces: readonly number[]): void {
    const scheduler = this.#scheduler;
    if (scheduler === null) return;
    scheduler.nak(pieces);
    // No longer finished, so a later completion is worth announcing again.
    this.#eofAnnounced = false;
    for (const piece of pieces) {
      this.#store.drop(piece);
      // The client hashed it and it failed, which is far stronger evidence than a failed dial: the
      // piece hashes come from the info dict whose own SHA-1 *is* the infohash, so a mismatch means
      // the peer sent bytes that are not this torrent's.
      for (const key of this.#blame.blame(piece)) {
        this.#peers.get(key)?.close();
        this.#peers.delete(key);
        this.#pendingReads.delete(key);
        this.#deadPeers.add(key);
      }
    }
  }

  #onSeek(control: { piece?: number; byte?: number }): void {
    const scheduler = this.#scheduler;
    const layout = this.#layout;
    const file = this.#file;
    if (scheduler === null || layout === null || file === null) return;

    const target = control.piece !== undefined
      ? control.piece
      : pieceOfFileOffset(layout, file, control.byte ?? 0);
    const epoch = scheduler.seek(target);

    // Withdraw the requests that were serving the old position. Without this the peers answer
    // anyway and their blocks have to be parsed and discarded, which spends the one budget that
    // matters — and the bandwidth belongs to the pieces now wanted.
    for (const peer of this.#peers.values()) void peer.cancelAll().catch(() => {});
    const dropped = this.#store.retain(scheduler.keepAfterSeek(new Set(this.#store.keys())));
    for (const piece of dropped) this.#blame.forget(piece);

    this.#send({ t: "stats", ...this.#stats(), epoch });
  }

  // ---------------------------------------------------------------------------------------------
  // The pump

  /** Idempotent, never throws, safe from any invocation. */
  async #pump(source: "open" | "message" | "alarm"): Promise<void> {
    if (this.#closing) return;
    if (this.#pumpBusy()) {
      this.#pumpQueued = true;
      return;
    }
    this.#pumpStartedAt = Date.now();
    const wasDirty = this.#dirtyExit;
    this.#dirtyExit = true;
    try {
      if (wasDirty) this.#recoverFromDirtyExit();
      await this.#tick();
    } catch (err) {
      console.error("tick failed", { source, error: describe(err) });
    } finally {
      this.#dirtyExit = false;
      this.#pumpStartedAt = 0;
    }

    await this.#settle();
    if (this.#pumpQueued) {
      this.#pumpQueued = false;
      this.#arm(Date.now());
    }
  }

  /**
   * Whether a tick is genuinely still running.
   *
   * Wall-clock staleness rather than a boolean, because an invocation killed for exceeding CPU
   * never reaches its `finally` — and a Durable Object is single-threaded, so a tick that started
   * longer ago than its own budget cannot still be running.
   */
  #pumpBusy(): boolean {
    if (this.#pumpStartedAt === 0) return false;
    const age = Date.now() - this.#pumpStartedAt;
    if (age > this.#config.tickBudgetMs + this.#config.pumpStaleGraceMs) {
      this.#pumpStartedAt = 0;
      return false;
    }
    return true;
  }

  /**
   * Pick up after an invocation that died mid-tick.
   *
   * Promises created in a dead context never settle, so a retained read promise would be raced
   * forever. Dropping them costs one re-issued `readNext` per peer; keeping them costs the session.
   */
  #recoverFromDirtyExit(): void {
    this.#pendingReads.clear();
    // A socket whose read was abandoned may have a half-consumed message in flight, and there is
    // no way to know. Re-dialling is cheap next to serving corrupt bytes.
    this.#dropPeers();
  }

  async #tick(): Promise<void> {
    if (!await this.#ensureLoaded()) return;
    const scheduler = this.#scheduler!;
    const layout = this.#layout!;

    if (!this.#greeted) {
      this.#greeted = true;
      this.#send(this.#ready());
    }

    const deadline = Date.now() + this.#config.tickBudgetMs;
    let budget = this.#config.maxBytesPerTick;

    this.#reap();
    this.#dropUselessPeers();
    this.#dropSilentPeers();
    this.#dial();

    if (scheduler.done) {
      // Announce once per connection, because a client reconnecting to a finished session is
      // otherwise told nothing at all. Its own record of what it holds is the authority — "sent"
      // here only means "handed to a socket" — so if it is missing pieces it will NAK them and this
      // stops being done. Once per connection rather than once per tick: the watchdog keeps ticking
      // while the client is attached, and a repeated eof is just noise in its log.
      if (!this.#eofAnnounced) {
        this.#eofAnnounced = true;
        this.#send({ t: "eof", sent: this.#piecesOut });
      }
      return;
    }

    if (this.#peers.size === 0) {
      // Wait inside this invocation rather than returning and re-arming. A cold start against a
      // stale peer list can spend twenty seconds here, and one alarm per settle would be fifty
      // billed invocations spent doing nothing but waiting.
      while (
        this.#peers.size === 0 && Date.now() < deadline &&
        (this.#dialSlots.inFlight > 0 || this.#candidates.length > 0)
      ) {
        await sleep(DIAL_SETTLE_MS);
        this.#reap();
        this.#dial();
      }
      if (this.#peers.size === 0) {
        if (await this.#refreshSwarm()) return;
        // Still working through the list is not a failure, and reporting it as one every few
        // seconds buries the log in identical errors while the dialler is doing exactly its job.
        // Only speak up when there is genuinely nothing left, and then only once a minute.
        const exhausted = this.#candidates.length === 0 && this.#dialSlots.inFlight === 0;
        const now = Date.now();
        if (exhausted && now - this.#lastNoPeersAt > 60_000) {
          this.#lastNoPeersAt = now;
          this.#send({
            t: "error",
            code: "peers_exhausted",
            message: "every address in the swarm has been tried and none answered",
          });
        }
        return;
      }
    }

    // Re-dispatching on every arriving block is what starves the pipelines.
    //
    // `#dispatch` walks every open assembly to rebuild the outstanding-block list, so calling it
    // once per block makes the cost of receiving a block proportional to the whole window — and
    // that work happens *instead of* reading the next block. Measured on a well-seeded swarm it
    // held per-peer throughput to 0.17 MiB/s against the 0.9 MiB/s those same peers give a plain
    // client. So top the pipelines up in batches, and immediately whenever a piece completes,
    // since that is when a whole piece's worth of slots frees at once.
    const topUpEvery = Math.max(1, this.#config.pipelineDepth >> 1);
    let sinceDispatch = topUpEvery;

    while (budget > 0 && Date.now() < deadline && !scheduler.done) {
      if (!this.#openAssemblies()) {
        // Either the client has no room or memory is full. Either way, more requests would be
        // bytes nobody can take delivery of.
        if (this.#store.size === 0) break;
      }
      if (sinceDispatch >= topUpEvery) {
        sinceDispatch = 0;
        await this.#dispatch();
      }

      const arrival = await this.#readAny(deadline);
      if (arrival === null) break;
      const { peer, block } = arrival;
      if (block === null) continue;

      sinceDispatch += 1;
      budget -= block.block.length;
      const assembly = this.#store.get(block.index);
      if (assembly === undefined) continue;

      this.#blame.credit(block.index, peer.key, block.block.length);
      if (assembly.addBlock(block.begin, block.block)) {
        this.#deliver(block.index, assembly.bytes);
        // A completed piece frees a whole piece's worth of request slots at once, and the client
        // is waiting on the next one — so do not sit on them until the batch counter comes round.
        sinceDispatch = topUpEvery;
      }
      this.#goodPeers.add(peer.key);
    }

    this.#maybeSendStats(layout);
  }

  /** Hand a finished piece to the client, unverified. The client hashes it. */
  #deliver(pieceIndex: number, bytes: Uint8Array): void {
    const scheduler = this.#scheduler!;
    const ws = this.#client();
    if (ws === undefined) return;
    try {
      ws.send(encodePiece(scheduler.epoch, pieceIndex, bytes));
    } catch (err) {
      console.error("send failed", { pieceIndex, error: describe(err) });
      return;
    }
    this.#bytesOut += bytes.length;
    this.#piecesOut += 1;
    this.#credit = Math.max(0, this.#credit - 1);
    scheduler.markSent(pieceIndex);
    this.#store.drop(pieceIndex);
    if (scheduler.done) this.#send({ t: "eof", sent: this.#piecesOut });
  }

  /**
   * Open assemblies for the pieces the scheduler wants next.
   *
   * Returns false when nothing could be opened, which is the backpressure signal: the client is
   * out of credit, or the memory budget is spent.
   */
  #openAssemblies(): boolean {
    const scheduler = this.#scheduler!;
    const layout = this.#layout!;
    const inFlight = new Set(this.#store.keys());
    const room = this.#store.maxPieces - this.#store.size;
    if (room <= 0) return false;

    const wanted = scheduler.plan(room, this.#credit - inFlight.size, inFlight);
    let opened = 0;
    for (const piece of wanted) {
      if (this.#store.open(piece, pieceLengthAt(layout, piece)) !== undefined) opened += 1;
    }
    return opened > 0;
  }

  /** Assign outstanding blocks to peers that are unchoked and hold them. */
  async #dispatch(): Promise<void> {
    const scheduler = this.#scheduler!;
    // Block requests go out in the scheduler's priority order, not in whatever order the
    // assemblies happen to have been opened: a rejected piece is what the client is stalled on, so
    // its blocks must be asked for before anything else's.
    // Sorting by piece index here would defeat the tail window entirely: the tail has the highest
    // indices in the file, so its blocks would queue behind every sequential piece and the `moov`
    // of a non-faststart MP4 would arrive last instead of first.
    const order = this.#store.keys().sort((a, b) => scheduler.priority(a) - scheduler.priority(b));
    const pending = this.#store.neededAcross(
      order,
      this.#config.maxPeers * this.#config.pipelineDepth,
    );
    if (pending.length === 0) return;

    let at = 0;
    for (const peer of this.#peers.values()) {
      if (peer.closed || peer.choked) continue;
      while (peer.inflight < this.#config.pipelineDepth && at < pending.length) {
        const block = pending[at]!;
        // Step past a piece this peer lacks rather than abandoning the peer: partial seeds are the
        // common case, and giving up on one for lacking the head of the queue idles a connection
        // that cost seconds of dialling to obtain.
        if (!peer.has(block.index)) {
          at += 1;
          continue;
        }
        at += 1;
        try {
          await peer.request(block.index, block.begin, block.length);
        } catch {
          peer.close();
          break;
        }
      }
    }
  }

  /**
   * The next block from whichever peer answers first.
   *
   * Racing every peer's next read is what turns a set of slow links into one fast one. The read
   * promises are **held across iterations**: starting a fresh `readNext()` each pass would leave
   * the losers of the previous race still reading, so one socket would end up with several
   * concurrent readers, which does not error — it interleaves halves of different messages and
   * corrupts the framing.
   */
  async #readAny(
    deadline: number,
  ): Promise<
    { peer: PeerSession; block: { index: number; begin: number; block: Uint8Array } | null } | null
  > {
    const live = [...this.#peers.values()].filter((peer) => !peer.closed);
    if (live.length === 0) return null;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    for (const peer of live) {
      if (this.#pendingReads.has(peer.key)) continue;
      this.#pendingReads.set(
        peer.key,
        peer.readNext().then(
          (event) => {
            if (event.kind === "block") {
              return {
                peer,
                // Copy: the block is a view into a buffer the connection will reuse.
                block: { index: event.index, begin: event.begin, block: new Uint8Array(event.block) },
              };
            }
            return { peer, block: null };
          },
          () => {
            peer.close();
            return { peer, block: null };
          },
        ),
      );
    }
    for (const key of [...this.#pendingReads.keys()]) {
      if (!this.#peers.has(key)) this.#pendingReads.delete(key);
    }

    const expiry = AbortSignal.timeout(remaining);
    const timer = new Promise<null>((resolve) => {
      expiry.addEventListener("abort", () => resolve(null), { once: true });
    });
    const settled = await Promise.race([...this.#pendingReads.values(), timer]);
    if (settled === null) return null;

    // Only the winner is consumed; every other promise stays pending and is re-raced.
    this.#pendingReads.delete(settled.peer.key);
    if (settled.peer.closed) {
      this.#peers.delete(settled.peer.key);
      this.#deadPeers.add(settled.peer.key);
    }
    return settled;
  }

  // ---------------------------------------------------------------------------------------------
  // Peers

  #dial(): void {
    const layout = this.#layout;
    if (layout === null) return;
    this.#dialSlots.sweep(Date.now());

    let room = Math.min(this.#dialSlots.room(this.#peers.size), this.#config.maxDialsPerTick);
    const infoHash = fromHex(layout.id);
    const timeouts = {
      connectMs: this.#config.connectTimeoutMs,
      handshakeMs: this.#config.handshakeTimeoutMs,
    };

    while (room > 0 && this.#candidates.length > 0) {
      const candidate = this.#candidates.shift()!;
      const key = peerKey(candidate.ip, candidate.port);
      if (
        this.#peers.has(key) || this.#deadPeers.has(key) || this.#probeDead.has(key) ||
        this.#blame.banned(key)
      ) continue;

      const slot = this.#dialSlots.open(Date.now());
      room -= 1;

      // Fire and forget. Awaiting a batch of dials is how cf-stream hung: five settle and one does
      // not, and every request behind it stalls. Peers join the pool as they answer.
      void PeerSession.dial(
        candidate.ip,
        candidate.port,
        infoHash,
        this.#peerId,
        layout.pieceCount,
        // The **era** signal alone, deliberately. `PeerSession.dial` layers the connect and
        // handshake deadlines on internally and then re-parents the surviving connection onto
        // whatever signal it was handed — so passing a timeout here does not bound setup, it bounds
        // the peer's whole life. Doing that killed every peer 4.7 s after it connected, which
        // presented as a swarm that answered and then evaporated.
        this.#era.signal,
        timeouts,
      ).then(
        (peer) => {
          slot.release();
          if (this.#era.signal.aborted || this.#closing) {
            peer.close();
            return;
          }
          this.#peers.set(key, peer);
          this.#failureStreak = 0;
          void this.#pump("alarm");
        },
        () => {
          slot.release();
          this.#deadPeers.add(key);
          this.#failureStreak += 1;
        },
      );
    }
  }

  /**
   * Drop peers that cannot serve what is wanted, without waiting for them to look "silent".
   *
   * A public swarm is full of leechers: the measured sample had a peer advertising **3 of 1055
   * pieces**, which is indistinguishable from a stalled seeder if the only test is elapsed time.
   * Waiting the full stall window on such a peer holds a pool slot and, worse, holds one of only
   * six connecting slots' worth of opportunity behind it. Judging it on its bitfield is immediate
   * and certain.
   */
  #dropUselessPeers(): void {
    const wanted = this.#store.keys();
    if (wanted.length === 0) return;
    const now = Date.now();

    for (const [key, peer] of [...this.#peers]) {
      if (peer.delivered > 0) continue;
      const tooManyMisses = peer.missed >= MAX_MISSED_BEFORE_DROP;
      const holdsNothing = now - peer.connectedAt >= BITFIELD_GRACE_MS &&
        !wanted.some((piece) => peer.has(piece));
      if (!tooManyMisses && !holdsNothing) continue;

      peer.close();
      this.#peers.delete(key);
      this.#pendingReads.delete(key);
      // Dead for this session: it is not slow, it does not have the file. bstream is told, and the
      // next session will rank it accordingly.
      this.#deadPeers.add(key);
    }
  }

  /** Close peers that have gone. */
  #reap(): void {
    for (const [key, peer] of [...this.#peers]) {
      if (!peer.closed) continue;
      this.#peers.delete(key);
      this.#pendingReads.delete(key);
      this.#deadPeers.add(key);
    }
  }

  /**
   * Close peers that have gone quiet — but only while there was something to be quiet about.
   *
   * This guard is load-bearing and its absence was a real bug: once the bootstrap windows landed
   * and the pump briefly had nothing dispatched, every peer looked idle, the whole pool was closed,
   * and the session then burned through its candidate list re-dialling replacements for peers that
   * had been working perfectly. A peer is only silent if we asked it for something.
   */
  #dropSilentPeers(): void {
    if (this.#store.size === 0) return;
    const starved = starvedPeers(
      [...this.#peers.values()].map((peer) => ({
        key: peer.key,
        delivered: peer.delivered,
        connectedAt: peer.connectedAt,
        deliveredAt: peer.deliveredAt,
      })),
      Date.now(),
    );
    for (const key of starved) {
      const peer = this.#peers.get(key);
      peer?.close();
      this.#peers.delete(key);
      this.#pendingReads.delete(key);
      // Not dead: it handshaked, it simply had nothing for us here and now. Requeued at the back,
      // because a swarm of 220 addresses yields about 30 that answer and throwing one away for
      // good is how a session runs out of peers halfway through a film.
      const requeue = this.#silent.get(key) ?? 0;
      if (requeue < 2) {
        this.#silent.set(key, requeue + 1);
        const [ip, port] = splitKey(key);
        if (ip !== null) this.#candidates.push({ ip, port, source: "requeue", verified: true });
      } else {
        this.#deadPeers.add(key);
      }
    }
  }

  /**
   * Ask bstream to walk the swarm again. Rate-limited: a stalled stream must not amplify.
   *
   * Before spending a subrequest, give the addresses that merely failed to connect another go. A
   * connect timeout is weak evidence — the measured swarm had peers that refused one dial and
   * answered the next — and retrying costs nothing but a connecting slot.
   */
  async #refreshSwarm(): Promise<boolean> {
    if (this.#candidates.length === 0 && this.#deadPeers.size > 0) {
      const retry = [...this.#deadPeers].filter((key) => !this.#blame.banned(key));
      this.#deadPeers.clear();
      for (const key of retry) {
        const [ip, port] = splitKey(key);
        if (ip !== null) this.#candidates.push({ ip, port, source: "retry", verified: false });
      }
      if (this.#candidates.length > 0) return true;
    }
    return this.#refreshFromRecords();
  }

  async #refreshFromRecords(): Promise<boolean> {
    const infoHash = this.#infoHash;
    if (infoHash === null) return false;
    const now = Date.now();
    if (now - this.#lastRefreshAt < this.#config.refreshCooldownMs) return false;
    if (!shouldRefreshSwarm(this.#candidates.length, this.#failureStreak, now - this.#swarmResolvedAt)) {
      return false;
    }
    this.#lastRefreshAt = now;

    try {
      const records = await fetchRecords(this.#config.recordsUrl, infoHash, {
        refresh: true,
        signal: this.#era.signal,
      });
      this.#adoptRecords(records.layout, records.peers, records.health, records.resolvedAt);
      await this.ctx.storage.put("records", {
        layout: records.layout,
        peers: records.peers,
        health: [...records.health],
        webseeds: records.webseeds,
        resolvedAt: records.resolvedAt,
      } satisfies StoredRecords);
      this.#failureStreak = 0;
      return this.#candidates.length > 0;
    } catch (err) {
      console.error("refresh failed", { error: describe(err) });
      return false;
    }
  }

  #dropPeers(): void {
    this.#era.abort();
    this.#era = new AbortController();
    for (const peer of this.#peers.values()) peer.close();
    this.#peers.clear();
    this.#pendingReads.clear();
    this.#dialSlots.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Loading and lifecycle

  /** Rebuild identity after a hibernation, from the socket that woke us. */
  #restoreIdentity(): void {
    if (this.#infoHash !== null) return;
    const ws = this.#client();
    if (ws === undefined) return;
    const attachment = ws.deserializeAttachment() as SessionAttachment | null;
    if (attachment === null || attachment.v !== 1) return;
    this.#infoHash = attachment.infoHash;
    this.#fileIndex = attachment.fileIndex;
    if (this.#credit === 0) this.#credit = this.#config.creditWindow;
  }

  /**
   * Put the addresses that served bytes in a previous session at the front of the queue.
   *
   * The single best lever on cold start. Measured on a real swarm, an address with a positive
   * record answers about 86 % of the time against a 14 % baseline — so a handful of remembered
   * peers is worth more than the next hundred untried ones, and dialling them first turns a
   * minute of fruitless connecting into a few seconds.
   */
  #promoteGoodPeers(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const wanted = new Set(keys);
    const front: PeerEntry[] = [];
    const rest: PeerEntry[] = [];
    for (const peer of this.#candidates) {
      (wanted.has(peerKey(peer.ip, peer.port)) ? front : rest).push(peer);
    }
    // A remembered peer that has fallen off the tracker's list is still worth a dial.
    const present = new Set(front.map((peer) => peerKey(peer.ip, peer.port)));
    for (const key of keys) {
      if (present.has(key)) continue;
      const [ip, port] = splitKey(key);
      if (ip !== null) front.push({ ip, port, source: "remembered", verified: true });
    }
    this.#candidates = [...front, ...rest];
  }

  async #saveGoodPeers(): Promise<void> {
    if (this.#goodPeers.size === 0) return;
    try {
      await this.ctx.storage.put("good", {
        at: Date.now(),
        keys: [...this.#goodPeers].slice(-32),
      });
    } catch {
      // Losing this costs a slower cold start next time, nothing more.
    }
  }

  async #ensureLoaded(): Promise<boolean> {
    this.#restoreIdentity();
    const infoHash = this.#infoHash;
    if (infoHash === null) return false;
    if (this.#scheduler !== null) return true;

    let stored = await this.ctx.storage.get<StoredRecords>("records");
    // A stale swarm is worth re-fetching, but a stale *layout* cannot go stale — a torrent's
    // geometry is fixed by its infohash.
    if (stored !== undefined && Date.now() - stored.resolvedAt > 15 * 60_000) {
      stored = undefined;
    }

    if (stored === undefined) {
      try {
        const records = await fetchRecords(this.#config.recordsUrl, infoHash, {
          signal: this.#era.signal,
        });
        stored = {
          layout: records.layout,
          peers: records.peers,
          health: [...records.health],
          webseeds: records.webseeds,
          resolvedAt: records.resolvedAt,
        };
        await this.ctx.storage.put("records", stored);
      } catch (err) {
        const code = err instanceof RecordsError ? err.code : "records_failed";
        this.#send({ t: "error", code, message: describe(err) });
        return false;
      }
    }

    try {
      this.#adoptRecords(
        stored.layout,
        stored.peers,
        new Map(stored.health),
        stored.resolvedAt,
      );
    } catch (err) {
      this.#send({ t: "error", code: "bad_file", message: describe(err) });
      return false;
    }

    const remembered = await this.ctx.storage.get<{ at: number; keys: string[] }>("good");
    // A week: peer addresses churn, but a seedbox that answered on Monday usually still answers.
    if (remembered !== undefined && Date.now() - remembered.at < 7 * 24 * 60 * 60_000) {
      this.#promoteGoodPeers(remembered.keys);
    }

    const snapshot = await this.ctx.storage.get<SchedulerSnapshot>("plan");
    const init = this.#schedulerInit();
    this.#scheduler = snapshot === undefined
      ? new Scheduler(init)
      : Scheduler.restore(init, snapshot);
    return true;
  }

  #adoptRecords(
    layout: TorrentLayout,
    peers: readonly PeerEntry[],
    health: ReadonlyMap<string, PeerHealth>,
    resolvedAt: number,
  ): void {
    this.#layout = layout;
    this.#file = resolveFile(layout, this.#fileIndex);
    this.#health = new Map(health);
    this.#swarmResolvedAt = resolvedAt;
    // Merge rather than replace: a refresh must not discard addresses still worth trying, and the
    // dial loop consumes this list destructively.
    const known = new Set(this.#candidates.map((peer) => peerKey(peer.ip, peer.port)));
    const banned = new Set([...this.#deadPeers, ...this.#blame.bannedKeys]);
    const ranked = rankPeers(peers, this.#health, banned, Date.now());
    for (const peer of ranked) {
      if (!known.has(peerKey(peer.ip, peer.port))) this.#candidates.push(peer);
    }
    this.#kickOffProbe();
  }

  /**
   * Ask `probe/` (see `../probe/README.md`) to dial the top of `#candidates` in parallel — 512
   * addresses at once from a runtime with no six-socket cap — and promote whatever comes back
   * alive before this Worker's own `#dial` has to guess.
   *
   * Strictly an upgrade, never a dependency: dialling proceeds immediately on today's ranked list
   * regardless, and this is `void`d at the call site. `probePeers` (`./swarm/probe.ts`) already
   * swallows every failure and returns an empty outcome, so a disabled, unreachable, or slow probe
   * changes nothing about correctness.
   */
  #kickOffProbe(): void {
    const { probeUrl, probeToken } = this.#config;
    if (probeUrl === "" || probeToken === "" || this.#probeInFlight) return;
    const layout = this.#layout;
    if (layout === null || this.#candidates.length === 0) return;

    const era = this.#era;
    const targets = this.#candidates
      .slice(0, this.#config.probeBatch)
      .map((peer) => ({ ip: peer.ip, port: peer.port }));
    const want = this.#bootstrapPieces();
    // Leave the Deno service room to answer inside its own deadline before this Worker's fetch
    // gives up on it; otherwise a slow network hop, not a slow sweep, is what times it out.
    const budgetMs = Math.max(500, this.#config.probeTimeoutMs - 500);

    this.#probeInFlight = true;
    probePeers({
      baseUrl: probeUrl,
      token: probeToken,
      infoHash: layout.id,
      peers: targets,
      pieceCount: layout.pieceCount,
      want,
      need: this.#config.probeNeed,
      budgetMs,
      timeoutMs: this.#config.probeTimeoutMs,
      signal: era.signal,
    }).then((outcome) => {
      this.#probeInFlight = false;
      this.#lastProbe = {
        at: Date.now(),
        sent: targets.length,
        probed: outcome.probed,
        truncated: outcome.truncated,
        useful: outcome.useful.length,
        alive: outcome.alive.length,
        dead: outcome.dead.length,
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      };
      // The era that asked may already be gone — a reconnect tore the pool down and started a new
      // one — in which case this answer is about sockets nobody is going to open.
      if (era.signal.aborted || this.#closing) return;
      for (const key of outcome.dead) this.#probeDead.add(key);
      // Two calls, deliberately: the first promotes confirmed-useful peers to the very front, the
      // second promotes merely-alive-but-unproven ones next — `#promoteGoodPeers` only ever moves
      // things forward, so a peer already placed by the first call stays ahead of the second's.
      this.#promoteGoodPeers(outcome.useful);
      this.#promoteGoodPeers(outcome.alive);
      this.#dial();
    }).catch((err) => {
      // `probePeers` does not throw in normal operation; this is insurance against a bug in it,
      // not an expected path.
      this.#probeInFlight = false;
      console.error("probe kickoff failed", { error: describe(err) });
    });
  }

  /**
   * A handful of piece indices worth asking the probe about: the head and tail bootstrap window
   * every scheduler starts with. `#store.keys()` is not usable here — a probe fires from
   * `#adoptRecords`, before the scheduler exists to have opened anything.
   */
  #bootstrapPieces(): number[] {
    const init = this.#schedulerInit();
    const want = new Set<number>();
    for (let i = init.head.first; i <= init.head.last && want.size < 4; i++) want.add(i);
    for (let i = init.tail.last; i >= init.tail.first && want.size < 8; i--) want.add(i);
    return [...want];
  }

  #schedulerInit() {
    const layout = this.#layout!;
    const file = this.#file!;
    const range = pieceRangeOfFile(layout, file);
    const tailBytes = tailBytesFor(file.length, this.#config);
    return {
      firstPiece: range.first,
      lastPiece: range.last,
      head: pieceRangeOfWindow(layout, file, 0, this.#config.headBytes),
      tail: pieceRangeOfWindow(layout, file, Math.max(0, file.length - tailBytes), tailBytes),
    };
  }

  #ready(): ServerControl {
    const layout = this.#layout!;
    const file = this.#file!;
    const range = pieceRangeOfFile(layout, file);
    return {
      t: "ready",
      infoHash: layout.id,
      pieceLength: layout.pieceLength,
      pieceCount: layout.pieceCount,
      totalLength: layout.totalLength,
      file: {
        index: file.index,
        path: file.path,
        offset: file.offset,
        length: file.length,
        mime: file.mime,
      },
      firstPiece: range.first,
      lastPiece: range.last,
      creditWindow: this.#config.creditWindow,
    };
  }

  /**
   * Decide what happens after a tick: work again, hold the sockets, or let them go.
   *
   * `"idle"` is where the money is. An open outbound TCP socket is exactly what makes a Durable
   * Object ineligible to hibernate, so dropping the peers is what stops duration accruing — and
   * duration is the constraint that decides how many streams a day the free plan affords.
   */
  async #settle(): Promise<void> {
    const scheduler = this.#scheduler;
    if (scheduler === null) return;
    const demandAge = Date.now() - this.#lastDemandAt;
    const queued = this.#credit > 0 ? scheduler.remaining : 0;
    const action = nextAction(queued, demandAge, this.#config.idleMs, this.#config.holdMs);

    if (scheduler.done || action === "idle") {
      await this.#persistPlan();
      await this.#saveGoodPeers();
      this.#dropPeers();
      return;
    }
    if (action === "hold") {
      await this.#persistPlan();
      // Nothing is armed beyond the slow watchdog: the client's next credit message is a cheaper
      // wake-up than an alarm, and it is the thing actually being waited for.
      this.#arm(Date.now() + this.#config.watchdogMs);
      return;
    }
    this.#arm(Date.now());
  }

  async #persistPlan(): Promise<void> {
    if (this.#scheduler === null) return;
    await this.ctx.storage.put("plan", this.#scheduler.snapshot());
  }

  /**
   * The only place `setAlarm` is called.
   *
   * Every alarm is both a billed request and a SQLite row write, against 100,000 of each per day.
   * Without the floor and the de-duplication, a `#pump` that kicks fifty times inside one tick
   * would write fifty rows for one alarm, and a fast pump would spend a day's budget on one film.
   */
  #arm(at: number): void {
    if (this.#closing) return;
    const when = Math.max(at, Date.now() + this.#config.minAlarmGapMs);
    if (this.#alarmArmedFor !== null && this.#alarmArmedFor <= when) return;
    this.#alarmArmedFor = when;
    void this.ctx.storage.setAlarm(when).catch(() => {
      this.#alarmArmedFor = null;
    });
  }

  async #teardown(reason: string): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#dropPeers();
    this.#store.clear();
    try {
      await this.#persistPlan();
      await this.#saveGoodPeers();
      await this.ctx.storage.deleteAlarm();
    } catch {
      // Storage is best-effort at this point; the session is over either way.
    }
    await this.#reportHealth(reason);
  }

  /**
   * Tell bstream which addresses were worth dialling.
   *
   * One POST at the end rather than a write per outcome, and it is genuinely valuable: peers with
   * a positive record unchoke at 86 % against a 14 % baseline, so this is the measurement that
   * makes the *next* session cheap. Failure is ignored — a stream that has already finished must
   * not be held up reporting on it.
   */
  async #reportHealth(reason: string): Promise<void> {
    const infoHash = this.#infoHash;
    if (infoHash === null) return;
    if (this.#goodPeers.size === 0 && this.#deadPeers.size === 0) return;
    const body = JSON.stringify({
      infoHash,
      reason,
      ok: [...this.#goodPeers],
      fail: [...this.#deadPeers].filter((key) => !this.#goodPeers.has(key)),
      bad: this.#blame.bannedKeys,
    });
    try {
      await fetch(`${this.#config.recordsUrl}/peer-health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // bstream may not implement this yet. It is an optimisation for later sessions, not a step
      // this one depends on.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Telemetry

  #maybeSendStats(layout: TorrentLayout): void {
    const now = Date.now();
    if (now - this.#lastStatAt < STAT_INTERVAL_MS) return;
    this.#lastStatAt = now;
    void layout;
    this.#send({ t: "stats", ...this.#stats(), epoch: this.#scheduler?.epoch ?? 0 });
  }

  #stats() {
    return {
      cursor: this.#scheduler?.cursor ?? 0,
      sent: this.#piecesOut,
      peers: this.#peers.size,
      dialsInFlight: this.#dialSlots.inFlight,
      bytesOut: this.#bytesOut,
    };
  }

  /** Counters a `/debug` route can read without disturbing the session. */
  debug(): Record<string, unknown> {
    return {
      infoHash: this.#infoHash,
      fileIndex: this.#fileIndex,
      epoch: this.#scheduler?.epoch ?? null,
      cursor: this.#scheduler?.cursor ?? null,
      remaining: this.#scheduler?.remaining ?? null,
      bootstrapping: this.#scheduler?.bootstrapping ?? null,
      credit: this.#credit,
      peers: [...this.#peers.values()].map((peer) => ({
        key: peer.key,
        choked: peer.choked,
        delivered: peer.delivered,
        inflight: peer.inflight,
        ageMs: Date.now() - peer.connectedAt,
      })),
      silentRequeues: this.#silent.size,
      candidates: this.#candidates.length,
      dialsInFlight: this.#dialSlots.inFlight,
      deadPeers: this.#deadPeers.size,
      probe: {
        enabled: this.#config.probeUrl !== "" && this.#config.probeToken !== "",
        inFlight: this.#probeInFlight,
        probeDead: this.#probeDead.size,
        last: this.#lastProbe,
      },
      bannedPeers: this.#blame.bannedKeys,
      assembliesOpen: this.#store.size,
      bytesHeld: this.#store.bytesHeld,
      piecesOut: this.#piecesOut,
      bytesOut: this.#bytesOut,
      alarms: this.#alarms,
      inboundMessages: this.#inbound,
      alarmArmedFor: this.#alarmArmedFor,
    };
  }

  /**
   * The live client socket: the newest one.
   *
   * Never index 0 — that is the oldest, and after a reconnect it is the one that just got replaced.
   */
  #client(): WebSocket | undefined {
    return this.ctx.getWebSockets().at(-1);
  }

  #send(control: ServerControl): void {
    const ws = this.#client();
    if (ws === undefined) return;
    try {
      ws.send(encodeControl(control));
    } catch {
      // The client has gone; `webSocketClose` will follow.
    }
  }
}

/** `ip:port` back into its parts. Returns a null ip for anything malformed. */
function splitKey(key: string): [string | null, number] {
  const at = key.lastIndexOf(":");
  if (at <= 0) return [null, 0];
  const port = Number(key.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [null, 0];
  return [key.slice(0, at), port];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `setTimeout` does fire inside a Durable Object alarm — an earlier belief to the contrary was wrong. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
