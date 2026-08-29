/**
 * Assembling pieces out of 16 KiB blocks.
 *
 * cf-stream's equivalent module assembled 4 MiB R2 *segments* and verified each piece with SHA-1
 * before storing it. Both of those are gone: there is no store, and the browser verifies. What is
 * left is the part that was never optional — collecting blocks into whole pieces, because SHA-1 is
 * defined over a piece and the client cannot check anything smaller.
 *
 * Two invariants carried over, both learned the hard way:
 *
 *  - **The last piece of a torrent is short.** Its length is `min(pieceLength, totalLength -
 *    index × pieceLength)`, and the caller passes that. Deriving the block layout from a constant
 *    instead means the final piece never completes and the stream hangs one piece from the end,
 *    which looks like a dead swarm rather than a bug.
 *  - **Blocks are written straight into the piece buffer** at their offset. One allocation per
 *    piece, no per-block retention, and no second copy of the video over the session's lifetime.
 *    The caller has already copied the block off the socket (`WireConn` copies on read, and the
 *    read loop copies again before handing it over), so nothing here needs to.
 */

import { blocksFor } from "./wire/messages.ts";

export interface BlockRequest {
  readonly index: number;
  readonly begin: number;
  readonly length: number;
}

/** One piece being filled. */
export class PieceAssembly {
  readonly #buffer: Uint8Array;
  /** Block offsets still outstanding. Empty means the piece is whole. */
  readonly #missing = new Set<number>();
  #received = 0;

  constructor(readonly pieceIndex: number, readonly pieceLength: number) {
    if (!Number.isInteger(pieceLength) || pieceLength <= 0) {
      throw new Error(`piece ${pieceIndex} has a length of ${pieceLength}`);
    }
    this.#buffer = new Uint8Array(pieceLength);
    for (const block of blocksFor(pieceLength)) this.#missing.add(block.begin);
  }

  /** Blocks still needed, in offset order — which is the order they will be played in. */
  needed(): BlockRequest[] {
    const out: BlockRequest[] = [];
    for (const block of blocksFor(this.pieceLength)) {
      if (this.#missing.has(block.begin)) {
        out.push({ index: this.pieceIndex, begin: block.begin, length: block.length });
      }
    }
    return out;
  }

  /**
   * Store a block. Returns true when this one completed the piece.
   *
   * A duplicate, a stray, or one that runs past the end of the piece is ignored rather than
   * treated as an error: a peer may answer a request that has since been cancelled, and a peer
   * that miscounts is a peer to drop, not a reason to fail a piece other peers are filling.
   */
  addBlock(begin: number, block: Uint8Array): boolean {
    if (!this.#missing.has(begin)) return false;
    if (begin + block.length > this.pieceLength) return false;
    this.#buffer.set(block, begin);
    this.#missing.delete(begin);
    this.#received += block.length;
    return this.#missing.size === 0;
  }

  /** Put every block back, for a piece the client rejected. */
  reset(): void {
    this.#missing.clear();
    for (const block of blocksFor(this.pieceLength)) this.#missing.add(block.begin);
    this.#received = 0;
  }

  get complete(): boolean {
    return this.#missing.size === 0;
  }

  get received(): number {
    return this.#received;
  }

  get missingCount(): number {
    return this.#missing.size;
  }

  /** The finished piece. Only meaningful once `complete`. */
  get bytes(): Uint8Array {
    return this.#buffer;
  }
}

/**
 * The pieces in flight at once.
 *
 * Bounded twice, by count *and* by bytes, because a count alone is not a bound: a piece is 256 KiB
 * on the sample torrent but 16 MiB on a large one, and this runs in a 128 MB isolate. `open`
 * returning `undefined` is the backpressure signal — the caller stops asking for more pieces until
 * something drains.
 */
export class PieceStore {
  /** Insertion-ordered, which `retain` and the eviction paths rely on. */
  readonly #open = new Map<number, PieceAssembly>();
  #bytesHeld = 0;

  constructor(readonly maxPieces: number, readonly memoryBudgetBytes: number) {}

  /** Opens an assembly if there is room for it, else `undefined`. Idempotent for an open piece. */
  open(pieceIndex: number, pieceLength: number): PieceAssembly | undefined {
    const existing = this.#open.get(pieceIndex);
    if (existing !== undefined) return existing;
    if (this.#open.size >= this.maxPieces) return undefined;
    if (this.#bytesHeld + pieceLength > this.memoryBudgetBytes) return undefined;

    const assembly = new PieceAssembly(pieceIndex, pieceLength);
    this.#open.set(pieceIndex, assembly);
    this.#bytesHeld += pieceLength;
    return assembly;
  }

  get(pieceIndex: number): PieceAssembly | undefined {
    return this.#open.get(pieceIndex);
  }

  drop(pieceIndex: number): void {
    const assembly = this.#open.get(pieceIndex);
    if (assembly === undefined) return;
    this.#open.delete(pieceIndex);
    this.#bytesHeld -= assembly.pieceLength;
  }

  /**
   * Discard everything not in `keep`. Returns what was dropped.
   *
   * This is the seek path: after a jump, most of what is half-assembled is bytes nobody is going
   * to watch, and holding them starves the pieces that are now wanted.
   */
  retain(keep: ReadonlySet<number>): number[] {
    const dropped: number[] = [];
    for (const pieceIndex of [...this.#open.keys()]) {
      if (!keep.has(pieceIndex)) {
        this.drop(pieceIndex);
        dropped.push(pieceIndex);
      }
    }
    return dropped;
  }

  /**
   * Every outstanding block across the open assemblies, visiting pieces in the order given.
   *
   * The order is the scheduler's priority, so the blocks come out in the order they should be
   * requested. Capped, because this feeds a request pipeline and not an unbounded queue.
   */
  neededAcross(order: readonly number[], limit: number): BlockRequest[] {
    const out: BlockRequest[] = [];
    for (const pieceIndex of order) {
      const assembly = this.#open.get(pieceIndex);
      if (assembly === undefined) continue;
      for (const block of assembly.needed()) {
        out.push(block);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  get size(): number {
    return this.#open.size;
  }

  get bytesHeld(): number {
    return this.#bytesHeld;
  }

  keys(): number[] {
    return [...this.#open.keys()];
  }

  clear(): void {
    this.#open.clear();
    this.#bytesHeld = 0;
  }
}
