/**
 * The slice of the BitTorrent peer wire protocol this service needs: the 68-byte handshake, the
 * length-prefixed message framing, and enough of `bitfield` / `have` / `have all` / `have none` to
 * answer "is this peer alive and does it hold what we asked about."
 *
 * Deliberately self-contained rather than importing `clave`'s `src/wire/*`: those modules are
 * written against `cloudflare:sockets`, this one against Deno's `Deno.Conn`, and the two runtimes
 * do not share a socket shape. Byte-for-byte this is a port of `src/wire/handshake.ts` and the
 * relevant half of `src/wire/messages.ts` — if the wire format ever changes, both copies need it.
 */

const encoder = new TextEncoder();
const PROTOCOL = encoder.encode("BitTorrent protocol");
const HANDSHAKE_BYTES = 68;

const RESERVED_EXTENDED_BYTE = 5;
const RESERVED_EXTENDED_BIT = 0x10;
const RESERVED_LAST_BYTE = 7;
const RESERVED_FAST_BIT = 0x04;
const RESERVED_DHT_BIT = 0x01;

export const MSG_CHOKE = 0;
export const MSG_UNCHOKE = 1;
export const MSG_HAVE = 4;
export const MSG_BITFIELD = 5;
export const MSG_HAVE_ALL = 14;
export const MSG_HAVE_NONE = 15;
export const MSG_KEEPALIVE = -1;

/** Bounded for the same reason `clave` bounds it: the largest legitimate reply here is a bitfield
 * of one bit per piece, and nothing this service sends ever provokes a `piece` message. */
const MAX_MESSAGE_BYTES = 256 * 1024;

export class WireError extends Error {
  override readonly name = "WireError";
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function generatePeerId(): Uint8Array {
  const prefix = encoder.encode("-CP0001-");
  const out = new Uint8Array(20);
  out.set(prefix, 0);
  const random = crypto.getRandomValues(new Uint8Array(12));
  for (let i = 0; i < 12; i++) out[8 + i] = 0x30 + (random[i]! % 62);
  return out;
}

export function buildHandshake(infoHash: Uint8Array, peerId: Uint8Array): Uint8Array {
  if (infoHash.length !== 20) throw new WireError("infohash must be 20 bytes");
  if (peerId.length !== 20) throw new WireError("peer id must be 20 bytes");
  const out = new Uint8Array(HANDSHAKE_BYTES);
  out[0] = PROTOCOL.length;
  out.set(PROTOCOL, 1);
  out[20 + RESERVED_EXTENDED_BYTE] = RESERVED_EXTENDED_BIT;
  out[20 + RESERVED_LAST_BYTE] = RESERVED_FAST_BIT | RESERVED_DHT_BIT;
  out.set(infoHash, 28);
  out.set(peerId, 48);
  return out;
}

export interface HandshakeResult {
  readonly supportsExtended: boolean;
  readonly supportsFast: boolean;
  readonly supportsDht: boolean;
}

export function parseHandshakeResponse(response: Uint8Array, infoHash: Uint8Array): HandshakeResult {
  if (response[0] !== PROTOCOL.length || !bytesEqual(response.subarray(1, 20), PROTOCOL)) {
    throw new WireError("peer did not speak the BitTorrent protocol");
  }
  if (!bytesEqual(response.subarray(28, 48), infoHash)) {
    throw new WireError("peer returned a different infohash");
  }
  const reserved = response.subarray(20, 28);
  return {
    supportsExtended: (reserved[RESERVED_EXTENDED_BYTE]! & RESERVED_EXTENDED_BIT) !== 0,
    supportsFast: (reserved[RESERVED_LAST_BYTE]! & RESERVED_FAST_BIT) !== 0,
    supportsDht: (reserved[RESERVED_LAST_BYTE]! & RESERVED_DHT_BIT) !== 0,
  };
}

export function frame(id: number, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  const out = new Uint8Array(4 + 1 + body.length);
  new DataView(out.buffer).setUint32(0, 1 + body.length);
  out[4] = id;
  out.set(body, 5);
  return out;
}

export const interestedFrame = (): Uint8Array => frame(2);

export interface WireMessage {
  readonly id: number;
  readonly payload: Uint8Array;
}

/**
 * Buffers reads off a `Deno.Conn` so a caller can ask for exactly `n` bytes.
 *
 * `Deno.Conn.read` hands back however many bytes happened to arrive, same as any stream — this is
 * the same accumulate-and-slice shape as `clave`'s `WireConn#take`, just against Deno's `Reader`
 * interface instead of a `ReadableStreamDefaultReader`.
 */
export class FramedConn {
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #closed = false;

