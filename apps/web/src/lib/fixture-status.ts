// Every value of fixtures.status (V214 + V432). Client-safe: no server-only. The status-set sweep
// (`lib/__tests__/status-set-sweep.test.ts`) classifies every OTHER list of these literals against this one, and
// V432's migration test holds the check constraint to it.
//
// W2a (spec §5.4.6, ruling 79): `needs_decision` — a play-produced level result in a bracket stage, held: played,
// not finished, nobody seated, closed by the organiser's `core.settle`.
export const FIXTURE_STATUSES = [
  "scheduled",
  "in_play",
  "decided",
  "finalized",
  "abandoned",
  "forfeited",
  "cancelled",
  "needs_decision",
] as const;
export type FixtureStatusValue = (typeof FIXTURE_STATUSES)[number];
