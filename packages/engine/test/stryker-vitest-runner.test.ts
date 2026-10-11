// Engine mutation-debt P0: a test FILE that fails as a whole during a mutant run counts as a detection (Killed).
//
// Group=all run 37957068135 reported `cricket.ts:3417` (padSpec's DLS panel, ObjectLiteral -> {}) as Survived, with 1,973 tests
// completed out of the leg's 2,154: a static mutant made padSpec({dls}) throw, testkit/conformance-pad.ts calls padSpec(cfg) at
// module level for cricket.test.ts, so that file (181 tests) failed to load, and @stryker-mutator/vitest-runner 10.0.0 builds its
// verdict from tests only. Reproduced in this worktree by a single-mutant Stryker run (P0 report).
//
// These tests drive the REAL vitest runner, built by its own plugin factory, over a scratch project whose test file throws at
// load exactly when a given mutant is active, the way a static mutant does (the runner's own setup file sets the active mutant
// before the test file is imported). Expected values come from the runner's own dry-run output, never from the decorator.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { strykerPlugins as vitestPlugins } from "@stryker-mutator/vitest-runner";
import { DRY_RUN_TESTS_FILE, FILE_FAILED_REASON, FILE_FAILED_TEST_NAME, FileFailureKills, RUNNER_NAME, filesFailedAsAWhole, strykerPlugins, vitestRunnerOf, type VitestFileLike } from "../scripts/stryker-vitest-runner.mjs";
import { SPAWN_MS } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);
const PLUGIN = join(ENGINE, "scripts/stryker-vitest-runner.mjs");
const VITEST_RUNNER = req.resolve("@stryker-mutator/vitest-runner");

/** The mutant whose activation makes the fixture's second test file throw at load; and one that breaks nothing. */
const BREAKS_LOAD = "7";
const BREAKS_NOTHING = "8";
/** Mutants that break a NESTED suite as a whole (review M1): one makes an afterAll in a nested describe throw, one empties the
 *  list a nested describe's tests are generated from (vitest: "No test found in suite"). */
