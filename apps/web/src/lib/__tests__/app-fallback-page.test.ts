// Open in app (spec 2026-11-25 §5.3): the bare-HTML fallback pages `/app/stream`, `/app/score`, `/app/day`, seen only when
// the Android app did not take the link. The URL FRAGMENT IS A LIVE CREDENTIAL, so the page asks for nothing but its own
// document, runs one nonce'd script that drops the fragment, and sets no cookie. On /app/score alone that script first
// keeps a device-link token in its closure, for the one tap that opens the remote pad (owner, 2026-11-26); the other
// pages never read the fragment. The served script is RUN below in a bare realm where any access it was not given throws.
// The sweep is over the three pages, not over sports: no sport reaches them. The browser half (served headers, requests,
// CSP, the cascade, the real pad) is e2e/open-in-app.spec.ts's.
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";
import { nextConfig } from "../../../next.config.js";
import { appFallbackResponse } from "@/lib/app-fallback-page";
import { PLAY_STORE_URL } from "@/lib/app-store";
import { captureQrV2Text } from "@/lib/capture-qr";
import { dayAppLink, scoreAppLink, streamAppLink } from "@/lib/open-in-app";
import { mintDeviceLinkSecret } from "@/server/usecases/device-links";
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
  "Seazn Club Mobile App isn't on this phone yet",
  "Get it on Google Play",
  "Then come back and tap Open in app again",
  "Score in browser instead",
];
const NONCE = "bm9uY2UtMTIz";
/** What no fallback page's script may name, the scoring page's included: every other way a held credential could leave
 *  the closure (a request, storage, history state, the DOM, a message, a log). */
const LEAKY =
  /location\.href|\.href\b|\.src\b|localStorage|sessionStorage|indexedDB|cookie|fetch|XMLHttpRequest|sendBeacon|WebSocket|Image|innerHTML|outerHTML|textContent|innerText|setAttribute|createElement|dataset|console|postMessage|pushState|window|globalThis|navigator|eval|Function\(/;

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
        expect(scripts[0]![2], at).not.toMatch(LEAKY);
        // Only the scoring page reads the fragment or knows the pad's address.
        if (kind === "score") {
          expect(scripts[0]![2], at).toMatch(/location\.hash/);
          expect(scripts[0]![2], at).toContain('"/score/"');
        } else {
          expect(scripts[0]![2], at).not.toMatch(/hash|\/score\//);
        }
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

/** An object that answers only the members given: any other read, and any write that is not allowed, throws. */
function only(name: string, members: Record<string, () => unknown>, writable: Record<string, (v: unknown) => void> = {}) {
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      const member = members[String(prop)];
      if (member) return member();
      throw new Error(`the script read ${name}.${String(prop)}`);
    },
    set: (_t, prop, value) => {
      const write = writable[String(prop)];
      if (!write) throw new Error(`the script wrote ${name}.${String(prop)}`);
      write(value);
      return true;
    },
    defineProperty: (_t, prop) => {
      throw new Error(`the script defined ${name}.${String(prop)}`);
    },
  });
}

/** Runs the served script in a realm of its own, which holds `history`, `location` and `document` and nothing else of a
 *  browser: `window`, `fetch`, storage and the rest do not exist there, so naming one throws. As in a browser, the hash
 *  reads empty once `replaceState` has been given the bare path. Only the scoring page may read it, and only it may
 *  navigate, by `location.replace`. `globals` is what the script left behind in the realm. */
