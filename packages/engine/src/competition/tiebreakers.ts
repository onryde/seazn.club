// Swiss / cascade-time tiebreak computations — spec 05 §4 + engine/sports/
// chess.md §4 (PROMPT-07). Buchholz, Buchholz Cut-1 and Sonneborn-Berger depend
// on opponents' *final* scores, so they cannot be folded incrementally into a
// StandingsDelta — they are computed here, at rank time, from a ledger the
// competition engine assembles (opponent list + per-game score/result/colour
// the boardgame module exposes via standingsDelta).
//
// Everything is integer (spec 04 §9.4, PROMPT-07 acceptance — no floats):
// scores are HALF-POINTS (1 = 2, ½ = 1, 0 = 0). Buchholz keeps half-points;
// Sonneborn-Berger is returned in QUARTER-points (÷4 for the conventional
// value) because ½·(opponent score) is a quarter-point. Use pointsToText for
// display.
//
// The comparator *registry* (TiebreakerKey → comparator), h2h partition
// refinement and the ranking driver are in the second half of this file
// (PROMPT-08); the functions above are the cascade-time metrics those
// comparators call.
import { EngineError } from "../core/errors.ts";
import { shuffle } from "../core/rng.ts";
import type { EntrantId, StandingsDelta } from "../core/types.ts";
import type { PartialScheduleKey, TiebreakerKey } from "../sport/module.ts";
import { RATIO_LEDGERS, type RatioKey } from "./display.ts";
import {
  foldResults,
  resultsAmong,
  type FixtureResult,
  type StandingsRow,
  type TieBreakNote,
} from "./standings.ts";

export type Color = "W" | "B";
export type GameResult = "win" | "draw" | "loss";

// One game on an entrant's card, in round order.
export interface SwissGame {
  // The real opponent, or null for a bye (no opponent). `unplayed` games (byes,
  // forfeits, absences) use a FIDE virtual opponent for Buchholz/SB.
  opponent: EntrantId | null;
  result: GameResult;
  scored: number; // half-points earned in this game (win 2 / draw 1 / loss 0 / byeScore)
  color?: Color | null; // colour held; null/absent ⇒ excluded from colour history
  unplayed?: boolean;
}

export interface SwissRow {
  entrant: EntrantId;
  score: number; // Σ scored (half-points) — the primary standings key
  games: SwissGame[]; // in round order (index = round − 1)
}

export type SwissTable = readonly SwissRow[];

function indexTable(table: SwissTable): Map<EntrantId, SwissRow> {
  const map = new Map<EntrantId, SwissRow>();
  for (const row of table) map.set(row.entrant, row);
  return map;
}

// FIDE virtual opponent (Handbook C.07 — Tie-Break Regulations 2023, "Unplayed
// games"): a bye/forfeit is scored against a virtual opponent whose score = the
// player's score *before* that round, plus ½ point for every round from the
// unplayed one to the end inclusive (i.e. the opponent is assumed to draw the
// rest). In half-points: scoreBefore + (rounds − index).
function virtualOpponentScore(row: SwissRow, gameIndex: number): number {
  const rounds = row.games.length;
  let scoreBefore = 0;
  for (let i = 0; i < gameIndex; i++) scoreBefore += (row.games[i] as SwissGame).scored;
  return scoreBefore + (rounds - gameIndex);
}

// The score attributed to the opponent of `row`'s game at `index` — the real
// opponent's final score, or the virtual opponent's for an unplayed game.
function opponentScore(byEntrant: Map<EntrantId, SwissRow>, row: SwissRow, index: number): number {
  const game = row.games[index] as SwissGame;
  if (game.unplayed || game.opponent === null) return virtualOpponentScore(row, index);
  const opp = byEntrant.get(game.opponent);
  if (opp === undefined) {
    throw new Error(`Swiss ledger references unknown opponent "${game.opponent}"`);
  }
  return opp.score;
}

function requireRow(byEntrant: Map<EntrantId, SwissRow>, entrant: EntrantId): SwissRow {
  const row = byEntrant.get(entrant);
  if (row === undefined) throw new Error(`entrant "${entrant}" is not in the Swiss table`);
  return row;
}

// Buchholz = Σ opponents' final scores (half-points). Cut-`cut` drops the
// `cut` lowest opponent scores (FIDE recommends Cut-1 first) — spec 04 §6.3.
export function buchholz(table: SwissTable, entrant: EntrantId, opts: { cut?: number } = {}): number {
  const byEntrant = indexTable(table);
  const row = requireRow(byEntrant, entrant);
  const scores = row.games.map((_, i) => opponentScore(byEntrant, row, i));
  const cut = opts.cut ?? 0;
  if (cut <= 0) return scores.reduce((sum, s) => sum + s, 0);
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted.slice(cut).reduce((sum, s) => sum + s, 0);
}

export function buchholzCut1(table: SwissTable, entrant: EntrantId): number {
  return buchholz(table, entrant, { cut: 1 });
}

// Sonneborn-Berger = Σ (defeated opponents' scores) + ½ Σ (drawn opponents'
// scores) — spec 04 §6.3. Returned in QUARTER-points (integer): a win weights
// the opponent score ×2, a draw ×1, a loss ×0 (½·score → quarter-points).
export function sonnebornBerger(table: SwissTable, entrant: EntrantId): number {
  const byEntrant = indexTable(table);
  const row = requireRow(byEntrant, entrant);
  let total = 0;
  row.games.forEach((game, i) => {
    const oppScore = opponentScore(byEntrant, row, i);
    const weight = game.result === "win" ? 2 : game.result === "draw" ? 1 : 0;
    total += weight * oppScore;
  });
  return total;
}

// Number of wins (cascade tail) — spec 04 §6.3.
export function wins(table: SwissTable, entrant: EntrantId): number {
  const row = requireRow(indexTable(table), entrant);
  return row.games.filter((game) => game.result === "win").length;
}

// Direct-encounter result between two tied entrants (building block for the
// `direct` comparator, spec 05 §4.2): +1 if `a` scored more head-to-head, −1 if
// less, 0 if level or they never met. Half-point aware.
export function directEncounter(table: SwissTable, a: EntrantId, b: EntrantId): number {
  const byEntrant = indexTable(table);
  // Each side's head-to-head half-points, read straight off its own card.
  const scoredAgainst = (row: SwissRow, foe: EntrantId): { met: boolean; scored: number } => {
    let scored = 0;
    let met = false;
    for (const game of row.games) {
      if (game.opponent !== foe || game.unplayed) continue;
      met = true;
      scored += game.scored;
    }
    return { met, scored };
  };
  const aVsB = scoredAgainst(requireRow(byEntrant, a), b);
  const bVsA = scoredAgainst(requireRow(byEntrant, b), a);
  if (!aVsB.met && !bVsA.met) return 0; // never met
  return aVsB.scored > bVsA.scored ? 1 : aVsB.scored < bVsA.scored ? -1 : 0;
}

