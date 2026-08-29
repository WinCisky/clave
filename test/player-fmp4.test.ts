/**
 * Grouping the muxer's boxes into MediaSource segments.
 *
 * This looked correct for a long time while being wrong. The muxer does not write `moov` before
 * `output.start()` resolves — it appears later, once the first packets have gone through — so
 * appending whatever had accumulated by then produced an init segment of `ftyp` alone. Twenty-eight
 * bytes. Nothing threw, segment counts were plausible, byte totals were plausible, and every
 * fragment afterwards referred to tracks the SourceBuffer had never been told about. It took handing
 * the output to a real demuxer, which said `trun track id unknown, no tfhd was found`, to see it.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JavaScript, exactly as the browser loads it.
import { concat, segmentCollector } from "../web/player/fmp4.js";

const box = (name: string, fill: number, length = 8) => {
  const out = new Uint8Array(length).fill(fill);
  out.set(new TextEncoder().encode(name.slice(0, 4)), 0);
  return out;
};

describe("segment grouping", () => {
  it("waits for moov before calling the init segment complete", () => {
    const { handlers, take } = segmentCollector();
    handlers.onFtyp(box("ftyp", 1));
    // `moov` has not arrived, so there is nothing to append yet — appending now is the bug.
    expect(take()).toEqual([]);

    handlers.onMoov(box("moov", 2));
    const [init] = take();
    expect(init.init).toBe(true);
    expect(init.parts).toHaveLength(2);
    expect(concat(init.parts)).toHaveLength(16);
  });

  it("pairs each moof with the mdat that follows it", () => {
    const { handlers, take } = segmentCollector();
    handlers.onFtyp(box("ftyp", 1));
    handlers.onMoov(box("moov", 2));
    take();

    handlers.onMoof(box("moof", 3), 0, 1.5);
    expect(take()).toEqual([]); // incomplete until its mdat arrives
    handlers.onMdat(box("mdat", 4));

    const [fragment] = take();
    expect(fragment).toMatchObject({ init: false, timestamp: 1.5 });
    expect(fragment.parts).toHaveLength(2);
  });

  it("keeps segments in the order the muxer wrote them", () => {
    const { handlers, take } = segmentCollector();
    handlers.onFtyp(box("ftyp", 1));
    handlers.onMoov(box("moov", 2));
    handlers.onMoof(box("moof", 3), 0, 0);
    handlers.onMdat(box("mdat", 4));
    handlers.onMoof(box("moof", 5), 0, 0.5);
    handlers.onMdat(box("mdat", 6));

    const segments = take();
    expect(segments.map((segment: { init: boolean }) => segment.init)).toEqual([true, false, false]);
    expect(segments.map((segment: { timestamp: number }) => segment.timestamp)).toEqual([null, 0, 0.5]);
  });

  it("copies the muxer's buffers, which it is free to reuse", () => {
    const { handlers, take } = segmentCollector();
    const reused = box("ftyp", 1);
    handlers.onFtyp(reused);
    handlers.onMoov(box("moov", 2));
    const [init] = take();
    reused.fill(0xff);
    expect(init.parts[0][4]).toBe(1);
  });

  it("drops an mdat with no moof before it rather than appending it alone", () => {
    const { handlers, take } = segmentCollector();
    handlers.onFtyp(box("ftyp", 1));
    handlers.onMoov(box("moov", 2));
    take();
    handlers.onMdat(box("mdat", 9));
    expect(take()).toEqual([]);
  });

  it("empties itself when taken, so nothing is appended twice", () => {
    const { handlers, take } = segmentCollector();
    handlers.onFtyp(box("ftyp", 1));
    handlers.onMoov(box("moov", 2));
    expect(take()).toHaveLength(1);
    expect(take()).toHaveLength(0);
  });
});

describe("concat", () => {
  it("returns the single part untouched", () => {
    const only = box("moof", 7);
    expect(concat([only])).toBe(only);
  });

  it("joins parts end to end in order", () => {
    const joined = concat([box("moof", 3, 4), box("mdat", 4, 4)]);
    expect(joined).toHaveLength(8);
    expect(new TextDecoder().decode(joined.subarray(0, 4))).toBe("moof");
    expect(new TextDecoder().decode(joined.subarray(4, 8))).toBe("mdat");
  });
});
