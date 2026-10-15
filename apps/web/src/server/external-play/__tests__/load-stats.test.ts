// T17B fix 2, D22 — the load test's own arithmetic (e2e/load/load-stats.ts).
//
// The 30-board run reports outside calls per vendor per five minutes, and latency percentiles. Those numbers are the
// finding, so the code that makes them is checked here against hand-counted cases: a window function that counted a
// half-open window as closed, or a percentile that rounded the wrong way, would put a wrong number in a report that
// decides whether the platform's vendor budget holds.
import { describe, expect, it } from "vitest";
import { CLIENT_CAMERA_RETRY, CLIENT_SEAT, LOAD_LIMITS, callsPerWindow, cameraRetryWaitMs, groupCalls, normalisePath, percentile, replayBucket, slidingWindowMax } from "../../../../e2e/load/load-stats";
import { CAMERA_EVIDENCE_MAX_POLLS } from "../../../components/public-site/match-room/room-snapshot";
import { CAMERA_RETRY_BASE_MS, CAMERA_RETRY_MAX_MS, cameraRetryDelayMs } from "../../../components/public-site/match-room/use-room";
import { RTK_BUDGET_BURST, RTK_BUDGET_REFILL_PER_S, RTK_BUDGET_WINDOW_MS, RTK_CALLS_PER_WINDOW, RTK_VENDOR_LIMIT_PER_WINDOW } from "../video/budget";

