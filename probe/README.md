# probe

A Deno Deploy service whose only job is to find out, in parallel, which addresses in a peer list are actually
reachable and actually hold what a stream needs — before `clave`'s Worker spends any of its own dial budget
finding out the slow way.

## Why this exists

`clave`'s Durable Object can only have **six sockets connecting at once** — a Cloudflare platform cap, not a
tuning knob (`../src/session.ts`, `MAX_CONNECTING`). On a fresh, unranked peer list only about 14% of
addresses answer, so landing six working peers costs roughly 40 dials at six slots and a 1.2s connect deadline
each — that sequence _is_ the cold start. `../src/records.ts`'s `rankPeers` already improves this using
bstream's historical health data (`ok > 0` peers answer 86% of the time), but that evidence can be minutes or
hours old.

Deno has no six-socket cap. This service dials every candidate in a peer list at once, completes the 68-byte
BitTorrent handshake, and reads until it has seen a bitfield-shaped message or given up — turning a
220-address list into a _live-verified, currently-useful_ shortlist in about a second. Measured against the
real swarm for the sample torrent (`../fixtures/records-bbb.json`'s infohash): 220 peers in, 36 dialled before
the `need` threshold was satisfied, 13 alive, all 12+ confirmed seeds — in 628ms. The Worker's six precious
connecting slots can then dial almost entirely winners instead of guessing.

## Contract

`GET /health` → `{"ok":true}`

`POST /probe`, `authorization: Bearer <PROBE_TOKEN>`:

```jsonc
{
  "infoHash": "40 lowercase hex chars",
  "peers": [{ "ip": "1.2.3.4", "port": 51413 }], // numeric IPs only; max 512
  "pieceCount": 1055,
  "want": [0, 1, 2, 1054], // pieces to check for; max 64
  "need": 12, // return as soon as this many useful peers are found
  "budgetMs": 3000 // clamped to 8000
}
```

```jsonc
{
  "infoHash": "…",
  "tookMs": 628,
  "probed": 36,
  "truncated": true, // fewer than `peers.length` were probed before this returned
  "alive": [
    {
      "ip": "…",
      "port": 51413,
      "rttMs": 30,
      "handshakeMs": 27,
      "seed": true,
      "have": 1055,
      "hasWanted": true,
      "fast": true,
      "extended": true
    }
  ],
  "dead": [{ "ip": "…", "port": 1, "why": "connect_timeout" }]
}
```

- `hasWanted` is `true`/`false` once a bitfield-shaped message (`bitfield`, `have all`, `have
  none`)
  arrived, and `null` when the peer handshaked but nothing arrived inside the window — alive and unproven,
  better than untried, worse than confirmed-useful. `alive` is sorted `hasWanted` (true, then null, then
  false), then `seed`, then `have`, then `rttMs`, all descending except rtt.
- `why` is one of
  `connect_timeout | connect_refused | handshake_timeout | bad_protocol |
  infohash_mismatch | closed | blocked`.
- A request always returns as soon as it has an answer worth giving — `need` satisfied, the whole list swept,
  or `budgetMs` elapsed — never waiting out a straggling dial into a dead address. `truncated: true` covers
  both the early-exit and the budget-ran-out case; either way `dead` is not exhaustive.

## Deploying

```
deno task test           # unit tests, no network required except loopback fixtures
deployctl deploy --project=<name> main.ts   # or: connect the repo in the Deno Deploy dashboard
```

Set `PROBE_TOKEN` as a secret in the Deploy project settings — **there is no unauthenticated path**; a missing
token means every request is refused, not that auth is skipped. `MAX_CONCURRENCY` (default 128) is the only
other environment variable this service reads.

If raw outbound TCP (`Deno.connect`) turns out to be unavailable on Deploy for some account tier, this folder
needs no changes to run anywhere else that runs Deno — the bstream VPS (`../../bstream`) is already a Deno
service and is the fallback target; only the deploy step changes.

## Wire format is duplicated, not shared, on purpose

`wire.ts` is a from-scratch port of the relevant slice of `../src/wire/handshake.ts` and
`../src/wire/messages.ts` — the 68-byte handshake, length-prefixed framing, and bitfield decoding — against
`Deno.Conn` instead of `cloudflare:sockets`. The two runtimes' socket shapes do not overlap enough to share
code without an abstraction neither side needs, and this service has zero risk to the Worker by being fully
standalone. The cost is that **the two copies can drift**: if the wire byte layout in
`../src/wire/handshake.ts` or `../src/wire/messages.ts` ever changes (a new BEP, a reserved-bit fix),
`probe/wire.ts` needs the same change by hand. There is no test that catches this automatically — it would
have to be a fixture shared across both, which does not exist yet.

Same story for `addr.ts`: it is `../src/wire/addr.ts` minus the Cloudflare-specific address block (irrelevant
here — this is not a Cloudflare Worker) and is the actual SSRF guard for this service, not a copy kept for
consistency. It must reject the same private/reserved ranges independently, because this service has no
upstream guarantee that a caller has already filtered them.
