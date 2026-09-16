// The competition hub's filter chip and the rail that holds a row of them —
// EXTRACTED from `matches-tab.tsx` (plan 2026-09-13, R5) when the Knockout tab
// became the second tab to need the same control. One copy, two callers: the
// Matches tab's filter and division rails, and the Knockout tab's division,
// round and view rails.
//
// NO `"use client"`. Nothing here holds state; it returns an element whose
// `onClick` is whatever the (client) caller hands it.
//
// A plain FUNCTION returning a `<button>`, deliberately not a component. The
// hub's tap tests drive handlers through `_hook-harness`, whose `walk` never
// calls a child component — so a `<HubChip>` element would hide its `<button>`
// and its `onClick` from every one of those tests. A function call leaves the
// button in the caller's own tree, exactly where the Matches tab had it.
import type { ReactNode } from "react";

// One DOM, branched. Below `lg` the rail scrolls horizontally — a swipe rail —
// and bleeds to the phone edge below `md` so a chip is never half-cut by the
// page gutter; the negative margin cancels the public page's own side padding.
//
// From `lg` it WRAPS (Knockout fix round, C1). A mouse has no way to scroll a
// rail sideways, and at 1280 a double-elimination round rail cut its last
// chip mid-word with nothing to reach it by. `overflow-x-auto` stays: a rail
// that wraps never overflows, so it scrolls nothing, and the scroll-into-view
// effect in `knockout-tab.tsx` finds every chip already inside the rail and
// leaves `scrollLeft` at 0. The rail keeps `tabIndex={0}`, its role and its
// name at every width — tabindex cannot vary by media query (AGENTS.md 23).
//
// It SNAPS to chip starts (visual gate C-1). A scrolled rail used to come to
// rest with its leading chip cut mid-word ("uarter-finals", "als 2/2"). The
// snap is `snap-proximity`, not mandatory, so a swipe that stops far from every
// chip stays where it was left. The scroll padding is the inset padding's own
// value, and `max-md:` like it, so a snapped chip lands on the gutter.
// `revealScrollLeft` (knockout-tab.tsx) aligns a revealed chip to that same
// padding, so its answer IS a snap point and the browser has nothing to move.
// Change one and you must change the other. Snapping cannot help at the very END
// of a rail: every chip start past the last reachable offset clamps to that
// offset, so a rail scrolled fully right can still cut its leading chip. That
// is geometry, not a rule this class can express.
export const HUB_RAIL_CLASS =
  "flex snap-x snap-proximity gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4 max-md:scroll-px-4 lg:flex-wrap";

// `min-h-11` is the 44px tap target (AGENTS.md). NOTE the divergence from
// `PublicTabRail`, which splits the button (hit area) from an inner span (the
// pill) precisely so the tap-target height does not stretch the pill
// background: a Matches chip carries its COUNT as a direct text child
// ("Live 2"), so there is no inner span to put the pill on without breaking
// that. The chip therefore IS the tap target, 44px tall — which is the
// ordinary shape of a mobile filter chip, and a deliberate difference from the
// tab rail directly above it rather than a copy of it that went wrong.
//
// `snap-start` is the other half of the rail's `snap-x` (above). It does
// nothing on a chip whose parent does not scroll, such as the Knockout tab's
// view switch.
const CHIP_CLASS =
  "inline-flex min-h-11 shrink-0 snap-start items-center whitespace-nowrap rounded-full px-4 text-sm tabular-nums transition";
const CHIP_ON = "bg-accent font-semibold text-accent-ink shadow-sm";
const CHIP_OFF = "font-medium text-ink-muted hover:bg-accent-soft hover:text-accent-strong";

/**
 * One chip. `content` is a string for the Matches tab ("Live 2") and a label
 * plus a badge for the Knockout tab's round rail.
 *
 * Attribute ORDER is load-bearing and not cosmetic: the suites match
 * `data-testid="…"[^>]*aria-pressed="…"`, and `[^>]*` cannot cross the `>`
 * that ends an opening tag — so an attribute that moves ahead of
 * `data-testid` reds a test about something else entirely. The same hazard
 * `tab-rail.tsx:137-143` writes up for its own roving `tabIndex`.
 */
export function hubChip(
  testid: string,
  content: ReactNode,
  pressed: boolean,
  onPress: () => void,
) {
  return (
    <button
      key={testid}
      data-testid={testid}
      aria-pressed={pressed}
      type="button"
      onClick={onPress}
      className={`${CHIP_CLASS} ${pressed ? CHIP_ON : CHIP_OFF}`}
    >
      {content}
    </button>
  );
}
