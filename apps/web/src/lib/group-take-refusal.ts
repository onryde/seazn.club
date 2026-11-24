// Add stage after groups (owner Option C, 2026-11-24): a knockout added after a stage of several pools takes ONE count, "Qualify to the
// knockout: N", split into a per-group take (`groupsKoTake`, the division builder's own). A count is only worth saving when the stage
// can later be drawn from it, so the refusals the cross-pool draw used to raise at DRAW time - once results existed and the format was
// locked - are asked here, at SAVE, where the shape is knowable (pool count + take), by the same codes:
//   SEEDING_QUALIFY_TOO_FEW            fewer places than a knockout's minimum (FORMAT_BOUNDS.qualify.min);
//   SEEDING_PAGE_PLAYOFF_NEEDS_FOUR    a page playoff takes exactly PAGE_PLAYOFF_SIZE;
//   SEEDING_CROSS_POOL_DRAW_TOO_LARGE  past the draw's bounds (`crossPoolTooLarge`, which the server's draw reads too);
//   SEEDING_POOL_SEPARATION_IMPOSSIBLE the builder's own question (`crossPoolShapeCanRefuse`, the engine's rule): for SOME set of pools
//                                      the best places could come from, no ordering keeps pool-mates apart in round one.
// A count above the field is RR_CUT_EXCEEDS_FIELD, asked by the usecase against the field (`takeCutIssue`), not here.
//
// Each refusal's vars carry `phase`, which picks the SAVE copy (`seeding.<CODE>.<phase>`, errors.json): "Pick one of ..." says what
// WOULD work here, where the draw-time copy ("delete the stage; results are in") is not true yet. A refusal that has nothing to
// pick says so (`saveNone`, `saveGroups`) rather than naming a remedy this form cannot offer (RB5-D4's lesson).
//
// Pure and client-safe: the form asks it for the count the organiser typed, the server asks it again as the authority.
import { expandTake, type TakeRule } from "@seazn/engine/competition";
import { crossPoolShapeCanRefuse } from "@/lib/cross-pool-draw-risk";
import { CROSS_POOL_SHAPES } from "@/lib/cross-pool-ties";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { PAGE_PLAYOFF_SIZE } from "@/lib/format-size-gates";
import { groupsKoTake } from "@/lib/format-templates";

const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A field the draw was never measured over: more pools or more qualifiers than the builder offers (D-B2-2). One predicate - the
 *  server's draw (`drawAcrossPools`) and the save door both read it. */
export function crossPoolTooLarge(pools: number, entrants: number): boolean {
  return pools > FORMAT_BOUNDS.pools.max || entrants > FORMAT_BOUNDS.qualify.max;
}

export type GroupTakeRefusalCode =
  | "SEEDING_QUALIFY_TOO_FEW"
  | "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR"
  | "SEEDING_CROSS_POOL_DRAW_TOO_LARGE"
  | "SEEDING_POOL_SEPARATION_IMPOSSIBLE";

export interface GroupTakeRefusal {
  code: GroupTakeRefusalCode;
  vars: Record<string, string | number>;
}

export interface GroupTakeAsk {
  /** The stage being added. */
  destKind: string;
  placement: string;
  /** The source stage's pool count. */
  pools: number;
  take: readonly TakeRule[];
  /** The field the groups hold, when known: it caps the counts a refusal may suggest. */
  entrants?: number | null;
}

/** How many places `take` opens across `pools` pools - the engine's own expansion. */
export function takeSlots(take: readonly TakeRule[], pools: number): number {
  return expandTake(take, { poolKeys: POOL_KEYS.slice(0, pools).split("") }).reduce((n, pot) => n + pot.length, 0);
}

/** Whether the ask is one this check judges: a stage drawn across pools (knockout, stepladder, page playoff) in rank order, from two or
 *  more pools, by pool places and best places only. Anything else is the organiser's own seating or never drawn across pools. */
function judged(ask: GroupTakeAsk): boolean {
  return (
    CROSS_POOL_SHAPES[ask.destKind] !== undefined &&
    ask.placement === "rank_order" &&
    ask.pools >= 2 &&
    ask.take.length > 0 &&
    ask.take.every((t) => t.kind === "topNPerGroup" || t.kind === "bestNth")
  );
}

/** The refusal without its options (a separation refusal names none yet), or null. */
function plainRefusal(ask: GroupTakeAsk): GroupTakeRefusal | null {
  if (!judged(ask)) return null;
  const q = takeSlots(ask.take, ask.pools);
  if (q < FORMAT_BOUNDS.qualify.min) return { code: "SEEDING_QUALIFY_TOO_FEW", vars: { pools: ask.pools, qualified: q, min: FORMAT_BOUNDS.qualify.min, phase: "save" } };
  if (ask.destKind === "page_playoff" && q !== PAGE_PLAYOFF_SIZE) {
    return { code: "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR", vars: { entrants: q, size: PAGE_PLAYOFF_SIZE, phase: "save" } };
  }
  if (crossPoolTooLarge(ask.pools, q)) {
    const vars = { pools: ask.pools, entrants: q, maxPools: FORMAT_BOUNDS.pools.max, maxEntrants: FORMAT_BOUNDS.qualify.max };
    // More groups than the draw takes: no count mends it, and the groups cannot be changed from here. Said as it is.
    return { code: "SEEDING_CROSS_POOL_DRAW_TOO_LARGE", vars: { ...vars, phase: ask.pools > FORMAT_BOUNDS.pools.max ? "saveGroups" : "save" } };
  }
  if (crossPoolShapeCanRefuse(CROSS_POOL_SHAPES[ask.destKind]!, ask.pools, ask.take)) {
    return { code: "SEEDING_POOL_SEPARATION_IMPOSSIBLE", vars: { pools: ask.pools, entrants: q, phase: "save" } };
  }
  return null;
}

/** What `ask` is refused for at save, or null. EMPTY CASE FIRST: an ask this check does not judge is null. The count is the take's own
 *  slots (`takeSlots`); a separation refusal names the counts that WOULD save (`options`: the nearest, ascending). */
export function groupTakeRefusal(ask: GroupTakeAsk): GroupTakeRefusal | null {
  const refusal = plainRefusal(ask);
  if (refusal?.code !== "SEEDING_POOL_SEPARATION_IMPOSSIBLE") return refusal;
  const options = nearest(groupTakeWorkingCounts(ask.destKind, ask.pools, ask.entrants ?? null), Number(refusal.vars.entrants), 4);
  return { code: refusal.code, vars: { ...refusal.vars, options: options.join(", "), phase: options.length > 0 ? "save" : "saveNone" } };
}

/** Every count a form may offer for a knockout-shaped `destKind` fed by `pools` pools, ascending: the builder's own split of the
 *  count, kept when nothing refuses it, from the minimum to min(the draw's max, the field when known). */
export function groupTakeWorkingCounts(destKind: string, pools: number, entrants: number | null): number[] {
  const hi = Math.min(FORMAT_BOUNDS.qualify.max, entrants ?? Infinity);
  const out: number[] = [];
  for (let q = FORMAT_BOUNDS.qualify.min; q <= hi; q++) {
    if (plainRefusal({ destKind, placement: "rank_order", pools, take: groupsKoTake(q, pools) }) === null) out.push(q);
  }
  return out;
}

/** The `n` counts of `counts` nearest `target` (ties to the smaller), ascending. */
function nearest(counts: readonly number[], target: number, n: number): number[] {
  return [...counts]
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)
    .slice(0, n)
    .sort((a, b) => a - b);
}
