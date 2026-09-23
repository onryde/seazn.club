// The ONE composition of a match reference — "R1·2", or "QF·3" where the
// schedule board names the round by its code (board/round-codes.ts). Moved
// here from `slot-label.ts` (fix round 2 of the knockout void un-fill) so a
// module that must stay free of the dictionaries can compose the SAME ref:
// `slot-label.ts` imports the English `msg` for its default lookup, and with
// it every dictionary JSON, which the pad's refusal copy, the dictionary-free
// scoring vocabulary and the e2e specs cannot import. `slot-label.ts`'s
// `matchRef` is now a wrapper over this function, not a second formatter.
//
// Keep this file free of runtime imports — a type import is erased.
import type { MessageKey } from "@/lib/messages";

export type MatchRefLookup = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** `{round, seq}` → the localized match ref via `slot.match_ref`, or — given
 *  the round's short `code` — via `slot.match_ref_code` ("QF·3"). */
export function composeMatchRef(round: number, seq: number, lookup: MatchRefLookup, code?: string): string {
  if (code !== undefined) return lookup("slot.match_ref_code" as MessageKey, { code, seq });
  return lookup("slot.match_ref" as MessageKey, { round, seq });
}
