// Add stage after groups (owner Option C, 2026-11-24): the form's ONE count, "Qualify to the knockout: N", is split into a per-group take
// by the SAME function the division builder's Groups + Knockout uses (format-templates.ts `groupsKoTake`), never a second copy.
// Expected values come from the rule (q = pools * n + r, wave-major: every pool's winner, then every pool's runner-up ...) derived
// here by SEATING the qualifiers one at a time, and from the engine's own `expandTake` (how many slots the take opens).
// Pure: no DB, no DOM. Sweeps pools 2..8 (FORMAT_BOUNDS.pools) x q 2..32 (FORMAT_BOUNDS.qualify) and reports what it checked.
import { describe, expect, it } from "vitest";
import { expandTake } from "@seazn/engine/competition";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { buildTemplateStages, groupsKoTake, splitQualifiers } from "@/lib/format-templates";

const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const poolKeys = (pools: number) => POOL_KEYS.slice(0, pools).split("");

/** The rule, derived by seating q qualifiers one by one, a wave (one place from every pool) at a time. */
function seated(q: number, pools: number): { n: number; r: number } {
  const perWave: number[] = [];
  for (let seat = 0; seat < q; seat++) perWave[Math.floor(seat / pools)] = (perWave[Math.floor(seat / pools)] ?? 0) + 1;
  const full = perWave.filter((c) => c === pools).length;
  const partial = perWave.find((c) => c < pools) ?? 0;
  return { n: full, r: partial };
}

describe("splitQualifiers: q = pools * n + r", () => {
  it("sweep: every pools 2..8 x q 2..32 matches the seated derivation, and reconstructs q", () => {
    let checked = 0;
    for (let pools = FORMAT_BOUNDS.pools.min; pools <= FORMAT_BOUNDS.pools.max; pools++) {
      for (let q = FORMAT_BOUNDS.qualify.min; q <= FORMAT_BOUNDS.qualify.max; q++) {
        const want = seated(q, pools);
        const got = splitQualifiers(q, pools);
        expect(got, `${pools} pools, q ${q}`).toEqual(want);
        expect(got.n * pools + got.r, `${pools} pools, q ${q}: reconstructs q`).toBe(q);
        expect(got.r, `${pools} pools, q ${q}: remainder is below the pool count`).toBeLessThan(pools);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: the whole 7 x 31 grid").toBe(7 * 31);
  });

  it("the wrong answer differs from the right constant: 10 from 4 pools is 2 + 2, 10 from 3 pools is 3 + 1 (a hard-coded split would fail one)", () => {
    expect(splitQualifiers(10, 4)).toEqual({ n: 2, r: 2 });
    expect(splitQualifiers(10, 3)).toEqual({ n: 3, r: 1 });
    expect(splitQualifiers(3, 4)).toEqual({ n: 0, r: 3 });
  });
});

describe("groupsKoTake: the take the builder's Groups + Knockout saves", () => {
  it("shapes: whole waves omit the best-Nth; a remainder takes the NEXT place; fewer than the pools is a best-Nth of winners only", () => {
    expect(groupsKoTake(8, 4)).toEqual([{ kind: "topNPerGroup", n: 2 }]);
    expect(groupsKoTake(10, 4)).toEqual([{ kind: "topNPerGroup", n: 2 }, expect.objectContaining({ kind: "bestNth", nth: 3, count: 2 })]);
    expect(groupsKoTake(3, 4)).toEqual([expect.objectContaining({ kind: "bestNth", nth: 1, count: 3 })]);
  });

  it("sweep: the engine's own expandTake opens exactly q slots for every pools x q (the take means what the count says)", () => {
    let checked = 0;
    for (let pools = FORMAT_BOUNDS.pools.min; pools <= FORMAT_BOUNDS.pools.max; pools++) {
      for (let q = FORMAT_BOUNDS.qualify.min; q <= FORMAT_BOUNDS.qualify.max; q++) {
        const slots = expandTake(groupsKoTake(q, pools), { poolKeys: poolKeys(pools) }).reduce((n, pot) => n + pot.length, 0);
        expect(slots, `${pools} pools, q ${q}`).toBe(q);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(7 * 31);
  });

  it("one copy: the groups_ko template's own take IS groupsKoTake (the builder and Add stage cannot drift apart)", () => {
    let checked = 0;
    for (const [pools, q] of [[4, 8], [4, 10], [3, 10], [2, 3], [8, 32], [5, 4]] as const) {
      const stages = buildTemplateStages("groups_ko", { qualified: q, poolCount: pools, swissRounds: 3, legs: 1 });
      expect(stages[1]!.progression!.sources[0]!.take, `${pools} pools, q ${q}`).toEqual(groupsKoTake(q, pools));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(6);
  });
});
