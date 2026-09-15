import "server-only";
import sharp from "sharp";
import { log } from "@/server/logger";

/**
 * The ONE fetcher behind every remote image the match share card and the
 * downloadable poster draw — team badges and the org logo.
 *
 * Why it exists. `ImageResponse` hands `<img src>` to satori, and satori
 * FETCHES it: server-side, from inside our own network, on a route any
 * anonymous visitor can hit by URL. So "draw this badge" was, unguarded,
 * "make this request": to any host including an internal one, with no
 * timeout, no size cap and no fallback.
 *
 * The badge is the live one. `entrants.badge_url` is organiser-typed free
 * text — `z.string().min(1).max(1000)` (`api-v1/schemas.ts:573`, `:618`), set
 * through `PATCH /entrants/{id}` — and `resolveEntrantBadge` keeps it verbatim
 * when it already looks like a URL.
 *
 * The org logo is guarded too, on a weaker premise, deliberately:
 * `resolveLogoUrl` falls back to `organizations.logo_url` (V106) — but no
 * write path in the app sets that column today (the org PATCH takes
 * `logo_storage_path` only), so in practice the logo is already a storage
 * URL. It goes through here anyway, because the fallback is live code and a
 * future writer for it would otherwise reopen this silently.
 *
 * What it does instead. Only the origin this app serves its OWN uploads from
 * is fetched at all — host AND port — over https, under one budget that covers
 * the decode as well as the request, with a byte cap and a pixel cap; the bytes
 * are re-encoded here and handed to satori as a `data:` URI. Anything else — a
 * different origin, a redirect, a wrong content type, bytes that turn out not
 * to BE that type, a slow or oversized or corrupt body — returns null, and the
 * tile falls back to the monogram that already renders for a side with no
 * badge. Never a throw, never a 500.
 *
 * `match-poster.tsx` then refuses anything that is not a `data:` URI, so the
 * guard cannot be reopened by a caller that forgets this module.
 */

/**
 * A slow host must not stall a share preview or a download — and neither must
 * a slow picture. This is the budget for the WHOLE operation: the fetch, the
 * body read, and the decode and re-encode after it. Bounding the fetch alone
 * left the expensive half unwatched, since a 50 MP canvas is real work and a
 * `sharp` pipeline takes no `AbortSignal`.
 */
export const POSTER_IMAGE_TIMEOUT_MS = 1500;

/** A crest is a few KB. Two megabytes is already generous; past it we stop
 *  reading rather than buffer whatever the sender feels like sending. */
export const POSTER_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The largest edge kept. The poster draws a badge at 260px and a logo at 96px
 * (`SCALE` in match-poster.tsx), so 1024 is already four times oversampled —
 * the drawn picture is unchanged, and the decoded buffer is bounded. Small
 * images are never enlarged, so an ordinary crest passes through untouched.
 */
export const POSTER_IMAGE_MAX_EDGE = 1024;

