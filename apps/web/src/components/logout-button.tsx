"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOutClient } from "@/lib/sign-out-client";

/** `label` is the localized "Sign out" copy, resolved by the server parent and
 *  passed in (client islands can't import the server-only t()).
 *
 *  The visible words appear from `sm` (the player home's own header); below it the button is the icon alone. `iconOnly` (the
 *  console gantry, owner ruling 2026-11-01: Sign out is its icon at every width, as Settings is) never paints them. Either way
 *  `aria-label` is the button's name and `title` its tooltip, in the same words. */
export function LogoutButton({ label, iconOnly = false }: { label: string; iconOnly?: boolean }) {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        // The session ends and the analytics identity dies BEFORE the (soft) navigation (task-8 review, Critical) -
        // both in the shared sign-out (lib/sign-out-client.ts), which the match room's Switch account uses too.
        await signOutClient();
        // Land on the marketing home, not the login form — signing out is
        // "leave the console", not "start a new session".
        router.push("/");
        router.refresh();
      }}
      // Lives only on night chrome (gantry + my-matches header) — cream it is.
      // shrink-0: the gantry's right-hand group can now shrink the display
      // name (min-w-0 truncate, #349) to fit narrow tablet widths — this
      // button must never be a second target, or "Sign out" wraps to two
      // lines the same way the name used to overflow.
      className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/10 hover:text-cream"
      title={label}
      // The accessible name when the label is not painted (below `sm`, or always when `iconOnly`): the same translated words, so
      // it also satisfies "label in name" where the words ARE painted.
      aria-label={label}
    >
      <LogOut className="h-4 w-4" strokeWidth={1.75} />
      {!iconOnly && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}
