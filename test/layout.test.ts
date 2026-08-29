/**
 * Piece arithmetic.
 *
 * The module where a mistake is quietest: a wrong offset does not throw, it plays for four seconds
 * and dies. So every case here uses the **real** Big Buck Bunny geometry, whose video file starts
 * at torrent byte 140 behind a 140-byte subtitle track. An unaligned file offset is both the case
 * that breaks naive arithmetic and the case that actually occurs.
 */

import { describe, expect, it } from "vitest";
import { settings, tailBytesFor, type Settings } from "../src/config.ts";
import {
  LayoutError,
  pieceIndexAt,
  pieceLengthAt,
  pieceOfFileOffset,
  pieceRangeOfFile,
  pieceRangeOfWindow,
  resolveFile,
  type TorrentLayout,
} from "../src/layout.ts";

const BBB: TorrentLayout = {
  id: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
  name: "Big Buck Bunny",
  pieceLength: 262_144,
  pieceCount: 1055,
  totalLength: 276_445_467,
  files: [
    { path: "Big Buck Bunny.en.srt", length: 140, offset: 0 },
    { path: "Big Buck Bunny.mp4", length: 276_134_947, offset: 140, mime: "video/mp4" },
    { path: "poster.jpg", length: 310_380, offset: 276_135_087 },
  ],
  fileIndex: 1,
  filePath: "Big Buck Bunny.mp4",
  fileOffset: 140,
  fileLength: 276_134_947,
  mime: "video/mp4",
};

const video = resolveFile(BBB);
const config: Settings = settings({} as never);

describe("pieceIndexAt", () => {
  it("maps torrent bytes to pieces", () => {
    expect(pieceIndexAt(0, 262_144)).toBe(0);
    expect(pieceIndexAt(262_143, 262_144)).toBe(0);
    expect(pieceIndexAt(262_144, 262_144)).toBe(1);
    expect(pieceIndexAt(276_445_466, 262_144)).toBe(1054);
  });
});

describe("pieceLengthAt", () => {
  it("gives the full length for every piece but the last", () => {
    expect(pieceLengthAt(BBB, 0)).toBe(262_144);
    expect(pieceLengthAt(BBB, 527)).toBe(262_144);
    expect(pieceLengthAt(BBB, 1053)).toBe(262_144);
  });

  it("shortens the torrent's final piece", () => {
    // 276,445,467 − 1054 × 262,144. Deriving the block layout from the constant instead means the
    // final piece never completes and the stream hangs one piece from the end.
    expect(pieceLengthAt(BBB, 1054)).toBe(145_691);
    const sum = 1054 * 262_144 + pieceLengthAt(BBB, 1054);
    expect(sum).toBe(BBB.totalLength);
  });
});

describe("resolveFile", () => {
  it("defaults to the selection bstream made", () => {
    expect(resolveFile(BBB)).toEqual({
      index: 1,
      path: "Big Buck Bunny.mp4",
      offset: 140,
      length: 276_134_947,
      mime: "video/mp4",
    });
    expect(resolveFile(BBB, null)).toEqual(resolveFile(BBB));
  });

  it("indexes files as stored, padding entries included", () => {
    expect(resolveFile(BBB, 0).path).toBe("Big Buck Bunny.en.srt");
    expect(resolveFile(BBB, 2).path).toBe("poster.jpg");
    expect(resolveFile(BBB, 2).mime).toBe("application/octet-stream");
  });

  it("refuses an index the torrent does not have", () => {
    for (const wanted of [-1, 3, 1.5]) {
      expect(() => resolveFile(BBB, wanted)).toThrow(LayoutError);
    }
  });

  it("refuses a padding entry rather than skipping it", () => {
    // Filtering padding would shift every later index by one and silently serve the wrong file.
    const padded: TorrentLayout = {
      ...BBB,
      files: [BBB.files[0]!, { path: ".pad/123", length: 123, offset: 140, padding: true },
        BBB.files[1]!],
    };
    expect(() => resolveFile(padded, 1)).toThrow(/padding/);
  });
});

