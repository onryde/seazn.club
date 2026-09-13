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

// One DOM, branched. The rail scrolls horizontally at every width and bleeds
// to the phone edge below `md` so a chip is never half-cut by the page gutter
// — the negative margin cancels the public page's own side padding.
export const HUB_RAIL_CLASS = "flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4";

// `min-h-11` is the 44px tap target (AGENTS.md). NOTE the divergence from
// `PublicTabRail`, which splits the button (hit area) from an inner span (the
// pill) precisely so the tap-target height does not stretch the pill
// background: a Matches chip carries its COUNT as a direct text child
// ("Live 2"), so there is no inner span to put the pill on without breaking
// that. The chip therefore IS the tap target, 44px tall — which is the
// ordinary shape of a mobile filter chip, and a deliberate difference from the
// tab rail directly above it rather than a copy of it that went wrong.
const CHIP_CLASS =
  "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm tabular-nums transition";
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
