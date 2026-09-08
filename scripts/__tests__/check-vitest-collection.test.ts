// Guards the `--exclude` passthrough in check-vitest-collection.ts.
//
// ci.yml splits src/server + src/lib across smoke-db and smoke-db-usecases by
// excluding complementary halves of src/server/usecases/__tests__. Each job then
// reconciles its OWN half, which only works if the reconciliation narrows the
// `vitest list` oracle by the same glob the run was narrowed by. Without the
// passthrough every file the other job owns is reported as "listed but not run",
// so a correct run goes red — and a gate that reds on correct runs gets deleted
// rather than fixed. These tests are what stop the passthrough being dropped as
// an unused-looking flag.
//
// Exercises the real script against a real path (src/server/public-site) rather
// than injecting a fake listing: a seam bypassing `vitest list` would leave
// the production path — the one that shells out — untested, and a list on this
// path costs ~0.6s, so there is nothing to buy.
//
// The partition itself (exhaustive, disjoint) is guarded separately by
// smoke-db-shard-partition.test.ts. This file only proves the flag is wired.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from THIS FILE, not cwd: a cwd-relative root reads whichever checkout
// the runner happens to sit in, which in a worktree is a different tree.
const REPO_ROOT = join(import.meta.dirname, "../..");
const SCRIPT = "scripts/check-vitest-collection.ts";

// The files `vitest list --filesOnly src/server/public-site` selects, and the
// one a `c*` glob removes. Named explicitly so that adding or removing a file
// in that directory fails loudly rather than quietly changing what is proven.
const CONSENT = "src/server/public-site/__tests__/consent.test.ts";
const REST = [
  // P9: added with the public court/venue-name coverage. This list is
  // deliberately explicit so a new file in that directory fails HERE rather
  // than quietly changing what the gate proves — which is exactly what
  // happened, and is the list working.
  "src/server/public-site/__tests__/data-court-venue-names.test.ts",
  "src/server/public-site/__tests__/pass-scope-public-realtime.test.ts",
  "src/server/public-site/__tests__/player-stats-public.test.ts",
  "src/server/public-site/__tests__/revalidate.test.ts",
  // Spectator W1: the match-centre document and the two panels folded from the
  // ledger. Same story as P9 — this gate reddened the moment they landed, which
  // is the explicit list doing its job.
  "src/server/public-site/__tests__/match-centre.test.ts",
  "src/server/public-site/__tests__/match-centre-dictionary.test.ts",
  "src/server/public-site/__tests__/match-centre-parity.test.ts",
  "src/server/public-site/__tests__/public-lineups.test.ts",
  "src/server/public-site/__tests__/timeline.test.ts",
];
const EXCLUDE_C = "**/public-site/__tests__/c*";

// Derived from REST, never typed twice. The counts are not what this file
// proves — the `excluding` line, the two drift reports and the exit status are —
// but a hand-copied literal beside a list that grows means every new file in
// that directory reds this gate TWICE: once at the list (intended) and once at
// a number that has no independent meaning (pure toil). `+ 1` is CONSENT, the
// single file `c*` removes.
const NARROWED = `listed=${REST.length} executed=${REST.length}`;
const UNNARROWED = `listed=${REST.length + 1} executed=${REST.length}`;

const dir = mkdtempSync(join(tmpdir(), "collection-exclude-test-"));

/** A minimal vitest JSON reporter payload naming exactly these files. */
const resultsFile = (label: string, files: string[]): string => {
  const p = join(dir, `${label}.json`);
  writeFileSync(p, JSON.stringify({ testResults: files.map((name) => ({ name })) }));
  return p;
};

const run = (args: string[]): { status: number; output: string } => {
  try {
    const output = execFileSync("node", ["--experimental-strip-types", SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

describe("check-vitest-collection --exclude", () => {
  it("narrows the listing so a partial run reconciles clean", () => {
    const results = resultsFile("narrowed", REST);
    const { status, output } = run([
      "--results", results, "--exclude", EXCLUDE_C, "--", "src/server/public-site",
    ]);
    expect(output).toContain(NARROWED);
    expect(output).toContain(`excluding ${EXCLUDE_C}`);
    expect(status).toBe(0);
  });

  it("without the flag, that SAME run is a failure — so the flag is load-bearing", () => {
    // The negative control. If this ever passes, the passthrough has stopped
    // mattering and the two-job split is no longer being reconciled per half.
    const results = resultsFile("unnarrowed", REST);
    const { status, output } = run(["--results", results, "--", "src/server/public-site"]);
    expect(output).toContain(UNNARROWED);
    expect(output).toContain("LISTED BUT NOT RUN (1)");
    expect(output).toContain(CONSENT);
    expect(status).toBe(1);
  });

  it("still catches a file that ran but was excluded from the listing", () => {
    // The gate must stay two-sided. Excluding a file from the listing while the
    // run executed it anyway is the mirror-image drift — the globs said one half
    // and the run did something else — and must not read as clean.
    const results = resultsFile("over-ran", [CONSENT, ...REST]);
    const { status, output } = run([
      "--results", results, "--exclude", EXCLUDE_C, "--", "src/server/public-site",
    ]);
    expect(output).toContain("RAN BUT NOT LISTED (1)");
    expect(output).toContain(CONSENT);
    expect(status).toBe(1);
  });

  it("ignores an empty --exclude instead of forwarding it", () => {
    // An unset shell variable reaches the script as `--exclude ''`. Forwarded,
    // that matches nothing and silently widens the listing back to the full set
    // while the command line still LOOKS narrowed — the same green-for-the-wrong-
    // reason this whole file exists to prevent. Dropped, the caller gets the
    // honest unnarrowed failure below.
    const results = resultsFile("empty-glob", REST);
    const { status, output } = run([
      "--results", results, "--exclude", "", "--", "src/server/public-site",
    ]);
    expect(output).toContain(UNNARROWED);
    expect(output).not.toContain("excluding");
    expect(status).toBe(1);
  });
});
