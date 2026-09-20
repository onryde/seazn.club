// The Cloudflare adapter against a recording fetch — every claim here is one
// R0 measured (R0-CORRECTIONS-FOR-R1.md rows named per test). Three kinds:
// behavioural (the request the adapter sends / the answer it gives back),
// DIFFERENTIAL (Task 3 review G1: the fake's recorded path shapes and subject
// ids must equal the real adapter's, or Task 10's DB tests prove the fake),
// and STATIC (source scans over server/relay/** for the four things that must
// never appear: a recording-mode update on a live input (C4),
// preferLowLatency (C11), /user/tokens/verify (C12), a manifest fetch or an
// ENDLIST read (C8/C13)). Each absent-grep has a present-grep twin.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CLOUDFLARE_STREAM_BASE, CloudflareIngest, LIST_VIDEOS_PAGE_LIMIT } from "../ingest-cf";
import { FakeIngest, FakeRecorder } from "../fakes";
import { pathTemplate } from "../sanitise";
import type { ProviderCallRecord } from "../ports";
import {
  CLOUDFLARE_RETENTION_RANGE, DELETE_RECORDING_AFTER_DAYS, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS,
} from "../config";

type Call = { url: string; init: RequestInit };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
function recorder(reply: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    const r = reply(c);
    // `JSON.stringify(undefined)` is undefined, which builds a body-less
    // Response — that is how the I-3 fixtures answer a DELETE with no JSON.
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

// Task 4 carry C1 (owner ruling 2026-09-16): a live input's `srt.url` is BARE —
// `streamId` and `passphrase` are separate fields and never ride in a query
// string. The plan's own fixture showed `?passphrase=…&streamid=…`; that shape
// would hide Task 2's query-strip AND its sealing of {passphrase, streamId}.
// The create response ECHOES the settings back (U1-S1's own dump, measured
// 2026-09-10): `recording` carries five keys and NOT the retention one, which
// is a TOP-LEVEL sibling. Both echoes are derived from config, never typed as
// literals, so moving a constant moves this fixture with it.
const CREATE_RESULT = {
  uid: "in_abc",
  rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: "rk" },
  srt: { url: "srt://live.cloudflare.com:778", streamId: "sid", passphrase: "pp" },
  webRTC: { url: "https://x/webrtc/publish" },
  webRTCPlayback: { url: "https://x/webrtc/play" },
  status: null,
  recording: { allowedOrigins: null, hideLiveViewerCount: false, mode: "automatic", requireSignedURLs: false, timeoutSeconds: INGEST_TIMEOUT_SECONDS },
  deleteRecordingAfterDays: DELETE_RECORDING_AFTER_DAYS,
};
/** The MEASURED consequence of nesting the retention key: a green 200 whose
 *  `recording` echo does not carry it and whose top-level value is null. */
const CREATE_RESULT_DROPPED = {
  ...CREATE_RESULT,
  recording: { allowedOrigins: null, hideLiveViewerCount: false, mode: "automatic", requireSignedURLs: false, timeoutSeconds: INGEST_TIMEOUT_SECONDS },
  deleteRecordingAfterDays: null,
};
/** U1-S8: a `timeoutSeconds` Cloudflare declined comes back null, not applied. */
const CREATE_RESULT_TIMEOUT_NULL = {
  ...CREATE_RESULT,
  recording: { allowedOrigins: null, hideLiveViewerCount: false, mode: "automatic", requireSignedURLs: false, timeoutSeconds: null },
};
/** N-4: a bad echo whose input then REFUSES to be deleted — the one path that
 *  leaves a live input nothing will ever reclaim. */
const CREATE_RESULT_ORPHAN = { ...CREATE_RESULT_DROPPED, uid: "in_undeletable" };

