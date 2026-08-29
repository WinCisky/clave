/**
 * Peer-quality decisions.
 *
 * `PeerBlame` is the one place client-side verification pays off structurally: the browser tells
 * us a piece was wrong, which is evidence no amount of server-side heuristics could produce. What
 * matters is that the evidence lands on the right peer — banning the innocent contributors of a
 * multi-peer piece would shrink a working pool on one bad byte.
 */

import { describe, expect, it } from "vitest";
import {
  DIAL_FAILURE_STREAK,
  PeerBlame,
  shouldRefreshSwarm,
  starvedPeers,
  SWARM_STALE_MS,
} from "../src/swarm/health.ts";

const NOW = 1_700_000_000_000;

describe("shouldRefreshSwarm", () => {
  it("refreshes when the candidate list is exhausted", () => {
    expect(shouldRefreshSwarm(0, 0, 0)).toBe(true);
  });

  it("refreshes on a long failure streak, even with candidates left", () => {
    expect(shouldRefreshSwarm(100, DIAL_FAILURE_STREAK, 0)).toBe(true);
    expect(shouldRefreshSwarm(100, DIAL_FAILURE_STREAK - 1, 0)).toBe(false);
  });

  it("refreshes a stale list that will never reach exhaustion", () => {
    // The production case: hundreds of untried-but-dead addresses, hours old.
    expect(shouldRefreshSwarm(330, 3, SWARM_STALE_MS + 1)).toBe(true);
    expect(shouldRefreshSwarm(330, 3, SWARM_STALE_MS - 1)).toBe(false);
  });
});

describe("starvedPeers", () => {
  const peer = (key: string, delivered: number, connectedAt: number, deliveredAt: number) => ({
    key,
    delivered,
    connectedAt,
    deliveredAt,
  });

  it("disturbs nothing while a peer is delivering", () => {
    expect(starvedPeers([peer("a", 5, NOW - 60_000, NOW - 100)], NOW)).toEqual([]);
  });

  it("gives an unproven peer its grace period before dropping it", () => {
    expect(starvedPeers([peer("new", 0, NOW - 3_000, 0)], NOW)).toEqual([]);
    expect(starvedPeers([peer("ghost", 0, NOW - 20_000, 0)], NOW)).toEqual(["ghost"]);
  });

  it("prefers dropping unproven peers over working ones", () => {
    const pool = [peer("good", 9, NOW - 60_000, NOW - 30_000), peer("ghost", 0, NOW - 20_000, 0)];
    expect(starvedPeers(pool, NOW)).toEqual(["ghost"]);
  });

  it("drops the whole pool only once every peer has gone silent", () => {
    const quiet = [
      peer("a", 3, NOW - 60_000, NOW - 20_000),
      peer("b", 4, NOW - 60_000, NOW - 30_000),
    ];
    expect(starvedPeers(quiet, NOW).sort()).toEqual(["a", "b"]);
  });

  it("says nothing about an empty pool", () => {
    expect(starvedPeers([], NOW)).toEqual([]);
  });
});

describe("PeerBlame", () => {
  it("blames the majority contributor and spares the rest", () => {
    const blame = new PeerBlame(1);
    blame.credit(7, "big", 200_000);
    blame.credit(7, "small", 62_144);
    expect(blame.blame(7)).toEqual(["big"]);
    expect(blame.banned("small")).toBe(false);
  });

  it("blames every peer tied for largest, because a tie is genuinely ambiguous", () => {
    const blame = new PeerBlame(1);
    blame.credit(7, "a", 131_072);
    blame.credit(7, "b", 131_072);
    expect(blame.blame(7).sort()).toEqual(["a", "b"]);
  });

  it("bans only at the threshold, not before", () => {
    const blame = new PeerBlame(3);
    for (let piece = 0; piece < 2; piece++) {
      blame.credit(piece, "flaky", 1000);
      expect(blame.blame(piece)).toEqual([]);
    }
    expect(blame.banned("flaky")).toBe(false);
    blame.credit(2, "flaky", 1000);
    expect(blame.blame(2)).toEqual(["flaky"]);
    expect(blame.banned("flaky")).toBe(true);
    expect(blame.strikes("flaky")).toBe(3);
  });

  it("reports a peer as newly banned exactly once", () => {
    const blame = new PeerBlame(1);
    blame.credit(1, "bad", 10);
    expect(blame.blame(1)).toEqual(["bad"]);
    blame.credit(2, "bad", 10);
    expect(blame.blame(2)).toEqual([]);
    expect(blame.banned("bad")).toBe(true);
  });

  it("abstains on a piece it never saw, rather than guessing", () => {
    expect(new PeerBlame(1).blame(42)).toEqual([]);
  });

  it("releases a piece the client accepted", () => {
    const blame = new PeerBlame(1);
    blame.credit(3, "a", 10);
    expect(blame.trackedPieces).toBe(1);
    blame.forget(3);
    expect(blame.trackedPieces).toBe(0);
    // Forgotten, so a later NAK for it cannot blame anyone.
    expect(blame.blame(3)).toEqual([]);
  });

  it("stays bounded across a whole film, forgetting oldest first", () => {
    const blame = new PeerBlame(2, 64);
    for (let piece = 0; piece < 8_192; piece++) blame.credit(piece, `peer${piece % 12}`, 262_144);
    expect(blame.trackedPieces).toBe(64);

    // A NAK arrives within seconds of delivery or not at all, so the oldest pieces are gone and
    // nobody can be blamed for them.
    blame.blame(0);
    expect(blame.strikes("peer0")).toBe(0);

    // The newest are still on the ledger, and land a strike on their contributor. One strike is
    // not a ban at a threshold of two — `blame` returns only who *crossed* it.
    expect(blame.blame(8_191)).toEqual([]);
    expect(blame.strikes(`peer${8_191 % 12}`)).toBe(1);
  });
});
