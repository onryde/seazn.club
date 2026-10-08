// Ruling 61 (design §6.5) and D6: harness-green is mechanical. A harness fault is
// a crash, a non-product error, a vacuous red, or a ░ the plan did not mark
// planned; product reds (incl. RefusedCall — the product answering) are data.
// States must be identical across runs, per case.
//
//   harnessFaults  one run's faults (D6), by class;
//   statesAcross   the per-case states of K runs, compared (ruling 61);
//   regressions    a run against the committed baseline, restricted to the exact
//                  ids a sample planned (D13, review C3c);
//   forceBaselineStates  the baseline as it is judged: the ids owner ruling 70 holds red, read red;
//   matchPlanIds   a run's case ids against the planner's, for the plan the run
//                  recorded (ruling T4-IDS): CI runs have no lock entry, so this
//                  is the only check that a merged run holds the plan's cases;
//   scopeOfPlan    "<layer> (<scope>)" derived from a plan string (ruling T6-SCOPE);
//   JudgeOut       the verdict as JSON, which `summary --judge` (Task 8) reads.
import { z } from "zod";
import { livePlan, noVariant, noWidth, type ExpectedPlan } from "./expected-plan.ts";
import { CASE_STATES, LAYERS, VACUOUS_REASONS, isPlannedShape, type CaseResultV2, type CaseState, type RunResults } from "./results.ts";

// ---------------------------------------------------------------------------------------------------------------
// Refusals

/** Every way the judge refuses to judge (exit 2, nothing written). Each is the Error's own `name`. */
export const JUDGE_REFUSALS = [
  "RunUnreadable", "RunNotV3", "TooFewRuns", "RunRepeated", "RunsDisagree", "NoCases", "PlanMissing", "PlanUnknown", "PlanIdsMismatch", "ScopeMismatch",
  "ExpectUnreadable", "ExpectedAbsent", "UnexpectedCase", "RerunMissing", "NoneCompared", "CaseIdsDiffer", "BaselineUnreadable",
] as const;
export type JudgeRefusalName = (typeof JUDGE_REFUSALS)[number];

