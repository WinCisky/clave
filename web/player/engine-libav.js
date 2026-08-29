/**
 * Route C: the containers and codecs nothing in the browser has heard of.
 *
 * AVI, ASF/WMV, FLV, MPEG program streams; Xvid and DivX, MPEG-2, WMV3/VC-1, Theora, Cinepak,
 * Sorenson. Chrome decodes none of it and mediabunny parses none of it, so a purpose-built libav.js
 * variant demuxes and decodes here, and the frames are then re-encoded through WebCodecs — in
 * hardware — and muxed by exactly the same fragmented-MP4 path routes A and B use.
 *
 * This is loaded only when the probe asks for it: 3.6 MB of wasm should not be downloaded to watch
 * an ordinary H.264 file, which is nearly all of them.
 *
 * Decoding happens in libav's own worker, so the software decode of a legacy codec does not stall
 * the download's hashing or this worker's message loop. The byte reads it asks for come back here,
 * through the same piece-bitmap gate everything else uses.
 */

import {
  AudioSample,
  AudioSampleSource,
  NullTarget,
  Output,
  QUALITY_HIGH,
  VideoSample,
  VideoSampleSource,
} from "../vendor/mediabunny.min.mjs";
import { concat, fragmentedMp4 } from "./fmp4.js";

const LIBAV_BASE = "../vendor/libav";
const LIBAV_ENTRY = `${LIBAV_BASE}/libav-6.10.9.0-clave-legacy.mjs`;

const FRAGMENT_SECONDS = 0.5;

/** Keyframe spacing for the re-encode, and therefore the seek granularity on this route. */
const KEYFRAME_SECONDS = 2;
const TARGET_BUFFER_SECONDS = 30;
const IDLE_MS = 200;

/**
 * How much of the file to hand libav per demux call.
 *
 * Deliberately small. Four megabytes of Ogg is close to a minute of video, and a whole minute
 * decoded and encoded before the loop next looks at the buffer is both a latency spike and a pile of
 * frames sitting in the encoder queue.
 */
const READ_LIMIT = 1024 * 1024;

const AVMEDIA_TYPE_VIDEO = 0;
const AVMEDIA_TYPE_AUDIO = 1;

/**
 * Codecs this build leaves out on purpose, because the browser decodes them itself in hardware.
 *
 * Reaching route C with one of these means the browser refused it — an HEVC file on a machine with
 * no hardware decoder, say — and there is no second opinion worth offering, since decoding HEVC or
 * AV1 in WebAssembly is far slower than realtime. Asked by name rather than by codec id: the ids
 * are an unstable thing to hardcode, and libav can simply be asked whether it has the decoder.
 */
const BROWSER_ONLY = new Set(["h264", "hevc", "av1", "vp9", "vp8"]);

/**
 * AVPixelFormat to WebCodecs. Only the planar YUV layouts the decoders in this variant actually
 * emit are here; anything else is refused by name rather than rendered as garbage.
 */
const PIXEL_FORMATS = new Map([
  [0, "I420"],   // yuv420p
  [12, "I420"],  // yuvj420p — same layout, full-range
  [4, "I422"],   // yuv422p
  [13, "I422"],  // yuvj422p
  [5, "I444"],   // yuv444p
  [14, "I444"],  // yuvj444p
]);

/** AVSampleFormat to WebCodecs. */
const SAMPLE_FORMATS = new Map([
  [0, "u8"], [1, "s16"], [2, "s32"], [3, "f32"],
  [5, "u8-planar"], [6, "s16-planar"], [7, "s32-planar"], [8, "f32-planar"],
]);

const PLANES = { I420: 3, I422: 3, I444: 3 };

export class LibavEngine {
  #store;
  #plan;
  #sink;
  #onEvent;
  #name;

  #libav = null;
  #format = 0;
  #streams = [];
  #video = null;
  #audio = null;
  #videoDecoder = null;
  #audioDecoder = null;

  #generation = 0;
  #started = false;
  #reportedSize = false;
  #offsetSettled = false;

  constructor({ store, plan, sink, onEvent, name }) {
    this.#store = store;
    this.#plan = plan;
    this.#sink = sink;
    this.#onEvent = onEvent ?? (() => {});
    this.#name = name ?? "input.bin";
  }

