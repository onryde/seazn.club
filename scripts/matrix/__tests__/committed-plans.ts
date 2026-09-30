// The committed-evidence judge (W1c Task 14 carry 3, fix round 1 review I-1,
// final review I-1/I-2), shared by committed-matrix.test.ts and
// committed-plans-tomorrow.test.ts. A committed run is judged case by case
// against the plan it ran: a case the plan PLANS is stored as exactly the
// plan's 🚫/░ with no check; a case the plan DRIVES is never stored as planned
// (class 6); no case is missing, repeated or outside the plan.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { decideState, parseResults, type CaseResultV2 } from "../lib/results.ts";
import { API_ONLY_BROWSER_SET, WIDTH_SWEEP_SET, apiOnlyBrowserPlanner, l1Planner, l2Planner, layerCaseId, widthSweepPlanner, type LayerCase } from "../lib/layers.ts";
import { PAD_PROOF_SET, padProofPlanner } from "../lib/pad-proof-set.ts";
import { PROBE_SET, probePlanner } from "../lib/probe-set.ts";
import { planCanaryCase, planSliceCases } from "../lib/slice.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TRUTH_RUNS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs";

/** Every file git tracks (index included, so a staged file counts) under a
 *  committed root, relative to the repo. W1c Task 14: this read the FILESYSTEM
 *  before, so a local sweep also read every untracked run left on the disk
 *  (~3800 shot PNGs from Tasks 7–11, which the Task 7 ruling keeps untracked)
 *  and timed out — committed evidence is what the repo holds. Stage new
 *  evidence before running this sweep over it. */
export const trackedUnder = (root: string): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", root], { cwd: REPO, encoding: "utf8" }).split("\0").filter((f) => f !== "");

/** How one committed case is judged. `checked`: re-decided from its checks
 *  (a refused case with its mandate, rebuilt from its reason). `errored`: an
 *  error red — decideState makes it from the error alone, whatever checks it
 *  kept (run.ts M-2 keeps a browser case's checks), so it is re-decided with
 *  that error, rebuilt from its `error: ` reason. `planned`: 🚫/░, and
 *  `deferred`: ⏳ — decideState makes both WITHOUT reading checks, and N-3
 *  gives such a row none, so a row that carries one is reported. Whether a
 *  planned/deferred case SHOULD be one is its plan's question (judgeRun). */
export type CaseKind = "checked" | "errored" | "planned" | "deferred";
export function judgeCase(c: CaseResultV2): { kind: CaseKind; wrong: string | null } {
  const differs = (d: { state: string; reason: string }): string | null =>
    d.state === c.state && d.reason === c.reason ? null : `${c.caseId}: stored ${c.state} "${c.reason}", checks decide ${d.state} "${d.reason}"`;
  if (c.state === "no_path" || c.state === "not_run" || c.state === "later") {
    const kind: CaseKind = c.state === "later" ? "deferred" : "planned";
    return { kind, wrong: c.checks.length > 0 ? `${c.caseId}: ${c.state} carries ${c.checks.length} check(s) — a planned or deferred row carries none (N-3)` : null };
  }
  if (c.state === "red" && c.reason.startsWith("error: ")) {
    return { kind: "errored", wrong: differs(decideState({ checks: c.checks, deferred: null, error: c.reason.slice("error: ".length) })) };
  }
  return { kind: "checked", wrong: differs(decideState({ checks: c.checks, deferred: null, error: null, mandated: c.state === "refused" ? c.reason : null })) };
}
/** W1c Task 14, carry 3: every case re-decided or skipped by kind, counted.
 *  The caller pins the counts: zero checked is a failure, not a pass. */
export function reDecide(cases: readonly CaseResultV2[]): { checked: number; skipped: number; wrong: string[] } {
  const judged = cases.map(judgeCase);
  return {
    checked: judged.filter((j) => j.kind === "checked").length,
    skipped: judged.filter((j) => j.kind !== "checked").length,
    wrong: judged.flatMap((j) => (j.wrong === null ? [] : [j.wrong])),
  };
}

/** A plan's cases, keyed without the variant (the DB's builder default, which
 *  the planner reads live) and, for a plain run, without the run's one width. */
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

function fromLayered(plan: string, cases: readonly LayerCase[]): ExpectedPlan {
  const driven = new Set<string>();
  const planned = new Map<string, { state: "no_path" | "not_run"; reason: string }>();
  for (const c of cases) {
    const key = noVariant(layerCaseId(c));
    if (c.spec !== null) { driven.add(key); continue; }
    // The stored reason is what decideState makes of the planner's own 🚫/░ (run.ts recordPlanned).
    const d = decideState({ checks: [], deferred: null, error: null, noPath: c.noPath, notRun: c.notRun });
    planned.set(key, { state: d.state as "no_path" | "not_run", reason: d.reason });
  }
  return { plan, layered: true, driven, planned };
}
const fromSpecs = (plan: string, ids: readonly string[]): ExpectedPlan =>
  ({ plan, layered: false, driven: new Set(ids.map(noVariant)), planned: new Map() });

