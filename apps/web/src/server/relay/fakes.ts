// server/relay/fakes.ts — FakeIngest / FakeRunner. Two modes in one class:
//  * SCRIPTED (unit tests): `setState`, `addVideo`, `scriptDeleteVideo`.
//  * CLOCK-DERIVED (a server started with RELAY_DRIVERS=fake): an input is
//    "connected" once `connectAfterMs` has passed since its creation, and the
//    creation time is ENCODED IN THE INPUT ID (`fake-in-<ms>-<rand>`), so the
//    e2e drives a real server and waits, exactly as an organiser would.
//    HOW FAR that survives a restart, narrowed (lane-A minors, Task 3 review m7 —
//    the header claimed it for the whole fake): `inputStatus` alone. It is the
//    only method that reconstructs a row from the id. After a restart
//    `addOutput` THROWS on an id this instance does not hold, `outputState`
//    reads "unknown", and an input deleted before the restart reads "connected"
//    again because the `deleted` flag was in memory. Every one of those fails
//    LOUDLY (a red e2e), not into a false green, which is why the fake is left
//    as it is rather than made to adopt id-derived rows lazily.
// The fake mirrors what R0 measured, not what would be convenient: the
// per-input status shape (C5), the recording leak on deleteInput (C2), the
// BARE srt:// URL with streamId and passphrase as separate fields (Task 2
// ruling, 2026-09-16 — no secret ever rides in the URL's query string).
import { randomBytes } from "node:crypto";
import {
  DELETE_RECORDING_AFTER_DAYS, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS,
} from "./config";
import { machineNameFor } from "./domain/runner";   // T5-a: the fake names a Machine exactly as FlyRunner does
import { LIST_VIDEOS_PAGE_LIMIT } from "./ingest-cf"; // m2: the fake lists in the REAL adapter's page size (A13 runs as in production)
import { FlyApiError } from "./fly-client";           // A3: a create failure's PROOF is the adapter's own error type…
import { runnerCreateErrorFrom } from "./runner-fly";  // …mapped onto the port's RunnerCreateError by the REAL adapter mapping (A23)
import { NOOP_RECORDER } from "./ports";
import type {
  DeleteVideoResult, IngestCapabilities, IngestCreateSpec, IngestCredentials, IngestProvider,
  IngestState, IngestStatus, IngestTarget, IngestVideo, OutputState, ProviderCallMeta, ProviderCallRecord,
  ProviderCallRecorder, RunnerHandle, RunnerListing,
  RunnerObservation, RunnerProvider, RunnerSpec, StorageUsage,
} from "./ports";

/** A destination whose stream KEY starts with this is refused by the fake "platform" — how a walkthrough drives
 *  `target_rejected` now that the ingest url is a server preset (D6) and no longer carries a "reject" host. */
export const FAKE_REJECT_KEY_PREFIX = "reject-";

/** D3 (spec §5.6): a destination whose stream KEY starts with this never accepts the output — the fake reads it
 *  `unknown` until the input connects, then `connecting` for as long as it is asked, which is Cloudflare's shape for a
 *  destination still dialling. How a walkthrough crosses go-live into the amber warning. */
export const FAKE_CONNECTING_KEY_PREFIX = "connecting-";

export const FAKE_CONNECT_AFTER_MS_DEFAULT = 3000;

/** `FAKE_INGEST_CONNECT_AFTER_MS`, parsed STRICTLY (lane-A minors, Task 3 review
 *  m3). A bare `Number(...)` took whatever it was given, and both failure modes
 *  were silent and wrong in different ways: an empty or whitespace value became
 *  **0**, an instant connect, so a server-mode e2e meaning to watch `warming`
 *  saw `live` at once and its wait proved nothing; a non-numeric value became
 *  **NaN**, and because `inputStatus` computes `enteredAt` unconditionally,
 *  `new Date(NaN).toISOString()` threw RangeError on EVERY poll of a live input
 *  — a 500 per heartbeat rather than "never connects". Nothing sets this env
 *  today, so neither has bitten; it is refused at CONSTRUCTION, the way
 *  `relayDriverMode()` refuses a junk RELAY_DRIVERS, because a fake driver's env
 *  is still an operator-facing switch and the failure it causes is three layers
 *  from its cause. 0 stays legal — "connect immediately", asked for on purpose. */
