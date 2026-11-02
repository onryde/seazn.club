"use client";

// The tap-per-section card the division Settings tab is made of (a title row that folds a body open), shared with the entrant
// kinds block on the Entrants tab (Match Day C4) so the two read as one family of controls rather than a copy and an original.
import { useState, type ReactNode } from "react";

export function SettingsGroup({
  title,
  summary,
  defaultOpen = false,
  danger = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card p-0 ${danger ? "border-red-200" : ""}`}>
      {/* Below md the summary takes a row of its own under the title (order +
          basis-full) instead of squeezing it: at 320px a long title next to a
          summary wrapped one word per line. md+ is one row, as before. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-5 py-3 text-left md:flex-nowrap md:justify-between"
      >
        <span className={`min-w-0 flex-1 text-sm font-semibold ${danger ? "text-red-700" : "text-slate-700"}`}>
          {title}
        </span>
        <span aria-hidden className="order-2 text-xs text-slate-500 md:order-3">{open ? "▾" : "▸"}</span>
        {summary && !open && (
          <span className="order-3 basis-full truncate text-xs text-slate-500 md:order-2 md:max-w-sm md:basis-auto">{summary}</span>
        )}
      </button>
      {open && <div className="space-y-3 px-5 pb-5">{children}</div>}
    </section>
  );
}
