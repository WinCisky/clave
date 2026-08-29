/**
 * One peer session.
 *
 * Deliberately *pull*-shaped: `readNext()` returns the next event rather than the session running
 * its own background pump. A floating read loop inside a Durable Object would keep consuming CPU
 * across invocation boundaries with no clear owner, and CPU is the budget that decides whether
 * this runs on the free plan at all. Here every byte parsed is billed to the tick that asked for
 * it, which is also what makes a tick's work bounded and measurable.
 *
 * State that the protocol keeps per-connection — am I choked, which pieces does this peer have —
 * lives here and is updated as messages stream past, so the scheduler can ask simple questions.
 */

import { WireConn, WireError } from "../wire/conn.ts";
import { performHandshake } from "../wire/handshake.ts";
import {
  Bitfield,
  cancelFrame,
  interestedFrame,
  MSG_BITFIELD,
  MSG_CHOKE,
  MSG_HAVE,
  MSG_HAVE_ALL,
  MSG_HAVE_NONE,
  MSG_PIECE,
  MSG_REJECT_REQUEST,
  MSG_UNCHOKE,
  parseBlockRequest,
  parseHave,
  parsePiece,
  readMessage,
  requestFrame,
} from "../wire/messages.ts";

export type PeerEvent =
  | { readonly kind: "block"; readonly index: number; readonly begin: number; readonly block: Uint8Array }
  | { readonly kind: "unchoke" }
  | { readonly kind: "choke" }
  | { readonly kind: "progress" }
  /** BEP-6: the peer will not serve this block. Deterministic, unlike silence. */
  | { readonly kind: "reject"; readonly index: number; readonly begin: number }
  | { readonly kind: "other" };

export interface PeerTimeouts {
  /** Deadline on the TCP connect alone. Bounds what one dead address costs a connecting slot. */
  readonly connectMs: number;
  /** Further time allowed for the 68-byte handshake once the socket is open. */
  readonly handshakeMs: number;
}

/**
 * The two deadlines a dial runs under, from the one pair of tunables.
 *
 * Exported because the property that matters is not visible at the call site: connecting must be
 * bounded *separately* and *sooner* than the whole setup. It was not, for a long time —
 * `connectMs` was declared, passed, and never read, so every dead address held a connecting slot
 * for the full handshake window. Six slots at five seconds apiece is what made a cold start take
 * two minutes, and nothing in the type system was going to notice.
 */
export function dialDeadlines(timeouts: PeerTimeouts): { connectMs: number; setupMs: number } {
  return { connectMs: timeouts.connectMs, setupMs: timeouts.connectMs + timeouts.handshakeMs };
}

