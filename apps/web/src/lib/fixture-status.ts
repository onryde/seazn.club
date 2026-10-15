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

/** The statuses whose ledger refuses every further append (finalized, cancelled) — the write path's lock
 *  (`server/engine-db/append-event.ts` re-exports it and refuses on it). Here, in the client-safe module, so a client
 *  reader that must agree with the lock (the live-fixture transport) imports the SAME set instead of copying it. */
export const LOCKED_FIXTURE_STATUSES: ReadonlySet<string> = new Set(["finalized", "cancelled"]);

/** Settled but not locked: the match has ended (a result, a walkover or an abandonment), yet the ledger still takes a
 *  write — an undo reopens it. Every status that is neither open (scheduled, in_play, the held needs_decision) nor
 *  locked. `server/usecases/carried-forward.ts` reads it as `SETTLED_OPEN_STATUSES`; the live-fixture transport reads
 *  it to listen for a bounded window after a match ends (`SETTLED_LISTEN_MS`). */
export const SETTLED_FIXTURE_STATUSES: ReadonlySet<string> = new Set(["decided", "forfeited", "abandoned"]);
