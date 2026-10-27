// Chess is individual-only (owner ruling, 2026-10-26) — the PREDICATE half of
// the rule, in a file that imports nothing. Plain node loads it, so the format
// matrix (tools/matrix, run under `node --experimental-strip-types`) reads the
// same rule the division builder offers by (format-templates.ts) and the stage
// writers refuse by, never a copy. Keep it import-free: an `@/` import here
// breaks every node-run reader of format-templates.ts
// (tools/matrix/__tests__/boundary.test.ts pins it).
//
// The refusal itself (an HttpError, 422 CHESS_INDIVIDUAL_ONLY) and the entrant
// predicates live in chess-individual-only.ts, which re-exports this file: the
// two files are one statement of the rule.

/** The sport module key that IS chess. `sports.name` for it is "Chess"
 *  (scripts/sync-sports.ts); the key predates the name and stays `boardgame`.
 *  The engine module declares the same thing from its side
 *  (`entrantModel.kinds = ["individual"]`, packages/engine/src/sports/boardgame)
 *  — a test pins that the two agree. */
export const CHESS_SPORT_KEY = "boardgame";

/** Is this sport chess? Null/undefined (a division that could not be read) is
 *  "no": the writers refuse only what they can positively identify. */
export function isChessSport(sportKey: string | null | undefined): boolean {
  return sportKey === CHESS_SPORT_KEY;
}

/** The stage kinds that MINT pair entrants: an americano stage rotates its
 *  individual players into a new `pair` entrant for every pairing
 *  (usecases/stages.ts americanoGen -> pairEntrantsFor). Mexicano is the same
 *  kind (`config.mode: "mexicano"`), so this one entry covers both formats. */
export const PAIR_MINTING_STAGE_KINDS: readonly string[] = Object.freeze(["americano"]);

/** Does this sport refuse this stage kind? Chess refuses every kind that mints
 *  pairs (follow-up to #1027): the builder does not offer it, and creating such
 *  a stage is refused with CHESS_INDIVIDUAL_ONLY. Every other sport refuses
 *  nothing here. */
export function sportRefusesStageKind(sportKey: string | null | undefined, kind: string): boolean {
  return isChessSport(sportKey) && PAIR_MINTING_STAGE_KINDS.includes(kind);
}
