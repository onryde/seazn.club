// The reference package's import boundary (design §7.2, ruling 27):
// relative imports that stay inside packages/reference/src, and statement-form
// `import type` / `export type` from @seazn/engine/core. Everything else —
// engine values, inline `{ type X }` (strip-types keeps it as a runtime
// import), other engine subpaths, anything leaving src (the bench pack types
// import engine runtime values, trap 3), a relative path into packages/engine,
// a relay through a test file (tests are not scanned), dynamic import() of any
// argument, require / createRequire / getBuiltinModule (called or merely
// named), import-equals, triple-slash references, eval / Function (named, or
// reached through `.constructor`), a relative specifier that does not end in
// `.ts`, and nondeterministic tokens — is a violation. A token is a read of
// the GLOBAL (`performance.now`, `globalThis.Date.now`), never a member that
// merely shares its name (`r.performance.rating`, a FIDE performance rating —
// final batch FB-2); so the global object itself, and a token's own global
// (`performance`, `globalThis.Date`, … — W1b carry a), may be named only as
// the owner of a member read, and a token's global may not be read by a
// computed key (`Date[k]`). Zero files scanned is a refusal.
//
// The judge walks each file's TypeScript syntax tree, so comments, strings,
// line breaks and ASI cannot hide a statement from it (review I-1 measured ten
// shapes that hid from the old line judge). Its assumptions are guards, not
// comments: a file that does not parse is refused (the parser recovers
// silently, and a recovered tree is not the file node will run); a symlink in
// src is refused (and never followed); containment is by realpath and by path
// SEGMENT; a source the scan cannot read (.mts, .tsx, .js, …) is refused.
// Residual limit, by construction: a loader name BUILT at runtime (string
// concatenation, a computed key) is invisible to any static judge.
//
// Run: npm run reference:boundary [-- srcDir] (default: this checkout's
// packages/reference/src). Exit 0 clean; 1 on any violation, or on zero files
// scanned (a vacuous verdict: kept as 1 by ruling, final batch F-6 — a scan
// that finds nothing is a failed gate, not a usage error); 2 on usage; 3 on a
// crash — inside the scan (a source it cannot read), or, through the package
// script's crash-exit.ts preload, while the gate loads.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";
import { isMainModule } from "./matrix/lib/main-module.ts";

// `typescript` through require, not import: vite's transform chokes on the
// ~9 MB CJS bundle and a test importing this module then fails to collect (as
// scripts/matrix/single-sport.ts). The type side is erased.
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

export interface Violation { file: string; line: number; specifier: string; reason: string }
export const ALLOWED_ENGINE = "@seazn/engine/core";

const R = {
  value: "engine imports must be `import type { … }` statements (a value import couples the oracle to the code it checks)",
  inline: "inline `{ type X }` is refused — strip-types keeps it as a runtime import of the engine",
  otherEngine: "only @seazn/engine/core types may be imported",
  trap3: "relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)",
  intoEngine: "relative import resolves into packages/engine — the oracle must not load the code it checks",
  notAllowed: "not an allowed import (relative within src, or @seazn/engine/core types)",
  relay: "relative import of a test file is refused — tests are not scanned, so a test could relay the engine",
  sideEffect: "side-effect import is refused",
  dynamic: "dynamic import() is refused",
  importEquals: "`import … = require()` is refused",
  tripleSlash: "triple-slash reference is refused (use `import type`)",
  loaderRef: "a module loader named outside a call is refused — an alias would hide the call",
  globalRef: "the global object named outside a member read is refused — an alias would hide a clock or entropy read",
  constructorRef: "a `.constructor` read is refused — it reaches Function without naming it",
  notTs: "a relative import must name its .ts file (the house strip-types rule) — an extensionless or suffixed specifier hides which file loads",
  eval: "code built from a string (eval / Function) is refused — the gate cannot judge it",
  token: "nondeterministic token (the reference must answer the same way every time)",
  tokenAlias: "a nondeterministic global (Date, Math, process, performance, crypto, Temporal) named outside a member read is refused — an alias or Reflect.get would hide a clock or entropy read",
  tokenComputed: "a nondeterministic global (Date, Math, process, performance, crypto, Temporal) read by a computed key is refused — the gate cannot see which member it reads",
  symlink: "symlink in src is refused — the gate judges real files only",
  unscanned: "not a .ts source — the gate scans .ts only, so this file's imports would go unjudged",
} as const;

