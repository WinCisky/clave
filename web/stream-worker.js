/**
 * Owns the stream: the WebSocket, the SHA-1 verification, and the writes to local storage.
 *
 * A Web Worker for three reasons, none of them stylistic:
 *
 *  1. OPFS `createSyncAccessHandle()` — the positional-write path, and the only one that does not
 *     copy the whole file per write — exists **only** in a worker.
 *  2. Hashing ~1000 pieces while writing at several MiB/s would make the grid stutter on the main
 *     thread, and the grid is the thing being demonstrated.
 *  3. The page then contains no protocol detail at all and never touches a byte of video.
 *
 * This is a port of `tools/testclient.mjs`, which is the reference implementation of the client half
 * of the contract. The Worker sends pieces **unverified** by design — that is what keeps it inside
 * the free plan — so everything that makes the stream trustworthy happens here.
 */

import { client, decodeServerFrame } from "./wsproto.js";
import { overlapWithFile, pieceLengthAt, safeName } from "./torrent.js";

/** Per-piece states reported to the page. Must match the grid's CSS classes. */
/** Piece indices per NAK message. One message can carry many, and inbound messages are billed. */
const NAK_BATCH = 128;

/** How many times to re-ask for missing pieces after an eof before accepting the shortfall. */
const MAX_RECONCILE_ROUNDS = 6;

const PENDING = 0;
const INFLIGHT = 1;
const OK = 2;
const BAD = 3;

const state = {
  socket: null,
  /** OPFS sync access handles for the video and its verified-piece bitmap. */
  file: null,
  bitmap: null,
  bits: null,
  memory: null, // in-memory fallback when OPFS is unavailable
  chunks: null,
  fileEntry: null,
  hashes: null,
  firstPiece: 0,
  lastPiece: 0,
  pieceTotal: 0,
  verified: 0,
  bytesWritten: 0,
  sinceGrant: 0,
  naks: 0,
  reconcileRounds: 0,
  lastMissing: -1,
  finished: false,
  paused: false,
  stopped: false,
  corruptPiece: -1,
  corruptedOnce: false,
  creditGrant: 48,
  creditEvery: 24,
  startedAt: 0,
  epoch: 0,
  swarm: { peers: 0, dialsInFlight: 0, cursor: 0, sent: 0, bytesOut: 0 },
};

self.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "start":
      void start(message).catch((err) => fail("start_failed", describe(err)));
      break;
    case "pause":
      state.paused = true;
      post({ type: "paused" });
      break;
    case "resume":
      state.paused = false;
      grant(state.creditGrant);
      post({ type: "resumed" });
      break;
    case "seek":
      if (state.socket?.readyState === WebSocket.OPEN) {
        state.socket.send(client.seekPiece(message.piece));
      }
      break;
    case "stop":
      void teardown("stopped");
      break;
    case "clear":
      void clearStorage(message.infoHash).then(
        () => post({ type: "cleared" }),
        (err) => fail("clear_failed", describe(err)),
      );
      break;
  }
};

