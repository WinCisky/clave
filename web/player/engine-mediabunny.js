/**
 * Routes A and B: read packets, mux fragmented MP4, hand the fragments to MediaSource.
 *
 * The video is *copied* — demuxed out of whatever container it arrived in and remuxed into fMP4
 * without ever being decoded. That is what makes this fast enough to outrun playback on any machine:
 * the expensive part of video is decoding, and the browser is going to do that anyway, in hardware,
 * after the append. Only audio is ever decoded here, and only when the browser has no decoder for it.
 *
 * Fragments come out of mediabunny as `moof` + `mdat` pairs through the output format's callbacks,
 * which is exactly the shape MSE consumes: `ftyp` + `moov` is the init segment, and each `moof` +
 * `mdat` is a media segment.
 */

import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  NullTarget,
  Output,
} from "../vendor/mediabunny.min.mjs";
import { concat, fragmentedMp4 } from "./fmp4.js";

/** Stop feeding the buffer once this many seconds are ready ahead of the playhead. */
const TARGET_BUFFER_SECONDS = 30;

/** Fragment length. Short enough that playback can start quickly, long enough not to be all header. */
const FRAGMENT_SECONDS = 0.5;

/** How long to sit still when the buffer is full before checking again. */
const IDLE_MS = 200;

export class MediabunnyEngine {
  #source;
  #plan;
  #sink;
  #onEvent;

  #input = null;
  #videoTrack = null;
  #audioTrack = null;

  /** Bumped on every seek and on stop; a pump whose generation is stale exits at its next check. */
  #generation = 0;
  #started = false;

  constructor({ source, plan, sink, onEvent }) {
    this.#source = source;
    this.#plan = plan;
    this.#sink = sink;
    this.#onEvent = onEvent ?? (() => {});
  }