/**
 * A 2 MB file can still decode to a huge canvas — a flat-colour 8689×5792 PNG
 * is ~1 MB on the wire and 200 MB once it is RGBA — so the byte cap is not the
 * ceiling that matters for memory; this is. It is a ceiling that REFUSES: a
 * canvas past it is not downscaled, it falls back to the monogram. So it must
 * sit above every picture an organiser really uploads, and memory is bounded
 * another way as well (one decode at a time — `decodeQueue`, below).
 *
 * Chosen from real uploads, not from the size we draw. Entrant badges are
 * stored exactly as uploaded: a designer's 2560–4096px export, or a phone
 * photo at 4032×3024 (12 MP). The reference is the largest common camera
 * frame, a 50 MP-class full frame at 8688×5792 = 50,320,896 px; a 48 MP phone
 * frame (8064×6048 = 48,771,072) and a 24 MP one (6000×4000) sit under it. A
 * real photograph that large is far past the byte cap anyway, so in practice
 * this is what a well-compressing image — flat art, or a bomb — meets.
 *
 * What one decode at the ceiling holds, measured with sharp 0.34.5 (macOS
 * RSS): JPEG ~11 MB and WebP ~12 MB at one libvips thread (22 and 14 MB at
 * 12), because sharp shrinks both WHILE loading (libjpeg's 1/2–1/8 DCT
 * scaling, libwebp's scaled decode). PNG has no shrink-on-load and is streamed
 * at full width in per-thread regions, so its peak follows libvips' thread
 * count: ~72 MB at 1 thread, ~74 MB at 2, ~126 MB at 4, ~175 MB at 12.
 *
 * Nothing in the app sets that count, deliberately: `sharp.concurrency()` is
 * process-wide and would throttle `/_next/image` too. On node:26-alpine (musl)
 * sharp leaves libvips at the vCPU count, and Next's image optimizer halves it
 * on first use when it is above 1. So production (`fly.toml`,
 * `shared-cpu-1x`, 1 GB) runs 1 thread, ~72 MB; staging (`fly.stg.toml`,
 * `shared-cpu-4x`, 1 GB) runs 4, ~126 MB, and 2 (~74 MB) once `/_next/image`
 * has served a request. It fits in 1 GB either way. Inferred from those files
 * and sharp's own rule, not measured on Fly.
 *
 * sharp checks this from the image HEADER (it throws "Input image exceeds
 * pixel limit" at `.metadata()` below), so an oversized canvas is refused
 * before anything is allocated for it.
 */
export const POSTER_IMAGE_MAX_PIXELS = 8688 * 5792;

/**
 * GIF's own, lower ceiling. libvips holds a GIF as a WHOLE canvas however
 * small it is drawn — measured ~5 bytes a pixel, so 264 MB at the ceiling
 * above — and GIF is a screen format, not a camera one: the org content
 * uploader takes GIFs for prose images, and a typed `badge_url` can point at
 * one. So a 4K UHD frame, 3840×2160 = 8,294,400 px; a 9 MP GIF measured
 * ~65 MB at one libvips thread (production's count, above; not measured at
 * more).
 */
export const POSTER_IMAGE_MAX_GIF_PIXELS = 3840 * 2160;

/**
 * What we will draw. `image/svg+xml` is deliberately NOT here even though the
 * badge uploader accepts it: satori parses SVG itself and THROWS on one that
 * carries no `viewBox` ("Failed to parse SVG"), which on these routes is a 500
 * where a monogram would do, and an organiser-supplied SVG is arbitrary markup
 * we would otherwise be rasterising. An SVG badge falls back to the monogram
 * tile; converting it belongs at UPLOAD time, not at render time.
 */
export const POSTER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * The same four types as sharp NAMES them once it has sniffed the bytes, and
 * derived from the list above so the two gates cannot drift apart.
 *
 * Why a second gate at all: the content type is the organiser's to choose.
 * `setEntrantBadge` (`server/usecases/entrants.ts`) passes the client's
 * multipart `contentType` to storage verbatim, without reading a byte of the
 * file, and storage serves it back under that name. So `image/png` is a claim,
 * not a fact — while sharp decides the real format by sniffing, and will
 * cheerfully rasterise a raw SVG buffer (librsvg ships in its prebuilt
 * libvips). The type we refuse above has to be refused from the BYTES, or the
 * refusal is decorative for exactly the input it was written to exclude.
 */
const POSTER_IMAGE_FORMATS: ReadonlySet<string> = new Set(
  [...POSTER_IMAGE_TYPES].map((type) => type.slice("image/".length)),
);

/** `host:port` as this module compares it — the port left empty when it is the
 *  protocol's default, which is exactly how WHATWG `URL` reports it, so the two
 *  sides of the comparison are built the same way from the same parser. */
