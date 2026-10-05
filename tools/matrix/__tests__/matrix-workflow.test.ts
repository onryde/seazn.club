// W1d Task 9 (rulings 60, 64, 66, 68; D1-D4, D12, D13, D23, D24): .github/workflows/matrix-truth.yml, held by TEXT (there is no
// YAML dependency at the repo root, and none is added: review I8) and, where a step's logic lives in its `run:` block, by
// RUNNING that block for real. A step's script is extracted from the workflow and run under bash with `pnpm` and `gh` replaced
// by stand-ins on the PATH — so what is proven is the YAML's own wiring (the flags it passes, the exit codes it keeps, the files
// it reads), never a copy of it kept in the test.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { WEEKLY_EVENTS, WORKFLOW } from "../ci/gh.ts";
import { slugRunId } from "../lib/run-id.ts";
import { parseResults } from "../lib/results.ts";
import { runSlice, type PlanCases } from "../run.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { deps } from "./run-deps.ts";
import { ID, baseCases, judgeOut, mergedRun } from "./summary-fixtures.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";
import { fillRunId, jobBlock, jobsOf, runIdTemplate, stepHeads, stepOf } from "./workflow-text.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const WF = readFileSync(join(WORKFLOWS, "matrix-truth.yml"), "utf8");
const JOBS = jobsOf(WF);                               // job name → that job's text
const GUARD = "Visibility guard (design §6.4; R14a)";
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { packageManager: string; scripts: Record<string, string> };