const BREAKS_AFTER_ALL = "9";
const EMPTIES_SWEEP = "10";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A scratch project the vitest runner can run: its own vitest config (globals, so the files import nothing), the engine's
 *  node_modules (the runner's setup file imports vitest from the project), and the test files given. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "stryker-vitest-runner-"));
  roots.push(root);
  symlinkSync(join(ENGINE, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
  writeFileSync(join(root, "vitest.config.mjs"), `export default { cacheDir: ".vite-cache", test: { globals: true, include: ["*.test.js"] } };\n`);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "subject.js"), "export const subject = 1;\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const PASSES = `it("passes whatever the mutant", () => { expect(1).toBe(1); });\n`;
/** Throws at load when mutant 7 is active (statically, as Stryker activates a static mutant), and has two tests otherwise. */
const BREAKS_ON_LOAD = `
if (globalThis.__stryker__?.activeMutant === "${BREAKS_LOAD}") throw new Error("mutant ${BREAKS_LOAD} broke the load");
it("would see mutant ${BREAKS_LOAD} if the file could load", () => { expect(globalThis.__stryker__?.activeMutant).not.toBe("${BREAKS_LOAD}"); });
it("a second test in the same file", () => { expect(2).toBe(2); });
`;

type Step = { runner: "plain" | "wrapped"; ops: string[] };
type TestResult = { id: string; name: string; status: number; fileName?: string; failureMessage?: string };
type Outcome = { status: string; tests?: TestResult[]; errorMessage?: string; failureMessage?: string; killedBy?: string[]; nrOfTests?: number };

/** Runs `steps` in one plain node process whose cwd is `root` (the runner, like a Stryker child, works in its cwd): each step
 *  builds a fresh runner through its plugin's own factory, inits it, runs its ops in order (`dry`, `mutant:<id>`, `rm-map`),
 *  and disposes it. Returns each op's outcome, in order. */
function drive(root: string, steps: Step[]): Outcome[] {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const [wrappedUrl, plainUrl, stepsJson, mapFile] = process.argv.slice(1);
    const { rmSync } = await import("node:fs");
    const wrapped = (await import(wrappedUrl)).strykerPlugins;
    const plain = (await import(plainUrl)).strykerPlugins;
    const log = new Proxy({}, { get: (_t, k) => (String(k).startsWith("is") ? () => false : () => {}) });
    const options = { vitest: { configFile: "vitest.config.mjs", related: false }, disableBail: false };
    const injector = { provideValue: (_token, value) => ({ injectClass: (C) => new C(options, log, value) }) };
    const out = [];
    for (const step of JSON.parse(stepsJson)) {
      const plugin = (step.runner === "plain" ? plain : wrapped).find((p) => p.kind === "TestRunner");
      const runner = plugin.factory(injector);
      await runner.init();
      for (const op of step.ops) {
        if (op === "rm-map") { rmSync(mapFile, { force: true }); continue; }
        if (op === "dry") { out.push(await runner.dryRun({ coverageAnalysis: "perTest", timeout: 30000, disableBail: false, files: [] })); continue; }
        const id = op.slice("mutant:".length);
        out.push(await runner.mutantRun({ activeMutant: { id }, mutantActivation: "static", testFilter: undefined, sandboxFileName: "src/subject.js", hitLimit: undefined, timeout: 30000, disableBail: false, reloadEnvironment: false }));
      }
      await runner.dispose();
    }
    process.stdout.write("\\nRESULT:" + JSON.stringify(out) + "\\n");
    // vitest sets process.exitCode = 1 after a run with a failure, which every scenario here has on purpose; a crash of the
    // driver itself still exits non-zero (an uncaught rejection) and prints no RESULT line
    process.exitCode = 0;
  `, pathToFileURL(PLUGIN).href, pathToFileURL(VITEST_RUNNER).href, JSON.stringify(steps), DRY_RUN_TESTS_FILE],
  { cwd: root, encoding: "utf8", timeout: SPAWN_MS * steps.length });
  expect(r.status, `${r.stderr}\n${r.stdout}`).toBe(0);
  const line = r.stdout.split("\n").findLast((l) => l.startsWith("RESULT:"));
  expect(line, "the driver printed its outcomes").toBeDefined();
  return JSON.parse(line!.slice("RESULT:".length)) as Outcome[];
}

const budget = (steps: number) => SPAWN_MS * steps + 5_000;
const testsIn = (o: Outcome, file: string) => (o.tests ?? []).filter((t) => t.fileName === undefined ? false : t.fileName.endsWith(`/${file}`));

describe("stryker.config.mjs runs the engine's mutants through this runner", () => {
  it("selects it by name and loads both plugins: the vitest runner (its options schema) and this one, from a path that exists", () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `process.env.STRYKER_GROUP = "probe"; console.log(JSON.stringify((await import("./stryker.config.mjs")).default));`], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const c = JSON.parse(r.stdout) as { testRunner: string; plugins: string[] };
    expect(c.testRunner).toBe(RUNNER_NAME);
    expect(c.plugins).toEqual(["@stryker-mutator/vitest-runner", "./scripts/stryker-vitest-runner.mjs"]);
    // Stryker resolves a relative plugin against its cwd, which is packages/engine (`pnpm mutation`)
    expect(resolve(ENGINE, c.plugins[1]!)).toBe(PLUGIN);
    expect(strykerPlugins.map((p) => [p.kind, p.name])).toEqual([["TestRunner", RUNNER_NAME]]);
    // the factory asks Stryker's injector for exactly what the vitest runner's own factory asks for
    expect(strykerPlugins[0]!.factory.inject).toEqual(["$injector"]);
  }, budget(1));
});

describe("a test file that fails to load in a mutant run is a detection", () => {
  const root = project({ "a-passes.test.js": PASSES, "b-breaks-on-load.test.js": BREAKS_ON_LOAD });

  it("the plain vitest runner reports it SURVIVED (the artefact): the file's tests simply vanish from the count", () => {
    const [dry, mutant] = drive(root, [{ runner: "plain", ops: ["dry", `mutant:${BREAKS_LOAD}`] }]);
    expect(dry!.status).toBe("complete");
    const all = dry!.tests!.length;
    const inBroken = testsIn(dry!, "b-breaks-on-load.test.js").length;
    expect(all, "the dry run ran both files").toBe(3);
    expect(inBroken, "the file the mutant breaks has tests the dry run ran").toBe(2);
    expect(mutant).toEqual({ status: "survived", nrOfTests: all - inBroken });
  }, budget(1));

  it("this runner reports it KILLED, by the broken file's first dry-run test, with the load error as the reason", () => {
    const [dry, killed, untouched] = drive(root, [{ runner: "wrapped", ops: ["dry", `mutant:${BREAKS_LOAD}`, `mutant:${BREAKS_NOTHING}`] }]);
    expect(dry!.status).toBe("complete");
    const first = testsIn(dry!, "b-breaks-on-load.test.js")[0];
    expect(first, "the dry run ran the broken file").toBeDefined();
    expect(killed).toMatchObject({ status: "killed", killedBy: [first!.id], nrOfTests: dry!.tests!.length - 2 });
    expect(killed!.failureMessage).toBe(`${FILE_FAILED_REASON}\nb-breaks-on-load.test.js: mutant ${BREAKS_LOAD} broke the load`);
    // the positive pair: a mutant that breaks nothing still survives, every file loaded, every test counted
    expect(untouched).toEqual({ status: "survived", nrOfTests: dry!.tests!.length });
  }, budget(1));

  it("a second runner child (no dry run of its own) reads the dry run's map from the sandbox; with no map the kill names the file", () => {
    const [dry, fromMap, withoutMap] = drive(root, [
      { runner: "wrapped", ops: ["dry"] },
      { runner: "wrapped", ops: [`mutant:${BREAKS_LOAD}`] },
      { runner: "wrapped", ops: ["rm-map", `mutant:${BREAKS_LOAD}`] },
    ]);
    const first = testsIn(dry!, "b-breaks-on-load.test.js")[0]!;
    expect(fromMap).toMatchObject({ status: "killed", killedBy: [first.id] });
    expect(withoutMap).toMatchObject({ status: "killed", killedBy: [`b-breaks-on-load.test.js#${FILE_FAILED_TEST_NAME}`] });
    expect(existsSync(join(root, DRY_RUN_TESTS_FILE)), "the map was removed before the last run").toBe(false);
  }, budget(3));
});

