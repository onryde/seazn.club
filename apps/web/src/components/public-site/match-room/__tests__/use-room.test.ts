// T14 — the transport's two pure decisions: how often the room polls, and
// when a clock that reached zero is reported. The hook's wiring (the poll
// effect, the realtime channel, the calls) is the room e2e's.
import { describe, expect, it } from "vitest";
import { CLOCK_ZERO_MAX_SPACING_MS, CLOCK_ZERO_SPACING_MS, IDLE_POLL_MS, LIVE_POLL_MS, SETTLED_POLL_MS, nextClockZeroReport, pollIntervalMs, reReadDelayMs } from "../use-room";

describe("pollIntervalMs", () => {
  it("a live game with no realtime channel polls fast; everything else slow", () => {
    expect(pollIntervalMs({ gameLive: true, subscribed: false })).toBe(LIVE_POLL_MS);
    expect(pollIntervalMs({ gameLive: true, subscribed: true })).toBe(IDLE_POLL_MS);
    expect(pollIntervalMs({ gameLive: false, subscribed: false })).toBe(IDLE_POLL_MS);
    expect(pollIntervalMs({ gameLive: false, subscribed: true })).toBe(IDLE_POLL_MS);
    // Our own numbers (the brief sets none): the live cadence must be the faster one.
    expect(LIVE_POLL_MS).toBeLessThan(IDLE_POLL_MS);
  });

  it("D10b: a settled room still reads, slowest of all — whatever else holds (counted)", () => {
    let checked = 0;
    for (const gameLive of [true, false]) {
      for (const subscribed of [true, false]) {
        expect(pollIntervalMs({ gameLive, subscribed, settled: true }), `${gameLive} ${subscribed}`).toBe(SETTLED_POLL_MS);
        expect(pollIntervalMs({ gameLive, subscribed, settled: false })).toBeLessThan(SETTLED_POLL_MS);
        checked++;
      }
    }
    expect(checked).toBe(4);
    expect(SETTLED_POLL_MS).toBeGreaterThan(IDLE_POLL_MS);
  });
});

describe("nextClockZeroReport", () => {
  const K = "g1:12";
  it("the empty case: the first report for a ply goes at once", () => {
    expect(nextClockZeroReport(null, K, 1000)).toEqual({ key: K, attempts: 1, at: 1000 });
  });

  it("a second report for the same ply waits out the spacing (a tick at zero is not a report)", () => {
    const first = nextClockZeroReport(null, K, 1000)!;
    expect(nextClockZeroReport(first, K, 1000 + CLOCK_ZERO_SPACING_MS - 1)).toBeNull();
    expect(nextClockZeroReport(first, K, 1000 + CLOCK_ZERO_SPACING_MS)).toEqual({ key: K, attempts: 2, at: 1000 + CLOCK_ZERO_SPACING_MS });
  });

  // T17B fix 2, D11 (controller ruling): x0JKlePc sat at zero for 7 minutes past a 5-report cap — the room said
  // nothing more and nobody asked again. No cap now: 3 s, then doubling, never more than 30 s apart.
  it("D11: no cap — the gaps double from 3 s and hold at 30 s, for as long as the clock sits at zero (10 minutes, counted)", () => {
    const sentAt: number[] = [0];
    let r = nextClockZeroReport(null, K, 0)!;
    for (let now = 100; now <= 600_000; now += 100) {
      const n = nextClockZeroReport(r, K, now);
      if (n) {
        r = n;
        sentAt.push(now);
      }
    }
    const gaps = sentAt.slice(1).map((at, i) => at - sentAt[i]!);
    // Typed from the ruling, never from the constants: 3, 6, 12, 24, then 30 s apart.
    expect(gaps.slice(0, 6)).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
    expect(new Set(gaps.slice(4)), "every later gap is the 30 s ceiling").toEqual(new Set([30_000]));
    // 0, 3, 9, 21, 45 s, then every 30 s to 585 s: 5 + 18 reports in 10 minutes.
    expect(sentAt.length, "anti-vacuity: reports in 10 minutes").toBe(23);
    expect(r.attempts).toBe(23);
    expect([CLOCK_ZERO_SPACING_MS, CLOCK_ZERO_MAX_SPACING_MS]).toEqual([3_000, 30_000]);
  });

  it("a new ply (the opponent moved) starts afresh, even after many reports — the spacing back to 3 s", () => {
    let r = nextClockZeroReport(null, K, 0)!;
    for (let now = 100; now <= 300_000; now += 100) r = nextClockZeroReport(r, K, now) ?? r;
    expect(r.attempts, "premise: well past the old cap of 5").toBeGreaterThan(5);
    const fresh = nextClockZeroReport(r, "g1:13", r.at + 1)!;
    expect(fresh).toEqual({ key: "g1:13", attempts: 1, at: r.at + 1 });
    expect(nextClockZeroReport(fresh, "g1:13", fresh.at + 3_000 - 1)).toBeNull();
    expect(nextClockZeroReport(fresh, "g1:13", fresh.at + 3_000)?.attempts).toBe(2);
  });
});

describe("reReadDelayMs (review I2: a refused act re-reads and carries on, backing off when it repeats)", () => {
  it("the empty case: no failure yet, or the first, re-reads at once", () => {
    expect(reReadDelayMs(0)).toBe(0);
    expect(reReadDelayMs(1)).toBe(0);
  });

  it("repeats back off — doubling from 1s — and never wait longer than the idle poll, which re-reads anyway", () => {
    expect([2, 3, 4, 5].map(reReadDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    let checked = 0;
    let prev = 0;
    for (let streak = 0; streak <= 60; streak += 1) {
      const d = reReadDelayMs(streak);
      expect(d, `streak ${streak}`).toBeGreaterThanOrEqual(prev);
      expect(d, `streak ${streak}`).toBeLessThanOrEqual(IDLE_POLL_MS);
      expect(Number.isFinite(d), `streak ${streak}`).toBe(true);
      prev = d;
      checked += 1;
    }
    expect(checked, "anti-vacuity: streaks").toBe(61);
    expect(reReadDelayMs(60), "a long run sits at the cap").toBe(IDLE_POLL_MS);
  });
});
