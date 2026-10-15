// Custom competition points (Jul3/05 §2), carry-over openings (§3), and
// manual rank locks (§4). Pure: rules are config, evaluated per decided
// fixture over the pair a SportModule.standingsDelta already returns — no
// sport-module changes. Fractional/negative points are legal (Jul3/09).
import { z } from "zod";
import type { EntrantId, ForfeitAward, MatchOutcome, MetricSpec, StandingsDelta } from "../core/types.ts";
import { EngineError } from "../core/errors.ts";
import { awardReasonOf } from "../sport/forfeit-credit.ts";
import type { AnySportModule, AwardScoreKeys, MatchPointsBounds } from "../sport/module.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";

// Jul3/05 §2 — declarative points rule (stages.config.points).
export const PointsRule = z.object({
  base: z.object({ win: z.number(), draw: z.number(), loss: z.number() }),
  bonuses: z
    .array(
      z.object({
        when: z.enum([
          "loss_margin_lte",
          "win_margin_gte",
          "score_ratio_gte",
          "draw",
          "forfeit_win",
          "forfeit_loss",
          "no_result",
        ]),
        param: z.number().optional(),
        points: z.number(),
      }),
    )
    .default([]),
  forfeit: z
    .object({
      winnerPoints: z.number(),
      loserPoints: z.number(),
      awardScore: z.tuple([z.number(), z.number()]).optional(), // 20 Jan
    })
    .optional(),
});
export type PointsRule = z.infer<typeof PointsRule>;

const MARGIN_KINDS = new Set(["loss_margin_lte", "win_margin_gte", "score_ratio_gte"]);

/** Jul3/05 §8: a rule referencing metrics the sport doesn't emit fails at
 *  stage-config time (fail closed — bad configs never reach play). */
export function validatePointsRule(rule: PointsRule, metrics: readonly MetricSpec[]): void {
  const keys = new Set(metrics.map((m) => m.key));
  const needsScores = rule.bonuses.some((b) => MARGIN_KINDS.has(b.when));
  if (needsScores && !(keys.has("for") && keys.has("against")) && !keys.has("diff")) {
    throw new EngineError(
      "CONFIG_INVALID",
      "points rule uses margin/ratio bonuses but the sport emits no for/against metrics",
      { metrics: [...keys] },
    );
  }
}

// ---------------------------------------------------------------------------
// W2c Task 9 (X-PT-1; owner Q9, P-3 "A") — which results a stage PointsRule pays as a forfeit.
// ---------------------------------------------------------------------------

/** A bye: the system's award nobody forfeited (`awardReasonOf` reads a typed or a pre-W2b stored award). */
const isBye = (outcome: MatchOutcome): boolean => outcome.kind === "award" && awardReasonOf(outcome) === "bye";

/** A walkover by its own reason: the side never arrived. An award whose reason is `walkover`, or a win whose method is. */
const isWalkover = (outcome: MatchOutcome): boolean =>
  outcome.kind === "award" ? awardReasonOf(outcome) === "walkover" : outcome.kind === "win" && outcome.method === "walkover";

/** The outcomes whose `played` fact matters: an award (a bye included), or a win by walkover/forfeit — chess's
 *  pre-W2b `boardgame.result{method: "forfeit"}` still decides a `win`, not an award. Callers load ledgers for exactly
 *  these (one query per stage), so a win by forfeit after a played game is read as played. */
export function forfeitShaped(outcome: MatchOutcome): boolean {
  return outcome.kind === "award" || (outcome.kind === "win" && (outcome.method === "walkover" || outcome.method === "forfeit"));
}

