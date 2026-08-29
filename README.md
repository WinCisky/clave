# clave

Relays a torrent's pieces from the BitTorrent swarm to a browser over **one WebSocket**, on the
Cloudflare Workers **free plan**. Given an infohash and a file index, it opens raw TCP connections
to peers, pulls the pieces of that one file, and pushes each finished piece to the client
**unverified**. The client hashes, asks again for anything that failed, asks to seek, and assembles
the file. The Worker stores nothing and hashes nothing.

```
ws://…/stream?ih=<40-hex-infohash>&file=1&s=<session>
```

TCP rather than WebRTC because real swarms have no WebRTC peers.

## Verified end to end

Against the live public swarm, deployed on the free plan:

| | |
| --- | --- |
| Pieces delivered | **1054 / 1054** of the file |
| Hash-verified by the client | **1054**, against the torrent's own `pieces` blob |
| Mismatches | **0** |
| File assembled | 276,134,947 bytes — byte-exact, `ffprobe` reads 634.6 s of 1080p H.264 |
| Throughput | 2.7 MiB/s (peaks near 4.9) |
| Time to first piece | 0.79 s |

The assertion that matters is the second row. The client fetches the piece hashes from bstream
itself, so the Worker never sees them and cannot have been built to agree with them — one wrong
offset anywhere in peer discovery, the wire protocol, block assembly, the frame codec or the piece
arithmetic shows up as a hash mismatch and nowhere else.

## Measured free-plan budget

One full 263.5 MiB film, measured in production rather than estimated:

| Meter | Per film | Free allowance | Films/day |
| --- | --- | --- | --- |
| Worker requests | 1 | 100,000/day | — |
| **DO duration** | **12.3 GB-s** (96 s × 0.128) | **13,000 GB-s/day** | **~1,050** ← binding |
| DO requests | 70 = 1 upgrade + 67 alarms + 33 messages at 20:1 | 100,000/day | ~1,400 |
| SQLite rows written | ~70 (one per alarm) | 100,000/day | ~1,400 |
| Subrequests | 2 | 50/invocation | — |
| `connect()` dials | ~120 | not a subrequest | 6 concurrent |
| Bytes out | 263.5 MiB | — | free |

That is **44 GB-s per GB delivered**. The predecessor (`../cf-stream`, which verified and stored
into R2) measured 145 GB-s/GB, so this is a 3.3× improvement — entirely from not hashing, not
storing, and letting go of the sockets.

### Why duration is the only constraint that matters

An open outbound TCP socket is precisely what makes a Durable Object **ineligible to hibernate**,
so the peers are what cost money. Two consequences shape the whole design:

- **Drop the peers the moment nobody is watching.** `nextAction` returning `"idle"` is that lever;
  `HOLD_MS` decides how long a caught-up session keeps its sockets warm before letting go.
- **Race, do not pace.** Duration is proportional to how long the *download* takes, not to how long
  the film runs. The client holds the buffer, so it should grant credit generously and let the
  transfer finish early. Pacing delivery to playback would hold sockets for 90 minutes and cost
  roughly 8× more.

Alarms are billed 1:1 **and** cost a SQLite row write each, so `#arm` is the only place `setAlarm`
is called and it de-duplicates behind a `MIN_ALARM_GAP_MS` floor. Inbound WebSocket messages are
billed 20:1, which makes them the cheapest wake-up available — so a credit message runs the pump
inline instead of arming anything.

## How it fits together

```
browser ──GET /records/<ih>──────────────► bstream        (client fetches the hashes itself)
        └─WS /stream?ih=…&file=N─► Worker router ─► DO Session
                                     (no bytes)     ├─ fetch /records        1 subrequest
                                                    └─ connect() × N ─► peers
```

- **The router touches no payload bytes.** A plain Worker on the free plan gets 10 ms of CPU per
  invocation; a Durable Object request gets 30 s. So every byte of video is handled inside the DO
  and the router only validates a query string and upgrades a socket.
- **One DO per `(infohash, file, session)`.** `seek` and credit are per-viewer, so two clients on
  one object would fight over one cursor. Naming it also means a browser reload lands on the same
  object and resumes from its stored plan instead of starting over.
- **The 28 KB piece-hash blob never crosses the Worker.** The browser fetches it from bstream.

### Peer discovery is somebody else's problem

Workers have no UDP, so DHT and `udp://` trackers are impossible. `bstream.ssimo.dev` (a Deno
service on a VPS, `../bstream`) does that part and returns the layout plus a ranked peer list in one
48 KB response. This is not a convenience — it is what makes the project possible.

