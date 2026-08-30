#!/usr/bin/env node
/**
 * Watch the picture, with numbers instead of eyes.
 *
 * Everything up to the SourceBuffer already has a test: `web/selftest.js` drives probe → engine →
 * muxer and hands the fragments to a `CaptureSink` that keeps the bytes, and ffmpeg then decodes
 * them. What that cannot see is the stage after it — the append queue, the throttle, the eviction,
 * the timeline alignment — because `CaptureSink` stubs all four out. That is exactly the stage that
 * produced a black, glitchy picture playing perfectly good sound, and it went unnoticed because no
 * browser reachable from the automation here will start a media pipeline: the tab is a background
 * tab, `document.visibilityState` is `hidden`, and `readyState` never leaves 0.
 *
 * So this launches a Chromium of its own, in a real window with a throwaway profile, and asks the
 * video element what it is actually doing:
 *
 *   corruptedVideoFrames / droppedVideoFrames   "glitchy", as a number
 *   mean luma of the element drawn to a canvas  "black", as a number
 *   computed `display` and the element's rect   whether the video is even on screen
 *   currentTime, readyState, error, buffered    a stall told apart from corruption
 *
 * Driven over the DevTools protocol with Node's built-in WebSocket — no framework, matching the rest
 * of the repository.
 *
 *   node scripts/devserver.mjs
 *   node scripts/playback-check.mjs
 *   node scripts/playback-check.mjs --seconds 20 'http://localhost:8080/?local=/fixtures/h264-aac.mp4'
 *   node scripts/playback-check.mjs --gpu --browser brave --seek 90 <url>
 *
 * It proves its own instrument before trusting it: an ordinary `<video src>` is played first, and if
 * that comes back black the picture readings are reported as unavailable rather than as a failure.
 * Skipping that step already produced one confident, entirely false diagnosis.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALL_BROWSERS = ["chromium", "google-chrome-stable", "google-chrome", "brave"];
const PORT = 9333;

const DEFAULT_TARGETS = [
  "http://localhost:8080/?local=/fixtures/h264-aac.mp4",
  "http://localhost:8080/?local=/fixtures/h264-eac3.mkv",
  "http://localhost:8080/?local=/fixtures/xvid-ac3.avi",
];

const args = process.argv.slice(2);
const seconds = Number(valueOf("--seconds") ?? 20);
const shots = join(valueOf("--shots") ?? "fixtures/capture", "playback");
/**
 * Software compositing, and the default.
 *
 * Under GPU compositing the decoded frames live in an overlay that no part of the DevTools protocol
 * can see: `drawImage` and `Page.captureScreenshot` both read the page beneath it, and a screencast
 * is not even sent a new frame, because as far as the page is concerned nothing changed. Checking
 * the picture is the entire point of this harness, so it gives that up only when asked: `--gpu`
 * exercises the real hardware decode path, where the frame counters are the only evidence available.
 */
const software = !args.includes("--gpu");
/** Which browser to drive. The bug being chased may well be one browser's and not another's. */
const BROWSERS = valueOf("--browser") ? [valueOf("--browser")] : ALL_BROWSERS;
/** Seek here once playback is established, then keep measuring. The path `issues.md` §4 blames. */
const seekTo = valueOf("--seek") === undefined ? null : Number(valueOf("--seek"));
const seekAt = Number(valueOf("--seek-at") ?? 12);
const targets = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  // A flag's value is not a target: `--seconds 20` must not try to open a page called "20".
  return !(index > 0 && ["--seconds", "--shots", "--browser", "--seek", "--seek-at"].includes(args[index - 1]));
});