function connectAfterMsFromEnv(): number {
  const raw = process.env.FAKE_INGEST_CONNECT_AFTER_MS;
  if (raw === undefined) return FAKE_CONNECT_AFTER_MS_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new Error(`FAKE_INGEST_CONNECT_AFTER_MS must be a whole number of milliseconds, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** Dd: a test names the fields it cares about; the fake supplies the rest. */
export type FakeVideoInput = Pick<IngestVideo, "videoId" | "inputId" | "createdAt" | "inProgress"> & Partial<IngestVideo>;

interface FakeInput { createdAt: number; scripted: IngestState | null; outputs: IngestTarget[]; deleted: boolean; outputUids: string[] }

export class FakeIngest implements IngestProvider {
  readonly capabilities: IngestCapabilities = {
    timeoutSeconds: INGEST_TIMEOUT_SECONDS,
    deleteRecordingAfterDays: DELETE_RECORDING_AFTER_DAYS,
    holdWindowSeconds: { rtmps: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, srt: null },
    listVideosPageLimit: LIST_VIDEOS_PAGE_LIMIT,
  };
  readonly deletedInputs: string[] = [];
  readonly deletedVideos: string[] = [];
  storage: StorageUsage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 1000, videoCount: 0 };

  private readonly inputs = new Map<string, FakeInput>();
  private videos: IngestVideo[] = [];
  private readonly deleteScripts = new Map<string, DeleteVideoResult[]>();
  private readonly clock: () => number;
  private readonly connectAfterMs: number;

  private readonly rec: ProviderCallRecorder;

  constructor(opts: { clock?: () => number; connectAfterMs?: number; recorder?: ProviderCallRecorder } = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.connectAfterMs = opts.connectAfterMs ?? connectAfterMsFromEnv();
    this.rec = opts.recorder ?? NOOP_RECORDER;
  }

  /** Ruling 13: the fake records like the adapter, so the seam to
   *  stream_provider_calls is exercised in every fake-driver run. Best-effort
   *  (the port's contract): a throwing recorder never fails the call. */
  private record(operation: string, method: ProviderCallRecord["method"], path: string, ids: string[], subjectId: string | null, sessionId: string | null = null): void {
    void Promise.resolve()
      .then(() => this.rec.record({ provider: "cloudflare", operation, subjectId, sessionId, method, url: `https://api.cloudflare.com/client/v4/accounts/fake/stream${path}`, ids: ["fake", ...ids], status: 200, latencyMs: 0, attempt: 1 }))
      .catch(() => undefined);
  }

  async createLiveInput(spec: IngestCreateSpec): Promise<IngestCredentials> {
    const createdAt = this.clock();
    const inputId = `fake-in-${createdAt}-${randomBytes(4).toString("hex")}`;
    this.record("createLiveInput", "POST", "/live_inputs", [], inputId, spec.sessionId);
    this.inputs.set(inputId, { createdAt, scripted: null, outputs: [], deleted: false, outputUids: [] });
    const streamId = `${spec.sessionId}-${spec.slot}`;
    const passphrase = randomBytes(12).toString("hex");
    return {
      inputId,
      srt: { url: "srt://fake.ingest.invalid:778", streamId, passphrase },
      rtmps: { url: "rtmps://fake.ingest.invalid:443/live/", streamKey: randomBytes(12).toString("hex") },
    };
  }

  setState(inputId: string, state: IngestState): void {
    const row = this.inputs.get(inputId);
    if (!row) throw new Error(`FakeIngest.setState: unknown input ${inputId}`);
    row.scripted = state;
  }

  /** The ONE connect rule (scripted state, else the clock), shared by `inputStatus` and `outputState` — the latter must
   *  not call `inputStatus`, which would record a provider call nobody made and move every provider-call count. */
  private stateOf(row: FakeInput | undefined, createdAt: number): IngestState {
    return row?.scripted ?? (this.clock() - createdAt >= this.connectAfterMs ? "connected" : "disconnected");
  }

  async inputStatus(inputId: string, meta: ProviderCallMeta = {}): Promise<IngestStatus> {
    this.record("inputStatus", "GET", `/live_inputs/${inputId}`, [inputId], inputId, meta.sessionId ?? null);
    const row = this.inputs.get(inputId);
    const createdAt = row ? (row.deleted ? null : row.createdAt) : createdAtFromId(inputId);
    if (createdAt === null) return { state: "unknown", protocol: null, enteredAt: null, lastSeenAt: null, reason: null };
    const state = this.stateOf(row, createdAt);
    const connected = state === "connected";
    const enteredAt = new Date(createdAt + this.connectAfterMs).toISOString();
    return {
      state,
      protocol: connected ? "srt" : null,
      enteredAt: connected ? enteredAt : null,
      lastSeenAt: connected ? new Date(this.clock()).toISOString() : null,
      // Dh: a stable stand-in for Cloudflare's free-text status.current.reason.
      // Non-null on purpose — an all-null fake would let a dropped ingest_reason
      // writer pass every fake-driver run unnoticed.
      reason: connected ? "live_input_connected" : "waiting_for_input",
    };
  }

  async addOutput(inputId: string, target: IngestTarget, meta: ProviderCallMeta = {}): Promise<string> {
    this.record("addOutput", "POST", `/live_inputs/${inputId}/outputs`, [inputId], inputId, meta.sessionId ?? null);
    const row = this.inputs.get(inputId);
    if (!row) throw new Error(`FakeIngest.addOutput: unknown input ${inputId}`);
    row.outputs.push(target);
    const uid = `fake-out-${row.outputUids.length + 1}-${randomBytes(3).toString("hex")}`;   // Dg
    row.outputUids.push(uid);
    return uid;
  }

  outputsFor(inputId: string): IngestTarget[] {
    return [...(this.inputs.get(inputId)?.outputs ?? [])];
  }

  /** C1: every removeOutput call's output uid, in order — a repeat and an unknown uid included. */
  readonly removedOutputs: string[] = [];

  /** C1: Cloudflare's "Delete an output". An output already gone (or an input the fake never made) is its 404 — success,
   *  and nothing changes. Only the named output leaves; its neighbours stay. */
  async removeOutput(inputId: string, outputId: string, meta: ProviderCallMeta = {}): Promise<void> {
    this.record("removeOutput", "DELETE", `/live_inputs/${inputId}/outputs/${outputId}`, [inputId, outputId], outputId, meta.sessionId ?? null);
    this.removedOutputs.push(outputId);
    const row = this.inputs.get(inputId);
    const i = row ? row.outputUids.indexOf(outputId) : -1;
    if (!row || i === -1) return;
    row.outputUids.splice(i, 1);
    row.outputs.splice(i, 1);
  }

  /** C1: the outputs still simulcasting from ONE input — none once the input is deleted (Cloudflare drops them with it). */
  liveOutputCount(inputId: string): number {
    const row = this.inputs.get(inputId);
    return row && !row.deleted ? row.outputs.length : 0;
  }

  /** C1: the outputs still pushing to ONE destination (url + key) across EVERY live input — what "exactly one publisher
   *  on the organiser's key" means, since each session opens its own input. */
  liveOutputsTo(target: IngestTarget): number {
    let n = 0;
    for (const row of this.inputs.values()) {
      if (row.deleted) continue;
      n += row.outputs.filter((o) => o.url === target.url && o.streamKey === target.streamKey).length;
    }
    return n;
  }

  async outputState(inputId: string, meta: ProviderCallMeta = {}): Promise<OutputState> {
    this.record("outputState", "GET", `/live_inputs/${inputId}/outputs`, [inputId], inputId, meta.sessionId ?? null);
    const row = this.inputs.get(inputId);
    if (!row || row.outputs.length === 0) return "unknown";
    if (row.outputs.some((o) => new URL(o.url).hostname.includes("reject") || o.streamKey.startsWith(FAKE_REJECT_KEY_PREFIX))) return "rejected";
    // Cloudflare reports no output status before inbound video (ingest-cf.ts outputState): `unknown` until the input
    // connects, then `connecting` for a destination that never accepts. The walkthrough then crosses go-live in the
    // real shape, not a friendlier one.
    if (row.outputs.some((o) => o.streamKey.startsWith(FAKE_CONNECTING_KEY_PREFIX)))
      return !row.deleted && this.stateOf(row, row.createdAt) === "connected" ? "connecting" : "unknown";
    return "ok";
  }

  async deleteInput(inputId: string): Promise<void> {
    this.record("deleteInput", "DELETE", `/live_inputs/${inputId}`, [inputId], inputId);
    this.deletedInputs.push(inputId);
    const row = this.inputs.get(inputId);
    if (row) row.deleted = true;
    // Deliberately NOT touching this.videos — Cloudflare leaks them (C2).
  }

  async storageUsage(): Promise<StorageUsage> {
    this.record("storageUsage", "GET", "/storage-usage", [], null);
    return { ...this.storage };
  }

  /** Dd: normalise to the probe's shape. A live recording reports NOTHING
   *  measurable — Cloudflare reads -1/-1/0/0 there, and the adapter maps those
   *  to null, so the fake must too, whatever the caller passed. */
  addVideo(v: FakeVideoInput): void {
    this.videos.push(
      v.inProgress
        ? { ...v, durationSeconds: null, sizeBytes: null, width: null, height: null, state: "live-inprogress", errorReasonCode: v.errorReasonCode ?? null }
        : {
            ...v,
            durationSeconds: v.durationSeconds ?? null, sizeBytes: v.sizeBytes ?? null,
            width: v.width ?? null, height: v.height ?? null,
            state: v.state ?? "ready", errorReasonCode: v.errorReasonCode ?? null,
          },
    );
  }

  scriptDeleteVideo(videoId: string, results: DeleteVideoResult[]): void {
    this.deleteScripts.set(videoId, [...results]);
  }

  async listVideos(opts: { createdBefore: Date }): Promise<IngestVideo[]> {
    // Cloudflare lists videos on the account's bare `/stream` (Task 4's adapter, `?end=`), not on a `/videos` path.
    this.record("listVideos", "GET", `?end=${encodeURIComponent(opts.createdBefore.toISOString())}`, [], null);
    return this.videos.filter((v) => new Date(v.createdAt).getTime() < opts.createdBefore.getTime()).map((v) => ({ ...v }));
  }

  async deleteVideo(videoId: string): Promise<DeleteVideoResult> {
    this.record("deleteVideo", "DELETE", `/${videoId}`, [videoId], videoId);   // `/stream/{uid}`, as Task 4's adapter calls it
    const script = this.deleteScripts.get(videoId);
    const scripted = script?.shift();
    if (scripted) return scripted;
    const i = this.videos.findIndex((v) => v.videoId === videoId);
    if (i < 0) return "absent";
    this.videos.splice(i, 1);
    this.deletedVideos.push(videoId);
    return "deleted";
  }
}

