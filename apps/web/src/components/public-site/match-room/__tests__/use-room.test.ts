// T14 — the transport's two pure decisions: how often the room polls, and
// when a clock that reached zero is reported. The hook's wiring (the poll
// effect, the realtime channel, the calls) is the room e2e's.
import { describe, expect, it } from "vitest";
import { CLOCK_ZERO_ATTEMPTS, CLOCK_ZERO_SPACING_MS, IDLE_POLL_MS, LIVE_POLL_MS, SETTLED_POLL_MS, nextClockZeroReport, pollIntervalMs, reReadDelayMs } from "../use-room";

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

  it("at most CLOCK_ZERO_ATTEMPTS per ply, however long the clock sits at zero", () => {
    let r = nextClockZeroReport(null, K, 0)!;
    let sent = 1;
    for (let now = 1; now < 600_000; now += 100) {
      const n = nextClockZeroReport(r, K, now);
      if (n) {
        r = n;
        sent += 1;
      }
    }
    expect(sent).toBe(CLOCK_ZERO_ATTEMPTS);
    expect(CLOCK_ZERO_ATTEMPTS).toBeGreaterThan(1); // a later report is how a flag Lichess settles late is read
  });

  it("a new ply (the opponent moved) starts afresh, even straight after the cap", () => {
    let r = nextClockZeroReport(null, K, 0)!;
    for (let i = 0; i < 10; i += 1) r = nextClockZeroReport(r, K, (i + 1) * CLOCK_ZERO_SPACING_MS) ?? r;
    expect(r.attempts).toBe(CLOCK_ZERO_ATTEMPTS);
    expect(nextClockZeroReport(r, "g1:13", r.at + 1)).toEqual({ key: "g1:13", attempts: 1, at: r.at + 1 });
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
