import "server-only";
import type { RateLimitConfig } from "@/lib/rate-limit";
import {
  calendarDaysCovering,
  slotFixtures,
  type Assignment,
  type HardConstraint,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { MS_PER_MIN } from "./helpers";

/** How much room past the work the solver is given to rearrange inside, when the
 *  competition itself sets no end date. A day, not a year — and the size is
 *  MEASURED, not a taste: see `boundSolverWindow`. */
const SOLVER_SLACK_MS = 24 * 60 * MS_PER_MIN;

/**
 * The wall the auto pass gives a solver, overriding the engine's 30-second
 * default.
 *
 * `autoSchedule` is a SYNCHRONOUS request an organiser is watching, so the
 * engine's own cap is the wrong one here: measured on a 15-fixture, 2-court
 * board it is spent in full, every time, and hands back a 30-second HTTP
 * response for a board that stopped improving long before.
 *
 * 8 seconds is where a 15-fixture, 2-court board's measurements level off —
 * 2s and 5s differ (court imbalance 90 -> 30 minutes), 5s and 10s do not, and
 * small boards finish and prove themselves optimal in well under a second
 * regardless. THAT BOARD IS NOT REPRESENTATIVE. Re-measured on a 40-80 fixture,
 * 4-5 court board (`packages/engine/scripts/bench-build.ts --sizes=40,60,80
 * --per-entrant=2 --wall=8000` vs `--wall=20000`): 40 plateaus by 8s same as
 * before, but 60 keeps improving (makespan 1760->1600 at 8s, ->1480 at 20s,
 * idle only catches up at 20s) and 80 does not even reach a z3 result at 8s
 * (falls straight to greedy) while 20s gets one improved board. 20 seconds is
 * where THIS range levels off — re-run the sweep before moving it again.
 *
 * That sweep was z3's, and it is not re-runnable as written: BUILD solves
 * through the placement service now, and `bench-build.ts` was deleted with the
 * z3 tier encoder in `82553ec3`. The numbers above stand as the record that set
 * this constant; moving it means rebuilding the sweep against CP-SAT first.
 *
 * AND MOVING IT MOVES SOMETHING ELSE. `canSolveWithin` scales the R18 size
 * gate by `wallMs / 8_000`, and this wall is what the web layer passes, so
 * changing it silently re-tunes which boards reach the solver at all. #589.
 *
 * Expiring is ORDINARY, not a failure: `budget_expired` rides the wire and the
 * result strip says how many improvement targets the run got through. What is
 * NOT ordinary is reading the flag as "not optimal" — optimality is
 * `tiers_completed === tiers_total`; a term or metric drift exits a tier without
 * ever setting it.
 *
 * Task 13's bench sets the DETERMINISTIC budget (`rlimit`); this is only the
 * outer safety cap, and should be revisited once that lands.
 *
 * CONFIGURABLE AT RUNTIME, via `PLACEMENT_WALL_SECONDS` (seconds, to match the
 * service's own units). This is the caller's ASK. The service applies its own
 * independent CEILING, `PLACEMENT_WALL_SECONDS_MAX`, as a `min()` — so the wall
 * a board actually gets is the smaller of the two, and RAISING EITHER ONE ALONE
 * CHANGES NOTHING. Both, or no board's budget moves.
 *
 * Read per call rather than captured at module load: the value must come from
 * the running process's environment, so a `fly secrets set` takes effect on
 * restart without a rebuild. A module-scope read risks being evaluated during
 * the build instead, which would bake the wrong number in silently.
 */
const DEFAULT_AUTO_SOLVER_WALL_SECONDS = 10;

export function autoSolverWallMs(): number {
  const raw = process.env.PLACEMENT_WALL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUTO_SOLVER_WALL_SECONDS * 1_000;
  const seconds = Number(raw);
  // Refused, not defaulted, and deliberately: the failure this guards is a
  // typo'd env var that leaves every board silently running the old wall while
  // the operator believes they changed it. `config.py` refuses the same way on
  // its side of the wire. A loud failure on the one surface that reads this is
  // cheaper than a plausible, stable, wrong answer.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `PLACEMENT_WALL_SECONDS must be a finite number > 0, got ${JSON.stringify(raw)}. It is the ` +
        `solve budget in seconds asked of the placement service.`,
    );
  }
  return Math.round(seconds * 1_000);
}

