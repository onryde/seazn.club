// W4 app-A Task 16 (SP-UI; RB4-S6 / X-SP-6, owner ruling 269): a stepladder or a page playoff is not offered standalone.
// Both rank the top of a TABLE (RB4-S1: "top k from a table"; RB4-S2: "exactly 4 from a table"), so a stage of either kind
// with no progression has nothing to seed from: the stage writers refuse it by name (`usecases/stages.ts`
// `assertStageBatchGates`, the one gate both the create and the Format dialog's replace ask before anything is written).
// They stay offered as FINAL stages (RB4-S7 / X-SP-7): league then stepladder, league or Swiss then page playoff — those
// carry a progression and this predicate answers null for them.
//
// The PREDICATE half of the rule, in a file that imports nothing: plain node loads it, so the format matrix
// (tools/matrix/lib/catalogue.ts `refusedCell`, run under `node --experimental-strip-types`) reads the same rule the
// writers refuse by, never a copy (tools/matrix/__tests__/boundary.test.ts pins it import-free). The refusal rows (status,
// English, dictionary key) live in `lib/knockout-refusals.ts`, keyed by the codes below.
//
// Existing standalone stages (stg held 11 on 2026-11-05, pre-flight count 5) are NOT touched: the refusal guards new
// writes only, and a legacy stage keeps playing (X-LE-8 reaches one through late entry).

/** The stage kinds that only ever seed from a table, each with the code its standalone refusal carries. One code per kind
 *  (pre-flight ruling D13): the refusal names the kind in the reader's language, never a raw kind token inside es/fr/nl. */
export const STANDALONE_REFUSED_KINDS = Object.freeze({
  stepladder: "STEPLADDER_NEEDS_TABLE_SOURCE",
  page_playoff: "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE",
} as const);

export type StandaloneRefusalCode = (typeof STANDALONE_REFUSED_KINDS)[keyof typeof STANDALONE_REFUSED_KINDS];

/** Why the product refuses this stage as written, or null when it takes it: a stepladder or page playoff that names no
 *  progression (null or absent — both mean "no source", `stages.progression` is stored null for either). Own keys only:
 *  a kind that happens to be an Object.prototype name (`toString`) is no refused kind. Any other kind, and either kind
 *  WITH a progression, answers null — the progression's own shape is `validateStageProgression`'s question, not this one. */
export function standaloneStageRefusal(stage: { kind: string; progression: unknown }): StandaloneRefusalCode | null {
  if (!Object.hasOwn(STANDALONE_REFUSED_KINDS, stage.kind)) return null;
  if (stage.progression !== null && stage.progression !== undefined) return null;
  return STANDALONE_REFUSED_KINDS[stage.kind as keyof typeof STANDALONE_REFUSED_KINDS];
}
