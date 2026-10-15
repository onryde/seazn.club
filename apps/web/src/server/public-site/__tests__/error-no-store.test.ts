// A public page's 404 or 5xx is never stored by a CDN or a browser (owner
// ruling 2026-10-14).
//
// Next 16.3.6 has no per-status Cache-Control for an ISR route: a page that
// calls `notFound()` keeps the route's `revalidate`, so its 404 went out as
// `s-maxage=30, stale-while-revalidate=31535970` — the found page's header,
// measured on a prod build (app-render.js sets the 404 status and keeps the
// collected revalidate; send-payload.js writes `getCacheControlHeader` for
// it). The guard rewrites the header at the one point every response passes,
// `ServerResponse.prototype.writeHead`, and only for an error status on the
// cacheable public trees (/shared, /embed — the proxy's own predicate).
//
// Through a real node HTTP server and a real client: what the guard does is
// only visible on the wire.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// instrumentation.ts's other two node-side imports: Sentry's init and the
// relay's driver-mode check. Neither is under test here.
vi.mock("@sentry/nextjs", () => ({ captureRequestError: vi.fn() }));
vi.mock("../../../../sentry.server.config", () => ({}));
vi.mock("@/server/relay/config", () => ({ relayDriverMode: vi.fn() }));

import { ERROR_NO_STORE, installPublicErrorNoStore } from "../error-no-store";
import { register } from "../../../../instrumentation";

/** What a found public page sends today (s-maxage from the page, SWR from expireTime). */
const FOUND_PAGE = "s-maxage=30, stale-while-revalidate=270";

type Write =
  | { how: "setHeader"; cacheControl?: string }
  | { how: "writeHead-object"; cacheControl: string }
  | { how: "writeHead-flat"; cacheControl: string };

