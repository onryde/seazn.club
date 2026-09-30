// L2 (design §6.2): every OWED (row, scenario) and (sport, scenario) pair —
// applicable, or dropped only for the L3 harness gap (below) — runs at least
// once in the browser, widths rotating across the seven —
// per scenario, per format and per sport (controller ruling, T7 fix round 1).
// Greedy and deterministic: per scenario in catalogue order, rows in registry
// order take the first sport that still needs covering, then leftover sports
// take the first owed row. Registry order, never the caller's: the
// variants are looked up by sport. Committed by gen-catalogue.ts (R11).
//
// "Owed" by L2 includes a pair whose ONLY drop is the rule's L3
// harness gap (Rule.gap: the rule applies, the L3 generator cannot drive it):
// a browser scorer can, so L2 plans it and marks the run `l3Gap` for W1c to
// record, as it records knownNoPath / l2NoPath (controller ruling, T7
// dispatch). A genuinely inapplicable pair stays dropped. Ruling 30: atoms
// with a known path gap still get their runs (W1c reads the catalogue).
//
// W1c Task 12: parseL2Pairs / loadL2Pairs read the COMMITTED file back, for
// the L2 layer planner (lib/layers.ts), which filters it and never re-plans.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROW_KEYS, SPORT_KEYS, type RowKey } from "./catalogue.ts";
import { MissingRule, RULES, decide, type Rule } from "./applicability.ts";
import { l2Atomic } from "./scenario-catalogue.ts";
import type { SportVariants } from "./variants.ts";
import { L2_WIDTHS, type L2Width } from "./widths.ts";

// The widths live in the leaf widths.ts (W1c Task 4); re-exported here so
// every existing `from "./pairs.ts"` import of them keeps working.
export { L2_WIDTHS } from "./widths.ts";
export type { L2Width } from "./widths.ts";

export interface L2Run {
  readonly n: number;
  readonly scenario: string;
  readonly row: RowKey;
  readonly sport: string;
  readonly preset: string;
  readonly bound: string | null;
  readonly width: L2Width;
  readonly covers: readonly ("row" | "sport")[];
  /** The rule's harness-gap reason when L3 cannot drive this pair (the gap is
   *  its only drop); null when L3 plans it too. */
  readonly l3Gap: string | null;
}

export interface L2Plan {
  runs: L2Run[];
  /** The pairs the plan OWES — not the "applicable" ones: per scenario, every
   *  row and every sport with at least one owed cell, where a cell is owed when
   *  the scenario applies there (L3 plans it too) OR its only drop is the L3
   *  harness gap (the run is marked `l3Gap`). Each is covered by exactly one
   *  run's `covers`. counts.json reports their sum as `pairTargets`. */
  targets: { rowScenario: number; sportScenario: number };
  perScenario: Record<string, number>;
}

export class UnknownL2Scenario extends Error {
  readonly ids: readonly string[];
  constructor(ids: readonly string[]) {
    super(ids.length === 0
      ? "pairs: 'only' is empty (the set []) — an empty filter would plan nothing and read green"
      : `pairs: 'only' names ids that are not L2 scenarios: ${ids.join(", ")} — a typo, or an L3-only atom, would plan nothing`);
    this.name = "UnknownL2Scenario";
    this.ids = ids;
  }
}

/** `variants` must hold exactly one entry per registry sport: decide() reads an
 *  absent sport as "no committed variants" and would plan less, silently. */
export class VariantsIncomplete extends Error {
  readonly missing: readonly string[];
  readonly duplicated: readonly string[];
  readonly unknown: readonly string[];
  constructor(missing: readonly string[], duplicated: readonly string[], unknown: readonly string[]) {
    const list = (xs: readonly string[]) => (xs.length === 0 ? "none" : xs.join(", "));
    super(`pairs: variants must hold exactly one entry per registry sport (SPORT_KEYS) — missing: ${list(missing)}; duplicated: ${list(duplicated)}; unknown: ${list(unknown)}. decide() reads an absent sport as "no committed variants" and would plan less, silently`);
    this.name = "VariantsIncomplete";
    this.missing = missing;
    this.duplicated = duplicated;
    this.unknown = unknown;
  }
}

