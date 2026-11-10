import "server-only";
// The court/venue half of "put a fixture back where it was", as SQL fragments - one rule for every writer that restores a
// slot from a record (history.ts's undo/redo/restore replays; match-day-call.ts's `endCall`, which Undo call, Unpair and
// Undo of Pair next run). A leaf module so both can import it with no cycle between them.
import type postgres from "postgres";

type Tx = postgres.TransactionSql;

/** A canonical uuid; a ledger payload's court or venue that is not one is skipped, never sent to Postgres. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The venue a court sits in: the ONE rule every fixture write derives
 *  `venue_id` by (schedule/board.ts `courtVenueIds`, moveFixture's "#5 fix") — a
 *  court belongs to a venue, so a fixture's venue is its court's, and no court
 *  means no venue. Every history write that sets `court_id` sets `venue_id`
 *  from it in the same statement; one that left it alone kept a cross-venue
 *  move's Undo in the venue it was moved to. */
export const venueOf = (tx: Tx, courtId: string | null) =>
  tx`(select c.venue_id from courts c where c.id = ${courtId})`;

/** The court a history write puts a fixture back on, if it still exists. A
 *  court deleted since (deleteCourt refuses only while a fixture is ON it, so
 *  a move away frees it) writes as no court — and `venueOf` then as no venue —
 *  never a dangling id: the court FK is DEFERRED, so that failed at COMMIT,
 *  and every retry replays the same court. Undo stuck for good. */
export const liveCourt = (tx: Tx, courtId: string | null) =>
  tx`(select c.id from courts c where c.id = ${courtId})`;

/** The `venue_id` a replay that writes `court_id = liveCourt(courtId)` sets:
 *  the new court's venue when the court CHANGES, the row's own otherwise — as
 *  `moveFixture` leaves the venue alone whenever the court is. A fixture can
 *  hold a venue with no court (`addFixture` takes a venue alone), and deriving
 *  it from the payload's court every time wiped that venue on the Undo of a
 *  time-only move, a pin or a shift. (`court_id` on the right of a SET is the
 *  row's value BEFORE the update.) */
export const venueWith = (tx: Tx, courtId: string | null) =>
  tx`case when court_id is distinct from ${liveCourt(tx, courtId)} then ${venueOf(tx, courtId)} else venue_id end`;

/** The `venue_id` a move replay writes. With NO court to put the fixture on, a
 *  payload side that carries the venue it stood in (`venue`, review 3 of #857,
 *  m5) puts that venue back: a venue-only fixture dragged onto a court and then
 *  undone lost its venue, because an absent court names none. A payload written
 *  before carries no `venue` key and replays exactly as before (`venueWith`).
 *  A venue deleted since writes as no venue, never a dangling id. */
export const venueBack = (tx: Tx, courtId: string | null, side: { venue?: unknown }) => {
  if (courtId !== null || side.venue === undefined) return venueWith(tx, courtId);
  const venue = typeof side.venue === "string" && UUID_RE.test(side.venue) ? side.venue : null;
  return tx`(select v.id from venues v where v.id = ${venue})`;
};
