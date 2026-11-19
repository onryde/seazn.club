// W5 app PR A, Task 24 (T5-b): the opt-in round-robin scripts R2 (a late player into a running league or group), R4c (a withdrawal under half where a
// result is already finalized), Q2 (a departed qualifier backfilled), P7 (rank override per pool, refused on a non-table), C6a (a correction after
// the stage completed, a confirmed cut) and SURF (the table's API shape), plus F4 and C5 planned and NOT run (app PR B) - their registration, their
// cells, and each script's own checks against fixtures that mirror what the product answered in the local live runs (next dev :3330 + the HTTP
// driver; run ids t24r2*, t24r4*, t24q2*, t24p7*, t24c6a*, t24s* of the Task 24 report).
//
// Expected values are the rulebook's (RB5-L3/L4/L9/L13/L16, L8, W1/W2, K1/K2/K6, P5/P7, X-BD-7, ST-G23/28), never the scripts' own output. Every check
// reports how many items it examined and zero is a failure; every item class has a fixture that makes exactly it fail and one that passes.
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { RefusedCall, type LateEntryWire, type StandingsOut, type WithdrawOut } from "../lib/driver/types.ts";
import type { ObservedOutcome, ObservedStage } from "../lib/observed.ts";
import { ATOMIC } from "../lib/scenario-catalogue.ts";
import { assertion } from "../lib/scenarios/assertions.ts";
import { c5AdjustPoints } from "../lib/scenarios/c5-adjust-points.ts";
import { correctionItems, type CorrectionObs } from "../lib/scenarios/c6a-correction-after-complete.ts";
import { f4UnequalPools } from "../lib/scenarios/f4-unequal-pools.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { pinnedTableItems, refusedOverrideItems } from "../lib/scenarios/p7-rank-override-pool.ts";
import { departedQualifierItems, eligibleCut } from "../lib/scenarios/q2-departed-qualifier.ts";
import { ALREADY_PLACED_CODE, STAGE_COMPLETE_CODE, alreadyPlacedItems, catchUpItems, refusedLateItems, snakePoolIndex, type LateAddObs } from "../lib/scenarios/r2-late-entry.ts";
import { finalizedExpungeItems, type FinalizedExpungeObs } from "../lib/scenarios/r4-atomic.ts";
import { surfaceItems, type SurfaceObs } from "../lib/scenarios/surfaces-table.ts";
import { ScenarioUnsupported, W5A_SCENARIO_KEYS, type CaseSpec, type ScenarioContext } from "../lib/scenarios/types.ts";
import type { TLine } from "../lib/scenarios/w5a-table.ts";
import { Recorder, playDivision, setUpDivision } from "../lib/scenarios/common.ts";
import { fieldSizeFor } from "../lib/field-size.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeMultiStageDriver } from "./fake-formats-driver.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { W5A_ATOMS, W5A_NOT_RUN_KEYS, W5A_RUN_KEYS, entryPools, w5aCells, w5aField, w5aFedRows, w5aPooledRows, w5aRows, w5aTableRows } from "../lib/w5a-cells.ts";

const variantFor = offlineBuilderDefault;
const failing = (items: readonly { ok: boolean; note: string }[]): string[] => items.filter((i) => !i.ok).map((i) => i.note);
const win = (winner: string): ObservedOutcome => ({ kind: "win", winner, method: "regulation" });
/** One line of a table stage (pool null: a league). */
function tl(id: string, round: number, home: string | null, away: string | null, status = "scheduled", outcome: ObservedOutcome | null = null, poolId: string | null = null): TLine {
  return { id, stageId: "s", round, home, away, status, outcome, thirdPlace: false, poolId };
}

// --- registration and cells -------------------------------------------------------------------------------------------------------

