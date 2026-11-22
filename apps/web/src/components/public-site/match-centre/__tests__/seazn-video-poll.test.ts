// Seazn-hosted video, Phase 1 Task 15: the island's read loop (`startVideoPoll`), the part `apps/web`'s node-only vitest cannot see
// through a component (no DOM, so an effect never runs): the island's timer, driven here through its REAL schedule
// (`nextVideoFetchMs`) with vitest's fake timers and fake clock, no network. What must hold:
//   - it reads at once, then at the schedule's delay (30 s with nothing to show, and 30 s while live too: Task 19, so a Stop reaches
//     an open page within one poll; and 30 s while the interim replay plays: Task 19 fix round 1, I1, so a second Go live reaches
//     it too), and a new answer moves the next read with it;
//   - a replay of embeds alone (Task 25, carry 4) reads at the floor until it is FINAL (the fixture settled, nothing hot), then sets NO
//     timer; a read the island asks for still happens: `refreshSoon` (a player gave up: the next answer rebuilds it) and `readSoon`
//     (the replay host's frame holds an address whose token has passed: a fresh read, never a rebuild, so the frame is not remounted);
//   - a failed read keeps the last answer on screen and tries again in 30 s, and a later good answer replaces it;
//   - a stop ends everything: no timer, the read in flight is aborted, and its late answer is never delivered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { type PageVisibility, SEAZN_VIDEO_FETCH_TIMEOUT_MS, startVideoPoll } from "../seazn-video-poll";
import { SEAZN_VIDEO_POLL_FLOOR_MS, nextVideoFetchMs } from "../seazn-video-schedule";

