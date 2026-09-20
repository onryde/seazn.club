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
import { NOOP_RECORDER } from "./ports";
import type {
  DeleteVideoResult, IngestCapabilities, IngestCreateSpec, IngestCredentials, IngestProvider,
  IngestState, IngestStatus, IngestTarget, IngestVideo, OutputState, ProviderCallRecord,
  ProviderCallRecorder, RunnerHandle, RunnerListing,
  RunnerObservation, RunnerProvider, RunnerSpec, StorageUsage,
} from "./ports";

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

  async inputStatus(inputId: string): Promise<IngestStatus> {
    this.record("inputStatus", "GET", `/live_inputs/${inputId}`, [inputId], inputId);
    const row = this.inputs.get(inputId);
    const createdAt = row ? (row.deleted ? null : row.createdAt) : createdAtFromId(inputId);
    if (createdAt === null) return { state: "unknown", protocol: null, enteredAt: null, lastSeenAt: null, reason: null };
    const state: IngestState =
      row?.scripted ?? (this.clock() - createdAt >= this.connectAfterMs ? "connected" : "disconnected");
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

  async addOutput(inputId: string, target: IngestTarget): Promise<string> {
    this.record("addOutput", "POST", `/live_inputs/${inputId}/outputs`, [inputId], inputId);
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

  async outputState(inputId: string): Promise<OutputState> {
    this.record("outputState", "GET", `/live_inputs/${inputId}/outputs`, [inputId], inputId);
    const row = this.inputs.get(inputId);
    if (!row || row.outputs.length === 0) return "unknown";
    return row.outputs.some((o) => new URL(o.url).hostname.includes("reject")) ? "rejected" : "ok";
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
  private readonly alive = new Map<string, { sessionId: string | null; name: string | null }>(); // runnerId → who it was created for
  private readonly observed = new Map<string, RunnerObservation>();
  private nextCreateFailure: { retryable: boolean } | null = null;
  private n = 0;
  private readonly rec: ProviderCallRecorder;

  constructor(opts: { recorder?: ProviderCallRecorder } = {}) { this.rec = opts.recorder ?? NOOP_RECORDER; }

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
      throw Object.assign(new Error(`fake create failed (${f.retryable ? "retryable" : "not retryable"})`), { retryable: f.retryable });
    }
    this.n += 1;
    const runnerId = `fake-machine-${this.n}-${randomBytes(3).toString("hex")}`;
    this.alive.set(runnerId, { sessionId: spec.sessionId, name: machineNameFor(spec.sessionId, spec.attempt) });
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
    return [...this.alive].map(([runnerId, { sessionId, name }]) => ({ runnerId, sessionId, name, state: "running" as const }));
  }

  /** Test controls. */
  setObserved(runnerId: string, state: RunnerObservation["state"], exit: RunnerObservation["exit"] = null): void {
    this.observed.set(runnerId, { state, exit });
    if (state === "destroyed") this.alive.delete(runnerId);
  }
  failNextCreate(retryable: boolean): void { this.nextCreateFailure = { retryable }; }
  /** A Machine the provider holds that no session row explains. */
  addOrphan(runnerId: string, sessionId: string | null): void {
    this.alive.set(runnerId, { sessionId, name: null });
    this.observed.set(runnerId, { state: "running", exit: null });
  }
}
