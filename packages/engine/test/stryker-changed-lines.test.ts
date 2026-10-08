// W2a Task 0b: changed-lines Stryker. STRYKER_MUTATE="<src path>:<a>-<b>[,…]" makes stryker.config.mjs mutate exactly those
// ranges (perTest, never incremental, its own report), so an engine task mutates the lines it changed in minutes, not in a
// family leg's hours. With STRYKER_MUTATE unset the config is the one the weekly legs, their floors and fingerprints were
// measured with, for every group. No test here reads git history: CI's engine job is a shallow clone with no origin/main,
// and after the merge the merge base would be HEAD itself, comparing the file with itself (preflight C4).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMutateRanges, rangesFromDiff, rangesFromUntracked, snapshotForm, verdictsFromReport } from "../scripts/stryker-changed.mjs";
import { resolveGroup } from "../scripts/stryker-cuts.mjs";
import { STRYKER_GROUPS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(import.meta.dirname, "..");
// The group configs as they were BEFORE Task 0b's edit, written once by `node scripts/stryker-changed.mjs --snapshot` from the
// unedited config and committed. It is regenerated only as a reviewed, deliberate config change, and the commit says so.
const SNAPSHOT = JSON.parse(readFileSync(resolve(import.meta.dirname, "stryker-config-groups.snap.json"), "utf8")) as Record<string, string>;
/** A child's env: neither variable leaks in from the shell that runs the suite. */
const childEnv = (env: Record<string, string | undefined>) => ({ ...process.env, STRYKER_GROUP: undefined, STRYKER_MUTATE: undefined, ...env });

/** The config a child process sees for `env`, as Stryker loads it (a plain node process; the config reads env at import). */
function configUnder(env: Record<string, string | undefined>): string {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const c = (await import("./stryker.config.mjs")).default; process.stdout.write(JSON.stringify(c));`], {
    cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: childEnv(env),
  });
  if (r.status !== 0) throw new Error(r.stderr || `status ${r.status}, signal ${r.signal}`);
  return r.stdout;
}

/** Every group's config in snapshot form NOW, by the same command that wrote the committed snapshot (one child process). */
function groupConfigsNow(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "stryker-changed-"));
  try {
    const out = join(dir, "groups.json");
    const r = spawnSync(process.execPath, ["scripts/stryker-changed.mjs", "--snapshot", out], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: childEnv({}) });
    if (r.status !== 0) throw new Error(r.stderr || `status ${r.status}, signal ${r.signal}`);
    return JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("changed-lines Stryker (W2a Task 0b)", () => {
  it("empty case first: STRYKER_MUTATE set but empty is refused, never a run that mutates nothing", () => {
    expect(() => parseMutateRanges("", ENGINE)).toThrow(/names no range/);
    expect(() => parseMutateRanges(" , ,", ENGINE)).toThrow(/names no range/);
    expect(() => configUnder({ STRYKER_MUTATE: "" })).toThrow(/names no range/);
  }, spawnBudget(1));

  it("parses ranges exactly, and refuses a missing file, a reversed range, a path outside src/ and a test file", () => {
    expect(parseMutateRanges("src/core/events.ts:10-20,src/core/types.ts:5-5", ENGINE)).toEqual(["src/core/events.ts:10-20", "src/core/types.ts:5-5"]);
    expect(() => parseMutateRanges("src/core/nope.ts:1-2", ENGINE)).toThrow(/does not exist/);
    expect(() => parseMutateRanges("src/core/events.ts:20-10", ENGINE)).toThrow(/reversed/);
    expect(() => parseMutateRanges("src/core/events.ts:0-3", ENGINE)).toThrow(/before line 1/);
    expect(() => parseMutateRanges("test/rules-reference.ts:1-2", ENGINE)).toThrow(/outside src/);
    expect(() => parseMutateRanges("src/core/events.test.ts:1-2", ENGINE)).toThrow(/test file/);
    expect(() => parseMutateRanges("src/core/events.ts", ENGINE)).toThrow(/is not <src path>:<a>-<b>/);
  });

  it("with STRYKER_MUTATE the run is 'changed': exactly those ranges, not incremental, its own report — even with STRYKER_GROUP also set", () => {
    let checked = 0;
    for (const env of [{ STRYKER_MUTATE: "src/core/events.ts:10-20" }, { STRYKER_MUTATE: "src/core/events.ts:10-20", STRYKER_GROUP: "core-1" }]) {
      const c = JSON.parse(configUnder(env));
      expect(c.mutate, JSON.stringify(env)).toEqual(["src/core/events.ts:10-20"]);
      expect(c.incremental, JSON.stringify(env)).toBe(false);
      expect(c.jsonReporter, JSON.stringify(env)).toEqual({ fileName: "reports/mutation/changed.json" });
      expect(c.coverageAnalysis, JSON.stringify(env)).toBe("perTest");
      checked++;
    }
    expect(checked).toBe(2);
  }, spawnBudget(2));

  it("with STRYKER_MUTATE unset the config equals the pre-0b snapshot, for EVERY group", () => {
    const groups = Object.keys(STRYKER_GROUPS);
    // A group added or dropped since the snapshot (a recut, a new leg) is a finding, never a silent pass: a deliberate config
    // change regenerates the snapshot with `node scripts/stryker-changed.mjs --snapshot test/stryker-config-groups.snap.json`
    // and its commit says so.
    expect(Object.keys(SNAPSHOT).sort(), "the snapshot's groups are the groups").toEqual([...groups].sort());
    const now = groupConfigsNow();
    let checked = 0;
    for (const g of groups) {
      expect(now[g], `${g}: the config with STRYKER_MUTATE unset is not the snapshot's`).toBe(SNAPSHOT[g]);
      checked++;
    }
    expect(checked).toBe(groups.length);
    expect(checked).toBeGreaterThan(0);
  }, spawnBudget(1));

  it("the snapshot stands in for exactly two values (a split file's line ranges, this machine's concurrency), and only when they equal what produced them", () => {
    // sports-other-1 is boardgame.ts part 1: its `file:a-b` range moves with any edit to boardgame.ts, and the concurrency
    // follows the machine's cores and memory, so neither can be held byte-for-byte across later engine tasks and CI's runner.
    const g = "sports-other-1";
    const resolved = resolveGroup(g);
    expect(resolved.some((e) => /:\d+-\d+$/.test(e)), "the group resolves a split file to a line range").toBe(true);
    const machine = strykerConcurrency({ cores: availableParallelism(), memBytes: totalmem(), workersPerSandbox: STRYKER_VITEST_WORKERS });
    expect(JSON.stringify(snapshotForm({ testRunner: "vitest", mutate: resolved, concurrency: machine, tempDirName: ".stryker-tmp" }, g, ENGINE)))
      .toBe(JSON.stringify({ testRunner: "vitest", mutate: `<resolveGroup(${g})>`, concurrency: "<strykerConcurrency(this machine)>", tempDirName: ".stryker-tmp" }));
    // anything else is kept as it is, so the comparison with the snapshot sees it
    const other = snapshotForm({ mutate: ["src/core/events.ts:10-20"], concurrency: machine + 1 }, g, ENGINE);
    expect(other).toEqual({ mutate: ["src/core/events.ts:10-20"], concurrency: machine + 1 });
    // another group's list is not this group's
    expect(snapshotForm({ mutate: resolveGroup("core-1"), concurrency: machine }, g, ENGINE).mutate).toEqual(resolveGroup("core-1"));
    // and a config with neither key gains neither
    expect(snapshotForm({ testRunner: "vitest" }, g, ENGINE)).toEqual({ testRunner: "vitest" });
  });

  it("rangesFromUntracked: a NEW src file (untracked, so absent from git diff) is mutated whole; test files never", () => {
    expect(rangesFromUntracked([{ path: "src/core/level.ts", lines: 12 }, { path: "src/core/level.test.ts", lines: 40 }])).toEqual(["src/core/level.ts:1-12"]);
    expect(rangesFromUntracked([{ path: "src/core/empty.ts", lines: 0 }])).toEqual([]);
    expect(rangesFromUntracked([])).toEqual([]);
  });

  it("rangesFromDiff: added and changed lines of non-test src files only; a deletion-only hunk adds nothing", () => {
    const diff = [
      "diff --git a/packages/engine/src/core/events.ts b/packages/engine/src/core/events.ts",
      "+++ b/packages/engine/src/core/events.ts",
      "@@ -10,0 +11,3 @@",
      "@@ -40,2 +44 @@",
      "@@ -60,4 +63,0 @@",
      "diff --git a/packages/engine/src/core/events.test.ts b/packages/engine/src/core/events.test.ts",
      "+++ b/packages/engine/src/core/events.test.ts",
      "@@ -1,0 +2,9 @@",
      "diff --git a/packages/engine/src/core/gone.ts b/packages/engine/src/core/gone.ts",
      "+++ /dev/null",
      "@@ -1,7 +0,0 @@",
    ].join("\n");
    expect(rangesFromDiff(diff)).toEqual(["src/core/events.ts:11-13", "src/core/events.ts:44-44"]);
    // a file outside packages/engine/src after an engine one: its hunks are not the engine file's
    expect(rangesFromDiff(["+++ b/packages/engine/src/core/events.ts", "@@ -1,0 +2 @@", "+++ b/apps/web/src/a.ts", "@@ -1,0 +1,2 @@"].join("\n"))).toEqual(["src/core/events.ts:2-2"]);
    expect(rangesFromDiff("")).toEqual([]);
  });

  it("verdictsFromReport names the killers, and counts Survived and NoCoverage as failures", () => {
    const report = {
      testFiles: { "src/x.test.ts": { tests: [{ id: "1", name: "kills it" }] } },
      files: { "src/x.ts": { mutants: [
        { id: "a", mutatorName: "EqualityOperator", replacement: "<=", status: "Killed", killedBy: ["1"], location: { start: { line: 3 } } },
        { id: "b", mutatorName: "BooleanLiteral", replacement: "false", status: "Survived", location: { start: { line: 4 } } },
        { id: "c", mutatorName: "StringLiteral", replacement: '""', status: "NoCoverage", location: { start: { line: 5 } } },
        { id: "d", mutatorName: "BlockStatement", replacement: "{}", status: "Timeout", location: { start: { line: 6 } } },
      ] } },
    };
    const v = verdictsFromReport(report);
    expect(v.rows).toEqual([
      { file: "src/x.ts", line: 3, mutator: "EqualityOperator", status: "Killed", killedBy: ["kills it"] },
      { file: "src/x.ts", line: 4, mutator: "BooleanLiteral", status: "Survived", killedBy: [] },
      { file: "src/x.ts", line: 5, mutator: "StringLiteral", status: "NoCoverage", killedBy: [] },
      { file: "src/x.ts", line: 6, mutator: "BlockStatement", status: "Timeout", killedBy: [] },
    ]);
    expect(v.failures).toBe(2); // a Timeout is a detected mutant (Stryker scores it killed); Survived and NoCoverage are not
    expect(verdictsFromReport({ testFiles: {}, files: {} }).rows).toEqual([]); // and the CLI refuses an empty report
  });
});
