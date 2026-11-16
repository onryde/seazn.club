// /sports/{sport}, rendered: the sport-page shape (cricket first), and the guard that any other slug is a 404.
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LOCALES } from "@/lib/i18n-constants";
import { SPORT_PAGES, isSportPage } from "@/lib/marketing/sport-pages";
import { navHrefs } from "@/lib/marketing/product-nav";
import { RALLY_RULES, type RallySport } from "@/lib/marketing/rally-rules";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import { h1Of, renderPage, sectionOrder, textOf } from "../../product/__tests__/_render";

vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const { default: Page, generateMetadata, generateStaticParams } = await import("../[sport]/page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/sports/cricket", () => {
  it.each(LOCALES.map((l) => [l]))("%s: h1 is the short line; the search words are in the title and the lede", async (lang) => {
    const html = await renderPage(Page, { lang, sport: "cricket" });
    const d = DICTS[lang]!;
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(d["sport.cricket.h1"]!));
    const meta = await generateMetadata({ params: Promise.resolve({ lang, sport: "cricket" }) });
    expect(JSON.stringify(meta.title)).toContain(d["sport.cricket.meta.title"]!);
    // The search words: the sport and "tournament" are named in both the <title> and the lede the page renders.
    const SEARCH = /(cricket|críquet).*(tournament|tournoi|torneo|toernooi)|(tournament|tournoi|torneo|toernooi).*(cricket|críquet)/i;
    expect(d["sport.cricket.meta.title"]!).toMatch(SEARCH);
    expect(d["sport.cricket.lede"]!).toMatch(SEARCH);
    const text = textOf(html);
    expect(text).toContain(d["sport.cricket.lede"]!);
    expect(text).not.toMatch(/(sport|product)\.[a-z]+\.[a-zA-Z0-9.]+\b(?<!\.png)/);
    expect(text).not.toMatch(/\{[a-z]+\}/);
  });

  it("sections come in the sport-page order", async () => {
    const html = await renderPage(Page, { lang: "en", sport: "cricket" });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "phones", "offline", "ticket", "club", "questions", "closing"]);
    // Nothing between the closing call and the footer: no second list of product links.
    expect(html.slice(html.indexOf('data-section="closing"'))).not.toMatch(/<nav|mkp-more|mkp-chips/);
  });

  it("the offline section names the app, in every locale", async () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const html = await renderPage(Page, { lang, sport: "cricket" });
      const off = html.slice(html.indexOf('data-section="offline"'), html.indexOf('data-section="ticket"'));
      const app = DICTS[lang]!["product.shared.appName"]!;
      expect(textOf(off).toLowerCase(), lang).toContain(app.toLowerCase());
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the stream upsell links to the streaming page", async () => {
    const html = await renderPage(Page, { lang: "en", sport: "cricket" });
    const ticket = html.slice(html.indexOf('data-section="ticket"'), html.indexOf('data-section="club"'));
    expect(ticket).toContain('href="/product/streaming"');
  });

  it("the demo shows all four screens and quotes no price", async () => {
    const html = await renderPage(Page, { lang: "en", sport: "cricket" });
    for (const tile of ["pad", "matchCentre", "table", "stream"]) expect(html, tile).toContain(`data-testid="chase-tile-${tile}"`);
    expect(textOf(html)).not.toMatch(/[$£€]\s?\d/);
  });
});

// The rally sports (badminton, table tennis, volleyball): same page shape, their own demo, pictures and words.
const RALLY_PAGES = [
  ["badminton", "badminton", /b[aá]dminton/i],
  ["table-tennis", "tabletennis", /table tennis|tennis de table|tenis de mesa|tafeltennis/i],
  ["volleyball", "volleyball", /volleyball|volley-ball|voleibol|volleybal/i],
] as const;
const TOURNAMENT = /tournament|tournoi|torneo|toernooi/i;

