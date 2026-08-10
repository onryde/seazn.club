// Integration tests against a REAL running CP-SAT service — everything
// before Task 07 exercised `cpsat-client.ts`/`build.ts`'s CP-SAT path
// through a mocked `solveBuild` (`build.test.ts`'s "CP-SAT path" describe
// block). SKIPPED by default: see `services/cp-sat/README.md`'s "Local dev"
// section to start a real service and run this for real.
//
// `docs/superpowers/plans/2026-08-07-cpsat-service-prompts/_INDEX.md`'s "The
// cutover nearly shipped INERT" is required reading for why this file exists
// at all: Task 06's first pass wired `solveBuild` correctly and passed 8/8
// new happy-path tests while silently running greedy, not CP-SAT, on most
// real (multi-court, non-grid-aligned-seed) boards — every one of those 8
// tests was single-court or grid-aligned, so none of them could see it. Its
// own conclusion: "assert `engine === 'cp-sat'` on a multi-court board with
// a non-aligned seed." That is this file's one load-bearing assertion.
//
// `.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/task-07-brief.md`
// corrects three compile errors in this prompt's base spec
// (`docs/superpowers/plans/2026-08-07-cpsat-service-prompts/07-integration-tests.md`)
// — no second `buildSchedule` argument (host comes from
// `CPSAT_SERVICE_HOST` via `vi.stubEnv`), no `test:integration` script, and
// the fallback status is `solver_unavailable` because `build.ts`'s catch
// block folds every rejection into one outcome, not because of a
// `.failure`-keyed switch. This file follows the brief where the two
// disagree.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSchedule, type BuildInput } from "../build.ts";
import { validateAssignments, type SchedulableFixture, type SlotConfig } from "../calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

// Same gate the base prompt specifies: unset by default, so this whole file
// is inert without a service to point at. Set by the README recipe.
const RUN_INTEGRATION = process.env.CPSAT_SERVICE_HOST !== undefined;

const fx = (id: string, home: string, away: string): SchedulableFixture => ({
  id,
  roundNo: 1,
  home,
  away,
});

/**
 * Lifted from `build.test.ts`'s "returns a board the verifier accepts"
 * (currently at line 265) — the exact case `_INDEX.md` cites as
 * `build.test.ts:265`, "a zero-pin case that failed before the fix" during
 * Task 06's first pass. That test mocks `solveBuild`'s reply; this one asks
 * a REAL service to produce it.
 *
 * STRUCTURALLY forced off-grid, not just observed to be: every pair of
 * these three fixtures shares exactly one entrant (a-b share E1, a-c share
 * E2, b-c share E3 — a complete graph on 3 fixtures), so ANY legal board
 * needs all three pairwise starts >=75 minutes apart (30 min match + 45 min
 * rest). The minimum-span arrangement for three points that must be
 * pairwise >=75 apart is the arithmetic progression {0, 75, 150} relative
 * to T0 (tighter is impossible; any permutation of a/b/c onto those three
 * offsets is equally legal) — so the middle position (T0+75) is forced in
 * *every* optimal board, and 75 does not divide the 30-minute grid step
 * (`gcd(matchMinutes, gapMinutes)` = `gcd(30, 0)` = 30).
 *
 * It also gives CP-SAT genuine room to beat greedy, which is what makes
 * `engine === "cp-sat"` a real assertion here rather than a coin flip:
 * greedy's `slotFixtures` (`calendar.ts`) always prefers the first court
 * that can offer the earliest legal start, so it stacks all three matches
 * on C1 (`courtImbalanceMinutes` 90). The SAME start-time set {0, 75, 150}
 * is available split 2/1 across C1/C2 (`courtImbalanceMinutes` 30).
 * `makespanMinutes` (180) and `worstIdleGapMinutes` (120 — the PARTICIPANT
 * gap E2 waits between `a` and `c`, per `boardMetrics`; not a court-idle
 * measure) are identical either way, because both are pure functions of the
 * start-time set, not of court assignment — so `isStrictlyBetter` ties
 * through the first two dimensions and decides on court imbalance, the one
 * dimension a same-court stack cannot match.
 */
