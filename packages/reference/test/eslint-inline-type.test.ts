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
import { describe, expect, it } from "vitest";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESLINT = join(PKG, "node_modules", ".bin", "eslint");
type Result = { filePath: string; messages: { ruleId: string | null; message: string }[] };
function lint(code: string): { status: number | null; results: Result[]; stderr: string } {
  const r = spawnSync(ESLINT, ["--format", "json", "--stdin", "--stdin-filename", "src/index.ts"], { cwd: PKG, input: code, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, results: r.stdout.trim() === "" ? [] : (JSON.parse(r.stdout) as Result[]), stderr: r.stderr };
}

// A type-aware eslint start takes ~2.5s idle; the package's bare `vitest run`
// (the root test chain) defaults to a 5s test timeout.
describe("eslint: ruling 27's statement form is a lint error in src (review I-2)", { timeout: 60_000 }, () => {
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
