/**
 * Block-to-piece assembly.
 *
 * Every payload byte in this project passes through here, so the tests fill each block with a
 * pattern derived from its **absolute offset**: a block written to the wrong place cannot pass by
 * accident, which a fill of zeroes or of a constant would allow.
 */

import { describe, expect, it } from "vitest";
import { PieceAssembly, PieceStore } from "../src/pieces.ts";
import { BLOCK_SIZE } from "../src/wire/messages.ts";

const PIECE = 262_144;
/** 276,445,467 − 1054 × 262,144: the real last piece of Big Buck Bunny. */
const SHORT_PIECE = 145_691;

/** A byte that depends on where it lives, so a misplaced write is visible. */
const byteAt = (offset: number) => (offset * 31 + 7) & 0xff;

function block(begin: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = byteAt(begin + i);
  return out;
}

function expectExact(bytes: Uint8Array, length: number): void {
  expect(bytes.length).toBe(length);
  for (let i = 0; i < length; i++) {
    if (bytes[i] !== byteAt(i)) {
      throw new Error(`byte ${i} is ${bytes[i]}, expected ${byteAt(i)}`);
    }
  }
}

describe("PieceAssembly", () => {
  it("splits a full piece into sixteen 16 KiB blocks", () => {
    const piece = new PieceAssembly(0, PIECE);
    const needed = piece.needed();
    expect(needed).toHaveLength(16);
    expect(needed[0]).toEqual({ index: 0, begin: 0, length: BLOCK_SIZE });
    expect(needed[15]).toEqual({ index: 0, begin: 15 * BLOCK_SIZE, length: BLOCK_SIZE });
  });

  it("assembles in order, byte-exactly", () => {
    const piece = new PieceAssembly(3, PIECE);
    let completed = false;
    for (const request of piece.needed()) {
      completed = piece.addBlock(request.begin, block(request.begin, request.length));
    }
    expect(completed).toBe(true);
    expect(piece.complete).toBe(true);
    expectExact(piece.bytes, PIECE);
  });

  it("assembles out of order, byte-exactly", () => {
    const piece = new PieceAssembly(3, PIECE);
    const requests = [...piece.needed()].reverse();
    for (const request of requests) piece.addBlock(request.begin, block(request.begin, request.length));
    expect(piece.complete).toBe(true);
    expectExact(piece.bytes, PIECE);
  });

  it("completes a short final piece", () => {
    // The one case a constant block layout gets wrong. Its symptom is a stream that hangs one
    // piece from the end, which looks like a dead swarm rather than a bug.
    const piece = new PieceAssembly(1054, SHORT_PIECE);
    const needed = piece.needed();
    expect(needed).toHaveLength(Math.ceil(SHORT_PIECE / BLOCK_SIZE));
    expect(needed.at(-1)!.length).toBe(SHORT_PIECE % BLOCK_SIZE);
    for (const request of needed) piece.addBlock(request.begin, block(request.begin, request.length));
    expect(piece.complete).toBe(true);
    expectExact(piece.bytes, SHORT_PIECE);
  });

  it("ignores a duplicate block", () => {
    const piece = new PieceAssembly(0, PIECE);
    expect(piece.addBlock(0, block(0, BLOCK_SIZE))).toBe(false);
    expect(piece.addBlock(0, block(0, BLOCK_SIZE))).toBe(false);
    expect(piece.missingCount).toBe(15);
    expect(piece.received).toBe(BLOCK_SIZE);
  });

  it("ignores a stray offset — a peer may answer a cancelled request", () => {
    const piece = new PieceAssembly(0, PIECE);
    expect(piece.addBlock(7, block(7, BLOCK_SIZE))).toBe(false);
    expect(piece.missingCount).toBe(16);
  });

  it("refuses a block that would run past the end of the piece", () => {
    const piece = new PieceAssembly(1054, SHORT_PIECE);
    const last = piece.needed().at(-1)!;
    // A peer that miscounts is a peer to drop, not a reason to corrupt a piece.
    expect(piece.addBlock(last.begin, block(last.begin, BLOCK_SIZE))).toBe(false);
    expect(piece.complete).toBe(false);
  });

  it("restores the full block set on reset", () => {
    const piece = new PieceAssembly(0, PIECE);
    for (const request of piece.needed()) piece.addBlock(request.begin, block(request.begin, request.length));
    expect(piece.complete).toBe(true);
    piece.reset();
    expect(piece.complete).toBe(false);
    expect(piece.needed()).toHaveLength(16);
    expect(piece.received).toBe(0);
  });

  it("refuses a nonsensical length", () => {
    expect(() => new PieceAssembly(0, 0)).toThrow();
    expect(() => new PieceAssembly(0, -1)).toThrow();
  });
});

