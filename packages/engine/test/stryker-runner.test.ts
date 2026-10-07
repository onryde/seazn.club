// W1d Task 20 pre-step, carries (a) and (c): how the vitest each Stryker sandbox runs is configured.
//
// (a) vitest adds its `github-actions` reporter by itself when GITHUB_ACTIONS=true and the config names no reporters. Inside a
//     Stryker run the test-runner child's stdout is not read as a report, but a CRASHED child's stdout is printed, and the
//     reporter turned it into `##[error]` annotations on a job that finished green. The Stryker runs use a vitest config of
//     their own (vitest.stryker.config.ts) that names its reporters.
// (c) a mutant that turns a counter into a runaway loop is killed by the heap, not by anything quicker. The runner child gets
//     a cap on the heap of its test-worker thread, so the loop dies in seconds.
//
// The figures below are MEASURED, on this engine's own dry run (the core-1 leg, whose related-tests set is the whole engine:
// 3,830 tests in one worker thread, the largest dry run there is), by running it through Stryker with a cap on the runner child:
// it passed at 4096, 1024, 640, 384 and 256 MB, and failed at 128 and at 64 MB ("Child process ran out of memory"). A runaway
// allocating loop in a worker thread died after 13.9 s at 1024 MB and 42.3 s at 4096 MB (2026-10-05, a 12-core machine).
// None of them is taken from the code under test.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";
import { strykerConcurrency } from "../stryker.groups.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);

/** The least cap the whole-engine dry run was seen to pass at, and the greatest it was seen to fail at, in MB. */
const DRY_RUN_PASSES_AT_MB = 256;
const DRY_RUN_FAILS_AT_MB = 128;
/** What a hosted runner has (ubuntu-latest, 4 vCPU), and the concurrency strykerConcurrency gives it: run 37330725739. */
const HOSTED = { cores: 4, memBytes: 16 * 1024 ** 3, workersPerSandbox: 1 };
const HOSTED_CONCURRENCY = 3;

/** The vitest config as vitest itself resolves it, in a plain node process (the config is TypeScript and `defineConfig`'d, so
 *  the resolution is vitest's, not a read of the file), with GITHUB_ACTIONS as given. */
function resolved(configFile: string, githubActions: boolean) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { resolveConfig } from "vitest/node";
    const { vitestConfig: c } = await resolveConfig({ config: ${JSON.stringify(configFile)}, watch: false });
    console.log(JSON.stringify({ reporters: c.reporters, pool: c.pool, isolate: c.isolate, maxWorkers: c.maxWorkers, include: c.include, environment: c.environment }));
  `], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS, env: { ...process.env, GITHUB_ACTIONS: githubActions ? "true" : "" } });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { reporters: [string, unknown][]; pool: string; isolate: boolean; maxWorkers: number; include: string[]; environment: string };
}
const names = (r: { reporters: [string, unknown][] }) => r.reporters.map(([n]) => n);

/** stryker.config.mjs as Stryker loads it (a plain node process), for one real group. */
function strykerConfig(): Record<string, unknown> {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `process.env.STRYKER_GROUP = "probe"; console.log(JSON.stringify((await import("./stryker.config.mjs")).default));`], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe("carry (a): the Stryker runs' vitest does not turn a crashed child's stdout into job annotations", () => {
  it("the POSITIVE CONTROL: the engine's own vitest config, under GITHUB_ACTIONS=true, gets the github-actions reporter; without it, it does not", () => {
    expect(names(resolved("vitest.config.ts", true))).toContain("github-actions");
    expect(names(resolved("vitest.config.ts", false))).not.toContain("github-actions");
  });

  it("stryker.config.mjs hands the runner vitest.stryker.config.ts, and that file is there", () => {
    const c = strykerConfig();
    expect(c.vitest).toEqual({ related: true, configFile: "vitest.stryker.config.ts" });
    expect(existsSync(join(ENGINE, "vitest.stryker.config.ts")), "the file the runner is told to load").toBe(true);
  });

  it("under GITHUB_ACTIONS=true the Stryker config resolves to explicit reporters and no github-actions, and the suite it runs is the engine's own", () => {
    const base = resolved("vitest.config.ts", false);
    const stryker = resolved("vitest.stryker.config.ts", true);
    expect(stryker.reporters.length, "reporters are named, not defaulted").toBeGreaterThan(0);
    expect(names(stryker)).not.toContain("github-actions");
    expect(names(stryker)).toEqual(["default"]);
    // only the reporters differ: the same tests, the same pool, the same bound on workers as every plain run
    expect({ ...stryker, reporters: null }).toEqual({ ...base, reporters: null });
    expect(stryker.include.length, "the engine's tests are still selected").toBeGreaterThan(0);
  }, spawnBudget(3));

  it("the same file under GITHUB_ACTIONS unset names the same reporters (the reporter is not tied to CI)", () => {
    expect(names(resolved("vitest.stryker.config.ts", false))).toEqual(["default"]);
  });
});

describe("carry (c): the runner child's heap is capped, so a runaway mutant dies in seconds", () => {
  const args = strykerConfig().testRunnerNodeArgs as string[] | undefined;
  const cap = (() => {
    const m = /^--max-old-space-size=(\d+)$/.exec(args?.[0] ?? "");
    return m ? Number(m[1]) : NaN;
  })();

  it("stryker.config.mjs passes exactly one node arg to the test runner child, --max-old-space-size=<MB>", () => {
    expect(args, "testRunnerNodeArgs is set").toBeDefined();
    expect(args).toHaveLength(1);
    expect(Number.isInteger(cap), `${args?.[0]} is --max-old-space-size=<integer>`).toBe(true);
  });

  it("both option names are ones Stryker's own schema has (a misspelling would be ignored or refused only on a Sunday)", () => {
    const core = req.resolve("@stryker-mutator/core/package.json");
    const apiCore = createRequire(core).resolve("@stryker-mutator/api/core");
    const schema = JSON.parse(readFileSync(join(dirname(apiCore), "../../schema/stryker-core.json"), "utf8")) as { properties: Record<string, { type?: string; items?: { type?: string } }> };
    expect(schema.properties.testRunnerNodeArgs).toMatchObject({ type: "array", items: { type: "string" } });
    const runnerDir = dirname(req.resolve("@stryker-mutator/vitest-runner"));
    const runner = JSON.parse(readFileSync(join(runnerDir, "../schema/vitest-runner-options.json"), "utf8")) as { properties: { vitest: { properties: Record<string, unknown> } } };
    expect(Object.keys(runner.properties.vitest.properties)).toContain("configFile");
  });

  it("the cap is at least double the least cap the whole-engine dry run was seen to pass at, and above the one it failed at", () => {
    expect(DRY_RUN_FAILS_AT_MB).toBeLessThan(DRY_RUN_PASSES_AT_MB);
    expect(cap, "above a cap the dry run failed at").toBeGreaterThan(DRY_RUN_FAILS_AT_MB);
    expect(cap, "a margin of at least 2x over the least cap it passed at").toBeGreaterThanOrEqual(2 * DRY_RUN_PASSES_AT_MB);
  });

  it("and it is a cap that kills a runaway quickly and that the hosted runner's concurrent children fit in: 1024 MB, 3 children, half the runner's memory at most", () => {
    expect(cap).toBe(1024);
    expect(strykerConcurrency(HOSTED), "the hosted concurrency the sizing assumes").toBe(HOSTED_CONCURRENCY);
    expect(cap * HOSTED_CONCURRENCY * 1024 ** 2, "all the children at their cap").toBeLessThanOrEqual(HOSTED.memBytes / 2);
  });
});
