// W2b Task 13 fix round 1 — no "use client" module reaches the SERVER-ONLY `@seazn/engine/scheduling` barrel, through
// any chain of its own value imports. The barrel reaches placement-client.ts → @grpc/grpc-js, and a browser bundle then
// dies at BUILD time on `Module not found: dns` — tsc, vitest and eslint are all blind to it (swiss-pairing.test.ts
// guards one module the same way, by reading its source). This file sweeps every client root: review I-2 imported
// `bracketForfeitWords` from the Server Component `bracket.tsx` into the client `schedule.tsx`, which green unit suites
// and a clean tsc let through, and only `next build` caught.
//
// The walk follows VALUE imports (`import type` / `export type` statements are erased by the compiler and never reach
// a bundle) through `@/…` and relative specifiers; a package specifier is recorded, not followed.
//
// Fix round 2 (re-review N-2): the forbidden specifiers are DERIVED, not typed — every `@seazn/engine/*` export (the
// engine's package.json `exports` map) whose own module graph reaches `@grpc/grpc-js`, plus grpc itself. The bare
// barrel alone let `@seazn/engine/scheduling/placement-client`, which imports grpc directly, through.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE = resolve(SRC, "../../../packages/engine");
const BARREL = "@seazn/engine/scheduling";
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
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return candidate;
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

/** Every `@seazn/engine/*` specifier the package exports, with its entry file (`./sports/*` expanded per sport). */
function engineExports(): Map<string, string> {
  const pkg = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as { exports: Record<string, string> };
  const out = new Map<string, string>();
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (!key.includes("*")) {
      out.set(`@seazn/engine${key.slice(1)}`, join(ENGINE, target));
      continue;
    }
    const [dirPart] = target.split("*");
    for (const name of readdirSync(join(ENGINE, dirPart!))) {
      const entry = join(ENGINE, target.replace("*", name));
      if (existsSync(entry)) out.set(`@seazn/engine${key.slice(1).replace("*", name)}`, entry);
    }
  }
  return out;
}

/** The engine exports whose module graph (relative value + dynamic imports) reaches grpc — plus grpc itself. */
function forbiddenSpecifiers(): { forbidden: Set<string>; exportsChecked: number } {
  const forbidden = new Set<string>([GRPC]);
  const exports = engineExports();
  for (const [specifier, entry] of exports) {
    if ([...walk(entry).keys()].some((file) => specsOf(file).includes(GRPC))) forbidden.add(specifier);
  }
  return { forbidden, exportsChecked: exports.size };
}

describe("no client module reaches the server-only scheduling barrel", () => {
  const files = sourceFiles(SRC);
  const roots = files.filter((f) => isClient(readFileSync(f, "utf8")));
  const { forbidden, exportsChecked } = forbiddenSpecifiers();

  it("the forbidden list is derived from the engine's exports: the barrel and placement-client, never a leaf", () => {
    expect(exportsChecked, "engine exports read").toBeGreaterThan(20);
    expect(forbidden.has(BARREL), "the barrel reaches grpc").toBe(true);
    expect(forbidden.has(`${BARREL}/placement-client`), "placement-client imports grpc").toBe(true);
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

  it("every client root's value-import graph stays clear of the barrel", () => {
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
