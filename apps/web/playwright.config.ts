import { defineConfig, devices } from "@playwright/test";

// E2E UI suite. Drives the real app in Chromium. Auth is provisioned once
// (auth.setup.ts → storageState) and reused across specs.
//
// Server:  a PRE-COMPILED production server, never `next dev` — dev's
//          per-request Turbopack compiles + half-RAM heap watchdog make a full
//          run flaky (transient 404s, restarts). Starting it is an explicit
//          PRECONDITION, not something this config does for you (#342, and the
//          `webServer` note at the bottom of this file): a server must already
//          be up on PLAYWRIGHT_BASE (:3000) against a migrated DB, and
//          e2e/global-setup.ts aborts the run with the recipe if it is missing
//          or broken. Because a prod build never dev-exposes `login_url`, local
//          runs need E2E_PROD_TARGET=1 + DATABASE_URL so the auth helpers mint
//          tokens in the DB (same as CI). Recipe: docs/runbooks/e2e-local.md.
//          CI: e2e.yml builds + starts against Postgres.
//
// Two projects, two phases (see the test:e2e script):
//   parallel — specs that only touch state they create (own competitions/
//              divisions); safe at several workers, tests within a file too.
//   serial   — specs entangled with shared org-level state: owned-org quota
//              (billing, billing-states, org-management all mint orgs on the
//              shared Pro user — cap + reasoning in e2e/auth.setup.ts,
//              "ORG BUDGET"), the community org's competitions.max_active
//              slots (journey-community, device-links), org renames, plan
//              flips, and the single Pro scorer seat. One worker, one file at
//              a time — `npm run test:e2e` runs this phase with --workers=1.
const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";
const AUTH_STATE = "e2e/.auth/pro.json";

const SERIAL_SPECS =
  /(journey-pro|journey-community|org-management|billing|billing-states|billing-groups|billing-groups-journey|members-roles|scorer|device-links|division-delete|pricing-v3|player-accounts|fixture-config-snapshot)\.spec\.ts/;

// --- how e2e.yml splits the `parallel` project across three jobs ------------
//
// Playwright's own `--shard` splits by TEST COUNT over a CONTIGUOUS run of
// test groups in file order (`filterForShard` in the runner: it sums
// `group.tests.length` and takes a slice). It knows nothing about how long a
// test takes, and e2e/scorepad-v3-cricket.spec.ts alone is ~90s of this
// project's ~368s — a quarter of the work in ONE file, sitting in the
// alphabetical tail, so `--shard=3/3` always inherited it.
//
// Measured Playwright-step times, shards 1/2/3:
//   run 32272599493   89s /  87s / 176s
//   run 32269332414   87s /  77s / 170s
//   run 32214432854  147s / 112s / 227s
// The third shard was not merely uneven, it was the whole workflow's
// wall-clock floor — the run finished when it finished.
//
// E2E_PARALLEL_SLICE moves the expensive files into a leg of their own and
// lets the other two shard the remainder:
//   "heavy"  -> only PARALLEL_HEAVY
//   "rest"   -> everything except PARALLEL_HEAVY, then --shard=N/2
//   unset    -> the whole project, unchanged — every local run, and
//               `npm run test:e2e`, take this path
//
// PARALLEL_HEAVY holds three files, not one, and the count is derived rather
// than chosen. Carving out only the cricket spec leaves the remainder's own
// alphabetical first half heavy (marketing-ai-demo, ai-architect, board-v3,
// games all land there) and predicts 90 / 158 / 120s — better than 176s, but
// still 29% off balance. Searched over the subsets of the twelve most
// expensive files, against per-file durations recovered from the line
// reporter's timestamps on runs 32272599493 / 32269332414 / 32214432854, this
// set is the flattest available: a predicted 128 / 126 / 115s against a
// perfect-split floor of 123s.
//
// Read the target as a WORKFLOW property, the way this file's e2e.yml header
// already insists. At ~128s plus ~106s of setup these legs land at ~234s,
// just under `e2e-mobile`'s phones-small leg (244s). That leg becomes the
// run's floor, so balancing this project any harder — or sharding it any
// finer — buys nothing at all. Revisit against the new floor, not these
// numbers.
//
// "rest" is a CATCH-ALL by construction: it ignores PARALLEL_HEAVY and nothing
// else. A new spec file therefore joins the sharded remainder automatically.
// Only a file NAMED here can leave it — which is the whole reason this is a
// single carve-out regex rather than three explicit per-shard file lists, a
// shape that drops a new spec on the floor the moment someone forgets to add
// it. apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts pins that property,
// and proves every file named here is real — a typo would otherwise give the
// heavy leg fewer tests than it thinks and go green while they run nowhere.
const PARALLEL_HEAVY = /(scorepad-v3-cricket|marketing-ai-demo|board-v3)\.spec\.ts/;
const PARALLEL_SLICE = process.env.E2E_PARALLEL_SLICE;

