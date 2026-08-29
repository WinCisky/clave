/**
 * The Matroska text-subtitle reader.
 *
 * mediabunny reads no subtitle tracks at all — subtitles are output-only there — so this parser is
 * the only path to embedded text subtitles, and it walks a container format by hand. The documents
 * below are built byte by byte rather than loaded from a fixture, so each test states exactly which
 * structure it is about: an unknown-size Segment, a BlockGroup with an explicit duration, a bare
 * SimpleBlock with none, a styled track that must be listed but skipped.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JavaScript, exactly as the browser loads it.
import { extractCues, looksLikeMatroska, readSubtitleTracks, toVtt } from "../web/player/subtitles.js";

// ---- a very small EBML writer, enough to build documents to parse back -------------------------

const bytes = (...values: number[]) => Uint8Array.from(values);

/** An EBML size, in the fewest bytes that will hold it. */
function size(value: number): Uint8Array {
  if (value < 0x7f) return bytes(0x80 | value);
  if (value < 0x3fff) return bytes(0x40 | (value >> 8), value & 0xff);
  return bytes(0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff);
}

const UNKNOWN_SIZE = bytes(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** An element whose id is given as its raw bytes, since EBML ids carry their own length marker. */
function element(id: number[], body: Uint8Array, unknownSize = false): Uint8Array {
  return join(Uint8Array.from(id), unknownSize ? UNKNOWN_SIZE : size(body.length), body);
}

const uint = (value: number): Uint8Array => {
  const out: number[] = [];
  let rest = value;
  do { out.unshift(rest & 0xff); rest = Math.floor(rest / 256); } while (rest > 0);
  return Uint8Array.from(out);
};

const text = (value: string) => new TextEncoder().encode(value);

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  SEGMENT: [0x18, 0x53, 0x80, 0x67],
  INFO: [0x15, 0x49, 0xa9, 0x66],
  TIMESTAMP_SCALE: [0x2a, 0xd7, 0xb1],
  TRACKS: [0x16, 0x54, 0xae, 0x6b],
  TRACK_ENTRY: [0xae],
  TRACK_NUMBER: [0xd7],
  TRACK_TYPE: [0x83],
  CODEC_ID: [0x86],
  LANGUAGE: [0x22, 0xb5, 0x9c],
  NAME: [0x53, 0x6e],
  FLAG_DEFAULT: [0x88],
  CLUSTER: [0x1f, 0x43, 0xb6, 0x75],
  CLUSTER_TIMESTAMP: [0xe7],
  SIMPLE_BLOCK: [0xa3],
  BLOCK_GROUP: [0xa0],
  BLOCK: [0xa1],
  BLOCK_DURATION: [0x9b],
};

function track(number: number, codec: string, options: { language?: string; name?: string; isDefault?: boolean } = {}) {
  return element(ID.TRACK_ENTRY, join(
    element(ID.TRACK_NUMBER, uint(number)),
    element(ID.TRACK_TYPE, uint(0x11)), // subtitle
    element(ID.CODEC_ID, text(codec)),
    element(ID.LANGUAGE, text(options.language ?? "und")),
    ...(options.name === undefined ? [] : [element(ID.NAME, text(options.name))]),
    element(ID.FLAG_DEFAULT, uint(options.isDefault ? 1 : 0)),
  ));
}

/** Track number, a signed 16-bit offset from the cluster's timestamp, flags, then the payload. */
function block(trackNumber: number, relative: number, payload: string) {
  const signed = relative < 0 ? relative + 0x10000 : relative;
  return join(bytes(0x80 | trackNumber, (signed >> 8) & 0xff, signed & 0xff, 0x00), text(payload));
}

function document(options: { tracks: Uint8Array[]; clusters: Uint8Array[]; unknownSegment?: boolean }) {
  return join(
    element(ID.EBML, join(element([0x42, 0x86], uint(1)))),
    element(ID.SEGMENT, join(
      element(ID.INFO, element(ID.TIMESTAMP_SCALE, uint(1_000_000))),
      element(ID.TRACKS, join(...options.tracks)),
      ...options.clusters,
    ), options.unknownSegment),
  );
}

const store = (data: Uint8Array) => ({
  size: data.length,
  read: async (start: number, end: number) => data.subarray(start, end),
});

// ---- tests ------------------------------------------------------------------------------------

describe("recognising the container", () => {
  it("accepts the EBML magic and rejects anything else", () => {
    expect(looksLikeMatroska(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x00))).toBe(true);
    expect(looksLikeMatroska(text("ftypisom"))).toBe(false);
    expect(looksLikeMatroska(bytes(0x1a, 0x45))).toBe(false);
  });

  it("returns null for a file that is not Matroska, rather than failing", async () => {
    await expect(readSubtitleTracks(store(text("this is not a container at all")))).resolves.toBeNull();
  });
});

