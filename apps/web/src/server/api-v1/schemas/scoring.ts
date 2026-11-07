// /api/v1 contracts — Fixture read model, competition desk, lineups, score events (append/import), fixture state, API keys, device links, scorer sheets.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
import { FIXTURE_STATUSES } from "../../../lib/fixture-status.ts";
import { Uuid, CourtId, VenueId, ApiKeyScope } from "./common.ts";
import { EligibilityOverride } from "./divisions.ts";

/** D4a (P5) i18n pattern ref for a not-yet-filled slot — {key, params}, never
 *  a prebuilt string. Named rather than inlined because THREE published
 *  schemas carry it (Fixture, AssignedFixture) and a per-schema copy is how
 *  two shapes of the same field drift apart. */
export const SlotLabelRef = z
  .object({ key: z.string(), params: z.record(z.string(), z.unknown()) })
  .nullable();

export const Fixture = z.object({
  id: Uuid,
  stage_id: Uuid,
  division_id: Uuid,
  pool_id: Uuid.nullable(),
  round_no: z.number().int(),
  seq_in_round: z.number().int(),
  /** Per-division ordinal (PROMPT-30) — the `/f/{no}` public URL segment.
   *  Declared here because it is already SERVED: `FIXTURE_COLS` selects it and
   *  every fixture route returns its row unmapped. Nothing applies a response
   *  schema at runtime, so its absence was a silent gap between the published
   *  spec and the real payload rather than a missing field. */
  fixture_no: z.number().int(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  /** D4a (P5): i18n pattern ref for a not-yet-filled slot ("Winner Group A"),
   *  {key, params} — never a prebuilt string. Cleared on fill (design's Fill
   *  algorithm step 4); non-null only while the matching *_entrant_id is null. */
  home_slot_label: SlotLabelRef,
  away_slot_label: SlotLabelRef,
  scheduled_at: z.string().nullable(),
  // P9 pass 3c-2: court_id/venue_id + derived, read-only court_name/
  // venue_name — same shape as ScheduleAssignment. The frozen `venue`/
  // `court_label` text columns leave the wire entirely here (unlike the
  // general internal FixtureRow, which keeps them for callers not yet
  // migrated): this is the published v1 API contract, the highest-visibility
  // reader, and the one place P9 makes a clean break rather than adding
  // alongside. A client still reading `court_label` off this response
  // needs to move to `court_name` — there is no compatibility shim.
  court_id: CourtId.nullable(),
  court_name: z.string().nullable(),
  venue_id: VenueId.nullable(),
  venue_name: z.string().nullable(),
  officials: z.array(z.unknown()),
  // W2a: every fixtures.status value, `needs_decision` included (spec §5.4.6; plan finding 8).
  status: z.enum(FIXTURE_STATUSES),
  outcome: z.unknown().nullable(),
  schedule_source: z.enum(["none", "auto", "manual", "ai"]),
  schedule_locked: z.boolean(),
  created_at: z.string(),
  /** F1 (2026-08-17): the engine's bracket-position role, persisted instead
   *  of re-derived per consumer (V374/V369). Declared here for the same
   *  reason as `fixture_no` above — `FIXTURE_COLS` now selects it and every
   *  fixture route returns its row unmapped, so leaving it undocumented
   *  would be a silent gap between the published spec and the real
   *  payload, not a missing field. `.optional()`, unlike `fixture_no`: a
   *  real response always sends it, but dozens of pre-existing tests
   *  `Fixture.parse()` a hand-built row literal that predates these five
   *  fields, and `.optional()` is this schema's own established way of
   *  landing a new response field without breaking every one of them
   *  (see ScheduleSolverInfo's later fields for the same convention). */
  ext_key: z.string().nullable().optional(),
  lane: z.enum(["WB", "LB", "GF"]).nullable().optional(),
  is_final: z.boolean().optional(),
  third_place: z.boolean().optional(),
  conditional: z.boolean().optional(),
  /** W4 B5b (X-CH-4; V499): when the organiser ruled this unplayed final JOINT WINNERS - an ISO instant, else null. The
   *  final is stored `decided` with NO `outcome`, so this is the one field that says why a decided match names no winner
   *  (and the one the console reads to offer Undo). `.optional()` for the reason `ext_key` is: dozens of tests parse a
   *  hand-built row that predates the column. */
  joint_winners_at: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Competition desk (W3 Task 6): the in-play band's producer, served bare by
// GET /competitions/{id}/desk (usecases/competition-desk.ts's
// `getCompetitionDesk`, "one shape, two doors" — the SSR page reads the same
// function directly). Mirrors that module's exported interfaces field for
// field.
// ---------------------------------------------------------------------------

export const DeskInPlayFixture = z.object({
  id: Uuid,
  division_id: Uuid,
  division_name: z.string(),
  home: z.string().nullable(),
  away: z.string().nullable(),
  fixture_no: z.number().int(),
  event_count: z.number().int(),
  started_at: z.string().nullable(),
});

/** competition-desk.ts's `DeskNextFixture` (`Omit<NextFixture, "court_label">`) —
 *  no existing schema to reuse: `NextFixture` (card-stats.ts) has never
 *  crossed the wire before this route. */
export const DeskNextFixture = z.object({
  home: z.string().nullable(),
  away: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  in_play: z.boolean(),
});

export const CompetitionDesk = z.object({
  in_play: z.number().int(),
  // Ordered by kickoff ascending, nulls last — see getCompetitionDesk. The
  // SAME rows `in_play` above counts: `in_play === in_play_fixtures.length`
  // always (competition-desk.test.ts's Task 6 case pins this).
  in_play_fixtures: z.array(DeskInPlayFixture),
  up_next: DeskNextFixture.nullable(),
  // Match Day B1: how many of the competition's matches are today, each on its own division's day, plus any in play — Match
  // Day's own count (`countFixturesToday`). Above zero, the competition is on its match day.
  fixtures_today: z.number().int().nonnegative(),
  // The usecase's own type is `Map<string, DeskDivision>` — a bare Map
  // serialises to `{}` over JSON (no own enumerable properties), so the
  // route converts it with `Object.fromEntries` before this schema ever
  // sees it. Left loosely typed rather than a full `DeskDivision` mirror:
  // no consumer of this wire contract reads inside `divisions` yet (the W3
  // band, retired by Match Day B1, read only in_play/in_play_fixtures/up_next), and DeskDivision's
  // own shape (division-phase.ts's `Attention` discriminated union, etc.)
  // has no established Zod schema to reuse — inventing one is out of this
  // task's scope.
  divisions: z.record(z.string(), z.unknown()),
  now: z.string(),
});

export const LineupSlotInput = z.object({
  person_id: Uuid,
  slot: z.enum(["starting", "bench"]).default("starting"),
  position_key: z.string().nullish(),
  order_no: z.number().int().min(1).nullish(),
  roles: z.array(z.string()).default([]),
  // S4 (#428) review round 1, finding 1 — V357. Mirrors LineupSlot.role
  // exactly. `.optional()`, NOT `.default()` — a `.default()` makes `role`
  // a REQUIRED key on the inferred `PutLineup` TS type, which would break
  // every existing caller that constructs a slots array without it
  // (`putLineup` is called directly, bypassing this schema, by
  // `usecases/__tests__/_seed.ts`-style test helpers and possibly future
  // internal callers — the same "who parses vs. who just gets the TS type"
  // seam `reference_usecase_vs_schema_seam` names elsewhere). The usecase
  // (`fixtures.ts`) falls back to `"player"` at the SQL boundary instead,
  // the same `?? default` idiom `position_key`/`order_no` already use on
  // the line above.
  role: z.enum(["player", "coach", "staff"]).optional(),
  // S12/#421 pass D — V361. Mirrors LineupSlot.pairOrder exactly (which of a
  // pair entrant's two bound members serves/plays first). `.nullish()`, the
  // same convention `order_no` already uses one line up: it stays optional
  // on the inferred PutLineup TS type (never required), and an explicit
  // `null` is a valid "no declared order" alongside an omitted key.
  pair_order: z.number().int().positive().nullish(),
});

export const PutLineup = z.object({
  slots: z.array(LineupSlotInput).max(100),
  // RS011: see CreateEntrant's field of the same name — a lineup can name a
  // person who was never gated at roster time (a pre-feature roster).
  eligibility_override: EligibilityOverride.optional(),
});
export type PutLineup = z.infer<typeof PutLineup>;

/** THE scoring request (doc 08 §4). */
export const AppendEventRequest = z.object({
  // Bounded to int4, the type of `score_events.seq` (V216): usecases/scoring.ts compares it with that column in SQL, where a
  // larger value made Postgres raise "out of range" (a 500). Past the bound it is a 400 at the door (W2e M1).
  expected_seq: z.number().int().min(0).max(2_147_483_647),
  type: z.string().min(1).max(100), // 'cricket.ball', 'core.void', …
  payload: z.unknown(),
  idempotency_key: z.string().min(1).max(200).optional(),
  // Engine-split D26/D31. Optional on purpose: the server cannot tell a capture phone from the web pad (both use the same `dl_`
  // device link), so a missing value is never a refusal. Lower than `foldEpochOf(sport)` → 426 ENGINE_OUTDATED (usecases/scoring.ts).
  engine_epoch: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Fold epoch of the client's engine for this fixture's sport (engine-split D26/D31). Native clients send it; the web pad does not.",
    ),
  /** W2c Task 15 (X-SR-7, owner P-1) — the match's rules version the sender scores under (`GET /fixtures/{id}/rules`,
   *  or the last accepted answer's). Sent, it must be the match's: a correction since refuses the tap, 409
   *  FIXTURE_RULES_CHANGED, before anything is written. Omitted, it is never checked (a console, an integration). */
  rules_version: z.number().int().min(0).optional(),
});
export type AppendEventRequest = z.infer<typeof AppendEventRequest>;

/** P11 (D6) batch score-event import. `seq` is assigned server-side 1..n,
 *  gapless — a caller never sends one. (This said "0..n" until 2026-09-02; the
 *  implementation has always assigned `seq: i + 1` from the array index —
 *  `usecases/event-import.ts:289`, whose own comment at :282 correctly says
 *  "seq 1..n, gapless". Corrected because an offline replayer that mints
 *  0-based seq from this comment would disagree with the write path about
 *  event identity.) `core.void` is refused here rather than downstream:
 *  a void is a live-scoring undo, and a wrong import is re-run under a new
 *  import_id (owner ruling R2). */
export const EventImportRequest = z.object({
  import_id: z.string().min(1).max(200),
  streams: z.array(
    z.object({
      fixture: z.union([
        z.object({ id: z.uuid() }),
        z.object({ ext_key: z.string().min(1).max(200) }),
      ]),
      events: z.array(
        z.object({
          // `.max(100)` mirrors `AppendEventRequest.type` above, and is not
          // decoration. It was the one unbounded string in this request, in
          // the shape that carries up to `IMPORT_CAPS.eventsPerCall` (10,000)
          // of them per body — so the BATCH door stood wider than the
          // single-append door it batches. Nothing downstream narrows it
          // either: `score_events.type` is `text`, and a type the engine does
          // not know is refused by VALUE, at the fold, after the whole string
          // has travelled through resolution and into the report. The two
          // bounds are pinned equal by `schemas.test.ts`, so a change to one
          // that forgets the other is a red rather than a silent re-widening.
          type: z.string().min(1).max(100).refine((t) => t !== "core.void", {
            message: "core.void cannot be imported",
          }),
          payload: z.record(z.string(), z.unknown()).default({}),
          // A real ISO-8601 INSTANT, the same idiom every other timestamp in
          // this file uses. Not decoration: `at` lands in a `timestamptz`
          // column, the engine's own envelope only asks `.min(1)`, and the
          // dry-run fold never touches it — so a malformed value used to
          // survive every guard and raise Postgres 22007 inside the write
          // transaction, which is neither a unique violation nor an
          // EngineError and therefore rethrew as a 500, discarding the report
          // for streams that had already committed.
          at: z.iso.datetime({ offset: true }).optional(),
        }),
      ).min(1),
    }),
  ).min(1),
});
export type EventImportRequest = z.infer<typeof EventImportRequest>;

export const EventImportReport = z.object({
  importId: z.string(),
  totals: z.object({ imported: z.number(), skipped: z.number(), rejected: z.number() }),
  results: z.array(
    z.object({
      fixture: z.string(),
      status: z.enum(["imported", "skipped_duplicate", "rejected"]),
      eventsAppended: z.number(),
      outcome: z.unknown().optional(),
      error: z.object({ code: z.string() }).loose().optional(),
    }),
  ),
});

export const ScoreEvent = z.object({
  id: Uuid,
  seq: z.number().int(),
  type: z.string(),
  payload: z.unknown(),
  recorded_at: z.string(),
  recorded_by: Uuid.nullable(),
  voids_event_id: Uuid.nullable(),
  /** Doc 13 §7: set when the event arrived via a day-of device link. */
  device_link_id: Uuid.nullable(),
});

export const AppendEventResponse = z.object({
  seq: z.number().int(),
  state_summary: z.unknown(),
  outcome: z.unknown().nullable(),
  status: z.string(),
  /** The id of the row this append wrote (on an idempotent replay, the row the
   *  original append wrote) — the same id `GET /events` reports for it and a
   *  `core.void`'s `event_id` names. Lets a client hold the event under the
   *  server's id from the moment it lands. */
  event_id: Uuid,
  /** W2c Task 15 (X-SR-7) — the match's rules version this answer saw (on a replay, the version now). Higher than the
   *  one the client sent ⇒ the format was corrected: reload it (`GET /fixtures/{id}/rules`) before the next append. */
  rules_version: z.number().int().min(0),
});

export const FixtureState = z.object({
  fixture_id: Uuid,
  status: z.string(),
  last_seq: z.number().int(),
  summary: z.unknown(),
  state: z.unknown(),
  outcome: z.unknown().nullable(),
});

export const StandingsRowOut = z.object({
  entrantId: z.string(),
  rank: z.number().int(),
  played: z.number().optional(),
  points: z.number().optional(),
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const CreateApiKey = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScope).min(1).default(["read"]),
  /** Optional pin: the key only works inside this competition (v3/08 §2). */
  competition_id: Uuid.nullish(),
});
export type CreateApiKey = z.infer<typeof CreateApiKey>;

export const ApiKey = z.object({
  id: Uuid,
  name: z.string(),
  scopes: z.array(ApiKeyScope),
  competition_id: Uuid.nullable(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export const CreatedApiKey = ApiKey.extend({
  /** The sc_ secret — returned exactly once, at creation. */
  secret: z.string(),
});

// ---------------------------------------------------------------------------
// Device links (doc 13 §7, PROMPT-21)
// ---------------------------------------------------------------------------

export const CreateDeviceLink = z.object({
  /** 'Court 3 phone' — organiser-facing label, optional. */
  label: z.string().min(1).max(100).nullish(),
});
export type CreateDeviceLink = z.infer<typeof CreateDeviceLink>;

export const DeviceLink = z.object({
  id: Uuid,
  fixture_id: Uuid,
  label: z.string().nullable(),
  issued_by: Uuid,
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export const CreatedDeviceLink = DeviceLink.extend({
  /** The dl_ secret. Re-shown unchanged by ensure (sealed, scorer sheets §4.1); replaced only by reissue. QR payload = /score/{secret}. */
  secret: z.string(),
});

/** A Match Day code's scope (capture S4 design §3; MD-1): the whole competition (matches with no court included), one
 *  venue's courts, or exactly these courts. */
export const MatchDayCodeScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("competition") }),
  z.object({ kind: z.literal("venue"), venue_id: Uuid }),
  z.object({ kind: z.literal("courts"), court_ids: z.array(Uuid).min(1).max(200) }),
]);
export type MatchDayCodeScope = z.infer<typeof MatchDayCodeScope>;

/** POST /competitions/{id}/match-day-codes: mint a Match Day code (editor session only). */
export const CreateMatchDayCode = z.object({
  scope: MatchDayCodeScope,
  /** `YYYY-MM-DD`, the day the code opens, on the competition's clock. Omitted = today there. */
  day: z.iso.date().optional(),
  /** "Can approve draws": off unless ticked. */
  can_approve: z.boolean().default(false),
});
export type CreateMatchDayCode = z.infer<typeof CreateMatchDayCode>;

/** A Match Day code on the desk. `url` is the QR's payload, `{origin}/day/md_…`: a credential, shown to the editor who
 *  manages it and to nobody else. `opens_at` / `expires_at` are 00:00 and 24:00 of `day` in the competition's zone. */
export const MatchDayCode = z.object({
  id: Uuid,
  url: z.string(),
  scope: MatchDayCodeScope,
  day: z.iso.date(),
  opens_at: z.string(),
  expires_at: z.string(),
  can_approve: z.boolean(),
});
export type MatchDayCode = z.infer<typeof MatchDayCode>;

/** POST /competitions/{id}/exports/scorer-sheets (scorer sheets §4.4). */
export const ScorerSheetsRequest = z
  .object({
    /** One day to print, `YYYY-MM-DD` on the organisation's clock. */
    date: z.iso.date().optional(),
    /** Or a range (inclusive, either end optional). With `divisionId`, no date at all = every scheduled day. */
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    /** Narrow the sheet to one division of the competition. Omitted = every division. */
    divisionId: z.uuid().optional(),
    /** Page runs: by court (default), or by division with the court printed on each card. */
    groupBy: z.enum(["court", "division"]).optional(),
  })
  .refine((v) => v.date === undefined || (v.dateFrom === undefined && v.dateTo === undefined), {
    message: "date and dateFrom/dateTo are exclusive",
  })
  .refine((v) => v.divisionId !== undefined || v.groupBy === "division" || v.date !== undefined, {
    message: "date is required unless divisionId is given or groupBy is division",
  });