function cfReply(c: Call): Reply {
  if (c.init.method === "POST" && c.url.endsWith("/live_inputs")) {
    // Keyed on the session id the adapter puts in `meta.name`, so one fixture
    // can answer three different creates.
    const name = String((JSON.parse(String(c.init.body)) as { meta?: { name?: string } }).meta?.name ?? "");
    if (name.includes("s_orphan")) return { status: 200, body: { success: true, result: CREATE_RESULT_ORPHAN } };
    if (name.includes("s_dropped")) return { status: 200, body: { success: true, result: CREATE_RESULT_DROPPED } };
    if (name.includes("s_notimeout")) return { status: 200, body: { success: true, result: CREATE_RESULT_TIMEOUT_NULL } };
    return { status: 200, body: { success: true, result: CREATE_RESULT } };
  }
  if (c.init.method === "GET" && /\/live_inputs\/in_abc$/.test(c.url))
    return { status: 200, body: { success: true, result: { uid: "in_abc", status: { current: { ingestProtocol: "srt", state: "connected", reason: "connected_to_live_input", statusEnteredAt: "2026-09-13T10:00:00Z", statusLastSeen: "2026-09-13T10:00:05Z" }, history: [] } } } };
  if (c.init.method === "GET" && /\/live_inputs\/in_never$/.test(c.url))
    return { status: 200, body: { success: true, result: { uid: "in_never" } } };
  if (c.init.method === "GET" && /\/live_inputs\/in_rtmps$/.test(c.url))
    return { status: 200, body: { success: true, result: { uid: "in_rtmps", status: { current: { ingestProtocol: "rtmp", state: "disconnected", reason: "waiting_for_input", statusEnteredAt: "2026-09-13T10:01:00Z", statusLastSeen: "2026-09-13T10:01:00Z" } } } } };
  if (c.init.method === "GET" && /\/live_inputs\/in_noout\/outputs$/.test(c.url))
    return { status: 200, body: { success: true, result: [] } };
  if (c.init.method === "GET" && /\/live_inputs\/in_okout\/outputs$/.test(c.url))
    return { status: 200, body: { success: true, result: [{ uid: "out_2", enabled: true, status: { current: { state: "connected" } } }] } };
  // I-2: an output Cloudflare has never tried to push to. There is no `status`
  // key at all — the common case for the whole of `warming`.
  if (c.init.method === "GET" && /\/live_inputs\/in_pending\/outputs$/.test(c.url))
    return { status: 200, body: { success: true, result: [{ uid: "out_3", enabled: true }] } };
  // N-2: the two remaining guards, each with its own case. A success envelope
  // with NO result array is not an empty list, and a FAILED envelope's body is
  // not authoritative however healthy it looks.
  if (c.init.method === "GET" && /\/live_inputs\/in_noresult\/outputs$/.test(c.url))
    return { status: 200, body: { success: true } };
  if (c.init.method === "GET" && /\/live_inputs\/in_failed\/outputs$/.test(c.url))
    return { status: 200, body: { success: false, errors: [{ code: 10001 }], result: [{ uid: "out_4", status: { current: { state: "connected" } } }] } };
  if (c.init.method === "GET" && /\/live_inputs\/in_gone$/.test(c.url))
    return { status: 404, body: { success: false, errors: [{ code: 10003, message: "not found" }] } };
  if (c.init.method === "POST" && /\/outputs$/.test(c.url)) return { status: 200, body: { success: true, result: { uid: "out_1" } } };
  if (c.init.method === "GET" && /\/outputs$/.test(c.url))
    return { status: 200, body: { success: true, result: [{ uid: "out_1", enabled: true, status: { current: { state: "error", reason: "destination refused" } } }] } };
  if (c.init.method === "GET" && c.url.endsWith("/storage-usage"))
    return { status: 200, body: { success: true, result: { totalStorageMinutes: 396.84, totalStorageMinutesLimit: 1000, videoCount: 7 } } };
  if (c.init.method === "GET" && /\/stream\?end=/.test(c.url))
    // Dd: the -1 / 0 placeholders are what the probe actually returns while
    // a recording is live, AND on one that errored before it had dimensions.
    return { status: 200, body: { success: true, result: [
      { uid: "v_live", created: "2026-09-01T00:00:00Z", status: { state: "live-inprogress" }, liveInput: "in_abc", duration: -1, size: -1, input: { width: 0, height: 0 } },
      { uid: "v_done", created: "2026-09-01T00:00:00Z", status: { state: "ready" }, liveInput: null, duration: 61.5, size: 734003200, input: { width: 1280, height: 720 } },
      { uid: "v_err", created: "2026-09-01T00:00:00Z", status: { state: "error", errorReasonCode: "ERR_NON_VIDEO" }, liveInput: null, duration: -1, size: -1, input: { width: 0, height: 0 } },
    ] } };
  if (c.init.method === "DELETE" && /\/stream\/v_live$/.test(c.url))
    return { status: 409, body: { success: false, errors: [{ code: 10046, message: "recording in progress" }] } };
  if (c.init.method === "DELETE" && /\/stream\/v_done$/.test(c.url)) return { status: 200, body: { success: true } };
  if (c.init.method === "DELETE" && /\/stream\/v_gone$/.test(c.url)) return { status: 404, body: { success: false, errors: [{ code: 10003 }] } };
  if (c.init.method === "DELETE" && /\/live_inputs\/in_abc$/.test(c.url)) return { status: 200, body: { success: true } };
  if (c.init.method === "DELETE" && /\/live_inputs\/in_gone$/.test(c.url)) return { status: 404, body: { success: false } };
  // I-3: a 2xx with NO parseable body, on both delete paths. `call()` reads an
  // unbodied answer as { success: false }, which the two used to treat oppositely.
  if (c.init.method === "DELETE" && /\/live_inputs\/in_nobody$/.test(c.url)) return { status: 204, body: undefined };
  // N-4: the cleanup delete itself fails, so the misconfigured input survives.
  if (c.init.method === "DELETE" && /\/live_inputs\/in_undeletable$/.test(c.url))
    return { status: 500, body: { success: false, errors: [{ code: 10001, message: "internal error" }] } };
  if (c.init.method === "DELETE" && /\/stream\/v_nobody$/.test(c.url)) return { status: 200, body: undefined };
  return { status: 500, body: { success: false, errors: [{ message: `unexpected ${String(c.init.method)} ${c.url}` }] } };
}

