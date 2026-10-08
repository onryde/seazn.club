// W2a Task 14 Step 4: the five opt-in bracket-finish scenarios. Expected values come from the rule rows (GN-KO-1,
// CA-KO-1, BG-KO-1, X-BR-1/2, X-ST-1), the spec's frozen refusal (409 LEVEL_RESULT_IN_BRACKET) and the engine's own
// SETTLE_METHODS / TIEBREAK_RUNGS — never from the scenarios' text. Needs loop D's exports: red until D merges.
import { SETTLE_METHODS, forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import type { OrganiserDriver, PostedEvent } from "../lib/driver/types.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { decideState } from "../lib/results.ts";
import { fieldSizeFor } from "../lib/field-size.ts";
import type { BracketDrive } from "../lib/reference-bracket.ts";
import { Recorder, decideFixture, setUpDivision } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { W2A_SCENARIO_KEYS, type CaseSpec, type W2aScenarioKey } from "../lib/scenarios/types.ts";
import { LEVEL_RESULT_IN_BRACKET, W2A_SCENARIOS, W2aMisplanned, everyGamePlayedTheExtraBoard, everyMatchTookThePath, genericDrawRefused, type RefusalProbe } from "../lib/scenarios/w2a-bracket-finish.ts";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import { drawsAllowed, resolveSportCfg } from "../lib/sport-cfg.ts";
import { levelReachable } from "../lib/streams/index.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { bracketCfgOf, bracketRootRows, w2aApplies, w2aCells } from "../lib/w2a-cells.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

const variantFor = offlineBuilderDefault;
// The five keys and, for each, the (row, sport) it is run on in these tests: a bracket-root row, and the sport whose rule it is.
const RUN_ON: Readonly<Record<W2aScenarioKey, string>> = {
  BRACKET_SETTLE_LEVEL: "football", BRACKET_SETTLE_ABANDON: "generic", BRACKET_TIEBREAK: "boardgame", BRACKET_EXTRA_BOARD: "carrom", BRACKET_NO_DRAW_GENERIC: "generic",
};

describe("the five keys: frozen names, registered, opt-in", () => {
  it("W2A_SCENARIOS are the plan's five keys; each is registered with its own key and no canary; the slice never plans them", () => {
    expect([...W2A_SCENARIOS]).toEqual(["BRACKET_SETTLE_LEVEL", "BRACKET_SETTLE_ABANDON", "BRACKET_TIEBREAK", "BRACKET_EXTRA_BOARD", "BRACKET_NO_DRAW_GENERIC"]);
    let checked = 0;
    for (const k of W2A_SCENARIO_KEYS) {
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(SCENARIOS[k].canaryCheck, k).toBeNull();
      expect((SCENARIO_KEYS as readonly string[]).includes(k), `${k} is in the slice's keys`).toBe(false);
      expect((W1_DRIVING_SCENARIOS as readonly string[]).includes(k), `${k} is one of the w1-driving scripts`).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("no filter plans none of them (the committed plan is the four scripts and the cricket test cases), and a named one plans only its own cells", () => {
    const all = planW1Driving(variantFor, {});
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((c) => (W2A_SCENARIOS as readonly string[]).includes(c.scenario))).toEqual([]);
    expect(new Set(all.map((c) => c.scenario))).toEqual(new Set(["LIFECYCLE", "M1", "R4", "F1"]));
    let planned = 0;
    for (const k of W2A_SCENARIO_KEYS) {
      const cases = planW1Driving(variantFor, { scenario: k });
      expect(cases.length, k).toBeGreaterThan(0);
      expect(new Set(cases.map((c) => c.scenario)), k).toEqual(new Set([k]));
      expect(cases.every((c) => c.caseId === `${c.row}|${c.sport}|${c.variant}|${k}` && !c.canary), k).toBe(true);
      planned += cases.length;
    }
    expect(planned).toBeGreaterThan(0);
  });

  it("a cell the committed drop list drops from LIFECYCLE is not a bracket-finish cell either: dropped from the plan, the rest stay", () => {
    type Drops = { has: (atom: string, row: string, sport: string) => boolean; reason: (atom: string, row: string, sport: string) => string | undefined };
    const none: Drops = { has: () => false, reason: () => undefined };
    const drop: Drops = { has: (atom, row, sport) => atom === "LIFECYCLE" && row === "knockout" && sport === "football", reason: () => "no football knockout here" };
    const ids = (deps: { drops: () => Drops }) => planW1Driving(variantFor, { scenario: "BRACKET_SETTLE_LEVEL" }, deps).map((c) => `${c.row}|${c.sport}`);
    const all = ids({ drops: () => none });
    const less = ids({ drops: () => drop });
    expect(all).toContain("knockout|football");
    expect(less).not.toContain("knockout|football");
    expect(less.length).toBe(all.length - 1);
    // a drop of ANOTHER script's atom (M1) does not touch it
    const other = ids({ drops: () => ({ has: (atom) => atom === "M1", reason: () => undefined }) });
    expect(other).toEqual(all);
  });

  it("an unknown scenario is still refused by name, listing the four and the five", () => {
    expect(() => planW1Driving(variantFor, { scenario: "BRACKET_NOPE" })).toThrow(/--scenario.*BRACKET_NOPE/);
    expect(() => planW1Driving(variantFor, { scenario: "BRACKET_TIEBREAK", only: "knockout|boardgame" })).not.toThrow();
    // a filter that plans nothing is refused by name, never read as "run zero cases": chess is the only sport with a tie-break
    expect(() => planW1Driving(variantFor, { scenario: "BRACKET_TIEBREAK", only: "knockout|football" })).toThrow(/plans no case/);
    // and a table row is not a bracket cell
    expect(() => planW1Driving(variantFor, { scenario: "BRACKET_SETTLE_ABANDON", only: "league|generic" })).toThrow(/plans no case/);
  });
});

describe("the cells: bracket-root rows × the sports whose rule the scenario is, derived", () => {
  it("the rows are exactly the catalogue's whose root stage forbids a level result, and there are some", () => {
    const rows = bracketRootRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of ROW_KEYS) expect(rows.includes(r), r).toBe(forbidsLevelResult(stagesForRow(r)[0]!.kind as StageKind));
    expect(rows).toContain("knockout");
  });

  it("per scenario, over the sport registry: a level settle exactly where a level result is reachable, an abandon settle everywhere a bracket abandons, a tie-break for chess alone, an extra board for carrom alone, a refused draw for generic alone", () => {
    const by = (k: W2aScenarioKey) => SPORT_KEYS.filter((s) => w2aApplies(k, s));
    expect(by("BRACKET_SETTLE_LEVEL")).toEqual(SPORT_KEYS.filter((s) => levelReachable(s, bracketCfgOf(s), "knockout")));
    expect(by("BRACKET_SETTLE_LEVEL")).not.toContain("generic"); // GN-KO-1
    expect(by("BRACKET_SETTLE_LEVEL")).toContain("football");
    expect(by("BRACKET_SETTLE_ABANDON")).toContain("generic");
    expect(by("BRACKET_SETTLE_ABANDON").length).toBeGreaterThanOrEqual(by("BRACKET_SETTLE_LEVEL").length);
    expect(by("BRACKET_TIEBREAK")).toEqual(["boardgame"]); // BG-KO-1
    expect(by("BRACKET_EXTRA_BOARD")).toEqual(["carrom"]); // CA-KO-1
    expect(by("BRACKET_NO_DRAW_GENERIC")).toEqual(["generic"]); // GN-KO-1
    expect(drawsAllowed("generic", resolveSportCfg("generic", variantFor("generic")), "league")).toBe(true); // the draw the probe posts exists
  });

  it("w2aCells is rows × applicable sports, less what LIFECYCLE's drop list drops, and says how many", () => {
    let total = 0;
    for (const k of W2A_SCENARIO_KEYS) {
      const cells = w2aCells(k);
      expect(cells.length, k).toBe(bracketRootRows().length * SPORT_KEYS.filter((s) => w2aApplies(k, s)).length);
      expect(cells.length, k).toBeGreaterThan(0);
      const dropped = w2aCells(k, (row, sport) => row === cells[0]!.row && sport === cells[0]!.sport);
      expect(dropped.length, `${k}: one drop`).toBe(cells.length - 1);
      total += cells.length;
    }
    expect(total).toBeGreaterThan(0);
  });
});

describe("each scenario, run on the knockout fake of the sport whose rule it is", () => {
  async function runScenario(key: W2aScenarioKey, driver: OrganiserDriver = new FakeKnockoutDriver()) {
    const sport = RUN_ON[key];
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|${key}`, row: "knockout", sport, variant, scenario: key, canary: false };
    const out = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const checks = [...evaluateInvariants(out.observed), ...out.assertions];
    return { out, checks, state: decideState({ checks, deferred: null, error: null }).state };
  }
  const OWN: Readonly<Record<W2aScenarioKey, string>> = {
    BRACKET_SETTLE_LEVEL: "w2a-every-match-settled", BRACKET_SETTLE_ABANDON: "w2a-every-match-settled", BRACKET_TIEBREAK: "w2a-every-match-tiebroken",
    BRACKET_EXTRA_BOARD: "w2a-every-game-played-the-extra-board", BRACKET_NO_DRAW_GENERIC: "w2a-generic-draw-refused",
  };

  it("works, with its own check passing on a counted item and the shared bracket checks passing too — over all five", async () => {
    let ran = 0;
    for (const key of W2A_SCENARIO_KEYS) {
      const { checks, state } = await runScenario(key);
      expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`).join(" | "), key).toBe("");
      expect(state, key).toBe("works");
      const own = checks.find((c) => c.id === OWN[key])!;
      expect(own, key).toBeDefined();
      expect(own.verdict, key).toBe("pass");
      expect(own.checked, key).toBeGreaterThan(0);
      // The extra board IS carrom's decider (CA-KO-1): the organiser-decider counter is not part of that scenario.
      const shared = key === "BRACKET_EXTRA_BOARD" ? ["life-reference-bracket-finish"] : ["life-bracket-decider-exercised", "life-reference-bracket-finish"];
      expect(checks.some((c) => c.id === "life-bracket-decider-exercised"), `${key}: the organiser-decider counter is in the scenario iff an organiser decides`).toBe(key !== "BRACKET_EXTRA_BOARD");
      for (const id of shared) {
        const c = checks.find((x) => x.id === id)!;
        expect(c.verdict, `${key} ${id}`).toBe("pass");
        expect(c.checked, `${key} ${id}`).toBeGreaterThan(0);
      }
      ran++;
    }
    expect(ran).toBe(W2A_SCENARIO_KEYS.length);
  });

  it("a scenario planned on a cell it is not for is refused by name before any driver call: a table row, or a sport whose rule it is not", async () => {
    let refused = 0;
    let wrongSports = 0;
    for (const key of W2A_SCENARIO_KEYS) {
      const rightSport = RUN_ON[key];
      const tableRow = ROW_KEYS.find((r) => !bracketRootRows().includes(r));
      expect(tableRow, "a catalogue row whose root stage is not a bracket").toBeDefined();
      // BRACKET_SETTLE_ABANDON is every sport's rule (a bracket abandons whatever the sport), so it has no wrong sport.
      const wrongSport = SPORT_KEYS.find((x) => !w2aApplies(key, x));
      const cells: { row: RowKey; sport: string; why: RegExp }[] = [
        { row: tableRow!, sport: rightSport, why: /root stage is not a bracket kind/ },
        ...(wrongSport === undefined ? [] : [{ row: "knockout" as const, sport: wrongSport, why: /sport's rules do not build the path/ }]),
      ];
      if (wrongSport !== undefined) wrongSports++;
      for (const cell of cells) {
        const variant = variantFor(cell.sport);
        const spec: CaseSpec = { caseId: `${cell.row}|${cell.sport}|${variant}|${key}`, row: cell.row, sport: cell.sport, variant, scenario: key, canary: false };
        const calls: string[] = [];
        const driver = new Proxy(new FakeKnockoutDriver(), { get: (t, k, r) => { calls.push(String(k)); return Reflect.get(t, k, r) as unknown; } });
        const err = await SCENARIOS[key].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(cell.sport, variant), tag: "t", denied: [] }).then(() => null, (e: unknown) => e as Error);
        expect(err, `${key} on ${cell.row}|${cell.sport}`).toBeInstanceOf(W2aMisplanned);
        expect(err!.message, `${key} on ${cell.row}|${cell.sport}`).toMatch(cell.why);
        expect(err!.message).toContain(key);
        expect(calls, `${key}: nothing was asked of the driver`).toEqual([]);
        refused++;
      }
    }
    expect(wrongSports).toBe(W2A_SCENARIO_KEYS.length - 1);
    expect(refused).toBe(W2A_SCENARIO_KEYS.length + wrongSports);
  });

  it("every match of a SETTLE or TIE-BREAK scenario took the forced path, and the methods rotate through the engine's lists", async () => {
    for (const key of ["BRACKET_SETTLE_LEVEL", "BRACKET_SETTLE_ABANDON", "BRACKET_TIEBREAK"] as const) {
      const { out } = await runScenario(key);
      const fixtures = out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "win");
      expect(fixtures.length, key).toBeGreaterThan(1);
      const prefix = key === "BRACKET_TIEBREAK" ? "tiebreak_" : "settled_";
      const methods = fixtures.map((f) => (f.outcome as { method?: string }).method ?? "");
      expect(methods.every((m) => m.startsWith(prefix)), `${key}: ${methods.join(",")}`).toBe(true);
      const list: readonly string[] = key === "BRACKET_TIEBREAK" ? TIEBREAK_RUNGS : SETTLE_METHODS;
      expect(methods.map((m) => m.slice(prefix.length)).every((m) => list.includes(m)), key).toBe(true);
      expect(new Set(methods).size, `${key}: the rotation reaches more than one`).toBeGreaterThan(1);
    }
  });

  it("BRACKET_NO_DRAW_GENERIC: the draw is refused by name on the first match, the match is then finished and the run is whole", async () => {
    const { out, checks } = await runScenario("BRACKET_NO_DRAW_GENERIC");
    const refused = checks.find((c) => c.id === "w2a-generic-draw-refused")!;
    expect(refused.checked, "five facts about the refusal").toBe(5);
    const fixtures = out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "win");
    expect(fixtures.length).toBeGreaterThan(1);
    expect(out.observed.stages[0]!.fixtures.every((f) => f.outcome?.kind !== "draw"), "no draw was ever written").toBe(true);
  });

  /** Counts the draws the product refused. */
  class CountsRefusals extends FakeKnockoutDriver {
    refusals: string[] = [];
    override postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
      return super.postStream(id, events, prefix).catch((e: unknown) => {
        if (e instanceof RefusedCall && e.code === LEVEL_RESULT_IN_BRACKET) this.refusals.push(id);
        throw e;
      });
    }
  }
  it("BRACKET_NO_DRAW_GENERIC: the draw is posted ONCE, at one match of the first round — not at every round's first match", async () => {
    const driver = new CountsRefusals();
    await runScenario("BRACKET_NO_DRAW_GENERIC", driver);
    const rounds = new Set(driver.fixtures.map((f) => f.round_no));
    expect(rounds.size, "a knockout of more than one round, or 'once' proves nothing").toBeGreaterThan(1);
    expect(driver.refusals).toHaveLength(1);
    expect(driver.fixtures.find((f) => f.id === driver.refusals[0])!.round_no, "the first round").toBe(Math.min(...[...rounds].filter((r): r is number => r !== null)));
  });

  /** A product that ACCEPTS the generic draw in a bracket (the guard GN-KO-1 names, removed): the refusal is swallowed
   *  into a plain answer, so the scenario sees an accepted draw. */
  class AcceptsDraws extends FakeKnockoutDriver {
    override postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
      return super.postStream(id, events, prefix).catch((e: unknown) => {
        if (e instanceof RefusedCall && e.code === LEVEL_RESULT_IN_BRACKET) return [];
        throw e;
      });
    }
  }
  it("a product that accepts the draw fails the scenario on the refusal, by name", async () => {
    const { checks, state } = await runScenario("BRACKET_NO_DRAW_GENERIC", new AcceptsDraws());
    const refused = checks.find((c) => c.id === "w2a-generic-draw-refused")!;
    expect(refused.verdict).toBe("fail");
    expect(refused.reason).toMatch(/ACCEPTED a generic draw in a bracket/);
    expect(state).not.toBe("works");
  });
});

