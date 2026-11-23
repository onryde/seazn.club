// LIVE, opt-in: the three Cloudflare behaviours the Seazn-hosted POC (2026-11-20, C1–C6) left open, and that Task 13's
// recording lock and Task 12's `setInputEnabled` rest on. Results are recorded in
// docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md.
//
//   1. lock in progress — `POST /stream/{video_uid} {requireSignedURLs:true}` on a recording that is still
//      `live-inprogress`: is it echoed, does the live HLS through a fresh input-uid token keep answering 200, does the
//      unsigned video manifest refuse, and does the flag survive the recording's end?
//   2. PUT keeps it — a `PUT /live_inputs/{uid}` re-sending the create's `recording` with `enabled: false`: is
//      `recording.requireSignedURLs` still `true` in the echo?
//   3. expiry — a token minted with `exp` = now + 60 s: 200 at once, 401/403 at now + 90 s?
//   4. the deletion across the lock (Phase 1 review I3) — the recording's `scheduledDeletion` before the lock; after the
//      lock body Task 13 first sent (`{requireSignedURLs:true}` alone: does the edit keep what the input's
//      `deleteRecordingAfterDays` stamped?); after the body the lock now sends (`scheduledDeletion` = creation + the input's
//      retention + the longest run and finalisation, seazn-recordings.ts `seaznRecordingDeleteAt`: does Cloudflare accept it
//      on a live-inprogress recording, or 400?); and after the recording ends. Each read is the echo and a GET re-read.
//      Printed: the video uid, the scheduledDeletion values, the edit's HTTP status and Cloudflare's error CODES — never a
//      token, a URL or an error message.
//   5. analytics keys (Task 30) — a live HLS view of the programme input, made as Seazn's player makes it (the INPUT uid's
//      token, C1): its minutes land in Cloudflare's GraphQL Analytics under the input uid, under the live video uid, or both?
//      During the expiry's wait (item 3) the probe plays the live rendition's playlist and every segment it lists, once each, ~90 s
//      (counts only are kept); after the PUT it reads the minutes for both uids through the production reader
//      (video/cf-analytics.ts `liveMinutesViewed`) every 30 s for the full 10 min — stopping early only once BOTH uids show
//      minutes that held still across two polls (Task 30 review I1: a key whose rows arrive later must not read as absent).
//      After the cleanup's deletes it reads the same two uids once more (review I2: does a deleted uid still answer? Task 31's
//      daily read normally comes after the delete). Printed: OBSERVED.liveView (segments, bytes, seconds, timedOut) and OBSERVED.analytics
//      ({inputUid, videoUid, byUid, keyedBy, polls, series, firstNonZeroPoll, stoppedBecause, afterDelete}) — uids and numbers
//      only. `keyedBy` answers ONE question: is one live view reported under both keys (a double count)? Task 31 queries both
//      uids whatever it says, because the interim replay plays by video uid (cf-playback.ts); the report's decision table maps
//      the answer to Task 31's rule. `afterDelete` is recorded, never asserted.
//
// Gate (the `_live-fly-gate.ts` order): the flag CF_LIVE_PROBE=1 first, and only behind it the account pair
// CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_STREAM_TOKEN (environment, then apps/web/.env.local). Without the flag nothing
// else is read and the file skips loudly. CI never sets the flag. Step 5 queries Analytics with the SAME Stream token (owner
// ruling 2026-11-23: no separate analytics token), which must carry Account Analytics: Read beside its Stream permission: without
// that grant Cloudflare refuses the query, OBSERVED.analytics.lastError carries its reason, and step 5's one assertion fails.
//
// SAFETY (owner, 2026-11-20 — 25 recordings were lost to a list filter Cloudflare ignored, C6):
//   * Deletes are by uid ONLY, and only of the one input and the one video this run created. The input uid comes from
//     the create response. The video uid comes from the input's OWN path-scoped videos read
//     (`/live_inputs/{uid}/videos`, no query filter), and every item there is checked: its `liveInput` must equal the
//     input this run created, else it is skipped and counted. `GET /stream?…` is never called.
//   * Before each delete Cloudflare is re-read by path: the video must name this run's input as its `liveInput`, the
//     input must carry this run's uid and meta name. A mismatch skips the delete and reports it. If the run failed
//     before the video uid was captured, the input's own videos are read once; exactly one own item is deleted (same
//     re-check), anything else is left and reported with its uids.
//   * Cleanup lives in `afterAll`, so it runs when an assertion fails.
//   * No update other than the probe's one PUT is sent, and only to this run's throwaway input (ingest-cf.ts:10-15).
//     The two lock edits (step 4) go only to this run's own recording, which the cleanup deletes.
//   * Secrets (API token, stream key, playback tokens) are never logged or asserted on; a token is shown, if ever, as
//     its first 6 characters. The stream key reaches ffmpeg as argv only.
//   * Step 5 changes nothing on Cloudflare: the viewer GETs this run's own live HLS, and the analytics read is one GraphQL query
//     (a POST that only reads) for this run's two uids. The token rides in a header only (cf-analytics.ts). The post-delete
//     re-read in `afterAll` is the same read-only query for the same two uids, made after the deletes and never before them.
//
// Run: cd apps/web && DATABASE_URL= CF_LIVE_PROBE=1 npx vitest run src/server/relay/__tests__/cf-signed-live.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLOUDFLARE_STREAM_BASE } from "../ingest-cf";
import { DELETE_RECORDING_AFTER_DAYS, FINALISATION_GRACE_SECONDS, MAX_DURATION_MINUTES } from "../config";
import { liveMinutesViewed } from "../../video/cf-analytics";

