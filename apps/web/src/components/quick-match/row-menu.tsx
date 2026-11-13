"use client";
// The quick match home's row menu (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md Task 4, D6, D7; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6 "Option A"; owner 2026-11-13: ONE ⋯ menu
// per row). A match still to play offers its Score and "Not played"; a finished one "Edit result"; a Not played one "Put
// back". The list decides what a row offers (match-list.tsx `rowMenuItems`); the page builds each action's path and words
// and hands them here. Nothing else of the match reaches this island.
//
//   - No script: the menu is a native `<details>` (keyboard and screen-reader reachable as is), and every item is a real
//     `<form method="post">`, so each one posts. "Not played" then skips at once (Put back undoes it, D7).
//   - With the script, "Not played" asks first: its submit is held and a native `<dialog>` opens, a bottom sheet below `md`
//     and a centred dialog from `md`, with the match's own words (the last open match says the league finishes now and the
//     skip cannot be put back, D6; a live one says its score will not count). "Mark not played" posts the skip; "Keep this
//     match", Escape or a tap outside closes it and puts focus back on the ⋯.
//   - One post per menu: the first goes, every later one (a double tap, a second item) is cancelled until the page comes back
//     from the back-forward cache (the guest pressed Back), which unlocks it; `score-form.tsx`'s rule. A button is never
//     `disabled` (that can cancel the post it started); busy is `aria-disabled` and its look.
//   - Opened, a tap outside or Escape closes the menu; the menus share one `name`, so opening one closes any other.
//   - `ph-no-capture` on every form: each action holds the home token, the quick match's credential (O3), so session replay
//     must never record it (scrub-secret-painters.test.ts).
//   - Every target is 44px (min-h-11; the ⋯ is 44 by 44).
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Ban, Ellipsis, PencilLine, Undo2, Zap } from "lucide-react";

/** The items' words, in the viewer's language (the page's dictionary). */
export interface QuickMatchRowMenuWords {
  /** "Score" (`quickMatch.home.scoreShort`). */
  score: string;
  /** "Edit result". */
  editResult: string;
  /** "Not played", and its hint: "Skip it. No points for either side." */
  notPlayed: string;
  notPlayedHint: string;
  /** "Put back". */
  putBack: string;
}

/** The confirm sheet's words for this match (home.tsx `SkipCopy`, with the two buttons). */
export interface QuickMatchSkipSheetWords {
  title: string;
  body: string;
  /** A live match's score that will not count; null when nothing is scored. */
  partial: string | null;
  /** "Mark not played". */
  confirm: string;
  /** "Keep this match". */
  keep: string;
}

export interface QuickMatchRowMenuProps {
  /** The ⋯ button's accessible name, naming the match: "More actions for A v B" (`quickMatch.home.moreActions`). */
  label: string;
  /** Each item's post, `/q/<token>/…`, built by the page; an absent one is not offered. */
  scoreAction?: string;
  editAction?: string;
  /** "Not played" is offered only WITH its sheet: never a skip that cannot ask first. */
  skipAction?: string;
  putBackAction?: string;
  words: QuickMatchRowMenuWords;
  sheet?: QuickMatchSkipSheetWords;
}

type Submit = FormEvent<HTMLFormElement> | { preventDefault(): void };

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream";
const ITEM =
  "flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold leading-snug text-cream hover:bg-[#2c1d63] aria-disabled:opacity-70 " +
  FOCUS;
const ICON = "mt-0.5 h-4 w-4 flex-none text-[#b7aede]";

