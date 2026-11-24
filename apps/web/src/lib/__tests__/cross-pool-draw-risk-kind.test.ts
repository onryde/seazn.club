// `crossPoolShapeRefusalKind` maps the engine's per-supply answers (`crossPoolSeparable`) to never / sometimes / always. No shape in the
// builder's whole space is refused for EVERY supply (probed: 1704 shapes, 0 always), so "always" cannot be witnessed through the real
// rule; the engine's answer is stood in - the one seam - and the MAPPING is pinned over a field with several supplies (2 pools, a
// winners tier and a best-2nd tier of one: two supplies, A2 or B2). The real rule's answers are pinned in cross-pool-draw-risk.test.ts.
import { describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ answer: (_poolOfLastSeed: string): boolean | null => true }));
vi.mock("@/lib/cross-pool-separable", () => ({
  crossPoolSeparable: (seeds: readonly { pool: string }[]) => ({ separable: engine.answer(seeds[seeds.length - 1]!.pool) }),
}));
import { crossPoolShapeAlwaysRefuses, crossPoolShapeCanRefuse, crossPoolShapeRefusalKind } from "@/lib/cross-pool-draw-risk";

// Each case is a distinct field (the answer is cached per field), so no case reads another's.
const take = (nth: number) => [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth, count: 1 }] as const;

describe("crossPoolShapeRefusalKind maps the engine's answers over every supply", () => {
  it("separable for every supply: never", () => {
    engine.answer = () => true;
    expect(crossPoolShapeRefusalKind("single_elim", 2, take(2))).toBe("never");
  });
  it("refused for every supply: always (and so can refuse)", () => {
    engine.answer = () => false;
    expect(crossPoolShapeRefusalKind("single_elim", 2, take(3))).toBe("always");
    expect(crossPoolShapeAlwaysRefuses("single_elim", 2, take(3))).toBe(true);
    expect(crossPoolShapeCanRefuse("single_elim", 2, take(3))).toBe(true);
  });
  it("refused for one supply (the best 2nd is B's) and not the other: sometimes - it can refuse, it does not always", () => {
    engine.answer = (pool) => pool !== "B";
    expect(crossPoolShapeRefusalKind("single_elim", 2, take(4))).toBe("sometimes");
    expect(crossPoolShapeAlwaysRefuses("single_elim", 2, take(4))).toBe(false);
    expect(crossPoolShapeCanRefuse("single_elim", 2, take(4))).toBe(true);
  });
  it("an input the engine refuses on sight for another reason (null) is no refusal of this kind: a supply of null and false is sometimes, never always", () => {
    engine.answer = (pool) => (pool === "A" ? null : false);
    expect(crossPoolShapeRefusalKind("single_elim", 2, take(5))).toBe("sometimes");
  });
});
