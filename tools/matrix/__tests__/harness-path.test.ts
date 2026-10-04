// lib/harness-path.ts is the ONE place that knows the harness moved
// (ruling 56: scripts/matrix -> tools/matrix). These tests pin the map against
// the tree itself — where this file sits, what committed evidence recorded —
// never against the module's own constants alone.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HARNESS_DIR, HISTORICAL_HARNESS_DIRS, livePath, spellingsOf } from "../lib/harness-path.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATRIX = resolve(HERE, "..");
const REPO = resolve(MATRIX, "..", "..");
const TRUTH_RUNS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs";
const OLD = HISTORICAL_HARNESS_DIRS[0]!;

/** Every tracked file under `dir`, repo-relative (git, so node_modules and outputs never count). */
const trackedUnder = (dir: string): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", dir], { cwd: REPO, encoding: "utf8" }).split("\0").filter((f) => f !== "");

describe("harness-path: where the harness lives, and where it used to (ruling 56)", () => {
  it("HARNESS_DIR is the directory this test's harness actually sits in, and no historical directory survives in the tree", () => {
    expect(relative(REPO, MATRIX)).toBe(HARNESS_DIR);
    expect(existsSync(join(REPO, HARNESS_DIR, "lib", "harness-path.ts"))).toBe(true);
    expect(HISTORICAL_HARNESS_DIRS.length).toBeGreaterThan(0);
    for (const dir of HISTORICAL_HARNESS_DIRS) {
      expect(dir).not.toBe(HARNESS_DIR);
      // A recreated old directory would make a recorded path resolve to the wrong copy.
      expect(existsSync(join(REPO, dir)), `${dir} is back in the tree`).toBe(false);
    }
    // The ruling's own words: the harness was scripts/matrix.
    expect(HISTORICAL_HARNESS_DIRS).toEqual(["scripts/matrix"]);
  });

  it("livePath maps a recorded harness path into today's tree and leaves every other path alone — by segment, not by prefix", () => {
    const cases: [string, string][] = [
      [`${OLD}/draw-counts.ts`, "tools/matrix/draw-counts.ts"],
      [`${OLD}/lib/scenarios/r4-withdrawal.ts`, "tools/matrix/lib/scenarios/r4-withdrawal.ts"],
      [OLD, "tools/matrix"],
      // Not the harness: a sibling whose name only starts with matrix, the bench, the web app, today's path.
      [`${OLD}-legacy/a.ts`, `${OLD}-legacy/a.ts`],
      [`${OLD}x/a.ts`, `${OLD}x/a.ts`],
      ["scripts/bench/lib/env.ts", "scripts/bench/lib/env.ts"],
      ["apps/web/src/lib/format-templates.ts", "apps/web/src/lib/format-templates.ts"],
      ["tools/matrix/run.ts", "tools/matrix/run.ts"],
      [`x/${OLD}/run.ts`, `x/${OLD}/run.ts`],
    ];
    for (const [recorded, live] of cases) expect(livePath(recorded), recorded).toBe(live);
    expect(cases.length).toBe(9);
  });

  it("spellingsOf lists today's path first, then each historical one; a path outside the harness has only itself", () => {
    expect(spellingsOf("tools/matrix/catalogue/single-sport-baseline.json")).toEqual([
      "tools/matrix/catalogue/single-sport-baseline.json",
      `${OLD}/catalogue/single-sport-baseline.json`,
    ]);
    expect(spellingsOf("tools/matrix")).toEqual(["tools/matrix", OLD]);
    expect(spellingsOf("tools/matrixx/a.ts")).toEqual(["tools/matrixx/a.ts"]);
    expect(spellingsOf("package.json")).toEqual(["package.json"]);
    // The two directions agree: every spelling maps back to the live path.
    for (const p of spellingsOf("tools/matrix/lib/crash-exit.ts")) expect(livePath(p)).toBe("tools/matrix/lib/crash-exit.ts");
  });

  it("every harness path committed evidence records still names a real file once mapped — and none does unmapped", () => {
    // The evidence is never edited (REBASE-R3); the map is what makes its paths readable today.
    const files = trackedUnder(TRUTH_RUNS).filter((f) => !f.endsWith("results.json"));
    expect(files.length).toBeGreaterThan(10);
    const recorded = new Set<string>();
    const pattern = new RegExp(`${OLD.replace("/", "\\/")}\\/[\\w./-]+\\.(?:ts|json)\\b`, "g");
    for (const f of files) for (const m of readFileSync(join(REPO, f), "utf8").matchAll(pattern)) recorded.add(m[0]);
    console.info(`harness-path: ${files.length} evidence files read, ${recorded.size} distinct recorded harness paths`);
    // Anti-vacuity: draw-counts.json's "script" and W1-DRIVING-REBASES.md's test paths at least.
    expect(recorded.size).toBeGreaterThanOrEqual(5);
    expect(recorded).toContain(`${OLD}/draw-counts.ts`);
    for (const p of recorded) {
      expect(existsSync(join(REPO, livePath(p))), `${p} -> ${livePath(p)}`).toBe(true);
      expect(existsSync(join(REPO, p)), `${p} still resolves unmapped`).toBe(false);
    }
  });

  it("no harness file but this module and this test spells a historical directory — the map is the only place that knows", () => {
    const files = trackedUnder(HARNESS_DIR).concat(
      // New files not yet committed are harness files too.
      execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", HARNESS_DIR], { cwd: REPO, encoding: "utf8" }).split("\0").filter((f) => f !== ""),
    );
    const allowed = new Set([`${HARNESS_DIR}/lib/harness-path.ts`, `${HARNESS_DIR}/__tests__/harness-path.test.ts`]);
    const spell = (text: string) => HISTORICAL_HARNESS_DIRS.some((d) => text.includes(d) || text.includes(d.replace("/", "\\/")));
    const offenders: string[] = [];
    let read = 0;
    for (const f of new Set(files)) {
      if (!existsSync(join(REPO, f))) continue; // deleted in the working tree
      read++;
      if (!allowed.has(f) && spell(readFileSync(join(REPO, f), "utf8"))) offenders.push(f);
    }
    console.info(`harness-path: ${read} harness files read for a historical spelling`);
    expect(read).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
    // Positive control: the same probe sees the module's own spelling, in both forms it checks.
    expect(spell(readFileSync(join(MATRIX, "lib", "harness-path.ts"), "utf8"))).toBe(true);
    expect(spell(`/outside ${OLD.replace("/", "\\/")}/`)).toBe(true);
    expect(spell("tools/matrix/run.ts")).toBe(false);
  });

  it("no live wiring file names a historical directory: root scripts, workflows, lint, tsc, turbo and the workspace list all point at today's", () => {
    const wiring = [
      "package.json", "pnpm-workspace.yaml", "eslint.config.mjs", "tsconfig.scripts.json", "turbo.json", ".gitignore", ".dockerignore",
      "packages/reference/turbo.json",
      ...readdirSync(join(REPO, ".github", "workflows")).filter((f) => f.endsWith(".yml")).map((f) => `.github/workflows/${f}`),
    ];
    let read = 0;
    const offenders: string[] = [];
    for (const f of wiring) {
      const text = readFileSync(join(REPO, f), "utf8");
      read++;
      text.split("\n").forEach((l, i) => { if (HISTORICAL_HARNESS_DIRS.some((d) => l.includes(d))) offenders.push(`${f}:${i + 1}`); });
    }
    expect(read).toBe(wiring.length);
    expect(read).toBeGreaterThan(8);
    expect(offenders).toEqual([]);
    // Positive pair: the live directory IS named where the harness is wired.
    const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain(`--testTimeout=30000 ${HARNESS_DIR}`);
    expect(readFileSync(join(REPO, "package.json"), "utf8")).toContain(`${HARNESS_DIR}/run.ts`);
  });
});
