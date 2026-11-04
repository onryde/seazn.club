// May this division hold an entrant of kind K? The ONE predicate (FU1, controller ruling 1).
//
// A division's allowed kinds are the engine's effective entrant model: the sport module's declaration narrowed by the
// division's `config.entrants` override (`effectiveEntrantModel`, @seazn/engine/sport). The server resolves that model in
// one place (server/usecases/entrant-shape.ts) and every door asks THIS predicate of it: creating an entrant, a registration
// settings save, the public register panel, a registration submit, and materialising a registration into an entrant. The
// organiser's registration settings panel asks it too, of the allowed kinds the page resolved on the server, so the select
// offers exactly what a save would take.
//
// Pure and client-safe: no server imports.

/** The named refusal, shared by every writer (HTTP 422). */
export const ENTRANT_KIND_NOT_ALLOWED = "ENTRANT_KIND_NOT_ALLOWED";

/** True when `kind` is one of the division's allowed kinds. */
export function divisionTakesKind(allowedKinds: readonly string[], kind: string): boolean {
  return allowedKinds.includes(kind);
}
