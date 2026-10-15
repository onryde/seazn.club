// A public page's 404 or 5xx is never stored by a CDN or a browser (owner
// ruling 2026-10-14).
//
// Next 16.3.6 cannot say this itself. An ISR page that calls `notFound()` is
// rendered with the route's own `revalidate` (app-render.js keeps the
// collected revalidate when it recovers the 404), so the 404 leaves with the
// FOUND page's header — `s-maxage=30, stale-while-revalidate=…` — and there is
// no config, `headers()` rule or proxy hook that can see the status (the proxy
// runs before the render; a `headers()` Cache-Control would apply to found
// pages too, and Next would keep it). A `revalidate = 0` not-found boundary is
// not an option either: in an ISR route it throws "Page changed from static to
// dynamic at runtime" and serves a 500 (see (public)/shared/[orgSlug]/not-found.tsx).
//
// So the header is fixed on the wire: `installPublicErrorNoStore` wraps
// `ServerResponse.prototype.writeHead` — the call every node response makes,
// explicitly or through `end()` — and, for a status of 400 or more on a
// cacheable public path (the proxy's own `isCacheablePublicPath`: /shared,
// /embed), replaces any Cache-Control with the value Next itself sends for an
// uncacheable response. Every other response is untouched: found pages, a
// redirect, and every /api path keep exactly what they had.
//
// What this does NOT change: Next's own server-side ISR cache still keeps the
// rendered 404 for the route's `revalidate` (30 s). The data under it is never
// cached as missing (cache-found.ts), and the writes that make a page appear
// expire its tags in their own request (#954), which drops that entry.
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { isCacheablePublicPath } from "@/proxy";

/** Exactly what Next sends for a response nobody may store (getCacheControlHeader, revalidate 0). */
export const ERROR_NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

const INSTALLED = Symbol.for("seazn.publicErrorNoStore");

/** Whether a response of `status` for `url` must not be stored by any cache. */
export function mustNotStore(url: string | undefined, status: number): boolean {
  if (!(status >= 400) || !url) return false;
  const query = url.indexOf("?");
  return isCacheablePublicPath(query === -1 ? url : url.slice(0, query));
}

const isCacheControl = (name: unknown) => typeof name === "string" && name.toLowerCase() === "cache-control";

/** `writeHead`'s own headers argument (an object, or node's flat `[name, value, …]` list), minus any
 *  Cache-Control: node merges it OVER what `setHeader` wrote. */
function withoutCacheControl(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    const kept: unknown[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      if (!isCacheControl(headers[i])) kept.push(headers[i], headers[i + 1]);
    }
    return kept;
  }
  if (headers && typeof headers === "object") {
    return Object.fromEntries(Object.entries(headers as OutgoingHttpHeaders).filter(([name]) => !isCacheControl(name)));
  }
  return headers;
}

/**
 * Wrap `proto.writeHead` so an error on a cacheable public path is sent
 * `no-store`. Idempotent; returns the uninstall (a no-op for a repeat install).
 */
export function installPublicErrorNoStore(proto: ServerResponse): () => void {
  const marked = proto as ServerResponse & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return () => {};
  const original = proto.writeHead;
  const writeHead = function (this: ServerResponse, statusCode: number, ...rest: unknown[]) {
    if (!this.headersSent && mustNotStore(this.req?.url, statusCode)) {
      this.setHeader("Cache-Control", ERROR_NO_STORE);
      const last = rest.length - 1;
      if (last >= 0 && typeof rest[last] === "object") rest[last] = withoutCacheControl(rest[last]);
    }
    return (original as (...args: unknown[]) => ServerResponse).call(this, statusCode, ...rest);
  };
  proto.writeHead = writeHead as ServerResponse["writeHead"];
  marked[INSTALLED] = true;
  return () => {
    proto.writeHead = original;
    delete marked[INSTALLED];
  };
}
