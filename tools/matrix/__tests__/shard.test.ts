// W1d Task 4 (D4): `--shard k/N` is a stripe of the plan — a pure function of
// plan order, so the same case lands in the same shard on every run (ruling 61
// compares each case across runs). Sport-agnostic by construction: the stripe
// sees opaque plan items and never reads a sport, so these tests sweep plan
// SHAPES (empty, shorter than N, a prime length, N at the cap), not sports.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_SHARDS } from "../lib/results.ts";
import { BadShard, parseShard, stripe, stripeSize } from "../lib/shard.ts";

describe("parseShard", () => {
  it.each(["0/2", "3/2", "1/1", "1/65", "a/2", "1/2/3", "", "1/ 2", "01/2", "1/02", "-1/2", "1.5/2", " 1/2", "1/2 ", "1/2\n"])("refuses %j", (s) => {
    expect(() => parseShard(s)).toThrow(BadShard);
    expect(() => parseShard(s)).toThrow(expect.objectContaining({ name: "BadShard" }));
  });
  it("reads k/N", () => expect(parseShard("3/12")).toEqual({ index: 3, of: 12 }));
  it("accepts both edges: 1/2 (smallest) and MAX/MAX (the cap, from the schema's own constant)", () => {
    expect(parseShard("1/2")).toEqual({ index: 1, of: 2 });
    expect(parseShard(`${MAX_SHARDS}/${MAX_SHARDS}`)).toEqual({ index: MAX_SHARDS, of: MAX_SHARDS });
    expect(() => parseShard(`1/${MAX_SHARDS + 1}`)).toThrow(BadShard);
  });
  it("the refusal quotes the bad text and states the range, so a usage error is self-explaining", () => {
    expect(() => parseShard("3/2")).toThrow(`--shard "3/2" is not k/N with 1 ≤ k ≤ N and 2 ≤ N ≤ ${MAX_SHARDS}`);
  });
});

describe("stripe (rule 10: the union is the plan, in order, with no overlap, on every run)", () => {
  it("the empty plan: every shard is empty and stripeSize says 0", () => {
    expect(stripe([], { index: 1, of: 2 })).toEqual([]);
    expect(stripeSize(0, { index: 1, of: 2 })).toBe(0);
  });
  it("a plan shorter than N leaves the high shards empty", () => {
    expect(stripe(["a"], { index: 2, of: 3 })).toEqual([]);
    expect(stripeSize(1, { index: 2, of: 3 })).toBe(0);
    expect(stripe(["a"], { index: 1, of: 3 })).toEqual(["a"]);
    expect(stripeSize(1, { index: 1, of: 3 })).toBe(1);
  });
  it("a hand-worked plan: item i belongs to shard (i mod N) + 1 — the expected values are written out, not computed", () => {
    const plan = ["a", "b", "c", "d", "e"];
    expect(stripe(plan, { index: 1, of: 2 })).toEqual(["a", "c", "e"]);
    expect(stripe(plan, { index: 2, of: 2 })).toEqual(["b", "d"]);
    expect(stripe(plan, { index: 1, of: 3 })).toEqual(["a", "d"]);
    expect(stripe(plan, { index: 2, of: 3 })).toEqual(["b", "e"]);
    expect(stripe(plan, { index: 3, of: 3 })).toEqual(["c"]);
    expect([1, 2, 3].map((k) => stripeSize(5, { index: k, of: 3 }))).toEqual([2, 2, 1]);
  });
  it("a prime-length plan over 12 shards (the L2 job count): 937 = 12 x 78 + 1, so shard 1 holds 79 and the other eleven 78", () => {
    const sizes = Array.from({ length: 12 }, (_, k) => stripeSize(937, { index: k + 1, of: 12 }));
    expect(sizes).toEqual([79, ...Array<number>(11).fill(78)]);
    const plan = Array.from({ length: 937 }, (_, i) => `c${i}`);
    expect(Array.from({ length: 12 }, (_, k) => stripe(plan, { index: k + 1, of: 12 }).length)).toEqual(sizes);
  });
  it("stripeSize is the count of plan positions i with i mod N = k-1 — swept over every plan size 0..40, every N 2..9 and every k, not sampled", () => {
    let checked = 0;
    for (let n = 0; n <= 40; n++) {
      for (let of = 2; of <= 9; of++) {
        for (let k = 1; k <= of; k++) {
          // The definition itself, counted position by position.
          const want = Array.from({ length: n }, (_, i) => i).filter((i) => i % of === k - 1).length;
          expect(stripeSize(n, { index: k, of }), `plan ${n}, shard ${k}/${of}`).toBe(want);
          checked++;
        }
      }
    }
    // 41 plan sizes x (2+3+…+9 = 44) shards.
    expect(checked).toBe(41 * 44);
  });
  it("property: interleaving the N stripes round-robin rebuilds the plan exactly", () => {
    let checked = 0;
    fc.assert(fc.property(fc.array(fc.integer(), { maxLength: 300 }), fc.integer({ min: 2, max: 64 }), (plan, of) => {
      const parts = Array.from({ length: of }, (_, k) => stripe(plan, { index: k + 1, of }));
      parts.forEach((p, k) => expect(p).toHaveLength(stripeSize(plan.length, { index: k + 1, of })));
      const rebuilt: number[] = [];
      for (let i = 0; i < plan.length; i++) rebuilt.push(parts[i % of][Math.floor(i / of)]);
      expect(rebuilt).toEqual(plan);
      expect(parts.reduce((n, p) => n + p.length, 0)).toBe(plan.length);
      checked++;
    }), { numRuns: 300 });
    expect(checked).toBe(300);
  });
  it("property: no two stripes share an item (unique plan items land in exactly one stripe)", () => {
    let checked = 0;
    fc.assert(fc.property(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 2, max: 64 }), (n, of) => {
      const plan = Array.from({ length: n }, (_, i) => `case-${i}`);
      const seen = new Map<string, number>();
      for (let k = 1; k <= of; k++) for (const item of stripe(plan, { index: k, of })) seen.set(item, (seen.get(item) ?? 0) + 1);
      expect(seen.size).toBe(n);
      expect([...seen.values()].every((v) => v === 1)).toBe(true);
      checked++;
    }), { numRuns: 200 });
    expect(checked).toBe(200);
  });
  it("a second call is identical (the partition is a pure function of plan order)", () => {
    const plan = Array.from({ length: 937 }, (_, i) => `c${i}`);
    expect(stripe(plan, { index: 2, of: 2 })).toEqual(stripe(plan, { index: 2, of: 2 }));
    // …and it does not consume or reorder its input.
    expect(plan[0]).toBe("c0");
    expect(plan).toHaveLength(937);
  });
  it("a case keeps its shard when the plan is run again: the same plan, two calls, the same case in the same stripe (ruling 61)", () => {
    const plan = () => Array.from({ length: 233 }, (_, i) => `league|generic|score|S${i}`);
    const shardOfCase = (items: readonly string[], of: number): Map<string, number> => {
      const m = new Map<string, number>();
      for (let k = 1; k <= of; k++) for (const c of stripe(items, { index: k, of })) m.set(c, k);
      return m;
    };
    const first = shardOfCase(plan(), 7);
    const second = shardOfCase(plan(), 7);
    expect(first.size).toBe(233);
    expect(second).toEqual(first);
  });
});
