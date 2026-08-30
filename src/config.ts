/**
 * Tunables, read once per request from the bindings.
 *
 * Every read is defensive in the same spirit as cf-stream's config: a malformed variable falls
 * back to its default rather than throwing, because a typo in a dashboard value should degrade
 * one setting, not take the whole Worker down.
 *
 * These are the cost levers. The binding free-tier constraint is Durable Object *duration*
 * (13,000 GB-s/day), and duration is proportional to how long the download takes rather than to
 * how long the film runs — so the defaults are chosen to finish quickly and close, not to pace
 * delivery to playback. The client is holding the buffer; it can take bytes as fast as we send.
 */

/** The generated `Env` plus anything `wrangler types` cannot see. */
export interface Bindings extends Env {
  /** Secret, set with `wrangler secret put PROBE_TOKEN` — never declared in `wrangler.jsonc`, so
   * `wrangler types` has no way to generate it. */
  readonly PROBE_TOKEN?: string;
}

export interface Settings {
  readonly corsOrigins: readonly string[];
  readonly recordsUrl: string;

  readonly maxPeers: number;
  readonly pipelineDepth: number;
  readonly maxBytesPerTick: number;
  readonly tickBudgetMs: number;
  readonly minAlarmGapMs: number;
  readonly watchdogMs: number;
  readonly pumpStaleGraceMs: number;
  readonly maxDialsPerTick: number;
  readonly assemblyBudgetBytes: number;

  readonly headBytes: number;
  readonly tailDivisor: number;
  readonly tailMinBytes: number;
  readonly tailMaxBytes: number;

  readonly creditWindow: number;
  readonly holdMs: number;
  readonly idleMs: number;
  readonly nakBanThreshold: number;

  readonly connectTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly refreshCooldownMs: number;

  /** Empty disables probing entirely — every code path below degrades to today's behaviour. */
  readonly probeUrl: string;
  readonly probeToken: string;
  readonly probeTimeoutMs: number;
  readonly probeBatch: number;
  readonly probeNeed: number;
}

function int(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const truncated = Math.trunc(value);
  return truncated >= min && truncated <= max ? truncated : fallback;
}

