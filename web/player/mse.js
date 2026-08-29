/**
 * The MediaSource, living in the worker.
 *
 * MSE has been available in dedicated workers since Chrome 108: the worker owns the `MediaSource`
 * and hands the page a `MediaSourceHandle`, which the page assigns to `video.srcObject`. That is
 * worth doing rather than posting segments to the main thread, because it means no byte of video is
 * ever copied across a message boundary — the bytes go from OPFS through the muxer into the
 * SourceBuffer without leaving this thread.
 *
 * Everything here is serialised. `appendBuffer` is asynchronous and a SourceBuffer will throw if you
 * call it while it is still updating, so every append and every removal goes through one queue.
 */

/** Keep this much played-back video behind the playhead before evicting it. */
const KEEP_BEHIND_SECONDS = 30;

export class Sink {
  #mediaSource;
  #buffer = null;
  #handle;
  #queue = Promise.resolve();
  #opened;
  #playhead = 0;
  #ended = false;

  constructor() {
    this.#mediaSource = new MediaSource();
    // Only readable in a worker, and only once — it is transferred to the page.
    this.#handle = this.#mediaSource.handle;
    this.#opened = new Promise((resolve) => {
      this.#mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
    });
  }

  /** Transfer this to the page; `video.srcObject = handle` is what opens the source. */
  get handle() {
    return this.#handle;
  }

  get playhead() {
    return this.#playhead;
  }

  set playhead(seconds) {
    this.#playhead = seconds;
  }

  /** Resolves once the page has attached the handle and the source buffer exists. */
  async open(mime, duration) {
    await this.#opened;
    this.#buffer = this.#mediaSource.addSourceBuffer(mime);
    // Fragments carry their own timestamps; 'segments' is the mode that honours them.
    this.#buffer.mode = "segments";
    if (typeof duration === "number" && duration > 0) this.#mediaSource.duration = duration;
  }

  get mediaSource() {
    return this.#mediaSource;
  }

  /** Byte ranges currently buffered, as `[start, end]` pairs in seconds. */
  buffered() {
    if (this.#buffer === null) return [];
    const ranges = [];
    for (let i = 0; i < this.#buffer.buffered.length; i++) {
      ranges.push([this.#buffer.buffered.start(i), this.#buffer.buffered.end(i)]);
    }
    return ranges;
  }

  /** How many seconds are buffered continuously from `time` forward. */
  aheadOf(time) {
    for (const [start, end] of this.buffered()) {
      if (time >= start - 0.25 && time < end) return end - time;
    }
    return 0;
  }

  append(bytes) {
    return this.#enqueue(async () => {
      try {
        await this.#appendOnce(bytes);
      } catch (err) {
        if (err?.name !== "QuotaExceededError") throw err;
        // The buffer is full, not broken. Drop what has already been watched and try once more.
        await this.#removeOnce(0, Math.max(0, this.#playhead - KEEP_BEHIND_SECONDS));
        await this.#appendOnce(bytes);
      }
    });
  }

  /**
   * Throw away everything buffered.
   *
   * Used when seeking somewhere far away: the fresh muxer's fragments would otherwise sit next to
   * stale ones, and MSE would happily play the stale ones on the way past.
   */
  clear() {
    return this.#enqueue(async () => {
      if (this.#buffer === null) return;
      if (this.#buffer.updating) this.#buffer.abort();
      const end = this.#mediaSource.duration;
      await this.#removeOnce(0, Number.isFinite(end) && end > 0 ? end : this.#playhead + 3600);
    });
  }

  /** Drop what is well behind the playhead, so a long film cannot exhaust the buffer budget. */
  evict() {
    const until = this.#playhead - KEEP_BEHIND_SECONDS;
    if (until <= 0) return Promise.resolve();
    return this.#enqueue(() => this.#removeOnce(0, until));
  }

  /**
   * Line the muxer's timeline up with the film's.
   *
   * Whether a fresh muxer emits absolute timestamps or rebases them to zero is an implementation
   * detail of the muxer, and guessing it wrong puts a seek to 30:00 at 00:00. So it is measured:
   * the first fragment after a seek reports its own timestamp, and the difference from what was
   * asked for becomes the SourceBuffer's offset. When they already agree this does nothing.
   */
  alignTo(wantedSeconds, fragmentSeconds) {
    return this.#enqueue(async () => {
      if (this.#buffer === null) return;
      const offset = wantedSeconds - fragmentSeconds;
      if (Math.abs(offset - this.#buffer.timestampOffset) < 0.01) return;
      this.#buffer.timestampOffset = offset;
    });
  }

  setDuration(seconds) {
    return this.#enqueue(async () => {
      if (this.#mediaSource.readyState !== "open") return;
      if (Number.isFinite(seconds) && seconds > 0) this.#mediaSource.duration = seconds;
    });
  }

  end() {
    if (this.#ended) return Promise.resolve();
    this.#ended = true;
    return this.#enqueue(async () => {
      if (this.#mediaSource.readyState === "open") this.#mediaSource.endOfStream();
    });
  }

  #enqueue(task) {
    this.#queue = this.#queue.then(task, task);
    return this.#queue;
  }

  #appendOnce(bytes) {
    return new Promise((resolve, reject) => {
      const buffer = this.#buffer;
      if (buffer === null) {
        reject(new Error("append before the source buffer was created"));
        return;
      }
      const done = () => {
        buffer.removeEventListener("updateend", onDone);
        buffer.removeEventListener("error", onError);
      };
      const onDone = () => { done(); resolve(); };
      const onError = () => { done(); reject(new Error("the source buffer rejected the segment")); };
      buffer.addEventListener("updateend", onDone);
      buffer.addEventListener("error", onError);
      try {
        buffer.appendBuffer(bytes);
      } catch (err) {
        done();
        reject(err);
      }
    });
  }

  #removeOnce(start, end) {
    return new Promise((resolve) => {
      const buffer = this.#buffer;
      if (buffer === null || end <= start || this.#mediaSource.readyState !== "open") {
        resolve();
        return;
      }
      const onDone = () => {
        buffer.removeEventListener("updateend", onDone);
        resolve();
      };
      buffer.addEventListener("updateend", onDone);
      try {
        buffer.remove(start, end);
      } catch {
        buffer.removeEventListener("updateend", onDone);
        resolve();
      }
    });
  }
}