describe.each(RALLY_PAGES.map((r) => [...r]))("/sports/%s", (slug, key, sportWord) => {
  const rules = RALLY_RULES[key as RallySport];
  const decider = rules.targets[rules.bestOf - 1]!;

  it.each(LOCALES.map((l) => [l]))("%s: one h1, the search words in the title and the lede, no leaked key or placeholder", async (lang) => {
    const html = await renderPage(Page, { lang, sport: slug });
    const d = DICTS[lang]!;
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(d[`sport.${key}.h1`]!));
    const meta = await generateMetadata({ params: Promise.resolve({ lang, sport: slug }) });
    expect(JSON.stringify(meta.title)).toContain(d[`sport.${key}.meta.title`]!);
    for (const k of ["meta.title", "lede"]) {
      expect(d[`sport.${key}.${k}`]!, k).toMatch(sportWord);
      expect(d[`sport.${key}.${k}`]!, k).toMatch(TOURNAMENT);
    }
    const text = textOf(html);
    expect(text).toContain(d[`sport.${key}.lede`]!);
    expect(text).not.toMatch(/(sport|product)\.[a-z]+\.[a-zA-Z0-9.]+\b(?<!\.webp)/);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(text).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/tournament (format )?software/i);
  });

  it("sections come in the sport-page order, with nothing after the closing call", async () => {
    const html = await renderPage(Page, { lang: "en", sport: slug });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "ticket", "club", "questions", "closing"]);
    expect(html.slice(html.indexOf('data-section="closing"'))).not.toMatch(/<nav|mkp-more|mkp-chips/);
  });

  it("the demo opens in the deciding set at the engine's own target, all four screens present", async () => {
    const html = await renderPage(Page, { lang: "en", sport: slug });
    for (const tile of ["pad", "matchCentre", "table", "stream"]) expect(html, tile).toContain(`data-testid="rally-tile-${tile}"`);
    expect(html).toMatch(new RegExp(`data-testid="rally-score-a"[^>]*>${decider - 3}<`));
    expect(html).toMatch(new RegExp(`data-testid="rally-score-b"[^>]*>${decider - 4}<`));
    expect(html.split('data-testid="rally-set"').length - 1).toBe(rules.bestOf - 1);
    expect(textOf(html)).toContain(`first to ${decider}`);
    expect(html).not.toContain('data-testid="chase-demo"');
  });

  it("every picture on the page is this sport's own", async () => {
    const html = await renderPage(Page, { lang: "en", sport: slug });
    const pics = [...html.matchAll(/\/marketing\/product\/([a-z0-9-]+)\.webp/g)].map((m) => m[1]!);
    expect(pics.length).toBeGreaterThanOrEqual(4);
    for (const pic of pics) expect(pic.startsWith(`${key}-`), pic).toBe(true);
  });

  it("the stream upsell links to the streaming page", async () => {
    const html = await renderPage(Page, { lang: "en", sport: slug });
    expect(html.slice(html.indexOf('data-section="ticket"'), html.indexOf('data-section="club"'))).toContain('href="/product/streaming"');
  });
});

describe("sport page guard", () => {
  it("accepts every listed sport and rejects everything else", () => {
    let checked = 0;
    for (const s of SPORT_PAGES) { expect(isSportPage(s)).toBe(true); checked++; }
    for (const s of ["", "Cricket", "cricket/", "tabletennis", " cricket", "__proto__"]) { expect(isSportPage(s), JSON.stringify(s)).toBe(false); checked++; }
    expect(checked).toBe(SPORT_PAGES.length + 6);
  });

  it("an unlisted sport, and an unknown locale, are 404s", async () => {
    await expect(renderPage(Page, { lang: "en", sport: "notasport" })).rejects.toThrow("NOT_FOUND");
    await expect(renderPage(Page, { lang: "de", sport: "cricket" })).rejects.toThrow("NOT_FOUND");
    expect(await generateMetadata({ params: Promise.resolve({ lang: "en", sport: "notasport" }) })).toEqual({});
  });

  it("prerenders exactly the listed sports", () => {
    expect(generateStaticParams()).toEqual(SPORT_PAGES.map((sport) => ({ sport })));
  });
});

describe("nav links are not inert", () => {
  it("every nav href resolves to a page file under the marketing tree", () => {
    const root = path.resolve(__dirname, "../..");
    let checked = 0;
    for (const href of navHrefs()) {
      const parts = href.split("/").filter(Boolean);
      const direct = path.join(root, ...parts, "page.tsx");
      const dynamic = path.join(root, ...parts.slice(0, -1), "[sport]", "page.tsx");
      const ok = fs.existsSync(direct) || (parts[0] === "sports" && isSportPage(parts[1] ?? "") && fs.existsSync(dynamic));
      expect(ok, href).toBe(true);
      checked++;
    }
    expect(checked).toBe(navHrefs().length);
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});
