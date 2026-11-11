// Stand-ins for the title sponsor poster's two boundaries the e2e server cannot reach: the image optimiser and storage.
//
// CI builds against `NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co` (e2e.yml): a host that answers nothing. So a poster stored under
// it can never be fetched by the real `/_next/image` optimiser. Everything else is the product, left real: the sponsor API, the row, the
// public page, the click redirect.
//
//   `routePosterArt`   answers the browser's `/_next/image?url=<poster>` request with art, or with an error status;
//   `posterSvg`        the art itself.
import type { BrowserContext, Page } from "@playwright/test";

/** The host CI's e2e build treats as storage (e2e.yml sets it; a local run falls back to the same stub). One origin, no trailing slash. */
export const STORAGE_STUB = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://stub.supabase.co").origin;

/** The public URL a stored object has under the stub (the shape Supabase serves, and the one `next.config.js` allows). */
export const storagePublicUrl = (tail: string): string => `${STORAGE_STUB}/storage/v1/object/public/${tail}`;

const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A 1080 x 1350 (4:5) poster: a flat fill and one line of text, the label. It carries a size of its own (`width`/`height`), so an
 *  `<img>` that loads it reports a `naturalWidth` of 1080: "the picture arrived" is a number a test can read. */
export function posterSvg(label: string, fill: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">` +
    `<rect width="1080" height="1350" fill="${escapeXml(fill)}"/>` +
    `<text x="540" y="675" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="96" fill="#ffffff">${escapeXml(label)}</text>` +
    `</svg>`
  );
}

/** Answer every `/_next/image` request for `posterUrl` (any width, any quality) with `answer`: the art, or a bare status. Matched on the
 *  `url` query value, decoded, so the one route serves the whole srcset. A later route for the same URL on the same target wins; use a
 *  fresh context to change the answer. */
export async function routePosterArt(
  target: Page | BrowserContext,
  posterUrl: string,
  answer: { svg: string } | { status: number },
): Promise<void> {
  await target.route(
    (url) => url.pathname === "/_next/image" && url.searchParams.get("url") === posterUrl,
    (route) =>
      "svg" in answer
        ? route.fulfill({ status: 200, contentType: "image/svg+xml", body: answer.svg })
        : route.fulfill({ status: answer.status, contentType: "text/plain", body: "poster stand-in: refused" }),
  );
}