/**
 * The per-ORG cooldown on the auto pass. Ten runs per five minutes.
 *
 * WHY PER-ORG AND NOT GLOBAL. The resource being protected is a SHARED,
 * capacity-constrained one: every solve (BUILD/POLISH directly, REFLOW
 * through `reflowExisting` — none of the three calls z3 for scheduling any
 * more, since C4, 2026-08-14) is a remote call to the placement service,
 * which admits only a small, fixed number of concurrent solves
 * (`PLACEMENT_MAX_WORKERS` on the service side — see `fly.toml` in
 * onryde/seazn.club.placement; this comment predates that cutover and its "one at a time via
 * `withZ3Lock`" framing is no longer literally accurate, but the underlying
 * shape — a small shared ceiling, not unlimited parallelism — still holds,
 * which is why the numbers below have not been revisited). The failure mode
 * is therefore one org monopolising a queue everybody shares, not aggregate
 * load — and a global limiter would punish precisely the tenants being
 * starved. The key is the org.
 *
 * WHERE THE NUMBERS COME FROM. Ten runs x `AUTO_SOLVER_WALL_MS` is bounded to
 * ~27% of an instance's solver capacity, whatever the wall is currently set
 * to — `max` stays 10 (the UX reason below is about button-presses, not
 * capacity, and does not move with the wall) and `windowSeconds` is re-derived
 * to hold the ratio: `10 * wallMs / 0.2667`. At `wallMs = 20_000` that is
 * 10 * 20 / 0.2667 = 750s (12.5 min). One org can never take more than ~27% of
 * an instance's solver capacity however hard it is driven — while a human
 * organiser iterating on a board is never blocked, because ten is enough to
 * try all three buttons (Auto / Re-flow / Polish) three times over with a
 * settings change between each. Anyone clicking faster than one run per 75
 * seconds sustained is not reading the results.
 *
 * `max` IS POLICY and is here to be moved. `windowSeconds` no longer is — it is
 * computed from the wall below, because the wall became an env var and a
 * hand-re-derived constant cannot track a value an operator can change without
 * touching this file.
 *
 * FAIL-OPEN, deliberately, and matching every other limiter on this surface
 * (`ai-plan` 5/hr, `ai-plan-competition` 3/hr, `ai-officials` 5/hr). A Redis
 * outage must not delete the feature for every tenant at once, and the queue cap
 * (`MAX_SOLVER_QUEUE`) still bounds what a burst can occupy while it is down.
 * Note this also makes the limiter INERT with no REDIS_URL — local dev, e2e and
 * the test suite — so it is a production control, and any test of it has to mock
 * `incrWindow` to make it real (`schedule-auto-cooldown.test.ts` does).
 *
 * IT MUST NOT SLOW THE FAST REFUSAL. `buildSchedule` answers `solver_busy` with
 * a greedy board WITHOUT taking the z3 lock once two solves are in flight,
 * precisely so the third caller need not wait out two full budgets — a
 * `withZ3Teardown` wrapper destroyed that property earlier in this wave and was
 * deleted for it. This limiter is one Redis INCR ahead of everything, on no
 * lock and no queue, so the refusal path is unchanged; pinned by
 * `schedule-auto-solver-busy-latency.test.ts`, which now runs with the limiter
 * live for exactly that reason.
 */
/** Ten runs. A UX number about button-presses, and it does NOT move with the
 *  wall — see the block above. */
const AUTO_SCHEDULE_COOLDOWN_MAX = 10;

/** The share of one instance's solver capacity a single org may occupy, ~27%.
 *  THIS is the invariant being held; `windowSeconds` is merely what holds it at
 *  the current wall. */
const AUTO_SCHEDULE_ORG_CAPACITY_SHARE = 0.2667;

