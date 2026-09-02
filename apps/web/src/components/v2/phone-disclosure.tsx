"use client";
import { useState, type ReactNode } from "react";

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
 *  desktop is a plain wrapper around what it always rendered. Both this
 *  wrapper and the body carry `h-full`: when the caller is a grid item
 *  (`grid gap-4 lg:grid-cols-2` in `fixture-console.tsx`), grid's default
 *  `stretch` sizes THIS div to the track, and without propagating that
 *  height inward the real card one level deeper stays content-height —
 *  home/away cards can then render at different heights on desktop. */
export function PhoneDisclosure({ summary, aside, showLabel, hideLabel, children }: PhoneDisclosureProps) {
  const [open, setOpen] = useState(false);
  return (
    <div data-role="phone-disclosure" data-open={open} className="h-full">
      <button
        type="button"
        data-role="phone-disclosure-toggle"
        aria-expanded={open}
        aria-label={open ? hideLabel : showLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
      >
        <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{summary}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-slate-600">
          {aside}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      <div className={open ? "h-full" : "h-full max-md:hidden"}>{children}</div>
    </div>
  );
}
