// W6 (#401), C5 (z3 retirement stage B, 2026-08-15) — the placement CP-SAT
// service, as the AI runners see it.
//
// Both runners (single-division `runAiPlan`, joint `runCompetitionAiPlan`) hit a
// verifier pass and then, on blocking conflicts, spend an LLM repair round. This
// module is what they try FIRST: pin what stands — this pack's own pins, union
// every movable fixture the caller's own verifier did NOT flag as blocking —
// and re-solve only the violators through `buildSchedule`, no tokens, no
// credits, no SDK call.
//
// C5 replaced the z3 `repairDecomposed` call this module used to wrap with a
// direct `buildSchedule` call — see `reflowExisting` (`schedule.ts`) for the
// identical pattern REFLOW already uses (`frozen`/`current` anchoring, the
// fallback-exit reconciliation) and
// `docs/superpowers/specs/2026-08-12-z3-retirement-design.md` stage B for the
// design ruling this module implements ("pin what stands, re-solve the
// violators"). `buildSchedule` has no "fewest fixtures moved" term the way
// z3's ascending-k repair search did — freezing every non-violator is what
// keeps this round from letting the solver reshuffle a board the LLM
// conversation, and the organiser, have already seen.
//
// Three properties this module still guarantees, none of which belongs in a
// runner:
//
//   1. IT NEVER FAILS THE RUN. Every throw `buildSchedule` can produce is
//      caught here and turned into a fallback the caller reads as "use the
//      LLM". A repair that cannot be done is not an error; it is the status
//      quo before this wave.
//   2. A FROZEN ID NEVER MOVES. Every fixture not named by a blocking
//      conflict — and every fixture this pack pinned — comes back at
//      EXACTLY the slot `board` (the caller's own record) had it at,
//      regardless of what `buildSchedule` itself reports: its FALLBACK exits
//      (`already_optimal`, a proved tie, `verifier_rejected`, `not_searched`)
//      report the plain unpinned greedy seed, which has no idea a
//      `current`-only frozen id is supposed to stay put (the same C4 finding
//      `reflowExisting` guards against — see its doc comment).
//   3. IT IS TELEMETRY-VISIBLE EITHER WAY. #401 requires the fallback to be
//      visible, not merely correct. Every path fills {@link SolverTelemetry}.
//
// UNLIKE THE Z3-ERA VERSION, this module does NOT wrap the call in its own
// busy-gate/wall-clock race. Those existed for TWO z3-specific reasons:
// `repairDecomposed` serialises per process and cannot be cancelled (its
// `resetZ3()` tears down a shared WASM context), so "a run parked behind
// another run's solve would therefore sit past its own deadline with the
// engine reporting a perfectly healthy elapsed time" — and this module's own
// busy flag was the ONLY thing standing between a caller and that queue,
// since nothing else serialised z3 access for this path.
//
// `buildSchedule` narrows the SAME risk rather than eliminating it outright:
// it has its OWN admission control (`MAX_SOLVER_QUEUE`, checked FIRST,
// declining rather than queueing past two in flight) and its OWN hard
// transport deadline (`placement-client.ts`'s gRPC channel deadline plus a JS
// watchdog, both derived from `wallMs`, guaranteeing the PROMISE settles) —
// but `build.ts` STILL wraps every `buildSchedule` call, this one included,
// in the SAME process-wide `withZ3LockAndReset` mutex BUILD/POLISH/REFLOW
// already queue behind (kept deliberately, for reasons unrelated to this
// module — see that file's own comment on why removing it needs its own
// measurement first). So a repair attempt CAN still exceed its nominal
// budget while queued behind an unrelated BUILD/POLISH/REFLOW/repair call on
// this box — the watchdog still guarantees the call eventually settles, and
// `SolverTelemetry.ms` correctly reports the full elapsed time including any
// queue wait, so nothing is mis-reported. It does mean the run-level budget
// bookkeeping (`solverBudgetLeft`, `SOLVER_MIN_BUDGET_MS`) is a target, not a
// hard ceiling this module itself enforces — same as it already is for
// BUILD/POLISH/REFLOW. BUILD/POLISH/REFLOW already call `buildSchedule`
// directly with no wrapper of their own for exactly this reason
// (`schedule.ts`'s R17 ruling: a redundant wrapper here is not neutral, it is
// the same mistake `withZ3Teardown` was — see that ruling's own comment for
// the measured latency cost of layering a second serialisation on top of one
// that already exists).
import {
  repairDecomposedCpsat,
  type Assignment,
  type BuildInput,
  type DecomposedRepairResult,
  type OrderDependency,
  type SchedulableFixture,
} from "@seazn/engine/scheduling";

