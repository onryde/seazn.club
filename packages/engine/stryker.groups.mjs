// Design §7.5 item 2 (W1d D14; owner rulings 66, 67): the Stryker groups of the engine, placement scheduling excepted.
// One group (a "leg") per CI job (mutation.yml reads these keys for its matrix and its dispatch choices); stryker.config.mjs
// mutates exactly one of them per run (STRYKER_GROUP). test/stryker-groups.test.ts gives every non-test .ts under src/ exactly one
// home: a group below, a named exclusion, or the ruling-67 placement exclusion, and fails with the count of files that have
// none, so a new source file cannot slip past the weekly run unmeasured.
//
// Plain .mjs (stryker.config.mjs, scripts/stryker-matrix.mjs and the workflow's `node` step all load it without a TS
// loader); stryker.groups.d.mts types it for the engine's .ts tests (the engine tsconfig includes test/**, and a .ts
// importing an untyped .mjs is TS7016). The two declare the same exports; a test holds them equal. Where a file is cut into
// parts (STRYKER_SPLITS), scripts/stryker-cuts.mjs resolves a part to the `file:a-b` range Stryker reads (T15-CUT).

/** `src/` co-locates its tests (`*.test.ts`) and one `__tests__/` helper directory, and a glob group without these
 *  negations would have Stryker mutate test files (review I11a). A leg lists them last. */
const NO_TESTS = ["!src/**/*.test.ts", "!src/**/__tests__/**"];

/** The files too big for one leg, each cut at top-level STATEMENT boundaries (T15-CUT) and, where one statement is itself bigger
 *  than a leg, between the MEMBERS of that declaration (T20-PRE). A cut is the name of the statement that STARTS the next part
 *  (an `export function`, `const`, `class`, `interface`, `type` or `enum` declares it), so `["a", "b"]` makes three parts: the
 *  statements before `a`, from `a` up to `b`, and from `b` to the end. A member anchor is `Host.member` (deeper: `Host.member.sub`):
 *  the member of the named declaration that starts the next part, as in `padSpec.twoInnings` or `cricket.outcome`.
 *
 *  A STATEMENT cut ends a part right after the last line of a statement, so a blank line, a comment or an edit anywhere cannot
 *  move it off its statement, and it loses no mutant. A MEMBER cut cannot be loss-free: Stryker keeps a mutant only if its whole
 *  node lies inside one part, so the declaration that holds the cut (its object literal, its function body) lies inside none,
 *  and that container's own mutant ("replace the body with {}") is held by no leg and so never scored. There are 9 of them in
 *  24,842; stryker-unscored.json names each by file, mutator, replacement and line text (the line number is information only), and test/stryker-sizing.test.ts holds the list equal to what the
 *  instrumenter finds. scripts/stryker-cuts.mjs resolves the cuts with the TypeScript parser, and test/stryker-cuts.test.ts proves
 *  it with Stryker's own instrumenter, with an edit at the top of cricket.ts. A rename of an anchor is a loud failure (no
 *  statement or member declares it), never a silent loss. The anchors are chosen by `pnpm --filter @seazn/engine mutation:recut
 *  <file> <parts> [--open <Host,...>]`, which minimises the largest part by Stryker's own mutant count. A leg takes part N of a
 *  file as `file#N`. */
