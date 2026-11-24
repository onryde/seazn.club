// Task 22: the Bunny Stream adapter (BunnyReplayHost) against a mocked fetch. No network: every answer below is a fixture
// shaped like what the probes measured (docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md, cited by id B1–B10).
// Expected token values come from the published formulas (B4, B5), never from the adapter: once as literals computed
// outside this repo's code (shasum/openssl, 2026-11-21), and once more from the formula for a second vector.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BunnyConfig } from "@/server/relay/config";
import { FakeRecorder } from "@/server/relay/fakes";
import { pathTemplate } from "@/server/relay/sanitise";
import { bunnyResolutionsBody } from "./_bunny-resolutions";
import { BunnyReplayHost, WATCH_TIME_CHART_SECONDS_PER_UNIT, mp4HeightsIn } from "../replay-bunny";
import { type ReplayHost, ReplayHostRefused, ReplayHostUnavailable, ReplayNotDownloadable } from "../replay-ports";

const CONFIG: BunnyConfig = {
  libraryId: "424242",
  apiKey: "ZZ-api-key-4b8d0a17",
  readOnlyKey: "ZZ-readonly-key-c55e",
  cdnHost: "vz-test0001.b-cdn.net",
  tokenKey: "ZZ-token-key-7f3e91c2",
};
/** Recognisable on purpose: any of them in a message, a record or a log line is a leak. */
const SECRETS = [CONFIG.apiKey, CONFIG.readOnlyKey, CONFIG.tokenKey];
const API = "https://video.bunnycdn.com/library/424242";
const GUID = "3f1c2a9e-0b7d-4c55-9a61-2d8e4f7b1c03";
/** 250 ms past the second, so an expiry built from milliseconds instead of whole seconds shows. */
const NOW = new Date("2026-11-21T10:00:00.250Z");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = { status: number; body?: unknown } | Response;

function harness(reply: (c: Call) => Reply | Promise<Reply>, origins: string[] | null = ["stg.seazn.club", "seazn.club"]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()), // names lower-cased
      body: init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(c);
    const r = await reply(c);
    if (r instanceof Response || "ok" in r) return r as Response; // a real Response, or a hand-built one (cdnAnswer)
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const recorder = new FakeRecorder();
  const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => origins });
  return { host, calls, recorder };
}

const errorOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error("expected a rejection, got an answer");
};

/** A Bunny `GET /videos/{id}` body (the fields the probe read, B7/B9). */
const videoBody = (o: { status: number; resolutions?: string | null; length?: number; title?: string }) => ({
  guid: GUID, title: o.title ?? "Final, part 1", status: o.status, length: o.length ?? 0, collectionId: "c1",
  availableResolutions: o.resolutions ?? null, hasMP4Fallback: true,
});

/** The `/resolutions` answer in the shape stg returned (_bunny-resolutions.ts). */
const mp4Body = (heights: readonly number[], o: { storage?: readonly number[]; success?: boolean } = {}) => bunnyResolutionsBody({ guid: GUID, mp4: heights, ...o });
/** The API's answer to a playable video with one 720 rendition and one 720 file: `GET /videos/{id}` or `GET /videos/{id}/resolutions`. */
const playable720 = (url: string): { status: number; body: unknown } =>
  url.endsWith("/resolutions") ? { status: 200, body: mp4Body([720]) } : { status: 200, body: videoBody({ status: 4, resolutions: "720p" }) };

describe("BunnyReplayHost: the API calls (AccessKey header, library base URL)", () => {
  it("createCollection POSTs the name org:<orgId> and answers the guid; an answer with no guid throws", async () => {
    const { host, calls } = harness(() => ({ status: 200, body: { guid: "col-1", name: "org:o1", videoCount: 0 } }));
    expect(await host.createCollection("o1")).toBe("col-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${API}/collections`, method: "POST", body: { name: "org:o1" } });
    expect(calls[0].headers.accesskey).toBe(CONFIG.apiKey);

    const none = harness(() => ({ status: 200, body: { name: "org:o1" } }));
    expect(await errorOf(none.host.createCollection("o1"))).toMatch(/no collection id/);
  });

  it("fetchFromUrl POSTs /videos/fetch?collectionId=c1 with {url, title} and answers the reply's id (B1, B7); no id throws", async () => {
    const src = "https://customer-x.cloudflarestream.com/abc/downloads/default.mp4";
    const { host, calls } = harness(() => ({ status: 200, body: { id: GUID, message: "OK", statusCode: 200, success: true } }));
    expect(await host.fetchFromUrl({ collectionId: "c1", title: "Final, part 1", url: src })).toBe(GUID);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${API}/videos/fetch?collectionId=c1`, method: "POST", body: { url: src, title: "Final, part 1" } });
    expect(calls[0].headers.accesskey).toBe(CONFIG.apiKey);
    expect(calls[0].headers["content-type"]).toBe("application/json");

    const noId = harness(() => ({ status: 200, body: { message: "OK", statusCode: 200, success: true } }));
    expect(await errorOf(noId.host.fetchFromUrl({ collectionId: "c1", title: "t", url: src }))).toMatch(/no video id/);
    const refused = harness(() => ({ status: 500, body: { message: "boom" } }));
    expect(await errorOf(refused.host.fetchFromUrl({ collectionId: "c1", title: "t", url: src }))).toMatch(/HTTP 500/);
  });

  it("video maps the video API's status table (Task 21's ruling) and a 404 to absent; an unknown status throws", async () => {
    // The table as Task 21 states it: 4 playable; 5 and 6 failed; 0-3, 7 and 8 processing (B2 saw 2 -> 3 -> 4).
    const TABLE: [number, string][] = [
      [0, "processing"], [1, "processing"], [2, "processing"], [3, "processing"], [4, "playable"],
      [5, "failed"], [6, "failed"], [7, "processing"], [8, "processing"],
    ];
    let checked = 0;
    for (const [status, state] of TABLE) {
      const { host, calls } = harness(() => ({ status: 200, body: videoBody({ status }) }));
      expect((await host.video(GUID)).state, `status ${status}`).toBe(state);
      expect(calls[0]).toMatchObject({ url: `${API}/videos/${GUID}`, method: "GET" });
      checked++;
    }
    expect(checked).toBe(9);

    const gone = harness(() => ({ status: 404, body: { message: "not found" } }));
    expect(await gone.host.video(GUID)).toEqual({ state: "absent", lengthSeconds: null, title: null, heights: [] });

    const unknown = harness(() => ({ status: 200, body: videoBody({ status: 9 }) }));
    const message = await errorOf(unknown.host.video(GUID));
    expect(message).toMatch(/status 9/);
    expect(message).toContain(GUID);

    const failed = harness(() => ({ status: 503 }));
    expect(await errorOf(failed.host.video(GUID))).toMatch(/HTTP 503/);
  });

  it("video reads length and title, and a length of 0 (not read yet) as null", async () => {
    const done = harness(() => ({ status: 200, body: videoBody({ status: 4, length: 183, title: "Final, part 2", resolutions: "240p,360p" }) }));
    expect(await done.host.video(GUID)).toMatchObject({ state: "playable", lengthSeconds: 183, title: "Final, part 2" });
    const early = harness(() => ({ status: 200, body: videoBody({ status: 2, length: 0 }) }));
    expect(await early.host.video(GUID)).toMatchObject({ state: "processing", lengthSeconds: null, heights: [] });
  });

  it("heights: availableResolutions is parsed, unordered (B9), with NO ceiling: a 1080 is listed, and nothing is warned or dropped (Task 48)", async () => {
    const { host, calls } = harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "360p,480p,720p,240p,1080p" }) }));
    const v = await host.video(GUID);
    expect([...v.heights].sort((a, b) => a - b)).toEqual([240, 360, 480, 720, 1080]);
    await host.video(GUID);
    expect(calls, "the HLS list is read from the video body alone: no second endpoint").toHaveLength(2);
    expect(calls.every((c) => c.url === `${API}/videos/${GUID}`)).toBe(true);

    const repeated = harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "720p, 720p,abc,,0p,1080p" }) }));
    expect([...(await repeated.host.video(GUID)).heights].sort((a, b) => a - b), "repeats, junk and zero dropped").toEqual([720, 1080]);
  });

  it("remove GETs first: a present video is DELETEd and reads deleted; a second remove reads absent though DELETE answers 200 again (B10)", async () => {
    let present = true;
    const { host, calls } = harness((c) => {
      if (c.method === "DELETE") { present = false; return { status: 200, body: { success: true } } } // 200 every time (B10)
      return present ? { status: 200, body: videoBody({ status: 4 }) } : { status: 404 };
    });
    expect(await host.remove(GUID)).toBe("deleted");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/videos/${GUID}`, `DELETE ${API}/videos/${GUID}`]);
    expect(await host.remove(GUID)).toBe("absent");
    expect(calls.filter((c) => c.method === "DELETE"), "an absent video is not deleted again").toHaveLength(1);
    expect((await host.video(GUID)).state).toBe("absent");
    for (const c of calls) expect(c.headers.accesskey).toBe(CONFIG.apiKey);
  });

  it("remove: a present video whose DELETE fails is never reported deleted (one DELETE, the status and the id in the message)", async () => {
    const { host, calls } = harness((c) => (c.method === "DELETE" ? { status: 500, body: { message: "boom" } } : { status: 200, body: videoBody({ status: 4 }) }));
    const message = await errorOf(host.remove(GUID));
    expect(message).toMatch(/remove: HTTP 500/);
    expect(message).toContain(GUID);
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });

});