/** The plan a recorded `plan` string names, built by TODAY's planners. */
export function livePlan(plan: string): ExpectedPlan {
  const words = plan.split(" ");
  const flag = (name: string): string | undefined => { const i = words.indexOf(name); return i < 0 ? undefined : words[i + 1]; };
  const filters = { only: flag("--only"), scenario: flag("--scenario") };
  if (words[0] === "--set") {
    const set = words[1];
    if (set === PAD_PROOF_SET) return fromSpecs(plan, padProofPlanner({}).plan(anyVariant).map((c) => c.caseId));
    if (set === PROBE_SET) return fromSpecs(plan, probePlanner({}).plan(anyVariant).map((c) => c.caseId));
    if (set === API_ONLY_BROWSER_SET) return fromLayered(plan, apiOnlyBrowserPlanner({}).layered(anyVariant));
    if (set === WIDTH_SWEEP_SET) return fromLayered(plan, widthSweepPlanner({}).layered(anyVariant));
  }
  if (words[0] === "--canary" && words[1] !== undefined) return fromSpecs(plan, [planCanaryCase(anyVariant, words[1]).caseId]);
  if (words[0] === "--layer" && words[1] === "L1") return fromLayered(plan, l1Planner(filters).layered(anyVariant));
  if (words[0] === "--layer" && words[1] === "L2") return fromLayered(plan, l2Planner(filters).layered(anyVariant));
  if (words[0] === "slice") return fromSpecs(plan, planSliceCases(anyVariant, filters).map((c) => c.caseId));
  throw new Error(`committed-plans: no planner for the recorded plan "${plan}"`);
}

/** One run judged against its plan, case by case: a case the plan PLANS is
 *  stored as exactly the plan's 🚫/░ (state and reason) with no check; a case
 *  the plan DRIVES is never stored as planned (class 6); no case is missing,
 *  repeated or outside the plan; a plain run is one width. The counts are the
 *  plan's by construction: `driven` + `planned` = the run's cases. */
export function judgeRun(cases: readonly CaseResultV2[], plan: ExpectedPlan): { driven: number; planned: number; wrong: string[] } {
  const keyOf = (id: string): string => (plan.layered ? noVariant(id) : noWidth(noVariant(id)));
  const wrong: string[] = [];
  const seen = new Set<string>();
  let driven = 0;
  let planned = 0;
  for (const c of cases) {
    const key = keyOf(c.caseId);
    const j = judgeCase(c);
    if (j.wrong !== null) wrong.push(j.wrong);
    if (seen.has(key)) wrong.push(`${c.caseId}: repeated in the run`);
    seen.add(key);
    const p = plan.planned.get(key);
    if (p !== undefined) {
      planned++;
      if (c.state !== p.state || c.reason !== p.reason) wrong.push(`${c.caseId}: the plan records ${p.state} "${p.reason}", stored ${c.state} "${c.reason}"`);
    } else if (plan.driven.has(key)) {
      driven++;
      // Final review I-2: only recordPlanned writes not_run, and it writes 🚫/⏳
      // with no time spent and nothing counted. A driven case always spends
      // time in prepareCaseOrg, so that shape on a driven case is a lost result
      // (class 6) — while a ⏳/🚫 the case reached at RUNTIME (ScenarioUnsupported,
      // NoOrganiserPath; run.ts) is honest.
      const unrun = c.durationMs === 0 && c.counts.calls === 0 && c.counts.fixtures === 0 && c.counts.events === 0;
      if (c.state === "not_run" || ((c.state === "no_path" || c.state === "later") && unrun)) {
        wrong.push(`${c.caseId}: the plan DRIVES this case, stored ${c.state} with ${c.checks.length} check(s) in ${c.durationMs} ms — a driven result recorded as planned (class 6)`);
      }
    } else {
      wrong.push(`${c.caseId}: not in its plan (${plan.plan})`);
    }
  }
  for (const k of [...plan.driven, ...plan.planned.keys()]) if (!seen.has(k)) wrong.push(`${k}: planned by ${plan.plan}, missing from the run`);
  if (!plan.layered && new Set(cases.map((c) => c.caseId.match(/@\d+$/)?.[0] ?? "")).size > 1) wrong.push(`${plan.plan}: a plain run holds more than one width`);
  return { driven, planned, wrong };
}

/** The committed runs written before results.json recorded its plan (carry 6,
 *  3c36ea1b3), each named with the plan its command line ran. Any other run
 *  with no recorded plan is refused, never skipped. */
