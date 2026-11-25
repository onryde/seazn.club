// The "Open in app" fallback pages, `/app/stream`, `/app/score` and `/app/day` (spec 2026-11-25 §5.3). Seen only when the
// Android app did not take the link. THE URL FRAGMENT IS A LIVE CREDENTIAL, so this is bare HTML from a route handler —
// no layout, so no analytics and no app bundle — and it must stay that way:
//   * nothing is requested but the document: no external script, style, font or image, and an empty `data:` icon so the
//     browser does not ask for /favicon.ico;
//   * one inline script under the proxy's nonce, which drops the fragment WITHOUT READING IT, and on /app/score wires the
//     way back. It never builds a scoring URL;
//   * no cookie (proxy.ts skips its session hint under /app).
// `Referrer-Policy: no-referrer` is next.config.js's `/app/:path*` rule, which replaces the site-wide value; it is not
// set here too, so the header has one authority.
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

// The house light theme's colours (globals.css), typed here because this page may not fetch a stylesheet.
// `[hidden]` needs the !important: a class that sets `display` would otherwise show a hidden button.
const STYLE =
  `[hidden]{display:none!important}` +
  `*{box-sizing:border-box}` +
  `body{margin:0;background:#fdfcf8;color:#1e1b2e;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}` +
  `main{max-width:24rem;margin:0 auto;padding:3rem 1.25rem}` +
  `.brand{margin:0 0 2.5rem;color:#7c3aed;font-size:1.125rem;font-weight:800;letter-spacing:-.01em}` +
  `h1{margin:0 0 1.5rem;color:#2e1065;font-size:1.5rem;line-height:1.25;text-wrap:balance}` +
  `.play{display:block;min-height:3rem;padding:.75rem 1rem;border-radius:.75rem;background:#7c3aed;color:#fff;font-weight:600;text-decoration:none}` +
  `.retry{margin:1rem 0 0;color:#6f6a7c;text-wrap:balance}` +
  `.back{display:block;width:100%;min-height:2.75rem;margin:2rem 0 0;padding:.5rem;border:0;background:none;color:#6931c9;font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}` +
  `a:focus-visible,button:focus-visible{outline:3px solid #2e1065;outline-offset:2px}`;

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
<p class="brand">Seazn Club</p>
<h1>${title}</h1>
<a class="play" data-testid="app-fallback-play" href="${PLAY_STORE_URL}" rel="noreferrer">${copy("play")}</a>
<p class="retry">${copy("retry")}</p>
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
