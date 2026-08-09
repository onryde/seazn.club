// Transport wrapper for the Python CP-SAT scheduling service.
//
// This is the ONLY gRPC-aware module on the TS side, and it is deliberately
// dumb: it translates `SolveBuildInput` onto the wire, translates the response
// back into `SolveBuildOutcome`, and settles. No tier reasoning, no objective
// interpretation, no board validation — `build.ts` owns all of that.
import * as grpc from "@grpc/grpc-js";

import type { ServiceError } from "@grpc/grpc-js";

import { systemClock } from "../core/clock.ts";
import type { Clock } from "../core/clock.ts";
import type {
  DivisionRule,
  SchedulerServiceClient as SchedulerServiceClientType,
  SolveBuildRequest,
  SolveBuildResponse,
} from "./generated/scheduler.ts";
import { SchedulerServiceClient, SolveStatus } from "./generated/scheduler.ts";

/**
 * @internal The RPC seam, declared explicitly rather than `Pick`ed off the
 * generated client so that nothing on the public surface is structurally tied
 * to generated code. It is deliberately NOT a field on `SolveBuildOptions`:
 * `build.ts` builds that object, and a wire-typed member on it would put
 * generated types in the domain layer's type graph — the exact leak §2.2
 * forbids, and one `grep "@grpc/grpc-js" build.ts` cannot see. Tests pass it as
 * the third argument instead; production never supplies it.
 */
export interface SolveBuildCall {
  solveBuild(
    request: SolveBuildRequest,
    metadata: grpc.Metadata,
    options: Partial<grpc.CallOptions>,
    callback: (error: ServiceError | null, response: SolveBuildResponse) => void,
  ): // The started call, whose only use here is cancellation. Typed `unknown`
  // rather than `ClientUnaryCall` so the seam does not drag a grpc handle type
  // onto the surface for a capability probed at run time anyway.
  unknown;
}

/** Best-effort cancellation of a started call; a seam need not return a handle. */
function cancelCall(call: unknown): void {
  const cancel = (call as { cancel?: unknown } | null | undefined)?.cancel;
  if (typeof cancel === "function") cancel.call(call);
}

