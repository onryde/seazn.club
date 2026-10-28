// The rules reference CHECKER (W2a ruling 75, spec §6). The PARSER (reading `rules/*.md`, row parsing, `enforced at` / `proved by`
// extraction) lives in src/testkit/rules-reference.ts since engine-split 1d-5 and ships in the package; what stays here reads the
// REPO: does a proving test exist, does its title name the rule. The old names are re-exported so the checker's tests read as before.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  RULES_DIR as TESTKIT_RULES_DIR,
  RULE_ID,
  RULE_ROW_HEADER,
  RULE_ROW_SHAPED,
  RULE_STATUS,
  allRows,
  parseRuleRows,
  ruleFiles,
  type RuleRow,
} from "../src/testkit/rules-reference.ts";

export { allRows, parseRuleRows, ruleFiles, type RuleRow };
export const RULES_DIR = TESTKIT_RULES_DIR;
export const ROW_HEADER = RULE_ROW_HEADER;
export const STATUS = RULE_STATUS;
export const ID = RULE_ID;
export const ROW_SHAPED = RULE_ROW_SHAPED;

export const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The MONOREPO root. Only the checks that read paths outside the engine use it (the root half, scripts/__tests__/rules-reference.test.ts). */
export const REPO = resolve(ENGINE, "..", "..");
/** A file that can prove a rule: a test or spec file, never a rules table, a doc, or the checker. */
export const TEST_FILE = /\.(?:test\.tsx?|spec\.ts)$/;
/** The checker's own files (repo-relative): they hold ids as data, so they can never prove one. */
export const CHECKER_FILES: readonly string[] = [
  "packages/engine/test/rules-reference.ts",
  "packages/engine/test/rules-reference.test.ts",
  "scripts/__tests__/rules-reference.test.ts",
];

/** Signed rows whose proving test lands in a later W2a task. A task that adds
 *  the proof deletes its id here in the same commit; Task 16 Step 5 requires
 *  this map to be EMPTY. A row not named here must already be proved.
 *  W2c's rows: the value names the first W2c task that proves the row (plan Appendix A). The orchestrator's batch-end
 *  proof commit deletes the entry and fills the row's `proved by`; W2c Task 23 requires the map empty.
 *  W2d's rows (spec 2026-10-20 Appendix A, signed 2026-10-24): the value names the first W2d task whose "Rule rows" line
 *  lists the row (plan 2026-10-20-format-matrix-w2d.md). Each wave's proof commit deletes the entry and fills `proved by`;
 *  W2d Task 21 requires the map empty for W2d ids.
 *  W2d Task 21 (the fold) emptied it: all 43 W2d rows now name their proving tests and are signed by ruling 197. */
/** W2e's rows (spec 2026-10-28 section 8, signed 2026-10-28 as `W2e-D<n>`): the value names the task of the W2e plan that proves the row. The proving
 *  commit deletes the entry and fills `proved by`; every W2e entry is to be gone before PR A merges. */
export const AWAITING_PROOF: ReadonlyMap<string, string> = new Map<string, string>([
  ["X-SE-1", "Task 1"],
  ["X-SE-2", "Task 1"],
  ["X-SU-1", "Task 15"],
  ["X-DV-1", "Task 17"],
  ["BD-VR-1", "Task 3"],
  ["BD-SE-1", "Task 3"],
  ["BD-SV-1", "Task 16"],
  ["BD-DV-1", "Task 16"],
  ["VB-SE-1", "Task 3"],
  ["VB-CF-1", "Task 13"],
  ["VB-RO-1", "Task 16"],
  ["TT-CF-1", "Task 13"],
  ["TT-SE-1", "Task 16"],
  ["TT-TO-1", "Task 16"],
  ["TN-SE-1", "Task 4"],
  ["TN-SS-1", "Task 4"],
  ["TN-SS-2", "Task 5"],
  ["TN-CF-1", "Task 13"],
  ["TN-SE-2", "Task 16"],
  ["TN-RO-1", "Task 16"],
  ["CK-RR-1", "Task 8"],
  ["CK-IV-1", "Task 14"],
  ["CK-FO-1", "Task 14"],
  ["CK-IF-1", "Task 14"],
  ["CK-RR-2", "Task 14"],
  ["CK-PR-1", "Task 14"],
  ["CK-MO-1", "Task 14"],
  ["CK-SO-2", "Task 14"],
  ["CK-RT-2", "Task 14"],
  ["CK-AB-3", "Task 14"],
  ["CK-RH-1", "Task 14"],
  ["CK-BO-1", "Task 14"],
  ["CK-FH-1", "Task 14"],
  ["CK-WK-1", "Task 14"],
  ["CK-CR-1", "Task 14"],
  ["CK-RO-1", "Task 14"],
  ["CK-DV-1", "Task 14"],
  ["CK-DV-2", "Task 14"],
  ["CK-DV-3", "Task 14"],
  ["FB-OG-1", "Task 15"],
  ["FB-YT-1", "Task 15"],
  ["FB-SB-1", "Task 15"],
  ["FB-SU-1", "Task 15"],
  ["FB-RO-1", "Task 15"],
  ["HK-SO-1", "Task 9"],
  ["HK-SO-2", "Task 9"],
  ["HK-YT-1", "Task 15"],
  ["HK-SU-1", "Task 15"],
  ["HK-GK-1", "Task 15"],
  ["HK-ST-1", "Task 15"],
  ["IH-SO-1", "Task 9"],
  ["IH-SO-2", "Task 9"],
  ["IH-SU-1", "Task 15"],
  ["IH-ST-1", "Task 15"],
  ["BG-RS-1", "Task 10"],
  ["BG-AB-3", "Task 17"],
  ["CA-AD-1", "Task 11"],
  ["CA-VR-1", "Task 17"],
  ["CA-DG-1", "Task 17"],
  ["CA-RO-1", "Task 17"],
  ["GN-DV-1", "Task 17"],
]);

