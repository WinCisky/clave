/**
 * Run the playback engines against a plain file, with no MediaSource and no swarm.
 *
 * The point is attribution. A stream that does not play could be a bad remux, a wrong codec string,
 * a stalled byte source or the video element refusing the segments, and the only way to tell is to
 * take the pieces apart. This drives probe → engine → muxer exactly as playback does, but sends the
 * fragments to a buffer instead of a SourceBuffer, then posts the result back to the dev server so
 * it can be checked with a real decoder.
 *
 * A test fixture. It is not loaded by the page and is not part of the deployed client.
 */

import { ByteStore } from "./player/store.js";
import { ROUTE, planLegacyEncoders, probeFile } from "./player/probe.js";
import { readSubtitleTracks } from "./player/subtitles.js";

/** Stands in for `Sink`: same surface, but it keeps the bytes instead of appending them. */
class CaptureSink {
  playhead = 0;
  parts = [];
  segments = 0;
  firstFragment = null;
  offset = 0;
  ended = false;

  async append(bytes) {
    this.parts.push(bytes);
    this.segments++;
  }
  async alignTo(wanted, fragment) {
    this.firstFragment = fragment;
    this.offset = wanted - fragment;
  }
  aheadOf() {
    // Never claim to be full, so the pump runs to completion instead of throttling.
    return 0;
  }
  async evict() {}
  async clear() { this.parts = []; this.segments = 0; }
  async setDuration() {}
  async end() { this.ended = true; }
  blob() { return new Blob(this.parts, { type: "video/mp4" }); }
  get bytes() { return this.parts.reduce((total, part) => total + part.length, 0); }
}

/**
 * A store over a file already in memory.
 *
 * With `trickle`, pieces are revealed over time instead of all at once, and out of order: the head
 * and tail windows first, exactly as the relay's bootstrap delivers them, then sequentially from a
 * cursor that a `requestPieces` call can move. That makes the interesting case reproducible — a
 * demuxer blocking on bytes that have not arrived, and resuming when they do — without needing a
 * swarm, a network, or luck.
 */
function memoryStore(bytes, { trickle = null } = {}) {
  const pieceLength = 262_144;
  const total = Math.ceil(bytes.length / pieceLength);
  const have = new Set();
  let cursor = 0;

  const store = new ByteStore({
    chunks: { pieceLength, totalLength: bytes.length },
    file: { offset: 0, length: bytes.length },
    readAt: (offset, length) => bytes.subarray(offset, offset + length),
    hasPiece: (piece) => trickle === null || have.has(piece),
    requestPieces: (piece) => { cursor = piece; },
    cursor: () => cursor,
  });

  if (trickle !== null) {
    // The relay's own bootstrap: a head window, then a tail window, then sequential.
    const head = Math.min(total, Math.ceil((2 * 1024 * 1024) / pieceLength));
    const tail = Math.min(total, Math.ceil((1 * 1024 * 1024) / pieceLength));
    for (let i = 0; i < head; i++) have.add(i);
    for (let i = Math.max(0, total - tail); i < total; i++) have.add(i);
    cursor = head;
    store.timer = setInterval(() => {
      for (let n = 0; n < trickle.piecesPerTick && have.size < total; n++) {
        while (have.has(cursor) && cursor < total) cursor++;
        if (cursor >= total) break;
        have.add(cursor);
      }
      store.pieceArrived();
      if (have.size >= total) clearInterval(store.timer);
    }, trickle.tickMs);
  }
  return store;
}

