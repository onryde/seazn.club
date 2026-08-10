// A DB-gated suite outside src/server / src/lib / src/app runs in NO CI job.
//
// Two jobs could run it and neither does by default. The `test` job has no
// DATABASE_URL, so `describe.skipIf(!HAS_DB)` skips there and the job goes
// green. The `smoke` job has Postgres, but selects its files by PATH — one step
// takes `src/server src/lib`, another takes `src/app`. A DB-gated suite
// anywhere else is therefore selected by nothing and skipped by everything,
// which reports as neither a pass nor a failure but as silence.
//
// Found 2026-08-10 with two suites in exactly that state:
// upgrade-gate-pass-features.test.ts (src/components) and the ai-templates
// seeds.test.ts (src/demo). Both are now named file-by-file in a smoke step;
// this guard is what stops the third one going unnoticed.
//
// Same shape and same reasoning as the sibling redis-suite-ci-wiring.test.ts,
// which owns the *.redis.test.ts family — those are excluded here so the two
// guards cannot both claim the same file and disagree about it.
//
// Pure: no DB, no network. It runs in every job and can never self-skip, which
// is the property that makes it worth having at all.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** apps/web/src — this file lives at apps/web/src/lib/__tests__/. */
const SRC = resolve(import.meta.dirname, "../..");
/** Repo root: up out of __tests__ / lib / src / web / apps. */
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CI_YML = join(REPO_ROOT, ".github/workflows/ci.yml");

/** The trees the smoke job already selects wholesale, by path. */
const COVERED_BY_PATH = ["src/server/", "src/lib/", "src/app/"];

/**
 * A suite is DB-gated when it wraps its body in `describe.skipIf(!HAS_DB)`.
 *
 * Merely MENTIONING DATABASE_URL is not the test, and getting that wrong in
 * the lax direction is what makes a guard like this useless. `capture.test.ts`
 * and `drift.test.ts` under src/demo both name DATABASE_URL in prose and in
 * code, and both deliberately do NOT skip without it — their own comments say
 * "a guard that skips is not one". They run correctly in the unit job today,
 * and demanding a Postgres step for them would be wrong.
 */
const isDbGated = (text: string) => /describe\.skipIf\(\s*!HAS_DB\s*\)/.test(text);

/** Every DB-gated suite under apps/web/src that no path selection covers. */
function orphanCandidates(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.test\.tsx?$/.test(p))
    // The redis family has its own guard, with a stricter per-step rule.
    .filter((p) => !p.endsWith(".redis.test.ts"))
    .map((p) => `src/${p}`)
    .filter((p) => !COVERED_BY_PATH.some((tree) => p.startsWith(tree)))
    .filter((p) => isDbGated(readFileSync(join(REPO_ROOT, "apps/web", p), "utf8")))
    .sort();
}

/**
 * ci.yml with its COMMENTS removed — load-bearing for the same reason the
 * redis guard strips them: the workflow's own prose names these very files
 * (the block above the new step names both), so a raw substring search over
 * the file would be satisfied by the commentary. Delete the `run:` line and
 * the guard would stay green — precisely the failure it exists to catch.
 *
 * YAML's actual comment rule (`#` at line start or after whitespace), so a
 * `#` inside a quoted command survives.
 */
const stripComments = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

const ciExecutableText = () => stripComments(readFileSync(CI_YML, "utf8"));

/**
 * Comment-stripped ci.yml split into one block per job.
 *
 * Needed because "ci.yml names the file somewhere" is too weak: wiring a
 * DB-gated suite into a step of the `test` job would satisfy it while the
 * suite still self-skips for want of DATABASE_URL — the exact silence this
 * guard exists to break. Correlating against the enclosing job's text asks
 * the question that actually matters: does the job running this file have a
 * database?
 *
 * A job is a two-space-indented key under `jobs:`; its body runs to the next
 * such key.
 */
function jobBlocks(text: string): Record<string, string> {
  const lines = text.split("\n");
  const out: Record<string, string> = {};
  let current: string | null = null;
  let started = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      current = header[1];
      out[current] = "";
      continue;
    }
    if (current) out[current] += line + "\n";
  }
  return out;
}

const jobHasDatabaseUrl = (block: string) => /(^|\n)\s*DATABASE_URL:/.test(block);

describe("DB-gated suites outside the path-selected trees are wired into CI", () => {
  it("finds the ci.yml this guard reads", () => {
    expect(readFileSync(CI_YML, "utf8").length).toBeGreaterThan(0);
  });

  it("splits ci.yml into jobs, and at least one of them has a database", () => {
    // Vacuity guard on the reader itself. If jobBlocks silently returned {},
    // every `some(...)` below would be false and the assertions would report
    // orphans that are in fact wired — a false RED — while a `[]`-returning
    // candidate walk would give the opposite. Both halves are pinned.
    const jobs = jobBlocks(ciExecutableText());
    expect(Object.keys(jobs).length).toBeGreaterThan(2);
    expect(Object.values(jobs).filter(jobHasDatabaseUrl).length).toBeGreaterThan(0);
  });

  it("recognises the two suites this guard was written for", () => {
    // Pins the DETECTOR, not the wiring. If `isDbGated` ever stopped matching
    // the repo's convention, `orphanCandidates()` would return [] and the real
    // assertion below would pass for ever against an empty set.
    const found = orphanCandidates();
    expect(found).toContain("src/components/__tests__/upgrade-gate-pass-features.test.ts");
    expect(found).toContain("src/demo/ai-templates/__capture__/__tests__/seeds.test.ts");
  });

  it("does not mistake a suite that merely mentions DATABASE_URL for a gated one", () => {
    // The lax direction of the detector, on a literal fixture rather than on
    // today's files. A guard that flagged these would demand Postgres steps
    // for suites that correctly run without one.
    expect(isDbGated('const HAS_DB = !!process.env.DATABASE_URL;\ndescribe("x", () => {})')).toBe(
      false,
    );
    expect(isDbGated("describe.skipIf(!HAS_DB)('x', () => {})")).toBe(true);
    // The redis family's own form is matched too — which is why they are
    // filtered out by NAME above rather than by this predicate.
    expect(isDbGated("describe.skipIf(!HAS_DB || !HAS_REDIS)('x', () => {})")).toBe(false);
  });

  it("runs every such suite in a job that actually has a database", () => {
    const jobs = Object.values(jobBlocks(ciExecutableText()));
    const unwired = orphanCandidates().filter((p) => {
      const name = basename(p);
      return !jobs.some((b) => b.includes(name) && jobHasDatabaseUrl(b));
    });
    expect(
      unwired,
      `DB-gated but run by no Postgres job — add them to a smoke step by NAME ` +
        `(not by adding their whole tree as a path): ${unwired.join(", ")}`,
    ).toEqual([]);
  });

  it("catches a suite named only in the DB-less unit job", () => {
    // The false-negative a plain "ci.yml mentions the file" check would allow,
    // reproduced on a fixture so it asserts the RULE rather than today's file.
    const fixture = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm test -- src/components/__tests__/decoy.test.ts",
      "  smoke:",
      "    env:",
      "      DATABASE_URL: postgres://localhost/x",
      "    steps:",
      "      - run: npm test -- src/server src/lib",
    ].join("\n");
    const jobs = Object.values(jobBlocks(fixture));

    // The weak check is satisfied — the filename is right there in the file.
    expect(fixture).toContain("decoy.test.ts");
    // The real one is not: the only job naming it has no database.
    expect(jobs.some((b) => b.includes("decoy.test.ts") && jobHasDatabaseUrl(b))).toBe(false);
  });
});
