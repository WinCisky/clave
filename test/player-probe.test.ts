/**
 * Which audio track the player picks, and what happens when none of them will do.
 *
 * The preference order is the whole reason a TrueHD remux plays: those files almost always carry an
 * AC-3 companion track, and taking it beats refusing the file. The `null` case matters just as much
 * — it used to condemn the entire file to the compatibility route, which then refused it for the
 * *video* codec, which is how a perfectly playable HEVC film came to be reported as unplayable HEVC.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JavaScript, exactly as the browser loads it.
import { chooseAudioTrack } from "../web/player/probe.js";

const track = (id: number, options: { copy?: boolean; usable?: boolean } = {}) => ({
  id,
  copy: options.copy ?? false,
  usable: options.usable ?? true,
});

describe("chooseAudioTrack", () => {
  it("prefers a track that needs no work at all", () => {
    const chosen = chooseAudioTrack([track(1), track(2, { copy: true }), track(3)]);
    expect(chosen?.id).toBe(2);
  });

  it("falls back to one that only needs re-encoding", () => {
    const chosen = chooseAudioTrack([track(1, { usable: false }), track(2)]);
    expect(chosen?.id).toBe(2);
  });

  it("takes the AC-3 companion when the headline track cannot be decoded", () => {
    // The shape of a TrueHD remux: track 1 is the one nobody can read, track 2 is the fallback.
    const chosen = chooseAudioTrack([track(1, { usable: false }), track(2, { copy: true })]);
    expect(chosen?.id).toBe(2);
  });

  it("returns null when nothing is usable, rather than picking something that will fail", () => {
    expect(chooseAudioTrack([track(1, { usable: false }), track(2, { usable: false })])).toBeNull();
  });

  it("returns null for a file with no audio at all", () => {
    expect(chooseAudioTrack([])).toBeNull();
  });
});