// Colour history string for the pairing algorithm (spec 05 §2.2, chess.md §3):
// 'W'/'B' in round order, skipping games with no colour (byes/forfeits/colours
// off). Constraint checks (no 3 in a row, |W−B| ≤ 2) live in the pairing code.
export function colorHistory(row: SwissRow): string {
  return row.games
    .filter((game) => game.color === "W" || game.color === "B")
    .map((game) => game.color)
    .join("");
}

// Convenience bundle for the ranking cascade — all integers.
export interface SwissTiebreaks {
  score: number; // half-points
  buchholzCut1: number; // half-points
  buchholz: number; // half-points
  sonnebornBerger: number; // quarter-points
  wins: number;
  colorHistory: string;
}

export function swissTiebreaks(table: SwissTable, entrant: EntrantId): SwissTiebreaks {
  const row = requireRow(indexTable(table), entrant);
  return {
    score: row.score,
    buchholzCut1: buchholzCut1(table, entrant),
    buchholz: buchholz(table, entrant),
    sonnebornBerger: sonnebornBerger(table, entrant),
    wins: wins(table, entrant),
    colorHistory: colorHistory(row),
  };
}

// Half-points → conventional score string (2 → "1", 1 → "½", 7 → "3½").
export function pointsToText(halfPoints: number): string {
  const whole = Math.floor(halfPoints / 2);
  const half = halfPoints % 2 === 1 ? "½" : "";
  if (whole === 0) return half === "" ? "0" : "½";
  return `${whole}${half}`;
}

// ===========================================================================
// Comparator registry + tiebreaker cascade — spec 05 §4 (PROMPT-08).
//
// A standings table is entrants sorted by a *cascade of comparators*. The
// cascade is data (a TiebreakerKey[]); ranking is iterative PARTITION
// REFINEMENT, never a pairwise sort — pairwise comparison breaks transitivity
// for head-to-head keys (spec 05 §4.2). Each key refines the current
// equivalence classes into finer, ordered sub-classes; a class of size 1 is
// final. Ratio metrics compare by cross-multiplication of integer ledgers, so
// ordering never touches a float (spec 05 §4.3).
// ===========================================================================

// >0 ⇒ a ranks ABOVE b; <0 ⇒ below; 0 ⇒ level on this key.
export type Comparator = (a: StandingsRow, b: StandingsRow, ctx: RankContext) => number;

export interface RankContext {
  cascade: readonly TiebreakerKey[];
  // Decided fixtures of the pool being ranked — the source for head-to-head
  // and direct-encounter mini-tables (spec 05 §4.2). Empty ⇒ no h2h data.
  // Absent (W2d T12) ⇒ the rows are not one pool's table (the cross-group
  // comparison, §5.9): `sberger` then compares each row's own materialised SB
  // rather than a ledger of results nobody passed.
  results?: readonly FixtureResult[];
  // W2d (spec §5.6, B2): which wins the `wins` key (and `h2h_wins`) counts.
  // "regulation" — FIH "matches won" — leaves out a win in overtime (the
  // `won_ot` display metric). A shoot-out after a draw is already a draw in the
  // W column, so it is never subtracted. Absent ⇒ "all".
  winsCount?: "all" | "regulation";
  // W2d (spec §5.6, B5, FIDE C.07): the GAME points of a result, [home, away],
  // in half-points (1/½/0 → 2/1/0). `sberger` and `direct` on a non-Swiss
  // stage read these instead of the table points, so a 3/1/0 round robin still
  // scores SB and direct encounter on game points. Absent ⇒ the table points.
  // (UEFA re-application, formerly `h2hRecursive`, is now the cascade's own
  // `h2h_reapply` modifier.)
  gamePoints?: (result: FixtureResult) => readonly [number, number];
  // Assembled Swiss ledger for buchholz/sberger/direct (spec 05 §4.1); the
  // boardgame cascade needs it, most sports do not.
  swiss?: SwissTable;
  // Entrant seeds for the `seed` comparator and deterministic residual-tie
  // ordering; lower number = higher seed.
  seeds?: ReadonlyMap<EntrantId, number>;
  // Jul3/05 §5 (3 Sep): for ≥3-way ties, 'overall' skips the h2h mini-table
  // so the cascade falls through to overall metrics (UEFA default is the
  // mini-table).
  h2hScope?: "mini_table" | "overall";
  // Division rngSeed for `lots` (spec 05 §4.4); combined with sorted tie-group
  // ids so the draw is reproducible and audited.
  rngSeed?: number;
  // W2d (spec §5.8, ruling 70): the draws already stored for this table, by the
  // tied set's members key. A class whose exact set is here takes the stored
  // order, whatever rngSeed says now. The value carries the stored draw's date
  // (PS-5b): `drawnAt` is the DB's `stage_lots_draws.drawn_at` — the engine has
  // no clock and never makes one up.
  lotsDraws?: ReadonlyMap<MembersKey, StoredLotsDraw>;
  // W2d (spec §5.8 step 1, anti-goal 3): how many fixtures this table counts.
  // 0 ⇒ an empty table: every row is `level`, ordered by seed then id, and no
  // lots are drawn. Absent ⇒ the caller does not say, and nothing is level.
  countedFixtures?: number;
  // W2d (spec §5.6 "ST-G12", X-TB-8): every fixture the stage schedules among
  // these rows, decided or not, as [home, away] — ONE ENTRY PER FIXTURE, so a
  // double round robin lists each pair twice. A head-to-head step (an h2h
  // block, `h2h_two`, `direct`) needs the tied class's mini-schedule complete:
  // every scheduled fixture between members of the class counted in `results`.
  // Otherwise the block gives way to `partialScheduleOrder`, or the step does not
  // split and the class carries the note `h2h_incomplete`. Every counted result
  // must be on the schedule (CONFIG_INVALID otherwise: the two were built from
  // different fixtures). Absent or empty ⇒ every mini-schedule is complete (as
  // before W2d). Refused beside `swiss` (a Swiss stage has no round-robin
  // schedule).
  scheduledPairs?: readonly (readonly [EntrantId, EntrantId])[];
  // W2d (IH-TB-2): the sport's order for a tied class whose mini-schedule is
  // incomplete, in place of the h2h block (`SportModule.partialScheduleOrder`,
  // IIHF RBG:349-350). Plain keys and `fewest_played`; a final `lots` hands the
  // class still level back to the stage's order, whose lots decide it. Anything
  // else is refused up front (CONFIG_INVALID).
  partialScheduleOrder?: readonly PartialScheduleKey[];
}

/** W2d (spec §5.8): a tied set's identity — its entrant ids, sorted, joined with ",". */
export type MembersKey = string;

/** A drawing of lots as stored (`stage_lots_draws`): the drawn order and the date the DB stamped on it. */
export interface StoredLotsDraw {
  readonly order: readonly EntrantId[];
  readonly drawnAt: string;
}

