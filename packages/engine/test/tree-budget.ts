// Shared by the tests that read the whole real src/ (boundary-gate, pack-proof). AGENTS.md class 20: a flat timeout beside a derived cost is
// a latent red, so a test (or the `beforeAll` that does its work once) states its budget from the number of files it touches.
//
// Measured on CI under v8 coverage (engine-split PR #958), where every function of the parser is instrumented: the slowest per-file pass over
// src/ - parsing a file and walking its whole token tree - cost about 60 ms a file. The allowance is ~7x that per pass, so a runner that is
// several times slower still passes while a hang is reported by the test that hung rather than by vitest's default 5 s.

/** What one pass over one file may take, in ms. */
export const PER_FILE_MS = 400;
/** The least a tree-wide test or hook is given, for a tree of few files. */
export const FLOOR_MS = 20_000;

/** The budget for work that makes `passes` passes over `files` files. */
export function treeBudget(files: number, passes = 1): number {
  if (!Number.isInteger(files) || files < 1) throw new Error(`treeBudget: ${files} is not a file count of at least 1`);
  if (!Number.isInteger(passes) || passes < 1) throw new Error(`treeBudget: ${passes} is not a pass count of at least 1`);
  return Math.max(FLOOR_MS, files * PER_FILE_MS * passes);
}
