import "server-only";
import sharp from "sharp";

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
 * left the expensive half unwatched, since a 4 Mpx canvas is real work and a
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
 * A 2 MB file can still decode to a gigapixel canvas — a flat-colour 5000²
 * PNG is ~500 KB on the wire and 100 MB once it is RGBA in memory, and three
 * images are decoded in parallel per render on an unauthenticated public
 * route. So the byte cap is not the ceiling that matters; this is.
 *
 * Derived from what these surfaces actually draw, not chosen: nothing here
 * keeps more than `POSTER_IMAGE_MAX_EDGE` on the longest edge, and past twice
 * that edge no pixel of the input survives the downscale. 2048² is therefore
 * the last input size that is picture rather than allocation — ~17 MB RGBA
 * each, ~50 MB for a render's three, against 100/300 MB before.
 *
 * sharp checks this from the image HEADER (it throws "Input image exceeds
 * pixel limit" at `.metadata()` below), so an oversized canvas is refused
 * before anything is allocated for it.
 */
export const POSTER_IMAGE_MAX_PIXELS = (2 * POSTER_IMAGE_MAX_EDGE) ** 2;

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

    // Never rejects: an unwinnable race would otherwise leave a rejection
    // nobody is listening for, once the deadline has already answered.
    const decode = (async (): Promise<Buffer | null> => {
      try {
        const image = sharp(bytes, { limitInputPixels: POSTER_IMAGE_MAX_PIXELS });
        // The format the BYTES are, not the one the response called them. Also
        // where `limitInputPixels` fires: sharp reads the header here, so an
        // oversized canvas is refused before anything is allocated for it.
        const { format } = await image.metadata();
        if (format === undefined || !POSTER_IMAGE_FORMATS.has(format)) return null;
        return await image
          .resize({
            width: POSTER_IMAGE_MAX_EDGE,
            height: POSTER_IMAGE_MAX_EDGE,
            fit: "inside",
            withoutEnlargement: true,
          })
          // libvips' own watchdog. The race below bounds what the ROUTE waits
          // for; this is what stops an abandoned decode carrying on burning a
          // threadpool slot after we have already answered.
          .timeout({ seconds: Math.ceil(POSTER_IMAGE_TIMEOUT_MS / 1000) })
          .png()
          .toBuffer();
      } catch {
        return null;
      }
    })();

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
