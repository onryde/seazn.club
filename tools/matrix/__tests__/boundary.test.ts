// R3 / ruling 17 as a gate, not a convention: the harness imports only the
// bench's small helpers, only two apps/web files (the builder's templates and,
// from W1b Task 5, the match-rules table the variant set is built from), and
// the invariant layer is type-only so W1b's fast-check model and W10's shadow
// checks can reuse it.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(MATRIX, "..", "..");
// Full repo-relative paths, never basenames: tools/bench/lib/drivers/http.ts
// is a different module that a basename check would wave through as "http.ts".
const ALLOWED_BENCH = new Set([
  "tools/bench/lib/http.ts", "tools/bench/lib/plan.ts", "tools/bench/lib/env.ts",
  // Ruling 38 (2026-09-29): the tap vocabulary, the ledger reader, the generic adapter and the
  // consent/device-link helpers are imported, not copied. scorer.ts and tap-play.ts reach
  // pack-schema through simulate.ts — a second transitive load ruling 38 accepts by name.
  "tools/bench/lib/ledger.ts", "tools/bench/lib/drivers/scorer.ts",
  "tools/bench/lib/drivers/adapters/generic.ts", "tools/bench/lib/tap-play.ts",
]);
// W2a Task 14 (phase 3): organiser-only-events.ts is the PRODUCT's own list of the events only an organiser may author
// (isOrganiserOnlyEvent); the browser driver routes those through the console by that predicate, never a second list.
// The module imports nothing (pinned below), so plain node loads it with no alias.
const ORGANISER_ONLY_EVENTS = "apps/web/src/lib/organiser-only-events.ts";
const ALLOWED_WEB = new Set(["apps/web/src/lib/format-templates.ts", "apps/web/src/lib/match-rules.ts", ORGANISER_ONLY_EVENTS]);
const FORBIDDEN = ["run-suite", "pack-schema", "seed.ts", "seed-plan", "validate-pack", "scripts/smoke"];
const TYPE_ONLY = new Set(["lib/invariants.ts", "lib/observed.ts"]);
// The bench is also the @seazn/bench workspace (2026-10-04). A bare
// `@seazn/bench/<sub>` specifier would reach it with no relative path, so it
// would get past both the ALLOWED_BENCH check and closure(), which read
// relative specifiers only. Matrix -> bench imports stay relative. That keeps
// one spelling, and the allowlist sees every import. This is refused, not
// mapped, because mapping would leave two spellings (controller ruling BT-R3).
const BENCH_PACKAGE = /^@seazn\/bench(?:\/|$)/;