export const STRYKER_SPLITS = {
  "src/competition/progression.ts": ["validateProgressionAgainstShapes"],
  "src/competition/tiebreakers.ts": ["directRefine"],
  "src/core/lineup.ts": ["moveTo"],
  "src/import/plan.ts": ["planImport.resolvePerson"],
  "src/sports/boardgame/boardgame.ts": ["boardgame"],
  "src/sports/carrom/carrom.ts": ["applyBoard", "carrom"],
  "src/sports/cricket/cricket.ts": ["CricketFollowOn", "closeOpenInnings", "DeliveryCtx", "finishDelivery", "boundaryCount", "requireOpenInnings", "generateBall", "withArrivals", "padSpec", "padSpec.twoInnings", "cricket.outcome", "cricket.arbitraryEvent.roll"],
  "src/sports/cricket/scorecard.ts": ["InningsAccumulator.onRetire"],
  "src/sports/football/football.ts": ["fairPlayPoints", "applySinBinStart", "applyAbandon", "liftSide", "football.variants", "football.arbitraryEvent"],
  "src/sports/generic/generic.ts": ["applyScore", "generic"],
  "src/sports/nested/kernel.ts": ["setGamesWinner", "applySetSummary", "PLAUSIBLE_INTERRUPTION_SECONDS", "makeNestedModule"],
  "src/sports/period/kernel.ts": ["sweepThroughPhase", "applyAdvance", "applyShot", "PeriodPreset", "makePeriodModule.officialScore", "makePeriodModule.declaredPointsSets"],
  "src/sports/setbased/kernel.ts": ["applyTimeout", "sideFieldsTheRotation", "setBasedPosition", "makeSetBasedModule.onLineup"],
};

/** One leg (= one CI job) per key. A leg is a list of `mutate` entries, read in order as Stryker itself reads them: a glob
 *  adds files, `!glob` removes them, and `file#N` adds only part N of a split file (STRYKER_SPLITS), which scripts/stryker-cuts.mjs
 *  turns into Stryker's `file:a-b` (the lines a..b, 1-based, inclusive). A directory leg lists the test-file negations LAST
 *  (`...NO_TESTS`).
 *
 *  SIZING (T15-SIZE, T20-PRE; rulings 66, 67, D14). A leg's wall time is its mutant count times the measured cost of one mutant,
 *  so the legs are cut from Stryker's own dry-run count (its "Instrumented N source file(s) with M mutant(s)" line), never from
 *  line counts. The cost is the HOSTED one: the probe's run on GitHub (run 37330725739, ubuntu-latest, 4 vCPU, concurrency 3)
 *  spent 3,400.6 s on its 134 mutants, 76.13 runner-seconds each, pinned at 77 runner-seconds a mutant (the local run had
 *  measured 26; a hosted runner is 2.9 times slower). D14's floor of 344 s for a dry run is added once per leg, and the leg's wall time at CI's
 *  concurrency of 3 is that floor plus 77 / 3 seconds a mutant. A leg is under the 200-minute split line only while it holds
 *  at most 454 mutants, and no leg holds more than that. It is ONE sample, on a file whose mutants survive 22% of the time
 *  (the first full dispatch is the second); test/stryker-sizing.test.ts says so and holds the rate to its derivation. It holds
 *  every leg to the line from a fresh instrumenter count, and when a leg is over it says which command re-cuts the file
 *  (`pnpm --filter @seazn/engine mutation:recut <file> <parts>`).
 *
 *  Floors are keyed by FAMILY (STRYKER_FAMILIES, ruling 66's ten groups), the sum of a family's legs, never by leg: cutting a
 *  file again or adding a leg changes the legs, and never removes a floor key (T15-CUT).
 *
 *  The six `sports-*` families split src/sports/ by sport family (each is one kernel with its own tests). */