describe("W5A registration: eight keys, opt-in, six that run and two planned and not run", () => {
  it("the keys, the registry and the planner agree, and the default plans hold none of them", () => {
    expect([...W5A_SCENARIO_KEYS]).toEqual(["W5A_R2", "W5A_R4C", "W5A_Q2", "W5A_P7", "W5A_C6A", "W5A_SURF", "W5A_F4", "W5A_C5"]);
    for (const k of W5A_SCENARIO_KEYS) {
      expect(SCENARIOS[k], k).toBeDefined();
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(W1_DRIVING_SCENARIOS as readonly string[], k).not.toContain(k);
    }
    expect([...W5A_RUN_KEYS, ...W5A_NOT_RUN_KEYS].sort()).toEqual([...W5A_SCENARIO_KEYS].sort());
    const all = planW1Driving(variantFor, {});
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((c) => (W5A_SCENARIO_KEYS as readonly string[]).includes(c.scenario))).toEqual([]);
  });

  it("every atom a script drives is a real catalogue atom (a rename in scenario-catalogue.ts reds here)", () => {
    const ids = new Set(ATOMIC.map((a) => a.id));
    expect(ids.size).toBeGreaterThan(0);
    const named = Object.values(W5A_ATOMS);
    expect(named.length).toBe(7);
    for (const id of named) expect(ids.has(id), id).toBe(true);
  });

  it("the row sets are DERIVED from the stage bodies: table rows start on a league or group, fed rows add a progression, pooled rows hold a group", () => {
    const table = ROW_KEYS.filter((r) => ["league", "group"].includes(stagesForRow(r)[0]?.kind ?? ""));
    expect([...w5aTableRows()]).toEqual(table);
    expect(table.length).toBeGreaterThan(0);
    expect(table).toContain("league");
    expect(table).toContain("group_group_ko");
    expect(table).not.toContain("knockout");
    expect(table).not.toContain("swiss");
    expect(w5aFedRows().length).toBeGreaterThan(0);
    for (const r of w5aFedRows()) expect(stagesForRow(r)[1]?.progression?.sources?.length ?? 0, r).toBeGreaterThan(0);
    expect(w5aFedRows()).not.toContain("league");
    expect(w5aPooledRows().length).toBeGreaterThan(0);
    for (const r of w5aPooledRows()) expect(stagesForRow(r).some((s) => s.kind === "group"), r).toBe(true);
    expect(entryPools("league")).toBe(1);
    expect(entryPools("groups_ko")).toBeGreaterThan(1);
    // the script rows
    expect([...w5aRows("W5A_R2")]).toEqual([...w5aTableRows()]);
    expect([...w5aRows("W5A_Q2")]).toEqual([...w5aFedRows()]);
    expect([...w5aRows("W5A_F4")]).toEqual([...w5aPooledRows()]);
  });

  it("a field is sized so the rule under test has something to act on: odd for a late add, pools of four for a withdrawal under half", () => {
    for (const row of w5aTableRows()) {
      const p = entryPools(row);
      expect(w5aField("W5A_R2", row) % 2, `${row} R2 odd`).toBe(1);
      expect(w5aField("W5A_R4C", row), `${row} R4c pools of four`).toBe(p === 1 ? 6 : p * 4);
      expect(w5aField("W5A_Q2", row), `${row} Q2 a next in line`).toBeGreaterThan(p === 1 ? 4 : 2 * p);
    }
  });

  it("a named key plans exactly its own cells, every sport of the registry, under its own case id; --only narrows to one; a dropped cell plans nothing (counted)", () => {
    let planned = 0;
    for (const k of W5A_SCENARIO_KEYS) {
      const cases = planW1Driving(variantFor, { scenario: k });
      expect(cases.length, k).toBe(w5aRows(k).length * SPORT_KEYS.length);
      expect(w5aCells(k).length, k).toBe(cases.length);
      for (const c of cases) {
        expect(c.scenario, c.caseId).toBe(k);
        expect(c.caseId, k).toBe(`${c.row}|${c.sport}|${c.variant}|${k}`);
        expect(w5aRows(k), c.caseId).toContain(c.row);
        planned++;
      }
      expect(new Set(cases.map((c) => c.sport)), `${k}: every sport of the registry`).toEqual(new Set(SPORT_KEYS));
      expect(planW1Driving(variantFor, { scenario: k, only: `${w5aRows(k)[0]}|football` }).map((c) => c.caseId)).toEqual([`${w5aRows(k)[0]}|football|${variantFor("football")}|${k}`]);
    }
    expect(planned).toBeGreaterThan(0);
    expect(planned).toBe(W5A_SCENARIO_KEYS.reduce((n, k) => n + w5aRows(k).length * SPORT_KEYS.length, 0));
    expect(w5aCells("W5A_R2", (row, sport) => row === "league" && sport === "football").length).toBe(w5aTableRows().length * SPORT_KEYS.length - 1);
    expect(w5aCells("W5A_R2", () => true)).toEqual([]);
  });

  it("F4 and C5 are planned and NOT run: they defer to W5 by name, never read green", async () => {
    for (const s of [f4UnequalPools, c5AdjustPoints]) {
      const ctx = { spec: { row: "league", sport: "football" } } as unknown as ScenarioContext;
      await expect(s.run(ctx)).rejects.toBeInstanceOf(ScenarioUnsupported);
      await expect(s.run(ctx)).rejects.toMatchObject({ wave: "W5" });
    }
    expect(SCENARIOS.W5A_F4).toBe(f4UnequalPools);
    expect(SCENARIOS.W5A_C5).toBe(c5AdjustPoints);
  });
});

// --- R2 ---------------------------------------------------------------------------------------------------------------------------

