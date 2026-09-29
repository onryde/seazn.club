// Design §6.2's layer sizes, derived from what gen-catalogue.ts commits (W1b
// owes the formulas and the real numbers). Pure and deterministic (R11).
import { ROW_KEYS, SPORT_KEYS } from "./catalogue.ts";
import { cellFacts, scenarioCounts, type Drop, type PlannedCase } from "./applicability.ts";
import { ATOMIC, LIFECYCLE_ID, PARENTS, l2Atomic, l3Atomic, type RegressionCase } from "./scenario-catalogue.ts";
import type { L2Run } from "./pairs.ts";
import { offlineBuilderDefault, type SportVariants, type VariantCase } from "./variants.ts";

/** A variant case listed apart, with where its work is routed. */
export interface CaseList { count: number; routedTo?: string; why: string; ids: string[] }

export interface Counts {
  schemaVersion: 1;
  grid: { rows: number; sports: number; cells: number };
  catalogue: { parents: number; atomic: number; atomicL3: number; atomicL2: number };
  l1: { formula: string; value: number };
  /** `pairTargets`: the OWED (row, scenario) + (sport, scenario) pairs
   *  (pairs.ts L2Plan.targets) — not the applicable ones: a pair whose only
   *  drop is the L3 harness gap is owed too, its run marked l3Gap. */
  l2: { formula: string; value: number; pairTargets: number; l3GapRuns: number };
  /** Only the SCORABLE variant cases count (fix round 1, I-1): an unscorable
   *  case is listed under `variants`, never counted as an L3 run. */
  l3: { formula: string; lifecycle: number; atomicApplicable: number; bound: number; variantCasesScorable: number; variantCasesUnscorable: number; denied: number; regressions: number; value: number };
  /** `harnessGap`: drops where the rule applies but the L3 harness cannot
   *  drive it yet (Rule.gap); `unscorableOnly`: drops only unscorable
   *  committed variants would lift — each recorded apart from a real
   *  inapplicability (drop-list.json `kinds`). */
  drops: { total: number; harnessGap: number; unscorableOnly: number; byScenario: Record<string, number> };
  /** `unscorable` = engineUnscorable + generatorUnsupported (kept: T16 reads
   *  it). `noOp`: no overrides at the builder-default preset — the case runs
   *  the builder-default cfg again; listed, not removed from the set. */
  variants: {
    perSport: Record<string, number>;
    cases: number;
    scorable: number;
    unscorable: number;
    engineUnscorable: CaseList;
    generatorUnsupported: CaseList;
    noOp: CaseList;
    uncoverablePairs: number;
  };
}

/** An unscorable reason (VariantCase.scorable) that is neither an engine
 *  refusal nor a generator gap — refused by name rather than guessed into a
 *  bucket that routes it to the wrong wave. */
export class UnscorableUnclassified extends Error {
  readonly id: string;
  constructor(id: string, reason: string) {
    super(`counts: variant case ${id} is unscorable for a reason counts.ts cannot route: ${reason}`);
    this.name = "UnscorableUnclassified";
    this.id = id;
  }
}

/** variants.ts's reason shapes: `cfg: <Err>: …` (the engine's configSchema
 *  refused the cfg) or `win-<side>: <Err>: …` (generate, then fold). */
function unscorableClass(vc: VariantCase & { scorable: string }): "engine" | "generator" {
  if (/^cfg: /.test(vc.scorable) || /^win-(home|away): EngineError: /.test(vc.scorable)) return "engine";
  if (/^win-(home|away): GeneratorUnsupported: /.test(vc.scorable)) return "generator";
  throw new UnscorableUnclassified(vc.id, vc.scorable);
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
  const all = input.variants.flatMap((v) => v.cases);
  const engine: string[] = [];
  const generator: string[] = [];
  for (const vc of all) {
    if (vc.scorable === null) continue;
    (unscorableClass({ ...vc, scorable: vc.scorable }) === "engine" ? engine : generator).push(vc.id);
  }
  const scorable = all.length - engine.length - generator.length;
  const noOp = input.variants.flatMap((v) => v.cases.filter((c) => Object.keys(c.overrides).length === 0 && c.preset === offlineBuilderDefault(v.sport)).map((c) => c.id));
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
      formula: "Σ cells (1 LIFECYCLE + applicable L3 atomic, variant-bound included) + scorable variant cases (Q-B: LIFECYCLE each; unscorable ones are listed under variants, not run) + denied cases (one per gated row, generic) + regression cases",
      lifecycle,
      atomicApplicable,
      bound: input.l3.cases.filter((c) => c.bound !== null).length,
      variantCasesScorable: scorable,
      variantCasesUnscorable: engine.length + generator.length,
      denied,
      regressions,
      value: lifecycle + atomicApplicable + scorable + denied + regressions,
    },
    drops: {
      total: input.l3.drops.length,
      harnessGap: input.l3.drops.filter((d) => d.kind === "harness-gap").length,
      unscorableOnly: input.l3.drops.filter((d) => d.kind === "unscorable-only").length,
      // Every L3 scenario in catalogue order (zero where nothing drops), never
      // the plan's first-seen order.
      byScenario: Object.fromEntries([LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)].map((id) => [id, dropped[id] ?? 0])),
    },
    variants: {
      perSport: Object.fromEntries(input.variants.map((v) => [v.sport, v.cases.length])),
      cases: all.length,
      scorable,
      unscorable: engine.length + generator.length,
      engineUnscorable: { count: engine.length, routedTo: "W2", why: "the engine refuses the cfg or its stream (EngineError): a rulebook question for W2", ids: engine },
      generatorUnsupported: { count: generator.length, routedTo: "W1-driving", why: "the stream generator does not build this cfg yet (GeneratorUnsupported: cricket's two-innings presets)", ids: generator },
      noOp: { count: noOp.length, why: "no overrides at the sport's builder-default preset: the case runs the builder-default cfg again (listed, not removed from the variant set)", ids: noOp },
      uncoverablePairs: input.variants.reduce((n, v) => n + v.uncoverable.length, 0),
    },
  };
}
