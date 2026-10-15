// D14/D16/D25: what a registry consumer receives. The workspace keeps TS source exports until 2b (spec §5.2);
// publishConfig.exports must mirror every one of them into dist/.
//
// This file imports src/ (the sideEffects check loads the registry), so under Stryker's `vitest.related: true` it is a related test for
// every leg that reaches src/sport/registry.ts, and runs inside .stryker-tmp/sandbox-*, which holds packages/engine and nothing above it.
// It therefore must not load ESLint: eslint.config.mjs imports ../../scripts/lib/tools-import-guard.mjs, absent in a sandbox, and the
// dry run would stop with "failed tests in the initial test run". The lint-ignore assertion for dist/ lives in pack-proof.test.ts, which
// imports nothing from src/; test/stryker-sandbox-safe.test.ts holds that rule.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRegistry, registry } from "../src/sport/registry.ts";
import { builtinModules, registerBuiltins } from "../src/sports/index.ts";
import { DATA_EXPORTS, sourceSportDirs } from "../pack-proof/lib.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8"));
const buildConfig = JSON.parse(readFileSync(join(ENGINE, "tsconfig.build.json"), "utf8"));
const toDist = (src: string) => src.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
// the exports that are code (everything but the data files DATA_EXPORTS names): the ones a consumer can `import` and a bundler can walk
const moduleExports = Object.entries<string>(pkg.exports).filter(([k]) => !DATA_EXPORTS.has(k));

