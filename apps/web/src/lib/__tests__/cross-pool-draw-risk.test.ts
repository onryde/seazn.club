// W5 app PR B Task 5 part 3 (RB5-D10, X-PD-4; controller ruling, owner standing "apply rec"): the builder warns before Start that a
// format's knockout draw can be refused. Expected values are the RULEBOOK's (cross-sport.md X-PD-2, X-PD-4), never the module's:
// - X-PD-4 names it: "with two pools, the winners plus the best runner-up into a 4-draw ... is refused, and stays refused";
// - X-PD-4's mechanism (pool winners keep their fold places; swaps only inside a later tier) refuses three pools' winners and the one
//   best runner-up into a 4-draw too: that runner-up holds seed 4 and meets seed 1, Group A's winner, whenever she is A2;
// - X-PD-2: whole pool places (A1 v B2, B1 v A2; three pools top two by rotation) always separate, so a format with no best-Nth seat
//   never warns.
// Pure: no DB, no DOM.
import { describe, expect, it } from "vitest";
import { DRAW_SEARCH_BUDGET, crossPoolDrawCanRefuse, drawSearchSpace } from "@/lib/cross-pool-draw-risk";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { STAGE_TEMPLATES, buildTemplateStages, type StageDraft } from "@/lib/format-templates";

const knobs = (poolCount: number, qualified: number) => ({ qualified, poolCount, swissRounds: 3, legs: 1 });
const drafts = (key: string, poolCount: number, qualified: number) => buildTemplateStages(key, knobs(poolCount, qualified));
const hasBestNth = (stages: readonly StageDraft[]) => stages.some((s) => s.progression?.sources.some((src) => src.take.some((t) => t.kind === "bestNth")) ?? false);

describe("crossPoolDrawCanRefuse: the builder's RB5-D10 warning, asked of the engine", () => {
  it("X-PD-4's named case: groups_ko, two pools, Top 3 (the winners and the best runner-up into a 4-draw) warns", () => {
    expect(hasBestNth(drafts("groups_ko", 2, 3)), "the premise: Top 3 from two pools takes a best runner-up").toBe(true);
    expect(crossPoolDrawCanRefuse(drafts("groups_ko", 2, 3))).toBe(true);
  });

  it("X-PD-4's mechanism: three pools, Top 4 (three winners and one best runner-up into a 4-draw) warns too", () => {
    expect(crossPoolDrawCanRefuse(drafts("groups_ko", 3, 4))).toBe(true);
  });

  it("X-PD-2: whole pool places always separate - two pools Top 2 and Top 4, three pools Top 3 and Top 6 never warn", () => {
    for (const [p, q] of [[2, 2], [2, 4], [3, 3], [3, 6]] as const) {
      expect(hasBestNth(drafts("groups_ko", p, q)), `${p} pools Top ${q}: no best-Nth seat`).toBe(false);
      expect(crossPoolDrawCanRefuse(drafts("groups_ko", p, q)), `${p} pools Top ${q}`).toBe(false);
    }
  });

  it("the empty case and the fields the draw never runs on: no stages, one stage, a league source, an organiser's own seats", () => {
    expect(crossPoolDrawCanRefuse([])).toBe(false);
    expect(crossPoolDrawCanRefuse(drafts("groups_ko", 2, 3).slice(0, 1))).toBe(false);
    for (const key of ["group_stepladder", "group_playoffs", "league_ko"]) {
      for (let q = FORMAT_BOUNDS.qualify.min; q <= 8; q++) expect(crossPoolDrawCanRefuse(drafts(key, 2, q)), `${key} Top ${q}: a league has no pools`).toBe(false);
    }
    const mapped = drafts("groups_ko", 2, 3).map((s) => (s.progression === null ? s : { ...s, progression: { ...s.progression, placement: "seeded_map" as const } }));
    expect(crossPoolDrawCanRefuse(mapped as StageDraft[]), "seeded_map: the organiser's own seats are never drawn").toBe(false);
  });

  it("another refusal is not this warning's: a page playoff of six from two pools is refused for its size, never for pool separation", () => {
    // The engine refuses a page playoff not of four (`page_playoff_needs_four`); the size gates say that, not this line.
    const six = drafts("groups_ko", 2, 6).map((s) => (s.kind === "knockout" ? { ...s, kind: "page_playoff" as const } : s));
    expect(six.map((s) => s.kind), "premise: groups feed a page playoff").toEqual(["group", "page_playoff"]);
    expect(crossPoolDrawCanRefuse(six as StageDraft[])).toBe(false);
  });

  it("the builder never waits on the engine's longest searches: past DRAW_SEARCH_BUDGET it stays silent, at once", () => {
    // 5 pools Top 31: every pool's top six and one best seventh - five later tiers of five seats, (5!)^5 orderings (measured: one
    // engine call past 190 s). The named case sits far inside the budget (one later tier of one seat).
    expect(drawSearchSpace(new Map([[1, 2], [2, 1]])), "two pools' winners and one best runner-up").toBe(1);
    expect(drawSearchSpace(new Map([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 1]]))).toBeGreaterThan(DRAW_SEARCH_BUDGET);
    const started = Date.now();
    expect(crossPoolDrawCanRefuse(drafts("groups_ko", 5, 31))).toBe(false);
    expect(Date.now() - started, "answered without asking the engine").toBeLessThan(1000);
  });

  it("sweep: every template x pools x Top the builder offers - a warning only where a best-Nth seat is taken (X-PD-2), counted", () => {
    let checked = 0;
    const warned: string[] = [];
    for (const t of STAGE_TEMPLATES) {
      for (let p = FORMAT_BOUNDS.pools.min; p <= FORMAT_BOUNDS.pools.max; p++) {
        for (let q = FORMAT_BOUNDS.qualify.min; q <= FORMAT_BOUNDS.qualify.max; q++) {
          const stages = drafts(t.key, p, q);
          checked++;
          if (!crossPoolDrawCanRefuse(stages)) continue;
          warned.push(`${t.key} ${p}/${q}`);
          expect(hasBestNth(stages), `${t.key} ${p} pools Top ${q} warns, so it takes a best-Nth seat`).toBe(true);
        }
      }
    }
    expect(checked, "anti-vacuity").toBe(STAGE_TEMPLATES.length * (FORMAT_BOUNDS.pools.max - FORMAT_BOUNDS.pools.min + 1) * (FORMAT_BOUNDS.qualify.max - FORMAT_BOUNDS.qualify.min + 1));
    expect(warned, "the rulebook's two named shapes are among the warnings").toEqual(expect.arrayContaining(["groups_ko 2/3", "groups_ko 3/4"]));
    console.info(`cross-pool draw risk sweep: ${checked} shapes, ${warned.length} warn: ${warned.join(", ")}`);
  });
});
