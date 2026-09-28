// Design §6.2's layer sizes, derived from what gen-catalogue.ts commits (W1b
// owes the formulas and the real numbers). Pure and deterministic (R11).
import { ROW_KEYS, SPORT_KEYS } from "./catalogue.ts";
import { cellFacts, scenarioCounts, type Drop, type PlannedCase } from "./applicability.ts";
import { ATOMIC, LIFECYCLE_ID, PARENTS, l2Atomic, l3Atomic, type RegressionCase } from "./scenario-catalogue.ts";
import type { L2Run } from "./pairs.ts";
import type { SportVariants } from "./variants.ts";

export interface Counts {
  schemaVersion: 1;
  grid: { rows: number; sports: number; cells: number };
  catalogue: { parents: number; atomic: number; atomicL3: number; atomicL2: number };
  l1: { formula: string; value: number };
  /** `pairTargets`: the OWED (row, scenario) + (sport, scenario) pairs
   *  (pairs.ts L2Plan.targets) — not the applicable ones: a pair whose only
   *  drop is the L3 harness gap is owed too, its run marked l3Gap. */
  l2: { formula: string; value: number; pairTargets: number; l3GapRuns: number };
  l3: { formula: string; lifecycle: number; atomicApplicable: number; bound: number; variantCases: number; denied: number; regressions: number; value: number };
  /** `harnessGap`: drops where the rule applies but the L3 harness cannot
   *  drive it yet (Rule.gap) — recorded apart from a real inapplicability. */
  drops: { total: number; harnessGap: number; byScenario: Record<string, number> };
  variants: { perSport: Record<string, number>; uncoverablePairs: number; unscorable: number };
}

export function computeCounts(input: {
  l3: { cases: readonly PlannedCase[]; drops: readonly Drop[] };
  l2: { runs: readonly L2Run[]; targets: { rowScenario: number; sportScenario: number } };
  variants: readonly SportVariants[];
  regressions: readonly RegressionCase[];
}): Counts {
  const cells = ROW_KEYS.length * SPORT_KEYS.length;
  const lifecycle = input.l3.cases.filter((c) => c.scenario === LIFECYCLE_ID).length;
  const atomicApplicable = input.l3.cases.length - lifecycle;
  const variantCases = input.variants.reduce((n, v) => n + v.cases.length, 0);
  // Q-B / ruling 29 and the format gate: one denied case per gated row, on generic.
  const denied = ROW_KEYS.filter((r) => cellFacts(r, "generic").gate !== null).length;
  const regressions = input.regressions.length;
  const dropped = scenarioCounts(input.l3.drops);
  return {
    schemaVersion: 1,
    grid: { rows: ROW_KEYS.length, sports: SPORT_KEYS.length, cells },
    catalogue: { parents: PARENTS.length, atomic: ATOMIC.length, atomicL3: l3Atomic().length, atomicL2: l2Atomic().length },
    l1: { formula: "cells × 2 widths (1280, 320)", value: cells * 2 },
    l2: {
      formula: "runs in l2-pairs.json; pairTargets = owed (row, scenario) + (sport, scenario) pairs (the scenario applies there, or its only drop is the L3 harness gap — that run is marked l3Gap), each covered by one run, so runs ≥ owed (row, scenario) pairs",
      value: input.l2.runs.length,
      pairTargets: input.l2.targets.rowScenario + input.l2.targets.sportScenario,
      l3GapRuns: input.l2.runs.filter((r) => r.l3Gap !== null).length,
    },
    l3: {
      formula: "Σ cells (1 LIFECYCLE + applicable L3 atomic, variant-bound included) + variant cases (Q-B: LIFECYCLE each) + denied cases (one per gated row, generic) + regression cases",
      lifecycle,
      atomicApplicable,
      bound: input.l3.cases.filter((c) => c.bound !== null).length,
      variantCases,
      denied,
      regressions,
      value: lifecycle + atomicApplicable + variantCases + denied + regressions,
    },
    drops: {
      total: input.l3.drops.length,
      harnessGap: input.l3.drops.filter((d) => d.harnessGap).length,
      // Every L3 scenario in catalogue order (zero where nothing drops), never
      // the plan's first-seen order.
      byScenario: Object.fromEntries([LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)].map((id) => [id, dropped[id] ?? 0])),
    },
    variants: {
      perSport: Object.fromEntries(input.variants.map((v) => [v.sport, v.cases.length])),
      uncoverablePairs: input.variants.reduce((n, v) => n + v.uncoverable.length, 0),
      unscorable: input.variants.reduce((n, v) => n + v.cases.filter((c) => c.scorable !== null).length, 0),
    },
  };
}
