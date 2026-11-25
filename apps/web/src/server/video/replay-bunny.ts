// server/video/replay-bunny.ts — Bunny Stream behind ReplayHost (Task 22). Every endpoint and rule here was measured on the
// owner's Bunny POC library; the ids cite docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md.
//  * API: `https://video.bunnycdn.com/library/{libraryId}`, keyed by the `AccessKey` header. The key never rides in a URL.
//  * Fetch: `POST /videos/fetch?collectionId=` with `{url, title}`. The answer's `id` is the new video (B1, B7).
//  * Status: the video API's numbers, mapped by Task 21's table. The webhook's numbers are a different list (B6, Task 27).
//  * `availableResolutions` is a comma list in no order (B9 read `360p,480p,720p,240p,1080p`), and the library is NOT capped
//    at 720p (B9; the owner keeps 1080p on, 2026-11-24): `video().heights` lists every height in it, the HLS set a viewer plays.
//    It is NOT the set of files a download may take: the MP4 fallback files (`play_{h}p.mp4`) are their own set, read from
//    `GET /videos/{id}/resolutions` (Task 48), and exist only for videos encoded after the fallback was switched on.
//  * A DELETE answers 200 every time, a second one included (B10). So `remove` decides `absent` from a GET that answers 404,
//    never from the DELETE's status.
//  * The embed token is B4's. A file needs B5's CDN token AND an allowed Referer (B3, B9).
//  * Watch time (Task 30): `GET /statistics?videoGuid=&dateFrom=&dateTo=`, summing `watchTimeChart`, whose unit is SECONDS
//    (WATCH_TIME_CHART_SECONDS_PER_UNIT; measured by the Task 20 probe's B11, 2026-11-23). A 404 is a video the library does not
//    hold, deleted or never there (the controller's read-only check, 2026-11-23: no chart, and not the library's total): null.
// Secrets (the API key, the read-only key, the token key) reach no URL, message, record or log line. A message is built from
// the operation, the status and our own ids only (never the vendor's text, never a fetch error's text, which can quote the
// URL), and it passes sanitise.ts's `redact` floor on its way out. A signed URL is never recorded: the CDN call is recorded
// with its token replaced by `[signed]`, and the fetch's source URL (a signed Cloudflare download) goes only to Bunny.
import { createHash } from "node:crypto";
import { z } from "zod";
import { BUNNY_EMBED_HOST, SEAZN_REPLAY_CALL_TIMEOUT_MS, seaznVideoOrigins, type BunnyConfig } from "@/server/relay/config";
import { NOOP_RECORDER, type ProviderCallRecorder } from "@/server/relay/ports";
import { redact } from "@/server/relay/sanitise";
import {
  assertWatchWindow, type ReplayCredential, type ReplayDownload, type ReplayHost, ReplayHostRefused, ReplayHostUnavailable, ReplayNotDownloadable,
  type ReplayState, type ReplayVideo,
} from "./replay-ports";

export const BUNNY_API_BASE = "https://video.bunnycdn.com/library";
/** How long the CDN token for one server-side download is valid. The server makes the request at once, so this only has to
 *  cover the start of one GET. A provider-protocol number, like the base URL above. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 300;
/** How many SECONDS one unit of the statistics answer's `watchTimeChart` is (Task 30). Bunny's "Get Video Statistics" (read
 *  2026-11-23) types each value as an int64 "total watch time" and names no unit. MEASURED as seconds by the Task 20 probe's B11
 *  (bunny.live.test.ts, "watch time"; the controller's run, 2026-11-23): 119 units charted for 183.1 s played, an implied
 *  1.539 s per unit — inside the probe's factor-of-two band around 1, where minutes would chart ~3 and milliseconds ~183 100.
 *  Kept at exactly 1 (controller ruling): the chart reads about a third under what the probe played, a gap whose cause is
 *  unmeasured, so a total here is an estimate, not an invoice line. The same run: the unwatched control video answered 0 (its
 *  chart an object, not null or absent), and a video read seconds after its DELETE still answered minutes — but re-read an hour
 *  later it answered 404 with no chart (the controller's check, 2026-11-23), so that read was lag: a deleted video's watch time is
 *  gone with it (Task 31 reads it before every removal). A provider-protocol fact, like the base URL above. */