export interface SolveBuildInput {
  courts: string[];
  fixtures: { fixtureId: string; entrantIds: string[]; divisionId: string }[];
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
  existing: { fixtureId: string; court: string; startAtMs: number }[];
  dependencies: { beforeFixtureId: string; afterFixtureId: string }[];
  constraints: {
    matchMinutes: number;
    gapMinutes: number;
    restByDivision?: Record<string, number>;
    dayCapByDivision?: Record<string, number>;
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

/**
 * Transport configuration. Deliberately carries NO wall budget: that lives on
 * `SolveBuildInput.wallSeconds`, which is the value that goes on the wire, and
 * a second copy here could disagree with it. See `deadlineMsFor`.
 */
export interface SolveBuildOptions {
  /** `host:port` of the cp-sat service. Ignored when a call seam is injected. */
  host?: string;
  /** Shared secret sent as `x-internal-secret` metadata on every call. */
  secret: string;
  /**
   * Correlation id for the service's logs — the service treats it as opaque and
   * never as an idempotency key. Defaults to empty: the engine boundary gate
   * bans `node:crypto` and `Math.random` from `src/`, and the caller is where a
   * meaningful id (org, competition, job) exists anyway.
   */
  requestId?: string;
  /**
   * Source of wall time for the transport deadline. `src/` may not touch
   * ambient time directly — `core/clock.ts` is the only sanctioned source.
   */
  clock?: Clock;
}

/**
 * Slack between the solver's own wall budget and the transport deadline. The
 * service is expected to return a partial board when its wall runs out, so the
 * deadline must never be the thing that ends a solve: it only catches a service
 * that has stopped answering at all.
 */
const DEADLINE_MARGIN_SECONDS = 2;

/**
 * The wire budget and the transport deadline are derived from ONE field, and
 * that field is the one the service actually receives. When the budget was also
 * settable through the options object the two could disagree silently: a caller
 * that passed the budget only in the options left the request carrying
 * `wallSeconds` while the deadline was computed from the other copy — every
 * solve would then die at the margin, report `deadline`, and `build.ts` would
 * fall back to greedy on every board with nothing surfacing anywhere.
 */
function deadlineMsFor(input: SolveBuildInput): number {
  return Math.round((input.wallSeconds + DEADLINE_MARGIN_SECONDS) * 1000);
}

const DEFAULT_HOST = "cp-sat.internal:50051";

/**
 * Wire enum -> outcome vocabulary. An unmapped value (including proto3's
 * `UNSPECIFIED` and ts-proto's `UNRECOGNIZED = -1`) becomes `ERROR` rather than
 * `UNKNOWN`: `UNKNOWN` is a claim the solver makes about a board it actually
 * produced, and reporting it for a status we could not read would hand
 * `build.ts` a board it has no reason to trust.
 */
const STATUS_BY_WIRE_VALUE = new Map<number, SolveBuildOutcome["status"]>([
  [SolveStatus.SOLVE_STATUS_OPTIMAL, "OPTIMAL"],
  [SolveStatus.SOLVE_STATUS_FEASIBLE, "FEASIBLE"],
  [SolveStatus.SOLVE_STATUS_INFEASIBLE, "INFEASIBLE"],
  [SolveStatus.SOLVE_STATUS_UNKNOWN, "UNKNOWN"],
  [SolveStatus.SOLVE_STATUS_ERROR, "ERROR"],
]);

/**
 * One channel per host. The brief's single module-level cache returns the first
 * host's channel for every subsequent host, which silently sends a solve to the
 * wrong service the moment anything (a test, a second environment) uses two.
 */
const channelsByHost = new Map<string, SchedulerServiceClientType>();

function clientFor(host: string): SchedulerServiceClientType {
  let client = channelsByHost.get(host);
  if (!client) {
    client = new SchedulerServiceClient(host, grpc.credentials.createInsecure());
    channelsByHost.set(host, client);
  }
  return client;
}

/**
 * TS models the per-division rules as two Records keyed by division id; the
 * wire merges them into ONE repeated `DivisionRule`, keyed by
 * `division_index` instead of duplicated across two lists (half 1's
 * `DivisionRestRule` + `DivisionDayCapRule` -> `DivisionRule` merge). A
 * division keeps whichever half it actually has: `minRestMinutes` /
 * `maxFixturesPerDay` are each proto3-`optional`, so a division present in
 * only one Record sends a rule with the other field left UNSET, not a false
 * zero — 0 is itself a legitimate rest minutes value.
 */
function toDivisionRules(
  constraints: SolveBuildInput["constraints"],
  divisionIndexOf: (divisionId: string) => number,
): DivisionRule[] {
  const rest = constraints.restByDivision ?? {};
  const cap = constraints.dayCapByDivision ?? {};
  const divisionIds = new Set([...Object.keys(rest), ...Object.keys(cap)]);
  return [...divisionIds].map((divisionId) => ({
    divisionIndex: divisionIndexOf(divisionId),
    minRestMinutes: Object.hasOwn(rest, divisionId) ? rest[divisionId] : undefined,
    maxFixturesPerDay: Object.hasOwn(cap, divisionId) ? cap[divisionId] : undefined,
  }));
}

/**
 * Build a fully-populated request. Every field is set explicitly: the generated
 * encoder reads the message directly, so a `SolveBuildInput` cast at the call
 * seam would leave `requestId` undefined and the repeated fields non-iterable.
 *
 * `indices` resolves every domain id to its wire position; see
 * {@link buildIndexSpace}. This function only CONSUMES it — it never invents
 * an index of its own, so a lookup this function needs but `indices` cannot
 * answer is a bug in `buildIndexSpace`, not here.
 */
function toRequest(input: SolveBuildInput, requestId: string, indices: IndexSpace): SolveBuildRequest {
  return {
    requestId,
    courtNames: indices.courtNames,
    entrantCount: indices.entrantCount,
    divisionCount: indices.divisionCount,
    fixtures: input.fixtures.map(({ entrantIds, divisionId }) => ({
      entrantIndices: entrantIds.map((entrantId) => indices.entrantIndexOf(entrantId)),
      divisionIndex: indices.divisionIndexOf(divisionId),
    })),
    slots: input.grid.slots.map(({ court, startAtMs, dayIndex }) => ({
      courtIndex: indices.courtIndexOf(court),
      startAtMs,
      dayIndex,
    })),
    stepMinutes: input.grid.stepMinutes,
    // `existing[].fixtureId` is intentionally not read: `PinnedRow` carries no
    // identity on the wire any more (half 1 confirmed the old
    // `Assignment.fixture_id` on an existing row was already dead — it
    // reached only a debug label on the interval variable's name, never a
    // constraint). The field stays on `SolveBuildInput` so Task 06 does not
    // have to change what it passes; the client just has nowhere left to put it.
    existing: input.existing.map(({ court, startAtMs }) => ({
      courtIndex: indices.courtIndexOf(court),
      startAtMs,
    })),
    dependencies: input.dependencies.map(({ beforeFixtureId, afterFixtureId }) => ({
      beforeIndex: indices.fixtureIndexOf(beforeFixtureId),
      afterIndex: indices.fixtureIndexOf(afterFixtureId),
    })),
    divisionRules: toDivisionRules(input.constraints, indices.divisionIndexOf),
    constraints: {
      matchMinutes: input.constraints.matchMinutes,
      gapMinutes: input.constraints.gapMinutes,
    },
    wallSeconds: input.wallSeconds,
  };
}

/**
 * `fixtureIndex`/`courtIndex` invert through the SAME arrays `toRequest` just
 * sent — the response never echoes `fixtures`/`court_names` back, so
 * `indices` (built once per call in {@link solveBuild}) is the only place
 * those strings still exist once the response arrives. This is the "invert on
 * the way back" step: nothing past this function ever sees an index.
 */
function toOutcome(response: SolveBuildResponse, indices: IndexSpace): SolveBuildOutcome {
  return {
    assignments: (response.assignments ?? []).map(({ fixtureIndex, courtIndex, startAtMs }) => ({
      fixtureId: reverseLookup(indices.fixtureIds, fixtureIndex, "fixture"),
      court: reverseLookup(indices.courtNames, courtIndex, "court"),
      startAtMs,
    })),
    status: STATUS_BY_WIRE_VALUE.get(response.status) ?? "ERROR",
    tiersCompleted: response.tiersCompleted,
    objectiveValues: (response.objectiveValues ?? []).map(({ name, value }) => ({
      name,
      value,
    })),
    elapsedMs: response.elapsedMs,
    wallExhausted: response.wallExhausted,
    error: response.error ? { code: response.error.code, message: response.error.message } : undefined,
  };
}

/**
 * Index -> string for a response the SERVICE authored. Out of range means the
 * service and this client disagree about how many fixtures/courts were in the
 * request — a transport-level defect, not a caller mistake — so this throws a
 * plain `Error` rather than `CpSatError`: it runs inside `toOutcome`, which
 * `solveBuild`'s `settle()` already wraps into `CpSatError("transport", ...)`
 * for exactly this reason (see the comment on `settle`, below).
 */
function reverseLookup(values: readonly string[], index: number, kind: "fixture" | "court"): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error(
      `cp-sat response references ${kind} index ${index}, out of range for the ` +
        `${values.length} ${kind}(s) sent in the request.`,
    );
  }
  return value;
}

