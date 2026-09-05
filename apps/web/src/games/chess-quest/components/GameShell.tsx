"use client";

// Shared chrome for every mini-game (replaces the original modal): title +
// score header, a one-line subtitle strip, coach bubble with rich status and
// answer chips, an occasional-choices `picker`, an `extra` slot (puzzle dots)
// the board, and a controls row.
//
// Phone composition — design of record 2026-09-05, "Option 1 — Board first,
// picks in a sheet". ONE DOM, branched: everything below Tailwind `md` (768)
// is `max-md:*`, everything phone-only is `md:hidden`. There is no second
// phone tree, and >=768 renders exactly what it rendered before.
//
//   phone   header → subtitle → BOARD → coach → extra → sticky thumb bar
//   desktop header → coach → subtitle → picker (inline) → extra → board → controls
//
// Source order IS the desktop order (no `md:order-*` anywhere); the phone
// column is re-ordered with `max-md:order-1..6` on the six slots.
//
// `picker` is the occasional choice — which pack, which pieces, which puzzle.
// Desktop shows it inline; phones move it behind a middle button in the thumb
// bar that opens a bottom sheet. Its children are therefore rendered TWICE
// (the inline copy is `max-md:hidden`, the sheet is `md:hidden`), which is the
// same duplication the scoring pad's phone composition accepts for its device
// hand-over control: only one copy is ever in the accessibility tree, because
// the other is `display:none`.
import { Children, Fragment, isValidElement, useCallback, useEffect, useRef, useState } from "react";
import { Rich } from "./rich";

// Flatten a `controls` node so the picker button can be dropped into the
// MIDDLE of the phone thumb bar (Hint · Packs · Restart). Games conventionally
// pass a single fragment of buttons, and Children.toArray() would hand that
// fragment back as one item — so unwrap exactly one level of it.
function controlItems(controls: React.ReactNode): React.ReactNode[] {
  const top = Children.toArray(controls);
  if (top.length === 1 && isValidElement(top[0]) && top[0].type === Fragment) {
    const inner = (top[0] as React.ReactElement<{ children?: React.ReactNode }>).props.children;
    return Children.toArray(inner);
  }
  return top;
}

