// W2b Task 13 fix round 1 — no "use client" module reaches `@grpc/grpc-js`, through any chain of its own value imports.
// A browser bundle that pulls the gRPC client in dies at BUILD time on `Module not found: dns` — tsc, vitest and eslint
// are all blind to it (swiss-pairing.test.ts guards one module the same way, by reading its source). This file sweeps
// every client root: review I-2 imported `bracketForfeitWords` from the Server Component `bracket.tsx` into the client
// `schedule.tsx`, which green unit suites and a clean tsc let through, and only `next build` caught.
//
// The walk follows VALUE imports (`import type` / `export type` statements are erased by the compiler and never reach
// a bundle) through `@/…` and relative specifiers; a package specifier is recorded, not followed.
//
// Fix round 2 (re-review N-2): the forbidden specifiers are DERIVED, not typed — every export of `@seazn/engine` AND
// `@seazn/scheduler` (each package.json `exports` map) whose own module graph reaches `@grpc/grpc-js`, plus grpc itself.
// The bare barrel alone let `@seazn/engine/scheduling/placement-client`, which imports grpc directly, through.
//
// Engine split 1a (D11, D32h): the gRPC client moved to `@seazn/scheduler`, so the engine's `scheduling` barrel no longer
// reaches grpc and is now CLIENT-IMPORTABLE — a recorded decision, pinned below rather than assumed — while
// `@seazn/scheduler` and its `placement-client` subpath are what a client must never import. The derivation is the same;
// only what it finds moved.
//
// Engine split 2b (reverse inventory row 2, I): the engine is the INSTALLED package (`@onryde/seazn-engine` under its `@seazn/engine`
// alias), so its exports are read from the installed manifest and walked through its compiled `dist/` graph — what a bundle actually
// loads. An export target there is a conditional object (`types`, `default`); the bundle loads `default`. The walker's `.ts` filter
// learned `.js` for the same reason. The engine's own "no gRPC in src" half is the engine's (`test/runtime-deps.test.ts`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Every workspace package whose `exports` can hand a client the gRPC client. */
const PACKAGES = [
  { scope: "@seazn/engine", dir: resolve(SRC, "../node_modules/@seazn/engine") },
  { scope: "@seazn/scheduler", dir: resolve(SRC, "../../../packages/scheduler") },
] as const;
const BARREL = "@seazn/engine/scheduling";
const SCHEDULER = "@seazn/scheduler";
const GRPC = "@grpc/grpc-js";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      sourceFiles(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const isClient = (text: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(text);

/** Every specifier a module's BUNDLE needs: value `import … from`, `export … from`, `import "x"`, `import("x")`. */
function valueSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\n;])\s*(import|export)(\s+type\b)?([^;]*?)\bfrom\s*["']([^"']+)["']/g)) {
    if (m[2] === undefined) out.push(m[4]!);
  }
  for (const m of text.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.(?:tsx?|js)$/.test(candidate)) return candidate;
  }
  return null;
}

const specCache = new Map<string, string[]>();
const specsOf = (file: string) => {
  let specs = specCache.get(file);
  if (specs === undefined) {
    specs = valueSpecifiers(readFileSync(file, "utf8"));
    specCache.set(file, specs);
  }
  return specs;
};

/** BFS from `root`; returns every module reached and, per module, the chain that reached it. */
function walk(root: string): Map<string, string[]> {
  const reached = new Map<string, string[]>([[root, [root]]]);
  const queue = [root];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of specsOf(file)) {
      const next = resolveLocal(file, spec);
      if (next !== null && !reached.has(next)) {
        reached.set(next, [...reached.get(file)!, next]);
        queue.push(next);
      }
    }
  }
  return reached;
}

/** Every `<scope>/*` specifier a package exports, with its entry file (`./sports/*` expanded per sport). */
function packageExports(scope: string, dir: string): Map<string, string> {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports: Record<string, string | { default: string }> };
  const out = new Map<string, string>();
  for (const [key, conditional] of Object.entries(pkg.exports)) {
    // A conditional target (the installed engine's `{ types, default }`) is loaded through `default`.
    const target = typeof conditional === "string" ? conditional : conditional.default;
    if (!key.includes("*")) {
      out.set(`${scope}${key.slice(1)}`, join(dir, target));
      continue;
    }
    const [dirPart] = target.split("*");
    for (const name of readdirSync(join(dir, dirPart!))) {
      const entry = join(dir, target.replace("*", name));
      if (existsSync(entry)) out.set(`${scope}${key.slice(1).replace("*", name)}`, entry);
    }
  }
  return out;
}

