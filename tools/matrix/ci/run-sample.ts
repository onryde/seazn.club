// CLI: MATRIX_ARGS="--set pr-sample --rows <csv|all|none> --workers N" pnpm run matrix:sample --run-id <id> --report-dir <dir>
// W1d Task 9 (R27, D13): the per-PR sample's driver. The logic lives here, in a tested script, never in YAML: run the L3
// sample (`run.ts --set pr-sample`), judge it against the committed baseline (`judge.ts regression`), and when it finds a
// regression re-run the WHOLE sample once under its own run id and judge again with `--rerun` — only a case red in BOTH
// counts (D13), so one flaky case does not fail a PR and a real regression does.
//
// The args ride in the environment (MATRIX_ARGS), not on the command line: util.parseArgs refuses a separate value that
// starts with `--` (`--args "--set pr-sample"`), and the shard-matrix emits the string with its dashes (review C3a).
// Exit codes, each with one meaning (the one convention, D8):
//   0  the sample ran and no regression survived the re-run;
//   1  a regression the re-run reproduced (named on stdout by the judge) — a negative signal, the PR is red;
//   2  refused or broken, nothing judged: usage; MATRIX_ARGS missing or not a pr-sample plan; a run id that is not its
//      own slug, or whose re-run id would not fit; a baseline that cannot be used; a run that exited non-zero (a sample
//      that did not finish is not a pass, whatever its code); the judge refusing (its own exit 2);
//   3  a crash — the judge's own, or an uncaught throw while this loads, through `pnpm run matrix:sample` (its preload,
//      scripts/lib/crash-exit.ts). Run it only through that script: without the preload a load crash exits 1, which
//      reads as a verdict.
// Every line printed here passes through redact(). The child run and judge print to the same stdout/stderr and redact
// their own.
//
// MATRIX_RUN_BIN / MATRIX_JUDGE_BIN swap the two child scripts (default: this harness's run.ts and judge.ts). They are
// the process-boundary seam run-sample.test.ts stands its fake run and judge in at — CI never sets them.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainModule } from "../../../scripts/lib/main-module.ts";
import { PR_SAMPLE_SET, UnknownRow, baselineL3Path, parseRows, planPrSample } from "../lib/pr-sample.ts";
import { redact } from "../lib/redact.ts";
import { RUN_ID_MAX, slugRunId } from "../lib/run-id.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_RUN_BIN = resolve(REPO, "tools/matrix/run.ts");
export const DEFAULT_JUDGE_BIN = resolve(REPO, "tools/matrix/judge.ts");
const PRELOAD = resolve(REPO, "scripts/lib/crash-exit.ts");
const NODE_FLAGS = ["--experimental-strip-types", "--import", PRELOAD];

const USAGE = "usage: MATRIX_ARGS=\"--set pr-sample --rows <csv|all|none> [--workers N]\" run-sample.ts --run-id <id> --report-dir <dir>";

/** What one sample needs, every effect injected: the args (already checked), the ids and paths, a run, a judge, a clock and
 *  a voice. `run` and `judge` take the child CLI's own arguments and answer its exit code. */
export interface SampleDeps {
  readonly args: readonly string[];
  readonly runId: string;
  readonly reportDir: string;
  /** The committed baseline's results.json (baselineL3Path()). */
  readonly baseline: string;
  /** The ids the sample planned, written before the run starts. */
  readonly expectFile: string;
  run(args: readonly string[]): Promise<number>;
  judge(args: readonly string[]): number;
  now(): Date;
  say(line: string): void;
}

/** The re-run's id: the first id and `-r`. */
export const rerunId = (runId: string): string => `${runId}-r`;

const resultsOf = (reportDir: string, runId: string): string => join(reportDir, runId, "results.json");

/** The judge's exit, as this CLI's: a verdict (0, 1) or a refusal (2) stays itself, and anything else — a crash (3), a
 *  signal, a code the judge never documents — is a crash, never a pass. */
const judgeExit = (code: number): number => (code === 0 || code === 1 || code === 2 ? code : 3);

/** Run the sample; judge it; on a regression run it once more and judge with --rerun. See the header for the exits. */
export async function runSample(d: SampleDeps): Promise<number> {
  /** One whole pass of the sample under `id`: its exit code, with how long it took said. */
  const pass = async (n: number, id: string): Promise<number> => {
    const t0 = d.now().getTime();
    const code = await d.run([...d.args, "--run-id", id, "--report-dir", d.reportDir]);
    const seconds = Math.round((d.now().getTime() - t0) / 1000);
    d.say(`pass ${n}: run exit ${code} in ${seconds} s`);
    if (code !== 0) d.say(`run-sample: the sample run (${id}) exited ${code}: a sample that did not finish is not a pass, so nothing is judged`);
    return code;
  };

  if ((await pass(1, d.runId)) !== 0) return 2;
  const first = ["regression", "--baseline", d.baseline, "--now", resultsOf(d.reportDir, d.runId), "--expect", d.expectFile];
  const one = d.judge(first);
  if (one !== 1) return judgeExit(one);

  d.say("run-sample: the first pass regressed; re-running the whole sample once (only a case red in both passes counts)");
  const again = rerunId(d.runId);
  if ((await pass(2, again)) !== 0) return 2;
  return judgeExit(d.judge([...first, "--rerun", resultsOf(d.reportDir, again)]));
}

