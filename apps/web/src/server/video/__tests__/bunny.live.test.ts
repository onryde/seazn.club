// LIVE, opt-in: the Bunny Stream behaviours the Seazn-hosted POC (2026-11-20, B1–B6) left open, which Tasks 21, 22,
// 25 and 26 rest on. Results are recorded in docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md (B7–B10).
//
//   B7  collections: `POST /collections {name}` answers a `guid`; a fetch with `collectionId` answers an `id` (B1)
//       whose `GET /videos/{id}` names that collection.
//   B8  embed past expiry: an embed loaded with `expires` = now + 60 s keeps playing a ~3-min video to its end. Driven
//       in headless Chrome on a page served, by request interception, from an allowed referrer host (no request
//       reaches seazn.club). A control embed whose `expires` has already passed must be refused, or the main result
//       means nothing.
//   B9  MP4 fallback: `play_{h}p.mp4` under the B5 CDN token answers 200 with an allowed `Referer` and 403 without
//       one, for the highest `h` listed. The library is NOT capped at 720p (owner ruling 2026-11-24: 1080p stays on), which is an
//       owner library setting, so it is checked in its own test.
//   B10 delete: `DELETE /videos/{id}` answers 200 and the video then reads 404. (The brief expected a second DELETE
//       to answer 404; it answers 200, so the probe pins what was measured.)
//   B8 also reads the CDN token the embed was handed (its form and its own `expires`) and re-requests the embed's
//   last playlist and segment URLs after the embed's expiry, since a fully buffered 3-min video fetches little late.
//   B11 watch time (Task 30): the UNIT of `watchTimeChart`. After B8 has played `long` to its end in the embed, its statistics are
//       read through the production adapter (`BunnyReplayHost.watchMinutes`) every 30 s for up to 10 min, until they show any
//       watch time. `impliedSecondsPerUnit` (the seconds the embed played over the chart's sum) is the answer: ~1 means seconds,
//       ~60 minutes, ~0.001 milliseconds; replay-bunny.ts's WATCH_TIME_CHART_SECONDS_PER_UNIT must equal it. Control: `hd`, never
//       played in a player, must read 0, or `videoGuid` was not applied and the reading means nothing. Also recorded, not asserted:
//       what the read answers for `long` once B10 has deleted it (Task 31 measures replays until they are deleted).
//
// Gate: the flag BUNNY_LIVE_PROBE=1 first; only behind it the four BUNNY_* values, from the environment only (the POC
// credentials file; .env.local is never read for them). Without the flag nothing else is read and the file skips
// loudly. CI never sets the flag.
//
// SAFETY: the target is the owner's Bunny POC library (the one ~/.config/seazn/bunny-poc.env names), nothing else;
// whether it is also the staging library of Operator setup Phase 2 is not confirmed. This run creates one collection and two
// videos and deletes only those, each by the id its own create/fetch answered, tracked in-process. No list endpoint is
// ever called: `bunny()` refuses any GET or DELETE that is not a single id path, and B11's adapter is handed a fetch that refuses
// anything but a GET of one video's statistics. Before each delete the item is re-read
// by id (a video must carry its own guid and sit in this run's collection or under this run's title; the collection
// must carry this run's name).
// Cleanup is in `afterAll`, one try per item, so one failure strands nothing else. The API key, the token key, every
// token and every signed URL are never logged, asserted on or put into an error message.
//
// Run: cd apps/web && set -a; . ~/.config/seazn/bunny-poc.env; set +a; \
//      DATABASE_URL= BUNNY_LIVE_PROBE=1 npx vitest run src/server/video/__tests__/bunny.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Frame } from "playwright";
import { BunnyReplayHost, WATCH_TIME_CHART_SECONDS_PER_UNIT } from "../replay-bunny";

type BunnyGate =
  | { enabled: true; libraryId: string; cdnHost: string; apiKey: string; tokenKey: string }
  | { enabled: false; reason: string };

/** Flag first; the credentials are read only behind it, and only from the environment. Names, never values. */
function bunnyLiveGate(env: Record<string, string | undefined>): BunnyGate {
  if (env.BUNNY_LIVE_PROBE !== "1") return { enabled: false, reason: "BUNNY_LIVE_PROBE=1 is not set" };
  const read = (k: string) => env[k]?.trim() || "";
  const values = {
    libraryId: read("BUNNY_STREAM_LIBRARY_ID"),
    cdnHost: read("BUNNY_STREAM_CDN_HOST"),
    apiKey: read("BUNNY_STREAM_API_KEY"),
    tokenKey: read("BUNNY_TOKEN_KEY"),
  };
  const names: Record<keyof typeof values, string> = {
    libraryId: "BUNNY_STREAM_LIBRARY_ID", cdnHost: "BUNNY_STREAM_CDN_HOST", apiKey: "BUNNY_STREAM_API_KEY", tokenKey: "BUNNY_TOKEN_KEY",
  };
  const missing = (Object.keys(values) as (keyof typeof values)[]).filter((k) => !values[k]).map((k) => names[k]);
  if (missing.length > 0) return { enabled: false, reason: `missing from the environment: ${missing.join(", ")}` };
  return { enabled: true, ...values };
}

