// R26: the single-sport ratchet. Counts the unreasoned single-sport pins in
// the sport sweep's scope and ratchets them against a committed baseline, so
// no count can rise — not in the tool, and not in CI, which also compares the
// PR's baseline with its base branch's (--against).
//
// Scope: every *.test.ts / *.test.tsx under packages/engine/src/{scheduling,
// competition}, plus every one under packages/engine/src or apps/web/src whose
// FILE name says standings, progression, seeding or tiebreak. node_modules and
// dot-directories are skipped; symlinks are not followed.
//
// Files are PARSED (the TypeScript parser, TSX for .tsx), not grepped, so
// comments, strings and code are told apart. A pin is either
//   - a registry sport key in matching quotes in a string or template
//     literal's source: the literal itself ("generic", 'generic', `generic`),
//     or a key quoted inside one (SQL: `values ('generic', …)`); or
//   - an import of one sport's module: `…/sports/<key>/…`,
//     `…/sports/setbased/<key>.ts`, or a named `{ <key> }` from
//     `@seazn/engine/sports` (static or dynamic import) — the engine's own
//     idiom for pinning a sport.
// A pin is SWEPT (not a pin) when it sits inside a sweep, or in a test block
// that itself sweeps. A sweep is a call shape, never a mention: a call of
// forEachSport / forEachSportAsync / sportCases; `for … of` over builtinModules
// or SPORT_KEYS; `.map/.forEach/.flatMap/.filter/.some/.every/.reduce(` on
// them; or `it.each(<registry>)`. A `.find(` or `[n]` pick is a pin, not a
// sweep, and a sweep in one test block exempts nothing in its siblings.
//
// A reason is a `// single-sport: <reason>` line comment, the reason
// non-empty. It covers:
//   - trailing a code line: that line only;
//   - on its own line as the first line of a block body (only comment lines,
//     no blank line, between the `{` and it), unless the next statement is a
//     test call: the rest of that block — the house convention
//     (scripts/matrix/__tests__, Task 7 M-2) is the first line of a test body;
//   - on its own line anywhere else — at indent 0 too, and across blank
//     lines: the NEXT statement only (a test call, an import, a const).
//
// The baseline counts unreasoned pins per `<file>:<sport>`. A line move is no
// change; a new entry, or a count that rises, fails --check. A count that
// falls passes, and --write records it (the ratchet turns down).
//
// usage: single-sport.ts [--check [--against REF] | --write | --init |
//                         --move OLD NEW] [--root DIR]
//   (no mode)  list the unreasoned pins;
//   --check    list them, then compare with the committed baseline. With
//              --against REF, the baseline itself must also sit at or below
//              REF's committed baseline (read via `git show REF:<path>`), so a
//              PR cannot raise the ceiling it is checked against. REF with no
//              baseline yet (the introducing PR) is a notice, not a failure;
//   --write    record today's counts. Only lowers: any count above the
//              baseline (a new entry included) is refused;
//   --init     write the first baseline; refused when one already exists;
//   --move     a renamed test file: transfer OLD's entries to NEW. OLD must be
//              gone from the tree and NEW scanned with no entries of its own.
//              The move is recorded, so --against maps NEW back to OLD.
//   --root     the checkout to scan (default: this file's own checkout).
// Exit codes, each with one meaning:
//   0  ok;
//   1  the ratchet is violated (--check): a new entry, a count that rose, or
//      (--against) a baseline above REF's;
//   2  refused: bad arguments; a scope root that scanned ZERO files (a scope
//      that finds nothing is wrong, not clean); a missing or malformed
//      baseline (here or at REF); an unknown REF; --write that would raise a
//      count; --init over an existing baseline; an invalid --move;
//   3  the scanner crashed — never 1, which would read as a ratchet verdict.
// Deterministic: files in codepoint order, pins in source order, keys sorted.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type * as TS from "typescript";
import { SPORT_KEYS } from "./lib/catalogue.ts";
import { isMainModule } from "./lib/main-module.ts";

// `typescript` through require, not import: vite's transform chokes on the
// ~9 MB CJS bundle and a test importing this module then fails to collect (as
// scenario-catalogue.test.ts). The type side is erased.
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

