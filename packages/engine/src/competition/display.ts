// Standings display helpers — doc 09 §2 (PROMPT-12). The public dashboard
// renders sport-correct tables with ZERO per-sport UI code: columns come from
// the module's MetricSpec[] plus the cascade-derived metrics below, and the
// formulas for derived values live HERE (engine-owned), never in the web app.
//
// Derived metrics are ranking concepts, not ledger fields: NRR and the ratio
// metrics are recomputed for display from the integer ledger in a row (the
// cascade compares them by cross-multiplication and never stores a float);
// the Swiss metrics (buchholz/buchholz_cut1/sberger) are materialised into
// row.metrics by rankStandings because they need the assembled ledger.
import { EngineError } from "../core/errors.ts";
import type { DecidedIn, TiebreakerKey } from "../sport/module.ts";
import type { StandingsRow } from "./standings.ts";

export interface DerivedMetricSpec {
  key: TiebreakerKey;
  label: string;
  decimals: number;
}

// Cascade keys that earn a standings column when the division's cascade uses
// them (doc 09 §2: cricket → NRR; volleyball → set/point ratio; chess →
// Buchholz Cut-1, SB). Declaration order = column order. W2d (spec §5.7, ST-G29):
// badminton's set and point difference, hockey's field goals and tennis's game
// ratio, each only where the stage's order holds it (`standingsColumns`).
export const DERIVED_METRICS: readonly DerivedMetricSpec[] = [
  { key: "nrr", label: "NRR", decimals: 3 },
  { key: "set_ratio", label: "Ratio", decimals: 2 },
  { key: "board_ratio", label: "Board ratio", decimals: 2 },
  { key: "point_ratio", label: "Pts ratio", decimals: 2 },
  { key: "buchholz_cut1", label: "Buchholz Cut-1", decimals: 1 },
  { key: "buchholz", label: "Buchholz", decimals: 1 },
  { key: "set_diff", label: "Diff", decimals: 0 }, // neutral, like "Ratio": sets in volleyball, games in badminton
  { key: "point_diff", label: "Pts diff", decimals: 0 },
  { key: "field_goals", label: "FG", decimals: 0 },
  { key: "sberger", label: "SB", decimals: 2 },
  { key: "game_ratio", label: "Game ratio", decimals: 2 },
];

/**
 * The integer won/lost pair each ratio key divides. Declared ONCE: the ratio
 * text below reads it, so does the standings table's breakdown popover, which
 * prints these two totals beside the ratio, the qualification what-if
 * (`tie-what-if.ts`), and the cascade's own comparators (`tiebreakers.ts`
 * `ratioComparator`) — two copies of the pair would let the popover explain a
 * number the cell did not compute, or the table rank on a pair it never
 * shows. `game_ratio` (tennis, ATP C.3-1) is a column since W2d (ST-G29), and a
 * tie decided on it prints both sides' values and a target.
 */
export const RATIO_LEDGERS = {
  set_ratio: ["sets_won", "sets_lost"],
  game_ratio: ["games_won", "games_lost"],
  board_ratio: ["boards_won", "boards_lost"],
  point_ratio: ["points_won", "points_lost"],
} as const satisfies Partial<Record<TiebreakerKey, readonly [string, string]>>;

export type RatioKey = keyof typeof RATIO_LEDGERS;

function metric(row: StandingsRow, key: string): number {
  return row.metrics[key] ?? 0;
}

/**
 * W2d (spec §5.6; BWF 16.2.3 "games difference", 16.2.4 "points difference") — won − lost over the SAME pair the ratio
 * of that ledger divides. `undefined` for a row recording neither half: it has no difference at all (and the cascade's
 * `set_diff`/`point_diff` sort it last, #429); one recorded half reads the other as 0. The ONE formula: the comparator
 * (`tiebreakers.ts`) and the column below both read it, so the table cannot print a number it did not rank on.
 */
export function ledgerDifference(row: StandingsRow, key: "set_ratio" | "point_ratio"): number | undefined {
  const [won, lost] = RATIO_LEDGERS[key];
  const w = row.metrics[won];
  const l = row.metrics[lost];
  return w === undefined && l === undefined ? undefined : (w ?? 0) - (l ?? 0);
}

/** W2d (B3, FIH GTR App. 3) — every goal not scored from a penalty corner or a penalty stroke. An own goal is in `gf`
 *  (credited to the side it benefits) and in no `goals_<kind>` ledger, so it counts. Missing reads 0. The ONE formula
 *  the `field_goals` step ranks on and its column prints. */
