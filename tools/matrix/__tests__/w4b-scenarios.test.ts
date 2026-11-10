// W4 app PR B, Task 15 (T8-c, PR-B share): the Q3 (third place), Q4a (joint winners) and Q5a / Q5b (plate) scripts - registration, cells, and each
// script's own check against a DIFFERENTIAL pair: a fixture of the right answer (passes) and one of the wrong answer (reds, by the item that names it).
//
// Expected values are the rulebook's (rulebook-W4-knockout.md), never the scripts': RB4-T2 / ruling 270 (Shared: two 3rds, nobody 4th), RB4-T3
// (Play-off: the SF losers play, winner 3rd, loser 4th), RB4-T6 (both sides out: 4, 4), RB4-C4 (joint: 1, 1 and nobody 2nd), RB4-P1..P4 (the plate holds
// every first played loss) and ruling 116 (a departed entrant is never seated). Every check reports how many items it examined; zero is a failure.
// The scripts are NOT run against a live product here (T17's truth run does that); the fixtures are shaped as the product's wire reads.
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, isKnobRow, stagesForRow } from "../lib/catalogue.ts";
import { DriverMisuse, type FixtureRow, type JointWinnersOut } from "../lib/driver/types.ts";
import { ATOMIC } from "../lib/scenario-catalogue.ts";
import { identityOf, planL1Grid } from "../lib/layers.ts";
import { apiOnlyUiRoute } from "../lib/api-only-ui.ts";
import type { CompleteObs, ObservedOutcome, ObservedPlace, ObservedTitle } from "../lib/observed.ts";
import { assertion } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { ROW_MODE, modeOfBody, thirdPlaceItems, type Q3Obs } from "../lib/scenarios/q3-third-place.ts";
import { jointWinnersItems, jLineOf, type JLine, type JointObs } from "../lib/scenarios/q4a-joint-winners.ts";
import { plateDeclinesItems, plateWithdrawItems, type PlateDeclinesObs, type PlateWithdrawObs } from "../lib/scenarios/q5-plate.ts";
import { W4B_SCENARIO_KEYS, type CaseSpec, type ScenarioContext, type W4bScenarioKey } from "../lib/scenarios/types.ts";
import { Q3_FIELD, Q3_OUT_FIELD, Q4A_FIELD, Q5A_FIELD, Q5B_FIELD } from "../lib/scenarios/w4b-support.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { SCENARIO_KEYS, planSliceCases } from "../lib/slice.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { W4B_ATOMS, W4B_ROWS, w4bCells } from "../lib/w4b-cells.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";
import type { Line } from "../lib/scenarios/w4a-late-entry.ts";

const variantFor = offlineBuilderDefault;
const failing = (items: readonly { ok: boolean; note: string }[]): string[] => items.filter((i) => !i.ok).map((i) => i.note);
const win = (winner: string): ObservedOutcome => ({ kind: "win", winner, method: "regulation" });
const dw: ObservedOutcome = { kind: "double_walkover" };
const walk = (winner: string, loser: string): ObservedOutcome => ({ kind: "award", winner, loser, reason: "withdrew" });
const ST = "stage-1";
function line(id: string, round: number, home: string | null, away: string | null, status = "decided", outcome: ObservedOutcome | null = null, third = false): Line {
  return { id, stageId: ST, round, home, away, status, outcome, thirdPlace: third };
}
const places = (...rows: [string, number][]): ObservedPlace[] => rows.map(([entrantId, rank]) => ({ entrantId, rank }));
const completed = (p: ObservedPlace[], title: ObservedTitle | null): CompleteObs => ({ status: 200, code: null, completed: true, finalRanks: p.map((x) => x.entrantId), places: p, title });
const champion = (c: string): ObservedTitle => ({ kind: "champion", champion: c });

// --- registration and cells ---------------------------------------------------------------------------------------------------------

