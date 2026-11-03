"use client";

// Match Day E1 item 1 (owner 2026-11-01), taken off the ⓘ by PB1 (owner 2026-11-02): a control that is not available yet says WHY from
// the control itself, not through a second button beside it. One reason, three ways in, one bubble in the DOM the whole time:
//   - hover (a mouse over the greyed control) and keyboard focus (it is `aria-disabled`, not `disabled`, so it stays in the tab order)
//     show the bubble from CSS alone - no state to go stale;
//   - a tap (touch has no hover) or an Enter/Space press on the greyed control toggles it open, and it stays open until a tap outside
//     it or Escape - the press itself does nothing else, that is the caller's `aria-disabled` handler;
//   - Escape also puts away a bubble that hover or focus is holding up (WCAG 1.4.13, dismissable without moving the pointer), and it
//     stays away until the pointer and focus have both left and one returns (`reason-tip-state.ts` - the transitions, as pure functions);
//   - a screen reader reads it as the DESCRIPTION of the control: the control's `aria-describedby` names the bubble's id, and the bubble
//     is `role="tooltip"` whether it is showing or not.
// Below `md` the bubble opens IN FLOW under the control (it sits in a scrolling bottom sheet there, which would clip an absolutely-placed
// bubble); from `md` it floats under the control, and a transparent bridge over the gap keeps it up while the pointer crosses to it
// (WCAG 1.4.13 "hoverable"). HOVER reveals it from `md` only: below it there is no pointer to hover with, and the bottom sheet grows
// UPWARD when the in-flow bubble appears - a hover reveal would slide the control from under the very press that follows the hover (the
// press then lands on the bubble, which is not a press on the control). Focus and the tap reveal it there; a press's own focus slides the
// control too, but a click whose press and release land on different elements is dispatched to their common ancestor - the wrapper.
import { useEffect, useRef, useState } from "react";
import { TIP_CLOSED, tipEscape, tipLeft, tipOutside, tipToggle, type TipState } from "./reason-tip-state";

/** Is the pointer over the wrapper, or focus inside it? Read from the DOM when asked (CSS is what shows the bubble for either), never
 *  mirrored in state - so it cannot go stale. */
function isEngaged(root: Element | null): boolean {
  return root?.matches(":hover, :focus-within") === true;
}

export function WithReasonTip({
  id,
  reason,
  reasonTestId,
  align = "start",
  children,
}: {
  /** The bubble's id - the control's `aria-describedby` must name the same one. */
  id: string;
  /** The reason, in words. */
  reason: React.ReactNode;
  reasonTestId: string;
  /** Which edge of the control the floating bubble hangs from (from `md`; below it the bubble is in flow). `end` for a control that is
   *  last in a right-aligned group (the stage card's Bracket button): a 256px bubble from its left edge would run off the card. The
   *  two class strings are literal on purpose - Tailwind only generates tokens it can read. */
  align?: "start" | "end";
  /** The greyed control that owns the reason. */
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
    // The press handler is on the wrapper: the greyed control keeps its own handler (which refuses), and its click bubbles here. A press
    // inside the bubble (selecting its words) is not a press on the control. The keyboard path is the control's own Enter/Space click,
    // which bubbles here the same way.
    <span
      ref={rootRef}
      onClick={(e) => {
        if ((e.target as Element).closest('[role="tooltip"]')) return;
        setTip(tipToggle);
      }}
      onPointerLeave={() => setTip((t) => tipLeft(t, isEngaged(rootRef.current)))}
      onBlur={(e) => {
        // Focus moving to another control INSIDE the wrapper is not leaving it.
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setTip((t) => tipLeft(t, isEngaged(rootRef.current)));
      }}
      className="group/tip relative flex min-w-0 flex-wrap items-center gap-y-1 max-md:w-full md:inline-flex md:flex-nowrap">
      {children}
      {/* Always in the DOM (the control's `aria-describedby` needs it, shown or not); `hidden` is what a closed bubble is. */}
      <span
        role="tooltip"
        id={id}
        data-testid={reasonTestId}
        data-open={open ? "true" : "false"}
        className={`${open ? "block" : dismissed ? "hidden" : "hidden md:group-hover/tip:block group-focus-within/tip:block"} min-w-0 text-xs leading-snug text-slate-700 max-md:basis-full max-md:rounded-lg max-md:bg-slate-50 max-md:px-3 max-md:py-2 md:absolute ${align === "end" ? "md:right-0" : "md:left-0"} md:top-full md:z-30 md:mt-1 md:w-64 md:max-w-[calc(100vw-2rem)] md:rounded-xl md:border md:border-purple-100 md:bg-white md:p-3 md:shadow-lg md:before:absolute md:before:inset-x-0 md:before:-top-1.5 md:before:h-1.5`}
      >
        {reason}
      </span>
    </span>
  );
}
