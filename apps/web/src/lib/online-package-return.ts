// The checkout return of an Online Chess division (spec 2026-11-23-online-chess-credits-design.md §8.4): the relay-checkout route's
// `returnTo: "division"` lands the buyer on the division's Fixtures tab as `?tab=fixtures&oc=pay&checkout=success&session_id=…`, plus
// `&size=N` when the buyer was upgrading (the target rides in the address, §8.4), then `&cameras=1` when the buy was for the camera of a paid package.
// The page reads the three params this module owns - `oc`, `size` and `cameras` - and hands the receipt's request down to the Division rules strip, where the receipt opens. `checkout` and `session_id`
// are the page's other reader's (the session's reconcile); they are not read here.
import { isOnlineSize, type OnlineSize } from "@/lib/online-chess-package";

/** The receipt the buyer returns to: `size` is the upgrade's target, or null for "the stored size" (a first payment keeps its size on
 *  the unpaid row, so the address carries none). */
export interface OnlineReceiptRequest {
  size: OnlineSize | null;
  /** WHICH arrival this is: the checkout session the buyer returned from ("" when the address names none). The receipt opens once per key, so
   *  a second arrival (another payment, a client navigation back to `?oc=pay`) reopens it, and a refresh of the same one does not. */
  key: string;
  /** The buyer came back from buying credits for the CAMERA of a paid package (`cameras=1`): the receipt reopens on the camera, at the size the address
   *  names (the paid size). Present only when asked; an address without the intent has no such key. */
  cameras?: true;
}

/** The receipt request in a division page's query, or null when it asks for none. `oc` must be exactly `pay`. `size` is a URL, so it
 *  is judged as text: whole decimal digits naming a size on the ladder, else dropped (the receipt still reopens, on the stored size) -
 *  `016`, `16.0`, `1e1`, a sign, a space or a number of another script never reach a price. */
export function onlineReceiptRequest(query: Readonly<Record<string, unknown>>): OnlineReceiptRequest | null {
  if (query.oc !== "pay") return null;
  // A Stripe session id (`cs_test_…`): letters, digits and underscores. Anything else is not a key (it never reaches the page's state).
  const key = typeof query.session_id === "string" && /^[A-Za-z0-9_]{1,255}$/.test(query.session_id) ? query.session_id : "";
  // Only the exact string `1` is the intent: the route writes nothing else, and a hand-typed value is not a switch.
  const cameras = query.cameras === "1" ? ({ cameras: true } as const) : {};
  const raw = query.size;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,2}$/.test(raw)) return { size: null, key, ...cameras };
  const n = Number(raw);
  return { size: isOnlineSize(n) ? n : null, key, ...cameras };
}
