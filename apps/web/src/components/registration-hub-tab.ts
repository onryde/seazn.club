// Registration hub tab derivation (RS004 W2) — pure and dependency-free so
// it is testable without any server/page mocking. Mirrors the division
// page's server-side `?tab=` pattern
// (app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:93-95).
//
// RS005 (owner ruling, 2026-08-25, reverses RS004 ruling 2): the hub is NOT
// owner/admin-only any more — a viewer reaches it too, read-only. There is
// still no `canEdit`-style narrowing HERE: both tabs are always offered to
// whoever reaches the page at all (a scorer never does — that 404 happens
// inside `requireCompetitionPage` itself, before `?tab=` is ever read).
// `canEdit` now travels as a per-panel PROP instead, deciding which of a
// panel's own controls are mutating — see page.tsx.
export const REGISTRATION_HUB_TABS = ["settings", "registrants"] as const;
export type RegistrationHubTab = (typeof REGISTRATION_HUB_TABS)[number];

/** Absent or unrecognised `?tab=` falls back to "settings" — the hub's
 *  landing tab (RS004 prompt scope item 1). */
export function resolveRegistrationHubTab(rawTab: string | undefined): RegistrationHubTab {
  return (REGISTRATION_HUB_TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as RegistrationHubTab)
    : "settings";
}
