import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMutants, table, validateMutants, type Mutant } from "../mutate.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
// Outside scripts/__tests__ on purpose: CI's `vitest run scripts/__tests__` positional is a substring filter,
// so a scratch test here can never be collected by a concurrent CI run. At the repo ROOT, not under scripts/:
// scripts/__tests__/test-email-domain.test.ts walks scripts/, tools/ and apps/web/e2e when it is collected and reads
// those files later, in the same CI job (ci.yml:787), so a scratch tree there that this file removes mid-run is an
// ENOENT in an unrelated test. Nothing walks the root's dot-directories. Gitignored (/.mutate-selftest-*/).
let dir = "";
let rel = "";
const SRC = "export const add = (a: number, b: number): number => a + b;\nexport const isPositive = (n: number): boolean => n > 0;\n";
let SPEC = ""; // sum.test.ts as copied, for the restore check on a mutant of the test file itself
// Each case spawns vitest once for the baseline and once per mutant; a cold vitest start is about 2 s locally,
// and CI with coverage is about 5x slower (TEST-STRATEGY budget rule).
const SPAWNS = 3;
const BUDGET_MS = Math.max(20_000, SPAWNS * 2_000 * 5);
// A signal case waits three times in a row, so its budget is the SUM of its waits plus slack, not BUDGET_MS:
// for the killer to start hanging (the three spawns above), for the runner to exit after the signal, for its group to be gone.
const START_WAIT_MS = BUDGET_MS;
const EXIT_WAIT_MS = 10_000;
const GONE_WAIT_MS = 5_000;
const SIGNAL_BUDGET_MS = START_WAIT_MS + EXIT_WAIT_MS + GONE_WAIT_MS + 5_000;