/**
 * Why a solve did not produce an outcome, in domain words. `build.ts` decides
 * whether to fall back on this field; it must never need `grpc.status`, which
 * is exactly the vocabulary this type exists to stop at the boundary.
 */
export type CpSatFailure =
  | "invalid_request" // refused here, or refused by the service's own ACL
  | "deadline" // no answer inside wallSeconds + the margin
  | "unauthenticated" // the shared secret was rejected
  | "unavailable" // the service could not be reached
  | "transport"; // anything else that went wrong on the wire

export class CpSatError extends Error {
  readonly failure: CpSatFailure;

  constructor(failure: CpSatFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CpSatError";
    this.failure = failure;
  }
}

/**
 * The id<->index translation this ACL exists to own (round-6 brief: "the
 * mapping lives in cpsat-client.ts, not in build.ts"; `_RULES.md` §2.2).
 * Built once per call in {@link solveBuild} and threaded through both
 * `toRequest` (forward: id -> index) and `toOutcome` (reverse: index -> id),
 * so one derivation backs both directions of a single request/response pair —
 * `build.ts` never sees an index, and never has to hand-build one either.
 *
 * `courts` and `fixtures` are DECLARED lists: `SolveBuildInput.courts` and
 * `.fixtures` are themselves the index space (array position IS the wire
 * index), so a name/id that does not appear in one of them is refused rather
 * than silently added — the same "declared, not inferred" distinction the
 * generated `court_names`/`entrant_count` comments draw. Entrants and
 * divisions have no declared list of their own on `SolveBuildInput` — nothing
 * enumerates them up front — so they are INFERRED: the first time an id is
 * seen it is assigned the next index, in input order.
 */
