// W4 app-A Task 4 (gap K3; extends X-RB-1): a knockout line's ROLE in its bracket — the final, a semi-final, the third
// place match — as a key that survives a Rebuild that changes the bracket's size. Pure and client-safe, like
// lib/rebuild-slots.ts, which reads it.
//
// Why a role and not a position: a knockout's `round_no` counts from the FIRST round (usecases/stages/generators.ts `bracketToGen`: the
// engine's round index + 1), so a bracket of 8 has its final in round 3 and a bracket of 16 in round 4. Rebuild carried
// slots by `(pool, round_no, seq)`, so an 8 → 9 Rebuild handed the old final's court and time to a new quarter-final.
// Counted back from the final instead — the final is depth 0, its semi-finals depth 1 — the final keeps the final's slot
// at every size.

/** The columns a role is read from. */
export interface BracketRoleRow {
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
}

/** A bracket with no line but third-place ones has no final to count back from. Named, so a caller (and a test) can
 *  tell it from any other failure: an assumption made a guard, never a comment. */
export class BracketHasNoFinalError extends Error {
  constructor() {
    super("finalRoundOf: the bracket has no line outside a third-place match, so it has no final to count back from");
    this.name = "BracketHasNoFinalError";
  }
}

/** The third-place match: the engine names it `<prefix>-3p` (scheduling/bracket.ts `generateSingleElim`), and the app
 *  stores the engine's id as `ext_key` (usecases/stages/generators.ts `bracketToGen`). It sits in the final's round, so it is told apart by
 *  its key, never by its round. */
const isThirdPlace = (r: Pick<BracketRoleRow, "ext_key">): boolean => r.ext_key !== null && r.ext_key.endsWith("-3p");

/** The final's round: the highest `round_no` among the lines that are not the third-place match. */
export function finalRoundOf(rows: readonly BracketRoleRow[]): number {
  let max: number | null = null;
  for (const r of rows) if (!isThirdPlace(r) && (max === null || r.round_no > max)) max = r.round_no;
  if (max === null) throw new BracketHasNoFinalError();
  return max;
}

/** A line's role key: `<pool>:3p` for the third-place match, else `<pool>:<rounds before the final>:<seq>` — the final
 *  is `<pool>:0:1`, its semi-finals `<pool>:1:1` and `<pool>:1:2`. `finalRound` is the row's OWN bracket's
 *  (`finalRoundOf`), so the rows before and after a Rebuild are each keyed against their own final. */
export function bracketRoleKey(row: BracketRoleRow, finalRound: number): string {
  const pool = row.pool_id ?? "";
  if (isThirdPlace(row)) return `${pool}:3p`;
  return `${pool}:${finalRound - row.round_no}:${row.seq_in_round}`;
}
