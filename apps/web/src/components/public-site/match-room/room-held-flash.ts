// How long the room keeps the Lichess outcome it was landed with (`?lichess=<code>`) - PR #990 review, I1.
//
// The room HOLDS the outcome for the page's life, because the address bar loses `lichess=` as soon as it has been read
// (use-strip-lichess-param.ts) and the server page is re-read under it. That makes the holding a rule of its own, pure:
//   - only a FAILURE is held (lib/lichess-link.ts `lichessFailureCode`): "Lichess account linked." held over a LATER
//     "Your Lichess link was revoked" card is a lie, and a success is shown by the state itself;
//   - it is drawn only ON a card that offers the link (relink, revoked), where the player's next tap is the one that failed;
//   - it is HELD through the screens that come before the card - the check-in, until the seat call answers "link
//     required" - or the loop returns for a player who was never linked;
//   - once it has been on a card and the screen leaves the cards it is gone for the page's life: a LATER card is a new
//     event, and the old sentence does not belong to it.
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

export function onFlashScreen(kind: RoomScreen["kind"]): boolean {
  return (flashScreenKinds as readonly string[]).includes(kind);
}

/** What the room holds when it is landed with `value`: a failure, not yet seen - or nothing. */
export function heldFlashFrom(value: string | null | undefined): HeldFlash {
  return { code: lichessFailureCode(value), seen: false };
}

/** The held outcome after a render on a screen (`onCard`: `onFlashScreen` of its kind). Returns `held` itself when
 *  nothing changes, so the render-phase update settles. */
export function nextHeldFlash(held: HeldFlash, onCard: boolean): HeldFlash {
  if (held.code === null) return held;
  if (onCard) return held.seen ? held : { code: held.code, seen: true };
  return held.seen ? { code: null, seen: false } : held;
}
