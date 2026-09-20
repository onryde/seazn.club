// server/relay/runner-fly.ts — Fly Machines behind RunnerProvider (design
// §7.1), over fly-client.ts (Task 5A: retries, timeouts, idempotency,
// redaction live THERE). `create` is 1:1 onto POST /v1/apps/{app}/machines in
// FIELDS, with `cpuClass` translated to Fly's `cpu_kind` here and nowhere
// else. Values that are load-bearing, each with its measurement:
//  * guest performance-4x / 8 GB — owner ruling 2026-09-13 (C7); Fly refuses
//    performance-8x under 16384 MB, which is why the size is a FIELD the
//    caller passes from config.ts, not a driver default that could drift.
//  * auto_destroy: true — fires on a NON-ZERO exit too (R0 watch 4 closed:
//    Machine `destroyed`, absent from the list).
//  * restart.policy "no" — D4: the lazy expiry path is the only retry
//    authority; any other policy puts two encoders on one stream key.
//  * name `machineNameFor(sessionId, attempt)` — i.e. `relay-<sid>-r<attempt>`,
//    the domain's own spelling (domain/runner.ts), never a second one here —
//    plus metadata.seazn_session: together the client's idempotency key, so a
//    retry after a timeout finds THIS Machine. The attempt is IN the name
//    because Fly ALLOWS a destroyed Machine's name to be reused (measured
//    2026-09-20), so a 409 always means a LIVE Machine holds it.
//  * env RELAY_DEADLINE_AT — recommendation B's hard stop: the R2 supervisor
//    exits at that instant on its own; auto_destroy takes the Machine down.
//
// This adapter is the money path: three outcomes of a create are handled here
// rather than left to the caller, because each of them can strand a paid
// Machine or start a second one — the 409 adopt (T5-c), the unestablished
// create (T5-g), and the untouched pass-through of the client's `retryable`,
// which is the domain's licence to create attempt + 1 (T5-b).
import { FLY_MACHINES_BASE, FlyApiError, FlyClient, SESSION_METADATA_KEY, exitInfoFrom, isRetryable, type Machine } from "./fly-client";
import { machineNameFor, type ObservedRunnerState, type RunnerTrigger } from "./domain/runner";
import type { ProviderCallRecorder, RunnerHandle, RunnerListing, RunnerObservation, RunnerProvider, RunnerSpec } from "./ports";
import { NOOP_RECORDER } from "./ports";

export const FLY_RELAY_APP_DEFAULT = "seazn-relay";
/** Defined in fly-client.ts, beside the metadata lookup that uses it — two
 *  spellings of an idempotency key is two keys. Re-exported so every consumer
 *  and test keeps importing it from one place. */
export { SESSION_METADATA_KEY };

/** The `error_code` a `stream_provider_calls` row carries when a create's
 *  OUTCOME was never established (T5-g). Its own value, not an HTTP status:
 *  "Fly refused the create" and "we do not know whether Fly holds a Machine"
 *  are different operational events, and only the second one may not be retried
 *  under a new name. */
export const CREATE_OUTCOME_UNKNOWN = "create_outcome_unknown";

export function cpuKindFor(cpuClass: "shared" | "dedicated"): "shared" | "performance" {
  return cpuClass === "dedicated" ? "performance" : "shared";
}

/** The plan's "Fly state → observed input" table (fly.io/docs/machines/machine-states,
 *  verified 2026-09-14, RE-FETCHED 2026-09-20: the page lists exactly these
 *  seventeen and marks none deprecated). The ONLY place Fly's state spelling is
 *  read. `destroying` is terminal-in-progress, not a contradiction: C1 measured
 *  that the GET right after `wait destroyed` can still answer `destroying`. */
export const FLY_STATE_MAP: Record<string, ObservedRunnerState> = {
  created: "pending", creating: "pending", starting: "pending", updating: "pending", replacing: "pending", restarting: "pending",
  started: "running",
  stopping: "stopping", suspending: "stopping",
  stopped: "stopped", suspended: "stopped",
  failed: "failed", launch_failed: "failed",
  destroying: "destroying",
  destroyed: "destroyed", replaced: "destroyed", migrated: "destroyed",
};
export function fromFlyState(state: string | null | undefined): ObservedRunnerState {
  // `Object.hasOwn`, never a bare `MAP[state]`: `state` is a `z.string()` straight off
  // Fly's JSON, and a plain object answers for every key Object.prototype carries —
  // `"constructor"` returned the `Object` FUNCTION and `"__proto__"` the prototype, i.e.
  // values this function's own declared return type forbids and tsc cannot see (lane-A
  // minors, Task 5 review M1). Own-property only; anything else is the typed `unknown`,
  // never a crash and never "running".
  if (state === null || state === undefined || !Object.hasOwn(FLY_STATE_MAP, state)) return "unknown";
  return FLY_STATE_MAP[state] ?? "unknown";
}