/**
 * P-3 "A": a forfeit under a stage PointsRule is an award with NOTHING PLAYED, whatever its reason; never a bye.
 *  - A walkover is nothing played by its own reason, whatever `played` reads (X-PT-1 lists "a walkover" unqualified;
 *    Q9 "only walkover reason = forfeit"). The one ledger where the two differ is chess's: its Start is play (ruling
 *    118, `startIsPlay`) and a no-show after it is still recorded as a walkover (FIDE 6.7.1) — the stats reader reads
 *    it as unplayed too (`forfeitStatsRole`, X-PS-1).
 *  - Any other forfeit — a withdrawal, a disqualification, a retirement, a pre-W2b chess win by forfeit — is one only
 *    while nothing is played (`played` false). After play it is a result (Q9: normal points).
 *  - A bye is never one: nobody forfeited (it keeps the forfeit row's points, `applyPointsRule`, but no award score).
 */
export function isUnplayedForfeit(outcome: MatchOutcome, played: boolean): boolean {
  if (isWalkover(outcome)) return true;
  if (played) return false;
  if (outcome.kind === "win") return outcome.method === "forfeit";
  return outcome.kind === "award" && !isBye(outcome);
}

function marginOf(delta: StandingsDelta): number {
  const m = delta.metrics;
  if (m.diff !== undefined) return m.diff;
  if (m.for !== undefined && m.against !== undefined) return m.for - m.against;
  return 0;
}

/** `forfeitRow`: the result the rule pays as a forfeit (`applyPointsRule`) — an unplayed forfeit or a bye. Margin bonuses
 *  read a played score, so they skip it; the forfeit bonuses pay only it. An award AFTER play is not one: its margin
 *  bonuses read the real score the sport credited (owner Q9, "normal win/loss points + bonuses on real score"). */
function bonusesFor(
  delta: StandingsDelta,
  outcome: MatchOutcome,
  rule: PointsRule,
  forfeitRow: boolean,
): number {
  // D14 (X-DW-4): a double walkover earns no bonus, `forfeit_loss` included — nobody forfeited TO anyone.
  if (outcome.kind === "double_walkover") return 0;
  let extra = 0;
  const margin = marginOf(delta);
  for (const b of rule.bonuses) {
    switch (b.when) {
      case "loss_margin_lte":
        if (delta.lost === 1 && !forfeitRow && -margin <= (b.param ?? 0)) extra += b.points;
        break;
      case "win_margin_gte":
        if (delta.won === 1 && !forfeitRow && margin >= (b.param ?? 0)) extra += b.points;
        break;
      case "score_ratio_gte": {
        // netball 26 Jan: losing side that scored ≥ param × the winner's score.
        // Cross-multiplied — never divide (spec 05 §4.3).
        const f = delta.metrics.for;
        const a = delta.metrics.against;
        if (
          delta.lost === 1 &&
          !forfeitRow &&
          f !== undefined &&
          a !== undefined &&
          f >= (b.param ?? 0) * a
        ) {
          extra += b.points;
        }
        break;
      }
      case "draw":
        if (delta.drawn === 1) extra += b.points;
        break;
      case "forfeit_win":
        if (forfeitRow && delta.won === 1) extra += b.points;
        break;
      case "forfeit_loss":
        if (forfeitRow && delta.lost === 1) extra += b.points;
        break;
      case "no_result":
        if (outcome.kind === "no_result") extra += b.points;
        break;
    }
  }
  return extra;
}

/**
 * Re-derive both sides' competition points from the rule (Jul3/05 §2). Only `points` changes — plus, on a forfeit with
 * nothing played, the rule's configured award score (never a fake score unless the organiser configured one, 20 Jan /
 * 8 Dec), which REPLACES `for` / `against` / `diff` (W2c X-PT-1, owner Q9) and, where the sport keeps its match score
 * under its own keys, those too: `scoreKeys` is the module's `awardScoreKeys` declaration (football's and the period
 * sports' `gf` / `ga` / `gd`; gap a, 2026-10-13), REQUIRED so no caller can leave it out — `undefined` where the module
 * declares none. Every other ledger key (`runs_for` — cricket is exempt, P1 2026-09-24, tiebreak-rule-award-alias.test.ts
 * — `sets_won`, …) is never touched: the credit stands beside the rule's score, out of the rule's reach
 * (`pointsRuleAwardReachesTable`).
 *
 * `played` (W2c Task 9, owner P-3 "A") is the fixture's "was anything played" fact — W2b's `playRecorded` over its
 * ledger under its sport module (rulings 112–115, 118, 120, 127). REQUIRED, so no caller can leave it out: a stored
 * award outcome carries no played marker (review I7), so only the caller, which holds the ledger, can say. It is read
 * only for a forfeit-shaped outcome (`forfeitShaped`). How the rule reads each outcome (X-PT-1):
 *  - a forfeit with nothing played (`isUnplayedForfeit`) pays the rule's forfeit row, its forfeit bonuses and its award
 *    score;
 *  - a bye pays the forfeit row and its forfeit bonuses (as before W2c) but never the award score: nobody forfeited;
 *  - an award after play is a result: base points, and the margin bonuses on the real score the sport credited (Q9);
 *  - a double walkover and a no result pay 0 (D14).
 */