const T0 = new Date("2026-11-21T12:00:00.000Z");
const MIN = 60_000;
const REFRESH_MS = SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
const EMPTY: PublicFixtureVideo = { live: null, replay: [] };
const liveFor = (ms: number): PublicFixtureVideo => ({
  live: { src: "https://host.invalid/t/manifest/video.m3u8", expiresAt: new Date(Date.now() + ms).toISOString() },
  replay: [],
});
/** The interim Cloudflare recording, signed for an hour from when it is read (as the route signs it). */
const replayFor = (ms: number): PublicFixtureVideo => ({
  live: null,
  replay: [{ partNo: 1, player: "hls", src: "https://host.invalid/p1/manifest/video.m3u8", expiresAt: new Date(Date.now() + ms).toISOString() }],
});
/** A fixture settled a minute before T0: an answer of embeds alone is final there (carry 4). */
const SETTLED = T0.getTime() - MIN;
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

  it("the interim replay: the next read is the 30 s floor, not the recording token's refresh point, so a second Go live reaches an open page within one poll", async () => {
    // I1 (Task 19 review): the organiser stops at half-time, the tick signs part 1 and the page plays it; then the second half goes
    // live. Each answer is built when it is read, so the recording's token is always an hour long: its refresh point never waits.
    const answers = [replayFor(60 * MIN), replayFor(60 * MIN), liveFor(60 * MIN)];
    let reads = 0;
    const seen: PublicFixtureVideo[] = [];
    const fetchVideo = vi.fn(async () => answers[Math.min(reads++, answers.length - 1)]!);
    const poll = startVideoPoll({ fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reads, "one tick before the floor").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads, "at the floor, 55 min before the recording token's refresh point").toBe(2);
    expect(60 * MIN - REFRESH_MS, "premise: the refresh point is far past the floor").toBeGreaterThan(30_000);
    // The second Go live: the third read answers live, delivered one floor later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(3);
    expect(seen.map((v) => (v.live !== null ? "live" : v.replay.length > 0 ? "replay" : "none")), "replay, replay, then live").toEqual(["replay", "replay", "live"]);
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

  it("carry 4: a replay of embeds alone on a SETTLED fixture is final — no timer: a day later there is still the one read", async () => {
    const r = route(embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: T0.getTime() - MIN });
    await flush();
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(r.calls).toHaveLength(1);
    expect(vi.getTimerCount(), "no timer left").toBe(0);
    poll.stop();
  });

  it("carry 4: embeds alone on a fixture NOT settled are re-read at the floor, so a new Go live is seen within one read; the live answer then stays on the floor (a Stop is seen within one read)", async () => {
    const live = liveFor(60 * MIN);
    const r = route(embedOnly, embedOnly, live, live);
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS - 1);
    expect(r.calls, "not before the floor").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(seen.at(-1)?.live, "the Go live, one floor later").not.toBeNull();
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(r.calls).toHaveLength(4);
    poll.stop();
  });

  it("carry 4: embeds alone, settled but HOT (a session active as the page was drawn): still the floor", async () => {
    const r = route(embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: T0.getTime() - MIN, activeUntilMs: T0.getTime() + 10 * MIN });
    await flush();
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(r.calls).toHaveLength(2);
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

// Task 25 (coordinator's addition): each failed read's error reaches the island (which reports it, seazn-video-report.ts) — a failed
// first read, a failure after an answer, the give-up timer's abort — and the abort `stop` makes never does.
describe("startVideoPoll: onReadFailed", () => {
  it("EMPTY CASE FIRST: reads that answer report nothing", async () => {
    const failed: unknown[] = [];
    const poll = startVideoPoll({ fetchVideo: route(EMPTY).fetchVideo, onVideo: () => {}, onReadFailed: (e) => void failed.push(e) });
    await flush();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(failed).toEqual([]);
    poll.stop();
  });

  it("every failed read hands its own error over, in order, and a good answer between them is not one", async () => {
    const first = new Error("offline");
    const second = new Error("503");
    const r = route(first, EMPTY, second, EMPTY);
    const failed: unknown[] = [];
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, onReadFailed: (e) => void failed.push(e) });
    /** Runs the clock a second at a time until the route has been read `n` times. */
    const untilRead = async (n: number) => {
      for (let i = 0; i < 10 * 60 && r.calls.length < n; i++) await vi.advanceTimersByTimeAsync(1_000);
      expect(r.calls, `premise: read ${n} happened`).toHaveLength(n);
    };
    await flush();
    expect(failed).toEqual([first]);
    await untilRead(2);
    expect(failed, "the answer is not a failure").toEqual([first]);
    await untilRead(3);
    expect(failed).toEqual([first, second]);
    await untilRead(4);
    expect(failed, "nor is the one after").toEqual([first, second]);
    poll.stop();
  });

  it("the give-up timer's abort is a failed read (an AbortError handed over); the abort stop() makes is not", async () => {
    const failed: unknown[] = [];
    const fetchVideo = vi.fn((signal: AbortSignal) => new Promise<PublicFixtureVideo>((_res, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const poll = startVideoPoll({ fetchVideo, onVideo: () => {}, onReadFailed: (e) => void failed.push(e) });
    await flush();
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_FETCH_TIMEOUT_MS);
    expect(failed.map((e) => (e as DOMException).name)).toEqual(["AbortError"]);
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(fetchVideo, "premise: the retry is in flight").toHaveBeenCalledTimes(2);
    poll.stop();
    await flush();
    expect(failed, "stop's abort is not reported").toHaveLength(1);
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

// Phase 1 review m8: one read at a time, so a request that never answers used to freeze the island (no Stop, no live) until the
// browser gave up. It is given up at 15 s (the review's figure) and treated as a failed read.
describe("review m8: a read that hangs", () => {
  it("is given up at the fetch timeout and tried again a floor later; a read that answers inside the timeout is never cut off", async () => {
    expect(SEAZN_VIDEO_FETCH_TIMEOUT_MS, "the review's 15 s").toBe(15_000);
    const signals: AbortSignal[] = [];
    const fetchVideo = vi.fn((signal: AbortSignal) => new Promise<PublicFixtureVideo>((resolve, reject) => {
      signals.push(signal);
      // The first read never answers (it rejects only when aborted, as fetch does); the second answers after 14 s.
      if (signals.length === 1) signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      else setTimeout(() => resolve(EMPTY), SEAZN_VIDEO_FETCH_TIMEOUT_MS - 1_000);
    }));
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo, onVideo: (v) => seen.push(v) });
    await flush();
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_FETCH_TIMEOUT_MS - 1);
    expect(signals[0]!.aborted, "not before the timeout").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted, "given up at the timeout").toBe(true);
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS - 1);
    expect(fetchVideo, "the retry waits the floor").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchVideo, "and then reads again").toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_FETCH_TIMEOUT_MS - 1_000);
    expect(signals[1]!.aborted, "a slow answer inside the timeout is kept").toBe(false);
    expect(seen).toEqual([EMPTY]);
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_FETCH_TIMEOUT_MS);
    expect(signals[1]!.aborted, "and its give-up timer was cleared").toBe(false);
    poll.stop();
  });
});

