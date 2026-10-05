// Design §7.5 item 2 (W1d D14; owner rulings 66, 67): the Stryker groups of the engine, placement scheduling excepted.
// One group (a "leg") per CI job (mutation.yml reads these keys for its matrix and its dispatch choices); stryker.config.mjs
// mutates exactly one of them per run (STRYKER_GROUP). test/stryker-groups.test.ts gives every non-test .ts under src/ exactly one
// home: a group below, a named exclusion, or the ruling-67 placement exclusion, and fails with the count of files that have
// none, so a new source file cannot slip past the weekly run unmeasured.
//
// Plain .mjs (stryker.config.mjs, scripts/stryker-matrix.mjs and the workflow's `node` step all load it without a TS
// loader); stryker.groups.d.mts types it for the engine's .ts tests (the engine tsconfig includes test/**, and a .ts
// importing an untyped .mjs is TS7016). The two declare the same five exports; a test holds them equal.

/** `src/` co-locates its tests (`*.test.ts`) and one `__tests__/` helper directory, and a glob group without these
 *  negations would have Stryker mutate test files (review I11a). A leg lists them last. */
const NO_TESTS = ["!src/**/*.test.ts", "!src/**/__tests__/**"];

/** One leg (= one CI job) per key. A leg is a list of Stryker `mutate` entries, read in order, as Stryker itself reads them:
 *  a glob adds files, `!glob` removes them, and `file:a-b` adds only the lines a..b (1-based, inclusive) of that file. The
 *  last range of a split file ends at 99999, which is how a range says "to the end of the file", so lines added at the foot
 *  stay in the last leg. A directory leg lists the test-file negations LAST (`...NO_TESTS`).
 *
 *  SIZING (T15-SIZE, rulings 66, 67, D14). A leg's wall time is its mutant count times the measured cost of one mutant, so
 *  the legs are cut from Stryker's own dry-run count (its "Instrumented N source file(s) with M mutant(s)" line), never from
 *  line counts. The probe's real run measured 26 runner-seconds per mutant (134 mutants, 740 s at concurrency 5, 187 tests
 *  per mutant); D14's formula assumed 10 / 3 = 3.33 s of wall time per mutant at CI's concurrency of 3, and the measured
 *  figure is 26 / 3 = 8.67 s, 2.6 times as slow. At that rate a leg is under the 200-minute split line only while it holds
 *  at most 1,344 mutants; these legs hold at most 1,162, which leaves about 14% for the source to grow. Task 20 re-measures
 *  on CI. test/stryker-sizing.test.ts holds every leg to the line, from a fresh instrumenter count.
 *
 *  Where one FILE is over the line, it is cut with ranges at top-level statement ends: a cut inside a statement loses the
 *  mutants of every node that spans it (a function body, an object literal), and the same test proves the ranges lose none.
 *  The six `sports-*` families split src/sports/ by sport family (each is one kernel with its own tests). */
export const STRYKER_GROUPS = {
  // competition/ (2,556 mutants): two explicit legs, and the directory glob keeps the rest, new files included.
  "competition-tiebreakers": ["src/competition/tiebreakers.ts", "src/competition/points.ts"],
  "competition-progression": ["src/competition/progression.ts", "src/competition/stage.ts"],
  competition: [
    "src/competition/**/*.ts",
    "!src/competition/tiebreakers.ts",
    "!src/competition/points.ts",
    "!src/competition/progression.ts",
    "!src/competition/stage.ts",
    ...NO_TESTS,
  ],
  core: ["src/core/**/*.ts", ...NO_TESTS],
  // modules (2,524 mutants): three legs by directory.
  "modules-io": ["src/import/**/*.ts", "src/exports/**/*.ts", ...NO_TESTS],
  "modules-sport": ["src/sport/**/*.ts", "src/stats/**/*.ts", ...NO_TESTS],
  "modules-people": ["src/officials/**/*.ts", "src/history/**/*.ts", ...NO_TESTS],
  // The draw generators (ruling 67 lists them): format code, so in scope though they sit beside the placement files.
  "draws-bracket": ["src/scheduling/bracket.ts", "src/scheduling/bracket-layout.ts", "src/scheduling/feedgraph.ts"],
  "draws-pairing": ["src/scheduling/swiss.ts", "src/scheduling/roundrobin.ts", "src/scheduling/americano.ts", "src/scheduling/participants.ts"],
  // cricket (5,123 mutants): everything but cricket.ts, then cricket.ts (4,248) in four ranges.
  "sports-cricket": ["src/sports/cricket/**/*.ts", "!src/sports/cricket/cricket.ts", ...NO_TESTS],
  "sports-cricket-kernel-1": ["src/sports/cricket/cricket.ts:1-1354"],
  "sports-cricket-kernel-2": ["src/sports/cricket/cricket.ts:1355-2371"],
  "sports-cricket-kernel-3": ["src/sports/cricket/cricket.ts:2372-3522"],
  "sports-cricket-kernel-4": ["src/sports/cricket/cricket.ts:3523-99999"],
  // football (2,597 mutants, all in football.ts): three ranges; the last leg also holds the directory's other files.
  "sports-football-1": ["src/sports/football/football.ts:1-1490"],
  "sports-football-2": ["src/sports/football/football.ts:1491-2435"],
  "sports-football-3": ["src/sports/football/**/*.ts", "!src/sports/football/football.ts", "src/sports/football/football.ts:2436-99999", ...NO_TESTS],
  // period (3,040 mutants): kernel.ts (2,169) in two ranges, and the rest of the family.
  "sports-period-1": ["src/sports/period/kernel.ts:1-1478"],
  "sports-period-2": ["src/sports/period/kernel.ts:1479-99999"],
  "sports-period-3": ["src/sports/period/**/*.ts", "src/sports/hockey/**/*.ts", "src/sports/icehockey/**/*.ts", "!src/sports/period/kernel.ts", ...NO_TESTS],
  // setbased (2,210 mutants): kernel.ts (1,809) in two ranges; the second leg also holds the other files (401 mutants).
  "sports-setbased-1": ["src/sports/setbased/kernel.ts:1-1827"],
  "sports-setbased-2": ["src/sports/setbased/**/*.ts", "src/sports/tennis/**/*.ts", "!src/sports/setbased/kernel.ts", "src/sports/setbased/kernel.ts:1828-99999", ...NO_TESTS],
  // nested (1,713 mutants, all in kernel.ts): two ranges.
  "sports-nested-1": ["src/sports/nested/kernel.ts:1-1415"],
  "sports-nested-2": ["src/sports/nested/**/*.ts", "!src/sports/nested/kernel.ts", "src/sports/nested/kernel.ts:1416-99999", ...NO_TESTS],
  // other (2,591 mutants): carrom, generic, and boardgame with the top-level files.
  "sports-other-carrom": ["src/sports/carrom/**/*.ts", ...NO_TESTS],
  "sports-other-generic": ["src/sports/generic/**/*.ts", ...NO_TESTS],
  "sports-other": [
    "src/sports/boardgame/**/*.ts",
    "src/sports/*.ts", // the top-level index.ts and squad-state.ts
    ...NO_TESTS,
  ],
  // The PR self-proof (D3): one draw generator with a co-located test (roundrobin.test.ts). It is NOT a home in the sweep:
  // roundrobin.ts is in `draws-pairing` too, and a PR runs only this. 134 mutants, measured.
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
