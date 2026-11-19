// W5 Task 12 (X-BD-1, ST-G5, R12): F1 seeds 7 entrants, and on group_group_ko the first stage is 4 pools (t20-super8). Seven snaked into four
// leave a pool of one, which the product refuses by name since C38 (Start answers 422 STAGE_NOT_READY group_too_few_entrants) and now offers
// the pool count that works. The refusal is the EXPECTED outcome (the W5 design's "group_group_ko F1 cells become refused, not red"), so the
// case is judged on the refusal and renders refused - the draw it never made cannot be a defect.
// Expected values are typed from the rulebook (each group needs at least 2; floor(7/3)=2, so 3 pools work), never from the code under test.
import { describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { resolveProgression, type ProgressionSpec, type StandingsRow } from "@seazn/engine/competition";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { decideState } from "../lib/results.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { cutBeyondFieldExpected, cutItems, poolItems, poolOfOneExpected } from "../lib/scenarios/f1-odd-field.ts";
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

// W5 T12b (RB5-E6, X-BD-8; matrix truth run 44395599687): the product's Start also refuses a CUT the field cannot supply, and it asks that
// BEFORE the group draw, so on group_group_ko (a top 2 of each of 4 pools = 8, from a field of 7) the answer is 422 RR_CUT_EXCEEDS_FIELD, not the
// pool of one's STAGE_NOT_READY. The rulebook owes each refusal by name and orders neither, so F1 judges whichever it gets on that refusal's own
// numbers. Before this, all 11 group_group_ko F1 cases were red in CI ("Start answered 422 RR_CUT_EXCEEDS_FIELD, want 422 STAGE_NOT_READY").
describe("cutBeyondFieldExpected: which rows' first stage cuts more than 7 entrants supply (from the posted bodies)", () => {
  it("group_group_ko's top 2 of each of 4 pools is 8, and 7 entrants in pools of 2, 2, 2, 1 supply 4 (a rank wave is all or nothing); every other row's cut fits 7", () => {
    // differential: today (the run's reds) nothing here said so, and the cut's refusal read as a defect.
    expect(cutBeyondFieldExpected("group_group_ko", 7)).toEqual({ qualified: 8, max: 4 });
    expect(cutBeyondFieldExpected("group_group_ko", 8), "8 fill 4 pools of 2: the top 2 of each is 8").toBeNull();
    let judged = 0;
    const refused: string[] = [];
    for (const row of ROW_KEYS) {
      judged++;
      if (cutBeyondFieldExpected(row, 7) !== null) refused.push(row);
    }
    expect(judged, "anti-vacuity: every row asked").toBe(ROW_KEYS.length);
    expect(refused, "only the row whose first stage cuts 8").toEqual(["group_group_ko"]);
    // A rank range: a top 4 of a league of 3 supplies 3 (league_ko, the same rule off a plain table).
    expect(cutBeyondFieldExpected("league_ko", 3)).toEqual({ qualified: 4, max: 3 });
    expect(cutBeyondFieldExpected("league_ko", 4)).toBeNull();
  });
});

describe("F1 on group_group_ko when the product's Start refuses the cut first (the real order): ⛔, judged on the cut's own numbers", () => {
  it("every sport: refused, the cut named 8 against a supply of 4, every assertion passes and the fixture invariants are not judged", async () => {
    let judged = 0;
    for (const sport of SPORT_KEYS) {
      const { checks, state } = await runF1("group_group_ko", { enforceCutBeyondField: true, enforcePoolSize: true }, sport);
      expect(failed(checks), sport).toEqual([]);
      expect(checks.map((c) => c.id), `${sport}: judged on the refusal alone`).toEqual(["f1-pool-of-one-refused"]);
      expect(checks[0]!.checked, `${sport}: items judged`).toBeGreaterThan(0);
      expect(state.state, `${sport}: ${state.reason}`).toBe("refused");
      expect(state.reason, sport).toMatch(/cut of 8.*supplies 4/);
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
    expect(judged).toBeGreaterThan(0);
  });

  it("a cut refusal that names the wrong cut or the wrong supply is red, naming what it said", async () => {
    let judged = 0;
    for (const wrongMessage of ["9 can't qualify from this field: it can supply at most 4.", "8 can't qualify from this field: it can supply at most 7.", "the cut is too big"]) {
      const { checks, state } = await runF1("group_group_ko", { enforceCutBeyondField: { wrongMessage } });
      expect(failed(checks).join(";"), wrongMessage).toMatch(/f1-pool-of-one-refused.*the refusal names a (cut|supply) of/);
      expect(state.state, wrongMessage).toBe("red");
      judged++;
    }
    expect(judged).toBe(3);
  });

  it("a product that DRAWS the field (neither refusal) is red, naming both it owed", async () => {
    const { checks, state } = await runF1("group_group_ko", {});
    expect(failed(checks).join(";")).toMatch(/f1-pool-of-one-refused.*accepted.*pool of one.*RB5-E6/);
    expect(state.state).toBe("red");
  });

  it("the rule's other side: a row whose cut the field supplies (league_ko, a top 4 of 7) owes no refusal, is drawn under the same product and works", async () => {
    const drawn = await runF1("league_ko", { enforceCutBeyondField: true });
    expect(drawn.state, failed(drawn.checks).join("; ")).toMatchObject({ state: "works" });
    expect(F1.mandatedRefusal?.(specFor("league_ko")) ?? null).toBeNull();
    expect(invariantsApply(F1, specFor("league_ko"))).toBe(true);
  });
});

describe("cutItems: a cut refusal the field does not owe is a failed item, never a pass (the guard behind 'cannot happen')", () => {
  const refusal = new RefusedCall("POST", "/api/v1/divisions/d1/start", 422, "RR_CUT_EXCEEDS_FIELD", "8 can't qualify from this field: it can supply at most 4.");
  it("owed: every item passes on the right numbers; not owed: the first item fails", () => {
    expect(cutItems(refusal, { qualified: 8, max: 4 }).map((i) => i.ok)).toEqual([true, true, true, true]);
    expect(cutItems(refusal, null).map((i) => i.ok)[0], "the gate over-refused a field that supplies the cut").toBe(false);
  });
});

// Fix round 1 (Task 25 review): the status is half of what a refusal IS. Both items below were mutation survivors - deleting the status
// predicate left every test green, because each fixture the suite refused with already carried 422. So each is now refused with the right
// text and a status or code that is wrong, and the same refusal at 422 beside it, so a pass cannot come from the fixture alone.
describe("a refusal's status and code are judged as well as its text (the survivors of the cut and pool items)", () => {
  const cutMessage = "8 can't qualify from this field: it can supply at most 4.";
  const owedCut = { qualified: 8, max: 4 };
  const poolExtra = { reason: "group_too_few_entrants", groups: 4, entrants: 7, required: 8, suggested: 3 };
  const owedPool = { groups: 4, required: 8, suggested: 3 };

  it("cutItems: the cut's text at 409 (or any status but 422) fails the status item, and only it; at 422 every item passes", () => {
    let checked = 0;
    for (const status of [409, 400, 500, 200]) {
      const items = cutItems(new RefusedCall("POST", "/api/v1/divisions/d1/start", status, "RR_CUT_EXCEEDS_FIELD", cutMessage), owedCut);
      expect(items.map((i) => i.ok), `status ${status}`).toEqual([true, false, true, true]);
      expect(items[1]!.note).toContain(`Start answered ${status} RR_CUT_EXCEEDS_FIELD, want 422`);
      checked++;
    }
    expect(cutItems(new RefusedCall("POST", "/api/v1/divisions/d1/start", 422, "RR_CUT_EXCEEDS_FIELD", cutMessage), owedCut).map((i) => i.ok)).toEqual([true, true, true, true]);
    expect(checked).toBe(4);
  });

  it("poolItems: the pool refusal's extras at 409, or under a code that is not STAGE_NOT_READY, fail its first item, and only it; at 422 STAGE_NOT_READY every item passes", () => {
    const refusal = (status: number, code: string) => new RefusedCall("POST", "/api/v1/divisions/d1/start", status, code, "a pool of one", null, poolExtra);
    const good = poolItems(refusal(422, "STAGE_NOT_READY"), 7, owedPool, null);
    expect(good.map((i) => i.ok)).toEqual([true, true, true, true, true, true]);
    let checked = 0;
    for (const [status, code] of [[409, "STAGE_NOT_READY"], [400, "STAGE_NOT_READY"], [422, "RR_CUT_EXCEEDS_FIELD"], [422, "VALIDATION"], [409, "OTHER"]] as const) {
      const items = poolItems(refusal(status, code), 7, owedPool, null);
      expect(items.map((i) => i.ok), `${status} ${code}`).toEqual([false, true, true, true, true, true]);
      expect(items[0]!.note, `${status} ${code}`).toContain(`Start answered ${status} ${code}, want 422 STAGE_NOT_READY`);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

// Run 44411389618 (the second W5 truth run): all 11 group_group_ko F1 cells were still red, "the refusal names a supply of 4, want 7". The
// expectation summed min(n, pool) over the pools (7); the product, and the engine behind it, fill a rank WAVE all or nothing. The ORACLE
// here is the engine's own `resolveProgression` over the tables the snake leaves, so no expected number comes from the gate or from the
// function under test: the supply is the most waves the engine can resolve, times the pools.
describe("cutBeyondFieldExpected's supply is the engine's: a rank wave is all or nothing (resolveProgression as the oracle)", () => {
  const row = (entrantId: string, rank: number): StandingsRow => ({ entrantId, played: 3, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank });
  const stages = stagesForRow("group_group_ko");

  /** The slots the engine can fill with a top `n` of `pools` pools holding `sizes` entrants: pools x the most ranks it resolves. */
  function engineSupply(sizes: readonly number[], n: number): number {
    const base = stages[1]!.progression as unknown as ProgressionSpec;
    let waves = 0;
    for (let w = 1; w <= n; w++) {
      const spec = { ...base, sources: base.sources.map((s) => ({ ...s, take: [{ kind: "topNPerGroup", n: w }] })) } as unknown as ProgressionSpec;
      const poolKeys = sizes.map((_, i) => "ABCDEFGH"[i]!);
      const pools = sizes.map((size, p) => ({ pool: poolKeys[p]!, rows: Array.from({ length: size }, (_, i) => row(`e${p}-${i + 1}`, i + 1)) }));
      try {
        resolveProgression(spec, [{ poolKeys }], [{ pools }], stages[1]!.kind);
        waves = w;
      } catch (e) {
        if (!EngineError.is(e)) throw e;
        break;
      }
    }
    return waves * sizes.length;
  }

  it("for every field from 4 to 16 over 4 pools the harness's supply equals what the engine resolves (and 7 of 4 is 4, not 7)", () => {
    let checked = 0;
    for (let field = 4; field <= 16; field++) {
      const sizes = Array.from({ length: 4 }, (_, i) => Math.floor(field / 4) + (i < field % 4 ? 1 : 0));
      const engine = engineSupply(sizes, 2);
      const owed = cutBeyondFieldExpected("group_group_ko", field);
      // qualified is 8 (a top 2 of 4 pools); owed is null exactly when the engine supplies all of it.
      expect(owed === null ? 8 : owed.max, `field ${field}`).toBe(engine);
      checked++;
    }
    expect(checked).toBe(13);
    expect(engineSupply([2, 2, 2, 1], 2), "the engine's own answer for 7 into 4 pools").toBe(4);
    expect(cutBeyondFieldExpected("group_group_ko", 7)!.max).toBe(4);
  });
});