### Ordering

1. **NAKs.** The client is stalled on them and we have already paid for them once.
2. **Bootstrap** — a head window, then a tail window. The head carries `ftyp` and a faststart MP4's
   `moov`, or Matroska's EBML header and SeekHead. The tail carries the `moov` of an MP4 written
   *without* faststart, which is what many encoders emit by default. The tail window is
   **proportional** (1 % of the file, clamped to 1–16 MiB), because a `moov` is 0.1–1 % of the file
   and a fixed window silently misses it on a large one.
3. **Sequential** from the cursor.
4. Stop at the file's last piece. This streams one file, not a torrent.

Bootstrap keeps its priority even after a seek: it is a handful of pieces, and it is what makes
seeking work at all on a non-faststart file.

## Client protocol

- server → client, binary: `[0x01][u32 epoch][u32 pieceIndex][piece bytes]`
- server → client, control: `[0x02][utf8 JSON]` — `ready`, `stats`, `eof`, `error`
- client → server, text JSON: `{"t":"credit","n":64}`, `{"t":"nak","p":[12,13]}`,
  `{"t":"seek","piece":420}` (or `{"t":"seek","byte":N}`), `{"t":"bye"}`

**Whole torrent pieces are sent, not the file's byte range.** SHA-1 is defined over a piece, so a
trimmed one cannot be verified — Big Buck Bunny's video starts at torrent byte 140, behind a
subtitle track, so piece 0 legitimately carries 140 bytes that are not video. The client trims when
it assembles; `tools/testclient.mjs` shows how.

`epoch` increments on every seek and rides in every frame, so a client can discard pieces that were
already in flight for the position it left. The last piece of a torrent is short — its length is
`min(pieceLength, totalLength − index × pieceLength)` — and the client must apply that rule rather
than infer it from the frame.

## Running it

```bash
npm install
npm run verify          # typecheck + 198 tests, inside workerd
npx wrangler dev

# the whole file, hash-checked, written to disk
node tools/testclient.mjs dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c --file=1 --out=/tmp/bbb.mp4

# exercise the NAK and seek paths
node tools/testclient.mjs <infohash> --file=1 --max-pieces=60 --corrupt=5 --seek=30 --seek-to=900

# against production
node tools/testclient.mjs <infohash> --url=https://clave.xsimone97.workers.dev --file=1
```

`GET /debug/<infohash>?file=N&s=<session>` reports what a session is doing — peers with their
delivered counts and choke state, dials in flight, candidates left, credit, open assemblies, alarms,
inbound messages. It is an RPC call, so reading it cannot disturb the stream. It is the first thing
to look at when one stalls.

Tests run **inside workerd** via `@cloudflare/vitest-pool-workers`, against the real bindings, with
`--max-workers=1 --no-isolate` (Durable Object WebSockets are unsupported under per-file storage
isolation). Dialling a live swarm cannot be hermetic, so that part is the integration run above.

## Configuration

Every cost lever lives in `src/config.ts`, read from `wrangler.jsonc` vars, and every read falls
back to its default rather than throwing — a typo in one dashboard value should degrade one setting,
not take the Worker down. The defaults stay inside the free plan.

The ones that actually move the numbers: `HOLD_MS` (how long a caught-up session keeps its sockets),
`MAX_PEERS` and `PIPELINE_DEPTH` (throughput, and duration is inversely proportional to it),
`CREDIT_WINDOW` (how far ahead the client lets us run), `MIN_ALARM_GAP_MS` (the floor that makes an
expensive pump structurally impossible), `HEAD_BYTES` / `TAIL_DIVISOR` (time to first frame).

## Things that were wrong, and are worth not re-discovering

Some of these are inherited from `../cf-stream`, whose comments record what they cost. The rest were
found by the integration run in this repo — every one of them looked like "the swarm is slow".

- **A dial's signal becomes the peer's whole lifetime.** `PeerSession.dial` layers the connect and
  handshake deadlines on internally and then re-parents the surviving connection onto whatever
  signal it was handed. Passing `AbortSignal.timeout(setupMs)` there does not bound setup — it kills
  every peer 4.7 s after it connects. Pass the era signal, nothing else.
- **Advertising BEP-6 means handling BEP-6.** A peer that speaks the fast extension sends `have all`
  (id 14) *instead of* a bitfield. Treated as an unknown message, its bitfield stays empty, every
  `has()` returns false, and a seeder is silently never asked for anything. Ten peers connected and
  zero blocks requested.
