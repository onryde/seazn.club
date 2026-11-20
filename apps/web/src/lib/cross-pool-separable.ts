// W5 app PR B D-B2-2 (live matrix; engine 10.0.1): the engine's `crossPoolDraw` decides a REFUSAL by an exhaustive search - tier 1
// keeps its places and every later tier is permuted, depth-first, until no real round-one pair shares a pool - so a field it must
// refuse can cost the product of every later tier's permutations (measured: 5 pools Top 31, one call 196 s). This answers the same
// question - does ANY ordering the engine may try keep the pools apart? - from the engine's own rule, before its search runs.
//
// The rule (crossPoolDraw's doc, RB5-D3/D10): step 1 shuffles each `tied` run with the stored seed; step 2 holds tier 1 at its step-1
// places and lets each later tier take any order of its own places; the real round-one pairs are the shape's (`seedPositions` for a
// single elimination, a pair holding a seed beyond the field being a bye; a stepladder's first rung; a page playoff's 1v2 and 3v4).
//
// Why a later tier rarely matters: every tier holds each pool at most once (one place per pool, one best-Nth candidate per pool - an
// assumption, guarded below). Group a tier's places by the tier their round-one opponents sit in. A group of two or more places
// against one other tier (or against tier 1's fixed places) can always be paired off apart: each entrant clashes with at most ONE
// opponent there, so Hall's condition holds. Only a group of exactly ONE place binds - that place's entrant must differ from that one
// opponent. A tier with a spare place beyond its binding ones can always dodge (each binding place has one forbidden pool, one
// fewer than the tier's choices). So the whole question is the TIGHT tiers - every place a binding one: a search over a handful of
// places, never over a tier's permutations.
//
// Pure and client-safe. Exact for every input it answers; an input the engine refuses before searching (an empty field, a tier out
// of order, a broken tie link, a page playoff not of four) is left to the engine (null), which refuses it at no cost.
import { shuffle } from "@seazn/engine/core";
import { nextPowerOfTwo, seedPositions, type FirstRoundShape, type PooledSeed } from "@seazn/engine/scheduling";

/** The real round-one pairs the draw keeps apart, as 0-based seed indices: a single elimination's from the fold (`seedPositions`;
 *  a pair holding a seed beyond the field is a bye line), a stepladder's first rung (the two lowest seeds), a page playoff's 1v2 and
 *  3v4. The engine's `crossPoolDraw` reads the same pairs (bracket.ts `firstRoundPairs`). */
export function firstRoundPairs(shape: FirstRoundShape, n: number): [number, number][] {
  if (shape === "stepladder") return n >= 2 ? [[n - 2, n - 1]] : [];
  if (shape === "page_playoff") return [[0, 1], [2, 3]];
  const pos = seedPositions(nextPowerOfTwo(n));
  const pairs: [number, number][] = [];
  for (let i = 0; i < pos.length; i += 2) {
    const a = pos[i]!;
    const b = pos[i + 1]!;
    if (a <= n && b <= n) pairs.push([a - 1, b - 1]);
  }
  return pairs;
}

/** The answer and what it took: `separable` (null - an input the engine refuses before its search; left to it), and the binding
 *  places searched and the search's nodes (`places`, `nodes`), so a sweep can report what it checked. */
export interface SeparableAnswer {
  readonly separable: boolean | null;
  readonly places: number;
  readonly nodes: number;
}

