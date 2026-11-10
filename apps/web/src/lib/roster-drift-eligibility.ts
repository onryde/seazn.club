// Which stages can have a drifted board — the ONE definition.
//
// Deliberately its own module, and deliberately free of `server-only` and of
// any DB import: `usecases/stages/roster-drift.ts` (which owns getStageRosterDrift and
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

/**
 * A swiss stage that is simply BETWEEN ROUNDS, not drifted (W3 item 6).
 *
 * Swiss pairs one round at a time. After the bye-row follow-up, a designed
 * sit-out is a real forfeited fixture and no longer appears in `unplaced` —
 * this predicate now mainly covers an entrant added before the next round
 * is generated (genuine late registration shape, still unplaced-only).
 * Ghosts keep the full warning and rebuild button.
 *
 * Deliberately NOT `ROSTER_DRIFT_INELIGIBLE_KINDS` (the design doc's option
 * 3): ineligibility suppresses BOTH halves, taking ghost detection with it. A
 * withdrawn entrant still named on a live fixture is drift on a swiss stage
 * exactly as anywhere else, so any ghost keeps the full warning and the
 * rebuild button.
 */
export function swissAwaitingPairing(
  kind: string,
  drift: { ghosts: readonly unknown[]; unplaced: readonly unknown[] },
): boolean {
  return kind === "swiss" && drift.ghosts.length === 0 && drift.unplaced.length > 0;
}

/**
 * Whether a stage's board no longer matches its roster — the ONE test the drift banner (with its Rebuild) and Update draw's
 * offer both read (stages-panel.tsx), so the two cannot disagree. Any direction is drift: a ghost (named on a match still
 * to be played, no longer active), an unplaced entrant (active, on no match), or — W4 B2 fix round 2, item 1 — an empty
 * first-round place on a root knockout (`vacantLines`: an entrant DELETED, so nobody is named and nobody is missing).
 * Optional `vacantLines`: a payload that predates the field is read as none.
 */
export function rosterDriftShown(
  drift: { ghosts: readonly unknown[]; unplaced: readonly unknown[]; vacantLines?: number } | undefined,
): boolean {
  if (drift === undefined) return false;
  return drift.ghosts.length > 0 || drift.unplaced.length > 0 || (drift.vacantLines ?? 0) > 0;
}
