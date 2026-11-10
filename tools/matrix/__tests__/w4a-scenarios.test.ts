// W4 app PR A, Task 24: the three opt-in scripts R2 (late entry after Start), R10 (an automatic arrival waits, then the tap) and R6
// (a lucky loser takes a departed qualifier's seat) - their registration, their cells, and their own checks against fixtures that
// mirror what the product answered in the local live runs (next dev + the HTTP driver, football knockout / qualifying_main, run
// ids w4a-r2-c, w4a-r10-c, w4a-r6-b: the bracket shapes below are the ones those runs read, byes advanced at Start included).
//
// Expected values come from the rulebook, never from the scripts: RB4-L4 / X-LE-3 (the lowest-seeded bye holder's bye, at once),
// X-LE-10 / K13 (an automatic arrival is not placed until the tap; the tap gives back her own walked-over seat), RB4-V2 / V4 / V5 and
// X-LL-1 (the best loser below the cut: latest round lost, then the better seed, never a walkover loser). Every check reports how many
// items it examined and zero is a failure; every item class has a fixture that makes exactly it fail (the product misbehaving in that
// one way) and one that passes.
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { DriverMisuse, type EntrantInput, type EntrantRow, type LateEntryWire, type ReinstateOut } from "../lib/driver/types.ts";
import type { ObservedOutcome } from "../lib/observed.ts";
import { assertion } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { W4A_SCENARIO_KEYS, type CaseSpec, type ScenarioContext, type W4aScenarioKey } from "../lib/scenarios/types.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import {
  FULL_FIELD, R10_REVERSED_EVENTS, R2_FIELD, R6_CUT, W4A_SCENARIOS, bestLoser, lateAddItems, luckyLoserItems, qualifiersOf, reinstateItems, semifinalsOf,
  type LateAddObs, type Line, type LuckyObs, type ReinstateObs,
} from "../lib/scenarios/w4a-late-entry.ts";
import { SCENARIO_KEYS, planSliceCases } from "../lib/slice.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { W1_DRIVING_SCENARIOS, planW1Driving } from "../lib/w1-driving-set.ts";
import { W4A_ROWS, w4aCells } from "../lib/w4a-cells.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

const variantFor = offlineBuilderDefault;

// --- fixtures -------------------------------------------------------------------------------------------------------------------

const win = (winner: string): ObservedOutcome => ({ kind: "win", winner, method: "regulation" });
const bye = (winner: string): ObservedOutcome => ({ kind: "award", winner, loser: null, reason: "bye" });
const walkover = (winner: string, loser: string): ObservedOutcome => ({ kind: "award", winner, loser, reason: "withdrew" });
const ST = "stage-1";
/** One fixture. `round` is 1-based; `third` flags a third-place match. */
function line(id: string, round: number, home: string | null, away: string | null, status = "scheduled", outcome: ObservedOutcome | null = null, third = false): Line {
  return { id, stageId: ST, round, home, away, status, outcome, thirdPlace: third };
}
const swap = (lines: readonly Line[], id: string, over: Partial<Line>): Line[] => lines.map((l) => (l.id === id ? { ...l, ...over } : l));
const without = (lines: readonly Line[], id: string): Line[] => lines.filter((l) => l.id !== id);

// R2: six seeds in a bracket of eight, as the product draws it at Start - seeds 1 and 2 hold a bye (their lines finished as a bye,
// and each advanced into round 2).
const R2_BEFORE: readonly Line[] = [
  line("a1", 1, "E1", null, "forfeited", bye("E1")),
  line("a2", 1, "E4", "E5"),
  line("a3", 1, "E3", "E6"),
  line("a4", 1, "E2", null, "forfeited", bye("E2")),
  line("s1", 2, "E1", null),
  line("s2", 2, null, "E2"),
  line("f", 3, null, null),
];
// ... and after the organiser's add of E7: seed 2's bye line is reopened against the newcomer and seed 2's advance retracted.
const R2_AFTER: readonly Line[] = swap(swap(R2_BEFORE, "a4", { home: "E2", away: "E7", status: "scheduled", outcome: null }), "s2", { away: null });
const R2_ANSWER: LateEntryWire = { format: "knockout", case: "bye", entrant_id: "E7", stage_id: ST, fixture_id: "a4", opponent_id: "E2", scheduled: false };
const r2obs = (over: Partial<LateAddObs> = {}): LateAddObs => ({ before: R2_BEFORE, after: R2_AFTER, lateId: "E7", expectedOpponent: "E2", answer: R2_ANSWER, ...over });
const failing = (items: readonly { ok: boolean; note: string }[]): string[] => items.filter((i) => !i.ok).map((i) => i.note);

