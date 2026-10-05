// The plan a recorded `plan` string names, built by TODAY's planners (W1d Task 7, ruling T6-LIVEPLAN).
//
// This lived in __tests__/committed-plans.ts, and lib/judge.ts (the judge CLI's own module) imported it from
// there: shipped code depended on a test module. It is hoisted here so both read one definition — the test
// module re-exports it, so its importers are unchanged — and boundary.test.ts holds every shipped module off
// __tests__ from now on.
//
// A plan's cases are keyed WITHOUT the variant (the DB's builder default, which a planner reads live and a
// consumer with no DB — the committed-plans judge, a CI judge — cannot), and, for a plain run, without the run's
// one width. Adding a `--set` (or any other recorded plan shape) to run.ts's planOf owes a branch in livePlan.
import { decideState } from "./results.ts";
import { API_ONLY_BROWSER_SET, LAYER_GRID_PLANNERS, W1_DRIVING_L1_SET, WIDTH_SWEEP_SET, apiOnlyBrowserPlanner, l1Planner, l2Planner, layerCaseId, w1DrivingL1Planner, widthSweepPlanner, type LayerCase } from "./layers.ts";
import { PAD_PROOF_SET, padProofPlanner } from "./pad-proof-set.ts";
import { PROBE_SET, probePlanner } from "./probe-set.ts";
import { PR_SAMPLE_SET, PrSampleNeedsRows, parseRows, prSamplePlanner } from "./pr-sample.ts";
import { planCanaryCase, planSliceCases } from "./slice.ts";
import { W1_DRIVING_SET, w1DrivingPlanner } from "./w1-driving-set.ts";

export interface ExpectedPlan {
  readonly plan: string;
  readonly layered: boolean;
  readonly driven: ReadonlySet<string>;
  readonly planned: ReadonlyMap<string, { readonly state: "no_path" | "not_run"; readonly reason: string }>;
}
export const noVariant = (caseId: string): string => caseId.split("|").filter((_, i) => i !== 2).join("|");
export const noWidth = (caseId: string): string => caseId.replace(/@\d+$/, "");
/** Variant-free keys: every planner is handed the sport as its own variant, and the key drops it. */
const anyVariant = (sport: string): string => sport;

/** One plan item in the order the planner lists it: its variant-free key, and null when it is DRIVEN or the planner's own
 *  🚫/░ when it is only planned. run.ts stripes the plan in exactly this order (`runItems`), so a consumer that must know
 *  which stripe holds which item (the CI shard matrix, D4) reads the order from here, never from a Set. */
type OrderedItem = { readonly key: string; readonly planned: { readonly state: "no_path" | "not_run"; readonly reason: string } | null };
interface Ordered { readonly plan: string; readonly layered: boolean; readonly items: readonly OrderedItem[] }

function fromLayered(plan: string, cases: readonly LayerCase[]): Ordered {
  const items = cases.map((c): OrderedItem => {
    const key = noVariant(layerCaseId(c));
    if (c.spec !== null) return { key, planned: null };
    // The stored reason is what decideState makes of the planner's own 🚫/░ (run.ts recordPlanned).
    const d = decideState({ checks: [], deferred: null, error: null, noPath: c.noPath, notRun: c.notRun });
    return { key, planned: { state: d.state as "no_path" | "not_run", reason: d.reason } };
  });
  return { plan, layered: true, items };
}
const fromSpecs = (plan: string, ids: readonly string[]): Ordered =>
  ({ plan, layered: false, items: ids.map((id) => ({ key: noVariant(id), planned: null })) });

/** The plan a recorded `plan` string names, built by TODAY's planners. */
export function livePlan(plan: string): ExpectedPlan {
  const o = orderedPlan(plan);
  const driven = new Set<string>();
  const planned = new Map<string, { state: "no_path" | "not_run"; reason: string }>();
  for (const it of o.items) {
    if (it.planned === null) driven.add(it.key);
    else planned.set(it.key, { ...it.planned });
  }
  return { plan: o.plan, layered: o.layered, driven, planned };
}

/** W1d Task 8 (D4): for each item of the plan, in the order `--shard k/N` stripes it, whether the run DRIVES it (true) or
 *  only records it planned (false: a 🚫/░ costs no time). The CI shard matrix budgets each job's timeout from the driven
 *  items of that job's own stripe, so it needs the order — `ExpectedPlan` keeps sets and loses it. */
export function drivenInPlanOrder(plan: string): boolean[] {
  return orderedPlan(plan).items.map((it) => it.planned === null);
}

function orderedPlan(plan: string): Ordered {
  const words = plan.split(" ");
  const flag = (name: string): string | undefined => { const i = words.indexOf(name); return i < 0 ? undefined : words[i + 1]; };
  const filters = { only: flag("--only"), scenario: flag("--scenario") };
  if (words[0] === "--set") {
    const set = words[1];
    // W1d item 15b: the one-sport pad proof (run.ts planOf records its --only). A planner that ignored the recorded
    // filter would judge a one-sport run against the whole set's plan: the filter is read here, as w1-driving's is.
    if (set === PAD_PROOF_SET) return fromSpecs(plan, padProofPlanner({ only: filters.only }).plan(anyVariant).map((c) => c.caseId));
    if (set === PROBE_SET) return fromSpecs(plan, probePlanner({}).plan(anyVariant).map((c) => c.caseId));
    if (set === API_ONLY_BROWSER_SET) return fromLayered(plan, apiOnlyBrowserPlanner({}).layered(anyVariant));
    if (set === WIDTH_SWEEP_SET) return fromLayered(plan, widthSweepPlanner({}).layered(anyVariant));
    // W1-driving Task 13 (T13-R1 I-1): the capability cells and the two template cards, at 1280.
    if (set === W1_DRIVING_L1_SET) return fromLayered(plan, w1DrivingL1Planner({}).layered(anyVariant));
    // W1-driving Task 12: the one set that takes --only / --scenario (run.ts planOf records them).
    if (set === W1_DRIVING_SET) return fromSpecs(plan, w1DrivingPlanner(filters).plan(anyVariant).map((c) => c.caseId));
    // W1d Task 7 (D13): the per-PR sample takes the rows the PR declared (run.ts planOf records them, sorted). A
    // plan with no rows is no plan: refused by name, never read as the fixed sample alone.
    if (set === PR_SAMPLE_SET) {
      const rows = flag("--rows");
      if (rows === undefined) throw new PrSampleNeedsRows();
      return fromSpecs(plan, prSamplePlanner({ rows: parseRows(rows) }).plan(anyVariant).map((c) => c.caseId));
    }
  }
  if (words[0] === "--canary" && words[1] !== undefined) return fromSpecs(plan, [planCanaryCase(anyVariant, words[1]).caseId]);
  // W1d Task 3: `--scope grid` is the full grid; a bare `--layer L1` stays the slice, so every
  // committed entry is judged exactly as before. The grid takes no filter.
  const grid = flag("--scope") === "grid";
  if (words[0] === "--layer" && words[1] === "L1") return fromLayered(plan, (grid ? LAYER_GRID_PLANNERS.L1({}) : l1Planner(filters)).layered(anyVariant));
  if (words[0] === "--layer" && words[1] === "L2") return fromLayered(plan, (grid ? LAYER_GRID_PLANNERS.L2({}) : l2Planner(filters)).layered(anyVariant));
  if (words[0] === "slice") return fromSpecs(plan, planSliceCases(anyVariant, filters).map((c) => c.caseId));
  throw new Error(`committed-plans: no planner for the recorded plan "${plan}"`);
}
