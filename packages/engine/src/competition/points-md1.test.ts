// W2c Task 22 (MD-1, owner ruling 2026-10-11; W2c classifies competition/points.ts in FULL, ruling 2026-10-20): the tests
// that kill what Stryker left alive in points.ts, and the guards behind the points.ts mutants recorded as equivalent
// (stryker-equivalent.json).
//
// Expected values come from the rule's own fields (`base`, a bonus's `points`, a lock's `rank`), from what the rule says
// (Jul3/05 §2 bonuses, §3 carry-over, §4 rank locks, §8 "a rule referencing metrics the sport doesn't emit fails at
// stage-config time"; the netball 26 Jan golden, "the losing side that scored at least 50%"), and from each sport's
// DECLARED metrics. Never from `validatePointsRule`, `applyPointsRule`, `carryDeltas` or `applyRankLocks`.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { MatchOutcome, StandingsDelta } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { buildWalk, lineupFromCatalog } from "../testkit/helpers.ts";
import { applyPointsRule, applyRankLocks, carryDeltas, PointsRule, validatePointsRule, type RankLock } from "./points.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

/** The bonus kinds that read the match SCORE (Jul3/05 §2): a winning margin, a losing margin, and the loser's score as a
 *  share of the winner's (netball). Written from what each kind means; checked below against PointsRule's own list. */
const SCORE_READING: readonly string[] = ["loss_margin_lte", "win_margin_gte", "score_ratio_gte"];
const KINDS: readonly string[] = PointsRule.shape.bonuses.unwrap().element.shape.when.options;
const NOT_SCORE_READING = KINDS.filter((k) => !SCORE_READING.includes(k));
/** The generic score keys those bonuses read: `delta.metrics.for`, `.against` and `.diff`. */
const SCORE_KEYS = ["for", "against", "diff"] as const;

const declared = (m: AnySportModule): Set<string> => new Set(m.metrics.map((x) => x.key));
const declaresScore = (m: AnySportModule): boolean => SCORE_KEYS.every((k) => declared(m).has(k));
const ruleOf = (...kinds: string[]) =>
  PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, bonuses: kinds.map((when) => ({ when, param: 1, points: 1 })) });
/** A metric list by key alone: the one field `validatePointsRule` is about. */
const metricList = (...keys: string[]) => keys.map((key) => ({ key, label: key, direction: "desc" })) as never;
const codeOf = (fn: () => void): string | null => {
  try {
    fn();
  } catch (e) {
    return EngineError.is(e) ? e.code : `not an EngineError: ${String(e)}`;
  }
  return null;
};

