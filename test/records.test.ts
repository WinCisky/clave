/**
 * The bstream client.
 *
 * Two things are worth pinning hard. The **validation**, because a malformed layout does not throw
 * anywhere useful — it silently shifts every piece index and surfaces as a video that plays for
 * four seconds. And the **ranking**, because it is the single biggest lever on cold start and its
 * ordering is derived from measurements that are not visible in the code.
 *
 * Every test runs against the real 48 KB response checked in at `fixtures/records-bbb.json`, and
 * nothing here touches the network.
 */

import { describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/records-bbb.json";
import {
  fetchRecords,
  parseRecords,
  peerKey,
  rankPeers,
  RecordsError,
  type PeerEntry,
  type PeerHealth,
} from "../src/records.ts";

const ID = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";

/** A deep clone, so a test that corrupts the fixture cannot leak into the next one. */
const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(fixture));

/** Typed with the arguments so the assertions on `mock.calls` can see them. */
const okResponse = (body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );

describe("parsing the real response", () => {
  it("produces the torrent's actual geometry", () => {
    const { layout } = parseRecords(clone(), ID);
    expect(layout.pieceLength).toBe(262_144);
    expect(layout.pieceCount).toBe(1055);
    expect(layout.totalLength).toBe(276_445_467);
    expect(layout.files).toHaveLength(3);
  });

  it("selects the video, which does not start at a piece boundary", () => {
    const { layout } = parseRecords(clone(), ID);
    expect(layout.fileIndex).toBe(1);
    expect(layout.filePath).toBe("Big Buck Bunny.mp4");
    // 140 bytes of subtitle come first. This unaligned offset is the case that breaks naive
    // arithmetic, and it is the common case.
    expect(layout.fileOffset).toBe(140);
    expect(layout.fileLength).toBe(276_134_947);
    expect(layout.mime).toBe("video/mp4");
  });

  it("does not carry the piece hashes", () => {
    const { layout } = parseRecords(clone(), ID);
    // 28 KB of base64 the Worker has no use for: the browser verifies, so it fetches them itself.
    expect("pieces" in layout).toBe(false);
  });

  it("reads the peers, their health and the empty webseed list", () => {
    const result = parseRecords(clone(), ID);
    expect(result.peers).toHaveLength(220);
    expect(result.health.size).toBe(69);
    expect(result.health.get("46.232.211.217:64086")).toEqual({
      ok: 19,
      fails: 1,
      bannedUntil: null,
    });
    expect(result.webseeds).toEqual([]);
    expect(result.resolvedAt).toBeGreaterThan(0);
  });

  it("skips junk peer entries instead of failing the whole swarm", () => {
    const body = clone();
    const peers = (body["peers"] as Record<string, unknown>)["peers"] as unknown[];
    peers.push({ ip: "", port: 6881 }, { ip: "1.2.3.4", port: 0 }, { ip: "1.2.3.4" }, null);
    expect(parseRecords(body, ID).peers).toHaveLength(220);
  });
});

