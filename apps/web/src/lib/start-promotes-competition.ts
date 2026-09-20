// Does starting a division also move its PARENT competition's status?
//
// `startDivision` (`server/usecases/schedule.ts`) ends its status transaction
// with `update competitions set status = 'live' where id = ${…} and status =
// 'published'`. The guard is the `where`, so the promotion happens for exactly
// ONE prior status and for no other: a `draft` competition is left alone (to
// promote it would publish something nobody published), and `completed` /
// `archived` are left alone in the other direction.
//
// Client-safe on purpose, exactly like `open-entry-stages.ts` beside it: the
// Start-tournament confirmation has to know whether the promotion really
// happens before it says so, and that dialog is a client island
// (`components/v2/launch-actions.tsx`). Importing the usecase would drag
// `server-only` into the browser bundle, so the two literals are mirrored here
// and `__tests__/start-promotes-competition.test.ts` reds if they drift.
export const COMPETITION_STATUS_START_PROMOTES_FROM = "published";
export const COMPETITION_STATUS_START_PROMOTES_TO = "live";

/**
 * Will starting a division in this competition move the competition's status?
 *
 * Mirrors the server's `where` exactly — an equality, not a set — so every
 * other status (including one this build has never heard of) answers false and
 * the dialog stays quiet rather than guessing.
 */
export function startPromotesCompetition(competitionStatus: string): boolean {
  return competitionStatus === COMPETITION_STATUS_START_PROMOTES_FROM;
}
