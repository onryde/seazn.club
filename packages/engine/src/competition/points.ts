// Custom competition points (Jul3/05 §2; W2d spec §5.3), carry-over openings (§3), and manual rank locks (§4). Pure:
// rules are config, evaluated per decided fixture over the pair a SportModule.standingsDelta already returns.
// Fractional/negative points are legal (Jul3/09).
import { z } from "zod";
import type { EntrantId, ForfeitAward, MatchOutcome, MetricSpec, StageKind, StandingsDelta } from "../core/types.ts";
import { EngineError } from "../core/errors.ts";
import { awardReasonOf } from "../sport/forfeit-credit.ts";
import type { AnySportModule, AwardScoreKeys, DecidedIn, MatchPointsBounds } from "../sport/module.ts";
import { DECIDED_IN } from "./decided-in.ts";
import { DEFAULT_BALLS_PER_OVER, overLengthOf, type TableLayout } from "./display.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { AGAINST_KEYS, DIFF_KEYS, FOR_KEYS } from "./tiebreakers.ts";

// Jul3/05 §2 — the bonus vocabulary, unchanged by W2d (spec §5.3 "the `when` enum unchanged").
const Bonus = z.object({
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
});
const ForfeitRow = z.object({
  winnerPoints: z.number(),
  loserPoints: z.number(),
  awardScore: z.tuple([z.number(), z.number()]).optional(), // 20 Jan
});
import { SET_SCORE_KEY } from "../sport/module.ts"; // `bySetScore`'s key (SC-S9): defined there, off competition/, for the
export { SET_SCORE_KEY }; // set kernel, which may not value-import competition/ (the phone closure; sport/module.ts).

/**
 * W2d (spec §5.3, D4, B2, D6, D10) — a stage's points rule, keyed by outcome: a win and a loss by how the match was
 * decided (regulation, overtime, shoot-out; `decidedIn`), a loss not played (D6), a draw, cricket's tie and no result, and
 * a set sport's payout by set score. An absent `draw` or `tie` means the rule covers none (`coverage` refuses it where one
 * is reachable); an absent `ot`/`so` falls back so → ot → regulation; an absent `noResult` pays 0 (D14); an absent
 * `soBonus` pays 1 (B2). `unit` is display only ("half": the stored numbers are half-points, shown "1½"). Replaces the
 * W2c `{base, bonuses, forfeit}` shape (greenfield, no shim: the W2d migration converts every stored old shape, and
 * `parseStoredPointsRule` reads this shape alone — W2d T9, PS-9f).
 */
export const PointsRule = z
  .object({
    win: z.object({ regulation: z.number(), ot: z.number().optional(), so: z.number().optional() }),
    loss: z.object({
      regulation: z.number(),
      ot: z.number().optional(),
      so: z.number().optional(),
      unplayed: z.number().optional(),
    }),
    draw: z.number().optional(),
    soBonus: z.number().optional(),
    shootoutAs: z.enum(["draw_plus_bonus", "result"]),
    tie: z.number().optional(),
    noResult: z.number().optional(),
    bySetScore: z.record(z.string().regex(SET_SCORE_KEY), z.tuple([z.number(), z.number()])).optional(),
    unit: z.enum(["whole", "half"]),
    bonuses: z.array(Bonus).default([]),
    forfeit: ForfeitRow.optional(),
  })
  // Assumptions are guards: a field the rule's shoot-out booking can never pay is refused, never silently ignored.
  .superRefine((rule, ctx) => {
    if (rule.shootoutAs === "draw_plus_bonus") {
      for (const side of ["win", "loss"] as const) {
        if (rule[side].so !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [side, "so"],
            message: "a draw-plus-bonus shoot-out is booked as a draw plus `soBonus`: it pays no `so` split",
          });
        }
      }
    } else if (rule.soBonus !== undefined) {
      ctx.addIssue({ code: "custom", path: ["soBonus"], message: "a shoot-out booked as a result pays `win.so`/`loss.so`, never `soBonus`" });
    }
    if (rule.bySetScore !== undefined && Object.keys(rule.bySetScore).length === 0) {
      ctx.addIssue({ code: "custom", path: ["bySetScore"], message: "a set-score map pays at least one score (absent: the win and loss pay every score)" });
    }
  })
  // The published example (api-v1 reuses this schema): a rule the schema takes — IIHF's 3/2/1/0 (spec §5.10) and a
  // walkover row. The generator's own pick would combine `so` with `draw_plus_bonus`, which the refinement above refuses.
  .meta({
    examples: [
      {
        win: { regulation: 3, ot: 2 },
        loss: { regulation: 0, ot: 1 },
        shootoutAs: "result",
        unit: "whole",
        bonuses: [],
        forfeit: { winnerPoints: 3, loserPoints: 0 },
      },
    ],
  });
