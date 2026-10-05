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

/** One `gh` process. A command that could not start (no gh on the PATH) is status 1 with the reason on stderr, never a throw. */
export const realGh: GhRunner = (args) => {
  const r = spawnSync("gh", [...args], { encoding: "utf8", timeout: 120_000 });
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

export interface WorkflowRun { id: number; conclusion: string; event: string; created_at: string }
// Not strict: GitHub adds fields to a run, and only these four are read.
const RunsSchema = z.object({
  workflow_runs: z.array(z.object({ id: z.number().int(), conclusion: z.string().nullable(), event: z.string(), created_at: z.string() })),
});

/** `owner/name`, and nothing that could steer the API path elsewhere. */
export const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const checkedRepo = (repo: string | undefined): string => {
  if (repo === undefined || repo === "") throw new GhFailed("GITHUB_REPOSITORY", "is not set");
  if (!REPO_SHAPE.test(repo) || repo.split("/").some((p) => p === "." || p === "..")) throw new GhFailed("GITHUB_REPOSITORY", "is not owner/name");
  return repo;
};

/** The workflow's successful runs, newest first as GitHub lists them. A page of 100, not 20: pull_request smoke runs
 *  share the workflow, so a short page could fill with them and push the weekly run out of sight (a false "never"). */
export function successfulRuns(gh: GhRunner, repo: string | undefined): WorkflowRun[] {
  const r = gh(["api", `repos/${checkedRepo(repo)}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=100`]);
  if (r.status !== 0) throw new GhFailed("gh api (workflow runs)", r.stderr);
  let json: unknown;
  try { json = JSON.parse(r.stdout); } catch { throw new GhFailed("gh api (workflow runs)", "the answer is not JSON"); }
  const p = RunsSchema.safeParse(json);
  if (!p.success) throw new GhFailed("gh api (workflow runs)", "the answer is not a list of workflow runs");
  return p.data.workflow_runs.map((w) => ({ id: w.id, conclusion: w.conclusion ?? "", event: w.event, created_at: w.created_at }));
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
