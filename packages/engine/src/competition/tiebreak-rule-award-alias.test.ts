// The `for` / `diff` tie-breaks resolve through alias lists (tiebreakers.ts
// FOR_KEYS / DIFF_KEYS): each row reads the FIRST alias it records. A stage
// PointsRule that scores forfeits (`forfeit.awardScore`) writes the generic
// `for` / `against` / `diff` keys (points.ts `applyPointsRule`). In cricket the
// sport's own ledger is `runs_for` / `runs_against`, and it used to be listed
// AFTER `for` (with no `run_diff` at all) — so a cricket row that took a
// rule-scored walkover read the rule's award ALONE on `for`/`diff`, while its
// rival read real runs, or nothing. The two rows were compared on different
// ledgers. P1 (owner-approved, 2026-09-24): each list names the sport's alias
// before the generic one, and cricket records `run_diff`. On the old order
// this suite was 1/4; on the reorder alone 3/4 (`diff` still had no runs).
//
// Driven through the real producer: cricket's own `standingsDelta` for played
// matches and a real `core.forfeit` award, then the real `applyPointsRule`,
// `foldResults` and `rankStandings` — the same chain as the web's
// engine-db/competition.ts snapshot fold.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { EntrantId, LineupPair, StageCtx } from "../core/types.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { cricket, type CricketCfg } from "../sports/cricket/cricket.ts";
import { makeEnvelope } from "../testkit/helpers.ts";
import { applyPointsRule, PointsRule } from "./points.ts";
import { foldResults, type FixtureResult } from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

const t20: CricketCfg = cricket.configSchema.parse(cricket.variants.t20);
const league: StageCtx = { kind: "league" };

// A forfeit is worth 2 points and an organiser-configured 10–0 award score.
const RULE = PointsRule.parse({
  base: { win: 2, draw: 1, loss: 0 },
  forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [10, 0] },
});

function lineup(entrantId: EntrantId): LineupPair["home"] {
  return {
    entrantId,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${entrantId}-${i + 1}`,
      slot: "starting" as const,
      orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  };
}

function fixture(home: EntrantId, away: EntrantId, specs: Array<[string, unknown]>): FixtureResult {
  const events: EventEnvelope[] = specs.map(([type, payload], i) => makeEnvelope(i, { type, payload }));
  const state = foldMatch(cricket, t20, { home: lineup(home), away: lineup(away) }, events, { strictFromSeq: 0 });
  if (state.outcome === null) throw new Error(`${home} v ${away} did not finish`);
  const pair = cricket.standingsDelta(state.outcome, t20, league, state);
  return applyPointsRule(state.outcome, pair, RULE);
}

// Home bats first and wins; the chasing side is bowled out.
const played = (home: EntrantId, away: EntrantId, homeRuns: number, awayRuns: number): FixtureResult =>
  fixture(home, away, [
    ["core.start", {}],
    ["cricket.innings.summary", { runs: homeRuns, wickets: 4, legalBalls: 120 }],
    ["cricket.innings.summary", { runs: awayRuns, wickets: 10, legalBalls: 100 }],
  ]);

// `away` does not turn up: a real cricket award, no innings bowled.
const walkover = (home: EntrantId, away: EntrantId): FixtureResult =>
  fixture(home, away, [
    ["core.start", {}],
    ["core.forfeit", { by: away, reason: "no_show" }],
  ]);

const ENTRANTS = ["A", "B", "C", "D"];

// A: two real wins — 200 v 80 and 130 v 120: 330 runs for, 200 against (+130).
// B: one real win, 340 v 330 (+10), plus a walkover over D.
// C: two narrow real losses: 450 for, 470 against (−20).
// D: one heavy real loss (80 v 200, −120), plus the walkover it conceded.
// A and B finish on 4 points, C and D on 0, so the second key decides both.
const RESULTS: FixtureResult[] = [
  played("A", "D", 200, 80),
  played("A", "C", 130, 120),
  played("B", "C", 340, 330),
  walkover("B", "D"),
];

function rank(cascade: TiebreakerKey[]) {
  return rankStandings(foldResults(ENTRANTS, RESULTS), { cascade }).rows;
}

const order = (rows: { entrantId: EntrantId }[]) => rows.map((r) => r.entrantId);

describe("cricket: a stage rule's forfeit score does not replace a side's runs on the for/diff tie-breaks", () => {
  it("the scene: the walkover puts the rule's award on the generic keys, beside the real runs", () => {
    const rows = foldResults(ENTRANTS, RESULTS);
    const by = (id: string) => rows.find((r) => r.entrantId === id)!;
    expect(rows.map((r) => r.points)).toEqual([4, 4, 0, 0]);
    expect(by("A").metrics).toMatchObject({ runs_for: 330, runs_against: 200 });
    expect(by("C").metrics).toMatchObject({ runs_for: 450, runs_against: 470 });
    // The walkover adds nothing to B's or D's runs (cricket's award is a zero
    // ledger); the rule's 10–0 lands on the generic keys only.
    expect(by("B").metrics).toMatchObject({ runs_for: 340, runs_against: 330, for: 10, against: 0, diff: 10 });
    expect(by("D").metrics).toMatchObject({ runs_for: 80, runs_against: 200, for: 0, against: 10, diff: -10 });
    // Sides that never forfeited record no generic key at all.
    expect([by("A").metrics.for, by("A").metrics.diff, by("C").metrics.diff]).toEqual([undefined, undefined, undefined]);
  });

  it("[points, for]: B outscored A on runs (340 v 330), so B ranks first", () => {
    const rows = rank(["points", "for"]);
    // Live code reads B's `for` = 10 (the award alone) against A's 330 runs.
    expect(order(rows)).toEqual(["B", "A", "C", "D"]);
    expect(rows[0]?.tieBreak?.key).toBe("for");
  });

  it("[points, h2h_points, for]: the same when head-to-head cannot separate them (they never met)", () => {
    expect(order(rank(["points", "h2h_points", "for"]))).toEqual(["B", "A", "C", "D"]);
  });

  it("[points, diff]: A's run difference (+130) beats B's (+10), and C's (−20) beats D's (−120)", () => {
    // Live code: only B and D record a `diff` (the rule's ±10), and a recorded
    // value outranks an absent one — so D, the side that did not turn up,
    // ranks above C, and B above A.
    expect(order(rank(["points", "diff"]))).toEqual(["A", "B", "C", "D"]);
  });
});
