// W1d Task 14 (items 15c-15f): the three carry sets and the match-day dating step.
//
//   match-day     league|badminton LIFECYCLE at 1280 and 320, dated today (D17: the run sheet's default filter,
//                 15d: the rail's fold on a phone)
//   void-proof    league|badminton VOIDPROOF at 1280 and 320 (15e: Void last entry on the console)
//   carry8-1280   league|generic and knockout|badminton x M1, R4 at 1280 (15f: forfeit and withdraw)
//
// Every expected value comes from the brief, restated here as literals, from ruling 39 (L1 is 1280, L2 is a phone
// width), from the slice's own declarations and from the scenario registry: never from the set modules. Every sweep
// reports how many items it checked, and zero checked is a failure.
import { describe, expect, it } from "vitest";
import { drivenInPlanOrder, livePlan, noVariant, noWidth } from "../lib/expected-plan.ts";
import { L1_WIDTH, identityOf, layerCaseId, layerOfWidth, type DrivenLayerCase, type LayerCase } from "../lib/layers.ts";
import { MATCH_DAY_SET, VOID_PROOF_SET, matchDayPlanner, voidProofPlanner } from "../lib/match-day-set.ts";
import { CARRY8_1280_SET, carry8Planner } from "../lib/carry-1280-set.ts";
import { SetTakesNoFilter } from "../lib/probe-set.ts";
import { PAD_PROOF_SET } from "../lib/pad-proof-set.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "../lib/slice.ts";
import { Recorder, MatchDayUnfit, dateFirstRound, setUpDivision } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import type { CaseSpec, ScenarioContext } from "../lib/scenarios/types.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { decideState } from "../lib/results.ts";
import { SETS, UnknownSet, planOf } from "../run.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

const v = (s: string) => `v-${s}`;
const driven = (cs: readonly LayerCase[]): DrivenLayerCase[] => cs.map((c) => {
  expect(c.spec, `${layerCaseId(c)} is planned, not driven`).not.toBeNull();
  return c as DrivenLayerCase;
});

