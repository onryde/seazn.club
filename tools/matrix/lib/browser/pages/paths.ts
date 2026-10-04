// The routes the organiser page objects visit — apps/web/src/lib/routes.ts's
// own templates (competitionNew :26, competition :27, divisionNew :53,
// division :54-55, fixture :59-60, shared :65-66), restated because nothing is
// imported from apps/web (R3) and pinned to that file's text by
// page-objects.test.ts. The public division page reads `?tab=` on the client
// (public-site/use-tab-param.ts), so its tab rides the same query key.

/** The organiser division page's tabs a page object asks for — members of its
 *  `TABS` (d/[divSlug]/page.tsx:78; pinned). */
export const ORGANISER_TABS = ["entrants", "fixtures", "standings"] as const;
export type OrganiserTab = (typeof ORGANISER_TABS)[number];
/** The public division page's tab a page object asks for — one of its Tabs
 *  `ids` (shared/…/[divisionSlug]/page.tsx:529; pinned). */
export const PUBLIC_TABS = ["standings"] as const;
export type PublicTab = (typeof PUBLIC_TABS)[number];

export const paths = Object.freeze({
  competitionNew: (org: string): string => `/o/${org}/c/new`,
  competition: (org: string, comp: string): string => `/o/${org}/c/${comp}`,
  divisionNew: (org: string, comp: string): string => `/o/${org}/c/${comp}/d/new`,
  division: (org: string, comp: string, div: string, tab?: OrganiserTab): string =>
    tab ? `/o/${org}/c/${comp}/d/${div}?tab=${tab}` : `/o/${org}/c/${comp}/d/${div}`,
  fixture: (org: string, comp: string, div: string, no: number): string => `/o/${org}/c/${comp}/d/${div}/f/${no}`,
  publicDivision: (org: string, comp: string, div: string, tab?: PublicTab): string => {
    const page = ["/shared", org, comp, div].join("/");
    return tab ? `${page}?tab=${tab}` : page;
  },
});
