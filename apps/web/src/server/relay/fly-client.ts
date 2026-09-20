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
//    documented as 1 req/s per action per machine (burst 3; Get Machine 5/10)
//    — the backoff floor keeps a retry storm under that.
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
 *  because the spec marks none of them required. */
export const WaitResultSchema = z.object({ ok: z.boolean().optional(), state: z.string().optional(), event_id: z.string().optional(), version: z.string().optional() }).passthrough();
export type WaitResult = z.infer<typeof WaitResultSchema>;

export interface MachineCreateInput {
  name: string; region: string;
  config: {
    image: string; guest: { cpus: number; memory_mb: number; cpu_kind: "shared" | "performance" };
    auto_destroy: true; restart: { policy: "no" }; env: Record<string, string>; metadata: Record<string, string>;
  };
}

export interface FlyClientOptions {
  token: string; app: string; fetchImpl?: typeof fetch;
  clock?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number;
  requestTimeoutMs?: number; deadlineMs?: number; maxAttempts?: number; baseBackoffMs?: number; maxBackoffMs?: number;
  secrets?: readonly string[];
  /** Ruling 13: one stream_provider_calls row per ATTEMPT (telemetry.ts behind it in prod; FakeRecorder in tests). */
  recorder?: ProviderCallRecorder;
}

/** What `once` needs to record an attempt: the method's name, the machine it is about, the ids in the path. */
interface CallMeta { operation: string; subjectId?: string | null; sessionId?: string | null; ids: readonly string[] }

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join("[redacted]");
  return out;
}

