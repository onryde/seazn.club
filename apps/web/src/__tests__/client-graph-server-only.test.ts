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
// It reads every file with the TypeScript parser, never a regex: the first version scanned the first 2000 characters for the
// directive (a client module whose header comment is longer was never a root: 10 of 444 files today), and its import regex let
// `export type X = ...;` swallow the NEXT statement's `import ... from` (three files lost an edge). The directive is a statement in
// the file's directive prologue; an import is an ImportDeclaration / ExportDeclaration node. A second, INDEPENDENT count of the client
// modules (a line that is exactly the directive) must agree with the parser's, so a parser that silently drops roots cannot read as a
// clean graph.
//
// It cannot replace the build (aliases beyond `@/` and barrel re-export subtleties are not modelled), but it is the cheap instrument
// that sees this class of defect. Anti-vacuity: the sweep reports how many client modules, graph files and edges it walked, a floor
// close to what was measured fails when a walk silently shrinks, and reaching the known file is asserted.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type * as TS from "typescript";

const ts: typeof TS = createRequire(import.meta.url)("typescript");

const SRC = join(process.cwd(), "src");

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

const parse = (source: string, file = "x.tsx"): TS.SourceFile =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX);

const specText = (n: TS.Expression | undefined): string | null => (n && ts.isStringLiteralLike(n) ? n.text : null);

/** Does this file carry the `"use client"` directive? A directive is a string-literal statement in the PROLOGUE - the leading run of
 *  string-literal statements - however long the comment above it is. */
export function hasUseClient(source: string): boolean {
  for (const st of parse(source).statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === "use client") return true;
  }
  return false;
}

/** An INDEPENDENT reading of the directive (no parser): a line that is exactly `"use client"`, with or without its semicolon. It can
 *  over-count (the same line mid-file is not a directive) but never misses a real one, so the two readings must agree. */
