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
| **DO duration** | **8-12 GB-s** (62-96 s × 0.128) | **13,000 GB-s/day** | **~1,000-1,600** ← binding |
| DO requests | 70 = 1 upgrade + 67 alarms + 33 messages at 20:1 | 100,000/day | ~1,400 |
| SQLite rows written | ~70 (one per alarm) | 100,000/day | ~1,400 |
| Subrequests | 2 | 50/invocation | — |
| `connect()` dials | ~120 | not a subrequest | 6 concurrent |
| Bytes out | 263.5 MiB | — | free |

That is **30-44 GB-s per GB delivered** — the range is throughput, and throughput on a public swarm
varies by a factor of two between runs of the identical build, so treat any single figure with
suspicion. Duration is billed on how long the download takes, so **going faster is directly cheaper**:
the same film at 4.2 MiB/s instead of 2.7 costs a third less. The predecessor (`../cf-stream`, which verified and stored
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
npm run verify          # typecheck + 242 tests, inside workerd
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

## The browser client

`web/` is a static two-page client — no framework, no build step — that does the client half of the
contract for real: paste a magnet, pick a video if the torrent holds more than one, and it plays.

**Page one is the magnet**, and nothing else: the field, Resolve, and Clear storage. **Page two is
the file and the video**, with a Back that returns to the first. Recovery starts the moment there is
a file to recover — as soon as the magnet resolves when there is only one video, or as soon as one is
picked when there are several — and the player opens itself behind it. There is no Start button,
because it only ever delayed the download by however long it took someone to notice it.

Recovering and watching are one panel, because they are one activity: the video leads, the progress
grid sits underneath it as the evidence for what the player is doing, and Save file waits at the
bottom until the last piece is verified — half a film saved is a file that will not open.

`Back` terminates the stream worker rather than just hiding the page, and that is load-bearing: the
worker holds an *exclusive* handle on the stored file, so `Clear storage` on page one would
otherwise find it busy. Clearing also invalidates the relay's session name, because a client that
has thrown its pieces away and a Durable Object that still remembers sending them disagree in a way
that costs a whole download (see below).

```bash
node scripts/devserver.mjs          # then open http://localhost:8080/?bstream=/bstream
```

| file | job |
| --- | --- |
| `web/index.html`, `styles.css` | the three steps, the player, the grid, the legend |
| `web/app.js` | step machine, file chooser, grid painting, stats. Touches no video bytes |
| `web/stream-worker.js` | a Web Worker owning the WebSocket, SHA-1 and OPFS writes |
| `web/wsproto.js` | browser mirror of `src/wsproto.ts` |
| `web/torrent.js` | magnet parsing, piece arithmetic, video detection |
| `web/config.js` | endpoints, overridable per-load with `?bstream=` / `?worker=` |
| `web/player/` | playback: the byte gate, the route decision, the two engines, MSE, subtitles |
| `web/vendor/` | pinned mediabunny bundles and the custom libav.js build, fetched by `scripts/vendor.mjs` and `scripts/build-libav.sh` |

**The stream lives in a Web Worker** for three reasons, none of them stylistic: OPFS
`createSyncAccessHandle()` — the positional-write path — exists only in a worker; hashing ~1000
pieces while writing at several MiB/s would visibly stutter the grid; and the page then holds no
protocol detail at all.

`web/wsproto.js` duplicates the contract, so `test/wsproto-mirror.test.ts` round-trips fixtures
through the TypeScript encoder and the browser decoder. Drift here is silent — a changed header size
does not throw, it shifts every piece index and presents as universally failing hashes.

**Storage and resume.** The video goes to OPFS under `<infohash>/<filename>`, sized up front, beside
a bit-packed `<filename>.bitmap` of which pieces are verified. The session name is
`<infohash>-<fileIndex>`, so a reload resumes *both* halves: the relay restores its scheduler
snapshot, and the bitmap stops the page re-requesting what it already holds. `?fresh` forces a new
session, `?corrupt=N` pretends piece N failed its hash, `?credit=N` sets the opening grant.

## Playing it

The file is played out of the same OPFS storage the download writes into, while the download is
still running. Three things make that harder than pointing a `<video>` at a blob.

**The file is not all there.** Both engines read through one gate (`web/player/store.js`) that maps
file bytes onto torrent pieces, answers immediately when the covering pieces are verified, and
otherwise waits. The waiting is where the design is: the relay has a single cursor, so the *oldest*
blocked reader owns it, and it is only moved when what that reader wants is somewhere the relay is
not about to reach anyway. Progress is guaranteed because every waiter eventually becomes the
oldest; thrash is avoided because a piece already on its way is simply waited for. When the relay
finishes without supplying a piece, blocked reads are rejected rather than left hanging — a spinner
that never stops is the worst of the available failures.

**The container is usually not MP4-in-a-browser-shape.** A probe runs once, up front, and picks one
of four answers, then says which and why:

| route | what happens | when |
| --- | --- | --- |
| copy | demux, remux to fragmented MP4, append. No decoding at all | H.264/HEVC/VP9/AV1 with AAC/Opus/MP3/FLAC in MP4, MOV, MKV, WebM, TS |
| transcode audio | video copied untouched; audio decoded in wasm and re-encoded | AC-3, E-AC-3, DTS — no browser ships a decoder for any of them |
| legacy | libav.js demuxes and decodes; WebCodecs re-encodes in hardware | AVI, WMV/ASF, FLV, MPEG-PS, Ogg; Xvid/DivX, MPEG-2, WMV3/VC-1, Theora, Cinepak |
| unplayable | says which codec, in which container, and what this browser lacks | a video codec neither the browser nor the compatibility build can decode |

The video bitstream is **copied, never re-encoded**, on the first two routes — verified byte-identical
to the source. Only the legacy route re-encodes, and only because nothing else can.

**Nothing renders it for you.** `MediaSource` lives in the same worker as the download, so no video
byte crosses to the main thread; the page gets a `MediaSourceHandle` and assigns it to
`video.srcObject`. The worker owns the file because it has to: `createSyncAccessHandle()` takes an
*exclusive* lock, so a second worker could not open the file being written. `Save file` moved into
the worker for the same reason.

**Playback never changes the bill.** The download still races to finish, because Durable Object
duration is billed for as long as peers are held; pacing delivery to playback would turn an
8-12 GB-s film into hundreds. The only coupling is one `seek` when a read needs pieces the relay has
not reached and will not soon.

### Subtitles

Text tracks only, and only from Matroska — mediabunny reads no subtitle tracks at all, and pulling
in 3.6 MB of wasm to fetch a few kilobytes of text would be absurd, so `web/player/subtitles.js`
walks the EBML itself. The walk is forward-only and incremental, so cues appear as their part of the
film arrives. ASS/SSA tracks are listed and named as skipped rather than silently dropped; they need
a libass renderer this page does not have.

### The libav build

Upstream deliberately ships no prebuilt variant containing the MPEG decoders, so
`scripts/build-libav.sh` builds one: demuxers and decoders only, no muxers, no encoders, no CLI,
because mediabunny muxes and WebCodecs encodes. **3.6 MB of wasm**, loaded only when a file actually
needs it. It is committed, so nobody else needs emscripten.

### Verified without a swarm

`web/selftest.js` drives probe → engine → muxer against local fixtures with no MediaSource and no
network, and posts the muxed output back to the dev server so it can be checked with a real decoder.
Finding a torrent that happens to contain Xvid with an AC-3 track is a coincidence you wait for;
this is a test.

```bash
bash scripts/make-fixtures.sh       # one file per route, built with ffmpeg
node scripts/devserver.mjs          # then open http://localhost:8080/selftest.html
```

Every fixture: **750 frames — 30 s at 25 fps, exactly — zero decode errors**, durations within
0.13 s, keyframes every 2 s on the transcode routes. The copy route's video bitstream is
**bit-identical** to its source. The 440 Hz test tone comes back at **439 Hz** through both the
straight copy and the full AC-3 → wasm decode → AAC encode path, and the Xvid transcode measures
**39 dB PSNR** against its source. Seeks land within 0.1 s of each other on video and audio across
MP4, MKV, AVI and MPEG-PS. A video codec nothing here can decode is refused by name, with the reason.

**And the stage after the muxer, which nothing used to cover.** `scripts/playback-check.mjs`
(`npm run playback`) launches a Chromium of its own with a throwaway profile, drives it over the
DevTools protocol, and asks the video element what it is really doing: `getVideoPlaybackQuality()`
for dropped and corrupted frames, the mean luma of the element drawn to a canvas and of the
compositor's own screencast for whether there is a picture at all, plus `currentTime`, `buffered`,
`readyState` and the element's computed `display`. It plays `?local=` fixtures on all three routes,
takes `--seek` to exercise the path a seek follows, and takes a magnet to run the real thing end to
end. Measured over four minutes of Big Buck Bunny through the relay: **7525 frames, none dropped,
none corrupted**, with eviction holding the buffer to a minute either side of the playhead.

It proves its own instrument first. Under GPU compositing the decoded frames sit in an overlay that
the protocol cannot see — `drawImage` returns black, `captureScreenshot` returns black, and a
screencast is not even sent a new frame, because the *page* has not changed. So the harness plays an
ordinary `<video src>` before anything else, and if that comes back black it reports the picture as
unreadable instead of failing. Skipping that check produced one confident and entirely false
diagnosis of an app whose picture was fine, which is why it is now the first thing the run does.
`--gpu` opts into the real hardware path, where the frame counters are the only evidence there is.

The same harness has a trickle mode that reveals pieces over time in the relay's own order — head
window, tail window, then sequential — so a demuxer blocking on absent bytes and resuming is
reproducible. A 150 s file produced **3750 frames, exact duration, no errors**, muxed faster than it
arrived.

### Verified in the browser

Against the live swarm, through the deployed relay:

| torrent | result |
| --- | --- |
| Big Buck Bunny — 3 files, 1 video | step 2 auto-skips; **1054/1054 verified, 0 bad**, 263 MiB in 56 s; OPFS file byte-exact at 276,134,947 with a real `ftyp`/`isom` header |
| Sintel — 11 files (9 subtitle tracks), 1 video | one video found among eleven; **987/987 verified**; OPFS file byte-exact at 129,241,752 |
| archive.org `BigBuckBunny_124` — **3 videos** | step 2 offers the choice; picking the 45 MiB `.ogv` streams **pieces 752-841**, a file starting mid-torrent; **90/90 verified**; resolved from a magnet bstream had never seen |
| archive.org `ElephantsDream` — 8 videos | **does not resolve.** bstream finds 10 peers but none serve metadata inside 45 s. The page reports bstream's own error verbatim instead of hanging |

Also checked: a malformed magnet and an unknown bare infohash each produce a distinct, accurate
message; `?corrupt=800` produces a red cell, a NAK, and a green cell after the re-fetch; Clear
storage frees exactly the file's bytes; the grid's dark-green cells show the head and tail windows
arriving before the middle, which is the bootstrap policy made visible.

### Four bugs the browser client found in the relay

The Node client never reconnected, so none of these had ever been exercised:

- **A reconnect landed behind a corpse.** `getWebSockets()` is ordered oldest-first, and a closed
  page's socket outlives it briefly, so every frame — `ready` included — went to the dead socket
  while the live client sat there looking at a swarm with no peers. A new connection now closes the
  ones it replaces, and the session always addresses the newest.
- **A warm object never greeted a reconnect.** The greeting was tied to building the scheduler, so
  the second connection to a still-resident object got no `ready`, hence no layout and nothing to do.
  It is now per-connection.
- **A finished session told a reconnecting client nothing**, so a client missing pieces waited
  forever. It now re-announces `eof` once per connection.
- **"Sent" and "held" can disagree**, and the protocol has no `have` message for the client to
  correct the relay with. It does not need one: a piece the client lacks is indistinguishable from
  one that failed its hash, so the client NAKs the shortfall on `eof`. Measured recovering 479
  pieces lost to the stale socket, ending at 987/987.

## Deploying the page

`.github/workflows/pages.yml` uploads `web/` and deploys it on a push to the default branch. Two
things are needed once, and neither is discoverable from an error message:

1. Repository -> Settings -> Pages -> Source: **GitHub Actions**.
2. Add the Pages origin to `MA_CORS_ORIGIN` on the bstream VPS and restart it. bstream's CORS is an
   **allowlist**, not a wildcard — measured, `https://wincisky.github.io` is allowed while
   `http://localhost:8080` and any other origin get no `access-control-allow-origin` header at all,
   which the browser reports as a CORS failure with nothing wrong server-side. Adding
   `http://localhost:8080` and `http://127.0.0.1:8080` too makes `scripts/devserver.mjs`'s proxy
   unnecessary.

The Pages origin for this repository is `https://wincisky.github.io`, which is already on
bstream's allowlist.

## Configuration

Every cost lever lives in `src/config.ts`, read from `wrangler.jsonc` vars, and every read falls
back to its default rather than throwing — a typo in one dashboard value should degrade one setting,
not take the Worker down. The defaults stay inside the free plan.

The ones that actually move the numbers: `HOLD_MS` (how long a caught-up session keeps its sockets),
`MAX_PEERS` (24 — raising it is free on the dial budget, since the six-connection cap applies only
while a socket is being established) and `PIPELINE_DEPTH` (32, i.e. 512 KiB in flight per peer;
what a peer can give is bounded by bytes-in-flight over round-trip time),
`CREDIT_WINDOW` (how far ahead the client lets us run), `MIN_ALARM_GAP_MS` (the floor that makes an
expensive pump structurally impossible), `HEAD_BYTES` / `TAIL_DIVISOR` (time to first frame).

## Things that were wrong, and are worth not re-discovering

Some of these are inherited from `../cf-stream`, whose comments record what they cost. The rest were
found by the integration run in this repo — every one of them looked like "the swarm is slow".

- **A failed dial must not wait on `socket.close()`.** Closing a socket that never finished
  connecting takes around twenty seconds in workerd
  ([cloudflare/workerd#2060](https://github.com/cloudflare/workerd/issues/2060)), so awaiting it
  meant the *dial* did not settle until then — and a dead address held one of only **six** concurrent
  connecting slots for twenty seconds instead of releasing at the 1.2 s connect deadline. Almost
  every address on a public peer list is dead, so this one `await` *was* the cold start. Measured on
  a real swarm: **0.84 dials/second before, 5.0 after**, and on a thin 13-peer swarm the difference
  between one peer and five. Fire and forget it.
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
- **Do not re-dispatch on every arriving block.** Topping up the request pipelines walks every open
  assembly to rebuild the outstanding-block list, so doing it once per block makes receiving a block
  cost time proportional to the whole window — time spent instead of reading the next block. Batch
  the top-ups (half a pipeline's worth), and top up immediately when a piece completes, since that
  frees a whole piece's slots at once.
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

## Things playback got wrong first

Some of these looked like they were working. That is the point of the self-test: each one produced
plausible segment counts and plausible byte totals, and only a real decoder disagreed.

- **Two letters stopped a large share of MKV releases from playing at all.** mkvmerge has written a
  `LanguageIETF` element on every track it muxes since 2020. mediabunny validates Matroska's older
  `Language` element against `/^[a-z]{3}$/` and falls back to `und`, but hands the newer element's
  primary subtag back untouched — so a track tagged `en-US` arrives as `"en"`, and the MP4 muxer,
  which packs a language into three five-bit letters, throws before a single fragment is written.
  The symptom was a `TypeError` and a video that never started, on files with nothing else wrong
  with them. Nothing reaches the muxer now without passing through `web/player/language.js`.
- **A file was called unplayable HEVC when the video was never the problem.** The probe demoted the
  *whole file* to the compatibility route whenever no audio track could be decoded — and that route
  refuses HEVC on purpose, so a TrueHD remux of a film the browser plays perfectly reported itself
  as a codec the browser cannot play. Both halves were wrong: the diagnosis and the premise. The
  route now falls back to video-only, and the message names the track that actually failed. Pinned
  by three fixtures made from the same bytes, differing only in a language string.
- **The init segment was `ftyp` alone — 28 bytes.** `moov` is not written when `output.start()`
  resolves; it appears once the first packets have been muxed. Appending what had accumulated by
  then silently dropped it, leaving every fragment referring to tracks the SourceBuffer had never
  heard of. ffprobe: `trun track id unknown, no tfhd was found`. Segments are now emitted strictly
  in the order the muxer writes them, and `test/player-fmp4.test.ts` pins it.
- **A time base is a pair, and has to be taken as one.** The AVI decoder reports its frames' time
  base as `0/1`, so picking numerator and denominator independently — `frame.num || stream.num`,
  `frame.den || stream.den` — took 1 from the stream and 1 from the frame and yielded raw ticks.
  Every frame of a 25 fps file landed a whole second apart, which made the encoder emit a keyframe
  for almost every frame: 751 fragments for thirty seconds, nearly all box header. Two earlier
  "fixes" (a keyframe interval, then interleaving the feed) changed nothing, because neither was
  the cause.
- **FFmpeg's configure accepts an unknown `--enable-decoder` without complaining.** So
  `demuxer-mpeg` built a variant that could not open a `.mpg` at all — the MPEG program stream
  demuxer is `mpegps` — and `decoder-flv1` silently omitted FLV. Compounding it, the *configure*
  name and the *runtime* name differ for two of them: `decoder-msmpeg4v3` is found at runtime as
  `msmpeg4`. Every entry is now checked against the built artefact with
  `avcodec_find_decoder_by_name`.
- **The muxer refuses negative timestamps, and real files have them.** An MP4's AAC track carries
  encoder delay as a negative first timestamp. The whole run is now shifted so the muxer's timeline
  starts at zero, and the SourceBuffer's own offset puts it back — measured from the first fragment
  rather than assumed, because whether a fresh muxer rebases to zero is its business, not ours.
- **A seek started the audio where the viewer asked, not where the video actually began.** A seek
  lands on the key packet *before* the target, so asking audio for the requested time left the sound
  two seconds ahead of the picture for the rest of the film.
- **The byte gate fought the download it depends on.** Playback reads ahead constantly, and some of
  those reads land beyond the piece the relay is currently at — so the gate dutifully moved the
  relay's cursor to them. But the sequential download would have reached them within a second or two
  anyway, and each move restarts the relay somewhere else: measured against the live swarm, **seven
  cursor resets in a hundred seconds and throughput down from 2.4 MiB/s to 0.06**, with the download
  never finishing. The fix is a delay, not a cleverer target — a reader still blocked after two and a
  half seconds is genuinely stuck, which is what a real seek looks like, while a read-ahead resolves
  on its own long before that. Afterwards: **zero cursor resets, and the same file in under thirty
  seconds at 5.5 MiB/s.**
- **Clearing local storage without telling the relay costs the whole download.** The relay remembers
  per session which pieces it has sent, so the next connection was greeted with an immediate `eof`
  for a file the client no longer had a byte of. The client recovers — it NAKs the shortfall — but
  the refill arrives in NAK order rather than head-and-tail first, so the player waits for the end of
  the file and playback cannot begin until the download is finished. Clearing now starts a fresh
  relay session, and playback begins at **48 of 987 pieces**, five percent in.
- **A zero-length packet is not a drain signal, but `avcodec_send_packet` thinks it is.** Theora
  encodes a repeated frame as an empty packet, and plenty of real files are full of them: the
  archive.org Big Buck Bunny `.ogv` decoded **exactly one video frame** and then returned
  `AVERROR_EOF` for every packet after it. The symptom pointed everywhere except the cause — a
  `SourceBuffer` reports the *intersection* of its tracks, so a one-frame video track against
  minutes of audio showed nothing buffered at all, which meant the pump never throttled, which
  meant it filled the buffer until MediaSource refused it with `QuotaExceededError` after 10.5 MiB.
  Three plausible theories died before the packet lengths got measured. Empty packets are now
  filtered out, and `theora-dupframes.ogv` is a fixture that decodes one frame without the filter
  and forty-two with it.
- **The buffer throttle measured the wrong thing when nothing was playing.** It asked how far the
  buffer ran *ahead of the playhead*, and returned zero when the playhead sat outside every buffered
  range — reporting "empty, keep going" about a buffer that was filling up. It now measures the run
  waiting for the playhead when the playhead is behind it.
- **`{ type: "player_stat", ...event }` never worked.** The spread carries the event's own `type` and
  overwrites the outer one, so every statistic and every engine error the player reported was
  silently dropped by the page's message switch. It was invisible precisely because the errors it
  swallowed were the ones that would have said so.
- **Appending a whole decode batch before checking the buffer overshoots badly.** One megabyte of Ogg
  is close to fifteen seconds of video, and four was closer to a minute. Throttling now happens
  between segments, and both engines append through a single path so no code route can skip the
  timeline alignment — the flush after `finalize()` used to be exactly that route.
- **The extension bundles import a bare `"mediabunny"` specifier**, which no browser can resolve —
  and an import map would not help, because these load inside a Web Worker and import maps are
  scoped to a document. `scripts/vendor.mjs` rewrites it at vendor time. Without this the AC-3, DTS
  and AAC-encoder extensions all failed to register, and every Dolby track looked undecodable.

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
- **Styled subtitles (ASS/SSA) are listed but not rendered**, and neither are bitmap ones (PGS,
  VobSub). Text tracks are also read only from Matroska, which is where they actually live in
  practice; MP4's `tx3g` is not.
- **A video codec the browser lacks cannot be played.** The compatibility build deliberately omits
  H.264, HEVC, AV1 and VP8/9 — decoding those in WebAssembly would be far slower than realtime, so
  there is no second opinion to offer and the page says so by name instead. In practice this is
  rarer than it sounds: Chromium 151 on Linux plays HEVC, Main and Main10, through the platform
  decoder, and both `MediaSource.isTypeSupported` and `VideoDecoder.isConfigSupported` are asked
  rather than assumed.
- **A soundtrack nobody can decode does not stop the film.** TrueHD, DTS-HD MA and their kind have
  no decoder here and mediabunny does not even name them, so the track is dropped, the video plays,
  and the panel says which codec went and why. Saving the file keeps the original soundtrack.
- **The picture was never watched moving.** *(Now it is — `npm run playback`, below.)* In the automation the browser's document reports
  `hidden`, so Chrome will not run a media element's playback clock. Everything up to that does now
  verify there: the handle attaches, the segments are accepted, `readyState` reaches
  `HAVE_ENOUGH_DATA`, the buffer holds the expected thirty seconds and `videoWidth`/`videoHeight`
  report the real decoded dimensions — 1024×436 for Sintel, 532×300 for the Theora transcode. Only
  `currentTime` advancing was not seen.
- Cloudflare's Self-Serve Agreement §2.2.1(j) prohibits "a virtual private network or other similar
  proxy services", and Cloudflare publishes no definition covering a peer relay of this shape.
  Stated as a fact about the terms, not as advice.
