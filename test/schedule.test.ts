/**
 * The order pieces are fetched in, which is the whole product.
 *
 * Fixtures use the real Big Buck Bunny geometry: the video is file 1, so its pieces are 0..1053 of
 * a 1055-piece torrent, its head window is 0..8 and its proportional tail window is 1042..1053.
 */

import { describe, expect, it } from "vitest";
import { nextAction, Scheduler, type SchedulerInit } from "../src/schedule.ts";

const BBB: SchedulerInit = {
  firstPiece: 0,
  lastPiece: 1053,
  head: { first: 0, last: 8 },
  tail: { first: 1042, last: 1053 },
};

const HEAD = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const TAIL = [1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050, 1051, 1052, 1053];
const NONE: ReadonlySet<number> = new Set();

const fresh = (init: SchedulerInit = BBB) => new Scheduler(init);

/** Deliver everything the scheduler asks for until it is done, recording the order. */
function drain(scheduler: Scheduler, perPass = 64): number[] {
  const order: number[] = [];
  let guard = 0;
  while (!scheduler.done && guard++ < 10_000) {
    const planned = scheduler.plan(perPass, 1_000_000, NONE);
    if (planned.length === 0) break;
    for (const piece of planned) {
      order.push(piece);
      scheduler.markSent(piece);
    }
  }
  return order;
}

describe("bootstrap", () => {
  it("asks for the head window first, in order", () => {
    expect(fresh().plan(9, 100, NONE)).toEqual(HEAD);
  });

  it("asks for the tail window next, before any sequential piece", () => {
    // The tail is where a non-faststart MP4 keeps its `moov`, and a media element asks for the end
    // of the file almost immediately.
    expect(fresh().plan(21, 100, NONE)).toEqual([...HEAD, ...TAIL]);
  });

  it("only then continues sequentially, skipping what it already queued", () => {
    expect(fresh().plan(25, 100, NONE)).toEqual([...HEAD, ...TAIL, 9, 10, 11, 12]);
  });

  it("reports itself bootstrapping until both windows are delivered", () => {
    const scheduler = fresh();
    expect(scheduler.bootstrapping).toBe(true);
    for (const piece of [...HEAD, ...TAIL]) {
      expect(scheduler.bootstrapping).toBe(true);
      scheduler.markSent(piece);
    }
    expect(scheduler.bootstrapping).toBe(false);
    expect(scheduler.plan(3, 100, NONE)).toEqual([9, 10, 11]);
  });

  it("de-duplicates windows that overlap completely on a small file", () => {
    const small = fresh({
      firstPiece: 4,
      lastPiece: 6,
      head: { first: 4, last: 6 },
      tail: { first: 4, last: 6 },
    });
    expect(small.plan(10, 100, NONE)).toEqual([4, 5, 6]);
  });

  it("ignores an empty window and a window outside the file", () => {
    const scheduler = fresh({
      firstPiece: 10,
      lastPiece: 12,
      head: { first: 0, last: -1 },
      tail: { first: 100, last: 200 },
    });
    expect(scheduler.bootstrapping).toBe(false);
    expect(scheduler.plan(10, 100, NONE)).toEqual([10, 11, 12]);
  });
});

describe("budgets", () => {
  it("respects the smaller of limit and credit", () => {
    expect(fresh().plan(4, 100, NONE)).toHaveLength(4);
    expect(fresh().plan(100, 4, NONE)).toHaveLength(4);
    expect(fresh().plan(0, 100, NONE)).toEqual([]);
    expect(fresh().plan(100, 0, NONE)).toEqual([]);
    expect(fresh().plan(100, -1, NONE)).toEqual([]);
  });

  it("never re-plans a piece already being assembled", () => {
    const inFlight = new Set([0, 1, 2, 1042]);
    const planned = fresh().plan(10, 100, inFlight);
    for (const piece of inFlight) expect(planned).not.toContain(piece);
    expect(planned).toEqual([3, 4, 5, 6, 7, 8, 1043, 1044, 1045, 1046]);
  });
});

