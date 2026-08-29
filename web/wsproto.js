/**
 * Browser mirror of `src/wsproto.ts`.
 *
 * Duplicated rather than imported because the page is plain static files with no build step, and a
 * `.ts` file cannot be served to a browser. Drift between the two is therefore the real risk, so
 * `test/wsproto-mirror.test.ts` round-trips fixtures through the TypeScript encoder and this
 * decoder and fails loudly if either side moves.
 *
 * Asymmetric on purpose, and the reasons are in the Worker's copy: payload comes down as binary
 * because a piece is bytes, control goes up as text JSON because it is rare and inbound WebSocket
 * messages are billed at 20:1.
 */

export const FRAME_PIECE = 0x01;
export const FRAME_CONTROL = 0x02;

/** Tag, epoch, piece index. */
export const PIECE_HEADER_BYTES = 9;

/**
 * Decode one frame from the server.
 *
 * Returns `null` for an unknown tag rather than throwing, so a page running against a newer Worker
 * degrades instead of dying.
 */
export function decodeServerFrame(data) {
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
      return { kind: "control", control: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) };
    } catch {
      return null;
    }
  }
  return null;
}

/** The client half of the protocol. Text frames, all of them rare. */
export const client = {
  credit: (n) => JSON.stringify({ t: "credit", n }),
  nak: (pieces) => JSON.stringify({ t: "nak", p: pieces }),
  seekPiece: (piece) => JSON.stringify({ t: "seek", piece }),
  seekByte: (byte) => JSON.stringify({ t: "seek", byte }),
  bye: () => JSON.stringify({ t: "bye" }),
};
