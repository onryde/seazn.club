// Decomposed repair on CP-SAT (C9, z3 retirement design, following stage B/C5).
//
// C5 replaced the AI repair round's z3 `repairDecomposed` call with a SINGLE
// monolithic `buildSchedule` call ("pin what stands, re-solve the violators" —
// every fixture not named by a blocking conflict frozen, the rest handed to
// the placement CP-SAT service in one request). That regressed two ways,
// both measured (`packages/engine/scripts/bench-ai-repair-cpsat.ts`,
// `scripts/repro-ai-bracket-frozen-feeder.ts`):
//
//   1. DENSITY. CP-SAT does not reliably solve a dense violator set as one
//      monolithic call — at ~60% violator density it exhausts a 45s budget
//      and `buildSchedule` falls back to its own internal greedy, which does
//      not avoid the injected clashes.
//   2. THE FROZEN-FEEDER STRADDLE. `buildSchedule`'s wire construction
//      (`build.ts`'s `solveBuild`) turns every `frozen`-listed id into a
//      fixed `existing` row and DROPS it from the movable `fixtures` array —
//      and its dependency-forwarding filter
//      (`dependencies.filter(d => freeFixtureIds.has(d.fixtureId) &&
//      freeFixtureIds.has(d.dependsOn))`) silently discards any edge with
//      EXACTLY ONE end in that now-immovable set. REFLOW never hits this
//      (it freezes every already-placed card uniformly, so a dependency edge
//      is always fully inside or fully outside the frozen set); C5's
//      violator-derived freeze is the first caller that can hand
//      `buildSchedule` an edge with exactly one end frozen — a free violator
//      depending on a frozen non-violator.
//
// This file is the fix for both: decompose FIRST, the way `repairDecompose.ts`
// already does for z3, then solve each component with `buildSchedule` instead
// of z3's `repairSchedule`.
//
// `repairComponents()`/`dayCapGuard()` (`repair-decompose.ts`) are reused
// UNCHANGED — solver-agnostic by construction (verified: the only z3-specific
// code in that file is the `repairSchedule()` call itself and its mandatory
// `resetZ3()`, neither of which this driver touches). So is
// `disjointConflictBound()` (`repair-minimality.ts`) — a pure combinatorial
// lower bound over the ORIGINAL board's conflicts, unrelated to which solver
// produced the answer.
//
// WHAT DOES NOT WORK, MEASURED, NOT ASSUMED: passing a caller-frozen
// non-violator as a genuinely movable `fixtures` entry (so its dependency
// edges survive `freeFixtureIds`) was the first design tried here. It does
// keep the dependency edge — but `buildSchedule`'s own objective ladder
// (`days`/`day_span`/`day_start`/`idle_gap`/`imbalance`) actively REWARDS
// compactness with nothing anchoring a fixture to `current`, so a frozen
// feeder with any slack before it gets pulled EARLIER even though nothing
// requires it to move — measured directly against the real placement
// service: a lone feeder with 60 minutes of window slack ahead of it was
// relocated a full hour with zero other fixtures in play. Reconciling
// (discarding the whole component when a frozen member came back moved)
// would then discard almost every component with any slack at all — the
// opposite of what decomposition is for. So this driver does NOT do that.
//
// WHAT ACTUALLY CLOSES THE STRADDLE: every caller-frozen member of a
// component is passed to `buildSchedule` EXACTLY as C5 already does —
// folded into `existing`, at its own fixed position, never a `fixtures`
// entry — so it is structurally incapable of drifting. This reproduces the
// dependency-drop bug (the frozen feeder's edge is filtered off the wire,
// same as the monolithic call). What decomposition adds is the CLOSED
// WORLD: because `repairComponents` already unions on every `dependencies`
// edge (`repair-decompose.ts:309-313`), a violator whose only remaining
// blocking conflict is `order_before_feeder` against a frozen member of ITS
// OWN component is a fully self-contained, fully-known problem — the
// feeder's position is FIXED and already in hand, so "starts far enough
// after the feeder" is answerable without any solver at all. `nudgeForward`
// (below) answers it: a plain ascending grid search over
// `validateAssignments` — the real verifier, never a guess — that moves
// ONLY the violator, never the feeder. This is deliberately narrow: it never
// fires unless every residual blocking conflict on the component is exactly
// this shape, and it is verified again, in full, before anything commits.
//
// A CALLER-FROZEN FIXTURE THEREFORE NEVER APPEARS MOVED, STRUCTURALLY, not
// merely by convention — it is never a `buildSchedule` decision variable and
// `nudgeForward` never touches one either.
//
// A GENUINE, SEPARATE LIMIT THIS DRIVER DOES NOT CLOSE — reported, not
// engineered around: a TBD bracket slot (`SchedulableFixture` with neither
// `home` nor `away` — `home_entrant_id`/`away_entrant_id` both null) carries
// its POSSIBLE participants only in `people`, and the placement wire
// (`placement-client.ts`) never forwards `people` at all, only
// `entrantIds` derived from `home`/`away`. Two TBD siblings that share
// `people` but not `entrantIds` are therefore invisible to CP-SAT's own
// participant-overlap encoding no matter how they are decomposed — and
// `services/placement/src/placement/schema.py` refuses ANY fixture with
// empty `entrant_indices` outright (`INVALID_REQUEST`, silently — no log
// line on that branch), so `buildSchedule` is never even reached for a
// component containing one. Confirmed directly against the real placement
// service and the exact scenario `scripts/repro-ai-bracket-frozen-feeder.ts`
// exercises (both TBD fixtures reach the service with `entrant_indices`
// empty and the whole request is rejected `INVALID_REQUEST` before any
// solve): this is why the third-place-playoff/two-decided-semis scenario
// still cannot be repaired by this driver, DIFFERENT FROM AND IN ADDITION TO
// the straddle above — closing it needs the wire to carry a `people`-shaped
// NoOverlap concept the Python model does not have today, which is a wire
// protocol change touching `packages/engine/src/scheduling/placement-client.ts`
// AND `services/placement/**`, well outside this task's file set. See the C9
// PR body for the full account. `solveBoard` still handles this shape
// SAFELY — every path here either commits a component this driver has
// independently re-verified, or leaves it unresolved; no illegal board is
// ever produced or reported repaired.
import {
  effectiveHard,
  effectiveRestMinutes,
  isBlockingConflict,
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type VerifyConfig,
} from "./calendar.ts";
import { gridStepMinutes } from "./grid-step.ts";
import { disjointConflictBound } from "./repair-minimality.ts";
import {
  dayCapGuard,
  repairComponents,
  type ComponentOutcome,
  type ComponentSkipReason,
  type DecomposedRepairResult,
  type DecomposedRepairStatus,
  type DecompositionMode,
  type DecompositionModeReason,
  type MinimalityCaveat,
  type RepairComponent,
  type RepairComponentReport,
} from "./repair-decompose.ts";
import { buildSchedule, type BuildInput } from "./build.ts";