export const SCOPE_DIRS = ["packages/engine/src/scheduling", "packages/engine/src/competition"] as const;
export const NAME_ROOTS = ["packages/engine/src", "apps/web/src"] as const;
export const TEST_FILE = /\.test\.tsx?$/;
export const SCOPE_NAME = /(standing|progression|seeding|tiebreak)[^/\\]*\.test\.tsx?$/i;
export const REGISTRY_EXPORTS: ReadonlySet<string> = new Set(["builtinModules", "SPORT_KEYS"]);
export const SWEEP_CALLS: ReadonlySet<string> = new Set(["forEachSport", "forEachSportAsync", "sportCases"]);
export const ITERATORS: ReadonlySet<string> = new Set(["map", "forEach", "flatMap", "filter", "some", "every", "reduce"]);
export const TEST_ROOTS: ReadonlySet<string> = new Set(["it", "test", "describe", "bench"]);
export const BASELINE_PATH = "scripts/matrix/catalogue/single-sport-baseline.json";
export const REASON = /^\/\/\s*single-sport:\s*\S/;
const ENGINE_SPORTS = "@seazn/engine/sports";
const GENERATED_BY = "scripts/matrix/single-sport.ts";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = "usage: single-sport.ts [--check [--against REF] | --write | --init | --move OLD NEW] [--root DIR]";

export interface Pin { file: string; line: number; sport: string; via: "literal" | "import"; reasoned: boolean; swept: boolean }
export interface Scan { scanned: number; perRoot: Record<string, number>; pins: Pin[] }
/** Unreasoned pin counts per `<file>:<sport>`, and the recorded renames (NEW file → OLD file). */
export interface Baseline { pins: Record<string, number>; moves: Record<string, string> }
export interface Delta { key: string; was: number; now: number }

/** A sport-key match over no keys would match nothing and pass vacuously. */
export class EmptySportList extends Error {
  constructor() {
    super("single-sport: the sport list is empty — a scan over no keys finds nothing and proves nothing");
    this.name = "EmptySportList";
  }
}

/** A named refusal: the CLI exits 2 with its message. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

// A quote, then (a key), then the same quote. Built by concatenation: a regex
// literal inside a template literal's `${}` trips vite's import analysis.
const QUOTES = "([\"'`])";
const escapeRe = (k: string): string => k.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedRecord = <T>(r: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => byCodepoint(a, b)));

// ---------------------------------------------------------------- the parse

/** The test-call chain's root: `it`, `it.each([...])`, `describe.skip`, … */
function testRoot(e: TS.Expression): string | null {
  let x: TS.Expression = e;
  for (;;) {
    if (ts.isCallExpression(x) || ts.isPropertyAccessExpression(x)) x = x.expression;
    else if (ts.isIdentifier(x)) return x.text;
    else return null;
  }
}
const isTestCall = (n: TS.Node): n is TS.CallExpression => ts.isCallExpression(n) && TEST_ROOTS.has(testRoot(n.expression) ?? "");

function unwrap(e: TS.Expression): TS.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return x;
}

/** builtinModules / SPORT_KEYS (also as `x.SPORT_KEYS` or `[...builtinModules]`), or a sweep call's result. */
function isRegistryRef(e: TS.Expression): boolean {
  const x = unwrap(e);
  if (ts.isIdentifier(x)) return REGISTRY_EXPORTS.has(x.text);
  if (ts.isPropertyAccessExpression(x)) return REGISTRY_EXPORTS.has(x.name.text);
  if (ts.isArrayLiteralExpression(x)) return x.elements.length === 1 && x.elements[0] !== undefined && ts.isSpreadElement(x.elements[0]) && isRegistryRef(x.elements[0].expression);
  if (ts.isCallExpression(x)) return isSweep(x);
  return false;
}

/** A sweep is a call or an iteration over the registry — never a mention. */
export function isSweep(n: TS.Node): boolean {
  if (ts.isForOfStatement(n)) return isRegistryRef(n.expression);
  if (!ts.isCallExpression(n)) return false;
  const c = unwrap(n.expression);
  if (ts.isIdentifier(c)) return SWEEP_CALLS.has(c.text);
  if (!ts.isPropertyAccessExpression(c)) return false;
  if (ITERATORS.has(c.name.text) && isRegistryRef(c.expression)) return true;
  // it.each(SPORT_KEYS) / describe.each(builtinModules)
  return c.name.text === "each" && TEST_ROOTS.has(testRoot(c.expression) ?? "") && n.arguments.some(isRegistryRef);
}