export function QuickMatchRowMenu({ label, scoreAction, editAction, skipAction, putBackAction, words, sheet }: QuickMatchRowMenuProps) {
  const titleId = useId();
  const bodyId = useId();
  const details = useRef<HTMLDetailsElement | null>(null);
  const summary = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // Never a skip that cannot ask first: "Not played" needs its action AND its sheet.
  const canSkip = skipAction !== undefined && sheet !== undefined;

  // Back from the pad or the home (bfcache): the page comes back exactly as it was left, locked mid-post. Unlock it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      locked.current = false;
      setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // While the menu is open: a tap outside it, or Escape, closes it (Escape puts focus back on the ⋯).
  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      if (details.current) details.current.open = false;
      if (refocus) summary.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (details.current && target !== null && !details.current.contains(target)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Any post of this menu: the first goes through untouched, every later one is cancelled until a bfcache restore. */
  function post(e: Submit) {
    if (locked.current) {
      e.preventDefault();
      return;
    }
    locked.current = true;
    setBusy(true);
  }

  /** "Not played" in the menu: hold the post and ask first. With no `<dialog>` to open (none mounted, or a browser without
   *  `showModal`), it posts as it does with no script. */
  function askFirst(e: Submit) {
    const sheetEl = dialog.current;
    if (locked.current || !sheetEl || typeof sheetEl.showModal !== "function") return post(e);
    e.preventDefault();
    if (details.current) details.current.open = false;
    sheetEl.showModal();
    // The safe answer has the focus: an Enter does not skip the match.
    keep.current?.focus();
  }

  // `ask`: "Not played", which asks first; every other item posts at once. A flag, not the handler itself: the handlers
  // read the lock (a ref), so they are named only as the form's event prop, never passed through a render-time call.
  const item = (testId: string, action: string, icon: ReactNode, text: string, ask: boolean, hint?: string): ReactNode => (
    <form key={testId} method="post" action={action} onSubmit={ask ? askFirst : post} className="ph-no-capture min-w-0">
      <button type="submit" data-testid={testId} aria-disabled={busy || undefined} className={ITEM}>
        {icon}
        <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
          <span>{text}</span>
          {hint ? <span className="text-xs font-normal text-[#b7aede]">{hint}</span> : null}
        </span>
      </button>
    </form>
  );

  return (
    <div className="ph-no-capture relative flex-none">
      <details
        ref={details}
        name="qm-row-menu"
        data-testid="qm-row-menu"
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="group/menu"
      >
        <summary
          ref={summary}
          aria-label={label}
          data-testid="qm-row-menu-toggle"
          className={`flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-lg border border-[#3b2a6e] text-[#d9d2f2] hover:border-[#6b5aa6] group-open/menu:border-[color:var(--mk-lime)] group-open/menu:text-[color:var(--mk-lime)] [&::-webkit-details-marker]:hidden ${FOCUS}`}
        >
          <Ellipsis aria-hidden="true" className="h-5 w-5" />
        </summary>
        <div
          data-testid="qm-row-menu-panel"
          className="absolute right-0 top-full z-30 mt-1.5 flex w-64 max-w-[calc(100vw-2.5rem)] flex-col gap-0.5 rounded-xl border border-[#3b2a6e] bg-[#1d1146] p-1.5 shadow-[0_22px_44px_-16px_rgba(0,0,0,0.75)]"
        >
          {scoreAction !== undefined ? item("qm-menu-score", scoreAction, <Zap aria-hidden="true" className={ICON} />, words.score, false) : null}
          {canSkip
            ? item("qm-skip", skipAction, <Ban aria-hidden="true" className={ICON} />, words.notPlayed, true, words.notPlayedHint)
            : null}
          {editAction !== undefined
            ? item("qm-edit-result", editAction, <PencilLine aria-hidden="true" className={ICON} />, words.editResult, false)
            : null}
          {putBackAction !== undefined
            ? item("qm-put-back", putBackAction, <Undo2 aria-hidden="true" className={ICON} />, words.putBack, false)
            : null}
        </div>
      </details>
      {canSkip ? (
        <dialog
          ref={dialog}
          data-testid="qm-skip-sheet"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          // Closed by Keep, Escape or a tap on the backdrop: focus goes back to the ⋯ (the menu it came from is closed).
          onClose={() => {
            if (!locked.current) summary.current?.focus();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) e.currentTarget.close();
          }}
          className="mx-0 mb-0 mt-auto w-full max-w-none rounded-t-2xl border border-b-0 border-[#3b2a6e] bg-night-2 p-0 text-cream shadow-[0_-18px_40px_-20px_rgba(0,0,0,0.8)] backdrop:bg-[rgb(8_4_24/0.72)] md:m-auto md:w-[28rem] md:max-w-[calc(100%-2rem)] md:rounded-2xl md:border-b"
        >
          <div className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 md:p-6">
            <h2
              id={titleId}
              data-testid="qm-skip-title"
              className="app-display text-xl font-bold leading-tight text-cream [overflow-wrap:anywhere]"
            >
              {sheet.title}
            </h2>
            <div id={bodyId} className="mt-2 flex flex-col gap-2 text-sm leading-relaxed text-[#d9d2f2] [overflow-wrap:anywhere]">
              {sheet.partial !== null ? <p data-testid="qm-skip-partial">{sheet.partial}</p> : null}
              <p data-testid="qm-skip-body">{sheet.body}</p>
            </div>
            <form method="post" action={skipAction} onSubmit={post} className="ph-no-capture mt-5 flex flex-col gap-2.5">
              <button
                type="submit"
                data-testid="qm-skip-confirm"
                aria-disabled={busy || undefined}
                className={`app-display inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[color:var(--mk-lime)] px-5 py-2.5 text-center text-base font-bold leading-tight text-night aria-disabled:opacity-70 ${FOCUS}`}
              >
                {sheet.confirm}
              </button>
              <button
                ref={keep}
                type="button"
                data-testid="qm-skip-keep"
                onClick={() => dialog.current?.close()}
                className={`app-display inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-[#3b2a6e] bg-transparent px-5 py-2.5 text-center text-base font-semibold leading-tight text-cream hover:border-[#6b5aa6] ${FOCUS}`}
              >
                {sheet.keep}
              </button>
            </form>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
