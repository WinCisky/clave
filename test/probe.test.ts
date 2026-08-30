/**
 * The `probe/` client.
 *
 * `probePeers` is deliberately built so nothing it does can turn into a stream failure: a
 * disabled, unreachable, slow, or malformed response all collapse to the same empty outcome, which
 * `session.ts` treats as "nothing to promote" and dials on today's ranked list exactly as if the
 * probe did not exist. These tests pin that degrade-to-nothing behaviour as hard as the parsing
 * itself, the same way `records.test.ts` pins `parseRecords`. Nothing here touches the network.
 */

import { describe, expect, it, vi } from "vitest";
import { parseProbeResponse, probePeers } from "../src/swarm/probe.ts";

const okResponse = (body: unknown, status = 200) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  );

const baseRequest = {
  baseUrl: "https://probe.example",
  token: "secret",
  infoHash: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
  peers: [{ ip: "1.2.3.4", port: 51413 }],
  pieceCount: 1055,
  want: [0, 1054],
  need: 12,
  budgetMs: 3_000,
  timeoutMs: 4_000,
};

describe("parseProbeResponse", () => {
  it("splits alive into useful (hasWanted !== false) and the full alive set", () => {
    const outcome = parseProbeResponse({
      alive: [
        { ip: "1.1.1.1", port: 1, hasWanted: true },
        { ip: "2.2.2.2", port: 2, hasWanted: null },
        { ip: "3.3.3.3", port: 3, hasWanted: false },
      ],
      dead: [],
    });
    expect(outcome.useful).toEqual(["1.1.1.1:1", "2.2.2.2:2"]);
    expect(outcome.alive).toEqual(["1.1.1.1:1", "2.2.2.2:2", "3.3.3.3:3"]);
  });

  it("reads dead addresses regardless of `why`", () => {
    const outcome = parseProbeResponse({
      alive: [],
      dead: [{ ip: "9.9.9.9", port: 51413, why: "connect_timeout" }],
    });
    expect(outcome.dead).toEqual(["9.9.9.9:51413"]);
  });

  it("skips a malformed entry rather than failing the whole response", () => {
    const outcome = parseProbeResponse({
      alive: [
        { ip: "1.1.1.1", port: 1, hasWanted: true },
        { ip: "no-port-here" },
        { port: 2 },
        "not even an object",
      ],
      dead: [],
    });
    expect(outcome.useful).toEqual(["1.1.1.1:1"]);
  });

  it("treats missing alive/dead arrays as empty rather than throwing", () => {
    expect(parseProbeResponse({})).toEqual({ useful: [], alive: [], dead: [] });
  });

  it("rejects a response that is not an object", () => {
    expect(() => parseProbeResponse(null)).toThrow();
    expect(() => parseProbeResponse([1, 2, 3])).toThrow();
  });
});

describe("probePeers", () => {
  it("is a no-op when the probe is not configured", async () => {
    const fetchImpl = okResponse({ alive: [], dead: [] });
    const outcome = await probePeers({ ...baseRequest, baseUrl: "", fetchImpl });
    expect(outcome).toEqual({ useful: [], alive: [], dead: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no token, even with a configured url", async () => {
    const fetchImpl = okResponse({ alive: [], dead: [] });
    const outcome = await probePeers({ ...baseRequest, token: "", fetchImpl });
    expect(outcome).toEqual({ useful: [], alive: [], dead: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op when there are no candidate peers, saving the round trip entirely", async () => {
    const fetchImpl = okResponse({ alive: [], dead: [] });
    const outcome = await probePeers({ ...baseRequest, peers: [], fetchImpl });
    expect(outcome).toEqual({ useful: [], alive: [], dead: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the bearer token and the request shape the service expects", async () => {
    const fetchImpl = okResponse({ alive: [], dead: [] });
    await probePeers({ ...baseRequest, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://probe.example/probe");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer secret");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      infoHash: baseRequest.infoHash,
      pieceCount: 1055,
      want: [0, 1054],
      need: 12,
      budgetMs: 3_000,
    });
  });

  it("strips a trailing slash from baseUrl the same way fetchRecords does", async () => {
    const fetchImpl = okResponse({ alive: [], dead: [] });
    await probePeers({ ...baseRequest, baseUrl: "https://probe.example/", fetchImpl });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://probe.example/probe");
  });

  it("returns the parsed outcome on success", async () => {
    const fetchImpl = okResponse({
      alive: [{ ip: "5.6.7.8", port: 6881, hasWanted: true }],
      dead: [{ ip: "9.9.9.9", port: 1, why: "connect_refused" }],
    });
    const outcome = await probePeers({ ...baseRequest, fetchImpl });
    expect(outcome.useful).toEqual(["5.6.7.8:6881"]);
    expect(outcome.dead).toEqual(["9.9.9.9:1"]);
  });

  it("degrades to an empty outcome, not a throw, on a non-2xx status", async () => {
    const fetchImpl = okResponse({ error: "unauthorized" }, 401);
    const outcome = await probePeers({ ...baseRequest, fetchImpl });
    expect(outcome).toEqual({ useful: [], alive: [], dead: [] });
  });

  it("degrades to an empty outcome on unparseable JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    const outcome = await probePeers({ ...baseRequest, fetchImpl });
    expect(outcome).toEqual({ useful: [], alive: [], dead: [] });
  });

  it("degrades to an empty outcome on a malformed but well-formed-JSON body", async () => {
    const fetchImpl = okResponse("just a string, not an object");
    const outcome = await probePeers({ ...baseRequest, fetchImpl });
    expect(outcome).toEqual({ useful: [], alive: [], dead: [] });
  });

  it("degrades to an empty outcome when the fetch itself rejects (network error, timeout)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const outcome = await probePeers({ ...baseRequest, fetchImpl });
    expect(outcome).toEqual({ useful: [], alive: [], dead: [] });
  });
});
