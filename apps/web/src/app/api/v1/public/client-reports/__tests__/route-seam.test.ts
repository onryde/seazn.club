// Seazn-hosted Task 25b, the seam end to end: a viewer's failure, made by the match page's REAL producers (hls.js's fatal error data
// through `hlsFailureOf`, a failed read through `routeFailureOf`), deduped by the REAL reporter, sent by the REAL beacon (a recording
// `navigator.sendBeacon`: its URL and its text/plain string body), POSTed to the REAL route, through the REAL pipeline over a REAL
// database with a real Seazn session. What comes out is the server's log line and its Sentry warning, and neither holds any part of the
// signed address the player failed on. Only Sentry's capture and Redis's windowed INCR are stand-ins.
// ONE SPORT, on purpose: nothing here reads a sport rule; the rig rides `generic`.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/cache")>()),
  incrWindow: async (key: string) => {
    const next = (counter.get(key) ?? 0) + 1;
    counter.set(key, next);
    return { count: next, ttlMs: 60_000 };
  },
}));
const sentry = vi.hoisted(() => ({ messages: [] as { message: string; context: unknown }[] }));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureMessage: (message: string, context: unknown) => void sentry.messages.push({ message, context }),
}));

import { ApiError } from "@/lib/client";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { incrWindow } from "@/lib/cache";
import { log } from "@/server/logger";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { goLive, installSeaznEnvForDescribe, seaznRigFor } from "@/server/video/__tests__/_seazn-session-rig";
import { hlsFailureOf } from "@/components/public-site/match-centre/seazn-playback";
import { beaconVideoReport, createVideoReporter } from "@/components/public-site/match-centre/seazn-video-report";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWQtYSJ9.c2lnbmF0dXJlLWE";
const HOST = "customer-q7x2k9m4.cloudflarestream.com";
const SIGNED = `https://${HOST}/${TOKEN}/manifest/video.m3u8`;
/** Every part of the address that must never reach the log line or the event. */
const FORBIDDEN = [TOKEN, HOST, "cloudflarestream", "/manifest", "m3u8", "token", "expires", "?", "://"];

describe.skipIf(!HAS_DB)("a viewer's failure, from the player's own error to the server's log line and Sentry warning", () => {
  installSeaznEnvForDescribe("client-reports-seam-test");
  const fixture = { id: "" };
  beforeAll(async () => {
    const seeded = await seedOrg();
    const auth = { ...seeded.auth, userId: await rigUser() };
    const { fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    const r = await seaznRigFor(auth, fixtureIds as [string, string]);
    fixture.id = fixtureIds[0]!;
    await goLive(r, fixture.id, r.seazn);
  });

  let warn: ReturnType<typeof vi.spyOn>;
  const beacons: { url: string; body: string }[] = [];
  beforeEach(() => {
    counter.clear();
    sentry.messages.length = 0;
    beacons.length = 0;
    __setRateLimitCounterForTests((key, windowSeconds) => incrWindow(key, windowSeconds));
    vi.stubGlobal("navigator", { sendBeacon: (url: string, body: string) => (beacons.push({ url, body }), true) });
    warn = vi.spyOn(log, "warn");
  });
  afterEach(() => {
    __setRateLimitCounterForTests(null);
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  /** Each recorded beacon, POSTed to the route as the browser sends it: its URL, a text/plain string, the viewer's IP. */
  const deliver = async () => {
    const statuses: number[] = [];
    for (const { url, body } of beacons) {
      const res = await POST(new Request(`http://app.test${url}`, {
        method: "POST", body, headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.90" },
      }));
      statuses.push(res.status);
    }
    return statuses;
  };

  it("a fatal hls.js error whose data quotes the signed address: one line and one warning, codes only; the same address again sends nothing", async () => {
    const reporter = createVideoReporter(beaconVideoReport);
    // hls.js's own error data: its URL, the response text and the error message each quote the signed address.
    const failure = hlsFailureOf({
      type: "networkError", details: "manifestLoadError", fatal: true, url: SIGNED,
      response: { code: 403, text: `Forbidden: ${SIGNED}` }, error: new Error(`HTTP Error 403 Forbidden loading ${SIGNED}`),
    });
    reporter.player(fixture.id, { address: SIGNED, source: "live", partNo: null, player: "hls", failure });
    reporter.player(fixture.id, { address: SIGNED, source: "live", partNo: null, player: "hls", failure });
    expect(beacons, "the reporter's dedupe: one beacon for the address").toHaveLength(1);
    expect(await deliver()).toEqual([204]);
    const own = warn.mock.calls.filter((c: unknown[]) => c[1] === "seazn video: the player gave up");
    expect(own.map((c: unknown[]) => c[0])).toEqual([{
      clientReport: "video", fixtureId: fixture.id, stage: "player", source: "live", partNo: null, player: "hls", reason: "hls",
      hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null,
    }]);
    expect(sentry.messages.map((m) => [m.message, (m.context as { level: string }).level])).toEqual([["seazn video: the player gave up", "warning"]]);
    let checked = 0;
    for (const bit of FORBIDDEN) {
      expect(JSON.stringify([own, sentry.messages, beacons]).includes(bit), `"${bit}" reached the log, the event or the beacon`).toBe(false);
      checked++;
    }
    expect(checked).toBe(FORBIDDEN.length);
  });

  it("a failed read of the route, twice, then a second viewer's: one beacon each, two lines, one warning (the window's dedupe)", async () => {
    createVideoReporter(beaconVideoReport).route(fixture.id, new ApiError("Request failed (503)", 503));
    createVideoReporter(beaconVideoReport).route(fixture.id, new ApiError("Request failed (503)", 503));
    expect(beacons).toHaveLength(2);
    expect(await deliver()).toEqual([204, 204]);
    const own = warn.mock.calls.filter((c: unknown[]) => c[1] === "seazn video: the video route could not be read");
    expect(own, "every accepted report is a line").toHaveLength(2);
    expect(sentry.messages, "one warning per fixture and reason in the window").toHaveLength(1);
    expect((sentry.messages[0]!.context as { tags: Record<string, string> }).tags).toEqual({
      client_report: "video", area: "seazn-video", event: "route_read_failed", reason: "http", fixture_id: fixture.id,
    });
  });
});
