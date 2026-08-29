/**
 * The only `fetch()` in the design.
 *
 * `bstream` resolves a magnet over UDP trackers and the DHT and hands back both the torrent
 * layout and a peer list. A Worker has no UDP, so this dependency is not a convenience — it is
 * what makes the project possible at all. One request per session returns everything.
 *
 * Two things this module deliberately does *not* do:
 *
 *  - **Decode `chunks.pieces`.** That is 28 KB of base64 holding one SHA-1 per piece, and it is
 *    two thirds of the response. The Worker never verifies anything, so it never needs them; the
 *    browser fetches the same endpoint itself for the hashes. Parsing and allocating them here
 *    would be pure waste in a 128 MB isolate.
 *  - **Trust anything.** Everything below is untrusted input, and a malformed layout does not fail
 *    loudly — it produces piece arithmetic that is quietly wrong, which surfaces as a video that
 *    plays for four seconds and dies. So the shape is validated, not cast.
 */

import type { ChunkFileEntry, TorrentLayout } from "./layout.ts";
import { isRoutable } from "./wire/addr.ts";

export interface PeerEntry {
  readonly ip: string;
  readonly port: number;
  /** How bstream learned of this peer: "udp" (tracker) or "pex". */
  readonly source: string;
  /** bstream itself completed a BitTorrent handshake with it. */
  readonly verified: boolean;
}

export interface PeerHealth {
  /** Times a peer has served bytes. Counts, not booleans — one entry read `ok:19, fails:1`. */
  readonly ok: number;
  readonly fails: number;
  readonly bannedUntil: number | null;
}

export interface RecordsResult {
  readonly layout: TorrentLayout;
  readonly peers: readonly PeerEntry[];
  /** Keyed `ip:port`. */
  readonly health: ReadonlyMap<string, PeerHealth>;
  /** BEP-19 HTTP sources. Usually empty, but a webseed is cheaper than any peer — see below. */
  readonly webseeds: readonly string[];
  readonly resolvedAt: number;
}

export class RecordsError extends Error {
  override readonly name = "RecordsError";
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/** Matches the `peer_key` bstream's health table is indexed by. */
export function peerKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchRecordsOptions {
  /** Make bstream re-announce. Costs it real work, so only on pool starvation. */
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Injected for tests, which must never reach the network. */
  readonly fetchImpl?: typeof fetch;
}

export async function fetchRecords(
  baseUrl: string,
  infoHash: string,
  options: FetchRecordsOptions = {},
): Promise<RecordsResult> {
  if (!/^[0-9a-f]{40}$/.test(infoHash)) {
    throw new RecordsError(`"${infoHash}" is not a v1 infohash`, 400, "bad_infohash");
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/records/${infoHash}` +
    (options.refresh === true ? "?refresh=1" : "");

  // A hung dependency must not hang a stream, and the caller's own lifetime still applies.
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    throw new RecordsError(
      `records fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
      "records_unreachable",
    );
  }
  if (!response.ok) {
    throw new RecordsError(`records returned ${response.status}`, 502, "records_status");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RecordsError("records returned unparseable JSON", 502, "records_malformed");
  }
  return parseRecords(body, infoHash);
}

/** Exported so tests can exercise validation without a fetch at all. */
export function parseRecords(body: unknown, infoHash: string): RecordsResult {
  const root = asObject(body, "response");
  const chunks = asObject(root["chunks"], "chunks");
  const peersBlock = asObject(root["peers"], "peers");

  const echoed = chunks["infoHash"];
  if (typeof echoed !== "string" || echoed.toLowerCase() !== infoHash) {
    throw new RecordsError(
      `records answered for ${String(echoed)}, not ${infoHash}`,
      502,
      "infohash_mismatch",
    );
  }

  const pieceLength = positiveInt(chunks["pieceLength"], "pieceLength");
  const pieceCount = positiveInt(chunks["pieceCount"], "pieceCount");
  const totalLength = positiveInt(chunks["totalLength"], "totalLength");

  // The one cross-check worth making: these three are independent fields in the response, and a
  // disagreement between them means every piece index computed from them is wrong.
  const expectedPieces = Math.ceil(totalLength / pieceLength);
  if (expectedPieces !== pieceCount) {
    throw new RecordsError(
      `pieceCount ${pieceCount} disagrees with ${totalLength}/${pieceLength} = ${expectedPieces}`,
      502,
      "geometry_mismatch",
    );
  }

  const files = parseFiles(chunks["files"], totalLength);
  const fileIndex = asInt(chunks["fileIndex"], "fileIndex");
  if (fileIndex < 0 || fileIndex >= files.length) {
    throw new RecordsError(
      `fileIndex ${fileIndex} is outside the ${files.length} files`,
      502,
      "bad_file_index",
    );
  }

  const layout: TorrentLayout = {
    id: infoHash,
    name: typeof chunks["name"] === "string" ? chunks["name"] : infoHash,
    pieceLength,
    pieceCount,
    totalLength,
    files,
    fileIndex,
    filePath: typeof chunks["filePath"] === "string" ? chunks["filePath"] : files[fileIndex]!.path,
    fileOffset: asInt(chunks["fileOffset"], "fileOffset"),
    fileLength: asInt(chunks["fileLength"], "fileLength"),
    mime: typeof chunks["mime"] === "string" ? chunks["mime"] : "application/octet-stream",
  };

  return {
    layout,
    peers: parsePeers(peersBlock["peers"]),
    health: parseHealth(root["health"]),
    webseeds: parseWebseeds(peersBlock["webseeds"]),
    resolvedAt: typeof peersBlock["resolvedAt"] === "number" ? peersBlock["resolvedAt"] : 0,
  };
}

