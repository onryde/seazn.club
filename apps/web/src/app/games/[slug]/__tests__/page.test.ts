import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GamePage, { generateMetadata } from "../page";

// GamePage ITSELF (the default export) is an async server component whose
// slim header nests GamePlayer -> next/dynamic({ssr:false}) -> the real
// chess-quest chunk. This header used to claim it was "not renderable with
// react-dom/server outside a real Next.js runtime"; that was checked in the
// phone-composition wave and is FALSE — `await GamePage({params})` returns a
// plain element, and renderToStaticMarkup renders it down to the dynamic
// import's "Loading game…" fallback, chrome and all. The chrome tests below
// therefore assert on real markup; only the source-scan pair immediately
// after keeps reading the file (an href expression is not visible in the
// rendered output as an expression). generateMetadata has no such
// dependency either and is called directly.
const source = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");

// Review 2026-08-27: on the games.* subdomain, proxy.ts's gamesHostRewrite
// sends a relative href="/" straight back to /games — a dead loop, never
// reaching the marketing home. The "Powered by Seazn Club" link must be
// absolute (siteOrigin()), never a bare "/".
describe("games/[slug] page — Powered by link escapes the games.* subdomain", () => {
  it("imports siteOrigin", () => {
    expect(source).toMatch(/import\s*\{\s*siteOrigin\s*\}\s*from\s*"@\/lib\/site-origin"/);
  });

  it("the Powered by link's href uses siteOrigin(), not a bare relative \"/\"", () => {
    const linkBlock = source.slice(source.indexOf("Powered by") - 200, source.indexOf("Powered by"));
    expect(linkBlock).toContain("siteOrigin()");
    expect(linkBlock).not.toMatch(/href="\/"/);
  });
});

// Review 2026-08-27: Metadata merges shallowly per segment — since this
// page defines its own openGraph key, the root layout's openGraph
// (type/siteName only) is REPLACED here, not merged. Without an explicit
// openGraph.title/description, sharing a game link showed no page-specific
// preview card at all.
describe("games/[slug] page metadata — Open Graph", () => {
  it("sets openGraph title/description matching the page's own title/description for a real game", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "chess-quest" }),
    });
    expect(metadata.openGraph?.title).toBe(metadata.title);
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.openGraph?.url).toBe("https://seazn.club/games/chess-quest");
  });

  it("returns empty metadata for an unknown slug (no crash, matches the existing notFound() path)", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "not-a-real-game" }),
    });
    expect(metadata).toEqual({});
  });
});

// Phone composition — design of record: scratchpad games-phone-options.html,
// "Game page header". At 320 "← Games | Title | Powered by Seazn Club" wrapped
// into two or three rows with orphaned dividers. On phones it is one row of
// "← Games" + the title; the attribution moves to a footer line under the
// game. One DOM: the header copy carries max-md:hidden and the footer copy
// md:hidden, so exactly one of the two is visible at any width.
describe("games/[slug] page — phone header composition", () => {
  const cls = (name: string) =>
    new RegExp(`["\\s]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s"]`);

  async function render(slug = "chess-quest"): Promise<string> {
    return renderToStaticMarkup(await GamePage({ params: Promise.resolve({ slug }) }));
  }

  function tagBefore(html: string, at: number, open: string): string {
    const start = html.lastIndexOf(open, at);
    expect(start, `no ${open} before offset ${at}`).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf(">", start) + 1);
  }

  it("shows exactly one attribution: the header copy on desktop, the footer copy on phones", async () => {
    const html = await render();
    const marks = [...html.matchAll(/Powered by/g)].map((m) => m.index!);
    expect(marks.length, "expected one header copy and one footer copy").toBe(2);

    const headerLink = tagBefore(html, marks[0], "<a");
    expect(headerLink, "the header attribution must fold away on phones").toMatch(
      cls("max-md:hidden"),
    );

    // The footer copy lives under <main>, and is the phone-only one.
    const footer = tagBefore(html, marks[1], "<footer");
    expect(footer).toMatch(cls("md:hidden"));
    expect(footer).not.toMatch(cls("max-md:hidden"));
    expect(html.indexOf("</main>")).toBeLessThan(marks[1]);
  });

  it("both attribution copies escape the games.* subdomain with an absolute href", async () => {
    const html = await render();
    const hrefs = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>Powered by/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(2);
    for (const href of hrefs) expect(href).toMatch(/^https?:\/\/[^/]+\//);
  });

  it("drops the dividers on phones and keeps the back link + title on one row", async () => {
    const html = await render();
    const dividers = [...html.matchAll(/<span[^>]*>\|<\/span>/g)].map((m) => m[0]);
    expect(dividers.length).toBe(2);
    for (const d of dividers) expect(d).toMatch(cls("max-md:hidden"));

    const backAt = html.indexOf("← Games");
    const back = tagBefore(html, backAt, "<a");
    expect(back).not.toMatch(cls("hidden"));
    const h1 = tagBefore(html, html.indexOf("Chess Quest</h1>"), "<h1");
    // truncate only bites on phones, and only with min-w-0 up the chain —
    // the header itself is the flex container, so the h1 carries both.
    expect(h1).toMatch(cls("max-md:truncate"));
    expect(h1).toMatch(cls("max-md:min-w-0"));
  });

  it("keeps the title inside the banner landmark (e2e locates it by role)", async () => {
    const html = await render();
    const headerAt = html.indexOf("<header");
    const headerEnd = html.indexOf("</header>");
    expect(html.slice(headerAt, headerEnd)).toContain("Chess Quest</h1>");
  });
});