describe("PieceStore", () => {
  it("opens up to its piece count and then signals backpressure", () => {
    const store = new PieceStore(3, 1 << 30);
    for (let piece = 0; piece < 3; piece++) expect(store.open(piece, PIECE)).toBeDefined();
    expect(store.open(3, PIECE)).toBeUndefined();
    expect(store.size).toBe(3);
  });

  it("bounds bytes as well as count, because a piece can be 16 MiB", () => {
    // A count-only limit is not a limit against a 128 MB isolate.
    const store = new PieceStore(100, 2 * PIECE);
    expect(store.open(0, PIECE)).toBeDefined();
    expect(store.open(1, PIECE)).toBeDefined();
    expect(store.open(2, PIECE)).toBeUndefined();
    expect(store.bytesHeld).toBe(2 * PIECE);
  });

  it("is idempotent for a piece already open", () => {
    const store = new PieceStore(1, 1 << 30);
    const first = store.open(5, PIECE);
    expect(store.open(5, PIECE)).toBe(first);
    expect(store.size).toBe(1);
  });

  it("releases bytes on drop", () => {
    const store = new PieceStore(4, 1 << 30);
    store.open(0, PIECE);
    store.open(1, SHORT_PIECE);
    expect(store.bytesHeld).toBe(PIECE + SHORT_PIECE);
    store.drop(0);
    expect(store.bytesHeld).toBe(SHORT_PIECE);
    store.drop(999); // absent: a no-op, not a throw
    expect(store.size).toBe(1);
  });

  it("retains only what a seek still wants, and frees the rest", () => {
    const store = new PieceStore(8, 1 << 30);
    for (const piece of [10, 11, 12, 13]) store.open(piece, PIECE);
    const dropped = store.retain(new Set([11, 13]));
    expect(dropped.sort((a, b) => a - b)).toEqual([10, 12]);
    expect(store.keys().sort((a, b) => a - b)).toEqual([11, 13]);
    expect(store.bytesHeld).toBe(2 * PIECE);
  });

  it("walks outstanding blocks in the order it is given, capped", () => {
    const store = new PieceStore(4, 1 << 30);
    store.open(7, PIECE);
    store.open(2, PIECE);
    const requests = store.neededAcross([2, 7], 20);
    expect(requests).toHaveLength(20);
    // Priority order is honoured: piece 2's sixteen blocks come before piece 7's.
    expect(requests.slice(0, 16).every((r) => r.index === 2)).toBe(true);
    expect(requests.slice(16).every((r) => r.index === 7)).toBe(true);
  });

  it("skips a piece in the order that is not open", () => {
    const store = new PieceStore(4, 1 << 30);
    store.open(7, PIECE);
    const requests = store.neededAcross([2, 7], 100);
    expect(requests.every((r) => r.index === 7)).toBe(true);
    expect(requests).toHaveLength(16);
  });

  it("clears wholesale", () => {
    const store = new PieceStore(4, 1 << 30);
    store.open(0, PIECE);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.bytesHeld).toBe(0);
  });
});