/** A drawing of lots this rank call made, for the caller to store: `members` sorted, `seed` = lotSeed(rngSeed, members). */
export interface NewLotsDraw {
  readonly membersKey: MembersKey;
  readonly members: readonly EntrantId[];
  readonly drawnOrder: readonly EntrantId[];
  readonly seed: number;
}

export interface RankingResult {
  // Ranked rows (clones — the input is never mutated), `rank` = 1..n, distinct.
  rows: StandingsRow[];
  // Tie-groups a drawing of lots decided (sorted ids) — each needs a
  // `rank_lock_required` division event before progression (spec 05 §3).
  lotsGroups: EntrantId[][];
  // W2d (spec §5.8): the lots drawn in this call because no stored draw held the
  // tied set. Empty on an empty table and when every draw was stored.
  newLotsDraws: readonly NewLotsDraw[];
}

/** The members key of a tied set (spec §5.8). An id holding the separator is refused: {"a,b"} and {"a","b"} would
 *  share a key, so one set's stored draw would order the other. */
export function membersKeyOf(ids: readonly EntrantId[]): MembersKey {
  for (const id of ids) {
    if (id.includes(",")) {
      throw new EngineError("CONFIG_INVALID", `entrant id "${id}" holds ",", the lots members-key separator`, { entrantId: id });
    }
  }
  return [...ids].sort().join(",");
}

const sgn = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

// Ledger key aliases: the abstract `diff`/`for` tiebreaks map to whatever the
// sport calls goal/run difference and goals/runs for (spec 04 per-sport).
export const DIFF_KEYS = ["gd", "run_diff", "diff"] as const;
export const FOR_KEYS = ["gf", "runs_for", "for"] as const;
/** The "against" twin of FOR_KEYS, index for index — the what-if's average
 *  match size is for + against (tie-what-if.ts). No comparator reads it. */
export const AGAINST_KEYS = ["ga", "runs_against", "against"] as const;

const FAIR_PLAY_KEYS = ["fair_play"] as const;
const SBERGER_KEYS = ["sberger"] as const;

// The first of `keys` this row records, or `undefined` when it records none.
//
// Partial on purpose (#429 scope item 5). `metrics` is a fold: `zeroRow` starts
// at `{}` and `addDelta` only ever writes a key some delta carried, so a row
// with no fixtures in the table being ranked — an entrant yet to play, an
// entrant absent from an h2h mini-table — records NO key at all, and neither
// does a row folded before a metric existed. Collapsing that to 0 made "never
// recorded" indistinguishable from "recorded, and it was zero", which is wrong
// for every signed metric (a −5 GD is worse than no GD, not better) and blocks
// any future rate metric outright, where no attempts is not the same as 0%.
// Callers now state their own answer rather than inheriting a silent one.
export function metricOf(row: StandingsRow, keys: readonly string[]): number | undefined {
  const key = metricKeyOf(row, keys);
  return key === undefined ? undefined : row.metrics[key];
}

/** The alias `metricOf` reads: the first of `keys` this row records. Callers
 *  that need to know WHICH ledger a row's `for`/`diff` resolve to (a stage
 *  rule's forfeit score reaches `for`/`against`/`diff` only — points.ts
 *  `payout`) ask this rather than re-walking the alias order. */
export function metricKeyOf<K extends string>(row: StandingsRow, keys: readonly K[]): K | undefined {
  return keys.find((key) => row.metrics[key] !== undefined);
}

// Integer-ledger readers (the ratio metrics and NRR). An unrecorded count IS 0
// here — these compare two ledger counters by cross-multiplication, and 0 is
// the identity the fold would have summed to, with `compareRatio` already
// giving 0/0 its own "no data" branch. Named so the default is a decision at
// the call site rather than a fallback hidden inside the lookup.
export function ledgerOf(row: StandingsRow, keys: readonly string[]): number {
  return metricOf(row, keys) ?? 0;
}

// Order two rows on a metric where absence means NO DATA: absent sorts below
// every recorded value, and two absent rows are level. Same "unknown sorts
// last" rule `seed` applies to an entrant with no seed, and it keeps the
// comparator a total preorder — which `groupBySort` requires, so "the key
// simply does not apply to this pair" is not an available answer. Two rows that
// BOTH record the metric compare exactly as they did before.
function compareMetric(a: StandingsRow, b: StandingsRow, keys: readonly string[]): number {
  return compareRecorded(metricOf(a, keys), metricOf(b, keys));
}

// The same "absent sorts last" order on two already-read values.
function compareRecorded(va: number | undefined, vb: number | undefined): number {
  if (va === undefined || vb === undefined) {
    return va === vb ? 0 : va === undefined ? -1 : 1;
  }
  return sgn(va - vb);
}

// Compare fractions an/ad vs bn/bd by cross-multiplication — no floats (spec 05
// §4.3). Denominators are ≥ 0; x/0 with x>0 is treated as +∞ (an unbeaten
// ratio), and 0/0 as 0 (no data). Numerators may be negative (net run rate).
function compareRatio(an: number, ad: number, bn: number, bd: number): number {
  const aInf = ad === 0 && an > 0;
  const bInf = bd === 0 && bn > 0;
  if (aInf || bInf) return aInf && bInf ? 0 : aInf ? 1 : -1;
  const an2 = ad === 0 ? 0 : an;
  const ad2 = ad === 0 ? 1 : ad;
  const bn2 = bd === 0 ? 0 : bn;
  const bd2 = bd === 0 ? 1 : bd;
  const lhs = BigInt(an2) * BigInt(bd2);
  const rhs = BigInt(bn2) * BigInt(ad2);
  return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
}

// Net run rate as an exact fraction: rf/bf − ra/bb = (rf·bb − ra·bf)/(bf·bb)
// (spec 04 §5 / cricket.md). Compared, never divided.
function nrrFraction(row: StandingsRow): { n: number; d: number } {
  const rf = ledgerOf(row, ["runs_for"]);
  const bf = ledgerOf(row, ["balls_faced_eff"]);
  const ra = ledgerOf(row, ["runs_against"]);
  const bb = ledgerOf(row, ["balls_bowled_eff"]);
  return { n: rf * bb - ra * bf, d: bf * bb };
}

// A ratio key compares its integer won/lost pair, cross-multiplied, never
// divided. The pair is RATIO_LEDGERS' (display.ts) — the ONE declaration the
// ratio column, the breakdown popover and the qualification what-if also read,
// so the cascade cannot rank on a pair the table does not print (final review
// M2: these four were literal copies before).
function ratioComparator(key: RatioKey): RunComparator {
  const [won, lost] = RATIO_LEDGERS[key];
  return (a, b) => compareRatio(ledgerOf(a, [won]), ledgerOf(a, [lost]), ledgerOf(b, [won]), ledgerOf(b, [lost]));
}

