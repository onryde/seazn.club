// W1d Task 9 (R27, D13): the per-PR sample's driver. The logic lives in a tested script, not in YAML: run the sample,
// judge it against the committed baseline, and re-run the WHOLE sample once before a regression fails the PR (only a case
// red in both counts).
//
// Three layers of test, each owed to a different seam:
//   1. runSample over fake deps: the control flow (one run, one re-run at most, who returns what);
//   2. the REAL run-sample.ts through its package script, its run and judge replaced only at the process boundary
//      (MATRIX_RUN_BIN / MATRIX_JUDGE_BIN: stand-in scripts that record their argv). That is where the argv the real run.ts
//      and judge.ts would get is pinned — against the workflow's text, never against run-sample.ts's own constants (review I9);
//   3. the REAL run-sample.ts with the REAL judge and the REAL committed baseline, the run alone stood in (it needs a
//      server): the expect file, the baseline path and the judge's `--now` / `--expect` / `--rerun` meet for real.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_JUDGE_BIN, DEFAULT_RUN_BIN, main, runSample, type SampleDeps } from "../ci/run-sample.ts";
import { baselineL3Path, parseRows, planPrSample } from "../lib/pr-sample.ts";
import { RUN_ID_MAX, slugRunId } from "../lib/run-id.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";
import { fillRunId, jobsOf, runIdTemplate, stepOf } from "./workflow-text.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const WF = readFileSync(resolve(REPO, ".github/workflows/matrix-truth.yml"), "utf8");

