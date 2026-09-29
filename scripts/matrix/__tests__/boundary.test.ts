// R3 / ruling 17 as a gate, not a convention: the harness imports only the
// bench's small helpers, only two apps/web files (the builder's templates and,
// from W1b Task 5, the match-rules table the variant set is built from), and
// the invariant layer is type-only so W1b's fast-check model and W10's shadow
// checks can reuse it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(MATRIX, "..", "..");
// Full repo-relative paths, never basenames: scripts/bench/lib/drivers/http.ts
// is a different module that a basename check would wave through as "http.ts".
const ALLOWED_BENCH = new Set([
  "scripts/bench/lib/http.ts", "scripts/bench/lib/plan.ts", "scripts/bench/lib/env.ts",
  // Ruling 38 (2026-09-29): the tap vocabulary, the ledger reader, the generic adapter and the
  // consent/device-link helpers are imported, not copied. scorer.ts and tap-play.ts reach
  // pack-schema through simulate.ts — a second transitive load ruling 38 accepts by name.
  "scripts/bench/lib/ledger.ts", "scripts/bench/lib/drivers/scorer.ts",
  "scripts/bench/lib/drivers/adapters/generic.ts", "scripts/bench/lib/tap-play.ts",
]);
const ALLOWED_WEB = new Set(["apps/web/src/components/v2/format-templates.ts", "apps/web/src/lib/match-rules.ts"]);
const FORBIDDEN = ["run-suite", "pack-schema", "seed.ts", "seed-plan", "validate-pack", "scripts/smoke"];
const TYPE_ONLY = new Set(["lib/invariants.ts", "lib/observed.ts"]);

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

function importsOf(file: string): { spec: string; typeOnly: boolean }[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(SPEC)].map((m) => ({ spec: (m[3] ?? m[4] ?? m[5])!, typeOnly: m[2] !== undefined }));
}

/** Every `.ts` file a real load reaches from `roots`: relative VALUE imports
 *  only (a type import is erased under strip-types and loads nothing), and
 *  only specs that name an existing `.ts` file — exactly what node follows.
 *  Bare packages and apps/web's `@/` alias are not walked. */
function closure(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, typeOnly } of importsOf(file)) {
      if (typeOnly || !spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (target.endsWith(".ts") && existsSync(target)) stack.push(target);
    }
  }
  return seen;
}

const MODULES = shipped(MATRIX).sort();

describe("scripts/matrix import boundary", () => {
  it("discovery guard: the walker finds the shipped modules (an empty set would pass vacuously)", () => {
    expect(MODULES.length).toBeGreaterThan(0);
    expect(MODULES.some((f) => f.endsWith("lib/catalogue.ts"))).toBe(true);
  });

  it.each(MODULES.map((f) => [relative(MATRIX, f), f]))("%s imports only allowed modules", (_rel, file) => {
    for (const { spec } of importsOf(file)) {
      expect(FORBIDDEN.some((bad) => spec.includes(bad)), `${spec}`).toBe(false);
      if (!spec.startsWith(".")) continue;
      const target = relative(REPO, resolve(dirname(file), spec));
      if (target.startsWith("scripts/bench/")) expect(ALLOWED_BENCH.has(target), target).toBe(true);
      if (target.startsWith("apps/web/")) expect(ALLOWED_WEB.has(target), target).toBe(true);
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
});
