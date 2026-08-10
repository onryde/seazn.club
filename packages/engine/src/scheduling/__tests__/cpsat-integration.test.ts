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
import {
  slotFixtures,
  validateAssignments,
  type SchedulableFixture,
  type SlotConfig,
} from "../calendar.ts";

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
 * Combines two patterns already proven elsewhere in this suite, because
 * neither survives alone against how the cp-sat path actually works — both
 * halves below are MEASURED against this service, not hand-derived and
 * assumed correct.
 *
 * `a`/`b` (2 courts, `perEntrantMinRest: 45`, both sharing entrant E1) is
 * lifted from `build.test.ts:265`'s "returns a board the verifier accepts"
 * — the exact case `_INDEX.md` cites as `build.test.ts:265`, "a zero-pin
 * case that failed before the fix" during Task 06's first pass. It reliably
 * gives greedy an off-grid seed: greedy's raw seed places `a@C1` at T0 and
 * `b@C1` at T0+75 (30 min match + 45 min rest, chained), and 75 is not a
 * multiple of the 30-minute grid step (`gridStepMinutes(30, 0)` = `gcd(30,
 * 0)` = 30) — asserted below via `slotFixtures` directly, not assumed.
 *
 * BUT `a`/`b` ALONE cannot prove `engine === "cp-sat"`, which was the
 * first draft of this board and it failed for a real, structural reason:
 * cp-sat's grid has NO seed-pin injection on this path (`build.ts`: "NO
 * `pinned`/`seedPins` HERE, DELIBERATELY ... Neither concept has a job
 * here" — removing that injection is Task 06's own fix for the ORIGINAL
 * "nearly shipped INERT" bug, see `_INDEX.md`). So cp-sat is bound to the
 * bare 30-minute lattice and can only reach 90-minute spacing for a pair
 * that needs >=75 apart — never the continuous 75 minutes greedy achieves
 * directly. That is a WORSE makespan, and makespan is tier 2, strictly
 * ahead of the court-imbalance tier (4) a 2/1 court split would otherwise
 * win on — so D6 ("never worse than greedy") rejects cp-sat's board every
 * time on THIS shape alone, regardless of how good it is later in the
 * ladder. Observed directly against this service before `x`/`y` below were
 * added: `status: "already_optimal"`, `tiersCompleted: 4` — cp-sat proved
 * its OWN board optimal and still lost, on merit, not on time or a routing
 * failure.
 *
 * `x`/`y` graft on this file's OTHER proven pattern: `build.test.ts`'s
 * `cornerConfig`/`cornerFixtures` scarcity trap (see that file's header —
 * greedy places one card first because nothing stops it, leaving a second,
 * start-window-bound card with no slot, where a solver considering both at
 * once places them both). `y`'s start window (entrant E6, `notAfter: T0`)
 * admits exactly one instant, and by the time greedy reaches `y` (processed
 * last, id order a/b/x/y) both courts are already occupied at that instant
 * — `a` on C1 (placed first) and `x` on C2 (placed third; nothing about
 * `x` ITSELF delays it, it is only there first because `y` sorts after it).
 * `y` is stranded — measured: greedy places 3 of 4, `y` reports
 * `start_window`. A solver weighing all four at once is not stuck with that
 * trade: placing `y` at T0 and shifting `a`/`b` later (still >=45 apart,
 * still grid-aligned, still legal) places all four — verified against this
 * service, not merely proposed (it found `y@C1[0,30)`, `x@C1[30,60)`,
 * `b@C2[0,30)`, `a@C2[90,120)`, court-perfectly balanced besides). 4 > 3
 * decides `isStrictlyBetter` at tier 1, BEFORE makespan is ever compared —
 * which is exactly the tier `a`/`b` alone lost on, and why this shape
 * survives cp-sat being grid-bound where the first draft did not.
 *
 * `restByDivision: { "": 45 }` is separately load-bearing, and is a
 * workaround for a found-not-fixed defect (out of this task's scope —
 * `build.ts` is on the do-not-touch list; reported separately, and
 * unrelated to the tier-ordering issue above). `config.perEntrantMinRest`
 * alone reaches greedy and the verifier fine (both resolve rest through
 * `effectiveRestMinutes` -> `rest-floor.ts`'s `restFloor()`, which reads
 * `perEntrantMinRest`/`constraints.restMin`/`restByGroup`/`noBackToBack` —
 * none of which is `restByDivision`), but `build.ts`'s translation to
 * `SolveBuildInput.constraints` sends ONLY the caller-supplied
 * `verifyConfig.restByDivision` map verbatim — never derived from
 * `restFloor`/`effectiveRestMinutes`/`perEntrantMinRest`. Without this
 * field cp-sat receives no rest constraint at all and returns a board with
 * `a`/`b` back-to-back — legal by cp-sat's own (unconstrained) model, but a
 * "rest" verifier conflict once checked for real (measured: 6/6 conflicts
 * on the `a`/`b`-only draft). Every fixture here has no explicit
 * `divisionId`, so `build.ts` sends `divisionId: f.divisionId ?? ""` on the
 * wire — `""` is therefore the right (only) key to reach them.
 */
