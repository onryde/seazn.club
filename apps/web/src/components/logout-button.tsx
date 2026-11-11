"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOutClient } from "@/lib/sign-out-client";

/** The sign-out ACTION, shared by this button and the gantry's account menu (one door, two places to reach it): the session ends
 *  and the analytics identity dies BEFORE the (soft) navigation (task-8 review, Critical) - both in the shared sign-out
 *  (lib/sign-out-client.ts), which the match room's Switch account uses too. A rejection (the session could not be ended)
 *  propagates and nothing navigates. */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  return async () => {
    await signOutClient();
    // Land on the marketing home, not the login form — signing out is
    // "leave the console", not "start a new session".
    router.push("/");
    router.refresh();
  };
}

/** `label` is the localized "Sign out" copy, resolved by the server parent and
 *  passed in (client islands can't import the server-only t()).
 *
 *  The visible words appear from `sm` (the player home's own header); below it the button is the icon alone. `iconOnly` never
 *  paints them. Either way `aria-label` is the button's name and `title` its tooltip, in the same words. (The console gantry
 *  no longer mounts this button: Sign out lives in its account menu, which calls `useSignOut` above.) */
export function LogoutButton({ label, iconOnly = false }: { label: string; iconOnly?: boolean }) {
  const signOut = useSignOut();
  return (
    <button
      onClick={signOut}
      // Lives only on night chrome (the player home's header) — cream it is.
      // shrink-0: never a flex shrink target, or "Sign out" wraps to two lines.
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
