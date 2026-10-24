// W2d Task 1 (X-PT-2, SPEC §13.4) — every win method a sport module's SOURCE can write is in that module's
// `outcomeMethods`, so a method added to a fold without a declaration fails here, before a table meets it and
// `decidedInOf` refuses it CONFIG_INVALID.
//
// A syntax scan, not a text grep: the methods reach a win three ways, and a `method: "<literal>"` regex sees only the
// first — (1) a `method` property on an object literal with `kind: "win"` (its string leaves, through `?:`, `??` and
// `||`; a local const resolved to its initializer); (2) the argument a call hands a same-file function at its parameter
// named `method` (the period kernel's and cricket's `decideWin(state, side, "extra_time")`); (3) a template literal,
// whose fixed head must open at least one declared method (chess's `tiebreak_${rung}`).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FOLD_EPOCH } from "./fold-epoch.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";

const SPORTS_DIR = fileURLToPath(new URL("../sports/", import.meta.url));

/** The source directories each registered module folds from: its own, plus the kernel it is a preset of. Held to the
 *  registry below — a sport with no row, or a row for no sport, fails. */
const SOURCE_DIRS: Readonly<Record<string, readonly string[]>> = {
  football: ["football"],
  cricket: ["cricket"],
  boardgame: ["boardgame"],
  carrom: ["carrom"],
  generic: ["generic"],
  volleyball: ["setbased"],
  badminton: ["setbased"],
  tabletennis: ["setbased"],
  tennis: ["nested", "tennis"],
  icehockey: ["period", "icehockey"],
  hockey: ["period", "hockey"],
};

interface Scan {
  literals: Set<string>;
  templateHeads: Set<string>;
  /** Leaves the scan cannot enumerate (a payload's own field, a parameter): reported, never counted as checked. */
  unresolved: number;
}

const isWinLiteral = (o: ts.ObjectLiteralExpression): boolean =>
  o.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === "kind" &&
      ts.isStringLiteralLike(p.initializer) &&
      p.initializer.text === "win",
  );

/** Each file is parsed once per run: kernels are shared by several modules (the period kernel by both hockeys, the set-based
 *  kernel by three sports), and a parse of a 4,000-line module is the cost of this test. */
const fileScans = new Map<string, Scan>();
const scanFile = (path: string, out: Scan): void => {
  let own = fileScans.get(path);
  if (own === undefined) {
    own = { literals: new Set(), templateHeads: new Set(), unresolved: 0 };
    scanSource(path, readFileSync(path, "utf8"), own);
    fileScans.set(path, own);
  }
  for (const l of own.literals) out.literals.add(l);
  for (const h of own.templateHeads) out.templateHeads.add(h);
  out.unresolved += own.unresolved;
};

/** The TypeScript compiler parses every module source of every sport: a stated budget, not vitest's 5 s (a loaded runner is
 *  several times slower than the ~1 s it takes locally). */
const SCAN_BUDGET_MS = 30_000;

function scanSource(name: string, text: string, out: Scan): void {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const consts = new Map<string, ts.Expression>();
  const methodParam = new Map<string, number>(); // function name → index of its parameter named `method`
  const index = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) consts.set(n.name.text, n.initializer);
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) {
      const at = n.parameters.findIndex((p) => p.name.getText(sf) === "method");
      if (at >= 0) methodParam.set(n.name.text, at);
    }
    ts.forEachChild(n, index);
  };
  index(sf);

  const leaves = (e: ts.Expression, seen: Set<string>): void => {
    if (ts.isStringLiteralLike(e)) out.literals.add(e.text);
    else if (ts.isTemplateExpression(e)) out.templateHeads.add(e.head.text);
    else if (ts.isParenthesizedExpression(e)) leaves(e.expression, seen);
    else if (ts.isConditionalExpression(e)) {
      leaves(e.whenTrue, seen);
      leaves(e.whenFalse, seen);
    } else if (
      ts.isBinaryExpression(e) &&
      (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      leaves(e.left, seen);
      leaves(e.right, seen);
    } else if (ts.isIdentifier(e) && consts.has(e.text) && !seen.has(e.text)) leaves(consts.get(e.text)!, new Set([...seen, e.text]));
    else out.unresolved++;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n) && isWinLiteral(n)) {
      for (const p of n.properties) {
        // A shorthand `method` is the enclosing function's parameter: its values are read at the call sites, below.
        if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "method") leaves(p.initializer, new Set());
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && methodParam.has(n.expression.text)) {
      const arg = n.arguments[methodParam.get(n.expression.text)!];
      if (arg !== undefined) leaves(arg, new Set());
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function sourcesOf(dirs: readonly string[]): string[] {
  return dirs.flatMap((d) =>
    readdirSync(join(SPORTS_DIR, d))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(SPORTS_DIR, d, f)),
  );
}

