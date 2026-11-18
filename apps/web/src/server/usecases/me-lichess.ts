import "server-only";
// T16 (T20 review m1, reworked 2026-11-18) — `/me`'s Lichess card. The player home is not club-scoped, and neither is
// linking: the card is shown to EVERY signed-in player (owner 2026-11-18), so the reader no longer decides whether to
// render a card, and no longer works out which club the link is "for" — the link start names none
// (`lichessLinkStartHref(null, …)`). What is left is the player's own state: the account they linked, and whether its
// grant is still enough to play.
import { getLichessLink, lichessGrantPlays } from "./external-accounts";

export type MyLichessLink = {
  /** The linked Lichess username (so the player can unlink or re-link); null when not linked. */
  linkedUsername: string | null;
  /** Linked, but the grant is not enough to play (the play gate would refuse LICHESS_RECONSENT_REQUIRED). */
  needsReconsent: boolean;
};

export async function myLichessLink(userId: string): Promise<MyLichessLink> {
  const link = await getLichessLink(userId);
  return {
    linkedUsername: link?.username ?? null,
    needsReconsent: link !== null && !lichessGrantPlays(link),
  };
}
