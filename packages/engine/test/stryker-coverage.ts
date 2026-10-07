// Shared by the Stryker group tests (stryker-groups, stryker-sizing). Two things the groups tests cannot take from the code
// under test: WHICH LINES of which files a group's `mutate` list selects (the evaluator below copies Stryker's own reading
// of the list, and stryker-sizing checks the copy against a real Stryker dry run), and HOW MANY MUTANTS Stryker's own
// instrumenter finds in them (the instrumenter is what Stryker itself runs, resolved from @stryker-mutator/core).
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** An inclusive 1-based line range, as `file:a-b` writes it. */
export type Lines = readonly [number, number];
/** "all" is a whole file; otherwise the ranges (several when two entries range the same file). */
export type Selected = "all" | Lines[];

const RANGE = /^(.*):(\d+)-(\d+)$/;

/** `src/x.ts:3-9` -> its file and its range; a plain glob has no range. */
export function parseEntry(entry: string): { glob: string; lines: Lines | null } {
  const m = RANGE.exec(entry);
  return m ? { glob: m[1] as string, lines: [Number(m[2]), Number(m[3])] } : { glob: entry, lines: null };
}

/** The files (and which of their lines) a `mutate` list selects, read in order like Stryker's resolveFileDescriptions
 *  (@stryker-mutator/core 10.0.0, fs/project-reader.js): a positive entry adds files, a `!` entry removes the files it
 *  matches whatever was added before, and a later positive entry adds them back. Two entries for one file join (ranges
 *  concatenate, a whole file stays whole). */
export function selected(cwd: string, globs: readonly string[]): Map<string, Selected> {
  const out = new Map<string, Selected>();
  for (const entry of globs) {
    if (entry.startsWith("!")) {
      for (const f of [...out.keys()]) if (matchesGlob(f, entry.slice(1))) out.delete(f);
      continue;
    }
    const { glob, lines } = parseEntry(entry);
    for (const f of globSync(glob, { cwd })) {
      const was = out.get(f);
      if (lines === null || was === "all") out.set(f, "all");
      else out.set(f, [...(was ?? []), lines]);
    }
  }
  return out;
}

/** The source lines of `file` (relative to `cwd`). */
export const lineCount = (cwd: string, file: string): number => readFileSync(join(cwd, file), "utf8").split("\n").length;

interface Instrumenter {
  instrument(files: { name: string; mutate: unknown; content: string }[], options: unknown): Promise<{ mutants: unknown[] }>;
}
let instrumenter: Promise<Instrumenter> | undefined;

/** Stryker's own instrumenter, from @stryker-mutator/core's dependency tree (the engine does not depend on it directly). */
function loadInstrumenter(cwd: string): Promise<Instrumenter> {
  instrumenter ??= (async () => {
    const core = createRequire(join(cwd, "package.json")).resolve("@stryker-mutator/core/package.json");
    const path = createRequire(core).resolve("@stryker-mutator/instrumenter");
    const mod = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as { Instrumenter: new (logger: unknown) => Instrumenter };
    return new mod.Instrumenter({ debug() {}, info() {}, isDebugEnabled: () => false });
  })();
  return instrumenter;
}

/** A mutant's place in its file, as Stryker reports it: LINES COUNT FROM 0 here (the JSON report counts from 1). */
export interface Place { start: { line: number; column: number }; end: { line: number; column: number } }
/** A mutant as Stryker's instrumenter reports it: its place, the mutator that made it, and the text it puts there. */
export interface Found extends Place { mutator: string; replacement: string }

const found = new Map<string, Found[]>();

/** The mutants Stryker's instrumenter finds in `content` (named `name`, so it is read as TypeScript), or in just its `lines`
 *  (1-based and inclusive, as `file:a-b` writes them), with the default mutator settings the engine's stryker.config.mjs
 *  runs. Not cached: a scratch edit of a file is a different text under the same name. */
export async function mutantsOfText(name: string, content: string, lines: Selected): Promise<Found[]> {
  // Stryker's ranges are 0-based lines; an end column of MAX_SAFE_INTEGER is a range of whole lines.
  const mutate = lines === "all" ? true : lines.map(([a, b]) => ({ start: { line: a - 1, column: 0 }, end: { line: b - 1, column: Number.MAX_SAFE_INTEGER } }));
  const inst = await loadInstrumenter(ENGINE);
  const r = await inst.instrument([{ name, mutate, content }], { ignorers: [], plugins: null, excludedMutations: [] });
  return (r.mutants as { location: Place; mutatorName: string; replacement: string }[]).map((m) => ({ ...m.location, mutator: m.mutatorName, replacement: m.replacement }));
}

/** The mutants Stryker's instrumenter finds in `file` of the working tree (or in just its `lines`). */
export async function mutantsOf(cwd: string, file: string, lines: Selected): Promise<Found[]> {
  const key = `${file}|${lines === "all" ? "all" : lines.map((l) => l.join("-")).join(",")}`;
  const hit = found.get(key);
  if (hit !== undefined) return hit;
  const places = await mutantsOfText(file, readFileSync(join(cwd, file), "utf8"), lines);
  found.set(key, places);
  return places;
}

/** How many mutants Stryker's instrumenter finds in `file` (or in just its `lines`). */
export async function mutantCount(cwd: string, file: string, lines: Selected): Promise<number> {
  return (await mutantsOf(cwd, file, lines)).length;
}

/** Mutants Stryker finds in everything `globs` selects. */
export async function groupMutants(cwd: string, globs: readonly string[]): Promise<number> {
  let n = 0;
  for (const [file, lines] of selected(cwd, globs)) n += await mutantCount(cwd, file, lines);
  return n;
}