/**
 * DERIVED, not a literal, now that the wall is an env var.
 *
 * It was `375` hardcoded, with a comment instructing whoever moved the wall to
 * re-derive it by hand. That instruction was correct and had already been
 * missed once — it sat at 750 (right for a 20 s wall) against a 10 s wall.
 * A hand-maintained constant cannot survive a value that an operator can now
 * change with `fly secrets set` and no code review at all: raising
 * `PLACEMENT_WALL_SECONDS` to 20 while this stayed 375 would silently double
 * one org's share of solver capacity, which is the exact ratio it exists to
 * hold. So it is computed instead. At the default 10 s wall this is
 * `10 * 10 / 0.2667 = 375`, byte-for-byte the value it replaces.
 */
export function autoScheduleCooldown(): RateLimitConfig {
  const wallSeconds = autoSolverWallMs() / 1_000;
  return {
    max: AUTO_SCHEDULE_COOLDOWN_MAX,
    windowSeconds: Math.round(
      (AUTO_SCHEDULE_COOLDOWN_MAX * wallSeconds) / AUTO_SCHEDULE_ORG_CAPACITY_SHARE,
    ),
  };
}

/**
 * A FINITE search window, replacing an open-ended one.
 *
 * IT REPLACES A BOUND THE VERIFIER ALSO READS — this is not a solver-only knob,
 * and pretending otherwise is how `mustContain` came to be needed. The returned
 * config is the SAME object handed to `validateAssignments` and
 * `validateInstructionRules`, so narrowing `window` narrows what counts as a
 * `window` conflict too. The clamp is therefore built to be wider than anything
 * the run can legally produce, never tighter, and every bound below is chosen on
 * that basis.
 *
 * `applyWindow` answers an open-ended competition with `±Infinity`, and for the
 * verifier that is exactly right — a bound nothing can breach enforces nothing.
 * The SOLVERS cannot take it: `buildGrid` derives its day buckets from this
 * window through `calendarDaysCovering`, and `dayKeyInTz(Infinity)` throws
 * `RangeError: Invalid time value`. A division with a start date and no end date
 * is the ordinary case, so unclamped the whole auto pass 500s on it.
 *
 * Two bounds that are NOT interchangeable:
 *
 *   * the open end is clamped to the WORK — the greedy board proves how much
 *     time these fixtures actually need, and the solver gets that plus
 *     `SOLVER_SLACK_MS` (one day) to rearrange inside. Wider is not free and not
 *     neutral: the lattice is capped
 *     at `MAX_SLOTS`, and `buildGrid` answers an overflow by returning NOTHING,
 *     which drops `buildSchedule` straight back onto the greedy board it was
 *     asked to improve. A 365-day horizon over two courts is ~35k slots — the
 *     solver would be silently inert on exactly the configs it exists for.
 *   * the open START is clamped to `config.startAt`, or to a pinned card if one
 *     sits earlier. A pin is admitted to the lattice unconditionally, so a
 *     window that excluded it would hand back a `window` conflict on a card
 *     nobody asked to move.
 *
 * A window with two finite bounds is returned untouched: the competition's own
 * dates are the answer whenever it has them.
 */
export function boundSolverWindow<T extends SlotConfig & VerifyConfig>(
  config: T,
  fixtures: readonly SchedulableFixture[],
  existing: readonly Assignment[],
  /**
   * Cards that will be IN the proposal already placed — REFLOW's incumbent
   * board. They must be inside the window even though nothing asked to move
   * them: `validateAssignments` bounds `assignments` and not `existing`, so a
   * card the organiser parked three days out would otherwise come back with a
   * BLOCKING `window` conflict the moment the clamp closed in front of it.
   * Empty for BUILD and POLISH, which propose from scratch.
   */
  mustContain: readonly Assignment[] = [],
  /** Bracket feeds, forwarded to the measuring greedy pass. Without them that
   *  pass places a dependent at the SAME instant as its feeders, so the span it
   *  measures is too short and the window handed to the solver cannot fit the
   *  dependent after them — the second route to the "2 of 3 placed" bug the
   *  ordering fix in `slotFixtures` closes. Optional: every pre-existing caller
   *  measures exactly as it did. */
  dependencies: readonly OrderDependency[] = [],
): T {
  const w = config.window;
  if (w !== undefined && Number.isFinite(w.from) && Number.isFinite(w.to)) return config;

  const pins = fixtures.flatMap((f) => (f.locked !== undefined ? [f.locked.startAt] : []));
  const from =
    w !== undefined && Number.isFinite(w.from)
      ? w.from
      : Math.min(config.startAt, ...pins, ...mustContain.map((a) => a.startAt));
  // MEASURED, not invented: the greedy pass is the same one `buildSchedule`
  // runs first, so this is the span the fixtures demonstrably occupy.
  const seed = slotFixtures({ fixtures, config, existing, dependencies });
  const to =
    w !== undefined && Number.isFinite(w.to)
      ? w.to
      : Math.max(
          from,
          ...seed.assignments.map((a) => a.endAt),
          ...pins.map((t) => t + config.matchMinutes * MS_PER_MIN),
          ...mustContain.map((a) => a.endAt),
        ) + SOLVER_SLACK_MS;
  return { ...config, window: { from, to } };
}

