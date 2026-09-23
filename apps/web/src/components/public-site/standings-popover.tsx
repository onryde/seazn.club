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
// GEOMETRY. Two outcomes are kept from the `<details>` this replaced, both
// measured on the live page with `elementFromPoint`. Then comes how an OPEN
// panel is placed.
//
//  * The root carries `data-open` while open. A sticky host cell can then
//    raise itself with `has-[[data-open]]:z-30`; `standings-table.tsx`
//    explains why the CELL, not the panel, has to rise.
//  * An open panel is `position: fixed`, placed from the trigger's own box on
//    every open, scroll and resize. It is NOT a portal: the panel stays where
//    it is in the markup, so `aria-controls`, `aria-describedby`, the unit
//    tests' `panelOf` and the tables' goldens are untouched. What changes is
//    its containing block. Both tables sit in an `overflow-x-auto` box, which
//    computes `overflow-y: auto` too, and an ABSOLUTE panel was clipped by
//    that box, because clipping happens before stacking and no z-index
//    rescues it. The hub's four-part qualification popover (status, if you
//    lose, tie note, what-if) showed 157px of its 178px at every width
//    (Task 8, measured), so the what-if's numbers were unreadable. A fixed
//    panel's containing block is the viewport, so the box no longer clips it.
//  * The VIEWPORT is the room, with 16px gutters on every side, and the width
//    is capped at the viewport less 32px (spec 2026-09-22 §5).
//  * Which side it opens on:
//    - A panel opens on its preferred side when it fits there. That is below
//      the trigger, except on the LAST row, where it is above (spec §5: "on
//      the last rows it opens upward"; the CSS `[tr:last-child_&]` default
//      keeps that true even before the first measurement).
//    - Otherwise it opens on the other side, if it fits there (`data-side`
//      records "up").
//    - A panel that fits on NEITHER side goes to the roomier one and slides
//      along the viewport to stay whole, over its own trigger if need be.
//    - Only a panel taller than the whole viewport less its gutters is
//      capped (`max-height`) and scrolls its own text.
//  * Sideways, it hangs from the trigger's left edge (`start`) or its right
//    edge (`end`), then is shifted back inside the viewport's gutters.
//  * An ancestor with a transform or a filter would make ITSELF the
//    containing block for `fixed`. The placement therefore measures where
//    the panel landed and corrects by the difference, so an offset container
//    cannot move it away from its trigger. The e2e probe also asserts that no
//    such ancestor exists on any mount.
//
// The panel is `z-20`, above the sticky rank cells' `z-10`. Inside a sticky
// cell that number is local to the cell, and the raise above does the work.
// In a plain cell (a ratio column) it is what stops a panel that hangs left
// over the frozen rank column from being painted under it. `fixed` does not
// change which stacking context the panel paints in.
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
  /** The button's accessible name, for a trigger whose content cannot say it:
   *  a rank chip beside an aria-hidden qualification marker is named "Rank 3,
   *  Win and in, show details" (spec 2026-09-22 §5). Omitted — every trigger
   *  before that — and the content names the button, exactly as before. */
  ariaLabel?: string;
}

/** Shared by every panel, exported so the static-markup tests read the classes
 *  the component actually emits rather than a copy. The `normal-case` /
 *  `tracking-normal` / `font-normal` reset matters: a host cell can be bold
 *  (points) or right-aligned (every numeric column), and the note must read
 *  the same wherever it opens. */
export const PANEL_CLASS =
  "absolute top-full z-20 mt-1 block w-56 rounded-lg border border-zinc-200 bg-surface p-2 text-left text-xs font-normal normal-case leading-snug tracking-normal whitespace-normal text-zinc-700 shadow-lg focus:outline-none [tr:last-child_&]:bottom-full [tr:last-child_&]:top-auto [tr:last-child_&]:mb-1 [tr:last-child_&]:mt-0 data-[side=up]:bottom-full data-[side=up]:top-auto data-[side=up]:mb-1 data-[side=up]:mt-0";

/** The gap between the trigger and the panel: the `mt-1` / `mb-1` the classes
 *  carry, restated because an open panel's margins are zeroed (it is placed
 *  by `top`, and a margin would add to it). */
const GAP_PX = 4;