function createdAtFromId(inputId: string): number | null {
  const m = /^fake-in-(\d+)-/.exec(inputId);
  return m ? Number(m[1]) : null;
}

export class FakeRecorder implements ProviderCallRecorder {
  readonly calls: ProviderCallRecord[] = [];
  private failNextCall = false;
  failNext(): void { this.failNextCall = true; }
  record(c: ProviderCallRecord): void {
    if (this.failNextCall) { this.failNextCall = false; throw new Error("fake recorder failed"); }
    this.calls.push(c);
  }
}

export class FakeRunner implements RunnerProvider {
  readonly created: RunnerSpec[] = [];
  readonly stops: { runnerId: string; signal: string; timeoutSeconds: number }[] = [];
  readonly destroyed: string[] = [];
  private readonly alive = new Map<string, { sessionId: string | null; name: string | null; environment: string | null }>(); // runnerId → who (and which deployment) it was created for
  private readonly observed = new Map<string, RunnerObservation>();
  private nextCreateFailure: { retryable: boolean; proof: { status: number | null; retryable: boolean } | null } | null = null;
  private n = 0;
  private readonly rec: ProviderCallRecorder;
  /** m1: a fake lists consistently, so 0 by default; a test that models Fly's lag passes its own window. */
  readonly listSettleMs: number;

