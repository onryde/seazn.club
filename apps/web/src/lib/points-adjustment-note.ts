// W5 app PR B, Task 7 (C5; X-ADJ-1, X-ADJ-4; RB5-T5..T9, RB5-T15; owner R24 pick 15 A, ruling 284): "Adjust points" — an
// organiser moves an entrant's table points by N with a required reason, on a started, not-complete league, group or Swiss stage
// (preflight C5). Its source is the division ledger: `adjustPoints` (usecases/points-adjustments.ts) appends one
// `points_adjustment` row; its Undo appends a `points_adjustment_voided` row naming it (`voids_seq`) — append-only, as
// `table_withdrawal_voided` is. Neither is a history step nor an Undo barrier: the engine's `isReversible` is false for both,
// and a division Undo steps over them (the adjustment's own Undo is the reversal).
//
// Two readers of one fold over the rows (`activePointsAdjustments`): the table fold (`toTableStage`, engine-db/competition.ts →
// `TableStage.adjustments`, folded before the cascade) and the footnote under the table on every surface that prints it
// ("Marsh Lane: −3 points, fielded an ineligible player, 16 Nov 2026."). The footnote reads the row, never the fold, so a
// surface that holds only the stored snapshot (the division page, the embed, the hub) prints it from the same ledger.
//
// Pure and client-safe: the public pages, the hub and the console resolve the text with this module.
import type { TKey } from "@/lib/i18n-runtime";
import { pointsText } from "@seazn/engine/competition";

export const POINTS_ADJUSTMENT_ROW = "points_adjustment";
export const POINTS_ADJUSTMENT_VOIDED_ROW = "points_adjustment_voided";

/** What `delta` moved (engine `AdjustmentUnit`, RB5-T15): table points, or matches won where the cascade ranks wins first. */
export type AdjustmentUnit = "points" | "wins";
/** The stage points rule's stored unit (`PointsRule.unit`): "half" stores half-points (chess 1 / ½ / 0), shown "1½". */
export type PointsDisplayUnit = "whole" | "half";

/** One active `points_adjustment` row, as written. `delta` is in the engine's ranking unit (half-points on a "half" rule);
 *  `unit` and `points_unit` are DISPLAY facts recorded at write from the stage's pinned rules (C5: only a started stage, whose
 *  rules are pinned and cannot move, takes one) — the fold derives its own unit from the same pin (`adjustmentUnitOf`). `at` is
 *  the ledger row's date (ISO). */
export interface PointsAdjustmentRecord {
  seq: number;
  stage_id: string;
  entrant_id: string;
  delta: number;
  reason: string;
  unit: AdjustmentUnit;
  points_unit: PointsDisplayUnit;
  at: string;
  /** B3 ruling 3: set on a COPY of a source stage's row, filed under the stage its table was carried into (`withCarriedAdjustments`)
   *  - the source stage, named, for the destination's footnote. Never on a row the ledger fold reads (`activePointsAdjustments`). */
  carried_from?: { stage_id: string; stage_name: string };
}

/** B3 ruling 3: one carry of a finished table into the next stage, as its `standings_carried` row records it (the newest per
 *  destination): the destination, the source and its name, the carry's mode and the entrants carried. */
export interface AdjustmentCarry {
  into: string;
  from: string;
  fromName: string;
  mode: "points" | "full";
  entrants: readonly string[];
}

/**
 * B3 ruling 3: a carried table carries its adjustments - a carry's opening is the source's folded row, adjustment and all - so the
 * destination's footnote names each one it carries, "carried from <stage>". Each source row of a carried entrant is copied under the
 * destination with `carried_from`; the source keeps its own. A "points" carry moves points only (engine `carryDeltas`: won 0), so
 * it carries a points adjustment and never a wins one; a "full" carry moves both. No carry: the records unchanged.
 */
export function withCarriedAdjustments(records: readonly PointsAdjustmentRecord[], carries: readonly AdjustmentCarry[]): PointsAdjustmentRecord[] {
  const out = [...records];
  for (const c of carries) {
    const carried = new Set(c.entrants);
    for (const r of records) {
      if (r.stage_id !== c.from || r.carried_from !== undefined || !carried.has(r.entrant_id)) continue;
      if (r.unit === "wins" && c.mode !== "full") continue;
      out.push({ ...r, stage_id: c.into, carried_from: { stage_id: c.from, stage_name: c.fromName } });
    }
  }
  return out;
}

/** A ledger row as the readers load it: `at` is the row's `created_at` as ISO text. */
export interface AdjustmentLedgerRow {
  seq: number;
  type: string;
  payload: unknown;
  at: string;
}

/**
 * The rows still in force, in ledger order: every `points_adjustment` no `points_adjustment_voided` names (`voids_seq`). Unlike a
 * withdrawal, two adjustments of one entrant STACK (X-ADJ-4 "a second adjustment stacks"): every active row is kept. A row this
 * module's writer never produces (a missing field, a zero or non-finite delta, an empty reason) is not read, so neither the fold
 * nor the footnote ever acts on a row the engine would refuse (`validatePointsAdjustments`) and brick every score write.
 */
