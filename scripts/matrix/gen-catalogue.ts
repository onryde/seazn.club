// Writes or checks the committed W1b catalogue files (R11: regenerating is a
// reviewed diff). Exit codes, each with one meaning:
//   0  the files match (--check) or were written (--write);
//   1  drift: a committed file differs from the generator or is missing;
//   2  a refusal: bad arguments, or --write asked to lower a committed floor
//      without --accept-lower-floors (a missing or unparseable committed
//      floors.json counts: it would accept any lowering), or any zero floor
//      (trap 1, even with --accept-lower-floors);
//   3  the generator crashed — never 1, which would read as drift.
//   (3 also: a crash while the CLI LOADS, before any of its code runs — a
//   strip-types parse error, a missing export, a module that throws — through
//   `pnpm matrix:catalogue`, whose preload lib/crash-exit.ts maps it; a bare `node …`
//   run exits 1 on one. Final batch F-6.)
// --root redirects only where the committed files are read and written, and
// where regressions.json is read from; the generators read the product and
// engine through imports.
// Deterministic: registry order or an explicit sort, no clock (R11, trap 5).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ROW_KEYS, SPORT_KEYS } from "./lib/catalogue.ts";
import { planL3, rowCounts, scenarioCounts, type DropKind } from "./lib/applicability.ts";
import { computeCounts } from "./lib/counts.ts";
import { isMainModule } from "./lib/main-module.ts";
import { L2_WIDTHS, planL2 } from "./lib/pairs.ts";
import { ATOMIC, LIFECYCLE_ID, l2Atomic, l3Atomic, loadRegressions } from "./lib/scenario-catalogue.ts";
import { buildSportVariants } from "./lib/variants.ts";

export const CATALOGUE_DIR = "scripts/matrix/catalogue";
export const GENERATED = ["variants.json", "drop-list.json", "floors.json", "l2-pairs.json", "counts.json"] as const;
export type Generated = (typeof GENERATED)[number];
/** The planned-case counts later waves must not run below: L3 per row and per
 *  scenario, L2 runs per scenario. Never lowered silently (--write refuses). */
export interface Floors { schemaVersion: 1; perRow: Record<string, number>; perScenarioL3: Record<string, number>; perScenarioL2: Record<string, number> }

interface DropGroup { scenario: string; kind: DropKind; reason: string; count: number; cells: Record<string, string[]> }

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const GEN = "scripts/matrix/gen-catalogue.ts";
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const USAGE = "usage: gen-catalogue.ts [--check | --write [--accept-lower-floors]] [--root DIR]";

export function generateCatalogue(repoRoot: string): Record<Generated, string> {
  const variants = SPORT_KEYS.map((s) => buildSportVariants(s));
  const l3 = planL3({ variants });
  const l2 = planL2({ variants });
  const regressions = loadRegressions(repoRoot);

  // Grouped by (scenario, kind, reason). A group's cells keep the plan's
  // registry order (ROW_KEYS outer, SPORT_KEYS inner) — never sorted; the
  // groups themselves sort by catalogue order, then kind, then reason.
  const order = [LIFECYCLE_ID, ...ATOMIC.map((a) => a.id)];
  const groups = new Map<string, DropGroup>();
  for (const d of l3.drops) {
    const k = JSON.stringify([d.scenario, d.kind, d.reason]);
    const g = groups.get(k) ?? { scenario: d.scenario, kind: d.kind, reason: d.reason, count: 0, cells: {} };
    (g.cells[d.row] ??= []).push(d.sport);
    g.count++;
    groups.set(k, g);
  }
  const dropGroups = [...groups.values()].sort((a, b) =>
    order.indexOf(a.scenario) - order.indexOf(b.scenario) || byCodepoint(a.kind, b.kind) || byCodepoint(a.reason, b.reason));
  const ofKind = (k: DropKind): number => l3.drops.filter((d) => d.kind === k).length;

  const perRow = rowCounts(l3.cases);
  const perScenario = scenarioCounts(l3.cases);
  const floors: Floors = {
    schemaVersion: 1,
    perRow: Object.fromEntries(ROW_KEYS.map((r) => [r, perRow[r] ?? 0])),
    perScenarioL3: Object.fromEntries([LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)].map((id) => [id, perScenario[id] ?? 0])),
    perScenarioL2: Object.fromEntries(l2Atomic().map((a) => [a.id, l2.perScenario[a.id] ?? 0])),
  };
  return {
    "variants.json": json({ schemaVersion: 1, generatedBy: GEN, sports: variants }),
    "drop-list.json": json({
      schemaVersion: 1,
      generatedBy: GEN,
      basis: "builder-default variant per sport, derived offline; variant-dependent scenarios bound to variants.json first",
      kinds: {
        inapplicable: "the scenario cannot happen in the cell — the reason says why",
        "harness-gap": "the scenario APPLIES in the cell, but the L3 generator cannot drive it yet (the rule's harness gap); L2 still owes the pair and marks its run l3Gap",
        "unscorable-only": "only committed variants the harness cannot score (variants.json scorable ≠ null) would enable the scenario in the cell — it may apply once they can be scored; the reason names them",
      },
      total: l3.drops.length,
      inapplicable: ofKind("inapplicable"),
      harnessGap: ofKind("harness-gap"),
      unscorableOnly: ofKind("unscorable-only"),
      groups: dropGroups,
    }),
    "floors.json": json(floors),
    "l2-pairs.json": json({ schemaVersion: 1, generatedBy: GEN, widths: [...L2_WIDTHS], targets: l2.targets, runs: l2.runs }),
    "counts.json": json(computeCounts({ l3, l2, variants, regressions })),
  };
}