describe("finding the subtitle tracks", () => {
  it("lists text tracks as usable and styled ones as skipped", async () => {
    const data = document({
      tracks: [
        track(3, "S_TEXT/UTF8", { language: "eng", name: "English", isDefault: true }),
        track(4, "S_TEXT/ASS", { language: "jpn" }),
      ],
      clusters: [element(ID.CLUSTER, element(ID.CLUSTER_TIMESTAMP, uint(0)))],
    });

    const layout = await readSubtitleTracks(store(data));
    expect(layout.tracks).toHaveLength(2);
    expect(layout.tracks[0]).toMatchObject({
      number: 3, codec: "S_TEXT/UTF8", language: "eng", name: "English",
      isDefault: true, supported: true, styled: false,
    });
    // Styled subtitles need a renderer this page does not have, so they are named, not dropped.
    expect(layout.tracks[1]).toMatchObject({ number: 4, supported: false, styled: true });
  });

  it("reads the timestamp scale, which everything else is measured in", async () => {
    const data = document({ tracks: [track(1, "S_TEXT/UTF8")], clusters: [] });
    const layout = await readSubtitleTracks(store(data));
    expect(layout.timestampScale).toBe(1_000_000);
  });
});

describe("reading cues", () => {
  const cluster = element(ID.CLUSTER, join(
    element(ID.CLUSTER_TIMESTAMP, uint(1000)),
    element(ID.BLOCK_GROUP, join(
      element(ID.BLOCK, block(1, 500, "with an explicit duration")),
      element(ID.BLOCK_DURATION, uint(2000)),
    )),
    // A block for a different track, which must be ignored entirely.
    element(ID.BLOCK_GROUP, join(
      element(ID.BLOCK, block(2, 500, "another track")),
      element(ID.BLOCK_DURATION, uint(2000)),
    )),
    element(ID.SIMPLE_BLOCK, block(1, 3000, "with no duration")),
  ));

  it("times cues from the cluster timestamp plus the block's own offset", async () => {
    const data = document({ tracks: [track(1, "S_TEXT/UTF8"), track(2, "S_TEXT/UTF8")], clusters: [cluster] });
    const layout = await readSubtitleTracks(store(data));
    const cues: { start: number; end: number; text: string }[] = [];
    await extractCues(store(data), layout, 1, (batch: typeof cues) => cues.push(...batch));

    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1.5, end: 3.5, text: "with an explicit duration" });
    // A subtitle with no duration is a broken file, not one that lasts forever.
    expect(cues[1]).toMatchObject({ start: 4, end: 6, text: "with no duration" });
  });

  it("ignores blocks belonging to other tracks", async () => {
    const data = document({ tracks: [track(1, "S_TEXT/UTF8"), track(2, "S_TEXT/UTF8")], clusters: [cluster] });
    const layout = await readSubtitleTracks(store(data));
    const cues: { text: string }[] = [];
    await extractCues(store(data), layout, 2, (batch: typeof cues) => cues.push(...batch));
    expect(cues.map((cue) => cue.text)).toEqual(["another track"]);
  });

  it("stops when asked to, so switching tracks does not leave a walk running", async () => {
    const data = document({ tracks: [track(1, "S_TEXT/UTF8")], clusters: [cluster] });
    const layout = await readSubtitleTracks(store(data));
    const cues: unknown[] = [];
    await extractCues(store(data), layout, 1, (batch: unknown[]) => cues.push(...batch), () => true);
    expect(cues).toHaveLength(0);
  });

  it("handles a Segment written with an unknown size", async () => {
    const data = document({
      tracks: [track(1, "S_TEXT/UTF8")], clusters: [cluster], unknownSegment: true,
    });
    const layout = await readSubtitleTracks(store(data));
    expect(layout.tracks).toHaveLength(1);
    const cues: unknown[] = [];
    await extractCues(store(data), layout, 1, (batch: unknown[]) => cues.push(...batch));
    expect(cues).toHaveLength(2);
  });
});

describe("turning SubRip markup into something a VTTCue will render", () => {
  it("keeps the four inline tags VTT shares with SubRip", () => {
    expect(toVtt("<i>a</i> <b>b</b> <u>c</u>")).toBe("<i>a</i> <b>b</b> <u>c</u>");
  });

  it("escapes everything else, so a stray bracket shows instead of eating the line", () => {
    expect(toVtt("5 < 6 & 7 > 2")).toBe("5 &lt; 6 &amp; 7 &gt; 2");
    expect(toVtt("<font color=red>x</font>")).toBe("&lt;font color=red&gt;x&lt;/font&gt;");
  });

  it("normalises line endings", () => {
    expect(toVtt("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });
});
