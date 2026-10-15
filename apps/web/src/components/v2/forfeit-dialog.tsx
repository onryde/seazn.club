"use client";

// W2b Task 11 (UI-1 option A; spec §5.5, §7). The organiser console's forfeit: one dialog, who → why → the credit the
// table will carry → one specific Confirm. It replaces the old side menu plus a free-text reason prompt that defaulted
// to "walkover" — which the server now refuses for every reason outside the closed vocabulary (X-RS-1).
//
// Nothing here decides what may be recorded. The chips are the engine's own phase guard (`forfeitAdmission`,
// core/events.ts — the list the guard judges by, exported for exactly this) less the server's cascade-only reasons
// (`CASCADE_ONLY_FORFEIT_REASONS`, PF-2: withdrew is the withdrawal cascade's alone); "Neither" is the guard's own
// double-walkover answer, hidden where the server refuses it (`noNextMatch`, read server-side through D19's one
// reading, lib/double-walkover-next-match.ts); the preview is the module's own `forfeitCredit`. So the dialog can never
// offer a choice the server would refuse for a reason the dialog could have known.
//
// The visual pattern is the settle dialog's (needs-decision.tsx `SettleDialog`): a bottom sheet on phones, buttons for
// the side, radios for the reason, Cancel + Confirm, focus trapped, Escape closes unless sending.
import { useEffect, useRef, useState } from "react";
import { forfeitAdmission, playRecorded, unplayedForfeitEvent, type ForfeitAward, type ForfeitReason, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { isCascadeOnlyForfeitReason, type WriterForfeitReason } from "@/lib/forfeit-phase-refusal";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Who forfeits: a side (the OFFENDING one — the engine awards the other), or both (a double walkover, X-DW-1). */
export type ForfeitWho = "home" | "away" | "both";

export type ForfeitConfirmKey =
  | "forfeitDialog.confirm.walkover"
  | "forfeitDialog.confirm.retired"
  | "forfeitDialog.confirm.disqualified"
  | "forfeitDialog.confirm.doubleWalkover"
  | "forfeitDialog.confirm.withdrew";

export interface ForfeitDialogModel {
  /** The sides offered, in this order; "both" only in the module's walkover phases and when the fixture has a next match. */
  who: readonly ForfeitWho[];
  /** The reasons offered for a side, in FORFEIT_REASONS order (D3); "both" ⇒ ["walkover"]. A side not offered ⇒ []. */
  why: (who: ForfeitWho) => readonly WriterForfeitReason[];
  /** The table's credited headline score (the module's first metric), or null when nothing is credited on it. */
  preview: (who: ForfeitWho, reason: ForfeitReason) => { home: string; away: string } | null;
  confirmKey: (who: ForfeitWho, reason: ForfeitReason) => ForfeitConfirmKey;
  /** The reason radio's label, in the sport's own terms where the house word would read as one of its results. */
  reasonKey: (reason: WriterForfeitReason) => MessageKey;
  /** X-DW-3: shown instead of "Neither" on a fixture with no next match (§7 row 3's sentence). */
  guidance: "noNextMatch" | null;
}

/** What the model reads off a sport module: its phase guard, its credit and its table's metric order. */
export type ForfeitModule = Pick<AnySportModule, "key" | "forfeitPhase" | "walkoverPhases" | "startIsPlay" | "forfeitCredit" | "metrics">;

const REASON_KEY: Record<WriterForfeitReason, MessageKey> = {
  walkover: "forfeitDialog.reason.walkover",
  retired: "forfeitDialog.reason.retired",
  disqualified: "forfeitDialog.reason.disqualified",
};

/** Design audit 1.3: a reason worded in a sport's own terms, where the house gloss sits beside one of the sport's own
 *  results. Chess's dock records "Resignation" (`method.resign`, a board result); a chess retirement is the player
 *  leaving the game — a different fact, so its gloss says so. Same noun, so Confirm still records a retirement. */
const SPORT_REASON_KEY: Readonly<Record<string, Partial<Record<WriterForfeitReason, MessageKey>>>> = {
  boardgame: { retired: "forfeitDialog.reason.retired.boardgame" },
};

const CONFIRM_KEY: Record<ForfeitReason, ForfeitConfirmKey> = {
  walkover: "forfeitDialog.confirm.walkover",
  retired: "forfeitDialog.confirm.retired",
  disqualified: "forfeitDialog.confirm.disqualified",
  // Kept for the union (spec), unreachable from this dialog: no phase offers withdrew to an organiser (PF-2).
  withdrew: "forfeitDialog.confirm.withdrew",
};

const SIDES = ["home", "away"] as const;

/** One ledger row as the console holds it (fixture-console.tsx `EventIn`): a void names its target in `voids_event_id`. */
export type ForfeitLedgerRow = { readonly id: string; readonly seq: number; readonly type: string; readonly voids_event_id: string | null };

/**
 * Ruling 112's fact for the dialog: has anything been played on this fixture — the engine's own `playRecorded` (the
 * reading its fold guard judges a walkover by), asked of the console's ledger rows in seq order, for the fixture's own
 * module (ruling 118: chess's Start is play).
 */
export function forfeitPlayRecorded(rows: readonly ForfeitLedgerRow[], module: Pick<ForfeitModule, "startIsPlay">): boolean {
  return playRecorded(
    [...rows].sort((a, b) => a.seq - b.seq).map((r) => ({ id: r.id, type: r.type, voids: r.voids_event_id })),
    module,
  );
}

/**
 * The dialog's model (spec §5.5). `state` is the module's folded state for this fixture (`forfeitBaseState` for a
 * scheduled one). `noNextMatch` is the page's server-side D19 reading: a feeding bracket kind on a line that feeds no
 * next match, where the server refuses a double walkover (DOUBLE_WALKOVER_NO_NEXT_MATCH). `playRecorded` is ruling 112's
 * fact, read from the same ledger the state folds (`forfeitPlayRecorded`): a walkover stays on offer after the Start
 * until something is played.
 */
export function forfeitDialogModel(
  module: ForfeitModule,
  cfg: unknown,
  state: unknown,
  f: {
    noNextMatch: boolean;
    playRecorded: boolean;
    /** W2c Task 16b (X-WO-1 B): the stage points rule's walkover award (winner first) the page read server-side
     *  (`stageForfeitAward`), when the fixture's stage has one that reaches this sport's table. The preview then says the
     *  number the table will carry for a forfeit with nothing played - the same reading the server's fold makes
     *  (`unplayedForfeitEvent`) - and the sport's own credit for one after play (P-3 "A"). */
    forfeitAward?: ForfeitAward;
  },
): ForfeitDialogModel {
  const admission = forfeitAdmission(module, state, { playRecorded: f.playRecorded });
  // PF-2: the engine admits withdrew in every phase; the server refuses it from every writer but the cascade.
  const sideReasons = admission.reasons.filter((r): r is WriterForfeitReason => !isCascadeOnlyForfeitReason(r));
  const sides: ForfeitWho[] = sideReasons.length > 0 ? [...SIDES] : [];
  const both = admission.both && !f.noNextMatch;
  const who: readonly ForfeitWho[] = both ? [...sides, "both"] : sides;
  const why = (w: ForfeitWho): readonly WriterForfeitReason[] => {
    if (!who.includes(w)) return [];
    return w === "both" ? ["walkover"] : sideReasons;
  };
  const headline = module.metrics[0]?.key;
  const preview = (w: ForfeitWho, reason: ForfeitReason): { home: string; away: string } | null => {
    // X-DW-4: a double walkover credits nothing; a choice the dialog does not offer previews nothing.
    if (w === "both" || headline === undefined || !why(w).includes(reason as WriterForfeitReason)) return null;
    let credit: ReturnType<ForfeitModule["forfeitCredit"]>;
    try {
      // The module reads the award from its own state (`state.forfeitAward`), as the server's fold leaves it.
      const awarded = f.forfeitAward !== undefined && typeof state === "object" && state !== null && unplayedForfeitEvent({ by: w, reason }, f.playRecorded);
      credit = module.forfeitCredit(cfg, awarded ? { ...state, forfeitAward: f.forfeitAward } : state, reason, w);
    } catch {
      // A credit the module cannot compute here (an unpriceable cfg) is the server's refusal to explain, not a guess.
      return null;
    }
    const [h, a] = [credit.perSide[0][headline], credit.perSide[1][headline]];
    if (typeof h !== "number" || typeof a !== "number") return null;
    // GN-WO-1 / CK-WO-1: a walkover that credits no score on the headline (generic 0-0, cricket's runs) reads as none.
    if (h === 0 && a === 0) return null;
    return { home: String(h), away: String(a) };
  };
  return {
    who,
    why,
    preview,
    confirmKey: (w, reason) => (w === "both" ? "forfeitDialog.confirm.doubleWalkover" : CONFIRM_KEY[reason]),
    reasonKey: (reason) => SPORT_REASON_KEY[module.key]?.[reason] ?? REASON_KEY[reason],
    guidance: admission.both && f.noNextMatch ? "noNextMatch" : null,
  };
}

/** Review M-1: the preview states the consequence the server will RECORD, and the server judges the send at the
 *  current tip (`post` sends `live.last_seq`). So the chips stay the snapshot taken when the dialog opened, but the
 *  preview reads the console's CURRENT model (`live`, recomputed from every resync): a goal recorded on another device
 *  while the dialog is open moves the credited score with it (FB-RT-1: the real margin stands). Where the current model
 *  no longer offers the choice (the match moved past it), nothing it computes is the answer — the server refuses that
 *  send and the console says why — so the snapshot's preview stays, never a "no score" that would be a claim. */
export function forfeitPreviewNow(
  snapshot: ForfeitDialogModel,
  live: ForfeitDialogModel | null,
  who: ForfeitWho,
  reason: ForfeitReason,
): { home: string; away: string } | null {
  if (live !== null && live.why(who).includes(reason as WriterForfeitReason)) return live.preview(who, reason);
  return snapshot.preview(who, reason);
}

/** The page serves `state: null` for a scheduled fixture (no match_states row yet). The engine's reading of a fixture
 *  with no events is the module's own init — the same fallback the pad pipeline folds from (use-pad-pipeline.ts). */
export function forfeitBaseState(module: Pick<AnySportModule, "init">, cfg: unknown, state: unknown, lineups: LineupPair): unknown {
  return state ?? module.init(cfg, lineups);
}

export interface ForfeitSelection {
  who: ForfeitWho | null;
  reason: WriterForfeitReason | null;
}
export const NO_FORFEIT_PICK: ForfeitSelection = { who: null, reason: null };
export type ForfeitPick = { kind: "who"; who: ForfeitWho } | { kind: "why"; reason: WriterForfeitReason };

/** One tap. A side or reason the model does not offer is not taken (the selection is returned as it was); changing the
 *  side keeps a reason the new side is also offered. Design audit 1.1: a side offered ONE reason has it chosen with the
 *  side ("Both sides" is always a walkover; so is a side before play) — a second tap there would decide nothing. */
export function pickForfeit(model: ForfeitDialogModel, sel: ForfeitSelection, pick: ForfeitPick): ForfeitSelection {
  if (pick.kind === "who") {
    if (!model.who.includes(pick.who)) return sel;
    const offered = model.why(pick.who);
    const keep = sel.reason !== null && offered.includes(sel.reason);
    return { who: pick.who, reason: keep ? sel.reason : offered.length === 1 ? offered[0]! : null };
  }
  if (sel.who === null || !model.why(sel.who).includes(pick.reason)) return sel;
  return { ...sel, reason: pick.reason };
}

/** Confirm stays disabled until who and why are chosen (and still offered), and from the first tap until the answer
 *  comes back (Review Focus 4: a double submit must record one forfeit). */
export function forfeitConfirmBlocked(model: ForfeitDialogModel, sel: ForfeitSelection, sending: boolean): boolean {
  return sel.who === null || sel.reason === null || sending || !model.why(sel.who).includes(sel.reason);
}

/** `core.forfeit {by, reason}`: the offending entrant's id, or "both" for a double walkover. Only for an unblocked
 *  selection (the caller checks `forfeitConfirmBlocked` first). */
export function forfeitPayload(sel: ForfeitSelection, entrants: { home: string; away: string }): { by: string; reason: WriterForfeitReason } {
  if (sel.who === null || sel.reason === null) throw new Error("forfeitPayload: nothing chosen — Confirm is blocked");
  return { by: sel.who === "both" ? "both" : entrants[sel.who], reason: sel.reason };
}

export type ForfeitResult = { ok: true } | { ok: false; message: string };

interface DialogProps {
  msg: Msg;
  model: ForfeitDialogModel;
  /** The console's model over the CURRENT ledger (review M-1): the preview follows it; the chips stay `model`'s. */
  live?: ForfeitDialogModel | null;
  /** The two entrants as the screen names them (`entrantDisplayName`, D-6). */
  home: { id: string; name: string };
  away: { id: string; name: string };
  /** Sends `core.forfeit` and reports the server's answer — the localized refusal on a 4xx. */
  forfeit: (payload: { by: string; reason: WriterForfeitReason }) => Promise<ForfeitResult>;
  onClose: () => void;
  /** Spec §7: a refused forfeit CLOSES the dialog and the reason shows on the console (`forfeit-refusal`). */
  onRefused: (message: string) => void;
}

const FORFEIT_DIALOG_TITLE_ID = "forfeit-dialog-title";
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

export function ForfeitDialog(props: DialogProps) {
  const { msg, model } = props;
  const [sel, setSel] = useState<ForfeitSelection>(NO_FORFEIT_PICK);
  const [sending, setSending] = useState(false);
  // The synchronous guard: a double click lands its second event before React re-renders `sending`.
  const sendingRef = useRef(false);
  const onCloseRef = useRef(props.onClose);
  useEffect(() => {
    onCloseRef.current = props.onClose;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  // One forfeit dialog per console, one console per page: a fixed id, not `useId` (which the node harness that drives
  // this dialog's clicks does not supply).
  const titleId = FORFEIT_DIALOG_TITLE_ID;

  // The settle dialog's focus discipline: focus once on mount, give focus back on close, trap Tab, Escape closes.
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
    if (forfeitConfirmBlocked(model, sel, sendingRef.current)) return;
    sendingRef.current = true;
    setSending(true);
    const r = await props.forfeit(forfeitPayload(sel, { home: props.home.id, away: props.away.id }));
    sendingRef.current = false;
    setSending(false);
    if (r.ok) props.onClose();
    else props.onRefused(r.message);
  };

  const whoLabel = (w: ForfeitWho): string => (w === "home" ? props.home.name : w === "away" ? props.away.name : msg("forfeitDialog.who.both"));
  const reasons = sel.who === null ? [] : model.why(sel.who);
  const chosen = sel.who !== null && sel.reason !== null;
  const preview = chosen ? forfeitPreviewNow(model, props.live ?? null, sel.who!, sel.reason!) : null;
  const blocked = forfeitConfirmBlocked(model, sel, sending);

  return (
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !sendingRef.current) props.onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="forfeit-dialog" className="modal">
        <span className="sheet-handle" aria-hidden />
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {msg("forfeitDialog.title")}
        </h2>
        <fieldset className="mt-4 min-w-0">
          <legend className="text-sm font-medium text-slate-700">{msg("forfeitDialog.who")}</legend>
          {/* Loop H F3: a wrapping row, not two fixed columns — at 768 and 1280 a half-width column broke a long surname
              mid-word ("Wolfeschlegelsteinhause / n"). The AI instruction preview's pattern (`flex-1 basis-*`): two
              chips share a row when their words fit (the old two columns at ≥640), stack when one does not (and below
              640, where the sheet is narrower than two bases — the old single column). */}
          <div className="mt-2 flex min-w-0 flex-wrap gap-2">
            {model.who.map((w) => (
              <button
                key={w}
                type="button"
                data-testid={`forfeit-who-${w}`}
                aria-pressed={sel.who === w}
                onClick={() => setSel((s) => pickForfeit(model, s, { kind: "who", who: w }))}
                // The settle dialog's M12: a long name WRAPS whole, never an ellipsis. Loop H F3: at WORD boundaries — no
                // `min-w-0`, so a chip never shrinks below its longest word; `max-w-full` clamps that to the row, so only a
                // single word wider than the whole dialog falls back to `break-words`.
                className={`flex min-h-12 max-w-full flex-1 items-center rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${
                  w === "both" ? "basis-full " : "basis-48 "
                }${
                  sel.who === w
                    ? "border-purple-600 bg-purple-600 text-white"
                    : "border-slate-200 bg-white text-slate-800 hover:border-purple-300 hover:bg-purple-50"
                }`}
              >
                <span className="min-w-0 break-words">{whoLabel(w)}</span>
              </button>
            ))}
          </div>
          {model.guidance === "noNextMatch" && (
            <p data-testid="forfeit-guidance-no-next-match" className="mt-2 text-sm text-slate-600">
              {msg("forfeitDialog.guidance.noNextMatch")}
            </p>
          )}
        </fieldset>
        {sel.who !== null && (
          <fieldset className="mt-4 min-w-0">
            <legend className="text-sm font-medium text-slate-700">{msg("forfeitDialog.why")}</legend>
            <div className="mt-1 grid gap-1">
              {reasons.map((r) => (
                <label key={r} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-slate-50">
                  <input
                    type="radio"
                    name="forfeit-why"
                    data-testid={`forfeit-why-${r}`}
                    checked={sel.reason === r}
                    onChange={() => setSel((s) => pickForfeit(model, s, { kind: "why", reason: r }))}
                    className="h-4 w-4 shrink-0 accent-purple-600"
                  />
                  <span className="min-w-0 text-sm text-slate-800">{msg(model.reasonKey(r))}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {chosen && (
          <p data-testid="forfeit-preview" className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 [overflow-wrap:anywhere]">
            {preview === null
              ? msg("forfeitDialog.preview.none")
              : msg("forfeitDialog.preview", { home: props.home.name, homeScore: preview.home, away: props.away.name, awayScore: preview.away })}
          </p>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={sending} onClick={props.onClose} className="btn btn-ghost min-h-11">
            {msg("editor.cancel")}
          </button>
          <button
            type="button"
            data-testid="forfeit-confirm"
            disabled={blocked}
            onClick={() => void confirm()}
            className="btn btn-danger min-h-11"
          >
            {chosen ? msg(model.confirmKey(sel.who!, sel.reason!)) : msg("forfeitDialog.confirm.choose")}
          </button>
        </div>
      </div>
    </div>
  );
}
