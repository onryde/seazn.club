// Seazn-hosted video Task 25 (coordinator's addition, owner: viewer-side failures visible through Sentry, NOT PostHog): when the match
// page's player gives up on an address, and when the island's read of the video route fails, ONE report is sent — once per address for a
// player, once per kind of failure for the route — with the fixture, the part, the player's kind, live or replay, and the failure's
// CODES (hls.js's type/details, the HTTP status). Never the address, its token, its `expires`, or any query.
//
// The failures come from their REAL producers: hls.js's fatal error through the playback controller (a recording fake of hls.js, as
// seazn-playback.test.ts drives it, whose error data carries the signed URL and a message quoting it, as hls.js's does), and the
// route's failures from `api()` (lib/client.ts) and the island's own answer check. The send (Task 25b) is a beacon to OUR server's
// client-report route, here a recording `navigator.sendBeacon` (and a recording `fetch` for the fallback), and every body sent is parsed
// with the route's REAL schema (server/client-reports/kinds.ts `ClientReport`), so the client cannot send a body the route refuses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: string, data: unknown) => void;
const hls = vi.hoisted(() => ({ instances: [] as { handlers: Map<string, Handler> }[] }));
vi.mock("hls.js", () => {
  class FakeHls {
    static Events = { ERROR: "hlsError" };
    static isSupported() {
      return true;
    }
    config: Record<string, unknown>;
    handlers = new Map<string, Handler>();
    constructor(config: Record<string, unknown>) {
      this.config = config;
      hls.instances.push(this);
    }
    attachMedia() {}
    loadSource() {}
    startLoad() {}
    destroy() {}
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }
  }
  return { default: FakeHls };
});

import { ApiError } from "@/lib/client";
import { CLIENT_REPORTS_PATH } from "@/lib/client-reports";
import { ClientReport } from "@/server/client-reports/kinds";
import { createPlayback, hlsFailureOf, type PlaybackFailure } from "../seazn-playback";
import { asPublicFixtureVideo } from "../seazn-video-island";
import { beaconVideoReport, createVideoReporter, routeFailureOf, videoReportRequest, type VideoFailureReport } from "../seazn-video-report";

const FIXTURE = "8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d";
const TOKEN_A = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWQtYSJ9.c2lnbmF0dXJlLWE";
const TOKEN_B = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWQtYiJ9.c2lnbmF0dXJlLWI";
const HOST = "customer-q7x2k9m4.cloudflarestream.com";
const addr = (token: string) => `https://${HOST}/${token}/manifest/video.m3u8`;
const EMBED = `https://iframe.mediadelivery.net/embed/424242/3f1c2a9e?token=${"ab".repeat(32)}&expires=1795000000`;

