import "server-only";
import sharp from "sharp";

/**
 * The ONE fetcher behind every remote image the match share card and the
 * downloadable poster draw — team badges and the org logo.
 *
 * Why it exists. `ImageResponse` hands `<img src>` to satori, and satori
 * FETCHES it: server-side, from inside our own network, on a route any
 * anonymous visitor can hit by URL. The values reaching those `src` props are
 * organiser-typed free text — `entrants.badge_url` and `orgs.logo_url` are
 * `z.string().min(1).max(1000)` in `api-v1/schemas.ts`, kept verbatim by
 * `resolveEntrantBadge` / `resolveLogoUrl` when they already look like a URL.
 * So "draw this badge" was, unguarded, "make this request": to any host
 * including an internal one, with no timeout, no size cap and no fallback.
 *
 * What it does instead. Only the host this app serves its OWN uploads from is
 * fetched at all, over https, with a hard timeout and a byte cap; the bytes are
 * re-encoded here and handed to satori as a `data:` URI. Anything else — a
 * different host, a redirect, a wrong content type, a slow or oversized or
 * corrupt body — returns null, and the tile falls back to the monogram that
 * already renders for a side with no badge. Never a throw, never a 500.
 *
 * `match-poster.tsx` then refuses anything that is not a `data:` URI, so the
 * guard cannot be reopened by a caller that forgets this module.
 */

/** A slow host must not stall a share preview or a download. */
export const POSTER_IMAGE_TIMEOUT_MS = 1500;

/** A crest is a few KB. Two megabytes is already generous; past it we stop
 *  reading rather than buffer whatever the sender feels like sending. */
export const POSTER_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** A 2 MB file can still decode to a gigapixel canvas. Cap the decode too. */
export const POSTER_IMAGE_MAX_PIXELS = 25_000_000;

/**
 * The largest edge kept. The poster draws a badge at 260px and a logo at 96px
 * (`SCALE` in match-poster.tsx), so 1024 is already four times oversampled —
 * the drawn picture is unchanged, and the decoded buffer is bounded. Small
 * images are never enlarged, so an ordinary crest passes through untouched.
 */
export const POSTER_IMAGE_MAX_EDGE = 1024;

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
 * The allow-list: the host this app builds its own public asset URLs from.
 *
 * Derived from the same environment variable `publicStorageUrl`
 * (`lib/storage-url.ts`) and `resolveLogoUrl` (`server/public-site/data.ts`)
 * build those URLs with, and the same one `next.config.js` already names in
 * `images.remotePatterns` — never a hardcoded host, so a project move cannot
 * leave a stale origin trusted here. Read per call, not at module load: the
 * value is environment, and a test that changes it must change this.
 */
function allowedHosts(): ReadonlySet<string> {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return new Set();
  try {
    return new Set([new URL(configured).hostname.toLowerCase()]);
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
  if (!allowedHosts().has(hostname)) return null;
  return url;
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

    const png = await sharp(bytes, { limitInputPixels: POSTER_IMAGE_MAX_PIXELS })
      .resize({
        width: POSTER_IMAGE_MAX_EDGE,
        height: POSTER_IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // A timeout, a socket error, bytes sharp cannot decode: all one answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
