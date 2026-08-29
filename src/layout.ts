/**
 * Byte ↔ piece arithmetic.
 *
 * Two coordinate systems meet here and confusing them is the easiest way to stream a video that
 * plays for four seconds and then dies:
 *
 *  - **File coordinates.** What the client cares about. Byte 0 is the first byte of the selected
 *    file, not of the torrent.
 *  - **Torrent coordinates.** What pieces are indexed in. A file starts at `fileOffset`, which is
 *    almost never piece-aligned — Big Buck Bunny's video starts at byte 140, behind a subtitle
 *    file, and that unaligned case is the common one.
 *
 * Whole *torrent* pieces are what travel over the WebSocket, because SHA-1 is defined over a
 * piece and the client cannot verify a trimmed one. It trims when it assembles. So the only
 * question this module answers is which piece indices a file, or a window inside a file, covers.
 *
 * Everything is a pure function of a `TorrentLayout`. No I/O, no bindings, no clock — which is why
 * this is the module with exhaustive unit tests.
 */

/** One entry of bstream's `chunks.files`. Position in the array is the public `?file=` index. */
export interface ChunkFileEntry {
  readonly path: string;
  readonly length: number;
  /** Torrent offset of this file's first byte. */
  readonly offset: number;
  /** BEP-47 padding, which occupies an index but holds no content. */
  readonly padding?: boolean;
  readonly mime?: string;
}

export interface TorrentLayout {
  readonly id: string;
  readonly name: string;
  readonly pieceLength: number;
  readonly pieceCount: number;
  readonly totalLength: number;
  readonly files: readonly ChunkFileEntry[];
  /** bstream's own default selection, used when the client names no file. */
  readonly fileIndex: number;
  readonly filePath: string;
  readonly fileOffset: number;
  readonly fileLength: number;
  readonly mime: string;
}

export interface FileView {
  readonly index: number;
  readonly path: string;
  /** Torrent offset of the file's first byte. */
  readonly offset: number;
  readonly length: number;
  readonly mime: string;
}

/** An inclusive run of piece indices. */
export interface PieceRange {
  readonly first: number;
  readonly last: number;
}

export class LayoutError extends Error {
  override readonly name = "LayoutError";
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/** The piece holding a given torrent byte. */
export function pieceIndexAt(torrentOffset: number, pieceLength: number): number {
  return Math.floor(torrentOffset / pieceLength);
}

/** Length of a piece, which is short only for the torrent's last one. */
export function pieceLengthAt(layout: TorrentLayout, pieceIndex: number): number {
  const start = pieceIndex * layout.pieceLength;
  return Math.min(layout.pieceLength, layout.totalLength - start);
}

/**
 * Resolve `?file=N` against the layout, or the default selection when absent.
 *
 * `wanted` indexes `files` **as stored**: padding entries occupy a position and are counted. A
 * reader that filtered them would shift every later index by one and silently serve the wrong
 * file, so an explicit request for a padding entry is an error rather than a skip.
 */
export function resolveFile(layout: TorrentLayout, wanted?: number | null): FileView {
  if (wanted === undefined || wanted === null) {
    return {
      index: layout.fileIndex,
      path: layout.filePath,
      offset: layout.fileOffset,
      length: layout.fileLength,
      mime: layout.mime,
    };
  }

  if (!Number.isInteger(wanted) || wanted < 0 || wanted >= layout.files.length) {
    throw new LayoutError(
      `file ${wanted} is out of range; the torrent has ${layout.files.length}`,
      404,
      "no_such_file",
    );
  }
  const file = layout.files[wanted]!;
  if (file.padding) {
    throw new LayoutError(
      `file ${wanted} is BEP-47 padding and holds no content`,
      404,
      "padding_file",
    );
  }
  return {
    index: wanted,
    path: file.path,
    offset: file.offset,
    length: file.length,
    mime: file.mime ?? "application/octet-stream",
  };
}

/**
 * The pieces a file occupies.
 *
 * Inclusive on both ends, and both ends are usually shared with a neighbouring file — piece 0 of
 * Big Buck Bunny holds a 140-byte subtitle track before the video starts. That sharing is why the
 * client receives whole pieces and does the trimming itself.
 */
export function pieceRangeOfFile(layout: TorrentLayout, file: FileView): PieceRange {
  if (file.length <= 0) {
    const only = pieceIndexAt(file.offset, layout.pieceLength);
    return { first: only, last: only };
  }
  return {
    first: pieceIndexAt(file.offset, layout.pieceLength),
    last: pieceIndexAt(file.offset + file.length - 1, layout.pieceLength),
  };
}

/**
 * The pieces covering `[fileStart, fileStart + length)` of a file, clamped to the file.
 *
 * Used for the head and tail bootstrap windows. A zero or negative `length` yields an empty
 * range, signalled by `last < first`, so a caller can iterate it without a special case.
 */
export function pieceRangeOfWindow(
  layout: TorrentLayout,
  file: FileView,
  fileStart: number,
  length: number,
): PieceRange {
  if (length <= 0 || file.length <= 0) return { first: 0, last: -1 };
  const start = Math.max(0, Math.min(fileStart, file.length - 1));
  const end = Math.min(file.length, start + length);
  if (end <= start) return { first: 0, last: -1 };
  return {
    first: pieceIndexAt(file.offset + start, layout.pieceLength),
    last: pieceIndexAt(file.offset + end - 1, layout.pieceLength),
  };
}

/** The piece holding a byte offset inside a file, for translating a client's seek. */
export function pieceOfFileOffset(
  layout: TorrentLayout,
  file: FileView,
  fileOffset: number,
): number {
  const clamped = Math.max(0, Math.min(fileOffset, Math.max(0, file.length - 1)));
  return pieceIndexAt(file.offset + clamped, layout.pieceLength);
}