describe("the dry run refuses a test file that fails as a whole (the guard that keeps the change above from counting a broken baseline as kills)", () => {
  it("a file that never loads: the plain runner drops it silently and completes; this runner fails the dry run, naming it", () => {
    const root = project({ "a-passes.test.js": PASSES, "b-never-loads.test.js": `throw new Error("this file never loads");\nit("unreachable", () => {});\n` });
    const [plain, wrapped] = drive(root, [{ runner: "plain", ops: ["dry"] }, { runner: "wrapped", ops: ["dry"] }]);
    expect(plain!.status).toBe("complete");
    expect(plain!.tests!.map((t) => t.name), "the plain dry run silently ran only the other file").toEqual(["passes whatever the mutant"]);
    expect(wrapped!.status).toBe("error");
    expect(wrapped!.errorMessage).toContain("b-never-loads.test.js: this file never loads");
    expect(existsSync(join(root, DRY_RUN_TESTS_FILE)), "a refused dry run writes no map").toBe(false);
  }, budget(2));

  it("a file whose TEST fails is not a file that failed as a whole: the dry run completes with the failed test (Stryker's own refusal)", () => {
    const root = project({ "a-passes.test.js": PASSES, "b-one-test-fails.test.js": `it("fails", () => { expect(1).toBe(2); });\n` });
    const [dry] = drive(root, [{ runner: "wrapped", ops: ["dry"] }]);
    expect(dry!.status).toBe("complete");
    expect(dry!.tests!.filter((t) => t.status === 1).map((t) => t.name)).toEqual(["fails"]);
    const map = JSON.parse(readFileSync(join(root, DRY_RUN_TESTS_FILE), "utf8")) as Record<string, string>;
    expect(Object.keys(map).length, "the map names a first test for each file the dry run ran").toBe(2);
  }, budget(1));
});

