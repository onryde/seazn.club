// W1d Task 3 (owner ruling 64, item 2): the FULL grid planners — `--layer L1
// --scope grid` is one LIFECYCLE case per catalogue cell at 1280 (231), and
// `--layer L2 --scope grid` is every run of the committed l2-pairs.json (1,731).
// Every expected value comes from somewhere other than planL1Grid / planL2: the
// catalogue's row and sport constants, the product's own catalog JSON (read as
// text through fake-driver.ts's rawCatalogTemplate, never through
// lib/templates.ts), the D7 wave table, the scenario catalogue's declarations
// (ATOMIC, HARNESS_SCENARIO) and the committed pair file read as plain JSON.
// Every sweep reports how many items it checked; zero checked is a failure.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ONLY_ROWS, ROW_KEYS, SPORT_KEYS, TEMPLATE_ROW_KEYS, cellId, type ApiOnlyRowKey } from "../lib/catalogue.ts";
import { API_ONLY_UI_WAVE } from "../lib/api-only-ui.ts";
import { TEMPLATE_ROW } from "../lib/templates.ts";
import { ATOMIC, HARNESS_SCENARIO } from "../lib/scenario-catalogue.ts";
import { ALL_CELLS, GridTakesNoFilter, L1_WIDTH, LAYER_GRID_PLANNERS, identityOf, layerCaseId, planL1Grid, type LayerCase } from "../lib/layers.ts";
import { loadL2Pairs, type L2Run } from "../lib/pairs.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "../lib/slice.ts";
import { livePlan } from "./committed-plans.ts";
import { rawCatalogTemplate } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The committed pair file as plain JSON: never through layers.ts or pairs.ts. */
const RAW = (JSON.parse(readFileSync(join(REPO, "tools/matrix/catalogue/l2-pairs.json"), "utf8")) as { runs: L2Run[] }).runs;
const COUNTS = JSON.parse(readFileSync(join(REPO, "tools/matrix/catalogue/counts.json"), "utf8")) as { l1: { formula: string; value: number } };

/** Ruling 64: the grid is rows × sports, from the catalogue's own constants. */
const CELLS = (TEMPLATE_ROW_KEYS.length + API_ONLY_ROWS.length) * SPORT_KEYS.length;
/** The API-only cells a catalog template builds (ruling 47), from the PRODUCT's catalog JSON: its sport, its variant. */
const TEMPLATE_CELLS = new Map(Object.entries(TEMPLATE_ROW).map(([key, row]) => {
  const d = rawCatalogTemplate(key).divisions[0]!;
  return [cellId(row, d.sportKey), { key, row, sport: d.sportKey, variant: d.variantKey }] as const;
}));
/** Whether the run's atom has a harness script (the scenario catalogue's own declaration). */
const hasScript = (r: L2Run): boolean => Object.hasOwn(HARNESS_SCENARIO, r.scenario);
const driven = (cs: readonly LayerCase[]) => cs.filter((c) => c.spec !== null);
const planned = (cs: readonly LayerCase[]) => cs.filter((c) => c.spec === null);
const cellOf = (c: LayerCase): string => { const i = identityOf(c); return cellId(i.row, i.sport); };
/** A variantFor that is NOT a builder default, so a case's variant visibly comes from the argument. */
const stubVariant = (s: string): string => `v-${s}`;