const TABLES = ["perRow", "perScenarioL3", "perScenarioL2"] as const;

/** Each floor of `prev` that `next` lowers — a key gone from `next` is lowered to 0. */
export const lowered = (prev: Floors, next: Floors): string[] =>
  TABLES.flatMap((k) => Object.entries(prev[k]).filter(([id, v]) => (next[k][id] ?? 0) < v).map(([id, v]) => `${id}: ${v} → ${next[k][id] ?? 0}`));
/** Each floor at or below zero, named `<table>.<id>`. */
export const zeros = (next: Floors): string[] =>
  TABLES.flatMap((k) => Object.entries(next[k]).filter(([, v]) => v <= 0).map(([id]) => `${k}.${id}`));

const say = (s: string): void => { process.stdout.write(`gen-catalogue: ${s}\n`); };
const warn = (s: string): void => { process.stderr.write(`gen-catalogue: ${s}\n`); };

/** A floors.json read back: its three tables must be objects of finite numbers. */
function parseFloors(text: string): Floors | string {
  try {
    const f = JSON.parse(text) as Partial<Floors> | null;
    for (const k of TABLES) {
      const t: unknown = f?.[k];
      if (typeof t !== "object" || t === null) return `its ${k} is not an object`;
      if (!Object.values(t).every((v) => typeof v === "number" && Number.isFinite(v))) return `its ${k} holds a value that is not a finite number`;
    }
    return f as Floors;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function main(argv: string[], deps: { generate?: (repoRoot: string) => Record<Generated, string> } = {}): number {
  let values: { write?: boolean; check?: boolean; "accept-lower-floors"?: boolean; root?: string };
  try {
    // pnpm 10 passes a `--` through (`pnpm matrix:catalogue -- --write`): one
    // leading separator is dropped, so both spellings work.
    const args = argv[0] === "--" ? argv.slice(1) : argv;
    ({ values } = parseArgs({ args, options: { write: { type: "boolean" }, check: { type: "boolean" }, "accept-lower-floors": { type: "boolean" }, root: { type: "string" } } }));
  } catch (e) {
    warn(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  if (values.write === true && values.check === true) { warn(`--write and --check are exclusive\n${USAGE}`); return 2; }
  if (values["accept-lower-floors"] === true && values.write !== true) { warn(`--accept-lower-floors applies to --write only\n${USAGE}`); return 2; }
  const root = values.root ?? process.cwd();
  try {
    return run(root, values.write === true, values["accept-lower-floors"] === true, deps.generate ?? generateCatalogue);
  } catch (e) {
    warn(`the generator failed (exit 3 — not drift): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 3;
  }
}

function run(root: string, write: boolean, acceptLower: boolean, generate: (repoRoot: string) => Record<Generated, string>): number {
  const out = generate(root);
  const path = (f: Generated): string => resolve(root, CATALOGUE_DIR, f);
  const read = (f: Generated): string | null => { try { return readFileSync(path(f), "utf8"); } catch { return null; } };

  if (write) {
    const next = parseFloors(out["floors.json"]);
    if (typeof next === "string") { warn(`refusing — the generated floors.json does not parse: ${next}`); return 2; }
    const z = zeros(next);
    if (z.length > 0) { warn(`refusing — zero floor(s): ${z.join(", ")}`); return 2; }
    const prevText = read("floors.json");
    // A missing floors.json beside the other committed files is a deletion, not
    // a first write: it would accept any lowering. Only an empty root is new.
    if (prevText === null && !acceptLower && GENERATED.some((f) => read(f) !== null)) {
      warn("refusing — the committed floors.json is missing beside the other catalogue files, so no lowering could be caught; restore it, or pass --accept-lower-floors");
      return 2;
    }
    if (prevText !== null && !acceptLower) {
      const prev = parseFloors(prevText);
      if (typeof prev === "string") { warn(`refusing — the committed floors.json does not parse (${prev}); fix it, or pass --accept-lower-floors to replace it`); return 2; }
      const low = lowered(prev, next);
      if (low.length > 0) { warn(`refusing to lower floors without --accept-lower-floors:\n  ${low.join("\n  ")}`); return 2; }
    }
    mkdirSync(resolve(root, CATALOGUE_DIR), { recursive: true });
    for (const f of GENERATED) writeFileSync(path(f), out[f]);
    say(`wrote ${GENERATED.length} files`);
    return 0;
  }
  const drifted = GENERATED.filter((f) => read(f) !== out[f]);
  if (drifted.length > 0) {
    for (const f of drifted) warn(`${f} differs from the generator (or is missing) — run: pnpm matrix:catalogue --write, and review the diff`);
    return 1;
  }
  say(`${GENERATED.length} files match`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
