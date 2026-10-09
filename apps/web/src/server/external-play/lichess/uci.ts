// Strict UCI validation (design §3.4, measured fact M5). The ONLY gate between
// a client-supplied move string and Lichess.
//
// M5, 2026-10-09: `move e7e6xx` → 200 {"ok":true}, export `moves=e4 e6`.
// Lichess truncated the suffix and played a move. So a malformed string is not
// an error we can catch downstream — by the time we could look, a piece has
// moved. Nothing forwards a move string that has not been through here.
//
// No flags: a shared RegExp with /g or /y carries `lastIndex` between calls and
// would answer differently on the second identical move of a game.
import { HttpError } from "@/lib/errors";

export const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Returns the value when it is well-formed UCI; throws 400 INVALID_UCI
 *  otherwise. The message never echoes the rejected value — a client string
 *  reflected into an error is a reflection sink. */
export function assertUci(value: string): string {
  if (!UCI_RE.test(value)) {
    throw new HttpError(400, "That move is not a valid move.", "INVALID_UCI");
  }
  return value;
}
