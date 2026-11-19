import "server-only";
import { HistoryError, redo as engineRedo, undo as engineUndo, type LedgerEvent } from "@seazn/engine/history";
import { HttpError } from "@/lib/errors";
import { isKnockoutRefusalCode } from "@/lib/knockout-refusals";
import { isRoundRobinRefusalCode } from "@/lib/roundrobin-refusals";
import type { UndoRefusalCode } from "@/lib/undo-refusals";
import { SWISS_PAIRINGS, type SwissPairingMode } from "@/lib/swiss-pairing";
import { swissRefusal } from "../swiss-refusal";
import { knockoutRefusal } from "../knockout-refusal";
import { roundRobinRefusal } from "../roundrobin-refusal";

/**
 * W3 T5 (design §10.8, X-SW-28; spec §7 "Add late player has no Undo"): the ledger events no Undo or Redo steps across.
 * The engine skips them — they are not REVERSIBLE (`isReversible`) — so this app-side check is the only barrier.
 * A late entry is one only when an ORGANISER added the player (ruling 252 items 8 and 11: an automatic arrival — a paid
 * registration, a waitlist promotion, an import — does not change Undo); a change to the round count always is.
 * W4 T5 (K1): so is a seed confirm (`seed_confirmed`, stages/seed-proposal.ts `confirmSeedProposal`). It fills a setup-timing bracket's
 * seats through `fillSlot`, a write no ledger step records, so an Undo after it inverted the step BEFORE it — the
 * bracket's own day-one generation — and deleted the seeded draw. Each row is written by `appendUndoBarrierRow`
 * (swiss-late-entry.ts), which moves the division's token and never the watermark.
 */
export const UNDO_BARRIER_TYPES = {
  swiss_late_entry: "SWISS_LATE_ENTRY_NOT_UNDOABLE",
  swiss_rounds_changed: "SWISS_ROUNDS_CHANGE_NOT_UNDOABLE",
  seed_confirmed: "SEED_CONFIRM_NOT_UNDOABLE",
  // W4 T10 (X-LE-13): a late player placed into a drawn knockout — a bye reopened or a walkover reversed, writes no step
  // records. Every writer of the row is an organiser's action (Add late player; Task 11's one-tap place), so every row
  // is a barrier.
  knockout_late_entry: "KO_LATE_ENTRY_NOT_UNDOABLE",
  // W5 T5 (X-CU-13, RB5-L14): a late player added to a started league or group — catch-up lines written outside any step (or the
  // stage redrawn with them in it). Only an organiser's add writes the row, so every row is a barrier; the refusal points to
  // Withdraw.
  roundrobin_late_entry: "RR_LATE_ENTRY_NOT_UNDOABLE",
} as const satisfies Record<string, UndoRefusalCode>;

export type UndoBarrierType = keyof typeof UNDO_BARRIER_TYPES;

/** A barrier's refusal, thrown through its own family's table so the status, the code and the English come from one row:
 *  a knockout code through `knockoutRefusal`, a round-robin one through `roundRobinRefusal` (W5 T5), a Swiss one through
 *  `swissRefusal`. */
export function undoRefusal(code: UndoRefusalCode): HttpError {
  if (isKnockoutRefusalCode(code)) return knockoutRefusal(code);
  if (isRoundRobinRefusalCode(code)) return roundRobinRefusal(code);
  return swissRefusal(code);
}

function isUndoBarrier(e: LedgerEvent): e is LedgerEvent & { type: UndoBarrierType } {
  if (!Object.hasOwn(UNDO_BARRIER_TYPES, e.type)) return false;
  return e.type !== "swiss_late_entry" || e.payload.source === "organiser";
}

/** The refusal code of the NEWEST barrier past `targetSeq` — the ledger row an Undo inverts or a Redo copies — or null
 *  when the step crosses none. Order-free: the newest is the highest seq, however the ledger arrives. */
export function undoBarrierRefusal(ledger: readonly LedgerEvent[], targetSeq: number): UndoRefusalCode | null {
  let newest: (LedgerEvent & { type: UndoBarrierType }) | undefined;
  for (const e of ledger) {
    if (e.seq <= targetSeq || !isUndoBarrier(e)) continue;
    if (newest === undefined || e.seq > newest.seq) newest = e;
  }
  return newest === undefined ? null : UNDO_BARRIER_TYPES[newest.type];
}

