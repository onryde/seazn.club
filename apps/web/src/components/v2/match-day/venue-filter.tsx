"use client";
// Match Day's venue filter (Match Day E2 item 5, owner 2026-11-01): a multi-select before the division chips, there only when the
// courts span more than one venue. One DOM, branched: from md a popover under its button; on a phone the same checklist as a
// full-width sheet from the bottom edge, every row a 44px target, with a backdrop tap and a Done button to leave it. Esc closes
// either and hands focus back to the button.
//
// It is DISPLAY ONLY. It reports the venues the organiser wants listed; the call guards never read it.
//
// The checklist is a set of real checkboxes: "Show all venues" is checked while every venue is, checking it selects every venue,
// and unchecking the last selected venue selects every venue instead of leaving the page with nothing to list.
import { useEffect, useId, useRef, useState } from "react";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import type { VenueOption } from "@/lib/match-day/view";

export function VenueFilter({
  dict,
  locale,
  options,
  selected,
  onChange,
}: {
  dict: Dict;
  locale: Locale;
  options: readonly VenueOption[];
  /** The venues listed now: ids of `options`. */
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    // From md the popover closes on a tap outside it (a phone has the backdrop for that).
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current !== null && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const everyVenue = options.every((o) => selected.has(o.id));
  const chosen = options.filter((o) => selected.has(o.id));
  const summary = everyVenue
    ? t(dict, "matchDay.venue.triggerAll")
    : chosen.length === 1
      ? chosen[0]!.name
      : plural(dict, "matchDay.venue.triggerMany", chosen.length, locale);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Nothing selected is not a state: it reads as every venue.
    onChange(next.size === 0 ? new Set(options.map((o) => o.id)) : next);
  };

  return (
    <div ref={rootRef} data-testid="md-venue-filter" className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="md-venue-trigger"
        data-all={everyVenue ? "true" : "false"}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${t(dict, "matchDay.venue.label")}: ${summary}`}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex min-h-11 max-w-full min-w-0 items-center gap-2 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition md:min-h-8 ${
          everyVenue ? "bg-white text-purple-800 ring-purple-200 hover:bg-purple-50" : "bg-purple-50 text-purple-900 ring-purple-400 hover:bg-purple-100"
        }`}
      >
        <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 14s4.5-3.9 4.5-7.5a4.5 4.5 0 10-9 0C3.5 10.1 8 14 8 14z" />
          <circle cx="8" cy="6.5" r="1.5" />
        </svg>
        <span className="min-w-0 truncate" data-testid="md-venue-summary">
          {summary}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className={`h-3.5 w-3.5 shrink-0 fill-none stroke-current transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <>
          <div aria-hidden data-testid="md-venue-backdrop" onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-slate-900/40 md:hidden" />
          <div
            id={panelId}
            role="group"
            aria-label={t(dict, "matchDay.venue.label")}
            data-testid="md-venue-panel"
            className="z-50 rounded-xl bg-white p-2 shadow-xl ring-1 ring-purple-100 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[80vh] max-md:overflow-y-auto max-md:rounded-b-none max-md:rounded-t-2xl max-md:p-3 md:absolute md:left-0 md:top-full md:mt-2 md:w-80"
          >
            <p className="px-3 pb-1 pt-2 text-sm font-semibold text-purple-950 md:sr-only">{t(dict, "matchDay.venue.label")}</p>
            <ul>
              <li>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm font-medium text-slate-900 hover:bg-purple-50">
                  <input
                    type="checkbox"
                    data-testid="md-venue-all"
                    checked={everyVenue}
                    onChange={() => onChange(new Set(options.map((o) => o.id)))}
                    className="h-5 w-5 shrink-0 accent-purple-600"
                  />
                  <span className="min-w-0 flex-1">{t(dict, "matchDay.venue.all")}</span>
                </label>
              </li>
              {options.map((o) => (
                <li key={o.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm text-slate-900 hover:bg-purple-50">
                    <input
                      type="checkbox"
                      data-testid="md-venue-option"
                      data-venue-id={o.id}
                      checked={selected.has(o.id)}
                      onChange={() => toggle(o.id)}
                      className="h-5 w-5 shrink-0 accent-purple-600"
                    />
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    <span className="shrink-0 text-xs text-slate-600">{plural(dict, `matchDay.header.places.${o.noun}`, o.courts, locale)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-2 border-t border-purple-50 pt-2 md:hidden">
              <button type="button" onClick={() => setOpen(false)} className="btn btn-primary min-h-11 w-full">
                {t(dict, "matchDay.venue.done")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
