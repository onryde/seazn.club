// Shared shapes for the v3 schedule board (v3/04 §2). The server pages feed
// these straight from the usecases; everything client-side derives from them.

import type { FeedLabelPair } from "@/lib/schedule-board";
import { msg } from "@/lib/messages";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

export interface BoardDivision {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** Optimistic-concurrency token (v3/11 gap 10): divisions.seq at render. */
  seq: number;
  /** Whole-division freeze (Jul3/03 §4) — every schedule edit 422s while on. */
  schedule_locked?: boolean;
}

export interface BoardStage {
  id: string;
  division_id: string;
  seq: number;
  kind: string;
  name: string;
  status: string;
}

export interface BoardFixture {
  id: string;
  stage_id: string;
  division_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** D4b (P6) — {key, params} i18n pattern ref while the matching
   *  *_entrant_id is null (V360's fixtures.home/away_slot_label). */
  home_slot_label?: SlotLabel | null;
  away_slot_label?: SlotLabel | null;
  /** ISO string over the wire, Date when it crosses straight from an RSC. */
  scheduled_at: string | Date | null;
  /** LEGACY and OPTIONAL. Frozen since the P9 cutover — nothing writes them,
   *  and the board query stopped SENDING them (identity only; six court/venue
   *  fields per row is what blew the RSC payload budget). Kept on the type,
   *  optional, because non-board callers still pass richer rows and
   *  `courtDisplayName` keeps them as a last-resort fallback for a
   *  pre-cutover fixture whose court string never mapped to a real court. */
  venue?: string | null;
  court_label?: string | null;
  /** P9 pass 4a: the fixture's REAL court identity — `court_label` above is
   *  frozen legacy (null for anything scheduled since the cutover). Every
   *  column/scope/swap comparison must key on this, never on `court_label`.
   *  Mirrors `FixtureRow.court_id`/`court_name` (stages.ts). */
  court_id: string | null;
  /** DERIVED display name for `court_id` — never render `court_id` itself
   *  (a raw uuid) to an organiser. Falls back to `court_label` at the render
   *  site while no lookup populates this (purely additive; see court_id). */
  /** OPTIONAL: the board resolves this client-side from the venues prop
   *  (`resolveCourtNames`), so the server no longer ships it per row. */
  court_name?: string | null;
  status: string;
  schedule_source: string;
  schedule_locked: boolean;
  outcome: unknown;
  /** Bracket position flags (V368) — the inputs `roundRole()` reads for the
   *  card's knockout round code (board/round-codes.ts). OPTIONAL and sent only
   *  when they say something (`listDivisionFixturesForBoard`): absent means
   *  the column default — lane null, flag false — which is every round-robin
   *  row, so a league board pays no bytes for them.
   *
   *  `is_final` is sent (when true) for a different reason: `roundRole()`
   *  never reads it, but it is the PRESENCE test for all four columns. V368
   *  added them with no backfill, so a stage generated before it has every row
   *  at the defaults — and every stage generated since flags its final (the
   *  single-elimination final, the grand-final games, a stepladder's last
   *  game). A knockout, double-elimination or stepladder stage with no
   *  `is_final` row is therefore a legacy one, and keeps its plain R{n}
   *  (review M2 — board/round-codes.ts `hasRoleMetadata`). A page playoff is
   *  the exception: it is named by its `ext_key` alone and needs no
   *  `is_final`. One key per bracket, not per row. */
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
  /** The generator's stable id — sent ONLY on a page-playoff row (a `pp-*`
   *  key: "pp-q1", "pp-elim", "pp-q2", "pp-final"; board playoff codes,
   *  2026-09-23). It is the one thing that tells Qualifier 1 from the
   *  Eliminator: they share a round, a match count and every flag. Every other
   *  row omits it, so the budget board pays nothing for it. (`| null` only so a
   *  full `FixtureRow` still satisfies this shape; the board read never sends
   *  one.) */
  ext_key?: string | null;
  /** A `scheduled` row that holds a result or scoring — a start taken back, a
   *  walkover recorded in play (`fixtureHasResultSql`, server side). Every
   *  board write refuses to move or pin it, so the board offers neither
   *  (review 4 of #857). Sent only when true (`listDivisionFixturesForBoard`);
   *  any other status already says it is not movable. */
  held?: boolean;
}

/** Whether the board may move or pin this card: `scheduled`, and holding no
 *  result (`held`). The server refuses the rest (schedule.ts `isMovable`). */
export function boardMovable(f: Pick<BoardFixture, "status" | "held">): boolean {
  return f.status === "scheduled" && f.held !== true;
}

export interface BoardConfig {
  startAt?: string | null;
  endAt?: string | null;
  matchMinutes: number;
  gapMinutes: number;
  courts: string[];
  perEntrantMinRest: number;
  blackouts: { court?: string; from: string; to: string }[];
  sessionWindows: { from: string; to: string }[];
  roundMinutes?: number | null;
  /** Present on the wire and in `schedule_settings.config` all along — one GET
   *  serves this object to BOTH the Settings panel and the Constraints panel —
   *  but never declared here, so the Settings tab could not see the three other
   *  controls that raise its own rest floor. Optional, because the board's own
   *  callers build a `BoardConfig` without one and a missing constraints block
   *  means "no extra rule", which is what `restFloor` already assumes.
   *
   *  Structural rather than `SchedulingConstraints`: only the rest-bearing
   *  fields are read here, and importing the zod-inferred type would pull the
   *  scheduling barrel — and the solvers behind it — into this client bundle. */
  constraints?: {
    restMin?: number;
    restByGroup?: Record<string, number>;
    noBackToBack?: boolean;
  };
}

/** Snake_case wire mirror of the engine's `ConflictDetail`
 *  (`packages/engine/src/scheduling/conflict-detail.ts`), matching
 *  `ScheduleConflictDetail` in server/api-v1/schemas.ts field for field.
 *  Structural rather than the zod-inferred type or an engine import (C3,
 *  2026-08-13 design amendment) — same reason `BoardConfig.constraints` is
 *  hand-declared rather than importing `SchedulingConstraints` just above:
 *  this module stays a pure shapes file. `kind` stays plain `string` here
 *  (not `ConflictDetailKind`) so this file needn't know the engine's type;
 *  `conflict-detail-format.ts` is the one place that narrows it and is
 *  exhaustive over every kind. */
export interface BoardConflictDetail {
  kind: string;
  entrant_ids?: string[];
  person_ids?: string[];
  other_fixture_id?: string;
  court?: string;
  /** P9 review wave 3, finding #3: the server's resolved, venue-qualified
   *  display name for `court` (schemas.ts's ScheduleConflictDetail.court_name,
   *  via courtNamesById -> buildCourtDirectory — see toWireConflictDetail).
   *  `court` itself is a raw `courts.id` uuid for every kind that carries it
   *  (court_double_booking, locked_slot_clash, court_tag_mismatch) and must
   *  never render directly — conflict-detail-format.ts is the one place that
   *  reads this field, and degrades a miss to courtPicker.unknownCourt. */
  court_name?: string;
  day?: string;
  other_day?: string;
  weekday?: string;
  required_weekday?: string;
  required_date?: string;
  time?: string;
  required_time?: string;
  rule_type?: string;
  round_no?: number;
  other_round_no?: number;
  minutes?: number;
  required_minutes?: number;
  count?: number;
  required_count?: number;
}

export interface BoardConflict {
  fixture_id: string;
  code: string;
  blocking: boolean;
  /** @deprecated Pre-C3 English, derived server-side (byte-for-byte) from
   *  `details` — kept only for any remaining reader of raw prose. New code
   *  should read `details` and format via `conflict-detail-format.ts`. */
  detail?: string;
  /** Structured, id-only conflict detail (C3, 2026-08-13 design amendment).
   *  Additive: absent only for a conflict the engine built without a
   *  `details` entry (there should be none — every family template sets one
   *  — but the field stays optional to match the wire's own `.optional()`). */
  details?: BoardConflictDetail;
}

export const CONFLICT_LABEL: Record<string, string> = {
  "conflict.court": "court clash",
  "conflict.start_window": "outside a start window",
  "warn.rest": "rest",
  "warn.person_overlap": "person overlap",
  "warn.order": "plays before feeder",
  "warn.blackout": "blackout",
  "warn.window": "outside dates",
  "warn.instruction": "breaks your instruction",
  "warn.no_slot": "no slot",
  "warn.official_declined": "umpire declined",
  "warn.official_unavailable": "umpire unavailable",
};

// Plain-English explanations shown to organisers (no codes, no UUIDs) — the
// generic, code-level fallback when a conflict carries no structured
// `details`, or `board.conflictHelp.<code>` is missing from the active
// locale. The per-conflict specifics (names, courts, times) are never
// hand-rolled prose: they come from `details` via
// `conflict-detail-format.ts`, localized and name-resolved at render time,
// so nothing shown to an organiser is ever a raw code or a UUID (C3,
// 2026-08-13 design amendment).
export const CONFLICT_HELP: Record<string, string> = {
  "conflict.court": "Two matches would use the same court at the same time.",
  "conflict.start_window":
    "This match starts outside a start window set for one of its entrants, its pool or its division.",
  "warn.rest": "There isn't enough rest between matches for a team or player.",
  "warn.person_overlap": "Someone would be playing in two matches at once.",
  "warn.order": "This match feeds a later one, so it can't start before the earlier match finishes.",
  "warn.blackout": "This time falls inside a blackout period.",
  "warn.window":
    "This match falls outside the dates the competition runs — change the schedule dates in Settings, or move the match inside them.",
  "warn.instruction":
    "This match breaks a rule from your scheduling instruction — such as a limit on matches per day, or a match you asked to be played on a particular day.",
  "warn.no_slot": "There's no free slot for this match at that time.",
  "warn.official_declined": "An assigned official has declined — re-assign this match.",
  "warn.official_unavailable": "An assigned official is unavailable at this time.",
};

/**
 * P9 pass 4a item 3: the court text to show an organiser for a fixture.
 * Resolved NAME first, the frozen legacy label as a fallback (a pre-cutover
 * fixture's court_label is still a real, human-readable string — never
 * cleared), and NEVER `court_id` itself, which is a raw uuid. Null — not ""
 * — when neither is known, so a caller can tell "no court text" from "an
 * empty string" and choose its own placeholder rather than silently
 * rendering a blank slot where a court label used to be.
 *
 * P9 pass 4d: an optional `courtNames` id -> venue-qualified-label map
 * (schedule-board.tsx's `courtNamesById`, built via `resolveCourtNames` —
 * the SAME "Name (Venue)" rule the AI pack applies) takes priority over the
 * fixture's own bare `court_name` whenever `f.court_id` resolves in it, so
 * two courts sharing a name in different venues never render the identical
 * caption. `court_id` is optional on the Pick (not required) so every
 * pre-existing call site that never carried it keeps typechecking
 * unchanged; omitting `courtNames` keeps this function's original
 * behaviour byte-for-byte.
 */
export function courtDisplayName(
  f: Pick<BoardFixture, "court_name" | "court_label"> & Partial<Pick<BoardFixture, "court_id">>,
  courtNames?: Record<string, string>,
): string | null {
  if (f.court_id != null && courtNames?.[f.court_id] !== undefined) return courtNames[f.court_id];
  return f.court_name ?? f.court_label ?? null;
}

export function cardTitle(
  f: BoardFixture,
  names: Record<string, string>,
  feeds: Record<string, FeedLabelPair>,
  // `feeds` is a SEPARATE, pre-existing scheduling-feed data source (built in
  // schedule/page.tsx from winner_to_fixture/winner_to_slot, out of this
  // task's file set) — that data source is untouched. Its SHAPE is not: as of
  // P7/F1, `feeds[f.id]?.home`/`.away` are `SlotLabel` objects (same
  // {key,params} shape as `home_slot_label`), so both go through
  // resolveSlotLabel() below — one composition point instead of two, which is
  // what stops the feed's ref text and the card's own short code from
  // rendering the same match in two different formats. `feeds` still wins
  // when both are present: `home_slot_label` is only consulted once `feeds`
  // has nothing. `lookup` defaults to the client-safe English msg(); pass
  // useMsg()'s bound fn from a caller that already sits inside a
  // <DictProvider> for real localization (schedule-board.tsx's card render
  // does; consoleFixtures() below is a plain exported function with no hook
  // context, so it stays on the default).
  lookup: SlotLabelLookup = msg,
): string {
  const home = f.home_entrant_id
    ? (names[f.home_entrant_id] ?? "?")
    : resolveSlotLabel(feeds[f.id]?.home ?? f.home_slot_label ?? null, lookup, "schedule.tbd");
  const away = f.away_entrant_id
    ? (names[f.away_entrant_id] ?? "?")
    : resolveSlotLabel(feeds[f.id]?.away ?? f.away_slot_label ?? null, lookup, "schedule.tbd");
  return `${home} vs ${away}`;
}

/** One proposal block painted over the grid while an AI proposal is on screen
 *  (v4 Task 13, design/v4/02 §3). Positioned by the PROPOSED slot (`at`/`court`),
 *  not the fixture's current one; `tone` is its state-palette bucket. The block
 *  shows code + JR/Final marker + matchup + time only — move provenance lives in
 *  the diff list, never here. */
export interface GhostBlock {
  id: string;
  code: string;
  matchup: string;
  isFinal: boolean;
  isJunior: boolean;
  /** Proposed kick-off, epoch ms. */
  at: number;
  /** Proposed court (null → unassigned column). */
  court: string | null;
  tone: "moved" | "placed" | "unchanged" | "blocking";
  /** Referee just flagged this fixture — pulse red for ~1.5s (§0.3). */
  pulse?: boolean;
  /** The owning division, on a JOINT (multi-division) proposal only (#350).
   *  `null` on a single-division one, where every block would carry the same
   *  name and the label would say nothing. */
  division?: { id: string; name: string } | null;
}

/** Board density modes (v3/04 §2). Week view lives inside Board mode — the
 *  cross-day drag affordance predates v3 and stays (no regression). */
export type Density = "board" | "agenda" | "lanes";

export const DENSITY_STORAGE_KEY = "seazn:board:density";

/** The single "Unassigned venue" fallback column label (v3/04 §2) — a
 *  sentinel, never persisted: placing here writes court_label = null. */
export const UNASSIGNED = " unassigned";

/**
 * One division's outcome from the COMPETITION-wide publish
 * (`POST /api/v1/competitions/{id}/schedule/publish`, the board slice of the
 * "Publish all" work). Only divisions at `status === "setup"` are reported —
 * a division already past setup is not a failure to explain, it is simply not
 * part of the question.
 *
 * Snake_case wire mirror, hand-declared for the same reason `BoardConflict`
 * and `BoardConfig.constraints` above are: this stays a pure shapes file that
 * a client bundle can import without dragging `server/api-v1/schemas.ts` (and
 * therefore zod + the usecases) behind it.
 */
export interface PublishAllDivisionResult {
  division_id: string;
  name: string;
  published: boolean;
  /** Absent when `published` is true. `blocking: false` is the ONLY shape that
   *  `acknowledge_warnings: true` can clear — same asymmetry as the
   *  single-division gate, and derived from the CODE server-side, never
   *  recomputed from the conflict rows. */
  refusal?: { code: string; blocking: boolean; conflicts: BoardConflict[] };
}

export interface PublishAllOutcome {
  published: number;
  needs_acknowledgement: number;
  blocked: number;
  results: PublishAllDivisionResult[];
}
