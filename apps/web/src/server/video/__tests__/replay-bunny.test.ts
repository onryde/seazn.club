// Task 22: the Bunny Stream adapter (BunnyReplayHost) against a mocked fetch. No network: every answer below is a fixture
// shaped like what the probes measured (docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md, cited by id B1–B10).
// Expected token values come from the published formulas (B4, B5), never from the adapter: once as literals computed
// outside this repo's code (shasum/openssl, 2026-11-21), and once more from the formula for a second vector.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BunnyConfig } from "@/server/relay/config";
import { FakeRecorder } from "@/server/relay/fakes";
import { pathTemplate } from "@/server/relay/sanitise";
import { BunnyReplayHost } from "../replay-bunny";
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
  const warnings: { fields: Record<string, unknown>; msg: string }[] = [];
  const host = new BunnyReplayHost(CONFIG, {
    fetchImpl, recorder, now: () => NOW, videoOrigins: () => origins,
    warn: (fields, msg) => { warnings.push({ fields, msg }); },
  });
  return { host, calls, recorder, warnings };
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

  it("heights: availableResolutions is parsed, unordered (B9), and every height above 720 is dropped with ONE warning naming the video id only", async () => {
    const { host, warnings } = harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "360p,480p,720p,240p,1080p" }) }));
    const v = await host.video(GUID);
    expect([...v.heights].sort((a, b) => a - b)).toEqual([240, 360, 480, 720]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain(GUID);
    const said = JSON.stringify(warnings[0]);
    for (const s of [...SECRETS, "http", CONFIG.cdnHost, "bcdn_token"]) expect(said, s).not.toContain(s);
    await host.video(GUID);
    expect(warnings, "one warning per video, not one per read").toHaveLength(1);

    const capped = harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "240p,360p,480p,720p" }) }));
    expect([...(await capped.host.video(GUID)).heights].sort((a, b) => a - b)).toEqual([240, 360, 480, 720]);
    expect(capped.warnings).toEqual([]);
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

  it("watchMinutes is Task 30's and refuses until it is built", async () => {
    const { host, calls } = harness(() => ({ status: 200, body: {} }));
    const port: ReplayHost = host; // called as the application layer calls it
    expect(await errorOf(port.watchMinutes(GUID, NOW, NOW))).toMatch(/Task 30/);
    expect(calls).toEqual([]);
  });
});

