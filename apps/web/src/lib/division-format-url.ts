// FMT5: the division's format moved from Settings › Format onto the Fixtures tab's Division rules card, behind its Format
// button. Settings › Format never had an address of its own (it was a group on `?tab=settings`), so the addresses that
// asked for it by name - `?tab=format`, and the Settings tab asked for its format section - land on the Fixtures tab with the
// Format dialog open. `?tab=settings` itself still opens Settings, which keeps one line pointing at the card.
import { routes } from "@/lib/routes";

type Slug = string;

/** The Format dialog's own address: the division's Fixtures tab with the dialog open. */
export function formatDialogHref(org: Slug, comp: Slug, div: Slug): string {
  return `${routes.division(org, comp, div, "fixtures")}&format=open`;
}

/** An address that asked for Settings › Format by name. */
export function isOldFormatAddress(query: { tab?: string; section?: string }): boolean {
  return query.tab === "format" || (query.tab === "settings" && query.section === "format");
}

/** Did the address ask for the Format dialog open? */
export function formatDialogAsked(query: { format?: string }): boolean {
  return query.format === "open";
}
