// ci.yml splits src/server + src/lib across several DB jobs (four today:
// smoke-db, smoke-db-app, smoke-db-outliers, smoke-db-usecases) by giving each
// an exclude-glob, USECASES_EXCLUDE, that drops every src/server/usecases test
// outside that job's own first-letter range. That split is only safe while the
// globs stay exhaustive (no file runs in no job) and disjoint (no file runs in
// two). Neither property is visible from reading any one job, and a file that
// runs in NO job is exactly the silent-coverage-loss failure the #339
// collection reconciliation exists to prevent — except the reconciliation
// cannot see it here, because each job reconciles only its own narrowed
// listing.
//
// So this test is the thing that sees it. It derives every glob, AND the paths
// each job hands vitest, from ci.yml rather than restating them, because a copy
// here would drift from the workflow and then prove a partition nobody runs.
//
// Concretely: each glob is a negated class, `[!a-d]*.test.*` — "every usecases
// test whose name does not start with my letters". A new usecases test named
// with a leading digit, capital or underscore matches EVERY job's glob, so it
// runs in NONE. Today zero do. This is what fails when the first one appears;
// the opposite mistake (two jobs claiming a letter) fails it too.
//
// Why the split is cut with --exclude rather than --shard, which would need no
// globs and rebalance itself: vitest 4.1.9 honours `vitest run --shard` but
// SILENTLY IGNORES `vitest list --shard` (verified: 247 files for 1/2, for 2/2,
// and unsharded), and the reconciliation is built on `vitest list`.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Resolved from THIS FILE, not cwd: a cwd-relative root reads whichever checkout
// the runner happens to sit in. In a worktree that is a different tree entirely,
// and the test would pass or fail on the wrong ci.yml.
const REPO_ROOT = join(import.meta.dirname, "../..");
const CI_YML = join(REPO_ROOT, ".github/workflows/ci.yml");
const USECASES = "src/server/usecases/";

interface DbJob {
  id: string;
  /** The job's USECASES_EXCLUDE value. */
  glob: string;
  /** The positional paths of the ONE run step that passes `--exclude "$USECASES_EXCLUDE"`. */
  runPaths: string[];
  /** The paths after `--` of the reconciliation call that passes the same exclude. */
  reconciledPaths: string[];
}

/**
 * Every job in ci.yml that declares USECASES_EXCLUDE, with what it runs.
 *
 * Regex rather than a YAML parse because no YAML library is a declared root
 * dependency, and toolchain.test.ts enforces that every dependency scripts/
 * imports is declared. The repo's other workflow-reading guards (toolchain and
 * db-suite-ci-wiring among them) all read the raw text the same way. Job keys
 * sit at exactly two spaces under `jobs:`; comment lines are dropped first so
 * prose that quotes a command cannot be mistaken for one.
 */
