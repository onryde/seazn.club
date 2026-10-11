// W2b Task 13 fix round 1 — no "use client" module reaches the SERVER-ONLY `@seazn/engine/scheduling` barrel, through
// any chain of its own value imports. The barrel reaches placement-client.ts → @grpc/grpc-js, and a browser bundle then
// dies at BUILD time on `Module not found: dns` — tsc, vitest and eslint are all blind to it (swiss-pairing.test.ts
// guards one module the same way, by reading its source). This file sweeps every client root: review I-2 imported
// `bracketForfeitWords` from the Server Component `bracket.tsx` into the client `schedule.tsx`, which green unit suites
// and a clean tsc let through, and only `next build` caught.
//
// The walk follows VALUE imports (`import type` / `export type` statements are erased by the compiler and never reach
// a bundle) through `@/…` and relative specifiers; a package specifier is recorded, not followed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BARREL = "@seazn/engine/scheduling";

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

describe("no client module reaches the server-only scheduling barrel", () => {
  const files = sourceFiles(SRC);
  const roots = files.filter((f) => isClient(readFileSync(f, "utf8")));

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
        if (specsOf(file).includes(BARREL)) offenders.push(chain.map((f) => relative(SRC, f)).join(" → "));
      }
    }
    expect(roots.length, "client roots swept").toBeGreaterThan(50);
    expect(walked, "modules walked").toBeGreaterThan(roots.length);
    expect(offenders, `a client chain reaches ${BARREL}`).toEqual([]);
  });
});
