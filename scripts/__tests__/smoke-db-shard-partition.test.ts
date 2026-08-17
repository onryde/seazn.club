// ci.yml splits src/server + src/lib across two jobs — `smoke-db` and
// `smoke-db-usecases` — by giving each an exclude-glob covering the OTHER's half
// of src/server/usecases/__tests__. That split is only safe while the two globs
// stay exhaustive (no file runs in neither job) and disjoint (no file runs in
// both). Neither property is visible from reading either job alone, and a file
// that runs in NEITHER is exactly the silent-coverage-loss failure the #339
// collection reconciliation exists to prevent — except the reconciliation cannot
// see it here, because each job reconciles only its own narrowed listing.
//
// So this test is the thing that sees it. It derives BOTH globs from ci.yml
// rather than restating them, because a copy here would drift from the workflow
// and then prove a partition nobody runs.
//
// Concretely: the globs are `[a-h]*` and `[i-z]*`, so a new usecases test named
// with a leading digit, an underscore or a capital would fall into BOTH halves
// (each glob excludes only the other's letter range, so neither excludes it) and
// run twice against two databases. Today zero files do. This is what fails when
// the first one appears.
//
// Why the split is cut with --exclude rather than --shard, which would need no
// globs and rebalance itself: vitest 4.1.9 honours `vitest run --shard` but
// SILENTLY IGNORES `vitest list --shard` (verified: 247 files for 1/2, for 2/2,
// and unsharded), and the reconciliation is built on `vitest list`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from THIS FILE, not cwd: a cwd-relative root reads whichever checkout
// the runner happens to sit in. In a worktree that is a different tree entirely,
// and the test would pass or fail on the wrong ci.yml.
const REPO_ROOT = join(import.meta.dirname, "../..");
const CI_YML = join(REPO_ROOT, ".github/workflows/ci.yml");

/**
 * Every `USECASES_EXCLUDE:` value in ci.yml, in file order.
 *
 * Regex rather than a YAML parse because no YAML library is a declared root
 * dependency, and toolchain.test.ts enforces that every dependency scripts/
 * imports is declared. The repo's other workflow-reading guards (toolchain,
 * db-suite-ci-wiring, z3-retirement-drift) all read the raw text the same way.
 */
const excludeGlobs = (): string[] => {
  const text = readFileSync(CI_YML, "utf8");
  return [...text.matchAll(/^\s*USECASES_EXCLUDE:\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
};

/** `vitest list --filesOnly` for these paths, narrowed by these globs. */
const listed = (paths: string[], excludes: string[]): Set<string> => {
  const args = [
    "vitest",
    "list",
    "--filesOnly",
    ...excludes.flatMap((g) => ["--exclude", g]),
    ...paths,
  ];
  const out = execFileSync("npx", args, {
    cwd: join(REPO_ROOT, "apps/web"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(l))
      .map((l) => l.replace(/^.*?(apps\/web\/)?src\//, "src/")),
  );
};

describe("ci.yml's smoke-db / smoke-db-usecases partition", () => {
  it("declares exactly two exclude globs, one per job", () => {
    // Pins the shape the rest of this file assumes. A third job (or a deleted
    // one) must come here and decide what the invariant means before the
    // set-comparisons below silently start proving something narrower.
    expect(excludeGlobs()).toHaveLength(2);
  });

  it("splits src/server + src/lib exhaustively and disjointly", () => {
    const [smokeDb, usecases] = excludeGlobs();

    // Exactly the paths each job passes to vitest.
    const a = listed(["src/server", "src/lib"], [smokeDb]);
    const b = listed(["src/server/usecases"], [usecases]);
    const full = listed(["src/server", "src/lib"], []);

    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);

    const both = [...a].filter((f) => b.has(f)).sort();
    const neither = [...full].filter((f) => !a.has(f) && !b.has(f)).sort();

    expect(
      both,
      `these files run in BOTH jobs, against two different databases:\n  ${both.join("\n  ")}`,
    ).toEqual([]);
    expect(
      neither,
      `these files run in NEITHER job — silent coverage loss:\n  ${neither.join("\n  ")}`,
    ).toEqual([]);

    // Exhaustive AND disjoint together mean the halves partition the whole. The
    // size identity is asserted separately so a failure says which property
    // broke rather than just "sets differ".
    expect(a.size + b.size).toBe(full.size);
  });

  it("keeps the halves close enough in size that the split still buys wall clock", () => {
    // A count check, not a timing one — CI wall clock is not measurable from a
    // unit test. It exists because the h/i boundary was chosen from measured
    // per-file times (113.8s vs 111.6s) and drifts as files are added: 239
    // usecases files today. A 70/30 file split means the boundary needs
    // recomputing from a real run before the slower half becomes the new floor.
    //
    // Deliberately loose. This must not fail on ordinary growth — it is a
    // tripwire for lopsidedness, not a balance gate.
    const [smokeDb, usecases] = excludeGlobs();
    const uc = listed(["src/server/usecases"], []).size;
    const mine = listed(["src/server/usecases"], [usecases]).size;
    const theirs = listed(["src/server/usecases"], [smokeDb]).size;

    expect(mine + theirs).toBe(uc);
    const ratio = Math.max(mine, theirs) / uc;
    expect(
      ratio,
      `usecases splits ${theirs}/${mine} of ${uc} files. Recompute the boundary letter from a real run's per-file times.`,
    ).toBeLessThan(0.68);
  });
});
