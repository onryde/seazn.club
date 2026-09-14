"use client";
import { useId, useLayoutEffect, useState, type ReactNode } from "react";

export interface PhoneDisclosureProps {
  /** The card's own title, verbatim — what the row reads as on a phone. */
  summary: ReactNode;
  /** Right-aligned fact in the row, e.g. the word "Lineup". */
  aside?: ReactNode;
  showLabel: string;
  hideLabel: string;
  children: ReactNode;
  /** Initial `open` state (default true — the original always-open-at-desktop
   *  behavior). Callers that also pass `desktopCollapsible` use this to start
   *  folded, e.g. `!started` for a section worth full width only pre-match. */
  startOpen?: boolean;
  /** Default false, phone-only per the design doc below. When true the toggle
   *  row also renders at `md` and up (no `md:hidden`) and the body is gated
   *  purely by `open` at every width — a desktop-collapsible variant for
   *  sections that should fold once some event fires (2026-09-14, fixture
   *  console lineup/roster: collapse once the match starts, every sport). */
  desktopCollapsible?: boolean;
}

/** Phone-only disclosure by default (spec
 *  2026-09-02-scorepad-v3-phone-composition §3.10). Below `md` the body is
 *  hidden until the row is tapped; at `md` and up the row is not rendered
 *  (`md:hidden`) and the body carries no hiding class, so desktop is a plain
 *  wrapper around what it always rendered — UNLESS `desktopCollapsible` is
 *  set, in which case the toggle and the fold both apply at every width.
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
export function PhoneDisclosure({
  summary,
  aside,
  showLabel,
  hideLabel,
  children,
  startOpen = true,
  desktopCollapsible = false,
}: PhoneDisclosureProps) {
  // Always starts closed, on the server AND the first client paint — matches
  // spec 2026-09-02-scorepad-v3-phone-composition §3.10's phone-narrow
  // default exactly, with no SSR/hydration mismatch. `desktopCollapsible`
  // widths (>= Tailwind's `md`, 768px) then flip to `startOpen` a layout
  // effect later, BEFORE the browser paints, so there is no visible flash —
  // this can't be done in the initial `useState` because the two widths
  // need DIFFERENT defaults from the SAME `open` state (review fix, PR #782:
  // a shared `useState(startOpen)` opened the lineup editor pre-match on
  // phone-narrow widths too, silently dropping the documented "closed until
  // tapped" phone default and reddening
  // `mobile.spec.ts`'s "lineup editor role/pair-order selects hold at phone
  // width" at every width, narrow AND tablet, the moment `mobile.spec.ts`'s
  // fixture was pre-match).
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!desktopCollapsible || !startOpen) return;
    if (typeof window === "undefined") return;
    if (window.matchMedia("(min-width: 768px)").matches) setOpen(true);
  }, [desktopCollapsible, startOpen]);
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
        className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400${desktopCollapsible ? "" : " md:hidden"}`}
      >
        <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{summary}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-slate-600">
          {aside}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      <div
        className={open ? "grid h-full" : desktopCollapsible ? "grid h-full hidden" : "grid h-full max-md:hidden"}
        id={bodyId}
      >
        {children}
      </div>
    </div>
  );
}