// --- the real effects ----------------------------------------------------------------------------------------------

const spawnBin = (bin: string, args: readonly string[]): Promise<number> =>
  new Promise((done) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, bin, ...args], { stdio: "inherit" });
    child.on("error", () => { done(3); });
    child.on("close", (code) => { done(code ?? 3); });
  });

const spawnBinSync = (bin: string, args: readonly string[]): number =>
  spawnSync(process.execPath, [...NODE_FLAGS, bin, ...args], { stdio: "inherit" }).status ?? 3;

/** Seams `main` takes beyond the environment: the effects, so a test reaches each refusal without spawning anything. */
export interface MainOver {
  run?: SampleDeps["run"];
  judge?: SampleDeps["judge"];
  now?: SampleDeps["now"];
  say?: SampleDeps["say"];
  /** The baseline resolver (default: the real baselineL3Path()). */
  baseline?: () => string;
}

/** What MATRIX_ARGS must be: a pr-sample plan that declares its rows and owns none of the flags this driver adds. A refusal
 *  is a thrown Error whose message names the fault. Returns the tokens and the parsed rows. */
function checkArgs(raw: string | undefined): { args: string[]; rows: readonly string[] | "all" } {
  if (raw === undefined || raw.trim() === "") throw new Error("MATRIX_ARGS is unset or blank: the shard's args (e.g. `--set pr-sample --rows none --workers 4`) ride in the environment");
  const args = raw.trim().split(/\s+/);
  for (const owned of ["--run-id", "--report-dir", "--shard"]) {
    if (args.some((a) => a === owned || a.startsWith(`${owned}=`))) {
      throw new Error(`MATRIX_ARGS carries ${owned}, which this driver owns${owned === "--shard" ? " (the sample is one job, and the judge needs the whole plan)" : ""}`);
    }
  }
  const valueOf = (flag: string): string | undefined => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
  if (valueOf("--set") !== PR_SAMPLE_SET) throw new Error(`MATRIX_ARGS is not a ${PR_SAMPLE_SET} plan: it must name \`--set ${PR_SAMPLE_SET}\` (a sample that is not ${PR_SAMPLE_SET} is no sample)`);
  const rows = valueOf("--rows");
  if (rows === undefined || rows.startsWith("--")) throw new Error(`MATRIX_ARGS declares no --rows: \`--rows <row>[,<row>...]|all|none\` is required (no declaration is not none)`);
  return { args, rows: parseRows(rows) };   // throws UnknownRow, named
}

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, over: MainOver = {}): Promise<number> {
  const say = over.say ?? ((line: string) => { process.stderr.write(`${redact(line)}\n`); });
  const refuse = (why: string): number => { say(`run-sample: ${why}`); return 2; };

  let runId: string;
  let reportDir: string;
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:sample -- <flags>`; a bare one is never a value.
    const { values } = parseArgs({ args: argv.filter((a) => a !== "--"), options: { "run-id": { type: "string" }, "report-dir": { type: "string" } }, strict: true, allowPositionals: false });
    if (values["run-id"] === undefined || values["report-dir"] === undefined) throw new Error("--run-id and --report-dir are both required");
    runId = values["run-id"];
    reportDir = values["report-dir"];
  } catch (e) {
    return refuse(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }

  let parsed: ReturnType<typeof checkArgs>;
  try { parsed = checkArgs(env.MATRIX_ARGS); } catch (e) {
    return refuse(e instanceof UnknownRow ? `${e.name}: ${e.message}` : `${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }

  // run.ts writes <report-dir>/<slugRunId(--run-id)>/ and the judge reads <report-dir>/<id>/: an id that is not its own slug
  // would be run into one directory and judged from another (review C1). The re-run id adds `-r`, and must fit too.
  const slug = slugRunId(runId);
  if (slug !== runId) return refuse(`--run-id '${runId}' is not its own slug (run.ts would write '${slug ?? "nothing: it is empty or longer than " + String(RUN_ID_MAX)}', and the judge would read another directory); pass a lowercase [a-z0-9-] id of at most ${RUN_ID_MAX} characters`);
  const again = rerunId(runId);
  if (slugRunId(again) !== again) return refuse(`--run-id '${runId}' is too long to re-run: the re-run id '${again}' would exceed ${RUN_ID_MAX} characters, so a regression could not be re-run`);

  let baseline: string;
  try { baseline = (over.baseline ?? baselineL3Path)(); } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));   // BaselineUnreadable: a sample judged against nothing passes every PR
  }

  // The plan's ids, written BEFORE the run: the judge compares exactly these, and the run can be killed after it starts.
  const expectFile = join(reportDir, `${runId}.expect.json`);
  const ids = planPrSample(parsed.rows, offlineBuilderDefault).map((c) => c.caseId);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(expectFile, JSON.stringify(ids));

  const runBin = env.MATRIX_RUN_BIN ?? DEFAULT_RUN_BIN;
  const judgeBin = env.MATRIX_JUDGE_BIN ?? DEFAULT_JUDGE_BIN;
  return runSample({
    args: parsed.args, runId, reportDir, baseline, expectFile,
    run: over.run ?? ((a) => spawnBin(runBin, a)),
    judge: over.judge ?? ((a) => spawnBinSync(judgeBin, a)),
    now: over.now ?? (() => new Date()),
    say,
  });
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
