import { NextRequest, NextResponse } from "next/server";
import { negotiateLocale } from "@/lib/i18n-negotiate";
import { hasLocale } from "@/lib/i18n-constants";
import { SESSION_HINT_COOKIE, SESSION_MAX_AGE_S, hasSessionHint } from "@/lib/session-hint";
import { RELAY_PHASE_PORT } from "@/lib/relay-phase";
import { isPublicHubPath } from "@/lib/routes";
import { isStagingOrigin } from "@/lib/robots-policy";
import { siteOrigin } from "@/lib/site-origin";
import { revshareEnabled } from "@/lib/revshare-shared";
import { streamPlaybackHost } from "@/server/relay/config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ISR/CDN-cacheable public surfaces (spec 2026-07-12 P5): nonce CSP forces
// dynamic rendering, so these trees stay Report-Only permanently — flipping
// CSP_MODE=enforce hardens the app surface without un-caching spectator pages.
// Cacheable trees: the public hub (`/live/…`, routes.publicHub) and /embed. A
// bare `/live` is the marketing wall (LIVE1 option A) and keeps the app's
// nonce CSP like every other marketing page. /r (registration-ref tree,
// /r/[ref]) is deliberately excluded because it is force-dynamic and processes
// self-withdraw tokens; excluding it from the carve-out costs no caching but
// keeps enforce active on a token-bearing page. The pre-LIVE1 `/shared/…` tree
// never reaches here: next.config.js's redirects run before the proxy.
const EMBED_TREE = /^\/embed(\/|$)/;

export function isCacheablePublicPath(pathname: string): boolean {
  return isPublicHubPath(pathname) || EMBED_TREE.test(pathname);
}

// Blog P2 Task 5 (owner ruling 2026-11-19: help and blog are cached at the edge together, with a fixed CSP). Both trees
// are prerendered (`dynamic = "error"` on every page, so a request-time read fails the build) and stored by Cloudflare,
// which hands one copy to every visitor. So a response here is the same for every visitor: no nonce (a page built
// ahead of any request carries none, and a cached nonce would be one request's, frozen), no Set-Cookie (it would be
// cached for everyone, and Cloudflare skips caching a response that sets one), and a policy that is byte-identical
// from one request to the next (cspHeader(null)). `/help` and `/blog` exactly, or a path under them; never `/helpdesk`,
// `/blogs` or `/help-centre`. Unlike the public hub's carve-out above, the mode follows CSP_MODE: the fixed policy is
// what a prebuilt page actually does, so enforcing it blocks nothing the page runs.
const STATIC_CONTENT_TREE = /^\/(help|blog)(\/|$)/;

export function isStaticContentPath(pathname: string): boolean {
  return STATIC_CONTENT_TREE.test(pathname);
}

/** revshare's tracking.js (app/layout.tsx) posts to its own API (`/api/tracking/click`, `/api/tracking/get-ip-hash`). */
const REVSHARE_ORIGIN = "https://www.revshare.so";

/** The external script origins the root layout loads on every page, as ` <origin>` script-src suffixes, for the fixed
 *  (nonce-free) policy, which has no 'strict-dynamic' to trust them through: revshare's tracking.js when it is on
 *  (app/layout.tsx), and PostHog's own origin, from which posthog-js loads its lazy extensions (instrumentation-client.ts;
 *  "" when events ride the same-origin /ingest rewrite). Both are fixed per deployment, so the header stays byte-stable. */
function rootLayoutScriptOrigins(): string {
  return `${revshareEnabled() ? ` ${REVSHARE_ORIGIN}` : ""}${posthogApiOrigin()}`;
}

/** The `/overlay` tree (`/overlay` or `/overlay/…`, never `/overlayx…`): the stream overlay a club adds to OBS, and the
 *  page the compositor renders (`host=compositor`). */
const OVERLAY_TREE = /^\/overlay(\/|$)/;

