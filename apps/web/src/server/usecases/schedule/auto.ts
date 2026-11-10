import "server-only";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { playedFixtureIds } from "../fixture-results-sql";
import { rateLimit } from "@/lib/rate-limit";
import {
  dayKeyInTz,
  TIER_COUNT,
  validateInstructionRules,
  type Assignment,
  type BuildResult,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { placementSolver, schedulerLog } from "@seazn/scheduler";
import type { AuthCtx } from "@/server/api-v1/auth";
import type {
  AutoScheduleRequest,
  ScheduleConflict,
  ScheduleMetrics,
  ScheduleSolverInfo,
} from "@/server/api-v1/schemas";
import { capacityInputForFixtures, guardCapacity } from "../capacity-guard";
import {
  candidateCourtsByFixture,
  guardNoMatchingCourt,
  guardNoMatchingCourtPerFixture,
  requiredCourtTagsByFixture,
  resolveCandidateCourts,
  resolveCourtCalendars,
  strandedCourtIdsForDivision,
  guardNoUsableCourtWindows,
  unionRequiredCourtTags,
} from "../court-candidates";
import { autoBuildSchedule } from "../schedule-solver-rest";
import { ms, iso, roundToMinute } from "./helpers";
import {
  isMovable,
  divisionLockState,
  divisionFixtures,
  courtNamesById,
  peopleByEntrant,
  peopleOf,
  lockedFixtureIds,
} from "./board";
import { loadSettings } from "./settings";
import { roundRobinStageIds, roundFieldsOf } from "./rounds";
import {
  toAssignment,
  feedDependencies,
  siblingAssignments,
  toVerifyConfig,
} from "./engine-inputs";
import { mapConflicts } from "./conflicts";
import {
  autoSolverWallMs,
  autoScheduleCooldown,
  boundSolverWindow,
  withDefaultDaySpread,
} from "./solver-tuning";
import { type ReflowResult, reflowExisting } from "./reflow";

// ---------------------------------------------------------------------------
// Auto pass (propose only — doc 12 §4: nothing persisted)
// ---------------------------------------------------------------------------

/**
 * The lexicographic improvement targets `buildSchedule` walks: T0's placement
 * count, then days used, per-day span, per-day start offset, idle gap, court
 * balance.
 *
 * RE-EXPORTS the engine's `TIER_COUNT` rather than restating it. It used to be
 * a hand-written `4` with a comment claiming it "MIRRORS `TIER_COUNT` ...
 * which is module-private there" — and that comment was already wrong when it
 * was written: `build.ts` exports the constant precisely so this layer does not
 * need a copy (its own comment records the ruling, R17). The copy survived
 * anyway and had to be corrected by hand when the ladder went from four rungs
 * to six on 2026-08-13, which is the drift the export existed to prevent.
 *
 * Not free-floating either way: `buildSchedule` returns
 * `status: "already_optimal"` only when `tiersCompleted` reached the ladder's
 * length, so a run that comes back `already_optimal` states the engine's number
 * out loud. `__tests__/schedule-solver-telemetry.test.ts` drives exactly that
 * run and compares, so a ladder that grows or shrinks in the engine reds there
 * rather than shipping a wrong denominator to the board.
 */
export const TIERS_TOTAL = TIER_COUNT;

export interface AutoScheduleOut {
  assignments: {
    fixture_id: string;
    scheduled_at: string;
    ends_at: string;
    court_id: string;
    /** DERIVED, read-only (P9 pass 3a) — see `ScheduleAssignment` in schemas.ts. */
    court_name: string | null;
  }[];
  conflicts: ScheduleConflict[];
  /** Board quality of the proposal (Task 8's wire shape, filled here). */
  metrics: ScheduleMetrics;
  /** How the proposal was produced — telemetry, not policy. */
  solver: ScheduleSolverInfo;
}

/**
 * Everything the solve needs, read under one transaction and carried out of it.
 *
 * The split this type exists for is not tidiness. See `autoSchedule`.
 */
interface AutoSchedulePlan {
  schedulable: SchedulableFixture[];
  config: SlotConfig & VerifyConfig & { courts: string[] };
  board: Assignment[];
  /** D2 capacity guard inputs — carried out of the transaction alongside
   *  everything else `capacityInputForFixtures` needs, so phase 2 does not
   *  have to re-open a connection to ask for them. */
  divisionId: string;
  orgTz: string;
  /** The ORGANISER-DECLARED config (`declaredConfig`) — neither
   *  `boundSolverWindow`'s synthetic window-fill nor
   *  `withDefaultDaySpread`'s synthetic cap. See the guard call site's
   *  comment for why this is deliberately NOT the same object as `config`. */
  capacityConfig: SlotConfig & VerifyConfig & { courts: string[] };
  /** P9 pass 2b: the union of tags that produced `capacityConfig.courts` —
   *  division ∪ stage (`unionRequiredCourtTags`). Carried out of the
   *  transaction purely for the phase-2 `guardNoMatchingCourt` error
   *  payload; nothing else reads it. */
  requiredCourtTags: string[];
  /** P9 pass 3a: id -> name, resolved once in phase 1 (the only phase with
   *  a db connection) and carried out for phase 3's wire mapping
   *  (`court_name` on each proposed assignment, and any conflict whose
   *  `details.court` needs one). */
  courtNames: Map<string, string>;
  /**
   * The direct winner/loser feed edges of the whole division (#452).
   *
   * NOT OPTIONAL DECORATION, and the reason it is on the plan rather than
   * rebuilt at each use is that all three consumers must read the SAME list.
   * `slotFixtures` — the pass this wave replaced — walked fixtures in ascending
   * round order, so a dependent could not physically land before its feeder and
   * nothing had to be told about the edges. `buildSchedule` and `repairSchedule`
   * place by search and have no such structural guarantee: both take
   * `dependencies`, both encode it as a hard term, and `validateAssignments`
   * reports `order` only for the edges it is handed.
   *
   * With the list absent all three went blind at once, and the two holes lined
   * up into a wrong board rather than a missing warning: given a
   * `feeder_to_dependent` rest rule the repair solver "satisfied" it by moving
   * the final BEFORE its own semi-finals (measured: feeder end 09:30, final
   * start 08:30), `validateInstructionRules` skips a dependent placed before its
   * feeder on purpose, `order` had no edges to check — and the pass reported
   * `conflicts: []` on a board `applySchedule`, which has always passed
   * `feedDependencies(all)`, then answered with a blocking 409.
   */
  dependencies: OrderDependency[];
  placedNow: Assignment[];
  pinnedNow: Assignment[];
  frozen: string[];
  total: number;
}

/**
 * The auto pass: propose only, nothing persisted (doc 12 §4).
 *
 * THREE PHASES, AND THE BOUNDARIES ARE LOAD-BEARING.
 *
 *   1. READ, under one transaction, into an `AutoSchedulePlan`.
 *   2. SOLVE, with NO transaction open and no pooled connection held.
 *   3. MAP, pure.
 *
 * Phase 2 must not run inside phase 1's transaction, and this is a hard rule
 * rather than a preference. `withTenant` pins a pooled connection for the whole
 * callback, and the solve is now up to `AUTO_SOLVER_WALL_MS` spent on a remote
 * call to the placement CP-SAT service (BUILD/POLISH directly, REFLOW through
 * `reflowExisting` — since C4, 2026-08-14, none of the three modes calls z3 for
 * scheduling any more; that gRPC round trip has its own queueing on the service
 * side, `solver_busy`/`solver_unavailable` when it is saturated or unreachable)
 * — so a solve inside the transaction is tens of seconds of idle-in-transaction
 * per organiser click, and a handful of concurrent clicks exhausts the pool and
 * stalls DB traffic for the entire application.
 *
 * That hazard did not exist before this wave: the in-transaction work used to be
 * a synchronous `slotFixtures` pass. It arrived WITH the solver, which is
 * exactly why it is called out here rather than assumed to be obvious.
 *
 * There is no second transaction, because this use case writes nothing. If a
 * write tail is ever added it opens its own, after the solve.
 *
 * Pinned by `__tests__/schedule-auto-tx-boundary.test.ts`, structurally — it
 * asserts the solver is entered at transaction depth 0, not that the call was
 * fast, because a timing assertion is a flake on a loaded machine.
 */
export async function autoSchedule(
  auth: AuthCtx,
  stageId: string,
  body: AutoScheduleRequest,
): Promise<AutoScheduleOut> {
  // ---- Phase 0: the cooldown. Before the read, before the solver, before
  // anything that costs more than a Redis INCR.
  await rateLimit(`auto-schedule:${auth.orgId}`, autoScheduleCooldown());

  // ---- Phase 1: read. The connection goes back to the pool at the `}` below.
  const plan = await withTenant(auth.orgId, async (tx): Promise<AutoSchedulePlan> => {
    const [stage] = await tx<
      {
        division_id: string;
        competition_id: string;
        // P9 pass 2b: read straight off the SAME join the rest of this query
        // already makes rather than a second round trip — division's D5/P8
        // tags and the stage's own V367 sibling (its READ path, previously
        // unwired, see court-candidates.ts), unioned below for the
        // candidate-court resolve.
        stage_required_court_tags: string[];
        division_required_court_tags: string[];
      }[]
    >`
      select s.division_id, d.competition_id,
        s.required_court_tags as stage_required_court_tags,
        d.required_court_tags as division_required_court_tags
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    const settings = await loadSettings(tx, stage.division_id);
    const all = await divisionFixtures(tx, stage.division_id);
    // P9 pass 3a: resolved once here (the only phase with a connection) and
    // carried out via the plan for phase 3's wire mapping — see AutoSchedulePlan.
    const courtNames = await courtNamesById(tx);
    const { scopes } = await divisionLockState(tx, stage.division_id);
    // C1 (2026-08-12 round-order design). Resolved once, reused for both the
    // `schedulable` builder below and every `toAssignment` call in this
    // function — `obstacles` spans OTHER stages in this same division, so
    // without this a stepladder's own round_no (display numbering, not a
    // round-robin sequence) would ride along and get compared against this
    // stage's round-robin rounds as if they were one sequence.
    const roundRobin = await roundRobinStageIds(tx, stage.division_id, settings);
    const entrantIds = [
      ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
    ].filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, entrantIds);

    // Movable: this stage's undecided fixtures. Fixed obstacles: everything
    // already on the timetable elsewhere in the division (other stages,
    // decided fixtures) plus sibling divisions.
    // A fixture holding a result is fixed like a decided one (`isMovable`), so
    // it lands in `obstacles` below and keeps its slot.
    const played = await playedFixtureIds(tx, stage.division_id);
    const movable = all.filter((f) => f.stage_id === stageId && isMovable(f, played));
    const obstacles = all
      .filter((f) => !movable.includes(f))
      .filter((f) => f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    const siblings = await siblingAssignments(
      tx,
      stage.division_id,
      stage.competition_id,
      settings.config.matchMinutes,
    );

    // Pinned cards are fixed obstacles on EVERY mode, BUILD included (owner
    // ruling 2026-08-12, #pins-in-build) — scope-locked fixtures (Jul3/03 §4
    // two-site safety) pin the same way. Hoisted out of the `schedulable`
    // builder below because THREE things read it now — the `locked` anchor,
    // REFLOW's incumbent board, and the set `buildSchedule` may not move
    // (C4, 2026-08-14: `reflowExisting`'s `pinned` arg, frozen alongside
    // `placed` — see that function's own doc comment).
    //
    // `only_unlocked` used to gate this filter too, which was the bug: the
    // primary Auto-schedule button always posts `only_unlocked: false` (to
    // derive `mode: "build"` — see `AutoScheduleRequest` in schemas.ts), so
    // the gate silently zeroed this set on every BUILD call and a locked
    // fixture entered the solve fully movable. `only_unlocked` now steers
    // ONLY `mode` derivation, nowhere else; a lock is honoured regardless of
    // it, and `ignore_locks` is the one explicit way to suppress one.
    //
    // ONE predicate (`lockedFixtureIds`, below), reused as-is for POLISH's
    // `frozen` set at the return statement — a second hand-maintained copy of
    // "is this fixture locked" is exactly how the pin the solver honours and
    // the pin the caller sees drifted apart in the first place.
    const pinnedIds = lockedFixtureIds(movable, scopes, body.ignore_locks ?? false);

    // P9 pass 2b: the candidate court set for THIS stage — the organiser's
    // configured `settings.config.courts`, filtered to non-archived courts
    // carrying every tag the division OR the stage requires, through the
    // ONE engine filter (court-candidates.ts's own header explains why a
    // second, inlined tag-filter loop here is this subsystem's recurring
    // bug). `settingsForEngine` overrides ONLY `config.courts` — every other
    // read of `settings` below (matchMinutes, orgTz, …) stays untouched —
    // so `toVerifyConfig`/`toSlotConfig` need no changes of their own:
    // `courts: [...c.courts]` already does the right thing once the courts
    // it's handed already ARE the filtered set.
    const requiredCourtTags = unionRequiredCourtTags(
      stage.division_required_court_tags,
      stage.stage_required_court_tags,
    );
    // #622 review (finding #9): these two are independent reads over the same
    // open tx — `resolveCandidateCourts` resolves the STAGE-WIDE set,
    // `requiredCourtTagsByFixture` the per-fixture tag map `candidateCourtsByFixture`
    // narrows below — so there is no ordering dependency to serialise them for.
    const [candidateCourtIds, fixtureTags] = await Promise.all([
      resolveCandidateCourts(tx, stage.division_id, settings.config.courts, requiredCourtTags),
      requiredCourtTagsByFixture(tx, stage.division_id, stage.division_required_court_tags),
    ]);
    // #622: the stage-wide set above is now a FLOOR, not the whole answer. A
    // round-scoped tag narrows individual fixtures BELOW it (only the final
    // needs the championship court), so each movable fixture carries its own
    // `allowedCourts` and `config.courts` stays the stage-wide set — which is
    // exactly what the lattice needs, because a lattice narrowed to the
    // intersection would delete the slots the un-narrowed rounds must use.
    //
    // Resolved through the shared `requiredCourtTagsByFixture`/
    // `candidateCourtsByFixture` pair (fetched alongside `candidateCourtIds`
    // above), the SAME two `validateScheduleIn` and `buildSchedulePack`
    // resolve through, so the three cannot disagree about a fixture's
    // candidate set — the fork court-candidates.ts's header opens by warning
    // about, now with a third scope to fork over.
    const fixtureCandidates = await candidateCourtsByFixture(
      tx,
      stage.division_id,
      settings.config.courts,
      fixtureTags,
    );
    const settingsForEngine = {
      ...settings,
      config: { ...settings.config, courts: [...candidateCourtIds.ids] },
    };
    // P9.5: the candidate courts' own opening hours (V367). Scoped to the
    // candidate ids, which is what keeps an ARCHIVED court's existing cards
    // validating clean — an archived court is not a candidate, so it is absent
    // from this list, and `usableWindows` reads absent as unrestricted. "The
    // court is gone" is P10's stranded-fixture case (A6), not this one.
    const courtCalendars = await resolveCourtCalendars(tx, candidateCourtIds.ids);
    // P10 (A6/§1): this run's OWN assigned courts, so an existing card sitting
    // on a since-archived court is flagged on the very board this pass hands
    // back — not only on the NEXT /validate. `all`, not `movable`: an obstacle
    // card this run cannot move is still on the board this pass reports on.
    const strandedCourtIds = await strandedCourtIdsForDivision(
      tx,
      stage.division_id,
      [...new Set(all.map((f) => f.court_id).filter((c): c is string => c !== null))],
    );

    // #622: which of this stage's movable fixtures are narrowed BELOW the
    // stage-wide candidate set by a round-scoped tag, as `allowedCourts` for
    // the solver and the greedy placer. A fixture whose set already equals the
    // stage-wide one gets nothing at all — that is every fixture on every
    // board with no round rules, so the ordinary solve is unchanged down to
    // the wire bytes (`build.ts`'s `allowedCourtsFor`, and `model.py` section
    // 1c which emits no constraint for an unconstrained fixture).
    const stageWideCourts = new Set(candidateCourtIds.ids);
    const narrowedCourtsFor = (fixtureId: string): readonly string[] | undefined => {
      const ids = fixtureCandidates.get(fixtureId);
      if (ids === undefined) return undefined;
      if (ids.length === stageWideCourts.size && ids.every((id) => stageWideCourts.has(id))) {
        return undefined;
      }
      return ids;
    };
    const schedulable: SchedulableFixture[] = movable.map((f) => ({
      id: f.id,
      // C1 (2026-08-12 round-order design). `roundNo` used to be stamped
      // unconditionally — harmless while it was only a soft placement-order
      // hint for `slotFixtures`' own comparator, but `movable` is always
      // stage-scoped to ONE stage here (see the `movable` filter above), so
      // a bare stage-kind check is enough: gated the same way `toAssignment`
      // is, for the same reason (round is now a HARD constraint elsewhere,
      // not merely an ordering hint, so a bracket/stepladder stage's own
      // display-numbering round_no must not ride along as if it meant
      // round order; the set is league, group and swiss — W3 T3b).
      ...roundFieldsOf(roundRobin, f),
      ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
      divisionId: f.division_id,
      // C1 fix-loop (Finding 2). Unconditional, same as `divisionId` — see
      // `SchedulableFixture.stageId`'s own doc comment in `calendar.ts` for
      // why `build.ts`'s contamination guard needs it.
      stageId: f.stage_id,
      ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
      ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
      people: peopleOf(f, people),
      ...(pinnedIds.has(f.id)
        ? { locked: { court: f.court_id as string, startAt: ms(f.scheduled_at as string | Date) } }
        : {}),
      // #622 — omitted, never `[]`, when this fixture is not narrowed: an
      // empty array reads as UNCONSTRAINED everywhere downstream (the wire,
      // `slotFixtures`, `allowedCourtsFor`), so sending one would be
      // indistinguishable from the un-narrowed case anyway and would only
      // make the difference harder to see in a test snapshot.
      ...(narrowedCourtsFor(f.id) !== undefined
        ? { allowedCourts: narrowedCourtsFor(f.id) as readonly string[] }
        : {}),
    }));

    // ONE config for both halves of this pass (#447). The placer reads the
    // `SlotConfig` side, the typed-rule referee below reads the `VerifyConfig`
    // side, and neither can drift onto a different idea of the rules.
    // #462: the siblings' rule identity rides along with their court time. The
    // placer's day tally and the referee below both count only the `existing`
    // rows `ruleFixtures` names, so without this the auto pass proposes a board
    // that breaches a competition-scoped cap and then reports it clean.
    const board = [...obstacles, ...siblings.assignments];

    // Where the movable cards sit RIGHT NOW. REFLOW proposes from this rather
    // than from nothing, so it is split by whether this run may move the card.
    const placedNow = movable
      .filter((f) => !pinnedIds.has(f.id) && f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    const pinnedNow = movable
      .filter((f) => pinnedIds.has(f.id))
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));

    const declaredConfig = toVerifyConfig(
      settingsForEngine,
      all,
      roundToMinute(Date.now()),
      siblings.ruleFixtures,
      courtCalendars,
      strandedCourtIds,
    );
    const windowedConfig = boundSolverWindow(
      declaredConfig,
      schedulable,
      board,
      // REFLOW alone proposes cards that are already placed, so REFLOW alone
      // needs the window widened to contain them. Passing them on a BUILD
      // would stretch the lattice around a board that pass is about to
      // replace.
      body.mode === "reflow" ? [...placedNow, ...pinnedNow] : [],
      // The SAME feeds `buildSchedule` is handed below, so the window this
      // measures can actually fit a dependent after its feeders.
      feedDependencies(all),
    );
    // BUILD, with an organiser-set end date, only. POLISH and REFLOW are
    // contracts about NOT moving a card that doesn't need moving (R20/#452) —
    // a default the organiser never asked for would fight that on any board
    // that already exists across days one way, forcing churn to satisfy a cap
    // nobody set. A fresh BUILD has no existing board to disturb, which is
    // exactly the reported bug's shape — but only when `declaredConfig.window`
    // is finite, i.e. `endAt` was actually set: `boundSolverWindow` fills in
    // an UNFINISHED window from wherever the greedy seed's fixtures happened
    // to land, and that derived span is not a date range the organiser
    // configured, so a board with no end date at all must not get a cap it
    // never asked for either.
    const hasExplicitRange = declaredConfig.window !== undefined && Number.isFinite(declaredConfig.window.to);
    const config =
      body.mode === "build" && hasExplicitRange
        ? withDefaultDaySpread(windowedConfig, stage.division_id, schedulable.length)
        : windowedConfig;

    return {
      schedulable,
      config,
      // D2 capacity guard reads THIS, not `config` or even `windowedConfig`:
      // both carry SOLVER-CONVENIENCE machinery the organiser never
      // configured. `withDefaultDaySpread`'s injected max_fixtures_per_day
      // is a makespan-distribution NUDGE the solver/greedy already treat as
      // best-effort (a breach reports as a CAP conflict, never a refusal —
      // honoring it as a hard arithmetic bound is the placer/verifier fork
      // this codebase keeps naming as its recurring defect). And
      // `boundSolverWindow` FILLS IN a finite window from wherever the
      // greedy seed's fixtures happen to land when the organiser set no
      // `endAt` at all (its own doc comment, a few lines below) — feeding
      // THAT synthetic span into a precheck would refuse boards an
      // organiser never gave an end date to assess against in the first
      // place. `declaredConfig` is the one config built directly from
      // `settings.config` with neither adjustment — exactly what the
      // organiser configured, still carrying every rule they actually set
      // (constraints.hard from the Constraints tab).
      capacityConfig: declaredConfig,
      // P9 pass 2b: the NO_MATCHING_COURT guard (phase 2, no db connection
      // held) reads `capacityConfig.courts.length` — declaredConfig's, the
      // same "read declaredConfig, never windowedConfig/config" discipline
      // guardCapacity's own call site already established just below — and
      // needs the tags that produced it for the error payload, which is not
      // otherwise derivable once the transaction has closed.
      requiredCourtTags,
      courtNames,
      board,
      divisionId: stage.division_id,
      orgTz: settings.orgTz,
      // Over `all`, not over `movable`: `feedDependencies` keeps only edges whose
      // BOTH ends are in the list it is given, and a semi already decided (so not
      // movable) still constrains the final it feeds. The same argument every
      // other surface passes — `applySchedule`, the move gate and the board
      // report all call `feedDependencies(all)`.
      dependencies: feedDependencies(all),
      placedNow,
      pinnedNow,
      // Literally `pinnedIds`, not a second computation of it — see the
      // comment on `pinnedIds` above. POLISH's freeze set and the anchor the
      // solver sees must never be able to name a different set of fixtures.
      frozen: [...pinnedIds],
      total: schedulable.length,
    };
  });

  // ---- Phase 2: solve. Nothing below here holds a database connection.
  //
  // Three modes, ONE config (design D2), and — since C4 (2026-08-14, z3
  // retirement stage A) — ONE solver behind all three: `buildSchedule`, the
  // placement CP-SAT service. BUILD and POLISH call it directly, below.
  // REFLOW calls it through `reflowExisting`, which is not a thin wrapper:
  // `buildSchedule` has no "fewest cards moved" term of its own the way
  // z3's old ascending-k repair walk did, so `reflowExisting` freezes every
  // already-placed card (locked or not) via the same `frozen`/`current`
  // mechanism POLISH uses (R20) to keep that property without one — see
  // `reflowExisting`'s own doc comment for the full rationale, the accepted
  // trade-off, and the reconciliation this makes necessary.
  const { schedulable, config, board, dependencies, total } = plan;
  // P9 pass 2b: an empty candidate court set makes the solve unwinnable
  // before it starts — checked FIRST, ahead of capacity, because "no court
  // matches your tags" is a more specific, more actionable refusal than the
  // capacity guard would derive from a zero-court config on its own. Reads
  // `capacityConfig.courts` (declaredConfig, already the FILTERED set —
  // phase 1 fed it through `resolveCandidateCourts` before building
  // `declaredConfig`), the same "read declaredConfig" discipline
  // `guardCapacity` just below follows for the identical reason.
  guardNoMatchingCourt(plan.capacityConfig.courts, {
    requiredTags: plan.requiredCourtTags,
    divisionId: plan.divisionId,
    stageId,
  });
  // #622 review: the stage-wide guard above cannot see a round-scoped tag
  // that narrows a SINGLE fixture's own candidate set to empty while the
  // stage-wide set stays non-empty (other rounds still have candidates) —
  // see `guardNoMatchingCourtPerFixture`'s own doc comment.
  guardNoMatchingCourtPerFixture(schedulable, {
    requiredTags: plan.requiredCourtTags,
    divisionId: plan.divisionId,
    stageId,
  });
  // P9.5, edge matrix row 3: the same refusal one constraint over. If every
  // candidate court is CLOSED for the whole run — hours that miss the session
  // window, or a closed exception on the only day — the lattice would be empty
  // and the solver would answer "infeasible", which tells an organiser nothing
  // about the court calendar they just edited. Placed here, after the tag
  // guards and before capacity, for the same reason the tag guard sits ahead of
  // capacity: "no court is open then" is more specific and more actionable than
  // anything the capacity arithmetic would derive from an empty supply.
  //
  // Reads `plan.config`, which already carries the loaded calendars and the org
  // zone — the same object the placer and the verifier read, so the guard
  // cannot refuse a run the lattice would have allowed.
  //
  // BUILD ONLY. A reflow or polish already HAS a board, and its window is
  // widened to contain those cards — so an organiser who narrows the sole
  // court's hours to Mon-Fri under a Saturday board would make every candidate
  // court closed across that range and get a hard 422 with no
  // `acknowledge_warnings` route out and no edit that fixes it. That is exactly
  // the case `outside_court_hours` is carved out of `isBlockingConflict` to
  // keep advisory (calendar.ts, and conflict-detail.ts's header says so in as
  // many words), and this guard would have overridden that promise from the
  // other side. The empty-lattice argument only applies to a FRESH solve,
  // which is what `mode: "build"` is.
  if (body.mode === "build") {
    const cfg = plan.config;
    const span = cfg.window ?? { from: cfg.startAt, to: cfg.startAt };
    // `applyWindow` yields -Infinity/Infinity for an unbounded window, and
    // `dayKeyInTz(Infinity)` THROWS. An unbounded run also has no finite set of
    // days to prove closed, so there is nothing here to refuse.
    if (cfg.tz !== undefined && Number.isFinite(span.from) && Number.isFinite(span.to)) {
      guardNoUsableCourtWindows(
        cfg.courts,
        cfg.courtCalendars ?? [],
        { from: dayKeyInTz(span.from, cfg.tz), to: dayKeyInTz(span.to, cfg.tz) },
        { tz: cfg.tz, sessionWindows: cfg.sessionWindows, blackouts: cfg.blackouts },
        { divisionId: plan.divisionId },
      );
    }
  }
  // D2 capacity pre-check: arithmetic-provable impossibility refuses with a
  // typed 422 BEFORE either solver is reached — no db connection is held
  // here (phase 1 already closed), so this costs nothing a real solve
  // wouldn't have paid anyway. `guardCapacity` returns null and does
  // nothing when the config has no bounded window to assess.
  guardCapacity(capacityInputForFixtures(schedulable, plan.capacityConfig, plan.divisionId), {
    scope: "stage",
    divisionId: plan.divisionId,
    stageId,
  });
  /**
   * The organiser's board as it stands — every movable card that currently has a
   * time, whether or not this run may move it.
   *
   * POLISH ONLY, and that is the whole of ruling R20. `BuildInput.current` does
   * two things the engine cannot do for itself: it is the baseline `moved` and
   * `lost` are measured against, and it is where a `frozen` id with no `locked`
   * anchor gets pinned. Without it POLISH measured its churn against a board
   * greedy invented during the run — so a pass that relocated every card
   * reported "nothing moved" — and froze published cards onto slots nobody had
   * ever seen, which is the exact opposite of the mode's purpose.
   *
   * NOT sent on BUILD. A fresh full pass is not a rearrangement of anything, and
   * anchoring its churn to a board it was asked to replace would report every
   * card as moved by definition.
   *
   * EMPTY MEANS NO BOARD, and the array is withheld rather than sent empty. The
   * engine draws the same line (`input.current.length > 0 ? … : undefined`), so
   * this is belt-and-braces on today's engine rather than an independently
   * observable guard — kept because the alternative reading of `[]` is "every
   * card moved and every card was lost" on a stage nobody has ever scheduled,
   * and that is too sharp an edge to leave to one package's internals.
   */
  const currentBoard = [...plan.placedNow, ...plan.pinnedNow];
  /**
   * No SERIALISING or ADMISSION wrapper sits around the solve, and the absence
   * is deliberate (R17): nothing here may make the call wait. The one wrapper
   * that does sit here, `autoBuildSchedule` (#452, described at the end of this
   * comment), rewrites the request and judges the reply; it awaits nothing
   * ahead of the call.
   *
   * HOW THIS WAS LEARNT (history — z3 and its lock were deleted in C8, so
   * none of the machinery named here still exists). A `withZ3Teardown` helper
   * once wrapped this call with a `finally { await resetZ3() }` to hand the
   * WASM heap back. It was redundant — the engine already freed the heap
   * inside its own lock, which is where it had to happen for the bound to be
   * per solve rather than per burst — and it was actively harmful:
   *
   *   * that lock was a strict FIFO promise chain and `resetZ3` took it, so
   *     the no-op reset queued BEHIND every solve already waiting. Three
   *     concurrent clicks: the first solve finished at ~8s and its HTTP response
   *     landed at ~24s.
   *   * it defeated the queue cap outright. `buildSchedule` answers
   *     `solver_busy` with a greedy board WITHOUT reaching the solver, precisely
   *     so the third caller need not wait — and this `finally` made that
   *     immediate answer wait out two full budgets anyway.
   *
   * WHAT STILL APPLIES. There is no heap to tear down any more, but the second
   * bullet survives the solver that produced it: a solve is now an
   * out-of-process RPC carrying `autoSolverWallMs()`, so anything added at this
   * seam that awaits it — a wrapper, a limiter, an admission check moved below
   * the call — puts a refusal that costs nothing behind an answer that costs
   * tens of seconds. Pinned by `schedule-auto-solver-busy-latency.test.ts`,
   * which stages the contention by holding the placement client open (it used
   * to hold the z3 lock; C8 deleted that and the test with it, and this
   * restores the fact at the seam that replaced it).
   *
   * `autoBuildSchedule` (#452) is `buildSchedule` plus two things that keep
   * that promise: it adds each pool's rest to the request on the way IN (a
   * synchronous rewrite of the input, nothing awaited ahead of the call), and
   * refuses a solver board that breaks a declared rest on the way OUT — a
   * second, solver-free greedy rebuild that runs only when the first call has
   * already returned a solver board. A `solver_busy` answer is greedy, so it
   * comes straight back. See `schedule-solver-rest.ts`.
   */
  const out: BuildResult | ReflowResult = await (body.mode === "reflow"
    ? // Pinned cards are handed separately from the rest: the solver may not
      // move them, but they are still part of the proposal it hands back.
      reflowExisting({
        schedulable,
        config,
        board,
        dependencies,
        placed: plan.placedNow,
        pinned: plan.pinnedNow,
      })
    : autoBuildSchedule({
        fixtures: schedulable,
        config,
        existing: board,
        dependencies,
        wallMs: autoSolverWallMs(),
        solve: placementSolver,
        log: schedulerLog,
        ...(body.mode === "polish"
          ? {
              frozen: plan.frozen,
              ...(currentBoard.length > 0 ? { current: currentBoard } : {}),
            }
          : {}),
      }));

  /**
   * REFLOW's first-time-placement count, absent on the two modes that cannot
   * distinguish one. Read out here rather than through an `in` narrowing at the
   * spread below, where `ReflowResult` being assignable to `BuildResult` makes
   * the narrowed property `unknown`.
   *
   * ANNOTATED, and the `typeof` guard is not decoration: hoisting the `in` out
   * of the spread moved the problem rather than solving it. `in` on a type
   * that does not declare the key narrows the property to `{} | null`, which is
   * not assignable to `ScheduleSolverInfo["seeded"]` — and the object literal
   * below reports only its FIRST incompatible property, so for as long as
   * `status` was also wrong this error was invisible.
   */
  const seeded: number | undefined =
    "seeded" in out && typeof out.seeded === "number" ? out.seeded : undefined;

  // ---- Phase 3: map. Pure (courtNames was resolved in phase 1).
  return {
    assignments: out.assignments.map((a) => ({
      fixture_id: a.fixtureId,
      scheduled_at: iso(a.startAt),
      ends_at: iso(a.endAt),
      court_id: a.court,
      court_name: plan.courtNames.get(a.court) ?? null,
    })),
    // No baseline: the auto pass PROPOSES a board rather than editing one, so
    // every conflict in it is this proposal's own doing (#399).
    //
    // WIDER THAN IT USED TO BE, deliberately. This pass previously reported only
    // what the placer could not fit (`no_slot`, `start_window`, a pinned
    // collision) plus the typed-rule referee; it now also carries the FULL
    // verifier's rows, because `buildSchedule` and `reflowExisting` both run
    // `validateAssignments` over the board they produce. So rest and overlap
    // rows the auto pass never emitted can now appear.
    //
    // That is the point of the programme — a board that breaches a rule should
    // say so on the surface the organiser builds it from — but it has a sharp
    // edge worth naming: REFLOW is the DEFAULT mode, and on `timeout` or
    // `infeasible` it hands back the organiser's ORIGINAL board and verifies
    // THAT. A board they have been living with can therefore come back carrying
    // blocking rows they have never been shown before. Pinned exactly, board and
    // row for row, by `schedule-reflow-verifier-widening.test.ts`.
    //
    // `validateInstructionRules` derives its own rule stream and shares no row
    // with `validateAssignments` (which reads only the `min_rest_minutes`
    // subset, and only to raise a pair's bound), so the two lists concatenate
    // without double-reporting.
    conflicts: mapConflicts(
      [...out.conflicts, ...validateInstructionRules(out.assignments, config, board)],
      plan.courtNames,
    ),
    metrics: {
      makespan_minutes: out.metrics.makespanMinutes,
      worst_idle_gap_minutes: out.metrics.worstIdleGapMinutes,
      court_imbalance_minutes: out.metrics.courtImbalanceMinutes,
      placed: out.metrics.placed,
      total,
    },
    solver: {
      engine: out.engine,
      status: out.status,
      // Forwarded, never synthesised, and only ever present alongside
      // `status: "not_searched"` — see `ScheduleSolverInfo.not_searched_reason`.
      // `BuildResult` sets it on all six of `not_searched`'s exits; REFLOW's
      // `settle()` never reports `not_searched` at all, so this stays absent on
      // every REFLOW result, exactly like every other BUILD-only field here.
      ...(out.notSearchedReason !== undefined
        ? { not_searched_reason: out.notSearchedReason }
        : {}),
      // The mode the CALLER asked for, not a property of the result. `engine`
      // names what produced the board and cannot stand in for it: an expired
      // REFLOW and a BUILD that ran out before its first tier are both
      // `greedy` / `budget_expired` / `tiersCompleted: 0` / `tiers_total: 4`,
      // and only one of them was ever on a tier ladder.
      mode: body.mode,
      tiers_completed: out.tiersCompleted,
      tiers_total: TIERS_TOTAL,
      budget_expired: out.budgetExpired,
      elapsed_ms: out.elapsedMs,
      moved: out.moved,
      // Relocations and losses are separate counts since R21. Forwarded on every
      // mode: it is 0 wherever the run had no baseline to lose from, and that 0
      // is a fact rather than a placeholder.
      lost: out.lost,
      // REFLOW only — the one path that can tell a first-time placement from a
      // relocation. BUILD and POLISH re-place everything by definition, so the
      // distinction does not arise and the field stays off the payload.
      ...(seeded !== undefined ? { seeded } : {}),
      // Forwarded, never synthesised: absence on an `infeasible` result is
      // the engine SAYING the proof is about the board rather than the pins.
      ...(out.contradictoryPins !== undefined
        ? { contradictory_pins: [...out.contradictoryPins] }
        : {}),
      // `plan.frozen` IS `pinnedIds` (see `lockedFixtureIds`) — its length is
      // exactly the count of this stage's own fixtures held fixed by a lock
      // this run, on every mode, always present so a client never needs a
      // null check to render "N fixtures are locked and will be kept".
      locked_kept: plan.frozen.length,
    },
  };
}