/** The test block a node belongs to: its innermost enclosing test call,
 *  widened to the whole chain (`it.each(table)(name, fn)` is one block). */
function testBlockOf(n: TS.Node): TS.Node | undefined {
  let p: TS.Node | undefined = n.parent;
  while (p !== undefined && !isTestCall(p)) p = p.parent;
  if (p === undefined) return undefined;
  while (p.parent !== undefined && ts.isCallExpression(p.parent) && p.parent.expression === p) p = p.parent;
  return p;
}

function importedSports(spec: string, clause: TS.ImportClause | undefined, keys: ReadonlySet<string>): string[] {
  if (spec === ENGINE_SPORTS) {
    const named = clause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) return [];
    return named.elements.map((el) => (el.propertyName ?? el.name).text).filter((k) => keys.has(k));
  }
  const m = /(?:^|\/)sports\/(?:setbased\/)?([a-z]+)(?:[/.]|$)/.exec(spec);
  return m?.[1] !== undefined && keys.has(m[1]) ? [m[1]] : [];
}

/** Every `// single-sport:` reason's covered range [from, to) (see the header). */
function reasonRanges(sf: TS.SourceFile): Array<[number, number]> {
  const text = sf.text;
  const seen = new Map<number, TS.CommentRange>();
  const add = (rs: TS.CommentRange[] | undefined): void => { for (const r of rs ?? []) seen.set(r.pos, r); };
  const collect = (n: TS.Node): void => {
    if (n.kind === ts.SyntaxKind.JsxText) return;
    add(ts.getLeadingCommentRanges(text, n.pos));
    add(ts.getTrailingCommentRanges(text, n.end));
    for (const c of n.getChildren(sf)) collect(c);
  };
  collect(sf);

  const out: Array<[number, number]> = [];
  for (const r of seen.values()) {
    if (r.kind !== ts.SyntaxKind.SingleLineCommentTrivia || !REASON.test(text.slice(r.pos, r.end))) continue;
    const lineStart = text.lastIndexOf("\n", r.pos - 1) + 1;
    if (text.slice(lineStart, r.pos).trim() !== "") {
      const eol = text.indexOf("\n", r.end);
      out.push([lineStart, eol === -1 ? text.length : eol]);
      continue;
    }
    const next = statementAt(sf, skipTrivia(text, r.end));
    if (next === undefined) continue;
    const block = next.parent;
    const headsBody = ts.isBlock(block) && block.statements[0] === next && onlyCommentLinesBetween(text, block.getStart(sf), lineStart);
    const nextIsTest = ts.isExpressionStatement(next) && isTestCall(unwrap(next.expression));
    out.push([r.pos, headsBody && !nextIsTest ? block.end : next.end]);
  }
  return out;
}

/** The first position at or after `p` that is not whitespace or a comment
 *  (the public API has no skipTrivia). */
function skipTrivia(text: string, p: number): number {
  let i = p;
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (text.startsWith("//", i)) {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? text.length : eol;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else return i;
  }
}

/** The outermost node that starts at `p` (the statement a reason sits above). */
function statementAt(sf: TS.SourceFile, p: number): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (n: TS.Node): void => {
    if (found !== undefined) return;
    if (n !== sf && n.getStart(sf) === p) { found = n; return; }
    ts.forEachChild(n, (c) => { if (found === undefined && c.pos <= p && p < c.end) visit(c); });
  };
  visit(sf);
  return found;
}