// Task 30: the statistics read. `GET /library/{lib}/statistics?videoGuid=&dateFrom=&dateTo=` (Bunny's "Get Video Statistics", read
// 2026-11-23: dateFrom/dateTo are UTC date-times, videoGuid filters to one video, and an omitted or INVALID dateFrom answers the
// last 30 days instead of an error). `watchTimeChart` maps each UTC interval to an int64 "total watch time" whose unit the docs do
// not state: WATCH_TIME_CHART_SECONDS_PER_UNIT holds it, measured as seconds by the Task 20 probe's B11 (2026-11-23).
describe("BunnyReplayHost: watchMinutes (Task 30)", () => {
  const FROM = new Date("2026-11-01T00:00:00.000Z");
  const TO = new Date("2026-11-22T23:59:59.999Z");
  const stats = (watchTimeChart: unknown) => ({
    viewsChart: { "2026-11-01T00:00:00Z": 2 }, watchTimeChart, countryViewCounts: {}, countryWatchTime: {}, engagementScore: 0,
  });

  it("the unit: one watchTimeChart unit is ONE SECOND (Bunny does not document it; measured by the Task 20 probe's B11, 2026-11-23: 119 units for 183.1 s played)", () => {
    expect(WATCH_TIME_CHART_SECONDS_PER_UNIT).toBe(1);
  });

  it("GETs /statistics with videoGuid, dateFrom and dateTo (ISO instants) and the AccessKey header, and sums watchTimeChart {a:60,b:30} to the minutes it means", async () => {
    const { host, calls } = harness(() => ({ status: 200, body: stats({ a: 60, b: 30 }) }));
    const port: ReplayHost = host; // called as the application layer calls it
    // {a:60, b:30} is 90 units; a unit is WATCH_TIME_CHART_SECONDS_PER_UNIT seconds; a minute is 60 seconds.
    expect(await port.watchMinutes(GUID, FROM, TO)).toBe((90 * WATCH_TIME_CHART_SECONDS_PER_UNIT) / 60);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${API}/statistics`);
    expect(calls[0].method).toBe("GET");
    expect([...url.searchParams.entries()]).toEqual([
      ["videoGuid", GUID], ["dateFrom", "2026-11-01T00:00:00.000Z"], ["dateTo", "2026-11-22T23:59:59.999Z"],
    ]);
    expect(calls[0].headers.accesskey).toBe(CONFIG.apiKey);
    for (const s of SECRETS) expect(calls[0].url).not.toContain(s);
  });

  it("a null chart (the schema's 'nullable': no watch data) and an empty one read 0; an answer with NO chart, or a value that is not a count, throws", async () => {
    for (const chart of [null, {}]) {
      const { host } = harness(() => ({ status: 200, body: stats(chart) }));
      expect(await host.watchMinutes(GUID, FROM, TO), JSON.stringify(chart)).toBe(0);
    }
    const refused: [string, unknown][] = [
      ["no chart", { viewsChart: {}, engagementScore: 0 }],
      ["a chart that is a list", stats([60, 30])],
      ["a value that is text", stats({ a: "60" })],
      ["a negative value", stats({ a: -5 })],
    ];
    let checked = 0;
    for (const [what, body] of refused) {
      const { host } = harness(() => ({ status: 200, body }));
      const message = await errorOf(host.watchMinutes(GUID, FROM, TO));
      expect(message, what).toMatch(/^bunny watchMinutes: /);
      expect(message, what).toContain(GUID);
      checked++;
    }
    expect(checked, "anti-vacuity: refused shapes").toBe(4);
  });

  it("a backwards window, or a date that is not one, is refused before any call (the host would answer an unreadable date with its last 30 days)", async () => {
    const { host, calls } = harness(() => ({ status: 200, body: stats({ a: 60 }) }));
    await expect(host.watchMinutes(GUID, TO, FROM)).rejects.toThrow(/before it starts/);
    await expect(host.watchMinutes(GUID, new Date("nope"), TO)).rejects.toThrow(/not a date/);
    await expect(host.watchMinutes(GUID, FROM, new Date(Number.NaN))).rejects.toThrow(/not a date/);
    expect(calls).toEqual([]);
    expect(await host.watchMinutes(GUID, FROM, FROM), "a zero-length window is a window").toBe((60 * WATCH_TIME_CHART_SECONDS_PER_UNIT) / 60);
  });

  it("refusals map by status, as every other API call's do: 401/403 refuse our API key, 429/5xx are the host not answering, any other non-2xx is neither", async () => {
    const rows: [number, (e: unknown) => boolean][] = [
      [401, (e) => e instanceof ReplayHostRefused && e.credential === "api_key"],
      [403, (e) => e instanceof ReplayHostRefused && e.credential === "api_key"],
      [429, (e) => e instanceof ReplayHostUnavailable],
      [503, (e) => e instanceof ReplayHostUnavailable],
      [400, (e) => !(e instanceof ReplayHostRefused) && !(e instanceof ReplayHostUnavailable) && /HTTP 400/.test((e as Error).message)],
    ];
    let checked = 0;
    for (const [status, is] of rows) {
      const { host } = harness(() => ({ status, body: { message: "no" } }));
      const err = await host.watchMinutes(GUID, FROM, TO).then(() => null, (e: unknown) => e);
      expect(is(err), `HTTP ${status}: ${String(err)}`).toBe(true);
      expect((err as Error).message).toContain(GUID);
      checked++;
    }
    expect(checked).toBe(5);
  });

  // Task 31 (controller ruling 2, 2026-11-23): the controller's read-only check — a deleted video's statistics answer 404 with no
  // watchTimeChart, and so does a guid the library never held (not the library's whole total). So a 404 is "the host holds no such
  // video: nothing more can be read", answered as null — never 0, which a caller would add as a measurement, and never an error,
  // which would hold the session's other copies back. Both bodies the host may send with it read the same.
  it("a 404 (the host holds no such video: never stored, or removed) answers null — not 0, not an error — whatever its body; it is recorded as the 404 it was", async () => {
    let checked = 0;
    for (const body of [{ message: "Not Found" }, { viewsChart: {}, engagementScore: 0 }, undefined]) {
      const { host, recorder } = harness(() => ({ status: 404, body }));
      expect(await host.watchMinutes(GUID, FROM, TO), JSON.stringify(body)).toBeNull();
      await new Promise((r) => setTimeout(r, 0)); // the record is fire-and-forget
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]).toMatchObject({ operation: "watchMinutes", status: 404, errorCode: null });
      checked++;
    }
    expect(checked, "anti-vacuity: 404 bodies").toBe(3);
  });

  it("each read is one provider-call record about the video, its library id templated and no key in it", async () => {
    const { host, recorder } = harness(() => ({ status: 200, body: stats({ a: 60 }) }));
    await host.watchMinutes(GUID, FROM, TO);
    await new Promise((r) => setTimeout(r, 0)); // the record is fire-and-forget
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({ provider: "bunny", operation: "watchMinutes", method: "GET", subjectId: GUID, status: 200 });
    expect(pathTemplate(recorder.calls[0].url, recorder.calls[0].ids)).toBe("/library/{id}/statistics");
    for (const s of SECRETS) expect(JSON.stringify(recorder.calls[0])).not.toContain(s);
  });
});

// Task 24 review I3 (2026-11-22): the move calls the host inside the tick's 8 s Seazn slice, and undici's own bound is 300 s. Every
// API call therefore gives up at the move's call timeout: 4 s, the ruling's literal, typed here.
describe("BunnyReplayHost: every API call gives up at the move's 4 s timeout (Task 24 review I3)", () => {
  it("createCollection, fetchFromUrl, video, remove and watchMinutes each carry AbortSignal.timeout(4000); the abort is a thrown failure of our own wording, recorded `timeout`, no key in it", async () => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { const c = new AbortController(); deadlines.push(c); return c.signal; });
    try {
      const signals: (AbortSignal | null | undefined)[] = [];
      const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        signals.push(signal);
        return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }) as unknown as typeof fetch;
      const recorder = new FakeRecorder();
      const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => ["seazn.club"] });
      const calls: [string, () => Promise<unknown>][] = [
        ["createCollection", () => host.createCollection("o1")],
        ["fetchFromUrl", () => host.fetchFromUrl({ collectionId: "c1", title: "Final, part 1", url: "https://example.test/x.mp4" })],
        ["video", () => host.video(GUID)],
        ["remove", () => host.remove(GUID)],
        ["watchMinutes", () => host.watchMinutes(GUID, NOW, NOW)],
      ];
      let checked = 0;
      for (const [k, [op, call]] of calls.entries()) {
        const pending = call().then(() => null, (e: unknown) => e as Error);
        await vi.waitFor(() => expect(signals).toHaveLength(k + 1));
        expect(timeout, op).toHaveBeenLastCalledWith(4_000);
        expect(signals[k], `${op}: the request carries the timeout's signal`).toBe(deadlines[k]!.signal);
        deadlines[k]!.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        const err = await pending;
        expect(err?.message, op).toMatch(new RegExp(`^bunny ${op}: request failed before a response`));
        for (const secret of SECRETS) expect(err?.message).not.toContain(secret);
        checked++;
      }
      expect(checked, "API calls timed").toBe(5);
      await new Promise((r) => setTimeout(r, 0));   // the record is fire-and-forget
      expect(recorder.calls.map((c) => [c.operation, c.status, c.errorCode])).toEqual(calls.map(([op]) => [op, null, "timeout"]));
    } finally {
      timeout.mockRestore();
    }
  });
});

