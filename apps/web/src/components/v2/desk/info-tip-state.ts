// Match Day E1 fix round 1 (m4): what the ⓘ bubble is doing, as pure functions so a node-only vitest can drive every transition.
//
// The bubble is shown three ways: a TAP (`open`, toggled by the button), and HOVER / FOCUS, which CSS shows on its own (`engaged` = the
// pointer is over the ⓘ's wrapper or focus is inside it - read from the DOM at the moment of the event, never tracked, so it cannot
// go stale). WCAG 1.4.13 (content on hover or focus): it must be dismissable without moving the pointer or focus, and Escape is how.
// `dismissed` is that dismissal: it hides a hover/focus bubble, and it ends only when the pointer AND focus have both left, so the next
// time either returns the bubble shows again.

export type TipState = { open: boolean; dismissed: boolean };

export const TIP_CLOSED: TipState = { open: false, dismissed: false };

/** Is the bubble on screen? A tap shows it; hover/focus show it unless Escape has put it away. */
export function tipShown(s: TipState, engaged: boolean): boolean {
  return s.open || (engaged && !s.dismissed);
}

/** A press on the ⓘ: toggle the tapped-open state. Asking for the bubble again also ends a dismissal. */
export function tipToggle(s: TipState): TipState {
  return { open: !s.open, dismissed: false };
}

/** A press outside the wrapper: the tapped-open bubble closes. A dismissal is left alone (it ends when the pointer/focus leave). */
export function tipOutside(s: TipState): TipState {
  return s.open ? { ...s, open: false } : s;
}

/**
 * Escape. When the bubble is showing, it is spent here: the tapped-open state closes and, if hover or focus is still holding the bubble
 * up, the dismissal keeps it away. `consumed` says whether the key was used - when nothing was showing it is NOT, and the caller must
 * leave the key alone for whatever else is listening (the bottom sheet around the ⓘ closes on the same key).
 */
export function tipEscape(s: TipState, engaged: boolean): { state: TipState; consumed: boolean } {
  if (!tipShown(s, engaged)) return { state: s, consumed: false };
  return { state: { open: false, dismissed: engaged }, consumed: true };
}

/** The pointer or focus left the wrapper. Once neither is left on it, a dismissal is over: coming back shows the bubble again. */
export function tipLeft(s: TipState, engaged: boolean): TipState {
  return engaged || !s.dismissed ? s : { ...s, dismissed: false };
}
