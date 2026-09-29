// Ruling 27 at lint time (review I-2): an inline `{ type X }` engine import is
// a lint error in packages/reference/src, not only a gate violation. The
// package's REAL eslint config is run (spawned, on stdin, linted as
// src/index.ts) — a rule present in the config but not reaching src would
// still pass a config-reading test. Positive pair: the statement form, the
// only allowed shape, lints clean under the same run. Single-sport reason: no
// sport is involved; this is a lint rule over import syntax.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESLINT = join(PKG, "node_modules", ".bin", "eslint");
type Result = { filePath: string; messages: { ruleId: string | null; message: string }[] };
// A type-aware eslint start takes ~2.5s idle; the package's bare `vitest run`
// (the root test chain) defaults to a 5s test timeout, and CI passes 30s. One
// constant sets both the spawn's cap and the test budget (final batch FB-6,
// AGENTS.md class 20): each test lints once, so its budget is one cap plus
// slack, and a hung eslint is reported as the spawn's own failure.
const LINT_MS = 60_000;
const SLACK_MS = 5_000;
let lints = 0;
beforeEach(() => { lints = 0; });
function lint(code: string): { status: number | null; results: Result[]; stderr: string } {
  if (++lints > 1) throw new Error("test: a second eslint spawn in one test — the budget covers one (LINT_MS + SLACK_MS); raise it with the count");
  const r = spawnSync(ESLINT, ["--format", "json", "--stdin", "--stdin-filename", "src/index.ts"], { cwd: PKG, input: code, encoding: "utf8", timeout: LINT_MS });
  return { status: r.status, results: r.stdout.trim() === "" ? [] : (JSON.parse(r.stdout) as Result[]), stderr: r.stderr };
}

describe("eslint: ruling 27's statement form is a lint error in src (review I-2)", { timeout: LINT_MS + SLACK_MS }, () => {
  it("the package's own eslint binary exists — a missing binary is not a pass", () => {
    expect(existsSync(ESLINT), ESLINT).toBe(true);
  });
  it("an inline `{ type X }` engine import goes red under no-import-type-side-effects", () => {
    const r = lint(`import { type StageKind } from "@seazn/engine/core";\nexport type K = StageKind;\n`);
    expect(r.results, r.stderr).toHaveLength(1);
    expect(r.results[0]?.filePath.endsWith(join("src", "index.ts"))).toBe(true);
    expect(r.results[0]?.messages.map((m) => m.ruleId)).toEqual(["@typescript-eslint/no-import-type-side-effects"]);
    expect(r.status).toBe(1);
  });
  it("the positive pair: the statement form `import type { X }` lints clean", () => {
    const r = lint(`import type { StageKind } from "@seazn/engine/core";\nexport type K = StageKind;\n`);
    expect(r.results, r.stderr).toHaveLength(1);
    expect(r.results[0]?.filePath.endsWith(join("src", "index.ts"))).toBe(true);
    expect(r.results[0]?.messages).toEqual([]);
    expect(r.status).toBe(0);
  });
});
