/**
 * Turning mediabunny's fragmented-MP4 callbacks into MediaSource segments.
 *
 * The muxer reports boxes as it writes them: `ftyp`, then `moov`, then a `moof`/`mdat` pair per
 * fragment. MSE wants those grouped — `ftyp` + `moov` is the init segment, and each `moof` + `mdat`
 * is a media segment — and it wants them **in emission order**.
 *
 * The order is the part that is easy to get wrong. `moov` is not written when `output.start()`
 * resolves; it appears later, once the first packets have been muxed and the muxer knows what the
 * tracks contain. Appending whatever had accumulated by the time `start()` returned therefore
 * produced an init segment of `ftyp` alone — 28 bytes — and silently dropped the `moov`, leaving
 * every fragment referring to tracks the SourceBuffer had never been told about. It looked like it
 * was working: segments were produced, byte counts were plausible, nothing threw. It only showed up
 * when the output was handed to a real demuxer, which said `trun track id unknown, no tfhd was
 * found`. Hence: collect, never assume, and emit strictly in the order the muxer wrote.
 */

import { Mp4OutputFormat } from "../vendor/mediabunny.min.mjs";

/**
 * The grouping itself, with no muxer attached, so it can be exercised directly.
 */
export function segmentCollector() {
  /** Segments ready to append, oldest first. */
  const ready = [];
  let head = [];
  let fragment = null;

  return {
    handlers: {
      // Every callback hands out a view the muxer may reuse, so all of these are copies.
      onFtyp: (data) => head.push(data.slice()),
      onMoov: (data) => {
        head.push(data.slice());
        ready.push({ init: true, timestamp: null, parts: head });
        head = [];
      },
      onMoof: (data, _position, timestamp) => {
        fragment = { init: false, timestamp, parts: [data.slice()] };
      },
      onMdat: (data) => {
        // An `mdat` with no `moof` before it is not a media segment and must not be appended alone.
        if (fragment === null) return;
        fragment.parts.push(data.slice());
        ready.push(fragment);
        fragment = null;
      },
    },
    /** Everything complete so far, in order. */
    take() {
      return ready.splice(0);
    },
    get pending() {
      return ready.length;
    },
  };
}

export function fragmentedMp4({ minimumFragmentDuration = 0.5 } = {}) {
  const collector = segmentCollector();
  const format = new Mp4OutputFormat({
    fastStart: "fragmented",
    minimumFragmentDuration,
    ...collector.handlers,
  });
  return { format, take: () => collector.take(), get pending() { return collector.pending; } };
}

export function concat(parts) {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