/** The viewport gutter an open panel keeps on every side (spec §5: at most
 *  the screen width less 32px). */
const GUTTER_PX = 16;

/** Places an OPEN panel: `position: fixed`, from the trigger root's box,
 *  inside the viewport's gutters. Written straight to the node (React renders
 *  no `style` or `data-side` on the panel, so it never overwrites them), and
 *  measured afresh on each call: this runs on open, on every scroll (the
 *  page's or the table's own box) and on resize. */
function placePanel(panel: HTMLElement, root: HTMLElement, align: "start" | "end"): void {
  const view = document.documentElement;
  const vw = view.clientWidth;
  const vh = view.clientHeight;
  const s = panel.style;
  s.position = "fixed";
  s.left = "0px";
  s.top = "0px";
  s.right = "auto";
  s.bottom = "auto";
  s.margin = "0px";
  s.translate = "";
  s.maxWidth = `${vw - 2 * GUTTER_PX}px`;
  s.maxHeight = "";
  s.overflowY = "";
  const size = panel.getBoundingClientRect();
  const anchor = root.getBoundingClientRect();

  const below = vh - GUTTER_PX - (anchor.bottom + GAP_PX);
  const above = anchor.top - GAP_PX - GUTTER_PX;
  const fitsBelow = size.height <= below + 0.5;
  const fitsAbove = size.height <= above + 0.5;
  const preferUp = root.closest("tr")?.matches(":last-child") ?? false;
  const fitsPreferred = preferUp ? fitsAbove : fitsBelow;
  const fitsOther = preferUp ? fitsBelow : fitsAbove;
  const up = fitsPreferred
    ? preferUp
    : fitsOther
      ? !preferUp
      : above === below
        ? preferUp
        : above > below;
  if (up) panel.dataset.side = "up";
  else delete panel.dataset.side;

  let top = up ? anchor.top - GAP_PX - size.height : anchor.bottom + GAP_PX;
  if (!fitsPreferred && !fitsOther) {
    const room = vh - 2 * GUTTER_PX;
    if (size.height > room + 0.5) {
      top = GUTTER_PX;
      s.maxHeight = `${Math.max(0, Math.floor(room))}px`;
      s.overflowY = "auto";
    } else {
      top = Math.min(Math.max(top, GUTTER_PX), vh - GUTTER_PX - size.height);
    }
  }
  const wanted = align === "end" ? anchor.right - size.width : anchor.left;
  const left = Math.min(Math.max(wanted, GUTTER_PX), vw - GUTTER_PX - size.width);
  s.left = `${left}px`;
  s.top = `${top}px`;
  // Correct for a containing block that is not the viewport (see GEOMETRY).
  const placed = panel.getBoundingClientRect();
  const dx = left - placed.left;
  const dy = top - placed.top;
  if (Math.abs(dx) > 0.5) s.left = `${left + dx}px`;
  if (Math.abs(dy) > 0.5) s.top = `${top + dy}px`;
}

export function StandingsPopover({
  trigger,
  children,
  align = "start",
  testid,
  className = "",
  ariaLabel,
}: StandingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const panelId = `${id}-panel`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  // Before paint, on every open: placed fixed from the trigger (see
  // `placePanel`). Closing hands the panel back exactly as the markup has it,
  // with no `style` and no `data-side`, so a closed popover's DOM is its SSR.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const root = rootRef.current;
    if (!open || !panel || !root) return;
    placePanel(panel, root, align);
    return () => {
      panel.removeAttribute("style");
      delete panel.dataset.side;
    };
  }, [open, align]);

  // While open, it follows its trigger on any scroll and on resize. A scroll
  // event does not bubble, so only the CAPTURE phase hears the table's own box
  // as well as the page. The panel's OWN scroll (an over-tall one reading its
  // text) is ignored: re-placing it resets `overflow`, and with it the
  // reader's place.
  useEffect(() => {
    const panel = panelRef.current;
    const root = rootRef.current;
    if (!open || !panel || !root) return;
    const follow = (e: Event) => {
      if (e.target instanceof Node && panel.contains(e.target)) return;
      placePanel(panel, root, align);
    };
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
    };
  }, [open, align]);

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
        aria-label={ariaLabel}
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