function list(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function text(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.length > 0 ? raw.replace(/\/+$/, "") : fallback;
}

export function settings(env: Bindings): Settings {
  return {
    corsOrigins: list(env.CF_CORS_ORIGIN),
    recordsUrl: text(env.RECORDS_URL, "https://bstream.ssimo.dev"),

    // The ceiling that matters is the six *connecting* sockets the platform allows, which
    // `DialSlots` enforces separately — an established socket does not count against it. So a
    // larger pool is free, and on a thin swarm where most peers are choked or partial it is the
    // difference between a stalled stream and a slow one.
    maxPeers: int(env.MAX_PEERS, 24, 1, 64),
    // Outstanding 16 KiB requests per peer, so 32 is 512 KiB in flight each. What a peer can give
    // is bounded by bytes-in-flight over round-trip time, and these are transatlantic links —
    // libtorrent advertises a `reqq` of 250, so this is still well inside what peers accept.
    pipelineDepth: int(env.PIPELINE_DEPTH, 32, 1, 512),
    // One tick is one Durable Object request, and requests are what cap daily throughput, so a
    // larger budget is straightforwardly fewer of them. A Durable Object gets 30 s of CPU per
    // request — the notorious 10 ms is the plain-Worker figure and does not apply here.
    maxBytesPerTick: int(env.MAX_BYTES_PER_TICK, 16 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
    tickBudgetMs: int(env.TICK_BUDGET_MS, 5_000, 250, 25_000),
    // Every alarm is a billed request *and* a SQLite row write, against 100,000 of each per day.
    // A 250 ms pump would spend the whole daily budget on one film; this floor makes that
    // unreachable no matter how often the pump asks to be woken.
    minAlarmGapMs: int(env.MIN_ALARM_GAP_MS, 1_000, 250, 60_000),
    // The slow heartbeat that recovers a pump whose invocation was killed and enforces the hold
    // and idle transitions. Rare enough to be free.
    watchdogMs: int(env.WATCHDOG_MS, 10_000, 1_000, 120_000),
    // Grace past a tick's own budget before it is presumed dead. A killed invocation never runs
    // its `finally`, so liveness cannot be a flag.
    pumpStaleGraceMs: int(env.PUMP_STALE_GRACE_MS, 5_000, 1_000, 60_000),
    // Insurance in case `connect()` turns out to count against the 50-external-subrequest cap.
    // The docs list subrequests as fetch/KV/Cache/R2/Queues and do not mention TCP sockets, and
    // cf-stream ran well past 50 dials in one invocation in production — so this is a belt, not a
    // known limit.
    maxDialsPerTick: int(env.MAX_DIALS_PER_TICK, 40, 1, 200),
    // Piece buffers held at once, against a 128 MB isolate. A count alone is not a bound: a piece
    // is 256 KiB on the sample torrent and 16 MiB on a large one.
    assemblyBudgetBytes: int(env.ASSEMBLY_BUDGET_BYTES, 32 * 1024 * 1024, 1024 * 1024, 96 * 1024 * 1024),

    headBytes: int(env.HEAD_BYTES, 2 * 1024 * 1024, 0, 64 * 1024 * 1024),
    // An MP4 written without faststart puts `moov` at the very end, and `moov` is 0.1-1% of the
    // file — so the tail window has to scale with the file or it misses the one box a player
    // cannot start without.
    tailDivisor: int(env.TAIL_DIVISOR, 100, 1, 10_000),
    tailMinBytes: int(env.TAIL_MIN_BYTES, 1024 * 1024, 0, 64 * 1024 * 1024),
    tailMaxBytes: int(env.TAIL_MAX_BYTES, 16 * 1024 * 1024, 0, 128 * 1024 * 1024),

    // How many pieces may be outstanding to the client at once. Inbound WebSocket messages bill
    // at 20:1, so topping this up often is cheap and a wide window is the right default.
    creditWindow: int(env.CREDIT_WINDOW, 64, 1, 1024),
    // Caught up with a viewer still attached: hold the sockets this long, then drop them. Peers
    // are expensive to replace, but an open outbound TCP socket is precisely what makes the object
    // ineligible to hibernate, so holding them is what duration is spent on.
    holdMs: int(env.HOLD_MS, 20_000, 1_000, 600_000),
    idleMs: int(env.IDLE_MS, 120_000, 5_000, 900_000),
    nakBanThreshold: int(env.NAK_BAN_THRESHOLD, 3, 1, 32),

    connectTimeoutMs: int(env.CONNECT_TIMEOUT_MS, 1_200, 200, 10_000),
    handshakeTimeoutMs: int(env.HANDSHAKE_TIMEOUT_MS, 3_500, 500, 20_000),
    refreshCooldownMs: int(env.REFRESH_COOLDOWN_MS, 60_000, 5_000, 3_600_000),

    // `probe/` (a Deno Deploy service, see its README) dials a whole peer list at once, which a
    // Worker structurally cannot do — Cloudflare allows only six *connecting* sockets. Empty means
    // the feature is off: every caller of `probePeers` treats that as "nothing to do" rather than
    // an error, so an unset or unreachable probe leaves behaviour exactly as it is today.
    probeUrl: text(env.PROBE_URL, ""),
    // A secret, not a var — set with `wrangler secret put PROBE_TOKEN`, never in wrangler.jsonc.
    probeToken: text(env.PROBE_TOKEN, ""),
    probeTimeoutMs: int(env.PROBE_TIMEOUT_MS, 4_000, 500, 15_000),
    // How many of the top-ranked (already `isRoutable`- and ban-filtered) candidates to hand the
    // probe. Larger costs the probe more dials, not the Worker anything.
    probeBatch: int(env.PROBE_BATCH, 120, 1, 512),
    // Ask the probe to stop early once it has found this many useful peers, so the response comes
    // back fast rather than after a full sweep of `probeBatch` addresses.
    probeNeed: int(env.PROBE_NEED, 12, 1, 64),
  };
}

/** The id is the lowercase 40-character v1 infohash, and nothing else is addressable. */
export function isTorrentId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * The tail window for a file of this length.
 *
 * Proportional rather than fixed, then clamped: 1% of a 276 MB file is 2.7 MiB, of a 8 GB file
 * 80 MiB — which is more than the largest `moov` is ever worth speculating on, hence the ceiling.
 */
export function tailBytesFor(fileLength: number, config: Settings): number {
  const proportional = Math.floor(fileLength / config.tailDivisor);
  return Math.min(config.tailMaxBytes, Math.max(config.tailMinBytes, proportional));
}
