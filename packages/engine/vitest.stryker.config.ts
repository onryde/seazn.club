import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * The vitest every Stryker sandbox runs (stryker.config.mjs hands it to the runner as `vitest.configFile`): vitest.config.ts
 * exactly, with its reporters NAMED.
 *
 * With none named, vitest adds its `github-actions` reporter by itself whenever GITHUB_ACTIONS=true, and a crashed test-runner
 * child's stdout, which Stryker prints, then turns into `##[error]` annotations on a job that finished green (the hosted probe,
 * run 37330725739). `default` is what vitest would have picked without CI; naming it is what keeps the other one out.
 * test/stryker-runner.test.ts resolves both files through vitest, under GITHUB_ACTIONS=true.
 */
export default mergeConfig(base, defineConfig({ test: { reporters: ["default"] } }));
