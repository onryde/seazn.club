// W5 app PR A, Task 24 (T5-g): the drops on the seven round-robin rows, re-reasoned from the rows' STRUCTURE.
//
// catalogue/drop-list.json is the generated output of lib/applicability.ts (gen-catalogue.ts). A test that reads the rules back to the drop list proves
// the generator, not the drops. This file types, by hand and from what each row IS (its stages, in order), which of the fifteen structural scenarios
// can happen on it, and holds the committed drop list to that: every one of the 15 x 7 cells, on all eleven sports. The structure table is itself held
// to the catalogue's real stage bodies, so a row that gains or loses a stage reds here by name instead of leaving a stale drop standing.
//
// The sport-driven scenarios (a team entrant, a pair, a tie decider, ...) do not look at the row at all: they must drop the same sports on every one of
// the seven rows. M5 (a level result a stage refuses) is the one row-AND-sport scenario: a table-only row accepts every draw, so it drops every sport.
// Also pinned: no cell on group_only or group_group_ko is a row-level "no organiser control" at L2 (X-BD-2, X-BD-3).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS, cellId, stagesForRow } from "../lib/catalogue.ts";
import { LAYER_GRID_PLANNERS, identityOf } from "../lib/layers.ts";
import { PR_SAMPLE_SET, parseRows, planPrSample } from "../lib/pr-sample.ts";
import { W5A_SCENARIO_KEYS } from "../lib/scenarios/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { REPO } from "./committed-plans.ts";
import { isNoOrganiserPathCell } from "./refused-cells.ts";

interface DropGroup { scenario: string; kind: string; reason: string; count: number; cells: Record<string, string[]> }
const DROP = JSON.parse(readFileSync(resolve(REPO, "tools/matrix/catalogue/drop-list.json"), "utf8")) as { groups: DropGroup[] };

/** What each of the seven rows IS, typed here (design section 5, the format picker's own descriptions) and checked against stagesForRow below. */
interface Structure {
  /** The stage kinds in order. */
  readonly stages: readonly string[];
  /** A stage is split into pools. */
  readonly pooled: boolean;
  /** A later stage takes its entrants from an earlier stage's points table. */
  readonly tableFed: boolean;
  /** A stage is a knockout or double-elimination bracket (a page playoff and a stepladder are NOT: they are fed ladders). */
  readonly bracket: boolean;
  /** Entrants are placed by seed somewhere: a pool draw, or a stage seeded from the table. */
  readonly seeded: boolean;
  /** The row ends on a deciding match (a final, a page playoff's grand final, a stepladder's last rung), not on a table. */
  readonly final: boolean;
}
const STRUCTURE: Readonly<Record<string, Structure>> = {
  league: { stages: ["league"], pooled: false, tableFed: false, bracket: false, seeded: false, final: false },
  group_only: { stages: ["group"], pooled: true, tableFed: false, bracket: false, seeded: true, final: false },
  league_ko: { stages: ["league", "knockout"], pooled: false, tableFed: true, bracket: true, seeded: true, final: true },
  groups_ko: { stages: ["group", "knockout"], pooled: true, tableFed: true, bracket: true, seeded: true, final: true },
  group_group_ko: { stages: ["group", "group", "knockout"], pooled: true, tableFed: true, bracket: true, seeded: true, final: true },
  group_playoffs: { stages: ["league", "page_playoff"], pooled: false, tableFed: true, bracket: false, seeded: true, final: true },
  group_stepladder: { stages: ["league", "stepladder"], pooled: false, tableFed: true, bracket: false, seeded: true, final: true },
};
const ROWS = Object.keys(STRUCTURE);

/** The fifteen structural scenarios: does the scenario CAN happen on a row with this structure? Each line is the reason the drop reason gives, as a fact. */
const APPLIES: Readonly<Record<string, (s: Structure) => boolean>> = {
  F3: (s) => s.bracket, // a field sized to a power of two: only a bracket has one
  F4: (s) => s.pooled, // unequal pools: needs pools
  F8: (s) => s.seeded, // seeded placement: needs a seed to place
  P2: (s) => s.tableFed, // a qualifier from a table into the next stage
  Q1a: (s) => s.tableFed, // a qualifying tie decided by lots: needs a table cut
  Q1b: (s) => s.tableFed, // the same, decided by the organiser
  Q2: (s) => s.tableFed, // nobody qualifies from a table without a table feeding on
  Q3: () => false, // a LONE knockout stage with a third-place choice: none of the seven is a single bracket
  Q4a: (s) => s.final, // the final not played: needs a final
  Q4b: (s) => s.final && s.tableFed, // fall back to the table when the final is not played: the final must be fed by one
  Q5a: () => false, // a plate stage: none of the seven has one
  Q5b: () => false,
  R6: (s) => s.stages.length > 1, // a withdrawal into a later stage: needs a later stage
  R15: () => false, // still paired next round: swiss / americano / mexicano only, none of the seven
  P5b: () => false, // pair-next-round and its undo: swiss only
};

