// Registration hub tab derivation (RS004 W2) — pure and dependency-free so
// it is testable without any server/page mocking. Mirrors the division
// page's server-side `?tab=` pattern
// (app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:93-95) but this hub has
// no role-gated tab: the page itself is owner/admin-only (its own `canEdit`
// guard), so there is no `canEdit`-style narrowing here — both tabs are
// always offered to whoever reaches the page at all.
export const REGISTRATION_HUB_TABS = ["settings", "registrants"] as const;
export type RegistrationHubTab = (typeof REGISTRATION_HUB_TABS)[number];

/** Absent or unrecognised `?tab=` falls back to "settings" — the hub's
 *  landing tab (RS004 prompt scope item 1). */
export function resolveRegistrationHubTab(rawTab: string | undefined): RegistrationHubTab {
  return (REGISTRATION_HUB_TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as RegistrationHubTab)
    : "settings";
}
