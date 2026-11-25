// The "Open in app" block (spec 2026-11-25 §5.4/§5.5; plan Task 4, "Approved look"). Its anchor's href is a LIVE
// CREDENTIAL on a page that runs analytics, so the markup rules are the security rules: everything that holds a link sits
// inside ONE `ph-no-capture` element (PostHog autocapture ignores it, session replay records none of it), the anchor is
// plain (`rel="noreferrer"`, no `target`), and nothing at all is server-rendered. Node has no DOM, so WHO sees it — the
// Android check after mount, the md breakpoint — is e2e/open-in-app-buttons.spec.ts's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenInAppBlock, OpenInAppHint, OpenInAppRow, ScoreInBrowserLink } from "../open-in-app";

const HREF = `https://stg.seazn.club/app/score#dl_${"a".repeat(43)}`;
const PAD = `https://stg.seazn.club/score/dl_${"a".repeat(43)}`;
const DICTS = resolve(import.meta.dirname, "../../../dictionaries");
const dict = (locale: string) => JSON.parse(readFileSync(resolve(DICTS, locale, "ui.json"), "utf8")) as Record<string, string>;
const EN = dict("en");

/** The opening tag of the element carrying `data-testid="id"`. */
const tagOf = (html: string, id: string): string => {
  const tag = html.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no element ${id} in ${html}`);
  return tag;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenInAppRow server render (and so the first client render)", () => {
  it("is empty even with the flag on, an Android browser and a link: the button appears only after mount", () => {
    vi.stubEnv("NEXT_PUBLIC_OPEN_IN_APP", "1");
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile" });
    expect(renderToStaticMarkup(<OpenInAppRow href={HREF}>extra</OpenInAppRow>)).toBe("");
  });
});

describe("the block's markup", () => {
  // React 19 puts an image preload hint ahead of the tree; it is not part of the block (and is the logo, same origin).
  const html = renderToStaticMarkup(
    <OpenInAppBlock href={HREF}>
      <ScoreInBrowserLink href={PAD} />
    </OpenInAppBlock>,
  ).replace(/^<link rel="preload" as="image" href="\/brand\/seazn-logo-night-tight\.png"\/>/, "");

  it("is ONE root element, ph-no-capture and md:hidden, so both links and their text sit inside it", () => {
    const root = html.match(/^<div\b[^>]*class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    expect(root).toContain("ph-no-capture");
    expect(root).toContain("md:hidden");
    // One root: the markup is a single balanced <div>, nothing trails it.
    let depth = 0;
    let closedAt = -1;
    for (const m of html.matchAll(/<\/?div\b[^>]*>/g)) {
      depth += m[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        closedAt = m.index + m[0].length;
        break;
      }
    }
    expect(closedAt).toBe(html.length);
  });

  it("Open in app is a plain anchor: the link, rel=noreferrer, no target, no download", () => {
    const tag = tagOf(html, "open-in-app");
    expect(tag.startsWith("<a ")).toBe(true);
    expect(tag).toContain(`href="${HREF}"`);
    expect(tag).toContain('rel="noreferrer"');
    expect(tag).not.toContain("target=");
    expect(tag).not.toContain("download=");
    expect(html).toContain(`>${EN["openApp.button"]}</a>`);
  });

  it("Score in browser opens the pad in a new tab, so the panel keeps the secret", () => {
    const tag = tagOf(html, "score-in-browser-link");
    expect(tag.startsWith("<a ")).toBe(true);
    expect(tag).toContain(`href="${PAD}"`);
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noreferrer"');
    expect(html).toContain(`>${EN["openApp.scoreInBrowser"]}</a>`);
    expect(html.indexOf('data-testid="open-in-app"')).toBeLessThan(html.indexOf('data-testid="score-in-browser-link"'));
  });

  it("carries the logo with its name, then the or-scan line last", () => {
    expect(html).toMatch(/<img\b[^>]*src="\/brand\/seazn-logo-night-tight\.png"/);
    expect(html).toMatch(/<img\b[^>]*alt="Seazn Club"/);
    expect(html).toContain(`>${EN["openApp.orScan"]}</p></div>`);
    expect(html.endsWith(`>${EN["openApp.orScan"]}</p></div>`)).toBe(true);
  });
});

describe("OpenInAppHint", () => {
  it("names itself and paints only the two missing-thing lines amber — counted", () => {
    const keys = {
      "openApp.stream.thenGoLive": false,
      "openApp.stream.needDestination": true,
      "openApp.stream.needCredit": true,
      "openApp.stream.checkFirst": false,
    } as const;
    let checked = 0;
    for (const [key, amber] of Object.entries(keys) as [keyof typeof keys, boolean][]) {
      const html = renderToStaticMarkup(<OpenInAppHint hint={key} />);
      expect(html, key).toContain(`data-hint="${key}"`);
      expect(html.includes("#ffc66b"), key).toBe(amber);
      expect(html.includes("#c9bfee"), key).toBe(!amber);
      expect(html, key).toContain(`>${EN[key]!.replace(/'/g, "&#x27;")}</p>`);
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("the copy", () => {
  const COPY: Record<string, string> = {
    "openApp.button": "Open in app",
    "openApp.scoreInBrowser": "Score in browser",
    "openApp.orScan": "or scan with another phone",
    "openApp.stream.thenGoLive": "Then hold Go live in the app.",
    "openApp.stream.needDestination": "Pick a destination here first.",
    "openApp.stream.needCredit": "You need a streaming credit first.",
    "openApp.stream.checkFirst": "Check a destination is picked and you have a credit.",
  };

  it("English is the approved wording", () => {
    for (const [key, text] of Object.entries(COPY)) expect(EN[key], key).toBe(text);
  });

  it("es, fr and nl each carry their own line for every key — counted", () => {
    let checked = 0;
    for (const locale of ["es", "fr", "nl"]) {
      const other = dict(locale);
      for (const key of Object.keys(COPY)) {
        expect(other[key], `${locale} ${key}`).toBeTruthy();
        expect(other[key], `${locale} ${key}`).not.toBe(COPY[key]);
        checked += 1;
      }
    }
    expect(checked).toBe(21);
  });
});
