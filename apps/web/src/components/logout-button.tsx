"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { signOutClient } from "@/lib/sign-out-client";

/** Where the visible "Sign out" words appear; below it the button is the icon alone and `aria-label` (plus `title`) is its name.
 *  Written out in full: Tailwind only emits classes it can read as whole strings. The gantry asks for `lg` (its width budget, see
 *  nav.tsx); the player home's own header keeps the default `sm`. */
const LABEL_FROM = { sm: "hidden sm:inline", lg: "hidden lg:inline" } as const;

/** `label` is the localized "Sign out" copy, resolved by the server parent and
 *  passed in (client islands can't import the server-only t()). */
export function LogoutButton({ label, labelFrom = "sm" }: { label: string; labelFrom?: keyof typeof LABEL_FROM }) {
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
      className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/10 hover:text-cream"
      title={label}
      // The accessible name when the label is not painted (below `labelFrom`): the same translated words, so it also satisfies
      // "label in name" where the words ARE painted.
      aria-label={label}
    >
      <LogOut className="h-4 w-4" strokeWidth={1.75} />
      <span className={LABEL_FROM[labelFrom]}>{label}</span>
    </button>
  );
}
