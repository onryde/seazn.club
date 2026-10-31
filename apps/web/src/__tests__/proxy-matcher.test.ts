// proxy.ts's matcher, judged by Next's OWN matcher compiler (`unstable_doesMiddlewareMatch`, next/experimental/testing).
//
// Capture record upload (spec 2026-10-12 §5, review fix 5 on PR #943): while proxy runs on a path, Next buffers the
// request body — up to `proxyClientMaxBodySize`, 10 MB by default — BEFORE the route's own 1 MB raw cap, its rate
// limit and its auth. The records route is Bearer-only and cookie-less, so the one thing proxy does for an /api POST
// (the CSRF Origin check) guards nothing there; the records path alone is left out of the matcher, and every other
// path — the other capture routes, every other /api route, every page — still runs proxy.
//
// R4 S9: the sponsor frame upload (`/api/internal/relay/sessions/{sid}/airings/{momentId}/frame`) is left out for the
// same reason: a 256 KiB JPEG, Bearer-only (the relay job token) and cookie-less, whose route reads the body under its
// own bound — which proxy's 10 MB buffering would otherwise come before.
//
// ONE SPORT, on purpose: not applicable — a matcher reads no sport.
import { describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's testing entry reads its request storage at import; under vitest's node environment it is not installed.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
const { config } = await import("@/proxy");

const matchesAsGiven = (url: string): boolean => unstable_doesMiddlewareMatch({ config, nextConfig: {}, url });
/** Whether proxy runs on `url` IN PRODUCTION. `unstable_doesMiddlewareMatch` tries the path as given only, but a server
 *  tries it as given AND decoded once (next/dist/server/lib/router-utils/resolve-routes.js: `match(parsedUrl.pathname)
 *  || match(decodeURIComponent(…))`, the decode skipped when it throws) — so a test of the raw path alone would excuse a
 *  `%2F` that the server decodes into a path proxy runs on (S9 review m2). */
const runs = (url: string): boolean => {
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* the server matches the raw path only */ }
  return matchesAsGiven(url) || matchesAsGiven(decoded);
};

describe("proxy matcher (review fix 5)", () => {
  it("the records path — with or without a trailing slash, any code — never runs proxy, so Next never buffers its body", () => {
    const skipped = ["/api/v1/capture/codes/abcdefghjkmn/records", "/api/v1/capture/codes/abcdefghjkmn/records/", "/api/v1/capture/codes/x/records"];
    let checked = 0;
    for (const url of skipped) {
      expect(runs(url), url).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("R4 S9: the sponsor frame upload — SC2's percent-encoded break and scene ids, with or without a trailing slash — never runs proxy", () => {
    const sid = "0b5f6f1e-8c8e-4c1a-9a51-6f1d2b3c4d5e";
    const skipped = [
      `/api/internal/relay/sessions/${sid}/airings/12%3Asponsor.over_end/frame`,
      `/api/internal/relay/sessions/${sid}/airings/12%3Asponsor.over_end/frame/`,
      `/api/internal/relay/sessions/${sid}/airings/scene%3Astarting%3A173000000/frame`,
      `/api/internal/relay/sessions/${sid}/airings/50%/frame`,
    ];
    let checked = 0;
    for (const url of skipped) {
      expect(runs(url), url).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("R4 S9 (review m2): `runs` is the server's raw-OR-decoded rule — an encoded slash decodes into a path proxy runs on, though the raw path alone would not match", () => {
    const url = "/api/internal/relay/sessions/sid-1/airings/a%2Fb/frame";
    expect(matchesAsGiven(url), "premise: the raw path alone is excluded").toBe(false);
    expect(runs(url), "the server decodes it to …/airings/a/b/frame and runs proxy").toBe(true);
  });

  it("everything else still runs it: the other capture routes, near misses of the records path, other /api routes and pages — counted", () => {
    const kept = [
      "/api/v1/capture/codes/abcdefghjkmn/beats", "/api/v1/capture/codes/abcdefghjkmn/start", "/api/v1/capture/codes/abcdefghjkmn",
      "/api/v1/capture/codes/x/scoring-link",
      "/api/v1/capture/codes/abcdefghjkmn/records-x", "/api/v1/capture/codes/a/b/records", "/api/v1/capture/records",
      "/api/v1/competitions/c1/exports/scorer-sheets", "/api/orgs", "/api", "/", "/admin/capture-records", "/fr/start",
    ];
    let checked = 0;
    for (const url of kept) {
      expect(runs(url), url).toBe(true);
      checked++;
    }
    expect(checked).toBe(13);
    // R4 S9's near misses: the session's other internal routes and paths that only look like the frame upload.
    const relayKept = [
      "/api/internal/relay/sessions/sid-1", "/api/internal/relay/sessions/sid-1/heartbeat",
      "/api/internal/relay/sessions/sid-1/airings/12%3Asponsor.over_end", "/api/internal/relay/sessions/sid-1/airings/12%3Asponsor.over_end/frame-x",
      "/api/internal/relay/sessions/sid-1/airings/12%3Asponsor.over_end/frame/x", "/api/internal/relay/sessions/sid-1/airings/a/b/frame",
      "/api/internal/relay/sessions/airings/m/frame", "/api/internal/relay/sessions/sid-1/airings/a%2Fb/frame",
    ];
    let relayChecked = 0;
    for (const url of relayKept) {
      expect(runs(url), url).toBe(true);
      relayChecked++;
    }
    expect(relayChecked).toBe(8);
    // Next's own exclusions stay excluded.
    expect(runs("/_next/static/chunk.js")).toBe(false);
    expect(runs("/favicon.ico")).toBe(false);
  });
});
