// W2e Task 15 (A2) - the proving tests for icehockey.md's W2e rows: IH-SU-1 and IH-ST-1. Every describe/it title carries its row id as a
// whole token (packages/engine/test/rules-reference.ts reads them). Expected values come from the rulebook (IIHF Official Rule Book
// 2026/27: Rules 16.1, 16.2, 17.1, 17.2, 18.2, 19, 20.2 and 26.1; 84.3 is the overtime rule and is not claimed) written into each test as literals -
// never from the code under test. Both rows are `deviation` rows because of the limits below.
//
// Several tests are marked "limit": they pin where the engine does NOT follow the IIHF article (a penalty-shot goal, coincidental minors
// and a double minor under Rule 16.2/18.2; the delayed clock of a third penalty under Rule 26.1). They are the engine's behaviour as it is,
// recorded in the row's text and in a0-findings A0.9, not a ruling that the article is wrong.
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`): the write path.
//
// The shoot-out rows (IH-SO-1, IH-SO-2) are Task 9's and are not touched here.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { PeriodCfg, PeriodState } from "../period/kernel.ts";
import { icehockey } from "./icehockey.ts";

const STRICT = { strictFromSeq: 0 } as const;
const lineups: LineupPair = defaultLineupPair(icehockey.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

const cfgOf = (raw: unknown = {}): PeriodCfg => icehockey.configSchema.parse(raw);

type Spec = [type: string, payload?: unknown, voids?: string];
const stream = (...specs: Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const fold = (cfg: PeriodCfg, ...specs: Spec[]): PeriodState => foldMatch(icehockey, cfg, lineups, stream(...specs), STRICT);
const at = (period: string, elapsed: number) => ({ period, elapsed });
const start: Spec = ["core.start"];

const card = (cls: string, by = A, extra: Record<string, unknown> = {}): Spec => ["icehockey.suspension.start", { by, class: cls, ...extra }];
const release = (cls: string, by = A): Spec => ["icehockey.suspension.end", { by, class: cls }];
const goal = (by: string, extra: Record<string, unknown> = {}): Spec => ["icehockey.goal", { by, ...extra }];
const chipOf = (state: PeriodState): string | null => (icehockey.summary(state).detail as { strength: string | null }).strength;

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
// IH-SU-1 (M17) - a goal releases the conceding side's minor: IIHF Rule 16.2 / 17.2
// ---------------------------------------------------------------------------------------------------------------------

describe("IH-SU-1 a goal ends the conceding side's running minor or bench minor with the least time left; for an own goal the conceding side is the striker's own", () => {
  // IIHF 16.2: if a team is short-handed by a minor or bench minor and the opposing team scores, the first of those penalties terminates
  // automatically - the one with the least time on the clock. 20.2: a major is served in full. Misconducts do not leave the team short.
  const RELEASED = ["minor", "bench_minor"] as const;
  const NOT_RELEASED = ["major", "misconduct", "game_misconduct", "match"] as const;

  it("IH-SU-1 a stamped goal by the opponent releases a minor or a bench minor, and never a major, a misconduct or a match penalty", () => {
    let checked = 0;
    for (const cls of RELEASED) {
      const state = fold(cfgOf(), start, card(cls, A, { at: at("P1", 100) }), goal(H, { at: at("P1", 200) }));
      expect(state.suspensions, `${cls} released`).toEqual([]);
      expect(chipOf(state), `${cls} back to full strength`).toBeNull();
      // The scoresheet row survives the release: PIM is not refunded.
      expect(state.cardLog.length, `${cls} still on the card log`).toBe(1);
      checked++;
    }
    for (const cls of NOT_RELEASED) {
      const state = fold(cfgOf(), start, card(cls, A, { at: at("P1", 100) }), goal(H, { at: at("P1", 200) }));
      expect(state.suspensions.length, `${cls} served in full`).toBe(1);
      checked++;
    }
    expect(checked).toBe(RELEASED.length + NOT_RELEASED.length);
  });

  it("IH-SU-1 a permanent exclusion is never released by a goal, even where a competition's class table marks it releasable", () => {
    // The permanent flag outranks releaseOnGoal: a send-off has no time to cut short. Without the permanent class the same goal releases the minor.
    const classes = {
      minor: { minutes: 2, teamShort: true, releaseOnGoal: true },
      banished: { minutes: null, teamShort: true, permanent: true, releaseOnGoal: true },
    };
    const cfg = cfgOf({ suspensions: { classes } });
    const banished = fold(cfg, start, card("banished", A, { at: at("P1", 100) }), goal(H, { at: at("P1", 200) }));
    expect(banished.suspensions.map((s) => s.classKey)).toEqual(["banished"]);
    const minor = fold(cfg, start, card("minor", A, { at: at("P1", 100) }), goal(H, { at: at("P1", 200) }));
    expect(minor.suspensions).toEqual([]);
  });

  it("IH-SU-1 the goal must come from the other side: a goal by the penalised side releases nothing", () => {
    const state = fold(cfgOf(), start, card("minor", A, { at: at("P1", 100) }), goal(A, { at: at("P1", 200) }));
    expect(state.suspensions.length).toBe(1);
  });

  it("IH-SU-1 releases the penalty with the least time left, not the first one entered, and falls back to entry order on a tie", () => {
    // A 5-minute minor at 100 s expires at 400 s; a 2-minute minor at 200 s expires at 320 s. The goal at 250 s ends the one with the
    // least time on the clock: the later-entered minor (320). The first-entered one (400) keeps running.
    const state = fold(
      cfgOf(),
      start,
      card("minor", A, { minutes: 5, at: at("P1", 100) }),
      card("minor", A, { at: at("P1", 200) }),
      goal(H, { at: at("P1", 250) }),
    );
    expect(state.suspensions.map((s) => s.expiresAt)).toEqual([at("P1", 400)]);
    // A tie on remaining time (both expire at 340 s) goes to the one entered first.
    const tie = fold(
      cfgOf(),
      start,
      card("minor", A, { minutes: 4, at: at("P1", 100) }),
      card("minor", A, { minutes: 2, at: at("P1", 220) }),
      goal(H, { at: at("P1", 250) }),
    );
    expect(tie.suspensions.map((s) => s.startedAt)).toEqual([at("P1", 220)]);
    // One goal ends one penalty: a second goal ends the second.
    const twoGoals = fold(
      cfgOf(),
      start,
      card("minor", A, { at: at("P1", 100) }),
      card("minor", A, { at: at("P1", 110) }),
      goal(H, { at: at("P1", 150) }),
      goal(H, { at: at("P1", 160) }),
    );
    expect(twoGoals.suspensions).toEqual([]);
  });

  it("IH-SU-1 for an own goal the conceding side is the side whose player struck it", () => {
    // A's player puts the puck into A's own net: H is credited, A conceded, so A's minor ends. H's minor (H did not concede) stays.
    const own = fold(
      cfgOf(),
      start,
      card("minor", A, { at: at("P1", 100) }),
      card("minor", H, { at: at("P1", 100) }),
      goal(A, { kind: "og", at: at("P1", 200) }),
    );
    expect(own.goals).toEqual({ home: 1, away: 0 });
    expect(own.suspensions.map((s) => s.side)).toEqual(["home"]);
    // The mirror image: H's own goal credits A and ends H's minor, not A's.
    const mirror = fold(
      cfgOf(),
      start,
      card("minor", A, { at: at("P1", 100) }),
      card("minor", H, { at: at("P1", 100) }),
      goal(H, { kind: "og", at: at("P1", 200) }),
    );
    expect(mirror.goals).toEqual({ home: 0, away: 1 });
    expect(mirror.suspensions.map((s) => s.side)).toEqual(["away"]);
    // Only the striker's side has a minor: an own goal by the OTHER side's player releases nothing (the striker's opponent did not concede).
    const opponentOnly = fold(cfgOf(), start, card("minor", A, { at: at("P1", 100) }), goal(H, { kind: "og", at: at("P1", 200) }));
    expect(opponentOnly.suspensions.length).toBe(1);
    const strikerOnly = fold(cfgOf(), start, card("minor", A, { at: at("P1", 100) }), goal(A, { kind: "og", at: at("P1", 200) }));
    expect(strikerOnly.suspensions).toEqual([]);
  });

  it("IH-SU-1 needs a game-time stamp on both the goal and the penalty; otherwise only the explicit release ends it", () => {
    const unstampedGoal = fold(cfgOf(), start, card("minor", A, { at: at("P1", 100) }), goal(H));
    expect(unstampedGoal.suspensions.length).toBe(1);
    const unstampedCard = fold(cfgOf(), start, card("minor", A), goal(H, { at: at("P1", 200) }));
    expect(unstampedCard.suspensions.length).toBe(1);
    // The explicit release still works on both, and after it nothing is left to release.
    expect(fold(cfgOf(), start, card("minor", A), goal(H), release("minor")).suspensions).toEqual([]);
    // A penalty entered at the very instant of the goal has served none of it: not released, whichever event came first.
    for (const order of ["card first", "goal first"] as const) {
      const specs: Spec[] = order === "card first" ? [card("minor", A, { at: at("P1", 220) }), goal(H, { at: at("P1", 220) })] : [goal(H, { at: at("P1", 220) }), card("minor", A, { at: at("P1", 220) })];
      expect(fold(cfgOf(), start, ...specs).suspensions.length, order).toBe(1);
    }
  });

  it("IH-SU-1 holds in the recreational variant (minors only) and a voided goal puts the penalty back", () => {
    const recreational = cfgOf(icehockey.variants.recreational);
    expect(Object.keys(recreational.suspensions?.classes ?? {}).sort()).toEqual(["bench_minor", "minor"]);
    expect(fold(recreational, start, card("minor", A, { at: at("P1", 100) }), goal(H, { at: at("P1", 200) })).suspensions).toEqual([]);
    // Undo is a void: the goal is voided, so the penalty it ended is running again.
    const undone = fold(cfgOf(), start, card("minor", A, { at: at("P1", 100) }), goal(H, { at: at("P1", 200) }), ["core.void", {}, "e-2"]);
    expect(undone.goals).toEqual({ home: 0, away: 0 });
    expect(undone.suspensions.length).toBe(1);
  });

  it("IH-SU-1 limit: a goal on a penalty shot, and a goal while both sides are serving minors, still release (IIHF 16.2 releases in neither case)", () => {
    // 16.2: "this rule does not apply when a goal is scored on a Penalty Shot"; coincidental minors leave neither side short-handed. The
    // engine reads the conceding side's running minor and the stamps, nothing else.
    const penaltyShot = fold(cfgOf(), start, card("minor", A, { at: at("P1", 100) }), goal(H, { kind: "ps", at: at("P1", 200) }));
    expect(penaltyShot.suspensions).toEqual([]);
    const coincidental = fold(
      cfgOf(),
      start,
      card("minor", A, { at: at("P1", 100) }),
      card("minor", H, { at: at("P1", 100) }),
      goal(H, { at: at("P1", 200) }),
    );
    expect(coincidental.suspensions.map((s) => s.side)).toEqual(["home"]);
  });

  it("IH-SU-1 limit: a double minor is never released by a goal (IIHF 18.2 washes one of its two minors out for a goal scored during the delay)", () => {
    const state = fold(cfgOf(), start, card("double_minor", A, { at: at("P1", 100) }), goal(H, { at: at("P1", 200) }));
    expect(state.suspensions.map((s) => s.classKey)).toEqual(["double_minor"]);
    // A plain minor beside it is the one the goal reaches.
    const beside = fold(cfgOf(), start, card("double_minor", A, { at: at("P1", 100) }), card("minor", A, { at: at("P1", 150) }), goal(H, { at: at("P1", 200) }));
    expect(beside.suspensions.map((s) => s.classKey)).toEqual(["double_minor"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// IH-ST-1 (M18, D15) - strength 5 with a floor of 3: IIHF Rule 26.1
// ---------------------------------------------------------------------------------------------------------------------

describe("IH-ST-1 ice hockey strength is five skaters with a floor of three: further penalties stack without reducing the team, nothing ends or warns, the organiser's abandon or a forfeit ends the match", () => {
  const minors = (n: number, by = A): Spec[] => Array.from({ length: n }, () => card("minor", by));

  it("IH-ST-1 the chip clamps at 3: one minor 5v4, two 5v3, three and more still 5v3", () => {
    // IIHF 26.1: the third penalised player is substituted to keep the on-ice strength at no less than three skaters.
    const expected = [["5v4", 1], ["5v3", 2], ["5v3", 3], ["5v3", 4], ["5v3", 5]] as const;
    let checked = 0;
    for (const [chip, n] of expected) {
      expect(chipOf(fold(cfgOf(), start, ...minors(n))), `${n} on away`).toBe(chip);
      const [short, full] = chip.split("v");
      expect(chipOf(fold(cfgOf(), start, ...minors(n, H))), `${n} on home`).toBe(`${full}v${short}`);
      checked++;
    }
    expect(checked).toBe(5);
    expect(chipOf(fold(cfgOf(), start, ...minors(4, A), ...minors(4, H)))).toBe("3v3");
    // The empty case: no penalty, no chip.
    expect(chipOf(fold(cfgOf(), start))).toBeNull();
  });

  it("IH-ST-1 declares strength base 5, minimum 3 in the default and the recreational variant", () => {
    expect(cfgOf().strength).toEqual({ base: 5, min: 3 });
    expect(cfgOf(icehockey.variants.recreational).strength).toEqual({ base: 5, min: 3 });
  });

  it("IH-ST-1 a misconduct does not reduce the team at all: the player sits and the team stays at five", () => {
    expect(chipOf(fold(cfgOf(), start, card("misconduct"), card("game_misconduct")))).toBeNull();
    // A major does (IIHF 20.2: short-handed).
    expect(chipOf(fold(cfgOf(), start, card("major")))).toBe("5v4");
  });

  it("IH-ST-1 every stacked penalty stays on the state: the floor clamps the count, it consumes nothing", () => {
    const four = fold(cfgOf(), start, ...minors(4));
    expect(four.suspensions.length).toBe(4);
    // Releasing down from four: three and two left still read 5v3, only the last one left is a 5v4.
    const afterReleases = (n: number) => chipOf(fold(cfgOf(), start, ...minors(4), ...Array.from({ length: n }, () => release("minor"))));
    expect([afterReleases(1), afterReleases(2), afterReleases(3)]).toEqual(["5v3", "5v3", "5v4"]);
  });

  it("IH-ST-1 limit: stacked penalties run their clocks together, where IIHF 26.1 starts a third penalty only when one of the first two has elapsed", () => {
    const state = fold(cfgOf(), start, card("minor", A, { at: at("P1", 100) }), card("minor", A, { at: at("P1", 100) }), card("minor", A, { at: at("P1", 100) }));
    expect(state.suspensions.map((s) => s.expiresAt)).toEqual([at("P1", 220), at("P1", 220), at("P1", 220)]);
  });

  it("IH-ST-1 the engine ends nothing and warns of nothing when a team is at or below the floor", () => {
    const state = fold(cfgOf(), start, goal(H), ...minors(6));
    expect(state.outcome).toBeNull();
    expect(state.phase).toBe("P1");
    const played = fold(cfgOf(), start, goal(H), ...minors(6), goal(A), ["icehockey.period.advance", { to: "P2" }]);
    expect(played.phase).toBe("P2");
    expect(played.goals).toEqual({ home: 1, away: 1 });
    const detail = icehockey.summary(state).detail as Record<string, unknown>;
    expect(Object.keys(detail)).toContain("strength");
    expect(Object.keys(detail).filter((key) => /warn|alert|insufficient|below|cannot|forfeit/i.test(key))).toEqual([]);
  });

  it("IH-ST-1 the organiser's abandon (under the stage's award policy) or a retirement forfeit ends a match a team cannot continue", () => {
    const effective = (cfg: PeriodCfg, ...specs: Spec[]) => {
      const folded = foldMatchWithStoppage(icehockey, cfg, lineups, stream(...specs), STRICT);
      return { outcome: outcomeOf(icehockey, folded), state: folded.state };
    };
    const cannotContinue: Spec[] = [start, goal(H), ...minors(6)];
    expect(effective(cfgOf({ abandonPolicy: "award" }), ...cannotContinue, ["core.abandon", { reason: "too few skaters" }]).outcome).toEqual({
      kind: "win",
      winner: H,
      loser: A,
      method: "abandoned",
    });
    const replay = effective(cfgOf(), ...cannotContinue, ["core.abandon", { reason: "too few skaters" }]);
    expect(replay.outcome).toBeNull();
    expect(replay.state.replayFlagged).toBe(true);
    expect(codeOf(() => fold(cfgOf(), ...cannotContinue, ["core.abandon", { reason: "too few skaters" }], goal(H)))).toBe("WRONG_PHASE");
    expect(effective(cfgOf(), ...cannotContinue, ["core.forfeit", { by: A, reason: "retired" }]).outcome).toEqual({
      kind: "award",
      winner: H,
      loser: A,
      reason: "retired",
    });
  });
});