describe("a suite NESTED in a test file that fails as a whole is a detection too (review M1)", () => {
  // vitest records a nested suite's own failure on that suite, never on the file: an afterAll that throws (runSuite's catch around
  // the suite hooks) and a suite left with no test ("No test found in suite"), the shape a mutant that empties a sweep's list has
  const NESTED = `
const CASES = globalThis.__stryker__?.activeMutant === "${EMPTIES_SWEEP}" ? [] : [1, 2];
describe("outer", () => {
  describe("a sweep over CASES", () => {
    for (const c of CASES) it(\`case \${c}\`, () => { expect(c).toBeGreaterThan(0); });
  });
  describe("with a cleanup", () => {
    afterAll(() => { if (globalThis.__stryker__?.activeMutant === "${BREAKS_AFTER_ALL}") throw new Error("mutant ${BREAKS_AFTER_ALL} broke an afterAll"); });
    it("passes", () => { expect(1).toBe(1); });
  });
});
`;
  const root = project({ "a-passes.test.js": PASSES, "c-nested.test.js": NESTED });

  it("the plain runner reports both SURVIVED; this runner reports both KILLED, by the enclosing file's first dry-run test, naming the suite", () => {
    const [plainDry, plainAfterAll, plainEmptied, dry, afterAllKill, emptiedKill] = drive(root, [
      { runner: "plain", ops: ["dry", `mutant:${BREAKS_AFTER_ALL}`, `mutant:${EMPTIES_SWEEP}`] },
      { runner: "wrapped", ops: ["dry", `mutant:${BREAKS_AFTER_ALL}`, `mutant:${EMPTIES_SWEEP}`] },
    ]);
    expect(plainDry!.status).toBe("complete");
    const all = plainDry!.tests!.length;
    expect(all, "the dry run ran both files: 1 + the sweep's 2 + 1").toBe(4);
    expect(plainAfterAll, "every test passed, so the plain runner sees nothing").toEqual({ status: "survived", nrOfTests: all });
    expect(plainEmptied, "the sweep's 2 tests simply vanish").toEqual({ status: "survived", nrOfTests: all - 2 });
    expect(dry!.status).toBe("complete");
    const first = testsIn(dry!, "c-nested.test.js")[0];
    expect(first, "the dry run ran the nested file").toBeDefined();
    expect(afterAllKill).toEqual({
      status: "killed",
      killedBy: [first!.id],
      failureMessage: `${FILE_FAILED_REASON}\nc-nested.test.js > outer > with a cleanup: mutant ${BREAKS_AFTER_ALL} broke an afterAll`,
      nrOfTests: all,
    });
    expect(emptiedKill).toEqual({
      status: "killed",
      killedBy: [first!.id],
      failureMessage: `${FILE_FAILED_REASON}\nc-nested.test.js > outer > a sweep over CASES: No test found in suite a sweep over CASES`,
      nrOfTests: all - 2,
    });
  }, budget(2));

  it("the dry run refuses a nested suite that fails as a whole without any mutant, naming the file and the suite", () => {
    const always = `describe("outer", () => {\n  afterAll(() => { throw new Error("this cleanup always throws"); });\n  it("passes", () => { expect(1).toBe(1); });\n});\n`;
    const root2 = project({ "a-passes.test.js": PASSES, "d-nested-always.test.js": always });
    const [plain, wrapped] = drive(root2, [{ runner: "plain", ops: ["dry"] }, { runner: "wrapped", ops: ["dry"] }]);
    expect(plain!.status, "the plain dry run completes: every test passed").toBe("complete");
    expect(wrapped!.status).toBe("error");
    expect(wrapped!.errorMessage).toContain("d-nested-always.test.js > outer: this cleanup always throws");
    expect(existsSync(join(root2, DRY_RUN_TESTS_FILE)), "a refused dry run writes no map").toBe(false);
  }, budget(2));
});

