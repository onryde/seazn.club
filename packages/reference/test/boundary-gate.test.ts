// The reference boundary gate (ruling 27). State transitions and the empty
// case first: a src with no .ts files (the CLI refuses it); the real package
// (clean, scanned > 0); each allowed form; each refused form by name; the ten
// runtime-load bypasses review I-1 measured against the old line judge; and
// the CLI itself, SPAWNED, going clean → violated → clean again on a scratch
// copy of the real src — the deliberate-violation proof, run in CI, never a
// violating file committed into packages/reference/src.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReferenceBoundary, engineDir, parseDiagnosticsOf } from "../../../scripts/reference-boundary.ts";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const ENGINE = resolve(REPO, "packages", "engine");
const CLI = resolve(REPO, "scripts", "reference-boundary.ts");
function src(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "w1b-ref-"));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const reasons = (root: string) => { try { return checkReferenceBoundary(root).violations.map((v) => `${v.specifier}: ${v.reason}`); } finally { rmSync(root, { recursive: true, force: true }); } };
/** `line specifier: reason` per violation; `setup` may add symlinks before the scan. */
function judged(files: Record<string, string>, setup?: (root: string) => void): string[] {
  const root = src(files);
  try {
    setup?.(root);
    return checkReferenceBoundary(root).violations.map((v) => `${v.line} ${v.specifier}: ${v.reason}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
/** `npm run reference:boundary`'s own flags, read from package.json (final batch F-6: they preload crash-exit.ts). */
const SCRIPT = ((JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["reference:boundary"] ?? "").split(" ");
/** The CLI exactly as `npm run reference:boundary` starts it, optionally on another src dir. */
const gate = (args: string[], cli = CLI) => spawnSync(process.execPath, [...SCRIPT.slice(1, -1), cli, ...args], { cwd: REPO, encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
/** The CLI with no preload, as `node --experimental-strip-types scripts/reference-boundary.ts` starts it. */
const bare = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { cwd: REPO, encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
/** The package's non-test .ts sources, counted from the tree — never from the gate. */
function sources(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) n += sources(p);
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) n++;
  }
  return n;
}
// Every reason spelled out here, never imported from the gate.
const VALUE_IMPORT = "engine imports must be `import type { … }` statements (a value import couples the oracle to the code it checks)";
const INLINE = "inline `{ type X }` is refused — strip-types keeps it as a runtime import of the engine";
const OTHER_ENGINE = "only @seazn/engine/core types may be imported";
const TRAP3 = "relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)";
const INTO_ENGINE = "relative import resolves into packages/engine — the oracle must not load the code it checks";
const NOT_ALLOWED = "not an allowed import (relative within src, or @seazn/engine/core types)";
const DYNAMIC = "dynamic import() is refused";
const RELAY = "relative import of a test file is refused — tests are not scanned, so a test could relay the engine";
const TOKEN = "nondeterministic token (the reference must answer the same way every time)";
const IMPORT_EQUALS = "`import … = require()` is refused";
const TRIPLE_SLASH = "triple-slash reference is refused (use `import type`)";
const SYMLINK = "symlink in src is refused — the gate judges real files only";
const EVAL = "code built from a string (eval / Function) is refused — the gate cannot judge it";
const LOADER_REF = "a module loader named outside a call is refused — an alias would hide the call";
const GLOBAL_REF = "the global object named outside a member read is refused — an alias would hide a clock or entropy read";
const NOT_TS = "a relative import must name its .ts file (the house strip-types rule) — an extensionless or suffixed specifier hides which file loads";
const CONSTRUCTOR_REF = "a `.constructor` read is refused — it reaches Function without naming it";

describe("reference boundary gate (ruling 27: statement-form import type from @seazn/engine/core only)", () => {
  it("empty case first: a src dir with no .ts files scans zero — the CLI refuses that", () => {
    const root = src({ "README.md": "x" });
    try { expect(checkReferenceBoundary(root).scanned).toBe(0); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("the real package is clean, and scanned > 0 files", () => {
    const r = checkReferenceBoundary(join(PKG, "src"));
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.scanned).toBe(sources(join(PKG, "src")));
    expect(r.violations).toEqual([]);
  });
  it("allowed: statement import type / export type from @seazn/engine/core, and relative imports inside src", () => {
    expect(reasons(src({
      "a.ts": `import type { MatchOutcome } from "@seazn/engine/core";\nexport type { StageKind } from "@seazn/engine/core";\nimport { b } from "./b.ts";\n`,
      "b.ts": "export const b = 1;\n",
    }))).toEqual([]);
  });
  it("allowed: every erased statement form — multi-line, namespace, default, export type *, a type-level import(), and a subdirectory import", () => {
    expect(reasons(src({
      "a.ts": [
        `import type {`,
        `  MatchOutcome,`,
        `  StageKind,`,
        `} from "@seazn/engine/core";`,
        `import type * as E from "@seazn/engine/core";`,
        `export type * from "@seazn/engine/core";`,
        `export type * as F from "@seazn/engine/core";`,
        `export type K = import("@seazn/engine/core").StageKind;`,
        `import { c } from "./sub/c.ts";`,
        `export type Both = E.MatchOutcome | MatchOutcome | StageKind;`,
        `export { c };`,
      ].join("\n"),
      "sub/c.ts": `import type { MatchOutcome } from "@seazn/engine/core";\nexport const c: MatchOutcome | null = null;\n`,
    }))).toEqual([]);
  });
  it("refused, each by name", () => {
    const got = reasons(src({ "a.ts": [
      `import { buildStandings } from "@seazn/engine/core";`,
      `import { type MatchOutcome } from "@seazn/engine/core";`,
      `import type { X } from "@seazn/engine/competition";`,
      `import type { P } from "../../../scripts/bench/lib/pack-schema.ts";`,
      `import { s } from "../../../apps/web/src/lib/match-rules.ts";`,
      `import postgres from "postgres";`,
      `const m = await import("./b.ts");`,
      `const t = Date.now();`,
    ].join("\n") }));
    expect(got).toEqual([
      `@seazn/engine/core: ${VALUE_IMPORT}`,
      `@seazn/engine/core: ${INLINE}`,
      `@seazn/engine/competition: ${OTHER_ENGINE}`,
      `../../../scripts/bench/lib/pack-schema.ts: ${TRAP3}`,
      `../../../apps/web/src/lib/match-rules.ts: ${TRAP3}`,
      `postgres: ${NOT_ALLOWED}`,
      `./b.ts: ${DYNAMIC}`,
      `Date.now: ${TOKEN}`,
    ]);
  });
  it("refused: the other shapes a runtime engine import can take", () => {
    const got = reasons(src({ "a.ts": [
      `import { StageKind } from "@seazn/engine/core";`,
      `import {`,
      `  buildStandings,`,
      `} from "@seazn/engine/core";`,
      `export * from "@seazn/engine/core";`,
      `export { StageKind as K } from "@seazn/engine/core";`,
      `import "@seazn/engine/core";`,
      `const r = require("@seazn/engine/core");`,
      `import type { Z } from "@seazn/engine";`,
      `import type { Y } from "../outside.ts";`,
    ].join("\n") }));
    expect(got).toEqual([
      `@seazn/engine/core: ${VALUE_IMPORT}`,
      `@seazn/engine/core: ${VALUE_IMPORT}`,
      `@seazn/engine/core: ${VALUE_IMPORT}`,
      `@seazn/engine/core: ${VALUE_IMPORT}`,
      "@seazn/engine/core: side-effect import is refused",
      "@seazn/engine/core: require() is refused",
      `@seazn/engine: ${OTHER_ENGINE}`,
      `../outside.ts: ${TRAP3}`,
    ]);
  });
  it("refused: the remaining statement shapes — mixed and empty clauses, inline re-export, import-equals, triple-slash, a type-level import() of another subpath", () => {
    expect(judged({ "a.ts": [
      `/// <reference types="@seazn/engine" />`,
      `/// <reference path="./b.ts" />`,
      `/// <reference lib="es2022" />`,
      `import { A, type B } from "@seazn/engine/core";`,
      `import {} from "@seazn/engine/core";`,
      `export { type StageKind } from "@seazn/engine/core";`,
      `import X = require("@seazn/engine/core");`,
      `export import E = require("@seazn/engine/core");`,
      `import type T = require("@seazn/engine/core");`,
      `export type C = import("@seazn/engine/competition").Anything;`,
      `import type { G } from "@seazn/engine/core/../sports";`,
      `import type { H } from "@seazn/engine-extras";`,
      `import D, { type I } from "@seazn/engine/core";`,
      `export {} from "@seazn/engine/core";`,
      `export { A, B, X, T, G, H, D, I };`,
    ].join("\n"), "b.ts": "export {};\n" })).toEqual([
      `1 @seazn/engine: ${TRIPLE_SLASH}`,
      `2 ./b.ts: ${TRIPLE_SLASH}`,
      `3 es2022: ${TRIPLE_SLASH}`,
      `4 @seazn/engine/core: ${VALUE_IMPORT}`,
      `5 @seazn/engine/core: ${VALUE_IMPORT}`,
      `6 @seazn/engine/core: ${INLINE}`,
      `7 @seazn/engine/core: ${IMPORT_EQUALS}`,
      `8 @seazn/engine/core: ${IMPORT_EQUALS}`,
      `9 @seazn/engine/core: ${IMPORT_EQUALS}`,
      `10 @seazn/engine/competition: ${OTHER_ENGINE}`,
      `11 @seazn/engine/core/../sports: ${OTHER_ENGINE}`,
      `12 @seazn/engine-extras: ${NOT_ALLOWED}`,
      `13 @seazn/engine/core: ${VALUE_IMPORT}`,
      `14 @seazn/engine/core: ${VALUE_IMPORT}`,
    ]);
  });
  it("refused: a module loader reached without a plain call — a property read, a destructure, a string key, a string-keyed call", () => {
    expect(judged({ "a.ts": [
      `const g = process.getBuiltinModule;`,
      `const { getBuiltinModule: h } = process;`,
      `export const r: unknown = Reflect.get(process, "getBuiltinModule");`,
      `export const e: unknown = process["getBuiltinModule"]("node:module");`,
      `export { g, h };`,
    ].join("\n") })).toEqual([
      `1 getBuiltinModule: ${LOADER_REF}`,
      `2 getBuiltinModule: ${LOADER_REF}`,
      `3 getBuiltinModule: ${LOADER_REF}`,
      "4 node:module: getBuiltinModule() is refused",
    ]);
  });
  it("refused: code built from a string, which no static judge can read", () => {
    expect(judged({ "a.ts": `export const v: unknown = eval("1");\nexport const F = new Function("return 1");\nexport const G = Function("return 1");\n` })).toEqual([
      `1 eval: ${EVAL}`,
      `2 Function: ${EVAL}`,
      `3 Function: ${EVAL}`,
    ]);
  });
  it("an export with no `from` of its own never borrows a later statement's: clean, and a later value import is judged ONCE, on its own line", () => {
    const body = [
      `export const A: readonly string[] = Object.freeze([]);`,
      `export class B extends Error {`,
      `  constructor() {`,
      `    super("b");`,
      `  }`,
      `}`,
      `export function c(): number {`,
      `  return 1;`,
      `}`,
      `import type { MatchOutcome } from "@seazn/engine/core";`,
      `export type D = MatchOutcome;`,
    ];
    expect(reasons(src({ "a.ts": body.join("\n") }))).toEqual([]);
    expect(judged({ "a.ts": [...body, `import { buildStandings } from "@seazn/engine/core";`].join("\n") })).toEqual([`12 @seazn/engine/core: ${VALUE_IMPORT}`]);
  });
  it("a long multi-line value import is one statement, judged whatever its length", () => {
    const names = Array.from({ length: 25 }, (_, n) => `  n${n},`);
    expect(judged({ "a.ts": [`import {`, ...names, `} from "@seazn/engine/core";`].join("\n") })).toEqual([`1 @seazn/engine/core: ${VALUE_IMPORT}`]);
  });
  it("two statements on one line are each judged: the type import passes, the value import is refused", () => {
    expect(reasons(src({ "a.ts": `import type { A } from "@seazn/engine/core"; import { b } from "@seazn/engine/core";\nexport type { A };\nexport { b };\n` }))).toEqual([
      `@seazn/engine/core: ${VALUE_IMPORT}`,
    ]);
  });
  it("refused: a source file the gate cannot scan (.mts/.tsx/.js …) — its imports would go unjudged", () => {
    const root = src({ "a.ts": "export const a = 1;\n", "b.mts": `import { StageKind } from "@seazn/engine/core";\n`, "sub/c.js": "export const c = 1;\n", "README.md": "x" });
    try {
      const r = checkReferenceBoundary(root);
      expect(r.scanned).toBe(1);
      expect(r.violations.map((v) => `${v.file}: ${v.reason}`)).toEqual([
        "b.mts: not a .ts source — the gate scans .ts only, so this file's imports would go unjudged",
        "sub/c.js: not a .ts source — the gate scans .ts only, so this file's imports would go unjudged",
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("guards on the gate's own assumptions: a parse without a parseDiagnostics array, and a missing engine dir, each throw rather than pass", () => {
    expect(() => parseDiagnosticsOf({})).toThrow(/parseDiagnostics is not an array/);
    expect(() => parseDiagnosticsOf(null)).toThrow(/parseDiagnostics is not an array/);
    expect(parseDiagnosticsOf({ parseDiagnostics: [] })).toEqual([]);
    expect(() => engineDir(join(tmpdir(), "w1b-ref-no-such-engine"))).toThrow(/does not exist/);
    expect(engineDir()).toBe(realpathSync(ENGINE));
  });
  it("refused: a file that does not parse — never judged on the parser's recovered tree", () => {
    const root = src({ "a.ts": `import { buildStandings from "@seazn/engine/core";\nexport const x = buildStandings;\n`, "b.ts": "export const b = 1;\n" });
    try {
      const r = checkReferenceBoundary(root);
      expect(r.scanned).toBe(2);
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0]?.file).toBe("a.ts");
      expect(r.violations[0]?.reason).toMatch(/^does not parse \(.+\) — refused, never judged on a recovered tree$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("review I-1: each runtime-load bypass the line judge passed is refused", () => {
  // Each shape passed the pre-AST gate with 0 violations while loading
  // @seazn/engine/core at runtime (measured by the review).
  const CASES: ReadonlyArray<readonly [string, Record<string, string>, readonly string[]]> = [
    ["(1) a comment between from and the specifier", { "a.ts": `import { buildStandings } from /* c */ "@seazn/engine/core";\nexport { buildStandings };\n` }, [`1 @seazn/engine/core: ${VALUE_IMPORT}`]],
    ["(2) `//` inside an earlier string on the same line", { "a.ts": `const u = "//"; import { buildStandings } from "@seazn/engine/core";\nexport { u, buildStandings };\n` }, [`1 @seazn/engine/core: ${VALUE_IMPORT}`]],
    ["(3a) an ASI type alias launders a comment-led import", { "a.ts": `export type Foo = string\n/* c */ import { buildStandings } from "@seazn/engine/core";\nexport { buildStandings };\n` }, [`2 @seazn/engine/core: ${VALUE_IMPORT}`]],
    ["(3b) an ASI type alias launders an import after other statements", { "a.ts": `export type Foo = string\nconst y = 2; export { y }; import { buildStandings } from "@seazn/engine/core"\nexport { buildStandings }\n` }, [`2 @seazn/engine/core: ${VALUE_IMPORT}`]],
    ["(4) a relay through an excluded .test.ts file", { "a.ts": `import { buildStandings } from "./relay.test.ts";\nexport const f = buildStandings;\n`, "relay.test.ts": `export { buildStandings } from "@seazn/engine/core";\n` }, [`1 ./relay.test.ts: ${RELAY}`]],
    ["(5) import() of a template literal", { "a.ts": "export const m = import(`@seazn/engine/core`);\n" }, [`1 @seazn/engine/core: ${DYNAMIC}`]],
    ["(6) import() of a computed specifier", { "a.ts": `const s = "@seazn/engine/core";\nexport const m = import(s);\n` }, [`2 <computed>: ${DYNAMIC}`]],
    ["(7) import() with a comment before the specifier", { "a.ts": `export const m = import(/* c */ "@seazn/engine/core");\n` }, [`1 @seazn/engine/core: ${DYNAMIC}`]],
    ["(8) import() with the specifier on the next line", { "a.ts": `export const m = import(\n  "@seazn/engine/core"\n);\n` }, [`1 @seazn/engine/core: ${DYNAMIC}`]],
    ["(9) `//` in an earlier string, then an awaited import()", { "a.ts": `const u = "http://x"; const m = await import("@seazn/engine/core");\nexport { u, m };\n` }, [`1 @seazn/engine/core: ${DYNAMIC}`]],
    ["(10) process.getBuiltinModule(…).createRequire(…)(…), one chain", { "a.ts": `export const e: unknown = process.getBuiltinModule("node:module").createRequire(import.meta.url)("@seazn/engine/core");\n` }, [`1 node:module: getBuiltinModule() is refused`, `1 <computed>: createRequire() is refused`]],
    ["(10b) the same through a destructured createRequire", { "a.ts": `const { createRequire } = process.getBuiltinModule("node:module");\nexport const e: unknown = createRequire(import.meta.url)("@seazn/engine/core");\n` }, [`1 createRequire: ${LOADER_REF}`, `1 node:module: getBuiltinModule() is refused`, `2 <computed>: createRequire() is refused`]],
  ];
  it.each(CASES)("%s", (_label, files, expected) => {
    expect(judged(files)).toEqual(expected);
  });
  it("the sweep above is not vacuous: ten measured bypasses, every one refused", () => {
    expect(CASES.map(([l]) => l.replace(/^\((\d+)[ab]?\).*/, "$1")).filter((v, i, a) => a.indexOf(v) === i)).toHaveLength(10);
    let refused = 0;
    for (const [, files] of CASES) if (judged(files).length > 0) refused++;
    expect(refused).toBe(CASES.length);
  });
  it("(11) a symlink in src — to an engine file or an engine directory — is refused, and the import through it resolves into the engine", () => {
    const file = judged({ "a.ts": `import { x } from "./eng.ts";\nexport { x };\n` }, (root) => symlinkSync(join(ENGINE, "src", "core", "clock.ts"), join(root, "eng.ts")));
    expect(file).toEqual([`1 ./eng.ts: ${INTO_ENGINE}`, `1 eng.ts: ${SYMLINK}`]);
    // Line 2 names a file that does not exist: it is judged by where its
    // path lands (the realpath of its nearest existing ancestor), so a
    // missing file behind the link is still the engine.
    const dir = judged({ "a.ts": `import type { C } from "./core/index.ts";\nimport type { N } from "./core/not-there.ts";\nexport type { C, N };\n` }, (root) => symlinkSync(join(ENGINE, "src", "core"), join(root, "core")));
    expect(dir).toEqual([`1 ./core/index.ts: ${INTO_ENGINE}`, `2 ./core/not-there.ts: ${INTO_ENGINE}`, `1 core: ${SYMLINK}`]);
  });
  it("the positive pair: a relative import of a file not (yet) in src is judged by its path — inside src, allowed", () => {
    expect(judged({ "a.ts": `import type { M } from "./sub/missing.ts";\nexport type { M };\n` })).toEqual([]);
  });
});

describe("containment is by path SEGMENT, not by string prefix (review M-1)", () => {
  it("a sibling whose name only starts with the src dir's name is outside src", () => {
    const base = mkdtempSync(join(tmpdir(), "w1b-ref-sib-"));
    try {
      for (const [p, t] of Object.entries({ "src/a.ts": `import { x } from "../src-x/b.ts";\nimport { y } from "./in.ts";\nexport { x, y };\n`, "src/in.ts": "export const y = 1;\n", "src-x/b.ts": "export const x = 1;\n" })) {
        mkdirSync(dirname(join(base, p)), { recursive: true });
        writeFileSync(join(base, p), t);
      }
      expect(checkReferenceBoundary(join(base, "src")).violations.map((v) => `${v.specifier}: ${v.reason}`)).toEqual([`../src-x/b.ts: ${TRAP3}`]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("a sibling of packages/engine whose name only starts with `engine` is not the engine — and the engine itself is", () => {
    const root = src({});
    try {
      // From the REAL root: node resolves a relative import from the file's
      // real path, and the tmp dir is a symlink on macOS (/var → /private/var).
      const real = realpathSync(root);
      const extras = relative(real, join(REPO, "packages", "engine-extras", "x.ts"));
      const engine = relative(real, join(ENGINE, "src", "core", "index.ts"));
      writeFileSync(join(root, "a.ts"), `import type { X } from "${extras}";\nimport type { Y } from "${engine}";\nexport type { X, Y };\n`);
      expect(checkReferenceBoundary(root).violations.map((v) => `${v.line}: ${v.reason}`)).toEqual([`1: ${TRAP3}`, `2: ${INTO_ENGINE}`]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("nondeterministic tokens are judged on the syntax tree (review M-2)", () => {
  it("refused: every clock and entropy read, however it is spelled", () => {
    expect(judged({ "a.ts": [
      `export const a = Date.now ();`,
      `export const b = new Date;`,
      `export const c = performance.now();`,
      `export const d = crypto.randomUUID();`,
      `export const e = Math["random"]();`,
      `export const f = globalThis.Date.now();`,
      `export const g = Date();`,
      `export const h = new Date();`,
      `export const i = process.hrtime.bigint();`,
    ].join("\n") })).toEqual([
      `1 Date.now: ${TOKEN}`,
      `2 new Date: ${TOKEN}`,
      `3 performance.now: ${TOKEN}`,
      `4 crypto.randomUUID: ${TOKEN}`,
      `5 Math.random: ${TOKEN}`,
      `6 Date.now: ${TOKEN}`,
      `7 Date(): ${TOKEN}`,
      `8 new Date: ${TOKEN}`,
      `9 process.hrtime: ${TOKEN}`,
    ]);
  });
  it("the positive pair: a Date built from an argument, Date.UTC, and other Math members are deterministic — clean", () => {
    expect(judged({ "a.ts": `export const a = new Date(0);\nexport const b = Date.UTC(2026, 0, 1);\nexport const c = Math.max(1, 2);\nexport const d: Date | null = null;\n` })).toEqual([]);
  });
  it("final batch FB-2: a member NAMED like a global is no token — a FIDE performance rating reads clean", () => {
    // Review RR-4: the owner was the rightmost name, so `r.performance.rating`
    // (a tournament performance rating, a Swiss tiebreak) read as the clock.
    expect(judged({ "a.ts": [
      `interface Row { performance: { rating: number }; crypto: { id: string }; Date: { now: number }; Math: { random: number } }`,
      `export const f = (r: Row) => [r.performance.rating, r.crypto.id, r.Date.now, r.Math.random, r["performance"]["rating"]];`,
      `export const g = (r: { stats: Row }) => r.stats.performance.rating;`,
      `export const h = { global: 1, globalThis: 2 };`,
      `export const i = (r: { global: number }) => r.global;`,
      `export const k = (m: { Date: new () => object }) => new m.Date();`,
    ].join("\n") })).toEqual([]);
  });
  it("…while the global itself stays refused, through globalThis and global too — and the global object may not be aliased", () => {
    expect(judged({ "a.ts": [
      `export const a = globalThis.performance.now();`,
      `export const b = globalThis["crypto"].randomUUID();`,
      `export const c = global.Math.random();`,
      `const g = globalThis;`,
      `export const d = Reflect.get(global, "performance");`,
      `export const e = g;`,
    ].join("\n") })).toEqual([
      `1 performance.now: ${TOKEN}`,
      `2 crypto.randomUUID: ${TOKEN}`,
      `3 Math.random: ${TOKEN}`,
      `4 globalThis: ${GLOBAL_REF}`,
      `5 global: ${GLOBAL_REF}`,
    ]);
  });
});

describe("final batch FB-9: the three escapes task 12 re-review measured (RR-1..RR-3)", () => {
  it("RR-1: a relative specifier that does not end in .ts is refused — the extensionless and suffixed relays among them", () => {
    expect(judged({
      "a.ts": [
        `import { buildStandings } from "./relay.test";`,
        `import { raw } from "./relay.test.ts?raw";`,
        `import { b } from "./b";`,
        `import type { C } from "./sub";`,
        `import { d } from "./sub/";`,
        `export { buildStandings, raw, b, d };`,
        `export type { C };`,
      ].join("\n"),
      "relay.test.ts": `export { buildStandings } from "@seazn/engine/core";\n`,
      "b.ts": "export const b = 1;\n",
      "sub/index.ts": "export type C = 1;\nexport const d = 1;\n",
    })).toEqual([
      `1 ./relay.test: ${NOT_TS}`,
      `2 ./relay.test.ts?raw: ${NOT_TS}`,
      `3 ./b: ${NOT_TS}`,
      `4 ./sub: ${NOT_TS}`,
      `5 ./sub/: ${NOT_TS}`,
    ]);
  });
  it("RR-1, the positive pair: a relative .ts import inside src stays clean — a `.ts` inside the name is no suffix", () => {
    expect(judged({ "a.ts": `import { b } from "./b.ts";\nimport type { T } from "./x.types.ts";\nexport { b };\nexport type { T };\n`, "b.ts": "export const b = 1;\n", "x.types.ts": "export type T = 1;\n" })).toEqual([]);
  });
  it("RR-2: Function reached through `.constructor` — arrow, async function, element access — is refused", () => {
    expect(judged({ "a.ts": [
      `const F = (() => {}).constructor;`,
      `const A = Object.getPrototypeOf(async function () {}).constructor;`,
      `const G = (function () {})["constructor"];`,
      `export { F, A, G };`,
    ].join("\n") })).toEqual([
      `1 constructor: ${CONSTRUCTOR_REF}`,
      `2 constructor: ${CONSTRUCTOR_REF}`,
      `3 constructor: ${CONSTRUCTOR_REF}`,
    ]);
  });
  it("RR-3: Temporal.Now, and a Date whose arguments are only a spread (possibly none), are nondeterministic — refused", () => {
    expect(judged({ "a.ts": [
      `export const a = Temporal.Now.instant();`,
      `export const b = new Date(...[]);`,
      `const xs: number[] = [];`,
      `export const c = new Date(...xs);`,
      `export const d = globalThis.Temporal.Now.plainDateISO();`,
    ].join("\n") })).toEqual([
      `1 Temporal.Now: ${TOKEN}`,
      `2 new Date: ${TOKEN}`,
      `4 new Date: ${TOKEN}`,
      `5 Temporal.Now: ${TOKEN}`,
    ]);
  });
  it("RR-3, the positive pair: a Date given a fixed argument beside a spread, and Temporal's pure constructors, are clean", () => {
    expect(judged({ "a.ts": `const xs: number[] = [1];\nexport const a = new Date(2026, ...xs);\nexport const b = Temporal.PlainDate.from("2026-09-29");\n` })).toEqual([]);
  });
});

describe("reference:boundary CLI (spawned — its exit code is the CI verdict)", () => {
  it("CLI refuses zero: a src dir with no .ts files exits non-zero and says so", () => {
    const root = src({ "README.md": "x" });
    try {
      const r = gate([root]);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("reference:boundary scanned ZERO files — refusing");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("CLI refuses zero through a symlinked path too — never a silent 0 (the old main-module idiom loaded, ran nothing and exited 0)", () => {
    const root = src({ "README.md": "x" });
    try {
      const via = join(root, "gate-link.ts");
      symlinkSync(CLI, via);
      const r = gate([join(root, "empty")], via);
      expect(r.stderr.trim(), "nothing on stderr — main never ran").not.toBe("");
      expect(r.status, r.stderr).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("with no argument it gates the real packages/reference/src: clean, exit 0, and it counts the files it read", () => {
    const r = gate([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`reference:boundary: ${sources(join(PKG, "src"))} files, 0 violation(s)`);
  });
  it("more than one argument is refused as usage (exit 2), never read as a src dir; the usage states every exit, zero files scanned among the 1s (final batch F-6)", () => {
    const r = gate([join(PKG, "src"), join(PKG, "src")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
    expect(r.stderr).toContain("exit 0 clean; 1 on a violation, or on zero files scanned (a vacuous verdict); 2 on usage; 3 on a crash");
  });
  it("final batch F-6: a scan that crashes (a source it cannot read) exits 3, naming the crash — never 1, which reads as a violation; bare, without the preload, too", () => {
    const root = src({ "ok.ts": "export const a = 1;\n", "locked.ts": "export const b = 2;\n" });
    try {
      chmodSync(join(root, "locked.ts"), 0o000);
      // The premise: the file really cannot be read here (a root user could).
      let unreadable = false;
      try { readFileSync(join(root, "locked.ts")); } catch { unreadable = true; }
      expect(unreadable, "locked.ts is readable — the crash cannot be witnessed as this user").toBe(true);
      let checked = 0;
      for (const r of [gate([root]), bare([root])]) {
        expect(r.status, r.stderr).toBe(3);
        expect(r.stderr).toMatch(/reference:boundary crashed — .*EACCES/);
        expect(r.stdout).not.toContain("violation(s)");
        checked++;
      }
      expect(checked).toBe(2);
    } finally { chmodSync(join(root, "locked.ts"), 0o644); rmSync(root, { recursive: true, force: true }); }
  });
  it("deliberate violation: a scratch copy of the real src goes clean → violated (exit 1, naming the file and line) → clean again", () => {
    const root = mkdtempSync(join(tmpdir(), "w1b-ref-proof-"));
    try {
      cpSync(join(PKG, "src"), root, { recursive: true });
      const index = join(root, "index.ts");
      const original = readFileSync(index, "utf8");
      expect(gate([root]).status).toBe(0);
      const violated = `${original}\nimport { buildStandings } from "@seazn/engine/core";\n`;
      writeFileSync(index, violated);
      const line = violated.split("\n").findIndex((l) => l.startsWith("import { buildStandings }")) + 1;
      expect(line).toBeGreaterThan(1);
      const bad = gate([root]);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(`FAIL index.ts:${line} @seazn/engine/core — ${VALUE_IMPORT}`);
      expect(bad.stdout).toContain("1 violation(s)");
      writeFileSync(index, original);
      const again = gate([root]);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stderr).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
