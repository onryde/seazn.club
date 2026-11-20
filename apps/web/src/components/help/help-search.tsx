"use client";

// The help search box (layout A): results as you type, each with its title, section and description and
// the matched words marked. Client-side over the index (server/help-search-index.ts, served by
// /api/help-index): no service, no dependency. The index is fetched on the box's FIRST focus or keystroke
// and shared by every box on the page — it is never inside a help page's HTML.
//
// Two sizes, one behaviour: `hero` on the help home, `rail` at the top of the section list.
//
// KEYBOARD. The results are ordinary links right after the box, so Tab reaches them. Down from the box
// moves to the first result, Up/Down move between results, Up from the first returns to the box, Enter
// in the box opens the first result, and Escape (in the box or on a result) clears the search and puts
// the cursor back in the box.
import Link from "next/link";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { markParts, searchHelp, type HelpSearchRow } from "@/lib/help-search";

let indexLoad: Promise<HelpSearchRow[]> | null = null;

function loadIndex(): Promise<HelpSearchRow[]> {
  indexLoad ??= fetch("/api/help-index")
    .then(async (res) => {
      if (!res.ok) throw new Error(`help index: HTTP ${res.status}`);
      return (await res.json()) as HelpSearchRow[];
    })
    .catch((err: unknown) => {
      // Not remembered: the next focus tries again.
      indexLoad = null;
      throw err;
    });
  return indexLoad;
}

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {markParts(text, query).map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded-sm bg-purple-100 px-0.5 text-purple-950">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function HelpSearch({ variant }: { variant: "hero" | "rail" }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HelpSearchRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputId = useId();
  const statusId = useId();
  const hero = variant === "hero";

  const hits = useMemo(() => (rows ? searchHelp(rows, query) : []), [rows, query]);
  const active = query.trim() !== "";

  const ensureIndex = () => {
    if (rows) return;
    setFailed(false);
    loadIndex().then(setRows, () => setFailed(true));
  };

  const links = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  const clear = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      clear();
    } else if (e.key === "ArrowDown" && hits.length > 0) {
      e.preventDefault();
      links()[0]?.focus();
    } else if (e.key === "Enter" && hits.length > 0) {
      e.preventDefault();
      links()[0]?.click();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const all = links();
    const at = all.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "Escape") {
      e.preventDefault();
      clear();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      all[Math.min(at + 1, all.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at <= 0) inputRef.current?.focus();
      else all[at - 1]?.focus();
    }
  };

  const status = !active
    ? ""
    : failed
      ? "Search could not load. Check your connection and try again."
      : !rows
        ? "Loading search…"
        : hits.length === 0
          ? "No pages match. Try another word."
          : `${hits.length} ${hits.length === 1 ? "page matches" : "pages match"}`;

  return (
    <div role="search" aria-label="Help" className="min-w-0">
      <label htmlFor={inputId} className="sr-only">
        Search help
      </label>
      <div
        className={`flex items-center gap-2 rounded-xl border border-slate-300 bg-white transition focus-within:border-purple-500 focus-within:ring-2 focus-within:ring-purple-200 ${
          hero ? "px-4 py-3 shadow-sm" : "px-3 py-2"
        }`}
      >
        <Search aria-hidden className={`shrink-0 text-slate-400 ${hero ? "h-5 w-5" : "h-4 w-4"}`} strokeWidth={2} />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onFocus={ensureIndex}
          onChange={(e) => {
            setQuery(e.target.value);
            ensureIndex();
          }}
          onKeyDown={onInputKey}
          aria-describedby={statusId}
          placeholder={hero ? "Search help, for example “waitlist”" : "Search help"}
          className={`w-full min-w-0 bg-transparent text-slate-900 outline-none placeholder:text-slate-400 ${hero ? "text-base" : "text-sm"}`}
        />
      </div>
      <p id={statusId} aria-live="polite" className="sr-only">
        {status}
      </p>
      {active ? (
        hits.length === 0 ? (
          <p data-testid="help-search-message" className="mt-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            {status}
          </p>
        ) : (
          <ul
            ref={listRef}
            onKeyDown={onListKey}
            aria-label="Search results"
            className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white"
          >
            {hits.map((h) => (
              <li key={h.slug}>
                <Link
                  href={`/help/${h.slug}`}
                  onClick={() => setQuery("")}
                  className="block px-4 py-2.5 outline-none transition-colors hover:bg-purple-50 focus-visible:bg-purple-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-400"
                >
                  <span className="block text-sm font-medium text-slate-900">
                    <Marked text={h.title} query={query} />
                  </span>
                  <span className="mt-0.5 block text-xs font-medium text-purple-700">{h.section}</span>
                  {h.description ? (
                    <span className={`mt-0.5 block text-xs text-slate-500 ${hero ? "" : "line-clamp-2"}`}>
                      <Marked text={h.description} query={query} />
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
