// CLI: pnpm run matrix:judge <mode> ... [--json-out <path>]
// W1d Task 6 (ruling 61, D6, D13): the mechanical judge of a matrix run.
//   across <run.json> <run.json> [<run.json>...] [--planned-not-run allow|refuse]
//       K merged runs of ONE layer, plan and harness commit (ruling 61 asks three): harness-green
//       when no run holds a harness fault and every case has the same state in every run.
//   faults <run.json> [--planned-not-run allow|refuse]
//       one merged run's harness faults (D6) — the merge job runs it on every run.
//   regression --baseline <file> --now <file> --expect <ids.json> [--rerun <file>]
//       a sample against the committed baseline, restricted to EXACTLY the ids the sample planned
//       (--expect, written by run-sample.ts); with --rerun, only a regression the re-run reproduces counts.
//       The baseline is read as catalogue/baseline.json's ruling70 block says (owner ruling 70): the ids it lists
//       are red whatever the baseline run recorded, so a later works on them is an improvement and a later red no change.
// --planned-not-run (ruling 65) defaults to allow: a ░ the plan marked planned is not a fault; a ░ on a
// driven case always is. --json-out writes the verdict as JSON (lib/judge.ts JudgeOut) for `summary --judge`.
// Exit codes, each with one meaning:
//   0  done — a verdict was reached and it is clean: no harness fault and identical states across runs
//      (across, faults); no reproduced regression (regression);
//   1  a negative signal, the verdict written: a harness fault, a case whose state differs between runs,
//      or a regression the re-run reproduced — each named on stdout;
//   2  refused, nothing written: usage; unreadable input (a missing or unreadable file, bad JSON, results the
//      schema refuses, a v2 run); fewer than 2 runs, one run given twice, runs that differ in layer, driver,
//      plan, scope or harness commit (three runs of two products are not a flakiness measure, D21); a run whose
//      case ids are not its recorded plan's, or whose scope is not its plan's; runs of one plan that do not hold
//      the same case ids (they differ in width or variant, which a plan's ids drop): none shared is NoneCompared,
//      some shared is CaseIdsDiffer; a catalogue/baseline.json that cannot be used (BaselineUnreadable: regression);
//      zero cases compared (across, regression); an expected
//      case absent from --now, a case in --now or --rerun the sample did not plan, or a regression with no
//      case in --rerun. Each refusal prints its own name (lib/judge.ts JUDGE_REFUSALS);
//   3  a crash while it loads, through `pnpm run matrix:judge` (its preload, scripts/lib/crash-exit.ts).
//      Run it only through that script: without the preload a load crash exits 1, which reads as a verdict.
// An uncaught throw would exit 1 without the preload, so every input failure is caught here. Every line
// printed, and every string written, passes through redact().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { ZodError, z } from "zod";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { EXIT_CODES } from "./lib/exit-codes.ts";
import { HELD, JudgeOutSchema, JudgeRefused, forceBaselineStates, harnessFaults, matchPlanIds, regressions, statesAcross, type Fault, type JudgeOut, type RunLike } from "./lib/judge.ts";
import { BaselineUnreadable, baselineOverrides } from "./lib/pr-sample.ts";
import { mapStrings, redact } from "./lib/redact.ts";
import { parseResults, type AnyRunResults, type RunResults } from "./lib/results.ts";

const USAGE = [
  "usage: judge.ts across <run.json> <run.json> [<run.json>...] [--planned-not-run allow|refuse] [--json-out <path>]",
  "       judge.ts faults <run.json> [--planned-not-run allow|refuse] [--json-out <path>]",
  "       judge.ts regression --baseline <file> --now <file> --expect <ids.json> [--rerun <file>] [--json-out <path>]",
].join("\n");

/** The most list lines a mode prints (the rest are counted; --json-out has them all). */
const LIST_CAP = 50;
const REASON_CAP = 240;

type Mode = "across" | "faults" | "regression";
interface Cli {
  mode: Mode;
  files: string[];
  plannedNotRun: "allow" | "refuse";
  jsonOut: string | undefined;
  baseline: string | undefined;
  now: string | undefined;
  expect: string | undefined;
  rerun: string | undefined;
}

