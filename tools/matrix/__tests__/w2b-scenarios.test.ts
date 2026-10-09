// W2b Task 2 Step 4: the five opt-in forfeit-credit scenarios (WO-PRE, RT-PART, DW-ALL, AB-AWARD, WD-CASC), their
// derived cells, their pure checks, the bracket feed graph they reason on, and the interim walkover-credit oracle.
// Expected values come from Appendix A's rows (X-RS-1, X-WO-1, X-RT-1, X-DW-1..4, X-AB-1/2, X-WD-1..4, the per-sport
// *-WO-1 / *-AB-* rows), the engine's own declarations (BRACKET_STAGE_KINDS, the bracket generators' feed edges and
// isFinal/thirdPlace/conditional flags, the sports' standingsDelta metric keys) and hand-written cfgs — never from the
// scenarios' text or the oracle's own table.
import { BRACKET_STAGE_KINDS } from "@seazn/engine/competition";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import type { FixtureRow, StandingsRowWire, WithdrawOut } from "../lib/driver/types.ts";
import { foldStream } from "../lib/fold.ts";
import type { ObservedFixture, ObservedOutcome } from "../lib/observed.ts";
import { CREDIT_SPORTS, CreditNotCovered, walkoverCredit } from "../lib/reference-walkover.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { BRACKET_OF } from "../lib/scenarios/terminal-finals.ts";
import { W2B_SCENARIO_KEYS, type CaseSpec } from "../lib/scenarios/types.ts";
import {
  DW_NO_NEXT, FeedGraphUnresolved, NO_PLACEMENT, WITHDREW, deadSeats, doubleWalkoverAdvancesNobody, doubleWalkoverRecorded, doubleWalkoverRefusedAtTheEnd, feedGraph, forfeitRecorded,
  hasNoNextMatch, isolatedTable, ladderUnmoved, partialPlayStands, pickDoubleWalkover, wireGraph, type FeedGraph, type ForfeitDrive, type LocalDelta, type RefusalProbe,
} from "../lib/scenarios/w2b-checks.ts";
import {
  W2B_SCENARIOS, W2bMisplanned, abandonPlan, abandonWithResult, bothSeatsDead, goalLead, heldStream, knockoutLines, tableJudged, tbdSeatWalksOver, withdrawalsWalkOver,
} from "../lib/scenarios/w2b-forfeit-credit.ts";
import { SCENARIO_KEYS, planSliceCases } from "../lib/slice.ts";
import { resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { AWARD_POLICY, DLS_ON, bracketRootRow, minOversRule, knockoutRootRow, rootKindRows, tableRootRow, thirdPlaceRows, w2bApplies, w2bCells } from "../lib/w2b-cells.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

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

  it("advances nobody: neither entrant seated again, a one-dead-seat fixture walked over to its live side, a two-dead-seat one a double walkover", () => {
    const fixtures = [
      fx("q1", "a", "b", "forfeited", { kind: "double_walkover" }),
      fx("s1", null, "c", "forfeited", { kind: "award", winner: "c", loser: null, reason: "walkover" }, { extKey: "S1" }),
      fx("z", null, null, "forfeited", { kind: "double_walkover" }, { extKey: "Z" }),
    ];
    const dead = new Map([["S1", 1], ["Z", 2]]);
    expect(doubleWalkoverAdvancesNobody(dw, fixtures, dead)).toMatchObject({ verdict: "pass", checked: 3 });
    expect(doubleWalkoverAdvancesNobody(dw, [...fixtures, fx("lb", "a", null, "scheduled", null)], dead).verdict, "a seated again").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(dw, [fixtures[0]!, { ...fixtures[1]!, status: "scheduled", outcome: null }, fixtures[2]!], dead).verdict, "S1 left open").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(dw, [fixtures[0]!, fixtures[1]!, { ...fixtures[2]!, outcome: { kind: "award", winner: "x", loser: null, reason: "walkover" } }], dead).verdict, "Z walked over").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(dw, fixtures, new Map([...dead, ["MISSING", 1]])).verdict, "a fed seat not in the stage").toBe("fail");
    expect(doubleWalkoverAdvancesNobody(null, fixtures, dead)).toMatchObject({ verdict: "fail", checked: 1 });
    expect(doubleWalkoverAdvancesNobody({ ...dw, refusal: { status: 422, code: null } }, fixtures, dead).verdict).toBe("fail");
  });

  it("a ladder's order is unmoved by a double walkover", () => {
    expect(ladderUnmoved(["a", "b", "c"], ["a", "b", "c"])).toMatchObject({ verdict: "pass", checked: 1 });
    expect(ladderUnmoved(["a", "b", "c"], ["b", "a", "c"]).verdict).toBe("fail");
    expect(ladderUnmoved(null, ["a"]).verdict).toBe("fail");
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
];

describe("feedGraph: the engine's wiring, trusted only on the stage the product stored", () => {
  it("the fixtures with no next match are the final and the third-place match, or the reset where a grand final can be replayed (X-DW-3, D19) — per shape", () => {
    let checked = 0;
    for (const s of SHAPES) {
      const { gen, graph } = bracket(s.kind, s.field, s.config);
      const reset = gen.fixtures.some((g) => g.conditional === true);
      const want = gen.fixtures.filter((g) => (reset ? g.conditional === true : g.isFinal === true) || g.thirdPlace === true).map((g) => g.id);
      expect(graph.keys.filter((k) => hasNoNextMatch(graph, k)), s.name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  });

  it("refuses a stage whose stored keys are not the engine's, and a size the engine cannot lay out, by name", () => {
    const { rows } = bracket("knockout", F8);
    expect(() => feedGraph("knockout", {}, F8, rows.slice(1))).toThrow(FeedGraphUnresolved);
    expect(() => feedGraph("knockout", {}, F8, rows.map((r, i) => (i === 0 ? { ...r, ext_key: "other" } : r)))).toThrow(FeedGraphUnresolved);
    expect(() => feedGraph("page_playoff", {}, F8, rows)).toThrow(/lays out no page_playoff/);
    expect(() => feedGraph("league", {}, F8, rows)).toThrow(/no bracket generator/);
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
      const cfg = stageCfg(sport, resolveSportCfg(sport, variantFor(sport)), "knockout");
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
    const d = (kind: "leading" | "level" | "past_min_overs" | "before_min_overs", events: StreamEvent[] = []) => ({ fixtureId: "f", home: "a", away: "b", kind, events });
    const at = (status: string, outcome: ObservedOutcome | null) => [fx("f", "a", "b", status, outcome)];
    expect(abandonWithResult([d("leading", goals("a"))], at("decided", { kind: "win", winner: "a", method: "abandoned" }))).toMatchObject({ verdict: "pass", checked: 1 });
    expect(abandonWithResult([d("leading", goals("a"))], at("decided", { kind: "win", winner: "b", method: "abandoned" })).verdict).toBe("fail");
    expect(abandonWithResult([d("leading", goals("a"))], at("decided", { kind: "win", winner: "a" })).verdict).toBe("fail");
    expect(abandonWithResult([d("leading", goals("a"))], at("abandoned", null)).verdict).toBe("fail");
    expect(abandonWithResult([d("leading", goals("a", "b"))], at("decided", { kind: "win", winner: "a", method: "abandoned" })).verdict, "no leader posted").toBe("fail");
    expect(abandonWithResult([d("level", goals("a", "b"))], at("decided", { kind: "draw" }))).toMatchObject({ verdict: "pass" });
    expect(abandonWithResult([d("level", goals("a", "b"))], at("abandoned", null)).verdict).toBe("fail");
    expect(abandonWithResult([d("past_min_overs")], at("decided", { kind: "win", winner: "b", method: "dls" })).verdict).toBe("pass");
    expect(abandonWithResult([d("past_min_overs")], at("decided", { kind: "tie" })).verdict).toBe("pass");
    expect(abandonWithResult([d("past_min_overs")], at("decided", { kind: "win", winner: "b" })).verdict, "a win by no method").toBe("fail");
    expect(abandonWithResult([d("past_min_overs")], at("decided", { kind: "no_result" })).verdict).toBe("fail");
    expect(abandonWithResult([d("before_min_overs")], at("decided", { kind: "no_result" })).verdict).toBe("pass");
    expect(abandonWithResult([d("before_min_overs")], at("abandoned", null)).verdict).toBe("fail");
    expect(abandonWithResult([], [])).toMatchObject({ verdict: "fail", checked: 0 });
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

describe("WD-CASC's checks (X-WD-1..4)", () => {
  const answer = (over: Partial<WithdrawOut> = {}): WithdrawOut => ({ entrant_id: "x", status: "withdrawn", policy: "walkover", walkovers: 1, voided: 0, skipped_finalized: 0, ...over });
  const { rows, graph } = bracket("knockout", F8);
  const lines = knockoutLines(graph, rows.filter((r) => r.round_no === 1));
  const [qf1, qf2] = lines.a.qf;
  const [qf3, qf4] = lines.b.qf;
  const id = (k: string) => `f-${k}`;
  const ext = (key: string, home: string | null, away: string | null, status: string, outcome: ObservedOutcome | null) => fx(id(key), home, away, status, outcome, { extKey: key });
  const w1 = qf1.home_entrant_id!; const a2 = qf2.away_entrant_id!; const a3 = qf3.away_entrant_id!;
  const r = {
    steps: [{ entrantId: w1, label: "semi-final opponent TBD", answer: answer({ walkovers: 0 }) }, { entrantId: qf2.home_entrant_id!, label: "held", answer: answer() }],
    walked: [{ fixtureId: qf2.id, withdrawn: qf2.home_entrant_id!, remaining: a2, label: "held" }],
    w1, a2, a3, lines, dw: { fixtureId: qf4.id, home: qf4.home_entrant_id!, away: qf4.away_entrant_id!, asked: { kind: "double_walkover" as const }, refusal: null },
  };
  const good = [
    ext(qf1.ext_key!, w1, qf1.away_entrant_id, "decided", { kind: "win", winner: w1 }),
    ext(qf2.ext_key!, qf2.home_entrant_id, a2, "forfeited", { kind: "award", winner: a2, loser: qf2.home_entrant_id!, reason: WITHDREW }),
    ext(qf3.ext_key!, qf3.home_entrant_id, a3, "forfeited", { kind: "award", winner: a3, loser: qf3.home_entrant_id!, reason: WITHDREW }),
    ext(qf4.ext_key!, qf4.home_entrant_id, qf4.away_entrant_id, "forfeited", { kind: "double_walkover" }),
    ext(lines.a.sf, null, a2, "forfeited", { kind: "award", winner: a2, loser: null, reason: "walkover" }),
    ext(lines.b.sf, null, null, "forfeited", { kind: "double_walkover" }),
    ext(lines.final, a2, null, "forfeited", { kind: "award", winner: a2, loser: null, reason: "walkover" }),
  ];
  it("the rule's run passes all three; each reds when its own fixture is wrong", () => {
    expect(withdrawalsWalkOver(r, good)).toMatchObject({ verdict: "pass", checked: 3 });
    expect(tbdSeatWalksOver(r, good)).toMatchObject({ verdict: "pass", checked: 4 });
    expect(bothSeatsDead(r, good, [a2])).toMatchObject({ verdict: "pass", checked: 4 });
    const swap = (key: string, f: ObservedFixture) => good.map((g) => (g.extKey === key ? f : g));
    expect(withdrawalsWalkOver(r, swap(qf2.ext_key!, ext(qf2.ext_key!, qf2.home_entrant_id, a2, "abandoned", null))).verdict).toBe("fail");
    expect(withdrawalsWalkOver({ ...r, steps: [...r.steps, { entrantId: "y", label: "x", answer: answer({ voided: 1 }) }] }, good).verdict, "a voiding answer").toBe("fail");
    expect(tbdSeatWalksOver(r, swap(lines.a.sf, ext(lines.a.sf, w1, a2, "forfeited", { kind: "award", winner: a2, loser: w1, reason: WITHDREW }))).verdict, "W1 still seated").toBe("fail");
    expect(tbdSeatWalksOver(r, [...good, ext("other", w1, "z", "scheduled", null)]).verdict, "W1 seated later").toBe("fail");
    expect(tbdSeatWalksOver(r, swap(qf1.ext_key!, ext(qf1.ext_key!, w1, qf1.away_entrant_id, "cancelled", null))).verdict, "a voided fixture").toBe("fail");
    expect(bothSeatsDead(r, swap(lines.b.sf, ext(lines.b.sf, null, null, "scheduled", null)), [a2]).verdict, "SF2 left open").toBe("fail");
    expect(bothSeatsDead(r, swap(lines.final, ext(lines.final, a2, null, "scheduled", null)), [a2]).verdict, "final left open").toBe("fail");
    expect(bothSeatsDead(r, good, [w1]).verdict, "wrong champion").toBe("fail");
    expect(bothSeatsDead({ ...r, dw: { ...r.dw, refusal: { status: 409, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" } } }, good, [a2]).verdict, "the DW refused").toBe("fail");
  });
  it("a choreography that never began fails each check by name (never a vacuous pass)", () => {
    const empty = { steps: [], walked: [], w1: null, a2: null, a3: null, lines: null, dw: null };
    expect(withdrawalsWalkOver(empty, good)).toMatchObject({ verdict: "fail", checked: 1 });
    expect(tbdSeatWalksOver(empty, good)).toMatchObject({ verdict: "fail", checked: 1 });
    expect(bothSeatsDead(empty, good, null)).toMatchObject({ verdict: "fail", checked: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("reference-walkover: the interim oracle against Appendix A's walkover rows", () => {
  const credit = (sport: string, cfg: Record<string, unknown>, reason: Parameters<typeof walkoverCredit>[0]["reason"] = "walkover") => walkoverCredit({ sport, cfg, reason });
  it("answers every built-in sport (sweep of 11)", () => {
    expect([...CREDIT_SPORTS].sort()).toEqual([...SPORT_KEYS].sort());
    expect(CREDIT_SPORTS.length).toBe(11);
  });
  it("the per-sport rows, from hand-written cfgs", () => {
    expect(credit("football", { awardScore: { goals: 3 } }).winner).toEqual({ gf: 3, ga: 0 }); // FB-WO-1
    expect(credit("football", { awardScore: { goals: 3 } }).loser).toEqual({ gf: 0, ga: 3 });
    expect(credit("hockey", { awardScore: { goals: 5 } }).winner).toEqual({ gf: 5, ga: 0 }); // HK-WO-1
    expect(credit("hockey", { awardScore: { goals: 3 } }).winner).toEqual({ gf: 3, ga: 0 }); // a cfg that pins 3 keeps it
    expect(credit("icehockey", { awardScore: { goals: 5 } }).winner).toEqual({ gf: 5, ga: 0 }); // IH-WO-1
    expect(credit("volleyball", { bestOf: 5, setTo: 25 }).winner).toEqual({ sets_won: 3, sets_lost: 0, points_won: 75, points_lost: 0 }); // VB-WO-1, FIVB 6.4.1
    expect(credit("volleyball", { bestOf: 3, setTo: 21 }).loser).toEqual({ sets_won: 0, sets_lost: 2, points_won: 0, points_lost: 42 });
    expect(credit("tabletennis", { bestOf: 5, setTo: 11 }).winner).toEqual({ sets_won: 3, sets_lost: 0, points_won: 33, points_lost: 0 }); // TT-WO-1
    expect(credit("badminton", { bestOf: 3, setTo: 21 }).winner).toEqual({ sets_won: 2, sets_lost: 0, points_won: 42, points_lost: 0 }); // BD-WO-1
    expect(credit("carrom", { bestOf: 3, gameTo: 29 }).winner).toMatchObject({ sets_won: 2, points_won: 58 }); // CA-WO-1
    const tn = credit("tennis", { bestOf: 3 }); // TN-WO-1: straight sets; the games excluded from game %
    expect(tn.winner).toMatchObject({ sets_won: 2, sets_lost: 0 });
    expect(tn.excluded).toEqual(["games_won", "games_lost"]);
    expect(credit("tennis", { bestOf: 5 }).winner.sets_won).toBe(3);
    const ck = credit("cricket", { ballsPerInnings: 120, inningsPerSide: 1 }); // CK-WO-1: the defaulter charged its full quota
    expect(ck.loser.balls_faced_eff).toBe(120);
    expect(ck.winner.balls_faced_eff).toBe(0);
    expect(credit("cricket", { ballsPerInnings: 300, inningsPerSide: 2 }).loser.balls_faced_eff).toBe(600);
    expect(credit("cricket", { ballsPerInnings: 120 }).loser.balls_faced_eff).toBe(120);
    const bg = credit("boardgame", {}); // BG-WO-1: 1-0, a game, no colour
    expect(bg.winner).toEqual({ wins: 1, white: 0, black: 0 });
    expect(bg.excluded).toEqual(["white", "black"]);
    expect(credit("generic", {}).winner).toEqual({ for: 0, against: 0 }); // GN-WO-1
    for (const s of SPORT_KEYS) {
      const c = credit(s, { awardScore: { goals: 3 }, bestOf: 3, setTo: 21, gameTo: 29, ballsPerInnings: 120 });
      expect(c.points, s).toBe("win");
      expect(c.statsMatch, s).toBe(false); // X-PS-1
    }
  });
  it("a double walkover (X-DW-4) is zero everywhere, nobody scores, every key excluded", () => {
    let checked = 0;
    for (const s of SPORT_KEYS) {
      const c = credit(s, { awardScore: { goals: 3 }, bestOf: 3, setTo: 21, gameTo: 29, ballsPerInnings: 120 }, "double_walkover");
      expect(Object.values({ ...c.winner, ...c.loser }).every((v) => v === 0), s).toBe(true);
      expect(c.points, s).toBe("zero");
      expect(c.excluded.length, s).toBe(new Set([...Object.keys(c.winner), ...Object.keys(c.loser)]).size);
      checked++;
    }
    expect(checked).toBe(11);
  });
  it("refuses by name what only the walkover-credit family answers: a retirement, a disqualification, a withdrawal after play; and an unknown sport or a cfg without the rule's key", () => {
    expect(() => credit("football", { awardScore: { goals: 3 } }, "retired")).toThrow(CreditNotCovered);
    expect(() => credit("football", { awardScore: { goals: 3 } }, "disqualified")).toThrow(CreditNotCovered);
    expect(() => walkoverCredit({ sport: "football", cfg: { awardScore: { goals: 3 } }, reason: "withdrew", played: { home: [1], away: [] } })).toThrow(/X-WD-1/);
    expect(walkoverCredit({ sport: "football", cfg: { awardScore: { goals: 3 } }, reason: "withdrew" }).winner).toEqual({ gf: 3, ga: 0 });
    expect(() => credit("curling", {})).toThrow(CreditNotCovered);
    expect(() => credit("football", {})).toThrow(/awardScore/);
    expect(() => credit("volleyball", { bestOf: 3 })).toThrow(/setTo/);
  });
  it("every key the oracle credits is a metric the sport's own standingsDelta emits for a played match (sweep of 11, under each builder default)", () => {
    let checked = 0;
    for (const sport of SPORT_KEYS) {
      const cfg = stageCfg(sport, resolveSportCfg(sport, variantFor(sport)), "league") as Record<string, unknown>;
      const events = generateStream({ sportKey: sport, cfg, stageKind: "league", home: "h", away: "a", outcome: { kind: "win", winner: "home" } });
      const folded = foldStream(sportModule(sport), cfg, "h", "a", events);
      const [h] = sportModule(sport).standingsDelta(folded.outcome as never, cfg as never, { kind: "league" }, folded.state as never);
      const c = walkoverCredit({ sport, cfg, reason: "walkover" });
      const keys = [...new Set([...Object.keys(c.winner), ...Object.keys(c.loser)])];
      expect(keys.length, sport).toBeGreaterThan(0);
      for (const k of keys) expect(Object.keys(h.metrics), `${sport}: ${k}`).toContain(k);
      checked++;
    }
    expect(checked).toBe(11);
  });
  it("HK-WO-1: the hockey builder default credits 5-0 (the default moves from 3) — red until the engine's default moves", () => {
    const cfg = resolveSportCfg("hockey", variantFor("hockey")) as { awardScore?: { goals?: number } };
    expect(cfg.awardScore?.goals).toBe(5);
    expect((resolveSportCfg("icehockey", variantFor("icehockey")) as { awardScore?: { goals?: number } }).awardScore?.goals).toBe(5);
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
    { key: "RT-PART", sport: "football", pass: ["w2b-retirement-recorded", "w2b-retirement-keeps-play"], abstain: ["w2b-retirement-credit"] },
    { key: "DW-ALL", sport: "generic", pass: ["w2b-double-walkover-recorded", "w2b-double-walkover-table"], abstain: ["w2b-double-walkover-advances-nobody", "w2b-double-walkover-final-refused"] },
    { key: "AB-AWARD", sport: "football", pass: ["w2b-abandon-with-result", "w2b-abandon-in-table"], abstain: [] },
    { key: "AB-AWARD", sport: "cricket", pass: ["w2b-abandon-with-result", "w2b-abandon-in-table"], abstain: [] },
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
});
