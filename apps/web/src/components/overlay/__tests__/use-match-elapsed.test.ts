import { describe, expect, it } from "vitest";
import { MATCH_ELAPSED_CAP_MS, matchElapsedLabel, matchElapsedShown } from "../use-match-elapsed";
import { NO_CLOCK_STATUSES } from "../use-overlay-clock";

// The corner badge's match timer (owner, 2026-11-17): time since the match started, for every sport.
const START = Date.parse("2026-11-17T10:00:00.000Z");
const at = (h: number, m: number, s: number) => START + ((h * 60 + m) * 60 + s) * 1000;

describe("matchElapsedLabel", () => {
  it("reads m:ss under an hour and h:mm:ss from the hour on", () => {
    const cases: readonly (readonly [number, string])[] = [
      [at(0, 0, 0), "0:00"],
      [at(0, 0, 59), "0:59"],
      [at(0, 12, 34), "12:34"],
      [at(0, 59, 59), "59:59"],
      [at(1, 0, 0), "1:00:00"],
      [at(1, 2, 3), "1:02:03"],
      [at(3, 45, 9), "3:45:09"],
    ];
    expect(cases.length).toBe(7);
    for (const [now, label] of cases) expect(matchElapsedLabel(START, now), label).toBe(label);
  });

  it("never runs backward: a picture time before the start (stream delay, clock skew) reads 0:00", () => {
    expect(matchElapsedLabel(START, START - 90_000)).toBe("0:00");
  });

  it("F16 — never an implausible number: a match left in play shows NO timer past the cap, at the cap exactly it still shows", () => {
    expect(matchElapsedLabel(START, START + MATCH_ELAPSED_CAP_MS)).not.toBeNull();
    expect(matchElapsedLabel(START, START + MATCH_ELAPSED_CAP_MS + 1000)).toBeNull();
    expect(matchElapsedLabel(START, START + 20 * 3600_000)).toBeNull();
  });

  it("a start that is not a finite number yields no timer", () => {
    expect(matchElapsedLabel(Number.NaN, START)).toBeNull();
  });
});

describe("matchElapsedShown", () => {
  it("only while in play, with a start, and when the scorebug carries no clock of its own", () => {
    expect(matchElapsedShown({ startedAtMs: START, status: "in_play", sportHasClock: false })).toBe(true);
    // A football-family scorebug already shows match time in its header: never two timers on one picture.
    expect(matchElapsedShown({ startedAtMs: START, status: "in_play", sportHasClock: true })).toBe(false);
    expect(matchElapsedShown({ startedAtMs: undefined, status: "in_play", sportHasClock: false })).toBe(false);
  });

  it("every status the header clock goes dark for, the corner timer goes dark for too", () => {
    expect(NO_CLOCK_STATUSES.size).toBeGreaterThan(0);
    for (const status of NO_CLOCK_STATUSES) {
      expect(matchElapsedShown({ startedAtMs: START, status, sportHasClock: false }), status).toBe(false);
    }
  });
});