const scratch = mkdtempSync(join(tmpdir(), "w1d-sample-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string): string => { const d = join(scratch, `${label}-${++n}`); mkdirSync(d, { recursive: true }); return d; };

// --- 1. the control flow, over fake deps ------------------------------------------------------------------------

const ARGS = ["--set", "pr-sample", "--rows", "none", "--workers", "4"];
type FakeDeps = SampleDeps & { runArgs: string[][]; judgeArgs: string[][]; said: string[]; readonly runs: number };
function fakeSampleDeps(o: { runExits?: number[]; judgeExits: number[] }): FakeDeps {
  const runArgs: string[][] = [];
  const judgeArgs: string[][] = [];
  const said: string[] = [];
  let clock = Date.parse("2026-10-05T00:00:00Z");
  const d: SampleDeps = {
    args: ARGS, runId: "ci-5-1-l3-sample", reportDir: "out", baseline: "/repo/baseline/results.json", expectFile: "out/ci-5-1-l3-sample.expect.json",
    run: (a) => { runArgs.push([...a]); return Promise.resolve(o.runExits?.[runArgs.length - 1] ?? 0); },
    judge: (a) => {
      judgeArgs.push([...a]);
      const exit = o.judgeExits[judgeArgs.length - 1];
      if (exit === undefined) throw new Error(`the judge was called ${judgeArgs.length} times; the test scripted ${o.judgeExits.length}`);
      return exit;
    },
    now: () => new Date((clock += 1000)),
    say: (line) => { said.push(line); },
  };
  // `runs` is a live getter: Object.assign would call it once and copy 0.
  return Object.defineProperty(Object.assign(d, { runArgs, judgeArgs, said }), "runs", { get: () => runArgs.length }) as FakeDeps;
}

describe("runSample: one run, and a regression is re-run once before it fails (D13)", () => {
  it("no regression: one run, judge 0, no re-run", async () => {
    const deps = fakeSampleDeps({ judgeExits: [0] });
    expect(await runSample(deps)).toBe(0);
    expect(deps.runs).toBe(1);
    expect(deps.judgeArgs).toHaveLength(1);
    expect(deps.judgeArgs[0]).not.toContain("--rerun");
  });

  it("the first run gets the sample's flags then --run-id and --report-dir; the first judge call names the baseline, this run's results and the expect file", async () => {
    const deps = fakeSampleDeps({ judgeExits: [0] });
    await runSample(deps);
    expect(deps.runArgs[0]).toEqual([...ARGS, "--run-id", "ci-5-1-l3-sample", "--report-dir", "out"]);
    expect(deps.judgeArgs[0]).toEqual(["regression", "--baseline", "/repo/baseline/results.json", "--now", "out/ci-5-1-l3-sample/results.json", "--expect", "out/ci-5-1-l3-sample.expect.json"]);
  });

  it("a regression that does not reproduce: two runs, the second judged with --rerun, exit 0", async () => {
    const deps = fakeSampleDeps({ judgeExits: [1, 0] });
    expect(await runSample(deps)).toBe(0);
    expect(deps.runs).toBe(2);
    expect(deps.judgeArgs[1]).toContain("--rerun");
    // The re-run is the WHOLE sample under its own run id (the first id + `-r`); the judge keeps the first run as --now.
    expect(deps.runArgs[1]).toEqual([...ARGS, "--run-id", "ci-5-1-l3-sample-r", "--report-dir", "out"]);
    expect(deps.judgeArgs[1]).toEqual([...deps.judgeArgs[0]!, "--rerun", "out/ci-5-1-l3-sample-r/results.json"]);
  });

  it("a reproduced regression is exit 1; the sample never re-runs twice", async () => {
    const deps = fakeSampleDeps({ judgeExits: [1, 1] });
    expect(await runSample(deps)).toBe(1);
    expect(deps.runs).toBe(2);
    expect(deps.judgeArgs).toHaveLength(2);
  });

  it("a run that exits non-zero (refused/aborted) is exit 2 with no judge call — a broken sample is not a pass, whatever the code", async () => {
    let checked = 0;
    for (const code of [1, 2, 3, 130]) {
      const deps = fakeSampleDeps({ runExits: [code], judgeExits: [] });
      expect(await runSample(deps), `run exit ${code}`).toBe(2);
      expect(deps.judgeArgs, `run exit ${code}: no judge call`).toEqual([]);
      expect(deps.said.join("\n"), `run exit ${code}`).toContain(`exited ${code}`);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a RE-RUN that exits non-zero is exit 2, not a pass for the first run's regression", async () => {
    const deps = fakeSampleDeps({ runExits: [0, 3], judgeExits: [1] });
    expect(await runSample(deps)).toBe(2);
    expect(deps.runs).toBe(2);
    expect(deps.judgeArgs).toHaveLength(1);
  });

  it("a judge that refuses (2) or crashes (3) on the first call is that exit, and never a reason to re-run: only exit 1 is a regression", async () => {
    for (const code of [2, 3]) {
      const deps = fakeSampleDeps({ judgeExits: [code] });
      expect(await runSample(deps), `judge exit ${code}`).toBe(code);
      expect(deps.runs, `judge exit ${code}: one run`).toBe(1);
    }
  });

  it("a judge that refuses on the re-run is exit 2", async () => {
    const deps = fakeSampleDeps({ judgeExits: [1, 2] });
    expect(await runSample(deps)).toBe(2);
    expect(deps.runs).toBe(2);
  });

  it("each pass says how long it took, from now(): the cost of the two passes is what shards.json's prSample.passes budgets", async () => {
    const deps = fakeSampleDeps({ judgeExits: [1, 0] });
    await runSample(deps);
    const said = deps.said.join("\n");
    expect(said).toContain("pass 1: run exit 0 in 1 s");
    expect(said).toContain("pass 2: run exit 0 in 1 s");
  });
});

// --- 2. the real run-sample.ts, its run and judge stood in at the process boundary ------------------------------

/** A stand-in for run.ts / judge.ts: it records its argv and exits as scripted — and, for the run, drops the results.json the
 *  judge would read. Plain JS: it is run by node, not under the harness's loader. */
const BIN = fresh("bin");
const STAND_IN = (who: "run" | "judge"): string => `
import { appendFileSync, readFileSync } from "node:fs";
const record = process.env.RECORD;
const seen = (readFileSync(record, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.who === "${who}").length;
appendFileSync(record, JSON.stringify({ who: "${who}", argv: process.argv.slice(2) }) + "\\n");
const exits = (process.env.${who.toUpperCase()}_EXITS ?? "0").split(",").map(Number);
process.exitCode = exits[Math.min(seen, exits.length - 1)];
`;
writeFileSync(join(BIN, "run-bin.mjs"), STAND_IN("run"));
writeFileSync(join(BIN, "judge-bin.mjs"), STAND_IN("judge"));

interface Recorded { who: "run" | "judge"; argv: string[] }
interface Sample { status: number | null; stderr: string; stdout: string; record: Recorded[]; reportDir: string }

/** The package script as package.json spells it, run for real. */
function argvOf(script: string, tail: readonly string[]): string[] {
  const words = (scripts[script] ?? "").split(" ");
  expect(words[0], `${script}: runs node`).toBe("node");
  return [...words.slice(1), ...tail];
}
const CAP = 4 * SPAWN_MS;   // the real-judge tests spawn up to four node processes inside the one CLI call

function sample(o: { env?: Record<string, string | undefined>; runId?: string; reportDir?: string; useJudge?: boolean; runBin?: string; extra?: string[] }): Sample {
  const reportDir = o.reportDir ?? join(fresh("rep"), "out");
  const recordFile = join(fresh("rec"), "record.jsonl");
  writeFileSync(recordFile, "");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", RECORD: recordFile, MATRIX_RUN_BIN: o.runBin ?? join(BIN, "run-bin.mjs"), ...(o.useJudge === true ? {} : { MATRIX_JUDGE_BIN: join(BIN, "judge-bin.mjs") }) };
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v !== undefined) env[k] = v; }
  const r = spawnSync(process.execPath, argvOf("matrix:sample", ["--run-id", o.runId ?? "ci-5-1-l3-sample", "--report-dir", reportDir, ...(o.extra ?? [])]), { cwd: REPO, encoding: "utf8", timeout: CAP, env });
  const record = readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Recorded);
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, record, reportDir };
}
const runs = (s: Sample): string[][] => s.record.filter((r) => r.who === "run").map((r) => r.argv);
const judges = (s: Sample): string[][] => s.record.filter((r) => r.who === "judge").map((r) => r.argv);
const flag = (argv: readonly string[], name: string): string | undefined => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };

