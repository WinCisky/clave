import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type AliveResult,
  type DeadResult,
  type ProbeContext,
  probeOne,
  probePeers,
  type ProbeTarget,
} from "../probe.ts";
import { buildHandshake, frame, generatePeerId, MSG_BITFIELD, MSG_HAVE_ALL } from "../wire.ts";

const INFO_HASH = new Uint8Array(20).map((_, i) => i + 1);
const INFO_HASH_HEX_20 = [...INFO_HASH].map((b) => b.toString(16).padStart(2, "0")).join("");

function baseCtx(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    infoHashBytes: INFO_HASH,
    peerId: generatePeerId(),
    pieceCount: 16,
    wanted: [0, 15],
    deadline: performance.now() + 5_000,
    ...overrides,
  };
}

interface FakePeerOptions {
  readonly bitfield?: Uint8Array;
  readonly haveAll?: boolean;
  readonly closeAfterHandshake?: boolean;
  readonly delayMs?: number;
}

/** A minimal one-shot BitTorrent peer on loopback, for exercising the real dial+handshake path. */
function fakePeer(opts: FakePeerOptions): { target: ProbeTarget; stop: () => void } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;

  (async () => {
    let conn: Deno.Conn;
    try {
      conn = await listener.accept();
    } catch {
      return;
    }
    try {
      const buf = new Uint8Array(68);
      let filled = 0;
      while (filled < 68) {
        const n = await conn.read(buf.subarray(filled));
        if (n === null) return;
        filled += n;
      }
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      await conn.write(buildHandshake(INFO_HASH, generatePeerId()));
      if (opts.closeAfterHandshake) return;
      if (opts.bitfield) await conn.write(frame(MSG_BITFIELD, opts.bitfield));
      else if (opts.haveAll) await conn.write(frame(MSG_HAVE_ALL));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      // The client closed or timed out; nothing left to do.
    } finally {
      try {
        conn!.close();
      } catch {
        // Already gone.
      }
    }
  })();

  return { target: { ip: "127.0.0.1", port }, stop: () => listener.close() };
}

Deno.test("probeOne reports a peer that sends a bitfield covering a wanted piece as alive and useful", async () => {
  const { target, stop } = fakePeer({ bitfield: new Uint8Array([0b1000_0000, 0b0000_0001]) });
  try {
    const result = await probeOne(target, baseCtx());
    assert(!("why" in result), `expected alive, got ${JSON.stringify(result)}`);
    const alive = result as AliveResult;
    assertEquals(alive.hasWanted, true); // piece 0 and 15 are both wanted; piece 0 is set
    assertEquals(alive.have, 2);
    assert(!alive.seed);
  } finally {
    stop();
  }
});

Deno.test("probeOne reports have-all as a seed with every wanted piece present", async () => {
  const { target, stop } = fakePeer({ haveAll: true });
  try {
    const result = await probeOne(target, baseCtx());
    assert(!("why" in result));
    const alive = result as AliveResult;
    assert(alive.seed);
    assertEquals(alive.hasWanted, true);
    assertEquals(alive.have, 16);
  } finally {
    stop();
  }
});

Deno.test("probeOne reports hasWanted:false for a bitfield that misses every wanted piece", async () => {
  // Piece 3 only; wanted is [0, 15].
  const { target, stop } = fakePeer({ bitfield: new Uint8Array([0b0001_0000, 0]) });
  try {
    const result = await probeOne(target, baseCtx());
    assert(!("why" in result));
    assertEquals((result as AliveResult).hasWanted, false);
  } finally {
    stop();
  }
});

Deno.test("probeOne reports hasWanted:null for a peer that handshakes but sends nothing after", async () => {
  const { target, stop } = fakePeer({});
  try {
    // Give the bitfield-wait window almost no room, so the test stays fast.
    const result = await probeOne(target, baseCtx({ deadline: performance.now() + 50 }));
    assert(!("why" in result), `expected alive, got ${JSON.stringify(result)}`);
    assertEquals((result as AliveResult).hasWanted, null);
  } finally {
    stop();
  }
});

Deno.test("probeOne reports a peer that closes right after the handshake as dead", async () => {
  const { target, stop } = fakePeer({ closeAfterHandshake: true });
  try {
    const result = await probeOne(target, baseCtx({ deadline: performance.now() + 50 }));
    assert("why" in result, `expected dead, got ${JSON.stringify(result)}`);
  } finally {
    stop();
  }
});

Deno.test("probeOne reports connect_timeout for a port nothing listens on", async () => {
  // Port 1 on loopback: nothing is listening, and the OS refuses immediately rather than hanging,
  // so this also incidentally covers the connect_refused branch of the same code path.
  const result = await probeOne({ ip: "127.0.0.1", port: 1 }, baseCtx());
  assert("why" in result);
  const dead = result as DeadResult;
  assert(dead.why === "connect_timeout" || dead.why === "connect_refused", dead.why);
});