// Task 24 re-review N6 (2026-11-22): the timeout covers the body too. Headers that arrived with a 200 and a body that never did are
// a failed call — recorded as one (no status, `timeout`), never as the 200, and thrown in our own words. A body cut off by the
// connection is the same failure, recorded `network`. A body that arrived but is not JSON stays what it was: read as absent.
describe("BunnyReplayHost: a body that never arrives is a failed call (Task 24 re-review N6)", () => {
  function stalledBody(signal: AbortSignal | null | undefined, cut?: () => unknown): Response {
    return new Response(new ReadableStream({
      start(c) {
        if (cut) queueMicrotask(() => c.error(cut()));
        else signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  it("each API call whose 200 body stalls past the 4 s timeout throws our own failure, recorded with no status and `timeout`, no key in it", async () => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { const c = new AbortController(); deadlines.push(c); return c.signal; });
    try {
      let answered = 0;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { answered++; return stalledBody(init?.signal); }) as unknown as typeof fetch;
      const recorder = new FakeRecorder();
      const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => ["seazn.club"] });
      const calls: [string, () => Promise<unknown>][] = [
        ["createCollection", () => host.createCollection("o1")],
        ["fetchFromUrl", () => host.fetchFromUrl({ collectionId: "c1", title: "Final, part 1", url: "https://example.test/x.mp4" })],
        ["video", () => host.video(GUID)],
        ["remove", () => host.remove(GUID)],
        ["watchMinutes", () => host.watchMinutes(GUID, NOW, NOW)],
      ];
      let checked = 0;
      for (const [k, [op, call]] of calls.entries()) {
        const pending = call().then(() => null, (e: unknown) => e as Error);
        await vi.waitFor(() => expect(answered, `${op}: the headers arrived`).toBe(k + 1));
        deadlines[k]!.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        const err = await pending;
        expect(err?.message, op).toMatch(new RegExp(`^bunny ${op}: the response did not arrive in full`));
        for (const secret of SECRETS) expect(err?.message).not.toContain(secret);
        checked++;
      }
      expect(checked, "API calls whose body stalled").toBe(5);
      await new Promise((r) => setTimeout(r, 0));   // the record is fire-and-forget
      expect(recorder.calls.map((c) => [c.operation, c.status, c.errorCode]), "a failure, never the 200").toEqual(calls.map(([op]) => [op, null, "timeout"]));
    } finally {
      timeout.mockRestore();
    }
  });

  it("a 200 body cut off by the connection is the same failure, recorded `network`; a body that arrived but is not JSON still reads as absent (no failure recorded)", async () => {
    const recorder = new FakeRecorder();
    let cut = true;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      cut ? stalledBody(init?.signal, () => new TypeError("terminated")) : new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;
    const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => ["seazn.club"] });
    expect(await errorOf(host.video(GUID))).toMatch(/^bunny video: the response did not arrive in full/);
    cut = false;
    const notJson = await errorOf(host.video(GUID));
    expect(notJson, "an unreadable answer, not a failed call").not.toMatch(/did not arrive in full/);
    await new Promise((r) => setTimeout(r, 0));
    expect(recorder.calls.map((c) => [c.operation, c.status, c.errorCode])).toEqual([["video", null, "network"], ["video", 200, null]]);
  });
});