const GATE = bunnyLiveGate(process.env);
if (!GATE.enabled) console.log(`SKIP  bunny live probe — ${GATE.reason} (needs BUNNY_LIVE_PROBE=1 and the four BUNNY_* values)`);

/** Public samples, fetched by Bunny (B1). `long` (720p, 183 s) carries the embed; `hd` (1080p, 28 s) tests the cap. */
const SOURCES = {
  long: "https://filesamples.com/samples/video/mp4/sample_1280x720_surfing_with_audio.mp4",
  hd: "https://filesamples.com/samples/video/mp4/sample_1920x1080.mp4",
} as const;
type SourceKey = keyof typeof SOURCES;

/** Referrers the operator setup allows (plan, Phase 2 setup; B3). The first that answers 200 hosts the embed page. */
const REFERER_CANDIDATES = ["https://stg.seazn.club/", "https://seazn.club/", "https://www.seazn.club/"] as const;
const FOREIGN_REFERER = "https://example.com/";
const PROBE_PAGE_PATH = "/__seazn-task20-bunny-probe";
const EMBED_HOST = "iframe.mediadelivery.net";
const API_BASE = "https://video.bunnycdn.com/library";
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ONE_ID_PATH = new RegExp(`^/(videos|collections)/${ID}$`);
const FETCH_PATH = new RegExp(`^/videos/fetch\\?collectionId=${ID}$`);

const RUN = `seazn-task20-probe-${Date.now().toString(36)}`;
/** B11: how long the watch-time read waits for the embed's view to show (Bunny states no delay), and how often it asks. */
const WATCH_STATS_WAIT_MS = 10 * 60_000;
const WATCH_STATS_POLL_MS = 30_000;
const TITLES: Record<SourceKey, string> = { long: `${RUN}-long`, hd: `${RUN}-hd` };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (s: string) => console.log("LIVE  " + s);
const nowSec = () => Math.floor(Date.now() / 1000);

type BunnyVideo = {
  guid?: string; title?: string; status?: number; length?: number; width?: number; height?: number;
  collectionId?: string; availableResolutions?: string | null; hasMP4Fallback?: boolean;
};
type Sample = { at: number; video: boolean; t?: number; d?: number; paused?: boolean; ended?: boolean; err?: number | null; buf?: number; text?: string };

/** Finds the player's <video>, through open shadow roots, and reads its state. A string so no bundler helper leaks in. */
const SAMPLE_JS = `(() => {
  const find = (root) => { const v = root.querySelector("video"); if (v) return v;
    for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } return null; };
  const v = find(document);
  if (!v) return { video: false, text: ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").slice(0, 160) };
  const b = v.buffered;
  return { video: true, t: v.currentTime, d: v.duration, paused: v.paused, ended: v.ended, err: v.error ? v.error.code : null,
    buf: b.length ? b.end(b.length - 1) : 0 };
})()`;
const PLAY_JS = `(() => {
  const find = (root) => { const v = root.querySelector("video"); if (v) return v;
    for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } return null; };
  const v = find(document); if (!v) return "no video";
  v.muted = true; return v.play().then(() => "ok", (e) => String(e && e.name));
})()`;

