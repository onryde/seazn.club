// server/relay/ports.ts — the two provider seams (design §6.4, §7.1 E6, §9a
// "ports and adapters with in-repo fakes"). No provider VOCABULARY crosses
// these interfaces: no Fly ids, no Machines JSON, no Cloudflare enum values —
// which is what makes "a second driver is one file" a checkable claim.
//
// C3: `storageUsage()` is RAW usage. Headroom is computed by the usecase
// (usage limit − used − Σ reservations), because an in-progress recording
// contributes ZERO to the figure for its whole life and lands as a lump at
// finalisation — poll-then-admit is unsound, not imprecise.
// C2: `deleteInput` leaks recordings on Cloudflare. Every cleanup deletes
// videos before inputs; `deleteVideo` answers "in_progress" for a 409/10046
// and the caller retries on its next tick.
import type { ExitInfo, ObservedRunnerState } from "./domain/runner";

export type IngestMode = "passthrough" | "composed";
export type IngestProtocol = "srt" | "rtmps";
export type IngestState = "connected" | "disconnected" | "unknown";
export interface IngestTarget { url: string; streamKey: string }
export interface IngestCreateSpec { sessionId: string; slot: number }
export interface IngestCredentials {
  inputId: string;
  srt: { url: string; streamId: string; passphrase: string };
  rtmps: { url: string; streamKey: string };
}
export interface IngestStatus {
  state: IngestState; protocol: IngestProtocol | null; enteredAt: string | null; lastSeenAt: string | null;
  /** Dh: Cloudflare's `status.current.reason`, VERBATIM — the sentence that says
   *  WHY the ingest is in this state. Task 10 writes it to every sample's
   *  `ingest_reason`. The edge LOCATION is dropped: GET /live_inputs/{uid}
   *  returns no location field (probe, 2026-09-14). Null when absent. */
  reason: string | null;
}
export type OutputState = "ok" | "rejected" | "unknown";
export interface StorageUsage { totalStorageMinutes: number; totalStorageMinutesLimit: number; videoCount: number }
/** Dd — a recording, with every fact Cloudflare's video object carries.
 *  While `state` is "live-inprogress" the probe (2026-09-14) reads `duration`
 *  −1, `size` −1 and `input.width`/`input.height` 0; the adapter maps each of
 *  those PLACEHOLDERS to null, because a −1 landing in `recording_bytes` is a
 *  lie the sweep cannot tell from a measurement. `state` is what the gate reads
 *  (Task 12 writes one `recording_finalised` event per video only once it is no
 *  longer "live-inprogress"), so the nulls never have to carry that news.
 *  There is NO codec field on the object — it is not omitted here, it does not
 *  exist. */
