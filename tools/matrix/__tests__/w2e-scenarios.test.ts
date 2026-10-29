// W2e Tasks 19–24 (spec §10, D16): the opt-in deciding-path scenarios the local truth run plays with `--scenario`, one key
// per stream (W2E_ET and W2E_SO from Task 19, W2E_OT from Task 20, W2E_SUPER_OVER and W2E_DLS from Task 21). Each forces EVERY bracket match of a bracket-root row down its key's path,
// so a green run cannot have got there by the policy's rotation. Expected values come from the engine's own declarations
// (`decidedInFor` over the module's win-method table; the decider presets a bracket stage is created with), never from
// the scenario's text.
import { decidedInFor, type DecidedIn } from "@seazn/engine/competition";
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { deciderKeysFor, stageKeysFor } from "@seazn/engine/sport";
import { football } from "@seazn/engine/sports/football";
import { cricket } from "@seazn/engine/sports/cricket";
import { hockey } from "@seazn/engine/sports/hockey";
import { icehockey } from "@seazn/engine/sports/icehockey";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import { DEFAULT_FIELD, PAGE_PLAYOFF_FIELD, fieldSizeFor } from "../lib/field-size.ts";
import { foldStream } from "../lib/fold.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import type { BracketDrive } from "../lib/reference-bracket.ts";
import { decideState } from "../lib/results.ts";
import { Recorder } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { W2E_SCENARIO_KEYS, type CaseSpec, type W2eScenarioKey } from "../lib/scenarios/types.ts";
import { W2E_SCENARIO_PATHS, W2eMisplanned, everyMatchTookTheDecidingPath } from "../lib/scenarios/w2e-deciding-paths.ts";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import { resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { PROBE_LINEUPS, type ProductFold, type StreamEvent, type StreamLineups } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { bracketRootRows } from "../lib/w2a-cells.ts";
import { w2eApplies, w2eBracketCfgOf, w2eCells } from "../lib/w2e-cells.ts";
import type { FixtureStateOut } from "../lib/driver/types.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

const variantFor = offlineBuilderDefault;
/** What the product serves at /state for a fixture folded to `stream`: the engine's own summary of the fold and the fold's
 *  state, through JSON as the match_states jsonb columns hold them (apps/web usecases/fixtures.ts getFixtureState). A
 *  HAND-BUILT drive's product — the integrated runs below read it from the fake driver's /state instead. */
function productOf(module: ReturnType<typeof sportModule>, cfg: unknown, home: string, away: string, stream: readonly StreamEvent[], lineups?: StreamLineups): ProductFold {
  const { state } = foldStream(module, cfg, home, away, stream, lineups);
  return JSON.parse(JSON.stringify({ summary: module.summary(state as never), state })) as ProductFold;
}
/** What decides each key's matches, in the engine's own vocabulary (sport/module.ts DecidedIn): extra time and overtime are
 *  decided "in overtime", the shoot-out (and the GWS) "by a shoot-out". */
const DECIDED_IN: Readonly<Record<W2eScenarioKey, DecidedIn>> = { W2E_ET: "ot", W2E_SO: "so", W2E_OT: "ot", W2E_SUPER_OVER: "so", W2E_DLS: "regulation" };
/** The method a product result carries when the key's path decided it, where the engine's win-method table cannot say so on
 *  its own: a DLS win is decidedIn 'regulation' (a revised target is no extra play), so only its method names it. */
const METHOD_OF: Readonly<Partial<Record<W2eScenarioKey, string>>> = { W2E_DLS: "dls" };
/** Which of the engine's decider rule keys each scenario plays (`deciderKeysFor`: football's extraTime and shootout, the
 *  period kernel's overtime and shootout — the IIHF's is its GWS). With DECIDED_IN it names the sports the key is FOR. */
const ENGINE_DECIDER: Readonly<Record<W2eScenarioKey, string>> = { W2E_ET: "extraTime", W2E_SO: "shootout", W2E_OT: "overtime", W2E_SUPER_OVER: "superOver", W2E_DLS: "dls" };
/** The rule keys the engine lets a knockout stage set: the deciders (`decider: true`) for the first four keys; cricket's `dls`
 *  is a stage rule but no decider (a revised target is no extra play), so it is read off the stage's settable keys. */
const keysOf = (k: W2eScenarioKey, s: string): readonly string[] => (k === "W2E_DLS" ? stageKeysFor : deciderKeysFor)(sportModule(s), "knockout", variantFor(s));
/** The sports the ENGINE declares the key's decider for on a knockout, and whose bracket preset reaches the decidedIn it
 *  produces — derived from the modules, not from any generator or scenario. */
const engineSports = (k: W2eScenarioKey): string[] => SPORT_KEYS.filter((s) =>
  keysOf(k, s).includes(ENGINE_DECIDER[k])
  && sportModule(s).reachableDecidedIn(w2eBracketCfgOf(s) as never, "knockout").has(DECIDED_IN[k]));

describe("the W2e keys: frozen names, registered, opt-in", () => {
  it("the keys are W2E_ET and W2E_SO (Task 19), W2E_OT (Task 20) and W2E_SUPER_OVER and W2E_DLS (Task 21), each naming its deciding paths — the shoot-out key lists the IIHF's GWS after hockey's shoot-out; each is registered under its own key with no canary, outside the slice and the w1-driving scripts", () => {
    expect([...W2E_SCENARIO_KEYS]).toEqual(["W2E_ET", "W2E_SO", "W2E_OT", "W2E_SUPER_OVER", "W2E_DLS"]);
    expect(W2E_SCENARIO_PATHS).toEqual({ W2E_ET: ["extraTime"], W2E_SO: ["shootout", "gws"], W2E_OT: ["overtime"], W2E_SUPER_OVER: ["superOver"], W2E_DLS: ["dls"] });
    let checked = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(SCENARIOS[k].canaryCheck, k).toBeNull();
      expect((SCENARIO_KEYS as readonly string[]).includes(k), `${k} is in the slice's keys`).toBe(false);
      expect((W1_DRIVING_SCENARIOS as readonly string[]).includes(k), `${k} is one of the w1-driving scripts`).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("no filter plans none of them; a named key plans only its own cells, with the w1-driving case-id shape", () => {
    const all = planW1Driving(variantFor, {});
    expect(all.filter((c) => (W2E_SCENARIO_KEYS as readonly string[]).includes(c.scenario))).toEqual([]);
    let planned = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      const cases = planW1Driving(variantFor, { scenario: k });
      expect(cases.length, k).toBe(w2eCells(k).length);
      expect(cases.length, k).toBeGreaterThan(0);
      expect(new Set(cases.map((c) => c.scenario)), k).toEqual(new Set([k]));
      expect(cases.every((c) => c.caseId === `${c.row}|${c.sport}|${c.variant}|${k}` && !c.canary && c.overrides === undefined), k).toBe(true);
      planned += cases.length;
    }
    expect(planned).toBeGreaterThan(0);
  });

  it("a filter that plans nothing is refused by name: a sport whose generator builds no such path, a table row, an unknown key", () => {
    expect(() => planW1Driving(variantFor, { scenario: "W2E_ET", only: "knockout|football" })).not.toThrow();
    expect(() => planW1Driving(variantFor, { scenario: "W2E_ET", only: "knockout|generic" })).toThrow(/plans no case/);
    expect(() => planW1Driving(variantFor, { scenario: "W2E_SO", only: "league|football" })).toThrow(/plans no case/);
    // Task 20: the shoot-out key plans both period sports (hockey's shoot-out, the IIHF's GWS); the overtime key plans ice hockey alone.
    for (const only of ["knockout|hockey", "knockout|icehockey", "knockout|football"]) expect(() => planW1Driving(variantFor, { scenario: "W2E_SO", only }), only).not.toThrow();
    expect(() => planW1Driving(variantFor, { scenario: "W2E_OT", only: "knockout|icehockey" })).not.toThrow();
    for (const only of ["knockout|hockey", "knockout|football"]) expect(() => planW1Driving(variantFor, { scenario: "W2E_OT", only }), only).toThrow(/plans no case/);
    expect(() => planW1Driving(variantFor, { scenario: "W2E_ET", only: "knockout|icehockey" })).toThrow(/plans no case/);
    // Task 21: the super over and DLS keys plan cricket alone (a limited-overs bracket); no other sport has either.
    for (const scenario of ["W2E_SUPER_OVER", "W2E_DLS"] as const) {
      expect(() => planW1Driving(variantFor, { scenario, only: "knockout|cricket" }), scenario).not.toThrow();
      for (const only of ["knockout|football", "knockout|hockey", "knockout|icehockey", "knockout|generic"]) expect(() => planW1Driving(variantFor, { scenario, only }), `${scenario} ${only}`).toThrow(/plans no case/);
      expect(() => planW1Driving(variantFor, { scenario, only: "league|cricket" }), scenario).toThrow(/plans no case/);
    }
    expect(() => planW1Driving(variantFor, { scenario: "W2E_NOPE" })).toThrow(/--scenario.*W2E_NOPE/);
  });

  it("the field: the format's own, as LIFECYCLE seeds it (8, or a page playoff's 4)", () => {
    let checked = 0;
    for (const k of W2E_SCENARIO_KEYS) for (const row of bracketRootRows()) {
      expect(fieldSizeFor(row, k), `${row} ${k}`).toBe(stagesForRow(row).length === 1 && stagesForRow(row)[0]!.kind === "page_playoff" ? PAGE_PLAYOFF_FIELD : DEFAULT_FIELD);
      checked++;
    }
    expect(checked).toBe(W2E_SCENARIO_KEYS.length * bracketRootRows().length);
  });
});

describe("the cells: bracket-root rows × the sports whose generator builds the key's path under the bracket preset", () => {
  it("each key's sports are EXACTLY the ones the engine declares its decider for (deciderKeysFor, and the decidedIn the bracket preset reaches): extra time is football's alone, overtime ice hockey's alone, the shoot-out football's, hockey's and ice hockey's (its GWS); the cells are rows × applicable sports, less LIFECYCLE's drops", () => {
    const by = (k: W2eScenarioKey) => SPORT_KEYS.filter((s) => w2eApplies(k, s));
    let derived = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      expect(engineSports(k).length, `${k}: the engine declares its decider for some sport`).toBeGreaterThan(0);
      expect(by(k), k).toEqual(engineSports(k));
      derived += engineSports(k).length;
    }
    console.info(`w2e-scenarios: engine-derived sports ${JSON.stringify(Object.fromEntries(W2E_SCENARIO_KEYS.map((k) => [k, engineSports(k)])))}`);
    expect(derived).toBeGreaterThan(W2E_SCENARIO_KEYS.length);
    expect(engineSports("W2E_SO"), "the period sports are in the shoot-out key (Task 20)").toEqual(expect.arrayContaining(["football", "hockey", "icehockey"]));
    // Task 21: cricket alone plays a super over (a decider of its limited-overs knockouts) and a DLS-revised target.
    expect(engineSports("W2E_SUPER_OVER")).toEqual(["cricket"]);
    expect(engineSports("W2E_DLS")).toEqual(["cricket"]);
    let total = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      const cells = w2eCells(k);
      expect(cells.length, k).toBe(bracketRootRows().length * by(k).length);
      expect(cells.every((c) => forbidsLevelResult(stagesForRow(c.row)[0]!.kind as StageKind)), k).toBe(true);
      const dropped = w2eCells(k, (row, sport) => row === cells[0]!.row && sport === cells[0]!.sport);
      expect(dropped.length, `${k}: one drop`).toBe(cells.length - 1);
      total += cells.length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("a sport applies only where the bracket PRESET switches the path on: football with its deciders off builds neither", () => {
    const variant = variantFor("football");
    const off = stageCfg("football", resolveSportCfg("football", variant), "knockout", variant, { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false });
    for (const path of ["extraTime", "shootout"] as const) {
      expect(() => generateStream({ sportKey: "football", cfg: off, stageKind: "knockout", home: "h", away: "a", outcome: { kind: "win", winner: "home", path } }), path).toThrow(/the cfg does not switch/);
    }
  });
});

describe("each key, run on the knockout fake for every sport it is for", () => {
  async function runScenario(key: W2eScenarioKey, row: RowKey = "knockout", sport = "football") {
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${key}`, row, sport, variant, scenario: key, canary: false };
    const out = await SCENARIOS[key].run({ driver: new FakeKnockoutDriver(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const checks = [...evaluateInvariants(out.observed), ...out.assertions];
    return { out, checks, state: decideState({ checks, deferred: null, error: null }).state };
  }

  it("works: its own check passes on a counted item per bracket match, the shared bracket checks pass, and every product result was decided down the key's path (decidedIn from the engine) — for every sport the key is for", async () => {
    let ran = 0;
    const perKey = new Map<string, number>();
    for (const key of W2E_SCENARIO_KEYS) for (const sport of engineSports(key)) {
      const at = `${key}/${sport}`;
      const { out, checks, state } = await runScenario(key, "knockout", sport);
      expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`).join(" | "), at).toBe("");
      expect(state, at).toBe("works");
      const own = checks.find((c) => c.id === "w2e-every-match-took-the-path")!;
      expect(own, at).toBeDefined();
      expect(own.verdict, at).toBe("pass");
      const wins = out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "win");
      expect(wins.length, `${at}: more than one bracket match was decided`).toBeGreaterThan(1);
      expect(own.checked, at).toBe(wins.length);
      for (const f of wins) {
        const o = f.outcome as { kind: "win"; winner: string; method?: string };
        expect(decidedInFor(sportModule(sport), { kind: "win", winner: o.winner, loser: "x", ...(o.method === undefined ? {} : { method: o.method }) }), `${at} ${f.id}`).toBe(DECIDED_IN[key]);
        // Where decidedIn cannot name the path (a DLS win is decided in regulation), the method does.
        if (METHOD_OF[key] !== undefined) expect(o.method, `${at} ${f.id}`).toBe(METHOD_OF[key]);
      }
      for (const id of ["life-reference-bracket-finish", "life-fold-parity"]) {
        const c = checks.find((x) => x.id === id)!;
        expect(c.verdict, `${at} ${id}`).toBe("pass");
        expect(c.checked, `${at} ${id}`).toBeGreaterThan(0);
      }
      // The sport's own rule decides every match: no organiser decider is owed, so that counter is not in the scenario.
      expect(checks.some((c) => c.id === "life-bracket-decider-exercised"), at).toBe(false);
      ran++;
      perKey.set(key, (perKey.get(key) ?? 0) + 1);
    }
    console.info(`w2e-scenarios: ${ran} run(s) on the fake, per key ${JSON.stringify(Object.fromEntries(perKey))}`);
    expect(ran).toBe(W2E_SCENARIO_KEYS.reduce((n, k) => n + engineSports(k).length, 0));
    for (const key of W2E_SCENARIO_KEYS) expect(perKey.get(key) ?? 0, `${key}: no sport was run`).toBeGreaterThan(0);
  });

  it("a key planned on a cell it is not for is refused by name before any driver call: a table row, or EVERY sport the engine declares no such decider for (including the other period and football sports)", async () => {
    const tableRow = ROW_KEYS.find((r) => !bracketRootRows().includes(r))!;
    expect(tableRow, "a catalogue row whose root stage is not a bracket").toBeDefined();
    let refused = 0;
    let expected = 0;
    for (const key of W2E_SCENARIO_KEYS) {
      const cells: (readonly [RowKey, string, RegExp])[] = [
        [tableRow, engineSports(key)[0]!, /root stage is not a bracket kind/],
        ...SPORT_KEYS.filter((sport) => !engineSports(key).includes(sport)).map((sport) => ["knockout", sport, /builds no such path/] as const),
      ];
      expected += cells.length;
      for (const [row, sport, why] of cells) {
        const variant = variantFor(sport);
        const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${key}`, row, sport, variant, scenario: key, canary: false };
        const calls: string[] = [];
        const driver = new Proxy(new FakeKnockoutDriver(), { get: (t, k, r) => { calls.push(String(k)); return Reflect.get(t, k, r) as unknown; } });
        const err = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] }).then(() => null, (e: unknown) => e as Error);
        expect(err, `${key} on ${row}|${sport}`).toBeInstanceOf(W2eMisplanned);
        expect(err!.message, `${key} on ${row}|${sport}`).toMatch(why);
        expect(err!.message).toContain(key);
        expect(calls, `${key}: nothing was asked of the driver`).toEqual([]);
        refused++;
      }
    }
    expect(refused).toBe(expected);
    expect(refused).toBeGreaterThan(2 * W2E_SCENARIO_KEYS.length);
  });
});

describe("everyMatchTookTheDecidingPath, on hand-built drives (a wrong product is named, an empty run fails)", () => {
  const variant = variantFor("football");
  const cfg = stageCfg("football", resolveSportCfg("football", variant), "knockout", variant);
  const streamOf = (path: "extraTime" | "shootout"): StreamEvent[] => generateStream({ sportKey: "football", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home", path } });
  /** A drive as decideFixture records it, with the stream the harness posted. The product's method is the local fold's. */
  const drive = (path: "extraTime" | "shootout", over: Partial<BracketDrive> = {}) => {
    const stream = streamOf(path);
    const method = (foldStream(football, cfg, "a", "b", stream).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport: "football", home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(football, cfg, "a", "b", stream), ...over,
    };
    return { d, stream };
  };
  const recOf = (...drives: { d: BracketDrive; stream: StreamEvent[] }[]) => {
    const r = new Recorder();
    for (const { d, stream } of drives) { r.bracketDrives.push(d); r.streams.set(d.fixtureId, stream); }
    return r;
  };
  const cfgOf = () => cfg;

  it("the right path passes per key; a plain win, the other path, the other winner, a held match, no outcome, a product method of the other path, a missing stream each red alone; an empty run fails (R25)", () => {
    expect(everyMatchTookTheDecidingPath(recOf(drive("extraTime")), "W2E_ET", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    expect(everyMatchTookTheDecidingPath(recOf(drive("shootout")), "W2E_SO", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    const et = drive("extraTime");
    const so = drive("shootout");
    const wrong: readonly [string, { d: BracketDrive; stream: StreamEvent[] }, W2eScenarioKey][] = [
      ["a plain win", { ...et, d: { ...et.d, asked: { kind: "win", winner: "home" } } }, "W2E_ET"],
      ["the shoot-out in the ET scenario", so, "W2E_ET"],
      ["extra time in the SO scenario", et, "W2E_SO"],
      ["the product shows the other winner", { ...et, d: { ...et.d, outcome: { kind: "win", winner: "b", method: "extra_time" } } }, "W2E_ET"],
      ["held, not decided", { ...et, d: { ...et.d, status: "needs_decision" } }, "W2E_ET"],
      ["the product shows no outcome", { ...et, d: { ...et.d, outcome: null } }, "W2E_ET"],
      ["the product shows the shoot-out's method for an ET request", { ...et, d: { ...et.d, outcome: { kind: "win", winner: "a", method: "shootout" } } }, "W2E_ET"],
      ["the product shows a regulation win", { ...so, d: { ...so.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_SO"],
      ["no stream was recorded", { d: et.d, stream: [] }, "W2E_ET"],
      ["the product's own /state was not recorded (Task 21: product evidence is owed on every drive)", { ...et, d: { ...et.d, product: null } }, "W2E_ET"],
      ["a drive recorded before Task 21 carried no product at all", { ...et, d: (({ product: _p, ...rest }) => rest)(et.d) }, "W2E_ET"],
    ];
    let reds = 0;
    for (const [label, x, key] of wrong) {
      const r = new Recorder();
      r.bracketDrives.push(x.d);
      if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
      expect(everyMatchTookTheDecidingPath(r, key, cfgOf), label).toMatchObject({ verdict: "fail", checked: 1 });
      reds++;
    }
    expect(reds).toBe(wrong.length);
    expect(everyMatchTookTheDecidingPath(new Recorder(), "W2E_ET", cfgOf)).toMatchObject({ verdict: "fail", checked: 0 });
    // One wrong match among right ones is named.
    expect(everyMatchTookTheDecidingPath(recOf(et, { ...so, d: { ...so.d, fixtureId: "f2" } }), "W2E_ET", cfgOf)).toMatchObject({ verdict: "fail", checked: 2 });
  });
});

describe("everyMatchTookTheDecidingPath on ice hockey's drives (overtime, the GWS): the product's method is read through the engine, a wrong path or method is named", () => {
  const variant = variantFor("icehockey");
  const cfg = stageCfg("icehockey", resolveSportCfg("icehockey", variant), "knockout", variant);
  const streamOf = (path: "overtime" | "gws"): StreamEvent[] => generateStream({ sportKey: "icehockey", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home", path } });
  const drive = (path: "overtime" | "gws", over: Partial<BracketDrive> = {}) => {
    const stream = streamOf(path);
    const method = (foldStream(icehockey, cfg, "a", "b", stream).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport: "icehockey", home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(icehockey, cfg, "a", "b", stream), ...over,
    };
    return { d, stream };
  };
  const one = (x: { d: BracketDrive; stream: StreamEvent[] }) => {
    const r = new Recorder();
    r.bracketDrives.push(x.d);
    if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
    return r;
  };
  const cfgOf = () => cfg;

  it("the right path passes per key (the product's methods are the engine's: extra_time, shootout); the other key's path, the other method, a regulation method, the other winner and a missing stream each red alone", () => {
    const ot = drive("overtime");
    const gws = drive("gws");
    expect((ot.d.outcome as { method?: string }).method).toBe("extra_time");
    expect((gws.d.outcome as { method?: string }).method).toBe("shootout");
    expect(everyMatchTookTheDecidingPath(one(ot), "W2E_OT", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    expect(everyMatchTookTheDecidingPath(one(gws), "W2E_SO", cfgOf)).toMatchObject({ verdict: "pass", checked: 1 });
    const wrong: readonly [string, { d: BracketDrive; stream: StreamEvent[] }, W2eScenarioKey][] = [
      ["the GWS under the overtime key", gws, "W2E_OT"],
      ["the overtime under the shoot-out key", ot, "W2E_SO"],
      ["the product shows the shoot-out's method for an overtime request", { ...ot, d: { ...ot.d, outcome: { kind: "win", winner: "a", method: "shootout" } } }, "W2E_OT"],
      ["the product shows overtime's method for a GWS request", { ...gws, d: { ...gws.d, outcome: { kind: "win", winner: "a", method: "extra_time" } } }, "W2E_SO"],
      ["the product shows a regulation win for an overtime request", { ...ot, d: { ...ot.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_OT"],
      ["the product shows the other winner", { ...gws, d: { ...gws.d, outcome: { kind: "win", winner: "b", method: "shootout" } } }, "W2E_SO"],
      ["no stream was recorded", { d: gws.d, stream: [] }, "W2E_SO"],
    ];
    let reds = 0;
    for (const [label, x, key] of wrong) {
      expect(everyMatchTookTheDecidingPath(one(x), key, cfgOf), label).toMatchObject({ verdict: "fail", checked: 1 });
      reds++;
    }
    expect(reds).toBe(wrong.length);
  });
});

// ---------------------------------------------------------------------------
// Task 21 Part 1 — the witness reads the PRODUCT's /state, not only the local fold (Task 19 Important carry, Task 20 I-1).

describe("Task 21: the period sports' shoot-out name is witnessed on the product's summary headline", () => {
  /** The engine's own name for a cfg's shoot-out (kernel.ts: the `preset.shootoutLabel` the pad panel and the headline both
   *  print) - read off the pad panel that carries the sport's attempt event, never typed. */
  const labelOf = (sport: "hockey" | "icehockey", cfg: unknown): string =>
    sportModule(sport).padSpec!(cfg as never).panels.find((p) => p.actions.some((a) => a.type === `${sport}.shootout.attempt`))!.labelKey.label;
  const cases = [["hockey", hockey, "shootout"], ["icehockey", icehockey, "gws"]] as const;
  const build = (sport: "hockey" | "icehockey", module: typeof hockey | typeof icehockey, path: "shootout" | "gws") => {
    const variant = variantFor(sport);
    const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "knockout", variant);
    const stream = generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home", path } });
    const method = (foldStream(module, cfg, "a", "b", stream).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport, home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(module, cfg, "a", "b", stream),
    };
    const rec = new Recorder();
    rec.bracketDrives.push(d);
    rec.streams.set("f1", stream);
    return { cfg, d, rec };
  };
  /** The same drive, its product's headline naming `label` where the engine's own label stood. */
  const relabelled = (x: ReturnType<typeof build>, from: string, to: string): Recorder => {
    const product = JSON.parse(JSON.stringify(x.d.product)) as { summary: { headline: string } };
    product.summary.headline = product.summary.headline.replace(`(${from} `, `(${to} `);
    const rec = new Recorder();
    rec.bracketDrives.push({ ...x.d, product: product as ProductFold });
    rec.streams.set("f1", x.rec.streams.get("f1")!);
    return rec;
  };

  it("the product's headline carries the engine's label, and that label differs between the two sports (right answer differs from the wrong one)", () => {
    const labels = new Set<string>();
    for (const [sport, module, path] of cases) {
      const x = build(sport, module, path);
      const label = labelOf(sport, x.cfg);
      const headline = (x.d.product as { summary: { headline: string } }).summary.headline;
      expect(headline, sport).toContain(`(${label} `);
      labels.add(label);
    }
    expect([...labels].sort()).toEqual(["GWS", "SO"]);
  });

  it("passes on the product's own label; a headline that names the OTHER sport's label, or no shoot-out, or no summary at all, each reds the match alone — whatever the local fold says", () => {
    let reds = 0;
    for (const [sport, module, path] of cases) {
      const x = build(sport, module, path);
      const key: W2eScenarioKey = "W2E_SO";
      const cfgOf = () => x.cfg;
      expect(everyMatchTookTheDecidingPath(x.rec, key, cfgOf), `${sport} right`).toMatchObject({ verdict: "pass", checked: 1 });
      const mine = labelOf(sport, x.cfg);
      const other = mine === "SO" ? "GWS" : "SO";
      expect(everyMatchTookTheDecidingPath(relabelled(x, mine, other), key, cfgOf), `${sport} other label`).toMatchObject({ verdict: "fail", checked: 1 });
      const noTally = new Recorder();
      noTally.bracketDrives.push({ ...x.d, product: { summary: { headline: "0 — 0" }, state: (x.d.product as ProductFold).state } });
      noTally.streams.set("f1", x.rec.streams.get("f1")!);
      expect(everyMatchTookTheDecidingPath(noTally, key, cfgOf), `${sport} no tally`).toMatchObject({ verdict: "fail", checked: 1 });
      const noSummary = new Recorder();
      noSummary.bracketDrives.push({ ...x.d, product: { summary: null, state: (x.d.product as ProductFold).state } });
      noSummary.streams.set("f1", x.rec.streams.get("f1")!);
      expect(everyMatchTookTheDecidingPath(noSummary, key, cfgOf), `${sport} no summary`).toMatchObject({ verdict: "fail", checked: 1 });
      reds += 3;
    }
    expect(reds).toBe(6);
  });
});

describe("Task 21: the fake knockout driver serves a product-shaped /state, and the scenarios record it", () => {
  /** A fake that keeps every /state answer it gave, in order. */
  class Spy extends FakeKnockoutDriver {
    readonly reads: { id: string; st: FixtureStateOut }[] = [];
    override async fixtureState(id: string): Promise<FixtureStateOut> { const st = await super.fixtureState(id); this.reads.push({ id, st }); return st; }
  }

  it("a fixture nothing was posted to serves null summary and state (the product has no match_states row); a decided one serves the engine's summary of its fold and that fold's state — the playing is the scenario's own, so this is the integrated path", async () => {
    const sport = "icehockey";
    const variant = variantFor(sport);
    const driver = new Spy();
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|W2E_SO`, row: "knockout", sport, variant, scenario: "W2E_SO", canary: false };
    await SCENARIOS.W2E_SO.run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const first = new Map<string, FixtureStateOut>();
    for (const r of driver.reads) if (!first.has(r.id)) first.set(r.id, r.st);
    let untouched = 0;
    for (const [id, st] of first) {
      if (st.last_seq !== 0) continue;
      expect(st.summary, `${id} before any event`).toBeNull();
      expect(st.state, `${id} before any event`).toBeNull();
      untouched++;
    }
    expect(untouched, "some fixture was read before it was played").toBeGreaterThan(1);
    let played = 0;
    for (const f of driver.rows()) {
      const st = await driver.fixtureState(f.id);
      if (f.status !== "decided") continue;
      expect(st.state, f.id).not.toBeNull();
      expect(st.summary, f.id).not.toBeNull();
      expect((st.summary as { headline: string }).headline, f.id).toBe(sportModule(sport).summary(st.state as never).headline);
      expect(st.outcome, f.id).toMatchObject({ kind: "win" });
      played++;
    }
    expect(played, "more than one decided fixture was read").toBeGreaterThan(1);
  });
});

describe("everyMatchTookTheDecidingPath, cricket's super over and DLS on hand-built drives (Task 21: paths the outcome cannot name are read from the PRODUCT's state)", () => {
  const variant = variantFor("cricket");
  const cfg = stageCfg("cricket", resolveSportCfg("cricket", variant), "knockout", variant);
  const cfgOf = () => cfg;
  const stream = (path: "superOver" | "dls", winner: "home" | "away" = "home"): StreamEvent[] =>
    generateStream({ sportKey: "cricket", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner, path }, lineups: PROBE_LINEUPS });
  /** A drive as decideFixture records it: the stream the harness posted, the outcome the product answered, and the product's
   *  own /state - here the fold of `shown` (what the product held), which a wrong-product test replaces. */
  const drive = (path: "superOver" | "dls", over: Partial<BracketDrive> = {}) => {
    const events = stream(path);
    const method = (foldStream(cricket, cfg, "a", "b", events, PROBE_LINEUPS).outcome as { method?: string }).method;
    const d: BracketDrive = {
      fixtureId: "f1", stageKind: "knockout", sport: "cricket", home: "a", away: "b", asked: { kind: "win", winner: "home", path },
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null,
      product: productOf(cricket, cfg, "a", "b", events, PROBE_LINEUPS), lineups: PROBE_LINEUPS, ...over,
    };
    return { d, stream: events };
  };
  const one = (x: { d: BracketDrive; stream: StreamEvent[] }, key: W2eScenarioKey) => {
    const r = new Recorder();
    r.bracketDrives.push(x.d);
    if (x.stream.length > 0) r.streams.set(x.d.fixtureId, x.stream);
    return everyMatchTookTheDecidingPath(r, key, cfgOf);
  };
  /** The product's state of a plain regulation win: no super over was played and no target revised. */
  const regulation = productOf(cricket, cfg, "a", "b", generateStream({ sportKey: "cricket", cfg, stageKind: "knockout", home: "a", away: "b", outcome: { kind: "win", winner: "home" } }));

  it("the right path passes per key, counted; a super over or a revision the PRODUCT's state does not show reds even when the stream the harness posted was one (the local fold would pass)", () => {
    const so = drive("superOver");
    const dls = drive("dls");
    expect(one(so, "W2E_SUPER_OVER")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(one(dls, "W2E_DLS")).toMatchObject({ verdict: "pass", checked: 1 });
    const wrong: readonly [string, { d: BracketDrive; stream: StreamEvent[] }, W2eScenarioKey][] = [
      ["a super over the product's state never played (its outcome claims one)", { ...so, d: { ...so.d, product: regulation } }, "W2E_SUPER_OVER"],
      ["the product's state is the super over's with an unfinished pair", { ...so, d: { ...so.d, product: { ...(so.d.product as ProductFold), state: { ...(so.d.product!.state as object), superOver: { innings: [], dismissed: { home: [], away: [] } } } } } }, "W2E_SUPER_OVER"],
      ["a regulation outcome with the super over's state", { ...so, d: { ...so.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_SUPER_OVER"],
      ["no product state was recorded", { ...so, d: { ...so.d, product: null } }, "W2E_SUPER_OVER"],
      ["the lineups the stream was built against were not recorded (it cannot be refolded)", { ...so, d: { ...so.d, lineups: undefined } }, "W2E_SUPER_OVER"],
      ["a revised target the product's state never held (its outcome claims DLS)", { ...dls, d: { ...dls.d, product: regulation } }, "W2E_DLS"],
      ["a regulation outcome with a revised target's state", { ...dls, d: { ...dls.d, outcome: { kind: "win", winner: "a", method: "regulation" } } }, "W2E_DLS"],
      ["the super over's drive under the DLS key", so, "W2E_DLS"],
      ["the DLS drive under the super over key", dls, "W2E_SUPER_OVER"],
      ["the other winner", { ...so, d: { ...so.d, outcome: { kind: "win", winner: "b", method: "super_over" } } }, "W2E_SUPER_OVER"],
    ];
    for (const [label, x, key] of wrong) expect(one(x, key), label).toMatchObject({ verdict: "fail", checked: 1 });
    expect(wrong.length).toBe(10);
  });
});
