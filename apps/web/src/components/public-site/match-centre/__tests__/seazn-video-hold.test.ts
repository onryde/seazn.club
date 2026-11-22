// Seazn-hosted video, Phase 1 visual re-capture R2: WHEN the island holds its box through an answer with nothing to play (a session
// warming, or just stopped with its recording not locked yet). The rules are pure and live in seazn-video-hold.ts; the island's wiring
// (the box staying across reads, the one collapse) is seazn-video-island.test.tsx's.
//
// Expected values come from the engine's own declarations: the recording's lock window is `FINALISATION_GRACE_SECONDS` (the very
// grace the stream tick's Seazn pass waits out before it calls a session's recordings settled), a read is `SEAZN_VIDEO_POLL_FLOOR_MS`.
import { describe, expect, it } from "vitest";
import { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { FINALISATION_GRACE_SECONDS } from "@/server/relay/config";
import { SEAZN_VIDEO_HOLD_MS, holdAfterAnswer, holdWait, parseHold, showsPlayer } from "../seazn-video-hold";
import { SEAZN_VIDEO_POLL_FLOOR_MS } from "../seazn-video-schedule";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const signed = (name: string) => ({ src: `https://playback.fake.invalid/tok-${name}/manifest/video.m3u8`, expiresAt: new Date(NOW + 3_600_000).toISOString() });
const part = (partNo: number, player: "hls" | "embed" = "hls") => ({ partNo, player, ...signed(`p${partNo}`) });
const answer = (v: { live?: ReturnType<typeof signed> | null; replay?: ReturnType<typeof part>[] }): PublicFixtureVideo =>
  PublicFixtureVideo.parse({ live: v.live ?? null, replay: v.replay ?? [] });

describe("SEAZN_VIDEO_HOLD_MS: how long an empty answer is a wait after a player was on screen", () => {
  it("covers the recording's whole lock window after a Stop, plus one read (the Stop can come a poll before the page sees it)", () => {
    expect(SEAZN_VIDEO_HOLD_MS).toBeGreaterThanOrEqual(FINALISATION_GRACE_SECONDS * 1000 + SEAZN_VIDEO_POLL_FLOOR_MS);
  });
});

describe("showsPlayer: does the answer have something the stage draws", () => {
  it("EMPTY CASE FIRST: the empty answer, and an answer of embeds alone (no rendering until Task 25), draw no player", () => {
    expect(showsPlayer(answer({}))).toBe(false);
    expect(showsPlayer(answer({ replay: [part(1, "embed"), part(2, "embed")] }))).toBe(false);
  });
  it("a live, an hls part, and an hls part beside an embed each draw one", () => {
    expect(showsPlayer(answer({ live: signed("l") }))).toBe(true);
    expect(showsPlayer(answer({ replay: [part(1)] }))).toBe(true);
    expect(showsPlayer(answer({ replay: [part(1, "embed"), part(2)] }))).toBe(true);
  });
});

describe("holdAfterAnswer: the wait only ever starts on a player, and runs down on nothing", () => {
  it("EMPTY CASE FIRST: an empty answer leaves the wait where it was — absent stays absent, a running one is not extended", () => {
    expect(holdAfterAnswer(null, answer({}), NOW), "nothing was being waited for").toBeNull();
    expect(holdAfterAnswer(NOW + 5_000, answer({}), NOW), "a running wait is not renewed by nothing").toBe(NOW + 5_000);
    expect(holdAfterAnswer(NOW - 5_000, answer({}), NOW), "an elapsed one stays elapsed").toBe(NOW - 5_000);
  });
  it("an answer with a player (live, or a recording) starts the wait afresh from that read — also over a wait that had run out", () => {
    for (const video of [answer({ live: signed("l") }), answer({ replay: [part(1)] })]) {
      for (const before of [null, NOW - 5_000, NOW + 5_000]) {
        expect(holdAfterAnswer(before, video, NOW), `from ${before}`).toBe(NOW + SEAZN_VIDEO_HOLD_MS);
      }
    }
  });
  it("an answer of embeds alone is nothing to draw, so it renews nothing", () => {
    expect(holdAfterAnswer(null, answer({ replay: [part(1, "embed")] }), NOW)).toBeNull();
  });
});

describe("parseHold: the plan's instant as the island reads it", () => {
  it("EMPTY CASE FIRST: absent and null are no wait", () => {
    expect(parseHold(undefined)).toBeNull();
    expect(parseHold(null)).toBeNull();
  });
  it("an ISO instant is its millisecond; a string that is not a date is no wait (a NaN must never hold a box for ever)", () => {
    expect(parseHold("2026-11-22T12:10:00.000Z")).toBe(NOW + 10 * 60_000);
    expect(parseHold("not a date")).toBeNull();
    expect(parseHold("")).toBeNull();
  });
});

describe("holdWait: when the box lets go", () => {
  it("answered: a wait still to run releases when it ends; one that has run out releases at once", () => {
    expect(holdWait(NOW + 40_000, NOW, true)).toBe(40_000);
    expect(holdWait(NOW, NOW, true), "exactly now").toBe(0);
    expect(holdWait(NOW - 1, NOW, true), "an answer came and nothing is being waited for any more").toBe(0);
  });
  it("not answered yet: a wait still to run releases when it ends (the route may never answer)", () => {
    expect(holdWait(NOW + 40_000, NOW, false)).toBe(40_000);
  });
  it("not answered yet, and the plan's wait ran out before the page even loaded (an old cached page): no release — the first answer decides, so a live one is never collapsed first", () => {
    expect(holdWait(NOW - 1, NOW, false)).toBeNull();
    expect(holdWait(NOW, NOW, false)).toBeNull();
  });
});
