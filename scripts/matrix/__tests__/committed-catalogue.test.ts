// The committed W1b catalogue (Task 8; R11, Review Focus 1): five reviewed
// files that later waves measure against, and the drift gate that reds on any
// byte difference. State transitions and empty cases first (TEST-STRATEGY
// rule 1):
//  - a first --write into a root with no committed files (the empty case),
//    then a second --write (byte-identical), then --check;
//  - a hand-edited or a missing committed file (--check exits 1, naming it);
//  - a lowered floor (--write refuses, exit 2, naming it), and the same with
//    --accept-lower-floors (written);
//  - a zero floor (refused, even with --accept-lower-floors);
//  - bad arguments (exit 2 — never 1, which reads as drift).
// Another sport: every sweep walks the registry (ROW_KEYS, SPORT_KEYS). A
// withdrawal or void is not an input: the generator is a pure function of the
// rules, the catalogue, the variant set and regressions.json.
// Expected values come from the catalogue (ROW_KEYS, SPORT_KEYS, l3Atomic,
// l2Atomic), applicability.ts's own decide and RULES, the committed
// regressions file and L2_WIDTHS — never from gen-catalogue.ts or counts.ts.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { RULES, decide } from "../lib/applicability.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import { L2_WIDTHS } from "../lib/pairs.ts";
import { LIFECYCLE_ID, REGRESSIONS_PATH, l2Atomic, l3Atomic, loadRegressions } from "../lib/scenario-catalogue.ts";
import { buildSportVariants } from "../lib/variants.ts";
import { CATALOGUE_DIR, GENERATED, generateCatalogue, lowered, main, zeros, type Floors } from "../gen-catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fresh = generateCatalogue(REPO);
const L3_IDS = [LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)];
const L2_IDS = l2Atomic().map((a) => a.id);
const CELLS = ROW_KEYS.length * SPORT_KEYS.length;
const parsed = <T,>(f: (typeof GENERATED)[number]): T => JSON.parse(fresh[f]) as T;

interface DropGroup { scenario: string; kind: string; reason: string; count: number; cells: Record<string, string[]> }
interface DropList { total: number; inapplicable: number; harnessGap: number; groups: DropGroup[] }
interface CountsFile {
  grid: { rows: number; sports: number; cells: number };
  l1: { formula: string; value: number };
  l2: { formula: string; value: number; pairTargets: number; l3GapRuns: number };
  l3: { formula: string; lifecycle: number; atomicApplicable: number; bound: number; variantCases: number; denied: number; regressions: number; value: number };
  drops: { total: number; harnessGap: number; byScenario: Record<string, number> };
  variants: { perSport: Record<string, number> };
}
interface L2File { widths: number[]; targets: { rowScenario: number; sportScenario: number }; runs: { l3Gap: string | null }[] }

/** Every module reached from gen-catalogue.ts by relative import (the boundary
 *  test's three import shapes), walked transitively — the generator's whole
 *  own-source closure, so a new generator module cannot escape the scan. */
const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']|import\(\s*["'`]([^"'`]+)["'`]\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
function generatorClosure(): string[] {
  const seen = new Set<string>();
  const todo = [resolve(REPO, "scripts/matrix/gen-catalogue.ts")];
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? "";
      if (spec.startsWith(".")) todo.push(resolve(dirname(f), spec));
    }
  }
  return [...seen].sort();
}

