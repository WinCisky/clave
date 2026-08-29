/**
 * Peer wire message framing, and the data-transfer half of the protocol.
 *
 * ma-stream only ever needed the metadata half — it speaks BEP-10 and BEP-9 and discards every
 * other message, so `request`, `piece`, `cancel`, `have`, `bitfield`, `choke` and `unchoke` are
 * unimplemented there. They are implemented here, because downloading the payload is this
 * service's entire job.
 *
 * The length prefix is the one field a peer fully controls before we allocate anything, so it is
 * bounded. `MAX_MESSAGE_BYTES` is deliberately much tighter than ma-stream's 1 MiB: the largest
 * thing we can legitimately receive is now a 16 KiB block (32 KiB from a generous client) or a
 * bitfield of one bit per piece — 15 KB even for a 120,000-piece torrent.
 */

import { WireConn, WireError } from "./conn.ts";

export const MSG_CHOKE = 0;
export const MSG_UNCHOKE = 1;
export const MSG_INTERESTED = 2;
export const MSG_NOT_INTERESTED = 3;
export const MSG_HAVE = 4;
export const MSG_BITFIELD = 5;
export const MSG_REQUEST = 6;
export const MSG_PIECE = 7;
export const MSG_CANCEL = 8;
export const MSG_PORT = 9;

/**
 * BEP-6 fast extension. Advertised in the handshake, so these *will* arrive and must be handled.
 *
 * `have all` and `have none` replace the bitfield entirely for peers that speak this, and treating
 * them as unknown messages is not harmless: the peer's bitfield stays empty, every `has()` returns
 * false, and a seeder is silently never asked for anything. That failure looks exactly like a
 * swarm full of peers that connect and then do nothing.
 */
export const MSG_SUGGEST_PIECE = 13;
export const MSG_HAVE_ALL = 14;
export const MSG_HAVE_NONE = 15;
export const MSG_REJECT_REQUEST = 16;
export const MSG_ALLOWED_FAST = 17;

export const MSG_EXTENDED = 20;

/** Synthetic id for a zero-length keep-alive, which carries no id byte of its own. */
export const MSG_KEEPALIVE = -1;

export const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * The block size every client agrees on. Asking for more than 16 KiB is how you get disconnected
 * by half the swarm, so it is a constant rather than a tunable.
 */
export const BLOCK_SIZE = 16 * 1024;

export interface WireMessage {
  readonly id: number;
  readonly payload: Uint8Array;
}

export function frame(id: number, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  const out = new Uint8Array(4 + 1 + body.length);
  new DataView(out.buffer).setUint32(0, 1 + body.length);
  out[4] = id;
  out.set(body, 5);
  return out;
}

/** BEP-10 envelope: `<len><20><extendedId><payload>`. */
export function extendedFrame(extendedId: number, payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(1 + payload.length);
  body[0] = extendedId;
  body.set(payload, 1);
  return frame(MSG_EXTENDED, body);
}

export const chokeFrame = (): Uint8Array => frame(MSG_CHOKE);
export const unchokeFrame = (): Uint8Array => frame(MSG_UNCHOKE);
export const interestedFrame = (): Uint8Array => frame(MSG_INTERESTED);
export const notInterestedFrame = (): Uint8Array => frame(MSG_NOT_INTERESTED);
export const keepAliveFrame = (): Uint8Array => new Uint8Array(4);

function blockFrame(id: number, index: number, begin: number, length: number): Uint8Array {
  const body = new Uint8Array(12);
  const view = new DataView(body.buffer);
  view.setUint32(0, index);
  view.setUint32(4, begin);
  view.setUint32(8, length);
  return frame(id, body);
}

/** `request`: give me `length` bytes of piece `index`, starting at `begin`. */
export const requestFrame = (index: number, begin: number, length: number): Uint8Array =>
  blockFrame(MSG_REQUEST, index, begin, length);

/**
 * `cancel`: withdraw a request.
 *
 * Sent when a block arrives from a faster peer, so the slow one does not spend upload bandwidth
 * on bytes we already have — and, more importantly here, so its reply does not have to be parsed
 * and discarded on our CPU budget.
 */
