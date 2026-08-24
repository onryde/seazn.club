// Registration hub — Settings tab row status pill (RS004 W3, design §5).
// Pure and dependency-free (matches registration-hub-tab.ts's convention) so
// every boundary is unit-testable without a DB row or a clock mock.
//
// Deliberately NOT `registrations.ts`'s `windowOpen` (a boolean): that helper
// answers "can a submission land right now", collapsing "not yet open" and
// "closed" into the same false. An organiser's row needs the three-way
// distinction — open|scheduled|closed — so this is its own small derivation,
// same enabled+window inputs, richer output.
export type RegistrationHubStatus = "open" | "scheduled" | "closed";

export interface RegistrationWindowInput {
  enabled: boolean;
  opens_at: Date | string | null;
  closes_at: Date | string | null;
}

/** `enabled` + window + `now` → open|scheduled|closed. `enabled: false` wins
 *  outright — a disabled division reads "closed" even with a future window
 *  configured, never "scheduled" (there is nothing scheduled to happen). */
export function deriveRegistrationStatus(
  settings: RegistrationWindowInput,
  now: Date,
): RegistrationHubStatus {
  if (!settings.enabled) return "closed";
  const opensAt = settings.opens_at ? new Date(settings.opens_at) : null;
  const closesAt = settings.closes_at ? new Date(settings.closes_at) : null;
  if (opensAt && now < opensAt) return "scheduled";
  if (closesAt && now > closesAt) return "closed";
  return "open";
}
