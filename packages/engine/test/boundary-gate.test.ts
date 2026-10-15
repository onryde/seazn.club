// The gate itself must demonstrably fail on seeded violations (PROMPT-01
// acceptance). Fixtures are written to a temp dir shaped like an engine src/.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, globSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkEngineBoundary, checkPhoneClosure, checkPhoneSafety, codeSkeleton, IMPORT_EXEMPTIONS, importSpecifiers, phoneClosureDrift, scanEngineBoundary } from "../scripts/engine-boundary.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

// Every scratch directory a test makes is tracked and removed after THAT test (a test may make several: the CLI "scanned nothing" test
// makes three), and afterAll holds the line: none made by this file is still there. It asks only for no leftovers, never for "some were
// made": a run of a single test (`-t`) that makes none must stay green. That tracking really removes is proved by its own test below.
const made: string[] = [];
const everMade: string[] = [];
/** Remove every scratch directory made since the last call; returns how many it removed. */
function cleanUp(): number {
  const dirs = made.splice(0);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  return dirs.length;
}
afterEach(cleanUp);
afterAll(() => {
  expect(everMade.filter((d) => existsSync(d)), "scratch directories left behind").toEqual([]);
});
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  everMade.push(d);
  return d;
}

describe("scratch directories", () => {
  it("every one a test makes is tracked, removed by the cleanup, and forgotten - however many a test makes", () => {
    const dirs = [scratchDir("engine-scratch-a-"), scratchDir("engine-scratch-b-"), scratchDir("engine-scratch-c-")];
    for (const d of dirs) expect(existsSync(d), `${d} exists once made`).toBe(true);
    expect(made).toEqual(dirs);
    expect(cleanUp(), "the cleanup reports how many it removed").toBe(3);
    for (const d of dirs) expect(existsSync(d), `${d} is gone after the cleanup`).toBe(false);
    expect(made, "and the list is empty again").toEqual([]);
    expect(cleanUp(), "a second cleanup removes nothing").toBe(0);
  });
});

