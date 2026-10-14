import "server-only";
// Final review P11: a player re-linked a DIFFERENT Lichess account. Every board of theirs whose game is live or
// mid-create was made for the OLD account, and the re-link has just revoked that account's grant (M-2), so nothing of
// theirs can move it from Seazn. Each such board goes to the organiser as `account_changed`. Called by the re-link
// (external-accounts.ts upsertLichessLink) after its own write commits; never throws, and never silent.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { holdForOrganiser } from "./result";

/** Hold `userId`'s live and mid-create boards for the organiser — the boards M-10's lock refuses to clear (stages.ts
 *  `lockBoardsRefusingOnlineGames`): a create sent (T9's `create_sent_at` marker: a game MAY exist), or a recorded
 *  game no read has seen end on a bridge our side has not closed. A board whose fixture is no longer playable is
 *  refused by the hold itself, and a board already held keeps its first diagnosis (holdForOrganiser). */
export async function holdBoardsOnAccountChange(userId: string, change: { from: string; to: string }): Promise<void> {
  let boards: { fixtureId: string }[];
  try {
    boards = await sql<{ fixtureId: string }[]>`
      select ep.fixture_id as "fixtureId"
        from fixture_external_play ep
        join fixtures f on f.id = ep.fixture_id
       where (ep.create_sent_at is not null
              or (ep.challenge_id is not null and ep.game_over_at is null and ep.status <> 'finished'))
         and exists (
           select 1 from entrant_members em
             join persons p on p.id = em.person_id
            where p.user_id = ${userId} and em.entrant_id in (f.home_entrant_id, f.away_entrant_id))
       order by ep.fixture_id`;
  } catch (err) {
    log.error(
      { userId, err: err instanceof Error ? err.message : String(err) },
      "lichess: re-link to a different account could not list the player's live boards — none was held for the organiser",
    );
    return;
  }
  const detail = `lichess account changed: ${change.from} → ${change.to}`;
  const held: string[] = [];
  for (const { fixtureId } of boards) {
    try {
      const r = await holdForOrganiser({ fixtureId, reason: "account_changed", detail });
      if (r.wrote === "needs_organiser" && r.reason === "account_changed") held.push(fixtureId);
    } catch (err) {
      log.error(
        { userId, fixtureId, err: err instanceof Error ? err.message : String(err) },
        "lichess: re-link to a different account could not hold a live board for the organiser",
      );
    }
  }
  if (held.length > 0) {
    log.info({ userId, fixtureIds: held }, "lichess: re-link to a different account held the player's live boards for the organiser");
  }
}
