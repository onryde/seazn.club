// The online chess entrant cap's two refusals, said in the organiser's own language (owner ruling 2026-11-21). The server's
// words are English-only by design, so a screen never shows `err.message` for these: it maps the code to localized copy.
//
//   ONLINE_DIVISION_FULL            an online chess division already holds its most (128): add / promote / confirm / waive / a
//                                   registration capacity above it;
//   ONLINE_PLAY_TOO_MANY_ENTRANTS   turning online play on, for a division that already holds more than that.
//
// A CAPACITY limit, not a plan upsell: neither sentence mentions plans, upgrading or Pro, and neither screen offers an upgrade
// button. EVERY organiser screen that can meet one says it through this file (one wording per code).
import {
  ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION,
  ONLINE_DIVISION_FULL,
  ONLINE_PLAY_TOO_MANY_ENTRANTS,
} from "@/lib/online-chess";

/** The copy keys, one per code. */
export const ONLINE_ENTRANT_CAP_KEYS = {
  [ONLINE_DIVISION_FULL]: "onlineChess.entrantCap",
  [ONLINE_PLAY_TOO_MANY_ENTRANTS]: "onlineChess.turnOnTooMany",
} as const;

export function isOnlineEntrantCapCode(code: unknown): code is keyof typeof ONLINE_ENTRANT_CAP_KEYS {
  return typeof code === "string" && Object.hasOwn(ONLINE_ENTRANT_CAP_KEYS, code);
}

/** The refusal's text, or null when `err` is neither code (the caller keeps its own handling). `limit` is the one the server read
 *  (`extra.limit`), falling back to the shared constant; `entrants` is what the division holds, named by the turn-on sentence. */
export function onlineEntrantCapText(
  err: { code?: string; extra?: Record<string, unknown> },
  text: (key: string, vars: Record<string, string | number>) => string,
): string | null {
  if (!isOnlineEntrantCapCode(err.code)) return null;
  const limit = typeof err.extra?.limit === "number" ? err.extra.limit : ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION;
  if (err.code === ONLINE_DIVISION_FULL) return text(ONLINE_ENTRANT_CAP_KEYS[ONLINE_DIVISION_FULL], { limit });
  const entrants = err.extra?.entrants;
  return typeof entrants === "number"
    ? text(ONLINE_ENTRANT_CAP_KEYS[ONLINE_PLAY_TOO_MANY_ENTRANTS], { entrants, limit })
    : null;
}