Deno.test("probePeers marks a loopback target as blocked without dialing it", async () => {
  const response = await probePeers({
    infoHash: INFO_HASH_HEX_20,
    peers: [{ ip: "127.0.0.1", port: 51413 }],
    pieceCount: 16,
    want: [],
    need: 1,
    budgetMs: 500,
  });
  assertEquals(response.alive.length, 0);
  assertEquals(response.dead.length, 1);
  assertEquals(response.dead[0]!.why, "blocked");
});

Deno.test("probePeers returns immediately for an empty peer list", async () => {
  const response = await probePeers({
    infoHash: INFO_HASH_HEX_20,
    peers: [],
    pieceCount: 16,
    want: [],
    need: 1,
    budgetMs: 1_000,
  });
  assertEquals(response.probed, 0);
  assertEquals(response.alive.length, 0);
  assertEquals(response.truncated, false);
});

/** A synthetic `probeOne` for exercising orchestration without any real socket. */
function stubDial(
  outcomes: ReadonlyMap<string, { result: AliveResult | DeadResult; delayMs?: number }>,
): typeof probeOne {
  return async (target) => {
    const key = `${target.ip}:${target.port}`;
    const outcome = outcomes.get(key);
    if (outcome === undefined) throw new Error(`no stubbed outcome for ${key}`);
    if (outcome.delayMs) await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
    return outcome.result;
  };
}

function alive(port: number, hasWanted: boolean | null = true): AliveResult {
  return {
    ip: "203.0.113.1", // documentation range, rejected by isDialable — irrelevant here since the
    // dial is stubbed and never reaches isDialable's caller-side check in this test path.
    port,
    rttMs: 10,
    handshakeMs: 10,
    seed: false,
    have: 1,
    hasWanted,
    fast: false,
    extended: false,
  };
}

Deno.test("probePeers stops early once `need` useful peers are found, without waiting for slow stragglers", async () => {
  // Ordinary-looking public IPs: `isDialable` still runs ahead of the stubbed dial, so these must
  // not fall in a reserved/documentation range (unlike the deliberately-blocked test above).
  const targets: ProbeTarget[] = Array.from({ length: 6 }, (_, i) => ({ ip: "5.6.7.8", port: 1000 + i }));
  const outcomes = new Map(
    targets.map((t, i) => [
      `${t.ip}:${t.port}`,
      { result: alive(t.port), delayMs: i < 3 ? 5 : 4_000 }, // three fast winners, three slow ones
    ]),
  );

  const start = performance.now();
  const response = await probePeers(
    { infoHash: INFO_HASH_HEX_20, peers: targets, pieceCount: 16, want: [], need: 3, budgetMs: 8_000 },
    { probeOne: stubDial(outcomes) },
  );
  const elapsedMs = performance.now() - start;

  assertEquals(response.alive.length, 3);
  assert(response.truncated, "expected early exit to be reported as truncated");
  // The three slow (4s) targets must not have been waited on: this should resolve close to the
  // fast targets' delay, nowhere near their 4s delay or the 8s budget.
  assert(elapsedMs < 500, `expected an early return, took ${elapsedMs}ms`);
});

Deno.test("probePeers respects budgetMs rather than waiting out a straggling dial", async () => {
  // A single target whose stubbed dial takes far longer than the budget: `need` is unreachable in
  // time, so this should return once `budgetMs` elapses rather than once the dial eventually would.
  const targets: ProbeTarget[] = [{ ip: "5.6.7.9", port: 2000 }];
  const outcomes = new Map([["5.6.7.9:2000", { result: alive(2000), delayMs: 5_000 }]]);

  const start = performance.now();
  const response = await probePeers(
    { infoHash: INFO_HASH_HEX_20, peers: targets, pieceCount: 16, want: [], need: 1, budgetMs: 300 },
    { probeOne: stubDial(outcomes) },
  );
  const elapsedMs = performance.now() - start;

  assertEquals(response.alive.length, 0); // the dial had not settled when the budget ran out
  assert(response.truncated);
  assert(elapsedMs >= 300 && elapsedMs < 1_000, `expected ~budgetMs latency, took ${elapsedMs}ms`);
});

Deno.test("probePeers sorts alive results by usefulness, then seed, then have, then rtt", async () => {
  const mk = (port: number, over: Partial<AliveResult>): AliveResult => ({ ...alive(port), ...over });
  const targets: ProbeTarget[] = [1, 2, 3, 4].map((port) => ({ ip: "5.6.7.10", port }));
  const outcomes = new Map<string, { result: AliveResult | DeadResult }>([
    ["5.6.7.10:1", { result: mk(1, { hasWanted: false, rttMs: 5 }) }],
    ["5.6.7.10:2", { result: mk(2, { hasWanted: true, seed: true, have: 16, rttMs: 50 }) }],
    ["5.6.7.10:3", { result: mk(3, { hasWanted: true, seed: false, have: 1, rttMs: 5 }) }],
    ["5.6.7.10:4", { result: mk(4, { hasWanted: null, rttMs: 5 }) }],
  ]);

  const response = await probePeers(
    { infoHash: INFO_HASH_HEX_20, peers: targets, pieceCount: 16, want: [], need: 99, budgetMs: 500 },
    { probeOne: stubDial(outcomes) },
  );

  assertEquals(response.alive.map((a) => a.port), [2, 3, 4, 1]);
});
