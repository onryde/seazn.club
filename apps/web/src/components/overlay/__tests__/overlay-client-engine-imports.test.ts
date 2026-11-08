// The OBS overlay's browser bundle carries no sport module of the engine (S2-5 final review I1). The overlay is an OBS
// browser source, where page weight is the feature (`overlay-tokens.ts`). The wire already carries what a sport's
// reading needs as plain values (football's `matchTime`, parsed on the server), so nothing the browser runs needs
// `@seazn/engine/sports/*`. At 0df9a4c524 the only engine runtime import in the overlay's client graph was
// `@seazn/engine/core` (through `lib/forfeit-tag.ts`); a module-level `FootballCfg` import in
// `skins/football-match-time.ts` once put the whole football module (41 KB) into every sport's overlay.
//
// This is an import-graph check over the real source, in the shape of `email-outbox/__tests__/no-import-cycle.test.ts`.
// The client graph is what Next.js sends to the browser: every `"use client"` module reachable from the overlay route,
// and everything those modules import at runtime. Server modules the page imports (the loader, `project.ts`) are not
// in it, and may read the engine freely — the positive control below proves the reader finds the import there.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "../../.."); // apps/web/src
const ROUTE = ["app/overlay/fixtures/[fixtureId]/page.tsx", "app/overlay/fixtures/[fixtureId]/layout.tsx"];
const SPORT_MODULE = /^@seazn\/engine\/sports(\/|$)/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Module specifiers a file imports at runtime. `import type` / `export type` are erased by the compiler, so they put
 *  nothing in a bundle and are not followed. */
function specifiersOf(src: string): string[] {
  const text = stripComments(src);
  const out: string[] = [];
  const statement = /(^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g;
  for (let m = statement.exec(text); m; m = statement.exec(text)) {
    if (m[3]) continue;
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

interface Node {
  readonly client: boolean;
  readonly local: string[];
  readonly packages: string[];
}

/** The runtime import graph reachable from `roots` (paths relative to src/). */
function buildGraph(roots: readonly string[]): Map<string, Node> {
  const graph = new Map<string, Node>();
  const stack = roots.map((r) => join(SRC, r));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (graph.has(rel(file))) continue;
    const src = readFileSync(file, "utf8");
    const local: string[] = [];
    const packages: string[] = [];
    for (const spec of specifiersOf(src)) {
      const target = resolveLocal(spec, file);
      if (target) {
        local.push(rel(target));
        stack.push(target);
      } else if (!spec.startsWith("@/") && !spec.startsWith(".")) packages.push(spec);
    }
    graph.set(rel(file), { client: /^\s*["']use client["']/.test(stripComments(src)), local, packages });
  }
  return graph;
}

/** Every module the browser gets: the `"use client"` modules and everything they import at runtime. */
function clientClosure(graph: Map<string, Node>): Set<string> {
  const seen = new Set([...graph].filter(([, n]) => n.client).map(([f]) => f));
  const stack = [...seen];
  while (stack.length > 0) {
    for (const next of graph.get(stack.pop()!)?.local ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** `file -> specifier` for each sport-module import among `files`. */
function sportImports(graph: Map<string, Node>, files: Iterable<string>): string[] {
  return [...files].flatMap((f) => (graph.get(f)?.packages ?? []).filter((p) => SPORT_MODULE.test(p)).map((p) => `${f} -> ${p}`));
}

describe("the reader (anti-vacuity: a reader that finds nothing proves nothing)", () => {
  it("reads value imports and skips type-only ones", () => {
    const src = [
      'import { FootballCfg } from "@seazn/engine/sports/football";',
      'import type { Envelope } from "@seazn/engine/sports/cricket";',
      'import { matchClock, type MatchTimeCfg } from "./football-match-time";',
      'export type { X } from "@seazn/engine/sports";',
      '// import { gone } from "@seazn/engine/sports/hockey";',
      'const lazy = () => import("@seazn/engine/sports/tennis");',
    ].join("\n");
    expect(specifiersOf(src)).toEqual(["@seazn/engine/sports/football", "./football-match-time", "@seazn/engine/sports/tennis"]);
  });

  it("matches every sport-module path and nothing else of the engine", () => {
    for (const hit of ["@seazn/engine/sports", "@seazn/engine/sports/football", "@seazn/engine/sports/cricket"]) expect(hit).toMatch(SPORT_MODULE);
    for (const miss of ["@seazn/engine/core", "@seazn/engine/sport", "@seazn/engine/sportsish", "@seazn/engine/testkit"]) expect(miss).not.toMatch(SPORT_MODULE);
  });
});

describe("the overlay's client graph", () => {
  const graph = buildGraph(ROUTE);
  const client = clientClosure(graph);

  it("is the graph the browser gets: the stage, its clock and the football match-time reading are in it; the server projection is not", () => {
    expect(client.has("components/overlay/overlay-stage.tsx")).toBe(true);
    expect(client.has("components/overlay/use-overlay-clock.ts")).toBe(true);
    expect(client.has("components/v2/scorepad/v3/skins/football-match-time.ts")).toBe(true);
    expect(graph.has("server/overlay/project.ts")).toBe(true);
    expect(client.has("server/overlay/project.ts")).toBe(false);
  });

  it("sees the engine where the overlay does import it: `@seazn/engine/core`, through lib/forfeit-tag.ts", () => {
    expect(graph.get("lib/forfeit-tag.ts")?.packages).toContain("@seazn/engine/core");
    expect(client.has("lib/forfeit-tag.ts")).toBe(true);
  });

  it("sees a sport module where the server reads one: football's cfg parse, outside the client graph", () => {
    const server = [...graph.keys()].filter((f) => !client.has(f));
    expect(sportImports(graph, server)).toContain(
      "components/v2/scorepad/v3/skins/football-match-time-cfg.ts -> @seazn/engine/sports/football",
    );
  });

  it("imports no sport module of the engine", () => {
    const found = sportImports(graph, client);
    expect(found, `client modules importing a sport module:\n${found.join("\n")}`).toEqual([]);
  });
});