/** The `{` ends its line, and every line after it up to `lineStart` is a comment line. */
function onlyCommentLinesBetween(text: string, bracePos: number, lineStart: number): boolean {
  const eol = text.indexOf("\n", bracePos);
  if (eol === -1 || eol >= lineStart || text.slice(bracePos + 1, eol).trim() !== "") return false;
  const between = text.slice(eol + 1, lineStart);
  return between === "" || between.split("\n").slice(0, -1).every((l) => /^\s*\/\//.test(l));
}

/** Every pin in `text`, in source order, with its reasoned and swept flags. */
export function pinsIn(text: string, file: string, sports: readonly string[] = SPORT_KEYS): Pin[] {
  if (sports.length === 0) throw new EmptySportList();
  const keys = new Set(sports);
  const quoted = new RegExp(QUOTES + "(" + sports.map(escapeRe).join("|") + ")\\1", "g");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ node: TS.Node; at?: number; sport: string; via: Pin["via"] }> = [];
  const sweeps: TS.Node[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      for (const s of importedSports(n.moduleSpecifier.text, n.importClause, keys)) found.push({ node: n, sport: s, via: "import" });
      return;
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a !== undefined && ts.isStringLiteralLike(a)) for (const s of importedSports(a.text, undefined, keys)) found.push({ node: n, sport: s, via: "import" });
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      // Over the literal's SOURCE text, delimiters included: "generic" itself,
      // and a key quoted inside it — `values ('generic', …)` in a SQL template.
      const raw = n.getText(sf);
      const start = n.getStart(sf);
      for (const m of raw.matchAll(quoted)) if (m[2] !== undefined) found.push({ node: n, at: start + m.index + 1, sport: m[2], via: "literal" });
    }
    if (isSweep(n)) sweeps.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const sweepBlocks = new Set(sweeps.map(testBlockOf).filter((b): b is TS.Node => b !== undefined));
  const insideSweep = (n: TS.Node): boolean => {
    for (let p = n.parent; p !== undefined; p = p.parent) if (sweeps.includes(p)) return true;
    return false;
  };
  const ranges = reasonRanges(sf);
  return found.map(({ node, at: pos, sport, via }) => {
    const at = pos ?? node.getStart(sf);
    const block = testBlockOf(node);
    return {
      file,
      line: sf.getLineAndCharacterOfPosition(at).line + 1,
      sport,
      via,
      reasoned: ranges.some(([from, to]) => at >= from && at < to),
      swept: insideSweep(node) || (block !== undefined && sweepBlocks.has(block)),
    };
  });
}

// ---------------------------------------------------------------- the scan

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && TEST_FILE.test(e.name)) out.push(p);
  }
}

function filesUnder(root: string, d: string): string[] {
  const abs = resolve(root, d);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  walk(abs, out);
  return out;
}

const relOf = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");

/** The in-scope files, repo-relative, in codepoint order, and how many each scope root found. */
export function scopeFiles(root: string): { files: string[]; perRoot: Record<string, number> } {
  const perRoot: Record<string, number> = {};
  const files = new Set<string>();
  for (const d of SCOPE_DIRS) {
    const found = filesUnder(root, d);
    perRoot[d] = found.length;
    for (const f of found) files.add(relOf(root, f));
  }
  for (const d of NAME_ROOTS) {
    const found = filesUnder(root, d).filter((f) => SCOPE_NAME.test(f));
    perRoot[d] = found.length;
    for (const f of found) files.add(relOf(root, f));
  }
  return { files: [...files].sort(byCodepoint), perRoot };
}

/** The scope's pins (swept ones dropped: they are not pins). */
export function scanSingleSport(root: string, sports: readonly string[] = SPORT_KEYS): Scan {
  const { files, perRoot } = scopeFiles(root);
  const pins: Pin[] = [];
  for (const f of files) pins.push(...pinsIn(readFileSync(resolve(root, f), "utf8"), f, sports).filter((p) => !p.swept));
  return { scanned: files.length, perRoot, pins };
}

// ---------------------------------------------------------------- the ratchet

const keyOf = (p: Pin): string => `${p.file}:${p.sport}`;

/** Unreasoned pin counts per `<file>:<sport>`, keys sorted. */
export function countsOf(pins: readonly Pin[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pins) if (!p.reasoned && !p.swept) out[keyOf(p)] = (out[keyOf(p)] ?? 0) + 1;
  return sortedRecord(out);
}

