// W1d Task 3 (owner ruling 64, item 2): the FULL grid planners — `--layer L1
// --scope grid` is one LIFECYCLE case per OFFERED catalogue cell at 1280 (207 of
// the 231: chess americano/mexicano are refused, follow-up to #1027), and
// `--layer L2 --scope grid` is every run of the committed l2-pairs.json (1,589).
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
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { API_ONLY_ROWS, ROW_KEYS, SPORT_KEYS, TEMPLATE_ROW_KEYS, cellId, type ApiOnlyRowKey } from "../lib/catalogue.ts";
import { API_ONLY_UI_WAVE } from "../lib/api-only-ui.ts";
import { TEMPLATE_ROW } from "../lib/templates.ts";
import { ATOMIC, HARNESS_SCENARIO, l2NoPathFor } from "../lib/scenario-catalogue.ts";
import { ALL_CELLS, GridTakesNoFilter, L1_WIDTH, LAYER_GRID_PLANNERS, identityOf, layerCaseId, planL1Grid, type LayerCase } from "../lib/layers.ts";
import { loadL2Pairs, type L2Run } from "../lib/pairs.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "../lib/slice.ts";
import { livePlan } from "./committed-plans.ts";
import { rawCatalogTemplate } from "./fake-driver.ts";
import { CHESS_REFUSED_CELLS, NO_ORGANISER_PATH_CELLS, PAIR_NO_PATH_CELLS, REFUSED_CELLS, RETIRED_ROW_CELLS, STANDALONE_REFUSED_CELLS, isNoOrganiserPathCell, isRefusedCell, noPathWaveOf, offeredCells } from "./refused-cells.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The committed pair file as plain JSON: never through layers.ts or pairs.ts. */
const RAW = (JSON.parse(readFileSync(join(REPO, "tools/matrix/catalogue/l2-pairs.json"), "utf8")) as { runs: L2Run[] }).runs;
const COUNTS = JSON.parse(readFileSync(join(REPO, "tools/matrix/catalogue/counts.json"), "utf8")) as { l1: { formula: string; value: number } };

/** Ruling 64: the grid is rows × sports, from the catalogue's own constants. */
const CELLS = (TEMPLATE_ROW_KEYS.length + API_ONLY_ROWS.length) * SPORT_KEYS.length;
/** The cells L1 plans: every cell but the ones the product refuses (chess americano/mexicano, owner ruling 2026-10-26). */
const OFFERED = CELLS - REFUSED_CELLS.length;
/** The refused BUILDER-row cells (chess americano and mexicano are templates), which come off the driven count. */
const REFUSED_TEMPLATE_CELLS = REFUSED_CELLS.filter((c) => (TEMPLATE_ROW_KEYS as readonly string[]).includes(c.split("|")[0]!)).length;
/** The refused API-only cells (W4 T16, ruling 269: the standalone stepladder and page playoff on every sport), which come off the 🚫 count. */
const REFUSED_API_ONLY_CELLS = REFUSED_CELLS.filter((c) => (API_ONLY_ROWS as readonly string[]).includes(c.split("|")[0]!)).length;
/** Every no-organiser-path cell is a BUILDER row's too (Match Day C9 review I5, option 2; the retired Triple round robin,
 *  owner ruling 2026-11-01): it comes off the driven count and onto the 🚫 one, and every L2 run on it is 🚫. */
const NO_PATH_TEMPLATE_CELLS = NO_ORGANISER_PATH_CELLS.filter((c) => (TEMPLATE_ROW_KEYS as readonly string[]).includes(c.split("|")[0]!)).length;
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

