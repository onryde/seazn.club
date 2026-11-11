// Stand-ins for the title sponsor poster's two boundaries the e2e server cannot reach: the image optimiser and storage.
//
// CI builds against `NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co` (e2e.yml): a host that answers nothing. So a poster stored under
// it can never be fetched by the real `/_next/image` optimiser, and a content-upload grant would hand the browser a URL nobody listens
// on. Everything between those two edges is the product, left real: the sponsor API, the row, the public page, the click redirect.
//
//   `routePosterArt`   answers the browser's `/_next/image?url=<poster>` request with art, or with an error status;
//   `standInStorage`   answers the editor's content-upload grant, its PUT, and the later GET of what it stored;
//   `posterSvg` / `posterPng`   the art itself.
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";

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

/** A PNG of exactly `width` x `height`, flat `fill`: a screenshot of a bare page in a viewport of that size, so the editor's own
 *  `createImageBitmap` measures the real dimensions (a 1920 x 1080 picture must read as wider than 4:5). Flat colour keeps it far under
 *  the 2 MB cap. Its own context: nothing of the caller's session or routes touches it. */
export async function posterPng(browser: Browser, width: number, height: number, fill: string): Promise<Buffer> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${escapeXml(fill)}"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${escapeXml(fill)}"/></svg></body></html>`,
    );
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  } finally {
    await ctx.close();
  }
}

/** What the stand-in storage holds, by object path: the bytes a PUT carried. Module state on purpose: a later test in the same file
 *  (a fresh page) reads back what an earlier one stored, as real storage would keep it. */
const stored = new Map<string, { type: string; body: Buffer }>();
const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const UPLOAD_PREFIX = "/storage/v1/upload/sign/";
const PUBLIC_PREFIX = "/storage/v1/object/public/";

/** Storage, at the browser's boundary, for the sponsor editor's upload (`uploadLogo` in org-sponsors.tsx):
 *   POST /api/orgs/<orgId>/content-upload  -> a grant, `{ ok, data: { upload_url, public_url } }`, one fresh object path per call;
 *   PUT  <STUB>/storage/v1/upload/sign/**    -> 200, the bytes kept;
 *   GET  <STUB>/storage/v1/object/public/**  -> those bytes (404 for anything never PUT).
 *  `issued` lists each grant's PUBLIC url in the order given, so a test reads what the editor will save. The real server is never asked
 *  for a grant: it would sign a URL on the real bucket. */
export async function standInStorage(page: Page, orgId: string): Promise<{ issued: string[] }> {
  const issued: string[] = [];
  await page.route(
    (url) => url.pathname === `/api/orgs/${orgId}/content-upload`,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const asked = (route.request().postDataJSON() ?? {}) as { content_type?: string };
      const tail = `assets/orgs/${orgId}/content/${randomUUID()}.${EXTENSION[asked.content_type ?? ""] ?? "png"}`;
      issued.push(storagePublicUrl(tail));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { upload_url: `${STORAGE_STUB}${UPLOAD_PREFIX}${tail}`, public_url: storagePublicUrl(tail) } }),
      });
    },
  );
  await page.route(
    (url) => url.origin === STORAGE_STUB && url.pathname.startsWith(UPLOAD_PREFIX),
    async (route) => {
      const request = route.request();
      if (request.method() !== "PUT") return route.fallback();
      stored.set(new URL(request.url()).pathname.slice(UPLOAD_PREFIX.length), {
        type: request.headers()["content-type"] ?? "application/octet-stream",
        body: request.postDataBuffer() ?? Buffer.alloc(0),
      });
      // Cross-origin from the page: the browser reads the answer, so it must be allowed to.
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "" });
    },
  );
  await page.route(
    (url) => url.origin === STORAGE_STUB && url.pathname.startsWith(PUBLIC_PREFIX),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const object = stored.get(new URL(route.request().url()).pathname.slice(PUBLIC_PREFIX.length));
      return object === undefined
        ? route.fulfill({ status: 404, contentType: "text/plain", body: "not stored" })
        : route.fulfill({ status: 200, contentType: object.type, body: object.body });
    },
  );
  return { issued };
}
