// The gate itself must demonstrably fail on seeded violations (PROMPT-01
// acceptance). Fixtures are written to a temp dir shaped like an engine src/.
import { spawnSync } from "node:child_process";
import { copyFileSync, globSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkEngineBoundary, scanEngineBoundary } from "../scripts/engine-boundary.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "engine-boundary-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("engine boundary gate", () => {
  it("passes on the real packages/engine/src", () => {
    dir = mkdtempSync(join(tmpdir(), "engine-boundary-")); // for afterEach
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

// The CLI, as CI and `pnpm boundary` run it (engine-split 1d-2 review). Layout-agnostic: the gate and its helper are copied into a scratch
// tree shaped like an engine checkout (`scripts/` beside `src/`), and started through a symlink, so what is proven is the gate's own
// resolution of the src/ beside it, with no reliance on this package sitting at packages/engine or on the root's scripts/lib.
describe("engine boundary gate CLI (a copy of the gate beside a scratch src/)", () => {
  const GATE = fileURLToPath(new URL("../scripts/engine-boundary.ts", import.meta.url));
  const HELPER = fileURLToPath(new URL("../scripts/lib/main-module.ts", import.meta.url));

  /** A scratch engine checkout: `eng/scripts/{engine-boundary.ts,lib/main-module.ts}` and `eng/src/<files>` (no src/ at all when `src` is null),
   *  plus `bin/gate.ts`, a symlink to the copy. `dir` is set so afterEach removes it. */
  function checkout(src: Record<string, string> | null): { root: string; eng: string; via: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "engine-boundary-cli-")));
    dir = root;
    const eng = join(root, "eng");
    mkdirSync(join(eng, "scripts/lib"), { recursive: true });
    copyFileSync(GATE, join(eng, "scripts/engine-boundary.ts"));
    copyFileSync(HELPER, join(eng, "scripts/lib/main-module.ts"));
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

  const CLEAN = { "core/ok.ts": "export const ok = 1;\n", "a/b/c/deep.ts": "export const deep = 2;\n" };
  const NESTED_BAD = 'export {};\nimport postgres from "postgres";\n';

  it("exits 1 and names a violation in a NESTED file, by its path from the working directory, and counts the files it scanned", () => {
    const { root, eng, via } = checkout({ ...CLEAN, "deep/er/nested/bad.ts": NESTED_BAD });
    const here = run(via, eng);
    expect(here.status, here.stdout + here.stderr).toBe(1);
    expect(here.stderr).toContain('FAIL  src/deep/er/nested/bad.ts:2  forbidden import "postgres" (postgres)');
    expect(here.stdout).toContain("1 boundary violation(s) in 3 files scanned");
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
});
