// B7 T22 — the registration hub's tab state (spec 2026-11-13 §9.1), pure and
// dependency-free like `registration-hub-tab.ts` beside it.
//
// The state is two facts carried in the URL:
//   - `open`: the division settings tabs, at most 2, LEAST recently used
//     first (`?open=<a>,<b>`). `open[0]` is the one a third tab evicts.
//   - `active`: the tab on screen (`?tab=settings|registrants|division:<id>`).
//
// The interface, beyond the types:
//   - every function returns a fresh state and never writes to its input;
//   - every state any of them returns holds `open.length <= 2`, no duplicate
//     ids, and an active division that is in `open`;
//   - `parseHubTabs(hubTabsQuery(s), openable)` is `s` again, for every `s`
//     these functions produce over `openable`;
//   - `activate` and `openDivision` move the division they touch to the end
//     of `open` (most recently used); the URL's own order is otherwise kept.
import { resolveRegistrationHubTab } from "@/components/registration-hub-tab";

export type HubTab = "settings" | "registrants" | { division: string };
export type HubTabsState = { active: HubTab; open: string[] };

/** Spec §9.1: "a comma list of up to 2 division ids". */
const MAX_OPEN = 2;
const DIVISION_TAB_PREFIX = "division:";

/**
 * The hub's address as tab state. `openable` is the divisions that may have a
 * tab: those with registration settings in this competition when the viewer
 * can edit, and none when they cannot — so a viewer never gets a division tab.
 *
 * Normalisation, in this order (spec §9.1): ids not in `openable` are dropped;
 * duplicates are dropped, keeping the last mention (the list is least recently
 * used first, so the last mention is the latest use); the last 2 are kept; a
 * `tab=division:X` whose X is not in `open` by then is appended and the list
 * re-capped. An active division that does not survive becomes Settings, and
 * any other unrecognised `tab` falls back to Settings exactly as
 * `resolveRegistrationHubTab` does.
 *
 * A param that is not a string (Next hands a repeated `?open=a&open=b` over as
 * a `string[]`) reads as absent rather than throwing.
 */
export function parseHubTabs(params: { tab?: string; open?: string }, openable: ReadonlySet<string>): HubTabsState {
  const rawOpen = typeof params.open === "string" ? params.open.split(",") : [];
  let open = keepLastMention(rawOpen.filter((id) => openable.has(id))).slice(-MAX_OPEN);

  const requested = divisionIdOf(params.tab);
  if (requested === null) return { active: resolveRegistrationHubTab(params.tab), open };
  if (openable.has(requested) && !open.includes(requested)) open = [...open, requested].slice(-MAX_OPEN);
  return { active: open.includes(requested) ? { division: requested } : "settings", open };
}

/**
 * The state as query params: always `tab`, and `open` as one comma list when
 * any division tab is open. This is the WHOLE of the tab state, so a caller
 * building an href from it replaces both keys rather than merging into them —
 * a merge would keep a stale `open` after the last tab closed.
 *
 * Refuses an id the comma list cannot carry (empty, or holding a comma): it
 * would come back from `parseHubTabs` as something else, or not at all.
 * Division ids are uuids, so this guards an assumption rather than a case.
 */
export function hubTabsQuery(s: HubTabsState): Record<string, string> {
  for (const id of s.open) {
    if (id === "" || id.includes(",")) {
      throw new Error(`hubTabsQuery: the division id ${JSON.stringify(id)} cannot ride in the URL's open list`);
    }
  }
  const query: Record<string, string> = {
    tab: typeof s.active === "string" ? s.active : `${DIVISION_TAB_PREFIX}${s.active.division}`,
  };
  if (s.open.length > 0) query.open = s.open.join(",");
  return query;
}

/**
 * "Open settings" on a division row: the division's tab becomes active and the
 * most recently used. Opening one that is already open only moves it to the
 * end. Opening a third evicts `open[0]`, the least recently used, and reports
 * it, so the caller can ask about unsaved edits or offer Reopen (spec §9.2).
 */
export function openDivision(s: HubTabsState, id: string): { state: HubTabsState; evicted: string | null } {
  const open = [...s.open.filter((other) => other !== id), id];
  const evicted = open.length > MAX_OPEN ? open[0] : null;
  return { state: { active: { division: id }, open: open.slice(-MAX_OPEN) }, evicted };
}

/**
 * Switching tabs. Settings and Registrants leave `open` as it is; an activated
 * division moves to the end of `open`. A division that is not open has no tab
 * to switch to, so activating it changes nothing: opening is `openDivision`'s
 * job, because only it reports the tab an open evicts.
 */
export function activate(s: HubTabsState, tab: HubTab): HubTabsState {
  if (typeof tab === "string") return { active: tab, open: [...s.open] };
  if (!s.open.includes(tab.division)) return { active: s.active, open: [...s.open] };
  return {
    active: { division: tab.division },
    open: [...s.open.filter((other) => other !== tab.division), tab.division],
  };
}

/** The × on a division tab. Closing the active one lands on Settings; closing
 *  any other keeps the active tab. Closing an id that is not open changes
 *  nothing. */
export function closeDivision(s: HubTabsState, id: string): HubTabsState {
  const closesActive = typeof s.active !== "string" && s.active.division === id;
  return { active: closesActive ? "settings" : s.active, open: s.open.filter((other) => other !== id) };
}

/** The division id of a `division:<id>` tab param, or null for any other value. */
function divisionIdOf(tab: unknown): string | null {
  return typeof tab === "string" && tab.startsWith(DIVISION_TAB_PREFIX) ? tab.slice(DIVISION_TAB_PREFIX.length) : null;
}

/** Each id once, at the position of its last mention. */
function keepLastMention(ids: readonly string[]): string[] {
  return ids.filter((id, index) => ids.lastIndexOf(id) === index);
}
