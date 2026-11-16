// The public affiliate entry point: the page, its footer link and its four-locale
// copy. Pure (no DB). The numbers shown come from AFFILIATE_TERMS, so these tests
// derive every expected figure from that constant, never from a typed "40".
import { afterEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

// next/font/google needs the Next build pipeline; the shell only uses the
// returned CSS-variable name. The shell/footer also read the session and mount
// router-hook islands — stubbed exactly as home-signed-in.test.tsx does.
vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn().mockResolvedValue(null) }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => "/en",
    useSearchParams: () => new URLSearchParams(),
  };
});
import { footerCols } from "@/components/marketing-footer";
import { getDictionary, t } from "@/lib/i18n";
import { LOCALES } from "@/lib/i18n-constants";
import { AFFILIATE_PORTAL_URL, AFFILIATE_TERMS } from "@/lib/affiliate-terms";
import AffiliatesPage from "../affiliates/page";

afterEach(() => vi.unstubAllEnvs());

const KEYS = [
  "affiliates.meta.title",
  "affiliates.meta.description",
  "affiliates.badge",
  "affiliates.h1",
  "affiliates.subhead",
  "affiliates.card.0.title",
  "affiliates.card.0.body",
  "affiliates.card.1.title",
  "affiliates.card.1.body",
  "affiliates.card.2.title",
  "affiliates.card.2.body",
  "affiliates.payout",
  "affiliates.cta.title",
  "affiliates.cta.subtext",
  "affiliates.cta.button",
  "footer.link.affiliates",
] as const;

describe("footer link", () => {
  const affiliateLinks = (on: boolean) =>
    footerCols(on).flatMap((c) => c.links).filter((l) => l.href === "/affiliates");

  it("is present exactly once while the Revshare switch is on", () => {
    expect(affiliateLinks(true)).toHaveLength(1);
  });
  it("is absent while the switch is off (negative pair)", () => {
    expect(affiliateLinks(false)).toHaveLength(0);
  });
  it("switching it off removes ONLY that link", () => {
    const count = (on: boolean) => footerCols(on).flatMap((c) => c.links).length;
    expect(count(true) - count(false)).toBe(1);
  });
});

describe("/affiliates page", () => {
  const render = (lang: string) => AffiliatesPage({ params: Promise.resolve({ lang }) });
  async function html(lang: string): Promise<string> {
    const { prelude } = await prerender(await render(lang));
    const reader = (prelude as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  it("404s when the switch is off (stg / local)", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "0");
    await expect(render("en")).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });
  it("404s for an unknown locale even when on", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "1");
    await expect(render("xx")).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });
  it("renders the real page in every locale: terms in the headline, CTA to the portal, safe external link", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "1");
    let checked = 0;
    for (const lang of LOCALES) {
      const d = await getDictionary(lang, "marketing");
      const page = await html(lang);
      expect(page, lang).toContain(t(d, "affiliates.h1", AFFILIATE_TERMS));
      expect(page, lang).toContain(t(d, "affiliates.payout", AFFILIATE_TERMS));
      // Judge the CTA's OWN tag: the page carries other external links, so a
      // page-wide match for rel/target would pass with the CTA's attributes gone.
      const cta = page.match(/<a\b[^>]*data-testid="affiliates-join"[^>]*>/)?.[0] ?? "";
      expect(cta, `${lang}: CTA anchor not found`).not.toBe("");
      expect(cta, lang).toContain(`href="${AFFILIATE_PORTAL_URL}"`);
      expect(cta, lang).toContain('rel="noopener noreferrer"');
      expect(cta, lang).toContain('target="_blank"');
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});

describe("four-locale copy", () => {
  it("every key exists in every locale and no placeholder is left unfilled", async () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const d = await getDictionary(lang, "marketing");
      for (const key of KEYS) {
        const out = t(d, key, AFFILIATE_TERMS);
        expect(out, `${lang} ${key}`).not.toBe(key);
        expect(out, `${lang} ${key}`).not.toMatch(/[{}]/);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * KEYS.length);
  });

  it("the headline carries the terms from AFFILIATE_TERMS in every locale", async () => {
    for (const lang of LOCALES) {
      const d = await getDictionary(lang, "marketing");
      const h1 = t(d, "affiliates.h1", AFFILIATE_TERMS);
      expect(h1, lang).toContain(String(AFFILIATE_TERMS.percent));
      expect(h1, lang).toContain(String(AFFILIATE_TERMS.years));
    }
  });

  it("the terms move with the constant: other numbers produce other copy", async () => {
    const d = await getDictionary("en", "marketing");
    const other = t(d, "affiliates.h1", { percent: AFFILIATE_TERMS.percent + 7, years: AFFILIATE_TERMS.years + 1 });
    expect(other).not.toBe(t(d, "affiliates.h1", AFFILIATE_TERMS));
    expect(other).toContain(String(AFFILIATE_TERMS.percent + 7));
  });

  it("no dictionary hardcodes the numbers (they must stay placeholders)", async () => {
    const mustHold: Record<string, string[]> = {
      "affiliates.h1": ["{percent}", "{years}"],
      "affiliates.subhead": ["{percent}", "{years}"],
      "affiliates.card.2.body": ["{percent}", "{years}"],
      "affiliates.meta.description": ["{percent}", "{years}"],
      "affiliates.payout": ["{payoutDelayDays}", "{payoutMinimum}", "{payoutMethod}"],
    };
    let checked = 0;
    for (const lang of LOCALES) {
      const d = await getDictionary(lang, "marketing");
      for (const [key, placeholders] of Object.entries(mustHold)) {
        const raw = (d as Record<string, string>)[key];
        for (const ph of placeholders) {
          expect(raw, `${lang} ${key}`).toContain(ph);
          checked++;
        }
      }
    }
    expect(checked).toBe(LOCALES.length * 11); // anti-vacuity: 2+2+2+2+3 placeholders per locale
  });
});
