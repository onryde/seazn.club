// Standings qualification status — spec
// docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md §3.
// Pure. Independent-rival bound (R3): each rival is allowed its own best and
// worst case regardless of whom it plays. That admits outcomes that cannot
// happen (two rivals who meet cannot both win), so every Through/Out it prints
// also holds over the real outcomes; it can only be too cautious.
import type { EntrantId } from "../core/types.ts";
import type { MatchPointsBounds } from "../sport/module.ts";

export type QualStatus =
  | { kind: "through" }
  | { kind: "out" }
  | { kind: "win_k"; k: number }
  | { kind: "needs_help" };

export interface QualRow {
  entrantId: EntrantId;
  /** The table's match points (carry-over included). */
  points: number;
  /** false for a withdrawn/disqualified entrant: still a rival, frozen at `points`. */
  active: boolean;
}

export interface QualificationInput {
  rows: readonly QualRow[];
  /** entrant → matches left in THIS table (Swiss: rounds not yet settled). */
  remaining: ReadonlyMap<EntrantId, number>;
  perMatch: MatchPointsBounds;
  /** Places that go through from this table (a pool's quota under topNPerGroup). */
  cut: number;
  anyPlayed: boolean;
  complete: boolean;
}

export interface QualRowResult {
  status: QualStatus;
  /** Status after losing the next match — only for the two open statuses. */
  ifYouLose: QualStatus | null;
}

function remainingOf(input: QualificationInput, row: QualRow): number {
  return row.active ? Math.max(0, input.remaining.get(row.entrantId) ?? 0) : 0;
}
export function bestCase(input: QualificationInput, row: QualRow): number {
  return row.points + remainingOf(input, row) * input.perMatch.max;
}
export function worstCase(input: QualificationInput, row: QualRow): number {
  return row.points + remainingOf(input, row) * input.perMatch.min;
}

/** `lo`/`hi`: the least/most the row can already be sure of; `r`: matches left. */
interface Own { lo: number; hi: number; r: number }

function statusFor(input: QualificationInput, entrantId: EntrantId, own: Own): QualStatus {
  const rivals = input.rows.filter((row) => row.entrantId !== entrantId);
  const count = (pred: (row: QualRow) => boolean) => rivals.filter(pred).length;
  const { max, min, winFloor } = input.perMatch;
  const myWorst = own.lo + own.r * min;
  const myBest = own.hi + own.r * max;
  // R4: `≥` — a rival who can draw level counts as a rival who can beat you.
  if (count((j) => bestCase(input, j) >= myWorst) < input.cut) return { kind: "through" };
  if (count((j) => worstCase(input, j) > myBest) >= input.cut) return { kind: "out" };
  for (let k = 1; k <= own.r; k++) {
    const target = own.lo + k * winFloor + (own.r - k) * min;
    if (count((j) => bestCase(input, j) >= target) < input.cut) return { kind: "win_k", k };
  }
  return { kind: "needs_help" };
}

/** Per-row status for one table, or null when the table shows none (§3.3). */
export function qualificationStatus(
  input: QualificationInput,
): ReadonlyMap<EntrantId, QualRowResult | null> | null {
  if (!input.anyPlayed || input.complete) return null;
  if (!Number.isInteger(input.cut) || input.cut < 1 || input.rows.length === 0) return null;
  const out = new Map<EntrantId, QualRowResult | null>();
  for (const row of input.rows) {
    if (!row.active) {
      out.set(row.entrantId, null);
      continue;
    }
    const r = remainingOf(input, row);
    const status = statusFor(input, row.entrantId, { lo: row.points, hi: row.points, r });
    const open = status.kind === "win_k" || status.kind === "needs_help";
    const ifYouLose =
      open && r >= 1
        ? statusFor(input, row.entrantId, {
            lo: row.points + input.perMatch.min,
            hi: row.points + input.perMatch.lossCeil,
            r: r - 1,
          })
        : null;
    out.set(row.entrantId, { status, ifYouLose });
  }
  return out;
}

/** §3.4 step 4: the nearest entrant across the line with whom a tie on points
 *  is still reachable. `orderedIds` is the table in rank order. */
export function tieRival(
  input: QualificationInput,
  orderedIds: readonly EntrantId[],
  entrantId: EntrantId,
): EntrantId | null {
  const byId = new Map(input.rows.map((row) => [row.entrantId, row]));
  const me = byId.get(entrantId);
  const i = orderedIds.indexOf(entrantId);
  if (!me || i < 0) return null;
  const across = i < input.cut ? orderedIds.slice(input.cut) : orderedIds.slice(0, input.cut).reverse();
  const lo = worstCase(input, me);
  const hi = bestCase(input, me);
  for (const id of across) {
    const j = byId.get(id);
    if (j && Math.max(lo, worstCase(input, j)) <= Math.min(hi, bestCase(input, j))) return id;
  }
  return null;
}
