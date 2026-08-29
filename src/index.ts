/**
 * The router, and nothing else.
 *
 * It touches no payload bytes on purpose. A plain Worker on the Free plan gets **10 ms of CPU per
 * invocation**, and that is the figure everyone quotes; a Durable Object request gets 30 s. So the
 * division of labour is not stylistic — every byte of video is handled inside the Durable Object,
 * and this file validates a query string, upgrades a socket and gets out of the way.
 */

import { isTorrentId, settings, type Bindings } from "./config.ts";

export { Session } from "./session.ts";

/**
 * Which Durable Object serves a request.
 *
 * Named per `(infohash, file, session)` rather than per torrent. cf-stream named per torrent
 * because R2 made its object a shared cache worth sharing; here there is no shared state to
 * protect, and `seek` and credit are per-viewer — two clients on one object would fight over one
 * cursor. Naming it also means a browser reload lands on the same object and resumes from its
 * stored plan instead of re-downloading from the start.
 *
 * A client that does not supply `s` gets the shared default, which is right for a single viewer
 * and for local work.
 */
function sessionName(infoHash: string, file: string | null, session: string | null): string {
  return `${infoHash}:${file ?? "default"}:${session ?? "default"}`;
}

function corsHeaders(env: Bindings, request: Request): Headers {
  const allowed = settings(env).corsOrigins;
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  });
  if (allowed.includes("*")) {
    headers.set("access-control-allow-origin", "*");
  } else if (origin !== null && allowed.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

function problem(status: number, code: string, detail: string, cors: Headers): Response {
  const headers = new Headers(cors);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error: code, detail }), { status, headers });
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return problem(405, "method_not_allowed", `${request.method} is not accepted`, cors);
    }

    if (url.pathname === "/healthz") {
      const headers = new Headers(cors);
      headers.set("content-type", "text/plain; charset=utf-8");
      return new Response("ok\n", { headers });
    }

    if (url.pathname === "/stream") {
      const infoHash = (url.searchParams.get("ih") ?? "").toLowerCase();
      if (!isTorrentId(infoHash)) {
        return problem(400, "bad_infohash", "ih must be a 40-character v1 infohash", cors);
      }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return problem(426, "upgrade_required", "/stream speaks WebSocket only", cors);
      }
      const name = sessionName(
        infoHash,
        url.searchParams.get("file"),
        url.searchParams.get("s"),
      );
      // The Durable Object reads `ih` and `file` off the URL, so it is forwarded as-is.
      return env.SESSION.getByName(name).fetch(request);
    }

    const debug = /^\/debug\/([0-9a-f]{40})$/.exec(url.pathname);
    if (debug !== null) {
      const name = sessionName(debug[1]!, url.searchParams.get("file"), url.searchParams.get("s"));
      // An RPC call, so reading counters cannot disturb a stream the way a request through the
      // pump would. This is the first thing to look at when a stream stalls.
      const state = await env.SESSION.getByName(name).debug();
      const headers = new Headers(cors);
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(state, null, 2), { headers });
    }

    return problem(404, "not_found", `no route for GET ${url.pathname}`, cors);
  },
} satisfies ExportedHandler<Bindings>;
