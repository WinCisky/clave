/**
 * The parallel probe orchestrator.
 *
 * `clave`'s Worker can only ever have six sockets *connecting* at once (Cloudflare's platform
 * cap, not a tuning knob — see its `src/session.ts`), so on a fresh, unranked peer list at ~14%
 * answering it burns roughly 40 dials to land six working peers. This runs with no such cap: it
 * dials every candidate at once, completes the handshake, and reads until it has seen a bitfield
 * or given up — so by the time the Worker asks, most of the guessing has already been done.
 *
 * One request in, one summary out. Nothing here holds a connection open past its own probe —
 * every socket is closed before this returns, alive or dead.
 */

import { isDialable } from "./addr.ts";
import {
  Bitfield,
  buildHandshake,
  FramedConn,
  generatePeerId,
  interestedFrame,
  MSG_BITFIELD,
  MSG_HAVE,
  MSG_HAVE_ALL,
  MSG_HAVE_NONE,
  parseHandshakeResponse,
  parseHave,
  readMessage,
  WireError,
} from "./wire.ts";

export interface ProbeTarget {
  readonly ip: string;
  readonly port: number;
}

export type DeadReason =
  | "connect_timeout"
  | "connect_refused"
  | "handshake_timeout"
  | "bad_protocol"
  | "infohash_mismatch"
  | "closed"
  | "blocked";

export interface AliveResult {
  readonly ip: string;
  readonly port: number;
  readonly rttMs: number;
  readonly handshakeMs: number;
  readonly seed: boolean;
  readonly have: number;
  /** null: handshaked but no bitfield/have arrived inside the window. Alive, unproven. */
  readonly hasWanted: boolean | null;
  readonly fast: boolean;
  readonly extended: boolean;
}

export interface DeadResult {
  readonly ip: string;
  readonly port: number;
  readonly why: DeadReason;
}

export interface ProbeRequest {
  readonly infoHash: string;
  readonly peers: readonly ProbeTarget[];
  readonly pieceCount: number;
  readonly want: readonly number[];
  readonly need: number;
  readonly budgetMs: number;
}

export interface ProbeResponse {
  readonly infoHash: string;
  readonly tookMs: number;
  readonly probed: number;
  readonly truncated: boolean;
  readonly alive: AliveResult[];
  readonly dead: DeadResult[];
}

export const MAX_PEERS_PER_REQUEST = 512;
export const MAX_WANT = 64;
export const MAX_BUDGET_MS = 8_000;
export const DEFAULT_CONCURRENCY = Number(Deno.env.get("MAX_CONCURRENCY") ?? "128");

