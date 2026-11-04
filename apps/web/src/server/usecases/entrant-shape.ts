import "server-only";
// A division's EFFECTIVE entrant model (spec 2026-07-18): the pinned sport module's declaration merged with the division's
// `config.entrants` override, resolved by the engine (`effectiveEntrantModel`). Extracted from entrants.ts (FU1) so every
// door that asks "may this division hold kind K" - entrants, registration settings, the public register panel, submit and
// materialise - resolves the model the same way and asks the one predicate (@/lib/division-entrant-kinds).
import type postgres from "postgres";
import { HttpError } from "@/lib/errors";
import { ENTRANT_KIND_NOT_ALLOWED, divisionTakesKind } from "@/lib/division-entrant-kinds";
import { isChessSport } from "@/lib/chess-individual-only";
import { resolveModule } from "@/server/engine-db/registry";
import { effectiveEntrantModel, type EffectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";

/** The columns the model is resolved from. */
export interface EntrantShapeSource {
  sport_key: string;
  module_version: string;
  config: unknown;
}

/** The division's effective model, from a row the caller already read. Sports with no model (generic legacy) fall back
 *  to "all kinds, no cap" so existing divisions accept exactly what they always did. */
export function entrantShapeOf(division: EntrantShapeSource): EffectiveEntrantModel {
  let model = null;
  try {
    model = resolveModule(division.sport_key, division.module_version).entrantModel ?? null;
  } catch {
    // Retired module build - no declaration to resolve; treat as legacy shape.
  }
  return effectiveEntrantModel(model, division.config);
}

/** Read the division and resolve its model. Load ONCE per write call, not per row. 404 when there is no such division. */
export async function loadEntrantShape(tx: postgres.TransactionSql, divisionId: string): Promise<EffectiveEntrantModel> {
  const [d] = await tx<EntrantShapeSource[]>`
    select sport_key, module_version, config from divisions where id = ${divisionId}`;
  if (!d) throw new HttpError(404, "division not found");
  return entrantShapeOf(d);
}

/** Throw 422 ENTRANT_KIND_NOT_ALLOWED unless the division takes `kind`. The kind rides along (`kind`) so a reader can say
 *  the refusal in its own language (lib/entrant-kind-refusal.ts) rather than show this English. */
export function assertDivisionTakesKind(eff: Pick<EffectiveEntrantModel, "kinds">, kind: string): void {
  if (!divisionTakesKind(eff.kinds, kind)) {
    throw new HttpError(422, `this division doesn't take '${kind}' entrants`, ENTRANT_KIND_NOT_ALLOWED, { kind });
  }
}

/** The kind registration uses when none is stored or sent: the division's own default (FU1 ruling 3) - except chess,
 *  which takes individual players only (owner ruling 2026-10-26) whatever a legacy `config.entrants` override's
 *  `defaultKind` says (FU1 fix round 1 m4: such an override's `team` default made a save that named no kind 422
 *  CHESS_INDIVIDUAL_ONLY). */
export function registrationDefaultKind(division: EntrantShapeSource): EntrantKind {
  return isChessSport(division.sport_key) ? "individual" : entrantShapeOf(division).defaultKind;
}