export function applyPointsRule(
  outcome: MatchOutcome,
  pair: FixtureResult,
  rule: PointsRule,
  played: boolean,
  scoreKeys: AwardScoreKeys | undefined,
): FixtureResult {
  const forfeit = isUnplayedForfeit(outcome, played);
  // The rule's forfeit row pays an unplayed forfeit and a bye alike; only the award score tells them apart.
  const forfeitRow = forfeit || isBye(outcome);
  const mapped = pair.map((delta) => {
    let points: number;
    // D14 (X-DW-4): a double walkover is a 0-point loss for both, whatever the rule pays a loss or a forfeit loser.
    if (outcome.kind === "no_result" || outcome.kind === "double_walkover") {
      points = 0;
    } else if (forfeitRow && rule.forfeit !== undefined) {
      points = delta.won === 1 ? rule.forfeit.winnerPoints : rule.forfeit.loserPoints;
    } else if (delta.won === 1) {
      points = rule.base.win;
    } else if (delta.drawn === 1) {
      points = rule.base.draw;
    } else if (delta.lost === 1) {
      points = rule.base.loss;
    } else {
      points = 0;
    }
    points += bonusesFor(delta, outcome, rule, forfeitRow);
    const metrics = { ...delta.metrics };
    if (forfeit && rule.forfeit?.awardScore !== undefined) {
      const [w, l] = rule.forfeit.awardScore;
      const [mine, theirs] = delta.won === 1 ? [w, l] : [l, w];
      metrics.for = mine;
      metrics.against = theirs;
      metrics.diff = mine - theirs;
      if (scoreKeys !== undefined) {
        metrics[scoreKeys.for] = mine;
        metrics[scoreKeys.against] = theirs;
        metrics[scoreKeys.diff] = mine - theirs;
      }
    }
    return { ...delta, points, metrics };
  }) as unknown as FixtureResult;
  return mapped;
}

/**
 * W2c X-PT-1 (gap a) — does a stage PointsRule's `forfeit.awardScore` reach this sport's table? Only where the module
 * declares the keys it keeps its match score under (`awardScoreKeys`): there the award replaces the credit the
 * tie-breaks read. Elsewhere — the set sports, carrom, the board games, cricket — the rule's score lands only on the
 * generic `for` / `against` / `diff`, which those tables never rank by, so an editor offering a walkover score there would
 * offer a number that changes nothing: hide it or explain it (Tasks 13 / 18).
 */
export function pointsRuleAwardReachesTable(module_: Pick<AnySportModule, "awardScoreKeys">): boolean {
  return module_.awardScoreKeys !== undefined;
}

/**
 * W2c Task 16b (X-WO-1 part B) - what a stage PointsRule offers a fold of that stage's matches (`FoldOptions.forfeitAward`):
 * its `forfeit.awardScore`, winner first, as a COPY, and only where the award reaches the sport's table
 * (`pointsRuleAwardReachesTable`) - the one place the fold and the table agree on "does this rule award a score here".
 * The fold then applies it to a forfeit with nothing played alone (`unplayedForfeitEvent`, the event half of
 * `isUnplayedForfeit`). `undefined` for no rule, a rule with no forfeit row or no award, and a sport the award never reaches.
 * A 0-0 award is a score like any other (Task 9 fix round 2).
 */