function valueOf(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * What to ask the page, every half second.
 *
 * Runs as one expression so a sample is atomic: a reading of `currentTime` from one moment and a
 * frame count from the next would make a stall look like corruption.
 */
const SAMPLE = `(() => {
  const video = document.getElementById("video");
  const text = (id) => document.getElementById(id)?.textContent ?? null;
  if (video === null) return { missing: true };

  const style = getComputedStyle(video);
  const rect = video.getBoundingClientRect();
  const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;

  // Mean luma off a tiny canvas. A black picture reads near zero however the frame got that way,
  // where the frame counters only see what the decoder admits to.
  let luma = null;
  try {
    if (video.videoWidth > 0 && video.readyState >= 2) {
      const canvas = self.__lumaCanvas ??= new OffscreenCanvas(32, 18);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, 32, 18);
      const { data } = context.getImageData(0, 0, 32, 18);
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        total += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      luma = total / (data.length / 4);
    }
  } catch (err) {
    luma = "error: " + err.message;
  }

  const buffered = [];
  for (let i = 0; i < video.buffered.length; i++) {
    buffered.push([+video.buffered.start(i).toFixed(2), +video.buffered.end(i).toFixed(2)]);
  }

  return {
    t: +video.currentTime.toFixed(2),
    readyState: video.readyState,
    paused: video.paused,
    error: video.error ? video.error.code + " " + video.error.message : null,
    dims: video.videoWidth + "x" + video.videoHeight,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    rect: [Math.round(rect.width), Math.round(rect.height)],
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    onTop: (() => {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === null ? null : hit.tagName + (hit.id ? "#" + hit.id : "") + (hit.className ? "." + hit.className : "");
    })(),
    total: quality?.totalVideoFrames ?? null,
    dropped: quality?.droppedVideoFrames ?? null,
    corrupted: quality?.corruptedVideoFrames ?? null,
    luma,
    buffered,
    route: text("w-route"),
    container: text("w-container"),
    video: text("w-video"),
    audio: text("w-audio"),
    pageVisibility: document.visibilityState,
    watchMessage: document.getElementById("watch-message")?.hidden === false
      ? document.getElementById("watch-message").textContent : null,
    recoverMessage: document.getElementById("recover-message")?.hidden === false
      ? document.getElementById("recover-message").textContent : null,
  };
})()`;

// ---------------------------------------------------------------------------------------------
// A very small DevTools protocol client.

class Devtools {
  #socket;
  #next = 1;
  #pending = new Map();
  #listeners = new Map();

  static async open(url) {
    const client = new Devtools();
    client.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener("open", resolve, { once: true });
      client.#socket.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)), { once: true });
    });
    client.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        client.#listeners.get(message.method)?.(message.params, message.sessionId);
        return;
      }
      const waiter = client.#pending.get(message.id);
      if (waiter === undefined) return;
      client.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    return client;
  }

  /** One handler per event name — this only ever needs to watch the screencast. */
  on(method, handler) {
    this.#listeners.set(method, handler);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close() {
    this.#socket.close();
  }
}

// ---------------------------------------------------------------------------------------------

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "clave-playback-"));
  for (const browser of BROWSERS) {
    const child = spawn(browser, [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--window-size=1280,900",
      // With GPU compositing the decoded frames live in an overlay this process cannot read: both
      // `drawImage` and `Page.captureScreenshot` come back pure black for a video that is playing
      // perfectly. That is measured rather than assumed — see `calibrate` below.
      ...(software ? ["--disable-gpu"] : []),
      "about:blank",
    ], { stdio: "ignore", detached: false });

    const failed = new Promise((resolve) => child.once("error", () => resolve(null)));
    const version = await Promise.race([waitForPort(), failed]);
    if (version !== null) return { child, profile, version };
    child.kill();
  }
  throw new Error(`no browser found (tried ${BROWSERS.join(", ")})`);
}

async function waitForPort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Can this browser hand back the pixels of a playing video at all?
 *
 * It cannot, under GPU compositing: the frames sit in an overlay, and both `drawImage` and
 * `Page.captureScreenshot` return solid black for a video that is playing correctly. That produced a
 * confident, entirely false "every sampled frame is black" against an app whose picture was fine, so
 * the harness now proves its own instrument on an ordinary `<video src>` before trusting it on the
 * one under test. If the control is black, luma is reported as unreadable rather than as a failure.
 */
async function calibrate(devtools) {
  const { targetId } = await devtools.send("Target.createTarget", { url: "http://localhost:8080/index.html" });
  const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
  await devtools.send("Runtime.enable", {}, sessionId);
  const luma = await evaluate(devtools, sessionId, `(async () => {
    const video = document.createElement("video");
    video.src = "/fixtures/h264-aac.mp4";
    video.muted = true;
    video.style.cssText = "position:fixed;top:0;left:0;width:320px;height:180px";
    document.body.append(video);
    await new Promise((resolve) => video.addEventListener("canplay", resolve, { once: true }));
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, 32, 18);
    const { data } = context.getImageData(0, 0, 32, 18);
    let total = 0;
    for (let i = 0; i < data.length; i += 4) total += (data[i] + data[i + 1] + data[i + 2]) / 3;
    return total / (data.length / 4);
  })()`);
  await devtools.send("Target.closeTarget", { targetId });
  return typeof luma === "number" && luma > 4;
}

/**
 * What the compositor actually put on the glass.
 *
 * `drawImage` and `Page.captureScreenshot` both read the page *before* the video overlay is composed
 * in, so under GPU compositing they report a black rectangle for a video that is playing correctly.
 * A screencast frame comes from the compositor instead and contains the overlay — which makes it the
 * only reading that can tell a genuinely black picture apart from an unreadable one, and the only
 * one that would catch a fault in compositing rather than in decode.
 *
 * Luma is measured with ffmpeg, the same arbiter the fragment captures already use.
 */
