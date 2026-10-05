// W1b carry (e): a bare `node --experimental-strip-types tools/matrix/<cli>.ts`
// loses crash-exit.ts's preload, so a load crash exits 1 — a verdict. Every
// documented invocation must go through the package script.
//
// Committed truth-run evidence is excluded: it records what was run, and
// rewriting history is not the point. So are the bare lines a PLAN records
// (HISTORY): a plan is its wave's record of what it planned and ran. They are
// pinned by count, so a new bare line in one of them still reds, and a plan
// that no longer holds its count reds until the pin is updated.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HARNESS_DIR, HISTORICAL_HARNESS_DIRS, RELOCATED_FILES, spellingsOf } from "../lib/harness-path.ts";

const REPO = new URL("../../..", import.meta.url).pathname;
/** Every matrix CLI, as a hand-kept PIN (W1c Task 13 added `parity`; W1d Task 1 `lock-append-only`, ruling T1-b;
 *  Task 4 `merge-shards`, Task 6 `judge`, Task 7 `ci/pr-rows`, Task 8 `ci/shard-matrix`, `ci/summary` and `ci/staleness`,
 *  ruling CLI-TABLES; Task 9 `ci/run-sample`). Since W1d Task 8 (ruling CI-BLIND) it
 *  no longer DEFINES what the scan looks for: BARE is built from the CLIs found in the tree (discoverClis), so a new CLI
 *  anywhere under tools/matrix/ — `ci/` included — is scanned whether or not anyone remembers a row. This table is
 *  held EQUAL to that discovery, so a CLI with no row, or a row naming no CLI, reds. `findings-table` and `draw-counts`
 *  have no `matrix:*` script (a documented, preloaded `node` line runs them) and were never in this table: the
 *  discovery found them. */
const CLIS = ["run", "render", "gen-catalogue", "single-sport", "model", "parity", "lock-append-only", "merge-shards", "judge", "findings-table", "draw-counts", "ci/pr-rows", "ci/shard-matrix", "ci/summary", "ci/staleness", "ci/run-sample"];
const DIRS = [HARNESS_DIR, ...HISTORICAL_HARNESS_DIRS];
if (!DIRS.every((d) => /^[\w-]+(?:\/[\w-]+)*$/.test(d))) throw new Error(`a harness directory is not a plain path: ${DIRS.join(", ")}`);

/** A shipped CLI is a module under the harness directory that guards its main with isMainModule — every CLI does (a
 *  main that runs when imported would run in every test that loads it), and a module that does not is no CLI. The name is
 *  its path under the directory without `.ts`: `run`, `ci/pr-rows`. A test, and anything under `__tests__`, is no CLI. */
function discoverClis(files: readonly { path: string; text: string }[]): string[] {
  const under = new RegExp(`^${HARNESS_DIR}/((?:[\\w-]+/)*[\\w-]+)\\.ts$`);
  const out: string[] = [];
  for (const { path, text } of files) {
    const m = under.exec(path);
    if (m === null || m[1].split("/").includes("__tests__")) continue;
    if (/\bisMainModule\(import\.meta\.url\)/.test(text)) out.push(m[1]);
  }
  return out.sort();
}
/** `node [--flag ...] [./]<dir>/<cli>.ts`: a CLI run without the crash-exit preload. `(?:\./)?`: `./tools/matrix/run.ts`
 *  is the same bare run. Every directory the harness has lived in (lib/harness-path.ts): a plan that ran a CLI bare at
 *  its historical path is still a bare run, and still owes its HISTORY pin. The directories are plain path segments, so
 *  they go into the pattern as-is. */