describe("startVideoPoll: refreshSoon (a lapsed token, or a viewer's pick of an expired part)", () => {
  it("reads at once when the last read is older than the floor, even with no timer owed", async () => {
    const r = route(embedOnly, embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: SETTLED });
    await flush();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(r.calls, "premise: nothing re-reads on its own").toHaveLength(1);
    poll.refreshSoon();
    await flush();
    expect(r.calls).toHaveLength(2);
    poll.stop();
  });

  it("waits out the floor when the last read was just now (a flood of errors cannot flood the route)", async () => {
    // Embeds alone on a settled fixture set no timer of their own, so the only read here is the ask's (a live answer's own 30 s read
    // would hide it).
    const r = route(embedOnly, embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: SETTLED });
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

// Task 25 (carry 3): the replay host's frame holds an address whose token has passed (a part picked, or the first part, from an answer
// read long ago on a final replay that sets no timer). It asks for a fresh read — NOT a rebuild: the frame is waiting, not dead, and
// a rebuild would remount it (a fresh frame that asks again, for ever, on a viewer's wrong clock).
describe("startVideoPoll: readSoon (a frame holding a lapsed address)", () => {
  const record = () => {
    const seen: { video: PublicFixtureVideo; rebuild: boolean }[] = [];
    return { seen, onVideo: (video: PublicFixtureVideo, o: { rebuild: boolean }) => void seen.push({ video, rebuild: o.rebuild }) };
  };

  it("EMPTY CASE FIRST: never asked, a final replay reads once and never again", async () => {
    const r = route(embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: SETTLED });
    await flush();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.calls).toHaveLength(1);
    poll.stop();
  });

  it("reads at once when the last read is older than the floor, and the answer is delivered WITHOUT rebuild", async () => {
    const r = route(embedOnly, embedOnly);
    const rec = record();
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: rec.onVideo, settledAtMs: SETTLED });
    await flush();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    poll.readSoon();
    await flush();
    expect(r.calls).toHaveLength(2);
    expect(rec.seen.map((x) => x.rebuild)).toEqual([false, false]);
    poll.stop();
  });

  it("waits out the floor after the last read, and a burst of asks is ONE read", async () => {
    const r = route(embedOnly, embedOnly, embedOnly);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: SETTLED });
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    poll.readSoon();
    poll.readSoon();
    poll.readSoon();
    await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS - 10_000 - 1);
    expect(r.calls, "a ms short of the floor").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.calls, "one read for the burst").toHaveLength(2);
    poll.stop();
  });

  it("leaves a rebuild a player asked for in place: the next answer still rebuilds", async () => {
    const r = route(embedOnly, embedOnly);
    const rec = record();
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: rec.onVideo, settledAtMs: SETTLED });
    await flush();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    poll.refreshSoon();
    poll.readSoon();
    await flush();
    expect(rec.seen.map((x) => x.rebuild)).toEqual([false, true]);
    poll.stop();
  });

  it("is ignored while a read is in flight (that answer serves) and after a stop; a hidden page owes it until shown", async () => {
    let calls = 0;
    const fetchVideo = vi.fn(() => {
      calls++;
      return new Promise<PublicFixtureVideo>(() => {});
    });
    const poll = startVideoPoll({ fetchVideo, onVideo: () => {} });
    await flush();
    poll.readSoon();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(calls, "the pending read is not doubled").toBe(1);
    poll.stop();
    poll.readSoon();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(calls).toBe(1);

    const page = fakePage();
    const r = timed(embedOnly, embedOnly);
    const hidden = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, visibility: page.visibility, settledAtMs: SETTLED });
    await flush();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    page.hide();
    hidden.readSoon();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(r.at, "hidden: no read").toHaveLength(1);
    page.show();
    await flush();
    expect(r.at, "shown: the owed read, at once (the last read is past the floor)").toHaveLength(2);
    hidden.stop();
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
    const next = nextVideoFetchMs(live, { nowMs: Date.now(), settledAtMs: null, emptyStreak: 0 });
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Phase 1 review I2: the loop polled every 30 s forever, hidden tab or not. The delays below are the fix brief's (30 s -> 60 s ->
// 120 s, capped at 5 min; stop once settled; a hidden page reads nothing and reads once when it is looked at again), typed here.
// ---------------------------------------------------------------------------------------------------------------------------------
/** A scripted route that also records the clock offset (ms from T0) of every read. */
function timed(...steps: (PublicFixtureVideo | Error)[]) {
  const r = route(...steps);
  const at: number[] = [];
  const fetchVideo = vi.fn(async (signal: AbortSignal) => {
    at.push(Date.now() - T0.getTime());
    return r.fetchVideo(signal);
  });
  return { fetchVideo, at };
}
/** A page whose visibility the test sets, as `document` would report it. */
function fakePage(hidden = false) {
  const state = { hidden };
  const listeners = new Set<() => void>();
  const visibility: PageVisibility = {
    hidden: () => state.hidden,
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const set = (h: boolean) => {
    state.hidden = h;
    for (const l of [...listeners]) l();
  };
  return { visibility, listeners, hide: () => set(true), show: () => set(false) };
}

// The fix-wave re-review's N1 (2026-11-22): the ladder is 30 s then 60 s (no 5 min: a viewer watching saw Go live that late), and a
// HOT page (an hour either side of kick-off, or active when drawn) holds the floor. N6: a failed read climbs the same ladder.
describe("review I2 + N1: an empty answer backs off to 60 s; anything shown resets it", () => {
  it("EMPTY CASE FIRST: empty answers in a row are read at 30 s, then every 60 s", async () => {
    const r = timed(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await vi.advanceTimersByTimeAsync(30_000 + 4 * 60_000);
    expect(r.at).toEqual([0, 30_000, 90_000, 150_000, 210_000, 270_000]);
    poll.stop();
  });

  it("a live after the empties puts the page back on the floor, and the empty answer after it (the Stop) starts the backoff again at 30 s", async () => {
    const r = timed(EMPTY, EMPTY, EMPTY, liveFor(60 * MIN), EMPTY, EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await vi.advanceTimersByTimeAsync(150_000 + 30_000 + 30_000 + 60_000);
    // 0, 30, 90 empty (next 60); 150 live (next 30); 180 empty again, the first in a row (next 30); 210 the second (next 60): 270.
    expect(r.at).toEqual([0, 30_000, 90_000, 150_000, 180_000, 210_000, 270_000]);
    poll.stop();
  });

  it("a failed read neither counts as empty nor resets the run: it retries on its own ladder and the empty backoff goes on where it was", async () => {
    const r = timed(EMPTY, EMPTY, new Error("offline"), EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await vi.advanceTimersByTimeAsync(90_000 + 30_000 + 60_000);
    // 0 and 30 empty (next 60); 90 fails, the first failure (retry 30); 120 empty, the third in a row (next 60): 180.
    expect(r.at).toEqual([0, 30_000, 90_000, 120_000, 180_000]);
    poll.stop();
  });
});

describe("review N6: failed reads back off on the same ladder, capped at 60 s", () => {
  it("EMPTY CASE FIRST: failures in a row retry at 30 s, then every 60 s; a good answer resets the run, so the next failure is 30 s again", async () => {
    const boom = new Error("429");
    const r = timed(boom, boom, boom, boom, liveFor(60 * MIN), boom, boom);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 60_000 + 60_000 + 30_000 + 30_000);
    // 0, 30, 90, 150 fail (next 30, 60, 60, 60); 210 live (next 30); 240 fails, the first since (next 30); 270 the second (next 60).
    expect(r.at).toEqual([0, 30_000, 90_000, 150_000, 210_000, 240_000, 270_000]);
    poll.stop();
  });

  it("a hot page's failures back off too (an outage is not news): the hints never hold a failure at the floor", async () => {
    const boom = new Error("500");
    const r = timed(boom);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, kickoffAtMs: T0.getTime(), activeUntilMs: T0.getTime() + 60 * MIN });
    await vi.advanceTimersByTimeAsync(30_000 + 2 * 60_000);
    expect(r.at).toEqual([0, 30_000, 90_000, 150_000]);
    poll.stop();
  });
});

describe("review N1: a hot page holds the floor through empty answers", () => {
  it("EMPTY CASE FIRST: kick-off 10 min away — every empty answer is read again at 30 s, deep into the streak", async () => {
    const r = timed(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, kickoffAtMs: T0.getTime() + 10 * MIN });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(r.at).toEqual(Array.from({ length: 11 }, (_, i) => i * 30_000));
    poll.stop();
  });

  it("the hour after kick-off ends: the read at its last instant is still hot (30 s), the next is cold and backs off (60 s)", async () => {
    const r = timed(EMPTY);
    // Kick-off 58 min ago: the window ends at T0 + 120 s.
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, kickoffAtMs: T0.getTime() - 58 * MIN });
    await vi.advanceTimersByTimeAsync(210_000);
    expect(r.at).toEqual([0, 30_000, 60_000, 90_000, 120_000, 150_000, 210_000]);
    poll.stop();
  });

  it("active until 90 s from now: the floor until then, the backoff from that instant", async () => {
    const r = timed(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, activeUntilMs: T0.getTime() + 90_000 });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(r.at).toEqual([0, 30_000, 60_000, 90_000, 150_000]);
    poll.stop();
  });
});