describe("BunnyReplayHost: signedEmbed (B4)", () => {
  it("answers the B4 URL for a fixed key, guid and expiry, expiring whole seconds after now, and calls nothing", () => {
    const { host, calls } = harness(() => ({ status: 500 }));
    const out = host.signedEmbed(GUID, NOW, 3600);
    // shasum -a 256 of "ZZ-token-key-7f3e91c2" + GUID + "1795258800" (computed outside the repo's code).
    expect(out.src).toBe(
      `https://iframe.mediadelivery.net/embed/424242/${GUID}?token=b775fe21f404eb33afb250cab8c046dbe27aeff556c0fa9d601ba572d22e23be&expires=1795258800`,
    );
    expect(out.expiresAt).toBe("2026-11-21T11:00:00.000Z"); // the token's own expiry, not now + ttl to the millisecond
    expect(calls).toEqual([]);
    for (const s of SECRETS) expect(out.src).not.toContain(s);
  });

  it("matches the formula hex(sha256(tokenKey + guid + expires)) on a second vector", () => {
    const { host } = harness(() => ({ status: 500 }));
    const guid = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
    const at = new Date("2027-01-02T03:04:05.000Z");
    const expires = Date.parse("2027-01-02T03:05:05.000Z") / 1000;
    const token = createHash("sha256").update(`${CONFIG.tokenKey}${guid}${expires}`).digest("hex");
    expect(host.signedEmbed(guid, at, 60).src).toBe(`https://iframe.mediadelivery.net/embed/424242/${guid}?token=${token}&expires=${expires}`);
  });
});

