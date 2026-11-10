import "server-only";
import { log } from "@/server/logger";
import {
  boardMetrics,
  validateAssignments,
  type Assignment,
  type BuildResult,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { placementSolver, schedulerLog } from "@seazn/scheduler";
import { autoBuildSchedule, fallbackBoard } from "../schedule-solver-rest";
import { autoSolverWallMs } from "./solver-tuning";

/**
 * REFLOW (C4, 2026-08-14 — z3 retirement stage A): routed through the same
 * placement CP-SAT service BUILD/POLISH already call, instead of z3's
 * ascending-k repair solver. `pinned` (schedule-locked) and `placed`
 * (already on the board, just not locked) are BOTH frozen for this solve —
 * the exact mechanism POLISH already uses (R20, `BuildInput.frozen` +
 * `current`, resolved by `publishedSlotOf` in `build.ts`) — because
 * `buildSchedule` has no "fewest cards moved" term of its own the way the
 * repair solver's ascending-k walk did; pinning every already-placed card is
 * what makes this mode keep that property without one. Owner's ruling on a
 * design gap this session found beyond the brief's literal "wiring" framing
 * — see the C4 status-log entry in
 * `docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md`.
 *
 * TRADE-OFF, explicitly accepted: REFLOW can no longer rearrange
 * already-placed UNLOCKED cards to resolve a conflict that exists AMONG
 * them — it can only place cards that have no slot yet, around everything
 * already placed. `repairSchedule` could do this (moving one of a colliding
 * pair); `buildSchedule` cannot, because neither `pinned` nor `placed` is
 * ever a free variable here. Proven non-crashing rather than assumed —
 * `schedule-reflow-cpsat.test.ts`'s two-card-collision case.
 *
 * RECONCILIATION BELOW IS NOT REDUNDANT PLUMBING, and that was measured, not
 * assumed. `buildSchedule`'s SUCCESS/`improved` exit anchors a `current`-only
 * frozen id correctly (its own `pinnedAssignments`), but every FALLBACK exit
 * — `already_optimal`, a proved tie that does not disturb `current` less
 * (engine 6.0.2), `verifier_rejected`, `not_searched` —
 * reports `seed.assignments`, the PLAIN unpinned greedy seed, which has no
 * idea a `current`-only id (no `.locked`) is supposed to stay put. Confirmed
 * empirically against unmodified `build.ts`: a two-fixture repro, both
 * `current`-anchored, mocked onto the `already_optimal` fallback, swapped
 * both fixtures' courts. That fallback is not a corner — it is the ORDINARY
 * shape of a reflow over a mostly-already-placed board (nothing to improve,
 * or the budget does not prove an improvement), so every frozen id's slot in
 * the board this function returns is read from `known` directly below,
 * never trusted off `buildSchedule`'s own `assignments`. And restoring the
 * frozen cards alone is not always enough: the seed chose the FREE cards'
 * slots around the wrong positions, so when it moved a frozen card the board
 * placed around the real slots is built too and the better of the two kept
 * (`fallbackBoard`, #1143, ruling D30).
 */
/** A `BuildResult` plus the one fact only the REFLOW path is in a position to
 *  know: how many of `moved` were cards it placed for the first time rather than
 *  relocated. See `ScheduleSolverInfo.seeded` for why it is carried. */
export type ReflowResult = BuildResult & { seeded: number };

export async function reflowExisting(args: {
  schedulable: readonly SchedulableFixture[];
  /** Where the cards this run may move sit right now. */
  placed: readonly Assignment[];
  /** Cards this run may NOT move — obstacles to the solver, still part of the
   *  proposal it hands back. */
  pinned: readonly Assignment[];
  config: SlotConfig & VerifyConfig & { courts: string[] };
  board: readonly Assignment[];
  /** The division's direct feed edges — threaded to both `buildSchedule` and
   *  the fresh verifier pass below (see `AutoSchedulePlan.dependencies`). */
  dependencies: readonly OrderDependency[];
}): Promise<ReflowResult> {
  const startedAt = Date.now();
  const total = args.schedulable.length;
  /** Every card this run may not move, keyed by id — `placed` first so a
   *  fixture appearing in both (should never happen; `placed`/`pinned` are
   *  constructed as a partition upstream) resolves to its locked slot. */
  const known = new Map<string, Assignment>([
    ...args.placed.map((a) => [a.fixtureId, a] as const),
    ...args.pinned.map((a) => [a.fixtureId, a] as const),
  ]);
  const frozen = [...known.keys()];

  // A THIRD finding, beyond the reconciliation gap above: the placement
  // service's own wire contract refuses a request naming ZERO movable
  // fixtures ("fixtures must not be empty", `schema.py`) — silently, on a
  // validation branch that (unlike its siblings) carries no log call, so
  // this was found by reading the service's own source, not a log line.
  // Measured against the real service: `solveBuild` resolves (no
  // exception `buildSchedule`'s own catch would report) with
  // `status: "ERROR"`, which `buildSchedule` maps to `solver_unavailable`
  // — indistinguishable, from this caller's side, from a genuine outage.
  //
  // A reflow with nothing left to place — every schedulable fixture
  // already frozen — is the ORDINARY shape of "click Re-flow a second
  // time, nothing changed", not a corner, so `buildSchedule` must never
  // be asked in the first place here. Mirrors the OLD z3-repair path's
  // `clean, k=0` verdict for the identical shape: verify the untouched
  // board directly and hand it back.
  if (![...args.schedulable].some((f) => !known.has(f.id))) {
    const assignments = [...known.values()];
    return {
      assignments,
      conflicts: validateAssignments(assignments, args.config, args.board, args.dependencies),
      metrics: boardMetrics(assignments, args.config.courts, total),
      engine: "greedy",
      status: "ok",
      tiersCompleted: 0,
      budgetExpired: false,
      elapsedMs: Date.now() - startedAt,
      moved: 0,
      seeded: 0,
      rlimitSpent: 0,
      lnsWindowRlimits: [],
      lost: 0,
    };
  }

  const input: Parameters<typeof autoBuildSchedule>[0] = {
    fixtures: args.schedulable,
    config: args.config,
    existing: args.board,
    dependencies: args.dependencies,
    wallMs: autoSolverWallMs(),
    solve: placementSolver,
    log: schedulerLog,
    frozen,
    // Empty means "no board" to `buildSchedule` (an empty array is NOT sent
    // as one) — mirrors the BUILD/POLISH call site's identical guard on
    // `currentBoard`, and matters here for the same reason: REFLOW's
    // ordinary case is a stage with nothing on it yet at all.
    ...(known.size > 0 ? { current: [...known.values()] } : {}),
  };
  // `autoBuildSchedule`, not bare `buildSchedule`: this is the auto pass too, so
  // the pool rest goes out on the request and a solver board that breaks a
  // declared rest is refused (#452, `schedule-solver-rest.ts`).
  const out = await autoBuildSchedule(input);

  // Structured telemetry for the branch this session's finding is about: how
  // often the fallback actually NEEDED reconciling (not merely took the
  // fallback exit — the success path's own `pinnedAssignments` already
  // agrees with `known`, so this counts real corrections only). `log.warn`,
  // not `info`: a nonzero count means `buildSchedule`'s own board would have
  // silently relocated an already-placed card had this function trusted it.
  const outById = new Map(out.assignments.map((a) => [a.fixtureId, a] as const));
  const correctedCount = [...known.entries()].filter(([id, a]) => {
    const reported = outById.get(id);
    return reported === undefined || reported.court !== a.court || reported.startAt !== a.startAt;
  }).length;
  // An engine FALLBACK whose plain seed moved a known card chose every free
  // card's slot around the wrong positions: putting the known card back
  // (below) can leave a free card beside it with a rest breach or a court
  // clash, under a strip that says the board is valid (#1143). Placing the
  // free cards again around the REAL slots fixes that but can break round
  // order instead, so `fallbackBoard` — the one helper the rest guard's own
  // fallback uses — builds both and keeps the better (ruling D30). The
  // engine's verdict (`engine`, `status`, tiers) is still reported as it
  // came: only where the free cards sit can change. Never on the success
  // exit, whose board already agrees with `known` — `correctedCount` is 0
  // there by construction.
  const placedBy =
    correctedCount > 0 && out.engine !== "optimized" ? await fallbackBoard(input, out) : out;
  if (correctedCount > 0) {
    log.warn(
      { engine: out.engine, status: out.status, frozenCount: known.size, correctedCount, replaced: placedBy !== out },
      "schedule: reflow reconciled frozen cards back onto their known slots — buildSchedule's own board would have moved at least one",
    );
  }

  // THE RECONCILIATION (see the doc comment above): every frozen id's slot
  // comes from `known`, never from the engine's board, regardless of which
  // exit produced it.
  const assignments = [
    ...placedBy.assignments.filter((a) => !known.has(a.fixtureId)),
    ...known.values(),
  ];
  const presentIds = new Set(assignments.map((a) => a.fixtureId));
  const conflicts: Conflict[] = [
    ...validateAssignments(assignments, args.config, args.board, args.dependencies),
    // `validateAssignments` iterates the rows it is handed and cannot report
    // an ABSENCE, so a free fixture `buildSchedule` could not place needs
    // its diagnosis read off `out.conflicts` directly — the engine's own
    // `conflictsFor` machinery already does this better than a bare
    // `no_slot` could (greedy's diagnosis when there is one, a PROVEN
    // `no_slot` otherwise). Filtered to ids genuinely missing from the
    // RECONCILED board: a frozen id can be absent from `out.assignments` on
    // the fallback path above (its naive-seed placement disqualified for a
    // blocking conflict it would not have had at its real, reconciled slot)
    // without being absent here, and a stale row about it must not survive
    // reconciliation.
    ...placedBy.conflicts.filter((c) => !presentIds.has(c.fixtureId)),
  ];

  // Every free (non-`known`) fixture that made it onto the board is a
  // first-time placement, by construction — `known` is exactly "already has
  // a slot", so its complement never did. It is now ALSO every relocation:
  // reconciliation above means a `known` id never moves, so `moved` and
  // `seeded` are always equal (a direct, testable consequence of the
  // churn-minimization ruling — see the sibling assertion in
  // `schedule-reflow-cpsat.test.ts`).
  const seeded = assignments.filter((a) => !known.has(a.fixtureId)).length;

  return {
    assignments,
    conflicts,
    metrics: boardMetrics(assignments, args.config.courts, total),
    // Forwarded, never re-derived — `out.engine` already says where the FREE
    // fixtures' placements came from: `"optimized"` on a genuine
    // improvement, `"greedy"` on every fallback, including "nothing needed
    // placing at all" (this mode's most common shape). Exactly how
    // BUILD/POLISH already report the same field.
    engine: out.engine,
    status: out.status,
    ...(out.notSearchedReason !== undefined ? { notSearchedReason: out.notSearchedReason } : {}),
    tiersCompleted: out.tiersCompleted,
    budgetExpired: out.budgetExpired,
    elapsedMs: Date.now() - startedAt,
    moved: seeded,
    seeded,
    rlimitSpent: out.rlimitSpent,
    lnsWindowRlimits: out.lnsWindowRlimits,
    // ALWAYS 0, and now BY CONSTRUCTION rather than by measurement: `known`
    // is unioned into `assignments` unconditionally above, so a `placed` or
    // `pinned` row can never be absent from the board this function
    // returns. Was a tripwire proven live by mocking a `repairSchedule` row
    // drop (`schedule-reflow-lost.test.ts`, retired with this change —
    // `repairSchedule` is not called on this path at all any more, so that
    // file's mock is inert; see the PR body for why deleting the guard is
    // safe rather than silent).
    lost: 0,
    ...(out.contradictoryPins !== undefined ? { contradictoryPins: out.contradictoryPins } : {}),
  };
}