type CfLiveGate = { enabled: true; accountId: string; token: string } | { enabled: false; reason: string };

/** Flag first; the credentials are read only behind it. */
function cfLiveGate(env: Record<string, string | undefined>, readLocal: (key: string) => string | undefined): CfLiveGate {
  if (env.CF_LIVE_PROBE !== "1") return { enabled: false, reason: "CF_LIVE_PROBE=1 is not set" };
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || readLocal("CLOUDFLARE_ACCOUNT_ID");
  const token = env.CLOUDFLARE_STREAM_TOKEN?.trim() || readLocal("CLOUDFLARE_STREAM_TOKEN");
  if (!accountId || !token) return { enabled: false, reason: "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_STREAM_TOKEN are in neither the environment nor apps/web/.env.local" };
  return { enabled: true, accountId, token };
}

function readEnvLocal(key: string): string | undefined {
  try {
    const line = readFileSync(resolve(import.meta.dirname, "../../../../.env.local"), "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

const GATE = cfLiveGate(process.env, readEnvLocal);
if (!GATE.enabled) console.log(`SKIP  cf-signed-live probe — ${GATE.reason} (needs CF_LIVE_PROBE=1 and the Cloudflare account pair)`);

/** The create's recording settings, verbatim from the Task 7 brief. The PUT re-sends exactly these. */
const RECORDING = { mode: "automatic", requireSignedURLs: true, allowedOrigins: ["seazn.club"], timeoutSeconds: 180 } as const;
const PROBE_NAME = "seazn-task7-probe";   // the input's meta name; the cleanup re-check requires it
const FEED_MAX_SECONDS = 300;   // ffmpeg's own cap; the run stops it earlier, after the expiry probe
/** Step 5: how long the analytics read waits for a view's minutes to show (Cloudflare states no delay for this dataset), and how
 *  often it asks. */
const ANALYTICS_WAIT_MS = 10 * 60_000;
const ANALYTICS_POLL_MS = 30_000;
/** Step 5 (review m6): the longest one live-view GET — a playlist or a segment, headers and body — may take. A segment is a few
 *  seconds of video at the lowest rendition, so 10 s is generous; the GET is also never allowed past the view's end. */
const LIVE_VIEW_GET_TIMEOUT_MS = 10_000;

/** The test feed, everything but the output. History (2026-11-21, owner runs):
 *  - Runs 1–2 sent `testsrc -tune zerolatency -g 60 -b:v 2500k`: measured locally at ~1.1 Mbps, under Stream Live's
 *    2–14 Mbps input floor, with keyframes on the 2 s edge
 *    (developers.cloudflare.com/stream/stream-live/start-stream-live/#requirements). Cloudflare served 204, then closed.
 *  - Run 3 sent testsrc2 at CBR 3 Mbps, 4 s GOP, `-preset veryfast`, on a loaded x86 Mac: ffmpeg stalled ~31 s at the
 *    start ("Resumed reading … after a lag of 30.944s"), the input went connected → disconnected, ffmpeg exited at 33 s.
 *  So the feed is now as cheap as libx264 allows: SMPTE bars (no per-frame drawing), `ultrafast` + `zerolatency`,
 *  still 1280x720@30, still true CBR 3 Mbps (`nal-hrd=cbr` pads a static picture up to the rate) and a fixed closed
 *  4 s GOP. Measured locally with no network: 13.6x real time, 3,112 kbps, keyframes every 4.0 s. */
function feedArgs(seconds: number): string[] {
  return [
    "-f", "lavfi", "-i", "smptebars=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(seconds),
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
    "-b:v", "3000k", "-minrate", "3000k", "-maxrate", "3000k", "-bufsize", "6000k", "-x264-params", "nal-hrd=cbr",
    "-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "128k",
  ];
}

const PREFLIGHT_SECONDS = 10;
const PREFLIGHT_MIN_SPEED = 1.5;

/** Encode PREFLIGHT_SECONDS of the feed locally, as fast as it goes, to nowhere (no network, no Cloudflare). A machine
 *  that cannot do it at PREFLIGHT_MIN_SPEED x real time would stall a live push (run 3), so the probe refuses to spend a
 *  Cloudflare input on it. */
function preflightSpeed(): Promise<number> {
  return new Promise((resolveSpeed, reject) => {
    const started = Date.now();
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...feedArgs(PREFLIGHT_SECONDS), "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr!.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-500); });   // no secret: the output is null
    p.on("error", (e: NodeJS.ErrnoException) => reject(new Error(e.code === "ENOENT" ? "ffmpeg is not installed (ENOENT)" : `ffmpeg failed to start: ${e.code ?? e.message}`)));
    p.on("exit", (code) => code === 0
      ? resolveSpeed(PREFLIGHT_SECONDS / ((Date.now() - started) / 1000))
      : reject(new Error(`preflight encode exited ${code}: ${err}`)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (s: string) => console.log("LIVE  " + s);

describe.skipIf(!GATE.enabled)("Cloudflare Stream — signed recording lock, PUT, token expiry (live)", () => {
  const accountId = GATE.enabled ? GATE.accountId : "";
  const token = GATE.enabled ? GATE.token : "";
  const base = `${CLOUDFLARE_STREAM_BASE}/${accountId}/stream`;

  // The only two uids this run may ever delete, each captured once.
  let inputUid: string | null = null;
  let videoUid: string | null = null;
  let ffmpeg: ChildProcess | null = null;
  const ledger = { created: [] as string[], deleted: [] as string[], skipped: [] as string[], foreignItemsSkipped: 0 };
  let runStartedAt: Date | null = null;   // step 5's analytics window opens here; the post-delete re-read (afterAll) reuses it
  const obs: Record<string, unknown> = {};

  async function cf<T>(method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; result: T | undefined; errors: unknown }> {
    if (path.includes("?")) throw new Error("refused: a query-filtered list call (C6)");
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: unknown };
    return { status: res.status, ok: res.ok && json.success !== false, result: json.result, errors: json.errors };
  }

  /** `POST /stream/{uid}/token`, Cloudflare's own endpoint (C1). The token is returned, never printed. */
  async function mint(uid: string, exp?: number): Promise<string> {
    const r = await cf<{ token: string }>("POST", `/${uid}/token`, exp === undefined ? {} : { exp });
    if (!r.ok || !r.result?.token) throw new Error(`token mint for ${uid} answered ${r.status} ${JSON.stringify(r.errors)}`);
    return r.result.token;
  }

  const httpStatus = async (url: string) => (await fetch(url, { redirect: "manual" })).status;

  /** Step 5's viewer, as Seazn's player views a live match: a fresh token for the INPUT uid (C1), the master playlist, its
   *  lowest-bandwidth rendition, and every segment that rendition lists, each fetched once, until `untilMs`. Only counts are
   *  kept — no URL, no token, no body — and a failure is recorded by the step it hit and the error's NAME, never its text (a
   *  fetch error can quote the URL, and the URL is the token). It never throws: the expiry probe shares this wait.
   *  Review m6 (2026-11-23): every playlist and segment GET — headers and body alike — gives up after LIVE_VIEW_GET_TIMEOUT_MS,
   *  and never past `untilMs` (with a 1 s floor), so one hung GET cannot push the expiry reads that follow past the feed. A GET
   *  that times out is COUNTED (`timedOut`), not a failure: a playlist is asked again on the next turn, a segment is left. */
  async function watchLive(liveHost: string, untilMs: number): Promise<{
    segments: number; bytes: number; seconds: number; stoppedAt: string | null; timedOut: { playlist: number; segment: number };
  }> {
    const startedAt = Date.now();
    const fetched = new Set<string>();
    const timedOut = { playlist: 0, segment: 0 };
    let bytes = 0;
    let step = "mint";
    const TIMED_OUT = Symbol("timed out");
    /** One bounded GET and its body read: the read's value, or TIMED_OUT when the bound ran out first. Anything else throws. */
    async function boundedGet<T>(url: string, read: (res: Response) => Promise<T>): Promise<T | typeof TIMED_OUT> {
      const signal = AbortSignal.timeout(Math.max(1_000, Math.min(LIVE_VIEW_GET_TIMEOUT_MS, untilMs - Date.now())));
      try {
        return await read(await fetch(url, { signal }));
      } catch (e) {
        if (signal.aborted) return TIMED_OUT;
        throw e;
      }
    }
    const result = (stoppedAt: string | null) => ({ segments: fetched.size, bytes, seconds: Math.round((Date.now() - startedAt) / 1000), stoppedAt, timedOut });
    try {
      const master = `${liveHost}/${await mint(inputUid!)}/manifest/video.m3u8`;
      step = "master playlist";
      let masterText: string | null = null;
      while (masterText === null && Date.now() < untilMs) {
        const got = await boundedGet(master, (res) => res.text());
        if (got === TIMED_OUT) timedOut.playlist++;
        else masterText = got;
      }
      if (masterText === null) return result(null);   // the whole window went on timed-out GETs: counted, not a failure
      const lines = masterText.split("\n").map((l) => l.trim());
      let pick: { bandwidth: number; uri: string } | null = null;
      for (let i = 0; i < lines.length - 1; i++) {
        const m = /^#EXT-X-STREAM-INF:.*\bBANDWIDTH=(\d+)/.exec(lines[i]);
        const uri = lines[i + 1];
        if (m && uri && !uri.startsWith("#") && (!pick || Number(m[1]) < pick.bandwidth)) pick = { bandwidth: Number(m[1]), uri };
      }
      if (!pick) throw new Error("no rendition");
      const rendition = new URL(pick.uri, master).toString();
      while (Date.now() < untilMs) {
        step = "rendition playlist";
        const playlist = await boundedGet(rendition, async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        });
        if (playlist === TIMED_OUT) timedOut.playlist++;
        else {
          for (const line of playlist.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
            const segment = new URL(line, rendition).toString();
            if (fetched.has(segment) || Date.now() >= untilMs) continue;
            fetched.add(segment);
            step = "segment";
            const got = await boundedGet(segment, async (res) => (await res.arrayBuffer()).byteLength);
            if (got === TIMED_OUT) timedOut.segment++;
            else bytes += got;
          }
        }
        await sleep(Math.min(4_000, Math.max(0, untilMs - Date.now())));
      }
      return result(null);
    } catch (e) {
      const why = e instanceof Error && /^(no rendition|HTTP \d+)$/.test(e.message) ? e.message : (e as { name?: string })?.name ?? "error";
      return result(`${step}: ${why}`);
    }
  }

  type Video = {
    uid: string; liveInput?: string | null; requireSignedURLs?: boolean; created?: string; scheduledDeletion?: string | null;
    status?: { state?: string; errorReasonCode?: string; errorReasonText?: string }; playback?: { hls?: string };
  };
  /** Cloudflare's error codes only: a message is free text, and nothing but ids and the deletion values is printed (step 4). */
  const codesOf = (errors: unknown): unknown[] => (Array.isArray(errors) ? errors.map((e) => (e as { code?: unknown })?.code ?? null) : []);
  /** Step 4's record: the video uid and the scheduledDeletion values (with each edit's status and error codes), nothing else. */
  const deletion: Record<string, unknown> = {};
  obs.scheduledDeletion = deletion;

  /** The input's OWN videos, each checked against the input (C6): a foreign item is skipped and counted. */
  async function ownVideos(): Promise<Video[]> {
    const r = await cf<Video[]>("GET", `/live_inputs/${inputUid}/videos`);
    if (!r.ok) throw new Error(`input videos read answered ${r.status}`);
    const all = r.result ?? [];
    const mine = all.filter((v) => v.liveInput === inputUid);
    ledger.foreignItemsSkipped += all.length - mine.length;
    return mine;
  }

  async function readVideo(): Promise<Video> {
    const r = await cf<Video>("GET", `/${videoUid}`);
    if (!r.ok || !r.result) throw new Error(`video read answered ${r.status}`);
    return r.result;
  }

  function stopFeed() {
    if (ffmpeg && ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill("SIGINT");
  }

  afterAll(async () => {
    stopFeed();
    await sleep(2_000);
    if (ffmpeg && ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill("SIGKILL");

    // The video first: a deleted input leaks its recording. If the run failed after the feed started but before the
    // video uid was captured, look once at the input's OWN videos (path-scoped, each item checked) so a live, unsigned
    // recording is not leaked; act only on exactly one own item, else hand the uids to a human.
    if (!videoUid && inputUid) {
      try {
        const mine = await ownVideos();
        if (mine.length === 1) videoUid = mine[0].uid;
        else if (mine.length > 1) ledger.skipped.push(`leak sweep: ${mine.length} own videos of input ${inputUid} (${mine.map((v) => v.uid).join(", ")}); none deleted`);
      } catch (e) {
        ledger.skipped.push(`leak sweep: input ${inputUid} videos read failed (${(e as Error).message})`);
      }
    }
    if (videoUid) {
      const deadline = Date.now() + 6 * 60_000;
      for (;;) {
        // Re-check against Cloudflare, by path: the video must belong to the input this run created.
        const check: { status: number; ok: boolean; result: Video | undefined } = await cf<Video>("GET", `/${videoUid}`);
        if (check.status === 404) { ledger.deleted.push(`video ${videoUid} (already gone, 404)`); break; }
        if (!check.ok || !inputUid || check.result?.uid !== videoUid || check.result?.liveInput !== inputUid) {
          ledger.skipped.push(`video ${videoUid} re-check failed (status ${check.status}, liveInput ${check.result?.liveInput ?? "absent"}, expected ${inputUid}); not deleted`);
          break;
        }
        const r = await cf("DELETE", `/${videoUid}`);
        if (r.ok || r.status === 404) { ledger.deleted.push(`video ${videoUid} (${r.status})`); break; }
        if (Date.now() > deadline) { ledger.skipped.push(`video ${videoUid} delete still ${r.status} at deadline`); break; }
        await sleep(15_000);
      }
    }
    if (inputUid) {
      // Re-check against Cloudflare, by path: same uid and this probe's own meta name.
      const check = await cf<{ uid?: string; meta?: { name?: string } }>("GET", `/live_inputs/${inputUid}`);
      if (check.status === 404) ledger.deleted.push(`input ${inputUid} (already gone, 404)`);
      else if (!check.ok || check.result?.uid !== inputUid || check.result?.meta?.name !== PROBE_NAME) {
        ledger.skipped.push(`input ${inputUid} re-check failed (status ${check.status}, name ${check.result?.meta?.name ?? "absent"}); not deleted`);
      } else {
        const r = await cf("DELETE", `/live_inputs/${inputUid}`);
        if (r.ok || r.status === 404) ledger.deleted.push(`input ${inputUid} (${r.status})`);
        else ledger.skipped.push(`input ${inputUid} delete answered ${r.status}`);
      }
    }
    // Review I2: one more read of the step-8 uids, AFTER the deletes above — does Cloudflare still answer a deleted uid's minutes
    // (it keeps the data 92 days)? Recorded, never asserted: Task 31 reads only after its own deletes, so a 0 here is a finding.
    // Read-only, this run's two uids, and only when step 8 ran (its byUid is what this is compared with).
    const analytics = obs.analytics as Record<string, unknown> | undefined;
    if (analytics && inputUid && videoUid && runStartedAt) {
      try {
        const after = await liveMinutesViewed([inputUid, videoUid], runStartedAt, new Date(), { config: { accountId, token } });
        analytics.afterDelete = { input: after[inputUid] ?? null, video: after[videoUid] ?? null, deleted: [...ledger.deleted] };
      } catch (e) {
        analytics.afterDelete = { error: (e as Error).message };
      }
    }
    note(`OBSERVED ${JSON.stringify(obs)}`);
    note(`LEDGER ${JSON.stringify(ledger)}`);
    expect(ledger.skipped).toEqual([]);
  }, 8 * 60_000);

  it("observes the lock in progress, the expiry, the lock after the end, the PUT, and which uid a live view's minutes land under", async () => {
    const windowStart = new Date();
    runStartedAt = windowStart;
    // 0. Preflight, before anything is created on Cloudflare: can this machine encode the feed in real time?
    const speed = await preflightSpeed();
    obs.preflightSpeed = Math.round(speed * 10) / 10;
    if (speed < PREFLIGHT_MIN_SPEED) {
      throw new Error(`preflight: ffmpeg encodes the feed at ${speed.toFixed(2)}x real time (< ${PREFLIGHT_MIN_SPEED}x) on this machine; a live push would stall. Nothing was created on Cloudflare. Retry when the machine is less loaded.`);
    }

    // 1. Create the throwaway input. deleteRecordingAfterDays (30, the floor) is a leak backstop only.
    const created = await cf<{ uid: string; rtmps: { url: string; streamKey: string }; recording?: Record<string, unknown> }>(
      "POST", "/live_inputs", { meta: { name: PROBE_NAME }, recording: RECORDING, deleteRecordingAfterDays: 30 });
    expect(created.ok, `create answered ${created.status}`).toBe(true);
    const uid = created.result?.uid;
    if (typeof uid !== "string" || uid.length === 0) throw new Error("create answered no input uid");
    inputUid = uid;
    ledger.created.push(`input ${inputUid}`);
    note(`created input ${inputUid}`);
    obs.createEcho = created.result!.recording;

    // 2. Publish the test feed. The stream key is argv to ffmpeg only.
    const target = `${created.result!.rtmps.url}${created.result!.rtmps.streamKey}`;
    ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-re", ...feedArgs(FEED_MAX_SECONDS), "-f", "flv", "-flvflags", "no_duration_filesize", target],
      { stdio: ["ignore", "ignore", "pipe"] });
    const ffStartedAt = Date.now();
    let ffExitAfterMs: number | null = null;
    ffmpeg.on("exit", () => { ffExitAfterMs = Date.now() - ffStartedAt; });
    // stderr is kept RAW in memory (bounded at 1 MiB; ffmpeg at `warning` writes a few KiB) and read only through
    // ffTail(), which redacts the full target URL and the key over the WHOLE text before it slices. Redacting per chunk
    // would miss a key split across two chunks, and slicing first could cut a key into an unredacted fragment.
    const streamKey = created.result!.rtmps.streamKey;
    let ffRaw = "";
    const ffTail = (n = 500) => ffRaw.replaceAll(target, "<rtmps-url>").replaceAll(streamKey, "<key>").slice(-n);
    let ffSpawnError: string | null = null;
    ffmpeg.stderr!.on("data", (d: Buffer) => { if (ffRaw.length < 1 << 20) ffRaw += d.toString(); });
    ffmpeg.on("error", (e: NodeJS.ErrnoException) => { ffSpawnError = e.code === "ENOENT" ? "ffmpeg is not installed (ENOENT)" : `ffmpeg failed to start: ${e.code ?? e.message}`; });
    note(`ffmpeg pid ${ffmpeg.pid}`);

    // 3. Capture the in-progress recording's uid from the input's own videos, each item checked (C6).
    let deadline = Date.now() + 120_000;
    while (!videoUid) {
      if (ffSpawnError) throw new Error(ffSpawnError);
      if (ffmpeg.exitCode !== null) throw new Error(`ffmpeg exited ${ffmpeg.exitCode}: ${ffTail()}`);
      const mine = (await ownVideos()).filter((v) => v.status?.state === "live-inprogress");
      if (mine.length > 1) throw new Error(`expected one in-progress recording, saw ${mine.length}`);
      if (mine.length === 1) videoUid = mine[0].uid;
      else if (Date.now() > deadline) throw new Error("no in-progress recording appeared within 120 s");
      else await sleep(5_000);
    }
    ledger.created.push(`video ${videoUid}`);
    note(`captured video ${videoUid}`);
    const before = await readVideo();
    obs.videoBeforeLock = { state: before.status?.state, requireSignedURLs: before.requireSignedURLs };
    deletion.videoUid = videoUid;
    deletion.created = before.created ?? null;
    deletion.beforeLock = before.scheduledDeletion ?? null;   // did the input's deleteRecordingAfterDays stamp one at all?
    const host = new URL(before.playback!.hls!).origin;

    // Live HLS through a fresh input-uid token must answer 200 before the lock (C1), or the after-lock read means nothing.
    // Run 1 (2026-11-21) answered 204 for 90 s while the recording sat in live-inprogress and later ended in `error`:
    // the token was accepted (an expired one answered 401 at the same URL) but there was nothing to serve. So the
    // baseline now waits up to 180 s, and if it never reaches 200 the run stops HERE with the feed's diagnostics
    // instead of locking a recording whose live side was never playable.
    deadline = Date.now() + 180_000;
    let liveBefore = 0;
    const baselineSeen: number[] = [];
    const inputStatesSeen: string[] = [];
    for (;;) {
      liveBefore = await httpStatus(`${host}/${await mint(inputUid)}/manifest/video.m3u8`);
      baselineSeen.push(liveBefore);
      const st = await cf<{ status?: { current?: { state?: string } } }>("GET", `/live_inputs/${inputUid}`);
      inputStatesSeen.push(st.result?.status?.current?.state ?? "absent");
      if (liveBefore === 200 || Date.now() > deadline) break;
      await sleep(5_000);
    }
    obs.liveHlsBeforeLock = liveBefore;
    obs.liveHlsBaselineSeen = [...new Set(baselineSeen)];
    if (liveBefore !== 200) {
      const v = await readVideo();
      const inp = await cf<{ status?: { current?: { state?: string; reason?: string } } }>("GET", `/live_inputs/${inputUid}`);
      obs.baselineDiagnostics = {
        videoState: v.status?.state, errorReasonCode: v.status?.errorReasonCode, errorReasonText: v.status?.errorReasonText,
        inputState: inp.result?.status?.current?.state, inputReason: inp.result?.status?.current?.reason,
        inputStatesSeen: [...new Set(inputStatesSeen)],
        ffmpegExit: ffmpeg.exitCode, ffmpegSignal: ffmpeg.signalCode, ffmpegExitAfterMs: ffExitAfterMs, ffmpegStderrTail: ffTail(),
      };
      throw new Error(`live HLS never answered 200 within 180 s (saw ${JSON.stringify(obs.liveHlsBaselineSeen)}); lock not attempted — see OBSERVED.baselineDiagnostics`);
    }

    // 4. Lock the in-progress recording.
    const lock = await cf<Video>("POST", `/${videoUid}`, { requireSignedURLs: true });
    obs.lockEcho = { status: lock.status, requireSignedURLs: lock.result?.requireSignedURLs, state: lock.result?.status?.state };
    // 4a. The deletion after the lock-only edit: its echo, and a re-read.
    deletion.lockOnly = { status: lock.status, echo: lock.result?.scheduledDeletion ?? null, reread: (await readVideo()).scheduledDeletion ?? null };
    // 4b. The edit the lock now sends: the same, with the recording's own deletion (seaznRecordingDeleteAt's formula over this
    // recording's `created`, from now when Cloudflare gives none). A 400 here is the risk review I3 names.
    const createdMs = Date.parse(before.created ?? "");
    const deleteAt = new Date((Number.isFinite(createdMs) ? createdMs : Date.now())
      + DELETE_RECORDING_AFTER_DAYS * 86_400_000 + MAX_DURATION_MINUTES * 60_000 + FINALISATION_GRACE_SECONDS * 1000).toISOString();
    const lockWithDeletion = await cf<Video>("POST", `/${videoUid}`, { requireSignedURLs: true, scheduledDeletion: deleteAt });
    deletion.sent = deleteAt;
    deletion.lockWithDeletion = {
      status: lockWithDeletion.status, errorCodes: codesOf(lockWithDeletion.errors),
      echo: lockWithDeletion.result?.scheduledDeletion ?? null, reread: (await readVideo()).scheduledDeletion ?? null,
    };
    await sleep(5_000);
    obs.liveHlsAfterLock = await httpStatus(`${host}/${await mint(inputUid)}/manifest/video.m3u8`);
    obs.unsignedVideoManifestAfterLock = await httpStatus(`${host}/${videoUid}/manifest/video.m3u8`);
    obs.videoAfterLockInProgress = await readVideo().then((v) => ({ state: v.status?.state, requireSignedURLs: v.requireSignedURLs }));

    // 5. Expiry: exp = now + 60 s; 200 at once, 401/403 at now + 90 s. The feed is still live throughout.
    const exp = Math.floor(Date.now() / 1000) + 60;
    const short = await mint(inputUid, exp);
    const shortUrl = `${host}/${short}/manifest/video.m3u8`;
    obs.expiryAtOnce = await httpStatus(shortUrl);
    // Header item 5 (Task 30): the wait is spent VIEWING the live HLS as Seazn's player does, on a token of its own (the short one
    // is left alone), so step 8 has minutes to look for. A viewer that stops early leaves the rest of the wait a plain sleep.
    obs.liveView = await watchLive(host, (exp + 30) * 1000);
    await sleep(Math.max(0, (exp + 30) * 1000 - Date.now()));
    obs.expiryAtPlus90 = await httpStatus(shortUrl);
    obs.liveHlsFreshTokenAtPlus90 = await httpStatus(`${host}/${await mint(inputUid)}/manifest/video.m3u8`);   // control: still live
    obs.feedStillRunningAtPlus90 = ffmpeg.exitCode === null;
    if (ffmpeg.exitCode !== null) obs.ffmpegEarlyExit = { code: ffmpeg.exitCode, stderrTail: ffTail() };

    // 6. Stop the feed; wait for the recording to finish (timeoutSeconds 180 after the disconnect), then re-read the lock.
    stopFeed();
    deadline = Date.now() + 8 * 60_000;
    let after = await readVideo();
    while (after.status?.state === "live-inprogress" || after.status?.state === "inprogress" || after.status?.state === "queued" || after.status?.state === "downloading") {
      if (Date.now() > deadline) break;
      await sleep(15_000);
      after = await readVideo();
    }
    obs.videoAfterEnd = { state: after.status?.state, requireSignedURLs: after.requireSignedURLs, errorReasonCode: after.status?.errorReasonCode, errorReasonText: after.status?.errorReasonText };
    deletion.afterEnd = after.scheduledDeletion ?? null;

    // 7. PUT re-sending the create's recording with enabled:false — only on this run's input, now off air.
    const put = await cf<{ recording?: { requireSignedURLs?: boolean; allowedOrigins?: string[]; mode?: string; timeoutSeconds?: number }; enabled?: boolean }>(
      "PUT", `/live_inputs/${inputUid}`, { recording: RECORDING, enabled: false });
    obs.putEcho = { status: put.status, enabled: put.result?.enabled, recording: put.result?.recording };
    const reread = await cf<{ recording?: { requireSignedURLs?: boolean }; enabled?: boolean }>("GET", `/live_inputs/${inputUid}`);
    obs.inputAfterPut = { enabled: reread.result?.enabled, requireSignedURLs: reread.result?.recording?.requireSignedURLs };

    // 8. Header item 5 (Task 30): is the step-5 view's minutes reported under the input uid, the live video uid, or BOTH? The
    // production reader, for this run's two uids only, every ANALYTICS_POLL_MS for the whole ANALYTICS_WAIT_MS (review I1): the
    // first key to show is not the answer, because the other key's rows may land later and a hidden `both` is a double count.
    // The one early stop: both keys non-zero and unchanged across two consecutive polls. Every poll's pair is kept (`series`),
    // with the poll each key first showed minutes. Errors are the reader's own redacted wording. The account and token are the
    // run's own Stream pair (owner ruling 2026-11-23): a token without Analytics read shows in lastError.
    const analytics: Record<string, unknown> = { inputUid, videoUid };
    obs.analytics = analytics;
    {
      const config = { accountId, token };
      const pollStart = Date.now();
      const waitUntil = pollStart + ANALYTICS_WAIT_MS;
      let byUid: Record<string, number> = {};
      let polls = 0;
      const series: { poll: number; atSeconds: number; input: number | null; video: number | null }[] = [];
      const firstNonZeroPoll: { input: number | null; video: number | null } = { input: null, video: null };
      let stoppedBecause = "window ended";
      for (;;) {
        polls++;
        try {
          byUid = await liveMinutesViewed([inputUid, videoUid], windowStart, new Date(), { config });
          analytics.lastError = null;
          const point = { poll: polls, atSeconds: Math.round((Date.now() - pollStart) / 1000), input: byUid[inputUid] ?? null, video: byUid[videoUid] ?? null };
          const prev = series.at(-1);
          series.push(point);
          if (firstNonZeroPoll.input === null && (point.input ?? 0) > 0) firstNonZeroPoll.input = polls;
          if (firstNonZeroPoll.video === null && (point.video ?? 0) > 0) firstNonZeroPoll.video = polls;
          if (prev && (point.input ?? 0) > 0 && (point.video ?? 0) > 0 && prev.input === point.input && prev.video === point.video) {
            stoppedBecause = "both keys non-zero and stable across two polls";
            break;
          }
        } catch (e) {
          analytics.lastError = (e as Error).message;
        }
        if (Date.now() > waitUntil) break;
        await sleep(ANALYTICS_POLL_MS);
      }
      const onInput = (byUid[inputUid] ?? 0) > 0;
      const onVideo = (byUid[videoUid] ?? 0) > 0;
      Object.assign(analytics, {
        byUid: { input: byUid[inputUid] ?? null, video: byUid[videoUid] ?? null }, polls, series, firstNonZeroPoll, stoppedBecause,
        waitedSeconds: Math.round((Date.now() - pollStart) / 1000),
        keyedBy: onInput && onVideo ? "both" : onInput ? "input" : onVideo ? "video" : "neither",
      });
    }

    // Facts, each asserted softly so one red does not hide the others.
    expect.soft(obs.liveHlsBeforeLock, "live HLS 200 before the lock (C1 baseline)").toBe(200);
    expect.soft(lock.result?.requireSignedURLs, "lock echo").toBe(true);
    expect.soft(obs.liveHlsAfterLock, "live HLS still 200 after the lock").toBe(200);
    expect.soft([401, 403], "unsigned video manifest refused").toContain(obs.unsignedVideoManifestAfterLock);
    expect.soft(after.requireSignedURLs, "lock survives the recording's end").toBe(true);
    expect.soft(put.result?.recording?.requireSignedURLs, "PUT keeps requireSignedURLs").toBe(true);
    // Step 4 (review I3): the lock's deletion is accepted on an in-progress recording, kept in the echo and the re-read, and still
    // there after the end. Instants are compared as instants (Cloudflare may write the same one differently).
    const same = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
    const wd = deletion.lockWithDeletion as { status: number; echo: unknown; reread: unknown };
    expect.soft(wd.status, "the lock with scheduledDeletion answers 200 on an in-progress recording").toBe(200);
    expect.soft(same(wd.echo), "its echo carries the deletion sent").toBe(Date.parse(deleteAt));
    expect.soft(same(wd.reread), "a re-read carries it").toBe(Date.parse(deleteAt));
    expect.soft(same(deletion.afterEnd), "it survives the recording's end").toBe(Date.parse(deleteAt));
    expect.soft(obs.expiryAtOnce, "short token at once").toBe(200);
    expect.soft([401, 403], "short token at now+90 s").toContain(obs.expiryAtPlus90);
    // Header item 5 (Task 30): the live view's minutes show under the input uid, the live video uid, or both — OBSERVED.analytics.keyedBy
    // says which, read after the full window. "neither" answers nothing: read OBSERVED.analytics.lastError (a refused query) and
    // OBSERVED.liveView (no view) first.
    expect.soft(analytics.keyedBy, "Task 30: a live HLS view's minutes land under the input uid, the live video uid, or both").toMatch(/^(input|video|both)$/);
  }, 32 * 60_000);
});
