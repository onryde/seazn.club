import "server-only";
// Creation (spec §3.3). Claim-then-call, the shape mintIfReady already uses
// (room.ts): claim with a conditional UPDATE, call Lichess OUTSIDE any
// transaction, then commit with an UPDATE conditional on the SAME claim
// stamp — so a takeover mid-flight cannot stomp another minter's work.
//
// White's token challenges Black's username and Black's token accepts.
// Colour is READ from the pairing (whiteSideOf), never assigned here — W3
// owns colour allocation.
//
// CreateOutcome has no "busy": a lost claim answers `not_ready`, which is
// retry-safe, rather than `already`, which would promise the work is done
// while the other claimant may still fail.
import { sql } from "@/lib/db";
import { loadOnlinePlayFixture, loadSides } from "./guard";

export type CreateOutcome =
  | { created: true; gameId: string }
  | { created: false; reason: "not_ready" | "already" | "unplayable" | "provider_error" | "no_person" };

export type CreateGameDeps = { now?: Date; publish?: (fixtureId: string) => Promise<void> };

/** The guard answers `null` for "not an online fixture" AND for a bye, so a
 *  bye cannot be told apart without this second read (plan premise P-B2-11).
 *  One query, only on the refusal path. */
async function classifyRefusedFixture(fixtureId: string): Promise<"no_person" | "not_ready"> {
  const [row] = await sql<{ home: string | null; away: string | null }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
  if (!row) return "not_ready";
  return row.home === null || row.away === null ? "no_person" : "not_ready";
}

export async function createGameIfReady(
  fixtureId: string,
  deps: CreateGameDeps = {},
): Promise<CreateOutcome> {
  void deps;
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) return { created: false, reason: await classifyRefusedFixture(fixtureId) };

  const { home, away } = await loadSides(f);
  // An unrostered entrant, or one whose sole member is a merge tombstone:
  // loadSides always returns a displayName but nulls personId
  // (guard.ts:223-271). There is nobody to seat, so this fixture is never
  // offered as an online match — it says so here rather than failing at
  // creation with a provider error nobody can read.
  if (home.personId === null || away.personId === null) {
    return { created: false, reason: "no_person" };
  }
  throw new Error("unimplemented: readiness and creation land in the next steps");
}
