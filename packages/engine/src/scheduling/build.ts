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
// No `z3-solver` type import here any more: `Arith`/`Bool`/`Solver` existed
// solely for the deleted `buildTiers` encoder. The two remaining `Solver`
// mentions in this file are prose in comments about the WASM heap, not types.
import { boardMetrics, isStrictlyBetter, type BoardMetrics, type DayView } from "./build-objectives.ts";
import { buildGrid, type BuildGrid, type BuildSlot } from "./build-grid.ts";
import type { BuildConfig } from "./build-encode.ts";
import {
  deltaConflicts,
  effectiveHard,
  isBlockingConflict,
  scopeCoversFixture,
  slotFixtures,
  validateAssignments,
  RULE_BY_REASON,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type ScopeRow,
  type SlotConfig,
  type VerifyConfig,
} from "./calendar.ts";
import type { HardConstraint } from "./constraints.ts";
import { dayKeyInTz } from "./tz.ts";
import { repairUniverse } from "./repair-domain.ts";
// `withZ3LockAndReset` only — `Z3Context` was the deleted encoder's. The lock
// itself is still taken around the placement solve and is vestigial rather
// than dead; see the comment at its call site.
import { withZ3LockAndReset } from "./z3-load.ts";
// `placement-client.ts` is imported dynamically at the call site inside
// `solveBuild`, never statically — see the comment there. This is a
// TYPE-only import: `import type` is erased at compile time, so it creates
// no runtime module binding and does not defeat the dynamic-import mocking
// seam `build.test.ts` relies on (the repo's own recorded trap: `vi.doMock`/
// `vi.spyOn(await import(...))` is inert against a module the file under
// test also imports statically).
import type { SolveBuildInput, SolveBuildOutcome } from "./placement-client.ts";
import { log } from "./logger.ts";

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
/** The tier ladder's names, in order — the SHARED VOCABULARY with the
 *  placement service (`placement/objective.py`'s `TIER_ORDER`) and with
 *  `proto/scheduler.proto`'s `Tier.name` comment. Same strings on both sides;
 *  the DDD ubiquitous-language rule allows the case convention to change at a
 *  language boundary and nothing else, and these need no change at all.
 *
 *  Checked, not merely declared. `tiersCompleted === TIER_COUNT` used to be the
 *  whole optimality predicate, and a COUNT cannot tell one ladder from another:
 *  the two apps deploy separately, so a service running a different ladder of
 *  the same length would have its `tiers_completed` read as a full proof of
 *  THIS one. That is not hypothetical — the ladder went 4 -> 6 on 2026-08-13,
 *  and during that window a service proving four of its six rungs reports
 *  `tiers_completed: 4`, which a caller expecting four rungs reads as a
 *  complete ladder and reports `already_optimal` about a board whose idle gap
 *  and court balance were never optimised. Comparing the NAMES closes the class
 *  for good, whatever the next change to the ladder is.
 *
 *  It cannot close it retroactively: a caller already deployed with the old
 *  four-name list has no such check, so the safe deploy order for THIS change
 *  is still web first, then the placement service. New web against an old
 *  service simply never reaches `TIER_COUNT` — degraded, but honest. */
export const TIER_NAMES = [
  "placed",
  "days",
  "day_span",
  "day_start",
  "idle_gap",
  "imbalance",
] as const;

/** T0 plus the five lexicographic tiers
 *  (`placed → days → day_span → day_start → idle_gap → imbalance`).
 *  `tiersCompleted` reaching this is what "the board is lexicographically
 *  optimal" means.
 *
 *  EXPORTED for the web layer (ruling R17), which was carrying its own
 *  `TIERS_TOTAL = 4`. Two copies of a number that means "the solver proved
 *  every tier" drift the moment a tier is added, and the copy that drifts is
 *  the one deciding what an organiser is told.
 *
 *  4 → 6 on 2026-08-13, and the warning above turned out to be exactly right:
 *  the web layer's copy was STILL a hand-written literal, not this export, so
 *  it had to be found and moved by hand. It now imports this constant. */
export const TIER_COUNT = TIER_NAMES.length;

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

// `RunBudget` (z3's per-run rlimit accounting), `rlimitCount` and `withModel`
// lived here — z3-specific support code for the tier-walk `solveBuild` used
// to run. Removed rather than left as dead code once this task's rewrite of
// `solveBuild` (see below) took their only call sites: ESLint's
// `no-unused-vars` is an error in this package, not a warning, and ORPHANED
// local helpers are not "z3 code" in the sense `_RULES.md`/the task brief
// mean by it — `build-encode.ts`, `z3-load.ts` and `build-lns.ts` (which
// still own the actual solving logic, untouched, for Prompt 10 to remove as
// a unit) are.

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
  /** The WASM would not boot. A fallback, never an exception. z3-era only —
   *  additive, not renamed, since Prompt 10 (not this task) removes z3. */
  | "z3_unavailable"
  /** The placement era's `z3_unavailable`: the service call resolved but not
   *  into a trustworthy board — a transport fault, an unmapped/unreadable
   *  status, or the RPC promise rejecting outright (deadline, unavailable,
   *  a malformed request) all land here. A DIFFERENT identifier rather than
   *  reusing `z3_unavailable`, even though the two mean the same thing to an
   *  organiser and share one i18n key (`board.result.unavailable`):
   *  `z3_unavailable` is invisible to users today per the design doc, but
   *  the NAME is misleading once z3 is gone, and carrying a stale name
   *  forward was judged more expensive than adding one clean value now.
   *
   *  Deliberately NOT what `SOLVER_BUSY` maps to — that is `solver_busy`,
   *  a few members below, because a retry helps there and this copy does
   *  not promise one will. */
  | "solver_unavailable"
  /**
   * THE SOLVER NEVER SEARCHED THIS BOARD, so nothing is claimed about it.
   *
   * The greedy board is returned and it is a perfectly good board; what is
   * missing is any statement about whether a better one exists. FOUR causes, in
   * two families, are catalogued below — written for the pre-placement-cutover
   * z3 tier walk this function used to run, and kept for the shape it still
   * rhymes with. `NotSearchedReason` (a few lines down) is the CURRENT and
   * authoritative map: five members, one per exit `solveBuild` and
   * `buildSchedule` actually have today, including the R22 size gate's own
   * `too_big`, which this paragraph never named. A sixth member,
   * `per_court_grid`, existed here between the placement cutover and task
   * C2 — the configured courts not all sharing a start-time grid was, for
   * that window, a refusal rather than something the solver could express.
   * It is gone now that `placement.model.build_model` enforces each court's
   * own tick set directly; see that module's docstring, "per-court grids".
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

/**
 * WHICH of `not_searched`'s exits produced this board — the fact `status`
 * alone cannot carry, because all of them collapse onto that one member. One
 * member per call site in this file, in the order they appear:
 *
 *   * `too_big` — the R22 size gate (`canSolveWithin`) refused the board
 *     before it ever queued. THE FIRST GATE EVERY CALLER PASSES THROUGH: an
 *     over-cap or empty lattice is refused here too (`canSolveWithin` opens
 *     with the identical `grid.overCap || grid.slots.length === 0` test
 *     `lattice_unusable` names below), so a board that would otherwise reach
 *     that check never does — this member, not that one, is what a caller
 *     actually observes for those boards. `lattice_unusable` stays its own
 *     member anyway: it documents what that second check is FOR, and stops
 *     being shadowed the moment anything ever calls the lower-level solve
 *     path directly.
 *   * `window_empty` — the competition/session window ends at or before this
 *     run's own start.
 *   * `lattice_unusable` — the lattice exceeds `MAX_SLOTS`, or comes back
 *     empty, discovered where `solveBuild` builds its own copy of the grid.
 *   * `out_of_time` — the wall was already spent before the RPC would have
 *     gone out.
 *   * `no_verdict` — the service resolved with `UNKNOWN`: the chain proved
 *     nothing, so nothing here claims a better board exists.
 *
 * `per_court_grid` — the configured courts not all sharing one start-time
 * grid — lived here between the placement cutover and task C2, gating a
 * check (`everyCourtSharesGrid`) that refused the request before it ever
 * reached placement. It is GONE, not merely undocumented:
 * `placement.model.build_model` now enforces each court's own tick set
 * directly (a per-fixture domain restriction, court by court), so a
 * per-court blackout is placed correctly instead of being bounced back to
 * greedy. A server response naming this reason is therefore either from a
 * deploy one release behind this field, or a bug.
 *
 * Optional, and meaningful only when `status === "not_searched"` — absent on
 * every other status, and absent on a `not_searched` from a server one
 * deploy behind this field.
 */