export const WATCH_TIME_CHART_SECONDS_PER_UNIT = 1;

/** The video API's `status`, number by number (Task 21's table; B2 saw 2 -> 3 -> 4). A number not listed throws: a status
 *  Bunny adds later is reported, never guessed at. A Map, so a key like `constructor` cannot find Object.prototype. */
const VIDEO_STATES: ReadonlyMap<number, ReplayState> = new Map<number, ReplayState>([
  [0, "processing"], [1, "processing"], [2, "processing"], [3, "processing"],
  [4, "playable"],
  [5, "failed"], [6, "failed"],
  [7, "processing"], [8, "processing"],
]);

/** The fields of `GET /videos/{id}` this adapter reads (B7, B9). */
type BunnyVideoBody = { status?: unknown; length?: unknown; title?: unknown; availableResolutions?: unknown };
type Method = "GET" | "POST" | "DELETE";

export interface BunnyReplayOptions {
  fetchImpl?: typeof fetch;
  /** Every call is one record (ruling 13). Default: nothing. */
  recorder?: ProviderCallRecorder;
  /** The clock the CDN token's expiry is read from. */
  now?: () => Date;
  /** SEAZN_VIDEO_ORIGINS, read per download: the first host is the Referer the library allows (B3). */
  videoOrigins?: () => string[] | null;
}

/** `availableResolutions` (`"360p,480p,720p,240p,1080p"`) as heights, in the order Bunny gave, without repeats. The HLS set. */
export function heightsOf(list: unknown): number[] {
  const all = (typeof list === "string" ? list : "").split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(all)];
}

/** `GET /videos/{id}/resolutions` as stg answered it (the controller's probe, 2026-11-24, two videos): `data.mp4Resolutions` is the list of
 *  MP4 FALLBACK FILES, each `{resolution: "1080p", path: "play_1080p.mp4"}`. `data.storageResolutions` and `data.storageObjects` hold
 *  paths too, and are NOT downloadable, so only `mp4Resolutions` is read. `success` is the answer's own verdict. Unknown keys pass. */
const Mp4Answer = z.object({
  success: z.literal(true),
  data: z.object({
    mp4Resolutions: z.array(z.object({ resolution: z.string().optional(), path: z.string().optional() }).passthrough()),
  }).passthrough(),
}).passthrough();
const MP4_FILE = /^play_(\d+)p\.mp4$/;
const MP4_LABEL = /^(\d+)p$/;
/** The heights of the MP4 files a `/resolutions` answer lists, without repeats and in no promised order. A file's height is its `path`
 *  (`play_{h}p.mp4`), else its `resolution` label when it has no path. An answer that is not the documented shape, is not `success:
 *  true`, or has no `data.mp4Resolutions` list, has no file: an empty set (the download answers "not ready"), never a guess. */
export function mp4HeightsIn(json: unknown): number[] {
  const parsed = Mp4Answer.safeParse(json);
  if (!parsed.success) return [];
  const found = new Set<number>();
  for (const f of parsed.data.data.mp4Resolutions) {
    const m = f.path !== undefined ? MP4_FILE.exec(f.path) : f.resolution !== undefined ? MP4_LABEL.exec(f.resolution) : null;
    const h = m ? Number.parseInt(m[1]!, 10) : 0;
    if (h > 0) found.add(h);
  }
  return [...found];
}

export class BunnyReplayHost implements ReplayHost {
  private readonly config: BunnyConfig;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rec: ProviderCallRecorder;
  private readonly now: () => Date;
  private readonly videoOrigins: () => string[] | null;
  private readonly secrets: readonly string[];