/** R2005 change 8 (compositor `_FINDINGS.md` F-009; coordinator decision 2026-10-16): the compositor's loopback phase
 *  endpoint (overlay templates spec §4.3), allowed in `connect-src` on the `/overlay` tree ONLY, as a ` <origin>`
 *  suffix. F-009 proved CEF 139 reaches it from a page with NO policy; without this, `CSP_MODE=enforce` would block
 *  every phase poll before it left the page and the hook would fall back to the heartbeat in silence. The OBS page
 *  carries the source too and never fetches it: the hook makes no request without `host=compositor`. Derived from
 *  `RELAY_PHASE_PORT`, never a second literal. */
function overlayLoopbackOrigin(pathname: string): string {
  return OVERLAY_TREE.test(pathname) ? ` http://127.0.0.1:${RELAY_PHASE_PORT}` : "";
}

/** Seazn-hosted video (Task 15): the Stream customer host the signed playback addresses are built on (`https://<host>/<token>/manifest/
 *  video.m3u8`, server/video/cf-playback.ts reads the SAME `streamPlaybackHost()`), as a ` https://<host>` suffix for the two
 *  directives the player's requests fall under; "" where there is none to name (a live deployment with no host signs nothing) or the
 *  setting is malformed (the signer refuses it by name; the policy must never be what takes every page down). */
function playbackOrigin(): string {
  try {
    const host = streamPlaybackHost();
    return host ? ` https://${host}` : "";
  } catch {
    return "";
  }
}

/** The PostHog first-party proxy origin (prod), as a ` <origin>` connect-src suffix; "" when events ride the same-origin /ingest rewrite. */
function posthogApiOrigin(): string {
  const host = process.env.NEXT_PUBLIC_POSTHOG_API_HOST;
  if (!host?.startsWith("https://")) return "";
  try {
    return ` ${new URL(host).origin}`;
  } catch {
    return "";
  }
}

/**
 * Build the Content-Security-Policy for a page request (doc 04 §5).
 *
 * With a nonce, script-src uses the per-request nonce + 'strict-dynamic'; Next.js reads the
 * enforcing CSP header and automatically stamps the nonce onto its framework
 * and page scripts, so no per-tag wiring is needed. connect-src allows Supabase
 * (realtime websockets) and Sentry ingest; img-src allows arbitrary https for
 * player/org avatars.
 *
 * Default is Content-Security-Policy-Report-Only so a missing directive can
 * never break the running app — set CSP_MODE=enforce (after verifying the
 * browser console on staging) to switch to blocking. Enforcing nonce CSP forces
 * dynamic rendering (no static/CDN caching), which is why it is opt-in.
 *
 * With `nonce` null (the static-content trees, isStaticContentPath), script-src is the fixed `'self' 'unsafe-inline'`
 * plus the root layout's external script origins: Next's documented policy for pages without nonces
 * (next/dist/docs/01-app/02-guides/content-security-policy.md, "Without Nonces"). Every other directive is the same.
 */