export function forfeitAwardOffer(
  rule: Pick<PointsRule, "forfeit"> | null | undefined,
  module_: Pick<AnySportModule, "awardScoreKeys">,
): ForfeitAward | undefined {
  const award = rule?.forfeit?.awardScore;
  return award !== undefined && pointsRuleAwardReachesTable(module_) ? [award[0], award[1]] : undefined;
}

// ---------------------------------------------------------------------------
// Q1 (W2c spec item 10): what a stage PointsRule cannot express.
// ---------------------------------------------------------------------------

export type Expressible = { readonly ok: true } | { readonly ok: false; readonly keys: readonly string[]; readonly reason: string };

/** The `points` keys a stage PointsRule's `base` stands in for: the three-way result, under either spelling (generic
 *  writes w/d/l). Every other non-null key of a division's `points` pays a result the rule has no field for. */
const BASE_KEYS: ReadonlySet<string> = new Set(["win", "draw", "loss", "w", "d", "l"]);

/**
 * W2c Q1 (owner "A"): can a stage PointsRule (win/draw/loss + bonuses + a forfeit row) stand in for this division's own
 * points without dropping any of them? Refused — never silently dropped — where the division splits its points in a way
 * the rule cannot say (W2d widens PointsRule and lifts this):
 *  - a `points` key beyond the three-way result: ice hockey's `otWin`/`otLoss`, hockey's `shootoutWin`/`shootoutLoss`,
 *    cricket's `tie`/`noResult` (plan finding 29);
 *  - a set sport's `pointsMap` that pays more than one pair by set score (volleyball's FIVB 3-2 → 2:1 beside 3:0): the
 *    rule pays one pair per result. A map of one pair (badminton's `*` 2:0) is the rule's own win/loss.
 * The empty case first: no cfg, or one with neither key, is expressible.
 */
export function pointsRuleExpressible(divisionCfg: unknown): Expressible {
  const cfg = (typeof divisionCfg === "object" && divisionCfg !== null ? divisionCfg : {}) as {
    points?: Record<string, unknown> | null;
    pointsMap?: Record<string, unknown> | null;
  };
  const pts = cfg.points ?? {};
  const keys = Object.keys(pts).filter((k) => !BASE_KEYS.has(k) && pts[k] != null);
  const pairs = new Set(Object.values(cfg.pointsMap ?? {}).map((pair) => JSON.stringify(pair)));
  if (pairs.size > 1) keys.push("pointsMap");
  return keys.length === 0
    ? { ok: true }
    : { ok: false, keys, reason: `this division awards ${keys.join(", ")}, which a stage points rule cannot express yet` };
}

// ---------------------------------------------------------------------------
// Carry-over (Jul3/05 §3): a synthetic opening delta folded before new
// fixtures — carry-over is data, not new fold logic.
// ---------------------------------------------------------------------------

export type CarryMode = "none" | "points" | "full";

export function carryDeltas(
  rows: readonly StandingsRow[],
  mode: CarryMode,
): StandingsDelta[] {
  if (mode === "none") return [];
  return rows.map((row) =>
    mode === "points"
      ? {
          entrantId: row.entrantId,
          played: 0,
          won: 0,
          drawn: 0,
          lost: 0,
          points: row.points,
          metrics: {},
        }
      : {
          entrantId: row.entrantId,
          played: row.played,
          won: row.won,
          drawn: row.drawn,
          lost: row.lost,
          points: row.points,
          metrics: { ...row.metrics },
        },
  );
}

// ---------------------------------------------------------------------------
// Manual rank override (Jul3/05 §4): locked ranks are pinned; the cascade
// ranks only the unlocked remainder around them.
// ---------------------------------------------------------------------------

export interface RankLock {
  entrantId: EntrantId;
  rank: number;
}

