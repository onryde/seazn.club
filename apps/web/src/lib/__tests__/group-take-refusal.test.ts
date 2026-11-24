// Add stage after groups: the cross-pool refusals that used to fire only at DRAW time (SEEDING_POOL_SEPARATION_IMPOSSIBLE,
// SEEDING_CROSS_POOL_DRAW_TOO_LARGE, SEEDING_PAGE_PLAYOFF_NEEDS_FOUR) are asked at SAVE, where the shape (pool count + take) is
// knowable, and a count under the knockout's minimum is refused by name. One predicate per refusal, the draw's own: the separation
// answer is the builder's `crossPoolShapeCanRefuse` (itself `crossPoolSeparable`, the engine's rule), the size bound is
// `crossPoolTooLarge` (also read by the server's draw), the page playoff's four is PAGE_PLAYOFF_SIZE.
// Expected values: X-PD-4 (rulebook) for the separation cases - the same named cases cross-pool-draw-risk.test.ts takes from
// cross-sport.md - and FORMAT_BOUNDS for the size bounds; the options the copy offers are checked by RE-ASKING the predicate
// through the builder's own graph (`crossPoolDrawCanRefuse` over `buildTemplateStages`), an independent route.
// Pure: no DB, no DOM.
import { describe, expect, it } from "vitest";
import { crossPoolDrawCanRefuse } from "@/lib/cross-pool-draw-risk";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { PAGE_PLAYOFF_SIZE } from "@/lib/format-size-gates";
import { buildTemplateStages, groupsKoTake } from "@/lib/format-templates";
import { crossPoolTooLarge, groupTakeRefusal, groupTakeWorkingCounts } from "@/lib/group-take-refusal";

const ask = (pools: number, q: number, destKind = "knockout") => groupTakeRefusal({ destKind, placement: "rank_order", pools, take: groupsKoTake(q, pools) });
const builderRefuses = (pools: number, q: number) => crossPoolDrawCanRefuse(buildTemplateStages("groups_ko", { qualified: q, poolCount: pools, swissRounds: 3, legs: 1 }));

