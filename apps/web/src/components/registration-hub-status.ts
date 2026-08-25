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
 *  configured, never "scheduled" (there is nothing scheduled to happen).
 *
 *  Boundary semantics (RS004 W3b review finding 2 — intentional, both ways):
 *   - BOTH instants are inclusive of "open": `now === opens_at` is already
 *     open (`now < opensAt` is false, so it falls through), and
 *     `now === closes_at` is STILL open (`now > closesAt` is false — closing
 *     happens the instant AFTER closes_at, not at it).
 *   - An INVERTED window (`closes_at` before `opens_at`) makes "open"
 *     unreachable: the `opens_at` check alone decides everything once
 *     `closes_at < opens_at`, since `now > closesAt` is then automatically
 *     true for every `now >= opensAt`. The status jumps straight from
 *     "scheduled" (`now < opens_at`) to "closed" (`now >= opens_at`) with no
 *     "open" in between. Not validated against here — a caller that wants to
 *     forbid an inverted window must reject it before this function ever
 *     sees it. */
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
