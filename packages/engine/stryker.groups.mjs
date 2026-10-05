// Design §7.5 item 2 (W1d D14; owner rulings 66, 67): the Stryker groups of the engine, placement scheduling excepted.
// One group per CI job (mutation.yml reads these keys for its matrix and its dispatch choices); stryker.config.mjs mutates
// exactly one of them per run (STRYKER_GROUP). test/stryker-groups.test.ts gives every non-test .ts under src/ exactly one
// home: a group below, a named exclusion, or the ruling-67 placement exclusion, and fails with the count of files that have
// none, so a new source file cannot slip past the weekly run unmeasured.
//
// Plain .mjs (stryker.config.mjs, scripts/stryker-matrix.mjs and the workflow's `node` step all load it without a TS
// loader); stryker.groups.d.mts types it for the engine's .ts tests (the engine tsconfig includes test/**, and a .ts
// importing an untyped .mjs is TS7016). The two declare the same five exports; a test holds them equal.

/** `src/` co-locates its tests (`*.test.ts`) and one `__tests__/` helper directory, and a glob group without these
 *  negations would have Stryker mutate test files (review I11a). Negations come after every positive. */
const NO_TESTS = ["!src/**/*.test.ts", "!src/**/__tests__/**"];

/** Globs relative to packages/engine, as Stryker's `mutate` reads them. The six `sports-*` groups split src/sports/ by
 *  sport family (each family is one kernel with its own tests). It is an initial split, re-justified from the dry run's
 *  mutant count per group (mutation.yml's matrix and stryker-timeouts.json), never from line counts. */
export const STRYKER_GROUPS = {
  competition: ["src/competition/**/*.ts", ...NO_TESTS],
  core: ["src/core/**/*.ts", ...NO_TESTS],
  modules: [
    "src/sport/**/*.ts",
    "src/stats/**/*.ts",
    "src/history/**/*.ts",
    "src/officials/**/*.ts",
    "src/import/**/*.ts",
    "src/exports/**/*.ts",
    ...NO_TESTS,
  ],
  // The draw generators (ruling 67 lists them): format code, so in scope though they sit beside the placement files.
  draws: [
    "src/scheduling/bracket.ts",
    "src/scheduling/bracket-layout.ts",
    "src/scheduling/roundrobin.ts",
    "src/scheduling/swiss.ts",
    "src/scheduling/americano.ts",
    "src/scheduling/participants.ts",
    "src/scheduling/feedgraph.ts",
  ],
  // cricket.ts alone is 4,248 of the family's 5,123 mutants (the dry run's count), which put the family's estimate over the
  // 200-minute split line; the file is carved out into its own group and the directory glob keeps everything else, new
  // files included. One file cannot be split further by file: see stryker-timeouts.json and the task report.
  "sports-cricket": ["src/sports/cricket/**/*.ts", "!src/sports/cricket/cricket.ts", ...NO_TESTS],
  "sports-cricket-kernel": ["src/sports/cricket/cricket.ts"],
  "sports-football": ["src/sports/football/**/*.ts", ...NO_TESTS],
  "sports-period": ["src/sports/period/**/*.ts", "src/sports/hockey/**/*.ts", "src/sports/icehockey/**/*.ts", ...NO_TESTS],
  "sports-setbased": ["src/sports/setbased/**/*.ts", "src/sports/tennis/**/*.ts", ...NO_TESTS],
  "sports-nested": ["src/sports/nested/**/*.ts", ...NO_TESTS],
  "sports-other": [
    "src/sports/generic/**/*.ts",
    "src/sports/boardgame/**/*.ts",
    "src/sports/carrom/**/*.ts",
    "src/sports/*.ts", // the top-level index.ts and squad-state.ts
    ...NO_TESTS,
  ],
  // The PR self-proof (D3): one draw generator with a co-located test (roundrobin.test.ts). It is NOT a home in the sweep:
  // roundrobin.ts is in `draws` too, and a PR runs only this.
  probe: ["src/scheduling/roundrobin.ts"],
};

