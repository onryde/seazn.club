// The import-free leaves (cap-256 review m2): constants that a runner OUTSIDE the Next build imports by relative path - the Playwright
// load harness (e2e/load, which cannot load a `server-only` module or resolve `@/`) and the smoke suite (scripts/smoke, bare node).
// vitest stubs `server-only` (vitest.config.ts), so an import added to a leaf stays green in every unit test and kills that runner at
// start - on a manual load dispatch, or the smoke job, long after the merge. This scan is the guard: each leaf imports NOTHING, and each
// runner still imports the leaf (not the module behind it, which is the import the leaf exists to avoid).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..", "..", "..", "..");
const REPO = join(WEB, "..", "..");

/** [the leaf, under apps/web/src; the runner that imports it, from the repo root; the specifier that runner names]. A leaf whose runner
 *  has not landed yet carries `null` for both: it is still scanned for imports, and the runner half is owed by the task that adds the runner.
 *  None does now: the price leaf's runner landed with Task 7 of the Online Chess credits plan (the smoke suite chooses sizes off its ladder). */
const LEAVES: [leaf: string, runner: string | null, specifier: string | null][] = [
  ["server/usecases/external-play/sweep/pass-limits.ts", "apps/web/e2e/load/chess-30-boards.load.ts", "../../src/server/usecases/external-play/sweep/pass-limits"],
  ["server/external-play/video/budget-limits.ts", "apps/web/e2e/load/load-stats.ts", "../../src/server/external-play/video/budget-limits"],
  ["lib/online-chess-cap.ts", "scripts/smoke/suites/onlineChessDesk.ts", "../../../apps/web/src/lib/online-chess-cap.ts"],
  ["lib/online-chess-package.ts", "scripts/smoke/suites/onlineChessDesk.ts", "../../../apps/web/src/lib/online-chess-package.ts"], // the price leaf: the smoke suite picks sizes off its ladder
];

/** Every module a source depends on: a static import (bare, with bindings, or type-only), a re-export from, a dynamic import, a require.
 *  Comments are dropped first, so a doc comment that mentions an import is not one. */
function moduleDependencies(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const found: string[] = [];
  for (const re of [
    /^\s*import\b[^;]*?["']([^"']+)["']/gm,
    /^\s*export\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ]) {
    for (const m of code.matchAll(re)) found.push(m[1]!);
  }
  return found;
}

const SMOKE_SUITES = join(REPO, "scripts", "smoke", "suites");

/** Whether a smoke suite (a file at `suiteFile`, reading `source`) imports the leaf at `leafAbs` (an absolute path): a relative specifier
 *  that resolves to it (with or without the `.ts`), or an aliased one (`@/lib/...`) that ends in the leaf's own path under src/. */
function suiteImportsLeaf(suiteFile: string, source: string, leafAbs: string, leaf: string): boolean {
  const bare = (p: string) => p.replace(/\.tsx?$/, "");
  return moduleDependencies(source).some((spec) => {
    if (spec.startsWith(".")) return bare(resolve(dirname(suiteFile), spec)) === bare(leafAbs);
    return bare(spec).endsWith(bare(leaf));
  });
}

