// server/video/replay-bunny.ts — Bunny Stream behind ReplayHost (Task 22). Every endpoint and rule here was measured on the
// owner's Bunny POC library; the ids cite docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md.
//  * API: `https://video.bunnycdn.com/library/{libraryId}`, keyed by the `AccessKey` header. The key never rides in a URL.
//  * Fetch: `POST /videos/fetch?collectionId=` with `{url, title}`. The answer's `id` is the new video (B1, B7).
//  * Status: the video API's numbers, mapped by Task 21's table. The webhook's numbers are a different list (B6, Task 27).
//  * `availableResolutions` is a comma list in no order (B9 read `360p,480p,720p,240p,1080p`), and the library is NOT capped
//    at 720p (B9). The port promises heights at or under 720, so anything above is dropped here, with one warning per video.
//  * A DELETE answers 200 every time, a second one included (B10). So `remove` decides `absent` from a GET that answers 404,
//    never from the DELETE's status.
//  * The embed token is B4's. A file needs B5's CDN token AND an allowed Referer (B3, B9).
// Secrets (the API key, the read-only key, the token key) reach no URL, message, record or log line. A message is built from
// the operation, the status and our own ids only (never the vendor's text, never a fetch error's text, which can quote the
// URL), and it passes sanitise.ts's `redact` floor on its way out. A signed URL is never recorded: the CDN call is recorded
// with its token replaced by `[signed]`, and the fetch's source URL (a signed Cloudflare download) goes only to Bunny.
import { createHash } from "node:crypto";
import { BUNNY_EMBED_HOST, SEAZN_REPLAY_CALL_TIMEOUT_MS, seaznVideoOrigins, type BunnyConfig } from "@/server/relay/config";
import { NOOP_RECORDER, type ProviderCallRecorder } from "@/server/relay/ports";
import { redact } from "@/server/relay/sanitise";
import { type ReplayDownload, type ReplayHost, ReplayNotDownloadable, type ReplayState, type ReplayVideo } from "./replay-ports";

export const BUNNY_API_BASE = "https://video.bunnycdn.com/library";
/** The tallest rendition a replay is served at: the port promises nothing above it. */
const MAX_HEIGHT = 720;
/** How long the CDN token for one server-side download is valid. The server makes the request at once, so this only has to
 *  cover the start of one GET. A provider-protocol number, like the base URL above. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 300;

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
  /** Where the above-720p warning goes. INJECTED, like ingest-cf's `reportError`, so this adapter imports no app module.
   *  Default: nothing. */
  warn?: (fields: Record<string, unknown>, msg: string) => void;
}

export class BunnyReplayHost implements ReplayHost {
  private readonly config: BunnyConfig;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rec: ProviderCallRecorder;
  private readonly now: () => Date;
  private readonly videoOrigins: () => string[] | null;
  private readonly warn: (fields: Record<string, unknown>, msg: string) => void;
  private readonly secrets: readonly string[];
  /** The videos already warned about, so a video polled every tick warns once per process. */
  private readonly warnedAbove = new Set<string>();

