// The rules reference (W2a ruling 75, spec §6). One row per line of a
// markdown table whose header is exactly ROW_HEADER. Cells are split on " | ";
// `enforced at` and `proved by` hold backticked paths separated by "<br>".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(ENGINE, "..", "..");
export const RULES_DIR = join(ENGINE, "rules");
export const ROW_HEADER = "| id | rule | citation | status | enforced at | proved by |";
export const STATUS = /^(signed \d+ \d{4}-\d{2}-\d{2}|deviation \d+ \d{4}-\d{2}-\d{2}|⬜ open)$/;
export const ID = /^[A-Z]{1,3}-[A-Z]{2}-\d+$/;
/** A line that looks like a rule row. The parser reads one table; a row-shaped line it did not read is a failure. */
export const ROW_SHAPED = /^\| [A-Z]{1,3}-[A-Z]{2}-\d+ \|/;
/** A file that can prove a rule: a test or spec file, never a rules table, a doc, or the checker. */
export const TEST_FILE = /\.(?:test\.tsx?|spec\.ts)$/;
/** The checker's own two files (repo-relative): they hold ids as data, so they can never prove one. */
export const CHECKER_FILES: readonly string[] = ["packages/engine/test/rules-reference.ts", "packages/engine/test/rules-reference.test.ts"];

export interface RuleRow {
  id: string; rule: string; citation: string; status: string;
  enforcedAt: string[]; provedBy: string[]; file: string;
}

const paths = (cell: string): string[] =>
  cell.trim() === "—" ? [] : cell.split("<br>").map((p) => p.trim().replace(/^`|`$/g, "")).filter((p) => p !== "");

export function parseRuleRows(text: string, file: string): RuleRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === ROW_HEADER);
  const rows: RuleRow[] = [];
  const read = new Set<number>();
  if (start !== -1) {
    for (const [i, line] of lines.entries()) {
      if (i < start + 2) continue;
      if (!line.startsWith("| ")) break;
      const cells = line.slice(2, -2).split(" | ");
      if (cells.length !== 6) throw new Error(`${file}: a rule row has ${cells.length} cells, not 6: ${line}`);
      const [id, rule, citation, status, enforced, proved] = cells.map((c) => c.trim()) as [string, string, string, string, string, string];
      rows.push({ id, rule, citation, status, enforcedAt: paths(enforced), provedBy: paths(proved), file });
      read.add(i);
    }
  }
  // Spec §6: a row the parser skips is a failure, not a row nobody checks. The table ends at the first non-row line,
  // so a row after prose, a second table, or a file with no header at all would otherwise be silently unchecked.
  const skipped = lines.flatMap((l, i) => (ROW_SHAPED.test(l) && !read.has(i) ? [`line ${i + 1}: ${l.slice(0, 48)}`] : []));
  if (skipped.length > 0) throw new Error(`${file}: ${skipped.length} row-shaped line(s) not read as rows (a row after prose, a second table, or no table header): ${skipped.join("; ")}`);
  return rows;
}