/** Rule rows write every engine path as `packages/engine/...`, in the monorepo and in the engine's own repo alike: the prefix is
 *  part of the row's text, not of the checkout. Rows whose path starts with it are the ENGINE's to check (test/rules-reference.test.ts);
 *  every other path (apps/web, e2e, tools, packages/reference, ...) is the monorepo's (scripts/__tests__/rules-reference.test.ts). */
export const ENGINE_ROW_PREFIX = "packages/engine/";
export const inEngine = (p: string): boolean => p.startsWith(ENGINE_ROW_PREFIX);
/** A row's engine path on disk: resolved against ENGINE, never REPO, so it also holds where the engine sits at a repo root. No CI job runs
 *  that layout yet; the simulated engine repo run of engine-split 1d-6 is its witness (a REPO-relative resolution passes in the monorepo). */
const enginePath = (p: string): string => join(ENGINE, p.slice(ENGINE_ROW_PREFIX.length));
/** Whether a row's engine path exists. A path that is not the engine's does not (it is not this checker's to find). */
export const engineFileExists = (p: string): boolean => inEngine(p) && existsSync(enginePath(p));

/** A `proved by` entry is a repo-relative test path, or a matrix case id prefixed `matrix:`. A matrix case is
 *  additional evidence only: a row that names nothing else names no proving test (spec §6). */
export const isMatrixCase = (p: string): boolean => p.startsWith("matrix:");
export const fileExists = (p: string): boolean => existsSync(join(REPO, p));

/** Reads a repo-relative file; undefined when it does not exist. Injectable into `proofProblems`, so a synthetic row
 *  proves against in-memory fixtures instead of borrowing a real file (the old positive pair was the checker itself). */
export type ReadRepoFile = (repoPath: string) => string | undefined;
const readOrUndefined = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};
export const readRepoFile: ReadRepoFile = (p) => readOrUndefined(join(REPO, p));
/** The reader of the engine half: a `packages/engine/...` path read from the engine directory; any other path is undefined. */
export const readEngineFile: ReadRepoFile = (p) => (inEngine(p) ? readOrUndefined(enginePath(p)) : undefined);

/** Batch 4 review M7. The proof check reads one proving file per (row, test path) pair and parses each DISTINCT file once
 *  (`testTitles` memoises), so its cost grows with the table: 1.4 s for 311 pairs on an idle machine (about 4.5 ms a pair),
 *  and it timed out at 13 s under load. AGENTS.md class 20: a flat timeout beside a derived cost is a latent red, so the
 *  budget is stated from the pairs the table has. PROOF_PAIR_MS is about 20x the idle cost, the margin a loaded machine
 *  needed (the Stryker spawn tests budget the same way, `spawnBudget`); PROOF_SLACK_MS is the file-system and parse floor.
 *  ONE budget for both halves of the check (the engine's paths here, the monorepo's in scripts/__tests__/rules-reference.test.ts):
 *  two copies of the constants would drift. */
export const PROOF_PAIR_MS = 100;
export const PROOF_SLACK_MS = 5_000;
export const proofBudget = (pairs: number): number => {
  if (!Number.isInteger(pairs) || pairs < 1) throw new Error(`proofBudget: ${pairs} is not a pair count of at least 1`);
  return PROOF_SLACK_MS + pairs * PROOF_PAIR_MS;
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

/** The last parse of each path, with the exact source it parsed. Many rows cite the same test file (abandon-result,
 *  bracket-finish, double-walkover …), and an AST parse per (row, path) pair is what made the proof test cost seconds
 *  (W2b Task 14 M-3: about 265 parses of 66 files). A hit needs the SAME source, not just the same path: a synthetic test
 *  that hands one path two different in-memory sources gets each source's own titles. */
const TITLES_MEMO = new Map<string, { source: string; titles: readonly string[] }>();

/** The first argument of every title-bearing call that is a string literal, from the AST, so a comment, a body string
 *  and a second argument are never titles; an unconditionally skipped call yields nothing and is not entered. */
export function testTitles(path: string, source: string): string[] {
  const hit = TITLES_MEMO.get(path);
  if (hit !== undefined && hit.source === source) return [...hit.titles];
  const titles = parseTestTitles(path, source);
  TITLES_MEMO.set(path, { source, titles });
  return [...titles];
}

function parseTestTitles(path: string, source: string): string[] {
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
export function proofProblems(r: RuleRow, read: ReadRepoFile = readRepoFile, scope: (path: string) => boolean = () => true): string[] {
  const tests = r.provedBy.filter((p) => !isMatrixCase(p));
  if (tests.length === 0) return [`${r.id} names no proving test`];
  const out: string[] = [];
  // `scope` splits a row's proofs between the engine's checker and the monorepo's: each checks the paths it can read. The row-level
  // refusal above is about the row's text and is the same in both.
  for (const p of tests.filter(scope)) {
    const bad = pathProblem(p);
    if (bad !== null) { out.push(`${r.id}: ${p} ${bad}`); continue; }
    const source = read(p);
    if (source === undefined) { out.push(`${r.id}: ${p} does not exist`); continue; }
    if (!testTitles(p, source).some((t) => hasToken(t, r.id))) out.push(`${r.id}: ${p} has no it/test/describe title naming "${r.id}"`);
  }
  return out;
}
