// W5 app PR B Task 1 (X-PO-1 <- RB5-P1, X-PO-2 <- RB5-E4/P2; ruling 279; preflight C10, C11, C12): a POOLED stage's seating -
// entrant -> pool - for the engine's fold (`TableStage.pools`). With it every seated member of a pool is a row of that pool's
// table from the first fold, zero played; without it (engine 9's rule) a pool's members were the entrants of its results and
// awards, so a pool nobody had played in had no table at all.
//
// The seating is read off the stage's stored lines, EVERY line whatever its status (C10): a void, cancelled or walked-over line
// still seats its two sides, so a withdrawn entrant - expunged lines all void - stays in her pool (RB5-W1: a leaver's row stays
// listed, ranked last) and her kept results never name an unseated entrant (engine `entrant_unseated`). A waiting late arrival
// (`entrants.table_waiting_stage_id`) holds no line, so she is neither seated nor a declared entrant of the fold: not a row, not
// refused (F9). Pure and node-safe: the engine-db fold (`toTableStage`) and the tests read the same function.
//
// C11 (the legacy guard): a stored pooled stage whose lines would make the engine refuse EVERY fold - a pool seating fewer than
// two (`pool_too_small`), an entrant on lines of two pools (`fixture_pool_mismatch` on whichever result the map does not hold), or
// a pooled stage holding a line with no pool - is HELD: the fold gets no seating for that stage alone and keeps engine 9's
// membership, so a score write never answers 422 for a draw the app stored. The census read 0 such stages on stg (2026-11-20).
import { validatePoolSizes } from "@seazn/engine/competition";
import { EngineError } from "@seazn/engine/core";

/** The fields of a stored line the seating reads (`fixtures` row shape). */
export interface SeatingLine {
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/** Why a stored pooled stage is held off the seating (C11) - each one an engine refusal the fold would otherwise raise. */
export type SeatingHeldReason = "pool_too_small" | "entrant_in_two_pools" | "unpooled_line";

export type StageSeating =
  /** A pooled stage with at least one seat: entrant id -> the pool's id (the fold's pool key, a line's `pool_id`). */
  | { kind: "seated"; pools: ReadonlyMap<string, string> }
  /** Not a pooled stage (a league, a Swiss, a group drawn before W5 T3 with no pool on its lines), or a pooled one nobody is seated
   *  in yet (a fed group's TBD lines): the fold keeps engine 9's membership, which for one table is every declared entrant. */
  | { kind: "unpooled" }
  /** C11: a stored seating the engine would refuse; the fold keeps engine 9's membership for this stage. */
  | { kind: "held"; reason: SeatingHeldReason; entrantId?: string; pool?: string };

/** The stage kinds drawn in pools: only a group (a league is one table; americano rides the league fold; Swiss pairs one field). */
const POOLED_KINDS: ReadonlySet<string> = new Set(["group"]);

/** The stage's seating, from its stored lines (see the file's head). `kind` is the stored stage kind. */
export function stageSeatingOf(kind: string, lines: readonly SeatingLine[]): StageSeating {
  if (!POOLED_KINDS.has(kind) || !lines.some((l) => l.pool_id !== null)) return { kind: "unpooled" };
  const pools = new Map<string, string>();
  for (const line of lines) {
    const sides = [line.home_entrant_id, line.away_entrant_id].filter((id): id is string => id !== null);
    if (line.pool_id === null) {
      // A line with no pool in a pooled stage: whoever it seats belongs to no pool, and a result on it names no pool's member.
      if (sides.length > 0) return { kind: "held", reason: "unpooled_line", entrantId: sides[0] };
      continue;
    }
    for (const id of sides) {
      const seated = pools.get(id);
      if (seated !== undefined && seated !== line.pool_id) return { kind: "held", reason: "entrant_in_two_pools", entrantId: id, pool: line.pool_id };
      pools.set(id, line.pool_id);
    }
  }
  if (pools.size === 0) return { kind: "unpooled" };
  try {
    validatePoolSizes(pools);
  } catch (err) {
    const reason = err instanceof EngineError ? (err.data as { reason?: unknown; pool?: unknown } | undefined) : undefined;
    if (reason?.reason === "pool_too_small") return { kind: "held", reason: "pool_too_small", pool: String(reason.pool) };
    throw err;
  }
  return { kind: "seated", pools };
}
