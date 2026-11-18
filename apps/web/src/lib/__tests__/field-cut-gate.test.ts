// W5 Task 12b (X-BD-8, RB5-E6): a cut larger than the field, or a best-Nth cut no pool can supply, is refused by name.
// The builder's Next and the server's Start / resolve doors ask the same function, so they say the same numbers (`max`).
// The ORACLE is the engine's own `resolveProgression` run over tables of the shape the generators make: a cut is supplied
// exactly when the engine can resolve it, so no expected value is derived from the gate under test. The pinned examples below
// are the brief's, typed from the rulebook.
import { describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { resolveProgression, type ProgressionSpec, type SourceTables, type StandingsRow } from "@seazn/engine/competition";
import { buildTemplateStages } from "../format-templates";
import { cutIssue, snakeSizes, stageGraphCutIssue, takeCutIssue } from "../field-cut-gate";

const CUT_TEMPLATES = ["league_ko", "groups_ko", "group_stepladder", "swiss_knockout"] as const;

const row = (entrantId: string, rank: number): StandingsRow => ({ entrantId, played: 3, won: 3 - rank, drawn: 0, lost: rank, points: 9 - rank, metrics: {}, rank });

/** The tables a source of `sizes` pools holds: one pool per size, ranks 1..size, every entrant distinct. */
function tablesOf(sizes: readonly number[], grouped: boolean): SourceTables {
  return {
    pools: sizes.map((size, p) => ({
      pool: grouped ? "ABCDEFGH"[p]! : "",
      rows: Array.from({ length: size }, (_, i) => row(`e${p}-${i + 1}`, i + 1)),
    })),
  };
}

/** Whether the ENGINE can resolve `template`'s cut at `qualified` over `entrants` snaked into `pools`: the oracle. */
function engineSupplies(template: string, entrants: number, pools: number, qualified: number): boolean {
  const drafts = buildTemplateStages(template, { qualified, swissRounds: 3, poolCount: pools, legs: 1 });
  const grouped = drafts[0]!.kind === "group";
  const sizes = grouped ? snakeSizes(entrants, pools) : [entrants];
  const spec = drafts[1]!.progression as unknown as ProgressionSpec;
  const shape = { poolKeys: grouped ? sizes.map((_, i) => "ABCDEFGH"[i]!) : [] };
  try {
    resolveProgression(spec, [shape], [tablesOf(sizes, grouped)], drafts[1]!.kind);
    return true;
  } catch (e) {
    if (EngineError.is(e)) return false;
    throw e;
  }
}

describe("cutIssue (X-BD-8): the brief's pinned cases", () => {
  it("X-BD-8 league_ko: a top 8 of 6 entrants is refused naming 6", () => {
    // differential: today the builder passes it (formatBoundIssue judged only FORMAT_BOUNDS, 2..32).
    expect(cutIssue(6, 2, 8, "league_ko")).toEqual({ reason: "cut_exceeds_field", qualified: 8, max: 6 });
  });

  it("X-BD-8 groups_ko: a best-Nth cut no pool can supply is refused (2 pools of 3, qualified 7 -> max 6)", () => {
    // 6 entrants in 2 pools of 3: a top 7 is 3 per pool and the best 4th, and no pool has a 4th - and 7 is more than the field's 6.
    expect(cutIssue(6, 2, 7, "groups_ko")).toEqual({ reason: "cut_exceeds_field", qualified: 7, max: 6 });
    // 7 entrants in pools of 4 and 3: the field holds 7, but the best 4th is only the 4-pool's - the other pool has no 4th.
    expect(cutIssue(7, 2, 7, "groups_ko")).toEqual({ reason: "bestnth_unsuppliable", qualified: 7, max: 6 });
  });

  it("X-BD-8 a cut equal to the field passes where the shape can supply it (pin: the off-by-one)", () => {
    expect(cutIssue(6, 2, 6, "league_ko")).toBeNull();
    expect(cutIssue(6, 2, 6, "swiss_knockout")).toBeNull();
    expect(cutIssue(6, 2, 6, "group_stepladder")).toBeNull();
    // 6 into 2 pools of 3 hands over all three per pool.
    expect(cutIssue(6, 2, 6, "groups_ko")).toBeNull();
    // ... and one under the field refuses when the pools are uneven: 7 in 4+3, the cut of 7 above, while 6 passes.
    expect(cutIssue(7, 2, 6, "groups_ko")).toBeNull();
    expect(cutIssue(6, 2, 7, "league_ko")).toEqual({ reason: "cut_exceeds_field", qualified: 7, max: 6 });
  });

  it("a template with no cut (the empty case: nothing to refuse) and an empty field are never refused", () => {
    let checked = 0;
    for (const template of ["league", "knockout", "swiss", "double_elim", "americano", "ladder", "ko_plate"]) {
      expect(cutIssue(3, 2, 8, template), template).toBeNull();
      checked++;
    }
    expect(checked).toBe(7);
    // No field yet: nobody registered, the Start doors say so by their own name.
    expect(cutIssue(0, 2, 8, "league_ko")).toBeNull();
  });

  it("refuses an input it cannot mean, by name (a fraction, a negative field, a pool count out of range)", () => {
    expect(() => snakeSizes(7.5, 2)).toThrow(RangeError);
    expect(() => snakeSizes(-1, 2)).toThrow(RangeError);
    expect(() => snakeSizes(7, 0)).toThrow(RangeError);
    expect(() => snakeSizes(7, 27)).toThrow(RangeError);
  });
});

describe("cutIssue (X-BD-8): the engine is the oracle, over the whole table", () => {
  it("sweep: every template x field 2..20 x pools 2..5 x Top N 2..24 agrees with what resolveProgression can resolve, with the exact max", () => {
    let checked = 0, refused = 0, exceeds = 0, bestNth = 0, supplied = 0;
    for (const template of CUT_TEMPLATES) {
      const poolCounts = template === "groups_ko" ? [2, 3, 4, 5] : [2];
      for (const pools of poolCounts) {
        for (let entrants = 2; entrants <= 20; entrants++) {
          for (let qualified = 2; qualified <= 24; qualified++) {
            const issue = cutIssue(entrants, pools, qualified, template);
            const can = engineSupplies(template, entrants, pools, qualified);
            checked++;
            expect(issue === null, `${template} ${entrants}/${pools} top ${qualified}: gate says ${JSON.stringify(issue)}, engine ${can ? "resolves" : "refuses"}`).toBe(can);
            if (issue === null) { supplied++; continue; }
            refused++;
            // The reason: more than the field holds, else a shape the pools cannot fill.
            expect(issue.reason, `${template} ${entrants}/${pools} top ${qualified}`).toBe(qualified > entrants ? "cut_exceeds_field" : "bestnth_unsuppliable");
            if (issue.reason === "cut_exceeds_field") exceeds++; else bestNth++;
            expect(issue.qualified).toBe(qualified);
            // `max` is the largest cut the engine resolves: it resolves at max, and at no cut above it up to the ask.
            expect(engineSupplies(template, entrants, pools, issue.max), `${template} ${entrants}/${pools}: the engine resolves max ${issue.max}`).toBe(true);
            for (let above = issue.max + 1; above <= qualified; above++) {
              expect(engineSupplies(template, entrants, pools, above), `${template} ${entrants}/${pools}: the engine refuses ${above} above max ${issue.max}`).toBe(false);
            }
          }
        }
      }
    }
    expect(checked, "anti-vacuity: every cell").toBe(3 * 19 * 23 + 4 * 19 * 23);
    expect(refused).toBeGreaterThan(0);
    expect(supplied).toBeGreaterThan(0);
    expect(exceeds, "both reasons reached").toBeGreaterThan(0);
    expect(bestNth, "both reasons reached").toBeGreaterThan(0);
  });
});

describe("takeCutIssue / stageGraphCutIssue: the same rule over a stored graph and a real table", () => {
  it("the stored graph is judged as the template is: one function, one answer", () => {
    // differential: the builder and the server judged nothing before. Both sides read the template's own drafts / a stored graph.
    let checked = 0;
    for (const template of CUT_TEMPLATES) {
      const pools = template === "groups_ko" ? 2 : 2;
      for (const [entrants, qualified] of [[6, 8], [7, 7], [6, 6], [8, 3]] as const) {
        const drafts = buildTemplateStages(template, { qualified, swissRounds: 3, poolCount: pools, legs: 1 });
        const stored = drafts.map((d, i) => ({ id: `s${i}`, ...d }));
        const fromGraph = stageGraphCutIssue(stored, entrants);
        const fromBuilder = cutIssue(entrants, pools, qualified, template);
        expect(fromGraph === null ? null : { reason: fromGraph.reason, qualified: fromGraph.qualified, max: fromGraph.max }, `${template} ${entrants}/${qualified}`).toEqual(fromBuilder);
        if (fromGraph !== null) expect(fromGraph.at, "the cut sits on the second stage").toBe(1);
        checked++;
      }
    }
    expect(checked).toBe(16);
  });

  it("a stage fed by an explicit stage id, and a fed (non-root) source, are read as the server stores them", () => {
    const stages = [
      { id: "a", kind: "league", config: {}, progression: null },
      { id: "b", kind: "knockout", config: {}, progression: { sources: [{ stage: { stageId: "a" }, take: [{ kind: "rankRange", from: 1, to: 8 }] }] } },
    ];
    expect(stageGraphCutIssue(stages, 6)).toEqual({ reason: "cut_exceeds_field", qualified: 8, max: 6, at: 1 });
    // A source that is itself fed has no field of the whole roster: not this gate's to judge.
    const fed = [
      { id: "a", kind: "league", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }] } },
      { id: "b", kind: "knockout", config: {}, progression: { sources: [{ stage: { stageId: "a" }, take: [{ kind: "rankRange", from: 1, to: 8 }] }] } },
    ];
    expect(stageGraphCutIssue(fed, 6)).toBeNull();
    // A fed page playoff seats four whatever the field: its size is `PAGE_PLAYOFF_TOO_FEW`'s (format-size-gates.ts), and its own day-one Generate is
    // deliberately not gated (T26c I1; usecases/__tests__/format-size-gates.test.ts pins that), so this gate leaves it alone at any field.
    let pages = 0;
    for (const template of ["group_playoffs", "swiss_playoff"]) {
      for (const n of [2, 3]) {
        const drafts = buildTemplateStages(template, { qualified: 4, swissRounds: 1, poolCount: 2, legs: 1 });
        expect(drafts[1]!.kind, template).toBe("page_playoff");
        expect(stageGraphCutIssue(drafts.map((d, i) => ({ id: `s${i}`, ...d })), n), `${template} at ${n}`).toBeNull();
        pages++;
      }
    }
    expect(pages).toBe(4);
    // A knockout source's cut is the whole-round rule's (KO_CUT_NOT_WHOLE_ROUND), never this one's.
    const ko = [
      { id: "a", kind: "knockout", config: {}, progression: null },
      { id: "b", kind: "knockout", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 8 }] }] } },
    ];
    expect(stageGraphCutIssue(ko, 6)).toBeNull();
  });

  it("a real table's sizes: pools of 4 and 2 hand over whole waves only (3 per pool needs a 3rd in every pool)", () => {
    // differential: the engine's rowAtRank says "pool B takes rank 3, but only 2 entrants are available" after the stage is played.
    expect(takeCutIssue([{ kind: "topNPerGroup", n: 3 }], [4, 2])).toEqual({ reason: "bestnth_unsuppliable", qualified: 6, max: 4 });
    expect(takeCutIssue([{ kind: "topNPerGroup", n: 2 }], [4, 2])).toBeNull();
    expect(takeCutIssue([{ kind: "rankRange", from: 1, to: 5 }], [4])).toEqual({ reason: "cut_exceeds_field", qualified: 5, max: 4 });
    // The empty cases: no pool at all, a take that asks for nothing.
    expect(takeCutIssue([{ kind: "rankRange", from: 1, to: 5 }], [])).toBeNull();
    expect(takeCutIssue([], [4])).toBeNull();
    expect(takeCutIssue([{ kind: "firstLosses" }], [4])).toBeNull();
  });
});
