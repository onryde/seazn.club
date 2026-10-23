"use client";

// W2a Task 11 (spec §5.5, UI-1 option A; owner ruling 82c). A bracket match that ended level — or was abandoned with
// nobody decided, or is a drawn chess knockout waiting on its tie-break — is HELD: nobody is seated until the
// organiser settles it. This is the console's block that says so, and the dialog that sends the settle.
//
// ONE authority for "does this fixture need a decision": the engine's `settleOffered` (core/events.ts), fed the
// same facts the kernel's settle precondition reads — the effective outcome, whether an abandon is ACTIVE in the
// ledger (and whether it is a withdrawal's expunge), and the module's pending-decider hook. A bracket kind is the
// kernel's own `settleApplies` (controller ruling C12); a TABLE stage (W2c P-7 / X-AB-5) is held only by an abandon that
// decided nobody. The server's settle guard (append-event.ts) calls the SAME function, so the block can never offer a
// settle the server would refuse for a reason the block could have known - nor withhold one it would take.
import { useEffect, useId, useRef, useState } from "react";
import { SETTLE_METHODS, forbidsLevelResult, settleOffered, type MatchOutcome, type SettleMethod } from "@seazn/engine/core";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
type LedgerRow = { id: string; type: string; voids_event_id: string | null; payload?: unknown };

/** An abandon no row voids — the kernel's own reading (voids are not themselves voidable, core/events.ts
 *  `resolveVoids`, so "a void names it" is the whole test). The generator's void writes NO event, so it never counts. */
export function hasActiveAbandon(events: readonly LedgerRow[]): boolean {
  return events.some((e) => e.type === "core.abandon" && !events.some((v) => v.voids_event_id === e.id));
}

/** An active abandon that is a withdrawal's EXPUNGE (`core.abandon{expunge: true}`, W2b D5): the match left the table
 *  altogether, so nothing is owed on it. Read from the payload the way the kernel's fold does (`expunge === true`). */
export function abandonExpunged(events: readonly LedgerRow[]): boolean {
  return events.some(
    (e) =>
      e.type === "core.abandon" &&
      !events.some((v) => v.voids_event_id === e.id) &&
      (e.payload as { expunge?: unknown } | null | undefined)?.expunge === true,
  );
}

/** Rebase ruling D3: an active abandon that IS the organiser's online No result (`core.abandon{noResult: true}`) - already
 *  the settle, so a table stage owes it nothing more. Read from the payload the way the server's settle guard does. */
export function abandonNoResult(events: readonly LedgerRow[]): boolean {
  return events.some(
    (e) =>
      e.type === "core.abandon" &&
      !events.some((v) => v.voids_event_id === e.id) &&
      (e.payload as { noResult?: unknown } | null | undefined)?.noResult === true,
  );
}

/** Controller ruling C12 + W2c P-7 / X-AB-5: the engine's stage-aware settle offer (`settleOffered`) fed the same facts
 *  the server's settle guard reads. A bracket kind: the kernel's precondition. A table stage: an active abandon that
 *  decided nobody, a withdrawal's expunge aside. */
export function needsDecision(
  module: { awaitingDecider?(state: never): boolean },
  f: { outcome: unknown; state: unknown; stageKind: string | null; events: readonly LedgerRow[] },
): boolean {
  return settleOffered(module, f.stageKind, {
    outcome: f.outcome as MatchOutcome | null,
    abandoned: hasActiveAbandon(f.events),
    expunged: abandonExpunged(f.events),
    noResult: abandonNoResult(f.events),
    state: f.state,
  });
}

/** Ruling D-H3 — WHY a held fixture is held, so the block can say so: an active abandon (it wins: an abandon over a level
 *  score is still an abandon), else no outcome at all (only a drawn chess knockout game whose tie-break is owed is held
 *  with none — `settleApplies`' third arm), else a level result. Read only for a fixture `needsDecision` holds. */
export type HeldCause = "level" | "abandoned" | "tiebreak";
export function heldCause(f: { outcome: unknown; events: readonly LedgerRow[] }): HeldCause {
  if (hasActiveAbandon(f.events)) return "abandoned";
  return f.outcome == null ? "tiebreak" : "level";
}

const BODY_KEY: Record<HeldCause, MessageKey> = {
  level: "score.needsDecision.body",
  abandoned: "score.needsDecision.body.abandoned",
  tiebreak: "score.needsDecision.body.tiebreak",
};

/** Fix round 2 (N2) - the OFFICIAL's line, by cause. A level or abandoned hold waits on the organiser's settle; a chess
 *  tie-break does not: the official's own pad offers the Tie-break tile, and recording it is the scorer's job (BG-KO-1).
 *  Telling them to wait for the organiser there would stall the match. */
const WAITING_KEY: Record<HeldCause, MessageKey> = {
  level: "score.needsDecision.waiting",
  abandoned: "score.needsDecision.waiting",
  tiebreak: "score.needsDecision.waiting.tiebreak",
};

