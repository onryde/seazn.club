// --set pad-innings (W1d Task 12, fix round 1; controller ruling T12-I1): the one
// case that REACHES cricket's two-innings pad route. The route shipped in the
// first round of Task 12 and was reachable by no committed plan — every `test`
// case carries a rule override, which the browser has no path for (OVERRIDE_ROUTE,
// W2), and the builder default is t20 — so it was declared, typed, unit-green
// and inert. This file proves the seam from its producer: what the planner
// plans, how the plan is recorded and read back, and that the runner knows the
// set. The driven half (the planner's own case played through the real scenario
// loop, the real BrowserDriver and the real replay) lives in
// browser-driver.test.ts, where the driver's fakes are.
//
// Expected values come from the engine's declarations (resolveSportCfg's
// inningsPerSide, the variant order), from the controller's ruling (the case id
// and the variant `test`, no override), and from the plan reader's own spelling
// of a case — never from lib/pad-innings-set.ts.
import { describe, expect, it } from "vitest";
import { drivenInPlanOrder, livePlan, noVariant } from "../lib/expected-plan.ts";
import { PAD_INNINGS_SET, padInningsPlanner } from "../lib/pad-innings-set.ts";
import { SetTakesNoFilter } from "../lib/probe-set.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault, offlineVariantOrder } from "../lib/variants.ts";
import { SETS, planOf } from "../run.ts";

const NO_PLAN_FLAGS = { only: undefined, scenario: undefined, canary: undefined, layer: undefined, scope: undefined, rows: undefined };
const inningsPerSide = (variant: string): number => (resolveSportCfg("cricket", variant) as { inningsPerSide: number }).inningsPerSide;

describe("the pad-innings planner (what run.ts's SETS['pad-innings'] is)", () => {
  it("is named pad-innings, declares cricket alone, denies nothing, and needs the browser (a set that proves the pad has nothing to prove over http)", () => {
    expect(PAD_INNINGS_SET).toBe("pad-innings");
    const p = padInningsPlanner({});
    expect(p.sports).toEqual(["cricket"]);
    expect(p.deniesFeatures).toBe(false);
    expect(p.needsBrowser).toBe(true);
  });

  it("plans ONE case — league|cricket|test|LIFECYCLE, variant test, no override and no deny — whatever builder default the harness hands it", () => {
    let checked = 0;
    const builderDefault = offlineBuilderDefault("cricket");
    // The harness's variantFor answers the builder default (t20); a stranger and a thrower must change nothing.
    for (const variantFor of [(_: string) => builderDefault, (_: string) => "not-a-variant", (_: string): string => { throw new Error("the planner must not ask"); }]) {
      const cases = padInningsPlanner({}).plan(variantFor);
      expect(cases).toEqual([{ caseId: "league|cricket|test|LIFECYCLE", row: "league", sport: "cricket", variant: "test", scenario: "LIFECYCLE", canary: false }]);
      expect(cases[0]).not.toHaveProperty("overrides"); // an override is the thing the browser has no path for
      expect(cases[0]).not.toHaveProperty("deny");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the planned variant IS two innings a side, by the engine's own cfg — and the builder default is not (the differential: a plan that took the default would reach the one-innings route)", () => {
    const variant = padInningsPlanner({}).plan(() => offlineBuilderDefault("cricket"))[0]!.variant;
    expect(offlineVariantOrder("cricket")).toContain(variant); // a committed cricket variant, not an invented key
    expect(inningsPerSide(variant)).toBe(2);
    expect(inningsPerSide(offlineBuilderDefault("cricket"))).not.toBe(2);
    // …and it is the ONLY kind of variant that reaches the route, so the set cannot be satisfied by any other.
    const twoInnings = offlineVariantOrder("cricket").filter((v) => inningsPerSide(v) === 2);
    expect(twoInnings).toContain(variant);
    expect(twoInnings.length).toBeGreaterThan(0);
  });

  it("takes no filter: --only, --scenario or --canary is refused by name, each alone and together (it runs the whole set, which is one case)", () => {
    let refused = 0;
    for (const [cli, given] of [[{ only: "league|cricket" }, "--only"], [{ scenario: "LIFECYCLE" }, "--scenario"], [{ canary: "M1" }, "--canary"], [{ only: "league|cricket", scenario: "LIFECYCLE" }, "--only, --scenario"]] as const) {
      expect(() => padInningsPlanner(cli), JSON.stringify(cli)).toThrow(SetTakesNoFilter);
      expect(() => padInningsPlanner(cli), JSON.stringify(cli)).toThrow(`--set pad-innings runs the whole set; it takes no ${given}`);
      refused++;
    }
    expect(refused).toBe(4);
    expect(() => padInningsPlanner({})).not.toThrow(); // its positive pair
  });
});

describe("the pad-innings set, registered and read back (the plan is judged by the planner that made it)", () => {
  it("run.ts's SETS holds it under its own name, as the planner this module exports", () => {
    expect(Object.keys(SETS)).toContain(PAD_INNINGS_SET);
    expect(SETS[PAD_INNINGS_SET]).toBe(padInningsPlanner);
  });

  it("planOf records `--set pad-innings`, and the plan reader parses it back to that one case — driven, not planned, not layered", () => {
    const plan = planOf({ ...NO_PLAN_FLAGS, set: PAD_INNINGS_SET });
    expect(plan).toBe("--set pad-innings");
    const live = livePlan(plan);
    // The reader spells a case without its variant segment (the variant order is the DB's, so the plan must not carry it).
    expect([...live.driven]).toEqual(["league|cricket|LIFECYCLE"]);
    expect(noVariant("league|cricket|test|LIFECYCLE")).toBe("league|cricket|LIFECYCLE");
    expect(live.planned.size).toBe(0);
    expect(live.layered).toBe(false);
    expect(drivenInPlanOrder(plan)).toEqual([true]); // the CI shard matrix budgets its job from this
  });

  it("the plan reader tells it from pad-proof: pad-proof drives every pad sport and none of its cases is this one, and this set drives exactly one", () => {
    const proof = livePlan("--set pad-proof");
    expect(proof.driven.size).toBeGreaterThan(1);
    expect([...proof.driven]).not.toContain("league|cricket|LIFECYCLE");
    expect(livePlan("--set pad-innings").driven.size).toBe(1);
  });
});