async function run(kind: Kind, hash = "") {
  const { html } = await render(kind, { "x-nonce": NONCE });
  const calls: unknown[][] = [];
  let live = hash;
  const history = only("history", {
    replaceState: () => (...args: unknown[]) => {
      calls.push(["replaceState", ...args]);
      live = "";
    },
  });
  const score = kind === "score";
  const location = only("location", {
    pathname: () => `/app/${kind}`,
    ...(score
      ? { hash: () => live, replace: () => (url: unknown) => void calls.push(["replace", url]) }
      : {}),
  });
  const tag = html.match(/<button\b[^>]*\bdata-testid="score-in-browser"[^>]*>/)?.[0] ?? null;
  const id = tag?.match(/\bid="([^"]+)"/)?.[1] ?? null;
  const clicks: (() => void)[] = [];
  const state = { hidden: tag !== null && /\shidden[\s>]/.test(tag) };
  const button = tag
    ? only(
        "button",
        {
          hidden: () => state.hidden,
          addEventListener: () => (type: string, fn: () => void) => {
            expect(type).toBe("click");
            clicks.push(fn);
          },
        },
        { hidden: (value) => void (state.hidden = value as boolean) },
      )
    : null;
  const document = only("document", { getElementById: () => (wanted: string) => (wanted === id ? button : null) });
  const realm: Record<string, unknown> = { history, location, document };
  runInNewContext(scriptsOf(html)[0]![2]!, realm);
  return {
    calls,
    hasButton: button !== null,
    state,
    tap: () => clicks.forEach((fn) => fn()),
    listeners: clicks.length,
    globals: Object.keys(realm),
  };
}

const ORIGIN = "https://seazn.club";
/** A token from the one thing that mints them, and the fragment the real link builder puts it in. */
const minted = () => mintDeviceLinkSecret();
const hashOf = (link: string) => new URL(link).hash;

/** Every fragment that is not exactly one device-link token. The look-alikes are built from a real token, so each differs
 *  from an accepted one by the thing its name says and nothing else. */
function refusedFragments(): [string, string][] {
  const token = minted();
  const body = token.slice(3);
  const qr = captureQrV2Text({ v: 2, code: "0123456789ab", slot: 0, tok: "A".repeat(22) });
  const day = `md_${body}`;
  return [
    ["none", ""],
    ["a lone #", "#"],
    ["junk percents", "#%%%"],
    ["the prefix alone", "#dl_"],
    ["one character short", `#${token.slice(0, -1)}`],
    ["one character long", `#${token}a`],
    ["an encoded first letter", `#%64l_${body}`],
    ["the real Match Day link", hashOf(dayAppLink(ORIGIN, `${ORIGIN}/day/${day}`)!)],
    ["the real stream link", hashOf(streamAppLink(ORIGIN, qr))],
    ["a quick match home token", `#qm_${body}`],
    ["another prefix", `#xl_${body}`],
    ["an upper-case prefix", `#DL_${body}`],
    ["no prefix", `#${body}`],
    ["traversal of a token's own length", `#dl_${"../".repeat(14)}a`],
    ["traversal after the token", `#${token}/../../dashboard`],
    ["traversal before it", `#../${token}`],
    ["a trailing slash", `#${token}/`],
    ["an extra segment", `#${token}/events`],
    ["a query", `#${token}?next=//evil.test`],
    ["a parameter", `#${token}&x=1`],
    ["a second fragment", `#${token}#x`],
    ["a doubled #", `##${token}`],
    ["the token twice", `#${token}${token}`],
    ["an encoded underscore", `#dl%5F${body}`],
    ["an encoded slash inside", `#dl_${body.slice(0, -3)}%2F`],
    ["an encoded trailing slash", `#${token}%2F`],
    ["a trailing space", `#${token}%20`],
    ["a raw trailing newline", `#${token}\n`],
    ["a raw leading space", `# ${token}`],
    ["standard base64's + and /", `#dl_${body.slice(0, -2)}+/`],
    ["padding", `#dl_${body.slice(0, -1)}=`],
    ["a dot", `#dl_${body.slice(0, -1)}.`],
    ["a backslash", `#dl_${body.slice(0, -1)}\\`],
    ["a non-ASCII letter", `#dl_${body.slice(0, -1)}é`],
    ["a path to the pad", `#/score/${token}`],
    ["another origin", `#https://evil.test/score/${token}`],
  ];
}

