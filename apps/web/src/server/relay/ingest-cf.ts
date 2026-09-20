// server/relay/ingest-cf.ts — Cloudflare Stream behind IngestProvider. Every
// endpoint and every number here was measured in R0 (R0-memo.md §11 F1–F3,
// R0-CORRECTIONS-FOR-R1.md C1–C5, C8, C10–C13):
//  * create: recording { mode: "automatic", timeoutSeconds, deleteRecordingAfterDays }
//    — 30 is the floor (1 and 7 are HTTP 400 code 10060); the 3-day promise is
//    the sweep's, over VIDEOS.
//  * status: the PER-INPUT GET. The list endpoint omits `recording` entirely
//    and unset fields are omitted (absent-as-false), so an input that has
//    never connected has no `status.current` — read as "disconnected".
//  * NO update of `recording` on a live input, ever: flipping mode off took a
//    live input off air in seconds while it stayed `connected` (F1).
//  * deleteInput leaks the recording; deleteVideo answers 409 code 10046 while
//    a recording is live-inprogress — reported as "in_progress", never retried
//    here (the sweep's next tick does).
//  * webRTC / webRTCPlayback are dropped at this boundary (C10). So is every
//    secret-bearing query string: the SRT url comes back BARE and streamId /
//    passphrase are separate fields (owner ruling 2026-09-16), which is what
//    lets Task 2 seal them through secret-columns.ts instead of a URL.
//    (Column names live in that file alone — enc-boundary.test.ts claim 3
//    reads a mention here, comment or code, as a leak.)
//  * Ruling 13 (Dd/Dg/Dh): a video's duration/size/width/height/state/error
//    code, an output's uid, and the per-input status `reason` all cross the
//    port. Cloudflare writes -1 (duration, size) and 0 (width, height) for
//    "not known yet" — `measured()` maps those to null on the VALUE, never on
//    the state, because a video that ERRORED is no longer `live-inprogress`
//    and a state-keyed rule would pass its -1 into recording_bytes.
import { DELETE_RECORDING_AFTER_DAYS, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS } from "./config";
// The token is ACCOUNT-owned: /user/tokens/verify says "Invalid API Token"
// while every Stream endpoint answers 200 (C12) — nothing here calls it.
// Ruling 13: one stream_provider_calls row per call, through the injected
// recorder. NOOP_RECORDER is a VALUE — the default when nothing is injected —
// so it is a plain import; `ProviderCallRecorder` beside it is a type and is
// erased. The record payload is built inline at the call site, so the
// `ProviderCallRecord` type itself is never named in this file.
import { NOOP_RECORDER } from "./ports";
import type {
  DeleteVideoResult, IngestCapabilities, IngestCreateSpec, IngestCredentials, IngestProvider,
  IngestState, IngestStatus, IngestTarget, IngestVideo, OutputState, ProviderCallRecorder, StorageUsage,
} from "./ports";

export const CLOUDFLARE_STREAM_BASE = "https://api.cloudflare.com/client/v4/accounts";

interface CfEnvelope<T> { success: boolean; result?: T; errors?: { code?: number; message?: string }[] }

/** Dd: -1 (duration, size) and 0 (width, height) are Cloudflare's "not known
 *  yet". Tested on the VALUE, so an errored video's -1 is dropped too; a real
 *  recording is never negative and never 0 px, so nothing true is lost. */
const measured = (n: number | null | undefined): number | null => (typeof n === "number" && n > 0 ? n : null);

export class CloudflareIngest implements IngestProvider {
  readonly capabilities: IngestCapabilities = {
    timeoutSeconds: INGEST_TIMEOUT_SECONDS,
    deleteRecordingAfterDays: DELETE_RECORDING_AFTER_DAYS,
    holdWindowSeconds: { rtmps: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, srt: null },
  };
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly token: string;

  private readonly accountId: string;
  private readonly rec: ProviderCallRecorder;

  constructor(opts: { fetchImpl?: typeof fetch; accountId?: string; token?: string; recorder?: ProviderCallRecorder } = {}) {
    const accountId = opts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = opts.token ?? process.env.CLOUDFLARE_STREAM_TOKEN;
    if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set (RELAY_DRIVERS=live needs it)");
    if (!token) throw new Error("CLOUDFLARE_STREAM_TOKEN is not set (RELAY_DRIVERS=live needs it)");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = `${CLOUDFLARE_STREAM_BASE}/${accountId}/stream`;
    this.token = token;
    this.accountId = accountId;
    this.rec = opts.recorder ?? NOOP_RECORDER;
  }