describe("the import-free leaves import nothing (cap-256 review m2)", () => {
  it("the scan itself: every form of dependency is caught, and a comment that only mentions one is not", () => {
    const cases: [string, string[]][] = [
      [`export const A = 1;`, []], // the empty case first: a leaf
      [`import "server-only";\nexport const A = 1;`, ["server-only"]],
      [`import { a } from "@/lib/x";`, ["@/lib/x"]],
      [`import {\n  a,\n  b,\n} from "./multi-line";`, ["./multi-line"]],
      [`import type { A } from "./types";`, ["./types"]],
      [`export { a } from "./re-export";`, ["./re-export"]],
      [`export * from "./star";`, ["./star"]],
      [`const m = await import("./dynamic");`, ["./dynamic"]],
      [`const m = require("./cjs");`, ["./cjs"]],
      [`// import "server-only";\n/** export { a } from "./a"; */\nexport const A = 1; // see https://example.invalid/x`, []],
    ];
    let checked = 0;
    for (const [source, want] of cases) {
      expect(moduleDependencies(source), JSON.stringify(source)).toEqual(want);
      checked += 1;
    }
    expect(checked, "scan cases checked").toBe(cases.length);
  });

  it("each leaf is read, declares an export, and depends on nothing; each runner imports the leaf by that path", () => {
    let checked = 0;
    let withRunner = 0;
    for (const [leaf, runner, specifier] of LEAVES) {
      const source = readFileSync(join(WEB, "src", leaf), "utf8");
      expect(source, `${leaf}: anti-vacuity - the file read declares a constant`).toMatch(/^export const \w+/m);
      expect(moduleDependencies(source), `${leaf} must import nothing: ${runner ?? "its smoke runner"} cannot load what it would pull in`).toEqual([]);
      if (runner !== null && specifier !== null) {
        const runnerSource = readFileSync(join(REPO, runner), "utf8");
        expect(moduleDependencies(runnerSource), `${runner} reads the leaf itself`).toContain(specifier);
        withRunner += 1;
      }
      checked += 1;
    }
    expect(checked, "leaves scanned").toBe(4);
    expect(withRunner, "leaves whose runner was checked").toBe(4);
  });

  it("the tripwire's own detector: it fires on a relative import, with or without .ts, and on an aliased one; it is silent otherwise", () => {
    const suite = join(SMOKE_SUITES, "x.ts");
    const leafAbs = join(WEB, "src", "lib", "online-chess-package.ts");
    const leaf = "lib/online-chess-package.ts";
    const cases: [string, boolean][] = [
      [`import { a } from "../../../apps/web/src/lib/online-chess-package.ts";`, true],
      [`import { a } from "../../../apps/web/src/lib/online-chess-package";`, true],
      [`import { a } from "@/lib/online-chess-package";`, true],
      [`import { a } from "../../../apps/web/src/lib/online-chess-cap.ts";`, false], // a sibling leaf is not this leaf
      [`// import { a } from "../../../apps/web/src/lib/online-chess-package.ts";\nexport const A = 1;`, false], // a comment is not an import
      [``, false],
    ];
    let checked = 0;
    for (const [source, want] of cases) {
      expect(suiteImportsLeaf(suite, source, leafAbs, leaf), JSON.stringify(source)).toBe(want);
      checked += 1;
    }
    expect(checked, "detector cases checked").toBe(cases.length);
    // and against a REAL runner: onlineChessDesk.ts does import the cap leaf (the positive control for the sweep below)
    const desk = join(SMOKE_SUITES, "onlineChessDesk.ts");
    expect(suiteImportsLeaf(desk, readFileSync(desk, "utf8"), join(WEB, "src", "lib", "online-chess-cap.ts"), "lib/online-chess-cap.ts")).toBe(true);
  });

  it("the tuple is the truth both ways: a leaf with a null runner is imported by NO smoke suite, and a leaf whose runner is a smoke suite IS imported by it", () => {
    const suites = readdirSync(SMOKE_SUITES).filter((f) => f.endsWith(".ts"));
    expect(suites.length, "smoke suite files scanned (zero is a failure)").toBeGreaterThan(0);
    const sources = suites.map((f) => [join(SMOKE_SUITES, f), readFileSync(join(SMOKE_SUITES, f), "utf8")] as const);
    const importersOf = (leaf: string): string[] =>
      sources.filter(([file, source]) => suiteImportsLeaf(file, source, join(WEB, "src", leaf), leaf)).map(([file]) => file.slice(SMOKE_SUITES.length + 1));
    let nullLeaves = 0;
    let smokeRunners = 0;
    for (const [leaf, runner] of LEAVES) {
      const importers = importersOf(leaf);
      if (runner === null) {
        // null means "no runner imports it yet": the first import forces the tuple to be filled in.
        nullLeaves += 1;
        expect(importers, `${leaf} has a null runner but ${importers.join(", ")} imports it: put that suite's path and specifier in LEAVES`).toEqual([]);
      } else if (runner.startsWith("scripts/smoke/suites/")) {
        // the other direction: the runner the tuple names really imports the leaf (the guard above would be a dead tripwire for it)
        smokeRunners += 1;
        expect(importers, `${runner} is named as ${leaf}'s runner, so the smoke scan must find it importing it`).toContain(runner.slice("scripts/smoke/suites/".length));
      }
    }
    expect(nullLeaves, "leaves with a null runner (the tripwire's subjects: none since Task 7 of the Online Chess credits plan)").toBe(0);
    expect(smokeRunners, "leaves whose runner is a smoke suite (the cap leaf and the price leaf)").toBe(2);
  });
});