// ---- FileFailureKills against a FAKE inner runner: the guards the real-runner scenarios above cannot reach (review M3) --------

/** A sandbox for one fake run. */
function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "file-failure-kills-"));
  roots.push(d);
  return d;
}
type Fake = { files?: VitestFileLike[] | (() => unknown); dry?: unknown; mutant?: unknown };
/** An inner runner with the vitest runner's shape: `ctx.state.getFiles()` (left out when `files` is undefined), and fixed results. */
function fake(f: Fake): unknown {
  const getFiles = typeof f.files === "function" ? f.files : () => f.files;
  return { ...(f.files === undefined ? {} : { ctx: { state: { getFiles } } }), dryRun: async () => f.dry, mutantRun: async () => f.mutant };
}
const failedOnLoad = (cwd: string, name: string, message = "it broke on load"): VitestFileLike =>
  ({ filepath: join(cwd, name), type: "suite", name, result: { state: "fail", errors: [{ message }] }, tasks: [] });
const clean = (cwd: string, name: string): VitestFileLike =>
  ({ filepath: join(cwd, name), type: "suite", name, result: { state: "pass" }, tasks: [{ type: "test", name: "t", result: { state: "pass" } }] });
const mapAt = (cwd: string) => join(cwd, DRY_RUN_TESTS_FILE);
const SURVIVED = { status: "survived", nrOfTests: 3 };