function seed(files: Record<string, string>): string {
  const dir = scratchDir("engine-boundary-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

// The engine package this file sits in, found from its own URL and nothing else: test/layout.ts asks git where the engine sits, which
// answers wrong inside a Stryker sandbox (stryker-sandbox-safe rule 2), and this file must not need git.
const ENGINE = fileURLToPath(new URL("..", import.meta.url));

// The phone walk's scratch engines (engine-split 1c-1). A checkout is a package.json whose `exports` name the phone subpaths, a
// phone-subpaths.json that lists them, and src/ files. `PHONE_LIST` is the decided D25 list (core, sport, sports, every sport directory):
// the scratch engines use their OWN copy so a walker test does not depend on what the real phone-subpaths.json says.
const PHONE_LIST = ["./core", "./sport", "./sports", "./sports/*"];

/** The src/ files a clean scratch engine needs for the four phone subpaths to resolve, one sport directory included. */
const PHONE_SKELETON: Record<string, string> = {
  "src/core/index.ts": "export {};\n",
  "src/sport/index.ts": "export {};\n",
  "src/sports/index.ts": "export {};\n",
  "src/sports/x/index.ts": "export {};\n",
};

interface PhoneConfig {
  /** Point `./sport` at a file that is not there. */
  sportMissing?: boolean;
  /** What phone-subpaths.json lists (default: the D25 list). */
  subpaths?: readonly string[];
  /** Extra or replacing `exports` entries (a value that is not a string is allowed, to seed a malformed one). */
  exports?: Record<string, unknown>;
  /** The `closure.modules` pin phone-subpaths.json records (default: a one-module pin that only checkPhoneClosure reads, and never matches). */
  pinned?: readonly string[];
}

function writePhoneConfig(dir: string, opts: PhoneConfig = {}): void {
  const exportsMap = {
    "./core": "./src/core/index.ts",
    "./sport": opts.sportMissing ? "./src/sport/gone.ts" : "./src/sport/index.ts",
    "./sports": "./src/sports/index.ts",
    "./sports/*": "./src/sports/*/index.ts",
    ...opts.exports,
  };
  // declared packages: dep-a and @scope/pkg (dependencies), zod (a required peer), opt-peer (an OPTIONAL peer), dev-only (a devDependency)
  const declared = {
    dependencies: { "dep-a": "1.0.0", "@scope/pkg": "1.0.0" },
    devDependencies: { "dev-only": "1.0.0" },
    peerDependencies: { zod: "^4", "opt-peer": "^1" },
    peerDependenciesMeta: { "opt-peer": { optional: true } },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scratch-engine", exports: exportsMap, ...declared }));
  writeFileSync(join(dir, "phone-subpaths.json"), JSON.stringify({ subpaths: opts.subpaths ?? PHONE_LIST, closure: { modules: opts.pinned ?? ["src/core/index.ts"], measured: "scratch", why: "scratch" } }));
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

/** A scratch engine: the config, the minimal phone skeleton (unless `files` supplies the same path), and `files`. Paths are engine-relative. */
function seedEngine(files: Record<string, string>, opts: PhoneConfig = {}): string {
  const dir = scratchDir("engine-phone-");
  writePhoneConfig(dir, opts);
  const skeleton = { ...PHONE_SKELETON };
  if (opts.sportMissing) delete skeleton["src/sport/index.ts"];
  writeFiles(dir, { ...skeleton, ...files });
  return dir;
}

describe("engine boundary gate", () => {
  it("passes on the real packages/engine/src", () => {
    const real = new URL("../src", import.meta.url).pathname;
    expect(checkEngineBoundary(real)).toEqual([]);
    // anti-vacuity: the gate reports how many files it looked at, and that is every .ts file under src/, counted by glob rather than by the gate's own walk
    const { scanned, violations } = scanEngineBoundary(real);
    expect(violations).toEqual([]);
    expect(scanned).toBe(globSync("**/*.ts", { cwd: real }).length);
    expect(scanned).toBeGreaterThan(100);
  });

  it.each([
    ["postgres", 'import postgres from "postgres";'],
    ["next", 'import { headers } from "next/headers";'],
    ["react", 'import { useState } from "react";'],
    ["ioredis", 'import Redis from "ioredis";'],
    ["server-only", 'import "server-only";'],
    ["node:crypto", 'import { randomUUID } from "node:crypto";'],
    ["apps/", 'import { db } from "../../apps/web/src/lib/db";'],
  ])("fails on forbidden import: %s", (_name, line) => {
    const violations = checkEngineBoundary(seed({ "core/bad.ts": `${line}\nexport {};\n` }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain("forbidden import");
  });

  it.each([
    ["Date.now(", "export const t = Date.now();"],
    ["Math.random(", "export const r = Math.random();"],
    ["new Date()", "export const d = new Date();"],
  ])("fails on ambient call outside core/clock.ts: %s", (_name, line) => {
    const violations = checkEngineBoundary(seed({ "competition/bad.ts": `${line}\n` }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toContain("forbidden call");
  });

  it("allows ambient time in core/clock.ts and its test", () => {
    const violations = checkEngineBoundary(
      seed({
        "core/clock.ts": "export const now = () => Date.now();\n",
        "core/clock.test.ts": "const t = Date.now();\nexport {};\n",
      }),
    );
    expect(violations).toEqual([]);
  });

  it("ignores banned tokens inside comments", () => {
    const violations = checkEngineBoundary(
      seed({ "core/ok.ts": "// never call Date.now() here\n/* Math.random( banned */\nexport {};\n" }),
    );
    expect(violations).toEqual([]);
  });

  it("reports file and line for each violation", () => {
    const violations = checkEngineBoundary(
      seed({ "scheduling/bad.ts": "export {};\nconst t = Date.now();\n" }),
    );
    expect(violations).toEqual([
      { file: "scheduling/bad.ts", line: 2, rule: expect.stringContaining("Date.now(") },
    ]);
  });
});

// The boundary scan reads the code skeleton (comments, strings, templates and regexes blanked), not a regex-stripped copy: the old
// comment stripper ran its block-comment pass before its line-comment pass, so a `/**` inside a `//` comment blanked the code up to the
// next `*/` (src/testkit/golden.ts:20 hid its first 43 lines, and a `node:crypto` import with them), and a `"//"` or `"/*"` in a string
// hid the rest of the line. Single-sport reason: no sport is involved - this is a text-scanning rule.
describe("engine boundary gate: it reads code, not text", () => {
  it.each([
    ["a /** inside a // comment (src/testkit/golden.ts:20)", '// the /** marker\nimport postgres from "postgres";\n/* a real comment */\nexport {};\n', "forbidden import", 2],
    ["a /* inside a // comment", '// opens /* nothing\nimport postgres from "postgres";\nexport const s = 1; // a */ b\n', "forbidden import", 2],
    ["a // inside a string", 'export const u = "http://x"; export const t = Date.now();\n', "forbidden call", 1],
    ["a /* inside a string", 'export const g = "/*"; export const t = Date.now(); export const h = "*/";\n', "forbidden call", 1],
    ["an apostrophe in a comment", "// it's fine\nexport const r = Math.random();\n", "forbidden call", 2],
    ["a quote in a regular expression", 'export const q = /"/.test(x); export const d = new Date();\n', "forbidden call", 1],
    ["a template placeholder", "export const t = `a ${Date.now()} b`;\n", "forbidden call", 1],
    ["a mid-line import after a string holding //", 'export const u = "http://x"; import postgres from "postgres";\n', "forbidden import", 1],
    ["an import with no space before its string", 'import"postgres";\n', "forbidden import", 1],
    ["an import after another statement on its line", 'export {}; import "postgres";\n', "forbidden import", 1],
    ["a no-space from", 'import{headers}from"next/headers";\n', "forbidden import", 1],
    ["a multi-line import", 'import {\n  a,\n} from "react";\nexport {};\n', "forbidden import", 3],
    ["a multi-line block comment before it (the line is the source's, not the skeleton's)", "/* a\n   b\n   c */\nexport const t = Date.now();\n", "forbidden call", 4],
    ["a multi-line template before it", "export const s = `a\nb`;\nexport const t = Date.now();\n", "forbidden call", 3],
    ["a multi-line template before an import", 'export const s = `a\nb`;\nimport postgres from "postgres";\n', "forbidden import", 3],
  ])("still sees the violation after %s", (_label, code, rule, line) => {
    const violations = checkEngineBoundary(seed({ "core/bad.ts": code }));
    expect(violations).toEqual([{ file: "core/bad.ts", line, rule: expect.stringContaining(rule) }]);
  });

  it.each([
    ["Date.now( in a string", 'export const s = "Date.now(";\n'],
    ["Math.random( in a template", "export const s = `Math.random( ${1}`;\n"],
    ["new Date() in a single-quoted string", "export const s = 'new Date()';\n"],
    ["a banned import written inside a string", "export const s = 'import x from \"postgres\"';\n"],
    ["a banned import written inside a template", "export const s = `import \"next\"`;\n"],
    ["a banned import written inside a regex", 'export const r = /from "react"/;\n'],
    ["a banned import written in a block comment", '/* import x from "react"; */\nexport {};\n'],
    ["a method named import", 'export const r = loader.import("postgres");\n'],
    ["a method named require", 'export const r = loader.require("postgres");\n'],
    ["a function whose name ends in import", 'export const r = reimport("postgres");\n'],
    ["a function whose name ends in require", 'export const r = $require("postgres");\n'],
  ])("does not flag %s", (_label, code) => {
    expect(checkEngineBoundary(seed({ "core/ok.ts": code }))).toEqual([]);
  });

  it("agrees with the TypeScript AST on every module specifier of every file of the real src/ (type imports included)", () => {
    const real = new URL("../src", import.meta.url).pathname;
    const files = globSync("**/*.ts", { cwd: real });
    let compared = 0;
    for (const rel of files) {
      const source = readFileSync(join(real, rel), "utf8");
      const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.ESNext, true);
      const found: string[] = [];
      const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) found.push(n.moduleSpecifier.text);
        else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) found.push(n.moduleReference.expression.text);
        else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) found.push(n.arguments[0].text);
        else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) found.push(n.argument.literal.text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      expect(importSpecifiers(source), rel).toEqual(found);
      compared += found.length;
    }
    expect(files.length, "anti-vacuity: files compared").toBeGreaterThan(100);
    expect(compared, "anti-vacuity: specifiers compared").toBeGreaterThan(500);
  });
});

// The code skeleton is built from the TypeScript parser's own reading of the file (batch 1c review, M1): the hand-rolled lexer that came
// first guessed regex-versus-division from the preceding character and read the `/` after a non-null `!` (and after postfix `++`/`--`) as
// the start of a regular expression, which blanked the rest of the line - or, inside a template placeholder, the rest of the function - and
// with it a `process.env` or a `Date.now()`. The probes below are valid TypeScript with the banned thing on the SAME line after the idiom.
// Single-sport reason: no sport is involved - this is a text-scanning rule.
const DIVISION_AND_REGEX_PROBES: [string, string][] = [
  ["a non-null assertion before a division", "const a = x! / 2;"],
  ["a non-null assertion on a member before a division", "const a = x.y! / z.w!;"],
  ["a postfix ++ before a division", "let i = 0; const q = i++ / 2;"],
  ["a postfix -- before a division", "let i = 0; const q = i-- / 2;"],
  ["a non-null assertion in a template placeholder", "export const p = `${(done! / total) * 100}%`;"],
  ["a non-null assertion in a nested template placeholder", "export const p = `a ${`b ${(done! / total)}`} c`;"],
  ["a non-null assertion before a division and a string", 'const s = a! / 2 + "x";'],
  ["a division after a property named return", "const q = a.return / 2;"],
  ["a division after a property named in", "const q = a.in / 2;"],
  ["a division after a property named typeof", "const q = a.typeof / 2;"],
  ["a division after a cast", "const q = (a as number) / 2;"],
  ["a division after an angle-bracket assertion", "const q = (<number>a) / 2;"],
  ["a division after a generic call", "const q = f<number>(a) / 2;"],
  ["a division after an indexed non-null", "const q = a[0]! / a[1]!;"],
  ["a division after a call", "const q = f(a) / 2;"],
  ["a regex after an if condition", 'if (a) /"/.test(b);'],
  ["a regex after a block", '{ } /"/.test(b);'],
  ["a regex in an arrow body", 'const f = (s: string) => /"/.test(s);'],
  ["a division after a closing bracket and a regex after", 'const q = a[0] / 2, r = /"/;'],
];

describe("code skeleton: division and regular expressions (the TypeScript parser decides, not the preceding character)", () => {
  it.each(DIVISION_AND_REGEX_PROBES)("the purity scan still sees a banned call after %s", (_label, idiom) => {
    const violations = checkEngineBoundary(seed({ "core/bad.ts": `${idiom} export const t = Date.now();\n` }));
    expect(violations).toEqual([{ file: "core/bad.ts", line: 1, rule: expect.stringContaining("forbidden call Date.now(") }]);
  });

  it.each(DIVISION_AND_REGEX_PROBES)("the phone walk still sees process after %s", (_label, idiom) => {
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": `${idiom} export const e = process.env;\n` }));
    expect(r.violations.map((v) => [v.kind, v.detail.split(":")[0]])).toEqual([["process", "line 1"]]);
  });

  it.each(DIVISION_AND_REGEX_PROBES)("the purity scan still sees a banned import after %s", (_label, idiom) => {
    const violations = checkEngineBoundary(seed({ "core/bad.ts": `${idiom} import postgres from "postgres";\nexport {};\n` }));
    expect(violations.map((v) => v.rule)).toEqual([expect.stringContaining('forbidden import "postgres"')]);
  });

  it("the skeleton of a fixture is exactly what its author wrote: comments and the insides of strings, templates and regular expressions blank, quotes and code kept", () => {
    const z = (text: string) => " ".repeat(text.length); // the blanking of `text`, piece by piece, so each expectation is written down rather than computed from the gate
    const source = [
      "// it's a /** comment",
      'import a from "node:fs"; /* "q" */ const b = `x${a! / 2}y${`z`}`;',
      String.raw`const c = /[/"]\//g, d = 'it\'s', e = a++ / 2;`,
      "export const f = `${(b! / 1)}%`; // tail 'x",
    ].join("\n");
    const expected = [
      z("// it's a /** comment"),
      `import a from "${z("node:fs")}"; ${z('/* "q" */')} const b = \`${z("x")}\${a! / 2}${z("y")}\${\`${z("z")}\`}\`;`,
      `const c = /${z(String.raw`[/"]\/`)}/g, d = '${z(String.raw`it\'s`)}', e = a++ / 2;`,
      `export const f = \`\${(b! / 1)}${z("%")}\`; ${z("// tail 'x")}`,
    ].join("\n");
    expect(codeSkeleton(source).split("\n")).toEqual(expected.split("\n"));
  });

  it("keeps the source's length and its line breaks outside comments, strings and templates", () => {
    const source = 'const a = "x";\n// c\n/* m\nn */\nconst b = `p\nq`;\n';
    const out = codeSkeleton(source);
    expect(out.length).toBe(source.length);
    expect(out.split("\n").length, "block comments and templates may blank their own newlines, nothing else").toBeLessThanOrEqual(source.split("\n").length);
    expect(out.split("\n")[0]).toBe('const a = " ";');
  });
});

// The skeleton against the TypeScript parser on every file of the real src/: each token's own text, and the trivia between tokens, read
// through a second path (the parser's token list and its comment-range functions) from the one the gate uses (literal nodes plus a scan for
// the comments that remain). A position the parser calls code must be the source's own character; a position inside a comment or a
// literal's text must be blank. Anti-vacuity: the files, the literals and the comments it covered are counted, and none is a failure.
/** What the skeleton of `source` should be, from the parser's tokens: the text of string, template and regular-expression literals and the
 *  comments between tokens blanked, everything else as written. Also counts the spans it blanked. */
function expectedSkeleton(source: string): { text: string; literals: number; comments: number } {
  const sf = ts.createSourceFile("oracle.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const out = source.split("");
  const blank = (from: number, to: number) => { for (let i = from; i < to; i++) out[i] = " "; };
  let literals = 0;
  let comments = 0;
  const leaves: ts.Node[] = [];
  const collect = (n: ts.Node): void => {
    // a JSDoc comment is trivia, not a token (and a comment dangling before the end of the file hangs off the end-of-file token as a child)
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.kind === ts.SyntaxKind.EndOfFileToken ? [] : n.getChildren(sf);
    if (kids.length === 0) leaves.push(n);
    else kids.forEach(collect);
  };
  collect(sf);
  for (const leaf of leaves) {
    for (const range of [...(ts.getLeadingCommentRanges(source, leaf.pos) ?? []), ...(ts.getTrailingCommentRanges(source, leaf.pos) ?? [])]) {
      blank(range.pos, range.end);
      comments++;
    }
    const start = leaf.getStart(sf);
    const text = source.slice(start, leaf.end);
    switch (leaf.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateTail:
        blank(start + 1, text.length > 1 && text.endsWith(text[0] === "}" ? "`" : text[0]!) ? leaf.end - 1 : leaf.end);
        literals++;
        break;
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
        blank(start + 1, leaf.end - 2);
        literals++;
        break;
      case ts.SyntaxKind.RegularExpressionLiteral:
        blank(start + 1, start + text.lastIndexOf("/"));
        literals++;
        break;
      default:
    }
  }
  return { text: out.join(""), literals, comments };
}

/** Compare the skeleton of every file to the parser's reading. A comparison over no file is a failure. */
function skeletonMismatches(files: { name: string; source: string }[], skeleton: (s: string) => string): { files: number; literals: number; comments: number; mismatches: string[] } {
  if (files.length === 0) throw new Error("skeletonMismatches: no file to compare - a comparison over nothing proves nothing");
  const mismatches: string[] = [];
  let literals = 0;
  let comments = 0;
  for (const { name, source } of files) {
    const want = expectedSkeleton(source);
    literals += want.literals;
    comments += want.comments;
    const got = skeleton(source);
    if (got === want.text) continue;
    let at = 0;
    while (got[at] === want.text[at]) at++;
    mismatches.push(`${name}:${source.slice(0, at).split("\n").length}: ${JSON.stringify(source.slice(Math.max(0, at - 20), at + 20))}`);
  }
  return { files: files.length, literals, comments, mismatches };
}

describe("code skeleton: against the TypeScript parser, over every file of the real src/", () => {
  it("is what the parser says on every file: no code position blanked, no comment or literal text left", () => {
    const real = new URL("../src", import.meta.url).pathname;
    const files = globSync("**/*.ts", { cwd: real }).map((name) => ({ name, source: readFileSync(join(real, name), "utf8") }));
    const r = skeletonMismatches(files, codeSkeleton);
    expect(r.files, "anti-vacuity: files compared").toBeGreaterThan(100);
    expect(r.literals, "anti-vacuity: string, template and regular-expression literals compared").toBeGreaterThan(5000);
    expect(r.comments, "anti-vacuity: comments compared").toBeGreaterThan(2000);
    expect(r.mismatches, `${r.files} files, ${r.literals} literals, ${r.comments} comments: ${JSON.stringify(r.mismatches)}`).toEqual([]);
  });

  it("refuses to compare nothing, and sees a skeleton that is wrong", () => {
    expect(() => skeletonMismatches([], codeSkeleton)).toThrow(/no file to compare/);
    const idiom = [{ name: "idiom.ts", source: "const a = x! / 2; const s = \"it's\";\n" }];
    expect(skeletonMismatches(idiom, codeSkeleton).mismatches).toEqual([]);
    // a skeleton that leaves a comment's text, one that blanks code, and one that blanks the rest of the line after a `!` are all seen
    const withComment = [{ name: "c.ts", source: "const a = 1; // note\n" }];
    expect(skeletonMismatches(withComment, (s) => s).mismatches).toHaveLength(1);
    expect(skeletonMismatches(idiom, (s) => codeSkeleton(s).replace("const", "     ")).mismatches).toHaveLength(1);
    expect(skeletonMismatches(idiom, (s) => s.replace(/!.*/, (m) => " ".repeat(m.length))).mismatches).toHaveLength(1);
  });
});

// The one named exemption (orchestrator ruling, a recommendation to the owner, reversible): src/testkit/golden.ts imports node:crypto
// for createHash, and has since 2dd25ba4b; the old stripper hid that import from the gate, so the gate was never red over it. Replacing
// createHash would churn every golden digest, so the import is allowed in that ONE file, and only that specifier.
describe("engine boundary gate: the golden.ts node:crypto exemption", () => {
  const GOLDEN = "testkit/golden.ts";
  const CRYPTO = 'import { createHash } from "node:crypto";\nexport const h = createHash;\n';

  it("is declared once, for that file and that specifier, with a reason", () => {
    expect(IMPORT_EXEMPTIONS.map((e) => [e.file, e.specifier])).toEqual([[GOLDEN, "node:crypto"]]);
    expect(IMPORT_EXEMPTIONS[0]!.why.length).toBeGreaterThan(20);
  });

  it("allows node:crypto in that file, and says it did", () => {
    const r = scanEngineBoundary(seed({ [GOLDEN]: CRYPTO }));
    expect(r.violations).toEqual([]);
    expect(r.exempted).toEqual([`${GOLDEN} node:crypto`]);
  });

  it.each([
    ["another testkit file", "testkit/other.ts"],
    ["a file of the same name elsewhere", "core/testkit/golden.ts"],
    ["a file named like it", "testkit/golden-compare.ts"],
    ["a phone module", "core/index.ts"],
    ["the sport directory", "sports/x/index.ts"],
  ])("still refuses node:crypto in %s", (_label, file) => {
    const r = scanEngineBoundary(seed({ [file]: CRYPTO, [GOLDEN]: CRYPTO }));
    expect(r.violations).toEqual([{ file, line: 1, rule: expect.stringContaining('"node:crypto"') }]);
    expect(r.exempted, "the exemption is used by the one file only").toEqual([`${GOLDEN} node:crypto`]);
  });

  it("allows nothing else in that file: bare crypto, another banned import, and a banned call still red", () => {
    const code = 'import { createHash } from "node:crypto";\nimport c from "crypto";\nimport postgres from "postgres";\nexport const t = Date.now();\n';
    const r = scanEngineBoundary(seed({ [GOLDEN]: code }));
    expect(r.violations.map((v) => [v.line, v.rule.split(" ").slice(0, 3).join(" ")])).toEqual([
      [2, 'forbidden import "crypto"'],
      [3, 'forbidden import "postgres"'],
      [4, "forbidden call Date.now()"],
    ]);
  });

  it("is red when the file no longer imports it (a stale exemption), whether it imports nothing, or only mentions it in a comment or a string", () => {
    for (const code of ["export const h = 1;\n", '// import { createHash } from "node:crypto";\nexport {};\n', 'export const s = \'import "node:crypto"\';\n']) {
      const r = scanEngineBoundary(seed({ [GOLDEN]: code }));
      expect(r.violations, code).toEqual([{ file: GOLDEN, line: 1, rule: expect.stringContaining("stale import exemption") }]);
      expect(r.exempted, code).toEqual([]);
    }
  });

  it("asks nothing of a tree that has no such file", () => {
    const r = scanEngineBoundary(seed({ "core/ok.ts": "export {};\n" }));
    expect(r.violations).toEqual([]);
    expect(r.exempted).toEqual([]);
  });

  it("is used by the real src/: the exemption is not dead, and it is the only one in use", () => {
    const real = new URL("../src", import.meta.url).pathname;
    const r = scanEngineBoundary(real);
    expect(r.violations).toEqual([]);
    expect(r.exempted).toEqual([`${GOLDEN} node:crypto`]);
    // counted without the gate: the real file does import it, and nothing else under src/ imports node:crypto outside a comment
    expect(readFileSync(join(real, GOLDEN), "utf8")).toMatch(/^import \{ createHash \} from "node:crypto";$/m);
  });

  it("does not extend to the phone walk: the same file reached from a phone subpath is still a Node builtin", () => {
    const dir = seedEngine({ "src/core/index.ts": 'export * from "../testkit/golden.ts";', "src/testkit/golden.ts": CRYPTO });
    expect(checkPhoneSafety(dir).violations).toEqual([{ kind: "node-builtin", file: "src/testkit/golden.ts", detail: expect.stringContaining("line 1") }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Phone-safe subpaths (engine-split 1c-1, D25). The phone subpaths (phone-subpaths.json) and everything they import by value must read
// no Node builtin, no `process`, and nothing from scheduling. Single-sport reason: no sport is involved - this is a module-graph rule.

describe("phone-safe subpaths: the real engine", () => {
  const cfg = JSON.parse(readFileSync(join(ENGINE, "phone-subpaths.json"), "utf8")) as { subpaths: string[]; closure: { modules: string[]; why: string } };
  const pkg = JSON.parse(readFileSync(join(ENGINE, "package.json"), "utf8")) as {
    exports: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  /** The value-import closure of the phone entries, read with the TypeScript AST: a reading of the same graph that shares no code with
   *  the gate's own scanner. `entries` come from a glob over the declared sport directories, not from the gate. */
  function astClosure(entries: string[]): { modules: string[]; externals: string[] } {
    const seen = new Set<string>();
    const externals = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const sf = ts.createSourceFile(file, readFileSync(join(ENGINE, file), "utf8"), ts.ScriptTarget.ESNext, true);
      const follow = (spec: string) => {
        if (spec.startsWith(".")) queue.push(posix.join(posix.dirname(file), spec));
        else externals.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      };
      const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) follow((n.moduleSpecifier as ts.StringLiteral).text);
        else if (ts.isExportDeclaration(n) && n.moduleSpecifier && !n.isTypeOnly) follow((n.moduleSpecifier as ts.StringLiteral).text);
        else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) follow(n.arguments[0].text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return { modules: [...seen].sort(), externals: [...externals].sort() };
  }
  const sportIndexes = () => globSync("src/sports/*/index.ts", { cwd: ENGINE }).map((f) => f.split("\\").join("/")).sort();

  it("walks exactly the recorded closure, every phone entry module included, and finds it clean", () => {
    const r = checkPhoneSafety(ENGINE);
    expect(r.violations).toEqual([]);
    // the pin is a SET of modules recorded in phone-subpaths.json; a drift names what was added and removed, and where to re-pin
    expect(cfg.closure.modules.length, "anti-vacuity: the recorded closure").toBeGreaterThan(30);
    expect(phoneClosureDrift(r.walked, cfg.closure.modules), "the phone closure drifted from the pin").toBeNull();
    // the entries are the declared exports of the listed subpaths, counted without the gate: one file per plain subpath, one per sport directory
    expect(sportIndexes().length, "anti-vacuity: the sport directories the ./sports/* pattern expands over").toBeGreaterThan(5);
    expect(r.entries.length).toBe(cfg.subpaths.filter((p) => !p.includes("*")).length + sportIndexes().length);
    for (const e of r.entries) expect(r.walked).toContain(e);
  });

  it("is red against the real src/ when the recorded closure is perturbed: a module dropped from the pin, one invented", () => {
    const dropped = cfg.closure.modules[0]!;
    const invented = "src/core/not-a-module.ts";
    expect(cfg.closure.modules, "the invented module is not a real one").not.toContain(invented);
    // a scratch engine whose package.json and src/ are the real ones and whose pin is the real one, perturbed
    const dir = scratchDir("engine-pin-");
    copyFileSync(join(ENGINE, "package.json"), join(dir, "package.json"));
    symlinkSync(join(ENGINE, "src"), join(dir, "src"));
    const writePin = (modules: string[]) => writeFileSync(join(dir, "phone-subpaths.json"), JSON.stringify({ subpaths: cfg.subpaths, closure: { ...cfg.closure, modules } }));
    writePin([...cfg.closure.modules]);
    expect(checkPhoneClosure(dir).violations, "the unperturbed pin is green against the real src/ - the red below is the perturbation's").toEqual([]);
    writePin([...cfg.closure.modules.slice(1), invented]);
    const r = checkPhoneClosure(dir);
    expect(r.violations).toEqual([{ kind: "closure-changed", file: "phone-subpaths.json", detail: expect.stringContaining(`added: ${dropped}`) }]);
    expect(r.violations[0]!.detail).toContain(`removed: ${invented}`);
    expect(r.walked.length, "the walk is reported whole").toBe(cfg.closure.modules.length);
  });

  it("lists the D25 phone subpaths, and every one is a key of the package's exports", () => {
    // D25 (plan 1c-1): core, sport, sports and every sport directory. The list is the authority; this pins it against the decision.
    expect(cfg.subpaths).toEqual(["./core", "./sport", "./sports", "./sports/*"]);
    for (const p of cfg.subpaths) expect(Object.keys(pkg.exports), p).toContain(p);
  });

  it("agrees with an independent reading of the same graph: the TypeScript AST finds the same modules and the same packages", () => {
    const entries = [...cfg.subpaths.filter((p) => !p.includes("*")).map((p) => (pkg.exports[p] as string).replace(/^\.\//, "")), ...sportIndexes()];
    const oracle = astClosure(entries);
    const r = checkPhoneSafety(ENGINE);
    expect(oracle.modules.length, "anti-vacuity: modules the oracle read").toBeGreaterThan(30);
    expect([...r.walked].sort()).toEqual(oracle.modules);
    expect(r.externals).toEqual(oracle.externals);
  });

  it("imports only packages the engine declares as runtime dependencies: zod, and nothing optional (read without the gate's own check)", () => {
    const r = checkPhoneSafety(ENGINE);
    const required = (name: string) => pkg.peerDependenciesMeta?.[name]?.optional !== true;
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}).filter(required)];
    expect(r.externals.length, "anti-vacuity: the phone closure imports at least zod").toBeGreaterThan(0);
    for (const x of r.externals) expect(declared, `${x} is imported by a phone module but is not a required dependency or peer`).toContain(x);
  });

  it("is deterministic: a second call reports the same walk", () => {
    expect(checkPhoneSafety(ENGINE)).toEqual(checkPhoneSafety(ENGINE));
  });

  it("is red through the combined check when the pin and the walk disagree, and green when they agree (the real engine)", () => {
    const green = checkPhoneClosure(ENGINE);
    expect(green.violations).toEqual([]);
    expect(green.walked.length).toBe(cfg.closure.modules.length);
  });
});

// The pin is a set, and every check that reds on a new phone module says the same thing: which file to update, and which modules were
// added and removed.
describe("phone-safe subpaths: the closure pin", () => {
  const A = "src/core/a.ts";
  const B = "src/core/b.ts";
  const C = "src/core/c.ts";

  it("is silent when the walk and the pin hold the same modules, in any order and however often the pin repeats one", () => {
    expect(phoneClosureDrift([A, B, C], [C, A, B])).toBeNull();
    expect(phoneClosureDrift([A, B], [A, B, B])).toBeNull();
  });

  it("names the modules added, the modules removed, and the file to re-pin", () => {
    const added = phoneClosureDrift([A, B, C], [A, B]);
    expect(added).toContain("1 module(s) added");
    expect(added).toContain(C);
    expect(added).not.toMatch(/removed/);
    const removed = phoneClosureDrift([A], [A, B, C]);
    expect(removed).toContain("2 module(s) removed");
    expect(removed).toContain(B);
    expect(removed).toContain(C);
    expect(removed).not.toMatch(/added/);
    const both = phoneClosureDrift([A, C], [A, B])!;
    expect(both).toContain(`added: ${C}`);
    expect(both).toContain(`removed: ${B}`);
    for (const msg of [added, removed, both]) {
      expect(msg).toContain("closure.modules");
      expect(msg).toContain("phone-subpaths.json");
      expect(msg).toContain("closure.measured");
    }
  });

  it("is a violation of the combined check, named at phone-subpaths.json, and not of the plain walk", () => {
    const dir = seedEngine({ "src/core/index.ts": 'export * from "./a.ts";', "src/core/a.ts": "export const a = 1;" }, { pinned: ["src/core/index.ts", "src/sport/index.ts", "src/sports/index.ts", "src/sports/x/index.ts", "src/core/gone.ts"] });
    expect(checkPhoneSafety(dir).violations, "the plain walk does not read the pin").toEqual([]);
    const r = checkPhoneClosure(dir);
    expect(r.violations).toEqual([{ kind: "closure-changed", file: "phone-subpaths.json", detail: expect.stringContaining("added: src/core/a.ts") }]);
    expect(r.violations[0]!.detail).toContain("removed: src/core/gone.ts");
    expect(r.walked, "the walk is reported whole").toContain("src/core/a.ts");
  });

  it("passes the combined check when the pin matches", () => {
    const pinned = ["src/core/index.ts", "src/sport/index.ts", "src/sports/index.ts", "src/sports/x/index.ts"];
    const r = checkPhoneClosure(seedEngine({}, { pinned }));
    expect(r.violations).toEqual([]);
    expect(r.walked).toEqual(pinned);
  });

  it("reports the walk's own violations as well, ahead of the drift", () => {
    const dir = seedEngine({ "src/core/index.ts": 'import "node:fs";' }, { pinned: ["src/core/other.ts"] });
    expect(checkPhoneClosure(dir).violations.map((v) => v.kind)).toEqual(["node-builtin", "closure-changed"]);
  });

  it("refuses a pin it cannot read: missing, empty, not a list, or a list of anything but strings", () => {
    for (const closure of [undefined, {}, { modules: [] }, { modules: "src/core/index.ts" }, { modules: [7] }, { modules: null }]) {
      const dir = seedEngine({});
      writeFileSync(join(dir, "phone-subpaths.json"), JSON.stringify({ subpaths: PHONE_LIST, closure }));
      expect(() => checkPhoneClosure(dir), JSON.stringify(closure)).toThrow(/closure\.modules/);
    }
  });
});

describe("phone-safe subpaths: what the walk refuses", () => {
  it.each([
    ["a node: builtin", 'import { readFileSync } from "node:fs";', "node-builtin"],
    ["a bare builtin", 'import path from "path";', "node-builtin"],
    ["a builtin subpath", 'import { readFile } from "fs/promises";', "node-builtin"],
    ["a node:-only builtin", 'import { test } from "node:test";', "node-builtin"],
    ["a side-effect node: import", 'import "node:fs";', "node-builtin"],
    ["a dynamic node: import", 'export const load = () => import("node:fs");', "node-builtin"],
    ["a re-exported builtin", 'export { join } from "path";', "node-builtin"],
    ["a star re-exported node: builtin", 'export * from "node:path";', "node-builtin"],
    ["process", "export const lvl = process.env.LOG_LEVEL;", "process"],
    ["optional-chained process", "export const lvl = process?.env?.LOG_LEVEL;", "process"],
    ["globalThis.process", "export const lvl = globalThis.process;", "process"],
    ["optional-chained globalThis.process", "export const lvl = globalThis?.process;", "process"],
    ["process behind brackets", 'export const lvl = process["env"];', "process"],
    ["globalThis behind brackets", 'export const lvl = globalThis["process"];', "process"],
    ["process spread into an object", "export const env = { ...process.env };", "process"],
    ["process spread into an array", "export const argv = [...process.argv];", "process"],
    ["process destructured", "export const { env } = process;", "process"],
    ["process destructured by name", "const { process } = globalThis; export const p = 1;", "process"],
    ["process destructured from globalThis under another name", "const { process: p } = globalThis; export const e = p;", "process"],
    ["process passed as an argument", "declare function f(x: unknown): void; f(process);", "process"],
    ["process in parentheses", "export const lvl = (process).env;", "process"],
    ["process in a ternary", "export const p = Math.abs(1) > 0 ? process : null;", "process"],
    ["process on the right of a ternary", "export const p = Math.abs(1) > 0 ? null : process;", "process"],
    ["typeof process", 'export const has = typeof process !== "undefined";', "process"],
    ["a type query of process", "export type P = typeof process;", "process"],
    ["a shorthand property", "export const o = { process };", "process"],
    ["global.process", "export const p = global.process;", "process"],
    ["window.process", "export const p = window.process;", "process"],
    ["self.process", "export const p = self.process;", "process"],
    ["optional-chained global.process", "export const p = global?.process;", "process"],
    ["global behind brackets", "export const p = global['process'];", "process"],
    ["window behind optional brackets", 'export const p = window?.["process"];', "process"],
    ["globalThis.process with whitespace", "export const p = globalThis . process;", "process"],
    ["process after a return", "export function f() { return process; }", "process"],
    ["process as a default parameter", "export function f(p = process) { return p; }", "process"],
    ["globalThis behind a template literal", "export const lvl = globalThis[`process`];", "process"],
    ["global behind an optional template literal", "export const lvl = global?.[`process`];", "process"],
    ["process as a switch label", "export function f(x: unknown) { switch (x) { case process: return 1; default: return 0; } }", "process"],
    ["process as a switch label after another case", "export function f(x: unknown) { switch (x) { case 1: case process: return 1; default: return 0; } }", "process"],
    ["Buffer", "export const b = Buffer.from([1]);", "node-global"],
    ["Buffer as a type annotation", "export function f(b: Buffer) { return b; }", "node-global"],
    ["new Buffer", "export const b = new Buffer(4);", "node-global"],
    ["optional-chained Buffer", "export const b = Buffer?.from([1]);", "node-global"],
    ["typeof Buffer", 'export const has = typeof Buffer !== "undefined";', "node-global"],
    ["Buffer after a spread", "export const b = [...Buffer.from([1])];", "node-global"],
    ["Buffer as a shorthand property", "export const o = { Buffer };", "node-global"],
    ["globalThis.Buffer", "export const b = globalThis.Buffer;", "node-global"],
    ["globalThis behind brackets for Buffer", 'export const b = globalThis["Buffer"];', "node-global"],
    ["Buffer destructured from globalThis under another name", "const { Buffer: B } = globalThis; export const e = B;", "node-global"],
    ["__dirname", 'export const d = __dirname + "/x";', "node-global"],
    ["__filename", "export const d = __filename;", "node-global"],
    ["__dirname in a template placeholder", "export const d = `${__dirname}/x`;", "node-global"],
    ["__filename as an argument", "declare function f(x: string): void; f(__filename);", "node-global"],
    ["typeof __dirname", 'export const has = typeof __dirname !== "undefined";', "node-global"],
    ["require of a variable", "export const load = (n: string) => require(n);", "unresolved-import"],
    ["require of a template", "export const load = require(`node:fs`);", "unresolved-import"],
    ["an empty require", "export const load = require();", "unresolved-import"],
    ["a dynamic import of a concatenation", 'export const load = () => import("./" + "../scheduling/build.ts");', "unresolved-import"],
    ["a require of a concatenation", 'export const load = require("./leak" + ".ts");', "unresolved-import"],
    ["a dynamic import of a literal and a variable", 'export const load = (n: string) => import("./" + n);', "unresolved-import"],
    ["a dynamic import of a literal in a conditional", 'export const load = (c: boolean) => import(c ? "./a.ts" : "./b.ts");', "unresolved-import"],
    ["a dynamic import of a literal then an operator", 'export const load = () => import("./a.ts" as string);', "unresolved-import"],
    ["a dynamic import of a template", "export const load = () => import(`node:fs`);", "unresolved-import"],
    ["an import with no spaces", 'import{readFileSync}from"node:fs";', "node-builtin"],
    ["a re-export with no spaces", 'export{join}from"path";', "node-builtin"],
    ["a star re-export with no spaces", 'export*from"node:path";', "node-builtin"],
    ["an import of a string-named specifier", 'import { "a-b" as ab } from "node:fs"; export const x = ab;', "node-builtin"],
    ["a re-export of a string-named specifier", 'export { "a-b" as "c-d" } from "node:fs";', "node-builtin"],
    ["a star re-export under a string name", 'export * as "x-y" from "node:path";', "node-builtin"],
    ["a default import named type", 'import type from "node:fs"; export const x = type;', "node-builtin"],
    ["a default import named type next to a named import", 'import type, { a } from "node:fs"; export const x = [type, a];', "node-builtin"],
    ["a default import with a namespace import", 'import d, * as ns from "node:fs"; export const x = [d, ns];', "node-builtin"],
    ["an import of the package by its published name", 'import "scratch-engine/core";', "self-import"],
    ["an import of the package by its alias", 'import { a } from "@seazn/engine/core"; export const b = a;', "self-import"],
    ["an import of the bare alias", 'export * from "@seazn/engine";', "self-import"],
    ["a dynamic import of the package itself", 'export const load = () => import("@seazn/engine/sport");', "self-import"],
    ["a package that is not declared at all", 'import "left-pad";', "undeclared-package"],
    ["a package that is only a devDependency", 'import "dev-only";', "undeclared-package"],
    ["a package that is only an optional peer", 'import "opt-peer";', "undeclared-package"],
    ["a scoped package that is not declared", 'import "@scope/other/sub";', "undeclared-package"],
    ["a package whose name starts like the package's own alias", 'import "@seazn/engine-extra";', "undeclared-package"],
    ["scheduling", 'import { buildSchedule } from "../scheduling/build.ts";', "scheduling"],
    ["scheduling through a directory import", 'export * from "../scheduling";', "scheduling"],
    ["a dynamic import it cannot resolve", "export const load = (n: string) => import(n);", "unresolved-import"],
    ["a relative import of a file that is not there", 'import { a } from "./nope.ts"; export const b = a;', "unresolved-import"],
    ["an import that leaves the package", 'import "../../../elsewhere.ts";', "outside-src"],
    ["an import that leaves the package by exactly the root", 'import "../../..";', "outside-src"],
    ["an import of a package file outside src/", 'import "../../package.json";', "outside-src"],
  ])("refuses %s reached from a phone subpath", (_label, line, kind) => {
    const dir = seedEngine({ "src/core/index.ts": 'export * from "./leak.ts";', "src/core/leak.ts": line, "src/scheduling/build.ts": "export const buildSchedule = 1;", "src/scheduling/index.ts": "export {};" });
    const r = checkPhoneSafety(dir);
    // exactly one violation, of this kind, named at the file that holds it (and not at the entry that merely re-exports it)
    expect(r.violations).toEqual([{ kind, file: "src/core/leak.ts", detail: expect.stringContaining("line 1") }]);
    expect(r.walked).toContain("src/core/leak.ts");
  });

  it("does not walk into scheduling once it has refused the import: the one violation is the import, not what is behind it", () => {
    const dir = seedEngine({ "src/core/index.ts": 'import "../scheduling/build.ts";', "src/scheduling/build.ts": 'import "node:fs"; export const x = process.env;' });
    const r = checkPhoneSafety(dir);
    expect(r.violations.map((v) => v.kind)).toEqual(["scheduling"]);
    expect(r.walked).not.toContain("src/scheduling/build.ts");
    // ... and an import of a scheduling file that does not exist is still a scheduling violation, not an unresolved one
    const gone = checkPhoneSafety(seedEngine({ "src/core/index.ts": 'import "../scheduling/gone.ts";' }));
    expect(gone.violations.map((v) => v.kind)).toEqual(["scheduling"]);
  });

  it.each([
    ["import … from", 'import { a } from "./leak.ts"; export const b = a;'],
    ["a default and a named import", 'import d, { a } from "./leak.ts"; export const b = [d, a];'],
    ["a namespace import", 'import * as ns from "./leak.ts"; export const b = ns;'],
    ["a multi-line import", 'import {\n  a,\n  c,\n} from "./leak.ts";\nexport const b = [a, c];'],
    ["a side-effect import", 'import "./leak.ts";'],
    ["export *", 'export * from "./leak.ts";'],
    ["export * as", 'export * as ns from "./leak.ts";'],
    ["export { … } from", 'export { a } from "./leak.ts";'],
    ["a dynamic import()", 'export const load = () => import("./leak.ts");'],
    ["a require()", 'export const load = require("./leak.ts");'],
    ["an inline `type` specifier (whether the build keeps it is a compiler flag; a walk too wide is loud, too narrow silent)", 'import { type X } from "./leak.ts"; export const a = 1;'],
    ["an import with no spaces", 'import{a}from"./leak.ts";export const b = a;'],
    ["a re-export with no spaces", 'export{a}from"./leak.ts";'],
    ["a star re-export with no spaces", 'export*from"./leak.ts";'],
    ["a string-named import specifier", 'import { "a" as ab } from "./leak.ts"; export const b = ab;'],
    ["a string-named re-export", 'export { "a" as "z-z" } from "./leak.ts";'],
    ["a star re-export under a string name", 'export * as "z-z" from "./leak.ts";'],
    ["a default import named type", 'import type from "./leak.ts"; export const a = type;'],
    ["a default import named type next to a named import", 'import type, { a } from "./leak.ts"; export const b = [type, a];'],
    ["an import after a statement on its line", 'export const k = 1; import "./leak.ts";'],
    ["a dynamic import with spaces inside the parentheses", 'export const load = () => import( "./leak.ts" );'],
    ["a require with spaces inside the parentheses", 'export const load = require( "./leak.ts" );'],
    ["a dynamic import with import attributes", 'export const load = () => import("./leak.ts", { with: { type: "json" } });'],
    ["a dynamic import with a trailing comma", 'export const load = () => import("./leak.ts",);'],
    ["a require split over lines", 'export const load = require(\n  "./leak.ts"\n);'],
  ])("follows %s", (_label, line) => {
    const dir = seedEngine({ "src/core/index.ts": line, "src/core/leak.ts": 'import "node:fs"; export const a = 1; export const c = 2; export default 3;' });
    const r = checkPhoneSafety(dir);
    expect(r.walked).toContain("src/core/leak.ts");
    expect(r.violations.map((v) => v.kind)).toEqual(["node-builtin"]);
  });

  it.each([
    ["import type", 'import type { X } from "./leak.ts"; export const a = 1;'],
    ["import type of a default", 'import type D from "./leak.ts"; export const a = 1;'],
    ["export type { … } from", 'export type { X } from "./leak.ts";'],
    ["export type *", 'export type * from "./leak.ts";'],
    ["import type with no space before the braces", 'import type{ X }from"./leak.ts"; export const a = 1;'],
    ["import type of a namespace", 'import type * as ns from "./leak.ts"; export const a = 1;'],
    ["import type of a default and braces on several lines", 'import type {\n  X,\n} from "./leak.ts";\nexport const a = 1;'],
    ["typeof import()", 'export type T = typeof import("./leak.ts"); export const a = 1;'],
    ["typeof import() with whitespace", 'export type T = typeof  import ( "./leak.ts" ); export const a = 1;'],
  ])("does not follow `%s` (erased at compile time)", (_label, line) => {
    const dir = seedEngine({ "src/core/index.ts": line, "src/core/leak.ts": 'import "node:fs"; export type X = 1; export default 1;' });
    const r = checkPhoneSafety(dir);
    expect(r.violations).toEqual([]);
    expect(r.walked, "the walk did run").toContain("src/core/index.ts");
    expect(r.walked).not.toContain("src/core/leak.ts");
  });

  it("treats an exports target that does not exist as a violation, not a smaller walk", () => {
    const dir = seedEngine({ "src/core/index.ts": "export const a = 1;" }, { sportMissing: true });
    expect(checkPhoneSafety(dir).violations).toEqual([{ kind: "missing-entry", file: "src/sport/gone.ts", detail: expect.stringContaining('"./sport"') }]);
  });

  it("treats a ./sports/* pattern that matches no directory, and an exports value that is not a ./ path, as violations too", () => {
    const none = seedEngine({}, { exports: { "./sports/*": "./src/nowhere/*/index.ts" } });
    expect(checkPhoneSafety(none).violations).toEqual([{ kind: "missing-entry", file: "src/nowhere/*/index.ts", detail: expect.stringContaining("matches no file") }]);
    for (const odd of [{ types: "./x.d.ts" }, "src/sport/index.ts", 7]) {
      const dir = seedEngine({}, { exports: { "./sport": odd } });
      expect(checkPhoneSafety(dir).violations, JSON.stringify(odd)).toEqual([{ kind: "missing-entry", file: "package.json", detail: expect.stringContaining('"./sport"') }]);
    }
  });

  it("refuses a pattern shape it would have to guess at, rather than walking a smaller closure", () => {
    for (const shape of ["./src/sports/x-*/index.ts", "./src/sports/*.ts", "./src/*/*/index.ts"]) {
      const dir = seedEngine({}, { exports: { "./sports/*": shape } });
      expect(() => checkPhoneSafety(dir), shape).toThrow(/only <dir>\/\*\/<file> patterns/);
    }
  });

  it("refuses a phone subpath whose entry file lives under scheduling", () => {
    const dir = seedEngine({ "src/scheduling/index.ts": "export {};" }, { exports: { "./core": "./src/scheduling/index.ts" } });
    const r = checkPhoneSafety(dir);
    expect(r.violations).toEqual([{ kind: "scheduling", file: "src/scheduling/index.ts", detail: expect.stringContaining('"./core"') }]);
    expect(r.walked, "an entry under scheduling is refused, not walked").not.toContain("src/scheduling/index.ts");
  });

  it("refuses a listed subpath the package does not export", () => {
    const dir = seedEngine({}, { subpaths: [...PHONE_LIST, "./nope"] });
    expect(checkPhoneSafety(dir).violations).toEqual([{ kind: "unknown-subpath", file: "phone-subpaths.json", detail: expect.stringContaining("./nope") }]);
  });

  it("resolves a specifier as written, without its extension, with .js for .ts, and as a directory's index", () => {
    const dir = seedEngine({
      "src/core/index.ts": 'import "./exact.ts"; import "./noext"; import "./js-ext.js"; import "./dir"; import "../up/../core/exact.ts";',
      "src/core/exact.ts": "export {};",
      "src/core/noext.ts": "export {};",
      "src/core/js-ext.ts": "export {};",
      "src/core/dir/index.ts": "export {};",
    });
    const r = checkPhoneSafety(dir);
    expect(r.violations).toEqual([]);
    for (const f of ["exact", "noext", "js-ext", "dir/index"]) expect(r.walked, f).toContain(`src/core/${f}.ts`);
  });

  it("reports a violation at its own line, after multi-line comments, strings and templates", () => {
    const code = ["/* a", "   b */", "export const t = `x", "y`;", 'import "node:fs";', "", "export const e = process.env;"].join("\n");
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": code }));
    expect(r.violations).toEqual([
      { kind: "node-builtin", file: "src/core/index.ts", detail: expect.stringContaining("line 5:") },
      { kind: "process", file: "src/core/index.ts", detail: expect.stringContaining("line 7:") },
    ]);
  });

  it("lists a file's violations in the order they stand in the file, whichever check found them", () => {
    const code = ['export const e = process.env;', 'import "node:fs";', 'export const l = (n: string) => require(n);', 'export const g = globalThis.process;', 'import "left-pad";'].join("\n");
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": code }));
    expect(r.violations.map((v) => [v.kind, v.detail.split(":")[0]])).toEqual([
      ["process", "line 1"],
      ["node-builtin", "line 2"],
      ["unresolved-import", "line 3"],
      ["process", "line 4"],
      ["undeclared-package", "line 5"],
    ]);
  });

  it("does not flag the same code outside the phone closure", () => {
    const dir = seedEngine({ "src/core/index.ts": "export const a = 1;", "src/history/x.ts": 'import "node:fs"; export const e = process.env;' });
    const r = checkPhoneSafety(dir);
    expect(r.violations).toEqual([]);
    expect(r.walked, "the walk did run").toContain("src/core/index.ts");
    expect(r.walked).not.toContain("src/history/x.ts");
  });
});

// A walk that does not terminate must fail, not hang: the visit budget is 10 x the .ts files under src/, and the walk visits each
// module once, so only a broken visited-guard can reach it.
describe("phone-safe subpaths: the visit budget", () => {
  const cyc = { "src/core/index.ts": 'import "./a.ts";', "src/core/a.ts": 'import "./b.ts"; import "./index.ts";', "src/core/b.ts": 'import "./a.ts"; import "./index.ts";' };

  it("walks a cycle once, and a module that several others import once", () => {
    const r = checkPhoneSafety(seedEngine(cyc));
    expect(r.violations).toEqual([]);
    expect(r.walked).toEqual(["src/core/a.ts", "src/core/b.ts", "src/core/index.ts", "src/sport/index.ts", "src/sports/index.ts", "src/sports/x/index.ts"]);
  });

  it("stops with an error naming the budget when the visits pass it, and not one visit sooner", () => {
    const dir = seedEngine(cyc);
    const needed = checkPhoneSafety(dir).walked.length; // every module is visited exactly once
    expect(checkPhoneSafety(dir, { visitBudget: needed }).walked).toHaveLength(needed);
    expect(() => checkPhoneSafety(dir, { visitBudget: needed - 1 })).toThrow(/visit budget/);
    expect(() => checkPhoneSafety(dir, { visitBudget: 0 })).toThrow(/visit budget/);
  });

  it("defaults to ten times the .ts files under src/", () => {
    // 6 scratch files here (the four entries and a, b ... plus index) -> a budget of 10 x the files; a one-module walk is far below it
    const dir = seedEngine(cyc);
    const files = globSync("**/*.ts", { cwd: join(dir, "src") }).length;
    expect(files).toBe(6);
    // the visit budget the walk used is reported, so the default is pinned by what it says rather than by waiting for a hang
    expect(checkPhoneSafety(dir).visitBudget).toBe(10 * files);
  });

  it("refuses a budget that is not a positive-or-zero integer", () => {
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => checkPhoneSafety(seedEngine(cyc), { visitBudget: bad }), String(bad)).toThrow(/visitBudget/);
  });
});

describe("phone-safe subpaths: what the walk reads", () => {
  it("lists the walk and its entries exactly: every phone entry, each sport directory with an index, what they import, once each", () => {
    const dir = seedEngine({
      "src/core/index.ts": 'export * from "./a.ts"; export * from "../shared/s.ts";',
      "src/core/a.ts": 'import { b } from "./b.ts"; export const a = b;',
      "src/core/b.ts": 'import { a } from "./a.ts"; export const b = 1; export const back = a;', // a cycle: walked once
      "src/shared/s.ts": 'import { z } from "zod"; import { w } from "@scope/pkg/sub"; export const s = [z, w];',
      "src/sports/y/index.ts": "export {};",
      "src/sports/novice/notes.ts": "export {};", // a directory with no index.ts is not an entry
      "src/orphan.ts": "export {};", // reachable from nothing
    }, { subpaths: ["./sports/*", "./sports", "./sport", "./core"] });
    const r = checkPhoneSafety(dir);
    expect(r.violations).toEqual([]);
    // sorted, whatever order the subpaths were listed in and the imports were met
    expect(r.entries).toEqual(["src/core/index.ts", "src/sport/index.ts", "src/sports/index.ts", "src/sports/x/index.ts", "src/sports/y/index.ts"]);
    expect(r.walked).toEqual(["src/core/a.ts", "src/core/b.ts", "src/core/index.ts", "src/shared/s.ts", "src/sport/index.ts", "src/sports/index.ts", "src/sports/x/index.ts", "src/sports/y/index.ts"]);
    expect(r.externals).toEqual(["@scope/pkg", "zod"]);
  });

  it("reads imports written without semicolons, one violation each, however many lines they span", () => {
    const dir = seedEngine({ "src/core/index.ts": 'import "./stub.ts"\nimport x from "node:fs"\nimport {\n  a,\n} from "node:path"\nexport const y = [x, a]', "src/core/stub.ts": "export {}" });
    const r = checkPhoneSafety(dir);
    expect(r.violations.map((v) => [v.kind, v.detail.split(":")[0]])).toEqual([["node-builtin", "line 2"], ["node-builtin", "line 3"]]);
  });

  it("lists the externals it saw even when it refuses them, and not the package's own name", () => {
    const dir = seedEngine({ "src/core/index.ts": 'import "zod"; import "left-pad"; import "@seazn/engine/sport"; import "dep-a/deep/file";' });
    const r = checkPhoneSafety(dir);
    expect(r.externals).toEqual(["dep-a", "left-pad", "zod"]);
    expect(r.violations.map((v) => [v.kind, v.detail])).toEqual([
      ["undeclared-package", expect.stringContaining('"left-pad"')],
      ["self-import", expect.stringContaining('"@seazn/engine/sport"')],
    ]);
  });

  it("reads code, not text: a comment or a string that says process.env or node:fs is not an import or a read", () => {
    const dir = seedEngine({
      "src/core/index.ts": [
        "// process.env.A and import 'node:fs'",
        "/* globalThis.process, and:",
        '   import x from "node:fs"; */',
        'export const a = "process.env.B";',
        "export const b = 'import \"node:fs\"';",
        "export const c = `process.env.C ${1 + 1} globalThis.process`;",
        "export const d = /process\\.env/;",
        "export const e = { process: 1 };",
        "export const f = e.process;",
        "export const subprocess = { env: 1 };",
        "export const g = subprocess.env;",
        'export const h = globalThis["fetch"];',
        "export const i = globalThis.fetch;",
        "export const j = e.process.env;", // some other object's `process` member
        "/*/ process.env */ export const k = 1;", // `/*/` opens a comment, it does not close one
        "export const l = { a: 1, process: 2 };", // a key after a comma
        "export interface Cfg { x: number; process: string; y?: number }", // a member of a type
        "export type Opt = { process?: string };",
        "export const m = (c: { process: number }) => c.process;",
        "export const n = e?.process;", // optional-chained property
        "export const o = [e].map((x) => x.process);",
        "export const q = e\n  .process;", // a property access split over lines
        "export const r = { ...e, process: 3 };", // a spread of something else, then the key
        "export const b1 = { Buffer: 1 };", // the other Node globals are property names too when they are one
        "export const b2 = e.Buffer;",
        "export const b3 = e?.__dirname;",
        "export interface Io { Buffer: string; __filename?: string }",
        "export const b4 = e.__filename;",
        "export const b5 = { __dirname: 1, __filename: 2 };",
        "export const b6 = globalThis.fetch;",
        "export const b7 = globalThis[`fetch`];", // a global other than the Node ones, behind a template literal
        'export const b8 = "Buffer __dirname __filename";', // names inside a string
        "export const b9 = `${1} Buffer`; // __dirname",
        "export const Buffered = 1; export const mybuffer = Buffered; export const __dirnames = 1;", // longer words that contain the names
        "export const b10 = subBuffer.length;",
        "export const b11 = sw === 1 ? e : { case1: 1 };",
        'export const x1 = loader.import("node:fs");', // a method named import / require is not a module load
        'export const x2 = loader.require("node:fs");',
        'export const x3 = reimport("node:fs");',
        "export const x4 = loader.import(name);",
        "export const x5 = loader.require(name);",
        "export const x6 = $import(name);",
      ].join("\n"),
    });
    const r = checkPhoneSafety(dir);
    expect(r.violations).toEqual([]);
    expect(r.walked).toContain("src/core/index.ts");
  });

  it.each([
    ["after a // inside a string", 'export const u = "http://x"; export const e = process.env;'],
    ["after a /* inside a string", 'export const g = "/*"; export const e = process.env; export const h = "*/";'],
    ["after an apostrophe in a comment", "// it's fine\nexport const e = process.env;"],
    ["after a quote in a block comment", "/* a \" b */ export const e = process.env;"],
    ["after an escaped quote", 'export const s = "a\\"b"; export const e = process.env;'],
    ["after a regex holding a quote", 'export const r = /"/; export const e = process.env;'],
    ["after a regex holding a slash in a class", 'export const r = /[/"]/; export const e = process.env;'],
    ["after a division by a number", 'export const q = 4 / 2; export const s = "/"; export const e = process.env;'],
    ["after a division by a call", 'export const q = Math.abs(4) / 2; export const s = "/"; export const e = process.env;'],
    ["after a regex that follows return", 'export function f(x: string) { return /"/.test(x) && process.env; }'],
    ["inside a template placeholder", "export const t = `a ${process.env.X} b`;"],
    ["inside a nested template placeholder", "export const t = `a ${`b ${process.env.X}`} c`;"],
    ["after an unterminated string", 'export const a = "never closed\nexport const e = process.env;'],
    ["after an escaped backtick in a template", "export const t = `a \\` b`; export const e = process.env;"],
    ["after an escaped slash in a regex", 'export const r = /\\/"/; export const e = process.env;'],
    ["after a regex at the start of the file", '/"/.test(x) && process.env;'],
    ["after a division by an indexed value", 'export const q = a[0] / 2; export const s = "/"; export const e = process.env;'],
    ["after a division by an object", 'export const q = {} / 2; export const s = "/"; export const e = process.env;'],
    ["after a division by a name", 'export const q = a / 2; export const s = "/"; export const e = process.env;'],
    ["inside a placeholder that holds braces", "export const t = `${ ({ a: 1 }).a + process.env.X }`;"],
    ["after a placeholder that held braces", "export const t = `${ ({ a: 1 }).a }`; export const e = process.env;"],
  ])("still sees process %s", (_label, code) => {
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": code }));
    expect(r.violations.map((v) => v.kind)).toEqual(["process"]);
  });

  it("reads an unterminated block comment as a comment to the end of the file, and the same text closed as a comment and then code", () => {
    const head = "export const a = 1;\n";
    const open = `${head}/* process.env; import "node:fs"; Buffer.from([1]);`;
    expect(checkPhoneSafety(seedEngine({ "src/core/index.ts": open })).violations).toEqual([]);
    expect(codeSkeleton(open)).toBe(head + " ".repeat(open.length - head.length));
    // the control: closed, the comment ends where it says and the code after it is read
    const closed = `${head}/* process.env; */ export const e = process.env;`;
    expect(checkPhoneSafety(seedEngine({ "src/core/index.ts": closed })).violations.map((v) => [v.kind, v.detail.split(":")[0]])).toEqual([["process", "line 2"]]);
  });

  it.each([
    ["import()", 'export const load = () => import("./b.ts" + "x");'],
    ["require()", 'export const load = require("./b.ts" + "x");'],
  ])("does not follow the first literal of a concatenated %s as if it were the module, and follows a plain one", (_what, code) => {
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": code, "src/core/b.ts": "export const b = 1;" }));
    expect(r.violations.map((v) => v.kind)).toEqual(["unresolved-import"]);
    expect(r.walked, "b.ts is not what this loads").not.toContain("src/core/b.ts");
    const plain = checkPhoneSafety(seedEngine({ "src/core/index.ts": code.replace(' + "x"', ""), "src/core/b.ts": "export const b = 1;" }));
    expect(plain.violations).toEqual([]);
    expect(plain.walked, "the control: a plain literal is followed").toContain("src/core/b.ts");
  });

  // The places a `/` opens a regular expression (JavaScript's grammar, read by the TypeScript parser, not by a table of preceding characters):
  // a quote inside that regex must not be read as a string, or the code after it on the line disappears from the scan. Every row is a valid
  // program, followed on its own line by a read of `process`.
  it.each([
    ["(", 'f( /"/ );'],
    [",", 'f(a, /"/);'],
    ["=", 'x = /"/;'],
    [":", '({ k: /"/ });'],
    ["[", '[ /"/ ];'],
    ["!", '!/"/.test(s);'],
    ["&&", 'a && /"/.test(s);'],
    ["||", 'a || /"/.test(s);'],
    ["?", 'a ? /"/ : 1;'],
    ["{ (a block)", '{ /"/.test(s); }'],
    [";", 'a; /"/.test(s);'],
    ["+", 'a + /"/.lastIndex;'],
    ["-", 'a - /"/.lastIndex;'],
    ["*", 'a * /"/.lastIndex;'],
    ["%", 'a % /"/.lastIndex;'],
    ["<", 'a < /"/.lastIndex;'],
    [">", 'a > /"/.lastIndex;'],
    ["~", "~/\"/.lastIndex;"],
    ["^", 'a ^ /"/.lastIndex;'],
    ["&", 'a & /"/.lastIndex;'],
    ["|", 'a | /"/.lastIndex;'],
    ["=>", "const f = (s: string) => /\"/.test(s);"],
    [") of an if", 'if (a) /"/.test(b);'],
    [") of a while", 'while (a) /"/.test(b);'],
    ["} of a block", '{ } /"/.test(b);'],
  ])("reads a / after %s as a regular expression, and still sees the next line", (_where, code) => {
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": `${code}\nexport const e = process.env;` }));
    expect(r.violations.map((v) => [v.kind, v.detail.split(":")[0]])).toEqual([["process", "line 2"]]);
  });

  it.each([
    ["return", 'function f() { return /"/.test(s); }'],
    ["typeof", 'const t = typeof /"/;'],
    ["instanceof", 'const t = a instanceof /"/;'],
    ["in", 'const t = a in /"/;'],
    ["of", 'for (const a of /"/.exec(s) ?? []) { a; }'],
    ["new", 'const t = new /"/();'],
    ["delete", 'delete /"/.x;'],
    ["void", 'const t = void /"/;'],
    ["throw", 'function f() { throw /"/; }'],
    ["case", 'switch (a) { case /"/: break; }'],
    ["do", 'do /"/.test(s); while (a);'],
    ["else", 'if (a) b; else /"/.test(s);'],
    ["yield", 'function* g() { yield /"/; }'],
    ["await", 'async function h() { await /"/; }'],
  ])("reads a / after the word %s as a regular expression, and still sees the next line", (_word, code) => {
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": `${code}\nexport const e = process.env;` }));
    expect(r.violations.map((v) => [v.kind, v.detail.split(":")[0]])).toEqual([["process", "line 2"]]);
  });

  it("sees an import written after a string that holds a // as well", () => {
    const dir = seedEngine({ "src/core/index.ts": 'export const u = "http://x"; import "./leak.ts";', "src/core/leak.ts": 'import "node:fs";' });
    expect(checkPhoneSafety(dir).violations.map((v) => v.kind)).toEqual(["node-builtin"]);
  });

  it("reads the package.json and phone-subpaths.json it is given, and fails loudly when either is unusable", () => {
    const noConfig = scratchDir("engine-phone-none-");
    writeFiles(noConfig, PHONE_SKELETON);
    expect(() => checkPhoneSafety(noConfig)).toThrow(/package\.json/);
    const noList = seedEngine({});
    rmSync(join(noList, "phone-subpaths.json"));
    expect(() => checkPhoneSafety(noList)).toThrow(/phone-subpaths\.json/);
    for (const subpaths of ["./core", [7], null]) {
      const badList = seedEngine({});
      writeFileSync(join(badList, "phone-subpaths.json"), JSON.stringify({ subpaths }));
      expect(() => checkPhoneSafety(badList), JSON.stringify(subpaths)).toThrow(/subpaths/);
    }
    const notJson = seedEngine({});
    writeFileSync(join(notJson, "phone-subpaths.json"), "{ not json");
    expect(() => checkPhoneSafety(notJson)).toThrow(/phone-subpaths\.json is not valid JSON/);
    const noExports = seedEngine({});
    writeFileSync(join(noExports, "package.json"), JSON.stringify({ name: "x" }));
    expect(() => checkPhoneSafety(noExports)).toThrow(/exports/);
  });
});

// The CLI, as CI and `pnpm boundary` run it (engine-split 1d-2 review). Layout-agnostic: the gate and its helper are copied into a scratch
// tree shaped like an engine checkout (`scripts/` beside `src/`), and started through a symlink, so what is proven is the gate's own
// resolution of the src/ beside it, with no reliance on this package sitting at packages/engine or on the root's scripts/lib.
describe("engine boundary gate CLI (a copy of the gate beside a scratch src/)", () => {
  const GATE = fileURLToPath(new URL("../scripts/engine-boundary.ts", import.meta.url));
  const HELPER = fileURLToPath(new URL("../scripts/lib/main-module.ts", import.meta.url));

  /** A scratch engine checkout: `eng/scripts/{engine-boundary.ts,lib/main-module.ts}`, `eng/node_modules` (the real one, for `typescript`), `eng/src/<files>` (no src/ at all when `src` is null),
   *  and the phone walk's inputs, `eng/package.json` + `eng/phone-subpaths.json` (1c-1; `phone` shapes or omits them), plus `bin/gate.ts`,
   *  a symlink to the copy. Every root it makes is tracked, so afterEach removes them all. */
  function checkout(src: Record<string, string> | null, phone: PhoneConfig | null = { pinned: CLEAN_PIN }): { root: string; eng: string; via: string } {
    const root = realpathSync(scratchDir("engine-boundary-cli-"));
    const eng = join(root, "eng");
    mkdirSync(join(eng, "scripts/lib"), { recursive: true });
    copyFileSync(GATE, join(eng, "scripts/engine-boundary.ts"));
    copyFileSync(HELPER, join(eng, "scripts/lib/main-module.ts"));
    // the gate parses with the `typescript` devDependency, which a scratch checkout finds the way a real one does: through its node_modules
    symlinkSync(join(ENGINE, "node_modules"), join(eng, "node_modules"));
    if (phone !== null) writePhoneConfig(eng, phone);
    if (src !== null) mkdirSync(join(eng, "src"), { recursive: true });
    for (const [rel, text] of Object.entries(src ?? {})) {
      mkdirSync(dirname(join(eng, "src", rel)), { recursive: true });
      writeFileSync(join(eng, "src", rel), text);
    }
    mkdirSync(join(root, "bin"));
    const via = join(root, "bin", "gate.ts");
    symlinkSync(join(eng, "scripts/engine-boundary.ts"), via);
    return { root, eng, via };
  }
  const run = (via: string, cwd: string) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", via], { cwd, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });

  // The four phone entries (core/index.ts re-exports core/ok.ts) and one file the phone subpaths never reach: 6 files scanned, 5 of them walked.
  const CLEAN = {
    "core/index.ts": 'export * from "./ok.ts";\n',
    "core/ok.ts": "export const ok = 1;\n",
    "sport/index.ts": "export {};\n",
    "sports/index.ts": "export {};\n",
    "sports/x/index.ts": "export {};\n",
    "a/b/c/deep.ts": "export const deep = 2;\n",
  };
  const WALKED = Object.keys(CLEAN).length - 1; // all but a/b/c/deep.ts
  // the pin a clean scratch checkout records: written out, not read back from the walk
  const CLEAN_PIN = ["src/core/index.ts", "src/core/ok.ts", "src/sport/index.ts", "src/sports/index.ts", "src/sports/x/index.ts"];
  const NESTED_BAD = 'export {};\nimport postgres from "postgres";\n';

  it("exits 1 and names a violation in a NESTED file, by its path from the working directory, and counts the files it scanned", () => {
    const { root, eng, via } = checkout({ ...CLEAN, "deep/er/nested/bad.ts": NESTED_BAD });
    const here = run(via, eng);
    expect(here.status, here.stdout + here.stderr).toBe(1);
    expect(here.stderr).toContain('FAIL  src/deep/er/nested/bad.ts:2  forbidden import "postgres" (postgres)');
    expect(here.stdout).toContain(`1 boundary violation(s) in ${Object.keys(CLEAN).length + 1} files scanned`);
    expect(here.stdout, "a violation is never also a PASS").not.toContain("PASS");
    // the same gate from the parent directory prints the same file by THAT working directory, not by a typed prefix
    const above = run(via, root);
    expect(above.status, above.stdout + above.stderr).toBe(1);
    expect(above.stderr).toContain('FAIL  eng/src/deep/er/nested/bad.ts:2  forbidden import "postgres" (postgres)');
    expect(above.stderr, "no monorepo prefix is typed into the message").not.toContain("packages/engine");
  }, spawnBudget(2));

  it("exits 0 with a PASS line that counts every file it scanned, nested ones included, when src/ is clean", () => {
    const { eng, via } = checkout(CLEAN);
    const r = run(via, eng);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`PASS  engine boundary clean (${Object.keys(CLEAN).length} files scanned)`);
    // the phone walk reports the modules IT walked, which is not the number of files scanned (deep.ts is outside every phone subpath)
    expect(r.stdout).toContain(`phone-safe: ${WALKED} modules walked`);
    expect(r.stderr).toBe("");
  }, spawnBudget(1));

  it("exits 1 when it scanned nothing: an empty src/, a src/ with no .ts file, and no src/ at all are not a clean engine", () => {
    for (const [what, src] of [["an empty src/", {}], ["a src/ with no .ts file", { "notes.md": "Date.now() is banned\n" }], ["no src/ at all", null]] as const) {
      const { eng, via } = checkout(src);
      const r = run(via, eng);
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, `${what}: a gate over nothing must not say PASS`).not.toContain("PASS");
      expect(r.stderr, what).toMatch(/FAIL {2}(scanned 0 files|cannot scan)/);
    }
  }, spawnBudget(3));

  // The phone walk (1c-1): the same CLI also walks the phone subpaths and prints how many modules it walked.
  const LEAK = 'import { readFileSync } from "node:fs";\nexport const ok = readFileSync;\n';

  it("exits 1 on a phone-safety violation, names it by its path from the working directory, and does not say PASS", () => {
    const { root, eng, via } = checkout({ ...CLEAN, "core/ok.ts": LEAK });
    const here = run(via, eng);
    expect(here.status, here.stdout + here.stderr).toBe(1);
    expect(here.stderr).toContain('FAIL  src/core/ok.ts  node-builtin: line 1: imports "node:fs"');
    expect(here.stdout).toContain(`1 phone-safety violation(s) in ${WALKED} modules walked`);
    expect(here.stdout, "the phone rule failed, so neither the PASS line nor the phone-safe line may print").not.toMatch(/PASS|phone-safe:/);
    expect(here.stdout, "the boundary scan was clean, and says how many files it scanned: a red gate still states what it checked").toContain(`engine boundary clean (${Object.keys(CLEAN).length} files scanned)`);
    const above = run(via, root);
    expect(above.status, above.stdout + above.stderr).toBe(1);
    expect(above.stderr).toContain('FAIL  eng/src/core/ok.ts  node-builtin: line 1: imports "node:fs"');
    expect(above.stderr, "no monorepo prefix is typed into the message").not.toContain("packages/engine");
  }, spawnBudget(2));

  it("reports a boundary violation and a phone-safety violation together, each by its own summary", () => {
    const { eng, via } = checkout({ ...CLEAN, "core/ok.ts": LEAK, "deep/er/nested/bad.ts": NESTED_BAD });
    const r = run(via, eng);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('FAIL  src/deep/er/nested/bad.ts:2  forbidden import "postgres" (postgres)');
    expect(r.stderr).toContain("FAIL  src/core/ok.ts  node-builtin:");
    expect(r.stdout).toContain(`1 boundary violation(s) in ${Object.keys(CLEAN).length + 1} files scanned`);
    expect(r.stdout).toContain(`1 phone-safety violation(s) in ${WALKED} modules walked`);
    expect(r.stdout).not.toContain("PASS");
  }, spawnBudget(1));

  it("a boundary violation does not hide the phone walk's own line, and says nothing of a clean boundary", () => {
    const { eng, via } = checkout({ ...CLEAN, "deep/er/nested/bad.ts": NESTED_BAD });
    const r = run(via, eng);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout, "the phone walk was clean, and says so").toContain(`phone-safe: ${WALKED} modules walked`);
    expect(r.stdout).toContain(`1 boundary violation(s) in ${Object.keys(CLEAN).length + 1} files scanned`);
    expect(r.stdout, "a boundary violation is not a clean boundary").not.toContain("engine boundary clean");
  }, spawnBudget(1));

  const CRYPTO_IMPORT = 'import { createHash } from "node:crypto";\nexport const h = createHash;\n';

  it("passes with the golden.ts node:crypto exemption, and says on stdout that it used it", () => {
    const { eng, via } = checkout({ ...CLEAN, "testkit/golden.ts": CRYPTO_IMPORT });
    const r = run(via, eng);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("exempt  src/testkit/golden.ts  node:crypto");
    expect(r.stdout).toContain(`PASS  engine boundary clean (${Object.keys(CLEAN).length + 1} files scanned)`);
    expect(r.stderr).toBe("");
  }, spawnBudget(1));

  it("exits 1 on node:crypto anywhere else, and on a stale exemption (golden.ts without the import)", () => {
    const other = checkout({ ...CLEAN, "testkit/golden.ts": CRYPTO_IMPORT, "testkit/other.ts": CRYPTO_IMPORT });
    const a = run(other.via, other.eng);
    expect(a.status, a.stdout + a.stderr).toBe(1);
    expect(a.stderr).toContain('FAIL  src/testkit/other.ts:1  forbidden import "node:crypto" (node:crypto)');
    expect(a.stderr).not.toContain("golden.ts");
    expect(a.stdout).not.toContain("PASS");
    const stale = checkout({ ...CLEAN, "testkit/golden.ts": "export const h = 1;\n" });
    const b = run(stale.via, stale.eng);
    expect(b.status, b.stdout + b.stderr).toBe(1);
    expect(b.stderr).toContain("FAIL  src/testkit/golden.ts:1  stale import exemption");
    expect(b.stdout).not.toMatch(/PASS|exempt /);
  }, spawnBudget(2));

  it("exits 1 when the phone closure drifts from the pin, names the modules and the file to re-pin, and does not say PASS", () => {
    const { root, eng, via } = checkout({ ...CLEAN, "core/extra.ts": "export const e = 1;\n", "core/index.ts": 'export * from "./ok.ts";\nexport * from "./extra.ts";\n' });
    const here = run(via, eng);
    expect(here.status, here.stdout + here.stderr).toBe(1);
    expect(here.stderr).toContain("FAIL  phone-subpaths.json  closure-changed:");
    expect(here.stderr).toContain("added: src/core/extra.ts");
    expect(here.stderr).toContain("closure.modules");
    expect(here.stdout).toContain(`1 phone-safety violation(s) in ${WALKED + 1} modules walked`);
    expect(here.stdout).not.toMatch(/PASS|phone-safe:/);
    const above = run(via, root);
    expect(above.stderr).toContain("FAIL  eng/phone-subpaths.json  closure-changed:");
  }, spawnBudget(2));

  it("exits 1 on a package the closure imports and the package does not declare, and on the package importing itself", () => {
    for (const [what, line, kind] of [
      ["an undeclared package", 'import "left-pad";\n', "undeclared-package"],
      ["an optional peer", 'import "opt-peer";\n', "undeclared-package"],
      ["the package itself", 'import "@seazn/engine/sport";\n', "self-import"],
    ] as const) {
      const { eng, via } = checkout({ ...CLEAN, "core/ok.ts": `${line}export const ok = 1;\n` });
      const r = run(via, eng);
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stderr, what).toContain(`FAIL  src/core/ok.ts  ${kind}: line 1:`);
      expect(r.stdout, what).not.toMatch(/PASS|phone-safe:/);
    }
  }, spawnBudget(3));

  it("exits 1 when the phone walk cannot run or walked nothing: no package.json or phone-subpaths.json, and an empty subpath list, are not a clean engine", () => {
    for (const [what, phone, expected] of [
      ["no package.json and no phone-subpaths.json", null, /FAIL {2}cannot walk the phone subpaths: .*package\.json/],
      ["an empty subpath list", { subpaths: [] }, /FAIL {2}walked 0 phone modules/],
    ] as const) {
      const { eng, via } = checkout(CLEAN, phone);
      const r = run(via, eng);
      expect(r.status, `${what}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, `${what}: a gate over nothing must not say PASS`).not.toMatch(/PASS|phone-safe:/);
      expect(r.stderr, what).toMatch(expected);
      expect(r.stderr.trim().split("\n"), `${what}: one FAIL line and no stack trace`).toHaveLength(1);
    }
  }, spawnBudget(2));

  it("the real gate walks the recorded closure and passes, from the engine directory and from the directory above it", () => {
    const cfg = JSON.parse(readFileSync(join(ENGINE, "phone-subpaths.json"), "utf8")) as { closure: { modules: string[] } };
    expect(cfg.closure.modules.length, "anti-vacuity: the recorded closure").toBeGreaterThan(30);
    for (const cwd of [ENGINE, dirname(ENGINE.replace(/[\\/]$/, ""))]) {
      const r = run(GATE, cwd);
      expect(r.status, `${cwd}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`phone-safe: ${cfg.closure.modules.length} modules walked`);
      expect(r.stderr).toBe("");
    }
  }, spawnBudget(2));
});