// W2d (spec §5.6) — `set_diff` / `point_diff`: won − lost over the SAME
// RATIO_LEDGERS pair the ratio of that ledger reads (BWF 16.2.3 "games
// difference", 16.2.4 "points difference"), greater first. A row recording
// neither half has no difference at all and sorts last, as `diff` does (#429);
// one recorded half reads the other as 0, as the ratio does.
function differenceComparator(key: "set_ratio" | "point_ratio"): RunComparator {
  const [won, lost] = RATIO_LEDGERS[key];
  const difference = (row: StandingsRow): number | undefined => {
    const w = metricOf(row, [won]);
    const l = metricOf(row, [lost]);
    return w === undefined && l === undefined ? undefined : (w ?? 0) - (l ?? 0);
  };
  return (a, b) => compareRecorded(difference(a), difference(b));
}

// `wins` (W2d B2): the W column, less the overtime wins under winsCount
// "regulation" (FIH). A draw-plus-bonus shoot-out is a draw in the W column
// already, so `won_so` is never subtracted.
function winsOf(row: StandingsRow, ctx: RankContext): number {
  return ctx.winsCount === "regulation" ? row.won - ledgerOf(row, ["won_ot"]) : row.won;
}

// `field_goals` (W2d B3, FIH GTR App. 3): every goal not scored from a penalty
// corner or a penalty stroke. An own goal is in `gf` (credited to the side it
// benefits) and in no `goals_<kind>` ledger, so it counts. Missing reads 0.
function fieldGoals(row: StandingsRow): number {
  return ledgerOf(row, ["gf"]) - ledgerOf(row, ["goals_pc"]) - ledgerOf(row, ["goals_stroke"]);
}

// The keys the refinement driver handles itself, because they need the tied
// class (a mini-table, the class size, the stored draw) rather than a pairwise
// value. Every OTHER key has a comparator: COMPARATORS is a full Record over
// PlainKey, so a new TiebreakerKey cannot compile without one (anti-goal 2).
type BlockKey = "h2h_points" | "h2h_diff" | "h2h_for" | "h2h_wins" | "h2h_set_ratio" | "h2h_point_ratio";
type Modifier = "h2h_reapply" | "h2h_exclusion";
type StructuralKey = BlockKey | Modifier | "h2h_two" | "direct" | "lots";
type PlainKey = Exclude<TiebreakerKey, StructuralKey>;

// What the driver threads through every step of one rank call.
interface RunContext extends RankContext {
  // `sberger` outside Swiss (B5): the pool's results as a Swiss ledger scored
  // in game points. Built once per call, and only when the cascade has sberger.
  readonly poolLedger: SwissTable | undefined;
  // Why a conditional step left a class unsplit (anti-goal 2), by entrant.
  // A later split clears it (markTieBreak), except `h2h_incomplete`; a residual
  // tie keeps it.
  readonly notes: Map<EntrantId, TieBreakNote>;
  // W2d (ST-G12): `scheduledPairs` when it says anything (non-empty), else
  // undefined — every mini-schedule complete.
  readonly schedule: readonly (readonly [EntrantId, EntrantId])[] | undefined;
  // W2d (IH-TB-2): `partialScheduleOrder`, parsed once per rank call.
  readonly partial: readonly PlainStep[] | undefined;
}
type RunComparator = (a: StandingsRow, b: StandingsRow, run: RunContext) => number;

// spec 05 §4.1 — one comparator per non-structural TiebreakerKey.
const COMPARATORS: Readonly<Record<PlainKey, RunComparator>> = {
  points: (a, b) => sgn(a.points - b.points),
  wins: (a, b, run) => sgn(winsOf(a, run) - winsOf(b, run)),
  diff: (a, b) => compareMetric(a, b, DIFF_KEYS),
  for: (a, b) => compareMetric(a, b, FOR_KEYS),
  fair_play: (a, b) => compareMetric(a, b, FAIR_PLAY_KEYS),
  nrr: (a, b) => {
    const na = nrrFraction(a);
    const nb = nrrFraction(b);
    return compareRatio(na.n, na.d, nb.n, nb.d);
  },
  set_ratio: ratioComparator("set_ratio"),
  // Tennis games won/lost (v6/00 §2) — same cross-multiplied form as
  // set_ratio, one level down the nested ledger.
  game_ratio: ratioComparator("game_ratio"),
  // Carrom boards won/lost (carrom.md §4) — same cross-multiplied form.
  board_ratio: ratioComparator("board_ratio"),
  point_ratio: ratioComparator("point_ratio"),
  // Swiss cascade-time metrics — read the assembled ledger (spec 05 §4.1).
  buchholz: (a, b, ctx) =>
    ctx.swiss ? sgn(buchholz(ctx.swiss, a.entrantId) - buchholz(ctx.swiss, b.entrantId)) : 0,
  buchholz_cut1: (a, b, ctx) =>
    ctx.swiss
      ? sgn(buchholzCut1(ctx.swiss, a.entrantId) - buchholzCut1(ctx.swiss, b.entrantId))
      : 0,
  // The Swiss ledger, else (W2d §5.6, B5) the pool ledger in game points, else
  // (W2d T12: rows from different pools, compared without results, §5.9) each
  // row's own SB as its pool's table materialised it.
  sberger: (a, b, run) => {
    const table = run.swiss ?? run.poolLedger;
    return table ? sgn(sonnebornBerger(table, a.entrantId) - sonnebornBerger(table, b.entrantId)) : compareMetric(a, b, SBERGER_KEYS);
  },
  seed: (a, b, ctx) => {
    const sa = ctx.seeds?.get(a.entrantId) ?? Number.MAX_SAFE_INTEGER;
    const sb = ctx.seeds?.get(b.entrantId) ?? Number.MAX_SAFE_INTEGER;
    return sgn(sb - sa); // lower seed number ranks above
  },
  // W2d (spec §5.6).
  set_diff: differenceComparator("set_ratio"),
  point_diff: differenceComparator("point_ratio"),
  // ATP 4.01 C.3-2: more matches played ranks higher ("a 2-1 record beats 2-0").
  matches_played: (a, b) => sgn(a.played - b.played),
  field_goals: (a, b) => sgn(fieldGoals(a) - fieldGoals(b)),
};

// Inside an h2h block each key is its plain twin applied to the mini-table:
// "h2h GD" is simply GD computed among the tied set (W2d adds wins, set ratio
// and point ratio — FIH's mini-league, ITTF 3.7.5.2).
const H2H_PLAIN: Readonly<Record<BlockKey, PlainKey>> = {
  h2h_points: "points",
  h2h_diff: "diff",
  h2h_for: "for",
  h2h_wins: "wins",
  h2h_set_ratio: "set_ratio",
  h2h_point_ratio: "point_ratio",
};
const H2H_KEYS: ReadonlySet<string> = new Set(Object.keys(H2H_PLAIN));
const MODIFIERS: ReadonlySet<string> = new Set<Modifier>(["h2h_reapply", "h2h_exclusion"]);