function shipped(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__") shipped(full, out); continue; }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// Three import shapes: `import|export … from "x"`, dynamic `import("x")` (any
// quote, backtick included), and the bare side-effect `import "x";`. The third
// has no `from`, so the first alternative cannot see it — and a side-effect
// import of seed.ts is exactly what this gate exists to stop (found by
// mutation: without the third alternative, `import "../../bench/lib/seed.ts";`
// stayed green; without the backtick, `` import(`…/seed.ts`) `` did).
//
// ASSUMES SEMICOLON-TERMINATED STATEMENTS (the repo style; not enforced by a
// formatter). `[^;]*?` is the statement boundary, so in semicolon-less source
// a bare import followed by another import is swallowed, and `export type X =
// Y` followed by a value import marks that import type-only. Known, not fixed.
const SPEC = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|import\(\s*["'`]([^"'`]+)["'`]\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

/** `dynamic`: an `import("x")` expression, which loads only when it runs —
 *  never at module load (W1c Task 6, ruling A). */
function importsOf(file: string): { spec: string; typeOnly: boolean; dynamic: boolean }[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(SPEC)].map((m) => ({ spec: (m[3] ?? m[4] ?? m[5])!, typeOnly: m[2] !== undefined, dynamic: m[4] !== undefined }));
}

/** Every `.ts` file a module LOAD reaches from `roots`: relative static VALUE
 *  imports only (a type import is erased under strip-types and loads nothing;
 *  a dynamic `import()` loads only when its code runs, and every one is pinned
 *  by exact set below), and only specs that name an existing `.ts` file —
 *  exactly what node follows. Bare packages and apps/web's `@/` alias are not
 *  walked. */
function closure(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, typeOnly, dynamic } of importsOf(file)) {
      // Refused before the skip below, which would otherwise wave it through as a package.
      if (BENCH_PACKAGE.test(spec)) throw new Error(`${relative(REPO, file)} imports ${spec}: reach the bench by relative path, never by package name`);
      if (typeOnly || dynamic || !spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (target.endsWith(".ts") && existsSync(target)) stack.push(target);
    }
  }
  return seen;
}

const MODULES = shipped(MATRIX).sort();

/** W1d Task 7 (ruling T6-LIVEPLAN): production code never depends on a test module. lib/judge.ts imported
 *  `__tests__/committed-plans.ts` for `livePlan`, so `matrix:judge` loaded a test fixture's module graph.
 *  A spec reaches one when any of its path segments is the test directory. */
const reachesTests = (spec: string): boolean => spec.startsWith(".") && spec.split("/").includes("__tests__");

describe("tools/matrix import boundary", () => {
  it("discovery guard: the walker finds the shipped modules (an empty set would pass vacuously)", () => {
    expect(MODULES.length).toBeGreaterThan(0);
    expect(MODULES.some((f) => f.endsWith("lib/catalogue.ts"))).toBe(true);
  });

  it.each(MODULES.map((f) => [relative(MATRIX, f), f]))("%s imports only allowed modules", (_rel, file) => {
    for (const { spec } of importsOf(file)) {
      expect(FORBIDDEN.some((bad) => spec.includes(bad)), `${spec}`).toBe(false);
      expect(BENCH_PACKAGE.test(spec), `${spec}: reach the bench by relative path, never by package name`).toBe(false);
      expect(reachesTests(spec), `${spec}: a shipped module imports a test module (ruling T6-LIVEPLAN) — hoist what it needs into lib/`).toBe(false);
      if (!spec.startsWith(".")) continue;
      const target = relative(REPO, resolve(dirname(file), spec));
      if (target.startsWith("tools/bench/")) expect(ALLOWED_BENCH.has(target), target).toBe(true);
      if (target.startsWith("apps/web/")) expect(ALLOWED_WEB.has(target), target).toBe(true);
    }
  });

  it("the product's organiser-only predicate is a file plain node can load: it exists and imports nothing, and only the browser driver names it", () => {
    const file = join(REPO, ORGANISER_ONLY_EVENTS);
    expect(existsSync(file), ORGANISER_ONLY_EVENTS).toBe(true);
    expect(importsOf(file), `${ORGANISER_ONLY_EVENTS} must stay import-free`).toEqual([]);
    const naming = MODULES.filter((m) => importsOf(m).some((i) => i.spec.startsWith(".") && relative(REPO, resolve(dirname(m), i.spec)) === ORGANISER_ONLY_EVENTS)).map((m) => relative(MATRIX, m));
    expect(naming).toEqual(["lib/driver/browser-driver.ts"]);
  });

  it("the test-module check sees every import shape it is held to, and no shipped module reaches __tests__ (anti-vacuity: the scan reads every module)", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-boundary-tests-"));
    try {
      const probe = join(dir, "probe.ts");
      writeFileSync(probe, 'import { a } from "../__tests__/committed-plans.ts";\nexport { b } from "../../__tests__/x.ts";\nimport "./__tests__/y.ts";\nconst c = await import("../__tests__/z.ts");\nimport { ok } from "../lib/ok.ts";\nimport { node } from "node:fs";\nimport { m } from "../__tests__x/no.ts";\n');
      const specs = importsOf(probe).map((i) => i.spec);
      expect(specs.filter(reachesTests)).toEqual(["../__tests__/committed-plans.ts", "../../__tests__/x.ts", "./__tests__/y.ts", "../__tests__/z.ts"]);
      expect(specs.filter((s) => !reachesTests(s))).toEqual(["../lib/ok.ts", "node:fs", "../__tests__x/no.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    let scanned = 0;
    const offenders: string[] = [];
    for (const file of MODULES) {
      for (const { spec } of importsOf(file)) if (reachesTests(spec)) offenders.push(`${relative(MATRIX, file)}: ${spec}`);
      scanned++;
    }
    expect(offenders).toEqual([]);
    expect(scanned).toBe(MODULES.length);
    expect(scanned).toBeGreaterThan(50);
  });

  it("the bench is reached by relative path only: a bare @seazn/bench specifier is refused, by the per-module check and by closure()", () => {
    const refused = ["@seazn/bench", "@seazn/bench/lib/board.ts", "@seazn/bench/lib/env.ts"];
    const passed = ["@seazn/benchx", "@seazn/engine", "../../bench/lib/env.ts", "../bench/lib/http.ts"];
    expect(refused.filter((s) => !BENCH_PACKAGE.test(s))).toEqual([]);
    expect(passed.filter((s) => BENCH_PACKAGE.test(s))).toEqual([]);
    // closure() throws rather than skipping the specifier as a bare package. A
    // decoy file in the same directory is walked without a throw.
    const dir = mkdtempSync(join(tmpdir(), "matrix-boundary-"));
    try {
      const probe = join(dir, "probe.ts");
      const decoy = join(dir, "decoy.ts");
      writeFileSync(probe, 'import "@seazn/bench/lib/board.ts";\n');
      writeFileSync(decoy, 'import "@seazn/benchx";\n');
      expect(() => closure([probe])).toThrow(/imports @seazn\/bench\/lib\/board\.ts/);
      expect([...closure([decoy])]).toEqual([decoy]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // PF7: the two TYPE_ONLY modules may VALUE-import each other (invariants.ts
  // reuses observed.ts's pure helpers rather than duplicating them) and nothing
  // else. Both files are checked, so the pair as a whole stays free of engine,
  // HTTP, bench, apps/web and node: value imports. Only `import type` /
  // `export type … from` count as type-only: `import { type X }` is read as a
  // value import (the regex keys on the statement keyword), so write the
  // statement form.
  it("invariants.ts and observed.ts import types only, except each other (reusable by W1b fast-check and W10 shadow checks)", () => {
    const pair = new Set([...TYPE_ONLY].map((rel) => join(MATRIX, rel)));
    let files = 0;
    for (const rel of TYPE_ONLY) {
      const file = join(MATRIX, rel);
      // Both must exist: a missing file would skip its whole check (vacuous).
      expect(MODULES, `${rel} is not a shipped module`).toContain(file);
      files++;
      const imports = importsOf(file);
      expect(imports.length, `${rel}: no imports parsed (the regex read nothing)`).toBeGreaterThan(0);
      for (const imp of imports) {
        if (imp.typeOnly) continue;
        const target = imp.spec.startsWith(".") ? resolve(dirname(file), imp.spec) : null;
        expect(target !== null && target !== file && pair.has(target), `${rel}: value import of ${imp.spec}`).toBe(true);
      }
    }
    expect(files).toBe(TYPE_ONLY.size);
  });
});

// W1c Task 4, ruling 38: the bench's tap helpers are imported — but only the
// sport-blind parts of scorer.ts and tap-play.ts.
describe("ruling 38: what the matrix may take from the bench", () => {
  // Ruling 38: the bench's match loop fixes the widths (organiser 1280, scorer 390) and always
  // finalizes, which breaks HTTP parity. Refused by name wherever it is imported from.
  const REFUSED_BENCH_EXPORTS = ["playMatchByTaps", "createTapPlayer", "browserTapPlayer"];
  it.each(MODULES.map((f) => [relative(MATRIX, f), f]))("%s never imports the bench match loop", (_rel, file) => {
    const src = readFileSync(file, "utf8");
    for (const name of REFUSED_BENCH_EXPORTS) expect(new RegExp(`\\b${name}\\b`).test(src), name).toBe(false);
  });

  // Transitively: everything a real load of every shipped module reaches.
  //
  // One forbidden name IS reached today, and was before W1c (found by this
  // test, Task 4): run.ts imports bench plan.ts (provisionPlan, allowed since
  // W1a), and plan.ts value-imports seed.ts for its defaultTransport. That one
  // chain is pinned by its importer, so any NEW way into seed.ts — or into any
  // other forbidden file — reds; routed to the controller for a ruling.
  const TRANSITIVE_FORBIDDEN = ["run-suite", "seed.ts", "seed-plan", "validate-pack", "scripts/smoke"];
  const KNOWN_TRANSITIVE: Readonly<Record<string, readonly string[]>> = { "tools/bench/lib/seed.ts": ["tools/bench/lib/plan.ts"] };
  /** Within `files`, the ones that value-import `target`. */
  const importersOf = (files: ReadonlySet<string>, target: string) => [...files]
    .filter((f) => importsOf(f).some((i) => !i.typeOnly && i.spec.startsWith(".") && resolve(dirname(f), i.spec) === resolve(REPO, target)))
    .map((f) => relative(REPO, f)).sort();
  it("the value-import closure of every shipped module stays clear of the bench's suite runner, seeding and pack validation", () => {
    const files = closure(MODULES);
    const reached = [...files].map((f) => relative(REPO, f)).sort();
    console.info(`boundary: the shipped matrix modules' value-import closure reaches ${reached.length} files`);
    expect(reached.length).toBeGreaterThan(50);
    const bad = reached.filter((f) => TRANSITIVE_FORBIDDEN.some((x) => f.includes(x)));
    expect(bad).toEqual(Object.keys(KNOWN_TRANSITIVE));
    for (const f of bad) expect(importersOf(files, f), `${f} is reached through a new importer`).toEqual(KNOWN_TRANSITIVE[f]);
  });
  // pack-schema is reached through scorer.ts/tap-play.ts -> simulate.ts, which
  // ruling 38 accepts by name. It is ALSO reached through plan.ts -> seed.ts
  // (above), so "pack-schema is visited" alone could not witness the ruling-38
  // chain; this pins simulate.ts as one of its importers. If a refactor drops
  // that load, this reds and the ruling-38 comment is re-read.
  it("pack-schema is reached through simulate.ts, the chain ruling 38 accepts by name", () => {
    const files = closure(MODULES);
    expect(importersOf(files, "tools/bench/lib/pack-schema.ts")).toContain("tools/bench/lib/simulate.ts");
    expect(importersOf(files, "tools/bench/lib/simulate.ts")).toContain("tools/bench/lib/drivers/scorer.ts");
  });

  // So the L3 path never loads a browser. Two checks. This one is DIRECT and
  // covers every .ts under tools/matrix, tests included: only the browser
  // layer names playwright in its own imports. Type-only imports count too:
  // nothing outside the browser layer has a reason to name a Page. The two
  // closure tests below carry the transitive half.
  const BROWSER_LAYER = (rel: string) => rel.startsWith("lib/browser/") || rel.startsWith("lib/pads/") || rel === "lib/driver/browser-driver.ts";
  /** W1d item 11: every spelling that loads (or names) playwright: the library, its subpaths and the test runner. */
  const namesPlaywright = (spec: string): boolean => spec === "playwright" || spec.startsWith("playwright/") || spec === "@playwright/test";
  /** The file's own imports name playwright, type-only ones included (nothing outside the browser layer has a reason to name a Page). */
  const namesPlaywrightIn = (f: string): boolean => importsOf(f).some((i) => namesPlaywright(i.spec));
  function everyTs(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") everyTs(full, out); continue; }
      if (e.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }
  it("no file under tools/matrix outside lib/browser, lib/pads and lib/driver/browser-driver.ts imports playwright", () => {
    const files = everyTs(MATRIX);
    expect(files.length).toBeGreaterThan(MODULES.length);
    const bad = files.filter((f) => !BROWSER_LAYER(relative(MATRIX, f)) && namesPlaywrightIn(f)).map((f) => relative(MATRIX, f));
    expect(bad).toEqual([]);
    // Positive pair: the scan does see the browser layer's own import.
    expect(namesPlaywrightIn(join(MATRIX, "lib/browser/session.ts"))).toBe(true);
  });
  // W1d item 11 (Task 13): the scan above matched `spec === "playwright"` alone, so `playwright/test` and the test
  // runner's `@playwright/test` (which loads the same library) passed it. Each spelling has a fixture the scan must
  // catch, and each lookalike a fixture it must not; the real-tree scan then reports zero hits over a non-zero count.
  it("the playwright scans catch every spelling that loads it and pass every lookalike, in each import shape", () => {
    const positives = ["playwright", "playwright/test", "playwright/lib/x", "@playwright/test"];
    // `@playwright/other` is a lookalike BY DESIGN: the scan names the test runner and nothing else under that scope
    // (no import of one exists in the tree); a second scoped package that loads playwright is a decision to add.
    const negatives = ["./playwright.ts", "../lib/playwright", "playwrightx", "playwright-extra-thing", "my-playwright/test", "@playwrightx/test", "@playwright", "@playwright/other"];
    const shapes: readonly (readonly [string, (spec: string) => string])[] = [
      ["value import", (s) => `import { chromium } from "${s}";\n`],
      ["type import", (s) => `import type { Page } from "${s}";\n`],
      ["export from", (s) => `export { test } from "${s}";\n`],
      ["side-effect import", (s) => `import "${s}";\n`],
      ["dynamic import", (s) => `const m = await import("${s}");\n`],
    ];
    const dir = mkdtempSync(join(tmpdir(), "matrix-boundary-pw-"));
    try {
      let caught = 0;
      let passed = 0;
      for (const [shape, text] of shapes) {
        for (const [i, spec] of [...positives, ...negatives].entries()) {
          const file = join(dir, `${shape.replace(/\W/g, "-")}-${i}.ts`);
          writeFileSync(file, text(spec));
          const want = positives.includes(spec);
          expect(namesPlaywrightIn(file), `${shape}: ${spec}`).toBe(want);
          // The closure walk's loader scan: a value or dynamic import loads it, a type import is erased.
          expect(playwrightLoaders([file]).length > 0, `${shape}: ${spec} (loader scan)`).toBe(want && shape !== "type import");
          if (want) caught++; else passed++;
        }
      }
      expect(caught).toBe(shapes.length * positives.length);
      expect(passed).toBe(shapes.length * negatives.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // The scan above reads each file's OWN imports. A module that loads
  // playwright two hops away passes it, so the L3 guarantee is proven over each
  // non-browser module's whole value-import closure (Task 4 review, I-1).
  const OUTSIDE = MODULES.filter((f) => !BROWSER_LAYER(relative(MATRIX, f)));
  const SESSION = join(MATRIX, "lib/browser/session.ts");
  /** The files in `files` that VALUE-import playwright (a type import is erased and loads nothing). */
  const playwrightLoaders = (files: Iterable<string>) => [...files].filter((f) => importsOf(f).some((i) => namesPlaywright(i.spec) && !i.typeOnly));
  /** The shortest value-import chain from `root` to `target`, over the same edges closure() walks. */
  function chain(root: string, target: string): string {
    const parent = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (file === target) break;
      for (const { spec, typeOnly, dynamic } of importsOf(file)) {
        if (typeOnly || dynamic || !spec.startsWith(".")) continue;
        const next = resolve(dirname(file), spec);
        if (!next.endsWith(".ts") || !existsSync(next) || parent.has(next)) continue;
        parent.set(next, file);
        queue.push(next);
      }
    }
    expect(parent.has(target), `${relative(MATRIX, target)} is not reachable from ${relative(MATRIX, root)}`).toBe(true);
    const hops: string[] = [];
    for (let f: string | null = target; f !== null; f = parent.get(f) ?? null) hops.unshift(relative(MATRIX, f));
    return hops.join(" -> ");
  }

  // Found by these tests (Task 4 and its review), pre-existing since W1a: bench
  // env.ts imports playwright's `chromium` at its top (its preflight resolves
  // the Chromium executable; it launches nothing), run.ts imports env.ts for
  // runPreflight, and model.ts imports run.ts for its deps and exit codes. So
  // both L3 entry points already load the playwright LIBRARY. Each is pinned
  // with the chain that reaches it: a new module that loads playwright, by any
  // number of hops, reds here. Routed to the controller.
  const KNOWN_PLAYWRIGHT_LOADS: Readonly<Record<string, readonly string[]>> = {
    "model.ts": ["model.ts -> run.ts -> ../bench/lib/env.ts"],
    "run.ts": ["run.ts -> ../bench/lib/env.ts"],
  };
  it("exactly the known non-browser modules load playwright anywhere in their value-import closure, each by its recorded chain", () => {
    let checked = 0;
    const found: Record<string, string[]> = {};
    for (const m of OUTSIDE) {
      const files = closure([m]);
      checked += files.size;
      const loaders = playwrightLoaders(files);
      if (loaders.length > 0) found[relative(MATRIX, m)] = loaders.map((l) => chain(m, l)).sort();
    }
    console.info(`boundary: ${OUTSIDE.length} non-browser modules, ${checked} closure files read for a playwright load`);
    // Non-vacuity: the two L3 entry points are among the modules checked, and the walks read files.
    expect(OUTSIDE.map((f) => relative(MATRIX, f))).toEqual(expect.arrayContaining(["run.ts", "model.ts"]));
    expect(checked).toBeGreaterThan(OUTSIDE.length);
    expect(found).toEqual(KNOWN_PLAYWRIGHT_LOADS);
    // Positive pair: the same walk sees the browser layer's own load.
    expect(playwrightLoaders(closure([SESSION])).map((f) => relative(MATRIX, f))).toContain("lib/browser/session.ts");
  });

  it("no shipped module outside the browser layer reaches lib/browser/ or lib/pads/ in its value-import closure", () => {
    let checked = 0;
    const bad = OUTSIDE.flatMap((m) => {
      const files = [...closure([m])];
      checked += files.length;
      return files.filter((f) => /^lib\/(browser|pads)\//.test(relative(MATRIX, f))).map((f) => chain(m, f));
    });
    console.info(`boundary: ${OUTSIDE.length} non-browser modules, ${checked} closure files read for a browser-layer module`);
    expect(OUTSIDE.map((f) => relative(MATRIX, f))).toEqual(expect.arrayContaining(["run.ts", "model.ts"]));
    expect(checked).toBeGreaterThan(OUTSIDE.length);
    expect(bad).toEqual([]);
    // Positive pair: session.ts's own closure does reach another browser-layer module.
    expect([...closure([SESSION])].map((f) => relative(MATRIX, f))).toContain("lib/browser/viewports.ts");
  });

  // W1c Task 6, ruling A: the closures above walk STATIC imports only — a
  // dynamic import() loads when its code runs, not when its module loads — so
  // every dynamic edge is a door those walks do not look through. Each one, in
  // any shipped module and into anywhere, is pinned here by exact set. The one
  // allowed is the runner's lazy open of a browser run (realDeps.openBrowserRun;
  // run-cli.test.ts pins that the import sits inside that function). A second
  // edge reds until it is ruled on.
  const KNOWN_DYNAMIC_EDGES = ["run.ts -> lib/browser/browser-run.ts"];
  const BROWSER_RUN = join(MATRIX, "lib/browser/browser-run.ts");
  it("every dynamic import() in a shipped module is a known edge: only run.ts's lazy open of the browser run", () => {
    const edges: string[] = [];
    let imports = 0;
    for (const m of MODULES) {
      for (const i of importsOf(m)) {
        imports++;
        if (!i.dynamic) continue;
        const to = i.spec.startsWith(".") ? relative(MATRIX, resolve(dirname(m), i.spec)) : i.spec;
        edges.push(`${relative(MATRIX, m)} -> ${to}`);
      }
    }
    console.info(`boundary: ${MODULES.length} shipped modules, ${imports} imports read, ${edges.length} dynamic`);
    expect(imports).toBeGreaterThan(MODULES.length);
    expect(edges.sort()).toEqual(KNOWN_DYNAMIC_EDGES);
    // The edge's target exists, is a shipped module (so every closure test above
    // reads it as a root of its own) and is the browser layer's.
    expect(MODULES).toContain(BROWSER_RUN);
    expect(BROWSER_LAYER(relative(MATRIX, BROWSER_RUN))).toBe(true);
    // Positive pair for the split: run.ts's static imports are read as static
    // (its closure reaches http-driver.ts), and the dynamic target is not walked.
    const runClosure = [...closure([join(MATRIX, "run.ts")])].map((f) => relative(MATRIX, f));
    expect(runClosure).toContain("lib/driver/http-driver.ts");
    expect(runClosure).not.toContain("lib/browser/browser-run.ts");
    // ...while the target's own static closure is the browser path: it loads playwright.
    expect(playwrightLoaders(closure([BROWSER_RUN])).map((f) => relative(MATRIX, f))).toContain("lib/browser/session.ts");
  });

  // Fix round 1 (d): SPEC reads only `import("literal")`, so an `import(p)` —
  // or a template with a `${…}` in it — names its target at run time and
  // slips past the exact-set pin above. Every `import(` in a shipped module's
  // code (comments stripped) must be a literal the pin can read.
  const LITERAL_IMPORT = /^import\s*\(\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`$\n]*`)\s*\)/;
  /** Comments out: a block comment, or a line comment at a line start or after
   *  whitespace (so `http://` inside a string is not taken for one). */
  const codeOf = (src: string) => src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|\s)\/\/.*$/gm, "$1");
  it("every import() in a shipped module is a string literal — never an identifier or an interpolated template", () => {
    const bad: string[] = [];
    const literal: string[] = [];
    for (const m of MODULES) {
      const code = codeOf(readFileSync(m, "utf8"));
      for (const hit of code.matchAll(/\bimport\s*\(/g)) {
        const at = code.slice(hit.index);
        (LITERAL_IMPORT.test(at) ? literal : bad).push(`${relative(MATRIX, m)}: ${at.split("\n")[0]!.slice(0, 80)}`);
      }
    }
    console.info(`boundary: ${literal.length + bad.length} import() call(s) read, ${bad.length} not a literal`);
    expect(bad).toEqual([]);
    // Positive pair: the one known edge is read, as a literal.
    expect(literal.some((l) => l.startsWith("run.ts: import(\"./lib/browser/browser-run.ts\")"))).toBe(true);
    // The pattern has teeth on each refused shape, and passes each literal quote.
    for (const refused of ["import(p)", "import(`./lib/${x}.ts`)", "import(\"./a\" + b)"]) expect(LITERAL_IMPORT.test(refused), refused).toBe(false);
    for (const ok of ["import(\"./a.ts\")", "import('./a.ts')", "import(`./a.ts`)"]) expect(LITERAL_IMPORT.test(ok), ok).toBe(true);
  });
});

// W1c Task 4 (Task 3 review, controller ruling): the harness's widths live in
// a leaf, so the browser path reads them without loading pairs.ts — which
// pulls in the catalogue, the engine and apps/web's match-rules table.
describe("the widths leaf", () => {
  const WIDTHS = join(MATRIX, "lib/widths.ts");
  it("lib/widths.ts is a shipped module that imports nothing at all", () => {
    expect(MODULES).toContain(WIDTHS);
    expect(importsOf(WIDTHS)).toEqual([]);
    // Positive pair for the parse: the file does export the constants, so an
    // empty import list is a real "none", not a regex that read nothing.
    expect(readFileSync(WIDTHS, "utf8")).toMatch(/export const L2_WIDTHS\b[\s\S]*export const BROWSER_WIDTHS\b/);
  });
  it("pairs.ts and results.ts read their widths from the leaf (one authority)", () => {
    for (const rel of ["lib/pairs.ts", "lib/results.ts"]) {
      const specs = importsOf(join(MATRIX, rel)).map((i) => i.spec);
      expect(specs, rel).toContain("./widths.ts");
    }
    // Transitively too: results.ts (and render.ts through it) loads neither
    // pairs.ts nor the catalogue. The positive pair (the leaf IS reached)
    // proves the walk read the file.
    const reached = [...closure([join(MATRIX, "lib/results.ts")])].map((f) => relative(MATRIX, f));
    expect(reached).toContain("lib/widths.ts");
    expect(reached.filter((f) => f === "lib/pairs.ts" || f === "lib/catalogue.ts"), "results.ts must not load pairs.ts for a constant").toEqual([]);
  });
  it("lib/browser/viewports.ts reaches the leaf and never pairs.ts or results.ts (the browser path stays off the engine)", () => {
    const VIEWPORTS = join(MATRIX, "lib/browser/viewports.ts");
    expect(MODULES).toContain(VIEWPORTS);
    const reached = [...closure([VIEWPORTS])].map((f) => relative(MATRIX, f));
    expect(reached).toContain("lib/widths.ts");
    expect(reached.filter((f) => ["lib/pairs.ts", "lib/results.ts", "lib/catalogue.ts"].includes(f))).toEqual([]);
  });
});