export function cspHeader(
  nonce: string | null,
  opts: { forceReportOnly?: boolean; pathname?: string } = {},
): { name: string; value: string } {
  const isDev = process.env.NODE_ENV === "development";
  const enforce = process.env.CSP_MODE === "enforce" && !opts.forceReportOnly;
  const value = [
    `default-src 'self'`,
    // Stripe.js is loaded from js.stripe.com for Embedded Checkout. Turnstile's api.js is loaded from challenges.cloudflare.com by
    // lib/turnstile-client.ts (a script this page's own nonced code appends, so 'strict-dynamic' already trusts it; the origin is the
    // declaration for a browser that ignores 'strict-dynamic').
    nonce === null
      ? `script-src 'self' 'unsafe-inline'${rootLayoutScriptOrigins()}${isDev ? " 'unsafe-eval'" : ""}`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind ships an external stylesheet; 'unsafe-inline' covers the small
    // inline styles Next injects. Styles are low-risk vs script injection.
    `style-src 'self' 'unsafe-inline'`,
    // The replay facade's thumbnail (YouTube Connect T16, owner ruling O4): `https:` already covers it today, and the explicit origin is
    // the declaration, so tightening `https:` later cannot silently break the facade.
    `img-src 'self' blob: data: https: https://i.ytimg.com`,
    `font-src 'self' data:`,
    // Stripe: api.stripe.com for tokenization; supabase + sentry as before.
    // RealtimeKit: the match room's camera tile joins from the browser; its
    // Core SDK talks to *.realtime.cloudflare.com, signalling over wss
    // (Cloudflare's RealtimeKit network allowlist; proxy-csp-realtimekit.test.ts).
    // R2005: the compositor's loopback phase channel, on `/overlay` only (overlayLoopbackOrigin).
    // The fixed policy (nonce null) also lets revshare's tracking.js reach its API when revshare is on.
    // Seazn-hosted video (Task 15): the match page's player fetches the signed HLS manifest and its segments from the Stream customer
    // host (hls.js: XHR/fetch, here), so it is named in connect-src and, below, in media-src (proxy-csp-seazn-video.test.ts).
    `connect-src 'self' https://api.stripe.com https://*.supabase.co wss://*.supabase.co https://*.realtime.cloudflare.com wss://*.realtime.cloudflare.com${playbackOrigin()} https://*.ingest.sentry.io https://*.sentry.io${posthogApiOrigin()}${overlayLoopbackOrigin(opts.pathname ?? "")}${nonce === null && revshareEnabled() ? ` ${REVSHARE_ORIGIN}` : ""}`,
    // Embedded Checkout renders inside a Stripe-hosted iframe; the Turnstile widget (components/turnstile-widget.tsx) is a challenges.cloudflare.com
    // iframe. The public match page's replay player (YouTube Connect T16) is YouTube's
    // privacy-enhanced embed, loaded only after a tap: `youtube-nocookie.com` and its www host, and no `youtube.com` origin.
    // Seazn-hosted video (Task 15): the <video> plays a MediaSource through a `blob:` URL (hls.js), or the signed manifest itself
    // (Safari's native HLS) from the Stream customer host. A directive of its own, so it restates 'self' (default-src covered media).
    `media-src 'self' blob:${playbackOrigin()}`,
    `frame-src 'self' https://js.stripe.com https://*.stripe.com https://hooks.stripe.com https://www.youtube-nocookie.com https://youtube-nocookie.com https://challenges.cloudflare.com`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
    // Only on the enforced policy: a browser ignores it in a report-only one and logs a console error saying so on
    // every page.
    ...(enforce ? [`upgrade-insecure-requests`] : []),
  ].join("; ");
  return {
    name: enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    value,
  };
}

/**
 * Bare hostname for the request: prefer X-Forwarded-Host (Fly.io / reverse
 * proxy; Next dev also sets it — WITH a port), fall back to Host. Ports are
 * stripped; URL parsing handles IPv6 hosts like "[::1]:3000" correctly.
 */
export function requestHostname(request: NextRequest): string {
  const rawHost =
    request.headers.get("x-forwarded-host")?.split(",")[0].trim() ??
    request.headers.get("host") ??
    request.nextUrl.hostname;
  try {
    return new URL(`http://${rawHost}`).hostname;
  } catch {
    return rawHost.split(":")[0];
  }
}

/**
 * games.* hosts serve the /games route tree: games.seazn.club/ is the games
 * listing, games.seazn.club/<slug> plays a game. Any `games.`-prefixed host
 * matches so staging (games.stg…) and local (games.localhost) work unchanged.
 * Returns the rewritten URL, or null when no rewrite applies.
 *
 * Only "/" and single-segment slug paths ("/chess-quest") rewrite — the games
 * tree has no deeper URLs. Everything else (API, /ingest PostHog proxy,
 * public files like /site.webmanifest or /brand/*, and /games itself — never
 * double-prefix) passes through untouched so shared assets keep working on
 * the subdomain.
 */
const GAMES_SLUG_PATH = /^\/[a-z0-9-]+$/;