/** decide() reported the rule gapped at this pair, yet with the gap lifted it
 *  does not apply: the run's preset and bound would be invented. */
export class GapUnbound extends Error {
  readonly scenario: string;
  readonly row: string;
  readonly sport: string;
  constructor(scenario: string, row: string, sport: string, gapped: readonly string[]) {
    super(`pairs: ${scenario} at ${row}|${sport} is gapped at ${gapped.join(", ")} but does not apply once the gap is lifted`);
    this.name = "GapUnbound";
    this.scenario = scenario;
    this.row = row;
    this.sport = sport;
  }
}

interface Owed { readonly row: RowKey; readonly sport: string; readonly preset: string; readonly bound: string | null; readonly l3Gap: string | null }

/** Applies (L3 plans it too), or its only drop is the gap: bound as decide
 *  binds the rule with the gap lifted. Else null (genuinely inapplicable). */
function owed(id: string, r: Rule, row: RowKey, sport: string, variants: readonly SportVariants[]): Owed | null {
  const d = decide(r, row, sport, variants);
  if (d.applies) return { row, sport, preset: d.preset, bound: d.bound, l3Gap: null };
  const { gap, ...lifted } = r;
  if (gap === undefined || d.gapped.length === 0) return null;
  const u = decide(lifted, row, sport, variants);
  if (!u.applies) throw new GapUnbound(id, row, sport, d.gapped);
  return { row, sport, preset: u.preset, bound: u.bound, l3Gap: gap.reason };
}

export function planL2(input: { rules?: Readonly<Record<string, Rule>>; variants: readonly SportVariants[]; only?: readonly string[] }): L2Plan {
  const rules = input.rules ?? RULES;
  const given = input.variants.map((v) => v.sport);
  const missing = SPORT_KEYS.filter((s) => !given.includes(s));
  const duplicated = SPORT_KEYS.filter((s) => given.indexOf(s) !== given.lastIndexOf(s));
  const unknown = given.filter((s) => !SPORT_KEYS.includes(s));
  if (missing.length + duplicated.length + unknown.length > 0) throw new VariantsIncomplete(missing, duplicated, unknown);
  const atoms = l2Atomic();
  const only = input.only;
  if (only !== undefined) {
    if (only.length === 0) throw new UnknownL2Scenario([]);
    const bad = only.filter((id) => !atoms.some((a) => a.id === id));
    if (bad.length > 0) throw new UnknownL2Scenario(bad);
  }
  const runs: L2Run[] = [];
  const targets = { rowScenario: 0, sportScenario: 0 };
  const perScenario: Record<string, number> = {};
  /** Earlier scenarios whose run count is a multiple of 7 (see the width). */
  let laps = 0;
  for (const a of atoms.filter((x) => only === undefined || only.includes(x.id))) {
    const r = rules[a.id];
    if (r === undefined) throw new MissingRule(a.id);
    // Registry order throughout: rows outer, sports inner (never sorted).
    const grid: Owed[] = [];
    for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) {
      const o = owed(a.id, r, row, sport, input.variants);
      if (o !== null) grid.push(o);
    }
    const byRow = ROW_KEYS.map((row) => grid.filter((o) => o.row === row)).filter((os) => os.length > 0);
    const bySport = SPORT_KEYS.map((s) => grid.filter((o) => o.sport === s)).filter((os) => os.length > 0);
    targets.rowScenario += byRow.length;
    targets.sportScenario += bySport.length;
    const sportsLeft = new Set(bySport.map((os) => os[0].sport));
    const picks: { readonly o: Owed; readonly covers: ("row" | "sport")[] }[] = [];
    for (const os of byRow) {
      const o = os.find((x) => sportsLeft.has(x.sport)) ?? os[0];
      picks.push({ o, covers: sportsLeft.delete(o.sport) ? ["row", "sport"] : ["row"] });
    }
    for (const os of bySport) if (sportsLeft.has(os[0].sport)) picks.push({ o: os[0], covers: ["sport"] });
    // Widths rotate by run number, (n - 1) % 7: run 1 is at 320, the split
    // across widths is within one, and a scenario's runs take consecutive
    // widths. A scenario of 7m runs puts m runs on every width wherever it
    // starts, so its start alone is advanced one step per such scenario — the
    // split is still exactly the plain rotation's. Without it the 21-run
    // (one-per-row) scenarios all start on the same width and each row meets
    // the same few widths: 12 (row, width) pairs never ran (T7 review I-1).
    const shift = picks.length % L2_WIDTHS.length === 0 ? laps++ % L2_WIDTHS.length : 0;
    for (const { o, covers } of picks) {
      const n = runs.length + 1;
      runs.push({ n, scenario: a.id, row: o.row, sport: o.sport, preset: o.preset, bound: o.bound, width: L2_WIDTHS[(n - 1 + shift) % L2_WIDTHS.length], covers, l3Gap: o.l3Gap });
    }
    perScenario[a.id] = picks.length;
  }
  return { runs, targets, perScenario };
}

