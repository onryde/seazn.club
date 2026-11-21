// Seazn-hosted video, Task 13 (C1, C5; recommendation 2026-11-21 G-B): signed Cloudflare playback URLs. One token per uid is
// minted through the ingest port and cached, so the calls scale with live inputs and recordings, never with viewers. The fake
// mints `fake.<uid>.<exp seconds>[.dl]` (fakes.test.ts pins that), so a token read back here says which uid and expiry it was
// minted for.
//
// Expected values are the plan's numbers typed as literals (a 1 h token, re-minted with 5 min left: Task 8), and the URL
// shapes are Cloudflare's (C1: `/<token>/manifest/video.m3u8`; C5: `/<token>/downloads/default.mp4`), never read off the
// module under test. Every case builds its own empty cache, so no case depends on another's order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeIngest } from "@/server/relay/fakes";
import { createPlaybackTokenCache, signDownload, signLivePlayback, signRecordingPlayback } from "../cf-playback";

const MIN = 60_000;
/** The plan's token life (Task 8: SEAZN_LIVE_TOKEN_TTL_SECONDS = 3600), typed here. */
const TTL_MS = 3600 * 1000;
const T0 = new Date("2026-11-21T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
/** Cloudflare's signed live/recording manifest: the token is one PATH segment, and there is no query string. */
const PLAY = /^https:\/\/playback\.fake\.invalid\/([^/?]+)\/manifest\/video\.m3u8$/;

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

describe("signLivePlayback (C1)", () => {
  it("answers the input's signed manifest — the token a path segment, no `?` — expiring 1 h after now", async () => {
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

  it("a failed mint is not kept: the next call mints again, and its error reaches the caller", async () => {
    const { deps, mint } = rig();
    mint.mockRejectedValueOnce(new Error("cloudflare playback token: HTTP 503"));
    await expect(signLivePlayback(deps, "in-1", T0)).rejects.toThrow(/HTTP 503/);
    const ok = await signLivePlayback(deps, "in-1", at(MIN));
    expect(tokenOf(ok.src)).toMatch(/^fake\.in-1\./);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("a deployment on a real relay with no STREAM_PLAYBACK_HOST refuses by name BEFORE any mint (a guessed host would be a lie)", async () => {
    vi.stubEnv("RELAY_DRIVERS", "live");
    const { deps, mint } = rig();
    await expect(signLivePlayback(deps, "in-1", T0)).rejects.toThrow(/STREAM_PLAYBACK_HOST/);
    expect(mint).not.toHaveBeenCalled();
    // The pair: the same relay with the host set signs on that host.
    vi.stubEnv("STREAM_PLAYBACK_HOST", "customer-abc.cloudflarestream.com");
    expect((await signLivePlayback(deps, "in-1", T0)).src).toMatch(/^https:\/\/customer-abc\.cloudflarestream\.com\/[^/?]+\/manifest\/video\.m3u8$/);
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

  it("the other order: a viewer's live token cached for a uid is never handed out as its download token", async () => {
    const { deps, mint } = rig();
    await signRecordingPlayback(deps, "v-rec", T0);
    const url = await signDownload(deps, "v-rec", at(MIN), 3600);
    expect(url).toMatch(/^https:\/\/playback\.fake\.invalid\/fake\.v-rec\.\d+\.dl\/downloads\/default\.mp4$/);
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
