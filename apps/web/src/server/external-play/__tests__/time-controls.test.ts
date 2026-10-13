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
  lichessSpeedOf,
} from "../time-controls";
import type { TimeControl } from "../time-controls";
import type { BoardgameClockInput } from "../clock";

/** Spec §3.7's list, written out as the rulebook states it — the catalogue is
 *  checked AGAINST this, not derived from it. Owner ruling 2026-10-09: 10+0
 *  and 15+0 join ship-1, in this order (both measured playable, b3-spike.log
 *  18:00:23Z and 18:00:40Z: created, accepted, both sides' moves 200). */
const SHIP1_KEYS = ["3+0", "3+2", "5+0", "5+3", "10+0", "10+5", "15+0", "15+10"];

/** The stored clock for a ship-1 key, from the KEY's own words (minutes +
 *  increment seconds; divisions.config.clock is in seconds). */
const clockOf = (key: string): BoardgameClockInput => {
  const [mins, inc] = key.split("+").map(Number) as [number, number];
  return { base: mins * 60, increment: inc };
};

/** M14 as Lichess DOCUMENTS it — lichess-api.yaml, `clock.limit`: "0, 15, 30,
 *  45, 60, 90, and any multiple of 60 up to 10800". A rulebook transcription,
 *  kept in the test: production enforces M14 through the catalogue alone
 *  (round 0's `isCreatableLimit` had no runtime caller and was removed, fix
 *  round 1, T5-I1). The next test pins this transcription to every measured
 *  creation outcome, so it cannot drift from the evidence unnoticed. */
const documentedCreatable = (limit: number) =>
  [0, 15, 30, 45, 60, 90].includes(limit) || (limit >= 0 && limit <= 10_800 && limit % 60 === 0);

describe("M14's documented rule agrees with every measured creation", () => {
  it("accepts each limit a spike created, and refuses each one a spike saw refused", () => {
    // Accepted: spike-battery2.log §A-§F, tc-boundary.log, flag-spike.log,
    // b3-spike.log (900: the 15+0 game, 18:00:40Z).
    const accepted = [0, 60, 120, 180, 600, 900];
    // Refused {"clock.limit":["Invalid value"]}: tc-boundary.log 10:32:04Z, 10:33:06Z.
    const refused = [170, 140];
    let checked = 0;
    for (const limit of accepted) { expect(documentedCreatable(limit), String(limit)).toBe(true); checked++; }
    for (const limit of refused) { expect(documentedCreatable(limit), String(limit)).toBe(false); checked++; }
    expect(checked).toBe(accepted.length + refused.length);
  });
});

