// Client-safe facts about online chess (T20), shared by the server's start gates and the islands that read their
// refusals — the gate module itself is server-only (it asks PostHog), so an island cannot import the code from there.
import { CHESS_SPORT_KEY } from "@/lib/chess-individual-only-rule";

/** The refusal every server-side start gate answers with while the club is not offered online chess (403). */
export const ONLINE_CHESS_DISABLED_CODE = "ONLINE_CHESS_DISABLED";

/** Does a division of this sport draw the Online play control - the one that switches a chess division onto Lichess? Only chess
 *  does, and only while the club is offered online chess (the PostHog flag `online-chess`, asked by the page). The Division rules
 *  strip draws the control by this answer, and Settings' pointer to the strip names online play by the same one, so the sentence
 *  never promises a control the strip does not show. */
export function onlinePlayShown(sportKey: string, onlineChessOffered: boolean): boolean {
  return sportKey === CHESS_SPORT_KEY && onlineChessOffered;
}