/** Sources node or a bundler would load that the judge never reads. */
const UNSCANNED = /\.(?:mts|cts|tsx|js|mjs|cjs|jsx)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** Names that load a module at runtime — refused when called, and when named at all. */
const LOADERS: ReadonlySet<string> = new Set(["require", "createRequire", "getBuiltinModule"]);
/** Names that run a string as code — refused wherever they are named (a call names them too). */
const EVALS: ReadonlySet<string> = new Set(["eval", "Function"]);
/** `owner.member` reads of a GLOBAL that answer differently per call; `*` = every member. */
const TOKENS: ReadonlyMap<string, string> = new Map([["Date", "now"], ["Math", "random"], ["process", "hrtime"], ["performance", "*"], ["crypto", "*"], ["Temporal", "Now"]]);
/** The global object's names in node: `globalThis.performance` is `performance`. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "global"]);

/** The engine's real directory; a missing one is refused, never read as "nothing is the engine". */
export function engineDir(p: string = fileURLToPath(new URL("../packages/engine", import.meta.url))): string {
  if (!existsSync(p)) throw new Error(`reference:boundary: ${p} does not exist — the gate cannot tell a path into the engine from one out of it`);
  return realpathSync(p);
}
const ENGINE = engineDir();

const within = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/** realpath of the nearest existing ancestor, with the missing tail re-appended. */
function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    tail.unshift(basename(head));
    head = up;
  }
  return join(realpathSync(head), ...tail);
}

interface Found { ts: string[]; unscanned: string[]; symlinks: string[] }
function walk(dir: string, out: Found): Found {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.symlinks.push(p);
    else if (st.isDirectory()) walk(p, out);
    else if (n.endsWith(".ts")) { if (!n.endsWith(".test.ts")) out.ts.push(p); }
    else if (UNSCANNED.test(n)) out.unscanned.push(p);
  }
  return out;
}

/** The rightmost name an expression reads: `a.b.c` → c, `a["c"]` → c, `c` → c. */
function nameNode(e: TS.Expression): TS.Identifier | TS.StringLiteralLike | undefined {
  if (ts.isParenthesizedExpression(e)) return nameNode(e.expression);
  if (ts.isIdentifier(e)) return e;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression;
  return undefined;
}
const nameOf = (e: TS.Expression) => nameNode(e)?.text;
const unparen = (e: TS.Expression): TS.Expression => (ts.isParenthesizedExpression(e) ? unparen(e.expression) : e);
/** The global an expression names: a bare identifier, or a member of the
 *  global object (`globalThis.performance`, `global["crypto"]`) — never a
 *  member of anything else (`r.performance` names no global, FB-2). */