describe("publish manifest", () => {
  const keys = Object.keys(pkg.exports);

  it(`mirrors all ${keys.length} workspace exports into dist (never zero)`, () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const [k, target] of moduleExports) expect(pkg.publishConfig.exports[k], k).toEqual({ types: `${toDist(target)}.d.ts`, default: `${toDist(target)}.js` });
    expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual([...keys].sort());
    expect(moduleExports.length, "anti-vacuity: module exports mirrored").toBeGreaterThan(10);
  });

  it("exports the phone pin as a data file at the package root, the same in the workspace and in the published manifest, and ships it", () => {
    // not a module: no types/default conditions, no dist/ twin - the file itself, which `files` carries into the tarball
    expect([...DATA_EXPORTS]).toEqual([["./phone-subpaths.json", "phone-subpaths.json"]]);
    for (const [key, file] of DATA_EXPORTS) {
      expect(pkg.exports[key], `workspace ${key}`).toBe(`./${file}`);
      expect(pkg.publishConfig.exports[key], `published ${key}`).toBe(`./${file}`);
      expect(pkg.files, `${file} ships`).toContain(file);
      expect(existsSync(join(ENGINE, file)), `${file} exists beside package.json`).toBe(true);
    }
  });

  it("ships dist and rules/, nothing private, to GitHub Packages", () => {
    expect(pkg.private).toBeUndefined();
    // pnpm pack copies the repo's proprietary LICENSE.md into the tarball; the manifest has to say so rather than leave the registry's licence field blank
    expect(pkg.license).toBe("SEE LICENSE IN LICENSE.md");
    expect(pkg.files).toEqual(["dist", "rules", "phone-subpaths.json"]);
    expect(pkg.publishConfig.registry).toBe("https://npm.pkg.github.com");
    // the entry in `files` is only a promise: the directory has to be where the entry says (anti-vacuity for the line above).
    // NOTE: rules/ is read at runtime by one shipped module, src/testkit/rules-reference.ts (engine-split 1d-5; before it, only the
    // test-side checker read it and the directory shipped on the plan's say-so, D32f). pack-proof/node/rules.mjs parses it from the tarball.
    expect(existsSync(join(ENGINE, "rules")), "packages/engine/rules/ exists beside src/").toBe(true);
  });

  it("takes zod as a peer only, and declares the testkit's test-runner imports as optional peers", () => {
    expect(pkg.peerDependencies.zod).toBeDefined();
    expect(pkg.dependencies?.zod).toBeUndefined();
    expect(pkg.devDependencies.zod).toBeDefined();
    for (const p of ["fast-check", "vitest"]) {
      expect(pkg.peerDependencies[p], p).toBeDefined();
      expect(pkg.peerDependenciesMeta[p]).toEqual({ optional: true });
    }
  });

  it("records where the package lives, and only the dist build is named `build:dist` (a `build` script would join every turbo typecheck)", () => {
    expect(pkg.repository).toEqual({ type: "git", url: "https://github.com/onryde/seazn.club", directory: "packages/engine" });
    expect(typeof pkg.scripts["build:dist"]).toBe("string");
    expect(pkg.scripts.build).toBeUndefined();
  });

  it("clears dist before it emits, so a module deleted from src cannot survive a rebuild into the tarball", () => {
    // tsc only ever writes: without a clear, the .js of a deleted module stays in dist and `files` ships it.
    const steps = (pkg.scripts["build:dist"] as string).split(" && ");
    expect(steps, "clear, then emit — nothing else").toHaveLength(2);
    const [clear, emit] = steps as [string, string];
    expect(emit).toBe("node ../../node_modules/typescript-native/bin/tsc -p tsconfig.build.json");
    // run the clear step AS DECLARED, in a scratch package dir with a stale dist and a src that must survive it
    const dir = mkdtempSync(join(tmpdir(), "engine-clear-"));
    try {
      mkdirSync(join(dir, "dist/sub"), { recursive: true });
      writeFileSync(join(dir, "dist/stale-deleted-module.js"), "export {};\n");
      writeFileSync(join(dir, "dist/sub/old.d.ts"), "export {};\n");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/keep.ts"), "export {};\n");
      writeFileSync(join(dir, "package.json"), "{}\n");
      execFileSync("sh", ["-c", clear], { cwd: dir });
      expect(existsSync(join(dir, "dist")), "dist cleared").toBe(false);
      expect(existsSync(join(dir, "src/keep.ts")), "src untouched").toBe(true);
      expect(existsSync(join(dir, "package.json")), "package.json untouched").toBe(true);
      // the empty case: a first build has no dist yet, and a second clear must not fail
      execFileSync("sh", ["-c", clear], { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries each module's source inside its source map, because src is not in `files` and a map that points at it resolves to nothing", () => {
    expect(pkg.files).not.toContain("src");
    expect(buildConfig.compilerOptions.sourceMap).toBe(true);
    expect(buildConfig.compilerOptions.inlineSources).toBe(true);
  });

  it("has a README that names every public subpath, the registry, the install alias and the peers", () => {
    const readme = readFileSync(join(ENGINE, "README.md"), "utf8");
    // the subpaths come from the manifest's own exports, so a new export without a README line fails here
    for (const k of Object.keys(pkg.exports)) expect(readme, `README names the ${k} subpath`).toContain(`\`${k}\``);
    expect(readme).toContain("https://npm.pkg.github.com");
    expect(readme).toContain("@onryde:registry=https://npm.pkg.github.com");
    expect(readme).toContain("@seazn/engine@npm:@onryde/seazn-engine");
    // required peer vs optional peers, each named in the sentence that gives its status
    expect(readme).toMatch(/`zod`[^\n]*required/i);
    for (const p of Object.keys(pkg.peerDependenciesMeta)) expect(readme, `README names optional peer ${p}`).toContain(`\`${p}\``);
    expect(readme).toContain("docs/superpowers/specs/2026-10-13-engine-split-design.md");
  });

  it("emits the src tree into dist as .js with .d.ts beside it, so the toDist mapping above is the real one", () => {
    const o = buildConfig.compilerOptions;
    expect(o.rootDir).toBe("src");
    expect(o.outDir).toBe("dist");
    expect(o.noEmit).toBe(false);
    expect(o.declaration).toBe(true);
    // a declaration map points at ../../src, which does not ship, and inlineSources does not reach it: it would be 118 dead files
    expect(o.declarationMap, "declarationMap").not.toBe(true);
    // .ts specifiers in the source become .js in both the emit and the .d.ts, or a consumer cannot resolve a relative import
    expect(o.rewriteRelativeImportExtensions).toBe(true);
    expect(buildConfig.include).toEqual(["src"]);
    expect(buildConfig.exclude).toEqual(["src/**/*.test.ts", "src/**/__tests__/**"]);
  });
});

// The testkit barrel IS an export, so every bare package its import closure reaches ships to the consumer. A consumer that does
// not use the testkit never loads it, so the test-runner packages are optional peers; zod is a required peer because the kernel needs it.
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[^"';]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function closureOf(entry: string): { files: Set<string>; bare: Map<string, string> } {
  const files = new Set<string>();
  const bare = new Map<string, string>(); // package -> first file that imports it
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const m of source.matchAll(SPECIFIER)) {
      const spec = (m[1] ?? m[2] ?? m[3])!;
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else if (!spec.startsWith("node:")) {
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
        if (!bare.has(name)) bare.set(name, file.slice(ENGINE.length + 1));
      }
    }
  }
  return { files, bare };
}

