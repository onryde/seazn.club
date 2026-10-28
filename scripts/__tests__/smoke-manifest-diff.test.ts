// Smoke-split proof: a refactor of scripts/smoke.ts must keep every suite's name, order and check count. Each case
// perturbs ONE of those and expects exactly that difference; the identical case reports how many suites it compared.
import { describe, expect, it } from "vitest";
import { SmokeManifestError, diffSmokeManifests, parseSmokeManifest } from "../smoke-manifest-diff.ts";

const base = [
  { suite: "v1", checks: 12 },
  { suite: "arbiter", checks: 7 },
  { suite: "matchRoom", checks: 3 },
];

describe("diffSmokeManifests", () => {
  it("identical manifests: no differences, over a non-empty comparison", () => {
    expect(base.length).toBeGreaterThan(0);
    expect(diffSmokeManifests(base, structuredClone(base))).toEqual([]);
  });
  it("a changed check count is named with both values", () => {
    const after = base.map((e) => (e.suite === "arbiter" ? { ...e, checks: 6 } : e));
    expect(diffSmokeManifests(base, after)).toEqual(["checks changed: arbiter 7 -> 6"]);
  });
  it("a reordered suite is an order difference and nothing else", () => {
    const after = [base[1], base[0], base[2]];
    expect(diffSmokeManifests(base, after)).toEqual(["order changed: [v1, arbiter, matchRoom] -> [arbiter, v1, matchRoom]"]);
  });
  it("a dropped suite and a renamed suite are reported on both sides", () => {
    const after = [base[0], base[1], { suite: "matchRoom2", checks: 3 }];
    expect(diffSmokeManifests(base, after)).toEqual(["missing after: matchRoom", "new after: matchRoom2"]);
  });
  it("an empty manifest on either side throws instead of passing vacuously", () => {
    expect(() => diffSmokeManifests([], base)).toThrow(SmokeManifestError);
    expect(() => diffSmokeManifests(base, [])).toThrow(SmokeManifestError);
  });
});

describe("parseSmokeManifest", () => {
  it("accepts the report shape", () => {
    expect(parseSmokeManifest(JSON.stringify(base))).toEqual(base);
  });
  it.each([
    ["not an array", "{}"],
    ["negative count", '[{"suite":"a","checks":-1}]'],
    ["fractional count", '[{"suite":"a","checks":1.5}]'],
    ["missing name", '[{"checks":1}]'],
    ["duplicate suite", '[{"suite":"a","checks":1},{"suite":"a","checks":2}]'],
  ])("rejects %s", (_n, raw) => {
    expect(() => parseSmokeManifest(raw)).toThrow(SmokeManifestError);
  });
});