describe("the five keys: frozen names, registered, opt-in, one catalogue atom each", () => {
  it("each key is registered under its own key, no canary, its own field; none is a slice key or in a committed w1-driving plan", () => {
    expect([...W4B_SCENARIO_KEYS]).toEqual(["W4B_Q3", "W4B_Q3_OUT", "W4B_Q4A", "W4B_Q5A", "W4B_Q5B"]);
    const fields: Record<W4bScenarioKey, number> = { W4B_Q3: Q3_FIELD, W4B_Q3_OUT: Q3_OUT_FIELD, W4B_Q4A: Q4A_FIELD, W4B_Q5A: Q5A_FIELD, W4B_Q5B: Q5B_FIELD };
    let checked = 0;
    for (const k of W4B_SCENARIO_KEYS) {
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(SCENARIOS[k].canaryCheck, k).toBeNull();
      expect(SCENARIOS[k].entrantCount, k).toBe(fields[k]);
      expect((SCENARIO_KEYS as readonly string[]).includes(k), `${k} is a slice key`).toBe(false);
      expect((W1_DRIVING_SCENARIOS as readonly string[]).includes(k), `${k} is a w1-driving script`).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
    // The fields are the rulebook's: a third place needs the semi-finals (X-TP-1: four or more); a full bracket of eight has no byes; seven has one.
    expect([Q3_FIELD, Q3_OUT_FIELD, Q4A_FIELD, Q5A_FIELD, Q5B_FIELD]).toEqual([8, 4, 4, 8, 7]);
    const keys: readonly string[] = W4B_SCENARIO_KEYS;
    const slice = planSliceCases(variantFor);
    expect(slice.length).toBeGreaterThan(0);
    expect(slice.filter((c) => keys.includes(c.scenario))).toEqual([]);
    const all = planW1Driving(variantFor, {});
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((c) => keys.includes(c.scenario))).toEqual([]);
  });

  it("the catalogue's atoms Q3, Q4a, Q5a and Q5b exist and are scripted (none known-no-path); each key names its atom (counted by id)", () => {
    const byId = new Map(ATOMIC.map((a) => [a.id, a]));
    let checked = 0;
    for (const id of ["Q3", "Q4a", "Q5a", "Q5b"]) {
      const a = byId.get(id);
      expect(a, id).toBeDefined();
      expect(a!.knownNoPath, `${id} still has no organiser path`).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
    for (const k of W4B_SCENARIO_KEYS) expect(byId.has(W4B_ATOMS[k]), `${k} -> ${W4B_ATOMS[k]}`).toBe(true);
    expect(W4B_ATOMS).toEqual({ W4B_Q3: "Q3", W4B_Q3_OUT: "Q3", W4B_Q4A: "Q4a", W4B_Q5A: "Q5a", W4B_Q5B: "Q5b" });
  });

  it("the rows are the ones the rulebook names, read off the real stage bodies", () => {
    const singleKnockout = ROW_KEYS.filter((r) => { const s = stagesForRow(r); return s.length === 1 && s[0]!.kind === "knockout"; });
    expect([...singleKnockout].sort()).toEqual(["knockout", "knockout_third_place"]);
    expect([...W4B_ROWS.W4B_Q3]).toEqual(["knockout", "knockout_third_place"]);
    expect([...W4B_ROWS.W4B_Q3_OUT]).toEqual(["knockout_third_place"]);
    expect([...W4B_ROWS.W4B_Q4A]).toEqual(["knockout", "knockout_third_place"]);
    // The row's own body carries the rulebook's setting: Shared posts no true flag, the Play-off row posts true.
    expect(modeOfBody(stagesForRow("knockout")[0]!.config)).toBe("shared");
    expect(modeOfBody(stagesForRow("knockout_third_place")[0]!.config)).toBe("playoff");
    expect(ROW_MODE).toEqual({ knockout: "shared", knockout_third_place: "playoff" });
    // The plate rows: a knockout feeding a plate, the only ones that hold one.
    const plated = ROW_KEYS.filter((r) => stagesForRow(r).some((s) => s.kind === "knockout" && s.progression?.sources.some((src) => src.take.some((t) => (t as { kind?: string }).kind === "firstLosses"))));
    expect(plated).toEqual(["ko_plate"]);
    expect([...W4B_ROWS.W4B_Q5A]).toEqual(["ko_plate"]);
    expect([...W4B_ROWS.W4B_Q5B]).toEqual(["ko_plate"]);
  });

  it("a named key plans exactly its own cells, every sport of the registry; a refused cell plans nothing (counted)", () => {
    let planned = 0;
    const want: Record<W4bScenarioKey, number> = { W4B_Q3: 22, W4B_Q3_OUT: 11, W4B_Q4A: 22, W4B_Q5A: 11, W4B_Q5B: 11 };
    for (const k of W4B_SCENARIO_KEYS) {
      const cases = planW1Driving(variantFor, { scenario: k });
      expect(cases.length, k).toBe(want[k]);
      expect(cases.length, k).toBe(W4B_ROWS[k].length * SPORT_KEYS.length);
      expect(w4bCells(k).length, k).toBe(cases.length);
      for (const c of cases) {
        expect(c.scenario, c.caseId).toBe(k);
        expect(c.caseId, k).toBe(`${c.row}|${c.sport}|${c.variant}|${k}`);
        expect(c.canary, c.caseId).toBe(false);
        expect(W4B_ROWS[k], c.caseId).toContain(c.row);
        planned++;
      }
      expect(new Set(cases.map((c) => c.sport)), `${k}: every sport of the registry`).toEqual(new Set(SPORT_KEYS));
    }
    expect(planned).toBe(77);
    expect(w4bCells("W4B_Q3", (row, sport) => row === "knockout" && sport === "football").length).toBe(21);
    expect(w4bCells("W4B_Q3_OUT", () => true)).toEqual([]);
  });
});

describe("knockout_third_place is a builder path now, not an API-only row", () => {
  it("it is a knob row, throws NotApiOnlyRow at the API-only route, and its L1 cells are driven (measured count, none left 🚫)", () => {
    expect(isKnobRow("knockout_third_place")).toBe(true);
    expect(isKnobRow("knockout")).toBe(false);
    expect(() => apiOnlyUiRoute("knockout_third_place")).toThrow();
    const cases = planL1Grid(variantFor).filter((c) => identityOf(c).row === "knockout_third_place");
    expect(cases.length).toBeGreaterThan(0);
    const driven = cases.filter((c) => c.spec !== null && c.noPath === null);
    // The plan said 11; the cells are every sport the row's cell is not refused on. Measured, and every one of them is driven.
    expect(driven.length).toBe(cases.length);
    expect(cases.length).toBe(11);
  });
});

// --- Q3: third place ------------------------------------------------------------------------------------------------------------------

// An 8-bracket: QF E1vE8, E4vE5, E2vE7, E3vE6 (higher seeds win); SF E1vE4, E2vE3; final E1vE2 - E1 champion.
const QF: Line[] = [line("q1", 1, "E1", "E8", "decided", win("E1")), line("q2", 1, "E4", "E5", "decided", win("E4")), line("q3", 1, "E2", "E7", "decided", win("E2")), line("q4", 1, "E3", "E6", "decided", win("E3"))];
const SF: Line[] = [line("s1", 2, "E1", "E4", "decided", win("E1")), line("s2", 2, "E2", "E3", "decided", win("E2"))];
const FINAL = line("f", 3, "E1", "E2", "decided", win("E1"));
const FIELD8 = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"];
const RANK_REST = [["E5", 5], ["E6", 5], ["E7", 5], ["E8", 5]] as [string, number][];
const pubOf = (p: ObservedPlace[]): Map<string, number | null> => new Map(p.map((x) => [x.entrantId, x.rank]));
const q3 = (over: Partial<Q3Obs> & { p: ObservedPlace[] }): Q3Obs => {
  const { p, ...rest } = over;
  return { mode: "shared", rowMode: "shared", field: FIELD8, lines: [...QF, ...SF, FINAL], complete: completed(p, champion("E1")), publicRanks: pubOf(p), departed: new Set(), ...rest };
};
const SHARED_RIGHT = places(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 3], ...RANK_REST);

