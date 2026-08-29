/**
 * Where the page points, and the knobs worth having during a demo.
 *
 * Every value is overridable per-load with a query parameter, which is how the page gets tested
 * against a local `wrangler dev` or through the dev server's CORS proxy without editing anything.
 */

const params = new URLSearchParams(location.search);

export const CONFIG = {
  /** bstream resolves magnets over UDP trackers and the DHT, which a Worker cannot do. */
  bstream: params.get("bstream") ?? "https://bstream.ssimo.dev",
  /** The piece relay. `http(s)` here; the stream worker swaps it to `ws(s)`. */
  worker: params.get("worker") ?? "https://clave.xsimone97.workers.dev",

  /** Pretend this piece failed its hash, to exercise the NAK path from the browser. */
  corruptPiece: params.has("corrupt") ? Number(params.get("corrupt")) : -1,
  /** Ignore anything already stored and start the download from nothing. */
  fresh: params.has("fresh"),
  /** Prefill the magnet field, so a test run is one click. */
  magnet: params.get("magnet") ?? "",
  /**
   * Play a plain URL instead of a torrent.
   *
   * A test hook, not a feature: it pins one file to one playback route so an engine can be fixed
   * without first finding a torrent that happens to contain the codec in question.
   */
  local: params.get("local") ?? "",

  /** Pieces the client will hold before it must be granted more. */
  creditStart: Number(params.get("credit") ?? 64),
  creditGrant: 48,
  creditEvery: 24,
};
