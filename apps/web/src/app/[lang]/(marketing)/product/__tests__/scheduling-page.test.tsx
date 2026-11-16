// /product/scheduling, rendered: the demo opens on the model's own opening day, in every locale.
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import { COURTS, DELAY_STEP, MATCHES, SLOTS, clockAt, openingDay } from "@/lib/marketing/day-board";
import { h1Of, renderPage, sectionOrder, textOf } from "./_render";

vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const { default: Page, generateMetadata } = await import("../scheduling/page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/product/scheduling", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, the dictionary's headline, and no raw key or placeholder", async (lang) => {
    const html = await renderPage(Page, { lang });
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(DICTS[lang]!["product.scheduling.h1"]!));
    const text = textOf(html);
    expect(text).not.toMatch(/(product\.(scheduling|shared)|pricing\.matrix)\.[a-zA-Z0-9.]+/);
    expect(text).not.toMatch(/\{[a-z]+\}/);
    expect(text).not.toContain("*");
    expect(text.toLowerCase()).not.toMatch(/software|logiciel/);
  });

  it("sections come in the feature-page order", async () => {
    expect(sectionOrder(await renderPage(Page, { lang: "en" }))).toEqual(["hero", "demo", "road", "ticket", "questions", "closing"]);
  });

  it("the demo is rendered on the server at the model's opening day", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const open = openingDay();
    expect(html.split('data-testid="day-cell-').length - 1).toBe(COURTS * SLOTS);
    let placed = 0;
    for (const m of MATCHES) {
      const at = open.placed[m.id];
      if (at) {
        placed++;
        expect(html, m.id).toMatch(new RegExp(`data-testid="day-cell-${at.court}-${at.slot}"[^>]*data-match="${m.id}"|data-match="${m.id}"[^>]*data-testid="day-cell-${at.court}-${at.slot}"`));
      } else expect(html, m.id).toContain(`data-testid="day-tray-${m.id}"`);
    }
    expect(placed).toBe(Object.keys(open.placed).length);
    expect(placed).toBeGreaterThan(0);
    for (let s = 0; s < SLOTS; s++) expect(textOf(html)).toContain(clockAt(s, 0));
    expect(html).toContain('data-published="false"');
    // The delay button names the model's own step, the one the real board's "Shift day" buttons use.
    expect(textOf(html)).toContain(`+${DELAY_STEP} min`);
  });

  it.each(LOCALES.map((l) => [l]))("%s: quotes no price", async (lang) => {
    expect(textOf(await renderPage(Page, { lang }))).not.toMatch(/[$£€]\s?\d|\d\s?(USD|GBP|EUR|€|£|\$)/);
  });

  it("metadata is canonical per locale; an unknown locale is a 404", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ lang: "fr" }) });
    expect(JSON.stringify(meta)).toContain("/fr/product/scheduling");
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
