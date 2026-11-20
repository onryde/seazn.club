// W5 app PR B Task 5 part 3 (RB5-D10, X-PD-4; owner 288 REC-12; controller ruling, owner standing "apply rec"): the division builder
// says BEFORE Start that a format's knockout draw can be refused. The engine's cross-pool draw keeps the pool winners in their fold
// places and swaps only within a later rank tier (X-PD-4), so a field whose later tier has too few seats to move - two pools' winners
// and the best runner-up into a 4-draw, the rulebook's named case - is refused whenever that runner-up shares a pool with the winner
// she would meet. Which finishers qualify is unknown until the groups are played, so the builder asks the ENGINE: for every set of
// pools the drafts' best-Nth seats could come from, is `crossPoolDraw` refused by name? One refused set is enough to warn.
//
// Never a hand-typed shape table: the answer is the engine's own `crossPoolDraw` over the drafts the builder is about to send.
// Pure and client-safe (the builder runs it while the organiser edits the knobs).
import { EngineError } from "@seazn/engine/core";
import type { TakeRule } from "@seazn/engine/competition";
import { crossPoolDraw, type FirstRoundShape, type PooledSeed } from "@seazn/engine/scheduling";
import { CROSS_POOL_SHAPES } from "@/lib/cross-pool-ties";
import type { StageDraft } from "@/lib/format-templates";

/** The orderings the engine may search for one field: it keeps tier 1 (the pool winners) in place and permutes the seats of every
 *  later tier (X-PD-4: the search is exhaustive over the tiers), so a REFUSAL can cost the product of each later tier's seat count
 *  factorial. Measured on engine 10.0.1 (groups_ko, one best-Nth seat): 3 pools Top 31 (6^9, about 10^7) refused in 17 ms; 4 pools
 *  Top 29 (24^6, about 2*10^8) in 1 s; 5 pools Top 31 ((5!)^5, about 2.5*10^10) ran one call past 190 s. The builder asks while the
 *  organiser types, so it asks only within this budget and stays silent beyond it - the confirm still refuses such a field by name.
 *  A bound on the engine's search, not a shape rule: which fields refuse is always the engine's own answer. */
export const DRAW_SEARCH_BUDGET = 10_000_000;

/** The search space of one field's later tiers (`seats`: tier -> seats in it), stopping once past the budget. */
export function drawSearchSpace(seats: ReadonlyMap<number, number>): number {
  let space = 1;
  for (const [tier, n] of seats) {
    if (tier < 2) continue;
    for (let k = 2; k <= n; k++) {
      space *= k;
      if (space > DRAW_SEARCH_BUDGET) return space;
    }
  }
  return space;
}

/** The engine's answer per field (shape, pools, take): a handful of shapes per builder session, each asked once. */
const answered = new Map<string, boolean>();

/** Every `k`-subset of `items`, in order. */
function subsets<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [head!, ...s]), ...subsets(rest, k)];
}

/** Every combination of one choice per list (the cartesian product). */
function product<T>(lists: readonly (readonly T[])[]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);
}

/** Whether some set of pools the best-Nth seats could come from makes the engine's draw refuse by name. */
function refusedForSomeSupply(shape: FirstRoundShape, poolCount: number, take: readonly TakeRule[]): boolean {
  const pools = Array.from({ length: poolCount }, (_, p) => String.fromCharCode(65 + p));
  // The fold's tiers: every pool's places 1..n (pool order), then each best-Nth tier's seats from some `count` of the pools.
  const fixed: PooledSeed[] = take.flatMap((t) =>
    t.kind === "topNPerGroup" ? Array.from({ length: t.n }, (_, r) => pools.map((pool) => ({ entrantId: `${pool}${r + 1}`, pool, tier: r + 1 }))).flat() : [],
  );
  const best = take.flatMap((t) => (t.kind === "bestNth" ? [{ nth: t.nth, choices: subsets(pools, t.count) }] : []));
  for (const pick of product(best.map((b) => b.choices))) {
    const seeds = [...fixed, ...pick.flatMap((set, b) => set.map((pool) => ({ entrantId: `${pool}${best[b]!.nth}`, pool, tier: best[b]!.nth })))].sort((x, y) => x.tier - y.tier);
    try {
      crossPoolDraw(seeds, shape, 1);
    } catch (e) {
      if (e instanceof EngineError && (e.data as { reason?: unknown } | undefined)?.reason === "pool_separation_impossible") return true;
      // Any other refusal (a page playoff not of four, a size the bound checks refuse) is said elsewhere; it is not this warning's.
    }
  }
  return false;
}

/** Whether a stage the drafts feed from a group of two or more pools - a knockout, stepladder or page playoff placed in rank order from
 *  pool places (`topNPerGroup`) and best places (`bestNth`) - has a qualifying field the engine's cross-pool draw refuses
 *  (`pool_separation_impossible`). False for anything the draw never runs on: a league source, one pool, a `picks` or `seeded_map`
 *  placement (the organiser's own seats), a group destination; and false past `DRAW_SEARCH_BUDGET`. */
export function crossPoolDrawCanRefuse(stages: readonly StageDraft[]): boolean {
  for (let i = 1; i < stages.length; i++) {
    const src = stages[i - 1]!;
    const dst = stages[i]!;
    const shape = CROSS_POOL_SHAPES[dst.kind];
    const progression = dst.progression;
    if (shape === undefined || progression === null || progression.placement !== "rank_order" || progression.sources.length !== 1) continue;
    const poolCount = src.kind === "group" ? (src.config.pools as { count?: unknown } | undefined)?.count : undefined;
    if (typeof poolCount !== "number" || poolCount < 2) continue;
    const take = progression.sources[0]!.take;
    if (take.length === 0 || !take.every((t) => t.kind === "topNPerGroup" || t.kind === "bestNth")) continue;
    const seats = new Map<number, number>();
    for (const t of take) {
      if (t.kind === "topNPerGroup") for (let r = 1; r <= t.n; r++) seats.set(r, (seats.get(r) ?? 0) + poolCount);
      else if (t.kind === "bestNth") seats.set(t.nth, (seats.get(t.nth) ?? 0) + t.count);
    }
    if (drawSearchSpace(seats) > DRAW_SEARCH_BUDGET) continue;
    const key = JSON.stringify([shape, poolCount, take]);
    let refused = answered.get(key);
    if (refused === undefined) {
      refused = refusedForSomeSupply(shape, poolCount, take);
      answered.set(key, refused);
    }
    if (refused) return true;
  }
  return false;
}