describe("BunnyReplayHost: openDownload (B5, B9)", () => {
  /** A CDN answer whose body is a stream we hold: if the adapter buffered it, the body it answers would not be this one. */
  function cdnAnswer(status: number, bytes = 1234) {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); } }); // never closed
    const res = {
      ok: status >= 200 && status < 300, status, body,
      headers: new Headers({ "content-type": "video/mp4", "content-length": String(bytes) }),
      arrayBuffer: () => { throw new Error("buffered"); }, text: () => { throw new Error("buffered"); }, json: () => { throw new Error("buffered"); },
    } as unknown as Response;
    return { res, body };
  }
  /** `hls`: the video body's availableResolutions (what a viewer plays); `mp4`: the files the download may take. They are NOT the same set. */
  function downloadHarness(o: { hls?: readonly number[]; mp4: readonly number[]; cdnStatus?: number; origins?: string[] | null; resolutionsStatus?: number }) {
    const cdn = cdnAnswer(o.cdnStatus ?? 200);
    const hls = (o.hls ?? o.mp4).map((h) => `${h}p`).join(",");
    const h = harness((c) => {
      if (c.url === `${API}/videos/${GUID}`) return { status: 200, body: videoBody({ status: 4, resolutions: hls }) };
      if (c.url === `${API}/videos/${GUID}/resolutions`) return { status: o.resolutionsStatus ?? 200, body: mp4Body(o.mp4) };
      return cdn.res;
    }, o.origins === undefined ? ["stg.seazn.club", "seazn.club"] : o.origins);
    return { ...h, stream: cdn.body };
  }
  const cdnUrlOf = (calls: Call[]) => calls.find((c) => c.url.startsWith(`https://${CONFIG.cdnHost}/`))?.url;

  it("fetches the tallest MP4 file at the B5 URL with the allowed Referer, and answers the CDN body itself as a stream", async () => {
    const { host, calls, stream } = downloadHarness({ mp4: [240, 360, 480, 720] });
    const dl = await host.openDownload(GUID);
    expect(calls.map((c) => c.url.replace(API, "").replace(/^https:.*\/(play_\d+p\.mp4)$/, "CDN $1"))).toEqual([`/videos/${GUID}`, `/videos/${GUID}/resolutions`, "CDN play_720p.mp4"]);
    // base64url-no-pad(sha256("ZZ-token-key-7f3e91c2" + "/{GUID}/" + "1795255500" + "token_path=/{GUID}/")), via openssl
    // outside the repo's code; 1795255500 is NOW (whole seconds) + 300.
    expect(calls[2]!.url).toBe(
      `https://vz-test0001.b-cdn.net/bcdn_token=iHh1EY5kWAt8pzmkxls-qj52SwTi4HKGSqZNqeEQypY&expires=1795255500&token_path=%2F${GUID}%2F/${GUID}/play_720p.mp4`,
    );
    expect(calls[2]!.method).toBe("GET");
    expect(calls[2]!.headers.referer).toBe("https://stg.seazn.club/"); // the FIRST SEAZN_VIDEO_ORIGINS host (B3, B9)
    expect(calls[2]!.headers.accesskey, "the API key never goes to the CDN").toBeUndefined();
    expect(calls[1]!.headers.accesskey, "the API's own calls carry it, in the header").toBe(CONFIG.apiKey);
    expect(dl.body, "the CDN's own stream, not a buffered copy").toBe(stream);
    expect(dl.bytes).toBe(1234);
    expect(dl.fileName).toBe(`${GUID}-720p.mp4`);
  });

  it("Task 48: takes the TALLEST file of the MP4 set, whatever its order — 1080 where there is one, the top of a short set where there is not", async () => {
    const SETS: { mp4: number[]; want: number }[] = [
      { mp4: [360, 1080, 240, 720, 480], want: 1080 },
      { mp4: [240, 360, 480, 720, 1080], want: 1080 },
      { mp4: [720, 240, 360], want: 720 },
      { mp4: [360, 240], want: 360 },
      { mp4: [480], want: 480 },
    ];
    let checked = 0;
    for (const { mp4, want } of SETS) {
      const { host, calls } = downloadHarness({ mp4 });
      const dl = await host.openDownload(GUID);
      expect(cdnUrlOf(calls), `[${mp4}]`).toMatch(new RegExp(`/play_${want}p\\.mp4$`));
      expect(dl.fileName).toBe(`${GUID}-${want}p.mp4`);
      checked++;
    }
    expect(checked, "anti-vacuity: every set").toBe(SETS.length);
  });

  it("Task 48: the file comes from the MP4 set, never from availableResolutions — an HLS set that holds 1080 over MP4 files that stop at 720 asks for 720, and the reverse asks for what the files hold", async () => {
    const hlsTaller = downloadHarness({ hls: [240, 360, 480, 720, 1080], mp4: [240, 360, 480, 720] });
    await hlsTaller.host.openDownload(GUID);
    expect(cdnUrlOf(hlsTaller.calls)).toMatch(/\/play_720p\.mp4$/);
    const mp4Taller = downloadHarness({ hls: [240, 360], mp4: [240, 360, 480, 720, 1080] });
    await mp4Taller.host.openDownload(GUID);
    expect(cdnUrlOf(mp4Taller.calls)).toMatch(/\/play_1080p\.mp4$/);
  });

  it("Task 48: mp4HeightsIn reads data.mp4Resolutions EXACTLY — the storage lists and storage objects (which hold the same paths) are never read — and an answer of any other shape is an empty set", () => {
    const asc = (xs: number[]) => xs.sort((a, b) => a - b);
    expect(asc(mp4HeightsIn(mp4Body([240, 360, 480, 720, 1080])))).toEqual([240, 360, 480, 720, 1080]);
    expect(mp4HeightsIn(mp4Body([720, 240, 720])), "unordered; a repeat once").toHaveLength(2);
    expect(mp4HeightsIn(mp4Body([360], { storage: [360, 720, 1080] })), "storageResolutions/storageObjects name 1080 and 720: not files").toEqual([360]);
    expect(mp4HeightsIn(mp4Body([], { storage: [720, 1080] })), "storage only: no MP4 file").toEqual([]);
    const body = mp4Body([480]);
    expect(mp4HeightsIn({ ...body, extra: { x: 1 }, data: { ...body.data, unknownKey: ["play_1080p.mp4"] } }), "unknown keys pass and are not read").toEqual([480]);
    const label = { ...body, data: { ...body.data, mp4Resolutions: [{ resolution: "720p" }, { resolution: "1080p", path: "play_480p.mp4" }, { path: "play_720p.m3u8" }, { path: "x/play_240p.mp4" }, { path: "play_0p.mp4" }, {}] } };
    expect(mp4HeightsIn(label), "a label only when there is no path; the path wins; a non-file path, a nested one, zero, and an empty entry are not files").toEqual([720, 480]);
    const none: unknown[] = [null, undefined, {}, [], 7, "", "play_720p.mp4", { success: true }, { success: true, data: {} },
      { success: true, data: { mp4Resolutions: null } }, { success: true, data: { mp4Resolutions: "720p" } }, { success: true, data: { mp4Resolutions: [7, null] } },
      { ...body, success: false }, { ...body, success: "true" }, { data: body.data }, { ...body, data: [] }];
    let checked = 0;
    for (const j of none) { expect(mp4HeightsIn(j), JSON.stringify(j)).toEqual([]); checked++; }
    expect(checked, "anti-vacuity: every malformed shape").toBe(none.length);
  });

  it("Task 48: a body whose storageResolutions holds play_1080p.mp4 while mp4Resolutions tops out at 720 downloads the 720; `success: false` is not downloadable (the CDN is never asked)", async () => {
    const h = harness((c) => {
      if (c.url === `${API}/videos/${GUID}`) return { status: 200, body: videoBody({ status: 4, resolutions: "240p,720p,1080p" }) };
      if (c.url === `${API}/videos/${GUID}/resolutions`) return { status: 200, body: mp4Body([240, 720], { storage: [240, 720, 1080] }) };
      return cdnAnswer(200).res;
    });
    await h.host.openDownload(GUID);
    expect(cdnUrlOf(h.calls)).toMatch(/\/play_720p\.mp4$/);
    const failed = harness((c) => (c.url.endsWith("/resolutions") ? { status: 200, body: mp4Body([720, 1080], { success: false }) } : { status: 200, body: videoBody({ status: 4, resolutions: "720p,1080p" }) }));
    const err = await failed.host.openDownload(GUID).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayNotDownloadable);
    expect(failed.calls.map((c) => c.url), "never reaches the CDN").toEqual([`${API}/videos/${GUID}`, `${API}/videos/${GUID}/resolutions`]);
  });

  it("matches the B5 formula on a second vector", async () => {
    const { host, calls } = downloadHarness({ mp4: [480, 240] });
    await host.openDownload(GUID);
    const expires = Math.floor(NOW.getTime() / 1000) + 300;
    const t = createHash("sha256").update(`${CONFIG.tokenKey}/${GUID}/${expires}token_path=/${GUID}/`).digest("base64url");
    expect(cdnUrlOf(calls)).toBe(`https://${CONFIG.cdnHost}/bcdn_token=${t}&expires=${expires}&token_path=%2F${GUID}%2F/${GUID}/play_480p.mp4`);
  });

  it("refuses before the CDN when the video is not playable, the MP4 set is empty (or the library holds no such video), or SEAZN_VIDEO_ORIGINS is not set", async () => {
    const processing = harness(() => ({ status: 200, body: videoBody({ status: 3, resolutions: "240p" }) }));
    expect(await errorOf(processing.host.openDownload(GUID))).toMatch(/not playable \(processing\)/);
    expect(processing.calls).toHaveLength(1);

    // Task 48: an HLS set with renditions over an MP4 set with no files (a video encoded before the fallback was switched on).
    const noFiles = downloadHarness({ hls: [240, 720, 1080], mp4: [] });
    expect(await errorOf(noFiles.host.openDownload(GUID))).toMatch(/no MP4 file/);
    expect(noFiles.calls.map((c) => c.url)).toEqual([`${API}/videos/${GUID}`, `${API}/videos/${GUID}/resolutions`]);
    const noVideo = downloadHarness({ mp4: [720], resolutionsStatus: 404 });
    expect(await errorOf(noVideo.host.openDownload(GUID))).toMatch(/no MP4 file/);
    expect(noVideo.calls, "never reaches the CDN").toHaveLength(2);

    const noOrigin = downloadHarness({ mp4: [720], origins: null });
    expect(await errorOf(noOrigin.host.openDownload(GUID))).toMatch(/SEAZN_VIDEO_ORIGINS/);
    expect(noOrigin.calls, "a configuration fault costs no second call").toHaveLength(1);
    // Task 26 (T22 review m6): "not playable" and "no file" are the port's typed refusal — the download answers "not ready,
    // try again" (409) — and nothing else is: a missing origin is a configuration fault, not a video that is not ready.
    const thrown = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
    expect(await thrown(processing.host.openDownload(GUID))).toBeInstanceOf(ReplayNotDownloadable);
    expect(await thrown(noFiles.host.openDownload(GUID))).toBeInstanceOf(ReplayNotDownloadable);
    expect(await thrown(noVideo.host.openDownload(GUID))).toBeInstanceOf(ReplayNotDownloadable);
    expect(await thrown(noOrigin.host.openDownload(GUID))).not.toBeInstanceOf(ReplayNotDownloadable);
  });

  it("Task 48: a 404 from the CDN for a file the list named is the typed not-downloadable (try again), with the CDN's body cancelled; 403, 500 are still faults", async () => {
    const gone = downloadHarness({ mp4: [720], cdnStatus: 404 });
    const err = await gone.host.openDownload(GUID).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayNotDownloadable);
    expect((err as ReplayNotDownloadable).why).toMatch(/not on the CDN/);
    const said = (err as Error).message;
    for (const piece of [...SECRETS, "bcdn_token", "expires=", CONFIG.cdnHost]) expect(said, piece).not.toContain(piece);
    for (const status of [403, 500]) {
      const h = downloadHarness({ mp4: [720], cdnStatus: status });
      const e = await h.host.openDownload(GUID).then(() => null, (x: unknown) => x);
      expect(e, `CDN ${status}`).toBeInstanceOf(Error);
      expect(e, `CDN ${status}`).not.toBeInstanceOf(ReplayNotDownloadable);
    }
  });

  it("Task 48: the /resolutions call is an API call (AccessKey header, never a URL), recorded under its own operation, and a refusal of it is a fault, not 'not ready'", async () => {
    const { host, calls, recorder } = downloadHarness({ mp4: [720] });
    await host.openDownload(GUID);
    expect(calls[1]!.url).toBe(`${API}/videos/${GUID}/resolutions`);
    expect(calls[1]!.url).not.toContain(CONFIG.apiKey);
    await new Promise((r) => setTimeout(r, 0));
    expect(recorder.calls.map((c) => c.operation)).toEqual(["video", "mp4Resolutions", "openDownload"]);
    const refused = harness((c) => (c.url.endsWith("/resolutions") ? { status: 401, body: { Message: `AccessKey ${CONFIG.apiKey} is not valid` } } : { status: 200, body: videoBody({ status: 4, resolutions: "720p" }) }));
    const e = await refused.host.openDownload(GUID).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ReplayHostRefused);
    for (const s of SECRETS) expect((e as Error).message).not.toContain(s);
  });

  it("a CDN refusal throws with the status and the video id", async () => {
    const { host } = downloadHarness({ mp4: [720], cdnStatus: 403 });
    const message = await errorOf(host.openDownload(GUID));
    expect(message).toMatch(/HTTP 403/);
    expect(message).toContain(GUID);
  });
});