export class JudgeRefused extends Error {
  constructor(name: JudgeRefusalName, message: string) {
    super(message);
    this.name = name;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// D6: harness faults

export const FAULT_KINDS = ["crash", "harness-error", "setup-refused", "vacuous", "unplanned-not-run", "planned-not-run", "marker-on-driven"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
export interface Fault { caseId: string; kind: FaultKind; reason: string }

/** What the judge reads of a run: its cases, v2 (the committed evidence) or v3 (a `planned` marker besides). */
export type JudgedRun = { readonly cases: readonly (CaseResultV2 & { readonly planned?: true })[] };

// results.ts VACUOUS_REASONS: { none, abstained } are whole reasons; zeroItemsPrefix carries a suffix of check ids.
const isVacuous = (r: string): boolean => r === VACUOUS_REASONS.none || r === VACUOUS_REASONS.abstained || r.startsWith(VACUOUS_REASONS.zeroItemsPrefix);

// D6: a refusal raised inside setUpDivision's setup phase is tagged SetupRefused at the seam
// (scenarios/common.ts inSetup) — the harness asked wrongly. A RefusedCall anywhere else is the product answering.

/** `plannedNotRun` (ruling 65) is `allow` for every caller: a ░ the plan marked planned is not a fault, and a ░ on
 *  a driven case still is. `refuse` exists so a test can show what the option changes. */
export function harnessFaults(run: JudgedRun, opts: { plannedNotRun: "allow" | "refuse" }): Fault[] {
  const out: Fault[] = [];
  for (const c of run.cases) {
    const reason = c.reason;
    let kind: FaultKind | null = null;
    // R2-m6: the marker is trusted only in the shape it can be checked without a plan — the ONE shape predicate
    // (isPlannedShape, T2-PRED) and no time spent. A marked case that ran is a driven result relabelled.
    if (c.planned === true && (c.durationMs > 0 || !isPlannedShape(c))) kind = "marker-on-driven";
    else if (c.state === "red" && reason.startsWith("error: crashed —")) kind = "crash";
    else if (c.state === "red" && reason.startsWith("error: SetupRefused:")) kind = "setup-refused";
    else if (c.state === "red" && reason.startsWith("error: ") && !reason.startsWith("error: RefusedCall:")) kind = "harness-error";
    else if (c.state === "red" && isVacuous(reason)) kind = "vacuous";
    else if (c.state === "not_run" && c.planned !== true) kind = "unplanned-not-run";
    else if (c.state === "not_run" && opts.plannedNotRun === "refuse") kind = "planned-not-run";
    if (kind !== null) out.push({ caseId: c.caseId, kind, reason });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Ruling 61: states across runs

/** The per-case states of K runs. `compared` counts the cases every run holds; `differing` lists those whose state is
 *  not the same in every run (with the state per run, in run order — never a majority); `missing` lists a case some run
 *  does not hold, with the runs (0-based) that do. A red that is the same red everywhere is NOT a difference. */
export function statesAcross(runs: readonly JudgedRun[]): { compared: number; differing: { caseId: string; states: string[] }[]; missing: { caseId: string; inRuns: number[] }[] } {
  const ids = new Set(runs.flatMap((r) => r.cases.map((c) => c.caseId)));
  const maps = runs.map((r) => new Map(r.cases.map((c) => [c.caseId, c.state as string])));
  const differing: { caseId: string; states: string[] }[] = [];
  const missing: { caseId: string; inRuns: number[] }[] = [];
  let compared = 0;
  for (const id of ids) {
    const inRuns = maps.flatMap((m, i) => (m.has(id) ? [i] : []));
    if (inRuns.length !== runs.length) { missing.push({ caseId: id, inRuns }); continue; }
    compared++;
    const states = maps.map((m) => m.get(id) as string);
    if (new Set(states).size > 1) differing.push({ caseId: id, states });
  }
  return { compared, differing, missing };
}

// ---------------------------------------------------------------------------------------------------------------
// D13: regression against the baseline

/** The states a regression is measured from: a case that WORKED, or that the product refused as the rulebook says. */
export const HELD: ReadonlySet<string> = new Set(["works", "refused"]);

/** What `regressions` reads of a run: any version's cases. */
export type RunLike = { readonly cases: readonly Pick<CaseResultV2, "caseId" | "state" | "reason">[] };

/** The baseline as it is judged (owner ruling 70): each id in `forced` is read in the state `forced` gives it, whatever the baseline run
 *  recorded. A case forced to red is no longer HELD, so a later red on it is no change and a later works is an improvement — the
 *  baseline run's own luck (a lots draw that paired nobody in some runs) is not a promise the product made. `applied` lists the forced
 *  ids the baseline holds, in baseline order: an id it lacks overrides nothing, and is not counted as applied. The input is not edited. */
export function forceBaselineStates<T extends RunLike>(baseline: T, forced: ReadonlyMap<string, CaseState>): { run: T; applied: string[] } {
  const applied: string[] = [];
  const cases = baseline.cases.map((c) => {
    const state = forced.get(c.caseId);
    if (state === undefined) return c;
    applied.push(c.caseId);
    return { ...c, state };
  });
  return { run: { ...baseline, cases }, applied };
}

/** `baseline` against `now`, restricted to EXACTLY the ids in `expected` — never a cell or a scenario: the baseline's
 *  `league|cricket|test|LIFECYCLE|cricket#…` cases share a cell and a scenario with the fixed sample's
 *  `league|cricket|<variant>|LIFECYCLE`, and a cell filter would report them absent on every PR (review C3c).
 *  `compared` counts expected cases present in both runs; `absent` lists expected cases the baseline held and `now` lacks. */
export function regressions(baseline: RunLike, now: RunLike, expected: readonly string[]): { compared: number; regressed: { caseId: string; was: CaseState; now: CaseState; reason: string }[]; absent: string[] } {
  const want = new Set(expected);
  const nowBy = new Map(now.cases.map((c) => [c.caseId, c]));
  const regressed: { caseId: string; was: CaseState; now: CaseState; reason: string }[] = [];
  const absent: string[] = [];
  let compared = 0;
  for (const b of baseline.cases) {
    if (!want.has(b.caseId)) continue; // not planned by this sample (review C3c)
    const n = nowBy.get(b.caseId);
    if (n === undefined) { if (HELD.has(b.state)) absent.push(b.caseId); continue; }
    compared++;
    if (HELD.has(b.state) && !HELD.has(n.state)) regressed.push({ caseId: b.caseId, was: b.state, now: n.state, reason: n.reason });
  }
  return { compared, regressed, absent };
}

// ---------------------------------------------------------------------------------------------------------------
// T6-SCOPE and T4-IDS: what a run says it is, against the plan it recorded

/** "<layer> (<scope>)" for a `--layer` plan, as run.ts's scopeOf writes it, derived from the PLAN string (planOf's):
 *  `--layer L1` is the slice, `--layer L1 --scope grid` the grid. Any other plan (a slice, a set, a canary) has none. */
export function scopeOfPlan(plan: string): string | null {
  const words = plan.split(" ");
  if (words[0] !== "--layer" || (words[1] !== "L1" && words[1] !== "L2")) return null;
  const at = words.indexOf("--scope");
  return `${words[1]} (${at >= 0 && words[at + 1] === "grid" ? "grid" : "slice"})`;
}

/** Plans are deterministic, and `across` asks for one three times. */
const PLANS = new Map<string, ExpectedPlan>();
function expectedPlan(plan: string): ExpectedPlan {
  const hit = PLANS.get(plan);
  if (hit !== undefined) return hit;
  let built: ExpectedPlan;
  try {
    built = livePlan(plan);
  } catch (e) {
    throw new JudgeRefused("PlanUnknown", `${plan}: ${e instanceof Error ? e.message : String(e)}`);
  }
  PLANS.set(plan, built);
  return built;
}

const FEW = 5;
const some = (list: readonly string[]): string => `${list.length}: ${list.slice(0, FEW).join(", ")}${list.length > FEW ? `, … and ${list.length - FEW} more` : ""}`;

/** The run's case ids against the ids the planner makes for the plan the run recorded (ruling T4-IDS): the same
 *  keys, no more, no fewer, none twice. The key drops the variant (the DB's builder default, which a planner reads
 *  live and a CI judge has no DB for), and for a plain plan the width — exactly the key committed-plans' judgeRun uses.
 *  Refuses by name: NoCases, PlanMissing, ScopeMismatch (T6-SCOPE), PlanUnknown, PlanIdsMismatch.
 *  `compared` is the number of plan ids the run was held to; zero is NoCases, never a pass. */
export function matchPlanIds(run: RunResults): { compared: number } {
  if (run.cases.length === 0) throw new JudgeRefused("NoCases", `${run.runId}: zero cases — nothing to judge (vacuous)`);
  if (run.plan === undefined) throw new JudgeRefused("PlanMissing", `${run.runId}: records no plan, so its case ids cannot be checked`);
  // T6-SCOPE: a scope, when the run records one, is the plan's own.
  if (run.scope !== undefined) {
    const want = scopeOfPlan(run.plan);
    if (want !== run.scope) throw new JudgeRefused("ScopeMismatch", `${run.runId}: scope ${JSON.stringify(run.scope)} is not its plan's (${JSON.stringify(run.plan)} is ${want === null ? "a plan with no scope" : JSON.stringify(want)})`);
  }
  const plan = expectedPlan(run.plan);
  const keyOf = (id: string): string => (plan.layered ? noVariant(id) : noWidth(noVariant(id)));
  const expected = new Set([...plan.driven, ...plan.planned.keys()]);
  const seen = new Map<string, string>();
  const repeated: string[] = [];
  for (const c of run.cases) {
    const k = keyOf(c.caseId);
    if (seen.has(k)) repeated.push(c.caseId);
    else seen.set(k, c.caseId);
  }
  const missing = [...expected].filter((k) => !seen.has(k));
  const extra = [...seen].filter(([k]) => !expected.has(k)).map(([, id]) => id);
  if (missing.length + extra.length + repeated.length > 0) {
    const parts = [
      ...(missing.length > 0 ? [`missing ${some(missing)}`] : []),
      ...(extra.length > 0 ? [`extra ${some(extra)}`] : []),
      ...(repeated.length > 0 ? [`repeated ${some(repeated)}`] : []),
    ];
    throw new JudgeRefused("PlanIdsMismatch", `${run.runId}: its cases are not the plan ${JSON.stringify(run.plan)}'s (${expected.size} ids) — ${parts.join("; ")}`);
  }
  // No missing, no extra, and the run has a case: the plan's ids and the run's are one non-empty set, so `compared` is never 0.
  return { compared: expected.size };
}

// ---------------------------------------------------------------------------------------------------------------
// JudgeOut (PF-1): the verdict as JSON, read by Task 8's `summary --judge <path>`

/** The judge's verdict, as `--json-out` writes it. Written for a verdict only (exit 0 or 1): a refusal (exit 2) writes
 *  nothing, so a reader never finds a verdict a refused run did not reach. One judgement per file: `faults` judges one run,
 *  `across` K runs of one layer, `regression` a sample against the baseline. A field a mode does not produce is empty. */
export const JudgeOutSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["across", "faults", "regression"]),
  exit: z.union([z.literal(0), z.literal(1)]),
  /** The layer judged (`regression`: the layer of `now`, null when `now` is a v2 run). */
  layer: z.enum(LAYERS).nullable(),
  /** Run ids, in argument order (`regression`: the `now` run). */
  runs: z.array(z.string().min(1)).min(1),
  /** `across` and `faults`: the --planned-not-run setting; `regression` has none. */
  plannedNotRun: z.enum(["allow", "refuse"]).nullable(),
  /** Cases compared: the plan's ids (`faults`), the cases every run holds (`across`), the expected cases in both runs (`regression`). Never 0. */
  compared: z.number().int().min(1),
  faults: z.array(z.strictObject({ run: z.string().min(1), caseId: z.string().min(1), kind: z.enum(FAULT_KINDS), reason: z.string() })),
  differing: z.array(z.strictObject({ caseId: z.string().min(1), states: z.array(z.string().min(1)).min(2) })),
  /** What `statesAcross` returns; the CLI refuses a non-empty list (CaseIdsDiffer) before it writes a verdict, so a file's is always []. */
  missing: z.array(z.strictObject({ caseId: z.string().min(1), inRuns: z.array(z.number().int().min(0)) })),
  /** `rerun` is the same case's state on the re-run, when there was one. */
  regressed: z.array(z.strictObject({ caseId: z.string().min(1), was: z.enum(CASE_STATES), now: z.enum(CASE_STATES), reason: z.string(), rerun: z.enum(CASE_STATES).optional() })),
  absent: z.array(z.string().min(1)),
});
export type JudgeOut = z.infer<typeof JudgeOutSchema>;
export const parseJudgeOut = (json: unknown): JudgeOut => JudgeOutSchema.parse(json);
