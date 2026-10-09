// Design §3.7. The organiser picks from a curated list validated at TOURNAMENT
// SETUP, because creation succeeding proves nothing about playability (M12: a
// 0+1 challenge was accepted and then refused every move).
//
// Expected values here come from the SPEC's ship-1 list and from the measured
// log lines, never from time-controls.ts.
import { describe, expect, it } from "vitest";
import {
  BOARD_API_MIN_ESTIMATED_SECONDS,
  SHIP1_TIME_CONTROLS,
  assertTimeControl,
  estimatedSeconds,
  isBoardApiPlayable,
  isCreatableLimit,
} from "../time-controls";
import type { TimeControl } from "../time-controls";

/** Spec §3.7's list, written out as the rulebook states it — the catalogue is
 *  checked AGAINST this, not derived from it. */
const SHIP1_KEYS = ["3+0", "3+2", "5+0", "5+3", "10+5", "15+10"];

describe("SHIP1_TIME_CONTROLS", () => {
  it("is exactly the spec's six entries, in the spec's order", () => {
    expect(SHIP1_TIME_CONTROLS.map((t) => t.key)).toEqual(SHIP1_KEYS);
  });

  it("every key's minutes+increment match its seconds — the label cannot lie", () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const [mins, inc] = tc.key.split("+").map(Number) as [number, number];
      expect(tc.limitSeconds, tc.key).toBe(mins * 60);
      expect(tc.incrementSeconds, tc.key).toBe(inc);
      checked++;
    }
    expect(checked, "the label sweep checked nothing").toBe(SHIP1_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });

  // The §8.2 sweep: driven, not asserted. Every entry walks BOTH measured
  // rules, and the count is reported — a sweep that checks zero is a FAILURE.
  it("every entry is both creatable (M14) and playable (M13), and reports the count", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const tc of SHIP1_TIME_CONTROLS) {
      if (!isCreatableLimit(tc.limitSeconds)) failures.push(`${tc.key}: clock.limit refused`);
      if (!isBoardApiPlayable(tc)) {
        failures.push(`${tc.key}: estimated ${estimatedSeconds(tc)}s < ${BOARD_API_MIN_ESTIMATED_SECONDS}s`);
      }
      checked++;
    }
    expect(failures).toEqual([]);
    expect(checked, "the playability sweep checked nothing — zero is a failure")
      .toBe(SHIP1_TIME_CONTROLS.length);
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(6);
  });

  it("no duplicate keys, and no duplicate (limit, increment) pairs", () => {
    expect(new Set(SHIP1_TIME_CONTROLS.map((t) => t.key)).size).toBe(SHIP1_TIME_CONTROLS.length);
    expect(new Set(SHIP1_TIME_CONTROLS.map((t) => `${t.limitSeconds}/${t.incrementSeconds}`)).size)
      .toBe(SHIP1_TIME_CONTROLS.length);
  });

  it("is frozen — a caller cannot push an unplayable entry into the shared catalogue", () => {
    expect(Object.isFrozen(SHIP1_TIME_CONTROLS)).toBe(true);
    expect(() => (SHIP1_TIME_CONTROLS as TimeControl[]).push({
      key: "0+1", limitSeconds: 0, incrementSeconds: 1,
    })).toThrow();
  });
});

