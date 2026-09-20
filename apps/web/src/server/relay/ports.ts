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
}
export interface IngestProvider {
  readonly capabilities: IngestCapabilities;
  createLiveInput(spec: IngestCreateSpec): Promise<IngestCredentials>;
  inputStatus(inputId: string): Promise<IngestStatus>;            // C5: the per-input GET
  addOutput(inputId: string, target: IngestTarget): Promise<string>; // passthrough only, exactly once; RETURNS the output's uid (Dg → sessions.output_uid). Output ERROR codes are dropped: the output object carries only uid, url, streamKey, enabled (API docs 2026-09-14)
  outputState(inputId: string): Promise<OutputState>;             // target_rejected source
  deleteInput(inputId: string): Promise<void>;                    // LEAKS recordings (C2) — videos first
  storageUsage(): Promise<StorageUsage>;                          // C3: raw usage; headroom is the usecase's
  listVideos(opts: { createdBefore: Date }): Promise<IngestVideo[]>;
  deleteVideo(videoId: string): Promise<DeleteVideoResult>;       // 409/10046 → "in_progress"
}
export type RunnerSpec = {
  sessionId: string; attempt: number; jobToken: string; appUrl: string;   // attempt → the Machine NAME (domain/runner.ts machineNameFor)
  guest: { cpus: number; memoryMb: number; cpuClass: "shared" | "dedicated" };
  region: string;
  /** Recommendation B: the Machine exits on its own at this instant (env RELAY_DEADLINE_AT); auto_destroy removes it. */
  deadlineAt: Date;
};
export type RunnerHandle = { runnerId: string };
/** `name` is the Machine's own name — `machineNameFor(sessionId, attempt)` for ours, so it carries the ATTEMPT (post-2C plan sync,
 *  T5-a: Task 10 adopts and force-destroys by session AND name, so an earlier attempt's Machine is never taken for the current
 *  one). null when the provider holds a Machine with no name. */
export interface RunnerListing { runnerId: string; sessionId: string | null; name: string | null; state: "running" | "stopped" | "other" }
/** The lifecycle's observed input (plan §"Fly machine lifecycle"): the adapter's fromFlyState mapping, never Fly's spelling. */
export interface RunnerObservation { state: ObservedRunnerState; exit: ExitInfo | null }   // both types from domain/runner.ts
export interface RunnerProvider {
  create(spec: RunnerSpec): Promise<RunnerHandle>;   // idempotent per (sessionId, attempt): a retry after an ambiguous failure returns the SAME runner
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
