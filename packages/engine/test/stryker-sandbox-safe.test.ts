// Engine-split batch 1b review, B1. Stryker runs with `vitest.related: true` (stryker.config.mjs): the dry run executes the test files that
// import (directly or through other files) a mutated source file, inside .stryker-tmp/sandbox-*. A sandbox holds packages/engine and
// NOTHING above it, and `new ESLint({ cwd })` loads eslint.config.mjs, whose imports climb to ../../scripts/lib/tools-import-guard.mjs.
// So a test that both reaches src/ and loads ESLint is a test the dry run cannot pass: "failed tests in the initial test run", every leg
// that touches the files it reaches, and a PR whose own mutation probe never reaches it stays green. 1b-2 shipped exactly that
// (publish-manifest.test.ts); the lint assertion moved to pack-proof.test.ts, which imports nothing from src/.
//
// This holds the rule, not the one file: no engine test file that imports ESLint reaches src/ through its static imports.
//
// The same sandbox breaks test/layout.ts (engine-split 1d-1): it asks git where the engine sits in its checkout, and the sandbox is a
// copy under .stryker-tmp/, so `git rev-parse --show-prefix` answers ".stryker-tmp/sandbox-x/" (or "packages/engine/.stryker-tmp/...") and
// every path built from ENGINE_PREFIX or GIT_TOPLEVEL is wrong (or git is absent and the import throws). So the second rule: no engine
// test file that reaches test/layout.ts, directly or through a helper, reaches src/.
// Single-sport reason: no sport is involved - this is a file-graph rule.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { treeBudget } from "./tree-budget.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const IMPORTS_ESLINT = /\bfrom\s*["']eslint["']|\bimport\s*\(\s*["']eslint["']\s*\)|\brequire\s*\(\s*["']eslint["']\s*\)|\bimport\s*["']eslint["']/;
/** Every relative module specifier a file names: `from "./x"`, `import "./x"`, `import("./x")`, `export * from "./x"`. */
const RELATIVE = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;

/** The file a relative specifier means (the exact file, or with an extension, or a directory's index), or null when it is not a file. */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, "index.ts"), join(base, "index.mjs")]) {
    if (existsSync(candidate) && !readdirOrNull(candidate)) return candidate;
  }
  return null;
}
const readdirOrNull = (p: string) => {
  try {
    return readdirSync(p);
  } catch {
    return null;
  }
};

/** The files `file` reaches through relative static imports (itself included), staying inside `engineDir`. */
function reachable(file: string, engineDir: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  if (!/\.(ts|mjs|js)$/.test(file)) return seen;
  for (const m of readFileSync(file, "utf8").matchAll(RELATIVE)) {
    const target = resolveSpecifier(file, m[1]!);
    if (target !== null && !relative(engineDir, target).startsWith("..")) reachable(target, engineDir, seen);
  }
  return seen;
}

/** Every test file under `test/` and `src/` of the engine package. */
function testFiles(engineDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts")) out.push(p);
    }
  };
  for (const d of ["test", "src"]) if (existsSync(join(engineDir, d))) walk(join(engineDir, d));
  return out;
}

/** The test files that import ESLint (`eslint`) and, through their relative imports, reach a file under src/. `loadsEslint` is how many
 *  files import it at all, which the real tree must not leave at zero (a scan that found no ESLint test would pass on anything). */
function eslintTestsReachingSrc(engineDir: string): { scanned: number; loadsEslint: string[]; offenders: string[] } {
  const files = testFiles(engineDir);
  const srcDir = join(engineDir, "src") + "/";
  const loadsEslint = files.filter((f) => IMPORTS_ESLINT.test(readFileSync(f, "utf8")));
  const offenders = loadsEslint.filter((f) => [...reachable(f, engineDir)].some((r) => r.startsWith(srcDir)));
  return { scanned: files.length, loadsEslint: loadsEslint.map((f) => relative(engineDir, f)), offenders: offenders.map((f) => relative(engineDir, f)) };
}

/** The test files that reach test/layout.ts through their relative imports (directly or through a helper) and, through them, a file under
 *  src/. `importers` is how many reach the layout at all, which the real tree must not leave at zero. */
