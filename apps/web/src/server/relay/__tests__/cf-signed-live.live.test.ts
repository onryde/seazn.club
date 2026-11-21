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
//
// Gate (the `_live-fly-gate.ts` order): the flag CF_LIVE_PROBE=1 first, and only behind it the account pair
// CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_STREAM_TOKEN (environment, then apps/web/.env.local). Without the flag nothing
// else is read and the file skips loudly. CI never sets the flag.
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
//   * Secrets (API token, stream key, playback tokens) are never logged or asserted on; a token is shown, if ever, as
//     its first 6 characters. The stream key reaches ffmpeg as argv only.
//
// Run: cd apps/web && DATABASE_URL= CF_LIVE_PROBE=1 npx vitest run src/server/relay/__tests__/cf-signed-live.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLOUDFLARE_STREAM_BASE } from "../ingest-cf";

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

  type Video = { uid: string; liveInput?: string | null; requireSignedURLs?: boolean; status?: { state?: string; errorReasonCode?: string; errorReasonText?: string }; playback?: { hls?: string } };

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
    note(`OBSERVED ${JSON.stringify(obs)}`);
    note(`LEDGER ${JSON.stringify(ledger)}`);
    expect(ledger.skipped).toEqual([]);
  }, 8 * 60_000);

  it("observes the lock in progress, the expiry, the lock after the end, and the PUT", async () => {
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
    await sleep(5_000);
    obs.liveHlsAfterLock = await httpStatus(`${host}/${await mint(inputUid)}/manifest/video.m3u8`);
    obs.unsignedVideoManifestAfterLock = await httpStatus(`${host}/${videoUid}/manifest/video.m3u8`);
    obs.videoAfterLockInProgress = await readVideo().then((v) => ({ state: v.status?.state, requireSignedURLs: v.requireSignedURLs }));

    // 5. Expiry: exp = now + 60 s; 200 at once, 401/403 at now + 90 s. The feed is still live throughout.
    const exp = Math.floor(Date.now() / 1000) + 60;
    const short = await mint(inputUid, exp);
    const shortUrl = `${host}/${short}/manifest/video.m3u8`;
    obs.expiryAtOnce = await httpStatus(shortUrl);
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

    // 7. PUT re-sending the create's recording with enabled:false — only on this run's input, now off air.
    const put = await cf<{ recording?: { requireSignedURLs?: boolean; allowedOrigins?: string[]; mode?: string; timeoutSeconds?: number }; enabled?: boolean }>(
      "PUT", `/live_inputs/${inputUid}`, { recording: RECORDING, enabled: false });
    obs.putEcho = { status: put.status, enabled: put.result?.enabled, recording: put.result?.recording };
    const reread = await cf<{ recording?: { requireSignedURLs?: boolean }; enabled?: boolean }>("GET", `/live_inputs/${inputUid}`);
    obs.inputAfterPut = { enabled: reread.result?.enabled, requireSignedURLs: reread.result?.recording?.requireSignedURLs };

    // Facts, each asserted softly so one red does not hide the others.
    expect.soft(obs.liveHlsBeforeLock, "live HLS 200 before the lock (C1 baseline)").toBe(200);
    expect.soft(lock.result?.requireSignedURLs, "lock echo").toBe(true);
    expect.soft(obs.liveHlsAfterLock, "live HLS still 200 after the lock").toBe(200);
    expect.soft([401, 403], "unsigned video manifest refused").toContain(obs.unsignedVideoManifestAfterLock);
    expect.soft(after.requireSignedURLs, "lock survives the recording's end").toBe(true);
    expect.soft(put.result?.recording?.requireSignedURLs, "PUT keeps requireSignedURLs").toBe(true);
    expect.soft(obs.expiryAtOnce, "short token at once").toBe(200);
    expect.soft([401, 403], "short token at now+90 s").toContain(obs.expiryAtPlus90);
  }, 20 * 60_000);
});