  constructor(config: BunnyConfig, opts: BunnyReplayOptions = {}) {
    this.config = config;
    this.base = `${BUNNY_API_BASE}/${encodeURIComponent(config.libraryId)}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rec = opts.recorder ?? NOOP_RECORDER;
    this.now = opts.now ?? (() => new Date());
    this.videoOrigins = opts.videoOrigins ?? (() => seaznVideoOrigins());
    this.secrets = [config.apiKey, config.readOnlyKey, config.tokenKey];
  }

  async createCollection(orgId: string): Promise<string> {
    const r = await this.api<{ guid?: unknown }>("POST", "/collections", { name: `org:${orgId}` }, {
      operation: "createCollection", ids: [], subjectOf: (j) => (typeof j?.guid === "string" ? j.guid : null),
    });
    if (!r.ok) throw this.error(`createCollection: HTTP ${r.status} (org ${orgId})`);
    const guid = r.json?.guid;
    if (typeof guid !== "string" || guid === "") throw this.error(`createCollection: HTTP ${r.status} answered no collection id (org ${orgId})`);
    return guid;
  }

  async fetchFromUrl(a: { collectionId: string; title: string; url: string }): Promise<string> {
    const r = await this.api<{ id?: unknown }>("POST", `/videos/fetch?collectionId=${encodeURIComponent(a.collectionId)}`, { url: a.url, title: a.title }, {
      operation: "fetchFromUrl", ids: [a.collectionId], subjectOf: (j) => (typeof j?.id === "string" ? j.id : null),
    });
    if (!r.ok) throw this.error(`fetchFromUrl: HTTP ${r.status} (collection ${a.collectionId})`);
    const id = r.json?.id;
    if (typeof id !== "string" || id === "") throw this.error(`fetchFromUrl: HTTP ${r.status} answered no video id (collection ${a.collectionId})`);
    return id;
  }

  async video(videoId: string): Promise<ReplayVideo> {
    const body = await this.read(videoId, "video");
    if (body === null) return { state: "absent", lengthSeconds: null, title: null, heights: [] };
    const state = typeof body.status === "number" ? VIDEO_STATES.get(body.status) : undefined;
    if (state === undefined) {
      throw this.error(`video: unknown status ${typeof body.status === "number" ? body.status : "(none)"} (video ${videoId})`);
    }
    return {
      state,
      // 0 is Bunny's "not read yet" (an unencoded video reads length 0), and no replay is 0 s long.
      lengthSeconds: typeof body.length === "number" && body.length > 0 ? body.length : null,
      title: typeof body.title === "string" ? body.title : null,
      heights: heightsOf(body.availableResolutions),
    };
  }

  async remove(videoId: string): Promise<"deleted" | "absent"> {
    // B10: Bunny answers a DELETE of a video it no longer holds with 200, so only a GET can say it is absent.
    if ((await this.read(videoId, "remove")) === null) return "absent";
    const r = await this.api("DELETE", `/videos/${encodeURIComponent(videoId)}`, undefined, { operation: "remove", ids: [videoId], subjectId: videoId });
    if (!r.ok) throw this.error(`remove: HTTP ${r.status} (video ${videoId})`);
    return "deleted";
  }

  /** B4: `token = hex(sha256(tokenKey + videoId + expires))`. Pure: no call, and the video need not exist. `expiresAt` is the
   *  token's own expiry, in whole seconds. */
  signedEmbed(videoId: string, now: Date, ttlSeconds: number): { src: string; expiresAt: string } {
    const expires = Math.floor((now.getTime() + ttlSeconds * 1000) / 1000);
    const token = createHash("sha256").update(`${this.config.tokenKey}${videoId}${expires}`).digest("hex");
    return {
      src: `https://${BUNNY_EMBED_HOST}/embed/${encodeURIComponent(this.config.libraryId)}/${encodeURIComponent(videoId)}?token=${token}&expires=${expires}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  /** Whether a download would start (Task 48 review m2): the SAME checks `openDownload` makes before it opens the CDN — playable, the
   *  Referer origin set, an MP4 file listed — and nothing after. Two API reads, no CDN request, no token made. Throws as `openDownload`
   *  does; resolves when a file is listed. (A file the list names but the CDN does not hold is only `openDownload`'s to find.) */
  async checkDownload(videoId: string): Promise<void> {
    await this.downloadPlan(videoId, "checkDownload");
  }

  /** The checks every download starts with, in order, and the file they choose: the tallest of the MP4 set. */
  private async downloadPlan(videoId: string, operation: string): Promise<{ origin: string; height: number }> {
    const v = await this.video(videoId);
    if (v.state !== "playable") throw new ReplayNotDownloadable(videoId, `not playable (${v.state})`);
    const origin = this.videoOrigins()?.[0];
    if (!origin) throw this.error(`${operation}: SEAZN_VIDEO_ORIGINS is not set, and the replay host serves a file only to an allowed Referer (video ${videoId})`);
    const files = await this.mp4Heights(videoId);
    if (files.length === 0) throw new ReplayNotDownloadable(videoId, "no MP4 file yet");
    return { origin, height: Math.max(...files) };
  }

  /** The video's TALLEST MP4 file, as `play_{h}p.mp4` (B9) under the B5 CDN token, sent with the first SEAZN_VIDEO_ORIGINS host
   *  as Referer. The tallest is taken from the MP4 fallback set (`/resolutions`, Task 48), never from `availableResolutions`: the
   *  two sets differ. No file yet (the set is empty, or the CDN answers 404) is ReplayNotDownloadable: "try again", not a fault. The CDN's body is answered as it streams in, never buffered here.
   *
   *  Task 26 review m1: the CDN's HEADERS must arrive within SEAZN_REPLAY_CALL_TIMEOUT_MS (4 s, every call's deadline), else the
   *  request is aborted and recorded `timeout`; once they are in the deadline is cleared, so a 3 h file streams for as long as it
   *  is read (never AbortSignal.timeout on the whole request). The caller's `cancel` aborts the CDN request at any point — before
   *  the headers (recorded `cancelled`, not a failure of the host's) or while the body streams. */
  async openDownload(videoId: string, cancel?: AbortSignal): Promise<ReplayDownload> {
    const { origin, height } = await this.downloadPlan(videoId, "openDownload");
    const file = `play_${height}p.mp4`;
    const dir = `/${videoId}/`;
    // B5: base64url without padding of a plain sha256 (not an HMAC) over key + path + expiry + "token_path=" + path.
    const expires = Math.floor(this.now().getTime() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS;
    const token = createHash("sha256").update(`${this.config.tokenKey}${dir}${expires}token_path=${dir}`).digest("base64url");
    const url = `https://${this.config.cdnHost}/bcdn_token=${token}&expires=${expires}&token_path=${encodeURIComponent(dir)}${dir}${file}`;
    const recorded = `https://${this.config.cdnHost}/[signed]${dir}${file}`;
    const started = Date.now();
    const upstream = new AbortController();
    let why: "timeout" | "cancelled" | null = null;
    const deadline = setTimeout(() => {
      why = "timeout";
      upstream.abort(new DOMException("no response headers in time", "TimeoutError"));
    }, SEAZN_REPLAY_CALL_TIMEOUT_MS);
    const onCancel = () => {
      why ??= "cancelled";
      upstream.abort(cancel?.reason);
    };
    // Left attached after the headers on purpose: the caller's cancel must still stop the body from streaming.
    if (cancel?.aborted) onCancel();
    else cancel?.addEventListener("abort", onCancel, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers: { Referer: `https://${origin}/` }, signal: upstream.signal });
    } catch {
      clearTimeout(deadline);
      cancel?.removeEventListener("abort", onCancel);
      // The fetch error's own text is dropped, not quoted: a network failure can quote the URL, and the URL is the token.
      this.record("openDownload", "GET", recorded, [videoId], null, videoId, started, why ?? "network");
      // The caller's own cancel is not the host's failure: a plain error, which the download answers before reading any kind.
      if (why === "cancelled") throw this.error(`openDownload: cancelled before a response (video ${videoId})`);
      throw this.unavailable(
        why === "timeout"
          ? `openDownload: no response within ${SEAZN_REPLAY_CALL_TIMEOUT_MS} ms (video ${videoId})`
          : `openDownload: request failed before a response (video ${videoId})`,
      );
    }
    // The headers are in: the deadline was for them alone. The body streams for as long as the caller reads it.
    clearTimeout(deadline);
    this.record("openDownload", "GET", recorded, [videoId], res.status, videoId, started, null);
    if (!res.ok || !res.body) {
      cancel?.removeEventListener("abort", onCancel);
      await res.body?.cancel().catch(() => undefined);
      // The file the list named is not on the CDN (yet): the same "try again" as an empty list, never a fault (Task 48).
      if (res.status === 404) throw new ReplayNotDownloadable(videoId, "the MP4 file is not on the CDN yet");
      throw this.httpError(res.status, `openDownload: HTTP ${res.status} (video ${videoId})`, "delivery_token");
    }
    const size = Number(res.headers.get("content-length"));
    return { body: res.body, bytes: Number.isFinite(size) && size > 0 ? size : null, fileName: `${videoId}-${height}p.mp4` };
  }

  /** Task 30: `GET /statistics?videoGuid=&dateFrom=&dateTo=` (Bunny's "Get Video Statistics"), the window sent as ISO instants
   *  after the port's own check (`assertWatchWindow`: Bunny answers an unreadable date with the last 30 days, never an error).
   *  `watchTimeChart` maps each UTC interval to a watch-time count; their sum is converted through
   *  WATCH_TIME_CHART_SECONDS_PER_UNIT. A null chart is the schema's "no data" and reads 0. An answer with no chart at all, or a
   *  value that is not a count, throws: a shape we did not expect is reported, never read as nobody watching. A 404 is null (Task 31):
   *  the library holds no such video — Bunny forgets a deleted video's statistics with it — so there is nothing left to read. */
  async watchMinutes(videoId: string, from: Date, to: Date): Promise<number | null> {
    assertWatchWindow(from, to);
    const query = `videoGuid=${encodeURIComponent(videoId)}&dateFrom=${encodeURIComponent(from.toISOString())}&dateTo=${encodeURIComponent(to.toISOString())}`;
    const r = await this.api<{ watchTimeChart?: unknown }>("GET", `/statistics?${query}`, undefined, { operation: "watchMinutes", ids: [videoId], subjectId: videoId });
    if (r.status === 404) return null;
    if (!r.ok) throw this.httpError(r.status, `watchMinutes: HTTP ${r.status} (video ${videoId})`, "api_key");
    const chart = r.json?.watchTimeChart;
    if (chart === null) return 0;
    if (typeof chart !== "object" || Array.isArray(chart)) throw this.error(`watchMinutes: HTTP ${r.status} answered no watch-time chart (video ${videoId})`);
    let units = 0;
    for (const value of Object.values(chart)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw this.error(`watchMinutes: a watch-time value is not a count (video ${videoId})`);
      units += value;
    }
    return (units * WATCH_TIME_CHART_SECONDS_PER_UNIT) / 60;
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------

  /** `GET /videos/{id}`: the body, or null when Bunny answers 404 (it holds no such video). Any other refusal throws. */
  private async read(videoId: string, operation: string): Promise<BunnyVideoBody | null> {
    const r = await this.api<BunnyVideoBody>("GET", `/videos/${encodeURIComponent(videoId)}`, undefined, { operation, ids: [videoId], subjectId: videoId });
    if (r.status === 404) return null;
    if (!r.ok) throw this.httpError(r.status, `${operation}: HTTP ${r.status} (video ${videoId})`, "api_key");
    if (r.json === undefined || r.json === null) throw this.error(`${operation}: HTTP ${r.status} (video ${videoId})`);
    return r.json;
  }

  /** `GET /videos/{id}/resolutions` (Task 48): the heights of the MP4 fallback files the video HAS, as the paths it lists. A video
   *  the library does not hold (404) has none. */
  private async mp4Heights(videoId: string): Promise<number[]> {
    const r = await this.api<unknown>("GET", `/videos/${encodeURIComponent(videoId)}/resolutions`, undefined, { operation: "mp4Resolutions", ids: [videoId], subjectId: videoId });
    if (r.status === 404) return [];
    if (!r.ok) throw this.httpError(r.status, `mp4Resolutions: HTTP ${r.status} (video ${videoId})`, "api_key");
    return mp4HeightsIn(r.json);
  }

  /** One API request, one record. The AccessKey goes in its header and nowhere else. A network failure throws a message of
   *  our own: the fetch error's text is never quoted. Every request gives up after SEAZN_REPLAY_CALL_TIMEOUT_MS (Task 24 review I3:
   *  the move calls the host inside the tick's Seazn slice) — the request and the body read alike, recorded as `timeout`. */
  private async api<T>(
    method: Method, path: string, body: unknown,
    meta: { operation: string; ids: string[]; subjectId?: string; subjectOf?: (json: T | undefined) => string | null },
  ): Promise<{ status: number; ok: boolean; json: T | undefined }> {
    const url = `${this.base}${path}`;
    const started = Date.now();
    const signal = AbortSignal.timeout(SEAZN_REPLAY_CALL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { AccessKey: this.config.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      this.record(meta.operation, method, url, meta.ids, null, meta.subjectId ?? null, started, (e as { name?: string })?.name === "TimeoutError" ? "timeout" : "network");
      throw this.unavailable(`${meta.operation}: request failed before a response${meta.subjectId ? ` (video ${meta.subjectId})` : ""}`);
    }
    let json: T | undefined;
    try {
      json = (await res.json()) as T;
    } catch (e) {
      // A body that arrived but is not JSON (an empty 204, an error page) reads as absent, as before. A body that never arrived in
      // full — the call's own timeout, or the connection cut — is a failed call (re-review N6): recorded as one, never as its status.
      if (!(e instanceof SyntaxError)) {
        this.record(meta.operation, method, url, meta.ids, null, meta.subjectId ?? null, started, signal.aborted || (e as { name?: string })?.name === "TimeoutError" ? "timeout" : "network");
        throw this.unavailable(`${meta.operation}: the response did not arrive in full${meta.subjectId ? ` (video ${meta.subjectId})` : ""}`);
      }
      json = undefined;
    }
    this.record(meta.operation, method, url, meta.ids, res.status, meta.subjectId ?? meta.subjectOf?.(json) ?? null, started, null);
    return { status: res.status, ok: res.ok, json };
  }

  /** Fire-and-forget, like ingest-cf's: a recorder that throws never fails the call. Each string passes the redaction floor. */
  private record(operation: string, method: Method, url: string, ids: string[], status: number | null, subjectId: string | null, started: number, errorCode: string | null): void {
    const red = (s: string) => redact(s, this.secrets);
    const c = {
      provider: "bunny" as const, operation, subjectId: subjectId === null ? null : red(subjectId), sessionId: null, method,
      url: red(url), ids: [this.config.libraryId, ...ids].map(red), status, latencyMs: Date.now() - started, attempt: 1,
      requestId: null, errorCode,
    };
    void Promise.resolve().then(() => this.rec.record(c)).catch(() => undefined);
  }

  private error(text: string): Error {
    return new Error(redact(`bunny ${text}`, this.secrets));
  }

  /** The host did not answer (Task 27, carrying T26 re-review m1 a): retryable. */
  private unavailable(text: string): ReplayHostUnavailable {
    return new ReplayHostUnavailable(redact(`bunny ${text}`, this.secrets));
  }

  /** A refusal, by its status: 401 / 403 refuse OUR `credential` (the API's AccessKey, or the CDN's token and Referer: a
   *  configuration fault), 429 and every 5xx are the host not answering, anything else is neither. */
  private httpError(status: number, text: string, credential: ReplayCredential): Error {
    const message = redact(`bunny ${text}`, this.secrets);
    if (status === 401 || status === 403) return new ReplayHostRefused(status, credential, message);
    if (status === 429 || status >= 500) return new ReplayHostUnavailable(message);
    return new Error(message);
  }
}