const bareRegex = (clis: readonly string[]): RegExp => new RegExp(`node\\s+(?:--[a-z-]+\\s+)*(?:\\./)?(?:${DIRS.join("|")})/(?:${clis.join("|")})\\.ts`);
/** Every `tools/matrix/**\/*.ts` that is tracked, with its text. */
function trackedModules(): { path: string; text: string }[] {
  return execFileSync("git", ["ls-files", "--", `${HARNESS_DIR}/*.ts`], { cwd: REPO, encoding: "utf8" })
    .split("\n").filter((f) => f !== "").map((path) => ({ path, text: readFileSync(`${REPO}${path}`, "utf8") }));
}
const DISCOVERED = discoverClis(trackedModules());
const BARE = bareRegex(DISCOVERED);
/** The preload's path today: scripts/lib, outside the harness (CL-R4). */
const CRASH_EXIT = "scripts/lib/crash-exit.ts";
const PRELOAD = `--import ./${CRASH_EXIT}`;
/** The preload at every path it has had (lib/harness-path.ts's RELOCATED_FILES):
 *  a recorded line that names the historical one carried the preload when it ran. */
const PRELOADS = spellingsOf(CRASH_EXIT).map((p) => `--import ./${p}`);
/** A line that runs a matrix CLI without the preload. The preload may ride
 *  outside the flag run the pattern spans (NODE_OPTIONS), so a line naming it
 *  anywhere is exempt. */
const bareRun = (line: string): boolean => BARE.test(line) && !PRELOADS.some((p) => line.includes(p));
/** Bare lines a plan records, by plan: history, never rewritten. */
const HISTORY: Readonly<Record<string, number>> = {
  // W1a's plan: the CLI headers and package scripts as W1a first wrote them (before the F-6 preload).
  "docs/superpowers/plans/2026-09-27-format-matrix-w1a.md": 5,
  // W1b's plan: its package scripts before F-6, and the commands its tasks ran.
  "docs/superpowers/plans/2026-09-28-format-matrix-w1b.md": 10,
  // W1c's plan: this file's own unit case, quoted in Task 2.
  "docs/superpowers/plans/2026-09-29-format-matrix-w1c.md": 1,
};

/** A tracked file the scan reads: anything but committed truth-run evidence. */
const scanned = (f: string): boolean => f !== "" && !f.includes("/truth-runs/");
/** Every tracked doc, workflow, script and matrix module the scan reads. */
function tracked(): string[] {
  return execFileSync("git", ["ls-files", "--", "*.md", "*.yml", "*.yaml", "*.sh", "package.json", "tools/matrix/*.ts"], { cwd: REPO, encoding: "utf8" })
    .split("\n").filter(scanned);
}
/** Every line that runs a matrix CLI bare: `file:line`, per file. */
function bareLines(files: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    readFileSync(`${REPO}${f}`, "utf8").split("\n").forEach((l, i) => {
      if (bareRun(l)) out.set(f, [...(out.get(f) ?? []), `${f}:${i + 1}`]);
    });
  }
  return out;
}

