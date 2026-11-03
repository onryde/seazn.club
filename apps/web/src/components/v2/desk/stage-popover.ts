// The stage card's floating menus (owner pick, Option A, 2026-11-03): More and the Pair next ▾ panel used to open IN FLOW inside the
// header's actions group, so opening either grew the card by up to 225px and shoved the settings buttons down a line. From `md` they
// are now popovers hung from their trigger, over the content, so the card does not move; below `md` they stay in flow inside the
// Stage tools sheet exactly as before (a bottom sheet would clip an absolutely-placed panel - `reason-tip.tsx` makes the same split).
//
// The house pattern is `desk-open-menu.tsx` (the competition "Open" menu): a `relative` root holding the trigger and the panel, dismissed
// by an outside press, by Escape (which hands focus back to the trigger), or by choosing an item. Two differences, both forced by
// the card:
//   - the trigger's place depends on how the header wraps, so no fixed side is safe. The panel hangs from the trigger's LEFT edge unless
//     that would run past the viewport, then from its RIGHT edge (`popoverAlign`, measured when the trigger is pressed);
//   - everything is gated on the viewport being `md` or wider AT THE MOMENT OF THE EVENT. A phone's sheet has its own Escape and its own
//     backdrop, and the in-flow menus there never closed on a press elsewhere - that is today's behaviour and it is not changed.
import { useEffect, useRef } from "react";

/** The panel's width from `md` up (`md:w-96`), and the breathing room it keeps from the viewport's edge. */
export const POPOVER_WIDTH_PX = 384;
export const POPOVER_EDGE_PX = 16;

/** Tailwind's `md` breakpoint. */
const FLOATS_FROM = "(min-width: 768px)";

export type PopoverAlign = "start" | "end";

/**
 * Which edge of the trigger the panel hangs from. `start` (the panel's left edge on the trigger's left edge) when the panel fits to the
 * right of it; `end` (right edges together) when it does not but fits to the left; `start` when neither does, so a panel never takes a
 * negative left edge. At every viewport from 768 up one of the two fits for any trigger that is itself on screen.
 */
export function popoverAlign(trigger: { left: number; right: number }, viewportWidth: number): PopoverAlign {
  const room = POPOVER_WIDTH_PX + POPOVER_EDGE_PX;
  const startFits = trigger.left + room <= viewportWidth;
  const endFits = trigger.right - room >= 0;
  return startFits || !endFits ? "start" : "end";
}

/** Measured from the DOM when the trigger is pressed (never tracked, so it cannot go stale); `start` where there is no DOM to measure. */
export function alignOf(trigger: Element | null): PopoverAlign {
  if (!trigger || typeof window === "undefined") return "start";
  return popoverAlign(trigger.getBoundingClientRect(), window.innerWidth);
}

/** True when the viewport is wide enough for the menus to float. Read at the moment of an event, so a resize is always honoured. */
export function floatsNow(): boolean {
  return typeof window !== "undefined" && window.matchMedia(FLOATS_FROM).matches;
}

/**
 * The panel's classes: nothing below `md` (it is the next row of the sheet's column), a popover under the trigger from `md`. `w-96` is
 * capped to the viewport so it can never be wider than the screen it sits on. The caller adds its own box (border, radius, items).
 */
export function popoverClasses(align: PopoverAlign): string {
  return `min-w-0 md:absolute md:top-full md:z-30 md:mt-1 md:w-96 md:max-w-[calc(100vw-2rem)] ${align === "end" ? "md:right-0" : "md:left-0"}`;
}

/** The class an inner box carries so the floating panel reads as raised, from `md` only. */
export const POPOVER_RAISED = "md:shadow-lg";

/** Did this click land on something the menu offers (a link or an enabled button)? Everything else in the panel is just padding or text. */
export function pressedAnItem(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return typeof el?.closest === "function" && el.closest("a[href], button:not(:disabled)") !== null;
}

/**
 * Outside-press and Escape dismissal for a floating menu. Returns the ref for the ROOT element (the trigger and the panel both inside
 * it - a press on the trigger is the trigger's own toggle, not an outside press). `onDismiss` runs only while `open` and only from `md`.
 * An Escape another handler already spent (`defaultPrevented` - the pairing panel's own, the Complete bubble's) is left alone.
 */
export function useStagePopover(open: boolean, onDismiss: (how: "outside" | "escape") => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onDown = (e: PointerEvent) => {
      if (!floatsNow() || rootRef.current?.contains(e.target as Node)) return;
      dismissRef.current("outside");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !floatsNow()) return;
      dismissRef.current("escape");
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return rootRef;
}