  async prepare() {
    this.#input = new Input({ source: this.#source, formats: ALL_FORMATS });
    this.#videoTrack = (await this.#input.getVideoTracks())[0] ?? null;
    if (this.#videoTrack === null) throw new Error("no video track");

    if (this.#plan.audio != null) {
      const tracks = await this.#input.getAudioTracks();
      this.#audioTrack = tracks.find((track) => track.id === this.#plan.audio.id) ?? null;
    }
  }

  /** Switch to a different audio track without disturbing the video. Re-pumps from the playhead. */
  async useAudioTrack(id) {
    const tracks = await this.#input.getAudioTracks();
    const track = tracks.find((candidate) => candidate.id === id);
    if (track === undefined) return false;
    this.#audioTrack = track;
    await this.seek(this.#sink.playhead);
    return true;
  }

  async play(fromTime = 0) {
    this.#started = true;
    const generation = ++this.#generation;
    await this.#pump(fromTime, generation).catch((err) => {
      if (generation !== this.#generation) return; // superseded by a seek; its error is irrelevant
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
    this.#input?.dispose();
    this.#input = null;
  }

  async #pump(fromTime, generation) {
    const segments = fragmentedMp4({ minimumFragmentDuration: FRAGMENT_SECONDS });
    const output = new Output({ format: segments.format, target: new NullTarget() });

    const videoSource = new EncodedVideoPacketSource(this.#videoTrack.codec);
    output.addVideoTrack(videoSource, { languageCode: this.#videoTrack.languageCode ?? undefined });

    // Where the video will really begin: the key packet at or before the requested time. Audio has
    // to start there too — asking it for `fromTime` instead leaves the sound seconds ahead of the
    // picture for the whole run, because a seek lands on the key packet *before* the target.
    const videoSink = new EncodedPacketSink(this.#videoTrack);
    const firstVideo = fromTime > 0
      ? await videoSink.getKeyPacket(fromTime)
      : await videoSink.getFirstPacket();
    const audio = await this.#openAudio(output, firstVideo?.timestamp ?? 0);

    await output.start();
    if (generation !== this.#generation) { await output.cancel(); return; }

    const videoConfig = await this.#videoTrack.getDecoderConfig();
    const video = packetsFrom(videoSink, firstVideo);
    let videoFirst = true;

    let v = await video.next();
    let a = audio === null ? { done: true } : await audio.items.next();

    // The muxer refuses negative timestamps, and real files routinely start below zero — an MP4's
    // AAC track carries encoder delay as a negative first timestamp. Everything is therefore shifted
    // so the muxer's timeline starts at zero, and `alignTo` puts it back where the viewer asked for
    // it using the SourceBuffer's own offset.
    const earliest = Math.min(
      v.done ? Infinity : v.value.timestamp,
      a.done ? Infinity : a.value.timestamp,
    );
    // `base` is where this run really starts on the film's timeline — a seek lands on the key packet
    // at or before the target, which is usually a little earlier than asked for. Feeding it to
    // `alignTo` puts the fragments back at their true times instead of at the requested one.
    const base = Number.isFinite(earliest) ? earliest : 0;

    // The muxer places fragments at the timestamps it is given, but whether those are the source's
    // absolute timestamps or rebased to zero is not something to assume — so it is measured from the
    // first fragment and corrected with the SourceBuffer's own offset.
    let offsetSettled = false;

    while (!v.done || !a.done) {
      if (generation !== this.#generation) { await output.cancel(); return; }

      const takeAudio = !a.done && (v.done || a.value.timestamp <= v.value.timestamp);
      if (takeAudio) {
        await audio.add(a.value, base);
        a = await audio.items.next();
      } else {
        const packet = base === 0 ? v.value : v.value.clone({ timestamp: v.value.timestamp - base });
        await videoSource.add(packet, videoFirst ? { decoderConfig: videoConfig } : undefined);
        videoFirst = false;
        v = await video.next();
      }

      const produced = segments.take();
      if (produced.length > 0) {
        for (const segment of produced) {
          // The offset that puts this run back on the film's timeline can only be measured from the
          // first real fragment, and must be set before that fragment is appended.
          if (!segment.init && !offsetSettled) {
            offsetSettled = true;
            await this.#sink.alignTo(base, segment.timestamp);
          }
          await this.#sink.append(concat(segment.parts));
        }
        this.#onEvent({ type: "buffer", ahead: this.#sink.aheadOf(this.#sink.playhead) });
        await this.#waitForRoom(generation);
      }
    }

    await output.finalize();
    if (generation !== this.#generation) return;
    for (const segment of segments.take()) await this.#sink.append(concat(segment.parts));
    await this.#sink.end();
    this.#onEvent({ type: "buffer_complete" });
  }

  /** Either copy the audio packets through, or decode and re-encode them. */
  async #openAudio(output, fromTime) {
    const track = this.#audioTrack;
    const plan = this.#plan.audio;
    if (track === null || plan == null) return null;

    if (plan.copy) {
      const source = new EncodedAudioPacketSource(track.codec);
      output.addAudioTrack(source, { languageCode: track.languageCode ?? undefined });
      const config = await track.getDecoderConfig();
      const sink = new EncodedPacketSink(track);
      let first = true;
      return {
        items: packets(sink, fromTime),
        add: async (packet, base) => {
          const shifted = base === 0 ? packet : packet.clone({ timestamp: packet.timestamp - base });
          await source.add(shifted, first ? { decoderConfig: config } : undefined);
          first = false;
        },
      };
    }

    const source = new AudioSampleSource({
      codec: plan.encode.codec,
      // Opus rejects 192 kbps for stereo in Chrome's encoder; this is a sane rate for both codecs.
      bitrate: plan.encode.numberOfChannels > 2 ? 384_000 : 160_000,
      // A downmix is chosen in the probe when the encoder cannot manage the source's channel count.
      transform: plan.encode.numberOfChannels !== plan.channels
        ? { numberOfChannels: plan.encode.numberOfChannels }
        : undefined,
    });
    output.addAudioTrack(source, { languageCode: track.languageCode ?? undefined });
    const sink = new AudioSampleSink(track);
    return {
      items: sink.samples(fromTime),
      add: async (sample, base) => {
        if (base !== 0) sample.setTimestamp(sample.timestamp - base);
        await source.add(sample);
        sample.close();
      },
    };
  }

  /** Hold off while the buffer is comfortably ahead. The download is unaffected; only muxing pauses. */
  async #waitForRoom(generation) {
    while (generation === this.#generation &&
           this.#sink.aheadOf(this.#sink.playhead) > TARGET_BUFFER_SECONDS) {
      await this.#sink.evict();
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    }
  }
}

/** Every packet of a track from `from` onwards, starting at the key packet that covers it. */
async function* packets(sink, from) {
  const first = from > 0 ? await sink.getKeyPacket(from) : await sink.getFirstPacket();
  yield* packetsFrom(sink, first);
}

async function* packetsFrom(sink, first) {
  let packet = first;
  while (packet !== null) {
    yield packet;
    packet = await sink.getNextPacket(packet);
  }
}


const describe = (err) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