describe("SHIP1_TIME_CONTROLS", () => {
  it("is exactly the ruled ship-1 list (eight entries), in its order", () => {
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
      if (!documentedCreatable(tc.limitSeconds)) failures.push(`${tc.key}: clock.limit refused`);
      if (!isBoardApiPlayable(tc)) {
        failures.push(`${tc.key}: estimated ${estimatedSeconds(tc)}s < ${BOARD_API_MIN_ESTIMATED_SECONDS}s`);
      }
      checked++;
    }
    expect(failures).toEqual([]);
    expect(checked, "the playability sweep checked nothing — zero is a failure")
      .toBe(SHIP1_TIME_CONTROLS.length);
    expect(checked).toBeGreaterThan(0);
    // Anchored on the RULING's list, not the catalogue: an entry dropped from
    // both would otherwise shrink the sweep unnoticed.
    expect(checked).toBe(SHIP1_KEYS.length);
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
    expect(documentedCreatable(tc.limitSeconds)).toBe(true);
    expect(isBoardApiPlayable(tc)).toBe(false);
  });

  // tc-boundary.log, 10:33:06Z — CHALLENGE REFUSED {"clock.limit":["Invalid value"]}
  // even though 140 + 40 = 180 clears M13's cutoff. This is the case that
  // proves the two rules are not one rule.
  it("140+1 is playable by the formula and NOT creatable: clock.limit refused", () => {
    const tc = { key: "140s+1", limitSeconds: 140, incrementSeconds: 1 };
    expect(estimatedSeconds(tc)).toBe(180);
    expect(isBoardApiPlayable(tc)).toBe(true);
    expect(documentedCreatable(tc.limitSeconds)).toBe(false);
  });

  // tc-boundary.log, 10:32:04Z — refused at creation; also under the cutoff.
  it("170+0 fails both", () => {
    const tc = { key: "170s+0", limitSeconds: 170, incrementSeconds: 0 };
    expect(documentedCreatable(tc.limitSeconds)).toBe(false);
    expect(isBoardApiPlayable(tc)).toBe(false);
  });

  // tc-boundary.log, 10:33:39Z — speed=blitz, move http=200. The boundary,
  // exactly ON the cutoff.
  it("180+0 passes both, at the boundary", () => {
    const tc = { key: "3+0", limitSeconds: 180, incrementSeconds: 0 };
    expect(estimatedSeconds(tc)).toBe(BOARD_API_MIN_ESTIMATED_SECONDS);
    expect(isBoardApiPlayable(tc)).toBe(true);
    expect(documentedCreatable(tc.limitSeconds)).toBe(true);
  });

  // spike-battery2.log §A — both created fine, both refused every move.
  it.each([
    ["0+1", 0, 1], ["1+0", 60, 0],
  ])("%s was ACCEPTED at creation and is still unplayable (M12)", (_k, limit, inc) => {
    // Added beyond the brief: the title's first half is a measured fact too
    // (§A: "challenge accepted at creation"), so it is asserted, not just named.
    expect(documentedCreatable(limit)).toBe(true);
    expect(isBoardApiPlayable({ key: _k, limitSeconds: limit, incrementSeconds: inc })).toBe(false);
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

describe("assertTimeControl — the setup gate, on the clock the division STORES", () => {
  // Fix round 1 (T5-I1): the division stores `clock {base, increment?, delay?}`
  // in seconds (clock.ts); nothing formats that into a "3+0" key, so the gate
  // takes the stored shape. Wiring it into the division save is Task 6's.
  it("returns the catalogue entry for every ship-1 clock, and reports the count", () => {
    let checked = 0;
    for (const key of SHIP1_KEYS) {
      expect(assertTimeControl(clockOf(key)).key, key).toBe(key);
      checked++;
    }
    expect(checked).toBe(SHIP1_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("hands back the SAME object the catalogue holds, not a copy", () => {
    expect(assertTimeControl(clockOf("5+3"))).toBe(
      SHIP1_TIME_CONTROLS.find((t) => t.key === "5+3"),
    );
  });

  // The engine's own comment (boardgame.ts, `clock`): an absent increment is
  // behaviourally identical to `increment: 0` — sudden death.
  it("an ABSENT increment is sudden death, so { base: 180 } is 3+0", () => {
    expect(assertTimeControl({ base: 180 }).key).toBe("3+0");
    expect(assertTimeControl({ base: 300 }).key).toBe("5+0");
  });

  it.each<[string, BoardgameClockInput | undefined]>([
    ["0+1: accepted at creation, unplayable (M12)", { base: 0, increment: 1 }],
    ["1+0: accepted at creation, unplayable (M12)", { base: 60 }],
    ["2+1: creatable, estimated 160s (M13)", { base: 120, increment: 1 }],
    ["140+1: refused at creation (M14)", { base: 140, increment: 1 }],
    ["170+0: refused at creation (M14)", { base: 170 }],
    ["20+0: passes both rules, not on the ship-1 list", { base: 1200, increment: 0 }],
    ["3+1: not on the list — the catalogue is the gate, not the formula", { base: 180, increment: 1 }],
    ["a delay clock: Lichess has none (clock.ts)", { base: 180, increment: 0, delay: 2 }],
    ["a delay of 0 is still a delay clock", { base: 180, delay: 0 }],
    ["no clock at all", undefined],
    ["minutes stored where seconds belong", { base: 3, increment: 0 }],
    ["milliseconds stored where seconds belong", { base: 180_000, increment: 0 }],
    ["a negative base", { base: -180 }],
    ["NaN", { base: Number.NaN }],
    ["a base that drifted to a string in stored JSON", { base: "180" as unknown as number }],
    ["an increment that drifted to a string", { base: 180, increment: "2" as unknown as number }],
  ])("refuses %s with 400 INVALID_TIME_CONTROL", (_why, clock) => {
    expect(() => assertTimeControl(clock)).toThrowError(
      expect.objectContaining({ status: 400, code: "INVALID_TIME_CONTROL" }),
    );
  });

  it("the refusal names the permitted controls, so an organiser can fix it without the docs", () => {
    let message = "";
    try { assertTimeControl({ base: 180, increment: 1 }); } catch (e) { message = (e as Error).message; }
    expect(message).not.toBe("");
    for (const key of SHIP1_KEYS) expect(message, key).toContain(key);
  });

  // The gate is the CATALOGUE, not the formula: a time control can satisfy
  // both measured rules and still be refused, because §3.7 says the organiser
  // picks from a curated list.
  it("a formula-passing clock off the list is still refused", () => {
    const off = { key: "20+0", limitSeconds: 1200, incrementSeconds: 0 };
    expect(isBoardApiPlayable(off)).toBe(true);
    expect(documentedCreatable(off.limitSeconds)).toBe(true);
    expect(() => assertTimeControl({ base: 1200, increment: 0 })).toThrow();
  });
});

// T17 round B, C: the match centre said "Classical" over a 10+5 game, because the label was the division's declared
// clock family, which nothing ties to the time control. Online, the game is a Lichess game, and Lichess names its
// speed from the time control alone. The rulebook here is scalachess `core/src/main/scala/Speed.scala` (read
// 2026-10-13): Bullet 30–179, Blitz 180–479, Rapid 480–1499, Classical 1500–21599, on the estimate limit + 40 × increment.
describe("lichessSpeedOf — the speed Lichess names a time control by", () => {
  it("every ship-1 entry, as Lichess's own lobby names it", () => {
    const LICHESS_NAMES: Record<string, string> = {
      "3+0": "blitz", "3+2": "blitz", "5+0": "blitz", "5+3": "blitz",
      "10+0": "rapid", "10+5": "rapid", "15+0": "rapid", "15+10": "rapid",
    };
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      expect(lichessSpeedOf(tc), tc.key).toBe(LICHESS_NAMES[tc.key]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: the whole catalogue").toBe(SHIP1_KEYS.length);
  });

  it("the edges of Speed.scala's ranges — and the increment counts 40 times, so 2+9 is rapid though 2 minutes is not", () => {
    const at = (limitSeconds: number, incrementSeconds = 0): TimeControl => ({ key: "edge", limitSeconds, incrementSeconds });
    const cells: [TimeControl, string][] = [
      [at(179), "bullet"],
      [at(180), "blitz"],
      [at(479), "blitz"],
      [at(480), "rapid"],
      [at(1499), "rapid"],
      [at(1500), "classical"],
      [at(120, 9), "rapid"],
      [at(1200, 8), "classical"],
    ];
    let checked = 0;
    for (const [tc, speed] of cells) {
      expect(lichessSpeedOf(tc), `${tc.limitSeconds}+${tc.incrementSeconds}`).toBe(speed);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
  });
});
