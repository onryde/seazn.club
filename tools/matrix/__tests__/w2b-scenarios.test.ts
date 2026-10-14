// W2b Task 2 Step 4: the five opt-in forfeit-credit scenarios (WO-PRE, RT-PART, DW-ALL, AB-AWARD, WD-CASC), their
// derived cells, their pure checks, the bracket feed graph they reason on, and how they ask the walkover-credit family.
// Expected values come from Appendix A's rows (X-RS-1, X-WO-1, X-RT-1, X-DW-1..4, X-AB-1/2, X-WD-1..4, the per-sport
// *-WO-1 / *-AB-* rows), the engine's own declarations (BRACKET_STAGE_KINDS, the bracket generators' feed edges and
// isFinal/thirdPlace/conditional flags, the sports' standingsDelta metric keys) and hand-written cfgs — never from the
// scenarios' text or the oracle's own table.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRACKET_STAGE_KINDS } from "@seazn/engine/competition";
import type { StageKind } from "@seazn/engine/core";
import { CREDIT_SPORTS, walkoverCredit } from "@seazn/reference";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import { RefusedCall, type FixtureRow, type StandingsRowWire, type WithdrawOut } from "../lib/driver/types.ts";
import { fieldSizeFor } from "../lib/field-size.ts";
import { foldStream } from "../lib/fold.ts";
import { INVARIANTS, evaluateInvariant } from "../lib/invariants.ts";
import type { ObservedFixture, ObservedOutcome } from "../lib/observed.ts";
import { Recorder, caseStageCfg, setUpDivision } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { BRACKET_OF } from "../lib/scenarios/terminal-finals.ts";
import { W2B_SCENARIO_KEYS, type CaseSpec } from "../lib/scenarios/types.ts";
import {
  DW_NO_NEXT, FeedGraphUnresolved, NO_PLACEMENT, ScoresheetUnread, WITHDREW, creditExpectation, deadSeats, expectationOf, forfeitPoints, doubleWalkoverAdvancesNobody, doubleWalkoverRecorded, doubleWalkoverRefusedAtTheEnd, feedGraph, forfeitRecorded,
  hasNoNextMatch, isolatedTable, ladderUnmoved, partialPlayStands, pickDoubleWalkover, scoresheetOf, wireGraph, withRefusals, type FeedGraph, type ForfeitDrive, type LocalDelta, type RefusalProbe,
} from "../lib/scenarios/w2b-checks.ts";
import {
  CROWN_SETTLED, FINAL_TBD, FINAL_VACANT_TITLE, W2B_SCENARIOS, W2bCascadeLeftOpen, W2bMisplanned, abandonDelta, abandonPlan, cascadeLeftOpen, abandonWithResult, bothSeatsDead, finalVacant, goalLead, heldStream, knockoutCrown, knockoutLines, tableJudged, tbdSeatWalksOver,
  wdCascFinalHalf, withdrawalsWalkOver,
} from "../lib/scenarios/w2b-forfeit-credit.ts";
import { SCENARIO_KEYS, planSliceCases } from "../lib/slice.ts";
import { decidersOffRulesFor, resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { levelCoins } from "../lib/streams/carrom.ts";
import { GeneratorUnsupported, OutcomeUnreachable, type StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { AWARD_POLICY, DLS_ON, bracketRootRow, minOversRule, knockoutRootRow, rootKindRows, tableRootRow, thirdPlaceRows, w2bApplies, w2bCells } from "../lib/w2b-cells.ts";
import { FakeKnockoutDriver, FakeLeagueDriver, bracketWithdrawalActs, bracketWithdrawalPolicy } from "./fake-driver.ts";
import { FakeLadderDriver, FakeMultiStageDriver } from "./fake-formats-driver.ts";
import { bracketWithdrawalFrom, bracketWithdrawalPolicyFrom, bracketWithdrawalPolicyText, bracketWithdrawalText } from "./product-text.ts";

const variantFor = offlineBuilderDefault;
const rootKind = (row: RowKey): string => stagesForRow(row)[0]!.kind;

describe("the five keys: frozen names, registered, opt-in", () => {
  it("W2B_SCENARIOS are the plan's five keys; each is registered under its own key with no canary; neither the slice nor the w1-driving scripts hold one", () => {
    expect([...W2B_SCENARIOS]).toEqual(["WO-PRE", "RT-PART", "DW-ALL", "AB-AWARD", "WD-CASC"]);
    let checked = 0;
    for (const k of W2B_SCENARIO_KEYS) {
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(SCENARIOS[k].canaryCheck, k).toBeNull();
      expect((SCENARIO_KEYS as readonly string[]).includes(k), `${k} is a slice key`).toBe(false);
      expect((W1_DRIVING_SCENARIOS as readonly string[]).includes(k), `${k} is a w1-driving script`).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("no filter plans any of them (the slice and the committed w1-driving plan are unchanged); a named one plans exactly its own cells", () => {
    const keys: readonly string[] = W2B_SCENARIO_KEYS;
    const slice = planSliceCases(variantFor);
    expect(slice.length).toBeGreaterThan(0);
    expect(slice.filter((c) => keys.includes(c.scenario))).toEqual([]);
    const all = planW1Driving(variantFor, {});
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((c) => c.scenario))).toEqual(new Set(["LIFECYCLE", "M1", "R4", "F1"]));
    let planned = 0;
    for (const k of W2B_SCENARIO_KEYS) {
      const cases = planW1Driving(variantFor, { scenario: k });
      const cells = w2bCells(k);
      expect(cases.length, k).toBeGreaterThan(0);
      // Each case is one of the key's cells (the cells less LIFECYCLE's committed drops), under its own id, with exactly
      // that cell's override (or none).
      expect(cases.length, k).toBeLessThanOrEqual(cells.length);
      for (const c of cases) {
        expect(cells.some((x) => x.row === c.row && x.sport === c.sport), `${k}: ${c.caseId} is not one of its cells`).toBe(true);
        expect(c.caseId, k).toBe(`${c.row}|${c.sport}|${c.variant}|${k}`);
        expect(c.canary, k).toBe(false);
        expect(c.overrides, `${k} ${c.caseId}`).toEqual(cells.find((x) => x.row === c.row && x.sport === c.sport)!.overrides);
      }
      expect(new Set(cases.map((c) => c.caseId)).size, `${k}: case ids unique`).toBe(cases.length);
      planned += cases.length;
    }
    expect(planned).toBeGreaterThan(0);
  });

  it("an --only cell outside the key's cells plans nothing and says so (never zero cases read as green)", () => {
    const outside = ROW_KEYS.find((r) => !rootKindRows().includes(r) && !thirdPlaceRows().includes(r))!;
    expect(outside).toBeDefined();
    expect(() => planW1Driving(variantFor, { scenario: "WO-PRE", only: `${outside}|generic` })).toThrow(/plans no case/);
  });
});

describe("the cells, derived and counted", () => {
  it("rootKindRows holds one row per distinct root stage kind, and every catalogue row's root kind is among them — the engine's four feeding bracket kinds included", () => {
    const rows = rootKindRows();
    const kinds = rows.map(rootKind);
    expect(new Set(kinds).size, "one row per kind").toBe(rows.length);
    let covered = 0;
    for (const r of ROW_KEYS) { expect(kinds, r).toContain(rootKind(r)); covered++; }
    expect(covered).toBe(ROW_KEYS.length);
    // X-DW-3 is judged on each feeding bracket kind the engine declares; a ladder and a table are the exempt cases.
    for (const k of BRACKET_STAGE_KINDS) expect(kinds, `${k} has a root row`).toContain(k);
    expect(BRACKET_STAGE_KINDS.size).toBe(4);
    expect(kinds).toContain("ladder");
    expect(kinds.some((k) => !BRACKET_STAGE_KINDS.has(k) && k !== "ladder")).toBe(true);
  });

  it("thirdPlaceRows are the knockout roots that play a third-place match (X-DW-3 names it beside the final)", () => {
    const rows = thirdPlaceRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(rootKind(r)).toBe("knockout");
      expect((stagesForRow(r)[0] as { config?: Record<string, unknown> }).config?.thirdPlace).toBe(true);
    }
  });

  it("WO-PRE is every sport on every root kind; DW-ALL that plus the third-place rows; RT-PART a table and a bracket for every sport (X-RT-1 is every sport's); WD-CASC every sport on the knockout", () => {
    const n = SPORT_KEYS.length;
    expect(n).toBe(11);
    expect(w2bCells("WO-PRE").length).toBe(rootKindRows().length * n);
    expect(w2bCells("DW-ALL").length).toBe((rootKindRows().length + thirdPlaceRows().length) * n);
    expect(w2bCells("RT-PART").length).toBe(2 * n);
    expect(new Set(w2bCells("RT-PART").map((c) => rootKind(c.row)))).toEqual(new Set(["league", "knockout"]));
    expect(w2bCells("WD-CASC").map((c) => c.row)).toEqual(Array(n).fill(knockoutRootRow()));
    expect(rootKind(knockoutRootRow())).toBe("knockout");
    expect(rootKind(tableRootRow())).toBe("league");
    expect(rootKind(bracketRootRow())).toBe("knockout");
  });

  it("AB-AWARD is the four sports whose own rule gives an abandon a result, in a table — FB/HK/IH-AB-1 under the award policy, CK-AB-1/2 with DLS on", () => {
    const cells = w2bCells("AB-AWARD");
    expect(cells.map((c) => c.sport).sort()).toEqual(["cricket", "football", "hockey", "icehockey"]);
    for (const c of cells) {
      expect(c.row).toBe(tableRootRow());
      expect(c.overrides, c.sport).toEqual(c.sport === "cricket" ? DLS_ON : AWARD_POLICY);
    }
    expect(AWARD_POLICY).toEqual({ abandonPolicy: "award" });
    // CK-AB-1 is a DLS result: the t20 builder default has DLS off (cricket.ts applyAbandon then answers no_result
    // past the minimum too), so the case switches it on; the minimum (5 overs, ICC T20 PC 16.10) is reached by the
    // generator's partial chase.
    expect(DLS_ON).toEqual({ dls: { enabled: true, edition: "standard" } });
    expect((resolveSportCfg("cricket", variantFor("cricket")) as { dls?: { enabled?: boolean } }).dls?.enabled).toBe(false);
    expect(minOversRule("cricket")).toEqual({ minBalls: 30, partialBalls: 30 });
    // The plan each sport is driven by: leading then level (D8), past the minimum overs then short of it (CK-AB-1/2).
    expect(abandonPlan("football")!.map((p) => p.kind)).toEqual(["leading", "level"]);
    expect(abandonPlan("cricket")!.map((p) => p.kind)).toEqual(["past_min_overs", "before_min_overs"]);
    expect(abandonPlan("tennis")).toBeNull();
  });

  it("a drop removes exactly the cell it names, for every key", () => {
    let checked = 0;
    for (const k of W2B_SCENARIO_KEYS) {
      const cells = w2bCells(k);
      const first = cells[0]!;
      expect(w2bCells(k, (row, sport) => row === first.row && sport === first.sport).length, k).toBe(cells.length - 1);
      expect(w2bApplies(k, first.row, first.sport), k).toBe(true);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("a scenario planned on a cell it is not for is refused by name before any driver call", () => {
  const notRoot = ROW_KEYS.find((r) => !rootKindRows().includes(r) && !thirdPlaceRows().includes(r))!;
  const cases: { key: (typeof W2B_SCENARIO_KEYS)[number]; row: RowKey; sport: string; overrides?: Record<string, unknown>; why: RegExp }[] = [
    { key: "WO-PRE", row: notRoot, sport: "generic", why: /not one of the scenario's cells/ },
    { key: "RT-PART", row: notRoot, sport: "generic", why: /not one of the scenario's cells/ },
    { key: "DW-ALL", row: notRoot, sport: "generic", why: /not one of the scenario's cells/ },
    { key: "AB-AWARD", row: "league", sport: "tennis", why: /not one of the scenario's cells/ },
    { key: "AB-AWARD", row: "league", sport: "football", why: /carries no .*abandonPolicy.* override/ },
    { key: "AB-AWARD", row: "league", sport: "cricket", why: /carries no .*dls.* override/ },
    { key: "WD-CASC", row: "league", sport: "generic", why: /not one of the scenario's cells/ },
  ];
  it("each misplanned case throws W2bMisplanned naming the key, and the driver was asked nothing", async () => {
    expect(notRoot).toBeDefined();
    let refused = 0;
    for (const c of cases) {
      const variant = variantFor(c.sport);
      const spec: CaseSpec = { caseId: `${c.row}|${c.sport}|${variant}|${c.key}`, row: c.row, sport: c.sport, variant, scenario: c.key, canary: false, ...(c.overrides ? { overrides: c.overrides } : {}) };
      const calls: string[] = [];
      const driver = new Proxy(new FakeLeagueDriver(), { get: (t, k, r) => { calls.push(String(k)); return Reflect.get(t, k, r) as unknown; } });
      const err = await SCENARIOS[c.key].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(c.sport, variant), tag: "t", denied: [] }).then(() => null, (e: unknown) => e as Error);
      expect(err, `${c.key} on ${c.row}|${c.sport}`).toBeInstanceOf(W2bMisplanned);
      expect(err!.message).toMatch(c.why);
      expect(err!.message).toContain(c.key);
      expect(calls, `${c.key}: nothing was asked of the driver`).toEqual([]);
      refused++;
    }
    expect(refused).toBe(cases.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The pure checks, on synthetic data: one good item passes, and each wrong field fails alone.

const fx = (id: string, home: string | null, away: string | null, status: string, outcome: ObservedOutcome | null, extra: Partial<ObservedFixture> = {}): ObservedFixture =>
  ({ id, stageId: "s", poolId: null, roundNo: 1, home, away, status, outcome, declared: null, ...extra });
const walk = (fixtureId: string, by: "home" | "away", reason: "walkover" | "retired" | "disqualified" = "walkover", refusal: ForfeitDrive["refusal"] = null): ForfeitDrive =>
  ({ fixtureId, home: "a", away: "b", asked: { kind: "forfeit", by, reason, at: reason === "walkover" ? "before_start" : "after_start" }, refusal });

describe("forfeitRecorded (X-RS-1, X-WO-1, X-RT-1): an award to the OTHER side, the forfeiting side its loser, the asked reason, forfeited", () => {
  const good = fx("f1", "a", "b", "forfeited", { kind: "award", winner: "a", loser: "b", reason: "walkover" });
  it("the rule's record passes on one counted item; nothing to judge fails", () => {
    expect(forfeitRecorded("x", [walk("f1", "away")], [good])).toMatchObject({ verdict: "pass", checked: 1 });
    expect(forfeitRecorded("x", [], [good])).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("each wrong field reds alone: status, kind, winner, loser, reason, a missing fixture, a refusal, a non-forfeit request", () => {
    const bad: [string, ObservedFixture[], ForfeitDrive][] = [
      ["status", [{ ...good, status: "decided" }], walk("f1", "away")],
      ["kind", [{ ...good, outcome: { kind: "win", winner: "a" } }], walk("f1", "away")],
      ["winner", [{ ...good, outcome: { kind: "award", winner: "b", loser: "b", reason: "walkover" } }], walk("f1", "away")],
      ["loser", [{ ...good, outcome: { kind: "award", winner: "a", loser: null, reason: "walkover" } }], walk("f1", "away")],
      ["reason", [{ ...good, outcome: { kind: "award", winner: "a", loser: "b", reason: "retired" } }], walk("f1", "away")],
      ["side", [good], walk("f1", "home")],
      ["missing", [], walk("f1", "away")],
      ["refused", [good], walk("f1", "away", "walkover", { status: 422, code: "FORFEIT_REASON_WRONG_PHASE" })],
      ["not a forfeit", [good], { ...walk("f1", "away"), asked: { kind: "double_walkover" } }],
    ];
    for (const [what, fixtures, d] of bad) expect(forfeitRecorded("x", [d], fixtures), what).toMatchObject({ verdict: "fail", checked: 1 });
    expect(bad.length).toBe(9);
  });
});

describe("partialPlayStands (X-RT-1): the ledger keeps every event posted before the retirement", () => {
  it("tip equal to the posted count passes; a dropped event, too short a stream, a refusal or an unread tip fails", () => {
    expect(partialPlayStands([{ ...walk("f1", "home", "retired"), seq: 4, posted: 4 }])).toMatchObject({ verdict: "pass", checked: 1 });
    // A sport with no play events before its result (chess) still posts START and the forfeit.
    expect(partialPlayStands([{ ...walk("f1", "home", "retired"), seq: 2, posted: 2 }])).toMatchObject({ verdict: "pass", checked: 1 });
    expect(partialPlayStands([{ ...walk("f1", "home", "retired"), seq: 3, posted: 4 }]).verdict).toBe("fail");
    expect(partialPlayStands([{ ...walk("f1", "home", "retired"), seq: 1, posted: 1 }]).verdict).toBe("fail");
    expect(partialPlayStands([{ ...walk("f1", "home", "retired", { status: 422, code: null }), seq: 4, posted: 4 }]).verdict).toBe("fail");
    expect(partialPlayStands([walk("f1", "home", "retired")]).verdict).toBe("fail");
    expect(partialPlayStands([])).toMatchObject({ verdict: "fail", checked: 0 });
  });
});

describe("the double walkover's checks (X-DW-1..4)", () => {
  const dw: ForfeitDrive = { fixtureId: "q1", home: "a", away: "b", asked: { kind: "double_walkover" }, refusal: null };
  it("recorded: forfeited with the double_walkover outcome; anything else, a refusal, or none posted fails", () => {
    expect(doubleWalkoverRecorded([dw], [fx("q1", "a", "b", "forfeited", { kind: "double_walkover" })])).toMatchObject({ verdict: "pass", checked: 1 });
    expect(doubleWalkoverRecorded([dw], [fx("q1", "a", "b", "abandoned", { kind: "double_walkover" })]).verdict).toBe("fail");
    expect(doubleWalkoverRecorded([dw], [fx("q1", "a", "b", "forfeited", { kind: "draw" })]).verdict).toBe("fail");
    expect(doubleWalkoverRecorded([{ ...dw, refusal: { status: 422, code: "INVALID_EVENT" } }], [fx("q1", "a", "b", "scheduled", null)]).verdict).toBe("fail");
    expect(doubleWalkoverRecorded([], [])).toMatchObject({ verdict: "fail", checked: 1 });
  });

  it("refused at the end: 409 DOUBLE_WALKOVER_NO_NEXT_MATCH with the fixture unmoved; an accepted one, another code, a moved fixture, or no probe fails; an exempt kind abstains", () => {
    expect(DW_NO_NEXT).toEqual({ status: 409, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" });
    const ok: RefusalProbe = { fixtureId: "fin", refusal: { status: 409, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" }, before: { status: "scheduled", seq: 0 }, after: { status: "scheduled", seq: 0 } };
    expect(doubleWalkoverRefusedAtTheEnd([ok], null)).toMatchObject({ verdict: "pass", checked: 3 });
    expect(doubleWalkoverRefusedAtTheEnd([{ ...ok, refusal: null, after: { status: "forfeited", seq: 1 } }], null)).toMatchObject({ verdict: "fail" });
    expect(doubleWalkoverRefusedAtTheEnd([{ ...ok, refusal: { status: 422, code: "INVALID_EVENT" } }], null).verdict).toBe("fail");
    expect(doubleWalkoverRefusedAtTheEnd([{ ...ok, refusal: { status: 409, code: "ALREADY_DECIDED" } }], null).verdict).toBe("fail");
    expect(doubleWalkoverRefusedAtTheEnd([{ ...ok, after: { status: "scheduled", seq: 1 } }], null).verdict).toBe("fail");
    expect(doubleWalkoverRefusedAtTheEnd([], null)).toMatchObject({ verdict: "fail", checked: 1 });
    expect(doubleWalkoverRefusedAtTheEnd([ok], "a league")).toMatchObject({ verdict: "abstain", checked: 0, reason: "a league" });
  });

  it("advances nobody: neither entrant seated again, a one-dead-seat fixture walked over to its live side, a two-dead-seat one a void (loop F: no seat of a recorded double walkover's chain departed)", () => {
    const fixtures = [
      fx("q1", "a", "b", "forfeited", { kind: "double_walkover" }),
      fx("s1", null, "c", "forfeited", { kind: "award", winner: "c", loser: null, reason: "bye" }, { extKey: "S1" }),
      fx("z", null, null, "abandoned", null, { extKey: "Z" }),
    ];
    const dead = new Map([["S1", 1], ["Z", 2]]);
    expect(doubleWalkoverAdvancesNobody(dw, fixtures, dead)).toMatchObject({ verdict: "pass", checked: 3 });
    expect(doubleWalkoverAdvancesNobody(dw, [...fixtures, fx("lb", "a", null, "scheduled", null)], dead).verdict, "a seated again").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(dw, [fixtures[0]!, { ...fixtures[1]!, status: "scheduled", outcome: null }, fixtures[2]!], dead).verdict, "S1 left open").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(dw, [fixtures[0]!, fixtures[1]!, { ...fixtures[2]!, status: "forfeited", outcome: { kind: "award", winner: "x", loser: null, reason: "walkover" } }], dead).verdict, "Z walked over").toBe("fail");
    // The I-6 shape loop F refutes: two dead seats, neither departed, written as a double walkover.
    const asDw = doubleWalkoverAdvancesNobody(dw, [fixtures[0]!, fixtures[1]!, { ...fixtures[2]!, status: "forfeited", outcome: { kind: "double_walkover" } }], dead);
    expect(asDw.verdict, "Z a double walkover").toBe("fail");
    expect(asDw.reason).toMatch(/Z: both seats dead — forfeited \{"kind":"double_walkover"\}, wanted abandoned with no outcome/);
    expect(doubleWalkoverAdvancesNobody(dw, [fixtures[0]!, fixtures[1]!, { ...fixtures[2]!, status: "scheduled" }], dead).verdict, "Z left open").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(dw, fixtures, new Map([...dead, ["MISSING", 1]])).verdict, "a fed seat not in the stage").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(null, fixtures, dead)).toMatchObject({ verdict: "fail", checked: 1 });
    expect(doubleWalkoverAdvancesNobody({ ...dw, refusal: { status: 422, code: null } }, fixtures, dead).verdict).toBe("fail");
  });

  it("a ladder's order is unmoved by a double walkover", () => {
    expect(ladderUnmoved(dw, ["a", "b", "c"], ["a", "b", "c"])).toMatchObject({ verdict: "pass", checked: 1 });
    expect(ladderUnmoved(dw, ["a", "b", "c"], ["b", "a", "c"]).verdict).toBe("fail");
    expect(ladderUnmoved(dw, null, ["a"]).verdict).toBe("fail");
    // The truth-run's find: a refused double walkover leaves the order unmoved by construction, so it fails by name.
    const refused = ladderUnmoved({ ...dw, refusal: { status: 422, code: "INVALID_EVENT" } }, ["a", "b", "c"], ["a", "b", "c"]);
    expect(refused).toMatchObject({ verdict: "fail", checked: 1 });
    expect(refused.reason).toMatch(/q1: the product refused it 422 INVALID_EVENT/);
    expect(ladderUnmoved(null, ["a"], ["a"]).reason).toMatch(/no double walkover was posted/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The feed graph and the dead chain, on the engine's own brackets: the expectation is each bracket's shape as the
// rulebook describes it, read off the generator's own flags and feed edges.

const F8 = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"];
function bracket(kind: string, field: readonly string[], config: Record<string, unknown> = {}) {
  const gen = BRACKET_OF[kind]!(field, config);
  const rows: FixtureRow[] = gen.fixtures.map((g, i) => ({ id: `f-${g.id}`, stage_id: "s", pool_id: null, round_no: g.round + 1, fixture_no: i + 1, home_entrant_id: g.home ?? null, away_entrant_id: g.away ?? null, status: "scheduled", outcome: null, ext_key: g.id }));
  return { gen, rows, graph: feedGraph(kind, config, field, rows) };
}
const SHAPES: readonly { name: string; kind: string; field: readonly string[]; config?: Record<string, unknown> }[] = [
  { name: "knockout of 8", kind: "knockout", field: F8 },
  { name: "knockout of 8, third place", kind: "knockout", field: F8, config: { thirdPlace: true } },
  { name: "page playoff", kind: "page_playoff", field: F8.slice(0, 4) },
  { name: "stepladder of 5", kind: "stepladder", field: F8.slice(0, 5) },
  { name: "double elimination of 4", kind: "double_elim", field: F8.slice(0, 4) },
  { name: "double elimination of 4, bracket reset", kind: "double_elim", field: F8.slice(0, 4), config: { bracketReset: true } },
  { name: "double elimination of 8", kind: "double_elim", field: F8 },
  { name: "double elimination of 2", kind: "double_elim", field: F8.slice(0, 2) },
  { name: "double elimination of 2, bracket reset", kind: "double_elim", field: F8.slice(0, 2), config: { bracketReset: true } },
];

describe("feedGraph: the engine's wiring, trusted only on the stage the product stored", () => {
  it("the fixtures with no next match are every final (a grand final with a reset too), the third-place match, and a match whose two sides meet again in one fixture (X-DW-3, D19, loop F I-5) — per shape", () => {
    // D19 plus loop F's review I-5 (apps/web bracket-next-match.ts): a final feeds nothing, and a match whose winner AND
    // loser both go to one fixture feeds only its own rematch — a grand final with a bracket reset, or a two-entrant
    // double elimination's one winners' match — so it is a final too. Read off the engine's own declarations: its
    // isFinal and thirdPlace flags (both grand finals of a reset are isFinal), and the fixture fed from both sides of one.
    let checked = 0;
    for (const s of SHAPES) {
      const { gen, graph } = bracket(s.kind, s.field, s.config);
      const rematch = (id: string) => gen.fixtures.some((g) => g.homeFrom?.fixtureId === id && g.awayFrom?.fixtureId === id);
      const want = gen.fixtures.filter((g) => g.isFinal === true || g.thirdPlace === true || rematch(g.id)).map((g) => g.id);
      expect(want.length, `${s.name}: an end exists`).toBeGreaterThan(0);
      expect(graph.keys.filter((k) => hasNoNextMatch(graph, k)), s.name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  });

  it("loop F I-5: a double-elimination grand final WITH a bracket reset has no next match (its winner and loser both feed the reset); without one, it has no edge at all; the winners' final feeding two fixtures is a next match", () => {
    // single-sport: the feed graph reads the engine's wiring, never the sport.
    const reset = bracket("double_elim", F8.slice(0, 4), { bracketReset: true });
    const gf = reset.gen.fixtures.find((g) => g.isFinal === true && g.conditional !== true)!;
    const replay = reset.gen.fixtures.find((g) => g.conditional === true)!;
    expect([reset.graph.winnerTo.get(gf.id)?.target, reset.graph.loserTo.get(gf.id)?.target], "premise: both of gf's lines go to the reset").toEqual([replay.id, replay.id]);
    expect([hasNoNextMatch(reset.graph, gf.id), hasNoNextMatch(reset.graph, replay.id)]).toEqual([true, true]);
    const plain = bracket("double_elim", F8.slice(0, 4));
    const gf2 = plain.gen.fixtures.find((g) => g.isFinal === true)!;
    expect([plain.graph.winnerTo.has(gf2.id), plain.graph.loserTo.has(gf2.id), hasNoNextMatch(plain.graph, gf2.id)], "no reset: no edge, no next match").toEqual([false, false, true]);
    const wbFinal = reset.gen.fixtures.find((g) => g.id === gf.homeFrom?.fixtureId)!;
    expect(reset.graph.winnerTo.get(wbFinal.id)?.target, "premise: the winners' final feeds the grand final").toBe(gf.id);
    expect(reset.graph.loserTo.get(wbFinal.id)?.target, "…and its loser the losers' bracket").not.toBe(gf.id);
    expect(hasNoNextMatch(reset.graph, wbFinal.id), "two different fixtures: a next match").toBe(false);
  });

  it("refuses a stage whose stored keys are not the engine's, and a size the engine cannot lay out, by name", () => {
    const { rows } = bracket("knockout", F8);
    expect(() => feedGraph("knockout", {}, F8, rows.slice(1))).toThrow(FeedGraphUnresolved);
    expect(() => feedGraph("knockout", {}, F8, rows.map((r, i) => (i === 0 ? { ...r, ext_key: "other" } : r)))).toThrow(FeedGraphUnresolved);
    expect(() => feedGraph("page_playoff", {}, F8, rows)).toThrow(/lays out no page_playoff/);
    expect(() => feedGraph("league", {}, F8, rows)).toThrow(/no bracket generator/);
  });
});

describe("loop F I-5 on the knockout fake: its double-walkover refusal is the product's feedsNextMatch over BOTH of a fixture's lines", () => {
  // single-sport: the refusal reads the fake's feed edges, never the sport.
  async function doubleElim(n: number) {
    const variant = variantFor("generic");
    const d = new FakeKnockoutDriver({ doubleElim: true });
    const spec: CaseSpec = { caseId: `double_elim|generic|${variant}|DW-ALL`, row: "double_elim", sport: "generic", variant, scenario: "DW-ALL", canary: false };
    await setUpDivision({ driver: d, spec, orgSlug: "o", cfg: resolveSportCfg("generic", variant), tag: "t", denied: [] }, new Recorder(), n);
    return { d, byKey: (k: string) => d.fixtures.find((f) => f.ext_key === k)! };
  }
  const DW: StreamEvent[] = [{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }];

  it("a two-entrant double elim's winners' match — its winner AND its loser into the grand final — is refused 409 DOUBLE_WALKOVER_NO_NEXT_MATCH, unwritten; a four-entrant opener (two different fixtures) is accepted", async () => {
    const two = await doubleElim(2);
    const wb = two.byKey("wb-r0-i0");
    const gf = two.byKey("gf");
    expect([two.d.feeds.get(wb.id)?.to, two.d.loserFeeds.get(wb.id)?.to], "premise: both of its lines go to the grand final").toEqual([gf.id, gf.id]);
    const refused = await two.d.postStream(wb.id, DW).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(RefusedCall);
    expect(refused).toMatchObject(DW_NO_NEXT);
    expect(wb.events, "the refused fixture is unwritten").toEqual([]);
    const four = await doubleElim(4);
    const opener = four.byKey("wb-r0-i0");
    const lines = [four.d.feeds.get(opener.id)?.to, four.d.loserFeeds.get(opener.id)?.to];
    expect(lines.every((t) => t !== undefined) && lines[0] !== lines[1], "premise: the opener's two lines go to two fixtures").toBe(true);
    await four.d.postStream(opener.id, DW);
    expect((opener.outcome as { kind?: unknown } | null)?.kind, "accepted").toBe("double_walkover");
  });

  it("the fake lays out no bracket reset (generateDoubleElim, no bracketReset): a reset's grand final is unreachable on it, so I-5's reset is witnessed on the feed graph and the oracle's next line instead", async () => {
    const { d } = await doubleElim(4);
    const field = F8.slice(0, 4);
    const keys = d.fixtures.map((f) => f.ext_key);
    expect(keys).toEqual(BRACKET_OF.double_elim!(field, {}).fixtures.map((g) => g.id));
    const replay = BRACKET_OF.double_elim!(field, { bracketReset: true }).fixtures.find((g) => g.conditional === true);
    expect(replay, "premise: the engine's reset has a conditional replay").toBeDefined();
    expect(keys).not.toContain(replay!.id);
  });
});

describe("deadSeats (X-DW-2): a double walkover kills both seats it feeds; one dead seat is a walkover, two a double walkover", () => {
  it("a knockout quarter-final's double walkover kills one seat of its semi-final, and nothing beyond (the walkover's winner plays on)", () => {
    const { gen, graph } = bracket("knockout", F8);
    const qf1 = gen.fixtures.find((g) => g.home === "e1")!;
    const sf = gen.fixtures.find((g) => g.homeFrom?.fixtureId === qf1.id || g.awayFrom?.fixtureId === qf1.id)!;
    expect([...deadSeats(graph, qf1.id)]).toEqual([[sf.id, 1]]);
  });

  it("with a third-place match, the semi-final's walkover has no loser, so the third-place seat it feeds is dead too", () => {
    const { gen, graph } = bracket("knockout", F8, { thirdPlace: true });
    const qf1 = gen.fixtures.find((g) => g.home === "e1")!;
    const sf = gen.fixtures.find((g) => g.homeFrom?.fixtureId === qf1.id || g.awayFrom?.fixtureId === qf1.id)!;
    const third = gen.fixtures.find((g) => g.thirdPlace === true)!;
    expect(new Map(deadSeats(graph, qf1.id))).toEqual(new Map([[sf.id, 1], [third.id, 1]]));
  });

  it("a fixture both of whose seats die is a double walkover whose winner line dies too; one with a single dead seat passes its winner on", () => {
    // A → X (winner), A → Y (loser); X's loser and Y's winner both feed Z; Z's winner feeds W.
    const g: FeedGraph = {
      keys: ["A", "X", "Y", "Z", "W"], order: ["A", "X", "Y", "Z", "W"],
      winnerTo: new Map([["A", { target: "X", slot: "home" }], ["Y", { target: "Z", slot: "away" }], ["Z", { target: "W", slot: "home" }]]),
      loserTo: new Map([["A", { target: "Y", slot: "home" }], ["X", { target: "Z", slot: "home" }]]),
    };
    // Y has one dead seat, so its winner (the live side) plays on into Z — only X's loser line is dead there. So Z has 1.
    expect(new Map(deadSeats(g, "A"))).toEqual(new Map([["X", 1], ["Y", 1], ["Z", 1]]));
    // Now Y's winner line comes from a two-dead fixture: kill both of Y's seats by feeding it from A twice.
    const g2: FeedGraph = { ...g, winnerTo: new Map([["A", { target: "Y", slot: "home" }], ["Y", { target: "Z", slot: "away" }], ["Z", { target: "W", slot: "home" }]]), loserTo: new Map([["A", { target: "Y", slot: "away" }]]) };
    expect(new Map(deadSeats(g2, "A"))).toEqual(new Map([["Y", 2], ["Z", 1]]));
  });

  it("pickDoubleWalkover leaves every fixture with no next match askable, or answers none — per shape", () => {
    const want: Readonly<Record<string, (gen: ReturnType<typeof bracket>["gen"]) => string | undefined>> = {
      "knockout of 8": (gen) => gen.fixtures.find((g) => g.home === "e1")!.id, // QF1: the final stays live
      "knockout of 8, third place": () => undefined, // every quarter-final walks a semi-final over, so the third place
      "page playoff": (gen) => gen.fixtures.find((g) => g.home === "e3")!.id, // q1's would kill a final seat; the eliminator's does not
      "stepladder of 5": (gen) => gen.fixtures.find((g) => g.home === "e4")!.id,
      "double elimination of 4": (gen) => gen.fixtures.find((g) => g.home === "e1")!.id,
      "double elimination of 4, bracket reset": (gen) => gen.fixtures.find((g) => g.home === "e1")!.id,
      "double elimination of 8": (gen) => gen.fixtures.find((g) => g.home === "e1")!.id,
      "double elimination of 2": () => undefined, // its one seated match is a final (I-5): nothing has a next match
      "double elimination of 2, bracket reset": () => undefined,
    };
    let checked = 0;
    for (const s of SHAPES) {
      const { gen, rows, graph } = bracket(s.kind, s.field, s.config);
      const r1 = rows.filter((r) => r.home_entrant_id !== null && r.away_entrant_id !== null);
      expect(pickDoubleWalkover(graph, r1)?.ext_key, s.name).toBe(want[s.name]!(gen));
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
    expect(NO_PLACEMENT).toMatch(/X-DW-3/);
  });

  it("wireGraph refuses a generation order where a fixture comes before its feeder (deadSeats' one-pass rule, guarded), and two lines of one side out of a fixture", () => {
    expect(() => wireGraph([{ id: "F", homeFrom: { fixtureId: "A", side: "winner" } }, { id: "A" }])).toThrow(/generates F before the fixture whose winner feeds it \(A\)/);
    expect(() => wireGraph([{ id: "A" }, { id: "F", homeFrom: { fixtureId: "A", side: "winner" }, awayFrom: { fixtureId: "A", side: "winner" } }])).toThrow(/two winner lines out of A/);
    expect(wireGraph([{ id: "A" }, { id: "F", homeFrom: { fixtureId: "A", side: "winner" }, awayFrom: { fixtureId: "A", side: "loser" } }]).keys).toEqual(["A", "F"]);
    // A loser line alone is a next match (D19 reads winner_to AND loser_to): a fixture feeding only a losers' bracket or a
    // third-place match is never one a double walkover is refused at.
    const loserOnly = wireGraph([{ id: "A" }, { id: "L", awayFrom: { fixtureId: "A", side: "loser" } }]);
    expect(hasNoNextMatch(loserOnly, "A")).toBe(false);
    expect(hasNoNextMatch(loserOnly, "L")).toBe(true);
    // The order is the generator's, never the stored rows': a reversed row list reads the same graph.
    const { rows, graph } = bracket("knockout", F8);
    expect(feedGraph("knockout", {}, F8, [...rows].reverse()).keys).toEqual(graph.keys);
  });
});

describe("knockoutLines: WD-CASC's two semi-final lines and the final, from the feed graph", () => {
  it("QF1's line is QF1 and the quarter-final feeding the same semi-final; the other two are the other line; both feed one final", () => {
    const { gen, rows, graph } = bracket("knockout", F8);
    const r1 = rows.filter((r) => r.round_no === 1);
    const lines = knockoutLines(graph, r1);
    const final = gen.fixtures.find((g) => g.isFinal === true)!;
    expect(lines.final).toBe(final.id);
    const sfOf = (id: string) => gen.fixtures.find((g) => g.homeFrom?.fixtureId === id || g.awayFrom?.fixtureId === id)!.id;
    expect(lines.a.qf.map((f) => sfOf(f.ext_key!))).toEqual([lines.a.sf, lines.a.sf]);
    expect(lines.b.qf.map((f) => sfOf(f.ext_key!))).toEqual([lines.b.sf, lines.b.sf]);
    expect(lines.a.sf).not.toBe(lines.b.sf);
    expect(lines.a.qf[0]!.home_entrant_id).toBe("e1");
    expect(() => knockoutLines(bracket("knockout", F8.slice(0, 4)).graph, bracket("knockout", F8.slice(0, 4)).rows.filter((r) => r.round_no === 1))).toThrow(W2bMisplanned);
  });
});

describe("heldStream: what QF2 is when its side withdraws (X-WD-1, BG-WO-3, D3 R5), per sport", () => {
  it("a level result where the sport has one in a bracket, chess's tie-break pending, otherwise play under way — every sport labelled", () => {
    let checked = 0;
    const labels = new Map<string, string>();
    for (const sport of SPORT_KEYS) {
      // WD-CASC is a hold-path scenario (R-T12-3): its knockout is posted with every decider off.
      const cfg = stageCfg(sport, resolveSportCfg(sport, variantFor(sport)), "knockout", variantFor(sport), decidersOffRulesFor(sport, variantFor(sport), "knockout"));
      const h = heldStream(sport, cfg, "h", "a");
      labels.set(sport, h.label);
      expect(h.events[0]?.type, sport).toBe("core.start");
      // Held or pending: the stream folds to no final result (the withdrawal is what decides it).
      const folded = foldStream(sportModule(sport), cfg, "h", "a", h.events);
      if (h.label === "in play") expect(folded.outcome, sport).toBeNull();
      checked++;
    }
    expect(checked).toBe(11);
    expect(labels.get("boardgame")).toBe("tie-break pending"); // BG-WO-3
    expect(labels.get("generic")).toBe("in play"); // GN-KO-1: no level result in a bracket
    expect(labels.get("football")).toBe("held"); // FB: a level match in a knockout is held for its decider
  });
});

describe("abandonWithResult and goalLead (X-AB-2, FB/HK/IH-AB-1, CK-AB-1/2)", () => {
  const goals = (...by: string[]): StreamEvent[] => [{ type: "core.start", payload: {} }, ...by.map((b) => ({ type: "football.goal", payload: { by: b } })), { type: "core.abandon", payload: {} }];
  it("goalLead reads the goals the harness posted", () => {
    expect(goalLead(goals("a"), "a", "b")).toBe("home");
    expect(goalLead(goals("b", "b", "a"), "a", "b")).toBe("away");
    expect(goalLead(goals("a", "b"), "a", "b")).toBe("level");
    expect(goalLead(goals(), "a", "b")).toBe("level");
  });
  it("each kind's rule passes, and each wrong result fails alone", () => {
    const d = (kind: "leading" | "level" | "past_min_overs" | "before_min_overs", events: StreamEvent[] = [], rule: ObservedOutcome | null = null, drawStands = true) => ({ fixtureId: "f", home: "a", away: "b", kind, events, rule, drawStands });
    const dlsB: ObservedOutcome = { kind: "win", winner: "b", method: "dls" };
    const at = (status: string, outcome: ObservedOutcome | null) => [fx("f", "a", "b", status, outcome)];
    expect(abandonWithResult([d("leading", goals("a"))], at("decided", { kind: "win", winner: "a", method: "abandoned" }))).toMatchObject({ verdict: "pass", checked: 1 });
    expect(abandonWithResult([d("leading", goals("a"))], at("decided", { kind: "win", winner: "b", method: "abandoned" })).verdict).toBe("fail");
    expect(abandonWithResult([d("leading", goals("a"))], at("decided", { kind: "win", winner: "a" })).verdict).toBe("fail");
    expect(abandonWithResult([d("leading", goals("a"))], at("abandoned", null)).verdict).toBe("fail");
    expect(abandonWithResult([d("leading", goals("a", "b"))], at("decided", { kind: "win", winner: "a", method: "abandoned" })).verdict, "no leader posted").toBe("fail");
    expect(abandonWithResult([d("level", goals("a", "b"))], at("decided", { kind: "draw" }))).toMatchObject({ verdict: "pass" });
    expect(abandonWithResult([d("level", goals("a", "b"))], at("abandoned", null)).verdict).toBe("fail");
    // R16-3 (FB-AB-1: a draw in draw kinds only; X-AB-1): where the stage refuses a draw (the sport's supportsDraws), a
    // level abandon is abandoned with no result - and a draw there is the defect.
    expect(abandonWithResult([d("level", goals("a", "b"), null, false)], at("abandoned", null))).toMatchObject({ verdict: "pass", checked: 1 });
    expect(abandonWithResult([d("level", goals("a", "b"), null, false)], at("decided", { kind: "draw" })).verdict, "a draw where the stage refuses one").toBe("fail");
    expect(abandonWithResult([d("level", goals("a", "b"), null, false)], at("abandoned", { kind: "draw" })).verdict, "a held draw is still a result").toBe("fail");
    expect(abandonWithResult([d("level", goals("a"), null, false)], at("abandoned", null)).verdict, "no level score posted").toBe("fail");
    // CK-AB-1 (review M-3): the expected result is the rule's fold of the posted stream, never the product's winner.
    expect(abandonWithResult([d("past_min_overs", [], dlsB)], at("decided", { kind: "win", winner: "b", method: "dls" })).verdict).toBe("pass");
    expect(abandonWithResult([d("past_min_overs", [], dlsB)], at("decided", { kind: "win", winner: "a", method: "dls" })).verdict, "the product's other winner").toBe("fail");
    expect(abandonWithResult([d("past_min_overs", [], dlsB)], at("decided", { kind: "tie" })).verdict, "a tie where the rule gives a win").toBe("fail");
    expect(abandonWithResult([d("past_min_overs", [], { kind: "tie" })], at("decided", { kind: "tie" })).verdict).toBe("pass");
    expect(abandonWithResult([d("past_min_overs", [], { kind: "tie" })], at("decided", { kind: "win", winner: "b", method: "dls" })).verdict, "a win where the rule gives a tie").toBe("fail");
    expect(abandonWithResult([d("past_min_overs", [], dlsB)], at("decided", { kind: "win", winner: "b" })).verdict, "a win by no method").toBe("fail");
    expect(abandonWithResult([d("past_min_overs", [], dlsB)], at("decided", { kind: "no_result" })).verdict).toBe("fail");
    // A rule fold that is neither a DLS win nor a tie fails by name, whatever the product says.
    for (const rule of [null, { kind: "no_result" } as const, { kind: "win", winner: "b" } as const]) {
      const c = abandonWithResult([d("past_min_overs", [], rule)], at("decided", { kind: "win", winner: "b", method: "dls" }));
      expect(c, JSON.stringify(rule)).toMatchObject({ verdict: "fail", checked: 1 });
      expect(c.reason, JSON.stringify(rule)).toMatch(/neither a DLS win nor a tie/);
    }
    expect(abandonWithResult([d("before_min_overs")], at("decided", { kind: "no_result" })).verdict).toBe("pass");
    expect(abandonWithResult([d("before_min_overs")], at("abandoned", null)).verdict).toBe("fail");
    expect(abandonWithResult([], [])).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("abandonDelta (X-AB-1): each kind's table delta from the cfg's own points and the RULE's winner; a rule result that cannot be read is refused by name, never dropped (review M-3)", () => {
    // Cricket's league points (hand-written): win 2, loss 0, tie 1, no result 1.
    const pts: Record<string, number> = { win: 2, loss: 0, draw: 1, tie: 1, noResult: 1 };
    const p = (k: string) => pts[k]!;
    const d = (kind: "leading" | "level" | "past_min_overs" | "before_min_overs", events: StreamEvent[] = [], rule: ObservedOutcome | null = null, drawStands = true) => ({ fixtureId: "f", home: "a", away: "b", kind, events, rule, drawStands });
    const exp = (x: ReturnType<typeof abandonDelta>) => { if (!("expect" in x)) throw new Error(x.refused); return x.expect; };
    const lead = exp(abandonDelta(d("leading", goals("a")), p));
    expect([lead("a"), lead("b")]).toEqual([{ scalars: { played: 1, won: 1, lost: 0, points: 2 }, metrics: {} }, { scalars: { played: 1, won: 0, lost: 1, points: 0 }, metrics: {} }]);
    const past = exp(abandonDelta(d("past_min_overs", [], { kind: "win", winner: "b", method: "dls" }), p));
    expect([past("a"), past("b")], "the RULE's winner b, not a product answer").toEqual([{ scalars: { played: 1, won: 0, lost: 1, points: 0 }, metrics: {} }, { scalars: { played: 1, won: 1, lost: 0, points: 2 }, metrics: {} }]);
    expect(exp(abandonDelta(d("past_min_overs", [], { kind: "tie" }), p))("a")).toEqual({ scalars: { played: 1, points: 1 }, metrics: {} });
    expect(exp(abandonDelta(d("before_min_overs"), p))("b")).toEqual({ scalars: { played: 1, won: 0, lost: 0, points: 1 }, metrics: { no_results: 1 } });
    expect(exp(abandonDelta(d("level", goals("a", "b")), p))("a")).toEqual({ scalars: { played: 1, won: 0, drawn: 1, lost: 0, points: 1 }, metrics: {} });
    // R16-3 / X-AB-1: where the stage refuses a draw, the level abandon has no result - out of the table, nothing played.
    const out = exp(abandonDelta(d("level", goals("a", "b"), null, false), p));
    expect([out("a"), out("b")]).toEqual([0, 1].map(() => ({ scalars: { played: 0, won: 0, drawn: 0, lost: 0, points: 0 }, metrics: {} })));
    let refused = 0;
    for (const rule of [null, { kind: "no_result" } as const, { kind: "draw" } as const]) {
      expect(abandonDelta(d("past_min_overs", [], rule), p), JSON.stringify(rule)).toEqual({ refused: expect.stringMatching(/neither a DLS win nor a tie/) });
      refused++;
    }
    expect(abandonDelta(d("leading", goals("a", "b")), p)).toEqual({ refused: expect.stringMatching(/no leader/) });
    expect(refused).toBe(3);
  });
});

describe("isolatedTable (X-WO-1, X-DW-4, X-AB-1): a row against the rule's delta plus the sport's own for every other match", () => {
  const zero: LocalDelta = { played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} };
  const win = (gf: number, ga: number): LocalDelta => ({ ...zero, played: 1, won: 1, points: 3, metrics: { gf, ga } });
  const loss = (gf: number, ga: number): LocalDelta => ({ ...zero, played: 1, lost: 1, metrics: { gf, ga } });
  const fixtures = [
    fx("wo", "a", "b", "forfeited", { kind: "award", winner: "a", loser: "b", reason: "walkover" }),
    fx("p1", "a", "c", "decided", { kind: "win", winner: "a" }),
    fx("p2", "b", "c", "decided", { kind: "win", winner: "c" }),
    fx("open", "a", "d", "scheduled", null),
  ];
  const local = (f: ObservedFixture): readonly [LocalDelta, LocalDelta] | null => (f.id === "p1" ? [win(2, 1), loss(1, 2)] : f.id === "p2" ? [loss(0, 1), win(1, 0)] : null);
  const judged = new Map([["wo", (e: string) => (e === "a" ? { scalars: { played: 1, won: 1, lost: 0 }, metrics: { gf: 3, ga: 0 } } : { scalars: { played: 1, won: 0, lost: 1 }, metrics: { gf: 0, ga: 3 } })]]);
  const row = (entrantId: string, played: number, won: number, lost: number, gf: number, ga: number): StandingsRowWire => ({ entrantId, rank: 1, points: 0, played, won, lost, drawn: 0, metrics: { gf, ga } });
  const rows = new Map([["a", row("a", 2, 2, 0, 5, 1)], ["b", row("b", 2, 0, 2, 0, 4)]]);
  it("each judged entrant's row is the rule's credit plus its other matches: two items pass", () => {
    expect(isolatedTable("t", { fixtures, rows, judged, local })).toMatchObject({ verdict: "pass", checked: 2 });
  });
  it("a credited key off by one reds that entrant alone; a missing row reds; an unposted counted result is named, not guessed", () => {
    expect(isolatedTable("t", { fixtures, rows: new Map([...rows, ["a", row("a", 2, 2, 0, 4, 1)]]), judged, local })).toMatchObject({ verdict: "fail", checked: 2 });
    expect(isolatedTable("t", { fixtures, rows: new Map([...rows, ["b", row("b", 2, 1, 2, 0, 4)]]), judged, local })).toMatchObject({ verdict: "fail", checked: 2 });
    expect(isolatedTable("t", { fixtures, rows: new Map([["a", rows.get("a")!]]), judged, local })).toMatchObject({ verdict: "fail", checked: 2 });
    const foreign = [...fixtures, fx("x", "b", "d", "decided", { kind: "win", winner: "d" })];
    const r = isolatedTable("t", { fixtures: foreign, rows, judged, local });
    expect(r).toMatchObject({ verdict: "pass", checked: 1 });
    expect(r.reason).toMatch(/1 entrant\(s\) not isolable \(b: x/);
    const none = isolatedTable("t", { fixtures: [...foreign, fx("y", "a", "d", "decided", { kind: "win", winner: "d" })], rows, judged, local });
    expect(none).toMatchObject({ verdict: "fail", checked: 0 });
    expect(none.reason).toMatch(/not isolable/);
  });
  it("nothing judged is a failure (R25)", () => {
    expect(isolatedTable("t", { fixtures, rows, judged: new Map(), local })).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("tableJudged: a table's rows are the division's entrants — americano and every bracket kind are not", () => {
    expect(tableJudged("league")).toBe(true);
    expect(tableJudged("group")).toBe(true);
    expect(tableJudged("swiss")).toBe(true);
    expect(tableJudged("americano")).toBe(false);
    for (const k of [...BRACKET_STAGE_KINDS, "ladder"]) expect(tableJudged(k), k).toBe(false);
  });
});

describe("WD-CASC's checks (X-WD-1..3, X-DW-2, Review Focus 1)", () => {
  const answer = (over: Partial<WithdrawOut> = {}): WithdrawOut => ({ entrant_id: "x", status: "withdrawn", policy: "walkover", walkovers: 1, voided: 0, skipped_finalized: 0, walked_over_held: 0, ...over });
  const { rows, graph } = bracket("knockout", F8);
  const lines = knockoutLines(graph, rows.filter((r) => r.round_no === 1));
  const [qf1, qf2] = lines.a.qf;
  const [qf3, qf4] = lines.b.qf;
  const id = (k: string) => `f-${k}`;
  const ext = (key: string, home: string | null, away: string | null, status: string, outcome: ObservedOutcome | null) => fx(id(key), home, away, status, outcome, { extKey: key });
  const w1 = qf1.home_entrant_id!; const a2 = qf2.away_entrant_id!; const a3 = qf3.away_entrant_id!;
  // W2b C-5: the bye award a dead seat's arriving opponent gets (awardSeededByes) — no loser, reason bye — unless a
  // WINNER withdrew from that seat: then it names her, reason withdrew (owner ruling 116).
  const bye = (winner: string): ObservedOutcome => ({ kind: "award", winner, loser: null, reason: "bye" });
  const overHer = (winner: string, loser: string): ObservedOutcome => ({ kind: "award", winner, loser, reason: WITHDREW });
  const r = {
    half: "crowned" as const,
    steps: [
      { entrantId: w1, label: "semi-final opponent TBD", answer: answer() },
      { entrantId: qf2.home_entrant_id!, label: "held", answer: answer({ walked_over_held: 1 }) },
      { entrantId: qf3.home_entrant_id!, label: "not started", answer: answer() },
      { entrantId: a3, label: "semi-final opponent TBD", answer: answer() },
    ],
    walked: [{ fixtureId: qf2.id, withdrawn: qf2.home_entrant_id!, remaining: a2, label: "held" }, { fixtureId: qf3.id, withdrawn: qf3.home_entrant_id!, remaining: a3, label: "not started" }],
    w1, a2, a3, lines, dw: { fixtureId: qf4.id, home: qf4.home_entrant_id!, away: qf4.away_entrant_id!, asked: { kind: "double_walkover" as const }, refusal: null },
  };
  const good = [
    ext(qf1.ext_key!, w1, qf1.away_entrant_id, "decided", { kind: "win", winner: w1 }),
    ext(qf2.ext_key!, qf2.home_entrant_id, a2, "forfeited", { kind: "award", winner: a2, loser: qf2.home_entrant_id!, reason: WITHDREW }),
    ext(qf3.ext_key!, qf3.home_entrant_id, a3, "forfeited", { kind: "award", winner: a3, loser: qf3.home_entrant_id!, reason: WITHDREW }),
    ext(qf4.ext_key!, qf4.home_entrant_id, qf4.away_entrant_id, "forfeited", { kind: "double_walkover" }),
    // Ruling 116: w1 won QF1 and then withdrew, so SF1's walkover names her; the final's dead seat (SF2's void) is a bye.
    ext(lines.a.sf, null, a2, "forfeited", overHer(a2, w1)),
    // Review Focus 1: a3's departed seat beside QF4's RECORDED double walkover — nobody withdrew from QF4 — is a void.
    ext(lines.b.sf, null, null, "abandoned", null),
    // X-DW-2 (and the 2026-09-21 cascade ruling): the seat the void feeds is dead, so its opponent walks over.
    { ...ext(lines.final, a2, null, "forfeited", bye(a2)), isFinal: true },
  ];
  const ranks = [a2];
  it("the rule's run passes all three; each reds when its own fixture is wrong", () => {
    expect(withdrawalsWalkOver(r, good)).toMatchObject({ verdict: "pass", checked: 6 });
    expect(tbdSeatWalksOver(r, good)).toMatchObject({ verdict: "pass", checked: 4 });
    expect(bothSeatsDead(r, good, ranks)).toMatchObject({ verdict: "pass", checked: 4 });
    const swap = (key: string, f: ObservedFixture) => good.map((g) => (g.extKey === key ? f : g));
    expect(withdrawalsWalkOver(r, swap(qf2.ext_key!, ext(qf2.ext_key!, qf2.home_entrant_id, a2, "abandoned", null))).verdict).toBe("fail");
    expect(withdrawalsWalkOver({ ...r, steps: [...r.steps, { entrantId: "y", label: "x", answer: answer({ voided: 1 }) }] }, good).verdict, "a voiding answer").toBe("fail");
    const refused = withdrawalsWalkOver({ ...r, steps: [...r.steps, { entrantId: "y", label: "semi-final opponent TBD", answer: null, refusal: { status: 422, code: "WRONG_PHASE" } }] }, good);
    expect(refused, "a refused withdrawal (X-WD-3)").toMatchObject({ verdict: "fail", checked: 7 });
    expect(refused.reason).toMatch(/withdrawal of y \(semi-final opponent TBD\) refused 422 WRONG_PHASE/);
    // walked_over_held (the plan's N1): a held line, or a chess tie-break pending, counts once; nothing else does.
    const heldRows: [string, WithdrawOut, string, RegExp][] = [
      ["a held line not counted", answer({ walked_over_held: 0 }), "held", /\(held\) answered policy walkover, voided 0, walked_over_held 0; wanted walkover, 0, 1/],
      ["a tie-break pending not counted", answer({ walked_over_held: 0 }), "tie-break pending", /\(tie-break pending\) answered .*walked_over_held 0; wanted walkover, 0, 1/],
      ["play under way counted held", answer({ walked_over_held: 1 }), "in play", /\(in play\) answered .*walked_over_held 1; wanted walkover, 0, 0/],
      ["the field missing (a pre-F answer)", { entrant_id: "x", status: "withdrawn", policy: "walkover", walkovers: 1, voided: 0, skipped_finalized: 0 } as WithdrawOut, "held", /\(held\) answered .*walked_over_held undefined; wanted walkover, 0, 1/],
    ];
    for (const [name, a, label, why] of heldRows) {
      const got = withdrawalsWalkOver({ ...r, steps: [{ entrantId: "y", label, answer: a }] }, good);
      expect(got.verdict, name).toBe("fail");
      expect(got.evidence.join(" | "), name).toMatch(why);
    }
    expect(heldRows.length).toBe(4);
    expect(withdrawalsWalkOver({ ...r, steps: [{ entrantId: "y", label: "tie-break pending", answer: answer({ walked_over_held: 1 }) }] }, good).verdict, "a tie-break pending counted once").toBe("pass");
    expect(tbdSeatWalksOver(r, swap(lines.a.sf, ext(lines.a.sf, w1, a2, "forfeited", { kind: "award", winner: a2, loser: w1, reason: WITHDREW }))).verdict, "W1 still seated").toBe("fail");
    expect(tbdSeatWalksOver(r, [...good, ext("other", w1, "z", "scheduled", null)]).verdict, "W1 seated later").toBe("fail");
    expect(tbdSeatWalksOver(r, swap(qf1.ext_key!, ext(qf1.ext_key!, w1, qf1.away_entrant_id, "cancelled", null))).verdict, "a voided fixture").toBe("fail");
    // Ruling 116: the arrival's award names w1, who withdrew — loser w1, reason withdrew — and the check reads both;
    // the bye it was before the ruling (C-5) is now a failure.
    const sf1Rows: [string, ObservedOutcome][] = [
      ["the bye it was (C-5)", bye(a2)],
      ["reason walkover", { kind: "award", winner: a2, loser: w1, reason: "walkover" }],
      ["another loser named", { kind: "award", winner: a2, loser: qf1.away_entrant_id!, reason: WITHDREW }],
    ];
    for (const [name, o] of sf1Rows) {
      const got = tbdSeatWalksOver(r, swap(lines.a.sf, ext(lines.a.sf, null, a2, "forfeited", o)));
      expect(got.verdict, name).toBe("fail");
      expect(got.evidence.join(" | "), name).toMatch(/wanted the arriving .* walked over .*, who withdrew/);
    }
    expect(sf1Rows.length).toBe(3);
    // SF2 and the final, each way to go wrong: SF2 a double walkover (the I-6 expectation F's Review Focus 1 refutes) or
    // left open; the final left open (the I-6 expectation), walked over by another reason, or no champion crowned.
    const deadRows: [string, string, ObservedFixture, readonly string[] | null, RegExp][] = [
      ["SF2 a double walkover", lines.b.sf, ext(lines.b.sf, null, null, "forfeited", { kind: "double_walkover" }), ranks, /forfeited \{"kind":"double_walkover"\}, seats nobody — wanted abandoned with no outcome/],
      ["SF2 left open", lines.b.sf, ext(lines.b.sf, null, null, "scheduled", null), ranks, /scheduled no outcome, seats nobody — wanted abandoned/],
      ["SF2 seats someone", lines.b.sf, ext(lines.b.sf, a3, null, "abandoned", null), ranks, new RegExp(`abandoned no outcome, seats ${a3} — wanted`)],
      ["the final left open", lines.final, ext(lines.final, a2, null, "scheduled", null), null, /scheduled no outcome — wanted forfeited bye award to/],
      ["the final by another reason", lines.final, ext(lines.final, a2, null, "forfeited", { kind: "award", winner: a2, loser: null, reason: "walkover" }), ranks, /wanted forfeited bye award to/],
      ["no champion", lines.final, good.at(-1)!, null, /crowned \(none\)/],
      ["another champion", lines.final, good.at(-1)!, ["z"], /crowned z/],
    ];
    for (const [name, key, row, rk, why] of deadRows) {
      const got = bothSeatsDead(r, swap(key, row), rk);
      // A final row swapped in keeps its flag: the crown is read off the flagged final.
      expect(got.verdict, name).toBe("fail");
      expect(got.evidence.join(" | "), name).toMatch(why);
    }
    expect(deadRows.length).toBe(7);
    expect(bothSeatsDead({ ...r, dw: { ...r.dw, refusal: { status: 409, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" } } }, good, ranks).verdict, "the DW refused").toBe("fail");
    // The voids item exempts SF2 alone: a void anywhere else is still the cascade voiding (X-WD-2/3).
    expect(tbdSeatWalksOver(r, swap(lines.final, ext(lines.final, null, null, "abandoned", null))).verdict, "the final voided").toBe("fail");
  });
  // The vacant half (re-review round 2, item 2): a2 withdraws from the final while its other seat is TBD, and SF2's void
  // then kills that seat. Expected values from the ruling (final void, nobody crowned: W4's vacant title) and C-5/X-WD-3.
  const vr = { ...r, half: "vacant" as const, steps: [...r.steps.slice(0, 2), { entrantId: a2, label: FINAL_TBD, answer: answer() }, ...r.steps.slice(2)] };
  const finalRow = (home: string | null, away: string | null, status: string, outcome: ObservedOutcome | null, extra: Partial<ObservedFixture> = {}) => ({ ...ext(lines.final, home, away, status, outcome), isFinal: true, ...extra });
  const vacant = good.map((g) => (g.extKey === lines.final ? finalRow(null, null, "abandoned", null) : g));
  it(`${FINAL_VACANT_TITLE}: each check passes on the rule's rows and reds on every other shape`, () => {
    expect(withdrawalsWalkOver(vr, vacant)).toMatchObject({ verdict: "pass", checked: 7 });
    expect(tbdSeatWalksOver(vr, vacant)).toMatchObject({ verdict: "pass", checked: 5 });
    expect(bothSeatsDead(vr, vacant, null), "the final is finalVacant's, so finalRanks are not read").toMatchObject({ verdict: "pass", checked: 2 });
    // W4's defect: under a vacant title the product ranks a first-round loser 1st. No rank order moves the vacant half's
    // verdict — a pin would freeze the defect (class 4); the crowned half's rank-1 item is the only one read.
    const rankOrders = [["a first-round loser", vr.a2!], [vr.a2!], []];
    for (const ranks of rankOrders) expect(bothSeatsDead(vr, vacant, ranks), JSON.stringify(ranks)).toMatchObject({ verdict: "pass", checked: 2 });
    expect(rankOrders.length).toBe(3);
    expect(finalVacant(vr, vacant)).toMatchObject({ verdict: "pass", checked: 2 });
    // The crowned half's rows are not the vacant half's: its bye-crowned final reds both items, and its void would red
    // the crowned half's voids item (above), never this one's.
    const crownedFinal = finalVacant(vr, good);
    expect(crownedFinal).toMatchObject({ verdict: "fail", checked: 2 });
    expect(crownedFinal.evidence.length).toBe(2);
    for (const line of crownedFinal.evidence) expect(line.startsWith(FINAL_VACANT_TITLE), "each line names the deferral").toBe(true);
    expect(crownedFinal.evidence.join(" | ")).toMatch(new RegExp(`is forfeited .*"reason":"bye".*wanted abandoned with no outcome`));
    expect(crownedFinal.evidence.join(" | ")).toMatch(new RegExp(`crown rule names ${a2} — wanted nobody`));
    const swapF = (f: ObservedFixture) => vacant.map((g) => (g.extKey === lines.final ? f : g));
    const rows: [string, ObservedFixture[], boolean, boolean, RegExp][] = [
      // name, rows, final item ok, crown item ok, the evidence
      ["the final left open", swapF(finalRow(null, null, "scheduled", null)), false, true, /is scheduled no outcome, seats nobody — wanted abandoned/],
      ["her seat kept", swapF(finalRow(a2, null, "abandoned", null)), false, true, new RegExp(`is abandoned no outcome, seats ${a2} — wanted`)],
      ["a void that kept a winner", swapF(finalRow(null, null, "abandoned", { kind: "win", winner: a2 })), false, true, /is abandoned \{"kind":"win"/],
      ["crowned by a decided final", swapF(finalRow(a2, "z", "decided", { kind: "win", winner: "z" })), false, false, /crown rule names z — wanted nobody/],
      ["no final flagged", swapF({ ...finalRow(null, null, "abandoned", null), isFinal: undefined }), true, false, /flags 0 finals \(none\), wanted one/],
      ["two finals flagged", [...vacant, fx("f-x", "z", "y", "decided", { kind: "win", winner: "z" }, { extKey: "x", isFinal: true })], true, false, /flags 2 finals/],
    ];
    for (const [name, fixtures, finalOk, crownOk, why] of rows) {
      const got = finalVacant(vr, fixtures);
      expect(got.verdict, name).toBe("fail");
      expect(got.evidence.length, `${name}: one evidence line per failing item`).toBe(Number(!finalOk) + Number(!crownOk));
      expect(got.evidence.join(" | "), name).toMatch(why);
    }
    expect(rows.length).toBe(6);
    // A third-place match is never the final, settled or not (champion.ts): the stage still crowns nobody.
    expect(finalVacant(vr, [...vacant, fx("f-3p", "z", "y", "decided", { kind: "win", winner: "z" }, { extKey: "3p", isFinal: true, thirdPlace: true })]).verdict).toBe("pass");
    // X-WD-3 for a2: she keeps QF2 and SF1 (both walked over to her) and is seated nowhere after.
    const again = tbdSeatWalksOver(vr, swapF(finalRow(a2, null, "abandoned", null)));
    expect(again.verdict).toBe("fail");
    expect(again.evidence.join(" | ")).toMatch(new RegExp(`${a2} withdrew after ${qf2.id}, f-${lines.a.sf} and is seated again in f-${lines.final}`));
    // The final void is owed in this half only, and a void anywhere else still reds.
    expect(tbdSeatWalksOver(vr, vacant.map((g) => (g.extKey === qf1.ext_key ? ext(qf1.ext_key!, w1, qf1.away_entrant_id, "cancelled", null) : g))).verdict, "QF1 voided").toBe("fail");
    // knockoutCrown on the crowned half's rows names a2: the positive pair of "nobody".
    expect(knockoutCrown(good)).toEqual({ ok: true, winner: a2 });
    // A crown read off the bye award (forfeited is a settled status, C-5) — and never off an unsettled status.
    expect(knockoutCrown(good.map((g) => (g.extKey === lines.final ? finalRow(a2, null, "scheduled", bye(a2)) : g)))).toEqual({ ok: true, winner: null });
  });
  it("the final half alternates along WD-CASC's planned cells, so every run drives both shapes; a cell outside the plan is refused by name", () => {
    const cells = w2bCells("WD-CASC");
    const halves = cells.map((c) => wdCascFinalHalf(c.row, c.sport));
    expect(halves.filter((h) => h === "crowned").length).toBe(Math.ceil(cells.length / 2));
    expect(halves.filter((h) => h === "vacant").length).toBe(Math.floor(cells.length / 2));
    expect(halves.filter((h) => h === "vacant").length).toBeGreaterThan(0);
    expect(() => wdCascFinalHalf("league", "generic")).toThrow(W2bMisplanned);
  });
  it("CROWN_SETTLED is champion.ts BRACKET_SETTLED, read from the product", () => {
    const text = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/web/src/server/public-site/champion.ts"), "utf8");
    const m = /export const BRACKET_SETTLED[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(text);
    expect(m, "champion.ts no longer declares BRACKET_SETTLED").not.toBeNull();
    const product = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    expect(product.length).toBeGreaterThan(0);
    expect([...CROWN_SETTLED].sort()).toEqual(product.sort());
  });
  it("a withdrawn side's fixture left open stops the case by the rule's name; a terminal one plays on", () => {
    // The truth-run's find (pre-D): football's held QF2 stayed needs_decision after its home side withdrew, and the round
    // loop then posted core.start to it (422 ALREADY_DECIDED) — an error that named the harness, not the gap.
    const rows: [string, "accepted" | "refused", boolean, string | null][] = [
      ["forfeited", "accepted", true, null],
      ["forfeited", "refused", true, null],
      ["needs_decision", "accepted", true, "q2 (held) is needs_decision after its side withdrew: the product did not walk it over (X-WD-1)"],
      ["scheduled", "accepted", false, "q2 (held) is scheduled after its side withdrew"],
      ["needs_decision", "refused", true, "q2 (held) is needs_decision after its withdrawal was refused: the choreography already posted to it"],
      ["scheduled", "refused", false, null],
    ];
    for (const [status, withdrawal, posted, want] of rows) {
      const got = cascadeLeftOpen("q2", "held", status, withdrawal, posted);
      if (want === null) expect(got, `${status} ${withdrawal} posted=${posted}`).toBeNull();
      else expect(got, `${status} ${withdrawal} posted=${posted}`).toContain(want);
    }
    expect(rows.length).toBe(6);
    expect(new W2bCascadeLeftOpen("x").message).toBe("scenario: WD-CASC — x");
  });
  it("a choreography that never began fails each check by name (never a vacuous pass)", () => {
    for (const half of ["crowned", "vacant"] as const) {
      const empty = { half, steps: [], walked: [], w1: null, a2: null, a3: null, lines: null, dw: null };
      expect(withdrawalsWalkOver(empty, good), half).toMatchObject({ verdict: "fail", checked: 1 });
      expect(tbdSeatWalksOver(empty, good), half).toMatchObject({ verdict: "fail", checked: 1 });
      expect(bothSeatsDead(empty, good, ranks), half).toMatchObject({ verdict: "fail", checked: 1 });
      expect(finalVacant(empty, good), half).toMatchObject({ verdict: "fail", checked: 1 });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("walkover-credit (the reference family) as the harness asks it: the scoresheet so far, the offender, and a refusal JUDGED", () => {
  it("every key the family credits is a metric the sport's own standingsDelta emits for a played match — walkover and double walkover (sweep of 11, under each builder default)", () => {
    let checked = 0;
    for (const sport of SPORT_KEYS) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, variantFor(sport)), "league", variantFor(sport)) as Record<string, unknown>;
      const events = generateStream({ sportKey: sport, cfg, stageKind: "league", home: "h", away: "a", outcome: { kind: "win", winner: "home" } });
      const folded = foldStream(sportModule(sport), cfg, "h", "a", events);
      const [h] = sportModule(sport).standingsDelta(folded.outcome as never, cfg as never, { kind: "league" }, folded.state as never);
      for (const reason of ["walkover", "double_walkover"] as const) {
        const c = walkoverCredit({ sport, cfg, reason });
        const keys = [...new Set([...Object.keys(c.winner), ...Object.keys(c.loser)])];
        expect(keys.length, `${sport} ${reason}`).toBeGreaterThan(0);
        for (const k of keys) expect(Object.keys(h.metrics), `${sport} ${reason}: ${k}`).toContain(k);
      }
      checked++;
    }
    expect(checked).toBe(11);
    expect([...CREDIT_SPORTS].sort()).toEqual([...SPORT_KEYS].sort());
  });

  /** The scoresheet each sport's retirement stream carries, read off the generators' declared partial plays
   *  (streams/*.ts `partial`) by the unit the family names (a period, a set, a game, an innings). */
  const SHEET: Readonly<Record<string, (cfg: Record<string, unknown>) => { home: number[]; away: number[] }>> = {
    football: () => ({ home: [1], away: [1] }), // a goal each (10', 20')
    hockey: () => ({ home: [1], away: [1] }),
    icehockey: () => ({ home: [1], away: [1] }),
    volleyball: () => ({ home: [1], away: [1] }), // a rally each: set 1 at 1-1
    tabletennis: () => ({ home: [1], away: [1] }),
    badminton: () => ({ home: [1], away: [1] }),
    tennis: () => ({ home: [0], away: [0] }), // a point each: set 1, no game won
    generic: () => ({ home: [1], away: [1] }), // one point each
    // a board each at the level game's coin count (one to home where maxBoards ≤ 2), each worth coins × pointsPerCoin
    carrom: (cfg) => {
      const pts = Math.max(1, levelCoins(cfg as never)) * (cfg.pointsPerCoin as number);
      return (cfg.maxBoards as number) > 2 ? { home: [pts], away: [pts] } : { home: [pts], away: [0] };
    },
    cricket: () => ({ home: [120], away: [40] }), // home's innings closed at 120, away's chase at 40
    boardgame: () => ({ home: [], away: [] }), // the game IS its result: nothing played short of it
  };

  it("scoresheetOf reads the play the harness POSTED before its forfeit, unit by unit, over every sport's retirement stream (table and bracket cfgs)", () => {
    let checked = 0;
    let unbuilt = 0;
    for (const kind of ["league", "knockout"] as const) {
      for (const sport of SPORT_KEYS) {
        const cfg = stageCfg(sport, resolveSportCfg(sport, variantFor(sport)), kind, variantFor(sport)) as Record<string, unknown>;
        let events: StreamEvent[];
        try {
          events = generateStream({ sportKey: sport, cfg, stageKind: kind, home: "h", away: "a", outcome: { kind: "forfeit", by: "home", reason: "retired", at: "after_start" } });
        } catch (e) {
          if (!(e instanceof OutcomeUnreachable) && !(e instanceof GeneratorUnsupported)) throw e;
          unbuilt++;
          continue;
        }
        expect(events.at(-1)?.type, sport).toBe("core.forfeit");
        expect(scoresheetOf(sport, cfg, events.slice(0, -1), "h", "a"), `${kind} ${sport}`).toEqual(SHEET[sport]!(cfg));
        checked++;
      }
    }
    expect(checked + unbuilt).toBe(2 * SPORT_KEYS.length);
    expect(checked).toBeGreaterThanOrEqual(SPORT_KEYS.length);
    expect(Object.keys(SHEET).sort()).toEqual([...SPORT_KEYS].sort());
  });

  it("scoresheetOf, the empty case (ruling 112, R112 review M-3): a stream holding nothing but its START — or nothing at all — reads as an EMPTY scoresheet in every sport, never a 0-0 unit (the oracle reads a unit as play)", () => {
    let checked = 0;
    for (const sport of SPORT_KEYS) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, variantFor(sport)), "league", variantFor(sport)) as Record<string, unknown>;
      for (const events of [[{ type: "core.start", payload: {} }], []] as StreamEvent[][]) {
        expect(scoresheetOf(sport, cfg, events, "h", "a"), `${sport} ${events.length === 0 ? "nothing" : "a bare START"}`).toEqual({ home: [], away: [] });
        checked++;
      }
    }
    expect(checked).toBe(2 * SPORT_KEYS.length);
    expect(SPORT_KEYS.length).toBe(11);
  });

  it("scoresheetOf refuses by name what it cannot place: an event outside the sport's vocabulary, a side neither of the two, a unit that may have ended, a sport it has no reading for", () => {
    const fb = { awardScore: { goals: 3 } };
    expect(() => scoresheetOf("football", fb, [{ type: "football.card", payload: { by: "h" } }], "h", "a")).toThrow(ScoresheetUnread);
    expect(() => scoresheetOf("football", fb, [{ type: "football.goal", payload: { by: "zz" } }], "h", "a")).toThrow(/neither side/);
    const vb = { setTo: 2, bestOf: 3 };
    expect(() => scoresheetOf("volleyball", vb, [{ type: "volleyball.rally", payload: { wonBy: "h" } }, { type: "volleyball.rally", payload: { wonBy: "h" } }], "h", "a")).toThrow(/may have ended/);
    expect(scoresheetOf("volleyball", vb, [{ type: "volleyball.rally", payload: { wonBy: "h" } }], "h", "a")).toEqual({ home: [1], away: [0] }); // its positive pair
    expect(() => scoresheetOf("tennis", {}, Array.from({ length: 4 }, () => ({ type: "tennis.point", payload: { by: "a" } })), "h", "a")).toThrow(/may have ended/);
    expect(() => scoresheetOf("boardgame", {}, [{ type: "boardgame.result", payload: { winner: null } }], "h", "a")).toThrow(ScoresheetUnread);
    expect(() => scoresheetOf("curling", {}, [], "h", "a")).toThrow(/no scoresheet reading/);
  });

  it("creditExpectation: a one-sided forfeit credits the OTHER side the winner's metrics (W1) and its win points, the offender the loser's (L1) and its loss points; a double walkover is L1, 0 points and zero for both; a refusal comes back BY NAME, never thrown, never skipped", () => {
    const sides = { home: "h", away: "a" };
    // Hand-written cfgs, each with its sport's points table (FB 3/1/0; FIVB's 3-2 → 2:1, else 3:0; generic 3/1/0).
    const fb = { awardScore: { goals: 3 }, points: { win: 3, draw: 1, loss: 0 } };
    const wo = creditExpectation({ sport: "football", cfg: fb, reason: "walkover", by: "away" }, { ...sides, offender: "away" });
    expect("expect" in wo).toBe(true);
    if (!("expect" in wo)) return;
    // FB-WO-1: 3-0 to the side that turned up — a win's 3 points, the offender a loss's 0.
    expect(wo.expect("h")).toEqual({ scalars: { played: 1, won: 1, lost: 0, points: 3 }, metrics: { gf: 3, ga: 0, gd: 3 } });
    expect(wo.expect("a")).toEqual({ scalars: { played: 1, won: 0, lost: 1, points: 0 }, metrics: { gf: 0, ga: 3, gd: -3 } });
    // VB-RT-1: home retires at 10-12 in set 1 of a best of 3 — set 1 completed for away 25-10, set 2 25-0: a 2-0 win, FIVB's "*" 3:0.
    const vb = { bestOf: 3, setTo: 25, finalSetTo: 15, winBy: 2, cap: null, pointsMap: { "3-2": [2, 1], "2-1": [2, 1], "*": [3, 0] } };
    const rt = creditExpectation({ sport: "volleyball", cfg: vb, reason: "retired", by: "home", played: { home: [10], away: [12] } }, { ...sides, offender: "home" });
    expect("expect" in rt && rt.expect("a")).toEqual({ scalars: { played: 1, won: 1, lost: 0, points: 3 }, metrics: { sets_won: 2, sets_lost: 0, points_won: 50, points_lost: 10 } });
    expect("expect" in rt && rt.expect("h")).toEqual({ scalars: { played: 1, won: 0, lost: 1, points: 0 }, metrics: { sets_won: 0, sets_lost: 2, points_won: 10, points_lost: 50 } });
    // X-DW-4: P+1, L+1, 0 points, no score credited — for both sides.
    const dw = creditExpectation({ sport: "generic", cfg: { resultMode: "score", points: { w: 3, d: 1, l: 0 } }, reason: "double_walkover" }, { ...sides, offender: "both" });
    for (const e of ["h", "a"]) expect("expect" in dw && dw.expect(e), e).toEqual({ scalars: { played: 1, won: 0, drawn: 0, lost: 1, points: 0 }, metrics: { for: 0, against: 0, diff: 0 } });
    // Refusals, by the family's own name (CreditRefused), returned to be judged as failures.
    expect(creditExpectation({ sport: "football", cfg: fb, reason: "retired", by: "home" }, { ...sides, offender: "home" })).toEqual({ refused: expect.stringMatching(/not-started|retired and disqualified are recorded after play started/) });
    expect(creditExpectation({ sport: "football", cfg: fb, reason: "retired", played: { home: [0], away: [1] } }, { ...sides, offender: "home" })).toEqual({ refused: expect.stringMatching(/names that side/) });
    expect(creditExpectation({ sport: "football", cfg: { points: fb.points }, reason: "walkover", by: "away" }, { ...sides, offender: "away" })).toEqual({ refused: expect.stringMatching(/awardScore/) });
    // A cfg with no points table this check reads is refused by name, not credited 0 (its positive pair: fb above).
    expect(creditExpectation({ sport: "football", cfg: { awardScore: { goals: 3 } }, reason: "walkover", by: "away" }, { ...sides, offender: "away" })).toEqual({ refused: expect.stringMatching(/no points table/) });
  });

  it("forfeitPoints: a forfeit's 'win' is the points a PLAYED win and loss earn under the same cfg — the sport's own standingsDelta of its generated win stream, every sport (sweep of 11); 'zero' is nothing; an unread table is named", () => {
    let checked = 0;
    for (const sport of SPORT_KEYS) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, variantFor(sport)), "league", variantFor(sport)) as Record<string, unknown>;
      const events = generateStream({ sportKey: sport, cfg, stageKind: "league", home: "h", away: "a", outcome: { kind: "win", winner: "home" } });
      const folded = foldStream(sportModule(sport), cfg, "h", "a", events);
      const [h, a] = sportModule(sport).standingsDelta(folded.outcome as never, cfg as never, { kind: "league" }, folded.state as never);
      const credit = walkoverCredit({ sport, cfg, reason: "walkover" });
      expect(credit.points, sport).toBe("win");
      expect(forfeitPoints(cfg, credit.points, credit.winner), sport).toEqual({ winner: h.points, loser: a.points });
      expect(h.points, `${sport}: a win earns points`).toBeGreaterThan(a.points);
      expect(forfeitPoints(cfg, "zero", credit.winner), sport).toEqual({ winner: 0, loser: 0 });
      checked++;
    }
    expect(checked).toBe(SPORT_KEYS.length);
    expect(forfeitPoints({}, "win", {})).toEqual({ unread: expect.stringMatching(/no points table/) });
    expect(forfeitPoints({ pointsMap: { "3-2": [2, 1] } }, "win", { sets_won: 3, sets_lost: 0 })).toEqual({ unread: expect.stringMatching(/no pair for the credited set score 3-0/) });
    expect(forfeitPoints({ pointsMap: { "3-0": [3, 0], "*": [2, 1] } }, "win", { sets_won: 3, sets_lost: 0 }), "the exact score before the wildcard").toEqual({ winner: 3, loser: 0 });
  });

  it("expectationOf (M-8): a double walkover whose credit names a non-zero key on EITHER side alone is refused by name — the two sides are judged apart, never merged", () => {
    const cfg = { points: { w: 3, d: 1, l: 0 } };
    const both = { home: "h", away: "a", offender: "both" as const };
    const answer = (winner: Record<string, number>, loser: Record<string, number>, points: "win" | "zero" = "zero") => ({ winner, loser, excluded: [], points, statsMatch: false });
    expect(expectationOf(answer({ for: 0 }, { for: 0 }), cfg, both)).toHaveProperty("expect"); // the positive pair
    // A merge {...winner, ...loser} would read for: 0 here — the loser's zero hiding the winner's 2.
    expect(expectationOf(answer({ for: 2 }, { for: 0 }), cfg, both)).toEqual({ refused: expect.stringMatching(/credits its winner side for 2/) });
    expect(expectationOf(answer({ for: 0 }, { against: 1 }), cfg, both)).toEqual({ refused: expect.stringMatching(/credits its loser side against 1/) });
    expect(expectationOf(answer({ for: 0 }, { for: 0 }, "win"), cfg, both)).toEqual({ refused: expect.stringMatching(/X-DW-4 is 0 points/) });
  });

  it("withRefusals: each refused credit is a FAILING item counted beside the table's own; no refusal leaves the table's verdict as it was", () => {
    const pass = { id: "t", kind: "assertion" as const, verdict: "pass" as const, checked: 2, reason: "2 ok", evidence: [] };
    expect(withRefusals(pass, [])).toBe(pass);
    const out = withRefusals(pass, ["f1: walkover-credit refused (not-started)"]);
    expect(out).toMatchObject({ verdict: "fail", checked: 3, reason: "f1: walkover-credit refused (not-started)" });
    expect(out.evidence).toEqual(["f1: walkover-credit refused (not-started)"]);
    // Refusals alone (nothing judged in the table) still fail, counted.
    expect(withRefusals({ ...pass, verdict: "fail", checked: 0, reason: "checked 0 items (vacuous, R25)" }, ["x", "y"])).toMatchObject({ verdict: "fail", checked: 2, reason: "x" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Runs on the league fake, which folds every stream through the real engine module: the scenario end to end, its
// own checks counted. Red until loop D lands the rows they witness (D2's award {winner, loser, reason}, D3's bare
// walkover in "pre", X-DW-1's `by: "both"`, D8's award abandon) — the pre-D signatures are recorded in the Task 2
// report. The bracket scenarios (DW-ALL's refusal and dead chain, WD-CASC) need the product's withdrawal and
// fed-seat cascade, which no fake here mirrors; the L3 truth-run is their witness.
describe("each table scenario, run on the league fake", () => {
  async function run(key: (typeof W2B_SCENARIO_KEYS)[number], sport: string) {
    const variant = variantFor(sport);
    const overrides = w2bCells(key).find((c) => c.row === "league" && c.sport === sport)?.overrides;
    const spec: CaseSpec = { caseId: `league|${sport}|${variant}|${key}`, row: "league", sport, variant, scenario: key, canary: false, ...(overrides ? { overrides } : {}) };
    const out = await SCENARIOS[key].run({ driver: new FakeLeagueDriver(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant, { ...(overrides ?? {}) }), tag: "t", denied: [] });
    const own = new Map(out.assertions.filter((c) => c.id.startsWith("w2b-")).map((c) => [c.id, c]));
    return { out, own };
  }
  const RUNS: readonly { key: (typeof W2B_SCENARIO_KEYS)[number]; sport: string; pass: readonly string[]; abstain: readonly string[] }[] = [
    { key: "WO-PRE", sport: "generic", pass: ["w2b-walkover-recorded", "w2b-walkover-credit"], abstain: [] },
    { key: "WO-PRE", sport: "volleyball", pass: ["w2b-walkover-recorded", "w2b-walkover-credit"], abstain: [] },
    { key: "RT-PART", sport: "football", pass: ["w2b-retirement-recorded", "w2b-retirement-keeps-play", "w2b-retirement-credit"], abstain: [] },
    { key: "DW-ALL", sport: "generic", pass: ["w2b-double-walkover-recorded", "w2b-double-walkover-table"], abstain: ["w2b-double-walkover-advances-nobody", "w2b-double-walkover-final-refused"] },
    { key: "AB-AWARD", sport: "football", pass: ["w2b-abandon-with-result", "w2b-abandon-in-table"], abstain: [] },
    { key: "AB-AWARD", sport: "cricket", pass: ["w2b-abandon-with-result", "w2b-abandon-in-table"], abstain: [] },
    // R16-3: hockey's default takes a draw, ice hockey's (iihf: overtime and a shootout) refuses one - both halves of the
    // level abandon, end to end through the real engine module.
    { key: "AB-AWARD", sport: "hockey", pass: ["w2b-abandon-with-result", "w2b-abandon-in-table"], abstain: [] },
    { key: "AB-AWARD", sport: "icehockey", pass: ["w2b-abandon-with-result", "w2b-abandon-in-table"], abstain: [] },
  ];
  for (const r of RUNS) {
    it(`${r.key} on league|${r.sport}: its own checks pass on counted items, the rest abstain by name`, async () => {
      const { own } = await run(r.key, r.sport);
      for (const id of r.pass) {
        const c = own.get(id);
        expect(c, id).toBeDefined();
        expect(`${c!.verdict}: ${c!.reason}`, id).toMatch(/^pass/);
        expect(c!.checked, id).toBeGreaterThan(0);
      }
      for (const id of r.abstain) expect(own.get(id)?.verdict, id).toBe("abstain");
      expect(own.size).toBe(r.pass.length + r.abstain.length);
    });
  }

  it("DW-ALL on knockout_third_place (review I-1): nowhere to place an accepted double walkover, and the refusals at the final and the third-place match are JUDGED by the bracket-finish oracle — the run passes on a correct product, every sport (the row's 11 cells)", async () => {
    let judged = 0;
    const cells = w2bCells("DW-ALL").filter((c) => c.row === "knockout_third_place");
    expect(cells.map((c) => c.sport).sort()).toEqual([...SPORT_KEYS].sort());
    for (const { sport } of cells) {
      const variant = variantFor(sport);
      const spec: CaseSpec = { caseId: `knockout_third_place|${sport}|${variant}|DW-ALL`, row: "knockout_third_place", sport, variant, scenario: "DW-ALL", canary: false };
      const out = await SCENARIOS["DW-ALL"].run({ driver: new FakeKnockoutDriver({ thirdPlace: true }), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
      const by = new Map(out.assertions.map((c) => [c.id, c]));
      const finish = by.get("life-reference-bracket-finish")!;
      expect(`${finish.verdict}: ${finish.reason}`, sport).toMatch(/^pass/);
      // The two refusals (the final, the third-place match) are among the judged forfeits — never "0 of 0".
      const m = /forfeits and double walkovers: (\d+) of (\d+) judged/.exec(finish.reason);
      expect(m, sport).not.toBeNull();
      expect(Number(m![1]), sport).toBe(2);
      expect(Number(m![2]), sport).toBe(2);
      const refused = by.get("w2b-double-walkover-final-refused")!;
      // Three items a probe (refused, by the code, the fixture unmoved): the final's and the third-place match's.
      expect(`${refused.verdict} ${refused.checked}: ${refused.reason} ${refused.evidence.join(" | ")}`, sport).toMatch(/^pass 6:/);
      expect(by.get("w2b-double-walkover-recorded")?.verdict, sport).toBe("abstain");
      expect(by.get("w2b-double-walkover-recorded")?.reason, sport).toBe(NO_PLACEMENT);
      expect(by.get("life-built-as-posted")?.verdict, sport).toBe("pass");
      judged += Number(m![1]);
    }
    expect(judged).toBe(2 * SPORT_KEYS.length);
  });

  it("DW-ALL on knockout_third_place: a product that ACCEPTS the double walkover at the final reds the bracket-finish oracle by name (the run above is its positive pair)", async () => {
    class AcceptsAtTheEnd extends FakeKnockoutDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        const dw = events.some((e) => e.type === "core.forfeit" && (e.payload as { by?: unknown }).by === "both");
        const f = this.fixtures.find((x) => x.id === id)!;
        if (!dw || f.is_final !== true) return super.postStream(id, events, prefix);
        // The defect: the final recorded as a double walkover — nobody wins the title.
        Object.assign(f, { status: "forfeited", outcome: { kind: "double_walkover" } });
        f.events.push(...events);
        return [{ seq: 1, event_id: `${id}-dw`, status: "forfeited", outcome: { kind: "double_walkover" } }];
      }
    }
    const sport = "generic";
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `knockout_third_place|${sport}|${variant}|DW-ALL`, row: "knockout_third_place", sport, variant, scenario: "DW-ALL", canary: false };
    const out = await SCENARIOS["DW-ALL"].run({ driver: new AcceptsAtTheEnd({ thirdPlace: true }), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const finish = out.assertions.find((c) => c.id === "life-reference-bracket-finish")!;
    expect(finish.verdict).toBe("fail");
    expect(finish.evidence.join("\n")).toMatch(/the oracle refuses action 0 with DOUBLE_WALKOVER_NO_NEXT_MATCH, which the harness drove as legal/);
  });

  it("WO-PRE (I-2): a product whose table gives a walkover's winner 0 points FAILS the walkover credit by name — the family's 'win' is the cfg's win points (the generic run above is its positive pair)", async () => {
    class ZeroPoints extends FakeLeagueDriver {
      override async standings(stageId: string, poolId: string | null) {
        const out = await super.standings(stageId, poolId);
        return { ...out, rows: out.rows.map((r) => ({ ...r, points: 0 })) };
      }
    }
    const sport = "generic";
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `league|${sport}|${variant}|WO-PRE`, row: "league", sport, variant, scenario: "WO-PRE", canary: false };
    const out = await SCENARIOS["WO-PRE"].run({ driver: new ZeroPoints(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const c = out.assertions.find((x) => x.id === "w2b-walkover-credit")!;
    expect(c.verdict).toBe("fail");
    expect(c.checked).toBeGreaterThan(0);
    expect(c.evidence.join("\n")).toMatch(/points 0≠[1-9]/);
  });

  it("RT-PART on league, every sport it is planned on: the retirement credit is judged against the walkover-credit family (X-RT-1, the *-RT-1 rows) with the drive's offender and its scoresheet — a pass on counted items, never an abstain", async () => {
    let sports = 0;
    let items = 0;
    for (const cell of w2bCells("RT-PART").filter((c) => c.row === "league")) {
      const { own } = await run("RT-PART", cell.sport);
      const c = own.get("w2b-retirement-credit");
      expect(c, cell.sport).toBeDefined();
      expect(`${c!.verdict}: ${c!.reason}`, cell.sport).toMatch(/^pass/);
      expect(c!.checked, cell.sport).toBeGreaterThan(0);
      items += c!.checked;
      sports++;
    }
    expect(sports).toBe(SPORT_KEYS.length); // X-RT-1 is every sport's (w2bCells: a table and a bracket for each)
    expect(items).toBeGreaterThanOrEqual(2 * sports); // both sides of at least one retirement per sport
  });

  it("RT-PART: a stored row the harness cannot read as a scoresheet FAILS the retirement credit by name — a refusal is judged, never skipped (the sweep above is its positive pair)", async () => {
    // The product answers every retirement post with its stored rows, the first goal stored as a card: the harness
    // folds what the product holds, and a card is not a goal.
    class StoresACard extends FakeLeagueDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        if (events.at(-1)?.type !== "core.forfeit" || events.length < 3 || out.length !== events.length) return out;
        return out.map((p, i) => ({ ...p, stored: i === 1 ? { type: "football.card", payload: { by: (events[i]!.payload as { by: string }).by, color: "yellow" } } : events[i]! }));
      }
    }
    const sport = "football";
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `league|${sport}|${variant}|RT-PART`, row: "league", sport, variant, scenario: "RT-PART", canary: false };
    const out = await SCENARIOS["RT-PART"].run({ driver: new StoresACard(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const c = out.assertions.find((x) => x.id === "w2b-retirement-credit")!;
    expect(c.verdict).toBe("fail");
    expect(c.checked).toBeGreaterThan(0);
    expect(c.reason).toMatch(/scoresheet so far — football\.card is not in its vocabulary/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Review I-6: WD-CASC driven end to end. WD-CASC through the scenario on the single-elimination fake, which plays loop F's cascade (withdrawal.ts, stages.ts
// resolveBracketSeats): a TBD seat dies and the arriving opponent walks over by bye; a dead seat beside a RECORDED double
// walkover is a void (Review Focus 1), and the seat that void feeds walks its opponent over.
describe("WD-CASC end to end on the single-elimination fake (review I-6, re-pinned to loop F's cascade)", () => {
  it("every sport: the WD-CASC checks pass on counted items in both final halves (crowned; vacant, W4's), nothing is left open by rule, and no check fails", async () => {
    const cells = w2bCells("WD-CASC");
    expect(cells.map((c) => c.sport).sort()).toEqual([...SPORT_KEYS].sort());
    const failures: string[] = [];
    let judged = 0;
    const halves = { crowned: 0, vacant: 0 };
    const I2 = INVARIANTS.find((x) => x.id === "I2-bracket-one-champion-ranks-permutation")!;
    let i2Passed = 0;
    for (const { row, sport } of cells) {
      const variant = variantFor(sport);
      const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|WD-CASC`, row, sport, variant, scenario: "WD-CASC", canary: false };
      const out = await SCENARIOS["WD-CASC"].run({ driver: new FakeKnockoutDriver({ singleElim: true }), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
      for (const c of out.assertions) if (c.verdict === "fail") failures.push(`${sport} ${c.id}: ${c.reason}`);
      const half = wdCascFinalHalf(row, sport);
      halves[half]++;
      // Per half, from the choreography: the two walkovers (QF2, QF3) and its withdrawals (w1, QF2's home, QF3's home,
      // a3, and the vacant half's a2); SF1's bye, each departed entrant seated nowhere after, no void but the owed ones;
      // the double walkover and SF2's void, plus the crowned final's bye and crown; the vacant final's void and crown.
      const want: Record<string, number> = half === "crowned"
        ? { "w2b-withdrawal-walks-over": 2 + 4, "w2b-withdrawal-tbd-seat": 1 + 2 + 1, "w2b-withdrawal-both-seats-dead": 2 + 2 }
        : { "w2b-withdrawal-walks-over": 2 + 5, "w2b-withdrawal-tbd-seat": 1 + 3 + 1, "w2b-withdrawal-both-seats-dead": 2, "w2b-withdrawal-final-vacant": 2 };
      for (const [id, n] of Object.entries(want)) {
        const c = out.assertions.find((x) => x.id === id);
        expect(c, `${sport} ${id}`).toBeDefined();
        expect(c!.checked, `${sport} ${id}`).toBe(n);
        judged += c!.checked;
      }
      expect(out.assertions.some((x) => x.id === "w2b-withdrawal-final-vacant"), `${sport}: the final-vacant check runs in the vacant half only`).toBe(half === "vacant");
      expect(out.assertions.find((c) => c.id === "life-loop-bounded")?.verdict, sport).toBe("pass");
      expect(out.notes.filter((n) => n.includes("(exempt)")), sport).toEqual([]);
      // Ruling R16-5, through the real snapshot: the run carries the departures the fake STORES (its entrants' status)
      // — the choreography's four (w1, QF2's home, QF3's home, a3), and the vacant half's a2 — and I2 counts them
      // eliminated. The crowned half's champion is then the one unbeaten; the vacant half has none (its title is W4's).
      // The fake ranks the whole field, as the product's bracketRanks does (T16 review m8), so I2 is judged whole.
      expect(out.observed.departed?.length, `${sport}: departed`).toBe(half === "crowned" ? 4 : 5);
      const i2 = evaluateInvariant(I2, out.observed);
      if (half === "crowned") {
        // w1 and a3 won a match before withdrawing; QF2's and QF3's home sides lost theirs by walkover.
        expect(i2, `${sport}: I2`).toMatchObject({ verdict: "pass", checked: 9, evidence: [expect.stringMatching(/^2 departed entrant\(s\) counted eliminated \(stored status\): /)] });
        i2Passed++;
      } else {
        expect(i2.verdict, `${sport}: I2`).toBe("fail");
        expect(i2.evidence.filter((e) => /unbeaten|rank 1|not ranked/.test(e)), sport).toEqual(["0 unbeaten entrants: "]);
      }
    }
    expect(i2Passed, "I2 judged the crowned half").toBe(halves.crowned);
    expect(failures).toEqual([]);
    expect(halves.crowned, "the crowned half ran").toBeGreaterThan(0);
    expect(halves.vacant, "the vacant half ran").toBeGreaterThan(0);
    expect(halves.crowned + halves.vacant).toBe(cells.length);
    expect(judged).toBe(halves.crowned * (6 + 4 + 4) + halves.vacant * (7 + 5 + 2 + 2));
  });
});

/** The multi-stage fake's two bracket rows after a group (catalogue.ts): a knockout, and a page playoff (X-WD-2 puts
 *  it on the bracket path, withdrawal.ts WITHDRAWAL_WALKOVER_KINDS). */
const MS_ROWS: readonly (readonly [RowKey, string])[] = [["groups_ko", "knockout"], ["group_playoffs", "page_playoff"]];

// ---------------------------------------------------------------------------------------------------------------
// Post-F re-checks 2–5: loop F's bracket withdrawal (withdrawal.ts) and seat resolver (stages.ts resolveBracketSeats),
// read from the product where a fake mirrors them, and the single-elimination fake played through each state the
// cascade distinguishes. Expected values come from the plan's rows (C-2's three former holds, C-5's bye, D17, X-WD-1..4,
// X-DW-2, Review Focus 1, the plan's N1's walked_over_held), never from the fake.
describe("loop F's bracket cascade, read from the product, and the single-elimination fake playing it (post-F re-checks 2–5)", () => {
  const WITHDRAWAL_TS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/web/src/server/usecases/withdrawal.ts");
  it("the product's bracket withdrawal walks scheduled, in_play and needs_decision lines over, and an abandoned one only while its abandon is active (C-2); a changed shape is refused by name", () => {
    const got = bracketWithdrawalText();
    expect([...got.pending].sort()).toEqual(["in_play", "needs_decision", "scheduled"]);
    expect(got.ifAbandonActive).toEqual(["abandoned"]);
    const text = readFileSync(WITHDRAWAL_TS, "utf8");
    const refusals: [string, string, readonly string[], RegExp][] = [
      ["no function", "", ["scheduled"], /bracketWithdrawalStatus not found/],
      ["PENDING not read", text.replace('  if (PENDING.has(status)) return "scheduled";', ""), ["scheduled"], /no longer reads PENDING/],
      ["an empty table set", text, [], /pending set is empty/],
    ];
    for (const [name, t, p, why] of refusals) expect(() => bracketWithdrawalFrom(t, p), name).toThrow(why);
    expect(refusals.length).toBe(3);
  });

  async function knockout(sport: string, n: number) {
    const variant = variantFor(sport);
    const d = new FakeKnockoutDriver({ singleElim: true });
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|WD-CASC`, row: "knockout", sport, variant, scenario: "WD-CASC", canary: false };
    const ctx = { driver: d, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
    await setUpDivision(ctx, new Recorder(), n);
    const cfg = caseStageCfg(ctx, "knockout"); // WD-CASC posts its knockout with every decider off (R-T12-3)
    const row = (id: string) => d.fixtures.find((f) => f.id === id)!;
    const r1 = d.fixtures.filter((f) => f.round_no === 1);
    const win = (id: string, winner: "home" | "away" = "home") => {
      const f = row(id);
      return d.postStream(id, generateStream({ sportKey: sport, cfg, stageKind: "knockout", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome: { kind: "win", winner } }));
    };
    const next = (id: string) => d.feeds.get(id)!;
    const seatOf = (id: string) => { const n2 = next(id); return row(n2.to)[n2.slot]; };
    return { d, cfg, row, r1, win, next, seatOf };
  }
  const bye = (winner: string) => ({ kind: "award", winner, loser: null, reason: "bye" });

  it("each state the cascade walks over (X-WD-1, R14, D-G2): a held line and a chess tie-break owed count in walked_over_held, an abandoned line has its abandon voided first and counts, play under way does not count", async () => {
    const cases: { sport: string; build: (cfg: unknown, home: string, away: string) => { label: string; events: StreamEvent[] }; status: string; held: number }[] = [
      { sport: "football", build: (cfg, h, a) => heldStream("football", cfg, h, a), status: "needs_decision", held: 1 },
      { sport: "boardgame", build: (cfg, h, a) => heldStream("boardgame", cfg, h, a), status: "in_play", held: 1 },
      { sport: "generic", build: (cfg, h, a) => ({ label: "abandoned", events: generateStream({ sportKey: "generic", cfg, stageKind: "knockout", home: h, away: a, outcome: { kind: "abandon" } }) }), status: "abandoned", held: 1 },
      { sport: "generic", build: (cfg, h, a) => heldStream("generic", cfg, h, a), status: "in_play", held: 0 },
    ];
    const labels: string[] = [];
    for (const c of cases) {
      const { d, cfg, row, r1 } = await knockout(c.sport, 4);
      const f = r1[0]!;
      const [home, away] = [f.home_entrant_id!, f.away_entrant_id!];
      const s = c.build(cfg, home, away);
      labels.push(s.label);
      await d.postStream(f.id, s.events);
      expect(row(f.id).status, `${c.sport} ${s.label}: premise`).toBe(c.status);
      const before = row(f.id).events.length;
      const out = await d.withdraw(home);
      expect(out, `${c.sport} ${s.label}`).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0, walked_over_held: c.held });
      expect(row(f.id), `${c.sport} ${s.label}`).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: away, loser: home, reason: WITHDREW } });
      const written = row(f.id).events.slice(before).map((e) => e.type);
      expect(written, `${c.sport} ${s.label}: the cascade's writes`).toEqual(c.status === "abandoned" ? ["core.void", "core.forfeit"] : ["core.forfeit"]);
    }
    expect(labels).toEqual(["held", "tie-break pending", "abandoned", "in play"]);
  });

  it("X-WD-3 (D17): a withdrawal whose opponent is TBD empties her seat and counts as a walkover; the opponent who arrives walks over HER (ruling 116: loser her, reason withdrew), and she ranks last", async () => {
    const { d, row, r1, win, next, seatOf } = await knockout("generic", 4);
    const sf1 = r1[0]!;
    const sf2 = r1[1]!;
    await win(sf1.id);
    const w = sf1.home_entrant_id!;
    expect(seatOf(sf1.id), "premise: the winner went on").toBe(w);
    expect(await d.withdraw(w)).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0, walked_over_held: 0 });
    expect(seatOf(sf1.id), "her seat is empty").toBeNull();
    await win(sf2.id, "away");
    expect(row(next(sf1.id).to)).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: sf2.away_entrant_id!, loser: w, reason: "withdrew" } });
    expect(seatOf(sf1.id), "she is never seated (X-WD-3)").toBeNull();
    const done = await d.completeStage();
    expect(done.completed).toBe(true);
    const ranks = (done.events[0] as { finalRanks: string[] }).finalRanks;
    expect(ranks[0], "the walkover's winner holds the title").toBe(sf2.away_entrant_id);
    // The product's ranks (withdrawn-winner-walkover.test.ts): she is no loser of a tie she never sat in, so she ranks
    // below every field entrant, as a departed entrant always has — never the walked-over final's runner-up.
    expect([ranks.length, ranks.indexOf(w)], "she ranks last of four").toEqual([4, 3]);
  });

  it("Review Focus 1: a dead seat beside a RECORDED double walkover is a void (nobody withdrew from it), and the seat that void feeds walks its opponent over", async () => {
    const { d, row, r1, win, next } = await knockout("generic", 8);
    const [qf1, qf2, qf3, qf4] = [r1[0]!, r1[1]!, r1[2]!, r1[3]!];
    expect(next(qf1.id).to, "rig: QF1 and QF2 feed one semi").toBe(next(qf2.id).to);
    await win(qf1.id);
    await d.withdraw(qf1.home_entrant_id!);
    await d.postStream(qf2.id, [{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }]);
    const sf1 = row(next(qf1.id).to);
    expect([sf1.status, sf1.outcome, sf1.home_entrant_id, sf1.away_entrant_id], "a void").toEqual(["abandoned", null, null, null]);
    expect(sf1.events, "written with no event").toEqual([]);
    await win(qf3.id);
    await win(qf4.id);
    const sf2 = row(next(qf3.id).to);
    await win(sf2.id);
    expect(row(next(sf1.id).to)).toMatchObject({ status: "forfeited", outcome: bye(sf2.home_entrant_id!) });
  });

  it("X-WD-4: both sides of a line withdrawn is a departure double walkover (no event, both seats kept); the seat it feeds dies by departure, and its opponent walks over; a final both of whose sides departed stays open, written nothing", async () => {
    // single-sport: the cascade's shapes read seats and statuses, never the sport. The first withdrawal is rigged on the
    // entrant row, as F's own test flips the division back before Start (withdrawal-w2b.test.ts withdrawBeforeStart).
    const rigGone = (d: FakeKnockoutDriver, id: string) => { d.entrants.find((e) => e.id === id)!.status = "withdrawn"; };
    let checked = 0;
    {
      const { d, row, r1, win, next } = await knockout("generic", 4);
      const sf1 = r1[0]!;
    const sf2 = r1[1]!;
      await win(sf2.id);
      rigGone(d, sf1.home_entrant_id!);
      expect(await d.withdraw(sf1.away_entrant_id!)).toMatchObject({ walkovers: 1, voided: 0, walked_over_held: 0 });
      expect(row(sf1.id)).toMatchObject({ status: "forfeited", outcome: { kind: "double_walkover" }, home_entrant_id: sf1.home_entrant_id, away_entrant_id: sf1.away_entrant_id, events: [] });
      expect(row(next(sf1.id).to)).toMatchObject({ status: "forfeited", outcome: bye(sf2.home_entrant_id!) });
      checked++;
    }
    {
      const { d, row, r1, next } = await knockout("generic", 4);
      for (const sf of r1) { rigGone(d, sf.home_entrant_id!); await d.withdraw(sf.away_entrant_id!); }
      for (const sf of r1) expect(row(sf.id).outcome, sf.id).toEqual({ kind: "double_walkover" });
      const fin = row(next(r1[0]!.id).to);
      expect([fin.status, fin.outcome, fin.home_entrant_id, fin.away_entrant_id, fin.events], "every finalist-to-be departed: open").toEqual(["scheduled", null, null, null, []]);
      expect((await d.completeStage()).completed, "nobody holds the title").toBe(false);
      checked++;
    }
    {
      const { d, row, r1 } = await knockout("generic", 2);
      const fin = r1[0]!;
      rigGone(d, fin.home_entrant_id!);
      expect(await d.withdraw(fin.away_entrant_id!)).toMatchObject({ walkovers: 0, voided: 0 });
      expect(row(fin.id)).toMatchObject({ status: "scheduled", outcome: null, home_entrant_id: fin.home_entrant_id, away_entrant_id: fin.away_entrant_id, events: [] });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the ladder fake (loop F: a ladder takes the bracket path): a challenge under an ACTIVE abandon has the abandon voided, walks over to the opponent, and counts held", async () => {
    // single-sport: the planner reads statuses and the ledger's abandons, never the sport.
    const d = new FakeLadderDriver();
    const spec: CaseSpec = { caseId: "ladder|generic|x|WD-CASC", row: "ladder", sport: "generic", variant: variantFor("generic"), scenario: "WD-CASC", canary: false };
    const ctx = { driver: d, spec, orgSlug: "o", cfg: resolveSportCfg("generic", variantFor("generic")), tag: "t", denied: [] };
    const setup = await setUpDivision(ctx, new Recorder(), 4);
    const [top, second] = [setup.idOfSeed(1), setup.idOfSeed(2)];
    const { fixture_id: id } = await d.challenge(setup.stage.id, second, top);
    await d.postStream(id, generateStream({ sportKey: "generic", cfg: stageCfg("generic", ctx.cfg, "ladder", ctx.spec.variant), stageKind: "ladder", home: second, away: top, outcome: { kind: "abandon" } }));
    const f = () => d.fixtures.find((x) => x.id === id)!;
    expect(f().status, "premise").toBe("abandoned");
    expect(await d.withdraw(second)).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0, walked_over_held: 1 });
    expect(f()).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: top, loser: second, reason: WITHDREW } });
    expect(f().events.map((e) => e.type).slice(-2), "the cascade's writes").toEqual(["core.void", "core.forfeit"]);
  });

  it("the multi-stage fake, groups then a knockout or a page playoff: a withdrawal whose next opponent is TBD empties her seat and counts a walkover, never a void; the arrival walks over by bye (C-5)", async () => {
    // single-sport: the seat rule reads seats and statuses, never the sport.
    let checked = 0;
    for (const [row, later] of MS_ROWS) {
      let answer: WithdrawOut | null = null;
      let left: { fixture: string; side: "home_entrant_id" | "away_entrant_id"; who: string } | null = null;
      class WithdrawsAWinner extends FakeMultiStageDriver {
        override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
          const out = await super.postStream(id, events, prefix);
          const f = this.fixtures.find((x) => x.id === id)!;
          const kind = this.stages.find((s) => s.id === f.stage_id)?.kind;
          const w = (f.outcome as { winner?: unknown } | null)?.winner;
          const to = this.feeds.get(id);
          if (answer === null && kind === later && typeof w === "string" && to !== undefined) {
            const next = this.fixtures.find((x) => x.id === to.to)!;
            const side = to.side === "home" ? "home_entrant_id" : "away_entrant_id";
            const other = to.side === "home" ? "away_entrant_id" : "home_entrant_id";
            if (next[side] === w && next[other] === null) {
              left = { fixture: next.id, side, who: w };
              answer = await this.withdraw(w);
            }
          }
          return out;
        }
      }
      const d = new WithdrawsAWinner();
      const variant = variantFor("generic");
      const spec: CaseSpec = { caseId: `${row}|generic|${variant}|LIFECYCLE`, row, sport: "generic", variant, scenario: "LIFECYCLE", canary: false };
      await SCENARIOS.LIFECYCLE.run({ driver: d, spec, orgSlug: "o", cfg: resolveSportCfg("generic", variant), tag: "t", denied: [] });
      expect(d.stages.map((s) => s.kind), `${row}: premise`).toContain(later);
      expect(left, `${row}: premise — a ${later} winner went on to a TBD seat`).not.toBeNull();
      expect(answer, row).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0, walked_over_held: 0 });
      const next = d.fixtures.find((x) => x.id === left!.fixture)!;
      expect(next[left!.side], `${row}: her seat is emptied`).not.toBe(left!.who);
      const arrival = next[left!.side === "home_entrant_id" ? "away_entrant_id" : "home_entrant_id"];
      expect([next.status, next.outcome], `${row}: the arrival walks over by bye`).toEqual(["forfeited", { kind: "award", winner: arrival, loser: null, reason: "bye" }]);
      const stage = d.stages.find((s) => s.kind === later)!;
      expect(d.fixtures.filter((x) => x.stage_id === stage.id && x.status === "abandoned").map((x) => x.id), `${row}: nothing voided (X-WD-2)`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(MS_ROWS.length);
  });

  it("the multi-stage fake, groups then a knockout or a page playoff: a line HELD (a level result, needs_decision) when its side withdraws walks over to the opponent and counts held (C-2, X-WD-1, X-WD-2)", async () => {
    // single-sport: football is the sport whose bracket lines hold a level result for the organiser's settle.
    let checked = 0;
    for (const [row, later] of MS_ROWS) {
      let answer: WithdrawOut | null = null;
      let held: { id: string; home: string; away: string } | null = null;
      class WithdrawsAHeldSide extends FakeMultiStageDriver {
        override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
          // The harness posts a held line and its settle together: post up to the settle, withdraw while it is held,
          // and let the settle meet the walked-over fixture.
          const at = events.findIndex((e) => e.type === "core.settle");
          if (answer !== null || at <= 0) return super.postStream(id, events, prefix);
          const out = await super.postStream(id, events.slice(0, at), prefix);
          const f = this.fixtures.find((x) => x.id === id)!;
          if (f.status !== "needs_decision" || f.home_entrant_id === null || f.away_entrant_id === null) return [...out, ...(await super.postStream(id, events.slice(at), prefix))];
          held = { id, home: f.home_entrant_id, away: f.away_entrant_id };
          answer = await this.withdraw(f.home_entrant_id);
          return out;
        }
      }
      const d = new WithdrawsAHeldSide();
      const variant = variantFor("football");
      // LIFECYCLE's choreography on a case labelled WD-CASC, a hold-path scenario (R-T12-3): its later bracket stage is
      // posted with every decider off, so a level result there is HELD (the line this test withdraws a side from).
      const spec: CaseSpec = { caseId: `${row}|football|${variant}|WD-CASC`, row, sport: "football", variant, scenario: "WD-CASC", canary: false };
      // The harness's own settle of that line then meets a decided fixture; how the run judges that is not this test's.
      await SCENARIOS.LIFECYCLE.run({ driver: d, spec, orgSlug: "o", cfg: resolveSportCfg("football", variant), tag: "t", denied: [] }).catch((e: unknown) => {
        if (!(e instanceof RefusedCall)) throw e;
      });
      expect(held, `${row}: premise — a ${later} line was held`).not.toBeNull();
      const f = d.fixtures.find((x) => x.id === held!.id)!;
      expect(d.stages.find((s) => s.id === f.stage_id)?.kind, `${row}: premise`).toBe(later);
      expect(answer, row).toMatchObject({ walkovers: 1, voided: 0, walked_over_held: 1 });
      expect([f.status, f.outcome], `${row}: walked over to the remaining side`).toEqual(["forfeited", { kind: "award", winner: held!.away, loser: held!.home, reason: WITHDREW }]);
      checked++;
    }
    expect(checked).toBe(MS_ROWS.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Owner rulings 53 + 106 (loop F, withdrawal.ts's bracket branch; 106 extends 53 to every bracket kind): a withdrawal
// on any bracket kind, a ladder or a page_playoff that leaves nothing pending answers policy `none`; one pending line
// answers `walkover`. Every fake reads the product's policy line (product-text.ts) rather than typing it. Expected values
// are the rulings', never the fake's.
describe("rulings 53 + 106: a bracket-path withdrawal with nothing pending answers policy none, one pending line walkover — the product's line, and every fake", () => {
  const WITHDRAWAL_TS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/web/src/server/usecases/withdrawal.ts");
  const RULED = 'if (out.policy === "none" && result.updates.length > 0) out.policy = "walkover";';
  const BEFORE_RULING = 'if (out.policy === "none") out.policy = "walkover";';
  it("the product's bracket branch moves a none policy only when its planner acted (rulings 53 + 106); the line before the ruling reads in-stage; a changed shape is refused by name", () => {
    expect(bracketWithdrawalPolicyText()).toBe("acted");
    const text = readFileSync(WITHDRAWAL_TS, "utf8");
    expect(text.split(RULED).length - 1, "premise: the ruled line, once").toBe(1);
    expect(bracketWithdrawalPolicyFrom(text.replace(RULED, BEFORE_RULING))).toBe("in-stage");
    const refusals: [string, string, RegExp][] = [
      ["no bracket branch", text.replace("} else if (WITHDRAWAL_WALKOVER_KINDS.has(stage.kind)) {", "} else if (BRACKETS.has(stage.kind)) {"), /no WITHDRAWAL_WALKOVER_KINDS branch/],
      ["neither shape", text.replace(RULED, 'out.policy = "walkover";'), /in no shape this reader knows/],
      ["both shapes", text.replace(RULED, `${RULED}\n        ${BEFORE_RULING}`), /in both shapes/],
    ];
    for (const [name, t, why] of refusals) expect(() => bracketWithdrawalPolicyFrom(t), name).toThrow(why);
    expect(refusals.length).toBe(3);
  });

  it("bracketWithdrawalPolicy: a policy an earlier stage set stands; a none moves to walkover only when the planner acted on a line", () => {
    // [prior, the entrant's fixtures in the stage, the ones the planner acts on, the answer]: rulings 53 + 106's rows, and the
    // product's stage loop (a table stage before the bracket answers first).
    const rows: [WithdrawOut["policy"], number, number, WithdrawOut["policy"]][] = [
      ["none", 2, 0, "none"], ["none", 0, 0, "none"], ["none", 2, 1, "walkover"],
      ["walkover", 1, 0, "walkover"], ["expunge", 1, 0, "expunge"], ["expunge", 1, 1, "expunge"],
    ];
    for (const [prior, inStage, acted, want] of rows) expect(bracketWithdrawalPolicy(prior, inStage, acted), `${prior} ${inStage} ${acted}`).toBe(want);
    expect(rows.length).toBe(6);
  });

  /** The knockout fake in one of its bracket modes, set up and started on `row`'s field. */
  async function bracketFake(make: () => FakeKnockoutDriver, row: RowKey) {
    const d = make();
    const sport = "generic";
    const variant = variantFor(sport);
    const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|LIFECYCLE`, row, sport, variant, scenario: "LIFECYCLE", canary: false };
    const ctx = { driver: d, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
    await setUpDivision(ctx, new Recorder(), fieldSizeFor(row, "LIFECYCLE"));
    const kind = d.bracketKind as StageKind;
    return { d, cfg: stageCfg(sport, ctx.cfg, kind, ctx.spec.variant), kind };
  }
  const mineOf = (d: FakeLeagueDriver, id: string) => d.fixtures.filter((f) => f.home_entrant_id === id || f.away_entrant_id === id);
  const acting = (d: FakeLeagueDriver, id: string) => mineOf(d, id).filter((f) => bracketWithdrawalActs(f.status, d.abandonActive(f))).length;
  const MODES: readonly (readonly [string, () => FakeKnockoutDriver, RowKey])[] = [
    ["single elimination (loop F's cascade)", () => new FakeKnockoutDriver({ singleElim: true }), "knockout"],
    ["a plain knockout (the league's cascade)", () => new FakeKnockoutDriver(), "knockout"],
    ["a stepladder", () => new FakeKnockoutDriver({ stepladder: true }), "stepladder_only"],
    ["a page playoff", () => new FakeKnockoutDriver({ pagePlayoff: true }), "page_playoff_only"],
  ];
  it("the knockout fake, every bracket mode: a round-one loser who feeds nowhere answers none (walkovers 0); a side of an open line answers walkover (walkovers 1)", async () => {
    // single-sport: the policy reads statuses and seats, never the sport.
    let checked = 0;
    for (const [mode, make, row] of MODES) {
      const { d, cfg, kind } = await bracketFake(make, row);
      const open = d.fixtures.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && bracketWithdrawalActs(f.status, false));
      const out = open.find((f) => !d.loserFeeds.has(f.id));
      expect(out, `${mode}: premise — a seated line whose loser feeds nowhere`).toBeDefined();
      await d.postStream(out!.id, generateStream({ sportKey: "generic", cfg, stageKind: kind, home: out!.home_entrant_id!, away: out!.away_entrant_id!, outcome: { kind: "win", winner: "home" } }));
      const loser = out!.away_entrant_id!;
      expect([mineOf(d, loser).length, acting(d, loser)], `${mode}: premise — the loser holds a fixture, nothing pending`).toEqual([1, 0]);
      expect(await d.withdraw(loser), `${mode}: nothing pending`).toMatchObject({ policy: "none", walkovers: 0, voided: 0 });
      const next = d.fixtures.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.home_entrant_id !== loser && f.away_entrant_id !== loser && bracketWithdrawalActs(f.status, false));
      expect(next, `${mode}: premise — another seated open line`).toBeDefined();
      const side = next!.home_entrant_id!;
      expect(acting(d, side), `${mode}: premise — one line pending`).toBe(1);
      expect(await d.withdraw(side), `${mode}: one pending`).toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
      checked++;
    }
    expect(checked).toBe(MODES.length);
  });

  it("the ladder fake (a ladder takes the bracket branch): a side whose challenge is decided answers none; a side of a pending challenge answers walkover", async () => {
    // single-sport: the policy reads statuses and seats, never the sport.
    const d = new FakeLadderDriver();
    const spec: CaseSpec = { caseId: "ladder|generic|x|R4", row: "ladder", sport: "generic", variant: variantFor("generic"), scenario: "R4", canary: false };
    const ctx = { driver: d, spec, orgSlug: "o", cfg: resolveSportCfg("generic", variantFor("generic")), tag: "t", denied: [] };
    const setup = await setUpDivision(ctx, new Recorder(), 4);
    const cfg = stageCfg("generic", ctx.cfg, "ladder", ctx.spec.variant);
    const [s1, s2, s3, s4] = [setup.idOfSeed(1), setup.idOfSeed(2), setup.idOfSeed(3), setup.idOfSeed(4)];
    const { fixture_id: first } = await d.challenge(setup.stage.id, s2, s1);
    await d.postStream(first, generateStream({ sportKey: "generic", cfg, stageKind: "ladder", home: s2, away: s1, outcome: { kind: "win", winner: "away" } }));
    expect([mineOf(d, s2).length, acting(d, s2)], "premise: s2 holds a decided challenge, nothing pending").toEqual([1, 0]);
    expect(await d.withdraw(s2), "nothing pending").toMatchObject({ policy: "none", walkovers: 0, voided: 0 });
    await d.challenge(setup.stage.id, s4, s3);
    expect(acting(d, s4), "premise: one challenge pending").toBe(1);
    expect(await d.withdraw(s4), "one pending").toMatchObject({ policy: "walkover", walkovers: 1, voided: 0 });
  });

  it("the multi-stage fake (formats), groups then a knockout or a page playoff: a bracket loser with nothing pending answers the GROUP stage's walkover — the bracket branch moves only a none, and a table stage always names a policy", async () => {
    // single-sport: the policy reads statuses and seats, never the sport. Every bracket entrant played its group, so the
    // table branch (stage.ts withdrawTableEntrant: played ≥ half walks over) answers first; rulings 53 + 106's none needs a
    // withdrawal with no table fixture, which a group-first format never has (bracketWithdrawalPolicy's own rows above).
    let checked = 0;
    for (const [row, later] of MS_ROWS) {
      let answer: WithdrawOut | null = null;
      let premise: [number, number] | null = null;
      class WithdrawsALoser extends FakeMultiStageDriver {
        override async postStream(id: string, events: readonly StreamEvent[], prefix = "") {
          const out = await super.postStream(id, events, prefix);
          const f = this.fixtures.find((x) => x.id === id)!;
          const kind = this.stages.find((s) => s.id === f.stage_id)?.kind;
          const o = f.outcome as { winner?: unknown; loser?: unknown } | null;
          if (answer === null && kind === later && typeof o?.loser === "string" && !this.loserFeeds.has(id)) {
            const inStage = this.fixtures.filter((x) => x.stage_id === f.stage_id && (x.home_entrant_id === o.loser || x.away_entrant_id === o.loser));
            premise = [inStage.length, inStage.filter((x) => bracketWithdrawalActs(x.status, this.abandonActive(x))).length];
            answer = await this.withdraw(o.loser);
          }
          return out;
        }
      }
      const d = new WithdrawsALoser();
      const variant = variantFor("generic");
      const spec: CaseSpec = { caseId: `${row}|generic|${variant}|LIFECYCLE`, row, sport: "generic", variant, scenario: "LIFECYCLE", canary: false };
      await SCENARIOS.LIFECYCLE.run({ driver: d, spec, orgSlug: "o", cfg: resolveSportCfg("generic", variant), tag: "t", denied: [] }).catch((e: unknown) => {
        if (!(e instanceof RefusedCall)) throw e;
      });
      expect(premise, `${row}: premise — a ${later} loser who feeds nowhere withdrew, holding a ${later} fixture and nothing pending`).toEqual([1, 0]);
      expect(answer, row).toMatchObject({ policy: "walkover", walkovers: 0, voided: 0 });
      checked++;
    }
    expect(checked).toBe(MS_ROWS.length);
  });
});