describe("the two measured rules are INDEPENDENT (M13, M14)", () => {
  // tc-boundary.log, 10:32:36Z — created fine, then every move refused.
  it("120+1 is creatable and NOT playable: estimated 160s", () => {
    const tc = { key: "2+1", limitSeconds: 120, incrementSeconds: 1 };
    expect(estimatedSeconds(tc)).toBe(160);
    expect(isCreatableLimit(tc.limitSeconds)).toBe(true);
    expect(isBoardApiPlayable(tc)).toBe(false);
  });

  // tc-boundary.log, 10:33:06Z — CHALLENGE REFUSED {"clock.limit":["Invalid value"]}
  // even though 140 + 40 = 180 clears M13's cutoff. This is the case that
  // proves the two rules are not one rule.
  it("140+1 is playable by the formula and NOT creatable: clock.limit refused", () => {
    const tc = { key: "140s+1", limitSeconds: 140, incrementSeconds: 1 };
    expect(estimatedSeconds(tc)).toBe(180);
    expect(isBoardApiPlayable(tc)).toBe(true);
    expect(isCreatableLimit(tc.limitSeconds)).toBe(false);
  });

  // tc-boundary.log, 10:32:04Z — refused at creation; also under the cutoff.
  it("170+0 fails both", () => {
    const tc = { key: "170s+0", limitSeconds: 170, incrementSeconds: 0 };
    expect(isCreatableLimit(tc.limitSeconds)).toBe(false);
    expect(isBoardApiPlayable(tc)).toBe(false);
  });

  // tc-boundary.log, 10:33:39Z — speed=blitz, move http=200. The boundary,
  // exactly ON the cutoff.
  it("180+0 passes both, at the boundary", () => {
    const tc = { key: "3+0", limitSeconds: 180, incrementSeconds: 0 };
    expect(estimatedSeconds(tc)).toBe(BOARD_API_MIN_ESTIMATED_SECONDS);
    expect(isBoardApiPlayable(tc)).toBe(true);
    expect(isCreatableLimit(tc.limitSeconds)).toBe(true);
  });

  // spike-battery2.log §A — both created fine, both refused every move.
  it.each([
    ["0+1", 0, 1], ["1+0", 60, 0],
  ])("%s was ACCEPTED at creation and is still unplayable (M12)", (_k, limit, inc) => {
    // Added beyond the brief: the title's first half is a measured fact too
    // (§A: "challenge accepted at creation"), so it is asserted, not just named.
    expect(isCreatableLimit(limit)).toBe(true);
    expect(isBoardApiPlayable({ key: _k, limitSeconds: limit, incrementSeconds: inc })).toBe(false);
  });

  // Added beyond the brief: the `>= 0` half of isCreatableLimit. -60 is a
  // multiple of 60, so without that half it would read as creatable.
  it("a negative limit is not a clock, even when it is a multiple of 60", () => {
    expect(-60 % 60 === 0).toBe(true); // the trap: JS says -0 === 0
    expect(isCreatableLimit(-60)).toBe(false);
  });

  it("the cutoff is 180s, and one second under it is refused", () => {
    expect(BOARD_API_MIN_ESTIMATED_SECONDS).toBe(180);
    expect(isBoardApiPlayable({ key: "x", limitSeconds: 179, incrementSeconds: 0 })).toBe(false);
    expect(isBoardApiPlayable({ key: "x", limitSeconds: 180, incrementSeconds: 0 })).toBe(true);
  });

  it("the 40× weighting is the measured one, not a guess", () => {
    // 60 + 40 × 3 = 180: the increment carries 40 moves' worth, which is what
    // makes 60+3 playable and 60+2 (140s) not.
    expect(estimatedSeconds({ key: "1+3", limitSeconds: 60, incrementSeconds: 3 })).toBe(180);
    expect(estimatedSeconds({ key: "1+2", limitSeconds: 60, incrementSeconds: 2 })).toBe(140);
  });
});

describe("assertTimeControl — the setup gate", () => {
  it("returns the catalogue entry for every ship-1 key, and reports the count", () => {
    let checked = 0;
    for (const key of SHIP1_KEYS) {
      const tc = assertTimeControl(key);
      expect(tc.key).toBe(key);
      checked++;
    }
    expect(checked).toBe(SHIP1_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("hands back the SAME object the catalogue holds, not a copy", () => {
    expect(assertTimeControl("5+3")).toBe(
      SHIP1_TIME_CONTROLS.find((t) => t.key === "5+3"),
    );
  });

  it.each([
    ["0+1", "accepted at creation, unplayable (M12)"],
    ["1+0", "accepted at creation, unplayable (M12)"],
    ["2+1", "creatable, estimated 160s (M13)"],
    ["20+0", "playable and creatable, but not on the ship-1 list"],
    ["3+1", "not on the list — the catalogue is the gate, not the formula"],
    ["", "the shape a missing field arrives as"],
    ["3+0 ", "a trailing space is a different key"],
    ["3 + 0", "whitespace inside"],
    ["3-0", "wrong separator"],
    ["__proto__", "a prototype key must not resolve to anything"],
  ])("refuses %s (%s) with 400 INVALID_TIME_CONTROL", (key) => {
    expect(() => assertTimeControl(key)).toThrowError(
      expect.objectContaining({ status: 400, code: "INVALID_TIME_CONTROL" }),
    );
  });

  it("the refusal names the permitted keys, so an organiser can fix it without the docs", () => {
    let message = "";
    try { assertTimeControl("3+1"); } catch (e) { message = (e as Error).message; }
    for (const key of SHIP1_KEYS) expect(message, key).toContain(key);
  });

  // The gate is the CATALOGUE, not the formula: a time control can satisfy
  // both measured rules and still be refused, because §3.7 says the organiser
  // picks from a curated list that has been verified playable.
  it("a formula-passing key off the list is still refused", () => {
    const off = { key: "20+0", limitSeconds: 1200, incrementSeconds: 0 };
    expect(isBoardApiPlayable(off)).toBe(true);
    expect(isCreatableLimit(off.limitSeconds)).toBe(true);
    expect(() => assertTimeControl(off.key)).toThrow();
  });
});