describe("Q3 Shared: two 3rds (RB4-T2, ruling 270)", () => {
  it("the right answer (E3 and E4 both 3rd, nobody 4th) passes, counted", () => {
    const items = thirdPlaceItems(q3({ p: SHARED_RIGHT }));
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(20);
    expect(assertion("w4b-q3-third-place", items)).toMatchObject({ verdict: "pass", checked: items.length });
  });
  it("today's wrong answer - the two semi-final losers split 3rd and 4th by seed - reds by name", () => {
    const wrong = places(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 4], ...RANK_REST);
    const why = failing(thirdPlaceItems(q3({ p: wrong }))).join(" | ");
    expect(why).toMatch(/expected both 3rd/);
    expect(why).toMatch(/rank\(s\) 4th under Shared|entrant\(s\) rank 4th under Shared/);
  });
  it("a Shared stage that holds a third-place line reds; a missing completion and unread public standings red (no vacuous pass)", () => {
    expect(failing(thirdPlaceItems(q3({ p: SHARED_RIGHT, lines: [...QF, ...SF, FINAL, line("t", 3, "E3", "E4", "decided", win("E3"), true)] }))).join("|")).toMatch(/third-place line\(s\) exist under Shared/);
    const none = thirdPlaceItems({ ...q3({ p: SHARED_RIGHT }), complete: null });
    expect(failing(none).join("|")).toMatch(/completion was never read/);
    expect(none.length).toBe(2);
    expect(failing(thirdPlaceItems(q3({ p: SHARED_RIGHT, publicRanks: null }))).join("|")).toMatch(/public standings were never read/);
    expect(failing(thirdPlaceItems(q3({ p: SHARED_RIGHT, mode: "playoff" }))).join("|")).toMatch(/posted playoff, the rulebook's row carries shared/);
  });
  it("the public standings disagreeing with the completion reds (every surface, RB4-T2)", () => {
    const pub = pubOf(SHARED_RIGHT);
    pub.set("E4", 4);
    expect(failing(thirdPlaceItems(q3({ p: SHARED_RIGHT, publicRanks: pub }))).join("|")).toMatch(/the public standings rank E4 4/);
  });
});