describe("pieceRangeOfFile", () => {
  it("stops before the piece that belongs to the next file", () => {
    // The video ends at torrent byte 276,135,086. Piece 1054 holds poster.jpg and must never be
    // fetched — this streams one file, not a torrent.
    expect(pieceRangeOfFile(BBB, video)).toEqual({ first: 0, last: 1053 });
  });

  it("shares its first and last piece with its neighbours", () => {
    const srt = pieceRangeOfFile(BBB, resolveFile(BBB, 0));
    const poster = pieceRangeOfFile(BBB, resolveFile(BBB, 2));
    // Piece 0 carries 140 bytes of subtitle before the video begins, which is exactly why the
    // client receives whole pieces and trims them itself.
    expect(srt).toEqual({ first: 0, last: 0 });
    expect(poster).toEqual({ first: 1053, last: 1054 });
    expect(poster.first).toBe(pieceRangeOfFile(BBB, video).last);
  });

  it("handles a zero-length file without producing an inverted range", () => {
    const empty = { index: 9, path: "empty", offset: 262_144, length: 0, mime: "x" };
    expect(pieceRangeOfFile(BBB, empty)).toEqual({ first: 1, last: 1 });
  });
});

describe("pieceRangeOfWindow", () => {
  it("covers a 2 MiB head window — nine pieces, not eight", () => {
    // 2 MiB is exactly eight pieces, but the file starts at torrent byte 140, so the window ends
    // at torrent byte 2,097,291 and spills 139 bytes into piece 8. Piece-aligned arithmetic would
    // stop at 7 and hand the demuxer a truncated `moov`.
    expect(pieceRangeOfWindow(BBB, video, 0, config.headBytes)).toEqual({ first: 0, last: 8 });
  });

  it("covers a proportional tail window", () => {
    const tail = tailBytesFor(video.length, config);
    // 1% of a 276 MB file, which is inside the 1-16 MiB clamp.
    expect(tail).toBe(2_761_349);
    const range = pieceRangeOfWindow(BBB, video, video.length - tail, tail);
    expect(range).toEqual({ first: 1042, last: 1053 });
    // The tail must reach the file's real last piece, or a non-faststart `moov` is missed.
    expect(range.last).toBe(pieceRangeOfFile(BBB, video).last);
  });

  it("signals an empty window with last < first", () => {
    for (const length of [0, -1]) {
      const range = pieceRangeOfWindow(BBB, video, 0, length);
      expect(range.last).toBeLessThan(range.first);
    }
  });

  it("clamps a window that runs past either end of the file", () => {
    expect(pieceRangeOfWindow(BBB, video, -1_000, 10)).toEqual({ first: 0, last: 0 });
    const past = pieceRangeOfWindow(BBB, video, video.length - 10, 1_000_000);
    expect(past.last).toBe(1053);
  });
});

describe("pieceOfFileOffset", () => {
  it("translates a client seek", () => {
    expect(pieceOfFileOffset(BBB, video, 0)).toBe(0);
    expect(pieceOfFileOffset(BBB, video, 262_004)).toBe(1);
    expect(pieceOfFileOffset(BBB, video, video.length - 1)).toBe(1053);
  });

  it("clamps a seek past either end into the file", () => {
    expect(pieceOfFileOffset(BBB, video, -5)).toBe(0);
    expect(pieceOfFileOffset(BBB, video, video.length * 2)).toBe(1053);
  });

  it("puts the file's first piece-aligned byte in piece 1", () => {
    // 262,144 − 140. The first byte of the file that begins a piece, which is the boundary a
    // naive implementation gets wrong by exactly 140 bytes.
    expect(pieceOfFileOffset(BBB, video, 262_144 - 140)).toBe(1);
    expect(pieceOfFileOffset(BBB, video, 262_144 - 141)).toBe(0);
  });
});

describe("walking the whole file", () => {
  it("tiles it in contiguous windows with no gap and no inversion", () => {
    const step = 4 * 1024 * 1024;
    let previousLast = -1;
    let windows = 0;
    for (let at = 0; at < video.length; at += step) {
      const range = pieceRangeOfWindow(BBB, video, at, Math.min(step, video.length - at));
      expect(range.first).toBeLessThanOrEqual(range.last);
      // Consecutive windows either continue from the previous piece or share it, never skip one.
      expect(range.first).toBeLessThanOrEqual(previousLast + 1);
      expect(range.first).toBeGreaterThanOrEqual(previousLast);
      previousLast = range.last;
      windows += 1;
    }
    expect(windows).toBeGreaterThan(50);
    expect(previousLast).toBe(pieceRangeOfFile(BBB, video).last);
  });
});
