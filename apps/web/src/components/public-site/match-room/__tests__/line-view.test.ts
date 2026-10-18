// Capacity test 32, the card's words (spec §6.1 (2), §8.1): the estimate is shown rounded UP to 5 s, in minutes above 90 s,
// and never as "about 0"; `lineOf` hands the card the line only for a `queued` answer.
//
// Expected values come from the RULE (rounded up to the next 5 s; "about 2 minutes" above 90 s), not from the function.
import { describe, expect, it } from "vitest";
import { ETA_MINUTES_ABOVE_S, ETA_STEP_S, etaPhrase, lineOf } from "../line-view";
import type { SeatAnswer } from "../room-api";
import type { LineWire } from "../room-snapshot";

const LINE: LineWire = { position: 3, etaS: 30, pollMs: 3_000, closesAt: "2026-10-15T10:30:00.000Z", mayTimeOut: false, left: null };

describe("etaPhrase", () => {
  it("rounds UP to the next 5 s: a player told 'about 30 seconds' never waits for 25 that were rounded down", () => {
    const CASES: [number, number][] = [
      [0, 5], // never "about 0 seconds"
      [1, 5],
      [4.2, 5],
      [5, 5], // already on a step: not moved
      [5.001, 10], // a hair over: the next step
      [6, 10],
      [29, 30],
      [30, 30],
      [31, 35],
      [89, 90],
      [90, 90], // the last second the card still counts in seconds
    ];
    for (const [etaS, want] of CASES) expect(etaPhrase(etaS), `etaS ${etaS}`).toEqual({ unit: "seconds", count: want });
    expect(CASES.length, "cases checked").toBe(11);
  });

  it("above 90 s it is whole minutes rounded UP: 91 s is 'about 2 minutes', not 1", () => {
    const CASES: [number, number][] = [
      [ETA_MINUTES_ABOVE_S + 1, 2],
      [120, 2],
      [120.5, 3],
      [121, 3],
      [300, 5],
      [3_600, 60],
    ];
    for (const [etaS, want] of CASES) expect(etaPhrase(etaS), `etaS ${etaS}`).toEqual({ unit: "minutes", count: want });
    expect(CASES.length, "cases checked").toBe(6);
  });

  it("the boundary pair: 90 s is still seconds, one more is minutes (the spec's 'above 90 s')", () => {
    expect(ETA_MINUTES_ABOVE_S, "the spec's 90").toBe(90);
    expect(ETA_STEP_S, "the spec's 5").toBe(5);
    expect(etaPhrase(90).unit).toBe("seconds");
    expect(etaPhrase(90.001).unit).toBe("minutes");
  });

  it("a number that is not one (NaN, Infinity, negative) reads as the smallest step, never a crash or 'about NaN'", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -30]) {
      expect(etaPhrase(bad), String(bad)).toEqual({ unit: "seconds", count: ETA_STEP_S });
    }
  });
});

describe("lineOf", () => {
  it("is the wire's line for a queued answer, and null for everything else (anti-vacuity: both sides asserted)", () => {
    const queued: SeatAnswer = { seated: false, reason: "queued", participant: null, line: LINE };
    expect(lineOf(queued)).toBe(LINE);
    const others: (SeatAnswer | null)[] = [
      null,
      { seated: false, reason: "camera_starting", participant: null },
      { seated: false, reason: "camera_required", participant: null },
      { seated: false, reason: "checkin_not_open", participant: null },
    ];
    for (const o of others) expect(lineOf(o), JSON.stringify(o)).toBeNull();
    expect(others.length, "answers checked").toBe(4);
  });
});
