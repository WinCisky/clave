/**
 * Language tags, made safe for the muxer and readable for the panel.
 *
 * Matroska carries a track's language twice: the old `Language` element, which is ISO 639-2, and
 * `LanguageBCP47`, which mkvmerge has written on every track it muxes since 2020. mediabunny
 * validates the first and falls back to `und`, but returns the second's primary subtag untouched —
 * so a track tagged `en-US` arrives here as `"en"`. Its *writer* then rejects that, because MP4
 * stores a language as three packed five-bit letters and there is nowhere to put two.
 *
 * That threw a TypeError before any fragment was muxed, which is why a large share of ordinary
 * H.264 releases would not play at all. Nothing reaches the muxer now without passing through here.
 */

/**
 * ISO 639-1 to ISO 639-2/T.
 *
 * Terminological, not bibliographic: French is `fra`, not `fre`. A file that already says `fre` is
 * left alone — it is three lowercase letters, which is all the muxer asks for.
 */
const ISO_639_1 = new Map(Object.entries({
  aa: "aar", ab: "abk", ae: "ave", af: "afr", ak: "aka", am: "amh", an: "arg", ar: "ara",
  as: "asm", av: "ava", ay: "aym", az: "aze",
  ba: "bak", be: "bel", bg: "bul", bh: "bih", bi: "bis", bm: "bam", bn: "ben", bo: "bod",
  br: "bre", bs: "bos",
  ca: "cat", ce: "che", ch: "cha", co: "cos", cr: "cre", cs: "ces", cu: "chu", cv: "chv",
  cy: "cym",
  da: "dan", de: "deu", dv: "div", dz: "dzo",
  ee: "ewe", el: "ell", en: "eng", eo: "epo", es: "spa", et: "est", eu: "eus",
  fa: "fas", ff: "ful", fi: "fin", fj: "fij", fo: "fao", fr: "fra", fy: "fry",
  ga: "gle", gd: "gla", gl: "glg", gn: "grn", gu: "guj", gv: "glv",
  ha: "hau", he: "heb", hi: "hin", ho: "hmo", hr: "hrv", ht: "hat", hu: "hun", hy: "hye",
  hz: "her",
  ia: "ina", id: "ind", ie: "ile", ig: "ibo", ii: "iii", ik: "ipk", io: "ido", is: "isl",
  it: "ita", iu: "iku",
  ja: "jpn", jv: "jav",
  ka: "kat", kg: "kon", ki: "kik", kj: "kua", kk: "kaz", kl: "kal", km: "khm", kn: "kan",
  ko: "kor", kr: "kau", ks: "kas", ku: "kur", kv: "kom", kw: "cor", ky: "kir",
  la: "lat", lb: "ltz", lg: "lug", li: "lim", ln: "lin", lo: "lao", lt: "lit", lu: "lub",
  lv: "lav",
  mg: "mlg", mh: "mah", mi: "mri", mk: "mkd", ml: "mal", mn: "mon", mr: "mar", ms: "msa",
  mt: "mlt", my: "mya",
  na: "nau", nb: "nob", nd: "nde", ne: "nep", ng: "ndo", nl: "nld", nn: "nno", no: "nor",
  nr: "nbl", nv: "nav", ny: "nya",
  oc: "oci", oj: "oji", om: "orm", or: "ori", os: "oss",
  pa: "pan", pi: "pli", pl: "pol", ps: "pus", pt: "por",
  qu: "que",
  rm: "roh", rn: "run", ro: "ron", ru: "rus", rw: "kin",
  sa: "san", sc: "srd", sd: "snd", se: "sme", sg: "sag", si: "sin", sk: "slk", sl: "slv",
  sm: "smo", sn: "sna", so: "som", sq: "sqi", sr: "srp", ss: "ssw", st: "sot", su: "sun",
  sv: "swe", sw: "swa",
  ta: "tam", te: "tel", tg: "tgk", th: "tha", ti: "tir", tk: "tuk", tl: "tgl", tn: "tsn",
  to: "ton", tr: "tur", ts: "tso", tt: "tat", tw: "twi", ty: "tah",
  ug: "uig", uk: "ukr", ur: "urd", uz: "uzb",
  ve: "ven", vi: "vie", vo: "vol",
  wa: "wln", wo: "wol",
  xh: "xho",
  yi: "yid", yo: "yor",
  za: "zha", zh: "zho", zu: "zul",
}));

/**
 * A language tag the MP4 muxer will accept, or null.
 *
 * Null rather than `"und"` on purpose: the caller passes `undefined` and lets the muxer apply its
 * own default, so this never has to know what that default is.
 */
export function toIso6392T(raw) {
  if (typeof raw !== "string") return null;
  // The primary subtag is the only part a three-letter code can hold: `pt-BR` is Portuguese here.
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{3}$/.test(primary)) return primary;
  return ISO_639_1.get(primary) ?? null;
}

/**
 * What to call the language in the panel.
 *
 * `Intl.DisplayNames` already knows every one of these, in two and three letters alike, so there is
 * no second table to keep in step with the first. Unknown tags — `und`, `mis`, the private-use
 * range — come back as null so a picker can leave the codec to speak for itself.
 */
export function languageLabel(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  // Matroska and QuickTime both turn up with an underscore where BCP-47 wants a hyphen.
  const tag = raw.trim().replace(/_/g, "-");
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(tag) ?? null;
  } catch {
    return null;
  }
}