export const hasUseClientLine = (source: string): boolean => /^[ \t]*["']use client["'];?[ \t]*\r?$/m.test(source);

/** The specifiers a file imports BY VALUE (static `import … from`, side-effect `import "x"`, re-export `export … from`, dynamic
 *  `import("x")`). `import type …` and `export type …` are erased; inside braces `type X` bindings are erased too, so a statement
 *  whose every binding is `type` is not an edge either. */
export function valueSpecifiers(source: string): string[] {
  const out: string[] = [];
  const sf = parse(source);
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      // `import { type A, type B } from "x"`: every binding is a type, so nothing survives the compile.
      if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)) continue;
      const spec = specText(st.moduleSpecifier);
      if (spec !== null) out.push(spec);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      if (st.isTypeOnly) continue;
      const clause = st.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly)) continue;
      const spec = specText(st.moduleSpecifier);
      if (spec !== null) out.push(spec);
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && !st.isTypeOnly) {
      const spec = specText(st.moduleReference.expression);
      if (spec !== null) out.push(spec);
    }
  }
  // Dynamic `import("x")`, wherever it sits (a call, not an `import("x")` TYPE, which is erased).
  const visit = (n: TS.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = specText(n.arguments[0]);
      if (spec !== null) out.push(spec);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Does this file `import "server-only"` (any form)? */
export function isServerOnly(source: string): boolean {
  return parse(source).statements.some((st) => ts.isImportDeclaration(st) && specText(st.moduleSpecifier) === "server-only");
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

/** What a file contributes to the graph, parsed ONCE (the walk visits a file from every root that reaches it). */
const parsed = new Map<string, { serverOnly: boolean; specs: string[] }>();
const info = (f: string) => {
  let p = parsed.get(f);
  if (p === undefined) parsed.set(f, (p = { serverOnly: isServerOnly(read(f)), specs: valueSpecifiers(read(f)) }));
  return p;
};

/** The first chain from `root` to a `server-only` file over value imports, or null. Breadth-first, so the chain reported is the shortest. */
export function serverOnlyChain(root: string, graphFiles?: Set<string>, edges?: { n: number }): string[] | null {
  const seen = new Set<string>([root]);
  const queue: string[][] = [[root]];
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1]!;
    graphFiles?.add(file);
    const { serverOnly, specs } = info(file);
    if (serverOnly) return chain;
    for (const spec of specs) {
      const next = resolveSpecifier(spec, file);
      if (next === null || seen.has(next)) continue;
      if (edges) edges.n++;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

const rel = (f: string) => f.slice(SRC.length + 1);

/** Measured when the parser was written (see the report line the sweep prints). The floor sits a little under it: deleting a few
 *  screens must not red the guard, losing a tenth of the roots must. Raise it when the count grows by more than a handful. */
const CLIENT_MODULE_FLOOR = 430;

describe("the guard's own parser", () => {
  it("the specifier reader sees value imports and skips type-only ones", () => {
    const src = [
      'import { a } from "@/x/a";',
      'import type { B } from "@/x/b";',
      'import { type C, type D } from "@/x/cd";',
      'import { type E, f } from "@/x/ef";',
      'import Def, { type G } from "@/x/def";',
      'import * as NS from "@/x/ns";',
      'export { g } from "./g";',
      'export type { H } from "./h";',
      'export { type I } from "./i";',
      'export * from "./star";',
      'import "./side";',
      'const l = () => import("./lazy");',
      'type T = import("./type-only").X;',
    ].join("\n");
    expect(valueSpecifiers(src)).toEqual(["@/x/a", "@/x/ef", "@/x/def", "@/x/ns", "./g", "./star", "./side", "./lazy"]);
  });

  it("an `export type X = ...;` before an import does not swallow it (the regex's blind spot: the statement's own `from` was the next import's)", () => {
    const src = ["export type Row = { id: string };", 'import { real } from "@/x/real";', "export type Other = number;", 'import type { T } from "@/x/t";', 'import { second } from "@/x/second";'].join("\n");
    expect(valueSpecifiers(src)).toEqual(["@/x/real", "@/x/second"]);
  });

  it("a `from` inside a string or a comment is not an import", () => {
    const src = ['// import { x } from "@/x/commented";', 'const s = "import { y } from \'@/x/in-a-string\'";', 'import { z } from "@/x/z";'].join("\n");
    expect(valueSpecifiers(src)).toEqual(["@/x/z"]);
  });

  it("the directive is found after a header comment of any length (the 2000-character window's blind spot), and only in the prologue", () => {
    const longHeader = `/*${"x".repeat(3200)}*/\n`;
    expect(hasUseClient(`${longHeader}"use client";\nimport { a } from "@/a";`)).toBe(true);
    expect(hasUseClient(`${"// header line\n".repeat(400)}"use client"\nexport const a = 1;`)).toBe(true);
    expect(hasUseClient("'use client';\n")).toBe(true);
    // not a directive: after a statement, or a string that is not a statement of its own
    expect(hasUseClient('import { a } from "@/a";\n"use client";')).toBe(false);
    expect(hasUseClient('const s = "use client";')).toBe(false);
    expect(hasUseClient('"use strict";\n"use client";')).toBe(true);
    expect(hasUseClient("export const a = 1;")).toBe(false);
  });

  it("the independent line reading agrees on the same fixtures (it is only a cross-check)", () => {
    const longHeader = `/*${"x".repeat(3200)}*/\n`;
    expect(hasUseClientLine(`${longHeader}"use client";\nexport const a = 1;`)).toBe(true);
    expect(hasUseClientLine("export const a = 1;")).toBe(false);
    expect(hasUseClientLine('const s = "use client";')).toBe(false);
  });

  it("`server-only` is found as a side-effect import and in any import form, not in a comment or a string", () => {
    expect(isServerOnly('import "server-only";\nexport const a = 1;')).toBe(true);
    expect(isServerOnly('import x from "server-only";')).toBe(true);
    expect(isServerOnly('// import "server-only"\nexport const a = 1;')).toBe(false);
    expect(isServerOnly('const s = \'import "server-only"\';')).toBe(false);
  });
});

describe("client modules never reach a `server-only` file", () => {
  const files = walk(SRC);
  const clientModules = files.filter((f) => hasUseClient(read(f)));
  const lineReading = files.filter((f) => hasUseClientLine(read(f)));

  it("the parser and the independent line reading find the same client modules (counts reported, below the floor fails)", () => {
    console.info(`client-graph guard: ${files.length} source files, ${clientModules.length} client modules (parser), ${lineReading.length} (line reading)`);
    const parser = new Set(clientModules.map(rel));
    const lines = new Set(lineReading.map(rel));
    expect([...lines].filter((f) => !parser.has(f)), "a directive line the parser did not take as a directive").toEqual([]);
    expect([...parser].filter((f) => !lines.has(f)), "a directive the line reading missed").toEqual([]);
    expect(clientModules.length).toBeGreaterThanOrEqual(CLIENT_MODULE_FLOOR);
  });

  it("the walk reaches the chain that broke the build when the deal chip imports the chip from status-chip.tsx", () => {
    // The graph is real files: org-sponsors.tsx reaches deal-chip.tsx, and the style module it now reads is a leaf with no server import.
    const reachedFiles = new Set<string>();
    expect(serverOnlyChain(join(SRC, "components/org-sponsors.tsx"), reachedFiles)).toBeNull();
    const reached = [...reachedFiles].map(rel);
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

    const offenders: string[] = [];
    const graph = new Set<string>();
    const edges = { n: 0 };
    for (const root of clientModules) {
      const chain = serverOnlyChain(root, graph, edges);
      if (chain) offenders.push(chain.map(rel).join(" -> "));
    }
    console.info(`client-graph guard: walked ${graph.size} files over ${edges.n} import edges from ${clientModules.length} client roots; ${offenders.length} offenders`);
    expect(graph.size, "graph files walked").toBeGreaterThan(clientModules.length);
    expect(edges.n, "import edges followed").toBeGreaterThan(graph.size);
    expect(offenders).toEqual([]);
  });
});
