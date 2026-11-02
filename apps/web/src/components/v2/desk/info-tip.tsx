"use client";

// Match Day E1 item 1 (owner 2026-11-01): a control that is not available yet says WHY through an ⓘ beside it, not in a line of its
// own. One ⓘ, three ways in, one reason in the DOM the whole time:
//   - hover (a mouse over the ⓘ or over the control it sits beside) and keyboard focus (the ⓘ is a button in the tab order, so
//     a person who tabs to it, or to the control, reads the reason) show the bubble from CSS alone - no state to go stale;
//   - a tap (touch has no hover) toggles it open, and it stays open until another tap outside it or Escape;
//   - Escape also puts away a bubble that hover or focus is holding up (WCAG 1.4.13, dismissable without moving the pointer), and it
//     stays away until the pointer and focus have both left and one returns (`info-tip-state.ts` - the transitions, as pure functions);
//   - a screen reader reads it as the DESCRIPTION of the control: the control's `aria-describedby` and the ⓘ's both name the
//     bubble's id, and the bubble is `role="tooltip"` whether it is showing or not.
// Below `md` the bubble opens IN FLOW under the row (the control sits in a scrolling bottom sheet there, which would clip an
// absolutely-placed bubble); from `md` it floats under the ⓘ.
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { TIP_CLOSED, tipEscape, tipLeft, tipOutside, tipToggle, type TipState } from "./info-tip-state";

/** Is the pointer over the wrapper, or focus inside it? Read from the DOM when asked (CSS is what shows the bubble for either), never
 *  mirrored in state - so it cannot go stale. */
function isEngaged(root: Element | null): boolean {
  return root?.matches(":hover, :focus-within") === true;
}

export function WithInfoTip({
  id,
  label,
  reason,
  infoTestId,
  reasonTestId,
  children,
}: {
  /** The bubble's id - the control's `aria-describedby` must name the same one. */
  id: string;
  /** The ⓘ's accessible name ("Why Complete stage is not available yet"). */
  label: string;
  /** The reason, in words. */
  reason: React.ReactNode;
  infoTestId: string;
  reasonTestId: string;
  /** The control the ⓘ sits beside. */
  children: React.ReactNode;
}) {
  const [tip, setTip] = useState<TipState>(TIP_CLOSED);
  const { open, dismissed } = tip;
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setTip(tipOutside);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { state, consumed } = tipEscape(tip, isEngaged(rootRef.current));
      if (!consumed) return;
      // Spent here: the bottom sheet around this listens for the same key on `document` (bubble phase, registered BEFORE this effect ran)
      // and stays open when the key is `defaultPrevented`. Listening in the CAPTURE phase is what puts this handler first, whatever the
      // registration order - a bubble listener added later would see the sheet already closed. When nothing is showing the key is left
      // alone, so the sheet still closes on it.
      e.preventDefault();
      setTip(state);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [tip]);

  return (
    <span
      ref={rootRef}
      onPointerLeave={() => setTip((t) => tipLeft(t, isEngaged(rootRef.current)))}
      onBlur={(e) => {
        // Focus moving to another control INSIDE the wrapper is not leaving it.
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setTip((t) => tipLeft(t, isEngaged(rootRef.current)));
      }}
      className="group/tip relative flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 max-md:w-full md:inline-flex md:flex-nowrap">
      {children}
      <button
        type="button"
        data-testid={infoTestId}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setTip(tipToggle)}
        className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-slate-500 transition hover:text-purple-700 focus-visible:text-purple-700"
      >
        <Info className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      </button>
      {/* Always in the DOM (the control's `aria-describedby` needs it, shown or not); `hidden` is what a closed bubble is. */}
      <span
        role="tooltip"
        id={id}
        data-testid={reasonTestId}
        data-open={open ? "true" : "false"}
        className={`${open ? "block" : dismissed ? "hidden" : "hidden group-hover/tip:block group-focus-within/tip:block"} min-w-0 text-xs leading-snug text-slate-700 max-md:basis-full max-md:rounded-lg max-md:bg-slate-50 max-md:px-3 max-md:py-2 md:absolute md:left-0 md:top-full md:z-30 md:mt-1 md:w-64 md:max-w-[calc(100vw-2rem)] md:rounded-xl md:border md:border-purple-100 md:bg-white md:p-3 md:shadow-lg`}
      >
        {reason}
      </span>
    </span>
  );
}