export function isRetryable(status: number | null, code: FlyErrorCode): boolean {
  if (code === "network" || code === "timeout") return true;
  if (code !== "http" || status === null) return false;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const ErrorBody = z.object({ error: z.string().optional() }).passthrough();

export class FlyClient {
  private readonly o: Required<Omit<FlyClientOptions, "secrets">> & { secrets: readonly string[] };
  constructor(opts: FlyClientOptions) {
    this.o = {
      fetchImpl: fetch, clock: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random,
      requestTimeoutMs: 10_000, deadlineMs: 45_000, maxAttempts: 4, baseBackoffMs: 500, maxBackoffMs: 8_000, secrets: [],
      // Ruling 13: the recorder is bound HERE, which is what makes
      // `this.o.recorder` satisfy the `Required<…>` above. `record()` keeps its
      // `?? NOOP_RECORDER` all the same — the `...opts` spread below overwrites
      // this default when a caller passes an explicit `recorder: undefined`, so
      // that fallback is live, not dead code.
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
  private record(meta: CallMeta, method: string, url: string, r: { status: number | null; latencyMs: number; attempt: number; requestId: string | null; retryAfterSeconds: number | null; errorCode: string | null; retryable: boolean }): void {
    const retryReason = !r.retryable ? null : r.errorCode === "timeout" || r.errorCode === "network" ? r.errorCode : r.status === 429 ? "status_429" : r.status !== null && r.status >= 500 ? "status_5xx" : null;
    void Promise.resolve()
      .then(() => (this.o.recorder ?? NOOP_RECORDER).record({
        provider: "fly", operation: meta.operation, subjectId: meta.subjectId ?? null, sessionId: meta.sessionId ?? null,
        method: method as ProviderCallRecord["method"], url, ids: [this.o.app, ...meta.ids],
        status: r.status, latencyMs: r.latencyMs, attempt: r.attempt, retryReason, retryAfterSeconds: r.retryAfterSeconds, requestId: r.requestId, errorCode: r.errorCode,
      }))
      .catch(() => undefined);
  }

  /** ONE attempt. Returns the parsed body or throws a FlyApiError classified for the retry loop. */
  private async once<T>(method: string, path: string, body: unknown, schema: z.ZodType<T> | null, attempts: number, meta: CallMeta): Promise<{ status: number; data: T | null; requestId: string | null }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.requestTimeoutMs);
    const url = `${FLY_MACHINES_BASE}/apps/${encodeURIComponent(this.o.app)}${path}`;
    const started = this.o.clock();
    let res: Response;
    try {
      res = await this.o.fetchImpl(url, {
        method, signal: ac.signal,
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const isAbort = (e as { name?: string })?.name === "AbortError";
      const code = isAbort ? "timeout" : "network";
      this.record(meta, method, url, { status: null, latencyMs: this.o.clock() - started, attempt: attempts, requestId: null, retryAfterSeconds: null, errorCode: code, retryable: true });
      throw new FlyApiError(`fly ${method} ${path}: ${isAbort ? "timeout" : "network error"}`, code, null, true, null, attempts);
    } finally {
      clearTimeout(timer);
    }
    const requestId = res.headers.get("fly-request-id");
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
    const text = await res.text();
    const latencyMs = this.o.clock() - started;
    if (!res.ok) {
      const parsed = text ? ErrorBody.safeParse(safeJson(text)) : null;
      const detail = parsed?.success ? (parsed.data.error ?? "") : text.slice(0, 200);
      const retryable = isRetryable(res.status, "http");
      this.record(meta, method, url, { status: res.status, latencyMs, attempt: attempts, requestId, retryAfterSeconds, errorCode: `http_${res.status}`, retryable });
      throw new FlyApiError(`fly ${method} ${path}: HTTP ${res.status} ${this.redFor(body, detail)}`, "http", res.status, retryable, requestId, attempts, retryAfterSeconds);
    }
    this.record(meta, method, url, { status: res.status, latencyMs, attempt: attempts, requestId, retryAfterSeconds: null, errorCode: null, retryable: false });
    if (!schema) return { status: res.status, data: null, requestId };
    const parsed = schema.safeParse(safeJson(text));
    if (!parsed.success) throw new FlyApiError(`fly ${method} ${path}: malformed response (${this.redFor(body, parsed.error.issues[0]?.message ?? "unparseable")})`, "malformed", res.status, false, requestId, attempts);
    return { status: res.status, data: parsed.data, requestId };
  }

  /** The retry loop: full jitter, Retry-After, maxAttempts, the deadline.
   *  `op` receives the ATTEMPT NUMBER and hands it to `once`, so each
   *  stream_provider_calls row and each error says which attempt it was —
   *  passing a literal 0 there (the first draft) made every row read "0". */
  private async withRetry<T>(op: (attempt: number) => Promise<T>, onAmbiguous?: () => Promise<T | null>): Promise<T> {
    const started = this.o.clock();
    for (let attempt = 1; ; attempt++) {
      try {
        return await op(attempt);
      } catch (e) {
        const err = e instanceof FlyApiError ? e : new FlyApiError(this.red(String((e as Error)?.message ?? e)), "network", null, true, null, attempt);
        if (!err.retryable) throw withAttempts(err, attempt);
        if (onAmbiguous) {
          // T5-b (post-2C plan sync): a RETRYABLE create failure reaches the domain as `create_failed { retryable: true }`, which
          // lets the runner table schedule attempt + 1 (invariant 1) — so it must MEAN "Fly holds no Machine under this name".
          // Every ambiguous failure is looked up, the LAST attempt's included (the first draft threw at maxAttempts before
          // looking, and a create that timed out on its final try reported retryable with its Machine booting); a deadline
          // below is reached only after this lookup found nothing. A lookup that cannot answer makes the failure NOT retryable.
          let found: T | null;
          try {
            found = await onAmbiguous();
          } catch (lookupErr) {
            throw new FlyApiError(`fly: create outcome unknown — the lookup after "${err.message}" failed (${this.red(String((lookupErr as Error)?.message ?? lookupErr))})`, err.code, err.status, false, err.requestId, attempt);
          }
          if (found !== null) return found;
        }
        if (attempt >= this.o.maxAttempts) throw withAttempts(err, attempt);
        const retryAfter = err.status === 429 && err.retryAfterSeconds !== null ? err.retryAfterSeconds * 1000 : null;
        const wait = retryAfter ?? Math.floor(Math.min(this.o.maxBackoffMs, this.o.baseBackoffMs * 2 ** (attempt - 1)) * this.o.random());
        if (this.o.clock() - started + wait > this.o.deadlineMs) {
          throw new FlyApiError(`fly: deadline of ${this.o.deadlineMs} ms exceeded after ${attempt} attempt(s) (${err.message})`, "deadline", err.status, true, err.requestId, attempt);
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
      async () => {
        if (!sessionKey) return null;
        // T5-a: by NAME — the session's metadata also lists an EARLIER attempt's Machine, and `found[0]` handed that one back
        // as this create's. T5-b: no `.catch(() => [])` — a lookup that failed must never read as "nothing there".
        const found = await this.listMachines({ metadata: { [SESSION_METADATA_KEY]: sessionKey } });
        return found.find((m) => m.name === input.name) ?? null;
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

  async listMachines(opts: { metadata?: Record<string, string>; includeDeleted?: boolean } = {}): Promise<Machine[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.metadata ?? {})) q.set(`metadata.${k}`, v);
    if (opts.includeDeleted) q.set("include_deleted", "true");
    const qs = q.toString();
    const meta: CallMeta = { operation: "listMachines", ids: [] };
    return this.withRetry(async (attempt) => (await this.once("GET", `/machines${qs ? `?${qs}` : ""}`, undefined, z.array(MachineSchema), attempt, meta)).data!);
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

function withAttempts(err: FlyApiError, attempts: number): FlyApiError {
  return new FlyApiError(err.message, err.code, err.status, err.retryable, err.requestId, attempts, err.retryAfterSeconds);
}