describe("X-PT-2: the win methods a module's source writes are its declared outcomeMethods", () => {
  it("X-PT-2 every win method literal in a module's fold source is declared in its outcomeMethods; each module writes at least one (forEachSport, counted per module)", () => {
    const perModule: Record<string, { literals: number; templates: number; files: number }> = {};
    const n = forEachSport(({ key, module }) => {
      const dirs = SOURCE_DIRS[key];
      expect(dirs, `${key} has no source row`).toBeDefined();
      const files = sourcesOf(dirs!);
      expect(files.length, `${key} source files`).toBeGreaterThan(0);
      const scan: Scan = { literals: new Set(), templateHeads: new Set(), unresolved: 0 };
      for (const f of files) scanFile(f, scan);
      for (const m of scan.literals) expect(module.outcomeMethods, `${key} writes win method "${m}"`).toContain(m);
      for (const head of scan.templateHeads) {
        expect(head.length, `${key} template win method with no fixed head`).toBeGreaterThan(0);
        expect(module.outcomeMethods.some((m) => m.startsWith(head)), `${key} writes win methods "${head}…"`).toBe(true);
      }
      perModule[key] = { literals: scan.literals.size, templates: scan.templateHeads.size, files: files.length };
      // Zero checked is a failure: every module decides wins, so a scan that finds none is aimed at nothing.
      expect(scan.literals.size, `${key}: the scan found no win method`).toBeGreaterThan(0);
    });
    expect(n).toBe(Object.keys(FOLD_EPOCH).length);
    expect(Object.keys(perModule).sort()).toEqual(Object.keys(SOURCE_DIRS).sort());
    // The calls the regex form would miss are seen: the period kernel's extra time and cricket's super over reach a win
    // only as a `decideWin(…)` argument; chess's rungs only as a template.
    const probe = (dirs: readonly string[]): Scan => {
      const s: Scan = { literals: new Set(), templateHeads: new Set(), unresolved: 0 };
      for (const f of sourcesOf(dirs)) scanFile(f, s);
      return s;
    };
    expect(probe(SOURCE_DIRS.icehockey!).literals).toContain("extra_time");
    expect(probe(SOURCE_DIRS.cricket!).literals).toContain("super_over");
    expect(probe(SOURCE_DIRS.cricket!).literals).toContain("dls"); // through the local `methodSuffix` const
    expect(probe(SOURCE_DIRS.boardgame!).templateHeads).toContain("tiebreak_");
    expect(perModule.football!.literals).toBeGreaterThanOrEqual(4); // regulation, extra_time, shootout, abandoned
  }, SCAN_BUDGET_MS);

  it("the scanner sees each road a method takes into a win (a synthetic source; an undeclared method is found, not skipped)", () => {
    // A witness for the scanner, not the modules: without it a scanner that found nothing in a file would read as clean.
    const source = [
      'const suffix = flag ? "dls_like" : "plain";',
      "function decide(state, side, method) { return { kind: \"win\", winner: side, loser: side, method }; }",
      'const a = { kind: "win", winner: "H", loser: "A", method: "golden_goal" };',
      'const b = { kind: "win", winner: "H", loser: "A", method: x ? "left" : (y ?? "right") };',
      'decide(s, "home", "argument");',
      "decide(s, \"home\", suffix);",
      "const c = { kind: \"win\", winner: \"H\", loser: \"A\", method: `rung_${r}` };",
      'const notAWin = { kind: "award", method: "ignored" };',
      "const fromPayload = { kind: \"win\", winner: \"H\", loser: \"A\", method: payload.method };",
    ].join("\n");
    const s: Scan = { literals: new Set(), templateHeads: new Set(), unresolved: 0 };
    scanSource("synthetic.ts", source, s);
    expect([...s.literals].sort()).toEqual(["argument", "dls_like", "golden_goal", "left", "plain", "right"]);
    expect([...s.templateHeads]).toEqual(["rung_"]);
    expect(s.unresolved).toBe(2); // `y` and `payload.method`: reported, never counted as checked
    let declares = 0;
    forEachSport(({ module }) => {
      if (module.outcomeMethods.includes("golden_goal")) declares++;
    });
    expect(declares).toBe(0); // so a fold that wrote it would fail the sweep above
  });
});
