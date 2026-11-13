"use client";
// The quick match home's Score control (plan 2 Task 6; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5
// step 3, §7.4): a plain form post to `POST /q/<token>/score/<fixtureId>`, which answers a 303 into the scoring pad (or back
// to the home with a flash). The page builds `action` and the words; this island only keeps a second tap from posting
// twice while the page is leaving.
//
//   - No script: it is still a real `<form method="post">` and posts. The route is idempotent for a tap (a second post
//     re-opens the same link), so an unguarded double tap costs a round trip, nothing more.
//   - With the script: the first submit is the browser's own; every later one is cancelled until the page comes back from
//     the back-forward cache (the guest pressed Back in the pad), which unlocks it.
//   - The button is never `disabled`: disabling the submitter can cancel the post it started. Busy is `aria-disabled` and
//     its look.
//   - `ph-no-capture` on the form: its action holds the home token, the quick match's credential (O3), so session replay
//     must never record it (scrub-secret-painters.test.ts).
import { useEffect, useRef, useState, type FormEvent } from "react";

export interface QuickMatchScoreFormProps {
  /** `/q/<token>/score/<fixtureId>`, built by the page. */
  action: string;
  /** The button's words, in the viewer's language: "Score this match", "Continue scoring", "Score" or "Edit result". */
  label: string;
  /** The hero's full-width button, a list row's compact one, or a settled row's secondary "Edit result" (A-M6): the same
   *  post, outlined rather than filled, so the next match's Score stays the page's one lime call to action. */
  place: "hero" | "row" | "edit";
  /** A row's button names its match through the row's sides (`matchSidesId`): many rows say "Score". */
  describedBy?: string;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream";
const BUTTON = {
  hero: "min-h-12 w-full rounded-xl bg-[color:var(--mk-lime)] px-5 py-2.5 text-base font-bold text-night",
  row: "min-h-11 rounded-lg bg-[color:var(--mk-lime)] px-4 py-2 text-sm font-bold text-night",
  edit: "min-h-11 rounded-lg border border-[#3b2a6e] bg-transparent px-3 py-2 text-sm font-semibold text-cream hover:border-[color:var(--mk-lime)]",
} as const;

export function QuickMatchScoreForm({ action, label, place, describedBy }: QuickMatchScoreFormProps) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);

  // Back from the pad (bfcache): the page comes back exactly as it was left, locked mid-post. Unlock it.
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

  return (
    <form method="post" action={action} onSubmit={onSubmit} data-place={place} className={`ph-no-capture min-w-0 ${place === "hero" ? "w-full" : ""}`}>
      <button
        type="submit"
        data-testid={place === "edit" ? "qm-edit-result" : "qm-score"}
        aria-disabled={busy || undefined}
        aria-describedby={describedBy}
        className={`app-display inline-flex max-w-full items-center justify-center text-center leading-tight [overflow-wrap:anywhere] aria-disabled:opacity-70 ${BUTTON[place]} ${FOCUS}`}
      >
        {label}
      </button>
    </form>
  );
}
