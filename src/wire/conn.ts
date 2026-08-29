/**
 * A framed connection to one peer, over a Cloudflare TCP socket.
 *
 * Ported from ma-stream's `WireConn`. The buffering half — `readExact`, `#take`, `write` — is
 * unchanged, because it was already written against WHATWG streams and `connect()` from
 * `cloudflare:sockets` hands back the same `.readable` / `.writable` shape. Only the constructor
 * and teardown differ.
 *
 * Two properties are worth preserving deliberately:
 *
 *  - **Cancellation goes through `reader.cancel()`**, not `socket.close()`. Closing a socket does
 *    not interrupt a pending read, so a peer that goes quiet mid-message would otherwise pin the
 *    connection open until the object is evicted — and an open socket keeps a Durable Object
 *    resident, which is billed.
 *  - **Chunks are copied before being retained.** The stream may reuse its buffer; holding the
 *    view it handed over is a data race that shows up as corrupted pieces much later.
 */

import { connect } from "cloudflare:sockets";

export class WireError extends Error {
  override readonly name = "WireError";
}

export class WireConn {
  #socket: Socket;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #closed = false;
  #signal: AbortSignal;
  #abortListener: () => void;

  private constructor(socket: Socket, signal: AbortSignal) {
    this.#socket = socket;
    this.#reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.#writer = socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    this.#signal = signal;
    this.#abortListener = () => this.close();
    signal.addEventListener("abort", this.#abortListener, { once: true });
  }

  /**
   * Dial a peer.
   *
   * `secureTransport: "off"` because the BitTorrent peer wire is plaintext. Cloudflare refuses
   * private and loopback addresses and port 25 on its own, but callers should still filter with
   * `isRoutable` first — a rejected connect still spends one of the six concurrent connecting
   * slots while it fails.
   */
  static async connect(
    hostname: string,
    port: number,
    signal: AbortSignal,
  ): Promise<WireConn> {
    if (signal.aborted) throw new WireError("aborted before connect");

    let socket: Socket;
    try {
      socket = connect({ hostname, port }, { secureTransport: "off", allowHalfOpen: false });
    } catch (err) {
      throw new WireError(`connect to ${hostname}:${port} failed: ${describe(err)}`);
    }

    // A Cloudflare socket exposes `closed`, which **rejects** when the connection errors — and a
    // dead BitTorrent peer is the normal case, not the exception. With no handler attached that
    // rejection is unhandled, and an unhandled rejection inside a Durable Object tears the object
    // down mid-tick: every promise in flight, including the dial batch, simply never settles.
    void socket.closed.catch(() => {});

    // The deadline rides on `signal`, not on a `setTimeout`.
    //
    // An earlier version of this comment claimed a `setTimeout` armed inside a Durable Object
    // alarm does not fire. That was wrong, and cf-stream's own README records the correction —
    // both `setTimeout` and `AbortSignal.timeout` fire normally in an alarm. The signal is still
    // the right mechanism, for a different and better reason: aborting *cancels the pending read*,
    // where a timer only wins a race and leaves the read running against a socket nobody will
    // ever drain.
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new WireError(`connect to ${hostname}:${port} aborted or timed out`)),
        { once: true },
      );
    });

    try {
      await Promise.race([socket.opened, aborted]);
    } catch (err) {
      // **Do not await this.** Closing a socket that never finished connecting can take around
      // twenty seconds in workerd (cloudflare/workerd#2060), and awaiting it means the *dial* does
      // not settle until then — so a dead address holds one of only six concurrent connecting slots
      // for twenty seconds instead of releasing at the 1.2 s connect deadline.
      //
      // Measured against a real swarm: awaiting this capped dialling at 0.84 addresses per second,
      // which on a list where roughly one address in seven answers is about one usable peer every
      // eight seconds. Almost every address on a public peer list is dead, so this single `await`
      // was the cold start.
      void socket.close().catch(() => {});
      throw err instanceof WireError ? err : new WireError(describe(err));
    }

    return new WireConn(socket, signal);
  }

  /**
   * Hand the connection to a different lifetime.
   *
   * Setup runs under a short deadline; a peer that survives it must not then be killed when that
   * deadline expires, so the live session is re-parented onto the caller's long-lived signal.
   */
  adopt(signal: AbortSignal): void {
    this.#signal.removeEventListener("abort", this.#abortListener);
    this.#signal = signal;
    if (signal.aborted) {
      this.close();
      return;
    }
    signal.addEventListener("abort", this.#abortListener, { once: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Read exactly `n` bytes. Throws on EOF, on cancellation, or on any socket error. */
  async readExact(n: number): Promise<Uint8Array> {
    if (n < 0) throw new WireError(`negative read length ${n}`);
    while (this.#buffered < n) {
      if (this.#closed) throw new WireError("connection closed");
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await this.#reader.read();
      } catch (err) {
        this.close();
        if (this.#signal.aborted) throw new WireError("aborted during read");
        throw new WireError(`read failed: ${describe(err)}`);
      }
      // A cancelled reader settles as `done`, which is how an abort surfaces here.
      if (result.done) {
        this.close();
        throw new WireError(
          this.#signal.aborted ? "aborted during read" : "peer closed the connection",
        );
      }
      const chunk = result.value;
      if (chunk.length === 0) continue;
      // Copy before retaining: never hold a buffer the stream might reuse.
      this.#chunks.push(new Uint8Array(chunk));
      this.#buffered += chunk.length;
    }
    return this.#take(n);
  }

  /** Bytes already buffered, so a caller can drain without blocking. */
  get buffered(): number {
    return this.#buffered;
  }

  #take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0]!;
      const room = n - filled;
      if (chunk.length <= room) {
        out.set(chunk, filled);
        filled += chunk.length;
        this.#chunks.shift();
      } else {
        out.set(chunk.subarray(0, room), filled);
        this.#chunks[0] = chunk.subarray(room);
        filled = n;
      }
    }
    this.#buffered -= n;
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new WireError("connection closed");
    try {
      await this.#writer.write(data);
    } catch (err) {
      this.close();
      if (this.#signal.aborted) throw new WireError("aborted during write");
      throw new WireError(`write failed: ${describe(err)}`);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abortListener);
    this.#chunks = [];
    this.#buffered = 0;
    // Cancelling the reader is what actually unblocks a pending read; the rest is teardown.
    this.#reader.cancel().catch(() => {});
    this.#writer.abort().catch(() => {});
    this.#socket.close().catch(() => {});
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
