// Schedule history domain (Jul3/03 §3) — undo as ledger navigation. Types
// first (PROMPT-00 §3). The ledger is the existing division_events stream;
// this module never sees the database.
import { z } from "zod";

export const LedgerEvent = z.object({
  seq: z.number().int().positive(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

// Placement of one fixture on the timetable.
export const Placement = z.object({
  at: z.string().nullable(), // ISO timestamp | null = unscheduled
  court: z.string().nullable(),
});
export type Placement = z.infer<typeof Placement>;

// The disposable fold cache (same principle as MatchState, doc 02 §6):
// fold(events ≤ watermark) rebuilds it from the ledger at any time.
export interface FixtureScheduleState {
  exists: boolean;
  at: string | null;
  court: string | null;
  locked: boolean;
}
export interface DivisionScheduleState {
  fixtures: Record<string, FixtureScheduleState>;
}

// The event the app should append (under the division aggregate lock) plus
// the new watermark to persist.
export interface HistoryStep {
  event: { type: string; payload: Record<string, unknown> };
  newWatermark: number;
}

export type HistoryErrorCode =
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "UNDO_BLOCKED_HAS_RESULTS"; // Jul3/03 §3 results-guard

export class HistoryError extends Error {
  constructor(
    readonly code: HistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

const JsonObject = z.record(z.string(), z.unknown());

// A fixture snapshot rich enough to re-insert the row on undo/redo of a
// destructive op (fixtures_cleared / pool_entrants_cleared payloads).
//
// Restore fidelity (2026-09-23): every field after `locked` was added so the
// re-inserted row is the row that was taken — its ext_key, V368 round role,
// placeholders, feed edges, number, generation-time verdict and the rest of
// its schedule placement. Which columns are kept, and which deliberately are
// not, is decided beside the one reader and the one writer
// (`snapshotFixtures` / `restoreFixtures`, apps/web/src/server/usecases/
// history.ts). Every one is optional: a snapshot a ledger already holds from
// before they existed restores with the column defaults, as it always did.
export const FixtureSnapshot = z.object({
  id: z.string(),
  stage_id: z.string().optional(),
  pool_id: z.string().nullable().optional(),
  round_no: z.number().int().optional(),
  seq_in_round: z.number().int().optional(),
  home_entrant_id: z.string().nullable().optional(),
  away_entrant_id: z.string().nullable().optional(),
  at: z.string().nullable().optional(),
  court: z.string().nullable().optional(),
  locked: z.boolean().optional(),
  schedule_source: z.string().optional(),
  fixture_no: z.number().int().optional(),
  ext_key: z.string().nullable().optional(),
  lane: z.string().nullable().optional(),
  is_final: z.boolean().optional(),
  third_place: z.boolean().optional(),
  conditional: z.boolean().optional(),
  home_slot_label: JsonObject.nullable().optional(),
  away_slot_label: JsonObject.nullable().optional(),
  winner_to_fixture: z.string().nullable().optional(),
  winner_to_slot: z.number().int().nullable().optional(),
  loser_to_fixture: z.string().nullable().optional(),
  loser_to_slot: z.number().int().nullable().optional(),
  /** The row's status when snapshotted; restored, with `outcome`, only on a
   *  row that carried no score events (`restoreFixtures`). */
  status: z.string().optional(),
  outcome: JsonObject.nullable().optional(),
  /** Did the row carry score events? They cascade away with the delete. */
  scored: z.boolean().optional(),
  /** When the row entered the finished set (V430). Restored with `status` /
   *  `outcome`, on an unscored row only; V430's insert trigger keeps a supplied
   *  stamp and stamps now() when there is none (an older snapshot). */
  finished_at: z.string().nullable().optional(),
});
export type FixtureSnapshot = z.infer<typeof FixtureSnapshot>;

// Scoped clear (Jul3/03 §5) — mirrors the generation filters (4 Jul ask).
export const ClearScope = z.object({
  stageId: z.string().optional(),
  poolIds: z.array(z.string()).optional(),
  rounds: z.array(z.number().int()).optional(),
  courts: z.array(z.string()).optional(),
  excludeLocked: z.boolean().default(true),
});
export type ClearScope = z.infer<typeof ClearScope>;

// What clearSchedule needs to know about a fixture to decide scope membership.
export interface ClearableFixture {
  id: string;
  stageId: string;
  poolId: string | null;
  roundNo: number | null;
  court: string | null;
  at: string | null;
  locked: boolean;
  decided: boolean;
}