- **Do not judge a peer silent when you stopped asking.** Once the bootstrap windows landed and the
  pump briefly had nothing dispatched, every peer looked idle, the whole pool was closed, and the
  session burned through its candidate list replacing peers that had been working.
- **A leecher is not a slow seeder.** The measured swarm had a peer advertising 3 of 1055 pieces.
  Judge on the bitfield, immediately; waiting for a stall window holds a pool slot for nothing.
- **Deciding what to assemble is not deciding what to request.** Sorting open assemblies by piece
  index puts the tail window last — it has the highest indices in the file — so a non-faststart
  `moov` arrives when the film is nearly done. `Scheduler.priority` exists for this.
- **`socket.closed` rejects**, and an unhandled rejection tears the DO down mid-tick.
- **Cancel a read with `reader.cancel()`.** `socket.close()` does not interrupt a pending read, and
  a quiet peer would pin the socket open — which keeps the object resident and billed.
- **Copy every chunk before retaining it.** The stream may reuse its buffer.
- **Hold one outstanding read per peer across iterations.** Starting a fresh `readNext()` each pass
  leaves the losers of the previous race still reading, so one socket gets several concurrent
  readers, which does not error — it interleaves halves of different messages.
- **Dials are fire-and-forget**, with slots reclaimed by a swept TTL. Awaiting a batch hangs when
  five settle and one does not.
- **Two dial deadlines, not one.** A dead address must not hold a connecting slot for the full
  connect-plus-handshake window; almost every address on a stale list is dead.
- **A killed invocation never runs its `finally`.** So pump liveness is wall-clock staleness, not a
  boolean, and a killed tick costs a resumption rather than the session.
- **Six concurrent *connecting* sockets** is the real platform cap, and a refused connect spends one
  while it fails. Established sockets do not count.
- Cloudflare's published *proxy* IP list is narrower than what it owns: peers do appear in
  `104.28.x`, which the published list misses and ARIN's `104.16.0.0/12` catches. `connect()` cannot
  reach them, so `isRoutable` drops them before they cost a slot.

## Peer ranking is measured, not guessed

Dialling all 220 of bstream's peers for the sample torrent and counting handshake-plus-unchoke:

| bucket | dial → unchoked |
| --- | --- |
| `health.ok > 0` | **86 %** |
| `verified: true` | 60 % |
| unranked, `source: "pex"` | 24 % |
| unranked, `source: "udp"` | 13 % |
| `ok == 0 && fails > 0` | **2 %** |
| everything, unranked | 14 % |

That is the difference between ~17 dials to find six working peers and ~40, which at six concurrent
slots is the whole cold start. The worst bucket is sorted last rather than dropped — 46 of 220 peers
land in it and one of them worked.

## Worth adding to bstream

- `GET /records/<ih>?slim=1` — omit the 28 KB `pieces` blob and the `health` array. The Worker never
  hashes, so parsing them in a 128 MB isolate is pure waste; it would halve the payload.
- `POST /peer-health` — the Worker already calls this once from `webSocketClose` with
  `{ok, fail, bad}` and tolerates a 404. `bad` means the client's SHA-1 rejected the piece, which is
  much stronger evidence than a failed connect, and better `health` directly buys fewer dials.
- Populate `webseeds` (BEP-19) where a torrent has them. A plain `fetch()` never keeps a Durable
  Object alive, so a webseed is cheaper on the binding meter than any peer — no dial, no framing
  CPU, no six-socket cap.

## Not done

- **Webseeds are not used**, even when `peers.webseeds` is non-empty. It is empty for every torrent
  tested, but it is the cheapest available speed-up when present.
- **No MSE/PE encryption.** 8 of 8 handshakes against the live swarm succeeded in the clear, and
  encryption is off by default in the widely deployed clients, so a plaintext client reaches most of
  a public swarm — but not a swarm that mandates obfuscation.
- **Good peers are not remembered across sessions.** The addresses that worked are reported to
  bstream but not cached locally, so a cold start re-derives them. This is the obvious next
  cold-start win.
- **BitTorrent v2 / hybrid torrents** are not handled; v1 SHA-1 pieces only.
- Cloudflare's Self-Serve Agreement §2.2.1(j) prohibits "a virtual private network or other similar
  proxy services", and Cloudflare publishes no definition covering a peer relay of this shape.
  Stated as a fact about the terms, not as advice.
