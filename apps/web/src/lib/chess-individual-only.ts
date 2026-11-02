// Chess is played one player per entry (owner ruling, 2026-10-26): every chess
// division, online and over-the-board, takes INDIVIDUAL entrants only. No pair,
// no team, no free-agent (solo sign-up) pool.
//
// This file is the one statement of that rule. It is pure and client-safe (no
// server-only imports), so the writers (divisions, registration settings,
// entrants, imports, stages) and the organiser surfaces that would otherwise
// OFFER the options (the entrant kinds block at the top of the division Entrants tab, the registration
// hub config panel, and, through format-templates.ts templatesForSport, the
// builder's and Settings' format pickers, which offer no americano/mexicano
// for chess) read the same predicate and the same refusal.
//
// The sport predicate and the stage-kind predicate live in
// chess-individual-only-rule.ts (re-exported below), a file that imports
// nothing, so the format matrix and format-templates.ts read them under plain
// node. The two files are one statement of the rule.
//
// What it does NOT do: touch a stored row. A chess division saved before the
// ruling may still hold a team/pair/free-agent configuration; reads keep
// working and nothing here rewrites it (see the read-only listing query in the
// PR notes). The refusals apply to new WRITES only.
import { HttpError } from "@/lib/errors";
import { isChessSport, sportRefusesStageKind } from "@/lib/chess-individual-only-rule";

export {
  CHESS_SPORT_KEY,
  PAIR_MINTING_STAGE_KINDS,
  isChessSport,
  sportRefusesStageKind,
} from "@/lib/chess-individual-only-rule";

/** The one named refusal code, shared by every writer (HTTP 422). */
export const CHESS_INDIVIDUAL_ONLY = "CHESS_INDIVIDUAL_ONLY";

/** English fallback for API clients; the organiser UI localises the CODE
 *  (`divset.err.chessIndividualOnly`) rather than showing this raw. */
export const CHESS_INDIVIDUAL_ONLY_MESSAGE =
  "Chess divisions take individual players only — pairs, teams and solo sign-up pools are not available";

/** The refusal every writer throws. `extra` merges into the error body (the
 *  import names the file rows it refused). */
export function chessIndividualOnlyError(extra?: Record<string, unknown>): HttpError {
  return new HttpError(422, CHESS_INDIVIDUAL_ONLY_MESSAGE, CHESS_INDIVIDUAL_ONLY, extra);
}

/** Does a stored/incoming `config.entrants` override name anything but
 *  individual? Reads exactly the two members that choose a kind
 *  (`kinds`, `defaultKind` — packages/engine/src/sport/entrant-model.ts); the
 *  affordance flags (`squadNumbers`, `captain`) pick no kind and are ignored.
 *  Strict on purpose: an element that is not exactly "individual" counts, so a
 *  misspelt kind is refused rather than silently ignored by the engine and
 *  left in the row. A non-object (absent, null, a string) names nothing. */
export function entrantsOverrideWidensBeyondIndividual(entrants: unknown): boolean {
  if (entrants === null || typeof entrants !== "object" || Array.isArray(entrants)) return false;
  const { kinds, defaultKind } = entrants as { kinds?: unknown; defaultKind?: unknown };
  if (Array.isArray(kinds) && kinds.some((k) => k !== "individual")) return true;
  if (defaultKind !== undefined && defaultKind !== null && defaultKind !== "individual") return true;
  return false;
}

/** Throw the chess refusal when this sport is chess and the entrant kind is
 *  anything but individual. */
export function assertChessKindIndividual(sportKey: string | null | undefined, kind: string): void {
  if (isChessSport(sportKey) && kind !== "individual") throw chessIndividualOnlyError();
}

/** Throw the chess refusal when this sport is chess and any of these stage
 *  kinds mints pairs (americano, and mexicano, its `mode`). The stage writers
 *  ask it of a whole batch before anything is written (usecases/stages.ts
 *  assertStageBatchGates), so an organiser is never left holding a stage that
 *  Start would refuse. */
export function assertStageKindsAllowed(sportKey: string | null | undefined, kinds: readonly string[]): void {
  if (kinds.some((k) => sportRefusesStageKind(sportKey, k))) throw chessIndividualOnlyError();
}