function hostPort(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port}`;
}

/**
 * The allow-list: the host AND port this app builds its own public asset URLs
 * from.
 *
 * Derived from the same environment variable `publicStorageUrl`
 * (`lib/storage-url.ts`) and `resolveLogoUrl` (`server/public-site/data.ts`)
 * build those URLs with, and the same one `next.config.js` already names in
 * `images.remotePatterns` — never a hardcoded host, so a project move cannot
 * leave a stale origin trusted here. Read per call, not at module load: the
 * value is environment, and a test that changes it must change this.
 *
 * The port is part of it because a different port is a different service. Our
 * storage URLs carry no port, so `https://<storage host>:9999/…` is something
 * else living on that name, and nothing we publish ever points at it. Both
 * sides come from the configured URL — no 443 is written down here, so a
 * deployment that really does serve uploads from a port keeps working.
 */
function allowedOrigins(): ReadonlySet<string> {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return new Set();
  try {
    return new Set([hostPort(new URL(configured))]);
  } catch {
    return new Set();
  }
}

/** Loopback, link-local, metadata services, anything named by address. Checked
 *  independently of the allow-list so a misconfigured or injected storage URL
 *  cannot turn the allow-list itself into a pointer at our own network. */
function isInternalHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  // WHATWG `URL` keeps an IPv6 literal bracketed, which no real hostname is.
  if (hostname.startsWith("[")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The URL we are willing to request, or null. Pure — no I/O — so the refusals
 * are assertable one at a time.
 */
export function allowedPosterImageUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase();
  if (isInternalHost(hostname)) return null;
  if (!allowedOrigins().has(hostPort(url))) return null;
  return url;
}

/**
 * Rejects the moment the shared deadline fires. Raced against work that cannot
 * be handed an `AbortSignal` — a sharp decode — it puts that work under the
 * same clock as the fetch that preceded it, so the budget below means the
 * WHOLE operation and not just its network half.
 */
function deadline(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
}

/**
 * The tail of the decode queue: every decode waits for the one before it.
 *
 * Memory, not speed. A PNG gets no shrink-on-load — sharp streams it at FULL
 * input width — so what one decode holds grows with the canvas, and the match
 * poster draws three images at once. Decoded in parallel their peaks add;
 * decoded one at a time, share images hold one decode's worth between them,
 * for a single render and across concurrent renders alike. That is one
 * SHARE-IMAGE decode at a time, not one sharp decode for the whole process:
 * Next's `/_next/image` optimizer runs sharp in this same process, outside
 * this queue (`next/image` in the org layout and the sponsors board), so a
 * cold optimizer request that lands on a poster render adds its peak to this
 * one. It costs no throughput in production, which is one shared vCPU
 * (`fly.toml`, `shared-cpu-1x`); staging's four (`fly.stg.toml`,
 * `shared-cpu-4x`) give up parallel decodes for the same bound.
 *
 * Measured at the ceilings above (sharp 0.34.5, one libvips thread, which is
 * production's count): a render drawing three PNGs at `POSTER_IMAGE_MAX_PIXELS`
 * peaks ~73 MB one at a time — the same as one alone — against ~216 MB in
 * parallel. At staging's 4 threads one alone is ~126 MB; the per-thread figures
 * are at `POSTER_IMAGE_MAX_PIXELS`. Either fits in 1 GB.
 */
let decodeQueue: Promise<unknown> = Promise.resolve();

/**
 * sharp's own watchdog on a decode, in the whole seconds it takes, from the
 * same budget. It is also the grace the valve allows past that budget, so the
 * two cannot drift apart.
 */
const SHARP_TIMEOUT_SECONDS = Math.ceil(POSTER_IMAGE_TIMEOUT_MS / 1000);

/** How long a decode may hold the slot before it is taken to be hung: its
 *  caller's whole budget, and sharp's watchdog on top of that. */
const DECODE_HUNG_MS = POSTER_IMAGE_TIMEOUT_MS + SHARP_TIMEOUT_SECONDS * 1000;

