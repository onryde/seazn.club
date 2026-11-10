// The client/server import boundary, as `next build` enforces it and vitest cannot see it.
//
// A `"use client"` module (and everything it imports by value) is bundled for the browser, so none of it may contain
// `import "server-only"`: the build fails with "'server-only' cannot be imported from a Client Component module". vitest runs in
// node, resolves the import happily, and stays green - the sponsor-deals branch shipped exactly that: org-sponsors.tsx [client] ->
// sponsors/sponsor-list.tsx -> sponsors/deal-chip.tsx -> components/ui/status-chip.tsx -> lib/messages-i18n.ts
// (`import "server-only"`), green through ~600 tests and red in every e2e job at `next build`.
//
// This test walks the STATIC value-import graph from every client module under src/ and reports each client module that reaches a
// `server-only` file, with the chain. Type-only imports are erased by the compiler and are not edges. A DYNAMIC `import("...")` is an
// edge (the bundler still includes it).
//
// It cannot replace the build (aliases beyond `@/` and barrel re-export subtleties are not modelled), but it is the cheap instrument
// that sees this class of defect. Anti-vacuity: the sweep reports how many client modules and graph files it walked, and reaching the
// known file is asserted so a resolver that silently dropped every edge cannot read as a clean graph.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SRC = join(process.cwd(), "src");
const CLIENT_DIRECTIVE = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/;
const SERVER_ONLY = /^\s*import\s+(?:[^"']*\sfrom\s+)?["']server-only["']/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The specifiers a file imports BY VALUE (static `import … from`, side-effect `import "x"`, re-export `export … from`, dynamic
 *  `import("x")`). `import type …` and `export type …` are erased; inside braces `type X` bindings are erased too, so a statement
 *  whose every binding is `type` is not an edge either. */
export function valueSpecifiers(source: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = stmt.exec(source)) !== null) {
    if (m[2]) continue;
    const clause = m[3] ?? "";
    // `import { type A, type B }`: every binding is a type, so nothing survives the compile.
    const braced = /^\s*\{([\s\S]*)\}\s*$/.exec(clause);
    if (braced && braced[1]!.split(",").map((b) => b.trim()).filter(Boolean).every((b) => /^type\s/.test(b))) continue;
    out.push(m[4]!);
  }
  const bare = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
  while ((m = bare.exec(source)) !== null) out.push(m[1]!);
  const dyn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(source)) !== null) out.push(m[1]!);
  return out;
}

function resolveSpecifier(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // a package: not part of this graph
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const sources = new Map<string, string>();
const read = (f: string) => {
  let s = sources.get(f);
  if (s === undefined) sources.set(f, (s = readFileSync(f, "utf8")));
  return s;
};

/** The first chain from `root` to a `server-only` file over value imports, or null. Breadth-first, so the chain reported is the shortest. */
export function serverOnlyChain(root: string, graphFiles?: Set<string>): string[] | null {
  const seen = new Set<string>([root]);
  const queue: string[][] = [[root]];
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1]!;
    graphFiles?.add(file);
    if (SERVER_ONLY.test(read(file))) return chain;
    for (const spec of valueSpecifiers(read(file))) {
      const next = resolveSpecifier(spec, file);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

const rel = (f: string) => f.slice(SRC.length + 1);

describe("client modules never reach a `server-only` file", () => {
  const clientModules = walk(SRC).filter((f) => CLIENT_DIRECTIVE.test(read(f).slice(0, 2000)));

  it("the specifier reader sees value imports and skips type-only ones (the guard's own parser)", () => {
    const src = [
      'import { a } from "@/x/a";',
      'import type { B } from "@/x/b";',
      'import { type C, type D } from "@/x/cd";',
      'import { type E, f } from "@/x/ef";',
      'export { g } from "./g";',
      'export type { H } from "./h";',
      'import "./side";',
      'const l = () => import("./lazy");',
    ].join("\n");
    expect(valueSpecifiers(src)).toEqual(["@/x/a", "@/x/ef", "./g", "./side", "./lazy"]);
  });

  it("the walk reaches the chain that broke the build when the deal chip imports the chip from status-chip.tsx", () => {
    // The graph is real files: org-sponsors.tsx reaches deal-chip.tsx, and the style module it now reads is a leaf with no server import.
    const files = new Set<string>();
    expect(serverOnlyChain(join(SRC, "components/org-sponsors.tsx"), files)).toBeNull();
    const reached = [...files].map(rel);
    expect(reached).toContain("components/sponsors/deal-chip.tsx");
    expect(reached).toContain("components/ui/status-chip-style.ts");
    expect(reached).not.toContain("components/ui/status-chip.tsx");
    // And the detector itself works: status-chip.tsx reaches lib/messages-i18n.ts, which is `server-only`.
    expect(serverOnlyChain(join(SRC, "components/ui/status-chip.tsx"))?.map(rel)).toEqual([
      "components/ui/status-chip.tsx",
      "lib/messages-i18n.ts",
    ]);
  });

  it("no client module's import graph contains a `server-only` file", () => {
    // Anti-vacuity: the sweep must be looking at the sponsors screens at the least.
    const names = clientModules.map(rel);
    expect(names).toContain("components/org-sponsors.tsx");
    expect(names).toContain("components/sponsors/sponsor-list.tsx");
    expect(names).toContain("components/sponsors/add-deal-sheet.tsx");
    expect(names).toContain("components/sponsors/sponsor-sheet.tsx");
    expect(clientModules.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    const graph = new Set<string>();
    for (const root of clientModules) {
      const chain = serverOnlyChain(root, graph);
      if (chain) offenders.push(chain.map(rel).join(" -> "));
    }
    expect(graph.size, "graph files walked").toBeGreaterThan(clientModules.length);
    expect(offenders).toEqual([]);
  });
});
