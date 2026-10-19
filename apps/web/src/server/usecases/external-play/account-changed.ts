import "server-only";
// Final review P11: a player re-linked a DIFFERENT Lichess account. Every board of theirs whose game is live or
// mid-create was made for the OLD account, and the re-link has just revoked that account's grant (M-2), so nothing of
// theirs can move it from Seazn. Each such board goes to the organiser as `account_changed`. Called by the re-link
// (external-accounts.ts upsertLichessLink) after its own write commits; never throws, and never silent.
//
// Final re-review P11 (1): a seat hold, like token_revoked — the hold freezes THIS player's seat (V454
// `revoked_seat`), the opponent plays on, and reconcile keeps reading the game so its real end is recorded.
//
// Final re-review P11 (4): an UNLINK (`to: null`) leaves the same boards — recorded for an account no longer linked,
// whose grant the unlink revokes — and holds them as `token_revoked`: the unlink revokes Seazn's access, which is that
// reason's sentence, while `account_changed` would tell the organiser another account was linked. Same seat, same
// readers (both are SEAT_HOLD_REASONS).
//
// Final re-review 2, R2-1: a board mid-create records no colours yet, so its seat is the PAIRING's — whiteSideOf,
// the one rule T9 created the game by (and refuses to create past, if it moved) and the room reads before a game
// exists. A seat-less hold freezes both and blames nobody, so the player who changed nothing would read the same
// as the one who did.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { whiteSideOf } from "./guard";
import { holdForOrganiser, type RevokedSeat } from "./result";

/** The seat the player sits at on this board, by colour — null only when the colours could not be read. */
function seatOf(b: { whiteSide: "home" | "away" | null; home: boolean; away: boolean }): RevokedSeat | null {
  if (b.whiteSide === null) return null;
  if (b.home && b.away) return "both";
  const side = b.home ? "home" : "away";
  return side === b.whiteSide ? "white" : "black";
}

/** Hold `userId`'s live and mid-create boards for the organiser — the boards M-10's lock refuses to clear (stages.ts
 *  `lockBoardsRefusingOnlineGames`): a create sent (T9's `create_sent_at` marker: a game MAY exist), or a recorded
 *  game no read has seen end on a bridge our side has not closed. A board whose fixture is no longer playable is
 *  refused by the hold itself, and a board already held keeps its first diagnosis (holdForOrganiser). */
export async function holdBoardsOnAccountChange(userId: string, change: { from: string; to: string | null }): Promise<void> {
  const act = change.to === null ? "unlink" : "re-link to a different account";
  type Board = { fixtureId: string; orgId: string; whiteSide: "home" | "away" | null; home: boolean; away: boolean };
  let boards: Board[];
  try {
    boards = await sql<Board[]>`
      with mine as (
        select em.entrant_id from entrant_members em join persons p on p.id = em.person_id where p.user_id = ${userId})
      select ep.fixture_id as "fixtureId", ep.org_id as "orgId", ep.white_side as "whiteSide",
             f.home_entrant_id in (select entrant_id from mine) as home,
             f.away_entrant_id in (select entrant_id from mine) as away
        from fixture_external_play ep
        join fixtures f on f.id = ep.fixture_id
       where (ep.create_sent_at is not null
              or (ep.challenge_id is not null and ep.game_over_at is null and ep.status <> 'finished'))
         and (f.home_entrant_id in (select entrant_id from mine) or f.away_entrant_id in (select entrant_id from mine))
       order by ep.fixture_id`;
  } catch (err) {
    log.error(
      { userId, err: err instanceof Error ? err.message : String(err) },
      `lichess: ${act} could not list the player's live boards — none was held for the organiser`,
    );
    return;
  }
  const reason = change.to === null ? "token_revoked" : "account_changed";
  const detail = change.to === null ? `lichess account unlinked: ${change.from}` : `lichess account changed: ${change.from} → ${change.to}`;
  const held: string[] = [];
  for (const board of boards) {
    const { fixtureId } = board;
    let whiteSide = board.whiteSide;
    if (whiteSide === null) {
      try {
        whiteSide = await whiteSideOf(board);
      } catch (err) {
        // Held all the same, with no seat: both frozen, nobody blamed — never a board left unheld for want of a colour.
        log.error(
          { userId, fixtureId, err: err instanceof Error ? err.message : String(err) },
          `lichess: ${act} could not read a mid-create board's colours — held with no seat`,
        );
      }
    }
    const seat = seatOf({ ...board, whiteSide });
    try {
      const r = await holdForOrganiser({ fixtureId, reason, detail, ...(seat === null ? {} : { seat }) });
      if (r.wrote === "needs_organiser" && r.reason === reason) held.push(fixtureId);
    } catch (err) {
      log.error(
        { userId, fixtureId, err: err instanceof Error ? err.message : String(err) },
        `lichess: ${act} could not hold a live board for the organiser`,
      );
    }
  }
  if (held.length > 0) {
    log.info({ userId, fixtureIds: held }, `lichess: ${act} held the player's live boards for the organiser`);
  }
}
