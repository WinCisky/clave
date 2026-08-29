#!/usr/bin/env node
/**
 * The verification harness for clave. Node 22, zero dependencies.
 *
 * The Worker sends pieces **unverified** — that is the design, and it is what keeps the whole
 * service inside the free plan, because SHA-1 over a 276 MB video costs 300-600 ms of CPU. So the
 * hashing lives here, and this script is the only thing that can prove the service works.
 *
 * The assertion worth running is that **every piece received hashes to the corresponding 20 bytes
 * of the torrent's own `pieces` blob**, fetched independently from bstream. That single check
 * exercises peer discovery, the wire protocol, block assembly, the frame codec and the piece
 * arithmetic at once — a wrong offset anywhere shows up as a hash mismatch and nowhere else.
 *
 * Usage:
 *   node tools/testclient.mjs <infohash> [options]
 *
 *   --url=http://127.0.0.1:8787   the Worker
 *   --records=https://bstream.ssimo.dev
 *   --file=1                      file index within the torrent
 *   --out=path                    write the assembled file
 *   --seek=N                      after the first N pieces, seek to --seek-to
 *   --seek-to=N                   piece to seek to
 *   --corrupt=N                   pretend piece N failed its hash, to exercise the NAK path
 *   --max-pieces=N                stop early, for a smoke test
 *   --credit=N                    pieces granted per top-up (default 32)
 *   --quiet
 */

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const FRAME_PIECE = 0x01;
const FRAME_CONTROL = 0x02;
const PIECE_HEADER_BYTES = 9;

const args = process.argv.slice(2);
const infoHash = (args.find((a) => !a.startsWith("--")) ?? "").toLowerCase();
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const flag = (name) => args.includes(`--${name}`);
const num = (name, fallback) => {
  const raw = opt(name, null);
  return raw === null ? fallback : Number(raw);
};

if (!/^[0-9a-f]{40}$/.test(infoHash)) {
  console.error("usage: node tools/testclient.mjs <40-hex-infohash> [--url=…] [--file=N]");
  process.exit(2);
}

const workerUrl = opt("url", "http://127.0.0.1:8787");
const recordsUrl = opt("records", "https://bstream.ssimo.dev").replace(/\/+$/, "");
const fileIndex = opt("file", null);
const outPath = opt("out", null);
const seekAfter = num("seek", 0);
const seekTo = num("seek-to", 0);
const corruptPiece = num("corrupt", -1);
const maxPieces = num("max-pieces", Infinity);
const creditGrant = num("credit", 32);
const quiet = flag("quiet");
const sessionId = opt("s", `test-${Date.now()}`);

const log = (...parts) => {
  if (!quiet) console.log(...parts);
};

// ---------------------------------------------------------------------------------------------
// The piece hashes, fetched independently of the Worker. This is what makes the check meaningful:
// the Worker never sees them and cannot have been built to agree with them.

log(`fetching records for ${infoHash}`);
const recordsResponse = await fetch(
  `${recordsUrl}/records/${infoHash}`,
  { headers: { accept: "application/json" } },
);
if (!recordsResponse.ok) {
  console.error(`records returned ${recordsResponse.status}`);
  process.exit(1);
}
const records = await recordsResponse.json();
const chunks = records.chunks;
const hashes = Buffer.from(chunks.pieces, "base64");
if (hashes.length !== chunks.pieceCount * 20) {
  console.error(`pieces blob is ${hashes.length} bytes for ${chunks.pieceCount} pieces`);
  process.exit(1);
}
const expectedHash = (piece) => hashes.subarray(piece * 20, piece * 20 + 20);
const pieceLengthAt = (piece) =>
  Math.min(chunks.pieceLength, chunks.totalLength - piece * chunks.pieceLength);

log(
  `  ${chunks.name}: ${chunks.pieceCount} pieces of ${chunks.pieceLength}, ` +
    `${chunks.totalLength} bytes, ${records.peers.count} peers`,
);

// ---------------------------------------------------------------------------------------------