async function start(options) {
  state.chunks = options.chunks;
  state.fileEntry = options.file;
  state.hashes = options.hashes;
  state.firstPiece = options.file.firstPiece;
  state.lastPiece = options.file.lastPiece;
  state.pieceTotal = state.lastPiece - state.firstPiece + 1;
  state.corruptPiece = options.corruptPiece ?? -1;
  state.creditGrant = options.creditGrant ?? 48;
  state.creditEvery = options.creditEvery ?? 24;
  state.startedAt = Date.now();

  const resumed = await openStorage(options.infoHash, options.fresh === true);
  post({
    type: "storage",
    backend: state.file === null ? "memory" : "opfs",
    resumedPieces: resumed,
  });
  // Publish the resumed count straight away. Otherwise the counter reads 0 while the grid already
  // shows hundreds of green cells, until the first new piece happens to arrive.
  progress();

  const url = new URL("/stream", options.workerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.searchParams.set("ih", options.infoHash);
  url.searchParams.set("file", String(options.file.index));
  url.searchParams.set("s", options.session);

  const socket = new WebSocket(url.toString());
  socket.binaryType = "arraybuffer";
  state.socket = socket;

  socket.onopen = () => {
    post({ type: "open" });
    // Grant generously. The Worker's cost model is billed on how long it holds peer sockets open,
    // so finishing early is cheaper than pacing delivery — and the buffer is ours, not its.
    grant(options.creditStart ?? 64);
  };
  socket.onmessage = (event) => {
    void onFrame(event.data).catch((err) => fail("frame_failed", describe(err)));
  };
  socket.onerror = () => fail("socket_error", "the WebSocket reported an error");
  socket.onclose = (event) => {
    post({ type: "closed", code: event.code, reason: event.reason });
  };
}

async function onFrame(data) {
  const frame = decodeServerFrame(data);
  if (frame === null) return;

  if (frame.kind === "control") {
    const control = frame.control;
    if (control.t === "stats") {
      state.epoch = control.epoch;
      state.swarm = {
        peers: control.peers,
        dialsInFlight: control.dialsInFlight,
        cursor: control.cursor,
        sent: control.sent,
        bytesOut: control.bytesOut,
      };
      progress();
      return;
    }
    if (control.t === "ready") {
      post({ type: "ready", ready: control });
      return;
    }
    if (control.t === "eof") {
      await onEof();
      return;
    }
    if (control.t === "error") {
      post({ type: "server_error", code: control.code, message: control.message });
      return;
    }
    return;
  }

  await onPiece(frame.piece);
}

async function onPiece({ pieceIndex, bytes }) {
  if (state.stopped) return;

  // A piece whose length disagrees with the torrent means the offsets are wrong upstream, and
  // hashing it would only tell us the same thing less clearly.
  const expectedLength = pieceLengthAt(state.chunks, pieceIndex);
  if (bytes.length !== expectedLength) {
    mark(pieceIndex, BAD);
    post({
      type: "anomaly",
      message: `piece ${pieceIndex} is ${bytes.length} bytes, torrent says ${expectedLength}`,
    });
    nak(pieceIndex);
    return;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const expected = state.hashes.subarray(pieceIndex * 20, pieceIndex * 20 + 20);
  let matches = digest.length === expected.length;
  if (matches) {
    for (let i = 0; i < 20; i++) {
      if (digest[i] !== expected[i]) {
        matches = false;
        break;
      }
    }
  }

  // Deliberate corruption, so the NAK path is demonstrable from the page.
  const pretendBad = pieceIndex === state.corruptPiece && !state.corruptedOnce;
  if (pretendBad) state.corruptedOnce = true;

  if (!matches || pretendBad) {
    mark(pieceIndex, BAD);
    post({
      type: "anomaly",
      message: matches
        ? `piece ${pieceIndex} rejected on purpose (?corrupt=${pieceIndex}) — re-fetching`
        : `piece ${pieceIndex} failed its SHA-1 — re-fetching from another peer`,
    });
    nak(pieceIndex);
    return;
  }

  await write(pieceIndex, bytes);
  setBit(pieceIndex);
  state.verified += 1;
  mark(pieceIndex, OK);

  state.sinceGrant += 1;
  if (!state.paused && state.sinceGrant >= state.creditEvery) {
    state.sinceGrant = 0;
    grant(state.creditGrant);
  }
  progress();
}

/** Write only the part of this piece that belongs to the chosen file. */
async function write(pieceIndex, bytes) {
  const overlap = overlapWithFile(state.chunks, state.fileEntry, pieceIndex, bytes.length);
  if (overlap === null) return;
  const slice = bytes.subarray(overlap.sourceOffset, overlap.sourceOffset + overlap.length);

  if (state.file !== null) {
    state.file.write(slice, { at: overlap.fileOffset });
  } else if (state.memory !== null) {
    state.memory.set(slice, overlap.fileOffset);
  }
  state.bytesWritten += overlap.length;
}

function nak(pieceIndex) {
  state.naks += 1;
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(client.nak([pieceIndex]));
  }
}

function grant(n) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(client.credit(n));
}

function mark(pieceIndex, pieceState) {
  post({ type: "piece", index: pieceIndex, state: pieceState });
}

/**
 * The relay says it has sent everything. Check, because "sent" and "held" can disagree.
 *
 * The relay tracks what it *sent*; this tracks what was *verified and stored*. Those diverge
 * whenever a frame does not arrive — a dropped connection, or a resumed session whose earlier
 * frames went to a socket that had already gone away. There is no "have" message in the protocol
 * for the client to correct the relay with, but there does not need to be: a piece the client is
 * missing is indistinguishable, from the relay's side, from one that failed its hash. So NAK them.
 *
 * Bounded, because a relay that cannot supply a piece must not turn this into a loop.
 */
async function onEof() {
  if (state.finished) return;
  const missing = [];
  for (let piece = state.firstPiece; piece <= state.lastPiece; piece++) {
    if (!getBit(piece)) missing.push(piece);
  }

  if (missing.length === 0) {
    await finish();
    return;
  }

  if (state.reconcileRounds >= MAX_RECONCILE_ROUNDS || missing.length === state.lastMissing) {
    post({
      type: "anomaly",
      message: `relay finished with ${missing.length} pieces still missing and could not supply them`,
    });
    await finish();
    return;
  }

  state.reconcileRounds += 1;
  state.lastMissing = missing.length;
  post({
    type: "anomaly",
    message: `relay reported eof but ${missing.length} pieces are missing here — asking for them again`,
  });

  // Batched: one message carries many indices, and inbound messages are the relay's billed side.
  for (let at = 0; at < missing.length; at += NAK_BATCH) {
    const batch = missing.slice(at, at + NAK_BATCH);
    state.naks += batch.length;
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(client.nak(batch));
  }
  grant(Math.min(missing.length, 256));
}

async function finish() {
  state.finished = true;
  await flush();
  // Release the file. A sync access handle is exclusive, so the page cannot read the result — nor
  // offer it as a download — while this worker still holds one, and there is nothing more to write.
  closeHandles();
  post({
    type: "eof",
    verified: state.verified,
    total: state.pieceTotal,
    naks: state.naks,
    bytes: state.bytesWritten,
    elapsedMs: Date.now() - state.startedAt,
  });
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(client.bye());
}

