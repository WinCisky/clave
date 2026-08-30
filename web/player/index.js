/**
 * The player, as the stream worker sees it.
 *
 * It lives in the same worker as the download for one unavoidable reason: OPFS's
 * `createSyncAccessHandle()` takes an *exclusive* lock, so no second worker can open the file being
 * written. What starts as a constraint turns out to be the better arrangement anyway — the
 * verified-piece bitmap is an in-process lookup instead of a message round trip, and because MSE
 * works in dedicated workers the video never has to cross to the main thread at all.
 */

import { ByteStore } from "./store.js";
import { Sink } from "./mse.js";
import { ROUTE, planLegacyEncoders, probeFile } from "./probe.js";
import { extractCues, readSubtitleTracks } from "./subtitles.js";

/** Enough buffered to be worth starting. Below this a viewer just watches it stall. */
const START_SECONDS = 2;

export class Player {
  #post;
  #store;
  #sink = null;
  #engine = null;
  #plan = null;
  #layout = null;
  #subtitleRun = 0;
  #closed = false;
  #fileName;

  constructor({ chunks, file, readAt, hasPiece, requestPieces, cursor, post }) {
    this.#post = post;
    // libav probes by content, but a plausible extension is a strong hint and some demuxers are
    // only reached through it.
    this.#fileName = (file.name ?? file.path ?? "input.bin").split("/").pop();
    this.#store = new ByteStore({ chunks, file, readAt, hasPiece, requestPieces, cursor });
  }

  get store() {
    return this.#store;
  }

  /** A verified piece landed. Wakes whatever read was waiting for it. */
  pieceArrived() {
    this.#store.pieceArrived();
    if (this.#sink !== null) this.#reportAvailability();
  }

  /** The relay has given up. Better to fail a read loudly than to leave a spinner turning. */
  exhaust(reason) {
    this.#store.exhaust(reason);
  }

  async open() {
    const source = {
      getSize: () => this.#store.size,
      read: (start, end) => this.#store.read(start, end),
      // Bounded, and the gentler of the two profiles: an aggressive read-ahead would queue demands
      // for pieces nobody is waiting on and pull the relay's cursor away from the playhead.
      maxCacheSize: 16 * 1024 * 1024,
      prefetchProfile: "fileSystem",
    };

    const { CustomSource } = await import("../vendor/mediabunny.min.mjs");
    const plan = await probeFile(new CustomSource(source));

    if (plan.route === ROUTE.LEGACY) {
      const encoders = await planLegacyEncoders();
      if (!encoders.ok) {
        this.#post({ type: "player_error", plan, message: encoders.reason });
        return;
      }
      plan.encode = encoders;
      plan.mime = encoders.mime;
    }

    this.#plan = plan;
    this.#sink = new Sink();
    const handle = this.#sink.handle;
    // The page attaches this to the video element, which is what opens the MediaSource.
    this.#post({ type: "player_ready", plan: summarise(plan), handle }, [handle]);

    await this.#sink.open(plan.mime, plan.duration ?? undefined);

    if (plan.route === ROUTE.LEGACY) {
      const { LibavEngine } = await import("./engine-libav.js");
      this.#engine = new LibavEngine({
        store: this.#store, plan, sink: this.#sink,
        name: this.#fileName, onEvent: (event) => this.#post({ type: "player_stat", stat: event }),
      });
      let detail;
      try {
        detail = await this.#engine.prepare();
      } catch (err) {
        this.#post({ type: "player_error", plan: summarise(plan), message: describe(err) });
        this.#engine = null;
        return;
      }
      // The probe found no duration in the container's metadata for these formats; libav has it.
      if (plan.duration == null) {
        const duration = await this.#engine.duration();
        if (duration !== null) {
          plan.duration = duration;
          await this.#sink.setDuration(duration);
          this.#post({ type: "player_duration", duration });
        }
      }
      this.#post({ type: "player_engine", engine: "libav", detail });
    } else {
      const { MediabunnyEngine } = await import("./engine-mediabunny.js");
      this.#engine = new MediabunnyEngine({
        source: new CustomSource(source), plan, sink: this.#sink,
        onEvent: (event) => this.#post({ type: "player_stat", stat: event }),
      });
      await this.#engine.prepare();
      this.#post({ type: "player_engine", engine: "mediabunny" });
    }

    this.#reportAvailability();
    void this.#findSubtitles();
    await this.#engine.play(0);
  }

  setPlayhead(seconds) {
    if (this.#sink !== null) this.#sink.playhead = seconds;
  }

  async seek(seconds) {
    if (this.#engine === null) return;
    this.setPlayhead(seconds);
    await this.#engine.seek(seconds);
  }

  async chooseAudio(id) {
    if (this.#engine === null) return;
    const ok = await this.#engine.useAudioTrack(id);
    this.#post({ type: "player_audio", id, ok });
  }

  /** Start feeding cues for one subtitle track; zero or a missing number stops the current one. */
  async chooseSubtitles(trackNumber) {
    const run = ++this.#subtitleRun;
    if (this.#layout === null || trackNumber === null) return;
    const track = this.#layout.tracks.find((candidate) => candidate.number === trackNumber);
    if (track === undefined || !track.supported) return;

    this.#post({ type: "cues_reset", track: trackNumber });
    await extractCues(
      this.#store, this.#layout, trackNumber,
      (cues) => this.#post({ type: "cues", track: trackNumber, cues }),
      () => this.#closed || run !== this.#subtitleRun,
    );
  }

  async #findSubtitles() {
    try {
      this.#layout = await readSubtitleTracks(this.#store);
    } catch {
      this.#layout = null;
    }
    const tracks = this.#layout?.tracks ?? [];
    this.#post({ type: "subtitle_tracks", tracks });
    const first = tracks.find((track) => track.supported && track.isDefault)
      ?? tracks.find((track) => track.supported);
    if (first !== undefined) void this.chooseSubtitles(first.number);
  }

  #reportAvailability() {
    const contiguous = this.#store.contiguousFrom(0);
    this.#post({
      type: "availability",
      ranges: this.#store.availableRanges(),
      size: this.#store.size,
      // Enough at the front to be worth pressing play. Reported rather than enforced — a viewer who
      // wants to watch a stuttering stream is allowed to.
      startable: contiguous > 0 && (this.#plan?.duration == null
        ? contiguous > 4 * 1024 * 1024
        : contiguous / this.#store.size * this.#plan.duration > START_SECONDS),
    });
  }

  close() {
    this.#closed = true;
    this.#engine?.stop();
    this.#engine = null;
    this.#sink = null;
  }
}

const describe = (err) => (err instanceof Error ? err.message : String(err));

/** Only what the page needs to draw and explain itself; no track objects, nothing unstructured. */
function summarise(plan) {
  return {
    route: plan.route,
    container: plan.container ?? null,
    duration: plan.duration ?? null,
    mime: plan.mime ?? null,
    reason: plan.reason ?? null,
    audioReason: plan.audioReason ?? null,
    video: plan.video ?? null,
    audios: (plan.audios ?? []).map((audio) => ({
      id: audio.id,
      codec: audio.codec,
      channels: audio.channels,
      sampleRate: audio.sampleRate,
      language: audio.language,
      name: audio.name,
      copy: audio.copy,
      usable: audio.usable,
      encodedAs: audio.encode?.codec ?? null,
      encodedChannels: audio.encode?.numberOfChannels ?? null,
    })),
    audio: plan.audio == null ? null : { id: plan.audio.id, copy: plan.audio.copy },
    encode: plan.encode ?? null,
  };
}