function parseCli(argv: readonly string[]): Cli | { usage: string } {
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:judge -- <flags>`; a bare one is never a file.
    const { positionals, values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      allowPositionals: true,
      options: { "planned-not-run": { type: "string" }, "json-out": { type: "string" }, baseline: { type: "string" }, now: { type: "string" }, expect: { type: "string" }, rerun: { type: "string" } },
    });
    const [mode, ...files] = positionals;
    if (mode !== "across" && mode !== "faults" && mode !== "regression") return { usage: USAGE };
    const pnr = values["planned-not-run"];
    if (pnr !== undefined && pnr !== "allow" && pnr !== "refuse") return { usage: `--planned-not-run takes allow or refuse, got ${JSON.stringify(pnr)}\n${USAGE}` };
    const cli: Cli = { mode, files, plannedNotRun: pnr ?? "allow", jsonOut: values["json-out"], baseline: values.baseline, now: values.now, expect: values.expect, rerun: values.rerun };
    const regressionOnly = [cli.baseline, cli.now, cli.expect, cli.rerun].some((v) => v !== undefined);
    if (mode === "regression") {
      if (files.length > 0 || pnr !== undefined || cli.baseline === undefined || cli.now === undefined || cli.expect === undefined) return { usage: USAGE };
    } else if (regressionOnly) {
      return { usage: USAGE };
    }
    if (mode === "faults" && files.length !== 1) return { usage: USAGE };
    return cli;
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

// --- reading ---------------------------------------------------------------------------------------------------

const issuesOf = (e: ZodError): string => e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** A results.json, any version, or the named reason it is unreadable (exit 2, D8). */
function readRun(path: string): AnyRunResults {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new JudgeRefused("RunUnreadable", `${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new JudgeRefused("RunUnreadable", `${path}: not JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return parseResults(json);
  } catch (e) {
    if (e instanceof ZodError) throw new JudgeRefused("RunUnreadable", `${path}: not a results.json this harness wrote — ${issuesOf(e)}`);
    throw e;
  }
}

/** A run the judge can hold to a plan: v3, which records its layer, driver and plan. */
function readV3(path: string): RunResults {
  const r = readRun(path);
  if (r.schemaVersion !== 3) throw new JudgeRefused("RunNotV3", `${path}: a v${r.schemaVersion} run records no layer, driver or plan — it cannot be judged by them`);
  return r;
}

/** The sample's `--expect` file: a JSON list of distinct, non-empty case ids. */
function readExpect(path: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new JudgeRefused("ExpectUnreadable", `${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list = z.array(z.string().min(1)).safeParse(json);
  if (!list.success) throw new JudgeRefused("ExpectUnreadable", `${path}: not a JSON list of case ids — ${issuesOf(list.error)}`);
  if (new Set(list.data).size !== list.data.length) throw new JudgeRefused("ExpectUnreadable", `${path}: a case id is listed twice`);
  if (list.data.length === 0) throw new JudgeRefused("NoCases", `${path}: the sample planned no case — nothing to judge (vacuous)`);
  return list.data;
}

// --- the modes ---------------------------------------------------------------------------------------------------

/** What a mode answers: the verdict (JudgeOut) and the lines that explain it. */
interface Verdict { out: JudgeOut; lines: string[] }

const clip = (s: string): string => (s.length > REASON_CAP ? `${s.slice(0, REASON_CAP)}…` : s);
/** At most LIST_CAP lines, then a count of the rest. */
function capped(lines: readonly string[]): string[] {
  return lines.length <= LIST_CAP ? [...lines] : [...lines.slice(0, LIST_CAP), `  … and ${lines.length - LIST_CAP} more (--json-out has every one)`];
}
const faultLine = (f: JudgeOut["faults"][number], withRun: boolean): string => `  [${f.kind}] ${withRun ? `${f.run}: ` : ""}${f.caseId} — ${clip(f.reason)}`;
const faultsOf = (run: RunResults, plannedNotRun: "allow" | "refuse"): JudgeOut["faults"] => harnessFaults(run, { plannedNotRun }).map((f: Fault) => ({ run: run.runId, ...f }));

function faultsMode(cli: Cli): Verdict {
  const run = readV3(cli.files[0]);
  const { compared } = matchPlanIds(run);
  const faults = faultsOf(run, cli.plannedNotRun);
  const out: JudgeOut = { version: 1, mode: "faults", exit: faults.length > 0 ? 1 : 0, layer: run.layer, runs: [run.runId], plannedNotRun: cli.plannedNotRun, compared, faults, differing: [], missing: [], regressed: [], absent: [] };
  return { out, lines: [`${run.layer} ${run.runId} (${run.plan}): compared ${compared} cases; ${faults.length} faults`, ...capped(faults.map((f) => faultLine(f, false)))] };
}

/** What every run of one judgement must share: three runs of two products are not a flakiness measure (D21). */
const AGREE = ["harnessCommit", "layer", "driver", "plan", "scope"] as const;

function acrossMode(cli: Cli): Verdict {
  if (cli.files.length < 2) throw new JudgeRefused("TooFewRuns", `${cli.files.length} run(s) given — states cannot be compared across fewer than 2 (ruling 61 asks for 3)`);
  const runs = cli.files.map(readV3);
  const first = runs[0];
  const ids = new Set<string>();
  for (const r of runs) {
    if (ids.has(r.runId)) throw new JudgeRefused("RunRepeated", `run ${r.runId} is given twice — a run compared with itself agrees with itself`);
    ids.add(r.runId);
    for (const k of AGREE) {
      if (JSON.stringify(r[k]) !== JSON.stringify(first[k])) throw new JudgeRefused("RunsDisagree", `${r.runId} and ${first.runId} are not runs of one product: ${k} ${JSON.stringify(r[k]) ?? "(absent)"} ≠ ${JSON.stringify(first[k]) ?? "(absent)"}`);
    }
  }
  // Each run is held to its plan's ids before anything is compared: a run that lost a case would otherwise
  // shrink the comparison to the cases it kept.
  for (const r of runs) matchPlanIds(r);
  // Each run is its plan's ids, and the runs share one plan — but matchPlanIds' key DROPS the variant, and for a plain
  // plan the width, so "every run is the plan's" does not mean "every run holds the same case ids" (review I1): three
  // @375 / @390 / @375 runs of one plan pass every check above and share no id. statesAcross compares full ids, so the
  // two refusals below are what stand between that and a verdict over nothing (or over an id some runs lack).
  const sa = statesAcross(runs);
  if (sa.compared === 0) {
    throw new JudgeRefused("NoneCompared", `the ${runs.length} runs of plan ${JSON.stringify(first.plan)} share no case id (they differ in width or variant, which a plan's ids drop; ${first.runId} holds e.g. ${first.cases[0].caseId}) — nothing compared (vacuous)`);
  }
  if (sa.missing.length > 0) {
    const some = sa.missing.slice(0, 5).map((m) => `${m.caseId} (in run${m.inRuns.length === 1 ? "" : "s"} ${m.inRuns.map((i) => i + 1).join(", ")} of ${runs.length})`).join("; ");
    throw new JudgeRefused("CaseIdsDiffer", `${sa.missing.length} case id(s) are not in every run — runs of one plan whose case ids differ (width or variant) are not one product: ${some}${sa.missing.length > 5 ? "; …" : ""}`);
  }
  // After the two refusals, `missing` is empty by construction, so it is not a term of the verdict and the file's `missing` is [].
  const faults = runs.flatMap((r) => faultsOf(r, cli.plannedNotRun));
  const bad = sa.differing.length + faults.length;
  const out: JudgeOut = { version: 1, mode: "across", exit: bad > 0 ? 1 : 0, layer: first.layer, runs: runs.map((r) => r.runId), plannedNotRun: cli.plannedNotRun, compared: sa.compared, faults, differing: sa.differing, missing: [], regressed: [], absent: [] };
  return {
    out,
    lines: [
      `${first.layer}: compared ${sa.compared} cases across ${runs.length} runs; ${sa.differing.length} differing; ${faults.length} faults`,
      ...capped(sa.differing.map((d) => `  differing ${d.caseId}: ${d.states.join(", ")}`)),
      ...capped(faults.map((f) => faultLine(f, true))),
    ],
  };
}

/** `now` (or the re-run) is the sample: every case in `expect`, and no other. `needAll` is false for the re-run,
 *  which only needs the cases that regressed (judged by the caller). */
function holdsExactly(label: string, run: RunLike, runId: string, expect: readonly string[], needAll: boolean): void {
  const want = new Set(expect);
  const have = new Set<string>();
  const repeated: string[] = [];
  for (const c of run.cases) { if (have.has(c.caseId)) repeated.push(c.caseId); have.add(c.caseId); }
  const extra = [...have].filter((id) => !want.has(id));
  if (extra.length > 0 || repeated.length > 0) {
    throw new JudgeRefused("UnexpectedCase", `${label} (${runId}) holds ${extra.length > 0 ? `${extra.length} case(s) the sample did not plan: ${extra.slice(0, 5).join(", ")}` : `a case twice: ${repeated.slice(0, 5).join(", ")}`} — a sample that planned something else cannot pass by omission`);
  }
  const absent = needAll ? expect.filter((id) => !have.has(id)) : [];
  if (absent.length > 0) throw new JudgeRefused("ExpectedAbsent", `${label} (${runId}) lacks ${absent.length} case(s) the sample planned: ${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", …" : ""}`);
}

/** Where the judge reads catalogue/baseline.json from: the harness's own, unless a test points it elsewhere. */
interface JudgeOver { catalogue?: string }

function regressionMode(cli: Cli, over: JudgeOver): Verdict {
  const read = readRun(cli.baseline as string);
  const now = readRun(cli.now as string);
  const expect = readExpect(cli.expect as string);
  holdsExactly("--now", now, now.runId, expect, true);
  // Owner ruling 70: the baseline's override list is applied HERE, in the one reader of a baseline, so matrix:sample and any other
  // caller judge the same baseline. An unreadable list is a refusal, never a judgement made without it.
  let overrides: ReturnType<typeof baselineOverrides>;
  try { overrides = baselineOverrides(over.catalogue === undefined ? {} : { catalogue: over.catalogue }); } catch (e) {
    if (e instanceof BaselineUnreadable) throw new JudgeRefused("BaselineUnreadable", e.message);
    throw e;
  }
  const { run: baseline, applied } = forceBaselineStates(read, new Map(overrides === null ? [] : overrides.ids.map((id) => [id, overrides.state] as const)));
  // The baseline's id is the run's own (forceBaselineStates keeps every field but the cases).
  const r = regressions(baseline, now, expect);
  if (r.compared === 0) throw new JudgeRefused("NoneCompared", `none of the ${expect.length} expected case(s) is in the baseline (${baseline.runId}) and --now (${now.runId}) — nothing compared (vacuous)`);
  let regressed: JudgeOut["regressed"] = r.regressed;
  if (cli.rerun !== undefined) {
    const rerun = readRun(cli.rerun);
    holdsExactly("--rerun", rerun, rerun.runId, expect, false);
    const again = new Map(rerun.cases.map((c) => [c.caseId, c.state]));
    regressed = regressed.flatMap((x) => {
      const state = again.get(x.caseId);
      if (state === undefined) throw new JudgeRefused("RerunMissing", `--rerun (${rerun.runId}) lacks ${x.caseId}, which regressed (${x.was} → ${x.now}) — it cannot confirm or clear it`);
      // Reproduced: still not held. A case that came back ✅ (or ⛔) is not reported.
      return HELD.has(state) ? [] : [{ ...x, rerun: state }];
    });
  }
  const out: JudgeOut = { version: 1, mode: "regression", exit: regressed.length > 0 ? 1 : 0, layer: now.schemaVersion === 3 ? now.layer : null, runs: [now.runId], plannedNotRun: null, compared: r.compared, faults: [], differing: [], missing: [], regressed, absent: r.absent };
  return {
    out,
    lines: [
      `${now.runId} against the baseline ${baseline.runId}: compared ${r.compared} cases; ${regressed.length} regressions${cli.rerun === undefined ? "" : " reproduced by the re-run"}`,
      ...(overrides === null || applied.length === 0 ? [] : [`baseline overrides: ${applied.length} case(s) held red (cause ${overrides.cause}, ${overrides.gap}, ${overrides.wave}) — owner ruling 70`]),
      ...capped(regressed.map((x) => `  ${x.caseId}: ${x.was} → ${x.now} — ${clip(x.reason)}${x.rerun === undefined ? "" : ` (re-run: ${x.rerun})`}`)),
    ],
  };
}

// --- main --------------------------------------------------------------------------------------------------------

export function main(argv: readonly string[], over: JudgeOver = {}): number {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`judge: ${redact(cli.usage)}\n`);
    return 2;
  }
  let verdict: Verdict;
  try {
    verdict = cli.mode === "across" ? acrossMode(cli) : cli.mode === "faults" ? faultsMode(cli) : regressionMode(cli, over);
  } catch (e) {
    if (e instanceof JudgeRefused) {
      // The refusal's NAME is ours and is printed as it is: redact() reads `Name: <path>:` as a key/value pair.
      process.stderr.write(`judge: ${e.name}: ${redact(e.message)}\n`);
      return 2;
    }
    throw e;
  }
  const { out, lines } = verdict;
  // The verdict file is the schema's own: what the consumer parses is what was validated here.
  if (cli.jsonOut !== undefined) {
    const body = JudgeOutSchema.parse(mapStrings(out, redact));
    mkdirSync(dirname(cli.jsonOut), { recursive: true });
    writeFileSync(cli.jsonOut, `${JSON.stringify(body, null, 2)}\n`);
  }
  for (const l of [...lines, `exit ${out.exit}: ${EXIT_CODES[out.exit]}`]) process.stdout.write(`${redact(l)}\n`);
  return out.exit;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
