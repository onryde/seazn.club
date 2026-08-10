// Integration tests against a REAL running Placement service — everything
// before Task 07 exercised `placement-client.ts`/`build.ts`'s Placement path
// through a mocked `solveBuild` (`build.test.ts`'s "Placement path" describe
// block). SKIPPED by default: see `services/placement/README.md`'s "Local dev"
// section to start a real service and run this for real.
//
// `docs/superpowers/plans/2026-08-07-placement-service-prompts/_INDEX.md`'s "The
// cutover nearly shipped INERT" is required reading for why this file exists
// at all: Task 06's first pass wired `solveBuild` correctly and passed 8/8
// new happy-path tests while silently running greedy, not Placement, on most
// real (multi-court, non-grid-aligned-seed) boards — every one of those 8
// tests was single-court or grid-aligned, so none of them could see it. Its
// own conclusion: "assert `engine === 'optimized'` on a multi-court board with
// a non-aligned seed." That is this file's one load-bearing assertion.
// (`'optimized'`, not `'placement'`: the service is named placement, but the
// ENGINE label had to take a different word — `placement` would not
// distinguish it from greedy, which also places.)
//
// `.superpowers/sdd/2026-08-07-cpsat-service-build-cutover/task-07-brief.md`
// corrects three compile errors in this prompt's base spec
// (`docs/superpowers/plans/2026-08-07-placement-service-prompts/07-integration-tests.md`)
// — no second `buildSchedule` argument (host comes from
// `PLACEMENT_SERVICE_HOST` via `vi.stubEnv`), no `test:integration` script, and
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
const RUN_INTEGRATION = process.env.PLACEMENT_SERVICE_HOST !== undefined;

const fx = (id: string, home: string, away: string): SchedulableFixture => ({
  id,
  roundNo: 1,
  home,
  away,
});