/**
 * The largest component this driver will attempt, in fixtures (violators and
 * swept-in non-violators together).
 *
 * MEASURED against the real placement service (`packages/engine/scripts/
 * bench-ai-repair-cpsat.ts`'s third arm), NOT inherited from z3's
 * `COMPONENT_MOVABLE_LIMIT` (50) — that number came off z3's WASM curve ("40
 * movable 8.2s, 60 movable 43.8s, 80 never returns") and CP-SAT over a remote
 * gRPC call has a different cost shape entirely. See the PR body for the
 * curve this was set from.
 */
export const CPSAT_COMPONENT_MOVABLE_LIMIT = 40;

/**
 * Wall-clock ceiling on ONE component's `buildSchedule` call. Its own number,
 * not a reuse of `DEFAULT_COMPONENT_BUDGET_MS` (z3's) or `solverBudgetMs()`
 * (the whole-call web budget) — same reasoning `repair-decompose.ts`'s own
 * constant gives for why a shared meaning is how a budget silently drifts.
 */
export const DEFAULT_CPSAT_COMPONENT_BUDGET_MS = 10_000;

/**
 * Wall-clock ceiling on a whole decomposed call. A TERMINATION bound, not a
 * latency target — same role as z3's `DEFAULT_DECOMPOSED_BUDGET_MS`. Callers
 * on an HTTP path (`solveBoard`) pass their own, smaller `budgetMs`; the
 * anytime property means a smaller budget returns a PARTLY repaired board.
 */
