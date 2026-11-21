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

  type Video = { uid: string; liveInput?: string | null; requireSignedURLs?: boolean; status?: { state?: string }; playback?: { hls?: string } };

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
    ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-re",
      "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", String(FEED_MAX_SECONDS),
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "60", "-b:v", "2500k",
      "-c:a", "aac", "-b:a", "128k", "-f", "flv", target,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    // The key is redacted from each chunk BEFORE the tail is kept, so a slice can never cut it into an unredacted piece.
    const streamKey = created.result!.rtmps.streamKey;
    let ffErr = "";
    let ffSpawnError: string | null = null;
    ffmpeg.stderr!.on("data", (d: Buffer) => { ffErr = (ffErr + d.toString().replaceAll(streamKey, "<key>")).slice(-2000); });
    ffmpeg.on("error", (e: NodeJS.ErrnoException) => { ffSpawnError = e.code === "ENOENT" ? "ffmpeg is not installed (ENOENT)" : `ffmpeg failed to start: ${e.code ?? e.message}`; });
    note(`ffmpeg pid ${ffmpeg.pid}`);

    // 3. Capture the in-progress recording's uid from the input's own videos, each item checked (C6).
    let deadline = Date.now() + 120_000;
    while (!videoUid) {
      if (ffSpawnError) throw new Error(ffSpawnError);
      if (ffmpeg.exitCode !== null) throw new Error(`ffmpeg exited ${ffmpeg.exitCode}: ${ffErr}`);
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
    deadline = Date.now() + 90_000;
    let liveBefore = 0;
    for (;;) {
      liveBefore = await httpStatus(`${host}/${await mint(inputUid)}/manifest/video.m3u8`);
      if (liveBefore === 200 || Date.now() > deadline) break;
      await sleep(5_000);
    }
    obs.liveHlsBeforeLock = liveBefore;

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

    // 6. Stop the feed; wait for the recording to finish (timeoutSeconds 180 after the disconnect), then re-read the lock.
    stopFeed();
    deadline = Date.now() + 8 * 60_000;
    let after = await readVideo();
    while (after.status?.state === "live-inprogress" || after.status?.state === "inprogress" || after.status?.state === "queued" || after.status?.state === "downloading") {
      if (Date.now() > deadline) break;
      await sleep(15_000);
      after = await readVideo();
    }
    obs.videoAfterEnd = { state: after.status?.state, requireSignedURLs: after.requireSignedURLs };

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
