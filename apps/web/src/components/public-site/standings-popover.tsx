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
//    focus handed back to that button when Esc closes it — only when focus
//    was on the button or in the panel, and never for an Esc another handler
//    already claimed (`defaultPrevented`);
//  * closes when focus leaves the button and the panel together (tabbing
//    away). The panel is focusable but not tabbable (`tabIndex={-1}`), so a
//    tap on its own text moves focus INTO it rather than to `<body>`, which
//    would read as leaving;
//  * a 40px tap target both ways: `min-w-10` here, and each host stretches
//    the button over its cell's `py-2.5` with `-my-2.5 py-2.5`.
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
//  * Any OTHER row opens downward when the panel fits below, upward when it
//    fits only above (`data-side="up"`), measured on open. The last-row rule
//    alone left the hub's third row of four 3px short: a two-line panel is
//    taller than the one short row beneath it. The CSS rule stays as the
//    default, so the last row never paints downward even for a frame.
//  * A panel that fits NEITHER side goes to the roomier one (below on a tie)
//    and is clamped to it — `max-height` and its own scroll — rather than
//    having its top or bottom cut off by the box.
//  * Sideways, it is shifted back inside the box's visible width. A ratio
//    panel hangs LEFT from its cell, and with the table scrolled right (at
//    320, carrom's board ratio) its left edge fell in the columns scrolled out
//    of view and "Boards won…" lost its first letter.
//
// The panel is `z-20`, above the sticky rank cells' `z-10`. Inside a sticky
// cell that number is local to the cell (the raise above does the work); in a
// plain cell — a ratio column — it is what keeps a panel that hangs left over
// the frozen rank column from being painted under it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
  "absolute top-full z-20 mt-1 block w-56 rounded-lg border border-zinc-200 bg-surface p-2 text-left text-xs font-normal normal-case leading-snug tracking-normal whitespace-normal text-zinc-700 shadow-lg focus:outline-none [tr:last-child_&]:bottom-full [tr:last-child_&]:top-auto [tr:last-child_&]:mb-1 [tr:last-child_&]:mt-0 data-[side=up]:bottom-full data-[side=up]:top-auto data-[side=up]:mb-1 data-[side=up]:mt-0";

/** The panel's `mt-1` / `mb-1`: the gap between the trigger and the panel. */
const GAP_PX = 4;

/** The nearest ancestor that clips its content — on both tables, the
 *  `overflow-x-auto` scroll box. `null` when nothing clips. */
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") return a;
  }
  return null;
}

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
  const panelRef = useRef<HTMLSpanElement>(null);

  // Before paint, on every open, against the box that clips the panel: down
  // when it fits below; up when it fits only above; when it fits neither, the
  // roomier side (below on a tie), clamped to that room with its own scroll.
  // The last row is always up — its CSS already says so, and below it there
  // is only the box's edge. Written straight to the node (React renders no
  // `data-side` or inline style here, so it never overwrites them) and cleared
  // first, so each open measures afresh.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const root = rootRef.current;
    if (!open || !panel || !root) return;
    delete panel.dataset.side;
    panel.style.maxHeight = "";
    panel.style.overflowY = "";
    panel.style.translate = "";
    const box = clippingAncestor(root);
    if (!box) return;
    const edge = box.getBoundingClientRect();
    const top = edge.top + box.clientTop;
    const bottom = top + box.clientHeight;
    const anchor = root.getBoundingClientRect();
    const below = bottom - anchor.bottom - GAP_PX;
    const above = anchor.top - top - GAP_PX;
    const height = panel.getBoundingClientRect().height;
    const lastRow = root.closest("tr")?.matches(":last-child") ?? false;
    const up = lastRow || (height > below + 0.5 && (height <= above + 0.5 || above > below));
    if (up) panel.dataset.side = "up";
    const room = up ? above : below;
    if (height > room + 0.5) {
      panel.style.maxHeight = `${Math.max(0, Math.floor(room))}px`;
      panel.style.overflowY = "auto";
    }
    const left = edge.left + box.clientLeft;
    const right = left + box.clientWidth;
    const placed = panel.getBoundingClientRect();
    let dx = 0;
    if (placed.left < left) dx = Math.ceil(left - placed.left);
    else if (placed.right > right) dx = Math.floor(right - placed.right);
    if (dx !== 0) panel.style.translate = `${dx}px 0`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The outside-tap close. Not redundant with the focusout close below: on
    // iOS Safari a tap does not focus the button, so no focusout ever fires
    // and this is the ONLY thing that closes it there.
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Claimed by someone else (a dialog around the table, say): not ours.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Hand focus back only if it was ours to hand: on the button or in the
      // panel. Focus elsewhere on the page stays where the reader put it.
      const focusInside = rootRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (focusInside) buttonRef.current?.focus();
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
    <span
      ref={rootRef}
      data-open={open ? "" : undefined}
      className="relative inline-flex"
      // Focus leaving the button AND the panel — tabbing away — closes it.
      // `relatedTarget` is where focus went; null (to nothing) is leaving too.
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid={testid}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={panelId}
        onClick={toggle}
        className={`min-w-10 cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
      >
        {trigger}
      </button>
      <span
        ref={panelRef}
        id={panelId}
        role="note"
        tabIndex={-1}
        data-testid={testid ? `${testid}-panel` : undefined}
        hidden={!open}
        className={`${PANEL_CLASS} ${align === "end" ? "right-0" : "left-0"}`}
      >
        {children}
      </span>
    </span>
  );
}