  constructor(private readonly conn: Deno.Conn) {}

  /**
   * Read exactly `n` bytes, or throw. There is no deadline parameter here on purpose — Deno gives
   * no way to cancel a pending `conn.read()` short of closing the connection, so a caller enforces
   * a timeout by racing this against a timer whose `onTimeout` closes the socket (see
   * `withTimeout` in `probe.ts`), which unblocks the read below with an error the same way an
   * aborted `cloudflare:sockets` read does in `clave`'s `WireConn`.
   */
  async readExact(n: number): Promise<Uint8Array> {
    if (n < 0) throw new WireError(`negative read length ${n}`);
    const buf = new Uint8Array(65536);
    while (this.#buffered < n) {
      if (this.#closed) throw new WireError("connection closed");
      let count: number | null;
      try {
        count = await this.conn.read(buf);
      } catch (err) {
        this.#closed = true;
        throw new WireError(`read failed: ${describe(err)}`);
      }
      if (count === null) {
        this.#closed = true;
        throw new WireError("peer closed the connection");
      }
      if (count === 0) continue;
      this.#chunks.push(buf.slice(0, count));
      this.#buffered += count;
    }
    return this.#take(n);
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
    let offset = 0;
    while (offset < data.length) {
      offset += await this.conn.write(data.subarray(offset));
    }
  }
}

export async function readMessage(conn: FramedConn): Promise<WireMessage> {
  const header = await conn.readExact(4);
  const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
  if (length === 0) return { id: MSG_KEEPALIVE, payload: new Uint8Array(0) };
  if (length > MAX_MESSAGE_BYTES) throw new WireError(`peer announced a ${length}-byte message`);
  const body = await conn.readExact(length);
  return { id: body[0]!, payload: body.subarray(1) };
}

/** Decode a `have` message. */
export function parseHave(payload: Uint8Array): number {
  if (payload.length < 4) throw new WireError(`have message is ${payload.length} bytes`);
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
}

/**
 * Which pieces a peer claims to hold. Big-endian bit order: the high bit of byte 0 is piece 0.
 * Only the read side is needed here — this service never assembles a bitfield to send.
 */
export class Bitfield {
  readonly #bits: Uint8Array;

  constructor(readonly pieceCount: number, bits: Uint8Array) {
    this.#bits = bits;
  }

  static fromPayload(payload: Uint8Array, pieceCount: number): Bitfield {
    if (payload.length < Math.ceil(pieceCount / 8)) {
      throw new WireError(`bitfield is ${payload.length} bytes for ${pieceCount} pieces`);
    }
    return new Bitfield(pieceCount, payload);
  }

  static full(pieceCount: number): Bitfield {
    return new Bitfield(pieceCount, new Uint8Array(Math.ceil(pieceCount / 8)).fill(0xff));
  }

  static empty(pieceCount: number): Bitfield {
    return new Bitfield(pieceCount, new Uint8Array(Math.ceil(pieceCount / 8)));
  }

  has(index: number): boolean {
    if (index < 0 || index >= this.pieceCount) return false;
    return (this.#bits[index >> 3]! & (0x80 >> (index & 7))) !== 0;
  }

  set(index: number): void {
    if (index < 0 || index >= this.pieceCount) return;
    this.#bits[index >> 3]! |= 0x80 >> (index & 7);
  }

  get count(): number {
    let total = 0;
    for (let index = 0; index < this.pieceCount; index++) if (this.has(index)) total++;
    return total;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