// --- the walkthrough leg ---------------------------------------------------
//
// e2e/walkthrough/ holds the specs that play a WHOLE match by hand — from the
// pre-match screen through the decider — rather than asserting on a slice of
// behaviour. They exist because cricket and football each shipped a broken
// decider through two signed-off waves: every surface asserted on code, and
// nothing ever tapped the thing (#667, #670).
//
// Carved into their own leg for two reasons, in this order:
//
//  1. ATTRIBUTION. These are the suite's product-level proofs. A red leg named
//     "walkthrough" says "a scorer cannot finish a match", which is a
//     different alarm from "a shard failed" and wants reading differently.
//  2. BALANCE. Measured locally, warm server, one worker per file:
//     deciders-byhand 7s, deciders-fullmatch 64s, tennis-mtb 174s of test time
//     (~245s total, but ~174s wall clock at 2 workers — tennis-mtb is ONE test
//     and cannot be split). Left in the sharded remainder that lands as ~122s
//     on each "rest" leg; carved out, the rest legs return to their designed
//     ~128s and this leg costs ~174s + setup.
//
// Read the trade honestly before moving it: a separate job re-pays the whole
// ~106s setup (Flyway, sport sync, prod build, placement image, server), so
// this leg lands around ~280s and becomes the workflow's wall-clock floor,
// which e2e-mobile's phones-small leg (~244s) held before it. That is ~30s of
// wall clock bought for isolation and a legible failure. If it ever needs
// winning back, tennis-mtb is the whole lever — one test, ~174s, most of it
// deliberate waits clearing the pad's double-submit guard.
// ANCHORED ON `e2e/` deliberately. Playwright matches `testMatch`/`testIgnore`
// against the file's ABSOLUTE path, not a path relative to `testDir`, so a
// bare /walkthrough\// also matches every checkout that happens to live under
// a directory of that name — which is not hypothetical: developing this in a
// worktree at .claude/worktrees/walkthrough/ made the pattern select the whole
// suite, `helpers.ts` included, and Playwright then rejected every spec with
// `test file "ai-architect.spec.ts" should not import test file "helpers.ts"`.
const WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/;