describe("MD-1 points.ts: a bonus that reads the score fails closed where the sport emits none (Jul3/05 §8)", () => {
  it("premise: every sport declares the generic score keys for, against and diff all together or not at all", () => {
    // The guard behind the equivalents recorded for `validatePointsRule` and `marginOf` (stryker-equivalent.json,
    // points.ts:96:7 and 96:30): no sport declares one side of the score without the other.
    let all = 0;
    let none = 0;
    const visited = forEachSport(({ module: m }) => {
      const present = SCORE_KEYS.filter((k) => declared(m).has(k));
      expect([0, SCORE_KEYS.length], `${m.key} declares ${present.join(", ") || "none"}`).toContain(present.length);
      if (present.length === 0) none++;
      else all++;
    });
    expect(all, "sports that declare a score").toBeGreaterThan(0);
    expect(none, "sports that declare none").toBeGreaterThan(0);
    expect(all + none).toBe(visited);
  });

  it("a score-reading bonus is refused CONFIG_INVALID wherever the sport declares no score, alone and listed after one that reads none; every kind is taken where it declares one", () => {
    expect(SCORE_READING.filter((k) => KINDS.includes(k)), "the score-reading kinds are PointsRule's own").toEqual(SCORE_READING);
    expect(NOT_SCORE_READING.length, "the kinds that read no score").toBe(KINDS.length - SCORE_READING.length);
    const other = NOT_SCORE_READING[0]!;
    let refused = 0;
    let taken = 0;
    const visited = forEachSport(({ module: m }) => {
      const want = declaresScore(m) ? null : "CONFIG_INVALID";
      for (const kind of SCORE_READING) {
        expect(codeOf(() => validatePointsRule(ruleOf(kind), m.metrics)), `${kind} alone`).toBe(want);
        // ANY score-reading bonus in the list is enough: the rule cannot be paid as written.
        expect(codeOf(() => validatePointsRule(ruleOf(other, kind), m.metrics)), `${kind} after ${other}`).toBe(want);
        if (want === null) taken++;
        else refused++;
      }
      for (const kind of NOT_SCORE_READING) expect(codeOf(() => validatePointsRule(ruleOf(kind), m.metrics)), kind).toBeNull();
    });
    expect(refused, "refusals witnessed").toBeGreaterThan(0);
    expect(taken, "score-reading bonuses taken").toBeGreaterThan(0);
    expect(refused + taken).toBe(visited * SCORE_READING.length);
  });

  it("the score a margin needs is the difference: `diff`, or BOTH sides' scores - a list naming one side alone cannot feed it", () => {
    const rule = ruleOf("win_margin_gte");
    expect(codeOf(() => validatePointsRule(rule, metricList("for"))), "for alone").toBe("CONFIG_INVALID");
    expect(codeOf(() => validatePointsRule(rule, metricList("against"))), "against alone").toBe("CONFIG_INVALID");
    expect(codeOf(() => validatePointsRule(rule, metricList("diff"))), "diff alone").toBeNull();
    expect(codeOf(() => validatePointsRule(rule, metricList("for", "against"))), "both sides").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bonuses on a played result (Jul3/05 §2).
// ---------------------------------------------------------------------------

const WIN: MatchOutcome = { kind: "win", winner: "W", loser: "L" };
const PLAYED = true;
/** These deltas name their score under the generic keys themselves, so no further score keys are named. */
const NO_OWN_KEYS = undefined;
const side = (entrantId: string, won: number, drawn: number, lost: number, metrics: Record<string, number>): StandingsDelta => ({
  entrantId,
  played: 1,
  won,
  drawn,
  lost,
  points: 0,
  metrics,
});
const winPair = (winner: Record<string, number>, loser: Record<string, number>) =>
  [side("W", 1, 0, 0, winner), side("L", 0, 0, 1, loser)] as unknown as FixtureResult;
const pointsOf = (outcome: MatchOutcome, pair: FixtureResult, rule: PointsRule) =>
  applyPointsRule(outcome, pair, rule, PLAYED, NO_OWN_KEYS).map((d) => d.points);
const bonusRule = (when: string, param: number | undefined, points: number) =>
  PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, bonuses: [{ when, ...(param === undefined ? {} : { param }), points }] });

describe("MD-1 points.ts: the bonuses a played result earns", () => {
  it("a margin is the score difference: a delta's `diff` where it carries one, else its `for` minus its `against`", () => {
    // A win by 3, told three ways. The bonus is paid at param 3 (margin >= 3) and not at param 4.
    let checked = 0;
    for (const [shape, winner, loser] of [
      ["for/against, no diff", { for: 5, against: 2 }, { for: 2, against: 5 }],
      ["diff alone", { diff: 3 }, { diff: -3 }],
      ["all three", { for: 5, against: 2, diff: 3 }, { for: 2, against: 5, diff: -3 }],
    ] as const) {
      for (const [param, paid] of [[3, true], [4, false]] as const) {
        const rule = bonusRule("win_margin_gte", param, 1);
        const want = rule.base.win + (paid ? rule.bonuses[0]!.points : 0);
        expect(pointsOf(WIN, winPair(winner, loser), rule)[0], `${shape}, win_margin_gte ${param}`).toBe(want);
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("a draw bonus pays each side of a drawn result on top of the draw, and nothing to a decided one", () => {
    const rule = bonusRule("draw", undefined, 2);
    const drawn = [side("H", 0, 1, 0, { for: 1, against: 1, diff: 0 }), side("A", 0, 1, 0, { for: 1, against: 1, diff: 0 })] as unknown as FixtureResult;
    const each = rule.base.draw + rule.bonuses[0]!.points;
    expect(pointsOf({ kind: "draw" }, drawn, rule)).toEqual([each, each]);
    expect(pointsOf(WIN, winPair({ for: 2, against: 1, diff: 1 }, { for: 1, against: 2, diff: -1 }), rule)).toEqual([rule.base.win, rule.base.loss]);
  });

  it("the losing-side ratio bonus pays a loser that scored AT LEAST param x the winner's score - the boundary included (netball 26 Jan: '>= 50%')", () => {
    const rule = PointsRule.parse({ base: { win: 5, draw: 3, loss: 0 }, bonuses: [{ when: "score_ratio_gte", param: 0.5, points: 1 }] });
    const lost = (winnerScore: number, loserScore: number) =>
      pointsOf(WIN, winPair({ for: winnerScore, against: loserScore, diff: winnerScore - loserScore }, { for: loserScore, against: winnerScore, diff: loserScore - winnerScore }), rule)[1];
    expect(lost(12, 6), "exactly 50%").toBe(rule.base.loss + rule.bonuses[0]!.points);
    expect(lost(12, 5), "under 50%").toBe(rule.base.loss);
  });
});

// ---------------------------------------------------------------------------
// Carry-over (Jul3/05 §3) and rank locks (Jul3/05 §4).
// ---------------------------------------------------------------------------

const row = (entrantId: string, points: number): StandingsRow => ({
  entrantId,
  played: 3,
  won: 1,
  drawn: 0,
  lost: 2,
  points,
  metrics: { diff: points - 4 },
});

describe("MD-1 points.ts: carry-over and rank locks", () => {
  it("carry mode `none` carries nothing over; `points` and `full` each open one row per entrant", () => {
    const rows = [row("A", 9), row("B", 6)];
    expect(carryDeltas(rows, "none")).toEqual([]);
    expect(carryDeltas(rows, "points").map((d) => d.entrantId)).toEqual(["A", "B"]);
    expect(carryDeltas(rows, "full").map((d) => d.entrantId)).toEqual(["A", "B"]);
  });

  // The cascade: A, B, C, D by points.
  const ranked = () => rankStandings([row("A", 9), row("B", 6), row("C", 3), row("D", 1)], { cascade: ["points"] }).rows;

  it("the empty case: no lock leaves the cascade's table as it was", () => {
    const table = ranked();
    expect(table.map((r) => r.entrantId), "premise: the cascade's own order").toEqual(["A", "B", "C", "D"]);
    expect(applyRankLocks(table, [])).toStrictEqual(table);
  });

  it("a lock pins its row, rank 1 and the last rank included, and the unlocked rows fill the free ranks in cascade order", () => {
    // The cascade's LAST entrant locked to rank 1 and its FIRST to the last rank: D and A are pinned where the locks say,
    // and B and C, unlocked, take the free ranks 2 and 3 in the cascade's order.
    const locks: RankLock[] = [
      { entrantId: "D", rank: 1 },
      { entrantId: "A", rank: 4 },
    ];
    const out = applyRankLocks(ranked(), locks);
    expect(out.map((r) => [r.entrantId, r.rank, r.rankLocked === true])).toEqual([
      ["D", 1, true],
      ["B", 2, false],
      ["C", 3, false],
      ["A", 4, true],
    ]);
  });

  it("a lock outside 1..n or on a rank already taken is refused CONFIG_INVALID", () => {
    const n = ranked().length;
    let checked = 0;
    for (const [what, locks] of [
      ["rank 0", [{ entrantId: "A", rank: 0 }]],
      ["rank n + 1", [{ entrantId: "A", rank: n + 1 }]],
      ["a rank taken twice", [{ entrantId: "A", rank: 2 }, { entrantId: "B", rank: 2 }]],
    ] as const) {
      expect(codeOf(() => applyRankLocks(ranked(), locks)), what).toBe("CONFIG_INVALID");
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Premise for the `marginOf` equivalents (stryker-equivalent.json, points.ts:96:7 and 96:30).
// ---------------------------------------------------------------------------

describe("MD-1 points.ts: a sport that declares the score credits all of it on every delta a margin bonus can read", () => {
  it("each decided walk's deltas (a win, a draw, an award) carry for, against and diff, with diff = for - against", () => {
    // A margin bonus is taken only where the sport declares the score keys (above); there, a delta with no `diff` would
    // reach `marginOf`'s fallback. This holds the score sports to crediting all three, so it never does.
    let deltas = 0;
    let sports = 0;
    const kinds = new Set<string>();
    const visited = forEachSport(({ module: m }) => {
      if (!declaresScore(m)) return;
      sports++;
      for (const { cfg } of declaredCfgs(m)) {
        const lineups = { home: lineupFromCatalog(m.positions, "H"), away: lineupFromCatalog(m.positions, "A") };
        for (let seed = 1; seed <= 12; seed++) {
          const { states } = buildWalk(m, cfg, lineups, seed, 300);
          const state = states.at(-1);
          const outcome = state === undefined ? null : m.outcome(state);
          // A double walkover pays no bonus at all (D14) and a no result has no score to read.
          if (outcome === null || outcome.kind === "double_walkover" || outcome.kind === "no_result") continue;
          kinds.add(outcome.kind);
          for (const d of m.standingsDelta(outcome, cfg, { kind: "league" }, state)) {
            const { for: f, against: a, diff } = d.metrics;
            expect([typeof f, typeof a, typeof diff], `${m.key} seed ${seed} ${outcome.kind}`).toEqual(["number", "number", "number"]);
            expect(diff, `${m.key} seed ${seed} ${outcome.kind}`).toBe(f! - a!);
            deltas++;
          }
        }
      }
    });
    expect(sports, "sports that declare the score").toBeGreaterThan(0);
    expect(sports).toBeLessThanOrEqual(visited);
    expect(deltas, "deltas checked").toBeGreaterThan(0);
    // The title's three kinds, each walked: the award is the one the points.ts:96:7 equivalents lean on.
    expect([...kinds], `outcome kinds walked: ${[...kinds].join(", ")}`).toEqual(expect.arrayContaining(["win", "draw", "award"]));
  });
});