/**
 * The escape valve. The queue frees its slot when a decode settles, and
 * sharp's `.timeout()` is what makes a slow one settle — but that timeout is
 * on the output pipeline only, and its clock cannot fire on work libvips never
 * schedules. A decode that never settled would hold the slot for the life of
 * the process, and every later share image on that machine would fall back to
 * the monogram, silently. So a decode still running `DECODE_HUNG_MS` after it
 * took the slot is given up, with one warning. In that pathological case two
 * decodes can overlap briefly; everywhere else the memory bound holds.
 *
 * Armed when the decode STARTS: a waiter whose budget ran out never starts,
 * settles at once, and needs no valve.
 */
function unlessHung(decode: Promise<Buffer | null>): Promise<Buffer | null> {
  let valve: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<null>((resolve) => {
    valve = setTimeout(() => {
      log.warn({ heldMs: DECODE_HUNG_MS }, "poster-image: a share-image decode never settled; releasing its slot");
      resolve(null);
    }, DECODE_HUNG_MS);
  });
  return Promise.race([decode, hung]).finally(() => clearTimeout(valve));
}

/**
 * Runs `work` once every earlier decode has FINISHED — not merely been
 * abandoned by its caller, since an abandoned decode still holds its memory
 * until libvips lets go — or has been given up as hung (`unlessHung`). The
 * wait is spent from the caller's own budget, and a caller whose budget ran
 * out while it waited never starts: nobody is left to draw what it would
 * allocate.
 *
 * `work` must never reject. A rejection would sit in the queue and fail every
 * share-image decode queued after it, on that machine, until a restart.
 */
/**
 * The ceiling under the queue. Its valve, and the header read's own deadline,
 * free the SLOT, not the work: a decode given up as hung, or a header read
 * abandoned at its caller's deadline, is still running in libvips. Freed
 * without a ceiling, the slot would admit one more stuck operation every time —
 * one per request for a header read that hangs — until the threadpool was gone.
 * So at most this many sharp operations (header reads and pipelines, released
 * or not) are unsettled at once, and a call that would start another is
 * answered with the monogram. Under a real libvips hang, share images fall back
 * until a stuck operation settles or the process restarts.
 */
const MAX_UNSETTLED_SHARP_OPS = 2;
let unsettledSharpOps = 0;
/** Set by the first refusal at the cap and cleared when an operation settles
 *  below it, so an episode at the cap warns once, not once per refused call. */
let refusingAtCap = false;

/** Whether a call may start sharp work now. Warns on the first refusal of an episode. */
function sharpHasRoom(): boolean {
  if (unsettledSharpOps < MAX_UNSETTLED_SHARP_OPS) return true;
  if (!refusingAtCap) {
    refusingAtCap = true;
    log.warn(
      { unsettled: unsettledSharpOps, cap: MAX_UNSETTLED_SHARP_OPS },
      "poster-image: sharp operations still unsettled at the cap; share images fall back to the monogram until one settles",
    );
  }
  return false;
}

/** Counts a sharp operation as unsettled until it settles, however its caller stopped waiting for it. */
function counted<T>(op: Promise<T>): Promise<T> {
  unsettledSharpOps += 1;
  const settled = (): void => {
    unsettledSharpOps -= 1;
    if (unsettledSharpOps < MAX_UNSETTLED_SHARP_OPS) refusingAtCap = false;
  };
  // Both handlers, not `finally`: that would pass a rejection on to a promise nobody holds.
  void op.then(settled, settled);
  return op;
}

function afterEarlierDecodes(signal: AbortSignal, work: () => Promise<Buffer | null>): Promise<Buffer | null> {
  const turn = decodeQueue.then(() => (signal.aborted ? null : unlessHung(work())));
  // The tail keeps the turn's outcome but not its value: the PNG goes to the
  // caller, and is not held here until whenever the next decode arrives.
  decodeQueue = turn.then(() => undefined);
  return turn;
}