interface IndexSpace {
  /**
   * Positional copy of `SolveBuildInput.courts` — never deduplicated. Two
   * equal (or merely confusable) entries are two entries; `courtNames[i]` is
   * always the i-th COURT, never "the i-th distinct name".
   */
  courtNames: string[];
  /**
   * Resolves a `court` field on a slot or existing row to its wire index. On
   * a genuine duplicate name this resolves to the FIRST matching position — a
   * bare name cannot address a specific one of several identically-named
   * courts, because nothing on `SolveBuildInput` distinguishes them beyond
   * array position, and position is exactly what a string reference throws
   * away. This is an INPUT-side limitation only: the OUTPUT leg
   * (`courtNames[courtIndex]` in {@link toOutcome}) is exact for every index
   * the service returns, duplicates included, because it never goes through
   * this lookup. Throws `CpSatError("invalid_request", ...)` if `court` does
   * not match anything in `courts`.
   */
  courtIndexOf: (court: string) => number;
  /**
   * Positional copy of `SolveBuildInput.fixtures[].fixtureId`, in the order
   * the client sent `fixtures` — `fixtureIds[i]` names the i-th fixture.
   */
  fixtureIds: string[];
  /**
   * Resolves a `dependencies[].beforeFixtureId`/`afterFixtureId` to a fixture
   * index. Throws `CpSatError("invalid_request", ...)` if the id does not
   * name any entry in `fixtures` — `existing` never contributes to this
   * table, matching half 1's finding that a dependency naming a pinned row's
   * id was already meaningless under the old string contract.
   */
  fixtureIndexOf: (fixtureId: string) => number;
  /**
   * Total: every entrant id in every fixture's `entrantIds` was assigned an
   * index while building this `IndexSpace`, so this never fails for an id
   * that genuinely came from the input.
   */
  entrantIndexOf: (entrantId: string) => number;
  entrantCount: number;
  /**
   * Total for the same reason `entrantIndexOf` is — covers every division
   * mentioned by a fixture OR by `constraints.restByDivision` /
   * `dayCapByDivision`, so a rule for a division no fixture currently uses
   * still gets a valid, in-range index.
   */
  divisionIndexOf: (divisionId: string) => number;
  divisionCount: number;
}

/**
 * Looks up a total mapping built by {@link buildIndexSpace}. A miss here would
 * mean `buildIndexSpace` populated the map from a different source than this
 * is read back against — an internal bug, not a caller mistake — so this
 * throws a plain `Error`, not `CpSatError`.
 */
function totalLookup(byId: ReadonlyMap<string, number>, id: string): number {
  const index = byId.get(id);
  if (index === undefined) {
    throw new Error(`cp-sat client: internal error — no index derived for ${JSON.stringify(id)}`);
  }
  return index;
}

/**
 * Derives the complete id<->index mapping for one request; see
 * {@link IndexSpace}. Ordering always comes from the input itself — `courts`/
 * `fixtures` array position for the declared lists, first-sighting order over
 * `fixtures` (then `constraints.restByDivision`/`dayCapByDivision` keys, for
 * a division no fixture references yet) for the inferred ones — never a
 * `Set`/`Map` assembled from some OTHER collection's iteration order, and
 * never anything random: `packages/engine/src` bans `Math.random()` as well
 * as ambient time, and identity here comes entirely from the caller's own
 * arrays.
 */