/** `host:port`, matching the `peer_key` ma-stream's `peer_health` table is indexed by. */
export function peerKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export class PeerSession {
  #conn: WireConn;
  #field: Bitfield;
  #choked = true;
  #inflight = new Map<string, { index: number; begin: number; length: number }>();
  #closed = false;

  readonly key: string;
  /** When the handshake completed, so a peer can be judged on how long it has had to prove itself. */
  readonly connectedAt = Date.now();
  /** Blocks this peer has actually delivered. Used to prefer peers that are working. */
  delivered = 0;
  /** When the last block arrived, or 0 if none ever has. */
  deliveredAt = 0;
  /** Blocks requested that never arrived. */
  missed = 0;

  private constructor(conn: WireConn, key: string, pieceCount: number, seed: boolean) {
    this.#conn = conn;
    this.key = key;
    // A peer that sends no bitfield may still be a seed; assuming empty would mean never asking
    // it for anything, and assuming full would mean asking for pieces it lacks. Callers say which.
    this.#field = seed ? Bitfield.full(pieceCount) : new Bitfield(pieceCount);
  }

  static async dial(
    host: string,
    port: number,
    infoHash: Uint8Array,
    peerId: Uint8Array,
    pieceCount: number,
    signal: AbortSignal,
    timeouts: PeerTimeouts,
  ): Promise<PeerSession> {
    // Two deadlines, not one, and the distinction is the whole cold-start budget.
    //
    // A single setup deadline meant a dead address held one of the six concurrent connecting slots
    // for the entire connect-plus-handshake window. Almost every address on a stale peer list is
    // dead, so that window — not the download — is what a cold start actually spent its time on:
    // 162 dead addresses over 6 slots at 5 s apiece is a little over two minutes before the first
    // byte, which is what production showed.
    //
    // Connecting is answered by the network in a couple of round trips or not at all, so it gets a
    // short deadline of its own. The handshake is a peer that has already answered, so it can
    // afford the longer one — `readExact` has no timeout of its own, and a peer that completes TCP
    // and then says nothing would otherwise block forever.
    const { connectMs, setupMs } = dialDeadlines(timeouts);
    const connecting = AbortSignal.any([signal, AbortSignal.timeout(connectMs)]);
    const conn = await WireConn.connect(host, port, connecting);

    // Re-parent immediately, so the connect deadline cannot fire on a connection that beat it.
    // The handshake budget is measured from the same start rather than from here, so a peer that
    // spent most of `connectMs` arriving does not also get a full fresh handshake window.
    conn.adopt(AbortSignal.any([signal, AbortSignal.timeout(setupMs)]));

    try {
      await performHandshake(conn, infoHash, peerId);
      // Announce interest immediately. A peer will not unchoke a client that has not asked.
      await conn.write(interestedFrame());
    } catch (err) {
      conn.close();
      throw err;
    }
    // Survived setup, so re-parent onto the caller's lifetime before the setup deadline expires
    // and closes a perfectly good connection.
    conn.adopt(signal);
    return new PeerSession(conn, peerKey(host, port), pieceCount, false);
  }

  get choked(): boolean {
    return this.#choked;
  }

  get closed(): boolean {
    return this.#closed || this.#conn.closed;
  }

  get inflight(): number {
    return this.#inflight.size;
  }

  /** Whether this peer claims to hold a piece. */
  has(index: number): boolean {
    return this.#field.has(index);
  }

  get pieceCount(): number {
    return this.#field.count;
  }

  async request(index: number, begin: number, length: number): Promise<void> {
    const key = `${index}:${begin}`;
    if (this.#inflight.has(key)) return;
    this.#inflight.set(key, { index, begin, length });
    await this.#conn.write(requestFrame(index, begin, length));
  }

  /**
   * Withdraw every outstanding request.
   *
   * Sent when the scheduler gives a piece to a faster peer. Without it the slow peer eventually
   * replies anyway and its blocks have to be parsed and discarded, which spends the one budget
   * that matters.
   */
  async cancelAll(): Promise<void> {
    const outstanding = [...this.#inflight.values()];
    this.#inflight.clear();
    for (const block of outstanding) {
      if (this.closed) return;
      try {
        await this.#conn.write(cancelFrame(block.index, block.begin, block.length));
      } catch {
        return; // The peer is gone; there is nothing left to cancel.
      }
    }
  }

  /** Requests sent that have not been answered. */
  outstanding(): { index: number; begin: number; length: number }[] {
    return [...this.#inflight.values()];
  }

  /**
   * The next event, with protocol bookkeeping already applied.
   *
   * Messages that do not concern a downloader — `port`, `extended`, keep-alives — surface as
   * `other` rather than being silently swallowed, so a caller can tell "nothing useful yet" from
   * "nothing at all".
   */
  async readNext(): Promise<PeerEvent> {
    const message = await readMessage(this.#conn);
    switch (message.id) {
      case MSG_CHOKE: {
        this.#choked = true;
        // A choke voids every outstanding request; the peer will not answer them.
        this.missed += this.#inflight.size;
        this.#inflight.clear();
        return { kind: "choke" };
      }
      case MSG_UNCHOKE: {
        this.#choked = false;
        return { kind: "unchoke" };
      }
      case MSG_HAVE: {
        this.#field.set(parseHave(message.payload));
        return { kind: "progress" };
      }
      case MSG_BITFIELD: {
        this.#field = Bitfield.fromPayload(message.payload, this.#field.pieceCount);
        return { kind: "progress" };
      }
      case MSG_HAVE_ALL: {
        // BEP-6's compact way of saying "seed". A peer that sends this sends no bitfield at all,
        // so without this case it would look like it holds nothing and never be asked for a block.
        this.#field = Bitfield.full(this.#field.pieceCount);
        return { kind: "progress" };
      }
      case MSG_HAVE_NONE: {
        this.#field = new Bitfield(this.#field.pieceCount);
        return { kind: "progress" };
      }
      case MSG_REJECT_REQUEST: {
        // The other half of BEP-6's guarantee: every request gets exactly one answer, and this is
        // the negative one. Clearing the slot immediately is what makes the guarantee useful —
        // otherwise the request sits in flight until a timeout that has to be guessed.
        const block = parseBlockRequest(message.payload);
        if (this.#inflight.delete(`${block.index}:${block.begin}`)) this.missed += 1;
        return { kind: "reject", index: block.index, begin: block.begin };
      }
      case MSG_PIECE: {
        const piece = parsePiece(message.payload);
        this.#inflight.delete(`${piece.index}:${piece.begin}`);
        this.delivered++;
        this.deliveredAt = Date.now();
        return { kind: "block", index: piece.index, begin: piece.begin, block: piece.block };
      }
      default:
        return { kind: "other" };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#inflight.clear();
    this.#conn.close();
  }
}

export { WireError };