describe("NAK", () => {
  it("jumps ahead of everything, including bootstrap", () => {
    const scheduler = fresh();
    scheduler.markSent(500);
    scheduler.nak([500]);
    expect(scheduler.plan(3, 100, NONE)).toEqual([500, 0, 1]);
  });

  it("re-owes a piece that had been delivered", () => {
    const scheduler = fresh();
    scheduler.markSent(500);
    expect(scheduler.remaining).toBe(1053);
    scheduler.nak([500]);
    expect(scheduler.remaining).toBe(1054);
    expect(scheduler.nakCount).toBe(1);
  });

  it("keeps several rejected pieces in the order they arrived", () => {
    const scheduler = fresh();
    for (const piece of [900, 200, 700]) scheduler.markSent(piece);
    scheduler.nak([900, 200]);
    scheduler.nak([700]);
    expect(scheduler.plan(3, 100, NONE)).toEqual([900, 200, 700]);
  });

  it("does not queue the same piece twice", () => {
    const scheduler = fresh();
    scheduler.nak([500, 500]);
    scheduler.nak([500]);
    expect(scheduler.nakCount).toBe(1);
  });

  it("ignores indices outside the file rather than throwing", () => {
    // The client is untrusted input; one bad message must not end a half-buffered stream.
    const scheduler = fresh();
    scheduler.nak([-1, 1054, 99_999, 1.5, Number.NaN]);
    expect(scheduler.nakCount).toBe(0);
    expect(scheduler.plan(1, 100, NONE)).toEqual([0]);
  });

  it("clears a NAK once the replacement is delivered", () => {
    const scheduler = fresh();
    scheduler.markSent(500);
    scheduler.nak([500]);
    scheduler.markSent(500);
    expect(scheduler.nakCount).toBe(0);
    expect(scheduler.plan(1, 100, NONE)).toEqual([0]);
  });
});

describe("seek", () => {
  it("bumps the epoch monotonically", () => {
    const scheduler = fresh();
    expect(scheduler.epoch).toBe(0);
    expect(scheduler.seek(500)).toBe(1);
    expect(scheduler.seek(600)).toBe(2);
    expect(scheduler.epoch).toBe(2);
  });

  it("moves the cursor and resumes sequentially from there", () => {
    const scheduler = fresh();
    for (const piece of [...HEAD, ...TAIL]) scheduler.markSent(piece);
    scheduler.seek(500);
    expect(scheduler.cursor).toBe(500);
    expect(scheduler.plan(3, 100, NONE)).toEqual([500, 501, 502]);
  });

  it("clamps a seek past either end into the file", () => {
    const scheduler = fresh();
    expect(scheduler.seek(99_999)).toBe(1);
    expect(scheduler.cursor).toBe(1053);
    scheduler.seek(-10);
    expect(scheduler.cursor).toBe(0);
  });

  it("keeps bootstrap prioritised after a seek", () => {
    // Bootstrap is a handful of pieces and it is what makes seeking work at all on a file whose
    // `moov` lives at the end. Dropping it to save two seconds once would cost every later seek.
    const scheduler = fresh();
    scheduler.seek(500);
    expect(scheduler.plan(2, 100, NONE)).toEqual([0, 1]);
  });

  it("does not re-serve pieces the client already holds", () => {
    const scheduler = fresh();
    for (const piece of [...HEAD, ...TAIL, 9, 10, 11, 12]) scheduler.markSent(piece);
    scheduler.seek(9);
    // A viewer seeking backward into delivered territory gets nothing re-sent.
    expect(scheduler.plan(3, 100, NONE)).toEqual([13, 14, 15]);
  });

  it("still re-serves a rejected piece behind the cursor", () => {
    const scheduler = fresh();
    for (const piece of [...HEAD, ...TAIL, 9, 10]) scheduler.markSent(piece);
    scheduler.seek(900);
    scheduler.nak([9]);
    expect(scheduler.plan(2, 100, NONE)).toEqual([9, 900]);
  });
});

describe("keepAfterSeek", () => {
  it("keeps what is still wanted and discards the rest", () => {
    const scheduler = fresh();
    for (const piece of [...HEAD, ...TAIL]) scheduler.markSent(piece);
    scheduler.seek(500);
    // 100 is behind the new cursor and undelivered — nobody is watching it any more.
    const keep = scheduler.keepAfterSeek(new Set([100, 500, 501, 1042]));
    expect([...keep].sort((a, b) => a - b)).toEqual([500, 501]);
  });

  it("keeps a rejected piece wherever it sits", () => {
    const scheduler = fresh();
    scheduler.markSent(100);
    scheduler.nak([100]);
    scheduler.seek(500);
    expect(scheduler.keepAfterSeek(new Set([100]))).toEqual(new Set([100]));
  });

  it("keeps an undelivered bootstrap piece behind the cursor", () => {
    const scheduler = fresh();
    scheduler.seek(500);
    expect(scheduler.keepAfterSeek(new Set([3]))).toEqual(new Set([3]));
  });

  it("discards a bootstrap piece that has already been delivered", () => {
    const scheduler = fresh();
    scheduler.markSent(3);
    scheduler.seek(500);
    expect(scheduler.keepAfterSeek(new Set([3]))).toEqual(new Set());
  });
});

