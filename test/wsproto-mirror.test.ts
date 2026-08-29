/**
 * The browser client duplicates the wire contract in `web/wsproto.js`, because the page is plain
 * static files with no build step and a `.ts` module cannot be served to a browser.
 *
 * Duplication means drift, and drift here is silent: a changed header size does not throw, it
 * shifts every piece index by a few bytes and presents as universally failing hashes. So this
 * round-trips fixtures through the TypeScript encoder and the browser decoder, and fails the moment
 * either side moves.
 */

import { describe, expect, it } from "vitest";
import {
  encodeControl,
  encodePiece,
  parseClientControl,
  PIECE_HEADER_BYTES,
  type ServerControl,
} from "../src/wsproto.ts";

// @ts-expect-error — plain JavaScript, deliberately untyped, exactly as the browser loads it.
import * as mirror from "../web/wsproto.js";

describe("constants agree", () => {
  it("tags and header size", () => {
    expect(mirror.FRAME_PIECE).toBe(0x01);
    expect(mirror.FRAME_CONTROL).toBe(0x02);
    expect(mirror.PIECE_HEADER_BYTES).toBe(PIECE_HEADER_BYTES);
  });
});

describe("piece frames", () => {
  it("round-trip through both sides", () => {
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) & 0xff;

    const encoded = encodePiece(42, 1053, payload);
    const decoded = mirror.decodeServerFrame(encoded);

    expect(decoded.kind).toBe("piece");
    expect(decoded.piece.epoch).toBe(42);
    expect(decoded.piece.pieceIndex).toBe(1053);
    expect([...decoded.piece.bytes]).toEqual([...payload]);
  });

  it("survive the top of the u32 range", () => {
    // An epoch or piece index read as signed would come back negative here.
    const decoded = mirror.decodeServerFrame(encodePiece(4_294_967_295, 4_294_967_294, new Uint8Array(1)));
    expect(decoded.piece.epoch).toBe(4_294_967_295);
    expect(decoded.piece.pieceIndex).toBe(4_294_967_294);
  });

  it("decode an empty final piece body without inventing one", () => {
    const decoded = mirror.decodeServerFrame(encodePiece(0, 0, new Uint8Array(0)));
    expect(decoded.piece.bytes.length).toBe(0);
  });

  it("are rejected when truncated below the header", () => {
    expect(mirror.decodeServerFrame(new Uint8Array([0x01, 0, 0, 0]))).toBeNull();
  });
});

describe("control frames", () => {
  const cases: ServerControl[] = [
    {
      t: "ready",
      infoHash: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
      pieceLength: 262_144,
      pieceCount: 1055,
      totalLength: 276_445_467,
      file: { index: 1, path: "Big Buck Bunny.mp4", offset: 140, length: 276_134_947, mime: "video/mp4" },
      firstPiece: 0,
      lastPiece: 1053,
      creditWindow: 64,
    },
    { t: "stats", epoch: 2, cursor: 500, sent: 480, peers: 9, dialsInFlight: 2, bytesOut: 125_829_120 },
    { t: "eof", sent: 1054 },
    { t: "error", code: "peers_exhausted", message: "no peer answered" },
  ];

  for (const control of cases) {
    it(`round-trip ${control.t}`, () => {
      const decoded = mirror.decodeServerFrame(encodeControl(control));
      expect(decoded.kind).toBe("control");
      expect(decoded.control).toEqual(control);
    });
  }

  it("an unknown tag degrades to null instead of throwing", () => {
    expect(mirror.decodeServerFrame(new Uint8Array([0x7f, 1, 2, 3]))).toBeNull();
    expect(mirror.decodeServerFrame(new Uint8Array(0))).toBeNull();
  });

  it("malformed JSON in a control frame is null, not an exception", () => {
    expect(mirror.decodeServerFrame(new Uint8Array([0x02, 0x7b, 0x7b]))).toBeNull();
  });
});

describe("the client half", () => {
  it("produces messages the server accepts", () => {
    expect(parseClientControl(mirror.client.credit(64))).toEqual({ t: "credit", n: 64 });
    expect(parseClientControl(mirror.client.nak([12, 13]))).toEqual({ t: "nak", p: [12, 13] });
    expect(parseClientControl(mirror.client.seekPiece(420))).toEqual({ t: "seek", piece: 420 });
    expect(parseClientControl(mirror.client.seekByte(1_048_576))).toEqual({ t: "seek", byte: 1_048_576 });
    expect(parseClientControl(mirror.client.bye())).toEqual({ t: "bye" });
  });
});
