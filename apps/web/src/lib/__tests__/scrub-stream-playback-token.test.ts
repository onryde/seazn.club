// Seazn-hosted video, Task 14 (carried from the Task 13 review): a signed Cloudflare playback URL holds its token in the PATH,
// `https://<customer host>/<token>/manifest/video.m3u8` (C1), and the player (Task 15) fetches it, and every playlist and
// segment under it, from the viewer's browser. Whoever holds the URL plays the video until the token expires (1 h; C2: the
// token is the only protection). A browser's XHR/fetch breadcrumb, an http.client span, an error that quotes the URL, a console
// log and a PostHog autocapture of the <video> element would each send it on (the browser Sentry client records no replay:
// owner 2026-11-23). Every Sentry and
// PostHog string loses the path segment that follows a Cloudflare Stream customer host (`*.cloudflarestream.com/`) — the token,
// or on an unsigned input a uid that plays as well as a token does — and keeps the host and the rest of the path.
//
// The URLs come from the REAL producer (server/video/cf-playback.ts `signLivePlayback`, `signRecordingPlayback`,
// `signDownload`) on a Stream customer host, with a token shaped as Cloudflare mints them (an RS256 JWT: `POST
// /stream/{uid}/token`, C1). The events go through the options the REAL browser init hands the SDK (src/instrumentation-client.ts,
// imported with a DSN; options in lib/sentry-browser.ts), and once through the server config's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", () => ({ default: { init: vi.fn(), opt_in_capturing: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn((options: unknown) => ({ name: "Replay", options })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogs" })),
  pinoIntegration: vi.fn(() => ({ name: "Pino" })),
  captureRouterTransitionStart: vi.fn(),
  getClient: vi.fn(),
}));

import { createPlaybackTokenCache, signDownload, signLivePlayback, signRecordingPlayback } from "@/server/video/cf-playback";
import { holdsCredential, posthogBeforeSend, scrubScoreUrl } from "../scrub-score-url";
import { bootBrowserSentry } from "./_browser-sentry";

const HOST = "customer-k7q2m9.cloudflarestream.com";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
/** A token in Cloudflare's shape: header.payload.signature, base64url, the signature 342 characters (RS256, 2048-bit key). */
const cfToken = (uid: string, exp: number): string =>
  `${b64({ alg: "RS256", kid: "cdc935982f8075f2ef96106d85fcd838" })}.${b64({ sub: uid, kid: "cdc935982f8075f2ef96106d85fcd838", exp, nbf: exp - 3600 })}.` +
  Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37 + 11) % 256)).toString("base64url");
const T0 = new Date("2026-11-21T10:00:00Z");

/** The three URLs the producer makes, and the token inside each. */
async function produced() {
  const ingest = { playbackToken: async (uid: string, o: { expiresAt: Date }) => cfToken(uid, Math.floor(o.expiresAt.getTime() / 1000)) };
  const deps = { ingest, tokenCache: createPlaybackTokenCache() };
  const live = (await signLivePlayback(deps, "0f1e2d3c4b5a69788796a5b4c3d2e1f0", T0)).src;
  const replay = (await signRecordingPlayback(deps, "9a8b7c6d5e4f30211203f4e5d6c7b8a9", T0)).src;
  const download = await signDownload(deps, "9a8b7c6d5e4f30211203f4e5d6c7b8a9", T0, 6 * 3600);
  const tokenOf = (url: string) => new URL(url).pathname.split("/")[1]!;
  const urls = { live, replay, download };
  for (const url of Object.values(urls)) {
    expect(url.startsWith(`https://${HOST}/`), `premise: the customer host (${url})`).toBe(true);
    expect(tokenOf(url), "premise: a JWT-shaped token, one path segment").toMatch(/^[\w-]{20,}\.[\w-]{20,}\.[\w-]{300,}$/);
  }
  // What hls.js fetches next: the variant playlists and segments, resolved against the manifest (the token stays in the path).
  const variant = new URL("stream_t0e1.m3u8?CMCD=1", live).href;
  const segment = new URL("../video/720/seg_12.ts", variant).href;
  return { ...urls, variant, segment, token: tokenOf(live), recordingToken: tokenOf(replay), downloadToken: tokenOf(download) };
}

