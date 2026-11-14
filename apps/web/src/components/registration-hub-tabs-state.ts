// B7 T22 — the registration hub's tab state (spec 2026-11-13 §9.1), pure and
// dependency-free like `registration-hub-tab.ts` beside it.
//
// The state is two facts carried in the URL:
//   - `open`: the division settings tabs, at most 2, LEAST recently used
//     first (`?open=<a>,<b>`). `open[0]` is the one a third tab evicts.
//   - `active`: the tab on screen (`?tab=settings|registrants|division:<id>`).
//
// `openable` is every non-archived division on the Settings tab (each row
// there has an "Open settings" button) when the viewer can edit, and empty
// when they cannot — so a viewer never gets a division tab.
//
// The interface, beyond the types:
//   - every function returns a fresh state and never writes to its input;
//   - every state any of them returns holds `open.length <= 2`, no duplicate
//     ids, and an active division that is in `open`;
//   - `parseHubTabs(hubTabsQuery(s), openable)` is `s` again, for every `s`
//     these functions produce over `openable`;
//   - `activate` and `openDivision` move the division they touch to the end
//     of `open` (most recently used); the URL's own order is otherwise kept.
//
// Preconditions: every function that TAKES a state needs one that
// `parseHubTabs` or a transition produced, and an id from `openable`. Build
// states no other way. The cap is checked (more than 2 open throws, naming
// the function); no duplicates and an open active division hold by
// construction, which the model test proves; that an id is openable is the
// caller's to keep, because `openable` is not passed to the transitions.
import { resolveRegistrationHubTab } from "@/components/registration-hub-tab";
import type { RegistrationHubTabParam } from "@/lib/routes";

export type HubTab = "settings" | "registrants" | { division: string };
export type HubTabsState = { active: HubTab; open: string[] };

/** Spec §9.1: "a comma list of up to 2 division ids". */
const MAX_OPEN = 2;
const DIVISION_TAB_PREFIX = "division:";
/** Every query param the tab state owns. */
const HUB_TAB_PARAMS = ["tab", "open"] as const;

/**
 * The hub's address as tab state.
 *
 * Normalisation, in this order (spec §9.1): ids not in `openable` are dropped;
 * duplicates are dropped, keeping the last mention (the list is least recently
 * used first, so the last mention is the latest use); the last 2 are kept; a
 * `tab=division:X` whose X is not in `open` by then is appended and the list
 * re-capped. An active division that does not survive becomes Settings, and
 * any other unrecognised `tab` falls back to Settings exactly as
 * `resolveRegistrationHubTab` does.
 *
 * A repeated param (Next hands `?open=a&open=b` over as a `string[]`, which
 * this parameter type cannot express) reads as its FIRST value — the house
 * rule, `firstOf` in the hub's data.ts and `URLSearchParams.get()`.
 */
export function parseHubTabs(params: { tab?: string; open?: string }, openable: ReadonlySet<string>): HubTabsState {
  const rawOpen = firstValue(params.open);
  const segments = rawOpen === undefined ? [] : rawOpen.split(",");
  let open = keepLastMention(segments.filter((id) => openable.has(id))).slice(-MAX_OPEN);

  const tab = firstValue(params.tab);
  const requested = divisionIdOf(tab);
  if (requested === null) return { active: resolveRegistrationHubTab(tab), open };
  if (openable.has(requested) && !open.includes(requested)) open = [...open, requested].slice(-MAX_OPEN);
  return { active: open.includes(requested) ? { division: requested } : "settings", open };
}

/** The `?tab=` value of a tab, in the route builder's own type. */
export function hubTabParam(active: HubTab): RegistrationHubTabParam {
  return typeof active === "string" ? active : `${DIVISION_TAB_PREFIX}${active.division}`;
}

/**
 * The state as query params: always `tab`, and `open` as one comma list when
 * any division tab is open. This is the WHOLE of the tab state, so never merge
 * it into a live address — a merge keeps a stale `open` after the last tab
 * closes, and the closed tab comes back. `replaceHubTabs` does it right.
 *
 * Refuses an id the comma list cannot carry (empty, or holding a comma): it
 * would come back from `parseHubTabs` as something else, or not at all.
 * Division ids are uuids, so this guards an assumption rather than a case.
 */
export function hubTabsQuery(s: HubTabsState): Record<string, string> {
  assertWithinCap(s, "hubTabsQuery");
  for (const id of s.open) {
    if (id === "" || id.includes(",")) {
      throw new Error(`hubTabsQuery: the division id ${JSON.stringify(id)} cannot ride in the URL's open list`);
    }
  }
  const query: Record<string, string> = { tab: hubTabParam(s.active) };
  if (s.open.length > 0) query.open = s.open.join(",");
  return query;
}

/**
 * A copy of `current` with its tab state REPLACED by `s`: every `tab` and
 * `open` in it is deleted (repeated copies included), then `s` is written.
 * Every other param — the Registrants filters, a page — rides along.
 */
export function replaceHubTabs(current: URLSearchParams, s: HubTabsState): URLSearchParams {
  const query = hubTabsQuery(s);
  const params = new URLSearchParams(current);
  for (const name of HUB_TAB_PARAMS) params.delete(name);
  for (const [name, value] of Object.entries(query)) params.set(name, value);
  return params;
}

/**
 * "Open settings" on a division row: the division's tab becomes active and the
 * most recently used. Opening one that is already open only moves it to the
 * end. Opening a third evicts `open[0]`, the least recently used, and reports
 * it, so the caller can ask about unsaved edits or offer Reopen (spec §9.2).
 */
export function openDivision(s: HubTabsState, id: string): { state: HubTabsState; evicted: string | null } {
  assertWithinCap(s, "openDivision");
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
  assertWithinCap(s, "activate");
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
  assertWithinCap(s, "closeDivision");
  const closesActive = typeof s.active !== "string" && s.active.division === id;
  return { active: closesActive ? "settings" : s.active, open: s.open.filter((other) => other !== id) };
}

/** The one precondition the functions above can check for themselves: a
 *  state over the cap was built by hand, and every answer from it would be
 *  wrong (opening a 4th id would silently drop two tabs and report one). */
function assertWithinCap(s: HubTabsState, caller: string): void {
  if (s.open.length > MAX_OPEN) {
    throw new Error(
      `${caller}: a hub tab state holds at most ${MAX_OPEN} open divisions, got ${s.open.length} (build it with parseHubTabs and the transitions)`,
    );
  }
}

/** A possibly-repeated query param as one string: the first value wins, and
 *  anything that is not a string (an empty array included) is absent. */
function firstValue(value: unknown): string | undefined {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

/** The division id of a `division:<id>` tab param, or null for any other value. */
function divisionIdOf(tab: string | undefined): string | null {
  return tab !== undefined && tab.startsWith(DIVISION_TAB_PREFIX) ? tab.slice(DIVISION_TAB_PREFIX.length) : null;
}

/** Each id once, at the position of its last mention. */
function keepLastMention(ids: readonly string[]): string[] {
  return ids.filter((id, index) => ids.lastIndexOf(id) === index);
}