  async prepare() {
    const factory = (await import(/* @vite-ignore */ LIBAV_ENTRY)).default;
    // Its own worker: software decode of a legacy codec must not stall this thread, which is also
    // hashing pieces and answering the page.
    this.#libav = await factory.LibAV({ base: new URL(LIBAV_BASE, import.meta.url).href });

    this.#libav.onblockread = (name, position, length) => {
      void this.#store
        .read(position, position + length)
        .then(
          (bytes) => this.#libav.ff_block_reader_dev_send(name, position, bytes),
          // A zero-length send is how libav is told the read failed; it surfaces as a demux error.
          () => this.#libav.ff_block_reader_dev_send(name, position, new Uint8Array(0)),
        );
    };
    await this.#libav.mkblockreaderdev(this.#name, this.#store.size);

    const [format, streams] = await this.#libav.ff_init_demuxer_file(this.#name);
    this.#format = format;
    this.#streams = streams;

    this.#video = streams.find((stream) => stream.codec_type === AVMEDIA_TYPE_VIDEO) ?? null;
    if (this.#video === null) throw new Error("libav found no video stream either");

    if ((await this.#libav.avcodec_find_decoder(this.#video.codec_id)) === 0) {
      const name = await this.#libav.avcodec_get_name(this.#video.codec_id);
      throw new Error(BROWSER_ONLY.has(name)
        ? `this file is ${name.toUpperCase()}, which this browser will not play and which the ` +
          `compatibility decoder deliberately omits — decoding it in WebAssembly would be far ` +
          `slower than realtime. Save the file and play it in a desktop player instead.`
        : `no decoder for ${name} in this build`);
    }

    const audioStreams = streams.filter((stream) => stream.codec_type === AVMEDIA_TYPE_AUDIO);
    this.#audio = audioStreams.find((s) => s.index === this.#plan.audioStreamIndex)
      ?? audioStreams[0] ?? null;

    await this.#openDecoders();
    return this.describe();
  }

  /**
   * How long the film runs, in seconds, or null.
   *
   * Worth asking libav for: Ogg and MPEG program streams declare nothing a container-level metadata
   * read can find, so without this the scrubber has no length and a viewer cannot seek at all.
   */
  async duration() {
    try {
      const low = await this.#libav.AVFormatContext_duration(this.#format);
      const high = await this.#libav.AVFormatContext_durationhi(this.#format);
      const microseconds = this.#libav.i64tof64(low, high);
      if (!Number.isFinite(microseconds) || microseconds <= 0) return null;
      const seconds = microseconds / 1e6;
      return seconds < 1e6 ? seconds : null;
    } catch {
      return null;
    }
  }

  /**
   * What this file actually is, in libav's words.
   *
   * The probe's own description is empty on this route — mediabunny could not read the container,
   * which is why we are here — so without this the panel says "—" and "none" about a file that is
   * playing perfectly well.
   */
  async describe() {
    const name = async (stream) =>
      stream === null ? null : await this.#libav.avcodec_get_name(stream.codec_id).catch(() => null);

    const audioStreams = this.#streams.filter((stream) => stream.codec_type === AVMEDIA_TYPE_AUDIO);
    return {
      video: { codec: await name(this.#video) },
      audio: this.#audio === null ? null : { codec: await name(this.#audio), index: this.#audio.index },
      audioStreams: await Promise.all(audioStreams.map(async (stream) => ({
        index: stream.index,
        codec: await name(stream),
      }))),
    };
  }

  async useAudioTrack(index) {
    const stream = this.#streams.find((candidate) => candidate.index === index);
    if (stream === undefined || stream.codec_type !== AVMEDIA_TYPE_AUDIO) return false;
    this.#audio = stream;
    await this.#closeDecoders();
    await this.#openDecoders();
    await this.seek(this.#sink.playhead);
    return true;
  }

  async play(fromTime = 0) {
    this.#started = true;
    const generation = ++this.#generation;
    await this.#pump(fromTime, generation).catch((err) => {
      if (generation !== this.#generation) return;
      this.#onEvent({ type: "engine_error", message: describe(err) });
    });
  }

  async seek(time) {
    if (!this.#started) return;
    this.#generation++;
    await this.#sink.clear();
    void this.play(time);
  }

  stop() {
    this.#generation++;
    void this.#closeDecoders().catch(() => {});
    this.#libav?.terminate?.();
    this.#libav = null;
  }

  async #openDecoders() {
    const libav = this.#libav;
    const [, vCtx, vPkt, vFrame] = await libav.ff_init_decoder(this.#video.codec_id, this.#video);
    this.#videoDecoder = { ctx: vCtx, pkt: vPkt, frame: vFrame, index: this.#video.index };
    if (this.#audio !== null) {
      const [, aCtx, aPkt, aFrame] = await libav.ff_init_decoder(this.#audio.codec_id, this.#audio);
      this.#audioDecoder = { ctx: aCtx, pkt: aPkt, frame: aFrame, index: this.#audio.index };
    }
  }

  async #closeDecoders() {
    const libav = this.#libav;
    if (libav === null) return;
    for (const decoder of [this.#videoDecoder, this.#audioDecoder]) {
      if (decoder === null) continue;
      await libav.ff_free_decoder(decoder.ctx, decoder.pkt, decoder.frame).catch(() => {});
    }
    this.#videoDecoder = null;
    this.#audioDecoder = null;
  }

  async #pump(fromTime, generation) {
    const libav = this.#libav;
    const segments = fragmentedMp4({ minimumFragmentDuration: FRAGMENT_SECONDS });
    const output = new Output({ format: segments.format, target: new NullTarget() });
    const videoSource = new VideoSampleSource({
      codec: this.#plan.encode.video,
      quality: QUALITY_HIGH,
      // Without this the encoder keyframes far too often and the muxer emits a fragment per frame:
      // 751 moof/mdat pairs for thirty seconds, all header and no payload. Two seconds is also the
      // seek granularity a viewer gets on this route, since a fragment must start on a keyframe.
      keyFrameInterval: KEYFRAME_SECONDS,
      // The transcode has to keep up with playback; quality is the thing to give up, not time.
      latencyMode: "realtime",
    });
    output.addVideoTrack(videoSource);

    const channels = this.#plan.encode.audioChannels ?? 2;
    const audioSource = this.#audioDecoder === null ? null : new AudioSampleSource({
      codec: this.#plan.encode.audio,
      bitrate: channels > 2 ? 384_000 : 160_000,
      // Chrome's Opus encoder refuses 5.1, so the probe picked a channel count it will accept and
      // the downmix happens here rather than the encode failing on the first frame.
      transform: { numberOfChannels: channels },
    });
    if (audioSource !== null) output.addAudioTrack(audioSource);

    if (fromTime > 0) {
      // Approximate: land on the nearest key frame at or before the target and let the decoder
      // catch up. Exact seeking in these containers usually means no index at all.
      const sought = await libav.avformat_seek_file_approx(
        this.#format, -1, Math.round(fromTime * 1_000_000), 0).catch(() => -1);
      if (sought < 0) {
        // Some of these containers carry no index at all. Say so rather than silently restarting
        // from the beginning, which is what happens next.
        this.#onEvent({ type: "seek_unsupported", requested: fromTime });
      }
      await libav.avcodec_flush_buffers(this.#videoDecoder.ctx).catch(() => {});
      if (this.#audioDecoder !== null) {
        await libav.avcodec_flush_buffers(this.#audioDecoder.ctx).catch(() => {});
      }
    }

    await output.start();
    if (generation !== this.#generation) { await output.cancel(); return; }

    let base = null;
    this.#offsetSettled = false;
    let framesEncoded = 0;
    /**
     * Fallback clocks, for streams whose frames carry no usable presentation time at all — which is
     * routine in these containers. They start unset rather than at `fromTime`: seeding them with the
     * requested time while the other stream reports real timestamps from a seek that landed
     * elsewhere pushes the two apart, and an AVI whose audio has no timestamps then plays ten
     * seconds behind its picture.
     */
    let videoClock = null;
    let audioClock = null;
    const startedAt = Date.now();
    let mediaSeconds = 0;
    let finished = false;

    while (!finished) {
      if (generation !== this.#generation) { await output.cancel(); return; }

      const [result, byStream] = await libav.ff_read_frame_multi(
        this.#format, this.#videoDecoder.pkt, { limit: READ_LIMIT });
      // Anything other than "would block" means the file is done.
      finished = result !== -6 /* EAGAIN */;

      // Decode both streams, then feed the muxer in timestamp order.
      //
      // Feeding all of a chunk's video and then all of its audio makes the muxer close a fragment
      // every time the two tracks diverge, which turned thirty seconds into 751 fragments — one per
      // frame, almost all of it box headers. Interleaving is what lets `minimumFragmentDuration`
      // mean anything.
      const decoded = [];

      const videoPackets = decodable(byStream[this.#videoDecoder.index]);
      if (videoPackets.length > 0) {
        const frames = await libav.ff_decode_multi(
          this.#videoDecoder.ctx, this.#videoDecoder.pkt, this.#videoDecoder.frame,
          videoPackets, { fin: finished, ignoreErrors: true, copyoutFrame: "video_packed" });
        for (const frame of frames) {
          const at = secondsOf(libav, frame, this.#video, () => videoClock ?? base ?? 0);
          videoClock = at + 1 / 25;
          if (base === null) base = at;
          if (!this.#reportedSize && frame.width > 0) {
            this.#reportedSize = true;
            this.#onEvent({ type: "video_size", width: frame.width, height: frame.height });
          }
          decoded.push({ at, video: frame });
          mediaSeconds = Math.max(mediaSeconds, at);
        }
      }

      if (this.#audioDecoder !== null) {
        const audioPackets = byStream[this.#audioDecoder.index] ?? [];
        if (audioPackets.length > 0) {
          const frames = await libav.ff_decode_multi(
            this.#audioDecoder.ctx, this.#audioDecoder.pkt, this.#audioDecoder.frame,
            audioPackets, { fin: finished, ignoreErrors: true });
          for (const frame of frames) {
            const at = secondsOf(libav, frame, this.#audio, () => audioClock ?? base ?? 0);
            audioClock = at + (frame.nb_samples ?? 0) / (frame.sample_rate || 48_000);
            if (base === null) base = at;
            decoded.push({ at, audio: frame });
          }
        }
      }

      decoded.sort((left, right) => left.at - right.at);
      for (const item of decoded) {
        if (item.video !== undefined) {
          const sample = this.#toVideoSample(item.video, item.at - base);
          await videoSource.add(sample);
          sample.close();
          framesEncoded++;
        } else {
          const sample = this.#toAudioSample(item.audio, item.at - base);
          if (sample === null) continue;
          await audioSource.add(sample);
          sample.close();
        }
      }

      await this.#drain(segments, base, generation, { framesEncoded, mediaSeconds, fromTime, startedAt });
    }

    await output.finalize();
    if (generation !== this.#generation) return;
    await this.#drain(segments, base, generation, { framesEncoded, mediaSeconds, fromTime, startedAt });
    await this.#sink.end();
    this.#onEvent({ type: "buffer_complete" });
  }

  #toVideoSample(frame, at) {
    const format = PIXEL_FORMATS.get(frame.format);
    if (format === undefined) {
      throw new Error(`this build cannot present pixel format ${frame.format}`);
    }
    const width = frame.width;
    const height = frame.height;
    const data = frame.data instanceof Uint8Array ? frame.data : flatten(frame.data);
    const layout = frame.layout ?? defaultLayout(format, width, height);
    // Through VideoFrame rather than straight to VideoSample: WebCodecs validates the plane layout,
    // and a stride mismatch here is otherwise a silently sheared picture.
    const videoFrame = new VideoFrame(data, {
      format,
      codedWidth: width,
      codedHeight: height,
      timestamp: Math.max(0, Math.round(at * 1e6)),
      layout: layout.slice(0, PLANES[format]),
    });
    return new VideoSample(videoFrame);
  }

  #toAudioSample(frame, at) {
    const format = SAMPLE_FORMATS.get(frame.format);
    if (format === undefined) return null;
    const channels = frame.channels ?? 1;
    const data = frame.data instanceof Float32Array || frame.data instanceof Int16Array
      || frame.data instanceof Int32Array || frame.data instanceof Uint8Array
      ? frame.data
      : flattenSamples(frame.data);
    return new AudioSample({
      data,
      format,
      numberOfChannels: channels,
      sampleRate: frame.sample_rate,
      timestamp: Math.max(0, at),
    });
  }

  /**
   * Append what the muxer has produced, one segment at a time, waiting for room between each.
   *
   * Per segment, not per batch. A single four-megabyte read of an Ogg file yields close to a minute
   * of video, and appending all of it before looking at the buffer overshoots the target by an order
   * of magnitude — which MediaSource eventually answers with `QuotaExceededError`. This is also the
   * only path that appends, so the timeline alignment cannot be skipped by a code path that forgot
   * about it: the final flush after `finalize()` used to be exactly that.
   */
  async #drain(segments, base, generation, progress) {
    for (const segment of segments.take()) {
      if (generation !== this.#generation) return;
      if (!segment.init) {
        if (!this.#offsetSettled && base !== null) {
          this.#offsetSettled = true;
          await this.#sink.alignTo(base, segment.timestamp);
          this.#onEvent({ type: "aligned", base, fragment: segment.timestamp });
        }
        await this.#waitForRoom(generation);
      }
      await this.#sink.append(concat(segment.parts));
    }

    const elapsed = (Date.now() - progress.startedAt) / 1000;
    this.#onEvent({
      type: "transcode",
      framesEncoded: progress.framesEncoded,
      // How many seconds of film are produced per second of wall clock. Below 1 and playback will
      // eventually catch up with the transcoder, which is worth saying out loud.
      speed: elapsed > 0 ? (progress.mediaSeconds - progress.fromTime) / elapsed : 0,
      ahead: this.#sink.aheadOf(this.#sink.playhead),
    });
  }

  async #waitForRoom(generation) {
    while (generation === this.#generation &&
           this.#sink.aheadOf(this.#sink.playhead) > TARGET_BUFFER_SECONDS) {
      await this.#sink.evict();
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    }
  }
}

/**
 * When a frame's presentation time is missing or nonsense, fall back to counting.
 *
 * Two traps here, both found the hard way.
 *
 * The first: a decoded frame does not necessarily carry a usable time base. The AVI/MPEG-4 decoder
 * reports `0/1`, so scaling its pts by the frame's own time base multiplies by zero and every frame
 * in the file lands at t=0. The stream's time base is the authority; the frame's is a hint. (An
 * Xvid file seeking to ten seconds reported pts 240 with time base 0/1 — 240 ticks of the stream's
 * 1/25 is exactly the 9.6s its audio agreed on.)
 *
 * The second: `AV_NOPTS_VALUE` is INT64_MIN, which arrives as roughly -9.2e18 and, handed to
 * WebCodecs, throws "value is outside the long long range" — which is what a WMV file does on its
 * very first audio frame. Legacy containers are full of streams with no timestamps at all, so the
 * clock has to be able to run on its own.
 */
/**
 * Drop empty packets before they reach a decoder.
 *
 * A zero-length packet is how Theora encodes "this frame is identical to the last one", and plenty
 * of real files are full of them. `avcodec_send_packet` reads a zero-size packet as the *drain*
 * signal instead, so the decoder finishes, and every packet after it comes back `AVERROR_EOF`. The
 * symptom is a video track exactly one frame long while audio decodes for minutes: the SourceBuffer
 * reports the intersection of its tracks, so it shows nothing buffered, nothing throttles the pump,
 * and the buffer fills with audio until MediaSource refuses it. Skipping them is also correct on the
 * merits — the following packet's timestamp already accounts for the repeated frame's duration.
 */
const decodable = (packets) => (packets ?? []).filter((packet) => (packet.data?.length ?? 0) > 0);

function secondsOf(libav, frame, stream, clock) {
  // A time base is a pair, and has to be taken as one. The AVI decoder reports `0/1`, so picking
  // the numerator and denominator independently takes 1 from the stream and 1 from the frame and
  // yields raw ticks: every frame of a 25 fps file lands a whole second apart, which then makes the
  // encoder emit a keyframe for almost every frame.
  const usable = frame.time_base_num > 0 && frame.time_base_den > 0;
  const num = usable ? frame.time_base_num : (stream?.time_base_num || 1);
  const den = usable ? frame.time_base_den : (stream?.time_base_den || 1_000_000);

  for (const [lo, hi] of [
    [frame.best_effort_timestamp, frame.best_effort_timestamphi],
    [frame.pts, frame.ptshi],
  ]) {
    if (lo === undefined || lo === null) continue;
    const ticks = libav.i64tof64(lo, hi ?? 0);
    const seconds = (ticks * num) / den;
    // Anything beyond a few days is not a timestamp, it is a sentinel.
    if (Number.isFinite(seconds) && Math.abs(seconds) < 1e6) return seconds;
  }
  return clock();
}

function defaultLayout(format, width, height) {
  const chromaWidth = format === "I444" ? width : Math.ceil(width / 2);
  const chromaHeight = format === "I420" ? Math.ceil(height / 2) : height;
  const luma = width * height;
  const chroma = chromaWidth * chromaHeight;
  return [
    { offset: 0, stride: width },
    { offset: luma, stride: chromaWidth },
    { offset: luma + chroma, stride: chromaWidth },
  ];
}

function flatten(planes) {
  let total = 0;
  for (const plane of planes) total += plane.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const plane of planes) {
    out.set(plane, at);
    at += plane.length;
  }
  return out;
}

/** Planar audio arrives as one typed array per channel; WebCodecs wants them end to end. */
function flattenSamples(planes) {
  const first = planes[0];
  const Type = first.constructor;
  const out = new Type(planes.reduce((total, plane) => total + plane.length, 0));
  let at = 0;
  for (const plane of planes) {
    out.set(plane, at);
    at += plane.length;
  }
  return out;
}


const describe = (err) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