describe("run-sample.ts, the real CLI, with run.ts and judge.ts stood in at the process boundary", () => {
  it("a dash-leading MATRIX_ARGS reaches run.ts intact (util.parseArgs refuses a separate value that starts with --, so the args ride in the env)", () => {
    const s = sample({ env: { MATRIX_ARGS: "--set pr-sample --rows none --workers 4" } });
    expect(s.status, s.stderr).toBe(0);
    expect(runs(s)).toHaveLength(1);
    // the six tokens MATRIX_ARGS holds, then the two flags the workflow passes
    expect(runs(s)[0]!.slice(0, 6)).toEqual(["--set", "pr-sample", "--rows", "none", "--workers", "4"]);
    expect(runs(s)[0]!.slice(6)).toEqual(["--run-id", "ci-5-1-l3-sample", "--report-dir", s.reportDir]);
  }, spawnBudget(1, CAP));

  it("the run id the workflow builds is the id run.ts is given and the dir the judge reads (both expected values come from the workflow's text)", () => {
    const shards = spawnSync(process.execPath, argvOf("matrix:shards", ["--scope", "pr-sample", "--rows", "none"]), { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
    expect(shards.status, shards.stderr).toBe(0);
    const matrix = JSON.parse(shards.stdout.replace(/^matrix=/, "")) as { include: { id: string; args: string }[] };
    expect(matrix.include).toHaveLength(1);
    const job = matrix.include[0]!;
    // The workflow's own RUN_ID template, with the id shard-matrix.ts really emits for the sample.
    const id = fillRunId(runIdTemplate(WF), { runId: "12345678901", attempt: "2", matrixId: job.id });
    // …and the report dir the workflow passes, which the artifact upload must also read from.
    const call = /pnpm matrix:sample --run-id "\$RUN_ID" --report-dir (\S+)/.exec(stepOf(jobsOf(WF).shard!, "Run the shard").script!);
    expect(call, "the shard step calls pnpm matrix:sample --run-id \"$RUN_ID\" --report-dir <dir>").not.toBeNull();
    const workflowDir = call![1]!;
    expect(workflowDir).toBe("out");
    expect(stepOf(jobsOf(WF).shard!, "Upload shard results").body).toContain(`${workflowDir}/*/results.json`);
    // The CLI runs from the repo root (its package script's paths are relative to it), so the report dir it is given here is
    // a scratch one: the workflow's `out` is pinned above by its text, and everything else below is the dir-relative layout.
    const reportDir = join(fresh("wf"), workflowDir);
    const s = sample({ env: { MATRIX_ARGS: job.args, JUDGE_EXITS: "0" }, runId: id, reportDir });
    expect(s.status, s.stderr).toBe(0);
    expect(flag(runs(s)[0]!, "--run-id")).toBe(id);
    expect(flag(runs(s)[0]!, "--report-dir")).toBe(reportDir);
    expect(runs(s)[0]!.slice(0, -4).join(" ")).toBe(job.args);   // the whole of matrix.args, nothing added, nothing dropped
    expect(flag(judges(s)[0]!, "--now")).toBe(`${reportDir}/${id}/results.json`);
    expect(slugRunId(id)).toBe(id);
  }, spawnBudget(2, CAP));

  it("the re-run id is the first id plus -r, it is its own slug, and it fits RUN_ID_MAX", () => {
    const s = sample({ env: { MATRIX_ARGS: ARGS.join(" "), JUDGE_EXITS: "1,0" } });
    expect(s.status, s.stderr).toBe(0);
    expect(runs(s)).toHaveLength(2);
    const second = flag(runs(s)[1]!, "--run-id")!;
    expect(second).toBe(`${flag(runs(s)[0]!, "--run-id")!}-r`);
    expect(slugRunId(second)).toBe(second);
    expect(second.length).toBeLessThanOrEqual(RUN_ID_MAX);
    expect(flag(judges(s)[1]!, "--rerun")).toBe(join(s.reportDir, second, "results.json"));
  }, spawnBudget(1, CAP));

  it("an id so long that its re-run id would exceed RUN_ID_MAX is refused up front (exit 2, nothing runs); one character shorter runs", () => {
    const longest = "a".repeat(RUN_ID_MAX - 2);   // the re-run id adds `-r`: this one lands exactly on RUN_ID_MAX
    const fits = sample({ env: { MATRIX_ARGS: ARGS.join(" "), JUDGE_EXITS: "1,0" }, runId: longest });
    expect(fits.status, fits.stderr).toBe(0);
    expect(runs(fits)).toHaveLength(2);
    const tooLong = sample({ env: { MATRIX_ARGS: ARGS.join(" ") }, runId: "a".repeat(RUN_ID_MAX - 1) });
    expect(tooLong.status).toBe(2);
    expect(tooLong.record).toEqual([]);
    expect(tooLong.stderr).toMatch(/re-run/);
  }, spawnBudget(2, CAP));

  it("an upper-case --run-id is refused with exit 2 before anything runs (run.ts would write the slug's directory, and the judge would read another)", () => {
    const s = sample({ env: { MATRIX_ARGS: ARGS.join(" ") }, runId: "CI-5-1-L3-SAMPLE" });
    expect(s.status).toBe(2);
    expect(s.record).toEqual([]);
    expect(s.stderr).toMatch(/slug/);
    expect(s.stderr).toContain("ci-5-1-l3-sample");   // it says what run.ts would have written
  }, spawnBudget(1, CAP));

  it("the expect file holds planPrSample's ids for the rows in MATRIX_ARGS — and it is there before the run starts", () => {
    let checked = 0;
    for (const rows of ["none", "league,swiss", "all"]) {
      const s = sample({ env: { MATRIX_ARGS: `--set pr-sample --rows ${rows} --workers 4`, JUDGE_EXITS: "0" } });
      expect(s.status, s.stderr).toBe(0);
      const file = flag(judges(s)[0]!, "--expect")!;
      expect(file).toBe(join(s.reportDir, "ci-5-1-l3-sample.expect.json"));
      const ids = JSON.parse(readFileSync(file, "utf8")) as string[];
      expect(ids).toEqual(planPrSample(parseRows(rows), offlineBuilderDefault).map((c) => c.caseId));
      expect(new Set(ids).size, "no id twice").toBe(ids.length);
      checked++;
      if (rows === "none") expect(ids).toHaveLength(33);   // the fixed sample (pr-sample.test.ts pins what it holds)
      else expect(ids.length, `rows ${rows} widen the plan beyond the fixed 33`).toBeGreaterThan(33);
    }
    expect(checked).toBe(3);
  }, spawnBudget(3, CAP));

  it("the expect file is written BEFORE the sample runs (the run can be killed; the judge of a later step still needs the plan)", () => {
    const dirOf = fresh("early");
    const probe = join(dirOf, "probe-run.mjs");
    writeFileSync(probe, `import { existsSync, appendFileSync } from "node:fs";\nconst i = process.argv.indexOf("--report-dir");\nconst id = process.argv[process.argv.indexOf("--run-id") + 1];\nappendFileSync(process.env.RECORD, JSON.stringify({ who: "run", argv: [String(existsSync(process.argv[i + 1] + "/" + id + ".expect.json"))] }) + "\\n");\n`);
    const s = sample({ env: { MATRIX_ARGS: ARGS.join(" "), JUDGE_EXITS: "0" }, runBin: probe });
    expect(s.status, s.stderr).toBe(0);
    expect(runs(s)).toEqual([["true"]]);
  }, spawnBudget(1, CAP));

  it("the judge's --baseline is the committed baseline, resolved by baselineL3Path() for real (catalogue/baseline.json names it)", () => {
    const named = (JSON.parse(readFileSync(resolve(REPO, "tools/matrix/catalogue/baseline.json"), "utf8")) as { L3: string }).L3;
    const want = resolve(REPO, named);
    expect(existsSync(want), "the baseline file the catalogue names exists").toBe(true);
    const s = sample({ env: { MATRIX_ARGS: ARGS.join(" "), JUDGE_EXITS: "0" } });
    expect(s.status, s.stderr).toBe(0);
    expect(flag(judges(s)[0]!, "--baseline")).toBe(want);
    // The same seam from the other side: the function main calls is the real one, so what it returns is what the judge got.
    expect(baselineL3Path()).toBe(want);
  }, spawnBudget(1, CAP));

  it("unset run and judge bins default to the harness's own run.ts and judge.ts (the stand-ins are a test seam, not the production path)", () => {
    expect(DEFAULT_RUN_BIN).toBe(resolve(REPO, "tools/matrix/run.ts"));
    expect(DEFAULT_JUDGE_BIN).toBe(resolve(REPO, "tools/matrix/judge.ts"));
    expect(existsSync(DEFAULT_RUN_BIN) && existsSync(DEFAULT_JUDGE_BIN)).toBe(true);
  });

  it("a stand-in run that exits non-zero is exit 2, the judge is never called, and the message says so", () => {
    const s = sample({ env: { MATRIX_ARGS: ARGS.join(" "), RUN_EXITS: "3" } });
    expect(s.status).toBe(2);
    expect(judges(s)).toEqual([]);
    expect(s.stderr).toMatch(/exited 3/);
  }, spawnBudget(1, CAP));

  it("nothing a sample prints carries a token or a database URL, whatever the environment held", () => {
    const secret = `${"gh"}s_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const db = `${"postgres"}://u:${"pw123456"}@db.example.test:5432/x`;
    const s = sample({ env: { MATRIX_ARGS: ARGS.join(" "), JUDGE_EXITS: "1,1", GH_TOKEN: secret, DATABASE_URL: db } });
    expect(s.status).toBe(1);
    expect(s.stderr + s.stdout).not.toContain(secret);
    expect(s.stderr + s.stdout).not.toContain("pw123456");
  }, spawnBudget(1, CAP));
});

// --- the refusals, in-process (cheap: each is main()'s own answer, nothing spawned) --------------------------------

describe("run-sample.ts refuses by name, exit 2, before anything runs", () => {
  const quiet = () => { const said: string[] = []; return { said, say: (l: string) => { said.push(l); } }; };
  const attempt = async (env: Record<string, string | undefined>, argv: string[] = ["--run-id", "ci-5-1-l3-sample", "--report-dir", fresh("ref")], over: Parameters<typeof main>[2] = {}) => {
    const calls: string[] = [];
    const q = quiet();
    const status = await main(argv, env, { run: () => { calls.push("run"); return Promise.resolve(0); }, judge: () => { calls.push("judge"); return 0; }, say: q.say, ...over });
    return { status, calls, said: q.said.join("\n") };
  };

  // Each regex is the refusal's OWN phrase, never a word the appended usage line also holds: `--set pr-sample` and `--rows` are in
  // USAGE, so /pr-sample/ or /--rows/ would pass on the usage line while the guard under test was gone (mutation: both survived).
  const REFUSALS: readonly (readonly [string, Record<string, string | undefined>, RegExp])[] = [
    ["MATRIX_ARGS unset", {}, /MATRIX_ARGS is unset or blank/],
    ["MATRIX_ARGS empty", { MATRIX_ARGS: "" }, /MATRIX_ARGS is unset or blank/],
    ["MATRIX_ARGS blank", { MATRIX_ARGS: "   " }, /MATRIX_ARGS is unset or blank/],
    ["MATRIX_ARGS names another plan without rows (a sample that is not pr-sample is no sample)", { MATRIX_ARGS: "--set w1-driving --workers 4" }, /is not a pr-sample plan/],
    ["MATRIX_ARGS names another plan WITH rows (the rows check cannot stand in for the set check)", { MATRIX_ARGS: "--set w1-driving --rows none --workers 4" }, /is not a pr-sample plan/],
    ["MATRIX_ARGS names no --set", { MATRIX_ARGS: "--driver browser --layer L1" }, /is not a pr-sample plan/],
    ["MATRIX_ARGS declares no rows (no declaration is not none)", { MATRIX_ARGS: "--set pr-sample --workers 4" }, /declares no --rows/],
    ["MATRIX_ARGS --rows swallows the next flag as its value", { MATRIX_ARGS: "--set pr-sample --rows --workers 4" }, /declares no --rows/],
    ["MATRIX_ARGS names a row the catalogue lacks", { MATRIX_ARGS: "--set pr-sample --rows leaguee" }, /unknown row 'leaguee'/],
    ["MATRIX_ARGS carries a flag the sample owns (--run-id)", { MATRIX_ARGS: "--set pr-sample --rows none --run-id x" }, /carries --run-id, which this driver owns/],
    ["MATRIX_ARGS carries a flag the sample owns (--report-dir)", { MATRIX_ARGS: "--set pr-sample --rows none --report-dir x" }, /carries --report-dir, which this driver owns/],
    ["MATRIX_ARGS carries --shard (the sample is one job, and the judge needs the whole plan)", { MATRIX_ARGS: "--set pr-sample --rows none --shard 1/2" }, /carries --shard, which this driver owns/],
  ];
  it.each(REFUSALS)("%s", async (_what, env, why) => {
    const r = await attempt(env);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.said).toMatch(why);
  });
  it("the table holds the twelve refusals it was written with (a row dropped from it shrinks this count)", () => {
    expect(REFUSALS).toHaveLength(12);
  });

  it("a missing --run-id or --report-dir, an unknown flag, and a positional are usage errors", async () => {
    const env = { MATRIX_ARGS: ARGS.join(" ") };
    let checked = 0;
    for (const argv of [["--report-dir", "out"], ["--run-id", "ci-5-1-l3-sample"], ["--bogus"], ["--run-id", "ci-5-1-l3-sample", "--report-dir", "out", "extra"]]) {
      const r = await attempt(env, argv);
      expect({ argv, status: r.status, calls: r.calls }).toEqual({ argv, status: 2, calls: [] });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a committed baseline that cannot be used is exit 2 and nothing runs — a sample judged against nothing would pass every PR", async () => {
    const empty = fresh("nobaseline");
    // the REAL resolver, pointed at a catalogue directory that holds no baseline.json
    const r = await attempt({ MATRIX_ARGS: ARGS.join(" ") }, undefined, { baseline: () => baselineL3Path({ catalogue: empty }) });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.said).toMatch(/baseline/);
  });
});

// --- 3. the real judge, the real baseline, the real expect file -----------------------------------------------------

describe("run-sample.ts with the REAL judge against the REAL committed baseline (the run alone is stood in)", () => {
  // The stand-in run writes what a run of the sample would: the baseline's own cases, restricted to the ids the sample planned
  // (the expect file run-sample wrote), under the run id it was given — except the ids a test flips. A flipped case goes red.
  const RUN_FLIP = `
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const at = (f) => process.argv[process.argv.indexOf(f) + 1];
const id = at("--run-id"); const dir = at("--report-dir");
const rerun = id.endsWith("-r");
const expectFile = dir + "/" + (rerun ? id.slice(0, -2) : id) + ".expect.json";
const want = new Set(JSON.parse(readFileSync(expectFile, "utf8")));
const base = JSON.parse(readFileSync(process.env.BASELINE_FILE, "utf8"));
const flip = new Set(((rerun ? process.env.FLIP_RERUN : process.env.FLIP_FIRST) ?? "").split(",").filter(Boolean));
const cases = base.cases.filter((c) => want.has(c.caseId)).map((c) => (flip.has(c.caseId) ? { ...c, state: "red", reason: "flipped by the test" } : c));
mkdirSync(dir + "/" + id, { recursive: true });
writeFileSync(dir + "/" + id + "/results.json", JSON.stringify({ ...base, runId: id, cases }));
appendFileSync(process.env.RECORD, JSON.stringify({ who: "run", argv: [id, String(cases.length)] }) + "\\n");
`;
  writeFileSync(join(BIN, "run-flip.mjs"), RUN_FLIP);
  const baselineFile = baselineL3Path();
  const planned = planPrSample(parseRows("none"), offlineBuilderDefault).map((c) => c.caseId);
  // A case the baseline HOLDS (works), so flipping it is a regression — read from the baseline file, never from the judge.
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as { cases: { caseId: string; state: string }[] };
  const held = planned.filter((id) => baseline.cases.some((c) => c.caseId === id && c.state === "works"));
  const heldPair = [held[0]!, held[1]!];

  const real = (flipFirst: string[], flipRerun: string[]): Sample => sample({
    useJudge: true, runBin: join(BIN, "run-flip.mjs"),
    env: { MATRIX_ARGS: ARGS.join(" "), BASELINE_FILE: baselineFile, FLIP_FIRST: flipFirst.join(","), FLIP_RERUN: flipRerun.join(",") },
  });

  it("the sample's own ids are in the baseline, and enough of them are held to flip (anti-vacuity: a baseline that holds none proves nothing)", () => {
    expect(planned).toHaveLength(33);
    expect(planned.filter((id) => baseline.cases.some((c) => c.caseId === id))).toHaveLength(33);
    expect(held.length).toBeGreaterThanOrEqual(2);
  });

  it("states as the baseline holds them: exit 0 after ONE run (the judge compared all 33 for real)", () => {
    const s = real([], []);
    expect(s.status, s.stderr).toBe(0);
    expect(runs(s)).toEqual([[expect.stringContaining("ci-5-1-l3-sample"), "33"]]);
    expect(s.stdout).toMatch(/compared 33 cases; 0 regressions/);
  }, spawnBudget(1, CAP));

  it("a regression in the first run that the re-run clears: two runs, exit 0 — and the judge said which case, then that the re-run did not reproduce it", () => {
    const s = real([heldPair[0]!], []);
    expect(s.status, s.stderr).toBe(0);
    expect(runs(s)).toHaveLength(2);
    expect(s.stdout).toContain(heldPair[0]!);
    expect(s.stdout).toMatch(/1 regressions/);
    expect(s.stdout).toMatch(/0 regressions reproduced by the re-run/);
  }, spawnBudget(1, CAP));

  it("a regression the re-run reproduces: exit 1; a DIFFERENT case red in the re-run does not reproduce the first (only a case red in both counts)", () => {
    const both = real([heldPair[0]!], [heldPair[0]!]);
    expect(both.status, both.stderr).toBe(1);
    expect(runs(both)).toHaveLength(2);
    expect(both.stdout).toMatch(/1 regressions reproduced by the re-run/);
    expect(both.stdout).toContain(heldPair[0]!);
    const other = real([heldPair[0]!], [heldPair[1]!]);
    expect(other.status, other.stderr).toBe(0);
    expect(other.stdout).toMatch(/0 regressions reproduced by the re-run/);
  }, spawnBudget(2, CAP));
});
