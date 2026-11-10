"use client";

// W4 app B, B5b Task 13 (X-CH-4, X-CH-6; owner pick 4A) - the organiser's "Declare joint winners" and its Undo, in the
// match console beside Settle. The OFFER is decided by the caller from the one shared predicate (`lib/joint-winners.ts`,
// which the server's declare also reads); nothing here re-derives it. This file owns the three things a ruling needs:
// the button, the confirm sheet that names BOTH finalists (a ruling over the wrong pair is the mistake to prevent), and the
// declared state with its Undo.
//
// Layout: one DOM at every width. The button is full-width below md and content-width from md (the Settle block's rule);
// names WRAP in the sheet and the banner (`min-w-0 break-words`) - two long names do not fit one truncated line at 320, and
// an ellipsis over a finalist is the wrong answer.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { isKnockoutRefusalCode, knockoutRefusalText } from "@/lib/knockout-refusals";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
interface Finalist {
  name: string;
}

/** The route's own words for a refusal: a knockout code speaks in the locale, anything else is the console's generic line. */
function refusalText(err: unknown, msg: Msg): string {
  if (err instanceof ApiV1Error && isKnockoutRefusalCode(err.code)) return knockoutRefusalText(err.code, err.extra, msg);
  return msg("score.failed");
}

const jointUrl = (fixtureId: string) => `/api/v1/fixtures/${fixtureId}/joint-winners`;

/** The ruling's write and what must follow it. The console's `live` is `useState(initialState)`, which `router.refresh()`
 *  never re-seeds, so BOTH run: `onChanged` is the console's own `resync()` (status, badge, offer) and `refresh` re-renders
 *  the server props (`joint_winners_at`). A failed resync is swallowed: the write already landed, and the refresh still
 *  carries the new state. A refused write throws before either runs. Exported so a node test can drive the sequence. */
export async function commitJointWinners(
  method: "POST" | "DELETE",
  fixtureId: string,
  after: { onChanged: () => Promise<unknown> | void; refresh: () => void },
): Promise<void> {
  await apiV1(jointUrl(fixtureId), { method });
  try {
    await after.onChanged();
  } catch {
    // swallowed on purpose - see above
  }
  after.refresh();
}

const FOCUSABLE = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

/** The confirm sheet. Exported for its node test (effects are inert under `renderToStaticMarkup`). */
export function JointWinnersSheet({
  msg,
  home,
  away,
  sending,
  onConfirm,
  onClose,
}: {
  msg: Msg;
  home: Finalist;
  away: Finalist;
  sending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(sending);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    sendingRef.current = sending;
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    // Focus the SAFE choice (Cancel), not the ruling.
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sendingRef.current) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && !!panelRef.current?.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !sendingRef.current) onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="joint-winners-sheet" className="modal">
        <span className="sheet-handle" aria-hidden />
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {msg("jointWinners.confirmTitle")}
        </h2>
        <p data-testid="joint-winners-confirm-text" className="mt-2 min-w-0 break-words text-sm text-slate-700">
          {msg("jointWinners.confirm", { a: home.name, b: away.name })}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={sending} onClick={onClose} className="btn btn-ghost min-h-11">
            {msg("editor.cancel")}
          </button>
          <button type="button" data-testid="joint-winners-confirm" disabled={sending} onClick={onConfirm} className="btn btn-primary min-h-11">
            {msg("jointWinners.action")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "Declare joint winners" button and its sheet: the button alone, for the ORGANISER block (owner pick 4A) - beside
 *  Settle in the held block's action row, or in the Match actions panel (which folds on phones) when the final is not held. */
export function JointWinnersOffer({
  msg,
  fixtureId,
  home,
  away,
  busy,
  onChanged,
}: {
  msg: Msg;
  fixtureId: string;
  home: Finalist;
  away: Finalist;
  busy: boolean;
  /** The console's `resync()`: re-seeds `live` after the ruling. */
  onChanged: () => Promise<unknown> | void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);

  const declare = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await commitJointWinners("POST", fixtureId, { onChanged, refresh: () => router.refresh() });
      setOpen(false);
    } catch (err) {
      // A refusal closes the sheet and reads beside the button that reopens it (the settle dialog's rule).
      setOpen(false);
      setError(refusalText(err, msg));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const button: ReactNode = (
    <button
      type="button"
      data-testid="joint-winners-open"
      disabled={busy}
      onClick={() => {
        setError(null);
        setOpen(true);
      }}
      className="btn btn-ghost min-h-11 w-full shrink-0 md:w-auto"
    >
      {msg("jointWinners.action")}
    </button>
  );
  const sheet = open ? (
    <JointWinnersSheet msg={msg} home={home} away={away} sending={sending} onConfirm={() => void declare()} onClose={() => setOpen(false)} />
  ) : null;
  const err = error !== null ? (
    <p data-testid="joint-winners-error" role="alert" className="mt-2 min-w-0 break-words text-sm font-medium text-red-700">
      {error}
    </p>
  ) : null;

  return (
    <>
      {button}
      {sheet}
      {err !== null && <div className="w-full md:basis-full">{err}</div>}
    </>
  );
}

/** The declared state: both finalists named under one trophy, and the Undo (organisers only - the route is organiser-only). */
export function JointWinnersDeclared({
  msg,
  fixtureId,
  home,
  away,
  canUndo,
  undoBlockedReason,
  busy,
  onChanged,
}: {
  msg: Msg;
  fixtureId: string;
  home: Finalist;
  away: Finalist;
  canUndo: boolean;
  /** Set when the console already knows the server would refuse the Undo (a finalist has since left): the button is
   *  disabled and this line says why. */
  undoBlockedReason?: string | null;
  busy: boolean;
  onChanged: () => Promise<unknown> | void;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const titleId = useId();
  const undo = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await commitJointWinners("DELETE", fixtureId, { onChanged, refresh: () => router.refresh() });
    } catch (err) {
      setError(refusalText(err, msg));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  return (
    <section
      data-testid="joint-winners-declared"
      aria-labelledby={titleId}
      className="rounded-2xl border border-amber-200 bg-amber-50 p-4 md:flex md:items-center md:justify-between md:gap-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className="text-2xl leading-none">🏆</span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-amber-900">
            {msg("jointWinners.declaredTitle")}
          </h2>
          <p className="mt-1 min-w-0 break-words text-sm text-slate-700">{msg("jointWinners.declaredBody", { a: home.name, b: away.name })}</p>
          {error !== null && (
            <p data-testid="joint-winners-error" role="alert" className="mt-2 min-w-0 break-words text-sm font-medium text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
      {canUndo && (
        <div className="mt-3 flex shrink-0 flex-col gap-2 md:mt-0 md:flex-row">
          <button
            type="button"
            data-testid="joint-winners-undo"
            disabled={busy || sending || !!undoBlockedReason}
            onClick={() => void undo()}
            className="btn btn-ghost min-h-11 w-full shrink-0 md:w-auto"
          >
            {msg("jointWinners.undo")}
          </button>
          {undoBlockedReason ? (
            <p data-testid="joint-winners-undo-blocked" className="min-w-0 break-words text-xs text-slate-600">
              {undoBlockedReason}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
