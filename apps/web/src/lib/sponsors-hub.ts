// The Sponsors hub's tab rules (R4 sponsors-on-stream S11; spec 2026-10-27 §5.1).
//
// `/o/[orgSlug]/sponsors?tab=...` is a top-level console page (it left Settings), so its tab list, who may see which
// tab, and the redirect from the old Settings URL live here, pure and dependency-free: the page, the dashboard entry
// and the tests all read ONE declaration. Mirrors `registration-hub-tab.ts` (the hub's `?tab=` is read server-side;
// there is no client tabs component in this repo).
//
// Who sees what (R19, from the existing Settings -> Sponsors guard, reused):
//   - Settings never REFUSED a non-editor. It rendered a read-only view: `OrgSponsors canEdit={false}` and no
//     packages. The hub keeps exactly that - Overview and Sponsors are readable by every member, and the tabs that
//     only make sense to someone who can change things (On stream, Packages and orders) are not offered to a
//     non-editor and fall back to Overview if asked for by URL. The WRITE paths stay guarded by their own routes.
import { routes } from "@/lib/routes";

/** The hub's tabs, in the order they are laid out. Overview is the landing tab (S13 fills it); On stream is S12's. */
export const SPONSORS_TABS = ["overview", "sponsors", "on_stream", "packages"] as const;
export type SponsorsTab = (typeof SPONSORS_TABS)[number];

/** Tabs a non-editor is not offered (R19). A subset of `SPONSORS_TABS`; never contains the landing tab. */
export const SPONSORS_EDITOR_ONLY_TABS: readonly SponsorsTab[] = ["on_stream", "packages"];

/** The tabs this reader is offered, in layout order. */
export function sponsorsTabsFor(canEdit: boolean): readonly SponsorsTab[] {
  return canEdit ? SPONSORS_TABS : SPONSORS_TABS.filter((tab) => !SPONSORS_EDITOR_ONLY_TABS.includes(tab));
}

/** The tab to show for a raw `?tab=`: the one asked for if this reader is offered it, else Overview (absent, empty,
 *  unknown, or editor-only for a non-editor). `includes` on an array, never a keyed lookup, so `__proto__` and
 *  `constructor` are not tabs. */
export function resolveSponsorsTab(rawTab: string | undefined, canEdit: boolean): SponsorsTab {
  const offered = sponsorsTabsFor(canEdit);
  return offered.find((tab) => tab === rawTab) ?? SPONSORS_TABS[0];
}

/** `/o/<slug>/sponsors` (the landing tab) or `/o/<slug>/sponsors?tab=<tab>`. */
export function sponsorsHref(orgSlug: string, tab?: SponsorsTab): string {
  return routes.orgSponsors(orgSlug, tab);
}

/** `/o/<slug>/sponsors?tab=on_stream`, or with `&scope=<competitionId>` for one competition's own setting (the On stream tab's
 *  picker; no scope = the organisation-wide one). */
export function onStreamHref(orgSlug: string, competitionId?: string | null): string {
  const base = sponsorsHref(orgSlug, "on_stream");
  return competitionId ? `${base}&scope=${encodeURIComponent(competitionId)}` : base;
}

/** The competition a raw `?scope=` names, or null (the organisation-wide scope) when it is absent, repeated, empty or not one
 *  of THIS org's competitions - a foreign or made-up id is never a scope, so the loader is only ever asked about the org's own. */
export function resolveOnStreamScope(
  raw: string | string[] | undefined,
  competitions: readonly { id: string }[],
): string | null {
  return typeof raw === "string" ? (competitions.find((c) => c.id === raw)?.id ?? null) : null;
}

/**
 * Where `/o/<slug>/settings?tab=sponsors` goes now: the hub's Sponsors tab.
 *
 * Every OTHER query param is KEPT (after `tab`), the way the legacy `/settings/payments` redirect keeps its query: a
 * link minted before the move - a bookmark, a return URL - carries state the new page may still read, and a redirect
 * that silently dropped it would lose that without a trace. `tab` itself is always forced to `sponsors`, so an
 * incoming `tab` (the one that sent us here) can neither be repeated nor override it. Repeated params stay repeated;
 * `undefined` values are dropped; values are encoded.
 */
export function legacySettingsSponsorsTarget(
  orgSlug: string,
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const rest = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) rest.append(key, v);
  }
  const base = sponsorsHref(orgSlug, "sponsors");
  const qs = rest.toString();
  return qs ? `${base}&${qs}` : base;
}