const wsUrl = new URL("/stream", workerUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.searchParams.set("ih", infoHash);
if (fileIndex !== null) wsUrl.searchParams.set("file", fileIndex);
wsUrl.searchParams.set("s", sessionId);

log(`connecting to ${wsUrl}`);
const socket = new WebSocket(wsUrl);
socket.binaryType = "arraybuffer";

const state = {
  ready: null,
  received: 0,
  verified: 0,
  mismatched: 0,
  duplicated: 0,
  bytes: 0,
  naks: 0,
  order: [],
  seen: new Set(),
  epoch: 0,
  seeked: false,
  corruptedOnce: false,
  startedAt: 0,
  firstPieceAt: 0,
  peerKeys: new Set(),
  handle: null,
};

const send = (message) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

function finish(code) {
  const elapsed = (Date.now() - state.startedAt) / 1000;
  const mib = state.bytes / 1048576;
  console.log("");
  console.log("── result ─────────────────────────────────────────");
  console.log(`pieces received      ${state.received}`);
  console.log(`  hash verified      ${state.verified}`);
  console.log(`  hash MISMATCH      ${state.mismatched}`);
  console.log(`  duplicates         ${state.duplicated}`);
  console.log(`NAKs sent            ${state.naks}`);
  console.log(`bytes               ${state.bytes} (${mib.toFixed(1)} MiB)`);
  console.log(`elapsed             ${elapsed.toFixed(1)} s`);
  if (elapsed > 0) console.log(`throughput          ${(mib / elapsed).toFixed(2)} MiB/s`);
  if (state.firstPieceAt > 0) {
    console.log(`time to first piece ${((state.firstPieceAt - state.startedAt) / 1000).toFixed(2)} s`);
  }
  if (state.ready !== null) {
    const owed = state.ready.lastPiece - state.ready.firstPiece + 1;
    console.log(`file pieces         ${state.seen.size} of ${owed}`);
  }

  // Bootstrap ordering: the head and tail windows must arrive before the sequential body, or a
  // player cannot start on a file whose `moov` sits at the end.
  if (state.ready !== null && state.order.length > 12) {
    const first = state.order.slice(0, 12);
    const nearEnd = first.filter((p) => p >= state.ready.lastPiece - 60).length;
    console.log(`tail pieces in first 12  ${nearEnd} ${nearEnd > 0 ? "(bootstrap working)" : "(NO TAIL PREFETCH)"}`);
  }
  console.log("");
  console.log(`verdict             ${state.mismatched === 0 && state.verified > 0 ? "PASS" : "FAIL"}`);
  console.log("──────────────────────────────────────────────────");
  process.exit(code ?? (state.mismatched === 0 && state.verified > 0 ? 0 : 1));
}

socket.addEventListener("open", () => {
  state.startedAt = Date.now();
  log("open; granting initial credit");
  send({ t: "credit", n: creditGrant });
});

socket.addEventListener("message", async (event) => {
  const data = event.data;
  if (typeof data === "string") {
    log("unexpected text frame:", data.slice(0, 200));
    return;
  }
  const bytes = Buffer.from(data);
  if (bytes.length === 0) return;

  if (bytes[0] === FRAME_CONTROL) {
    let control;
    try {
      control = JSON.parse(bytes.subarray(1).toString("utf8"));
    } catch {
      return;
    }
    await onControl(control);
    return;
  }

  if (bytes[0] !== FRAME_PIECE || bytes.length < PIECE_HEADER_BYTES) return;
  await onPiece(bytes.readUInt32BE(1), bytes.readUInt32BE(5), bytes.subarray(PIECE_HEADER_BYTES));
});

async function onControl(control) {
  switch (control.t) {
    case "ready": {
      state.ready = control;
      log(
        `ready: ${control.file.path} (${control.file.length} bytes, ${control.file.mime}), ` +
          `pieces ${control.firstPiece}..${control.lastPiece}`,
      );
      // Cross-check the Worker's arithmetic against the records we fetched ourselves.
      if (control.pieceLength !== chunks.pieceLength || control.pieceCount !== chunks.pieceCount) {
        console.error("FAIL: worker geometry disagrees with bstream");
        finish(1);
      }
      if (outPath !== null) {
        state.handle = await open(outPath, "w");
        log(`writing to ${outPath}`);
      }
      break;
    }
    case "stats": {
      state.epoch = control.epoch;
      log(
        `  stats epoch=${control.epoch} cursor=${control.cursor} sent=${control.sent} ` +
          `peers=${control.peers} dialling=${control.dialsInFlight} out=${
            (control.bytesOut / 1048576).toFixed(1)
          }MiB`,
      );
      break;
    }
    case "eof": {
      log(`eof after ${control.sent} pieces`);
      if (state.handle !== null) await state.handle.close();
      finish();
      break;
    }
    case "error": {
      console.error(`worker error: ${control.code}: ${control.message}`);
      if (control.code === "no_peers" || control.code.startsWith("records")) finish(1);
      break;
    }
  }
}

async function onPiece(epoch, pieceIndex, payload) {
  state.received += 1;
  state.bytes += payload.length;
  if (state.firstPieceAt === 0) state.firstPieceAt = Date.now();

  if (state.seen.has(pieceIndex)) {
    state.duplicated += 1;
  } else {
    state.order.push(pieceIndex);
  }

  // The piece must be the length the torrent says, or the offsets are wrong somewhere upstream.
  const wanted = pieceLengthAt(pieceIndex);
  if (payload.length !== wanted) {
    console.error(
      `FAIL: piece ${pieceIndex} is ${payload.length} bytes, torrent says ${wanted}`,
    );
    state.mismatched += 1;
    return;
  }

  const digest = createHash("sha1").update(payload).digest();
  const matches = digest.equals(expectedHash(pieceIndex));

  // Deliberate corruption, to prove the NAK path actually re-fetches.
  const pretendBad = pieceIndex === corruptPiece && !state.corruptedOnce;
  if (pretendBad) state.corruptedOnce = true;

  if (!matches || pretendBad) {
    if (!matches) {
      state.mismatched += 1;
      console.error(`HASH MISMATCH on piece ${pieceIndex}`);
    } else {
      log(`  pretending piece ${pieceIndex} failed, to exercise the NAK path`);
    }
    state.naks += 1;
    state.seen.delete(pieceIndex);
    send({ t: "nak", p: [pieceIndex] });
    return;
  }

  state.verified += 1;
  state.seen.add(pieceIndex);

  if (state.handle !== null && state.ready !== null) {
    await writePiece(pieceIndex, payload);
  }

  // Credit is granted in batches, not per piece: an inbound WebSocket message is billed 20:1, so
  // this is cheap, but there is no reason to make it cheaper still by stalling the pipeline.
  if (state.verified % Math.max(1, Math.floor(creditGrant / 2)) === 0) {
    send({ t: "credit", n: creditGrant });
  }

  if (seekAfter > 0 && !state.seeked && state.verified >= seekAfter) {
    state.seeked = true;
    log(`  seeking to piece ${seekTo}`);
    send({ t: "seek", piece: seekTo });
  }

  if (state.verified >= maxPieces) {
    log(`stopping at ${maxPieces} pieces`);
    send({ t: "bye" });
    if (state.handle !== null) await state.handle.close();
    finish();
  }
}

/**
 * Write the part of this piece that belongs to the selected file.
 *
 * A piece is a *torrent* range, so the first and last piece of a file are usually shared with a
 * neighbour — Big Buck Bunny's video starts at torrent byte 140, behind a subtitle track. Trimming
 * is the client's job precisely because the Worker must send whole pieces for the hash to check.
 */
async function writePiece(pieceIndex, payload) {
  const { file } = state.ready;
  const pieceStart = pieceIndex * chunks.pieceLength;
  const from = Math.max(pieceStart, file.offset);
  const to = Math.min(pieceStart + payload.length, file.offset + file.length);
  if (to <= from) return;
  await state.handle.write(payload, from - pieceStart, to - from, from - file.offset);
}

socket.addEventListener("close", async (event) => {
  log(`closed: ${event.code} ${event.reason}`);
  if (state.handle !== null) await state.handle.close().catch(() => {});
  finish();
});

socket.addEventListener("error", () => {
  console.error("websocket error");
  finish(1);
});

// A stream that never starts is a failure, not a hang.
setTimeout(() => {
  console.error("timed out with no progress");
  finish(1);
}, num("timeout", 180) * 1000);
