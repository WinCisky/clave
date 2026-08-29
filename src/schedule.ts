/**
 * What to fetch next, and when to stop.
 *
 * Pure: no I/O, no bindings, no clock beyond what is passed in. Every other module in this project
 * is plumbing around the order this one decides, which is why it is the cheapest place to be
 * thorough and the most expensive place to be wrong.
 *
 * Priority, highest first:
 *
 *  1. **NAKs.** The client hashed a piece, it failed, and playback is stalled on it. It is also a
 *     piece we have already paid for once.
 *  2. **Bootstrap** — a head window then a tail window of the file. The head carries `ftyp` and a
 *     faststart MP4's `moov`, or Matroska's EBML header, Segment Info and SeekHead. The tail
 *     carries the `moov` of an MP4 written *without* faststart, which is the default output of many
 *     encoders. cf-stream learned this from production: a media element asks for the end of the
 *     file almost immediately, and an early version that retargeted its whole download window to
 *     satisfy that request orphaned the read-ahead it had already half-fetched and stalled.
 *  3. **Sequential** from the cursor.
 *
 * Bootstrap keeps its priority even after a seek. It is only a handful of pieces, and it is what
 * makes seeking work *at all* on a non-faststart file — dropping it to save two seconds once would
 * cost every later seek.
 *
 * Delivery stops at the file's last piece. This streams one file, not a torrent: the rest of the
 * torrent is never fetched, however much of it a peer offers.
 */

import type { PieceRange } from "./layout.ts";

export type NextAction = "tick" | "hold" | "idle";

export interface SchedulerInit {
  /** Inclusive piece range of the selected file. */
  readonly firstPiece: number;
  readonly lastPiece: number;
  /** Head window in piece indices. `last < first` means empty. */
  readonly head: PieceRange;
  /** Tail window in piece indices. May overlap the head entirely on a small file. */
  readonly tail: PieceRange;
}

/**
 * Enough to resume after the object hibernates.
 *
 * In-memory state does not survive hibernation, and hibernation is *the* cost lever here — an open
 * outbound TCP socket makes a Durable Object ineligible for it, so a paused player is exactly when
 * the sockets get dropped and the object goes away. Without this, resuming would re-deliver the
 * film from the start.
 *
 * `sent` is run-length encoded as inclusive `[from, to]` pairs. A sequential stream produces one
 * run, so the common case is a handful of bytes rather than one number per piece — which matters,
 * because this is stored against a 16 KB attachment budget and an 8,192-piece film would otherwise
 * not fit.
 */
export interface SchedulerSnapshot {
  readonly v: 1;
  readonly epoch: number;
  readonly cursor: number;
  readonly sent: readonly [number, number][];
  readonly naks: readonly number[];
  readonly bootstrap: readonly number[];
}

export class Scheduler {
  readonly firstPiece: number;
  readonly lastPiece: number;
  readonly total: number;

  #epoch = 0;
  #cursor: number;
  /** Pieces handed to the client and not since rejected. */
  readonly #sent = new Set<number>();
  /** Rejected pieces, in arrival order. A queue, because the client may reject several at once. */
  #naks: number[] = [];
  /** Head then tail, de-duplicated, in the order they should be fetched. */
  #bootstrap: number[];

  constructor(init: SchedulerInit) {
    if (init.lastPiece < init.firstPiece) {
      throw new Error(`empty piece range ${init.firstPiece}..${init.lastPiece}`);
    }
    this.firstPiece = init.firstPiece;
    this.lastPiece = init.lastPiece;
    this.total = init.lastPiece - init.firstPiece + 1;
    this.#cursor = init.firstPiece;

    // Head before tail, and each clamped into the file. A small file can produce windows that
    // overlap completely, so the set is what de-duplicates them rather than the caller.
    const seen = new Set<number>();
    const bootstrap: number[] = [];
    for (const window of [init.head, init.tail]) {
      for (let piece = window.first; piece <= window.last; piece++) {
        if (piece < this.firstPiece || piece > this.lastPiece) continue;
        if (seen.has(piece)) continue;
        seen.add(piece);
        bootstrap.push(piece);
      }
    }
    this.#bootstrap = bootstrap;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get sentCount(): number {
    return this.#sent.size;
  }

