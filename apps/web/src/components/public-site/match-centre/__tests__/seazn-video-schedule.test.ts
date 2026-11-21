// Seazn-hosted video, Phase 1 Task 15: WHEN the match page's island asks the video route again (`nextVideoFetchMs`). Pure: a
// clock in, a delay out. The rules are the plan's (Review Focus 3 and the 2026-11-21 recommendation):
//   - no video yet, or none to show (warming, or ended with no recording signed yet): look again in 30 s;
//   - live: at the 30 s floor, whatever the token's life (Task 19, the Task 15 review's r3: a Stop must reach a page that is open,
//     within one poll, not ~55 minutes later at the token's refresh point; a re-read at 30 s also always lands inside the token's
//     refresh window, so it carries the refresh too);
//   - replay only, and every part is the replay host's embed (Task 25): NO timer (a swap of its `src` would restart it);
//   - replay only with an `hls` part (the interim Cloudflare recording): the live rule over those parts' earliest `expiresAt`.
// The expected values are the rule's arithmetic from the declared window, never read off the function under test.
import { describe, expect, it } from "vitest";
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_VIDEO_POLL_FLOOR_MS, nextVideoFetchMs } from "../seazn-video-schedule";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const MIN = 60_000;
const REFRESH_MS = SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const live = (offsetMs: number): PublicFixtureVideo["live"] => ({ src: "https://host.invalid/t/manifest/video.m3u8", expiresAt: at(offsetMs) });
const part = (partNo: number, offsetMs: number, player: "hls" | "embed" = "hls"): PublicFixtureVideo["replay"][number] => ({
  partNo,
  player,
  src: `https://host.invalid/p${partNo}/manifest/video.m3u8`,
  expiresAt: at(offsetMs),
});

describe("nextVideoFetchMs: nothing to show yet", () => {
  it("EMPTY CASE FIRST: no answer yet, and an answer with no live and no replay, both look again in 30 s", () => {
    expect(nextVideoFetchMs(null, NOW)).toBe(30_000);
    expect(nextVideoFetchMs({ live: null, replay: [] }, NOW)).toBe(30_000);
    expect(SEAZN_VIDEO_POLL_FLOOR_MS, "the floor IS the plan's 30 s").toBe(30_000);
  });
});

describe("nextVideoFetchMs: live", () => {
  // r3 (Task 15 review, Task 19): the live answer is re-read at the floor, so a page that is open when the organiser stops learns it
  // within one poll. The expiries below are the ones the old rule (the token's refresh point) answered 55 and 25 min for.
  it("an expiry 60 min away is re-read at the 30 s floor, not at the token's refresh point (55 min)", () => {
    const wait = nextVideoFetchMs({ live: live(60 * MIN), replay: [] }, NOW);
    expect(wait).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(wait, "the refresh point is where a stopped live used to linger").not.toBe(60 * MIN - REFRESH_MS);
  });

  it("the delay does not follow the token: an expiry 30 min away is also the 30 s floor", () => {
    expect(nextVideoFetchMs({ live: live(30 * MIN), replay: [] }, NOW)).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });

  it("a 30 s re-read always lands inside the token's refresh window, so the floor carries the refresh as well", () => {
    expect(SEAZN_VIDEO_POLL_FLOOR_MS, "premise: the floor is shorter than the window the server re-mints in").toBeLessThan(REFRESH_MS);
  });

  it("an expiry closer than the refresh window (2 min), exactly on it, already past, or not a date: the 30 s floor", () => {
    expect(nextVideoFetchMs({ live: live(2 * MIN), replay: [] }, NOW)).toBe(30_000);
    expect(nextVideoFetchMs({ live: live(REFRESH_MS), replay: [] }, NOW), "0 ms left to wait").toBe(30_000);
    expect(nextVideoFetchMs({ live: live(-10 * MIN), replay: [] }, NOW)).toBe(30_000);
    expect(nextVideoFetchMs({ live: { src: "https://host.invalid/t/manifest/video.m3u8", expiresAt: "not a date" }, replay: [] }, NOW), "NaN must not become the delay").toBe(30_000);
  });

  it("recordings listed beside a live source set no delay of their own (only the live source plays): the floor", () => {
    expect(nextVideoFetchMs({ live: live(60 * MIN), replay: [part(1, 10 * MIN)] }, NOW)).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });
});

describe("nextVideoFetchMs: replay only", () => {
  it("every part is the replay host's embed: no timer at all", () => {
    expect(nextVideoFetchMs({ live: null, replay: [part(1, 60 * MIN, "embed"), part(2, 60 * MIN, "embed")] }, NOW)).toBeNull();
  });

  it("an hls part (the interim Cloudflare recording) 60 min away: 55 min", () => {
    expect(nextVideoFetchMs({ live: null, replay: [part(1, 60 * MIN)] }, NOW)).toBe(55 * MIN);
  });

  it("several hls parts: the EARLIEST expiry sets the delay, whatever the order they arrive in", () => {
    const parts = [part(1, 60 * MIN), part(3, 20 * MIN), part(4, 40 * MIN)];
    expect(nextVideoFetchMs({ live: null, replay: parts }, NOW)).toBe(20 * MIN - REFRESH_MS);
    expect(nextVideoFetchMs({ live: null, replay: [...parts].reverse() }, NOW)).toBe(20 * MIN - REFRESH_MS);
  });

  it("an embed part beside an hls one is not on the timer: only the hls part's expiry counts", () => {
    expect(nextVideoFetchMs({ live: null, replay: [part(1, 5 * MIN, "embed"), part(2, 60 * MIN)] }, NOW)).toBe(55 * MIN);
  });

  it("an hls part about to lapse: the 30 s floor", () => {
    expect(nextVideoFetchMs({ live: null, replay: [part(1, 1 * MIN)] }, NOW)).toBe(30_000);
  });
});