function progress() {
  const elapsed = (Date.now() - state.startedAt) / 1000;
  const remaining = state.pieceTotal - state.verified;
  const rate = elapsed > 0 ? state.bytesWritten / elapsed : 0;
  post({
    type: "progress",
    verified: state.verified,
    total: state.pieceTotal,
    naks: state.naks,
    bytes: state.bytesWritten,
    bytesPerSecond: rate,
    elapsedMs: Date.now() - state.startedAt,
    // Piece-based rather than byte-based, so it does not lurch when the tail window lands.
    etaSeconds: rate > 0 && state.verified > 0
      ? remaining * (elapsed / state.verified)
      : Number.POSITIVE_INFINITY,
    epoch: state.epoch,
    swarm: state.swarm,
    paused: state.paused,
  });
}

// -------------------------------------------------------------------------------------------------
// Storage

/**
 * Open the video file and its bitmap in the origin's private filesystem.
 *
 * The bitmap is a bit per piece of the file, recording what has been verified. Without it a reload
 * would keep the bytes but lose all knowledge of which are trustworthy, so it would have to start
 * over — and the point of storing locally is that 200 MB survives a refresh.
 *
 * Returns how many pieces were already verified.
 */
async function openStorage(infoHash, fresh) {
  const bitmapBytes = Math.ceil(state.pieceTotal / 8);
  state.bits = new Uint8Array(bitmapBytes);

  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(infoHash, { create: true });
    const name = safeName(state.fileEntry.name);

    if (fresh) {
      await dir.removeEntry(name).catch(() => {});
      await dir.removeEntry(`${name}.bitmap`).catch(() => {});
    }

    const fileHandle = await dir.getFileHandle(name, { create: true });
    state.file = await fileHandle.createSyncAccessHandle();
    // Size it up front so positional writes never have to extend the file.
    if (state.file.getSize() !== state.fileEntry.length) state.file.truncate(state.fileEntry.length);

    const bitmapHandle = await dir.getFileHandle(`${name}.bitmap`, { create: true });
    state.bitmap = await bitmapHandle.createSyncAccessHandle();
    if (state.bitmap.getSize() === bitmapBytes) {
      state.bitmap.read(state.bits, { at: 0 });
    } else {
      state.bitmap.truncate(bitmapBytes);
      state.bits.fill(0);
    }
  } catch (err) {
    // No OPFS, or it refused. The grid still works; the file does not survive the tab.
    state.file = null;
    state.bitmap = null;
    post({ type: "anomaly", message: `local storage unavailable (${describe(err)}), keeping pieces in memory` });
    try {
      state.memory = new Uint8Array(state.fileEntry.length);
    } catch {
      state.memory = null;
      post({ type: "anomaly", message: "file too large to hold in memory; pieces will be verified and discarded" });
    }
  }

  const already = [];
  for (let piece = state.firstPiece; piece <= state.lastPiece; piece++) {
    if (getBit(piece)) already.push(piece);
  }
  state.verified = already.length;
  if (already.length > 0) post({ type: "resumed_pieces", pieces: already });
  return already.length;
}

const bitIndex = (pieceIndex) => pieceIndex - state.firstPiece;

function getBit(pieceIndex) {
  const at = bitIndex(pieceIndex);
  if (at < 0 || state.bits === null) return false;
  return (state.bits[at >> 3] & (1 << (at & 7))) !== 0;
}

function setBit(pieceIndex) {
  const at = bitIndex(pieceIndex);
  if (at < 0 || state.bits === null) return;
  state.bits[at >> 3] |= 1 << (at & 7);
  // Written back in batches by `flush`, and on a cadence, so a crash loses at most a few pieces of
  // *knowledge* — never data, since the bytes are already on disk.
  if (state.verified % 16 === 0) writeBitmap();
}

function writeBitmap() {
  if (state.bitmap === null || state.bits === null) return;
  try {
    state.bitmap.write(state.bits, { at: 0 });
    state.bitmap.flush();
  } catch {
    // Best effort: losing the bitmap costs a re-download, not correctness.
  }
}

async function flush() {
  writeBitmap();
  try {
    state.file?.flush();
  } catch {
    // ignore
  }
}

function closeHandles() {
  try {
    state.file?.close();
    state.bitmap?.close();
  } catch {
    // Already closed, or the handle died with the storage; either way there is nothing to salvage.
  }
  state.file = null;
  state.bitmap = null;
}

async function clearStorage(infoHash) {
  await teardown("cleared");
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(infoHash, { recursive: true }).catch(() => {});
}

async function teardown(reason) {
  state.stopped = true;
  await flush();
  closeHandles();
  if (state.socket?.readyState === WebSocket.OPEN) {
    try {
      state.socket.send(client.bye());
    } catch {
      // ignore
    }
  }
  state.socket?.close();
  state.socket = null;
  post({ type: "stopped", reason });
}

function fail(code, message) {
  post({ type: "error", code, message });
}

function post(message) {
  self.postMessage(message);
}

function describe(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