const CONNECT_TIMEOUT_MS = 1_200;
const HANDSHAKE_TIMEOUT_MS = 1_500;
const BITFIELD_WINDOW_MS = 1_200;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Race `promise` against a timer. If the timer wins, `onTimeout` runs (closing the socket, which
 * is the only way Deno gives us to interrupt a pending read or an in-flight connect) and this
 * rejects with `WireError`. The loser is never left dangling: whichever settles second is still
 * awaited internally, so nothing here produces an unhandled rejection.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      onTimeout();
      reject(new WireError(`timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function classifyConnectError(err: unknown): DeadReason {
  if (err instanceof Deno.errors.ConnectionRefused) return "connect_refused";
  if (err instanceof WireError) return "connect_timeout";
  const message = err instanceof Error ? err.message : String(err);
  if (/refused/i.test(message)) return "connect_refused";
  return "connect_timeout";
}

export interface ProbeContext {
  readonly infoHashBytes: Uint8Array;
  readonly peerId: Uint8Array;
  readonly pieceCount: number;
  readonly wanted: readonly number[];
  readonly deadline: number;
}

/**
 * Dial, handshake and read one peer. Exported (only) for tests, which reach it directly to probe a
 * local fixture peer that `isDialable` would otherwise refuse — the SSRF guard is a policy check
 * `probePeers` applies before calling this, deliberately kept out of the dial itself so the two can
 * be tested independently.
 */
export async function probeOne(target: ProbeTarget, ctx: ProbeContext): Promise<AliveResult | DeadResult> {
  const connectStart = performance.now();
  let conn: Deno.TcpConn;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      conn?.close();
    } catch {
      // Already gone. Closing twice is a no-op we do not need to care about.
    }
  };

  try {
    // `Deno.connect` takes no signal or deadline of its own, so a slow dial is abandoned rather
    // than cancelled: the promise may still resolve after we have moved on, at which point `close`
    // (already fired by the timeout) tears the late socket down immediately.
    let pending: Deno.TcpConn | undefined;
    const connectPromise = Deno.connect({ hostname: target.ip, port: target.port, transport: "tcp" })
      .then((c) => {
        pending = c;
        if (closed) {
          try {
            c.close();
          } catch {
            // Nothing to clean up further.
          }
        }
        return c;
      });
    conn = await withTimeout(connectPromise, CONNECT_TIMEOUT_MS, () => {
      closed = true;
      if (pending) {
        try {
          pending.close();
        } catch {
          // Best effort.
        }
      }
    });
  } catch (err) {
    return { ip: target.ip, port: target.port, why: classifyConnectError(err) };
  }

  const rttMs = performance.now() - connectStart;
  const framed = new FramedConn(conn);

  try {
    const handshakeStart = performance.now();
    const result = await withTimeout(
      (async () => {
        await framed.write(buildHandshake(ctx.infoHashBytes, ctx.peerId));
        const response = await framed.readExact(68);
        const parsed = parseHandshakeResponse(response, ctx.infoHashBytes);
        await framed.write(interestedFrame());
        return parsed;
      })(),
      HANDSHAKE_TIMEOUT_MS,
      close,
    );
    const handshakeMs = performance.now() - handshakeStart;

    let field = Bitfield.empty(ctx.pieceCount);
    let seed = false;
    let sawField = false;
    const bitfieldBudget = Math.max(0, Math.min(BITFIELD_WINDOW_MS, ctx.deadline - performance.now()));

    if (bitfieldBudget > 0) {
      try {
        await withTimeout(
          (async () => {
            // A peer sends at most one bitfield-shaped message before ordinary traffic (`have`,
            // `choke`/`unchoke`) starts, so the first useful one is decisive; everything else is
            // ignored, same as clave's session loop does for messages it does not act on.
            for (;;) {
              const message = await readMessage(framed);
              if (message.id === MSG_BITFIELD) {
                field = Bitfield.fromPayload(message.payload, ctx.pieceCount);
                sawField = true;
                return;
              }
              if (message.id === MSG_HAVE_ALL) {
                field = Bitfield.full(ctx.pieceCount);
                seed = true;
                sawField = true;
                return;
              }
              if (message.id === MSG_HAVE_NONE) {
                sawField = true;
                return;
              }
              if (message.id === MSG_HAVE) {
                field.set(parseHave(message.payload));
                // A single `have` is not conclusive on its own, but it is evidence the peer is
                // live and talking — keep listening a little longer within the same budget.
                continue;
              }
              // choke/unchoke/keepalive/extended/etc: not what we are listening for, keep reading.
            }
          })(),
          bitfieldBudget,
          close,
        );
      } catch (err) {
        // Only a timeout means "alive, unproven" (`hasWanted: null`) — the window ran out with
        // nothing bitfield-shaped having arrived. Anything else (the peer hung up, a malformed
        // frame) is real evidence the peer is not usable, and must reach the outer catch as dead
        // rather than be reported as a live, silent peer.
        if (err instanceof WireError && /timed out/.test(err.message)) {
          // fall through with `sawField` still false
        } else {
          throw err;
        }
      }
    }

    const have = field.count;
    seed = seed || (ctx.pieceCount > 0 && have >= ctx.pieceCount);
    const hasWanted = sawField
      ? (ctx.wanted.length === 0 ? have > 0 : ctx.wanted.some((index) => field.has(index)))
      : null;

    return {
      ip: target.ip,
      port: target.port,
      rttMs: Math.round(rttMs),
      handshakeMs: Math.round(handshakeMs),
      seed,
      have,
      hasWanted,
      fast: result.supportsFast,
      extended: result.supportsExtended,
    };
  } catch (err) {
    const why: DeadReason = err instanceof WireError && /timed out/.test(err.message)
      ? "handshake_timeout"
      : err instanceof WireError && /infohash/.test(err.message)
      ? "infohash_mismatch"
      : err instanceof WireError && /protocol/.test(err.message)
      ? "bad_protocol"
      : "closed";
    return { ip: target.ip, port: target.port, why };
  } finally {
    close();
  }
}

function isAlive(result: AliveResult | DeadResult): result is AliveResult {
  return !("why" in result);
}

/** insertion-ordered TTL cache, evicted oldest-first once it grows past `maxEntries`. */
class ProbeCache {
  readonly #entries = new Map<
    string,
    { readonly expiresAt: number; readonly result: AliveResult | DeadResult }
  >();

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string, now: number): (AliveResult | DeadResult) | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(key: string, result: AliveResult | DeadResult, now: number): void {
    this.#entries.delete(key); // re-insert at the end so it is not the next eviction
    this.#entries.set(key, { expiresAt: now + this.ttlMs, result });
    if (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }
}

// Module-level: this is what makes the cache useful across requests within one isolate. Deploy
// isolates are per-region and recycled, so this is opportunistic, not a durability guarantee.
const cache = new ProbeCache(60_000, 20_000);

/** Bounded concurrent fan-out. `Deno.connect` has no platform-imposed cap, so this is a courtesy
 * limit to keep one request from opening thousands of sockets at once, not a workaround for one. */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}

export interface ProbePeersDeps {
  /** Overrides the real dial-and-handshake for tests, the same way `fetchImpl` does in
   * `clave`'s `fetchRecords` — the orchestration (pooling, early exit, budget, cache, sort) is
   * exercised without opening a single real socket. */
  readonly probeOne?: typeof probeOne;
}

export async function probePeers(request: ProbeRequest, deps: ProbePeersDeps = {}): Promise<ProbeResponse> {
  const dial = deps.probeOne ?? probeOne;
  const start = performance.now();
  const budgetMs = Math.min(request.budgetMs, MAX_BUDGET_MS);
  const deadline = start + budgetMs;
  const peerId = generatePeerId();
  const infoHashBytes = fromHex(request.infoHash);
  const now = Date.now();

  const alive: AliveResult[] = [];
  const dead: DeadResult[] = [];
  let probed = 0;
  let usefulCount = 0;
  let hitBudget = false;
  const controller = new AbortController();

  const need = Math.max(1, request.need);
  const peers = request.peers.slice(0, MAX_PEERS_PER_REQUEST);

  // `done` resolves the moment this request has an answer worth returning — enough useful peers
  // found, the whole list swept, or the budget elapsed — whichever comes first. Deliberately not
  // the same thing as every dial having settled: a handful of stragglers dialling into a dead
  // address can take the full connect-plus-handshake window, and waiting on them is exactly the
  // latency this service exists to avoid. They keep running unawaited and land in `cache` for
  // whoever asks next; each is bounded by its own timeouts, so nothing here can run away.
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const pool = runPool(peers, DEFAULT_CONCURRENCY, async (target) => {
    if (controller.signal.aborted) return;
    const key = `${request.infoHash}|${target.ip}:${target.port}`;
    const cached = cache.get(key, now);
    let result: AliveResult | DeadResult;
    if (cached !== undefined) {
      result = cached;
    } else if (!isDialable(target.ip, target.port)) {
      result = { ip: target.ip, port: target.port, why: "blocked" };
    } else {
      result = await dial(target, {
        infoHashBytes,
        peerId,
        pieceCount: request.pieceCount,
        wanted: request.want,
        deadline,
      });
      cache.set(key, result, now);
    }
    probed++;
    if (isAlive(result)) {
      alive.push(result);
      if (result.hasWanted !== false) usefulCount++;
      if (usefulCount >= need) {
        controller.abort();
        finish();
      }
    } else {
      dead.push(result);
    }
  }).then(finish, (err) => {
    // A worker threw, which should not happen — `probeOne` catches everything itself — but this is
    // an unawaited background promise, so an uncaught rejection here would otherwise be silent.
    console.error("probe pool worker failed", err);
    finish();
  }); // the whole list finished (or broke) on its own before `need` or the budget was reached

  const timer = setTimeout(() => {
    hitBudget = true;
    controller.abort();
    finish();
  }, budgetMs);

  await done;
  clearTimeout(timer);
  void pool; // intentionally not awaited past this point; see the comment on `done` above

  // Confirmed useful beats unproven beats confirmed not useful — `null` (no bitfield-shaped
  // message arrived in time) is meaningfully better than `false` (arrived, and it does not hold
  // what was asked about), so the two must not tie.
  const wantedRank = (value: boolean | null): number => value === true ? 0 : value === null ? 1 : 2;
  alive.sort((a, b) => {
    const byWanted = wantedRank(a.hasWanted) - wantedRank(b.hasWanted);
    if (byWanted !== 0) return byWanted;
    const bySeed = Number(b.seed) - Number(a.seed);
    if (bySeed !== 0) return bySeed;
    const byHave = b.have - a.have;
    if (byHave !== 0) return byHave;
    return a.rttMs - b.rttMs;
  });

  return {
    infoHash: request.infoHash,
    tookMs: Math.round(performance.now() - start),
    probed,
    // True whenever the response went out before every candidate settled — whether because the
    // budget ran out or because `need` was already satisfied. Either way, a caller with room for
    // more should not read `dead` as exhaustive.
    truncated: hitBudget || probed < peers.length,
    alive,
    dead,
  };
}
