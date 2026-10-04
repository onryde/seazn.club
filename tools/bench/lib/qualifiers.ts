// B07a T5 — the seat order a pooled group stage feeds its knockout.
//
// WHY THIS EXISTS. Until now the bench derived a progression's expected
// qualifier list from "every row of the one UNPOOLED expected table", in rank
// order. That is right for `_tiny`'s single league feeding a 2-slot playoff,
// and it is not a derivation at all for a pooled group stage: with one table
// per pool there IS no unpooled row, so the runner pushed a hard error and the
// pack failed loudly. This file replaces that loud failure with the real rule.
//
// THE RULE: `topNPerGroup` orders qualifiers RANK BEFORE GROUP — every pool's
// winner, then every pool's runner-up (A1, B1, C1, D1, A2, B2 …), never
// A1, A2, B1, B2. The product's own words, at
// `packages/engine/src/competition/progression.ts:124-134`:
//
//     // WAVE-major, not pool-major: every group's winner (wave 1) before any
//     // group's runner-up (wave 2) — the standard tournament convention, and
//     // what makes "snake" meaningful.
//
// and `placement: "rank_order"` then consumes that list VERBATIM — a plain
// `pots.flat()` with no reordering (`placeDescriptors`, progression.ts:239-298).
//
// ORDER IS THE WHOLE POINT. Membership is the same under either reading, so a
// check that only asks WHICH entrants qualified passes on a list that seeds
// every bracket slot with the wrong entrant. A single-elimination fold pairs
// seed i against seed N+1-i, so a pool-major list lands each pool's own
// qualifiers against each other in round 1 — the exact defect
// `placeDescriptors`' snake refusal exists to prevent, arrived at from the
// other direction.
//
// WHICH POOL COMES FIRST inside a wave is the product's ordering, not an
// invention here: `sourceShapeOf` reads
// `select key from pools where stage_id = ... order by key`
// (apps/web/src/server/usecases/stage-seeding.ts:134), and when no pool rows
// exist yet it falls back to `POOL_KEYS.slice(0, count).split("")` over
// `"ABCDEFGHIJKLMNOPQRSTUVWXYZ"` (usecases/stages.ts:745). Both are ascending
// by key, which is what sorting on `poolKey` below mirrors. A pack's
// DECLARATION order therefore cannot move a seat.
//
// INDEPENDENCE (bench `_RULES.md` §3, checker independence): this file imports
// NOTHING from the product — not `expandTake`, not `placeDescriptors`. The
// bench re-implements the rule so that the two can DISAGREE, which is a
// finding either way; sharing the product's implementation would make the
// check a tautology that agrees with the product even when the product is
// wrong. The cross-check against the engine's own expansion lives in
// `__tests__/qualifiers.test.ts`, where importing it is the point.

/** One row of a source stage's expected final table — the two fields a
 *  qualifier derivation needs. Structurally satisfied by
 *  `PackExpectedTableRow` (pack-schema.ts:1130), which carries played/won/
 *  drawn/lost/points as well; narrowed here so this module stays usable
 *  without the pack schema and cannot accidentally depend on a field that
 *  says nothing about seat order. */
export interface QualifierRow {
  readonly entrant: string;
  readonly rank: number;
}

/** One expected table. `poolKey` absent means the STAGE-wide table — which a
 *  pooled progression never reads (see `expectedQualifierRefs`). */
export interface QualifierTable {
  readonly poolKey?: string | undefined;
  readonly rows: readonly QualifierRow[];
}

/** The one take rule this module implements. Deliberately narrow: a pack
 *  declaring `rankRange`/`bestNth`/`picks`/`roundLosers` is NOT silently run
 *  through the topNPerGroup rule — the caller names what it actually saw
 *  instead of guessing (`run-suite.ts`'s `parseTopNPerGroup`). */
export interface TopNPerGroup {
  readonly kind: "topNPerGroup";
  readonly n: number;
}

/**
 * The expected qualifier ENTRANT REFS, in seat order (seed 1 first), for a
 * `topNPerGroup` progression fed by the given source-stage tables.
 *
 * Returns `[]` when no table declares a pool — an unpooled source stage is
 * not a `topNPerGroup` subject, and answering with its flat rows would
 * silently assert a completely different rule. The caller keeps its own
 * flat-table path for that case rather than this function inventing one.
 *
 * A pool that declares no row at some rank <= n contributes no seat at that
 * rank. The resulting list is then SHORTER than the product's proposal, and
 * the comparison is length-sensitive, so that mismatch surfaces as a red
 * rather than as a quietly-shortened expectation that happens to agree.
 */
export function expectedQualifierRefs(
  tables: readonly QualifierTable[],
  progression: TopNPerGroup,
): readonly string[] {
  const pooled = tables
    .filter((t): t is QualifierTable & { poolKey: string } => t.poolKey !== undefined)
    .sort((a, b) => a.poolKey.localeCompare(b.poolKey));
  if (pooled.length === 0) return [];

  const seats: string[] = [];
  // Wave-major: the RANK loop is outer, the POOL loop inner. Swapping these
  // two lines is precisely the group-before-rank defect this module exists to
  // exclude, and it is invisible to any membership-only assertion.
  for (let rank = 1; rank <= progression.n; rank += 1) {
    for (const table of pooled) {
      const row = table.rows.find((r) => r.rank === rank);
      if (row !== undefined) seats.push(row.entrant);
    }
  }
  return seats;
}