const dbJobs = (): DbJob[] => {
  const text = readFileSync(CI_YML, "utf8");
  const body = text.slice(text.indexOf("\njobs:"));
  const blocks = body.split(/\n(?= {2}[A-Za-z][\w-]*:\s*\n)/).slice(1);
  const jobs: DbJob[] = [];
  for (const block of blocks) {
    const id = /^ {2}([A-Za-z][\w-]*):/.exec(block)![1];
    const live = block
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n")
      // run: lines continue with a trailing backslash in the reconciliation
      .replace(/\\\n\s*/g, " ");
    const globs = [...live.matchAll(/^\s*USECASES_EXCLUDE:\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
    if (globs.length === 0) continue;
    expect(globs, `${id}: declares USECASES_EXCLUDE once`).toHaveLength(1);

    const runs = [...live.matchAll(/npm test --workspace apps\/web -- .*?--exclude "\$USECASES_EXCLUDE" ([^\n]+)$/gm)];
    expect(runs, `${id}: exactly one vitest run narrowed by USECASES_EXCLUDE`).toHaveLength(1);
    const recon = [
      ...live.matchAll(/check-vitest-collection\.ts .*?--exclude "\$USECASES_EXCLUDE" -- ([^\n]+)$/gm),
    ];
    expect(recon, `${id}: exactly one reconciliation narrowed by USECASES_EXCLUDE`).toHaveLength(1);

    const words = (s: string) => s.trim().split(/\s+/);
    jobs.push({ id, glob: globs[0], runPaths: words(runs[0][1]), reconciledPaths: words(recon[0][1]) });
  }
  return jobs;
};

/**
 * `vitest list --filesOnly` for these paths, narrowed by these globs.
 *
 * Read the timeout situation before touching this file. These tests run in
 * ci.yml's "Repo-root scripts tests" step, which invokes the root vitest binary
 * from the REPO ROOT — where, as that step's own comment records, no
 * vitest.config.* is discovered. So no repo-wide `testTimeout` convention is in
 * force and vitest's 5s DEFAULT applies, not apps/web's 30s, while a single
 * `vitest list` spawn costs ~1-3s locally and more on a runner sharing four
 * cores with a Postgres and a Redis container.
 *
 * THE FIX IS THE `--testTimeout=30000` IN ci.yml, not anything here. It lives in
 * the workflow rather than as an inline `{ timeout }` because an inline value
 * silently overrides whatever the caller passes — the defect behind #363, where
 * someone hits a CI timeout, passes the flag, watches it fail identically, and
 * concludes the test hangs.
 *
 * What IS here: the listings are spawned CONCURRENTLY and memoised, so with
 * four jobs the partition test costs one listing's wall time plus contention
 * (five spawns), not five in series, and the balance test reuses them all.
 */
const listCache = new Map<string, Promise<Set<string>>>();
const run = promisify(execFile);
const listed = (paths: string[], excludes: string[]): Promise<Set<string>> => {
  const key = JSON.stringify([paths, excludes]);
  const hit = listCache.get(key);
  if (hit) return hit;
  const args = ["vitest", "list", "--filesOnly", ...excludes.flatMap((g) => ["--exclude", g]), ...paths];
  const p = run("npx", args, {
    cwd: join(REPO_ROOT, "apps/web"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).then(
    ({ stdout }) =>
      new Set(
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(l))
          .map((l) => l.replace(/^.*?(apps\/web\/)?src\//, "src/")),
      ),
  );
  listCache.set(key, p);
  return p;
};

/** Each job's listing, keyed by job id, plus the un-narrowed listing of every path any job runs. */
const partition = async () => {
  const jobs = dbJobs();
  const universePaths = [...new Set(jobs.flatMap((j) => j.runPaths))].sort();
  const [full, ...perJob] = await Promise.all([
    listed(universePaths, []),
    ...jobs.map((j) => listed(j.runPaths, [j.glob])),
  ]);
  return { jobs, universePaths, full, perJob };
};

describe("ci.yml's DB-job partition of src/server + src/lib", () => {
  it("finds at least two DB jobs, each narrowing ONE run and ITS reconciliation by its own glob", () => {
    // Shape first, so the set comparisons below cannot quietly prove something
    // narrower: every job that declares a glob uses it in exactly one run, and
    // reconciles exactly the paths it ran (a reconciliation over other paths
    // would "pass" a run that dropped a tree).
    const jobs = dbJobs();
    expect(jobs.length, `DB jobs found: ${jobs.map((j) => j.id).join(", ")}`).toBeGreaterThanOrEqual(2);
    for (const j of jobs) {
      expect(j.reconciledPaths, `${j.id}: reconciles the paths it ran`).toEqual(j.runPaths);
      expect(j.glob, `${j.id}: the .test.* anchor (a bare letter glob prunes whole DIRECTORIES)`).toMatch(
        /\*\.test\.\*$/,
      );
    }
    // The universe is src/server + src/lib: the paths the split was made over.
    expect([...new Set(jobs.flatMap((j) => j.runPaths))].sort()).toEqual(["src/lib", "src/server", "src/server/usecases"]);
  });

  it("puts every file under src/server + src/lib in exactly one DB job", async () => {
    const { jobs, full, perJob } = await partition();

    // Anti-vacuity: an empty listing would make every comparison below pass.
    expect(full.size, "files under src/server + src/lib").toBeGreaterThan(0);
    perJob.forEach((s, i) => expect(s.size, `${jobs[i].id}: files listed`).toBeGreaterThan(0));

    const owners = new Map<string, string[]>();
    for (const f of full) owners.set(f, []);
    perJob.forEach((s, i) => {
      for (const f of s) owners.set(f, [...(owners.get(f) ?? []), jobs[i].id]);
    });
    const twice = [...owners].filter(([, o]) => o.length > 1).map(([f, o]) => `${f}  (${o.join(", ")})`).sort();
    const nowhere = [...owners].filter(([, o]) => o.length === 0).map(([f]) => f).sort();
    const stray = [...owners.keys()].filter((f) => !full.has(f)).sort();

    expect(twice, `these files run in TWO OR MORE jobs, against different databases:\n  ${twice.join("\n  ")}`).toEqual(
      [],
    );
    expect(nowhere, `these files run in NO job — silent coverage loss:\n  ${nowhere.join("\n  ")}`).toEqual([]);
    expect(stray, `listed by a job but not under the paths any job runs:\n  ${stray.join("\n  ")}`).toEqual([]);

    // Exhaustive AND disjoint together mean the shares partition the whole. The
    // size identity is asserted separately so a failure says which property
    // broke rather than just "sets differ".
    const checked = perJob.reduce((n, s) => n + s.size, 0);
    expect(checked, `${checked} files across ${jobs.length} jobs vs ${full.size} in the tree`).toBe(full.size);
  });

  it("gives every DB job a share of usecases, none so lopsided that the split stops buying wall clock", async () => {
    // A count check, not a timing one — CI wall clock is not measurable from a
    // unit test, and the shares are uneven ON PURPOSE (smoke-db also carries
    // src/lib and the rest of src/server, smoke-db-app also carries src/app).
    // The letters were picked from file counts weighted by a measured per-file
    // cost (ci.yml, header above smoke-db); the jobs now upload per-file timings
    // so the next move can use real ones.
    //
    // Deliberately loose. This must not fail on ordinary growth — it is a
    // tripwire for one job swallowing the work (a boundary typo, a deleted
    // job), not a balance gate. Its bound is 1.5x an even share.
    const { jobs, full, perJob } = await partition();
    const uc = [...full].filter((f) => f.startsWith(USECASES)).length;
    expect(uc, "usecases test files").toBeGreaterThan(0);
    const shares = perJob.map((s) => [...s].filter((f) => f.startsWith(USECASES)).length);
    expect(shares.reduce((a, b) => a + b, 0), "usecases files summed over the jobs").toBe(uc);

    const even = uc / jobs.length;
    jobs.forEach((j, i) => {
      expect(shares[i], `${j.id}: usecases files`).toBeGreaterThan(0);
      expect(
        shares[i],
        `${j.id} runs ${shares[i]} of ${uc} usecases files (even share ${even.toFixed(1)}). Recompute the boundary letters from a real run's per-file times (the DB jobs' vitest-results artifacts).`,
      ).toBeLessThan(even * 1.5);
    });
  });
});