function isH2HKey(key: string | undefined): key is BlockKey {
  return key !== undefined && H2H_KEYS.has(key);
}

function isModifier(key: string | undefined): key is Modifier {
  return key !== undefined && MODIFIERS.has(key);
}

function h2hToPlain(key: BlockKey): PlainKey {
  return H2H_PLAIN[key];
}

// Sort a tied class by a comparator (best first) and split into equal-neighbour
// sub-classes. Sound because every comparator here is a total preorder.
function groupBySort(cls: StandingsRow[], cmp: RunComparator, run: RunContext): StandingsRow[][] {
  const sorted = [...cls].sort((a, b) => -sgn(cmp(a, b, run)));
  const groups: StandingsRow[][] = [];
  let current: StandingsRow[] = [];
  for (const row of sorted) {
    const prev = current[current.length - 1];
    if (prev !== undefined && sgn(cmp(prev, row, run)) !== 0) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// Record on every row of a just-split tie group which cascade rule separated
// it (doc 09 §2 tie-explanation popover). Later, finer splits overwrite — the
// snapshot keeps the finest rule that applied to each row. A split answers any
// earlier "could not split" note, so the note goes.
function markTieBreak(cls: readonly StandingsRow[], key: string, run: RunContext): void {
  const ids = cls.map((row) => row.entrantId);
  for (const row of cls) {
    row.tieBreak = { key, with: ids.filter((id) => id !== row.entrantId) };
    // W2d (ST-G12): a skipped head-to-head stays unanswered — no later step re-runs it for these rows.
    if (run.notes.get(row.entrantId) !== "h2h_incomplete") run.notes.delete(row.entrantId);
  }
}

// A residual tie (lots / seed): the same trace, plus the note of a conditional
// step that could not split it (anti-goal 2: the popover says why), and for a
// stored draw the date it was drawn ("Drawn by lots on {date}", spec §5.8).
function markResidual(cls: readonly StandingsRow[], key: "lots" | "seed", run: RunContext, drawnAt?: string): void {
  const ids = cls.map((row) => row.entrantId);
  for (const row of cls) {
    const note = run.notes.get(row.entrantId);
    row.tieBreak = {
      key,
      with: ids.filter((id) => id !== row.entrantId),
      ...(note === undefined ? {} : { note }),
      ...(drawnAt === undefined ? {} : { drawnAt }),
    };
  }
}

// The cascade, parsed once per rank call. `index` is the key's position: the
// first key is the primary order, so a split there is not a tie to explain.
type Step =
  | { kind: "plain"; index: number; key: PlainKey | "fewest_played"; cmp: RunComparator }
  | { kind: "block"; index: number; keys: readonly BlockKey[]; modifier: Modifier | null }
  | { kind: "h2h_two" | "direct" | "lots"; index: number };
type PlainStep = Extract<Step, { kind: "plain" }>;

// Anti-goal 2 (W2d spec §2.3, §5.5 read side): a key nothing handles THROWS.
// Before W2d it was silently skipped (a preset name stored where a key belongs
// ranked as if the step were absent). Parsed up front, so the refusal does not
// depend on whether this table happens to reach the key. A modifier must
// directly follow an h2h block, at most one per block (§5.5 rule 5).
function parseCascade(cascade: readonly TiebreakerKey[]): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < cascade.length; i++) {
    const key = cascade[i] as TiebreakerKey;
    if (isH2HKey(key)) {
      const index = i;
      const keys: BlockKey[] = [key];
      while (isH2HKey(cascade[i + 1])) {
        i++;
        keys.push(cascade[i] as BlockKey);
      }
      const next = cascade[i + 1];
      const modifier = isModifier(next) ? next : null;
      if (modifier !== null) i++;
      steps.push({ kind: "block", index, keys, modifier });
      continue;
    }
    if (isModifier(key)) throw refusal(key, i, "must directly follow a head-to-head block, at most one per block");
    if (key === "h2h_two" || key === "direct" || key === "lots") {
      steps.push({ kind: key, index: i });
      continue;
    }
    // `key` is typed PlainKey by now, but a stored cascade is data: own-property
    // lookup, so neither an unknown key nor "toString" finds a comparator.
    const cmp = Object.hasOwn(COMPARATORS, key) ? COMPARATORS[key] : undefined;
    if (cmp === undefined) throw refusal(key, i, "has no comparator");
    steps.push({ kind: "plain", index: i, key, cmp });
  }
  return steps;
}

function refusal(key: string, index: number, why: string): EngineError {
  return new EngineError("CONFIG_INVALID", `tie-break key "${key}" at position ${index + 1} ${why}`, { key, index });
}

// W2d (IH-TB-2, RBG:349-350): IIHF's "fewest games played" — fewer played ranks
// higher. Internal: only a partial-schedule order holds it (never a TiebreakerKey).
const FEWEST_PLAYED: RunComparator = (a, b) => sgn(b.played - a.played);

// W2d (spec §5.6, IH-TB-2): a partial-schedule order, parsed up front like the
// cascade, so a bad order is refused whether or not this table reaches it. Plain
// keys and `fewest_played` refine; `lots`, last only, is the residual the stage's
// own order goes on to decide. A head-to-head key would need the very
// mini-schedule that is incomplete, so it — and anything without a comparator —
// is refused.
function parsePartialOrder(order: readonly PartialScheduleKey[]): PlainStep[] {
  const steps: PlainStep[] = [];
  order.forEach((key, i) => {
    const why = (what: string): EngineError =>
      new EngineError("CONFIG_INVALID", `partial-schedule key "${key}" at position ${i + 1} ${what}`, { key, index: i });
    if (key === "lots") {
      if (i !== order.length - 1) throw why("must be last");
      return;
    }
    if (key === "fewest_played") {
      steps.push({ kind: "plain", index: i, key, cmp: FEWEST_PLAYED });
      return;
    }
    const cmp = Object.hasOwn(COMPARATORS, key) ? COMPARATORS[key as PlainKey] : undefined;
    if (cmp === undefined) throw why("is not a plain key (no head-to-head step can rank an incomplete mini-schedule)");
    steps.push({ kind: "plain", index: i, key: key as PlainKey, cmp });
  });
  return steps;
}

// W2d (X-TB-8): the schedule holds every counted result, pair for pair. A
// result it does not list — or more results of a pair than it schedules — means
// the schedule and the results were built from different fixtures, and every
// completeness answer would be wrong: refused by name.
function checkSchedule(schedule: readonly (readonly [EntrantId, EntrantId])[], results: readonly FixtureResult[]): void {
  const owed = new Map<MembersKey, number>();
  for (const [home, away] of schedule) {
    const key = membersKeyOf([home, away]);
    owed.set(key, (owed.get(key) ?? 0) + 1);
  }
  for (const result of results) {
    const key = membersKeyOf([result[0].entrantId, result[1].entrantId]);
    const left = owed.get(key) ?? 0;
    if (left === 0) {
      throw new EngineError("CONFIG_INVALID", `counted result ${key} is not on the stage's schedule (or is counted more often than scheduled)`, {
        pair: key,
      });
    }
    owed.set(key, left - 1);
  }
}

