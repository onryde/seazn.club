// W5 app PR B Task 5 part 3 (RB5-D10, X-PD-4; owner 288 REC-12; controller ruling, owner standing "apply rec"): the division builder
// says BEFORE Start that a format's knockout draw can be refused. The engine's cross-pool draw keeps the pool winners in their fold
// places and swaps only within a later rank tier (X-PD-4), so a field whose later tier has too few seats to move - two pools' winners
// and the best runner-up into a 4-draw, the rulebook's named case - is refused whenever that runner-up shares a pool with the winner
// she would meet. Which finishers qualify is unknown until the groups are played, so the builder asks, for every set of pools the
// drafts' best-Nth seats could come from: would the engine's `crossPoolDraw` refuse it (`pool_separation_impossible`)? One refused
// set is enough to warn.
//
// Asked of the engine's own rule BEFORE its search (`crossPoolSeparable`, the same pre-search answer the server's draw takes; B2
// review m-1): the engine decides a refusal by trying every ordering - 5 pools Top 31 took one call 196 s - so the builder used to
// stay silent past a search budget, on exactly the six slow fields that refuse. The oracle's every answer is the engine's: its test
// asks `crossPoolDraw` itself over the builder's whole space (lib/__tests__/cross-pool-separable.test.ts). Never a hand-typed shape
// table. Pure and client-safe (the builder runs it while the organiser edits the knobs).
import type { TakeRule } from "@seazn/engine/competition";
import type { FirstRoundShape, PooledSeed } from "@seazn/engine/scheduling";
import { crossPoolSeparable } from "@/lib/cross-pool-separable";
import { CROSS_POOL_SHAPES } from "@/lib/cross-pool-ties";
import type { StageDraft } from "@/lib/format-templates";

/** Whether the engine's draw refuses a field for NONE of the sets of pools its best places could come from, for SOME of them, or for ALL.
 *  "never" also answers a field with no set at all (a best tier asking more pools than there are): "every set refuses" over no set
 *  is vacuously true, so "always" is never read from an empty enumeration. */
export type CrossPoolRefusalKind = "never" | "sometimes" | "always";

/** The answer per field (shape, pools, take): a handful of shapes per builder session, each asked once. */
const answered = new Map<string, CrossPoolRefusalKind>();

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

/** How many of the sets of pools the best-Nth seats could come from make the engine's draw refuse by name: none, some or all. One
 *  enumeration answers both questions (the builder's "can refuse", the save door's "always refuses"); it stops at the first two
 *  differing answers, so a field that only can refuse costs what it did. */
function refusalKindOf(shape: FirstRoundShape, poolCount: number, take: readonly TakeRule[]): CrossPoolRefusalKind {
  const pools = Array.from({ length: poolCount }, (_, p) => String.fromCharCode(65 + p));
  // The fold's tiers: every pool's places 1..n (pool order), then each best-Nth tier's seats from some `count` of the pools.
  const fixed: PooledSeed[] = take.flatMap((t) =>
    t.kind === "topNPerGroup" ? Array.from({ length: t.n }, (_, r) => pools.map((pool) => ({ entrantId: `${pool}${r + 1}`, pool, tier: r + 1 }))).flat() : [],
  );
  const best = take.flatMap((t) => (t.kind === "bestNth" ? [{ nth: t.nth, choices: subsets(pools, t.count) }] : []));
  let refused = 0;
  let separated = 0;
  for (const pick of product(best.map((b) => b.choices))) {
    const seeds = [...fixed, ...pick.flatMap((set, b) => set.map((pool) => ({ entrantId: `${pool}${best[b]!.nth}`, pool, tier: best[b]!.nth })))].sort((x, y) => x.tier - y.tier);
    // false: refused `pool_separation_impossible`. null: an input the engine refuses on sight for another reason (a page playoff
    // not of four) - said elsewhere, not this warning's. No seed is tied here, so the draw seed decides nothing.
    if (crossPoolSeparable(seeds, shape, 1).separable === false) refused += 1;
    else separated += 1;
    if (refused > 0 && separated > 0) return "sometimes";
  }
  // A mixed field has returned already, so what is left is every set refused, or none (and none at all - no set exists - is "never").
  return refused > 0 ? "always" : "never";
}

/** Whether a stage the drafts feed from a group of two or more pools - a knockout, stepladder or page playoff placed in rank order from
 *  pool places (`topNPerGroup`) and best places (`bestNth`) - has a qualifying field the engine's cross-pool draw refuses
 *  (`pool_separation_impossible`). False for anything the draw never runs on: a league source, one pool, a `picks` or `seeded_map`
 *  placement (the organiser's own seats), a group destination. */
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
    if (crossPoolShapeCanRefuse(shape, poolCount, take)) return true;
  }
  return false;
}

/** The same question for ONE field: `poolCount` pools feeding a stage drawn in `shape` by `take` (pool places and best places only),
 *  answered "never", "sometimes" or "always" refused. The Add stage form and its save door ask it of the stage they are adding
 *  (`group-take-refusal.ts`), so the builder's warning, the save refusal and the draw's own refusal are one rule. Answered once per
 *  field. */
export function crossPoolShapeRefusalKind(shape: FirstRoundShape, poolCount: number, take: readonly TakeRule[]): CrossPoolRefusalKind {
  const key = JSON.stringify([shape, poolCount, take]);
  let kind = answered.get(key);
  if (kind === undefined) {
    kind = refusalKindOf(shape, poolCount, take);
    answered.set(key, kind);
  }
  return kind;
}

/** Whether the draw can refuse the field for some set of pools the best places come from: the builder's warning, and the Add stage form's
 *  filter (it offers only a count that can never refuse). */
export function crossPoolShapeCanRefuse(shape: FirstRoundShape, poolCount: number, take: readonly TakeRule[]): boolean {
  return crossPoolShapeRefusalKind(shape, poolCount, take) !== "never";
}

/** Whether the draw refuses the field for EVERY set of pools the best places could come from: the save door's refusal. A shape that
 *  only can refuse is saved, and the draw refuses it by name once the groups are played. */
export function crossPoolShapeAlwaysRefuses(shape: FirstRoundShape, poolCount: number, take: readonly TakeRule[]): boolean {
  return crossPoolShapeRefusalKind(shape, poolCount, take) === "always";
}
