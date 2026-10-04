// W1d D4: a shard is a stripe of the plan — item i (0-based) belongs to shard
// (i mod N) + 1. A pure function of plan order: the same case lands in the
// same shard on every run (ruling 61 compares per case across runs), and the
// N stripes are the plan with no overlap — merge.ts rebuilds it by interleaving.
import { MAX_SHARDS } from "./results.ts";

export type Shard = { index: number; of: number };

export class BadShard extends Error {
  constructor(text: string) {
    super(`--shard ${JSON.stringify(text)} is not k/N with 1 ≤ k ≤ N and 2 ≤ N ≤ ${MAX_SHARDS}`);
    this.name = "BadShard";
  }
}

/** `k/N`: two positive integers with no sign, no space and no leading zero. */
export function parseShard(text: string): Shard {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  if (m === null) throw new BadShard(text);
  const index = Number(m[1]);
  const of = Number(m[2]);
  if (of < 2 || of > MAX_SHARDS || index > of) throw new BadShard(text);
  return { index, of };
}

/** The items shard `s` runs, in plan order. */
export function stripe<T>(items: readonly T[], s: Shard): T[] {
  return items.filter((_, i) => i % s.of === s.index - 1);
}

/** How many items `stripe` gives shard `s` of a plan of `planSize`, without the plan: the count of
 *  i in [0, planSize) with i mod N = k-1, which is ceil((planSize - (k-1)) / N) — written as the
 *  floor that equals it, so the integer maths is exact and a stripe past the plan's end is 0 (k <= N). */
export function stripeSize(planSize: number, s: Shard): number {
  return Math.floor((planSize + s.of - s.index) / s.of);
}
