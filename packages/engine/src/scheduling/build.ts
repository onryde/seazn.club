// The build solver's control loop.
//
// Greedy seeds the incumbent, so the answer is never worse than today's — that
// property is what lets this ship with NO escape hatch back to greedy (design
// D6). Tiers then improve the incumbent in a fixed lexicographic order, each by
// a bound walk under push/pop: assert the objective is strictly better than the
// incumbent, solve, and on SAT take the new board. The last satisfiable bound
// IS the optimum, by construction rather than by an objective function nobody
// can audit — the same reason `repair.ts` walks k upward instead of minimising
// a weighted sum.
//
// The budget is z3's `rlimit`, a DETERMINISTIC resource counter, not the wall
// clock (design D9). An anytime search cut off by wall clock returns a
// different board on a faster machine, which is both a support ticket and a
// permanently flaky test. The wall clock survives only as an outer cap that
// should never fire.
//
// --- the seed is LEGALISED before it is measured ---------------------------
//
// `slotFixtures` does not read `config.window`: its only bound is
// `horizonMinutes`, a 365-day default (`calendar.ts:390`). `repairUniverse`,
// which bounds the lattice this solver searches, DOES read it. So on any
// competition that overruns its own window greedy places every card — outside
// the window, reporting nothing — while z3 can only place the ones that fit
// inside it. D3 ranks `placed` first, so that illegal board outranks every
// legal one and would stay the incumbent forever, making the whole feature
// inert on exactly the boards it exists to fix.
//
// The fix is to make `placed` mean LEGALLY placed: every seed row carrying a
// BLOCKING conflict is dropped before the seed is measured. Those cards were
// already conflicts — counting them as placed was the bug — and the drop is
// provably sound, because every blocking reason is either per-row (`window`)
// or names both sides of a pair (`court`, `person_overlap`) or names the
// dependent (`order`), so removing every named row cannot leave one behind and
// cannot create a new one. The floor therefore becomes a board free of the
// blocking conflicts it can be held RESPONSIBLE for, and "never worse than
// greedy" becomes a stronger claim rather than a weaker one.
//
// Two honest limits on that claim, both harmless and both worth stating rather
// than leaving for the next reader to rediscover:
//
//   * it is not "provably legal". `validateAssignments` builds its index over
//     `[...existing, ...assignments]` (`calendar.ts:1268`), so a direct `order`
//     dependency between two IMMOVABLE rows emits a blocking conflict whose
//     `fixtureId` is not in the seed at all — the `seedIds` guard below skips
//     it, and it survives into the answer. Nothing the solver can do would
//     change it, which is exactly why the gate is a delta and is scoped to
//     `ours`; both neutralise it independently.
//   * the drop is CONSERVATIVE. `court` and `person_overlap` name both sides of
//     a pair, so a clashing pair loses both rows where keeping either one alone
//     would have been legal. Sound, never optimistic, and the solver is free to
//     re-place both — it just starts from a lower floor than it strictly had
//     to.
//
// --- the lattice is the CONFIGURED courts (R3) ------------------------------
//
// `repairCourts` folds in every court an `existing` row uses, which is right
// for a REPAIR — a card already sitting on court 5 may stay there — and wrong
// for a BUILD, which would then place brand-new fixtures on a court the
// organiser never listed. The verifier does not test court membership, so this
// was never a parity defect; it was a product question, and the ruling is that
// a BUILD places only on `config.courts`.
//
// Immovable rows on other courts remain OBSTACLES in full: their court time is
// still removed from the lattice by `buildGrid` and their participants still
// constrain through `encodeBuild` §7. Only new PLACEMENT is restricted. The one
// exemption is a PINNED slot: a card the caller locked onto an unlisted court
// must still be representable, or a board that merely looks odd becomes an
// infeasible one.
//
// --- three verdicts, and why the third is the point -------------------------
//
// A `check()` here has THREE outcomes and they are not two:
//
//   sat      a board exists at this bound, and it is in hand;
//   unsat    a PROOF that no board reaches this bound;
//   unknown  no proof either way inside the budget.
//
// `unknown` is T0's EXPECTED terminal state near the optimum — finding a good
// board is fast, proving a tight ceiling is not — and it is not an error and
// not an infeasibility. Collapsing it onto `infeasible` would report an
// impossibility nobody established, which is precisely the defect this tier
// exists to remove: greedy's `no_slot` is a GUESS, and replacing one guess with
// a differently-dressed guess buys nothing. When the answer is `unknown` the
// incumbent simply stands and `budgetExpired` says why. Both sites that can
// see an `unknown` — the feasibility probe and the T0 walk — are pinned by
// their own test.
import type { Arith, Bool, Model, Solver } from "z3-solver";
import { boardMetrics, isStrictlyBetter, type BoardMetrics } from "./build-objectives.ts";
import { buildGrid, type BuildGrid, type BuildSlot } from "./build-grid.ts";
import type { BuildConfig, EncodedModel } from "./build-encode.ts";
import {
  deltaConflicts,
  effectiveHard,
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  RULE_BY_REASON,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "./calendar.ts";
import type { HardConstraint } from "./constraints.ts";
import { dayKeyInTz } from "./tz.ts";
import { repairUniverse } from "./repair-domain.ts";
import { withZ3LockAndReset, type Z3Context } from "./z3-load.ts";
// `cpsat-client.ts` is imported dynamically at the call site inside
// `solveBuild`, never statically — see the comment there. This is a
// TYPE-only import: `import type` is erased at compile time, so it creates
// no runtime module binding and does not defeat the dynamic-import mocking
// seam `build.test.ts` relies on (the repo's own recorded trap: `vi.doMock`/
// `vi.spyOn(await import(...))` is inert against a module the file under
// test also imports statically).
import type { SolveBuildInput, SolveBuildOutcome } from "./cpsat-client.ts";

const MS_PER_MIN = 60_000;

/**
 * A RUN total, not a per-check allowance; see `RunBudget`.
 *
 * MEASURED by `scripts/bench-build.ts` (Task 13), replacing the placeholder.
 * The rule is the one `DEFAULT_REPAIR_BUDGET_MS` used: twice the worst `rlimit`
 * any board consumed that completed ALL FOUR TIERS, across both measured
 * densities, rounded up. The worst such board spent **14_562_487** (10 fixtures,
 * 2 matches per entrant, 8.1 s), so 2x is 29_124_974 and this is 30_000_000.
 * Every four-tier completion measured, for the record: 52_497 / 72_269 /
 * 765_734 / 850_484 / 864_501 / 1_822_166 / 7_693_966 / 8_281_447 / 14_562_487.
 *
 * --- READ THIS BEFORE TUNING IT -------------------------------------------
 *
 * **AT THE PRODUCTION WALL THIS CONSTANT GOVERNS NOTHING, and the change from
 * 40M to 30M is behaviourally inert.** The bench measured this box at roughly
 * 0.9-1.9M rlimit units per second of solving, so `AUTO_SOLVER_WALL_MS` (8_000)
 * can buy at most ~15M units — half of this budget and a third of the old one.
 * Every run in the 14-row sweep stopped on the WALL, never on the budget, at
 * every size from 10 fixtures to 200. D9 says the budget is the rlimit and not
 * the clock; in practice it is the clock, which is why the same board can come
 * back differently on a different machine.
 *
 * The mechanism, from Q9 of the same bench: at 200 fixtures an ABORTED check
 * spends **1** rlimit unit while costing 322 ms of wall, because z3 tests the
 * resource limit during preprocessing and bails before its counter moves. An
 * rlimit budget therefore cannot bound elapsed time on a large model at all —
 * D9's premise holds for small models and breaks for big ones.
 *
 * Making D9 true again means setting this BELOW what the wall can buy on the
 * slowest supported machine — around **6_000_000** on the measurements here —
 * so the deterministic cap fires first and the answer stops depending on
 * machine speed. That trades search for reproducibility and is an owner ruling,
 * not a tuning decision, so it is written up in the Task 13 report rather than
 * applied here.
 */
export const DEFAULT_BUILD_RLIMIT = 30_000_000;
/**
 * How much of a run's budget the monolithic solve may draw before the window
 * fallback gets a look (ruling R11).
 *
 * Without a reserve the two are not really sharing a budget: the tiers exhaust
 * it exactly when they fail to converge, which is precisely the state LNS
 * exists to rescue, so the fallback would be dead on arrival on every board it
 * is for. The FRACTION is a placeholder for Task 13's bench, like
 * `DEFAULT_BUILD_RLIMIT`; that some reserve must exist is not.
 *
 * THE RESERVE IS ONLY MEANINGFUL WHEN THE BUDGET IS LARGE relative to a single
 * check's overshoot (see `RunBudget` — ~28_500 units on the four-fixture model
 * in `build-budget.test.ts`). Below that a single check can blow through both
 * the share and the run total at once and no window ever opens, which is the
 * honest answer: a budget that cannot pay for one check cannot pay for two
 * solvers' worth of them either. At `DEFAULT_BUILD_RLIMIT` the reserve is
 * ~10_000_000 against an overshoot of tens of thousands, so it binds as
 * intended.
 */
export const BUILD_MAIN_RLIMIT_SHARE = 0.75;
/** The outer safety cap. Not the stopping rule; see the header. */
export const DEFAULT_BUILD_WALL_MS = 30_000;
/** T0 plus the three lexicographic tiers. `tiersCompleted` reaching this is
 *  what "the board is lexicographically optimal" means.
 *
 *  EXPORTED for the web layer (ruling R17), which was carrying its own
 *  `TIERS_TOTAL = 4`. Two copies of a number that means "the solver proved
 *  every tier" drift the moment a tier is added, and the copy that drifts is
 *  the one deciding what an organiser is told. */
export const TIER_COUNT = 4;

/**
 * The R18 size gate, in fixture-slots (`fixtures.length x grid.slots.length`).
 *
 * MEASURED by `scripts/bench-build.ts` (Task 13), the R18 knee sweep:
 *
 *   node --experimental-strip-types packages/engine/scripts/bench-build.ts \
 *     --sizes=10,20,40,60,80,120,200 --per-entrant=2,4 --wall=8000 --not-after=2
 *   node --experimental-strip-types packages/engine/scripts/bench-build.ts \
 *     --sizes=140,160,180 --per-entrant=2 --wall=8000 --not-after=2
 *
 * At the 8_000 ms production wall the solver improved the board at every size
 * up to 140 fixtures on a 144-slot lattice (20_160 fixture-slots) and improved
 * NOTHING at 160 on a 216-slot lattice (34_560) or above — `tiersCompleted: 0`,
 * `engine: "greedy"`, and 11-15 s spent to hand back the board it started with.
 * 20_000 is the improving side of that boundary, rounded.
 *
 * --- WHY FIXTURE-SLOTS AND NOT A FIXTURE COUNT ----------------------------
 *
 * The knee is not a property of the fixture count. It is where boot + greedy +
 * `encodeBuild` + the first `solver.push()` crosses the wall, and all of those
 * scale with the ENCODING — `fixtures x slots` place literals — not with
 * fixtures alone. The bench's own lattice happens to jump 144 -> 216 slots
 * between n=144 and n=145, which is what makes a fixture-count reading look
 * sharp at 140/160; a board with 200 fixtures on a 144-slot lattice would very
 * likely still improve, and one with 120 fixtures on a 400-slot lattice would
 * not. A gate spelled `n <= 140` misfires on both.
 *
 * --- WHAT TO RE-MEASURE BEFORE CHANGING THIS ------------------------------
 *
 * This number is a ratio between the wall and this machine's speed, so it is
 * NOT portable across a change to either. Re-run the two commands above and
 * move it if: `AUTO_SOLVER_WALL_MS` changes; the pre-search cost changes
 * (anything touching `encodeBuild`, `buildGrid` or the first `push()`); or the
 * deployment target's CPU changes. The figure to read off the sweep is the
 * largest `n x slots` whose row still reports `engine: "z3"`.
 */
export const MAX_SOLVE_ENCODING = 20_000;

/**
 * Whether the build solver is worth calling on this board at this wall — the
 * R18 gate, as a predicate, so no caller has to restate the threshold.
 *
 * THE POINT IS THAT `MAX_SOLVE_ENCODING` LIVES IN ONE PLACE. The web layer has
 * to decide whether to call `buildSchedule` at all, and a copy of the number
 * there is a placer/verifier fork wearing a different hat — the defect shape
 * this subsystem has hit three times, and the copy that drifts is always the
 * one deciding what the organiser gets.
 *
 * `false` does NOT mean "no better board exists". Task 13 measured a
 * 200-fixture board improving (placed 198 -> 199) when given 180 s instead of
 * 8 s: above the gate the solver is not failing to find anything, it is never
 * being asked, because the wall expires during the encode. So the honest
 * reading is "not inside this wall", and a caller that gets `false` should fall
 * through to the greedy board rather than tell anyone the board is optimal.
 *
 * It builds the real lattice rather than estimating it. `buildGrid` is cheap
 * (it never reads the fixture list) and it is the only thing that knows how
 * sessions, blackouts, the horizon and the configured courts turn into slots;
 * an estimate here would be a second implementation of exactly that, which is
 * the fork this export exists to prevent. `buildSchedule` builds the same
 * lattice again a moment later — that duplication is deliberate and cheap, and
 * far safer than threading a grid through the call.
 *
 * An over-cap or empty lattice answers `false`: `buildSchedule` returns the
 * greedy board on both without solving, so calling it would be pure cost.
 *
 * @param wallMs the wall the caller will actually pass. Defaults to the
 * engine's own, which is NOT what the web layer uses — pass
 * `AUTO_SOLVER_WALL_MS` explicitly or the gate answers for a 30 s budget the
 * request will not get.
 */
export function canSolveWithin(
  fixtures: readonly SchedulableFixture[],
  config: SlotConfig & { courts: string[] },
  wallMs: number = DEFAULT_BUILD_WALL_MS,
  existing: readonly Assignment[] = [],
): boolean {
  if (fixtures.length === 0) return false;
  // THE BARE LATTICE, WITHOUT THE SEED'S PINS — this runs before any seed
  // exists, and running greedy here to find out would cost more than the solve
  // it is gating. The pins add at most one slot per fixture (`seedPinsOf`), and
  // zero on the common case where the seed is on-grid, so this under-prices a
  // rest-chained board by up to `n` slots. Left un-padded deliberately: padding
  // every board by `n` would refuse boards that add nothing, and the gate is
  // calibrated by MEASUREMENT (Task 13's sweep, run at both an on-grid and an
  // off-grid rest) rather than by arithmetic.
  const grid = restrictToConfiguredCourts(buildGrid({ config, existing }), config.courts, []);
  if (grid.overCap || grid.slots.length === 0) return false;
  // Scaled by the wall the caller will really use. The 20_000 figure was
  // measured against 8_000 ms, so a caller with twice the budget can afford
  // twice the encoding — the gate is a cost-vs-budget ratio, not a fixed size.
  const budget = MAX_SOLVE_ENCODING * (wallMs / AUTO_SOLVER_WALL_MS_AT_MEASUREMENT);
  return fixtures.length * grid.slots.length <= budget;
}

/** The wall `MAX_SOLVE_ENCODING` was measured against — the web layer's
 *  `AUTO_SOLVER_WALL_MS` at the time of the Task 13 bench. It exists so
 *  `canSolveWithin` can scale the gate to whatever wall a caller passes;
 *  changing it without re-running the sweep silently rescales every gate
 *  decision. */
const AUTO_SOLVER_WALL_MS_AT_MEASUREMENT = 8_000;

/**
 * One run's z3 resource budget, shared by every solve the run performs
 * (ruling R11).
 *
 * --- WHY THIS IS NOT `solver.set("rlimit", n)` ONCE ------------------------
 *
 * MEASURED, against z3-solver 5.0.0:
 *
 *   * `rlimit` is RE-ARMED ON EVERY `check()`. Three checks at `rlimit: 50_000`
 *     on ONE solver each returned `sat`, spending ~40_000 apiece — 120_000
 *     against a limit that reads like 50_000.
 *   * it is a PER-CHECK DELTA, not an absolute threshold. With the context's
 *     counter already at 86_090, a check at `rlimit: 50_000` still returned
 *     `sat` and spent 40_672. An absolute reading would have aborted at once.
 *
 * So a limit set once before the first check bounds a CHECK, never a run: the
 * old code could spend `checks x rlimit`, and with LNS re-entering the solver
 * per window it became `(windows + 1) x checks x rlimit`. That inverts D9 —
 * the deterministic budget stops binding and the wall-clock backstop becomes
 * the real stopping rule, on a machine-dependent boundary that R10 says must
 * never fire at all.
 *
 * --- HOW IT IS ACCOUNTED ---------------------------------------------------
 *
 * z3's own counter, read from `solver.statistics()` under the key
 * `rlimit count`. It is CONTEXT-GLOBAL and monotonic — a fresh `Solver` keeps
 * counting from where the last one stopped, which is exactly what makes it
 * usable as a run total across the sub-solves LNS opens. Every reading here is
 * a DELTA against `base`, so what other runs did before this one is irrelevant,
 * and `withZ3Lock` guarantees no other solve is interleaving with ours.
 *
 * Deterministic by construction: `rlimit` is a resource counter, not a clock,
 * which is the whole reason D9 chose it. Nothing here reads elapsed time.
 */
interface RunBudget {
  /** The whole run's allowance, in z3 resource units. */
  readonly total: number;
  /** `rlimit count` when the run started. Readings are deltas against it. */
  readonly base: number;
  /** Consumed so far by every solve in this run. MEASURED, never assumed. */
  spent: number;
  /**
   * What the run has DRAWN, as opposed to what it spent: each phase is charged
   * the smaller of what it used and what it was allotted.
   *
   * The two differ because a check OVERSHOOTS (see `rlimitSpent`), and the
   * overshoot is z3's, not the next phase's to pay for. Charging it whole makes
   * the reserve imaginary: MEASURED, the main phase's last check overran its
   * 75% share by more than the remaining 25% in EVERY configuration tried —
   * 500_000 spent 1_045_248, 100_000 spent 103_661, 260_000 spent 288_533 — so
   * `spent < total` was false the moment the tiers fell short, and the fallback
   * never ran on a single board it exists for. Allotments are drawn against
   * this; `spent` stays the honest total and is what `rlimitSpent` reports.
   */
  drawn: number;
}

/**
 * z3's own resource counter. Present before the first `check()` (measured: 1 on
 * a brand-new context), but guarded anyway — a missing key must read as
 * "nothing spent yet", not as a `NaN` that would silently disable the cap.
 *
 * `release()` IS NOT OPTIONAL HERE, whatever the API docs' "can help release
 * memory sooner" suggests. `statistics()` allocates a `Z3_stats` in the WASM
 * heap and JS finalisers are not prompt enough to keep up with one reading per
 * `check()`: leaving them to the collector aborted a 14-run probe with
 * `RuntimeError: memory access out of bounds` inside
 * `smt::relevancy_propagator_imp::pop` — a corrupted heap, surfacing at the
 * next `solver.pop()` rather than anywhere near the leak.
 */
function rlimitCount(solver: Solver<"repair">): number {
  const stats = solver.statistics();
  try {
    return stats.keys().includes("rlimit count") ? stats.get("rlimit count") : 0;
  } finally {
    stats.release();
  }
}

/**
 * Read a satisfying model and hand the handle straight back.
 *
 * SAME ARGUMENT AS `rlimitCount` ABOVE, and `ModelImpl` uses the same
 * FinalizationRegistry `StatisticsImpl` does. Every `sat` in this file allocates
 * a `Z3_model` in the WASM heap, and a search can produce one per bound across
 * four tier walks plus every LNS sub-solve — the exact rate at which leaving
 * `Z3_stats` to the collector corrupted the heap and aborted a probe inside
 * `smt::relevancy_propagator_imp::pop`.
 *
 * A CALLBACK RATHER THAN A RETURNED HANDLE, because the model has to outlive the
 * read and not the caller: `model.slotOf` walks every placement literal through
 * it, so releasing before that is a use-after-free and releasing after the
 * caller has moved on is what this replaces. The `finally` also covers a throw
 * out of `slotOf`, which is where an encoder-drift error surfaces.
 *
 * Bounded in practice by `withZ3LockAndReset`'s per-run teardown, so this is
 * insurance rather than a fix for a reproduced abort — see the report.
 */
function withModel<T>(solver: Solver<"repair">, read: (model: Model<"repair">) => T): T {
  const m = solver.model();
  try {
    return read(m);
  } finally {
    m.release();
  }
}

export type BuildStatus =
  /** A board was produced and the gate accepted it. */
  | "ok"
  /** Every tier that ran completed, and none of them could improve on the
   *  greedy seed. A PROOF, not an opinion — the distinction from `ok` is
   *  exactly the distinction between "we stopped looking" and "there is
   *  nothing to find". */
  | "already_optimal"
  /** z3 PROVED no better board exists, and the proof is one of two:
   *
   *    * the bare feasibility probe came back unsat, which can only happen
   *      through a pin (see `solveBuild` §5);
   *    * the T0 walk proved `AtLeast(placed, 1)` unsat, i.e. not one card can
   *      be placed legally.
   *
   *  Never inferred from an `unknown`, and never from an unsat at a bound
   *  above 1 — that is `already_optimal`. The greedy board is still returned. */
  | "infeasible"
  /** The encoder and `validateAssignments` disagreed and the solver's board
   *  INTRODUCED a blocking conflict. The greedy seed is returned and the
   *  disagreement is logged. */
  | "verifier_rejected"
  /** The WASM would not boot. A fallback, never an exception. */
  | "z3_unavailable"
  /**
   * THE SOLVER NEVER SEARCHED THIS BOARD, so nothing is claimed about it.
   *
   * The greedy board is returned and it is a perfectly good board; what is
   * missing is any statement about whether a better one exists. Four causes, in
   * two families.
   *
   * NOTHING WAS EVER ASKED — no `check()` ran and `rlimitSpent` is 0:
   *
   *   * the competition window ends at or before the run's own `startAt`, so
   *     there is no universe to search over;
   *   * the lattice would exceed `MAX_SLOTS` and comes back EMPTY, so there is
   *     nothing to search over either;
   *   * the wall was already gone at the encode, so the run bailed to the seed
   *     before the model existed. Not a rare path — at a five-minute lattice the
   *     greedy seed alone outlasts an 8 s wall from ~40 fixtures up.
   *
   * OR EVERY QUESTION WAS VACUOUS — the ladder ran and established nothing:
   *
   *   * the greedy seed sits BETWEEN slots AND the lattice cannot carry a board
   *     as good as it. Every seed placement is PINNED into the lattice
   *     (`seedPinsOf`), so this is now the residue rather than the common case:
   *     a pin is refused when the slot is inadmissible (a blackout, a session
   *     edge) or on a court the organiser did not configure. Where that leaves
   *     the incumbent's own metrics out of reach, the first tier bound is
   *     unachievable, the model goes unsat, and every later walk is unsat on its
   *     first ask: all four tiers "complete" having looked at nothing.
   *
   * BOTH HALVES OF THAT LAST ONE ARE REQUIRED, and the second is a `check()`
   * (`latticeHoldsIncumbent`), not an inference. An off-grid ROW is not a
   * vacuous LADDER: one card parked against an existing booking's edge, on a
   * board whose others are all on-grid, is searched perfectly well, and flagging
   * it here would tell an organiser their schedule was never looked at when it
   * was.
   *
   * IT EXISTS TO STOP A VACUOUS LADDER READING AS `already_optimal`, which is
   * the damaging outcome — an organiser told their schedule is optimal when it
   * was never searched has no reason to look again and no way to find out. `ok`
   * is barely better: it reads as a board the solver produced and accepted.
   */
  | "not_searched"
  /** This build declined to QUEUE behind `withZ3Lock` rather than wait it out:
   *  `MAX_SOLVER_QUEUE` builds were already in flight, so the greedy board came
   *  back at once and the solver was never consulted. Ordinary rather than an
   *  error — the board is valid, and a retry can do better. */
  | "solver_busy";

export interface BuildInput {
  fixtures: readonly SchedulableFixture[];
  /**
   * `hard` and `restByDivision` are picked in explicitly because `SlotConfig`
   * has neither and `VerifyConfig` has both. Without them a caller writing
   * `{ ...packConfig, hard: compiled }` gets TS2353, deletes the field to make
   * it compile, and every compiled instruction rule silently stops binding —
   * `restByDivision` has no other channel at all, and a cross-division pair
   * then rests at whichever division's number happened to be asked.
   *
   * `tz` is named here too, for the cp-sat wire's `dayIndex`: `solveBuild`
   * derives it from `dayKeyInTz(slot.startAt, tz)`, the same bucketing the
   * verifier's own day-cap pass uses (#447/#448 — `settings.tz` is DISPLAY,
   * `settings.orgTz` is the governing clock, and the wrong one typechecks).
   * Unlike `hard`/`restByDivision`, `SlotConfig` already declares `tz?:
   * string` on its own (the placer's typed-rule day tallies read it too), so
   * this entry is redundant with what the intersection already exposed —
   * added for documentation of the cp-sat dependency, not because
   * `config.tz` was previously unreadable.
   */
  config: SlotConfig & { courts: string[] } & Pick<VerifyConfig, "hard" | "restByDivision" | "tz">;
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  /** POLISH only: fixture ids that may not move. Anchored to `locked` when the
   *  caller supplied one, and to greedy's placement otherwise — see
   *  `publishedSlotOf`. */
  frozen?: readonly string[];
  /**
   * Where the caller's MOVABLE cards sit right now, before this run.
   *
   * Read for exactly two things, and it is NOT part of the immovable board —
   * that is `existing`, and conflating the two would put the organiser's own
   * cards in their own way:
   *
   *   * it is the baseline `moved` is measured against, so the strip's
   *     "moved N" counts from where the organiser was rather than from a greedy
   *     seed they never saw;
   *   * POLISH anchors a freeze to it (R20), so a frozen card without a
   *     `locked` slot is held where it was PUBLISHED instead of wherever greedy
   *     happened to re-place it this run.
   *
   * It still does not constrain the solve: an unfrozen card is free to move off
   * its `current` slot, which is the whole point of asking.
   *
   * AN EMPTY ARRAY MEANS "no board", not "an empty board" — a first-ever build
   * would otherwise report every card it placed as moved.
   *
   * Rows for fixtures this run does not place are still consulted: one that
   * vanishes from the answer is reported through `lost`. So pass the board for
   * the cards this run may touch, not the whole competition, and do not filter
   * it down to the cards you expect back — that is precisely the signal.
   *
   * Optional and additive. Omitting it leaves `moved` measured against the
   * greedy seed and `lost` at 0, which is what every caller got before this
   * field existed.
   */
  current?: readonly Assignment[];
  rlimit?: number;
  wallMs?: number;
}

export interface BuildResult {
  assignments: readonly Assignment[];
  /** Everything wrong with `assignments`, INCLUDING a row per fixture that is
   *  not on the board. `validateAssignments` cannot report an absence — it
   *  iterates the rows it is given — so without this a solver that placed
   *  nothing would hand back an empty conflict list and read as a clean board.
   *  Each absent fixture carries what ACTUALLY happened to it, never a
   *  fabricated one: greedy's own diagnosis if greedy could not place it, the
   *  blocking conflict that disqualified it if the seed was legalised, and only
   *  otherwise a `no_slot` whose detail says whether a proof backs it. */
  conflicts: readonly Conflict[];
  metrics: BoardMetrics;
  /** Where the returned board came from, not which solver was consulted: `z3`
   *  means the board on this result is one z3 produced. */
  engine: "greedy" | "z3" | "z3+lns" | "cp-sat";
  status: BuildStatus;
  tiersCompleted: number;
  budgetExpired: boolean;
  elapsedMs: number;
  /**
   * Rows on this board that changed slot relative to the baseline — the
   * caller's `current` when there is one, and the greedy seed otherwise.
   *
   * RELOCATIONS ONLY. It never exceeds `assignments.length`, which is what makes
   * "moved N" printable beside a board of that size. A card the run could not
   * place is `lost`, not this (R21): folding the two made a single substitution
   * read as 2 and let the number outgrow the board it described.
   */
  moved: number;
  /**
   * Baseline rows that are NOT on this board — matches the caller had scheduled
   * and this run could not place.
   *
   * ALWAYS 0 without `current`, and that is a definition rather than a gap
   * (R21). The greedy seed is this run's own first guess and not a board anybody
   * was shown, so the solver dropping a seed row to fit two better ones is
   * ordinary progress; only the caller's real board can lose a match.
   *
   * Separate from `moved` because the two are different events and only one is
   * alarming — cards moving is what the organiser asked for, a card falling off
   * the board is not, and a single conflated number cannot say which happened.
   */
  lost: number;
  /**
   * What the RUN cost, in z3 resource units, measured off z3's own counter
   * (R11). The whole run — every tier check and every window the fallback
   * opened — because they share one allowance.
   *
   * Deterministic, which is the point: `rlimit` is a resource counter and not a
   * clock (D9), so this number is a property of the search and reproduces on
   * any machine. It exists so the budget is AUDITABLE rather than asserted —
   * "the run stayed inside its allowance" is otherwise unobservable from
   * outside, and it was silently false before R11.
   *
   * MAY EXCEED `rlimit`, and by much more than a rounding error: z3 tests the
   * resource limit at intervals rather than stopping on it, so a check carries
   * a floor cost it pays whatever the limit says. Measured on the four-fixture
   * model in `build-budget.test.ts`: `rlimit: 10` and `rlimit: 100` both spend
   * ~28_600, and `rlimit: 200_000` spends 228_533. Treat this as "the run drew
   * its allowance and one check's overshoot", never as a hard ceiling.
   */
  rlimitSpent: number;
  /**
   * What each LNS window was ALLOTTED, in order, in z3 resource units. Empty
   * when the fallback did not run.
   *
   * Telemetry, and the only place the apportionment is visible from outside:
   * every other symptom of a mis-apportioned budget is downstream of a solve
   * and washes out into "the solver found nothing", which is also what a
   * correctly-budgeted run looks like. Task 13's bench needs it to answer
   * whether one run budget is enough at 200 fixtures and how it should be
   * split.
   */
  lnsWindowRlimits: readonly number[];
  /**
   * The pinned fixtures an `infeasible` verdict is ABOUT (R4).
   *
   * `status: "infeasible"` has two sources and they mean opposite things to an
   * organiser. The T0 source is a statement about the board — not one card can
   * be placed legally. The PROBE source is a statement about the PINS: 38 of 40
   * cards can be scheduled perfectly well, and the only thing z3 proved is that
   * two `locked`/`frozen` placements cannot both be kept. Rendering the second
   * as "no schedule is possible" is false and unactionable, so the result
   * carries the identity of the cards the proof is about and the caller can say
   * which ones. `metrics.placed` / `metrics.total` still carry the rest of the
   * sentence.
   *
   * PRESENT ONLY on the probe path, and its absence on an `infeasible` result
   * is itself meaningful: it says the proof was about the board.
   *
   * It is the pinned SET, sorted, not a minimal unsat core. The claim it
   * supports is "these cannot ALL be kept", never "this one is at fault":
   * `encodeBuild` asserts a `locked` placement as a unit clause of its own, so
   * z3 is never asked the question a core would answer. Naming a subset would
   * need those pins passed as check-time assumptions, which is a change to
   * `build-encode.ts`.
   *
   * Optional and additive on purpose — every existing reader ignores it, and a
   * UI that has not been taught about it degrades to the count.
   */
  contradictoryPins?: readonly string[];
}

/**
 * The verifier gate's decision, as a pure function.
 *
 * A DELTA, not an absolute test, and that is a behavioural ruling rather than a
 * convenience. Blocking conflicts predate this solver: `person_overlap` and
 * `window` became blocking in #399 over boards that were published while they
 * were warnings, and an absolute gate would refuse the solver's answer on every
 * one of those boards forever — the feature would be dead on exactly the dirty
 * boards `deltaConflicts` exists to keep editable. "Never worse than greedy" is
 * enforced by `isStrictlyBetter` on the metrics, not here.
 *
 * `before` is the RAW greedy board — what the organiser gets today — so a
 * breach that is already theirs is not laid at the solver's door.
 *
 * Blocking-filtered BEFORE the delta, deliberately: `conflictKey` is
 * `fixtureId|reason|detail` and does not include `direct`, so a warn-only
 * `order` row and a blocking one can share a key and would cancel.
 *
 * Scoped to `ours` because `validateAssignments` attributes an `order` conflict
 * between two `existing` rows to a fixture this solver never placed. Refusing
 * our own answer over one would be a lock-out with no fix, since nothing the
 * solver can do changes it. Under the delta rule this is belt-and-braces — an
 * unchanged sibling conflict is already matched away — which is why it is
 * exercised here rather than through `buildSchedule`.
 */
export function rejectedBlockingConflicts(
  before: readonly Conflict[],
  after: readonly Conflict[],
  ours: ReadonlySet<string>,
): Conflict[] {
  return deltaConflicts(before.filter(isBlockingConflict), after.filter(isBlockingConflict)).filter(
    (c) => ours.has(c.fixtureId),
  );
}

/**
 * A board's conflicts, in full — the rows' own, PLUS a row per fixture that is
 * not on the board at all.
 *
 * `validateAssignments` answers for the rows it is handed; the fixtures that are
 * NOT on the board are the other half of the truth and it cannot see them.
 * Without this a solver that placed nothing hands back an empty conflict list
 * and reads as a clean board.
 *
 * Three sources, in order of how well established they are, because a fabricated
 * reason is fed straight to the repair prompt:
 *
 *   1. greedy's own diagnosis, which names the binding constraint — AND ONLY FOR
 *      A CARD GREEDY DID NOT PLACE (see `greedyPlaced`);
 *   2. the blocking conflict that disqualified the row from the seed;
 *   3. only then a `no_slot` — and `proved` decides whether its detail claims a
 *      ceiling (T0 came back unsat) or admits the budget ran out.
 *
 * EXPORTED for the web layer (ruling R17). It was module-private, so the API
 * layer grew a second copy of the same three-source rule; two copies of "what
 * actually happened to this card" will drift, and the drift is invisible until
 * an organiser is told the wrong reason. Behaviour is unchanged from the closure
 * it replaces — the captured values are now parameters and nothing else moved.
 */
export function conflictsFor(input: {
  board: readonly Assignment[];
  fixtures: readonly SchedulableFixture[];
  config: BuildConfig;
  existing: readonly Assignment[];
  dependencies: readonly OrderDependency[];
  /** `slotFixtures`' OWN conflicts for the raw greedy seed. */
  greedyConflicts: readonly Conflict[];
  /**
   * The fixtures the RAW greedy seed actually placed.
   *
   * Required, and required as its own field, because `greedyConflicts` cannot be
   * read as "what greedy could not do". `slotFixtures` also files rows about
   * cards it DID place — the `commit` person-overlap loop, and the clash it
   * reports rather than fixes when a `locked` slot collides — and source 1
   * short-circuits the two sources below it. So a card greedy placed and
   * something later removed (the legalisation pass dropping it for a blocking
   * conflict, or z3 dropping one while adding two, which `isStrictlyBetter`
   * permits at equal `placed`) was handed a PLACED card's conflict and never got
   * its own disqualifying row or a `no_slot`.
   *
   * The two sides of one collision then read differently: the card greedy
   * committed first is told which fixture it double-booked with, the second only
   * that "the locked slot clashes on C1", which names nobody — and that string
   * is fed verbatim to the repair prompt.
   */
  greedyPlaced: ReadonlySet<string>;
  /** Seed rows dropped by the legalisation pass, and what disqualified them. */
  disqualified: ReadonlyMap<string, readonly Conflict[]>;
  /** Whether a proof backs an absence, or the budget merely ran out. */
  proved: boolean;
}): Conflict[] {
  const { board, fixtures, config, existing, dependencies, proved } = input;
  const onBoard = new Set(board.map((a) => a.fixtureId));
  const out: Conflict[] = validateAssignments(board, config, existing, dependencies);
  for (const f of fixtures) {
    if (onBoard.has(f.id)) continue;
    const greedySaid = input.greedyPlaced.has(f.id)
      ? []
      : input.greedyConflicts.filter((c) => c.fixtureId === f.id);
    if (greedySaid.length > 0) {
      out.push(...greedySaid);
      continue;
    }
    const dropped = input.disqualified.get(f.id);
    if (dropped !== undefined) {
      out.push(...dropped);
      continue;
    }
    out.push({
      fixtureId: f.id,
      reason: "no_slot",
      detail: proved
        ? "no legal slot in the lattice"
        : "left unplaced when the solver's budget expired",
      rule: RULE_BY_REASON.no_slot,
    });
  }
  return out;
}

/**
 * Everything the GREEDY board is made of, and everything a `BuildResult`
 * describing it needs — all of it derived from the input alone, with no solver
 * and no lock involved.
 *
 * ONE DEFINITION, deliberately. `solveBuild` hands this board back from six
 * early exits, and `buildSchedule` hands it back without entering the lock at
 * all when the queue is full (`MAX_SOLVER_QUEUE`). A second construction of it
 * is the placer/verifier fork this subsystem has already hit three times, and
 * the copy that drifts is always the one deciding what the organiser gets: the
 * first field added to the solver's greedy exit and not to the queue-cap exit
 * would be invisible to every test that only ever looks at one of them.
 *
 * The defaults live here too (`existing`, `dependencies`, `verifyConfig`) so
 * that they are derived exactly once — the "ONE immovable board" rule below is
 * a real invariant, not a style note.
 */
interface GreedySeed {
  /**
   * ONE immovable board, read by three consumers that must not disagree.
   *
   * `encodeBuild` seeds its typed-rule day tallies from this array and
   * `validateAssignments` tallies from the array IT is handed; a filtered or
   * omitted copy on either side puts the encoder and the verifier on different
   * counts and reopens the placer/verifier fork. Every call passes THIS
   * binding — never a filtered view, never `input.existing` re-defaulted.
   */
  existing: readonly Assignment[];
  dependencies: readonly OrderDependency[];
  verifyConfig: BuildConfig;
  /** Greedy's board before legalisation, and its own conflict list. */
  rawSeed: ReturnType<typeof slotFixtures>;
  /** What `validateAssignments` says about the RAW seed. */
  rawSeedConflicts: readonly Conflict[];
  /** Seed rows disqualified by a blocking conflict, mapped to the conflicts
   *  that disqualified them — so the result can report what ACTUALLY happened
   *  to the card instead of inventing a reason for it. */
  disqualified: ReadonlyMap<string, readonly Conflict[]>;
  /** The LEGALISED greedy board: the floor the solver is held to, and the board
   *  every greedy exit returns. */
  assignments: readonly Assignment[];
  metrics: BoardMetrics;
  /**
   * The caller's own board, or `undefined` when they gave us none.
   *
   * AN EMPTY ARRAY IS "NONE", not "a board on which nothing was scheduled".
   * `[]` is the natural shape of a first-ever build on a division nobody has
   * touched, and reading it as a baseline makes every card the run places differ
   * from it — so the strip announces "12 matches moved" about a board that never
   * existed. The distinction is drawn HERE rather than at the call seam, because
   * it has to hold for every caller and not only for the one that remembered.
   *
   * ONE binding, read by both consumers. `publishedSlotOf` anchors a freeze to
   * it (R20) and `movedFrom` measures against it, and those two must never
   * disagree about whether there is a caller board at all: a freeze anchored to
   * the organiser's slot while `moved` counted from greedy's would report a card
   * as moved precisely when it had been held still.
   */
  currentBoard: readonly Assignment[] | undefined;
  /** This run's bindings for the exported `conflictsFor`, which carries the
   *  three-source rule and the reasoning behind it. */
  conflictsForBoard: (board: readonly Assignment[], proved: boolean) => Conflict[];
  /**
   * How many of `board`'s rows sit somewhere other than where the CALLER had
   * them — the number the UI renders verbatim as "moved N" / "nothing moved".
   *
   * MEASURED AGAINST `input.current` WHEN THERE IS ONE, and only otherwise
   * against the greedy seed. The seed is the wrong baseline whenever the two
   * differ, and they differ in exactly the shape POLISH exists for: a fixture
   * the caller froze but did not `lock` has no anchor of its own, so greedy
   * RE-PLACES it and the seed records greedy's slot rather than the organiser's.
   * The run then holds the card at greedy's slot, the diff against the seed is
   * zero, and the strip says "nothing moved" about a board whose published times
   * changed. Falling back to the seed keeps every caller that supplies nothing
   * exactly where it was — a self-comparison, so zero.
   *
   * ONE rule for both exits. The early-return greedy paths hand back the seed
   * itself, and hard-coding `moved: 0` there tells the same lie whenever
   * `current` disagrees with it, so they route through here too.
   *
   * A row missing from the baseline counts as moved, which is right in both
   * directions: under `current` it is a card the organiser had not scheduled at
   * all, and under the seed it is one greedy could not place.
   *
   * ROWS ONLY — a card this run could not place is `lostFrom`'s business, not
   * this one's (R21). Folding the two together made a single substitution read
   * as 2 (the card swapped in counted as moved, the card dropped counted again)
   * and let `moved` exceed the size of the board it describes. A strip printing
   * "moved N" cannot honestly print an N larger than the board.
   */
  movedFrom: (board: readonly Assignment[]) => number;
  /**
   * Baseline rows this run could not place — matches that were on the caller's
   * board and are not on the answer.
   *
   * SCOPED TO `currentBoard`, and zero without one (R21). Against the greedy
   * seed the question is not meaningful: the seed is this run's own first guess,
   * not a board anybody was shown, and the solver dropping a greedy card to fit
   * two better ones is ordinary progress rather than a loss. Measured on the
   * shape that proves it — one slot per court, `a=(E1,E2) b=(E1,E3) c=(E2,E4)`:
   * greedy places only `a`, z3 places `b` and `c`, and counting the seed's `a`
   * as lost took `moved` to 3 on a two-row board.
   *
   * That case is also why the previous justification here was wrong. It claimed
   * a seed baseline could never lose a row because T0 maximises `placed` — but
   * `isStrictlyBetter` only requires `placed >=`, so the solver may drop one
   * card while adding two, and the set can change even when the count does not.
   *
   * Its own field rather than folded into `moved`, because the two are different
   * events and only one of them is alarming: cards moving is what the organiser
   * asked for, a card falling off the board is not.
   */
  lostFrom: (board: readonly Assignment[]) => number;
}

/**
 * The seed, and the legalisation pass that turns it into a floor worth having.
 *
 * See the file header: `placed` has to mean LEGALLY placed or the solver can
 * never beat greedy on a window-overrunning board.
 */
function greedySeed(input: BuildInput): GreedySeed {
  const { fixtures, config } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const verifyConfig: BuildConfig = { ...config };

  const rawSeed = slotFixtures({ fixtures, config, existing });
  const rawSeedConflicts = validateAssignments(
    rawSeed.assignments,
    verifyConfig,
    existing,
    dependencies,
  );
  const disqualified = new Map<string, Conflict[]>();
  const seedIds = new Set(rawSeed.assignments.map((a) => a.fixtureId));
  for (const c of rawSeedConflicts) {
    if (!isBlockingConflict(c) || !seedIds.has(c.fixtureId)) continue;
    const rows = disqualified.get(c.fixtureId);
    if (rows === undefined) disqualified.set(c.fixtureId, [c]);
    else rows.push(c);
  }
  const assignments = rawSeed.assignments.filter((a) => !disqualified.has(a.fixtureId));
  const metrics = boardMetrics(assignments, config.courts, fixtures.length);

  const currentBoard =
    input.current !== undefined && input.current.length > 0 ? input.current : undefined;

  return {
    existing,
    dependencies,
    verifyConfig,
    rawSeed,
    rawSeedConflicts,
    disqualified,
    assignments,
    metrics,
    currentBoard,
    conflictsForBoard: (board, proved) =>
      conflictsFor({
        board,
        fixtures,
        config: verifyConfig,
        existing,
        dependencies,
        greedyConflicts: rawSeed.conflicts,
        // The RAW seed's rows, not the legalised ones: a card the legalisation
        // dropped was still PLACED by greedy, and greedy's row about it is a
        // statement about that placement rather than about its absence.
        greedyPlaced: seedIds,
        disqualified,
        proved,
      }),
    movedFrom: (board) => {
      const was = new Map((currentBoard ?? assignments).map((a) => [a.fixtureId, a]));
      return board.filter((a) => {
        const before = was.get(a.fixtureId);
        return before === undefined || before.court !== a.court || before.startAt !== a.startAt;
      }).length;
    },
    lostFrom: (board) => {
      if (currentBoard === undefined) return 0;
      const onBoard = new Set(board.map((a) => a.fixtureId));
      return currentBoard.filter((a) => !onBoard.has(a.fixtureId)).length;
    },
  };
}

/**
 * The greedy board as a finished `BuildResult` — the ONE place that shape is
 * written down.
 *
 * `spent` is the caller's because only a run that reached the solver has
 * anything but zero to report, and `lnsWindowRlimits` is passed by reference on
 * purpose: `solveBuild` fills it after this closure is built.
 */
function greedyResult(
  seed: GreedySeed,
  status: BuildStatus,
  spent: {
    budgetExpired: boolean;
    elapsedMs: number;
    rlimitSpent: number;
    lnsWindowRlimits: readonly number[];
  },
): BuildResult {
  return {
    assignments: seed.assignments,
    conflicts: seed.conflictsForBoard(seed.assignments, false),
    metrics: seed.metrics,
    engine: "greedy",
    status,
    tiersCompleted: 0,
    budgetExpired: spent.budgetExpired,
    elapsedMs: spent.elapsedMs,
    // NOT a hard 0. This board IS the seed, so it is zero whenever the caller
    // supplied no `current` — but when they did, a card greedy re-placed has
    // genuinely moved from where the organiser had it, and saying otherwise is
    // the same false "nothing moved" the solver paths were fixed for.
    moved: seed.movedFrom(seed.assignments),
    lost: seed.lostFrom(seed.assignments),
    rlimitSpent: spent.rlimitSpent,
    lnsWindowRlimits: spent.lnsWindowRlimits,
  };
}

/**
 * The greedy board and nothing else — for a caller that never reaches the
 * solver at all, so nothing has been spent and the result says so honestly.
 *
 * `budgetExpired` defaults false for the queue-cap case (Gap 4): a
 * `solver_busy` refusal is about CONTENTION, not this board's size — the same
 * call could succeed a moment later against an empty queue, which is not what
 * "expired" means. The R22 size gate is the opposite: refusing THIS wallMs
 * against THIS board is deterministic and will refuse again on retry, which is
 * exactly the budget-insufficiency `canSolveWithin` itself is documented to
 * mean ("not inside this wall") — so its caller passes `true`.
 */
function greedyOnly(
  input: BuildInput,
  status: BuildStatus,
  budgetExpired = false,
): BuildResult {
  const t0 = performance.now();
  const seed = greedySeed(input);
  return greedyResult(seed, status, {
    budgetExpired,
    elapsedMs: performance.now() - t0,
    rlimitSpent: 0,
    lnsWindowRlimits: [],
  });
}

/**
 * How many builds may be waiting on the WASM before a caller is told to take the
 * greedy board instead (Gap 4).
 *
 * `withZ3Lock` serialises the whole PROCESS — it is a correctness device, not a
 * throttle: `resetZ3` kills pthreads process-wide, so it cannot be reentrant.
 * Without this cap the third organiser to click auto-schedule waits out two full
 * `wallMs` budgets before their own run even starts, and their request simply
 * appears hung. Declining to queue converts that into an immediate greedy board
 * carrying `status: "solver_busy"`, which the result strip already renders as an
 * ordinary outcome rather than an error.
 *
 * **`queued` IS PER-PROCESS, so on a multi-instance deployment the real ceiling
 * is `instances x MAX_SOLVER_QUEUE` concurrent solves.** This is memory
 * protection for ONE process's WASM heap — z3's heap only ever grows, and behind
 * a process-wide lock a deeper queue buys no throughput at all, only waiting. It
 * is NOT global admission control and must not be read as one: nothing here
 * coordinates between instances, so a fleet-wide concurrency limit sized off
 * this number would be sized off a single box's.
 */
export const MAX_SOLVER_QUEUE = 2;

/** Builds that have entered `buildSchedule` and not yet finished — running or
 *  waiting on the lock, which from a caller's point of view is the same thing.
 *  Incremented SYNCHRONOUSLY, before anything is awaited, so two calls made in
 *  one tick cannot both read a stale depth. */
let queued = 0;

export function buildSchedule(input: BuildInput): Promise<BuildResult> {
  // The queue cap comes FIRST, ahead of every other reason to fall back to
  // greedy (Gap 4). The R22 size gate (`canSolveWithin`) and `solveBuild`'s own
  // lattice checks also end in a greedy board, but each of them has to build the
  // seed and the lattice to decide — behind the lock, where this caller would be
  // waiting out two full budgets first. This test is a single integer read: it
  // is the only one that can be answered before joining the queue, which is the
  // whole point of it. Order therefore costs nothing either way in the answer
  // and everything in the latency.
  if (queued >= MAX_SOLVER_QUEUE) return Promise.resolve(greedyOnly(input, "solver_busy"));
  // The R22 size gate, called from the ONE place every caller passes through.
  // `canSolveWithin` has existed since Task 13 as a pure predicate the web
  // layer was supposed to call before ever reaching here — it never was
  // (`git grep canSolveWithin` outside this file and its own tests turns up
  // only the offline bench). So a board over the gate paid the full R23
  // uninterruptible cost (encode + first push) before the wall guard caught
  // it downstream, instead of being refused for the price of one `buildGrid`.
  // Wiring it in here, ahead of the queue and the lock, covers every caller at
  // once and keeps the threshold in the one place it is meant to live.
  if (!canSolveWithin(input.fixtures, input.config, input.wallMs ?? DEFAULT_BUILD_WALL_MS, input.existing ?? []))
    return Promise.resolve(greedyOnly(input, "not_searched", true));
  queued++;
  // `withZ3Lock` is NOT reentrant. It is taken exactly here, and nothing below
  // may take it again — `loadZ3` deliberately does not, neither does anything
  // in `build-encode.ts`, and the LNS pass re-enters `solveBuild` rather than
  // `buildSchedule` for exactly this reason. (The plan proposed driving LNS
  // through `repairSchedule`, which DOES take the lock itself, and therefore
  // proposed moving this call inward; nothing here takes it twice, so the lock
  // stays on the outside where it can serialise the whole run.)
  //
  // AND THE TEARDOWN IS OURS, not the caller's (R17). z3's WASM heap only ever
  // grows and nothing frees a finished `Solver`, so a process that runs a
  // handful of solves aborts with an OOM and takes node with it — measured at
  // six consecutive solves. That fix first landed as a `finally` at the web
  // seam, where the NEXT entry point re-introduces the crash simply by not
  // knowing about it; `repairDecomposed` already owns its own resets, and this
  // now matches. `withZ3LockAndReset` rather than a `finally` around this call
  // because the reset has to happen while the lock is still HELD — see its
  // comment for what the obvious spelling does instead.
  //
  // `finally` on the promise, not a `try`/`finally` around the call: the
  // decrement has to happen when the SOLVE settles, and it must run on the throw
  // path too — `solveBuild` swallows a boot failure but not an encoder-drift
  // throw, and a counter that leaked one of those would refuse every subsequent
  // build in this process for as long as it lived.
  return withZ3LockAndReset(() => solveBuild(input)).finally(() => {
    queued--;
  });
}

/**
 * @param allowLns false on the LNS pass's own sub-solves. Each window is solved
 * by re-entering this function with the rest of the board pinned, so without a
 * guard a sub-solve that also fell short of `TIER_COUNT` would open windows of
 * its own, without bound.
 */
/**
 * Obligation 5 (cp-sat cutover): does every declared court offer the exact
 * same set of start times? If not, sending this grid to cp-sat gets the
 * whole request refused (`schema.py`'s `_validate_court_slot_coverage`)
 * rather than mis-scheduled — measured 6/6 under the string contract, a
 * fixture placed on a court at a time it did not actually offer.
 * `Blackout.court?` producing an uneven grid is ordinary org data, not a
 * synthetic edge case, so this is checked before ever calling the service.
 */
function everyCourtSharesGrid(grid: BuildGrid, courts: readonly string[]): boolean {
  if (courts.length <= 1) return true;
  let shared: Set<number> | undefined;
  for (const court of courts) {
    const indices = grid.byCourt.get(court) ?? [];
    const starts = new Set(indices.map((i) => grid.slots[i]!.startAt));
    if (shared === undefined) {
      shared = starts;
      continue;
    }
    if (starts.size !== shared.size || [...starts].some((s) => !shared!.has(s))) return false;
  }
  return true;
}

/**
 * Dense 0..n-1 over the org-local calendar day of every slot, matching
 * EXACTLY how the verifier buckets a day cap (`dayKeyInTz`, the
 * `max_fixtures_per_day` pass in `calendar.ts`) — any other derivation (a
 * UTC quotient, a midnight offset, a day number off the window start)
 * reopens the placer/verifier fork `hardRestMinutesFor`'s own docstring
 * warns about (#447). `tz` undefined returns a function that always answers
 * 0: the verifier skips day-cap counting entirely without a zone, and
 * `solveBuild` pairs this with omitting `dayCapByDivision` so a cap never
 * binds against a fabricated day.
 */
function buildDayIndexOf(
  slots: readonly { startAt: number }[],
  tz: string | undefined,
): (startAt: number) => number {
  if (tz === undefined) return () => 0;
  const keys = [...new Set(slots.map((s) => dayKeyInTz(s.startAt, tz)))].sort();
  const indexByKey = new Map(keys.map((k, i) => [k, i]));
  return (startAt) => indexByKey.get(dayKeyInTz(startAt, tz))!;
}

/**
 * The DIVISION-scoped subset of `max_fixtures_per_day` rules, as the simple
 * per-division map the cp-sat wire carries (design doc: "per-division
 * min_rest_minutes/max_fixtures_per_day"). A rule scoped to the competition,
 * a pool, an entrant or a person has no wire representation of its own —
 * cp-sat v1 does not receive it. That is a real capability gap against z3
 * (which hard-encodes every scope via `encodeBuild` §9), but not a newly
 * silent one: `validateInstructionRules`'s reports are warn-only by design,
 * unrelated to this task.
 *
 * The smallest count wins when more than one rule targets the same division
 * — an "at most" bound, so every rule that applies has to hold at once.
 */
function dayCapsByDivision(hard: readonly HardConstraint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hard) {
    if (h.type !== "max_fixtures_per_day" || h.scope.kind !== "division") continue;
    const prev = out[h.scope.divisionId];
    out[h.scope.divisionId] = prev === undefined ? h.count : Math.min(prev, h.count);
  }
  return out;
}