function globalNamed(e: TS.Expression): string | undefined {
  const x = unparen(e);
  if (ts.isIdentifier(x)) return x.text;
  if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && isGlobalObject(x.expression)) return nameOf(x);
  return undefined;
}
/** `globalThis`, `global`, `(globalThis)`. */
function isGlobalObject(e: TS.Expression): boolean {
  const o = unparen(e);
  return ts.isIdentifier(o) && GLOBAL_OBJECTS.has(o.text);
}
/** Where a name is a member or a key, not a reference: `x.global`, `{ global: 1 }`, `interface R { global: … }`, `{ global: g } = x`. */
function namesNoBinding(node: TS.Identifier): boolean {
  const p = node.parent;
  return ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === node)
    || (ts.isBindingElement(p) && p.propertyName === node);
}
/** `node` is the owner of a member read (`globalThis.x`, `(globalThis)["x"]`). */
function ownsMemberRead(node: TS.Node): boolean {
  let n = node;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  return (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n;
}
/** `node` sits in a type (`typeof Math.PI`, `d: Date`) — erased, never run. */
function isTypePosition(node: TS.Node): boolean {
  for (let n = node.parent; n !== undefined && !ts.isStatement(n); n = n.parent) if (ts.isTypeQueryNode(n) || ts.isTypeReferenceNode(n)) return true;
  return false;
}
const literal = (e: TS.Expression | undefined) => (e === undefined ? "<none>" : ts.isStringLiteralLike(e) ? e.text : "<computed>");

type Kind = "type" | "inline" | "value" | "side-effect";

/**
 * The parser's own syntax errors. `parseDiagnostics` is internal to
 * typescript; if it ever stops being an array the gate refuses to run rather
 * than read "no errors" off a missing field.
 */
export function parseDiagnosticsOf(sf: unknown): readonly TS.DiagnosticWithLocation[] {
  const d = (sf as { parseDiagnostics?: unknown } | null)?.parseDiagnostics;
  if (!Array.isArray(d)) throw new Error("reference:boundary: SourceFile.parseDiagnostics is not an array — typescript internals moved, so a clean parse cannot be told from a recovered one");
  return d as TS.DiagnosticWithLocation[];
}

function judgeFile(file: string, root: string, rel: string): Violation[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const first = parseDiagnosticsOf(sf)[0];
  if (first !== undefined) {
    return [{ file: rel, line: lineAt(first.start), specifier: rel, reason: `does not parse (${ts.flattenDiagnosticMessageText(first.messageText, " ")}) — refused, never judged on a recovered tree` }];
  }

  const found: { pos: number; v: Violation }[] = [];
  const add = (pos: number, specifier: string, reason: string) => found.push({ pos, v: { file: rel, line: lineAt(pos), specifier, reason } });
  const handled = new Set<TS.Node>();

  for (const r of [...sf.typeReferenceDirectives, ...sf.referencedFiles, ...sf.libReferenceDirectives]) add(r.pos, r.fileName, R.tripleSlash);

  const judge = (at: TS.Node, spec: string, kind: Kind) => {
    const pos = at.getStart(sf);
    if (kind === "side-effect") { add(pos, spec, R.sideEffect); return; }
    if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
      const target = realish(resolve(dirname(file), spec));
      if (within(target, ENGINE)) add(pos, spec, R.intoEngine);
      else if (!target.startsWith(root + sep)) add(pos, spec, R.trap3);
      // FB-9 (RR-1): `./relay.test` and `./relay.test.ts?raw` load a test file
      // the relay check below cannot see; the house rule names the .ts file.
      else if (!spec.endsWith(".ts")) add(pos, spec, R.notTs);
      else if (TEST_FILE.test(target)) add(pos, spec, R.relay);
      return;
    }
    if (spec === "@seazn/engine" || spec.startsWith("@seazn/engine/")) {
      if (spec !== ALLOWED_ENGINE) add(pos, spec, R.otherEngine);
      else if (kind === "inline") add(pos, spec, R.inline);
      else if (kind === "value") add(pos, spec, R.value);
      return;
    }
    add(pos, spec, R.notAllowed);
  };

  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const c = node.importClause;
      const n = c?.namedBindings;
      const kind: Kind = c === undefined ? "side-effect"
        : c.phaseModifier === ts.SyntaxKind.TypeKeyword ? "type"
        : c.name === undefined && n !== undefined && ts.isNamedImports(n) && n.elements.length > 0 && n.elements.every((e) => e.isTypeOnly) ? "inline"
        : "value";
      judge(node, literal(node.moduleSpecifier), kind);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const x = node.exportClause;
      const kind: Kind = node.isTypeOnly ? "type"
        : x !== undefined && ts.isNamedExports(x) && x.elements.length > 0 && x.elements.every((e) => e.isTypeOnly) ? "inline"
        : "value";
      judge(node, literal(node.moduleSpecifier), kind);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.getStart(sf), literal(node.moduleReference.expression), R.importEquals);
      return;
    }
    if (ts.isImportTypeNode(node)) {
      const a = node.argument;
      judge(node, ts.isLiteralTypeNode(a) && ts.isStringLiteralLike(a.literal) ? a.literal.text : "<computed>", "type");
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.getStart(sf), literal(node.arguments[0]), R.dynamic);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const nn = nameNode(node.expression);
      const name = nn?.text;
      const args = node.arguments ?? [];
      if (nn !== undefined && name !== undefined && LOADERS.has(name)) { handled.add(nn); add(nn.getStart(sf), literal(node.arguments?.[0]), `${name}() is refused`); }
      // The GLOBAL Date (FB-2); a spread-only argument list may be empty at runtime (FB-9, RR-3).
      // Called or constructed, Date is judged HERE — `new Date(0)` included — never
      // again below as an alias of itself (W1b carry a).
      else if (globalNamed(node.expression) === "Date") {
        // The callee as written: `Date`, or the `globalThis.Date` access itself.
        handled.add(unparen(node.expression));
        if (ts.isCallExpression(node) || args.every((a) => ts.isSpreadElement(a))) add(node.getStart(sf), ts.isCallExpression(node) ? "Date()" : "new Date", R.token);
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // The owner must BE the global (FB-2): `r.performance.rating` reads a field.
      const owner = globalNamed(node.expression);
      const member = nameOf(node);
      const want = owner === undefined ? undefined : TOKENS.get(owner);
      if (want !== undefined && member !== undefined && (want === "*" || want === member)) add(node.getStart(sf), `${owner ?? ""}.${member}`, R.token);
      // `Date[k]()`: a key the gate cannot read may be the token itself (an
      // access with no readable name is an element access by a computed key).
      else if (owner !== undefined && TOKENS.has(owner) && member === undefined) add(node.getStart(sf), `${owner}[<computed>]`, R.tokenComputed);
      // `globalThis.performance` IS `performance` (globalNamed): outside a member
      // read it is an alias, exactly as the bare name is below (W1b carry a). No
      // type-position guard: a type usually spells this as a QualifiedName, never
      // an access — but a computed key in a type literal (`{ [globalThis.x]: T }`)
      // parses as an access, and the gate refuses it: it fails closed there.
      else if (member !== undefined && TOKENS.has(member) && isGlobalObject(node.expression) && !ownsMemberRead(node) && !handled.has(node)) add(node.getStart(sf), member, R.tokenAlias);
      // FB-9 (RR-2): `(() => {}).constructor` is Function, never named.
      else if (member === "constructor") add(node.getStart(sf), member, R.constructorRef);
    } else if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && !handled.has(node)) {
      if (LOADERS.has(node.text)) add(node.getStart(sf), node.text, R.loaderRef);
      else if (EVALS.has(node.text)) add(node.getStart(sf), node.text, R.eval);
      // Only as a member read's owner: `const g = globalThis` would hide `g.performance.now()`.
      else if (ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text) && !ownsMemberRead(node) && !namesNoBinding(node)) add(node.getStart(sf), node.text, R.globalRef);
      // W1b carry (a): the owner of a TOKENS read may only appear AS that owner —
      // `performance.now()`. Bound to a name, destructured, or passed on
      // (`Reflect.get(Date, "now")`, `[Math][0]`), the gate can no longer see the read.
      else if (ts.isIdentifier(node) && TOKENS.has(node.text) && !ownsMemberRead(node) && !namesNoBinding(node) && !isTypePosition(node)) add(node.getStart(sf), node.text, R.tokenAlias);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Source order; a stable sort keeps two findings at one position in visit order.
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.v);
}

