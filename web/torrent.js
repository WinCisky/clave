/**
 * Torrent arithmetic and magnet parsing, mirroring `src/layout.ts` and `src/records.ts`.
 *
 * Pure, so the page and the stream worker can both use it and neither needs a network to be tested.
 */

/** Extensions that mean "video" when a torrent gives no mime type, which is most of the time. */
const VIDEO_EXTENSIONS = new Set([
  "mp4", "mkv", "webm", "avi", "mov", "m4v", "ogv", "ogg",
  "mpeg", "mpg", "ts", "m2ts", "mts", "flv", "wmv", "divx", "3gp",
]);

/**
 * Pull the infohash out of a magnet, accepting either encoding.
 *
 * BEP-9 allows base32 as well as hex, and real indexers emit both. Returns lowercase hex, or null.
 */
export function parseMagnet(input) {
  const text = String(input ?? "").trim();
  if (text.length === 0) return null;

  // A bare infohash is a legitimate thing to paste, and it is what our own /debug route takes.
  if (/^[0-9a-fA-F]{40}$/.test(text)) {
    return { infoHash: text.toLowerCase(), name: null, trackers: [], bare: true };
  }

  if (!/^magnet:\?/i.test(text)) return null;
  let params;
  try {
    params = new URLSearchParams(text.slice(text.indexOf("?") + 1));
  } catch {
    return null;
  }

  let infoHash = null;
  for (const xt of params.getAll("xt")) {
    const match = /^urn:btih:([0-9a-zA-Z]+)$/.exec(xt.trim());
    if (match === null) continue;
    const raw = match[1];
    if (/^[0-9a-fA-F]{40}$/.test(raw)) {
      infoHash = raw.toLowerCase();
      break;
    }
    if (/^[A-Za-z2-7]{32}$/.test(raw)) {
      const decoded = base32ToHex(raw.toUpperCase());
      if (decoded !== null) {
        infoHash = decoded;
        break;
      }
    }
  }
  if (infoHash === null) return null;

  return {
    infoHash,
    name: params.get("dn"),
    trackers: params.getAll("tr"),
    bare: false,
  };
}

/** RFC 4648 base32 → 40-char hex. Returns null unless it decodes to exactly 20 bytes. */
function base32ToHex(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const character of text) {
    const index = alphabet.indexOf(character);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length !== 20) return null;
  return out.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Length of one piece. Short only for the torrent's last. */
export function pieceLengthAt(chunks, pieceIndex) {
  return Math.min(chunks.pieceLength, chunks.totalLength - pieceIndex * chunks.pieceLength);
}

/**
 * The pieces a file occupies, inclusive.
 *
 * Both ends are usually shared with a neighbouring file — Big Buck Bunny's video starts at torrent
 * byte 140, behind a subtitle track — which is exactly why whole pieces are sent and the client
 * trims them itself.
 */
export function pieceRangeOfFile(chunks, file) {
  if (file.length <= 0) {
    const only = Math.floor(file.offset / chunks.pieceLength);
    return { first: only, last: only };
  }
  return {
    first: Math.floor(file.offset / chunks.pieceLength),
    last: Math.floor((file.offset + file.length - 1) / chunks.pieceLength),
  };
}

/** The part of a piece that belongs to a file: where to read from, how much, and where it goes. */
export function overlapWithFile(chunks, file, pieceIndex, pieceBytes) {
  const pieceStart = pieceIndex * chunks.pieceLength;
  const from = Math.max(pieceStart, file.offset);
  const to = Math.min(pieceStart + pieceBytes, file.offset + file.length);
  if (to <= from) return null;
  return { sourceOffset: from - pieceStart, length: to - from, fileOffset: from - file.offset };
}

/** Decode the base64 blob of concatenated 20-byte SHA-1s. */
export function decodePieceHashes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const extensionOf = (path) => {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

/**
 * Whether a file entry looks like a video.
 *
 * The mime type is authoritative when present but usually is not, so the extension carries most of
 * the weight in practice.
 */
export function isVideo(file) {
  if (typeof file.mime === "string" && file.mime.startsWith("video/")) return true;
  return VIDEO_EXTENSIONS.has(extensionOf(file.path));
}

/**
 * Annotate every file with its index, piece range and whether it is selectable.
 *
 * The index is the position **as stored**, padding entries included: the Worker's `resolveFile`
 * indexes the array the same way, and filtering padding out here would shift every later index and
 * silently stream the wrong file.
 */
export function describeFiles(chunks) {
  return chunks.files.map((file, index) => {
    const range = pieceRangeOfFile(chunks, file);
    return {
      index,
      path: file.path,
      name: file.path.split("/").pop() ?? file.path,
      length: file.length,
      offset: file.offset,
      mime: file.mime ?? null,
      padding: file.padding === true,
      video: isVideo(file),
      firstPiece: range.first,
      lastPiece: range.last,
      pieceCount: range.last - range.first + 1,
      // The Worker refuses BEP-47 padding, and a zero-length file has nothing to stream.
      selectable: file.padding !== true && file.length > 0,
    };
  });
}

/**
 * A torrent path turned into a single OPFS filename.
 *
 * OPFS names cannot contain a path separator and torrent paths routinely do, so both the worker
 * writing the file and the page reading it back must agree on this exactly.
 */
export function safeName(name) {
  return name.replace(/[/\\]/g, "_").slice(0, 180) || "video.bin";
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s`;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