export type PointsRule = z.infer<typeof PointsRule>;

/** One outcome a stage can produce, as its points rule names it (spec §5.3 "Reachable outcomes"). `set:W-L` is a set
 *  sport's final set score. */
export type OutcomeKey =
  | `win.${DecidedIn}`
  | `loss.${DecidedIn}`
  | "loss.unplayed"
  | "draw"
  | "tie"
  | "noResult"
  | `set:${number}-${number}`;

type LevelKind = Extract<MatchOutcome["kind"], "draw" | "tie" | "no_result">;
type LevelKey = Extract<OutcomeKey, "draw" | "tie" | "noResult">;
/**
 * THE one mapper between the two vocabularies: a stored outcome's kind (`MatchOutcome.kind`, `no_result`) and the
 * outcome key a rule, a sport's `reachableResultKinds` and `coverage` speak (`noResult`). A consumer holding an outcome
 * asks `reach.has(levelOutcomeKey(outcome.kind))`, never `reach.has(outcome.kind)` — which silently misses cricket's no
 * result.
 */
export function levelOutcomeKey(kind: LevelKind): LevelKey {
  return kind === "no_result" ? "noResult" : kind;
}

const MARGIN_KINDS = new Set(["loss_margin_lte", "win_margin_gte", "score_ratio_gte"]);

/** F11 (spec §5.3 step 7) — does a ledger name a match score under any of the sport's aliases: a difference
 *  (`DIFF_KEYS`), or a for/against pair (`FOR_KEYS`/`AGAINST_KEYS`, index for index)? */
function declaresScore(keys: ReadonlySet<string>): boolean {
  return DIFF_KEYS.some((k) => keys.has(k)) || FOR_KEYS.some((k, i) => keys.has(k) && keys.has(AGAINST_KEYS[i]!));
}

/** Jul3/05 §8: a rule referencing metrics the sport doesn't emit fails at stage-config time (fail closed — bad configs
 *  never reach play). F11: the margin and ratio bonuses read the sport's own score aliases (football's `gd`, cricket's
 *  `run_diff`), so a sport that keeps its score under any alias pair is accepted. */
