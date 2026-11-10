// The knockout draw: who a root knockout's Generate places where. A leaf of the engine-db layer (it needs only lib/swiss-draw),
// so the completion read (engine-db/competition.ts) and Generate (usecases/stages/generate-tx.ts) share ONE rule without an
// import cycle. Re-exported from usecases/stages/generators.ts for the existing importers.
import { swissDrawSeed, swissRoundOneOrder } from "@/lib/swiss-draw";
import type { ActiveEntrant } from "@/server/usecases/stages/types";

/**
 * W4 T7 (K5; RB4-D3, RB4-D6, X-SD-6/X-SD-9): whether a knockout's Generate DRAWS its field — the unseeded entrants placed
 * at random (`knockoutDrawOrder`), never in registration order. Not when an API `slotOrder` is set (RB4-D6: the slot map
 * overrides the draw, and it indexes into the field as given), nor when the stage draws from `config.qualified` (a fed
 * stage: that order IS the seeding), nor when nobody is unseeded (a wholly seeded field is the fold alone, X-SW-22's rule).
 */
export function knockoutDraws(active: readonly ActiveEntrant[], cfg: Record<string, unknown>): boolean {
  return !Array.isArray(cfg.slotOrder) && !Array.isArray(cfg.qualified) && active.some((e) => e.seed === null);
}

/**
 * W4 T7 (K5; RB4-D3/D4): a root knockout's field in DRAW order — the seeded first, by seed (the engine folds them,
 * RB4-D1/D2), then the unseeded shuffled with the stage's own seed (`swissRoundOneOrder(swissDrawSeed(stageId), …)`, the
 * W3 draw: one PRNG, one seed rule, so the same stage and the same field always draw the same bracket — RB4-D4, and a
 * Rebuild reuses it, RB4-D5). `active` itself (a copy, in its order) when the stage does not draw (`knockoutDraws`).
 */
export function knockoutDrawOrder(stageId: string, active: readonly ActiveEntrant[], cfg: Record<string, unknown>): ActiveEntrant[] {
  if (!knockoutDraws(active, cfg)) return [...active];
  const byId = new Map(active.map((e) => [e.id, e]));
  return swissRoundOneOrder(swissDrawSeed(stageId), active).map((id) => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`knockoutDrawOrder: the draw returned ${id}, which is not in the field`);
    return e;
  });
}


/** The order a ROOT bracket stage was laid out in (review M2): Generate draws ONLY a knockout (generate-tx.ts); every other
 *  bracket kind (double_elim, stepladder, page_playoff) is placed in `active` order. The completion read rebuilds its draw
 *  seeds with this, so it can never invent a shuffle Generate did not use. */
export function rootBracketOrder(kind: string, stageId: string, active: readonly ActiveEntrant[], cfg: Record<string, unknown>): string[] {
  return kind === "knockout" ? knockoutDrawOrder(stageId, active, cfg).map((e) => e.id) : active.map((e) => e.id);
}