/** T5-g. `fly-client.ts` reports "the create's outcome is unknown" by DOWNGRADING
 *  a retryable failure to `retryable: false` — that is the whole of T5-b:
 *  `retryable: true` out of a create is the domain's licence to create attempt + 1
 *  under a DIFFERENT name, so a lookup that could not answer must not grant it.
 *  The observable shape is therefore "a failure of a kind the client RETRIES (or
 *  the operation's own deadline, or a 2xx body we could not parse), and yet
 *  `retryable` is false". Read off the FIELDS, never off the message — the
 *  message is our own formatting and would stop matching the moment it changed. */
export function isUnestablishedCreate(e: unknown): e is FlyApiError {
  if (!(e instanceof FlyApiError) || e.retryable) return false;
  return e.code === "deadline" || e.code === "malformed" || isRetryable(e.status, e.code);
}

/** Whole-branch review I2 (money). The domain's `create_failed` trigger BUILT from the error a create threw — this
 *  adapter is the only place that knows whether Fly may still hold a Machine, and before this the fact was computed
 *  (`isUnestablishedCreate`), written to one telemetry row, and thrown away. The domain then landed BOTH arms of
 *  `creating × create_failed` on `destroyed` — the state that means CONFIRMED gone — with no teardown, so an
 *  unestablished create left a Machine running to RELAY_DEADLINE_AT, billing and pushing to the organiser's
 *  destination, until the daily orphan sweep.
 *
 *  Lane A owes the CONTRACT and this helper; Task 10's create call site is not ours to write. It catches the throw
 *  from `create` and feeds the result straight to `stepRunner` / `decide`.
 *
 *  Read off the FIELDS, never the message (T5-g). An error that is not a `FlyApiError` at all is the safe-direction
 *  default — unknown, not assumed-clean: the cost of being wrong that way is one extra force_destroy by name, which
 *  the provider answers as success when nothing is there; the cost of the other way is up to MAX_DURATION_MINUTES of
 *  a Machine nobody is watching. A 409 never reaches here — `create` adopts it (T5-c). */
export function createFailedFrom(e: unknown): Extract<RunnerTrigger, { type: "create_failed" }> {
  if (!(e instanceof FlyApiError)) return { type: "create_failed", retryable: false, outcomeUnknown: true };
  return { type: "create_failed", retryable: e.retryable, outcomeUnknown: isUnestablishedCreate(e) };
}

/** The port's three-value summary of a Machine the provider still holds.
 *  Review I3: derived from `fromFlyState`, NOT from Fly's raw state. Reading the
 *  raw state here made `suspended` answer `"other"` from `list()` and `"stopped"`
 *  from `observe()` — one vocabulary read two ways in one file, with only the
 *  map swept for parity. Anything that is neither running nor stopped is
 *  `"other"`, and that INCLUDES a Machine still coming up: Task 10's orphan
 *  sweep must not read `"other"` as "not alive" (measured live 2026-09-20 — a
 *  `created` Machine lists as `"other"` and bills like any other). */
function listStateOf(m: Machine): RunnerListing["state"] {
  const observed = fromFlyState(m.state);
  return observed === "running" ? "running" : observed === "stopped" ? "stopped" : "other";
}

function listingOf(m: Machine): RunnerListing {
  return {
    runnerId: m.id,
    sessionId: m.config?.metadata?.[SESSION_METADATA_KEY] ?? null,
    name: m.name || null, // T5-a: `machineNameFor(sessionId, attempt)` for ours — the attempt identity Task 10 matches on
    state: listStateOf(m),
  };
}

/** The id Fly names in its duplicate-name refusal. Measured body (2026-09-20):
 *  `already_exists: unique machine name violation, machine ID <id> already
 *  exists with name "<name>"`. The id is not a secret, so it survives redaction. */