describe("Q3 Play-off: who plays whom, then 3rd and 4th (RB4-T3)", () => {
  const third = (outcome: ObservedOutcome | null, home = "E3", away = "E4", status = "decided") => line("t", 3, home, away, status, outcome, true);
  const po = (p: ObservedPlace[], t: Line, extra: Partial<Q3Obs> = {}) => q3({ p, mode: "playoff", rowMode: "playoff", lines: [...QF, ...SF, FINAL, t], ...extra });
  const RIGHT = places(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4], ...RANK_REST);
  it("the right answer (the SF losers play; winner 3rd, loser 4th) passes, counted", () => {
    const items = thirdPlaceItems(po(RIGHT, third(win("E4"))));
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(20);
  });
  it("today's wrong answer - a shared 3rd under Play-off - reds; so does a third-place line seating someone who won a semi-final", () => {
    const shared = places(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 3], ...RANK_REST);
    expect(failing(thirdPlaceItems(po(shared, third(win("E4"))))).join("|")).toMatch(/third-place winner E4 ranks 3|third-place loser E3 ranks 3/);
    expect(failing(thirdPlaceItems(po(RIGHT, third(win("E4"), "E1", "E4")))).join("|")).toMatch(/third-place line seats E1 v E4, expected the semi-final losers/);
  });
  it("a Play-off stage with NO third-place line reds, and an undecided line is no result", () => {
    expect(failing(thirdPlaceItems(q3({ p: RIGHT, mode: "playoff", rowMode: "playoff" }))).join("|")).toMatch(/0 third-place line\(s\) exist under Play-off/);
    expect(failing(thirdPlaceItems(po(RIGHT, third(null, "E3", "E4", "scheduled")))).join("|")).toMatch(/no result that places anybody/);
  });
});

