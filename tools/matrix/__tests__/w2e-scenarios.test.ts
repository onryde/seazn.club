// W2e Tasks 19–24 (spec §10, D16): the opt-in deciding-path scenarios the local truth run plays with `--scenario`, one key
// per stream (W2E_ET and W2E_SO from Task 19). Each forces EVERY bracket match of a bracket-root row down its key's path,
// so a green run cannot have got there by the policy's rotation. Expected values come from the engine's own declarations
// (`decidedInFor` over the module's win-method table; the decider presets a bracket stage is created with), never from
// the scenario's text.
import { decidedInFor } from "@seazn/engine/competition";
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { football } from "@seazn/engine/sports/football";
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
import { resolveSportCfg, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { bracketRootRows } from "../lib/w2a-cells.ts";
import { w2eApplies, w2eCells } from "../lib/w2e-cells.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

const variantFor = offlineBuilderDefault;
/** What decides each key's matches, in the engine's own vocabulary (sport/module.ts DecidedIn): extra time is decided
 *  "in overtime", the shoot-out "by a shoot-out". */
const DECIDED_IN: Readonly<Record<W2eScenarioKey, "ot" | "so">> = { W2E_ET: "ot", W2E_SO: "so" };

describe("the W2e keys: frozen names, registered, opt-in", () => {
  it("Task 19's keys are W2E_ET and W2E_SO, each naming its deciding path; each is registered under its own key with no canary, outside the slice and the w1-driving scripts", () => {
    expect([...W2E_SCENARIO_KEYS]).toEqual(["W2E_ET", "W2E_SO"]);
    expect(W2E_SCENARIO_PATHS).toEqual({ W2E_ET: ["extraTime"], W2E_SO: ["shootout"] });
    let checked = 0;
    for (const k of W2E_SCENARIO_KEYS) {
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(SCENARIOS[k].canaryCheck, k).toBeNull();
      expect((SCENARIO_KEYS as readonly string[]).includes(k), `${k} is in the slice's keys`).toBe(false);
      expect((W1_DRIVING_SCENARIOS as readonly string[]).includes(k), `${k} is one of the w1-driving scripts`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
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
    expect(() => planW1Driving(variantFor, { scenario: "W2E_NOPE" })).toThrow(/--scenario.*W2E_NOPE/);
  });

  it("the field: the format's own, as LIFECYCLE seeds it (8, or a page playoff's 4)", () => {
    let checked = 0;
    for (const k of W2E_SCENARIO_KEYS) for (const row of bracketRootRows()) {
      expect(fieldSizeFor(row, k), `${row} ${k}`).toBe(stagesForRow(row).length === 1 && stagesForRow(row)[0]!.kind === "page_playoff" ? PAGE_PLAYOFF_FIELD : DEFAULT_FIELD);
      checked++;
    }
    expect(checked).toBe(2 * bracketRootRows().length);
  });
});

describe("the cells: bracket-root rows × the sports whose generator builds the key's path under the bracket preset", () => {
  it("W2E_ET is football's alone (extra time is football's decider; single-sport by its rule); W2E_SO holds football; the cells are rows × applicable sports, less LIFECYCLE's drops", () => {
    const by = (k: W2eScenarioKey) => SPORT_KEYS.filter((s) => w2eApplies(k, s));
    expect(by("W2E_ET")).toEqual(["football"]);
    expect(by("W2E_SO")).toContain("football");
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

describe("each key, run on the football knockout fake", () => {
  async function runScenario(key: W2eScenarioKey, row: RowKey = "knockout", sport = "football") {
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${key}`, row, sport, variant, scenario: key, canary: false };
    const out = await SCENARIOS[key].run({ driver: new FakeKnockoutDriver(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const checks = [...evaluateInvariants(out.observed), ...out.assertions];
    return { out, checks, state: decideState({ checks, deferred: null, error: null }).state };
  }

  it("works: its own check passes on a counted item per bracket match, the shared bracket checks pass, and every product result was decided down the key's path (decidedIn from the engine)", async () => {
    let ran = 0;
    for (const key of W2E_SCENARIO_KEYS) {
      const { out, checks, state } = await runScenario(key);
      expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`).join(" | "), key).toBe("");
      expect(state, key).toBe("works");
      const own = checks.find((c) => c.id === "w2e-every-match-took-the-path")!;
      expect(own, key).toBeDefined();
      expect(own.verdict, key).toBe("pass");
      const wins = out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "win");
      expect(wins.length, `${key}: more than one bracket match was decided`).toBeGreaterThan(1);
      expect(own.checked, key).toBe(wins.length);
      for (const f of wins) {
        const o = f.outcome as { kind: "win"; winner: string; method?: string };
        expect(decidedInFor(football, { kind: "win", winner: o.winner, loser: "x", ...(o.method === undefined ? {} : { method: o.method }) }), `${key} ${f.id}`).toBe(DECIDED_IN[key]);
      }
      for (const id of ["life-reference-bracket-finish", "life-fold-parity"]) {
        const c = checks.find((x) => x.id === id)!;
        expect(c.verdict, `${key} ${id}`).toBe("pass");
        expect(c.checked, `${key} ${id}`).toBeGreaterThan(0);
      }
      // The sport's own rule decides every match: no organiser decider is owed, so that counter is not in the scenario.
      expect(checks.some((c) => c.id === "life-bracket-decider-exercised"), key).toBe(false);
      ran++;
    }
    expect(ran).toBe(W2E_SCENARIO_KEYS.length);
  });

  it("a key planned on a cell it is not for is refused by name before any driver call: a table row, or a sport whose generator builds no such path", async () => {
    const tableRow = ROW_KEYS.find((r) => !bracketRootRows().includes(r))!;
    expect(tableRow, "a catalogue row whose root stage is not a bracket").toBeDefined();
    let refused = 0;
    for (const key of W2E_SCENARIO_KEYS) {
      for (const [row, sport, why] of [[tableRow, "football", /root stage is not a bracket kind/], ["knockout", "generic", /builds no such path/]] as const) {
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
    expect(refused).toBe(2 * W2E_SCENARIO_KEYS.length);
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
      levelAs: null, status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) }, loser: { line: "none" }, next: { line: "none" }, forfeitPlay: null, refusal: null, ...over,
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
