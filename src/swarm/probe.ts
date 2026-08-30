/**
 * Talking to `probe/`, the companion Deno Deploy service (`../../probe/README.md`).
 *
 * The whole reason it exists: this Worker can have only **six sockets connecting at once**
 * (`MAX_CONNECTING` in `../session.ts`), a Cloudflare platform cap, not a tuning knob. On a fresh,
 * unranked peer list only ~14% of addresses answer, so finding six working peers costs ~40 dials —
 * which at six slots and a 1.2s connect deadline apiece *is* the cold start. `probe/` has no such
 * cap: it dials a whole candidate list in parallel from a Deno runtime, completes the handshake,
 * and reports back which addresses are alive and hold what was asked for, in about a second. This
 * module is the client side of that: one request, validated the way `../records.ts` validates
 * bstream's response — untrusted input, shape checked rather than cast, a junk entry skipped
 * rather than fatal.
 *
 * Every failure here is meant to be survivable. A probe that is disabled, unreachable, slow, or
 * wrong changes nothing about correctness — it only gives up an optimisation. `session.ts` never
 * awaits this on the critical path; see `#kickOffProbe`.
 */

export interface ProbeCandidate {
  readonly ip: string;
  readonly port: number;
}

export interface ProbeOutcome {
  /** `ip:port`, matching `peerKey` — confirmed alive and holding at least one wanted piece. */
  readonly useful: readonly string[];
  /** Alive, but unproven: handshaked, no bitfield-shaped message arrived inside the window. */
  readonly alive: readonly string[];
  /** Confirmed unreachable or not speaking this torrent. Worth remembering, but only for this
   * session — see `#probeDead` in `session.ts` for why it is not reported to bstream. */
  readonly dead: readonly string[];
}

export interface ProbeRequest {
  readonly baseUrl: string;
  readonly token: string;
  readonly infoHash: string;
  readonly peers: readonly ProbeCandidate[];
  readonly pieceCount: number;
  readonly want: readonly number[];
  readonly need: number;
  readonly budgetMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Injected for tests, which must never reach the network. */
  readonly fetchImpl?: typeof fetch;
}

const EMPTY_OUTCOME: ProbeOutcome = { useful: [], alive: [], dead: [] };

export async function probePeers(request: ProbeRequest): Promise<ProbeOutcome> {
  if (request.baseUrl === "" || request.token === "" || request.peers.length === 0) {
    return EMPTY_OUTCOME;
  }

  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const doFetch = request.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${request.baseUrl.replace(/\/+$/, "")}/probe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.token}`,
      },
      body: JSON.stringify({
        infoHash: request.infoHash,
        peers: request.peers,
        pieceCount: request.pieceCount,
        want: request.want,
        need: request.need,
        budgetMs: request.budgetMs,
      }),
      signal,
    });
  } catch (err) {
    console.error("probe unreachable", { error: describe(err) });
    return EMPTY_OUTCOME;
  }

  if (!response.ok) {
    console.error("probe returned an error status", { status: response.status });
    return EMPTY_OUTCOME;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.error("probe returned unparseable JSON");
    return EMPTY_OUTCOME;
  }

  try {
    return parseProbeResponse(body);
  } catch (err) {
    console.error("probe returned a malformed response", { error: describe(err) });
    return EMPTY_OUTCOME;
  }
}

/** Exported so tests can exercise validation without a fetch at all. */
export function parseProbeResponse(body: unknown): ProbeOutcome {
  const root = asObject(body);
  const useful: string[] = [];
  const alive: string[] = [];
  for (const raw of asArray(root["alive"])) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const ip = entry["ip"];
    const port = entry["port"];
    if (typeof ip !== "string" || ip.length === 0) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const key = `${ip}:${port}`;
    // `false` is confirmed-not-useful, which is worth neither list here — it does not belong in
    // `useful` (nothing to promote it for) and it is not `dead` either (the peer did answer).
    if (entry["hasWanted"] !== false) useful.push(key);
    alive.push(key);
  }

  const dead: string[] = [];
  for (const raw of asArray(root["dead"])) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const ip = entry["ip"];
    const port = entry["port"];
    if (typeof ip !== "string" || ip.length === 0) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    dead.push(`${ip}:${port}`);
  }

  return { useful, alive, dead };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("response is not an object");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