describe("Q3 Play-off, both sides out: 4 and 4 (RB4-T6, X-TP-7)", () => {
  // A bracket of four: SF E1vE4, E2vE3 played (E3 and E4 lose, then withdraw), final E1vE2, third-place line a departure double walkover.
  const SF4: Line[] = [line("s1", 1, "E1", "E4", "decided", win("E1")), line("s2", 1, "E2", "E3", "decided", win("E2"))];
  const F4 = line("f", 2, "E1", "E2", "decided", win("E1"));
  const T4 = line("t", 2, "E4", "E3", "forfeited", dw, true);
  const out = (p: ObservedPlace[], over: Partial<Q3Obs> = {}) => q3({ p, mode: "playoff", rowMode: "playoff", field: ["E1", "E2", "E3", "E4"], lines: [...SF4, F4, T4], departed: new Set(["E3", "E4"]), ...over });
  it("ranks 1, 2, 4, 4 with 3rd vacant passes, counted", () => {
    const items = thirdPlaceItems(out(places(["E1", 1], ["E2", 2], ["E3", 4], ["E4", 4])));
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(14);
  });
  it("today's wrong answer - 3rd and 4th handed out - reds by name", () => {
    const why = failing(thirdPlaceItems(out(places(["E1", 1], ["E2", 2], ["E3", 3], ["E4", 4])))).join("|");
    expect(why).toMatch(/rank 3rd after a third-place double walkover, expected nobody/);
    expect(why).toMatch(/expected both 4th/);
  });
  it("sides the product still stores as in do not make a departure double walkover", () => {
    expect(failing(thirdPlaceItems(out(places(["E1", 1], ["E2", 2], ["E3", 4], ["E4", 4]), { departed: new Set(["E3"]) }))).join("|")).toMatch(/needs both sides departed/);
  });
});

// --- Q4a: joint winners ---------------------------------------------------------------------------------------------------------------

const jl = (id: string, round: number, home: string | null, away: string | null, status: string, outcome: ObservedOutcome | null, o: { third?: boolean; fin?: boolean; at?: string | null } = {}): JLine => ({
  ...line(id, round, home, away, status, outcome, o.third === true), isFinal: o.fin === true, jointAt: o.at ?? null,
});
const J_SF: JLine[] = [jl("s1", 1, "E1", "E4", "decided", win("E1")), jl("s2", 1, "E2", "E3", "decided", win("E2"))];
const J_FINAL = jl("f", 2, "E1", "E2", "scheduled", null, { fin: true });
const J_FINAL_DECL = { ...J_FINAL, status: "decided", jointAt: "2026-11-10T10:00:00Z" } as JLine;
const DECLARED: JointWinnersOut = { fixture_id: "f", status: "scheduled", stage_completed: true } as JointWinnersOut;
const undoObs = (over: Partial<JointObs> = {}): JointObs => ({
  flow: "undo", before: [...J_SF, J_FINAL], declared: DECLARED, afterDeclare: [...J_SF, J_FINAL_DECL], stageAfterDeclare: "complete",
  rankRows: [{ entrantId: "E1", rank: 1 }, { entrantId: "E2", rank: 1 }, { entrantId: "E3", rank: 3 }, { entrantId: "E4", rank: 3 }],
  undone: { answer: { fixture_id: "f", status: "scheduled" } as never, lines: [...J_SF, J_FINAL], stage: "in_progress" },
  complete: completed(places(["E2", 1], ["E1", 2], ["E3", 3], ["E4", 3]), champion("E2")),
  finalLines: [...J_SF, { ...J_FINAL, status: "decided", outcome: win("E2") } as JLine], ...over,
});