/** Every part of an address that must never reach a report. */
const FORBIDDEN = [TOKEN_A, TOKEN_B, HOST, "cloudflarestream", "/manifest", "m3u8", "mediadelivery", "expires", "token", "?", "://", "/api/"];
function expectNoUrl(payload: unknown): number {
  const sent = JSON.stringify(payload);
  let checked = 0;
  for (const bit of FORBIDDEN) {
    expect(sent, `the report carries "${bit}"`).not.toContain(bit);
    checked++;
  }
  return checked;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
/** A hls.js player under the REAL controller; answers its fatal hls.js error, raised with hls.js's own data shape. */
async function hlsFatal(src: string): Promise<PlaybackFailure> {
  const video = { canPlayType: () => "", addEventListener() {}, removeEventListener() {}, currentTime: 0, duration: Number.NaN, paused: true, ended: false };
  const seen: PlaybackFailure[] = [];
  const playback = createPlayback(video as unknown as HTMLVideoElement, { onFatal: (f) => void seen.push(f) });
  playback.setSource(src);
  await flush();
  const raise = hls.instances.at(-1)!.handlers.get("hlsError")!;
  raise("hlsError", {
    type: "networkError", details: "manifestLoadError", fatal: true, url: src,
    response: { code: 403, text: `Forbidden: ${src}` },
    error: new Error(`HTTP Error 403 Forbidden loading ${src}`),
    networkDetails: { responseURL: src },
  });
  playback.dispose();
  expect(seen, "premise: the controller reported the fatal error once").toHaveLength(1);
  return seen[0]!;
}

beforeEach(() => {
  hls.instances.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the controller's failure: codes only, from hls.js's own error data", () => {
  it("a fatal hls.js error yields its type, details and HTTP status, and no part of the URL or the message that quotes it", async () => {
    const f = await hlsFatal(addr(TOKEN_A));
    expect(f).toEqual({ reason: "hls", hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null });
    expect(expectNoUrl(f)).toBe(FORBIDDEN.length);
  });
});

describe("hlsFailureOf — a code is a bare word and a status is an HTTP status, or nothing", () => {
  it("a URL where a code should be, a status that is not a number, and no data at all each read as null", () => {
    expect(hlsFailureOf({ type: addr(TOKEN_A), details: `manifestLoadError ${addr(TOKEN_A)}`, response: { code: "403" } }))
      .toEqual({ reason: "hls", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null });
    expect(hlsFailureOf({ type: "mediaError", details: "bufferStalledError", response: { code: 0 } }))
      .toEqual({ reason: "hls", hlsType: "mediaError", hlsDetails: "bufferStalledError", httpStatus: null, mediaCode: null });
    expect(hlsFailureOf(undefined)).toEqual({ reason: "hls", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null });
  });
  it("a bare word that names a credential (the beacon route refuses one, lib/client-reports.ts) reads as null too, in either case", () => {
    expect(hlsFailureOf({ type: "accessToken", details: "linkEXPIRES" }))
      .toEqual({ reason: "hls", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null });
  });
});

describe("createVideoReporter — once per address, never the address", () => {
  const reporter = () => {
    const sent: VideoFailureReport[] = [];
    return { sent, r: createVideoReporter((x) => void sent.push(x)) };
  };

  it("EMPTY CASE FIRST: nothing failed, nothing is sent", () => {
    const { sent } = reporter();
    expect(sent).toEqual([]);
  });

  it("a fatal hls.js error on a replay part: ONE report per address — the same address failing again (the rebuilt player) sends nothing more; a fresh address is a new report", async () => {
    const { sent, r } = reporter();
    const a = await hlsFatal(addr(TOKEN_A));
    r.player(FIXTURE, { address: addr(TOKEN_A), source: "replay", partNo: 2, player: "hls", failure: a });
    r.player(FIXTURE, { address: addr(TOKEN_A), source: "replay", partNo: 2, player: "hls", failure: a });
    expect(sent).toEqual([
      { stage: "player", fixtureId: FIXTURE, source: "replay", partNo: 2, player: "hls", reason: "hls", hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null },
    ]);
    const b = await hlsFatal(addr(TOKEN_B));
    r.player(FIXTURE, { address: addr(TOKEN_B), source: "replay", partNo: 2, player: "hls", failure: b });
    expect(sent, "a fresh address that fails is reported").toHaveLength(2);
    expect(expectNoUrl(sent)).toBe(FORBIDDEN.length);
  });

  it("the live: partNo null and source live; an embed address keyed the same way and never sent", () => {
    const { sent, r } = reporter();
    const f: PlaybackFailure = { reason: "element", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: 2 };
    r.player(FIXTURE, { address: addr(TOKEN_A), source: "live", partNo: null, player: "hls", failure: f });
    r.player(FIXTURE, { address: EMBED, source: "replay", partNo: 1, player: "embed", failure: f });
    r.player(FIXTURE, { address: EMBED, source: "replay", partNo: 1, player: "embed", failure: f });
    expect(sent.map((x) => [x.source, x.partNo, x.player, x.reason, x.mediaCode])).toEqual([["live", null, "hls", "element", 2], ["replay", 1, "embed", "element", 2]]);
    expect(expectNoUrl(sent)).toBe(FORBIDDEN.length);
  });

  it("the route: once per kind of failure (a status, a network failure, a timeout, a bad answer), whatever the backoff retries", async () => {
    const { sent, r } = reporter();
    const http503 = new ApiError("Request failed (503)", 503);
    for (let i = 0; i < 3; i++) r.route(FIXTURE, http503);
    r.route(FIXTURE, new ApiError("Request failed (429)", 429));
    r.route(FIXTURE, new TypeError("Failed to fetch"));
    r.route(FIXTURE, new DOMException("signal is aborted without reason", "AbortError"));
    let bad: unknown = null;
    try {
      asPublicFixtureVideo({ live: { src: addr(TOKEN_A) }, replay: [] });
    } catch (e) {
      bad = e;
    }
    expect(bad, "premise: the island's own check refused the answer").not.toBeNull();
    r.route(FIXTURE, bad);
    r.route(FIXTURE, bad);
    expect(sent.map((x) => [x.stage, x.reason, x.httpStatus])).toEqual([
      ["route", "http", 503], ["route", "http", 429], ["route", "network", null], ["route", "timeout", null], ["route", "answer", null],
    ]);
    expect(sent.every((x) => x.fixtureId === FIXTURE && x.source === null && x.partNo === null && x.player === null)).toBe(true);
    expect(expectNoUrl(sent)).toBe(FORBIDDEN.length);
  });

  it("routeFailureOf reads the status of an ApiError and nothing of a message", () => {
    expect(routeFailureOf(new ApiError(`refused ${addr(TOKEN_A)}`, 502))).toEqual({ reason: "http", httpStatus: 502 });
    expect(routeFailureOf("a string")).toEqual({ reason: "network", httpStatus: null });
  });
});

describe("beaconVideoReport — the send is a beacon to our server's client-report route", () => {
  type Sent = { url: string; body: string };
  const beacons = (answer: boolean | "throw" = true) => {
    const sent: Sent[] = [];
    vi.stubGlobal("navigator", {
      sendBeacon: (url: string, body: string) => {
        if (answer === "throw") throw new TypeError("Illegal invocation");
        sent.push({ url, body });
        return answer;
      },
    });
    return sent;
  };
  const fetches = () => {
    const sent: (Sent & { init: RequestInit })[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body), init });
      return new Response(null, { status: 204 });
    });
    return sent;
  };
  /** Two reports through the REAL reporter, as the island makes them: a fatal hls.js error (twice, one address) and a failed read. */
  const twoReports = async (send: (r: VideoFailureReport) => void): Promise<VideoFailureReport[]> => {
    const reports: VideoFailureReport[] = [];
    const r = createVideoReporter((x) => {
      reports.push(x);
      send(x);
    });
    r.player(FIXTURE, { address: addr(TOKEN_A), source: "replay", partNo: 1, player: "hls", failure: await hlsFatal(addr(TOKEN_A)) });
    r.player(FIXTURE, { address: addr(TOKEN_A), source: "replay", partNo: 1, player: "hls", failure: await hlsFatal(addr(TOKEN_A)) });
    r.route(FIXTURE, new ApiError("Request failed (503)", 503));
    return reports;
  };

  it("one beacon per report, to the route's path, its body the report with kind `video` — which the route's own schema takes as it is", async () => {
    const sent = beacons();
    const f = fetches();
    const reports = await twoReports(beaconVideoReport);
    expect(sent, "one per report").toHaveLength(2);
    expect(f, "the beacon was taken: no fetch").toEqual([]);
    let checked = 0;
    for (const [i, { url, body }] of sent.entries()) {
      expect(url).toBe(CLIENT_REPORTS_PATH);
      expect(ClientReport.parse(JSON.parse(body)), "the route's schema takes the body unchanged").toEqual({ kind: "video", ...reports[i]! });
      checked++;
    }
    expect(checked).toBe(2);
    expect(expectNoUrl(sent.map((s) => s.body))).toBe(FORBIDDEN.length);
  });

  it("a beacon the browser will not queue (false), one that throws, and no beacon at all: the same body by a keepalive fetch", async () => {
    let checked = 0;
    for (const setup of [() => beacons(false), () => beacons("throw"), () => vi.stubGlobal("navigator", {})] as const) {
      setup();
      const f = fetches();
      const reports = await twoReports(beaconVideoReport);
      expect(f).toHaveLength(2);
      for (const [i, { url, body, init }] of f.entries()) {
        expect([url, init.method, init.keepalive]).toEqual([CLIENT_REPORTS_PATH, "POST", true]);
        expect(body).toBe(videoReportRequest(reports[i]!).body);
        checked++;
      }
      vi.unstubAllGlobals();
    }
    expect(checked).toBe(6);
  });

  it("a send that fails never throws into the page: a rejected fetch, and no fetch at all", async () => {
    beacons(false);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(() => beaconVideoReport({ stage: "route", fixtureId: FIXTURE, source: null, partNo: null, player: null, reason: "network", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    vi.stubGlobal("fetch", undefined);
    expect(() => beaconVideoReport({ stage: "route", fixtureId: FIXTURE, source: null, partNo: null, player: null, reason: "network", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null })).not.toThrow();
  });
});