describe("groupTakeRefusal: what a per-group take from several groups is refused for at save", () => {
  it("accepts the common shapes: 4 groups Top 2 (8), 4 groups Top 2 + 2 best thirds (10), 2 groups Top 2 (4), 3 groups Top 2 (6)", () => {
    for (const [pools, q] of [[4, 8], [4, 10], [2, 4], [3, 6]] as const) expect(ask(pools, q), `${pools} groups, ${q} through`).toBeNull();
  });

  it("X-PD-4's named cases: two groups' winners + the best runner-up (3), three groups' winners + one (4) are SEEDING_POOL_SEPARATION_IMPOSSIBLE", () => {
    for (const [pools, q] of [[2, 3], [3, 4]] as const) {
      const refusal = ask(pools, q);
      expect(refusal?.code, `${pools} groups, ${q} through`).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
      expect(refusal!.vars).toMatchObject({ pools, entrants: q, phase: "save" });
    }
  });

  it("sweep: every pools 2..8 x q 2..32 is refused EXACTLY when the builder's own warning says the draw can refuse (or a bound is passed)", () => {
    let checked = 0;
    let refused = 0;
    for (let pools = FORMAT_BOUNDS.pools.min; pools <= FORMAT_BOUNDS.pools.max; pools++) {
      for (let q = FORMAT_BOUNDS.qualify.min; q <= FORMAT_BOUNDS.qualify.max; q++) {
        const got = ask(pools, q);
        expect(got !== null, `${pools} groups, ${q} through`).toBe(builderRefuses(pools, q));
        if (got !== null) {
          expect(got.code, `${pools} groups, ${q} through`).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
          refused += 1;
        }
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: the whole grid").toBe(7 * 31);
    expect(refused, "anti-vacuity: the grid holds refusals (else 'exactly when' is one-sided)").toBeGreaterThan(10);
  });

  it("the options the copy names are shapes that DO save, the nearest ones, ascending, and never the refused count itself", () => {
    let checked = 0;
    for (const [pools, q] of [[2, 3], [3, 4], [4, 5], [4, 13], [5, 6], [8, 9]] as const) {
      const refusal = ask(pools, q)!;
      const options = String(refusal.vars.options).split(", ").map(Number);
      expect(options.length, `${pools} groups, ${q}: options named`).toBeGreaterThan(0);
      expect(options, `${pools} groups, ${q}: ascending`).toEqual([...options].sort((a, b) => a - b));
      for (const o of options) {
        expect(builderRefuses(pools, o), `${pools} groups: ${o} is offered`).toBe(false);
        expect(ask(pools, o), `${pools} groups: ${o} saves`).toBeNull();
        expect(o).not.toBe(q);
        checked += 1;
      }
      // Nearest: no working count lies strictly closer to q than the farthest offered one, unless it is offered.
      const working = groupTakeWorkingCounts("knockout", pools, null);
      const farthest = Math.max(...options.map((o) => Math.abs(o - q)));
      for (const w of working) if (Math.abs(w - q) < farthest) expect(options, `${pools} groups, ${q}: ${w} is nearer than an offered count`).toContain(w);
    }
    expect(checked, "anti-vacuity").toBeGreaterThan(10);
  });

  it("with no count that would work (a field of one) the refusal names none and says so by phase", () => {
    const refusal = groupTakeRefusal({ destKind: "knockout", placement: "rank_order", pools: 4, take: groupsKoTake(5, 4), entrants: 1 })!;
    expect(refusal.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    expect(refusal.vars).toMatchObject({ options: "", phase: "saveNone" });
    expect(groupTakeWorkingCounts("knockout", 4, 1), "the premise: nothing is offered").toEqual([]);
  });

  it("the entrant cap shapes the options: a field of 8 never offers a count above 8", () => {
    const refusal = groupTakeRefusal({ destKind: "knockout", placement: "rank_order", pools: 4, take: groupsKoTake(5, 4), entrants: 8 })!;
    expect(refusal.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    const options = String(refusal.vars.options).split(", ").map(Number);
    expect(Math.max(...options)).toBeLessThanOrEqual(8);
  });

  it("past the draw's bounds: more than FORMAT_BOUNDS.qualify.max qualifiers is SEEDING_CROSS_POOL_DRAW_TOO_LARGE, with the max to pick", () => {
    const refusal = ask(8, FORMAT_BOUNDS.qualify.max + 1)!;
    expect(refusal.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(refusal.vars).toMatchObject({ pools: 8, entrants: 33, maxPools: FORMAT_BOUNDS.pools.max, maxEntrants: FORMAT_BOUNDS.qualify.max, phase: "save" });
    expect(crossPoolTooLarge(8, 33)).toBe(true);
    expect(crossPoolTooLarge(8, 32), "the bound itself is inside").toBe(false);
    expect(crossPoolTooLarge(8, 33)).not.toBe(crossPoolTooLarge(8, 32));
  });

  it("more groups than the draw takes (9 > 8): TOO_LARGE with its own variant - no remedy in this form, so none is promised", () => {
    const refusal = ask(FORMAT_BOUNDS.pools.max + 1, 9)!;
    expect(refusal.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(refusal.vars.phase).toBe("saveGroups");
    expect(crossPoolTooLarge(9, 9)).toBe(true);
    expect(crossPoolTooLarge(8, 9)).toBe(false);
  });

  it("a page playoff seats exactly four (PAGE_PLAYOFF_SIZE): 4 saves, any other count is SEEDING_PAGE_PLAYOFF_NEEDS_FOUR", () => {
    expect(ask(4, PAGE_PLAYOFF_SIZE, "page_playoff")).toBeNull();
    for (const q of [2, 3, 5, 8]) {
      const refusal = ask(4, q, "page_playoff");
      expect(refusal?.code, `q ${q}`).toBe("SEEDING_PAGE_PLAYOFF_NEEDS_FOUR");
      expect(refusal!.vars, `q ${q}`).toMatchObject({ entrants: q, phase: "save" });
    }
  });

  it("a count under the minimum (a take of one place) is SEEDING_QUALIFY_TOO_FEW, with the minimum", () => {
    const one = groupTakeRefusal({ destKind: "knockout", placement: "rank_order", pools: 4, take: [{ kind: "bestNth", nth: 1, count: 1 }] });
    expect(one?.code).toBe("SEEDING_QUALIFY_TOO_FEW");
    expect(one!.vars).toMatchObject({ qualified: 1, min: FORMAT_BOUNDS.qualify.min });
    expect(ask(4, FORMAT_BOUNDS.qualify.min), "the minimum itself is not too few").toBeNull();
  });

  it("not this check's to judge (null): one group, a league-shaped Top N, a kind the draw never runs on, a seeded_map placement, an empty take", () => {
    const base = { destKind: "knockout", placement: "rank_order" as const, pools: 4, take: groupsKoTake(5, 4) };
    expect(groupTakeRefusal(base), "the premise: this shape IS refused").not.toBeNull();
    expect(groupTakeRefusal({ ...base, pools: 1 }), "one group").toBeNull();
    expect(groupTakeRefusal({ ...base, take: [{ kind: "rankRange", from: 1, to: 5 }] }), "a rankRange").toBeNull();
    expect(groupTakeRefusal({ ...base, destKind: "double_elim" }), "double elimination is not drawn across pools").toBeNull();
    expect(groupTakeRefusal({ ...base, placement: "seeded_map" }), "the organiser's own seats").toBeNull();
    expect(groupTakeRefusal({ ...base, take: [] }), "an empty take").toBeNull();
  });
});

describe("groupTakeWorkingCounts: the counts a form may offer", () => {
  it("is exactly the counts ask() accepts, bounded by the minimum and by min(max, field)", () => {
    for (const [pools, cap] of [[4, null], [4, 11], [2, 6]] as const) {
      const got = groupTakeWorkingCounts("knockout", pools, cap);
      const hi = Math.min(FORMAT_BOUNDS.qualify.max, cap ?? Infinity);
      const want: number[] = [];
      for (let q = FORMAT_BOUNDS.qualify.min; q <= hi; q++) if (ask(pools, q) === null) want.push(q);
      expect(got, `${pools} groups, cap ${cap}`).toEqual(want);
      expect(got.length, "anti-vacuity").toBeGreaterThan(0);
    }
  });
});
