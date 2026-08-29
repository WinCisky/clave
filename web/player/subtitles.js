/**
 * Text subtitles out of Matroska, because nothing else will give them to us.
 *
 * mediabunny reads no subtitle tracks at all — subtitles are output-only there, and the only codec
 * it writes is WebVTT — and pulling in 3.6 MB of libav to fetch a few kilobytes of text would be
 * absurd. Matroska is also where embedded text subtitles actually live; MP4's `tx3g` is rare enough
 * in torrents to be worth skipping honestly rather than supporting badly.
 *
 * The walk is deliberately forward-only and incremental. Clusters are laid out in play order, so
 * scanning them costs nothing extra while the file is downloading sequentially, and cues appear as
 * their part of the film arrives instead of the page waiting for a complete file.
 */

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  LANGUAGE: 0x22b59c,
  LANGUAGE_BCP47: 0x22b59d,
  NAME: 0x536e,
  FLAG_DEFAULT: 0x88,
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMESTAMP: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
};

const TRACK_TYPE_SUBTITLE = 0x11;

/** What we can turn into WebVTT cues without a styling engine. */
const TEXT_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASCII", "S_TEXT/WEBVTT"]);

/** Recognised, listed, and deliberately not rendered — these need libass to look like anything. */
const STYLED_CODECS = new Set(["S_TEXT/ASS", "S_TEXT/SSA"]);

export function looksLikeMatroska(headerBytes) {
  return headerBytes.length >= 4 &&
    headerBytes[0] === 0x1a && headerBytes[1] === 0x45 &&
    headerBytes[2] === 0xdf && headerBytes[3] === 0xa3;
}

/**
 * A forward cursor over the byte store, so the parser can read elements without holding the file.
 */
class Cursor {
  #store;
  #chunk = new Uint8Array(0);
  #chunkAt = 0;

  constructor(store, at = 0) {
    this.#store = store;
    this.at = at;
  }

  get end() {
    return this.#store.size;
  }

