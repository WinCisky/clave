/**
 * Reading a file that is not all there yet.
 *
 * Both playback engines need the same thing and neither can be told "come back later": mediabunny's
 * `CustomSource.read` and libav's `onblockread` are both "give me bytes [start, end)". So this sits
 * underneath both, answers immediately when the pieces covering that range have been verified, and
 * otherwise waits — nudging the relay towards the bytes somebody is actually blocked on.
 *
 * The nudge policy is the whole design. The relay has one cursor: `seek(piece)` restarts it there
 * and it walks sequentially to the end. Point it at every read and it thrashes; never point it and
 * a demuxer asking for a byte behind the cursor waits forever. So: the *oldest* outstanding reader
 * owns the demand, and it only moves the cursor when what it wants is somewhere the relay is not
 * about to reach anyway. Progress is guaranteed because every waiter eventually becomes the oldest.
 */

/** Pieces the relay may still deliver on its own before we bother moving its cursor. */
const LOOKAHEAD_PIECES = 64;

export class ByteStore {
  #chunks;
  #file;
  #readAt;
  #hasPiece;
  #requestPieces;
  #cursor;

  /** Ordered oldest-first; the head owns the relay's cursor. */
  #waiters = [];
  #seq = 0;
  #lastRequested = -1;
  #exhausted = null;

  /**
   * @param {object} options
   * @param {object} options.chunks       the torrent's layout (pieceLength, totalLength, …)
   * @param {object} options.file         the chosen file (offset, length)
   * @param {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} options.readAt
   * @param {(piece: number) => boolean} options.hasPiece                    verified-piece bitmap
   * @param {(piece: number) => void} options.requestPieces                  move the relay's cursor
   * @param {() => number} options.cursor                                    where the relay is now
   */
  constructor({ chunks, file, readAt, hasPiece, requestPieces, cursor }) {
    this.#chunks = chunks;
    this.#file = file;
    this.#readAt = readAt;
    this.#hasPiece = hasPiece;
    this.#requestPieces = requestPieces;
    this.#cursor = cursor;
  }

  get size() {
    return this.#file.length;
  }

  /** The torrent pieces covering file bytes [start, end), inclusive of both ends. */
  pieceSpan(start, end) {
    const pieceLength = this.#chunks.pieceLength;
    const from = this.#file.offset + Math.max(0, start);
    const to = this.#file.offset + Math.min(this.#file.length, Math.max(start, end));
    return {
      first: Math.floor(from / pieceLength),
      last: Math.floor(Math.max(from, to - 1) / pieceLength),
    };
  }

  /** The first piece of this range that is still missing, or -1 if the range is complete. */
  firstMissing(start, end) {
    const { first, last } = this.pieceSpan(start, end);
    for (let piece = first; piece <= last; piece++) {
      if (!this.#hasPiece(piece)) return piece;
    }
    return -1;
  }

  available(start, end) {
    return this.firstMissing(start, end) === -1;
  }

  /** How many bytes from `start` are contiguously available. Used to decide when play can begin. */
  contiguousFrom(start) {
    const pieceLength = this.#chunks.pieceLength;
    const { first } = this.pieceSpan(start, start + 1);
    let piece = first;
    const end = this.pieceSpan(this.#file.length - 1, this.#file.length).last;
    while (piece <= end && this.#hasPiece(piece)) piece++;
    // The run ends where the first missing piece begins, in file-relative bytes.
    const byte = piece * pieceLength - this.#file.offset;
    return Math.max(0, Math.min(this.#file.length, byte) - start);
  }

  async read(start, end) {
    const from = Math.max(0, Math.min(start, this.#file.length));
    const to = Math.max(from, Math.min(end, this.#file.length));
    if (to === from) return new Uint8Array(0);

    if (!this.available(from, to)) await this.#wait(from, to);
    return this.#readAt(from, to - from);
  }

  #wait(start, end) {
    if (this.#exhausted !== null) return Promise.reject(this.#exhausted);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ start, end, resolve, reject, seq: this.#seq++ });
      this.#steer();
    });
  }

  /** Called for every piece that passes its hash. Resolves whoever was waiting on it. */
  pieceArrived() {
    if (this.#waiters.length === 0) return;
    const still = [];
    for (const waiter of this.#waiters) {
      if (this.available(waiter.start, waiter.end)) waiter.resolve();
      else still.push(waiter);
    }
    this.#waiters = still;
    this.#steer();
  }

  /**
   * The relay has finished and cannot supply what is left.
   *
   * Rejecting beats waiting: a reader hung on a piece nobody has produces a spinner and no
   * explanation, where an error at least reaches the page as one.
   */
  exhaust(reason) {
    this.#exhausted = new Error(reason);
    for (const waiter of this.#waiters) waiter.reject(this.#exhausted);
    this.#waiters = [];
  }

  /** Aim the relay at whatever the oldest blocked reader needs, if it is not already heading there. */
  #steer() {
    const oldest = this.#waiters[0];
    if (oldest === undefined) return;
    const piece = this.firstMissing(oldest.start, oldest.end);
    if (piece === -1) return;

    const cursor = this.#cursor();
    // Already on its way here. Moving the cursor now would only restart what it is doing.
    if (piece >= cursor && piece <= cursor + LOOKAHEAD_PIECES) return;
    if (piece === this.#lastRequested) return;

    this.#lastRequested = piece;
    this.#requestPieces(piece);
  }

  /** What the page shows in the availability strip: runs of verified pieces, as file byte ranges. */
  availableRanges() {
    const pieceLength = this.#chunks.pieceLength;
    const first = this.pieceSpan(0, 1).first;
    const last = this.pieceSpan(this.#file.length - 1, this.#file.length).last;
    const ranges = [];
    let runStart = -1;
    for (let piece = first; piece <= last + 1; piece++) {
      const has = piece <= last && this.#hasPiece(piece);
      if (has && runStart === -1) runStart = piece;
      if (!has && runStart !== -1) {
        ranges.push([
          Math.max(0, runStart * pieceLength - this.#file.offset),
          Math.min(this.#file.length, piece * pieceLength - this.#file.offset),
        ]);
        runStart = -1;
      }
    }
    return ranges;
  }
}