describe("every bare package the exported entry points reach is declared for the consumer", () => {
  it("covers the testkit barrel's closure, whose conformance suite pulls in the test runner", () => {
    const { files, bare } = closureOf(join(ENGINE, "src/testkit/index.ts"));
    // anti-vacuity: a closure that walked nothing, or found no package, would make the declaration check below pass on nothing
    expect(files.size, "files in the testkit closure").toBeGreaterThan(10);
    expect([...bare.keys()], "bare packages in the testkit closure").toEqual(expect.arrayContaining(["zod", "fast-check", "vitest"]));
    const undeclared = [...bare].filter(([name]) => pkg.peerDependencies[name] === undefined).map(([name, from]) => `${name} (imported from ${from})`);
    expect(undeclared).toEqual([]);
  });

  it("covers every exported entry point, so a bare package outside the testkit cannot ship undeclared", () => {
    let entries = 0;
    for (const [, target] of moduleExports) {
      if (target.includes("*")) continue; // the sports/* wildcard is walked through ./sports
      entries++;
      const { bare } = closureOf(join(ENGINE, target));
      const undeclared = [...bare].filter(([name]) => pkg.peerDependencies[name] === undefined).map(([name, from]) => `${name} (imported from ${from})`);
      expect(undeclared, target).toEqual([]);
    }
    expect(entries, "entry points checked").toBeGreaterThan(10);
  });
});

// `sideEffects: false` lets a bundler drop an import that binds nothing. That is safe only while importing the engine does nothing the
// consumer needs: the sport registry is filled by an explicit registerBuiltins(), never as a side effect of loading a module.
// scripts/__tests__/engine-bare-imports.test.ts proves the other half (no consumer writes a binding-less import of the engine).
describe("sideEffects: false", () => {
  it("is declared", () => {
    expect(pkg.sideEffects).toBe(false);
  });

  it("holds: loading every exported entry point registers no sport into the shared registry", async () => {
    // the exports without a wildcard, and every concrete subpath the `./sports/*` wildcard expands to: one directory per sport family, each
    // reached by a consumer as `@seazn/engine/sports/<dir>` and none of them loaded by `./sports` itself
    const wildcard = moduleExports.map(([, t]) => t).filter((t) => t.includes("*"));
    expect(wildcard, "the one wildcard export is ./sports/*").toEqual(["./src/sports/*/index.ts"]);
    const sportDirs = sourceSportDirs(ENGINE);
    expect(sportDirs.length, "sport directories under src/sports").toBeGreaterThan(5);
    const entries = [...moduleExports.map(([, t]) => t).filter((t) => !t.includes("*")), ...sportDirs.map((d) => wildcard[0]!.replace("*", d))];
    for (const t of entries) await import(join(ENGINE, t));
    // the keys come from the engine's own declaration of what ships, never a list typed here
    expect(builtinModules.length, "shipped sport modules").toBeGreaterThan(0);
    for (const m of builtinModules) expect(() => registry.latest(m.key), `${m.key} registered by import alone`).toThrow();
    // the control: the same probe on a registry that WAS filled does find them, so the throw above is "nothing registered"
    const filled = createRegistry();
    registerBuiltins(filled);
    for (const m of builtinModules) expect(filled.latest(m.key).key).toBe(m.key);
    expect(entries.length, "entry points loaded").toBeGreaterThan(10);
  });
});
