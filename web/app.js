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
  safeName,
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
  stat: {
    pieces: $("s-pieces"), bytes: $("s-bytes"), rate: $("s-rate"), elapsed: $("s-elapsed"),
    eta: $("s-eta"), peers: $("s-peers"), dials: $("s-dials"),
    naks: $("s-naks"), epoch: $("s-epoch"),
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

el.save.onclick = () => void save();

function onWorkerMessage(message_) {
  switch (message_.type) {
    case "storage":
      log(`storage: ${message_.backend}${message_.resumedPieces > 0 ? `, resumed ${message_.resumedPieces} pieces` : ""}`);
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

async function save() {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(session.infoHash);
    const handle = await dir.getFileHandle(safeName(session.chosen.name));
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = session.chosen.name;
    anchor.click();
    // Revoked late: the download reads from the object URL after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    message(el.recoverMessage, "error", `Could not read the stored file: ${describe(err)}`);
  }
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
