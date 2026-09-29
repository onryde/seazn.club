// The committed W1b catalogue (Task 8; R11, Review Focus 1): five reviewed
// files that later waves measure against, and the drift gate that reds on any
// byte difference. State transitions and empty cases first (TEST-STRATEGY
// rule 1):
//  - a first --write into a root with no committed files (the empty case),
//    then a second --write (byte-identical), then --check;
//  - a hand-edited or a missing committed file (--check exits 1, naming it);
//  - a lowered floor (--write refuses, exit 2, naming it), and the same with
//    --accept-lower-floors (written); a deleted floors.json beside the other
//    files (refused: it would accept any lowering);
//  - a zero floor (refused, even with --accept-lower-floors);
//  - bad arguments (exit 2) and a generator crash (exit 3) — never 1, which
//    reads as drift.
// Another sport: every sweep walks the registry (ROW_KEYS, SPORT_KEYS). A
// withdrawal or void is not an input: the generator is a pure function of the
// rules, the catalogue, the variant set and regressions.json.
// Expected values come from the catalogue (ROW_KEYS, SPORT_KEYS, l3Atomic,
// l2Atomic), applicability.ts's own decide, planL3 and RULES, an independent
// generate-and-fold of every variant case (the real engine), the committed
// regressions file and L2_WIDTHS — never from gen-catalogue.ts or counts.ts.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type * as TS from "typescript";
import { EngineError, type StageKind } from "@seazn/engine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { RULES, decide, planL3 } from "../lib/applicability.ts";
import { UnscorableUnclassified, computeCounts } from "../lib/counts.ts";
import { foldStream } from "../lib/fold.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import { L2_WIDTHS, planL2 } from "../lib/pairs.ts";
import { LIFECYCLE_ID, REGRESSIONS_PATH, l2Atomic, l3Atomic, loadRegressions } from "../lib/scenario-catalogue.ts";
import { CfgInvalid, resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { GeneratorUnsupported } from "../lib/streams/types.ts";
import { buildSportVariants, offlineBuilderDefault, type SportVariants, type VariantCase } from "../lib/variants.ts";
import { CATALOGUE_DIR, GENERATED, generateCatalogue, lowered, main, zeros, type Floors } from "../gen-catalogue.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

// `typescript` through require, not import (as scenario-catalogue.test.ts).
const ts: typeof TS = createRequire(import.meta.url)("typescript");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fresh = generateCatalogue(REPO);
const L3_IDS = [LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)];
const L2_IDS = l2Atomic().map((a) => a.id);
const CELLS = ROW_KEYS.length * SPORT_KEYS.length;
const VARIANTS = SPORT_KEYS.map((s) => buildSportVariants(s));
const PLAN = planL3({ variants: VARIANTS });
const parsed = <T,>(f: (typeof GENERATED)[number]): T => JSON.parse(fresh[f]) as T;

const DROP_KINDS = ["inapplicable", "harness-gap", "unscorable-only"] as const;
interface DropGroup { scenario: string; kind: string; reason: string; count: number; cells: Record<string, string[]> }
interface DropList { kinds: Record<string, string>; total: number; inapplicable: number; harnessGap: number; unscorableOnly: number; groups: DropGroup[] }
interface CaseList { count: number; routedTo?: string; why: string; ids: string[] }
interface CountsFile {
  grid: { rows: number; sports: number; cells: number };
  catalogue: { parents: number; atomic: number; atomicL3: number; atomicL2: number };
  l1: { formula: string; value: number };
  l2: { formula: string; value: number; pairTargets: number; l3GapRuns: number };
  l3: { formula: string; lifecycle: number; atomicApplicable: number; bound: number; variantCasesScorable: number; variantCasesUnscorable: number; denied: number; regressions: number; value: number };
  drops: { total: number; harnessGap: number; unscorableOnly: number; byScenario: Record<string, number> };
  variants: { perSport: Record<string, number>; cases: number; scorable: number; unscorable: number; engineUnscorable: CaseList; generatorUnsupported: CaseList; noOp: CaseList; uncoverablePairs: number };
}
interface VariantsFile { sports: { sport: string; defaultPreset: string; cases: VariantCase[]; uncoverable: unknown[] }[] }
interface L2File { widths: number[]; targets: { rowScenario: number; sportScenario: number }; runs: { l3Gap: string | null }[] }