/** Today's counts against a ceiling: a new key, a count that rose, a count that fell. */
export function checkRatchet(counts: Readonly<Record<string, number>>, ceiling: Readonly<Record<string, number>>): { added: Delta[]; rose: Delta[]; lowered: Delta[] } {
  const added: Delta[] = [];
  const rose: Delta[] = [];
  const lowered: Delta[] = [];
  for (const [key, now] of Object.entries(counts)) {
    const was = ceiling[key];
    if (was === undefined) added.push({ key, was: 0, now });
    else if (now > was) rose.push({ key, was, now });
  }
  for (const [key, was] of Object.entries(ceiling)) {
    const now = counts[key] ?? 0;
    if (now < was) lowered.push({ key, was, now });
  }
  return { added, rose, lowered };
}

const splitKey = (key: string): [string, string] => {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
};

/** Where `key` sits in `base`: its own count there, or — through the recorded
 *  moves, NEW back to OLD — the count of the file it was renamed from. */
export function ceilingIn(base: Baseline, moves: Readonly<Record<string, string>>, key: string): number {
  const [file, sport] = splitKey(key);
  const seen = new Set<string>();
  for (let f: string | undefined = file; f !== undefined && !seen.has(f); f = moves[f]) {
    seen.add(f);
    const c = base.pins[`${f}:${sport}`];
    if (c !== undefined) return c;
  }
  return 0;
}

/** Each entry of `own` that sits above `base` — a PR raising its own ceiling. */
export function raisedAbove(own: Baseline, base: Baseline): Delta[] {
  return Object.entries(own.pins)
    .map(([key, now]) => ({ key, was: ceilingIn(base, own.moves, key), now }))
    .filter((d) => d.now > d.was);
}

/** Parse and validate a baseline's text. Anything off is a Refusal. */
export function parseBaseline(text: string, where: string): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Refusal(`${where} does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  const b = parsed as { schemaVersion?: unknown; pins?: unknown; moves?: unknown } | null;
  if (b === null || typeof b !== "object" || b.schemaVersion !== 2) throw new Refusal(`${where}: schemaVersion must be 2`);
  const pins = b.pins;
  if (typeof pins !== "object" || pins === null || Array.isArray(pins)) throw new Refusal(`${where}: pins must be an object of counts`);
  for (const [k, v] of Object.entries(pins)) {
    if (!/^[^:]+\.test\.tsx?:[a-z]+$/.test(k)) throw new Refusal(`${where}: "${k}" is not a <file>:<sport> key`);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Refusal(`${where}: ${k} must count at least 1 pin (got ${JSON.stringify(v)})`);
  }
  const moves = b.moves;
  if (typeof moves !== "object" || moves === null || Array.isArray(moves)) throw new Refusal(`${where}: moves must be an object (NEW file → OLD file)`);
  const sources = new Set<string>();
  for (const [to, from] of Object.entries(moves)) {
    if (typeof from !== "string" || from === to) throw new Refusal(`${where}: move ${to} ← ${JSON.stringify(from)} is invalid`);
    if (sources.has(from)) throw new Refusal(`${where}: ${from} is moved twice — one file's entries cannot be claimed by two`);
    sources.add(from);
    if (Object.keys(pins).some((k) => splitKey(k)[0] === from)) throw new Refusal(`${where}: ${from} was moved to ${to} but still has entries of its own — its ceiling would count twice`);
  }
  return { pins: pins as Record<string, number>, moves: moves as Record<string, string> };
}

/** The committed baseline in `root`. A missing or malformed file is a Refusal. */
export function loadBaseline(root: string): Baseline {
  let text: string;
  try {
    text = readFileSync(resolve(root, BASELINE_PATH), "utf8");
  } catch {
    throw new Refusal(`no baseline at ${BASELINE_PATH} — restore it (a missing baseline would accept any pin), or run --init for the first one`);
  }
  return parseBaseline(text, BASELINE_PATH);
}

function git(root: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/** REF's committed baseline, or null when REF has none yet. An unknown REF, or
 *  a root that is not a git checkout's top level, is a Refusal. */
export function baselineAt(root: string, ref: string): Baseline | null {
  if (ref === "" || ref.startsWith("-")) throw new Refusal(`--against: "${ref}" is not a ref`);
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) throw new Refusal(`--against needs ${root} to be a git checkout's top level`);
  if (git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0) {
    throw new Refusal(`--against ${ref}: no such commit here (in CI the gates job checks out with fetch-depth: 2 so the base, HEAD^1, is present)`);
  }
  if (git(root, ["cat-file", "-e", `${ref}:${BASELINE_PATH}`]).status !== 0) return null;
  const shown = git(root, ["show", `${ref}:${BASELINE_PATH}`]);
  if (shown.status !== 0) throw new Error(`git show ${ref}:${BASELINE_PATH} failed`);
  return parseBaseline(shown.stdout, `${ref}:${BASELINE_PATH}`);
}