describe("the three carry sets (W1d Task 14)", () => {
  it("match-day is league|badminton LIFECYCLE at 1280 then 320, each a match-day case, L1 at 1280 and L2 at 320 (ruling 39)", () => {
    const p = matchDayPlanner({});
    const cases = driven(p.layered(v));
    expect(cases.map(layerCaseId)).toEqual(["league|badminton|v-badminton|LIFECYCLE@1280", "league|badminton|v-badminton|LIFECYCLE@320"]);
    expect(cases.map((c) => [c.width, c.layer])).toEqual([[1280, "L1"], [320, "L2"]]);
    expect(cases.every((c) => c.spec.matchDay === true && c.spec.scenario === "LIFECYCLE" && !c.spec.canary && c.spec.template === undefined)).toBe(true);
    // The run is labelled by its widest need: it holds a phone width, so L2; per-case layers are ruling 39's.
    expect(p).toMatchObject({ layer: "L2", acceptsWidth: null, deniesFeatures: false, sports: ["badminton"], label: "--set match-day" });
    console.info(`carry-sets: match-day ${cases.length} cases`);
  });

  it("void-proof is league|badminton VOIDPROOF at 1280 then 320, no match day", () => {
    const p = voidProofPlanner({});
    const cases = driven(p.layered(v));
    expect(cases.map(layerCaseId)).toEqual(["league|badminton|v-badminton|VOIDPROOF@1280", "league|badminton|v-badminton|VOIDPROOF@320"]);
    expect(cases.map((c) => [c.width, c.layer])).toEqual([[1280, "L1"], [320, "L2"]]);
    expect(cases.every((c) => c.spec.matchDay === undefined && c.spec.scenario === "VOIDPROOF" && !c.spec.canary)).toBe(true);
    expect(p).toMatchObject({ layer: "L2", acceptsWidth: null, sports: ["badminton"], label: "--set void-proof" });
    // The scenario it plans is the registry's own.
    expect(Object.keys(SCENARIOS)).toContain("VOIDPROOF");
  });

  it("carry8-1280 is league|generic then knockout|badminton, each x M1 then R4, all at 1280 (L1) — the slice's own specs", () => {
    const p = carry8Planner({});
    const cases = driven(p.layered(v));
    expect(cases.map(layerCaseId)).toEqual([
      "league|generic|v-generic|M1@1280", "league|generic|v-generic|R4@1280",
      "knockout|badminton|v-badminton|M1@1280", "knockout|badminton|v-badminton|R4@1280",
    ]);
    expect(cases.every((c) => c.width === 1280 && c.layer === "L1" && c.spec.matchDay === undefined && !c.spec.canary)).toBe(true);
    expect(p).toMatchObject({ layer: "L1", acceptsWidth: L1_WIDTH, deniesFeatures: false, label: "--set carry8-1280" });
    expect([...p.sports].sort()).toEqual(["badminton", "generic"]);
    // Both rows are slice rows and both sports slice sports: the cells the committed M1/R4 runs are on.
    for (const c of cases) {
      expect(SLICE_ROWS as readonly string[]).toContain(c.spec.row);
      expect(SLICE_SPORTS as readonly string[]).toContain(c.spec.sport);
    }
    expect(cases).toHaveLength(4);
  });

  it("each set takes no filter: --only, --scenario and --canary are refused by name (a filter would be silently ignored)", () => {
    let checked = 0;
    for (const [name, planner] of [[MATCH_DAY_SET, matchDayPlanner], [VOID_PROOF_SET, voidProofPlanner], [CARRY8_1280_SET, carry8Planner]] as const) {
      for (const cli of [{ only: "league|badminton" }, { scenario: "LIFECYCLE" }, { canary: "M1" }]) {
        expect(() => planner(cli), `${name} ${JSON.stringify(cli)}`).toThrow(SetTakesNoFilter);
        checked++;
      }
    }
    expect(checked).toBe(9);
  });

  it("the set names are the brief's, registered in run.ts SETS as layered planners, recorded as `--set NAME` by planOf, and in UnknownSet's allowed list", () => {
    expect([MATCH_DAY_SET, VOID_PROOF_SET, CARRY8_1280_SET]).toEqual(["match-day", "void-proof", "carry8-1280"]);
    let checked = 0;
    for (const name of ["match-day", "void-proof", "carry8-1280"]) {
      expect(Object.prototype.hasOwnProperty.call(SETS, name), name).toBe(true);
      const planner = SETS[name]!({});
      expect("layered" in planner, `${name} is layered`).toBe(true);
      expect(planOf({ set: name, canary: undefined, layer: undefined, only: undefined, scenario: undefined, scope: undefined, rows: undefined })).toBe(`--set ${name}`);
      expect(new UnknownSet("nope").message, name).toContain(name);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("livePlan(plan) reads every carry set back: layered, every case driven, keyed without variant and with its width — and drivenInPlanOrder agrees", () => {
    const want: Record<string, string[]> = {
      "--set match-day": ["league|badminton|LIFECYCLE@1280", "league|badminton|LIFECYCLE@320"],
      "--set void-proof": ["league|badminton|VOIDPROOF@1280", "league|badminton|VOIDPROOF@320"],
      "--set carry8-1280": ["league|generic|M1@1280", "league|generic|R4@1280", "knockout|badminton|M1@1280", "knockout|badminton|R4@1280"],
    };
    let checked = 0;
    for (const [plan, keys] of Object.entries(want)) {
      const lp = livePlan(plan);
      expect(lp.layered, plan).toBe(true);
      expect([...lp.driven], plan).toEqual(keys);
      expect(lp.planned.size, plan).toBe(0);
      expect(drivenInPlanOrder(plan), plan).toEqual(keys.map(() => true));
      checked += keys.length;
    }
    expect(checked).toBe(8);
  });

  it("the set does not capture another set's plan: pad-proof still plans its own cases and carries no match day", () => {
    expect(livePlan(`--set ${PAD_PROOF_SET}`).layered).toBe(false);
    expect(noWidth(noVariant("league|badminton|bwf|LIFECYCLE@320"))).toBe("league|badminton|LIFECYCLE");
  });

  it("match-day is the ONLY planner that marks a case a match day: no other committed set or layer plans one (a flag nothing else sets cannot leak into a committed plan)", () => {
    let seen = 0;
    let marked = 0;
    for (const [name, make] of Object.entries(SETS)) {
      if (name === "pr-sample") continue; // takes --rows; planned over HTTP, no layered cases
      let specs: (CaseSpec | null)[];
      try {
        const planner = make({});
        specs = "layered" in planner ? planner.layered(v).map((c) => c.spec) : planner.plan(v);
      } catch { continue; }
      for (const spec of specs) {
        if (spec === null) continue;
        seen++;
        if (spec.matchDay === true) { marked++; expect(name).toBe("match-day"); }
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(marked).toBe(2);
  });

  it("layerOfWidth agrees with the per-case layers the sets declare (the harness's own rule, not a second table)", () => {
    for (const c of [...driven(matchDayPlanner({}).layered(v)), ...driven(voidProofPlanner({}).layered(v)), ...driven(carry8Planner({}).layered(v))]) {
      expect(c.layer).toBe(layerOfWidth(c.width));
      expect(identityOf(c).caseId.endsWith("@" + c.width)).toBe(false);
    }
  });
});

describe("dateFirstRound: the match-day case dates its first round NOW and nothing else (item 15c)", () => {
  const sport = "badminton";
  const variant = offlineBuilderDefault(sport);
  const ctxOf = (driver: FakeLeagueDriver, over: Partial<CaseSpec> = {}): ScenarioContext => {
    const spec: CaseSpec = { caseId: `league|${sport}|${variant}|LIFECYCLE`, row: "league", sport, variant, scenario: "LIFECYCLE", canary: false, matchDay: true, ...over };
    return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
  };
  const setup = async (d: FakeLeagueDriver, n = 8) => {
    const ctx = ctxOf(d);
    const rec = new Recorder();
    return { ctx, rec, setup: await setUpDivision(ctx, rec, n) };
  };

  it("dates every seated open fixture of the root stage's FIRST round, and no other: of 8 entrants' 28 fixtures only round 1's 4 are dated", async () => {
    const d = new FakeLeagueDriver();
    const { ctx, rec, setup: s } = await setup(d);
    await dateFirstRound(ctx, rec, s);
    const rows = d.rows();
    expect(rows).toHaveLength(28);
    const dated = rows.filter((r) => typeof r.scheduled_at === "string");
    expect(dated).toHaveLength(4);
    expect(dated.every((r) => r.round_no === 1)).toBe(true);
    expect(rows.filter((r) => r.round_no === 1).every((r) => typeof r.scheduled_at === "string")).toBe(true);
    expect(d.calls.filter((c) => c === "scheduleFixtureNow")).toHaveLength(4);
    expect(rec.notes.join("\n")).toMatch(/match day: dated 4 of 28/);
  });

  it("only the root stage's fixtures are dated: an open fixture of ANOTHER stage in a lower round is left alone (the first round is the stage's, not the division's)", async () => {
    const d = new FakeLeagueDriver();
    const { ctx, rec, setup: s } = await setup(d);
    d.fixtures.push({ id: "other-1", stage_id: "other-stage", pool_id: null, round_no: 0, fixture_no: 99, home_entrant_id: d.fixtures[0]!.home_entrant_id, away_entrant_id: d.fixtures[0]!.away_entrant_id, status: "scheduled", outcome: null, events: [] });
    await dateFirstRound(ctx, rec, s);
    const rows = d.rows();
    expect(rows.find((r) => r.id === "other-1")!.scheduled_at ?? null).toBeNull();
    const dated = rows.filter((r) => typeof r.scheduled_at === "string");
    expect(dated).toHaveLength(4);
    expect(dated.every((r) => r.stage_id === s.stage.id && r.round_no === 1)).toBe(true);
    expect(rec.notes.join("\n")).toMatch(/dated 4 of 28/);
  });

  it("a division whose first round is every fixture cannot tell 'today' from 'all' and is refused by name before any date is written", async () => {
    const d = new FakeLeagueDriver();
    const { ctx, rec, setup: s } = await setup(d, 2); // 2 entrants: one fixture, one round
    await expect(dateFirstRound(ctx, rec, s)).rejects.toBeInstanceOf(MatchDayUnfit);
    expect(d.calls).not.toContain("scheduleFixtureNow");
  });

  it("no seated open fixture is refused by name; a driver with no date filler is refused by name before the fixtures are listed", async () => {
    const empty = new FakeLeagueDriver();
    const a = await setup(empty);
    empty.fixtures = [];
    await expect(dateFirstRound(a.ctx, a.rec, a.setup)).rejects.toThrow(/no seated open fixture/);
    const bare = new FakeLeagueDriver();
    Object.defineProperty(bare, "scheduleFixtureNow", { value: undefined });
    const b = await setup(bare);
    const listed = bare.calls.length;
    await expect(dateFirstRound(b.ctx, b.rec, b.setup)).rejects.toThrow(/no scheduleFixtureNow/);
    expect(bare.calls.length).toBe(listed);
  });

  it("LIFECYCLE on a match-day case dates the first round BEFORE any fixture is played, and plays on exactly as before: every check passes and no other fixture is dated", async () => {
    const d = new FakeLeagueDriver();
    const out = await SCENARIOS.LIFECYCLE.run(ctxOf(d));
    const checks = [...evaluateInvariants(out.observed), ...out.assertions];
    expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`)).toEqual([]);
    expect(decideState({ checks, deferred: null, error: null }).state).toBe("works");
    // Dating precedes the first score (the browser's first rail visit is in playDivision).
    const firstDate = d.calls.indexOf("scheduleFixtureNow");
    expect(firstDate).toBeGreaterThan(-1);
    expect(firstDate).toBeLessThan(d.calls.indexOf("postStream"));
    expect(d.rows().filter((r) => typeof r.scheduled_at === "string")).toHaveLength(4);
  });

  it("a case that is not a match day dates nothing: the same scenario on the same fake leaves every fixture undated (the empty case of the new step)", async () => {
    const d = new FakeLeagueDriver();
    const spec: CaseSpec = { caseId: `league|${sport}|${variant}|LIFECYCLE`, row: "league", sport, variant, scenario: "LIFECYCLE", canary: false };
    await SCENARIOS.LIFECYCLE.run({ driver: d, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    expect(d.calls).not.toContain("scheduleFixtureNow");
    expect(d.rows().some((r) => typeof r.scheduled_at === "string")).toBe(false);
  });
});