// --- the committed file, read back (W1c Task 12) ------------------------------

/** gen-catalogue.ts writes it; lib/layers.ts reads it. */
export const L2_PAIRS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "catalogue", "l2-pairs.json");

const WIDTH_SET: ReadonlySet<number> = new Set(L2_WIDTHS);
/** One committed run, strict: a key the planner does not know, or a row, sport
 *  or width off the grid, is refused rather than planned from. Keys in the
 *  order gen-catalogue writes them, so a parsed run serialises as its entry. */
const L2RunSchema = z.strictObject({
  n: z.number().int().min(1),
  scenario: z.string().min(1),
  row: z.custom<RowKey>((r) => typeof r === "string" && (ROW_KEYS as readonly string[]).includes(r), "row is not on the grid (ROW_KEYS)"),
  sport: z.string().refine((s) => SPORT_KEYS.includes(s), "sport is not a registry sport (SPORT_KEYS)"),
  preset: z.string().min(1),
  bound: z.string().min(1).nullable(),
  width: z.custom<L2Width>((w) => typeof w === "number" && WIDTH_SET.has(w), `width is not one of L2_WIDTHS (${L2_WIDTHS.join(", ")})`),
  covers: z.array(z.enum(["row", "sport"])).min(1),
  l3Gap: z.string().min(1).nullable(),
});

const L2PairsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedBy: z.string().min(1),
  // One authority for the widths: the file must carry L2_WIDTHS, in order.
  widths: z.array(z.number()).refine((w) => w.length === L2_WIDTHS.length && w.every((x, i) => x === L2_WIDTHS[i]), `widths are not L2_WIDTHS (${L2_WIDTHS.join(", ")})`),
  targets: z.strictObject({ rowScenario: z.number().int().nonnegative(), sportScenario: z.number().int().nonnegative() }),
  runs: z.array(L2RunSchema),
}).superRefine((f, ctx) => {
  // A run is named by its n: two runs under one n would be one run to a reader.
  const seen = new Set<number>();
  for (const [i, r] of f.runs.entries()) {
    if (seen.has(r.n)) ctx.addIssue({ code: "custom", path: ["runs", i, "n"], message: `run n ${r.n} repeats` });
    seen.add(r.n);
  }
});

export interface L2PairsFile { readonly widths: readonly number[]; readonly targets: { rowScenario: number; sportScenario: number }; readonly runs: readonly L2Run[] }

/** The committed l2-pairs.json, parsed; throws (ZodError) on anything else. */
export function parseL2Pairs(json: unknown): L2PairsFile {
  const f = L2PairsFileSchema.parse(json);
  return { widths: f.widths, targets: f.targets, runs: f.runs };
}

export function loadL2Pairs(path: string = L2_PAIRS_PATH): L2PairsFile {
  return parseL2Pairs(JSON.parse(readFileSync(path, "utf8")));
}