describe("the scenarios' own checks, on hand-built drives (a wrong product is named, an empty run fails)", () => {
  const drive = (over: Partial<BracketDrive> = {}): BracketDrive => ({
    fixtureId: "f1", stageKind: "knockout", sport: "football", home: "a", away: "b", asked: { kind: "settle", then: "home", method: "lot", after: "level" },
    levelAs: "draw", status: "decided", outcome: { kind: "win", winner: "a", method: "settled_lot" }, loser: { line: "none" }, ...over,
  });
  const recOf = (...drives: BracketDrive[]) => { const r = new Recorder(); r.bracketDrives.push(...drives); return r; };

  it("everyMatchTookThePath: right path and method agree; the wrong decider, the wrong 'after', a missing or other method, an undecided match each red alone; an empty run fails (R25)", () => {
    const ok = recOf(drive());
    expect(everyMatchTookThePath(ok, "BRACKET_SETTLE_LEVEL")).toMatchObject({ verdict: "pass", checked: 1 });
    const wrong: readonly [string, BracketDrive, "BRACKET_SETTLE_LEVEL" | "BRACKET_SETTLE_ABANDON" | "BRACKET_TIEBREAK"][] = [
      ["a plain win", drive({ asked: { kind: "win", winner: "home" } }), "BRACKET_SETTLE_LEVEL"],
      ["settled after an abandon in the LEVEL scenario", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "abandon" } }), "BRACKET_SETTLE_LEVEL"],
      ["settled after a level result in the ABANDON scenario", drive(), "BRACKET_SETTLE_ABANDON"],
      ["the product shows another method", drive({ outcome: { kind: "win", winner: "a", method: "settled_organiser" } }), "BRACKET_SETTLE_LEVEL"],
      ["the product shows a play method", drive({ outcome: { kind: "win", winner: "a" } }), "BRACKET_SETTLE_LEVEL"],
      ["the product shows no outcome", drive({ outcome: null }), "BRACKET_SETTLE_LEVEL"],
      ["held, not decided", drive({ status: "needs_decision" }), "BRACKET_SETTLE_LEVEL"],
      ["a settle in the TIE-BREAK scenario", drive(), "BRACKET_TIEBREAK"],
    ];
    let reds = 0;
    for (const [label, d, key] of wrong) {
      expect(everyMatchTookThePath(recOf(d), key), label).toMatchObject({ verdict: "fail", checked: 1 });
      reds++;
    }
    expect(reds).toBe(wrong.length);
    const tb = drive({ asked: { kind: "tiebreak", rung: "rapid", winner: "home" }, outcome: { kind: "win", winner: "a", method: "tiebreak_rapid" } });
    expect(everyMatchTookThePath(recOf(tb), "BRACKET_TIEBREAK")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(everyMatchTookThePath(recOf({ ...tb, outcome: { kind: "win", winner: "a", method: "tiebreak_blitz" } }), "BRACKET_TIEBREAK")).toMatchObject({ verdict: "fail" });
    expect(everyMatchTookThePath(new Recorder(), "BRACKET_SETTLE_LEVEL")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(everyMatchTookThePath(recOf(drive(), wrong[0]![1]), "BRACKET_SETTLE_LEVEL")).toMatchObject({ verdict: "fail", checked: 2 }); // one wrong match among right ones is named
  });

  const carromCfg = { maxBoards: 4, bestOf: 3, tieBoard: "extra" };
  const boards = (n: number): StreamEvent[] => Array.from({ length: n }, () => ({ type: "carrom.board.summary", payload: {} }));
  it("everyGamePlayedTheExtraBoard: gamesToWin × (maxBoards + 1) boards, decided, under tieBoard 'extra' — one item short, one over, a held match, a draw-board cfg each red; an empty run fails", () => {
    const want = Math.ceil(3 / 2) * (4 + 1);
    const d = drive({ sport: "carrom", asked: { kind: "win", winner: "home" }, levelAs: null, outcome: { kind: "win", winner: "a" } });
    const rec = (n: number, over: Partial<BracketDrive> = {}) => { const r = recOf({ ...d, ...over }); r.streams.set("f1", boards(n)); return r; };
    expect(everyGamePlayedTheExtraBoard(rec(want), carromCfg)).toMatchObject({ verdict: "pass", checked: 2 }); // the run decided nothing by an organiser + the one match
    const organiser = rec(want);
    organiser.settlesPosted = 1;
    expect(everyGamePlayedTheExtraBoard(organiser, carromCfg)).toMatchObject({ verdict: "fail", reason: expect.stringMatching(/1 settle\(s\) and 0 tie-break\(s\) were posted/) });
    expect(everyGamePlayedTheExtraBoard(rec(want - 1), carromCfg)).toMatchObject({ verdict: "fail" });
    expect(everyGamePlayedTheExtraBoard(rec(want + 1), carromCfg)).toMatchObject({ verdict: "fail" });
    expect(everyGamePlayedTheExtraBoard(rec(want, { status: "needs_decision" }), carromCfg)).toMatchObject({ verdict: "fail" });
    expect(everyGamePlayedTheExtraBoard(rec(want), { ...carromCfg, tieBoard: "draw" })).toMatchObject({ verdict: "fail" });
    expect(everyGamePlayedTheExtraBoard(new Recorder(), carromCfg)).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("genericDrawRefused: a refusal with the spec's status and code that wrote nothing passes; each of the five facts reds alone; a probe that never ran fails", () => {
    const ok: RefusalProbe = { fixtureId: "f1", refusal: { status: 409, code: LEVEL_RESULT_IN_BRACKET }, before: { status: "in_play", seq: 1 }, after: { status: "in_play", seq: 1 } };
    expect(LEVEL_RESULT_IN_BRACKET).toBe("LEVEL_RESULT_IN_BRACKET");
    expect(genericDrawRefused(ok)).toMatchObject({ verdict: "pass", checked: 5 });
    const wrong: readonly [string, RefusalProbe, RegExp][] = [
      ["accepted", { ...ok, refusal: null }, /ACCEPTED/],
      ["another status", { ...ok, refusal: { status: 422, code: LEVEL_RESULT_IN_BRACKET } }, /status was 422/],
      ["another code", { ...ok, refusal: { status: 409, code: "DRAW_NOT_ALLOWED" } }, /code was DRAW_NOT_ALLOWED/],
      ["wrote an event", { ...ok, after: { status: "in_play", seq: 2 } }, /wrote 1 event/],
      ["moved the fixture", { ...ok, after: { status: "decided", seq: 1 } }, /moved the fixture from in_play to decided/],
    ];
    for (const [label, p, why] of wrong) {
      const c = genericDrawRefused(p);
      expect(c.verdict, label).toBe("fail");
      expect(c.evidence.join("|"), label).toMatch(why);
      expect(c.evidence.length, `${label}: only that fact reds`).toBe(label === "accepted" ? 3 : 1);
    }
    expect(genericDrawRefused(null)).toMatchObject({ verdict: "fail", reason: expect.stringMatching(/probe never ran/) });
  });
});

describe("a fixture the scenario started and the product refused (Recorder.resumed, nothing voided)", () => {
  it("is finished from where it stands: START is not posted twice; a stream whose lead is not the live events is still refused by name", async () => {
    const sport = "generic";
    const variant = variantFor(sport);
    const driver = new FakeKnockoutDriver();
    const spec: CaseSpec = { caseId: "knockout|generic|x|LIFECYCLE", row: "knockout", sport, variant, scenario: "LIFECYCLE", canary: false };
    const ctx = { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor("knockout", "LIFECYCLE"));
    await driver.start();
    const f = driver.fixtures.find((x) => x.home_entrant_id !== null && x.away_entrant_id !== null && x.round_no === 1)!;
    await driver.postStream(f.id, [{ type: "core.start", payload: {} }], "t:probe");
    rec.streams.set(f.id, [{ type: "core.start", payload: {} }]);
    rec.resumed.set(f.id, { outcome: { kind: "win", winner: "home" }, live: 1, voidedType: null });
    await decideFixture(ctx, rec, setup, f, { kind: "win", winner: "away" }); // the resumed outcome wins over the one passed
    expect(f.status).toBe("decided");
    expect(f.events.filter((e) => e.type === "core.start")).toHaveLength(1);
    expect(rec.parity.at(-1)).toMatchObject({ foreign: 0, request: "match" });
    // a lead that is not the live events: refused before any post
    const g = driver.fixtures.find((x) => x.home_entrant_id !== null && x.away_entrant_id !== null && x.id !== f.id && x.round_no === 1 && x.status === "scheduled")!;
    rec.streams.set(g.id, [{ type: "generic.result", payload: {} }]);
    rec.resumed.set(g.id, { outcome: { kind: "win", winner: "home" }, live: 1, voidedType: null });
    await expect(decideFixture(ctx, rec, setup, g, { kind: "win", winner: "home" })).rejects.toThrow(/cannot be resumed/);
  });
});
