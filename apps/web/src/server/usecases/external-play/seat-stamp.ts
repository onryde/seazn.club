// The per-SEAT invite stamp on the bridge row (`fixture_external_play.white_emailed_at` / `black_emailed_at`, V405, kept by
// V451) and the facts that decide whether a board still takes an invite.
//
// A LEAF module on purpose (ruling R1): it imports only a type from `postgres`. The email outbox's chess hook
// (invite-outbox-hook.ts) releases a seat when every email for it ended badly, and the outbox core must never import a usecase
// that imports the outbox back; this file is what the hook shares with invite.ts, so neither has to import the other.
// no-import-cycle.test.ts walks the real import graph and fails if a leaf stops being one.
//
// invite.ts re-exports everything here, so `import { claimSeat } from "./invite"` keeps working.
import type postgres from "postgres";

type AnySql = postgres.TransactionSql | postgres.Sql;

export type Colour = "white" | "black";

/** The outbox `ref_type` of a chess invite: what the email is about is one seat of one board. */
export const CHESS_SEAT_REF_TYPE = "fixture_seat";

/** The outbox `ref_id` of a chess invite: the board and the seat. With the recipient it is the key a newer invite replaces an
 *  older one by (the replace trigger), and the key the hook groups a seat's emails by. */
export const chessSeatRef = (fixtureId: string, colour: Colour): string => `${fixtureId}:${colour}`;

/** The bridge facts that decide whether a board can still be invited into,
 *  as read FRESH from the row (the guard's `BridgeRow` snapshot does not carry
 *  `create_sent_at`). */
export type InviteBridgeFacts = { status: string; challenge_id: string | null; create_sent_at: Date | null };

/** A bridge row that a game exists — or MAY exist — behind is never invited
 *  into and never re-attached: `challenge_id` is a recorded game; a
 *  `create_sent_at` marker is a create whose outcome is unknown (T9 I2); any
 *  status past `pending` is a game or an organiser's hold. No row at all takes
 *  invites. `attachToOpen` and `claimSeat` repeat this predicate in SQL. */
export function bridgeTakesInvites(b: InviteBridgeFacts | null): boolean {
  if (b === null) return true;
  return b.status === "pending" && b.challenge_id === null && b.create_sent_at === null;
}

export const STAMP_COLUMN = { white: "white_emailed_at", black: "black_emailed_at" } as const;

/**
 * THE rule for "this seat holds a stamp bound to this open" (pre-flight C15): the board's row names the open on screen
 * (`roundOpenId === openId`, an open that exists), and that colour's stamp is set. A stamp under an EARLIER open does not count: a
 * fixture moved to another round keeps the open id it was stamped under, and the new round's seat has not been invited. Both
 * readers ask it: `open-round-view.ts`'s `boundStamps` (what the round still owes) and the arbiter loader (whether a seat is "Not
 * invited" or "Not delivered"), so the two cannot disagree about what a stamp means.
 */
export function seatStampBound(
  row: { roundOpenId: string | null; whiteEmailedAt: Date | null; blackEmailedAt: Date | null },
  openId: string | null,
  colour: Colour,
): boolean {
  if (openId === null || row.roundOpenId !== openId) return false;
  return (colour === "white" ? row.whiteEmailedAt : row.blackEmailedAt) !== null;
}

/** Stamp one seat as invited, only if it is not already, on a row that names
 *  `roundOpenId` and has no game behind it. `true` ⇔ THIS call claimed it. */
export async function claimSeat(
  db: AnySql,
  fixtureId: string,
  colour: Colour,
  roundOpenId: string,
  at: Date,
): Promise<boolean> {
  const col = db(STAMP_COLUMN[colour]);
  const rows = await db<{ fixture_id: string }[]>`
    update fixture_external_play
       set ${col} = ${at}, updated_at = now()
     where fixture_id = ${fixtureId} and ${col} is null
       and round_open_id = ${roundOpenId}
       and status = 'pending' and challenge_id is null and create_sent_at is null
     returning fixture_id`;
  return rows.length === 1;
}

/** Undo THIS call's claim after its send failed, so the next open retries.
 *  Conditional on the exact stamp this call wrote — never clears another's.
 *  A row whose OTHER seat holds no stamp either was reached by nobody, so it
 *  is unbound from the open too: the binding is the round's record that
 *  someone was invited (openRound's "anyone invited?"), and a send that
 *  reached nobody is not that. */
export async function releaseSeat(db: AnySql, fixtureId: string, colour: Colour, at: Date): Promise<void> {
  const col = db(STAMP_COLUMN[colour]);
  const other = db(STAMP_COLUMN[colour === "white" ? "black" : "white"]);
  await db`
    update fixture_external_play
       set ${col} = null,
           round_open_id = case when ${other} is null then null else round_open_id end,
           updated_at = now()
     where fixture_id = ${fixtureId} and ${col} = ${at}`;
}

/** Unbind a row from the open when NEITHER seat holds a stamp: the binding is the round's record that someone was invited, and
 *  a board none of whose seats could be queued (their savepoints rolled back) reached nobody. The same rule `releaseSeat`
 *  applies to a seat it clears; this is for the seats that never got a stamp to clear. */
export async function unbindIfUnstamped(db: AnySql, fixtureId: string, roundOpenId: string): Promise<void> {
  await db`
    update fixture_external_play
       set round_open_id = null, updated_at = now()
     where fixture_id = ${fixtureId} and round_open_id = ${roundOpenId}
       and white_emailed_at is null and black_emailed_at is null`;
}