describe("R2: a late player into a running table - catch-up (RB5-L3), where each fixture lands, the pool (RB5-L9), the refusal on a complete stage (RB5-L8)", () => {
  // An even league of four (no byes): rounds 1-3, round 1 started (A-B decided). E joins: four catch-up rounds after round 3, in the order of the
  // rounds the opponents played first, then the seed order.
  const L_BEFORE: readonly TLine[] = [
    tl("l1", 1, "A", "B", "decided", win("A")), tl("l2", 1, "C", "D"),
    tl("l3", 2, "A", "C"), tl("l4", 2, "B", "D"), tl("l5", 3, "A", "D"), tl("l6", 3, "B", "C"),
  ];
  const E_LINES: readonly TLine[] = [tl("n1", 4, "E", "A"), tl("n2", 5, "E", "B"), tl("n3", 6, "E", "C"), tl("n4", 7, "E", "D")];
  const L_AFTER: readonly TLine[] = [...L_BEFORE, ...E_LINES];
  const SEEDS: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5 };
  const ANSWER: LateEntryWire = {
    format: "league", case: "catch_up", source: "organiser", entrant_id: "E", appended_rounds: 4,
    fixtures: E_LINES.map((l) => ({ fixture_id: l.id, round_no: l.round!, placement: "catch_up_round", scheduled: false })),
  };
  const obs = (over: Partial<LateAddObs> = {}): LateAddObs => ({
    label: "act", stageKind: "league", before: L_BEFORE, after: L_AFTER, drawn: L_BEFORE, lateId: "E", newcomerSeed: 5, originals: new Set(["A", "B", "C", "D"]),
    answer: ANSWER, poolKeyOf: new Map(), seedOf: (id) => SEEDS[id]!, ...over,
  });

  it("the recorded product shape passes, counted", () => {
    const items = catchUpItems(obs());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(20);
    expect(assertion("r2", items)).toMatchObject({ verdict: "pass", checked: items.length });
  });

  it("no late_entry (or another format's) fails by name with one counted item", () => {
    for (const answer of [undefined, { ...ANSWER, format: "knockout" }]) {
      const items = catchUpItems(obs({ answer }));
      expect(items.length).toBe(1);
      expect(failing(items)).toHaveLength(1);
    }
  });

  it("each way the product can misplace the newcomer fails the item that names it", () => {
    const cases: readonly [string, LateAddObs, RegExp][] = [
      ["a Rebuild offer where a result is in", obs({ answer: { ...ANSWER, case: "rebuild_offered" } }), /case rebuild_offered, expected catch_up/],
      ["the answer names another entrant", obs({ answer: { ...ANSWER, entrant_id: "A" } }), /expected the newcomer E/],
      ["a missing opponent: E owes only three", obs({ after: [...L_BEFORE, ...E_LINES.slice(0, 3)], answer: { ...ANSWER, fixtures: ANSWER.fixtures!.slice(0, 3), appended_rounds: 3 } }), /sits in 3 line\(s\), expected one per member of the pool \(4/],
      ["an existing line moved (RB5-L4)", obs({ after: L_AFTER.map((l) => (l.id === "l3" ? { ...l, round: 9 } : l)) }), /l3: .* the add changed a line it did not name/],
      ["an existing line's status changed (RB5-L4)", obs({ after: L_AFTER.map((l) => (l.id === "l1" ? { ...l, status: "scheduled" } : l)) }), /l1: .* the add changed a line it did not name/],
      ["a catch-up line written scheduled (RB5-L13)", obs({ answer: { ...ANSWER, fixtures: ANSWER.fixtures!.map((f, i) => (i === 0 ? { ...f, scheduled: true } : f)) } }), /written scheduled/],
      ["the catch-up rounds are not consecutive after the last round", obs({ after: [...L_BEFORE, tl("n1", 4, "E", "A"), tl("n2", 6, "E", "B"), tl("n3", 7, "E", "C"), tl("n4", 8, "E", "D")] }), /catch-up rounds are 4,6,7,8, expected 4,5,6,7/],
      ["the catch-up order ignores the seed order", obs({ after: [...L_BEFORE, tl("n1", 4, "E", "B"), tl("n2", 5, "E", "A"), tl("n3", 6, "E", "C"), tl("n4", 7, "E", "D")] }), /catch-up order is B,A,C,D, expected A,B,C,D/],
      ["appended_rounds understated", obs({ answer: { ...ANSWER, appended_rounds: 3 } }), /appended_rounds 3, expected 4/],
      ["a fixture placed in a bye slot that has no bye", obs({ answer: { ...ANSWER, fixtures: ANSWER.fixtures!.map((f, i) => (i === 0 ? { ...f, placement: "bye_slot" } : f)) } }), /vs A: placed bye_slot in round 4, expected a catch-up round/],
    ];
    let proven = 0;
    for (const [what, o, why] of cases) {
      const bad = failing(catchUpItems(o));
      expect(bad.length, what).toBeGreaterThan(0);
      expect(bad.some((n) => why.test(n)), `${what}: ${bad.join(" | ")}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
  });

  it("an odd league: the newcomer takes a bye slot of a FUTURE unstarted drawn round, and a catch-up round where the bye round has started", () => {
    // A, B, C: rounds 1-3, one bye each (C round 1, B round 2, A round 3). Round 1 started.
    const before: readonly TLine[] = [tl("b1", 1, "A", "B", "decided", win("A")), tl("b2", 2, "A", "C"), tl("b3", 3, "B", "C")];
    const after: readonly TLine[] = [...before, tl("m1", 2, "E", "B"), tl("m2", 3, "E", "A"), tl("m3", 4, "E", "C")];
    const answer: LateEntryWire = {
      format: "league", case: "catch_up", source: "organiser", entrant_id: "E", appended_rounds: 1,
      fixtures: [{ fixture_id: "m1", round_no: 2, placement: "bye_slot", scheduled: false }, { fixture_id: "m2", round_no: 3, placement: "bye_slot", scheduled: false }, { fixture_id: "m3", round_no: 4, placement: "catch_up_round", scheduled: false }],
    };
    const o: LateAddObs = { label: "odd", stageKind: "league", before, after, drawn: before, lateId: "E", newcomerSeed: 4, originals: new Set(["A", "B", "C"]), answer, poolKeyOf: new Map(), seedOf: (id) => ({ A: 1, B: 2, C: 3, E: 4 })[id]! };
    expect(failing(catchUpItems(o))).toEqual([]);
    // C's bye was in round 1, which has started: the product must NOT use a bye slot for it
    const wrong: LateAddObs = { ...o, after: [...before, tl("m1", 2, "E", "B"), tl("m2", 3, "E", "A"), tl("m3", 1, "E", "C")], answer: { ...answer, appended_rounds: 0, fixtures: answer.fixtures!.map((f) => (f.fixture_id === "m3" ? { ...f, round_no: 1, placement: "bye_slot" } : f)) } };
    expect(failing(catchUpItems(wrong)).some((n) => /vs C: placed bye_slot in round 1, expected a catch-up round/.test(n))).toBe(true);
  });

  it("a group newcomer joins a SMALLEST pool, the snake's pool among equals (RB5-L9)", () => {
    // pool P1 = {A,B,C} (3), pool P2 = {D,E} (2): the newcomer (seed 6) belongs in P2 (smaller), whatever the snake says.
    const before: readonly TLine[] = [
      tl("a1", 1, "A", "B", "decided", win("A"), "P1"), tl("a2", 2, "A", "C", "scheduled", null, "P1"), tl("a3", 3, "B", "C", "scheduled", null, "P1"),
      tl("d1", 1, "D", "E", "scheduled", null, "P2"),
    ];
    const good: readonly TLine[] = [...before, tl("g1", 2, "F", "D", "scheduled", null, "P2"), tl("g2", 3, "F", "E", "scheduled", null, "P2")];
    const answer: LateEntryWire = {
      format: "group", case: "catch_up", source: "organiser", entrant_id: "F", pool_key: "B", appended_rounds: 0,
      fixtures: [{ fixture_id: "g1", round_no: 2, placement: "bye_slot", scheduled: false }, { fixture_id: "g2", round_no: 3, placement: "bye_slot", scheduled: false }],
    };
    // D and E: pool B has two rounds... D-E round 1 only, so the stage's last round is 3: rounds 2 and 3 are empty for D and E -> both hold a "bye" there.
    const o: LateAddObs = { label: "grp", stageKind: "group", before, after: good, drawn: before, lateId: "F", newcomerSeed: 6, originals: new Set(["A", "B", "C", "D", "E"]), answer, poolKeyOf: new Map([["P1", "A"], ["P2", "B"]]), seedOf: (id) => "ABCDEF".indexOf(id) + 1 };
    // the bye slots in rounds 2 and 3 are a pool-P2 member's only if the member sits out the round: D and E sit out rounds 2 and 3
    const bad = failing(catchUpItems(o));
    expect(bad.filter((n) => /pool|smallest/.test(n))).toEqual([]);
    // the newcomer in the LARGER pool is refused by name
    const wrongAnswer = { ...answer, pool_key: "A" };
    const wrongLines: readonly TLine[] = [...before, tl("g1", 4, "F", "A", "scheduled", null, "P1"), tl("g2", 5, "F", "B", "scheduled", null, "P1"), tl("g3", 6, "F", "C", "scheduled", null, "P1")];
    const worse = failing(catchUpItems({ ...o, after: wrongLines, answer: { ...wrongAnswer, fixtures: wrongLines.slice(-3).map((l) => ({ fixture_id: l.id, round_no: l.round!, placement: "catch_up_round", scheduled: false })), appended_rounds: 3 } }));
    expect(worse.some((n) => /joined pool A of 3, expected a smallest pool \(2/.test(n)), worse.join(" | ")).toBe(true);
    // an unknown pool key
    expect(failing(catchUpItems({ ...o, answer: { ...answer, pool_key: "Z" } })).some((n) => /names none of the stage's pools/.test(n))).toBe(true);
  });

  it("the snake's pool for the (n+1)th seed: seeds walk 1..P then P..1", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((s) => snakePoolIndex(s, 3))).toEqual([0, 1, 2, 2, 1, 0, 0, 1]);
    expect([1, 2, 3, 4].map((s) => snakePoolIndex(s, 2))).toEqual([0, 1, 1, 0]);
    expect(snakePoolIndex(7, 1)).toBe(0);
  });

  it("the second tap on a placed player is refused by name and moves nothing (X-CU-8); an accepted one fails", () => {
    const refusal = new RefusedCall("POST", "/x", 409, ALREADY_PLACED_CODE, "already placed");
    const ok = alreadyPlacedItems({ label: "tap", refusal, before: L_AFTER, after: L_AFTER });
    expect(failing(ok)).toEqual([]);
    expect(ok.length).toBe(3 + L_AFTER.length);
    expect(failing(alreadyPlacedItems({ label: "tap", refusal: undefined, before: L_AFTER, after: L_AFTER }))[0]).toMatch(/accepted/);
    expect(failing(alreadyPlacedItems({ label: "tap", refusal: new RefusedCall("POST", "/x", 409, "OTHER", "x"), before: L_AFTER, after: L_AFTER })).join()).toMatch(/expected RR_LATE_ENTRY_ALREADY_PLACED/);
    expect(failing(alreadyPlacedItems({ label: "tap", refusal, before: L_AFTER, after: [...L_AFTER, tl("x", 8, "E", "A")] })).join()).toMatch(/one catch-up set per player/);
  });

  it("a late add to a COMPLETE table is refused by name, as a thrown refusal or an answered `refused`, and seats nobody (RB5-L8)", () => {
    const thrown = new RefusedCall("POST", "/x", 422, STAGE_COMPLETE_CODE, "complete");
    expect(failing(refusedLateItems({ label: "e", refusal: thrown, answer: undefined, before: L_BEFORE, after: L_BEFORE }))).toEqual([]);
    expect(failing(refusedLateItems({ label: "e", refusal: undefined, answer: { format: "league", case: "refused", reason: STAGE_COMPLETE_CODE }, before: L_BEFORE, after: L_BEFORE }))).toEqual([]);
    // accepted
    expect(failing(refusedLateItems({ label: "e", refusal: undefined, answer: ANSWER, before: L_BEFORE, after: L_AFTER })).join()).toMatch(/was accepted/);
    // refused with another code
    expect(failing(refusedLateItems({ label: "e", refusal: new RefusedCall("POST", "/x", 422, "OTHER", "x"), answer: undefined, before: L_BEFORE, after: L_BEFORE })).join()).toMatch(/expected RR_LATE_ENTRY_STAGE_COMPLETE/);
    // refused but a line was written anyway
    expect(failing(refusedLateItems({ label: "e", refusal: thrown, answer: undefined, before: L_BEFORE, after: L_AFTER })).join()).toMatch(/lines after the refused add/);
  });
});

// --- R4c --------------------------------------------------------------------------------------------------------------------------

describe("R4c: a withdrawal under half played where one of the entrant's results is FINALIZED - the expunge removes it too (RB5-W2)", () => {
  // A league of four: the target T played one line (finalized), one pool-mate pair played (counted), the rest open.
  const BEFORE: readonly TLine[] = [
    tl("t1", 1, "T", "X", "finalized", win("T")), tl("p1", 1, "Y", "Z", "decided", win("Y")),
    tl("t2", 2, "T", "Y"), tl("p2", 2, "X", "Z"), tl("t3", 3, "T", "Z"), tl("p3", 3, "X", "Y"),
  ];
  const AFTER: readonly TLine[] = BEFORE.map((l) => (l.home === "T" || l.away === "T" ? { ...l, status: "abandoned", outcome: null } : l));
  const ANSWER: WithdrawOut = { entrant_id: "T", status: "withdrawn", policy: "expunge", walkovers: 0, voided: 3, skipped_cancelled: 0, walked_over_held: 0 };
  const TABLE: StandingsOut = {
    stage_id: "s", pool_id: null,
    rows: [
      { entrantId: "Y", rank: 1, status: "active", played: 2 }, { entrantId: "X", rank: 2, status: "active", played: 0 },
      { entrantId: "Z", rank: 3, status: "active", played: 1 }, { entrantId: "T", rank: 4, status: "withdrawn", played: 0 },
    ],
  };
  // Y won p1 (counted: Y 1, Z 1 played); the pairs the target held contribute nothing.
  const o = (over: Partial<FinalizedExpungeObs> = {}): FinalizedExpungeObs => ({ target: "T", before: BEFORE, after: AFTER, answer: ANSWER, table: { ...TABLE, rows: TABLE.rows.map((r) => ({ ...r, played: ({ Y: 1, X: 0, Z: 1, T: 0 } as Record<string, number>)[r.entrantId]! })) }, poolId: null, stageKind: "league", ...over });

  it("the recorded product shape passes, counted", () => {
    const items = finalizedExpungeItems(o());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(18);
  });

  it("each way the withdrawal can go wrong fails the item that names it", () => {
    const cases: readonly [string, FinalizedExpungeObs, RegExp][] = [
      ["a walkover instead of the expunge", o({ answer: { ...ANSWER, policy: "walkover", walkovers: 2, voided: 0 } }), /policy walkover, expected expunge/],
      ["the finalized line skipped as locked (the pre-W5 behaviour, ST-G15)", o({ answer: { ...ANSWER, skipped_cancelled: 1, voided: 2 }, after: AFTER.map((l) => (l.id === "t1" ? BEFORE[0]! : l)) }), /reported skipped|t1: finalized before/],
      ["the finalized line keeps its result", o({ after: AFTER.map((l) => (l.id === "t1" ? { ...l, status: "finalized", outcome: win("T") } : l)) }), /t1: finalized before, finalized\/.* after - expected abandoned with no result/],
      ["the cascade REPORTS a skipped line though the lines are all expunged (the report alone is wrong)", o({ answer: { ...ANSWER, skipped_cancelled: 1 } }), /1 line\(s\) reported skipped, expected none/],
      ["voided count short", o({ answer: { ...ANSWER, voided: 2 } }), /reported voided, expected all 3/],
      ["another line changed (RB5-W9)", o({ after: AFTER.map((l) => (l.id === "p1" ? { ...l, outcome: win("Z") } : l)) }), /p1: a line the target did not hold changed|p1: a line/],
      ["the withdrawn entrant dropped from the league table (RB5-W1)", o({ table: { ...TABLE, rows: TABLE.rows.filter((r) => r.entrantId !== "T") } }), /no longer in the league table/],
      ["the withdrawn row not marked", o({ table: { ...TABLE, rows: TABLE.rows.map((r) => (r.entrantId === "T" ? { ...r, status: "active", played: 0 } : { ...r, played: ({ Y: 1, X: 0, Z: 1 } as Record<string, number>)[r.entrantId]! })) } }), /reads status active, expected withdrawn/],
      ["the withdrawn entrant not last", o({ table: { ...TABLE, rows: TABLE.rows.map((r) => ({ ...r, played: ({ Y: 1, X: 0, Z: 1, T: 0 } as Record<string, number>)[r.entrantId]!, rank: r.entrantId === "T" ? 2 : r.entrantId === "X" ? 4 : r.rank })) } }), /ranks 2 of 4, expected last/],
      ["an expunged result still counted in a row's played", o({ table: { ...TABLE, rows: TABLE.rows.map((r) => ({ ...r, played: r.entrantId === "X" ? 1 : ({ Y: 1, Z: 1, T: 0 } as Record<string, number>)[r.entrantId]! })) } }), /row X: 1 played, expected 0/],
    ];
    let proven = 0;
    for (const [what, obs, why] of cases) {
      const bad = failing(finalizedExpungeItems(obs));
      expect(bad.length, what).toBeGreaterThan(0);
      expect(bad.some((n) => why.test(n)), `${what}: ${bad.join(" | ")}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
  });

  it("a script with no finalized line, or one that played over half, proves nothing and says so", () => {
    const noFinal = failing(finalizedExpungeItems(o({ before: BEFORE.map((l) => (l.id === "t1" ? { ...l, status: "decided" } : l)) })));
    expect(noFinal.some((n) => /no line of the target was FINALIZED/.test(n))).toBe(true);
    const over = failing(finalizedExpungeItems(o({ before: BEFORE.map((l) => (l.id === "t2" ? { ...l, status: "decided", outcome: win("T") } : l)) })));
    expect(over.some((n) => /is not under half/.test(n))).toBe(true);
  });

  it("a GROUP pool's table lists only the entrants with a counted result (engine 9.x, membership from results): the withdrawn row may be absent", () => {
    const groupAfter = AFTER;
    const rows = [{ entrantId: "Y", rank: 1, status: "active", played: 1 }, { entrantId: "Z", rank: 2, status: "active", played: 1 }];
    const items = finalizedExpungeItems(o({ stageKind: "group", after: groupAfter, table: { stage_id: "s", pool_id: "P", rows } }));
    expect(failing(items)).toEqual([]);
    // ... but a row for an entrant with NO counted result is not what the engine seats either
    const extra = failing(finalizedExpungeItems(o({ stageKind: "group", table: { stage_id: "s", pool_id: "P", rows: [...rows, { entrantId: "X", rank: 3, status: "active", played: 0 }] } })));
    expect(extra.some((n) => /the table lists 3 row\(s\)/.test(n))).toBe(true);
    // and on a LEAGUE the same two-row table is a failure
    expect(failing(finalizedExpungeItems(o({ stageKind: "league", table: { stage_id: "s", pool_id: null, rows } }))).length).toBeGreaterThan(0);
  });
});

// --- Q2 ---------------------------------------------------------------------------------------------------------------------------

type Tbl = ObservedStage["standings"];
const row = (entrantId: string, rank: number | null, points: number | null = null) => ({ entrantId, rank, points });
describe("Q2: a departed qualifier leaves the cut and the next eligible entrant takes the seat (RB5-K1, K2, K3)", () => {
  // a league of six, the leader L departed (ranked last now); the cut is rankRange 1..4
  const TABLES: Tbl = [{ poolId: null, rows: [row("B", 1, 9), row("C", 2, 7), row("D", 3, 6), row("E", 4, 4), row("F", 5, 3), row("L", 6, 12)] }];
  const TAKE = [{ kind: "rankRange", from: 1, to: 4 }];
  const GROUPS: Tbl = [
    { poolId: "A", rows: [row("A2", 1), row("A3", 2), row("A4", 3), row("A1", 4)] },
    { poolId: "B", rows: [row("B2", 1), row("B3", 2), row("B4", 3), row("B1", 4)] },
  ];

  it("the cut is the first eligible entrants of each table: rankRange over the sole table, topNPerGroup per pool, the departed out", () => {
    const league = eligibleCut(TAKE, TABLES, new Set(["L"]));
    expect([...league.must].sort()).toEqual(["B", "C", "D", "E"]);
    expect(league.ties).toEqual([]);
    const groups = eligibleCut([{ kind: "topNPerGroup", n: 2 }], GROUPS, new Set(["A2"]));
    expect([...groups.must].sort()).toEqual(["A3", "A4", "B2", "B3"]);
    // empty case first: no take, no cut
    expect(eligibleCut([], TABLES, new Set()).must.size).toBe(0);
    // a take kind the W5A rows do not use is refused by name
    expect(() => eligibleCut([{ kind: "bestNth", nth: 3, count: 2 }], TABLES, new Set())).toThrow(/take kind 'bestNth'/);
  });

  it("a tie at the cut's edge owes its count of seats, which of them is X-PD-8's order (equal rank; or equal points when the confirm picked a tie)", () => {
    const tied: Tbl = [{ poolId: null, rows: [row("B", 1, 9), row("C", 2, 7), row("D", 3, 6), row("E", 3, 6), row("F", 3, 6)] }];
    const cut = eligibleCut(TAKE, tied, new Set());
    expect([...cut.must].sort()).toEqual(["B", "C"]);
    expect(cut.ties).toHaveLength(1);
    expect([...cut.ties[0]!.members].sort()).toEqual(["D", "E", "F"]);
    expect(cut.ties[0]!.count).toBe(2);
    // a tie wholly inside the cut owes nothing to chance: all of it is certain
    const inside = eligibleCut(TAKE, [{ poolId: null, rows: [row("B", 1), row("C", 2), row("D", 3), row("E", 3), row("F", 5)] }], new Set());
    expect([...inside.must].sort()).toEqual(["B", "C", "D", "E"]);
    expect(inside.ties).toEqual([]);
    // distinct wire ranks on equal points: strict by default, a tie only when the confirm picked one
    const wire: Tbl = [{ poolId: null, rows: [row("B", 1, 9), row("C", 2, 7), row("D", 3, 6), row("E", 4, 2), row("F", 5, 2)] }];
    expect(eligibleCut(TAKE, wire, new Set()).ties).toEqual([]);
    const picked = eligibleCut(TAKE, wire, new Set(), true);
    expect([...picked.ties[0]!.members].sort()).toEqual(["E", "F"]);
    expect(picked.ties[0]!.count).toBe(1);
  });

  const base = { departed: "L", takes: TAKE, tables: TABLES, rankBefore: 1, declared: 4, tiePicked: false };
  it("the recorded product shape passes: L is out, E (rank 4 behind the departed) and F ... the seats are B, C, D, E", () => {
    // with L staying (rank 1) the cut is L, B, C, D; without L it is B, C, D, E: E is the backfill
    const items = departedQualifierItems({ ...base, seeded: ["B", "C", "D", "E"] });
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(12);
  });

  it("each way the destination can be seeded wrong fails the item that names it", () => {
    const cases: readonly [string, string[], RegExp][] = [
      ["the departed is seeded (RB5-K1)", ["L", "B", "C", "D"], /the departed L is seeded/],
      ["the seat is left empty (the FP-2 leave-empty model)", ["B", "C", "D"], /seeded 3, expected 4/],
      ["the wrong entrant takes the seat (F, not E)", ["B", "C", "D", "F"], /E: a first-eligible qualifier by the source table, not seeded/],
      ["a seat goes to an entrant outside the cut", ["B", "C", "D", "E", "F"], /seeded 5, expected 4/],
    ];
    let proven = 0;
    for (const [what, seeded, why] of cases) {
      const bad = failing(departedQualifierItems({ ...base, seeded }));
      expect(bad.some((n) => why.test(n)), `${what}: ${bad.join(" | ")}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
  });

  it("the premises: a departed who was not first, no row kept (RB5-K3), or a cut that needs no backfill fail by name", () => {
    expect(failing(departedQualifierItems({ ...base, seeded: ["B", "C", "D", "E"], rankBefore: 3 })).some((n) => /expected 1/.test(n))).toBe(true);
    expect(failing(departedQualifierItems({ ...base, seeded: ["B", "C", "D", "E"], tables: [{ poolId: null, rows: TABLES[0]!.rows.filter((r) => r.entrantId !== "L") }] })).some((n) => /no row in the source table/.test(n))).toBe(true);
    // the cut takes everyone: no backfill is exercised
    const wide = departedQualifierItems({ ...base, takes: [{ kind: "rankRange", from: 1, to: 6 }], declared: 5, seeded: ["B", "C", "D", "E", "F"] });
    expect(failing(wide).some((n) => /no entrant outside the cut/.test(n))).toBe(true);
  });
});

// --- P7 ---------------------------------------------------------------------------------------------------------------------------

describe("P7: a rank override per pool (RB5-P5) and refused on a non-table stage (RB5-P7)", () => {
  const NATURAL = [{ entrantId: "A", rank: 1 }, { entrantId: "B", rank: 2 }, { entrantId: "C", rank: 3 }, { entrantId: "D", rank: 4 }];
  const PINNED = [{ entrantId: "D", rank: 1 }, { entrantId: "A", rank: 2 }, { entrantId: "B", rank: 3 }, { entrantId: "C", rank: 4 }];

  it("a pin moves the pinned entrant to rank 1 and keeps the others' order behind it, counted", () => {
    const items = pinnedTableItems("p", NATURAL, PINNED, "D");
    expect(failing(items)).toEqual([]);
    expect(items.length).toBe(8);
  });

  it("each way the table can come out wrong fails the item that names it", () => {
    const cases: readonly [string, Parameters<typeof pinnedTableItems>[2], RegExp][] = [
      ["the pin is not applied", NATURAL, /the pinned entrant ranks 4, expected 1/],
      ["a row is dropped", PINNED.slice(0, 3), /3 row\(s\) after the pin, 4 before/],
      ["the unpinned order changes", [{ entrantId: "D", rank: 1 }, { entrantId: "B", rank: 2 }, { entrantId: "A", rank: 3 }, { entrantId: "C", rank: 4 }], /now ranks behind/],
      ["two entrants at rank 1", [{ entrantId: "D", rank: 1 }, { entrantId: "A", rank: 1 }, { entrantId: "B", rank: 3 }, { entrantId: "C", rank: 4 }], /expected 2 or lower/],
    ];
    let proven = 0;
    for (const [what, after, why] of cases) {
      const bad = failing(pinnedTableItems("p", NATURAL, after, "D"));
      expect(bad.some((n) => why.test(n)), `${what}: ${bad.join(" | ")}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
    // empty case: a pool with no row proves nothing
    expect(failing(pinnedTableItems("p", [], [], "D")).some((n) => /held no row/.test(n))).toBe(true);
  });

  it("a refused override must be the named 422 and leave the table as it was; an accepted one fails", () => {
    const refusal = new RefusedCall("POST", "/x", 422, "RR_RANK_OVERRIDE_POOL", "x");
    expect(failing(refusedOverrideItems("dup", refusal, "RR_RANK_OVERRIDE_POOL", NATURAL, NATURAL))).toEqual([]);
    expect(failing(refusedOverrideItems("dup", undefined, "RR_RANK_OVERRIDE_POOL", NATURAL, NATURAL))[0]).toMatch(/accepted/);
    expect(failing(refusedOverrideItems("dup", new RefusedCall("POST", "/x", 422, "OTHER", "x"), "RR_RANK_OVERRIDE_POOL", NATURAL, NATURAL)).join()).toMatch(/expected 422 RR_RANK_OVERRIDE_POOL/);
    expect(failing(refusedOverrideItems("dup", new RefusedCall("POST", "/x", 409, "RR_RANK_OVERRIDE_POOL", "x"), "RR_RANK_OVERRIDE_POOL", NATURAL, NATURAL)).join()).toMatch(/refused 409/);
    expect(failing(refusedOverrideItems("dup", refusal, "RR_RANK_OVERRIDE_POOL", NATURAL, PINNED)).join()).toMatch(/table changed after a refused override/);
  });
});

// --- C6a --------------------------------------------------------------------------------------------------------------------------

describe("C6a: a correction inside a completed table whose cut was confirmed - the seats go back, then re-propose and re-confirm (RB5-K6)", () => {
  const BEFORE: Tbl = [{ poolId: null, rows: [row("A", 1, 9), row("B", 2, 7), row("C", 3, 6), row("D", 4, 4), row("E", 5, 4), row("F", 6, 0)] }];
  const VOIDED: Tbl = [{ poolId: null, rows: [row("A", 1, 9), row("B", 2, 7), row("C", 3, 6), row("E", 4, 4), row("D", 5, 1), row("F", 6, 0)] }];
  const obs = (over: Partial<CorrectionObs> = {}): CorrectionObs => ({
    takes: [{ kind: "rankRange", from: 1, to: 4 }], before: BEFORE, afterVoid: VOIDED, afterRepost: BEFORE,
    seatedConfirmed: new Set(["A", "B", "C", "D"]), seatedAfterVoid: new Set(), seatedFinal: new Set(["A", "B", "C", "D"]),
    seededFirst: ["A", "B", "C", "D"], reconfirmStatus: 200, tiePicked: false, ...over,
  });

  it("the recorded product shape passes, counted", () => {
    const items = correctionItems(obs());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBe(9);
  });

  it("each way the product can mishandle the correction fails the item that names it", () => {
    const cases: readonly [string, CorrectionObs, RegExp][] = [
      ["the confirmed seats stay after the cut moved (RB5-K6)", obs({ seatedAfterVoid: new Set(["A", "B", "C", "D"]) }), /still seated in the destination after a correction that moved the cut/],
      ["the correction did not move the cut", obs({ afterVoid: BEFORE }), /did not move the cut/],
      ["the repost did not restore the table", obs({ afterRepost: VOIDED }), /not the table before the correction/],
      ["the re-confirm is refused", obs({ reconfirmStatus: 409 }), /re-confirm answered 409/],
      ["the re-confirmed seats are another cut", obs({ seatedFinal: new Set(["A", "B", "C", "E"]) }), /expected the original cut of 4, the same entrants/],
      ["the premise: the destination did not seat the table's cut", obs({ seatedConfirmed: new Set(["A", "B", "C", "F"]) }), /premise \(a confirmed cut that the table gives\) does not hold/],
    ];
    let proven = 0;
    for (const [what, o, why] of cases) {
      const bad = failing(correctionItems(o));
      expect(bad.some((n) => why.test(n)), `${what}: ${bad.join(" | ")}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
  });
});

// --- SURF -------------------------------------------------------------------------------------------------------------------------

describe("SURF: the table's API shape - name, status, pool, the pools route, the all-pools read, the public page", () => {
  const nm = new Map([["A", "Matrix Player 1"], ["B", "Matrix Player 2"], ["C", "Matrix Player 3"], ["D", "Matrix Player 4"]]);
  const r = (entrantId: string, rank: number, status: "active" | "withdrawn", pool: string | null) => ({ entrantId, rank, status, pool, name: nm.get(entrantId)! });
  const P1 = [r("A", 1, "active", "A"), r("B", 2, "active", "A")];
  const P2 = [r("C", 1, "active", "B"), r("D", 2, "withdrawn", "B")];
  const base: SurfaceObs = {
    departed: "D", names: nm, declaredPools: 2, listedPools: [{ id: "p1", key: "A" }, { id: "p2", key: "B" }],
    perPool: new Map([["p1", P1], ["p2", P2]]), allPools: [...P1, ...P2], publicPools: new Map([["p1", P1], ["p2", P2]]),
  };

  it("a several-pool stage passes, counted; a league (no pools listed, pool null, no all-pools read) passes", () => {
    const items = surfaceItems(base);
    expect(failing(items)).toEqual([]);
    expect(items.length).toBe(30);
    const league = [r("A", 1, "active", null), r("B", 2, "active", null), r("C", 3, "active", null), r("D", 4, "withdrawn", null)];
    const lo: SurfaceObs = { ...base, declaredPools: 1, listedPools: [], perPool: new Map([[null, league]]), allPools: null, publicPools: new Map([[null, league]]) };
    expect(failing(surfaceItems(lo))).toEqual([]);
  });

  it("each way a door can disagree fails the item that names it", () => {
    const pub = (rows: typeof P1) => new Map([["p1", rows], ["p2", P2]]);
    const cases: readonly [string, SurfaceObs, RegExp][] = [
      ["a row with no name (ST-G23)", { ...base, perPool: new Map([["p1", [{ ...P1[0]!, name: null }, P1[1]!]], ["p2", P2]]) }, /is named null/],
      ["a row named for ANOTHER entrant (ST-G23: the name is the division's own)", { ...base, perPool: new Map([["p1", [{ ...P1[0]!, name: nm.get(P1[1]!.entrantId)! }, P1[1]!]], ["p2", P2]]) }, /is named .*, the division stores/],
      ["the departed not marked", { ...base, perPool: new Map([["p1", P1], ["p2", [P2[0]!, { ...P2[1]!, status: "active" }]]]) }, /reads status active, expected withdrawn/],
      ["a row with the wrong pool key (ST-G28)", { ...base, perPool: new Map([["p1", [{ ...P1[0]!, pool: "B" }, P1[1]!]], ["p2", P2]]) }, /reads pool B, expected A/],
      ["the departed not last", { ...base, perPool: new Map([["p1", P1], ["p2", [{ ...P2[0]!, rank: 2 }, { ...P2[1]!, rank: 1 }]]]) }, /the departed ranks 1 of 2, expected last/],
      ["the pools route lists none on a several-pool stage (X-BD-7)", { ...base, listedPools: [] }, /pools route lists 0 pool\(s\), expected 2/],
      ["the pools route lists a pool on a league", { ...base, declaredPools: 1, allPools: null }, /pools route lists 2 pool\(s\), expected 0/],
      ["the public order differs", { ...base, publicPools: pub([P1[1]!, P1[0]!]) }, /public order/],
      ["the public page does not mark the departed (RB5-K3)", { ...base, publicPools: new Map([["p1", P1], ["p2", [P2[0]!, { ...P2[1]!, status: "active" }]]]) }, /a public row's status disagrees/],
      ["the all-pools read drops a row", { ...base, allPools: [...P1, P2[0]!] }, /holds 3 row\(s\), the per-pool reads hold 4/],
      ["the all-pools read tags a row with the wrong pool", { ...base, allPools: [...P1, { ...P2[0]!, pool: "A" }, P2[1]!] }, /C: the all-pools row reads pool A/],
      ["the several-pool stage answers no all-pools table", { ...base, allPools: null }, /answered no all-pools table/],
    ];
    let proven = 0;
    for (const [what, o, why] of cases) {
      const bad = failing(surfaceItems(o));
      expect(bad.some((n) => why.test(n)), `${what}: ${bad.join(" | ")}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
  });

  it("empty case first: no row read is a failure by name, never a vacuous pass", () => {
    const none: SurfaceObs = { ...base, perPool: new Map(), allPools: [], publicPools: new Map() };
    expect(failing(surfaceItems(none)).some((n) => /no standings row was read/.test(n))).toBe(true);
  });
});

// --- the afterAdvance hook (C6a's seam) ----------------------------------------------------------------------------------------------

describe("playDivision's afterAdvance hook: the window between a confirmed destination and its first result (RB5-K6)", () => {
  async function play(row: "league_ko" | "group_group_ko", hooks: Parameters<typeof playDivision>[3], driver = new FakeMultiStageDriver()) {
    const spec: CaseSpec = { caseId: `${row}|generic|score|LIFECYCLE`, row, sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false };
    const ctx: ScenarioContext = { driver, spec, orgSlug: "o", cfg: resolveSportCfg("generic", "score"), tag: "t", denied: [] };
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(row, "LIFECYCLE", spec.template));
    const plays = await playDivision(ctx, rec, setup, hooks);
    return { driver, plays, setup };
  }

  it("is called once, for the SECOND stage, with its confirmed advance, before any result of that stage is posted", async () => {
    const driver = new FakeMultiStageDriver();
    const seen: { seq: number; status: number; filled: number; stage2Posts: number; stage1Posts: number }[] = [];
    const { plays } = await play("league_ko", {
      afterAdvance: async (stage, advance) => {
        const ids2 = new Set((await driver.listFixtures()).filter((f) => f.stage_id === stage.id).map((f) => f.id));
        const posted = driver.trace.filter((c) => c.startsWith("postStream ")).map((c) => c.split(" ")[1]!);
        seen.push({ seq: stage.seq, status: advance.status, filled: advance.filled, stage2Posts: posted.filter((id) => ids2.has(id)).length, stage1Posts: posted.filter((id) => !ids2.has(id)).length });
      },
    }, driver);
    expect(plays.length).toBe(2);
    expect(seen.length, "called exactly once").toBe(1);
    expect(seen[0]!.seq).toBe(2);
    expect(seen[0]!.status).toBe(200);
    expect(seen[0]!.filled, "the advance seated entrants").toBeGreaterThan(0);
    expect(seen[0]!.stage1Posts, "the source stage was played before the window (not vacuous)").toBeGreaterThan(0);
    expect(seen[0]!.stage2Posts, "nothing of the destination was posted yet").toBe(0);
    // and the destination WAS played after it: the hook is a window, not a stop
    expect(driver.trace.filter((c) => c.startsWith("postStream ")).length).toBeGreaterThan(seen[0]!.stage1Posts);
  });

  it("is not called for the third stage of a three-stage row: only the second stage's window", async () => {
    const seqs: number[] = [];
    const { plays } = await play("group_group_ko", { afterAdvance: async (stage) => { seqs.push(stage.seq); } });
    expect(plays.length).toBe(3);
    expect(seqs, "only the second stage's window").toEqual([2]);
  });
});