// W2d (spec §5.6 "ST-G12"): a tied class's mini-schedule is complete when every
// fixture the stage schedules between its members is decided. `checkSchedule`
// holds results ⊆ schedule pair for pair, so equal totals mean every pair is done.
function scheduleComplete(cls: readonly StandingsRow[], run: RunContext): boolean {
  if (run.schedule === undefined) return true;
  const ids = new Set(cls.map((row) => row.entrantId));
  const scheduled = run.schedule.filter(([home, away]) => ids.has(home) && ids.has(away)).length;
  return scheduled === resultsAmong(ids, run.results ?? []).length;
}

// A head-to-head step that cannot run on an incomplete mini-schedule: no split,
// and the popover says why (the author's call, AUD-ST:71 — a team is never placed
// above a rival it has not yet played on the strength of the meetings so far).
function h2hIncomplete(cls: StandingsRow[], run: RunContext): StandingsRow[][] {
  for (const row of cls) run.notes.set(row.entrantId, "h2h_incomplete");
  return [cls];
}

// W2d (IH-TB-2): the block's class has an incomplete mini-schedule. The sport's
// partial-schedule order ranks it (IIHF RBG:349-350), each split traced as the
// block's own would be; whatever stays level goes on down the stage's order,
// still noted. A sport without one: the block does not split.
function partialSchedule(cls: StandingsRow[], run: RunContext): StandingsRow[][] {
  const classes = h2hIncomplete(cls, run);
  if (run.partial === undefined) return classes;
  let current = classes;
  for (const step of run.partial) {
    current = current.flatMap((group) => {
      const groups = groupBySort(group, step.cmp, run);
      if (groups.length > 1) markTieBreak(group, step.key, run);
      return groups;
    });
  }
  return current;
}

// spec 05 §4.2, W2d §5.6 — head-to-head partition refinement over a maximal
// run of h2h_* keys (the block), with its optional modifier:
//   none (FIFA)             one pass; residual groups fall through.
//   h2h_reapply             after the WHOLE block, re-run it on each sub-group
//     (UEFA 20.01(d), IIHF) it left smaller than the group it started with, on
//                           matches among that sub-group only, until no group
//                           shrinks.
//   h2h_exclusion           as soon as ANY key splits the group, each resulting
//     (ITTF 3.7.5.3)        sub-group restarts the block from its FIRST key, on
//                           matches among its own members only.
// Every restart is on a strictly smaller set and siblings are disjoint, so the
// sets visited form a laminar family: at most n − 1 mini-tables per class.
function h2hBlock(
  cls: StandingsRow[],
  keys: readonly BlockKey[],
  modifier: Modifier | null,
  run: RunContext,
): StandingsRow[][] {
  // Jul3/05 §5 circular-H2H mode: an organiser may prefer overall metrics in
  // a ≥3-way tie — skip the mini-table and let later cascade keys decide.
  if (run.h2hScope === "overall" && cls.length >= 3) return [cls];
  // W2d (ST-G12): the block reads a mini-table only when it is complete. (A
  // re-applied or excluded sub-group of a complete class is complete.)
  if (!scheduleComplete(cls, run)) return partialSchedule(cls, run);
  if (modifier === "h2h_exclusion") return h2hExclusion(cls, keys, run);
  const ordered = h2hPass(cls, keys, run);
  if (modifier !== "h2h_reapply") return ordered;
  return ordered.flatMap((sub) =>
    // Recurse only when the block *partially* split the group; a sub-tie the
    // same size as the input made no progress (guards against non-termination).
    sub.length > 1 && sub.length < cls.length ? h2hBlock(sub, keys, modifier, run) : [sub],
  );
}

// The mini-table among a tied class: rows folded from the fixtures among its
// members only (every meeting — both legs of a double round robin aggregate,
// B4), and the way back from a mini row to the class's own row.
function miniTable(
  cls: readonly StandingsRow[],
  run: RunContext,
): { rows: StandingsRow[]; back: (mini: readonly StandingsRow[]) => StandingsRow[] } {
  const ids = cls.map((row) => row.entrantId);
  const rows = foldResults(ids, resultsAmong(new Set(ids), run.results ?? []));
  const byId = new Map(cls.map((row) => [row.entrantId, row]));
  return { rows, back: (mini) => mini.map((row) => byId.get(row.entrantId) as StandingsRow) };
}

// One pass of the block: refine the mini-table one key at a time so each split
// is attributed to the h2h key that caused it (tie-explanation trace).
function h2hPass(cls: StandingsRow[], keys: readonly BlockKey[], run: RunContext): StandingsRow[][] {
  const mini = miniTable(cls, run);
  let miniClasses: StandingsRow[][] = [mini.rows];
  for (const key of keys) {
    const cmp = COMPARATORS[h2hToPlain(key)];
    miniClasses = miniClasses.flatMap((group) => {
      if (group.length <= 1) return [group];
      const groups = groupBySort(group, cmp, run);
      if (groups.length > 1) markTieBreak(mini.back(group), key, run);
      return groups;
    });
    if (miniClasses.every((group) => group.length === 1)) break;
  }
  return miniClasses.map(mini.back);
}

// ITTF 3.7.5.3 exclusion: the first key that splits the class stops the walk;
// each sub-group of two or more restarts the block from blockKeys[0], among its
// own members only.
function h2hExclusion(cls: StandingsRow[], keys: readonly BlockKey[], run: RunContext): StandingsRow[][] {
  const mini = miniTable(cls, run);
  for (let k = 0; k < keys.length; k++) {
    const groups = groupBySort(mini.rows, COMPARATORS[h2hToPlain(keys[k] as BlockKey)], run);
    if (groups.length === 1) continue;
    markTieBreak(cls, keys[k] as BlockKey, run);
    return groups
      .map(mini.back)
      .flatMap((sub) => (sub.length > 1 ? h2hBlock(sub, keys, "h2h_exclusion", run) : [sub]));
  }
  return [cls];
}

// W2d (spec §5.6, OC3) — `h2h_two`: a tied class of exactly two, ordered by the
// table points of the matches between them (every meeting, B4). Any other size,
// two who never met, or two level between them: no split, and the class carries
// the note that says why (anti-goal 2). Two who never met have an empty
// mini-table, so they are level on its points — one test covers both.
function h2hTwo(cls: StandingsRow[], explain: boolean, run: RunContext): StandingsRow[][] {
  if (cls.length <= 1) return [cls];
  if (cls.length === 2) {
    // W2d (ST-G12): a match between them still to be decided — the matches so far are not "the match between them".
    if (!scheduleComplete(cls, run)) return h2hIncomplete(cls, run);
    const mini = miniTable(cls, run);
    const groups = groupBySort(mini.rows, COMPARATORS.points, run);
    if (groups.length > 1) {
      if (explain) markTieBreak(cls, "h2h_two", run);
      return groups.map(mini.back);
    }
  }
  for (const row of cls) run.notes.set(row.entrantId, "h2h_two_not_applicable");
  return [cls];
}