describe("the full L1 grid (ruling 64: 231 cells @1280, ruling 39; 207 offered since the follow-up to #1027 and W4 T16)", () => {
  const cases = planL1Grid(offlineBuilderDefault);

  it("plans one case per OFFERED cell — the count the corrected counts.json states — all at 1280, in ROW_KEYS × SPORT_KEYS order", () => {
    expect(CELLS).toBe(231);
    expect(OFFERED).toBe(207);
    expect(COUNTS.l1).toEqual({ formula: "offered cells (cells − refused) × 1 width (1280; ruling 39)", value: OFFERED });
    expect(cases).toHaveLength(OFFERED);
    expect(new Set(cases.map(layerCaseId)).size).toBe(OFFERED);
    expect(cases.every((c) => c.width === L1_WIDTH && c.layer === "L1" && c.run === null)).toBe(true);
    expect(cases.map(cellOf)).toEqual(offeredCells(ROW_KEYS, SPORT_KEYS));
    expect(cases.every((c) => identityOf(c).scenario === "LIFECYCLE")).toBe(true);
  });

  it("a cell the product refuses (chess americano/mexicano, the 22 standalone stepladder/page playoff cells) has no L1 case at all — neither driven nor 🚫 — while the rest of its row and sport plan", () => {
    expect(cases.filter((c) => isRefusedCell(cellOf(c)))).toEqual([]);
    let checked = 0;
    for (const cell of REFUSED_CELLS) {
      const [row, sport] = cell.split("|") as [string, string];
      expect(cases.filter((c) => identityOf(c).row === row).length, row).toBe(SPORT_KEYS.length - REFUSED_CELLS.filter((x) => x.startsWith(`${row}|`)).length);
      expect(cases.filter((c) => identityOf(c).sport === sport).length, sport).toBe(ROW_KEYS.length - REFUSED_CELLS.filter((x) => x.endsWith(`|${sport}`)).length);
      checked++;
    }
    expect(checked).toBe(CHESS_REFUSED_CELLS.length + STANDALONE_REFUSED_CELLS.length);
    expect(checked).toBe(24);
  });

  it("ALL_CELLS is every catalogue cell, once: the set the L2 grid filters by (a refused cell has no committed pair-run to let through)", () => {
    expect(ALL_CELLS.size).toBe(CELLS);
    expect([...ALL_CELLS].filter((c) => !isRefusedCell(c))).toEqual(cases.map(cellOf));
    for (const c of REFUSED_CELLS) expect(ALL_CELLS.has(c), c).toBe(true);
    expect(RAW.filter((r) => isRefusedCell(cellId(r.row, r.sport)))).toEqual([]);
  });

  it("drives every builder row and every template-reached API-only cell; plans 🚫 for the rest, each naming the wave that owes it", () => {
    expect(TEMPLATE_CELLS.size).toBeGreaterThan(0);
    expect(REFUSED_TEMPLATE_CELLS).toBe(CHESS_REFUSED_CELLS.length);
    expect(REFUSED_API_ONLY_CELLS).toBe(STANDALONE_REFUSED_CELLS.length);
    expect(NO_PATH_TEMPLATE_CELLS).toBe(NO_ORGANISER_PATH_CELLS.length);
    expect(driven(cases)).toHaveLength(TEMPLATE_ROW_KEYS.length * SPORT_KEYS.length - REFUSED_TEMPLATE_CELLS - NO_PATH_TEMPLATE_CELLS + TEMPLATE_CELLS.size); // 155
    const p = planned(cases);
    expect(p).toHaveLength(API_ONLY_ROWS.length * SPORT_KEYS.length - REFUSED_API_ONLY_CELLS - TEMPLATE_CELLS.size + NO_PATH_TEMPLATE_CELLS); // 52
    expect(driven(cases).length + p.length).toBe(OFFERED);
    let checked = 0;
    for (const c of p) {
      const id = layerCaseId(c);
      // The wave is the D7 declaration's, never a constant (the no-organiser-path cells: the rulings'); ░ is no part of L1.
      expect(c.noPath?.wave, id).toBe(isNoOrganiserPathCell(cellOf(c)) ? noPathWaveOf(cellOf(c)) : API_ONLY_UI_WAVE[identityOf(c).row as ApiOnlyRowKey]!.wave);
      expect(c.notRun, id).toBeNull();
      expect(c.noPath?.reason.length, id).toBeGreaterThan(0);
      // A cell a template builds is never 🚫: it has an organiser path.
      expect(TEMPLATE_CELLS.has(cellOf(c)), id).toBe(false);
      checked++;
    }
    expect(checked).toBe(p.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a pair-format cell the builder does not offer (C9 review I5, option 2) is 🚫 under the driven case's own id, routed to the americano wave; the same rows elsewhere are driven", () => {
    // The oracle's cells, from the ENGINE's declarations: the pair formats on every sport whose entrant model holds no
    // individuals or no pairs, chess left out (the product refuses those cells outright).
    const pairFormats = ["americano", "mexicano"];
    const engineNoPath = pairFormats.flatMap((row) => builtinModules.filter((m) => {
      const kinds = effectiveEntrantModel(m.entrantModel ?? null, null).kinds;
      return !(kinds.includes("individual") && kinds.includes("pair")) && !isRefusedCell(`${row}|${m.key}`);
    }).map((m) => `${row}|${m.key}`));
    expect(engineNoPath).toEqual([...PAIR_NO_PATH_CELLS]);
    let checked = 0;
    for (const cell of PAIR_NO_PATH_CELLS) {
      const [row, sport] = cell.split("|") as [string, string];
      const c = cases.filter((x) => cellOf(x) === cell);
      expect(c, cell).toHaveLength(1);
      expect(c[0]!.spec, cell).toBeNull();
      expect(c[0]!.notRun, cell).toBeNull();
      expect(c[0]!.noPath?.wave, cell).toBe("W7");
      expect(c[0]!.noPath?.reason, cell).toMatch(/no organiser path[\s\S]*americano or mexicano[\s\S]*review I5/);
      expect(layerCaseId(c[0]!), cell).toBe(`${row}|${sport}|${offlineBuilderDefault(sport)}|LIFECYCLE@${L1_WIDTH}`);
      checked++;
    }
    expect(checked).toBe(10);
    // The positive pair: the same rows on a sport that can play them, and another row on a no-path sport, are driven.
    for (const cell of ["americano|badminton", "mexicano|generic", "league|football", "knockout|volleyball"]) {
      expect(cases.find((x) => cellOf(x) === cell)?.spec, cell).not.toBeNull();
    }
  });

  // Owner ruling 2026-11-01: the Triple round robin is offered to no sport (STAGE_TEMPLATES marks it retired), and the
  // builder's picker has no such radio - CI run 42356855670 timed out ticking it on all 11 sports. Nothing refuses it, so
  // every sport's cell is 🚫 under its own id, routed to the round-robin wave that owns the triple_rr question.
  it("the retired Triple round robin is 🚫 on EVERY sport under the driven case's own id, routed to the round-robin wave; the league row beside it is driven", () => {
    expect(RETIRED_ROW_CELLS.length).toBe(SPORT_KEYS.length);
    let checked = 0;
    for (const cell of RETIRED_ROW_CELLS) {
      const [row, sport] = cell.split("|") as [string, string];
      const c = cases.filter((x) => cellOf(x) === cell);
      expect(c, cell).toHaveLength(1);
      expect(c[0]!.spec, cell).toBeNull();
      expect(c[0]!.notRun, cell).toBeNull();
      expect(c[0]!.noPath?.wave, cell).toBe("W5");
      expect(c[0]!.noPath?.reason, cell).toMatch(/no organiser path[\s\S]*Triple round robin to no sport[\s\S]*retired[\s\S]*2026-11-01/);
      expect(layerCaseId(c[0]!), cell).toBe(`${row}|${sport}|${offlineBuilderDefault(sport)}|LIFECYCLE@${L1_WIDTH}`);
      checked++;
    }
    expect(checked).toBe(11);
    // The positive pair: the league row (the same stage kind, one leg) is driven on every sport.
    let league = 0;
    for (const sport of SPORT_KEYS) {
      expect(cases.find((x) => cellOf(x) === `league|${sport}`)?.spec, `league|${sport}`).not.toBeNull();
      league++;
    }
    expect(league).toBe(SPORT_KEYS.length);
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
    expect(checked).toBe(OFFERED - TEMPLATE_CELLS.size);
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
    expect(out).toHaveLength(OFFERED);
    expect([...asked].sort()).toEqual([...SPORT_KEYS].sort());
  });
});

describe("the full L2 grid (ruling 64: every run of l2-pairs.json)", () => {
  const planner = LAYER_GRID_PLANNERS.L2({});
  const cases = planner.layered(offlineBuilderDefault);
  const atom = new Map(ATOMIC.map((a) => [a.id, a]));
  const owningWave = (r: L2Run): string | null => { const a = atom.get(r.scenario)!; return a.knownNoPath ?? l2NoPathFor(a, r.sport); };
  /** W4 T24: an atom the rulebook settled (⛔ or ⏳), from the rulebook's §14 table as the test states it - never read back from SETTLED. */
  const SETTLED_STATE: Readonly<Record<string, "refused" | "later">> = { Q4b: "refused", D4b: "refused", D4a: "later" };
  const settledOf = (r: L2Run): "refused" | "later" | null => SETTLED_STATE[r.scenario] ?? null;
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
    // A run on a no-organiser-path cell (C9 review I5, option 2) is 🚫 whatever its atom: no screen reaches the cell.
    const onNoPath = (r: L2Run): boolean => isNoOrganiserPathCell(cellId(r.row, r.sport));
    const wantDriven = RAW.filter((r) => !onNoPath(r) && hasScript(r));
    const wantSettled = RAW.filter((r) => !onNoPath(r) && !hasScript(r) && settledOf(r) !== null);
    const wantNoPath = RAW.filter((r) => onNoPath(r) || (!hasScript(r) && settledOf(r) === null && owningWave(r) !== null));
    const wantNotRun = RAW.filter((r) => !onNoPath(r) && !hasScript(r) && settledOf(r) === null && owningWave(r) === null);
    const d = driven(cases);
    const noPath = cases.filter((c) => c.spec === null && c.noPath !== null);
    const notRun = cases.filter((c) => c.spec === null && c.notRun !== null);
    const settled = cases.filter((c) => c.spec === null && c.settled !== undefined);
    expect(d.length).toBeGreaterThan(0);
    expect(planned(cases).length).toBe(noPath.length + notRun.length + settled.length);
    expect(d.map(layerCaseId)).toEqual(wantDriven.map(idOf));
    expect(noPath.map(layerCaseId)).toEqual(wantNoPath.map(idOf));
    expect(notRun.map(layerCaseId)).toEqual(wantNotRun.map(idOf));
    expect(settled.map(layerCaseId)).toEqual(wantSettled.map(idOf));
    // W4 T24: the settled runs, by atom (the cells moved off 🚫 - counted from the committed pair file, not typed from the code).
    // Q4b -> ⛔ 11, D4b -> ⛔ 16, D4a -> ⏳ 16; the 3 D4a and 3 D4b runs on the no-organiser-path cells stay 🚫 (no screen reaches the
    // cell): 2 each on the ten pair-format cells (C9 review I5) and 1 each on the retired triple_rr row (triple_rr|cricket).
    const settledBy = (id: string) => settled.filter((c) => c.run!.scenario === id);
    expect({ Q4b: settledBy("Q4b").length, D4b: settledBy("D4b").length, D4a: settledBy("D4a").length }).toEqual({ Q4b: 11, D4b: 16, D4a: 16 });
    expect(RAW.filter((r) => r.scenario === "D4a" || r.scenario === "D4b").filter(onNoPath).length).toBe(6);
    expect(RAW.filter((r) => (r.scenario === "D4a" || r.scenario === "D4b") && RETIRED_ROW_CELLS.includes(cellId(r.row, r.sport))).length).toBe(2);
    for (const c of settled) expect(c.settled!.state, layerCaseId(c)).toBe(SETTLED_STATE[c.run!.scenario]);
    // Q4a (joint winners) is not settled: it stays 🚫 naming W4, and so does the rest of D4's and Q4's parent.
    expect(noPath.filter((c) => c.run!.scenario === "Q4a" && !onNoPath(c.run!)).length).toBe(RAW.filter((r) => r.scenario === "Q4a" && !onNoPath(r)).length);
    for (const c of d) expect(c.spec!.scenario, layerCaseId(c)).toBe(HARNESS_SCENARIO[c.run!.scenario]);
    for (const c of noPath) expect(c.noPath!.wave, layerCaseId(c)).toBe(onNoPath(c.run!) ? noPathWaveOf(cellId(c.run!.row, c.run!.sport)) : owningWave(c.run!));
    expect(noPath.filter((c) => !onNoPath(c.run!) && ["Q4b", "D4a", "D4b"].includes(c.run!.scenario))).toEqual([]); // a settled atom is never 🚫 off the no-path cells
    // Both sides of the no-path rule were reached: runs on the cells, and runs elsewhere that stay as they were.
    expect(RAW.filter(onNoPath).length).toBeGreaterThan(0);
    expect(RAW.filter((r) => onNoPath(r) && hasScript(r)).length, "a run on a no-path cell that would have been driven").toBeGreaterThan(0);
    for (const c of notRun) expect(c.notRun, layerCaseId(c)).toContain(`atom ${c.run!.scenario}`);
    // Ruling 65's figures: only the driven runs can go red; the rest are planned, never driven. W2a (X-DR-1, loop D) moved the
    // pairwise cover: 1731 -> 1729 cases, driven and no_path unchanged (the catalogue was regenerated, a reviewed change, R11).
    // W2e Task 32 (B2-3): 19 committed M12b runs (football 16, volleyball, hockey, ice hockey 1 each) have a screen path now:
    // 🚫 164 -> 145, ░ 1,503 -> 1,522 (cricket's and generic's one M12b run each stay 🚫: their dispositions).
    // Match Day C9 review I5, option 2: the 146 runs on the ten no-organiser-path cells are 🚫 - 6 that were driven (football
    // americano/mexicano R4a, M1, F1), 12 already 🚫 and 128 that were ░: driven 62 -> 56, 🚫 145 -> 279, ░ 1,522 -> 1,394.
    // The retired Triple round robin (owner ruling 2026-11-01): its 77 runs are 🚫 - the 3 that were driven (CI run
    // 42356855670's L2 harness errors: R4a@430, M1@768, F1@390), 7 already 🚫 and 67 that were ░: driven 56 -> 53,
    // 🚫 279 -> 349, ░ 1,394 -> 1,327.
    // W4 T16 + T24 (on the pre-triple_rr figures): the 22 refused standalone cells leave the grid (140 held runs, 5 of them driven:
    // 56 -> 51; the pairwise cover keeps their width slots, so no other run moves), and the 45 settled runs leave 🚫: driven
    // 56 -> 51, 🚫 279 -> 222, ░ 1,394 -> 1,271, ⛔ 28 and ⏳ 17 new.
    // Both together (merge of main into W4 app PR A): the 77 triple_rr runs survive the standalone cut, and 2 of the 7 that were
    // already 🚫 are W4's settled D4a@430 / D4b@768 on triple_rr|cricket, which a no-organiser-path cell keeps 🚫 - so settled
    // 45 -> 43 (⛔ 27, ⏳ 16), driven 51 -> 48, 🚫 222 -> 222 + 3 + 67 + 2 = 294, ░ 1,271 -> 1,204, 1,589 runs in all.
    expect(RAW.filter((r) => RETIRED_ROW_CELLS.includes(cellId(r.row, r.sport))).length, "runs on the retired row").toBe(77);
    expect({ driven: d.length, noPath: noPath.length, notRun: notRun.length, settled: settled.length, all: cases.length }).toEqual({ driven: 48, noPath: 294, notRun: 1204, settled: 43, all: 1589 });
    expect(settled.filter((c) => c.settled!.state === "refused").length).toBe(27);
    expect(settled.filter((c) => c.settled!.state === "later").length).toBe(16);
    console.log(`L2 grid: ${d.length} driven, ${noPath.length} no_path, ${notRun.length} not_run, ${settled.length} settled of ${cases.length}`);
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
  it("--layer L1 --scope grid is the 207 offered cells (155 driven, 52 planned); --layer L1 is still the slice's 6", () => {
    const grid = livePlan("--layer L1 --scope grid");
    expect(grid.plan).toBe("--layer L1 --scope grid");
    expect(grid.layered).toBe(true);
    expect(grid.driven.size).toBe(TEMPLATE_ROW_KEYS.length * SPORT_KEYS.length - REFUSED_TEMPLATE_CELLS - NO_PATH_TEMPLATE_CELLS + TEMPLATE_CELLS.size);
    expect(grid.planned.size).toBe(API_ONLY_ROWS.length * SPORT_KEYS.length - REFUSED_API_ONLY_CELLS - TEMPLATE_CELLS.size + NO_PATH_TEMPLATE_CELLS);
    expect(grid.driven.size + grid.planned.size).toBe(OFFERED);
    const slice = livePlan("--layer L1");
    expect(slice.driven.size).toBe(SLICE_ROWS.length * SLICE_SPORTS.length);
    expect(slice.planned.size).toBe(0);
  });

  it("--layer L2 --scope grid is the 1,589 runs; --layer L2 is still the slice's cells only", () => {
    const grid = livePlan("--layer L2 --scope grid");
    expect(grid.driven.size + grid.planned.size).toBe(RAW.length);
    expect(grid.driven.size).toBe(RAW.filter((r) => hasScript(r) && !isNoOrganiserPathCell(cellId(r.row, r.sport))).length);
    const sliceCells = new Set(SLICE_ROWS.flatMap((r) => SLICE_SPORTS.map((s) => cellId(r, s))));
    const slice = livePlan("--layer L2");
    expect(slice.driven.size + slice.planned.size).toBe(RAW.filter((r) => sliceCells.has(cellId(r.row, r.sport))).length);
    expect(slice.driven.size + slice.planned.size).toBeLessThan(grid.driven.size + grid.planned.size);
  });
});
