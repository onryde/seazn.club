"use client";

import { useState } from "react";

/**
 * The join code's copy control (RS005 W2b task 2). The ONE genuinely
 * interactive piece of the row-expand detail — everything around it
 * (the `<details>` expand itself, every other detail field) stays plain
 * server-rendered markup with no client JS at all (task 1). Scoped
 * narrowly to just this button so that boundary stays visible: the caller
 * (registration-hub-registrant-detail.tsx, a server component) decides
 * WHETHER this renders at all (canEdit + team entry with a join_code —
 * task acceptance: absent for a viewer, not merely disabled) and passes
 * every string already translated — this file imports no i18n of its own,
 * so it can never accidentally pull `@/lib/i18n` (server-only) into a
 * client bundle (see AGENTS.md / this wave's context note 5).
 *
 * Deliberately NOT built on `copy-link.tsx`'s `<CopyLink>`: that component
 * copies an absolute URL (`${origin}${path}`) and has its own hardcoded
 * English "Copy"/"Copied ✓" strings — a join code is a bare code, not a
 * link, and every new string here is properly translated (task 5) rather
 * than repeating that existing debt.
 */
export function RegistrationHubRegistrantJoinCode({
  code,
  label,
  hint,
  copyLabel,
  copiedLabel,
}: {
  code: string;
  label: string;
  hint: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (permissions, insecure context…) — the code is
         still plainly visible and selectable as text. */
    }
  }

  return (
    <div data-registration-hub-registrant-join-code className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <code className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-sm text-slate-800">
        {code}
      </code>
      <button type="button" onClick={copy} className="btn btn-ghost text-xs">
        {copied ? copiedLabel : copyLabel}
      </button>
      <p className="w-full text-xs text-slate-500">{hint}</p>
    </div>
  );
}
