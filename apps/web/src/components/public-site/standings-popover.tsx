"use client";
// The ONE popover both standings tables explain themselves with: the tie-break
// note on a rank, and the won/lost totals behind a ratio cell. Used by
// `standings-table.tsx` (the division page, the embed, the organiser console)
// and `standings-table-view.tsx` (the hub's Table tab), so the two surfaces
// open, dismiss and read the same way.
//
// It replaces a native `<details>` that never closed on an outside tap (you
// had to find its own trigger again) and, on the hub, a `title=` a phone
// cannot hover. What it owes, all of it the brief's:
//
//  * closes on a tap or click OUTSIDE it, on Esc, and when ANOTHER one opens —
//    one explanation on screen at a time, across both tables;
//  * a real `<button>` trigger with `aria-expanded` and `aria-controls`, and
//    focus handed back to that button when Esc closes it.
//
// The panel is ALWAYS in the markup, `hidden` while closed, rather than
// mounted on open: `aria-controls` must name an element that exists, and
// `aria-describedby` lets a screen reader hear the explanation on focus
// without opening anything (a hidden node referenced directly still names).
//
// GEOMETRY — two outcomes from the `<details>` this replaced, both measured on
// the live page with `elementFromPoint`, both kept:
//
//  * The root carries `data-open` while open, so a sticky host cell can raise
//    itself with `has-[[data-open]]:z-30` (`standings-table.tsx` explains why
//    the CELL, not the panel, has to rise).
//  * The LAST row opens UPWARD (`[tr:last-child_&]:…`). Both tables sit in an
//    `overflow-x-auto` box, which computes `overflow-y: auto` too, so a panel
//    hanging below the final row is clipped by that box — and clipping
//    happens before stacking, so no z-index can rescue it.
//
// The panel is `z-20`, above the sticky rank cells' `z-10`. Inside a sticky
// cell that number is local to the cell (the raise above does the work); in a
// plain cell — a ratio column — it is what keeps a panel that hangs left over
// the frozen rank column from being painted under it.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Fired on `document` with the opener's id when a popover opens, so every
 *  other open one closes. An event rather than shared state because the
 *  division page mounts one table per pool and nothing else connects them. */
export const POPOVER_OPEN_EVENT = "seazn:standings-popover-open";

export interface StandingsPopoverProps {
  /** What the button shows — the rank chip and its marker, or the ratio. */
  trigger: ReactNode;
  /** The explanation the panel holds. */
  children: ReactNode;
  /** `start` hangs the panel from the trigger's left edge (the rank column,
   *  at the table's left); `end` from its right edge (a ratio column, at the
   *  table's right), so neither runs out of its own scroll box. */
  align?: "start" | "end";
  /** The button's `data-testid`; the panel gets `${testid}-panel`. */
  testid?: string;
  /** Layout for the button itself — its display, gap and hit area. */
  className?: string;
}

/** Shared by every panel, exported so the static-markup tests read the classes
 *  the component actually emits rather than a copy. The `normal-case` /
 *  `tracking-normal` / `font-normal` reset matters: a host cell can be bold
 *  (points) or right-aligned (every numeric column), and the note must read
 *  the same wherever it opens. */
export const PANEL_CLASS =
  "absolute top-full z-20 mt-1 block w-56 rounded-lg border border-zinc-200 bg-surface p-2 text-left text-xs font-normal normal-case leading-snug tracking-normal whitespace-normal text-zinc-700 shadow-lg [tr:last-child_&]:bottom-full [tr:last-child_&]:top-auto [tr:last-child_&]:mb-1 [tr:last-child_&]:mt-0";

export function StandingsPopover({
  trigger,
  children,
  align = "start",
  testid,
  className = "",
}: StandingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const panelId = `${id}-panel`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onOtherOpened = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener(POPOVER_OPEN_EVENT, onOtherOpened);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener(POPOVER_OPEN_EVENT, onOtherOpened);
    };
  }, [open, id]);

  const toggle = () => {
    // Announce BEFORE opening, so a popover opened from the keyboard — no
    // pointerdown anywhere — still closes the one already open.
    if (!open) document.dispatchEvent(new CustomEvent(POPOVER_OPEN_EVENT, { detail: id }));
    setOpen(!open);
  };

  return (
    <span ref={rootRef} data-open={open ? "" : undefined} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-testid={testid}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={panelId}
        onClick={toggle}
        className={`cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
      >
        {trigger}
      </button>
      <span
        id={panelId}
        role="note"
        data-testid={testid ? `${testid}-panel` : undefined}
        hidden={!open}
        className={`${PANEL_CLASS} ${align === "end" ? "right-0" : "left-0"}`}
      >
        {children}
      </span>
    </span>
  );
}
