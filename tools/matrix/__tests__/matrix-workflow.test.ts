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
import { STRYKER_FAMILIES, STRYKER_GROUPS } from "../../../packages/engine/stryker.groups.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const WF = readFileSync(join(WORKFLOWS, "matrix-truth.yml"), "utf8");
const JOBS = jobsOf(WF);                               // job name → that job's text
const GUARD = "Visibility guard (design §6.4; R14a)";
// Task 20 pre-step, carry (b): the refusal said "Matrix truth run refused ... Sharded matrix runs", which is matrix-truth.yml's
// name for itself, on a Stryker run. mutation.yml's guard is matrix-truth's script in every line but that message.
const MATRIX_TRUTH_REFUSAL = "Matrix truth run refused::repository visibility is '${vis:-unreadable}'. Sharded matrix runs are free only while the repo is public (design §6.4); refusing before any minute is spent. Set vars.MATRIX_RUNNER to a self-hosted runner label to run them privately (ruling 68).";
const STRYKER_REFUSAL = "Stryker mutation run refused::repository visibility is '${vis:-unreadable}'. The Stryker mutation workflow (mutation.yml) runs one hosted job per group, and those minutes are free only while the repo is public (design §6.4); refusing before any minute is spent. Set vars.MATRIX_RUNNER to a self-hosted runner label to run it privately (ruling 68).";

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
    expect(JOBS.plan).toContain("if: (github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true') && (");   // && the fork gate (T9-FORK), tested below
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

  /** The guard's script, run for real with a `gh` stand-in that FAILS its first `fails` calls (HTTP 403 on stderr; on stdout the
   *  raw JSON error body `body` when given, which is what gh 2.95 prints for a 404/401/403/5xx under `--jq`, else nothing) and
   *  then answers `answer`, and a `sleep` stand-in that records its argument instead of waiting (m4: the retry's backoff is
   *  observed, never slept). `calls` is how many times the guard asked, `sleeps` the backoffs it took between asks. */
  const runWith = (env: Record<string, string>, gh: { fails: number; answer: string; body?: string }, script: string = stepOf(JOBS.plan, GUARD).script!) => {
    const dir = mkdtempSync(join(tmpdir(), "gh-"));
    try {
      writeFileSync(join(dir, "gh"), `#!/bin/sh\nn=$(cat "$GH_STATE/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$GH_STATE/n"\nif [ "$n" -le "$GH_FAILS" ]; then if [ -n "$GH_BODY" ]; then echo "$GH_BODY"; fi; echo 'HTTP 403' >&2; exit 1; fi\necho "$GH_ANSWER"\n`, { mode: 0o755 });
      writeFileSync(join(dir, "sleep"), `#!/bin/sh\necho "$1" >> "$GH_STATE/sleeps"\n`, { mode: 0o755 });
      const r = spawnSync("bash", ["-c", script], { env: { PATH: `${dir}:${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "onryde/seazn.club", GH_STATE: dir, GH_FAILS: String(gh.fails), GH_ANSWER: gh.answer, GH_BODY: gh.body ?? "", ...env }, encoding: "utf8" });
      const lines = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean) : []);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: Number(lines("n")[0] ?? 0), sleeps: lines("sleeps") };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const run = (env: Record<string, string>, gh: "public" | "private" | "fail") => runWith(env, gh === "fail" ? { fails: 99, answer: "" } : { fails: 0, answer: gh });
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

  it("carry (b): a refusal on a private repository NAMES the Stryker mutation workflow, in every job, and says nothing of a matrix truth run (run for real, with a stand-in gh)", () => {
    const env = { RUNNER_ENV: "github-hosted", INJECT: "none" };
    let checked = 0;
    for (const [name, t] of Object.entries(MJOBS)) {
      const r = runWith(env, { fails: 0, answer: "private" }, stepOf(t, GUARD).script!);
      expect(r.status, `${name}: private, hosted is refused`).toBe(1);
      expect(r.stdout, name).toContain("::error title=Stryker mutation run refused::repository visibility is 'private'");
      expect(r.stdout, name).toContain("mutation.yml");
      expect(r.stdout, name).not.toMatch(/Matrix truth|Sharded matrix/);
      checked++;
    }
    expect(checked, "jobs of mutation.yml").toBe(Object.keys(MJOBS).length);
    // the positive control: matrix-truth.yml's own guard still names itself (so the assertions above can tell the two apart)
    const own = runWith(env, { fails: 0, answer: "private" });
    expect(own.status).toBe(1);
    expect(own.stdout).toContain("::error title=Matrix truth run refused::");
    expect(own.stdout).not.toContain("Stryker mutation");
    // and the public repository still passes through mutation.yml's guard (a refusal worded differently is not a refusal always)
    expect(runWith(env, { fails: 0, answer: "public" }, stepOf(MJOBS.plan!, GUARD).script!).status).toBe(0);
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

  // m4 (T9-FIX1): one blip on `gh api` must not refuse a run; but "still unreadable" stays a refusal (fail closed).
  describe("a flaky read is retried before it reads as unreadable (m4)", () => {
    const hosted = { RUNNER_ENV: "github-hosted", INJECT: "none" };
    it("fails twice, then answers public: the guard passes after exactly three asks, with a backoff between them", () => {
      const r = runWith(hosted, { fails: 2, answer: "public" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.calls).toBe(3);
      expect(r.sleeps).toEqual(["1", "2"]);   // a short, growing backoff: 1 s then 2 s
    });
    it("fails once, then answers PRIVATE: the retry never turns a real answer into a pass (two asks, still refused)", () => {
      const r = runWith(hosted, { fails: 1, answer: "private" });
      expect(r.status).toBe(1);
      expect(r.calls).toBe(2);
      expect(r.sleeps).toEqual(["1"]);
      expect(r.stdout).toContain("visibility is 'private'");
    });
    it("fails every time: exactly three asks, two backoffs, then it refuses as 'unreadable' (fails closed)", () => {
      const r = runWith(hosted, { fails: 99, answer: "public" });
      expect(r.status).toBe(1);
      expect(r.calls).toBe(3);
      expect(r.sleeps).toEqual(["1", "2"]);
      expect(r.stdout).toContain("visibility is 'unreadable'");
    });
    // Round 2: gh exits 1 on a 404/401/403/5xx but still PRINTS the JSON error body to stdout, so "non-empty" is not "answered".
    const NOT_FOUND = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}';
    it("an error BODY on stdout is not an answer: it is retried (3 asks, 2 backoffs) and refuses as 'unreadable', never echoing the body", () => {
      const r = runWith(hosted, { fails: 99, answer: "public", body: NOT_FOUND });
      expect(r.status).toBe(1);
      expect(r.calls).toBe(3);
      expect(r.sleeps).toEqual(["1", "2"]);
      expect(r.stdout).toContain("visibility is 'unreadable'");
      expect(r.stdout).not.toContain("Not Found");
      expect(r.stdout).not.toContain('{"message"');
    });
    it("two error bodies, then a real answer: passes on the third ask (a recognised answer after the blips is honoured)", () => {
      const r = runWith(hosted, { fails: 2, answer: "public", body: NOT_FOUND });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.calls).toBe(3);
      expect(r.sleeps).toEqual(["1", "2"]);
    });
    it("an exit-0 reply that is none of public|private|internal is no answer either: three asks, then 'unreadable'", () => {
      const r = runWith(hosted, { fails: 0, answer: "Not Found" });
      expect(r.status).toBe(1);
      expect(r.calls).toBe(3);
      expect(r.sleeps).toEqual(["1", "2"]);
      expect(r.stdout).toContain("visibility is 'unreadable'");
    });
    it.each(["private", "internal"])("a %s answer returns on the FIRST ask (it is an answer: no retry, no backoff) and refuses as that visibility", (answer) => {
      const r = runWith(hosted, { fails: 0, answer });
      expect(r.status).toBe(1);
      expect([r.calls, r.sleeps]).toEqual([1, []]);
      expect(r.stdout).toContain(`visibility is '${answer}'`);
    });
    it("a first answer is final: one ask, no backoff slept (a healthy API costs nothing)", () => {
      const r = runWith(hosted, { fails: 0, answer: "public" });
      expect(r.status).toBe(0);
      expect([r.calls, r.sleeps]).toEqual([1, []]);
    });
    it("a self-hosted runner never asks at all (no hosted minutes to guard)", () => {
      const r = runWith({ RUNNER_ENV: "self-hosted", INJECT: "none" }, { fails: 0, answer: "private" });
      expect([r.status, r.calls, r.sleeps]).toEqual([0, 0, []]);
    });
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
    expect(JOBS.merge).toContain("if: ${{ !cancelled() && needs.plan.result == 'success' && inputs.scope != 'pr-sample' && (");   // !cancelled(), not always() (m2); && the fork gate (T9-FORK)
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
    // THREE dots (I1, T9-FIX1): the merge-base, i.e. what the PR itself changed. Two dots diffs against the base TIP, so a PR
    // behind main lists main's own commits as its changes. The next describe drives this very step against a real repo.
    expect(step.script).toContain('git diff --name-only --no-renames "$BASE_SHA...$HEAD_SHA"');
    expect(step.script).not.toContain('"$BASE_SHA" "$HEAD_SHA"');
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

// --- fix round 1 (T9-FIX1, T9-FORK): the diff base, the fork gate, the exposure surface, re-runs ------------------

const CI = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
const CI_JOBS = jobsOf(CI);
const ROWS_STEP = "Rows the PR declares (R27)";
const SAME_REPO = "onryde/seazn.club";

/** The flags single-sport.test.ts and run-cli.test.ts spell inline (the repo has no shared git-identity helper): a fixed author,
 *  no signing, no hooks — so a scratch commit never depends on, or prompts for, the machine's own git config. */
function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Matrix Test", "-c", "user.email=matrix@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

interface Pr { dir: string; base: string; head: string }
/** A repo shaped like a PR that is BEHIND its base: A (the branch point: README.md and packages/engine/old.ts) → `pr` adds B
 *  (`change`'s work) while `main` moves on to C (packages/engine/a.ts). `base` is main's TIP (C, what github.event.pull_request.base.sha
 *  carries), `head` is B. It refuses a repo that cannot witness the defect: the two-dot diff must list main's own a.ts. */
function prBehindMain(change: (dir: string) => void): Pr {
  const dir = fresh("repo");
  gitIn(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "packages/engine"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "x\n");
  writeFileSync(join(dir, "packages/engine/old.ts"), "export const old = 1;\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "A: the branch point");
  const branchPoint = gitIn(dir, "rev-parse", "HEAD");
  gitIn(dir, "checkout", "-q", "-b", "pr");
  change(dir);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "B: the PR");
  const head = gitIn(dir, "rev-parse", "HEAD");
  gitIn(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "packages/engine/a.ts"), "export const a = 1;\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "C: main moves on");
  const base = gitIn(dir, "rev-parse", "HEAD");
  expect(gitIn(dir, "merge-base", base, head), "the fixture: the PR branched at A").toBe(branchPoint);
  expect(gitIn(dir, "diff", "--name-only", base, head).split("\n"), "the fixture can witness the defect: two dots list main's own change").toContain("packages/engine/a.ts");
  return { dir, base, head };
}

/** ci.yml's "Rows the PR declares (R27)" step, run for real in `pr.dir`: only `gh` is a stand-in (it prints `body`), and the two
 *  repo-relative paths of its node call are made absolute so the cwd can be the scratch repo. The git diff line runs as written. */
function runRowsStep(pr: Pr, body: string) {
  const script0 = stepOf(CI_JOBS["matrix-rows"]!, ROWS_STEP).script!;
  const script = script0.replace("--import ./scripts/lib/crash-exit.ts tools/matrix/ci/pr-rows.ts", `--import ${REPO}/scripts/lib/crash-exit.ts ${REPO}/tools/matrix/ci/pr-rows.ts`);
  expect(script, "the node call's paths were made absolute").not.toBe(script0);
  const bin = fresh("bin");
  const tmp = fresh("tmp");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s' "$GH_BODY"\n`, { mode: 0o755 });
  const out = join(tmp, "github-output");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", script], {
    cwd: pr.dir, encoding: "utf8", timeout: SPAWN_MS * 3,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_BODY: body, GH_TOKEN: "x", REPO: SAME_REPO, PR_NUMBER: "1", BASE_SHA: pr.base, HEAD_SHA: pr.head, RUNNER_TEMP: tmp, GITHUB_OUTPUT: out },
  });
  const changedFile = join(tmp, "changed.txt");
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, changed: existsSync(changedFile) ? readFileSync(changedFile, "utf8").split("\n").filter(Boolean) : null, out: readFileSync(out, "utf8") };
}