describe("review I2: a settled fixture", () => {
  it("EMPTY CASE FIRST: an empty answer once settled stops the loop; before the settle instant it is the backoff", async () => {
    const r = timed(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: T0.getTime() + 60_000 });
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    // 0 (not settled: 30 s), 30 (not settled: 60 s), 90 settled: no timer.
    expect(r.at).toEqual([0, 30_000, 90_000]);
    expect(vi.getTimerCount(), "no timer left").toBe(0);
    poll.stop();
  });

  it("an hls replay once settled is re-read at its token's refresh point, and that read is the replay's token refresh", async () => {
    const r = timed(replayFor(60 * MIN), replayFor(60 * MIN));
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: (v) => seen.push(v), settledAtMs: T0.getTime() - MIN });
    await vi.advanceTimersByTimeAsync(55 * MIN + 1);
    expect(r.at).toEqual([0, 60 * MIN - REFRESH_MS]);
    expect(seen).toHaveLength(2);
    poll.stop();
  });

  it("no settle time (not decided, or the page could not say): the backoff never stops, it caps", async () => {
    const r = timed(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, settledAtMs: null });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(r.at.length, "at 0 and 30 s, then every 60 s for the rest of the hour").toBe(2 + Math.floor((60 * MIN - 30_000) / 60_000));
    expect(vi.getTimerCount()).toBe(1);
    poll.stop();
  });
});

