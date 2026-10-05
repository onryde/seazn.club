// CLI: pnpm --silent run matrix:shards --scope full|smoke|pr-sample [--rows <csv|all|none>] [--shards-file <path>]
// W1d Task 8 (D4; class 20 — derived budgets): the CI job matrix. The workflow carries no logic it cannot test, so the
// shard counts, each job's `--shard k/N` argument string and its timeout are derived here, from ci/shards.json and from
// the plans the planners build TODAY, and the YAML only calls this.
//
// A job's timeout is setupMinutes + ceil(drivenInStripe × ceilingS × passes ÷ workers ÷ 60) + slackMinutes, where
// drivenInStripe counts the DRIVEN items i of the plan with i mod N = k-1 — the stripe run.ts takes — so the job holding
// the most driven items gets the largest budget, and a planned (🚫/░) case, which costs no time, costs no minutes. A layer's
// ceilingS is derived from committed evidence (ceilingFrom): the largest durationMs any listed run measured, rounded up
// to 10 s, times 1.5 for a CI runner. A job over maxTimeoutMinutes is refused here, at plan time, never at minute 360.
//
// N is CLAMPED to the plan's size (ruling T4-CLAMP): run.ts exits 2 on a stripe with no item AFTER its sign-in, so a job
// scheduled for one would red CI on a harmless empty shard. A plan of one item cannot be striped at all (run.ts takes
// no `--shard 1/1`, and merge-shards needs the shard header only a stripe carries), so it is refused by name.
//
// stdout is `matrix=<json>` — the one line the job appends to $GITHUB_OUTPUT — and the json holds ONLY `include`, since
// every other key of a GitHub matrix object becomes an axis. What the plan found is on stderr.
// Exit codes, each with one meaning (the one convention, D8):
//   0  planned: `matrix=<json>` is the whole of stdout;
//   2  refused, nothing on stdout: usage; an unreadable or invalid --shards-file; unreadable ceilingFrom evidence (a
//      listed directory with no results.json); a plan that is vacuous, too small to stripe, or whose job would outrun
//      maxTimeoutMinutes; a --rows the catalogue lacks (UnknownRow);
//   3  a crash while it loads, through `pnpm run matrix:shards` (its preload, scripts/lib/crash-exit.ts).
//      Run it only through that script: without the preload a load crash exits 1, which reads as a verdict.
// Every refusal is caught here: an uncaught throw would exit 1 without the preload. Printed lines pass through redact().
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isMainModule } from "../../../scripts/lib/main-module.ts";
import { drivenInPlanOrder } from "../lib/expected-plan.ts";
import { PR_SAMPLE_SET, UnknownRow, formatRows, parseRows } from "../lib/pr-sample.ts";
import { redact } from "../lib/redact.ts";
import { LAYERS, MAX_SHARDS, parseResults, type Layer } from "../lib/results.ts";
import { MAX_WORKERS } from "../lib/workers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const DEFAULT_SHARDS_FILE = join(HERE, "shards.json");
/** The committed runs a ceiling derives from (`ceilingFrom` names directories under it). */
const TRUTH_RUNS = join(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs");

const USAGE = "usage: shard-matrix.ts --scope full|smoke|pr-sample [--rows <csv|all|none>] [--shards-file <path>]";

// --- refusals --------------------------------------------------------------------------------------------------

/** Every refusal this module raises by name, so a reader (and a test) holds the whole set. */
export const SHARD_REFUSALS = [
  "ShardsFileInvalid", "ShardsArgsUnplannable", "CeilingUnreadable", "BadCeiling",
  "ShardPlanVacuous", "ShardPlanTooSmall", "ShardTimeoutTooLong", "PrSampleNeedsRows",
] as const;
export type ShardRefusalName = (typeof SHARD_REFUSALS)[number];

export class ShardRefused extends Error {
  constructor(name: ShardRefusalName, message: string) {
    super(message);
    this.name = name;
  }
}

// --- the config ------------------------------------------------------------------------------------------------

/** What a job's `args` may carry: the flags that choose a plan. `--shard` and `--workers` are added per job, `--run-id`
 *  and `--report-dir` by the workflow, so a config that names any of them is refused. Returns the plan string run.ts
 *  records for these args (`planOf`), so the plan a job runs is the plan its budget was derived from. */
export function planOfArgs(args: string): string {
  const bad = (why: string): ShardRefused => new ShardRefused("ShardsArgsUnplannable", `args ${JSON.stringify(args)}: ${why}`);
  const words = args.split(" ").filter((w) => w !== "");
  if (words.length === 0) throw bad("it names no plan");
  const got = new Map<string, string>();
  for (let i = 0; i < words.length; i += 2) {
    const flag = words[i];
    const value = words[i + 1];
    if (!["--driver", "--layer", "--scope", "--set", "--rows"].includes(flag)) throw bad(`${flag} is not a flag a job's args may carry (a plan's flags only: --shard and --workers are added per job)`);
    if (value === undefined || value.startsWith("--")) throw bad(`${flag} has no value`);
    if (got.has(flag)) throw bad(`${flag} twice`);
    got.set(flag, value);
  }
  const driver = got.get("--driver");
  if (driver !== undefined && driver !== "http" && driver !== "browser") throw bad(`--driver must be http or browser, got ${driver}`);
  const layer = got.get("--layer");
  const set = got.get("--set");
  if (layer !== undefined && set !== undefined) throw bad("--layer and --set choose a plan each; one of them");
  if (set !== undefined) {
    if (got.has("--scope")) throw bad("--scope belongs to --layer");
    if (set === PR_SAMPLE_SET) {
      const rows = got.get("--rows");
      if (rows === undefined) throw bad(`--set ${PR_SAMPLE_SET} needs --rows`);
      return `--set ${set} --rows ${formatRows(parseRows(rows))}`;
    }
    if (got.has("--rows")) throw bad(`--rows belongs to --set ${PR_SAMPLE_SET}`);
    return `--set ${set}`;
  }
  if (layer === undefined) throw bad("it names no plan (--layer or --set)");
  if (layer !== "L1" && layer !== "L2") throw bad(`--layer must be L1 or L2, got ${layer}`);
  if (got.has("--rows")) throw bad(`--rows belongs to --set ${PR_SAMPLE_SET}`);
  const scope = got.get("--scope");
  if (scope !== undefined && scope !== "grid" && scope !== "slice") throw bad(`--scope must be grid or slice, got ${scope}`);
  return `--layer ${layer}${scope === "grid" ? " --scope grid" : ""}`;
}

/** A zod check that `planOfArgs` accepts the string, carrying ITS reason into the issue (a throw inside a refine would
 *  escape safeParse). `suffix` completes a string the caller finishes (a pr-sample's rows). */
const plannableArgs = (suffix: string): z.ZodString =>
  z.string().superRefine((a, ctx) => {
    try { planOfArgs(`${a}${suffix}`); } catch (e) {
      if (e instanceof ShardRefused || e instanceof UnknownRow) { ctx.addIssue({ code: "custom", message: e.message }); return; }
      throw e;
    }
  });
const argsField = plannableArgs("");
const scopeCfg = z.strictObject({ args: argsField, shards: z.number().int().min(2).max(MAX_SHARDS), workers: z.number().int().min(1).max(MAX_WORKERS) });
/** A directory under the committed truth runs: relative, and never a step out of it. */
const ceilingDir = z.string().min(1).refine((d) => !isAbsolute(d) && !d.split("/").includes(".."), { message: "a path under truth-runs, relative, with no .." });
const layerCfg = z.strictObject({ full: scopeCfg, smoke: scopeCfg, ceilingFrom: z.array(ceilingDir).min(1) });
const ShardsConfigSchema = z.strictObject({
  note: z.string().optional(),
  setupMinutes: z.number().int().min(0),
  slackMinutes: z.number().int().min(0),
  // A hosted job's own cap is 360 minutes: a configured cap must sit under it, or it would never fire.
  maxTimeoutMinutes: z.number().int().min(1).max(359),
  layers: z.strictObject({ L1: layerCfg, L2: layerCfg, L3: layerCfg }),
  prSample: z.strictObject({
    // The caller adds `--rows <declared>`, so the check completes it with one.
    args: plannableArgs(" --rows none"),
    workers: z.number().int().min(1).max(MAX_WORKERS),
    passes: z.number().int().min(1),
  }),
});
export type ShardsConfig = z.infer<typeof ShardsConfigSchema>;

/** The config at `path`, or a ShardsFileInvalid naming what is wrong with it. */
export function loadShardsConfig(path: string = DEFAULT_SHARDS_FILE): ShardsConfig {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    throw new ShardRefused("ShardsFileInvalid", `${path} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) {
    throw new ShardRefused("ShardsFileInvalid", `${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = ShardsConfigSchema.safeParse(json);
  if (!r.success) throw new ShardRefused("ShardsFileInvalid", `${path}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

// --- ceilings --------------------------------------------------------------------------------------------------

/** One layer's per-case budget in seconds, from committed evidence: the largest durationMs any named run measured, rounded
 *  UP to 10 s, times 1.5 (ceil(ms / 10 000) × 10 × 1.5 = ceil(ms / 10 000) × 15). Every listed directory must hold a
 *  results.json: a moved directory reds the plan step, never a shard an hour in. */
export function ceilingFromRuns(dirs: readonly string[], root: string = TRUTH_RUNS): number {
  if (dirs.length === 0) throw new ShardRefused("CeilingUnreadable", "ceilingFrom names no run: a ceiling needs evidence to derive from");
  let maxMs = 0;
  for (const dir of dirs) {
    const file = join(root, dir, "results.json");
    let run;
    try { run = parseResults(JSON.parse(readFileSync(file, "utf8"))); } catch (e) {
      throw new ShardRefused("CeilingUnreadable", `ceilingFrom ${JSON.stringify(dir)}: ${dir}/results.json is missing or not a results file (${e instanceof Error ? e.name : "error"}); a ceiling derives from committed runs, so a moved directory is refused here`);
    }
    for (const c of run.cases) maxMs = Math.max(maxMs, c.durationMs);
  }
  if (maxMs <= 0) throw new ShardRefused("CeilingUnreadable", `ceilingFrom ${JSON.stringify(dirs.join(", "))}: no case with a duration above zero — a zero ceiling would plan every job at its setup alone`);
  return Math.ceil(maxMs / 10_000) * 15;
}

/** The ceilings of `layers` (all three by default), each from its own `ceilingFrom`. */
export function ceilingsFor(cfg: ShardsConfig, layers: readonly Layer[], root: string = TRUTH_RUNS): Partial<Record<Layer, number>> {
  return Object.fromEntries(layers.map((l) => [l, ceilingFromRuns(cfg.layers[l].ceilingFrom, root)]));
}
export function ceilingsOf(cfg: ShardsConfig, root: string = TRUTH_RUNS): Record<Layer, number> {
  return ceilingsFor(cfg, LAYERS, root) as Record<Layer, number>;
}

// --- the matrix ------------------------------------------------------------------------------------------------

export interface Job { layer: Layer; id: string; k: number; of: number; args: string; timeout: number }
export type Scope = "full" | "smoke" | "pr-sample";

/** setup + ceil(driven × ceilingS × passes ÷ workers ÷ 60) + slack, in minutes. */
const minutes = (cfg: ShardsConfig, driven: number, ceilingS: number, passes: number, workers: number): number =>
  cfg.setupMinutes + Math.ceil(driven * ceilingS * passes / workers / 60) + cfg.slackMinutes;

function checkPlan(layer: Layer, plan: readonly boolean[] | undefined): readonly boolean[] {
  if (plan === undefined || plan.length === 0) throw new ShardRefused("ShardPlanVacuous", `${layer}: zero planned items — a layer with nothing planned is no job, and a smaller matrix must never read as a complete one`);
  if (!plan.includes(true)) throw new ShardRefused("ShardPlanVacuous", `${layer}: zero driven items in ${plan.length} planned — a layer that drives nothing proves nothing`);
  return plan;
}
function checkCeiling(layer: Layer, ceilingS: number | undefined): number {
  if (ceilingS === undefined || !Number.isFinite(ceilingS) || ceilingS <= 0) throw new ShardRefused("BadCeiling", `${layer}: the per-case ceiling is ${String(ceilingS)}, not a positive number of seconds — a zero budget would be a vacuous one`);
  return ceilingS;
}
function checkCap(cfg: ShardsConfig, label: string, timeout: number, detail: string): void {
  if (timeout > cfg.maxTimeoutMinutes) throw new ShardRefused("ShardTimeoutTooLong", `${label}: timeout ${timeout} min exceeds maxTimeoutMinutes ${cfg.maxTimeoutMinutes} (${detail}); raise the layer's shard count in shards.json — a job that outruns its cap would be killed at minute 360`);
}

/** The jobs of `scope`, one per stripe of each layer's plan. `plans[layer][i]` is whether plan item i (in plan order, the
 *  order `stripe` partitions) is DRIVEN. `rows` is the declaration `pr-sample` plans with (already decided by pr-rows). */
export function shardMatrix(cfg: ShardsConfig, scope: Scope, plans: Partial<Record<Layer, readonly boolean[]>>, ceilingS: Partial<Record<Layer, number>>, rows?: string): { include: Job[] } {
  if (scope === "pr-sample") {
    if (rows === undefined || rows.trim() === "") throw new ShardRefused("PrSampleNeedsRows", `--scope ${PR_SAMPLE_SET} needs the rows a PR declares (--rows <row>[,<row>...] | all | none)`);
    const canonical = formatRows(parseRows(rows));
    const plan = checkPlan("L3", plans.L3);
    const c = checkCeiling("L3", ceilingS.L3);
    const { workers, passes } = cfg.prSample;
    const driven = plan.filter(Boolean).length;
    const timeout = minutes(cfg, driven, c, passes, workers);
    checkCap(cfg, "L3 pr-sample", timeout, `${driven} driven × ${c} s × ${passes} passes ÷ ${workers} workers`);
    return { include: [{ layer: "L3", id: "l3-sample", k: 1, of: 1, args: `${cfg.prSample.args} --rows ${canonical}${workers > 1 ? ` --workers ${workers}` : ""}`, timeout }] };
  }
  if (scope !== "full" && scope !== "smoke") throw new Error(`shardMatrix: unknown scope ${JSON.stringify(scope)} (full, smoke or pr-sample)`);
  const include: Job[] = [];
  for (const layer of LAYERS) {
    const plan = checkPlan(layer, plans[layer]);
    const c = checkCeiling(layer, ceilingS[layer]);
    const { args, shards, workers } = cfg.layers[layer][scope];
    // T4-CLAMP: no stripe without an item (run.ts refuses it as ShardEmpty, after its sign-in).
    const of = Math.min(shards, plan.length);
    if (of < 2) throw new ShardRefused("ShardPlanTooSmall", `${layer}: a plan of ${plan.length} item${plan.length === 1 ? "" : "s"} cannot be striped (a shard is k/N with N ≥ 2, and the merge needs the shard header only a stripe carries)`);
    const driven = new Array<number>(of).fill(0);
    plan.forEach((isDriven, i) => { if (isDriven) driven[i % of]++; });
    for (let k = 1; k <= of; k++) {
      const timeout = minutes(cfg, driven[k - 1], c, 1, workers);
      checkCap(cfg, `${layer} shard ${k}/${of}`, timeout, `${driven[k - 1]} driven × ${c} s ÷ ${workers} workers`);
      include.push({ layer, id: `${layer.toLowerCase()}-s${k}`, k, of, args: `${args}${workers > 1 ? ` --workers ${workers}` : ""} --shard ${k}/${of}`, timeout });
    }
  }
  return { include };
}

// --- the CLI ---------------------------------------------------------------------------------------------------

const write = (stream: NodeJS.WriteStream, s: string): void => { stream.write(`${redact(s)}\n`); };

/** The driven flags of the plan `args` names, in plan order, from today's planners (offline: the sport is its own variant). */
function plannedFlags(args: string): boolean[] {
  const plan = planOfArgs(args);
  try { return drivenInPlanOrder(plan); } catch (e) {
    if (e instanceof Error && /no planner/.test(e.message)) throw new ShardRefused("ShardsArgsUnplannable", `args ${JSON.stringify(args)}: no planner builds the plan "${plan}"`);
    throw e;
  }
}

export function main(argv: readonly string[]): number {
  let scope: Scope;
  let rows: string | undefined;
  let shardsFile: string | undefined;
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:shards -- <flags>`; a bare one is never a value.
    const { values } = parseArgs({ args: argv.filter((a) => a !== "--"), options: { scope: { type: "string" }, rows: { type: "string" }, "shards-file": { type: "string" } }, strict: true, allowPositionals: false });
    if (values.scope !== "full" && values.scope !== "smoke" && values.scope !== "pr-sample") throw new Error("--scope is required: full, smoke or pr-sample");
    if (values.scope === "pr-sample" && (values.rows === undefined || values.rows.trim() === "")) throw new Error("--scope pr-sample needs --rows");
    scope = values.scope;
    rows = values.rows;
    shardsFile = values["shards-file"];
  } catch (e) {
    write(process.stderr, `shard-matrix: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  try {
    const cfg = loadShardsConfig(shardsFile);
    const layers: readonly Layer[] = scope === "pr-sample" ? ["L3"] : LAYERS;
    const plans: Partial<Record<Layer, boolean[]>> = {};
    for (const l of layers) plans[l] = plannedFlags(scope === "pr-sample" ? `${cfg.prSample.args} --rows ${rows}` : cfg.layers[l][scope].args);
    const ceilings = ceilingsFor(cfg, layers);
    const { include } = shardMatrix(cfg, scope, plans, ceilings, rows);
    for (const l of layers) {
      const jobs = include.filter((j) => j.layer === l);
      const configured = scope === "pr-sample" ? 1 : cfg.layers[l][scope].shards;
      const items = plans[l]!;
      write(process.stderr, `shard-matrix: ${l} ${items.length} items, ${items.filter(Boolean).length} driven, ceiling ${ceilings[l]} s, ${jobs.length} job${jobs.length === 1 ? "" : "s"}, timeouts ${Math.min(...jobs.map((j) => j.timeout))}..${Math.max(...jobs.map((j) => j.timeout))} min`
        + (jobs[0].of < configured ? ` — clamped from ${configured} shards: the plan holds fewer items than shards` : ""));
    }
    process.stdout.write(`matrix=${JSON.stringify({ include })}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ShardRefused || e instanceof UnknownRow) {
      // The refusal's NAME is ours and is printed as it is: redact() reads `Name: <path>:` as a key/value pair.
      process.stderr.write(`shard-matrix: ${e.name}: ${redact(e.message)}\n`);
      return 2;
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