describe("validation", () => {
  const corrupt = (mutate: (body: Record<string, unknown>) => void, code: string) => {
    const body = clone();
    mutate(body);
    expect(() => parseRecords(body, ID)).toThrow(RecordsError);
    try {
      parseRecords(body, ID);
    } catch (err) {
      expect((err as RecordsError).code).toBe(code);
    }
  };

  const chunks = (body: Record<string, unknown>) => body["chunks"] as Record<string, unknown>;

  it("rejects a response for a different torrent", () => {
    corrupt((b) => void (chunks(b)["infoHash"] = "0".repeat(40)), "infohash_mismatch");
  });

  it("rejects a geometry that contradicts itself", () => {
    // The three fields are independent in the response, so they can disagree — and if they do,
    // every piece index derived from them is wrong.
    corrupt((b) => void (chunks(b)["pieceCount"] = 1054), "geometry_mismatch");
  });

  it("rejects non-positive dimensions", () => {
    corrupt((b) => void (chunks(b)["pieceLength"] = 0), "records_malformed");
    corrupt((b) => void (chunks(b)["totalLength"] = -1), "records_malformed");
    corrupt((b) => void (chunks(b)["pieceCount"] = 1.5), "records_malformed");
  });

  it("rejects an empty or missing file list", () => {
    corrupt((b) => void (chunks(b)["files"] = []), "records_malformed");
    corrupt((b) => void delete chunks(b)["files"], "records_malformed");
  });

  it("rejects a file that spans past the end of the torrent", () => {
    corrupt(
      (b) => void ((chunks(b)["files"] as Record<string, unknown>[])[1]!["length"] = 999_999_999),
      "records_malformed",
    );
  });

  it("rejects a file index nothing answers to", () => {
    corrupt((b) => void (chunks(b)["fileIndex"] = 7), "bad_file_index");
  });

  it("rejects a missing block outright", () => {
    corrupt((b) => void delete b["chunks"], "records_malformed");
    corrupt((b) => void delete b["peers"], "records_malformed");
  });

  it("refuses an infohash that is not one", () => {
    return expect(fetchRecords("https://x", "not-a-hash")).rejects.toThrow(/not a v1 infohash/);
  });
});

describe("fetching", () => {
  it("asks the right URL and trims a trailing slash from the base", async () => {
    const doFetch = okResponse(clone());
    await fetchRecords("https://bstream.ssimo.dev/", ID, { fetchImpl: doFetch });
    expect(doFetch.mock.calls[0]![0]).toBe(`https://bstream.ssimo.dev/records/${ID}`);
  });

  it("adds ?refresh=1 only when asked", async () => {
    const doFetch = okResponse(clone());
    await fetchRecords("https://bstream.ssimo.dev", ID, { refresh: true, fetchImpl: doFetch });
    expect(doFetch.mock.calls[0]![0]).toBe(`https://bstream.ssimo.dev/records/${ID}?refresh=1`);
  });

  it("turns a bad status into a RecordsError, not a crash", async () => {
    const doFetch = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(fetchRecords("https://x", ID, { fetchImpl: doFetch })).rejects.toMatchObject({
      code: "records_status",
    });
  });

  it("turns an unreachable dependency into a RecordsError", async () => {
    const doFetch = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(fetchRecords("https://x", ID, { fetchImpl: doFetch })).rejects.toMatchObject({
      code: "records_unreachable",
    });
  });

  it("turns unparseable JSON into a RecordsError", async () => {
    const doFetch = vi.fn(async () => new Response("{ not json", { status: 200 }));
    await expect(fetchRecords("https://x", ID, { fetchImpl: doFetch })).rejects.toMatchObject({
      code: "records_malformed",
    });
  });
});

