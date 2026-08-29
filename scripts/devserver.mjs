#!/usr/bin/env node
/**
 * Local development server for `web/`. Node 22, zero dependencies.
 *
 * It exists for one reason beyond serving files: **bstream's CORS is an origin allowlist**, and
 * `http://localhost` is not on it, so a page served from localhost cannot call bstream directly —
 * the browser gets no `access-control-allow-origin` header and blocks the response. This proxies
 * `/bstream/*` and adds the header, so the page can be developed and tested before anything changes
 * on the VPS.
 *
 * This is a test fixture. Production is a static host (GitHub Pages) talking straight to bstream
 * from an allowlisted origin, and nothing here is deployed.
 *
 *   node scripts/devserver.mjs [--port=8080] [--bstream=https://bstream.ssimo.dev]
 *
 * Then open http://localhost:8080/?bstream=/bstream
 */

import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const port = Number(opt("port", "8080"));
const upstream = opt("bstream", "https://bstream.ssimo.dev").replace(/\/+$/, "");
const root = resolve(import.meta.dirname, "..", "web");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);

  if (url.pathname === "/bstream" || url.pathname.startsWith("/bstream/")) {
    await proxy(request, response, url);
    return;
  }
  await serveStatic(response, url.pathname);
});

async function proxy(request, response, url) {
  const target = `${upstream}${url.pathname.slice("/bstream".length) || "/"}${url.search}`;

  if (request.method === "OPTIONS") {
    response.writeHead(204, cors()).end();
    return;
  }

  try {
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readBody(request);
    const upstreamResponse = await fetch(target, {
      method: request.method,
      headers: {
        accept: request.headers.accept ?? "*/*",
        ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
      },
      ...(body === undefined ? {} : { body }),
    });
    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    console.log(`  proxy ${request.method} ${target} -> ${upstreamResponse.status} ${buffer.length}B`);
    response.writeHead(upstreamResponse.status, {
      ...cors(),
      "content-type": upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
      "content-length": String(buffer.length),
    }).end(buffer);
  } catch (err) {
    console.error(`  proxy ${request.method} ${target} failed:`, err.message);
    response.writeHead(502, { ...cors(), "content-type": "application/json" })
      .end(JSON.stringify({ error: "proxy_failed", detail: err.message }));
  }
}

const cors = () => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
});

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function serveStatic(response, pathname) {
  // `normalize` collapses `..`, and the prefix check refuses anything that escaped the root.
  const requested = pathname === "/" ? "/index.html" : pathname;
  const path = join(root, normalize(requested));
  if (!path.startsWith(root)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "content-length": String(body.length),
      // No caching: this is a dev loop, and a stale module is a confusing way to lose an hour.
      "cache-control": "no-store",
    }).end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  }
}

server.listen(port, "127.0.0.1", () => {
  console.log(`clave dev server`);
  console.log(`  page      http://localhost:${port}/?bstream=/bstream`);
  console.log(`  serving   ${root}`);
  console.log(`  proxying  /bstream/* -> ${upstream}  (adds the CORS header localhost is missing)`);
});
