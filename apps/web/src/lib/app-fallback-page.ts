// The "Open in app" fallback pages, `/app/stream`, `/app/score` and `/app/day` (spec 2026-11-25 §5.3). Seen only when the
// Android app did not take the link. THE URL FRAGMENT IS A LIVE CREDENTIAL, so this is bare HTML from a route handler —
// no layout, so no analytics and no app bundle — and it must stay that way:
//   * nothing is requested but the document: no external script, style, font or image — the logo and the condensed face
//     are inline `data:` URIs (app-fallback-assets.ts) — and an empty `data:` icon so the browser does not ask for
//     /favicon.ico;
//   * one inline script under the proxy's nonce, which drops the fragment WITHOUT READING IT, and on /app/score wires the
//     way back. It never builds a scoring URL;
//   * no cookie (proxy.ts skips its session hint under /app).
// `Referrer-Policy: no-referrer` is next.config.js's `/app/:path*` rule, which replaces the site-wide value; it is not
// set here too, so the header has one authority.
import { DISPLAY_500_DATA_URI, DISPLAY_700_DATA_URI, LOGO_DATA_URI } from "@/lib/app-fallback-assets";
import { PLAY_STORE_URL } from "@/lib/app-store";
import { getDictionary, t, toLocale } from "@/lib/i18n";

export type AppFallbackKind = "stream" | "score" | "day";

const BACK_ID = "back";

// The query goes with the fragment: replaceState is given the bare path. With nothing to go back to (an in-app browser, a
// typed address) the button is never unhidden.
const SCRIPT =
  `history.replaceState(null,"",location.pathname);` +
  `var b=document.getElementById("${BACK_ID}");` +
  `if(b&&history.length>1){b.addEventListener("click",function(){history.back()});b.hidden=false}`;

const face = (weight: number, uri: string) =>
  `@font-face{font-family:"sz-display";font-weight:${weight};font-display:swap;src:url(${uri}) format("woff2")}`;

// The approved look (owner, 2026-11-25). The house night theme's colours (globals.css `--mk-*`) are typed here because
// this page may not fetch a stylesheet. `sz-display` is a private name, so an installed copy of the face is not picked
// up in its place. `[hidden]` needs the !important: a class that sets `display` would otherwise show a hidden button.
const STYLE =
  face(500, DISPLAY_500_DATA_URI) +
  face(700, DISPLAY_700_DATA_URI) +
  `[hidden]{display:none!important}` +
  `*{box-sizing:border-box}` +
  `body{margin:0;background:#150b36;color:#f5f0e8;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;-webkit-font-smoothing:antialiased}` +
  `main{max-width:24rem;margin:0 auto;padding:28px 24px}` +
  `.brand{display:block;height:30px;width:auto;margin:0 auto 20px}` +
  `.box{padding:20px 16px;border:1.5px dashed #a3e635;border-radius:12px}` +
  `h1,.play{font-family:"sz-display","Arial Narrow",sans-serif;text-transform:uppercase}` +
  `h1{margin:0 0 16px;font-size:25px;font-weight:500;line-height:1.1;letter-spacing:.02em}` +
  `.play{display:block;min-height:44px;padding:12px;border-radius:8px;background:#a3e635;color:#150b36;font-size:16px;font-weight:700;line-height:20px;letter-spacing:.04em;text-decoration:none}` +
  `.retry{margin:12px 0 0;color:#c9bfee;font-size:13px}` +
  `.back{display:block;width:100%;min-height:44px;margin:8px 0 0;padding:8px;border:0;background:none;color:#f5f0e8;font:inherit;font-size:13.5px;font-weight:600;text-decoration:underline;cursor:pointer}` +
  `a:focus-visible,button:focus-visible{outline:3px solid #f5f0e8;outline-offset:2px}`;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
/** For text content and double-quoted attributes, the only two places a value lands below. */
const escape = (value: string) => value.replace(/[&<>"]/g, (c) => ENTITIES[c]!);

/** The fallback document for `kind`. The locale and the CSP nonce are the request headers proxy.ts sets. With no nonce
 *  the script carries none, so an enforced policy blocks it rather than running it under an invented one. */
export async function appFallbackResponse(kind: AppFallbackKind, request: Request): Promise<Response> {
  const locale = toLocale(request.headers.get("x-seazn-locale"));
  const nonce = request.headers.get("x-nonce");
  const dict = await getDictionary(locale, "ui");
  const copy = (key: string) => escape(t(dict, `openApp.fallback.${key}`));
  const title = copy("title");
  const back =
    kind === "score"
      ? `<button type="button" class="back" id="${BACK_ID}" data-testid="score-in-browser" hidden>${copy("scoreInBrowser")}</button>\n`
      : "";
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<main>
<img class="brand" src="${LOGO_DATA_URI}" alt="Seazn Club" width="130" height="30">
<div class="box">
<h1>${title}</h1>
<a class="play" data-testid="app-fallback-play" href="${PLAY_STORE_URL}" rel="noreferrer">${copy("play")}</a>
<p class="retry">${copy("retry")}</p>
</div>
${back}</main>
<script${nonce ? ` nonce="${escape(nonce)}"` : ""}>${SCRIPT}</script>
</body>
</html>
`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
