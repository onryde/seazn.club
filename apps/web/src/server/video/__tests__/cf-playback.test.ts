// Seazn-hosted video, Task 13 (C1, C5; recommendation 2026-11-21 G-B): signed Cloudflare playback URLs. One token per uid is
// minted through the ingest port and cached, so the calls scale with live inputs and recordings, never with viewers. The fake
// mints `fake.<uid>.<exp seconds>[.dl]` (fakes.test.ts pins that), so a token read back here says which uid and expiry it was
// minted for.
//
// Expected values are the plan's numbers typed as literals (a 1 h token, re-minted with 5 min left: Task 8), and the URL
// shapes are Cloudflare's (C1: `/<token>/manifest/video.m3u8`; C5: `/<token>/downloads/default.mp4`), never read off the
// module under test. Every case builds its own empty cache, so no case depends on another's order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warn, capture } = vi.hoisted(() => ({ warn: vi.fn(), capture: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: { warn } }));
vi.mock("@/lib/sentry", () => ({ captureError: capture }));
import { parseSignedAddress, withToken } from "@/components/public-site/match-centre/seazn-signed-address";
import { FakeIngest } from "@/server/relay/fakes";
import { CloudflareIngest } from "@/server/relay/ingest-cf";
import { PlaybackTokenRecentlyFailed, createPlaybackTokenCache, signDownload, signLivePlayback, signRecordingPlayback } from "../cf-playback";

