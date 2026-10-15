// The settled-poll override (`NEXT_PUBLIC_E2E_SETTLED_POLL_MS`, use-live-fixture.ts) exists for ONE consumer: CI's
// e2e, which runs the overlay on the poll path (stub Supabase) and would otherwise wait out a 60 s settled tick on
// every undo step. Two halves, both read from the files that decide them:
//
//  1. NO deploy config sets it. A NEXT_PUBLIC_* value is baked into the client bundle at build time, so one line in a
//     Dockerfile, a fly*.toml or a deploying workflow would ship the e2e interval to every spectator — a settled page
//     polling twelve times as often as designed, the exact load the window exists to bound. The clamp keeps it at or
//     above 5 s, but 5 s is still not what ships.
//  2. EVERY e2e.yml job that runs Playwright sets it at JOB level, to a value the clamp accepts. Job level is what
//     reaches both the build (the bundle) and the runner (the spec's budgets); a job without it builds and measures
//     at the shipped 60 s, which is correct but slow — and a value the clamp rejects is the same thing silently.
//
// Pure: no DB, no network; runs in every unit job and cannot self-skip.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFAULT_SETTLED_POLL_MS, SETTLED_POLL_MS_ENV_VAR, resolveSettledPollMs } from "../use-live-fixture";

/** Repo root: up out of __tests__ / match-centre / public-site / components / src / web / apps. */
const REPO_ROOT = resolve(import.meta.dirname, "../../../../../../..");
const WORKFLOWS = join(REPO_ROOT, ".github/workflows");

/** Directories that hold no deploy config of ours (dependencies, build output, VCS, agent scratch). */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "target", "coverage", ".turbo", "out"]);

/** Every Dockerfile and fly*.toml in the repo, found by walking it — not a hand list, so a new service is covered. */
function deployFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (/^Dockerfile/.test(entry.name) || /^fly.*\.toml$/.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(REPO_ROOT, 0);
  return found.sort();
}

/** The workflows that DEPLOY — chosen by what they run (flyctl / fly deploy), not by their file names. */
function deployWorkflows(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(WORKFLOWS, f))
    .filter((p) => /flyctl|fly deploy|superfly\//.test(readFileSync(p, "utf8")))
    .sort();
}

const rel = (p: string) => relative(REPO_ROOT, p);

describe("the settled-poll override reaches e2e and nothing that ships", () => {
  it("no Dockerfile, fly*.toml or deploying workflow names NEXT_PUBLIC_E2E_SETTLED_POLL_MS", () => {
    const files = [...deployFiles(), ...deployWorkflows()];
    const names = files.map(rel);
    // Anti-vacuity: the scan found the configs that actually build and ship the app.
    for (const must of ["Dockerfile", "fly.toml", "fly.stg.toml", ".github/workflows/prod.yml", ".github/workflows/stg.yml"]) {
      expect(names, `the scan covers ${must}`).toContain(must);
    }
    const offenders = files.filter((p) => readFileSync(p, "utf8").includes(SETTLED_POLL_MS_ENV_VAR)).map(rel);
    expect(offenders, `${files.length} deploy configs scanned; none may set the e2e interval`).toEqual([]);
  });

  it("every e2e.yml job that runs Playwright sets it at JOB level, to a value the clamp takes and shorter than what ships", () => {
    const lines = readFileSync(join(WORKFLOWS, "e2e.yml"), "utf8").split("\n");
    const jobsAt = lines.findIndex((l) => l === "jobs:");
    expect(jobsAt, "e2e.yml has a jobs: block").toBeGreaterThanOrEqual(0);
    const jobs: { name: string; body: string[] }[] = [];
    for (const line of lines.slice(jobsAt + 1)) {
      const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
      if (header) jobs.push({ name: header[1]!, body: [] });
      else if (/^\S/.test(line)) break; // a later top-level key ends the jobs block
      else jobs.at(-1)?.body.push(line);
    }
    const playwrightJobs = jobs.filter((j) => j.body.some((l) => /^\s+run:.*playwright test/.test(l)));
    expect(playwrightJobs.length, "anti-vacuity: e2e.yml has Playwright jobs").toBeGreaterThan(0);
    for (const job of playwrightJobs) {
      // The JOB-level env block: `    env:` at four spaces, its entries at six, until the indent drops back.
      const envAt = job.body.findIndex((l) => l === "    env:");
      expect(envAt, `${job.name}: has a job-level env block`).toBeGreaterThanOrEqual(0);
      const env: string[] = [];
      for (const l of job.body.slice(envAt + 1)) {
        if (l.trim() === "" || /^ {6}#/.test(l)) continue;
        if (!/^ {6}\S/.test(l)) break;
        env.push(l);
      }
      const entry = env.map((l) => new RegExp(`^ {6}${SETTLED_POLL_MS_ENV_VAR}: "([^"]*)"$`).exec(l)).find(Boolean);
      expect(entry, `${job.name}: sets ${SETTLED_POLL_MS_ENV_VAR} in its job-level env`).toBeTruthy();
      const raw = entry![1]!;
      expect(resolveSettledPollMs(raw), `${job.name}: "${raw}" is taken by the clamp, not a silent fallback`).toBe(Number(raw));
      expect(Number(raw), `${job.name}: shorter than the shipped interval, or it buys nothing`).toBeLessThan(DEFAULT_SETTLED_POLL_MS);
    }
  });
});
