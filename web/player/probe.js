/**
 * Work out how — or whether — this file can be played, once, before any bytes are muxed.
 *
 * There are only four answers, and the point of deciding up front is that the third and fourth are
 * as useful as the first two. A file that cannot play should say which codec, in which container,
 * and what this particular browser is missing; "playback error" is not an answer anyone can act on.
 */

import { Input, ALL_FORMATS, canEncodeAudio, canEncodeVideo } from "../vendor/mediabunny.min.mjs";

export const ROUTE = {
  /** Copy both streams into fMP4. No decode, no encode. */
  COPY: "copy",
  /** Copy the video, decode and re-encode the audio Chrome cannot decode. */
  AUDIO: "transcode-audio",
  /** libav demuxes and decodes, WebCodecs re-encodes. Containers or codecs mediabunny has no idea about. */
  LEGACY: "legacy",
  /** Nothing here can be played. */
  NONE: "unplayable",
};

/** Audio codecs that need a wasm decoder because no browser ships one. */
const DECODER_EXTENSIONS = {
  ac3: ["../vendor/mediabunny-ac3.min.mjs", "registerAc3Decoder"],
  eac3: ["../vendor/mediabunny-ac3.min.mjs", "registerAc3Decoder"],
  dts: ["../vendor/mediabunny-dts.min.mjs", "registerDtsDecoder"],
};

const AAC_ENCODER_EXTENSION = ["../vendor/mediabunny-aac-encoder.min.mjs", "registerAacEncoder"];

const registered = new Set();

/** Load and register a codec extension once. They are 1–1.6 MB each, so never speculatively. */
async function register([path, fn]) {
  if (registered.has(path)) return true;
  try {
    const module = await import(/* @vite-ignore */ path);
    module[fn]();
    registered.add(path);
    return true;
  } catch {
    return false;
  }
}

export const mp4MimeFor = (codecs) => `video/mp4; codecs="${codecs.filter(Boolean).join(",")}"`;

const playable = (mime) => {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
};

/**
 * Everything the page needs to explain itself, and everything the engine needs to start.
 *
 * `source` is a mediabunny Source; the legacy route gets handed the raw byte store instead, because
 * libav does its own I/O.
 */
export async function probeFile(source) {
  const input = new Input({ source, formats: ALL_FORMATS });

  let container = null;
  try {
    container = (await input.getFormat()).name;
  } catch (err) {
    input.dispose();
    return {
      route: ROUTE.LEGACY,
      container: null,
      reason: `not a container mediabunny understands (${describe(err)})`,
    };
  }

  const videoTracks = await input.getVideoTracks();
  const audioTracks = await input.getAudioTracks();
  const video = videoTracks[0] ?? null;

  const duration = await durationOf(input);

  if (video === null || video.codec === null) {
    input.dispose();
    return {
      route: ROUTE.LEGACY,
      container,
      duration,
      reason: video === null
        ? `${container} holds no video track mediabunny recognises`
        : `${container} video track uses a codec mediabunny does not know`,
    };
  }

  const videoParam = await video.getCodecParameterString();
  const videoOk = videoParam !== null && playable(mp4MimeFor([videoParam]));

  const videoInfo = {
    codec: video.codec,
    parameter: videoParam,
    width: await video.getDisplayWidth?.() ?? await video.getCodedWidth(),
    height: await video.getDisplayHeight?.() ?? await video.getCodedHeight(),
    rotation: await video.getRotation(),
  };

  if (!videoOk) {
    input.dispose();
    return {
      route: ROUTE.LEGACY,
      container,
      duration,
      video: videoInfo,
      reason: videoParam === null
        ? `the video track's codec parameters could not be read`
        : `this browser will not play ${videoParam} in MP4` +
          (video.codec === "hevc" ? " — HEVC needs a hardware decoder the browser can reach" : ""),
    };
  }

  const audios = [];
  for (const track of audioTracks) {
    audios.push(await describeAudio(track, videoParam));
  }

  // Prefer a track that needs no work, then one that only needs re-encoding. A TrueHD remux almost
  // always carries an AC-3 companion, and taking it beats refusing the file.
  const chosen =
    audios.find((a) => a.usable && a.copy) ??
    audios.find((a) => a.usable) ??
    null;

  input.dispose();

  if (audioTracks.length > 0 && chosen === null) {
    return {
      route: ROUTE.LEGACY,
      container,
      duration,
      video: videoInfo,
      audios,
      reason: "no audio track here can be decoded, natively or in wasm",
    };
  }

  return {
    route: chosen === null || chosen.copy ? ROUTE.COPY : ROUTE.AUDIO,
    container,
    duration,
    video: videoInfo,
    audios,
    audio: chosen,
    mime: mp4MimeFor([videoParam, chosen?.outputParameter ?? null]),
  };
}

