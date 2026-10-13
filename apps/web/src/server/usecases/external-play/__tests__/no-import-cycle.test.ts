// T16 fix round 2, N1 — no STATIC import cycle runs through `usecases/fixtures.ts` or `external-play/guard.ts`.
//
// cacc41489 closed one: fixtures.ts → public-site/revalidate.ts → public-site/data.ts (for five cache-tag helpers)
// → usecases/external-play-read.ts → external-play/play.ts | preflight.ts → result.ts → guard.ts / fixtures.ts.
// Nothing in the product broke. What broke was every test that mocks guard or fixtures with `importOriginal`:
// importing the original drags in result.ts and preflight.ts, which then bind to the UNMOCKED modules. The staged
// pauses of external-play-result-race.test.ts and the lock-order hook of open-round.test.ts never fired, so 7 race
// and lock-order guards could not fail (task-16-rereview.md N1). The same loop, entered from its other end, unbound
// four suites that mock `public-site/revalidate` with `importOriginal` (admin-fixture-config-cache,
// hub-cache-invalidation, schedule-slot-writes-cache-keys, scoring-deferred): 5 more tests whose spies were never
// called. The helpers now live in the leaf `public-site/cache-tags.ts`.
//
// This walks the real source: static `import … from` / `export … from` edges only. An `import type` is erased and a
// dynamic `import()` runs later, so neither can close a cycle at module evaluation. Every walk reports what it
// visited, and the walker is proven to follow edges (result.ts DOES reach guard.ts and fixtures.ts).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The CJS loader, not `import ts from "typescript"` (src/__tests__/app-module-exports.test.ts: Vite's transform
// dies on the 9 MB file).
const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const rel = (abs: string) => path.relative(SRC, abs);
const FIXTURES = path.join(SRC, "server/usecases/fixtures.ts");
const GUARD = path.join(SRC, "server/usecases/external-play/guard.ts");
const RESULT = path.join(SRC, "server/usecases/external-play/result.ts");
const PREFLIGHT = path.join(SRC, "server/usecases/external-play/preflight.ts");
const REVALIDATE = path.join(SRC, "server/public-site/revalidate.ts");
const SCORING = path.join(SRC, "server/usecases/scoring.ts");
const FEN = path.join(SRC, "server/external-play/fen.ts");
const READ = path.join(SRC, "server/usecases/external-play-read.ts");
const PLAY = path.join(SRC, "server/usecases/external-play/play.ts");
const ORG_POSTS = path.join(SRC, "server/usecases/org-posts.ts");
const DB = path.join(SRC, "lib/db.ts");

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package: never this app's source
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`no-import-cycle: cannot resolve "${spec}" from ${rel(from)} — the walker would go blind here`);
}

const edgesCache = new Map<string, string[]>();
/** The modules `file` imports at evaluation time. */
function edgesOf(file: string): string[] {
  const cached = edgesCache.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  for (const node of source.statements) {
    let spec: string | null = null;
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) spec = (node.moduleSpecifier as import("typescript").StringLiteral).text;
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) spec = (node.moduleSpecifier as import("typescript").StringLiteral).text;
    if (spec === null) continue;
    const target = resolveSpecifier(file, spec);
    if (target !== null) out.push(target);
  }
  edgesCache.set(file, out);
  return out;
}

/** Breadth-first from `start`'s imports: every module reached, and the chain that first reached each. */
function walk(start: string): Map<string, string[]> {
  const chain = new Map<string, string[]>();
  const queue: string[] = [];
  for (const next of edgesOf(start)) {
    if (!chain.has(next)) {
      chain.set(next, [start, next]);
      queue.push(next);
    }
  }
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const next of edgesOf(at)) {
      if (chain.has(next)) continue;
      chain.set(next, [...chain.get(at)!, next]);
      queue.push(next);
    }
  }
  return chain;
}
const shown = (c: string[] | undefined) => (c ?? []).map(rel).join(" → ");