export function applyRankLocks(
  ranked: readonly StandingsRow[],
  locks: readonly RankLock[],
): StandingsRow[] {
  if (locks.length === 0) return [...ranked];
  const lockByEntrant = new Map(locks.map((l) => [l.entrantId, l.rank]));
  const lockedRanks = new Set(locks.map((l) => l.rank));
  const n = ranked.length;
  const out: (StandingsRow | null)[] = Array.from({ length: n }, () => null);
  // pin the locked rows first
  for (const row of ranked) {
    const rank = lockByEntrant.get(row.entrantId);
    if (rank === undefined) continue;
    if (rank < 1 || rank > n || out[rank - 1] !== null) {
      throw new EngineError("CONFIG_INVALID", `rank override ${rank} is out of range or duplicated`, {
        entrantId: row.entrantId,
      });
    }
    out[rank - 1] = { ...row, rank, rankLocked: true };
  }
  // fill everyone else, cascade order preserved, into the free positions
  const free = Array.from({ length: n }, (_, i) => i + 1).filter((r) => !lockedRanks.has(r));
  let fi = 0;
  for (const row of ranked) {
    if (lockByEntrant.has(row.entrantId)) continue;
    const rank = free[fi++]!;
    out[rank - 1] = { ...row, rank };
  }
  return out as StandingsRow[];
}

// Standings qualification (spec 2026-09-22 §3.1, plan P1): a stage PointsRule
// REPLACES the sport's points (applyPointsRule), so its bounds replace the
// module's. Bonuses are summed per outcome class — an over-approximation when
// two bonuses of one class exclude each other, which is safe (R3: cautious,
// never wrong).
//
// Which outcome each bonus can land on, as `bonusesFor` applies it. A Record
// over the zod enum, not a Set of strings (review fix 1): a new `when` kind is
// then a tsc error here until someone classifies it, instead of a bonus that
// silently falls outside every bound.
type BonusWhen = PointsRule["bonuses"][number]["when"];
type BonusClass = "win" | "loss" | "draw" | "no_result";
const BONUS_CLASS: Record<BonusWhen, BonusClass> = {
  win_margin_gte: "win",
  forfeit_win: "win",
  loss_margin_lte: "loss",
  score_ratio_gte: "loss",
  forfeit_loss: "loss",
  draw: "draw",
  no_result: "no_result",
};

export function pointsRuleBounds(rule: PointsRule): MatchPointsBounds {
  const sum = (cls: BonusClass, sign: 1 | -1) =>
    rule.bonuses
      .filter((b) => BONUS_CLASS[b.when] === cls)
      .reduce((s, b) => s + (sign === 1 ? Math.max(0, b.points) : Math.min(0, b.points)), 0);
  const wins = [rule.base.win, ...(rule.forfeit ? [rule.forfeit.winnerPoints] : [])];
  const losses = [rule.base.loss, ...(rule.forfeit ? [rule.forfeit.loserPoints] : [])];
  const winFloor = Math.min(...wins) + sum("win", -1);
  // D14 (X-DW-4): a double walkover is a loss that pays 0 and no bonus, so a loss can always land on 0.
  const lossCeil = Math.max(Math.max(...losses) + sum("loss", 1), 0);
  // Only wins pay, at one amount (MatchPointsBounds.winsOnly): a bonus that
  // can pay anything makes some outcome pay off-rate, so any one turns it off.
  const winsOnly =
    rule.bonuses.every((b) => b.points === 0) &&
    wins.every((v) => v === rule.base.win) &&
    rule.base.win !== 0 &&
    [rule.base.draw, ...losses].every((v) => v === 0);
  return {
    max: Math.max(Math.max(...wins) + sum("win", 1), lossCeil, rule.base.draw + sum("draw", 1), sum("no_result", 1)),
    min: Math.min(winFloor, Math.min(...losses) + sum("loss", -1), rule.base.draw + sum("draw", -1), sum("no_result", -1)),
    winFloor,
    lossCeil,
    winsOnly,
  };
}
