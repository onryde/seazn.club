import "server-only";
// T16 — "Let the game go on" (chess design D10, §7): the organiser has
// reviewed a board's fair-play flags and the game carries on. Flags are
// evidence, never sanctions: closing one changes no result and no seat, and
// the row stays on file with WHO closed it and WHEN — V439's resolution pair
// (closed_at, resolved_by) is the audit record (controller ruling
// 2026-10-12: one authority per fact).
//
// Exactly what the organiser SAW is closed (ruling A): the ids the panel or
// the queue listed, never "every open flag on the board" — a flag raised
// after the screen loaded is new evidence nobody has looked at yet, and stays
// open. Closing an id already closed changes nothing: the first resolver and
// time stand.
//
// Never gated by the online-chess flag: it decides about play already under
// way (T20). fixture_play_flags is SEALED (FORCE RLS, no app_user policy):
// read and written with the privileged `sql`, only after the caller's
// organisation has been proven to own the fixture.
import type { AuthCtx } from "@/server/api-v1/auth";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isSeatedOn } from "./seated";

export type FlagsClosed = {
  /** Flags this call closed (an id already closed is not counted again). */
  closed: number;
  /** Flags still open on the board afterwards — raised since the screen
   *  loaded, or never shown on it. */
  stillOpen: number;
};

/** A request carries at most this many ids: one board's flags, as a panel or
 *  queue row shows them. */
export const MAX_FLAGS_PER_CLOSE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function closeExternalPlayFlags(auth: AuthCtx, fixtureId: string, flagIds: readonly string[]): Promise<FlagsClosed> {
  if (auth.via !== "session" || auth.userId === null) {
    throw new HttpError(403, "Letting a game go on needs a signed-in organiser", "ORGANISER_SESSION_REQUIRED");
  }
  const actorUserId = auth.userId;
  const ids = [...new Set(flagIds)];
  if (ids.length === 0 || ids.length > MAX_FLAGS_PER_CLOSE || !ids.every((id) => UUID.test(id))) {
    throw new HttpError(422, `name between 1 and ${MAX_FLAGS_PER_CLOSE} flags to close`, "FLAG_IDS_INVALID");
  }
  const [fixture] = await sql<{ org_id: string }[]>`select org_id from fixtures where id = ${fixtureId}`;
  if (!fixture || fixture.org_id !== auth.orgId) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  // Conflict of interest (ruling C): an organiser who plays on the board
  // would be dismissing evidence about their own game.
  if (await isSeatedOn(actorUserId, fixtureId)) {
    throw new HttpError(403, "You play on this board, so another organiser must review its flags", "ARBITER_PLAYS_THIS_BOARD");
  }
  return sql.begin(async (tx) => {
    // Every id must be one of THIS board's flags: a stray id is a client
    // bug or a forged request, refused whole rather than half-applied.
    const owned = await tx<{ id: string }[]>`
      select id from fixture_play_flags
       where fixture_id = ${fixtureId} and org_id = ${auth.orgId} and id in ${tx(ids)}
         for update`;
    if (owned.length !== ids.length) throw new HttpError(404, "flag not found on this board", "FLAG_NOT_FOUND");
    const closed = await tx`
      update fixture_play_flags
         set closed_at = now(), resolved_by = ${actorUserId}
       where fixture_id = ${fixtureId} and id in ${tx(ids)} and closed_at is null
       returning id`;
    const [open] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixture_play_flags
       where fixture_id = ${fixtureId} and closed_at is null`;
    return { closed: closed.length, stillOpen: open?.n ?? 0 };
  });
}