describe("T5-g: the structure table is the catalogue's own (so a stale drop cannot hide behind a stale table)", () => {
  it("each of the seven rows has the stage kinds the table says, in order, and the table's flags follow from them", () => {
    let checked = 0;
    for (const row of ROWS) {
      const kinds = stagesForRow(row).map((s) => String(s.kind));
      expect(kinds, row).toEqual([...STRUCTURE[row]!.stages]);
      expect(STRUCTURE[row]!.bracket, `${row}: bracket`).toBe(kinds.some((k) => k === "knockout" || k === "double_elim"));
      expect(STRUCTURE[row]!.tableFed, `${row}: tableFed`).toBe(kinds.length > 1);
      checked++;
    }
    expect(checked).toBe(7);
  });
});

describe("T5-g: every drop of the fifteen structural scenarios on the seven rows is the structure's, on every sport", () => {
  const sportsDropped = (scenario: string, row: string): Set<string> => {
    const out = new Set<string>();
    for (const g of DROP.groups) if (g.scenario === scenario) for (const s of g.cells[row] ?? []) out.add(s);
    return out;
  };

  it("105 cells (15 scenarios x 7 rows): dropped on all eleven sports exactly when the structure says the scenario cannot happen, and on none otherwise", () => {
    expect(SPORT_KEYS.length).toBe(11);
    let checked = 0;
    let dropped = 0;
    let kept = 0;
    for (const [scenario, applies] of Object.entries(APPLIES)) {
      for (const row of ROWS) {
        const got = sportsDropped(scenario, row);
        const want = applies(STRUCTURE[row]!);
        expect([...got].sort(), `${scenario} on ${row}: ${want ? "applies, so no sport is dropped" : "cannot happen, so every sport is dropped"}`).toEqual(want ? [] : [...SPORT_KEYS].sort());
        checked++;
        if (want) kept++; else dropped++;
      }
    }
    expect(checked).toBe(Object.keys(APPLIES).length * ROWS.length);
    expect(checked).toBe(105);
    // both arms were reached: the table is not "everything dropped" nor "nothing dropped"
    expect(dropped).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
  });

  it("every drop is `inapplicable` with a reason that names the structure; no harness-gap or unscorable drop sits on a W5 row", () => {
    let checked = 0;
    for (const g of DROP.groups) {
      if (!ROWS.some((r) => g.cells[r] !== undefined)) continue;
      expect(g.kind, g.scenario).toBe("inapplicable");
      expect(g.reason.length, g.scenario).toBeGreaterThan(20);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a scenario the table lists is dropped only on the seven rows' structure: the SAME scenario's drop on a row outside them is not this table's to judge, but never leaks in", () => {
    // every drop group of a listed scenario is a whole-row group: a sport subset on one of the seven rows would be a sport-driven rule hiding in a structural one
    let checked = 0;
    for (const g of DROP.groups) {
      if (!(g.scenario in APPLIES)) continue;
      for (const row of ROWS) {
        const sports = g.cells[row];
        if (sports === undefined) continue;
        expect(sports.length, `${g.scenario} on ${row}`).toBe(SPORT_KEYS.length);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("T5-g: the sport-driven scenarios do not look at the row", () => {
  // Scenarios whose drop is a fact of the SPORT (entrant model, a tie decider, a retired-hurt event, a best-of): the seven rows must drop the same sports.
  const SPORT_DRIVEN = ["M12a", "M12b", "M12c", "M4b", "M6", "P6", "R11b", "R12a", "R12b", "R16", "R9a", "R9b"];
  const droppedOn = (scenario: string, row: string): string[] => [...new Set(DROP.groups.filter((g) => g.scenario === scenario).flatMap((g) => g.cells[row] ?? []))].sort();

  it("each of 12 sport-driven scenarios drops the same sports on all seven rows, and at least one sport", () => {
    let checked = 0;
    for (const sc of SPORT_DRIVEN) {
      const first = droppedOn(sc, ROWS[0]!);
      expect(first.length, `${sc}: drops some sport`).toBeGreaterThan(0);
      for (const row of ROWS) {
        expect(droppedOn(sc, row), `${sc} on ${row} drops what it drops on ${ROWS[0]}`).toEqual(first);
        checked++;
      }
    }
    expect(checked).toBe(SPORT_DRIVEN.length * ROWS.length);
  });

  it("M5 (a level result a stage refuses): a table-only row accepts every draw so every sport is dropped; the five rows with a bracket or a ladder drop the same, smaller set", () => {
    const tableOnly = ROWS.filter((r) => !STRUCTURE[r]!.tableFed);
    expect(tableOnly.sort()).toEqual(["group_only", "league"]);
    for (const row of tableOnly) expect(droppedOn("M5", row), row).toEqual([...SPORT_KEYS].sort());
    const fed = ROWS.filter((r) => STRUCTURE[r]!.tableFed);
    const first = droppedOn("M5", fed[0]!);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length, "the fed rows keep at least one sport the stage can refuse a draw for").toBeLessThan(SPORT_KEYS.length);
    for (const row of fed) expect(droppedOn("M5", row), row).toEqual(first);
    expect(fed.length).toBe(5);
  });
});

describe("T5-g: group_only and group_group_ko have no row-level no-organiser-path cell at L2 (X-BD-2, X-BD-3)", () => {
  const cases = LAYER_GRID_PLANNERS.L2({}).layered(offlineBuilderDefault);

  it("no sport's cell on either row is a no-organiser-path cell, and no L2 run on them is 🚫 for want of a control that builds the row", () => {
    let cells = 0;
    for (const row of ["group_only", "group_group_ko"]) for (const sport of SPORT_KEYS) {
      expect(isNoOrganiserPathCell(cellId(row as never, sport)), `${row}|${sport}`).toBe(false);
      cells++;
    }
    expect(cells).toBe(2 * SPORT_KEYS.length);
    let runs = 0;
    let nopath = 0;
    let cardFieldRuns = 0;
    for (const c of cases) {
      const id = identityOf(c);
      if (id.row !== "group_only" && id.row !== "group_group_ko") continue;
      runs++;
      if (c.spec !== null || c.noPath === null) continue;
      nopath++;
      // an atom-level 🚫 (design section 4: a screen for the scenario is owed, not for the row)
      // ...or the one scenario a card cannot seat: F1's odd field on super-groups' own 16 (truth run 44411389618), W5's, judged over HTTP.
      const cardField = /^no organiser path: the catalog card seeds its own field, /.test(c.noPath.reason);
      if (cardField) { cardFieldRuns++; expect(`${id.row}|${id.sport}|${id.scenario}`).toBe("group_group_ko|football|F1"); }
      else expect(c.noPath.reason, `${id.row}|${id.sport}|${id.scenario}`).toMatch(/^(no organiser path, known at design time|the HTTP route exists and no screen sends it) /);
      expect(c.noPath.reason, `${id.row}|${id.sport}|${id.scenario}`).not.toMatch(/no organiser control builds/);
    }
    // not vacuous: the rows have runs at L2, and the atom-level 🚫 arm was reached (so the reason check ran)
    expect(runs).toBeGreaterThan(0);
    expect(nopath).toBeGreaterThan(0);
    expect(cardFieldRuns, "the card-field arm was reached, once").toBe(1);
  });
});

describe("T5-g: a PR that declares a round-robin row gets a sample on it (pr-sample)", () => {
  it("each of the seven rows is a declarable row, plans at least one case on it, and the opt-in W5A scripts stay out of the per-PR sample", () => {
    expect(PR_SAMPLE_SET).toBe("pr-sample");
    let checked = 0;
    for (const row of ROWS) {
      expect(parseRows(row), row).toEqual([row]);
      const sample = planPrSample([row], offlineBuilderDefault);
      const own = sample.filter((c) => c.row === row);
      expect(own.length, `${row}: the sample holds cases on the declared row`).toBeGreaterThan(0);
      // the W5A scripts are opt-in (`--set w1-driving --scenario W5A_*`): a PR sample must not pull them in unasked
      for (const c of sample) expect((W5A_SCENARIO_KEYS as readonly string[]).includes(c.scenario), `${c.caseId}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(7);
  });
});