export const DEFAULT_DECOMPOSED_CPSAT_BUDGET_MS = 60_000;

export interface DecomposedCpsatRepairInput {
  /** Every fixture this call may place — the FULL set the caller's pack
   *  covers, `callerFrozen` ids included. `buildSchedule` needs the
   *  schedulable shape (home/away/people/...); `proposal` alone
   *  (`Assignment[]`) cannot carry it. */
  fixtures: readonly SchedulableFixture[];
  /** Where every fixture in `fixtures` sits right now. Same role as
   *  `repairDecomposed`'s `proposal`: the graph, the verifier and the
   *  reconciliation baseline are all built from this. */
  proposal: readonly Assignment[];
  /** Ids in `fixtures` that must NEVER appear moved in the result — this
   *  pack's own pins union every fixture the caller's own verifier did NOT
   *  name in a blocking conflict ("pin what stands, re-solve the violators",
   *  z3 retirement design stage B). Determines two things: which components
   *  are dirty (a component with every member in this set is already fine
   *  and is never touched, matching `repairDecomposed`'s own "nothing on
   *  this island is in conflict" fast path), and — inside a dirty component —
   *  which members are ever a `buildSchedule` decision variable (never these;
   *  see the module doc comment for why they are folded into `existing`
   *  instead, same as C5's monolithic call). */
  callerFrozen: ReadonlySet<string>;
  /** External immovable occupancy — other divisions, blackouts. Never
   *  includes anything named in `fixtures`. */
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  config: BuildInput["config"];
  /** Default `DEFAULT_DECOMPOSED_CPSAT_BUDGET_MS`. */
  budgetMs?: number;
  /** Default `DEFAULT_CPSAT_COMPONENT_BUDGET_MS`. */
  componentBudgetMs?: number;
  /** Default `CPSAT_COMPONENT_MOVABLE_LIMIT`. */
  componentLimit?: number;
  /** Fires once per component, in solve order. */
  onComponent?: (report: RepairComponentReport) => void;
}

const hasDayCap = (config: VerifyConfig): boolean =>
  effectiveHard(config).some((h) => h.type === "max_fixtures_per_day");

function report(
  component: RepairComponent,
  frozen: number,
  outcome: ComponentOutcome,
  skipReason?: ComponentSkipReason,
): RepairComponentReport {
  const base: RepairComponentReport = {
    index: component.index,
    size: component.fixtureIds.length,
    frozen,
    fixtureIds: component.fixtureIds,
    outcome,
    // Neither CP-SAT concept exists on this path: `buildSchedule` has no
    // relaxable-family mechanism (that is `repairSchedule`'s own
    // `REPAIR_FAMILIES` walk) and reports no SAT-solver check count. Kept as
    // fields on `RepairComponentReport` for wire parity with the z3 driver
    // (`RepairReport`'s `checks`/`relaxed` are additive-optional on the
    // wire), always empty/zero here.
    k: 0,
    moved: [],
    checks: 0,
    elapsedMs: 0,
    relaxed: [],
  };
  if (skipReason !== undefined) base.skipReason = skipReason;
  return base;
}

const MS_PER_MIN = 60_000;

/** How far forward `nudgeForward` will search, in grid ticks, before giving
 *  up. Bounded, not unbounded: a component this driver could not otherwise
 *  place has no business spinning forever — `budgetMs`/`componentBudgetMs`
 *  already own the wall-clock ceiling, this owns the search-space one. 500
 *  ticks at the coarsest realistic step (5 minutes, `GRID_FLOOR_MINUTES`) is
 *  41+ hours of lookahead on every configured court — generous for a single
 *  dependency floor, which is normally minutes away, not days. */
