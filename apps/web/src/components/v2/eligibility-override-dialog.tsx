"use client";

// Organiser-side eligibility override (RS011). Mirrors `ConfirmDialog`'s
// shell exactly (bottom sheet under `sm`, centered card above it, Escape to
// cancel, `${testId}-*` selectors) — this IS a confirm dialog, just one that
// also collects the audited reason `usecases/registration-eligibility.ts`'s
// `gateRosterEligibility` writes to `competition_events` on override. Opened
// by `entrants-panel.tsx` whenever a roster write 422s `ELIGIBILITY_VIOLATION`
// (never for a warning-only response — those render as amber chips instead,
// same file).
import { useEffect, useRef, useState } from "react";
import type { EligibilityIssue } from "@/lib/registration-rules";
import { useMsg } from "@/components/i18n/dict-provider";

const REASON_MIN = 3;
const REASON_MAX = 500;

/** One violation row's label — the same "Player N (name):" shape
 *  `formatEligibilityIssues` (server-side) renders as a sentence, kept
 *  separate here so the dialog can style the name and the reason
 *  differently instead of re-parsing a joined string. */
function offenderLabel(issue: EligibilityIssue): string | null {
  if (issue.playerIndex == null) return null;
  return issue.playerName ? issue.playerName : `Player ${issue.playerIndex}`;
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
  // ConfirmDialog's `typed` reset — no effect, no cascading re-render).
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setReason("");
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    textareaRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  const trimmed = reason.trim();
  const armed = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;

  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={msg("divset.entrants.eligibilityGate.title")}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="card w-full space-y-4 rounded-t-2xl rounded-b-none p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-xl sm:max-w-md sm:rounded-2xl sm:pb-6">
        <span className="sheet-handle" aria-hidden />
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-900">
            {msg("divset.entrants.eligibilityGate.title")}
          </h2>
          <p className="text-sm text-slate-600">{msg("divset.entrants.eligibilityGate.intro")}</p>
        </div>

        <ul className="space-y-1.5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {violations.map((issue, i) => {
            const who = offenderLabel(issue);
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

        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid={`${testId}-cancel`}
            className="btn btn-ghost min-h-11"
            onClick={onCancel}
            disabled={busy}
          >
            {msg("divset.entrants.eligibilityGate.cancel")}
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm`}
            className="btn btn-danger min-h-11"
            onClick={() => onConfirm(trimmed)}
            disabled={busy || !armed}
          >
            {msg("divset.entrants.eligibilityGate.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