export async function runOne(url, { seconds = 8, seekTo = null, trickle = null } = {}) {
  const report = { url, ok: false, events: [] };
  const onEvent = (event) => {
    if (event.type === "engine_error") report.events.push(event.message);
  };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  report.size = bytes.length;

  const store = memoryStore(bytes, { trickle });
  const { CustomSource } = await import("./vendor/mediabunny.min.mjs");
  const source = () => new CustomSource({
    getSize: () => store.size,
    read: (start, end) => store.read(start, end),
    maxCacheSize: 16 * 1024 * 1024,
    prefetchProfile: "fileSystem",
  });

  const plan = await probeFile(source());
  report.route = plan.route;
  report.container = plan.container;
  report.duration = plan.duration;
  report.reason = plan.reason ?? null;
  report.video = plan.video ? `${plan.video.codec} ${plan.video.width}x${plan.video.height}` : null;
  report.audios = (plan.audios ?? []).map((a) =>
    `${a.codec}/${a.channels}ch ${a.copy ? "copy" : a.usable ? `→${a.encode.codec}` : "UNUSABLE"}`);
  report.mime = plan.mime ?? null;

  const subtitles = await readSubtitleTracks(store).catch(() => null);
  report.subtitles = (subtitles?.tracks ?? []).map((t) => `${t.codec} ${t.language}${t.supported ? "" : " (skipped)"}`);

  const sink = new CaptureSink();
  let engine;
  if (plan.route === ROUTE.LEGACY) {
    const encoders = await planLegacyEncoders();
    if (!encoders.ok) { report.error = encoders.reason; return report; }
    plan.encode = encoders;
    plan.mime = encoders.mime;
    report.mime = encoders.mime;
    report.encode = `${encoders.video}+${encoders.audio}`;
    const { LibavEngine } = await import("./player/engine-libav.js");
    engine = new LibavEngine({ store, plan, sink, name: url.split("/").pop(), onEvent });
    await engine.prepare();
  } else {
    const { MediabunnyEngine } = await import("./player/engine-mediabunny.js");
    engine = new MediabunnyEngine({ source: source(), plan, sink, onEvent });
    await engine.prepare();
  }

  const startedAt = performance.now();
  const running = engine.play(seekTo ?? 0);
  // Let it produce for a bounded time; a full transcode of a fixture is not the point.
  await Promise.race([running, new Promise((resolve) => setTimeout(resolve, seconds * 1000))]);
  engine.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (store.timer !== undefined) clearInterval(store.timer);
  report.elapsedMs = Math.round(performance.now() - startedAt);
  report.segments = sink.segments;
  report.bytes = sink.bytes;
  report.firstFragment = sink.firstFragment;
  report.ok = sink.segments > 1 && sink.bytes > 0;

  if (report.ok) {
    const name = `${url.split("/").pop().replace(/\W+/g, "_")}${seekTo ? `_seek${seekTo}` : ""}.mp4`;
    await fetch(`/capture/${name}`, { method: "PUT", body: sink.blob() });
    report.captured = name;
  }
  return report;
}

const FIXTURES = [
  "/fixtures/h264-aac.mp4",
  "/fixtures/h264-aac-nofaststart.mp4",
  "/fixtures/hevc-aac.mp4",
  "/fixtures/h264-eac3.mkv",
  "/fixtures/h264-dts.mkv",
  "/fixtures/h264-eac3-subs.mkv",
  // The Matroska language trap: an ordinary file, and a 10-bit HEVC one, that muxed nothing at all
  // until a `LanguageBCP47` tag stopped reaching the muxer verbatim.
  "/fixtures/h264-langietf.mkv",
  "/fixtures/hevc10-eac3-ietf.mkv",
  "/fixtures/hevc10-eac3-eng.mkv",
  // Playable video, undecodable sound. Must play silently rather than be refused for its codec.
  "/fixtures/hevc10-truehd.mkv",
  "/fixtures/xvid-ac3.avi",
  "/fixtures/theora-vorbis.ogv",
  "/fixtures/theora-dupframes.ogv",
  "/fixtures/mpeg2-mp2.mpg",
  "/fixtures/wmv2-wmav2.wmv",
];

export async function runAll(only = null) {
  const results = [];
  for (const url of only ?? FIXTURES) {
    try {
      results.push(await runOne(url));
    } catch (err) {
      results.push({ url, ok: false, error: `${err.name}: ${err.message}`, stack: String(err.stack ?? "").split("\n").slice(0, 4).join(" | ") });
    }
  }
  return results;
}

globalThis.selftest = { runOne, runAll, FIXTURES };
