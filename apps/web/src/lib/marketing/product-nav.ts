/**
 * The marketing nav's link ledger: one place for the header menus, the mobile panel, the footer's product column and
 * the "more of the product" chips on product pages. Pure data (no dictionary, no React) so the proxy tests, the nav
 * and the pages can all read it.
 *
 * Formats and Scheduling point at their product pages. The old `/formats`, `/scheduling`, `/use-cases/*` and
 * `/discover` routes are deleted, with no redirects (design: docs/superpowers/specs/2026-11-16-product-pages-design.md §6).
 */
/** `desc` is the one line under the name in a menu panel; `icon` names its drawing (a lucide icon for a product
 *  page, a sport key for a sport page: marketing-nav.tsx turns it into the picture). */
export type NavLink = { key: string; href: string; desc?: string; icon?: string };

export const PRODUCT_LINKS = [
  { key: "nav.product.registration", href: "/product/registration", desc: "nav.desc.registration", icon: "ticket" },
  { key: "nav.product.streaming", href: "/product/streaming", desc: "nav.desc.streaming", icon: "radio" },
  { key: "nav.product.remoteScoring", href: "/product/remote-scoring", desc: "nav.desc.remoteScoring", icon: "smartphone" },
  { key: "nav.formats", href: "/product/format", desc: "nav.desc.formats", icon: "trophy" },
  { key: "nav.scheduling", href: "/product/scheduling", desc: "nav.desc.scheduling", icon: "calendar-clock" },
  { key: "nav.product.matchDay", href: "/product/match-day", desc: "nav.desc.matchDay", icon: "clipboard-list" },
  { key: "nav.product.sponsoring", href: "/product/sponsoring", desc: "nav.desc.sponsoring", icon: "handshake" },
] as const satisfies readonly NavLink[];

export const SPORT_LINKS = [
  { key: "nav.sport.cricket", href: "/sports/cricket", desc: "nav.desc.sport.cricket", icon: "cricket" },
  { key: "nav.sport.badminton", href: "/sports/badminton", desc: "nav.desc.sport.badminton", icon: "badminton" },
  { key: "nav.sport.tabletennis", href: "/sports/table-tennis", desc: "nav.desc.sport.tabletennis", icon: "tabletennis" },
  { key: "nav.sport.volleyball", href: "/sports/volleyball", desc: "nav.desc.sport.volleyball", icon: "volleyball" },
  { key: "nav.sport.football", href: "/sports/football", desc: "nav.desc.sport.football", icon: "football" },
  { key: "nav.sport.tennis", href: "/sports/tennis", desc: "nav.desc.sport.tennis", icon: "tennis" },
  { key: "nav.sport.hockey", href: "/sports/hockey", desc: "nav.desc.sport.hockey", icon: "hockey" },
  { key: "nav.sport.icehockey", href: "/sports/ice-hockey", desc: "nav.desc.sport.icehockey", icon: "icehockey" },
  { key: "nav.sport.all", href: "/sports", desc: "nav.desc.sport.all", icon: "layout-grid" },
] as const satisfies readonly NavLink[];

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
