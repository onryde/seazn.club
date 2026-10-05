// Design §7.5 item 2 (W1d D14; rulings 66, 67): weekly mutation testing of the engine, placement scheduling excepted.
// One group per CI job (STRYKER_GROUP; the groups live in stryker.groups.mjs); incremental across weeks via the cached
// incremental file. Run it through `pnpm mutation` (package.json), from packages/engine.
import { availableParallelism, totalmem } from "node:os";
import process from "node:process";
import { resolveGroup } from "./scripts/stryker-cuts.mjs";
import { STRYKER_GROUPS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "./stryker.groups.mjs";

/** @type {Record<string, string[] | undefined>} */
const groups = STRYKER_GROUPS;
const group = process.env.STRYKER_GROUP;
if (!group || groups[group] === undefined) throw new Error(`STRYKER_GROUP must be one of ${Object.keys(groups).join(", ")}`);

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
  mutate: resolveGroup(group),
  // Stryker's default for the initial test run is 5 minutes, below D14's own 344 s floor for it on CI, so a normal dry run would
  // be abandoned as hung. Allow the floor times the CI slowdown: 344 s x 8 = 45.9 minutes, 46. The job's own timeout
  // (stryker-timeouts.json) still bounds the whole run; this only decides when a HUNG dry run is given up on.
  dryRunTimeoutMinutes: Math.ceil((DRY_RUN_FLOOR_SECONDS * CI_SLOWDOWN) / 60),
  // Stryker's default, stated: the dry run runs only the test files related (by import) to the mutated files, which is what the
  // measured 42 s dry run and 26 runner-seconds per mutant were taken with. The dry run's own warning ("Vitest failed to find
  // test files related to mutated files") is what a leg whose files no test imports would print.
  vitest: { related: true },
  // The vitest runner ignores this and always uses perTest; the config states what it gets.
  coverageAnalysis: "perTest",
  incremental: true,
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
};
