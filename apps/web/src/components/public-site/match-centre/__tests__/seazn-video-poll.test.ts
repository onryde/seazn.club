// Seazn-hosted video, Phase 1 Task 15: the island's read loop (`startVideoPoll`), the part `apps/web`'s node-only vitest cannot see
// through a component (no DOM, so an effect never runs): the island's timer, driven here through its REAL schedule
// (`nextVideoFetchMs`) with vitest's fake timers and fake clock, no network. What must hold:
//   - it reads at once, then at the schedule's delay (30 s with nothing to show, and 30 s while live too: Task 19, so a Stop reaches
//     an open page within one poll), and a new answer moves the next read with it;
//   - a replay of embeds alone sets NO timer, and a read the island asks for (a viewer picks an expired part) still happens;
//   - a failed read keeps the last answer on screen and tries again in 30 s, and a later good answer replaces it;
//   - a stop ends everything: no timer, the read in flight is aborted, and its late answer is never delivered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { startVideoPoll } from "../seazn-video-poll";
import { nextVideoFetchMs } from "../seazn-video-schedule";

const T0 = new Date("2026-11-21T12:00:00.000Z");
const MIN = 60_000;
const REFRESH_MS = SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
const EMPTY: PublicFixtureVideo = { live: null, replay: [] };
const liveFor = (ms: number): PublicFixtureVideo => ({
  live: { src: "https://host.invalid/t/manifest/video.m3u8", expiresAt: new Date(Date.now() + ms).toISOString() },
  replay: [],
});
const embedOnly: PublicFixtureVideo = {
  live: null,
  replay: [{ partNo: 1, player: "embed", src: "https://embed.invalid/p1", expiresAt: new Date(T0.getTime() + 60 * MIN).toISOString() }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A scripted route: each call answers the next step (a video, or an Error to reject with). */
function route(...steps: (PublicFixtureVideo | Error)[]) {
  const calls: { signal: AbortSignal }[] = [];
  const fetchVideo = vi.fn(async (signal: AbortSignal) => {
    calls.push({ signal });
    const step = steps[Math.min(calls.length, steps.length) - 1]!;
    if (step instanceof Error) throw step;
    return step;
  });
  return { fetchVideo, calls };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("startVideoPoll: the schedule", () => {
  it("reads at once; with nothing to show it reads again in 30 s, not before", async () => {
    const r = route(EMPTY);
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    expect(r.calls, "read at once").toHaveLength(1);
    expect(seen).toEqual([EMPTY]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r.calls, "not before 30 s").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls, "at 30 s").toHaveLength(2);
    poll.stop();
  });

  it("warming turning live without a reload: the next read's answer is delivered", async () => {
    const r = route(EMPTY, liveFor(60 * MIN));
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    expect(seen.map((v) => v.live !== null)).toEqual([false]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen.map((v) => v.live !== null), "live arrived on the second read").toEqual([false, true]);
    poll.stop();
  });

  it("live: the next read is the 30 s floor, not the token's refresh point (55 min), so a Stop reaches an open page within one poll", async () => {
    // Task 19 (the Task 15 review's r3): the live answer stops being live when the organiser stops; the page must learn it on the
    // next read. Each answer is built when it is read, so its token is always an hour long: the refresh point is never what waits.
    const answers = [liveFor(60 * MIN), liveFor(60 * MIN), EMPTY];
    let reads = 0;
    const seen: PublicFixtureVideo[] = [];
    const fetchVideo = vi.fn(async () => answers[Math.min(reads++, answers.length - 1)]!);
    const poll = startVideoPoll({ fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reads, "one tick before the floor").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads, "at the floor, 55 min before the token's refresh point").toBe(2);
    expect(60 * MIN - REFRESH_MS, "premise: the refresh point is far past the floor").toBeGreaterThan(30_000);
    // The organiser stops: the third read answers no live, and that answer is delivered one floor later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(3);
    expect(seen.map((v) => v.live !== null), "live, live, then the stop").toEqual([true, true, false]);
    poll.stop();
  });

  it("a token that is about to lapse is re-read at the 30 s floor, never in a tight loop", async () => {
    const r = route(liveFor(2 * MIN));
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await flush();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toHaveLength(2);
    poll.stop();
  });

  it("a replay of embeds alone sets no timer: a day later there is still the one read", async () => {
    const r = route(embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await flush();
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(r.calls).toHaveLength(1);
    expect(vi.getTimerCount(), "no timer left").toBe(0);
    poll.stop();
  });
});

describe("startVideoPoll: a failed read", () => {
  it("keeps the last answer, tries again in 30 s, and a later good answer replaces it", async () => {
    const live = liveFor(60 * MIN);
    const r = route(live, new Error("offline"), liveFor(60 * MIN));
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    expect(seen).toHaveLength(1);
    // The live schedule says 30 s; a failure is the 30 s retry from the read that failed. Fail the SECOND read.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.calls, "the second read happened (and failed)").toHaveLength(2);
    expect(seen, "a failure delivers nothing, so the page keeps what it had").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls, "retried 30 s after the failure").toHaveLength(3);
    expect(seen, "the good answer is delivered").toHaveLength(2);
    poll.stop();
  });

  it("a first read that fails is retried in 30 s and delivers nothing meanwhile", async () => {
    const r = route(new Error("500"), EMPTY);
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.calls).toHaveLength(2);
    expect(seen).toEqual([EMPTY]);
    poll.stop();
  });
});

describe("startVideoPoll: stop", () => {
  it("ends the timer: no further read, and no timer left", async () => {
    const r = route(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await flush();
    expect(vi.getTimerCount(), "premise: a read is scheduled").toBe(1);
    poll.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.calls).toHaveLength(1);
  });

  it("aborts a read in flight, and its late answer is never delivered", async () => {
    let release!: (v: PublicFixtureVideo) => void;
    let signal!: AbortSignal;
    const fetchVideo = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<PublicFixtureVideo>((res) => {
        release = res;
      });
    });
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    expect(signal.aborted, "premise: the read is in flight").toBe(false);
    poll.stop();
    expect(signal.aborted).toBe(true);
    release(liveFor(60 * MIN));
    await flush();
    expect(seen, "an answer that arrives after the stop is dropped").toEqual([]);
    expect(vi.getTimerCount(), "and schedules nothing").toBe(0);
  });
});

