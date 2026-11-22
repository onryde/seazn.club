// W5 follow-ups B3: the public division page's tabs, by their URL-facing ids (`?tab=`, never translated: a shared link
// survives the reader's locale). The page server-renders only the active one; the proxy sends `?tab=standings` and
// `?tab=entrants` to their own ISR document (`src/proxy.ts` `divisionTabRewrite`). Shared by both, so the two cannot
// disagree about which ids are tabs.
export const DIVISION_TABS = ["schedule", "standings", "entrants"] as const;
export type DivisionTab = (typeof DIVISION_TABS)[number];

/** The tabs that have a document of their own (`tab/[tab]`); Schedule is the bare route. */
export const ROUTED_DIVISION_TABS: readonly DivisionTab[] = ["standings", "entrants"];

/** The tab a `tab/[tab]` param names: absent is Schedule (the bare route); a routed tab is itself; anything else is null. */
export function divisionTabOf(param: string | undefined): DivisionTab | null {
  if (param === undefined) return "schedule";
  return (ROUTED_DIVISION_TABS as readonly string[]).includes(param) ? (param as DivisionTab) : null;
}
