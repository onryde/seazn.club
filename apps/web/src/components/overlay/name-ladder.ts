// `_THEMES.md` §1's size step, measured (W2-F45).
//
// "Team names never wrap and never truncate on the overlay… a name longer than
// the cell can hold at 45 px falls to the entrant's short name, then to the
// three-letter code; this is the only size step." Nothing in CSS can express
// that: wrapping and an ellipsis are the two things CSS offers and §1 forbids
// both, so the rung is a MEASUREMENT the browser makes.
//
// SPLIT ON PURPOSE. `pickNameRung` is arithmetic and is unit-tested; everything
// that touches a box is in `availableNameWidth`, which `apps/web` vitest
// (`environment: "node"`) cannot run and the e2e covers instead.

/**
 * How much room a step UP has to find before it is taken.
 *
 * Not a cosmetic margin — see `pickNameRung`. 8 px at a 45 px face is under a
 * third of one character's width, so no name is held a rung lower than it needs
 * to be by a visible amount.
 */
export const NAME_RUNG_HYSTERESIS_PX = 8;

/**
 * The rung to render: the FIRST (longest) candidate that fits `available`.
 *
 * Falls to the LAST rung when none fits. That is the three-letter code, which
 * at 45 px is ~70 px wide and fits any cell the bar can produce; the branch
 * exists for the degenerate frame (a 200-px cell during a resize) and clips
 * there rather than painting over the brand mark.
 *
 * WHY `current` AND A HYSTERESIS. The team cell is `flex: 1 1 auto` (§3), so
 * its basis — and therefore the space its name gets — GROWS with the name
 * actually rendered. A rung that fits only because a shorter one is on screen
 * would stop fitting the moment it was taken, and the two would chase each
 * other for the length of the broadcast. Requiring `NAME_RUNG_HYSTERESIS_PX` of
 * spare room to step UP makes "fits at the shorter rung" strictly stronger than
 * "does not fit at the longer one", so no pair of rungs can alternate.
 *
 * @param widths  each candidate's natural width, longest-first order
 * @param available  the width the name may occupy, from `availableNameWidth`
 * @param current  the rung on screen; a step up must clear the hysteresis
 */
export function pickNameRung(
  widths: readonly number[],
  available: number,
  current = 0,
  hysteresis: number = NAME_RUNG_HYSTERESIS_PX,
): number {
  for (let i = 0; i < widths.length; i++) {
    const room = i < current ? available - hysteresis : available;
    if (widths[i]! <= room) return i;
  }
  return Math.max(0, widths.length - 1);
}

/**
 * The width the name element may occupy: its own box, plus the slack the
 * score's `margin-left: auto` (§3) is currently absorbing.
 *
 * READING THE GAP IS WHAT MAKES THIS EXACT IN BOTH STATES. The name is
 * `flex: 0 1 auto; min-width: 0`, so when it FITS its box is its natural width
 * and the leftover sits in the auto margin ahead of the score; when it does NOT
 * fit its box is exactly the space it was allotted and the margin is zero.
 * Either way box + slack is the same number — the space the name may have —
 * which is why a rung can be chosen from any rung without the answer depending
 * on which one happens to be on screen.
 *
 * Returns 0 for an unlaid-out element (a display:none preview, a node not in
 * the document), where every candidate would otherwise read as too wide.
 */
export function availableNameWidth(el: HTMLElement): number {
  const box = el.getBoundingClientRect().width;
  if (box === 0) return 0;
  const next = el.nextElementSibling;
  // An absolutely positioned sibling (`.ovl-led` is `position: absolute`) is
  // not a flex item and its left edge says nothing about the slack.
  if (!(next instanceof HTMLElement) || getComputedStyle(next).position === "absolute") return box;
  const parent = el.parentElement;
  const gap = parent === null ? 0 : parseFloat(getComputedStyle(parent).columnGap) || 0;
  const slack = next.getBoundingClientRect().left - el.getBoundingClientRect().right - gap;
  return box + Math.max(0, slack);
}