  constructor(opts: { recorder?: ProviderCallRecorder; listSettleMs?: number } = {}) {
    this.rec = opts.recorder ?? NOOP_RECORDER;
    this.listSettleMs = opts.listSettleMs ?? 0;
  }

  private record(operation: string, method: ProviderCallRecord["method"], path: string, subjectId: string | null, sessionId: string | null = null, status = 200): void {
    void Promise.resolve()
      .then(() => this.rec.record({ provider: "fly", operation, subjectId, sessionId, method, url: `https://api.machines.dev/v1/apps/fake-relay${path}`, ids: ["fake-relay", ...(subjectId ? [subjectId] : [])], status, latencyMs: 0, attempt: 1 }))
      .catch(() => undefined);
  }

  async create(spec: RunnerSpec): Promise<RunnerHandle> {
    this.created.push({ ...spec, guest: { ...spec.guest } });
    this.record("createMachine", "POST", "/machines", null, spec.sessionId, this.nextCreateFailure ? 500 : 200);
    if (this.nextCreateFailure) {
      const f = this.nextCreateFailure;
      this.nextCreateFailure = null;
      // A proof (lane C A3): a REAL FlyApiError — a transport failure carries no status (`network`), a provider answer
      // carries one (`http`) — through the REAL adapter mapping, so the port's RunnerCreateError the usecase reads (A23)
      // is decided by the code FlyRunner runs, never by a copy of it here.
      if (f.proof) throw runnerCreateErrorFrom(new FlyApiError("fake create failed", f.proof.status === null ? "network" : "http", f.proof.status, f.proof.retryable, null, 1));
      throw Object.assign(new Error(`fake create failed (${f.retryable ? "retryable" : "not retryable"})`), { retryable: f.retryable });
    }
    // Whole-branch review I6: `create` is IDEMPOTENT PER (sessionId, attempt) — ports.ts says so and
    // runner-fly.test.ts pins that the real adapter honours it (Fly answers 409 already_exists and the adapter ADOPTS
    // the named Machine). This fake used to mint a fresh id on every call and leave TWO live entries carrying one
    // `machineNameFor(sessionId, attempt)`, which is a state the provider cannot produce — so Tasks 10 and 12 would
    // have tested retry and orphan matching against a double that DUPLICATES where production adopts: a double-create
    // bug would pass, a correct implementation would look as if it created two, and T5-a's "match by session AND
    // name" would get two listings with one name. The attempt is in the name, so a genuine retry (attempt + 1) still
    // gets its own Machine. The POST above is still recorded either way: the real adapter really does call and get
    // refused.
    const name = machineNameFor(spec.sessionId, spec.attempt);
    for (const [runnerId, m] of this.alive) {
      if (m.sessionId === spec.sessionId && m.name === name) return { runnerId };
    }
    this.n += 1;
    const runnerId = `fake-machine-${this.n}-${randomBytes(3).toString("hex")}`;
    this.alive.set(runnerId, { sessionId: spec.sessionId, name, environment: spec.environment });
    this.observed.set(runnerId, { state: "running", exit: null });
    return { runnerId };
  }

