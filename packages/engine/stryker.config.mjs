// Design §7.5 item 2 (W1d D14; rulings 66, 67): weekly mutation testing of the engine, placement scheduling excepted.
// One group per CI job (STRYKER_GROUP; the groups live in stryker.groups.mjs); incremental across weeks via the cached
// incremental file. Run it through `pnpm mutation` (package.json), from packages/engine.
import { availableParallelism, totalmem } from "node:os";
import process from "node:process";
import { parseMutateRanges } from "./scripts/stryker-changed.mjs";
import { resolveGroup } from "./scripts/stryker-cuts.mjs";
import { STRYKER_GROUPS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "./stryker.groups.mjs";

/** @type {Record<string, string[] | undefined>} */
const groups = STRYKER_GROUPS;
// W2a Task 0b: STRYKER_MUTATE (changed-lines) wins over STRYKER_GROUP. Unset, the config is the group config, unchanged.
const changed = process.env.STRYKER_MUTATE;
const group = changed === undefined ? process.env.STRYKER_GROUP : "changed";
if (changed === undefined && (!group || groups[group] === undefined)) throw new Error(`STRYKER_GROUP must be one of ${Object.keys(groups).join(", ")}`);

/** D14's dry-run floor in seconds: the figure the sizing (test/stryker-sizing.test.ts) takes a leg's first, whole test run to
 *  be at least, measured on CI. */
const DRY_RUN_FLOOR_SECONDS = 344;
/** How many times slower than that floor a CI run can be while it is still sound: the review's figure, CI about 8 times slower
 *  than a local run, with the vitest runner forcing ONE worker per sandbox. */
const CI_SLOWDOWN = 8;

export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  // A leg's parts of a split file (`file#N`) become Stryker's `file:a-b` here, from the statements the TypeScript parser reads.
  // Changed-lines (STRYKER_MUTATE): exactly the ranges it names, checked by scripts/stryker-changed.mjs.
  mutate: changed === undefined ? resolveGroup(group) : parseMutateRanges(changed, import.meta.dirname),
  // Stryker's default for the initial test run is 5 minutes, below D14's own 344 s floor for it on CI, so a normal dry run would
  // be abandoned as hung. Allow the floor times the CI slowdown: 344 s x 8 = 45.9 minutes, 46. The job's own timeout
  // (stryker-timeouts.json) still bounds the whole run; this only decides when a HUNG dry run is given up on.
  dryRunTimeoutMinutes: Math.ceil((DRY_RUN_FLOOR_SECONDS * CI_SLOWDOWN) / 60),
  // Stryker's default, stated: the dry run runs only the test files related (by import) to the mutated files, which is what the
  // measured dry runs (153 s hosted for the probe, run 37330725739; every leg's, run 37371368951) and the legs' walls were taken with.
  // The dry run's own warning ("Vitest failed to find test files related to mutated files") is what a leg whose files no test
  // imports would print.
  // `configFile` is the engine's vitest config with its reporters named (vitest.stryker.config.ts): without them vitest adds its
  // github-actions reporter on CI, and a crashed runner child's stdout becomes `##[error]` annotations on a green job.
  vitest: { related: true, configFile: "vitest.stryker.config.ts" },
  // The vitest runner ignores this and always uses perTest; the config states what it gets.
  coverageAnalysis: "perTest",
  // A changed-lines run is never incremental: it reads no leg's incremental file and writes none.
  incremental: changed === undefined,
  incrementalFile: `reports/mutation/${group}.incremental.json`,
  reporters: ["json", "clear-text", "progress"],
  jsonReporter: { fileName: `reports/mutation/${group}.json` },
  // The floor file (stryker-floor.json, scripts/stryker-floor.ts), not Stryker's own `break`, gates (D14).
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 60000,
  // Each Stryker sandbox runs the engine's vitest, z3-WASM files included. Total vitest workers across sandboxes stay
  // within vitest.config.ts's own bound; a fixed 4 would OOM a 16 GB runner (I11b, R2-I4).
  concurrency: strykerConcurrency({ cores: availableParallelism(), memBytes: totalmem(), workersPerSandbox: STRYKER_VITEST_WORKERS }),
  tempDirName: ".stryker-tmp",
  // A mutant that turns a counter into a runaway loop is killed by the heap, not by anything quicker: the hosted probe lost about
  // 14 runner-minutes to three of them (run 37330725739), each retried twice. The cap is on the heap of the runner child's test
  // worker (it overrides the thread's own resource limit). MEASURED (test/stryker-runner.test.ts): the whole-engine dry run, the
  // largest there is, passes at 256 MB and fails at 128; a runaway allocating loop in a worker thread died in 13.9 s at 1024 MB
  // and 42.3 s at 4096. 1024 is 4x the least that passes, and 3 children at it are a fifth of a 16 GB runner.
  testRunnerNodeArgs: ["--max-old-space-size=1024"],
};
