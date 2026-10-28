// W2e Task 16 (rows TN-SE-2, TN-RO-1): tennis's point and game penalties stay entered as the point or the game award they are,
// and its interruptions are records. Every describe/it title carries its row id as a whole token
// (packages/engine/test/rules-reference.ts reads them).
//
// Expected values come from the rulebook and the rule rows, never from the code under test:
//  - ITF Rules of Tennis, Rule 5 (scoring in a game: the fourth point, two clear, wins the game) and Rule 6 (a set is first to six
//    games, a tie-break at 6-all): what one more point or one more game does to a score is read off those;
//  - ITF Code of Conduct: a point penalty concedes ONE point, a game penalty concedes ONE game;
//  - the rows' own text (rules/tennis.md): the sanction event alone moves no score; interruptions are recorded and flagged.
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`) unless a test names a narrower strict point: the write path.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { expectSanctionMovesNoScore, sanctionEventTypeOf, sanctionLevelsOf } from "../../testkit/sanction-score.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { NestedCfg, NestedState } from "../nested/kernel.ts";
import { tennis } from "./tennis.ts";

const lineups: LineupPair = defaultLineupPair(tennis.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

type Spec = [type: string, payload?: unknown, voids?: string];
const START: Spec = ["core.start"];
const stream = (specs: readonly Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const cfgOf = (extra?: Record<string, unknown>): NestedCfg => tennis.configSchema.parse(extra ?? {});

/** Strict from `strictFromSeq` on (the default: every event, the write path's shape for a ledger built in one go). */
const fold = (cfg: NestedCfg, specs: readonly Spec[], strictFromSeq = 0): NestedState =>
  foldMatch(tennis, cfg, lineups, stream(specs), { strictFromSeq });

/** One `tennis.point` per winner, in order. */
const points = (...by: string[]): Spec[] => by.map((b): Spec => ["tennis.point", { by: b }]);
/** A whole game to `by` from love: four points. */
const game = (by: string): Spec[] => points(by, by, by, by);
const sanction = (by: string, level: string): Spec => ["tennis.sanction", { by, level }];

/** The code of the EngineError a fold throws, or null when it folds. Anything else rethrows. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

/** Everything a score is read from: the headline and per-side lines, the sets, the games of the set in play, the game's points and the outcome. */
function scoreView(state: NestedState): unknown {
  const summary = tennis.summary(state);
  return { headline: summary.headline, perSide: summary.perSide, sets: state.sets, games: state.games, points: state.points, outcome: tennis.outcome(state) };
}

const FRESH_GAME = { kind: "standard", home: 0, away: 0, advantage: null } as const;

// ---------------------------------------------------------------------------------------------------------------------
// TN-SE-2 (A4, A5) - point and game penalties stay entered as a point or a game award
// ---------------------------------------------------------------------------------------------------------------------

describe("TN-SE-2 a tennis point penalty or game penalty stays entered as a point or a tennis.game.award, and the sanction event alone moves no score", () => {
  const cfg = cfgOf();

  it("TN-SE-2 a point penalty concedes one point: the sanction leaves the game as it was, the point then entered closes it at game point", () => {
    // H leads 40-0 (three points). A point penalty against A concedes the fourth to H: the game, with two clear.
    const base = [START, ...points(H, H, H)];
    const before = fold(cfg, base);
    expect(before.points).toEqual({ kind: "standard", home: 3, away: 0, advantage: null });
    const sanctioned = fold(cfg, [...base, sanction(A, "point_penalty")]);
    expect(scoreView(sanctioned), "the sanction alone").toEqual(scoreView(before));
    expect(sanctioned.games).toEqual({ home: 0, away: 0 });

    const awarded = fold(cfg, [...base, sanction(A, "point_penalty"), ...points(H)], base.length);
    expect(awarded.games).toEqual({ home: 1, away: 0 });
    expect(awarded.points).toEqual(FRESH_GAME);
  });

  it("TN-SE-2 the point counts once: a second penalty adds none, and a point entered before the sanction is the same as one entered after", () => {
    // 30-30; a point penalty against H concedes A one point: 30-40, not 30-all and not a game.
    const base = [START, ...points(H, A, H, A)];
    const after = fold(cfg, [...base, sanction(H, "point_penalty"), sanction(H, "point_penalty"), ...points(A)]);
    expect(after.points).toEqual({ kind: "standard", home: 2, away: 3, advantage: null });
    expect(after.games).toEqual({ home: 0, away: 0 });
    const pointFirst = fold(cfg, [...base, ...points(A), sanction(H, "point_penalty")]);
    expect(scoreView(pointFirst)).toEqual(scoreView(after));
  });

  it("TN-SE-2 a game penalty concedes one game: the sanction alone moves nothing, and the tennis.game.award that follows gives the opponent the game from the middle of one", () => {
    // Game 1 to H, then A leads 0-30 in game 2. A game penalty against H concedes game 2 to A.
    const base = [START, ...game(H), ...points(A, A)];
    const before = fold(cfg, base);
    expect(before.games).toEqual({ home: 1, away: 0 });
    expect(before.points).toEqual({ kind: "standard", home: 0, away: 2, advantage: null });
    const sanctioned = fold(cfg, [...base, sanction(H, "game_penalty")]);
    expect(scoreView(sanctioned), "the sanction alone").toEqual(scoreView(before));

    const awarded = fold(cfg, [...base, sanction(H, "game_penalty"), ["tennis.game.award", { winner: A }]], base.length + 1);
    expect(awarded.games).toEqual({ home: 1, away: 1 });
    expect(awarded.points).toEqual(FRESH_GAME);
    // A game is over, so the serve changes hands as it does after any game (Rule 13): game 1 was H's serve, game 2 was A's, game 3 is H's.
    expect(before.serving).toBe("away");
    expect(awarded.serving).toBe("home");
  });

  it("TN-SE-2 a game award is refused while a tie-break is played, and taken in the same match one game earlier", () => {
    // Alternate games to 6-all: the next game is the tie-break (Rule 6). The award is refused there, on the write path only.
    const toSixAll: Spec[] = [START, ...[0, 1, 2, 3, 4, 5].flatMap(() => [...game(H), ...game(A)])];
    const inTieBreak = fold(cfg, toSixAll);
    expect(inTieBreak.games).toEqual({ home: 6, away: 6 });
    expect(inTieBreak.points.kind).toBe("tiebreak");
    const award: Spec = ["tennis.game.award", { winner: A }];
    expect(codeOf(() => fold(cfg, [...toSixAll, award], toSixAll.length))).toBe("GAME_AWARD_DURING_TIEBREAK");
    // One game earlier (6-5, the 12th game not yet played) the same award is a game like any other.
    const fiveAll = toSixAll.slice(0, toSixAll.length - game(A).length);
    expect(fold(cfg, fiveAll).games).toEqual({ home: 6, away: 5 });
    expect(codeOf(() => fold(cfg, [...fiveAll, award], fiveAll.length))).toBeNull();
  });

  it("TN-SE-2 a sanction at every level the payload takes moves no score, over every declared config and walk", () => {
    const levels = sanctionLevelsOf(tennis);
    expect(levels).toEqual(["warning", "point_penalty", "game_penalty", "default"]);
    expect(sanctionEventTypeOf(tennis)).toBe("tennis.sanction");
    let checked = 0;
    for (const level of levels) {
      const states = expectSanctionMovesNoScore(tennis, level);
      expect(states, level).toBeGreaterThan(0);
      checked += states;
    }
    expect(checked).toBeGreaterThan(levels.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// TN-RO-1 (M4) - interruptions are recorded and flagged; record-only
// ---------------------------------------------------------------------------------------------------------------------

describe("TN-RO-1 tennis records interruptions - medical, toilet, heat and other breaks - flags those beyond the allowance, and none moves a score", () => {
  const interruption = (payload: Record<string, unknown>): Spec => ["tennis.interruption", payload];
  const KINDS = ["medical", "toilet", "heat", "other"] as const;
  const play = [START, ...points(H, H, A)];

  it("TN-RO-1 every kind is recorded with its side and the set it fell in, and the score is exactly what the same points give without it", () => {
    const control = fold(cfgOf(), play);
    let checked = 0;
    for (const kind of KINDS) {
      // Charged to a side, and unattributed (a rain delay is charged to nobody).
      for (const by of [A, undefined]) {
        const state = fold(cfgOf(), [...play, interruption({ kind, ...(by === undefined ? {} : { by }) })]);
        const recorded = state.interruptions ?? [];
        expect(recorded, `${kind} by ${by ?? "nobody"}`).toHaveLength(1);
        expect(recorded[0], `${kind} by ${by ?? "nobody"}`).toMatchObject({ kind, set: 1, ...(by === undefined ? {} : { by: "away" }) });
        expect(scoreView(state), `${kind} by ${by ?? "nobody"}`).toEqual(scoreView(control));
        // The record rides on the summary too, where the pad and the card read it.
        expect((tennis.summary(state).detail as { interruptions?: unknown }).interruptions).toEqual(recorded);
        checked++;
      }
    }
    expect(checked).toBe(KINDS.length * 2);
  });

  it("TN-RO-1 an interruption is recorded in live play only: refused before the first serve and once the match is decided", () => {
    expect(codeOf(() => fold(cfgOf(), [interruption({ kind: "heat" })]))).toBe("WRONG_PHASE");
    // Best of 3 sets of 6 games: H wins twelve games straight.
    const decided: Spec[] = [START, ...Array.from({ length: 12 }, () => game(H)).flat()];
    expect(tennis.outcome(fold(cfgOf(), decided))).toMatchObject({ kind: "win", winner: H });
    expect(codeOf(() => fold(cfgOf(), [...decided, interruption({ kind: "heat" })]))).toBe("ALREADY_DECIDED");
  });

  it("TN-RO-1 beyond the allowance a break is flagged overCount or overran and still recorded, per side and per set, and play goes on", () => {
    const allowed = cfgOf({ interruptions: { medical: { count: 1, seconds: 180 } } });
    const specs: Spec[] = [
      ...play,
      interruption({ kind: "medical", by: H, duration: 120 }), // within both limits
      interruption({ kind: "medical", by: H, duration: 200 }), // the second for H in this set, and over 180 s
      interruption({ kind: "medical", by: A, duration: 60 }), // A's first: the count is per side
      interruption({ kind: "toilet", by: H, duration: 9999 }), // no allowance declared for toilet breaks
    ];
    const state = fold(allowed, specs);
    expect((state.interruptions ?? []).map(({ kind, by, overCount, overran }) => ({ kind, by, overCount, overran }))).toEqual([
      { kind: "medical", by: "home", overCount: undefined, overran: undefined },
      { kind: "medical", by: "home", overCount: true, overran: true },
      { kind: "medical", by: "away", overCount: undefined, overran: undefined },
      { kind: "toilet", by: "home", overCount: undefined, overran: undefined },
    ]);
    // Recorded, not refused, and the score did not move: the next point lands where it would have.
    const resumed = fold(allowed, [...specs, ...points(A)]);
    expect(scoreView(resumed)).toEqual(scoreView(fold(allowed, [...play, ...points(A)])));

    // The count is per set: once set 1 is banked, H's next medical break is within the allowance again.
    const nextSet = fold(allowed, [START, interruption({ kind: "medical", by: H }), ["tennis.set_summary", { home: 6, away: 0 }], interruption({ kind: "medical", by: H })]);
    expect((nextSet.interruptions ?? []).map(({ set, overCount }) => ({ set, overCount }))).toEqual([
      { set: 1, overCount: undefined },
      { set: 2, overCount: undefined },
    ]);
  });

  it("TN-RO-1 an allowance lowered after the breaks were recorded re-flags them and never makes the ledger unreadable", () => {
    const ledger: Spec[] = [...play, interruption({ kind: "medical", by: H, duration: 120 }), interruption({ kind: "heat", by: A, duration: 300 })];
    const lenient = cfgOf({ interruptions: { medical: { count: 5, seconds: 600 }, heat: { count: 5, seconds: 600 } } });
    const strictest = cfgOf({ interruptions: { medical: { count: 0, seconds: 1 }, heat: { count: 0, seconds: 1 } } });
    const flagsOf = (state: NestedState) => (state.interruptions ?? []).map(({ overCount, overran }) => ({ overCount, overran }));
    expect(flagsOf(fold(lenient, ledger))).toEqual([{ overCount: undefined, overran: undefined }, { overCount: undefined, overran: undefined }]);
    // The same ledger under the tightest allowance folds - strict from the first event, and as a replay - and both breaks are now flagged.
    for (const strictFromSeq of [0, Number.MAX_SAFE_INTEGER]) {
      expect(flagsOf(fold(strictest, ledger, strictFromSeq)), `strictFromSeq ${strictFromSeq}`).toEqual([
        { overCount: true, overran: true },
        { overCount: true, overran: true },
      ]);
    }
  });

  it("TN-RO-1 only a malformed interruption is refused: a player named without a side, and a stamp in a set not yet reached", () => {
    expect(codeOf(() => fold(cfgOf(), [...play, interruption({ kind: "medical", person: "H-p1" })]))).toBe("INVALID_EVENT");
    // Named with a side it is taken (the contrast).
    expect(codeOf(() => fold(cfgOf(), [...play, interruption({ kind: "medical", by: H, person: "H-p1" })]))).toBeNull();
    // Set 1 is being played: a stamp in S3 runs ahead of play. Refused on the write path, replayed as recorded.
    const ahead = interruption({ kind: "heat", by: H, at: { period: "S3", elapsed: 60 } });
    expect(codeOf(() => fold(cfgOf(), [...play, ahead]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold(cfgOf(), [...play, ahead], Number.MAX_SAFE_INTEGER))).toBeNull();
    // A stamp in the set being played is taken.
    expect(codeOf(() => fold(cfgOf(), [...play, interruption({ kind: "heat", by: H, at: { period: "S1", elapsed: 60 } })]))).toBeNull();
  });
});