describe("percentile (nearest-rank)", () => {
  it("is the smallest value with at least p% of the sample at or below it — hand-counted on ten values", () => {
    const xs = [15, 20, 35, 40, 50, 60, 70, 80, 90, 100];
    // ceil(0.5 * 10) = 5th value; ceil(0.95 * 10) = 10th; ceil(0.9 * 10) = 9th; ceil(0.01 * 10) = 1st.
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 90)).toBe(90);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile(xs, 1)).toBe(15);
    expect(percentile(xs, 100)).toBe(100);
  });
  it("does not depend on the order it is given", () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
    expect(percentile([1, 3, 5, 7, 9], 50)).toBe(5);
  });
  it("a one-value sample is that value at every percentile (the differential: p50 and p95 are not the average)", () => {
    for (const p of [1, 50, 95, 100]) expect(percentile([42], p)).toBe(42);
  });
  it("refuses an empty sample — a percentile of nothing is a vacuous report, not 0", () => {
    expect(() => percentile([], 50)).toThrow(/empty/i);
  });
  it("refuses a percentile outside (0, 100]", () => {
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("slidingWindowMax: the most events in ANY closed window of the length", () => {
  it("empty: no events, no window, a max of 0 over 0 windows (the caller must refuse a vacuous report)", () => {
    expect(slidingWindowMax([], 300_000)).toEqual({ max: 0, windows: 0, startAt: null });
  });
  it("counts both ends of a closed window: events exactly one window apart are in the same window", () => {
    // 0 and 300000 are exactly a window apart; a half-open window would split them.
    expect(slidingWindowMax([0, 300_000], 300_000).max).toBe(2);
    expect(slidingWindowMax([0, 300_001], 300_000).max).toBe(1);
  });
  it("finds the busiest stretch wherever it is, and says where it starts", () => {
    // Window 10: [0,1,2] is 3; [20,21,22,23,24] is 5 (24 - 20 <= 10).
    const events = [0, 1, 2, 20, 21, 22, 23, 24, 100];
    expect(slidingWindowMax(events, 10)).toEqual({ max: 5, windows: 9, startAt: 20 });
  });
  it("is order-independent and counts repeated stamps (many calls in one millisecond)", () => {
    expect(slidingWindowMax([5, 5, 5, 1, 90], 10)).toEqual({ max: 4, windows: 5, startAt: 1 });
  });
});

describe("callsPerWindow: consecutive fixed windows from an origin", () => {
  it("buckets by floor((t - origin) / window), keeps the empty windows between, and counts what it was given", () => {
    const origin = 1_000;
    const counts = callsPerWindow([1_000, 1_005, 1_099, 1_100, 1_450], origin, 100);
    // windows: [1000,1100) = 3, [1100,1200) = 1, [1200,1300) = 0, [1300,1400) = 0, [1400,1500) = 1
    expect(counts).toEqual([3, 1, 0, 0, 1]);
    expect(counts.reduce((a, b) => a + b, 0), "every event is in exactly one window").toBe(5);
  });
  it("an event before the origin is a caller bug, not a negative window", () => {
    expect(() => callsPerWindow([999], 1_000, 100)).toThrow(RangeError);
  });
  it("no events: no windows", () => {
    expect(callsPerWindow([], 0, 100)).toEqual([]);
  });
});

describe("normalisePath / groupCalls: the vendor's endpoints, not one row per game id", () => {
  it("replaces ids in a Lichess path and keeps the verb's shape", () => {
    expect(normalisePath("/api/board/game/stream/abc12345")).toBe("/api/board/game/stream/:id");
    expect(normalisePath("/api/board/game/abc12345/move/e2e4")).toBe("/api/board/game/:id/move/:uci");
    expect(normalisePath("/api/challenge/e2e-rnd-0a1b2c3d4e")).toBe("/api/challenge/:id");
  });
  it("replaces ids in a RealtimeKit path", () => {
    expect(
      normalisePath("/accounts/acct/realtime/kit/app/meetings/5f0b9e1a-1111-4222-8333-444455556666/participants/6a0b9e1a-1111-4222-8333-444455556666/token"),
    ).toBe("/accounts/:acct/realtime/kit/:app/meetings/:id/participants/:id/token");
  });
  it("replaces the RealtimeKit FIXTURE's ids (mtg-/prt-/ses-) the same way, so a run against the fixture groups by endpoint", () => {
    expect(normalisePath("/meetings/mtg-0001-mv94buwd/participants/prt-0002-mv94buxr/token")).toBe("/meetings/:id/participants/:id/token");
    expect(normalisePath("/sessions/ses-000d-mv94bxvr/participants")).toBe("/sessions/:id/participants");
    // The counter is base 36: the 4-character part holds letters (`000q`), which a hex pattern would leave per-id.
    expect(normalisePath("/meetings/mtg-000q-mv94ezza/participants/prt-000r-mv94ezzd/token")).toBe("/meetings/:id/participants/:id/token");
    expect(normalisePath("/sessions/peer-report/peer-0003-abc")).toBe("/sessions/peer-report/:id");
    expect(normalisePath("/meetings/mtg-0001-mv94buwd/active-session/kick-all")).toBe("/meetings/:id/active-session/kick-all");
  });
  it("groups by method and normalised path, counts each, and the counts sum to the calls", () => {
    const calls = [
      { method: "POST", path: "/api/board/game/aaaaaaaa/move/e2e4" },
      { method: "POST", path: "/api/board/game/bbbbbbbb/move/d2d4" },
      { method: "GET", path: "/api/board/game/stream/aaaaaaaa" },
    ];
    const g = groupCalls(calls);
    expect(g).toEqual({ "POST /api/board/game/:id/move/:uci": 2, "GET /api/board/game/stream/:id": 1 });
    expect(Object.values(g).reduce((a, b) => a + b, 0)).toBe(calls.length);
  });
});

describe("LOAD_LIMITS: the run is judged against the budget the platform actually enforces", () => {
  it("the RealtimeKit limits are video/budget.ts's own (a runner cannot import it, so the copy is pinned here)", () => {
    expect(LOAD_LIMITS.rtkVendor).toBe(RTK_VENDOR_LIMIT_PER_WINDOW);
    expect(LOAD_LIMITS.rtkCeiling).toBe(RTK_CALLS_PER_WINDOW);
    expect(LOAD_LIMITS.windowMs).toBe(RTK_BUDGET_WINDOW_MS);
    expect(LOAD_LIMITS.rtkBurst).toBe(RTK_BUDGET_BURST);
    expect(LOAD_LIMITS.rtkRefillPerS).toBe(RTK_BUDGET_REFILL_PER_S);
  });
  it("the ceiling is under the vendor's limit, and the Lichess window is longer than the RealtimeKit one", () => {
    expect(LOAD_LIMITS.rtkCeiling).toBeLessThan(LOAD_LIMITS.rtkVendor);
    expect(LOAD_LIMITS.lichessCreateWindowMs).toBeGreaterThan(LOAD_LIMITS.windowMs);
  });
});

// The bucket replay answers one question about a recorded run: how many of its calls would the platform's call budget
// have refused. Hand-counted below on a bucket of 3 refilling at 1 per second (the shape of video/budget.ts's, smaller).
describe("replayBucket: which recorded calls a token bucket would have refused", () => {
  const T0 = 1_000_000;
  const bucket = { burst: 3, refillPerS: 1 };
  it("a burst up to the capacity passes, the next call in the same instant is refused, a second later one token is back", () => {
    const got = replayBucket([T0, T0, T0, T0, T0 + 1_000, T0 + 1_000], bucket);
    // 3 spend the burst, the 4th is refused; at +1 s one token refilled: the 5th passes, the 6th is refused.
    expect([got.granted, got.refused, got.refusedAt.length]).toEqual([4, 2, 2]);
    expect(got.refusedAt).toEqual([T0, T0 + 1_000]);
  });
  it("the bucket starts FULL and never holds more than its capacity: a long quiet spell is not a bigger burst", () => {
    const got = replayBucket([T0, T0 + 3_600_000, T0 + 3_600_000, T0 + 3_600_000, T0 + 3_600_000], bucket);
    // after the hour it is full (3), not 3603: three pass, the fourth is refused.
    expect([got.granted, got.refused]).toEqual([4, 1]);
  });
  it("a refused call spends nothing and the refill clock keeps running: 4 s of steady demand at 2/s against 1/s", () => {
    const calls = Array.from({ length: 9 }, (_, i) => T0 + i * 500); // 9 calls over 4 s
    const got = replayBucket(calls, bucket);
    // burst 3 + refill: t=0 s: 3->2; 0.5: 2.5->1.5; 1.0: 2.0->1.0 (0.5 refilled); 1.5: 1.5->0.5; 2.0: 1.0->0.0;
    // 2.5: 0.5 refused; 3.0: 1.0->0.0; 3.5: 0.5 refused; 4.0: 1.0->0.0. Granted 7, refused 2.
    expect([got.granted, got.refused]).toEqual([7, 2]);
  });
  it("is order-independent and counts every call it was given (granted + refused = calls)", () => {
    const calls = [T0 + 700, T0, T0 + 300, T0, T0 + 4_000, T0 + 100];
    const forward = replayBucket(calls, bucket);
    const sorted = replayBucket([...calls].sort((a, b) => a - b), bucket);
    expect(forward).toEqual(sorted);
    expect(forward.granted + forward.refused).toBe(calls.length);
  });
  it("no calls: nothing granted, nothing refused (the caller must refuse a vacuous report)", () => {
    expect(replayBucket([], bucket)).toEqual({ granted: 0, refused: 0, refusedAt: [] });
  });
  it("refuses a bucket that cannot hold a token or refills backwards", () => {
    expect(() => replayBucket([T0], { burst: 0, refillPerS: 1 })).toThrow(RangeError);
    expect(() => replayBucket([T0], { burst: 3, refillPerS: -1 })).toThrow(RangeError);
  });
});

describe("CLIENT_SEAT: the player the load test models stops polling where the real check-in screen does", () => {
  it("the poll bound is the room's own CAMERA_EVIDENCE_MAX_POLLS (a runner cannot import it into a Playwright file, so the copy is pinned here)", () => {
    expect(CLIENT_SEAT.maxPolls).toBe(CAMERA_EVIDENCE_MAX_POLLS);
    expect(CLIENT_SEAT.maxPolls, "anti-vacuity: a real bound").toBeGreaterThan(0);
  });
});

describe("CLIENT_CAMERA_RETRY: the load test's optional-camera player asks for its token on the room's own schedule (D21-fix-3)", () => {
  it("the base and the cap are the room's (copied because a Playwright file cannot import a client hook), and every attempt waits the same", () => {
    expect(CLIENT_CAMERA_RETRY).toEqual({ baseMs: CAMERA_RETRY_BASE_MS, maxMs: CAMERA_RETRY_MAX_MS });
    let checked = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(cameraRetryWaitMs(attempt), `attempt ${attempt}`).toBe(cameraRetryDelayMs(attempt));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(12);
    expect([0, 1, 2, 3, 4].map(cameraRetryWaitMs), "the ruling's 2/4/8/16 s then the ~30 s cap").toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
  });
});
