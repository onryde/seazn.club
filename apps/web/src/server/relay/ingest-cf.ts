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
// Review I4: the redaction floor, shared with fly-client.ts and defined in the one pure text module — not a
// second copy, and not an import of the sibling DRIVER (two adapters must stay independent of each other).
import { redact } from "./sanitise";
import type {
  DeleteVideoResult, IngestCapabilities, IngestCreateSpec, IngestCredentials, IngestProvider,
  IngestState, IngestStatus, IngestTarget, IngestVideo, OutputState, ProviderCallRecorder, StorageUsage,
} from "./ports";

export const CLOUDFLARE_STREAM_BASE = "https://api.cloudflare.com/client/v4/accounts";
/** The page bound `listVideos` sends. A provider-protocol constant, like the
 *  base URL above — config.ts holds the PRODUCT's numbers and is committed.
 *  The list endpoint is paged, and sending no `limit` takes whatever silent
 *  default the platform applies today; an explicit bound makes the page size
 *  OURS. UNMEASURED (R0 never listed more than a handful): Task 17 verifies
 *  the real ceiling on the live account, and whether `limit` is even the
 *  accepted parameter name. Until then a full page
 *  (`result.length === LIST_VIDEOS_PAGE_LIMIT`) means "there may be more" —
 *  the sweep that consumes this owes the second pass, and that is an
 *  ACCEPTANCE CRITERION in the Task 12 brief, not a promise this comment can
 *  keep. The VALUE is pinned by a literal in the test, never derived from this
 *  constant: a bound that supplies both sides of its own assertion is a
 *  tautology, and a limit of 1 would cap the daily retention sweep at one
 *  video per run and leak the prepaid block. */
