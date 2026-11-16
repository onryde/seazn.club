// /sports, rendered: one card per sport page, each named and described by that sport's own page copy, each with its
// own real pad picture, each linking to its page.
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import { SPORT_PAGES, sportKeyOf } from "@/lib/marketing/sport-pages";
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
const { default: Page, generateMetadata } = await import("../page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/sports", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, a card per sport page carrying that sport's own name and headline", async (lang) => {
    const html = await renderPage(Page, { lang });
    const d = DICTS[lang]!;
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(d["product.sports.h1"]!));
    const meta = await generateMetadata({ params: Promise.resolve({ lang }) });
    expect(JSON.stringify(meta.title)).toContain(d["product.sports.meta.title"]!);
    const text = textOf(html);
    expect(text).toContain(d["product.sports.lede"]!);
    let cards = 0;
    for (const slug of SPORT_PAGES) {
      const key = sportKeyOf(slug);
      const at = html.indexOf(`data-testid="sport-card-${slug}"`);
      expect(at, slug).toBeGreaterThan(-1);
      const card = html.slice(html.lastIndexOf("<a", at), html.indexOf("</a>", at));
      expect(card, slug).toContain(`href="/sports/${slug}"`);
      expect(textOf(card), slug).toContain(d[`nav.sport.${key}`]!);
      expect(textOf(card), slug).toContain(plain(d[`sport.${key}.h1`]!));
      cards++;
    }
    expect(cards).toBe(SPORT_PAGES.length);
    expect(html.split('data-testid="sport-card-').length - 1).toBe(SPORT_PAGES.length);
    expect(text).not.toMatch(/(sport|product|nav)\.[a-z]+\.[a-zA-Z0-9._]+\b(?<!\.webp)/);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(text).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/tournament (format )?software/i);
  });

  it("every card has its own picture, and the sections end on the closing call", async () => {
    const html = await renderPage(Page, { lang: "en" });
    // Pictures as drawn: the first card's is not lazy, so React also emits a preload link for it, which is not a card.
    const pics = [...html.matchAll(/<img src="\/marketing\/product\/([a-z0-9-]+)\.webp/g)].map((m) => m[1]!);
    expect(pics).toHaveLength(SPORT_PAGES.length);
    expect(new Set(pics).size).toBe(SPORT_PAGES.length);
    expect(sectionOrder(html)).toEqual(["hero", "sports", "questions", "closing"]);
    expect(html).toContain('href="#sports"');
    expect(html).toContain('id="sports"');
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });

  it("the first card's picture is not lazy (it is the largest thing on a phone's first screen); the rest are", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const grid = html.slice(html.indexOf("mkp-sportgrid"));
    const loads = [...grid.matchAll(/data-testid="sport-card-[a-z-]+".*?<img[^>]* loading="(eager|lazy)"/gs)].map((m) => m[1]);
    expect(loads.length).toBeGreaterThanOrEqual(8);
    expect(loads[0]).toBe("eager");
    expect(new Set(loads.slice(1))).toEqual(new Set(["lazy"]));
  });
});