// --- trap 5: no clock, no randomness ------------------------------------------
/** Identifiers (and the same names as string keys: `Math["random"]`) that read
 *  a clock or a random source, in any access form. */
const BANNED_NAMES = new Set(["Date", "Temporal", "performance", "hrtime", "random", "randomUUID", "randomBytes", "randomInt", "randomFill", "randomFillSync", "getRandomValues"]);
const BANNED_MODULES = new Set(["crypto", "node:crypto", "perf_hooks", "node:perf_hooks"]);
const parse = (src: string, file: string): TS.SourceFile => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
/** Parse errors fail closed: an unclosed comment or template would hide the code after it. */
const parseErrors = (sf: TS.SourceFile): string[] =>
  (sf as unknown as { parseDiagnostics: readonly TS.DiagnosticWithLocation[] }).parseDiagnostics.map((d) => `${sf.fileName}: parse error at ${d.start}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
/** Every clock or random read in `src`, from the TypeScript AST — a comment is
 *  never a hit, and a `//` inside a string hides nothing. */
function clockOrRandom(src: string, file = "synthetic.ts"): string[] {
  const sf = parse(src, file);
  const out = parseErrors(sf);
  const at = (n: TS.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: TS.Node): void => {
    if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && BANNED_NAMES.has(n.text)) out.push(`${at(n)}: ${n.text}`);
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && (BANNED_NAMES.has(n.text) || BANNED_MODULES.has(n.text))) out.push(`${at(n)}: "${n.text}"`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** Every module reached from gen-catalogue.ts by relative import (import,
 *  export … from, dynamic import(), read from the AST), walked transitively:
 *  the generator's whole own-source closure, so a new module cannot escape. */
function generatorClosure(): string[] {
  const seen = new Set<string>();
  const todo = [resolve(REPO, "scripts/matrix/gen-catalogue.ts")];
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    if (seen.has(f)) continue;
    seen.add(f);
    const sf = parse(readFileSync(f, "utf8"), f);
    expect(parseErrors(sf), f).toEqual([]);
    const visit = (n: TS.Node): void => {
      let spec: TS.Expression | undefined;
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined) spec = n.moduleSpecifier;
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) spec = n.arguments[0];
      if (spec !== undefined && ts.isStringLiteralLike(spec) && spec.text.startsWith(".")) todo.push(resolve(dirname(f), spec.text));
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...seen].sort();
}

// --- an independent generate-and-fold of one variant case ---------------------
type VariantClass = "scorable" | "engine" | "generator";
/** Win for each side on the row's first stage kind, generated then folded by
 *  the REAL engine: the engine's refusal (its configSchema, or an EngineError
 *  from the fold) is "engine"; the stream registry's GeneratorUnsupported is
 *  "generator". Never variants.ts's scorable() or counts.ts. */
function independentClass(vc: VariantCase): VariantClass {
  let cfg: unknown;
  try {
    cfg = resolveSportCfg(vc.sport, vc.preset, { ...vc.overrides });
  } catch (e) {
    if (e instanceof CfgInvalid) return "engine";
    throw e;
  }
  const stageKind = stagesForRow(vc.row)[0]!.kind as StageKind;
  for (const winner of ["home", "away"] as const) {
    try {
      const events = generateStream({ sportKey: vc.sport, cfg, stageKind, home: "H", away: "A", outcome: { kind: "win", winner } });
      const out = foldStream(sportModule(vc.sport), cfg, "H", "A", events).outcome;
      expect(out, `${vc.id} win-${winner}`).toMatchObject({ kind: "win", winner: winner === "home" ? "H" : "A" });
    } catch (e) {
      if (e instanceof GeneratorUnsupported) return "generator";
      if (EngineError.is(e)) return "engine";
      throw e;
    }
  }
  return "scorable";
}
/** Each drop's kind, recounted from decide's raw answer: the rule applied but
 *  its harness gap held → harness-gap; else only unscorable committed
 *  variants enable it → unscorable-only; else inapplicable. */