export function fieldGoalsOf(row: StandingsRow): number {
  return metric(row, "gf") - metric(row, "goals_pc") - metric(row, "goals_stroke");
}

/** won/lost as a ratio column prints it: ∞ when unbeaten, — with no ledger. */
export function ratioText(won: number, lost: number, decimals: number): string {
  if (lost === 0) return won > 0 ? "∞" : "—";
  return (won / lost).toFixed(decimals);
}

/**
 * W2e Task 8c (owner D19; CK-BO-2) — the over length net run rate is per when a competition names none: cricket's standard
 * six-ball over, the default of its `ballsPerOver` (held to the schema's by display-nrr-scale.test.ts, so this is not a
 * second source of truth). The ledger counts BALLS (`balls_faced_eff`, `balls_bowled_eff`); a competition that plays
 * another over (The Hundred's five) passes its own.
 */
export const DEFAULT_BALLS_PER_OVER = 6;

/** A competition's over length, refused when it is no whole number of balls above zero: it divides every NRR printed, and
 *  a NaN or zero there would print "NaN" or "0.000" for a table that has a perfectly good ledger. */
export function overLengthOf(ballsPerOver: number): number {
  if (!Number.isInteger(ballsPerOver) || ballsPerOver <= 0) {
    throw new EngineError("CONFIG_INVALID", `an over length is a whole number of balls above zero, not ${ballsPerOver}`, { ballsPerOver });
  }
  return ballsPerOver;
}

/**
 * Display text for a derived metric on one row, or null when the row cannot
 * produce it (no ledger yet). NRR is signed per convention (+0.412).
 *
 * NRR is runs PER OVER (ECB The Hundred Playing Conditions 2026, 16.9.4(a): "the average runs per over scored by that
 * team" less "the average runs per over scored against that team"; 17.1: an over "shall comprise 5 balls"), so it scales
 * by the competition's over length: `ballsPerOver` (default `DEFAULT_BALLS_PER_OVER`). The ORDER the cascade ranks on is
 * the integer cross-multiplication in tiebreakers.ts, which has no scale; only this printed value does.
 */
export function derivedMetricText(row: StandingsRow, key: TiebreakerKey, ballsPerOver: number = DEFAULT_BALLS_PER_OVER): string | null {
  switch (key) {
    case "nrr": {
      const bpo = overLengthOf(ballsPerOver);
      const bf = metric(row, "balls_faced_eff");
      const bb = metric(row, "balls_bowled_eff");
      if (bf === 0 || bb === 0) return "—";
      const nrr = (bpo * metric(row, "runs_for")) / bf - (bpo * metric(row, "runs_against")) / bb;
      const text = nrr.toFixed(3);
      return nrr > 0 ? `+${text}` : text;
    }
    case "set_ratio":
    case "game_ratio":
    case "board_ratio":
    case "point_ratio": {
      const [won, lost] = RATIO_LEDGERS[key];
      return ratioText(metric(row, won), metric(row, lost), 2);
    }
    case "set_diff":
    case "point_diff": {
      const difference = ledgerDifference(row, key === "set_diff" ? "set_ratio" : "point_ratio");
      return difference === undefined ? "—" : `${difference}`;
    }
    // A row with no goals ledger has played nothing that counts: a dash, as its GF cell prints.
    case "field_goals":
      return row.metrics.gf === undefined ? "—" : `${fieldGoalsOf(row)}`;
    case "buchholz":
    case "buchholz_cut1": {
      const value = row.metrics[key];
      return value === undefined ? null : formatHalfSteps(value);
    }
    case "sberger": {
      const value = row.metrics[key];
      return value === undefined ? null : value.toFixed(2).replace(/\.?0+$/, "") || "0";
    }
    default:
      return null;
  }
}

/**
 * W2d (spec §5.7; RBG §3.4, lines 343-344) — how a stage's table lays out its result columns, from its points rule:
 * `apart`, the decisions beyond regulation counted in their own columns (IIHF's OTW/OTL: "OT and GWS decisions both land
 * in OTW/OTL"), taken out of W and L; `unit`, how its points print (`"half"`: stored half-points, FIDE's 1 / ½ / 0 shown
 * "1½", D10(b)). `points.ts` `tableLayoutOf` decides it; this file only prints it.
 */
