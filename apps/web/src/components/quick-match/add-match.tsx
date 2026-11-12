"use client";
// The quick match home's "Add a match" (plan 2 Task 8; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step
// 3, C5): the decider a league takes. A plain form post of two sides to `POST /q/<token>/add-match`, which answers a 303
// back to the home (with the new match on it, or a flash). The page builds `action`, the sides and the words; this island
// only keeps a second tap from posting twice while the page is leaving.
//
//   - Collapsed behind "+ Add a match", a native `<details>`: it opens with no script, and the list above it stays the page.
//   - No script: still a real `<form method="post">` that posts. Unlike Score, an add is NOT idempotent (each post adds a
//     match), so an unguarded double tap adds two; the cap bounds that, and with the script the lock below stops it.
//   - With the script: the first submit is the browser's own; every later one is cancelled until the page comes back from
//     the back-forward cache, which unlocks it. The button is never `disabled` (disabling the submitter can cancel the
//     post it started); busy is `aria-disabled` and its look.
//   - `ph-no-capture` on the form: its action holds the home token, the quick match's credential (O3), so session replay
//     must never record it (scrub-secret-painters.test.ts).
//   - Phone first: each select is the column's full width and no wider (`w-full min-w-0 max-w-full`), so a 60-character
//     side name clips inside its select instead of widening a 320px page; side by side from `md`.
// Takes ids, names and words only: never the home read (A14).
import { useEffect, useRef, useState, type FormEvent } from "react";

export interface QuickMatchAddMatchProps {
  /** `/q/<token>/add-match`, built by the page (`routes.quickMatchAddMatch`). */
  action: string;
  /** Every side, in the order the guest typed them. */
  sides: { id: string; name: string }[];
  /** The ids the two selects open at (the page's pick: the table's top two). */
  home: string;
  away: string;
  /** In the viewer's language: the disclosure's "+ Add a match", the two selects' labels and the button. */
  labels: { open: string; home: string; away: string; submit: string };
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream";
const SELECT = `min-h-11 w-full min-w-0 max-w-full truncate rounded-lg border border-[#3b2a6e] bg-night px-3 py-2 text-base text-cream [color-scheme:dark] ${FOCUS}`;
const LABEL = "flex min-w-0 flex-col gap-1.5 text-xs font-semibold tracking-[0.04em] text-[#b7aede]";

export function QuickMatchAddMatch({ action, sides, home, away, labels }: QuickMatchAddMatchProps) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);

  // Back to a page the browser kept (bfcache): it comes back exactly as it was left, locked mid-post. Unlock it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      locked.current = false;
      setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  function onSubmit(e: FormEvent<HTMLFormElement> | { preventDefault(): void }) {
    if (locked.current) {
      e.preventDefault();
      return;
    }
    locked.current = true;
    setBusy(true);
  }

  // One list per select: each select owns its own option elements.
  const options = () =>
    sides.map((s) => (
      <option key={s.id} value={s.id}>
        {s.name}
      </option>
    ));

  return (
    <details data-testid="qm-add-match" className="min-w-0">
      <summary
        data-testid="qm-add-match-open"
        className={`app-display inline-flex min-h-11 max-w-full cursor-pointer list-none items-center rounded-lg text-sm font-semibold tracking-[0.04em] text-[color:var(--mk-lime)] [overflow-wrap:anywhere] [&::-webkit-details-marker]:hidden ${FOCUS}`}
      >
        {labels.open}
      </summary>
      <form
        method="post"
        action={action}
        onSubmit={onSubmit}
        data-testid="qm-add-match-form"
        className="ph-no-capture mt-2 grid min-w-0 gap-3 rounded-xl border border-[#3b2a6e] bg-night-2 p-3 md:grid-cols-2"
      >
        <label className={LABEL}>
          <span>{labels.home}</span>
          <select name="home" defaultValue={home} className={SELECT}>
            {options()}
          </select>
        </label>
        <label className={LABEL}>
          <span>{labels.away}</span>
          <select name="away" defaultValue={away} className={SELECT}>
            {options()}
          </select>
        </label>
        <button
          type="submit"
          data-testid="qm-add-match-submit"
          aria-disabled={busy || undefined}
          className={`app-display inline-flex min-h-11 w-full max-w-full items-center justify-center rounded-lg border border-[#3b2a6e] bg-transparent px-4 py-2 text-center text-sm font-semibold leading-tight text-cream [overflow-wrap:anywhere] hover:border-[color:var(--mk-lime)] aria-disabled:opacity-70 md:col-span-2 md:w-auto md:justify-self-start ${FOCUS}`}
        >
          {labels.submit}
        </button>
      </form>
    </details>
  );
}