/** The exports (of BOTH packages) whose module graph (relative value + dynamic imports) reaches grpc — plus grpc itself. */
function forbiddenSpecifiers(): { forbidden: Set<string>; exportsChecked: Record<string, number> } {
  const forbidden = new Set<string>([GRPC]);
  const exportsChecked: Record<string, number> = {};
  for (const { scope, dir } of PACKAGES) {
    const exports = packageExports(scope, dir);
    exportsChecked[scope] = exports.size;
    for (const [specifier, entry] of exports) {
      if ([...walk(entry).keys()].some((file) => specsOf(file).includes(GRPC))) forbidden.add(specifier);
    }
  }
  return { forbidden, exportsChecked };
}

describe("no client module reaches the gRPC client (the scheduler package, or grpc directly)", () => {
  const files = sourceFiles(SRC);
  const roots = files.filter((f) => isClient(readFileSync(f, "utf8")));
  const { forbidden, exportsChecked } = forbiddenSpecifiers();

  it("the forbidden list is derived from both packages' exports: the scheduler and its placement-client; the engine's scheduling barrel is client-importable since the solver port (D32h), as is every leaf", () => {
    expect(exportsChecked["@seazn/engine"], "engine exports read").toBeGreaterThan(20);
    expect(exportsChecked["@seazn/scheduler"], "scheduler exports read").toBeGreaterThanOrEqual(2);
    // Anti-vacuity for the installed engine (engine split 2b): the walk follows its compiled `.js` graph past the entry file, so a
    // "not forbidden" below is a walked answer, not an unread one.
    const barrelEntry = packageExports("@seazn/engine", PACKAGES[0].dir).get(BARREL);
    expect(barrelEntry, "the installed engine exports its scheduling barrel").toBeDefined();
    expect(walk(barrelEntry!).size, "modules the walk reached from the engine's scheduling barrel").toBeGreaterThan(5);
    expect(forbidden.has(SCHEDULER), "the scheduler barrel reaches grpc").toBe(true);
    expect(forbidden.has(`${SCHEDULER}/placement-client`), "the scheduler's placement-client imports grpc").toBe(true);
    // D32h, a recorded decision: the solver port took the gRPC client out of the engine, so its scheduling barrel no
    // longer reaches grpc and a client MAY import it. If this goes true again, something put a client back under the engine.
    expect(forbidden.has(BARREL), "the engine's scheduling barrel no longer reaches grpc (D32h)").toBe(false);
    // The leaves exist precisely so a client can import them: a list that forbade them would be wrong the other way.
    for (const leaf of ["bracket-layout", "swiss", "grid-step", "rest-floor"]) {
      expect(forbidden.has(`${BARREL}/${leaf}`), `${leaf} is a client-safe leaf`).toBe(false);
    }
    expect(forbidden.has("@seazn/engine/core"), "the core the client islands import").toBe(false);
  });

  it("the walker sees real edges (positive pair): schedule.tsx reaches lib/forfeit-tag.ts, bracket.tsx's barrel import is seen", () => {
    const schedule = join(SRC, "components/public-site/schedule.tsx");
    expect(roots, "schedule.tsx is a client root").toContain(schedule);
    expect([...walk(schedule).keys()]).toContain(join(SRC, "lib/forfeit-tag.ts"));
    expect(specsOf(join(SRC, "components/public-site/bracket.tsx")), "the Server Component's value import IS seen").toContain(BARREL);
    // `import type { … } from "x"` is not a bundle edge.
    expect(valueSpecifiers(`import type { A } from "${BARREL}";\nimport { b } from "./b";`)).toEqual(["./b"]);
  });

  it("every client root's value-import graph stays clear of everything that reaches grpc", () => {
    let walked = 0;
    const offenders: string[] = [];
    for (const root of roots) {
      for (const [file, chain] of walk(root)) {
        walked++;
        const hit = specsOf(file).find((spec) => forbidden.has(spec));
        if (hit !== undefined) offenders.push(`${chain.map((f) => relative(SRC, f)).join(" → ")} → ${hit}`);
      }
    }
    expect(roots.length, "client roots swept").toBeGreaterThan(50);
    expect(walked, "modules walked").toBeGreaterThan(roots.length);
    expect(offenders, `a client chain reaches grpc (${[...forbidden].join(", ")})`).toEqual([]);
  });
});
