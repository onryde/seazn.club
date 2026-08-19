// Which stages can have a drifted board — the ONE definition.
//
// Deliberately its own module, and deliberately free of `server-only` and of
// any DB import: `usecases/stages.ts` (which owns getStageRosterDrift and
// rebuildStageFixtures) is server-only, so every test that renders the
// division page mocks it wholesale. When this rule lived there, the page's
// three test files each had to restate it in their mock — three copies of a
// rule, which is exactly the defect class F3's ultrareview findings 9 and 11
// were both instances of. Living here, the page and its tests import the real
// function and nobody has a stub to keep in sync.
//
// A stage qualifies when it draws its fixtures directly from the live active
// roster. That means no progression (a later stage either reads a FROZEN
// qualified list at completion, or generates pure-topology placeholders with
// no entrant reference at all), and not one of the two kinds that reference
// the roster in their own way: a ladder's fixtures come from individual
// challenges rather than a bulk generate, and an americano mints ephemeral
// `pair` entrants per fixture. Both would misreport ~100% of entrants as
// "unplaced" — see getStageRosterDrift's own doc comment for the long form.
export const ROSTER_DRIFT_INELIGIBLE_KINDS = new Set(["ladder", "americano"]);

export function isRosterDriftEligible(stage: { kind: string; progression: unknown }): boolean {
  return stage.progression === null && !ROSTER_DRIFT_INELIGIBLE_KINDS.has(stage.kind);
}