export const PLAN_BEFORE_CARRY_6: Readonly<Record<string, string>> = Object.freeze({
  "w1a-slice": "slice",
  "w1b-slice": "slice",
  "w1b-probe": `--set ${PROBE_SET}`,
  // Task 8's walkthrough: one cell × LIFECYCLE per run, at 1280, 320 (×3) and over HTTP.
  ...Object.fromEntries(["1280-f", "320a", "320b", "320c", "http-f"].flatMap((w) =>
    ["generic", "badminton"].map((sport) => [`w1c-walkthrough-a/w1c-wa-${w}-${sport}`, `slice --only league|${sport} --scenario LIFECYCLE`]))),
});

/** The plan a committed run is judged against: the one it recorded, or the
 *  one it is named with from before carry 6 — never both, never neither. */
export function planFor(dir: string, recorded: string | undefined): string | { refused: string } {
  const named = PLAN_BEFORE_CARRY_6[dir];
  if (recorded !== undefined && named !== undefined) return { refused: `${dir}: records "${recorded}" AND is named "${named}" before carry 6` };
  return recorded ?? named ?? { refused: `${dir}: no recorded plan, and not named as a run from before carry 6` };
}

// Final review I-1: a committed run is judged against ITS plan as frozen when
// it was committed, never against today's planners. `--layer L1` meant "the
// slice at 1280" in W1c and will mean the full grid after W1d; one more
// scripted L2 atom turns a W1c ░ into a driven case. Judged live, either
// change reds unchanged W1c evidence as class 6, and the easy wrong repairs
// are re-running or deleting evidence.
export const LOCK_PATH = `${TRUTH_RUNS}/plans.lock.json`;
const PlannedRow = z.strictObject({ state: z.enum(["no_path", "not_run"]), reason: z.string().min(1) });
const LockEntry = z.strictObject({
  plan: z.string().min(1),
  layered: z.boolean(),
  driven: z.array(z.string().min(1)),
  planned: z.record(z.string().min(1), PlannedRow),
});
export type LockEntry = z.infer<typeof LockEntry>;
const LockFile = z.strictObject({ note: z.string().min(1), runs: z.record(z.string().min(1), LockEntry) });
export type Lock = z.infer<typeof LockFile>;

/** The committed lock, parsed strictly: a malformed lock is refused, never read as empty. */
export const readLock = (): Lock => LockFile.parse(JSON.parse(readFileSync(resolve(REPO, LOCK_PATH), "utf8")));
/** A plan as a lock entry: what a new run's commit adds, built from today's planners. */
export function freeze(plan: string): LockEntry {
  const p = livePlan(plan);
  return { plan: p.plan, layered: p.layered, driven: [...p.driven], planned: Object.fromEntries(p.planned) };
}
/** A lock entry as the plan judgeRun reads. */
export const thawed = (e: LockEntry): ExpectedPlan =>
  ({ plan: e.plan, layered: e.layered, driven: new Set(e.driven), planned: new Map(Object.entries(e.planned)) });

/** Every committed results.json: its run directory, its cases and the plan it ran. */
export interface CommittedRun {
  readonly dir: string;
  readonly cases: readonly CaseResultV2[];
  readonly plan: string | { refused: string };
}
export function committedRuns(): CommittedRun[] {
  return trackedUnder(TRUTH_RUNS).filter((f) => f.endsWith("/results.json")).map((f) => {
    const dir = f.slice(TRUTH_RUNS.length + 1, -"/results.json".length);
    const results = parseResults(JSON.parse(readFileSync(resolve(REPO, f), "utf8")));
    return { dir, cases: results.cases, plan: planFor(dir, "plan" in results && typeof results.plan === "string" ? results.plan : undefined) };
  });
}

/** Every committed run judged against its FROZEN plan (final review I-1),
 *  counted. Today's planners are never consulted: a run the lock does not
 *  hold, or holds under another plan, is refused by name. */
export function sweepCommitted(lock: Lock = readLock(), committed: readonly CommittedRun[] = committedRuns()): { runs: number; driven: number; planned: number; wrong: string[] } {
  const wrong: string[] = [];
  let runs = 0;
  let driven = 0;
  let planned = 0;
  for (const run of committed) {
    runs++;
    if (typeof run.plan !== "string") { wrong.push(run.plan.refused); continue; }
    const frozen = lock.runs[run.dir];
    if (frozen === undefined) { wrong.push(`${run.dir}: no frozen plan in ${LOCK_PATH}`); continue; }
    if (frozen.plan !== run.plan) { wrong.push(`${run.dir}: ran "${run.plan}", frozen as "${frozen.plan}"`); continue; }
    const r = judgeRun(run.cases, thawed(frozen));
    wrong.push(...r.wrong.map((w) => `${run.dir}: ${w}`));
    driven += r.driven;
    planned += r.planned;
  }
  return { runs, driven, planned, wrong };
}