const MIN = 60_000;
/** The plan's token life (Task 8: SEAZN_LIVE_TOKEN_TTL_SECONDS = 3600), typed here. */
const TTL_MS = 3600 * 1000;
/** Phase 1 review I1: how long a failed mint is remembered (the fix brief's 30-60 s; 60 s chosen), typed here. */
const FAILURE_WINDOW_MS = 60_000;
const T0 = new Date("2026-11-21T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
/** Cloudflare's signed live/recording manifest: the token is one PATH segment. A live programme manifest may carry Cloudflare's
 *  documented LL-HLS query (W-LL, below); a recording's never does (PLAY_PLAIN). */
const PLAY = /^https:\/\/playback\.fake\.invalid\/([^/?]+)\/manifest\/video\.m3u8(?:\?protocol=llhls)?$/;
const PLAY_PLAIN = /^https:\/\/playback\.fake\.invalid\/([^/?]+)\/manifest\/video\.m3u8$/;

function rig() {
  const ingest = new FakeIngest();
  const mint = vi.spyOn(ingest, "playbackToken");
  return { deps: { ingest, tokenCache: createPlaybackTokenCache() }, mint };
}
const tokenOf = (src: string): string => {
  const m = PLAY.exec(src);
  expect(m, `a signed manifest URL: ${src}`).not.toBeNull();
  return m![1]!;
};

beforeEach(() => {
  // The fake relay, with no STREAM_PLAYBACK_HOST: the host is the fake driver's own (config.ts FAKE_PLAYBACK_HOST).
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RELAY_DRIVERS", "");
  vi.stubEnv("STREAM_PLAYBACK_HOST", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("a signed manifest names its video: `id` (the match page holds a playing address on it)", () => {
  it("is the same for one uid whichever process signs it (a cold cache, another expiry, another token) and for the live and a recording of one uid alike; another uid has another", async () => {
    const a = await signLivePlayback(rig().deps, "in-1", T0);
    const b = await signLivePlayback(rig().deps, "in-1", at(7 * MIN));
    const other = await signLivePlayback(rig().deps, "in-2", T0);
    const rec = await signRecordingPlayback(rig().deps, "in-1", T0);
    expect(tokenOf(a.src), "PREMISE: two machines minted two different tokens for one uid").not.toBe(tokenOf(b.src));
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(rec.id);
    expect(other.id).not.toBe(a.id);
  });
  it("is opaque: sixteen hex characters that contain neither the uid nor the token", async () => {
    const live = await signLivePlayback(rig().deps, "in-1", T0);
    expect(live.id).toMatch(/^[0-9a-f]{16}$/);
    expect(live.id).not.toContain("in-1");
    expect(live.src).not.toContain(live.id);
  });
});

describe("signLivePlayback (C1)", () => {
  it("answers the input's signed manifest — the token a path segment, the LL-HLS query only when it is on — expiring 1 h after now", async () => {
    vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", "false");
    const { deps, mint } = rig();
    const live = await signLivePlayback(deps, "in-1", T0);
    expect(live.src).not.toContain("?");
    expect(tokenOf(live.src)).toBe(`fake.in-1.${T0.getTime() / 1000 + 3600}`);
    expect(live.expiresAt).toBe(at(TTL_MS).toISOString());
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]).toEqual(["in-1", { expiresAt: at(TTL_MS) }]);   // no `downloadable` at all: a viewer's token
  });

  it("is minted ONCE while more than 5 min of its life is left: 10 and 54 min later reuse it (same URL, same expiry); 56 min later a new one is minted", async () => {
    const { deps, mint } = rig();
    const first = await signLivePlayback(deps, "in-1", T0);
    const ten = await signLivePlayback(deps, "in-1", at(10 * MIN));
    const fiftyFour = await signLivePlayback(deps, "in-1", at(54 * MIN));
    expect(mint, "10 and 54 min: reused").toHaveBeenCalledTimes(1);
    expect([ten, fiftyFour]).toEqual([first, first]);
    const fiftySix = await signLivePlayback(deps, "in-1", at(56 * MIN));
    expect(mint, "56 min: 4 min left, under the 5 min window").toHaveBeenCalledTimes(2);
    expect(fiftySix.expiresAt).toBe(at(56 * MIN + TTL_MS).toISOString());
    expect(fiftySix.src).not.toBe(first.src);
    // The sequence goes on from the NEW token: 10 min after the re-mint is a reuse again.
    expect(await signLivePlayback(deps, "in-1", at(66 * MIN))).toEqual(fiftySix);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("viewers arriving together share ONE mint (the call in flight is the cache entry)", async () => {
    const { deps, mint } = rig();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => signLivePlayback(deps, "in-1", T0)));
    expect(answers).toHaveLength(5);
    expect(new Set(answers.map((a) => a.src)).size).toBe(1);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("review I1: a failed mint is REMEMBERED for 60 s under its key — its error reaches the caller, a call inside the window is refused by name with no second Cloudflare call, and the first call after it mints again", async () => {
    const { deps, mint } = rig();
    mint.mockRejectedValueOnce(new Error("cloudflare playback token: HTTP 503"));
    await expect(signLivePlayback(deps, "in-1", T0)).rejects.toThrow(/HTTP 503/);
    for (const later of [1_000, 30_000, FAILURE_WINDOW_MS - 1]) {
      await expect(signLivePlayback(deps, "in-1", at(later)), `${later} ms later`).rejects.toBeInstanceOf(PlaybackTokenRecentlyFailed);
    }
    expect(mint, "inside the window: the one mint").toHaveBeenCalledTimes(1);
    const ok = await signLivePlayback(deps, "in-1", at(FAILURE_WINDOW_MS));
    expect(tokenOf(ok.src)).toMatch(/^fake\.in-1\./);
    expect(mint, "the window is over: a new mint").toHaveBeenCalledTimes(2);
    // The recovered token is cached as any other: 10 min later it is reused.
    expect(await signLivePlayback(deps, "in-1", at(FAILURE_WINDOW_MS + 10 * MIN))).toEqual(ok);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("review I1: the window is per KEY — another uid, and the same uid's download token, still mint; the refusal quotes no uid and no token", async () => {
    const { deps, mint } = rig();
    mint.mockRejectedValueOnce(new Error("cloudflare playback token: HTTP 429"));
    await expect(signLivePlayback(deps, "in-1", T0)).rejects.toThrow(/HTTP 429/);
    expect(tokenOf((await signLivePlayback(deps, "in-2", at(1_000))).src)).toMatch(/^fake\.in-2\./);
    expect(await signDownload(deps, "in-1", at(1_000), 300)).toMatch(/\/fake\.in-1\.\d+\.dl\//);
    expect(mint).toHaveBeenCalledTimes(3);
    const refusal = await signLivePlayback(deps, "in-1", at(2_000)).then(() => null, (e: unknown) => e as Error);
    expect(refusal).toBeInstanceOf(PlaybackTokenRecentlyFailed);
    expect(refusal!.name).toBe("PlaybackTokenRecentlyFailed");
    expect(refusal!.message).not.toMatch(/in-1|fake\./);
    expect(mint).toHaveBeenCalledTimes(3);
  });

  it("review I1: viewers arriving together on a mint that fails all see ITS error, from one Cloudflare call", async () => {
    const { deps, mint } = rig();
    mint.mockRejectedValueOnce(new Error("cloudflare playback token: HTTP 502"));
    const answers = await Promise.allSettled([1, 2, 3, 4].map(() => signLivePlayback(deps, "in-1", T0)));
    expect(answers.map((a) => (a.status === "rejected" ? (a.reason as Error).message : "ok"))).toEqual(Array(4).fill("cloudflare playback token: HTTP 502"));
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("review I1: a mint that TIMES OUT is a failed mint — the real adapter gives up at its 10 s timeout, the caller is refused, and inside the window Cloudflare is not asked again", async () => {
    // The adapter's own timeout, driven by hand: `AbortSignal.timeout` answers a signal this test aborts, so no real 10 s passes.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    try {
      const deps = { ingest: new CloudflareIngest({ fetchImpl, accountId: "acct", token: "tok" }), tokenCache: createPlaybackTokenCache() };
      const first = signLivePlayback(deps, "in-1", T0).then(() => null, (e: unknown) => e as Error);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      expect(timeout, "the mint carries the plan's 10 s timeout").toHaveBeenCalledWith(10_000);
      deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      expect((await first)?.message).toMatch(/^cloudflare playbackToken: request failed before a response/);
      await expect(signLivePlayback(deps, "in-1", at(1_000))).rejects.toBeInstanceOf(PlaybackTokenRecentlyFailed);
      expect(fetchImpl, "the timed-out mint is the only Cloudflare call").toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it("a deployment on a real relay with no STREAM_PLAYBACK_HOST refuses by name BEFORE any mint (a guessed host would be a lie)", async () => {
    vi.stubEnv("RELAY_DRIVERS", "live");
    const { deps, mint } = rig();
    await expect(signLivePlayback(deps, "in-1", T0)).rejects.toThrow(/STREAM_PLAYBACK_HOST/);
    expect(mint).not.toHaveBeenCalled();
    // The pair: the same relay with the host set signs on that host.
    vi.stubEnv("STREAM_PLAYBACK_HOST", "customer-abc.cloudflarestream.com");
    expect((await signLivePlayback(deps, "in-1", T0)).src).toMatch(/^https:\/\/customer-abc\.cloudflarestream\.com\/[^/?]+\/manifest\/video\.m3u8(?:\?protocol=llhls)?$/);
  });

  it("expired entries leave the cache when a later token is minted, so a long-lived process does not keep every uid it ever signed", async () => {
    const { deps } = rig();
    await signLivePlayback(deps, "in-1", T0);
    await signLivePlayback(deps, "in-2", at(2 * TTL_MS));
    expect(deps.tokenCache.size, "in-1's token expired an hour ago").toBe(1);
    // The pair: a token still alive is kept beside the new one.
    await signLivePlayback(deps, "in-3", at(2 * TTL_MS + MIN));
    expect(deps.tokenCache.size).toBe(2);
  });
});

describe("signRecordingPlayback (recommendation 2026-11-21, G-B: the interim replay)", () => {
  it("answers the live shape for a recording's uid, from the same cache: 10 min later is one mint; a video uid and an input uid are two", async () => {
    const { deps, mint } = rig();
    const rec = await signRecordingPlayback(deps, "v-rec", T0);
    expect(rec.src).not.toContain("?");
    expect(tokenOf(rec.src)).toBe(`fake.v-rec.${T0.getTime() / 1000 + 3600}`);
    expect(rec.expiresAt).toBe(at(TTL_MS).toISOString());
    expect(await signRecordingPlayback(deps, "v-rec", at(10 * MIN))).toEqual(rec);
    expect(mint).toHaveBeenCalledTimes(1);
    const live = await signLivePlayback(deps, "in-1", at(10 * MIN));
    expect(mint, "the cache key is the uid").toHaveBeenCalledTimes(2);
    expect(tokenOf(live.src)).toMatch(/^fake\.in-1\./);
  });
});

describe("signDownload (C5, Phase 2's mover)", () => {
  it("answers https://<host>/<token>/downloads/default.mp4 with a DOWNLOADABLE token of the asked life — and a download token never serves a viewer", async () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", "customer-abc.cloudflarestream.com");
    const { deps, mint } = rig();
    const url = await signDownload(deps, "v-rec", T0, 300);
    const m = /^https:\/\/customer-abc\.cloudflarestream\.com\/([^/?]+)\/downloads\/default\.mp4$/.exec(url);
    expect(m, url).not.toBeNull();
    expect(m![1]).toBe(`fake.v-rec.${T0.getTime() / 1000 + 300}.dl`);
    expect(mint.mock.calls[0]).toEqual(["v-rec", { expiresAt: at(300_000), downloadable: true }]);
    // The same uid's viewer token is a different, non-downloadable mint (the key is the uid AND downloadable).
    const play = await signRecordingPlayback(deps, "v-rec", T0);
    expect(play.src).not.toContain(".dl");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("m5: a cached download token is reused only when it lives at least as long as the caller asks — the Bunny fetch's 6 h ask 10 min after a 6 h mint gets a NEW 6 h token; a 5 min ask reuses it", async () => {
    const { deps, mint } = rig();
    const SIX_H = 6 * 3600;
    const tokenIn = (url: string) => /\/([^/]+)\/downloads\/default\.mp4$/.exec(url)![1]!;
    const first = await signDownload(deps, "v-rec", T0, SIX_H);
    expect(tokenIn(first)).toBe(`fake.v-rec.${T0.getTime() / 1000 + SIX_H}.dl`);
    const again = await signDownload(deps, "v-rec", at(10 * MIN), SIX_H);
    expect(mint, "5 h 50 min left is less than the 6 h asked").toHaveBeenCalledTimes(2);
    expect(tokenIn(again)).toBe(`fake.v-rec.${at(10 * MIN).getTime() / 1000 + SIX_H}.dl`);
    const short = await signDownload(deps, "v-rec", at(20 * MIN), 300);
    expect(mint, "a 5 min ask is covered by the token minted 10 min ago").toHaveBeenCalledTimes(2);
    expect(short).toBe(again);
  });

  it("m5: an asked life that is not a whole number of seconds between 1 and Cloudflare's 24 h cap is refused by name, before any mint", async () => {
    const { deps, mint } = rig();
    for (const bad of [0, -1, Number.NaN, 1.5, 24 * 3600 + 1]) {
      await expect(signDownload(deps, "v-rec", T0, bad), String(bad)).rejects.toThrow(/signDownload: ttlSeconds/);
    }
    expect(mint).not.toHaveBeenCalled();
    // The pair: both ends of the range are accepted.
    await signDownload(deps, "v-a", T0, 1);
    await signDownload(deps, "v-b", T0, 24 * 3600);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("the other order: a viewer's live token cached for a uid is never handed out as its download token", async () => {
    const { deps, mint } = rig();
    await signRecordingPlayback(deps, "v-rec", T0);
    const url = await signDownload(deps, "v-rec", at(MIN), 3600);
    expect(url).toMatch(/^https:\/\/playback\.fake\.invalid\/fake\.v-rec\.\d+\.dl\/downloads\/default\.mp4$/);
    expect(mint).toHaveBeenCalledTimes(2);
  });
});

// W-LL (owner 2026-11-26). Cloudflare's own post (blog.cloudflare.com/cloudflare-stream-low-latency-hls-open-beta/): only its Stream
// player picks LL-HLS by itself; any other player gets plain HLS unless the manifest URL carries `?protocol=llhls`. The query is
// typed here as the post spells it. It goes on the LIVE PROGRAMME manifest only: the token stays the first path segment, so the match
// page's token swap and its same-video check (both read the address after the token) still see one shape.
describe("W-LL: the live programme manifest asks for LL-HLS with ?protocol=llhls (STREAM_PROGRAMME_LOW_LATENCY)", () => {
  it("on (true anywhere; unset on stg only): the live manifest ends in ?protocol=llhls after the token path; off (false, or unset elsewhere): it is the plain manifest; a recording and a download never carry it either way", async () => {
    let checked = 0;
    // [the variable, ENV_NAME, on]: the default is on only where the deploy says it is stg (review I3).
    for (const [env, envName, want] of [
      [undefined, "stg", true], ["", "stg", true], ["true", "prod", true], ["TRUE", "", true], ["false", "stg", false],
      [undefined, "prod", false], ["", "local", false], [undefined, "", false],
    ] as const) {
      vi.stubEnv("ENV_NAME", envName);
      vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", env);
      const { deps } = rig();
      const live = await signLivePlayback(deps, "in-1", T0);
      const recording = await signRecordingPlayback(deps, "in-1", T0);
      const download = await signDownload(deps, "in-1", T0, 300);
      const token = tokenOf(live.src);
      expect(live.src, `env ${JSON.stringify(env)} on ${JSON.stringify(envName)}`).toBe(`https://playback.fake.invalid/${token}/manifest/video.m3u8${want ? "?protocol=llhls" : ""}`);
      expect(recording.src, "a recording is plain HLS").toMatch(PLAY_PLAIN);
      expect(download, "a download never carries it").not.toContain("?");
      checked++;
    }
    expect(checked, "eight environments").toBe(8);
  });

  // Review I2: this runs on every live read of the match page; a throw is a 500 on every poll of a live Seazn fixture.
  it("a malformed value never throws or rejects: the live manifest is the plain one, on stg too, every read answers, and it is reported ONCE per value through the logger and the Sentry helper", async () => {
    let checked = 0;
    for (const bad of ["ll-bad-a", "ll-bad-b", "ll-bad-c"]) {
      vi.stubEnv("ENV_NAME", "stg");
      vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", bad);
      const { deps } = rig();
      const before = [warn.mock.calls.length, capture.mock.calls.length];
      // A SYNCHRONOUS throw would escape the caller's `.then(ok, err)` isolation (seazn-video.ts), so it is asserted on its own.
      expect(() => void signLivePlayback(deps, "in-1", T0), bad).not.toThrow();
      await expect(signLivePlayback(deps, "in-1", T0), bad).resolves.toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect((await signLivePlayback(deps, "in-1", T0)).src, bad).toMatch(PLAY_PLAIN);
      expect([warn.mock.calls.length - before[0]!, capture.mock.calls.length - before[1]!], `${bad}: three-plus reads, one report each`).toEqual([1, 1]);
      expect(capture.mock.calls.at(-1)![0]).toBeInstanceOf(Error);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a logger or Sentry that fails cannot fail the read", async () => {
    vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", "ll-bad-d");
    warn.mockImplementationOnce(() => { throw new Error("logger down"); });
    await expect(signLivePlayback(rig().deps, "in-1", T0)).resolves.toMatchObject({ src: expect.stringMatching(PLAY_PLAIN) });
  });

  it("the id does not see the query (one video, on or off), and a re-mint changes only the token: the part after it is equal", async () => {
    vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", "true");
    const a = await signLivePlayback(rig().deps, "in-1", T0);
    const b = await signLivePlayback(rig().deps, "in-1", at(7 * MIN));
    vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", "false");
    const off = await signLivePlayback(rig().deps, "in-1", T0);
    expect(a.id).toBe(off.id);
    expect(a.src.slice(a.src.indexOf("/manifest"))).toBe("/manifest/video.m3u8?protocol=llhls");
    expect(b.src.slice(b.src.indexOf("/manifest")), "the tail after the token is the same on every machine").toBe(a.src.slice(a.src.indexOf("/manifest")));
    // The match page's own reader (seazn-signed-address.ts) on the REAL producer's output: the comparison `holdAddresses` makes
    // (same origin, same tail, another token) still holds with the query, and the hls.js token swap keeps it.
    const pa = parseSignedAddress(a.src)!;
    const pb = parseSignedAddress(b.src)!;
    expect(pa.tail).toBe("/manifest/video.m3u8?protocol=llhls");
    expect([pa.origin, pa.tail]).toEqual([pb.origin, pb.tail]);
    expect(pa.token, "PREMISE: two machines, two tokens").not.toBe(pb.token);
    expect(withToken(a.src, pb)).toBe(b.src);
  });
});