function nonAlignedBoard(): BuildInput {
  const config: SlotConfig & { courts: string[] } = {
    startAt: T0,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["C1", "C2"],
    perEntrantMinRest: 45,
    window: { from: T0, to: T0 + 180 * MIN },
    tz: "UTC",
  };
  return {
    fixtures: [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")],
    config,
  };
}

/**
 * Adapted from `build-wall.test.ts`'s `board(opts)` — same generator shape
 * (courts tried in array order, one wide session window, `matchMinutes`
 * apart on a `gapMinutes: 0` grid) — sized for SCALE rather than for that
 * file's gate math: 32 fixtures over 5 courts, closer to the
 * investigation's 37-fixture/5-court production board
 * (`services/cp-sat/bench/cpsat_bench_boards.py`'s `production_board()`)
 * than any other board in this suite. Still a long way off it: no
 * divisions, no `existing`/pins/dependencies, `matchMinutes`/`gapMinutes`
 * 40/0 rather than production's 40/10, and — the load-bearing difference —
 * `pool = 2 * n` means every entrant appears in exactly one fixture, so
 * (unlike `nonAlignedBoard` above) NOTHING here ever repeats an entrant.
 *
 * That last point is deliberate, not an oversight: with no entrant ever
 * waiting on its own rest, every fixture's earliest legal start is
 * `config.startAt`, so greedy's own court-then-time loop already fills all
 * 5 courts at t=0 before advancing to t=+40min on any of them — a
 * round-robin-by-earliest-time fill that lands within one match-length of
 * optimal on both makespan and court balance before CP-SAT is ever asked.
 * This board is NOT expected to prove `engine === "cp-sat"`
 * (`nonAlignedBoard` owns that assertion, on a board where beating greedy
 * is provably possible); its job is to prove the service round-trips a
 * request at production-ish SCALE — encodes, transports, decodes, and
 * verifies clean — without erroring or timing out.
 */
function scaleBoard(): BuildInput {
  const courts = ["C1", "C2", "C3", "C4", "C5"];
  const matchMinutes = 40;
  const n = 32;
  const pool = 2 * n;
  const fixtures: SchedulableFixture[] = Array.from({ length: n }, (_, f) => ({
    id: `f${String(f).padStart(4, "0")}`,
    roundNo: 1,
    home: `e${(2 * f) % pool}`,
    away: `e${(2 * f + 1) % pool}`,
  }));
  const config: SlotConfig & { courts: string[] } = {
    startAt: T0,
    matchMinutes,
    gapMinutes: 0,
    courts,
    // Inert by construction here (see the comment above — no entrant ever
    // plays twice), so 0 documents that honestly rather than implying a
    // rest rule is doing something on this specific board.
    perEntrantMinRest: 0,
    window: { from: T0, to: T0 + 8 * matchMinutes * MIN },
    tz: "UTC",
  };
  return { fixtures, config };
}

describe.skipIf(!RUN_INTEGRATION)("cp-sat integration (requires a running service)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reaches CP-SAT on a multi-court board whose greedy seed is off the grid — the shape that regressed", async () => {
    const input = nonAlignedBoard();
    const result = await buildSchedule(input);

    // THE assertion — see `nonAlignedBoard`'s comment and `_INDEX.md`'s "The
    // cutover nearly shipped INERT". Reachable only via `build.ts`'s D6 gate
    // ("never worse than greedy") actually accepting a CP-SAT board, which
    // is hardcoded to report `status: "ok"` (build.ts: "Reachable only by
    // having just beaten the seed").
    expect(result.engine).toBe("cp-sat");
    expect(result.status).toBe("ok");
    expect(result.assignments).toHaveLength(3);

    // Not a mock, not a reimplemented checker: the real verifier over the
    // real board a real service produced.
    const conflicts = validateAssignments(
      result.assignments,
      input.config,
      input.existing ?? [],
      input.dependencies ?? [],
    );
    expect(conflicts).toHaveLength(0);

    // The PROOF that beating greedy was possible at all, not merely an
    // assertion that it happened to: greedy's floor is 90 (all three on
    // C1). Anything strictly better must be < 90.
    expect(result.metrics.courtImbalanceMinutes).toBeLessThan(90);
  }, 20_000);

  it("solves a 32-fixture/5-court board end to end with zero verifier conflicts", async () => {
    const input = scaleBoard();
    const result = await buildSchedule(input);

    expect(result.assignments).toHaveLength(32);
    const conflicts = validateAssignments(
      result.assignments,
      input.config,
      input.existing ?? [],
      input.dependencies ?? [],
    );
    expect(conflicts).toHaveLength(0);
  }, 20_000);

  // Task 06b, Correction 3 (task-07-brief.md): an unreachable service does
  // not resolve a status at all — the client THROWS `CpSatError` (one of
  // five `.failure` kinds), and `build.ts`'s catch block around
  // `cpsatClient.solveBuild` folds EVERY rejection, plus an unclassified
  // plain `Error`, into the same `greedy("solver_unavailable", true)`. So
  // this asserts BOTH `engine` and `status`, and deliberately never
  // `.failure` — `build.ts` does not surface it to a caller.
  //
  // `vi.stubEnv`/`vi.unstubAllEnvs` (afterEach, above), never a direct
  // `process.env` assignment: the host is resolved inside `cpsat-client.ts`
  // (`opts.host ?? process.env.CPSAT_SERVICE_HOST ?? DEFAULT_HOST`) on every
  // call, and `build.ts` has no option to pass a host through — the env var
  // is the only lever from a caller, and a leaked one would silently
  // redirect every later test in this worker to `localhost:1`.
  it("falls back to greedy with the service unreachable", async () => {
    vi.stubEnv("CPSAT_SERVICE_HOST", "localhost:1");
    // A short `wallMs` bounds the transport deadline
    // (`(wallSeconds + 2) * 1000` in `cpsat-client.ts`) well under this
    // test's own timeout, in case the unreachable port does not fail as
    // fast as a loopback connection refusal usually does.
    const input = { ...nonAlignedBoard(), wallMs: 2_000 };
    const result = await buildSchedule(input);
    expect(result.engine).toBe("greedy");
    expect(result.status).toBe("solver_unavailable");
    expect(result.assignments.length).toBeGreaterThan(0);
  }, 10_000);
});