const PLACEMENT_REASON = "ruling 67: placement scheduling, low priority (a later wave may lift this)";

/** Ruling 67's named exclusion: the placement build, calendar and repair files, 19 exact files. A later wave may lift it,
 *  by moving a file into a group. */
export const STRYKER_PLACEMENT_OUT_OF_SCOPE = Object.fromEntries(
  [
    // build
    "build", "build-grid", "build-objectives", "constraints", "candidate-courts",
    // calendar
    "calendar", "capacity", "health", "court-windows", "tz", "grid-step", "rest-floor",
    // repair
    "repair-domain", "repair-decompose-cpsat", "repair-decompose", "repair-synthetic-board", "repair-minimality", "conflict-detail", "report",
  ].map((name) => [`src/scheduling/${name}.ts`, PLACEMENT_REASON]),
);

/** Globs (relative to packages/engine) that are never measured, each with its OWN reason. Every src/scheduling/ entry is
 *  named by ruling 67's last bullet. */
export const STRYKER_EXCLUDED = {
  "src/scheduling/index.ts": "a barrel: re-exports only, no logic to mutate",
  "src/scheduling/logger.ts": "holds no logic: it builds the pino logger and nothing else",
  "src/scheduling/solver-test-bounds.ts": "a test helper: the bounds the solver tests run under, not product code",
  "src/scheduling/placement-client.ts": "the gRPC client, covered only by integration tests that need the placement service",
  // Decided from the file itself (opened 2026-10-04; ruling 67 conditions the exclusion on it "only building the placement
  // request"): it builds no request, it is test fixtures for the calendar and repair tests, which is the stated reason. It builds
  // frozen calendar `Assignment`s, golden slots and order dependencies, and only calendar-*.test.ts, repair-domain.test.ts,
  // participants-rules.test.ts (as test input) and the out-of-scope repair-synthetic-board.ts import it. It feeds no draw or
  // format code. test/stryker-groups.test.ts pins that no in-scope production file imports it: if one ever does, move it into
  // `draws` and say so in the task report.
  "src/scheduling/payload-fixtures.ts": "test fixtures for the calendar and repair tests (frozen assignments and golden slots), not a placement request and not draw code",
  "src/scheduling/generated/**": "generated protobuf stubs for the placement service, regenerated by gen:proto",
  "src/testkit/**": "ruling 67: test helpers, not product",
};

/** Vitest workers ONE Stryker sandbox runs. @stryker-mutator/vitest-runner 10.0.0 forces it: for vitest >= 4.1 its
 *  #getVitestPoolConfig returns `{ pool: 'threads', maxWorkers: 1 }` (node_modules/@stryker-mutator/vitest-runner/dist/src/
 *  vitest-test-runner.js:50-53, the last return), overriding the engine's own `maxWorkers`. So concurrency equals vitest's own
 *  bound. test/stryker-groups.test.ts reads that file, so a runner upgrade that changes it reds there. */
export const STRYKER_VITEST_WORKERS = 1;

const GB = 1024 ** 3;

/** Stryker's `concurrency`: how many sandboxes run at once. The quantity bounded is TOTAL vitest workers, not sandboxes,
 *  so it stays within the bound the engine's own suite was sized for (z3 WASM files hold a heap that only grows; a fixed 4
 *  would OOM a 16 GB runner: review I11b, R2-I4).
 *
 *  The bound is a COPY of vitest.config.ts's `maxWorkers` formula (there:
 *  `Math.max(2, Math.min(availableParallelism() - 1, Math.floor(totalmem() / (3 * GB))))`). test/stryker-groups.test.ts pins
 *  that text in vitest.config.ts, so a moved formula reds there rather than in an OOM on a Sunday. */
export function strykerConcurrency({ cores, memBytes, workersPerSandbox }) {
  const bound = Math.max(2, Math.min(cores - 1, Math.floor(memBytes / (3 * GB))));
  return Math.max(1, Math.floor(bound / workersPerSandbox));
}