  /** One request, one record (ruling 13). `meta.ids` are the ids the caller
   *  put in `path`, so the recorder can template them; the account id is
   *  always one of them. `subjectId` is the Cloudflare object the call is
   *  ABOUT — known up front for every operation but the create, which learns
   *  it from the answer (`subjectOf`), so a created input is traceable to the
   *  call that made it exactly as FakeIngest records it. The record never
   *  fails the call. */
  private async call<T>(
    method: "GET" | "POST" | "PUT" | "DELETE", path: string, body: unknown,
    meta: { operation: string; ids: string[]; subjectId?: string | null; subjectOf?: (result: T | undefined) => string | null; sessionId?: string | null },
  ): Promise<{ status: number; json: CfEnvelope<T> }> {
    const url = `${this.base}${path}`;
    const started = Date.now();
    const record = (status: number | null, requestId: string | null, errorCode: string | null, subjectId: string | null) =>
      void Promise.resolve()
        .then(() => this.rec.record({ provider: "cloudflare", operation: meta.operation, subjectId, sessionId: meta.sessionId ?? null,
          method, url, ids: [this.accountId, ...meta.ids], status, latencyMs: Date.now() - started, attempt: 1, requestId, errorCode }))
        .catch(() => undefined);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      record(null, null, "network", meta.subjectId ?? null);
      throw e;
    }
    const json = (await res.json().catch(() => ({ success: false }))) as CfEnvelope<T>;
    record(res.status, res.headers.get("cf-ray"), json.errors?.[0] ? String(json.errors[0].code) : null,
      meta.subjectId ?? meta.subjectOf?.(json.result) ?? null);
    return { status: res.status, json };
  }

  private static fail(what: string, r: { status: number; json: CfEnvelope<unknown> }): never {
    const e = r.json.errors?.[0];
    throw new Error(`cloudflare ${what}: HTTP ${r.status}${e ? ` code ${e.code} ${e.message}` : ""}`);
  }

  async createLiveInput(spec: IngestCreateSpec): Promise<IngestCredentials> {
    const r = await this.call<{
      uid: string;
      rtmps: { url: string; streamKey: string };
      srt: { url: string; streamId: string; passphrase: string };
    }>("POST", "/live_inputs", {
      meta: { name: `seazn-session-${spec.sessionId}-slot-${spec.slot}` },
      recording: {
        mode: "automatic",
        timeoutSeconds: INGEST_TIMEOUT_SECONDS,
        deleteRecordingAfterDays: DELETE_RECORDING_AFTER_DAYS,
      },
    }, { operation: "createLiveInput", ids: [], sessionId: spec.sessionId, subjectOf: (result) => result?.uid ?? null });
    if (!r.json.success || !r.json.result) CloudflareIngest.fail("create live input", r);
    const { uid, rtmps, srt } = r.json.result;
    return {
      inputId: uid,
      srt: { url: srt.url, streamId: srt.streamId, passphrase: srt.passphrase },
      rtmps: { url: rtmps.url, streamKey: rtmps.streamKey },
    };
  }

  async inputStatus(inputId: string): Promise<IngestStatus> {
    const r = await this.call<{
      status?: { current?: { ingestProtocol?: string; state?: string; reason?: string | null; statusEnteredAt?: string; statusLastSeen?: string } } | null;
    }>("GET", `/live_inputs/${encodeURIComponent(inputId)}`, undefined,
      { operation: "inputStatus", ids: [inputId], subjectId: inputId });
    if (r.status === 404) return { state: "unknown", protocol: null, enteredAt: null, lastSeenAt: null, reason: null };
    if (!r.json.success || !r.json.result) CloudflareIngest.fail("input status", r);
    const cur = r.json.result.status?.current;
    // An input that has never connected has no `status.current` at all
    // (absent-as-false) — so there is no reason to report either.
    if (!cur) return { state: "disconnected", protocol: null, enteredAt: null, lastSeenAt: null, reason: null };
    const state: IngestState = cur.state === "connected" ? "connected" : cur.state === "disconnected" ? "disconnected" : "unknown";
    const protocol = cur.ingestProtocol === "srt" ? "srt" : cur.ingestProtocol === "rtmps" || cur.ingestProtocol === "rtmp" ? "rtmps" : null;
    // Dh: verbatim. It is Cloudflare's sentence, not ours to reword — Task 10
    // writes it straight to fixture_stream_samples.ingest_reason.
    return { state, protocol, enteredAt: cur.statusEnteredAt ?? null, lastSeenAt: cur.statusLastSeen ?? null, reason: cur.reason ?? null };
  }

  /** Dg: returns the created output's uid — Task 10 persists it as
   *  sessions.output_uid. The output object carries only uid/url/streamKey/
   *  enabled, so there is no error code here to capture. */
  async addOutput(inputId: string, target: IngestTarget): Promise<string> {
    const r = await this.call<{ uid: string }>("POST", `/live_inputs/${encodeURIComponent(inputId)}/outputs`, {
      url: target.url, streamKey: target.streamKey, enabled: true,
    }, { operation: "addOutput", ids: [inputId], subjectId: inputId });
    if (!r.json.success || !r.json.result) CloudflareIngest.fail("add output", r);
    return r.json.result.uid;
  }

  async outputState(inputId: string): Promise<OutputState> {
    const r = await this.call<{ enabled?: boolean; status?: { current?: { state?: string } } | null }[]>(
      "GET", `/live_inputs/${encodeURIComponent(inputId)}/outputs`, undefined,
      { operation: "outputState", ids: [inputId], subjectId: inputId },
    );
    if (!r.json.success || !r.json.result || r.json.result.length === 0) return "unknown";
    return r.json.result.some((o) => o.status?.current?.state === "error") ? "rejected" : "ok";
  }

  async deleteInput(inputId: string): Promise<void> {
    const r = await this.call("DELETE", `/live_inputs/${encodeURIComponent(inputId)}`, undefined,
      { operation: "deleteInput", ids: [inputId], subjectId: inputId });
    if (r.status === 404 || r.json.success) return;
    CloudflareIngest.fail("delete input", r);
  }

  async storageUsage(): Promise<StorageUsage> {
    const r = await this.call<StorageUsage>("GET", "/storage-usage", undefined,
      { operation: "storageUsage", ids: [] });
    if (!r.json.success || !r.json.result) CloudflareIngest.fail("storage usage", r);
    const { totalStorageMinutes, totalStorageMinutesLimit, videoCount } = r.json.result;
    return { totalStorageMinutes, totalStorageMinutesLimit, videoCount };
  }

  async listVideos(opts: { createdBefore: Date }): Promise<IngestVideo[]> {
    const r = await this.call<{
      uid: string; created: string; liveInput?: string | null;
      status?: { state?: string; errorReasonCode?: string | null };
      duration?: number; size?: number; input?: { width?: number; height?: number } | null;
    }[]>(
      "GET", `?end=${encodeURIComponent(opts.createdBefore.toISOString())}`, undefined,
      { operation: "listVideos", ids: [] },
    );
    if (!r.json.success || !r.json.result) CloudflareIngest.fail("list videos", r);
    return r.json.result.map((v) => ({
      videoId: v.uid,
      inputId: v.liveInput ?? null,
      createdAt: v.created,
      inProgress: v.status?.state === "live-inprogress",
      // Dd — every fact the video object carries. No codec field exists.
      durationSeconds: measured(v.duration),
      sizeBytes: measured(v.size),
      width: measured(v.input?.width),
      height: measured(v.input?.height),
      state: v.status?.state ?? "unknown",
      errorReasonCode: v.status?.errorReasonCode ?? null,
    }));
  }

  async deleteVideo(videoId: string): Promise<DeleteVideoResult> {
    const r = await this.call("DELETE", `/${encodeURIComponent(videoId)}`, undefined,
      { operation: "deleteVideo", ids: [videoId], subjectId: videoId });
    if (r.status === 404) return "absent";
    if (r.status === 409 && r.json.errors?.some((e) => e.code === 10046)) return "in_progress";
    if (r.json.success || (r.status >= 200 && r.status < 300)) return "deleted";
    CloudflareIngest.fail("delete video", r);
  }
}
