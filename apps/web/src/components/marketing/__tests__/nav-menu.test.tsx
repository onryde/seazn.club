// The marketing nav's Product and Sports menus (nav-menu.tsx) and the link ledger behind them (product-nav.ts).
// Static render only: opening, Escape and outside-click are marketing-product.spec.ts's job (no DOM here).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NavMenu } from "../nav-menu";
import { MarketingMobileNav } from "../mobile-nav";
import { HELP_LINK, NAV_GROUPS, PRODUCT_LINKS, SPORT_LINKS, TOP_LINKS, navHrefs } from "@/lib/marketing/product-nav";
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
    // Blog is a top-level link between the Sports menu and Pricing; Help is the icon beside the sign-in actions (owner, 2026-11-19).
    expect(TOP_LINKS.map((l) => l.href)).toEqual(["/blog", "/pricing", "/live"]);
    expect(hrefs).toContain("/blog");
    expect(hrefs).toContain("/help");
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.length).toBe(PRODUCT_LINKS.length + SPORT_LINKS.length + TOP_LINKS.length + 1);
  });

  it("every label key exists in every locale", () => {
    let checked = 0;
    const keys = [...NAV_GROUPS.map((g) => g.key), ...NAV_GROUPS.flatMap((g) => g.links.map((l) => l.key)), ...TOP_LINKS.map((l) => l.key), HELP_LINK.key];
    for (const lang of LOCALES) for (const k of keys) {
      expect(DICTS[lang]![k], `${lang} ${k}`).toBeTruthy();
      checked++;
    }
    expect(checked).toBe(keys.length * 4);
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });
});

describe("nav menu descriptions", () => {
  it("every menu link has a one-line description and a drawing, in every locale, and no two read the same", () => {
    let checked = 0;
    for (const g of NAV_GROUPS) for (const l of g.links) {
      expect(l.icon, l.href).toBeTruthy();
      for (const lang of LOCALES) {
        const text = DICTS[lang]![l.desc];
        expect(text, `${lang} ${l.desc}`).toBeTruthy();
        // One line in the panel: short, and never a price or the banned phrase.
        expect(text!.length, `${lang} ${l.desc}`).toBeLessThanOrEqual(64);
        expect(text!).not.toMatch(/[$£€]\s?\d|tournament (format )?software/i);
        checked++;
      }
    }
    expect(checked).toBe((PRODUCT_LINKS.length + SPORT_LINKS.length) * 4);
    for (const lang of LOCALES) {
      const all = NAV_GROUPS.flatMap((g) => g.links.map((l) => DICTS[lang]![l.desc]));
      expect(new Set(all).size, lang).toBe(all.length);
    }
  });
});

describe("NavMenu", () => {
  const links = PRODUCT_LINKS.map((l) => ({ href: l.href, label: en[l.key as keyof typeof en], desc: en[l.desc as keyof typeof en], icon: <svg data-icon={l.icon} /> }));
  const html = renderToStaticMarkup(<NavMenu id="product" label="Product" links={links} />);

  it("renders a closed disclosure whose links are all in the markup", () => {
    expect(html).toMatch(/<button[^>]* aria-expanded="false"/);
    expect(html).toMatch(/<button[^>]* aria-controls="mk-menu-product"/);
    expect(html).toContain('id="mk-menu-product"');
    for (const l of links) expect(html).toContain(`href="${l.href}"`);
    expect(html.match(/<a /g)).toHaveLength(links.length);
  });

  it("each link carries its drawing, its name and its description, in a two-column panel", () => {
    for (const l of links) {
      const at = html.indexOf(`href="${l.href}"`);
      const row = html.slice(at, html.indexOf("</a>", at));
      expect(row, l.href).toContain("<svg data-icon=");
      expect(row, l.href).toContain(`>${l.label}<`);
      expect(row, l.href).toContain(`>${l.desc.replace(/'/g, "&#x27;")}<`);
    }
    expect(html).toMatch(/id="mk-menu-product"[^>]*class="[^"]*\bmk-menu-panel\b/);
  });

  it("is a desktop control: hidden below md, where the mobile panel carries the same links", () => {
    expect(html).toMatch(/class="[^"]*\bhidden\b[^"]*\smd:block"/);
  });
});

describe("mobile nav groups", () => {
  it("lists every nav href once, under its group heading", () => {
    const groups = NAV_GROUPS.map((g) => ({ label: en[g.key as keyof typeof en], links: g.links.map((l) => ({ href: l.href, label: en[l.key as keyof typeof en] })) }));
    const top = [...TOP_LINKS, HELP_LINK].map((l) => ({ href: l.href, label: en[l.key as keyof typeof en] }));
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