/**
 * What route C should re-encode into.
 *
 * The video codec has to be one this browser can both encode in hardware and play back from an MP4,
 * which in practice means H.264 and, failing that, VP9. Audio follows the same rule as route B.
 */
export async function planLegacyEncoders() {
  let video = null;
  for (const [codec, parameter] of [["avc", "avc1.42E01E"], ["vp9", "vp09.00.10.08"]]) {
    if (!playable(mp4MimeFor([parameter]))) continue;
    if (!(await canEncodeVideo(codec))) continue;
    video = { codec, parameter };
    break;
  }
  if (video === null) {
    return { ok: false, reason: "this browser has no video encoder that can produce a playable MP4" };
  }

  const audio = await pickEncoder(2, 48_000, video.parameter);
  return {
    ok: true,
    video: video.codec,
    audio: audio?.codec ?? null,
    audioChannels: audio?.numberOfChannels ?? null,
    mime: mp4MimeFor([video.parameter, audio?.parameter ?? null]),
    reason: audio === null ? "no audio encoder is available; the transcode will be silent" : null,
  };
}

async function describeAudio(track, videoParam) {
  const parameter = await track.getCodecParameterString();
  const channels = await track.getNumberOfChannels();
  const sampleRate = await track.getSampleRate();
  const info = {
    id: track.id,
    codec: track.codec,
    parameter,
    channels,
    sampleRate,
    language: await track.getLanguageCode(),
    name: await track.getName(),
    copy: false,
    usable: false,
    outputParameter: parameter,
    encode: null,
  };

  if (parameter !== null && playable(mp4MimeFor([videoParam, parameter]))) {
    info.copy = true;
    info.usable = true;
    return info;
  }

  // Not playable as-is, so it has to be decoded here and re-encoded into something that is.
  const extension = DECODER_EXTENSIONS[track.codec ?? ""];
  if (extension !== undefined) await register(extension);
  if (!(await track.canDecode())) return info;

  const encode = await pickEncoder(channels, sampleRate, videoParam);
  if (encode === null) return info;

  info.usable = true;
  info.encode = encode;
  info.outputParameter = encode.parameter;
  return info;
}

/**
 * Choose what to re-encode audio into.
 *
 * AAC first because it is the safest thing to put in an MP4 — but Chrome ships no AAC *encoder* on
 * desktop Linux, so the wasm one and then Opus stand behind it. Multichannel is attempted before
 * stereo, and the fallback to a downmix is deliberate: two channels that play beat six that do not.
 */
async function pickEncoder(channels, sampleRate, videoParam) {
  const candidates = [
    { codec: "aac", parameter: "mp4a.40.2", extension: null },
    { codec: "aac", parameter: "mp4a.40.2", extension: AAC_ENCODER_EXTENSION },
    { codec: "opus", parameter: "opus", extension: null },
  ];

  for (const candidate of candidates) {
    if (!playable(mp4MimeFor([videoParam, candidate.parameter]))) continue;
    if (candidate.extension !== null && !(await register(candidate.extension))) continue;

    for (const numberOfChannels of channels > 2 ? [channels, 2] : [channels]) {
      if (await canEncodeAudio(candidate.codec, { numberOfChannels, sampleRate })) {
        return { codec: candidate.codec, parameter: candidate.parameter, numberOfChannels, sampleRate };
      }
    }
  }
  return null;
}

/**
 * Duration from whatever the container declares.
 *
 * Never `computeDuration()`: that walks every packet, and walking a file we hold only part of would
 * block on bytes nobody has asked for yet. An estimate that is a little wrong is recoverable —
 * MediaSource.duration can be raised later — where a deadlock is not.
 */
async function durationOf(input) {
  try {
    const declared = await input.getDurationFromMetadata();
    if (typeof declared === "number" && declared > 0) return declared;
  } catch {
    // Fall through to the estimate.
  }
  return null;
}

const describe = (err) => (err instanceof Error ? err.message : String(err));