// R10: eight seeds; seed 3 (E3) plays seed 6 (E6) in round 1, withdraws, and E6 is walked over into round 2.
const R10_START: readonly Line[] = [
  line("l1", 1, "E1", "E8"), line("l2", 1, "E4", "E5"), line("l3", 1, "E3", "E6"), line("l4", 1, "E2", "E7"),
  line("s1", 2, null, null), line("s2", 2, null, null), line("f", 3, null, null),
];
const R10_WITHDRAWN: readonly Line[] = swap(swap(R10_START, "l3", { status: "forfeited", outcome: walkover("E6", "E3") }), "s2", { home: "E6" });
const R10_TAPPED: readonly Line[] = swap(swap(R10_WITHDRAWN, "l3", { status: "scheduled", outcome: null }), "s2", { home: null });
const R10_REINSTATE: ReinstateOut = { entrant_id: "E3", status: "confirmed", late_entry: { format: "knockout", case: "waiting", entrant_id: "E3", stage_id: ST } };
const R10_TAP: LateEntryWire = { format: "knockout", case: "withdrawn_slot", entrant_id: "E3", stage_id: ST, fixture_id: "l3", opponent_id: "E6", withdrawn_id: "E3" };
const r10obs = (over: Partial<ReinstateObs> = {}): ReinstateObs => ({
  target: "E3", opponent: "E6", lineId: "l3", afterWithdraw: R10_WITHDRAWN, afterReinstate: R10_WITHDRAWN, afterTap: R10_TAPPED,
  reinstate: R10_REINSTATE, tap: R10_TAP, ledgerAfterTap: R10_REVERSED_EVENTS, ...over,
});

// R6: qualifying_main of eight at a cut of four, the favourite winning every line.
const seedOfE = (id: string): number => Number(id.slice(1));
const Q_FAVOURITES: readonly Line[] = [
  line("q1", 1, "E1", "E8", "completed", win("E1")), line("q2", 1, "E4", "E5", "completed", win("E4")),
  line("q3", 1, "E3", "E6", "completed", win("E3")), line("q4", 1, "E2", "E7", "completed", win("E2")),
  line("qs1", 2, "E1", "E4", "completed", win("E1")), line("qs2", 2, "E2", "E3", "completed", win("E2")),
  line("qf", 3, "E1", "E2", "completed", win("E1")),
];
// The main draw as the product seats it when E4 (the first semifinal's loser) has left: E5, the best quarter-final loser, in her seat.
const M_LUCKY_E5: readonly Line[] = [line("m1", 1, "E1", "E5"), line("m2", 1, "E2", "E3"), line("mf", 2, null, null)];
const luckyObs = (over: Partial<LuckyObs> = {}): LuckyObs => ({ departed: "E4", cut: R6_CUT, qualifying: Q_FAVOURITES, main: M_LUCKY_E5, seedOf: seedOfE, ...over });
// The differential: E8 upsets E1, so the best loser below the cut is E1 (seed 1) - not E5, the seed order's first non-qualifier.
const Q_UPSET: readonly Line[] = [
  line("q1", 1, "E1", "E8", "completed", win("E8")), line("q2", 1, "E4", "E5", "completed", win("E4")),
  line("q3", 1, "E3", "E6", "completed", win("E3")), line("q4", 1, "E2", "E7", "completed", win("E2")),
  line("qs1", 2, "E8", "E4", "completed", win("E4")), line("qs2", 2, "E2", "E3", "completed", win("E2")),
  line("qf", 3, "E4", "E2", "completed", win("E2")),
];
const M_LUCKY_E1: readonly Line[] = [line("m1", 1, "E2", "E1"), line("m2", 1, "E4", "E3"), line("mf", 2, null, null)];

