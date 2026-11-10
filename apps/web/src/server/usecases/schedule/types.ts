import type postgres from "postgres";
import type { Assignment } from "@seazn/engine/scheduling";
import type { ScheduleConfig } from "@/server/api-v1/schemas";

export type Tx = postgres.TransactionSql;

/** The INTERNAL settings object. Its two zones are deliberately NOT one letter
 *  apart: `displayTz` vs `orgTz` reads as a choice, `tz` vs `orgTz` reads as a
 *  typo, and #448 was exactly that typo shipped. Anything doing calendar-day
 *  math wants `orgTz`; anything rendering a timestamp wants `displayTz`.
 *
 *  This is NOT the wire shape — see `ScheduleSettingsWire`. */
export interface ScheduleSettingsOut {
  division_id: string;
  config: ScheduleConfig;
  /** RESOLVED venue zone (V305): stored division tz → org timezone → 'UTC'.
   *  DISPLAY ONLY. Never use it to decide which calendar day something is on. */
  displayTz: string;
  /** The ORGANISATION zone, resolved independently of the division's own (#397).
   *  W2 makes this the one clock all temporal math runs in — day boundaries,
   *  weekday targets, session hours, output offsets — while `displayTz` above
   *  stays the display lane a division may override. */
  orgTz: string;
  updated_at: string;
}

export interface FixtureLite {
  id: string;
  stage_id: string;
  division_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** W4 T3 (K2): read with the seats, ext_key and status by `isByeLine` (via `isMovable`/`heldInPlace`) — a bracket's
   *  bye line is told by its outcome and the bye slot label on its empty side. */
  outcome: unknown;
  home_slot_label: unknown;
  away_slot_label: unknown;
  scheduled_at: string | Date | null;
  /** P9 pass 3a (venues/courts cutover): the REAL identity now — every
   *  "does this fixture have a placed court/is it occupying one" question
   *  reads THIS, never `court_label` below. `toAssignment` feeds it straight
   *  into the engine's `Assignment.court` (a pure representation swap — the
   *  scheduling lattice has always treated `court` as an opaque string, see
   *  court-id-lattice-equivalence.test.ts). */
  court_id: string | null;
  venue_id: string | null;
  /** LEGACY, read-only. Nothing writes it any more (`moveFixture`/
   *  `applySchedule` stopped, per the owner's FULL-cutover ruling) — frozen
   *  at whatever value each fixture already carried when that pass shipped.
   *  `scopeLocked` below matched on this column through pass 3a; P9
   *  pass-3a-FIX migrated `locked_scopes` to real ids (V374, third block) and
   *  switched the match to `court_id` above, so this field has no remaining
   *  reader. Do NOT use for anything else. */
  court_label: string | null;
  /** LEGACY, read-only — same reasoning as `court_label` above. */
  venue: string | null;
  status: string;
  schedule_locked: boolean;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
}

/** What a round sequence's rows carry beside `roundNo` (all three optional on the engine's `Assignment` and
 *  `SchedulableFixture`). `{}` for a start-floor sequence. */
export type RoundFields = Pick<Assignment, "roundBarrier" | "roundGapMinutes" | "roundsPerDayCap">;

/** The round-sequence stages a producer asks about: the Map {@link roundRobinStageIds} returns, or (a caller that only
 *  needs the ordering, not the fields) a bare id set. */
export type RoundSequenceStages = ReadonlyMap<string, RoundFields> | ReadonlySet<string>;
