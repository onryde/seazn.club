// Transport wrapper for the Python Placement scheduling service.
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
  SchedulerServiceClient as SchedulerServiceClientType,
  SolveBuildRequest,
  SolveBuildResponse,
} from "./generated/scheduler.ts";
import { SchedulerServiceClient, SolveStatus } from "./generated/scheduler.ts";
import { log } from "./logger.ts";

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

/**
 * Transport configuration. Deliberately carries NO wall budget: that lives on
 * `SolveBuildInput.wallSeconds`, which is the value that goes on the wire, and
 * a second copy here could disagree with it. See `deadlineMsFor`.
 */
export interface SolveBuildOptions {
  /** `host:port` of the placement service. Ignored when a call seam is injected. */
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

/**
 * `.flycast`, NOT `.internal` — and the difference is load-bearing the moment
 * the service is allowed to scale to zero.
 *
 * Both names resolve on Fly's private 6PN network, but `<app>.internal`
 * resolves straight to machine IPs and bypasses Fly Proxy, while `.flycast`
 * routes THROUGH the proxy. Autostart is a proxy feature: Fly's own docs say
 * of Flycast that "unlike private networking using `.internal` addresses you
 * don't need to keep Machines running for the app to be reachable".
 *
 * So with `auto_stop_machines = "suspend"` (fly.toml) and an `.internal`
 * host, every solve against a suspended machine dials an address with
 * nothing listening. `build.ts` catches the rejection and returns
 * `greedy("solver_unavailable")` — a perfectly ordinary-looking board. The
 * failure presents as "placement stopped winning", not as an outage, which is
 * the hardest possible shape to diagnose.
 *
 * `.flycast` requires a private IPv6 allocated once per app
 * (`fly ips allocate-v6 --private --app placement`) — see DEPLOY.md. It is NOT
 * automatic, and the failure mode if it is skipped is the same silent greedy
 * board as above.
 */
const DEFAULT_HOST = "placement.flycast:50051";

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
 * One channel per SOLVE, not one cached per host. A shared, long-lived channel
 * is exactly what defeats Fly Proxy's connection-based load balancing: ten
 * concurrent organisers riding one cached client ride ten HTTP/2 streams over
 * ONE TCP connection, and the proxy fans work out by CONNECTION — so all ten
 * pin to a single machine no matter how many are running or suspended.
 * `services/placement/fly.toml`'s `[services.concurrency] hard_limit = 1` is the
 * other half of this fix; it only means anything if each solve actually opens
 * its own connection for the proxy to count.
 *
 * The cost accepted for this: a TCP + HTTP/2 handshake per solve, milliseconds
 * on Fly's private 6PN network, against a solve that runs for seconds — cheap
 * insurance for the fan-out `fly scale count` is meant to buy.
 */
function newClientFor(host: string): SchedulerServiceClientType {
  return new SchedulerServiceClient(host, grpc.credentials.createInsecure());
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
    //
    // `ruleGroupIndices` is a straight passthrough (C4): it already names a
    // position in `input.ruleGroups`, and `ruleGroups` below is sent in that
    // SAME order, so no lookup is needed or possible — `indices` has no table
    // for a rule group, because a rule group has no id of its own to look up.
    // `entrantIndices` (C6) DOES need one: `entrantIds` are domain ids, like
    // every other id on this type, and `entrantIndexOf` resolves them exactly
    // as `fixtures[].entrantIds` are resolved above (see `buildIndexSpace`,
    // which registers `existing[].entrantIds` into the same total map).
    existing: input.existing.map(({ court, startAtMs, entrantIds, ruleGroupIndices }) => ({
      courtIndex: indices.courtIndexOf(court),
      startAtMs,
      ruleGroupIndices: [...(ruleGroupIndices ?? [])],
      entrantIndices: (entrantIds ?? []).map((entrantId) => indices.entrantIndexOf(entrantId)),
    })),
    dependencies: input.dependencies.map(({ beforeFixtureId, afterFixtureId }) => ({
      beforeIndex: indices.fixtureIndexOf(beforeFixtureId),
      afterIndex: indices.fixtureIndexOf(afterFixtureId),
    })),
    // C1. `fixtureIndices` resolves through the SAME `fixtureIndexOf` a
    // dependency endpoint does just above — an id `input.ruleGroups` names
    // that is not in `input.fixtures` is refused the same way a dependency
    // naming an unknown fixture already is, rather than silently dropped.
    ruleGroups: (input.ruleGroups ?? []).map(({ fixtureIds, minRestMinutes, maxFixturesPerDay }) => ({
      fixtureIndices: fixtureIds.map((fixtureId) => indices.fixtureIndexOf(fixtureId)),
      minRestMinutes,
      maxFixturesPerDay,
    })),
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
 * plain `Error` rather than `PlacementError`: it runs inside `toOutcome`, which
 * `solveBuild`'s `settle()` already wraps into `PlacementError("transport", ...)`
 * for exactly this reason (see the comment on `settle`, below).
 */
function reverseLookup(values: readonly string[], index: number, kind: "fixture" | "court"): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error(
      `placement response references ${kind} index ${index}, out of range for the ` +
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
export type PlacementFailure =
  | "invalid_request" // refused here, or refused by the service's own ACL
  | "deadline" // no answer inside wallSeconds + the margin
  | "unauthenticated" // the shared secret was rejected
  | "unavailable" // the service could not be reached
  | "transport"; // anything else that went wrong on the wire

export class PlacementError extends Error {
  readonly failure: PlacementFailure;

  constructor(failure: PlacementFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlacementError";
    this.failure = failure;
  }
}

/**
 * The id<->index translation this ACL exists to own (round-6 brief: "the
 * mapping lives in placement-client.ts, not in build.ts"; `_RULES.md` §2.2).
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
   * this lookup. Throws `PlacementError("invalid_request", ...)` if `court` does
   * not match anything in `courts`.
   */
  courtIndexOf: (court: string) => number;
  /**
   * Positional copy of `SolveBuildInput.fixtures[].fixtureId`, in the order
   * the client sent `fixtures` — `fixtureIds[i]` names the i-th fixture.
   */
  fixtureIds: string[];
  /**
   * Resolves a `dependencies[].beforeFixtureId`/`afterFixtureId` or a
   * `ruleGroups[].fixtureIds` entry (C1) to a fixture index. Throws
   * `PlacementError("invalid_request", ...)` if the id does not name any
   * entry in `fixtures` — `existing` never contributes to this table,
   * matching half 1's finding that a dependency naming a pinned row's id was
   * already meaningless under the old string contract, and a rule group is
   * no different: it binds MOVABLE fixtures, and a pinned row counts against
   * a group through `ruleGroupIndices` instead (see `SolveBuildInput.
   * existing[].ruleGroupIndices`).
   */
  fixtureIndexOf: (fixtureId: string) => number;
  /**
   * Total: every entrant id in every fixture's `entrantIds`, AND every
   * entrant id in every `existing[].entrantIds` (C6), was assigned an index
   * while building this `IndexSpace`, so this never fails for an id that
   * genuinely came from the input — a pinned row is allowed to name an
   * entrant no MOVABLE fixture uses.
   */
  entrantIndexOf: (entrantId: string) => number;
  entrantCount: number;
  /**
   * Total for the same reason `entrantIndexOf` is — covers every division
   * mentioned by a fixture. (Previously also covered a division named only
   * by `constraints.restByDivision`/`dayCapByDivision` — those fields were
   * retired alongside `division_rules`, proto field 10; a division reaches
   * this index space only through a fixture now.)
   */
  divisionIndexOf: (divisionId: string) => number;
  divisionCount: number;
}

/**
 * Looks up a total mapping built by {@link buildIndexSpace}. A miss here would
 * mean `buildIndexSpace` populated the map from a different source than this
 * is read back against — an internal bug, not a caller mistake — so this
 * throws a plain `Error`, not `PlacementError`.
 */
function totalLookup(byId: ReadonlyMap<string, number>, id: string): number {
  const index = byId.get(id);
  if (index === undefined) {
    throw new Error(`placement client: internal error — no index derived for ${JSON.stringify(id)}`);
  }
  return index;
}

/**
 * Derives the complete id<->index mapping for one request; see
 * {@link IndexSpace}. Ordering always comes from the input itself — `courts`/
 * `fixtures` array position for the declared lists, first-sighting order over
 * `fixtures` (then `existing[].entrantIds`, C6, for an entrant no MOVABLE
 * fixture names yet) for the inferred ones — never a `Set`/`Map` assembled
 * from some OTHER collection's iteration order,
 * and never anything random: `packages/engine/src` bans `Math.random()` as
 * well as ambient time, and identity here comes entirely from the caller's
 * own arrays.
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
  // C6 — `existing[].entrantIds` can name an entrant no MOVABLE fixture uses
  // (a pin from another division, say), so it gets the same first-sighting
  // registration `fixtures` did above — after, so an entrant already seen on
  // a movable fixture keeps the SAME index it always has; only a genuinely
  // new id is appended. Without this, `entrantIndexOf` (a TOTAL lookup) would
  // throw the internal-error branch on a perfectly legitimate id that simply
  // never appeared in `fixtures`.
  for (const row of input.existing) {
    for (const entrantId of row.entrantIds ?? []) {
      if (!entrantIndexById.has(entrantId)) entrantIndexById.set(entrantId, entrantIndexById.size);
    }
  }
  return {
    courtNames: [...input.courts],
    courtIndexOf: (court) => {
      const index = courtIndexByName.get(court);
      if (index === undefined) {
        throw new PlacementError(
          "invalid_request",
          `placement client: court ${JSON.stringify(court)} is referenced by a slot or existing ` +
            "row but does not appear in courts.",
        );
      }
      return index;
    },
    fixtureIds: input.fixtures.map((fixture) => fixture.fixtureId),
    fixtureIndexOf: (fixtureId) => {
      const index = fixtureIndexById.get(fixtureId);
      if (index === undefined) {
        throw new PlacementError(
          "invalid_request",
          `placement client: fixture ${JSON.stringify(fixtureId)} is referenced by a dependency ` +
            "or a rule group but does not appear in fixtures.",
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
function failureFor(code: number | undefined): PlacementFailure {
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

function deadlineError(deadlineMs: number, detail: string, cause?: unknown): PlacementError {
  return new PlacementError(
    "deadline",
    `placement solveBuild exceeded its ${deadlineMs}ms deadline: ${detail}`,
    { cause },
  );
}

/**
 * Proto3 cannot tell "unset" from "legitimately zero" for a scalar: a zero is
 * dropped from the wire entirely. For these two fields a zero is not a
 * harmless default but a different board — a zero-length match stacks every
 * fixture on one tick, and a zero wall stops the tier chain before it starts.
 * Each comes back OPTIMAL. The service's own ACL rejects both; refusing here
 * as well means the caller gets the reason without a round trip, and gets it
 * as `invalid_request` rather than as a transport error it has to decode.
 *
 * (Previously a third field, `constraints.dayCapByDivision`, got the same
 * treatment — retired alongside `division_rules`, proto field 10.)
 */
function assertNoAmbiguousZeros(input: SolveBuildInput): void {
  if (input.constraints.matchMinutes <= 0) {
    throw new PlacementError(
      "invalid_request",
      `constraints.matchMinutes must be > 0, got ${input.constraints.matchMinutes}. ` +
        "A zero-length match makes every court and rest interval zero-width, so the board " +
        "comes back OPTIMAL with every fixture stacked on one tick.",
    );
  }
  if (input.wallSeconds <= 0) {
    throw new PlacementError(
      "invalid_request",
      `wallSeconds must be > 0, got ${input.wallSeconds}. A 0 budget stops the tier chain ` +
        "before T0 runs and returns UNKNOWN with no assignments — the same answer an " +
        "impossible board gives, so an unset field would read as a solver verdict.",
    );
  }
}

/**
 * Call the placement service's SolveBuild RPC.
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
  log.debug(
    {
      requestId: opts.requestId,
      fixtures: input.fixtures.length,
      courts: input.courts.length,
      wallSeconds: input.wallSeconds,
    },
    "placement solveBuild: call start",
  );
  // Derives the id<->index mapping once so `toRequest` (forward) and
  // `toOutcome` (reverse, once the response arrives) share ONE translation —
  // see {@link buildIndexSpace}. Synchronous and before the Promise executor,
  // same as `assertNoAmbiguousZeros`, so an unresolvable reference rejects
  // immediately rather than after a wire round trip.
  const indices = buildIndexSpace(input);

  // Constructed fresh for this call, never cached — see {@link newClientFor}.
  // `undefined` when a call seam is injected: that object is caller-owned
  // (see the seam's own doc comment) and never ours to close.
  const constructedClient = injectedCall
    ? undefined
    : newClientFor(opts.host ?? process.env.PLACEMENT_SERVICE_HOST ?? DEFAULT_HOST);
  const client = injectedCall ?? constructedClient!;

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
        log.warn(
          { requestId: opts.requestId, deadlineMs },
          "placement solveBuild: watchdog timeout, no response from the service",
        );
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
          new PlacementError(
            "transport",
            `placement solveBuild could not read the service's response: ${
              thrown instanceof Error ? thrown.message : String(thrown)
            }`,
            { cause: thrown },
          ),
        );
      } finally {
        // `settle` is the one chokepoint every settle path passes through —
        // success, gRPC error, watchdog timeout, and the synchronous-throw
        // path below all call it exactly once (guarded by `settled` above),
        // so closing here closes exactly once too. `run` already ran (and
        // `toOutcome`, if this was the success path, already read the
        // response inside it) by the time this `finally` fires, so the close
        // cannot race the read. `constructedClient` is `undefined` when a
        // call seam was injected, and `?.close()` is then a no-op — that
        // object is caller-owned, never ours to close.
        constructedClient?.close();
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
              // here: everything past this point speaks `PlacementFailure`.
              log.warn(
                { requestId: opts.requestId, code: err.code, message: err.message },
                "placement solveBuild: RPC error",
              );
              reject(
                err.code === grpc.status.DEADLINE_EXCEEDED
                  ? deadlineError(deadlineMs, err.message, err)
                  : new PlacementError(
                      failureFor(err.code),
                      `placement solveBuild failed: ${err.details || err.message}`,
                      { cause: err },
                    ),
              );
              return;
            }
            const outcome = toOutcome(response, indices);
            log.debug(
              { requestId: opts.requestId, status: outcome.status, elapsedMs: outcome.elapsedMs },
              "placement solveBuild: response received",
            );
            resolve(outcome);
          });
        },
      );
    } catch (thrown) {
      // A synchronous throw (a request the generated encoder rejects, a closed
      // channel) would otherwise leave the watchdog armed and hold the process
      // open for the full deadline before anyone learned the call never started.
      settle(() => {
        // Curated fields, not the raw `thrown` value: same reasoning as the
        // RPC-error branch above — everything past this boundary should speak
        // plain, known-safe fields rather than an arbitrary caught object.
        log.warn(
          {
            requestId: opts.requestId,
            message: thrown instanceof Error ? thrown.message : String(thrown),
          },
          "placement solveBuild: synchronous throw before the call started",
        );
        reject(
          new PlacementError(
            "transport",
            `placement solveBuild failed before the call started: ${
              thrown instanceof Error ? thrown.message : String(thrown)
            }`,
            { cause: thrown },
          ),
        );
      });
    }
  });
}
