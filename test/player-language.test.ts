/**
 * Language tags, on the way to a muxer that will not accept most of them.
 *
 * This existed as a one-line `track.languageCode ?? undefined` and it stopped a large share of
 * ordinary MKV releases from playing at all: mediabunny validates Matroska's old `Language` element
 * but hands back `LanguageBCP47`'s primary subtag untouched, so `en-US` arrives as `"en"` and the
 * MP4 muxer — which packs a language into three five-bit letters — throws before a single fragment
 * is written. The failure was total and instant, which is exactly the shape a pure test can pin.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JavaScript, exactly as the browser loads it.
import { languageLabel, toIso6392T } from "../web/player/language.js";

describe("toIso6392T", () => {
  it("expands the two-letter codes Matroska's BCP-47 element leaves behind", () => {
    expect(toIso6392T("en")).toBe("eng");
    expect(toIso6392T("fr")).toBe("fra");
    expect(toIso6392T("ja")).toBe("jpn");
  });

  it("keeps only the primary subtag, whichever separator the file used", () => {
    expect(toIso6392T("en-US")).toBe("eng");
    expect(toIso6392T("pt_BR")).toBe("por");
    expect(toIso6392T("zh-Hant")).toBe("zho");
  });

  it("passes three-letter codes through, terminological or bibliographic", () => {
    expect(toIso6392T("eng")).toBe("eng");
    // `fre` is ISO 639-2/B rather than /T, but it is three lowercase letters and the muxer's own
    // check is exactly that — rewriting it would be a change with no beneficiary.
    expect(toIso6392T("fre")).toBe("fre");
    expect(toIso6392T("und")).toBe("und");
  });

  it("normalises case and surrounding space", () => {
    expect(toIso6392T(" EN-us ")).toBe("eng");
    expect(toIso6392T("ENG")).toBe("eng");
  });

  it("returns null rather than a guess, so the caller can omit the field", () => {
    expect(toIso6392T("zz")).toBeNull();
    expect(toIso6392T("")).toBeNull();
    expect(toIso6392T(null)).toBeNull();
    expect(toIso6392T(undefined)).toBeNull();
    expect(toIso6392T(42)).toBeNull();
  });
});

describe("languageLabel", () => {
  it("names a language from either length of code", () => {
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("eng")).toBe("English");
    expect(languageLabel("jpn")).toBe("Japanese");
  });

  it("keeps the region when the file bothered to record one", () => {
    expect(languageLabel("pt-BR")).toBe("Brazilian Portuguese");
    expect(languageLabel("pt_BR")).toBe("Brazilian Portuguese");
  });

  it("has no name for an unspecified language", () => {
    expect(languageLabel("und")).toBeNull();
    expect(languageLabel("zz")).toBeNull();
    expect(languageLabel("")).toBeNull();
    expect(languageLabel(null)).toBeNull();
  });
});
