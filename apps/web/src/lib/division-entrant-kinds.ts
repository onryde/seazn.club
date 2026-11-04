// May this division hold an entrant of kind K? The ONE predicate (FU1, controller ruling 1).
//
// A division's allowed kinds are the engine's effective entrant model: the sport module's declaration narrowed by the
// division's `config.entrants` override (`effectiveEntrantModel`, @seazn/engine/sport). The server resolves that model in
// one place (server/usecases/entrant-shape.ts) and these doors ask THIS predicate of it: creating an entrant, a registration
// settings save, the public register panel, a registration submit, materialising a registration into an entrant, and a
// division save that would take a kind out from under entrants or live registrations (divisions.ts). The organiser's
// registration settings panel asks it too, of the allowed kinds the page resolved on the server, so the select offers
// exactly what a save would take.
//
// NOT every door: bulk import (server/usecases/imports.ts, `entrant.create`) inserts `team` entrants with no kind check.
// That predates FU1 and lies outside registration; it is a follow-up, not covered here (FU1 review m9).
//
// Pure and client-safe: no server imports.

/** The named refusal, shared by every writer (HTTP 422). */
export const ENTRANT_KIND_NOT_ALLOWED = "ENTRANT_KIND_NOT_ALLOWED";

/** True when `kind` is one of the division's allowed kinds. */
export function divisionTakesKind(allowedKinds: readonly string[], kind: string): boolean {
  return allowedKinds.includes(kind);
}