function screencast(devtools, sessionId) {
  let latest = null;
  devtools.on("Page.screencastFrame", (params, from) => {
    if (from !== sessionId) return;
    latest = params;
    void devtools.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId);
  });
  return {
    start: () => devtools.send("Page.startScreencast",
      { format: "jpeg", quality: 80, everyNthFrame: 1 }, sessionId),
    stop: () => devtools.send("Page.stopScreencast", {}, sessionId).catch(() => {}),
    /** Mean luma of the video's rectangle in the last composited frame, or null. */
    async luma(rect) {
      if (latest === null || rect === null) return null;
      mkdirSync(shots, { recursive: true });
      const path = join(shots, "frame.jpg");
      writeFileSync(path, Buffer.from(latest.data, "base64"));
      // The screencast is scaled to fit; the crop has to be scaled with it.
      const scale = await widthOf(path) / (latest.metadata.deviceWidth || 1);
      const box = rect.map((n) => Math.max(0, Math.round(n * scale)));
      return await meanLuma(path, box);
    },
    save(name) {
      if (latest === null) return;
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, `${name}.jpg`), Buffer.from(latest.data, "base64"));
    },
  };
}

const run = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  child.on("error", () => resolve(""));
  child.on("close", () => resolve(out));
});

async function widthOf(path) {
  const out = await run("ffprobe", ["-v", "error", "-select_streams", "v",
    "-show_entries", "stream=width", "-of", "csv=p=0", path]);
  return Number(out.trim()) || 1;
}

