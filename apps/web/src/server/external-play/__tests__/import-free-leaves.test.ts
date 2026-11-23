// The import-free leaves (cap-256 review m2): constants that a runner OUTSIDE the Next build imports by relative path - the Playwright
// load harness (e2e/load, which cannot load a `server-only` module or resolve `@/`) and the smoke suite (scripts/smoke, bare node).
// vitest stubs `server-only` (vitest.config.ts), so an import added to a leaf stays green in every unit test and kills that runner at
// start - on a manual load dispatch, or the smoke job, long after the merge. This scan is the guard: each leaf imports NOTHING, and each
// runner still imports the leaf (not the module behind it, which is the import the leaf exists to avoid).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..", "..", "..", "..");
const REPO = join(WEB, "..", "..");

/** [the leaf, under apps/web/src; the runner that imports it, from the repo root; the specifier that runner names]. A leaf whose runner
 *  has not landed yet carries `null` for both: it is still scanned for imports, and the runner half is owed by the task that adds the runner
 *  (online-chess-package.ts: scripts/smoke/suites/onlineChessDesk.ts, extended by Task 7 Step 5 of the Online Chess credits plan, which must replace the nulls with its path and specifier). */
const LEAVES: [leaf: string, runner: string | null, specifier: string | null][] = [
  ["server/usecases/external-play/sweep/pass-limits.ts", "apps/web/e2e/load/chess-30-boards.load.ts", "../../src/server/usecases/external-play/sweep/pass-limits"],
  ["server/external-play/video/budget-limits.ts", "apps/web/e2e/load/load-stats.ts", "../../src/server/external-play/video/budget-limits"],
  ["lib/online-chess-cap.ts", "scripts/smoke/suites/onlineChessDesk.ts", "../../../apps/web/src/lib/online-chess-cap.ts"],
  ["lib/online-chess-package.ts", null, null], // the price leaf; onlineChessDesk.ts starts importing it in Task 7 Step 5
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
    expect(withRunner, "leaves whose runner was checked").toBe(3);
  });
});