function nonAlignedBoard(): BuildInput {
  // `BuildInput["config"]`, not the narrower `SlotConfig & { courts:
  // string[] }` used by `scaleBoard` below — `restByDivision` lives only on
  // the `Pick<VerifyConfig, "hard" | "restByDivision" | "tz">` half of that
  // intersection.
  const config: BuildInput["config"] = {
    startAt: T0,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["C1", "C2"],
    perEntrantMinRest: 45,
    window: { from: T0, to: T0 + 240 * MIN },
    tz: "UTC",
    restByDivision: { "": 45 },
    constraints: {
      noBackToBack: false,
      startWindows: [{ target: { kind: "entrant", id: "E6" }, notAfter: T0 }],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
    },
  };
  return {
    fixtures: [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("x", "E4", "E5"), fx("y", "E6", "E7")],
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

    // The premise, proven rather than assumed (see `nonAlignedBoard`'s
    // comment): greedy's OWN floor places only 3 of 4 — `y` is stranded by
    // its start window — and `b` lands at an offset the 30-minute grid does
    // not contain.
    const seed = slotFixtures({ fixtures: input.fixtures, config: input.config });
    expect(seed.assignments).toHaveLength(3);
    expect(seed.conflicts.map((c) => `${c.fixtureId}:${c.reason}`)).toEqual(["y:start_window"]);
    const bSeed = seed.assignments.find((a) => a.fixtureId === "b");
    expect(bSeed).toBeDefined();
    expect((bSeed!.startAt - input.config.startAt) % (30 * MIN)).not.toBe(0);

    const result = await buildSchedule(input);

    // THE assertion — see `nonAlignedBoard`'s comment and `_INDEX.md`'s "The
    // cutover nearly shipped INERT". Reachable only via `build.ts`'s D6 gate
    // ("never worse than greedy") actually accepting a CP-SAT board, which
    // is hardcoded to report `status: "ok"` (build.ts: "Reachable only by
    // having just beaten the seed").
    expect(result.engine).toBe("cp-sat");
    expect(result.status).toBe("ok");
    // The PROOF that beating greedy was possible at all: greedy's floor
    // places 3 (above), cp-sat places all 4 — decided at tier 1 (placed
    // count), before makespan (tier 2) is ever compared, which is what
    // makes this assertion robust to cp-sat's own grid-quantized cost on
    // `a`/`b`'s timing (see the comment on `nonAlignedBoard`).
    expect(result.assignments).toHaveLength(4);

    // Not a mock, not a reimplemented checker: the real verifier over the
    // real board a real service produced.
    const conflicts = validateAssignments(
      result.assignments,
      input.config,
      input.existing ?? [],
      input.dependencies ?? [],
    );
    expect(conflicts).toHaveLength(0);
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
