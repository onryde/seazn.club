// W1d Task 15, fix round 1, I1 / T15-CUT (D14; rulings 66, 67): how a Stryker leg takes PART of one source file.
//
// A file too big for one leg (its mutants at the measured cost of one are over the 200-minute split line) is cut into parts
// at top-level STATEMENT boundaries, each cut named by the statement that STARTS the next part (an "anchor": the name an
// `export function`, `const`, `class`, `interface`, `type` or `enum` declares). stryker.groups.mjs declares the cuts
// (STRYKER_SPLITS) and a leg takes a part with `file#N`; this module turns them into the `file:a-b` ranges Stryker's `mutate`
// reads, with the TypeScript parser, whenever a config, the floor or a test needs them.
//
// Why not line numbers (the first build): Stryker keeps a mutant for a range only when the mutant's whole node lies inside it,
// so a boundary inside a statement loses the mutants of every node that spans it (a function body, an object literal), and a
// boundary typed as a line number lands inside a statement the first time anything is added above it. The reviewer ran
// Stryker's own instrumenter over copies of the five split kernels with one blank line added at the top: 3 mutants lost in
// cricket.ts, 2 in football.ts, 1 each in the period, setbased and nested kernels. A cut resolved from an anchor sits right
// after the last line of the statement before it, so whitespace, comments and edits inside any statement cannot move it from
// that statement, no mutant can fall on it, and nothing is lost by construction. test/stryker-cuts.test.ts proves it with
// Stryker's own instrumenter on the real kernels, with an edit at the top of cricket.ts.
//
// Plain .mjs, like stryker.groups.mjs: stryker.config.mjs loads it under `stryker`, and the parser is loaded only when a cut is
// resolved, so scripts/stryker-matrix.mjs (which needs only the group names and runs before any install) never touches it.
// scripts/stryker-cuts.d.mts types it for the engine's .ts tests; a test holds the two equal.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STRYKER_GROUPS, STRYKER_SPLITS } from "../stryker.groups.mjs";

/** How a range says "to the end of the file": lines added at the foot of a file stay in its last part. */
export const TO_END_OF_FILE = 99999;

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The engine's own `typescript` (a devDependency), loaded the first time a cut is resolved.
 *  @type {typeof import("typescript") | undefined} */
let tsModule;
function typescript() {
  if (tsModule === undefined) {
    try {
      /** @type {unknown} */
      const loaded = createRequire(import.meta.url)("typescript");
      tsModule = /** @type {typeof import("typescript")} */ (loaded);
    } catch (e) {
      throw new Error(`scripts/stryker-cuts.mjs resolves a cut with the TypeScript parser, and \`typescript\` did not load (run pnpm install): ${e.message}`);
    }
  }
  return tsModule;
}

/** The names one top-level statement declares: a function, class, interface, type alias, enum or namespace by its name, a
 *  `const`/`let`/`var` statement by each name it binds. Other statements (an import, an `export { ... }`, an expression)
 *  declare none, and cannot be anchors.
 *  @param {typeof import("typescript")} ts
 *  @param {import("typescript").Statement} statement
 *  @returns {string[]} */
function declaredNames(ts, statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  if (
    ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
  ) {
    return statement.name !== undefined && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
  }
  return [];
}

/** The top-level statements of `text`, in source order: `{index, names, startLine, endLine}` with lines 1-based. A statement
 *  starts at its first token (a comment above it, its JSDoc included, belongs to the gap before it) and ends where its last
 *  token does, so the lines of two statements never overlap unless they share a line. */
