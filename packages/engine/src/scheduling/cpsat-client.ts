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
 * TS models the per-division rules as a Record keyed by division; the proto
 * models them as repeated messages. Handing the Record to the generated encoder
 * does not fail loudly — the solver just receives a board with every rest rule
 * missing and proves it optimal — so the translation has to happen here.
 */
function toRestRules(byDivision: Record<string, number> | undefined) {
  return Object.entries(byDivision ?? {}).map(([divisionId, minRestMinutes]) => ({
    divisionId,
    minRestMinutes,
  }));
}

function toDayCapRules(byDivision: Record<string, number> | undefined) {
  return Object.entries(byDivision ?? {}).map(([divisionId, maxFixturesPerDay]) => ({
    divisionId,
    maxFixturesPerDay,
  }));
}

/**
 * Build a fully-populated request. Every field is set explicitly: the generated
 * encoder reads the message directly, so a `SolveBuildInput` cast at the call
 * seam would leave `requestId` undefined and the repeated fields non-iterable.
 */
function toRequest(input: SolveBuildInput, requestId: string): SolveBuildRequest {
  return {
    requestId,
    courts: [...input.courts],
    grid: {
      slots: input.grid.slots.map(({ court, startAtMs, dayIndex }) => ({
        court,
        startAtMs,
        dayIndex,
      })),
      stepMinutes: input.grid.stepMinutes,
    },
    fixtures: input.fixtures.map(({ fixtureId, entrantIds, divisionId }) => ({
      fixtureId,
      entrantIds: [...entrantIds],
      divisionId,
    })),
    existing: input.existing.map(({ fixtureId, court, startAtMs }) => ({
      fixtureId,
      court,
      startAtMs,
    })),
    dependencies: input.dependencies.map(({ beforeFixtureId, afterFixtureId }) => ({
      beforeFixtureId,
      afterFixtureId,
    })),
    constraints: {
      matchMinutes: input.constraints.matchMinutes,
      gapMinutes: input.constraints.gapMinutes,
      restByDivision: toRestRules(input.constraints.restByDivision),
      dayCapByDivision: toDayCapRules(input.constraints.dayCapByDivision),
    },
    wallSeconds: input.wallSeconds,
  };
}

function toOutcome(response: SolveBuildResponse): SolveBuildOutcome {
  return {
    assignments: (response.assignments ?? []).map(({ fixtureId, court, startAtMs }) => ({
      fixtureId,
      court,
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

  const client =
    injectedCall ?? clientFor(opts.host ?? process.env.CPSAT_SERVICE_HOST ?? DEFAULT_HOST);

  const metadata = new grpc.Metadata();
  metadata.set("x-internal-secret", opts.secret);

  const deadlineMs = deadlineMsFor(input);
  const request = toRequest(input, opts.requestId ?? "");
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
            resolve(toOutcome(response));
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