describe("committed catalogue files (R11, Review Focus 1)", () => {
  it("drift: every generated file equals its committed copy byte for byte", () => {
    let n = 0;
    for (const f of GENERATED) {
      expect(readFileSync(resolve(REPO, CATALOGUE_DIR, f), "utf8"), `${f} drifted — run: pnpm matrix:catalogue --write, and review the diff`).toBe(fresh[f]);
      n++;
    }
    expect(n).toBe(5);
  });

  it("deterministic: a second generation in the same process is identical", () => {
    expect(generateCatalogue(REPO)).toEqual(fresh);
  });

  it("variants.json is the variant set itself: one entry per registry sport, as the generator builds it", () => {
    const v = parsed<{ sports: unknown[] }>("variants.json");
    expect(v.sports).toEqual(JSON.parse(JSON.stringify(SPORT_KEYS.map((s) => buildSportVariants(s)))));
    expect(v.sports.length).toBe(SPORT_KEYS.length);
  });

  it("no clock and no randomness in any generator module (trap 5) — the whole import closure of gen-catalogue.ts, counted", () => {
    const mods = generatorClosure();
    const rel = mods.map((m) => relative(resolve(REPO, "scripts/matrix"), m));
    // The brief's named modules must all be in the closure (the walk is not vacuous).
    for (const m of ["lib/scenario-catalogue.ts", "lib/variants.ts", "lib/applicability.ts", "lib/format-gates-copy.ts", "lib/pairs.ts", "lib/counts.ts", "gen-catalogue.ts"]) expect(rel, m).toContain(m);
    let checked = 0;
    for (const m of mods) {
      const src = readFileSync(m, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(src, m).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|crypto\.\w*random/i);
      checked++;
    }
    expect(checked).toBe(mods.length);
    expect(checked).toBeGreaterThan(7);
    console.info(`committed-catalogue: ${checked} generator modules scanned for a clock or randomness`);
  });

  it("floors: every row, every L3 scenario and every L2 scenario has a floor above zero — keyed by the catalogue, in registry order", () => {
    const floors = parsed<Floors>("floors.json");
    expect(Object.keys(floors.perRow)).toEqual([...ROW_KEYS]);
    expect(Object.keys(floors.perScenarioL3)).toEqual(L3_IDS);
    expect(Object.keys(floors.perScenarioL2)).toEqual(L2_IDS);
    let checked = 0;
    for (const [k, v] of [...Object.entries(floors.perRow), ...Object.entries(floors.perScenarioL3), ...Object.entries(floors.perScenarioL2)]) {
      expect(v, k).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length + L3_IDS.length + L2_IDS.length);
  });

  it("registry order, never sorted: variants by SPORT_KEYS, drop cells by ROW_KEYS then SPORT_KEYS", () => {
    const v = parsed<{ sports: { sport: string }[] }>("variants.json");
    expect(v.sports.map((s) => s.sport)).toEqual([...SPORT_KEYS]);
    const d = parsed<DropList>("drop-list.json");
    let rowsChecked = 0;
    for (const g of d.groups) {
      const rows = Object.keys(g.cells);
      expect(rows.length, `${g.scenario}: a group with no cells`).toBeGreaterThan(0);
      expect(rows).toEqual(ROW_KEYS.filter((r) => rows.includes(r)));
      for (const r of rows) {
        expect(g.cells[r]).toEqual(SPORT_KEYS.filter((s) => g.cells[r]!.includes(s)));
        rowsChecked++;
      }
    }
    expect(d.groups.length).toBeGreaterThan(0);
    expect(rowsChecked).toBeGreaterThanOrEqual(d.groups.length);
  });

  it("l2-pairs.json widths are L2_WIDTHS (one authority), and its runs are the whole L2 plan", () => {
    const l2 = parsed<L2File>("l2-pairs.json");
    expect(l2.widths).toEqual([...L2_WIDTHS]);
    expect(l2.runs.length).toBeGreaterThan(0);
    const floors = parsed<Floors>("floors.json");
    expect(l2.runs.length).toBe(Object.values(floors.perScenarioL2).reduce((a, b) => a + b, 0));
  });

  it("counts: L1 = cells × 2; L2 = the pair file's runs; L3 = the sum of its declared parts, each part checked against another file", () => {
    const c = parsed<CountsFile>("counts.json");
    const l2 = parsed<L2File>("l2-pairs.json");
    const floors = parsed<Floors>("floors.json");
    const d = parsed<DropList>("drop-list.json");
    const v = parsed<{ sports: { cases: unknown[] }[] }>("variants.json");
    expect(c.grid).toEqual({ rows: ROW_KEYS.length, sports: SPORT_KEYS.length, cells: CELLS });
    expect(c.l1.value).toBe(CELLS * 2);
    expect(c.l2.value).toBe(l2.runs.length);
    expect(c.l2.pairTargets).toBe(l2.targets.rowScenario + l2.targets.sportScenario);
    expect(c.l2.l3GapRuns).toBe(l2.runs.filter((r) => r.l3Gap !== null).length);
    expect(c.l2.formula).toMatch(/owed/);
    expect(c.l2.formula).not.toMatch(/applicable/);
    expect(c.l3.value).toBe(c.l3.lifecycle + c.l3.atomicApplicable + c.l3.variantCases + c.l3.denied + c.l3.regressions);
    expect(c.l3.lifecycle).toBe(CELLS);
    expect(c.l3.lifecycle).toBe(floors.perScenarioL3[LIFECYCLE_ID]);
    // Every (cell, L3 scenario) is planned or dropped, exactly once.
    expect(c.l3.lifecycle + c.l3.atomicApplicable + c.drops.total).toBe(CELLS * L3_IDS.length);
    expect(c.l3.lifecycle + c.l3.atomicApplicable).toBe(Object.values(floors.perRow).reduce((a, b) => a + b, 0));
    expect(c.l3.variantCases).toBe(v.sports.reduce((n, s) => n + s.cases.length, 0));
    expect(Object.keys(c.variants.perSport)).toEqual([...SPORT_KEYS]);
    // Q-B / ruling 29: one denied case per gated row (the product's format gate, text-pinned copy).
    const gated = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
    expect(gated.length).toBeGreaterThan(0);
    expect(c.l3.denied).toBe(gated.length);
    expect(c.l3.regressions).toBe(loadRegressions(REPO).length);
    expect(c.drops.total).toBe(d.total);
    expect(c.drops.harnessGap).toBe(d.harnessGap);
    expect(Object.keys(c.drops.byScenario)).toEqual(L3_IDS);
    expect(Object.values(c.drops.byScenario).reduce((a, b) => a + b, 0)).toBe(c.drops.total);
    for (const id of L3_IDS) expect(c.drops.byScenario[id]! + floors.perScenarioL3[id]!, id).toBe(CELLS);
  });

  it("drop list: every drop is a harness gap or a real inapplicability, recorded apart — gaps recounted from decide, counted", () => {
    const d = parsed<DropList>("drop-list.json");
    expect(d.groups.reduce((n, g) => n + g.count, 0)).toBe(d.total);
    for (const g of d.groups) expect(g.count, `${g.scenario}: ${g.reason}`).toBe(Object.values(g.cells).reduce((n, s) => n + s.length, 0));
    expect(d.inapplicable + d.harnessGap).toBe(d.total);
    const variants = SPORT_KEYS.map((s) => buildSportVariants(s));
    // Independent recount: a drop is a gap exactly where decide reports the
    // rule gapped (applies=false, gapped non-empty) for a rule with a gap.
    const gapCells = new Map<string, Set<string>>();
    for (const id of L3_IDS) {
      const r = RULES[id]!;
      if (r.gap === undefined) continue;
      for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
        const dec = decide(r, row, s, variants);
        if (!dec.applies && dec.gapped.length > 0) (gapCells.get(id) ?? gapCells.set(id, new Set()).get(id)!).add(`${row}|${s}`);
      }
    }
    const gapTotal = [...gapCells.values()].reduce((n, s) => n + s.size, 0);
    expect(d.harnessGap).toBe(gapTotal);
    let judged = 0;
    for (const g of d.groups) {
      expect(["inapplicable", "harness-gap"], g.kind).toContain(g.kind);
      const gapReason = RULES[g.scenario]?.gap?.reason;
      for (const [row, sports] of Object.entries(g.cells)) for (const s of sports) {
        const isGap = gapCells.get(g.scenario)?.has(`${row}|${s}`) === true;
        expect(g.kind, `${g.scenario} ${row}|${s}`).toBe(isGap ? "harness-gap" : "inapplicable");
        judged++;
      }
      if (g.kind === "harness-gap") {
        expect(gapReason, `${g.scenario}: a harness-gap group for a rule with no gap`).toBeDefined();
        expect(g.reason.startsWith(gapReason ?? ""), g.scenario).toBe(true);
      } else if (gapReason !== undefined) expect(g.reason.startsWith(gapReason), g.scenario).toBe(false);
    }
    expect(judged).toBe(d.total);
    // Anti-vacuity: the gap arm is live today (M5, a cricket tie in a bracket).
    // If W1-driving gives the generator a tie outcome this legitimately reaches
    // zero: then drop this line (the recount above still judges every drop).
    expect(d.harnessGap).toBeGreaterThan(0);
    console.info(`committed-catalogue: ${judged} drops judged, ${d.harnessGap} harness gaps, ${d.inapplicable} inapplicable, ${d.groups.length} groups`);
  });
});