async function meanLuma(path, [x, y, width, height]) {
  if (width < 8 || height < 8) return null;
  const out = await run("ffmpeg", ["-v", "info", "-i", path,
    "-vf", `crop=${width}:${height}:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    "-frames:v", "1", "-f", "null", "-"]);
  const match = /YAVG=([0-9.]+)/.exec(out);
  return match === null ? null : Number(match[1]);
}

/** Run one page and report what the video did. */
async function measure(devtools, url, index) {
  const { targetId } = await devtools.send("Target.createTarget", { url });
  const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
  await devtools.send("Page.enable", {}, sessionId);
  await devtools.send("Runtime.enable", {}, sessionId);
  const cast = screencast(devtools, sessionId);
  await cast.start();

  // A magnet in the query only prefills the field; the page waits to be told to go. The click has to
  // wait for `app.js` to have attached its handler, which is later than the target being created.
  if (url.includes("magnet=")) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = await evaluate(devtools, sessionId, `(() => {
        const button = document.getElementById("resolve");
        if (button === null || button.onclick === null) return "waiting";
        if (document.getElementById("page-watch").hidden === false) return "resolved";
        button.click();
        return "clicked";
      })()`);
      if (state === "clicked" || state === "resolved") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const samples = [];
  const shotsTaken = [];
  const started = Date.now();
  let playAttempted = false;
  let seeked = false;
  let seekedAt = null;

  while (Date.now() - started < seconds * 1000) {
    const elapsed = (Date.now() - started) / 1000;
    const sample = await evaluate(devtools, sessionId, SAMPLE);
    if (sample !== null && !sample.missing) {
      const composited = sample.readyState >= 2
        ? await cast.luma([sample.left, sample.top, sample.rect[0], sample.rect[1]])
        : null;
      samples.push({ at: +elapsed.toFixed(1), composited, ...sample });
      // Kick it off once there is something to play; the page never calls play() itself.
      if (!playAttempted && sample.readyState >= 2) {
        playAttempted = true;
        await evaluate(devtools, sessionId, `document.getElementById("video").play().then(()=>1,(e)=>e.name)`);
      }
      if (seekTo !== null && !seeked && playAttempted && elapsed >= seekAt) {
        seeked = true;
        seekedAt = { at: elapsed, from: sample.t, frames: sample.total };
        await evaluate(devtools, sessionId, `document.getElementById("video").currentTime = ${seekTo}, "seeking"`);
      }
    }
    for (const at of [1, 5, 15]) {
      if (elapsed >= at && !shotsTaken.includes(at)) {
        shotsTaken.push(at);
        cast.save(`${index}-${url.includes("?local=") ? url.split("/").pop() : "page"}-${at}s`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await cast.stop();
  await devtools.send("Target.closeTarget", { targetId });
  return { url, samples, seekedAt };
}

async function evaluate(devtools, sessionId, expression) {
  try {
    const { result, exceptionDetails } = await devtools.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (exceptionDetails) return { thrown: exceptionDetails.text };
    return result.value ?? null;
  } catch {
    return null;
  }
}

async function screenshot(devtools, sessionId, name) {
  try {
    const { data } = await devtools.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, sessionId);
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, `${name}.jpg`), Buffer.from(data, "base64"));
  } catch {
    // A screenshot is a convenience; the numbers are the evidence.
  }
}

/**
 * Say what happened, and whether it is acceptable.
 *
 * The three failing conditions are the three the user described, in the same order: no picture, a
 * damaged picture, and a clock that does not move.
 */
function report(run, lumaReadable) {
  const { url, samples, seekedAt } = run;
  const last = samples.at(-1);
  console.log(`\n=== ${url}`);
  if (last === undefined) {
    console.log("  no samples — the page never produced a video element");
    return false;
  }

  const played = samples.filter((s) => s.readyState >= 2);
  const lumas = (seekedAt === null ? played : played.filter((s) => s.at > seekedAt.at + 1))
    .map((s) => s.luma).filter((l) => typeof l === "number");
  const after = seekedAt === null ? played : played.filter((s) => s.at > seekedAt.at + 1);
  const advanced = after.length < 2 ? 0 : after.at(-1).t - after[0].t;
  const dark = lumas.length > 0 && lumas.every((l) => l < 4);
  const composited = (seekedAt === null ? played : played.filter((s) => s.at > seekedAt.at + 1))
    .map((s) => s.composited).filter((l) => typeof l === "number");
  const blackOnScreen = lumaReadable && composited.length > 2 && composited.every((l) => l < 4);

  console.log(`  route=${last.route}  video=${last.video}  audio=${last.audio}`);
  console.log(`  readyState=${last.readyState} dims=${last.dims} display=${last.display} `
    + `visibility=${last.visibility} opacity=${last.opacity} rect=${last.rect.join("x")} `
    + `onTop=${last.onTop} pageVisibility=${last.pageVisibility}`);
  console.log(`  currentTime=${last.t}s (advanced ${advanced.toFixed(2)}s)  buffered=${JSON.stringify(last.buffered)}`);
  console.log(`  frames: total=${last.total} dropped=${last.dropped} corrupted=${last.corrupted}`);
  if (seekedAt !== null) {
    console.log(`  seek: asked for ${seekTo}s from ${seekedAt.from}s at ${seekedAt.at}s in; `
      + `${last.total - seekedAt.frames} frames decoded since`);
  }
  console.log(`  luma (element): ${lumas.length === 0 ? "never sampled" : `${Math.min(...lumas).toFixed(1)}–${Math.max(...lumas).toFixed(1)}`}`
    + (lumaReadable ? "" : "  (not readable under GPU compositing)"));
  console.log(`  luma (composited): ${composited.length === 0 ? "never sampled" : `${Math.min(...composited).toFixed(1)}–${Math.max(...composited).toFixed(1)}`}`
    + (lumaReadable ? "" : "  (the overlay is invisible to the protocol; drop --gpu to check the picture)"));
  if (last.error) console.log(`  video.error: ${last.error}`);
  if (last.watchMessage) console.log(`  watch: ${last.watchMessage}`);
  if (last.recoverMessage) console.log(`  recover: ${last.recoverMessage}`);

  const problems = [];
  if (last.display === "none" || last.rect[0] === 0) problems.push("the video element is not on screen");
  if (dark && lumaReadable) problems.push(`every sampled frame is black (max luma ${Math.max(...lumas).toFixed(1)})`);
  if (blackOnScreen) problems.push(`the composited picture is black (max luma ${Math.max(...composited).toFixed(1)})`);
  if ((last.corrupted ?? 0) > 0) problems.push(`${last.corrupted} corrupted frames`);
  if (advanced < 1) problems.push(`the clock advanced ${advanced.toFixed(2)}s`);
  if (last.error) problems.push(`the element errored: ${last.error}`);

  for (const problem of problems) console.log(`  ✗ ${problem}`);
  if (problems.length === 0) console.log("  ✓ playing, picture present, no corrupted frames");
  return problems.length === 0;
}

const { child, profile, version } = await launch();
console.log(`browser: ${version.Browser}`);
const devtools = await Devtools.open(version.webSocketDebuggerUrl);

let clean = true;
try {
  const lumaReadable = await calibrate(devtools);
  console.log(`pixel readback: ${lumaReadable ? "working" : "unavailable — GPU overlay; frame counters only"}`);
  const list = targets.length > 0 ? targets : DEFAULT_TARGETS;
  for (const [index, url] of list.entries()) {
    clean = report(await measure(devtools, url, index), lumaReadable) && clean;
  }
} finally {
  devtools.close();
  child.kill();
  // The browser is still writing its profile as it exits; deleting underneath it throws ENOTEMPTY
  // and would lose the report that was the whole point of the run.
  await new Promise((resolve) => child.once("exit", resolve));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(`\n${clean ? "clean" : "FAILED"}`);
process.exit(clean ? 0 : 1);