const NUDGE_MAX_TICKS = 500;

/**
 * A small, targeted local search for exactly one shape: a violator whose
 * ONLY remaining blocking conflict, after `buildSchedule`'s own solve, is an
 * `order_before_feeder` breach against a caller-frozen fixture in the SAME
 * component. `buildSchedule`'s wire has no way to encode "starts after a
 * fixed, immovable instant" (see the module doc comment) — but the feeder's
 * position is fully known and never moves, so the floor is a plain number,
 * and finding a legal slot after it is an ordinary forward search, not a
 * fresh solve. The real verifier (`validateAssignments`) is the only judge;
 * nothing here trusts a computed slot without asking it.
 *
 * Tries every configured court at each grid tick, ascending in time from
 * `floorMs`, up to `NUDGE_MAX_TICKS`. Returns `null` — never a guess — when
 * nothing legal turns up in that budget; the caller leaves the component
 * unresolved, exactly as an infeasible or timed-out one already does.
 */
function nudgeForward(
  fixtureId: string,
  fx: SchedulableFixture,
  floorMs: number,
  durationMs: number,
  config: DecomposedCpsatRepairInput["config"],
  background: readonly Assignment[],
  dependencies: readonly OrderDependency[],
): Assignment | null {
  const stepMs = gridStepMinutes(config.matchMinutes, config.gapMinutes) * MS_PER_MIN;
  const start0 = Math.ceil(floorMs / stepMs) * stepMs;
  for (let tick = 0; tick < NUDGE_MAX_TICKS; tick++) {
    const startAt = start0 + tick * stepMs;
    for (const court of config.courts) {
      const candidate: Assignment = {
        fixtureId,
        court,
        startAt,
        endAt: startAt + durationMs,
        entrants: [fx.home, fx.away].filter((e): e is string => e !== undefined),
        people: [...(fx.people ?? [])],
        ...(fx.poolId !== undefined ? { poolId: fx.poolId } : {}),
        ...(fx.divisionId !== undefined ? { divisionId: fx.divisionId } : {}),
      };
      const conflicts = validateAssignments([candidate], config, background, dependencies).filter(
        isBlockingConflict,
      );
      if (conflicts.length === 0) return candidate;
    }
  }
  return null;
}

/**
 * Repairs a board component by component, each solved with `buildSchedule`,
 * committing as it goes, and verifies whatever it produced before returning
 * it.
 *
 * Never throws on exhaustion — a budget that runs out is a `partial` or
 * `unrepaired` result the caller falls back to LLM repair on. Throws in
 * exactly one case: the board it produced disagrees with the real verifier,
 * an impossible event that must be loud rather than shipped (same contract
 * `repairDecomposed` makes — see `RepairVerificationError` there; this driver
 * raises a plain `Error` instead of importing that z3-named class, since
 * nothing about the shape is z3-specific and this file owes no compile-time
 * coupling to `repair.ts`).
 *
 * SEQUENTIAL, one component at a time, one `buildSchedule` call per component
 * — never parallel. `build.ts:1196` still wraps every `buildSchedule` call in
 * the process-wide `withZ3LockAndReset` mutex (its own comment: the lock
 * "buys this call NOTHING correctness-wise" on the placement path but stays
 * because removing it is REFLOW's call too and the throughput cost is
 * unmeasured); parallel dispatch is a separate, benched task that has to
 * settle that question first.
 */
