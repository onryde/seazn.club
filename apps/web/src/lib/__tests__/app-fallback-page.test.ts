// Open in app (spec 2026-11-25 §5.3): the bare-HTML fallback pages `/app/stream`, `/app/score`, `/app/day`, seen only when
// the Android app did not take the link. The URL FRAGMENT IS A LIVE CREDENTIAL, so the page asks for nothing but its own
// document, runs one nonce'd script that drops the fragment without reading it, and sets no cookie. The sweep is over
// the three pages, not over sports: no sport reaches them. The browser half (served headers, requests, CSP, the cascade)
// is e2e/open-in-app.spec.ts's.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";
import { nextConfig } from "../../../next.config.js";
import { appFallbackResponse } from "@/lib/app-fallback-page";
import { PLAY_STORE_URL } from "@/lib/app-store";
import { proxy } from "@/proxy";
import { GET as dayGet } from "@/app/app/day/route";
import { GET as scoreGet } from "@/app/app/score/route";
import { GET as streamGet } from "@/app/app/stream/route";
import { GET as strayGet } from "@/app/app/[[...rest]]/route";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const KINDS = ["stream", "score", "day"] as const;
/** "stray": any other path under /app, answered by the catch-all route. */
type Kind = (typeof KINDS)[number] | "stray";
const DICTS: Record<string, Record<string, string>> = { en, es, fr, nl };
const LOCALES = Object.keys(DICTS);
const KEYS = ["openApp.fallback.title", "openApp.fallback.play", "openApp.fallback.retry", "openApp.fallback.scoreInBrowser"];
// Typed here from the task brief, never read from lib/app-store.
const PLAY = "https://play.google.com/store/apps/details?id=com.seazn.capture";
const ENGLISH = [
  "Seazn Club isn't on this phone yet",
  "Get it on Google Play",
  "Then come back and tap Open in app again",
  "Score in browser instead",
];
const NONCE = "bm9uY2UtMTIz";

const request = (kind: Kind, headers: Record<string, string> = {}) =>
  new Request(`https://seazn.club/app/${kind}`, { headers });
const render = async (kind: Kind, headers: Record<string, string> = {}) => {
  const res = await appFallbackResponse(kind, request(kind, headers));
  return { res, html: await res.text() };
};
/** Everything in `html` that would make the browser ask for something besides the document. A `data:` URI asks for
 *  nothing, so it is the one thing a `url(` or a loading attribute may hold. An attribute name may follow white space, a
 *  slash, or the quote that closed the value before it: the HTML parser takes all three. */
