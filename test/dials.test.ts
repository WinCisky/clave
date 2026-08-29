/**
 * The dialler's accounting.
 *
 * These cover the two defects that made a cold start take two minutes: dialling far past the
 * platform's connecting-socket allowance, and a leak guard that never ran. Both were invisible in
 * production telemetry — the object simply looked like it had no peers.
 */

import { describe, expect, it } from "vitest";
import { DialSlots } from "../src/swarm/dials.ts";
import { dialDeadlines } from "../src/swarm/peer.ts";
import { starvedPeers } from "../src/swarm/health.ts";

const CONNECTING = 6;
const PEERS = 24;
const TTL = 6_000;

const slots = () => new DialSlots(CONNECTING, PEERS, TTL);

describe("connecting-socket accounting", () => {
  it("never opens more slots than the platform gives", () => {
    const pool = slots();
    expect(pool.room(0)).toBe(CONNECTING);
    for (let i = 0; i < CONNECTING; i++) pool.open(0);
    expect(pool.inFlight).toBe(CONNECTING);
    // The bug: the old arithmetic said `MAX_PEERS - peers - inFlight` here, which is 18, so the
    // settle loop kept dialling into a queue four times deeper than the runtime would serve.
    expect(pool.room(0)).toBe(0);
  });

  it("refills as dials settle, one for one", () => {
    const pool = slots();
    const open = [...Array(CONNECTING)].map(() => pool.open(0));
    expect(pool.room(0)).toBe(0);
    open[0]!.release();
    open[1]!.release();
    expect(pool.room(0)).toBe(2);
  });

  it("stops short when the peer pool has no room left, not just the dialler", () => {
    const pool = slots();
    // Twenty-two established peers leaves room for two more, even though six could connect.
    expect(pool.room(PEERS - 2)).toBe(2);
    expect(pool.room(PEERS)).toBe(0);
  });

  it("reclaims a slot whose dial never settled", () => {
    const pool = slots();
    pool.open(1_000);
    pool.open(1_000);
    expect(pool.sweep(1_000 + TTL - 1)).toBe(0);
    expect(pool.inFlight).toBe(2);
    // Past the TTL both come back. Under the old `setTimeout` guard — which does not fire inside a
    // Durable Object alarm — they never did, and `room` walked to zero for the object's lifetime.
    expect(pool.sweep(1_000 + TTL)).toBe(2);
    expect(pool.inFlight).toBe(0);
    expect(pool.room(0)).toBe(CONNECTING);
  });

  it("releases idempotently, so a sweep racing a settled dial cannot double-count", () => {
    const pool = slots();
    const slot = pool.open(0);
    slot.release();
    slot.release();
    pool.sweep(TTL * 10);
    expect(pool.inFlight).toBe(0);
    expect(pool.room(0)).toBe(CONNECTING);
  });

  it("hands every slot back when the object goes idle", () => {
    const pool = slots();
    for (let i = 0; i < CONNECTING; i++) pool.open(0);
    pool.clear();
    expect(pool.inFlight).toBe(0);
  });
});

describe("dial deadlines", () => {
  it("bounds connecting separately from, and sooner than, the whole setup", () => {
    const { connectMs, setupMs } = dialDeadlines({ connectMs: 1_200, handshakeMs: 3_500 });
    expect(connectMs).toBe(1_200);
    expect(setupMs).toBe(4_700);
    // The regression this exists to catch: `connectMs` used to be ignored entirely, so connecting
    // was bounded by the setup window and a dead address cost a slot the full 5 s.
    expect(connectMs).toBeLessThan(setupMs);
  });

  it("keeps the cold-start budget within reach of a viewer's patience", () => {
    // The measured production case: a stale list with 162 dead addresses in front of the live ones.
    const dead = 162;
    const { connectMs } = dialDeadlines({ connectMs: 1_200, handshakeMs: 3_500 });
    const worstCaseMs = Math.ceil(dead / CONNECTING) * connectMs;
    // Was 135 s with the connect deadline ignored. This is the number that has to stay small; if
    // a future change raises `CONNECT_TIMEOUT_MS` back towards the handshake budget, this fails.
    expect(worstCaseMs).toBeLessThanOrEqual(35_000);
  });
});

describe("giving up on peers that do not deliver", () => {
  const peer = (key: string, delivered: number, connectedAt: number, deliveredAt: number) =>
    ({ key, delivered, connectedAt, deliveredAt });

  it("leaves a delivering pool completely alone", () => {
    const now = 100_000;
    const pool = [peer("a", 40, now - 60_000, now - 200), peer("b", 12, now - 30_000, now - 900)];
    expect(starvedPeers(pool, now)).toEqual([]);
  });

  it("gives a fresh peer time to prove itself before judging it", () => {
    const now = 100_000;
    expect(starvedPeers([peer("a", 0, now - 3_000, 0)], now)).toEqual([]);
  });

  it("drops a peer that has never delivered once it has had long enough", () => {
    // The measured production failure: one established socket, zero blocks, and every recovery
    // path in `#tick` switched off behind `peers.size === 0` for two minutes forty-five seconds.
    const now = 100_000;
    expect(starvedPeers([peer("ghost", 0, now - 20_000, 0)], now)).toEqual(["ghost"]);
  });

  it("keeps a working peer even when a silent one is dropped beside it", () => {
    const now = 100_000;
    const pool = [peer("ghost", 0, now - 20_000, 0), peer("good", 5, now - 20_000, now - 500)];
    expect(starvedPeers(pool, now)).toEqual(["ghost"]);
  });

  it("drops a pool that delivered and then went silent, rather than waiting on it", () => {
    const now = 100_000;
    const pool = [peer("a", 9, now - 60_000, now - 30_000), peer("b", 4, now - 60_000, now - 40_000)];
    expect(starvedPeers(pool, now).sort()).toEqual(["a", "b"]);
  });

  it("does not drop a pool where one peer is still delivering", () => {
    const now = 100_000;
    const pool = [peer("a", 9, now - 60_000, now - 30_000), peer("b", 4, now - 60_000, now - 100)];
    expect(starvedPeers(pool, now)).toEqual([]);
  });
});
