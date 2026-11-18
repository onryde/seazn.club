"use client";

// "On this page" for a help article (layout A, owner 2026-11-18). ONE list in the DOM, shown two ways
// by width — never a second copy:
//  - from 1100px: a rail beside the reading column that stays in view while scrolling (the caller makes
//    this box sticky) and marks the section being read;
//  - below 1100px (tablets and phones): folded behind a toggle under the lede.
// The entries come from helpTocEntries (lib/help-toc.ts), which already returns none for an article with
// fewer than two level-2 headings; this component renders nothing for an empty list.
//
// The rail scrolls on its own when it is taller than the window, so the navigation is focusable
// (tabIndex 0) and named, as every scrolling region here owes (AGENTS.md class 23).
import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { HelpTocEntry } from "@/lib/help-toc";

/** A heading counts as reached once its top passes this far down the window: below the sticky site nav, plus air. */
const REACHED_PX = 112;

export function HelpToc({ entries, className = "" }: { entries: HelpTocEntry[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const navId = useId();

  useEffect(() => {
    if (entries.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const root = document.documentElement;
      // At the very bottom, the last section is the one being read even if its heading never reached the top.
      if (window.innerHeight + window.scrollY >= root.scrollHeight - 2) {
        setCurrent(entries[entries.length - 1]!.id);
        return;
      }
      let reached = entries[0]!.id;
      for (const e of entries) {
        const el = document.getElementById(e.id);
        if (el && el.getBoundingClientRect().top <= REACHED_PX) reached = e.id;
      }
      setCurrent(reached);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <div className={`min-w-0 ${className}`} data-testid="help-toc">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={navId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 text-left text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 min-[1100px]:hidden"
      >
        <span>On this page</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-normal text-slate-500">
          {entries.length} sections
          <ChevronDown aria-hidden className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2} />
        </span>
      </button>
      <nav
        id={navId}
        aria-label="On this page"
        tabIndex={0}
        className={`rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 min-[1100px]:max-h-[calc(100vh-8rem)] min-[1100px]:overflow-y-auto ${
          open ? "max-[1100px]:mt-2 max-[1100px]:border max-[1100px]:border-slate-200 max-[1100px]:bg-white max-[1100px]:p-3" : "max-[1100px]:hidden"
        }`}
      >
        <p aria-hidden className="mb-2 hidden text-sm font-semibold text-slate-900 min-[1100px]:block">
          On this page
        </p>
        <ol className="border-l border-slate-200 text-sm">
          {entries.map((e) => {
            const here = e.id === current;
            return (
              <li key={e.id}>
                <a
                  href={`#${e.id}`}
                  aria-current={here ? "location" : undefined}
                  onClick={() => setOpen(false)}
                  className={`-ml-px block border-l-2 py-1.5 pl-3 leading-snug transition-colors ${
                    here
                      ? "border-purple-600 font-medium text-purple-800"
                      : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
                  }`}
                >
                  {e.text}
                </a>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
