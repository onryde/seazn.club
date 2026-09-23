// Tie-break what-if — spec 2026-09-22 §3.4 (R5). Pure. When a row can finish
// level on points with a rival across the qualification line, this names the
// cascade key that splits them, both current values, and — for keys built from
// the row's own results — the smallest net margin that puts it strictly ahead.
//
// The target ASSUMES the rival's figures stay as they are, and that the row
// plays ONE more match whose total size is its own average so far
// ((won + lost) / played, in the key's units). It is always shown with that
// assumption (R5); this module returns data, the copy lives in the web app.
import type { TiebreakerKey } from "../sport/module.ts";
import { derivedMetricText, ratioText } from "./display.ts";
import type { StandingsRow } from "./standings.ts";
import { AGAINST_KEYS, DIFF_KEYS, FOR_KEYS, ledgerOf, metricOf } from "./tiebreakers.ts";

/** Keys built from the row's own results — the only ones that get a target
 *  (R5, controller ruling OQ1 adds game_ratio). */
export const WHAT_IF_KEYS = ["point_ratio", "set_ratio", "game_ratio", "board_ratio", "diff", "for"] as const;
export type WhatIfKey = (typeof WHAT_IF_KEYS)[number];

export type TieWhatIf =
  /** Smallest integer net margin (own − opponent) that puts the row strictly
   *  ahead; negative = "lose by no more than −margin". */
  | { kind: "target"; key: WhatIfKey; margin: number }
  /** Ahead even after losing by a whole average match. */
  | { kind: "safe"; key: WhatIfKey }
  /** No target: the rule and both current values (null = no per-row value). */
  | { kind: "rule"; key: TiebreakerKey; mine: string | null; theirs: string | null };

export interface TieWhatIfOpts {
  /** Every point in this table came from wins at one rate, so rows level on
   *  points are level on wins and `wins` cannot split them (OQ1). The caller
   *  reads it from the bounds in force — `pointsRuleBounds(rule).winsOnly`
   *  when the stage has a PointsRule, else the module's
   *  `matchPointsBounds(cfg).winsOnly` — and must pass false when the table
   *  carries points that did not come from its matches (carry-over openings).
   *  Never `supportsDraws`: carrom and cricket draw nothing and still pay a
   *  no-result. */
  winsOnly: boolean;
}

// The integer won/lost pair each ratio key compares (tiebreakers.ts
// COMPARATORS reads the same pairs).
// TODO(T7): dedupe with RATIO_LEDGERS after rebase onto feat/standings-popovers
// (it has no game_ratio pair yet — add it there, then import this from it).
const RATIO_LEDGER = {
  point_ratio: ["points_won", "points_lost"],
  set_ratio: ["sets_won", "sets_lost"],
  game_ratio: ["games_won", "games_lost"],
  board_ratio: ["boards_won", "boards_lost"],
} as const satisfies Record<Exclude<WhatIfKey, "diff" | "for">, readonly [string, string]>;

const floorDiv = (a: number, b: number) => Math.floor(a / b);
const isWhatIfKey = (key: TiebreakerKey): key is WhatIfKey => (WHAT_IF_KEYS as readonly string[]).includes(key);

/** The cascade key that splits a tie on points: the first one after `points`,
 *  passing over `wins` when it cannot separate rows level on points. Null when
 *  `points` is not the cascade's primary key (rows level on points are then
 *  ordered by an earlier key, so no key after it decides) or nothing follows. */
export function tieDecidingKey(cascade: readonly TiebreakerKey[], opts: TieWhatIfOpts): TiebreakerKey | null {
  if (cascade[0] !== "points") return null;
  for (const key of cascade.slice(1)) {
    if (key === "wins" && opts.winsOnly) continue;
    return key;
  }
  return null;
}

/** A row's current value on a tie key, as the table would print it; null when
 *  the key has no per-row value (head-to-head, direct, lots, seed). */
export function tieKeyValue(row: StandingsRow, key: TiebreakerKey): string | null {
  switch (key) {
    case "diff": {
      const v = metricOf(row, DIFF_KEYS);
      return v === undefined ? null : v > 0 ? `+${v}` : `${v}`;
    }
    case "for": {
      const v = metricOf(row, FOR_KEYS);
      return v === undefined ? null : `${v}`;
    }
    case "wins":
      return `${row.won}`;
    case "game_ratio": {
      // derivedMetricText has no game_ratio case (no standings column).
      const [won, lost] = RATIO_LEDGER.game_ratio;
      return ratioText(ledgerOf(row, [won]), ledgerOf(row, [lost]), 2);
    }
    default:
      return derivedMetricText(row, key);
  }
}

/** Smallest integer margin m that puts the row strictly ahead, and `size`,
 *  the row's total in the key's units over its `played` matches. Null when
 *  there is nothing to reason from. */
function marginFor(key: WhatIfKey, row: StandingsRow, rival: StandingsRow): { margin: number; size: number } | null {
  const p = row.played;
  if (p <= 0) return null;
  if (key === "diff" || key === "for") {
    const f = metricOf(row, FOR_KEYS);
    const a = metricOf(row, AGAINST_KEYS);
    if (f === undefined || a === undefined) return null;
    const size = f + a;
    if (key === "diff") {
      const gd = metricOf(row, DIFF_KEYS);
      const rgd = metricOf(rival, DIFF_KEYS);
      if (gd === undefined || rgd === undefined) return null;
      return { margin: rgd - gd + 1, size };
    }
    const rf = metricOf(rival, FOR_KEYS);
    if (rf === undefined) return null;
    // f + (T + m)/2 > rf, T = size/p  ⇔  m·p > 2p(rf − f) − size
    return { margin: floorDiv(2 * p * (rf - f) - size, p) + 1, size };
  }
  const [wk, lk] = RATIO_LEDGER[key];
  const w = ledgerOf(row, [wk]);
  const l = ledgerOf(row, [lk]);
  const rw = ledgerOf(rival, [wk]);
  const rl = ledgerOf(rival, [lk]);
  // An unbeaten rival (x/0) cannot be passed, only equalled; 0/0 is no data.
  if (rl === 0) return null;
  // (w + (T+m)/2) / (l + (T−m)/2) > rw/rl, cross-multiplied and scaled by 2p:
  // m·p·(rw + rl) > rw·(2pl + size) − rl·(2pw + size). rl > 0 and p > 0, so
  // the divisor is positive and the inequality keeps its direction.
  const size = w + l;
  const num = rw * (2 * l * p + size) - rl * (2 * w * p + size);
  return { margin: floorDiv(num, p * (rw + rl)) + 1, size };
}

/** The what-if for `row` against `rival` (§3.4), or null when the cascade
 *  names no deciding key. The caller picks the rival (qualification.ts
 *  `tieRival`); this does not re-check that a tie on points is reachable. */
export function tieWhatIf(
  row: StandingsRow,
  rival: StandingsRow,
  cascade: readonly TiebreakerKey[],
  opts: TieWhatIfOpts,
): TieWhatIf | null {
  const key = tieDecidingKey(cascade, opts);
  if (key === null) return null;
  const rule: TieWhatIf = { kind: "rule", key, mine: tieKeyValue(row, key), theirs: tieKeyValue(rival, key) };
  if (!isWhatIfKey(key)) return rule;
  const m = marginFor(key, row, rival);
  if (m === null || m.size <= 0) return rule;
  const p = row.played;
  if (m.margin * p > m.size) return rule; // more than a whole average match can hold
  if (m.margin * p <= -m.size) return { kind: "safe", key };
  return { kind: "target", key, margin: m.margin };
}
