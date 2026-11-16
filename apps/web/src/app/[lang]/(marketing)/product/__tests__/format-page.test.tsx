// /product/format, rendered: the demo is the product's own recommender, and the plan claims match the format catalogue.
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import uiEn from "@/dictionaries/en/ui.json";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { FORMAT_NAME_KEY, bestFitSlug, rankFormats } from "@/lib/format-recommend";
import { FORMAT_DEMO_START, FREE_FORMATS, PRO_FORMAT } from "@/components/marketing/product/format-demo-config";
import { h1Of, renderPage, sectionOrder, textOf } from "./_render";

vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const { default: Page, generateMetadata } = await import("../format/page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/product/format", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, the dictionary's headline, and no raw key or placeholder", async (lang) => {
    const html = await renderPage(Page, { lang });
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(DICTS[lang]!["product.format.h1"]!));
    const text = textOf(html);
    expect(text).not.toMatch(/(product\.(format|shared)|start\.wizard|format\.[a-z_-]+\.(label|tagline))/);
    expect(text).not.toMatch(/\{[a-z]+\}/);
    expect(text).not.toContain("*");
  });

  it("sections come in the feature-page order", async () => {
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "ticket", "questions", "closing"]);
  });

  it("the demo opens on the recommender's own answer for its starting day", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const ranked = rankFormats(FORMAT_DEMO_START);
    expect(ranked.length).toBeGreaterThanOrEqual(5);
    const best = bestFitSlug(ranked);
    expect(best, "the opening day must have a best fit, or the demo opens with nothing to point at").not.toBeNull();
    for (const r of ranked) {
      const card = html.slice(html.indexOf(`data-testid="format-card-${r.slug}"`));
      expect(card.slice(0, 2000), r.slug).toContain(`data-testid="format-card-${r.slug}-matches">${r.matches} `);
      expect(html).toContain(uiEn[FORMAT_NAME_KEY[r.slug] as keyof typeof uiEn]);
    }
    expect(html.split('data-best="true"')).toHaveLength(2);
    expect(html).toMatch(new RegExp(`data-testid="format-card-${best}"[^>]*data-best="true"|data-best="true"[^>]*data-testid="format-card-${best}"`));
  });

  it("what it says is on every plan, and what it says is Pro, is what the format catalogue says", () => {
    const pro = new Set(FORMAT_FAMILIES.filter((f) => f.pro).map((f) => f.slug));
    expect(FREE_FORMATS.length).toBeGreaterThanOrEqual(4);
    for (const slug of FREE_FORMATS) expect(pro.has(slug), `${slug} is claimed free`).toBe(false);
    expect(pro.has(PRO_FORMAT), `${PRO_FORMAT} is claimed Pro`).toBe(true);
    for (const slug of [...FREE_FORMATS, PRO_FORMAT]) expect(FORMAT_FAMILIES.some((f) => f.slug === slug), slug).toBe(true);
  });

  it.each(LOCALES.map((l) => [l]))("%s: quotes no price", async (lang) => {
    expect(textOf(await renderPage(Page, { lang }))).not.toMatch(/[$£€]\s?\d|\d\s?(USD|GBP|EUR|€|£|\$)/);
  });

  it("metadata is canonical per locale; an unknown locale is a 404", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ lang: "nl" }) });
    expect(JSON.stringify(meta)).toContain("/nl/product/format");
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