describe("lowered / zeros (the floor refusals)", () => {
  const floors = parsed<Floors>("floors.json");
  it("empty case first: identical floors lower nothing and hold no zero", () => {
    expect(lowered(floors, floors)).toEqual([]);
    expect(zeros(floors)).toEqual([]);
  });
  it("a raised floor is not lowered; a lowered one is named with both values; a key gone from the next floors is lowered to 0", () => {
    const row = ROW_KEYS[0]!;
    const up = { ...floors, perRow: { ...floors.perRow, [row]: floors.perRow[row]! + 1 } };
    expect(lowered(floors, up)).toEqual([]);
    expect(lowered(up, floors)).toEqual([`${row}: ${floors.perRow[row]! + 1} → ${floors.perRow[row]}`]);
    const { [L2_IDS[0]!]: gone, ...rest } = floors.perScenarioL2;
    expect(lowered(floors, { ...floors, perScenarioL2: rest })).toEqual([`${L2_IDS[0]}: ${gone} → 0`]);
  });
  it("zeros names each floor at or below zero by its table", () => {
    const z = { ...floors, perScenarioL3: { ...floors.perScenarioL3, [LIFECYCLE_ID]: 0 }, perScenarioL2: { ...floors.perScenarioL2, [L2_IDS[0]!]: -1 } };
    expect(zeros(z)).toEqual([`perScenarioL3.${LIFECYCLE_ID}`, `perScenarioL2.${L2_IDS[0]}`]);
  });
});