export interface IngestVideo {
  videoId: string; inputId: string | null; createdAt: string; inProgress: boolean;
  durationSeconds: number | null;   // `duration`  → sessions.recording_seconds
  sizeBytes: number | null;         // `size`      → sessions.recording_bytes
  width: number | null;             // `input.width`
  height: number | null;            // `input.height`
  state: string;                    // `status.state`, verbatim ("live-inprogress" | "ready" | "error" | …)
  errorReasonCode: string | null;   // `status.errorReasonCode`
}
export type DeleteVideoResult = "deleted" | "in_progress" | "absent";
export interface IngestCapabilities {
  timeoutSeconds: number;
  deleteRecordingAfterDays: number;
  /** C2/C8: declared per transport; SRT is UNMEASURED (H-P5-1) and stays null. */
  holdWindowSeconds: { rtmps: number; srt: number | null };
  /** m2 (lane C final review): the most videos ONE `listVideos` call returns — the adapter's own page size. A listing of
   *  exactly this many may be missing its tail (A13), so the sweep judges "full page" by the provider it is talking to,
   *  read here, never by importing an adapter's module. */
  listVideosPageLimit: number;
}
export interface IngestProvider {
  readonly capabilities: IngestCapabilities;
  createLiveInput(spec: IngestCreateSpec): Promise<IngestCredentials>;
  inputStatus(inputId: string): Promise<IngestStatus>;            // C5: the per-input GET
  addOutput(inputId: string, target: IngestTarget): Promise<string>; // passthrough only, exactly once; RETURNS the output's uid (Dg → sessions.output_uid). Output ERROR codes are dropped: the output object carries only uid, url, streamKey, enabled (API docs 2026-09-14)
  outputState(inputId: string): Promise<OutputState>;             // target_rejected source
  /** C1 (lane C final review): takes the passthrough output off its input, which is what stops Cloudflare simulcasting
   *  to the destination — the ONE teardown of a passthrough broadcast. Idempotent: an output already gone is success.
   *  Never `deleteInput` for this (the input carries the recording — C2). */
  removeOutput(inputId: string, outputId: string): Promise<void>;
  deleteInput(inputId: string): Promise<void>;                    // LEAKS recordings (C2) — videos first
  storageUsage(): Promise<StorageUsage>;                          // C3: raw usage; headroom is the usecase's
  listVideos(opts: { createdBefore: Date }): Promise<IngestVideo[]>;
  deleteVideo(videoId: string): Promise<DeleteVideoResult>;       // 409/10046 → "in_progress"
}
export type RunnerSpec = {
  sessionId: string; attempt: number; jobToken: string; appUrl: string;   // attempt → the Machine NAME (domain/runner.ts machineNameFor)
  /** I1 (Task 12 fix round 1): the deploy environment creating this runner — config.ts `relayEnvironment()`. The adapter
   *  stamps it on the runner, and `list()` hands it back as `RunnerListing.environment`: it is the daily sweep's ONLY
   *  licence to destroy a listed runner. Two deployments can list one provider account, so "no row in my database" is
   *  never ownership. */
  environment: string;
  guest: { cpus: number; memoryMb: number; cpuClass: "shared" | "dedicated" };
  region: string;
  /** Recommendation B: the Machine exits on its own at this instant (env RELAY_DEADLINE_AT); auto_destroy removes it.
   *
   *  It MUST come from `domain/expiry.ts`'s `runnerDeadlineOf(session)` and never from `deadlineOf` (whole-branch
   *  review I1). The two anchor on different instants: `deadlineOf` reads `startedAt ?? createdAt`, and this spec is
   *  built while `startedAt` is still null, so `deadlineOf` here computes the hard stop from `createdAt` and the
   *  session's own `wall_clock` is later read from `startedAt` — up to MAX_ANCHOR_DRIFT_SECONDS later. The Machine
   *  would then die FIRST on every composed session that went live, and the session would read that as a crash: one
   *  wasted retry, or a `machine_crash` failure (and no `fill_replay`) on a broadcast that ran its full booked
   *  length. This deadline is a BACKSTOP; the session's wall clock is the authority. */
  deadlineAt: Date;
};
export type RunnerHandle = { runnerId: string };

/** A23 (lane C, OWNER 2026-09-28): the ONE create failure this port declares — provider-neutral, so the application layer
 *  classifies a failed `create` without importing any adapter (the guard is `__tests__/port-boundary.test.ts`). The two
 *  facts are the domain's `create_failed` trigger fields (domain/runner.ts), and each adapter owes them from its own
 *  evidence (FlyRunner: `runner-fly.ts` `runnerCreateErrorFrom`, whole-branch review I2's proof rules):
 *   - `outcomeUnknown`: the provider MAY hold a runner under the requested name. true unless something positively proves
 *     nothing was made — the domain then tears down by name before any retry.
 *   - `retryable`: the licence to create attempt + 1 under a DIFFERENT name. Only a CONFIRMED absence may earn it.
 *  The provider's own error rides as `cause` (ids, statuses, request ids stay on the adapter's side of the port). A
 *  `create` rejection that is NOT this type is read as outcome UNKNOWN (`createFailureOf`) — the safe direction. */
export class RunnerCreateError extends Error {
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  constructor(message: string, facts: { retryable: boolean; outcomeUnknown: boolean; cause?: unknown }) {
    super(message, facts.cause === undefined ? undefined : { cause: facts.cause });
    this.name = "RunnerCreateError";
    this.retryable = facts.retryable;
    this.outcomeUnknown = facts.outcomeUnknown;
  }
}
/** Task 12 n1: a create refused BEFORE any provider call — the runner could not be configured (a live deployment missing
 *  FLY_RELAY_APP / ENV_NAME / its token, or still on the retired shared app), or the create's own inputs could not be
 *  built. Nothing was sent, so nothing can exist under the name: made nothing, and not retryable — the same refusal would
 *  answer attempt + 1. The session fails `machine_create_failed` at once instead of running lost → force_destroy → retry
 *  with an alarm on every attempt. */
export function createRefusedBeforeCall(cause: unknown): RunnerCreateError {
  const why = cause instanceof Error ? cause.message : String(cause);
  return new RunnerCreateError(`runner create refused before any provider call: ${why}`, { retryable: false, outcomeUnknown: false, cause });
}
/** The ONE reading of whatever a `create` threw. The port's own failure carries its proof; anything else — an adapter bug,
 *  a failure the adapter did not map — is outcome UNKNOWN and not retryable: one extra teardown by name, which the
 *  provider answers as success when nothing is there, against a runner nobody is watching. */
