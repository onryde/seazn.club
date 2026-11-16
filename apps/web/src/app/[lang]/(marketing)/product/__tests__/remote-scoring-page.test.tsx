// /product/remote-scoring, rendered: offline scoring is the hero, and it is claimed for the app, never the web pad.
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import { openingSignal } from "@/lib/marketing/signal-queue";
import { h1Of, renderPage, sectionOrder, textOf } from "./_render";

vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const { default: Page, generateMetadata } = await import("../remote-scoring/page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/product/remote-scoring", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, the dictionary's headline, and no raw key or placeholder", async (lang) => {
    const html = await renderPage(Page, { lang });
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(DICTS[lang]!["product.remote.h1"]!));
    const text = textOf(html);
    expect(text).not.toMatch(/product\.(remote|signal|demo|shared)\./);
    expect(text).not.toMatch(/\{[a-z]+\}/);
    expect(text).not.toContain("*");
  });

  it("sections come in the feature-page order, the club block omitted, ending on the closing call", async () => {
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "offline", "ticket", "questions", "closing"]);
    expect(html.slice(html.indexOf('data-section="closing"'))).not.toMatch(/<nav|mkp-more|mkp-chips/);
  });

  it.each(LOCALES.map((l) => [l]))("%s: the hero says the offline claim is the app's", async (lang) => {
    const html = await renderPage(Page, { lang });
    const hero = textOf(html.slice(html.indexOf('data-section="hero"'), html.indexOf('data-section="demo"')));
    const app = DICTS[lang]!["product.shared.appName"]!;
    expect(hero.toLowerCase()).toContain(app.toLowerCase());
  });

  it("the demo opens online, with the phone and everyone else on the same score", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const o = openingSignal();
    const score = `${o.phone.runs}/${o.phone.wkts}`;
    expect(html).toContain(`data-testid="signal-phone-score">${score}<`);
    expect(html).toContain(`data-testid="signal-server-score">${score}<`);
    expect(html).toMatch(/data-testid="signal-switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="signal-switch"/);
  });

  it.each(LOCALES.map((l) => [l]))("%s: quotes no price", async (lang) => {
    expect(textOf(await renderPage(Page, { lang }))).not.toMatch(/[$£€]\s?\d|\d\s?(USD|GBP|EUR|€|£|\$)/);
  });

  it("the ticket's stub links to Streaming", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const ticket = html.slice(html.indexOf('data-section="ticket"'), html.indexOf('data-section="questions"'));
    expect(ticket).toContain('href="/product/streaming"');
  });

  it("metadata is canonical per locale; an unknown locale is a 404", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ lang: "fr" }) });
    expect(JSON.stringify(meta)).toContain("/fr/product/remote-scoring");
    expect(String(meta.title)).toContain(fr["product.remote.meta.title"]);
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
