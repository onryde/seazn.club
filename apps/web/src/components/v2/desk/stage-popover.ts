// The stage card's floating menus (owner pick, Option A, 2026-11-03): More and the Pair next ▾ panel used to open IN FLOW inside the
// header's actions group, so opening either grew the card by up to 225px and shoved the settings buttons down a line. From `md` they
// are now popovers hung from their trigger, over the content, so the card does not move; below `md` they stay in flow inside the
// Stage tools sheet exactly as before (a bottom sheet would clip an absolutely-placed panel - `reason-tip.tsx` makes the same split).
//
// The house pattern is `desk-open-menu.tsx` (the competition "Open" menu): a `relative` root holding the trigger and the panel, dismissed
// by an outside press, by Escape (which hands focus back to the trigger), by choosing an item, or by focus moving on out of it (Tab).
// Differences, forced by the card:
//   - the trigger's place depends on how the header wraps, so no fixed side is safe. The panel hangs from the trigger's LEFT edge unless
//     that would run past the CARD (or the viewport, on a card nearly as wide as it), then from its RIGHT edge (`popoverAlign`, measured
//     when the trigger is pressed). A panel that overhangs the card's border reads as spilling out of it (fix round 1, review m2);
//   - everything is gated on the viewport being `md` or wider AT THE MOMENT OF THE EVENT. A phone's sheet has its own Escape and its own
//     backdrop, and the in-flow menus there never closed on a press elsewhere - that is today's behaviour and it is not changed.
import { useEffect, useRef } from "react";

/** The panel's width from `md` up - `md:w-96` in `popoverClasses`, 24rem = 384px - and the breathing room it keeps from the viewport's edge.
 *  The class is a literal on purpose (Tailwind finds classes by scanning for whole tokens, so one built from this number would never be
 *  generated); stage-popover.test.ts pins the two together instead. */
export const POPOVER_WIDTH_PX = 384;
export const POPOVER_EDGE_PX = 16;
/** The stage card, the box a panel is aligned to (`stages-panel.tsx`'s `section[data-stage-id]`). */
const CARD_SELECTOR = "section[data-stage-id]";

/** Tailwind's `md` breakpoint. */
const FLOATS_FROM = "(min-width: 768px)";

export type PopoverAlign = "start" | "end";

/** The horizontal run the panel must stay inside. */
export interface PopoverBounds {
  left: number;
  right: number;
}

/**
 * Which edge of the trigger the panel hangs from. `start` (the panel's left edge on the trigger's left edge) when the panel fits to the
 * right of it inside `bounds`; `end` (right edges together) when it does not but fits to the left; `start` when neither does, so a panel
 * never takes a negative left edge (on a card that narrow the overhang is a few pixels, on the right).
 */
export function popoverAlign(trigger: { left: number; right: number }, bounds: PopoverBounds): PopoverAlign {
  const startFits = trigger.left + POPOVER_WIDTH_PX <= bounds.right;
  const endFits = trigger.right - POPOVER_WIDTH_PX >= bounds.left;
  return startFits || !endFits ? "start" : "end";
}

/** The card's run, narrowed to the viewport less its edge margin; the viewport's alone where the trigger is in no card. */
export function boundsOf(card: { left: number; right: number } | null, viewportWidth: number): PopoverBounds {
  const viewport = { left: POPOVER_EDGE_PX, right: viewportWidth - POPOVER_EDGE_PX };
  if (!card) return viewport;
  return { left: Math.max(card.left, viewport.left), right: Math.min(card.right, viewport.right) };
}

/** Measured from the DOM when the trigger is pressed (never tracked, so it cannot go stale); `start` where there is no DOM to measure. */
export function alignOf(trigger: Element | null): PopoverAlign {
  if (!trigger || typeof window === "undefined") return "start";
  const card = trigger.closest(CARD_SELECTOR)?.getBoundingClientRect() ?? null;
  return popoverAlign(trigger.getBoundingClientRect(), boundsOf(card, window.innerWidth));
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
 * Outside-press, focus-leaves and Escape dismissal for a floating menu. Returns the ref for the ROOT element (the trigger and the panel both inside
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
    // Focus moving on out of the menu (Tab to the next control) puts it away like a press elsewhere does - without it a keyboard user could
    // leave Pair next ▾ open, Tab to More and open that too, and one Escape would close both (review m9).
    const onFocusIn = (e: FocusEvent) => {
      if (!floatsNow() || rootRef.current?.contains(e.target as Node)) return;
      dismissRef.current("outside");
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);
  return rootRef;
}