  /** The stop sequence: recorded, and the fake goes to `stopped` then auto-destroys
   *  on the NEXT observe (both R0 soaks auto-destroyed on exit 0). */
  async stop(runnerId: string, opts: { signal: "SIGINT"; timeoutSeconds: number }): Promise<void> {
    this.stops.push({ runnerId, ...opts });
    this.record("stopMachine", "POST", `/machines/${runnerId}/stop`, runnerId);
    if (this.alive.has(runnerId)) this.observed.set(runnerId, { state: "stopped", exit: { exitCode: 0, oomKilled: false, requestedStop: true } });
  }

  async observe(runnerId: string): Promise<RunnerObservation> {
    this.record("getMachine", "GET", `/machines/${runnerId}`, runnerId);
    const o = this.observed.get(runnerId);
    if (!o || !this.alive.has(runnerId)) return { state: "destroyed", exit: o?.exit ?? null };
    if (o.state === "stopped" && o.exit?.requestedStop) {
      // auto_destroy: a cleanly stopped Machine is gone by the next look
      this.alive.delete(runnerId);
      this.observed.set(runnerId, { state: "destroyed", exit: o.exit });
      return { state: "stopped", exit: o.exit };
    }
    return o;
  }

  async destroy(runnerId: string): Promise<void> {
    this.destroyed.push(runnerId); // absent is success (C7)
    this.record("destroyMachine", "DELETE", `/machines/${runnerId}`, runnerId);
    this.alive.delete(runnerId);
    this.observed.set(runnerId, { state: "destroyed", exit: this.observed.get(runnerId)?.exit ?? null });
  }

