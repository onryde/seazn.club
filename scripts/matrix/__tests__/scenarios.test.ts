import { describe, expect, it } from "vitest";
import { evaluateInvariants } from "../lib/invariants.ts";
import type { ObservedFixture, ObservedRun } from "../lib/observed.ts";
import { decideState } from "../lib/results.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import {
  assertion, drawPathExercised, foldParity, formatEditRefusedNamed, loopBounded, publicStandingsMatch,
} from "../lib/scenarios/assertions.ts";
import { Recorder, byeDeclared, decideFixture, defaultPolicy, finishStage, playStage, setUpDivision, snapshot, type DivisionSetup } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { cascadeItems } from "../lib/scenarios/r4-withdrawal.ts";
import { ScenarioUnsupported, type CaseSpec, type ScenarioContext, type ScenarioKey } from "../lib/scenarios/types.ts";
import { START } from "../lib/streams/types.ts";
import { FakeLeagueDriver, FakeSwissDriver } from "./fake-driver.ts";

type Row = CaseSpec["row"];
interface Opts { canary?: boolean; row?: Row; sport?: string; variant?: string }

function ctxFor(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}): ScenarioContext {
  const sport = opts.sport ?? "generic";
  const variant = opts.variant ?? "score";
  const row = opts.row ?? "league";
  const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${scenario}`, row, sport, variant, scenario, canary: opts.canary ?? false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t" };
}

async function runOn(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}) {
  const out = await SCENARIOS[scenario].run(ctxFor(driver, scenario, opts));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { driver, out, checks, state: decideState({ checks, deferred: null, error: null }) };
}
const runFake = (scenario: ScenarioKey, opts: Opts = {}) => runOn(new FakeLeagueDriver(), scenario, opts);
const failed = (checks: { id: string; verdict: string }[]) => checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const SCENARIO_KEYS = Object.keys(SCENARIOS) as ScenarioKey[];

describe("assertion helper — empty first (R25)", () => {
  it("zero items is a fail, abstain carries a reason, one bad item fails", () => {
    expect(assertion("x", [])).toMatchObject({ verdict: "fail", checked: 0 });
    expect(assertion("x", [], "not a bracket")).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(assertion("x", [{ ok: true, note: "a" }, { ok: false, note: "b" }])).toMatchObject({ verdict: "fail", checked: 2, evidence: ["b"] });
    expect(assertion("x", [{ ok: true, note: "a" }])).toMatchObject({ verdict: "pass", checked: 1, kind: "assertion" });
  });
});

describe("shared assertions — empty case first, then each way to go red", () => {
  const fx = (over: Partial<ObservedFixture>): ObservedFixture =>
    ({ id: "f1", stageId: "s1", poolId: null, roundNo: 1, home: "a", away: "b", status: "decided", outcome: { kind: "win", winner: "a" }, declared: null, ...over });
  const run = (standings: ObservedRun["stages"][number]["standings"], fixtures: ObservedFixture[] = []): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: null, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind: "league", config: {}, field: ["a", "b"], fixtures, standings, generates: [], pairRounds: [], complete: null }],
  });

  it("foldParity: nothing posted is vacuous; a differing product outcome fails; foreign events are unjudgeable", () => {
    expect(foldParity(new Recorder())).toMatchObject({ id: "life-fold-parity", verdict: "fail", checked: 0 });
    const rec = new Recorder();
    rec.parity.push({ fixtureId: "f1", local: { kind: "win", winner: "a" }, product: { kind: "win", winner: "a" }, foreign: 0 });
    expect(foldParity(rec)).toMatchObject({ verdict: "pass", checked: 1 });
    rec.parity.push({ fixtureId: "f2", local: { kind: "win", winner: "a" }, product: { kind: "draw" }, foreign: 0 });
    expect(foldParity(rec)).toMatchObject({ verdict: "fail", checked: 2, evidence: [expect.stringMatching(/^f2: engine/)] });
    const rec2 = new Recorder();
    rec2.parity.push({ fixtureId: "f3", local: null, product: { kind: "win", winner: "a" }, foreign: 1 });
    expect(foldParity(rec2)).toMatchObject({ verdict: "fail", checked: 1, evidence: [expect.stringMatching(/f3: 1 event\(s\) .*did not post/)] });
  });

  it("publicStandingsMatch: no org table is vacuous; a missing pool, a rank and a points drift each fail", () => {
    const pub = (rows: { entrantId: string; rank: number; points?: number }[], pool: string | null = null) =>
      ({ division_id: "d1", standings: [{ stage_id: "s1", pool_id: pool, rows }] });
    const org = [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 2, points: 0 }] }];
    expect(publicStandingsMatch(run([]), pub([]))).toMatchObject({ verdict: "fail", checked: 0 });
    expect(publicStandingsMatch(run(org), pub([{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 2, points: 0 }]))).toMatchObject({ verdict: "pass", checked: 2 });
    expect(publicStandingsMatch(run(org), pub([], "p9"))).toMatchObject({ verdict: "fail", checked: 1, evidence: [expect.stringMatching(/missing from public/)] });
    expect(publicStandingsMatch(run(org), pub([{ entrantId: "a", rank: 2, points: 3 }, { entrantId: "b", rank: 1, points: 0 }]))).toMatchObject({ verdict: "fail", checked: 2 });
    expect(publicStandingsMatch(run(org), pub([{ entrantId: "a", rank: 1, points: 1 }, { entrantId: "b", rank: 2, points: 0 }]))).toMatchObject({ verdict: "fail", checked: 2, evidence: ["a: org 1/3 vs public 1/1"] });
  });

  it("drawPathExercised: abstains only when the module declares no draws; zero posted or a lost draw fails", () => {
    expect(drawPathExercised(new Recorder(), run([]), false)).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(drawPathExercised(new Recorder(), run([]), true)).toMatchObject({ verdict: "fail", checked: 1 });
    const rec = new Recorder();
    rec.drawsPosted = 2;
    expect(drawPathExercised(rec, run([], [fx({ outcome: { kind: "draw" } })]), true)).toMatchObject({ verdict: "fail", evidence: ["posted 2 draws, product shows 1"] });
    expect(drawPathExercised(rec, run([], [fx({ outcome: { kind: "draw" } }), fx({ id: "f2", outcome: { kind: "draw" } })]), true)).toMatchObject({ verdict: "pass", checked: 1 });
  });

  it("formatEditRefusedNamed: no format field abstains; only a NAMED 4xx passes (not 200, not generic CONFLICT, not 500)", () => {
    const edit = (status: number, code: string | null) => ({ attempts: [{ kind: "format" as const, status, code }], before: [], after: [] });
    expect(formatEditRefusedNamed({ attempts: [{ kind: "entrants_only", status: 200, code: null }], before: [], after: [] })).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(formatEditRefusedNamed(edit(409, "FORMAT_LOCKED"))).toMatchObject({ verdict: "pass", checked: 1 });
    expect(formatEditRefusedNamed(edit(200, null))).toMatchObject({ verdict: "fail" });
    expect(formatEditRefusedNamed(edit(409, "CONFLICT"))).toMatchObject({ verdict: "fail" });
    expect(formatEditRefusedNamed(edit(500, "MODULE_DUPLICATE"))).toMatchObject({ verdict: "fail" });
  });

  it("loopBounded: a cut_short run fails; an uncapped one passes with one item", () => {
    const rec = new Recorder();
    expect(loopBounded(rec)).toMatchObject({ id: "life-loop-bounded", verdict: "pass", checked: 1 });
    rec.facts.add("cut_short");
    expect(loopBounded(rec)).toMatchObject({ id: "life-loop-bounded", verdict: "fail", checked: 1 });
  });
});

describe("LIFECYCLE on the fake league (wiring, not product truth)", () => {
  it("drives the driver in lifecycle order and ends works", async () => {
    const { driver, state, out, checks } = await runFake("LIFECYCLE");
    const firsts = ["createCompetition", "createDivision", "postStages", "addEntrants", "start", "listStages", "generate"];
    expect(driver.calls.slice(0, firsts.length)).toEqual(firsts);
    const i = (m: string) => driver.calls.lastIndexOf(m);
    expect(i("patchDivisionConfig")).toBeLessThan(i("completeStage"));
    expect(driver.calls.filter((c) => c === "completeStage")).toHaveLength(1);
    expect(i("publicStandings")).toBeGreaterThan(i("completeStage"));
    expect(out.observed.stages[0]!.fixtures).toHaveLength(28); // 8 entrants, single RR
    expect(state, JSON.stringify(checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    expect(checks.find((c) => c.id === "life-draw-path-exercised")).toMatchObject({ verdict: "pass" });
    expect(checks.find((c) => c.id === "life-fold-parity")!.checked).toBe(28);
    expect(checks.find((c) => c.id === "life-loop-bounded")).toMatchObject({ verdict: "pass", checked: 1 });
  });

  it("the config probe: format edit refused FORMAT_LOCKED, entrants-only save accepted (Task 6 ruling)", async () => {
    const { out, checks } = await runFake("LIFECYCLE");
    expect(out.observed.configEdit!.attempts).toEqual([
      { kind: "format", status: 409, code: "FORMAT_LOCKED" },
      { kind: "entrants_only", status: 200, code: null },
    ]);
    expect(checks.find((c) => c.id === "life-format-edit-refused-named")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(checks.find((c) => c.id === "I5-config-edit-never-rescores")).toMatchObject({ verdict: "pass", checked: 28 });
  });

  it("the entrants-only probe spreads the division's CURRENT config (a stored override would otherwise read as a format change)", async () => {
    class Overridden extends FakeLeagueDriver {
      override async createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]) {
        const d = await super.createDivision(c, i);
        this.divisionConfig = { ...this.divisionConfig, points: { w: 5, d: 2, l: 1 } };
        return d;
      }
    }
    const { out } = await runOn(new Overridden(), "LIFECYCLE");
    expect(out.observed.configEdit!.attempts.find((a) => a.kind === "entrants_only")).toEqual({ kind: "entrants_only", status: 200, code: null });
  });

  it("PF8: events counts every event the harness posted, derived from what the product holds", async () => {
    const { driver, out } = await runFake("LIFECYCLE");
    const held = driver.fixtures.reduce((n, f) => n + f.events.length, 0);
    expect(held).toBeGreaterThan(0);
    expect(out.events).toBe(held);
  });

  it.each([["generic", "win_loss"], ["badminton", "bwf"]])("%s/%s: a sport with no draws still works; the draw check abstains", async (sport, variant) => {
    const { state, checks } = await runFake("LIFECYCLE", { sport, variant });
    expect(state, JSON.stringify(checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    expect(checks.find((c) => c.id === "life-draw-path-exercised")).toMatchObject({ verdict: "abstain" });
  });
});

describe("pilots on the fake league", () => {
  it("M1: walkover recorded for seed 1; the canary expects the absent side and goes red on that check", async () => {
    expect((await runFake("M1")).state.state).toBe("works");
    const canary = await runFake("M1", { canary: true });
    expect(canary.state.state).toBe("red");
    expect(failed(canary.checks)).toEqual(["m1-walkover-recorded"]);
  });
  it("R4: policy reported and cascade consistent; the canary evaluates the opposite policy", async () => {
    const r = await runFake("R4");
    expect(r.out.observed.facts).toContain("withdrawn");
    expect(r.checks.find((c) => c.id === "r4-cascade-consistent")).toMatchObject({ verdict: "pass" });
    const canary = await runFake("R4", { canary: true });
    expect(failed(canary.checks)).toEqual(["r4-cascade-consistent"]);
  });
  it("F1: 7 entrants, every round seats floor(7/2)=3; the canary's ceil goes red", async () => {
    const r = await runFake("F1");
    expect(r.checks.find((c) => c.id === "f1-round-size")).toMatchObject({ verdict: "pass", checked: 7 });
    const canary = await runFake("F1", { canary: true });
    expect(failed(canary.checks)).toEqual(["f1-round-size"]);
  });
  it("every scenario is registered under its own key and the three pilots name their canary check", () => {
    expect(SCENARIO_KEYS.sort()).toEqual(["F1", "LIFECYCLE", "M1", "R4"]);
    for (const k of SCENARIO_KEYS) expect(SCENARIOS[k].key).toBe(k);
    expect(SCENARIOS.LIFECYCLE.canaryCheck).toBeNull();
    expect([SCENARIOS.M1.canaryCheck, SCENARIOS.R4.canaryCheck, SCENARIOS.F1.canaryCheck]).toEqual(["m1-walkover-recorded", "r4-cascade-consistent", "f1-round-size"]);
  });
});

describe("PF5: a cut_short run is red in EVERY scenario, through life-loop-bounded", () => {
  // generate keeps answering the round-1 fixtures as still open while the
  // fixtures themselves are finished, so the loop never runs dry.
  class Stuck extends FakeLeagueDriver {
    override async generate() {
      const g = await super.generate();
      return { ...g, fixtures: g.fixtures.map((f) => (f.round_no === 1 ? { ...f, status: "scheduled", outcome: null } : f)).filter((f) => f.round_no === 1) };
    }
  }
  it.each(["LIFECYCLE", "M1", "R4", "F1"] as const)("%s", async (k) => {
    const r = await runOn(new Stuck(), k);
    expect(r.out.observed.facts).toContain("cut_short");
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual(["life-loop-bounded"]);
  });
});

describe("deferrals are named", () => {
  it("a multi-stage row is ScenarioUnsupported(W1b), not a crash, before any driver call", async () => {
    const driver = new FakeLeagueDriver();
    await expect(runOn(driver, "LIFECYCLE", { row: "league_ko" })).rejects.toBeInstanceOf(ScenarioUnsupported);
    await expect(runOn(driver, "LIFECYCLE", { row: "league_ko" })).rejects.toMatchObject({ wave: "W1b", message: expect.stringMatching(/multi-stage/) });
    expect(driver.calls).toEqual([]);
  });
  it.each(["ladder", "americano", "mexicano"] as const)("%s is ScenarioUnsupported(W1b) before any driver call", async (row) => {
    const driver = new FakeLeagueDriver();
    await expect(runOn(driver, "LIFECYCLE", { row })).rejects.toMatchObject({ name: "ScenarioUnsupported", wave: "W1b", message: expect.stringContaining(row) });
    expect(driver.calls).toEqual([]);
  });
  it("a team sport is ScenarioUnsupported(W1b, team rosters) before any driver call", async () => {
    const driver = new FakeLeagueDriver();
    const football = Object.keys(sportModule("football").variants as object)[0]!;
    await expect(runOn(driver, "LIFECYCLE", { sport: "football", variant: football })).rejects.toMatchObject({ name: "ScenarioUnsupported", wave: "W1b", message: "team rosters" });
    expect(driver.calls).toEqual([]);
  });
});

describe("decideFixture — the local fold is the fixture's WHOLE stream (Task 6 ruling)", () => {
  async function onBadminton() {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { sport: "badminton", variant: "bwf" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    const f = (await driver.listFixtures("d1"))[0]!;
    return { driver, ctx, rec, setup, f };
  }
  it("a forfeit on a live fixture the harness already started posts only core.forfeit and folds the full stream", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    await driver.postStream(f.id, [START], "t");
    rec.streams.set(f.id, [START]);
    await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: "away", reason: "retired hurt" });
    const held = driver.fixtures.find((x) => x.id === f.id)!.events;
    expect(held.map((e) => e.type)).toEqual(["core.start", "core.forfeit"]);
    expect(rec.streams.get(f.id)).toEqual(held);
    expect(rec.events).toBe(1);
    expect(foldParity(rec)).toMatchObject({ verdict: "pass", checked: 1 });
    expect(rec.declared.get(f.id)).toMatchObject({ forOutcome: { kind: "award", winner: f.home_entrant_id } });
  });
  it("events on the fixture the harness never posted make parity unjudgeable, not a silent pass", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    await driver.postStream(f.id, [START], "t"); // not recorded: a foreign write
    await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: "away", reason: "walkover" });
    expect(foldParity(rec)).toMatchObject({ verdict: "fail", checked: 1 });
    expect(rec.declared.has(f.id)).toBe(false);
  });
  it("a fixture already finished (a server cascade) is left alone", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    await driver.forfeit(f.id, f.away_entrant_id!, "walkover", "x");
    const before = driver.calls.length;
    await decideFixture(ctx, rec, setup, f, { kind: "win", winner: "home" });
    expect(driver.calls.slice(before)).toEqual(["fixtureState"]);
    expect(rec.parity).toHaveLength(0);
  });
});

describe("defaultPolicy — draws only where the module declares them, else the better seed wins", () => {
  const setup = { seedOf: (id: string) => Number(id.slice(1)) } as unknown as DivisionSetup;
  const f = { home_entrant_id: "e5", away_entrant_id: "e2" } as never;
  it("every third decision is a draw when drawOk, never otherwise; the lower seed number wins from either side", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => defaultPolicy(setup, f, true, n).kind)).toEqual(["win", "win", "draw", "win", "win", "draw"]);
    expect([0, 1, 2].map((n) => defaultPolicy(setup, f, false, n))).toEqual([0, 1, 2].map(() => ({ kind: "win", winner: "away" })));
    expect(defaultPolicy(setup, { home_entrant_id: "e1", away_entrant_id: "e2" } as never, false, 0)).toEqual({ kind: "win", winner: "home" });
  });
});

describe("snapshot — byes are declared, pools stay separate (Task 5 carries)", () => {
  it("byeDeclared is standingsDelta for the award, on the seated side; two-sided and non-award rows are not byes", () => {
    const cfg = resolveSportCfg("generic", "score", { points: { w: 5, d: 2, l: 1 } }) as { points: { w: number } };
    expect(cfg.points.w).toBe(5); // the override applied, and differs from the default 3
    const bye = (home: string | null, away: string | null): ObservedFixture =>
      ({ id: "b", stageId: "s1", poolId: null, roundNo: 2, home, away, status: "forfeited", outcome: { kind: "award", winner: "a", method: "bye" }, declared: null });
    expect(byeDeclared("generic", cfg, "swiss", bye("a", null))).toEqual({ home: cfg.points.w, away: 0, forOutcome: { kind: "award", winner: "a", method: "bye" } });
    expect(byeDeclared("generic", cfg, "swiss", bye(null, "a"))).toEqual({ home: 0, away: cfg.points.w, forOutcome: { kind: "award", winner: "a", method: "bye" } });
    expect(byeDeclared("generic", cfg, "swiss", bye("a", "c"))).toBeNull();
    expect(byeDeclared("generic", cfg, "swiss", { ...bye("a", null), outcome: { kind: "draw" } })).toBeNull();
    expect(byeDeclared("generic", cfg, "swiss", { ...bye("a", null), outcome: null })).toBeNull();
  });

  it("a 5-entrant 5-round swiss gives everyone a bye and I3 still checks all 5 (not vacuous)", async () => {
    const driver = new FakeSwissDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { row: "swiss" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 5);
    await playStage(ctx, rec, setup);
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
    const byes = observed.stages[0]!.fixtures.filter((f) => f.away === null);
    expect(new Set(byes.map((f) => f.home))).toEqual(new Set(setup.entrants.map((e) => e.id)));
    expect(byes.every((f) => f.declared !== null)).toBe(true);
    expect(evaluateInvariants(observed).find((c) => c.id === "I3-table-points-equal-declared")).toMatchObject({ verdict: "pass", checked: 5 });
  });

  it("each pool's table is read on its own and keeps its poolId (a merged table would red I1/I3)", async () => {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE");
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    driver.fixtures.forEach((f, i) => { f.pool_id = i % 2 === 0 ? "p1" : "p2"; });
    const observed = await snapshot(ctx, rec, setup, { complete: { status: 200, code: null, completed: false, finalRanks: null }, configEdit: null, withdrawal: null });
    expect(observed.stages[0]!.standings.map((p) => p.poolId).sort()).toEqual(["p1", "p2"]);
    expect(driver.calls.filter((c) => c === "standings")).toHaveLength(2);
  });
});

describe("the swiss branch of playStage on the swiss fake", () => {
  it.each(SCENARIO_KEYS.map((k) => [k]))("%s works, and pairs exactly the round budget, one round per generate", async (k) => {
    const r = await runOn(new FakeSwissDriver(), k, { row: "swiss" });
    expect(r.state, JSON.stringify(r.checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    const s = r.out.observed.stages[0]!;
    const budget = Number(s.config.rounds);
    expect(budget).toBeGreaterThan(1);
    expect(s.pairRounds.map((p) => p.roundNo)).toEqual(Array.from({ length: budget }, (_, i) => i + 1));
    // Seated = floor(active field / 2): every entrant until the R4 withdrawal after round 1.
    const active = (round: number) => s.field.length - (k === "R4" && round > 1 ? 1 : 0);
    expect(s.pairRounds.map((p) => p.seated)).toEqual(s.pairRounds.map((p) => Math.floor(active(p.roundNo) / 2)));
    expect(r.checks.find((c) => c.id === "I6-swiss-no-rematch")).toMatchObject({ verdict: "pass" });
  });
  it("R4 on swiss: walkover policy, and the withdrawn entrant is never paired again", async () => {
    const r = await runOn(new FakeSwissDriver(), "R4", { row: "swiss" });
    expect(r.out.observed.withdrawal).toMatchObject({ policy: "walkover" });
    expect(r.checks.find((c) => c.id === "r4-not-paired-later")).toMatchObject({ verdict: "pass" });
    expect(r.checks.find((c) => c.id === "r4-not-paired-later")!.checked).toBeGreaterThan(0);
  });
  it("F1 on swiss inspects every round", async () => {
    const r = await runOn(new FakeSwissDriver(), "F1", { row: "swiss" });
    expect(r.checks.find((c) => c.id === "f1-round-size")).toMatchObject({ verdict: "pass", checked: Number(r.out.observed.stages[0]!.config.rounds) });
  });
});

describe("cascadeItems — consistency with the policy the engine CHOSE", () => {
  const after = (id: string, status: string, outcome: ObservedFixture["outcome"], home: string | null = "w", away: string | null = "x"): ObservedFixture =>
    ({ id, stageId: "s1", poolId: null, roundNo: 2, home, away, status, outcome, declared: null });
  const ok = (items: { ok: boolean }[]) => items.map((i) => i.ok);

  it("expunge: every touched fixture abandons; finalized and cancelled are left as they were", () => {
    const before = [
      { id: "a", status: "decided", outcome: { kind: "win" as const, winner: "w" } },
      { id: "b", status: "scheduled", outcome: null },
      { id: "c", status: "finalized", outcome: { kind: "win" as const, winner: "x" } },
      { id: "d", status: "cancelled", outcome: null },
    ];
    const good = [after("a", "abandoned", null), after("b", "abandoned", null), after("c", "finalized", { kind: "win", winner: "x" }), after("d", "cancelled", null)];
    expect(ok(cascadeItems("expunge", "w", before, good, 0))).toEqual([true, true, true, true]);
    const bad = [after("a", "decided", { kind: "win", winner: "w" }), after("b", "forfeited", { kind: "award", winner: "x" }), after("c", "abandoned", null), after("d", "abandoned", null)];
    expect(ok(cascadeItems("expunge", "w", before, bad, 0))).toEqual([false, false, false, false]);
  });

  it("walkover: a pending game goes to the OPPONENT; a TBD seat is voided; the reported count must match", () => {
    const before = [
      { id: "a", status: "decided", outcome: { kind: "win" as const, winner: "w" } },
      { id: "b", status: "scheduled", outcome: null },
      { id: "t", status: "scheduled", outcome: null },
    ];
    const good = [after("a", "decided", { kind: "win", winner: "w" }), after("b", "forfeited", { kind: "award", winner: "x" }), after("t", "abandoned", null, "w", null)];
    expect(ok(cascadeItems("walkover", "w", before, good, 1))).toEqual([true, true, true, true]);
    expect(ok(cascadeItems("walkover", "w", before, good, 2))).toEqual([true, true, true, false]);
    const toW = [good[0]!, after("b", "forfeited", { kind: "award", winner: "w" }), good[2]!];
    expect(ok(cascadeItems("walkover", "w", before, toW, 0))).toEqual([true, false, true, true]);
    expect(ok(cascadeItems("walkover", "w", before, [good[0]!, good[1]!], 1))).toEqual([true, true, false, true]);
  });
});