export interface TableLayout {
  readonly apart: readonly Exclude<DecidedIn, "regulation">[];
  readonly unit: "whole" | "half";
  /** W2e Task 8c (CK-BO-2) — the over length the table's net run rate is per (`derivedMetricText`): the competition's own
   *  `ballsPerOver`, five on The Hundred. `DEFAULT_BALLS_PER_OVER` where a stage names none. Read by NRR alone. */
  readonly ballsPerOver: number;
}

/** A table with no rules to read (a stage the loader refused): W and L as folded, whole points. */
export const PLAIN_LAYOUT: TableLayout = { apart: [], unit: "whole", ballsPerOver: DEFAULT_BALLS_PER_OVER };

/** The result columns a table prints: played, the W/L split, draws, points. */
export type ResultColumnKey = "played" | "won" | "otw" | "otl" | "drawn" | "lost" | "points";

/** One result column's text on `row` under `layout`. W and L leave out the decisions counted apart; OTW and OTL are
 *  their sums (`won_<d>`/`lost_<d>`, the display fold `payout` writes on a match's real winner and loser). */
export function resultColumnText(row: StandingsRow, key: ResultColumnKey, layout: TableLayout): string {
  const beyond = (side: "won" | "lost"): number => layout.apart.reduce((n, d) => n + metric(row, `${side}_${d}`), 0);
  switch (key) {
    case "won":
      return `${row.won - beyond("won")}`;
    case "lost":
      return `${row.lost - beyond("lost")}`;
    case "otw":
      return `${beyond("won")}`;
    case "otl":
      return `${beyond("lost")}`;
    case "points":
      return pointsText(row.points, layout.unit);
    default:
      return `${row[key]}`;
  }
}

/** A points total as the table prints it: whole points as stored; half-points (`unit: "half"`) in halves — 3 → "1½",
 *  1 → "½", the spelling `pointsToText` gives a Swiss card. A fractional or negative total (Jul3/09: deductions and
 *  custom points are legal) keeps its sign and prints a non-half remainder as a decimal, never a wrong half. */
export function pointsText(points: number, unit: TableLayout["unit"]): string {
  if (unit === "whole") return `${points}`;
  if (!Number.isInteger(points)) return `${points / 2}`;
  const sign = points < 0 ? "-" : "";
  return `${sign}${formatHalfSteps(Math.abs(points) / 2)}`;
}

/** W2d (spec §5.8 step 1, anti-goal 3; X-TB-6) — the rank a level row prints: an en dash, no place. */
export const LEVEL_RANK = "–";

/** A table with no counted fixture: `rankStandings` marks every row `level` (anti-goal 3). No rows is no table — never a
 *  level one. */
export function isLevelTable(rows: readonly Pick<StandingsRow, "level">[]): boolean {
  return rows.length > 0 && rows.every((r) => r.level === true);
}

/** The rank cell's text: `LEVEL_RANK` on a level table, else the row's place (empty when the ranking pass left none). */
export function rankText(row: Pick<StandingsRow, "rank">, level: boolean): string {
  if (level) return LEVEL_RANK;
  return row.rank === undefined ? "" : `${row.rank}`;
}

// Chess-style points render in halves ("3½") — reuse for buchholz columns.
function formatHalfSteps(points: number): string {
  const whole = Math.trunc(points);
  const hasHalf = Math.abs(points - whole) >= 0.25;
  if (whole === 0) return hasHalf ? "½" : "0";
  return hasHalf ? `${whole}½` : `${whole}`;
}

// Human phrasing for the tie-break trace keys (doc 09 §2 popover: "ahead on
// head-to-head"). Keys not listed fall back to the raw key.
const TIE_BREAK_LABELS: Record<string, string> = {
  points: "points",
  wins: "wins",
  diff: "goal/run difference",
  for: "goals/runs scored",
  fair_play: "fair play",
  nrr: "net run rate",
  set_ratio: "set ratio",
  board_ratio: "board ratio",
  point_ratio: "point ratio",
  h2h_points: "head-to-head",
  h2h_diff: "head-to-head difference",
  h2h_for: "head-to-head scoring",
  direct: "direct encounter",
  buchholz: "Buchholz",
  buchholz_cut1: "Buchholz Cut-1",
  sberger: "Sonneborn–Berger",
  seed: "seeding",
  lots: "drawing of lots",
};

export function tieBreakLabel(key: string): string {
  return TIE_BREAK_LABELS[key] ?? key;
}
