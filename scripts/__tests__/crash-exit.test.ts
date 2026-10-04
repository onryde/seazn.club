// scripts/lib/crash-exit.ts (final batch F-6; lifted out of the harness by
// CL-R4): a preload that turns an import-time crash into exit 3 — "3 = crash,
// never 1", because 1 reads as a verdict. A failure to LOAD a CLI (a parse
// error under strip-types, a missing export, a module that throws while it
// evaluates) happens before any CLI code runs, and node exits 1 without it.
// The empty case first: a module that loads and sets nothing exits 0, and a
// verdict (exitCode 1) stays 1 — the preload never turns a verdict into 3.
//
// Here, with the module (review m-3), it is driven through reference:boundary
// — the repo gate packages/reference's test spawns as its package script.
// The matrix CLIs' own scripts are pinned and spawned by the harness
// (tools/matrix/__tests__/crash-exit.test.ts): nothing under scripts/ may
// name or run them (ruling 56; tools-import-guard.test.ts).
// Single-sport reason: no sport is involved — this is process plumbing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The preload, as every package script names it. */
const PRELOAD = "./scripts/lib/crash-exit.ts";
const GATE = "reference:boundary";
const CLI = "scripts/reference-boundary.ts";
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

// One spawn's cap, and the budget derived from it (AGENTS.md class 20). The
// harness keeps the same pair in tools/matrix/__tests__/spawn-budget.ts, which
// scripts/ may not import.
const SPAWN_MS = 25_000;
const SLACK_MS = 5_000;
const budget = (spawns: number) => spawns * SPAWN_MS + SLACK_MS;
let spawned = 0;
const run = (argv: readonly string[]) => {
  spawned++;
  return spawnSync(process.execPath, [...argv], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
};

/** The gate's package script argv (after `node`), its CLI swapped for `file` when given. */
function argvOf(file?: string): string[] {
  const words = (scripts[GATE] ?? "").split(" ");
  expect(words[0], `${GATE}: runs node`).toBe("node");
  expect(words.at(-1), `${GATE}: runs ${CLI}`).toBe(CLI);
  return [...words.slice(1, -1), file ?? CLI];
}

const dir = mkdtempSync(join(tmpdir(), "scripts-crash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, text: string): string => { writeFileSync(join(dir, name), text); return join(dir, name); };
put("enum.ts", "enum E { A }\nexport const x = E.A;\n");
put("exports-a.mjs", "export const a = 1;\n");
put("throws.mjs", "throw new Error(\"test: this module throws while it evaluates\");\n");
/** [what, a main, the exit through the preload]. */
const MAINS: readonly (readonly [string, string, number])[] = [
  ["a parse error under strip-types", put("main-parse.ts", "import { x } from \"./enum.ts\";\nconsole.log(x);\n"), 3],
  ["a missing export (a link error)", put("main-link.mjs", "import { nope } from \"./exports-a.mjs\";\nconsole.log(nope);\n"), 3],
  ["a module that throws while it evaluates", put("main-eval.mjs", "import \"./throws.mjs\";\n"), 3],
  ["a clean load (the empty case)", put("main-clean.mjs", "export {};\n"), 0],
  ["a verdict (exitCode 1)", put("main-verdict.mjs", "process.exitCode = 1;\n"), 1],
];

describe("crash-exit.ts: an import-time crash exits 3, a verdict stays a verdict", () => {
  it("every package script that preloads names it at its one path, scripts/lib — the gate among them; nothing preloads anything else", () => {
    expect(existsSync(join(REPO, PRELOAD)), PRELOAD).toBe(true);
    const preloads = Object.entries(scripts).filter(([, cmd]) => /\s--import[\s=]/.test(cmd));
    for (const [key, cmd] of preloads) {
      const values = [...cmd.matchAll(/\s--import[\s=](\S+)/g)].map((m) => m[1]);
      expect({ key, values }).toEqual({ key, values: [PRELOAD] });
    }
    // The gate, plus the harness CLIs (pinned by name in the harness's own test).
    expect(preloads.map(([key]) => key)).toContain(GATE);
    expect(preloads.length).toBeGreaterThanOrEqual(8);
    expect(scripts[GATE]).toBe(`node --experimental-strip-types --import ${PRELOAD} ${CLI}`);
  });

  it(`${GATE}'s flags: each load failure exits 3, naming the crash; a clean load exits 0; a verdict stays 1`, () => {
    spawned = 0;
    let checked = 0;
    for (const [what, main, code] of MAINS) {
      const r = run(argvOf(main));
      expect({ what, status: r.status }, r.stderr).toEqual({ what, status: code });
      if (code === 3) expect(r.stderr, what).toMatch(/: crashed — nothing caught /);
      else expect(r.stderr, what).not.toContain("crashed");
      checked++;
    }
    expect(checked).toBe(MAINS.length);
    expect(spawned).toBe(MAINS.length);
  }, budget(MAINS.length));

  it(`${GATE}, run as its package script, still answers a usage error with its own exit 2 — the preload changes no verdict`, () => {
    spawned = 0;
    const r = run([...argvOf(), "a", "b"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).not.toContain("crashed");
    expect(spawned).toBe(1);
  }, budget(1));
});
