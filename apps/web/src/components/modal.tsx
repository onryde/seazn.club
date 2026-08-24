"use client";

import { useEffect, useRef, useState } from "react";

/** Elements this trap treats as tab stops. Includes `select`/`textarea` —
 *  the registration hub config panel (RS004, the surface that motivated
 *  this fix) has both, and a selector that omits them would mis-detect the
 *  dialog's true first/last tab stop, letting Tab escape at that boundary.
 *  `:not(:disabled)` for the same reason: a disabled control matches the
 *  selector but can never actually hold keyboard focus, so treating it as a
 *  boundary computes a wrap target native Tab never lands on. `iframe`:
 *  billing-actions.tsx/buy-credits.tsx/pass-upgrade.tsx render a Modal
 *  whose only content is a Stripe EmbeddedCheckout iframe with no footer —
 *  without this, the only detected tab stop is the header close button and
 *  forward-Tab would re-trap on itself, blocking keyboard entry into the
 *  payment form entirely. */
export const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], iframe, [tabindex]:not([tabindex="-1"])';

/** Given the dialog's focusable elements (in tab order) and which one is
 *  currently active, decide whether a Tab/Shift+Tab press at a boundary
 *  should wrap to the opposite end. Returns the element to move focus to,
 *  or null when this press is not at a boundary the trap needs to
 *  intervene on — native Tab order handles every other case unassisted.
 *
 *  Deliberately pure (no DOM reads or writes) so it is unit-testable
 *  without jsdom, which this workspace does not have — see modal.test.ts. */
export function nextTrapFocus<T>(focusable: readonly T[], active: T | null, shiftKey: boolean): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (shiftKey) return active === first ? last : null;
  return active === last ? first : null;
}

/** Lightweight centered modal with an overlay. */
export function Modal({
  title,
  children,
  onClose,
  footer,
  size = "md",
}: {
  title: string;
  children?: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  size?: "md" | "lg";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read the LATEST onClose via a ref so the mount effect below can stay
  // deps:[] — a caller passing a fresh inline `onClose` every render must
  // not re-run this effect, or it would restore-then-refocus mid-edit,
  // yanking focus out of whatever field the organiser is actively typing
  // into (RS004 review finding 4).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Captured during RENDER (useState's lazy initialiser runs before commit),
  // not inside an effect: ConfirmModal's typeToConfirm input carries
  // `autoFocus`, which React applies during commit — before any passive
  // effect below runs. Capturing "what was focused before this opened"
  // inside an effect would sometimes read the autoFocus target back instead
  // of the real trigger.
  const [restoreTarget] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    const focusables = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    // Move focus into the dialog on open — unless something inside it has
    // already claimed focus itself (ConfirmModal's autoFocus input); don't
    // steal that.
    if (!dialog?.contains(document.activeElement)) {
      focusables()[0]?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        const target = nextTrapFocus(focusables(), document.activeElement, e.shiftKey);
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to the trigger on close.
      (restoreTarget as HTMLElement | null)?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxW = size === "lg" ? "sm:max-w-2xl" : "sm:max-w-md";

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* Bottom sheet under `sm`, centered modal above (v3/02 pattern 3). */}
      <div
        ref={dialogRef}
        // 85dvh, not 85vh: `vh` is the LARGE viewport and ignores retractable
        // mobile browser chrome, so the panel was measured against a box taller
        // than the visible one and the footer sat under the chrome at 320×568.
        className={`flex max-h-[85dvh] w-full ${maxW} flex-col rounded-t-2xl border border-purple-100 bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:pb-6`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="sheet-handle" aria-hidden />
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <h3 className="text-lg font-semibold text-purple-900">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-full text-slate-400 hover:bg-purple-50 hover:text-purple-700"
          >
            ×
          </button>
        </div>
        {children && (
          <div className="min-h-0 flex-1 overflow-y-auto text-sm text-slate-600">
            {children}
          </div>
        )}
        {footer && (
          <div className="mt-5 flex shrink-0 justify-end gap-2">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** Confirm dialog built on Modal. Pass `typeToConfirm` to require the user to type a word. */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  typeToConfirm,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const canConfirm = !typeToConfirm || typed.trim().toUpperCase() === typeToConfirm.toUpperCase();

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`btn ${danger ? "btn-danger" : "btn-primary"} disabled:opacity-40`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
      {typeToConfirm && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs text-slate-500">
            Type <span className="font-mono font-semibold text-red-600">{typeToConfirm}</span> to confirm
          </p>
          <input
            autoFocus
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="input w-full"
            placeholder={typeToConfirm}
          />
        </div>
      )}
    </Modal>
  );
}
