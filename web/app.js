/**
 * The page: three steps, a grid, and no bytes of video anywhere.
 *
 * Everything to do with the protocol, hashing and storage lives in `stream-worker.js`. This file
 * only turns messages into pixels, which is why it can afford to be straightforward.
 */

import { CONFIG } from "./config.js";
import {
  decodePieceHashes,
  describeFiles,
  formatBytes,
  formatDuration,
  parseMagnet,
  pieceRangeOfFile,
} from "./torrent.js";

/**
 * The bootstrap windows, recomputed here to colour the grid.
 *
 * These mirror the relay's own defaults (`HEAD_BYTES`, `TAIL_DIVISOR`, `TAIL_MIN_BYTES`,
 * `TAIL_MAX_BYTES` in `wrangler.jsonc`). Purely presentational — it is what makes it visible that
 * the head and tail of the file arrive before the middle — so a drift here misleads a viewer but
 * breaks nothing.
 */
const BOOTSTRAP = { headBytes: 2 * 1024 * 1024, tailDivisor: 100, tailMin: 1048576, tailMax: 16777216 };

const EXAMPLES = [
  { label: "Big Buck Bunny", magnet: "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce" },
  { label: "Sintel", magnet: "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce" },
  { label: "BBB (3 videos)", magnet: "magnet:?xt=urn:btih:8337c196d4536e9af5d2c7e599f0f1b7d71eee54&dn=BigBuckBunny_124&tr=http%3A%2F%2Fbt1.archive.org%3A6969%2Fannounce&tr=http%3A%2F%2Fbt2.archive.org%3A6969%2Fannounce" },
  { label: "Elephants Dream (8 videos)", magnet: "magnet:?xt=urn:btih:acb47ba3958759fdf09f36eeb80fe51c45c1abc9&dn=ElephantsDream&tr=http%3A%2F%2Fbt1.archive.org%3A6969%2Fannounce&tr=http%3A%2F%2Fbt2.archive.org%3A6969%2Fannounce" },
];

const $ = (id) => document.getElementById(id);
const el = {
  steps: { magnet: $("step-magnet"), file: $("step-file"), recover: $("step-recover") },
  magnet: $("magnet"),
  resolve: $("resolve"),
  reset: $("reset"),
  examples: $("examples"),
  magnetMessage: $("magnet-message"),
  magnetNote: $("magnet-note"),
  videos: $("videos"),
  others: $("others"),
  othersWrap: $("others-wrap"),
  othersSummary: $("others-summary"),
  fileMessage: $("file-message"),
  fileNote: $("file-note"),
  recoverNote: $("recover-note"),
  recoverMessage: $("recover-message"),
  grid: $("grid"),
  bar: $("bar"),
  log: $("log"),
  start: $("start"),
  pause: $("pause"),
  seek: $("seek"),
  seekPiece: $("seek-piece"),
  save: $("save"),
  clear: $("clear"),
  watch: $("watch"),
  stepWatch: $("step-watch"),
  watchNote: $("watch-note"),
  watchMessage: $("watch-message"),
  video: $("video"),
  strip: $("strip"),
  tracks: $("tracks"),
  audioLabel: $("audio-label"),
  audioTrack: $("audio-track"),
  subLabel: $("sub-label"),
  subTrack: $("sub-track"),
  stat: {
    pieces: $("s-pieces"), bytes: $("s-bytes"), rate: $("s-rate"), elapsed: $("s-elapsed"),
    eta: $("s-eta"), peers: $("s-peers"), dials: $("s-dials"),
    naks: $("s-naks"), epoch: $("s-epoch"),
  },
  watchStat: {
    route: $("w-route"), container: $("w-container"), video: $("w-video"),
    audio: $("w-audio"), buffered: $("w-buffered"), speed: $("w-speed"),
  },
};

const session = {
  infoHash: null,
  chunks: null,
  hashes: null,
  files: [],
  chosen: null,
  cells: [],
  firstPiece: 0,
  worker: null,
  running: false,
  paused: false,
  watching: false,
  duration: null,
  textTrack: null,
  lastPlayhead: -1,
};

