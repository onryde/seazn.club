// Each matrix CLI that shares isMainModule (scripts/lib/main-module.ts),
// started through a symlinked path, runs its main — never a silent 0 (T8 fix
// round 1, M-2). Before the fix each loaded, ran nothing and exited 0 with
// empty stderr: a fail-open --check. The module's own cases, and the engine
// boundary gate's, live beside it in scripts/__tests__/main-module.test.ts
// (CL-R4, review m-3); these stay in the harness because they spawn its CLIs.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { REGRESSIONS_PATH } from "../lib/scenario-catalogue.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "w1b-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// One CLI spawn per test; the budget derives from the spawn's cap (final batch FB-6).
const meter = new SpawnMeter(1);
beforeEach(() => meter.reset());

describe("isMainModule in the matrix CLIs: started through a symlink, each runs its main", { timeout: meter.budget }, () => {
  // Each CLI through a symlink, with an input it must refuse.
  const empty = join(dir, "empty-root");
  mkdirSync(join(empty, "tools/matrix/catalogue"), { recursive: true });
  cpSync(resolve(REPO, REGRESSIONS_PATH), join(empty, REGRESSIONS_PATH));
  const CLIS: readonly (readonly [string, string, readonly string[], number])[] = [
    ["gen-catalogue.ts", "--check on an empty catalogue: drift", ["--check", "--root", empty], 1],
    ["render.ts", "no results file: usage", [], 2],
    ["run.ts", "--bogus: usage, refused before any DB or HTTP", ["--bogus"], 2],
  ];
  it.each(CLIS)("%s (%s) started through a symlinked path runs its main and exits %i — never a silent 0", (name, _why, args, code) => {
    const via = join(dir, `link-${name}`);
    symlinkSync(resolve(REPO, "tools/matrix", name), via);
    meter.tick();
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", via, ...args], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
    expect(r.stderr.trim(), `${name}: nothing on stderr — main never ran`).not.toBe("");
    expect(r.status, r.stderr).toBe(code);
  });
});
