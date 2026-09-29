// The reference boundary gate (ruling 27). State transitions and the empty
// case first: a src with no .ts files (the CLI refuses it); the real package
// (clean, scanned > 0); each allowed form; each refused form by name; and the
// CLI itself, SPAWNED, going clean → violated → clean again on a scratch copy
// of the real src — the deliberate-violation proof, run in CI, never a
// violating file committed into packages/reference/src.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReferenceBoundary } from "../../../scripts/reference-boundary.ts";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(PKG, "..", "..", "scripts", "reference-boundary.ts");
function src(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "w1b-ref-"));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const reasons = (root: string) => { try { return checkReferenceBoundary(root).violations.map((v) => `${v.specifier}: ${v.reason}`); } finally { rmSync(root, { recursive: true, force: true }); } };
/** The CLI exactly as `npm run reference:boundary` starts it, optionally on another src dir. */
const gate = (args: string[], cli = CLI) => spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd: resolve(PKG, "..", ".."), encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
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
const VALUE_IMPORT = "engine imports must be `import type { … }` statements (a value import couples the oracle to the code it checks)";

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
  it("allowed: a multi-line import type statement, and a relative import into a subdirectory", () => {
    expect(reasons(src({
      "a.ts": `import type {\n  MatchOutcome,\n  StageKind,\n} from "@seazn/engine/core";\nimport { c } from "./sub/c.ts";\n`,
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
      "@seazn/engine/core: engine imports must be `import type { … }` statements (a value import couples the oracle to the code it checks)",
      "@seazn/engine/core: inline `{ type X }` is refused — strip-types keeps it as a runtime import of the engine",
      "@seazn/engine/competition: only @seazn/engine/core types may be imported",
      "../../../scripts/bench/lib/pack-schema.ts: relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)",
      "../../../apps/web/src/lib/match-rules.ts: relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)",
      "postgres: not an allowed import (relative within src, or @seazn/engine/core types)",
      "./b.ts: dynamic import() is refused",
      "Date.now(: nondeterministic token (the reference must answer the same way every time)",
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
      "@seazn/engine: only @seazn/engine/core types may be imported",
      "../outside.ts: relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)",
    ]);
  });
  it("an export with no `from` of its own never borrows a later statement's (the join stops at `;`): clean, and a later value import is judged ONCE, on its own line", () => {
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
    const root = src({ "a.ts": [...body, `import { buildStandings } from "@seazn/engine/core";`].join("\n") });
    try {
      expect(checkReferenceBoundary(root).violations.map((v) => `${v.line} ${v.specifier}: ${v.reason}`)).toEqual([`12 @seazn/engine/core: ${VALUE_IMPORT}`]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refused: an import whose `from` is out of the join's reach is refused, never skipped", () => {
    const names = Array.from({ length: 25 }, (_, n) => `  n${n},`);
    expect(reasons(src({ "a.ts": [`import {`, ...names, `} from "@seazn/engine/core";`].join("\n") }))).toEqual([
      "@seazn/engine/core: an import the gate could not judge (no import/export head within reach of its `from`) — refused, never skipped",
    ]);
  });
  it("refused: a second import statement on one line (the gate judges one statement per line, so a hidden second is a refusal, not a pass)", () => {
    expect(reasons(src({ "a.ts": `import type { A } from "@seazn/engine/core"; import { b } from "@seazn/engine/core";\n` }))).toEqual([
      "@seazn/engine/core: more than one import on a line — the gate judges one statement per line",
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
  it("more than one argument is refused as usage (exit 2), never read as a src dir", () => {
    const r = gate([join(PKG, "src"), join(PKG, "src")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
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