export function GameShell({
  title,
  score,
  status,
  chips,
  subtitle,
  picker,
  extra,
  controls,
  children,
}: {
  title: string;
  score?: React.ReactNode;
  status: string;
  chips?: { label: string; onPick(): void }[];
  /** One-line strip under the header: the current pack / puzzle name. */
  subtitle?: React.ReactNode;
  /** Occasional choices — inline on desktop, a bottom sheet on phones. */
  picker?: { label: string; children: React.ReactNode };
  extra?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  // Escape dismisses, the page behind must not scroll under an open sheet, and
  // focus belongs to the dialog while it is open and to whatever opened it
  // once it closes. All phone-only in practice: the only trigger is
  // `md:hidden`, so `sheetOpen` can never become true at >=768 and desktop
  // body scroll is never touched.
  //
  // Focus, specifically: on close the sheet's wrapper goes `display:none`, so
  // without the restore below focus falls to <body> and a keyboard or switch
  // user loses their place in the thumb bar — the sheet closes on Escape, on
  // the scrim, on ✕ AND on any pick, so that is four ways to be dropped. And
  // `aria-modal` is a promise no sibling makes good on (nothing here is
  // `inert`), so Tab is cycled inside the panel by hand.
  useEffect(() => {
    if (!sheetOpen) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const focusablesIn = (panel: HTMLElement) =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSheetOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = focusablesIn(panel);
      const active = document.activeElement;
      // The panel itself is only a focus HOLDER (tabIndex -1): a Tab from it,
      // or from anywhere outside the dialog, re-enters at the right end.
      const inside = active instanceof Node && panel.contains(active) && active !== panel;
      if (!stops.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey ? !inside || active === first : !inside || active === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      returnTo?.focus?.();
    };
  }, [sheetOpen]);

  const items = controlItems(controls);
  const pickerButton = picker ? (
    <button
      key="cq-picker-button"
      type="button"
      data-cq="picker-button"
      aria-haspopup="dialog"
      aria-expanded={sheetOpen}
      onClick={() => setSheetOpen(true)}
      className="md:hidden inline-flex h-11 w-full items-center justify-center rounded-xl border border-(color:--cq-accent) bg-(color:--cq-accent) px-3 text-sm font-bold text-white"
    >
      {picker.label}
    </button>
  ) : null;
  const mid = Math.floor(items.length / 2);
  const bar = pickerButton ? [...items.slice(0, mid), pickerButton, ...items.slice(mid)] : items;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-4">
      <header
        data-cq="header"
        className="max-md:order-1 flex items-baseline justify-between gap-3"
      >
        <h2
          data-cq="title"
          className="mk-display max-md:text-lg min-w-0 text-2xl font-bold text-(color:--cq-ink)"
        >
          {title}
        </h2>
        {score ? <div className="text-sm font-medium text-slate-600">{score}</div> : null}
      </header>

      <div data-cq="coach" className="max-md:order-4 flex items-start gap-2">
        <span aria-hidden className="mt-1 text-2xl">
          ♞
        </span>
        <div className="min-h-14 min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-(color:--cq-line-soft) bg-(color:--cq-accent-wash) px-3 py-2">
          <Rich html={status} className="text-sm text-(color:--cq-ink) [&_strong]:font-bold" />
          {chips && chips.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {chips.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={c.onPick}
                  className="rounded-full border border-(color:--cq-accent-line) bg-white px-3 py-1 text-xs font-medium text-(color:--cq-accent-strong) hover:bg-(color:--cq-accent-soft)"
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {subtitle ? (
        <div
          data-cq="subtitle"
          className="max-md:order-2 flex min-w-0 items-center gap-2 text-sm text-(color:--cq-ink)"
        >
          {subtitle}
        </div>
      ) : null}

      {/* `contents`, not a plain block: a puzzle game's picker children are
          themselves `md:hidden` (the sheet's 44px jump grid), so a real flex
          item here would still claim one `gap-3` of the desktop column while
          rendering nothing. `max-md:hidden` is a variant and so still wins
          below 768. */}
      {picker ? (
        <div data-cq="picker-inline" className="contents max-md:hidden">
          {picker.children}
        </div>
      ) : null}

      {extra ? (
        <div data-cq="extra" className="max-md:order-5">
          {extra}
        </div>
      ) : null}

      <div data-cq="board-slot" className="max-md:order-3 flex justify-center">
        {children}
      </div>

      {controls || pickerButton ? (
        <div
          data-cq="controls"
          // Equal thirds at 44px, and the labels shrink to fit them: a
          // three-up bar at 320 leaves ~85px a button, which a `.btn`'s
          // text-sm + px-3.5 cannot hold for a label like "Start pack over".
          className="max-md:order-6 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:grid max-md:auto-cols-fr max-md:grid-flow-col max-md:gap-2 max-md:border-t max-md:border-(color:--cq-line-soft) max-md:bg-white max-md:px-4 max-md:py-2 max-md:[&>*]:h-11 max-md:[&>*]:w-full max-md:[&>*]:min-w-0 max-md:[&>*]:px-1 max-md:[&>*]:text-xs max-md:[&>*]:leading-tight md:flex md:flex-wrap md:justify-center md:gap-2"
        >
          {bar}
        </div>
      ) : null}

      {picker ? (
        <div data-cq="picker-sheet" className="contents md:hidden" hidden={!sheetOpen}>
          <button
            type="button"
            data-cq="picker-sheet-scrim"
            aria-label={`Close ${picker.label.toLowerCase()}`}
            onClick={closeSheet}
            className="fixed inset-0 z-40 bg-black/40"
          />
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={picker.label}
            data-cq="picker-sheet-panel"
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-(color:--cq-line-soft) bg-white px-4 pt-2 pb-6 shadow-2xl outline-none"
          >
            <div
              data-cq="picker-sheet-handle"
              aria-hidden
              className="mx-auto mb-2 h-1 w-9 rounded-full bg-(color:--cq-accent-line)"
            />
            <div className="flex items-center justify-between gap-2">
              <h3 className="mk-display text-base font-bold text-(color:--cq-ink)">
                {picker.label}
              </h3>
              <button
                type="button"
                aria-label="Close"
                onClick={closeSheet}
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-lg text-(color:--cq-accent-strong)"
              >
                ✕
              </button>
            </div>
            {/* Any <button> tapped inside the sheet body IS the pick, so the
                sheet dismisses itself — games need no onPicked hook, and a tap
                on a section heading or the padding leaves it open. */}
            <div
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) closeSheet();
              }}
            >
              {picker.children}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