describe("rankPeers", () => {
  const peer = (ip: string, port: number, extra: Partial<PeerEntry> = {}): PeerEntry => ({
    ip,
    port,
    source: "udp",
    verified: false,
    ...extra,
  });
  const health = (entries: Record<string, Partial<PeerHealth>>) =>
    new Map<string, PeerHealth>(
      Object.entries(entries).map(([k, v]) => [k, { ok: 0, fails: 0, bannedUntil: null, ...v }]),
    );
  const NOW = 1_700_000_000_000;

  it("orders the five measured tiers", () => {
    const peers = [
      peer("5.0.0.5", 5), // unranked udp — 13 %
      peer("4.0.0.4", 4, { source: "pex" }), // unranked pex — 24 %
      peer("3.0.0.3", 3), // ok == 0, fails > 0 — 2 %, last
      peer("2.0.0.2", 2, { verified: true }), // verified — 60 %
      peer("1.0.0.1", 1), // ok > 0 — 86 %, first
    ];
    const ranked = rankPeers(
      peers,
      health({ "1.0.0.1:1": { ok: 3 }, "3.0.0.3:3": { fails: 2 } }),
      new Set(),
      NOW,
    );
    expect(ranked.map((p) => p.ip)).toEqual(["1.0.0.1", "2.0.0.2", "4.0.0.4", "5.0.0.5", "3.0.0.3"]);
  });

  it("puts a peer with failures first anyway when it has also succeeded", () => {
    // The best peer in the real sample read ok:19, fails:1.
    const peers = [peer("2.0.0.2", 2, { verified: true }), peer("1.0.0.1", 1)];
    const ranked = rankPeers(peers, health({ "1.0.0.1:1": { ok: 19, fails: 1 } }), new Set(), NOW);
    expect(ranked[0]!.ip).toBe("1.0.0.1");
  });

  it("keeps the worst tier rather than blacklisting it", () => {
    // 46 of the sample's 220 peers land here and one of them worked.
    const peers = [peer("3.0.0.3", 3)];
    expect(rankPeers(peers, health({ "3.0.0.3:3": { fails: 5 } }), new Set(), NOW)).toHaveLength(1);
  });

  it("drops banned peers and peers still inside a ban window", () => {
    const peers = [peer("1.0.0.1", 1), peer("2.0.0.2", 2), peer("3.0.0.3", 3)];
    const ranked = rankPeers(
      peers,
      health({ "2.0.0.2:2": { bannedUntil: NOW + 60_000 }, "3.0.0.3:3": { bannedUntil: NOW - 1 } }),
      new Set(["1.0.0.1:1"]),
      NOW,
    );
    expect(ranked.map((p) => p.ip)).toEqual(["3.0.0.3"]);
  });

  it("drops addresses a Worker cannot reach at all", () => {
    // Cloudflare's own space, and a peer advertising the blocked SMTP port.
    const peers = [peer("104.28.165.161", 42618), peer("9.9.9.9", 25), peer("8.8.8.8", 6881)];
    expect(rankPeers(peers, health({}), new Set(), NOW).map((p) => p.ip)).toEqual(["8.8.8.8"]);
  });

  it("is deterministic within a tier", () => {
    const peers = [peer("9.9.9.9", 2), peer("9.9.9.9", 1), peer("1.1.1.9", 3)];
    const once = rankPeers(peers, health({}), new Set(), NOW).map((p) => peerKey(p.ip, p.port));
    const twice = rankPeers([...peers].reverse(), health({}), new Set(), NOW)
      .map((p) => peerKey(p.ip, p.port));
    expect(once).toEqual(twice);
  });

  it("ranks the real 220-peer sample without losing anyone it should keep", () => {
    const result = parseRecords(clone(), ID);
    const ranked = rankPeers(result.peers, result.health, new Set(), Date.now());
    // Three addresses sit in Cloudflare's space and cannot be dialled from a Worker.
    expect(ranked).toHaveLength(217);
    // Every peer bstream has actually served from leads, strongest first. In this sample that is
    // 46.232.211.217 with ok:19 — the same address that delivered fastest when probed live.
    const leaders = ranked.slice(0, 7).map((p) => peerKey(p.ip, p.port));
    expect(leaders[0]).toBe("46.232.211.217:64086");
    for (const key of leaders) expect(result.health.get(key)!.ok).toBeGreaterThan(0);
    // Every peer bstream has only ever failed with is at the back — the 2 %-success bucket. The
    // count is derived, not hardcoded: three of those addresses are also in Cloudflare's space and
    // were dropped above, so the group is smaller than the raw health table suggests.
    // "Only ever failed" sends a peer to the back *unless* bstream also handshaked it: that is
    // independent evidence, and the measured buckets put `verified` at 60 % against 2 %. So the
    // last tier is the unverified half of that group.
    const hopeless = (peer: PeerEntry) => {
      const entry = result.health.get(peerKey(peer.ip, peer.port));
      return !peer.verified && entry !== undefined && entry.ok === 0 && entry.fails > 0;
    };
    const keys = ranked.map((p) => peerKey(p.ip, p.port));
    const worst = ranked.filter(hopeless).map((p) => peerKey(p.ip, p.port));
    expect(worst.length).toBeGreaterThan(0);
    expect(keys.slice(-worst.length)).toEqual(worst);
  });
});
