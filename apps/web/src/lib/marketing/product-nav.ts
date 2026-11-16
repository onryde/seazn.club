/**
 * The marketing nav's link ledger: one place for the header menus, the mobile panel, the footer's product column and
 * the "more of the product" chips on product pages. Pure data (no dictionary, no React) so the proxy tests, the nav
 * and the pages can all read it.
 *
 * `/formats` and `/scheduling` are the OLD pages. They stay listed until the wave that replaces each one lands
 * (design: docs/superpowers/specs/2026-11-16-product-pages-design.md §10); nothing is deleted before then.
 */
export type NavLink = { key: string; href: string };

export const PRODUCT_LINKS = [
  { key: "nav.product.streaming", href: "/product/streaming" },
  { key: "nav.formats", href: "/formats" },
  { key: "nav.scheduling", href: "/scheduling" },
] as const satisfies readonly NavLink[];

export const SPORT_LINKS = [{ key: "nav.sport.cricket", href: "/sports/cricket" }] as const satisfies readonly NavLink[];

export const TOP_LINKS = [
  { key: "nav.pricing", href: "/pricing" },
  { key: "nav.live", href: "/live" },
] as const satisfies readonly NavLink[];

/** The two disclosure menus, in bar order. */
export const NAV_GROUPS = [
  { id: "product", key: "nav.product", links: PRODUCT_LINKS },
  { id: "sports", key: "nav.sports", links: SPORT_LINKS },
] as const;

export function navHrefs(): string[] {
  return [...NAV_GROUPS.flatMap((g) => g.links.map((l) => l.href)), ...TOP_LINKS.map((l) => l.href)];
}
