// The match-credit ledger's WRITERS, declared once (Settings -> Credits -> Streaming review I2).
//
// `org_stream_credits` is written from nine places, all in stream-credits.ts. The organiser-facing history
// (stream-credit-history.ts) names every row by what wrote it — and one of its names, "Refund: camera never connected",
// is read off a row's SHAPE (a refund, no author, a session) rather than off anything the writer stamps. That is only
// honest while the shapes stay in one-to-one correspondence with the writers, so the writers are pinned here:
//
//   * `LEDGER_WRITER_SITES` is the ORACLE — typed from the writers' contract (the key formats and the reasons in the V410 /
//     V426 migrations and the stream-credits.ts header), never read back from the code under test. Two tests hold it:
//       - stream-credit-ledger-writers.test.ts scans stream-credits.ts with the TypeScript parser and requires the insert
//         sites it finds to be exactly these nine (so a tenth, or a renamed one, fails by name);
//       - stream-credit-history.test.ts drives EVERY site through its real writer, reads each row back and requires it to
//         wear the shape this table declares for the site that wrote it.
//   * The scanners below take SOURCE TEXT, not a path, so the test can run them on synthetic files and prove they see an
//     aliased import, a quoted table name, a schema-qualified one and a namespace access — the evasions a line grep misses.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import type { StreamHistoryKind } from "../stream-credit-history";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle (pass-scoping-guard.test.ts).
const ts: typeof TS = createRequire(import.meta.url)("typescript");

/** apps/web/src, from apps/web/src/server/usecases/__tests__. */
export const SRC = new URL("../../../", import.meta.url).pathname;

export interface LedgerWriterSite {
  /** The matrix row's name. */
  key: string;
  /** The function that holds the insert (nearest named ancestor of the statement). */
  fn: string;
  /** Text that must appear in the insert's template literal (its SQL and its `${}` expressions), telling the sites of one
   *  function apart. */
  needle: string;
  /** The ledger `reason`s the site writes. */
  reasons: readonly string[];
  /** The buckets the site writes. */
  buckets: readonly ("monthly" | "pack")[];
  /** `created_by` is set (a Seazn staff member wrote the row). */
  byStaff: boolean;
  /** The row's `session_id`: always set, never set, or either. */
  session: "always" | "never" | "either";
  /** The shape of the row's idempotency key, or null for a site that writes none. */
  key_shape: RegExp | null;
  /** The history kinds the site's rows are shown as. */
  kinds: readonly StreamHistoryKind[];
}

const ORG = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const LEDGER_WRITER_SITES: readonly LedgerWriterSite[] = [
  { key: "consume", fn: "consumeForSession", needle: "'consume'", reasons: ["consume"], buckets: ["monthly", "pack"], byStaff: false, session: "always", key_shape: null, kinds: ["streamUsed"] },
  { key: "purchase", fn: "recordPurchase", needle: "'purchase'", reasons: ["purchase"], buckets: ["pack"], byStaff: false, session: "never", key_shape: null, kinds: ["packPurchase"] },
  { key: "pack-clawback", fn: "recordStreamPackRefund", needle: "'revoke'", reasons: ["revoke"], buckets: ["pack"], byStaff: false, session: "never", key_shape: /^stream_pack_refund:.+$/, kinds: ["packRefund"] },
  { key: "staff", fn: "staffRow", needle: "created_by", reasons: ["grant", "revoke", "refund"], buckets: ["monthly", "pack"], byStaff: true, session: "either", key_shape: /^.+$/, kinds: ["staffAdjust", "refundStaff"] },
  { key: "never-live-refund", fn: "refundConsumeForSession", needle: "'refund'", reasons: ["refund"], buckets: ["monthly", "pack"], byStaff: false, session: "always", key_shape: null, kinds: ["refundNoCamera"] },
  { key: "monthly-topup", fn: "rollMonthlyLocked", needle: "streamMonthlyDeltaKey", reasons: ["grant"], buckets: ["monthly"], byStaff: false, session: "never", key_shape: new RegExp(`^stream-monthly:${ORG}:\\d{4}-\\d{2}:to-\\d+$`), kinds: ["monthlyGrant"] },
  { key: "monthly-expire", fn: "rollMonthlyLocked", needle: "'expire'", reasons: ["expire"], buckets: ["monthly"], byStaff: false, session: "never", key_shape: null, kinds: ["expired"] },
  { key: "monthly-grant", fn: "rollMonthlyLocked", needle: "streamMonthlyGrantKey", reasons: ["grant"], buckets: ["monthly"], byStaff: false, session: "never", key_shape: new RegExp(`^stream-monthly:${ORG}:\\d{4}-\\d{2}$`), kinds: ["monthlyGrant"] },
  { key: "event-pass", fn: "grantPassStreamCredits", needle: "'grant', 'pack'", reasons: ["grant"], buckets: ["pack"], byStaff: false, session: "never", key_shape: /^stream-pass:.+$/, kinds: ["passGrant"] },
];

// ---------------------------------------------------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------------------------------------------------

export function parseSource(file: string, text: string): TS.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Every production source file under src/: not a test, not a fixture directory. Relative paths, sorted. */
export function productionSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules" && e.name !== ".next") walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
        out.push(relative(SRC, p));
      }
    }
  };
  walk(SRC);
  return out.sort();
}

export const readSource = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