describe("startVideoPoll: refreshSoon (a lapsed token, or a viewer's pick of an expired part)", () => {
  it("reads at once when the last read is older than the floor, even with no timer owed", async () => {
    const r = route(embedOnly, embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await flush();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(r.calls, "premise: nothing re-reads on its own").toHaveLength(1);
    poll.refreshSoon();
    await flush();
    expect(r.calls).toHaveLength(2);
    poll.stop();
  });

  it("waits out the floor when the last read was just now (a flood of errors cannot flood the route)", async () => {
    // Embeds alone set no timer of their own, so the only read here is the ask's (a live answer's own 30 s read would hide it).
    const r = route(embedOnly, embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    poll.refreshSoon();
    poll.refreshSoon();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(r.calls, "20 s after the ask is 10 s short of the floor").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls, "one read, at the floor").toHaveLength(2);
    poll.stop();
  });

  it("is ignored while a read is already in flight, and after a stop", async () => {
    let calls = 0;
    const fetchVideo = vi.fn(() => {
      calls++;
      return new Promise<PublicFixtureVideo>(() => {});
    });
    const poll = startVideoPoll({ fetchVideo, onVideo: () => {} });
    await flush();
    await vi.advanceTimersByTimeAsync(31_000);
    poll.refreshSoon();
    await flush();
    expect(calls, "the pending read is not doubled").toBe(1);
    poll.stop();
    poll.refreshSoon();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });
});

// A player that gave up (a fatal error) is rebuilt by the NEXT answer, even when that answer holds the very same address: a token that
// is still good was not what failed (a blip on the manifest request), and a player that is never rebuilt stays on "can't play" until the
// viewer reloads. `onVideo`'s second argument says so; it is the island's one signal to mount a fresh player.
describe("startVideoPoll: rebuild (a player that gave up is rebuilt by the next answer)", () => {
  /** Every answer with the flag it arrived with. */
  const record = () => {
    const seen: { video: PublicFixtureVideo; rebuild: boolean }[] = [];
    return { seen, onVideo: (video: PublicFixtureVideo, o: { rebuild: boolean }) => void seen.push({ video, rebuild: o.rebuild }) };
  };

  it("EMPTY CASE FIRST: with no failure no answer asks for a rebuild, across scheduled reads", async () => {
    const live = liveFor(60 * MIN);
    const r = route(live, live, live);
    const rec = record();
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: rec.onVideo });
    await flush();
    await vi.advanceTimersByTimeAsync(55 * MIN);
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(rec.seen.length, "anti-vacuity: answers were checked").toBeGreaterThanOrEqual(2);
    expect(rec.seen.filter((a) => a.rebuild), "no failure, no rebuild").toEqual([]);
    poll.stop();
  });

  it("after refreshSoon the next answer carries rebuild, and the one after it does not", async () => {
    const live = liveFor(60 * MIN);
    const r = route(live, live, live);
    const rec = record();
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: rec.onVideo });
    await flush();
    // The ask comes 10 s in, before the live answer's own read: the floor is counted from the first read, so the answer to the ask
    // is the read at 30 s.
    await vi.advanceTimersByTimeAsync(10_000);
    poll.refreshSoon();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.calls, "the failed player's ask read the route").toHaveLength(2);
    expect(rec.seen.map((a) => a.rebuild), "first read, then the answer to the ask").toEqual([false, true]);
    // The schedule's own next point (derived from it, not typed): the read after the rebuild answer is an ordinary one.
    const next = nextVideoFetchMs(live, new Date());
    expect(next, "premise: a live answer sets a timer").not.toBeNull();
    await vi.advanceTimersByTimeAsync(next!);
    expect(r.calls).toHaveLength(3);
    expect(rec.seen.map((a) => a.rebuild), "the flag is spent by one answer").toEqual([false, true, false]);
    poll.stop();
  });

  it("an ask that arrives while a read is in flight still marks that read's answer, which then rebuilds", async () => {
    let release!: (v: PublicFixtureVideo) => void;
    const fetchVideo = vi.fn(() => new Promise<PublicFixtureVideo>((res) => (release = res)));
    const rec = record();
    const poll = startVideoPoll({ fetchVideo, onVideo: rec.onVideo });
    await flush();
    poll.refreshSoon();
    release(liveFor(60 * MIN));
    await flush();
    expect(fetchVideo, "the ask did not double the read").toHaveBeenCalledTimes(1);
    expect(rec.seen.map((a) => a.rebuild)).toEqual([true]);
    poll.stop();
  });

  it("a failed read does not spend the flag: the next GOOD answer rebuilds", async () => {
    const live = liveFor(60 * MIN);
    const r = route(live, new Error("offline"), live);
    const rec = record();
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: rec.onVideo });
    await flush();
    await vi.advanceTimersByTimeAsync(31_000);
    poll.refreshSoon();
    await flush();
    expect(rec.seen.map((a) => a.rebuild), "the failed read delivered nothing").toEqual([false]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rec.seen.map((a) => a.rebuild)).toEqual([false, true]);
    poll.stop();
  });

  it("a stop drops the pending ask: nothing is delivered, rebuild or not", async () => {
    const live = liveFor(60 * MIN);
    const r = route(live, live);
    const rec = record();
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: rec.onVideo });
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    poll.refreshSoon();
    poll.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rec.seen).toHaveLength(1);
  });
});
