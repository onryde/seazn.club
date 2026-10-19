"use client";
// "Switch account" on the match room's wrong-account card (owner staging test 2026-10-19): end the session, then send the
// player to sign in again with the room as the place to land. A FULL navigation, not a soft one: the session is gone, the
// room's document carries its own camera policy, and a stale router cache must not replay the signed-in tree.
//
// Signing out comes first and must SUCCEED: navigating to /login while the session still stands would bounce a signed-in
// user straight back to `next` (login/page.tsx redirects the signed in), i.e. to this same card. A failure re-enables the
// button and says so; nothing navigates.
import { useState } from "react";
import { signOutClient } from "@/lib/sign-out-client";

// The hand on a button (Tailwind v4's preflight gives <button> the arrow), and the not-allowed on a disabled one - written
// HERE rather than trusted to the `className` the card hands in, so the button is right whoever uses it (buttons-cursor.test).
const HAND = "cursor-pointer disabled:cursor-not-allowed";

/** Where the sign-in lands after: the login page, with the room (its path and query - the personal link) as `next`. */
export function switchAccountHref(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export function SwitchAccountButton({
  next,
  label,
  failedLabel,
  className,
  go = (href: string) => window.location.assign(href),
}: {
  /** The room's own path and query, as the page was loaded. */
  next: string;
  label: string;
  /** Said when the session could not be ended. */
  failedLabel: string;
  className: string;
  /** The navigation (a test seam; the page assigns the location). */
  go?: (href: string) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "working" | "failed">("idle");
  const press = async () => {
    setPhase("working");
    try {
      await signOutClient();
    } catch {
      setPhase("failed");
      return;
    }
    go(switchAccountHref(next));
  };
  return (
    <>
      <button type="button" data-testid="room-switch-account" className={`${HAND} ${className}`} disabled={phase === "working"} onClick={() => void press()}>
        {label}
      </button>
      {phase === "failed" ? (
        <p role="alert" data-testid="room-switch-account-failed" className="m-0 pt-2 text-xs leading-[1.4] text-[#b45309]">
          {failedLabel}
        </p>
      ) : null}
    </>
  );
}