describe("CloudflareIngest", () => {
  let ingest: CloudflareIngest;
  let rec: ReturnType<typeof recorder>;
  beforeEach(() => {
    rec = recorder(cfReply);
    ingest = new CloudflareIngest({ fetchImpl: rec.fetchImpl, accountId: "acct", token: "tok" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("create: deleteRecordingAfterDays is a TOP-LEVEL sibling of recording, never a member of it (U1-S1), with mode automatic and timeoutSeconds from config inside Cloudflare's range (C1, C4, C8)", async () => {
    await ingest.createLiveInput({ sessionId: "s1", slot: 0 });
    const c = rec.calls[0]!;
    expect(c.url).toBe(`${CLOUDFLARE_STREAM_BASE}/acct/stream/live_inputs`);
    expect((c.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(String(c.init.body)) as { recording: Record<string, unknown>; deleteRecordingAfterDays?: unknown };
    // MEASURED 2026-09-10 (U1-S1): nested, the key is accepted with a green 200
    // and dropped on the floor. `toEqual` is exact, so this reds the moment the
    // nesting returns — and the explicit membership check says why out loud.
    expect(body.recording).toEqual({ mode: "automatic", timeoutSeconds: INGEST_TIMEOUT_SECONDS });
    expect("deleteRecordingAfterDays" in body.recording).toBe(false);
    expect(body.deleteRecordingAfterDays).toBe(DELETE_RECORDING_AFTER_DAYS);
    // The constant itself is held to the measured range — 1 and 7 are HTTP 400
    // code 10060 on this account (C1). A mutant "7" dies here, not only above.
    expect(DELETE_RECORDING_AFTER_DAYS).toBeGreaterThanOrEqual(CLOUDFLARE_RETENTION_RANGE.min);
    expect(DELETE_RECORDING_AFTER_DAYS).toBeLessThanOrEqual(CLOUDFLARE_RETENTION_RANGE.max);
    expect("preferLowLatency" in body).toBe(false);
  });

  it("create: READS THE SETTINGS BACK — a retention echo of null (the nested-drop signature, U1-S1) and a timeoutSeconds echo of null (U1-S8) each refuse the create and delete the misconfigured input; the good echo passes", async () => {
    // A 200 cannot see any of the three silent-acceptance traps; only the echo can.
    await expect(ingest.createLiveInput({ sessionId: "s_dropped", slot: 0 })).rejects.toThrow(/deleteRecordingAfterDays/);
    // …and the input it created is not left behind to record forever.
    expect(rec.calls.map((x) => `${String(x.init.method)} ${x.url}`)).toEqual([
      `POST ${CLOUDFLARE_STREAM_BASE}/acct/stream/live_inputs`,
      `DELETE ${CLOUDFLARE_STREAM_BASE}/acct/stream/live_inputs/in_abc`,
    ]);
    await expect(ingest.createLiveInput({ sessionId: "s_notimeout", slot: 0 })).rejects.toThrow(/timeoutSeconds/);
    // Positive twin: the echo Cloudflare sends when the settings DID apply.
    await expect(ingest.createLiveInput({ sessionId: "s1", slot: 0 })).resolves.toMatchObject({ inputId: "in_abc" });
  });

  it("when the cleanup DELETE also fails, the create still refuses, the message NAMES the orphan uid, and the failed cleanup is recorded under that uid with its session id (N-4)", async () => {
    const port = new FakeRecorder();
    const cf = new CloudflareIngest({ fetchImpl: recorder(cfReply).fetchImpl, accountId: "acct", token: "tok", recorder: port });
    await expect(cf.createLiveInput({ sessionId: "s_orphan", slot: 0 })).rejects.toThrow(/ORPHAN input in_undeletable was NOT deleted/);
    await new Promise((r) => setImmediate(r));
    // Task 12's orphan pass is driven from provider-call rows, so the row for
    // the failed cleanup must name the input — a null subject would lose it.
    const cleanup = port.calls.find((c) => c.operation === "deleteInput");
    expect(cleanup).toMatchObject({ subjectId: "in_undeletable", sessionId: "s_orphan", status: 500, method: "DELETE" });
    expect(cleanup!.url).toContain("in_undeletable");
    // …and an ordinary deleteInput still records no session (nothing to join).
    await cf.deleteInput("in_abc");
    await new Promise((r) => setImmediate(r));
    expect(port.calls.filter((c) => c.operation === "deleteInput").at(-1)).toMatchObject({ subjectId: "in_abc", sessionId: null });
  });

  it("create: returns both credential shapes, a BARE srt URL (C1), and drops webRTC / webRTCPlayback (C10)", async () => {
    const creds = await ingest.createLiveInput({ sessionId: "s1", slot: 0 });
    expect(creds).toEqual({
      inputId: "in_abc",
      srt: { url: "srt://live.cloudflare.com:778", streamId: "sid", passphrase: "pp" },
      rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: "rk" },
    });
    // Negative pair for the bare-URL ruling: no secret, and no query string at
    // all, rides in the URL the session row stores.
    expect(creds.srt.url).not.toContain("?");
    expect(creds.srt.url).not.toContain("pp");
    expect(JSON.stringify(creds).toLowerCase()).not.toContain("webrtc");
  });

  it("capabilities: hold = timeoutSeconds + 3 for RTMPS only; SRT is null (C8)", () => {
    expect(ingest.capabilities.holdWindowSeconds).toEqual({ rtmps: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, srt: null });
    expect(ingest.capabilities.timeoutSeconds).toBe(INGEST_TIMEOUT_SECONDS);
    expect(ingest.capabilities.deleteRecordingAfterDays).toBe(DELETE_RECORDING_AFTER_DAYS);
  });

  it("inputStatus reads the PER-INPUT GET and its status.current shape, carrying reason through (Dh); absent status is disconnected; 404 is unknown (C5)", async () => {
    const s = await ingest.inputStatus("in_abc");
    expect(rec.calls[0]!.url).toBe(`${CLOUDFLARE_STREAM_BASE}/acct/stream/live_inputs/in_abc`);
    expect(s).toEqual({ state: "connected", protocol: "srt", enteredAt: "2026-09-13T10:00:00Z", lastSeenAt: "2026-09-13T10:00:05Z", reason: "connected_to_live_input" });
    // An input that never connected has no status.current at all, so no reason.
    expect(await ingest.inputStatus("in_never")).toMatchObject({ state: "disconnected", reason: null });
    expect((await ingest.inputStatus("in_gone")).state).toBe("unknown");
    // The OTHER leg (R-A: the phone may push either). Cloudflare spells the
    // protocol "rtmp"; the port's vocabulary is "rtmps", and a disconnected
    // input still reports which protocol it was last seen on.
    expect(await ingest.inputStatus("in_rtmps")).toEqual({
      state: "disconnected", protocol: "rtmps", enteredAt: "2026-09-13T10:01:00Z", lastSeenAt: "2026-09-13T10:01:00Z", reason: "waiting_for_input",
    });
  });

  it("addOutput posts exactly one enabled output and returns its uid (Dg); outputState maps an error state to rejected", async () => {
    const outputUid = await ingest.addOutput("in_abc", { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "yt" });
    expect(rec.calls[0]!.url).toBe(`${CLOUDFLARE_STREAM_BASE}/acct/stream/live_inputs/in_abc/outputs`);
    const body = JSON.parse(String(rec.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "yt", enabled: true });
    expect(rec.calls).toHaveLength(1);   // exactly once
    expect(outputUid).toBe("out_1");   // what Task 10 persists as sessions.output_uid
    expect(await ingest.outputState("in_abc")).toBe("rejected");
    // Positive pair for the "rejected" negative, and the two absent-evidence
    // cases: an input carrying a healthy output is "ok"; one carrying NO output
    // is "unknown"; and one whose output has NO STATUS YET — the common case for
    // the whole of warming, since Cloudflare cannot push before inbound video —
    // is "unknown" too, never "ok". Task 10 writes this into
    // fixture_stream_samples.output_state, so "ok" there would be a fact we made up.
    expect(await ingest.outputState("in_okout")).toBe("ok");
    expect(await ingest.outputState("in_noout")).toBe("unknown");
    expect(await ingest.outputState("in_pending")).toBe("unknown");
    // N-2: and the two envelope guards, so no branch is covered only by another.
    expect(await ingest.outputState("in_noresult")).toBe("unknown");
    expect(await ingest.outputState("in_failed")).toBe("unknown");
  });

  it("storageUsage returns the three fields raw — no headroom arithmetic in the adapter (C3)", async () => {
    expect(await ingest.storageUsage()).toEqual({ totalStorageMinutes: 396.84, totalStorageMinutesLimit: 1000, videoCount: 7 });
  });

  it("listVideos filters by created-before, flags live-inprogress, and maps the recording facts — every -1/0 placeholder to null, on the VALUE not the state (Dd); deleteVideo maps 200/409-10046/404 (C2)", async () => {
    const vids = await ingest.listVideos({ createdBefore: new Date("2026-09-10T00:00:00Z") });
    // I-4 / N-1: the list endpoint is paged. The bound is EXPLICIT and ours,
    // never the platform's silent default — and it is pinned as a LITERAL on
    // both sides. Deriving the expected URL from LIST_VIDEOS_PAGE_LIMIT made
    // the assertion a tautology: the reviewer set the constant to 1 and the
    // suite stayed green, while a bound of 1 would cap the daily retention
    // sweep at one video per run and leak the prepaid storage block.
    expect(rec.calls[0]!.url).toBe(`${CLOUDFLARE_STREAM_BASE}/acct/stream?end=2026-09-10T00%3A00%3A00.000Z&limit=1000`);
    expect(LIST_VIDEOS_PAGE_LIMIT).toBe(1000);
    expect(vids).toEqual([
      { videoId: "v_live", inputId: "in_abc", createdAt: "2026-09-01T00:00:00Z", inProgress: true, durationSeconds: null, sizeBytes: null, width: null, height: null, state: "live-inprogress", errorReasonCode: null },
      { videoId: "v_done", inputId: null, createdAt: "2026-09-01T00:00:00Z", inProgress: false, durationSeconds: 61.5, sizeBytes: 734003200, width: 1280, height: 720, state: "ready", errorReasonCode: null },
      // The differential the "map on the value" rule exists for: this one is
      // NOT live-inprogress, so a state-keyed mapping would pass its -1 straight
      // into recording_bytes.
      { videoId: "v_err", inputId: null, createdAt: "2026-09-01T00:00:00Z", inProgress: false, durationSeconds: null, sizeBytes: null, width: null, height: null, state: "error", errorReasonCode: "ERR_NON_VIDEO" },
    ]);
    expect(await ingest.deleteVideo("v_live")).toBe("in_progress");
    expect(await ingest.deleteVideo("v_done")).toBe("deleted");
    expect(await ingest.deleteVideo("v_gone")).toBe("absent");
  });

  it("both DELETEs treat a 2xx with no parseable body as SUCCESS, and deleteInput still resolves on 404 (I-3)", async () => {
    await expect(ingest.deleteInput("in_abc")).resolves.toBeUndefined();
    await expect(ingest.deleteInput("in_gone")).resolves.toBeUndefined();
    // A 204 with an empty body is what a DELETE may well answer; `call()` reads
    // it as { success: false }, and throwing there would fail the sweep's happy
    // path permanently. The two paths now agree.
    await expect(ingest.deleteInput("in_nobody")).resolves.toBeUndefined();
    expect(await ingest.deleteVideo("v_nobody")).toBe("deleted");
    // …and the call is still recorded, exactly like every other.
    expect(rec.calls.map((x) => x.url.split("/stream")[1])).toEqual([
      "/live_inputs/in_abc", "/live_inputs/in_gone", "/live_inputs/in_nobody", "/v_nobody",
    ]);
  });

  it("refuses to construct in live mode without account id and token", () => {
    const keep = { a: process.env.CLOUDFLARE_ACCOUNT_ID, t: process.env.CLOUDFLARE_STREAM_TOKEN };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_STREAM_TOKEN;
    try {
      expect(() => new CloudflareIngest()).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
      process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
      expect(() => new CloudflareIngest()).toThrow(/CLOUDFLARE_STREAM_TOKEN/);
    } finally {
      // Assigning `undefined` to process.env stores the STRING "undefined" and
      // would leak a bogus account id into every later test in THIS FILE — not,
      // as this comment used to say, into every later file in the process
      // (lane-A minors, Task 4 round-0 minor 4). `apps/web/vitest.config.ts` sets
      // `isolate: true` with `pool: "threads"`, so each file gets its own worker
      // and its own `process.env`. Still a real leak, and still restored here;
      // the blast radius is one file, and the guard this would defeat — "refuses
      // to construct without env", two lines up — lives in this file.
      if (keep.a === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = keep.a;
      if (keep.t === undefined) delete process.env.CLOUDFLARE_STREAM_TOKEN;
      else process.env.CLOUDFLARE_STREAM_TOKEN = keep.t;
    }
  });

  it("records every call through the ProviderCallRecorder: raw URL + the ids to template, cf-ray as requestId, the CF error code on a failure, and a thrown fetch as status null", async () => {
    const port = new FakeRecorder();
    // I-1: only the FIRST reply carries a cf-ray, so the mapping is pinned with
    // its negative pair — a response without the header records null, not "".
    const { fetchImpl } = recorder((c) => c.url.endsWith("/live_inputs")
      ? { status: 200, body: { success: true, result: CREATE_RESULT }, headers: { "cf-ray": "9a3f0c2b1d4e5f60-LHR" } }
      : { status: 400, body: { success: false, errors: [{ code: 10005, message: "not found" }] } });
    const cf = new CloudflareIngest({ fetchImpl, accountId: "acc1", token: "tok-secret", recorder: port });
    const creds = await cf.createLiveInput({ sessionId: "s1", slot: 0 });
    await cf.inputStatus("in-missing").catch(() => undefined);
    const dead = new CloudflareIngest({
      fetchImpl: vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
      accountId: "acc1", token: "tok-secret", recorder: port,
    });
    await dead.storageUsage().catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(port.calls.map((c) => [c.operation, c.status, c.errorCode])).toEqual([["createLiveInput", 200, null], ["inputStatus", 400, "10005"], ["storageUsage", null, "network"]]);
    expect(port.calls[0]!.sessionId).toBe("s1");
    // Cloudflare's cf-ray IS the request id — the only handle a support ticket
    // on a failed broadcast has, and Ruling 13 puts it on every row.
    expect(port.calls.map((c) => c.requestId)).toEqual(["9a3f0c2b1d4e5f60-LHR", null, null]);
    expect(port.calls[1]!.ids).toEqual(["acc1", "in-missing"]);
    for (const c of port.calls) { expect(c.url).toContain("acc1"); expect(JSON.stringify(c)).not.toContain("tok-secret"); }
    expect(creds.inputId).toBeTruthy();
  });

  // Lane-A minors, Task 4 round-0 minor 6: the twin above scans for the API TOKEN
  // alone, so a row leaking the SRT `passphrase` or the RTMPS `streamKey` — both
  // secrets this adapter handles, and both arriving in a RESPONSE rather than a
  // header, so redaction has no standing list to catch them — would have passed it.
  // It gets its OWN fixture rather than extending that loop: the shared
  // CREATE_RESULT's secrets are two characters ("rk", "pp"), and "rk" is a
  // substring of the word `network` that a failed row's errorCode carries, so a
  // whole-row `not.toContain` over them is unreliable in BOTH directions. A probe
  // for a secret has to be distinctive enough that matching it means something.
  it("no recorded row carries the SRT passphrase or the RTMPS stream key either — not just the API token", async () => {
    const SRT_SECRET = "srt-passphrase-DO-NOT-LEAK-8f3a";
    const RTMPS_SECRET = "rtmps-streamkey-DO-NOT-LEAK-2b91";
    const port = new FakeRecorder();
    const { fetchImpl } = recorder((c) => c.init.method === "POST" && c.url.endsWith("/live_inputs")
      ? { status: 200, body: { success: true, result: { ...CREATE_RESULT, rtmps: { ...CREATE_RESULT.rtmps, streamKey: RTMPS_SECRET }, srt: { ...CREATE_RESULT.srt, passphrase: SRT_SECRET } } } }
      : { status: 200, body: { success: true, result: { uid: "in_abc", status: { current: { state: "connected", reason: null } } } } });
    const cf = new CloudflareIngest({ fetchImpl, accountId: "acc1", token: "tok-secret", recorder: port });
    const creds = await cf.createLiveInput({ sessionId: "s1", slot: 0 });
    await cf.inputStatus(creds.inputId);
    await new Promise((r) => setImmediate(r));
    // Not vacuous, in two directions: rows WERE written, and the credentials really
    // do carry the values being looked for.
    expect(port.calls.length).toBeGreaterThan(0);
    expect(creds.srt.passphrase).toBe(SRT_SECRET);
    expect(creds.rtmps.streamKey).toBe(RTMPS_SECRET);
    for (const c of port.calls) {
      const row = JSON.stringify(c);
      expect(row, c.operation).not.toContain(SRT_SECRET);
      expect(row, c.operation).not.toContain(RTMPS_SECRET);
      expect(row, c.operation).not.toContain("tok-secret");
    }
  });

  // Lane-A minors, Task 4 round-0 minor 1: `String(json.errors[0].code)` wrote the
  // LITERAL string "undefined" into `error_code` whenever Cloudflare returned an
  // error object carrying a message but no code — a shape the test file's own
  // catch-all reply already had. A ledger column reading "undefined" is worse than
  // an empty one: it looks like a code, so it groups and counts as one.
  it("an error object with a message but NO code records error_code null, never the string \"undefined\"", async () => {
    const port = new FakeRecorder();
    const { fetchImpl } = recorder(() => ({ status: 500, body: { success: false, errors: [{ message: "internal" }] } }));
    const cf = new CloudflareIngest({ fetchImpl, accountId: "acc1", token: "tok", recorder: port });
    await cf.inputStatus("in_x").catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.errorCode).toBeNull();
    // The positive twin — a code that IS present still lands, so this is not just
    // "null everywhere".
    const port2 = new FakeRecorder();
    const cf2 = new CloudflareIngest({ fetchImpl: recorder(() => ({ status: 400, body: { success: false, errors: [{ code: 10005, message: "nope" }] } })).fetchImpl, accountId: "acc1", token: "tok", recorder: port2 });
    await cf2.inputStatus("in_y").catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(port2.calls[0]!.errorCode).toBe("10005");
  });

  // Whole-branch review I4 (secret handling). Before this the word "redact" did not appear in ingest-cf.ts at all:
  // `fail` interpolated Cloudflare's own `errors[0].message` VERBATIM into the thrown Error, and `addOutput` POSTs the
  // organiser's real destination stream key — the credential this lane otherwise keeps sealed end to end. Whether
  // Cloudflare echoes a rejected value back is UNMEASURED and deliberately not measured live; the finding is the
  // missing floor, so these rows script a provider that DOES echo and assert the floor holds.
  it("I4: a Cloudflare refusal that quotes the destination stream key back does not put it in the thrown message — nor the account token, on any call; the positive twin is that something WAS redacted and the rest of the sentence survives", async () => {
    const KEY = "yt-live-key-SECRET";
    const TOK = "cf-account-token-SECRET";
    // The provider quotes both our body value and (the worst case) our own credential back at us.
    const echoing = recorder(() => ({ status: 400, body: { success: false, errors: [{ code: 10004, message: `bad output streamKey=${KEY} for token ${TOK}` }] } }));
    const cf = new CloudflareIngest({ fetchImpl: echoing.fetchImpl, accountId: "acc1", token: TOK });
    const err = await cf.addOutput("in_abc", { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: KEY }).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(KEY);
    expect(err!.message).not.toContain(TOK);
    expect(err!.message).toContain("[redacted]");                 // positive twin: the redaction ran
    expect(err!.message).toContain("cloudflare add output: HTTP 400 code 10004");  // …and did not eat the diagnosis
    // Every OTHER call still gets the token floor even with no per-request secret to add.
    const other = new CloudflareIngest({
      fetchImpl: recorder(() => ({ status: 500, body: { success: false, errors: [{ code: 10001, message: `upstream said ${TOK}` }] } })).fetchImpl,
      accountId: "acc1", token: TOK,
    });
    await expect(other.inputStatus("in_abc")).rejects.toThrow(/\[redacted\]/);
    await expect(other.inputStatus("in_abc")).rejects.not.toThrow(new RegExp(TOK));
    // …and the create's own "settings were not applied" throw, which carries a NESTED provider error plus the
    // credentials Cloudflare just handed us, is redacted too.
    const settings = new CloudflareIngest({
      fetchImpl: recorder((c) => (c.init.method === "POST"
        ? { status: 200, body: { success: true, result: CREATE_RESULT_DROPPED } }
        : { status: 500, body: { success: false, errors: [{ code: 10002, message: `cleanup refused for ${TOK}` }] } })).fetchImpl,
      accountId: "acc1", token: TOK,
    });
    const createErr = await settings.createLiveInput({ sessionId: "s1", slot: 0 }).then(() => null, (e: unknown) => e as Error);
    expect(createErr!.message).toContain("settings were not applied");
    expect(createErr!.message).not.toContain(TOK);
    expect(createErr!.message).toContain("[redacted]");
  });

  // Lane-A minors, Task 4 round-0 minor 2: `storageUsage` destructured three
  // numbers straight out of a CAST envelope. `{ success: true, result: {} }` handed
  // back `{ undefined, undefined, undefined }` TYPED as StorageUsage, and Task 10's
  // headroom arithmetic then became NaN. It fails closed either way, so this is
  // diagnosability rather than money — but a NaN three call-sites downstream is a
  // bad way to learn that Cloudflare changed a field name.
  it("storageUsage REFUSES a 2xx whose result is missing the numbers, rather than returning undefined typed as a number", async () => {
    const cf = new CloudflareIngest({ fetchImpl: recorder(() => ({ status: 200, body: { success: true, result: {} } })).fetchImpl, accountId: "acc1", token: "tok" });
    await expect(cf.storageUsage()).rejects.toThrow(/storage usage/);
    // and a result carrying a NON-number is refused too, not coerced
    const bad = new CloudflareIngest({ fetchImpl: recorder(() => ({ status: 200, body: { success: true, result: { totalStorageMinutes: "396.84", totalStorageMinutesLimit: 1000, videoCount: 7 } } })).fetchImpl, accountId: "acc1", token: "tok" });
    await expect(bad.storageUsage()).rejects.toThrow(/storage usage/);
    // The positive twin: a well-formed result still passes straight through (C3 —
    // no arithmetic in the adapter), including a legitimate ZERO.
    const ok = new CloudflareIngest({ fetchImpl: recorder(() => ({ status: 200, body: { success: true, result: { totalStorageMinutes: 0, totalStorageMinutesLimit: 1000, videoCount: 0 } } })).fetchImpl, accountId: "acc1", token: "tok" });
    await expect(ok.storageUsage()).resolves.toEqual({ totalStorageMinutes: 0, totalStorageMinutesLimit: 1000, videoCount: 0 });
  });

  it("a recorder that THROWS never fails the call it records (the port's best-effort contract)", async () => {
    const port = new FakeRecorder();
    port.failNext();
    const cf = new CloudflareIngest({ fetchImpl: recorder(cfReply).fetchImpl, accountId: "acct", token: "tok", recorder: port });
    await expect(cf.createLiveInput({ sessionId: "s1", slot: 0 })).resolves.toMatchObject({ inputId: "in_abc" });
    await new Promise((r) => setImmediate(r));
    expect(port.calls).toHaveLength(0);   // the throw ate it, and nothing else broke
  });
});

// Task 3 review G1. Task 10's DB tests drive the FAKE; if the fake's recorded
// path shapes or subject ids drift from the real adapter's, those tests prove
// the fake and nothing else. Compared through the REAL pathTemplate (the same
// function telemetry.ts uses), per operation, so either side drifting reds.
describe("fake/real provider-call parity (Task 3 review G1, m4)", () => {
  type Shape = { operation: string; method: string; template: string; idCount: number; subject: string };

  function shapes(calls: readonly ProviderCallRecord[], known: { input: string; video: string }): Shape[] {
    return calls.map((c) => ({
      operation: c.operation,
      method: c.method,
      template: pathTemplate(c.url, c.ids),
      idCount: c.ids.length,
      subject: c.subjectId == null ? "none" : c.subjectId === known.input ? "input" : c.subjectId === known.video ? "video" : "other",
    }));
  }

  const TARGET = { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "yt" };
  const BEFORE = new Date("2026-09-10T00:00:00Z");

  it("every ingest operation records the same path template, id count and subject kind on both sides", async () => {
    const realPort = new FakeRecorder();
    const real = new CloudflareIngest({ fetchImpl: recorder(cfReply).fetchImpl, accountId: "acct", token: "tok", recorder: realPort });
    const realCreds = await real.createLiveInput({ sessionId: "s1", slot: 0 });
    await real.inputStatus(realCreds.inputId);
    await real.addOutput(realCreds.inputId, TARGET);
    await real.outputState(realCreds.inputId);
    await real.storageUsage();
    await real.listVideos({ createdBefore: BEFORE });
    await real.deleteVideo("v_done");
    await real.deleteInput(realCreds.inputId);

    const fakePort = new FakeRecorder();
    const fake = new FakeIngest({ recorder: fakePort });
    const fakeCreds = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    fake.addVideo({ videoId: "v_done", inputId: null, createdAt: "2026-09-01T00:00:00Z", inProgress: false });
    await fake.inputStatus(fakeCreds.inputId);
    await fake.addOutput(fakeCreds.inputId, TARGET);
    await fake.outputState(fakeCreds.inputId);
    await fake.storageUsage();
    await fake.listVideos({ createdBefore: BEFORE });
    await fake.deleteVideo("v_done");
    await fake.deleteInput(fakeCreds.inputId);

    await new Promise((r) => setImmediate(r));
    const realShapes = shapes(realPort.calls, { input: realCreds.inputId, video: "v_done" });
    const fakeShapes = shapes(fakePort.calls, { input: fakeCreds.inputId, video: "v_done" });
    // Present twin for the comparison's own vacuity: eight operations, in order,
    // and the templates really are Cloudflare's account-scoped Stream paths.
    expect(realShapes.map((s) => s.operation)).toEqual([
      "createLiveInput", "inputStatus", "addOutput", "outputState", "storageUsage", "listVideos", "deleteVideo", "deleteInput",
    ]);
    expect(realShapes[1]!.template).toBe("/client/v4/accounts/{id}/stream/live_inputs/{id}");
    expect(realShapes[5]!.template).toBe("/client/v4/accounts/{id}/stream");
    expect(realShapes[6]!.template).toBe("/client/v4/accounts/{id}/stream/{id}");
    // m4: the subject id per operation. The adapter is the authority — the
    // object the call is ABOUT — and the fake already agrees on all eight.
    expect(realShapes.map((s) => s.subject)).toEqual(["input", "input", "input", "input", "none", "none", "video", "input"]);
    expect(fakeShapes).toEqual(realShapes);
  });
});

describe("server/relay/** static claims (C4, C8, C11, C12, C13)", () => {
  const RELAY = resolve(import.meta.dirname, "..");
  // RECURSIVE: the ledger rows say `server/relay/**`, and `domain/` is a
  // subdirectory — a flat readdir silently exempted every file in it.
  // PRODUCTION ONLY: `__tests__` names these banned strings by design (this
  // very file does).
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
      return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
    });
  }
  // COMMENTS STRIPPED before matching (C11). Without this the scan reds on the
  // very sentences that document the bans: ingest-cf.ts's header explains why
  // nothing calls /user/tokens/verify, and config.ts's cites EXT-X-ENDLIST.
  // The `[^:]` guard keeps `https://…` inside a string literal intact.
  // Over-stripping is safe here: it can only make a ban harder to satisfy.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const sources = walk(RELAY).map((p) => ({ name: relative(RELAY, p), text: stripComments(readFileSync(p, "utf8")) }));
  const cf = sources.find((s) => s.name === "ingest-cf.ts")!.text;

  it("recording mode is the literal \"automatic\" and no request updates a live input's recording (C4)", () => {
    expect(cf).toMatch(/mode:\s*"automatic"/);                 // present twin
    expect(sources.some((s) => s.name.startsWith("domain/")), "the walk is recursive").toBe(true);
    // No PUT/PATCH to a live input at all — the only mutations are POST create,
    // POST outputs, DELETE. A `recording` key in an update body is the C4 outage.
    // BOTH spellings are banned: the object form, and this adapter's own helper
    // `this.call("PUT", …)` — which is the shape the m-C4 mutant uses, so a
    // regex matching only the first reported that mutant killed while it lived.
    expect(cf).not.toMatch(/method:\s*"(PUT|PATCH)"/);
    expect(cf).not.toMatch(/\.call(?:<[^>]*>)?\(\s*"(PUT|PATCH)"/);
  });
  it("no preferLowLatency, no token verify, no manifest fetch, no ENDLIST anywhere under server/relay (C11, C12, C13, C8)", () => {
    expect(sources.length, "the scan found sources at all").toBeGreaterThan(5);
    for (const s of sources) {
      expect(s.text, s.name).not.toMatch(/preferLowLatency/);
      expect(s.text, s.name).not.toMatch(/\/user\/tokens\/verify/);
      expect(s.text, s.name).not.toMatch(/\.m3u8/);
      expect(s.text, s.name).not.toMatch(/ENDLIST/);
    }
    // Present twin for the grep's own vacuity: the adapter DOES name its base.
    expect(cf).toContain("client/v4/accounts");
  });
});
