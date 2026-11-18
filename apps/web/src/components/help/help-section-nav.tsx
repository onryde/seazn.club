"use client";

// The help section list (layout A): sections as headings, their pages beneath, the current page marked.
// ONE list in the DOM. From `md` it is the left column, always open. Below `md` it is folded behind one
// toggle that names the current section and its page count, so a phone reads search, then this, then the
// article. The list never scrolls on its own (it is as long as it is, in the page's flow), so it is not a
// scrolling region and owes no tab stop.
import Link from "next/link";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { HelpSectionEntry } from "@/lib/help";

export function HelpSectionNav({ sections, currentHref }: { sections: HelpSectionEntry[]; currentHref: string }) {
  const [open, setOpen] = useState(false);
  const navId = useId();
  const current = sections.find((s) => s.pages.some((p) => p.href === currentHref));

  return (
    <div className="min-w-0" data-testid="help-sections">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={navId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 md:hidden"
      >
        <span className="min-w-0 truncate text-sm font-semibold text-slate-900">
          <span className="sr-only">Help sections: </span>
          {current ? current.label : "All sections"}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500">
          {current ? `${current.pages.length} ${current.pages.length === 1 ? "page" : "pages"}` : null}
          <ChevronDown aria-hidden className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2} />
        </span>
      </button>
      <nav id={navId} aria-label="Help sections" className={open ? "max-md:mt-3 max-md:rounded-xl max-md:border max-md:border-slate-200 max-md:p-4" : "max-md:hidden"}>
        {sections.map((s) => (
          <div key={s.key} className="mt-5 first:mt-0">
            <p id={`${navId}-${s.key}`} className="text-sm font-semibold text-slate-900">
              {s.label}
            </p>
            <ul aria-labelledby={`${navId}-${s.key}`} className="mt-1.5 border-l border-slate-200 text-sm">
              {s.pages.map((p) => {
                const here = p.href === currentHref;
                return (
                  <li key={p.href}>
                    <Link
                      href={p.href}
                      aria-current={here ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={`-ml-px block border-l-2 py-1 pl-3 leading-snug transition-colors ${
                        here
                          ? "border-purple-600 font-medium text-purple-800"
                          : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
                      }`}
                    >
                      {p.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
