// A thin `gh` wrapper with an injectable runner (W1d Task 8, D1 and D20). The two CLIs that read GitHub (staleness.ts
// and summary.ts) take a GhRunner, so a test hands them canned answers and no test reaches the network.
//
// Everything `gh` prints on stderr passes through redact() before a caller can see it: a failed call echoes the request,
// and an Authorization header or a token in a URL is a secret in a public log. The token itself is the caller's
// environment (GH_TOKEN, set by the workflow); nothing here reads, passes or prints it.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { redact } from "../lib/redact.ts";

export type GhRunner = (args: readonly string[]) => { status: number; stdout: string; stderr: string };

/** A backstop, not the plan: spawnSync's default is 1 MiB, and a run list that outgrows it comes back TRUNCATED with ENOBUFS
 *  (this repo's e2e.yml at per_page=100 is 1.2 MB). The runs call below is projected small server-side by `--jq`; this
 *  bound only keeps a future call that is not projected from going dark the same way. */
export const GH_MAX_BUFFER = 64 * 1024 * 1024;

/** One `gh` process. A command that could not start (no gh on the PATH) is status 1 with the reason on stderr, never a throw. */
export const realGh: GhRunner = (args) => {
  const r = spawnSync("gh", [...args], { encoding: "utf8", timeout: 120_000, maxBuffer: GH_MAX_BUFFER });
  const spawnFault = r.error === undefined ? "" : r.error.message;
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: redact(`${r.stderr ?? ""}${spawnFault}`) };
};

/** A gh call that did not give a usable answer. The message is redacted and short: it is printed into a log. */
export class GhFailed extends Error {
  constructor(what: string, detail: string) {
    super(`${what}: ${redact(detail).replace(/\s+/g, " ").trim().slice(0, 300) || "no output"}`);
    this.name = "GhFailed";
  }
}

/** The one workflow whose runs the weekly signal reads. */
export const WORKFLOW = "matrix-truth.yml";
/** The events whose success is a WEEKLY/dispatch run. A pull_request run is the smoke scope, not the weekly run (D1). */
export const WEEKLY_EVENTS: readonly string[] = ["schedule", "workflow_dispatch"];

/** `run_attempt` rides along (a re-run keeps its first attempt's created_at, so the date alone does not say when it last ran);
 *  nothing reads it yet. */
export interface WorkflowRun { id: number; conclusion: string; event: string; created_at: string; run_attempt?: number }
// Not strict: GitHub adds fields to a run, and only these five are read.
const RunsSchema = z.object({
  workflow_runs: z.array(z.object({ id: z.number().int(), conclusion: z.string().nullable(), event: z.string(), created_at: z.string(), run_attempt: z.number().int().optional() })),
});

/** What `gh api --jq` keeps of each run: five fields instead of GitHub's ~12 KB per run (every nested repository and actor).
 *  The answer keeps the `workflow_runs` envelope, so RunsSchema reads it unchanged. */
export const RUN_PROJECTION = "{workflow_runs: [.workflow_runs[] | {id, conclusion, event, created_at, run_attempt}]}";
/** Per event. The runs are asked for by event and by success on the server, newest first, so the first row of each is the
 *  newest success of that event: ten is slack, not a window the weekly run can fall out of. */
const PER_PAGE = 10;

/** `owner/name`, and nothing that could steer the API path elsewhere. */
export const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const checkedRepo = (repo: string | undefined): string => {
  if (repo === undefined || repo === "") throw new GhFailed("GITHUB_REPOSITORY", "is not set");
  if (!REPO_SHAPE.test(repo) || repo.split("/").some((p) => p === "." || p === "..")) throw new GhFailed("GITHUB_REPOSITORY", "is not owner/name");
  return repo;
};

/** The workflow's successful scheduled and dispatched runs: one call per weekly event, `event=` and `status=success` filtered
 *  on the server and projected small by `--jq`. A `pull_request` run is never asked for, so it cannot fill a page and push the
 *  weekly run out of sight (a false "never"), and the answer stays far inside any buffer however long the workflow's history.
 *  The two events' rows are concatenated, not ordered: `weeklySuccesses` orders them. */
export function successfulRuns(gh: GhRunner, repo: string | undefined): WorkflowRun[] {
  const checked = checkedRepo(repo);
  const runs: WorkflowRun[] = [];
  for (const event of WEEKLY_EVENTS) {
    const r = gh(["api", `repos/${checked}/actions/workflows/${WORKFLOW}/runs?event=${event}&status=success&per_page=${PER_PAGE}`, "--jq", RUN_PROJECTION]);
    if (r.status !== 0) throw new GhFailed(`gh api (${event} runs)`, r.stderr);
    let json: unknown;
    try { json = JSON.parse(r.stdout); } catch { throw new GhFailed(`gh api (${event} runs)`, "the answer is not JSON"); }
    const p = RunsSchema.safeParse(json);
    if (!p.success) throw new GhFailed(`gh api (${event} runs)`, "the answer is not a list of workflow runs");
    for (const w of p.data.workflow_runs) runs.push({ id: w.id, conclusion: w.conclusion ?? "", event: w.event, created_at: w.created_at, ...(w.run_attempt === undefined ? {} : { run_attempt: w.run_attempt }) });
  }
  return runs;
}

/** The runs that count as a weekly/dispatch success, newest first (a created_at that is no date counts for nothing). */
export function weeklySuccesses<T extends { conclusion: string; event: string; created_at: string }>(runs: readonly T[]): T[] {
  return runs
    .filter((r) => r.conclusion === "success" && WEEKLY_EVENTS.includes(r.event) && !Number.isNaN(Date.parse(r.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** `gh run download <id> -n merged -D <dir>`: the run's merged artifact, into `dir`. */
export function downloadMerged(gh: GhRunner, repo: string | undefined, runId: number, dir: string): void {
  const r = gh(["run", "download", String(runId), "-n", "merged", "-D", dir, "--repo", checkedRepo(repo)]);
  if (r.status !== 0) throw new GhFailed(`gh run download ${runId}`, r.stderr);
}