  /** Pieces of the file still owed to the client. */
  get remaining(): number {
    return this.total - this.#sent.size;
  }

  get done(): boolean {
    return this.remaining === 0;
  }

  /** True until every bootstrap piece has been delivered. */
  get bootstrapping(): boolean {
    return this.#bootstrap.length > 0;
  }

  get nakCount(): number {
    return this.#naks.length;
  }

  /** Rejected pieces, in arrival order. The dispatcher needs them to order its block requests. */
  get naked(): readonly number[] {
    return this.#naks;
  }

  /**
   * A sort key matching `plan`'s priority, for a piece already being assembled.
   *
   * Needed because deciding *what* to assemble is not the same as deciding what to **request
   * blocks for**, and only the second one governs what arrives first. Sorting open assemblies by
   * piece index instead loses the whole point of the tail window: the tail of a film has the
   * highest indices, so it queues behind every sequential piece and a non-faststart `moov` never
   * turns up until the film is nearly done.
   */
  priority(pieceIndex: number): number {
    const nak = this.#naks.indexOf(pieceIndex);
    if (nak !== -1) return nak;
    const bootstrap = this.#bootstrap.indexOf(pieceIndex);
    if (bootstrap !== -1) return 1_000_000 + bootstrap;
    return 2_000_000 + pieceIndex;
  }