function layoutTestsReachingSrc(engineDir: string): { scanned: number; importers: string[]; offenders: string[] } {
  const files = testFiles(engineDir);
  const srcDir = join(engineDir, "src") + "/";
  const layout = join(engineDir, "test/layout.ts");
  const importers = files.filter((f) => reachable(f, engineDir).has(layout));
  const offenders = importers.filter((f) => [...reachable(f, engineDir)].some((r) => r.startsWith(srcDir)));
  return { scanned: files.length, importers: importers.map((f) => relative(engineDir, f)), offenders: offenders.map((f) => relative(engineDir, f)) };
}

// The two tests on the REAL package each walk every test file's import closure (a test file's closure is read again for each file that
// reaches it), twice over: one pass to find the importers, one to find the offenders. Measured under load that took 7.8 s against vitest's
// 5 s default (AGENTS class 20), so the budget is derived from the number of test files it walks, as the tree-wide tests' is.
const REAL_SCAN_MS = treeBudget(testFiles(ENGINE).length, 2);

// spelled in two halves so THIS file's text holds no `from "eslint"` of its own (the scan reads every test file, this one included)
const E = ["es", "lint"].join("");
// created when the tests start, not at module load: a run that selects none of this file's tests (`-t`, `vitest related`, the parity
// collect) must not leave a directory behind
let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "sandbox-safe-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); expect(existsSync(scratch), "the scratch directory is gone").toBe(false); });
let n = 0;
/** A scratch engine package: `files` maps a path under it to its text. */
function tree(files: Record<string, string>): string {
  const dir = join(scratch, `engine-${n++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("no engine test that loads ESLint reaches src/ (Stryker's related set runs in a sandbox with no ../../scripts)", () => {
  it("holds on the real package, and the scan saw both the tests and an ESLint test", () => {
    const r = eslintTestsReachingSrc(ENGINE);
    expect(r.scanned, "test files scanned").toBeGreaterThan(50);
    // anti-vacuity: pack-proof.test.ts is the ESLint test that is meant to exist; a scan that stops finding it has stopped looking
    expect(r.loadsEslint).toContain("test/pack-proof.test.ts");
    expect(r.offenders).toEqual([]);
  }, REAL_SCAN_MS);

  it("publish-manifest.test.ts reaches src/ (it is a related test for the registry) and loads no ESLint: the case that failed the dry run", () => {
    const file = join(ENGINE, "test/publish-manifest.test.ts");
    const reached = [...reachable(file, ENGINE)].map((f) => relative(ENGINE, f));
    expect(reached.some((f) => f.startsWith("src/sport/registry.ts")), "reaches src/sport/registry.ts").toBe(true);
    expect(IMPORTS_ESLINT.test(readFileSync(file, "utf8"))).toBe(false);
  });

  it("catches a test that imports ESLint and src/ directly, through a helper, through an index, and by a dynamic import", () => {
    const eslint = `import { ESLint } from "${E}";\n`;
    const dir = tree({
      "src/a.ts": "export const a = 1;\n",
      "src/sub/index.ts": "export const s = 1;\n",
      "test/helper.ts": 'export { a } from "../src/a.ts";\n',
      "test/direct.test.ts": `${eslint}import { a } from "../src/a.ts";\n`,
      "test/indirect.test.ts": `${eslint}import { a } from "./helper.ts";\n`,
      "test/via-index.test.ts": `${eslint}import { s } from "../src/sub";\n`,
      "test/dynamic.test.ts": `${eslint}await import("../src/a.ts");\n`,
      "test/extensionless.test.ts": `${eslint}import { a } from "./helper";\n`,
    });
    const r = eslintTestsReachingSrc(dir);
    expect(r.offenders.sort()).toEqual(["test/direct.test.ts", "test/dynamic.test.ts", "test/extensionless.test.ts", "test/indirect.test.ts", "test/via-index.test.ts"]);
    expect(r.scanned).toBe(5);
  });

  it("passes a test that imports ESLint and nothing of src/, a src-importing test with no ESLint, and an ESLint test whose import chain stays in test/ and pack-proof/", () => {
    const dir = tree({
      "src/a.ts": "export const a = 1;\n",
      "pack-proof/lib.mjs": "export const x = 1;\n",
      "test/helper.ts": 'export { x } from "../pack-proof/lib.mjs";\n',
      "test/lint-only.test.ts": `import { ESLint } from "${E}";\nimport { x } from "./helper.ts";\n`,
      "test/src-only.test.ts": 'import { a } from "../src/a.ts";\n',
      "test/requires.test.ts": `const { ESLint } = require("${E}");\nimport { x } from "../pack-proof/lib.mjs";\n`,
    });
    const r = eslintTestsReachingSrc(dir);
    expect(r.offenders).toEqual([]);
    expect(r.loadsEslint.sort()).toEqual(["test/lint-only.test.ts", "test/requires.test.ts"]);
    expect(r.scanned).toBe(3);
  });

  it("is not fooled by a cycle in the import graph, and counts an ESLint test under src/ itself as reaching src/", () => {
    const dir = tree({
      "test/a.test.ts": `import { ESLint } from "${E}";\nimport "./b.ts";\n`,
      "test/b.ts": 'import "./a.test.ts";\n',
      "src/lint.test.ts": `import { ESLint } from "${E}";\n`,
    });
    expect(eslintTestsReachingSrc(dir).offenders).toEqual(["src/lint.test.ts"]);
  });
});

describe("no engine test that reads the checkout layout reaches src/ (test/layout.ts is wrong inside a Stryker sandbox)", () => {
  it("holds on the real package, and the scan saw both the tests and a layout importer", () => {
    const r = layoutTestsReachingSrc(ENGINE);
    expect(r.scanned, "test files scanned").toBeGreaterThan(50);
    // anti-vacuity: stryker-outputs-ignored.test.ts is a layout importer that is meant to exist; a scan that stops finding one has stopped looking
    expect(r.importers).toContain("test/stryker-outputs-ignored.test.ts");
    expect(r.offenders).toEqual([]);
  }, REAL_SCAN_MS);

  it("catches a layout importer that reaches src/ directly, through a helper, through an index, and by a dynamic import", () => {
    const dir = tree({
      "src/a.ts": "export const a = 1;\n",
      "src/sub/index.ts": "export const s = 1;\n",
      "test/layout.ts": "export const ENGINE_PREFIX = '';\n",
      "test/helper.ts": 'export { a } from "../src/a.ts";\n',
      "test/direct.test.ts": 'import { ENGINE_PREFIX } from "./layout.ts";\nimport { a } from "../src/a.ts";\n',
      "test/indirect.test.ts": 'import { ENGINE_PREFIX } from "./layout.ts";\nimport { a } from "./helper.ts";\n',
      "test/via-index.test.ts": 'import { ENGINE_PREFIX } from "./layout.ts";\nimport { s } from "../src/sub";\n',
      "test/dynamic.test.ts": 'import { ENGINE_PREFIX } from "./layout.ts";\nawait import("../src/a.ts");\n',
      "test/extensionless.test.ts": 'import { ENGINE_PREFIX } from "./layout";\nimport { a } from "./helper";\n',
      "test/layout-via-helper.ts": 'export { ENGINE_PREFIX } from "./layout.ts";\n',
      "test/through-helper.test.ts": 'import { ENGINE_PREFIX } from "./layout-via-helper.ts";\nimport { a } from "../src/a.ts";\n',
    });
    const r = layoutTestsReachingSrc(dir);
    expect(r.offenders.sort()).toEqual(["test/direct.test.ts", "test/dynamic.test.ts", "test/extensionless.test.ts", "test/indirect.test.ts", "test/through-helper.test.ts", "test/via-index.test.ts"]);
    expect(r.importers.length, "every case imports the layout").toBe(6);
    expect(r.scanned).toBe(6);
  });

  it("passes a layout importer that never reaches src/, and a src-importing test that never reaches the layout", () => {
    const dir = tree({
      "src/a.ts": "export const a = 1;\n",
      "test/layout.ts": "export const ENGINE_PREFIX = '';\n",
      "test/layout-only.test.ts": 'import { ENGINE_PREFIX } from "./layout.ts";\n',
      "test/src-only.test.ts": 'import { a } from "../src/a.ts";\n',
    });
    const r = layoutTestsReachingSrc(dir);
    expect(r.offenders).toEqual([]);
    expect(r.importers).toEqual(["test/layout-only.test.ts"]);
    expect(r.scanned).toBe(2);
  });

  it("is not fooled by a cycle through the layout, and counts a layout importer under src/ itself as reaching src/", () => {
    const dir = tree({
      "test/layout.ts": 'import "./a.test.ts";\n',
      "test/a.test.ts": 'import "./layout.ts";\n',
      "src/uses-layout.test.ts": 'import "../test/layout.ts";\n',
    });
    expect(layoutTestsReachingSrc(dir).offenders).toEqual(["src/uses-layout.test.ts"]);
  });
});