  constructor(config: BunnyConfig, opts: BunnyReplayOptions = {}) {
    this.config = config;
    this.base = `${BUNNY_API_BASE}/${encodeURIComponent(config.libraryId)}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rec = opts.recorder ?? NOOP_RECORDER;
    this.now = opts.now ?? (() => new Date());
    this.videoOrigins = opts.videoOrigins ?? (() => seaznVideoOrigins());
    this.warn = opts.warn ?? (() => undefined);
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
      heights: this.heightsOf(videoId, body.availableResolutions),
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

  /** The video's tallest rendition at or under 720p, as `play_{h}p.mp4` (B9) under the B5 CDN token, sent with the first
   *  SEAZN_VIDEO_ORIGINS host as Referer. The CDN's body is answered as it streams in, never buffered here.
   *
   *  Task 26 review m1: the CDN's HEADERS must arrive within SEAZN_REPLAY_CALL_TIMEOUT_MS (4 s, every call's deadline), else the
   *  request is aborted and recorded `timeout`; once they are in the deadline is cleared, so a 3 h file streams for as long as it
   *  is read (never AbortSignal.timeout on the whole request). The caller's `cancel` aborts the CDN request at any point — before
   *  the headers (recorded `cancelled`, not a failure of the host's) or while the body streams. */
  async openDownload(videoId: string, cancel?: AbortSignal): Promise<ReplayDownload> {
    const v = await this.video(videoId);
    if (v.state !== "playable") throw new ReplayNotDownloadable(videoId, `not playable (${v.state})`);
    if (v.heights.length === 0) throw new ReplayNotDownloadable(videoId, `no rendition at or under ${MAX_HEIGHT}p`);
    const origin = this.videoOrigins()?.[0];
    if (!origin) throw this.error(`openDownload: SEAZN_VIDEO_ORIGINS is not set, and the replay host serves a file only to an allowed Referer (video ${videoId})`);
    const height = Math.max(...v.heights);
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
      throw this.error(
        why === "timeout"
          ? `openDownload: no response within ${SEAZN_REPLAY_CALL_TIMEOUT_MS} ms (video ${videoId})`
          : why === "cancelled"
            ? `openDownload: cancelled before a response (video ${videoId})`
            : `openDownload: request failed before a response (video ${videoId})`,
      );
    }
    // The headers are in: the deadline was for them alone. The body streams for as long as the caller reads it.
    clearTimeout(deadline);
    this.record("openDownload", "GET", recorded, [videoId], res.status, videoId, started, null);
    if (!res.ok || !res.body) {
      cancel?.removeEventListener("abort", onCancel);
      await res.body?.cancel().catch(() => undefined);
      throw this.error(`openDownload: HTTP ${res.status} (video ${videoId})`);
    }
    const size = Number(res.headers.get("content-length"));
    return { body: res.body, bytes: Number.isFinite(size) && size > 0 ? size : null, fileName: `${videoId}-${height}p.mp4` };
  }

  /** Phase 3 (Task 30) builds the statistics read; until then this refuses, loudly. */
  async watchMinutes(): Promise<number> {
    throw new Error("BunnyReplayHost.watchMinutes is not built yet (Task 30)");
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------

  /** `GET /videos/{id}`: the body, or null when Bunny answers 404 (it holds no such video). Any other refusal throws. */
  private async read(videoId: string, operation: string): Promise<BunnyVideoBody | null> {
    const r = await this.api<BunnyVideoBody>("GET", `/videos/${encodeURIComponent(videoId)}`, undefined, { operation, ids: [videoId], subjectId: videoId });
    if (r.status === 404) return null;
    if (!r.ok || r.json === undefined || r.json === null) throw this.error(`${operation}: HTTP ${r.status} (video ${videoId})`);
    return r.json;
  }

  /** `availableResolutions` (`"360p,480p,720p,240p"`) as heights, in the order Bunny gave, without repeats, at or under 720.
   *  Anything above is dropped and warned about once per video, naming the video id and nothing else. */
  private heightsOf(videoId: string, list: unknown): number[] {
    const all = (typeof list === "string" ? list : "").split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    if (all.some((n) => n > MAX_HEIGHT) && !this.warnedAbove.has(videoId)) {
      this.warnedAbove.add(videoId);
      this.warn({ videoId }, "replay encoded above 720p: the library's 720p cap is off; only renditions at or under 720p are used");
    }
    return [...new Set(all.filter((n) => n <= MAX_HEIGHT))];
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
      throw this.error(`${meta.operation}: request failed before a response${meta.subjectId ? ` (video ${meta.subjectId})` : ""}`);
    }
    let json: T | undefined;
    try {
      json = (await res.json()) as T;
    } catch (e) {
      // A body that arrived but is not JSON (an empty 204, an error page) reads as absent, as before. A body that never arrived in
      // full — the call's own timeout, or the connection cut — is a failed call (re-review N6): recorded as one, never as its status.
      if (!(e instanceof SyntaxError)) {
        this.record(meta.operation, method, url, meta.ids, null, meta.subjectId ?? null, started, signal.aborted || (e as { name?: string })?.name === "TimeoutError" ? "timeout" : "network");
        throw this.error(`${meta.operation}: the response did not arrive in full${meta.subjectId ? ` (video ${meta.subjectId})` : ""}`);
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
}