describe("review I2: a hidden page reads nothing", () => {
  it("EMPTY CASE FIRST: a page opened hidden (a background tab) does not read until it is shown, then reads at once", async () => {
    const page = fakePage(true);
    const r = timed(liveFor(60 * MIN));
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, visibility: page.visibility });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.at, "hidden: no read").toEqual([]);
    expect(vi.getTimerCount(), "and no timer").toBe(0);
    page.show();
    await flush();
    expect(r.at, "shown: read at once").toEqual([10 * MIN]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.at, "then the live floor").toEqual([10 * MIN, 10 * MIN + 30_000]);
    poll.stop();
  });

  it("hiding a live page stops its timer; shown again after a while it reads at once, then keeps the floor", async () => {
    const page = fakePage();
    const r = timed(liveFor(60 * MIN));
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, visibility: page.visibility });
    await vi.advanceTimersByTimeAsync(10_000);
    page.hide();
    expect(vi.getTimerCount(), "the hidden page's timer is gone").toBe(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.at, "nothing read while hidden").toEqual([0]);
    page.show();
    await flush();
    expect(r.at, "read at once on return").toEqual([0, 10 * MIN + 10_000]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.at).toEqual([0, 10 * MIN + 10_000, 10 * MIN + 40_000]);
    poll.stop();
  });

  it("a page looked at again reads within ONE floor whatever the backoff had reached — at once after a long look away, at the floor after a blink", async () => {
    const page = fakePage();
    const r = timed(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, visibility: page.visibility });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(r.at, "premise: the third empty answer, whose backoff is 60 s").toEqual([0, 30_000, 90_000]);
    // A blink 5 s after that read: the next read is the floor from it (120 s), not the backoff's 150 s, and not at once.
    await vi.advanceTimersByTimeAsync(5_000);
    page.hide();
    page.show();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(r.at, "not before the floor").toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.at, "at the floor from the last read").toEqual([0, 30_000, 90_000, 120_000]);
    // Now away for a minute: on return, at once.
    await vi.advanceTimersByTimeAsync(10_000);
    page.hide();
    await vi.advanceTimersByTimeAsync(MIN);
    page.show();
    await flush();
    expect(r.at.at(-1), "at once on return").toBe(130_000 + MIN);
    poll.stop();
  });

  it("a read in flight when the page hides delivers its answer and schedules nothing; shown, the page reads within the floor of that read", async () => {
    const page = fakePage();
    let release!: (v: PublicFixtureVideo) => void;
    const at: number[] = [];
    const fetchVideo = vi.fn(() => {
      at.push(Date.now() - T0.getTime());
      return new Promise<PublicFixtureVideo>((res) => {
        release = res;
      });
    });
    const seen: PublicFixtureVideo[] = [];
    const poll = startVideoPoll({ fetchVideo, onVideo: (v) => seen.push(v), visibility: page.visibility });
    await flush();
    page.hide();
    release(liveFor(60 * MIN));
    await flush();
    expect(seen, "the answer is still delivered").toHaveLength(1);
    expect(vi.getTimerCount(), "but nothing is scheduled while hidden").toBe(0);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    page.show();
    await flush();
    expect(at, "shown: read at once").toEqual([0, 5 * MIN]);
    poll.stop();
  });

  it("hidden and shown again while a read is in flight: its answer's next read is the floor, not its backoff", async () => {
    const page = fakePage();
    const steps = [EMPTY, EMPTY, EMPTY, EMPTY];
    let release: ((v: PublicFixtureVideo) => void) | null = null;
    const at: number[] = [];
    const fetchVideo = vi.fn(() => {
      at.push(Date.now() - T0.getTime());
      if (at.length < 4) return Promise.resolve(steps[at.length - 1]!);
      return new Promise<PublicFixtureVideo>((res) => {
        release = res;
      });
    });
    const poll = startVideoPoll({ fetchVideo, onVideo: () => {}, visibility: page.visibility });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(at, "premise: the fourth read is in flight").toEqual([0, 30_000, 90_000, 150_000]);
    page.hide();
    page.show();
    release!(EMPTY);
    await flush();
    // The fourth empty answer's backoff is 60 s; the page was looked at again during the read, so the next one is a floor after it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(at).toEqual([0, 30_000, 90_000, 150_000, 180_000]);
    poll.stop();
  });

  it("a loop the schedule stopped stays stopped when the page is shown (a settled empty fixture, and embeds alone)", async () => {
    for (const [what, answer, settledAtMs] of [["settled, empty", EMPTY, T0.getTime() - MIN], ["settled, embeds alone", embedOnly, T0.getTime() - MIN]] as const) {
      const page = fakePage();
      const r = timed(answer);
      const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, visibility: page.visibility, settledAtMs });
      await flush();
      page.hide();
      await vi.advanceTimersByTimeAsync(MIN);
      page.show();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(r.at, `${what}: the one read`).toHaveLength(1);
      poll.stop();
    }
  });

  it("stop lets go of the page: its listener is removed, and a show after it reads nothing", async () => {
    const page = fakePage();
    const r = timed(EMPTY);
    const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {}, visibility: page.visibility });
    await flush();
    expect(page.listeners.size, "premise: the loop listens").toBe(1);
    page.hide();
    poll.stop();
    expect(page.listeners.size).toBe(0);
    page.show();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(r.at).toEqual([0]);
  });

  it("with no visibility given, the loop reads the DOCUMENT's (the island passes none): hidden pauses it, visibilitychange resumes it", async () => {
    const doc = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", doc);
    try {
      const r = timed(liveFor(60 * MIN));
      const poll = startVideoPoll({ fetchVideo: r.fetchVideo, onVideo: () => {} });
      await vi.advanceTimersByTimeAsync(10_000);
      doc.hidden = true;
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(r.at, "hidden: the live floor's read did not happen").toEqual([0]);
      doc.hidden = false;
      doc.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(r.at, "visible: at once").toEqual([0, 5 * MIN + 10_000]);
      poll.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