export function ruleFiles(): string[] {
  return readdirSync(RULES_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
}

export function allRows(): RuleRow[] {
  return ruleFiles().flatMap((f) => parseRuleRows(readFileSync(join(RULES_DIR, f), "utf8"), f));
}

/** A `proved by` entry is a repo-relative test path, or a matrix case id prefixed `matrix:`. A matrix case is
 *  additional evidence only: a row that names nothing else names no proving test (spec §6). */
export const isMatrixCase = (p: string): boolean => p.startsWith("matrix:");
export const fileExists = (p: string): boolean => existsSync(join(REPO, p));

/** Reads a repo-relative file; undefined when it does not exist. Injectable into `proofProblems`, so a synthetic row
 *  proves against in-memory fixtures instead of borrowing a real file (the old positive pair was the checker itself). */
export type ReadRepoFile = (repoPath: string) => string | undefined;
export const readRepoFile: ReadRepoFile = (p) => {
  try {
    return readFileSync(join(REPO, p), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/** Test frameworks' entry points. Every title-bearing call starts at one of these. */
const TEST_ROOTS = ["it", "test", "describe"];
/** Modifiers that switch a test off for good: its title proves nothing and nothing inside it runs. */
const UNCONDITIONAL_SKIPS = ["skip", "todo", "fixme"];
/** Modifiers that switch a test off only when a condition holds, as `it.skipIf(cond)(title, fn)`: CI's DB jobs run it. */
const CONDITIONAL_SKIPS = ["skipIf", "runIf"];
/** Playwright group modes, as `test.describe.serial(title, fn)`. */
const DESCRIBE_MODES = ["serial", "parallel"];
/** Callees that are themselves `title, fn` calls: `it(`, `test(`, `describe(`, `test.describe(`, `test.describe.serial(`. */
const DIRECT_CALLEES = new Set([...TEST_ROOTS, "test.describe", ...DESCRIBE_MODES.map((m) => `test.describe.${m}`)]);
/** Callees that are themselves calls returning the `title, fn` function: the callee of `it.skipIf(cond)(title, fn)`. */
const GATE_CALLEES = new Set(TEST_ROOTS.flatMap((r) => CONDITIONAL_SKIPS.map((g) => `${r}.${g}`)));

/** `test.describe.serial` -> "test.describe.serial"; undefined unless the expression is a plain dotted name. */
const dotted = (e: ts.Expression): string | undefined => {
  if (ts.isIdentifier(e)) return e.text;
  if (!ts.isPropertyAccessExpression(e)) return undefined;
  const up = dotted(e.expression);
  return up === undefined ? undefined : `${up}.${e.name.text}`;
};

/** Every name along a callee, root first, looking through calls: `describe.skip.each([1])` -> [describe, skip, each].
 *  Undefined when the chain does not start at it/test/describe. */
const names = (e: ts.Expression): string[] | undefined => {
  if (ts.isIdentifier(e)) return TEST_ROOTS.includes(e.text) ? [e.text] : undefined;
  if (ts.isCallExpression(e)) return names(e.expression);
  if (!ts.isPropertyAccessExpression(e)) return undefined;
  const up = names(e.expression);
  return up === undefined ? undefined : [...up, e.name.text];
};

type Callee = "title" | "skipped" | "other";
/** What a call's callee makes of its first argument. `skipped`: the title proves nothing and the call is not entered,
 *  so a test inside `describe.skip(...)` is not a proof either. */
function classify(callee: ts.Expression): Callee {
  const chain = names(callee);
  if (chain === undefined) return "other";
  if (chain.some((n) => UNCONDITIONAL_SKIPS.includes(n))) return "skipped";
  const direct = dotted(callee);
  if (direct !== undefined) return DIRECT_CALLEES.has(direct) ? "title" : "other";
  const gate = ts.isCallExpression(callee) ? dotted(callee.expression) : undefined;
  return gate !== undefined && GATE_CALLEES.has(gate) ? "title" : "other";
}

/** The first argument of every title-bearing call that is a string literal, from the AST, so a comment, a body string
 *  and a second argument are never titles; an unconditionally skipped call yields nothing and is not entered. */
export function testTitles(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const titles: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const kind = classify(n.expression);
      if (kind === "skipped") return;
      const first = n.arguments[0];
      if (kind === "title" && first !== undefined && ts.isStringLiteralLike(first)) titles.push(first.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return titles;
}

/** What may not touch an id on either side: a longer id (X-ST-10), a suffix (X-ST-1-b), a prefix (AX-ST-1). */
const TOKEN_EDGE = "[A-Za-z0-9-]";
export const hasToken = (text: string, id: string): boolean =>
  new RegExp(`(?<!${TOKEN_EDGE})${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!${TOKEN_EDGE})`).test(text);

/** Why a `proved by` path cannot prove anything, or null. Checked before the file is read. */
function pathProblem(p: string): string | null {
  if (p.startsWith("/") || p.startsWith("../") || posix.normalize(p) !== p) return "is not a normalised repo-relative path";
  if (p.startsWith("packages/engine/rules/") || p.startsWith("docs/")) return "is under packages/engine/rules/ or docs/, which cannot prove a rule";
  if (CHECKER_FILES.includes(p)) return "is the checker itself, which holds every id as data";
  if (!TEST_FILE.test(p)) return "is not a test file (*.test.ts, *.test.tsx or *.spec.ts)";
  return null;
}

/** The proving checks for one signed row, as data: exported so a synthetic row exercises them while every real row
 *  still awaits proof (preflight C5: at Task 2 no real row reaches these branches). A row needs at least one test
 *  path (matrix cases do not count), and EVERY test path it lists must prove the id: be a test file that exists and
 *  carry the id as a whole token in the first string argument of an `it(`, `test(` or `describe(` call. */
export function proofProblems(r: RuleRow, read: ReadRepoFile = readRepoFile): string[] {
  const tests = r.provedBy.filter((p) => !isMatrixCase(p));
  if (tests.length === 0) return [`${r.id} names no proving test`];
  const out: string[] = [];
  for (const p of tests) {
    const bad = pathProblem(p);
    if (bad !== null) { out.push(`${r.id}: ${p} ${bad}`); continue; }
    const source = read(p);
    if (source === undefined) { out.push(`${r.id}: ${p} does not exist`); continue; }
    if (!testTitles(p, source).some((t) => hasToken(t, r.id))) out.push(`${r.id}: ${p} has no it/test/describe title naming "${r.id}"`);
  }
  return out;
}
