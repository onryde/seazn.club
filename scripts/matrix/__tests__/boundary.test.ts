// R3 / ruling 17 as a gate, not a convention: the harness imports only the
// bench's small helpers, only one apps/web file, and the invariant layer is
// type-only so W1b's fast-check model and W10's shadow checks can reuse it.
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(MATRIX, "..", "..");
const ALLOWED_BENCH = new Set(["http.ts", "plan.ts", "env.ts"]);
const ALLOWED_WEB = new Set(["apps/web/src/components/v2/format-templates.ts"]);
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

// Three import shapes: `import|export … from "x"`, dynamic `import("x")`, and
// the bare side-effect `import "x";`. The third has no `from`, so the first
// alternative cannot see it — and a side-effect import of seed.ts is exactly
// what this gate exists to stop (found by mutation: without the third
// alternative, `import "../../bench/lib/seed.ts";` stayed green).
const SPEC = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function importsOf(file: string): { spec: string; typeOnly: boolean }[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(SPEC)].map((m) => ({ spec: (m[3] ?? m[4] ?? m[5])!, typeOnly: m[2] !== undefined }));
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
      if (target.startsWith("scripts/bench/")) expect(ALLOWED_BENCH.has(basename(target)), target).toBe(true);
      if (target.startsWith("apps/web/")) expect(ALLOWED_WEB.has(target), target).toBe(true);
    }
  });

  it("invariants.ts and observed.ts import types only (reusable by W1b fast-check and W10 shadow checks)", () => {
    for (const rel of TYPE_ONLY) {
      const file = join(MATRIX, rel);
      if (!MODULES.includes(file)) continue; // lands in Task 5; this test then bites
      for (const imp of importsOf(file)) expect(imp.typeOnly, `${rel}: ${imp.spec}`).toBe(true);
    }
  });
});
