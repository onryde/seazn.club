// W1b carry (e): a bare `node --experimental-strip-types scripts/matrix/<cli>.ts`
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

const REPO = new URL("../../..", import.meta.url).pathname;
/** Every matrix CLI. `parity` is Task 13's: listing it now means Task 13 cannot ship a bare invocation. */
const CLIS = ["run", "render", "gen-catalogue", "single-sport", "model", "parity"];
// `(?:\.\/)?`: `./scripts/matrix/run.ts` is the same bare run.
const BARE = new RegExp(`node\\s+(?:--[a-z-]+\\s+)*(?:\\./)?scripts/matrix/(?:${CLIS.join("|")})\\.ts`);
const PRELOAD = "--import ./scripts/matrix/lib/crash-exit.ts";
/** A line that runs a matrix CLI without the preload. The preload may ride
 *  outside the flag run the pattern spans (NODE_OPTIONS), so a line naming it
 *  anywhere is exempt. */
const bareRun = (line: string): boolean => BARE.test(line) && !line.includes(PRELOAD);
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
  return execFileSync("git", ["ls-files", "--", "*.md", "*.yml", "*.yaml", "*.sh", "package.json", "scripts/matrix/*.ts"], { cwd: REPO, encoding: "utf8" })
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
    for (const f of ["package.json", ".github/workflows/ci.yml", "AGENTS.md", "scripts/matrix/lib/crash-exit.ts"]) expect(files, f).toContain(f);
    let clis = 0;
    for (const cli of CLIS.filter((c) => c !== "parity")) {
      expect(files, cli).toContain(`scripts/matrix/${cli}.ts`);
      clis++;
    }
    expect(clis).toBe(CLIS.length - 1);
    // Truth-run evidence is the one exclusion, and only it.
    expect(scanned("docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-model-final/README.md")).toBe(false);
    expect(scanned("docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md")).toBe(true);
  });

  it("the pattern matches the bare form, and the preload form is exempt", () => {
    // Built, not written out: a literal bare line here would be a hit on this file.
    const bare = (...flags: string[]) => ["node", ...flags, "scripts/matrix/run.ts", "--set", "x"].join(" ");
    expect(BARE.test(bare("--experimental-strip-types"))).toBe(true);
    expect(BARE.test(bare())).toBe(true);
    expect(BARE.test(bare("--experimental-strip-types", "--no-warnings"))).toBe(true);
    expect(BARE.test(bare("--experimental-strip-types").replace(" scripts/", " ./scripts/"))).toBe(true);
    let clis = 0;
    for (const cli of CLIS) {
      expect(BARE.test(bare("--experimental-strip-types").replace("/run.ts", `/${cli}.ts`)), cli).toBe(true);
      clis++;
    }
    expect(clis).toBe(CLIS.length);
    // `--import <path>` is a flag with a value, which the pattern's `--flag` run does not span.
    expect(BARE.test(["node", "--experimental-strip-types", PRELOAD, "scripts/matrix/run.ts"].join(" "))).toBe(false);
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