export async function repairDecomposedCpsat(
  input: DecomposedCpsatRepairInput,
): Promise<DecomposedRepairResult> {
  // `performance.now()`: ambient wall-clock reads are banned engine-wide
  // (scripts/engine-boundary.ts).
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { config, proposal, fixtures, callerFrozen } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const budgetMs = input.budgetMs ?? DEFAULT_DECOMPOSED_CPSAT_BUDGET_MS;
  const componentBudgetMs = input.componentBudgetMs ?? DEFAULT_CPSAT_COMPONENT_BUDGET_MS;
  const componentLimit = input.componentLimit ?? CPSAT_COMPONENT_MOVABLE_LIMIT;
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  // A board that already verifies is answered without ever calling the
  // placement service.
  const pre = validateAssignments(proposal, config, existing, dependencies);
  if (pre.length === 0) {
    return {
      status: "clean",
      assignments: [...proposal],
      moved: [],
      k: 0,
      elapsedMs: elapsed(),
      checks: 0,
      relaxed: [],
      components: [],
      unresolvedFixtureIds: [],
      minimality: { verdict: "proved", k: 0, lowerBound: 0, witnesses: [], caveats: [] },
      mode: "components",
      residual: [],
    };
  }

  const modeReason: DecompositionModeReason | null = dayCapGuard(proposal, config);
  const mode: DecompositionMode = modeReason === null ? "components" : "whole_board";
  const components: RepairComponent[] =
    mode === "components"
      ? repairComponents({ proposal, dependencies, config })
      : [
          {
            index: 0,
            fixtureIds: [...proposal]
              .map((a) => a.fixtureId)
              .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          },
        ];

  const board = new Map(proposal.map((a) => [a.fixtureId, a]));
  const reports: RepairComponentReport[] = [];
  const resolved = new Set<string>();

  for (const component of components) {
    const ids = component.fixtureIds;
    const own = new Set(ids);
    // Dirty means "names a violator" — a fixture the CALLER's own verifier
    // did not pin and did not clear, per "pin what stands, re-solve the
    // violators". Deliberately NOT re-derived from a fresh
    // `validateAssignments` pass over the whole proposal (what
    // `repairDecomposed` does): the caller's blocking-conflict computation is
    // the one this driver is answering, and re-deriving it here — over
    // possibly a different (merged vs. per-division) config — would let a
    // component move a fixture the caller never asked this round to touch.
    const dirty = ids.some((id) => !callerFrozen.has(id));
    if (!dirty) {
      // Every member is caller-frozen, so this driver may not move any of
      // them — but "nothing to solve" is not the same fact as "nothing
      // wrong": two ALREADY-pinned fixtures can themselves contradict each
      // other (a pre-existing board defect, not this round's to fix — same
      // shape `solveBoard`'s own "every violator is also pinned" fast path
      // documents). `pre` (computed once, over the untouched proposal) is
      // the honest source for whether that is true HERE, never a fresh
      // `resolved`-then-hope: marking a genuinely conflicted island
      // "resolved" would make the anytime check below throw on a component
      // this driver correctly declined to touch.
      const preExisting = pre.some((c) => own.has(c.fixtureId) && isBlockingConflict(c));
      if (preExisting) {
        reports.push(report(component, 0, "infeasible"));
      } else {
        for (const id of ids) resolved.add(id);
        reports.push(report(component, 0, "clean"));
      }
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }

    const violatorIds = ids.filter((id) => !callerFrozen.has(id));
    const frozenIdsInComponent = ids.filter((id) => callerFrozen.has(id));
    const frozenMembers = frozenIdsInComponent.map((id) => board.get(id)!);

    // THE REST OF THE BOARD, at its current placement: the caller's own
    // `existing`, every OTHER component, AND every caller-frozen member of
    // THIS component — all folded into `existing`, never `fixtures`, exactly
    // as C5's monolithic call already does. `frozenMembers` join the
    // background here specifically so they are structurally incapable of
    // being a `buildSchedule` decision variable at all (see the module doc
    // comment on why "genuinely movable, verified after" was tried and
    // rejected).
    const outsideComponent = proposal.flatMap((a) =>
      own.has(a.fixtureId) ? [] : [board.get(a.fixtureId)!],
    );
    const trueBackground: Assignment[] = [...existing, ...outsideComponent];
    const background: Assignment[] = [...trueBackground, ...frozenMembers];

    if (mode === "components" && ids.length > componentLimit) {
      reports.push(report(component, background.length, "skipped", "over_component_limit"));
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }
    const remaining = budgetMs - elapsed();
    if (remaining <= 0) {
      reports.push(report(component, background.length, "skipped", "budget_exhausted"));
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }

    // Only violators are ever a `buildSchedule` decision variable. This
    // reproduces the wire's own dependency-drop for any edge touching a
    // frozen member (the same gap C5's monolithic call has) — closed below,
    // narrowly, by `nudgeForward`, not by pretending the wire encoded it.
    const movableFixtures = violatorIds.map((id) => fixtureById.get(id)!);
    const currentForComponent = violatorIds.map((id) => board.get(id)!);
    const startedAt = elapsed();
    const thisBudget = mode === "whole_board" ? remaining : Math.min(componentBudgetMs, remaining);

    let out;
    try {
      out = await buildSchedule({
        fixtures: movableFixtures,
        config,
        existing: background,
        dependencies,
        current: currentForComponent,
        wallMs: thisBudget,
      });
    } catch {
      // `buildSchedule` itself never throws in production use (every path
      // inside it is caught) — this guards a test double or a future
      // regression, not a documented behaviour. Treated as an infeasible
      // component: this driver never adopts a candidate it cannot verify.
      reports.push({ ...report(component, background.length, "infeasible"), elapsedMs: elapsed() - startedAt });
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }
    const componentElapsed = elapsed() - startedAt;

    // The candidate for THIS component's VIOLATORS alone — frozen members
    // are never part of the candidate; they stay at `board.get(id)`
    // unconditionally, so there is no drift to check for.
    const candidateById = new Map(out.assignments.map((a) => [a.fixtureId, a] as const));
    let violatorCandidates = violatorIds.map((id) => candidateById.get(id) ?? board.get(id)!);
    let componentBoard = [...violatorCandidates, ...frozenMembers];

    // LOCAL VERIFICATION before ever committing — the same discipline
    // `repairDecomposed` applies at the end of the WHOLE call, applied per
    // component here because `buildSchedule`'s fallback exits (already
    // optimal, verifier-rejected, not-searched, solver-unavailable/-busy) all
    // return an unpinned greedy board that may or may not actually be legal
    // against this component's own background — never trusted blindly.
    let localConflicts = validateAssignments(componentBoard, config, trueBackground, dependencies).filter(
      (c) => own.has(c.fixtureId) && isBlockingConflict(c),
    );

    if (localConflicts.length > 0) {
      // THE NUDGE — narrow on purpose. Fires only when EVERY residual
      // blocking conflict is a violator's `order_before_feeder` breach
      // against a frozen member of this same component (never on a frozen
      // member itself — those are never candidates for adjustment). Any
      // other residual shape (a genuine court/person clash among violators,
      // a rest breach, anything `buildSchedule` simply could not place in
      // budget) is left as `infeasible`/`timeout`, unresolved, exactly as
      // before this driver existed.
      const frozenSet = new Set(frozenIdsInComponent);
      const nudgeable =
        localConflicts.length > 0 &&
        localConflicts.every(
          (c) =>
            violatorIds.includes(c.fixtureId) &&
            c.reason === "order" &&
            c.details?.otherFixtureId !== undefined &&
            frozenSet.has(c.details.otherFixtureId),
        );

      if (nudgeable) {
        const byViolator = new Map<string, Conflict[]>();
        for (const c of localConflicts) {
          const list = byViolator.get(c.fixtureId);
          if (list === undefined) byViolator.set(c.fixtureId, [c]);
          else list.push(c);
        }
        let nudgedBoard = [...componentBoard];
        let allNudged = true;
        for (const [violatorId, cs] of byViolator) {
          const row = nudgedBoard.find((a) => a.fixtureId === violatorId)!;
          const floorMs = Math.max(
            ...cs.map((c) => {
              const feeder = board.get(c.details!.otherFixtureId!)!;
              return feeder.endAt + effectiveRestMinutes(config, row) * MS_PER_MIN;
            }),
          );
          const durationMs = row.endAt - row.startAt;
          const others = nudgedBoard.filter((a) => a.fixtureId !== violatorId);
          const nudged = nudgeForward(
            violatorId,
            fixtureById.get(violatorId)!,
            floorMs,
            durationMs,
            config,
            [...trueBackground, ...others],
            dependencies,
          );
          if (nudged === null) {
            allNudged = false;
            break;
          }
          nudgedBoard = nudgedBoard.map((a) => (a.fixtureId === violatorId ? nudged : a));
        }
        if (allNudged) {
          const afterNudge = validateAssignments(nudgedBoard, config, trueBackground, dependencies).filter(
            (c) => own.has(c.fixtureId) && isBlockingConflict(c),
          );
          if (afterNudge.length === 0) {
            componentBoard = nudgedBoard;
            violatorCandidates = violatorIds.map((id) => nudgedBoard.find((a) => a.fixtureId === id)!);
            localConflicts = [];
          }
        }
      }
    }

    if (localConflicts.length > 0) {
      const outcome: ComponentOutcome = out.status === "infeasible" ? "infeasible" : "timeout";
      reports.push({ ...report(component, background.length, outcome), elapsedMs: componentElapsed });
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }

    for (const a of violatorCandidates) board.set(a.fixtureId, a);
    for (const id of ids) resolved.add(id);
    const movedHere = violatorIds
      .filter((id) => {
        const before = proposal.find((a) => a.fixtureId === id)!;
        const after = board.get(id)!;
        return before.court !== after.court || before.startAt !== after.startAt;
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    reports.push({
      ...report(component, background.length, movedHere.length > 0 ? "repaired" : "clean"),
      k: movedHere.length,
      moved: movedHere,
      elapsedMs: componentElapsed,
    });
    input.onComponent?.(reports[reports.length - 1]!);
  }

  const assignments = proposal.map((a) => board.get(a.fixtureId) ?? a);
  const moved: string[] = [];
  for (const a of proposal) {
    const now = board.get(a.fixtureId)!;
    if (now.startAt !== a.startAt || now.court !== a.court) moved.push(a.fixtureId);
  }
  moved.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

  // ANYTIME MEANS VERIFIED, NOT MERELY RETURNED — same invariant
  // `repairDecomposed` asserts. A conflict on a component reported resolved
  // is this driver and the real verifier disagreeing, which must be loud.
  const after = validateAssignments(assignments, config, existing, dependencies);
  const offending = after.filter((c) => resolved.has(c.fixtureId) && isBlockingConflict(c));
  const unresolved = reports.filter((r) => r.outcome !== "clean" && r.outcome !== "repaired");
  const unresolvedCount = unresolved.length;
  const unresolvedFixtureIds = unresolved
    .flatMap((r) => [...r.fixtureIds])
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const repairedCount = reports.filter((r) => r.outcome === "repaired").length;
  const status: DecomposedRepairStatus =
    unresolvedCount === 0 ? "repaired" : repairedCount > 0 ? "partial" : "unrepaired";

  const caveats: MinimalityCaveat[] = [];
  if (mode === "components" && components.length > 1 && hasDayCap(config)) {
    caveats.push("day_cap_order_dependent");
  }
  if (unresolvedCount > 0) caveats.push("components_unresolved");

  const bound = disjointConflictBound({ proposal, existing, dependencies, config, conflicts: pre });
  const result: DecomposedRepairResult = {
    status,
    assignments,
    moved,
    k: moved.length,
    elapsedMs: elapsed(),
    checks: 0,
    relaxed: [],
    components: reports,
    unresolvedFixtureIds,
    minimality: {
      verdict:
        status === "repaired" && caveats.length === 0 && moved.length === bound.lowerBound
          ? "proved"
          : "upper_bound",
      k: moved.length,
      lowerBound: bound.lowerBound,
      witnesses: bound.witnesses,
      caveats,
    },
    mode,
    residual: after,
  };
  if (modeReason !== null) result.modeReason = modeReason;

  if (offending.length > 0) {
    throw new Error(
      `decomposed CP-SAT repair produced a schedule its own verifier rejects: ${offending.length} conflict(s): ` +
        offending.map((c) => `${c.fixtureId}:${c.reason}`).join(", "),
    );
  }
  return result;
}