describe("gen-catalogue CLI", () => {
  const cli = (args: string[], root: string) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", resolve(REPO, "scripts/matrix/gen-catalogue.ts"), ...args, "--root", root], { encoding: "utf8", timeout: 120_000 });
  const roots: string[] = [];
  const temp = (): string => {
    const root = mkdtempSync(join(tmpdir(), "w1b-cat-"));
    roots.push(root);
    mkdirSync(join(root, CATALOGUE_DIR), { recursive: true });
    return root;
  };
  const copy = (): string => {
    const root = temp();
    cpSync(resolve(REPO, CATALOGUE_DIR), join(root, CATALOGUE_DIR), { recursive: true });
    return root;
  };
  const snapshot = (root: string) => GENERATED.map((f) => (existsSync(join(root, CATALOGUE_DIR, f)) ? readFileSync(join(root, CATALOGUE_DIR, f), "utf8") : null));
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("--check on the repo exits 0, and the drift message's command is the real package script", () => {
    const r = cli(["--check"], REPO);
    expect(r.status, r.stderr).toBe(0);
    const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["matrix:catalogue"]).toBe("node --experimental-strip-types scripts/matrix/gen-catalogue.ts");
  });

  it("empty case: --write into a root with no committed files writes all five, a second --write changes no byte, then --check exits 0", () => {
    const root = temp();
    cpSync(resolve(REPO, REGRESSIONS_PATH), join(root, REGRESSIONS_PATH));
    expect(snapshot(root)).toEqual(GENERATED.map(() => null));
    const first = cli(["--write"], root);
    expect(first.status, first.stderr).toBe(0);
    const after = snapshot(root);
    expect(after).toEqual(GENERATED.map((f) => fresh[f]));
    const second = cli(["--write"], root);
    expect(second.status, second.stderr).toBe(0);
    expect(snapshot(root)).toEqual(after);
    expect(cli(["--check"], root).status).toBe(0);
  });

  it("--check exits 1 and names the file when a committed file was hand-edited", () => {
    const root = copy();
    const p = join(root, CATALOGUE_DIR, "variants.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"schemaVersion": 1', '"schemaVersion": 1 '));
    const r = cli(["--check"], root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("variants.json");
  });

  it("--check exits 1 and names the file when a committed file is missing", () => {
    const root = copy();
    rmSync(join(root, CATALOGUE_DIR, "counts.json"));
    const r = cli(["--check"], root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("counts.json");
  });

  it("--write refuses (exit 2) to lower a committed floor without --accept-lower-floors, naming the row and writing nothing; with it, writes", () => {
    const root = copy();
    const p = join(root, CATALOGUE_DIR, "floors.json");
    const f = JSON.parse(readFileSync(p, "utf8")) as Floors;
    f.perRow.league = f.perRow.league! + 1000;
    writeFileSync(p, `${JSON.stringify(f, null, 2)}\n`);
    const before = snapshot(root);
    const r = cli(["--write"], root);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/league: \d+ → \d+/);
    expect(snapshot(root)).toEqual(before);
    const accepted = cli(["--write", "--accept-lower-floors"], root);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(snapshot(root)).toEqual(GENERATED.map((g) => fresh[g]));
  });

  it("--write refuses (exit 2) a zero floor, even with --accept-lower-floors, naming it and writing nothing", () => {
    // In-process with a generator that yields one zero floor: the real
    // registry has none, and a zero must never reach the committed file.
    const root = copy();
    const floors = parsed<Floors>("floors.json");
    const id = L2_IDS[L2_IDS.length - 1]!;
    const zeroed = { ...fresh, "floors.json": `${JSON.stringify({ ...floors, perScenarioL2: { ...floors.perScenarioL2, [id]: 0 } }, null, 2)}\n` };
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const before = snapshot(root);
    for (const args of [["--write"], ["--write", "--accept-lower-floors"]]) {
      expect(main([...args, "--root", root], { generate: () => zeroed }), args.join(" ")).toBe(2);
      expect(snapshot(root)).toEqual(before);
    }
    expect(err.join("")).toContain(`perScenarioL2.${id}`);
  });

  it("bad arguments exit 2 (a usage refusal), never 1 — which would read as drift — and generate nothing", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; });
    let generated = 0;
    const generate = () => { generated++; return fresh; };
    expect(main(["--bogus"], { generate })).toBe(2);
    expect(main(["--write", "--check"], { generate })).toBe(2);
    expect(main(["stray"], { generate })).toBe(2);
    expect(main(["--accept-lower-floors"], { generate })).toBe(2);
    expect(generated).toBe(0);
    expect(err.join("")).toMatch(/usage/);
  });

  it("--write refuses (exit 2) a committed or generated floors.json that is not three tables of numbers — never a crash that reads as drift; --accept-lower-floors replaces a broken committed one", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = copy();
    const p = join(root, CATALOGUE_DIR, "floors.json");
    const floors = parsed<Floors>("floors.json");
    let checked = 0;
    for (const broken of ["{ not json", "null", JSON.stringify({ ...floors, perRow: null }), JSON.stringify({ ...floors, perScenarioL3: { ...floors.perScenarioL3, [LIFECYCLE_ID]: "231" } })]) {
      writeFileSync(p, broken);
      const before = snapshot(root);
      expect(main(["--write", "--root", root], { generate: () => fresh }), broken.slice(0, 40)).toBe(2);
      expect(snapshot(root)).toEqual(before);
      checked++;
    }
    expect(checked).toBe(4);
    expect(err.join("")).toMatch(/committed floors\.json does not parse/);
    expect(main(["--write", "--accept-lower-floors", "--root", root], { generate: () => fresh })).toBe(0);
    expect(snapshot(root)).toEqual(GENERATED.map((g) => fresh[g]));
    // The generated side: a generator whose floors.json lacks a table is refused too.
    expect(main(["--write", "--accept-lower-floors", "--root", root], { generate: () => ({ ...fresh, "floors.json": "{}" }) })).toBe(2);
    expect(err.join("")).toMatch(/generated floors\.json does not parse/);
    expect(snapshot(root)).toEqual(GENERATED.map((g) => fresh[g]));
  });

  it("one leading `--` (pnpm 10 passes it through: pnpm matrix:catalogue -- --write) is dropped; a second is still a usage refusal", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(main(["--", "--check", "--root", REPO], { generate: () => fresh })).toBe(0);
    expect(main(["--", "--", "--check", "--root", REPO], { generate: () => fresh })).toBe(2);
  });
});