describe("FileFailureKills against a fake inner runner (every guard the real-runner scenarios cannot reach; review M3)", () => {
  it("a mutant run the inner runner did NOT report survived passes through untouched, even with a file failed as a whole: a timeout stays a timeout, a kill keeps its own killer", async () => {
    const cwd = sandbox();
    const files = [failedOnLoad(cwd, "b.test.js")];
    const timeout = { status: "timeout", reason: "hit limit" };
    expect(await new FileFailureKills(fake({ files, mutant: timeout }), cwd).mutantRun({})).toBe(timeout);
    const killed = { status: "killed", killedBy: ["5"], failureMessage: "expected 1 to be 2", nrOfTests: 1 };
    expect(await new FileFailureKills(fake({ files, mutant: killed }), cwd).mutantRun({})).toBe(killed);
  });

  it("a dry run the inner runner did not complete passes through untouched and writes no map, even with a file failed as a whole", async () => {
    let checked = 0;
    for (const dry of [{ status: "error", errorMessage: "the inner runner broke" }, { status: "timeout" }]) {
      const cwd = sandbox();
      expect(await new FileFailureKills(fake({ files: [failedOnLoad(cwd, "b.test.js")], dry }), cwd).dryRun({}), dry.status).toBe(dry);
      expect(existsSync(mapAt(cwd)), `${dry.status}: no map`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an inner runner without ctx.state.getFiles() is refused by name, in a mutant run and in a dry run (never a TypeError)", async () => {
    let checked = 0;
    for (const files of [undefined, () => undefined, () => ({ length: 0 })]) {
      const cwd = sandbox();
      const r = new FileFailureKills(fake({ files, mutant: SURVIVED, dry: { status: "complete", tests: [] } }), cwd);
      await expect(r.mutantRun({})).rejects.toThrow(`${RUNNER_NAME}: the vitest runner no longer exposes ctx.state.getFiles()`);
      await expect(r.dryRun({})).rejects.toThrow(`${RUNNER_NAME}: the vitest runner no longer exposes ctx.state.getFiles()`);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the dry run's map: no file is an empty map (ENOENT); any other read failure is thrown, never read as an empty map", async () => {
    const cwd = sandbox();
    const r = new FileFailureKills(fake({ files: [failedOnLoad(cwd, "b.test.js")], mutant: SURVIVED }), cwd);
    expect(r.dryRunTests()).toEqual({});
    mkdirSync(mapAt(cwd)); // a directory where the map belongs: EISDIR
    let thrown: unknown;
    try { r.dryRunTests(); } catch (e) { thrown = e; }
    expect((thrown as { code?: string } | undefined)?.code, String(thrown)).toBe("EISDIR");
    await expect(r.mutantRun({})).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("a kill is credited through the map by the RESOLVED path of the failed file (the map's keys are resolved paths), and an unmapped file gets the synthetic id", async () => {
    const cwd = sandbox();
    // an unnormalised fileName too: the vitest runner resolves it today (vitest-helpers.js), the map must not depend on that
    const dry = { status: "complete", tests: [{ id: "11", name: "first", status: 0, fileName: `${cwd}/sub/../c.test.js` }, { id: "12", name: "second", status: 0, fileName: join(cwd, "c.test.js") }] };
    expect(await new FileFailureKills(fake({ files: [clean(cwd, "c.test.js")], dry }), cwd).dryRun({})).toBe(dry);
    expect(JSON.parse(readFileSync(mapAt(cwd), "utf8"))).toEqual({ [join(cwd, "c.test.js")]: "11" });
    // vitest's filepath is not always normalised; the map is keyed by path.resolve (vitest-helpers.js's toTestResult)
    const unnormalised = { ...failedOnLoad(cwd, "c.test.js"), filepath: `${cwd}/sub/../c.test.js` };
    const killed = await new FileFailureKills(fake({ files: [unnormalised, failedOnLoad(cwd, "unmapped.test.js")], mutant: SURVIVED }), cwd).mutantRun({});
    expect(killed).toMatchObject({ status: "killed", killedBy: ["11", `unmapped.test.js#${FILE_FAILED_TEST_NAME}`], nrOfTests: 3 });
  });

  it("a nested suite's own error makes its FILE failed as a whole, at any depth; a test's own error never does, nor a suite failed only because a test in it failed", () => {
    const cwd = sandbox();
    const nested: VitestFileLike = { filepath: join(cwd, "n.test.js"), type: "suite", name: "n.test.js", result: { state: "fail" }, tasks: [
      { type: "test", name: "passes", result: { state: "pass" } },
      { type: "suite", name: "outer", result: { state: "fail" }, tasks: [
        { type: "suite", name: "inner", result: { state: "fail", errors: [{ message: "afterAll threw" }] }, tasks: [] },
      ] },
    ] };
    const testFailed: VitestFileLike = { filepath: join(cwd, "t.test.js"), type: "suite", name: "t.test.js", result: { state: "fail" }, tasks: [
      { type: "suite", name: "outer", result: { state: "fail" }, tasks: [
        { type: "test", name: "fails", result: { state: "fail", errors: [{ message: "expected 1 to be 2" }] } },
      ] },
    ] };
    const passed = clean(cwd, "p.test.js");
    expect(filesFailedAsAWhole([nested, testFailed, passed]).map((f) => f.filepath)).toEqual([join(cwd, "n.test.js")]);
    expect(filesFailedAsAWhole([]), "the empty case").toEqual([]);
  });

  it("the vitest runner's plugin is found by kind AND name, and its absence is refused by name", () => {
    const real = vitestPlugins.find((p) => String(p.kind) === "TestRunner" && p.name === "vitest");
    expect(real, "@stryker-mutator/vitest-runner declares its runner").toBeDefined();
    expect(vitestRunnerOf(vitestPlugins)).toBe(real);
    let checked = 0;
    for (const plugins of [[], [{ kind: "Reporter", name: "vitest" }], [{ kind: "TestRunner", name: "jest" }]]) {
      expect(() => vitestRunnerOf(plugins), JSON.stringify(plugins)).toThrow(`${RUNNER_NAME}: @stryker-mutator/vitest-runner declares no "vitest" test runner`);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
