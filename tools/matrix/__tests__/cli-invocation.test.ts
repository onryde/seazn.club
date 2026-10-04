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
/** Every matrix CLI (W1c Task 13 added `parity`). */
const CLIS = ["run", "render", "gen-catalogue", "single-sport", "model", "parity"];
// `(?:\.\/)?`: `./tools/matrix/run.ts` is the same bare run. Every directory the
// harness has lived in (lib/harness-path.ts): a plan that ran a CLI bare at its
// historical path is still a bare run, and still owes its HISTORY pin.
// The directories are plain path segments, so they go into the pattern as-is.
const DIRS = [HARNESS_DIR, ...HISTORICAL_HARNESS_DIRS];
if (!DIRS.every((d) => /^[\w-]+(?:\/[\w-]+)*$/.test(d))) throw new Error(`a harness directory is not a plain path: ${DIRS.join(", ")}`);
const BARE = new RegExp(`node\\s+(?:--[a-z-]+\\s+)*(?:\\./)?(?:${DIRS.join("|")})/(?:${CLIS.join("|")})\\.ts`);
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
    // Truth-run evidence is the one exclusion, and only it.
    expect(scanned("docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-model-final/README.md")).toBe(false);
    expect(scanned("docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md")).toBe(true);
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
