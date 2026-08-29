#!/usr/bin/env node
/**
 * Fetch the pinned player libraries into `web/vendor/`.
 *
 * Vendored rather than loaded from a CDN at runtime: the page is a static GitHub Pages deployment
 * whose whole point is that it keeps working, and a third-party script host is one more thing that
 * can be down, slow, or blocked. These files change only when this script is re-run with a new
 * version, which is also what makes the deployment reproducible.
 *
 * Only `mediabunny.min.mjs` is loaded by every page view. The rest are dynamic imports, reached
 * only when a file actually needs them, so the common case downloads 647 KB and no wasm at all.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web", "vendor");

/** Pinned in lockstep: the extensions declare a peer dependency on the exact core version. */
const VERSION = "1.55.4";

const FILES = [
  {
    name: "mediabunny.min.mjs",
    url: `https://cdn.jsdelivr.net/npm/mediabunny@${VERSION}/dist/bundles/mediabunny.min.mjs`,
    why: "core: demux, mux, packet and sample plumbing",
    eager: true,
  },
  {
    name: "mediabunny-ac3.min.mjs",
    url: `https://cdn.jsdelivr.net/npm/@mediabunny/ac3@${VERSION}/dist/bundles/mediabunny-ac3.min.mjs`,
    why: "AC-3 and E-AC-3 decode — Chrome has neither",
  },
  {
    name: "mediabunny-dts.min.mjs",
    url: `https://cdn.jsdelivr.net/npm/@mediabunny/dts@${VERSION}/dist/bundles/mediabunny-dts.min.mjs`,
    why: "DTS decode — Chrome has none",
  },
  {
    name: "mediabunny-aac-encoder.min.mjs",
    url: `https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@${VERSION}/dist/bundles/mediabunny-aac-encoder.min.mjs`,
    why: "AAC encode — WebCodecs has no AAC encoder on desktop Linux",
  },
];

/**
 * The extension bundles import the bare specifier `"mediabunny"`, which assumes a bundler.
 *
 * A browser cannot resolve that, and an import map would not help: import maps are scoped to a
 * document, and these are loaded inside a Web Worker. So the specifier is rewritten to a relative
 * path here, once, at vendor time. It is the only change made to any vendored file, and mediabunny
 * is MPL-2.0, so this modified copy stays in this public repository under that licence.
 */
function relativise(bytes) {
  const text = new TextDecoder().decode(bytes);
  const patched = text.replace(/(["'])mediabunny\1/g, '"./mediabunny.min.mjs"');
  if (patched === text) throw new Error("no `mediabunny` import to rewrite — has the build changed?");
  return new TextEncoder().encode(patched);
}

await mkdir(OUT, { recursive: true });

let failed = false;
for (const file of FILES) {
  process.stdout.write(`  ${file.name} … `);
  try {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 100_000) throw new Error(`suspiciously small: ${bytes.length} bytes`);
    if (file.name !== "mediabunny.min.mjs") bytes = relativise(bytes);
    await writeFile(join(OUT, file.name), bytes);
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    console.log(`${(bytes.length / 1024).toFixed(0)} KB  sha256:${digest}`);
  } catch (err) {
    failed = true;
    console.log(`FAILED — ${err.message}`);
  }
}

console.log(failed ? "\nsome files failed" : `\nmediabunny ${VERSION} vendored into web/vendor/`);
process.exit(failed ? 1 : 0);