describe("the full L1 grid (ruling 64: 231 cells @1280, ruling 39)", () => {
  const cases = planL1Grid(offlineBuilderDefault);

  it("plans one case per cell — the count the corrected counts.json states — all at 1280, in ROW_KEYS × SPORT_KEYS order", () => {
    expect(CELLS).toBe(231);
    expect(COUNTS.l1).toEqual({ formula: "cells × 1 width (1280; ruling 39)", value: CELLS });
    expect(cases).toHaveLength(CELLS);
    expect(new Set(cases.map(layerCaseId)).size).toBe(CELLS);
    expect(cases.every((c) => c.width === L1_WIDTH && c.layer === "L1" && c.run === null)).toBe(true);
    expect(cases.map(cellOf)).toEqual(ROW_KEYS.flatMap((r) => SPORT_KEYS.map((s) => cellId(r, s))));
    expect(cases.every((c) => identityOf(c).scenario === "LIFECYCLE")).toBe(true);
  });

  it("ALL_CELLS is every catalogue cell, once: the set the L2 grid filters by", () => {
    expect(ALL_CELLS.size).toBe(CELLS);
    expect([...ALL_CELLS]).toEqual(cases.map(cellOf));
  });

  it("drives every builder row and every template-reached API-only cell; plans 🚫 for the rest, each naming the wave that owes it", () => {
    expect(TEMPLATE_CELLS.size).toBeGreaterThan(0);
    expect(driven(cases)).toHaveLength(TEMPLATE_ROW_KEYS.length * SPORT_KEYS.length + TEMPLATE_CELLS.size); // 178
    const p = planned(cases);
    expect(p).toHaveLength(API_ONLY_ROWS.length * SPORT_KEYS.length - TEMPLATE_CELLS.size); // 53
    expect(driven(cases).length + p.length).toBe(CELLS);
    let checked = 0;
    for (const c of p) {
      const id = layerCaseId(c);
      // The wave is the D7 declaration's, never a constant; ░ is no part of L1.
      expect(c.noPath?.wave, id).toBe(API_ONLY_UI_WAVE[identityOf(c).row as ApiOnlyRowKey].wave);
      expect(c.notRun, id).toBeNull();
      expect(c.noPath?.reason.length, id).toBeGreaterThan(0);
      // A cell a template builds is never 🚫: it has an organiser path.
      expect(TEMPLATE_CELLS.has(cellOf(c)), id).toBe(false);
      checked++;
    }
    expect(checked).toBe(p.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a template-reached cell carries its template and the template's OWN sport and variant (ruling 47, D11), never variantFor's", () => {
    const t = planL1Grid(stubVariant).filter((c) => c.spec !== null && c.spec.template !== undefined);
    expect(t).toHaveLength(TEMPLATE_CELLS.size);
    let checked = 0;
    for (const c of t) {
      const want = TEMPLATE_CELLS.get(cellOf(c));
      expect(want, layerCaseId(c)).toBeDefined();
      expect(c.spec!.template).toBe(want!.key);
      expect(c.spec!.row).toBe(want!.row);
      expect(c.spec!.sport).toBe(want!.sport);
      expect(c.spec!.variant).toBe(want!.variant);
      // The stub's variant differs from the template's, so a variantFor leak would be seen.
      expect(c.spec!.variant).not.toBe(stubVariant(want!.sport));
      checked++;
    }
    expect(checked).toBe(TEMPLATE_CELLS.size);
    expect(planL1Grid(stubVariant).filter((c) => c.spec !== null && c.spec.template === undefined)).toHaveLength(driven(cases).length - TEMPLATE_CELLS.size);
  });

  it("every other case is under variantFor's variant for ITS sport — another sport is another variant, and a 🚫 names it too", () => {
    const stubbed = planL1Grid(stubVariant);
    let checked = 0;
    for (const c of stubbed) {
      if (c.spec !== null && c.spec.template !== undefined) continue;
      const i = identityOf(c);
      expect(i.variant, layerCaseId(c)).toBe(stubVariant(i.sport));
      expect(i.caseId, layerCaseId(c)).toBe(`${i.row}|${i.sport}|${stubVariant(i.sport)}|LIFECYCLE`);
      checked++;
    }
    expect(checked).toBe(CELLS - TEMPLATE_CELLS.size);
    // The offline builder default differs by sport (cricket vs football), so one constant cannot pass.
    const cricket = cases.filter((c) => layerCaseId(c).startsWith("league|cricket|"));
    expect(cricket).toHaveLength(1);
    expect(cricket[0]!.spec!.variant).toBe(offlineBuilderDefault("cricket"));
    const football = cases.filter((c) => layerCaseId(c).startsWith("league|football|"));
    expect(football).toHaveLength(1);
    expect(football[0]!.spec!.variant).toBe(offlineBuilderDefault("football"));
    expect(cricket[0]!.spec!.variant).not.toBe(football[0]!.spec!.variant);
  });

  it("a second call plans the same grid (the planner keeps no state between calls)", () => {
    expect(planL1Grid(offlineBuilderDefault)).toStrictEqual(cases);
  });

  it("the planner declares every sport it asks variantFor about (the runner reads each declared sport's variant order once) and places the grid at 1280 only", () => {
    const planner = LAYER_GRID_PLANNERS.L1({});
    expect(planner.sports).toEqual(SPORT_KEYS);
    expect(planner.layer).toBe("L1");
    expect(planner.label).toBe("--layer L1 --scope grid");
    expect(planner.acceptsWidth).toBe(L1_WIDTH);
    expect(planner.deniesFeatures).toBe(false);
    const asked = new Set<string>();
    const out = planner.layered((s) => { asked.add(s); return offlineBuilderDefault(s); });
    expect(out).toHaveLength(CELLS);
    expect([...asked].sort()).toEqual([...SPORT_KEYS].sort());
  });
});

describe("the full L2 grid (ruling 64: every run of l2-pairs.json)", () => {
  const planner = LAYER_GRID_PLANNERS.L2({});
  const cases = planner.layered(offlineBuilderDefault);
  const atom = new Map(ATOMIC.map((a) => [a.id, a]));
  const owningWave = (r: L2Run): string | null => { const a = atom.get(r.scenario)!; return a.knownNoPath ?? a.l2NoPath; };
  const idOf = (r: L2Run) => `${r.row}|${r.sport}|${r.preset}|${r.scenario}${r.bound === null ? "" : `|${r.bound}`}@${r.width}`;
  const pairs = loadL2Pairs();

  it("plans exactly one case per committed pair-run, none twice, each keeping its own n, row, sport, preset and width", () => {
    expect(RAW.length).toBeGreaterThan(0);
    expect(pairs.runs).toStrictEqual(RAW);
    expect(cases).toHaveLength(RAW.length);
    expect(new Set(cases.map(layerCaseId)).size).toBe(RAW.length);
    let checked = 0;
    cases.forEach((c, i) => {
      const r = RAW[i]!;
      expect(layerCaseId(c), `run ${r.n}`).toBe(idOf(r));
      expect(c.run, `run ${r.n}`).toStrictEqual(r);
      expect(c.layer).toBe("L2");
      expect(c.width, `run ${r.n}`).toBe(r.width);
      checked++;
    });
    expect(checked).toBe(RAW.length);
  });

  it("drives exactly the runs whose atom has a harness script; every other run is 🚫 (a wave owes the path) or ░ with its atom named", () => {
    const wantDriven = RAW.filter(hasScript);
    const wantNoPath = RAW.filter((r) => !hasScript(r) && owningWave(r) !== null);
    const wantNotRun = RAW.filter((r) => !hasScript(r) && owningWave(r) === null);
    const d = driven(cases);
    const noPath = cases.filter((c) => c.spec === null && c.noPath !== null);
    const notRun = cases.filter((c) => c.spec === null && c.notRun !== null);
    expect(d.length).toBeGreaterThan(0);
    expect(planned(cases).length).toBe(noPath.length + notRun.length);
    expect(d.map(layerCaseId)).toEqual(wantDriven.map(idOf));
    expect(noPath.map(layerCaseId)).toEqual(wantNoPath.map(idOf));
    expect(notRun.map(layerCaseId)).toEqual(wantNotRun.map(idOf));
    for (const c of d) expect(c.spec!.scenario, layerCaseId(c)).toBe(HARNESS_SCENARIO[c.run!.scenario]);
    for (const c of noPath) expect(c.noPath!.wave, layerCaseId(c)).toBe(owningWave(c.run!));
    for (const c of notRun) expect(c.notRun, layerCaseId(c)).toContain(`atom ${c.run!.scenario}`);
    // Ruling 65's figures: only the driven runs can go red; the rest are planned, never driven. W2a (X-DR-1, loop D) moved the
    // pairwise cover: 1731 -> 1729 cases, driven and no_path unchanged (the catalogue was regenerated, a reviewed change, R11).
    expect({ driven: d.length, noPath: noPath.length, notRun: notRun.length, all: cases.length }).toEqual({ driven: 62, noPath: 164, notRun: 1503, all: 1729 });
    console.log(`L2 grid: ${d.length} driven, ${noPath.length} no_path, ${notRun.length} not_run of ${cases.length}`);
  });

  it("the four league/knockout M1/R4a phone runs (false premise 14) are driven, each at its own committed width", () => {
    let checked = 0;
    for (const [row, sport] of [["league", "football"], ["knockout", "icehockey"]] as const) {
      for (const sc of ["M1", "R4a"]) {
        const want = RAW.filter((r) => r.row === row && r.sport === sport && r.scenario === sc);
        expect(want.length, `${row}|${sport} ${sc}`).toBeGreaterThan(0);
        for (const w of want) {
          const c = cases.find((x) => x.run?.n === w.n);
          expect(c, `run ${w.n}`).toBeDefined();
          expect(c!.spec, `run ${w.n}`).not.toBeNull();
          expect(c!.width, `run ${w.n}`).toBe(w.width);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("declares exactly the sports its driven cases need (a planned run posts nothing), and takes no --width (each run sets its own)", () => {
    expect(planner.layer).toBe("L2");
    expect(planner.label).toBe("--layer L2 --scope grid");
    expect(planner.acceptsWidth).toBeNull();
    expect(planner.deniesFeatures).toBe(false);
    expect([...planner.sports].sort()).toEqual([...new Set(driven(cases).map((c) => c.spec!.sport))].sort());
    // variantFor is never asked: the committed runs carry their own preset.
    const asked: string[] = [];
    planner.layered((s) => { asked.push(s); return offlineBuilderDefault(s); });
    expect(asked).toEqual([]);
  });

  it("a second call plans the same grid", () => {
    expect(LAYER_GRID_PLANNERS.L2({}).layered(offlineBuilderDefault)).toStrictEqual(cases);
  });
});

describe("the grid takes no filter: the whole grid is the plan (refused by name, never silently ignored)", () => {
  it("--only, --scenario and --canary each refuse, on both layers, with the grid's own words", () => {
    let checked = 0;
    for (const layer of ["L1", "L2"] as const) {
      for (const cli of [{ only: "league|generic" }, { scenario: "M1" }, { canary: "M1" }] as const) {
        const flag = Object.keys(cli)[0]!;
        expect(() => LAYER_GRID_PLANNERS[layer](cli), `${layer} ${flag}`).toThrow(GridTakesNoFilter);
        expect(() => LAYER_GRID_PLANNERS[layer](cli), `${layer} ${flag}`).toThrow(new RegExp(`--layer ${layer} --scope grid runs the whole grid; it takes no --${flag}`));
        checked++;
      }
      // The positive pair: no filter, no refusal.
      expect(() => LAYER_GRID_PLANNERS[layer]({})).not.toThrow();
    }
    expect(checked).toBe(6);
  });
});

describe("committed-plans.ts reads the scope: --scope grid is the grid, a bare --layer is the slice (the second call: the default did not move)", () => {
  it("--layer L1 --scope grid is the 231 cells (178 driven, 53 planned); --layer L1 is still the slice's 6", () => {
    const grid = livePlan("--layer L1 --scope grid");
    expect(grid.plan).toBe("--layer L1 --scope grid");
    expect(grid.layered).toBe(true);
    expect(grid.driven.size).toBe(TEMPLATE_ROW_KEYS.length * SPORT_KEYS.length + TEMPLATE_CELLS.size);
    expect(grid.planned.size).toBe(API_ONLY_ROWS.length * SPORT_KEYS.length - TEMPLATE_CELLS.size);
    expect(grid.driven.size + grid.planned.size).toBe(CELLS);
    const slice = livePlan("--layer L1");
    expect(slice.driven.size).toBe(SLICE_ROWS.length * SLICE_SPORTS.length);
    expect(slice.planned.size).toBe(0);
  });

  it("--layer L2 --scope grid is the 1,731 runs; --layer L2 is still the slice's cells only", () => {
    const grid = livePlan("--layer L2 --scope grid");
    expect(grid.driven.size + grid.planned.size).toBe(RAW.length);
    expect(grid.driven.size).toBe(RAW.filter(hasScript).length);
    const sliceCells = new Set(SLICE_ROWS.flatMap((r) => SLICE_SPORTS.map((s) => cellId(r, s))));
    const slice = livePlan("--layer L2");
    expect(slice.driven.size + slice.planned.size).toBe(RAW.filter((r) => sliceCells.has(cellId(r.row, r.sport))).length);
    expect(slice.driven.size + slice.planned.size).toBeLessThan(grid.driven.size + grid.planned.size);
  });
});
