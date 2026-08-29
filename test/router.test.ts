/**
 * The routing surface.
 *
 * Deliberately shallow: everything below `/stream` needs a live swarm, and a swarm cannot run in a
 * hermetic suite. What is worth pinning here is that a malformed request is refused *before* a
 * Durable Object is created for it — an object spun up for a typo would hold storage and count
 * against the daily request budget for nothing.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ID = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";

describe("/healthz", () => {
  it("answers without touching anything", async () => {
    const response = await SELF.fetch("https://clave.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok\n");
  });
});

describe("CORS", () => {
  it("answers a preflight", async () => {
    const response = await SELF.fetch("https://clave.test/stream", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toBe("origin");
  });

  it("refuses anything but GET", async () => {
    const response = await SELF.fetch("https://clave.test/healthz", { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("/stream", () => {
  it("refuses a malformed infohash before creating an object for it", async () => {
    for (const ih of ["", "nope", ID.slice(0, 39), `${ID}f`, ID.toUpperCase().replace("D", "G")]) {
      const response = await SELF.fetch(`https://clave.test/stream?ih=${ih}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "bad_infohash" });
    }
  });

  it("accepts an uppercase infohash, since it is only hex", async () => {
    const response = await SELF.fetch(`https://clave.test/stream?ih=${ID.toUpperCase()}`);
    // Well-formed but not a WebSocket, so it gets as far as the upgrade check.
    expect(response.status).toBe(426);
  });

  it("insists on a WebSocket upgrade", async () => {
    const response = await SELF.fetch(`https://clave.test/stream?ih=${ID}`);
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ error: "upgrade_required" });
  });

  it("upgrades a well-formed request", async () => {
    const response = await SELF.fetch(`https://clave.test/stream?ih=${ID}&file=1&s=test`, {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});

describe("/debug", () => {
  it("reports a session's counters over RPC, without disturbing it", async () => {
    const response = await SELF.fetch(`https://clave.test/debug/${ID}?file=1&s=untouched`);
    expect(response.status).toBe(200);
    const state = await response.json() as Record<string, unknown>;
    // A session nobody has opened reports empty rather than failing — the object is created by the
    // read, which is why this route is a plain RPC call and not a request through the pump.
    expect(state).toMatchObject({
      infoHash: null,
      peers: [],
      candidates: 0,
      piecesOut: 0,
      bytesOut: 0,
      alarms: 0,
    });
  });

  it("404s an id that is not an infohash", async () => {
    const response = await SELF.fetch("https://clave.test/debug/nope");
    expect(response.status).toBe(404);
  });
});

describe("unknown routes", () => {
  it("404s with the path", async () => {
    const response = await SELF.fetch("https://clave.test/nothing/here");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });
});