describe("BunnyReplayHost: no secret and no signed token in a message, a record or a log line", () => {
  const CF_TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.eyJzdWIiOiJ2aWQiLCJleHAiOjE3OTV9.c2lnbmF0dXJlLXBhcnQtb25lLXR3bw";
  const SOURCE = `https://customer-x.cloudflarestream.com/${CF_TOKEN}/downloads/default.mp4`;
  /** Every 8-character run of a token: "no substring of the token" made checkable. */
  const shards = (token: string) => Array.from({ length: token.length - 7 }, (_, i) => token.slice(i, i + 8));
  const cdnToken = "iHh1EY5kWAt8pzmkxls-qj52SwTi4HKGSqZNqeEQypY";

  it("an API refusal that quotes the key back, and a network failure that quotes the request, leave no key in the message", async () => {
    const messages: string[] = [];
    const echo = harness(() => ({ status: 401, body: { Message: `AccessKey ${CONFIG.apiKey} is not valid; token ${CONFIG.tokenKey}` } }));
    messages.push(await errorOf(echo.host.video(GUID)));
    messages.push(await errorOf(echo.host.createCollection("o1")));
    messages.push(await errorOf(echo.host.remove(GUID)));
    messages.push(await errorOf(echo.host.watchMinutes(GUID, NOW, NOW)));
    const net = harness((c) => { throw new TypeError(`fetch failed: ${c.url} AccessKey=${CONFIG.apiKey} ${CONFIG.readOnlyKey} ${CONFIG.tokenKey}`); });
    messages.push(await errorOf(net.host.video(GUID)));
    messages.push(await errorOf(net.host.fetchFromUrl({ collectionId: "c1", title: "t", url: SOURCE })));
    // The floor under every message: even an id that carries a key (a caller's mistake) is redacted.
    const floor = harness(() => ({ status: 500 }));
    messages.push(await errorOf(floor.host.video(`x-${CONFIG.tokenKey}`)));
    messages.push(await errorOf(floor.host.watchMinutes(`x-${CONFIG.tokenKey}`, NOW, NOW)));
    expect(messages).toHaveLength(8);
    for (const m of messages) for (const s of SECRETS) expect(m, m).not.toContain(s);
    for (const h of [echo, net, floor]) {
      expect(h.recorder.calls.length).toBeGreaterThan(0);
      for (const r of h.recorder.calls) for (const s of SECRETS) expect(JSON.stringify(r)).not.toContain(s);
    }
  });

  it("every API URL carries the key in the AccessKey header only, never in a URL", async () => {
    const { host, calls } = harness((c) => (c.method === "POST" && c.url.endsWith("/collections")
      ? { status: 200, body: { guid: "col-1" } }
      : c.url.includes("/videos/fetch") ? { status: 200, body: { id: GUID } } : { status: 404 }));
    await host.createCollection("o1");
    await host.fetchFromUrl({ collectionId: "c1", title: "t", url: SOURCE });
    await host.video(GUID);
    await host.remove(GUID);
    expect(await host.watchMinutes(GUID, NOW, NOW)).toBeNull(); // 404 here (Task 31: no such video reads null): the URL is what is read
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      for (const s of SECRETS) expect(c.url, c.url).not.toContain(s);
      expect(c.headers.accesskey).toBe(CONFIG.apiKey);
    }
  });

  it("the fetchFromUrl source is a signed download: no record and no thrown error carries any piece of its token", async () => {
    const ok = harness(() => ({ status: 200, body: { id: GUID } }));
    await ok.host.fetchFromUrl({ collectionId: "c1", title: "Final, part 1", url: SOURCE });
    expect(ok.calls[0].body).toMatchObject({ url: SOURCE }); // Bunny itself is sent the whole URL: it must fetch it
    const refused = harness(() => ({ status: 400, body: { message: `could not fetch ${SOURCE}` } }));
    const refusal = await errorOf(refused.host.fetchFromUrl({ collectionId: "c1", title: "t", url: SOURCE }));
    const net = harness(() => { throw new TypeError(`fetch failed while sending ${SOURCE}`); });
    const netError = await errorOf(net.host.fetchFromUrl({ collectionId: "c1", title: "t", url: SOURCE }));
    const records = [ok, refused, net].flatMap((h) => h.recorder.calls);
    expect(records).toHaveLength(3);
    const texts = [refusal, netError, ...records.map((r) => JSON.stringify(r))];
    let checked = 0;
    for (const t of texts) for (const piece of shards(CF_TOKEN)) { expect(t).not.toContain(piece); checked++; }
    expect(checked).toBe(texts.length * (CF_TOKEN.length - 7));
    expect(records[0]).toMatchObject({ provider: "bunny", operation: "fetchFromUrl", method: "POST", subjectId: GUID, status: 200 });
  });

  it("the CDN call is recorded as [signed], and a CDN failure that quotes its URL leaves no token in the message", async () => {
    const recorded = harness((c) => (c.url.startsWith(API)
      ? playable720(c.url)
      : new Response("mp4 bytes", { status: 200 })));
    await recorded.host.openDownload(GUID);
    const cdnRecord = recorded.recorder.calls.find((r) => r.operation === "openDownload");
    expect(cdnRecord).toMatchObject({ provider: "bunny", method: "GET", subjectId: GUID, status: 200 });
    expect(cdnRecord!.url).toBe(`https://${CONFIG.cdnHost}/[signed]/${GUID}/play_720p.mp4`);
    expect(pathTemplate(cdnRecord!.url, cdnRecord!.ids)).toBe("/[signed]/{id}/play_720p.mp4"); // what the table would keep

    const net = harness((c) => {
      if (c.url.startsWith(API)) return playable720(c.url);
      throw new TypeError(`fetch failed: ${c.url} referer ${c.headers.referer}`);
    });
    const message = await errorOf(net.host.openDownload(GUID));
    expect(message).toContain(GUID);
    const texts = [message, ...[recorded, net].flatMap((h) => h.recorder.calls.map((r) => JSON.stringify(r)))];
    expect(texts.length, "the message, then each call's record: video, resolutions, CDN (x2)").toBe(7);
    for (const t of texts) {
      for (const piece of shards(cdnToken)) expect(t).not.toContain(piece);
      expect(t).not.toContain("bcdn_token");
      for (const s of SECRETS) expect(t).not.toContain(s);
    }
  });
});

