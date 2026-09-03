"use client";
import { useId, useState, type ReactNode } from "react";

export interface PhoneDisclosureProps {
  /** The card's own title, verbatim — what the row reads as on a phone. */
  summary: ReactNode;
  /** Right-aligned fact in the row, e.g. the word "Lineup". */
  aside?: ReactNode;
  showLabel: string;
  hideLabel: string;
  children: ReactNode;
}

/** Phone-only disclosure (spec 2026-09-02-scorepad-v3-phone-composition §3.10).
 *  Below `md` the body is hidden until the row is tapped; at `md` and up the
 *  row is not rendered (`md:hidden`) and the body carries no hiding class, so
 *  desktop is a plain wrapper around what it always rendered.
 *
 *  Width (fix round 2, item 1): the wrapper is a `grid` item with no width
 *  constraint of its own, so its default `min-width: auto` resolves to
 *  min-content — and the truncating summary span then renders at its FULL
 *  natural width instead of ellipsizing, overflowing the page at narrow
 *  phone widths with a realistic (~40+ char) entrant name. `min-w-0`
 *  overrides that floor so `truncate` can actually shrink the span below its
 *  content width — the repo's recorded `truncate`-needs-`min-w-0`-on-the-
 *  ancestor-chain trap, one level up from the span's own `min-w-0`.
 *
 *  Height (fix round 2, item 2): both this wrapper and the body carry
 *  `h-full` so they stretch to the grid track (`grid gap-4 lg:grid-cols-2`
 *  in `fixture-console.tsx`) — but `h-full` on a plain block only sizes that
 *  block's own box, it does not cascade into a content-sized child. The body
 *  is therefore ALSO `grid`: a single child of a grid container gets
 *  `stretch` on both axes by default, so the real card underneath
 *  (`lineup-editor.tsx`'s `<section class="card p-4">` / the roster's own
 *  section) fills the wrapper instead of staying content-height. Do not add
 *  `h-full` to `lineup-editor.tsx` itself — it is shared with the
 *  registration surfaces and must not inherit this plan's layout
 *  assumptions. */
export function PhoneDisclosure({ summary, aside, showLabel, hideLabel, children }: PhoneDisclosureProps) {
  const [open, setOpen] = useState(false);
  // Review fix: the activity toggle already carries `aria-controls`; this
  // one did not. `PhoneDisclosure` is mounted several times on one page
  // (once per lineup/availability side in `fixture-console.tsx`), so the
  // controlled region's id must be unique per instance — `useId()`, not a
  // static string like `match-details-toggle`'s (that one mounts once per
  // page).
  const bodyId = useId();
  return (
    <div data-role="phone-disclosure" data-open={open} className="h-full min-w-0">
      <button
        type="button"
        data-role="phone-disclosure-toggle"
        aria-expanded={open}
        aria-label={open ? hideLabel : showLabel}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
      >
        <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{summary}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-slate-600">
          {aside}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      <div className={open ? "grid h-full" : "grid h-full max-md:hidden"} id={bodyId}>
        {children}
      </div>
    </div>
  );
}
