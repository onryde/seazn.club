// Seazn-hosted video, Phase 1 visual re-capture R2: WHEN the island holds its box through an answer with nothing to play (a session
// warming, or just stopped with its recording not locked yet). The rules are pure and live in seazn-video-hold.ts; the island's wiring
// (the box staying across reads, the one collapse) is seazn-video-island.test.tsx's.
//
// Expected values come from the engine's own declarations, never from the constants under test: a recording reaches a viewer by
// Cloudflare's own hold after the input disconnects (`INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS`), then the stream tick that locks
// it (`STREAM_TICK_PERIOD_SECONDS`, read back off the Worker's crons by config.test.ts), then one read (the schedule's ceiling); a Stop
// is seen one live poll (the floor) late and takes at most `ENDING_TIMEOUT_SECONDS` to end the session (review I1).
import { describe, expect, it } from "vitest";
import { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { ENDING_TIMEOUT_SECONDS, FINALISATION_GRACE_SECONDS, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS, STREAM_TICK_PERIOD_SECONDS } from "@/server/relay/config";
import { SEAZN_RECORDING_SHOWN_BY_MS, SEAZN_VIDEO_HOLD_MS, holdAfterAnswer, holdWait, parseHold, showsPlayer } from "../seazn-video-hold";
import { SEAZN_VIDEO_POLL_CEILING_MS, SEAZN_VIDEO_POLL_FLOOR_MS } from "../seazn-video-schedule";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const signed = (name: string) => ({ src: `https://playback.fake.invalid/tok-${name}/manifest/video.m3u8`, expiresAt: new Date(NOW + 3_600_000).toISOString() });
const part = (partNo: number, player: "hls" | "embed" = "hls") => ({ partNo, player, ...signed(`p${partNo}`) });
const answer = (v: { live?: ReturnType<typeof signed> | null; replay?: ReturnType<typeof part>[] }): PublicFixtureVideo =>
  PublicFixtureVideo.parse({ live: v.live ?? null, replay: v.replay ?? [] });

// What a viewer waits for after a Stop, from the real path: Cloudflare finishes the recording a hold after the input goes, the next tick
// firing locks it (one whole period on the slowest deployment), and the island's next read carries it (one read at the schedule's ceiling).
const CLOUDFLARE_HOLD_MS = (INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS) * 1000;
const TICK_MS = STREAM_TICK_PERIOD_SECONDS * 1000;
const PATH_FROM_END_MS = CLOUDFLARE_HOLD_MS + TICK_MS + SEAZN_VIDEO_POLL_CEILING_MS;

describe("SEAZN_RECORDING_SHOWN_BY_MS: how long after a session's END a recording can still arrive at a viewer (review I1)", () => {
  it("covers Cloudflare's hold, a whole tick period (the slowest deployment's) and one read — the lock arrives one tick late and the viewer still gets it", () => {
    expect(SEAZN_RECORDING_SHOWN_BY_MS).toBeGreaterThanOrEqual(PATH_FROM_END_MS);
  });
  it("premise of the finding: the old window (the grace plus one read) ended BEFORE a lock one tick late, so it would have collapsed the box and re-expanded it", () => {
    const OLD_WINDOW_MS = FINALISATION_GRACE_SECONDS * 1000 + SEAZN_VIDEO_POLL_FLOOR_MS;
    expect(CLOUDFLARE_HOLD_MS + TICK_MS, "the lock, one tick after Cloudflare finished").toBeGreaterThan(OLD_WINDOW_MS);
    expect(SEAZN_RECORDING_SHOWN_BY_MS, "and the new window reaches it").toBeGreaterThan(CLOUDFLARE_HOLD_MS + TICK_MS);
  });
});

describe("SEAZN_VIDEO_HOLD_MS: how long an empty answer is a wait after a player was on screen", () => {
  it("covers a poll for the Stop to be seen, the whole stop (the ending backstop's bound) and then the recording's path to the viewer", () => {
    expect(SEAZN_VIDEO_HOLD_MS).toBeGreaterThanOrEqual(SEAZN_VIDEO_POLL_FLOOR_MS + ENDING_TIMEOUT_SECONDS * 1000 + PATH_FROM_END_MS);
  });
});

describe("showsPlayer: does the answer have something the stage draws", () => {
  it("EMPTY CASE FIRST: the empty answer draws no player", () => {
    expect(showsPlayer(answer({}))).toBe(false);
  });
  it("a live, an hls part, an embed part alone (the replay host's player, Task 25: CLS gap 3), and a mix each draw one", () => {
    expect(showsPlayer(answer({ live: signed("l") }))).toBe(true);
    expect(showsPlayer(answer({ replay: [part(1)] }))).toBe(true);
    expect(showsPlayer(answer({ replay: [part(1, "embed")] }))).toBe(true);
    expect(showsPlayer(answer({ replay: [part(1, "embed"), part(2, "embed")] }))).toBe(true);
    expect(showsPlayer(answer({ replay: [part(1, "embed"), part(2)] }))).toBe(true);
  });
});

describe("holdAfterAnswer: the wait only ever starts on a player, and runs down on nothing", () => {
  it("EMPTY CASE FIRST: an empty answer leaves the wait where it was — absent stays absent, a running one is not extended", () => {
    expect(holdAfterAnswer(null, answer({}), NOW), "nothing was being waited for").toBeNull();
    expect(holdAfterAnswer(NOW + 5_000, answer({}), NOW), "a running wait is not renewed by nothing").toBe(NOW + 5_000);
    expect(holdAfterAnswer(NOW - 5_000, answer({}), NOW), "an elapsed one stays elapsed").toBe(NOW - 5_000);
  });
  it("an answer with a player (live, a recording, or the replay host's copy) starts the wait afresh from that read — also over a wait that had run out", () => {
    for (const video of [answer({ live: signed("l") }), answer({ replay: [part(1)] }), answer({ replay: [part(1, "embed")] })]) {
      for (const before of [null, NOW - 5_000, NOW + 5_000]) {
        expect(holdAfterAnswer(before, video, NOW), `from ${before}`).toBe(NOW + SEAZN_VIDEO_HOLD_MS);
      }
    }
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
  it("a wait still to run releases when it ends (the route may never answer, so the answer is not waited for)", () => {
    expect(holdWait(NOW + 40_000, NOW)).toBe(40_000);
  });
  it("a wait that has run out releases at once (review m3): the plan's word on an old cached page is stale, and on a route that never answers the line must still go", () => {
    expect(holdWait(NOW, NOW), "exactly now").toBe(0);
    expect(holdWait(NOW - 1, NOW), "a ms ago").toBe(0);
    expect(holdWait(NOW - 10 * 60_000, NOW), "ten minutes ago").toBe(0);
  });
});