describe("the rows step reads what the PR changed, not what its base moved on to (I1, T9-FIX1)", () => {
  it("a web-only PR that is behind main: the change list is that one file, and main's engine commit is nobody's change", () => {
    const pr = prBehindMain((d) => { mkdirSync(join(d, "apps/web"), { recursive: true }); writeFileSync(join(d, "apps/web/page.ts"), "export const p = 1;\n"); });
    const r = runRowsStep(pr, "no rows needed here");
    expect(r.changed).toEqual(["apps/web/page.ts"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toBe("rows=none\n");
    expect(r.stderr).not.toContain("packages/engine");
  }, spawnBudget(2));

  it("an engine PR that is behind main: it names ITS file, never main's, and refuses without a declaration (the merge-base diff still sees the PR)", () => {
    const pr = prBehindMain((d) => writeFileSync(join(d, "packages/engine/b.ts"), "export const b = 1;\n"));
    const r = runRowsStep(pr, "no rows needed here");
    expect(r.changed).toEqual(["packages/engine/b.ts"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("packages/engine/b.ts");
    expect(r.stderr).not.toContain("packages/engine/a.ts");
    expect(r.out).toBe("");
    const declared = runRowsStep(pr, "Matrix rows: league");
    expect([declared.status, declared.out]).toEqual([0, "rows=league\n"]);
  }, spawnBudget(3));

  it("a file moved OUT of packages/engine in a PR behind main: both the old and the new path are listed (--no-renames survives the three-dot form)", () => {
    const pr = prBehindMain((d) => {
      mkdirSync(join(d, "apps/web"), { recursive: true });
      gitIn(d, "mv", "packages/engine/old.ts", "apps/web/moved.ts");
    });
    const r = runRowsStep(pr, "no rows needed here");
    expect(r.changed?.slice().sort()).toEqual(["apps/web/moved.ts", "packages/engine/old.ts"]);
    expect(r.status).toBe(1);   // the old engine path is named, so the PR owes a declaration
    expect(r.stderr).toContain("packages/engine/old.ts");
    expect(r.stderr).not.toContain("packages/engine/a.ts");
  }, spawnBudget(2));
});

/** `if:` expression of a job, from its own text; throws when the job has none (a gate that is not there reds, never reads as open). */
function ifOf(jobText: string): string {
  const m = /^ {4}if:\s*(\S.*)$/m.exec(jobText);
  if (m === null) throw new Error("the job has no `if:`");
  return m[1]!.trim();
}

/** A workflow `if:` evaluated against a context. It handles exactly what these workflows spell — context paths, `==`, `!=`, `&&`,
 *  `||`, `!`, string literals and the status functions — and throws on anything else, so a new construct is a red here rather than a
 *  silent misreading. A missing context path is null, as in GitHub. */
function evalIf(raw: string, ctx: Record<string, unknown>, cancelled = false): boolean {
  return Boolean(evalExpr(raw, ctx, cancelled));
}
/** The VALUE of one expression, by the same rules (`&&` and `||` return an operand, as in GitHub's expressions, which is what makes
 *  `cond && a || b` a ternary, and both short-circuit, so `plan.result == 'success' && fromJSON(plan output)` never parses an
 *  output a skipped plan did not write). The functions it knows: the status functions, `fromJSON(ref).a.*.b` (an object filter),
 *  `join` and `format`; anything else throws. */
function evalExpr(raw: string, ctx: Record<string, unknown>, cancelled = false): unknown {
  const expr = raw.trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const js = expr
    .replace(/\b(github|vars|needs|inputs)((?:\.[A-Za-z_][\w-]*)+)/g, (_m, root: string, path: string) => `ref(${JSON.stringify(root + path)})`)
    .replace(/fromJSON\((ref\("[^"]*"\))\)((?:\.[A-Za-z_*][\w-]*)+)/g, (_m, arg: string, path: string) => `fj(${arg}, ${JSON.stringify(path)})`)
    .replace(/fromJSON\((ref\("[^"]*"\))\)/g, (_m, arg: string) => `fj(${arg}, "")`);
  const bare = js.replace(/"[^"]*"|'[^']*'/g, '""');   // the whitelist is read with string contents out, so `*` and `{0}` may sit in a literal
  if (!/^[\s\w"'.()!=&|,-]*$/.test(bare) || /\b(?!always\b|cancelled\b|success\b|ref\b|fj\b|join\b|format\b)\w+\s*\(/.test(bare)) throw new Error(`evalIf: unsupported syntax in: ${expr}`);
  const ref = (path: string): unknown => {
    let at: unknown = ctx;
    for (const k of path.split(".")) { if (at === null || typeof at !== "object") return null; at = (at as Record<string, unknown>)[k] ?? null; }
    return at;
  };
  // fromJSON(text).a.b, and .a.*.b = that field of every item of `a` (what the workflow's LEGS spells)
  const fj = (text: unknown, path: string): unknown => {
    let at: unknown = JSON.parse(String(text));
    const segs = path.split(".").filter((x) => x !== "");
    for (const [i, k] of segs.entries()) {
      if (k === "*") {
        const items = Array.isArray(at) ? at : Object.values(at as object);
        return items.map((item: unknown) => segs.slice(i + 1).reduce<unknown>((a, key) => (a === null || typeof a !== "object" ? null : ((a as Record<string, unknown>)[key] ?? null)), item));
      }
      at = at === null || typeof at !== "object" ? null : ((at as Record<string, unknown>)[k] ?? null);
    }
    return at;
  };
  const join = (items: unknown, sep: string): string => (Array.isArray(items) ? items.join(sep) : String(items));
  const format = (fmt: string, ...args: unknown[]): string => fmt.replace(/\{(\d+)\}/g, (_m, n: string) => String(args[Number(n)]));
  // The expression is this repo's own committed workflow text, restricted to the token whitelist above.
  return new Function("ref", "fj", "join", "format", "always", "cancelled", "success", `return (${js});`)(ref, fj, join, format, () => true, () => cancelled, () => !cancelled);
}
const ctxOf = (o: { event: string; head?: string | null; weekly?: string; planResult?: string; scope?: string; headRef?: string; runId?: string; prNumber?: number; matrix?: string }) => ({
  github: { event_name: o.event, repository: SAME_REPO, head_ref: o.headRef ?? "", run_id: o.runId ?? "1", event: o.event === "pull_request" ? { pull_request: { number: o.prNumber ?? 1, head: { repo: o.head === null ? null : { full_name: o.head ?? SAME_REPO } } } } : {} },
  vars: { MATRIX_WEEKLY_ENABLED: o.weekly ?? "true" },
  inputs: { scope: o.scope ?? "" },
  needs: { plan: { result: o.planResult ?? "success", outputs: { matrix: o.matrix ?? "" } }, "matrix-rows": { outputs: { run: "true" } } },
});

describe("a fork PR never reaches vars.MATRIX_RUNNER (T9-FORK)", () => {
  const FORK_SAFE = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
  const truth = ["plan", "build", "shard", "merge"] as const;
  const gate = (job: (typeof truth)[number]) => ifOf(JOBS[job]!);
  const sample = () => ifOf(CI_JOBS["matrix-sample"]!);

  it("every matrix-truth.yml job and ci.yml's matrix-sample spells the fork condition in its own `if:` (five gates, counted)", () => {
    const gates = [...truth.map((j) => [`matrix-truth.yml ${j}`, gate(j)] as const), ["ci.yml matrix-sample", sample()] as const];
    expect(gates).toHaveLength(5);
    expect(Object.keys(JOBS).sort()).toEqual([...truth].sort());   // a fifth matrix-truth job owes this gate and a row here
    for (const [name, expr] of gates) expect(expr, name).toContain(FORK_SAFE);
  });

  it("the gates, evaluated: a same-repo PR, a dispatch and a schedule open them; a fork PR and a PR whose head repo is gone close every one (35 evaluations)", () => {
    let evaluated = 0;
    // A: matrix-truth.yml's own triggers (inputs.scope empty on a PR / a schedule, `full` on a dispatch).
    const own: { name: string; ctx: Record<string, unknown>; open: boolean }[] = [
      { name: "workflow_dispatch", ctx: ctxOf({ event: "workflow_dispatch", scope: "full" }), open: true },
      { name: "schedule, enabled", ctx: ctxOf({ event: "schedule" }), open: true },
      { name: "PR from the same repository", ctx: ctxOf({ event: "pull_request" }), open: true },
      { name: "PR from a fork", ctx: ctxOf({ event: "pull_request", head: "someone-else/seazn.club" }), open: false },
      { name: "PR whose head repository was deleted", ctx: ctxOf({ event: "pull_request", head: null }), open: false },
    ];
    for (const job of truth) for (const c of own) { expect(evalIf(gate(job), c.ctx), `${job}: ${c.name}`).toBe(c.open); evaluated++; }
    // B: the per-PR sample, as ci.yml calls it (the caller's event is pull_request; scope pr-sample). merge never runs for a sample (its own rule).
    const called: { name: string; head?: string | null; open: boolean }[] = [
      { name: "same-repo PR", open: true },
      { name: "fork PR", head: "someone-else/seazn.club", open: false },
      { name: "head repository deleted", head: null, open: false },
    ];
    for (const c of called) {
      const ctx = ctxOf({ event: "pull_request", scope: "pr-sample", head: c.head });
      for (const job of ["plan", "build", "shard"] as const) { expect(evalIf(gate(job), ctx), `called ${job}: ${c.name}`).toBe(c.open); evaluated++; }
      expect(evalIf(gate("merge"), ctx), `called merge: ${c.name}`).toBe(false); evaluated++;
      expect(evalIf(sample(), ctx), `matrix-sample: ${c.name}`).toBe(c.open); evaluated++;
    }
    expect(evaluated).toBe(35);
  });

  it("the weekly gate still holds beside the fork gate, and neither swallows the other (operator precedence)", () => {
    expect(evalIf(gate("plan"), ctxOf({ event: "schedule", weekly: "" }))).toBe(false);
    expect(evalIf(gate("plan"), ctxOf({ event: "schedule", weekly: "false" }))).toBe(false);
    expect(evalIf(gate("plan"), ctxOf({ event: "schedule", weekly: "true" }))).toBe(true);
    expect(evalIf(gate("plan"), ctxOf({ event: "pull_request", weekly: "" }))).toBe(true);        // the weekly switch does not gate a PR's own run
    expect(evalIf(gate("plan"), ctxOf({ event: "workflow_dispatch", weekly: "", scope: "full" }))).toBe(true);
    expect(evalIf(gate("plan"), ctxOf({ event: "pull_request", weekly: "true", head: "someone-else/seazn.club" }))).toBe(false);
  });

  it("the merge job runs after a red shard, but not for a sample, a failed plan, a skipped plan, or a CANCELLED run (m2: !cancelled(), not always())", () => {
    expect(gate("merge")).toContain("!cancelled()");
    expect(gate("merge")).not.toContain("always()");
    expect(evalIf(gate("merge"), ctxOf({ event: "workflow_dispatch", scope: "full" }))).toBe(true);
    expect(evalIf(gate("merge"), ctxOf({ event: "workflow_dispatch", scope: "full" }), true)).toBe(false);    // cancelled
    expect(evalIf(gate("merge"), ctxOf({ event: "workflow_dispatch", scope: "full", planResult: "failure" }))).toBe(false);
    expect(evalIf(gate("merge"), ctxOf({ event: "schedule", planResult: "skipped" }))).toBe(false);   // the disabled weekly firing
    expect(evalIf(gate("merge"), ctxOf({ event: "pull_request", scope: "pr-sample" }))).toBe(false);
  });

  it("the evaluator itself can tell the cases apart (a constant-true or constant-false reading would pass one half of the table above)", () => {
    expect(evalIf("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository", ctxOf({ event: "pull_request", head: "x/y" }))).toBe(false);
    expect(evalIf("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository", ctxOf({ event: "pull_request" }))).toBe(true);
    expect(() => evalIf("contains(github.ref, 'x')", ctxOf({ event: "push" }))).toThrow(/unsupported/);
  });
});

/** Every `permissions:` block of a workflow's text: its line, the scalar form (`permissions: write-all`) or null, and its key→value entries. */
function permissionBlocks(text: string): { line: number; scalar: string | null; entries: Record<string, string> }[] {
  const lines = text.split("\n");
  const out: { line: number; scalar: string | null; entries: Record<string, string> }[] = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)permissions:\s*([^#\s].*?)?\s*(?:#.*)?$/.exec(l);
    if (m === null) return;
    const entries: Record<string, string> = {};
    if (m[2] === undefined) {
      for (const next of lines.slice(i + 1)) {
        if (next.trim() === "" || next.trim().startsWith("#")) continue;
        if (next.length - next.trimStart().length <= m[1]!.length) break;
        const kv = /^\s+([\w-]+):\s*(\S+)/.exec(next);
        if (kv !== null) entries[kv[1]!] = kv[2]!;
      }
    }
    out.push({ line: i + 1, scalar: m[2] ?? null, entries });
  });
  return out;
}

describe("the exposure surface of the two workflows is read-only, secret-free and never pull_request_target (m1)", () => {
  it("matrix-truth.yml: ONE permissions block, workflow-level, exactly contents+actions read; no job widens it", () => {
    const blocks = permissionBlocks(WF);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.scalar).toBeNull();
    expect(blocks[0]!.entries).toEqual({ contents: "read", actions: "read" });
    expect(WF).toMatch(/^permissions:$/m);   // at column 0: the workflow's, not a job's
  });
  it("ci.yml: the matrix-rows block reads contents, pull-requests and actions; matrix-sample (a called workflow cannot exceed its caller) reads contents and actions", () => {
    expect(permissionBlocks(CI_JOBS["matrix-rows"]!).map((b) => b.entries)).toEqual([{ contents: "read", "pull-requests": "read", actions: "read" }]);
    expect(permissionBlocks(CI_JOBS["matrix-sample"]!).map((b) => b.entries)).toEqual([{ contents: "read", actions: "read" }]);
  });
  it("no permission in either file is anything but read (or none), and no block is a scalar shorthand — counted", () => {
    let entries = 0;
    for (const [name, text] of [["matrix-truth.yml", WF], ["ci.yml", CI]] as const) {
      for (const b of permissionBlocks(text)) {
        expect(b.scalar, `${name}:${b.line} scalar permissions`).toBeNull();
        for (const [k, v] of Object.entries(b.entries)) { expect(["read", "none"], `${name}:${b.line} ${k}: ${v}`).toContain(v); entries++; }
      }
    }
    expect(entries).toBeGreaterThanOrEqual(2 + 3 + 2);   // at least the three blocks pinned above
  });
  it("no secret reaches a matrix job: no `secrets` expression and no `secrets:` key in matrix-truth.yml, matrix-rows or matrix-sample", () => {
    const surfaces: [string, string][] = [["matrix-truth.yml", WF], ["ci.yml matrix-rows", CI_JOBS["matrix-rows"]!], ["ci.yml matrix-sample", CI_JOBS["matrix-sample"]!]];
    expect(surfaces).toHaveLength(3);
    for (const [name, text] of surfaces) {
      expect(text, `${name}: a secrets expression`).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
      expect(text, `${name}: a secrets: key (secrets: inherit)`).not.toMatch(/^\s*secrets:/m);
    }
  });
  it("neither file triggers on pull_request_target (it runs a fork's code with the base's secrets)", () => {
    for (const [name, text] of [["matrix-truth.yml", WF], ["ci.yml", CI]] as const) expect(text, name).not.toContain("pull_request_target");
  });
});

describe("a re-run does not collide with its own artifacts (m3)", () => {
  it("every upload-artifact step of matrix-truth.yml overwrites: the build, each shard, the merged result (3, counted)", () => {
    const named: [string, string][] = [["build", "Upload the build"], ["shard", "Upload shard results"], ["merge", "Upload merged results"]];
    for (const [job, step] of named) expect(stepOf(JOBS[job]!, step).body, `${job}: ${step}`).toContain("overwrite: true");
    expect(WF.match(/uses: actions\/upload-artifact@v4/g)).toHaveLength(3);
    expect(WF.match(/^\s+overwrite: true$/gm)).toHaveLength(3);   // a fourth upload without it reds on the first count
  });
});

// --- mutation.yml (W1d Task 15; rulings 66, 67, 68; D14) ----------------------------------------------------------------
// Held by text like matrix-truth.yml, and where a step's logic lives in its `run:` the block is RUN for real, with `pnpm`
// stood in on the PATH: what is proven is the YAML's own wiring (the flags it passes, the exit code it keeps, the files it
// reads) against the real engine CLIs, never a copy of the command kept in the test. They live here, not in Task 9's block,
// because they read mutation.yml and stryker.groups.mjs, which Task 15 creates (a read in a `describe` body fails the whole
// file at collection).
const MUT = readFileSync(join(WORKFLOWS, "mutation.yml"), "utf8");
const MJOBS = jobsOf(MUT);
/** The `matrix=` value the plan job's "Derive the matrix" step really writes for an event and a dispatch group: the step's own
 *  command run through bash against stryker-matrix.mjs. It is what `needs.plan.outputs.matrix` holds for the jobs after it. */
function planMatrix(event: string, group: string): string {
  const out = join(fresh("plan-out"), "github-output");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", runLine(MJOBS.plan!, "Derive the matrix")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, EVENT: event, GROUP: group } });
  if (r.status !== 0) throw new Error(`the plan step refused EVENT=${event} GROUP=${group}: ${r.stderr}`);
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  if (lines.length !== 1 || !lines[0]!.startsWith("matrix=")) throw new Error(`the plan step wrote ${JSON.stringify(lines)}`);
  return lines[0]!.slice("matrix=".length);
}
const ENGINE_DIR = join(REPO, "packages/engine");
const enginePkg = JSON.parse(readFileSync(join(ENGINE_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("both workflows run on the switchable runner (ruling 68, D24)", () => {
  it("every job of matrix-truth.yml AND mutation.yml runs on the switchable runner (ruling 68, D24), and has a timeout-minutes", () => {
    for (const [file, text] of [["matrix-truth.yml", WF], ["mutation.yml", MUT]] as const) {
      const jobs = Object.entries(jobsOf(text));
      expect(jobs.length, file).toBeGreaterThan(1);   // anti-vacuity
      for (const [name, t] of jobs) {
        expect(t, `${file}:${name} runs-on`).toContain("runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}");
        expect(t, `${file}:${name} timeout-minutes`).toMatch(/timeout-minutes:/);
      }
    }
  });
});

describe("mutation.yml and the runner wiring (review 5: R5-I1, m2, m3; moved here by review 6, R6-I1)", () => {
  it("every guard step of BOTH workflows takes RUNNER_ENV from runner.environment, never a literal (the one line that decides whether private hosted minutes can be billed)", () => {
    const all = [...Object.values(JOBS), ...Object.values(MJOBS)];
    expect(all.length).toBeGreaterThan(4);   // anti-vacuity: matrix-truth's four plus mutation's
    for (const t of all) expect(stepOf(t, GUARD).body).toContain("RUNNER_ENV: ${{ runner.environment }}");
  });
  it("the mutate job does not cancel its siblings, takes its timeout from the matrix, and saves its evidence even when Stryker exits non-zero (R5-I1)", () => {
    expect(MJOBS.mutate).toContain("matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}");
    expect(MJOBS.mutate).toContain("fail-fast: false");
    expect(MJOBS.mutate).toContain("timeout-minutes: ${{ matrix.timeout }}");
    for (const n of ["Survivors", "Upload mutation results"]) expect(stepOf(MJOBS.mutate!, n).body).toContain("if: always()");
  });
  it("the dispatch `group` choices are `all` plus exactly STRYKER_GROUPS's keys, in declaration order (m2)", () => {
    // a trailing `# comment` on an option line is stripped (review 6, m4)
    const opts = /group:[\s\S]*?options:\n((?:\s+- .+\n)+)/.exec(MUT)![1]!.split("\n").map((l) => l.replace(/\s+#.*$/, "").replace(/^\s+- /, "").trim()).filter(Boolean);
    expect(opts).toEqual(["all", ...Object.keys(STRYKER_GROUPS)]);
    expect(opts.length).toBeGreaterThan(2);
  });
  it("mutation.yml's guard is the first step of every job, with matrix-truth's script in every line but the refusal's wording (the identical-script claim for the second workflow)", () => {
    const base = stepOf(JOBS.plan!, GUARD).script;
    expect(base).not.toBeNull();
    expect(base, "matrix-truth's script still carries its own wording, so the substitution below is a real one").toContain(MATRIX_TRUTH_REFUSAL);
    const want = base!.replace(MATRIX_TRUTH_REFUSAL, STRYKER_REFUSAL);
    expect(want).not.toBe(base);
    expect(Object.keys(MJOBS).length).toBeGreaterThan(1);
    for (const [name, t] of Object.entries(MJOBS)) {
      expect(stepHeads(t)[0], name).toBe(`      - name: ${GUARD}`);
      expect(stepOf(t, GUARD).script, name).toBe(want);
    }
  });
});

describe("mutation.yml: triggers, the weekly gate and the fork gate (T9 conventions: T9-FORK, m1, m2, m3)", () => {
  it("schedule + workflow_dispatch + its own pull_request paths, and no push, no workflow_call, no pull_request_target", () => {
    expect(MUT).toMatch(/schedule:\s*\n\s*- cron: "23 3 \* \* 0"/);
    expect(MUT.match(/^\s*- cron:/gm)).toHaveLength(1);   // one weekly firing: a second cron line would run the whole matrix again
    for (const t of ["workflow_dispatch:", "pull_request:"]) expect(MUT).toContain(t);
    expect(MUT).not.toMatch(/^\s{2}push:/m);
    expect(MUT).not.toContain("workflow_call");
    expect(MUT).not.toContain("pull_request_target");
    expect(MUT).toMatch(/paths:\s*\n\s*- "\.github\/workflows\/mutation\.yml"\s*\n\s*- "packages\/engine\/stryker\*"\s*\n\s*- "packages\/engine\/scripts\/stryker-\*"/);
  });

  it("the three jobs are plan, mutate and floors; mutate needs plan, floors needs both, and plan and floors have the 15-minute timeout", () => {
    expect(Object.keys(MJOBS)).toEqual(["plan", "mutate", "floors"]);
    expect(MJOBS.mutate).toMatch(/needs:\s*\[plan\]/);
    expect(MJOBS.floors).toMatch(/needs:\s*\[plan, mutate\]/);
    expect(MJOBS.plan).toMatch(/timeout-minutes: 15\b/);
    expect(MJOBS.floors).toMatch(/timeout-minutes: 15\b/);
    expect(MJOBS.plan).toContain("outputs:\n      matrix: ${{ steps.matrix.outputs.matrix }}");
  });

  it("plan and mutate spell the fork condition in their own `if:` (plan the weekly gate beside it), and floors runs only when the plan holds a leg with a floor: each evaluated over every event, with the matrix the plan step really writes (9 cases x 3 jobs = 27 evaluations)", () => {
    let evaluated = 0;
    const plan = ifOf(MJOBS.plan!);
    const mutate = ifOf(MJOBS.mutate!);
    const floors = ifOf(MJOBS.floors!);
    expect(plan).toContain("(github.event_name != 'schedule' || vars.MATRIX_WEEKLY_ENABLED == 'true')");
    expect(mutate).toContain("(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)");
    // floors: after every leg even a red one (always()), only when plan ran, and never when the plan holds only the probe (a
    // probe-only plan, a pull request or `workflow_dispatch group=probe`, has no floor: --check-all refuses the probe). The fromJSON
    // term comes LAST: a skipped or failed plan wrote no matrix, and `&&` stops before it is parsed.
    expect(floors).toBe("always() && needs.plan.result == 'success' && join(fromJSON(needs.plan.outputs.matrix).include.*.group, ',') != 'probe'");
    const ran = (event: string, group: string) => ({ event, matrix: planMatrix(event, group) });
    const cases: { name: string; ctx: Record<string, unknown>; plan: boolean; mutate: boolean; floors: boolean }[] = [
      { name: "workflow_dispatch group=all", ctx: ctxOf(ran("workflow_dispatch", "all")), plan: true, mutate: true, floors: true },
      { name: "workflow_dispatch of one leg", ctx: ctxOf(ran("workflow_dispatch", "draws-3")), plan: true, mutate: true, floors: true },
      // N1: the documented probe-only dispatch plans [probe]; floors must skip, not refuse the probe
      { name: "workflow_dispatch group=probe", ctx: ctxOf(ran("workflow_dispatch", "probe")), plan: true, mutate: true, floors: false },
      { name: "schedule, enabled", ctx: ctxOf({ ...ran("schedule", ""), weekly: "true" }), plan: true, mutate: true, floors: true },
      // the disabled weekly firing: plan is skipped by its own `if:` and wrote no matrix, and mutate by `needs: [plan]` (a skipped
      // need skips the job); floors has always(), so only its own `needs.plan.result == 'success'` keeps it from running
      { name: "schedule, disabled", ctx: ctxOf({ event: "schedule", weekly: "", planResult: "skipped" }), plan: false, mutate: true, floors: false },
      // a pull request plans the probe
      { name: "PR from the same repository", ctx: ctxOf(ran("pull_request", "")), plan: true, mutate: true, floors: false },
      { name: "PR from a fork", ctx: ctxOf({ event: "pull_request", head: "someone-else/seazn.club", planResult: "skipped" }), plan: false, mutate: false, floors: false },
      { name: "PR whose head repository was deleted", ctx: ctxOf({ event: "pull_request", head: null, planResult: "skipped" }), plan: false, mutate: false, floors: false },
      // plan itself failed: there is no matrix, so nothing for floors to judge
      { name: "workflow_dispatch whose plan failed", ctx: ctxOf({ event: "workflow_dispatch", planResult: "failure" }), plan: true, mutate: true, floors: false },
    ];
    for (const c of cases) {
      expect(evalIf(plan, c.ctx), `plan: ${c.name}`).toBe(c.plan);
      expect(evalIf(mutate, c.ctx), `mutate: ${c.name}`).toBe(c.mutate);
      expect(evalIf(floors, c.ctx), `floors: ${c.name}`).toBe(c.floors);
      evaluated += 3;
    }
    expect(evaluated).toBe(27);
  }, spawnBudget(5));

  it("a push to a pull request cancels the run it supersedes and nothing else is ever cancelled: one top-level `concurrency:` whose group is the PR's number for a PR and the run's own id otherwise", () => {
    const blocks = MUT.match(/^concurrency:\n(?: {2}.*\n)+/gm);
    expect(blocks, "ONE concurrency block at column 0").toHaveLength(1);
    const group = /^ {2}group: (.+)$/m.exec(blocks![0]!)![1]!;
    const cancel = /^ {2}cancel-in-progress: (.+)$/m.exec(blocks![0]!)![1]!;
    expect(group).toBe("mutation-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}");
    expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
    const groupOf = (ctx: Record<string, unknown>) => `mutation-${String(evalExpr(/\$\{\{\s*(.+?)\s*\}\}/.exec(group)![1]!, ctx))}`;
    const cancels = (ctx: Record<string, unknown>) => evalIf(cancel, ctx);
    // a PR: the same PR is the same group (so a new push cancels the old run), another PR is another group
    const pr = (prNumber: number, headRef: string, runId: string) => ctxOf({ event: "pull_request", prNumber, headRef, runId });
    expect(groupOf(pr(7, "feat/a", "10"))).toBe("mutation-pr-7");
    expect(groupOf(pr(7, "feat/a", "11")), "a new push to the same PR").toBe(groupOf(pr(7, "feat/a", "10")));
    expect(groupOf(pr(7, "feat/renamed", "12")), "the same PR after its branch was renamed").toBe(groupOf(pr(7, "feat/a", "10")));
    expect(groupOf(pr(8, "feat/b", "13")), "another PR").not.toBe(groupOf(pr(7, "feat/a", "10")));
    // a fork PR whose branch is named like a same-repo PR's must not share its group: it would cancel that PR's run (the group is
    // taken before any job's `if:` skips the fork's run). Same head_ref, different PR number.
    expect(groupOf(pr(9, "feat/a", "14")), "a fork PR reusing a same-repo branch name").not.toBe(groupOf(pr(7, "feat/a", "10")));
    expect(cancels(pr(7, "feat/a", "10"))).toBe(true);
    // every other event: its own group per run, and never cancelling, so a weekly run or a dispatch is never aborted by a later push
    let others = 0;
    for (const event of ["schedule", "workflow_dispatch"]) {
      const a = ctxOf({ event, headRef: "", runId: "100" });
      const b = ctxOf({ event, headRef: "", runId: "101" });
      expect(groupOf(a), event).toBe("mutation-run-100");
      expect(groupOf(a), `${event}: two runs`).not.toBe(groupOf(b));
      expect(cancels(a), event).toBe(false);
      others++;
    }
    expect(others).toBe(2);
    // a dispatch from a branch whose name equals a PR's head ref does not share its group (head_ref is empty outside a PR), and a run
    // id that equals a PR number is another group (the two namespaces are prefixed)
    expect(groupOf(ctxOf({ event: "workflow_dispatch", headRef: "feat/a", runId: "7" }))).toBe("mutation-run-7");
    expect(groupOf(ctxOf({ event: "workflow_dispatch", runId: "7" }))).not.toBe(groupOf(pr(7, "feat/a", "10")));
  });

  it("the exposure surface is read-only and secret-free: ONE workflow-level permissions block, contents read, and no secrets anywhere", () => {
    const blocks = permissionBlocks(MUT);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.scalar).toBeNull();
    expect(blocks[0]!.entries).toEqual({ contents: "read" });
    expect(MUT).toMatch(/^permissions:$/m);   // at column 0: the workflow's, not a job's
    expect(MUT).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
    expect(MUT).not.toMatch(/^\s*secrets:/m);
  });

  it("the one upload overwrites its own artifact (a re-run must not 409), is named per group, and is rooted at packages/engine/ (PF-5: a download holds reports/mutation/<group>.json)", () => {
    expect(MUT.match(/uses: actions\/upload-artifact@v4/g)).toHaveLength(1);
    expect(MUT.match(/^\s+overwrite: true$/gm)).toHaveLength(1);
    const up = stepOf(MJOBS.mutate!, "Upload mutation results").body;
    expect(up).toContain("name: mutation-${{ matrix.group }}");
    const paths = /path: \|\n((?: {12}\S.*\n?)+)/.exec(up)![1]!.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(paths.length).toBeGreaterThan(1);
    for (const x of paths) expect(x, x).toMatch(/^packages\/engine\//);
    expect(paths).toContain("packages/engine/reports/mutation/${{ matrix.group }}.json");
    expect(paths).toContain("packages/engine/SURVIVORS.md");
  });
});

describe("mutation.yml: the incremental cache is keyed so no group can restore another's file", () => {
  const cache = stepOf(MJOBS.mutate!, "Restore the incremental file").body;
  const keyOf = (g: string) => /^ {10}key: (.+)$/m.exec(cache)![1]!.replace("${{ matrix.group }}", g).replace("${{ github.sha }}", "0123abc");
  const restoreOf = (g: string) => /restore-keys: \|\n {12}(\S.*)$/m.exec(cache)![1]!.replace("${{ matrix.group }}", g);

  it("the cached path is the group's own incremental file, the one stryker.config.mjs writes", () => {
    expect(cache).toContain("path: packages/engine/reports/mutation/${{ matrix.group }}.incremental.json");
    expect(cache).toContain("uses: actions/cache/restore@v4");
  });

  it("the file is SAVED by its own step, `if: always()`, after Stryker and under the key the restore looks for (a red Stryker run must not lose it)", () => {
    const save = stepOf(MJOBS.mutate!, "Save the incremental file").body;
    expect(save).toContain("uses: actions/cache/save@v4");
    expect(save).toContain("if: always()");
    expect(save).toContain("path: packages/engine/reports/mutation/${{ matrix.group }}.incremental.json");
    expect(save).toContain(`key: ${/^ {10}key: (.+)$/m.exec(cache)![1]!}`);
    const heads = stepHeads(MJOBS.mutate!);
    const at = (n: string) => heads.indexOf(`      - name: ${n}`);
    expect(at("Run Stryker")).toBeGreaterThan(at("Restore the incremental file"));
    expect(at("Save the incremental file")).toBe(at("Run Stryker") + 1);   // before any later step that can exit non-zero
    expect(at("Survivors")).toBeGreaterThan(at("Save the incremental file"));
    expect(heads.filter((h) => h.includes("Floor check")), "the floor is judged per family by the floors job, never by a leg").toEqual([]);
    // the plain `actions/cache@v4` would save only on a green job: none may remain
    expect(MUT).not.toMatch(/uses: actions\/cache@/);
  });

  it("no group's restore prefix is a prefix of another group's cache key (derived from the real group names)", () => {
    const names = Object.keys(STRYKER_GROUPS);
    let compared = 0;
    for (const g of names) {
      for (const h of names) {
        if (g === h) { expect(keyOf(h).startsWith(restoreOf(g)), `${g} restores its own`).toBe(true); continue; }
        expect(keyOf(h).startsWith(restoreOf(g)), `${g}'s restore prefix "${restoreOf(g)}" reaches ${h}'s key "${keyOf(h)}"`).toBe(false);
        compared++;
      }
    }
    expect(compared).toBe(names.length * (names.length - 1));
  });

  it("the premise: a restore key that stopped at the group's name WOULD collide on the real names, `sports-cricket-1` reaching `sports-cricket-10` (so the '@' is doing work, not decoration)", () => {
    const names = Object.keys(STRYKER_GROUPS);
    const colliding = names.flatMap((g) => names.filter((h) => h !== g && `stryker-${h}@0123abc`.startsWith(`stryker-${g}`)).map((h) => `${g} -> ${h}`));
    expect(colliding.length).toBeGreaterThan(0);
    expect(colliding, "the numbered legs are the ones that collide").toContain("sports-cricket-1 -> sports-cricket-10");
  });
});

// --- the steps, run for real -----------------------------------------------------------------------------------------

/** A `pnpm` on the PATH for a step that runs in packages/engine: `mutation:floor` runs the REAL engine CLI as the engine's
 *  package.json spells it (paths made absolute, so the cwd can be a scratch dir); `mutation` is a stand-in that records the
 *  STRYKER_GROUP it was given and exits with FAIL_CODE (the real Stryker run is the probe's, not a unit test's). */
function enginePnpm(dir: string): void {
  const floorCmd = enginePkg.scripts["mutation:floor"];
  expect(floorCmd, "the engine's mutation:floor script").toBeDefined();
  writeFileSync(join(dir, "pnpm"), `#!/bin/sh
echo "$*" >> "$RECORD"
cmd="$1"; shift
case "$cmd" in
  mutation:floor) exec ${floorCmd!.replace(" scripts/", ` ${ENGINE_DIR}/scripts/`)} "$@" ;;
  mutation) echo "STRYKER_GROUP=$STRYKER_GROUP" >> "$RECORD"; if [ -n "$FAIL_CODE" ]; then echo "stand-in: stryker failed" >&2; exit "$FAIL_CODE"; fi ;;
  *) echo "stand-in pnpm: unexpected command $cmd" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  chmodSync(join(dir, "pnpm"), 0o755);
}
/** The one-line `run:` of a step (the floor and survivors steps), with the engine-relative script path made absolute. */
function runLine(jobText: string, name: string): string {
  const m = /^ {8}run: (\S.*)$/m.exec(stepOf(jobText, name).body);
  if (m === null) throw new Error(`the "${name}" step has no one-line run:`);
  return m[1]!.replace(" scripts/stryker-floor.ts", ` ${ENGINE_DIR}/scripts/stryker-floor.ts`);
}
function runBlock(script: string, o: { cwd: string; env?: Record<string, string> }): { status: number | null; stdout: string; stderr: string; record: string[] } {
  const bin = fresh("bin");
  enginePnpm(bin);
  const recordFile = join(bin, "record");
  writeFileSync(recordFile, "");
  const r = spawnSync("bash", ["-c", script], { cwd: o.cwd, encoding: "utf8", timeout: SPAWN_MS * 3, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, RECORD: recordFile, ...o.env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, record: readFileSync(recordFile, "utf8").split("\n").filter(Boolean) };
}
/** A scratch packages/engine: the floor file, and a `draws-3` report (3 killed, 1 survived: 75.0%) at reports/mutation/draws-3.json
 *  (the Survivors step's own layout: one leg's report in the leg's own job). */
function engineDir(floors: Record<string, number>, over: { omitReport?: boolean } = {}): string {
  const cwd = fresh("engine");
  writeFileSync(join(cwd, "stryker-floor.json"), JSON.stringify({ note: "t", families: floors }));
  if (over.omitReport !== true) {
    mkdirSync(join(cwd, "reports/mutation"), { recursive: true });
    writeFileSync(join(cwd, "reports/mutation/draws-3.json"), JSON.stringify({ files: { "src/scheduling/bracket.ts": { mutants: mutantsOf([["Killed", 1], ["Killed", 2], ["Timeout", 3], ["Survived", 4]]) } } }));
  }
  return cwd;
}
const mutantsOf = (rows: [string, number][]) => rows.map(([status, line]) => ({ mutatorName: "ConditionalExpression", replacement: "true", status, location: { start: { line, column: 1 } } }));
/** A scratch checkout for the `floors` job: packages/engine holds the floor file (the step's working directory), and floors-in/
 *  holds what download-artifact unpacks, each leg's artifact at mutation-<leg>/reports/mutation/<leg>.json. Returns the engine
 *  directory. `reports` maps a leg to the file it mutated and its (status, line) mutants; a leg left out left no artifact. */
function floorsRepo(floors: Record<string, number>, reports: Record<string, { file: string; mutants: [string, number][] }>): string {
  const root = fresh("checkout");
  const engine = join(root, "packages/engine");
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "stryker-floor.json"), JSON.stringify({ note: "t", families: floors }));
  for (const [leg, r] of Object.entries(reports)) {
    const dir = join(root, "floors-in", `mutation-${leg}`, "reports/mutation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${leg}.json`), JSON.stringify({ files: { [r.file]: { mutants: mutantsOf(r.mutants) } } }));
  }
  return engine;
}

describe("mutation.yml: the plan step derives the matrix through the real script, per event", () => {
  const script = stepOf(MJOBS.plan!, "Derive the matrix").script ?? runLine(MJOBS.plan!, "Derive the matrix");
  const derive = (env: Record<string, string>) => {
    const out = join(fresh("out"), "github-output");
    writeFileSync(out, "");
    // the step's command, as the workflow spells it, run from the repo root (a workflow step's default directory)
    const r = spawnSync("bash", ["-c", script], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, ...env } });
    return { status: r.status, stderr: r.stderr, lines: readFileSync(out, "utf8").split("\n").filter(Boolean) };
  };
  const groupsIn = (lines: string[]) => (JSON.parse(lines[0]!.slice("matrix=".length)) as { include: { group: string; timeout: number }[] }).include.map((e) => e.group);

  it.each([
    ["pull_request", "", ["probe"]],
    ["schedule", "", Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe")],
    ["workflow_dispatch", "all", Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe")],
    ["workflow_dispatch", "probe", ["probe"]],
    ["workflow_dispatch", "draws-3", ["draws-3"]],
  ])("EVENT=%s GROUP='%s' appends exactly one `matrix=<json>` line to $GITHUB_OUTPUT with %j", (event, group, want) => {
    const r = derive({ EVENT: event, GROUP: group });
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^matrix=\{"include":\[/);
    expect(groupsIn(r.lines)).toEqual(want);
  }, spawnBudget(1));

  it("a dispatch of an unknown group fails the step and appends nothing (the matrix is never empty-and-green)", () => {
    const r = derive({ EVENT: "workflow_dispatch", GROUP: "nosuch" });
    expect(r.status).not.toBe(0);
    expect(r.lines).toEqual([]);
  }, spawnBudget(1));
});

describe("mutation.yml: the Stryker step keeps Stryker's own exit and writes it down (D8: a killed command reads as 0 otherwise)", () => {
  const body = stepOf(MJOBS.mutate!, "Run Stryker");
  const script = body.script!;
  it("it runs `pnpm mutation` in packages/engine with STRYKER_GROUP from the job's GROUP", () => {
    expect(body.body).toContain("working-directory: packages/engine");
    const r = runBlock(script, { cwd: fresh("engine"), env: { GROUP: "draws-3" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.record).toEqual(["mutation", "STRYKER_GROUP=draws-3"]);
  }, spawnBudget(1));
  it("a failing run: the step exits with Stryker's code, reports/mutation/exit.txt says so (the directory is made even if Stryker died before writing one), and EXIT= is printed", () => {
    let checked = 0;
    for (const code of [1, 2, 137]) {
      const cwd = fresh("engine");
      const r = runBlock(script, { cwd, env: { GROUP: "core-1", FAIL_CODE: String(code) } });
      expect(r.status, `exit ${code}`).toBe(code);
      expect(readFileSync(join(cwd, "reports/mutation/exit.txt"), "utf8").trim(), `exit ${code}`).toBe(String(code));
      expect(r.stdout).toContain(`EXIT=${code}`);
      checked++;
    }
    expect(checked).toBe(3);
  }, spawnBudget(3));
});

describe("mutation.yml: the floors job judges each family on all its legs, run through the real engine CLI", () => {
  const floorStep = stepOf(MJOBS.floors!, "Floor check");
  const floorLine = runLine(MJOBS.floors!, "Floor check");
  const survivorsLine = runLine(MJOBS.mutate!, "Survivors");
  // two families: `core` is three legs, each (3 killed, 1 survived), so the family is 9 of 12 = 75.0%; `draws` is four, bracket.ts
  // 3 of 4 and one killed mutant in each of the others, which SUM to 6 of 7 = 85.7% (the mean of the legs' scores is 93.75 and the
  // weakest leg 75.0, so a floor of 85.7 tells the sum from both)
  const CORE = STRYKER_FAMILIES.core;
  const DRAWS = STRYKER_FAMILIES.draws;
  const CORE_FILES = ["src/core/clock.ts", "src/core/errors.ts", "src/core/rng.ts"];   // a whole file each core leg selects
  const DRAWS_FILES: Record<string, string> = { "draws-1": "src/scheduling/americano.ts", "draws-2": "src/scheduling/feedgraph.ts", "draws-3": "src/scheduling/bracket.ts", "draws-4": "src/scheduling/swiss.ts" };
  const LEGS = [...CORE, ...DRAWS].join(",");
  const ALL: Record<string, { file: string; mutants: [string, number][] }> = {
    ...Object.fromEntries(CORE.map((leg, i) => [leg, { file: CORE_FILES[i]!, mutants: [["Killed", 1], ["Killed", 2], ["Killed", 3], ["Survived", 4]] as [string, number][] }])),
    ...Object.fromEntries(DRAWS.map((leg) => [leg, { file: DRAWS_FILES[leg]!, mutants: (leg === "draws-3" ? [["Killed", 1], ["Killed", 2], ["Killed", 3], ["Survived", 4]] : [["Killed", 1]]) as [string, number][] }])),
  };
  const only = (legs: readonly string[]) => Object.fromEntries(legs.map((l) => [l, ALL[l]!]));

  it("the floors job reads the legs' artifacts from floors-in, judges them with --check-all over the legs the plan scheduled, and the step can be neither conditional nor advisory", () => {
    expect(MJOBS.floors).toContain("LEGS: ${{ join(fromJSON(needs.plan.outputs.matrix).include.*.group, ',') }}");
    const dl = MJOBS.floors!.slice(MJOBS.floors!.indexOf("uses: actions/download-artifact@v4"));
    expect(dl).toMatch(/^uses: actions\/download-artifact@v4\n {8}with:\n {10}pattern: mutation-\*\n {10}path: floors-in\n/);
    expect(MJOBS.floors!.match(/uses: actions\/download-artifact@/g), "one download").toHaveLength(1);
    // each leg's upload is named mutation-<leg> (the pattern above reads exactly those)
    expect(stepOf(MJOBS.mutate!, "Upload mutation results").body).toContain("name: mutation-${{ matrix.group }}");
    expect(floorStep.body).toContain("working-directory: packages/engine");
    expect(floorStep.body).not.toContain("continue-on-error");
    expect(floorStep.body, "no step-level `if:` that could skip it").not.toMatch(/^ {8}if:/m);
    expect(floorLine).toBe('pnpm mutation:floor --check-all ../../floors-in --legs "$LEGS" --skip-if-no-floors');
    // the install the jobs share is the engine's own (Stryker, vitest and the TypeScript parser are its devDependencies)
    for (const job of ["mutate", "floors"] as const) expect(MJOBS[job], job).toContain("run: pnpm install --frozen-lockfile --filter @seazn/engine...");
    expect(MUT).not.toMatch(/run: pnpm install --frozen-lockfile\s*$/m);
    // the artifacts the job unpacks are those of the families it judges: every non-probe leg is in a family
    expect(Object.values(STRYKER_FAMILIES).flat().sort()).toEqual(Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe").sort());
    // the fixtures below name legs of the real families (a re-cut that moved them reds here, not in a refusal that reads like a verdict)
    expect(Object.keys(DRAWS_FILES), "the fixture's draws legs are the family's").toEqual([...DRAWS]);
    expect(CORE).toHaveLength(CORE_FILES.length);
  });

  it("against the real plan, for every dispatch group and the weekly and the PR: floors runs exactly when the plan holds a leg with a floor, LEGS is those legs, and the probe is never in it (N1)", () => {
    const floors = ifOf(MJOBS.floors!);
    const legsExpr = /^ {6}LEGS: \$\{\{\s*(.+?)\s*\}\}/m.exec(MJOBS.floors!)![1]!;
    const keys = Object.keys(STRYKER_GROUPS);
    const plans = [...keys.map((group) => ({ event: "workflow_dispatch", group })), { event: "workflow_dispatch", group: "all" }, { event: "schedule", group: "" }, { event: "pull_request", group: "" }];
    let ran = 0;
    for (const p of plans) {
      const matrix = planMatrix(p.event, p.group);
      const ctx = ctxOf({ event: p.event, matrix });
      // what the plan scheduled, read from its own JSON (not from the workflow's expressions under test)
      const scheduled = (JSON.parse(matrix) as { include: { group: string }[] }).include.map((e) => e.group);
      const runs = evalIf(floors, ctx);
      expect(runs, `${p.event} ${p.group}: floors runs unless the plan holds only the probe (plan: ${scheduled.join(",")})`).toBe(!scheduled.every((g) => g === "probe"));
      if (runs) {
        const legs = String(evalExpr(legsExpr, ctx));
        expect(legs, `${p.event} ${p.group}: LEGS`).toBe(scheduled.join(","));
        expect(legs.split(","), `${p.event} ${p.group}: --check-all refuses the probe`).not.toContain("probe");
        ran++;
      }
    }
    // anti-vacuity: every plan was looked at, and the jobs that ran are every leg dispatched alone, group=all and the weekly
    // (the probe dispatched alone and the pull request, the two probe-only plans, are the rest, each checked above)
    expect(plans.length).toBe(keys.length + 3);
    expect(ran).toBe(keys.length - 1 + 2);
  }, spawnBudget(Object.keys(STRYKER_GROUPS).length + 3));   // one plan spawn per dispatch group, plus all, the weekly and the PR

  it("what the skip prevents: a probe-only dispatch's LEGS is `probe`, and the real CLI refuses it (exit 2, names the probe), so a floors job that ran would go red on a documented option", () => {
    const legsExpr = /^ {6}LEGS: \$\{\{\s*(.+?)\s*\}\}/m.exec(MJOBS.floors!)![1]!;
    const legs = String(evalExpr(legsExpr, ctxOf({ event: "workflow_dispatch", matrix: planMatrix("workflow_dispatch", "probe") })));
    expect(legs).toBe("probe");
    const r = runBlock(floorLine, { cwd: floorsRepo({}, {}), env: { LEGS: legs } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--legs names the probe");
    // and the same wiring on a real one-leg plan: the LEGS the expression gives is read by the CLI (one leg of a family is not the family)
    const core = String(evalExpr(legsExpr, ctxOf({ event: "workflow_dispatch", matrix: planMatrix("workflow_dispatch", "core-1") })));
    expect(core).toBe("core-1");
    const ok = runBlock(floorLine, { cwd: floorsRepo({}, only(["core-1"])), env: { LEGS: core } });
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({ status: 0, stderr: "" });
    expect(ok.stdout).toContain(`core: not judged, only 1 of its ${CORE.length} legs were planned`);
  }, spawnBudget(4));

  it("PR-A's state (the committed floor file is empty): it prints `no floor yet: PR-B sets it` for each family and passes, for the legs' real reports", () => {
    const r = runBlock(floorLine, { cwd: floorsRepo({}, ALL), env: { LEGS } });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(r.stdout.match(/no floor yet: PR-B sets it/g)).toHaveLength(2);
    expect(r.stdout).toContain("core: score 75.0% (9 of 12 detected");
    expect(r.stdout).toContain("draws: score 85.7% (6 of 7 detected");   // the SUM of the four legs
    expect(r.record).toEqual([`mutation:floor --check-all ../../floors-in --legs ${LEGS} --skip-if-no-floors`]);
  }, spawnBudget(1));

  it("once PR-B commits floors: a family with no entry is a failure, met floors pass and a missed one fails", () => {
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75 }, ALL), env: { LEGS } }).status, "no entry for draws").toBe(2);
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75, draws: 85.7 }, ALL), env: { LEGS } }).status).toBe(0);                  // 9 of 12 = 75.0, 6 of 7 = 85.7
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75, draws: 85.8 }, ALL), env: { LEGS } }).status).toBe(1);                // one tenth over the sum
    expect(runBlock(floorLine, { cwd: floorsRepo({ core: 75.1, draws: 85.7 }, ALL), env: { LEGS } }).status).toBe(1);
  }, spawnBudget(4));

  it("a planned leg that left no report is a failure even while no floor exists (a leg that died is never a skip), and the other families are still judged", () => {
    const withoutSwiss = only(LEGS.split(",").filter((l) => l !== "draws-4"));   // draws-4's job died before it wrote a report
    const r = runBlock(floorLine, { cwd: floorsRepo({}, withoutSwiss), env: { LEGS } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('draws: no report for leg "draws-4"');
    expect(r.stdout).toContain("core: score 75.0%");
  }, spawnBudget(1));

  it("a dispatch of ONE leg of a family does not judge the family (it is not the sum of its legs) and still passes; every leg of a family is judged", () => {
    const partial = runBlock(floorLine, { cwd: floorsRepo({ draws: 99 }, only(["draws-3"])), env: { LEGS: "draws-3" } });
    expect({ status: partial.status, stderr: partial.stderr }).toEqual({ status: 0, stderr: "" });
    expect(partial.stdout).toContain(`draws: not judged, only 1 of its ${DRAWS.length} legs were planned`);
    const whole = runBlock(floorLine, { cwd: floorsRepo({ core: 99 }, only(CORE)), env: { LEGS: CORE.join(",") } });
    expect(whole.status, "core is judged on its three legs, and 75.0 is under 99").toBe(1);
  }, spawnBudget(2));

  it("an empty LEGS (the expression evaluating to nothing) is a refusal, never a pass over zero families", () => {
    const r = runBlock(floorLine, { cwd: floorsRepo({}, ALL), env: { LEGS: "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--check-all needs --legs");
  }, spawnBudget(1));

  it("the survivors step writes SURVIVORS.md next to the group's report, listing the one survivor", () => {
    expect(stepOf(MJOBS.mutate!, "Survivors").body).toContain("working-directory: packages/engine");
    const cwd = engineDir({});
    const r = runBlock(survivorsLine, { cwd, env: { GROUP: "draws-3" } });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const md = readFileSync(join(cwd, "SURVIVORS.md"), "utf8");
    expect(md.split("\n").filter((l) => l.startsWith("src/"))).toEqual(["src/scheduling/bracket.ts:4:1 ConditionalExpression → true"]);
  }, spawnBudget(1));
});
