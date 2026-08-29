/**
 * Deciding which peers to keep, which to blame, and when the peer list itself is the problem.
 *
 * All pure. Lifted out of cf-stream's Durable Object because these are the decisions that
 * determine whether a stream recovers from a bad swarm, and none of them were testable while they
 * lived inside a class that needed a runtime to instantiate.
 */

/** A peer that has said nothing for this long has stopped being a peer. */
export const STALL_MS = 12_000;

/** Consecutive failed dials before the list, not the moment, is presumed to be at fault. */
export const DIAL_FAILURE_STREAK = 40;

/** A peer list older than this is worth re-fetching even if it has entries left. */
export const SWARM_STALE_MS = 15 * 60_000;

/**
 * Which peers to give up on when the pool has gone quiet.
 *
 * Two tiers, because they mean different things. A peer that has *never* delivered has proved
 * nothing about itself and is the obvious thing to drop — it may be choking us indefinitely, or
 * lack every piece in the window. Only when there is no such peer, and the whole pool has gone
 * silent anyway, is it right to drop peers that were working: a swarm that delivered and then
 * stopped is better replaced than waited on.
 *
 * Returns keys to close. Empty means the pool is fine and nothing should be disturbed — which is
 * the answer during any healthy download, since a delivering peer resets the clock constantly.
 */
export function starvedPeers(
  peers: readonly { key: string; delivered: number; connectedAt: number; deliveredAt: number }[],
  now: number,
  stallMs = STALL_MS,
): string[] {
  const unproven = peers.filter((p) => p.delivered === 0 && now - p.connectedAt >= stallMs);
  if (unproven.length > 0) return unproven.map((p) => p.key);
  const allQuiet = peers.length > 0 &&
    peers.every((p) => p.deliveredAt > 0 && now - p.deliveredAt >= stallMs);
  return allQuiet ? peers.map((p) => p.key) : [];
}

/**
 * Whether the trouble is this peer list rather than this moment.
 *
 * Exhaustion is the obvious case; the other two matter because the list that broke cf-stream in
 * production was neither exhausted nor recently written — it was three and a half hours old with
 * 330 untried-but-dead addresses still in it, so exhaustion was never going to arrive.
 */
export function shouldRefreshSwarm(
  candidates: number,
  failureStreak: number,
  swarmAgeMs: number,
): boolean {
  if (candidates === 0) return true;
  if (failureStreak >= DIAL_FAILURE_STREAK) return true;
  return swarmAgeMs > SWARM_STALE_MS;
}

/**
 * Who to stop trusting when the client rejects a piece.
 *
 * The client hashes every piece and NAKs the ones that fail, which is far better evidence than
 * anything the Worker could gather on its own — a mismatch means the peer sent bytes that are not
 * this torrent's, because the piece hashes come from the info dict whose own SHA-1 *is* the
 * infohash. cf-stream could only blame whichever peer happened to deliver the *last* block of a
 * piece, and said so in a comment; with a per-piece contributor ledger we can do it properly.
 *
 * Blame goes to the largest contributor by bytes, and to every peer tied with it. A piece
 * assembled from four peers must not cost all four a strike on one failure, but a genuine tie is
 * genuinely ambiguous and both halves are equally suspect.
 */
export class PeerBlame {
  /** Insertion-ordered, so the oldest piece is the first thing evicted when the cap is hit. */
  readonly #contributions = new Map<number, Map<string, number>>();
  readonly #strikes = new Map<string, number>();
  readonly #banned = new Set<string>();

  constructor(
    readonly banThreshold: number,
    /**
     * Pieces tracked at once. This runs for a whole film, so the ledger has to forget: a NAK
     * arrives within a few seconds of delivery or not at all, and anything older is not going to
     * be blamed.
     */
    readonly maxTrackedPieces = 512,
  ) {}

  /** Record that `peerKey` supplied `bytes` of piece `pieceIndex`. */
  credit(pieceIndex: number, peerKey: string, bytes: number): void {
    let per = this.#contributions.get(pieceIndex);
    if (per === undefined) {
      per = new Map();
      this.#contributions.set(pieceIndex, per);
      if (this.#contributions.size > this.maxTrackedPieces) {
        // `Map` iterates in insertion order, so the first key is the oldest piece.
        const oldest = this.#contributions.keys().next();
        if (!oldest.done) this.#contributions.delete(oldest.value);
      }
    }
    per.set(peerKey, (per.get(peerKey) ?? 0) + bytes);
  }

  /**
   * The client rejected this piece.
   *
   * Returns the peers that just crossed the threshold and should be closed and banned. An unknown
   * piece yields nothing: the ledger may have forgotten it, and guessing is worse than abstaining.
   */
  blame(pieceIndex: number): string[] {
    const per = this.#contributions.get(pieceIndex);
    this.#contributions.delete(pieceIndex);
    if (per === undefined || per.size === 0) return [];

    let most = 0;
    for (const bytes of per.values()) if (bytes > most) most = bytes;

    const newlyBanned: string[] = [];
    for (const [peerKey, bytes] of per) {
      if (bytes < most) continue;
      const strikes = (this.#strikes.get(peerKey) ?? 0) + 1;
      this.#strikes.set(peerKey, strikes);
      if (strikes >= this.banThreshold && !this.#banned.has(peerKey)) {
        this.#banned.add(peerKey);
        newlyBanned.push(peerKey);
      }
    }
    return newlyBanned;
  }

  /** The client accepted this piece; its ledger entry is dead weight. */
  forget(pieceIndex: number): void {
    this.#contributions.delete(pieceIndex);
  }

  banned(peerKey: string): boolean {
    return this.#banned.has(peerKey);
  }

  get bannedKeys(): string[] {
    return [...this.#banned];
  }

  /** For the end-of-session report back to bstream, and for tests. */
  get trackedPieces(): number {
    return this.#contributions.size;
  }

  strikes(peerKey: string): number {
    return this.#strikes.get(peerKey) ?? 0;
  }
}