export default defineConfig({
  testDir: "./e2e",
  // Runs before EVERY project, `setup` included: proves the server on BASE is a
  // working build of this app, or aborts the whole run with the fix (#342).
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true, // parallel project only — the serial phase runs with --workers=1
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "parallel",
      // S13/#422 — the v2 scoring-pad e2e spec used to run in its own
      // Playwright project, against a second, flag-forced server (a project
      // this comment used to sit above). The feature flag that used to gate
      // the v2 pad has been removed entirely — v2 is the only pad — so that
      // spec runs here like any other now, against the one server every
      // other parallel spec already uses.
      // Spread rather than `testMatch: cond ? X : undefined` so the unset and
      // "rest" slices leave the key ABSENT and keep Playwright's default
      // testMatch, instead of handing it an explicit undefined.
      ...(PARALLEL_SLICE === "heavy" ? { testMatch: PARALLEL_HEAVY } : {}),
      testIgnore: [
        SERIAL_SPECS,
        /mobile\.spec\.ts/,
        // The walkthrough leg runs these; without this they would run TWICE.
        WALKTHROUGH,
        ...(PARALLEL_SLICE === "rest" ? [PARALLEL_HEAVY] : []),
      ],
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
    // Whole matches, played by hand, through the decider. Its own leg — see
    // WALKTHROUGH above for why, and for what it costs.
    {
      name: "walkthrough",
      testMatch: WALKTHROUGH,
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
    {
      name: "serial",
      testMatch: SERIAL_SPECS,
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
    // v3/02 §4 viewport gate: mobile.spec.ts runs at both reference phones —
    // iPhone SE (375×667) and iPhone 14 (390×844). Desktop projects ignore it.
    {
      name: "mobile-se",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 667 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile-14",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    // #349 responsive matrix — the five widths beyond the 375/390 references.
    // Full suite per width (owner decision, spec §1): every gate assertion
    // holds at every width; LCP self-pins to 375/390 inside the test.
    {
      name: "mobile-320",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 568 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile-360",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 800 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile-430",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 430, height: 932 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    {
      name: "tablet-768",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 768, height: 1024 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    {
      name: "tablet-834",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 834, height: 1194 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    // v3/R1 Task 10 — the productized gallery capture harness
    // (e2e/gallery.capture.ts). Deliberately named `.capture.ts`, not
    // `.spec.ts`, so it falls outside every OTHER project's default
    // testMatch and a plain `npm run test:e2e` sweep never selects it even
    // without this entry — but that same fact means NO project resolves it
    // at all without one. This project exists only so the harness is
    // actually invokable; it changes nothing about any other project's
    // matching. It is doubly guarded on top of that: the file's own
    // `test.skip(!process.env.GALLERY_DIR)` skips every test here unless
    // GALLERY_DIR is set, so `npx playwright test --project=gallery` with
    // no env var is a same no-op. No `storageState`/`setup` dependency —
    // each capture mints and logs in as its own fresh Pro org (loginUi,
    // PROD_TARGET-safe via mintLoginPathBySql — no shared-account budget or
    // magic-link rate limit involved). See docs/runbooks/pad-gallery.md.
    {
      name: "gallery",
      testMatch: /gallery\.capture\.ts/,
      // One worker, one sport at a time: the file's own `test.afterAll`
      // writes ONE shared `index.html` manifest into GALLERY_DIR once every
      // sport has captured, which is only race-free if the 12 per-sport
      // tests never run concurrently (they'd otherwise land across separate
      // worker processes, each with its own afterAll firing independently).
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // NO `webServer` BLOCK, deliberately (#342). It used to run
  // `npm run build && npm run start`, which was wrong in three ways at once:
  //
  //   1. `next start` does not serve an `output: standalone` build. It prints
  //      `⚠ "next start" does not work with "output: standalone" configuration`
  //      and serves the non-standalone tree — i.e. not what production runs.
  //   2. It could only ever fire when nothing was listening, at which point it
  //      spent 5+ minutes building INSIDE a test run, mutating .next and
  //      leaving a stale .next/lock behind when the run was killed.
  //   3. It made the environment implicit. A run that quietly arranged its own
  //      broken server is exactly how this suite reported a green that meant
  //      nothing.
  //
  // The server is now a precondition you start yourself (docs/runbooks/e2e-local.md),
  // and e2e/global-setup.ts turns a missing or broken one into an immediate,
  // explicit abort instead of a build. Nothing in CI changes: e2e.yml starts its
  // own server, so `reuseExistingServer` meant this block never ran there — and
  // e2e.yml already sets SCHEDULING_AI_BASE_URL / ANTHROPIC_API_KEY (the v4 AI
  // fixture vars this block used to inject) job-wide. A locally started server
  // needs them too; the runbook lists them.
});
