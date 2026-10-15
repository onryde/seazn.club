import { defineConfig, devices } from "@playwright/test";

// T17B fix 2, D22 - the 30-board load test (e2e/load/chess-30-boards.load.ts, which says how to run it).
//
// A config of its own, and NOT a project of playwright.config.ts: the load test is minutes long, drives a whole round
// through the fixture vendors, and must never ride along in CI's parallel/serial legs. The files are `*.load.ts`, which
// the main config's default testMatch (`*.spec.ts`) does not see, so nothing there changes. It reuses the same
// preflight (global-setup.ts: refuses a server that is not a working build) and the same provisioned Pro account
// (auth.setup.ts), which is why `setup` is a project here too.
const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 30 * 60_000,
  use: { baseURL: BASE },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "load",
      testMatch: /[\\/]e2e[\\/]load[\\/].*\.load\.ts$/,
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/pro.json" },
      dependencies: ["setup"],
    },
  ],
});