// -------------------------------------------------------------------------------------------------
// Step 1 — the magnet

for (const example of EXAMPLES) {
  const button = document.createElement("button");
  button.textContent = example.label;
  button.onclick = () => {
    el.magnet.value = example.magnet;
    message(el.magnetMessage, null);
  };
  el.examples.append(button);
}

if (CONFIG.magnet.length > 0) el.magnet.value = CONFIG.magnet;

el.resolve.onclick = () => void resolve();
el.reset.onclick = () => location.reload();
el.magnet.onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void resolve();
};

async function resolve() {
  const parsed = parseMagnet(el.magnet.value);
  if (parsed === null) {
    message(el.magnetMessage, "error", "That is not a magnet link or a 40-character infohash.");
    return;
  }

  el.resolve.disabled = true;
  el.magnetNote.textContent = "resolving…";
  message(el.magnetMessage, "info", parsed.bare
    ? `Looking up ${parsed.infoHash}…`
    : `Resolving ${parsed.name ?? parsed.infoHash}… this walks the swarm for the torrent's metadata.`);

  try {
    // A bare infohash cannot be resolved — there are no trackers in it — so it only works if the
    // relay has already seen the magnet. Say so precisely rather than failing vaguely.
    if (!parsed.bare) {
      const response = await fetch(`${CONFIG.bstream}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ magnet: el.magnet.value.trim(), force: false }),
      });
      if (!response.ok) {
        throw new Error(`resolve returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
    }

    const records = await fetch(`${CONFIG.bstream}/records/${parsed.infoHash}`, {
      headers: { accept: "application/json" },
    });
    if (records.status === 404) {
      throw new Error(parsed.bare
        ? "The relay has never seen this infohash. Paste the full magnet link instead — a bare hash carries no trackers to find it with."
        : "The relay resolved nothing for this magnet. It may have no reachable peers.");
    }
    if (!records.ok) throw new Error(`records returned ${records.status}`);

    const body = await records.json();
    adopt(parsed.infoHash, body);
  } catch (err) {
    message(el.magnetMessage, "error", describe(err));
    el.magnetNote.textContent = "";
  } finally {
    el.resolve.disabled = false;
  }
}

function adopt(infoHash, body) {
  session.infoHash = infoHash;
  session.chunks = body.chunks;
  session.hashes = decodePieceHashes(body.chunks.pieces);
  session.files = describeFiles(body.chunks);

  const peers = body.peers?.count ?? 0;
  el.magnetNote.textContent = `${body.chunks.name} · ${peers} peers`;
  message(el.magnetMessage, peers === 0 ? "warn" : null, peers === 0
    ? "Resolved, but the relay knows of no peers right now. The download may not start."
    : null);
  el.steps.magnet.classList.replace("active", "done");
  el.reset.hidden = false;

  chooseFile();
}

// -------------------------------------------------------------------------------------------------
// Step 2 — which file

function chooseFile() {
  const videos = session.files.filter((file) => file.video && file.selectable);
  const others = session.files.filter((file) => !(file.video && file.selectable));

  el.videos.replaceChildren();
  el.others.replaceChildren();
  for (const file of videos) el.videos.append(fileButton(file, true));
  for (const file of others) el.others.append(fileButton(file, false));

  el.othersWrap.hidden = others.length === 0;
  el.othersSummary.textContent = `${others.length} other file${others.length === 1 ? "" : "s"}`;

  el.steps.file.hidden = false;

  if (videos.length === 1) {
    // Nothing to choose, so do not make the user click. The step still shows what was picked and
    // still lets them pick something else out of the collapsed list.
    el.fileNote.textContent = "only one video — chosen automatically";
    el.steps.file.classList.add("done");
    pick(videos[0]);
    return;
  }

  el.steps.file.classList.add("active");
  if (videos.length === 0) {
    el.fileNote.textContent = "no video detected — pick any file";
    message(el.fileMessage, "warn",
      "Nothing here looks like a video by mime type or extension. Every file is listed below.");
    for (const file of session.files.filter((f) => f.selectable)) el.videos.append(fileButton(file, true));
    el.othersWrap.hidden = true;
    return;
  }
  el.fileNote.textContent = `${videos.length} videos — choose one`;
}

function fileButton(file, prominent) {
  const button = document.createElement("button");
  button.className = "file";
  button.type = "button";
  button.disabled = !file.selectable;
  button.setAttribute("aria-pressed", "false");
  button.dataset.index = String(file.index);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = file.path;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${formatBytes(file.length)} · ${file.pieceCount} pieces`;

  button.append(name);
  if (prominent && file.video) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = file.mime ?? "video";
    button.append(tag);
  }
  if (file.padding) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "padding";
    button.append(tag);
  }
  button.append(meta);
  button.onclick = () => pick(file);
  return button;
}

function pick(file) {
  session.chosen = file;
  for (const button of document.querySelectorAll(".file")) {
    button.setAttribute("aria-pressed", String(button.dataset.index === String(file.index)));
  }
  el.steps.file.classList.add("done");
  el.steps.file.classList.remove("active");
  prepareGrid(file);
}

// -------------------------------------------------------------------------------------------------
// Step 3 — recover

function prepareGrid(file) {
  const chunks = session.chunks;
  const range = pieceRangeOfFile(chunks, file);
  session.firstPiece = range.first;

  const total = range.last - range.first + 1;
  // Shrink the cell so a large torrent still fits on screen; the container scrolls past the floor.
  const size = total > 12000 ? 4 : total > 6000 ? 5 : total > 2500 ? 7 : total > 1400 ? 9 : 11;
  el.grid.style.setProperty("--cell-size", `${size}px`);
  el.grid.style.setProperty("--cell-gap", size <= 5 ? "1px" : "3px");

  const boot = bootstrapPieces(chunks, file, range);
  const fragment = document.createDocumentFragment();
  session.cells = new Array(total);
  for (let i = 0; i < total; i++) {
    const piece = range.first + i;
    const cell = document.createElement("i");
    if (boot.has(piece)) cell.classList.add("boot");
    cell.title = `piece ${piece}`;
    session.cells[i] = cell;
    fragment.append(cell);
  }
  el.grid.replaceChildren(fragment);

  el.bar.max = total;
  el.bar.value = 0;
  el.stat.pieces.textContent = `0 / ${total}`;
  el.recoverNote.textContent = `${file.name} · ${formatBytes(file.length)} · pieces ${range.first}–${range.last}`;
  el.steps.recover.hidden = false;
  el.steps.recover.classList.add("active");
  el.start.disabled = false;
  el.steps.recover.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** The pieces the relay fetches before anything else: a head window, then a proportional tail. */
function bootstrapPieces(chunks, file, range) {
  const tailBytes = Math.min(BOOTSTRAP.tailMax,
    Math.max(BOOTSTRAP.tailMin, Math.floor(file.length / BOOTSTRAP.tailDivisor)));
  const pieces = new Set();
  const add = (fileStart, length) => {
    if (length <= 0) return;
    const start = Math.max(0, Math.min(fileStart, file.length - 1));
    const end = Math.min(file.length, start + length);
    const first = Math.floor((file.offset + start) / chunks.pieceLength);
    const last = Math.floor((file.offset + end - 1) / chunks.pieceLength);
    for (let piece = first; piece <= last; piece++) {
      if (piece >= range.first && piece <= range.last) pieces.add(piece);
    }
  };
  add(0, BOOTSTRAP.headBytes);
  add(file.length - tailBytes, tailBytes);
  return pieces;
}

el.start.onclick = () => {
  if (session.running) return;
  session.running = true;
  el.start.disabled = true;
  el.pause.disabled = false;
  el.seek.disabled = false;
  el.seekPiece.disabled = false;
  message(el.recoverMessage, null);

  const worker = new Worker(new URL("./stream-worker.js", import.meta.url), { type: "module" });
  session.worker = worker;
  worker.onmessage = (event) => onWorkerMessage(event.data);
  worker.onerror = (event) => {
    log(`worker error: ${event.message}`, true);
    message(el.recoverMessage, "error", `The stream worker failed: ${event.message}`);
  };

  worker.postMessage({
    type: "start",
    workerUrl: CONFIG.worker,
    // Deterministic, so a reload resumes the relay's own scheduler state as well as ours.
    session: CONFIG.fresh
      ? `${session.infoHash}-${session.chosen.index}-${Date.now()}`
      : `${session.infoHash}-${session.chosen.index}`,
    infoHash: session.infoHash,
    chunks: session.chunks,
    file: session.chosen,
    hashes: session.hashes,
    corruptPiece: CONFIG.corruptPiece,
    creditStart: CONFIG.creditStart,
    creditGrant: CONFIG.creditGrant,
    creditEvery: CONFIG.creditEvery,
    fresh: CONFIG.fresh,
  });
};

el.pause.onclick = () => {
  session.paused = !session.paused;
  session.worker?.postMessage({ type: session.paused ? "pause" : "resume" });
  el.pause.textContent = session.paused ? "Resume" : "Pause";
};

el.seek.onclick = () => {
  const piece = Number(el.seekPiece.value);
  if (!Number.isInteger(piece)) {
    message(el.recoverMessage, "warn", "Enter a piece number to seek to.");
    return;
  }
  session.worker?.postMessage({ type: "seek", piece });
  log(`seek to piece ${piece}`);
};

el.clear.onclick = () => {
  session.worker?.postMessage({ type: "clear", infoHash: session.infoHash });
  if (session.worker === null) void clearWithoutWorker();
};

el.save.onclick = () => {
  // The worker holds the file's only handle now, so it is the one that can read it back.
  if (session.worker === null) {
    message(el.recoverMessage, "warn", "Start the download first — there is nothing stored yet.");
    return;
  }
  el.save.disabled = true;
  session.worker.postMessage({ type: "save" });
};

el.watch.onclick = () => {
  if (session.worker === null || session.watching) return;
  session.watching = true;
  el.watch.disabled = true;
  el.stepWatch.hidden = false;
  el.stepWatch.classList.add("active");
  el.watchNote.textContent = "reading the file's headers…";
  el.stepWatch.scrollIntoView({ behavior: "smooth", block: "nearest" });
  session.worker.postMessage({ type: "watch" });
};

function onWorkerMessage(message_) {
  switch (message_.type) {
    case "storage":
      log(`storage: ${message_.backend}${message_.resumedPieces > 0 ? `, resumed ${message_.resumedPieces} pieces` : ""}`);
      el.watch.disabled = false;
      break;
    case "file":
      receiveFile(message_.name, message_.blob);
      break;
    case "player_ready":
      onPlayerReady(message_.plan, message_.handle);
      break;
    case "player_engine":
      log(`player engine: ${message_.engine}`);
      break;
    case "player_error":
      session.watching = false;
      el.watch.disabled = false;
      el.stepWatch.classList.remove("active");
      message(el.watchMessage, "error", message_.message);
      el.watchNote.textContent = "cannot play this file";
      log(`player: ${message_.message}`, true);
      break;
    case "player_stat":
      onPlayerStat(message_);
      break;
    case "availability":
      paintStrip(message_);
      break;
    case "subtitle_tracks":
      fillSubtitleTracks(message_.tracks);
      break;
    case "cues_reset":
      resetCues();
      break;
    case "cues":
      addCues(message_.cues);
      break;
    case "local_ready":
      log(`local file: ${message_.name}, ${formatBytes(message_.bytes)}`);
      el.watch.click();
      break;
    case "open":
      log("connected to the relay");
      break;
    case "ready":
      log(`relay ready: pieces ${message_.ready.firstPiece}–${message_.ready.lastPiece}`);
      break;
    case "resumed_pieces":
      for (const piece of message_.pieces) paint(piece, "ok");
      break;
    case "piece":
      paint(message_.index, ["", "inflight", "ok", "bad"][message_.state]);
      break;
    case "progress":
      renderProgress(message_);
      break;
    case "eof":
      session.running = false;
      el.pause.disabled = true;
      el.seek.disabled = true;
      el.save.disabled = false;
      el.watch.disabled = session.watching;
      el.steps.recover.classList.replace("active", "done");
      message(el.recoverMessage, "info",
        `Done. ${message_.verified} of ${message_.total} pieces verified, ${formatBytes(message_.bytes)} written in ${formatDuration(message_.elapsedMs / 1000)}${message_.naks > 0 ? `, ${message_.naks} re-fetched after a failed hash` : ""}.`);
      log("eof");
      break;
    case "server_error":
      log(`relay: ${message_.code}: ${message_.message}`, true);
      message(el.recoverMessage, message_.code === "peers_exhausted" ? "warn" : "error",
        `${message_.code}: ${message_.message}`);
      break;
    case "anomaly":
      log(message_.message, true);
      break;
    case "error":
      session.running = false;
      log(`${message_.code}: ${message_.message}`, true);
      message(el.recoverMessage, "error", `${message_.code}: ${message_.message}`);
      break;
    case "closed":
      log(`connection closed (${message_.code})`);
      break;
    case "cleared":
      message(el.recoverMessage, "info", "Local storage for this torrent has been cleared.");
      for (const cell of session.cells) cell.className = cell.classList.contains("boot") ? "boot" : "";
      break;
    case "paused":
      log("paused — no more credit granted");
      break;
    case "resumed":
      log("resumed");
      break;
  }
}

function paint(pieceIndex, className) {
  const cell = session.cells[pieceIndex - session.firstPiece];
  if (cell === undefined) return;
  const boot = cell.classList.contains("boot");
  cell.className = boot ? `boot ${className}` : className;
}

function renderProgress(p) {
  el.bar.value = p.verified;
  el.stat.pieces.textContent = `${p.verified} / ${p.total}`;
  el.stat.bytes.textContent = formatBytes(p.bytes);
  el.stat.rate.textContent = `${(p.bytesPerSecond / 1048576).toFixed(2)} MiB/s`;
  el.stat.elapsed.textContent = formatDuration(p.elapsedMs / 1000);
  el.stat.eta.textContent = Number.isFinite(p.etaSeconds) ? formatDuration(p.etaSeconds) : "—";
  el.stat.peers.textContent = String(p.swarm.peers);
  el.stat.dials.textContent = String(p.swarm.dialsInFlight);
  el.stat.naks.textContent = String(p.naks ?? 0);
  el.stat.epoch.textContent = String(p.epoch);
}

function receiveFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoked late: the download reads from the object URL after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  el.save.disabled = false;
}

async function clearWithoutWorker() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(session.infoHash, { recursive: true });
    message(el.recoverMessage, "info", "Local storage for this torrent has been cleared.");
  } catch (err) {
    message(el.recoverMessage, "warn", `Nothing to clear: ${describe(err)}`);
  }
}

/**
 * `?local=<url>` — skip the swarm and play one file straight from HTTP.
 *
 * Steps one to three are about finding bytes; this is about what happens to them afterwards, and
 * separating the two is what makes a playback failure attributable to the player.
 */
function startLocal(url) {
  for (const step of [el.steps.magnet, el.steps.file, el.steps.recover]) step.hidden = true;
  el.steps.magnet.hidden = false;
  el.magnetNote.textContent = "local file mode";
  message(el.magnetMessage, "info", `Playing ${url} directly — no torrent, no relay.`);
  el.steps.magnet.classList.replace("active", "done");

  const worker = new Worker(new URL("./stream-worker.js", import.meta.url), { type: "module" });
  session.worker = worker;
  session.chosen = { index: 0, name: url.split("/").pop() ?? "local" };
  worker.onmessage = (event) => onWorkerMessage(event.data);
  worker.onerror = (event) => log(`worker error: ${event.message}`, true);
  worker.postMessage({ type: "start_local", url, name: session.chosen.name });
}

if (CONFIG.local !== "") startLocal(CONFIG.local);

// -------------------------------------------------------------------------------------------------
// Step 4 — watch

const ROUTE_LABEL = {
  copy: "copy — no decoding",
  "transcode-audio": "copy video, re-encode audio",
  legacy: "wasm decode, hardware re-encode",
};

function onPlayerReady(plan, handle) {
  session.duration = plan.duration ?? null;
  // The worker owns the MediaSource; this is the only thing that crosses to the page.
  el.video.srcObject = handle;

  el.watchStat.route.textContent = ROUTE_LABEL[plan.route] ?? plan.route;
  el.watchStat.route.className = `route-${plan.route}`;
  el.watchStat.container.textContent = plan.container ?? "—";
  el.watchStat.video.textContent = plan.video === null
    ? "—"
    : `${plan.video.codec} ${plan.video.width}×${plan.video.height}`;

  const chosen = plan.audios.find((audio) => audio.id === plan.audio?.id) ?? null;
  el.watchStat.audio.textContent = chosen === null
    ? "none"
    : `${chosen.codec} ${chosen.channels}ch` +
      (chosen.copy ? "" : ` → ${chosen.encodedAs}${chosen.encodedChannels !== chosen.channels ? ` ${chosen.encodedChannels}ch` : ""}`);

  fillAudioTracks(plan.audios, plan.audio?.id ?? null);
  el.watchNote.textContent = plan.route === "copy"
    ? "playing the file as it is"
    : ROUTE_LABEL[plan.route] ?? "";
  if (plan.route === "legacy") {
    message(el.watchMessage, "warn",
      "This file uses a codec no browser can decode, so it is being decoded in WebAssembly and " +
      "re-encoded on the fly. Expect a slower start, and check the transcode speed below — under " +
      "1× and playback will eventually catch up with it.");
  }
}

function onPlayerStat(stat) {
  if (typeof stat.ahead === "number") {
    el.watchStat.buffered.textContent = `${stat.ahead.toFixed(1)}s ahead`;
  }
  if (typeof stat.speed === "number" && stat.speed > 0) {
    el.watchStat.speed.textContent = `${stat.speed.toFixed(2)}× realtime`;
  }
  if (stat.type === "engine_error") {
    message(el.watchMessage, "error", stat.message);
    log(`player: ${stat.message}`, true);
  }
  if (stat.type === "buffer_complete") el.watchStat.buffered.textContent = "complete";
}

/**
 * Paint which parts of the file are here, on the same axis as the video's own scrubber.
 *
 * A gradient with hard stops rather than a node per run: a torrent with a hundred holes would
 * otherwise be a hundred elements repainted on every piece.
 */
function paintStrip({ ranges, size, startable }) {
  const stops = [];
  for (const [from, to] of ranges) {
    stops.push(`transparent ${(from / size) * 100}%`,
               `var(--cell-2) ${(from / size) * 100}%`,
               `var(--cell-2) ${(to / size) * 100}%`,
               `transparent ${(to / size) * 100}%`);
  }
  el.strip.style.setProperty("--runs",
    stops.length === 0 ? "none" : `linear-gradient(to right, ${stops.join(",")})`);
  if (startable && el.watchNote.textContent === "reading the file's headers…") {
    el.watchNote.textContent = "ready";
  }
}

function fillAudioTracks(audios, selected) {
  const usable = audios.filter((audio) => audio.usable);
  el.audioLabel.hidden = usable.length < 2;
  el.tracks.hidden = el.audioLabel.hidden && el.subLabel.hidden;
  if (usable.length < 2) return;

  el.audioTrack.replaceChildren();
  for (const audio of usable) {
    const option = document.createElement("option");
    option.value = String(audio.id);
    const label = [audio.language, audio.name, `${audio.codec} ${audio.channels}ch`]
      .filter((part) => part != null && part !== "" && part !== "und");
    option.textContent = label.join(" · ");
    option.selected = audio.id === selected;
    el.audioTrack.append(option);
  }
}

function fillSubtitleTracks(tracks) {
  const usable = tracks.filter((track) => track.supported);
  el.subLabel.hidden = usable.length === 0;
  el.tracks.hidden = el.audioLabel.hidden && el.subLabel.hidden;

  const skipped = tracks.filter((track) => track.styled);
  if (skipped.length > 0) {
    log(`${skipped.length} styled subtitle track${skipped.length === 1 ? "" : "s"} (ASS/SSA) skipped — those need a renderer this page does not have`);
  }
  if (usable.length === 0) return;

  el.subTrack.replaceChildren();
  const off = document.createElement("option");
  off.value = "";
  off.textContent = "off";
  el.subTrack.append(off);
  for (const track of usable) {
    const option = document.createElement("option");
    option.value = String(track.number);
    option.textContent = [track.language, track.name].filter((p) => p && p !== "und").join(" · ")
      || `track ${track.number}`;
    option.selected = track.isDefault;
    el.subTrack.append(option);
  }
}

function resetCues() {
  if (session.textTrack === null) {
    session.textTrack = el.video.addTextTrack("subtitles", "Subtitles");
  }
  for (const cue of [...(session.textTrack.cues ?? [])]) session.textTrack.removeCue(cue);
  session.textTrack.mode = "showing";
}

function addCues(cues) {
  if (session.textTrack === null) resetCues();
  for (const cue of cues) {
    try {
      session.textTrack.addCue(new VTTCue(cue.start, cue.end, cue.text));
    } catch {
      // A cue with impossible timings is worth skipping, not worth failing the track over.
    }
  }
}

el.audioTrack.onchange = () => {
  session.worker?.postMessage({ type: "player_audio", id: Number(el.audioTrack.value) });
  log(`audio track → ${el.audioTrack.selectedOptions[0]?.textContent ?? ""}`);
};

el.subTrack.onchange = () => {
  const value = el.subTrack.value;
  if (value === "") {
    if (session.textTrack !== null) session.textTrack.mode = "disabled";
    session.worker?.postMessage({ type: "player_subtitles", track: null });
    return;
  }
  session.worker?.postMessage({ type: "player_subtitles", track: Number(value) });
};

// The worker cannot see the element, so it is told where the playhead is. Quarter-second
// granularity is plenty for deciding whether the buffer is far enough ahead.
el.video.addEventListener("timeupdate", () => {
  const now = Math.floor(el.video.currentTime * 4) / 4;
  if (now === session.lastPlayhead) return;
  session.lastPlayhead = now;
  session.worker?.postMessage({ type: "playhead", time: el.video.currentTime });
});

el.video.addEventListener("seeking", () => {
  session.worker?.postMessage({ type: "player_seek", time: el.video.currentTime });
  log(`seek to ${formatDuration(el.video.currentTime)}`);
});

el.video.addEventListener("error", () => {
  const code = el.video.error?.code;
  message(el.watchMessage, "error",
    `The video element rejected the stream (code ${code ?? "?"}): ${el.video.error?.message ?? ""}`);
});

// -------------------------------------------------------------------------------------------------

function message(node, kind, text) {
  if (kind === null || kind === undefined || text === null || text === undefined) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.className = `message ${kind}`;
  node.textContent = text;
}

function log(text, bad = false) {
  const line = document.createElement("div");
  if (bad) line.className = "bad";
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  el.log.append(line);
  el.log.scrollTop = el.log.scrollHeight;
}

const describe = (err) => (err instanceof Error ? err.message : String(err));

// Surfaced in the page rather than only the console, since the console is not where a viewer looks.
window.addEventListener("unhandledrejection", (event) => {
  log(`unhandled: ${describe(event.reason)}`, true);
});