/** Drain a body we are not going to use, so the connection is not left open. */
function discard(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

/** Read at most the cap, then stop. Null if the body runs past it. */
async function readCapped(res: Response): Promise<Buffer | null> {
  if (res.body === null) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > POSTER_IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return total === 0 ? null : Buffer.concat(chunks);
}

/**
 * An allow-listed remote image as a `data:image/png` URI, or null.
 *
 * Re-encoded rather than forwarded, for two reasons measured through a real
 * `ImageResponse`: satori renders remote WEBP as an empty box — and the app's
 * own `orgLogoPath` / `divisionLogoPath` both end `.webp`, so today's uploaded
 * logos draw as nothing — and it THROWS on bytes that do not match their
 * content type ("Invalid JPEG"), which is a 500 on a public route. Decoding
 * here means a bad image fails to a monogram instead of to an error page.
 */
export async function posterImageDataUrl(raw: string | null | undefined): Promise<string | null> {
  const url = allowedPosterImageUrl(raw);
  if (url === null) return null;
  // Over the cap, answer now: no fetch, no wait for the slot, no sharp.
  if (!sharpHasRoom()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POSTER_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // A redirect is a second destination nobody checked. Refuse rather than
      // follow: `manual` surfaces the 3xx as a non-ok response below.
      redirect: "manual",
      headers: { accept: [...POSTER_IMAGE_TYPES].join(",") },
    });
    if (!res.ok) {
      discard(res);
      return null;
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!POSTER_IMAGE_TYPES.has(contentType)) {
      discard(res);
      return null;
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > POSTER_IMAGE_MAX_BYTES) {
      discard(res);
      return null;
    }
    const bytes = await readCapped(res);
    if (bytes === null) return null;

    // Never rejects: an unwinnable race would otherwise leave a rejection
    // nobody is listening for, once the deadline has already answered — and
    // the decode queue relies on it (see `afterEarlierDecodes`).
    const decode = afterEarlierDecodes(controller.signal, async (): Promise<Buffer | null> => {
      // Again at the turn: the cap can fill while a call waits for the slot.
      // Nothing further is needed before the pipeline, since the header read
      // it follows has settled and no other sharp work starts outside the slot.
      if (!sharpHasRoom()) return null;
      try {
        const image = sharp(bytes, { limitInputPixels: POSTER_IMAGE_MAX_PIXELS });
        // The format the BYTES are, not the one the response called them. Also
        // where `limitInputPixels` fires: sharp reads the header here, so an
        // oversized canvas is refused before anything is allocated for it.
        //
        // Raced against the call's own deadline: sharp's timeout below is on
        // the output pipeline only, `metadata()` has none, and a header read
        // that never settled would hold the slot until the valve. It allocates
        // no canvas, so abandoning one keeps the memory bound.
        const { format, width, height } = await Promise.race([counted(image.metadata()), deadline(controller.signal)]);
        if (format === undefined || !POSTER_IMAGE_FORMATS.has(format)) return null;
        // Also from the header: GIF is held whole, so it has a ceiling of its own.
        if (format === "gif" && width * height > POSTER_IMAGE_MAX_GIF_PIXELS) return null;
        return await counted(
          image
            .resize({
              width: POSTER_IMAGE_MAX_EDGE,
              height: POSTER_IMAGE_MAX_EDGE,
              fit: "inside",
              withoutEnlargement: true,
            })
            // libvips' own watchdog. The race below bounds what the ROUTE waits
            // for; this is what stops an abandoned decode carrying on burning a
            // threadpool slot after we have already answered.
            .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
            .png()
            .toBuffer(),
        );
      } catch {
        return null;
      }
    });

    const png = await Promise.race([decode, deadline(controller.signal)]);
    if (png === null) return null;
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // A timeout, a socket error, bytes sharp cannot decode: all one answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