export const STRYKER_GROUPS = {
  // ---- competition ----
  // competition/display.ts 123, competition/round-role.ts 144, competition/tie-what-if.ts 140
  "competition-1": ["src/competition/display.ts", "src/competition/round-role.ts", "src/competition/tie-what-if.ts"],
  // competition/points.ts 300; plus every other file under src/competition/ (new files land here)
  "competition-2": ["src/competition/**/*.ts", "!src/competition/display.ts", "!src/competition/progression.ts", "!src/competition/qualification.ts", "!src/competition/round-role.ts", "!src/competition/stage.ts", "!src/competition/standings.ts", "!src/competition/tie-what-if.ts", "!src/competition/tiebreakers.ts", ...NO_TESTS],
  // competition/progression.ts part 1/2 306
  "competition-3": ["src/competition/progression.ts#1"],
  // competition/progression.ts part 2/2 256, competition/qualification.ts 152
  "competition-4": ["src/competition/progression.ts#2", "src/competition/qualification.ts"],
  // competition/stage.ts 383
  "competition-5": ["src/competition/stage.ts"],
  // competition/standings.ts 39, competition/tiebreakers.ts part 1/2 363
  "competition-6": ["src/competition/standings.ts", "src/competition/tiebreakers.ts#1"],
  // competition/tiebreakers.ts part 2/2 350
  "competition-7": ["src/competition/tiebreakers.ts#2"],
  // ---- core ----
  // core/clock.ts 11, core/lineup.ts part 1/2 248, core/position.ts 96, core/types.ts 54
  "core-1": ["src/core/clock.ts", "src/core/lineup.ts#1", "src/core/position.ts", "src/core/types.ts"],
  // core/errors.ts 40, core/events.ts 264, core/time.ts 99
  "core-2": ["src/core/errors.ts", "src/core/events.ts", "src/core/time.ts"],
  // core/lineup.ts part 2/2 175, core/rng.ts 15; plus every other file under src/core/ (new files land here)
  "core-3": ["src/core/**/*.ts", "!src/core/clock.ts", "!src/core/errors.ts", "!src/core/events.ts", "!src/core/lineup.ts", "!src/core/position.ts", "!src/core/time.ts", "!src/core/types.ts", "src/core/lineup.ts#2", ...NO_TESTS],
  // ---- modules ----
  // exports/build.ts 405
  "modules-1": ["src/exports/build.ts"],
  // exports/types.ts 59, import/types.ts 60, sport/entrant-model.ts 62; plus every other file under src/import/, src/exports/, src/sport/, src/stats/, src/officials/, src/history/ (new files land here)
  "modules-2": ["src/import/**/*.ts", "src/exports/**/*.ts", "src/sport/**/*.ts", "src/stats/**/*.ts", "src/officials/**/*.ts", "src/history/**/*.ts", "!src/exports/build.ts", "!src/history/history.ts", "!src/history/types.ts", "!src/import/plan.ts", "!src/officials/assign.ts", "!src/officials/source.ts", "!src/officials/types.ts", "!src/sport/catalog.ts", "!src/sport/module.ts", "!src/sport/registry.ts", "!src/stats/stats.ts", ...NO_TESTS],
  // history/history.ts 283, officials/source.ts 90
  "modules-3": ["src/history/history.ts", "src/officials/source.ts"],
  // history/types.ts 6, officials/assign.ts 353, officials/types.ts 23
  "modules-4": ["src/history/types.ts", "src/officials/assign.ts", "src/officials/types.ts"],
  // import/plan.ts part 1/2 195, sport/module.ts 169
  "modules-5": ["src/import/plan.ts#1", "src/sport/module.ts"],
  // import/plan.ts part 2/2 269, sport/catalog.ts 139
  "modules-6": ["src/import/plan.ts#2", "src/sport/catalog.ts"],
  // sport/registry.ts 73, stats/stats.ts 337
  "modules-7": ["src/sport/registry.ts", "src/stats/stats.ts"],
  // ---- draws ----
  // scheduling/americano.ts 68, scheduling/participants.ts 95, scheduling/roundrobin.ts 134
  "draws-1": ["src/scheduling/americano.ts", "src/scheduling/participants.ts", "src/scheduling/roundrobin.ts"],
  // scheduling/bracket-layout.ts 359, scheduling/feedgraph.ts 22
  "draws-2": ["src/scheduling/bracket-layout.ts", "src/scheduling/feedgraph.ts"],
  // scheduling/bracket.ts 401
  "draws-3": ["src/scheduling/bracket.ts"],
  // scheduling/swiss.ts 407
  "draws-4": ["src/scheduling/swiss.ts"],
  // ---- sports-cricket ----
  // sports/cricket/cricket.ts part 1/13 136, sports/cricket/cricket.ts part 5/13 112, sports/cricket/dls.ts 120
  "sports-cricket-1": ["src/sports/cricket/cricket.ts#1", "src/sports/cricket/cricket.ts#5", "src/sports/cricket/dls.ts"],
  // sports/cricket/cricket.ts part 2/13 384
  "sports-cricket-2": ["src/sports/cricket/cricket.ts#2"],
  // sports/cricket/cricket.ts part 3/13 375
  "sports-cricket-3": ["src/sports/cricket/cricket.ts#3"],
  // sports/cricket/cricket.ts part 4/13 345
  "sports-cricket-4": ["src/sports/cricket/cricket.ts#4"],
  // sports/cricket/cricket.ts part 6/13 367
  "sports-cricket-5": ["src/sports/cricket/cricket.ts#6"],
  // sports/cricket/cricket.ts part 7/13 350
  "sports-cricket-6": ["src/sports/cricket/cricket.ts#7"],
  // sports/cricket/cricket.ts part 8/13 309; plus every other file under src/sports/cricket/ (new files land here)
  "sports-cricket-7": ["src/sports/cricket/**/*.ts", "!src/sports/cricket/cricket.ts", "!src/sports/cricket/dls.ts", "!src/sports/cricket/scorecard.ts", "src/sports/cricket/cricket.ts#8", ...NO_TESTS],
  // sports/cricket/cricket.ts part 9/13 383
  "sports-cricket-8": ["src/sports/cricket/cricket.ts#9"],
  // sports/cricket/cricket.ts part 10/13 379
  "sports-cricket-9": ["src/sports/cricket/cricket.ts#10"],
  // sports/cricket/cricket.ts part 11/13 347
  "sports-cricket-10": ["src/sports/cricket/cricket.ts#11"],
  // sports/cricket/cricket.ts part 12/13 374
  "sports-cricket-11": ["src/sports/cricket/cricket.ts#12"],
  // sports/cricket/cricket.ts part 13/13 384
  "sports-cricket-12": ["src/sports/cricket/cricket.ts#13"],
  // sports/cricket/scorecard.ts part 1/2 349
  "sports-cricket-13": ["src/sports/cricket/scorecard.ts#1"],
  // sports/cricket/scorecard.ts part 2/2 406
  "sports-cricket-14": ["src/sports/cricket/scorecard.ts#2"],
  // ---- sports-football ----
  // sports/football/football.ts part 1/7 362
  "sports-football-1": ["src/sports/football/football.ts#1"],
  // sports/football/football.ts part 2/7 393
  "sports-football-2": ["src/sports/football/football.ts#2"],
  // sports/football/football.ts part 3/7 367
  "sports-football-3": ["src/sports/football/football.ts#3"],
  // sports/football/football.ts part 4/7 379
  "sports-football-4": ["src/sports/football/football.ts#4"],
  // sports/football/football.ts part 5/7 338; plus every other file under src/sports/football/ (new files land here)
  "sports-football-5": ["src/sports/football/**/*.ts", "!src/sports/football/football.ts", "src/sports/football/football.ts#5", ...NO_TESTS],
  // sports/football/football.ts part 6/7 388
  "sports-football-6": ["src/sports/football/football.ts#6"],
  // sports/football/football.ts part 7/7 369
  "sports-football-7": ["src/sports/football/football.ts#7"],
  // ---- sports-period ----
  // sports/hockey/hockey.ts 321
  "sports-period-1": ["src/sports/hockey/hockey.ts"],
  // sports/icehockey/icehockey.ts 388
  "sports-period-2": ["src/sports/icehockey/icehockey.ts"],
  // sports/period/kernel.ts part 1/7 324, sports/period/shootout.ts 63
  "sports-period-3": ["src/sports/period/kernel.ts#1", "src/sports/period/shootout.ts"],
  // sports/period/kernel.ts part 2/7 321
  "sports-period-4": ["src/sports/period/kernel.ts#2"],
  // sports/period/kernel.ts part 3/7 280; plus every other file under src/sports/period/, src/sports/hockey/, src/sports/icehockey/ (new files land here)
  "sports-period-5": ["src/sports/period/**/*.ts", "src/sports/hockey/**/*.ts", "src/sports/icehockey/**/*.ts", "!src/sports/hockey/hockey.ts", "!src/sports/icehockey/icehockey.ts", "!src/sports/period/kernel.ts", "!src/sports/period/shootout.ts", "!src/sports/period/suspensions.ts", "src/sports/period/kernel.ts#3", ...NO_TESTS],
  // sports/period/kernel.ts part 4/7 306
  "sports-period-6": ["src/sports/period/kernel.ts#4"],
  // sports/period/kernel.ts part 5/7 307
  "sports-period-7": ["src/sports/period/kernel.ts#5"],
  // sports/period/kernel.ts part 6/7 318
  "sports-period-8": ["src/sports/period/kernel.ts#6"],
  // sports/period/kernel.ts part 7/7 311, sports/period/suspensions.ts 99
  "sports-period-9": ["src/sports/period/kernel.ts#7", "src/sports/period/suspensions.ts"],
  // ---- sports-setbased ----
  // sports/setbased/badminton.ts 66, sports/setbased/tabletennis.ts 67, sports/setbased/volleyball.ts 171; plus every other file under src/sports/setbased/, src/sports/tennis/ (new files land here)
  "sports-setbased-1": ["src/sports/setbased/**/*.ts", "src/sports/tennis/**/*.ts", "!src/sports/setbased/kernel.ts", "!src/sports/tennis/tennis.ts", ...NO_TESTS],
  // sports/setbased/kernel.ts part 1/5 398
  "sports-setbased-2": ["src/sports/setbased/kernel.ts#1"],
  // sports/setbased/kernel.ts part 2/5 394
  "sports-setbased-3": ["src/sports/setbased/kernel.ts#2"],
  // sports/setbased/kernel.ts part 3/5 370
  "sports-setbased-4": ["src/sports/setbased/kernel.ts#3"],
  // sports/setbased/kernel.ts part 4/5 254, sports/tennis/tennis.ts 97
  "sports-setbased-5": ["src/sports/setbased/kernel.ts#4", "src/sports/tennis/tennis.ts"],
  // sports/setbased/kernel.ts part 5/5 391
  "sports-setbased-6": ["src/sports/setbased/kernel.ts#5"],
  // ---- sports-nested ----
  // sports/nested/kernel.ts part 1/5 242; plus every other file under src/sports/nested/ (new files land here)
  "sports-nested-1": ["src/sports/nested/**/*.ts", "!src/sports/nested/kernel.ts", "src/sports/nested/kernel.ts#1", ...NO_TESTS],
  // sports/nested/kernel.ts part 2/5 365
  "sports-nested-2": ["src/sports/nested/kernel.ts#2"],
  // sports/nested/kernel.ts part 3/5 364
  "sports-nested-3": ["src/sports/nested/kernel.ts#3"],
  // sports/nested/kernel.ts part 4/5 370
  "sports-nested-4": ["src/sports/nested/kernel.ts#4"],
  // sports/nested/kernel.ts part 5/5 372
  "sports-nested-5": ["src/sports/nested/kernel.ts#5"],
  // ---- sports-other ----
  // sports/boardgame/boardgame.ts part 1/2 362
  "sports-other-1": ["src/sports/boardgame/boardgame.ts#1"],
  // sports/boardgame/boardgame.ts part 2/2 348
  "sports-other-2": ["src/sports/boardgame/boardgame.ts#2"],
  // sports/carrom/carrom.ts part 1/3 216, sports/generic/generic.ts part 1/3 167
  "sports-other-3": ["src/sports/carrom/carrom.ts#1", "src/sports/generic/generic.ts#1"],
  // sports/carrom/carrom.ts part 2/3 395
  "sports-other-4": ["src/sports/carrom/carrom.ts#2"],
  // sports/carrom/carrom.ts part 3/3 404, sports/index.ts 3
  "sports-other-5": ["src/sports/carrom/carrom.ts#3", "src/sports/index.ts"],
  // sports/generic/generic.ts part 2/3 276, sports/squad-state.ts 66; plus every other file under src/sports/boardgame/, src/sports/carrom/, src/sports/generic/, src/sports/*.ts (new files land here)
  "sports-other-6": ["src/sports/boardgame/**/*.ts", "src/sports/carrom/**/*.ts", "src/sports/generic/**/*.ts", "src/sports/*.ts", "!src/sports/boardgame/boardgame.ts", "!src/sports/carrom/carrom.ts", "!src/sports/generic/generic.ts", "!src/sports/index.ts", "src/sports/generic/generic.ts#2", ...NO_TESTS],
  // sports/generic/generic.ts part 3/3 354
  "sports-other-7": ["src/sports/generic/generic.ts#3"],
  // The PR self-proof (D3): one draw generator with a co-located test (roundrobin.test.ts). It is NOT a home in the sweep:
  // roundrobin.ts is in a draws leg too, and a PR runs only this. 134 mutants, measured, and the cost the hosted rate comes from.
  probe: ["src/scheduling/roundrobin.ts"],
};

