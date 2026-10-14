// The engine's side of the placement boundary (engine-split spec §5.1, D11, D25). The engine decides WHAT to ask a
// solver and what to do with the answer; the caller decides HOW the question reaches one. No transport, env or secret here.
import type { BuildInput } from "./build.ts";

export interface SolveBuildInput {
  courts: string[];
  fixtures: {
    fixtureId: string;
    entrantIds: string[];
    divisionId: string;
    /** C1 (2026-08-12 round-order design). Round-robin-generated fixtures
     *  only — `build.ts` is the one place that decides whether to set this,
     *  never forwarding it for a bracket/stepladder fixture. Absent means
     *  unconstrained by round order on the service side, not round 0. */
    roundNo?: number;
    /**
     * C10 (2026-08-16, wire person indices) — person ids, straight from
     * {@link SchedulableFixture.people} — resolved through a SEPARATE index
     * space than {@link entrantIds}; see `Fixture.person_indices`'s own
     * comment in the proto for why the two must never be merged into one.
     *
     * A genuinely undecided knockout slot (a final, a third-place playoff,
     * before its feeders have resolved) has no entrants yet — `entrantIds`
     * above is `[]` — but very much has people: the players who can still
     * reach it. Omitted/`undefined` is "no people recorded for this
     * fixture", a real answer (an ordinary, fully-resolved singles fixture
     * may carry no `people` of its own at all if the caller never populated
     * it), not a refusal — the service refuses only when BOTH `entrantIds`
     * and this are empty.
     */
    people?: string[];
    /**
     * #622 (round-scoped required court tags) — the courts THIS fixture may
     * be placed on, as ids resolved through the same `courtIndexOf` table
     * {@link grid} slots use. Every id must also appear in {@link courts}, or
     * the request is refused `invalid_request` before it reaches the wire,
     * exactly as an unknown slot/pin court already is.
     *
     * Omitted/`undefined` is UNCONSTRAINED — every court in {@link courts} —
     * and is the common case: only a fixture whose division ∪ stage ∪ round
     * required tags resolve to a STRICT SUBSET of the request's court list
     * needs one. An EMPTY array is deliberately the same reading rather than
     * "no court": that is what `Fixture.allowed_court_indices` means on the
     * wire and what `candidateCourts` means by an empty required-tag list,
     * and a caller with a genuinely empty candidate set is refused earlier
     * with `NO_MATCHING_COURT` (`court-candidates.ts`'s `guardNoMatchingCourt`)
     * rather than being allowed to encode an unsolvable board here.
     */
    allowedCourts?: readonly string[];
  }[];
  /**
   * `dayIndex` is the CALLER's calendar day for the slot, resolved in the
   * ORG's timezone — not a UTC day, and not optional. The solver groups the
   * per-division day cap by it and never reasons about a zone itself, so
   * getting it wrong here reintroduces the `settings.tz`-vs-`settings.orgTz`
   * class of bug one layer up. Required in this domain type even though the
   * wire field is proto3-`optional`: presence on the wire exists so the
   * service can REJECT an omission, not so callers may omit it.
   */
  grid: { slots: { court: string; startAtMs: number; dayIndex: number }[]; stepMinutes: number };
  /** `fixtureId` is carried for the caller's own bookkeeping only — it is NOT
   *  sent on the wire (`PinnedRow` carries no identity; see `toRequest`), so
   *  it cannot be used to "pin" a fixture that also appears in `fixtures`.
   *  Sending the same id in both lists does not pin it: the row here lays a
   *  fixed blocking interval while the movable fixture in `fixtures` stays
   *  free, and the fixture comes back placed a SECOND time elsewhere. A
   *  pinned/locked/frozen fixture must be excluded from `fixtures` when it is
   *  added here. */
  existing: {
    fixtureId: string;
    court: string;
    startAtMs: number;
    /**
     * C6 — who is playing in this pinned/existing row, so a rest rule can see
     * it even though the row itself never moves. IDs, not indices, like every
     * other caller-facing field here: {@link solveBuild} resolves each one
     * through the SAME `entrantIndexOf` that `fixtures[].entrantIds` uses
     * (see {@link buildIndexSpace}), so an id that appears ONLY on a pinned
     * row still gets a valid, in-range wire index. Omitted/`undefined` is "no
     * entrants recorded for this row" — a real answer, not a refusal; see
     * `PinnedRow.entrant_indices`'s own comment in the proto.
     */
    entrantIds?: string[];
    /**
     * C4 — which of {@link SolveBuildInput.ruleGroups} this row counts
     * against, by ARRAY POSITION in that list. `ruleGroups` has no id space
     * of its own (see its own doc comment below), so position is the only
     * handle there is — exactly what the wire's own `rule_group_indices`
     * names a position in `SolveBuildRequest.rule_groups`. {@link toRequest}
     * sends `ruleGroups` in the same order it receives it, so a position here
     * IS the wire position: straight passthrough, no lookup. Omitted/
     * `undefined` is "counts against nothing", a real answer per
     * `PinnedRow.rule_group_indices`'s own comment in the proto.
     */
    ruleGroupIndices?: number[];
    /**
     * C1 (2026-08-12 round-order design) — this pin's round, in the SAME
     * sequence as a movable `fixtures[].roundNo`, so a pin-movable pair can
     * be ordered even though the pin never moves. Absent is the common case.
     * `build.ts` is documented (see its own `existing`-map comment) to only
     * ever set this when the pin's division match against the movable
     * round-robin sequence is unambiguous — `PinnedRow` carries no division
     * index on the wire for the service to re-verify it against.
     */
    roundNo?: number;
  }[];
  dependencies: { beforeFixtureId: string; afterFixtureId: string }[];
  /**
   * C1 — one rule and the exact fixture ids it binds, resolved by the CALLER
   * (`build.ts`'s `scopeCoversFixture`) rather than sent as a scope this
   * client would have to understand — see `RuleGroup`'s own comment in the
   * proto and `_RULES.md` section 1 (this context does not own org/tenant
   * concepts, so a division/pool/entrant/person vocabulary stops at
   * `build.ts`). `fixtureIds` must each name an entry in {@link
   * SolveBuildInput.fixtures}; an EMPTY array is legal (see the field's own
   * comment below) and is not the same as omitting the group entirely —
   * dropping an empty group would shift every later group's array position
   * and silently misdirect any pinned row that references one by index.
   *
   * Optional at the type level only for the tests and callers that do not
   * care about it; `build.ts` always supplies the array (possibly empty).
   */
  ruleGroups?: {
    fixtureIds: string[];
    /** Presence, not `>= 0`: 0 is "no minimum rest", a legitimate rule,
     *  distinct from this group carrying no rest rule at all. */
    minRestMinutes?: number;
    /** Presence, then `> 0` when set: 0 would forbid the group outright,
     *  which is never what "no cap" means. Absent = uncapped. */
    maxFixturesPerDay?: number;
  }[];
  constraints: {
    matchMinutes: number;
    gapMinutes: number;
  };
  wallSeconds: number;
}