/** The name of the nearest function-like ancestor ("<module>" at top level): a function declaration, a method, or a
 *  function/arrow assigned to a variable or property. Anonymous callbacks (`sql.begin(async (tx) => …)`) are skipped. */
export function enclosingFunctionName(node: TS.Node): string {
  for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.getText();
    if (ts.isPropertyAssignment(n) && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.getText();
  }
  return "<module>";
}

/** A write to the ledger table in SQL text: insert, update, delete, truncate, merge or copy — case-insensitive, any
 *  whitespace (newlines included), an optional `only`, an optional schema qualifier, an optional double-quoted name. */
const LEDGER_WRITE = /\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into|copy)\s+(?:only\s+)?(?:"?\w+"?\s*\.\s*)?"?org_stream_credits"?/i;

export interface LedgerWrite {
  fn: string;
  verb: string;
  /** The literal as written, `${}` expressions included — what a needle is looked for in. */
  raw: string;
  line: number;
}

/** Every string or template literal in `sf` that writes `org_stream_credits`. Comments are not nodes, so a mention in
 *  prose is not a write; a literal handed to `sql.unsafe(...)` or built with `${}` is a literal like any other. */
export function ledgerWrites(sf: TS.SourceFile): LedgerWrite[] {
  const out: LedgerWrite[] = [];
  const visit = (node: TS.Node): void => {
    let cooked: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) cooked = node.text;
    else if (ts.isTemplateExpression(node)) cooked = node.head.text + node.templateSpans.map((s) => ` ${"${}"} ${s.literal.text}`).join("");
    if (cooked !== null) {
      const m = LEDGER_WRITE.exec(cooked);
      if (m) {
        out.push({
          fn: enclosingFunctionName(node),
          verb: m[1]!.toLowerCase().replace(/\s+/g, " "),
          raw: node.getText(sf),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface RefundEmission {
  /** The label of the nearest enclosing `case`, or null. */
  caseLabel: string | null;
  line: number;
}

/** Every object literal that IS the domain effect `{ type: "refund_credit" }` — a `type` property with that value and no
 *  `sessionId` (the event row the use-case records carries one; the effect never does). Spread and extra keys still count. */
/** An expression with the type-level and grouping wrappers peeled off: `x as const`, `x satisfies T`, `<T>x`, `x!`, `(x)` are
 *  all the value `x` at run time, and a scan that stops at the wrapper misses a literal written that way. */
export function unwrapExpression(e: TS.Expression): TS.Expression {
  let cur = e;
  for (;;) {
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/** A property's name as a string when it is statically known: `type`, `"type"`, `["type"]`, `[`type`]`. */
function propertyKey(name: TS.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpression(name.expression);
    return ts.isStringLiteralLike(inner) ? inner.text : null;
  }
  return null;
}

export function refundEmissions(sf: TS.SourceFile): RefundEmission[] {
  const out: RefundEmission[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name: string) => node.properties.find((p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && propertyKey(p.name) === name);
      const type = prop("type");
      const value = type === undefined ? undefined : unwrapExpression(type.initializer);
      const isRefund = value !== undefined && ts.isStringLiteralLike(value) && value.text === "refund_credit";
      const shorthandSession = node.properties.some((p) => ts.isShorthandPropertyAssignment(p) && p.name.text === "sessionId");
      if (isRefund && prop("sessionId") === undefined && !shorthandSession) {
        let label: string | null = null;
        for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
          if (ts.isCaseClause(n)) { label = n.expression.getText(sf); break; }
        }
        out.push({ caseLabel: label, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface NameUse {
  kind: "import" | "call" | "definition" | "other";
  /** The local binding, for an import. */
  local?: string;
  /** For a call: the text of the `if` condition it sits under, or null. */
  underIf: string | null;
  line: number;
}

/** Every way `name` is used in `sf`, classified. `other` is the evasions: a re-export, a namespace or property access
 *  (`ns.name`, `ns["name"]`), a destructured dynamic import, the function passed as a value, an alias that is called under
 *  any local name but is also used as a value. An ALIASED import (`name as other`) is an `import` whose `local` is `other`,
 *  and its calls are followed under that local name. */
export function nameUses(sf: TS.SourceFile, name: string): NameUse[] {
  const out: NameUse[] = [];
  const line = (n: TS.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  // Pass 1: imports, to learn the local names this file binds the function to.
  const locals = new Set<string>([name]);
  const visitImports = (node: TS.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === name) locals.add(node.name.text);
    ts.forEachChild(node, visitImports);
  };
  visitImports(sf);
  const ifCondition = (node: TS.Node): string | null => {
    for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isIfStatement(n)) return n.expression.getText(sf);
    }
    return null;
  };
  const visit = (node: TS.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === name) {
      out.push({ kind: "import", local: node.name.text, underIf: null, line: line(node) });
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      out.push({ kind: "definition", underIf: null, line: line(node) });
      if (node.body) ts.forEachChild(node.body, visit);
      return;
    }
    if (ts.isIdentifier(node) && locals.has(node.text)) {
      const p = node.parent;
      if (ts.isCallExpression(p) && p.expression === node) out.push({ kind: "call", local: node.text, underIf: ifCondition(node), line: line(node) });
      else out.push({ kind: "other", local: node.text, underIf: null, line: line(node) });
    } else if (ts.isStringLiteralLike(node) && node.text === name && !ts.isImportDeclaration(node.parent)) {
      out.push({ kind: "other", underIf: null, line: line(node) });   // ns["name"], a dynamic key
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