/**
 * Dial order.
 *
 * Measured against the live swarm for the sample torrent: every one of bstream's 220 peers was
 * dialled, handshaked and asked to unchoke, and the buckets came out this far apart —
 *
 * | bucket                      | dial → unchoked |
 * |-----------------------------|-----------------|
 * | `health.ok > 0`             | **86 %** (6/7)  |
 * | `verified: true`            | 60 % (6/10)     |
 * | unranked, `source: "pex"`   | 24 %            |
 * | unranked, `source: "udp"`   | 13 %            |
 * | `ok == 0 && fails > 0`      | **2 %** (1/46)  |
 * | everything, unranked        | 14 %            |
 *
 * — which is the difference between roughly 17 dials to find six working peers and roughly 40. At
 * six concurrent connecting slots and a 1.2 s connect deadline, that is the whole cold start.
 *
 * The last bucket is sorted last rather than dropped: 46 of 220 peers land in it and one of them
 * did work, so it is a last resort, not a blacklist. `ok > 0` outranks everything even when the
 * peer also has failures — the best peer in the sample read `ok:19, fails:1`.
 */
export function rankPeers(
  peers: readonly PeerEntry[],
  health: ReadonlyMap<string, PeerHealth>,
  banned: ReadonlySet<string>,
  now: number,
): PeerEntry[] {
  const tier = (peer: PeerEntry): number => {
    const entry = health.get(peerKey(peer.ip, peer.port));
    if (entry !== undefined && entry.ok > 0) return 0;
    if (peer.verified) return 1;
    if (entry !== undefined && entry.ok === 0 && entry.fails > 0) return 4;
    return peer.source === "pex" ? 2 : 3;
  };

  // Within a tier, the counts still carry information: a peer bstream has served from nineteen
  // times is a better bet than one it served from once. Net of failures, descending.
  const net = (peer: PeerEntry): number => {
    const entry = health.get(peerKey(peer.ip, peer.port));
    return entry === undefined ? 0 : entry.ok - entry.fails;
  };

  return peers
    .filter((peer) => {
      const key = peerKey(peer.ip, peer.port);
      if (banned.has(key)) return false;
      // A peer a Worker cannot reach is not a peer. Filtering here rather than at dial time is
      // what keeps it from spending one of only six connecting slots to discover that.
      if (!isRoutable(peer.ip, peer.port)) return false;
      const entry = health.get(key);
      return !(entry?.bannedUntil != null && entry.bannedUntil > now);
    })
    .sort((a, b) => {
      const byTier = tier(a) - tier(b);
      if (byTier !== 0) return byTier;
      const byEvidence = net(b) - net(a);
      if (byEvidence !== 0) return byEvidence;
      // Deterministic beyond that, so the order is testable and a retry is reproducible.
      return peerKey(a.ip, a.port) < peerKey(b.ip, b.port) ? -1 : 1;
    });
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordsError(`${what} is not an object`, 502, "records_malformed");
  }
  return value as Record<string, unknown>;
}

function asInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RecordsError(`${what} is not an integer`, 502, "records_malformed");
  }
  return value;
}

function positiveInt(value: unknown, what: string): number {
  const n = asInt(value, what);
  if (n <= 0) throw new RecordsError(`${what} must be positive, got ${n}`, 502, "records_malformed");
  return n;
}

function parseFiles(value: unknown, totalLength: number): ChunkFileEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RecordsError("files is empty", 502, "records_malformed");
  }
  return value.map((raw, index) => {
    const file = asObject(raw, `files[${index}]`);
    const length = asInt(file["length"], `files[${index}].length`);
    const offset = asInt(file["offset"], `files[${index}].offset`);
    if (length < 0 || offset < 0 || offset + length > totalLength) {
      throw new RecordsError(
        `files[${index}] spans ${offset}..${offset + length} outside a ${totalLength}-byte torrent`,
        502,
        "records_malformed",
      );
    }
    const entry: ChunkFileEntry = {
      path: typeof file["path"] === "string" ? file["path"] : `file${index}`,
      length,
      offset,
      ...(file["padding"] === true ? { padding: true } : {}),
      ...(typeof file["mime"] === "string" ? { mime: file["mime"] } : {}),
    };
    return entry;
  });
}

function parsePeers(value: unknown): PeerEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PeerEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const peer = raw as Record<string, unknown>;
    const ip = peer["ip"];
    const port = peer["port"];
    // A junk entry is skipped rather than fatal: one bad address must not cost a whole swarm.
    if (typeof ip !== "string" || ip.length === 0) continue;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({
      ip,
      port,
      source: typeof peer["source"] === "string" ? peer["source"] : "unknown",
      verified: peer["verified"] === true,
    });
  }
  return out;
}

function parseHealth(value: unknown): Map<string, PeerHealth> {
  const out = new Map<string, PeerHealth>();
  if (!Array.isArray(value)) return out;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const key = entry["peerKey"];
    if (typeof key !== "string") continue;
    out.set(key, {
      ok: typeof entry["ok"] === "number" ? entry["ok"] : 0,
      fails: typeof entry["fails"] === "number" ? entry["fails"] : 0,
      bannedUntil: typeof entry["bannedUntil"] === "number" ? entry["bannedUntil"] : null,
    });
  }
  return out;
}

function parseWebseeds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string =>
    typeof entry === "string" && /^https?:\/\//i.test(entry)
  );
}