/** Ruling 66's ten groups, as FAMILIES: the unit a FLOOR is kept for (stryker-floor.json, scripts/stryker-floor.ts). A family
 *  is the sum of its legs: its score counts the mutants of all of them, so cutting a file again, or adding a leg, never
 *  removes a floor key (T15-CUT). Each leg is in exactly one family, and is named for it or `<family>-<suffix>`; the probe is
 *  in none (it is the PR self-proof, and has no floor). test/stryker-groups.test.ts holds this table to ruling 66's ten
 *  families, typed there, and to the legs' names. */
export const STRYKER_FAMILIES = {
  competition: ["competition-1", "competition-2", "competition-3", "competition-4", "competition-5", "competition-6", "competition-7"],
  core: ["core-1", "core-2", "core-3"],
  modules: ["modules-1", "modules-2", "modules-3", "modules-4", "modules-5", "modules-6", "modules-7"],
  draws: ["draws-1", "draws-2", "draws-3", "draws-4"],
  "sports-cricket": ["sports-cricket-1", "sports-cricket-2", "sports-cricket-3", "sports-cricket-4", "sports-cricket-5", "sports-cricket-6", "sports-cricket-7", "sports-cricket-8", "sports-cricket-9", "sports-cricket-10", "sports-cricket-11", "sports-cricket-12", "sports-cricket-13", "sports-cricket-14"],
  "sports-football": ["sports-football-1", "sports-football-2", "sports-football-3", "sports-football-4", "sports-football-5", "sports-football-6", "sports-football-7"],
  "sports-period": ["sports-period-1", "sports-period-2", "sports-period-3", "sports-period-4", "sports-period-5", "sports-period-6", "sports-period-7", "sports-period-8", "sports-period-9"],
  "sports-setbased": ["sports-setbased-1", "sports-setbased-2", "sports-setbased-3", "sports-setbased-4", "sports-setbased-5", "sports-setbased-6"],
  "sports-nested": ["sports-nested-1", "sports-nested-2", "sports-nested-3", "sports-nested-4", "sports-nested-5"],
  "sports-other": ["sports-other-1", "sports-other-2", "sports-other-3", "sports-other-4", "sports-other-5", "sports-other-6", "sports-other-7"],
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
