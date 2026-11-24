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
import { CROSS_POOL_SHAPES } from "@/lib/cross-pool-ties";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { PAGE_PLAYOFF_SIZE } from "@/lib/format-size-gates";
import { buildTemplateStages, groupsKoTake } from "@/lib/format-templates";
import { crossPoolTooLarge, groupTakeRefusal, groupTakeWorkingCounts, supplyingPools, type GroupTakeAsk } from "@/lib/group-take-refusal";

// The form's reading ("can"): the whole-grid sweeps below compare it with the builder's own warning, which is also "can". The SAVE door's
// reading ("always", the default) is pinned in its own describe at the end.
const ask = (pools: number, q: number, destKind = "knockout") => groupTakeRefusal({ destKind, placement: "rank_order", pools, take: groupsKoTake(q, pools) }, "can");
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
    const refusal = groupTakeRefusal({ destKind: "knockout", placement: "rank_order", pools: 4, take: groupsKoTake(5, 4), entrants: 1 }, "can")!;
    expect(refusal.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    expect(refusal.vars).toMatchObject({ options: "", phase: "saveNone" });
    expect(groupTakeWorkingCounts("knockout", 4, 1), "the premise: nothing is offered").toEqual([]);
  });

  it("the entrant cap shapes the options: a field of 8 never offers a count above 8", () => {
    const refusal = groupTakeRefusal({ destKind: "knockout", placement: "rank_order", pools: 4, take: groupsKoTake(5, 4), entrants: 8 }, "can")!;
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
    for (const mode of ["can", "always"] as const) {
      // The premise is a shape both readings judge: a qualifier count past the draw's bound is refused whichever way it is asked.
      const refused = { ...base, take: groupsKoTake(FORMAT_BOUNDS.qualify.max + 1, 4) };
      expect(groupTakeRefusal(refused, mode), `${mode}: the premise: this shape IS refused`).not.toBeNull();
      expect(groupTakeRefusal({ ...refused, pools: 1 }, mode), `${mode}: one group`).toBeNull();
      expect(groupTakeRefusal({ ...refused, take: [{ kind: "rankRange", from: 1, to: 5 }] }, mode), `${mode}: a rankRange`).toBeNull();
      expect(groupTakeRefusal({ ...refused, destKind: "double_elim" }, mode), `${mode}: double elimination is not drawn across pools`).toBeNull();
      expect(groupTakeRefusal({ ...refused, placement: "seeded_map" }, mode), `${mode}: the organiser's own seats`).toBeNull();
      expect(groupTakeRefusal({ ...refused, take: [] }, mode), `${mode}: an empty take`).toBeNull();
    }
    expect(groupTakeRefusal(base, "can"), "the premise: the separation shape is refused as the form reads it").not.toBeNull();
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

// Save-gate policy (owner, 2026-11-24): the SAVE refuses only a shape the draw refuses for every set of pools the best places could
// come from. A shape that only CAN refuse is saved, and the draw refuses it by name later (as it did before the save gate existed).
// The FORM keeps offering only counts that can never refuse ("can" mode).
describe("save policy: only an 'always' refusal is a 422; a 'can' refusal saves", () => {
  // tables-w2d.spec.ts: 2 pools, take [top 1, best 2nd, best 3rd] on_complete into a knockout. Three of its four outcomes refuse, one
  // separates (see cross-pool-draw-risk.test.ts), so the draw can refuse it - and a real division saves and draws it.
  const RIG: GroupTakeAsk["take"] = [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }, { kind: "bestNth", nth: 3, count: 1 }];
  const base = { destKind: "knockout", placement: "rank_order", pools: 2, take: RIG } as const;

  it("the e2e rig SAVES (null), though the draw can refuse it", () => {
    expect(groupTakeRefusal(base)).toBeNull();
  });

  it("the same rig IS refused when asked as the form asks ('can'): the premise that the save's null is the policy, not a missing check", () => {
    expect(groupTakeRefusal(base, "can")?.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
  });

  it("X-PD-4's named shapes (2 groups: winners + the best runner-up; 3 groups: winners + one) only CAN refuse - it depends on which group's runner-up is best - so they SAVE", () => {
    for (const [pools, q] of [[2, 3], [3, 4]] as const) {
      const take = groupsKoTake(q, pools);
      expect(groupTakeRefusal({ ...base, pools, take }), `${pools} groups, ${q} through: saves`).toBeNull();
      expect(groupTakeRefusal({ ...base, pools, take }, "can")?.code, `${pools} groups, ${q} through: the form still leaves it out`).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    }
  });

  it("an always-refuse shape is a 422 by code at save: too few places, a page playoff not of four, more qualifiers than the draw takes, more groups than it takes", () => {
    const save = (a: Partial<GroupTakeAsk>) => groupTakeRefusal({ ...base, ...a })?.code;
    expect(save({ take: [{ kind: "bestNth", nth: 1, count: 1 }], pools: 4 })).toBe("SEEDING_QUALIFY_TOO_FEW");
    expect(save({ destKind: "page_playoff", pools: 4, take: groupsKoTake(8, 4) })).toBe("SEEDING_PAGE_PLAYOFF_NEEDS_FOUR");
    expect(save({ pools: 8, take: groupsKoTake(FORMAT_BOUNDS.qualify.max + 1, 8) })).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(save({ pools: 9, take: groupsKoTake(9, 9) })).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
  });

  it("the counts the form offers do not move: a count with a refusing supply is still left out", () => {
    // 2 groups: 3 is refused (above); 2 and 4 are not. The form's list is the 'can' reading, whatever the save door does.
    const counts = groupTakeWorkingCounts("knockout", 2, null);
    expect(counts).not.toContain(3);
    expect(counts).toEqual(expect.arrayContaining([2, 4]));
  });
});

// The save door never refuses what the form offers: every count the form shows (groupTakeWorkingCounts, the "can" reading) passes the save
// reading ("always") - else an organiser picks a count from the list and is refused for it at save. Swept over every pool count the form
// serves and every target kind it offers (the cross-pool kinds the draw knows, plus double elimination, which the form also offers).
describe("sweep: every count the form offers saves", () => {
  it("pools 2..8 x every offered target kind x field unknown / 8 / 16: groupTakeRefusal(...) is null for each offered count", () => {
    const kinds = [...Object.keys(CROSS_POOL_SHAPES), "double_elim"];
    let checked = 0;
    let withCounts = 0;
    for (const destKind of kinds) {
      for (let pools = FORMAT_BOUNDS.pools.min; pools <= FORMAT_BOUNDS.pools.max; pools++) {
        for (const entrants of [null, 8, 16]) {
          const counts = groupTakeWorkingCounts(destKind, pools, entrants);
          if (counts.length > 0) withCounts += 1;
          for (const q of counts) {
            const refusal = groupTakeRefusal({ destKind, placement: "rank_order", pools, take: groupsKoTake(q, pools), entrants });
            expect(refusal, `${destKind}, ${pools} groups, field ${entrants}, count ${q}: the form offers it, so save must accept it`).toBeNull();
            checked += 1;
          }
        }
      }
    }
    expect(kinds.length, "anti-vacuity: every target kind swept").toBeGreaterThanOrEqual(4);
    expect(withCounts, "anti-vacuity: shapes that offer counts").toBeGreaterThan(0);
    expect(checked, "anti-vacuity: offered counts checked (zero = a failure)").toBeGreaterThan(100);
    console.log(`group-take form-offered counts checked: ${checked}`);
  });
});

describe("crossPoolTooLarge is asked of the pools that can SUPPLY a qualifier, not of the source's pool count", () => {
  // A take with no whole-group rule draws from the pools its best places come from: four best winners from nine groups are four
  // pools in the draw (cross-pool-draw.ts counts the distinct pools of the qualifiers it was handed), inside the bound of eight.
  it("9 groups, 4 qualifiers (n=0: min(pools, q) = 4 pools) is not too large", () => {
    expect(ask(9, 4), "groupsKoTake(4, 9) is four best winners").toBeNull();
    expect(groupsKoTake(4, 9).every((t) => t.kind === "bestNth"), "the premise: no whole-group rule").toBe(true);
    expect(ask(FORMAT_BOUNDS.pools.max + 1, 4)).toBeNull();
  });

  it("9 groups, every group's winner (9 pools supply) is still too large, with the groups remedy", () => {
    const refusal = ask(9, 9)!;
    expect(refusal.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(refusal.vars.phase).toBe("saveGroups");
  });

  it("a whole-group rule takes every pool: 9 groups, top 1 + 1 best 2nd is too large; q > the entrant bound is too large whatever the pools", () => {
    expect(ask(9, 10)?.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(ask(2, FORMAT_BOUNDS.qualify.max + 1)?.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
  });

  it("at most vs at fewest: a best tier of eight and one of two from 9 groups draw from 8 to 9 pools - the form (can) leaves it out, the save (always) saves it", () => {
    // The tier of eight asks eight groups; the tier of two may sit inside them (8 pools drawn) or reach the ninth (9 pools, past the bound
    // of 8). Whether it is too large depends on the groups, so only the form's reading refuses it.
    const take: GroupTakeAsk["take"] = [{ kind: "bestNth", nth: 1, count: 8 }, { kind: "bestNth", nth: 2, count: 2 }];
    const base = { destKind: "knockout", placement: "rank_order", pools: 9, take } as const;
    expect(supplyingPools(take, 9)).toEqual({ min: 8, max: 9 });
    expect(groupTakeRefusal(base, "can")?.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(groupTakeRefusal(base, "can")?.vars.phase).toBe("saveGroups");
    expect(groupTakeRefusal(base)).toBeNull();
  });

  it("the form's counts for 9 groups are the counts under the bound, not none", () => {
    const counts = groupTakeWorkingCounts("knockout", 9, null);
    expect(counts.length, "anti-vacuity").toBeGreaterThan(0);
    expect(counts).toContain(4);
    expect(counts).not.toContain(9);
  });
});