export function gamesHostRewrite(request: NextRequest): URL | null {
  if (!requestHostname(request).startsWith("games.")) return null;
  const { pathname } = request.nextUrl;
  if (pathname !== "/" && !GAMES_SLUG_PATH.test(pathname)) return null;
  if (pathname === "/games") return null;
  const url = request.nextUrl.clone();
  url.pathname = pathname === "/" ? "/games" : `/games${pathname}`;
  return url;
}

/** Staging is the same app on another host. robots.txt (app/robots.ts) closes it, but a page already indexed
 *  stays indexed until it is served with noindex, so every staging response carries the header. */
export function proxy(request: NextRequest): NextResponse {
  const response = proxyCore(request);
  // The configured origin, not the Host/X-Forwarded-Host header: a client can send that header, and a forged
  // noindex on a cacheable prod page would be served to crawlers.
  if (isStagingOrigin(siteOrigin())) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

/**
 * CSRF protection: for every mutating API call, the Origin header must match
 * the app host. Browsers always send Origin on cross-origin requests, so a
 * mismatch means a third-party site is trying to trigger an action on behalf
 * of a logged-in user.
 *
 * Google OAuth callback is a GET — unaffected.
 * Same-origin fetch calls (from our own UI) always pass because their Origin
 * matches the host the app is running on.
 */
function proxyCore(request: NextRequest): NextResponse {
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (isApi) {
    if (
      !request.nextUrl.pathname.startsWith("/api/webhooks/") &&
      !SAFE_METHODS.has(request.method)
    ) {
      const origin = request.headers.get("origin");
      // Session cookies are SameSite=Lax — browsers won't attach them on
      // cross-origin mutations, so CSRF is already blocked at the cookie layer.
      // Only do an explicit host check when the browser sends Origin so we catch
      // any cross-origin request that somehow carries credentials.
      // Absent Origin (same-origin fetch in some browsers/curl) → allow through.
      if (origin) {
        const appHost = requestHostname(request);
        try {
          const originHostname = new URL(origin).hostname;
          if (originHostname !== appHost) {
            return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
          }
        } catch {
          return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
        }
      }
    }
    // API responses don't render HTML — no CSP needed.
    return NextResponse.next();
  }

  // Page requests: attach a per-request nonce + CSP — or, on the static-content trees, the fixed policy and no nonce.
  // On a games.* host, /help and /blog are game slugs (gamesHostRewrite serves /games/help), not the help or blog tree.
  const isGamesHost = requestHostname(request).startsWith("games.");
  const staticContent = !isGamesHost && isStaticContentPath(request.nextUrl.pathname);
  const cacheable = staticContent || isCacheablePublicPath(request.nextUrl.pathname);
  const nonce = staticContent ? null : Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = cspHeader(nonce, { forceReportOnly: cacheable && !staticContent, pathname: request.nextUrl.pathname });

  const requestHeaders = new Headers(request.headers);
  if (!cacheable && nonce !== null) {
    // Nonce request headers make Next stamp scripts per-request; cacheable
    // trees skip them so the HTML stays byte-stable for ISR/CDN.
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set(csp.name, csp.value);
  }

  // v5 i18n (spec §4): resolve the request locale once — explicit cookie pick,
  // else Accept-Language negotiation — and expose it via x-seazn-locale for
  // resolveLocale() to read. A request header only; it doesn't change cached
  // HTML unless a page actually reads it (marketing/public do; the shell does
  // not), so it's safe to set on cacheable trees too.
  const cookieLocale = request.cookies.get("seazn_locale")?.value;
  const locale =
    cookieLocale && hasLocale(cookieLocale)
      ? cookieLocale
      : negotiateLocale(request.headers.get("accept-language"));
  requestHeaders.set("x-seazn-locale", locale);

  // Marketing [lang] routing (spec §5): unprefixed marketing paths rewrite to
  // the locale resolved just above — the explicit cookie pick, else Accept-
  // Language (crawlers with no cookie/en get /en, so English stays canonical).
  // This is what makes the footer language switcher work on "/": it writes the
  // cookie and refreshes, and the rewrite then serves the matching prerender
  // without a visible redirect. Localized URLs like /fr/start are served
  // directly. Extend MARKETING_UNPREFIXED as more marketing pages move under
  // [lang].
  const MARKETING_UNPREFIXED = new Set(["/", "/start", "/pricing", "/live", "/affiliates", "/sports"]);
  // Marketing trees with sub-paths (e.g. /product/streaming, /sports/cricket) —
  // prefix match (the exact-match Set can't cover dynamic child routes).
  const MARKETING_PREFIXED = ["/product/", "/sports/"];
  const mp = request.nextUrl.pathname;
  // The games.* subdomain owns "/" (and single-segment slugs) for its own tree
  // via gamesHostRewrite below — the marketing [lang] rewrite must NOT claim
  // "/" first on that host, or games.seazn.club/ lands on the marketing home.
  if (
    !isGamesHost &&
    (MARKETING_UNPREFIXED.has(mp) || MARKETING_PREFIXED.some((pre) => mp.startsWith(pre)))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = mp === "/" ? `/${locale}` : `/${locale}${mp}`;
    const rewritten = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    rewritten.headers.set("Content-Language", locale);
    return rewritten;
  }

  const rewriteUrl = gamesHostRewrite(request);
  const response = rewriteUrl
    ? NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(csp.name, csp.value);
  // The static root layout serves `<html lang="en">` for every locale (app/layout.tsx), and script corrects it only
  // after load. A URL under /{locale} says which language the page is in, so the response says it too: a server-side
  // signal for a reader that runs no script, at no rendering cost.
  const prefix = mp.split("/")[1] ?? "";
  if (hasLocale(prefix)) response.headers.set("Content-Language", prefix);
  if (!cacheable) syncSessionHint(request, response);
  return response;
}

/** R2 (T16 fix round 1): keep the readable signed-in hint (lib/session-hint.ts) in step with the HttpOnly session, for
 *  a session minted before the hint existed or a hint an expired session left behind. App pages only — never on an
 *  ISR/CDN-cacheable tree, where a Set-Cookie would ride a shared response. Presence, not validity: the hint has no
 *  authority, and a stale one costs one refused request. */
function syncSessionHint(request: NextRequest, response: NextResponse): void {
  const session = request.cookies.has("seazn_session");
  const hint = hasSessionHint(request.headers.get("cookie") ?? "");
  if (session && !hint) {
    response.cookies.set(SESSION_HINT_COOKIE, "1", {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
    });
  } else if (!session && hint) {
    response.cookies.delete(SESSION_HINT_COOKIE);
  }
}

export const config = {
  // Run on API routes (CSRF) and all page routes (CSP), but skip Next's static
  // assets, image optimizer, and the favicon — they don't need either.
  //
  // TWO /api paths are left out: the capture record upload
  // (`/api/v1/capture/codes/{code}/records`, spec 2026-10-12 §5) and the
  // sponsor frame upload (`/api/internal/relay/sessions/{sid}/airings/{momentId}/frame`,
  // R4 S9). While proxy runs on a path Next buffers the whole request body —
  // up to `proxyClientMaxBodySize`, 10 MB — before the route's own cap (1 MB;
  // 256 KiB), rate limit and auth. Both routes are Bearer-only and cookie-less,
  // so the CSRF Origin check above guards nothing there
  // (src/__tests__/proxy-matcher.test.ts). Both entries carry the exclusions:
  // the second pattern matches /api paths too.
  // The values must be literals — Next reads them statically at build time.
  matcher: [
    "/api/((?!v1/capture/codes/[^/]+/records/?$|internal/relay/sessions/[^/]+/airings/[^/]+/frame/?$).*)",
    "/((?!_next/static|_next/image|favicon.ico|api/v1/capture/codes/[^/]+/records/?$|api/internal/relay/sessions/[^/]+/airings/[^/]+/frame/?$).*)",
  ],
};
