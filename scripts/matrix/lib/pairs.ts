// L2 (design §6.2): every applicable (row, scenario) and (sport, scenario)
// pair runs at least once in the browser, widths rotating across the seven —
// per scenario, per format and per sport (controller ruling, T7 fix round 1).
// Greedy and deterministic: per scenario in catalogue order, rows in registry
// order take the first sport that still needs covering, then leftover sports
// take the first applicable row. Registry order, never the caller's: the
// variants are looked up by sport. Committed by gen-catalogue.ts (R11).
//
// "Applicable" for L2 includes a pair whose ONLY drop is the rule's L3
// harness gap (Rule.gap: the rule applies, the L3 generator cannot drive it):
// a browser scorer can, so L2 plans it and marks the run `l3Gap` for W1c to
// record, as it records knownNoPath / l2NoPath (controller ruling, T7
// dispatch). A genuinely inapplicable pair stays dropped. Ruling 30: atoms
// with a known path gap still get their runs (W1c reads the catalogue).
import { ROW_KEYS, SPORT_KEYS, type RowKey } from "./catalogue.ts";
import { MissingRule, RULES, decide, type Rule } from "./applicability.ts";
import { l2Atomic } from "./scenario-catalogue.ts";
import type { SportVariants } from "./variants.ts";

/** apps/web/playwright.config.ts mobile projects (pinned by pairs.test.ts). */
export const L2_WIDTHS = Object.freeze([320, 360, 375, 390, 430, 768, 834] as const);
export type L2Width = (typeof L2_WIDTHS)[number];

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
