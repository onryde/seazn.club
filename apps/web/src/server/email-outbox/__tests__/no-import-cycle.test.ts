// Ruling R1: the outbox core never imports a usecase. A kind's side effect (the chess invite releasing its seat stamp)
// is reached through the KIND_HOOKS lookup table, and a hook module is a LEAF: it imports no usecase that imports the
// outbox back. If it did, `invite.ts -> email-outbox -> hooks.ts -> invite.ts` would be a cycle that only shows up at
// runtime, as an `undefined` import in whichever module loads first.
//
// This is an import-graph check over the real source (no runner is needed: the repo has no madge or dependency-cruiser).
// Three claims:
//  1. no file of the core (everything under server/email-outbox/ except tests) imports a usecase, except hooks.ts and
//     only the leaf hook modules named in ALLOWED_HOOK_LEAVES below;
//  2. no runtime import path leads from a core file back to a core file (a cycle through anything: the core, a lib
//     module, a leaf);
//  3. the leaf hook modules named below do not themselves import the outbox core or another usecase module (a leaf is a
//     leaf).
//
// The graph walker is exercised against synthetic graphs first, so a walker that finds nothing is a failure, not a pass.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "../../.."); // apps/web/src
const CORE_DIR = join(SRC, "server/email-outbox");
const USECASES_DIR = join(SRC, "server/usecases");

/** The only usecase-tree files hooks.ts may import (paths relative to src/). Task 7 adds the chess hook leaf here. */
const ALLOWED_HOOK_LEAVES: readonly string[] = [];

type Graph = Map<string, string[]>;

// ---------------------------------------------------------------------------
// The walker: pure functions over a Graph, so they can be tested on synthetic input.
// ---------------------------------------------------------------------------

