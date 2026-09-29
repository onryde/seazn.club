// server/relay/fly-client.ts — a typed, retrying, redacting client for the Fly
// Machines API (owner instruction 2026-09-14: "a robust Fly.io API client",
// its own unit under runner-fly.ts). Every endpoint and field is verified
// against https://docs.machines.dev/spec/openapi3.json and the docs on
// 2026-09-14, re-verified 2026-09-20 (see the plan, Task 5A) — not written
// from memory.
//
//  * Boundary parsing: every body goes through zod; a malformed body is a
//    FlyApiError{code:"malformed"}, never an undefined field downstream.
//  * Per-request timeout (AbortSignal) + an overall deadline per operation.
//  * Bounded retries with exponential backoff + FULL jitter, only on
//    retryable failures: network error, timeout, 429 (Retry-After honoured
//    when present), 502/503/504. Never another 4xx. Rate limits are
//    documented as 1 req/s per action per machine (burst 3; Get Machine 5/10).
//    There is NO backoff FLOOR (lane-A minors, Task 5A review m4 — this line
//    claimed one and there has never been one): the jitter is FULL, so a wait's
//    minimum is 0 ms and a 429 carrying no `Retry-After` can be retried
//    immediately. What actually bounds a storm is `maxAttempts` (4) plus the
//    per-operation `deadlineMs`, and, where Fly sends one, `Retry-After`
//    verbatim. Full jitter is the deliberate choice — it is what stops several
//    sessions retrying in lockstep — so the honest statement is "bounded in
//    COUNT, not spaced by a floor". A floor would need its own measurement.
//  * Create is made idempotent HERE: a deterministic `name` (unique per app)
//    + `metadata.seazn_session`; after ANY ambiguous failure (timeout,
//    network, 5xx) the client lists by that metadata and matches the NAME before
//    retrying — and before giving up on the last attempt — so a retry never makes a
//    second Machine and a RETRYABLE failure means none exists (T5-a, T5-b).
//  * Destroy is idempotent (404 = success, C7); `force=true` by default.
//  * Redaction: the guest env carries the job token (and R2's stream key);
//    no secret reaches a message, a cause or a log line.
//  * Ruling 13: ONE stream_provider_calls row per ATTEMPT, recorded through the
//    injected recorder (telemetry.ts in production, FakeRecorder in tests).
import { z } from "zod";
// NOOP_RECORDER is a VALUE — the default when nothing is injected — so it is a
// plain import; the two names beside it are types and are erased.
import { NOOP_RECORDER } from "./ports";
import type { ProviderCallRecord, ProviderCallRecorder } from "./ports";
import { redact } from "./sanitise";

export const FLY_MACHINES_BASE = "https://api.machines.dev/v1";
export type FlyErrorCode = "http" | "network" | "timeout" | "deadline" | "malformed";

/** The Machine metadata key this client's idempotency lookup filters on
 *  (`GET /machines?metadata.seazn_session=<sid>`). It lives here, beside the
 *  lookup; `runner-fly.ts` (Task 5) re-exports it rather than spelling it a
 *  second time — two spellings of an idempotency key is two keys. */
export const SESSION_METADATA_KEY = "seazn_session";

export class FlyApiError extends Error {
  constructor(
    message: string,
    readonly code: FlyErrorCode,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly requestId: string | null,
    readonly attempts: number,
    /** Retry-After's seconds. Carried as a FIELD: the first draft of this class
     *  omitted it and `withRetry` dug the number back out of `message` with a
     *  regex, which silently stopped working the moment the message changed.
     *  The "429 waits EXACTLY Retry-After" test is what pins it. */
    readonly retryAfterSeconds: number | null = null,
  ) { super(message); this.name = "FlyApiError"; }
}

export const MachineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string(),
    instance_id: z.string().optional(),
    region: z.string().optional(),
    config: z.object({ env: z.record(z.string(), z.string()).optional(), metadata: z.record(z.string(), z.string()).optional() }).passthrough().optional(),
  })
  .passthrough();
export type Machine = z.infer<typeof MachineSchema>;

