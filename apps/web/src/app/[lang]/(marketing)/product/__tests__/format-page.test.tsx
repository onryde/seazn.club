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
import { stageNeedsAdvancedFormatsGate } from "@/server/usecases/format-gates";
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

  // DERIVED from the server gate, never typed: a family is Pro exactly when one of its stage kinds needs
  // `formats.advanced` (usecases/format-gates.ts). Double elimination and the page playoff are on every plan (V393;
  // builder-template-locks-live.test.ts reads the plan rows), so the page may not call them Pro.
  const needsAdvanced = (slug: string) => FORMAT_FAMILIES.find((f) => f.slug === slug)!.kinds.some((kind) => stageNeedsAdvancedFormatsGate({ kind }));

  it("what it says is on every plan, and what it says is Pro, is what the server gate and the catalogue say", () => {
    expect(FREE_FORMATS.length).toBeGreaterThanOrEqual(5);
    for (const slug of [...FREE_FORMATS, PRO_FORMAT]) expect(FORMAT_FAMILIES.some((f) => f.slug === slug), `${slug} is a catalogue family`).toBe(true);
    for (const slug of FREE_FORMATS) {
      expect(needsAdvanced(slug), `${slug} is claimed free but the gate needs formats.advanced`).toBe(false);
      expect(FORMAT_FAMILIES.find((f) => f.slug === slug)!.pro, `${slug} is claimed free but the catalogue flags it Pro`).toBeUndefined();
    }
    expect(needsAdvanced(PRO_FORMAT), `${PRO_FORMAT} is claimed Pro but the gate lets every plan have it`).toBe(true);
    expect(FORMAT_FAMILIES.find((f) => f.slug === PRO_FORMAT)!.pro).toBe(true);
    expect(FREE_FORMATS as readonly string[], "double elimination is on every plan and the page says so").toContain("double_elim");
  });

  it.each(LOCALES.map((l) => [l]))("%s: the Pro stub names a gated format and its small print names no free one", async (lang) => {
    const text = textOf(await renderPage(Page, { lang }));
    const stub = DICTS[lang]!["product.format.ticket.stubBottom"]!;
    expect(text).toContain(stub);
    // The retired claim named the page playoff here; it is free, so no locale may list it as a rarer, paid format.
    expect(stub).not.toMatch(/page playoff/i);
    expect(DICTS[lang]!["product.format.ticket.body"]!.toLowerCase(), "the body names double elimination among the free formats").toMatch(/doubl|dubbel|doble/);
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
