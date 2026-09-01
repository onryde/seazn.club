"use client";

// Organiser-side eligibility override (RS011). Composes `ConfirmDialog`
// (components/v2/confirm-dialog.tsx) for its shell — overlay, bottom
// sheet/card layout, Escape-to-cancel, testid convention, button markup —
// this IS a confirm dialog, just one that also collects the audited reason
// `usecases/registration-eligibility.ts`'s `gateRosterEligibility` writes to
// `competition_events` on override. Opened by `entrants-panel.tsx` whenever
// a roster write 422s `ELIGIBILITY_VIOLATION` (never for a warning-only
// response — those render as amber chips instead, same file).
//
// RS011 review round 3, finding 5: this file used to hand-copy
// ConfirmDialog's entire shell verbatim (~146 lines), its own header comment
// admitting as much. The one piece ConfirmDialog's own armed-check
// (`typedName`/`isConfirmArmed`, an exact-string type-to-confirm rule)
// cannot express is THIS dialog's reason-LENGTH gate, so ConfirmDialog
// gained one new optional prop for it (`confirmDisabled` — see its own doc
// comment) rather than re-implementing the button/disabled logic here too.
// Only the eligibility-specific content — the intro line, the violation
// list, the reason textarea — is composed in as `children`.
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { REASON_MIN, REASON_MAX, type EligibilityIssue } from "@/lib/registration-rules";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

/** One violation row's label — the same "Player N (name):" shape
 *  `formatEligibilityIssues` (server-side) renders as a sentence, kept
 *  separate here so the dialog can style the name and the reason
 *  differently instead of re-parsing a joined string.
 *
 *  RS011 review round 3, finding 3: the no-`playerName` fallback used to be
 *  a raw English template literal (`` `Player ${issue.playerIndex}` ``),
 *  rendered directly, while every other string in this file already routes
 *  through `msg()` — AGENTS.md: "Any new or changed user-facing string →
 *  all 4 locale dictionaries, never hardcoded English." Takes `msg` as a
 *  param (rather than calling `useMsg()` itself) so it stays a plain
 *  function, callable from the render body below without becoming a hook —
 *  same shape `entrants-panel.tsx`'s `eligibilityBadges` uses for the same
 *  reason. */
function offenderLabel(
  issue: EligibilityIssue,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string | null {
  if (issue.playerIndex == null) return null;
  return issue.playerName
    ? issue.playerName
    : msg("divset.entrants.eligibilityGate.playerFallback", { n: issue.playerIndex });
}

interface Props {
  open: boolean;
  violations: EligibilityIssue[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  testId?: string;
}

export function EligibilityOverrideDialog({
  open,
  violations,
  busy = false,
  onCancel,
  onConfirm,
  testId = "eligibility-override",
}: Props) {
  const msg = useMsg();
  const [reason, setReason] = useState("");
  const [lastOpen, setLastOpen] = useState(open);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset the reason on every open (adjust-state-during-render, matches
  // ConfirmDialog's own `typed` reset — no effect, no cascading re-render).
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setReason("");
  }

  // ConfirmDialog's own focus-on-open effect targets ITS typed-name input,
  // which never renders here (`typedName` is never passed) — this dialog's
  // one field is the reason textarea, composed in as `children`, so it needs
  // its own focus effect. Escape-to-cancel is NOT duplicated here:
  // ConfirmDialog's own effect already wires Escape to the `onCancel` passed
  // through below.
  useEffect(() => {
    if (!open) return;
    textareaRef.current?.focus();
  }, [open]);

  const trimmed = reason.trim();
  const armed = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;

  return (
    <ConfirmDialog
      open={open}
      title={msg("divset.entrants.eligibilityGate.title")}
      confirmLabel={msg("divset.entrants.eligibilityGate.confirm")}
      cancelLabel={msg("divset.entrants.eligibilityGate.cancel")}
      busy={busy}
      confirmDisabled={!armed}
      onConfirm={() => onConfirm(trimmed)}
      onCancel={onCancel}
      testId={testId}
    >
      <p>{msg("divset.entrants.eligibilityGate.intro")}</p>

      <ul className="space-y-1.5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
        {violations.map((issue, i) => {
          const who = offenderLabel(issue, msg);
          return (
            <li key={i} className="flex gap-1.5">
              <span aria-hidden className="text-rose-400">
                •
              </span>
              <span>
                {who && <span className="font-medium">{who}: </span>}
                {issue.message}
              </span>
            </li>
          );
        })}
      </ul>

      <label className="block">
        <span className="label">{msg("divset.entrants.eligibilityGate.reasonLabel")}</span>
        <textarea
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input min-h-24 w-full"
          placeholder={msg("divset.entrants.eligibilityGate.reasonPlaceholder")}
          maxLength={REASON_MAX}
          data-testid={`${testId}-reason`}
        />
        <span className="mt-1 block text-xs text-slate-400">
          {msg("divset.entrants.eligibilityGate.reasonHint")}
        </span>
      </label>
    </ConfirmDialog>
  );
}