/**
 * Wall-clock ceiling on ONE solver attempt, measured from the moment this
 * module is asked, not from the moment the engine starts working.
 *
 * NOT `DEFAULT_BUILD_WALL_MS`. That constant is BUILD/POLISH/REFLOW's own
 * default, sized for a full-board placement; four minutes inside a web
 * request answering a repair round is not a budget, it is an outage.
 *
 * 45 s, from the measurements the original (#401) wave recorded and this
 * session re-confirmed still hold against `buildSchedule`:
 *
 *   * The thing this replaces is an LLM repair round, bounded by
 *     `ROUND_TIMEOUT_MS` = 600_000 and costing tokens and credits. A solver
 *     ceiling has to be small beside one round or the fallback path — solver
 *     burns its budget, LLM round then runs anyway — makes the run slower than
 *     not having a solver at all. 45 s is 7.5% of one round's ceiling.
 *   * `buildSchedule`'s own transport deadline is derived from the `wallMs`
 *     this budget becomes, so it is also the ceiling on how long a genuinely
 *     unreachable placement service can hold this call.
 *
 * Override per deployment with `SCHEDULING_REPAIR_BUDGET_MS`. Read per call
 * rather than at module load so a deployment — or a test — can change it without
 * depending on import order.
 */
export function solverBudgetMs(): number {
  const raw = Number(process.env.SCHEDULING_REPAIR_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

/**
 * The floor under a RE-attempt's remaining run budget.
 *
 * The runners try the solver before every repair round, sharing one run-level
 * budget. Below this there is not enough left to encode even a trivial board
 * and get an answer back over the wire, so the attempt would spend its whole
 * remainder proving nothing and then fall back anyway. The FIRST attempt of a
 * run is exempt: an operator who configures a tiny budget gets the attempt,
 * and the telemetry, they asked for.
 */
export const SOLVER_MIN_BUDGET_MS = 2_000;

/** The kill switch. `SCHEDULING_REPAIR_SOLVER=off` sends every run down the LLM
 *  repair path exactly as it behaved before #401 — no deploy needed. Kept
 *  through the C5 cutover as the same lever, now gating a `buildSchedule` call
 *  instead of a z3 one. */
export function solverEnabled(): boolean {
  return (process.env.SCHEDULING_REPAIR_SOLVER ?? "on").toLowerCase() !== "off";
}

/** Which engine produced the board the caller is returning. `none` means no
 *  repair changed it — either it verified clean, or repair was attempted and
 *  nothing was adopted. `z3` stays a valid value (it can still be read back
 *  from a board stored before this cutover, and the wire schema still accepts
 *  it as input until C7 narrows it) but is no longer PRODUCED by this module —
 *  `optimized` is written on adoption instead, C4's own vocabulary for a
 *  genuine placement-service win. */
export type RepairEngine = "none" | "z3" | "llm" | "optimized";

/**
 * The closed vocabulary `AiRepairReport.status`/`.fallback` already validate
 * on the wire (`schemas.ts`) — z3-decomposition-shaped names this module
 * keeps DELIBERATELY rather than inventing a `BuildStatus`-shaped set of its
 * own: C5's file set is additive-only on the wire (the `engine` enum alone),
 * so every value this module can now produce is mapped back onto these four,
 * not onto `buildSchedule`'s own `BuildStatus` union.
 *
 *   * `repaired` — every violator this attempt named is placed and no
 *     longer blocking.
 *   * `partial` — some moved, at least one violator is still blocking.
 *   * `unrepaired` — nothing moved: `buildSchedule` could not improve on
 *     the frozen board (`already_optimal`, a proved tie, `infeasible`,
 *     `not_searched`, `verifier_rejected`) or was unreachable
 *     (`solver_unavailable`, `solver_busy`).
 *   * `clean` — never produced by this module (it is only ever asked once a
 *     caller has already found a blocking conflict); kept for wire parity
 *     with whatever else may still emit it.
 */
export type SolverRepairStatus = "clean" | "repaired" | "partial" | "unrepaired";

/** Why the caller is falling back to LLM repair. Every value is a fact about
 *  this call, never a guess. Same closed set the wire already validates
 *  (`schemas.ts`'s `AiRepairReport.fallback`) minus `queue_wait`: that value
 *  existed only for the z3-era busy-gate this module no longer has (see the
 *  module doc comment) and is no longer producible — the wire keeps accepting
 *  it, narrowing it away is C7's job, not this one's. */
export type SolverFallback =
  /** The kill switch is off. */
  | "disabled"
  /** The wall clock ran out before an answer arrived, or `buildSchedule`
   *  itself reports `not_searched`/`out_of_time`. */
  | "budget"
  /** The solver answered, but left at least one violator still blocking. */
  | "partial"
  /** The solver answered and resolved nothing. */
  | "unrepaired"
  /** `buildSchedule` threw. */
  | "error"
  /** The solver answered, but the caller's own verifier did not agree the board
   *  was better, so its moves were discarded. Set by the CALLER, never by
   *  this module — see `schedule-ai.ts`/`competition-schedule-ai.ts`'s own
   *  adoption gate. */
  | "not_adopted"
  /** Joint runs only: the divisions in this run share no court, so there is no
   *  placement the solver could offer that is legal for all of them. Set by
   *  the CALLER (`competition-schedule-ai.ts`), never by this module. */
  | "court_split";

/** Everything one solver attempt observed. `engine` is stamped by the caller,
 *  which is the only party that knows whether an LLM round ran afterwards.
 *
 *  snake_case throughout, to match the `usage` object it ships beside. */
export interface SolverTelemetry {
  /** False on the clean path and on the one no-attempt path (`disabled`) —
   *  so "did we pay for a solve at all" is one field, not an inference over
   *  several. */
  solver_ran: boolean;
  status?: SolverRepairStatus;
  /** Violator fixtures whose slot changed. NOT a proved minimum in general —
   *  `buildSchedule` has no preference for touching fewer of the violators
   *  than necessary within one component, so a component with several
   *  violators can come back with more of them relocated than strictly
   *  necessary. `minimality` (below) says when `moved` IS provably the
   *  fewest possible. Frozen (non-violator) fixtures are UNAFFECTED
   *  regardless — structurally, not merely by convention (C9,
   *  `repair-decompose-cpsat.ts`'s own doc comment). */
  moved?: number;
  /** Wall-clock the request paid. */
  ms?: number;
  /** Violator fixtures still part of a blocking conflict after the attempt —
   *  handed to the LLM round so it is pointed at the residue rather than
   *  left to re-derive it. */
  unresolved?: number;
  /** Conflicts the reconciled board still carries, blocking or not. */
  residual?: number;
  /** C9 (decomposed repair on CP-SAT): whether `moved` is a PROVED minimum
   *  (`disjointConflictBound`, `repair-minimality.ts` — unchanged from the z3
   *  era, since it never touched z3 to begin with) or merely an upper bound a
   *  restricted search happened to find. Recovers the
   *  `data-minimality="proved"` claim C5 had to drop. */
  minimality?: "proved" | "upper_bound";
  /** Components the decomposed driver resolved (clean or repaired) vs.
   *  declined (skipped, timed out, infeasible). Diagnostic only — `unresolved`
   *  is the field that decides the next round's hand-off. */
  components_solved?: number;
  components_skipped?: number;
  /** The budget ran out, or `buildSchedule` reported it never got to search. */
  timed_out?: boolean;
  fallback?: SolverFallback;
}

export interface SolveBoardInput {
  /** Every fixture this pack's own model call may move — the FULL movable
   *  set, this pack's own pins included. Mirrors `reflowExisting`'s
   *  `schedulable`: `buildSchedule`'s own pin-promotion excludes any
   *  `frozen` id from being freely movable, so this must never be
   *  pre-filtered down to the violators alone. */
  fixtures: readonly SchedulableFixture[];
  /** Where every fixture in `fixtures` sits in the board this attempt is
   *  repairing — read both for the frozen anchor (`current`) and to tell a
   *  no-op attempt (every fixture already frozen, or unschedulable) from a
   *  real one. A fixture the model reported unschedulable is correctly
   *  ABSENT here (`toEngineAssignments`/`toJointEngineAssignments` build one
   *  row per `plan.assignments`, never per `fixtures`). */
  board: readonly Assignment[];
  /** Ids in `fixtures` that must not move this attempt: this pack's own pins
   *  union every fixture the caller's own verifier did NOT name in a
   *  blocking conflict ("pin what stands, re-solve the violators" — z3
   *  retirement design, stage B). Narrowed defensively against `board`
   *  inside this function — see the doc comment on that narrowing below —
   *  so a caller does not have to reason about the unschedulable case
   *  itself. */
  frozen: ReadonlySet<string>;
  /** Fixed occupancy OUTSIDE this pack's own fixtures (obstacles). Never
   *  includes a pinned fixture from THIS pack — those go through
   *  `fixtures`+`frozen` instead, the same split `reflowExisting` uses, so a
   *  dependency edge touching a pinned fixture still resolves (both ends in
   *  one array) instead of crossing the `fixtures`/`existing` boundary. */
  existing: readonly Assignment[];
  dependencies: readonly OrderDependency[];
  config: BuildInput["config"];
  budgetMs?: number;
}

export interface SolveBoardOutcome {
  /** The repaired board, when there was an attempt worth offering. `null`
   *  only on the two no-attempt/throw paths (`disabled`, `error`) — every
   *  other path returns a full board, reconciled, even when nothing moved.
   *  The caller still has to verify it: this module never decides that a
   *  board is good enough. */
  assignments: readonly Assignment[] | null;
  /** The violator fixtures whose slot changed, sorted. Empty whenever
   *  `assignments` is null. */
  movedFixtureIds: readonly string[];
  /** Violator fixtures still blocking after the attempt. Sorted. */
  unresolvedFixtureIds: readonly string[];
  telemetry: SolverTelemetry;
}

/** {@link SolverTelemetry} once a caller has stamped which engine produced the
 *  board it is returning. This is the shape that reaches the API. */
export interface RepairReport extends SolverTelemetry {
  engine: RepairEngine;
}

const noAttempt = (fallback: SolverFallback): SolveBoardOutcome => ({
  assignments: null,
  movedFixtureIds: [],
  unresolvedFixtureIds: [],
  telemetry: { solver_ran: false, fallback },
});

/**
 * One solver attempt. Never throws.
 *
 * The caller is expected to re-verify `assignments` with its OWN verifier
 * before adopting them — this module returns a candidate, not a verdict. That
 * is not belt-and-braces: the joint runner verifies per division with
 * per-division configs and hands this module one merged config, so its own
 * pass is the only authority on whether the merged view was faithful.
 */
export async function solveBoard(input: SolveBoardInput): Promise<SolveBoardOutcome> {
  if (!solverEnabled()) return noAttempt("disabled");

  const knownById = new Map(input.board.map((a) => [a.fixtureId, a] as const));
  /**
   * Defensive narrowing, not merely trusting the caller's own computation: a
   * frozen id with no slot in `board` would otherwise reach `buildSchedule`
   * as a `frozen` id `publishedSlotOf` (build.ts) cannot resolve from
   * `locked` or `current` — falling through to its THIRD source, the raw
   * greedy seed `buildSchedule` invents internally this very run. That pins
   * the fixture to a slot nobody chose instead of leaving it free, and it is
   * not hypothetical: it is exactly the shape of a fixture the model
   * reported unschedulable (absent from `board` by construction), which must
   * stay free to be placed, never frozen onto an invented slot.
   */
  const frozen = new Set([...input.frozen].filter((id) => knownById.has(id)));
  const violatorIds = input.fixtures.map((f) => f.id).filter((id) => !frozen.has(id));

  if (violatorIds.length === 0) {
    // Mirrors `reflowExisting`'s identical guard (schedule.ts): the placement
    // service's wire refuses a request naming zero movable fixtures
    // ("fixtures must not be empty", `schema.py` — no log call on that
    // branch, unlike its siblings). Reachable whenever every fixture a
    // blocking conflict names is ALSO pinned (two fixtures the model was
    // told never to move, already clashing on the board this run started
    // from) — a pre-existing board defect, not a hypothetical, and not this
    // module's to fix: nothing here may move a pinned fixture.
    return {
      assignments: [...input.board],
      movedFixtureIds: [],
      unresolvedFixtureIds: [],
      telemetry: { solver_ran: false, fallback: "unrepaired" },
    };
  }

  // A violator this pack's own model report never gave a slot at all — the
  // decomposed driver works over CURRENT PLACEMENTS (`repairComponents`
  // builds its graph from `Assignment[]`, matching `repairDecomposed`'s own
  // z3-era contract), so a fixture with no row in `board` is structurally
  // invisible to it, not merely un-attempted. Never silently dropped: folded
  // into `unresolvedFixtureIds` directly, same hand-off the LLM round always
  // got for this shape.
  const boardIds = new Set(input.board.map((a) => a.fixtureId));
  const unplacedViolators = violatorIds.filter((id) => !boardIds.has(id));

  const startedAt = Date.now();
  let out: DecomposedRepairResult;
  try {
    out = await repairDecomposedCpsat({
      fixtures: input.fixtures,
      proposal: input.board,
      callerFrozen: frozen,
      existing: input.existing,
      dependencies: input.dependencies,
      config: input.config,
      budgetMs: input.budgetMs ?? solverBudgetMs(),
    });
  } catch {
    // Every throw lands here — the driver's own "I produced a schedule my
    // own verifier rejects" alarm (an impossible event, loud in the
    // engine's own tests). Silent for the organiser: the LLM repairs the
    // board exactly as it did before this wave, and telemetry records that
    // the solver blew up.
    return {
      assignments: null,
      movedFixtureIds: [],
      unresolvedFixtureIds: [],
      telemetry: { solver_ran: true, ms: Date.now() - startedAt, fallback: "error" },
    };
  }
  const ms = Date.now() - startedAt;

  // NO RECONCILIATION STEP HERE — unlike the C5 (single `buildSchedule`
  // call) shape this replaces, `repairDecomposedCpsat` already guarantees
  // every frozen id's slot is exactly `board`'s, verified internally before
  // it ever returns (its own doc comment: a caller-frozen fixture is never
  // a decision variable in the first place, not merely reconciled after).
  const assignments = out.assignments;

  const violatorSet = new Set(violatorIds);
  // `out.moved`/`out.unresolvedFixtureIds` cover every fixture in `proposal`
  // (`input.board`) — narrowed to violators for wire parity with the
  // pre-C9 contract ("Violator fixtures ..."), and because a component that
  // is entirely caller-frozen but self-contradictory can appear in
  // `unresolvedFixtureIds` too (a pre-existing board defect this module has
  // never been able to fix — see `repairDecomposedCpsat`'s own handling).
  const movedFixtureIds = [...out.moved].filter((id) => violatorSet.has(id)).sort();
  const unresolvedFixtureIds = [
    ...new Set([
      ...out.unresolvedFixtureIds.filter((id) => violatorSet.has(id)),
      ...unplacedViolators,
    ]),
  ].sort();

  const status: SolverRepairStatus =
    unresolvedFixtureIds.length > 0 ? (movedFixtureIds.length > 0 ? "partial" : "unrepaired") : "repaired";
  const timedOut = out.components.some((c) => c.skipReason === "budget_exhausted");
  const fallback: SolverFallback | undefined =
    status === "repaired" ? undefined : status === "unrepaired" && timedOut ? "budget" : status;

  const componentsSolved = out.components.filter(
    (c) => c.outcome === "clean" || c.outcome === "repaired",
  ).length;
  const componentsSkipped = out.components.length - componentsSolved;

  return {
    assignments,
    movedFixtureIds,
    unresolvedFixtureIds,
    telemetry: {
      solver_ran: true,
      status,
      moved: movedFixtureIds.length,
      ms,
      unresolved: unresolvedFixtureIds.length,
      residual: out.residual.length,
      ...(status === "repaired" ? { minimality: out.minimality.verdict } : {}),
      ...(out.components.length > 0 ? { components_solved: componentsSolved, components_skipped: componentsSkipped } : {}),
      ...(timedOut ? { timed_out: true } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
    },
  };
}

/**
 * Fold the solver's moves back into the model's plan.
 *
 * Only `scheduled_at` and `court_label` change, and only for fixtures the solver
 * actually moved: an assignment the solver left alone keeps the model's own
 * rendering byte for byte, so a diff between the two boards shows the repair and
 * nothing else.
 *
 * `renderIso` is injected rather than imported to keep this module free of a
 * cycle with the runners that own the zone-aware renderer.
 */
export function applySolverMoves<P extends { assignments: { fixture_id: string; scheduled_at: string; court_label: string }[] }>(
  plan: P,
  repaired: readonly Assignment[],
  movedIds: readonly string[],
  renderIso: (instantMs: number) => string,
): P {
  if (movedIds.length === 0) return plan;
  const moved = new Set(movedIds);
  const byId = new Map(repaired.map((a) => [a.fixtureId, a]));
  return {
    ...plan,
    assignments: plan.assignments.map((a) => {
      if (!moved.has(a.fixture_id)) return a;
      const to = byId.get(a.fixture_id);
      if (to === undefined) return a;
      return { ...a, scheduled_at: renderIso(to.startAt), court_label: to.court };
    }),
  };
}