function buildIndexSpace(input: SolveBuildInput): IndexSpace {
  // Courts: DECLARED. `i` (the raw array position), not a running dedup
  // count — a later, non-duplicate name still belongs at its OWN wire
  // position even though earlier duplicates were skipped, so the count of
  // distinct names seen so far would under-shoot the real index.
  const courtIndexByName = new Map<string, number>();
  input.courts.forEach((name, i) => {
    if (!courtIndexByName.has(name)) courtIndexByName.set(name, i);
  });

  // Fixtures: DECLARED the same way, and for the same reason — `fixtures[i]`
  // IS index i, full stop.
  const fixtureIndexById = new Map<string, number>();
  input.fixtures.forEach(({ fixtureId }, i) => {
    if (!fixtureIndexById.has(fixtureId)) fixtureIndexById.set(fixtureId, i);
  });

  // Entrants and divisions: INFERRED. `.size` at the moment of first sighting
  // IS correct here (unlike courts/fixtures above) because there is no
  // separate positional array to stay aligned with — this Map IS the index
  // space, not a lookup into one that already exists.
  const entrantIndexById = new Map<string, number>();
  const divisionIndexById = new Map<string, number>();
  for (const fixture of input.fixtures) {
    for (const entrantId of fixture.entrantIds) {
      if (!entrantIndexById.has(entrantId)) entrantIndexById.set(entrantId, entrantIndexById.size);
    }
    if (!divisionIndexById.has(fixture.divisionId)) {
      divisionIndexById.set(fixture.divisionId, divisionIndexById.size);
    }
  }
  // A division-only rule — rest or day cap set for a division no fixture in
  // THIS solve uses yet — still needs a valid index: `DivisionRule
  // .division_index` is range-checked against `division_count` exactly like
  // any other index field, so it has to exist in this table too.
  for (const divisionId of Object.keys(input.constraints.restByDivision ?? {})) {
    if (!divisionIndexById.has(divisionId)) divisionIndexById.set(divisionId, divisionIndexById.size);
  }
  for (const divisionId of Object.keys(input.constraints.dayCapByDivision ?? {})) {
    if (!divisionIndexById.has(divisionId)) divisionIndexById.set(divisionId, divisionIndexById.size);
  }

  return {
    courtNames: [...input.courts],
    courtIndexOf: (court) => {
      const index = courtIndexByName.get(court);
      if (index === undefined) {
        throw new CpSatError(
          "invalid_request",
          `cp-sat client: court ${JSON.stringify(court)} is referenced by a slot or existing ` +
            "row but does not appear in courts.",
        );
      }
      return index;
    },
    fixtureIds: input.fixtures.map((fixture) => fixture.fixtureId),
    fixtureIndexOf: (fixtureId) => {
      const index = fixtureIndexById.get(fixtureId);
      if (index === undefined) {
        throw new CpSatError(
          "invalid_request",
          `cp-sat client: dependency references fixture ${JSON.stringify(fixtureId)}, which ` +
            "does not appear in fixtures.",
        );
      }
      return index;
    },
    entrantIndexOf: (entrantId) => totalLookup(entrantIndexById, entrantId),
    entrantCount: entrantIndexById.size,
    divisionIndexOf: (divisionId) => totalLookup(divisionIndexById, divisionId),
    divisionCount: divisionIndexById.size,
  };
}

/**
 * gRPC status code -> domain failure. Total by construction: the default arm
 * means a code added by a future grpc-js still yields a domain value rather
 * than leaking the integer to the caller.
 */
function failureFor(code: number | undefined): CpSatFailure {
  switch (code) {
    case grpc.status.DEADLINE_EXCEEDED:
      return "deadline";
    case grpc.status.UNAUTHENTICATED:
    case grpc.status.PERMISSION_DENIED:
      return "unauthenticated";
    case grpc.status.UNAVAILABLE:
      return "unavailable";
    case grpc.status.INVALID_ARGUMENT:
      return "invalid_request";
    default:
      return "transport";
  }
}

function deadlineError(deadlineMs: number, detail: string, cause?: unknown): CpSatError {
  return new CpSatError(
    "deadline",
    `cp-sat solveBuild exceeded its ${deadlineMs}ms deadline: ${detail}`,
    { cause },
  );
}

/**
 * Proto3 cannot tell "unset" from "legitimately zero" for a scalar: a zero is
 * dropped from the wire entirely. For these three fields a zero is not a
 * harmless default but a different board — a zero-length match stacks every
 * fixture on one tick, a zero day cap forbids a division outright, and a zero
 * wall stops the tier chain before it starts. Each comes back OPTIMAL. The
 * service's own ACL rejects all three; refusing here as well means the caller
 * gets the reason without a round trip, and gets it as `invalid_request` rather
 * than as a transport error it has to decode.
 */
function assertNoAmbiguousZeros(input: SolveBuildInput): void {
  if (input.constraints.matchMinutes <= 0) {
    throw new CpSatError(
      "invalid_request",
      `constraints.matchMinutes must be > 0, got ${input.constraints.matchMinutes}. ` +
        "A zero-length match makes every court and rest interval zero-width, so the board " +
        "comes back OPTIMAL with every fixture stacked on one tick.",
    );
  }
  for (const [divisionId, cap] of Object.entries(input.constraints.dayCapByDivision ?? {})) {
    if (cap <= 0) {
      throw new CpSatError(
        "invalid_request",
        `constraints.dayCapByDivision[${JSON.stringify(divisionId)}] must be > 0, got ${cap}. ` +
          "A cap of 0 forbids placing that division at all and the board comes back OPTIMAL " +
          "with all of its fixtures dropped. To leave a division uncapped, omit it rather " +
          "than sending 0.",
      );
    }
  }
  if (input.wallSeconds <= 0) {
    throw new CpSatError(
      "invalid_request",
      `wallSeconds must be > 0, got ${input.wallSeconds}. A 0 budget stops the tier chain ` +
        "before T0 runs and returns UNKNOWN with no assignments — the same answer an " +
        "impossible board gives, so an unset field would read as a solver verdict.",
    );
  }
}