export function createFailureOf(e: unknown): { retryable: boolean; outcomeUnknown: boolean } {
  return e instanceof RunnerCreateError ? { retryable: e.retryable, outcomeUnknown: e.outcomeUnknown } : { retryable: false, outcomeUnknown: true };
}
/** `name` is the Machine's own name — `machineNameFor(sessionId, attempt)` for ours, so it carries the ATTEMPT (post-2C plan sync,
 *  T5-a: Task 10 adopts and force-destroys by session AND name, so an earlier attempt's Machine is never taken for the current
 *  one). null when the provider holds a Machine with no name.
 *  `environment` is the `RunnerSpec.environment` the runner was created with (I1); null when it carries none — a runner
 *  that proves no ownership, which the sweep counts and never destroys. */
export interface RunnerListing { runnerId: string; sessionId: string | null; name: string | null; environment: string | null; state: "running" | "stopped" | "other" }
/** The lifecycle's observed input (plan §"Fly machine lifecycle"): the adapter's fromFlyState mapping, never Fly's spelling. */
export interface RunnerObservation { state: ObservedRunnerState; exit: ExitInfo | null }   // both types from domain/runner.ts
export interface RunnerProvider {
  /** m1 (Task 12 fix round 1): how long a runner created just before a `list()` may still be MISSING from it — the
   *  provider's list-consistency window (Fly's is undocumented: runner-fly.ts's adoption notes, and fly-client.ts settles
   *  its own create lookup for the same reason). A caller that acts on a runner's ABSENCE lists again after this long
   *  and acts only on what BOTH listings lack. */
  readonly listSettleMs: number;
  create(spec: RunnerSpec): Promise<RunnerHandle>;   // idempotent per (sessionId, attempt): a retry after an ambiguous failure returns the SAME runner. Rejects with RunnerCreateError (A23)
  stop(runnerId: string, opts: { signal: "SIGINT"; timeoutSeconds: number }): Promise<void>;   // the stop sequence; idempotent (already stopped / absent = success)
  /** GET + events → { state, exit }. "Absent" is TWO cases and they answer
   *  differently (lane-A minors, Task 3 review m1 — this line said only
   *  `absent = { destroyed, exit: null }`, which the fake appeared to contradict):
   *    * an id the provider never had → `{ state: "destroyed", exit: null }`.
   *      Fly 404s; there are no events to read.
   *    * a Machine it HAD and has since destroyed → `{ state: "destroyed", exit }`,
   *      carrying the exit it ended on. C1 measured that a destroyed Fly Machine
   *      still answers GET 200 with its events readable, which is the whole reason
   *      `FlyRunner.observe` fetches events for every non-running state.
   *  `FakeRunner` models the same split, and `fakes.test.ts` pins both sides — a
   *  fake that dropped the exit would let Task 10 read `machine_crash` where the
   *  real path reads `machine_exit_nonzero`. */
  observe(runnerId: string): Promise<RunnerObservation>;
  destroy(runnerId: string): Promise<void>;          // force; idempotent: an absent runner is success
  list(): Promise<RunnerListing[]>;                  // every runner the provider still holds for this app, with the session it was created for and its name (T5-a) — the daily orphan sweep's source
}
/** Ruling 13: every provider call, every attempt, is a row (stream_provider_calls).
 *  Adapters RECORD through this port and never touch SQL; telemetry.ts's
 *  recordProviderCall is bound behind it in drivers.ts, FakeRecorder in tests.
 *  Best-effort by contract: a recorder that throws never fails the call it
 *  records — telemetry must not take a broadcast down. WHERE that happens
 *  (lane-A minors, Task 3 review m6 — this line used to say "the adapter catches
 *  and logs ONCE per process", and the adapters do not log at all): every adapter
 *  and fake swallows the throw SILENTLY, inside its own fire-and-forget `record`.
 *  The once-per-process warning lives in `drivers.ts`'s `dbRecorder`, which is the
 *  only recorder that can actually fail, and which is bound in one place. An
 *  adapter that logged here would log once per CALL. `url` is the URL as called; the recorder templates
 *  it (sanitise.ts pathTemplate) — the adapter passes the ids it interpolated. */
export interface ProviderCallRecord {
  provider: "cloudflare" | "fly" | "stripe"; operation: string; subjectId?: string | null; sessionId?: string | null;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; ids: readonly string[];
  status: number | null; latencyMs: number; attempt: number;
  retryReason?: string | null; retryAfterSeconds?: number | null; requestId?: string | null; errorCode?: string | null;
}
export interface ProviderCallRecorder { record(c: ProviderCallRecord): void | Promise<void> }
/** The default when nothing is injected — a unit test that does not care. */
export const NOOP_RECORDER: ProviderCallRecorder = { record() {} };