describe("finishing", () => {
  it("delivers every piece of the file exactly once and then stops", () => {
    const scheduler = fresh();
    const order = drain(scheduler);
    expect(scheduler.done).toBe(true);
    expect(order).toHaveLength(1054);
    expect(new Set(order).size).toBe(1054);
    expect(Math.min(...order)).toBe(0);
    expect(Math.max(...order)).toBe(1053);
  });

  it("never asks for the piece that belongs to the next file", () => {
    // Piece 1054 holds poster.jpg. This streams one file, not a torrent.
    expect(drain(fresh())).not.toContain(1054);
  });

  it("delivers bootstrap before anything else, then runs monotonically", () => {
    const order = drain(fresh());
    expect(order.slice(0, 21)).toEqual([...HEAD, ...TAIL]);
    const sequential = order.slice(21);
    for (let i = 1; i < sequential.length; i++) {
      expect(sequential[i]!).toBeGreaterThan(sequential[i - 1]!);
    }
  });

  it("plans nothing more once done", () => {
    const scheduler = fresh();
    drain(scheduler);
    expect(scheduler.plan(10, 100, NONE)).toEqual([]);
    expect(scheduler.remaining).toBe(0);
  });

  it("handles a file occupying a single piece", () => {
    const one = fresh({
      firstPiece: 42,
      lastPiece: 42,
      head: { first: 42, last: 42 },
      tail: { first: 42, last: 42 },
    });
    expect(one.plan(10, 100, NONE)).toEqual([42]);
    one.markSent(42);
    expect(one.done).toBe(true);
  });

  it("refuses an inverted range at construction", () => {
    expect(() =>
      fresh({ firstPiece: 5, lastPiece: 4, head: { first: 0, last: -1 }, tail: { first: 0, last: -1 } })
    ).toThrow();
  });
});

describe("nextAction", () => {
  const IDLE = 120_000;
  const HOLD = 20_000;

  it("works while there is work and someone watching", () => {
    expect(nextAction(5, 0, IDLE, HOLD)).toBe("tick");
    expect(nextAction(1, HOLD + 1, IDLE, HOLD)).toBe("tick");
  });

  it("holds its sockets when caught up but still watched", () => {
    // Arming an alarm here instead is an unbounded spin: cf-stream spent thousands of billed
    // invocations doing nothing but waiting.
    expect(nextAction(0, 0, IDLE, HOLD)).toBe("hold");
    expect(nextAction(0, HOLD - 1, IDLE, HOLD)).toBe("hold");
  });

  it("lets go once holding costs more than re-dialling", () => {
    // An open outbound TCP socket is exactly what makes a Durable Object ineligible to hibernate,
    // so dropping the peers is what stops duration accruing.
    expect(nextAction(0, HOLD, IDLE, HOLD)).toBe("idle");
  });

  it("goes idle when nobody is watching, work or not", () => {
    expect(nextAction(500, IDLE, IDLE, HOLD)).toBe("idle");
  });

  it("collapses hold into idle when no separate hold window is given", () => {
    expect(nextAction(0, 0, IDLE)).toBe("hold");
    expect(nextAction(0, IDLE, IDLE)).toBe("idle");
  });
});

