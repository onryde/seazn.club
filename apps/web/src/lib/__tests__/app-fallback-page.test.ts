// Open in app (spec 2026-11-25 §5.3): the bare-HTML fallback pages `/app/stream`, `/app/score`, `/app/day`, seen only when
// the Android app did not take the link. The URL FRAGMENT IS A LIVE CREDENTIAL, so the page asks for nothing but its own
// document, runs one nonce'd script that drops the fragment without reading it, and sets no cookie. The sweep is over
// the three pages, not over sports: no sport reaches them. The browser half (served headers, requests, CSP, the cascade)
// is e2e/open-in-app.spec.ts's.
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
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const KINDS = ["stream", "score", "day"] as const;
type Kind = (typeof KINDS)[number];
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

        // Nothing is fetched but the document: no src at all, no CSS url(), and the only link elements are inline.
        expect(html, at).not.toMatch(/\ssrc=|url\(|@import|<img|<iframe/);
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
  const ROUTES: Record<Kind, (r: Request) => Promise<Response>> = { stream: streamGet, score: scoreGet, day: dayGet };

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
    for (const path of ["/app", ...KINDS.map((k) => `/app/${k}`)]) {
      const headers = await servedHeaders(path);
      expect(referrerKeys(headers), path).toEqual(["Referrer-Policy"]);
      expect(headers["Referrer-Policy"], path).toBe("no-referrer");
      expect(headers["X-Content-Type-Options"], path).toBe("nosniff");
      expect(headers["X-Frame-Options"], path).toBe("SAMEORIGIN");
      checked += 1;
    }
    expect(checked).toBe(4);
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