function outsideReferences(html: string): string[] {
  const targets = [
    ...html.matchAll(/\burl\(\s*["']?([^"')]*)/gi),
    ...html.matchAll(/[\s/"'](?:src|poster|data|background|action|formaction|xlink:href)\s*=\s*["']?([^"'\s>]*)/gi),
  ].map((m) => m[1]!);
  const loaders = html.match(/@import|image-set\(|[\s/"']srcset\s*=|<(?:iframe|object|embed|video|audio|source)\b|http-equiv/gi);
  return [...targets.filter((target) => !target.startsWith("data:")), ...(loaders ?? [])];
}

const scriptsOf = (html: string) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];

describe("copy", () => {
  it("the Play listing is the capture app's", () => expect(PLAY_STORE_URL).toBe(PLAY));

  it("English is the brief's, and fr/es/nl each carry their own four strings — counted", () => {
    expect(KEYS.map((k) => DICTS.en![k])).toEqual(ENGLISH);
    let checked = 0;
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      for (const key of KEYS) {
        expect(DICTS[locale]![key], `${locale} ${key}`).toBeTruthy();
        expect(DICTS[locale]![key], `${locale} ${key} is not left in English`).not.toBe(DICTS.en![key]);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });
});

describe("the outside-reference scan itself", () => {
  it("catches every way this page could fetch something, and lets data: through — counted", () => {
    const fetching = [
      "<style>a{background:url(https://x.test/a.png)}</style>",
      '<style>@font-face{src:url("/f.woff2")}</style>',
      "<style>a{background:url( 'b.png' )}</style>",
      '<img src="/brand/logo.png">',
      '<img alt="" src=//x.test/a.png>',
      // HTML also separates attributes with a slash, or with nothing after a closing quote.
      "<img/src=//x.test/a.png>",
      '<img alt=""src=//x.test/a.png>',
      '<img src="data:," srcset="/a.png 2x">',
      '<img src="data:,"srcset="/a.png 2x">',
      '<style>@import "a.css";</style>',
      '<style>a{background:image-set("a.png" 1x)}</style>',
      '<iframe></iframe>',
      '<object data="/a"></object>',
      '<meta http-equiv="refresh" content="0;url=/a">',
    ];
    let checked = 0;
    for (const html of fetching) {
      expect(outsideReferences(html), html).not.toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(14);
    expect(outsideReferences('<img src="data:image/png;base64,AA//"><style>a{src:url(data:font/woff2;base64,AA)}</style>')).toEqual([]);
    expect(outsideReferences('<style>a{src:url("data:font/woff2;base64,AA")}</style><b data-testid="x">')).toEqual([]);
  });
});

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

describe("the approved look's two inlined assets", () => {
  it("the logo is the brand file's own bytes as a data: URI, 30px high at its own aspect — counted", async () => {
    const file = readFileSync("public/brand/seazn-logo-night-tight.png");
    const { width, height } = pngSize(file);
    let checked = 0;
    for (const kind of KINDS) {
      for (const locale of LOCALES) {
        const at = `${kind}/${locale}`;
        const { html } = await render(kind, { "x-seazn-locale": locale });
        const images = html.match(/<img\b[^>]*>/g) ?? [];
        expect(images, at).toHaveLength(1);
        // Exactly one: the browser keeps the FIRST of a repeated attribute, so a second one could pass the check below
        // while the first is what gets fetched.
        expect(images[0]!.match(/[\s/"']src\s*=/gi), at).toHaveLength(1);
        const src = images[0]!.match(/\ssrc="data:image\/png;base64,([A-Za-z0-9+/=]+)"/)?.[1];
        expect(src, at).toBeTruthy();
        expect(Buffer.from(src!, "base64").equals(file), at).toBe(true);
        expect(images[0], at).toContain('alt="Seazn Club"');
        expect(images[0], at).toContain(`width="${Math.round((30 * width) / height)}" height="30"`);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });

  it("the condensed face is inlined woff2, one face per weight the heading and Play button ask for — counted", async () => {
    const { html } = await render("score");
    const faces = [...html.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]!);
    const weights: string[] = [];
    const payloads = new Set<string>();
    let family = "";
    for (const face of faces) {
      family = face.match(/font-family:"([^"]+)"/)![1]!;
      weights.push(face.match(/font-weight:(\d+)/)![1]!);
      const data = face.match(/src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\("woff2"\)/)![1]!;
      const font = Buffer.from(data, "base64");
      expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2");
      // The header's own total length: a truncated paste is not a font.
      expect(font.readUInt32BE(8)).toBe(font.length);
      payloads.add(data);
    }
    expect(faces).toHaveLength(2);
    expect(payloads.size).toBe(2);
    let checked = 0;
    for (const selector of ["h1", ".play"]) {
      // The rules that style `selector` alone or in a list, joined.
      const rules = [...html.matchAll(/(?<=\}|<style>)([^{}@]+)\{([^}]*)\}/g)]
        .filter((m) => m[1]!.split(",").includes(selector))
        .map((m) => m[2]!)
        .join(";");
      expect(rules, selector).toContain(`font-family:"${family}","Arial Narrow",sans-serif`);
      expect(weights, selector).toContain(rules.match(/font-weight:(\d+)/)?.[1]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

describe("the page, every kind in every locale", () => {
  it("is localized, self-contained, uncacheable, unindexable, cookie-free and carries exactly one nonce'd script — counted", async () => {
    let checked = 0;
    for (const kind of KINDS) {
      for (const locale of LOCALES) {
        const at = `${kind}/${locale}`;
        const { res, html } = await render(kind, { "x-seazn-locale": locale, "x-nonce": NONCE });
        expect(res.status, at).toBe(200);
        expect(res.headers.get("content-type"), at).toBe("text/html; charset=utf-8");
        expect(res.headers.get("cache-control"), at).toBe("no-store");
        expect(res.headers.get("x-robots-tag"), at).toBe("noindex");
        expect(res.headers.getSetCookie(), at).toEqual([]);
        // next.config.js owns it (below): a second copy here would be a second authority for one header.
        expect(res.headers.get("referrer-policy"), at).toBeNull();

        expect(html.startsWith("<!DOCTYPE html>"), at).toBe(true);
        expect(html, at).toContain(`<html lang="${locale}">`);
        expect(html, at).toContain(`>${DICTS[locale]!["openApp.fallback.title"]}</h1>`);
        expect(html, at).toContain(DICTS[locale]!["openApp.fallback.play"]);
        expect(html, at).toContain(DICTS[locale]!["openApp.fallback.retry"]);
        expect(html, at).toContain(`href="${PLAY}"`);

        // Nothing is fetched but the document: every url() and loading attribute holds a data: URI, the only absolute
        // URL anywhere is the Play listing, and the only hrefs are that and the empty icon.
        expect(outsideReferences(html), at).toEqual([]);
        expect(html.match(/https?:/gi), at).toEqual(["https:"]);
        const hrefs = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]!);
        expect(hrefs.sort(), at).toEqual(["data:,", PLAY]);

        const scripts = scriptsOf(html);
        expect(scripts, at).toHaveLength(1);
        expect(html.match(/<script/g), at).toHaveLength(1);
        expect(scripts[0]![1], at).toBe(` nonce="${NONCE}"`);
        expect(scripts[0]![2], at).not.toMatch(/hash|location\.href|\/score\//);
        // No inline handler: CSP's nonce does not cover one.
        expect(html, at).not.toMatch(/\son[a-z]+=/i);

        expect(html.includes('data-testid="score-in-browser"'), at).toBe(kind === "score");
        expect(html.includes(DICTS[locale]!["openApp.fallback.scoreInBrowser"]!), at).toBe(kind === "score");
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });

  it("no locale header, an unknown one and the pseudolocale all read English — counted", async () => {
    let checked = 0;
    for (const headers of [{}, { "x-seazn-locale": "de" }, { "x-seazn-locale": "en-XA" }, { "x-seazn-locale": "" }]) {
      const { html } = await render("stream", headers as Record<string, string>);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain(ENGLISH[0]);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("with no nonce header the script carries no nonce attribute (never an empty or invented one)", async () => {
    const [script] = scriptsOf((await render("score")).html);
    expect(script![1]).toBe("");
  });

  it("a nonce header cannot break out of its attribute", async () => {
    const { html } = await render("score", { "x-nonce": '"><script>alert(1)</script>' });
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

/** Runs the served script against a browser double. `location` answers `pathname` and THROWS for anything else, so a
 *  script that read the fragment (by any spelling) fails here, not just under the regex above. */
async function run(kind: Kind, historyLength: number) {
  const { html } = await render(kind, { "x-nonce": NONCE });
  const calls: unknown[][] = [];
  const history = {
    length: historyLength,
    replaceState: (...args: unknown[]) => calls.push(["replaceState", ...args]),
    back: () => calls.push(["back"]),
  };
  const location = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      if (prop === "pathname") return `/app/${kind}`;
      throw new Error(`the script read location.${String(prop)}`);
    },
  });
  const tag = html.match(/<button\b[^>]*\bdata-testid="score-in-browser"[^>]*>/)?.[0] ?? null;
  const id = tag?.match(/\bid="([^"]+)"/)?.[1] ?? null;
  const clicks: (() => void)[] = [];
  const button = tag
    ? { hidden: /\shidden[\s>]/.test(tag), addEventListener: (type: string, fn: () => void) => type === "click" && clicks.push(fn) }
    : null;
  const document = { getElementById: (wanted: string) => (wanted === id ? button : null) };
  new Function("history", "location", "document", scriptsOf(html)[0]![2]!)(history, location, document);
  return { calls, button, tap: () => clicks.forEach((fn) => fn()), listeners: clicks.length };
}

describe("the one inline script", () => {
  it("drops the fragment first, with the bare path, on every page — counted", async () => {
    let checked = 0;
    for (const kind of KINDS) {
      for (const length of [1, 3]) {
        const { calls } = await run(kind, length);
        expect(calls, `${kind} ${length}`).toEqual([["replaceState", null, "", `/app/${kind}`]]);
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  it("score with nothing to go back to: the link stays hidden and unwired", async () => {
    const { button, listeners } = await run("score", 1);
    expect(button!.hidden).toBe(true);
    expect(listeners).toBe(0);
  });

  it("score with history: the link is served hidden, unhidden by the script, and one tap goes back once", async () => {
    expect((await render("score")).html).toMatch(/<button\b[^>]*data-testid="score-in-browser"[^>]*\shidden>/);
    const { button, tap, calls } = await run("score", 2);
    expect(button!.hidden).toBe(false);
    tap();
    expect(calls.map((c) => c[0])).toEqual(["replaceState", "back"]);
  });
});

describe("the real producers: proxy, then each route", () => {
  const ROUTES: Record<(typeof KINDS)[number], (r: Request) => Promise<Response>> = { stream: streamGet, score: scoreGet, day: dayGet };

  it("the nonce the proxy puts in the CSP is the one on the script, and its negotiated locale is the page's — counted", async () => {
    let checked = 0;
    for (const kind of KINDS) {
      const through = proxy(
        new NextRequest(`http://localhost:3000/app/${kind}`, { headers: { "accept-language": "fr-FR,fr;q=0.9" } }),
      );
      const forwarded = new Headers();
      for (const name of ["x-nonce", "x-seazn-locale"]) {
        const value = through.headers.get(`x-middleware-request-${name}`);
        expect(value, `${kind}: the proxy forwards ${name}`).toBeTruthy();
        forwarded.set(name, value!);
      }
      const csp =
        through.headers.get("content-security-policy") ?? through.headers.get("content-security-policy-report-only");
      const nonce = csp?.match(/'nonce-([^']+)'/)?.[1];
      expect(nonce, kind).toBeTruthy();
      const html = await (await ROUTES[kind](request(kind, Object.fromEntries(forwarded)))).text();
      expect(scriptsOf(html)[0]![1], kind).toBe(` nonce="${nonce}"`);
      expect(html, kind).toContain(DICTS.fr!["openApp.fallback.title"]);
      expect(html.includes('data-testid="score-in-browser"'), `${kind}: each folder serves its own kind`).toBe(kind === "score");
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

// Every OTHER path under /app. Left to Next, each would be the not-found page inside the root layout, which loads
// analytics and a third-party tracking script while the fragment is still in the address.
const STRAY = ["/app", "/app/", "/app/other", "/app/other/", "/app/score/deeper", "/app/score/deeper/", "/app/a/b/c", "/app/day.json"];
const SLASHED = KINDS.map((k) => `/app/${k}/`);

describe("any other path under /app", () => {
  it("nothing under app/app/ renders through a layout: route handlers only, the three pages and one catch-all — counted", () => {
    const files = (readdirSync("src/app/app", { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
      .filter((e) => e.isFile())
      .map((e) => `${e.parentPath.split("src/app/app")[1]}/${e.name}`)
      .sort();
    expect(files).toEqual(["/[[...rest]]/route.ts", "/day/route.ts", "/score/route.ts", "/stream/route.ts"]);
  });

  it("the catch-all serves the same bare page, as a 404: localized, nonce'd, no outside reference, no way back — counted", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const res = await strayGet(
        new Request("https://seazn.club/app/other/deeper", { headers: { "x-seazn-locale": locale, "x-nonce": NONCE } }),
      );
      const html = await res.text();
      expect(res.status, locale).toBe(404);
      expect(res.headers.get("content-type"), locale).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control"), locale).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), locale).toBe("noindex");
      expect(res.headers.getSetCookie(), locale).toEqual([]);
      expect(html, locale).toContain(`<html lang="${locale}">`);
      expect(html, locale).toContain(`>${DICTS[locale]!["openApp.fallback.title"]}</h1>`);
      expect(outsideReferences(html), locale).toEqual([]);
      expect(html.match(/https?:/gi), locale).toEqual(["https:"]);
      expect(html.match(/<script/g), locale).toHaveLength(1);
      expect(scriptsOf(html)[0]![1], locale).toBe(` nonce="${NONCE}"`);
      expect(html, locale).not.toContain('data-testid="score-in-browser"');
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("the catch-all's script drops the fragment without reading it, and wires nothing", async () => {
    const { calls, button, listeners } = await run("stray", 3);
    expect(calls).toEqual([["replaceState", null, "", "/app/stray"]]);
    expect(button).toBeNull();
    expect(listeners).toBe(0);
  });

  it("on the games host too, no /app path is taken for a game's slug — counted", () => {
    const rewriteOf = (path: string, host: string) =>
      proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { "x-forwarded-host": host } })).headers.get(
        "x-middleware-rewrite",
      );
    // Premise: on that host a one-segment path IS rewritten into /games, which renders through the root layout.
    expect(rewriteOf("/chess-quest", "games.seazn.club")).toContain("/games/chess-quest");
    expect(rewriteOf("/apps", "games.seazn.club")).toContain("/games/apps");
    let checked = 0;
    for (const path of [...STRAY, ...SLASHED, ...KINDS.map((k) => `/app/${k}`)]) {
      expect(rewriteOf(path, "games.seazn.club"), path).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(14);
  });
});

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

/** The headers next.config serves `pathname` with, resolved the way Next does (see permissions-policy-headers.test.ts). */
async function servedHeaders(pathname: string): Promise<Record<string, string>> {
  const rules = await (nextConfig as { headers: () => Promise<HeaderRule[]> }).headers();
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (buildCustomRoute("header", rule).match(pathname) === false) continue;
    for (const h of rule.headers) headers[h.key] = h.value;
  }
  return headers;
}

describe("Referrer-Policy (next.config.js)", () => {
  const referrerKeys = (h: Record<string, string>) => Object.keys(h).filter((k) => k.toLowerCase() === "referrer-policy");

  it("/app/* sends no referrer — one header, replacing the catch-all's — and keeps the other security headers — counted", async () => {
    let checked = 0;
    for (const path of [...STRAY, ...SLASHED, ...KINDS.map((k) => `/app/${k}`)]) {
      const headers = await servedHeaders(path);
      expect(referrerKeys(headers), path).toEqual(["Referrer-Policy"]);
      expect(headers["Referrer-Policy"], path).toBe("no-referrer");
      expect(headers["X-Content-Type-Options"], path).toBe("nosniff");
      expect(headers["X-Frame-Options"], path).toBe("SAMEORIGIN");
      checked += 1;
    }
    expect(checked).toBe(14);
  });

  it("every other path keeps the site's policy, including ones that only look like /app — counted", async () => {
    const others = ["/", "/apps", "/application/score", "/o/app/c/cup", "/live/app/cup", "/score/dl_x", "/dashboard"];
    let checked = 0;
    for (const path of others) {
      expect((await servedHeaders(path))["Referrer-Policy"], path).toBe("strict-origin-when-cross-origin");
      checked += 1;
    }
    expect(checked).toBe(others.length);
  });
});