export function validatePointsRule(rule: PointsRule, metrics: readonly MetricSpec[]): void {
  const keys = new Set(metrics.map((m) => m.key));
  const needsScores = rule.bonuses.some((b) => MARGIN_KINDS.has(b.when));
  if (needsScores && !declaresScore(keys)) {
    throw new EngineError(
      "CONFIG_INVALID",
      "points rule uses margin/ratio bonuses but the sport emits no score (a difference or a for/against pair)",
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
 *  - A bye is never one: nobody forfeited (it keeps the forfeit row's points, `payout`, but no award score).
 */
export function isUnplayedForfeit(outcome: MatchOutcome, played: boolean): boolean {
  if (isWalkover(outcome)) return true;
  if (played) return false;
  if (outcome.kind === "win") return outcome.method === "forfeit";
  return outcome.kind === "award" && !isBye(outcome);
}

/** F11 — the margin a delta's ledger records, read through the sport's score aliases (`gd`, `run_diff`, `diff`; else a
 *  for/against pair), never the literal generic keys alone. 0 where the ledger names no score. */
function marginOf(delta: StandingsDelta): number {
  const m = delta.metrics;
  for (const k of DIFF_KEYS) {
    const v = m[k];
    if (v !== undefined) return v;
  }
  const score = scoreOf(delta);
  return score === null ? 0 : score.for - score.against;
}

/** The first for/against alias pair a delta's ledger records both halves of (`FOR_KEYS`/`AGAINST_KEYS`), or null. */
function scoreOf(delta: StandingsDelta): { for: number; against: number } | null {
  for (const [i, k] of FOR_KEYS.entries()) {
    const f = delta.metrics[k];
    const a = delta.metrics[AGAINST_KEYS[i]!];
    if (f !== undefined && a !== undefined) return { for: f, against: a };
  }
  return null;
}

/** `forfeitRow`: the result the rule pays as a forfeit (`payout`) — an unplayed forfeit or a bye. Margin bonuses read a
 *  played score, so they skip it; the forfeit bonuses pay only it. An award AFTER play is not one: its margin bonuses
 *  read the real score the sport credited (owner Q9, "normal win/loss points + bonuses on real score"). `delta` is the
 *  side as the rule BOOKS it (a draw-plus-bonus shoot-out is drawn for both, B2). */
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
        const score = scoreOf(delta);
        if (delta.lost === 1 && !forfeitRow && score !== null && score.for >= (b.param ?? 0) * score.against) {
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

/** A rule refused at save (`coverage`) reaching the table anyway: never paid as a guess. */
function uncoveredOutcome(key: OutcomeKey): EngineError {
  return new EngineError("CONFIG_INVALID", `the points rule pays no "${key}" outcome (coverage refuses such a rule at save)`, { outcome: key });
}

/** SPEC §5.3 step 6 — a win or a loss decided in `d`, falling back so → ot → regulation (the chain the period kernel
 *  used before W2d, `period/kernel.ts`): D9's "an OT win pays a win unless a split is set". */
function byChain(side: { readonly regulation: number; readonly ot?: number; readonly so?: number }, d: DecidedIn): number {
  if (d === "so" && side.so !== undefined) return side.so;
  if (d !== "regulation" && side.ot !== undefined) return side.ot;
  return side.regulation;
}

/** A draw, a tie or a no result, as the rule pays it: `noResult` falls back to 0 (D14); `draw` and `tie` have no fallback. */
function levelPayout(rule: PointsRule, key: LevelKey): number {
  if (key === "noResult") return rule.noResult ?? 0;
  const value = rule[key];
  if (value === undefined) throw uncoveredOutcome(key);
  return value;
}

/**
 * W2d I2 — the sets a match of `cfg` is won on, for a sport whose table pays by set score: the winner's count every final
 * score its `reachableSetScores` declares shares (⌈bestOf/2⌉). `undefined` for a sport that keeps no set table. Callers
 * pass it to `payout` from the fixture's own cfg (the one its fold and `standingsDelta` read).
 */
export function setsToWinOf(module: AnySportModule, cfg: unknown): number | undefined {
  if (module.reachableSetScores === undefined) return undefined;
  const won = new Set(module.reachableSetScores(module.configSchema.parse(cfg)).map((s) => Number(s.split("-")[0])));
  if (won.size !== 1) {
    throw new EngineError("CONFIG_INVALID", `${module.key}'s final set scores name ${won.size} winning counts, not one`, { sport: module.key });
  }
  return [...won][0];
}

/**
 * The final set score of a decided set match, "W-L", read off the winner's own ledger (`sets_won`/`sets_lost`): the
 * played score, or the score an award credits. A match that ended before its last set — an abandon the table settles
 * (by lot, seed or the organiser, W2c X-AB-5), a pre-W2b walkover win, a bye — pays as FIVB 6.4.3 scores a team declared
 * incomplete (ruling I2): the winner is given the sets it needed (`setsToWin`), the other side keeps its own. So the key
 * is always `setsToWin-L`, a final score `reachableSetScores` declares.
 */
function setScoreOf(pair: FixtureResult, setsToWin: number | undefined): `${number}-${number}` {
  if (setsToWin === undefined) {
    throw new EngineError("CONFIG_INVALID", "the points rule pays by set score, but the sport keeps no set score (coverage refuses such a rule at save)", {
      entrants: pair.map((d) => d.entrantId),
    });
  }
  const winner = pair.find((d) => d.won === 1);
  const w = winner?.metrics.sets_won;
  const l = winner?.metrics.sets_lost;
  if (w === undefined || l === undefined) {
    throw new EngineError("CONFIG_INVALID", "the points rule pays by set score, but the result names no winner's set score", {
      entrants: pair.map((d) => d.entrantId),
    });
  }
  // Assumptions are guards: a winner holding the majority's worth of losses, or more sets than a match is won on, is no
  // result this format ends on — never completed into a guess.
  if (l >= setsToWin || w > setsToWin) {
    throw new EngineError("CONFIG_INVALID", `the winner's set score ${w}-${l} no match won on ${setsToWin} sets ends on`, {
      entrants: pair.map((d) => d.entrantId),
      setsToWin,
    });
  }
  return `${setsToWin}-${l}`;
}

/** SC-S9 — the pair a `bySetScore` map pays a set score: the exact "W-L" key, else "*". Neither is a rule `coverage`
 *  refuses at save. */
function setPairOf(map: Readonly<Record<string, readonly [number, number]>>, score: `${number}-${number}`): readonly [number, number] {
  const pair = Object.hasOwn(map, score) ? map[score] : Object.hasOwn(map, "*") ? map["*"] : undefined;
  if (pair === undefined) throw uncoveredOutcome(`set:${score}`);
  return pair;
}

/**
 * W2d (spec §5.3) — what one decided fixture pays each side under a stage's points rule, applied in SPEC §5.3's order:
 *  1. (an undecided fixture has no outcome and no pair: the caller never asks — `TableFixture.result` absent);
 *  2. a double walkover pays 0/0 and no bonus (X-DW-4);
 *  3. a no result pays `noResult` (absent ⇒ 0, D14) each;
 *  4. a tie pays `tie` each, a draw (a cricket two-innings draw too, D10(c)) `draw` each — a rule without the field
 *     throws CONFIG_INVALID (`coverage` refuses such a rule at save);
 *  5. an award, and a pre-W2b win by walkover or forfeit (`forfeitShaped`), BEFORE `decidedIn` is read:
 *     - a forfeit with nothing played (`isUnplayedForfeit`) or a bye pays the forfeit row when the rule sets one — the
 *       organiser's more specific row outranks `loss.unplayed` (X-PT-1); only the unplayed forfeit also takes the
 *       row's `awardScore` (a bye never does: nobody forfeited);
 *     - otherwise the winner is paid the win of its credited score (ruling 108: `win.regulation`, or its set score's
 *       pair; a bye's clean sweep) and the loser `loss.unplayed` where the rule declares one (amended 108, D6: table
 *       tennis) — never a bye's, which has no loser — else the loss of the credited score;
 *  6. a win decided in `decidedIn`: a set sport's `bySetScore` pair (exact "W-L", else "*"; a match ended before its
 *     last set is scored FIVB 6.4.3's way, `setsToWin` to the other side's sets — ruling I2); a shoot-out under
 *     `shootoutAs: "draw_plus_bonus"` (B2) books BOTH sides drawn, pays each `draw` and the shoot-out winner `soBonus`
 *     (absent ⇒ 1) on top — no `wins` for either; otherwise `win`/`loss` by the so → ot → regulation chain;
 *  7. the bonuses, read off the side as the rule booked it (margins through the sport's score aliases, F11).
 * Only `points` and, under B2, the W/D/L counts change; the ledger is the module's, plus the display metrics `won_ot`,
 * `won_so`, `lost_ot`, `lost_so` (1, written only when 1) on a win decided beyond regulation (spec §5.7), and — on a
 * forfeit with nothing played — the rule's configured award score, which REPLACES `for` / `against` / `diff` and the
 * sport's own score keys (`scoreKeys`, the module's `awardScoreKeys`: football's and the period sports' gf/ga/gd; W2c
 * X-PT-1 gap a), REQUIRED so no caller can leave it out — `undefined` where the module declares none.
 *
 * `decidedIn` is `decidedInFor(module, outcome)`: present exactly for a `win` (a guard — a mismatch is a caller's bug and
 * throws CONFIG_INVALID). `played` (W2c Task 9, owner P-3 "A") is the fixture's "was anything played" fact — W2b's
 * `playRecorded` over its ledger — read only for a forfeit-shaped outcome; REQUIRED, because a stored award carries no
 * played marker (review I7) and only the caller holds the ledger. An organiser's No result abandon (W2c D3,
 * `core.abandon{noResult: true}`) folds to NO outcome and never reaches this function (ruling PF-10). `setsToWin` is
 * `setsToWinOf(module, cfg)` over the fixture's own cfg, REQUIRED like `scoreKeys`: read only under a `bySetScore` map,
 * where `undefined` (a sport with no set table) throws CONFIG_INVALID, as `coverage` refuses it at save (I1).
 */
export function payout(
  outcome: MatchOutcome,
  decidedIn: DecidedIn | null,
  pair: FixtureResult,
  played: boolean,
  rule: PointsRule,
  scoreKeys: AwardScoreKeys | undefined,
  setsToWin: number | undefined,
): FixtureResult {
  if ((outcome.kind === "win") !== (decidedIn !== null)) {
    throw new EngineError("CONFIG_INVALID", `a ${outcome.kind} outcome ${decidedIn === null ? "needs" : "takes no"} decidedIn`, {
      kind: outcome.kind,
      decidedIn,
    });
  }
  const d: DecidedIn = decidedIn ?? "regulation";
  const forfeit = isUnplayedForfeit(outcome, played);
  const bye = isBye(outcome);
  // The rule's forfeit row pays an unplayed forfeit and a bye alike; only the award score tells them apart.
  const forfeitRow = forfeit || bye;
  const award = forfeitShaped(outcome);
  // `d` is "so" only for a win (the guard above); a forfeit-shaped win is an award whatever a caller passes.
  const shootoutDraw = !award && rule.bySetScore === undefined && d === "so" && rule.shootoutAs === "draw_plus_bonus";
  const setPair = (): readonly [number, number] => setPairOf(rule.bySetScore!, setScoreOf(pair, setsToWin));

  const sidePoints = (delta: StandingsDelta): number => {
    switch (outcome.kind) {
      case "double_walkover":
        return 0;
      case "draw":
      case "tie":
      case "no_result":
        return levelPayout(rule, levelOutcomeKey(outcome.kind));
      // a win or an award: below
    }
    if (forfeitRow && rule.forfeit !== undefined) {
      return delta.won === 1 ? rule.forfeit.winnerPoints : rule.forfeit.loserPoints;
    }
    if (award) {
      if (delta.won === 1) return rule.bySetScore === undefined ? rule.win.regulation : setPair()[0];
      if (delta.lost !== 1) return 0;
      if (!bye && rule.loss.unplayed !== undefined) return rule.loss.unplayed;
      return rule.bySetScore === undefined ? rule.loss.regulation : setPair()[1];
    }
    if (rule.bySetScore !== undefined) {
      return delta.won === 1 ? setPair()[0] : delta.lost === 1 ? setPair()[1] : 0;
    }
    if (shootoutDraw) {
      return levelPayout(rule, "draw") + (delta.won === 1 ? (rule.soBonus ?? 1) : 0);
    }
    return delta.won === 1 ? byChain(rule.win, d) : delta.lost === 1 ? byChain(rule.loss, d) : 0;
  };

  const mapped = pair.map((delta) => {
    // B2: a draw-plus-bonus shoot-out is a draw on the table — both sides drawn, neither a win nor a loss.
    const booked: StandingsDelta = shootoutDraw ? { ...delta, won: 0, drawn: 1, lost: 0 } : delta;
    const points = sidePoints(delta) + bonusesFor(booked, outcome, rule, forfeitRow);
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
    // Spec §5.7: the display fold of how a match was decided (IIHF's OTW/OTL read these), on the match's real winner and
    // loser, whatever the rule books them.
    if (outcome.kind === "win" && !award && d !== "regulation") {
      if (delta.won === 1) metrics[`won_${d}`] = 1;
      else if (delta.lost === 1) metrics[`lost_${d}`] = 1;
    }
    return { ...booked, points, metrics };
  }) as unknown as FixtureResult;
  return mapped;
}

/**
 * W2d (spec §5.3 "Reachable outcomes") — every outcome a stage of `stageKind` can produce under `cfg` (the stage's merged
 * format: the division's cfg with the stage's rules, or a fixture override's), read from the sport's own declarations:
 * a win and a loss for each `reachableDecidedIn`, `loss.unplayed` only where the sport declares a loss not played (D6,
 * table tennis; PS-7a), the level results of `reachableResultKinds`, and a set sport's `set:W-L` for every final score
 * its `bestOf` can end. `cfg` is parsed through the sport's `configSchema` (its defaults applied).
 */
export function reachableOutcomes(module: AnySportModule, cfg: unknown, stageKind: StageKind): ReadonlySet<OutcomeKey> {
  const parsed: unknown = module.configSchema.parse(cfg);
  const decided = module.reachableDecidedIn(parsed, stageKind);
  const level = module.reachableResultKinds(parsed, stageKind);
  const out = new Set<OutcomeKey>();
  for (const d of DECIDED_IN) {
    if (decided.has(d)) {
      out.add(`win.${d}`);
      out.add(`loss.${d}`);
    }
  }
  if (module.declaresUnplayedLoss === true) out.add("loss.unplayed");
  for (const k of ["draw", "tie", "noResult"] as const) if (level.has(k)) out.add(k);
  for (const score of module.reachableSetScores?.(parsed) ?? []) out.add(`set:${score}`);
  return out;
}

/**
 * W2d (spec §5.7; RBG §3.4, lines 343-344) — how a stage's table lays out its result columns under `rule`, over the
 * outcomes the stage can produce (`reachableOutcomes`). A decision beyond regulation is counted APART (IIHF's OTW/OTL,
 * "OT and GWS decisions both land in OTW/OTL") when the stage can reach it, the table books it a win (a draw-plus-bonus
 * shoot-out is a draw on the table, B2) and the rule pays it differently from a regulation result on either side
 * (`byChain`, the chain `payout` pays by): a split nobody is paid for is not a column (D9). A set-score map pays by set
 * score, never by decision. `unit` is the rule's own. `ballsPerOver` (W2e Task 8c, CK-BO-2) is the over length net run rate is
 * printed per, the competition's own (default: cricket's six-ball over); it is no part of the rule.
 */
export function tableLayoutOf(rule: PointsRule, reachable: Iterable<OutcomeKey>, ballsPerOver: number = DEFAULT_BALLS_PER_OVER): TableLayout {
  const reach = new Set(reachable);
  const apart = (["ot", "so"] as const).filter(
    (d) =>
      rule.bySetScore === undefined &&
      reach.has(`win.${d}`) &&
      !(d === "so" && rule.shootoutAs === "draw_plus_bonus") &&
      (byChain(rule.win, d) !== rule.win.regulation || byChain(rule.loss, d) !== rule.loss.regulation),
  );
  return { apart, unit: rule.unit, ballsPerOver: overLengthOf(ballsPerOver) };
}

/** A rule field a stage can never pay (I1): a `bySetScore` map where the sport keeps no set table. */
export type InapplicableField = "bySetScore";
export type Coverage =
  | { readonly ok: true }
  | { readonly ok: false; readonly uncovered: readonly OutcomeKey[]; readonly inapplicable: readonly InapplicableField[] };

/** How many DIFFERENT pairs a `bySetScore` map pays (spec §5.3 "the `*` guard"). */
const distinctPairs = (map: Readonly<Record<string, readonly [number, number]>>): number =>
  new Set(Object.values(map).map(([w, l]) => `${w}:${l}`)).size;

/**
 * W2d (spec §5.3, X-PT-3, D9, D10(a)) — does `rule` pay every outcome in `reachable`, directly or through a declared
 * fallback? Fallbacks: ot/so → regulation; unplayed → the credited score's loss; `noResult` → 0. `draw` and `tie` have
 * none. In a `draw_plus_bonus` rule a reachable shoot-out is a draw (B2), so it needs `draw` — named as `draw` in
 * `uncovered`. A `bySetScore` map that pays more than one distinct pair must name every reachable "W-L" itself; "*" does
 * not count toward that (D10(a), RBS:566). A map of one distinct pair with "*" is flat and covers every score; a rule
 * with no map pays every score its win/loss. The empty set is covered. `uncovered` lists each key once, in `reachable`'s
 * order. A map where the stage reaches results but no set score — a sport with no set table (football, tennis: no
 * `reachableSetScores`) — is `inapplicable: ["bySetScore"]` (I1): `payout` would throw on its first win. One question for
 * the stage save, the division save and the fixture override (spec §5.4).
 */
export function coverage(rule: PointsRule, reachable: ReadonlySet<OutcomeKey>): Coverage {
  const uncovered: OutcomeKey[] = [];
  const miss = (key: OutcomeKey): void => {
    if (!uncovered.includes(key)) uncovered.push(key);
  };
  const map = rule.bySetScore;
  const flat = map !== undefined && distinctPairs(map) <= 1 && Object.hasOwn(map, "*");
  let decided = false;
  let setScores = false;
  for (const key of reachable) {
    if (key === "draw" || key === "tie") {
      if (rule[key] === undefined) miss(key);
    } else if (key === "win.so" || key === "loss.so") {
      if (rule.shootoutAs === "draw_plus_bonus" && rule.draw === undefined) miss("draw");
    } else if (key.startsWith("set:")) {
      setScores = true;
      if (map !== undefined && !flat && !Object.hasOwn(map, key.slice("set:".length))) miss(key);
    }
    if (key.startsWith("win.")) decided = true;
  }
  const inapplicable: InapplicableField[] = map !== undefined && decided && !setScores ? ["bySetScore"] : [];
  return uncovered.length === 0 && inapplicable.length === 0 ? { ok: true } : { ok: false, uncovered, inapplicable };
}

/**
 * B1 — the W2c `{base, bonuses, forfeit}` shape, paid exactly as before W2d: `base` becomes `win.regulation` / `draw` /
 * `loss.regulation`; a tie and a no result pay 0 (old `applyPointsRule` paid 0 for both, its bonuses aside); a shoot-out
 * or an overtime win pays as a win (`shootoutAs: "result"` with no split); bonuses and the forfeit row are kept.
 */
export function legacyPointsRule(old: {
  base: { win: number; draw: number; loss: number };
  bonuses?: unknown[];
  forfeit?: unknown;
}): PointsRule {
  return PointsRule.parse({
    win: { regulation: old.base.win },
    loss: { regulation: old.base.loss },
    draw: old.base.draw,
    tie: 0,
    noResult: 0,
    shootoutAs: "result",
    unit: "whole",
    bonuses: old.bonuses ?? [],
    ...(old.forfeit === undefined ? {} : { forfeit: old.forfeit }),
  });
}

/** The W2c shape, as W2c's `PointsRule` read it (non-strict, bonuses default []): read only by `parseLegacyPointsRule`. */
const LegacyPointsRule = z.object({
  base: z.object({ win: z.number(), draw: z.number(), loss: z.number() }),
  bonuses: z.array(Bonus).default([]),
  forfeit: ForfeitRow.optional(),
});

/** B1's authority, and nothing else's: a stored W2c `{base, bonuses, forfeit}` rule exactly as W2c's reader took it,
 *  converted through `legacyPointsRule`; else null. The W2d migration's SQL twin (`w2d_legacy_points`) is held to it.
 *  NO read path calls it: the migration converts every stored row (W2d Task 7), and `parseStoredPointsRule` reads the
 *  outcome-keyed shape alone (Task 9, PS-9f). */
export function parseLegacyPointsRule(raw: unknown): PointsRule | null {
  const old = LegacyPointsRule.safeParse(raw);
  return old.success ? legacyPointsRule(old.data) : null;
}

/** Reads a stored `config.points` in the outcome-keyed shape; else null. Never throws: a fold and a table read it. The
 *  W2c shape is not read here any more (W2d Task 9): every stored row was converted by the W2d migration (Task 7), so an
 *  old-shape value is a rule nobody wrote since, read as none — as any value neither shape takes always was. */
export function parseStoredPointsRule(raw: unknown): PointsRule | null {
  const now = PointsRule.safeParse(raw);
  return now.success ? now.data : null;
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


// Standings qualification (spec 2026-09-22 §3.1, plan P1; W2d spec §5.3 "Bounds"): a stage PointsRule REPLACES the
// sport's points (`payout`), so its bounds replace the module's — over the outcomes the stage can REACH, so
// qualification's bounds come from the same rule the table pays. Bonuses are summed per outcome class — an
// over-approximation when two bonuses of one class exclude each other, which is safe (R3: cautious, never wrong).
//
// Which outcome each bonus can land on, as `bonusesFor` applies it. A Record over the zod enum, not a Set of strings
// (review fix 1): a new `when` kind is then a tsc error here until someone classifies it, instead of a bonus that
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

/**
 * The per-side bounds of what `payout` pays under `rule` over the `reachable` outcomes (spec §5.3), plus what every table
 * can always produce: an award (its winner the credited win or the forfeit row, its loser the credited loss, the loss not
 * played or the forfeit row) and a double walkover (0, no bonus). A draw-plus-bonus shoot-out (B2) is booked drawn for
 * both sides, so it takes the draw class's bonuses; its winner is still a match winner (`winFloor`) and its loser a match
 * loser (`lossCeil`). A tie may be booked drawn by a module (football, the period kernel, generic) and so takes the draw
 * class's bonuses too. A reachable outcome the rule does not cover pays nothing here (`payout` refuses it).
 */
export function pointsRuleBounds(rule: PointsRule, reachable: ReadonlySet<OutcomeKey>): MatchPointsBounds {
  const sum = (cls: BonusClass, sign: 1 | -1) =>
    rule.bonuses
      .filter((b) => BONUS_CLASS[b.when] === cls)
      .reduce((s, b) => s + (sign === 1 ? Math.max(0, b.points) : Math.min(0, b.points)), 0);
  const dpb = rule.shootoutAs === "draw_plus_bonus";
  const won: number[] = []; // booked won: the win class's bonuses
  const lost: number[] = []; // booked lost: the loss class's bonuses
  const drawn: number[] = []; // booked drawn (a draw, a tie): the draw class's bonuses
  const soWon: number[] = []; // B2: a shoot-out winner booked drawn
  const soLost: number[] = []; // B2: a shoot-out loser booked drawn
  const noResult: number[] = [];
  const map = rule.bySetScore;
  if (map === undefined) {
    won.push(rule.win.regulation); // an award's credited win
    lost.push(rule.loss.regulation); // an award's credited loss
    for (const d of DECIDED_IN) {
      if (d === "so" && dpb) {
        if ((reachable.has("win.so") || reachable.has("loss.so")) && rule.draw !== undefined) {
          soWon.push(rule.draw + (rule.soBonus ?? 1));
          soLost.push(rule.draw);
        }
        continue;
      }
      if (reachable.has(`win.${d}`)) won.push(byChain(rule.win, d));
      if (reachable.has(`loss.${d}`)) lost.push(byChain(rule.loss, d));
    }
  } else {
    // A set sport pays every result, an award's credited score included, the pair of its set score.
    const paid = [...reachable].flatMap((k) => {
      if (!k.startsWith("set:")) return [];
      const score = k.slice("set:".length);
      const pair = Object.hasOwn(map, score) ? map[score] : map["*"];
      return pair === undefined ? [] : [pair];
    });
    for (const [w, l] of paid.length > 0 ? paid : Object.values(map)) {
      won.push(w);
      lost.push(l);
    }
  }
  if (rule.loss.unplayed !== undefined && reachable.has("loss.unplayed")) lost.push(rule.loss.unplayed);
  if (rule.forfeit !== undefined) {
    won.push(rule.forfeit.winnerPoints);
    lost.push(rule.forfeit.loserPoints);
  }
  if (rule.draw !== undefined && reachable.has("draw")) drawn.push(rule.draw);
  if (rule.tie !== undefined && reachable.has("tie")) drawn.push(rule.tie);
  if (reachable.has("noResult")) noResult.push(rule.noResult ?? 0);

  const plus = (vs: readonly number[], cls: BonusClass, sign: 1 | -1) => vs.map((v) => v + sum(cls, sign));
  const winFloor = Math.min(...plus(won, "win", -1), ...plus(soWon, "draw", -1));
  // D14 (X-DW-4): a double walkover is a loss that pays 0 and no bonus, so a loss can always land on 0.
  const lossCeil = Math.max(...plus(lost, "loss", 1), ...plus(soLost, "draw", 1), 0);
  // Only wins pay, at one amount (MatchPointsBounds.winsOnly): a bonus that can pay anything makes some outcome pay
  // off-rate, so any one turns it off; a shoot-out booked drawn that pays is a points gain with no win.
  const winsOnly =
    rule.bonuses.every((b) => b.points === 0) &&
    won.every((v) => v === won[0]) &&
    won[0] !== 0 &&
    [...lost, ...drawn, ...soWon, ...soLost, ...noResult].every((v) => v === 0);
  return {
    max: Math.max(...plus(won, "win", 1), lossCeil, ...plus([...drawn, ...soWon], "draw", 1), ...plus(noResult, "no_result", 1)),
    min: Math.min(winFloor, ...plus(lost, "loss", -1), ...plus([...drawn, ...soLost], "draw", -1), ...plus(noResult, "no_result", -1), 0),
    winFloor,
    lossCeil,
    winsOnly,
  };
}
