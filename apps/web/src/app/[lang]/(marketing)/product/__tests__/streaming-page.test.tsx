// /product/streaming, rendered: the feature-page shape, in every locale, with the claims it is allowed to make.
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import { h1Of, renderPage, sectionOrder, textOf } from "./_render";

vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const { default: Page, generateMetadata } = await import("../streaming/page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/product/streaming", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, the dictionary's headline, and no raw key or placeholder", async (lang) => {
    const html = await renderPage(Page, { lang });
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(DICTS[lang]!["product.streaming.h1"]!));
    const text = textOf(html);
    expect(text).not.toMatch(/product\.(streaming|demo|shared)\./);
    expect(text).not.toMatch(/\{[a-z]+\}/);
    expect(text).not.toContain("*");
  });

  it("sections come in the feature-page order", async () => {
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "camera", "ticket", "club", "questions", "closing"]);
    // Nothing between the closing call and the footer: no second list of product links.
    expect(html.slice(html.indexOf('data-section="closing"'))).not.toMatch(/<nav|mkp-more|mkp-chips/);
  });

  it.each(LOCALES.map((l) => [l]))("%s: quotes no price", async (lang) => {
    const text = textOf(await renderPage(Page, { lang }));
    expect(text).not.toMatch(/[$£€]\s?\d|\d\s?(USD|GBP|EUR|€|£|\$)/);
  });

  it("never claims offline scoring (that is the app's claim, made on sport pages)", async () => {
    for (const lang of LOCALES) expect(textOf(await renderPage(Page, { lang })).toLowerCase(), lang).not.toMatch(/offline|hors ligne|sin conexión|sin cobertura/);
  });

  it("the camera picture is declared illustrated, in every locale", async () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const html = await renderPage(Page, { lang });
      const cam = html.slice(html.indexOf('data-section="camera"'), html.indexOf('data-section="ticket"'));
      expect(textOf(cam), lang).toContain(DICTS[lang]!["product.shared.illustrated"]!);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the proof block has no link while there is no demo club to open", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const club = html.slice(html.indexOf('data-section="club"'), html.indexOf('data-section="questions"'));
    expect(club).not.toContain("<a ");
  });

  it("the demo renders the pad and the stream, with the stream's switches", async () => {
    const html = await renderPage(Page, { lang: "en" });
    expect(html).toContain('data-testid="chase-tile-pad"');
    expect(html).toContain('data-testid="chase-seg-state-recon"');
    expect(html).not.toContain('data-testid="chase-tile-table"');
  });

  it("metadata: canonical and hreflang for all four locales", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ lang: "fr" }) });
    expect(meta.alternates?.canonical).toBe("/fr/product/streaming");
    expect(Object.keys(meta.alternates!.languages as object).sort()).toEqual(["en", "es", "fr", "nl", "x-default"]);
  });

  it("an unknown locale is a 404", async () => {
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
