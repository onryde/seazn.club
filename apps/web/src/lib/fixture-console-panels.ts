// lib/fixture-console-panels.ts — the fixture console's header panel bar (owner request 2026-11-11), as pure data so the
// whole truth table is pinned in node vitest: which buttons the bar offers (same order for EVERY sport), the one panel
// that closes itself when idle, and the unsaved-lineup confirm. The one-open-at-a-time rule is `nextOpenPanel`
// (lib/fixture-stream-mount.ts).
import type { OpenPanel } from "@/lib/fixture-stream-mount";

export type PanelKey = Exclude<OpenPanel, null>;

/** Button order, left to right / top to bottom, the same for every sport. */
export const PANEL_ORDER: readonly PanelKey[] = ["stream", "handover", "lineup", "rules", "actions"];

/** Which panels the bar offers, in `PANEL_ORDER`. Each flag is the page's own gate for that panel; this only orders. */
export function offeredPanels(offer: Record<PanelKey, boolean>): PanelKey[] {
  return PANEL_ORDER.filter((k) => offer[k]);
}

/** Remote scoring closes itself after this long with no interaction inside it (owner 2026-11-11). */
export const REMOTE_SCORING_IDLE_MS = 20_000;

/** The idle auto-close of a panel, in ms; null = never closes by itself. Only Remote scoring does. */
export function autoCloseMsFor(panel: PanelKey): number | null {
  return panel === "handover" ? REMOTE_SCORING_IDLE_MS : null;
}

export interface IdleTimer {
  /** (Re)arm: the callback fires `ms` after the LAST call. */
  restart(): void;
  stop(): void;
}

/** A restartable one-shot. `timers` is injectable so a test can drive it with fake timers. */
export function createIdleTimer(
  ms: number,
  onIdle: () => void,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout },
): IdleTimer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
  return {
    stop,
    restart() {
      stop();
      handle = timers.setTimeout(() => {
        handle = null;
        onIdle();
      }, ms);
    },
  };
}

/** What a click on a panel control (or its close X) does, given an unsaved lineup draft: leaving the Lineup panel with
 *  unsaved edits asks first (an in-page prompt, never `window.confirm`) and changes nothing until it is answered. */
export function requestPanel(
  current: OpenPanel,
  clicked: PanelKey | "close",
  lineupDirty: boolean,
): { next: OpenPanel; confirm: boolean } {
  const target: OpenPanel = clicked === "close" ? null : current === clicked ? null : clicked;
  if (current === "lineup" && lineupDirty && target !== "lineup") return { next: current, confirm: true };
  return { next: target, confirm: false };
}

/** The DOM events inside Remote scoring that count as "the organiser is still here": each restarts the idle timer. Capture
 *  phase, so a child that stops propagation still counts. Spread onto the panel wrapper. */
export function idleActivityHandlers(restart: () => void) {
  return {
    onPointerDownCapture: restart,
    onPointerMoveCapture: restart,
    onKeyDownCapture: restart,
    onFocusCapture: restart,
    onCopyCapture: restart,
    onClickCapture: restart,
  };
}