/** Whether `crossPoolDraw(seeded, shape, drawSeed)` finds an ordering (true) or refuses `pool_separation_impossible` (false). */
export function crossPoolSeparable(seeded: readonly PooledSeed[], shape: FirstRoundShape, drawSeed: number): SeparableAnswer {
  const n = seeded.length;
  const defer: SeparableAnswer = { separable: null, places: 0, nodes: 0 };
  // The engine's input refusals run before its search and cost nothing: those inputs are its to refuse.
  if (n === 0 || !Number.isInteger(drawSeed) || (shape === "page_playoff" && n !== 4)) return defer;
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const s = seeded[i]!;
    const prev = seeded[i - 1];
    if (!Number.isInteger(s.tier) || s.tier < 1 || seen.has(s.entrantId)) return defer;
    if (prev !== undefined && s.tier < prev.tier) return defer;
    if (s.tied === true && (prev === undefined || prev.tier !== s.tier)) return defer;
    seen.add(s.entrantId);
  }
  // Step 1 (RB5-D3): each tied run in the stored seed's order - tier 1 keeps these places.
  const step1: PooledSeed[] = [];
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && seeded[j]!.tied === true) j++;
    const run = seeded.slice(i, j);
    step1.push(...(run.length > 1 ? shuffle(drawSeed, run) : run));
    i = j;
  }
  // The assumption the reduction stands on, guarded: a tier holds each pool at most once.
  const tierPools = new Map<number, Set<string>>();
  for (const s of step1) {
    const pools = tierPools.get(s.tier) ?? new Set<string>();
    if (pools.has(s.pool)) throw new Error(`cross-pool separation: tier ${s.tier} holds pool ${s.pool} twice - a tier is one place (or one best-Nth candidate) per pool`);
    pools.add(s.pool);
    tierPools.set(s.tier, pools);
  }
  const fixed = (p: number) => step1[p]!.tier === 1;
  const mateOf = new Map<number, number>();
  for (const [a, b] of firstRoundPairs(shape, n)) {
    // Tier 1 against tier 1 is never a same-pool pair: the tier holds each pool once (guarded above).
    mateOf.set(a, b);
    mateOf.set(b, a);
  }
  // Each later tier's places, grouped by where their opponents sit: tier 1 (`F`) or a later tier (its number). A group against the
  // tier's own places never binds (two of its entrants are never pool-mates).
  const groups = new Map<number, Map<string, number[]>>();
  for (let p = 0; p < n; p++) {
    const mate = mateOf.get(p);
    if (fixed(p) || mate === undefined) continue;
    const tier = step1[p]!.tier;
    const against = fixed(mate) ? "F" : String(step1[mate]!.tier);
    if (against === String(tier)) continue;
    const byTier = groups.get(tier) ?? new Map<string, number[]>();
    byTier.set(against, [...(byTier.get(against) ?? []), p]);
    groups.set(tier, byTier);
  }
  // A binding place: the only one of its tier against that opponent's tier. A TIGHT tier: every one of its places binds.
  const binding = new Set<number>();
  for (const byTier of groups.values()) for (const places of byTier.values()) if (places.length === 1) binding.add(places[0]!);
  const tight = new Set<number>();
  for (const tier of tierPools.keys()) {
    if (tier === 1) continue;
    const own = step1.flatMap((s, p) => (s.tier === tier ? [p] : []));
    if (own.every((p) => binding.has(p))) tight.add(tier);
  }
  // Search the tight tiers' places only: each takes an unused pool of its tier, apart from its opponent when that opponent is held
  // (tier 1) or already placed (another tight tier). A non-tight tier always finds a pool for each binding place (above).
  const places = step1.flatMap((s, p) => (tight.has(s.tier) ? [p] : []));
  const placed = new Map<number, string>();
  const used = new Map<number, Set<string>>();
  let nodes = 0;
  const opponentPool = (p: number): string | undefined => {
    const mate = mateOf.get(p);
    if (mate === undefined) return undefined;
    return fixed(mate) ? step1[mate]!.pool : placed.get(mate);
  };
  const place = (i: number): boolean => {
    if (i === places.length) return true;
    const p = places[i]!;
    const tier = step1[p]!.tier;
    const taken = used.get(tier) ?? new Set<string>();
    used.set(tier, taken);
    for (const pool of tierPools.get(tier)!) {
      nodes++;
      if (taken.has(pool) || opponentPool(p) === pool) continue;
      taken.add(pool);
      placed.set(p, pool);
      if (place(i + 1)) return true;
      taken.delete(pool);
      placed.delete(p);
    }
    return false;
  };
  return { separable: place(0), places: places.length, nodes };
}
