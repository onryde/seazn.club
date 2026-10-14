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
/** A static import that binds nothing: `import "@seazn/engine/x";` — the quote follows `import` directly, with no `from` between. */
const BARE_IMPORT = /^[ \t]*import[ \t]*["'](?:@seazn\/engine|@onryde\/seazn-engine)[^"']*["']/gm;
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
    expect([...'import {\n  a,\n} from "@seazn/engine/core";\n'.matchAll(BOUND_IMPORT)]).toHaveLength(1);
  });

  it("finds no bare static import of the engine under apps/, packages/, tools/ or scripts/", () => {
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