export function checkReferenceBoundary(srcDir: string): { scanned: number; violations: Violation[] } {
  let root: string;
  try { root = realpathSync(resolve(srcDir)); } catch { return { scanned: 0, violations: [] }; }
  const found = walk(root, { ts: [], unscanned: [], symlinks: [] });
  const files = found.ts.sort();
  const violations: Violation[] = [];
  for (const file of files) violations.push(...judgeFile(file, root, relative(root, file)));
  for (const file of found.symlinks.sort()) { const rel = relative(root, file); violations.push({ file: rel, line: 1, specifier: rel, reason: R.symlink }); }
  for (const file of found.unscanned.sort()) { const rel = relative(root, file); violations.push({ file: rel, line: 1, specifier: rel, reason: R.unscanned }); }
  return { scanned: files.length, violations };
}

const USAGE = "usage: node --experimental-strip-types scripts/reference-boundary.ts [srcDir]  (default: packages/reference/src) — exit 0 clean; 1 on a violation, or on zero files scanned (a vacuous verdict); 2 on usage; 3 on a crash";

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    const dir = args[0] ?? fileURLToPath(new URL("../packages/reference/src", import.meta.url));
    let scan: { scanned: number; violations: Violation[] } | null = null;
    // Final batch F-6: a crash is 3, never 1 — which reads as a violation.
    try { scan = checkReferenceBoundary(dir); } catch (e) {
      process.stderr.write(`reference:boundary crashed — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
      process.exitCode = 3;
    }
    if (scan !== null) {
      const { scanned, violations } = scan;
      for (const v of violations) process.stderr.write(`FAIL ${v.file}:${v.line} ${v.specifier} — ${v.reason}\n`);
      if (scanned === 0) process.stderr.write("reference:boundary scanned ZERO files — refusing\n");
      process.stdout.write(`reference:boundary: ${scanned} files, ${violations.length} violation(s)\n`);
      process.exitCode = scanned === 0 || violations.length > 0 ? 1 : 0;
    }
  }
}
