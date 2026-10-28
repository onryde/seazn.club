// W2e Task 15 (A2) - the proving tests for hockey.md's W2e rows: HK-YT-1, HK-SU-1, HK-GK-1, HK-ST-1. Every describe/it title carries
// its row id as a whole token (packages/engine/test/rules-reference.ts reads them). Expected values come from the rulebook (FIH Rules
// of Hockey, effective 1 March 2026: Rule 2.2 goalkeeper or field players only, Rule 14.1 personal penalties) written into each test as
// literals - never from the code under test. HK-YT-1 and HK-ST-1 are product rules (no federation figure exists), so their literals are the
// row's own text.
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`): the write path.
//
// The shoot-out rows (HK-SO-1, HK-SO-2) are Task 9's and are not touched here.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { resolvePositions, validateLineup } from "../../sport/catalog.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { PeriodCfg, PeriodState } from "../period/kernel.ts";
import { hockey } from "./hockey.ts";

const STRICT = { strictFromSeq: 0 } as const;
const lineups: LineupPair = defaultLineupPair(hockey.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

const cfgOf = (raw: unknown = {}): PeriodCfg => hockey.configSchema.parse(raw);
const youthCfg = (extra: Record<string, unknown> = {}): PeriodCfg => cfgOf({ ...hockey.variants.youth, ...extra });

type Spec = [type: string, payload?: unknown, voids?: string];
const stream = (...specs: Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const fold = (cfg: PeriodCfg, ...specs: Spec[]): PeriodState => foldMatch(hockey, cfg, lineups, stream(...specs), STRICT);
const at = (period: string, elapsed: number) => ({ period, elapsed });
const start: Spec = ["core.start"];

const card = (cls: string, by = A, extra: Record<string, unknown> = {}): Spec => ["hockey.suspension.start", { by, class: cls, ...extra }];
const release = (cls: string, by = A): Spec => ["hockey.suspension.end", { by, class: cls }];
const goal = (by: string, extra: Record<string, unknown> = {}): Spec => ["hockey.goal", { by, kind: "fg", ...extra }];
const advance = (to: string): Spec => ["hockey.period.advance", { to }];
const chipOf = (state: PeriodState): string | null => (hockey.summary(state).detail as { strength: string | null }).strength;

/** The code of the EngineError a fold throws, or null when it folds. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// HK-SU-1 (M15) - the card ladder: FIH Rules of Hockey 14.1
// ---------------------------------------------------------------------------------------------------------------------

describe("HK-SU-1 hockey cards suspend a player and the team plays short for the whole suspension: green 2 minutes, yellow 5 minutes, red permanent", () => {
  // FIH 14.1 (b) green: 2 minutes of playing time; (c) yellow: a minimum of 5 minutes; (d) red: the rest of the match; each leaves the
  // offending team one player short for as long as it lasts.
  const FIH_CARDS = [
    { card: "green", minutes: 2, permanent: false },
    { card: "yellow", minutes: 5, permanent: false },
    { card: "red", minutes: null, permanent: true },
  ] as const;

  it("HK-SU-1 declares exactly the three cards, each with the FIH length, each leaving the team short", () => {
    const classes = cfgOf().suspensions?.classes ?? {};
    expect(Object.keys(classes).sort()).toEqual(["green", "red", "yellow"]);
    for (const { card: cls, minutes, permanent } of FIH_CARDS) {
      expect(classes[cls], cls).toEqual({ minutes, teamShort: true, ...(permanent ? { permanent: true } : {}) });
    }
  });

  it("HK-SU-1 every card leaves the carded side one player short at once (11v10), whichever side is carded", () => {
    let checked = 0;
    for (const { card: cls } of FIH_CARDS) {
      expect(chipOf(fold(cfgOf(), start, card(cls, A))), `${cls} on away`).toBe("11v10");
      expect(chipOf(fold(cfgOf(), start, card(cls, H))), `${cls} on home`).toBe("10v11");
      checked++;
    }
    expect(checked).toBe(3);
    // The empty case: no card, no chip.
    expect(chipOf(fold(cfgOf(), start))).toBeNull();
  });

  it("HK-SU-1 a green and a yellow end by release and the side is back to full strength; a red is never released", () => {
    expect(chipOf(fold(cfgOf(), start, card("green"), release("green")))).toBeNull();
    expect(chipOf(fold(cfgOf(), start, card("yellow"), release("yellow")))).toBeNull();
    // The red: a release is refused (permanent exclusion), and it still leaves the team short at full time.
    expect(codeOf(() => fold(cfgOf(), start, card("red"), release("red")))).toBe("INVALID_EVENT");
    const fullTime = fold(cfgOf(), start, card("red"), advance("Q2"), advance("Q3"), advance("Q4"), advance("FT"));
    expect(fullTime.phase).toBe("done");
    expect(chipOf(fullTime)).toBe("11v10");
    // A second release of a card that was already released has nothing to release.
    expect(codeOf(() => fold(cfgOf(), start, card("green"), release("green"), release("green")))).toBe("INVALID_EVENT");
  });

  it("HK-SU-1 a stamped card runs out after its length of playing time, swept at the first stamped event at or past the expiry", () => {
    for (const { card: cls, minutes } of FIH_CARDS.filter((c) => c.minutes !== null)) {
      const seconds = (minutes as number) * 60;
      const started = fold(cfgOf(), start, card(cls, A, { at: at("Q1", 100) }));
      expect(started.suspensions[0]?.expiresAt, cls).toEqual(at("Q1", 100 + seconds));
      const justBefore = fold(cfgOf(), start, card(cls, A, { at: at("Q1", 100) }), goal(H, { at: at("Q1", 100 + seconds - 1) }));
      expect(justBefore.suspensions.length, `${cls} one second before`).toBe(1);
      const atExpiry = fold(cfgOf(), start, card(cls, A, { at: at("Q1", 100) }), goal(H, { at: at("Q1", 100 + seconds) }));
      expect(atExpiry.suspensions.length, `${cls} at the expiry`).toBe(0);
      expect(chipOf(atExpiry), `${cls} back to full strength`).toBeNull();
    }
    // A red has no length to run out.
    const red = fold(cfgOf(), start, card("red", A, { at: at("Q1", 100) }), goal(H, { at: at("Q1", 5000) }));
    expect(red.suspensions[0]?.expiresAt).toBeUndefined();
    expect(red.suspensions.length).toBe(1);
  });

  it("HK-SU-1 the umpire's awarded minutes govern a yellow (a minimum of 5), and the unserved time carries into the next quarter", () => {
    const tenMinutes = fold(cfgOf(), start, card("yellow", A, { minutes: 10, at: at("Q1", 100) }));
    expect(tenMinutes.suspensions[0]?.expiresAt).toEqual(at("Q1", 700));
    // FIH 14.3: playing time carries over a quarter break. A green at 14:00 of a 15-minute quarter has 60 s left in Q1 and 60 s in Q2.
    const carried = fold(cfgOf(), start, card("green", A, { at: at("Q1", 840) }));
    expect(carried.suspensions[0]?.expiresAt).toEqual(at("Q2", 60));
    const stillServing = fold(cfgOf(), start, card("green", A, { at: at("Q1", 840) }), advance("Q2"), goal(H, { at: at("Q2", 59) }));
    expect(stillServing.suspensions.length).toBe(1);
    const served = fold(cfgOf(), start, card("green", A, { at: at("Q1", 840) }), advance("Q2"), goal(H, { at: at("Q2", 60) }));
    expect(served.suspensions.length).toBe(0);
  });

  it("HK-SU-1 a goal does not end a card early: hockey has no power-play release", () => {
    const state = fold(cfgOf(), start, card("yellow", A, { at: at("Q1", 100) }), goal(H, { at: at("Q1", 150) }));
    expect(state.suspensions.length).toBe(1);
    expect(chipOf(state)).toBe("11v10");
    expect(state.goals).toEqual({ home: 1, away: 0 });
  });

  it("HK-SU-1 voiding the card start puts the side back to full strength, and the same card can be entered again", () => {
    const voided = fold(cfgOf(), start, card("yellow"), ["core.void", {}, "e-1"]);
    expect(voided.suspensions).toEqual([]);
    expect(chipOf(voided)).toBeNull();
    expect(chipOf(fold(cfgOf(), start, card("yellow"), ["core.void", {}, "e-1"], card("yellow")))).toBe("11v10");
  });

  it("HK-SU-1 a card class the competition does not declare is refused", () => {
    expect(codeOf(() => fold(cfgOf(), start, card("blue")))).toBe("INVALID_EVENT");
    // Ice hockey's ladder is not hockey's: a minor penalty is no FIH card.
    expect(codeOf(() => fold(cfgOf(), start, card("minor")))).toBe("INVALID_EVENT");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// HK-YT-1 (P6) - youth
// ---------------------------------------------------------------------------------------------------------------------

describe("HK-YT-1 the hockey youth variant plays four 10-minute quarters with a strength of seven (minimum 4) and the youth suspension classes", () => {
  // A product rule: no federation figure exists for youth hockey, so the literals are the row's own text. The youth cards are the adult
  // ladder scaled by 10/15 and rounded down to whole minutes (green 2 -> 1, yellow 5 -> 3); red stays permanent.
  const YOUTH_CARDS = [
    { card: "green", minutes: 1 },
    { card: "yellow", minutes: 3 },
  ] as const;

  it("HK-YT-1 the variant resolves to four 10-minute quarters, base 7 minimum 4 and green 1, yellow 3, red permanent", () => {
    const youth = youthCfg();
    expect(youth.periods).toEqual({ count: 4, minutes: 10 });
    expect(youth.strength).toEqual({ base: 7, min: 4 });
    expect(youth.suspensions?.classes).toEqual({
      green: { minutes: 1, teamShort: true },
      yellow: { minutes: 3, teamShort: true },
      red: { minutes: null, teamShort: true, permanent: true },
    });
    // The contrast: the adult variant is 4 x 15, 11 / 7 and 2 / 5 - a youth test that passes on the adult config tests nothing.
    const adult = cfgOf();
    expect([adult.periods, adult.strength, adult.suspensions?.classes.green?.minutes, adult.suspensions?.classes.yellow?.minutes]).toEqual([
      { count: 4, minutes: 15 },
      { base: 11, min: 7 },
      2,
      5,
    ]);
  });

  it("HK-YT-1 a youth match runs Q1 to Q4 and full time, and a fifth-period label is refused", () => {
    const state = fold(youthCfg(), start, goal(H), advance("Q2"), advance("Q3"), advance("Q4"), advance("FT"));
    expect(state.periods.map((p) => p.phase)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(state.outcome).toEqual({ kind: "win", winner: H, loser: A, method: "regulation" });
    expect(codeOf(() => fold(youthCfg(), start, advance("Q2"), advance("Q3"), advance("Q4"), advance("Q5")))).toBe("INVALID_EVENT");
  });

  it("HK-YT-1 the youth card lengths reach the clock, and the 10-minute quarter carries what the 15-minute one would not", () => {
    for (const { card: cls, minutes } of YOUTH_CARDS) {
      const started = fold(youthCfg(), start, card(cls, A, { at: at("Q1", 100) }));
      expect(started.suspensions[0]?.expiresAt, cls).toEqual(at("Q1", 100 + minutes * 60));
    }
    // A yellow at 8:20 of a 10-minute quarter has 100 s left in Q1 and 80 s to serve in Q2; the adult 15-minute quarter has room for it.
    const youth = fold(youthCfg(), start, card("yellow", A, { at: at("Q1", 500) }));
    expect(youth.suspensions[0]?.expiresAt).toEqual(at("Q2", 80));
    const adult = fold(cfgOf(), start, card("yellow", A, { at: at("Q1", 500) }));
    expect(adult.suspensions[0]?.expiresAt).toEqual(at("Q1", 800));
  });

  it("HK-YT-1 stacked cards take a youth side to 7v4 and no lower, on either side", () => {
    // base 7: one card 7v6 ... three cards 7v4 (the minimum); a fourth and fifth stay at 4.
    const expected = [["7v6", 1], ["7v5", 2], ["7v4", 3], ["7v4", 4], ["7v4", 5]] as const;
    for (const [chip, n] of expected) {
      const cards = Array.from({ length: n }, () => card("yellow", A));
      expect(chipOf(fold(youthCfg(), start, ...cards)), `${n} cards on away`).toBe(chip);
    }
    const bothSides = fold(youthCfg(), start, ...Array.from({ length: 5 }, () => card("yellow", A)), ...Array.from({ length: 5 }, () => card("yellow", H)));
    expect(chipOf(bothSides)).toBe("4v4");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// HK-GK-1 (M16) - goalkeeper and set pieces: FIH Rules of Hockey 2.2
// ---------------------------------------------------------------------------------------------------------------------

describe("HK-GK-1 a hockey side lists one goalkeeper (GK, minimum 1, maximum 1) unless the competition allows none, and penalty corners and strokes are separate set pieces and goal kinds", () => {
  /** The catalog-valid sheet with its keeper (the first starter) re-positioned: `keepers` of the starters become GK, the rest DF. */
  function sheetWith(keepers: number): Lineup {
    const base = lineups.home;
    let given = 0;
    return {
      ...base,
      slots: base.slots.map((slot) => {
        if (slot.slot !== "starting") return slot;
        const positionKey = given < keepers ? "GK" : "DF";
        given++;
        return { ...slot, positionKey };
      }),
    };
  }
  const issuesOf = (cfg: PeriodCfg, keepers: number) => validateLineup(resolvePositions(hockey, cfg), sheetWith(keepers)).map((i) => i.kind);

  it("HK-GK-1 one goalkeeper is a legal sheet; none and two are not", () => {
    expect(issuesOf(cfgOf(), 1)).toEqual([]);
    expect(issuesOf(cfgOf(), 0)).toEqual(["group_min"]);
    expect(issuesOf(cfgOf(), 2)).toEqual(["group_max"]);
  });

  it("HK-GK-1 a competition that allows a side with field players only (FIH 2.2) takes none, and still not two", () => {
    expect(issuesOf(cfgOf({ goalkeeper: "optional" }), 0)).toEqual([]);
    expect(issuesOf(cfgOf({ goalkeeper: "optional" }), 1)).toEqual([]);
    expect(issuesOf(cfgOf({ goalkeeper: "optional" }), 2)).toEqual(["group_max"]);
    // The catalog declares the group once, with minimum 1 and maximum 1.
    expect(hockey.positions.groups.find((g) => g.key === "GK")).toMatchObject({ min: 1, max: 1 });
  });

  it("HK-GK-1 the competition records two set-piece kinds, pc and stroke, and no other kind", () => {
    expect(cfgOf().setPieceKinds).toEqual(["pc", "stroke"]);
    const state = fold(cfgOf(), start, ["hockey.set_piece", { by: H, kind: "pc" }], ["hockey.set_piece", { by: H, kind: "pc" }], ["hockey.set_piece", { by: A, kind: "stroke" }]);
    expect(state.setPieces).toEqual({
      home: { pc: { awarded: 2, scored: 0, resolved: 0 } },
      away: { stroke: { awarded: 1, scored: 0, resolved: 0 } },
    });
    // A set piece alone moves no score.
    expect(state.goals).toEqual({ home: 0, away: 0 });
    // Ice hockey's penalty shot is no hockey set piece.
    expect(codeOf(() => fold(cfgOf(), start, ["hockey.set_piece", { by: H, kind: "ps" }]))).toBe("INVALID_EVENT");
  });

  it("HK-GK-1 a goal is credited to the kind it came from, and a scored set piece does not count the goal twice", () => {
    const state = fold(
      cfgOf(),
      start,
      ["hockey.set_piece", { by: H, kind: "pc", outcome: "scored" }],
      goal(H, { kind: "pc" }),
      ["hockey.set_piece", { by: H, kind: "stroke", outcome: "scored" }],
      goal(H, { kind: "stroke" }),
      goal(A), // a field goal
    );
    expect(state.goals).toEqual({ home: 2, away: 1 });
    expect(state.kindCounts).toEqual({ home: { pc: 1, stroke: 1 }, away: {} });
    expect(state.setPieces?.home).toEqual({ pc: { awarded: 1, scored: 1, resolved: 1 }, stroke: { awarded: 1, scored: 1, resolved: 1 } });
    // A kind this sport does not have is refused.
    expect(codeOf(() => fold(cfgOf(), start, goal(H, { kind: "pp" })))).toBe("INVALID_EVENT");
  });

  it("HK-GK-1 voiding a pc goal takes the kind's credit away with the goal", () => {
    const state = fold(cfgOf(), start, goal(H, { kind: "pc" }), ["core.void", {}, "e-1"]);
    expect(state.goals).toEqual({ home: 0, away: 0 });
    expect(state.kindCounts).toEqual({ home: {}, away: {} });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// HK-ST-1 (D15) - strength.min is a penalty floor
// ---------------------------------------------------------------------------------------------------------------------

describe("HK-ST-1 strength.min is a penalty floor: stacked suspensions never take a team below it, nothing ends or warns, the organiser's abandon or a forfeit ends the match", () => {
  const stacked = (n: number, by = A): Spec[] => Array.from({ length: n }, () => card("yellow", by));

  it("HK-ST-1 the chip clamps at the minimum 7 (adult) and does not go below it however many suspensions stack", () => {
    // base 11, min 7: one card 11v10, three 11v8, four 11v7 (at the floor), five and six still 11v7 - never 11v6.
    const expected = [["11v10", 1], ["11v9", 2], ["11v8", 3], ["11v7", 4], ["11v7", 5], ["11v7", 6]] as const;
    let checked = 0;
    for (const [chip, n] of expected) {
      expect(chipOf(fold(cfgOf(), start, ...stacked(n))), `${n} on away`).toBe(chip);
      const [short, full] = chip.split("v");
      expect(chipOf(fold(cfgOf(), start, ...stacked(n, H))), `${n} on home`).toBe(`${full}v${short}`);
      checked++;
    }
    expect(checked).toBe(6);
    // Both sides at the floor: 7v7.
    expect(chipOf(fold(cfgOf(), start, ...stacked(6, A), ...stacked(6, H)))).toBe("7v7");
  });

  it("HK-ST-1 every suspension stays in the ledger of the state: the floor clamps the count, it consumes nothing", () => {
    const six = fold(cfgOf(), start, ...stacked(6));
    expect(six.suspensions.length).toBe(6);
    // Releasing down from six: 5 and 4 left stay at the floor (11 - 4 = 7), 3 left is 11v8, 2 left 11v9.
    const afterReleases = (n: number) => chipOf(fold(cfgOf(), start, ...stacked(6), ...Array.from({ length: n }, () => release("yellow"))));
    expect([afterReleases(1), afterReleases(2), afterReleases(3), afterReleases(4)]).toEqual(["11v7", "11v7", "11v8", "11v9"]);
  });

  it("HK-ST-1 a red card counts toward the floor like any other suspension", () => {
    expect(chipOf(fold(cfgOf(), start, card("red"), card("red"), card("red"), card("red"), card("red")))).toBe("11v7");
  });

  it("HK-ST-1 the engine ends nothing and warns of nothing when a team is at or below the floor", () => {
    const state = fold(cfgOf(), start, goal(H), ...stacked(8));
    expect(state.outcome).toBeNull();
    expect(state.phase).toBe("Q1");
    // Play goes on: a goal and the quarter advance are still accepted, and the match is still decided by the score.
    const played = fold(cfgOf(), start, goal(H), ...stacked(8), goal(A), advance("Q2"));
    expect(played.phase).toBe("Q2");
    expect(played.goals).toEqual({ home: 1, away: 1 });
    // No warning field exists on the summary (positive pair: the strength chip does).
    const detail = hockey.summary(state).detail as Record<string, unknown>;
    expect(Object.keys(detail)).toContain("strength");
    expect(Object.keys(detail).filter((key) => /warn|alert|insufficient|below|cannot|forfeit/i.test(key))).toEqual([]);
  });

  it("HK-ST-1 the organiser's abandon (under the stage's award policy) or a retirement forfeit ends a match a team cannot continue", () => {
    const effective = (cfg: PeriodCfg, ...specs: Spec[]) => {
      const folded = foldMatchWithStoppage(hockey, cfg, lineups, stream(...specs), STRICT);
      return { outcome: outcomeOf(hockey, folded), state: folded.state };
    };
    const cannotContinue: Spec[] = [start, goal(H), ...stacked(6)];
    // Abandon, award policy: the leader wins on the score as it stood.
    expect(effective(cfgOf({ abandonPolicy: "award" }), ...cannotContinue, ["core.abandon", { reason: "too few players" }]).outcome).toEqual({
      kind: "win",
      winner: H,
      loser: A,
      method: "abandoned",
    });
    // Abandon, replay policy (the default): no result, flagged for the organiser, and no further play is accepted.
    const replay = effective(cfgOf(), ...cannotContinue, ["core.abandon", { reason: "too few players" }]);
    expect(replay.outcome).toBeNull();
    expect(replay.state.replayFlagged).toBe(true);
    expect(codeOf(() => fold(cfgOf(), ...cannotContinue, ["core.abandon", { reason: "too few players" }], goal(H)))).toBe("WRONG_PHASE");
    // A retirement forfeit by the short side awards the match to the other.
    expect(effective(cfgOf(), ...cannotContinue, ["core.forfeit", { by: A, reason: "retired" }]).outcome).toEqual({
      kind: "award",
      winner: H,
      loser: A,
      reason: "retired",
    });
  });
});
