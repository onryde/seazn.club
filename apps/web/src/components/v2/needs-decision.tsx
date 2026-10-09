"use client";

// W2a Task 11 (spec §5.5, UI-1 option A; owner ruling 82c). A bracket match that ended level — or was abandoned with
// nobody decided, or is a drawn chess knockout waiting on its tie-break — is HELD: nobody is seated until the
// organiser settles it. This is the console's block that says so, and the dialog that sends the settle.
//
// ONE authority for "does this fixture need a decision": the kernel's own `settleApplies` (core/events.ts), fed the
// same facts the kernel's settle precondition reads — the effective outcome, whether an abandon is ACTIVE in the
// ledger, and the module's pending-decider hook — gated on the stage being a bracket kind (controller ruling C12).
// The server holds the same rule twice over (append-event's status, scoring's refusal), so the block can never offer
// a settle the server would refuse for a reason the block could have known.
import { useEffect, useId, useRef, useState } from "react";
import { SETTLE_METHODS, forbidsLevelResult, settleApplies, type MatchOutcome, type SettleMethod } from "@seazn/engine/core";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
type LedgerRow = { id: string; type: string; voids_event_id: string | null };

/** An abandon no row voids — the kernel's own reading (voids are not themselves voidable, core/events.ts
 *  `resolveVoids`, so "a void names it" is the whole test). The generator's void writes NO event, so it never counts. */
export function hasActiveAbandon(events: readonly LedgerRow[]): boolean {
  return events.some((e) => e.type === "core.abandon" && !events.some((v) => v.voids_event_id === e.id));
}

/** Controller ruling C12: bracket kind AND the kernel's own settle precondition, fed the same facts. */
export function needsDecision(
  module: { awaitingDecider?(state: never): boolean },
  f: { outcome: unknown; state: unknown; stageKind: string | null; events: readonly LedgerRow[] },
): boolean {
  if (!forbidsLevelResult(f.stageKind)) return false;
  return settleApplies(module, { outcome: f.outcome as MatchOutcome | null, abandoned: hasActiveAbandon(f.events), state: f.state });
}

/** The confirm stays disabled until both questions are answered, and from the first tap until the answer comes back
 *  (Review Focus 2: a double submit must send one settle). */
export const confirmBlocked = (s: { winner: string | null; method: string | null; sending: boolean }): boolean =>
  s.winner === null || s.method === null || s.sending;

/** Finding 27: Finalize on a held fixture is refused (LEVEL_RESULT_IN_BRACKET), so it is never offered there. */
export const finalizeVisible = (s: { decided: boolean; held: boolean }): boolean => s.decided && !s.held;

const METHOD_KEY: Record<SettleMethod, MessageKey> = {
  lot: "score.needsDecision.method.lot",
  higher_seed: "score.needsDecision.method.higherSeed",
  organiser: "score.needsDecision.method.organiser",
};

export type SettleResult = { ok: true } | { ok: false; message: string };

interface BlockProps {
  msg: Msg;
  home: { id: string; name: string };
  away: { id: string; name: string };
  busy: boolean;
  /** Sends `core.settle` and reports the server's answer — the localized refusal on a 4xx. */
  settle: (payload: { winner: string; method: SettleMethod; note?: string }) => Promise<SettleResult>;
}

export function NeedsDecisionBlock(props: BlockProps) {
  const { msg } = props;
  const [open, setOpen] = useState(false);
  // Spec §7: a refused settle CLOSES the dialog and the reason shows here, beside the button that reopens it.
  const [refusal, setRefusal] = useState<string | null>(null);
  const titleId = useId();
  return (
    <section
      data-testid="needs-decision"
      aria-labelledby={titleId}
      className="rounded-2xl border border-orange-200 bg-orange-50 p-4 md:flex md:items-center md:justify-between md:gap-4"
    >
      <div className="min-w-0">
        <h2 id={titleId} className="text-sm font-semibold text-orange-900">
          {msg("score.needsDecision.title")}
        </h2>
        <p className="mt-1 text-sm text-slate-700">{msg("score.needsDecision.body")}</p>
        {refusal !== null && (
          <p data-testid="settle-error" role="alert" className="mt-2 text-sm font-medium text-red-700">
            {refusal}
          </p>
        )}
      </div>
      <button
        type="button"
        data-testid="settle-open"
        disabled={props.busy}
        onClick={() => {
          setRefusal(null);
          setOpen(true);
        }}
        className="btn btn-primary mt-3 min-h-11 w-full shrink-0 md:mt-0 md:w-auto"
      >
        {msg("score.needsDecision.settle")}
      </button>
      {open && (
        <SettleDialog
          {...props}
          onClose={() => setOpen(false)}
          onRefused={(message) => {
            setRefusal(message);
            setOpen(false);
          }}
        />
      )}
    </section>
  );
}

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

