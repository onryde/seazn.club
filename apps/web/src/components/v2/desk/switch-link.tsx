"use client";

// Match Day E1 fix round 1 (m5): a link that wears role="switch" (the ledger's "Show finished" - the state is the URL, so it is a link).
// A switch toggles on Space AND Enter (ARIA authoring practices); a link follows Enter only, so Space is added here: it does what a
// click does, through the link's own click (so Next's client navigation runs exactly as it does for Enter), and is kept from scrolling the page.
import type { ComponentProps } from "react";
import Link from "@/components/ui/console-link";

/** The slice of a keyboard event the handler reads - so a node-only test can drive it with a plain object. */
export interface SwitchKeyEvent {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  currentTarget: { click(): void };
}

export function switchLinkKeyDown(e: SwitchKeyEvent): void {
  if (e.defaultPrevented) return;
  if (e.key !== " " && e.key !== "Spacebar") return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  // Space on a link scrolls the page: always spent. Only the first press toggles; a held key repeats and must not navigate again.
  e.preventDefault();
  if (!e.repeat) e.currentTarget.click();
}

export function SwitchLink({ onKeyDown, ...rest }: ComponentProps<typeof Link>) {
  return (
    <Link
      {...rest}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        switchLinkKeyDown(e);
      }}
    />
  );
}
