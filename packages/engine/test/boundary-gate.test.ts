// The gate itself must demonstrably fail on seeded violations (PROMPT-01
// acceptance). Fixtures are written to a temp dir shaped like an engine src/.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, globSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkEngineBoundary, checkPhoneSafety, scanEngineBoundary } from "../scripts/engine-boundary.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

// Every scratch directory a test makes is tracked and removed after THAT test (a test may make several: the CLI "scanned nothing" test
// makes three), and afterAll holds the line: none made by this file is still there.
const made: string[] = [];
const everMade: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
afterAll(() => {
  expect(everMade.length, "scratch directories this file made").toBeGreaterThan(0);
  expect(everMade.filter((d) => existsSync(d)), "scratch directories left behind").toEqual([]);
});
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  everMade.push(d);
  return d;
}

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
}

function writePhoneConfig(dir: string, opts: PhoneConfig = {}): void {
  const exportsMap = {
    "./core": "./src/core/index.ts",
    "./sport": opts.sportMissing ? "./src/sport/gone.ts" : "./src/sport/index.ts",
    "./sports": "./src/sports/index.ts",
    "./sports/*": "./src/sports/*/index.ts",
    ...opts.exports,
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scratch-engine", exports: exportsMap, dependencies: { "dep-a": "1.0.0" }, peerDependencies: { zod: "^4", "opt-peer": "^1" }, peerDependenciesMeta: { "opt-peer": { optional: true } } }));
  writeFileSync(join(dir, "phone-subpaths.json"), JSON.stringify({ subpaths: opts.subpaths ?? PHONE_LIST, closure: { modules: 0, measured: "scratch", why: "scratch" } }));
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Phone-safe subpaths (engine-split 1c-1, D25). The phone subpaths (phone-subpaths.json) and everything they import by value must read
// no Node builtin, no `process`, and nothing from scheduling. Single-sport reason: no sport is involved - this is a module-graph rule.

describe("phone-safe subpaths: the real engine", () => {
  const cfg = JSON.parse(readFileSync(join(ENGINE, "phone-subpaths.json"), "utf8")) as { subpaths: string[]; closure: { modules: number; why: string } };
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
    expect(r.walked.length, `closure changed: re-pin phone-subpaths.json closure.modules deliberately (${cfg.closure.why})`).toBe(cfg.closure.modules);
    // the entries are the declared exports of the listed subpaths, counted without the gate: one file per plain subpath, one per sport directory
    expect(sportIndexes().length, "anti-vacuity: the sport directories the ./sports/* pattern expands over").toBeGreaterThan(5);
    expect(r.entries.length).toBe(cfg.subpaths.filter((p) => !p.includes("*")).length + sportIndexes().length);
    for (const e of r.entries) expect(r.walked).toContain(e);
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

  it("imports only packages the engine declares as runtime dependencies: zod, and nothing optional", () => {
    const r = checkPhoneSafety(ENGINE);
    const required = (name: string) => pkg.peerDependenciesMeta?.[name]?.optional !== true;
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}).filter(required)];
    expect(r.externals.length, "anti-vacuity: the phone closure imports at least zod").toBeGreaterThan(0);
    for (const x of r.externals) expect(declared, `${x} is imported by a phone module but is not a required dependency or peer`).toContain(x);
  });

  it("is deterministic: a second call reports the same walk", () => {
    expect(checkPhoneSafety(ENGINE)).toEqual(checkPhoneSafety(ENGINE));
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

  it("does not flag the same code outside the phone closure", () => {
    const dir = seedEngine({ "src/core/index.ts": "export const a = 1;", "src/history/x.ts": 'import "node:fs"; export const e = process.env;' });
    const r = checkPhoneSafety(dir);
    expect(r.violations).toEqual([]);
    expect(r.walked, "the walk did run").toContain("src/core/index.ts");
    expect(r.walked).not.toContain("src/history/x.ts");
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

  // The characters and words after which a `/` opens a regular expression (JavaScript's grammar, not the scanner's table): a quote inside
  // that regex must not be read as a string, or the code after it on the line disappears from the scan.
  it.each(Array.from("(,=:[!&|?{;+-*%<>~^"))("reads a / after %s as a regular expression", (before) => {
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": `a ${before} /"/ ; export const e = process.env;` }));
    expect(r.violations.map((v) => v.kind)).toEqual(["process"]);
  });

  it.each(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"])("reads a / after the word %s as a regular expression", (word) => {
    const r = checkPhoneSafety(seedEngine({ "src/core/index.ts": `${word} /"/ ; export const e = process.env;` }));
    expect(r.violations.map((v) => v.kind)).toEqual(["process"]);
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

  /** A scratch engine checkout: `eng/scripts/{engine-boundary.ts,lib/main-module.ts}`, `eng/src/<files>` (no src/ at all when `src` is null),
   *  and the phone walk's inputs, `eng/package.json` + `eng/phone-subpaths.json` (1c-1; `phone` shapes or omits them), plus `bin/gate.ts`,
   *  a symlink to the copy. Every root it makes is tracked, so afterEach removes them all. */
  function checkout(src: Record<string, string> | null, phone: PhoneConfig | null = {}): { root: string; eng: string; via: string } {
    const root = realpathSync(scratchDir("engine-boundary-cli-"));
    const eng = join(root, "eng");
    mkdirSync(join(eng, "scripts/lib"), { recursive: true });
    copyFileSync(GATE, join(eng, "scripts/engine-boundary.ts"));
    copyFileSync(HELPER, join(eng, "scripts/lib/main-module.ts"));
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
    expect(here.stdout, "the phone rule failed, so neither the boundary PASS nor the phone-safe line may print").not.toMatch(/PASS|phone-safe:/);
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

  it("a phone-safety violation does not hide a clean boundary line count, and a clean phone walk does not hide a boundary violation", () => {
    const { eng, via } = checkout({ ...CLEAN, "deep/er/nested/bad.ts": NESTED_BAD });
    const r = run(via, eng);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout, "the phone walk was clean, and says so").toContain(`phone-safe: ${WALKED} modules walked`);
    expect(r.stdout).toContain("1 boundary violation(s)");
  }, spawnBudget(1));

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
    const cfg = JSON.parse(readFileSync(join(ENGINE, "phone-subpaths.json"), "utf8")) as { closure: { modules: number } };
    for (const cwd of [ENGINE, dirname(ENGINE.replace(/[\\/]$/, ""))]) {
      const r = run(GATE, cwd);
      expect(r.status, `${cwd}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`phone-safe: ${cfg.closure.modules} modules walked`);
      expect(r.stderr).toBe("");
    }
  }, spawnBudget(2));
});