/** X-AB-5 - a TABLE stage's abandoned match has nobody to ADVANCE: the settle names the winner of a match the table
 *  does not count yet. Only the abandoned cause reaches a table (a level result there is a result, and chess's
 *  tie-break is a knockout's), so it is the one sentence each key map overrides. */
const TABLE_BODY_KEY: Partial<Record<HeldCause, MessageKey>> = { abandoned: "score.needsDecision.body.abandoned.table" };
const TABLE_WAITING_KEY: Partial<Record<HeldCause, MessageKey>> = { abandoned: "score.needsDecision.waiting.table" };

/** Is the fixture's stage a TABLE kind (or no stage at all) - the vocabulary the held sentences speak in. */
export const inTableStage = (stageKind: string | null): boolean => !forbidsLevelResult(stageKind);

/** The block's sentence for a cause, in the stage's own vocabulary (`table`: the stage is not a bracket kind). */
export function heldBodyKey(cause: HeldCause, table: boolean): MessageKey {
  return (table ? TABLE_BODY_KEY[cause] : undefined) ?? BODY_KEY[cause];
}
/** The official's line for a cause, in the stage's own vocabulary. */
export function heldWaitingKey(cause: HeldCause, table: boolean): MessageKey {
  return (table ? TABLE_WAITING_KEY[cause] : undefined) ?? WAITING_KEY[cause];
}

/** Fix round 1 (M7), round 2 (N2): one line for an official scorer on a held fixture, saying what happens next. */
export function HeldNote({ msg, cause, table = false }: { msg: Msg; cause: HeldCause; table?: boolean }) {
  return (
    <p data-testid="held-note" data-cause={cause} className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      {msg(heldWaitingKey(cause, table))}
    </p>
  );
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
  /** Ruling D-H3 — which sentence the block says (`heldCause`). */
  cause: HeldCause;
  /** X-AB-5 - the fixture's stage is a TABLE kind (not a bracket): the abandoned sentence and the dialog's question speak
   *  of the winner, not of who advances. Absent reads as a bracket. */
  table?: boolean;
  /** `withdrawn` (W2b D-R9, legacy rows only): a side that has left the competition is never offered as the winner —
   *  the server refuses it (C17). New rows cannot hold a withdrawn entrant on a held line: a withdrawal walks it over. */
  home: { id: string; name: string; withdrawn?: boolean };
  away: { id: string; name: string; withdrawn?: boolean };
  /** Loop-F tidy 2: does this line feed a NEXT match (`feedsNextMatch`, lib/bracket-next-match.ts — D19's one reading)?
   *  False on a final, a grand final, a third-place line: with both sides gone, the R-4 route (void, then a forfeit)
   *  would award that title or place to someone who has left, so the no-choice sentence names the vacancy instead.
   *  Unknown (absent) reads as the R-4 sentence. */
  feedsNextMatch?: boolean;
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
        <p data-cause={props.cause} className="mt-1 text-sm text-slate-700">
          {msg(heldBodyKey(props.cause, props.table === true))}
        </p>
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

/** Exported for its node test (needs-decision.test.tsx renders it closed-over, effects inert); mounted only by the block. */
export function SettleDialog(props: BlockProps & { onClose: () => void; onRefused: (message: string) => void }) {
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
  // D-R9: only the sides still in the competition are a choice.
  const choices = [props.home, props.away].filter((e) => e.withdrawn !== true);

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
          <legend className="text-sm font-medium text-slate-700">{msg(props.table === true ? "score.needsDecision.whoWins" : "score.needsDecision.whoAdvances")}</legend>
          {/* Loop-F M-8 (legacy rows only, PF-8a): both sides withdrawn leaves no choice — say so, never an empty grid. */}
          {choices.length === 0 && (
            <p data-testid="settle-no-choice" className="mt-2 text-sm text-slate-600">
              {msg(props.feedsNextMatch === false ? "score.needsDecision.noChoice.place" : "score.needsDecision.noChoice")}
            </p>
          )}
          <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            {choices.map((e) => (
              <button
                key={e.id}
                type="button"
                data-testid={`settle-winner-${e.id}`}
                aria-pressed={winner === e.id}
                // Fix round 1 (M12): the name WRAPS (two long names side by side at ≥640 lost their tails, the one thing
                // being chosen between); the button grows to fit, and a long single word breaks rather than overflows.
                onClick={() => setWinner(e.id)}
                className={`flex min-h-12 min-w-0 items-center rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${
                  winner === e.id
                    ? "border-purple-600 bg-purple-600 text-white"
                    : "border-slate-200 bg-white text-slate-800 hover:border-purple-300 hover:bg-purple-50"
                }`}
              >
                <span className="min-w-0 break-words">{e.name}</span>
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