/** The barrier the step the engine REFUSED (a result in its footprint) would have crossed: the same step read with no
 *  fixture counted as played, so its target is known. Null when the step crosses none, or the engine has no step to take
 *  (the caller then answers with the engine's own refusal). Only the engine's own HistoryError is that "no step"; any
 *  other throw — `invertedStepSeq`'s contract guard (HttpError 500), a payload the engine cannot read — is a defect and
 *  goes out, because answering "no barrier" for it would skip the very check the guard exists to force. */
export function barrierOfRefusedStep(direction: "undo" | "redo", ledger: readonly LedgerEvent[], watermark: number | null): UndoRefusalCode | null {
  try {
    const probe = direction === "undo" ? engineUndo(ledger, watermark, new Set()) : engineRedo(ledger, watermark, new Set());
    return undoBarrierRefusal(ledger, invertedStepSeq(direction, probe.event.payload));
  } catch (err) {
    if (err instanceof HistoryError) return null;
    throw err;
  }
}

/** The ledger row a step inverts (Undo, `__undo_of`) or copies (Redo, `__redo_of`): the engine stamps every one
 *  (`undo`/`redo`, @seazn/engine/history). A step with no stamp is a broken contract, and refused by name — a barrier
 *  check skipped on an absence would let the step cross one. */
export function invertedStepSeq(direction: "undo" | "redo", payload: Record<string, unknown>): number {
  const seq = direction === "undo" ? payload.__undo_of : payload.__redo_of;
  if (typeof seq !== "number") {
    throw new HttpError(500, `history step names no ledger row (${direction === "undo" ? "__undo_of" : "__redo_of"})`);
  }
  return seq;
}

/** The rows a Pair next seated (`seated_fixture_ids`, stages/generate-tx.ts `generateStageFixturesTx`): the shells it UPDATED,
 *  which `fixture_ids` — the Undo DELETE list — never names. Empty for every other generation. */
/** The Pair-next row whose seats a `fixtures_cleared` step takes away. An Undo clears the row it inverts; a Redo
 *  re-does an Undo, so it clears the row THAT Undo had inverted (`__undo_of`, which a Redo copy keeps). Batch-1 I1: once
 *  Undo can walk back through a Pair's own Undo, Redo can walk forward over it again, and that step clears seats too. */
export function pairRowClearedBy(ledger: readonly LedgerEvent[], direction: "undo" | "redo", targetSeq: number): LedgerEvent | undefined {
  const target = ledger.find((e) => e.seq === targetSeq);
  if (direction === "undo") return target;
  const of = target?.payload.__undo_of;
  return typeof of === "number" ? ledger.find((e) => e.seq === of) : undefined;
}

/** W3 T8 review P1. The Pair a re-pairing step puts back — the mirror of `pairRowClearedBy`. A Redo copies that row (the
 *  row `__redo_of` names); an Undo walking back through a Pair's own Undo inverts that Undo (a `fixtures_cleared`), whose
 *  `__undo_of` names the Pair. Either row may itself be an earlier step's: those record the same audit
 *  (`ledgerPayload`), override included. */
export function pairRowRestoredBy(ledger: readonly LedgerEvent[], direction: "undo" | "redo", targetSeq: number): LedgerEvent | undefined {
  const target = ledger.find((e) => e.seq === targetSeq);
  if (direction === "redo") return target;
  const of = target?.payload.__undo_of;
  return typeof of === "number" ? ledger.find((e) => e.seq === of) : undefined;
}

/** The round-1 pairing override a Pair row recorded (`override: true` with its `pairing`), or undefined: the round's own
 *  mode. Only a recognised mode is handed on — anything else is a row this code never wrote. */
export function recordedPairingOverride(e: LedgerEvent | undefined): SwissPairingMode | undefined {
  if (e?.type !== "fixtures_generated" || e.payload.override !== true) return undefined;
  const mode = e.payload.pairing;
  return SWISS_PAIRINGS.find((m) => m === mode);
}

export function pairNextSeatedIds(e: LedgerEvent | undefined): string[] {
  if (e?.type !== "fixtures_generated") return [];
  const ids = e.payload.seated_fixture_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}