  async #ensure(length) {
    const wanted = Math.max(length, 64 * 1024);
    if (this.at >= this.#chunkAt && this.at + length <= this.#chunkAt + this.#chunk.length) return;
    const to = Math.min(this.#store.size, this.at + wanted);
    this.#chunk = await this.#store.read(this.at, to);
    this.#chunkAt = this.at;
    if (this.#chunk.length < length) throw new RangeError("past the end of the file");
  }

  async bytes(length) {
    await this.#ensure(length);
    const from = this.at - this.#chunkAt;
    const out = this.#chunk.subarray(from, from + length);
    this.at += length;
    return out;
  }

  /** An EBML variable-length integer. `keepMarker` is what distinguishes an ID from a size. */
  async vint(keepMarker) {
    await this.#ensure(1);
    const first = this.#chunk[this.at - this.#chunkAt];
    let width = 1;
    while (width <= 8 && (first & (0x80 >> (width - 1))) === 0) width++;
    if (width > 8) throw new RangeError("not a valid EBML length");

    const bytes = await this.bytes(width);
    let value = keepMarker ? bytes[0] : bytes[0] & (0xff >> width);
    let allOnes = (bytes[0] & (0xff >> width)) === (0xff >> width);
    for (let i = 1; i < width; i++) {
      value = value * 256 + bytes[i];
      if (bytes[i] !== 0xff) allOnes = false;
    }
    // An all-ones size means "unknown", which Segment and Cluster both use when written live.
    return { value, width, unknown: !keepMarker && allOnes };
  }
}

const toUint = (bytes) => bytes.reduce((total, byte) => total * 256 + byte, 0);
const toText = (bytes) => new TextDecoder().decode(bytes).replace(/\0+$/, "");

/**
 * Find the subtitle tracks and where the clusters begin.
 *
 * Returns `null` for anything that is not Matroska, which is the signal to say "no embedded text
 * subtitles" rather than to report a failure.
 */
export async function readSubtitleTracks(store) {
  const head = await store.read(0, 4);
  if (!looksLikeMatroska(head)) return null;

  const cursor = new Cursor(store, 0);
  const tracks = [];
  let timestampScale = 1_000_000;
  let clustersAt = null;
  let segmentEnd = store.size;

  // Top level: the EBML header, then the Segment we actually care about.
  while (cursor.at < store.size && clustersAt === null) {
    const id = await cursor.vint(true);
    const size = await cursor.vint(false);
    const bodyAt = cursor.at;
    const bodyEnd = size.unknown ? store.size : bodyAt + size.value;

    if (id.value === ID.SEGMENT) {
      segmentEnd = bodyEnd;
      // Descend, rather than skipping: Tracks and the first Cluster are both in here.
      while (cursor.at < segmentEnd && clustersAt === null) {
        const childId = await cursor.vint(true);
        const childSize = await cursor.vint(false);
        const childAt = cursor.at;
        const childEnd = childSize.unknown ? segmentEnd : childAt + childSize.value;

        if (childId.value === ID.TRACKS) {
          await readTracks(cursor, childEnd, tracks);
        } else if (childId.value === ID.INFO) {
          timestampScale = await readTimestampScale(cursor, childEnd) ?? timestampScale;
        } else if (childId.value === ID.CLUSTER) {
          // Rewind to the start of this element; the cue walk re-reads it.
          clustersAt = childAt - (childId.width + childSize.width);
          break;
        }
        cursor.at = childEnd;
      }
      break;
    }
    cursor.at = bodyEnd;
  }

  return {
    timestampScale,
    clustersAt: clustersAt ?? segmentEnd,
    segmentEnd,
    tracks: tracks.map((track) => ({
      ...track,
      supported: TEXT_CODECS.has(track.codec),
      styled: STYLED_CODECS.has(track.codec),
    })),
  };
}

async function readTracks(cursor, end, out) {
  while (cursor.at < end) {
    const id = await cursor.vint(true);
    const size = await cursor.vint(false);
    const entryEnd = cursor.at + size.value;
    if (id.value !== ID.TRACK_ENTRY) {
      cursor.at = entryEnd;
      continue;
    }

    const track = { number: 0, type: 0, codec: "", language: "und", name: null, isDefault: false };
    while (cursor.at < entryEnd) {
      const fieldId = await cursor.vint(true);
      const fieldSize = await cursor.vint(false);
      const fieldEnd = cursor.at + fieldSize.value;
      const bytes = fieldSize.value <= 4096 ? await cursor.bytes(fieldSize.value) : null;
      if (bytes !== null) {
        switch (fieldId.value) {
          case ID.TRACK_NUMBER: track.number = toUint(bytes); break;
          case ID.TRACK_TYPE: track.type = toUint(bytes); break;
          case ID.CODEC_ID: track.codec = toText(bytes); break;
          case ID.LANGUAGE: track.language = toText(bytes); break;
          case ID.LANGUAGE_BCP47: track.language = toText(bytes); break;
          case ID.NAME: track.name = toText(bytes); break;
          case ID.FLAG_DEFAULT: track.isDefault = toUint(bytes) !== 0; break;
        }
      }
      cursor.at = fieldEnd;
    }
    if (track.type === TRACK_TYPE_SUBTITLE) out.push(track);
    cursor.at = entryEnd;
  }
}

async function readTimestampScale(cursor, end) {
  let scale = null;
  while (cursor.at < end) {
    const id = await cursor.vint(true);
    const size = await cursor.vint(false);
    const fieldEnd = cursor.at + size.value;
    if (id.value === ID.TIMESTAMP_SCALE && size.value <= 8) scale = toUint(await cursor.bytes(size.value));
    cursor.at = fieldEnd;
  }
  return scale;
}

/**
 * Walk the clusters, handing over cues for one subtitle track as they are found.
 *
 * `onCues` is called repeatedly with small batches. It stops when `shouldStop()` says so, which is
 * how the worker abandons the walk when the viewer switches tracks or closes the player.
 */
export async function extractCues(store, layout, trackNumber, onCues, shouldStop = () => false) {
  const cursor = new Cursor(store, layout.clustersAt);
  const scale = layout.timestampScale / 1e9; // ticks to seconds
  let batch = [];

  while (cursor.at < layout.segmentEnd && !shouldStop()) {
    let id;
    let size;
    try {
      id = await cursor.vint(true);
      size = await cursor.vint(false);
    } catch {
      break;
    }
    const end = size.unknown ? layout.segmentEnd : cursor.at + size.value;
    if (id.value !== ID.CLUSTER) {
      cursor.at = end;
      continue;
    }

    let clusterTime = 0;
    while (cursor.at < end && !shouldStop()) {
      let childId;
      let childSize;
      try {
        childId = await cursor.vint(true);
        childSize = await cursor.vint(false);
      } catch {
        return flush(batch, onCues);
      }
      const childEnd = cursor.at + childSize.value;

      if (childId.value === ID.CLUSTER_TIMESTAMP) {
        clusterTime = toUint(await cursor.bytes(childSize.value));
      } else if (childId.value === ID.SIMPLE_BLOCK) {
        const cue = await readBlock(cursor, childSize.value, trackNumber, clusterTime, scale, 0);
        if (cue !== null) batch.push(cue);
      } else if (childId.value === ID.BLOCK_GROUP) {
        const cue = await readBlockGroup(cursor, childEnd, trackNumber, clusterTime, scale);
        if (cue !== null) batch.push(cue);
      }
      cursor.at = childEnd;

      if (batch.length >= 64) {
        onCues(batch);
        batch = [];
      }
    }
    cursor.at = end;
  }
  flush(batch, onCues);
}

function flush(batch, onCues) {
  if (batch.length > 0) onCues(batch);
}

async function readBlockGroup(cursor, end, trackNumber, clusterTime, scale) {
  let cue = null;
  let duration = null;
  let blockAt = null;
  let blockSize = 0;

  while (cursor.at < end) {
    const id = await cursor.vint(true);
    const size = await cursor.vint(false);
    const fieldEnd = cursor.at + size.value;
    if (id.value === ID.BLOCK) {
      blockAt = cursor.at;
      blockSize = size.value;
    } else if (id.value === ID.BLOCK_DURATION && size.value <= 8) {
      duration = toUint(await cursor.bytes(size.value));
    }
    cursor.at = fieldEnd;
  }

  if (blockAt !== null) {
    cursor.at = blockAt;
    cue = await readBlock(cursor, blockSize, trackNumber, clusterTime, scale, duration ?? 0);
  }
  cursor.at = end;
  return cue;
}

async function readBlock(cursor, size, trackNumber, clusterTime, scale, durationTicks) {
  const start = cursor.at;
  const track = await cursor.vint(false);
  if (track.value !== trackNumber) {
    cursor.at = start + size;
    return null;
  }
  const header = await cursor.bytes(3); // int16 relative timestamp, then flags
  const relative = (header[0] << 8) | header[1];
  const signed = relative > 0x7fff ? relative - 0x10000 : relative;
  const payload = await cursor.bytes(size - (cursor.at - start));
  const text = toText(payload).trim();
  cursor.at = start + size;
  if (text.length === 0) return null;

  const from = (clusterTime + signed) * scale;
  // A subtitle with no duration is a broken file, not a subtitle that lasts forever.
  const length = durationTicks > 0 ? durationTicks * scale : 2;
  return { start: from, end: from + length, text: toVtt(text) };
}

/**
 * SubRip markup into what a VTTCue will render.
 *
 * Only the four inline tags VTT shares with SRT survive; everything else is escaped, so a file with
 * stray angle brackets shows them rather than losing the line.
 */
export function toVtt(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;(\/?)([biu])&gt;/gi, "<$1$2>")
    .replace(/\r\n?/g, "\n");
}