/**
 * FIX ROUND 1 (coordinator finding, `23fb5756` review): the PREVIOUS version
 * of this board used `config.constraints.startWindows` to strand a 4th
 * fixture, mirroring `cornerConfig`'s trap — and that is not wire-legitimate.
 * `SolveBuildInput.constraints` (`placement-client.ts`) carries exactly four
 * fields: `matchMinutes`, `gapMinutes`, `restByDivision`,
 * `dayCapByDivision`. `startWindows`, like every other
 * `SchedulingConstraints` field, is not on the wire at all (tracked gap
 * C1/C2 — not this task's to fix). placement never learned the stranded
 * fixture had a window, so it placed it with no idea a constraint existed,
 * and the test only passed when it happened to land inside that window by
 * luck. Measured by the coordinator, independently: two consecutive live
 * runs on the same commit gave `{placed:4,conflicts:0}` and
 * `{placed:4,conflicts:1}` — a real coin flip, and the exact "green means
 * the opposite of what it reads as" failure mode this file exists to catch.
 *
 * (SEPARATE finding, confirmed on review and reported rather than fixed
 * here — `build.ts` is out of scope: `rejectedBlockingConflicts` is a DELTA
 * against the greedy seed's own blocking conflicts, not an absolute zero,
 * so a blocking conflict identical in SHAPE — same `fixtureId`/`reason`/
 * `detail` — to one the seed already carried can ship un-rejected. That is
 * real and independent of this board's own defect, which was simpler and
 * did not even need the delta to be exploitable: `start_window` was never
 * in `isBlockingConflict`'s list at all, so it was never a candidate for
 * rejection, delta or absolute, in either direction.)
 *
 * This version rebuilds the SAME shape — greedy's single-pass ordering
 * strands a fixture a look-ahead solver would place, on a board whose seed
 * is also off-grid — out of ONLY fields confirmed to reach placement's solver:
 * `dependencies` (`SolveBuildInput.dependencies`, sent verbatim) and
 * `restByDivision`. Verified directly in
 * `services/placement/src/placement/model.py` (section 8), not assumed: the
 * dependency constraint is `start[after] >= start[before] + dur_ms +
 * rest_ms[after]`, where `rest_ms[i]` is resolved per-fixture off THAT
 * fixture's own division's `restByDivision` entry — so a dependency pair,
 * with `restByDivision` set for their division, is a real constraint
 * placement's solver enforces, not one it can silently ignore the way it
 * ignores `startWindows`.
 *
 * `m` depends on `z` (`dependencies: [{ fixtureId: "m", dependsOn: "z",
 * direct: true }]`) and shares entrant E1 with it, so the SAME
 * `perEntrantMinRest: 45` / `restByDivision: { "": 45 }` this board needs
 * anyway for the off-grid-seed property also governs their order gap —
 * one pair, two jobs, no second constraint channel to keep in sync. Greedy
 * processes fixtures in (roundNo, id) order — "m" sorts before "x" and
 * "z" — so it places `m` FIRST, with no way to know a later fixture depends
 * on it staying second. `x` is independent filler (no shared entrant, no
 * dependency) so the board genuinely uses both configured courts without
 * complicating the mechanism above.
 *
 * MEASURED, not assumed (verified against this service, not merely
 * proposed): greedy's raw seed places `m@C1+0`, `x@C2+0`, `z@C1+75` — `z`
 * at +75 minutes, not a multiple of the 30-minute grid step
 * (`gridStepMinutes(30, 0)` = `gcd(30, 0)` = 30), asserted below via
 * `slotFixtures` directly. That SAME seed, checked against the real
 * dependency (which `slotFixtures` itself never evaluates — only
 * `validateAssignments` does, which is why `slotFixtures`' own
 * `.conflicts` is empty here and a SEPARATE `validateAssignments` call is
 * needed to see it), has `m` starting 150 minutes before `z` even ends: a
 * `direct` `order` conflict, BLOCKING per `isBlockingConflict`, so `m` is
 * dropped from the LEGAL floor `isStrictlyBetter` actually compares
 * against — floor placed = 2 (`x`, `z`). placement, receiving the dependency
 * and the rest for real, places all three legally (measured: `m@C2+90`,
 * `x@C2+0`, `z@C1+0` — `m` waits for `z`'s end (30) plus its own
 * 45-minute rest, rounded up to the next grid point, 90). 3 > 2 decides
 * tier 1 before makespan or any other tier is ever compared — and unlike
 * the previous draft, this win is a real feasibility fact about a
 * constraint placement was actually given, not a coincidence about one it was
 * not.
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
  };
  return {
    fixtures: [fx("m", "E1", "E3"), fx("x", "E4", "E5"), fx("z", "E1", "E2")],
    config,
    dependencies: [{ fixtureId: "m", dependsOn: "z", direct: true }],
  };
}

/**
 * Adapted from `build-wall.test.ts`'s `board(opts)` — same generator shape
 * (courts tried in array order, one wide session window, `matchMinutes`
 * apart on a `gapMinutes: 0` grid) — sized for SCALE rather than for that
 * file's gate math: 32 fixtures over 5 courts, closer to the
 * investigation's 37-fixture/5-court production board
 * (`services/placement/bench/placement_bench_boards.py`'s `production_board()`)
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
 * optimal on both makespan and court balance before Placement is ever asked.
 * This board is NOT expected to prove `engine === "optimized"`
 * (`nonAlignedBoard` owns that assertion, on a board where beating greedy
 * is provably possible) — placement may legitimately tie here and D6 keeps the
 * greedy seed, `status: "already_optimal"`, which is a CORRECT outcome this
 * test must not fail on.
 *
 * FIX ROUND 2 (coordinator finding): this is exactly why the ORIGINAL two
 * assertions here (`assignments` length 32, zero verifier conflicts) proved
 * nothing about the SERVICE. Greedy alone, unaided, legally places all 32 —
 * traced through `slotFixtures`/`calendar.ts`, confirmed by the same
 * "nothing ever repeats an entrant" fact two paragraphs up — so a wall
 * timeout, an `UNAUTHENTICATED` secret mismatch, or a dead service all fall
 * back to greedy (`build.ts`'s catch block, `greedy("solver_unavailable",
 * true)`) and BOTH original assertions still pass. The docstring claimed
 * this proves the service "round-trips a request... without erroring or
 * timing out" while the assertions could not see an error OR a timeout —
 * a comment asserting a guarantee the code did not provide, the exact
 * no-teeth shape `nonAlignedBoard`'s own `restByDivision` fix already
 * corrected once in this file. The test below now asserts
 * `status !== "solver_unavailable"` for real: that status is reached ONLY
 * through the catch block (rejection) or an `ERROR` outcome whose code is
 * not `SOLVER_BUSY` — i.e. exactly "the RPC failed", which is the one thing
 * this board's own D6-tie possibility must not be confused with.
 * `engine === "optimized"` is still deliberately NOT asserted here, for the
 * same reason as before: this board legitimately may not need it.
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

describe.skipIf(!RUN_INTEGRATION)("placement integration (requires a running service)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reaches Placement on a multi-court board whose greedy seed is off the grid — the shape that regressed", async () => {
    const input = nonAlignedBoard();

    // The premise, proven rather than assumed (see `nonAlignedBoard`'s
    // comment): greedy's raw seed places `z` at an offset the 30-minute
    // grid does not contain — and, checked against the real dependency
    // (`slotFixtures` itself never evaluates `dependencies`, so this is a
    // SEPARATE `validateAssignments` call, not `seed.conflicts`), that same
    // seed has `m` starting before `z` even ends: a BLOCKING, direct
    // `order` conflict, which is what drops `m` from the legal floor below.
    const seed = slotFixtures({ fixtures: input.fixtures, config: input.config });
    expect(seed.assignments).toHaveLength(3);
    const zSeed = seed.assignments.find((a) => a.fixtureId === "z");
    expect(zSeed).toBeDefined();
    expect((zSeed!.startAt - input.config.startAt) % (30 * MIN)).not.toBe(0);

    const seedConflicts = validateAssignments(
      seed.assignments,
      input.config,
      input.existing ?? [],
      input.dependencies ?? [],
    );
    expect(seedConflicts.map((c) => `${c.fixtureId}:${c.reason}:${c.direct ?? false}`)).toEqual([
      "m:order:true",
    ]);

    const result = await buildSchedule(input);

    // THE assertion — see `nonAlignedBoard`'s comment and `_INDEX.md`'s "The
    // cutover nearly shipped INERT". Reachable only via `build.ts`'s D6 gate
    // ("never worse than greedy") actually accepting a Placement board, which
    // is hardcoded to report `status: "ok"` (build.ts: "Reachable only by
    // having just beaten the seed").
    expect(result.engine).toBe("optimized");
    expect(result.status).toBe("ok");
    // The PROOF that beating greedy was possible at all: greedy's LEGAL
    // floor drops `m` (above) and places only 2 (`x`, `z`); placement, given
    // the dependency and the rest for real, places all 3 — decided at tier
    // 1 (placed count), before makespan (tier 2) is ever compared. Unlike
    // the reverted draft, this is a feasibility fact about a constraint
    // placement actually received, not a coincidence about one it did not.
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
  }, 20_000);

  it("solves a 32-fixture/5-court board end to end with zero verifier conflicts", async () => {
    const input = scaleBoard();
    const result = await buildSchedule(input);

    // FIX ROUND 2: the load-bearing assertion for THIS board. Greedy alone
    // places all 32 legally (see `scaleBoard`'s comment), so neither
    // `assignments` length nor `conflicts` below can ever fail — a broken
    // service, a wall timeout, or a wrong `PLACEMENT_SERVICE_SECRET` all fall
    // back to greedy and both would still pass. `solver_unavailable` is
    // reached ONLY through an RPC rejection or a non-`SOLVER_BUSY` `ERROR`
    // outcome (`build.ts`'s catch block / `ERROR`-status arm) — i.e. it is
    // reached if and only if the real RPC to the real service failed. This
    // does NOT assert `engine === "optimized"`: D6 may legitimately keep the
    // greedy seed here (`status: "already_optimal"`), and that is a correct
    // outcome this test must not fail on — `nonAlignedBoard`'s test owns
    // the engine-selection assertion, on a board where beating greedy is
    // provably possible.
    expect(result.status).not.toBe("solver_unavailable");

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
  // not resolve a status at all — the client THROWS `PlacementError` (one of
  // five `.failure` kinds), and `build.ts`'s catch block around
  // `placementClient.solveBuild` folds EVERY rejection, plus an unclassified
  // plain `Error`, into the same `greedy("solver_unavailable", true)`. So
  // this asserts BOTH `engine` and `status`, and deliberately never
  // `.failure` — `build.ts` does not surface it to a caller.
  //
  // `vi.stubEnv`/`vi.unstubAllEnvs` (afterEach, above), never a direct
  // `process.env` assignment: the host is resolved inside `placement-client.ts`
  // (`opts.host ?? process.env.PLACEMENT_SERVICE_HOST ?? DEFAULT_HOST`) on every
  // call, and `build.ts` has no option to pass a host through — the env var
  // is the only lever from a caller, and a leaked one would silently
  // redirect every later test in this worker to `localhost:1`.
  it("falls back to greedy with the service unreachable", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", "localhost:1");
    // A short `wallMs` bounds the transport deadline
    // (`(wallSeconds + 2) * 1000` in `placement-client.ts`) well under this
    // test's own timeout, in case the unreachable port does not fail as
    // fast as a loopback connection refusal usually does.
    const input = { ...nonAlignedBoard(), wallMs: 2_000 };
    const result = await buildSchedule(input);
    expect(result.engine).toBe("greedy");
    expect(result.status).toBe("solver_unavailable");
    expect(result.assignments.length).toBeGreaterThan(0);
  }, 10_000);
});