export function topLevelStatements(text) {
  const ts = typescript();
  const source = ts.createSourceFile("cut.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  return source.statements.map((s, index) => ({ index, names: declaredNames(ts, s), startLine: line(s.getStart(source)), endLine: line(s.getEnd()) }));
}

/** The index of the top-level statement that `anchor` names, or the reason it cannot be one. */
function anchorIndex(statements, anchor, label) {
  const declaring = statements.filter((s) => s.names.includes(anchor));
  if (declaring.length === 0) throw new Error(`${label}: no top-level statement declares "${anchor}"`);
  if (declaring.length > 1) throw new Error(`${label}: "${anchor}" is declared by ${declaring.length} top-level statements (an overload set, or a type and a value of one name), so a cut before it is ambiguous; anchor on another statement`);
  return declaring[0].index;
}

/** The ranges `file:a-b` that `anchors` cut a file into: the parts tile lines 1..TO_END_OF_FILE exactly. Part k ends on the
 *  last line of the statement before its next anchor, and the next part starts on the line after it (so a comment, a JSDoc or
 *  a blank line between two statements goes with the statement BELOW it). `label` names the file in a refusal. */
export function resolveSplit(text, anchors, label = "the file") {
  const statements = topLevelStatements(text);
  const ends = [];
  let previous = -1;
  for (const anchor of anchors) {
    const at = anchorIndex(statements, anchor, label);
    if (at === 0) throw new Error(`${label}: "${anchor}" is the first statement, and a cut before it leaves an empty part`);
    if (at <= previous) throw new Error(`${label}: "${anchor}" must come after the previous anchor in the file (anchors are listed in source order, each once); it is at statement ${at + 1} and the one before it at ${previous + 1}`);
    const before = statements[at - 1];
    if (before.endLine >= statements[at].startLine) throw new Error(`${label}: "${anchor}" starts on line ${statements[at].startLine}, the same line the statement before it ends, and a line range cannot cut between them`);
    ends.push(before.endLine);
    previous = at;
  }
  const ranges = [];
  let from = 1;
  for (const end of ends) {
    ranges.push([from, end]);
    from = end + 1;
  }
  ranges.push([from, TO_END_OF_FILE]);
  return ranges;
}

const PART = /^(.*)#(\d+)$/;

/** `entries` (a leg's `mutate` list as stryker.groups.mjs declares it) with each `file#N` replaced by the range of part N of
 *  that file, `file:a-b`; every other entry (a glob, a `!` negation, a whole file) is kept as it is, in order. `splits` maps a
 *  file to its anchors, and `readText(file)` gives the file's source. */
export function resolveEntries(entries, splits, readText) {
  const cache = new Map();
  return entries.map((entry) => {
    const m = PART.exec(entry);
    if (m === null) return entry;
    const file = m[1];
    const anchors = splits[file];
    if (anchors === undefined) throw new Error(`${entry}: ${file} has no split in STRYKER_SPLITS`);
    if (!cache.has(file)) cache.set(file, resolveSplit(readText(file), anchors, file));
    const ranges = cache.get(file);
    const part = Number(m[2]);
    if (part < 1 || part > ranges.length) throw new Error(`${entry}: part ${part} does not exist, ${file} has parts 1 to ${ranges.length}`);
    const [from, to] = ranges[part - 1];
    return `${file}:${from}-${to}`;
  });
}

/** One leg's `mutate` list with its parts resolved to ranges (what stryker.config.mjs hands to Stryker). `cwd` is the
 *  engine directory, which the files are read from. */
export function resolveGroup(group, cwd = ENGINE) {
  const entries = STRYKER_GROUPS[group];
  if (entries === undefined) throw new Error(`unknown group "${group}": expected one of ${Object.keys(STRYKER_GROUPS).join(", ")}`);
  return resolveEntries(entries, STRYKER_SPLITS, (file) => readFileSync(join(cwd, file), "utf8"));
}

/** How many of the mutants that START on `startLines` (1-based, one entry per mutant) fall inside each top-level statement:
 *  `weights[i]` is statement i's. A mutant outside every statement is refused (it would be lost whichever way the file is cut). */
export function statementMutants(statements, startLines) {
  const weights = statements.map(() => 0);
  for (const line of startLines) {
    const at = statements.findIndex((s) => line >= s.startLine && line <= s.endLine);
    if (at === -1) throw new Error(`a mutant starts on line ${line}, outside every top-level statement`);
    weights[at]++;
  }
  return weights;
}

/** The split of statements `0..n-1` into `parts` runs that minimises the largest run, where a cut before statement i is allowed
 *  only if `cutable[i]` and every run holds at least one mutant. `extra` mutants (the other files a leg also carries) are
 *  added to the LAST run. Returns `{cuts, sizes, max}` (cuts are the statement indices that start runs 2..parts), or null when
 *  no such split exists. Ties go to the earliest cuts, so a plan is stable. */
export function planSplit({ weights, cutable, parts, extra = 0 }) {
  const n = weights.length;
  const prefix = [0];
  for (const w of weights) prefix.push(prefix[prefix.length - 1] + w);
  const sum = (from, to) => prefix[to] - prefix[from];
  // best[k][i]: the smallest possible largest run when statements i..n-1 are split into k runs; null when impossible
  const best = Array.from({ length: parts + 1 }, () => new Array(n + 1).fill(null));
  for (let i = 0; i < n; i++) best[1][i] = sum(i, n) > 0 ? { max: sum(i, n) + extra, next: n } : null;
  for (let k = 2; k <= parts; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!cutable[j] || sum(i, j) <= 0 || best[k - 1][j] === null) continue;
        const max = Math.max(sum(i, j), best[k - 1][j].max);
        if (best[k][i] === null || max < best[k][i].max) best[k][i] = { max, next: j };
      }
    }
  }
  if (n === 0 || best[parts][0] === null) return null;
  const cuts = [];
  const sizes = [];
  let at = 0;
  for (let k = parts; k >= 1; k--) {
    const next = best[k][at].next;
    sizes.push(sum(at, next === n ? n : next) + (k === 1 ? extra : 0));
    if (k > 1) cuts.push(next);
    at = next;
  }
  return { cuts, sizes, max: best[parts][0].max };
}
