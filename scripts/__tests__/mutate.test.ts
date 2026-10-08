import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMutants, validateMutants, type Mutant } from "../mutate.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
// Outside scripts/__tests__ on purpose: CI's `vitest run scripts/__tests__` positional is a substring filter,
// so a scratch test here can never be collected by a concurrent CI run. Gitignored (scripts/.mutate-selftest-*/).
let dir = "";
let rel = "";
const SRC = "export const add = (a: number, b: number): number => a + b;\nexport const isPositive = (n: number): boolean => n > 0;\n";
let SPEC = ""; // sum.test.ts as copied, for the restore check on a mutant of the test file itself
// Each case spawns vitest once for the baseline and once per mutant; a cold vitest start is about 2 s locally,
// and CI with coverage is about 5x slower (TEST-STRATEGY budget rule).
const SPAWNS = 3;
const BUDGET_MS = Math.max(20_000, SPAWNS * 2_000 * 5);

beforeAll(() => {
  dir = mkdtempSync(join(REPO, "scripts", ".mutate-selftest-"));
  rel = relative(REPO, dir);
  cpSync(join(REPO, "scripts/__tests__/fixtures/mutate/sum.src.txt"), join(dir, "sum.ts"));
  cpSync(join(REPO, "scripts/__tests__/fixtures/mutate/sum.spec.txt"), join(dir, "sum.test.ts"));
  SPEC = readFileSync(join(dir, "sum.test.ts"), "utf8");
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const killers = () => [{ cwd: ".", files: [`${rel}/sum.test.ts`] }];
const mutant = (id: string, find: string, replace: string): Mutant => ({ id, file: `${rel}/sum.ts`, find, replace, killers: killers() });

describe("scripts/mutate.ts — one mutant at a time, restored, killers named", () => {
  it("empty case first: a zero-mutant list is refused (exit 2), never a vacuous pass", async () => {
    const r = await runMutants([], { repo: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/zero mutants/);
  });

  it("reports a killed mutant with its killing test, and a survivor, and restores the file byte-identical", async () => {
    const r = await runMutants([mutant("plus-to-minus", "a + b", "a - b"), mutant("gt-to-gte", "n > 0", "n >= 0")], { repo: REPO });
    expect(r.verdicts).toEqual([
      { id: "plus-to-minus", state: "KILLED", killedBy: ["adds"] },
      { id: "gt-to-gte", state: "SURVIVED" },
    ]);
    expect(r.exitCode).toBe(1); // a survivor fails the run
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
  }, BUDGET_MS);

  it("all killed exits 0", async () => {
    const r = await runMutants([mutant("plus-to-minus", "a + b", "a - b")], { repo: REPO });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
  }, BUDGET_MS);

  it("a find that matches 0 or 2+ times, or a duplicate id, is refused before any edit", async () => {
    const none = await runMutants([mutant("absent", "a * b", "a / b")], { repo: REPO });
    expect(none.exitCode).toBe(2);
    expect(none.error).toMatch(/matches 0 times/);
    const many = await runMutants([mutant("twice", "number", "string")], { repo: REPO });
    expect(many.exitCode).toBe(2);
    expect(many.error).toMatch(/matches [2-9]\d* times/);
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
    const dup = await runMutants([mutant("same", "a + b", "a - b"), mutant("same", "n > 0", "n >= 0")], { repo: REPO });
    expect(dup.exitCode).toBe(2);
    expect(dup.error).toMatch(/duplicate mutant id/);
  });

  it("a red baseline is refused: with every killer already failing, every mutant would read KILLED", async () => {
    writeFileSync(join(dir, "sum.ts"), SRC.replace("a + b", "a + b + 1"));
    try {
      const r = await runMutants([mutant("plus-to-minus", "a + b + 1", "a - b + 1")], { repo: REPO });
      expect(r.exitCode).toBe(2);
      expect(r.error).toMatch(/baseline is red/);
    } finally { writeFileSync(join(dir, "sum.ts"), SRC); }
  }, BUDGET_MS);

  it("a killer with NO files is refused before any spawn: it would run the whole suite (AGENTS.md: never)", () => {
    expect(() => validateMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: ".", files: [] }] }], REPO)).toThrow(/would run the WHOLE suite/);
  });

  // Three guards, three distinct messages, three cases: one shared message would let each guard hide the others.
  // The brief premised that vitest writes NO report for a test file that does not exist. Measured on vitest 4.1.11 it
  // writes an EMPTY one (0 tests, exit 1), so a typo'd path lands on the "passed no test" guard instead. The no-report
  // guard is reached by a process that never runs: a killer cwd that does not exist (spawn ENOENT). Both are pinned, each
  // with its own message, so the day vitest changes either behaviour this reds instead of one guard silently covering the other.
  it("a killer that yields no result is refused, never a kill: an unrunnable cwd writes no report at all; a typo'd test file writes an empty one", async () => {
    const noReport = await runMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: "scripts/no-such-dir", files: [`${rel}/sum.test.ts`] }] }], { repo: REPO });
    expect(noReport.exitCode).toBe(2);
    expect(noReport.error).toMatch(/wrote no JSON report/);
    const typo = await runMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: ".", files: [`${rel}/no-such.test.ts`] }] }], { repo: REPO });
    expect(typo.exitCode).toBe(2);
    expect(typo.error).toMatch(/passed no test on the baseline/);
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
  }, BUDGET_MS);

  it("a killer whose -t name matches nothing is refused at the baseline (skipped tests count in numTotalTests, so the guard reads numPassedTests)", async () => {
    const r = await runMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: ".", files: [`${rel}/sum.test.ts`], name: "no such test name" }] }], { repo: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/passed no test on the baseline/);
  }, BUDGET_MS);

  it("a killer that runs no test UNDER the mutant is refused, never read as a survivor", async () => {
    const r = await runMutants([{ id: "skip-adds", file: `${rel}/sum.test.ts`, find: 'it("adds"', replace: 'it.skip("adds"', killers: [{ cwd: ".", files: [`${rel}/sum.test.ts`], name: "adds" }] }], { repo: REPO });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/ran no test under the mutant/);
    expect(readFileSync(join(dir, "sum.test.ts"), "utf8")).toBe(SPEC);
  }, BUDGET_MS);

  // The runner's first draft was synchronous (spawnSync), so its SIGINT/SIGTERM handlers could never run while a killer
  // was in flight: a `kill <pid>` was ignored until every mutant had finished. They fire only if the loop awaits. Driven
  // through the real CLI (a signal cannot be sent to a vitest worker), at the moment a killer is demonstrably running
  // under the mutant. One case per handler: each is its own line, and either could be deleted unseen by the other.
  it.each(["SIGTERM", "SIGINT"] as const)("%s while a killer runs under the mutant: the killer's whole process group is stopped, the file is restored byte-identical, exit 2", async (sig) => {
    const SLOW = `${rel}/slow.test.ts`;
    // Green on the baseline. Under the mutant it drops a marker file and then sleeps past the test timeout, so the signal can be
    // sent while the killer is demonstrably HANGING inside the test. Merely seeing the vitest process is not enough: sent while it
    // is still booting, the handler restores the file before the killer ever imports it, the killer passes, exits by itself,
    // and a handler that never stopped it is indistinguishable from one that did.
    const marker = join(dir, "hanging");
    rmSync(marker, { force: true });
    writeFileSync(join(dir, "slow.test.ts"), 'import { writeFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nimport { add } from "./sum.ts";\nit("hangs only when mutated", async () => { if (add(2, 3) !== 5) { writeFileSync(new URL("./hanging", import.meta.url), "x"); await new Promise((r) => setTimeout(r, 120_000)); } expect(add(2, 3)).toBe(5); });\n');
    const list = join(dir, "slow.mutants.json");
    writeFileSync(list, JSON.stringify([{ id: "hang", file: `${rel}/sum.ts`, find: "a + b", replace: "a - b", killers: [{ cwd: ".", files: [SLOW] }] }]));
    const procs = () => spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).stdout.split("\n").flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m === null ? [] : [{ pid: Number(m[1]), pgid: Number(m[2]), command: m[3]! }];
    });
    const killer = () => procs().find((p) => p.command.includes(SLOW));
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const cli = spawn(process.execPath, ["--experimental-strip-types", "--import", "./scripts/lib/crash-exit.ts", "scripts/mutate.ts", "--list", list], { cwd: REPO, stdio: "ignore" });
    const exited = new Promise<number | null>((done) => cli.once("close", (code) => done(code)));
    try {
      const deadline = Date.now() + BUDGET_MS - 10_000;
      const mutated = () => readFileSync(join(dir, "sum.ts"), "utf8") !== SRC;
      while (!(existsSync(marker) && killer() !== undefined) && Date.now() < deadline) await sleep(50);
      const group = killer()?.pgid;
      expect(existsSync(marker), "the killer is hanging inside the mutated test when the signal is sent").toBe(true);
      expect(group, "and its process is alive").toBeDefined();
      expect(mutated(), "and the file is mutated at that moment").toBe(true);
      cli.kill(sig);
      expect(await Promise.race([exited, sleep(10_000).then(() => `still running 10 s after ${sig}`)])).toBe(2);
      expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
      const gone = Date.now() + 5_000;
      while (procs().some((p) => p.pgid === group) && Date.now() < gone) await sleep(50);
      expect(procs().filter((p) => p.pgid === group).map((p) => p.command), "no process of the killer's group outlives the runner").toEqual([]);
    } finally {
      cli.kill("SIGKILL");
      writeFileSync(join(dir, "sum.ts"), SRC); // a failed case must not hand the next one a mutated file (the assertions above already ran)
    }
  }, BUDGET_MS);
});
