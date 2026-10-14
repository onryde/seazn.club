import "server-only";
// T16 (T20 review m1) — `/me`'s Lichess card. The player home is not club-scoped, but a link start must name a club
// (online chess is offered per club — lib/lichess-link.ts), so the start names a club that is offered online chess
// AND in which this player is entered in a division that plays online: the club the link is FOR. A club-A admin
// entered via club B (B offered, A not) links through B. Asked per (club, player), the flag's own grain.
import { sql } from "@/lib/db";
import { getLichessLink, lichessGrantPlays } from "./external-accounts";
import { onlineChessOffered } from "./external-play/online-chess-flag";

export type MyLichessLink = {
  /** Render the card: linked (so the player can unlink or re-link), or a club to link for. */
  show: boolean;
  linkedUsername: string | null;
  /** Linked, but the grant is not enough to play (the play gate would refuse LICHESS_RECONSENT_REQUIRED). */
  needsReconsent: boolean;
  /** The club the link / re-link start names; null ⇒ no start to offer. */
  orgSlug: string | null;
};

/** Rostered entrant statuses — an entry that still plays (me.ts's ROSTERED). */
const ROSTERED = ["registered", "confirmed"];

export async function myLichessLink(userId: string): Promise<MyLichessLink> {
  const link = await getLichessLink(userId);
  // Every club where one of this login's claimed players is entered, still rostered, in an online chess division that
  // is not over. `config ->> 'onlinePlay'` is the column readOnlinePlay reads (anything but 'lichess' is off).
  const clubs = await sql<{ orgId: string; slug: string }[]>`
    select distinct o.id as "orgId", o.slug, o.name
      from persons p
      join entrant_members em on em.person_id = p.id
      join entrants e on e.id = em.entrant_id and e.status in ${sql(ROSTERED)}
      join divisions d on d.id = e.division_id
      join organizations o on o.id = d.org_id
     where p.user_id = ${userId} and p.merged_into is null
       and d.sport_key = 'boardgame' and d.config ->> 'onlinePlay' = 'lichess'
       and d.status <> 'completed'
     order by o.name, o.id`;
  let orgSlug: string | null = null;
  for (const c of clubs) {
    if (await onlineChessOffered({ orgId: c.orgId, userId })) {
      orgSlug = c.slug;
      break;
    }
  }
  return {
    show: link !== null || orgSlug !== null,
    linkedUsername: link?.username ?? null,
    needsReconsent: link !== null && !lichessGrantPlays(link),
    orgSlug,
  };
}