function machineIdNamedIn(message: string): string | null {
  return /machine ID ([0-9A-Za-z_-]+)/.exec(message)?.[1] ?? null;
}

export class FlyRunner implements RunnerProvider {
  private readonly client: FlyClient;
  private readonly image: string;
  private readonly app: string;
  /** The adapter's OWN recorder, for the one row the client cannot produce (the
   *  unestablished-create mark, which is a verdict about a whole operation rather
   *  than an attempt). A caller-supplied client keeps its own for per-attempt rows. */
  private readonly rec: ProviderCallRecorder;

  constructor(opts: { client?: FlyClient; token?: string; app?: string; image?: string; recorder?: ProviderCallRecorder } = {}) {
    const image = opts.image ?? process.env.RELAY_IMAGE;
    this.app = opts.app ?? process.env.FLY_RELAY_APP ?? FLY_RELAY_APP_DEFAULT;
    this.rec = opts.recorder ?? NOOP_RECORDER;
    if (!opts.client) {
      const token = opts.token ?? process.env.FLY_API_TOKEN;
      if (!token) throw new Error("FLY_API_TOKEN is not set (RELAY_DRIVERS=live needs it)");
      if (!image) throw new Error("RELAY_IMAGE is not set (the seazn-relay image R2 builds; RELAY_DRIVERS=live needs it)");
      // Ruling 13: the recorder goes to the client it BUILDS.
      this.client = new FlyClient({ token, app: this.app, recorder: opts.recorder });
    } else {
      if (!image) throw new Error("RELAY_IMAGE is not set (the seazn-relay image R2 builds; RELAY_DRIVERS=live needs it)");
      this.client = opts.client;
    }
    this.image = image;
  }

  async create(spec: RunnerSpec): Promise<RunnerHandle> {
    const name = machineNameFor(spec.sessionId, spec.attempt);
    try {
      const m = await this.client.createMachine({
        name,
        region: spec.region,
        config: {
          image: this.image,
          guest: { cpus: spec.guest.cpus, memory_mb: spec.guest.memoryMb, cpu_kind: cpuKindFor(spec.guest.cpuClass) },
          auto_destroy: true,
          restart: { policy: "no" },
          env: { SESSION_ID: spec.sessionId, JOB_TOKEN: spec.jobToken, APP_URL: spec.appUrl, RELAY_DEADLINE_AT: spec.deadlineAt.toISOString() },
          metadata: { [SESSION_METADATA_KEY]: spec.sessionId },
        },
      });
      return { runnerId: m.id };
    } catch (e) {
      if (e instanceof FlyApiError && e.status === 409) return { runnerId: (await this.adoptNamed(name, spec.sessionId, e)).id };
      if (isUnestablishedCreate(e)) this.markUnestablished(spec, e);
      throw e;
    }
  }