function expectedDropKinds(): Map<string, (typeof DROP_KINDS)[number]> {
  const m = new Map<string, (typeof DROP_KINDS)[number]>();
  for (const id of L3_IDS) for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
    const r = RULES[id]!;
    const dec = decide(r, row, s, VARIANTS);
    if (dec.applies) continue;
    m.set(`${id}#${row}|${s}`, r.gap !== undefined && dec.gapped.length > 0 ? "harness-gap" : dec.unscorable.length > 0 ? "unscorable-only" : "inapplicable");
  }
  return m;
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
    expect(v.sports).toEqual(JSON.parse(JSON.stringify(VARIANTS)));
    expect(v.sports.length).toBe(SPORT_KEYS.length);
  });

  it("no clock and no randomness in any generator module (trap 5) — the whole import closure of gen-catalogue.ts, read from the AST, counted", () => {
    const mods = generatorClosure();
    const rel = mods.map((m) => relative(resolve(REPO, "scripts/matrix"), m));
    // The brief's named modules must all be in the closure (the walk is not vacuous).
    for (const m of ["lib/scenario-catalogue.ts", "lib/variants.ts", "lib/applicability.ts", "lib/format-gates-copy.ts", "lib/pairs.ts", "lib/counts.ts", "gen-catalogue.ts"]) expect(rel, m).toContain(m);
    let checked = 0;
    for (const m of mods) {
      expect(clockOrRandom(readFileSync(m, "utf8"), m), m).toEqual([]);
      checked++;
    }
    expect(checked).toBe(mods.length);
    expect(checked).toBeGreaterThan(7);
    console.info(`committed-catalogue: ${checked} generator modules scanned for a clock or randomness`);
  });

  it("the clock/randomness scan sees every evasion form (M-3), ignores comments, and fails closed on a parse error", () => {
    const EVASIONS = [
      'import { randomUUID } from "node:crypto";',
      "const d = Date();",
      "const d = new Date;",
      "const d = new Date ();",
      "const t = process.hrtime();",
      'const r = Math["random"]();',
      'const u = "http://x"; const r = Math.random();',
      "const r = Math?.random();",
      "const { random } = Math;",
      "const t = performance.now();",
      "const t = globalThis.performance.now();",
      "const n = Date.now();",
      "crypto.getRandomValues(new Uint8Array(1));",
      'import * as c from "crypto";',
      'import { performance as p } from "node:perf_hooks";',
      "const t = Temporal.Now.instant();",
    ];
    let seen = 0;
    for (const src of EVASIONS) {
      expect(clockOrRandom(src).length, src).toBeGreaterThan(0);
      seen++;
    }
    expect(seen).toBe(EVASIONS.length);
    for (const clean of ["// Date.now() and Math.random() in a comment", "/* new Date() */ const x = 1;", 'const u = "https://example.test/a"; const n = Math.max(1, 2);', "const round = Math.round(2.5);"]) expect(clockOrRandom(clean), clean).toEqual([]);
    expect(clockOrRandom("const s = `unclosed ${").join(" ")).toMatch(/parse error/);
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
    expect(l2.runs.length).toBe(planL2({ variants: VARIANTS }).runs.length);
  });

  it("counts: L1 = cells × 2; L2 = the pair file's runs; L3 = the sum of its declared parts, each part checked against another file", () => {
    const c = parsed<CountsFile>("counts.json");
    const l2 = parsed<L2File>("l2-pairs.json");
    const floors = parsed<Floors>("floors.json");
    const d = parsed<DropList>("drop-list.json");
    const v = parsed<VariantsFile>("variants.json");
    expect(c.grid).toEqual({ rows: ROW_KEYS.length, sports: SPORT_KEYS.length, cells: CELLS });
    expect(c.l1.value).toBe(CELLS * 2);
    expect(c.l2.value).toBe(l2.runs.length);
    expect(c.l2.pairTargets).toBe(l2.targets.rowScenario + l2.targets.sportScenario);
    expect(c.l2.l3GapRuns).toBe(l2.runs.filter((r) => r.l3Gap !== null).length);
    expect(c.l2.formula).toMatch(/owed/);
    expect(c.l2.formula).not.toMatch(/applicable/);
    expect(c.l3.value).toBe(c.l3.lifecycle + c.l3.atomicApplicable + c.l3.variantCasesScorable + c.l3.denied + c.l3.regressions);
    expect(c.l3.formula).toMatch(/scorable variant cases/);
    expect(c.l3.lifecycle).toBe(CELLS);
    expect(c.l3.lifecycle).toBe(floors.perScenarioL3[LIFECYCLE_ID]);
    // Every (cell, L3 scenario) is planned or dropped, exactly once.
    expect(c.l3.lifecycle + c.l3.atomicApplicable + c.drops.total).toBe(CELLS * L3_IDS.length);
    expect(c.l3.lifecycle + c.l3.atomicApplicable).toBe(Object.values(floors.perRow).reduce((a, b) => a + b, 0));
    // I-1: only the variant cases the harness can score count toward L3 —
    // recounted from variants.json's own per-case field, never counts.ts.
    const allCases = v.sports.flatMap((s) => s.cases);
    const scorable = allCases.filter((x) => x.scorable === null).length;
    expect(scorable).toBeGreaterThan(0);
    expect(scorable).toBeLessThan(allCases.length); // today some are unscorable, so the two totals differ
    expect(c.l3.variantCasesScorable).toBe(scorable);
    expect(c.l3.variantCasesUnscorable).toBe(allCases.length - scorable);
    // Q-B / ruling 29: one denied case per gated row (the product's format gate, text-pinned copy).
    const gated = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
    expect(gated.length).toBeGreaterThan(0);
    expect(c.l3.denied).toBe(gated.length);
    expect(c.l3.regressions).toBe(loadRegressions(REPO).length);
    expect(c.l3.value).toBe(CELLS + c.l3.atomicApplicable + scorable + gated.length + loadRegressions(REPO).length);
    // M-5: the fields drift alone used to protect.
    const bound = PLAN.cases.filter((x) => x.bound !== null);
    expect(c.l3.bound).toBe(bound.length);
    expect(c.l3.atomicApplicable).toBe(PLAN.cases.length - CELLS);
    const scorableIds = new Set(allCases.filter((x) => x.scorable === null).map((x) => x.id));
    for (const x of bound) expect(scorableIds.has(x.bound ?? ""), `${x.cell} ${x.scenario} binds ${x.bound}`).toBe(true);
    expect(c.variants.uncoverablePairs).toBe(v.sports.reduce((n, s) => n + s.uncoverable.length, 0));
    expect(c.variants.unscorable).toBe(allCases.filter((x) => x.scorable !== null).length);
    expect(c.catalogue.atomicL3).toBe(L3_IDS.length - 1);
    expect(c.catalogue.atomicL2).toBe(L2_IDS.length);
    expect(c.catalogue.atomic).toBe(new Set([...L3_IDS.slice(1), ...L2_IDS]).size);
    expect(c.catalogue.parents).toBe(new Set([...l3Atomic(), ...l2Atomic()].map((a) => a.parent)).size);
    expect(Object.keys(c.variants.perSport)).toEqual([...SPORT_KEYS]);
    expect(c.drops.total).toBe(d.total);
    expect(c.drops.harnessGap).toBe(d.harnessGap);
    expect(c.drops.unscorableOnly).toBe(d.unscorableOnly);
    expect(Object.keys(c.drops.byScenario)).toEqual(L3_IDS);
    expect(Object.values(c.drops.byScenario).reduce((a, b) => a + b, 0)).toBe(c.drops.total);
    for (const id of L3_IDS) expect(c.drops.byScenario[id]! + floors.perScenarioL3[id]!, id).toBe(CELLS);
  });

  it("variant cases split scorable / engine-unscorable (W2) / generator-unsupported (W1-driving) — every case re-classified by an independent generate-and-fold, counted (I-1)", () => {
    const c = parsed<CountsFile>("counts.json");
    const v = parsed<VariantsFile>("variants.json");
    const got: Record<VariantClass, string[]> = { scorable: [], engine: [], generator: [] };
    let judged = 0;
    for (const s of v.sports) for (const vc of s.cases) {
      got[independentClass(vc)].push(vc.id);
      judged++;
    }
    const total = v.sports.reduce((n, s) => n + s.cases.length, 0);
    expect(judged).toBe(total);
    expect(c.variants.cases).toBe(total);
    expect(c.variants.scorable).toBe(got.scorable.length);
    expect(c.variants.engineUnscorable).toEqual({ count: got.engine.length, routedTo: "W2", why: expect.any(String), ids: got.engine });
    expect(c.variants.generatorUnsupported).toEqual({ count: got.generator.length, routedTo: "W1-driving", why: expect.any(String), ids: got.generator });
    expect(c.variants.unscorable).toBe(got.engine.length + got.generator.length);
    expect(c.variants.scorable + c.variants.unscorable).toBe(total);
    // The committed per-case field agrees with the independent fold.
    expect(v.sports.flatMap((s) => s.cases.filter((x) => x.scorable === null).map((x) => x.id))).toEqual(got.scorable);
    // Anti-vacuity: both unscorable classes are live today (set-to-1 at
    // win-by-2 refused by the engine, ruling 31; cricket `test` two-innings
    // streams).
    expect(got.engine.length).toBeGreaterThan(0);
    expect(got.generator.length).toBeGreaterThan(0);
    console.info(`committed-catalogue: ${judged} variant cases folded — ${got.scorable.length} scorable, ${got.engine.length} engine-unscorable, ${got.generator.length} generator-unsupported`);
  });

  it("an unscorable reason counts.ts cannot classify is refused by name, never guessed; the engine's cfg refusal counts as engine (every arm reached)", () => {
    // single-sport: one synthetic case per arm, on the first sport's real variant set.
    const base = VARIANTS[0]!;
    const withReason = (reason: string): SportVariants[] => [{ ...base, cases: base.cases.map((x, i) => (i === 0 ? { ...x, scorable: reason } : x)) }, ...VARIANTS.slice(1)];
    const run = (reason: string) => computeCounts({ l3: PLAN, l2: planL2({ variants: VARIANTS }), variants: withReason(reason), regressions: [] });
    const id = base.cases[0]!.id;
    expect(run("cfg: CfgInvalid: refused").variants.engineUnscorable.ids).toContain(id);
    expect(run("win-away: EngineError: refused").variants.engineUnscorable.ids).toContain(id);
    expect(run("win-home: GeneratorUnsupported: not built").variants.generatorUnsupported.ids).toContain(id);
    for (const bad of ['win-home: folded {"kind":"win","winner":"A"}', "win-home: OutcomeUnreachable: no", "test: unscorable"]) expect(() => run(bad), bad).toThrow(UnscorableUnclassified);
  });

  it("noOp (M-6): the variant cases with no overrides at the sport's builder-default preset are listed apart — each resolves to the default cfg, counted", () => {
    const c = parsed<CountsFile>("counts.json");
    const v = parsed<VariantsFile>("variants.json");
    const ids: string[] = [];
    let judged = 0;
    for (const s of v.sports) {
      const def = offlineBuilderDefault(s.sport);
      const defCfg = resolveSportCfg(s.sport, def, {});
      for (const vc of s.cases) {
        judged++;
        if (Object.keys(vc.overrides).length > 0 || vc.preset !== def) continue;
        ids.push(vc.id);
        expect(isDeepStrictEqual(resolveSportCfg(vc.sport, vc.preset, { ...vc.overrides }), defCfg), vc.id).toBe(true);
      }
    }
    expect(judged).toBe(c.variants.cases);
    expect(ids.length).toBeGreaterThan(0);
    expect(c.variants.noOp).toEqual({ count: ids.length, why: expect.any(String), ids });
  });

  it("drop list: every drop is inapplicable, a harness gap or unscorable-only, recorded apart — each kind recounted from decide, counted", () => {
    const d = parsed<DropList>("drop-list.json");
    expect(Object.keys(d.kinds)).toEqual([...DROP_KINDS]);
    expect(d.groups.reduce((n, g) => n + g.count, 0)).toBe(d.total);
    for (const g of d.groups) expect(g.count, `${g.scenario}: ${g.reason}`).toBe(Object.values(g.cells).reduce((n, s) => n + s.length, 0));
    expect(d.inapplicable + d.harnessGap + d.unscorableOnly).toBe(d.total);
    const expected = expectedDropKinds();
    expect(d.total).toBe(expected.size);
    const tally = (k: string) => [...expected.values()].filter((x) => x === k).length;
    expect({ inapplicable: d.inapplicable, harnessGap: d.harnessGap, unscorableOnly: d.unscorableOnly }).toEqual({ inapplicable: tally("inapplicable"), harnessGap: tally("harness-gap"), unscorableOnly: tally("unscorable-only") });
    let judged = 0;
    for (const g of d.groups) {
      expect(DROP_KINDS as readonly string[], g.kind).toContain(g.kind);
      for (const [row, sports] of Object.entries(g.cells)) for (const s of sports) {
        expect(g.kind, `${g.scenario} ${row}|${s}`).toBe(expected.get(`${g.scenario}#${row}|${s}`));
        judged++;
      }
      const gapReason = RULES[g.scenario]?.gap?.reason;
      if (g.kind === "harness-gap") {
        expect(gapReason, `${g.scenario}: a harness-gap group for a rule with no gap`).toBeDefined();
        expect(g.reason.startsWith(gapReason ?? ""), g.scenario).toBe(true);
      } else if (gapReason !== undefined) expect(g.reason.startsWith(gapReason), g.scenario).toBe(false);
      if (g.kind === "unscorable-only") expect(g.reason, g.scenario).toMatch(/cannot be scored by the harness/);
    }
    expect(judged).toBe(d.total);
    // Anti-vacuity: both non-default kinds are live today — M5 is a cricket tie
    // in a bracket (harness gap), and M5 at americano/mexicano/ladder|cricket is
    // enabled only by the unscorable two-innings variants. If W1-driving gives
    // the generator a tie outcome or two-innings streams, drop the matching
    // line (the recount above still judges every drop).
    expect(d.harnessGap).toBeGreaterThan(0);
    expect(d.unscorableOnly).toBeGreaterThan(0);
    console.info(`committed-catalogue: ${judged} drops judged — ${d.inapplicable} inapplicable, ${d.harnessGap} harness gaps, ${d.unscorableOnly} unscorable-only, ${d.groups.length} groups`);
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

// At most three CLI spawns per test; the budget derives from the spawn's cap (final batch FB-6).
const genMeter = new SpawnMeter(3);
describe("gen-catalogue CLI", { timeout: genMeter.budget }, () => {
  beforeEach(() => genMeter.reset());
  const cli = (args: string[], root: string) => {
    genMeter.tick();
    return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", resolve(REPO, "scripts/matrix/gen-catalogue.ts"), ...args, "--root", root], { encoding: "utf8", timeout: SPAWN_MS });
  };
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

  it("--write refuses (exit 2) when floors.json is missing beside the other committed files — a deleted floors file would accept any lowering; --accept-lower-floors writes it", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = copy();
    rmSync(join(root, CATALOGUE_DIR, "floors.json"));
    // A floor lowered in the generator's output: exactly what the missing file would wave through.
    const floors = parsed<Floors>("floors.json");
    const low = { ...fresh, "floors.json": `${JSON.stringify({ ...floors, perRow: { ...floors.perRow, league: floors.perRow.league! - 1 } }, null, 2)}\n` };
    const before = snapshot(root);
    for (const out of [fresh, low]) {
      expect(main(["--write", "--root", root], { generate: () => out })).toBe(2);
      expect(snapshot(root)).toEqual(before);
    }
    expect(err.join("")).toMatch(/committed floors\.json is missing/);
    expect(main(["--write", "--accept-lower-floors", "--root", root], { generate: () => fresh })).toBe(0);
    expect(snapshot(root)).toEqual(GENERATED.map((g) => fresh[g]));
  });

  it("a generator crash exits 3 — never 1 (drift) or 2 (a refusal) — names the error and writes nothing; in-process and spawned", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = copy();
    const before = snapshot(root);
    let checked = 0;
    for (const args of [["--check"], ["--write"], ["--write", "--accept-lower-floors"]]) {
      expect(main([...args, "--root", root], { generate: () => { throw new TypeError("boom"); } }), args.join(" ")).toBe(3);
      expect(snapshot(root)).toEqual(before);
      checked++;
    }
    expect(checked).toBe(3);
    expect(err.join("")).toMatch(/TypeError: boom/);
    // Spawned, on the real generator: a root with no regressions.json.
    const bare = temp();
    const r = cli(["--check"], bare);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain("regressions.json");
  });

  it("one leading `--` (pnpm 10 passes it through: pnpm matrix:catalogue -- --write) is dropped; a second is still a usage refusal", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(main(["--", "--check", "--root", REPO], { generate: () => fresh })).toBe(0);
    expect(main(["--", "--", "--check", "--root", REPO], { generate: () => fresh })).toBe(2);
  });
});