// Task 26 review m1 (2026-11-23): the download's CDN GET gives up when its HEADERS do not arrive within the adapter's 4 s
// (SEAZN_REPLAY_CALL_TIMEOUT_MS, the same deadline as every API call) — and only then: once the headers are in, the deadline is
// cleared, because a 3 h file streams for as long as the viewer reads it (never AbortSignal.timeout on the whole request). The
// caller's cancel (the route's request.signal) aborts the CDN request too, before the headers or after, so an abandoned download
// stops pulling from Bunny. The fake CDN behaves as undici does: an abort before the headers rejects the fetch; an abort after them
// errors the body.
describe("BunnyReplayHost: openDownload times out on the headers only, and follows the caller's cancel (review m1)", () => {
  const DEADLINE_MS = 4_000;
  type Cdn = { headersAt: number | null; chunks?: [number, string][]; closeAt?: number };
  function cdnRig(cdn: Cdn) {
    const enc = new TextEncoder();
    const upstream: { signal: AbortSignal | null; bodyError: unknown } = { signal: null, bodyError: null };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(API)) {
        return new Response(JSON.stringify(playable720(String(url)).body), { status: 200, headers: { "content-type": "application/json" } });
      }
      const signal = init?.signal ?? null;
      upstream.signal = signal;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(signal!.reason);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (cdn.headersAt === null) return; // the headers never come
        setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              signal?.addEventListener("abort", () => { upstream.bodyError = signal.reason; c.error(signal.reason); }, { once: true });
              for (const [at, text] of cdn.chunks ?? []) setTimeout(() => { try { c.enqueue(enc.encode(text)); } catch { /* errored */ } }, at - cdn.headersAt!);
              if (cdn.closeAt !== undefined) setTimeout(() => { try { c.close(); } catch { /* errored */ } }, cdn.closeAt - cdn.headersAt!);
            },
          });
          resolve(new Response(body, { status: 200, headers: { "content-type": "video/mp4" } }));
        }, cdn.headersAt);
      });
    }) as unknown as typeof fetch;
    const recorder = new FakeRecorder();
    const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => ["stg.seazn.club"] });
    return { host, recorder, upstream };
  }
  const settledFlag = (p: Promise<unknown>) => {
    const s = { done: false, value: undefined as unknown, error: undefined as unknown };
    p.then((v) => { s.done = true; s.value = v; }, (e: unknown) => { s.done = true; s.error = e; });
    return s;
  };
  const cdnRecord = (r: FakeRecorder) => r.calls.filter((c) => c.operation === "openDownload");

  it("EMPTY CASE FIRST: headers that never arrive — nothing at 3999 ms, then at the adapter's 4 s our own failure, recorded `timeout` with no status, the CDN request aborted, no timer left; no token in the message or the record", async () => {
    vi.useFakeTimers();
    try {
      const { host, recorder, upstream } = cdnRig({ headersAt: null });
      const s = settledFlag(host.openDownload(GUID));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(s.done, "a ms short of the deadline: still waiting").toBe(false);
      expect(upstream.signal?.aborted, "PREMISE: the CDN was asked, with a signal").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.done).toBe(true);
      const message = (s.error as Error).message;
      expect(message).toMatch(/openDownload: no response within 4000 ms/);
      expect(s.error).not.toBeInstanceOf(ReplayNotDownloadable);
      expect(upstream.signal?.aborted, "the CDN request is aborted, not left hanging").toBe(true);
      expect(vi.getTimerCount(), "no timer left behind").toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      const rec = cdnRecord(recorder);
      expect(rec.map((c) => [c.status, c.errorCode])).toEqual([[null, "timeout"]]);
      for (const text of [message, JSON.stringify(rec)]) {
        expect(text).not.toMatch(/bcdn_token|expires=/);
        for (const secret of SECRETS) expect(text).not.toContain(secret);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("headers at 3.9 s, then a body that takes 12 s: every byte arrives — the deadline covered the headers only and was cleared with them", async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on a real timer that fake time never reaches: made to run on the fake clock here, so a deadline on
    // the WHOLE request (the shape review m1 rules out) would cut this body at 4 s and fail the test.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
      return c.signal;
    });
    try {
      const { host, recorder, upstream } = cdnRig({ headersAt: 3_900, chunks: [[6_000, "one-"], [10_000, "two-"], [11_500, "three"]], closeAt: 12_000 });
      const opened = settledFlag(host.openDownload(GUID));
      await vi.advanceTimersByTimeAsync(3_900);
      expect(opened.done, "PREMISE: the headers came in under the deadline").toBe(true);
      expect(opened.error).toBeUndefined();
      const reader = (opened.value as { body: ReadableStream<Uint8Array> }).body.getReader();
      const dec = new TextDecoder();
      let text = "";
      const read = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += dec.decode(value);
        }
      })();
      const finished = settledFlag(read);
      await vi.advanceTimersByTimeAsync(12_000 - 3_900);
      expect(finished.error, "the body was never cut").toBeUndefined();
      expect(finished.done).toBe(true);
      expect(text).toBe("one-two-three");
      expect(upstream.signal?.aborted, "nothing aborted the CDN request").toBe(false);
      expect(upstream.bodyError).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(cdnRecord(recorder).map((c) => [c.status, c.errorCode])).toEqual([[200, null]]);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("the caller's cancel AFTER the headers aborts the CDN request (its body errors: no more bytes are pulled); BEFORE the headers it rejects at once, recorded `cancelled`, never `timeout`", async () => {
    vi.useFakeTimers();
    try {
      const before = cdnRig({ headersAt: null });
      const early = new AbortController();
      const pending = settledFlag(before.host.openDownload(GUID, early.signal));
      await vi.advanceTimersByTimeAsync(100);
      early.abort(new Error("the viewer left"));
      await vi.advanceTimersByTimeAsync(0);
      expect(pending.done, "rejected at the cancel, not at the deadline").toBe(true);
      expect((pending.error as Error).message).toMatch(/openDownload: cancelled before a response/);
      expect(before.upstream.signal?.aborted).toBe(true);
      expect(vi.getTimerCount(), "the deadline went with it").toBe(0);
      expect(cdnRecord(before.recorder).map((c) => [c.status, c.errorCode])).toEqual([[null, "cancelled"]]);

      const after = cdnRig({ headersAt: 10, chunks: [[20, "one-"], [60_000, "never"]], closeAt: 120_000 });
      const viewer = new AbortController();
      const opened = settledFlag(after.host.openDownload(GUID, viewer.signal));
      await vi.advanceTimersByTimeAsync(30);
      expect(opened.error).toBeUndefined();
      expect(after.upstream.signal?.aborted, "PREMISE: streaming, not aborted").toBe(false);
      viewer.abort(new Error("the viewer left"));
      expect(after.upstream.signal?.aborted, "the viewer's cancel reached the CDN request").toBe(true);
      expect(after.upstream.bodyError, "and stopped its body").toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BunnyReplayHost: a failure says what kind it is (Task 27, carrying T26 re-review m1 a) — the download answers each its own way", () => {
  const kindOf = (e: unknown) =>
    e instanceof ReplayHostRefused ? `refused ${e.status} ${e.credential}` : e instanceof ReplayHostUnavailable ? "unavailable" : e instanceof ReplayNotDownloadable ? "not-downloadable" : e instanceof Error ? "other" : "none";
  const thrown = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it("EMPTY CASE FIRST: a 200 and a 404 throw nothing; the API's 401 and 403 are a refusal of OUR credentials (with the status), 429 and every 5xx the host not answering, any other status neither", async () => {
    expect(kindOf(await thrown(harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "720p" }) })).host.video(GUID)))).toBe("none");
    expect(kindOf(await thrown(harness(() => ({ status: 404 })).host.video(GUID))), "404 is absent, not a failure").toBe("none");
    // The API's refusal is of the API key (AccessKey): Task 27 review m3.
    const table: [number, string][] = [[401, "refused 401 api_key"], [403, "refused 403 api_key"], [429, "unavailable"], [500, "unavailable"], [502, "unavailable"], [503, "unavailable"], [504, "unavailable"], [400, "other"], [409, "other"]];
    let checked = 0;
    for (const [status, kind] of table) {
      const h = harness(() => ({ status, body: { Message: `AccessKey ${CONFIG.apiKey} rejected` } }));
      const e = await thrown(h.host.video(GUID));
      expect([status, kindOf(e)]).toEqual([status, kind]);
      for (const secret of SECRETS) expect((e as Error).message).not.toContain(secret);
      checked++;
    }
    expect(checked).toBe(9);
  });

  it("an API call that never answers (a network fault) is the host not answering, and so is a body cut off before it arrived", async () => {
    const net = harness(() => { throw new TypeError(`fetch failed ${CONFIG.apiKey}`); });
    expect(kindOf(await thrown(net.host.video(GUID)))).toBe("unavailable");
    const cut = harness(() => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new TypeError("terminated"); } }) as unknown as Response);
    expect(kindOf(await thrown(cut.host.video(GUID)))).toBe("unavailable");
  });

  it("openDownload: the CDN's 401 and 403 are a refusal (the token key, or a Referer the library does not allow), its 5xx the host not answering, its 404 the typed not-downloadable (Task 48), any other status neither; a missing SEAZN_VIDEO_ORIGINS neither", async () => {
    const cdn = (status: number) => harness((c) => (c.url.startsWith(API) ? playable720(c.url) : new Response(status < 300 ? "x" : null, { status })));
    // The CDN's refusal is of the delivery token (the token key) or the Referer: Task 27 review m3.
    const table: [number, string][] = [[401, "refused 401 delivery_token"], [403, "refused 403 delivery_token"], [500, "unavailable"], [503, "unavailable"], [429, "unavailable"], [404, "not-downloadable"], [410, "other"]];
    let checked = 0;
    for (const [status, kind] of table) {
      expect([status, kindOf(await thrown(cdn(status).host.openDownload(GUID)))]).toEqual([status, kind]);
      checked++;
    }
    expect(checked).toBe(7);
    const noOrigin = harness((c) => playable720(c.url), null);
    expect(kindOf(await thrown(noOrigin.host.openDownload(GUID))), "a configuration fault of ours is not the host's").toBe("other");
  });

  it("openDownload: no headers in the 4 s, or a network fault, is the host not answering; the caller's own cancel is neither (the download answers it before reading the kind)", async () => {
    // A CDN whose headers never come: only an abort (the adapter's deadline, or the caller's cancel) ends its request.
    const hangingCdn = () => {
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
        String(url).startsWith(API)
          ? new Response(JSON.stringify(playable720(String(url)).body), { status: 200, headers: { "content-type": "application/json" } })
          : new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))) as typeof fetch;
      return new BunnyReplayHost(CONFIG, { fetchImpl, recorder: new FakeRecorder(), now: () => NOW, videoOrigins: () => ["stg.seazn.club"] });
    };
    vi.useFakeTimers();
    try {
      const timedOut = thrown(hangingCdn().openDownload(GUID));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(kindOf(await timedOut), "no headers in 4 s").toBe("unavailable");
      const viewer = new AbortController();
      const cancelled = thrown(hangingCdn().openDownload(GUID, viewer.signal));
      await vi.advanceTimersByTimeAsync(10);
      viewer.abort(new Error("the viewer left"));
      expect(kindOf(await cancelled), "the caller's cancel").toBe("other");
    } finally {
      vi.useRealTimers();
    }
    const net = harness((c) => (c.url.startsWith(API) ? playable720(c.url) : Promise.reject(new TypeError("fetch failed"))));
    expect(kindOf(await thrown(net.host.openDownload(GUID))), "a network fault").toBe("unavailable");
  });
});