/**
 * Call the cp-sat service's SolveBuild RPC.
 *
 * Never retries: a solve is seconds of CPU, not a cheap idempotent GET, and a
 * retry after a deadline would spend the caller's remaining budget twice.
 */
export async function solveBuild(
  input: SolveBuildInput,
  opts: SolveBuildOptions,
  /** @internal Test seam — see {@link SolveBuildCall}. Production omits it. */
  injectedCall?: SolveBuildCall,
): Promise<SolveBuildOutcome> {
  assertNoAmbiguousZeros(input);
  // Derives the id<->index mapping once so `toRequest` (forward) and
  // `toOutcome` (reverse, once the response arrives) share ONE translation —
  // see {@link buildIndexSpace}. Synchronous and before the Promise executor,
  // same as `assertNoAmbiguousZeros`, so an unresolvable reference rejects
  // immediately rather than after a wire round trip.
  const indices = buildIndexSpace(input);

  const client =
    injectedCall ?? clientFor(opts.host ?? process.env.CPSAT_SERVICE_HOST ?? DEFAULT_HOST);

  const metadata = new grpc.Metadata();
  metadata.set("x-internal-secret", opts.secret);

  const deadlineMs = deadlineMsFor(input);
  const request = toRequest(input, opts.requestId ?? "", indices);
  // grpc-js reads `deadline` as an absolute instant, so this needs wall time.
  const deadlineAt = new Date((opts.clock ?? systemClock).now());
  deadlineAt.setTime(deadlineAt.getTime() + deadlineMs);

  return new Promise<SolveBuildOutcome>((resolve, reject) => {
    let settled = false;
    let call: unknown = undefined;

    // The gRPC CallOption deadline is enforced by the channel, so it cannot be
    // the only guard: a call that never reaches the channel's timer — or one
    // settled outside it — would leave this promise pending forever, and a
    // solve that never returns is worse than one that fails. `build.ts` has a
    // greedy fallback it can only take if this rejects.
    // NOTE: deliberately not `unref`'d. The timer is the only thing guaranteeing
    // this promise settles, and an unref'd one lets the process exit with the
    // caller still awaiting. It lives at most `deadlineMs`.
    const watchdog = setTimeout(() => {
      settle(() => {
        cancelCall(call);
        reject(deadlineError(deadlineMs, "no response from the service"));
      });
    }, deadlineMs);

    function settle(run: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      // `run` has already disarmed the watchdog, so a throw inside it would
      // leave the promise pending FOREVER with nothing left to time it out.
      // `toOutcome` can genuinely throw: the generated decoder raises on an
      // int64 past MAX_SAFE_INTEGER, and a malformed repeated field fails on
      // `.map`. Turn any such throw into a rejection.
      try {
        run();
      } catch (thrown) {
        reject(
          new CpSatError(
            "transport",
            `cp-sat solveBuild could not read the service's response: ${
              thrown instanceof Error ? thrown.message : String(thrown)
            }`,
            { cause: thrown },
          ),
        );
      }
    }

    try {
      call = client.solveBuild(
        request,
        metadata,
        { deadline: deadlineAt },
        (err: ServiceError | null, response: SolveBuildResponse) => {
          settle(() => {
            if (err) {
              // The raw ServiceError carries a `grpc.status` integer. It stops
              // here: everything past this point speaks `CpSatFailure`.
              reject(
                err.code === grpc.status.DEADLINE_EXCEEDED
                  ? deadlineError(deadlineMs, err.message, err)
                  : new CpSatError(
                      failureFor(err.code),
                      `cp-sat solveBuild failed: ${err.details || err.message}`,
                      { cause: err },
                    ),
              );
              return;
            }
            resolve(toOutcome(response, indices));
          });
        },
      );
    } catch (thrown) {
      // A synchronous throw (a request the generated encoder rejects, a closed
      // channel) would otherwise leave the watchdog armed and hold the process
      // open for the full deadline before anyone learned the call never started.
      settle(() =>
        reject(
          new CpSatError(
            "transport",
            `cp-sat solveBuild failed before the call started: ${
              thrown instanceof Error ? thrown.message : String(thrown)
            }`,
            { cause: thrown },
          ),
        ),
      );
    }
  });
}
