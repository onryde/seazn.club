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
// hydration cannot mismatch, and the store below switches immediately after.
//
// THAT READ NOW LIVES IN `use-tab-param.ts`, WHICH THIS FILE ASKED FOR. The
// version of this comment that shipped ended "the right end state is ONE —
// most likely a shared `useTabParam()` both call … recorded as owed rather
// than done here". Task 11 is the third caller of the same idea, so the
// extraction happened rather than a third copy; the whole argument for the
// mechanism (why not `useSearchParams`, why not `useState` + an effect, and
// what W1's match centre still does instead) moved there with it, because that
// is now where a reader meets it first.
//
// W5 follow-ups B3 (perf-measure-report P3): the division page no longer ships every panel. At the caps the hidden Fixtures
// panel was 43k of a Standings view's 45k DOM nodes and most of its 12 MB. The page server-renders ONLY the active tab's
// panel - `?tab=standings` / `?tab=entrants` reach their own ISR document through the proxy (`src/proxy.ts`
// `divisionTabRewrite`) - and hands the others as `null`. A tap on a panel that is not here navigates to its URL
// (`router.replace`, no history entry, scroll kept), which loads it from the server; a tap on one that is here only toggles,
// as before. `initial` is the panel the server rendered, so hydration matches whichever tab the URL named.
//
// Fix round 1 (review I3, M2): that load must read as a toggle did. Each absent panel's document is PREFETCHED on mount, so
// a tap usually finds it already here; and while one is still on its way the tapped tab takes the active style and
// `aria-busy` at once (the transition's pending state), never a dead tap. The target is built from the division's own
// `basePath`, never from the address this document was served at.
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTabParam } from "./use-tab-param";

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
  /** One panel per label, same order. `null` for a panel this document does not carry: tapping it loads it (B3). */
  children: ReactNode[];
  /** The panel the server rendered as active (B3); 0 when omitted. */
  initial?: number;
  /** The division home's path (`routes.publicHub(org, comp, division)`): every tab's URL is this plus `?tab=` (M2). */
  basePath: string;
}

export function Tabs({ ids, labels, label, children, initial = 0, basePath }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // The absent panel a tap is loading (I3); shown only while that transition is pending.
  const [loading, setLoading] = useState<number | null>(null);
  // `picked` stays null until the spectator actually taps something, and that
  // is what makes the precedence right in BOTH directions: before a tap the URL
  // wins, and after one the tap wins for good — no later re-render can drag
  // someone back to the tab they arrived on.
  const [picked, setPicked] = useState<number | null>(null);
  const deepLinked = useTabParam();
  // `> 0` and not `>= 0`: an unknown or absent `?tab=` yields -1, which has to
  // fall through to the first tab rather than select nothing.
  // A panel this document does not carry is never shown from the URL: the server picked `initial` for this document.
  const fromUrl = deepLinked === null ? -1 : ids.indexOf(deepLinked);
  const active = picked ?? (fromUrl >= 0 && children[fromUrl] != null ? fromUrl : initial);

  /** Tab `i`'s URL: the division's own path (M2), the query this page has with `tab` set (absent for the first tab). */
  function urlOf(i: number): URL {
    const url = new URL(window.location.href);
    url.pathname = basePath;
    if (i === 0) url.searchParams.delete("tab");
    else url.searchParams.set("tab", ids[i]!);
    return url;
  }

  // I3: the documents a tap would load, fetched ahead of it. Effects run on the client only, after hydration.
  useEffect(() => {
    children.forEach((panel, i) => {
      if (panel != null) return;
      const url = urlOf(i);
      router.prefetch(url.pathname + url.search);
    });
    // Once per document. Keyed on `initial` too: should a Standings-to-Entrants load keep this instance (the same route, another
    // param), the new document's absent panels are fetched as well.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  function select(i: number) {
    // Put the choice back in the URL so what a spectator shares is what they
    // are looking at. `replaceState`, not `pushState`: a tab is not a page, and
    // stacking history entries would make Back walk the tab bar instead of
    // leaving the division.
    const url = urlOf(i);
    // B3: a panel this document does not carry is loaded from its own URL - `router.replace`, so still no history entry.
    // The panel on screen stays until that document arrives (it opens on the tapped panel), never an empty one; the tapped
    // tab shows it is coming meanwhile (I3).
    if (children[i] == null) {
      setLoading(i);
      startTransition(() => router.replace(url.pathname + url.search + url.hash, { scroll: false }));
      return;
    }
    setPicked(i);
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
              aria-busy={isPending && loading === i ? true : undefined}
              onClick={() => select(i)}
              className={
                i === (isPending && loading !== null ? loading : active)
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