/** One response: `path`, `status`, its Cache-Control written the way `write` says, plus a marker header. */
async function serve(
  path: string,
  status: number,
  write: Write,
): Promise<{ status: number; cacheControl: string | null; marker: string | null }> {
  const server = http.createServer((_req, res) => {
    const cc = write.cacheControl;
    switch (write.how) {
      case "setHeader":
        res.statusCode = status;
        if (cc) res.setHeader("Cache-Control", cc);
        res.setHeader("X-Marker", "kept");
        res.end("body");
        return;
      case "writeHead-object":
        res.writeHead(status, { "cache-control": cc!, "X-Marker": "kept" });
        res.end("body");
        return;
      case "writeHead-flat":
        // node's raw form, with a status message: [name, value, name, value].
        res.writeHead(status, "Status", ["CACHE-CONTROL", cc!, "X-Marker", "kept"] as unknown as http.OutgoingHttpHeaders);
        res.end("body");
        return;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    await res.text();
    return { status: res.status, cacheControl: res.headers.get("cache-control"), marker: res.headers.get("x-marker") };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const CASES: Array<{ name: string; path: string; status: number; write: Write; owed: string | null }> = [
  // An error on a cacheable public tree: never stored, whatever was written.
  { name: "/shared 404 (notFound) — Next's own setHeader", path: "/shared/no-org/no-cup", status: 404, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  { name: "/shared RSC 404 (query string)", path: "/shared/o/c?_rsc=abc", status: 404, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  { name: "/embed 404", path: "/embed/divisions/x/standings", status: 404, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  { name: "/shared 500 with no header", path: "/shared/o/c", status: 500, write: { how: "setHeader" }, owed: ERROR_NO_STORE },
  { name: "/embed 503", path: "/embed/x", status: 503, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  { name: "/shared 410", path: "/shared/o", status: 410, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  { name: "/shared (bare) 404", path: "/shared", status: 404, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  { name: "/shared 404 — writeHead(object)", path: "/shared/o/c", status: 404, write: { how: "writeHead-object", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  { name: "/shared 404 — writeHead(flat raw)", path: "/shared/o/c", status: 404, write: { how: "writeHead-flat", cacheControl: FOUND_PAGE }, owed: ERROR_NO_STORE },
  // Everything else is untouched.
  { name: "/shared 200 (found page)", path: "/shared/o/c", status: 200, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: FOUND_PAGE },
  { name: "/embed 200", path: "/embed/divisions/x/standings", status: 200, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: FOUND_PAGE },
  { name: "/shared 308 (rename redirect)", path: "/shared/o/old", status: 308, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: FOUND_PAGE },
  { name: "/shared 200 — writeHead(object)", path: "/shared/o/c", status: 200, write: { how: "writeHead-object", cacheControl: FOUND_PAGE }, owed: FOUND_PAGE },
  { name: "/api 404 (API headers are not this guard's)", path: "/api/v1/public/orgs/x/live", status: 404, write: { how: "setHeader", cacheControl: "public, max-age=5" }, owed: "public, max-age=5" },
  { name: "/api 500 with no header", path: "/api/v1/x", status: 500, write: { how: "setHeader" }, owed: null },
  { name: "/sharedx 404 (not the tree)", path: "/sharedx/o", status: 404, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: FOUND_PAGE },
  { name: "/dashboard 404", path: "/dashboard/x", status: 404, write: { how: "setHeader", cacheControl: FOUND_PAGE }, owed: FOUND_PAGE },
];

describe("an error on a public page is never stored: the wire header", () => {
  let uninstall: () => void = () => {};
  beforeAll(() => {
    uninstall = installPublicErrorNoStore(http.ServerResponse.prototype);
  });
  afterAll(() => uninstall());

  it("every case answers with the header it owes, and keeps its other headers (zero checked is a failure)", async () => {
    const seen: Array<{ name: string; status: number; cacheControl: string | null; marker: string | null }> = [];
    for (const c of CASES) {
      const got = await serve(c.path, c.status, c.write);
      seen.push({ name: c.name, ...got });
    }
    expect(seen.length, "cases checked").toBe(CASES.length);
    expect(seen.filter((s) => s.cacheControl === ERROR_NO_STORE).length, "premise: some cases are rewritten").toBeGreaterThan(0);
    expect(seen.filter((s) => s.cacheControl !== ERROR_NO_STORE).length, "premise: some are left alone").toBeGreaterThan(0);
    expect(seen).toEqual(
      CASES.map((c) => ({ name: c.name, status: c.status, cacheControl: c.owed, marker: "kept" })),
    );
  });

  it("installing twice patches once, and uninstall restores the original", () => {
    const proto = { writeHead: function original() {} } as unknown as typeof http.ServerResponse.prototype;
    const first = proto.writeHead;
    const off = installPublicErrorNoStore(proto);
    const patched = proto.writeHead;
    expect(patched, "patched").not.toBe(first);
    const again = installPublicErrorNoStore(proto);
    expect(proto.writeHead, "a second install is a no-op").toBe(patched);
    again();
    expect(proto.writeHead, "the no-op's uninstall leaves the patch").toBe(patched);
    off();
    expect(proto.writeHead, "uninstall restores the original").toBe(first);
  });
});

describe("instrumentation installs the guard in the node runtime, before the server takes a request", () => {
  it("after register(), a /shared 404 goes out no-store and a found page keeps its header", async () => {
    const proto = http.ServerResponse.prototype;
    const original = proto.writeHead;
    const runtime = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      await register();
      expect(proto.writeHead, "premise: register() patched writeHead").not.toBe(original);
      const missing = await serve("/shared/no-org", 404, { how: "setHeader", cacheControl: FOUND_PAGE });
      const found = await serve("/shared/o", 200, { how: "setHeader", cacheControl: FOUND_PAGE });
      expect([missing.cacheControl, found.cacheControl]).toEqual([ERROR_NO_STORE, FOUND_PAGE]);
    } finally {
      proto.writeHead = original;
      for (const sym of Object.getOwnPropertySymbols(proto)) {
        if (sym.description === "seazn.publicErrorNoStore") delete (proto as unknown as Record<symbol, unknown>)[sym];
      }
      process.env.NEXT_RUNTIME = runtime;
    }
  });
});