async function solveBuild(input: BuildInput): Promise<BuildResult> {
  // `performance.now()`, never `Date.now()` — `scripts/engine-boundary.ts` bans
  // ambient wall-clock reads in engine source, and a monotonic clock is the
  // right one for a duration anyway.
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { fixtures, config } = input;
  const wallMs = input.wallMs ?? DEFAULT_BUILD_WALL_MS;
  /** The outer wall. cp-sat clamps its own wall server-side, so this only
   *  has to stop THIS function from spending anything — setup or a network
   *  round trip — once nothing would be left to search with anyway. */
  const outOfTime = (): boolean => elapsed() >= wallMs;

  // 1. The seed, the legalisation pass that turns it into a floor worth having,
  //    and every derived binding the run needs — all of it in `greedySeed`, so
  //    the queue-cap exit in `buildSchedule` returns the SAME board this
  //    function's early exits do rather than a second construction of it.
  const seed = greedySeed(input);
  const { existing, dependencies, verifyConfig, rawSeed, rawSeedConflicts } = seed;
  const { currentBoard, conflictsForBoard, movedFrom, lostFrom } = seed;
  const seedAssignments = seed.assignments;
  const seedMetrics = seed.metrics;

  const greedy = (status: BuildStatus, budgetExpired = false): BuildResult =>
    greedyResult(seed, status, {
      budgetExpired,
      elapsedMs: elapsed(),
      // Neither field means anything on this path: `rlimit` and LNS windows
      // are z3-specific machinery this function no longer has.
      rlimitSpent: 0,
      lnsWindowRlimits: [],
    });

  // 2. The lattice.
  //
  //    A universe that ends before the fixtures begin is not a small lattice,
  //    it is the WRONG one: `repairUniverse` falls back to the first day of the
  //    unix epoch when there is no competition window, no session window and no
  //    existing board, and solving over that would "improve" the board onto
  //    slots in 1970. Refused for the same reason `buildGrid` refuses a
  //    truncated lattice over `MAX_SLOTS`: a lattice the encoder cannot tell
  //    apart from a legal one is worse than none at all.
  //
  //    `not_searched`, NOT `ok`. This exit is taken before the lattice, before
  //    the WASM boot and before the gate, so `ok` — "a board was produced and
  //    the gate accepted it" — is false on both halves, and `budgetExpired`
  //    stays FALSE because nothing was spent, which leaves nothing at all in the
  //    result saying a solver was never consulted. The organiser reaching it is
  //    one who edited the competition window to end before the run's own start.
  const universe = repairUniverse({ proposal: [], existing, config });
  if (config.startAt >= universe.to) return greedy("not_searched");

  /**
   * Where a card the caller says may not move actually IS.
   *
   * THREE SOURCES, in descending order of how much the ORGANISER would
   * recognise the answer (R20):
   *
   *   1. `locked` — the caller naming a slot outright;
   *   2. `current` — where the card sits on the caller's own board, which for
   *      POLISH is the time an entrant has already been told;
   *   3. greedy's re-placement, and only as a last resort.
   *
   * The third is a slot greedy INVENTED during this very run, so anchoring to it
   * freezes the card to a time nobody has ever seen — POLISH silently moving a
   * published card, which is the exact opposite of the mode's purpose. It stayed
   * that way only because `BuildInput` had no published-board field; `current`
   * is that field, so `locked` is no longer the only way to express a true
   * freeze. The fallback survives for the caller that supplies neither, where a
   * pin at greedy's slot is still better than no freeze at all.
   *
   * `currentBoard`, not `input.current`, so an empty array is "no board" here
   * exactly as it is for `moved` — the two must agree or a freeze anchored to
   * one baseline gets counted against the other.
   *
   * The RAW seed, not the legalised one: a card the legalisation pass dropped
   * still has a placement the organiser is looking at.
   */
  const publishedSlotOf = (id: string): BuildSlot | undefined => {
    const f = fixtures.find((x) => x.id === id);
    if (f?.locked !== undefined) return f.locked;
    const now = currentBoard?.find((a) => a.fixtureId === id);
    if (now !== undefined) return { court: now.court, startAt: now.startAt };
    const at = rawSeed.assignments.find((a) => a.fixtureId === id);
    return at === undefined ? undefined : { court: at.court, startAt: at.startAt };
  };

  const frozenIds = input.frozen ?? [];
  // Every anchor is PINNED into the lattice, exactly as a `locked` placement
  // is. This is the deliberate answer to an off-grid freeze — a card the
  // organiser dragged to 09:07, or one greedy parked against the edge of an
  // existing booking. Dropping it (what a bare `findIndex === -1` did) lets the
  // card move under POLISH while the result still says `ok`, which is the one
  // outcome that silently breaks the caller's contract; refusing the whole run
  // would contradict "auto-schedule always hands back a board". Pinning honours
  // the freeze, and any illegality the pin causes surfaces through the ordinary
  // conflict and gate path where somebody can see it.
  //
  // Carried WITH the fixture id, not as a bare slot list, because an
  // `infeasible` proved off these pins has to be able to name them (R4).
  //
  // A FROZEN ID THAT NAMES NO FIXTURE IN THIS RUN IS NOT A PIN. `publishedSlotOf`
  // falls back to `current`, so a stale id — a filtered `schedulable` list,
  // another division's card, a board read before a deletion — resolves to a slot
  // this run has no card for, and a pin is admitted into the lattice
  // UNCONDITIONALLY, court filter included. The result is a free slot on a court
  // the organiser never configured: measured, `courts: ["C1"]` plus a ghost pin
  // on `C9` placed a real fixture on C9 and reported `status: "ok"`.
  //
  // The same guard the force loop below already applies (`i < 0 -> continue`),
  // and it belongs on BOTH: skipping the card there while still buying it a
  // lattice slot here is what let the slot go to somebody else. It also keeps
  // `contradictoryPins` — which is `pinnedIds` — naming only cards the caller
  // can act on.
  const ownFixture = (id: string): boolean => fixtures.some((f) => f.id === id);
  const pins: { id: string; at: BuildSlot }[] = [
    ...fixtures.flatMap((f) => (f.locked !== undefined ? [{ id: f.id, at: f.locked }] : [])),
    ...frozenIds.flatMap((id) => {
      if (!ownFixture(id)) return [];
      const at = publishedSlotOf(id);
      return at === undefined ? [] : [{ id, at }];
    }),
  ];
  const pinned = pins.map((p) => p.at);
  /** Sorted and de-duplicated: a `locked` card named in `frozen` too is one
   *  pin, and the order is part of what makes two runs comparable. */
  const pinnedIds = [...new Set(pins.map((p) => p.id))].sort();
  const grid = restrictToConfiguredCourts(
    buildGrid({ config, existing, pinned, seedPins: seedPinsOf(seedAssignments, config.courts) }),
    config.courts,
    pinned,
  );
  // There is no rescue for an over-cap lattice here: `buildGrid` never reads
  // the fixture list at all, so `overCap` is a function of the config, the
  // immovable board and the pins alone — nothing this function could retry
  // would shrink it. Rescuing one means shrinking the LATTICE itself (slicing
  // the horizon per window), which is a design change and out of scope
  // (controller ruling, Task 6).
  //
  // `not_searched`, NOT `ok`. There is no lattice, so nothing was looked at,
  // and a strip reading "the quick pass produced this board" is the most it can
  // honestly say — never that the board was produced and accepted by a solver.
  if (grid.overCap || grid.slots.length === 0) return greedy("not_searched");

  // Obligation 5 (cp-sat cutover, see `everyCourtSharesGrid`): a per-court
  // grid is refused by the service, not mis-scheduled, and this is reachable
  // from ordinary org data (`Blackout.court?`), not synthetic. Checked here,
  // before ever calling the service, rather than sent and learned from an
  // `invalid_request` error — the two are behaviourally identical (both end
  // at the greedy board) and checking locally costs nothing extra. This is a
  // capability gap against z3, tracked as a Prompt 10 blocker: closing it
  // properly (a per-fixture (court, start) domain, `court_allow`) is task
  // C2's, not this one's — do not build a narrower fix here that C2 then has
  // to widen.
  if (!everyCourtSharesGrid(grid, config.courts)) return greedy("not_searched");

  // The seed, the lattice and the checks above are already behind us; a wall
  // that has already gone must not pay for a network round trip nobody will
  // be allowed to wait for.
  if (outOfTime()) return greedy("not_searched", true);

  // 3. cp-sat.
  //
  // Obligation 3: a pin (`locked`, or `frozen` resolved to an anchor above)
  // cannot be expressed to cp-sat as "place this fixture, but only here" —
  // the wire has no per-fixture slot-pin field, only `existing` rows
  // (immovable) and `fixtures` (free to go anywhere the model likes). So
  // every pin is sent as an `existing` row at its own (court, startAt) and
  // DROPPED from `fixtures` — sending it in both is exactly how it silently
  // stops being pinned: the `existing` row lays a fixed blocking interval
  // while the movable fixture stays free, and it comes back placed a SECOND
  // time elsewhere, OPTIMAL, no error (measured 5/5 under the string
  // contract; see the field comment on `SolveBuildInput.existing` in
  // `cpsat-client.ts`, which the wire being positional now does not change).
  // This is also the documented shape of POLISH: "BUILD with a frozen set
  // already folded into the request's existing/pinned rows."
  const pinnedFixtureIds = new Set(pins.map((p) => p.id));
  const freeFixtures = fixtures.filter((f) => !pinnedFixtureIds.has(f.id));
  const freeFixtureIds = new Set(freeFixtures.map((f) => f.id));
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
  const matchMs = config.matchMinutes * MS_PER_MIN;

  /** Same field derivation `encodeBuild`'s own `asAssignment` uses, so a
   *  pinned row and a cp-sat-placed row are built identically. */
  const assignmentOf = (fixtureId: string, court: string, startAt: number): Assignment => {
    const f = fixtureById.get(fixtureId);
    return {
      fixtureId,
      court,
      startAt,
      endAt: startAt + matchMs,
      entrants: f === undefined ? [] : [f.home, f.away].filter((e): e is string => e !== undefined),
      people: f === undefined ? [] : [...(f.people ?? [])],
      ...(f?.poolId !== undefined ? { poolId: f.poolId } : {}),
      ...(f?.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
    };
  };
  const pinnedAssignments = pins.map((p) => assignmentOf(p.id, p.at.court, p.at.startAt));

  // Obligation 1: `dayIndex` is the org's local calendar day, bucketed
  // EXACTLY the way the verifier buckets a day cap — any other derivation
  // reopens the placer/verifier fork `hardRestMinutesFor`'s own docstring
  // warns about (#447). `tz` undefined means the verifier skips day-cap
  // counting entirely, so every slot gets the SAME index (0) and
  // `dayCapByDivision` is omitted below rather than binding a cap against a
  // fabricated day (#448 — `settings.tz` is DISPLAY, `settings.orgTz` is the
  // governing clock, and the in-scope wrong one typechecks).
  const tz = verifyConfig.tz;
  const dayIndexOf = buildDayIndexOf(grid.slots, tz);
  const dayCapByDivision = tz === undefined ? undefined : dayCapsByDivision(effectiveHard(verifyConfig));

  const cpsatInput: SolveBuildInput = {
    courts: config.courts,
    fixtures: freeFixtures.map((f) => ({
      fixtureId: f.id,
      entrantIds: [f.home, f.away].filter((e): e is string => e !== undefined),
      divisionId: f.divisionId ?? "",
    })),
    grid: {
      slots: grid.slots.map((s) => ({
        court: s.court,
        startAtMs: s.startAt,
        dayIndex: dayIndexOf(s.startAt),
      })),
      stepMinutes: grid.stepMinutes,
    },
    existing: [
      ...existing.map((a) => ({ fixtureId: a.fixtureId, court: a.court, startAtMs: a.startAt })),
      ...pins.map((p) => ({ fixtureId: p.id, court: p.at.court, startAtMs: p.at.startAt })),
    ],
    // Filtered to pairs where BOTH ends are fixtures cp-sat is actually being
    // asked to place: `fixtureIndexOf` throws `invalid_request` for an id
    // that names an `existing`/pinned row instead (positional identity has no
    // slot for it), which would fail the WHOLE request over one dependency
    // this run cannot violate anyway — a pin's time is fixed, and an
    // `existing` row's order was already decided outside this run. Dropping
    // the pair here is safe, not silent: `validateAssignments` (below) still
    // catches an actual `order` violation as a blocking conflict.
    dependencies: dependencies
      .filter((d) => freeFixtureIds.has(d.fixtureId) && freeFixtureIds.has(d.dependsOn))
      .map((d) => ({ beforeFixtureId: d.dependsOn, afterFixtureId: d.fixtureId })),
    constraints: {
      matchMinutes: config.matchMinutes,
      gapMinutes: config.gapMinutes,
      ...(verifyConfig.restByDivision !== undefined ? { restByDivision: verifyConfig.restByDivision } : {}),
      ...(dayCapByDivision !== undefined && Object.keys(dayCapByDivision).length > 0
        ? { dayCapByDivision }
        : {}),
    },
    wallSeconds: Math.max(1, Math.round((wallMs - elapsed()) / 1000)),
  };

  // Loaded dynamically, never `import { solveBuild } from "./cpsat-client.ts"`
  // at the top of this file: this repo has a recorded trap where a mock
  // against a module the file under test also imports statically is INERT,
  // and it has previously passed 5/5 with the guard deleted. `build.test.ts`
  // mocks this exact call via `vi.spyOn(await import("./cpsat-client.ts"),
  // "solveBuild")`, which only observes what THIS line does if this line
  // resolves the same module namespace object dynamically too — mirroring
  // how `z3-load.ts` defers its own WASM import to inside `loadZ3`, one call
  // site removed from this file. See the (type-only) import of
  // `SolveBuildInput`/`SolveBuildOutcome` above for the rest of the reasoning.
  let outcome: SolveBuildOutcome;
  try {
    const cpsatClient = await import("./cpsat-client.ts");
    outcome = await cpsatClient.solveBuild(cpsatInput, {
      secret: process.env.CPSAT_SERVICE_SECRET ?? "",
    });
  } catch {
    // Any rejection — deadline, unavailable, transport, or a request this
    // function itself got wrong — falls back to greedy exactly as the
    // z3-unavailable path always has. Distinguishing failure reasons into
    // their own engine-status vocabulary is Task 06b's job (`_RULES.md` §4:
    // the "wire -> engine" status translation), not this one's.
    return greedy("not_searched", true);
  }

  // `ERROR` is a RESOLVED outcome, not a rejection, but it carries the same
  // instruction: an unmapped or unreadable status is a board this function
  // has no reason to trust (see `cpsat-client.ts`'s comment on
  // `STATUS_BY_WIRE_VALUE`), so it is handled identically to a rejection.
  if (outcome.status === "ERROR") return greedy("not_searched", true);

  // The pins are the only thing that can make this request's model unsat:
  // without one the empty board is always a legal answer (the same reasoning
  // z3's own feasibility probe used). So an `INFEASIBLE` verdict is a proof
  // about the pins, and the result says so by name, exactly as the z3 path
  // did.
  if (outcome.status === "INFEASIBLE") {
    return { ...greedy("infeasible"), contradictoryPins: pinnedIds };
  }

  const placedAssignments = outcome.assignments.map((a) => assignmentOf(a.fixtureId, a.court, a.startAtMs));
  const incumbent: readonly Assignment[] = [...pinnedAssignments, ...placedAssignments];
  const incumbentMetrics = boardMetrics(incumbent, config.courts, fixtures.length);
  const budgetExpired = outcome.wallExhausted;
  const tiersCompleted = outcome.tiersCompleted;
  // Whether an absent fixture's `no_slot` conflict may honestly claim a proof
  // ("no legal slot in the lattice") or must admit the budget ran out — see
  // `conflictsFor`. Cosmetic wording only; it gates nothing else below.
  const proved = tiersCompleted >= 1;

  // 7. The gate. Encoder and verifier disagreeing is the exact bug class this
  //    design exists to prevent, so it is never silent — but it is also never
  //    an exception, because the organiser still needs a board, and it is a
  //    DELTA rather than an absolute test (see `rejectedBlockingConflicts`).
  //    UNCHANGED from the z3 path: `validateAssignments` (via
  //    `conflictsForBoard`) runs generically over whichever engine's board it
  //    is handed, and a cp-sat board comes back through the exact same call
  //    z3's did.
  const conflicts = conflictsForBoard(incumbent, proved);
  const ours = new Set(incumbent.map((a) => a.fixtureId));
  const rejected = rejectedBlockingConflicts(rawSeedConflicts, conflicts, ours);
  if (rejected.length > 0) {
    // The one place this library prints. The caller is handed a VALID board and
    // a status field they may never read, so an encoder/verifier fork would
    // otherwise reach nobody until an organiser filed a ticket about it.
    // eslint-disable-next-line no-console
    console.error(
      `buildSchedule: verifier rejected the cp-sat solver's board (${rejected
        .map((c) => `${c.fixtureId}:${c.reason}`)
        .join(", ")}) — falling back to the greedy seed`,
    );
    return { ...greedy("verifier_rejected", budgetExpired), tiersCompleted };
  }

  const moved = movedFrom(incumbent);
  const lost = lostFrom(incumbent);

  // A DELIBERATELY SIMPLER status derivation than z3's. The z3 path also asked
  // whether the tier ladder was proved over a NON-EMPTY region
  // (`seedOffLattice`/`latticeHoldsIncumbent`) before claiming
  // `already_optimal` — that nuance has no cp-sat equivalent here (there is no
  // live solver handle left to ask a follow-up `check()` of once the RPC has
  // returned) and is left to Task 06b's status-mapping work (`_RULES.md` §4).
  // What is kept: a board that matches or loses to the greedy seed, with
  // every tier proved, is `already_optimal`; one that proved nothing placed
  // is `infeasible`; everything else is `ok`.
  const improved = isStrictlyBetter(incumbentMetrics, seedMetrics);
  let status: BuildStatus = "ok";
  if (tiersCompleted === TIER_COUNT && !improved) {
    status = incumbentMetrics.placed === 0 && fixtures.length > 0 ? "infeasible" : "already_optimal";
  }

  return {
    assignments: incumbent,
    conflicts,
    metrics: incumbentMetrics,
    engine: "cp-sat",
    status,
    tiersCompleted,
    budgetExpired,
    elapsedMs: elapsed(),
    moved,
    lost,
    rlimitSpent: 0,
    lnsWindowRlimits: [],
  };
}

/**
 * THE INVARIANT: THE SOLVER MUST NEVER BE UNABLE TO EXPRESS ITS OWN INCUMBENT.
 *
 * Every tier bound the ladder asserts is read off the incumbent's own metrics,
 * so a lattice that cannot hold the incumbent makes the FIRST bound unsat and
 * every walk after it unsat on its first ask — four tiers "completed" having
 * refuted nothing, which is indistinguishable from a proof unless somebody asks
 * (`latticeHoldsIncumbent`). The cure is to put the incumbent's own
 * `(court, startAt)` pairs into the lattice.
 *
 * WHY NOT A FINER STEP. `gridStepMinutes` was briefly made to fold every rest
 * amount so that greedy's `lastEnd + rest` chaining landed on the grid by
 * construction. It works, and it costs ~8x the lattice on EVERY board whose
 * rest is incommensurate with its pitch — measured at the 8 s wall: slots at
 * n=10/80/140 24/168/288 -> 136/1260/2192, last improving size 80 -> 20,
 * `canSolveWithin` admitting n<=80 -> n<=20, and three of eighteen runs killed
 * outright by an emscripten heap OOM inside the WASM, which in production is
 * the request's whole process. Pinning is O(n) extra slots, and only on the
 * boards that are actually off-grid.
 *
 * TWO THINGS IT IS NOT.
 *
 *   * NOT a promise that the seed is representable. A pin on a court the
 *     organiser did not configure is dropped here (`restrictToConfiguredCourts`
 *     would drop it anyway, and buying a ghost court a slot is the bug R20
 *     fixed), and `buildGrid` refuses one whose slot is inadmissible. So
 *     `seedOffLattice` stays reachable and `not_searched` stays honest — rare
 *     rather than impossible.
 *   * NOT free of consequence for the search. Those slots are then available to
 *     EVERY fixture, not only the one that seeded them, so `already_optimal`
 *     means "over the lattice plus the seed's own slots". That is a wider
 *     search space than the bare lattice and a narrower one than a refined
 *     step; the verifier gate still passes on whatever comes back, because a
 *     seed pin is admitted only where an ordinary slot would have been.
 *
 * De-duplicated so the slot count is a function of the board and not of how
 * many rows happen to share a start.
 */
export function seedPinsOf(
  seed: readonly Assignment[],
  courts: readonly string[],
): readonly BuildSlot[] {
  const allowed = new Set(courts);
  const seen = new Set<string>();
  const out: BuildSlot[] = [];
  for (const a of seed) {
    const key = `${a.court}|${a.startAt}`;
    if (!allowed.has(a.court) || seen.has(key)) continue;
    seen.add(key);
    out.push({ court: a.court, startAt: a.startAt });
  }
  return out;
}

/**
 * The lattice, minus every slot on a court the organiser did not configure (R3).
 *
 * `buildGrid` takes its court list from `repairCourts`, which folds in every
 * court an `existing` row uses. That is right for a REPAIR — a card already
 * sitting on court 5 may stay on court 5 — and wrong for a BUILD, which would
 * otherwise place brand-new fixtures onto a court that exists only because some
 * other division borrowed it. The verifier never tests court membership, so
 * nothing here was ever reported; it is a product ruling, not a parity fix.
 *
 * Applied as a post-filter rather than by narrowing what `buildGrid` generates,
 * because `repairCourts` has no knob and `build-grid.ts` is shared with the
 * repair solver. Slot ORDER is preserved, which matters: `buildGrid` sorts by
 * (court, startAt) and the encoder names its variables by slot INDEX, so a
 * filter that reordered would silently rename every variable.
 *
 * PINNED SLOTS ARE EXEMPT. A card the caller locked onto an unlisted court must
 * still be representable — `encodeBuild` §4 throws outright when a locked
 * placement is missing from the lattice, and short of that the run would report
 * a contradiction the organiser never expressed.
 *
 * `overCap` is carried through unchanged, and deliberately not recomputed: it
 * was decided against the UNFILTERED lattice, so a board whose extra courts
 * pushed it over `MAX_SLOTS` still goes to greedy even though the filtered
 * lattice would have fitted. Conservative in the safe direction, and the cap is
 * two orders of magnitude away from any real board.
 */
function restrictToConfiguredCourts(
  grid: BuildGrid,
  courts: readonly string[],
  pinned: readonly BuildSlot[],
): BuildGrid {
  const allowed = new Set(courts);
  const key = (s: BuildSlot): string => `${s.court}|${s.startAt}`;
  const exempt = new Set(pinned.map(key));
  const slots = grid.slots.filter((s) => allowed.has(s.court) || exempt.has(key(s)));
  if (slots.length === grid.slots.length) return grid;
  const byCourt = new Map<string, number[]>();
  slots.forEach((s, i) => {
    const rows = byCourt.get(s.court);
    if (rows === undefined) byCourt.set(s.court, [i]);
    else rows.push(i);
  });
  return { slots, byCourt, stepMinutes: grid.stepMinutes, overCap: grid.overCap };
}

// --- the three lexicographic tiers ------------------------------------------

export interface Tier {
  name: string;
  /**
   * The metric this tier minimises, in WHOLE MILLISECONDS.
   *
   * `boardMetrics` reports MINUTES, as floats: `(hi - lo) / 60_000` for the
   * makespan and a sum of such quotients for each court's load. Every bound
   * asserted below is a z3 integer, so the two are compared in the unit the
   * underlying quantities actually are — milliseconds — and the float is
   * converted back with `Math.round`, which is exact for any value that came
   * from dividing an integer number of milliseconds by 60_000. Flooring would
   * round a 30-second idle gap down to zero and freeze a bound the incumbent
   * does not meet, which is the one failure mode that would make a later tier
   * unsatisfiable against the board in hand.
   */
  of: (m: BoardMetrics) => number;
  /**
   * Assert "this metric is at most `boundMs`" into the solver's CURRENT scope.
   *
   * Called under `push`/`pop` while the tier walks, and once at the top level to
   * freeze what it achieved. A function rather than an `Arith` term because only
   * two of the three ARE terms: the idle gap is a clause family whose shape
   * depends on the bound, and pretending otherwise would mean an integer
   * variable per participant pair and the arithmetic encoding this whole design
   * exists to avoid.
   */
  atMost: (boundMs: number) => void;
}

export interface TierInput {
  Z3: Z3Context["Z3"];
  solver: Solver<"repair">;
  model: EncodedModel;
  grid: BuildGrid;
  fixtures: readonly SchedulableFixture[];
  config: SlotConfig & { courts: string[] };
}

/**
 * Builds all three tiers, and every assertion they SHARE, exactly once.
 *
 * Called before the tier loop rather than lazily per tier, because two of the
 * three define themselves through assertions (`lo <= start` and friends) and an
 * assertion added inside a `push` would vanish at the matching `pop` — the tier
 * would then "optimise" a variable nothing constrains and report a bound no
 * board meets. Every definition here is an IMPLICATION off a placement literal,
 * so none of it changes which boards are legal.
 *
 * EXPORTED for `scripts/bench-build.ts` only (Task 13, question Q8: how big is
 * the idle-gap clause family at target scale, and which tier dominates). The
 * size of a tier's encoding is invisible from `BuildResult` — every symptom of
 * an expensive tier washes out into "the run stopped early", which is also what
 * a cheap tier under a small budget looks like — so measuring it means stating a
 * bound against a real encoded model and counting the assertions. The
 * alternative was for the bench to restate the clause shapes itself, which is a
 * placer/verifier fork in a new costume. No production caller outside this file.
 */
export function buildTiers(input: TierInput): Tier[] {
  const { Z3, solver, model, grid, fixtures, config } = input;
  const slots = grid.slots;
  const durMs = config.matchMinutes * MS_PER_MIN;

  /** "Some fixture sits in slot s". The same abstraction `build-encode.ts`
   *  uses and exact for the same reason: its §2 says a slot holds at most one
   *  fixture, so an occupancy literal cannot count to two. */
  const occAny = slots.map((_sl, s) => {
    const o = Z3.Bool.const(`m_occ_${s}`);
    solver.add(o.eq(Z3.Or(...fixtures.map((_f, i) => model.place[i]![s]!))));
    return o;
  });

  // --- T1: makespan ---------------------------------------------------------
  //
  // `boardMetrics` reports `maxEnd - minStart` over the PLACED rows, and every
  // row a build produces is exactly `matchMinutes` long, so both ends are known
  // statically per slot. Two free integers squeezed onto the real extremes: the
  // implications force `lo <= every occupied start` and `hi >= every occupied
  // end`, hence `hi - lo >= maxEnd - minStart`, and setting them to the extremes
  // themselves is always available — so `hi - lo <= B` holds for exactly the
  // boards whose true makespan is at most B. Nothing pins them on an empty
  // board, which is why the walk never asks below zero.
  const mkLo = Z3.Int.const("mk_lo");
  const mkHi = Z3.Int.const("mk_hi");
  slots.forEach((sl, s) => {
    solver.add(
      Z3.Implies(occAny[s]!, Z3.And(mkLo.le(sl.startAt), mkHi.ge(sl.startAt + durMs))),
    );
  });
  const makespan = mkHi.sub(mkLo);

  // --- T3: court imbalance --------------------------------------------------
  //
  // `boardMetrics` measures the busiest configured-or-used court minus the
  // quietest, so the court SET it divides by is `config.courts` plus whatever
  // courts the board actually used — a configured court nobody plays on counts
  // as a zero (that is the point of the metric), while an UNconfigured court
  // nobody plays on is not in the set at all.
  //
  // THE SECOND HALF OF THAT SENTENCE IS UNREACHABLE HERE, and the bound is
  // unconditional because of it. Under R3 the only slots left on an
  // unconfigured court are exact matches for a PIN (`restrictToConfiguredCourts`
  // deletes the rest), and every pin is force-asserted true — `encodeBuild` §4
  // for a `locked` fixture, the frozen-anchor loop above for the other source.
  // So an unconfigured court in `grid.byCourt` provably carries load, it is
  // provably in `boardMetrics`' court set, and `lo <= load` is exactly right
  // for it. An earlier draft guarded this with `Implies(load >= 1, ...)`; that
  // guard was not merely untested but DEAD, since its antecedent holds for
  // every reachable input, and a dead guard reads as a case somebody once saw.
  //
  // THAT ARGUMENT WAS BRIEFLY UNSOUND, which is worth recording: the pin builder
  // resolved a `frozen` id through `current` without checking it named a fixture
  // in this run, while the force loop skipped exactly those ids. Such a pin
  // bought a lattice slot nothing could be forced onto — an unconfigured court
  // carrying no load — and this line then pulled the minimum to zero and had T3
  // chase an imbalance the board did not have. `ownFixture` above restores the
  // premise: every pin names a card of this run's, so every pin is forced.
  //
  // (If an unforced pin source is ever added — a pin the solver may decline —
  // this is the line that has to come back, because a court in the lattice with
  // nothing on it would then pull the minimum to zero and report an imbalance
  // the board does not have.)
  const cbLo = Z3.Int.const("cb_lo");
  const cbHi = Z3.Int.const("cb_hi");
  const loadOf = (rowsOnCourt: readonly number[]): Arith<"repair"> =>
    Z3.Sum(
      Z3.Int.val(0),
      ...rowsOnCourt.map((s) => Z3.If(occAny[s]!, Z3.Int.val(durMs), Z3.Int.val(0))),
    );
  for (const rowsOnCourt of grid.byCourt.values()) {
    const load = loadOf(rowsOnCourt);
    solver.add(cbHi.ge(load));
    solver.add(cbLo.le(load));
  }
  // A configured court with no slots at all — blacked out, or outside every
  // session window. `boardMetrics` still seeds it at zero, so it still pulls the
  // minimum down, and leaving it out would understate the imbalance.
  for (const court of config.courts) {
    if (grid.byCourt.has(court)) continue;
    solver.add(cbHi.ge(0));
    solver.add(cbLo.le(0));
  }
  const imbalance = cbHi.sub(cbLo);

  // --- T2: worst idle gap ---------------------------------------------------
  //
  // The one metric with no honest term. `boardMetrics` takes, per participant
  // with two or more rows, the largest wait between CONSECUTIVE matches — and
  // "consecutive" is not a static property of a slot pair, it depends on which
  // other slots that participant occupies. Written as arithmetic it needs an
  // integer per participant pair and an ordering between them, which is the
  // O(n^2) encoding `build-encode.ts` exists to avoid.
  //
  // Stated as a BOUND it collapses. Every row is `matchMinutes` long, so a gap
  // of at most B is the same statement as consecutive STARTS at most
  // `W = B + matchMinutes` apart, and that is a clause family:
  //
  //     for each participant p and each start index k, with j the first start
  //     beyond starts[k] + W:      ~occ[k] \/ ~tail[j] \/ (p occupies something
  //                                in (starts[k], starts[k] + W])
  //
  // where `occ[k]` is "p occupies start k" and `tail[j]` is "p occupies some
  // start >= starts[j]". Both directions hold, which is the only thing that
  // makes the bound the metric rather than an approximation of it:
  //
  //   * SOUND. A violated clause means p occupies starts[k], occupies something
  //     beyond starts[k] + W, and occupies nothing in between — so the SUCCESSOR
  //     of starts[k] is more than W away and the real gap really does exceed B.
  //     Nothing legal is refused.
  //   * COMPLETE. If two consecutive occupied starts a < b are more than W
  //     apart, the clause at k = index(a) is violated: `occ[k]` holds, `tail[j]`
  //     holds because b lies beyond starts[k] + W, and the window between them
  //     is empty precisely because a and b are consecutive.
  //
  // (An earlier draft anchored the first literal on "p occupies some start <=
  // starts[k]" instead. It is equivalent — completeness is already argued at
  // k = index(a), where the two agree — so the extra prefix chain bought
  // nothing and is gone.)
  //
  // Cost is one clause per (participant, start) of length |window|, and only
  // participants with two or more fixtures are built at all — everyone else
  // contributes 0 to the metric by definition and would be pure encoding.
  // `tail` is a chain, so it is O(|starts|) and, unlike the clauses,
  // bound-independent, which is what lets the walk re-state only the clauses.
  const starts = [...new Set(slots.map((s) => s.startAt))].sort((a, b) => a - b);
  const slotsAtStart = starts.map((t) =>
    slots.flatMap((sl, s) => (sl.startAt === t ? [s] : [])),
  );
  /** Fixture indexes per participant, namespaced exactly as `boardMetrics` and
   *  `build-encode.ts` namespace them so an entrant id can never collide with a
   *  person id. */
  const byParticipant = new Map<string, number[]>();
  fixtures.forEach((f, i) => {
    for (const p of new Set([
      ...[f.home, f.away].filter((e): e is string => e !== undefined).map((e) => `e:${e}`),
      ...(f.people ?? []).map((p) => `p:${p}`),
    ])) {
      const rows = byParticipant.get(p);
      if (rows === undefined) byParticipant.set(p, [i]);
      else rows.push(i);
    }
  });

  let gapGroups = 0;
  const gapParticipants = [...byParticipant.values()]
    .filter((group) => group.length >= 2)
    .map((group) => {
      const g = gapGroups++;
      const occ = starts.map((_t, k) => {
        const o = Z3.Bool.const(`gp_${g}_${k}`);
        solver.add(
          o.eq(Z3.Or(...group.flatMap((i) => slotsAtStart[k]!.map((s) => model.place[i]![s]!)))),
        );
        return o;
      });
      const tail: Bool<"repair">[] = new Array<Bool<"repair">>(occ.length);
      for (let k = occ.length - 1; k >= 0; k--) {
        if (k === occ.length - 1) {
          tail[k] = occ[k]!;
          continue;
        }
        const v = Z3.Bool.const(`gt_${g}_${k}`);
        solver.add(v.eq(Z3.Or(occ[k]!, tail[k + 1]!)));
        tail[k] = v;
      }
      return { occ, tail };
    });

  const assertGapAtMost = (boundMs: number): void => {
    const width = boundMs + durMs;
    for (const p of gapParticipants) {
      for (let k = 0; k < starts.length; k++) {
        let j = k + 1;
        while (j < starts.length && starts[j]! <= starts[k]! + width) j++;
        // Nothing lies beyond the window, so no start can be stranded past it —
        // and `starts[k]` only grows, so neither can any later k.
        if (j >= starts.length) break;
        const between: Bool<"repair">[] = [];
        for (let i = k + 1; i < j; i++) between.push(p.occ[i]!);
        solver.add(Z3.Or(Z3.Not(p.occ[k]!), Z3.Not(p.tail[j]!), ...between));
      }
    }
  };

  const ms = (minutes: number): number => Math.round(minutes * MS_PER_MIN);
  return [
    {
      name: "makespan",
      of: (m) => ms(m.makespanMinutes),
      atMost: (boundMs) => solver.add(makespan.le(boundMs)),
    },
    {
      name: "idleGap",
      of: (m) => ms(m.worstIdleGapMinutes),
      atMost: assertGapAtMost,
    },
    {
      name: "imbalance",
      of: (m) => ms(m.courtImbalanceMinutes),
      atMost: (boundMs) => solver.add(imbalance.le(boundMs)),
    },
  ];
}
