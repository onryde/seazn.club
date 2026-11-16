// The marketing nav's Product and Sports menus (nav-menu.tsx) and the link ledger behind them (product-nav.ts).
// Static render only: opening, Escape and outside-click are marketing-product.spec.ts's job (no DOM here).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NavMenu } from "../nav-menu";
import { MarketingMobileNav } from "../mobile-nav";
import { NAV_GROUPS, PRODUCT_LINKS, SPORT_LINKS, TOP_LINKS, navHrefs } from "@/lib/marketing/product-nav";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };

describe("product nav ledger", () => {
  it("offers the new pages, keeps an old one until its replacement lands, and has no duplicate href", () => {
    const hrefs = navHrefs();
    expect(hrefs).toContain("/product/streaming");
    expect(hrefs).toContain("/sports/cricket");
    expect(hrefs).toContain("/product/remote-scoring");
    // Formats now points at its product page; the old gallery route is no longer linked from the nav.
    expect(hrefs).toContain("/product/format");
    expect(hrefs).not.toContain("/formats");
    expect(hrefs).toContain("/product/scheduling");
    expect(hrefs).toContain("/product/sponsoring");
    expect(hrefs).toContain("/product/match-day");
    expect(hrefs).toContain("/sports");
    expect(hrefs).not.toContain("/scheduling");
    expect(hrefs).toContain("/pricing");
    expect(hrefs).toContain("/live");
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.length).toBe(PRODUCT_LINKS.length + SPORT_LINKS.length + TOP_LINKS.length);
  });

  it("every label key exists in every locale", () => {
    let checked = 0;
    const keys = [...NAV_GROUPS.map((g) => g.key), ...NAV_GROUPS.flatMap((g) => g.links.map((l) => l.key)), ...TOP_LINKS.map((l) => l.key)];
    for (const lang of LOCALES) for (const k of keys) {
      expect(DICTS[lang]![k], `${lang} ${k}`).toBeTruthy();
      checked++;
    }
    expect(checked).toBe(keys.length * 4);
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });
});

describe("NavMenu", () => {
  const links = PRODUCT_LINKS.map((l) => ({ href: l.href, label: en[l.key as keyof typeof en] }));
  const html = renderToStaticMarkup(<NavMenu id="product" label="Product" links={links} />);

  it("renders a closed disclosure whose links are all in the markup", () => {
    expect(html).toMatch(/<button[^>]* aria-expanded="false"/);
    expect(html).toMatch(/<button[^>]* aria-controls="mk-menu-product"/);
    expect(html).toContain('id="mk-menu-product"');
    for (const l of links) expect(html).toContain(`href="${l.href}"`);
    expect(html.match(/<a /g)).toHaveLength(links.length);
  });

  it("is a desktop control: hidden below md, where the mobile panel carries the same links", () => {
    expect(html).toMatch(/class="[^"]*\bhidden\b[^"]*\smd:block"/);
  });
});

describe("mobile nav groups", () => {
  it("lists every nav href once, under its group heading", () => {
    const groups = NAV_GROUPS.map((g) => ({ label: en[g.key as keyof typeof en], links: g.links.map((l) => ({ href: l.href, label: en[l.key as keyof typeof en] })) }));
    const top = TOP_LINKS.map((l) => ({ href: l.href, label: en[l.key as keyof typeof en] }));
    const html = renderToStaticMarkup(<MarketingMobileNav groups={groups} links={top} openLabel="Open menu" closeLabel="Close menu" />);
    let checked = 0;
    for (const href of navHrefs()) {
      expect(html.split(`href="${href}"`), href).toHaveLength(2);
      checked++;
    }
    expect(checked).toBe(navHrefs().length);
    for (const g of groups) expect(html).toContain(`>${g.label}</p>`);
    expect(html.indexOf(">Product</p>")).toBeLessThan(html.indexOf('href="/product/streaming"'));
    expect(html.indexOf('href="/product/streaming"')).toBeLessThan(html.indexOf(">Sports</p>"));
  });
});
