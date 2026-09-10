"use client";
// Minimal tab switcher for the division home (Schedule / Standings /
// Entrants — doc 09 §2). All panels are server-rendered and shipped in the
// ISR payload; this only toggles visibility (fast + crawlable).
// Styled as a segmented pill bar, sticky under the court masthead so a
// spectator can hop tabs from anywhere in a long schedule.
//
// `?tab=` IS HONOURED, and it is read on the CLIENT on purpose. The hub's
// standings link (`server/public-site/competition-hub.ts:584`) and its entrants
// link (`:608`) both carry `?tab=`, and before this component read it every one
// of them landed on Schedule. The obvious repair — taking `searchParams` in the
// division page — is the expensive one: that page is `export const revalidate =
// 30`, and reading `searchParams` in a server component makes the whole route
// DYNAMIC, trading the public surface's CDN caching for a tab default. Reading
// it here costs a frame instead: the server always renders index 0, so
// hydration cannot mismatch, and the effect below switches immediately after.
// THIS IS THE SECOND ANSWER IN THIS REPO TO THE SAME QUESTION, and the other
// one came first. W1 hit exactly this wall on the fixture page and solved it in
// `match-centre/match-centre-with-tab-param.tsx` — same diagnosis (that page is
// ISR too, and reading `searchParams` on the server throws
// `DYNAMIC_SERVER_USAGE` on every request), same conclusion (read it on the
// client), different mechanism: `useSearchParams` inside a `<Suspense>` whose
// fallback is the same component with `tabParam={null}`. It is in production
// use at `fixtures/[fixtureId]/page.tsx:293`.
//
// The divergence here is deliberate, not ignorance of that file, and it buys
// one thing: `useSearchParams` bails its calling subtree to CLIENT-SIDE
// RENDERING up to the nearest boundary (its own docs say so, and a static build
// without the boundary fails outright), whereas reading `window.location`
// through `useSyncExternalStore` leaves the page fully static and additionally
// survives Back/Forward via `popstate`. For a tab bar wrapping three
// server-rendered panels that is worth having.
//
// But two mechanisms for one problem is a cost the next reader pays, and the
// right end state is ONE — most likely a shared `useTabParam()` both call.
// That means touching W1's merged match centre, which is not a thing to churn
// mid-wave, so it is recorded as owed rather than done here.
import { useState, useSyncExternalStore, type ReactNode } from "react";

interface Props {
  /**
   * Stable, URL-facing ids in panel order — "schedule" | "standings" |
   * "entrants". These are the `?tab=` values and they are NOT translated:
   * a deep link has to survive the reader's locale.
   */
  ids: string[];
  /** Display labels in the same order, already resolved by the caller. */
  labels: string[];
  /** Accessible name for the tablist (`division.tabsLabel`). */
  label: string;
  children: ReactNode[]; // one panel per label, same order
}

/* The query string is an EXTERNAL STORE in React's own sense — the browser owns
 * it, components only read it — so it is read with `useSyncExternalStore` and
 * not `useState` + `useEffect`. The first cut of this file did the latter and
 * called `setActive` from the effect body, which is exactly the cascading
 * render `react-hooks/set-state-in-effect` warns about; `scorebug.tsx:56-76`
 * had already hit the same wall and settled on this shape. `getServerSnapshot`
 * returns null, matching the server render, so hydration never mismatches.
 * `popstate` is subscribed because Back/Forward changes the URL under us; our
 * own `replaceState` in `select` deliberately does not fire it, and must not —
 * the tap has already moved the state. */
function subscribeToTabParam(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
function readTabParam(): string | null {
  return new URLSearchParams(window.location.search).get("tab");
}
function readTabParamOnServer(): string | null {
  return null;
}

export function Tabs({ ids, labels, label, children }: Props) {
  // `picked` stays null until the spectator actually taps something, and that
  // is what makes the precedence right in BOTH directions: before a tap the URL
  // wins, and after one the tap wins for good — no later re-render can drag
  // someone back to the tab they arrived on.
  const [picked, setPicked] = useState<number | null>(null);
  const deepLinked = useSyncExternalStore(subscribeToTabParam, readTabParam, readTabParamOnServer);
  // `> 0` and not `>= 0`: an unknown or absent `?tab=` yields -1, which has to
  // fall through to the first tab rather than select nothing.
  const fromUrl = deepLinked === null ? -1 : ids.indexOf(deepLinked);
  const active = picked ?? (fromUrl > 0 ? fromUrl : 0);

  function select(i: number) {
    setPicked(i);
    // Put the choice back in the URL so what a spectator shares is what they
    // are looking at. `replaceState`, not `pushState`: a tab is not a page, and
    // stacking history entries would make Back walk the tab bar instead of
    // leaving the division.
    const url = new URL(window.location.href);
    if (i === 0) url.searchParams.delete("tab");
    else url.searchParams.set("tab", ids[i]!);
    window.history.replaceState(null, "", url);
  }

  return (
    <div>
      <div className="sticky top-[54px] z-30 -mx-4 mb-5 bg-canvas/90 px-4 py-2 backdrop-blur">
        <div
          role="tablist"
          aria-label={label}
          className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full border border-zinc-200/80 bg-surface p-1 shadow-sm"
        >
          {labels.map((label, i) => (
            <button
              key={ids[i]}
              id={`tab-${ids[i]}`}
              role="tab"
              aria-selected={i === active}
              aria-controls={`panel-${ids[i]}`}
              onClick={() => select(i)}
              className={
                i === active
                  ? "shrink-0 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm"
                  : "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {children.map((panel, i) => (
        <div
          key={ids[i]}
          id={`panel-${ids[i]}`}
          role="tabpanel"
          aria-labelledby={`tab-${ids[i]}`}
          hidden={i !== active}
        >
          {panel}
        </div>
      ))}
    </div>
  );
}
