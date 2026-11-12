"use client";

import { useState } from "react";
import { useOrigin } from "@/lib/use-client-snapshot";

/**
 * The join link's copy control (RS005 W2b task 2; polish wave P6 made it the FULL link, not the bare code). The ONE genuinely
 * interactive piece of the row-expand detail - everything around it (the `<details>` expand itself, every other detail field) stays
 * plain server-rendered markup with no client JS at all (task 1). Scoped narrowly to just this button so that boundary stays visible:
 * the caller (registration-hub-registrant-detail.tsx, a server component) decides WHETHER this renders at all (canEdit + team entry
 * with a join_code - task acceptance: absent for a viewer, not merely disabled), builds the site-relative `joinPath`
 * (`joinLinkPath`, the one builder every surface shares) and passes every string already translated - this file imports no i18n of
 * its own, so it can never accidentally pull `@/lib/i18n` (server-only) into a client bundle (see AGENTS.md / this wave's context
 * note 5).
 *
 * Why the link and not the code: an organiser asked for a team's join code is asked to hand a teammate something they can open. The
 * code alone needs a second step (find the "Have a join code?" field); the link is the step. The link still contains the code, so it
 * stays readable on screen; the origin is the page's own, taken when the button is pressed (so a copied link is always the one the
 * organiser is looking at, never a build-time guess) and shown once the page has hydrated.
 *
 * Deliberately NOT built on `copy-link.tsx`'s `<CopyLink>`: that component has its own hardcoded English "Copy"/"Copied" strings,
 * and every new string here is properly translated (task 5) rather than repeating that existing debt.
 */
export function RegistrationHubRegistrantJoinCode({
  joinPath,
  label,
  hint,
  copyLabel,
  copiedLabel,
}: {
  /** The join page's site-relative URL for this entry (`joinLinkPath`). */
  joinPath: string;
  label: string;
  hint: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const origin = useOrigin();

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${joinPath}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (permissions, insecure context...) - the link is
         still plainly visible and selectable as text. */
    }
  }

  return (
    <div data-registration-hub-registrant-join-code className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      {/* `ph-no-capture`: a team's join link carries its join code, a capability (anyone holding it can join the entry), so it stays
          out of PostHog replay. `break-all` + `min-w-0`: the link is long and has no spaces, and the organiser console is used on a
          phone too. */}
      <code className="ph-no-capture min-w-0 break-all rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-sm text-slate-800">
        {`${origin}${joinPath}`}
      </code>
      <button type="button" onClick={copy} className="btn btn-ghost text-xs">
        {copied ? copiedLabel : copyLabel}
      </button>
      <p className="w-full text-xs text-slate-500">{hint}</p>
    </div>
  );
}