describe.skipIf(!GATE.enabled)("Bunny Stream — collections, embed past expiry, MP4 fallback, delete (live)", () => {
  const { libraryId, cdnHost, apiKey, tokenKey } = GATE.enabled ? GATE : { libraryId: "", cdnHost: "", apiKey: "", tokenKey: "" };

  // Everything this run created, by the id its own answer carried. Cleanup acts on these and nothing else.
  let collectionId: string | null = null;
  const videoIds: Partial<Record<SourceKey, string>> = {};
  const deleted = new Set<string>();
  const ledger = { created: [] as string[], deleted: [] as string[], skipped: [] as string[] };
  const obs: Record<string, unknown> = {};
  // Each video as read once it finished encoding. The first test fills it; the library-setting test reads it.
  const playable: Partial<Record<SourceKey, BunnyVideo>> = {};
  let browser: Browser | null = null;

  /** Strips anything secret from text that came back from the vendor or the browser. */
  const redact = (s: string) => [tokenKey, apiKey].filter(Boolean).reduce((acc, k) => acc.replaceAll(k, "<key>"), s);

  /** A re-read video is this run's own: the same guid, and in this run's collection or under this run's title. */
  const isOwn = (key: SourceKey, id: string, v: BunnyVideo | undefined) =>
    v?.guid === id && (v.collectionId === collectionId || v.title === TITLES[key]);

  async function bunny<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; ok: boolean; json: T | undefined }> {
    const allowed = method === "POST" ? path === "/collections" || FETCH_PATH.test(path) : ONE_ID_PATH.test(path);
    if (!allowed) throw new Error(`refused: ${method} ${path} is not a single-id call this probe may make (no list calls)`);
    const res = await fetch(`${API_BASE}/${libraryId}${path}`, {
      method,
      headers: { AccessKey: apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: T | undefined;
    try { json = text ? (JSON.parse(text) as T) : undefined; } catch { json = undefined; }
    return { status: res.status, ok: res.ok, json };
  }

  async function getVideo(id: string): Promise<{ status: number; video: BunnyVideo | undefined }> {
    const r = await bunny<BunnyVideo>("GET", `/videos/${id}`);
    return { status: r.status, video: r.json };
  }

  /** B4: hex(sha256(tokenKey + guid + expires)). */
  const embedUrl = (guid: string, expires: number) =>
    `https://${EMBED_HOST}/embed/${libraryId}/${guid}?token=${createHash("sha256").update(tokenKey + guid + expires).digest("hex")}` +
    `&expires=${expires}&autoplay=true&muted=true&loop=false`;

  /** B5: base64url-no-pad(sha256(tokenKey + "/{guid}/" + expires + "token_path=/{guid}/")), a plain sha256. */
  const cdnFileUrl = (guid: string, file: string, expires: number) => {
    const t = createHash("sha256").update(`${tokenKey}/${guid}/${expires}token_path=/${guid}/`).digest("base64url");
    return `https://${cdnHost}/bcdn_token=${t}&expires=${expires}&token_path=%2F${guid}%2F/${guid}/${file}`;
  };

  /** One GET of a CDN file; the body is cancelled at once, so nothing is downloaded. Errors never carry the URL. */
  async function cdnGet(url: string, referer: string | null): Promise<{ status: number; type: string | null; bytes: number | null }> {
    try {
      const res = await fetch(url, { headers: referer ? { referer } : {}, redirect: "manual" });
      const out = { status: res.status, type: res.headers.get("content-type"), bytes: Number(res.headers.get("content-length")) || null };
      await res.body?.cancel().catch(() => {});
      return out;
    } catch (e) {
      throw new Error(`CDN request failed (${String((e as { cause?: { code?: string } }).cause?.code ?? "network")})`);
    }
  }

  const heightsOf = (v: BunnyVideo | undefined) =>
    (v?.availableResolutions ?? "").split(",").map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  /** Deletes one video this run created, after re-reading it by id. Never throws; records the outcome. */
  async function deleteOwnVideo(key: SourceKey): Promise<void> {
    const id = videoIds[key];
    if (!id || deleted.has(id)) return;
    try {
      const check = await getVideo(id);
      if (check.status === 404) { deleted.add(id); ledger.deleted.push(`video ${id} (already gone, 404)`); return; }
      if (check.status !== 200 || !isOwn(key, id, check.video)) {
        ledger.skipped.push(`video ${id} re-check failed (status ${check.status}, collection ${check.video?.collectionId ?? "absent"}); not deleted`);
        return;
      }
      const r = await bunny("DELETE", `/videos/${id}`);
      if (r.ok || r.status === 404) { deleted.add(id); ledger.deleted.push(`video ${id} (${r.status})`); }
      else ledger.skipped.push(`video ${id} delete answered ${r.status}`);
    } catch (e) {
      ledger.skipped.push(`video ${id} cleanup threw (${redact((e as Error).message)})`);
    }
  }

  afterAll(async () => {
    if (browser) await browser.close().catch(() => {});
    for (const key of Object.keys(SOURCES) as SourceKey[]) await deleteOwnVideo(key);
    if (collectionId) {
      try {
        const check = await bunny<{ guid?: string; name?: string }>("GET", `/collections/${collectionId}`);
        if (check.status === 404) ledger.deleted.push(`collection ${collectionId} (already gone, 404)`);
        else if (check.status !== 200 || check.json?.guid !== collectionId || check.json?.name !== RUN) {
          ledger.skipped.push(`collection ${collectionId} re-check failed (status ${check.status}, name ${check.json?.name ?? "absent"}); not deleted`);
        } else {
          const r = await bunny("DELETE", `/collections/${collectionId}`);
          if (r.ok || r.status === 404) ledger.deleted.push(`collection ${collectionId} (${r.status})`);
          else ledger.skipped.push(`collection ${collectionId} delete answered ${r.status}`);
        }
      } catch (e) {
        ledger.skipped.push(`collection ${collectionId} cleanup threw (${redact((e as Error).message)})`);
      }
    }
    note(`OBSERVED ${redact(JSON.stringify(obs))}`);
    note(`LEDGER created ${ledger.created.length}, deleted ${ledger.deleted.length}, skipped ${ledger.skipped.length}: ${JSON.stringify(ledger)}`);
    expect(ledger.skipped).toEqual([]);
  }, 3 * 60_000);

  it("observes collections, the MP4 fallback, the embed past its expiry, and delete", async () => {
    // ---- B7: a collection, and two fetches into it. ----
    const coll = await bunny<{ guid?: string; name?: string }>("POST", "/collections", { name: RUN });
    obs.collectionCreate = { status: coll.status, hasGuid: typeof coll.json?.guid === "string", nameEcho: coll.json?.name === RUN };
    if (typeof coll.json?.guid !== "string" || !new RegExp(`^${ID}$`).test(coll.json.guid)) throw new Error(`collection create answered ${coll.status} with no guid`);
    collectionId = coll.json.guid;
    ledger.created.push(`collection ${collectionId}`);
    note(`created collection ${collectionId}`);

    const fetchStarted = Date.now();
    for (const key of Object.keys(SOURCES) as SourceKey[]) {
      const r = await bunny<{ id?: string; success?: boolean; message?: string }>(
        "POST", `/videos/fetch?collectionId=${collectionId}`, { url: SOURCES[key], title: TITLES[key] });
      obs[`fetch_${key}`] = { status: r.status, bodyKeys: Object.keys(r.json ?? {}).sort(), hasId: typeof r.json?.id === "string" };
      if (typeof r.json?.id !== "string" || !new RegExp(`^${ID}$`).test(r.json.id)) throw new Error(`fetch (${key}) answered ${r.status} with no id`);
      videoIds[key] = r.json.id;
      ledger.created.push(`video ${r.json.id} (${key})`);
      note(`fetched ${key} → video ${r.json.id}`);
    }

    // Wait for both to finish encoding (video API status 4; B2), recording the status sequence each passed through.
    const statusSeq: Record<SourceKey, number[]> = { long: [], hd: [] };
    const encodeDeadline = Date.now() + 12 * 60_000;
    while (Object.keys(playable).length < 2) {
      for (const key of Object.keys(SOURCES) as SourceKey[]) {
        if (playable[key]) continue;
        const { status, video } = await getVideo(videoIds[key]!);
        if (status !== 200 || !video) throw new Error(`video read (${key}) answered ${status}`);
        const seq = statusSeq[key];
        if (seq[seq.length - 1] !== video.status) seq.push(video.status ?? -1);
        if (video.status === 4) {
          playable[key] = video;
          obs[`encodeSeconds_${key}`] = Math.round((Date.now() - fetchStarted) / 1000);
        } else if (video.status === 5 || video.status === 6) throw new Error(`video ${key} failed to encode (status ${video.status})`);
      }
      if (Object.keys(playable).length < 2) {
        if (Date.now() > encodeDeadline) throw new Error(`encoding not finished within 12 min: ${JSON.stringify(statusSeq)}`);
        await sleep(10_000);
      }
    }
    obs.statusSequence = statusSeq;

    for (const key of Object.keys(SOURCES) as SourceKey[]) {
      const v = playable[key]!;
      obs[`video_${key}`] = {
        collectionIdIsOurs: v.collectionId === collectionId, titleEcho: v.title === TITLES[key], length: v.length,
        width: v.width, height: v.height, availableResolutions: v.availableResolutions, hasMP4Fallback: v.hasMP4Fallback,
      };
    }
    const collAfter = await bunny<{ videoCount?: number }>("GET", `/collections/${collectionId}`);
    obs.collectionVideoCount = collAfter.json?.videoCount;

    // ---- B9: the MP4 fallback for the highest height listed, with and without an allowed Referer. ----
    let allowedReferer: string | null = null;
    for (const key of Object.keys(SOURCES) as SourceKey[]) {
      const guid = videoIds[key]!;
      const heights = heightsOf(playable[key]);
      const top = heights[heights.length - 1];
      const out: Record<string, unknown> = { heights, top };
      obs[`mp4_${key}`] = out;
      if (top === undefined) continue;
      const file = `play_${top}p.mp4`;
      const expires = nowSec() + 3600;
      const url = cdnFileUrl(guid, file, expires);
      // The fallback MP4 can lag the status by a little; poll up to 4 min, trying each candidate referrer.
      const tries: string[] = [];
      const mp4Deadline = Date.now() + 4 * 60_000;
      let hit: { referer: string; status: number; type: string | null; bytes: number | null } | null = null;
      for (;;) {
        const candidates: readonly string[] = allowedReferer ? [allowedReferer] : REFERER_CANDIDATES;
        for (const ref of candidates) {
          const r = await cdnGet(url, ref);
          tries.push(`${new URL(ref).hostname}:${r.status}`);
          if (r.status === 200) { hit = { referer: ref, ...r }; break; }
        }
        if (hit || Date.now() > mp4Deadline) break;
        await sleep(15_000);
      }
      out.file = file;
      out.tries = tries.length > 12 ? [...tries.slice(0, 6), `…${tries.length - 12} more…`, ...tries.slice(-6)] : tries;
      if (hit) {
        allowedReferer ??= hit.referer;
        out.withAllowedReferer = { host: new URL(hit.referer).hostname, status: hit.status, type: hit.type, bytes: hit.bytes };
        out.withoutReferer = (await cdnGet(url, null)).status;
        out.withForeignReferer = (await cdnGet(url, FOREIGN_REFERER)).status;
        // Each listed height, for Task 22's choice of file.
        const perHeight: Record<string, number> = {};
        for (const h of heights) perHeight[`${h}p`] = (await cdnGet(cdnFileUrl(guid, `play_${h}p.mp4`, expires), hit.referer)).status;
        out.perHeightWithAllowedReferer = perHeight;
      } else {
        // The documented name did not answer: try the one alternative spelling, so the report names what exists.
        const alt = `play_${top}.mp4`;
        out.alternative = { file: alt, status: (await cdnGet(cdnFileUrl(guid, alt, expires), REFERER_CANDIDATES[0])).status };
      }
    }

    // ---- B8: the embed past its token's expiry, on a page served from an allowed referrer host. ----
    const embed: Record<string, unknown> = {};
    obs.embed = embed;
    const pageHost = allowedReferer ?? REFERER_CANDIDATES[0];
    embed.pageHost = new URL(pageHost).hostname;
    embed.pageHostSource = allowedReferer ? "the referrer the CDN accepted (B9)" : "first candidate (no MP4 answered 200)";
    const { chromium } = await import("playwright");
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
      embed.browser = `chrome ${browser.version()}`;
    } catch {
      browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
      embed.browser = `playwright chromium ${browser.version()} (Chrome channel unavailable)`;
    }
    const context: BrowserContext = await browser.newContext();
    let pageHtml = "";
    // Every seazn.club request is answered here; none reaches the real host.
    await context.route(/^https:\/\/([a-z0-9-]+\.)*seazn\.club\//, (route) =>
      new URL(route.request().url()).pathname === PROBE_PAGE_PATH
        ? route.fulfill({ status: 200, contentType: "text/html", body: pageHtml })
        : route.fulfill({ status: 404, body: "" }));
    const net: { at: number; host: string; ext: string; status: number }[] = [];
    const otherHosts = new Set<string>();
    // The last token-bearing playlist and segment URLs the embed itself used. Held in memory only, never logged: they
    // are re-requested after the embed's expiry, and only numbers derived from them reach OBSERVED.
    const seen: { m3u8: string | null; ts: string | null } = { m3u8: null, ts: null };
    context.on("response", (r) => {
      let u: URL;
      try { u = new URL(r.url()); } catch { return; }
      const host = u.hostname === cdnHost ? "cdn" : u.hostname === EMBED_HOST ? "embed"
        : u.hostname.endsWith(".b-cdn.net") ? "other-b-cdn" : u.hostname.endsWith("mediadelivery.net") ? "mediadelivery" : "other";
      if (host === "other" || host === "other-b-cdn") otherHosts.add(u.hostname);
      const last = u.pathname.split("/").pop() ?? "";
      const ext = last.includes(".") ? last.slice(last.lastIndexOf(".") + 1).slice(0, 8) : "-";
      net.push({ at: Date.now(), host, ext, status: r.status() });
      if (host === "cdn" && r.status() === 200 && (ext === "m3u8" || ext === "ts")) seen[ext] = r.url();
    });

    async function openEmbed(expires: number) {
      const src = embedUrl(videoIds.long!, expires);
      pageHtml = `<!doctype html><html><body style="margin:0"><iframe src="${src}" width="960" height="540" ` +
        `allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen style="border:0"></iframe></body></html>`;
      const page = await context.newPage();
      const loadedAt = Date.now();
      await page.goto(`${pageHost.replace(/\/$/, "")}${PROBE_PAGE_PATH}`, { waitUntil: "load", timeout: 60_000 });
      let frame: Frame | undefined;
      const frameDeadline = Date.now() + 30_000;
      while (!frame && Date.now() < frameDeadline) {
        frame = page.frames().find((f) => f.url().startsWith(`https://${EMBED_HOST}/`));
        if (!frame) await sleep(500);
      }
      return { page, frame, loadedAt };
    }
    const sample = async (frame: Frame, loadedAt: number): Promise<Sample> => {
      try {
        const s = (await frame.evaluate(SAMPLE_JS)) as Omit<Sample, "at">;
        return { at: Math.round((Date.now() - loadedAt) / 1000), ...s, ...(s.text ? { text: redact(s.text) } : {}) };
      } catch (e) {
        return { at: Math.round((Date.now() - loadedAt) / 1000), video: false, text: `evaluate failed: ${redact((e as Error).message).slice(0, 80)}` };
      }
    };

    // Control: an already-expired token must be refused, or "plays past expiry" proves nothing.
    {
      const { page, frame, loadedAt } = await openEmbed(nowSec() - 120);
      let last: Sample | null = null;
      if (frame) {
        await sleep(12_000);
        await frame.evaluate(PLAY_JS).catch(() => undefined);
        await sleep(8_000);
        last = await sample(frame, loadedAt);
      }
      const played = !!last?.video && (last.t ?? 0) > 0.5;
      embed.expiredControl = { frameFound: !!frame, played, sample: last };
      await page.close();
    }

    // Main: expires = now + 60 s; watch to the end.
    net.length = 0;
    const expires = nowSec() + 60;
    const expiresMs = expires * 1000;
    const { page, frame, loadedAt } = await openEmbed(expires);
    embed.frameFound = !!frame;
    const samples: Sample[] = [];
    let kicked: unknown = null;
    if (frame) {
      const length = playable.long!.length ?? 200;
      const watchDeadline = loadedAt + (length + 150) * 1000;
      for (;;) {
        const s = await sample(frame, loadedAt);
        samples.push(s);
        if (!kicked && s.at >= 8 && s.video && (s.t ?? 0) < 0.1) kicked = await frame.evaluate(PLAY_JS).catch((e) => `play threw ${(e as Error).name}`);
        const atEnd = s.video && (s.ended || (typeof s.d === "number" && Number.isFinite(s.d) && s.d > 0 && (s.t ?? 0) >= s.d - 0.5));
        if (atEnd || Date.now() > watchDeadline) break;
        await sleep(5_000);
      }
    }
    await page.close();

    // The player had buffered most of the video before the expiry, so few fetches happen after it. To settle whether a
    // LONG replay can keep fetching, read the CDN token the embed itself was handed: its form, its own `expires`
    // against the embed's, and whether the embed's last playlist and segment URLs still answer now, well after the
    // embed's expiry (with the iframe's Referer, as the player sends it, and with none).
    const tokenOf = (url: string | null) => {
      if (!url) return { form: "not seen" as const, expiresMinusEmbedExpires: null };
      const u = new URL(url);
      const form = u.pathname.includes("bcdn_token=") ? "path" : u.searchParams.has("token") ? "query" : "none";
      const m = /[&?]expires=(\d+)/.exec(u.pathname + u.search);
      return { form, expiresMinusEmbedExpires: m ? Number(m[1]) - expires : null };
    };
    const iframeReferer = `https://${EMBED_HOST}/`;
    embed.embedCdnToken = {
      playlist: tokenOf(seen.m3u8),
      segment: tokenOf(seen.ts),
      recheckSecondsAfterEmbedExpiry: nowSec() - expires,
      playlistNowWithIframeReferer: seen.m3u8 ? (await cdnGet(seen.m3u8, iframeReferer)).status : null,
      segmentNowWithIframeReferer: seen.ts ? (await cdnGet(seen.ts, iframeReferer)).status : null,
      segmentNowWithoutReferer: seen.ts ? (await cdnGet(seen.ts, null)).status : null,
    };
    embed.otherHosts = [...otherHosts].sort();
    const expiryAt = Math.round((expiresMs - loadedAt) / 1000);
    const atExpiry = samples.filter((s) => s.at <= expiryAt).pop();
    const lastSample = samples[samples.length - 1];
    const postExpiry: Record<string, number> = {};
    for (const n of net.filter((n) => n.at > expiresMs)) postExpiry[`${n.host}.${n.ext}:${n.status}`] = (postExpiry[`${n.host}.${n.ext}:${n.status}`] ?? 0) + 1;
    const preExpiry: Record<string, number> = {};
    for (const n of net.filter((n) => n.at <= expiresMs)) preExpiry[`${n.host}.${n.ext}:${n.status}`] = (preExpiry[`${n.host}.${n.ext}:${n.status}`] ?? 0) + 1;
    const reachedEnd = !!lastSample?.video && (!!lastSample.ended || (typeof lastSample.d === "number" && (lastSample.t ?? 0) >= lastSample.d - 0.5));
    Object.assign(embed, {
      kicked,
      expiresAtSecondsAfterLoad: expiryAt,
      atExpiry: atExpiry ? { at: atExpiry.at, t: atExpiry.t, buf: atExpiry.buf } : null,
      last: lastSample,
      reachedEnd,
      playedSecondsAfterExpiry: atExpiry && lastSample ? Math.round(((lastSample.t ?? 0) - (atExpiry.t ?? 0)) * 10) / 10 : null,
      wallSecondsAfterExpiry: lastSample ? lastSample.at - expiryAt : null,
      requestsBeforeExpiry: preExpiry,
      requestsAfterExpiry: postExpiry,
      samples: samples.filter((_, i) => i % 3 === 0 || i === samples.length - 1).map((s) => `${s.at}s:t=${s.t?.toFixed(1)}${s.paused ? ",paused" : ""}${s.ended ? ",ended" : ""}${s.err ? `,err${s.err}` : ""},buf=${s.buf?.toFixed(0)}`),
    });

    // ---- B11 (Task 30): the unit of watchTimeChart, read through the production adapter. Its fetch is fenced: one video's
    // statistics, GET only, on this library — anything else is refused before it leaves. The raw answers are kept in memory for
    // their numbers; no header, key or URL is recorded. ----
    const watch: Record<string, unknown> = {};
    obs.watchTime = watch;
    const rawCharts = new Map<string, unknown>();   // videoGuid -> the last watchTimeChart Bunny answered for it (absent: "absent")
    let fenceRefusals = 0;
    const statsOnly: typeof fetch = async (input, init) => {
      const u = new URL(String(input));
      const guid = u.searchParams.get("videoGuid") ?? "";
      if ((init?.method ?? "GET") !== "GET" || `${u.origin}${u.pathname}` !== `${API_BASE}/${libraryId}/statistics` || !new RegExp(`^${ID}$`).test(guid)) {
        fenceRefusals++;
        throw new Error("refused: B11 reads one video's statistics only");
      }
      const res = await fetch(input, init);
      const body = (await res.clone().json().catch(() => null)) as { watchTimeChart?: unknown } | null;
      rawCharts.set(guid, body && "watchTimeChart" in body ? body.watchTimeChart : "absent");
      return res;
    };
    const stats = new BunnyReplayHost({ libraryId, apiKey, readOnlyKey: "", cdnHost, tokenKey }, { fetchImpl: statsOnly });
    const chartSum = (chart: unknown) =>
      chart && typeof chart === "object" ? Object.values(chart).reduce<number>((n, v) => n + (typeof v === "number" ? v : 0), 0) : 0;
    const kindOf = (chart: unknown) =>
      chart === undefined ? "not read" : chart === null ? "null" : chart === "absent" ? "absent" : Array.isArray(chart) ? "list" : typeof chart;
    const control = embed.expiredControl as { played: boolean; sample: Sample | null };
    // What the players actually played: the main embed from 0 to its last position, plus the control's, if it played at all.
    const watchedSeconds = (lastSample?.t ?? 0) + (control.played ? control.sample?.t ?? 0 : 0);
    const statsFrom = new Date(fetchStarted - 86_400_000);   // a day's margin: the chart is bucketed by UTC day
    const statsUntil = Date.now() + WATCH_STATS_WAIT_MS;
    let minutes = 0;
    let polls = 0;
    let lastError: string | null = null;
    for (;;) {
      polls++;
      try {
        minutes = (await stats.watchMinutes(videoIds.long!, statsFrom, new Date())) ?? 0;   // null: the host holds no such video (Task 31)
        lastError = null;
      } catch (e) {
        lastError = redact((e as Error).message);
      }
      if (minutes > 0 || Date.now() > statsUntil) break;
      await sleep(WATCH_STATS_POLL_MS);
    }
    let hdMinutes: number | null = null;
    try { hdMinutes = await stats.watchMinutes(videoIds.hd!, statsFrom, new Date()); } catch (e) { watch.hdError = redact((e as Error).message); }
    const rawSum = chartSum(rawCharts.get(videoIds.long!));
    Object.assign(watch, {
      watchedSeconds: Math.round(watchedSeconds * 10) / 10,
      rawChartSum: rawSum,
      rawChartNonZeroPoints: kindOf(rawCharts.get(videoIds.long!)) === "object" ? Object.values(rawCharts.get(videoIds.long!) as object).filter((v) => v !== 0).length : 0,
      rawChartKind: kindOf(rawCharts.get(videoIds.long!)),
      adapterMinutes: minutes,
      impliedSecondsPerUnit: rawSum > 0 ? Math.round((watchedSeconds / rawSum) * 1000) / 1000 : null,
      assumedSecondsPerUnit: WATCH_TIME_CHART_SECONDS_PER_UNIT,
      hdControl: { minutes: hdMinutes, rawChartSum: chartSum(rawCharts.get(videoIds.hd!)), rawChartKind: kindOf(rawCharts.get(videoIds.hd!)) },
      polls, waitedSeconds: Math.round((Date.now() - (statsUntil - WATCH_STATS_WAIT_MS)) / 1000), lastError, fenceRefusals,
    });

    // ---- B10: delete answers 200, and the video then reads 404. The brief expected a second DELETE to answer 404;
    // run 1 (2026-11-21) measured 200 (Bunny's delete is idempotent), so absence is read with a GET, not a DELETE. ----
    for (const key of Object.keys(SOURCES) as SourceKey[]) {
      const id = videoIds[key]!;
      const check = await getVideo(id);
      if (check.status !== 200 || !isOwn(key, id, check.video)) {
        obs[`delete_${key}`] = { refusedRecheck: check.status };
        continue;
      }
      const first = await bunny("DELETE", `/videos/${id}`);
      if (first.ok) { deleted.add(id); ledger.deleted.push(`video ${id} (${first.status})`); }
      const second = await bunny("DELETE", `/videos/${id}`);
      const reread = await getVideo(id);
      obs[`delete_${key}`] = { first: first.status, second: second.status, getAfter: reread.status };
    }
    // B11, recorded only: what the statistics read answers for `long` once B10 has deleted it.
    try {
      watch.afterDelete = { minutes: await stats.watchMinutes(videoIds.long!, statsFrom, new Date()), rawChartKind: kindOf(rawCharts.get(videoIds.long!)) };
    } catch (e) {
      watch.afterDelete = { error: redact((e as Error).message) };
    }

    // Facts, each asserted softly so one red does not hide the others.
    expect.soft(collectionId, "B7 collection create answers a guid").toMatch(new RegExp(`^${ID}$`));
    for (const key of Object.keys(SOURCES) as SourceKey[]) {
      expect.soft(playable[key]!.collectionId, `B7 GET /videos/{id} (${key}) names the collection`).toBe(collectionId);
      const heights = heightsOf(playable[key]);
      expect.soft(heights.length, `B9 ${key} lists at least one resolution`).toBeGreaterThan(0);
      const m = obs[`mp4_${key}`] as { withAllowedReferer?: { status: number }; withoutReferer?: number };
      expect.soft(m.withAllowedReferer?.status, `B9 ${key}: play_{top}p.mp4 with an allowed Referer`).toBe(200);
      expect.soft(m.withoutReferer, `B9 ${key}: play_{top}p.mp4 with no Referer`).toBe(403);
      const d = obs[`delete_${key}`] as { first?: number; second?: number; getAfter?: number };
      expect.soft(d.first, `B10 ${key}: first DELETE`).toBe(200);
      expect.soft(d.getAfter, `B10 ${key}: GET after the delete`).toBe(404);
      expect.soft(d.second, `B10 ${key}: second DELETE (measured 200 in run 1; the brief expected 404)`).toBe(200);
    }
    const tok = embed.embedCdnToken as { segment: { form: string }; recheckSecondsAfterEmbedExpiry: number };
    expect.soft(tok.segment.form, "B8 the embed fetched at least one CDN segment").not.toBe("not seen");
    expect.soft(tok.recheckSecondsAfterEmbedExpiry, "B8 the token re-check ran well after the embed's expiry").toBeGreaterThan(90);
    expect.soft((embed.expiredControl as { played: boolean }).played, "B8 control: an expired embed token is refused").toBe(false);
    expect.soft(embed.frameFound, "B8 the embed frame loaded").toBe(true);
    expect.soft(reachedEnd, "B8 the embed played to its end").toBe(true);
    expect.soft(embed.wallSecondsAfterExpiry as number, "B8 the run watched well past the expiry").toBeGreaterThan(60);
    // B11 (Task 30): the adapter's minutes for `long` match the minutes the embed played, within a factor of 2 either way — a wrong
    // WATCH_TIME_CHART_SECONDS_PER_UNIT is off by 60 or 1000. OBSERVED.watchTime.impliedSecondsPerUnit is the measured unit.
    const ratio = minutes / (watchedSeconds / 60);
    expect.soft(Math.abs(Math.log2(ratio)) < 1, `B11 watchMinutes / minutes played = ${ratio} (WATCH_TIME_CHART_SECONDS_PER_UNIT = ${WATCH_TIME_CHART_SECONDS_PER_UNIT})`).toBe(true);
    expect.soft(hdMinutes, "B11 control: hd, never played in a player, reads 0 minutes (else videoGuid was not applied)").toBe(0);
  }, 45 * 60_000);

  // An OWNER LIBRARY SETTING, not code and not vendor behaviour (Task 48, owner 2026-11-24: 1080p stays ON; encoding is free, only
  // storage and delivery are billed — this supersedes Operator setup Phase 2's "capped at 720p"). Kept in its own test so a red here
  // is never mistaken for a vendor fact that moved. Only `hd` (a 1080p source) can witness it; `long` is a 720p source and cannot.
  it("library setting, not code (owner 2026-11-24): a 1080p source lists 1080", () => {
    const heights = heightsOf(playable.hd);
    expect(heights.length, "the hd video was read once encoded (the first test reached that step)").toBeGreaterThan(0);
    expect(Math.max(...heights), "B9 library setting: the 1080p source's highest listed resolution").toBe(1080);
  });
});