  /**
   * The next pieces to work on, most urgent first, at most `limit` of them and never more than
   * `credit` allows.
   *
   * `inFlight` are pieces already being assembled; they are never returned again, so the caller
   * can pass its assembly keys directly and does not have to de-duplicate.
   */
  plan(limit: number, credit: number, inFlight: ReadonlySet<number>): number[] {
    const budget = Math.min(limit, credit);
    if (budget <= 0) return [];
    const out: number[] = [];
    const taken = new Set<number>();

    const take = (piece: number): boolean => {
      if (taken.has(piece) || inFlight.has(piece)) return false;
      taken.add(piece);
      out.push(piece);
      return out.length >= budget;
    };

    for (const piece of this.#naks) {
      if (take(piece)) return out;
    }
    for (const piece of this.#bootstrap) {
      if (this.#sent.has(piece)) continue;
      if (take(piece)) return out;
    }

    // Sequential. `#cursor` only ever moves forward past pieces that are sent, and a rejected
    // piece comes back through the NAK queue rather than through this scan, so skipping sent
    // pieces here cannot lose one.
    this.#advanceCursor();
    for (let piece = this.#cursor; piece <= this.lastPiece; piece++) {
      if (this.#sent.has(piece)) continue;
      if (take(piece)) return out;
    }
    return out;
  }

  /** A piece was handed to the client. */
  markSent(pieceIndex: number): void {
    if (pieceIndex < this.firstPiece || pieceIndex > this.lastPiece) return;
    this.#sent.add(pieceIndex);
    if (this.#naks.length > 0) this.#naks = this.#naks.filter((piece) => piece !== pieceIndex);
    if (this.#bootstrap.length > 0) {
      this.#bootstrap = this.#bootstrap.filter((piece) => piece !== pieceIndex);
    }
    this.#advanceCursor();
  }

  /**
   * The client rejected these.
   *
   * An index outside the file is ignored rather than thrown on: the client is untrusted input, and
   * one malformed message must not end a stream it has half-buffered.
   */
  nak(pieces: readonly number[]): void {
    for (const piece of pieces) {
      if (!Number.isInteger(piece)) continue;
      if (piece < this.firstPiece || piece > this.lastPiece) continue;
      this.#sent.delete(piece);
      if (!this.#naks.includes(piece)) this.#naks.push(piece);
    }
  }

  /**
   * Jump. Returns the new epoch, which the caller must stamp on every subsequent frame so the
   * client can discard pieces that were already in flight for the old position.
   *
   * The cursor is clamped into the file; a seek past the end is a seek to the end.
   */
  seek(pieceIndex: number): number {
    this.#cursor = Math.max(this.firstPiece, Math.min(pieceIndex, this.lastPiece));
    this.#epoch += 1;
    return this.#epoch;
  }

  /**
   * Of the pieces currently being assembled, the ones still worth the memory.
   *
   * Called after a seek. Anything else is bytes for a position nobody is watching, and holding it
   * starves the pieces that are now wanted.
   */
  keepAfterSeek(inFlight: ReadonlySet<number>): Set<number> {
    const keep = new Set<number>();
    for (const piece of inFlight) {
      if (this.#naks.includes(piece)) {
        keep.add(piece);
        continue;
      }
      if (this.#bootstrap.includes(piece) && !this.#sent.has(piece)) {
        keep.add(piece);
        continue;
      }
      if (piece >= this.#cursor && piece <= this.lastPiece && !this.#sent.has(piece)) {
        keep.add(piece);
      }
    }
    return keep;
  }

  /** State worth carrying across a hibernation. */
  snapshot(): SchedulerSnapshot {
    return {
      v: 1,
      epoch: this.#epoch,
      cursor: this.#cursor,
      sent: runsOf(this.#sent),
      naks: [...this.#naks],
      bootstrap: [...this.#bootstrap],
    };
  }

  /**
   * Rebuild from a snapshot.
   *
   * `init` is recomputed from the layout rather than stored, so a snapshot cannot outlive a change
   * in geometry; anything in the snapshot that falls outside the range is dropped.
   */
  static restore(init: SchedulerInit, snapshot: SchedulerSnapshot): Scheduler {
    const scheduler = new Scheduler(init);
    if (snapshot.v !== 1) return scheduler;

    for (const [from, to] of snapshot.sent) {
      for (let piece = Math.max(from, init.firstPiece); piece <= Math.min(to, init.lastPiece); piece++) {
        scheduler.#sent.add(piece);
      }
    }
    scheduler.#naks = snapshot.naks.filter((piece) =>
      piece >= init.firstPiece && piece <= init.lastPiece
    );
    scheduler.#bootstrap = snapshot.bootstrap.filter((piece) =>
      piece >= init.firstPiece && piece <= init.lastPiece && !scheduler.#sent.has(piece)
    );
    scheduler.#epoch = Number.isInteger(snapshot.epoch) && snapshot.epoch >= 0 ? snapshot.epoch : 0;
    scheduler.#cursor = Math.max(
      init.firstPiece,
      Math.min(snapshot.cursor, init.lastPiece),
    );
    scheduler.#advanceCursor();
    return scheduler;
  }

  #advanceCursor(): void {
    while (this.#cursor <= this.lastPiece && this.#sent.has(this.#cursor)) this.#cursor += 1;
  }
}

/**
 * Whether the session should work, wait, or let go of its sockets.
 *
 * The three-way answer is the whole cost model. `"hold"` arms nothing and waits to be woken —
 * cf-stream re-armed an alarm here instead and spent thousands of billed invocations doing nothing
 * but waiting. `"idle"` is the lever that actually matters: an open outbound TCP socket is exactly
 * what makes a Durable Object ineligible to hibernate, so dropping the peers is what stops
 * duration accruing, and duration is the binding free-tier constraint.
 */
export function nextAction(
  queued: number,
  demandAgeMs: number,
  idleMs: number,
  holdMs = idleMs,
): NextAction {
  if (demandAgeMs >= idleMs) return "idle";
  if (queued > 0) return "tick";
  // Caught up while still being watched. Sockets are expensive to replace, so they are worth
  // holding — but only until `holdMs`, after which hibernating beats keeping them warm.
  return demandAgeMs >= holdMs ? "idle" : "hold";
}

/** Inclusive `[from, to]` runs over a set of piece indices, ascending. */
function runsOf(pieces: ReadonlySet<number>): [number, number][] {
  if (pieces.size === 0) return [];
  const sorted = [...pieces].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  let from = sorted[0]!;
  let previous = from;
  for (let i = 1; i < sorted.length; i++) {
    const piece = sorted[i]!;
    if (piece === previous + 1) {
      previous = piece;
      continue;
    }
    runs.push([from, previous]);
    from = piece;
    previous = piece;
  }
  runs.push([from, previous]);
  return runs;
}
