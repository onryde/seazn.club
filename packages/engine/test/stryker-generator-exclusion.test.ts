// W2b ruling 109 (owner "yes"; MD-1): the `arbitraryEvent` test-data generators inside the sport modules are not mutated.
// They are excluded with `// Stryker disable all` before the method and `// Stryker restore all` after it, never by config.
//
// Why the comments sit OUTSIDE the method, and why this test exists: Stryker reads a directive only as a LEADING comment of
// a node it visits (@stryker-mutator/instrumenter 10.0.0, transformers/directive-bookkeeper.js `processStrykerDirectives`,
// called on enter). A `restore` written as the last line inside a body leads no node, so it is never read and the disable
// runs on to the end of the file, silently excluding whatever follows (coarsen, in cricket, football and setbased). A
// `disable` written as the first line inside the body would leave the body's own `BlockStatement → {}` mutant live.
//
// Held against Stryker's own instrumenter on the real files, never against the comments' text: every mutant that starts
// inside a generator is Ignored with the ruling's reason, and no other mutant in the file is Ignored at all.
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The instrumenter over the largest file (cricket.ts, ~4,300 mutants) takes under half a second idle; the budget is the
 *  one stryker-cuts.test.ts gives the same instrumenter, for a loaded machine. */
const INSTRUMENT_BUDGET_MS = 120_000;
const REASON = "W2b ruling 109";

interface Span { file: string; first: number; last: number }

/** Every `arbitraryEvent` METHOD declared in the engine's non-test source, by the TypeScript parser (1-based lines, from the
 *  method's own first line to its closing brace). An interface's `arbitraryEvent?(…)` is a signature, not a method. */
function generatorSpans(): Span[] {
  const out: Span[] = [];
  for (const file of globSync("src/**/*.ts", { cwd: ENGINE }).sort()) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(join(ENGINE, file), "utf8");
    if (!text.includes("arbitraryEvent")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isMethodDeclaration(n) && n.name.getText(sf) === "arbitraryEvent") {
        out.push({ file, first: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, last: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1 });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** An independent census of the same thing, from the text alone: a line that opens the generator method. */
function generatorCensus(): number {
  let n = 0;
  for (const file of globSync("src/**/*.ts", { cwd: ENGINE })) {
    if (file.endsWith(".test.ts")) continue;
    n += readFileSync(join(ENGINE, file), "utf8").split("\n").filter((l) => /^\s*arbitraryEvent\(state, rng: Rng\)/.test(l)).length;
  }
  return n;
}

interface Mutant { location: { start: { line: number } }; mutatorName: string; replacement: string; status?: string; statusReason?: string }
interface Instrumenter { instrument(files: { name: string; mutate: boolean; content: string }[], options: unknown): Promise<{ mutants: Mutant[] }> }
let instrumenter: Promise<Instrumenter> | undefined;
/** Stryker's own instrumenter, from @stryker-mutator/core's dependency tree (as test/stryker-coverage.ts loads it). */
function loadInstrumenter(): Promise<Instrumenter> {
  instrumenter ??= (async () => {
    const core = createRequire(join(ENGINE, "package.json")).resolve("@stryker-mutator/core/package.json");
    const path = createRequire(core).resolve("@stryker-mutator/instrumenter");
    const mod = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as { Instrumenter: new (logger: unknown) => Instrumenter };
    return new mod.Instrumenter({ debug() {}, info() {}, warn() {}, isDebugEnabled: () => false });
  })();
  return instrumenter;
}

const SPANS = generatorSpans();
const instrumented = new Map<string, Promise<Mutant[]>>();
/** The mutants Stryker's instrumenter makes over the whole of `file` (every mutator, the engine config's defaults). */
function mutantsOf(file: string): Promise<Mutant[]> {
  let hit = instrumented.get(file);
  if (hit === undefined) {
    const content = readFileSync(join(ENGINE, file), "utf8");
    hit = loadInstrumenter().then(async (i) => (await i.instrument([{ name: file, mutate: true, content }], { ignorers: [], plugins: null, excludedMutations: [] })).mutants);
    instrumented.set(file, hit);
  }
  return hit;
}
const line = (m: Mutant) => m.location.start.line + 1; // the instrumenter counts lines from 0

describe("ruling 109: Stryker ignores exactly the arbitraryEvent generators", () => {
  it("the sweep finds every generator method the source declares (the parser against a text census)", () => {
    expect(SPANS.length, "generators found").toBeGreaterThan(0);
    expect(SPANS.length, "the parser's count against the text census").toBe(generatorCensus());
    expect(new Set(SPANS.map((s) => s.file)).size, "one generator per file").toBe(SPANS.length);
  });

  it.each(SPANS)("$file: every mutant inside the generator is Ignored for the ruling, none outside it is", async ({ file, first, last }) => {
    const mutants = await mutantsOf(file);
    const inside = mutants.filter((m) => line(m) >= first && line(m) <= last);
    const outside = mutants.filter((m) => line(m) < first || line(m) > last);
    expect(inside.length, `${file}: mutants inside the generator`).toBeGreaterThan(0);
    expect(outside.length, `${file}: mutants outside the generator`).toBeGreaterThan(0);
    const live = inside.filter((m) => m.status !== "Ignored" || !(m.statusReason ?? "").startsWith(REASON));
    expect(live.map((m) => `${line(m)} ${m.mutatorName} → ${m.replacement}`), `${file}: generator mutants still mutated`).toEqual([]);
    const ignored = outside.filter((m) => m.status === "Ignored");
    expect(ignored.map((m) => `${line(m)} ${m.mutatorName} → ${m.replacement}`), `${file}: mutants Ignored outside the generator`).toEqual([]);
  }, INSTRUMENT_BUDGET_MS);

  it("the restore is READ: generators with code after them exist, and that code is mutated", async () => {
    let after = 0;
    let files = 0;
    for (const { file, last } of SPANS) {
      const later = (await mutantsOf(file)).filter((m) => line(m) > last);
      if (later.length > 0) files++;
      after += later.filter((m) => m.status !== "Ignored").length;
      expect(later.filter((m) => m.status === "Ignored").length, `${file}: Ignored after the generator`).toBe(0);
    }
    expect(files, "files with mutants after their generator").toBeGreaterThan(0);
    expect(after, "live mutants after a generator").toBeGreaterThan(0);
  }, INSTRUMENT_BUDGET_MS);
});