beforeAll(() => {
  dir = mkdtempSync(join(REPO, ".mutate-selftest-"));
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

  // I-2 (review round 1): the scratch tree must live where no repo sweep walks, and must be gitignored.
  it("the scratch dir is a root-level dot-directory (no sweep of scripts/, tools/ or apps/ can see it) and git ignores it", () => {
    expect(dirname(rel), "directly under the repo root").toBe(".");
    expect(rel.startsWith(".mutate-selftest-")).toBe(true);
    const ignored = spawnSync("git", ["check-ignore", "-q", `${rel}/sum.ts`], { cwd: REPO });
    expect(ignored.status, "git check-ignore exits 0 for an ignored path").toBe(0);
  });

  // I-1 (review round 1): a killer's shape decides WHAT vitest runs. `files: [""]` and a bare "t" are positional filters
  // that match every test file in the cwd, i.e. the whole suite (owner-forbidden), and a string `files` spreads into one
  // filter per character. Every refusal is checked before any spawn or edit, one case per shape, each with its own message.
  const base = (): Mutant => mutant("m", "a + b", "a - b");
  const withKiller = (k: object): unknown[] => [{ ...base(), killers: [{ cwd: ".", files: [`${rel}/sum.test.ts`], ...k }] }];
  const SHAPES: readonly (readonly [string, () => unknown, RegExp])[] = [
    ["a list that is not an array", () => ({ ...base() }), /must be a JSON array/],
    ["a mutant that is null", () => [null], /mutant #0 is not an object/],
    ["an id that is not a string", () => [{ ...base(), id: 7 }], /id must be a string/],
    ["a file that is not a string", () => [{ ...base(), file: 7 }], /file must be a string/],
    ["a find that is not a string", () => [{ ...base(), find: 7 }], /find must be a string/],
    ["a replace that is not a string", () => [{ ...base(), replace: 7 }], /replace must be a string/],
    ["a mutated file that does not exist", () => [{ ...base(), file: `${rel}/no-such.ts` }], /mutant file .* does not exist/],
    ["killers that are a string", () => [{ ...base(), killers: "x" }], /killers must be an array/],
    ["a killer that is null", () => [{ ...base(), killers: [null] }], /a killer must be an object/],
    ["a killer cwd that is not a string", () => withKiller({ cwd: 7 }), /cwd must be a string/],
    ["a killer cwd that does not exist", () => withKiller({ cwd: "scripts/no-such-dir" }), /is not a directory/],
    ["a killer cwd that is a file", () => withKiller({ cwd: `${rel}/sum.ts` }), /is not a directory/],
    ["files that are a string (spread into one filter per character)", () => withKiller({ files: "x" }), /files must be an array/],
    ["a file that is the empty string (matches every test file)", () => withKiller({ files: [""] }), /killer file must be a non-empty string/],
    ["a file that is not a string", () => withKiller({ files: [7] }), /killer file must be a non-empty string/],
    ["a file that does not exist under the cwd", () => withKiller({ files: [`${rel}/no-such.test.ts`] }), /killer file .* does not exist/],
    ["a file that is a directory (a filter matching everything below it)", () => withKiller({ files: [rel] }), /is not a file/],
    ["a -t name that is not a string", () => withKiller({ name: 7 }), /name must be a non-empty string/],
    ["a -t name that is the empty string", () => withKiller({ name: "" }), /name must be a non-empty string/],
    ["a collectFailOk that is not a string", () => [{ ...base(), collectFailOk: true }], /collectFailOk must be a non-empty string/],
    ["a collectFailOk that is the empty string", () => [{ ...base(), collectFailOk: "" }], /collectFailOk must be a non-empty string/],
  ];
  it.each(SHAPES)("validateMutants refuses %s, before any spawn", (_what, build, message) => {
    expect(() => validateMutants(build(), REPO)).toThrow(message);
  });

  it("the shape table is not vacuous, and a well-formed list is NOT refused (the positive pair: a guard that refuses everything passes the table)", () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(20);
    const good = [{ ...base(), collectFailOk: "deliberate: a type-level change", killers: [{ cwd: ".", files: [`${rel}/sum.test.ts`], name: "adds" }] }];
    expect(() => validateMutants(good, REPO)).not.toThrow();
  });

  it("runMutants refuses a whole-suite killer with exit 2 and touches nothing: files [\"\"] and files \"t\"", async () => {
    for (const files of [[""], "t"]) {
      const r = await runMutants([{ ...base(), killers: [{ cwd: ".", files: files as string[] }] }], { repo: REPO });
      expect(r.exitCode, JSON.stringify(files)).toBe(2);
      expect(r.verdicts).toEqual([]);
      expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
    }
  });

  // I-3 (review round 1, plan-mandated): a killer that fails to COLLECT under the mutant (a syntax error from a bad replace,
  // a failed hook) ran no assertion, so reading it as a kill is exit 0 on a mutant nothing judged.
  it("a mutant that stops the killer COLLECTING is COLLECT_FAILED, not KILLED: it fails the run (exit 1), and the next mutant still runs", async () => {
    const r = await runMutants([mutant("syntax-error", "a + b", "a +"), mutant("plus-to-minus", "a + b", "a - b")], { repo: REPO });
    expect(r.verdicts.map((v) => [v.id, v.state])).toEqual([["syntax-error", "COLLECT_FAILED"], ["plus-to-minus", "KILLED"]]);
    const first = r.verdicts[0]!;
    expect(first.state === "COLLECT_FAILED" && first.detail.length > 0, "names why it failed to collect").toBe(true);
    expect(first.state === "COLLECT_FAILED" && first.detail.includes(String.fromCharCode(27)), "and the reason carries no terminal colour codes").toBe(false);
    expect(first.state === "COLLECT_FAILED" && first.accepted, "not accepted").toBeUndefined();
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
  }, BUDGET_MS);

  it("collectFailOk with a reason accepts that one mutant: still its own state, the reason kept for the table, exit 0", async () => {
    const reason = "deliberate: a type-level change";
    const r = await runMutants([{ ...mutant("syntax-error", "a + b", "a +"), collectFailOk: reason }], { repo: REPO });
    expect(r.verdicts).toEqual([{ id: "syntax-error", state: "COLLECT_FAILED", detail: expect.any(String), accepted: reason }]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
  }, BUDGET_MS);

  it("the table prints each state: the survivor and the unaccepted collect failure in bold, the accepted one with its reason", () => {
    const out = table([
      { id: "k", state: "KILLED", killedBy: ["adds"] },
      { id: "s", state: "SURVIVED" },
      { id: "c1", state: "COLLECT_FAILED", detail: "SyntaxError: boom" },
      { id: "c2", state: "COLLECT_FAILED", detail: "SyntaxError: boom", accepted: "deliberate: type-level" },
    ]);
    expect(out).toContain("| k | KILLED by adds |");
    expect(out).toContain("| s | **SURVIVED** |");
    expect(out).toContain("| c1 | **COLLECT_FAILED** — SyntaxError: boom |");
    expect(out).toContain("| c2 | COLLECT_FAILED (accepted: deliberate: type-level) — SyntaxError: boom |");
  });

  // Three guards, three distinct messages, three cases: one shared message would let each guard hide the others.
  // The brief premised that vitest writes NO report for a test file that does not exist. Measured on vitest 4.1.11 it
  // writes an EMPTY one (0 tests, exit 1), which is why a typo'd file is now refused up front (see the shape table) and
  // the "passed no test" guard is reached by a -t name. The no-report guard is reached by a process that never runs a
  // vitest: a killer cwd outside every workspace, where `pnpm exec vitest` refuses (no package, no binary).
  it("a killer that yields no report is refused, never a kill: pnpm exec vitest in a directory outside any workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "mutate-nows-"));
    try {
      writeFileSync(join(outside, "sum.test.ts"), SPEC);
      const r = await runMutants([{ ...mutant("plus-to-minus", "a + b", "a - b"), killers: [{ cwd: outside, files: ["sum.test.ts"] }] }], { repo: REPO });
      expect(r.exitCode).toBe(2);
      expect(r.error).toMatch(/wrote no JSON report/);
      expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
    } finally { rmSync(outside, { recursive: true, force: true }); }
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
    // POSIX ps (macOS and Linux procps): -A every process, -ww untruncated, args= the full command line.
    const procs = () => spawnSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,args="], { encoding: "utf8" }).stdout.split("\n").flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m === null ? [] : [{ pid: Number(m[1]), pgid: Number(m[2]), command: m[3]! }];
    });
    const killer = () => procs().find((p) => p.command.includes(SLOW));
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const cli = spawn(process.execPath, ["--experimental-strip-types", "--import", "./scripts/lib/crash-exit.ts", "scripts/mutate.ts", "--list", list], { cwd: REPO, stdio: "ignore" });
    const exited = new Promise<number | null>((done) => cli.once("close", (code) => done(code)));
    try {
      const deadline = Date.now() + START_WAIT_MS;
      const mutated = () => readFileSync(join(dir, "sum.ts"), "utf8") !== SRC;
      while (!(existsSync(marker) && killer() !== undefined) && Date.now() < deadline) await sleep(50);
      const group = killer()?.pgid;
      expect(existsSync(marker), "the killer is hanging inside the mutated test when the signal is sent").toBe(true);
      expect(group, "and its process is alive").toBeDefined();
      expect(mutated(), "and the file is mutated at that moment").toBe(true);
      cli.kill(sig);
      expect(await Promise.race([exited, sleep(EXIT_WAIT_MS).then(() => `still running ${EXIT_WAIT_MS} ms after ${sig}`)])).toBe(2);
      expect(readFileSync(join(dir, "sum.ts"), "utf8")).toBe(SRC);
      const gone = Date.now() + GONE_WAIT_MS;
      while (procs().some((p) => p.pgid === group) && Date.now() < gone) await sleep(50);
      expect(procs().filter((p) => p.pgid === group).map((p) => p.command), "no process of the killer's group outlives the runner").toEqual([]);
    } finally {
      cli.kill("SIGKILL");
      writeFileSync(join(dir, "sum.ts"), SRC); // a failed case must not hand the next one a mutated file (the assertions above already ran)
    }
  }, SIGNAL_BUDGET_MS);
});