const scratch = mkdtempSync(join(tmpdir(), "w1d-wf-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.restoreAllMocks(); });
let seq = 0;
const fresh = (label: string): string => { const d = join(scratch, `${label}-${++seq}`); mkdirSync(d, { recursive: true }); return d; };

describe("matrix-truth.yml — triggers and the disabled schedule (rulings 60, 62; D2, D3)", () => {
  it("schedule + workflow_dispatch + workflow_call + its own pull_request paths, and no push", () => {
    expect(WF).toMatch(/schedule:\s*\n\s*- cron: "17 2 \* \* 6"/);
    for (const t of ["workflow_dispatch:", "workflow_call:", "pull_request:"]) expect(WF).toContain(t);
    expect(WF).not.toMatch(/^\s{2}push:/m);
    expect(WF).toMatch(/paths:\s*\n\s*- "\.github\/workflows\/matrix-truth\.yml"\s*\n\s*- "tools\/matrix\/ci\/\*\*"/);
  });

  it("the plan job is skipped on a schedule unless vars.MATRIX_WEEKLY_ENABLED is 'true', and every other job needs it", () => {
    expect(Object.keys(JOBS)).toEqual(["plan", "build", "shard", "merge"]);
    expect(JOBS.plan).toContain("if: github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true'");
    for (const [name, text] of Object.entries(JOBS)) if (name !== "plan") expect(text, name).toMatch(/needs:\s*\[?[^\n]*\bplan\b/);
  });

  it("the dispatch and call inputs are the ones the other tasks use: dispatch scope (default full) and inject_visibility (default none); call scope (required) and rows (default none)", () => {
    const dispatch = /\n {2}workflow_dispatch:\n([\s\S]*?)\n {2}workflow_call:/.exec(WF)?.[1];
    const call = /\n {2}workflow_call:\n([\s\S]*?)\n {2}pull_request:/.exec(WF)?.[1];
    expect(dispatch, "the dispatch block").toBeDefined();
    expect(call, "the call block").toBeDefined();
    expect(dispatch).toMatch(/inject_visibility:[\s\S]*options: \[none, private, internal\][\s\S]*default: none/);
    expect(dispatch).toMatch(/scope:[\s\S]*default: full/);
    expect(call).toMatch(/scope:\s*\n\s*type: string\s*\n\s*required: true/);
    expect(call).toMatch(/rows:\s*\n\s*type: string\s*\n\s*default: none/);
  });
});

describe("what counts as the weekly run (D1, ruling 60; T8->T9)", () => {
  it("gh.ts's WORKFLOW is this very file's name, and the file is there (a rename of either reds here, not in a staleness check that reads no run)", () => {
    expect(WORKFLOW).toBe("matrix-truth.yml");
    expect(existsSync(join(WORKFLOWS, WORKFLOW))).toBe(true);
    expect(readdirSync(WORKFLOWS)).toContain(WORKFLOW);
  });

  it("WEEKLY_EVENTS are exactly the two triggers a weekly or dispatched run comes from, and both are declared by the workflow", () => {
    expect([...WEEKLY_EVENTS].sort()).toEqual(["schedule", "workflow_dispatch"]);
    const on = /^on:\n([\s\S]*?)\n\S/m.exec(WF)?.[1] ?? "";
    for (const e of WEEKLY_EVENTS) expect(on, e).toMatch(new RegExp(`^ {2}${e}:`, "m"));
  });

  it("a workflow_dispatch can only run the FULL scope: a smoke dispatch would finish green and read as the weekly run, so smoke is reached only by pull_request", () => {
    const dispatch = /\n {2}workflow_dispatch:\n([\s\S]*?)\n {2}workflow_call:/.exec(WF)![1]!;
    const options = /scope:[\s\S]*?options: \[([^\]]*)\]/.exec(dispatch)?.[1]?.split(",").map((o) => o.trim());
    expect(options, "the dispatch scope input lists its options").toBeDefined();
    expect(options).toEqual(["full"]);
    // …and the one place the smoke scope is chosen is the pull_request event, in the workflow-level SCOPE.
    expect(WF).toContain("SCOPE: ${{ inputs.scope || (github.event_name == 'pull_request' && 'smoke') || 'full' }}");
    expect((WF.match(/'smoke'/g) ?? []).length).toBe(1);
  });

  it("the workflow goes RED on a run that is not COMPLETE, so 'the previous successful run' is a complete one: the merge script exits non-zero on any merge, judge or summary failure, and its summary step asks for --require-complete (run below)", () => {
    const script = stepOf(JOBS.merge, "Merge each layer and judge its faults").script!;
    expect(script).toMatch(/exit "\$status"\s*$/);
    expect(script).toMatch(/set \+e/);
    expect(script).toContain("matrix:summary --merged merged \"${judges[@]}\" --previous-run auto --require-complete --out merged/SUMMARY.md");
    expect(JOBS.merge).not.toMatch(/continue-on-error/);
  });
});

describe("the visibility guard (Review Focus 2)", () => {
  it("is the first step of every job, with one identical script", () => {
    const scripts = Object.values(JOBS).map((t) => {
      expect(stepHeads(t)[0]).toBe(`      - name: ${GUARD}`);
      return stepOf(t, GUARD).script;
    });
    expect(scripts).toHaveLength(4);   // matrix-truth.yml's four jobs; Task 15 adds mutation.yml's, held equal to them
    expect(scripts.every((x) => x !== null)).toBe(true);
    expect(new Set(scripts).size).toBe(1);
  });

  const run = (env: Record<string, string>, gh: "public" | "private" | "fail") => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    try {
      writeFileSync(join(dir, "gh"), gh === "fail" ? "#!/bin/sh\necho 'HTTP 403' >&2\nexit 1\n" : `#!/bin/sh\necho ${gh}\n`, { mode: 0o755 });
      return spawnSync("bash", ["-c", stepOf(JOBS.plan, GUARD).script!], { env: { PATH: `${dir}:${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "onryde/seazn.club", ...env }, encoding: "utf8" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const cases: { name: string; env: Record<string, string>; gh: "public" | "private" | "fail"; want: number }[] = [
    { name: "public, hosted", env: { RUNNER_ENV: "github-hosted", INJECT: "none" }, gh: "public", want: 0 },
    { name: "public, self-hosted (ruling 68)", env: { RUNNER_ENV: "self-hosted", INJECT: "none" }, gh: "public", want: 0 },
    { name: "private, hosted", env: { RUNNER_ENV: "github-hosted", INJECT: "none" }, gh: "private", want: 1 },
    { name: "unreadable (403), hosted", env: { RUNNER_ENV: "github-hosted", INJECT: "none" }, gh: "fail", want: 1 },
    { name: "public but injected private (the live mutation)", env: { RUNNER_ENV: "github-hosted", INJECT: "private" }, gh: "public", want: 1 },
    { name: "public but injected internal", env: { RUNNER_ENV: "github-hosted", INJECT: "internal" }, gh: "public", want: 1 },
    { name: "private but injected public (cannot loosen)", env: { RUNNER_ENV: "github-hosted", INJECT: "public" }, gh: "private", want: 1 },
    { name: "runner.environment unset", env: { RUNNER_ENV: "", INJECT: "none" }, gh: "public", want: 1 },
    { name: "private, self-hosted (no hosted minutes; ruling 68)", env: { RUNNER_ENV: "self-hosted", INJECT: "none" }, gh: "private", want: 0 },
  ];
  // review m3: the title names the expected exit from the row itself ($want), never the row index.
  it.each(cases)("$name → exit $want", ({ env, gh, want }) => expect(run(env, gh).status).toBe(want));

  it("the guard has the nine cases it was written with, so a row dropped from the table reds here", () => {
    expect(cases).toHaveLength(9);
  });

  it("the four visibility × runner combinations of ruling 68 are all present and give the ruled exits", () => {
    const at = (r: string, g: string) => cases.find((c) => c.env.RUNNER_ENV === r && c.gh === g && c.env.INJECT === "none")!;
    expect([at("github-hosted", "public").want, at("self-hosted", "public").want, at("github-hosted", "private").want, at("self-hosted", "private").want]).toEqual([0, 0, 1, 0]);
  });

  it("every job of matrix-truth.yml runs on the switchable runner (ruling 68, D24), and has a timeout-minutes (mutation.yml's jobs join this check in Task 15)", () => {
    const jobs = Object.entries(JOBS);
    expect(jobs.length).toBeGreaterThan(1);   // anti-vacuity
    for (const [name, t] of jobs) {
      expect(t, `${name} runs-on`).toContain("runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}");
      expect(t, `${name} timeout-minutes`).toMatch(/timeout-minutes:/);
    }
    expect(WF).not.toMatch(/runs-on: ubuntu-latest/);
  });

  it("the guard fails closed: unreadable, 403, private, internal, injected public, unset runner — counted", () => {
    expect(cases.filter((c) => c.want === 1)).toHaveLength(6);
  });

  it("never prints the token", () => {
    const token = `${"gh"}s_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const r = run({ RUNNER_ENV: "github-hosted", INJECT: "none", GH_TOKEN: token }, "private");
    expect(r.status).toBe(1);   // anti-vacuity: the guard really ran to its refusal
    expect(r.stdout + r.stderr).not.toContain(token);
    expect(r.stdout + r.stderr).not.toContain("ghs_");
  });
});

describe("the build and shard jobs carry what bench.yml needed to build and serve (review I13)", () => {
  const bench = readFileSync(join(WORKFLOWS, "bench.yml"), "utf8");
  const envKeys = (block: string) => [...block.matchAll(/^ {6,10}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
  const benchJob = Object.values(jobsOf(bench))[0]!;
  const benchJobEnv = envKeys(jobBlock(benchJob.split("\n"), "env"));
  const benchServerEnv = envKeys(stepOf(benchJob, "Start server").body);
  it("every env key bench.yml sets at job level is set on the shard job AND the build job (NEXT_PUBLIC_* is baked at build)", () => {
    expect(benchJobEnv.length).toBeGreaterThan(8);
    expect(benchJobEnv).toEqual(expect.arrayContaining(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "DATABASE_SSL"]));
    const shardEnv = envKeys(jobBlock(JOBS.shard!.split("\n"), "env"));
    const buildEnv = envKeys(jobBlock(JOBS.build!.split("\n"), "env"));
    for (const k of benchJobEnv) expect(shardEnv, k).toContain(k);
    for (const k of benchJobEnv) expect(buildEnv, k).toContain(k);
  });
  // Ruling 66: the matrix drives no solver route, so the server step omits these two keys, by name.
  const OMITTED_BY_RULING_66 = ["PLACEMENT_SERVICE_HOST", "PLACEMENT_SERVICE_SECRET"];
  it("every env key bench.yml's server step sets is set on the shard job's server step, except the two ruling-66 omissions, and none twice (review m11)", () => {
    expect(benchServerEnv.length).toBeGreaterThan(3);
    expect(benchServerEnv).toEqual(expect.arrayContaining(OMITTED_BY_RULING_66));   // the exclusion names keys bench really sets; a rename reds here
    const server = envKeys(stepOf(JOBS.shard!, "Start the server").body);
    const shardEnv = envKeys(jobBlock(JOBS.shard!.split("\n"), "env"));
    for (const k of benchServerEnv.filter((x) => !OMITTED_BY_RULING_66.includes(x))) expect(server, k).toContain(k);
    for (const k of server) expect(shardEnv, `${k} set at job AND step level`).not.toContain(k);
  });
  it("the shard and build jobs carry no placement service at all: the keys are ABSENT, so putting one back is a deliberate act (ruling 66)", () => {
    for (const k of OMITTED_BY_RULING_66) expect(WF, k).not.toContain(k);
    expect(WF).not.toMatch(/placement|buildx|docker (load|run|save)|build-push-action|greedy/i);
  });
  it("the job-level secrets-shaped keys are the same CI dummies bench.yml uses, and DEVICE_LINK_KEK is paired with every AUTH_SECRET (the sealing key a minted device link needs)", () => {
    const kek = /^ {6}DEVICE_LINK_KEK: ([0-9a-f]{64})$/m.exec(bench)?.[1];
    expect(kek, "bench.yml's throwaway key").toBeDefined();
    let checked = 0;
    for (const name of ["build", "shard"]) {
      const lines = jobBlock(JOBS[name]!.split("\n"), "env").split("\n");
      const at = lines.findIndex((l) => /^ {6}AUTH_SECRET:/.test(l));
      expect(at, `${name} sets AUTH_SECRET`).toBeGreaterThan(0);
      let next = at + 1;
      while (next < lines.length && /^\s*#/.test(lines[next]!)) next++;
      expect(lines[next], name).toBe(`      DEVICE_LINK_KEK: ${kek}`);
      checked++;
    }
    expect(checked).toBe(2);
    const authLine = /^ {6}AUTH_SECRET: (.+)$/m;
    expect(authLine.exec(bench)?.[1]).toBeDefined();
    for (const name of ["build", "shard"]) expect(authLine.exec(jobBlock(JOBS[name]!.split("\n"), "env"))?.[1], name).toBe(authLine.exec(bench)![1]);
  });
  it("pnpm is the version package.json declares, and node is 26, in every job that installs", () => {
    const pnpmVersion = /^pnpm@(\S+)$/.exec(pkg.packageManager)?.[1];
    expect(pnpmVersion).toBeDefined();
    let installers = 0;
    for (const [name, t] of Object.entries(JOBS)) {
      if (!t.includes("pnpm install")) continue;
      expect(t, `${name} pins pnpm`).toMatch(new RegExp(`pnpm/action-setup@v4\\n\\s+with:\\n\\s+version: ${pnpmVersion!.replace(/\./g, "\\.")}\\n`));
      expect(t, `${name} pins node`).toMatch(/node-version: 26\n/);
      expect(t, `${name}: pnpm is set up before node (cache: pnpm asks pnpm for its store)`).toSatisfy((x: string) => x.indexOf("pnpm/action-setup") < x.indexOf("actions/setup-node"));
      installers++;
    }
    expect(installers).toBe(4);
  });
});

describe("the shard job (ruling 64; D4, D12; item 19, 27)", () => {
  const shard = JOBS.shard!;
  it("runs the derived matrix, fail-fast off, with the derived timeout", () => {
    expect(shard).toContain("matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}");
    expect(shard).toContain("fail-fast: false");
    expect(shard).toContain("timeout-minutes: ${{ matrix.timeout }}");
  });
  it("a fresh Postgres per job, db:apply then sync:sports before the run, its own data dir proven", () => {
    expect(shard).toMatch(/services:\s*\n\s*postgres:\s*\n\s*image: postgres:16/);
    const heads = stepHeads(shard);
    const at = (n: string) => heads.indexOf(`      - name: ${n}`);
    expect(at("Apply migrations")).toBeGreaterThan(0);
    expect(at("Apply migrations")).toBeLessThan(at("Sync sports (sync:sports)"));
    expect(at("Sync sports (sync:sports)")).toBeLessThan(at("Run the shard"));
    expect(shard).toContain("BENCH_EXPECTED_DATA_DIR");
  });
  it("the run id is built from the matrix's lowercase id, and is already its own slug (review C1)", () => {
    const tpl = runIdTemplate(WF);
    expect(tpl).toBe("ci-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.id }}");
    // Every layer's every job of BOTH sized scopes, planned by the real CLI, and the pr-sample's one.
    let ids = 0;
    for (const scope of ["full", "smoke"]) {
      const m = JSON.parse(spawnSync(process.execPath, ["--experimental-strip-types", "tools/matrix/ci/shard-matrix.ts", "--scope", scope], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS }).stdout.replace(/^matrix=/, "")) as { include: { id: string }[] };
      for (const j of m.include) {
        const id = fillRunId(tpl, { runId: "12345678901", attempt: "2", matrixId: j.id });
        expect(slugRunId(id), `${scope}: ${id}`).toBe(id);
        ids++;
      }
      expect(m.include.length).toBe(scope === "full" ? 12 : 6);
    }
    expect(ids).toBe(18);
  }, spawnBudget(2));
  it("no Redis anywhere (D12, item 19)", () => {
    expect(WF).not.toMatch(/redis/i);
  });
  it("the run writes EXIT=$? itself, and a killed step cannot read as 0", () => {
    expect(stepOf(shard, "Run the shard").script).toMatch(/set \+e[\s\S]*pnpm matrix:l3 \$MATRIX_ARGS[\s\S]*echo "\$code" > "\$dir\/exit\.txt"/);
  });
  it("upload paths are an allow-list; no trace; no step echoes a DB URL or token (Review Focus 5)", () => {
    const up = stepOf(shard, "Upload shard results").body;
    const paths = /path: \|\n((?: {12}.+\n)+)/.exec(up + "\n")![1]!.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(paths).toEqual(["out/*/results.json", "out/*/MATRIX.md", "out/*/exit.txt", "out/*/**/*.png"]);
    expect(WF).not.toMatch(/trace\.zip|MATRIX_TRACE_ON_TIMEOUT/);
    expect(WF).not.toMatch(/echo[^\n]*\$\{?(DATABASE_URL|AUTH_SECRET|GH_TOKEN|SUPABASE_JWT)/);
  });
  it("rows from a PR body never reach a run: line as an expression (script injection)", () => {
    expect(WF).not.toMatch(/run:[^\n]*\$\{\{\s*inputs\.rows/);
    expect(WF).not.toMatch(/\$\{\{\s*github\.event\.pull_request\.body/);
    expect(stepOf(JOBS.plan!, "Derive the shard matrix (D4)").body).toContain("ROWS: ${{ inputs.rows || 'none' }}");
  });
  it("a shard uploads under shard-<layer>-<k>, always (a red shard's evidence is the point), and the upload has a name the merge's pattern reads", () => {
    const up = stepOf(shard, "Upload shard results").body;
    expect(up).toContain("name: shard-${{ matrix.layer }}-${{ matrix.k }}");
    expect(up).toContain("if: always()");
    expect(stepOf(JOBS.merge!, "Download the shard artifacts").body).toContain("pattern: shard-*");
  });
});

// --- the step scripts, run for real ----------------------------------------------------------------------------

/** A `pnpm` on the PATH that the step's script calls. Each call is appended to RECORD as one line (`<args>`, `--silent` kept);
 *  a command named in `REAL` runs the package script as package.json spells it (paths made absolute, so the cwd can be a scratch
 *  dir); every other command is a stand-in that records and, for the three the merge step reads, drops the file the real one
 *  would write. `FAIL_MATCH` / `FAIL_CODE`: a call whose arguments contain that text exits with that code (writing nothing). */
function pnpmShim(dir: string, real: readonly string[]): void {
  const realCases = real.map((name) => {
    const cmd = pkg.scripts[name];
    if (cmd === undefined) throw new Error(`package.json has no script ${name}`);
    const abs = cmd.replace(/ \.\/scripts\//g, ` ${REPO}/scripts/`).replace(/ tools\//g, ` ${REPO}/tools/`);
    return `  ${name}) exec ${abs} "$@" ;;`;
  }).join("\n");
  writeFileSync(join(dir, "pnpm"), `#!/bin/sh
echo "$*" >> "$RECORD"
if [ "$1" = "--silent" ]; then shift; fi
cmd="$1"; shift
if [ -n "$FAIL_MATCH" ]; then case "$cmd $*" in *"$FAIL_MATCH"*) echo "stand-in: $cmd failed" >&2; exit "$FAIL_CODE" ;; esac; fi
case "$cmd" in
${realCases}
  matrix:merge) out=""; prev=""; for a in "$@"; do if [ "$prev" = "--out" ]; then out="$a"; fi; prev="$a"; done; mkdir -p "$out"; if [ -n "$MERGE_FIXTURES" ]; then cp "$MERGE_FIXTURES/$(basename "$out").json" "$out/results.json"; else echo '{}' > "$out/results.json"; fi ;;
  matrix:judge) jo=""; prev=""; for a in "$@"; do if [ "$prev" = "--json-out" ]; then jo="$a"; fi; prev="$a"; done; layer="$(basename "$(dirname "$2")")"; if [ -n "$jo" ]; then if [ -n "$JUDGE_FIXTURES" ]; then if [ -f "$JUDGE_FIXTURES/$layer.json" ]; then cp "$JUDGE_FIXTURES/$layer.json" "$jo"; fi; else echo '{}' > "$jo"; fi; fi; echo "judge stand-in: clean" ;;
  matrix:summary) out=""; prev=""; for a in "$@"; do if [ "$prev" = "--out" ]; then out="$a"; fi; prev="$a"; done; mkdir -p "$(dirname "$out")"; echo "# summary stand-in" > "$out" ;;
esac
`, { mode: 0o755 });
  chmodSync(join(dir, "pnpm"), 0o755);
}

interface StepRun { status: number | null; stdout: string; stderr: string; cwd: string; record: string[]; summary: string }
function runStep(script: string, o: { real?: readonly string[]; env?: Record<string, string>; setup?: (cwd: string) => void; failMatch?: string; failCode?: number }): StepRun {
  const cwd = fresh("step");
  const bin = fresh("bin");
  pnpmShim(bin, o.real ?? []);
  const recordFile = join(cwd, "..", `${seq}.record`);
  writeFileSync(recordFile, "");
  const summaryFile = join(cwd, "..", `${seq}.summary`);
  writeFileSync(summaryFile, "");
  o.setup?.(cwd);
  const r = spawnSync("bash", ["-c", script], {
    cwd, encoding: "utf8", timeout: SPAWN_MS * 3,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, RECORD: recordFile, GITHUB_STEP_SUMMARY: summaryFile, FAIL_MATCH: o.failMatch ?? "", FAIL_CODE: String(o.failCode ?? 0), ...o.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, cwd, record: readFileSync(recordFile, "utf8").split("\n").filter(Boolean), summary: readFileSync(summaryFile, "utf8") };
}

describe("the plan job's step derives the matrix through the real CLI (D4)", () => {
  const script = stepOf(JOBS.plan!, "Derive the shard matrix (D4)").script!;
  it.each([
    ["full", "none", 12, "L1:8,L2:2,L3:2"],
    ["smoke", "none", 6, "L1:2,L2:2,L3:2"],
    ["pr-sample", "none", 1, "L3:1"],
    ["pr-sample", "league,swiss", 1, "L3:1"],
  ])("SCOPE=%s ROWS=%s appends one `matrix=<json>` line with %i jobs (%s) to $GITHUB_OUTPUT", (scope, rows, jobs, perLayer) => {
    const out = join(fresh("out"), "github-output");
    writeFileSync(out, "");
    const r = runStep(script, { real: ["matrix:shards"], env: { SCOPE: scope, ROWS: rows, GITHUB_OUTPUT: out } });
    expect(r.status, r.stderr).toBe(0);
    const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);                  // nothing else goes to $GITHUB_OUTPUT: pnpm's banner is silenced
    expect(lines[0]).toMatch(/^matrix=\{"include":\[/);
    const include = (JSON.parse(lines[0]!.slice("matrix=".length)) as { include: { layer: string }[] }).include;
    expect(include).toHaveLength(jobs);
    const counts = ["L1", "L2", "L3"].flatMap((l) => (include.some((j) => j.layer === l) ? [`${l}:${include.filter((j) => j.layer === l).length}`] : []));
    expect(counts.join(",")).toBe(perLayer);
  }, spawnBudget(1));

  it("a scope the CLI refuses fails the step (the matrix is never empty-and-green)", () => {
    const out = join(fresh("out"), "github-output");
    writeFileSync(out, "");
    const r = runStep(script, { real: ["matrix:shards"], env: { SCOPE: "weekly", ROWS: "none", GITHUB_OUTPUT: out } });
    expect(r.status).not.toBe(0);
    expect(readFileSync(out, "utf8")).toBe("");
  }, spawnBudget(1));
});

describe("the shard job's run step keeps the run's own exit and writes it down (D8: a killed command reads as 0 otherwise)", () => {
  const script = stepOf(JOBS.shard!, "Run the shard").script!;
  const env = (over: Record<string, string> = {}): Record<string, string> => ({ RUN_ID: "ci-5-1-l1-s1", MATRIX_ARGS: "--driver browser --layer L1 --scope grid --shard 1/8", SCOPE: "full", ...over });

  it("a layer shard: pnpm matrix:l3 with the job's args then the run id and the report dir; exit.txt holds the code", () => {
    const r = runStep(script, { env: env() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.record).toEqual(["matrix:l3 --driver browser --layer L1 --scope grid --shard 1/8 --run-id ci-5-1-l1-s1 --report-dir out"]);
    expect(readFileSync(join(r.cwd, "out/ci-5-1-l1-s1/exit.txt"), "utf8").trim()).toBe("0");
  });

  it("a failing run: the step exits with the run's code, exit.txt says so, and the dir exists for the upload (a red shard is evidence)", () => {
    let checked = 0;
    for (const code of [1, 2, 3]) {
      const r = runStep(script, { env: env(), failMatch: "matrix:l3", failCode: code });
      expect(r.status, `exit ${code}`).toBe(code);
      expect(readFileSync(join(r.cwd, "out/ci-5-1-l1-s1/exit.txt"), "utf8").trim(), `exit ${code}`).toBe(String(code));
      expect(r.stdout).toContain(`EXIT=${code}`);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the pr-sample scope runs matrix:sample instead, and passes the args through the environment, never the command line (a dash-leading --args value is refused by parseArgs)", () => {
    const r = runStep(script, { env: env({ SCOPE: "pr-sample", RUN_ID: "ci-5-1-l3-sample", MATRIX_ARGS: "--set pr-sample --rows none --workers 4" }) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.record).toEqual(["matrix:sample --run-id ci-5-1-l3-sample --report-dir out"]);
    expect(readFileSync(join(r.cwd, "out/ci-5-1-l3-sample/exit.txt"), "utf8").trim()).toBe("0");
    const failed = runStep(script, { env: env({ SCOPE: "pr-sample", RUN_ID: "ci-5-1-l3-sample", MATRIX_ARGS: "--set pr-sample --rows none" }), failMatch: "matrix:sample", failCode: 1 });
    expect(failed.status).toBe(1);   // a reproduced regression reds the job
  });
});

describe("the merge job (D5, D20; ruling 65; PF-1; T8->T9 a-c)", () => {
  const STEP = "Merge each layer and judge its faults";
  const script = stepOf(JOBS.merge!, STEP).script!;
  const LAYERS = ["L1", "L2", "L3"] as const;

  it("runs even when a shard failed, refuses on any short shard, and judges faults per layer under ruling 65", () => {
    expect(JOBS.merge).toContain("if: ${{ always() && needs.plan.result == 'success' && inputs.scope != 'pr-sample' }}");
    expect(script).toMatch(/pnpm --silent matrix:merge --run-id "ci-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-\$lc"[\s\S]*pnpm --silent matrix:judge faults [^\n]*--planned-not-run allow/);
    expect(script, "portable lower-casing: bash 3.2 has no ${var,,}").not.toContain(",,}");
    expect(stepOf(JOBS.merge!, STEP).body).toMatch(/# ruling 65/);
    expect(script).toContain("$GITHUB_STEP_SUMMARY");
  });

  it("downloads every shard artifact into shards/, then uploads the merged directory under the exact name `merged` (summary and staleness download it by that name; T8->T9 a)", () => {
    const dl = stepOf(JOBS.merge!, "Download the shard artifacts").body;
    expect(dl).toContain("pattern: shard-*");
    expect(dl).toContain("path: shards");
    const up = stepOf(JOBS.merge!, "Upload merged results").body;
    expect(up).toContain("name: merged\n");
    expect(up).toMatch(/path: merged\/\n/);
    expect(up).toContain("if: always()");
    // the name gh.ts downloads is the name this uploads
    expect(readFileSync(join(REPO, "tools/matrix/ci/gh.ts"), "utf8")).toContain('"-n", "merged"');
  });

  /** Lays out what download-artifact leaves under shards/: `shard-<layer>-<k>/<run-id>/{results.json, exit.txt}`. */
  const layout = (layers: readonly string[], per = 2) => (cwd: string): void => {
    for (const l of layers) for (let k = 1; k <= per; k++) {
      const d = join(cwd, "shards", `shard-${l}-${k}`, `ci-9-1-${l.toLowerCase()}-s${k}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "results.json"), "{}");
      writeFileSync(join(d, "exit.txt"), "0\n");
    }
  };
  const envOf = (over: Record<string, string> = {}): Record<string, string> => ({ GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1", SCOPE: "full", GH_TOKEN: "stand-in", ...over });
  const calls = (r: StepRun, cmd: string): string[] => r.record.filter((l) => l.replace(/^--silent /, "").startsWith(`${cmd} `)).map((l) => l.replace(/^--silent /, ""));

  it("all three layers present: merge, judge faults (allow planned ░, JSON verdict beside it) per layer, then ONE summary with a --judge per layer; exit 0 and the page lands in the job summary", () => {
    const r = runStep(script, { env: envOf(), setup: layout(LAYERS) });
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
    const merges = calls(r, "matrix:merge");
    expect(merges).toHaveLength(3);
    LAYERS.forEach((l, i) => {
      const id = `ci-9-1-${l.toLowerCase()}`;
      expect(slugRunId(id), "the merged run id is its own slug").toBe(id);
      expect(merges[i]).toBe(`matrix:merge --run-id ${id} --out merged/${l} shards/shard-${l}-1/ci-9-1-${l.toLowerCase()}-s1 shards/shard-${l}-2/ci-9-1-${l.toLowerCase()}-s2`);
    });
    const faults = calls(r, "matrix:judge");
    expect(faults).toEqual(LAYERS.map((l) => `matrix:judge faults merged/${l}/results.json --planned-not-run allow --json-out merged/${l}/judge.json`));
    for (const l of LAYERS) expect(existsSync(join(r.cwd, `merged/${l}/faults.txt`)), `${l} faults.txt`).toBe(true);
    // PF-1 / T8->T9 (b): one --judge per layer, naming the file the judge wrote, in the same order.
    const summary = calls(r, "matrix:summary");
    expect(summary).toEqual(["matrix:summary --merged merged --judge merged/L1/judge.json --judge merged/L2/judge.json --judge merged/L3/judge.json --previous-run auto --require-complete --out merged/SUMMARY.md"]);
    expect(r.summary).toContain("# summary stand-in");
  });

  it("the summary's --judge files are the very files the judge was told to write (the two arguments name one path per layer)", () => {
    const r = runStep(script, { env: envOf(), setup: layout(LAYERS) });
    const written = calls(r, "matrix:judge").map((c) => /--json-out (\S+)/.exec(c)![1]!);
    const read = [...calls(r, "matrix:summary")[0]!.matchAll(/--judge (\S+)/g)].map((m) => m[1]!);
    expect(written).toHaveLength(3);
    expect(read).toEqual(written);
    for (const p of written) expect(existsSync(join(r.cwd, p)), p).toBe(true);
  });

  it("a layer whose merge is refused fails the job, skips that layer's judge, keeps judging the others, and still writes the summary (a refusal is visible, never silent)", () => {
    const r = runStep(script, { env: envOf(), setup: layout(LAYERS), failMatch: "--out merged/L2", failCode: 2 });
    expect(r.status).toBe(1);
    expect(calls(r, "matrix:merge")).toHaveLength(3);
    expect(calls(r, "matrix:judge").map((c) => /merged\/(L\d)/.exec(c)![1])).toEqual(["L1", "L3"]);
    expect(calls(r, "matrix:summary")).toHaveLength(1);
    // L2's judge file is still named to the summary: it is absent there, which the summary reads as "judge refused", never green.
    expect(calls(r, "matrix:summary")[0]).toContain("--judge merged/L2/judge.json");
    expect(existsSync(join(r.cwd, "merged/L2/judge.json"))).toBe(false);
  });

  it("a judge that finds a fault (exit 1), refuses (2) or crashes (3) fails the job, whichever layer it is", () => {
    let checked = 0;
    for (const layer of LAYERS) for (const code of [1, 2, 3]) {
      const r = runStep(script, { env: envOf(), setup: layout(LAYERS), failMatch: `faults merged/${layer}/results.json`, failCode: code });
      expect({ layer, code, status: r.status }).toEqual({ layer, code, status: 1 });
      expect(calls(r, "matrix:summary"), `${layer}/${code}: the summary is still written`).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(9);
  });

  it("a layer with no shard directory at all is a failed run, never a quiet skip: a layer the plan promised and nothing produced (upload failure, a skipped shard job) must not read green", () => {
    const r = runStep(script, { env: envOf(), setup: layout(["L1", "L3"]) });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/L2: no shard results/);
    expect(calls(r, "matrix:merge")).toHaveLength(2);
    expect(calls(r, "matrix:summary")).toHaveLength(1);
    // and with every layer absent, the job is red, not "nothing to do"
    const none = runStep(script, { env: envOf(), setup: layout([]) });
    expect(none.status).toBe(1);
    expect(calls(none, "matrix:merge")).toEqual([]);
  });

  it("a summary that fails is a failed job too (the page is the run's one report)", () => {
    const r = runStep(script, { env: envOf(), setup: layout(LAYERS), failMatch: "matrix:summary", failCode: 3 });
    expect(r.status).toBe(1);
    // …and the failure of one call leaves the job summary file untouched rather than half written
    expect(r.summary).toBe("");
  });

  it("the shard directories the glob finds are what download-artifact lays out, and the REAL merge reads them: two real shards of one plan, laid out under three layers", async () => {
    // Real shards, from the real runner over a five-case plan (the same producer run-shard.test.ts folds through the merge).
    const rows = ["league", "knockout", "double_elim", "swiss", "americano"] as const;
    const plan: PlanCases = () => ({
      sports: ["generic"], deniesFeatures: false,
      plan: (variantFor): CaseSpec[] => rows.map((row) => ({ caseId: `${row}|generic|${variantFor("generic")}|LIFECYCLE`, row, sport: "generic", variant: variantFor("generic"), scenario: "LIFECYCLE", canary: false })),
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const made = fresh("real-shards");
    for (const k of [1, 2]) expect(await runSlice(deps({ planCases: plan }), ["--shard", `${k}/2`, "--run-id", `sh${k}`, "--report-dir", made])).toBe(0);
    vi.restoreAllMocks();
    const r = runStep(script, {
      env: envOf(), real: ["matrix:merge"],
      setup: (cwd) => {
        for (const l of LAYERS) for (const k of [1, 2]) {
          const d = join(cwd, "shards", `shard-${l}-${k}`, `ci-9-1-${l.toLowerCase()}-s${k}`);
          mkdirSync(d, { recursive: true });
          writeFileSync(join(d, "results.json"), readFileSync(join(made, `sh${k}`, "results.json")));
          writeFileSync(join(d, "exit.txt"), "0\n");
        }
      },
    });
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
    let merged = 0;
    for (const l of LAYERS) {
      const run = parseResults(JSON.parse(readFileSync(join(r.cwd, `merged/${l}/results.json`), "utf8")));
      expect(run.runId).toBe(`ci-9-1-${l.toLowerCase()}`);
      expect(run.cases.map((c) => c.caseId)).toHaveLength(5);
      expect(existsSync(join(r.cwd, `merged/${l}/MATRIX.md`)), `${l} MATRIX.md`).toBe(true);
      merged++;
    }
    expect(merged).toBe(3);
  }, spawnBudget(3));
});

// T9-HG: one workflow run never says "Harness-green yes/no"; its colour follows the page's own per-run verdict. The merge step is
// run with the REAL matrix:summary (merge and judge are stand-ins that drop prebuilt, valid files: the summary's own tests own
// what a verdict is), so what is proven here is the seam — the argv the YAML builds, read by the real CLI, deciding the exit.
describe("the merge job's colour follows the summary's per-run verdict (T9-HG)", () => {
  const script = stepOf(JOBS.merge!, "Merge each layer and judge its faults").script!;
  const LAYERS3 = ["L1", "L2", "L3"] as const;
  const HARNESS_GREEN_LINE = "Harness-green: needs 3 runs — `matrix:judge across` (PR-B Task 17)";

  /** The files download-artifact leaves (two shards per layer), the merged run each layer's merge would write, and the faults
   *  verdict each layer's judge would write — valid files from the summary's own fixtures. `judgeRuns` names the run a layer's
   *  verdict is for (default: this run's merged id); `skipJudge` is a layer whose judge writes nothing (as a crashed one does). */
  const run = (o: { judgeRuns?: Partial<Record<(typeof LAYERS3)[number], string>>; skipJudge?: (typeof LAYERS3)[number] } = {}): StepRun => {
    const merge = fresh("merge-fx");
    const judge = fresh("judge-fx");
    for (const l of LAYERS3) {
      writeFileSync(join(merge, `${l}.json`), JSON.stringify(mergedRun(l, ID(l), baseCases(l))));
      if (l !== o.skipJudge) writeFileSync(join(judge, `${l}.json`), JSON.stringify(judgeOut({ mode: "faults", layer: l, runs: [o.judgeRuns?.[l] ?? ID(l)] })));
    }
    return runStep(script, {
      real: ["matrix:summary"],
      env: { GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1", SCOPE: "full", GH_TOKEN: "stand-in", MERGE_FIXTURES: merge, JUDGE_FIXTURES: judge },
      setup: (cwd) => {
        for (const l of LAYERS3) for (let k = 1; k <= 2; k++) {
          const d = join(cwd, "shards", `shard-${l}-${k}`, `ci-9-1-${l.toLowerCase()}-s${k}`);
          mkdirSync(d, { recursive: true });
          writeFileSync(join(d, "results.json"), "{}");
          writeFileSync(join(d, "exit.txt"), "0\n");
        }
      },
    });
  };
  const judgeCalls = (r: StepRun): number => r.record.filter((l) => l.replace(/^--silent /, "").startsWith("matrix:judge ")).length;

  it("the positive: every layer merged and judged clean -> the page says Run complete: yes, the job exits 0, and the page lands in the job summary", () => {
    const r = run();
    expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
    expect(judgeCalls(r)).toBe(3);   // anti-vacuity: the judge step really ran for each layer
    expect(r.summary).toContain("**Run complete: yes**");
    expect(r.summary).toContain(HARNESS_GREEN_LINE);
    expect(r.summary).not.toMatch(/Harness-green: (yes|no|not judged)/i);
    expect(readFileSync(join(r.cwd, "merged/SUMMARY.md"), "utf8")).toBe(r.summary);
  }, spawnBudget(2));

  it("a run that is NOT complete is RED even when every step before the summary exited 0: the summary's own exit carries the verdict, and the page says why", () => {
    let checked = 0;
    const cases: [string, Parameters<typeof run>[0], RegExp][] = [
      ["a stale faults verdict for L2 (another run's id)", { judgeRuns: { L2: "ci-1-1-l2" } }, /L2: no `judge faults` verdict is bound to run ci-9-1-l2/],
      ["a judge that wrote no file for L3 (exit 0, nothing written)", { skipJudge: "L3" }, /judge refused: merged\/L3\/judge\.json/],
    ];
    for (const [what, over, why] of cases) {
      const r = run(over);
      expect(judgeCalls(r), `${what}: every judge call exited 0, so only the summary can have failed the job`).toBe(3);
      expect({ what, status: r.status }, `${r.stderr}\n${r.stdout}`).toEqual({ what, status: 1 });
      expect(r.stdout, what).toContain("summary EXIT=1");
      expect(r.summary, what).toContain("**Run complete: no**");
      expect(r.summary, what).toMatch(why);
      expect(r.summary, what).toContain(HARNESS_GREEN_LINE);
      checked++;
    }
    expect(checked).toBe(2);
  }, spawnBudget(4));
});

describe("ci.yml's per-PR sample (R27, D13)", () => {
  const ci = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
  const ciJobs = jobsOf(ci);
  it("matrix-rows declares the rows, matrix-sample calls the truth workflow with scope pr-sample when the filter matches", () => {
    expect(ciJobs["matrix-sample"]).toMatch(/needs: matrix-rows[\s\S]*if: needs\.matrix-rows\.outputs\.run == 'true'[\s\S]*uses: \.\/\.github\/workflows\/matrix-truth\.yml[\s\S]*scope: pr-sample/);
    expect(ciJobs["matrix-sample"]).toContain("rows: ${{ needs.matrix-rows.outputs.rows }}");
  });
  it("the PR body is read live through gh api (so a re-run after a body edit sees the edit), never from the event payload, never inline (review 3, R3-m1)", () => {
    const step = stepOf(ciJobs["matrix-rows"]!, "Rows the PR declares (R27)");
    expect(step.script).toMatch(/gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER" --jq '\.body \/\/ ""'/);
    expect(step.body).toMatch(/REPO: \$\{\{ github\.repository \}\}/);
    expect(ciJobs["matrix-rows"]).toMatch(/pull-requests: read/);
    expect(ci).not.toMatch(/github\.event\.pull_request\.body/);   // neither in a run: line nor in env
  });
  it("the changed-file list keeps a rename: `git diff --name-only --no-renames`, so a file moved OUT of packages/engine still names its old path (T7->T9)", () => {
    const step = stepOf(ciJobs["matrix-rows"]!, "Rows the PR declares (R27)");
    expect(step.script).toContain('git diff --name-only --no-renames "$BASE_SHA" "$HEAD_SHA"');
    expect(ciJobs["matrix-rows"]).toMatch(/fetch-depth: 0/);
  });
  it("the pr-rows call goes through the crash-exit preload, as the package script does (a bare node line reads a load crash as a verdict)", () => {
    const step = stepOf(ciJobs["matrix-rows"]!, "Rows the PR declares (R27)");
    expect(step.script).toContain("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/ci/pr-rows.ts --body-file");
  });
  it("the staleness step never fails a PR, and runs even when the rows step failed (D1b; review m6)", () => {
    const s = stepOf(ciJobs["matrix-rows"]!, "Truth-run staleness (D1b, non-blocking)");
    expect(s.keys).toContain("continue-on-error");
    expect(s.body).toContain("continue-on-error: true");
    expect(s.body).toContain("if: ${{ always() && vars.MATRIX_WEEKLY_ENABLED == 'true' }}");
    expect(s.body).toContain("run: pnpm --silent matrix:staleness --max-days 8");
  });
  it("the called workflow's own concurrency group cannot equal the caller's (a called workflow in the caller's group is cancelled by it)", () => {
    const group = /^concurrency:\n {2}group: (.+)$/m;
    const mine = group.exec(WF)?.[1];
    const theirs = group.exec(ci)?.[1];
    expect(mine, "matrix-truth.yml's group").toBeDefined();
    expect(theirs, "ci.yml's group").toBeDefined();
    expect(mine).not.toBe(theirs);
    expect(mine!.startsWith("matrix-truth-")).toBe(true);
    expect(mine).toContain("inputs.scope");   // a PR's own-trigger run and the call from ci.yml are two groups
  });
});
