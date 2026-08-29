/**
 * The byte gate: reading a file that is only partly downloaded.
 *
 * This is the piece of the player most likely to be wrong in a way nothing else notices. Its
 * arithmetic maps file bytes onto torrent pieces — a file rarely starts on a piece boundary — and
 * its waiting logic decides whether a demuxer blocked on a missing piece ever gets unblocked. A bug
 * in the first shows up as a corrupt picture; a bug in the second as a spinner that never stops.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JavaScript, exactly as the browser loads it.
import { ByteStore } from "../web/player/store.js";

/** A file at torrent offset 5 with 16-byte pieces, so nothing lines up conveniently. */
function makeStore(options: {
  have?: Set<number>;
  cursor?: number;
  offset?: number;
  length?: number;
  pieceLength?: number;
} = {}) {
  const pieceLength = options.pieceLength ?? 16;
  const have = options.have ?? new Set<number>();
  const asked: number[] = [];
  // A clock the test drives, so "has this reader been stuck long enough to be worth a seek?" can be
  // asserted without waiting in real time.
  const clock = { now: 1_000_000 };
  const store = new ByteStore({
    now: () => clock.now,
    chunks: { pieceLength, totalLength: 4096 },
    file: { offset: options.offset ?? 5, length: options.length ?? 100 },
    readAt: (offset: number, length: number) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = (offset + i) & 0xff;
      return out;
    },
    hasPiece: (piece: number) => have.has(piece),
    requestPieces: (piece: number) => asked.push(piece),
    cursor: () => options.cursor ?? 0,
  });
  return { store, have, asked, clock };
}

describe("piece arithmetic", () => {
  it("maps file bytes onto the torrent pieces that hold them", () => {
    const { store } = makeStore();
    // File byte 0 is torrent byte 5, which is inside piece 0.
    expect(store.pieceSpan(0, 10)).toEqual({ first: 0, last: 0 });
    // File bytes 11..29 are torrent bytes 16..34: pieces 1 and 2.
    expect(store.pieceSpan(11, 30)).toEqual({ first: 1, last: 2 });
  });

  it("never reports a span past the end of the file", () => {
    const { store } = makeStore();
    // The file ends at torrent byte 104, in piece 6. Asking beyond it must not invent pieces.
    expect(store.pieceSpan(0, 10_000).last).toBe(6);
  });

  it("treats a request of zero length as needing nothing", async () => {
    const { store } = makeStore();
    await expect(store.read(50, 50)).resolves.toHaveLength(0);
  });

  it("reports the first missing piece of a range, not merely that one is missing", () => {
    const { store } = makeStore({ have: new Set([0, 1, 2, 4]) });
    expect(store.firstMissing(0, 40)).toBe(-1);
    expect(store.firstMissing(0, 60)).toBe(3);
    expect(store.available(0, 40)).toBe(true);
    expect(store.available(0, 60)).toBe(false);
  });

  it("measures how far a contiguous run reaches, in file bytes", () => {
    const { store } = makeStore({ have: new Set([0, 1, 2]) });
    // Pieces 0..2 cover torrent bytes 0..47, so file bytes 0..42 inclusive.
    expect(store.contiguousFrom(0)).toBe(43);
  });

  it("describes what is held as file byte ranges, with the holes left out", () => {
    const { store } = makeStore({ have: new Set([0, 1, 2, 4, 5, 6]) });
    expect(store.availableRanges()).toEqual([[0, 43], [59, 100]]);
  });
});

describe("waiting for pieces that have not arrived", () => {
  it("returns immediately when everything is already held", async () => {
    const { store, asked } = makeStore({ have: new Set([0, 1, 2, 3, 4, 5, 6]) });
    const bytes = await store.read(0, 60);
    expect(bytes).toHaveLength(60);
    expect(asked).toEqual([]);
  });

  it("resolves the read once the last missing piece lands", async () => {
    const { store, have } = makeStore({ have: new Set([0, 1, 2]) });
    let settled = false;
    const read = store.read(0, 60).then((bytes: Uint8Array) => { settled = true; return bytes; });

    have.add(3);
    store.pieceArrived();
    // Piece 4 is still missing, so the read must still be waiting.
    await Promise.resolve();
    expect(settled).toBe(false);

    have.add(4);
    store.pieceArrived();
    await expect(read).resolves.toHaveLength(60);
  });

  it("leaves the relay alone when it is already heading for the missing piece", async () => {
    const { store, asked, clock, have } = makeStore({ have: new Set(), cursor: 0 });
    void store.read(0, 32).catch(() => {});
    clock.now += 60_000;
    have.add(99);
    store.pieceArrived();
    // Piece 0 is within the lookahead of a cursor at 0; moving it would only restart what it does.
    expect(asked).toEqual([]);
  });

  /**
   * The one that matters. While playback runs, the demuxer reads ahead constantly and some of those
   * reads land beyond the lookahead — but the sequential download reaches them in a second or two.
   * Acting immediately restarts the relay's cursor over and over; measured against the live swarm
   * that was seven cursor resets in a hundred seconds and throughput down from 2.4 to 0.06 MiB/s.
   */
  it("does not move the relay for a read that has only just blocked", async () => {
    const { store, asked, clock, have } = makeStore({ have: new Set(), cursor: 500 });
    void store.read(0, 32).catch(() => {});
    clock.now += 500;
    have.add(99);
    store.pieceArrived();
    expect(asked).toEqual([]);
  });

  it("moves the relay for a read that stays blocked", async () => {
    const { store, asked, clock, have } = makeStore({ have: new Set(), cursor: 500 });
    void store.read(0, 32).catch(() => {});
    clock.now += 5_000;
    have.add(99);
    store.pieceArrived();
    expect(asked).toEqual([0]);
  });

  it("asks only once for the same piece, however many reads block on it", async () => {
    const { store, asked, clock, have } = makeStore({ have: new Set(), cursor: 500 });
    void store.read(0, 32).catch(() => {});
    void store.read(0, 48).catch(() => {});
    clock.now += 5_000;
    have.add(99);
    store.pieceArrived();
    expect(asked).toEqual([0]);
  });

  it("holds a minimum gap between demands, so several stuck readers cannot thrash the cursor", async () => {
    const { store, asked, clock, have } = makeStore({ have: new Set(), cursor: 500 });
    void store.read(0, 32).catch(() => {});
    clock.now += 5_000;
    have.add(99);
    store.pieceArrived();
    expect(asked).toEqual([0]);

    // A different reader, stuck on a different piece, immediately afterwards.
    void store.read(90, 100).catch(() => {});
    clock.now += 3_000;
    have.add(98);
    store.pieceArrived();
    expect(asked).toEqual([0]);
  });

  it("rejects rather than hanging once the relay has given up", async () => {
    const { store } = makeStore({ have: new Set() });
    const read = store.read(0, 32);
    store.exhaust("the relay could not supply 4 pieces");
    await expect(read).rejects.toThrow("could not supply");
  });

  it("rejects a read that arrives after the relay has already given up", async () => {
    const { store } = makeStore({ have: new Set() });
    store.exhaust("nothing left to try");
    await expect(store.read(0, 32)).rejects.toThrow("nothing left to try");
  });
});