export const cancelFrame = (index: number, begin: number, length: number): Uint8Array =>
  blockFrame(MSG_CANCEL, index, begin, length);

export async function readMessage(conn: WireConn): Promise<WireMessage> {
  const header = await conn.readExact(4);
  const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
  if (length === 0) return { id: MSG_KEEPALIVE, payload: new Uint8Array(0) };
  if (length > MAX_MESSAGE_BYTES) {
    throw new WireError(`peer announced a ${length}-byte message`);
  }
  const body = await conn.readExact(length);
  return { id: body[0]!, payload: body.subarray(1) };
}

/** Split a BEP-10 message body into its extended id and payload. */
export function splitExtended(
  payload: Uint8Array,
): { extendedId: number; body: Uint8Array } | null {
  if (payload.length === 0) return null;
  return { extendedId: payload[0]!, body: payload.subarray(1) };
}

export interface PieceMessage {
  readonly index: number;
  readonly begin: number;
  /** A view into the message buffer, not a copy. */
  readonly block: Uint8Array;
}

/**
 * Decode a `piece` message.
 *
 * A malformed one is a protocol error rather than something to skip: a peer that cannot frame a
 * block correctly cannot be trusted to have sent the right bytes either.
 */
export function parsePiece(payload: Uint8Array): PieceMessage {
  if (payload.length < 8) throw new WireError(`piece message is ${payload.length} bytes`);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    index: view.getUint32(0),
    begin: view.getUint32(4),
    block: payload.subarray(8),
  };
}

/** Decode a `have` message. */
export function parseHave(payload: Uint8Array): number {
  if (payload.length < 4) throw new WireError(`have message is ${payload.length} bytes`);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getUint32(0);
}

/** Decode `request`/`cancel`, which share a layout. Used when testing against a real client. */
export function parseBlockRequest(
  payload: Uint8Array,
): { index: number; begin: number; length: number } {
  if (payload.length < 12) throw new WireError(`block request is ${payload.length} bytes`);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { index: view.getUint32(0), begin: view.getUint32(4), length: view.getUint32(8) };
}

/**
 * Which pieces a peer claims to hold.
 *
 * Big-endian bit order: the *high* bit of the first byte is piece 0. Getting this backwards is a
 * classic bug whose symptom is requesting pieces the peer does not have and being ignored, which
 * looks exactly like a slow swarm.
 */
export class Bitfield {
  readonly #bits: Uint8Array;

  constructor(readonly pieceCount: number, bits?: Uint8Array) {
    const needed = Math.ceil(pieceCount / 8);
    this.#bits = bits ?? new Uint8Array(needed);
    if (this.#bits.length < needed) {
      throw new WireError(`bitfield is ${this.#bits.length} bytes, need ${needed}`);
    }
  }

  static fromPayload(payload: Uint8Array, pieceCount: number): Bitfield {
    // A peer sending a short bitfield is broken; one sending a longer one is padding, which is
    // legal — the spare high bits must simply be zero, and we never read them.
    if (payload.length < Math.ceil(pieceCount / 8)) {
      throw new WireError(`bitfield is ${payload.length} bytes for ${pieceCount} pieces`);
    }
    return new Bitfield(pieceCount, new Uint8Array(payload));
  }

  /** Every piece, for a peer that announced no bitfield but claims to be a seed. */
  static full(pieceCount: number): Bitfield {
    const field = new Bitfield(pieceCount);
    for (let index = 0; index < pieceCount; index++) field.set(index);
    return field;
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

/** How many blocks a piece of this length splits into, and the size of each. */
export function blocksFor(pieceLength: number): { begin: number; length: number }[] {
  const out: { begin: number; length: number }[] = [];
  for (let begin = 0; begin < pieceLength; begin += BLOCK_SIZE) {
    out.push({ begin, length: Math.min(BLOCK_SIZE, pieceLength - begin) });
  }
  return out;
}