export interface SolveBuildOutcome {
  assignments: { fixtureId: string; court: string; startAtMs: number }[];
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | "ERROR";
  tiersCompleted: number;
  objectiveValues: { name: string; value: number }[];
  elapsedMs: number;
  wallExhausted: boolean;
  error?: { code: string; message: string };
}

export interface SolveContext {
  /** Correlation id for the solver's logs, built by the engine from `t0` (`build.ts`, where `requestId` is formed). */
  readonly requestId: string;
}

/**
 * Rejecting is how a solver says "no answer". A rejection MAY carry a string `failure`, which build.ts duck-types.
 *
 * **A solver MUST settle (resolve or reject) within `input.wallSeconds` plus a transport margin.** The engine does not race
 * `solve` against a clock: it awaits it. A call that never settles is therefore never freed, and it pins one of
 * `MAX_SOLVER_QUEUE` slots for the life of the process (`queued` in `build.ts` drops only when the solve settles), after which
 * every further build in that process answers `solver_busy` without asking anyone. Today the bound is the gRPC client's own
 * deadline (`deadlineMsFor` in `@seazn/scheduler`'s `placement-client.ts`: `wallSeconds` plus a margin); an adapter that talks
 * to anything else must enforce the same bound itself.
 */
export type PlacementSolver = (input: SolveBuildInput, ctx: SolveContext) => Promise<SolveBuildOutcome>;

type LogFn = (fields: Record<string, unknown>, message: string) => void;

/** The four levels the scheduler uses, in pino's (fields, message) order. */
export interface EngineLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export const silentLogger: EngineLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * D29 at RUN time: `solve` and `log` are required on {@link BuildInput} and on the decomposed repair's input, and the type
 * alone does not hold that. It is erased in compiled JS (phase 1b publishes it), and an `any` or a hand-built input reaches the
 * same code. Called at the very top of `buildSchedule` and `repairDecomposedCpsat`, ahead of every `try` and every fallback: a
 * missing `solve` caught by `buildSchedule`'s catch-all around the solver call logged "placement service unavailable" and
 * returned a greedy board stamped `solver_unavailable` — an inert seam dressed as an outage. A forgotten port is a programmer
 * error and surfaces as one.
 */
export function assertEnginePorts(input: { solve?: unknown; log?: unknown }, caller: string): void {
  if (typeof input.solve !== "function") {
    throw new TypeError(
      `${caller}: input.solve is required (a PlacementSolver). A caller with no solver passes one that rejects, and gets the greedy board with solver_unavailable.`,
    );
  }
  const log = input.log as Partial<Record<string, unknown>> | null | undefined;
  for (const level of LOG_LEVELS) {
    if (typeof log?.[level] !== "function") {
      throw new TypeError(`${caller}: input.log is required (an EngineLogger) and input.log.${level} is not a function. silentLogger is the quiet one.`);
    }
  }
}

/** A build request without its ports — the shape tests and callers assemble before choosing a solver [R23]. */
export type BuildProblem = Omit<BuildInput, "solve" | "log">;