function SettleDialog(props: BlockProps & { onClose: () => void; onRefused: (message: string) => void }) {
  const { msg } = props;
  const [winner, setWinner] = useState<string | null>(null);
  const [method, setMethod] = useState<SettleMethod | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  // The synchronous guard: a double click lands its second event before React re-renders `sending`.
  const sendingRef = useRef(false);
  const onCloseRef = useRef(props.onClose);
  useEffect(() => {
    onCloseRef.current = props.onClose;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus ONCE on mount (preflight C23: re-focusing on every render stole the caret from the note field), and give it
  // back to whatever opened the dialog when it closes. Escape and Tab are bound once and read live values via refs.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sendingRef.current) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
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
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const confirm = async () => {
    if (confirmBlocked({ winner, method, sending: sendingRef.current })) return;
    sendingRef.current = true;
    setSending(true);
    const trimmed = note.trim();
    const r = await props.settle({ winner: winner!, method: method!, ...(trimmed ? { note: trimmed } : {}) });
    sendingRef.current = false;
    setSending(false);
    if (r.ok) props.onClose();
    else props.onRefused(r.message);
  };

  return (
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !sendingRef.current) props.onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="modal">
        <span className="sheet-handle" aria-hidden />
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {msg("score.needsDecision.dialogTitle")}
        </h2>
        <fieldset className="mt-4 min-w-0">
          <legend className="text-sm font-medium text-slate-700">{msg("score.needsDecision.whoAdvances")}</legend>
          <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            {[props.home, props.away].map((e) => (
              <button
                key={e.id}
                type="button"
                data-testid={`settle-winner-${e.id}`}
                aria-pressed={winner === e.id}
                // The name truncates on a narrow screen; the whole of it stays one hover (and the accessible name) away.
                title={e.name}
                onClick={() => setWinner(e.id)}
                className={`flex min-h-12 min-w-0 items-center rounded-xl border px-3 text-left text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${
                  winner === e.id
                    ? "border-purple-600 bg-purple-600 text-white"
                    : "border-slate-200 bg-white text-slate-800 hover:border-purple-300 hover:bg-purple-50"
                }`}
              >
                <span className="min-w-0 truncate">{e.name}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4 min-w-0">
          <legend className="text-sm font-medium text-slate-700">{msg("score.needsDecision.why")}</legend>
          <div className="mt-1 grid gap-1">
            {SETTLE_METHODS.map((m) => (
              <label key={m} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-slate-50">
                <input
                  type="radio"
                  name="settle-method"
                  data-testid={`settle-method-${m}`}
                  checked={method === m}
                  onChange={() => setMethod(m)}
                  className="h-4 w-4 shrink-0 accent-purple-600"
                />
                <span className="text-sm text-slate-800">{msg(METHOD_KEY[m])}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 block">
          <span className="text-sm font-medium text-slate-700">{msg("score.needsDecision.note")}</span>
          <input
            data-testid="settle-note"
            type="text"
            autoComplete="off"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="input mt-1 w-full"
          />
        </label>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={sending} onClick={props.onClose} className="btn btn-ghost min-h-11">
            {msg("editor.cancel")}
          </button>
          <button
            type="button"
            data-testid="settle-confirm"
            disabled={confirmBlocked({ winner, method, sending })}
            onClick={() => void confirm()}
            className="btn btn-primary min-h-11"
          >
            {msg("score.needsDecision.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