// The game points of a result (B5): the context's reader, else the table points.
function gamePointsOf(result: FixtureResult, ctx: RankContext): readonly [number, number] {
  return ctx.gamePoints === undefined ? [result[0].points, result[1].points] : ctx.gamePoints(result);
}

// Direct-encounter refinement among the tied set (spec 05 §4.1): the points
// each entrant scored against the others — from the Swiss ledger when present
// (boardgame), else the pool results in GAME points (B5). A mini-league, not
// pairwise, keeps it transitive for 3+ tied entrants.
function directRefine(cls: StandingsRow[], run: RunContext): StandingsRow[][] {
  const ids = new Set(cls.map((row) => row.entrantId));
  const scores = new Map<EntrantId, number>();
  const swiss = run.swiss;
  if (swiss) {
    for (const id of ids) {
      const row = swiss.find((entry) => entry.entrant === id);
      const scored = (row?.games ?? []).reduce(
        (sum, game) =>
          !game.unplayed && game.opponent !== null && ids.has(game.opponent) ? sum + game.scored : sum,
        0,
      );
      scores.set(id, scored);
    }
  } else {
    for (const result of resultsAmong(ids, run.results ?? [])) {
      const [home, away] = gamePointsOf(result, run);
      scores.set(result[0].entrantId, (scores.get(result[0].entrantId) ?? 0) + home);
      scores.set(result[1].entrantId, (scores.get(result[1].entrantId) ?? 0) + away);
    }
  }
  const score = (row: StandingsRow): number => scores.get(row.entrantId) ?? 0;
  return groupBySort(cls, (a, b) => sgn(score(a) - score(b)), run);
}

// The full cascade driver: refine the classes one parsed step at a time.
function refine(classes: StandingsRow[][], steps: readonly Step[], run: RunContext): StandingsRow[][] {
  let current = classes;
  for (const step of steps) {
    if (current.every((cls) => cls.length === 1)) break;
    const explain = step.index > 0;
    switch (step.kind) {
      case "lots":
        break; // resolved after the cascade (rankStandings)
      case "block":
        // h2hBlock writes its own per-key trace; an h2h block at cascade head
        // still explains genuine ties within the mini-table.
        current = current.flatMap((cls) => (cls.length > 1 ? h2hBlock(cls, step.keys, step.modifier, run) : [cls]));
        break;
      case "h2h_two":
        current = current.flatMap((cls) => h2hTwo(cls, explain, run));
        break;
      case "direct":
        current = current.flatMap((cls) => {
          if (cls.length <= 1) return [cls];
          // W2d (ST-G12): direct encounter among a tied set that has not played out its meetings does not split.
          if (!scheduleComplete(cls, run)) return h2hIncomplete(cls, run);
          const groups = directRefine(cls, run);
          if (explain && groups.length > 1) markTieBreak(cls, "direct", run);
          return groups;
        });
        break;
      case "plain":
        current = current.flatMap((cls) => {
          if (cls.length <= 1) return [cls];
          const groups = groupBySort(cls, step.cmp, run);
          if (explain && groups.length > 1) markTieBreak(cls, step.key, run);
          return groups;
        });
        break;
    }
  }
  return current;
}

// B5: the pool's counted results as a Swiss ledger, every result re-scored in
// game points, so SB reads opponents' GAME scores whatever the table paid.
function buildPoolLedger(ids: readonly EntrantId[], ctx: RankContext): SwissTable {
  const scored = resultsAmong(new Set(ids), ctx.results ?? []).map((result): FixtureResult => {
    const [home, away] = gamePointsOf(result, ctx);
    return [{ ...result[0], points: home }, { ...result[1], points: away }];
  });
  return buildSwissTable(ids, scored);
}

// FNV-1a fold of the division rngSeed and sorted tie-group ids → a stable
// 32-bit lot seed (spec 05 §4.4). Same seed + same ids ⇒ same draw. Exported
// (W2d T5) as the declared draw a test computes independently of rankStandings.
export function lotSeed(rngSeed: number, sortedIds: readonly EntrantId[]): number {
  let hash = rngSeed >>> 0;
  for (const id of sortedIds) {
    for (let k = 0; k < id.length; k++) {
      hash = Math.imul(hash ^ id.charCodeAt(k), 0x01000193) >>> 0;
    }
    hash = Math.imul(hash ^ 0x2c, 0x01000193) >>> 0; // separator between ids
  }
  return hash >>> 0;
}

function bySeedThenId(ctx: RankContext): (a: StandingsRow, b: StandingsRow) => number {
  return (a, b) => {
    const sa = ctx.seeds?.get(a.entrantId) ?? Number.MAX_SAFE_INTEGER;
    const sb = ctx.seeds?.get(b.entrantId) ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.entrantId < b.entrantId ? -1 : a.entrantId > b.entrantId ? 1 : 0;
  };
}

// A stored draw orders exactly the tied set it is keyed by. Anything else is a
// broken row (or two sets sharing a key) and is refused by name: applying it
// would drop or repeat entrants in the table.
function storedOrder(stored: StoredLotsDraw, membersKey: MembersKey): readonly EntrantId[] {
  if (membersKeyOf(stored.order) !== membersKey) {
    throw new EngineError(
      "CONFIG_INVALID",
      `stored lots draw "${membersKey}" orders [${stored.order.join(",")}], not exactly those entrants`,
      { membersKey, order: [...stored.order] },
    );
  }
  return stored.order;
}

