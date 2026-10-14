// The engine manifest declares `sideEffects: false` (engine-split 1b-2, D14). A bundler is then entitled to drop an import that binds
// nothing, so `import "@seazn/engine/sports"` — written to register something, or to patch a global — would silently do nothing in
// a production build while every dev run and unit test stayed green. The engine itself registers nothing on import
// (packages/engine/test/publish-manifest.test.ts proves that half); this proves no consumer relies on the opposite.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", "coverage", ".git", ".stryker-tmp", "reports", "test-results", "playwright-report"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const ENGINE_SPEC = String.raw`["'](?:@seazn/engine|@onryde/seazn-engine)[^"']*["']`;
/**
 * An import of the engine that binds nothing, in each of the three shapes a bundler may drop under `sideEffects: false`:
 * `import "@seazn/engine/x";` (the quote follows `import` directly), `import {} from "@seazn/engine/x";` (an empty binding
 * list), and a `require("@seazn/engine/x");` statement whose result is thrown away. A `require` whose value is used
 * (`const x = require(...)`, `module.exports = require(...)`) does not start the line, so it is not matched.
 */
const BARE_IMPORT = new RegExp(String.raw`^[ \t]*(?:import[ \t]*${ENGINE_SPEC}|import[ \t]*\{\s*\}\s*from[ \t]*${ENGINE_SPEC}|require\([ \t]*${ENGINE_SPEC}[ \t]*\))`, "gm");
const BOUND_IMPORT = /^[ \t]*(?:import|export)\b[^"';]*?\bfrom[ \t]*["']@seazn\/engine[^"']*["']/gm;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

describe("no consumer relies on importing the engine for an effect", () => {
  it("the matcher sees the shape it forbids and none it should allow", () => {
    const hit = (s: string) => [...s.matchAll(BARE_IMPORT)].length;
    expect(hit('import "@seazn/engine/sports";')).toBe(1);
    expect(hit("  import '@seazn/engine';")).toBe(1);
    expect(hit('import "@onryde/seazn-engine/core";')).toBe(1);
    expect(hit('import { a } from "@seazn/engine/core";')).toBe(0);
    expect(hit('import type { A } from "@seazn/engine/core";')).toBe(0);
    expect(hit('const m = await import("@seazn/engine/core");')).toBe(0);
    expect(hit('// import "@seazn/engine/sports"')).toBe(0);
    // the other ways to import for nothing: an empty binding list, and a require() whose result is thrown away
    expect(hit('import {} from "@seazn/engine/sports";')).toBe(1);
    expect(hit('import {  } from "@onryde/seazn-engine/sports";')).toBe(1);
    expect(hit('import {\n} from "@seazn/engine/sports";')).toBe(1);
    expect(hit('require("@seazn/engine/sports");')).toBe(1);
    expect(hit("  require('@onryde/seazn-engine');")).toBe(1);
    expect(hit('import { a } from "@seazn/engine/core";')).toBe(0);
    expect(hit('const { a } = require("@seazn/engine/core");')).toBe(0);
    expect(hit('module.exports = require("@seazn/engine/core");')).toBe(0);
    expect(hit('import {} from "./local";')).toBe(0);
    expect([...'import {\n  a,\n} from "@seazn/engine/core";\n'.matchAll(BOUND_IMPORT)]).toHaveLength(1);
  });

  it("finds no binding-less import or require of the engine under apps/, packages/, tools/ or scripts/", () => {
    const files = ["apps", "packages", "tools", "scripts"].flatMap((d) => walk(path.join(ROOT, d)));
    let boundImporters = 0;
    const bare: string[] = [];
    for (const f of files) {
      const source = readFileSync(f, "utf8");
      if (source.includes("@seazn/engine") || source.includes("@onryde/seazn-engine")) {
        for (const m of source.matchAll(BARE_IMPORT)) bare.push(`${path.relative(ROOT, f)}: ${m[0].trim()}`);
        if ([...source.matchAll(BOUND_IMPORT)].length > 0) boundImporters++;
      }
    }
    // anti-vacuity: an empty walk, or a bound-import matcher that matched nothing, would make "no bare import" mean "looked at nothing"
    expect(files.length, "source files scanned").toBeGreaterThan(500);
    expect(boundImporters, "files that import the engine with a binding").toBeGreaterThan(50);
    expect(bare).toEqual([]);
  });
});
