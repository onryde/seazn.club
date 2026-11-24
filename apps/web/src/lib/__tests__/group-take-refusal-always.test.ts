// The save door's "always" reading of the separation refusal. No shape in the builder's whole space is refused for EVERY set of pools its best
// places could come from (probed over 1704 shapes of 2..8 pools, 0..4 whole places and two best tiers: 1475 never, 229 sometimes, 0
// always), so the branch that refuses at save has no real input today. It is pinned here with the ORACLE stood in - the one seam - so
// that a change to the engine's rule that makes such a shape appear is refused by name at save, with the counts that would work.
// The real oracle's own three answers are pinned in cross-pool-draw-risk.test.ts.
import { describe, expect, it, vi } from "vitest";
import { groupsKoTake } from "@/lib/format-templates";

const oracle = vi.hoisted(() => ({ always: false, can: true }));
vi.mock("@/lib/cross-pool-draw-risk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cross-pool-draw-risk")>();
  return {
    ...actual,
    crossPoolShapeAlwaysRefuses: (...a: Parameters<typeof actual.crossPoolShapeAlwaysRefuses>) => (a[2].length === 1 ? actual.crossPoolShapeAlwaysRefuses(...a) : oracle.always),
    crossPoolShapeCanRefuse: (...a: Parameters<typeof actual.crossPoolShapeCanRefuse>) => (a[2].length === 1 ? actual.crossPoolShapeCanRefuse(...a) : oracle.can),
  };
});
import { groupTakeRefusal } from "@/lib/group-take-refusal";

const ask = { destKind: "knockout", placement: "rank_order" as const, pools: 4, take: groupsKoTake(5, 4) };

describe("the separation refusal at save asks the ALWAYS reading, the form's the CAN reading", () => {
  it("an oracle that says 'always' is refused at save by code, naming the counts that would work", () => {
    oracle.always = true;
    oracle.can = true;
    const refusal = groupTakeRefusal(ask);
    expect(refusal?.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    expect(String(refusal?.vars.options).length, "options named").toBeGreaterThan(0);
  });

  it("an oracle that says only 'can' saves (null) at save, and is refused as the form reads it", () => {
    oracle.always = false;
    oracle.can = true;
    expect(groupTakeRefusal(ask)).toBeNull();
    expect(groupTakeRefusal(ask, "can")?.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
  });

  it("an oracle that says neither saves under both readings", () => {
    oracle.always = false;
    oracle.can = false;
    expect(groupTakeRefusal(ask)).toBeNull();
    expect(groupTakeRefusal(ask, "can")).toBeNull();
  });
});
