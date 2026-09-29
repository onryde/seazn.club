// Review Focus 2 (RF2): a local-only green. This worktree is nested under the
// main checkout, whose `node_modules/fast-check` is a stray REAL directory left
// by an old npm install. Without a root devDependency, `scripts/` resolves
// fast-check UPWARD into that stray and every model test passes here — while
// CI's fresh pnpm install has no root link and the model fails to COLLECT.
// The proof is where it resolves: this checkout's own pnpm store.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
const STORE = `${REPO}${sep}node_modules${sep}.pnpm${sep}`;
const MODEL_DIR = resolve(REPO, "scripts", "matrix", "lib", "model");
const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
const engine = JSON.parse(readFileSync(resolve(REPO, "packages", "engine", "package.json"), "utf8")) as { devDependencies?: Record<string, string> };

describe("fast-check resolves from THIS checkout (Review Focus 2)", () => {
  it("is a root devDependency on the engine's own range", () => {
    // The engine's declaration is the authority: the model must run the major the engine's properties do.
    expect(engine.devDependencies?.["fast-check"]).toMatch(/^\^3/);
    expect(pkg.devDependencies?.["fast-check"]).toBe(engine.devDependencies?.["fast-check"]);
  });

  it("scripts/ resolves it (require) inside this checkout's node_modules/.pnpm — not a parent checkout's stray copy", () => {
    const at = realpathSync(createRequire(import.meta.url).resolve("fast-check"));
    expect(at.startsWith(STORE), at).toBe(true);
  });

  it("the model's own directory resolves it the way node's ESM loader does (the path commands.ts imports through)", () => {
    // A spawned node, cwd = the model dir, so `import.meta.resolve` in `-e`
    // resolves from there — the ESM `import` condition, not the require one.
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('fast-check'))"], { cwd: MODEL_DIR, encoding: "utf8", timeout: 25_000 });
    expect(r.status, r.stderr).toBe(0);
    const at = realpathSync(fileURLToPath(r.stdout.trim()));
    expect(at.startsWith(STORE), at).toBe(true);
    expect(at).toMatch(/[\\/]lib[\\/]esm[\\/]/);
  });
});