/** The shortest runtime path `from -> ... -> to`, or null. A path of one edge is a direct import. */
function pathBetween(graph: Graph, from: string, to: string): string[] | null {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of graph.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        for (let p = prev.get(to); p != null; p = prev.get(p) ?? null) path.unshift(p);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** Every `root` that sits on a cycle: it imports (directly or not) something that leads back to it. */
function cyclesThrough(graph: Graph, roots: readonly string[]): string[][] {
  const found: string[][] = [];
  for (const root of roots) {
    for (const dep of graph.get(root) ?? []) {
      if (dep === root) {
        found.push([root, root]);
        continue;
      }
      const back = pathBetween(graph, dep, root);
      if (back) found.push([root, ...back]);
    }
  }
  return found;
}

function closureOf(graph: Graph, roots: readonly string[]): Set<string> {
  const seen = new Set<string>(roots);
  const stack = [...roots];
  while (stack.length > 0) {
    for (const next of graph.get(stack.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The reader: runtime imports of one source file.
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Module specifiers a file imports at runtime. `import type` / `export type` are erased by the compiler, so they
 *  cannot close a runtime loop and are not followed. */
function specifiersOf(src: string): string[] {
  const text = stripComments(src);
  const out: string[] = [];
  const statement = /(^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g;
  for (let m = statement.exec(text); m; m = statement.exec(text)) {
    if (m[3]) continue; // import type / export type
    out.push(m[4]!);
  }
  const dynamic = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = dynamic.exec(text); m; m = dynamic.exec(text)) out.push(m[1]!);
  return out;
}

/** A local specifier (`@/...` or relative) to an absolute file under src/, or null for a package or a non-code file. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

const rel = (abs: string): string => relative(SRC, abs).split("\\").join("/");

function coreFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__") walk(full);
      } else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(CORE_DIR);
  return out.sort();
}

/** What a hook leaf reaches that a leaf must not: the outbox core or another usecase module. */
function leafViolations(graph: Graph, leaf: string): string[] {
  const reach = closureOf(graph, [leaf]);
  reach.delete(leaf);
  return [...reach].filter((f) => f.startsWith("server/email-outbox/") || f.startsWith("server/usecases/")).sort();
}

/** The runtime import graph reachable from `roots`, keyed by path relative to src/. */
function buildGraph(roots: readonly string[]): { graph: Graph; unresolvedLocal: string[] } {
  const graph: Graph = new Map();
  const unresolvedLocal: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (graph.has(rel(file))) continue;
    const deps: string[] = [];
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      const target = resolveLocal(spec, file);
      if (target) {
        deps.push(rel(target));
        stack.push(target);
      } else if (spec.startsWith("@/") || spec.startsWith(".")) {
        // A local specifier that points at no .ts/.tsx (a json, a css, a typo): recorded, not silently dropped.
        unresolvedLocal.push(`${rel(file)} -> ${spec}`);
      }
    }
    graph.set(rel(file), deps);
  }
  return { graph, unresolvedLocal };
}

// ---------------------------------------------------------------------------
// The walker is exercised first (anti-vacuity: a detector that finds nothing proves nothing).
// ---------------------------------------------------------------------------

describe("the import-graph walker", () => {
  it("finds a two-file cycle, a three-file cycle and a self import, and names the path", () => {
    const two: Graph = new Map([["a", ["b"]], ["b", ["a"]]]);
    expect(cyclesThrough(two, ["a"])).toEqual([["a", "b", "a"]]);
    const three: Graph = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]);
    expect(cyclesThrough(three, ["a"])).toEqual([["a", "b", "c", "a"]]);
    const self: Graph = new Map([["a", ["a"]]]);
    expect(cyclesThrough(self, ["a"])).toEqual([["a", "a"]]);
  });

  it("finds a cycle that closes through a file outside the roots (the shape that matters: core -> lib -> core)", () => {
    const g: Graph = new Map([["core", ["lib"]], ["lib", ["core"]]]);
    expect(cyclesThrough(g, ["core"]).length).toBe(1);
  });

  it("does not flag a diamond or a chain (the empty case: no cycle, no finding)", () => {
    const diamond: Graph = new Map([["a", ["b", "c"]], ["b", ["d"]], ["c", ["d"]], ["d", []]]);
    expect(cyclesThrough(diamond, ["a", "b", "c", "d"])).toEqual([]);
    expect(cyclesThrough(new Map(), [])).toEqual([]);
  });

  it("reads import forms: named, default, side-effect, re-export, multi-line, dynamic; skips type-only and comments", () => {
    const src = [
      `import "server-only";`,
      `import { a } from "@/x/a";`,
      `import b from "./b";`,
      `import type { T } from "@/x/types-only";`,
      `export type { U } from "@/x/types-only-2";`,
      `export { c } from "../c";`,
      `import {`,
      `  d,`,
      `  e,`,
      `} from "@/x/multi";`,
      `// import { z } from "@/x/commented";`,
      `/* import { y } from "@/x/blocked"; */`,
      `const lazy = () => import("@/x/lazy");`,
    ].join("\n");
    expect(specifiersOf(src).sort()).toEqual(
      ["server-only", "@/x/a", "./b", "../c", "@/x/multi", "@/x/lazy"].sort(),
    );
  });

  it("leafViolations names a leaf that reaches the core or another usecase, and passes a clean one", () => {
    const g: Graph = new Map([
      ["server/usecases/x/leaf.ts", ["lib/util.ts", "server/usecases/x/other.ts"]],
      ["lib/util.ts", ["server/email-outbox/enqueue.ts"]],
      ["server/usecases/x/other.ts", []],
      ["server/email-outbox/enqueue.ts", []],
      ["server/usecases/y/clean.ts", ["lib/util2.ts"]],
      ["lib/util2.ts", []],
    ]);
    expect(leafViolations(g, "server/usecases/x/leaf.ts")).toEqual(["server/email-outbox/enqueue.ts", "server/usecases/x/other.ts"]);
    expect(leafViolations(g, "server/usecases/y/clean.ts")).toEqual([]);
  });

  it("closureOf follows edges and includes the roots", () => {
    const g: Graph = new Map([["a", ["b"]], ["b", ["c"]], ["c", []], ["z", ["a"]]]);
    expect([...closureOf(g, ["a"])].sort()).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// The real graph.
// ---------------------------------------------------------------------------

describe("the outbox core's imports (ruling R1)", () => {
  const files = coreFiles();
  const roots = files.map(rel);
  const { graph, unresolvedLocal } = buildGraph(files);

  it("the walker saw the core and the code it reaches (anti-vacuity)", () => {
    // The core is at least the modules this task creates.
    for (const name of ["attempt", "classify", "constants", "enqueue", "hooks", "index", "seal", "transport"]) {
      expect(roots, name).toContain(`server/email-outbox/${name}.ts`);
    }
    // It resolved real edges, including one through the `@/` alias and one relative.
    expect(graph.get("server/email-outbox/attempt.ts")).toContain("server/email-outbox/constants.ts");
    expect(graph.get("server/email-outbox/attempt.ts")).toContain("lib/email.ts");
    expect(graph.get("server/email-outbox/seal.ts")).toContain("server/relay/crypto.ts");
    // And it went more than one level deep (lib/email.ts pulls in lib/db.ts).
    expect(closureOf(graph, roots).has("lib/db.ts")).toBe(true);
    expect(graph.size).toBeGreaterThan(roots.length);
  });

  it("every local specifier resolved to a source file (a miss would be a hole in the walk)", () => {
    expect(unresolvedLocal).toEqual([]);
  });

  it("no core file imports a usecase, except hooks.ts importing a named leaf", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const root of roots) {
      for (const dep of graph.get(root) ?? []) {
        checked++;
        if (!resolve(SRC, dep).startsWith(USECASES_DIR + "/")) continue;
        const allowed = root === "server/email-outbox/hooks.ts" && ALLOWED_HOOK_LEAVES.includes(dep);
        if (!allowed) offenders.push(`${root} -> ${dep}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("no runtime import path leads from a core file back to a core file", () => {
    expect(cyclesThrough(graph, roots)).toEqual([]);
  });

  it("each allowed hook leaf is a leaf: it reaches neither the core nor another usecase module", () => {
    // Empty until Task 7 registers the chess hook leaf; the predicate itself is exercised on synthetic graphs above.
    let checked = 0;
    for (const leaf of ALLOWED_HOOK_LEAVES) {
      expect(graph.has(leaf), `${leaf} is part of the walked graph`).toBe(true);
      expect(leafViolations(graph, leaf), leaf).toEqual([]);
      checked++;
    }
    expect(checked).toBe(ALLOWED_HOOK_LEAVES.length);
  });
});