const serialize = (b: Baseline): string =>
  `${JSON.stringify({ schemaVersion: 2, generatedBy: GENERATED_BY, pins: sortedRecord(b.pins), moves: sortedRecord(b.moves) }, null, 2)}\n`;

/** Keep a move while its NEW file still has entries, or while a kept move names it as OLD. */
function liveMoves(moves: Readonly<Record<string, string>>, pins: Readonly<Record<string, number>>): Record<string, string> {
  const files = new Set(Object.keys(pins).map((k) => splitKey(k)[0]));
  const keep = new Set(Object.keys(moves).filter((to) => files.has(to)));
  for (let grew = true; grew;) {
    grew = false;
    for (const to of keep) {
      const from = moves[to];
      if (from !== undefined && from in moves && !keep.has(from)) { keep.add(from); grew = true; }
    }
  }
  return Object.fromEntries(Object.entries(moves).filter(([to]) => keep.has(to)));
}

// ---------------------------------------------------------------- the CLI

const say = (s: string): void => { process.stdout.write(`${s}\n`); };
const warn = (s: string): void => { process.stderr.write(`${s}\n`); };
const fmt = (d: Delta): string => `${d.key} (${d.was} → ${d.now})`;

type Mode = "list" | "check" | "write" | "init" | "move";
interface Opts { mode: Mode; root: string; against?: string; move?: [string, string] }

export function main(argv: string[], deps: { scan?: (root: string) => Scan } = {}): number {
  let opts: Opts;
  try {
    opts = parseOpts(argv);
  } catch (e) {
    warn(`single-sport: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  try {
    return run(opts, deps.scan ?? ((r) => scanSingleSport(r)));
  } catch (e) {
    if (e instanceof Refusal) { warn(`::error::single-sport: ${e.message}`); return 2; }
    warn(`::error::single-sport: the scanner crashed (exit 3 — not a ratchet verdict): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 3;
  }
}

function parseOpts(argv: string[]): Opts {
  // pnpm 10 passes a `--` through (`pnpm matrix:single-sport -- --check`):
  // one leading separator is dropped, so both spellings work.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { check: { type: "boolean" }, write: { type: "boolean" }, init: { type: "boolean" }, move: { type: "boolean" }, against: { type: "string" }, root: { type: "string" } },
  });
  const modes = (["check", "write", "init", "move"] as const).filter((m) => values[m] === true);
  if (modes.length > 1) throw new Error(`${modes.map((m) => `--${m}`).join(" and ")} are exclusive`);
  const mode: Mode = modes[0] ?? "list";
  if (values.against !== undefined && mode !== "check") throw new Error("--against applies to --check only");
  if (mode === "move") {
    const [from, to] = positionals;
    if (positionals.length !== 2 || from === undefined || to === undefined) throw new Error("--move takes exactly two files: OLD NEW");
    return { mode, root: values.root ?? REPO_ROOT, move: [from, to] };
  }
  if (positionals.length > 0) throw new Error(`unexpected argument(s): ${positionals.join(" ")}`);
  return { mode, root: values.root ?? REPO_ROOT, ...(values.against === undefined ? {} : { against: values.against }) };
}