export const LIST_VIDEOS_PAGE_LIMIT = 1000;

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
    listVideosPageLimit: LIST_VIDEOS_PAGE_LIMIT,   // m2: the `limit` listVideos sends, declared on the port for the sweep
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
    // C4 is a TYPE here, not only a regex (lane-A minors, Task 4 round-0 minor 5).
    // The union used to admit "PUT", which `ingest-cf.test.ts`'s static C4 ban
    // forbids anywhere in this file — so the one thing that could cause the C4
    // outage (updating a live input's `recording`) was refused by a source scan and
    // welcomed by the compiler. Narrowed to what this adapter actually calls; the
    // scan stays, because a raw `fetch` beside this helper would dodge the type.
    method: "GET" | "POST" | "DELETE", path: string, body: unknown,
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
      // Re-review N2. The ONE throw in this adapter that bypassed the floor below — and the one whose message we did
      // not write: undici rejects with `TypeError: fetch failed`, and a url-shaped failure quotes the url back. The
      // sibling driver's twin (`fly-client.ts`'s `transportFailure`) does not rethrow either; it builds its own
      // sentence, which is what makes the floor absolute rather than best-effort. The original is deliberately NOT
      // attached as `cause`: Node prints a cause beneath the message, so attaching it puts back what this redacts.
      throw new Error(this.red(`cloudflare ${meta.operation}: request failed before a response (${String((e as Error)?.message ?? e)})`));
    }
    const json = (await res.json().catch(() => ({ success: false }))) as CfEnvelope<T>;
    // The `code != null` test, not a bare `errors?.[0]` (lane-A minors, Task 4
    // round-0 minor 1): an error object carrying a MESSAGE but no code wrote the
    // literal string "undefined" into `error_code`. That is worse than an empty
    // column, because it looks like a code and groups and counts as one. The
    // status still tells the row apart from a success.
    record(res.status, res.headers.get("cf-ray"), json.errors?.[0]?.code != null ? String(json.errors[0].code) : null,
      meta.subjectId ?? meta.subjectOf?.(json.result) ?? null);
    return { status: res.status, json };
  }

  /** Whole-branch review I4 (secret handling). Every message this adapter throws goes through here first.
   *
   *  Two secrets can reach a thrown string. The ACCOUNT token is in scope on every call. And the request BODY can
   *  carry the organiser's real destination credential — `addOutput` sends the stream key this lane otherwise keeps
   *  sealed end to end, and Cloudflare's refusal is interpolated VERBATIM below, so a provider that quotes the
   *  offending value back puts it in the message a caller then logs. Whether Cloudflare actually echoes it is
   *  UNMEASURED and not something to find out in production; the finding is that this adapter had no floor at all
   *  while `fly-client.ts` beside it adds every request's env VALUES to its redaction list for exactly this reason.
   *
   *  `per` is those per-request values. It is a parameter rather than constructor state because the secret is
   *  different on every call and belongs to the caller, not to the adapter.
   *
   *  No column name appears in this comment or in any string here: `enc-boundary.test.ts` claims 1–3 do NOT strip
   *  comments, so naming the sealed column would itself be the leak. */
  private red(text: string, per: readonly string[] = []): string {
    return redact(text, [this.token, ...per]);
  }

  private fail(what: string, r: { status: number; json: CfEnvelope<unknown> }, per: readonly string[] = []): never {
    const e = r.json.errors?.[0];
    throw new Error(this.red(`cloudflare ${what}: HTTP ${r.status}${e ? ` code ${e.code} ${e.message}` : ""}`, per));
  }

  async createLiveInput(spec: IngestCreateSpec): Promise<IngestCredentials> {
    const r = await this.call<{
      uid: string;
      rtmps: { url: string; streamKey: string };
      srt: { url: string; streamId: string; passphrase: string };
      /** The settings ECHO. `recording` comes back as
       *  { allowedOrigins, hideLiveViewerCount, mode, requireSignedURLs,
       *  timeoutSeconds } — the retention key is NOT in it (U1-S1), and a
       *  `timeoutSeconds` Cloudflare declined comes back null (U1-S8). */
      recording?: { timeoutSeconds?: number | null } | null;
      deleteRecordingAfterDays?: number | null;
    }>("POST", "/live_inputs", {
      meta: { name: `seazn-session-${spec.sessionId}-slot-${spec.slot}` },
      // U1-S1, MEASURED 2026-09-10: `deleteRecordingAfterDays` is a TOP-LEVEL
      // SIBLING of `recording`, never a member of it. Nested, Cloudflare answers
      // HTTP 200 / success:true, echoes a `recording` block that does not carry
      // the key at all, and leaves top-level `deleteRecordingAfterDays` null —
      // retention is then never configured, the prepaid storage block never
      // recycles, and §6.5's 503 storage_exhausted starts refusing every
      // session, with a green create call at every step.
      recording: { mode: "automatic", timeoutSeconds: INGEST_TIMEOUT_SECONDS },
      deleteRecordingAfterDays: DELETE_RECORDING_AFTER_DAYS,
    }, { operation: "createLiveInput", ids: [], sessionId: spec.sessionId, subjectOf: (result) => result?.uid ?? null });
    if (!r.json.success || !r.json.result) this.fail("create live input", r);
    const { uid, rtmps, srt } = r.json.result;
    // The rule U1-S1, U1-S4 and U1-S8 imply: EVERY setting we send is read back
    // and compared, because all three silent-acceptance traps answer 200. A
    // mismatch is an ERROR and not a warning — `IngestCredentials` has no
    // channel to carry one (ports.ts:20), Task 10 maps a create failure to a
    // visible 503, and an unconfigured retention is visible nowhere at all.
    const echoedTimeout = r.json.result.recording?.timeoutSeconds ?? null;
    const echoedRetention = r.json.result.deleteRecordingAfterDays ?? null;
    const notApplied: string[] = [];
    if (echoedTimeout !== INGEST_TIMEOUT_SECONDS) notApplied.push(`timeoutSeconds sent ${INGEST_TIMEOUT_SECONDS}, echoed ${String(echoedTimeout)}`);
    if (echoedRetention !== DELETE_RECORDING_AFTER_DAYS) notApplied.push(`deleteRecordingAfterDays sent ${DELETE_RECORDING_AFTER_DAYS}, echoed ${String(echoedRetention)}`);
    if (notApplied.length > 0) {
      // The input exists and is misconfigured. Nothing has connected yet, so it
      // holds no recording for `deleteInput` to leak (C2) — dropping it here is
      // what keeps a refused create from leaving an orphan input behind.
      // The cleanup carries the SESSION id so its stream_provider_calls row
      // joins to the session whose provisioning made the input; its subject is
      // the uid either way, which is the handle Task 12's orphan pass needs.
      // If the cleanup itself fails the input is unreclaimable, so the refusal
      // SAYS SO rather than swallowing it — `.catch(() => undefined)` alone
      // left a leak nobody could see.
      const cleanupFailure = await this.deleteInput(uid, { sessionId: spec.sessionId }).then(() => null, (e: unknown) => String(e));
      const orphan = cleanupFailure === null ? ""
        : `; ORPHAN input ${uid} was NOT deleted (${cleanupFailure}) — its failed deleteInput call is recorded under subject ${uid}`;
      // Review I4: this message carries a NESTED provider error (`cleanupFailure`), so it gets the token floor too.
      // Deliberately NOT redacted against the credentials Cloudflare just returned: nothing on this path SENDS them
      // (the create body carries no secret and the cleanup DELETE carries none), and `redact` is a substring
      // replace — a short provider value would silently eat innocent words out of our own diagnosis, which is how
      // this line first read `settings were not a[redacted]lied` against a 2-character test passphrase. The one
      // call that sends a secret is `addOutput`, and it names it there.
      throw new Error(this.red(`cloudflare create live input: settings were not applied — ${notApplied.join("; ")}${orphan}`));
    }
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
    if (!r.json.success || !r.json.result) this.fail("input status", r);
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
    // Review I4: the body carried the organiser's real destination stream key, so the refusal is redacted against
    // THAT value as well as the account token. This is the one call in the adapter that sends a secret.
    if (!r.json.success || !r.json.result) this.fail("add output", r, [target.streamKey]);
    return r.json.result.uid;
  }

  async outputState(inputId: string): Promise<OutputState> {
    const r = await this.call<{ enabled?: boolean; status?: { current?: { state?: string } } | null }[]>(
      "GET", `/live_inputs/${encodeURIComponent(inputId)}/outputs`, undefined,
      { operation: "outputState", ids: [inputId], subjectId: inputId },
    );
    // A failed envelope's body is not authoritative, and a missing array is not
    // an empty one. An EMPTY array needs no clause of its own: it yields no
    // states, and the states rule below already answers that with "unknown" —
    // a separate `length === 0` check was two guards covering for each other,
    // so neither could be killed on its own.
    if (!r.json.success || !r.json.result) return "unknown";
    const states = r.json.result.map((o) => o.status?.current?.state).filter((s): s is string => typeof s === "string");
    if (states.includes("error")) return "rejected";
    // An output Cloudflare has not tried to push to yet carries NO status at
    // all: its `status.current.state` cannot move before inbound video. "ok"
    // there would be a positive claim about something never observed, and Task
    // 10 writes this answer straight into fixture_stream_samples.output_state.
    // Absent evidence is `unknown` — the port has the word for it (ports.ts:33).
    return states.length === 0 ? "unknown" : "ok";
  }

  /** C1 (lane C final review): "Delete an output" — `DELETE /accounts/{account_id}/stream/live_inputs/{live_input_
   *  identifier}/outputs/{output_identifier}`, "Deletes an output and removes it from the associated live input". PINNED
   *  2026-09-29 against Cloudflare's OpenAPI spec (the Cloudflare MCP `search` over `spec.paths`) and the public page
   *  https://developers.cloudflare.com/api/resources/stream/subresources/live_inputs/subresources/outputs/methods/delete/ ,
   *  whose documented success is HTTP 200 with the body `{}` — no `success` envelope, so a 2xx is success on its own
   *  (the DELETE tolerance below, I-3). A 404 is an output already gone: success, so every retry (the daily sweep, the
   *  next admission on the destination) is idempotent. The subject is the OUTPUT — the object the call is about. */
  async removeOutput(inputId: string, outputId: string): Promise<void> {
    const r = await this.call("DELETE", `/live_inputs/${encodeURIComponent(inputId)}/outputs/${encodeURIComponent(outputId)}`, undefined,
      { operation: "removeOutput", ids: [inputId, outputId], subjectId: outputId });
    if (r.status === 404 || r.json.success || (r.status >= 200 && r.status < 300)) return;
    this.fail("remove output", r);
  }

  /** `meta.sessionId` is an ADDITION to the port's signature (an optional
   *  second argument, so `IngestProvider` is still satisfied): it exists so the
   *  create's own cleanup delete records a row that joins to its session. Every
   *  ordinary caller omits it. */
  async deleteInput(inputId: string, meta: { sessionId?: string | null } = {}): Promise<void> {
    const r = await this.call("DELETE", `/live_inputs/${encodeURIComponent(inputId)}`, undefined,
      { operation: "deleteInput", ids: [inputId], subjectId: inputId, sessionId: meta.sessionId ?? null });
    // A 2xx carrying an empty or unparseable body is SUCCESS, on this path and
    // on deleteVideo's alike — `call()` reports an unbodied 200/204 as
    // { success: false }, and the two DELETEs used to read that oppositely.
    // The COST of that tolerance, stated rather than left to be rediscovered
    // (lane-A minors, Task 4 re-review 2): a 200 carrying `{ success: false,
    // errors: [...] }` also resolves here. On the create's cleanup path that means
    // `cleanupFailure` is null and the refusal prints no orphan warning while the
    // input survives — an input nothing will ever reclaim. Theoretical: Cloudflare
    // reports errors with a non-2xx status, which is why I-3 ruled the tolerance in
    // (it is symmetric and safe either way against the UNMEASURED real reply). The
    // Task 17 live-watch item "what DELETE /live_inputs/{uid} actually returns" is
    // what closes it; until then, do not tighten this without that measurement, and
    // do not widen it either.
    if (r.status === 404 || r.json.success || (r.status >= 200 && r.status < 300)) return;
    this.fail("delete input", r);
  }

  async storageUsage(): Promise<StorageUsage> {
    const r = await this.call<StorageUsage>("GET", "/storage-usage", undefined,
      { operation: "storageUsage", ids: [] });
    if (!r.json.success || !r.json.result) this.fail("storage usage", r);
    const { totalStorageMinutes, totalStorageMinutesLimit, videoCount } = r.json.result;
    // The three numbers are CHECKED, not just destructured out of a cast envelope
    // (lane-A minors, Task 4 round-0 minor 2). `{ success: true, result: {} }` used
    // to hand back `{ undefined, undefined, undefined }` TYPED as StorageUsage, and
    // Task 10's headroom arithmetic became NaN three call sites downstream. It fails
    // closed either way, so this is diagnosability rather than money — but a NaN is a
    // bad way to learn that Cloudflare renamed a field. `typeof` rather than a
    // truthiness test: a legitimate 0 must pass.
    if (typeof totalStorageMinutes !== "number" || typeof totalStorageMinutesLimit !== "number" || typeof videoCount !== "number") {
      this.fail("storage usage: the 2xx result is missing totalStorageMinutes / totalStorageMinutesLimit / videoCount", r);
    }
    return { totalStorageMinutes, totalStorageMinutesLimit, videoCount };
  }

  async listVideos(opts: { createdBefore: Date }): Promise<IngestVideo[]> {
    const r = await this.call<{
      uid: string; created: string; liveInput?: string | null;
      status?: { state?: string; errorReasonCode?: string | null };
      duration?: number; size?: number; input?: { width?: number; height?: number } | null;
    }[]>(
      "GET", `?end=${encodeURIComponent(opts.createdBefore.toISOString())}&limit=${LIST_VIDEOS_PAGE_LIMIT}`, undefined,
      { operation: "listVideos", ids: [] },
    );
    if (!r.json.success || !r.json.result) this.fail("list videos", r);
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
    this.fail("delete video", r);
  }
}