describe("no import cycle through usecases/fixtures.ts or external-play/guard.ts (N1)", () => {
  it("the walker follows real edges: result.ts reaches guard.ts and fixtures.ts (else every 'unreachable' below is vacuous)", () => {
    const fromResult = walk(RESULT);
    expect(fromResult.has(GUARD), "result.ts → guard.ts").toBe(true);
    expect(fromResult.has(FIXTURES), "result.ts → fixtures.ts").toBe(true);
    expect(fromResult.size, "anti-vacuity: modules visited from result.ts").toBeGreaterThan(10);
  });

  it("fixtures.ts still reaches public-site/revalidate.ts (the old chain's first edge) — yet never result.ts or preflight.ts, and never itself", () => {
    const reached = walk(FIXTURES);
    expect(reached.size, "anti-vacuity: modules visited from fixtures.ts").toBeGreaterThan(10);
    expect(reached.has(path.join(SRC, "server/public-site/revalidate.ts")), "premise: fixtures.ts → revalidate.ts").toBe(true);
    for (const target of [RESULT, PREFLIGHT, FIXTURES]) {
      expect(reached.has(target), `fixtures.ts must not reach ${rel(target)}: ${shown(reached.get(target))}`).toBe(false);
    }
  });

  it("public-site/revalidate.ts (mocked with importOriginal by the cache suites) never reaches itself, fixtures.ts or scoring.ts", () => {
    const reached = walk(REVALIDATE);
    expect(reached.size, "anti-vacuity: modules visited from revalidate.ts").toBeGreaterThan(3);
    expect(walk(FIXTURES).has(REVALIDATE), "premise: fixtures.ts → revalidate.ts").toBe(true);
    expect(walk(SCORING).has(REVALIDATE), "premise: scoring.ts → revalidate.ts").toBe(true);
    for (const target of [REVALIDATE, FIXTURES, SCORING]) {
      expect(reached.has(target), `revalidate.ts must not reach ${rel(target)}: ${shown(reached.get(target))}`).toBe(false);
    }
  });

  it("guard.ts never reaches result.ts or preflight.ts, and never itself", () => {
    const reached = walk(GUARD);
    expect(reached.has(FIXTURES), "premise: guard.ts → fixtures.ts (the edge the mocks sit on)").toBe(true);
    for (const target of [RESULT, PREFLIGHT, GUARD]) {
      expect(reached.has(target), `guard.ts must not reach ${rel(target)}: ${shown(reached.get(target))}`).toBe(false);
    }
  });
});

// T17 fix round 5, I2 — the public read never loads the write graph. cacc41489 made `external-play-read.ts` import
// `fenAfter` from `external-play/play.ts`, so loading the public read ran play.ts → result.ts → scoring.ts →
// org-posts.ts, whose `const superuser = sql …` touches the database client AT MODULE LOAD. Any suite that mocks
// `@/lib/db` without `sql` and reaches the read then fails to collect (registration's fetch-registrant-details). The
// replay now lives in the leaf `server/external-play/fen.ts`: chess.js and nothing of this app.
describe("the public read path never loads the play/scoring write graph (I2)", () => {
  it("premise: the walker sees the old chain — play.ts DOES reach org-posts.ts and lib/db.ts", () => {
    const fromPlay = walk(PLAY);
    expect(fromPlay.has(ORG_POSTS), `play.ts → org-posts.ts: ${shown(fromPlay.get(ORG_POSTS))}`).toBe(true);
    expect(fromPlay.has(DB), "play.ts → lib/db.ts").toBe(true);
  });

  it("fen.ts is a leaf: it imports no module of this app at all — no database, no usecase", () => {
    expect(fs.existsSync(FEN), "the leaf exists").toBe(true);
    expect([...walk(FEN).keys()].map(rel), "fen.ts's own app imports").toEqual([]);
  });

  it("external-play-read.ts reaches fen.ts, yet never play.ts, scoring.ts or org-posts.ts", () => {
    const reached = walk(READ);
    expect(reached.size, "anti-vacuity: modules visited from external-play-read.ts").toBeGreaterThan(5);
    expect(reached.has(FEN), "premise: the read replays through the leaf").toBe(true);
    for (const target of [PLAY, SCORING, ORG_POSTS]) {
      expect(reached.has(target), `external-play-read.ts must not reach ${rel(target)}: ${shown(reached.get(target))}`).toBe(false);
    }
  });
});