/** What `GET /machines/{id}/wait` actually answers — the spec's
 *  `WaitMachineResponse { event_id, ok, state, version }`, confirmed live on
 *  2026-09-20 as `{"ok":true,"state":"destroyed"}`. Every field is optional
 *  because the spec marks none of them required.
 *  CONSEQUENCE, stated rather than discovered (lane-A minors, Task 5A review m6):
 *  all-optional plus `.passthrough()` means this schema can refuse NO JSON object,
 *  so `waitMachine` has no reachable `malformed` case and `{}` parses with `ok`
 *  undefined. That is deliberate — requiring a field the spec does not mark
 *  required would turn a successful wait into a client-side failure — and it is why
 *  no caller may branch on `ok` alone. Anyone tightening this owes a live
 *  measurement of which fields Fly really always sends, not a reading of the spec. */
export const WaitResultSchema = z.object({ ok: z.boolean().optional(), state: z.string().optional(), event_id: z.string().optional(), version: z.string().optional() }).passthrough();
export type WaitResult = z.infer<typeof WaitResultSchema>;

export interface MachineCreateInput {
  name: string; region: string;
  config: {
    image: string; guest: { cpus: number; memory_mb: number; cpu_kind: "shared" | "performance" };
    auto_destroy: true; restart: { policy: "no" }; env: Record<string, string>;
    /** The session key is REQUIRED, not merely conventional: it is the only thing
     *  `createMachine`'s ambiguity lookup can find the Machine by, and a create
     *  that cannot be looked up cannot report a trustworthy `retryable` (C1).
     *  The type makes it hard; `createMachine` refuses at runtime as well,
     *  because a cast can walk past a type. */
    metadata: Record<string, string> & { [SESSION_METADATA_KEY]: string };
  };
}

/** The timing defaults, EXPORTED so the budget they imply can be ASSERTED rather
 *  than described. `config.ts`'s PROVISION_TIMEOUT_SECONDS and
 *  ENDING_TIMEOUT_SECONDS derivations are written against these names, and the
 *  test "the provisioning budget config.ts derives HOLDS against this client's
 *  declared defaults" recomputes that arithmetic from THIS object — so raising
 *  one of these numbers reds a gate instead of silently invalidating a comment
 *  (review I5; AGENTS.md failure class 20, a flat budget beside a derived cost).
 *  They were inline literals in the constructor before, observed by nothing. */
export const FLY_CLIENT_DEFAULTS = {
  requestTimeoutMs: 10_000,
  deadlineMs: 45_000,
  maxAttempts: 4,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  /** How long the create-ambiguity lookup waits before its ONE confirming
   *  re-list (review I6). List-after-failed-POST consistency is not documented
   *  by Fly, so an empty list is not taken as proof of absence on its own. */
  lookupSettleMs: 1_000,
} as const;

export interface FlyClientOptions {
  token: string; app: string; fetchImpl?: typeof fetch;
  clock?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number;
  requestTimeoutMs?: number; deadlineMs?: number; maxAttempts?: number; baseBackoffMs?: number; maxBackoffMs?: number;
  /** See FLY_CLIENT_DEFAULTS.lookupSettleMs. */
  lookupSettleMs?: number;
  secrets?: readonly string[];
  /** Ruling 13: one stream_provider_calls row per ATTEMPT (telemetry.ts behind it in prod; FakeRecorder in tests). */
  recorder?: ProviderCallRecorder;
}

/** What the create-ambiguity lookup can conclude. The third case is the one the
 *  first draft could not express: it returned `null` for BOTH "looked, found
 *  nothing" and "nobody looked", and the domain reads the resulting
 *  `retryable: true` as PROOF that Fly holds no Machine (carry T5-b). A lookup
 *  that was never attempted, or that could not answer, is not evidence of
 *  absence — it is the one state that must never grant attempt + 1. */
/**  `absent` carries whether the absence was CONFIRMED (the settle + confirming re-list ran) or
 *  merely observed once: `retryable: true` out of a create is the domain's licence to create
 *  attempt + 1 under a DIFFERENT name, so only a confirmed absence may earn it (re-review N-C1). */
type LookupOutcome<T> = { kind: "found"; value: T } | { kind: "absent"; confirmed: boolean } | { kind: "unknown"; why: string };

