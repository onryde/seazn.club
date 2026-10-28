"use client";
// A YouTube refusal REPLACES Go live (YouTube Connect T12). The organiser's focus was on Go live (they just pressed it), so when the
// refusal block takes its place the focused element is removed and focus falls back to the page: a keyboard or screen-reader user is
// dropped at the top of the document. This wrapper puts focus on the block's first action (Reconnect, Try again or Use another
// destination) when the block appears.
//
// A callback ref, not an effect: it runs once when the box attaches, and the callback is module-level so its identity never changes —
// a re-render of the panel (every poll) does not re-run it and steal focus back. The panel keys the wrapper by the refusal's code, so a
// second refusal (a different code, or the same one after Try again unmounted the block) attaches a new box and focuses again.
//
// `display: contents`: the wrapper adds no box, so the block's spacing in the Ready column is exactly what it was.
import type { ReactNode } from "react";

/** The first enabled link or button in the box — the block's title and reason are paragraphs, so this is its first action. */
export const FIRST_ACTION = "a[href], button:not([disabled])";

export function focusFirstAction(box: HTMLElement | null): void {
  box?.querySelector<HTMLElement>(FIRST_ACTION)?.focus();
}

export function FocusFirstAction({ children }: { children: ReactNode }) {
  return (
    <div ref={focusFirstAction} className="contents">
      {children}
    </div>
  );
}
