// Final batch F-6: every W1b CLI promises "3 = crash, never 1" (1 reads as a
// verdict: drift, a ratchet violation, a NEW failure). Inside each main that
// held; a failure to LOAD the CLI — a parse error under strip-types, a
// missing export, a module that throws while it evaluates — exited 1, because
// node fails before any CLI code runs. Each CLI's package script now preloads
// scripts/lib/crash-exit.ts (node --import), which maps such a crash to
// 3. The empty case first: a module that loads and sets nothing exits 0, and
// a verdict (exitCode 1) stays 1 — the preload never turns a verdict into 3.
// Every command is the package script as written, run for real.
// The preload left the harness for scripts/lib (CL-R4), and its own test —
// driven through reference:boundary, the repo gate it also serves — sits
// beside it in scripts/__tests__/crash-exit.test.ts. The matrix CLIs stay
// here: spawning a harness CLI is the harness's business, never scripts/'s.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PRELOAD = "./scripts/lib/crash-exit.ts";
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

/** [package script, its CLI, an argv its main refuses as usage, that exit,
 *  the arguments the script itself passes after its CLI]. W1c added
 *  matrix:browser and matrix:parity (final review m-11); W1d Task 1 added
 *  matrix:lock-check (ruling T1-b), Task 4 matrix:merge and Task 6 matrix:judge (ruling CLI-TABLES). */
const CLIS: readonly (readonly [string, string, readonly string[], number, readonly string[]])[] = [
  ["matrix:l3", "tools/matrix/run.ts", ["--bogus"], 2, []],
  ["matrix:browser", "tools/matrix/run.ts", ["--bogus"], 2, ["--driver", "browser"]],
  ["matrix:render", "tools/matrix/render.ts", [], 2, []],
  ["matrix:catalogue", "tools/matrix/gen-catalogue.ts", ["--bogus"], 2, []],
  ["matrix:single-sport", "tools/matrix/single-sport.ts", ["--bogus"], 2, []],
  ["matrix:model", "tools/matrix/model.ts", ["--bogus"], 2, []],
  ["matrix:parity", "tools/matrix/parity.ts", [], 2, []],
  ["matrix:lock-check", "tools/matrix/lock-append-only.ts", ["--bogus"], 2, []],
  ["matrix:merge", "tools/matrix/merge-shards.ts", [], 2, []],
  ["matrix:judge", "tools/matrix/judge.ts", ["--bogus"], 2, []],
];

/** The package script's own argv (after `node`), with its CLI swapped for
 *  `file` when given; the script's own trailing arguments are kept. */
function argvOf(key: string, cli: string, tail: readonly string[], file?: string): string[] {
  const words = (scripts[key] ?? "").split(" ");
  expect(words[0], `${key}: runs node`).toBe("node");
  const at = words.length - 1 - tail.length;
  expect(words[at], `${key}: runs ${cli}`).toBe(cli);
  expect(words.slice(at + 1), `${key}: passes ${tail.join(" ")}`).toEqual([...tail]);
  return [...words.slice(1, at), file ?? cli, ...tail];
}

const meter = new SpawnMeter(5);
beforeEach(() => meter.reset());
const run = (argv: readonly string[]) => {
  meter.tick();
  return spawnSync(process.execPath, [...argv], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
};

const dir = mkdtempSync(join(tmpdir(), "w1b-crash-"));
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

describe("an import-time crash exits 3 in every W1b, W1c and W1d CLI (final batch F-6, W1c final review m-11, W1d T1-b)", { timeout: meter.budget }, () => {
  it("every W1b, W1c and W1d CLI's package script preloads crash-exit.ts, then runs its CLI", () => {
    let checked = 0;
    for (const [key, cli, , , tail] of CLIS) {
      expect(scripts[key], key).toBe([`node --experimental-strip-types --import ${PRELOAD} ${cli}`, ...tail].join(" "));
      checked++;
    }
    expect(checked).toBe(10);
  });

  it.each(CLIS)("%s's flags: each load failure exits 3, naming the crash; a clean load exits 0; a verdict stays 1", (key, cli, _usage, _code, tail) => {
    let checked = 0;
    for (const [what, main, code] of MAINS) {
      const r = run(argvOf(key, cli, tail, main));
      expect({ what, status: r.status }, r.stderr).toEqual({ what, status: code });
      if (code === 3) expect(r.stderr, what).toMatch(/: crashed — nothing caught /);
      else expect(r.stderr, what).not.toContain("crashed");
      checked++;
    }
    expect(checked).toBe(MAINS.length);
  });

  it.each(CLIS)("%s, run as its package script, still answers a usage error with its own exit — the preload changes no verdict", (key, cli, argv, code, tail) => {
    const r = run([...argvOf(key, cli, tail), ...argv]);
    expect(r.status, r.stderr).toBe(code);
    expect(r.stderr).not.toContain("crashed");
  });
});
