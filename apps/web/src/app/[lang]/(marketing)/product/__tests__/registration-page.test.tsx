// /product/registration, rendered: the feature-page shape, a demo that opens on the model's own opening list, fees
// read from the plan table (never typed), and the demo's every label in every locale.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES } from "@/lib/i18n-constants";
import { REG_DEMO, openingList, totals } from "@/lib/marketing/registration-demo";
import { REGISTRATION_DEMO_LABEL_KEYS } from "@/components/marketing/product/registration-demo-labels";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import { h1Of, renderPage, sectionOrder, textOf } from "./_render";

vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
// Fees no plan really charges, and all different: a typed figure in the page or the copy cannot match them.
const matrix = vi.hoisted(() => ({
  value: {
    "registration.fee_percent": { community: { int_value: 13 }, event_pass: { int_value: 11 }, pro: { int_value: 7 } },
  } as Record<string, Record<string, { int_value: number | null }>>,
}));
vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: async () => matrix.value }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "gbp" }));

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const { default: Page, generateMetadata } = await import("../registration/page");
const plain = (s: string) => s.replace(/\*/g, "");
const ticketOf = (html: string) => html.slice(html.indexOf('data-section="ticket"'), html.indexOf('data-section="questions"'));

describe("/product/registration", () => {
  it.each(LOCALES.map((l) => [l]))("%s: one h1, registration words in the title and the lede, no leaked key or placeholder", async (lang) => {
    const html = await renderPage(Page, { lang });
    const d = DICTS[lang]!;
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(d["product.registration.h1"]!));
    const meta = await generateMetadata({ params: Promise.resolve({ lang }) });
    expect(JSON.stringify(meta.title)).toContain(d["product.registration.meta.title"]!);
    for (const k of ["meta.title", "lede"]) expect(d[`product.registration.${k}`]!, k).toMatch(/registr|inscri|inschrijv/i);
    const text = textOf(html);
    expect(text).toContain(d["product.registration.lede"]!);
    expect(text).not.toMatch(/(sport|product)\.[a-z]+\.[a-zA-Z0-9._]+\b(?<!\.webp)/);
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(text).not.toMatch(/tournament (format )?software/i);
  });

  it("sections come in the feature-page order, with nothing after the closing call", async () => {
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "demo", "road", "entry", "ticket", "questions", "closing"]);
    expect(html.slice(html.indexOf('data-section="closing"'))).not.toMatch(/<nav|mkp-more|mkp-chips/);
    expect(ticketOf(html)).toContain('href="/pricing"');
  });

  it("the demo opens on the model's opening list, in the visitor's currency", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const open = totals(openingList());
    expect(html).toContain(`data-spots-left="${open.spotsLeft}"`);
    expect(html.split("<li data-status=").length - 1).toBe(openingList().entries.length);
    expect(html.split('data-status="paid"').length - 1).toBe(open.paid);
    expect(html.split('data-status="held"').length - 1).toBe(open.held);
    // The fee and the total are the model's minor units, formatted: £24 and paid × £24.
    const text = textOf(html);
    expect(text).toContain(`£${REG_DEMO.feeMinor / 100}`);
    expect(html).toMatch(new RegExp(`data-testid="reg-collected">£${(open.paid * REG_DEMO.feeMinor) / 100}<`));
    expect(html).toContain('data-act="card"');
    expect(html).toContain('data-act="leave"');
    expect(html).not.toContain('data-act="join"');
  });

  it("the fees are the plan table's own, one row per plan; a plan with no fee in the table gets no row", async () => {
    const html = ticketOf(await renderPage(Page, { lang: "en" }));
    const fees = matrix.value["registration.fee_percent"]!;
    for (const plan of ["community", "event_pass", "pro"]) expect(textOf(html), plan).toContain(`${fees[plan]!.int_value}%`);
    expect(html.split("<li").length - 1).toBe(3);
    const saved = matrix.value;
    matrix.value = { "registration.fee_percent": { community: saved["registration.fee_percent"]!.community!, pro: { int_value: null } } };
    try {
      const partial = ticketOf(await renderPage(Page, { lang: "en" }));
      expect(partial.split("<li").length - 1).toBe(1);
      expect(textOf(partial)).not.toMatch(/\d+\s?%.*\d+\s?%/);
    } finally {
      matrix.value = saved;
    }
  });

  it("the pay window the copy quotes is the model's, in every locale", async () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const text = textOf(await renderPage(Page, { lang }));
      const answer = DICTS[lang]!["product.registration.faq.1.a"]!.replace("{hours}", String(REG_DEMO.holdHours));
      expect(text, lang).toContain(answer);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("every demo label has copy in every locale, and the event lines differ from each other", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      for (const k of REGISTRATION_DEMO_LABEL_KEYS) {
        expect(DICTS[lang]![`product.registration.demo.${k}`], `${lang} ${k}`).toBeTruthy();
        checked++;
      }
      const events = REGISTRATION_DEMO_LABEL_KEYS.filter((k) => k.startsWith("event.")).map((k) => DICTS[lang]![`product.registration.demo.${k}`]);
      expect(new Set(events).size, lang).toBe(events.length);
    }
    expect(checked).toBe(4 * REGISTRATION_DEMO_LABEL_KEYS.length);
    expect(REGISTRATION_DEMO_LABEL_KEYS.length).toBeGreaterThan(20);
  });

  it("below 900 the player's phone comes first: the page's own rule outranks the shared pad-last rule", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../../components/marketing/product/product.css"), "utf8");
    const shared = /@media \(max-width:899px\)\{\s*\.mkp-stage \.mkp-t-pad\{order:(\d+)\}/.exec(css);
    const own = /@media \(max-width:899px\)\{\.mkp-stage\.mkp-reg \.mkp-t-pad\{order:(\d+)\}\}/.exec(css);
    expect(shared, "the shared rule this page overrides").not.toBeNull();
    expect(own, "the registration rule").not.toBeNull();
    expect(Number(own![1])).toBeLessThan(Number(shared![1]));
    expect(Number(own![1])).toBe(0);
  });

  it("every picture is a registration screen, four of them, each with its own caption", async () => {
    const html = await renderPage(Page, { lang: "en" });
    const pics = [...html.matchAll(/\/marketing\/product\/([a-z0-9-]+)\.webp/g)].map((m) => m[1]!);
    expect(new Set(pics).size).toBe(4);
    for (const pic of pics) expect(pic.startsWith("reg-"), pic).toBe(true);
    const alts = [...html.matchAll(/<img[^>]*alt="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(alts).size).toBe(4);
  });

  it("an unknown locale is a 404", async () => {
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
