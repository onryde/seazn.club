// /product/match-day, rendered: the feature-page shape, the demo's opening day, and copy in every locale that makes
// no claim the product does not back (no price, no "as many as you need").
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import { MATCHES, nextFor, openingDay } from "@/lib/marketing/match-day";
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
const { default: Page, generateMetadata } = await import("../match-day/page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/product/match-day", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, the lede on the page, no leaked key, placeholder, price or unbacked claim", async (lang) => {
    const html = await renderPage(Page, { lang });
    const d = DICTS[lang]!;
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(d["product.matchday.h1"]!));
    const meta = await generateMetadata({ params: Promise.resolve({ lang }) });
    expect(JSON.stringify(meta.title)).toContain(d["product.matchday.meta.title"]!);
    const text = textOf(html);
    expect(text).toContain(d["product.matchday.lede"]!);
    expect(text).not.toMatch(/(sport|product)\.[a-z]+\.[a-zA-Z0-9._]+\b(?<!\.webp)/);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(text).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/tournament (format )?software/i);
    expect(text).not.toMatch(/as many (volunteer )?codes/i);
  });

  it("sections come in the feature-page order and end on the closing call", async () => {
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "courtstream", "ticket", "club", "questions", "closing"]);
    expect(html.slice(html.indexOf('data-section="closing"'))).not.toMatch(/<nav|mkp-more|mkp-chips/);
    expect(html.slice(html.indexOf('data-section="ticket"'), html.indexOf('data-section="club"'))).toContain('href="/pricing"');
  });

  it("the demo renders the opening day: one court playing, two free with a call offered, four waiting, one phone on air", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const day = openingDay();
    for (const [i, c] of day.courts.entries()) expect(html, `court ${i}`).toContain(`data-testid="md-court-${i}" data-court-state="${c.kind}"`);
    expect(html.split('data-act="call"').length - 1).toBe(day.courts.filter((c) => c.kind === "free").length);
    expect(html.split('data-act="result"').length - 1).toBe(1);
    expect(html).toContain(`data-testid="md-waiting" data-waiting="${day.waiting.length}"`);
    expect(html.split('data-stream="live"').length - 1).toBe(1);
    expect(html).toContain('data-stream="none"');
    // The match a call would take is named on the page, by its two real team names.
    const next = MATCHES[nextFor(day)!]!;
    expect(next.a).not.toBe(next.b);
    expect(html).toContain('data-testid="md-next"');
  });

  it.each(LOCALES.map((l) => [l]))("%s: the questions are also published as FAQ structured data, word for word", async (lang) => {
    const html = await renderPage(Page, { lang });
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]!) as { "@type": string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] });
    const faq = blocks.filter((b) => b["@type"] === "FAQPage");
    expect(faq).toHaveLength(1);
    const d = DICTS[lang]!;
    expect(faq[0]!.mainEntity!.map((q) => [q.name, q.acceptedAnswer.text])).toEqual((["1", "2", "3", "4"] as const).map((n) => [d[`product.matchday.faq.${n}.q`], d[`product.matchday.faq.${n}.a`]]));
  });

  it("every picture is a Match Day or camera-phone screen, and an unknown locale is a 404", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const pics = [...html.matchAll(/\/marketing\/product\/([a-z0-9-]+)\.webp/g)].map((m) => m[1]!);
    expect(pics.length).toBeGreaterThanOrEqual(5);
    for (const pic of pics) expect(/^(matchday-|app-stream-)/.test(pic), pic).toBe(true);
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
