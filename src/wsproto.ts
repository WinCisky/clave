/**
 * The one protocol the browser and this Worker share.
 *
 * Asymmetric on purpose. Payload goes out as **binary**, because a piece is bytes and base64 in
 * JSON would cost a third more bandwidth and a full copy of the video through a string encoder.
 * Control goes back as **text JSON**, because it is rare and readability is worth more than the
 * bytes: inbound WebSocket messages bill at 20:1, so a hundred of them cost five requests.
 *
 * Frames are self-describing by a leading tag byte so a client can dispatch before parsing.
 */

export const FRAME_PIECE = 0x01;
export const FRAME_CONTROL = 0x02;

/** Tag, epoch, piece index. */
export const PIECE_HEADER_BYTES = 9;

/** What the server says. Always inside a {@link FRAME_CONTROL} frame. */
export type ServerControl =
  /** Sent once, before any payload, so the client can size its buffers and fetch piece hashes. */
  | {
    readonly t: "ready";
    readonly infoHash: string;
    readonly pieceLength: number;
    readonly pieceCount: number;
    readonly totalLength: number;
    readonly file: {
      readonly index: number;
      readonly path: string;
      readonly offset: number;
      readonly length: number;
      readonly mime: string;
    };
    /** Inclusive piece range of the selected file. Nothing outside it will ever be sent. */
    readonly firstPiece: number;
    readonly lastPiece: number;
    /** Pieces the client may hold before it must grant more credit. */
    readonly creditWindow: number;
  }
  /** Periodic, and cheap: outbound messages are not billed as requests. */
  | {
    readonly t: "stats";
    readonly epoch: number;
    readonly cursor: number;
    readonly sent: number;
    readonly peers: number;
    readonly dialsInFlight: number;
    readonly bytesOut: number;
  }
  /** Every piece of the file has been sent at least once. */
  | { readonly t: "eof"; readonly sent: number }
  | { readonly t: "error"; readonly code: string; readonly message: string };

/** What the client says. Always a text frame. */
export type ClientControl =
  /** Grant room for `n` more pieces. The server stops requesting when credit runs out. */
  | { readonly t: "credit"; readonly n: number }
  /** These pieces failed SHA-1. Re-fetch them, preferring a peer that did not serve them. */
  | { readonly t: "nak"; readonly p: readonly number[] }
  /**
   * Jump. Exactly one of `piece` or `byte` (an offset within the file).
   * Bumps the epoch, so pieces already in flight for the old position can be discarded.
   */
  | { readonly t: "seek"; readonly piece?: number; readonly byte?: number }
  | { readonly t: "bye" };

/**
 * Frame one piece for the wire.
 *
 * One allocation and one copy. This runs once per piece on the hot path, so it does no more than
 * it has to — no `DataView` on a fresh buffer per call, no intermediate array.
 */
export function encodePiece(epoch: number, pieceIndex: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(PIECE_HEADER_BYTES + bytes.length);
  out[0] = FRAME_PIECE;
  const view = new DataView(out.buffer, out.byteOffset, PIECE_HEADER_BYTES);
  view.setUint32(1, epoch);
  view.setUint32(5, pieceIndex);
  out.set(bytes, PIECE_HEADER_BYTES);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeControl(message: ServerControl): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const out = new Uint8Array(1 + body.length);
  out[0] = FRAME_CONTROL;
  out.set(body, 1);
  return out;
}

export interface DecodedPiece {
  readonly epoch: number;
  readonly pieceIndex: number;
  readonly bytes: Uint8Array;
}

/**
 * Decode a server frame. Used by the test client and by anyone writing a browser client.
 *
 * Returns `null` for a frame with an unknown tag rather than throwing, so a client written
 * against an older version of this file degrades instead of dying.
 */
export function decodeServerFrame(
  data: ArrayBuffer | Uint8Array,
): { kind: "piece"; piece: DecodedPiece } | { kind: "control"; control: ServerControl } | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) return null;
  if (bytes[0] === FRAME_PIECE) {
    if (bytes.length < PIECE_HEADER_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      kind: "piece",
      piece: {
        epoch: view.getUint32(1),
        pieceIndex: view.getUint32(5),
        bytes: bytes.subarray(PIECE_HEADER_BYTES),
      },
    };
  }
  if (bytes[0] === FRAME_CONTROL) {
    try {
      return { kind: "control", control: JSON.parse(decoder.decode(bytes.subarray(1))) };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse a client message.
 *
 * Everything a peer of this Worker sends is untrusted input, so this validates shape and range
 * rather than casting. An unparseable message is `null`, which the session answers with an
 * `error` control frame instead of closing the socket — a client that sends one bad message
 * should not lose the stream it has half-buffered.
 */
export function parseClientControl(raw: string | ArrayBuffer): ClientControl | null {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else {
    text = decoder.decode(raw);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;

  switch (message["t"]) {
    case "credit": {
      const n = message["n"];
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
      return { t: "credit", n: Math.min(Math.trunc(n), 1 << 20) };
    }
    case "nak": {
      const p = message["p"];
      if (!Array.isArray(p) || p.length === 0) return null;
      const pieces: number[] = [];
      for (const entry of p) {
        if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) return null;
        pieces.push(entry);
      }
      return { t: "nak", p: pieces };
    }
    case "seek": {
      const piece = message["piece"];
      const byte = message["byte"];
      if (typeof piece === "number" && Number.isInteger(piece) && piece >= 0) {
        return { t: "seek", piece };
      }
      if (typeof byte === "number" && Number.isFinite(byte) && byte >= 0) {
        return { t: "seek", byte: Math.trunc(byte) };
      }
      return null;
    }
    case "bye":
      return { t: "bye" };
    default:
      return null;
  }
}