/**
 * The auto pass's default `max_fixtures_per_day`, applied only when the
 * organiser set none of their own for this division — and, at its one call
 * site, only for BUILD. POLISH and REFLOW exist specifically to NOT move a
 * card that doesn't need moving (R20 / #452); a default the organiser never
 * asked for would fight that on any board that already exists spread one way
 * across days, forcing churn to satisfy a cap nobody set. BUILD has no
 * existing board to disturb, which is exactly the reported bug's shape.
 *
 * The solver's own objective has nothing that spreads a board across a
 * multi-day window, and the 2026-08-13 day-aware rungs made that MORE true,
 * not less. It used to be that T1 minimised `makespanMinutes`, which pulled
 * every fixture toward the earliest reachable day; T1 is now
 * `days → day_span → day_start`, and its FIRST rung minimises the COUNT of
 * calendar days used, which packs harder but no longer says WHICH day. Either
 * way a wide window and a tight one behave identically without a day cap
 * forcing the difference: a seven-day window and a one-day window both pile
 * every match onto ONE day. The other rungs are shift-invariant, so the LAST
 * rung, `day_rank` (owner ruling 2026-11-04), breaks a whole-day tie toward the
 * earliest day; before it the solver picked whichever day the lattice reached
 * (W3 T11 / X-SW-29: a board landed on the window's second day under
 * `boundSolverWindow`'s slack day). It prefers early days, it does not spread.
 *
 * `max_fixtures_per_day` is the one hard rule that already does this, fully
 * wired end to end (`build-encode.ts` groups by `dayKeyInTz` and encodes an
 * `AtMost` per day) — an organiser can already set it through the AI parser
 * or the constraints panel. This only fills the gap for a run that set
 * neither: `ceil(fixtures / availableDays)` spreads them roughly evenly
 * across the window's own dates instead of leaving every board on one day
 * (not necessarily the first) by default. An explicit whole-division rule from either surface always wins
 * untouched — this never overwrites one.
 */
export function withDefaultDaySpread<T extends SlotConfig & VerifyConfig>(
  config: T,
  divisionId: string,
  fixtureCount: number,
): T {
  const existingHard = config.constraints?.hard ?? [];
  const hasExplicitCap = existingHard.some(
    (h) => h.type === "max_fixtures_per_day" && h.scope.kind === "division" && h.scope.divisionId === divisionId,
  );
  if (hasExplicitCap || fixtureCount <= 0 || config.window === undefined || config.tz === undefined) return config;

  // Same padded-by-one-day-at-each-end shape `build-grid.ts` and `repair.ts`
  // already rely on (`calendarDaysCovering`'s own doc comment) — undo the pad
  // rather than reimplement day counting a third way.
  const days = calendarDaysCovering(config.window, config.tz).length - 2;
  if (days <= 1) return config;

  const hard: HardConstraint[] = [
    ...existingHard,
    {
      type: "max_fixtures_per_day",
      count: Math.max(1, Math.ceil(fixtureCount / days)),
      scope: { kind: "division", divisionId },
    },
  ];
  return {
    ...config,
    constraints: {
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      ...config.constraints,
      hard,
    },
  };
}