/** What `once` needs to record an attempt: the method's name, the machine it is about, the ids in the path. */
interface CallMeta { operation: string; subjectId?: string | null; sessionId?: string | null; ids: readonly string[] }

/** Review I4: the implementation moved to `sanitise.ts` — this file's SIBLING adapter owes the same
 *  floor, and one function with two homes is two functions. Re-exported so every consumer and test of
 *  this module keeps importing it from here. */
export { redact };

export function isRetryable(status: number | null, code: FlyErrorCode): boolean {
  if (code === "network" || code === "timeout") return true;
  if (code !== "http" || status === null) return false;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const ErrorBody = z.object({ error: z.string().optional() }).passthrough();

export class FlyClient {
  private readonly o: Required<Omit<FlyClientOptions, "secrets">> & { secrets: readonly string[] };
  /** The app every call is scoped to (I1: runner-fly.ts reads it off an injected client instead of defaulting one). */
  get app(): string { return this.o.app; }
  constructor(opts: FlyClientOptions) {
    this.o = {
      fetchImpl: fetch, clock: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random,
      ...FLY_CLIENT_DEFAULTS, secrets: [],
      // Ruling 13: the recorder is bound HERE, which is what makes
      // `this.o.recorder` satisfy the `Required<…>` above. `record()` keeps its
      // `?? NOOP_RECORDER` all the same — the `...opts` spread below overwrites
      // this default when a caller passes an explicit `recorder: undefined`, which
      // every optional-parameter rig in this wave does, so the branch really is
      // taken. Lane-A minors, Task 5A review m3, stated precisely because the old
      // wording ("live, not dead code") invited a test that cannot exist: taking
      // the branch has NO observable consequence. `NOOP_RECORDER.record` is empty,
      // and without the fallback the `undefined.record` TypeError is absorbed by
      // `record()`'s own `.catch(() => undefined)` — same outcome, no row either
      // way. It is defence for the day that `.catch` narrows, not a live path,
      // and no mutant can kill it.
      recorder: NOOP_RECORDER,
      ...opts,
    };
  }

  private red(s: string): string { return redact(s, [this.o.token, ...this.o.secrets]); }

  /** The guest env carries the job token (and, from R2, the stream key). Those
   *  values arrive PER REQUEST and are never in `secrets`, so every attempt
   *  adds the VALUES of the body's `config.env` to its own redaction list —
   *  otherwise Fly echoing back a rejected env value would print the token. */
  private redFor(body: unknown, s: string): string {
    const env = (body as { config?: { env?: Record<string, string> } } | undefined)?.config?.env;
    return redact(this.red(s), env ? Object.values(env) : []);
  }

  /** Ruling 13: one record per attempt, best-effort (never fails the call).
   *  `url` is the URL as fetched; `ids` = [app, ...meta.ids] so the recorder's
   *  pathTemplate turns every id into `{id}` (and a residual machine id into
   *  `{id}` by its long-hex rule). retryReason is what the retry loop will act
   *  on — `status_429`, `status_5xx`, `timeout`, `network` — or null. */
  private record(meta: CallMeta, method: ProviderCallRecord["method"], url: string, r: { status: number | null; latencyMs: number; attempt: number; requestId: string | null; retryAfterSeconds: number | null; errorCode: string | null; retryable: boolean }): void {
    const retryReason = !r.retryable ? null : r.errorCode === "timeout" || r.errorCode === "network" ? r.errorCode : r.status === 429 ? "status_429" : r.status !== null && r.status >= 500 ? "status_5xx" : null;
    void Promise.resolve()
      .then(() => (this.o.recorder ?? NOOP_RECORDER).record({
        provider: "fly", operation: meta.operation, subjectId: meta.subjectId ?? null, sessionId: meta.sessionId ?? null,
        // Lane-A minors, Task 5A review m7: `method` is now typed as the record's own
        // union all the way down from `once`, so there is no cast here. Every call
        // site passes a literal, so a method the ledger has no column for is a tsc
        // error rather than a runtime value a cast waved through.
        method, url, ids: [this.o.app, ...meta.ids],
        status: r.status, latencyMs: r.latencyMs, attempt: r.attempt, retryReason, retryAfterSeconds: r.retryAfterSeconds, requestId: r.requestId, errorCode: r.errorCode,
      }))
      .catch(() => undefined);
  }

  /** A request that never produced a body: classified for the retry loop and
   *  recorded as an attempt. An AbortError is OUR `requestTimeoutMs` firing. */
  private transportFailure(e: unknown, meta: CallMeta, method: ProviderCallRecord["method"], path: string, url: string, started: number, attempts: number): FlyApiError {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    const code = isAbort ? "timeout" : "network";
    this.record(meta, method, url, { status: null, latencyMs: this.o.clock() - started, attempt: attempts, requestId: null, retryAfterSeconds: null, errorCode: code, retryable: true });
    return new FlyApiError(`fly ${method} ${path}: ${isAbort ? "timeout" : "network error"}`, code, null, true, null, attempts);
  }

  /** ONE attempt. Returns the parsed body or throws a FlyApiError classified for the retry loop. */
  private async once<T>(method: ProviderCallRecord["method"], path: string, body: unknown, schema: z.ZodType<T> | null, attempts: number, meta: CallMeta): Promise<{ status: number; data: T | null; requestId: string | null }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.requestTimeoutMs);
    const url = `${FLY_MACHINES_BASE}/apps/${encodeURIComponent(this.o.app)}${path}`;
    const started = this.o.clock();
    // C2: ONE `finally` for the WHOLE attempt. The first draft cleared the timer
    // in a `finally` attached to the fetch alone, so the AbortSignal was already
    // disarmed by `res.text()` and a stalled body hung forever — measured
    // unsettled after 3 s at requestTimeoutMs 50, which returns NO outcome at all
    // to a create and falsifies every line of config.ts's budget derivation.
    try {
      let res: Response;
      try {
        res = await this.o.fetchImpl(url, {
          method, signal: ac.signal,
          headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        throw this.transportFailure(e, meta, method, path, url, started, attempts);
      }
      const requestId = res.headers.get("fly-request-id");
      const retryAfterHeader = res.headers.get("retry-after");
      // The anchors are load-bearing: `Retry-After` is legally an HTTP-date, and a
      // loose /\d+/ would make `Number(...)` NaN, the deadline comparison false and
      // `sleep(NaN)` a hot loop against a rate limiter. A non-numeric header falls
      // back to the jittered ladder.
      const retryAfterSeconds = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
      let text: string;
      try {
        // `abortable` is belt and braces beside the still-armed signal: a body that
        // ignores the AbortSignal (a stalled stream, a proxy that never closes) would
        // otherwise outlast every budget this client declares.
        text = await abortable(res.text(), ac.signal);
      } catch (e) {
        throw this.transportFailure(e, meta, method, path, url, started, attempts);
      }
      const latencyMs = this.o.clock() - started;
      if (!res.ok) {
        const parsed = text ? ErrorBody.safeParse(safeJson(text)) : null;
        const detail = parsed?.success ? (parsed.data.error ?? "") : text.slice(0, 200);
        const retryable = isRetryable(res.status, "http");
        this.record(meta, method, url, { status: res.status, latencyMs, attempt: attempts, requestId, retryAfterSeconds, errorCode: `http_${res.status}`, retryable });
        throw new FlyApiError(`fly ${method} ${path}: HTTP ${res.status} ${this.redFor(body, detail)}`, "http", res.status, retryable, requestId, attempts, retryAfterSeconds);
      }
      // The parse runs BEFORE the row is written (lane-A minors, Task 5A review m2).
      // Recorded above it, a 2xx whose body we could not read left a row saying the
      // call SUCCEEDED — status 200, errorCode null — and then threw `malformed`.
      // `malformed` is one of the three codes `isUnestablishedCreate` reads as "the
      // create's outcome was never established", so that row had the ledger
      // contradicting the money decision taken off the same event. `latencyMs` is
      // still the one measured at the end of the body read: parsing is ours, not Fly's.
      const parsed = schema ? schema.safeParse(safeJson(text)) : null;
      this.record(meta, method, url, { status: res.status, latencyMs, attempt: attempts, requestId, retryAfterSeconds: null, errorCode: parsed !== null && !parsed.success ? "malformed" : null, retryable: false });
      if (parsed === null) return { status: res.status, data: null, requestId };
      if (!parsed.success) throw new FlyApiError(`fly ${method} ${path}: malformed response (${this.redFor(body, parsed.error.issues[0]?.message ?? "unparseable")})`, "malformed", res.status, false, requestId, attempts);
      return { status: res.status, data: parsed.data, requestId };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The retry loop: full jitter, Retry-After, maxAttempts, the deadline.
   *  `op` receives the ATTEMPT NUMBER and hands it to `once`, so each
   *  stream_provider_calls row and each error says which attempt it was —
   *  passing a literal 0 there (the first draft) made every row read "0". */
  private async withRetry<T>(op: (attempt: number) => Promise<T>, onAmbiguous?: (lastAttempt: boolean) => Promise<LookupOutcome<T>>): Promise<T> {
    const started = this.o.clock();
    for (let attempt = 1; ; attempt++) {
      try {
        return await op(attempt);
      } catch (e) {
        const err = e instanceof FlyApiError ? e : new FlyApiError(this.red(String((e as Error)?.message ?? e)), "network", null, true, null, attempt);
        if (!err.retryable) throw withAttempts(err, attempt);
        // The next wait is computed BEFORE the lookup, because whether this call is ENDING decides
        // what the lookup has to prove. There are two terminal exits that carry `retryable` out —
        // attempts exhausted, and the deadline — and the first draft told the lookup about only the
        // first (re-review N-C1): a create whose deadline blew on attempt 1 reported `retryable: true`
        // on ONE unsettled list. That is the C1 breach by another door: the domain's retry posts
        // `relay-<sid>-r2`, a name Fly has no reason to refuse, so the r1 Machine — if Fly held one —
        // is orphaned under a name no row carries.
        const retryAfter = err.status === 429 && err.retryAfterSeconds !== null ? err.retryAfterSeconds * 1000 : null;
        const wait = retryAfter ?? Math.floor(Math.min(this.o.maxBackoffMs, this.o.baseBackoffMs * 2 ** (attempt - 1)) * this.o.random());
        const ending = attempt >= this.o.maxAttempts || this.o.clock() - started + wait > this.o.deadlineMs;
        // An operation with no lookup cannot have created anything, so there is no absence to
        // establish and its retryable stays exactly as it was (a list, a get, a destroy).
        let absenceConfirmed = !onAmbiguous;
        if (onAmbiguous) {
          // T5-b (post-2C plan sync): a RETRYABLE create failure reaches the domain as `create_failed { retryable: true }`, which
          // lets the runner table schedule attempt + 1 (invariant 1) — so it must MEAN "Fly holds no Machine under this name".
          // Every ambiguous failure is looked up, the LAST attempt's included (the first draft threw at maxAttempts before
          // looking, and a create that timed out on its final try reported retryable with its Machine booting); a deadline
          // below is reached only after this lookup found nothing. Only an `absent` verdict lets the retryable error out:
          // a lookup that could not answer — or could not even be attempted (C1) — is `unknown` and is downgraded here.
          let outcome: LookupOutcome<T>;
          try {
            outcome = await onAmbiguous(ending);
          } catch (lookupErr) {
            outcome = { kind: "unknown", why: this.red(String((lookupErr as Error)?.message ?? lookupErr)) };
          }
          if (outcome.kind === "found") return outcome.value;
          if (outcome.kind === "unknown") {
            throw new FlyApiError(`fly: create outcome unknown — the lookup after "${err.message}" could not answer (${outcome.why})`, err.code, err.status, false, err.requestId, attempt);
          }
          absenceConfirmed = outcome.confirmed;
        }
        // Both terminal exits ask the same question, and neither may answer `retryable: true` on an
        // absence nobody established. `ending` normally makes the lookup confirm before either is
        // reached; it can still be false here when the LOOKUP ITSELF is what consumed the budget,
        // and that race is exactly what this refuses to hand the domain as proof of absence.
        // THE INVARIANT, named so a "simplification" cannot perform S1 invisibly (lane-A
        // minors, Task 5A re-review 2): `absenceConfirmed` is ALREADY true on every path
        // that reaches this line with a lookup behind it — `ending` is true here by
        // construction, so the `if (onAmbiguous)` block above has run, and its only
        // fall-through arm assigns `outcome.confirmed`. Replacing the argument with
        // `true` therefore SURVIVES every test, and it is not a defect today. It is kept
        // because the equivalence is TEXTUAL — two expressions twenty-odd lines apart —
        // and the moment either moves, passing `true` re-opens N-C1: a create reporting
        // `retryable: true` on an absence nobody established, which is the domain's
        // licence to start a second Machine. Do not inline it.
        if (attempt >= this.o.maxAttempts) throw withAttempts(err, attempt, absenceConfirmed);
        if (this.o.clock() - started + wait > this.o.deadlineMs) {
          const unproven = absenceConfirmed ? "" : " — and the Machine's absence was never confirmed, so this is not a licence to create another";
          throw new FlyApiError(`fly: deadline of ${this.o.deadlineMs} ms exceeded after ${attempt} attempt(s) (${err.message})${unproven}`, "deadline", err.status, absenceConfirmed, err.requestId, attempt);
        }
        await this.o.sleep(wait);
      }
    }
  }

  async createMachine(input: MachineCreateInput): Promise<Machine> {
    const sessionKey = input.config.metadata[SESSION_METADATA_KEY];
    const meta: CallMeta = { operation: "createMachine", ids: [], sessionId: sessionKey ?? null };
    return this.withRetry(
      async (attempt) => (await this.once("POST", "/machines", input, MachineSchema, attempt, meta)).data!,
      async (ending): Promise<LookupOutcome<Machine>> => {
        // C1: with no session key there is nothing to look the Machine up BY, so no lookup is
        // possible. That is `unknown`, never `absent` — returning "nothing there" here reported
        // `retryable: true` after ZERO GETs, and the domain would have read that as proof Fly
        // holds nothing while a Machine booted under a name no row carries.
        if (!sessionKey) return { kind: "unknown", why: `the create carries no ${SESSION_METADATA_KEY} metadata, so there is nothing to look it up by` };
        // T5-a: by NAME — the session's metadata also lists an EARLIER attempt's Machine, and `found[0]` handed that one back
        // as this create's. T5-b: no `.catch(() => [])` — a lookup that failed must never read as "nothing there"; it throws,
        // and `withRetry` turns the throw into `unknown`.
        const mine = (ms: readonly Machine[]): Machine | undefined => ms.find((m) => m.name === input.name);
        const found = mine(await this.listMachines({ metadata: { [SESSION_METADATA_KEY]: sessionKey } }));
        if (found) return { kind: "found", value: found };
        // I6: an empty answer only has to be RIGHT when this call is ENDING — at maxAttempts, or
        // because the next wait already ends past the deadline (N-C1: the deadline is a terminal
        // exit too, and telling the lookup about only maxAttempts left it unconfirmed there).
        // Mid-ladder an empty answer merely permits another POST under the SAME name, which Fly
        // refuses 409 rather than duplicating (measured 2026-09-20). Ending, the same empty answer
        // would become `retryable: true`, which the domain reads as proof of absence AND acts on
        // under a DIFFERENT name — so it is confirmed once after a settle, and the verdict says
        // which of the two it is. The confirm is a SINGLE attempt: one that cannot answer throws,
        // and `unknown` is the right verdict for "we still do not know".
        if (!ending) return { kind: "absent", confirmed: false };
        await this.o.sleep(this.o.lookupSettleMs);
        const confirmed = mine((await this.once("GET", this.listPath({ metadata: { [SESSION_METADATA_KEY]: sessionKey } }), undefined, z.array(MachineSchema), 1, { operation: "listMachines", ids: [] })).data!);
        return confirmed ? { kind: "found", value: confirmed } : { kind: "absent", confirmed: true };
      },
    );
  }

  async getMachine(id: string): Promise<Machine | null> {
    const meta: CallMeta = { operation: "getMachine", ids: [id], subjectId: id };
    return this.withRetry(async (attempt) => {
      try {
        return (await this.once("GET", `/machines/${encodeURIComponent(id)}`, undefined, MachineSchema, attempt, meta)).data;
      } catch (e) {
        if (e instanceof FlyApiError && e.status === 404) return null;
        throw e;
      }
    });
  }

  /** One spelling of the list path, so `listMachines` and the I6 confirm cannot drift apart. */
  private listPath(opts: { metadata?: Record<string, string>; includeDeleted?: boolean }): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.metadata ?? {})) q.set(`metadata.${k}`, v);
    if (opts.includeDeleted) q.set("include_deleted", "true");
    const qs = q.toString();
    return `/machines${qs ? `?${qs}` : ""}`;
  }

  async listMachines(opts: { metadata?: Record<string, string>; includeDeleted?: boolean } = {}): Promise<Machine[]> {
    const path = this.listPath(opts);
    const meta: CallMeta = { operation: "listMachines", ids: [] };
    return this.withRetry(async (attempt) => (await this.once("GET", path, undefined, z.array(MachineSchema), attempt, meta)).data!);
  }

  async destroyMachine(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force ?? true;
    const meta: CallMeta = { operation: "destroyMachine", ids: [id], subjectId: id };
    await this.withRetry(async (attempt) => {
      try {
        await this.once("DELETE", `/machines/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, undefined, null, attempt, meta);
      } catch (e) {
        if (e instanceof FlyApiError && e.status === 404) return; // C7: absent is success
        throw e;
      }
    });
  }

  /** MEASURED 2026-09-20 against the real API, and the brief had it wrong: the
   *  wait endpoint does NOT answer with a Machine. It answers
   *  `WaitMachineResponse { event_id?, ok?, state?, version? }` — live body
   *  `{"ok":true,"state":"destroyed"}` — so parsing it as a `Machine` made EVERY
   *  wait fail as `malformed` (three live tests died on it). The caller that
   *  needs the Machine re-reads it with `getMachine`.
   *
   *  It is also a LONG POLL: its per-request budget (`requestTimeoutMs`) has to
   *  exceed the `timeoutSeconds` it asks Fly to hold the connection for, or the
   *  client's own AbortSignal fires first and a perfectly healthy wait reads as
   *  a timeout, burning `maxAttempts` at `requestTimeoutMs` each. The default
   *  pair (10 s request budget, 60 s wait) does exactly that — every caller
   *  sizes the two together.
   *
   *  `timeoutSeconds` is CAPPED AT 60 by Fly: 90 comes back HTTP 400
   *  invalid_argument, "value must be inside range [1s, 1m0s]" (measured
   *  2026-09-20). It is not clamped here — a silent wait shorter than the one
   *  asked for is worse than a refusal — so a caller that needs longer loops.
   *  And on an `auto_destroy` Machine, `state: "stopped"` is often never
   *  observable: the Machine is removed the instant it exits, and the wait
   *  answers HTTP 404. Wait for "destroyed". */
  async waitMachine(id: string, state: "started" | "stopped" | "destroyed", timeoutSeconds = 60): Promise<WaitResult> {
    const meta: CallMeta = { operation: "waitMachine", ids: [id], subjectId: id };
    return this.withRetry(async (attempt) =>
      (await this.once("GET", `/machines/${encodeURIComponent(id)}/wait?state=${state}&timeout=${timeoutSeconds}`, undefined, WaitResultSchema, attempt, meta)).data!,
    );
  }

  /** The stop sequence's first step: POST /machines/{id}/stop { signal, timeout }
   *  (spec: signal defaults to SIGINT; timeout is seconds before SIGKILL). 404
   *  and an already-stopped Machine are success — the caller observes. */
  async stopMachine(id: string, opts: { signal: "SIGINT" | "SIGTERM"; timeoutSeconds: number }): Promise<void> {
    const meta: CallMeta = { operation: "stopMachine", ids: [id], subjectId: id };
    await this.withRetry(async (attempt) => {
      try {
        await this.once("POST", `/machines/${encodeURIComponent(id)}/stop`, { signal: opts.signal, timeout: `${opts.timeoutSeconds}s` }, null, attempt, meta);
      } catch (e) {
        if (e instanceof FlyApiError && e.status === 404) return;
        throw e;
      }
    });
  }

  /** POST /machines/{id}/signal — the spec's enum; used only by the live test to force an exit code. */
  async signalMachine(id: string, signal: "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGKILL" | "SIGUSR1" | "SIGUSR2" | "SIGTERM"): Promise<void> {
    const meta: CallMeta = { operation: "signalMachine", ids: [id], subjectId: id };
    await this.withRetry(async (attempt) => { await this.once("POST", `/machines/${encodeURIComponent(id)}/signal`, { signal }, null, attempt, meta); });
  }

  /** GET /machines/{id}/events — `request` is untyped in the spec; the exit payload is read DEFENSIVELY. */
  async machineEvents(id: string): Promise<MachineEvent[]> {
    const meta: CallMeta = { operation: "machineEvents", ids: [id], subjectId: id };
    return this.withRetry(async (attempt) =>
      (await this.once("GET", `/machines/${encodeURIComponent(id)}/events`, undefined, z.array(MachineEventSchema), attempt, meta)).data!,
    );
  }
}

export const MachineEventSchema = z
  .object({
    id: z.string().optional(), type: z.string(), status: z.string().optional(), source: z.string().optional(), timestamp: z.number().optional(),
    request: z
      .object({
        exit_event: z
          .object({ exit_code: z.number().optional(), oom_killed: z.boolean().optional(), requested_stop: z.boolean().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      // MEASURED 2026-09-20: Fly sends `"request": null` on every launch and
      // destroy event. `.optional()` alone (the brief's shape) rejects null, so
      // the whole events array failed to parse against the REAL payload — a
      // `machineEvents` that can never answer for a Machine that was destroyed.
      .nullish(),
  })
  .passthrough();
export type MachineEvent = z.infer<typeof MachineEventSchema>;

/** The most recent exit the events carry, or null. Every field optional: the
 *  spec does not type the exit payload (verified 2026-09-14, re-verified
 *  2026-09-20: `MachineEvent.request` is a bare `type: object`) and the live
 *  test records what Fly sends; an absent field is null, never a guess. The
 *  live payload carries `exit_code`, `oom_killed` and `requested_stop` exactly
 *  as named, beside `guest_exit_code`, `guest_signal`, `signal`, `error`,
 *  `restarting` and `exited_at`, which passthrough keeps.
 *
 *  ORDER: Fly returns events NEWEST FIRST (measured 2026-09-20 — the array ends
 *  with `launch`). The brief's `[...events].reverse().find(…)` assumed the
 *  opposite and would hand back the OLDEST exit whenever a Machine has more than
 *  one. Nothing here depends on the array's direction any more: the greatest
 *  `timestamp` wins, and a tie keeps the earliest index — which is the newest
 *  under Fly's ordering. */
export function exitInfoFrom(events: readonly MachineEvent[]): { exitCode: number | null; oomKilled: boolean | null; requestedStop: boolean | null } | null {
  const exits = events.filter((e) => e.type === "exit" || e.request?.exit_event);
  if (exits.length === 0) return null;
  let newest = exits[0]!;
  for (const e of exits) if ((e.timestamp ?? -Infinity) > (newest.timestamp ?? -Infinity)) newest = e;
  const ev = newest.request?.exit_event;
  return { exitCode: ev?.exit_code ?? null, oomKilled: ev?.oom_killed ?? null, requestedStop: ev?.requested_stop ?? null };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Resolve with `p`, or reject the moment `signal` aborts. The AbortSignal is
 *  already wired into `fetch`, but nothing obliges a RESPONSE BODY to honour it,
 *  and an unbounded `res.text()` is exactly the hang C2 was: no outcome at all
 *  for the caller, past every budget this client declares. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** `absenceConfirmed` false DOWNGRADES a retryable error: it is only ever passed from a create,
 *  where `retryable` means "Fly holds no Machine" and not merely "the call failed" (N-C1). */
function withAttempts(err: FlyApiError, attempts: number, absenceConfirmed = true): FlyApiError {
  const message = absenceConfirmed ? err.message : `${err.message} — and the Machine's absence was never confirmed, so this is not a licence to create another`;
  return new FlyApiError(message, err.code, err.status, err.retryable && absenceConfirmed, err.requestId, attempts, err.retryAfterSeconds);
}
