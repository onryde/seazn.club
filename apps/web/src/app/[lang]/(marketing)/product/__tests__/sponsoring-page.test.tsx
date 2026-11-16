// /product/sponsoring, rendered: the feature-page shape, a demo that offers exactly what the product's own deal rules
// offer, and copy that names every tier, method, rule, status and step the product declares, in every locale.
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import { DEAL_STATUSES, GO_LIVE_RULES, PAYMENT_METHODS, goLiveRulesFor } from "@/lib/sponsor-deals";
import { SPONSOR_TIERS, SPONSOR_TIER_WEIGHTS } from "@/lib/sponsor-tiers";
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
const { default: Page, generateMetadata } = await import("../sponsoring/page");
const plain = (s: string) => s.replace(/\*/g, "");

describe("/product/sponsoring", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, sponsor words in the title and the lede, no leaked key, placeholder or price", async (lang) => {
    const html = await renderPage(Page, { lang });
    const d = DICTS[lang]!;
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(d["product.sponsoring.h1"]!));
    const meta = await generateMetadata({ params: Promise.resolve({ lang }) });
    expect(JSON.stringify(meta.title)).toContain(d["product.sponsoring.meta.title"]!);
    for (const k of ["meta.title", "lede"]) expect(d[`product.sponsoring.${k}`]!, k).toMatch(/sponsor|parrain|patrocin/i);
    const text = textOf(html);
    expect(text).toContain(d["product.sponsoring.lede"]!);
    expect(text).not.toMatch(/(sport|product)\.[a-z]+\.[a-zA-Z0-9._]+\b(?<!\.webp)/);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(text).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/tournament (format )?software/i);
  });

  it("sections come in the feature-page order, with nothing after the closing call", async () => {
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "ticket", "questions", "closing"]);
    expect(html.slice(html.indexOf('data-section="closing"'))).not.toMatch(/<nav|mkp-more|mkp-chips/);
    expect(html.slice(html.indexOf('data-section="ticket"'), html.indexOf('data-section="questions"'))).toContain('href="/pricing"');
  });

  it("the demo offers the product's own tiers and payment methods, and the rules the first method allows", async () => {
    const html = await renderPage(Page, { lang: "en" });
    for (const tier of SPONSOR_TIERS) expect(html, tier).toContain(`data-testid="sponsor-tier-${tier}"`);
    expect(html.split('data-testid="sponsor-tier-').length - 1).toBe(SPONSOR_TIERS.length);
    for (const m of PAYMENT_METHODS) expect(html, m).toContain(`data-testid="sponsor-method-${m}"`);
    const first = PAYMENT_METHODS[0];
    expect(html.split('data-testid="sponsor-rule-').length - 1).toBe(goLiveRulesFor(first).length);
    // It opens on a deal that is NOT live: nothing on the page or the stream until the deal's own rule is met.
    expect(html).toContain('data-deal-status="draft"');
    expect(html).toContain('data-board-tier=""');
    expect(html).toContain('data-on-stream="false"');
    expect(html).not.toContain('data-testid="sponsor-on-page"');
    // The one step a draft online deal offers besides ending it.
    expect(html).toContain('data-testid="sponsor-step-send_invoice"');
    expect(html).not.toContain('data-testid="sponsor-step-pay"');
    expect(html).not.toContain('data-testid="sponsor-step-approve"');
  });

  it("every tier, method, rule, status and step the product declares has a label in every locale", () => {
    const keys = [
      ...SPONSOR_TIERS.map((k) => `tier.${k}`),
      ...PAYMENT_METHODS.map((k) => `method.${k}`),
      ...GO_LIVE_RULES.map((k) => `rule.${k}`),
      ...DEAL_STATUSES.map((k) => `status.${k}`),
      "step.send_invoice", "step.pay.online", "step.pay.offline", "step.approve", "step.end",
    ];
    let checked = 0;
    for (const lang of LOCALES) {
      for (const k of keys) {
        expect(DICTS[lang]![`product.sponsor.demo.${k}`], `${lang} ${k}`).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBe(4 * (SPONSOR_TIERS.length + PAYMENT_METHODS.length + GO_LIVE_RULES.length + DEAL_STATUSES.length + 5));
    // The rotation shares shown on the stream tile are the product's weights, and they are not all one number.
    expect(new Set(Object.values(SPONSOR_TIER_WEIGHTS)).size).toBeGreaterThan(1);
  });

  it("every picture is a sponsor screen, and an unknown locale is a 404", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const pics = [...html.matchAll(/\/marketing\/product\/([a-z0-9-]+)\.webp/g)].map((m) => m[1]!);
    expect(pics.length).toBeGreaterThanOrEqual(3);
    for (const pic of pics) expect(pic.startsWith("sponsor-"), pic).toBe(true);
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
