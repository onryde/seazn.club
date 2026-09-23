"use client";
// Player profile — the Upcoming list's "Show N more" toggle (owner request
// 2026-09-23, superseding plan D2's native <details>). The SMALLEST client
// island: every row arrives already rendered by the server component
// (`player-upcoming.tsx`), dated and phrased in the org's locale, and both
// labels arrive resolved — so no dictionary, no date code and no server module
// crosses into the client bundle.
//
// ONE list: rows 6+ render straight under row 5 in the same <ul>, and the
// button sits below the last visible row. It is the same <button> in the same
// place open or closed — never unmounted, never re-keyed — so keyboard focus
// stays on it across a toggle. As served (SSR, and without JS) it is
// collapsed: the first rows and the button, nothing that moves at hydration.
// The rest are rendered only while open, so row 5 is the list's last child
// when collapsed and `divide-y` draws no rule under it.
import { useState, type ReactNode } from "react";

/** The list's id, for the button's `aria-controls`. One Upcoming list per page. */
export const UPCOMING_LIST_ID = "mh-player-upcoming-list";

export interface UpcomingRevealProps {
  /** The rows always shown: rendered, keyed <li> elements in the reader's order. */
  head: readonly ReactNode[];
  /** The rows behind the toggle, rendered only while open. Empty → no button. */
  rest: readonly ReactNode[];
  /** "Show {count} more", already interpolated in the org's locale. */
  moreLabel: string;
  /** "Show less", in the org's locale. */
  lessLabel: string;
}

export function UpcomingReveal({ head, rest, moreLabel, lessLabel }: UpcomingRevealProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ul
        id={UPCOMING_LIST_ID}
        className="min-w-0 divide-y divide-zinc-100 rounded-xl border border-zinc-200/80 bg-surface"
      >
        {head}
        {open ? rest : null}
      </ul>
      {rest.length > 0 ? (
        <button
          type="button"
          data-testid="mh-player-upcoming-more"
          aria-expanded={open}
          aria-controls={UPCOMING_LIST_ID}
          onClick={() => setOpen((o) => !o)}
          className="min-h-11 w-full rounded-lg border border-zinc-200/80 bg-surface px-3 text-sm font-medium text-accent-strong"
        >
          {open ? lessLabel : moreLabel}
        </button>
      ) : null}
    </>
  );
}
