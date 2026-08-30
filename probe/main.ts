/**
 * HTTP entry point: routing, auth, request validation, and handing off to `probePeers`.
 *
 * Deliberately closed rather than a general-purpose API: this is a server-to-server helper for one
 * caller (`clave`'s Durable Object), not a public port scanner. Every request must carry the bearer
 * token, and there is no unauthenticated path — a missing `PROBE_TOKEN` at startup means every
 * request is refused, not that auth is skipped.
 */

import {
  MAX_BUDGET_MS,
  MAX_PEERS_PER_REQUEST,
  MAX_WANT,
  probePeers,
  type ProbeRequest,
  type ProbeTarget,
} from "./probe.ts";

const PROBE_TOKEN = Deno.env.get("PROBE_TOKEN") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

/** Constant-time compare, so a timing side-channel does not turn into a token oracle. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

function authorized(req: Request): boolean {
  if (PROBE_TOKEN.length === 0) return false; // no token configured: refuse everything, not "open"
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), PROBE_TOKEN);
}

function isHexInfoHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function parsePeers(value: unknown): ProbeTarget[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ProbeTarget[] = [];
  for (const raw of value.slice(0, MAX_PEERS_PER_REQUEST)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const ip = entry["ip"];
    const port = entry["port"];
    if (typeof ip !== "string" || ip.length === 0) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ ip, port });
  }
  return out;
}

function parseWant(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)
    .slice(0, MAX_WANT);
}

function parseRequestBody(body: unknown): ProbeRequest | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body is not an object" };
  const raw = body as Record<string, unknown>;

  if (!isHexInfoHash(raw["infoHash"])) {
    return { error: '"infoHash" must be a 40-character lowercase hex string' };
  }
  const peers = parsePeers(raw["peers"]);
  if (peers === null) return { error: '"peers" must be a non-empty array of {ip, port}' };
  const pieceCount = raw["pieceCount"];
  if (typeof pieceCount !== "number" || !Number.isInteger(pieceCount) || pieceCount <= 0) {
    return { error: '"pieceCount" must be a positive integer' };
  }

  const needRaw = raw["need"];
  const need = typeof needRaw === "number" && Number.isInteger(needRaw) && needRaw > 0 ? needRaw : 12;
  const budgetRaw = raw["budgetMs"];
  const budgetMs = typeof budgetRaw === "number" && Number.isFinite(budgetRaw)
    ? Math.max(200, Math.min(MAX_BUDGET_MS, budgetRaw))
    : 3_000;

  return {
    infoHash: raw["infoHash"] as string,
    peers,
    pieceCount,
    want: parseWant(raw["want"]),
    need,
    budgetMs,
  };
}

async function handleProbe(req: Request): Promise<Response> {
  if (!authorized(req)) return error(401, "unauthorized", "missing or invalid bearer token");
  if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "bad_json", "request body is not valid JSON");
  }

  const parsed = parseRequestBody(body);
  if ("error" in parsed) return error(400, "bad_request", parsed.error);

  try {
    const result = await probePeers(parsed);
    return json(result);
  } catch (err) {
    console.error("probe failed", err);
    return error(500, "probe_failed", err instanceof Error ? err.message : String(err));
  }
}

Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname === "/health") return json({ ok: true });
  if (url.pathname === "/probe") return handleProbe(req);
  return error(404, "not_found", `no route for ${url.pathname}`);
});
