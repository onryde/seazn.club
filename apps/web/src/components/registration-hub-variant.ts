// TEMP(RS004 variants) — sign-off scaffold for the registration hub's
// division-row and config-panel design directions (RS004 taste round). The
// owner has not yet approved a look; this file (and every other edit tagged
// `TEMP(RS004 variants)` across registration-hub-{settings-panel,division-
// row-b,division-row-c,config-panel-b,config-panel-c,config-panel-variant-
// state}.tsx and the registration hub page.tsx) exists ONLY so the owner can
// flip `?variant=` on the live hub and screenshot all three side by side.
// Delete this whole file, its test, and every other TEMP(RS004 variants)
// edit/file the moment a direction is picked — none of it is meant to
// outlive that decision. Variant "a" is today's shipped look and is never
// touched by this scaffold; "b"/"c" are the two alternatives under review.
//
// Mirrors registration-hub-tab.ts's `?tab=` whitelist pattern exactly: pure
// and dependency-free so it's testable without a DB row or a page mock.
export const REGISTRATION_HUB_VARIANTS = ["a", "b", "c"] as const;
export type RegistrationHubVariant = (typeof REGISTRATION_HUB_VARIANTS)[number];

/** Absent or unrecognised `?variant=` falls back to "a" — today's shipped
 *  look, so a bookmarked/shared URL with no `?variant=` (or a typo'd one)
 *  never accidentally shows an unapproved direction. */
export function resolveRegistrationHubVariant(raw: string | undefined): RegistrationHubVariant {
  return (REGISTRATION_HUB_VARIANTS as readonly string[]).includes(raw ?? "")
    ? (raw as RegistrationHubVariant)
    : "a";
}
