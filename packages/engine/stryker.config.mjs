// Design §7.5 item 2 (W1d D14; rulings 66, 67): weekly mutation testing of the engine, placement scheduling excepted.
// One group per CI job (STRYKER_GROUP; the groups live in stryker.groups.mjs); incremental across weeks via the cached
// incremental file. Run it through `pnpm mutation` (package.json), from packages/engine.
import { availableParallelism, totalmem } from "node:os";
import process from "node:process";
import { STRYKER_GROUPS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "./stryker.groups.mjs";

/** @type {Record<string, string[] | undefined>} */
const groups = STRYKER_GROUPS;
const group = process.env.STRYKER_GROUP;
if (!group || groups[group] === undefined) throw new Error(`STRYKER_GROUP must be one of ${Object.keys(groups).join(", ")}`);

export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: groups[group],
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