  /** T5-c (SAFETY, money path). `409 already_exists` is NOT retryable, and it is
   *  the one create error where a Machine DOES exist — so it never reaches the
   *  client's ambiguity lookup, and reporting it as a create failure strands a
   *  RUNNING Machine: the domain fails the session, no row holds the id, and the
   *  compositor bills until the daily orphan sweep lists it. The named Machine is
   *  ADOPTED instead.
   *
   *  Adoption is safe on IDENTITY grounds and only on those: the name is
   *  `machineNameFor(sessionId, attempt)`, so the only thing that can hold it is
   *  our own earlier create for this same session and attempt (T5-a — identity is
   *  what was REQUESTED). Every handle below is therefore VERIFIED by name before
   *  it is adopted; a Machine under any other name is a stranger's and is refused.
   *
   *  Two handles, because either can be blind:
   *    1. the id in the refusal — authoritative the instant Fly refuses, and the
   *       only handle that works inside Fly's undocumented list-consistency window;
   *    2. the session metadata lookup — still answers if the refusal's wording
   *       changes under us, or names no id at all.
   *  A handle that cannot answer is swallowed rather than thrown, because the
   *  fallback below is a NON-retryable refusal that names the collision — never a
   *  claim of absence, so T5-b is not weakened by it (diffed against the client's
   *  N-C1 finding: no path here can report `retryable: true`).
   *
   *  The adopted Machine's STATE is not filtered. A 409 means a live Machine holds
   *  the name, but if one were somehow terminal the honest answer is still "this is
   *  the Machine that holds your name": the lifecycle then observes it destroyed
   *  and takes its one retry under `-r<attempt+1>`. Inventing a second POST here
   *  would be the invariant-1 breach this whole path exists to prevent. */
  private async adoptNamed(name: string, sessionId: string, refusal: FlyApiError): Promise<Machine> {
    const named = machineIdNamedIn(refusal.message);
    if (named) {
      // Review I1 — DO NOT "let the real error through, it's more informative".
      // `getMachine` has no `onAmbiguous`, so its 503 keeps `retryable: true`
      // (fly-client.ts, `withAttempts`' default) and escaping with it would tell
      // the domain Fly holds NO Machine — inside the one refusal that PROVES it
      // does. The 409 below is the only honest answer. Pinned by
      // "T5-c/I1: the named-id handle failing must not turn a 409 into a retryable".
      const m = await this.client.getMachine(named).catch(() => null);
      if (m && m.name === name) return m;
    }
    const listed = await this.client
      .listMachines({ metadata: { [SESSION_METADATA_KEY]: sessionId } })
      .then((ms) => ms.find((m) => m.name === name) ?? null)
      // Review I1, the second half: same argument, and it is a SEPARATE guard —
      // the two do not cover for each other, so each has its own defeating case.
      // Pinned by "T5-c/I1: the session-lookup handle failing …".
      .catch(() => null);
    if (listed) return listed;
    throw new FlyApiError(
      `fly: a Machine already holds the name ${name} and could not be adopted (${refusal.message}) — do NOT create another under this name`,
      "http", 409, false, refusal.requestId, refusal.attempts,
    );
  }

  /** T5-g: one row of its own, so a transient LIST outage that fails a session is
   *  visible as what it is and not as an ordinary create refusal. Best-effort, like
   *  every other record (the port's contract: a recorder never fails the call).
   *  The per-attempt rows are the client's; this is the operation's verdict, so it
   *  carries no latency and the attempt count the error ended on. */
  private markUnestablished(spec: RunnerSpec, e: FlyApiError): void {
    void Promise.resolve()
      .then(() =>
        this.rec.record({
          provider: "fly", operation: "createMachine", subjectId: null, sessionId: spec.sessionId,
          method: "POST", url: `${FLY_MACHINES_BASE}/apps/${encodeURIComponent(this.app)}/machines`, ids: [this.app],
          status: e.status, latencyMs: 0, attempt: e.attempts,
          retryReason: null, retryAfterSeconds: null, requestId: e.requestId, errorCode: CREATE_OUTCOME_UNKNOWN,
        }),
      )
      .catch(() => undefined);
  }

  /** The stop sequence's signal (plan §"Fly machine lifecycle"): SIGINT + the grace as Fly's `timeout`. */
  async stop(runnerId: string, opts: { signal: "SIGINT"; timeoutSeconds: number }): Promise<void> {
    await this.client.stopMachine(runnerId, { signal: opts.signal, timeoutSeconds: opts.timeoutSeconds }); // 404 = already gone, inside the client
  }

  /** GET the Machine and, when it is not still coming up or running, its events for
   *  the exit payload.
   *
   *  C1, measured and against the brief's premise: a DESTROYED Machine answers GET
   *  200 with `state: "destroyed"` — 404 means the id never existed. Both land on
   *  `destroyed` here, but only the 200 has events to read, which is why the events
   *  are fetched for every non-running state rather than only for a stopped one. */
  async observe(runnerId: string): Promise<RunnerObservation> {
    const m = await this.client.getMachine(runnerId);
    if (!m) return { state: "destroyed", exit: null };
    const state = fromFlyState(m.state);
    if (state === "running" || state === "pending") return { state, exit: null };
    const events = await this.client.machineEvents(runnerId).catch((e: unknown) => (e instanceof FlyApiError && e.status === 404 ? [] : Promise.reject(e)));
    return { state, exit: exitInfoFrom(events) };
  }

  async destroy(runnerId: string): Promise<void> {
    await this.client.destroyMachine(runnerId, { force: true }); // 404 = success (C7), inside the client
  }

  async list(): Promise<RunnerListing[]> {
    return (await this.client.listMachines()).map(listingOf);
  }
}