// --- registration and cells ----------------------------------------------------------------------------------------------------------

describe("the three keys: frozen names, registered, opt-in", () => {
  it("W4A_SCENARIOS are the brief's three keys; each is registered under its own key with no canary and its own field; no slice or committed w1-driving plan holds one", () => {
    expect([...W4A_SCENARIOS]).toEqual(["W4A_R2", "W4A_R10", "W4A_R6"]);
    const fields = { W4A_R2: R2_FIELD, W4A_R10: FULL_FIELD, W4A_R6: FULL_FIELD } as const;
    let checked = 0;
    for (const k of W4A_SCENARIO_KEYS) {
      expect(SCENARIOS[k].key, k).toBe(k);
      expect(SCENARIOS[k].canaryCheck, k).toBeNull();
      expect(SCENARIOS[k].entrantCount, k).toBe(fields[k]);
      expect((SCENARIO_KEYS as readonly string[]).includes(k), `${k} is a slice key`).toBe(false);
      expect((W1_DRIVING_SCENARIOS as readonly string[]).includes(k), `${k} is a w1-driving script`).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
    // The fields are the rulebook's: six seeds leave seeds 1 and 2 a bye in a bracket of eight (RB4-L4); eight make a full bracket whose
    // cut of four (the builder's default) leaves four quarter-final losers.
    expect(R2_FIELD).toBe(6);
    expect(FULL_FIELD).toBe(8);
    expect(R6_CUT).toBe(4);
    const keys: readonly string[] = W4A_SCENARIO_KEYS;
    const slice = planSliceCases(variantFor);
    expect(slice.length).toBeGreaterThan(0);
    expect(slice.filter((c) => keys.includes(c.scenario))).toEqual([]);
    const all = planW1Driving(variantFor, {});
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((c) => keys.includes(c.scenario))).toEqual([]);
    const planned = new Set(all.map((c) => c.scenario));
    expect(planned.size).toBeGreaterThan(0);
    for (const s of planned) expect(W1_DRIVING_SCENARIOS as readonly string[], `the default w1-driving plan holds ${s}`).toContain(s);
  });

  it("the rows are the ones the rulebook names, read off the real stage bodies: R2 / R10 a single root knockout, R6 a knockout feeding a knockout through a rank cut", () => {
    // X-LE-1: the division's ENTRY stage is a root knockout. Single-stage knockout rows, from the catalogue's own stage bodies.
    const singleKnockout = ROW_KEYS.filter((r) => { const s = stagesForRow(r); return s.length === 1 && s[0]!.kind === "knockout"; });
    expect([...singleKnockout].sort()).toEqual(["knockout", "knockout_third_place"]);
    expect([...W4A_ROWS.W4A_R2]).toEqual(["knockout", "knockout_third_place"]);
    expect([...W4A_ROWS.W4A_R10]).toEqual(["knockout", "knockout_third_place"]);
    // X-LL-1: a knockout whose destination takes a rankRange off it.
    const ranked = ROW_KEYS.filter((r) => {
      const s = stagesForRow(r);
      const take = s[1]?.progression?.sources[0]?.take[0] as { kind?: string } | undefined;
      return s.length === 2 && s[0]!.kind === "knockout" && s[1]!.kind === "knockout" && take?.kind === "rankRange";
    });
    expect(ranked).toEqual(["qualifying_main"]);
    expect([...W4A_ROWS.W4A_R6]).toEqual(["qualifying_main"]);
    expect(stagesForRow("qualifying_main")[1]!.progression!.sources[0]!.take[0]).toMatchObject({ kind: "rankRange", from: 1, to: R6_CUT });
  });

  it("a named key plans exactly its own cells, every sport of the registry, under its own case id; an --only narrows to one; a refused cell plans nothing (counted)", () => {
    let planned = 0;
    for (const k of W4A_SCENARIO_KEYS) {
      const cases = planW1Driving(variantFor, { scenario: k });
      expect(cases.length, k).toBe(W4A_ROWS[k].length * SPORT_KEYS.length);
      expect(w4aCells(k).length, k).toBe(cases.length);
      for (const c of cases) {
        expect(c.scenario, c.caseId).toBe(k);
        expect(c.caseId, k).toBe(`${c.row}|${c.sport}|${c.variant}|${k}`);
        expect(c.canary, c.caseId).toBe(false);
        expect(W4A_ROWS[k], c.caseId).toContain(c.row);
        planned++;
      }
      expect(new Set(cases.map((c) => c.sport)), `${k}: every sport of the registry`).toEqual(new Set(SPORT_KEYS));
      expect(planW1Driving(variantFor, { scenario: k, only: `${W4A_ROWS[k][0]}|football` }).map((c) => c.caseId)).toEqual([`${W4A_ROWS[k][0]}|football|${variantFor("football")}|${k}`]);
    }
    expect(planned).toBe(2 * 11 + 2 * 11 + 1 * 11);
    // A cell the committed drop list drops is left out, never planned: w4aCells takes the drop predicate the planner hands it.
    expect(w4aCells("W4A_R2", (row, sport) => row === "knockout" && sport === "football").length).toBe(2 * 11 - 1);
    expect(w4aCells("W4A_R6", () => true)).toEqual([]);
  });
});

