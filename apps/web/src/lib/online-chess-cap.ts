// The online chess entrant cap and its two refusal codes, in a leaf with no imports so the smoke suite (scripts/smoke, run by bare
// node, which cannot resolve lib/online-chess.ts's `@/` import) states the SAME number the server enforces. lib/online-chess.ts
// re-exports all three; the import-free invariant is pinned (import-free-leaves.test.ts).

/** The most entrants one ONLINE chess division holds, on every plan (owner ruling 2026-11-21 at 128; raised to 256 by the owner
 *  2026-11-23, gated on a 256-board load run against a real lila). A CAPACITY limit, not a plan upsell: no plan lifts it, so its
 *  refusal carries no upgrade wording. It is sized to what the platform can run - 256 players are 128 boards, and every board's
 *  check-in spends from the RealtimeKit call budget (server/external-play/video/budget.ts).
 *  Over-the-board chess and every other sport keep the plan's own per-division cap (`entrants.per_division.max`). The server
 *  enforces it as min(plan cap, this) at every door that grows an online division (server/external-play/online-entrant-cap.ts);
 *  declared here, client-safe, so the islands that say the refusal read the same number. */
export const ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION = 256;

/** 422: an entrant (or a place) was refused because an online chess division already holds `ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION`
 *  entrants. Never a 402: an upgrade does not lift it. The error body carries `limit`. */
export const ONLINE_DIVISION_FULL = "ONLINE_DIVISION_FULL";

/** 422: turning online play ON was refused because the division already holds more entrants than an online chess division may.
 *  The body carries `limit` and `entrants` (how many it holds). Remove entrants first. */
export const ONLINE_PLAY_TOO_MANY_ENTRANTS = "ONLINE_PLAY_TOO_MANY_ENTRANTS";
