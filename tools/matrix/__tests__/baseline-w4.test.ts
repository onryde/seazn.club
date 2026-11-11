// W4 knockout app B, Task 17 (T8-d): the committed L3 baseline is the W4 truth run (truth-runs/w4-final, CI 42992170592), and the 33
// W4 baseline reds of the W3 run are retired in it, counted by id:
//   - ko_plate F1 x11 (the plate model, RB4-P*): works.
//   - stepladder_only R4 x11 and page_playoff_only R4 x11: no longer cases. The product refuses a standalone stepladder or page
//     playoff (owner ruling 269, RB4-S6), so no layer plans them: the refusal is read from the engine's own declaration
//     (catalogue.ts refusedCell), never from the run.
// The 33 ids are MEASURED from the W3 baseline (w3-final), the run that held them red: not typed from the new results.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_ONLY_ROWS, SPORT_KEYS, STANDALONE_REFUSED_REASON, refusedCell, type RowKey } from "../lib/catalogue.ts";
import { baselineL3Path } from "../lib/pr-sample.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";

interface Case { caseId: string; row: string; state: string; scenario: string }
const cases = (dir: string, layer: string): Case[] =>
  (JSON.parse(readFileSync(resolve(REPO, TRUTH_RUNS, dir, "ci", layer, "results.json"), "utf8")) as { cases: Case[] }).cases;

const W3 = cases("w3-final", "L3");
const BASELINE = JSON.parse(readFileSync(resolve(REPO, baselineL3Path()), "utf8")) as { runId: string; cases: Case[] };
const NOW = new Map(BASELINE.cases.map((c) => [c.caseId, c]));

/** The W3 reds this task retires, measured from the W3 run itself. */
const KO_PLATE_F1 = W3.filter((c) => c.row === "ko_plate" && c.scenario === "F1" && c.state === "red").map((c) => c.caseId);
const STANDALONE_R4 = W3.filter((c) => (c.row === "stepladder_only" || c.row === "page_playoff_only") && c.scenario === "R4" && c.state === "red").map((c) => c.caseId);

describe("W4 T17: the committed L3 baseline is the W4 truth run", () => {
  it("baseline.json names truth-runs/w4-final/ci/L3, and the run it holds is the W4 run, not W3's", () => {
    expect(baselineL3Path()).toBe(resolve(REPO, TRUTH_RUNS, "w4-final", "ci", "L3", "results.json"));
    expect(BASELINE.runId).toBe("ci-42992170592-1-l3");
    expect(BASELINE.cases.length, "anti-vacuity: the baseline holds cases").toBeGreaterThan(800);
  });

  it("the 33 W4 baseline reds are measured from the W3 run: 11 ko_plate F1, 11 stepladder_only R4, 11 page_playoff_only R4 (one per sport)", () => {
    expect(SPORT_KEYS.length).toBe(11);
    expect(KO_PLATE_F1.length).toBe(11);
    expect(STANDALONE_R4.length).toBe(22);
    expect(new Set([...KO_PLATE_F1, ...STANDALONE_R4]).size).toBe(33);
    expect(new Set(KO_PLATE_F1.map((id) => id.split("|")[1])).size, "one ko_plate F1 per sport").toBe(11);
  });

  it("the committed baseline holds no ko_plate F1 red: every one of the 11 ids is works (counted by id)", () => {
    let checked = 0;
    for (const id of KO_PLATE_F1) {
      expect(NOW.get(id)?.state, id).toBe("works");
      checked++;
    }
    expect(checked, "anti-vacuity: 11 ids checked").toBe(11);
    // the row as a whole, not only F1: no ko_plate case is red in any scenario (LIFECYCLE / M1 / R4 were the msample lane's)
    const row = BASELINE.cases.filter((c) => c.row === "ko_plate");
    expect(row.length, "12 LIFECYCLE (cricket runs two) + 11 each of M1 R4 F1").toBe(45);
    expect(row.filter((c) => c.state !== "works").map((c) => c.caseId)).toEqual([]);
  });

  it("every one of the 22 standalone stepladder / page playoff R4 reds is retired: refused by the product (ruling 269) and absent from the baseline", () => {
    let checked = 0;
    for (const id of STANDALONE_R4) {
      const [row, sport] = id.split("|") as [RowKey, string];
      // the product's own declaration (a ⛔ cell, no layer plans a case on it), not the run's silence
      expect(refusedCell(row, sport), `${id}: the product refuses this cell`).toBe(STANDALONE_REFUSED_REASON);
      expect(NOW.has(id), `${id} is not a case of the W4 baseline`).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity: 22 ids checked").toBe(22);
    // the whole row is gone, every scenario, so no sibling cell kept the red alive
    expect(BASELINE.cases.filter((c) => c.row === "stepladder_only" || c.row === "page_playoff_only")).toEqual([]);
    // the pair: the other API-only rows are still offered where they were
    expect(API_ONLY_ROWS.filter((r) => SPORT_KEYS.some((s) => refusedCell(r, s) === null)).sort()).toEqual(["group_group_ko", "group_only", "knockout_third_place"]);
  });

  it("nothing ELSE the W3 baseline held works went red in W4 (the judge's regression, counted over the whole L3)", () => {
    let compared = 0;
    const regressed: string[] = [];
    for (const old of W3) {
      const now = NOW.get(old.caseId);
      if (now === undefined) continue; // the 79 retired rows, covered above and by the committed expected-skips list
      compared++;
      if (old.state === "works" && now.state !== "works") regressed.push(old.caseId);
    }
    expect(compared, "anti-vacuity").toBe(851);
    expect(regressed).toEqual([]);
  });
});
