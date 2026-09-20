"use client";

// Modal confirmation (v3/03 §3 — replaces window.confirm for destructive
// actions). `typedName` escalates to type-to-confirm: the button stays
// disabled until the user types the resource name exactly (v3/09 §4 division
// delete). Body copy must state what is destroyed vs kept.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isConfirmArmed } from "@/lib/typed-confirm";

interface Props {
  open: boolean;
  title: string;
  children: ReactNode; // body copy: exactly what happens, destroyed vs kept
  /** OMIT to render no confirm button at all — a dialog that only reports
   *  (#230: a board with blocking conflicts has nothing to confirm, and there is
   *  no override for it). The difference has to be structural rather than a
   *  disabled button: a disabled "Publish anyway" says "not yet", and this one
   *  means "never on this board". */
  confirmLabel?: string;
  /** Require typing this exact string to enable the confirm button. */
  typedName?: string;
  /** RS011 review round 3, finding 5: an ADDITIONAL confirm-armed override
   *  for a caller whose own domain rule decides when the confirm button may
   *  fire — a rule `typedName`'s exact-string-match (`isConfirmArmed`) can't
   *  express (e.g. `EligibilityOverrideDialog`'s reason-LENGTH gate). `true`
   *  disables confirm regardless of `typedName`/`typed`; omitted (the
   *  default) changes nothing — every existing caller keeps its
   *  `typedName`-only armed check byte-for-byte unchanged. */
  confirmDisabled?: boolean;
  /** The confirm button's intent. Defaults to `danger`: every caller that
   *  existed before the Start-tournament confirmation (design 2026-09-20)
   *  confirms a deletion or a refusal override, and none of them move. Start
   *  is irreversible but not destructive — it is the action the organiser came
   *  to take — so it renders as the primary affordance the design calls for. */
  confirmVariant?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Localized dismiss label. Defaults to the English "Cancel" every existing
   *  caller renders today; pass one when the dialog is reachable from a
   *  translated surface. */
  cancelLabel?: string;
  /** Root hook. The two buttons derive `${testId}-confirm` / `${testId}-cancel`,
   *  so a spec never has to select on copy. */
  testId?: string;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  typedName,
  confirmDisabled = false,
  confirmVariant = "danger",
  busy = false,
  onConfirm,
  onCancel,
  cancelLabel = "Cancel",
  testId,
}: Props) {
  const [typed, setTyped] = useState("");
  const [lastOpen, setLastOpen] = useState(open);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** The control that had focus when this opened, so focus can go home. */
  const triggerRef = useRef<HTMLElement | null>(null);

  // Reset the typed challenge on every open (adjust-state-during-render — no
  // effect, no cascading re-render).
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setTyped("");
  }

  // Escape, and the Tab trap. Keyed on `onCancel` as well as `open` because a
  // caller that passes an inline arrow mints a new one every render and the
  // handler must not close over a stale one.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  // Initial focus, and where focus goes when this closes. Keyed on `open`
  // ALONE: folding it into the effect above would re-run it on every render a
  // caller's inline `onCancel` causes, yanking focus back to the trigger and
  // then into the panel again mid-interaction.
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    // The typed challenge when there is one, otherwise the panel itself —
    // never the confirm button, which would arm an irreversible action on a
    // stray Enter.
    if (inputRef.current) inputRef.current.focus();
    else panelRef.current?.focus();
    return () => {
      const back = triggerRef.current;
      if (back?.isConnected) back.focus();
    };
  }, [open]);

  if (!open) return null;
  const armed = isConfirmArmed(typedName, typed);

  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {/* Bottom sheet under `sm` (v3/02 pattern 3). `tabIndex={-1}` makes the
          panel programmatically focusable so opening moves focus INTO the
          dialog without arming a button; it stays out of the tab order. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="card w-full space-y-4 rounded-t-2xl rounded-b-none p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-xl outline-none sm:max-w-md sm:rounded-2xl sm:pb-6"
      >
        <span className="sheet-handle" aria-hidden />
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <div className="space-y-2 text-sm text-slate-600">{children}</div>
        {typedName !== undefined && (
          <label className="block">
            <span className="label">
              Type <span className="font-mono font-semibold">{typedName}</span> to confirm
            </span>
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="input w-full"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        {/* `min-h-11` = 44px, the phone touch-target floor this repo asserts on
            every other action bar. `.btn` alone renders 38px, and this dialog is
            a bottom SHEET under `sm` — the one place a control is thumbed. */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid={testId ? `${testId}-cancel` : undefined}
            className="btn btn-ghost min-h-11"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          {confirmLabel !== undefined && (
            <button
              type="button"
              data-testid={testId ? `${testId}-confirm` : undefined}
              className={`btn min-h-11 ${confirmVariant === "primary" ? "btn-primary" : "btn-danger"}`}
              onClick={onConfirm}
              disabled={busy || !armed || confirmDisabled}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