describe("the one inline script", () => {
  it("is one static constant: the scoring page's and the bare one, whatever the request holds — counted", async () => {
    const bodies = new Map<Kind, Set<string>>();
    let checked = 0;
    for (const kind of [...KINDS, "stray"] as Kind[]) {
      for (const [i, locale] of LOCALES.entries()) {
        const res = await appFallbackResponse(
          kind === "stray" ? "stray" : kind,
          new Request(`https://host-${i}.test/app/${kind}?x=${minted()}`, {
            headers: { "x-seazn-locale": locale, "x-nonce": `nonce${i}` },
          }),
        );
        const set = bodies.get(kind) ?? new Set<string>();
        bodies.set(kind, set.add(scriptsOf(await res.text())[0]![2]!));
        checked += 1;
      }
    }
    expect(checked).toBe(16);
    for (const [kind, set] of bodies) expect([...set], kind).toHaveLength(1);
    const body = (kind: Kind) => [...bodies.get(kind)!][0];
    expect(body("day")).toBe(body("stream"));
    expect(body("stray")).toBe(body("stream"));
    expect(body("score")).not.toBe(body("stream"));
  });

  it("every other page drops the fragment, never reads it, and wires nothing — counted", async () => {
    let checked = 0;
    for (const kind of ["stream", "day", "stray"] as Kind[]) {
      for (const hash of ["", `#${minted()}`]) {
        // `run` gives these pages no `location.hash`: reading it throws.
        const { calls, hasButton, listeners, globals } = await run(kind, hash);
        expect(calls, `${kind} ${hash}`).toEqual([["replaceState", null, "", `/app/${kind}`]]);
        expect([hasButton, listeners], kind).toEqual([false, 0]);
        expect(globals, kind).toEqual(["history", "location", "document"]);
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  it("the scoring button is served hidden, so it is never there without a script that wired it", async () => {
    expect((await render("score")).html).toMatch(/<button\b[^>]*data-testid="score-in-browser"[^>]*\shidden>/);
  });

  it("every minted token: stripped at once, the button shown, nothing until the tap, then the same-origin pad — counted", async () => {
    let checked = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const token = minted();
      for (const char of token.slice(3)) seen.add(char);
      // Through the real producer of the link: what the panel's Open in app button carries.
      const { calls, state, listeners, tap, globals } = await run("score", hashOf(scoreAppLink(ORIGIN, token)));
      // The bare path and null state: the history entry keeps nothing.
      expect(calls, token).toEqual([["replaceState", null, "", "/app/score"]]);
      expect([state.hidden, listeners], token).toEqual([false, 1]);
      // Held in the closure alone: the script leaves no global behind.
      expect(globals).toEqual(["history", "location", "document"]);
      tap();
      // `replace`: Back from the pad must not land on this page without its token. Relative: the same origin.
      expect(calls.slice(1), token).toEqual([["replace", `/score/${token}`]]);
      checked += 1;
    }
    expect(checked).toBe(300);
    // The premise of the loop: minted tokens really do use the whole base64url alphabet, `-` and `_` included.
    expect(seen.has("-") && seen.has("_")).toBe(true);
    expect(seen.size).toBe(64);
  });

  it("a second tap asks for the same pad, so a double tap cannot go anywhere else", async () => {
    const token = minted();
    const { calls, tap } = await run("score", `#${token}`);
    tap();
    tap();
    expect(calls.slice(1)).toEqual([
      ["replace", `/score/${token}`],
      ["replace", `/score/${token}`],
    ]);
  });

  it("anything that is not exactly one device-link token: still stripped, the button stays hidden and unwired — counted", async () => {
    const table = refusedFragments();
    let checked = 0;
    for (const [name, hash] of table) {
      const { calls, state, listeners, tap, globals } = await run("score", hash);
      tap();
      expect(calls, name).toEqual([["replaceState", null, "", "/app/score"]]);
      expect([state.hidden, listeners], name).toEqual([true, 0]);
      expect(globals, name).toEqual(["history", "location", "document"]);
      checked += 1;
    }
    expect(checked).toBe(36);
    expect(new Set(table.map(([, hash]) => hash)).size).toBe(36);
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
      expect(scriptsOf(html)[0]![2], locale).not.toMatch(LEAKY);
      expect(scriptsOf(html)[0]![2], locale).not.toMatch(/hash|\/score\//);
      expect(html, locale).not.toContain('data-testid="score-in-browser"');
      checked += 1;
    }
    expect(checked).toBe(4);
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