function run(o: Opts, scan: (root: string) => Scan): number {
  const s = scan(o.root);
  const roots = [...SCOPE_DIRS, ...NAME_ROOTS];
  const empty = roots.filter((d) => !((s.perRoot[d] ?? 0) > 0));
  if (s.scanned === 0 || empty.length > 0) {
    throw new Refusal(`scanned ZERO files under ${(empty.length > 0 ? empty : roots).join(", ")} in ${o.root} — the scope is wrong, not clean`);
  }
  const unreasoned = s.pins.filter((p) => !p.reasoned);
  const counts = countsOf(s.pins);
  for (const p of unreasoned) say(`unreasoned single-sport test: ${p.file}:${p.line} pins "${p.sport}" (${p.via})`);
  say(`single-sport: ${s.scanned} files scanned (${roots.map((d) => `${d} ${s.perRoot[d] ?? 0}`).join(", ")}); ${s.pins.length} pins, ${unreasoned.length} unreasoned in ${Object.keys(counts).length} file:sport entries`);
  const path = resolve(o.root, BASELINE_PATH);

  if (o.mode === "list") return 0;
  if (o.mode === "init") {
    if (existsSync(path)) throw new Refusal(`a baseline already exists at ${BASELINE_PATH} — --init writes only the first one; use --write, which can only lower counts`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialize({ pins: counts, moves: {} }));
    say(`single-sport: first baseline written to ${BASELINE_PATH} — ${Object.keys(counts).length} entries`);
    return 0;
  }
  const own = loadBaseline(o.root);
  if (o.mode === "move") return move(o, s, own, path);
  const { added, rose, lowered } = checkRatchet(counts, own.pins);
  if (o.mode === "write") {
    if (added.length + rose.length > 0) {
      throw new Refusal(`refusing to raise the baseline — the ratchet only turns down. Sweep with forEachSport, or add \`// single-sport: <reason>\`:\n  ${[...added, ...rose].map(fmt).join("\n  ")}`);
    }
    writeFileSync(path, serialize({ pins: counts, moves: liveMoves(own.moves, counts) }));
    say(`single-sport: baseline written — ${Object.keys(counts).length} entries, ${lowered.length} lowered`);
    return 0;
  }
  for (const d of added) warn(`::error::new unreasoned single-sport pin ${fmt(d)} — sweep with forEachSport, or add \`// single-sport: <reason>\``);
  for (const d of rose) warn(`::error::unreasoned single-sport pins rose ${fmt(d)} — sweep with forEachSport, or add \`// single-sport: <reason>\``);
  for (const d of lowered) say(`::notice::single-sport: ${fmt(d)} can be lowered — run: pnpm matrix:single-sport --write`);
  let raised: Delta[] = [];
  if (o.against !== undefined) {
    const base = baselineAt(o.root, o.against);
    if (base === null) say(`::notice::single-sport: ${o.against} has no ${BASELINE_PATH} yet — the baseline is being introduced, so its own counts are the ceiling`);
    else raised = raisedAbove(own, base);
    for (const d of raised) warn(`::error::the baseline raises ${d.key} above ${o.against}'s (${d.was} → ${d.now}) — a ceiling cannot rise; sweep or reason the pins instead`);
  }
  const bad = added.length + rose.length + raised.length;
  if (bad > 0) { say(`single-sport: check FAILED — ${added.length} new, ${rose.length} risen, ${raised.length} raised above ${o.against ?? "the base"}`); return 1; }
  say(`single-sport: check passed against ${BASELINE_PATH}${o.against === undefined ? "" : ` and ${o.against}`}`);
  return 0;
}

function move(o: Opts, s: Scan, own: Baseline, path: string): number {
  const [from, to] = o.move ?? ["", ""];
  const mine = (f: string): string[] => Object.keys(own.pins).filter((k) => splitKey(k)[0] === f);
  if (mine(from).length === 0) throw new Refusal(`--move: ${from} has no baseline entries to move`);
  if (mine(to).length > 0) throw new Refusal(`--move: ${to} already has baseline entries — a move cannot merge two files' ceilings`);
  if (existsSync(resolve(o.root, from))) throw new Refusal(`--move: ${from} still exists — a move is for a renamed file`);
  if (!s.pins.some((p) => p.file === to) && !scopeFiles(o.root).files.includes(to)) throw new Refusal(`--move: ${to} is not an in-scope test file here`);
  const pins: Record<string, number> = {};
  for (const [k, v] of Object.entries(own.pins)) {
    const [f, sport] = splitKey(k);
    pins[f === from ? `${to}:${sport}` : k] = v;
  }
  writeFileSync(path, serialize({ pins, moves: { ...own.moves, [to]: from } }));
  say(`single-sport: moved ${mine(from).length} entries from ${from} to ${to} (recorded, so --against maps ${to} back to ${from})`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