export function activePointsAdjustments(ledger: readonly AdjustmentLedgerRow[]): PointsAdjustmentRecord[] {
  const voided = new Set<number>();
  for (const row of ledger) {
    const of = (row.payload as { voids_seq?: unknown } | null)?.voids_seq;
    if (row.type === POINTS_ADJUSTMENT_VOIDED_ROW && typeof of === "number") voided.add(of);
  }
  const out: PointsAdjustmentRecord[] = [];
  for (const row of [...ledger].sort((a, b) => a.seq - b.seq)) {
    if (row.type !== POINTS_ADJUSTMENT_ROW || voided.has(row.seq)) continue;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (typeof p.stage_id !== "string" || typeof p.entrant_id !== "string") continue;
    if (typeof p.delta !== "number" || !Number.isFinite(p.delta) || p.delta === 0) continue;
    if (typeof p.reason !== "string" || p.reason.trim() === "") continue;
    if (p.unit !== "points" && p.unit !== "wins") continue;
    if (p.points_unit !== "whole" && p.points_unit !== "half") continue;
    out.push({
      seq: row.seq,
      stage_id: p.stage_id,
      entrant_id: p.entrant_id,
      delta: p.delta,
      reason: p.reason,
      unit: p.unit,
      points_unit: p.points_unit,
      at: row.at,
    });
  }
  return out;
}

/** One footnote of ONE table, before its text is resolved. */
export interface AdjustmentNote {
  seq: number;
  entrantId: string;
  name: string;
  delta: number;
  unit: AdjustmentUnit;
  pointsUnit: PointsDisplayUnit;
  reason: string;
  at: string;
  /** B3 ruling 3: the source stage's name when the table carried this adjustment in. */
  carriedFrom?: string;
}

/**
 * The adjustment notes of ONE table: its stage's active rows whose entrant the table LISTS (`tableEntrantIds`, a pool's table
 * names only its pool), in ledger order — the rows the engine notes on that pool (`PoolTable.notes`). A held row (preflight C8:
 * its entrant is seated in no pool) is noted nowhere, as the fold folds it nowhere.
 */
export function adjustmentNotesFor(
  stageId: string,
  tableEntrantIds: readonly string[],
  records: readonly PointsAdjustmentRecord[],
  names: Readonly<Record<string, string>>,
): AdjustmentNote[] {
  const listed = new Set(tableEntrantIds);
  return records
    .filter((r) => r.stage_id === stageId && listed.has(r.entrant_id))
    .map((r) => ({
      seq: r.seq,
      entrantId: r.entrant_id,
      name: names[r.entrant_id] ?? r.entrant_id,
      delta: r.delta,
      unit: r.unit,
      pointsUnit: r.points_unit,
      reason: r.reason,
      at: r.at,
      ...(r.carried_from === undefined ? {} : { carriedFrom: r.carried_from.stage_name }),
    }));
}

/** The signed amount as the table prints it: "−3", "+1", "−½" (a half-point rule), the minus sign U+2212. */
export function adjustmentAmountText(delta: number, unit: AdjustmentUnit, pointsUnit: PointsDisplayUnit): string {
  const sign = delta < 0 ? "−" : "+";
  const magnitude = Math.abs(delta);
  return sign + (unit === "points" ? pointsText(magnitude, pointsUnit) : String(magnitude));
}

/** The number the plural is chosen by: a half-point rule's stored delta 2 is ONE point. */
export function adjustmentShownCount(delta: number, unit: AdjustmentUnit, pointsUnit: PointsDisplayUnit): number {
  const magnitude = Math.abs(delta);
  return unit === "points" && pointsUnit === "half" ? magnitude / 2 : magnitude;
}

/** The dictionary key of the amount's noun phrase, by unit and plural category (`one` or `other`) - its "carried from" form when
 *  the table carried the adjustment in (B3 ruling 3). */
export function adjustmentBodyKey(unit: AdjustmentUnit, count: number, locale: string, carried = false): TKey {
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    category = count === 1 ? "one" : "other";
  }
  const form = category === "one" ? "one" : "other";
  return `table.adjustmentNote.${unit}${carried ? ".carried" : ""}.${form}` as TKey;
}

/** One footnote line, resolved: the bold lead ("Marsh Lane:") and the sentence after it. */
export interface AdjustmentNoteText {
  key: string;
  entrantId: string;
  lead: string;
  body: string;
}

export function adjustmentNoteText(
  note: AdjustmentNote,
  msg: (key: TKey, vars?: Record<string, string | number>) => string,
  dateOf: (iso: string) => string | null,
  locale: string,
): AdjustmentNoteText {
  const count = adjustmentShownCount(note.delta, note.unit, note.pointsUnit);
  return {
    key: String(note.seq),
    entrantId: note.entrantId,
    lead: msg("table.adjustmentNote.lead", { name: note.name }),
    body: msg(adjustmentBodyKey(note.unit, count, locale, note.carriedFrom !== undefined), {
      amount: adjustmentAmountText(note.delta, note.unit, note.pointsUnit),
      ...(note.carriedFrom === undefined ? {} : { stage: note.carriedFrom }),
      reason: note.reason.trim(),
      date: dateOf(note.at) ?? note.at.slice(0, 10),
    }),
  };
}
