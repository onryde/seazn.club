// How long the room keeps the Lichess outcome it was landed with (`?lichess=<code>`) - PR #990 review, I1 and N1.
//
// The room HOLDS the outcome for the page's life, because the address bar loses `lichess=` as soon as it has been read
// (use-strip-lichess-param.ts) and the server page may be re-read under it (router.refresh). That makes the holding a rule of its own, pure:
//   - only a FAILURE is held (lib/lichess-link.ts `lichessFailureCode`): "Lichess account linked." held over a LATER
//     "Your Lichess link was revoked" card is a lie, and a success is shown by the state itself;
//   - it is drawn only ON a card that offers the link (relink, revoked), where the player's next tap is the one that failed;
//   - it is HELD through the screens that come before the card - the check-in, a closed window, a camera card - until the
//     seat call answers "link required", or the loop returns for a player who was never linked;
//   - once it has been on a card and the screen leaves the cards it is gone for the page's life: a LATER card is a new
//     event, and the old sentence does not belong to it;
//   - an UNSEEN one is SPENT the moment the room shows the link works - the seat taken, or the creating / live / held /
//     over screens (N1): the player never met the failure's card, and a revoke card that comes later must not show an old
//     failure as if it were fresh.
// The shell adjusts the held value in render with `nextHeldFlash` (the sanctioned adjust-state-on-change pattern).
import { lichessFailureCode, type LichessFailureCode } from "@/lib/lichess-link";
import type { RoomScreen } from "./room-screen";

export type HeldFlash = {
  code: LichessFailureCode | null;
  /** The outcome has stood on a card: leaving the cards now spends it. */
  seen: boolean;
};

/** The screens that carry the outcome: the two that offer the Lichess link (card 8 and seam A's notice). */
export const flashScreenKinds = ["relink", "revoked"] as const satisfies readonly RoomScreen["kind"][];
/** The screens that show the player's link works: a game being created, played, held on file, or over. */
export const settledScreenKinds = ["creating", "live", "held", "over"] as const satisfies readonly RoomScreen["kind"][];

/** Where in the sequence a screen puts the held outcome: on a `card` that carries it, `settled` (the link works), or
 *  `before` the card. `seated`: the seat answer took the seat - the link works whatever screen it leaves the room on
 *  (the check-in, waiting for the opponent); a card keeps its place even so (a seated player's game can sit on another
 *  Lichess account - seam A). */
export type FlashPhase = "card" | "settled" | "before";
export function flashPhase(kind: RoomScreen["kind"], seated: boolean): FlashPhase {
  if ((flashScreenKinds as readonly string[]).includes(kind)) return "card";
  if (seated || (settledScreenKinds as readonly string[]).includes(kind)) return "settled";
  return "before";
}

/** What the room holds when it is landed with `value`: a failure, not yet seen - or nothing. */
export function heldFlashFrom(value: string | null | undefined): HeldFlash {
  return { code: lichessFailureCode(value), seen: false };
}

/** The held outcome after a render in `phase`. Returns `held` itself when nothing changes, so the render-phase update
 *  settles. */
export function nextHeldFlash(held: HeldFlash, phase: FlashPhase): HeldFlash {
  if (held.code === null) return held;
  if (phase === "card") return held.seen ? held : { code: held.code, seen: true };
  // Off the cards: spent once seen, and spent unseen when the room shows the link works. Before the card it is held.
  return held.seen || phase === "settled" ? { code: null, seen: false } : held;
}