// Task 24 review I3 (2026-11-22): the move calls the host inside the tick's 8 s Seazn slice, and undici's own bound is 300 s. Every
// API call therefore gives up at the move's call timeout: 4 s, the ruling's literal, typed here.
describe("BunnyReplayHost: every API call gives up at the move's 4 s timeout (Task 24 review I3)", () => {
  it("createCollection, fetchFromUrl, video and remove each carry AbortSignal.timeout(4000); the abort is a thrown failure of our own wording, recorded `timeout`, no key in it", async () => {
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
      const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => ["seazn.club"], warn: () => undefined });
      const calls: [string, () => Promise<unknown>][] = [
        ["createCollection", () => host.createCollection("o1")],
        ["fetchFromUrl", () => host.fetchFromUrl({ collectionId: "c1", title: "Final, part 1", url: "https://example.test/x.mp4" })],
        ["video", () => host.video(GUID)],
        ["remove", () => host.remove(GUID)],
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
      expect(checked, "API calls timed").toBe(4);
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
      const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => ["seazn.club"], warn: () => undefined });
      const calls: [string, () => Promise<unknown>][] = [
        ["createCollection", () => host.createCollection("o1")],
        ["fetchFromUrl", () => host.fetchFromUrl({ collectionId: "c1", title: "Final, part 1", url: "https://example.test/x.mp4" })],
        ["video", () => host.video(GUID)],
        ["remove", () => host.remove(GUID)],
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
      expect(checked, "API calls whose body stalled").toBe(4);
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
    const host = new BunnyReplayHost(CONFIG, { fetchImpl, recorder, now: () => NOW, videoOrigins: () => ["seazn.club"], warn: () => undefined });
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
  function downloadHarness(resolutions: string, cdnStatus = 200, origins: string[] | null = ["stg.seazn.club", "seazn.club"]) {
    const cdn = cdnAnswer(cdnStatus);
    const h = harness((c) => (c.url.startsWith(API) ? { status: 200, body: videoBody({ status: 4, resolutions }) } : cdn.res), origins);
    return { ...h, stream: cdn.body };
  }

  it("fetches play_720p.mp4 at the B5 URL with the allowed Referer, and answers the CDN body itself as a stream", async () => {
    const { host, calls, stream } = downloadHarness("240p,360p,480p,720p");
    const dl = await host.openDownload(GUID);
    expect(calls).toHaveLength(2);
    // base64url-no-pad(sha256("ZZ-token-key-7f3e91c2" + "/{GUID}/" + "1795255500" + "token_path=/{GUID}/")), via openssl
    // outside the repo's code; 1795255500 is NOW (whole seconds) + 300.
    expect(calls[1].url).toBe(
      `https://vz-test0001.b-cdn.net/bcdn_token=iHh1EY5kWAt8pzmkxls-qj52SwTi4HKGSqZNqeEQypY&expires=1795255500&token_path=%2F${GUID}%2F/${GUID}/play_720p.mp4`,
    );
    expect(calls[1].method).toBe("GET");
    expect(calls[1].headers.referer).toBe("https://stg.seazn.club/"); // the FIRST SEAZN_VIDEO_ORIGINS host (B3, B9)
    expect(calls[1].headers.accesskey, "the API key never goes to the CDN").toBeUndefined();
    expect(dl.body, "the CDN's own stream, not a buffered copy").toBe(stream);
    expect(dl.bytes).toBe(1234);
    expect(dl.fileName).toMatch(/\.mp4$/);
  });

  it("asks for the highest height at or under 720 from an unordered list that holds 1080 (B9)", async () => {
    const { host, calls } = downloadHarness("360p,480p,720p,240p,1080p");
    await host.openDownload(GUID);
    expect(calls[1].url).toMatch(/\/play_720p\.mp4$/);
    const low = downloadHarness("360p,240p");
    await low.host.openDownload(GUID);
    expect(low.calls[1].url).toMatch(/\/play_360p\.mp4$/);
  });

  it("matches the B5 formula on a second vector", async () => {
    const { host, calls } = downloadHarness("480p,240p");
    await host.openDownload(GUID);
    const expires = Math.floor(NOW.getTime() / 1000) + 300;
    const t = createHash("sha256").update(`${CONFIG.tokenKey}/${GUID}/${expires}token_path=/${GUID}/`).digest("base64url");
    expect(calls[1].url).toBe(`https://${CONFIG.cdnHost}/bcdn_token=${t}&expires=${expires}&token_path=%2F${GUID}%2F/${GUID}/play_480p.mp4`);
  });

  it("refuses before the CDN when the video is not playable, has no rendition, or SEAZN_VIDEO_ORIGINS is not set", async () => {
    const processing = harness(() => ({ status: 200, body: videoBody({ status: 3, resolutions: "240p" }) }));
    expect(await errorOf(processing.host.openDownload(GUID))).toMatch(/not playable \(processing\)/);
    expect(processing.calls).toHaveLength(1);

    const onlyHd = harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "1080p" }) }));
    expect(await errorOf(onlyHd.host.openDownload(GUID))).toMatch(/no rendition/);
    expect(onlyHd.calls).toHaveLength(1);

    const noOrigin = downloadHarness("720p", 200, null);
    expect(await errorOf(noOrigin.host.openDownload(GUID))).toMatch(/SEAZN_VIDEO_ORIGINS/);
    expect(noOrigin.calls).toHaveLength(1);
    // Task 26 (T22 review m6): "not playable" and "no rendition" are the port's typed refusal — the download answers "not ready,
    // try again" (409) — and nothing else is: a missing origin is a configuration fault, not a video that is not ready.
    const thrown = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
    expect(await thrown(processing.host.openDownload(GUID))).toBeInstanceOf(ReplayNotDownloadable);
    expect(await thrown(onlyHd.host.openDownload(GUID))).toBeInstanceOf(ReplayNotDownloadable);
    expect(await thrown(noOrigin.host.openDownload(GUID))).not.toBeInstanceOf(ReplayNotDownloadable);
  });

  it("a CDN refusal throws with the status and the video id", async () => {
    const { host } = downloadHarness("720p", 403);
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
    const net = harness((c) => { throw new TypeError(`fetch failed: ${c.url} AccessKey=${CONFIG.apiKey} ${CONFIG.readOnlyKey} ${CONFIG.tokenKey}`); });
    messages.push(await errorOf(net.host.video(GUID)));
    messages.push(await errorOf(net.host.fetchFromUrl({ collectionId: "c1", title: "t", url: SOURCE })));
    // The floor under every message: even an id that carries a key (a caller's mistake) is redacted.
    const floor = harness(() => ({ status: 500 }));
    messages.push(await errorOf(floor.host.video(`x-${CONFIG.tokenKey}`)));
    expect(messages).toHaveLength(6);
    for (const m of messages) for (const s of SECRETS) expect(m, m).not.toContain(s);
    for (const h of [echo, net, floor]) {
      expect(h.recorder.calls.length).toBeGreaterThan(0);
      for (const r of h.recorder.calls) for (const s of SECRETS) expect(JSON.stringify(r)).not.toContain(s);
      expect(h.warnings).toEqual([]);
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
    expect(calls).toHaveLength(4);
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
      ? { status: 200, body: videoBody({ status: 4, resolutions: "720p" }) }
      : new Response("mp4 bytes", { status: 200 })));
    await recorded.host.openDownload(GUID);
    const cdnRecord = recorded.recorder.calls.find((r) => r.operation === "openDownload");
    expect(cdnRecord).toMatchObject({ provider: "bunny", method: "GET", subjectId: GUID, status: 200 });
    expect(cdnRecord!.url).toBe(`https://${CONFIG.cdnHost}/[signed]/${GUID}/play_720p.mp4`);
    expect(pathTemplate(cdnRecord!.url, cdnRecord!.ids)).toBe("/[signed]/{id}/play_720p.mp4"); // what the table would keep

    const net = harness((c) => {
      if (c.url.startsWith(API)) return { status: 200, body: videoBody({ status: 4, resolutions: "720p" }) };
      throw new TypeError(`fetch failed: ${c.url} referer ${c.headers.referer}`);
    });
    const message = await errorOf(net.host.openDownload(GUID));
    expect(message).toContain(GUID);
    const texts = [message, ...[recorded, net].flatMap((h) => h.recorder.calls.map((r) => JSON.stringify(r)))];
    expect(texts.length).toBe(5);
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
        return new Response(JSON.stringify(videoBody({ status: 4, resolutions: "720p" })), { status: 200, headers: { "content-type": "application/json" } });
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
    e instanceof ReplayHostRefused ? `refused ${e.status}` : e instanceof ReplayHostUnavailable ? "unavailable" : e instanceof ReplayNotDownloadable ? "not-downloadable" : e instanceof Error ? "other" : "none";
  const thrown = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it("EMPTY CASE FIRST: a 200 and a 404 throw nothing; the API's 401 and 403 are a refusal of OUR credentials (with the status), 429 and every 5xx the host not answering, any other status neither", async () => {
    expect(kindOf(await thrown(harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "720p" }) })).host.video(GUID)))).toBe("none");
    expect(kindOf(await thrown(harness(() => ({ status: 404 })).host.video(GUID))), "404 is absent, not a failure").toBe("none");
    const table: [number, string][] = [[401, "refused 401"], [403, "refused 403"], [429, "unavailable"], [500, "unavailable"], [502, "unavailable"], [503, "unavailable"], [504, "unavailable"], [400, "other"], [409, "other"]];
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

  it("openDownload: the CDN's 401 and 403 are a refusal (the token key, or a Referer the library does not allow), its 5xx the host not answering, its 404 neither; a missing SEAZN_VIDEO_ORIGINS neither", async () => {
    const cdn = (status: number) => harness((c) => (c.url.startsWith(API) ? { status: 200, body: videoBody({ status: 4, resolutions: "720p" }) } : new Response(status < 300 ? "x" : null, { status })));
    const table: [number, string][] = [[401, "refused 401"], [403, "refused 403"], [500, "unavailable"], [503, "unavailable"], [429, "unavailable"], [404, "other"]];
    let checked = 0;
    for (const [status, kind] of table) {
      expect([status, kindOf(await thrown(cdn(status).host.openDownload(GUID)))]).toEqual([status, kind]);
      checked++;
    }
    expect(checked).toBe(6);
    const noOrigin = harness(() => ({ status: 200, body: videoBody({ status: 4, resolutions: "720p" }) }), null);
    expect(kindOf(await thrown(noOrigin.host.openDownload(GUID))), "a configuration fault of ours is not the host's").toBe("other");
  });

  it("openDownload: no headers in the 4 s, or a network fault, is the host not answering; the caller's own cancel is neither (the download answers it before reading the kind)", async () => {
    // A CDN whose headers never come: only an abort (the adapter's deadline, or the caller's cancel) ends its request.
    const hangingCdn = () => {
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
        String(url).startsWith(API)
          ? new Response(JSON.stringify(videoBody({ status: 4, resolutions: "720p" })), { status: 200, headers: { "content-type": "application/json" } })
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
    const net = harness((c) => (c.url.startsWith(API) ? { status: 200, body: videoBody({ status: 4, resolutions: "720p" }) } : Promise.reject(new TypeError("fetch failed"))));
    expect(kindOf(await thrown(net.host.openDownload(GUID))), "a network fault").toBe("unavailable");
  });
});