// --- R2 -------------------------------------------------------------------------------------------------------------------------

describe("R2: late entry after Start - the add takes the lowest-seeded bye holder's bye at once", () => {
  it("the recorded product shape passes, and the check examines 9 + one item per fixture - counted, never zero", () => {
    const items = lateAddItems(r2obs());
    expect(failing(items)).toEqual([]);
    expect(items.length).toBe(9 + R2_BEFORE.length);
    expect(assertion("w4a-r2-late-entry-placed", items)).toMatchObject({ verdict: "pass", checked: 9 + R2_BEFORE.length });
  });

  it("no late_entry in the answer is a failure by name (the add that left the newcomer nowhere), and the check still counts its one item", () => {
    for (const answer of [undefined, { ...R2_ANSWER, format: "swiss" }]) {
      const items = lateAddItems(r2obs({ answer }));
      expect(items.length).toBe(1);
      expect(failing(items)).toHaveLength(1);
      expect(assertion("w4a-r2-late-entry-placed", items).verdict).toBe("fail");
    }
  });

  it("each way the product can misplace the newcomer fails exactly the item that names it", () => {
    const cases: readonly [string, LateAddObs, RegExp][] = [
      ["a Rebuild offer instead of the bye", r2obs({ answer: { ...R2_ANSWER, case: "rebuild_offered" } }), /case rebuild_offered, expected bye/],
      ["the answer names another entrant", r2obs({ answer: { ...R2_ANSWER, entrant_id: "E1" } }), /expected the newcomer E7/],
      ["seed 1's bye taken first (RB4-L4 says seed 2's)", r2obs({ answer: { ...R2_ANSWER, opponent_id: "E1", fixture_id: "a1" } }), /expected the seed-2 bye holder E2/],
      ["the named fixture does not exist", r2obs({ answer: { ...R2_ANSWER, fixture_id: "nope" } }), /is not among the stage's 7 fixtures/],
      ["the newcomer is not seated anywhere", r2obs({ after: R2_BEFORE }), /the named fixture seats E2\/-, expected the newcomer and E2/],
      ["a fixture is added instead of the bye line reopened", r2obs({ after: [...R2_AFTER, line("x", 1, "E7", "E2")] }), /8 fixtures after the add, 7 before/],
      ["another line moved", r2obs({ after: swap(R2_AFTER, "a2", { home: "E5", away: "E4" }) }), /a2: E4\/E5 scheduled before, E5\/E4 scheduled after/],
      ["the bye holder's advance is not retracted", r2obs({ after: swap(R2_AFTER, "s2", { away: "E2" }) }), /s2: -\/E2 scheduled before, -\/E2 scheduled after, expected -\/- scheduled/],
      ["the bye line was not a bye (a full line)", r2obs({ before: swap(R2_BEFORE, "a4", { away: "E7" }) }), /was E2\/E7 before the add, expected a bye line/],
    ];
    let proven = 0;
    for (const [what, obs, why] of cases) {
      const bad = failing(lateAddItems(obs));
      expect(bad.length, `${what}: ${JSON.stringify(bad)}`).toBeGreaterThan(0);
      expect(bad.some((n) => why.test(n)), `${what}: ${JSON.stringify(bad)}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
    expect(cases.length).toBe(9);
  });

  it("the second call: a second newcomer into the same bracket finds seed 1's bye next (RB4-L4), and the first one's line is left alone", () => {
    // After the first add, seed 1's bye is the only one left: the next newcomer plays it. The same check, the next expected holder.
    const second: Line[] = swap(swap(R2_AFTER, "a1", { home: "E1", away: "E8", status: "scheduled", outcome: null }), "s1", { home: null });
    const items = lateAddItems({
      before: R2_AFTER, after: second, lateId: "E8", expectedOpponent: "E1",
      answer: { format: "knockout", case: "bye", entrant_id: "E8", stage_id: ST, fixture_id: "a1", opponent_id: "E1" },
    });
    expect(failing(items)).toEqual([]);
    expect(items.length).toBe(9 + R2_AFTER.length);
    // ... and the first newcomer's line is one of the lines it examined unchanged.
    expect(items.some((i) => i.note.startsWith("a4:"))).toBe(true);
  });
});

// --- R10 ------------------------------------------------------------------------------------------------------------------------

describe("R10: an automatic arrival waits for the organiser's tap, and the tap gives back her own seat", () => {
  it("the recorded product shape passes, and the check examines every line it owes - counted from the fixture, never zero", () => {
    const items = reinstateItems(r10obs());
    expect(failing(items)).toEqual([]);
    // 2 guards + 2 for the Reinstate + one per line after the withdrawal + 2 for the tap + 5 for the lines it moved back + one per line
    // that seated neither player nor was hers (the tap's non-interference).
    const others = R10_WITHDRAWN.filter((l) => ![l.home, l.away].some((s) => s === "E3" || s === "E6") && l.id !== "l3").length;
    expect(others).toBeGreaterThan(0);
    expect(items.length).toBe(2 + 2 + R10_WITHDRAWN.length + 2 + 5 + others);
    expect(assertion("w4a-r10-arrival-waits-then-taps", items).verdict).toBe("pass");
  });

  it("each way the product can mishandle the arrival fails the item that names it", () => {
    const placedAtOnce = swap(R10_WITHDRAWN, "l3", { status: "scheduled", outcome: null });
    const cases: readonly [string, ReinstateObs, RegExp][] = [
      ["the app places the arrival itself (the line reopens on the Reinstate)", r10obs({ afterReinstate: placedAtOnce }), /l3: .* forfeited before the Reinstate, .* scheduled after - an automatic arrival was placed/],
      ["the Reinstate answers no late_entry", r10obs({ reinstate: { ...R10_REINSTATE, late_entry: null } }), /answered no late_entry/],
      ["the Reinstate answers placed, not waiting", r10obs({ reinstate: { ...R10_REINSTATE, late_entry: { ...R10_REINSTATE.late_entry!, case: "withdrawn_slot" } } }), /case withdrawn_slot, expected waiting/],
      ["no Reinstate answer at all", r10obs({ reinstate: undefined }), /no Reinstate answer/],
      ["the tap refuses", r10obs({ tap: { ...R10_TAP, case: "refused", reason: "KO_LATE_ENTRY_NO_SLOT" } }), /case refused, expected withdrawn_slot/],
      ["the tap seats another player in her seat", r10obs({ tap: { ...R10_TAP, entrant_id: "E1", withdrawn_id: "E3" } }), /E1 taking E3's seat, expected E3 taking her own/],
      ["the walkover is not reversed (the line stays decided)", r10obs({ afterTap: swap(R10_TAPPED, "l3", { status: "forfeited", outcome: walkover("E6", "E3") }) }), /expected it playable again with no result/],
      ["the opponent's advance is not undone", r10obs({ afterTap: R10_WITHDRAWN }), /the opponent sits in 2 fixture\(s\)/],
      ["the tap moved a fixture of neither player", r10obs({ afterTap: swap(R10_TAPPED, "l2", { status: "forfeited" }) }), /l2: .* scheduled before the tap, .* forfeited after - the tap moved a fixture of neither player/],
      ["the withdrawal never walked the opponent over (the premise is false)", r10obs({ afterWithdraw: R10_START, afterReinstate: R10_START }), /expected a walkover to E6/],
      ["the reopened line carries more than the walkover and its reversal", r10obs({ ledgerAfterTap: 3 }), /ledger holds 3 event\(s\), expected the walkover and its reversal \(2\)/],
    ];
    let proven = 0;
    for (const [what, obs, why] of cases) {
      const bad = failing(reinstateItems(obs));
      expect(bad.some((n) => why.test(n)), `${what}: ${JSON.stringify(bad)}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
    expect(cases.length).toBe(11);
  });
});

// --- R6 -------------------------------------------------------------------------------------------------------------------------

describe("R6: a lucky loser takes a departed qualifier's seat", () => {
  it("the qualifiers are the final's two sides and the two semifinal losers, read off the lines; an undecided bracket and no lines are null, never a guess", () => {
    expect([...qualifiersOf(Q_FAVOURITES)!].sort()).toEqual(["E1", "E2", "E3", "E4"]);
    expect([...qualifiersOf(Q_UPSET)!].sort()).toEqual(["E2", "E3", "E4", "E8"]);
    expect(semifinalsOf(Q_FAVOURITES).map((l) => l.id)).toEqual(["qs1", "qs2"]);
    expect(qualifiersOf(swap(Q_FAVOURITES, "qs2", { outcome: null, status: "scheduled" }))).toBeNull();
    expect(qualifiersOf(without(Q_FAVOURITES, "qf"))).toBeNull();
    expect(qualifiersOf([])).toBeNull();
    // A third-place match is no semifinal and no final: adding one changes nothing.
    expect([...qualifiersOf([...Q_FAVOURITES, line("q3p", 3, "E4", "E3", "completed", win("E3"), true)])!].sort()).toEqual(["E1", "E2", "E3", "E4"]);
  });

  it("the best loser below the cut is the latest round lost, then the better seed - and it differs between the two brackets (the ladder has an ordering witness)", () => {
    const fav = qualifiersOf(Q_FAVOURITES)!;
    // E5..E8 lost the quarter-finals; E5 is the best seed among them. E4 is the one who left.
    expect(bestLoser(Q_FAVOURITES, fav, "E4", seedOfE)).toBe("E5");
    // The upset: E1 lost in round 1 to E8 - the best seed of the non-qualifiers, so seed order is what decides.
    const up = qualifiersOf(Q_UPSET)!;
    expect(bestLoser(Q_UPSET, up, "E8", seedOfE)).toBe("E1");
    // A later round beats a better seed: a semifinal loser who did not qualify would draw before any quarter-final loser. Here the cut is
    // narrowed by hand (the final's two only) so the semifinal losers are non-qualifiers; E3 (seed 3) and E4 (seed 4) lost round 2.
    expect(bestLoser(Q_FAVOURITES, new Set(["E1", "E2"]), "E9", seedOfE)).toBe("E3");
    // A walkover loser never draws (RB4-V5): E1's quarter-final defeat by walkover leaves E5 the best.
    const walked = swap(Q_UPSET, "q1", { outcome: walkover("E8", "E1"), status: "forfeited" });
    expect(bestLoser(walked, up, "E8", seedOfE)).toBe("E5");
    // The empty case: nobody to draw.
    expect(bestLoser([], new Set(), "E4", seedOfE)).toBeNull();
    expect(bestLoser(Q_FAVOURITES, new Set(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]), "E4", seedOfE)).toBeNull();
  });

  it("the recorded product shape passes in both brackets, and the check examines 7 + the other qualifiers + one item per main-draw line - counted", () => {
    const fav = luckyLoserItems(luckyObs());
    expect(failing(fav)).toEqual([]);
    expect(fav.length).toBe(7 + (R6_CUT - 1) + M_LUCKY_E5.length);
    expect(assertion("w4a-r6-lucky-loser-takes-the-seat", fav)).toMatchObject({ verdict: "pass", checked: 7 + (R6_CUT - 1) + M_LUCKY_E5.length });
    const up = luckyLoserItems(luckyObs({ departed: "E8", qualifying: Q_UPSET, main: M_LUCKY_E1 }));
    expect(failing(up)).toEqual([]);
    expect(up.length).toBe(7 + (R6_CUT - 1) + M_LUCKY_E1.length);
  });

  it("the differential: seating E5 when E1 is the best loser fails, and seating E1 when E5 is fails - the check witnesses WHO, not just that someone", () => {
    const wrongInUpset = luckyLoserItems(luckyObs({ departed: "E8", qualifying: Q_UPSET, main: [line("m1", 1, "E2", "E5"), line("m2", 1, "E4", "E3"), line("mf", 2, null, null)] }));
    expect(failing(wrongInUpset).some((n) => /best loser below the cut \(E1\) is not seated/.test(n))).toBe(true);
    const wrongInFavourites = luckyLoserItems(luckyObs({ main: [line("m1", 1, "E1", "E9"), line("m2", 1, "E2", "E3"), line("mf", 2, null, null)] }));
    expect(failing(wrongInFavourites).length).toBeGreaterThan(0);
  });

  it("each way the product can mishandle the vacancy fails the item that names it", () => {
    const cases: readonly [string, LuckyObs, RegExp][] = [
      ["the departed qualifier is still seated", luckyObs({ main: [line("m1", 1, "E1", "E4"), line("m2", 1, "E2", "E3"), line("mf", 2, null, null)] }), /the departed E4 is still seated/],
      ["the seat is left empty (the opponent walked over)", luckyObs({ main: [line("m1", 1, "E1", null, "forfeited", walkover("E1", "E4")), line("m2", 1, "E2", "E3"), line("mf", 2, "E1", null)] }), /withdrawal walkover in the main draw/],
      ["only three are seated", luckyObs({ main: [line("m1", 1, "E1", null), line("m2", 1, "E2", "E3"), line("mf", 2, null, null)] }), /seats 3 entrant\(s\), expected the cut's 4/],
      ["a qualifier is missing from the main draw", luckyObs({ main: [line("m1", 1, "E5", "E6"), line("m2", 1, "E2", "E3"), line("mf", 2, null, null)] }), /qualifier E1 is not seated/],
      ["the cut is not the width this script reads", luckyObs({ cut: 8 }), /cut is 8 wide, this script reads a 4-wide one/],
      ["the withdrawn player was not a qualifier", luckyObs({ departed: "E7" }), /was not one of the four qualifiers/],
      ["the qualifying stage is not finished", luckyObs({ qualifying: without(Q_FAVOURITES, "qf") }), /final and semifinals are not all decided/],
    ];
    let proven = 0;
    for (const [what, obs, why] of cases) {
      const items = luckyLoserItems(obs);
      expect(items.length, `${what}: counted`).toBeGreaterThan(0);
      expect(failing(items).some((n) => why.test(n)), `${what}: ${JSON.stringify(failing(items))}`).toBe(true);
      proven++;
    }
    expect(proven).toBe(cases.length);
    expect(cases.length).toBe(7);
  });

  it("an unreadable qualifying stage still reports the items it examined and fails them by name - the empty case is a failure, never a pass", () => {
    const items = luckyLoserItems(luckyObs({ qualifying: [] }));
    expect(items.length).toBe(3);
    expect(assertion("w4a-r6-lucky-loser-takes-the-seat", items).verdict).toBe("fail");
  });
});

// --- the scripts, run on the knockout fake: what a driver or a product that does not answer the way the rulebook says looks like -----

/** The knockout fake with a LATE add that appends (the stock fake replaces the roster): it answers the new row and, like an old
 *  product, no `late_entry` - the shape R2 must name as a red rather than read past. The division's first roster goes in as stock. */
class AppendOnlyDriver extends FakeKnockoutDriver {
  override async addEntrants(d: string, es: readonly EntrantInput[]): Promise<EntrantRow[]> {
    if (this.entrants.length === 0) return super.addEntrants(d, es); // the division's own roster, as the stock fake takes it
    const e = es[0]!;
    const row: EntrantRow = { id: `e${this.entrants.length + 1}`, display_name: e.displayName, seed: e.seed, status: "registered", kind: e.kind };
    this.entrants = [...this.entrants, row];
    return [{ ...row }];
  }
}

function ctxOn(driver: FakeKnockoutDriver, key: W4aScenarioKey, row: "knockout" | "qualifying_main"): ScenarioContext {
  const spec: CaseSpec = { caseId: `${row}|generic|score|${key}`, row, sport: "generic", variant: "score", scenario: key, canary: false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg("generic", "score"), tag: "t", denied: [] };
}

describe("the scripts on the knockout fake - the refusals the harness owes by name", () => {
  it("R2: a product that answers the add with no late_entry is a red named so, with its one item counted, and the run still plays out", async () => {
    const out = await SCENARIOS.W4A_R2.run(ctxOn(new AppendOnlyDriver({ singleElim: true }), "W4A_R2", "knockout"));
    const own = out.assertions.find((a) => a.id === "w4a-r2-late-entry-placed");
    expect(own).toMatchObject({ verdict: "fail", checked: 1 });
    expect(own?.reason).toMatch(/the add answered no late_entry/);
    // The standard life checks ran beside it (the run was not abandoned at the red): every one reports what it examined.
    const ids = out.assertions.map((a) => a.id);
    expect(ids.length).toBeGreaterThan(5);
    expect(ids).toContain("w4a-r2-late-entry-placed");
  });

  it("R2: the same fake with the stock replacing add reaches the same red, never a pass on an empty answer", async () => {
    // The stock fake answers the whole replaced roster (one row, the newcomer), again with no late_entry.
    const out = await SCENARIOS.W4A_R2.run(ctxOn(new FakeKnockoutDriver({ singleElim: true }), "W4A_R2", "knockout"));
    const own = out.assertions.find((a) => a.id === "w4a-r2-late-entry-placed");
    expect(own?.verdict).toBe("fail");
    expect(own?.checked).toBeGreaterThan(0);
  });

  it("R10: a driver with no Reinstate or tap is refused by name (DriverMisuse), never run as a pass on nothing", async () => {
    const driver = new FakeKnockoutDriver({ singleElim: true });
    expect((driver as { reinstate?: unknown }).reinstate).toBeUndefined();
    expect((driver as { placeLateEntrant?: unknown }).placeLateEntrant).toBeUndefined();
    await expect(SCENARIOS.W4A_R10.run(ctxOn(driver, "W4A_R10", "knockout"))).rejects.toThrow(DriverMisuse);
    await expect(SCENARIOS.W4A_R10.run(ctxOn(new FakeKnockoutDriver({ singleElim: true }), "W4A_R10", "knockout"))).rejects.toThrow(/W4A_R10 needs reinstate and placeLateEntrant/);
  });
});