describe("Q4a: declare joint winners on an unplayed final, then undo it (RB4-C4, X-CH-4)", () => {
  it("the right answer (1, 1, nobody 2nd, undo re-opens, the replayed final crowns one) passes, counted", () => {
    const items = jointWinnersItems(undoObs());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(25);
    expect(assertion("w4b-q4a-joint-winners", items)).toMatchObject({ verdict: "pass", checked: items.length });
  });
  it("today's wrong answer - the declaration crowns one finalist and ranks the other 2nd - reds by name", () => {
    const why = failing(jointWinnersItems(undoObs({ rankRows: [{ entrantId: "E1", rank: 1 }, { entrantId: "E2", rank: 2 }, { entrantId: "E3", rank: 3 }, { entrantId: "E4", rank: 3 }] }))).join("|");
    expect(why).toMatch(/finalist E2 ranks 2 after the declaration, expected 1st/);
    expect(why).toMatch(/1 entrant\(s\) rank 2nd after a joint title/);
  });
  it("a declaration that cannot be undone, a stage that stays complete, or a decided-by-seed final red", () => {
    const stuck = undoObs({ undone: { answer: { fixture_id: "f", status: "scheduled" } as never, lines: [...J_SF, J_FINAL_DECL], stage: "complete" } });
    const why = failing(jointWinnersItems(stuck)).join("|");
    expect(why).toMatch(/after the Undo the final reads decided/);
    expect(why).toMatch(/the declaration's completion must re-open/);
    expect(failing(jointWinnersItems(undoObs({ undone: { answer: undefined, lines: [], stage: undefined } }))).join("|")).toMatch(/Undo was refused or never asked/);
    // The replayed final must be a real result: a final that is never played reds, and a completion that crowns nobody reds.
    expect(failing(jointWinnersItems(undoObs({ finalLines: [...J_SF, J_FINAL] }))).join("|")).toMatch(/replayed final reads/);
    expect(failing(jointWinnersItems(undoObs({ complete: completed(places(["E2", 1], ["E1", 2]), { kind: "joint", winners: ["E1", "E2"] }) }))).join("|")).toMatch(/completion after the replay crowns joint/);
  });
  it("a declaration on a final that was already played, a refused declaration and an empty bracket red (no vacuous pass)", () => {
    expect(failing(jointWinnersItems(undoObs({ before: [...J_SF, { ...J_FINAL, status: "decided", outcome: win("E1") } as JLine] }))).join("|")).toMatch(/expected an unplayed final/);
    const refused = jointWinnersItems(undoObs({ declared: undefined }));
    expect(failing(refused).join("|")).toMatch(/declaration was refused/);
    const empty = jointWinnersItems(undoObs({ before: [] }));
    expect(empty.length).toBe(1);
    expect(failing(empty).join("|")).toMatch(/name no final/);
  });
  it("the stage that moves another line on the declaration reds (nothing else in the bracket moves)", () => {
    const moved = undoObs({ afterDeclare: [{ ...J_SF[0]!, home: "E9" }, J_SF[1]!, J_FINAL_DECL] });
    expect(failing(jointWinnersItems(moved)).join("|")).toMatch(/s1: E1\/E4 decided before the declaration, E9\/E4 decided after/);
  });
});

describe("Q4a on the Play-off row: the declaration WAITS for the third-place line, and the completion's title is joint", () => {
  const T = jl("t", 2, "E3", "E4", "scheduled", null, { third: true });
  const T_DONE = { ...T, status: "decided", outcome: win("E4") } as JLine;
  const obs = (over: Partial<JointObs> = {}): JointObs => ({
    flow: "third_place", before: [...J_SF, J_FINAL, T], declared: { ...DECLARED, stage_completed: false } as JointWinnersOut, afterDeclare: [...J_SF, J_FINAL_DECL, T],
    stageAfterDeclare: "in_progress", rankRows: null, undone: null,
    complete: completed(places(["E1", 1], ["E2", 1], ["E4", 3], ["E3", 4]), { kind: "joint", winners: ["E1", "E2"] }), finalLines: [...J_SF, J_FINAL_DECL, T_DONE], ...over,
  });
  it("the right answer passes, counted", () => {
    const items = jointWinnersItems(obs());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(18);
  });
  it("today's wrong answer - the stage completes on the declaration, skipping the third-place line - reds", () => {
    const why = failing(jointWinnersItems(obs({ declared: { ...DECLARED, stage_completed: true } as JointWinnersOut, stageAfterDeclare: "complete", afterDeclare: [...J_SF, J_FINAL_DECL, T_DONE] }))).join("|");
    expect(why).toMatch(/answered stage_completed true, expected false/);
    expect(why).toMatch(/expected it to WAIT/);
    expect(why).toMatch(/third-place line reads decided after the declaration, expected it still owed/);
  });
  it("a title that is a champion, or a 2nd place held after a joint title, reds", () => {
    const wrongTitle = obs({ complete: completed(places(["E1", 1], ["E2", 2], ["E4", 3], ["E3", 4]), champion("E1")) });
    const why = failing(jointWinnersItems(wrongTitle)).join("|");
    expect(why).toMatch(/title is champion \(E1\), expected joint winners E1 and E2/);
    expect(why).toMatch(/places rank E1 1st, expected both finalists/);
    expect(why).toMatch(/1 entrant\(s\) rank 2nd after a joint title/);
  });
  it("jLineOf reads the final flag and the declaration instant off a stored row", () => {
    const row = { id: "f", stage_id: ST, round_no: 2, home_entrant_id: "E1", away_entrant_id: "E2", status: "decided", outcome: null, third_place: false, is_final: true, joint_winners_at: "2026-11-10T10:00:00Z" } as unknown as FixtureRow;
    expect(jLineOf(row)).toMatchObject({ id: "f", isFinal: true, jointAt: "2026-11-10T10:00:00Z", thirdPlace: false });
    expect(jLineOf({ ...row, is_final: false, joint_winners_at: undefined })).toMatchObject({ isFinal: false, jointAt: null });
  });
  it("a driver that lacks declareJointWinners is refused by name, never silently skipped", async () => {
    const spec: CaseSpec = { caseId: "knockout|football|v|W4B_Q4A", row: "knockout", sport: "football", variant: variantFor("football"), scenario: "W4B_Q4A", canary: false };
    const ctx: ScenarioContext = { driver: new FakeKnockoutDriver({ singleElim: true }), spec, orgSlug: "o", cfg: resolveSportCfg("football", spec.variant), tag: "t", denied: [] };
    await expect(SCENARIOS.W4B_Q4A.run(ctx)).rejects.toBeInstanceOf(DriverMisuse);
  });
});

// --- Q5: plate ------------------------------------------------------------------------------------------------------------------------

// A plate of the four round-1 losers of an 8-bracket: E5 E6 E7 E8. Plate round 1: p1 E5vE8, p2 E6vE7; round 2 the final. E8 withdraws: p1 walks over to E5.
const P_BEFORE: Line[] = [line("p1", 1, "E5", "E8", "scheduled"), line("p2", 1, "E6", "E7", "scheduled"), line("pf", 2, null, null, "scheduled")];
const P_AFTER: Line[] = [line("p1", 1, "E5", "E8", "forfeited", walk("E5", "E8")), line("p2", 1, "E6", "E7", "scheduled"), line("pf", 2, "E5", null, "scheduled")];
const withdrawObs = (over: Partial<PlateWithdrawObs> = {}): PlateWithdrawObs => ({
  expectedField: ["E5", "E6", "E7", "E8"], proposed: ["E5", "E6", "E7", "E8"], advanceStatus: 200, advanceCode: null, before: P_BEFORE.map((l) => (l.id === "pf" ? { ...l } : l)).map((l) => l),
  after: P_AFTER, withdrawn: "E8", opponent: "E5", lineId: "p1", departed: new Set(["E8"]), complete: completed(places(["E5", 1], ["E6", 2]), champion("E5")), ...over,
});

describe("Q5a: a plate entrant withdraws and their plate line walks over (X-WD-2)", () => {
  it("the right answer passes, counted; the plate's field is every first played loss", () => {
    const items = plateWithdrawItems(withdrawObs());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(14);
    expect(assertion("w4b-q5a", items)).toMatchObject({ verdict: "pass", checked: items.length });
  });
  it("today's wrong answer - the withdrawn entrant's line stays scheduled and the opponent never advances - reds by name", () => {
    const why = failing(plateWithdrawItems(withdrawObs({ after: P_BEFORE }))).join("|");
    expect(why).toMatch(/walked-over plate line reads scheduled, expected forfeited/);
    expect(why).toMatch(/expected an award to E5 against E8/);
    expect(why).toMatch(/opponent E5 is seated in 0 later plate line/);
  });
  it("a plate proposal missing a first loser, or seating a main-draw winner, reds (the oracle judges both directions)", () => {
    expect(failing(plateWithdrawItems(withdrawObs({ proposed: ["E5", "E6", "E7"] }))).join("|")).toMatch(/plate proposal seats \{E5,E6,E7\}/);
    expect(failing(plateWithdrawItems(withdrawObs({ proposed: ["E5", "E6", "E7", "E8", "E1"] }))).join("|")).toMatch(/plate proposal seats/);
  });
  it("a refused proposal and an empty oracle field red; a withdrawal the product does not store as departed reds", () => {
    expect(failing(plateWithdrawItems(withdrawObs({ proposed: null }))).join("|")).toMatch(/proposal was refused or never made/);
    expect(failing(plateWithdrawItems(withdrawObs({ expectedField: [] }))).join("|")).toMatch(/plate needs two/);
    expect(failing(plateWithdrawItems(withdrawObs({ departed: new Set() }))).join("|")).toMatch(/stores E8 as still in/);
  });
});

const PLATE_LINES: Line[] = [line("p1", 1, "E5", "E6", "scheduled"), line("p2", 1, "E7", "E8", "scheduled"), line("pf", 2, null, null, "scheduled")];
const declinesObs = (over: Partial<PlateDeclinesObs> = {}): PlateDeclinesObs => ({
  firstLosersAtDecline: ["E5", "E6", "E7", "E8"], declined: "E8", plateOpenAtDecline: true, departed: new Set(["E8"]), expectedField: ["E5", "E6", "E7"], proposed: ["E5", "E6", "E7"],
  advanceStatus: 200, advanceCode: null, plateLines: [line("p1", 1, "E5", "E6", "scheduled"), line("p2", 1, "E7", null, "forfeited", { kind: "award", winner: "E7", loser: null, reason: "bye" }), line("pf", 2, null, null, "scheduled")],
  complete: completed(places(["E5", 1], ["E6", 2]), champion("E5")), ...over,
});

describe("Q5b: a main-draw loser declines (withdraws) before the plate is proposed (ruling 116)", () => {
  it("the right answer - the plate draws from the three who remain - passes, counted", () => {
    const items = plateDeclinesItems(declinesObs());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBeGreaterThan(12);
  });
  it("today's wrong answer - the departed loser is seated in the plate - reds by name", () => {
    const wrong = declinesObs({ expectedField: ["E5", "E6", "E7"], proposed: ["E5", "E6", "E7", "E8"], plateLines: PLATE_LINES });
    const why = failing(plateDeclinesItems(wrong)).join("|");
    expect(why).toMatch(/plate proposal seats the departed E8/);
    expect(why).toMatch(/the departed E8 is seated in 1 plate line\(s\), expected none/);
  });
  it("an oracle that still names the departed, a plate already open at the decline, and a loser who was no first loser red", () => {
    expect(failing(plateDeclinesItems(declinesObs({ expectedField: ["E5", "E6", "E7", "E8"], proposed: ["E5", "E6", "E7", "E8"] }))).join("|")).toMatch(/oracle's plate field still names the departed E8/);
    expect(failing(plateDeclinesItems(declinesObs({ plateOpenAtDecline: false }))).join("|")).toMatch(/plate already had seated lines/);
    expect(failing(plateDeclinesItems(declinesObs({ firstLosersAtDecline: ["E5", "E6", "E7"] }))).join("|")).toMatch(/was no first loser of the main draw/);
  });
  it("a first loser left out of the plate reds, one item per expected entrant (counted)", () => {
    const left = declinesObs({ plateLines: [line("p1", 1, "E5", "E6", "scheduled")] });
    expect(failing(plateDeclinesItems(left)).join("|")).toMatch(/first loser E7 is not seated in the plate/);
    expect(plateDeclinesItems(left).length).toBe(plateDeclinesItems(declinesObs()).length);
  });
});