type Options = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;
const run = (fn: unknown, ...args: unknown[]): unknown => {
  expect(typeof fn, "the option is a function").toBe("function");
  return (fn as Fn)(...args);
};
async function sentryInitOptions(configPath: string): Promise<Options> {
  await import(configPath);
  const Sentry = await import("@sentry/nextjs");
  const calls = vi.mocked(Sentry.init).mock.calls;
  expect(calls, `${configPath} calls Sentry.init once`).toHaveLength(1);
  return calls[0]![0] as Options;
}
/** The browser client's options: src/instrumentation-client.ts imported for real with a DSN and the visitor's consent, and the
 *  lazy SDK load it schedules (lib/sentry-browser.ts) awaited. No DSN or no consent means no load and no init. */
const clientInitOptions = (): Promise<Options> => bootBrowserSentry();
/** No token of `tokens` survives, and the host is still there, followed by the placeholder. */
function expectClean(value: unknown, tokens: string[], placeholders: number): void {
  const text = JSON.stringify(value);
  for (const t of tokens) expect(text).not.toContain(t);
  expect(text.split(`${HOST}/[token]`).length - 1, "each URL keeps its host and loses only the token").toBe(placeholders);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("STREAM_PLAYBACK_HOST", HOST);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a signed Cloudflare playback URL never reaches Sentry or PostHog with its token", () => {
  it("scrubScoreUrl: the segment after the customer host becomes [token]; the rest of every URL stays", async () => {
    const p = await produced();
    // W-LL: the live programme manifest carries Cloudflare's LL-HLS query (default on), which is "the rest of the URL": it stays.
    expect(scrubScoreUrl(p.live)).toBe(`https://${HOST}/[token]/manifest/video.m3u8?protocol=llhls`);
    expect(scrubScoreUrl(p.replay)).toBe(`https://${HOST}/[token]/manifest/video.m3u8`);
    expect(scrubScoreUrl(p.download)).toBe(`https://${HOST}/[token]/downloads/default.mp4`);
    expect(scrubScoreUrl(p.variant)).toBe(`https://${HOST}/[token]/manifest/stream_t0e1.m3u8?CMCD=1`);
    expect(scrubScoreUrl(p.segment)).toBe(`https://${HOST}/[token]/video/720/seg_12.ts`);
    // Quoted in a sentence, and URL-encoded inside another URL (a `next=`, a referrer carried as a parameter).
    expect(scrubScoreUrl(`hls.js: manifestLoadError on ${p.live} (403)`)).toBe(`hls.js: manifestLoadError on https://${HOST}/[token]/manifest/video.m3u8?protocol=llhls (403)`);
    const encoded = `https://seazn.club/login?next=${encodeURIComponent(p.live)}`;
    expect(scrubScoreUrl(encoded)).not.toContain(p.token);
    expect(scrubScoreUrl(encoded)).toBe(`https://seazn.club/login?next=${encodeURIComponent(`https://${HOST}/`)}[token]${encodeURIComponent("/manifest/video.m3u8?protocol=llhls")}`);
    expect(holdsCredential(p.live)).toBe(true);
    // The negative twins: the fake host, Cloudflare's API (the token is in its answer, never its URL), and our own pages.
    for (const untouched of [
      "https://playback.fake.invalid/fake.in-1.1790000000/manifest/video.m3u8",
      "https://api.cloudflare.com/client/v4/accounts/acc/stream/0f1e2d3c4b5a69788796a5b4c3d2e1f0/token",
      "https://seazn.club/live/club/cup/open/fixtures/3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2b",
      `https://${HOST}`,
    ]) expect(scrubScoreUrl(untouched), untouched).toBe(untouched);
  });

  it("the browser client: an XHR breadcrumb, an error quoting the URL, a transaction's http.client span and a console log each lose the token", async () => {
    const p = await produced();
    const tokens = [p.token, p.recordingToken];
    const options = await clientInitOptions();
    // hls.js (enableWorker: false) loads over XHR; the SDK's breadcrumb carries the full URL.
    expectClean(run(options.beforeBreadcrumb, { category: "xhr", type: "http", data: { method: "GET", url: p.variant, status_code: 403 } }, {}), tokens, 1);
    const error = {
      event_id: "e1",
      exception: { values: [{ type: "Error", value: `networkError: fragLoadError ${p.segment}` }] },
      breadcrumbs: [{ category: "xhr", type: "http", data: { method: "GET", url: p.live, status_code: 200 } }, { category: "fetch", type: "http", data: { method: "GET", url: p.replay } }],
      extra: { hls: { url: p.live, frag: { url: p.segment } } },
    };
    expectClean(run(options.beforeSend, error, {}), tokens, 5);
    const transaction = {
      type: "transaction",
      transaction: "/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]",
      spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, op: "http.client", description: `GET ${p.live}`, data: { url: p.live, "url.full": p.live, "http.url": p.live } }],
    };
    expectClean(run(options.beforeSendTransaction, transaction, {}), tokens, 4);
    expectClean(run(options.beforeSendLog, { level: "error", message: `Failed to load ${p.replay}`, attributes: { src: p.replay } }), tokens, 2);
  });

  it("the server config: an error quoting the download URL (the replay mover's, C5) loses its token", async () => {
    const p = await produced();
    const options = await sentryInitOptions("../../../sentry.server.config");
    expectClean(run(options.beforeSend, { event_id: "e2", exception: { values: [{ type: "Error", value: `fetch failed for ${p.download}` }] } }, {}), [p.downloadToken], 1);
  });

  it("PostHog: an autocapture of the <video> element (native HLS sets its src to the signed URL) loses the token", async () => {
    const p = await produced();
    const event = {
      uuid: "u1",
      event: "$autocapture",
      properties: { $pathname: "/live/club/cup/open/fixtures/f1", $elements: [{ tag_name: "video", attr__src: p.live }], $el_text: "" },
    };
    expectClean(posthogBeforeSend(event as never), [p.token], 1);
  });

  // The review of Task 17 (unverified, owner check pending): `ph-no-capture` hides DOM, not network. When the PostHog project records
  // network requests, a replay stores each request's URL, and the player's hls.js asks for the manifest, every playlist and every
  // segment with the token in the path. `before_send` never sees those entries, so the recorder's own hook is the door.
  it("PostHog session recording: the init hands the recorder a network mask, and the manifest, playlist and segment requests lose the token", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("document", { cookie: "" });
    await import("../../instrumentation-client");
    const posthog = (await import("posthog-js")).default;
    const calls = vi.mocked(posthog.init).mock.calls;
    expect(calls, "the client config calls posthog.init once").toHaveLength(1);
    const recording = (calls[0]![1] as Options).session_recording as Options | undefined;
    expect(recording, "session_recording is configured").toBeDefined();
    const mask = recording!.maskCapturedNetworkRequestFn;
    // A custom mask turns off posthog-js's own body redaction (`scrubPayloads` runs only when no mask is given), and the client
    // setting beats the project's remote one: with bodies off there is nothing for the lost redaction to miss.
    expect(recording!.recordBody, "no request or response body is ever recorded").toBe(false);

    const p = await produced();
    const own = "https://seazn.club/api/v1/public/fixtures/3f1a2b04-8c1d-4e5f-9a6b-7c8d9e0f1a2b/video";
    // A performance-entry-shaped request as the recorder builds it: `name` is the URL.
    const request = (name: string, extra: Record<string, unknown> = {}) => ({ name, entryType: "resource", initiatorType: "xmlhttprequest", method: "GET", status: 200, ...extra });
    let checked = 0;
    for (const url of [p.live, p.replay, p.variant, p.segment, p.download]) {
      const out = run(mask, request(url)) as { name: string; status: number; method: string } | null | undefined;
      expect(out, "a request is masked, never dropped").toBeTruthy();
      expectClean(out, [p.token, p.recordingToken, p.downloadToken], 1);
      expect(out!.name.startsWith(`https://${HOST}/[token]/`), `the host and the rest of the path stay (${out!.name})`).toBe(true);
      expect([out!.status, out!.method], "the entry keeps its timing and status fields").toEqual([200, "GET"]);
      checked++;
    }
    expect(checked, "anti-vacuity: five signed URLs were masked").toBe(5);

    // The headers and bodies the recorder may also hold go through the same scrubber (a scoring link's token, as a Bearer).
    const scoring = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";
    const withHeaders = run(mask, request(`https://seazn.club/score/${scoring}`, { requestHeaders: { authorization: `Bearer ${scoring}` } }));
    expect(JSON.stringify(withHeaders)).not.toContain(scoring);
    expect(JSON.stringify(withHeaders)).toContain("[token]");

    // The negative pair: our own request has nothing to scrub, comes back whole and is not dropped.
    const untouched = request(own, { requestHeaders: { accept: "application/json" } });
    expect(run(mask, untouched)).toEqual(untouched);
  });
});
