// Client-safe facts about online chess (T20), shared by the server's start gates and the islands that read their
// refusals — the gate module itself is server-only (it asks PostHog), so an island cannot import the code from there.
import { CHESS_SPORT_KEY } from "@/lib/chess-individual-only-rule";

/** The refusal every server-side start gate answers with while the club is not offered online chess (403). */
export const ONLINE_CHESS_DISABLED_CODE = "ONLINE_CHESS_DISABLED";

/** The most entrants one ONLINE chess division holds, on every plan (owner ruling 2026-11-21). A CAPACITY limit, not a plan
 *  upsell: no plan lifts it, so its refusal carries no upgrade wording. It is sized to what the platform can run - 128 players
 *  are 64 boards, and every board's check-in spends from the RealtimeKit call budget (server/external-play/video/budget.ts).
 *  Over-the-board chess and every other sport keep the plan's own per-division cap (`entrants.per_division.max`). The server
 *  enforces it as min(plan cap, this) at every door that grows an online division (server/external-play/online-entrant-cap.ts);
 *  declared here, client-safe, so the islands that say the refusal read the same number. */
export const ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION = 128;

/** 422: an entrant (or a place) was refused because an online chess division already holds `ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION`
 *  entrants. Never a 402: an upgrade does not lift it. The error body carries `limit`. */
export const ONLINE_DIVISION_FULL = "ONLINE_DIVISION_FULL";

/** 422: turning online play ON was refused because the division already holds more entrants than an online chess division may.
 *  The body carries `limit` and `entrants` (how many it holds). Remove entrants first. */
export const ONLINE_PLAY_TOO_MANY_ENTRANTS = "ONLINE_PLAY_TOO_MANY_ENTRANTS";

/** The refusal an arbiter's join answers (503) while the check-in line's pool is under the join floor: the line has first call on the
 *  vendor's budget, so the arbiter waits. Client-safe: the panel reads it by this name. */
export const VIDEO_BUSY = "VIDEO_BUSY";

/** Does a division of this sport draw the Online play control - the one that switches a chess division onto Lichess? Only chess
 *  does, and only while the club is offered online chess (the PostHog flag `online-chess`, asked by the page). The Division rules
 *  strip draws the control by this answer, and Settings' pointer to the strip names online play by the same one, so the sentence
 *  never promises a control the strip does not show. */
export function onlinePlayShown(sportKey: string, onlineChessOffered: boolean): boolean {
  return sportKey === CHESS_SPORT_KEY && onlineChessOffered;
}