describe("snapshot and restore", () => {
  it("round-trips a fresh scheduler", () => {
    const before = fresh();
    const after = Scheduler.restore(BBB, before.snapshot());
    expect(after.plan(21, 100, NONE)).toEqual([...HEAD, ...TAIL]);
    expect(after.epoch).toBe(0);
    expect(after.cursor).toBe(0);
  });

  it("round-trips mid-stream, resuming where it left off", () => {
    const before = fresh();
    for (const piece of [...HEAD, ...TAIL]) before.markSent(piece);
    for (let piece = 9; piece < 400; piece++) before.markSent(piece);
    before.seek(700);
    before.markSent(700);

    const after = Scheduler.restore(BBB, before.snapshot());
    expect(after.epoch).toBe(before.epoch);
    expect(after.cursor).toBe(before.cursor);
    expect(after.sentCount).toBe(before.sentCount);
    expect(after.remaining).toBe(before.remaining);
    expect(after.plan(3, 100, NONE)).toEqual(before.plan(3, 100, NONE));
  });

  it("compresses a sequential stream into a single run", () => {
    const scheduler = fresh();
    for (let piece = 0; piece <= 1053; piece++) scheduler.markSent(piece);
    expect(scheduler.snapshot().sent).toEqual([[0, 1053]]);
  });

  it("stays small enough for a 16 KB attachment on a fragmented 8,192-piece film", () => {
    const big: SchedulerInit = {
      firstPiece: 0,
      lastPiece: 8_191,
      head: { first: 0, last: 8 },
      tail: { first: 8_100, last: 8_191 },
    };
    const scheduler = new Scheduler(big);
    // Worst realistic shape: bootstrap delivered, then a long sequential run, then a seek.
    for (let piece = 0; piece <= 8; piece++) scheduler.markSent(piece);
    for (let piece = 8_100; piece <= 8_191; piece++) scheduler.markSent(piece);
    for (let piece = 9; piece < 4_000; piece++) scheduler.markSent(piece);
    scheduler.seek(6_000);
    for (let piece = 6_000; piece < 6_500; piece++) scheduler.markSent(piece);
    const bytes = new TextEncoder().encode(JSON.stringify(scheduler.snapshot())).length;
    expect(bytes).toBeLessThan(1_024);
  });

  it("carries rejected pieces across", () => {
    const before = fresh();
    before.markSent(500);
    before.nak([500]);
    const after = Scheduler.restore(BBB, before.snapshot());
    expect(after.nakCount).toBe(1);
    expect(after.plan(1, 100, NONE)).toEqual([500]);
  });

  it("drops anything that falls outside a changed geometry", () => {
    const before = fresh();
    for (let piece = 0; piece <= 1053; piece++) before.markSent(piece);
    before.nak([1053]);
    // A snapshot must not outlive the layout it was taken against.
    const smaller: SchedulerInit = {
      firstPiece: 0,
      lastPiece: 99,
      head: { first: 0, last: 4 },
      tail: { first: 95, last: 99 },
    };
    const after = Scheduler.restore(smaller, before.snapshot());
    expect(after.sentCount).toBe(100);
    expect(after.nakCount).toBe(0);
    // The cursor walks past the last delivered piece, so one beyond the end is what "exhausted"
    // looks like.
    expect(after.cursor).toBe(100);
    expect(after.done).toBe(true);
    expect(after.plan(10, 100, NONE)).toEqual([]);
  });

  it("ignores a snapshot from a future version rather than trusting it", () => {
    const bogus = { ...fresh().snapshot(), v: 2 as unknown as 1, cursor: 900 };
    const after = Scheduler.restore(BBB, bogus);
    expect(after.cursor).toBe(0);
    expect(after.epoch).toBe(0);
  });
});

describe("priority", () => {
  it("ranks a rejected piece above everything", () => {
    const scheduler = fresh();
    scheduler.markSent(900);
    scheduler.nak([900]);
    expect(scheduler.priority(900)).toBeLessThan(scheduler.priority(0));
    expect(scheduler.priority(900)).toBeLessThan(scheduler.priority(1042));
  });

  it("ranks the tail window above sequential pieces with far lower indices", () => {
    // The bug this exists to prevent: sorting open assemblies by piece index puts the tail of the
    // film last, so a non-faststart `moov` arrives only when the film is nearly downloaded.
    const scheduler = fresh();
    expect(scheduler.priority(1042)).toBeLessThan(scheduler.priority(9));
    expect(scheduler.priority(1053)).toBeLessThan(scheduler.priority(10));
  });

  it("keeps head before tail, and both in window order", () => {
    const scheduler = fresh();
    expect(scheduler.priority(0)).toBeLessThan(scheduler.priority(8));
    expect(scheduler.priority(8)).toBeLessThan(scheduler.priority(1042));
    expect(scheduler.priority(1042)).toBeLessThan(scheduler.priority(1053));
  });

  it("orders sequential pieces among themselves by index", () => {
    const scheduler = fresh();
    expect(scheduler.priority(9)).toBeLessThan(scheduler.priority(10));
    expect(scheduler.priority(500)).toBeLessThan(scheduler.priority(501));
  });

  it("agrees with the order plan produces", () => {
    const scheduler = fresh();
    const planned = scheduler.plan(40, 1000, NONE);
    const byPriority = [...planned].sort((a, b) => scheduler.priority(a) - scheduler.priority(b));
    expect(byPriority).toEqual(planned);
  });

  it("demotes a bootstrap piece once it has been delivered", () => {
    const scheduler = fresh();
    scheduler.markSent(1042);
    // No longer in the bootstrap list, so it falls back to its sequential rank.
    expect(scheduler.priority(1042)).toBeGreaterThan(scheduler.priority(9));
  });
});