// Rank a folded standings table by the cascade (spec 05 §4). Returns cloned
// rows in a total order with distinct 1..n ranks. A class the cascade cannot
// separate is broken by `lots` if the cascade lists it (marking the group for a
// rank_lock_required event): by the stored draw of its exact set when
// `lotsDraws` holds one, else by a seeded draw returned in `newLotsDraws` for
// the caller to store (W2d §5.8, ruling 70). Otherwise — and on an empty table
// (countedFixtures 0: every row `level`, nothing drawn, anti-goal 3) — by
// seed→id, a deterministic fallback that never silently randomises (spec 05
// §3). Throws CONFIG_INVALID for a cascade it cannot run (anti-goal 2,
// `parseCascade`) and for a stored draw that does not fit its set.
export function rankStandings(rows: readonly StandingsRow[], ctx: RankContext): RankingResult {
  const steps = parseCascade(ctx.cascade);
  const partial = ctx.partialScheduleOrder === undefined ? undefined : parsePartialOrder(ctx.partialScheduleOrder);
  const schedule = ctx.scheduledPairs !== undefined && ctx.scheduledPairs.length > 0 ? ctx.scheduledPairs : undefined;
  if (schedule !== undefined && ctx.swiss !== undefined) {
    // ST-G12 is a round-robin rule: a Swiss stage pairs round by round, so it has no schedule to complete (B1, D7).
    throw new EngineError("CONFIG_INVALID", "a Swiss table has no round-robin schedule: scheduledPairs (ST-G12) is read only on a league or group stage", {});
  }
  if (schedule !== undefined) checkSchedule(schedule, ctx.results ?? []);
  const clones = rows.map((row) => ({ ...row, metrics: { ...row.metrics } }));
  const poolLedger =
    ctx.swiss === undefined && ctx.results !== undefined && ctx.cascade.includes("sberger")
      ? buildPoolLedger(clones.map((row) => row.entrantId), ctx)
      : undefined;
  const run: RunContext = { ...ctx, poolLedger, notes: new Map(), schedule, partial };
  // No rows, no class: zero entrants are no tie, so there is nothing for lots to draw (W2d T4 N1).
  const classes = refine(clones.length === 0 ? [] : [clones], steps, run);
  // W2d §5.8 step 1 (anti-goal 3): a table with no counted fixture has no
  // leader and draws no lots — its residual classes take seed then id.
  const empty = ctx.countedFixtures === 0;
  const hasLots = !empty && ctx.cascade.includes("lots");
  const rngSeed = ctx.rngSeed ?? 0;

  const order: StandingsRow[] = [];
  const lotsGroups: EntrantId[][] = [];
  const newLotsDraws: NewLotsDraw[] = [];
  for (const cls of classes) {
    if (cls.length === 1) {
      order.push(cls[0] as StandingsRow);
      continue;
    }
    if (hasLots) {
      const ids = cls.map((row) => row.entrantId).sort();
      const membersKey = membersKeyOf(ids);
      const stored = ctx.lotsDraws?.get(membersKey);
      let drawn: readonly EntrantId[];
      if (stored === undefined) {
        const seed = lotSeed(rngSeed, ids);
        drawn = shuffle(seed, ids);
        newLotsDraws.push({ membersKey, members: [...ids], drawnOrder: drawn, seed });
      } else {
        drawn = storedOrder(stored, membersKey);
      }
      const byId = new Map(cls.map((row) => [row.entrantId, row]));
      markResidual(cls, "lots", run, stored?.drawnAt);
      for (const id of drawn) {
        const row = byId.get(id) as StandingsRow;
        row.rankLocked = true;
        // Jul3/05 §5: equal on every criterion — even with a lots decider the
        // console should alert before KO seeding (10 Jun).
        row.tieUnbroken = true;
        order.push(row);
      }
      lotsGroups.push(ids);
    } else {
      // Jul3/05 §5 tie-exhaustion (10 Jun): the cascade could not separate
      // these rows — flag them so the console alerts before KO seeding.
      markResidual(cls, "seed", run);
      for (const row of [...cls].sort(bySeedThenId(ctx))) {
        row.tieUnbroken = true;
        order.push(row);
      }
    }
  }

  order.forEach((row, index) => {
    row.rank = index + 1;
    // Every row of an empty table is level; no row of any other table is, even
    // one a previous rank call flagged (the clone carries its input's fields).
    if (empty) row.level = true;
    else delete row.level;
  });

  // Swiss cascade metrics exist only at rank time (they need the assembled
  // ledger) — materialise the ones the cascade uses into row.metrics, in
  // DISPLAY points (buchholz half-points → points, SB quarter-points →
  // points), so the standings snapshot can render Buchholz/SB columns
  // (doc 09 §2) without re-assembling the ledger. Ordering never reads these.
  if (ctx.swiss) {
    for (const row of order) {
      if (ctx.cascade.includes("buchholz")) {
        row.metrics["buchholz"] = buchholz(ctx.swiss, row.entrantId) / 2;
      }
      if (ctx.cascade.includes("buchholz_cut1")) {
        row.metrics["buchholz_cut1"] = buchholzCut1(ctx.swiss, row.entrantId) / 2;
      }
      if (ctx.cascade.includes("sberger")) {
        row.metrics["sberger"] = sonnebornBerger(ctx.swiss, row.entrantId) / 4;
      }
    }
  } else if (poolLedger !== undefined) {
    // W2d (spec §5.7): SB in a round robin gets the same display column.
    for (const row of order) {
      row.metrics["sberger"] = sonnebornBerger(poolLedger, row.entrantId) / 4;
    }
  }
  return { rows: order, lotsGroups, newLotsDraws };
}

// The write-side check of an order (`validateCascade`, `offerableKeys`) lives in cascade-rules.ts (W2d Task 6, spec §5.5).

// Assemble a SwissTable from decided fixture results for the buchholz/sberger/
// direct comparators (spec 05 §4.1, PROMPT-07 note). Each entrant's card is
// built from the fixtures it played; `scored` is read straight off the
// module's delta points (half-points for the boardgame module). Colour isn't
// recoverable from deltas — pass richer cards directly when needed.
//
// `awards` are one-sided sit-out deltas (Swiss/KO byes): opponent null +
// unplayed, so Buchholz/SB use the FIDE virtual opponent (Handbook C.07).
export function buildSwissTable(
  entrants: readonly EntrantId[],
  results: readonly FixtureResult[],
  awards: readonly StandingsDelta[] = [],
): SwissTable {
  const cards = new Map<EntrantId, SwissGame[]>();
  const scoreOf = new Map<EntrantId, number>();
  for (const id of entrants) {
    cards.set(id, []);
    scoreOf.set(id, 0);
  }
  const resultOf = (delta: StandingsDelta): GameResult =>
    delta.won > 0 ? "win" : delta.drawn > 0 ? "draw" : "loss";
  const push = (self: StandingsDelta, opp: StandingsDelta): void => {
    const card = cards.get(self.entrantId);
    if (card === undefined) {
      throw new Error(`Swiss ledger built for entrant "${self.entrantId}" outside the entrant set`);
    }
    card.push({ opponent: opp.entrantId, result: resultOf(self), scored: self.points });
    scoreOf.set(self.entrantId, (scoreOf.get(self.entrantId) ?? 0) + self.points);
  };
  for (const [home, away] of results) {
    push(home, away);
    push(away, home);
  }
  for (const award of awards) {
    const card = cards.get(award.entrantId);
    if (card === undefined) {
      throw new Error(`Swiss ledger built for entrant "${award.entrantId}" outside the entrant set`);
    }
    card.push({
      opponent: null,
      result: resultOf(award),
      scored: award.points,
      unplayed: true,
    });
    scoreOf.set(award.entrantId, (scoreOf.get(award.entrantId) ?? 0) + award.points);
  }
  return entrants.map((entrant) => ({
    entrant,
    score: scoreOf.get(entrant) ?? 0,
    games: cards.get(entrant) ?? [],
  }));
}
