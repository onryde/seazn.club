// W5 round-robin app PR A, Task 25 (T5-d): the committed L3 baseline is the W5 truth run (truth-runs/w5-app-a, CI 44395599687, harness commit
// 552b8d7f0d), counted against the W4 run it replaces (truth-runs/w4-final, the baseline until this task). Every figure below is MEASURED from the
// two committed runs or read from the product's own declarations (catalogue.ts), never typed from the new results:
//   - triple_rr is deleted (ruling 287, W5 T16): its 46 L3 cases are no longer cases, and the row is gone from the catalogue;
//   - no case the W4 baseline held (works / refused) is held no longer (the judge's regression, counted over the whole L3);
//   - group_group_ko F1 x11: the pre-W5 failure (a pool of one drawn, ST-G5 / C38) is retired; the product refuses the field by name and the
//     case is judged on that refusal. In THIS run the 11 still read red, because the product's Start reached the cut's refusal first
//     (RR_CUT_EXCEEDS_FIELD, T12b) and the harness then wanted the pool of one's (a harness fault fixed with this commit, f1-odd-field.ts
//     cutBeyondFieldExpected): the next truth run renders them refused. So the figure pinned here is the RETIRED SIGNATURE, which holds in both.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { baselineL3Path } from "../lib/pr-sample.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";

interface Check { id: string; verdict: string; reason?: string }
interface Case { caseId: string; row: string; sport: string; scenario: string; state: string; reason?: string; checks: Check[] }
const read = (dir: string): { runId: string; cases: Case[] } => JSON.parse(readFileSync(resolve(REPO, TRUTH_RUNS, dir, "ci", "L3", "results.json"), "utf8")) as { runId: string; cases: Case[] };

const W4 = read("w4-final");
const W5 = read("w5-app-a");
const NOW = new Map(W5.cases.map((c) => [c.caseId, c]));
const HELD = new Set(["works", "refused"]);

describe("W5 T25: the committed L3 baseline is the W5 app A truth run", () => {
  it("baseline.json names truth-runs/w5-app-a/ci/L3, and the run it holds is the W5 run, not W4's", () => {
    expect(baselineL3Path()).toBe(resolve(REPO, TRUTH_RUNS, "w5-app-a", "ci", "L3", "results.json"));
    expect(W5.runId).toBe("ci-44395599687-1-l3");
    expect(W5.cases.length, "anti-vacuity: the baseline holds cases").toBeGreaterThan(800);
  });

  it("triple_rr is gone (ruling 287): its cases are measured from the W4 run, absent from the W5 run, and the row is not in the catalogue", () => {
    const retired = W4.cases.filter((c) => c.row === "triple_rr");
    // 11 sports; cricket runs its own variants too, so more than one case per sport. Counted from the W4 run, not typed.
    expect(retired.length, "anti-vacuity: the W4 run held triple_rr cases").toBeGreaterThanOrEqual(SPORT_KEYS.length);
    expect(new Set(retired.map((c) => c.sport)).size, "every sport had one").toBe(SPORT_KEYS.length);
    let checked = 0;
    for (const c of retired) {
      expect(NOW.has(c.caseId), `${c.caseId} is not a case of the W5 baseline`).toBe(false);
      checked++;
    }
    expect(checked).toBe(retired.length);
    expect(W5.cases.filter((c) => c.row === "triple_rr")).toEqual([]);
    expect((ROW_KEYS as readonly string[]).includes("triple_rr"), "the product's own row list").toBe(false);
  });

  it("nothing the W4 baseline held went unheld in W5: the judge's regression, counted over the whole L3, and no state moved at all", () => {
    let compared = 0;
    const regressed: string[] = [];
    const moved: string[] = [];
    for (const old of W4.cases) {
      const now = NOW.get(old.caseId);
      if (now === undefined) continue; // the retired rows above and cricket's renumbered variants (cricket#NNN), covered by the committed expected-skips list
      compared++;
      if (HELD.has(old.state) && !HELD.has(now.state)) regressed.push(old.caseId);
      if (old.state !== now.state) moved.push(`${old.caseId}: ${old.state} -> ${now.state}`);
    }
    expect(compared, "anti-vacuity: the cases both runs hold").toBeGreaterThan(700);
    expect(regressed).toEqual([]);
    // The expected ❌ -> ⛔ move of the 11 group_group_ko F1 cases is NOT in this run (see the header): none moved.
    expect(moved).toEqual([]);
    // The cricket variants carry a running index in their ids, so a row's addition or removal renumbers them: 6 left, 7 came.
    const dropped = W4.cases.filter((c) => !NOW.has(c.caseId) && c.row !== "triple_rr");
    expect(dropped.every((c) => c.caseId.includes("|cricket#")), dropped.map((c) => c.caseId).join(", ")).toBe(true);
  });

  it("group_group_ko F1 x11: the pre-W5 failure (a pool of one, never drawn, 409 STAGE_COMPLETED_SEEDING_FAILED) is retired, and the product's refusal is the answer", () => {
    const was = W4.cases.filter((c) => c.row === "group_group_ko" && c.scenario === "F1");
    const now = W5.cases.filter((c) => c.row === "group_group_ko" && c.scenario === "F1");
    expect(was.length, "one per sport").toBe(SPORT_KEYS.length);
    expect(now.length, "one per sport").toBe(SPORT_KEYS.length);
    // The W4 reds, measured: the failure the retired rule (ST-G5) names.
    for (const c of was) expect(c.checks.filter((k) => k.verdict === "fail").map((k) => k.id), c.caseId).toContain("f1-everyone-drawn");
    let checked = 0;
    for (const c of now) {
      const failing = c.checks.filter((k) => k.verdict === "fail").map((k) => k.id);
      // The signature is gone in whatever state the case reads: it no longer draws a pool of one.
      expect(failing, c.caseId).not.toContain("f1-everyone-drawn");
      expect(failing, c.caseId).not.toContain("I1-rr-pair-once-per-leg");
      const refusal = c.checks.find((k) => k.id === "f1-pool-of-one-refused");
      expect(refusal, `${c.caseId}: judged on the refusal`).toBeDefined();
      // Named by the product's answer: the cut's refusal (what Start reached first), whether the harness took it (refused) or not (red).
      expect(`${c.reason ?? ""} ${refusal!.reason ?? ""}`, c.caseId).toMatch(/RR_CUT_EXCEEDS_FIELD|cut of 8/);
      expect(["refused", "red"], c.caseId).toContain(c.state);
      checked++;
    }
    expect(checked, "anti-vacuity: 11 ids checked").toBe(SPORT_KEYS.length);
  });
});
