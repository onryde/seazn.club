// W5 Task 12 (X-BD-1, ST-G5, R12): F1 seeds 7 entrants, and on group_group_ko the first stage is 4 pools (t20-super8). Seven snaked into four
// leave a pool of one, which the product refuses by name since C38 (Start answers 422 STAGE_NOT_READY group_too_few_entrants) and now offers
// the pool count that works. The refusal is the EXPECTED outcome (the W5 design's "group_group_ko F1 cells become refused, not red"), so the
// case is judged on the refusal and renders refused - the draw it never made cannot be a defect.
// Expected values are typed from the rulebook (each group needs at least 2; floor(7/3)=2, so 3 pools work), never from the code under test.
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { decideState } from "../lib/results.ts";
import { poolOfOneExpected } from "../lib/scenarios/f1-odd-field.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { invariantsApply, type CaseSpec, type ScenarioContext } from "../lib/scenarios/types.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeMultiStageDriver, type FakeMultiStageOptions } from "./fake-formats-driver.ts";

const F1 = SCENARIOS.F1;
const specFor = (row: CaseSpec["row"], sport = "generic", variant = "score"): CaseSpec => ({ caseId: `${row}|${sport}|${variant}|F1`, row, sport, variant, scenario: "F1", canary: false });
async function runF1(row: CaseSpec["row"], opts: FakeMultiStageOptions, sport = "generic") {
  const variant = sport === "generic" ? "score" : offlineBuilderDefault(sport);
  const spec = specFor(row, sport, variant);
  const ctx: ScenarioContext = { driver: new FakeMultiStageDriver(opts), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
  const out = await F1.run(ctx);
  const checks = [...(invariantsApply(F1, spec) ? evaluateInvariants(out.observed) : []), ...out.assertions];
  const state = decideState({ checks, deferred: null, error: null, mandated: F1.mandatedRefusal?.(spec) ?? null });
  return { out, checks, state };
}
const failed = (checks: readonly { id: string; verdict: string; reason?: string }[]) => checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason ?? ""}`);

describe("poolOfOneExpected: which rows F1's 7 entrants cannot fill (from the posted body)", () => {
  it("7 into 4 (group_group_ko's first stage) is expected refused, naming 3; every other row's first stage takes 7", () => {
    // differential: before T12 nothing said so - the case ran, drew nothing and reddened ("in no pool", ST-G5).
    expect(poolOfOneExpected("group_group_ko", 7)).toEqual({ groups: 4, required: 8, suggested: 3 });
    let judged = 0;
    const refused: string[] = [];
    for (const row of ROW_KEYS) {
      judged++;
      if (poolOfOneExpected(row, 7) !== null) refused.push(row);
    }
    expect(judged, "anti-vacuity: every row asked").toBe(ROW_KEYS.length);
    expect(refused, "only the 4-pool row").toEqual(["group_group_ko"]);
    // The rule's other side, on the same row: 8 fill 4 pools.
    expect(poolOfOneExpected("group_group_ko", 8)).toBeNull();
    expect(stagesForRow("group_group_ko")[0]!.kind).toBe("group");
  });
});

describe("F1 on group_group_ko: the refusal is the expected outcome (⛔), judged on its name and its count", () => {
  it("every sport: the case renders refused, every assertion passes, and the fixture invariants are not judged (no stage was drawn)", async () => {
    let judged = 0;
    for (const sport of SPORT_KEYS) {
      const { checks, state } = await runF1("group_group_ko", { enforcePoolSize: true }, sport);
      expect(failed(checks), sport).toEqual([]);
      expect(checks.map((c) => c.id), `${sport}: judged on the refusal alone`).toEqual(["f1-pool-of-one-refused"]);
      const refusal = checks[0]!;
      expect(refusal.checked, `${sport}: items judged`).toBeGreaterThan(0);
      expect(state.state, `${sport}: ${state.reason}`).toBe("refused");
      expect(state.reason, sport).toMatch(/4 pools.*3/);
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
    expect(judged).toBeGreaterThan(0);
  });

  it("a product that DRAWS 7 into 4 (the refusal regressed) is red, not refused: nothing mandates a pass over a defect", async () => {
    const { checks, state } = await runF1("group_group_ko", {});
    expect(failed(checks).join(";")).toMatch(/f1-pool-of-one-refused.*accepted/);
    expect(state.state).toBe("red");
  });

  it("a refusal that offers the wrong count (2: floor(7/2)=3 works, but 3 is the LARGEST) or none is red, naming what it offered", async () => {
    for (const suggestedOverride of [2, 4, null]) {
      const { checks, state } = await runF1("group_group_ko", { enforcePoolSize: { suggestedOverride } });
      expect(failed(checks).join(";"), String(suggestedOverride)).toMatch(/f1-pool-of-one-refused.*suggested/);
      expect(state.state, String(suggestedOverride)).toBe("red");
    }
  });

  it("every other row's F1 is untouched: no mandate, the invariants still judged, and the case still works where the product draws (league_ko)", async () => {
    let judged = 0;
    for (const row of ROW_KEYS.filter((r) => r !== "group_group_ko")) {
      const spec = specFor(row);
      expect(F1.mandatedRefusal?.(spec) ?? null, row).toBeNull();
      expect(invariantsApply(F1, spec), row).toBe(true);
      judged++;
    }
    expect(judged).toBe(ROW_KEYS.length - 1);
    const { checks, state } = await runF1("league_ko", { enforcePoolSize: true });
    expect(state, failed(checks).join("; ")).toMatchObject({ state: "works" });
  });
});