  async list(): Promise<RunnerListing[]> {
    this.record("listMachines", "GET", "/machines", null);
    return [...this.alive].map(([runnerId, { sessionId, name, environment }]) => ({ runnerId, sessionId, name, environment, state: "running" as const }));
  }

  /** Test controls. */
  setObserved(runnerId: string, state: RunnerObservation["state"], exit: RunnerObservation["exit"] = null): void {
    this.observed.set(runnerId, { state, exit });
    if (state === "destroyed") this.alive.delete(runnerId);
  }
  /** Fail the next `create`. The ARGUMENT is the proof the failure carries (lane C A3, owner-confirmed 2026-09-28; A23):
   *   - a boolean — the legacy shape — throws a PLAIN error, which the port reads as outcome UNKNOWN whatever the flag
   *     says (`createFailureOf`): the session tears down by name before any retry. It is kept plain on purpose — it is
   *     the witness for the usecase's "not a RunnerCreateError ⇒ unknown" default;
   *   - `{ status, retryable }` throws the port's `RunnerCreateError`, mapped from a real `FlyApiError` by
   *     `runnerCreateErrorFrom`: a refusal status (4xx in CREATE_REFUSED_STATUSES) or a retryable one is a proof that
   *     NOTHING was made; any other status is still unknown. */
  failNextCreate(proof: boolean | { status: number | null; retryable: boolean }): void {
    this.nextCreateFailure = typeof proof === "boolean" ? { retryable: proof, proof: null } : { retryable: proof.retryable, proof };
  }
  /** A Machine the provider holds that no session row explains. `environment` is REQUIRED (I1): which deployment's
   *  Machine it is decides whether the sweep may touch it, so a test must say — null plants an untagged one. */
  addOrphan(runnerId: string, sessionId: string | null, environment: string | null): void {
    this.alive.set(runnerId, { sessionId, name: null, environment });
    this.observed.set(runnerId, { state: "running", exit: null });
  }
}