describe("CLI invocation (carry e)", () => {
  it("empty case first: the scan reads at least one file — and every kind it names, and every CLI that exists", () => {
    const files = tracked();
    expect(files.length).toBeGreaterThan(0);
    // A pathspec that silently matched nothing would read as "no bare line".
    // A nested harness module too: the matrix pathspec reaches lib/.
    for (const f of ["package.json", ".github/workflows/ci.yml", "AGENTS.md", "tools/matrix/lib/harness-path.ts"]) expect(files, f).toContain(f);
    let clis = 0;
    for (const cli of CLIS) {
      expect(files, cli).toContain(`tools/matrix/${cli}.ts`);
      clis++;
    }
    expect(clis).toBe(CLIS.length);
    // W1d Task 8 (ruling CI-BLIND): the scan's CLIs are the ones FOUND in the tree, and the table is a pin held equal to
    // them — a CLI nobody added a row for (the ci/ ones were invisible to the old pattern) reds here, and so does a row
    // that names no CLI. Pinned as a literal beside the derived bound, which is a tautology on its own.
    expect(DISCOVERED.length).toBeGreaterThan(0);
    expect(DISCOVERED, "a CLI under tools/matrix has no row in CLIS, or a row names none").toEqual([...CLIS].sort());
    expect(CLIS).toHaveLength(16);
    expect(DISCOVERED.filter((c) => c.includes("/")), "the nested (ci/) CLIs are discovered").toEqual(["ci/pr-rows", "ci/run-sample", "ci/shard-matrix", "ci/staleness", "ci/summary"]);
    // Truth-run evidence is the one exclusion, and only it.
    expect(scanned("docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-model-final/README.md")).toBe(false);
    expect(scanned("docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md")).toBe(true);
  });

  // The mechanism, on a tree of its own: a CLI that is NOT in any table is still found and still scanned. Before W1d
  // Task 8 the pattern was spelled from a hand table of top-level names, so a new tools/matrix/ci/<cli>.ts shipped
  // with no row and no scan at all (a plan or workflow quoting it bare was invisible to this file).
  it("discovery: a new CLI under ci/ is found and its bare form is caught, with no table edited; a lib module and a test are no CLI", () => {
    const main = "if (isMainModule(import.meta.url)) { process.exitCode = main(process.argv.slice(2)); }";
    const found = discoverClis([
      { path: "tools/matrix/ci/brand-new.ts", text: main },
      { path: "tools/matrix/run.ts", text: main },
      { path: "tools/matrix/lib/helper.ts", text: "export const x = 1;" },
      { path: "tools/matrix/lib/exports-a-main.ts", text: "export function main() {}" },
      { path: "tools/matrix/__tests__/a-fixture.ts", text: main },
      { path: "tools/matrix/__tests__/a.test.ts", text: main },
      { path: "tools/other/run.ts", text: main },
    ]);
    expect(found).toEqual(["ci/brand-new", "run"]);
    const bare = bareRegex(found);
    const line = (cli: string) => ["node", "--experimental-strip-types", `tools/matrix/${cli}.ts`, "--x"].join(" ");
    expect(bare.test(line("ci/brand-new"))).toBe(true);
    expect(bare.test(line("run"))).toBe(true);
    // …and the real table, as it was before this task's discovery, does not see the new one: that is the blind spot.
    expect(bareRegex(CLIS.filter((c) => !c.includes("/"))).test(line("ci/brand-new"))).toBe(false);
    expect(bare.test(line("lib/helper"))).toBe(false);
    // The preload form is exempt for a nested CLI as for a top-level one.
    expect(bare.test(["node", "--experimental-strip-types", PRELOAD, "tools/matrix/ci/brand-new.ts"].join(" "))).toBe(false);
    // The empty tree finds nothing (and a regex built from nothing would match `node …/.ts`; the real scan never builds one:
    // the pin above holds the real set non-empty).
    expect(discoverClis([])).toEqual([]);
  });

  it("the pattern matches the bare form, and the preload form is exempt", () => {
    // Built, not written out: a literal bare line here would be a hit on this file.
    const bare = (...flags: string[]) => ["node", ...flags, "tools/matrix/run.ts", "--set", "x"].join(" ");
    expect(BARE.test(bare("--experimental-strip-types"))).toBe(true);
    expect(BARE.test(bare())).toBe(true);
    expect(BARE.test(bare("--experimental-strip-types", "--no-warnings"))).toBe(true);
    const dotted = bare("--experimental-strip-types").replace(" tools/", " ./tools/");
    expect(dotted).toContain(" ./tools/matrix/run.ts");
    expect(BARE.test(dotted)).toBe(true);
    // The historical directory is the same CLI: a plan's bare line at that path is a hit, and its preload exempts it.
    const historical = bare("--experimental-strip-types").replace(" tools/matrix/", ` ${HISTORICAL_HARNESS_DIRS[0]}/`);
    expect(historical).not.toContain("tools/matrix");
    expect(bareRun(historical)).toBe(true);
    expect(bareRun(historical.replace("--experimental-strip-types", `--experimental-strip-types --import ./${HISTORICAL_HARNESS_DIRS[0]}/lib/crash-exit.ts`))).toBe(false);
    // The preload's two spellings: today's, and the one its file-level entry records (CL-R4).
    expect(RELOCATED_FILES[`${HISTORICAL_HARNESS_DIRS[0]}/lib/crash-exit.ts`]).toBe(CRASH_EXIT);
    expect(PRELOADS).toEqual([PRELOAD, `--import ./${HISTORICAL_HARNESS_DIRS[0]}/lib/crash-exit.ts`]);
    // The spelling that existed only between the move and CL-R4 points at no file, so it exempts nothing
    // (through NODE_OPTIONS, the one form whose preload rides outside the pattern).
    expect(bareRun(`NODE_OPTIONS="--import ./tools/matrix/lib/crash-exit.ts" ${bare("--experimental-strip-types")}`)).toBe(true);
    expect(bareRun(`NODE_OPTIONS="--import ./${HISTORICAL_HARNESS_DIRS[0]}/lib/crash-exit.ts" ${bare("--experimental-strip-types")}`)).toBe(false);
    // A directory that only ends in matrix is no harness.
    expect(BARE.test(bare("--experimental-strip-types").replace(" tools/matrix/", " tools/xmatrix/"))).toBe(false);
    let clis = 0;
    for (const cli of CLIS) {
      expect(BARE.test(bare("--experimental-strip-types").replace("/run.ts", `/${cli}.ts`)), cli).toBe(true);
      clis++;
    }
    expect(clis).toBe(CLIS.length);
    // W1d Task 1: the lock gate's CLI, named here and not only through the loop, so a row dropped from CLIS reds.
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/lock-append-only.ts"))).toBe(true);
    // W1d Task 4: the shard merge's CLI, named here and not only through the loop, so a row dropped from CLIS reds.
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/merge-shards.ts"))).toBe(true);
    // W1d Task 6: the judge's CLI, named here and not only through the loop, so a row dropped from CLIS reds.
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/judge.ts"))).toBe(true);
    // W1d Task 7: the PR-rows reader's CLI lives under ci/, named here and not only through the loop, so a row dropped from CLIS reds.
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/ci/pr-rows.ts"))).toBe(true);
    // W1d Task 8: the three CI helpers' CLIs, each named here and not only through the loop, so a row dropped from CLIS reds.
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/ci/shard-matrix.ts"))).toBe(true);
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/ci/summary.ts"))).toBe(true);
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/ci/staleness.ts"))).toBe(true);
    // W1d Task 9: the per-PR sample's driver, named here and not only through the loop, so a row dropped from CLIS reds.
    expect(bareRun(bare("--experimental-strip-types").replace("/run.ts", "/ci/run-sample.ts"))).toBe(true);
    // The preload form the package scripts and the workflow use is exempt for each of them.
    for (const cli of ["ci/shard-matrix", "ci/summary", "ci/staleness", "ci/run-sample"]) {
      expect(bareRun(["node", "--experimental-strip-types", PRELOAD, `tools/matrix/${cli}.ts`].join(" ")), cli).toBe(false);
    }
    // `--import <path>` is a flag with a value, which the pattern's `--flag` run does not span.
    expect(BARE.test(["node", "--experimental-strip-types", PRELOAD, "tools/matrix/run.ts"].join(" "))).toBe(false);
    expect(BARE.test("pnpm run matrix:l3 -- --set x")).toBe(false);
    // A module that is no CLI is not a run of one.
    expect(BARE.test(bare("--experimental-strip-types").replace("/run.ts", "/lib/crash-exit.ts"))).toBe(false);
    // The preload through NODE_OPTIONS: the pattern matches, the line is exempt — and the bare pair is not.
    const viaEnv = `NODE_OPTIONS="${PRELOAD}" ${bare("--experimental-strip-types")}`;
    expect(BARE.test(viaEnv)).toBe(true);
    expect(bareRun(viaEnv)).toBe(false);
    expect(bareRun(bare("--experimental-strip-types"))).toBe(true);
  });

  it("no tracked doc, workflow or script runs a matrix CLI without the crash-exit preload (a plan's recorded lines excepted, by count)", () => {
    const files = tracked();
    const hits = bareLines(files);
    const fresh = [...hits].filter(([f]) => !Object.hasOwn(HISTORY, f)).flatMap(([, lines]) => lines);
    expect(fresh).toEqual([]);
    // Each plan holds exactly its recorded count: a new bare line reds, and a
    // pin that no longer describes its plan reds too.
    let plans = 0;
    for (const [plan, count] of Object.entries(HISTORY)) {
      expect(files, plan).toContain(plan);
      expect(hits.get(plan)?.length ?? 0, plan).toBe(count);
      plans++;
    }
    expect(plans).toBe(Object.keys(HISTORY).length);
  });
});