export type NotSearchedReason =
  | "too_big"
  | "window_empty"
  | "lattice_unusable"
  | "out_of_time"
  | "no_verdict";

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
   * `tz` is named here too, for the placement wire's `dayIndex`: `solveBuild`
   * derives it from `dayKeyInTz(slot.startAt, tz)`, the same bucketing the
   * verifier's own day-cap pass uses (#447/#448 — `settings.tz` is DISPLAY,
   * `settings.orgTz` is the governing clock, and the wrong one typechecks).
   * Unlike `hard`/`restByDivision`, `SlotConfig` already declares `tz?:
   * string` on its own (the placer's typed-rule day tallies read it too), so
   * this entry is redundant with what the intersection already exposed —
   * added for documentation of the placement dependency, not because
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
  engine: "greedy" | "z3" | "z3+lns" | "optimized";
  status: BuildStatus;
  /** Set only when `status === "not_searched"` — see `NotSearchedReason`. */
  notSearchedReason?: NotSearchedReason;
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
/**
 * Blocking AT THIS GATE, which is deliberately a WIDER set than
 * `isBlockingConflict`'s — the shared predicate plus `instruction`.
 *
 * WHY THE BUILD GATE NEEDS ITS OWN. `isBlockingConflict` answers "may this be
 * WRITTEN", and it is shared by the apply gate, the drag path and the AI
 * pipeline precisely so those cannot drift into two vocabularies (#399 gap 5).
 * A durable typed rule is correctly warn-only THERE: an organiser must be able
 * to keep editing a board that already breaches one, which is the only way they
 * can ever fix it.
 *
 * This gate asks a different question — "did the SOLVER's board introduce it" —
 * and for that family the answer has to be no, because of an asymmetry the
 * placement service cannot fix from its side:
 *
 *   * The typed rules ARE NOT ON THE WIRE. `constraints` carries `matchMinutes`
 *     and `gapMinutes` and nothing else; `division_rules` (proto field 10) was
 *     retired, and `constraints.startWindows` was never sent. The service
 *     therefore cannot honour a `not_before` — it is not ignoring the rule, it
 *     has never been told about it.
 *   * GREEDY, by contrast, honours it natively: its cursor is
 *     `ready = max(config.startAt, window.notBefore)` (`calendar.ts:759`), so
 *     the seed respects a start window without being asked to.
 *
 * So the two producers are not equally capable here, and leaving `instruction`
 * out of this filter means the only thing standing between an organiser and a
 * board that breaks their own stated rule is `isStrictlyBetter` happening to
 * prefer greedy's — incidental, not a guarantee. Measured 2026-08-13: with the
 * gate changed to trust the solver's proof, a division whose durable rule says
 * nothing may start before noon got six cards at 00:00.
 *
 * THE DELTA STILL PROTECTS THE ORGANISER. `before` is the RAW greedy board, and
 * because greedy respects start windows that board carries no `instruction`
 * rows for a rule it can satisfy — so this refuses what the SOLVER introduced,
 * not what the organiser already had. A rule greedy also cannot satisfy appears
 * on both sides and cancels, which is the correct outcome: refusing there would
 * be a lock-out with no fix, exactly as the `ours` scoping avoids below.
 *
 * NOT widened by editing `isBlockingConflict` itself, deliberately — that would
 * change the apply gate's delta check and every surface sharing the predicate,
 * a blast radius far past what this gate needs.
 */
function isBlockingForBuild(c: Conflict): boolean {
  return isBlockingConflict(c) || c.reason === "instruction";
}

export function rejectedBlockingConflicts(
  before: readonly Conflict[],
  after: readonly Conflict[],
  ours: ReadonlySet<string>,
): Conflict[] {
  return deltaConflicts(before.filter(isBlockingForBuild), after.filter(isBlockingForBuild)).filter(
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
      details: { kind: proved ? "no_slot_lattice" : "no_slot_budget" },
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
      // NOTHING TO HAVE MOVED FROM, so nothing moved — the same rule
      // `lostFrom` states directly below, for the same reason.
      //
      // Greedy's own seed used to stand in as the baseline here, and that was
      // defensible for exactly as long as every no-`current` exit RETURNED that
      // seed: a self-comparison, so zero. The build gate now ships the solver's
      // proved board instead, and against an invented baseline the fallback
      // reports "6 matches moved" on the first run of the day — measured, on
      // `schedule-polish-current`'s own fixture — where those 6 cards moved
      // from a board greedy built during this same run and never showed
      // anybody. That is precisely the meaningless number R20 warns about for
      // anchoring to greedy's re-placement. A fresh full pass does not move
      // cards; it places them.
      if (currentBoard === undefined) return 0;
      const was = new Map(currentBoard.map((a) => [a.fixtureId, a]));
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
  notSearchedReason?: NotSearchedReason,
): BuildResult {
  return {
    assignments: seed.assignments,
    conflicts: seed.conflictsForBoard(seed.assignments, false),
    metrics: seed.metrics,
    engine: "greedy",
    status,
    // Conditional spread, not a bare `notSearchedReason` property: every other
    // caller of this function passes `undefined` for a status that is not
    // `not_searched`, and a literal `notSearchedReason: undefined` on the
    // object is a KEY the caller has to know to strip, not an absent one —
    // `ScheduleSolverInfo`'s own optional fields follow the same rule.
    ...(notSearchedReason !== undefined ? { notSearchedReason } : {}),
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
  notSearchedReason?: NotSearchedReason,
): BuildResult {
  const t0 = performance.now();
  const seed = greedySeed(input);
  return greedyResult(
    seed,
    status,
    {
      budgetExpired,
      elapsedMs: performance.now() - t0,
      rlimitSpent: 0,
      lnsWindowRlimits: [],
    },
    notSearchedReason,
  );
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
  log.info(
    { fixtures: input.fixtures.length, courts: input.config.courts.length },
    "buildSchedule: start",
  );
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
    return Promise.resolve(greedyOnly(input, "not_searched", true, "too_big"));
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
  // STILL HELD FOR THE PLACEMENT PATH TOO (fix round 1 finding, deliberately
  // NOT changed this round — a process-wide lock is a blast-radius change
  // and the one test that would prove dropping it safe needed writing
  // first; see `build-teardown.test.ts`'s "still serialises, and still
  // tears down, when two runs queue together").
  //
  // `solveBuild` no longer touches z3 on this path at all, so `withZ3Lock`
  // buys this call NOTHING correctness-wise: placement is an out-of-process
  // gRPC call, sharing no WASM heap, no `Solver` instance, no mutable
  // process-wide state with anything this lock protects. `tearDownZ3`
  // itself degrades gracefully (`if (loaded === null) return;` — a
  // near-instant no-op whenever z3 was never booted, which on this path is
  // always), so nothing is BROKEN by keeping the wrap — but it is not free
  // either: every placement call still queues behind `MAX_SOLVER_QUEUE` AND
  // behind this lock, needlessly serialising concurrent BUILD/POLISH
  // requests against each other (redundant with the queue cap and the
  // service's own `PLACEMENT_MAX_WORKERS`) and against REFLOW's concurrent z3
  // repairs (`repairSchedule` takes the SAME lock, and shares nothing with
  // placement either).
  //
  // Left in place because removing it is REFLOW's call to weigh in on too
  // (this lock is `z3-load.ts`'s, not BUILD/POLISH's own), and because the
  // throughput cost is unmeasured, not merely asserted — a claim worth
  // benchmarking before acting on, not assuming.
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
 * Dense 0..n-1 over the org-local calendar day of every slot, matching
 * EXACTLY how the verifier buckets a day cap (`dayKeyInTz`, the
 * `max_fixtures_per_day` pass in `calendar.ts`) — any other derivation (a
 * UTC quotient, a midnight offset, a day number off the window start)
 * reopens the placer/verifier fork `hardRestMinutesFor`'s own docstring
 * warns about (#447). `tz` undefined returns a function that always answers
 * 0: the verifier skips day-cap counting entirely without a zone, and
 * `buildRuleGroups` pairs this with leaving `max_fixtures_per_day` unset on
 * every group it emits, so a cap never binds against a fabricated day.
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

/** The `ScopeRow` a MOVABLE fixture would carry once placed — the same
 *  `entrants`/`people`/`poolId`/`divisionId` derivation `assignmentOf` (below,
 *  in `solveBuild`) uses for a real `Assignment`, minus the placement-specific
 *  fields (`court`/`startAt`/`endAt`) a fixture that has not been placed yet
 *  does not have. Exists so `buildRuleGroups` can ask `scopeCoversFixture`
 *  the IDENTICAL question the verifier asks of an already-placed row — same
 *  shape, same fields, before and after placement, which is what keeps this
 *  from becoming a second, drifting definition of "does this rule bind this
 *  fixture" (the placer/verifier fork this subsystem has hit three times —
 *  `hardRestMinutesFor`'s own docstring, #447). */
function scopeRowOf(f: SchedulableFixture): ScopeRow {
  return {
    entrants: [f.home, f.away].filter((e): e is string => e !== undefined),
    people: [...(f.people ?? [])],
    ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
    ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
  };
}

/**
 * C1 (#21) — one `RuleGroup` per `min_rest_minutes`/`max_fixtures_per_day`
 * hard rule, covering EVERY scope (competition, division, pool, entrant,
 * person). A division-scoped rule used to ALSO reach the wire through the
 * now-retired `division_rules` field (proto field 10) via this function's
 * own division-only predecessor, `dayCapsByDivision` — deleted alongside it,
 * since this function was already deriving the identical set from the same
 * `hard` array. Membership is resolved through `scopeCoversFixture` — the SAME
 * function `calendar.ts`'s own typed-rule pass and the verifier both call —
 * so this cannot fork from what a real board is checked against; deriving it
 * a second, independent way is exactly the recurring bug `_RULES.md`'s
 * anti-fork instruction (and #447) both exist to rule out.
 *
 * B5 (#21) APPENDS a second source: one synthetic group per division whose
 * RESOLVED rest (`restByDivision` below — the caller's
 * `restByDivisionForWire`, already the max of the Settings-tab floor and any
 * stored per-division override) is `> 0`. Before this, a division's rest
 * reached the wire only on `constraints.restByDivision`, a field
 * `ruleGroupIndices` cannot name — so a pin could be attributed a
 * `min_rest_minutes` HARD RULE but never the common case, rest configured
 * purely in Settings, which left C6's fold-in inert for exactly the case that
 * matters (measured 2026-08-11: two pinned rows sharing an entrant 30 minutes
 * apart, under a Settings-only 30-minute division rest, cleared `OPTIMAL`
 * where `INFEASIBLE` was owed). Division-keyed the same way
 * `restByDivisionForWire` keys its map — `divisionId ?? ""` — because that map
 * deliberately gives the no-division board an entry under `""`; comparing
 * against a raw, unnormalised `divisionId` here would make a division-less
 * board's rest silently emit no group, the exact shape of the bug being
 * fixed. Entries `=== 0` are skipped: a zero-rest group binds nothing on
 * either side (a pin's rest is a MAX over its groups, and a movable fixture's
 * own rest is resolved elsewhere, untouched by this list), so emitting one
 * would be pure wire weight.
 *
 * ONE GROUP PER RULE (or per division-rest entry), not merged by scope the
 * way the retired `dayCapsByDivision` used to merge same-division caps down
 * to their minimum count: a `RuleGroup` has no identity of its own beyond its
 * ARRAY POSITION
 * (see `SolveBuildInput.ruleGroups`'s own doc comment in
 * `placement-client.ts`), and a pinned row references one by that position
 * via `indicesFor` below. Merging two rules into one group would need
 * inventing a merged identity for no behavioural gain this round — the
 * domain does not read `rule_groups` yet (module docstring, "no model, no
 * behaviour change"). Typed rules keep their existing relative order and
 * come FIRST; every synthetic division-rest group is appended after them, so
 * an index a pin already resolves against a typed rule never moves.
 *
 * `minRestMinutes` is NOT gated on `tz`: it needs no calendar-day concept at
 * all. `maxFixturesPerDay` NOW IS (B5) — `tz === undefined` is exactly the
 * condition under which the verifier's own day-cap pass skips counting
 * without a zone and buckets every slot into dayIndex 0 (`buildDayIndexOf`
 * above), so a cap keyed by that collapsed index would bind against a
 * fabricated day. This
 * paragraph used to read "this task changes no behaviour regardless (nothing
 * downstream reads this field)" — true while C1's MODEL half did not exist,
 * false since C4 taught the placement service to enforce
 * `RuleGroup.max_fixtures_per_day`, bucketed by the caller's `day_index`: with
 * `tz` undefined and this field left ungated, the service would cap the WHOLE
 * BOARD at N as one fabricated day while the verifier enforces no cap at
 * all — a silent over-constraint, not a no-op. The GROUP itself still ships
 * either way (never dropped — see the empty-array comment on
 * `SolveBuildInput.ruleGroups`), just without this one field when `tz` is
 * absent, so array positions stay stable regardless of which branch runs.
 *
 * Fixture references are FIXTURE IDS at this layer, exactly like every other
 * collection `solveBuild` hands `placement-client.ts` — id -> wire-index
 * translation is that module's job alone (`_RULES.md` §2.2), and this
 * function never sees or invents a wire index.
 */
function buildRuleGroups(
  hard: readonly HardConstraint[],
  freeFixtures: readonly SchedulableFixture[],
  /** The resolved, wire-ready division rest map — `restByDivisionForWire` at
   *  the call site, already merged with the Settings-tab floor. `undefined`
   *  and `{}` both mean "no division carries a resolved rest". */
  restByDivision: Record<string, number> | undefined,
  /** `verifyConfig.tz` — the same zone `buildDayIndexOf` reads to decide
   *  whether the day-index lattice is real or collapsed to one bucket,
   *  passed through rather than re-derived so the two gates cannot drift
   *  apart. */
  tz: string | undefined,
): {
  /** In wire order — becomes `SolveBuildInput.ruleGroups` verbatim. */
  groups: NonNullable<SolveBuildInput["ruleGroups"]>;
  /** Which of `groups` (by array position) a pinned/existing row counts
   *  against. Derived from the SAME `sources` list `groups` was built from,
   *  in the SAME order, so position i always means "the i-th entry of
   *  `groups`" on both sides — by construction, not by two loops kept in
   *  sync by hand. */
  indicesFor: (row: ScopeRow) => number[];
} {
  const typedRules = hard.filter((h) => h.type === "min_rest_minutes" || h.type === "max_fixtures_per_day");
  const divisionRestEntries = Object.entries(restByDivision ?? {}).filter(([, minutes]) => minutes > 0);
  const freeRows = freeFixtures.map((f) => ({ id: f.id, row: scopeRowOf(f) }));

  // ONE list, ONE construction — `groups` and `indicesFor` below both walk
  // `sources` via the SAME `coversRow` predicate, so array position cannot
  // mean different things on the two sides (the placer/verifier fork this
  // subsystem has hit repeatedly; see this function's own docstring, #447).
  const sources: (
    | { kind: "typed"; rule: HardConstraint }
    | { kind: "division-rest"; divisionId: string; minRestMinutes: number }
  )[] = [
    ...typedRules.map((rule) => ({ kind: "typed" as const, rule })),
    ...divisionRestEntries.map(([divisionId, minRestMinutes]) => ({
      kind: "division-rest" as const,
      divisionId,
      minRestMinutes,
    })),
  ];

  const coversRow = (source: (typeof sources)[number], row: ScopeRow): boolean =>
    source.kind === "typed"
      ? scopeCoversFixture(source.rule.scope, undefined, row)
      : (row.divisionId ?? "") === source.divisionId;

  return {
    groups: sources.map((source) => ({
      fixtureIds: freeRows.filter(({ row }) => coversRow(source, row)).map(({ id }) => id),
      minRestMinutes:
        source.kind === "division-rest"
          ? source.minRestMinutes
          : source.rule.type === "min_rest_minutes"
            ? source.rule.minutes
            : undefined,
      maxFixturesPerDay:
        source.kind === "typed" && source.rule.type === "max_fixtures_per_day" && tz !== undefined
          ? source.rule.count
          : undefined,
    })),
    indicesFor: (row) => sources.flatMap((source, i) => (coversRow(source, row) ? [i] : [])),
  };
}

async function solveBuild(input: BuildInput): Promise<BuildResult> {
  // `performance.now()`, never `Date.now()` — `scripts/engine-boundary.ts` bans
  // ambient wall-clock reads in engine source, and a monotonic clock is the
  // right one for a duration anyway.
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { fixtures, config } = input;
  const wallMs = input.wallMs ?? DEFAULT_BUILD_WALL_MS;
  /** The outer wall. placement clamps its own wall server-side, so this only
   *  has to stop THIS function from spending anything — setup or a network
   *  round trip — once nothing would be left to search with anyway. */
  const outOfTime = (): boolean => elapsed() >= wallMs;

  // 1. The seed, the legalisation pass that turns it into a floor worth having,
  //    and every derived binding the run needs — all of it in `greedySeed`, so
  //    the queue-cap exit in `buildSchedule` returns the SAME board this
  //    function's early exits do rather than a second construction of it.
  const seed = greedySeed(input);
  const { existing, dependencies, verifyConfig, rawSeed, rawSeedConflicts } = seed;
  const seedMetrics = seed.metrics;
  const { currentBoard, conflictsForBoard, movedFrom, lostFrom } = seed;

  const greedy = (
    status: BuildStatus,
    budgetExpired = false,
    notSearchedReason?: NotSearchedReason,
  ): BuildResult =>
    greedyResult(
      seed,
      status,
      {
        budgetExpired,
        elapsedMs: elapsed(),
        // Neither field means anything on this path: `rlimit` and LNS windows
        // are z3-specific machinery this function no longer has.
        rlimitSpent: 0,
        lnsWindowRlimits: [],
      },
      notSearchedReason,
    );

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
  if (config.startAt >= universe.to) return greedy("not_searched", false, "window_empty");

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
  /** De-duplicated by fixture id — `pins` can name the same fixture TWICE (a
   *  `locked` card also listed in `frozen`). Every consumer below reads
   *  pins through this map rather than the raw array: building
   *  `pinnedAssignments` from the raw array sent that one fixture as two
   *  IDENTICAL rows, and `validateAssignments` correctly reported that as a
   *  self-collision "court" double-booking — a false `infeasible` from the
   *  pin-contradiction check above, caught by a test (`build-polish.test.ts`,
   *  every case using `optimal` + `frozen: ["a", "b"]` on already-`locked`
   *  fixtures). First occurrence wins, which is inert either way: `locked`
   *  sources are listed first in `pins`, and for a fixture that is both,
   *  `publishedSlotOf` already resolves the `frozen` source to the exact
   *  same slot `locked` does, so the two entries never actually disagreed —
   *  only duplicated. */
  const pinById = new Map(pins.map((p) => [p.id, p.at]));
  /** Sorted, from the de-duplicated map — the order is part of what makes
   *  two runs comparable. */
  const pinnedIds = [...pinById.keys()].sort();
  // NO `pinned`/`seedPins` HERE, DELIBERATELY — unlike the z3 path, where
  // they existed to make the SOLVER's own placement variables able to
  // express the incumbent (`seedPinsOf`'s doc: "THE SOLVER MUST NEVER BE
  // UNABLE TO EXPRESS ITS OWN INCUMBENT"). Neither concept has a job here: a
  // pin is never something the service treats as a placement variable (it is an `existing` row,
  // fixed regardless of the grid — see obligation 3 above), and there is no
  // incremental bound-walk left to protect from a vacuous ladder. Bare, this
  // is the SAME shape `canSolveWithin` already uses for the identical reason
  // (`buildGrid({ config, existing })`, no pins) — a coincidence worth
  // trusting, not re-deriving differently.
  //
  // THIS WAS A REAL BUG, caught by a test, not a pre-emptive cleanup: with
  // `seedPins` included, a rest-chained greedy seed that lands off-grid on
  // ONE court (measured: `perEntrantMinRest: 45` stacks all three cards on
  // C1) injects EXTRA slots onto that court alone — a per-court asymmetry in
  // the LATTICE, not merely in the seed — even though the UNDERLYING grid
  // (blackouts, session windows, window) is perfectly uniform and the real
  // service would happily accept it. Placement now enforces each court's own
  // tick set directly (task C2) rather than refusing an asymmetric grid
  // outright, so this would no longer misroute to greedy the way it once
  // did — but it would still send placement a grid that asymmetric for no
  // reason grounded in the org's own data, which is silently the wrong
  // request. Excluding `seedPins` avoids manufacturing that asymmetry at
  // all, on exactly the boards a real solve helps most: rest-constrained
  // multi-court ones.
  const grid = restrictToConfiguredCourts(buildGrid({ config, existing }), config.courts, []);
  // There is no rescue for an over-cap lattice here: `buildGrid` never reads
  // the fixture list at all, so `overCap` is a function of the config and
  // the immovable board alone — nothing this function could retry would
  // shrink it. Rescuing one means shrinking the LATTICE itself (slicing
  // the horizon per window), which is a design change and out of scope
  // (controller ruling, Task 6).
  //
  // `not_searched`, NOT `ok`. There is no lattice, so nothing was looked at,
  // and a strip reading "the quick pass produced this board" is the most it can
  // honestly say — never that the board was produced and accepted by a solver.
  if (grid.overCap || grid.slots.length === 0)
    return greedy("not_searched", false, "lattice_unusable");

  // Obligation 5 (placement cutover) used to live here: refuse a per-court
  // grid before ever calling the service, because it could not be expressed
  // and would otherwise come back mis-scheduled. Task C2 closed that gap in
  // the service itself (`placement.model.build_model` now enforces each
  // court's own tick set directly — see its docstring, "per-court grids"),
  // so a per-court blackout (`Blackout.court?`, ordinary org data, not a
  // synthetic edge case) is placed correctly instead of refused. Nothing
  // replaces this check; there is nothing left for it to catch.

  // The seed, the lattice and the checks above are already behind us; a wall
  // that has already gone must not pay for a network round trip nobody will
  // be allowed to wait for.
  if (outOfTime()) return greedy("not_searched", true, "out_of_time");

  // 3. Placement.
  //
  // Obligation 3: a pin (`locked`, or `frozen` resolved to an anchor above)
  // cannot be expressed to placement as "place this fixture, but only here" —
  // the wire has no per-fixture slot-pin field, only `existing` rows
  // (immovable) and `fixtures` (free to go anywhere the model likes). So
  // every pin is sent as an `existing` row at its own (court, startAt) and
  // DROPPED from `fixtures` — sending it in both is exactly how it silently
  // stops being pinned: the `existing` row lays a fixed blocking interval
  // while the movable fixture stays free, and it comes back placed a SECOND
  // time elsewhere, OPTIMAL, no error (measured 5/5 under the string
  // contract; see the field comment on `SolveBuildInput.existing` in
  // `placement-client.ts`, which the wire being positional now does not change).
  // This is also the documented shape of POLISH: "BUILD with a frozen set
  // already folded into the request's existing/pinned rows."
  const pinnedFixtureIds = new Set(pinById.keys());
  const freeFixtures = fixtures.filter((f) => !pinnedFixtureIds.has(f.id));
  const freeFixtureIds = new Set(freeFixtures.map((f) => f.id));
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
  const matchMs = config.matchMinutes * MS_PER_MIN;

  /** Same field derivation `encodeBuild`'s own `asAssignment` uses, so a
   *  pinned row and a row placement places are built identically. */
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
      // C1 fix-loop round 2 (2026-08-12, Item A). Same "carried through, not
      // dropped" reasoning as poolId/divisionId just above — omitted here,
      // this helper's own OUTPUT (`incumbent`, below) is what
      // `conflictsForBoard`/`validateAssignments` actually re-verify, so a
      // division with 2+ round-robin-kind stages would have its solver-fed
      // `roundNo` correctly stripped by `roundBearingFor` (the wire never
      // sees it) while this SELF-CHECK still compared both stages' original
      // roundNo values as one sequence — collapsing exactly the shape
      // `roundBearingFor`'s own stripping exists to prevent, just one step
      // later, on the encoder/verifier gate rather than the wire.
      ...(f?.stageId !== undefined ? { stageId: f.stageId } : {}),
      // C1 (2026-08-12 round-order design). Same "carried through, not
      // dropped" reasoning as poolId/divisionId — this helper builds BOTH
      // `pinnedAssignments` (below) and `placedAssignments` (the solver's own
      // output, further down), so `movable` cannot be a constant here:
      // `pinnedFixtureIds` is the SAME set that decided whether `fixtureId`
      // went to `fixtures` or `existing` on the wire in the first place, so
      // asking it again here cannot disagree with that split.
      ...(f?.roundNo !== undefined ? { roundNo: f.roundNo } : {}),
      movable: !pinnedFixtureIds.has(fixtureId),
    };
  };
  const pinnedAssignments = [...pinById.entries()].map(([id, at]) => assignmentOf(id, at.court, at.startAt));

  // If the pins ALONE already carry a PAIRWISE blocking conflict — two locked
  // cards on one slot, two pinned people double-booked, a direct order breach
  // between two pins — no amount of placing FREE fixtures can fix it: placement
  // cannot move a pin, only place the rest around it (a pin is sent as a
  // fixed `existing` row, and the wire never cross-checks two `existing` rows
  // against each other — see the comment on `SolveBuildInput.existing`). This
  // is the same fact z3's own feasibility probe rested on ("without a pin the
  // model is satisfiable by inspection"), reproduced locally because there is
  // no live solver handle left to probe once the request is a single RPC
  // rather than a session.
  //
  // PAIRWISE ONLY — `isBlockingConflict` (calendar.ts) is deliberately NOT
  // used here, because it also marks `window` blocking, and `window` is a
  // UNARY fact about one row's own placement against `config.window`, not a
  // contradiction between two pins. A single locked/frozen fixture merely
  // sitting outside the window is an ordinary "dirty board" —
  // `deltaConflicts`/R1 exist precisely to forgive it, the same way greedy's
  // own seed does — and reporting `infeasible` over it here, before placement is
  // even asked, would refuse boards neither greedy nor a real solve has any
  // trouble with. Measured: `build.test.ts`'s "does NOT reject a board over a
  // blocking breach greedy already had" (`a` locked outside a 60-minute
  // window) reproduced exactly this — `isBlockingConflict` alone turned one
  // unremarkable pin into a false `infeasible`, deterministically, with no
  // service involved.
  const isPairwiseBlockingConflict = (c: Conflict): boolean =>
    c.reason === "court" || c.reason === "person_overlap" || (c.reason === "order" && c.direct === true);
  if (pins.length > 0) {
    const pinConflicts = validateAssignments(pinnedAssignments, verifyConfig, existing, dependencies);
    if (pinConflicts.some(isPairwiseBlockingConflict)) {
      return { ...greedy("infeasible"), contradictoryPins: pinnedIds };
    }
  }

  // Obligation 1: `dayIndex` is the org's local calendar day, bucketed
  // EXACTLY the way the verifier buckets a day cap — any other derivation
  // reopens the placer/verifier fork `hardRestMinutesFor`'s own docstring
  // warns about (#447). `tz` undefined means the verifier skips day-cap
  // counting entirely, so every slot gets the SAME index (0) and
  // `buildRuleGroups` (below) leaves `max_fixtures_per_day` unset on every
  // group it emits rather than binding a cap against a fabricated day
  // (#448 — `settings.tz` is DISPLAY, `settings.orgTz` is the governing
  // clock, and the in-scope wrong one typechecks).
  const tz = verifyConfig.tz;
  const dayIndexOf = buildDayIndexOf(grid.slots, tz);
  // The SAME day resolution, handed to `boardMetrics` so the acceptance gate
  // ranks boards on the rungs the solver actually optimises. Built here, from
  // this run's grid, so the placer and the gate cannot disagree about which day
  // an instant is on — and `undefined` when there is no zone, because without
  // one every slot resolves to day 0 and "days used" would be a fabricated 1
  // for every board rather than an honest abstention.
  const days: DayView | undefined =
    tz === undefined
      ? undefined
      : (() => {
          const openByDay = new Map<number, number>();
          for (const s of grid.slots) {
            const d = dayIndexOf(s.startAt);
            const seen = openByDay.get(d);
            if (seen === undefined || s.startAt < seen) openByDay.set(d, s.startAt);
          }
          return {
            dayOf: dayIndexOf,
            // A pin can sit off the lattice, on no day the grid offers; its
            // own start is then the only sane opening for that day, and
            // `boardMetrics` floors the offset at 0 regardless.
            openOf: (d: number) => openByDay.get(d) ?? 0,
          };
        })();
  const hard = effectiveHard(verifyConfig);

  /**
   * `perEntrantMinRest` is a GLOBAL per-entrant rest, and the wire has no
   * dedicated field for it — a division-scoped rest reaches the wire only as
   * a `RuleGroup` (see `buildRuleGroups`, `restByDivisionForWire` below).
   * So it has to be folded into the per-division map, or the solver never hears
   * about it at all.
   *
   * IT DID NOT, AND THAT SHIPPED A WRONG BOARD. Reproduced 2026-08-10 by
   * `schedule-solver-telemetry.test.ts`'s "forwards the pinned set an infeasible
   * proof is about": two cards sharing an entrant, pinned 30 minutes apart under
   * `perEntrantMinRest: 30`. z3 received the rule and proved the board
   * INFEASIBLE, naming the two contradictory pins. The placement service, never
   * sent the rule, saw nothing wrong and returned **`already_optimal`**.
   *
   * `already_optimal` is the damaging status, not a harmless one: an organiser
   * told their schedule is optimal has no reason to look again. And nothing
   * downstream catches it — `isBlockingConflict` (`calendar.ts:202-209`) is
   * court / person_overlap / window / order-with-direct, so a rest violation is
   * WARN-ONLY at the verifier gate and the board is not rejected.
   *
   * MAX, not overwrite: a division rule and the global floor are both real
   * constraints, and the binding one is the larger. Taking the division's value
   * alone would drop the global floor; taking the global alone would drop a
   * stricter divisional rule.
   *
   * Every division ON THIS BOARD gets an entry, including `""` — the id used for
   * a fixture with no division (see `divisionId: f.divisionId ?? ""` below).
   * Without that key a division-less board keeps the rule invisible, which is
   * the exact shape of the bug this fixes.
   *
   * Resolved BEFORE `buildRuleGroups` (B5, #21) and fed into it: a rest that
   * lives only here — the common case, Settings-tab rest with no typed
   * `min_rest_minutes` hard rule at all — used to reach the wire solely on
   * `constraints.restByDivision` (retired alongside `division_rules`, proto
   * field 10), a field `ruleGroupIndices` cannot name, so a pin could never
   * be attributed it. See `buildRuleGroups`'s own docstring.
   */
  const restFloor = config.perEntrantMinRest ?? 0;
  const restByDivisionForWire = ((): Record<string, number> | undefined => {
    const declared = verifyConfig.restByDivision;
    if (restFloor <= 0) return declared;
    const merged: Record<string, number> = { ...(declared ?? {}) };
    for (const f of freeFixtures) {
      const division = f.divisionId ?? "";
      merged[division] = Math.max(merged[division] ?? 0, restFloor);
    }
    return merged;
  })();

  // C1/B5 (#21). Fed BOTH the resolved `restByDivisionForWire` (so a
  // Settings-level division rest becomes a rule group too, not only a typed
  // hard rule) and `tz` (so an emitted `max_fixtures_per_day` group honours
  // the SAME gate the day-index lattice just above does) — see
  // `buildRuleGroups`'s own docstring for why each half is, or isn't, gated.
  const ruleGroupSet = buildRuleGroups(hard, freeFixtures, restByDivisionForWire, tz);

  // C1 (2026-08-12 round-order design). `round` attaches to round-robin-
  // generated fixtures ONLY (design doc) — brackets/stepladder are already
  // ordered by `dependencies` (winner/loser feed edges) and never carry one.
  // This engine has no "stage kind" concept (the caller resolves that; see
  // `apps/web`'s `roundRobinStageIds`), so the one signal available HERE is
  // structural: a genuine round-robin fixture never appears in a dependency
  // edge (there is no "winner advances" relationship inside a round-robin
  // stage). A round-bearing fixture that ALSO appears as a dependency
  // endpoint is therefore contaminated input — mixed round sequences (or a
  // caller bug) leaking a bracket-shaped fixture's round through — and this
  // whole division's rounds are STRIPPED rather than risk a false ordering,
  // per the design doc's "strip + assert" guard. Checked over the FULL
  // `fixtures` list (free and pinned), not `freeFixtures` alone: a pinned
  // bracket fixture carrying both a round and a feed edge is the identical
  // contamination signal.
  const dependencyEndpointIds = new Set(dependencies.flatMap((d) => [d.fixtureId, d.dependsOn]));
  const dependencyContaminated = new Set(
    fixtures
      .filter((f) => f.roundNo !== undefined && dependencyEndpointIds.has(f.id))
      .map((f) => f.divisionId ?? ""),
  );
  if (dependencyContaminated.size > 0) {
    log.warn(
      { divisions: [...dependencyContaminated] },
      "buildSchedule: round-bearing fixture also carries a feed dependency — stripping round for its division rather than emit a false order",
    );
  }
  // SECOND contamination source, found during implementation: a `kind:
  // "group"` stage with N pools runs N INDEPENDENT round-robin sequences,
  // each restarting at round 1 (`stages.ts`'s `generate()` calls
  // `roundRobinGen` once per pool) — Pool A's round 2 and Pool B's round 2
  // are not comparable, the same way two stages' rounds are not. The wire
  // has no pool index at all (`Fixture` carries `division_index` only), so
  // — unlike the TS verifier, which CAN scope by `(divisionId, stageId,
  // poolId)` because `Assignment.poolId`/`stageId` exist (see `calendar.ts`'s
  // own comment) — this engine cannot forward a pool- or stage-scoped round
  // to the solver and must instead strip: a division whose round-bearing
  // free fixtures span more than one distinct (stage, pool) pair is
  // contaminated the same way a dependency-edge hit is.
  //
  // C1 fix-loop (Finding 2): the key used to be `poolId` alone, which missed
  // the sibling case — a division carrying TWO round-robin-kind stages
  // (two `league` stages, or a `league` beside an unpooled `group`), NEITHER
  // of which has a pool. Both then read `poolId: undefined`, one bucket, no
  // trip — the exact shape `stages.ts`'s `stages.per_division.max` (capped
  // 2/4/∞, no kind-uniqueness check) permits today. `stageId` joins the key
  // for the same reason it joined `calendar.ts`'s: it is the one dimension
  // that still separated two stages sharing no pool.
  const roundBearingPoolsByDivision = new Map<string, Set<string>>();
  for (const f of freeFixtures) {
    if (f.roundNo === undefined) continue;
    const division = f.divisionId ?? "";
    const pools = roundBearingPoolsByDivision.get(division) ?? new Set<string>();
    pools.add(`${f.stageId ?? ""}|${f.poolId ?? ""}`);
    roundBearingPoolsByDivision.set(division, pools);
  }
  const multiPoolContaminated = new Set(
    [...roundBearingPoolsByDivision.entries()].filter(([, pools]) => pools.size > 1).map(([d]) => d),
  );
  if (multiPoolContaminated.size > 0) {
    log.warn(
      { divisions: [...multiPoolContaminated] },
      "buildSchedule: round-bearing fixtures span more than one pool or round-robin stage in the same division — stripping round for its division rather than compare two independent round-robin sequences",
    );
  }
  const contaminatedDivisions = new Set([...dependencyContaminated, ...multiPoolContaminated]);
  const roundBearingFor = (f: SchedulableFixture): number | undefined =>
    f.roundNo !== undefined && !contaminatedDivisions.has(f.divisionId ?? "") ? f.roundNo : undefined;

  // `PinnedRow` carries no division index on the wire (its own proto comment
  // explains why), so the SOLVER cannot scope a pin-movable round pair by
  // division the way it scopes movable-movable pairs (`Fixture.
  // division_index`). A pin's round is therefore only forwarded when there
  // is AT MOST ONE round-bearing SEQUENCE among THIS run's own movable
  // fixtures — the one case this function can itself guarantee is
  // unambiguous. A multi-round-robin-division call (the joint-apply shape)
  // simply never attaches a pin's round; movable-movable pairs are
  // unaffected, since those stay scoped by the wire's own division_index.
  //
  // C1 fix-loop round 2 (2026-08-12, Item B): "sequence" is (divisionId,
  // stageId, poolId), NOT divisionId alone — the pin-path sibling of the
  // multi-pool/multi-stage contamination guard just above. A division can
  // carry a clean, all-movable round-robin stage AND a second, entirely
  // PINNED round-robin stage (or pool) at once — `multiPoolContaminated`
  // never sees the second one, because contamination there is scored over
  // `freeFixtures` (movable only) and every fixture in the pinned stage is,
  // by construction, not free. Checking divisionId alone let a pin from
  // that second stage/pool have ITS round forwarded and compared against
  // the first stage's movable rounds as if they were one sequence — the
  // pin-path version of the bug `multiPoolContaminated`/`stageId` already
  // fixed on the movable-movable path.
  const roundBearingSequenceOf = (f: { divisionId?: string; stageId?: string; poolId?: string }): string =>
    `${f.divisionId ?? ""}|${f.stageId ?? ""}|${f.poolId ?? ""}`;
  const roundBearingSequences = new Set(
    freeFixtures.flatMap((f) => (roundBearingFor(f) !== undefined ? [roundBearingSequenceOf(f)] : [])),
  );
  const singleRoundRobinSequence =
    roundBearingSequences.size === 1 ? [...roundBearingSequences][0] : undefined;

  const placementInput: SolveBuildInput = {
    courts: config.courts,
    fixtures: freeFixtures.map((f) => ({
      fixtureId: f.id,
      entrantIds: [f.home, f.away].filter((e): e is string => e !== undefined),
      divisionId: f.divisionId ?? "",
      roundNo: roundBearingFor(f),
    })),
    grid: {
      slots: grid.slots.map((s) => ({
        court: s.court,
        startAtMs: s.startAt,
        dayIndex: dayIndexOf(s.startAt),
      })),
      stepMinutes: grid.stepMinutes,
    },
    // `build.ts` holds a pinned row as a full fixture — `existing` (other
    // divisions' cards, obstacles) is already `Assignment[]`, and
    // `pinnedAssignments` (this run's own locked/frozen cards) is built
    // through the SAME `assignmentOf` helper above — so entrants/pool/
    // division are already in hand for both halves, and identity is only
    // stripped once, here, at the wire boundary. Concatenated before mapping
    // (rather than two separate `.map`s, as before #21) because both halves
    // now produce the identical shape.
    //
    // `ruleGroupIndices` (C4) is resolved through `ruleGroupSet.indicesFor`,
    // which asks `scopeCoversFixture` the SAME question `buildRuleGroups`
    // asked of every FREE fixture above — an `Assignment` already satisfies
    // `ScopeRow` structurally, so no conversion is needed. `entrantIds` (C6)
    // is `a.entrants` verbatim: exactly what closes #447's "two pinned rows
    // sharing an entrant are invisible to each other" gap, once the C1 model
    // half reads it.
    existing: [...existing, ...pinnedAssignments].map((a) => ({
      fixtureId: a.fixtureId,
      court: a.court,
      startAtMs: a.startAt,
      entrantIds: a.entrants,
      ruleGroupIndices: ruleGroupSet.indicesFor(a),
      // C1 (2026-08-12 round-order design). See `singleRoundRobinSequence`'s
      // own comment above for why a pin's round is only ever forwarded in
      // the one-round-robin-sequence case: `PinnedRow` has nowhere on the
      // wire to carry a division (let alone a stage or pool), so this is the
      // only condition under which the model comparing this pin's round
      // against every OTHER round-bearing movable fixture is still
      // guaranteed correct — the pin's OWN (division, stage, pool) must
      // match the single clean sequence, not merely its division (C1
      // fix-loop round 2, Item B).
      roundNo:
        a.roundNo !== undefined &&
        singleRoundRobinSequence !== undefined &&
        roundBearingSequenceOf(a) === singleRoundRobinSequence &&
        !contaminatedDivisions.has(a.divisionId ?? "")
          ? a.roundNo
          : undefined,
    })),
    // Filtered to pairs where BOTH ends are fixtures placement is actually being
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
    // C1 (#21). See `buildRuleGroups` — every `min_rest_minutes`/
    // `max_fixtures_per_day` rule, every scope. The only wire representation
    // of a division-scoped rest/cap rule now: `division_rules` (proto field
    // 10) carried the division-only predecessor and was retired once this
    // field became authoritative in production (2026-08-12).
    ruleGroups: ruleGroupSet.groups,
    constraints: {
      matchMinutes: config.matchMinutes,
      gapMinutes: config.gapMinutes,
    },
    wallSeconds: Math.max(1, Math.round((wallMs - elapsed()) / 1000)),
  };

  // Loaded dynamically, never `import { solveBuild } from "./placement-client.ts"`
  // at the top of this file: this repo has a recorded trap where a mock
  // against a module the file under test also imports statically is INERT,
  // and it has previously passed 5/5 with the guard deleted. `build.test.ts`
  // mocks this exact call via `vi.spyOn(await import("./placement-client.ts"),
  // "solveBuild")`, which only observes what THIS line does if this line
  // resolves the same module namespace object dynamically too — mirroring
  // how `z3-load.ts` defers its own WASM import to inside `loadZ3`, one call
  // site removed from this file. See the (type-only) import of
  // `SolveBuildInput`/`SolveBuildOutcome` above for the rest of the reasoning.
  // `requestId` is caller-supplied by design (`_RULES.md` §2.3): the client
  // defaults it to empty rather than generating one itself, specifically
  // because `packages/engine/src` may not read ambient time or randomness —
  // `t0` (`performance.now()`, already read at the top of this function for
  // `elapsed()`) is the one already-in-scope value with any entropy at all,
  // so the correlator is built from it plus the shape of the request, never
  // from a NEW `Date.now()`/`Math.random()` call. Not globally unique (two
  // calls can share a monotonic-clock tick under the low-resolution timers
  // some sandboxes use) — it only has to help a human match a service log
  // line back to roughly this call, which an always-empty string cannot do
  // at all.
  const requestId = `build-${fixtures.length}f${config.courts.length}c-${Math.trunc(t0)}`;
  let outcome: SolveBuildOutcome;
  try {
    const placementClient = await import("./placement-client.ts");
    outcome = await placementClient.solveBuild(placementInput, {
      secret: process.env.PLACEMENT_SERVICE_SECRET ?? "",
      requestId,
    });
  } catch (err) {
    // Any rejection — deadline, unavailable, transport, invalid_request
    // (`PlacementError["failure"]`, `placement-client.ts`'s `failureFor`), an
    // unclassified bug thrown as a plain `Error`, or unauthenticated (the
    // shared secret rejected — an OPERATOR misconfiguration, and the
    // single most likely first-deploy failure per `DEPLOY.md`: it presents
    // as "placement is slow", not as an auth error) — ALL of it falls back to
    // greedy as `solver_unavailable`, uniformly, by the same test the
    // `ERROR`-status default arm below already applies: none of these
    // promise a retry will help. `invalid_request` is the sharpest case for
    // that — retrying an IDENTICAL malformed request fails identically
    // every time — which is why it is not `solver_busy`: that status is
    // true of exactly one cause (`SOLVER_BUSY`, handled below) and would be
    // a worse lie here than for a genuine outage. No `.failure` switch is
    // needed because every kind lands in the same place; a caller that
    // needs the specific reason still has it on the rejected error's
    // `.failure`/`.message`, this function only decides the fallback board.
    // Curated fields, not the raw `err`: `failure` (when present — a
    // `PlacementError`, duck-typed rather than imported, matching this file's
    // no-static-coupling-to-placement-client convention above) and `message`
    // only, same idiom `placement-client.ts`'s own log sites use.
    const failure = err && typeof err === "object" && "failure" in err ? err.failure : undefined;
    log.warn(
      { failure, message: err instanceof Error ? err.message : String(err) },
      "buildSchedule: placement service unavailable, falling back to greedy",
    );
    return greedy("solver_unavailable", true);
  }

  // `ERROR` is a RESOLVED outcome, not a rejection, but it carries the same
  // instruction: an unmapped or unreadable status is a board this function
  // has no reason to trust (see `placement-client.ts`'s comment on
  // `STATUS_BY_WIRE_VALUE`), so it falls back to greedy exactly as a
  // rejection does. WHICH status name it falls back to is not uniform,
  // though (Task 06b, Correction 2): `SOLVER_BUSY` is the service's own
  // admission control refusing a concurrent solve (`schema.py`'s
  // `error_response("SOLVER_BUSY", ...)`, called from `main.py`), and Task
  // 08 pinned `PLACEMENT_MAX_WORKERS=1` in `fly.toml` specifically to hold
  // worst-case thread contention down — which makes two organisers clicking
  // Auto-schedule at once an ORDINARY-traffic path into this, not a rare
  // fault. A retry helps there (the other solve finishes in seconds), so it
  // reports the EXISTING `solver_busy` (`statusKey()` already handles it,
  // and its copy already promises a retry), never the new
  // `solver_unavailable` — whose copy does not promise a retry will help,
  // and would be a worse lie than "busy" for a transient queue refusal.
  // Every other `ERROR` (a transport fault, an unmapped status the service
  // itself could not name) genuinely offers no such promise.
  if (outcome.status === "ERROR") {
    return greedy(outcome.error?.code === "SOLVER_BUSY" ? "solver_busy" : "solver_unavailable", true);
  }

  // `UNKNOWN`: the chain proved nothing, closest in meaning to "don't claim
  // anything" — the same reading z3's own `unknown` got. Not folded into the
  // `!improved` derivation below with OPTIMAL/FEASIBLE: `objective.py`'s
  // `_chain_status` (the service's own status derivation) returns a raw
  // solver-status name — UNKNOWN among them — ONLY on its `if not
  // assignments` path, since a mapped OPTIMAL/FEASIBLE status is returned
  // whenever there IS a board. So `outcome.assignments` is always empty
  // here and `tiersCompleted` is always 0 (every tier that increments it
  // also extracts a non-empty board first) — meaning this outcome could
  // never legitimately reach `already_optimal` either, and would otherwise
  // silently fall through the `!improved` branch below as `"ok"` (0 !==
  // `TIER_COUNT`), the exact invented verdict `not_searched` exists to
  // refuse. `outcome.wallExhausted` carries whether the run actually spent
  // its budget getting here rather than bailing instantly.
  if (outcome.status === "UNKNOWN")
    return greedy("not_searched", outcome.wallExhausted, "no_verdict");

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
  const incumbentMetrics = boardMetrics(incumbent, config.courts, fixtures.length, days);
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
  //    is handed, and a placement board comes back through the exact same call
  //    z3's did.
  const conflicts = conflictsForBoard(incumbent, proved);
  const ours = new Set(incumbent.map((a) => a.fixtureId));
  const rejected = rejectedBlockingConflicts(rawSeedConflicts, conflicts, ours);
  if (rejected.length > 0) {
    // Structured error log, not a fallback-and-forget: the caller is handed a
    // VALID board and a status field they may never read, so an
    // encoder/verifier fork would otherwise reach nobody until an organiser
    // filed a ticket about it.
    log.error(
      { rejected: rejected.map((c) => `${c.fixtureId}:${c.reason}`) },
      "buildSchedule: verifier rejected the placement solver's board — falling back to the greedy seed",
    );
    return { ...greedy("verifier_rejected", budgetExpired), tiersCompleted };
  }

  // D6 — "never worse than greedy" — enforced explicitly, because the
  // structure that gave z3 this property for free is gone. z3's own
  // `incumbent` started as `seedAssignments` and was replaced ONLY inside an
  // `if (isStrictlyBetter(...))` arm (the T0/tier walks above, before this
  // task), so a regression was not reachable BY CONSTRUCTION — there was
  // never a code path that could hand back something worse. placement returns
  // one finished board over a single RPC; nothing upstream of this line
  // compared it to anything, so `outcome.assignments` must be treated as a
  // CANDIDATE, not a foregone incumbent. A starved or merely-suboptimal
  // FEASIBLE/UNKNOWN reply — fewer placed, or a worse makespan/idle
  // gap/imbalance than the seed — must not ship just because it passed the
  // verifier gate above: the gate only proves the board is LEGAL, not that
  // it is any good.
  //
  // A DELIBERATELY SIMPLER status derivation than z3's, in both branches
  // below. The z3 path also asked whether the tier ladder was proved over a
  // NON-EMPTY region (`seedOffLattice`/`latticeHoldsIncumbent`) before
  // claiming `already_optimal` — that nuance has no placement equivalent here
  // (there is no live solver handle left to ask a follow-up `check()` of
  // once the RPC has returned) and is left to Task 06b's status-mapping work
  // (`_RULES.md` §4).
  // Whether the reply proved OUR ladder — names, not just a count. See
  // `TIER_NAMES`: two separately deployed apps cannot agree on a ladder by
  // counting rungs, and `objective_values` is sliced to `[:tiers_completed]`
  // service side, so a fully proved chain carries exactly these names in
  // order. Read twice below: it decides whether the solver's proof is
  // authoritative for THIS caller, and whether `already_optimal` may be said.
  const provedOurLadder =
    tiersCompleted === TIER_COUNT &&
    outcome.objectiveValues.length === TIER_COUNT &&
    TIER_NAMES.every((name, i) => outcome.objectiveValues[i]?.name === name);

  // D6 — "never worse than greedy". The history below is kept because it is the
  // reasoning that has to survive: four measured variants died here, and the
  // shape of the answer is not guessable from the code alone.
  //
  // The obvious move is to mirror the solver's new ladder here, because a gate
  // ranking on terms the placer no longer optimises can discard a board the
  // placer proved optimal. That was a real defect and it is CLOSED below — see
  // the C2 follow-up notes in `docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md`.
  // What is NOT the fix is mirroring the ladder into this comparison. The two
  // boards are not both products of it: the seed is greedy's, and greedy is
  // RULE-BLIND. It packs from the first admissible tick, which scores
  // beautifully on `days`/`day_span`/`day_start` precisely BECAUSE it ignores
  // the typed rules that push a lawful board later. Measured, four separate
  // ways over a full DB-backed run: ranking the day terms here made the gate
  // prefer greedy's 09:00 board on a division whose durable rule says nothing
  // may start before noon, and drove `assertNoNewBlocking` failures across the
  // locks suites. Every variant traded one failure class for another.
  //
  // ------------------------------------------------------------------
  // THE GATE REWORK (2026-08-13). All of the above still holds: ranking these
  // two boards against each other is the wrong question, in BOTH directions.
  // Ranking the day terms rewards greedy for being rule-blind. Ranking
  // `makespan` — what `isStrictlyBetter` does — is the mirror error: the placer
  // stopped optimising that term when the ladder went day-aware, so a board the
  // service PROVED optimal loses on a number nobody was solving for. Measured
  // on `schedule-polish-current`'s own fixture: the solver returns
  // `dayStartOffsetMinutes: 0` against greedy's 540 and ties every other rung,
  // and the old comparison discarded it because both boards span 150 minutes.
  //
  // What was missing before #564 was a way to REFUSE a proved board that breaks
  // a durable rule. `isBlockingForBuild` is now that refusal, and it runs at
  // step 7 above — so a board that reaches this line has already been checked
  // against the typed rules the service is never told about. Trusting the proof
  // here is safe only BECAUSE that guard runs first; the two ship together.
  //
  // So: the service is the authority on its own objective, and when it proves
  // OUR ladder (`provedOurLadder` — names in order, not a bare count) there is
  // nothing left for a comparator to decide. When it proves nothing — a starved
  // reply, or a chain that proved a DIFFERENT ladder — `isStrictlyBetter` is
  // still the only evidence there is, and D6 keeps it.
  //
  // TRUSTING THE PROOF NEEDS A TIE RULE, and the tie is a question about the
  // LADDER, not about the boards. Equality on all six rungs is the solver's own
  // statement that it found nothing to gain: greedy's board is optimal too, and
  // the two are interchangeable by every measure the service was optimising.
  // Shipping the candidate anyway is pure churn — measured on
  // `schedule-solver-telemetry`'s one-fixture board, where the reply is a bare
  // COURT SWAP (`a@C2` for `a@C1`, same instant) with all six rungs and
  // `makespan` byte-identical. An organiser would see every card jump courts on
  // a board nothing improved, and `already_optimal` would lose its only name.
  //
  // NOT THE REJECTED MIRROR. That variant ranked the day terms and so could
  // PREFER a board for scoring better on one — which rewards greedy for being
  // rule-blind, and is why it was reverted. This asks only whether the two
  // boards are indistinguishable on the ladder, an equality, never an ordering;
  // it can decline to churn, and can never pick a winner.
  //
  // MEASURED WITH ONE INSTRUMENT, not two. `seed.metrics` is built by
  // `greedySeed` with NO `DayView`, and `boardMetrics` documents what that
  // means: no view is ONE DAY, so its `daysUsed` is 1 and its `daySpanMinutes`
  // is the whole-board span. Comparing those against `incumbentMetrics`, which
  // was measured against the real grid, is the placer/verifier fork this file
  // keeps paying for. Re-measure the seed with the same `days` view, and
  // compare like with like. (`seedMetrics` stays valid for `isStrictlyBetter`
  // below — all four terms it ranks are day-independent.)
  const seedLadderMetrics = boardMetrics(seed.assignments, config.courts, fixtures.length, days);
  const ladderTied =
    incumbentMetrics.placed === seedLadderMetrics.placed &&
    incumbentMetrics.daysUsed === seedLadderMetrics.daysUsed &&
    incumbentMetrics.daySpanMinutes === seedLadderMetrics.daySpanMinutes &&
    incumbentMetrics.dayStartOffsetMinutes === seedLadderMetrics.dayStartOffsetMinutes &&
    incumbentMetrics.worstIdleGapMinutes === seedLadderMetrics.worstIdleGapMinutes &&
    incumbentMetrics.courtImbalanceMinutes === seedLadderMetrics.courtImbalanceMinutes;

  const improved =
    // D6's floor first, in every arm: a board that places FEWER fixtures is
    // worse whatever else it proved, and no proof outranks that.
    incumbentMetrics.placed !== seedLadderMetrics.placed
      ? incumbentMetrics.placed > seedLadderMetrics.placed
      : provedOurLadder
        ? !ladderTied
        : isStrictlyBetter(incumbentMetrics, seedMetrics);
  if (!improved) {
    // `already_optimal`/`infeasible` are ONLY reachable here — both describe a
    // run that ships the SEED, so neither can be said in the `improved` arm
    // below: a proved ladder that also beat the seed is `ok`, and calling it
    // `already_optimal` would deny the very improvement this branch ships.
    //
    // DERIVED FROM THE PROOF AND THE BOARDS, NOT FROM `!improved`. Those two
    // used to coincide and no longer do, which is why this is written out
    // rather than inherited. `already_optimal` means "a board nothing beat",
    // and that is now exactly `provedOurLadder && ladderTied`: the service
    // proved our ladder and could not separate its own answer from the board
    // greedy already had.
    // Keying it off `!improved` instead would also catch the D6 floor case — a
    // proved reply that placed FEWER than the seed — and call a board the seed
    // BEAT "already optimal", which is the opposite of what the word says.
    const status: BuildStatus = provedOurLadder
      ? incumbentMetrics.placed === 0 && fixtures.length > 0
        ? "infeasible"
        : ladderTied
          ? "already_optimal"
          : "ok"
      : "ok";
    // The floor, not the candidate. `greedy()` recomputes conflicts/moved/
    // lost off `seed.assignments` itself — the SAME derivation every other
    // fallback exit in this function already uses — so this is not a second
    // "what does a returned board look like" implementation, only a second
    // call into the first one. `engine: "greedy"` here matches z3's own
    // exact precedent: `incumbent === seedAssignments` always reported
    // `"greedy"` there too, `already_optimal` included — the field names
    // where the BOARD came from, not which solver was consulted.
    return { ...greedy(status, budgetExpired), tiersCompleted };
  }

  const moved = movedFrom(incumbent);
  const lost = lostFrom(incumbent);

  return {
    assignments: incumbent,
    conflicts,
    metrics: incumbentMetrics,
    engine: "optimized",
    // Reachable only by having just beaten the seed — see the comment above.
    status: "ok",
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
 * TEST-ONLY alias for `solveBuild`. NOT for production use: calling it
 * directly skips both guards `buildSchedule` puts in front of it — the
 * `MAX_SOLVER_QUEUE` cap and the R22 size gate (`canSolveWithin`) — which
 * exist to protect z3's WASM heap and the request budget.
 *
 * It exists because `canSolveWithin` opens with the IDENTICAL
 * `grid.overCap || grid.slots.length === 0` test `solveBuild`'s own
 * `lattice_unusable` exit makes (same `config`, same `existing`, same pure
 * `buildGrid`), and runs first on every call `buildSchedule` admits. So
 * whenever that test would be true here, `canSolveWithin` has ALREADY
 * returned `false` and reported `too_big` — this function's matching branch
 * cannot fire from any input reachable through `buildSchedule` (see
 * `NotSearchedReason`'s doc comment, and the pair of tests in
 * `build-rest-lattice.test.ts` that pins both halves: `too_big` through
 * `buildSchedule` for a real over-cap board, `lattice_unusable` here).
 */
export const solveBuildForTests = solveBuild;

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

// --- the z3 lexicographic tier encoder USED TO LIVE HERE ---------------
//
// `Tier`, `TierInput` and `buildTiers` were removed 2026-08-10. They were
// z3's tier encoder for BUILD, replaced by the placement service, and by the
// time they were deleted they had ZERO callers anywhere in packages/engine,
// apps/web or scripts — dead code the cutover orphaned rather than code kept
// as a fallback.
//
// They were found by the engine COVERAGE gate, not by review: ~230 uncovered
// lines were on their own enough to drag the global line coverage under its
// 90% threshold (89.76% with them, above it without).
//
// This is NOT Prompt 10. That task removes z3 as a CAPABILITY — the WASM
// loader, the fallback path, repair/REFLOW's own z3 — and stays gated on
// C1/C2/C4. Deleting an uncalled function removes no capability, because
// nothing could reach it: `build.ts` already routes BUILD entirely through
// `solveBuild`, and the `withZ3LockAndReset` wrapper around it is vestigial
// (see the comment at that call site). Anything Prompt 10 needs from this
// code is in git history.
