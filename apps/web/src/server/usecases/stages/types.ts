import "server-only";
// The shapes and kind sets the stages modules share: row types and column
// lists, generated-fixture shapes, the Swiss/generate outcomes, roster-drift
// counts, and the table/bracket kind sets.

import type postgres from "postgres";
import type { SwissRoundsJudgement, SwissRoundsNotice, SwissRoundsShrunk } from "@/lib/swiss-rounds";
import type { SwissNextRound } from "@seazn/engine/scheduling";
import type { SwissPairingMode } from "@/lib/swiss-pairing";
import { z } from "zod";
import { CreateStage } from "@/server/api-v1/schemas";
import type { SlotLabel } from "../stage-seeding";

export type Tx = postgres.TransactionSql;

export type StageInput = z.infer<typeof CreateStage>;

export interface StageRow {
  id: string;
  division_id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  /** F2 — the union of the old `qualification` (auto-seed-on-complete) and
   *  `seeding` (propose/confirm-at-setup) columns; `null` for a stage with no
   *  upstream source (a division's first stage). `progression.timing`
   *  ("setup" | "on_complete") is the axis that used to be implicit in
   *  "which column is set" — see @seazn/engine/competition's ProgressionSpec
   *  and this session's F2 plan, Decision 1. */
  progression: Record<string, unknown> | null;
  status: string;
}

export const STAGE_COLS = ["id", "division_id", "seq", "kind", "name", "config", "progression", "status"] as const;

// P9 pass 3c-2: `court_id`/`venue_id` added as the real identity, documented
// here for parity with BOARD_FIXTURE_COLS below. The three `FIXTURE_COLS`
// readers in this file (and the two in usecases/fixtures.ts) no longer
// interpolate this array directly with `tx(FIXTURE_COLS)` — `court_name`/
// `venue_name` are DERIVED (left join courts/venues), which a flat
// unaliased column list can't express — so each of those selects is
// hand-written instead. This array stays the source-of-truth column list.
export const FIXTURE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round", "fixture_no",
  "home_entrant_id", "away_entrant_id", "home_slot_label", "away_slot_label",
  "scheduled_at", "venue", "court_label", "court_id", "venue_id",
  "officials", "status", "outcome", "schedule_source", "schedule_locked", "created_at",
  "ext_key", "lane", "is_final", "third_place", "conditional",
] as const;

/** F1 follow-up (2026-08-17, payload-budget regression — board-v3.spec.ts
 *  "gap 15" reds on PR #606, expect flightBytes-dictBytes < 250000, got
 *  279043): the schedule board (competition-wide AND single-division)
 *  never renders ext_key/lane/is_final/third_place/conditional — only the
 *  division page's bracket/stages panel does (StagesPanel/BracketPanel,
 *  fed by the full FIXTURE_COLS read via listDivisionFixtures above).
 *  Shipping those five columns to a board that reads none of them cost
 *  ~88 escaped bytes/fixture on the RSC flight — invisible on one
 *  division, ~29KB over budget at a 5-division x 66-fixture board.
 *  listDivisionFixturesForBoard (fixtures.ts) selects this instead.
 *  ext_key's exclusion isn't new scope creep, either — board/settings-
 *  panel.tsx already documented (pre-dating this branch) that "the page's
 *  fetched fixture list never carries ext_key" as a design invariant for
 *  its capacity precheck; this restores that invariant rather than
 *  breaking new ground. Same as FIXTURE_COLS minus those five columns —
 *  keep the two in sync by hand if FIXTURE_COLS's other columns change.
 *
 *  2026-09-23 (schedule-board knockout round codes): three of the five came
 *  back — `lane`, `third_place`, `conditional` are what the card's round code
 *  ("QF", "3rd", "WB2", "GF2") is computed from, and without `third_place` a
 *  bronze match reads as a second final. They are NOT back at the old cost:
 *  listDivisionFixturesForBoard puts each on a row only when it is not its
 *  column default, so a round-robin row (the budget board's whole population)
 *  carries none of them. `ext_key` stays out: it only serves page-playoff
 *  roles, which the board does not code.
 *
 *  Review M2 (same day): `is_final` came back too, on the same terms (sent
 *  only when true — one key per bracket). `roundRole()` never reads it; it is
 *  the presence test for all four V368 columns. A stage generated before V368
 *  has every row at the defaults, so a coded stage with no `is_final` row is a
 *  legacy one and keeps its plain R{n} rather than a guessed code.
 *
 *  Board playoff codes (same day, owner-approved): `ext_key` came back last,
 *  on the narrowest terms — sent only when it is a page-playoff key (`pp-*`),
 *  four per page playoff, because it is the only thing that tells Qualifier 1
 *  from the Eliminator. Every other row's generator id stays off the board;
 *  the capacity precheck (board/settings-panel.tsx) still reads none. */
/** P9: what the BOARD actually receives — identity, no derived names and no
 *  frozen legacy text. The board resolves display names client-side from the
 *  venues prop; sending them per row duplicated ~330 rows' worth of bytes.
 *  Distinct from `FixtureRow` (GET/PATCH /fixtures/{id}), which DOES carry the
 *  derived names because its consumers have no venue list to resolve from. */
export type BoardFixtureRow = Omit<
  FixtureRow,
  "venue" | "court_label" | "court_name" | "venue_name" | "venue_id"
> & {
  /** A `scheduled` row that holds a result or scoring (`fixtureHasResultSql`:
   *  a start taken back, a walkover recorded in play), which every board
   *  write refuses to move (review 4 of #857). Sent only when true. */
  held?: true;
  /** W3 T3 (X-SW-29), W4 T3 (X-SD-5): a bye line (`byeLineSql` — a Swiss bye shell, a bracket's system bye, or a
   *  pre-award bye line), which no board write places. Sent only when true. */
  bye_line?: true;
};

export const BOARD_FIXTURE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round", "fixture_no",
  "home_entrant_id", "away_entrant_id", "home_slot_label", "away_slot_label",
  "scheduled_at", "venue", "court_label", "court_id", "venue_id",
  "officials", "status", "outcome", "schedule_source", "schedule_locked", "created_at",
  "ext_key", "lane", "is_final", "third_place", "conditional",
] as const;

export interface FixtureRow {
  id: string;
  stage_id: string;
  division_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  /** Per-division ordinal (PROMPT-30) — the /f/[no] URL segment. */
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** D4a (P5) — {key, params} i18n pattern ref while the matching
   *  *_entrant_id is null; cleared on fill. */
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  /** P9 pass 3c-2: DERIVED from `courts`/`venues` via `court_id`/`venue_id` —
   *  the real identity. `venue`/`court_label` above are the FROZEN text
   *  columns (no longer written anywhere since pass 3a); they stay on this
   *  general row shape only for callers not yet migrated off them. Never
   *  render `venue`/`court_label` in new code — render `venue_name`/
   *  `court_name` (fall back to the id if a lookup somehow misses). */
  court_id: string | null;
  court_name: string | null;
  venue_id: string | null;
  venue_name: string | null;
  officials: unknown[];
  status: string;
  outcome: unknown;
  schedule_source: "none" | "auto" | "manual" | "ai";
  schedule_locked: boolean;
  created_at: string;
  /** Generator-stable id (idempotent regeneration key). Also the ONE place
   *  a page-playoff fixture's Qualifier-1-vs-Eliminator identity survives —
   *  both share a round and a match count (F1 Task 4). Optional (like the
   *  four fields below), not because a real row can lack one — FIXTURE_COLS
   *  always selects it — but because dozens of pre-existing tests hand-build
   *  a FixtureRow-shaped literal that predates this field (the same
   *  precedent ScheduleSolverInfo's later fields already established:
   *  required would break every one of those literals without a full
   *  apps/web typecheck to find them all). */
  ext_key?: string | null;
  /** F1 (2026-08-17): the engine's bracket-position role, persisted instead
   *  of re-derived per consumer (db/migration/deltas/V368__fixture_round_role.sql).
   *  `lane` is null for single-lane brackets and non-bracket stages. */
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
  /** The bracket FEED edges (V214__fixtures.sql): the fixture this one's winner/loser
   *  advances INTO, and which seat there (1 = home, 2 = away). Written by
   *  `wireCrossFeeds` and by both generators' feed pass; read by
   *  `advanceWinner`/`fillSlot`.
   *
   *  `.optional()`, and NOT in `FIXTURE_COLS`, deliberately: exactly one
   *  reader selects them — `listDivisionFixtures`, so the division page's
   *  draw list can name an unfilled seat by its feeder ("Winner of R1·3")
   *  the way the schedule board already does. `getFixture` does not, and the
   *  published v1 `Fixture` contract does not carry them (the list route
   *  strips them, beside `venue`/`court_label`). Keeping them off
   *  `FIXTURE_COLS` is what stops that array from claiming a column every
   *  one of its readers selects. */
  winner_to_fixture?: string | null;
  winner_to_slot?: number | null;
  loser_to_fixture?: string | null;
  loser_to_slot?: number | null;
  /** W2b D5 / loop-F I-2: a withdrawal EXPUNGED this match — `abandoned` with an active `core.abandon{expunge: true}`
   *  (`hasActiveAbandonSql`'s expunge probe). Read by `listDivisionFixtures` only, for the console's qualification
   *  line (`buildQualificationView` F2); the v1 list route strips it, like the feed edges above. */
  expunged?: boolean;
  /** W2b Task 13 (X-AB-2): the reason of the row's ACTIVE `core.abandon`, or null (`activeAbandonReasonSql`) — the
   *  run sheet's abandon tag reads it (`forfeitTag`: the ledger, never the status). Read by `listDivisionFixtures`
   *  only; the v1 list route strips it, like `expunged`. */
  abandon_reason?: string | null;
  /** W2c X-AB-5 / N2: the row has an ACTIVE `core.abandon` (`hasActiveAbandonSql`) - read by `listDivisionFixtures`
   *  only, for the console's qualification line (a held match is still open to it); the v1 list route strips it. */
  has_active_abandon?: boolean;
  /** Rebase ruling D3: that active abandon is the organiser's online "No result" (`hasActiveAbandonSql` with
   *  `noResult`) - the settle itself, so the console's qualification line does not hold for it. Read by
   *  `listDivisionFixtures` only; the v1 list route strips it. */
  no_result?: boolean;
  /** W2c Task 19 (S4): the match has a format of its own over its stage's (`fixtures.rules_override is not null`) - the run
   *  sheet's "Format changed" chip reads it. Read by `listDivisionFixtures` only; the v1 list route strips it. */
  format_changed?: boolean;
  /** W4 B1b fix round 1 (Q1): a bye line still waiting on its award whose award will be a WALKOVER - its dead seat's feeder
   *  handed on a winner who has withdrawn (`awaitsWalkoverSql`, the fragment `awardSeededByes` writes the award from) - so a
   *  match owed. The run sheet's round bar counts it in its total (never as done); every other waiting bye line becomes a
   *  bye and is no match. Read by `listDivisionFixtures` only; the v1 list route strips it. */
  awaits_walkover?: boolean;
}

export interface GenFixture {
  extKey: string;
  roundNo: number;
  seqInRound: number;
  home: string | null;
  away: string | null;
  homeFrom?: { extKey: string; side: "winner" | "loser" };
  awayFrom?: { extKey: string; side: "winner" | "loser" };
  award?: string; // bye: auto-advancing entrant
  poolId?: string; // group stages: which pool this fixture belongs to
  // F1 (round-role persistence): carried straight from BracketFixtureGen so
  // the generated round's ROLE survives insertion instead of being
  // re-derived from round_no/match-count by each consumer (design §2.3).
  lane?: "WB" | "LB" | "GF";
  isFinal?: boolean;
  thirdPlace?: boolean;
  conditional?: boolean;
  /** W2b D-G3 corner 3 (X-WD-3): the seat a departed qualifier was drawn into, emptied — her opponent is still to be
   *  fed — and stamped dead (`BYE_SLOT_LABEL`) at insert, so the arriving opponent walks over it. */
  departedSeat?: "home" | "away";
}

export interface ActiveEntrant {
  id: string;
  seed: number | null;
  /** W3 T6 (spec §4, ruling 251): the first Swiss round this entrant is in the field for; null = from round 1, which is
   *  every entrant enrolled before Start. Read only by the Swiss path (`swissFieldForRound`, `buildSwissHistory`);
   *  written by Task 9's late entry. Every list built from something other than the active select (a qualified slate,
   *  a preview, a slot placement) carries null: that field is fixed when the stage is drawn. */
  swiss_first_round: number | null;
}

export type SwissExistingFixture = {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  /** W3 T2 (SW-L8): the slot a shrinking pre-Start round weighs before it
   *  deletes a board (`chooseDoomedBoards`, lib/rebuild-slots.ts — the same
   *  order Rebuild's carry uses). postgres.js parses `timestamptz` into a Date. */
  scheduled_at: Date | string | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
};

export type SwissGenResult = {
  gen: GenFixture[];
  seatedCount: number;
  reshaped: SwissReshape;
  /** The mode this pass paired with, and the one it would have used with no
   *  override — both null when the pass seated nothing. */
  pairing: SwissPairingMode | null;
  defaultPairing: SwissPairingMode | null;
  /** The round this pass seated; null when it seated nothing. */
  round: number | null;
  /** The shell ids this pass seated (boards and the bye). An AUDIT list only:
   *  seating UPDATEs shells that already existed, so these must never reach
   *  the ledger's `fixture_ids`, which Undo deletes. */
  seatedIds: string[];
  /** W3 T8 (X-SW-22): the stage's draw seed when this pass drew round 1 (an unseeded entrant in its field); else null. */
  drawSeed: number | null;
  /** W3 T9 (T8 review n1): round 1's drawn order — every entrant of its field, seeds first, then the draw — when this pass
   *  drew round 1; else null. It rides on the round's ledger row (`draw_order`) and every later round ranks a tie by it
   *  (`swissRoundOneDrawOrder`), so a seed edit after Start or a late player seated in round 1 never reshuffles it. */
  drawOrder: string[] | null;
  /** W3 T8 (BG-SW-1): the colour board 1's upper player took when this pass coloured round 1 by lot (chess on); else
   *  null. */
  colourLot: "white" | "black" | null;
  /** W3 T11 (X-SW-16): the round count judged against the field this pass minted or paired for (`judgeSwissRoundsAt` at
   *  the mint, `judgeSwissPairAt` at a Pair) — never a refusal (that throws); null when the pass had nothing to pair. A
   *  warn, or a running Swiss's shrunk-field warning, rides on the Generate's answer. */
  swissRounds: SwissRoundsJudgement | SwissRoundsShrunk | null;
  /** W3 app-B T7 (X-SW-10): the engine's look-ahead verdict on the round AFTER the one this pass seated - present only when
   *  the pass asked for it (`lookAhead`, a stage above its safe maximum, never the last round); null when it did not, or
   *  nothing was seated. `pairable` is a verdict too (the Generate's answer drops it: nothing to tell). */
  nextRound: SwissNextRound | null;
  /** W3 app-B T7 (X-SW-11): the `finalRoundMaxScore` this pass sent (table points), else null. Recorded on the round's
   *  ledger row (`final_round_max_score`) so a later pass can tell the stage's one use of it has been spent. */
  finalRoundMaxScore: number | null;
};

/**
 * What a reconcile pass actually MOVED, so pressing Generate can say so.
 *
 * Byes are counted apart from matches because they are not the same thing to
 * an organiser: a match row needs a court and a slot, a bye row needs neither.
 * Reporting "4 matches added" when one of them is a bye would be a number they
 * cannot reconcile against the run sheet.
 *
 * `matches_removed` is the one that earns this whole seam. A removed board takes
 * its `scheduled_at` and `court_id` with it, and before this the organiser was
 * told only how many fixtures were seated — never that three of the slots they
 * had laid out were gone.
 */
export interface SwissReshape {
  matches_added: number;
  matches_removed: number;
  byes_added: number;
  byes_removed: number;
}

export interface GenerateOutcome {
  created: number;
  existing: number;
  fixtures: FixtureRow[];
  /** Swiss only, and ABSENT unless the shell set actually moved — a Generate
   *  that changed no round's shape must stay silent rather than announce four
   *  zeroes. See `SwissReshape`. */
  reshaped?: SwissReshape;
  /** W3 T11 (X-SW-16): Swiss only, and ABSENT unless the round count is above the safe maximum of the field this pass
   *  minted or paired for (`verdict: "warn"`, rulebook §3.2 "allowed, with a plain warning"), or a running Swiss's field
   *  shrank under its count while this round still pairs (`verdict: "shrunk"`, fix round 1). A count above the hard
   *  maximum is otherwise refused (SWISS_ROUNDS_ABOVE_MAX). */
  swiss_rounds?: SwissRoundsNotice;
  /** W3 app-B T7 (X-SW-10; rulebook-W3-swiss.md §3.3): Swiss only, and ABSENT unless this Pair asked the engine to look one
   *  round ahead (a stage above its safe maximum, not the last round) and the answer was not "pairable": `unpairable` -
   *  every legal pairing of the round just seated leaves the next one with none; `unknown` - the search budget ran out
   *  before the engine could tell. The round is seated either way. Always with `swiss_paired_round`. */
  swiss_next_round?: "unpairable" | "unknown";
  /** W3 app-B T7: the round the Pair just seated, sent beside `swiss_next_round` so the desk names the round it follows
   *  ({round}) and the one it warns about ({round} + 1) from ONE number, the server's - never a second count of its own. */
  swiss_paired_round?: number;
  /** W4 T8 (FX-G2): a root knockout's Generate over a bracket that already has lines — ABSENT on a first Generate and on
   *  every other kind. `noop`: nothing changed (the desk's "up to date"); `in_place`: newcomers `placed` in byes and the
   *  departed `vacated` (their opponents now hold byes), no line inserted or deleted; `regenerated`: the bracket crossed a
   *  power of two, so it was drawn again in this transaction with its slots carried by role (`slots`, as Rebuild says). */
  reconcile?: ReconcileOutcome;
}

/** W4 T8: what a root knockout's reconcile did (`GenerateOutcome.reconcile`). `placed`/`vacated` are entrant ids. */
export interface ReconcileOutcome {
  kind: "noop" | "in_place" | "regenerated";
  placed: string[];
  vacated: string[];
  /** B2 fix round 1 (I2): every seat emptied — a departed entrant's, and one whose entrant was deleted (in no list). */
  vacated_seats: number;
  slots?: { kept: number; freed: number; unscheduled: number };
}

/** A generate's committed write (R10e): the wire outcome, plus the division
 *  and competition its own transaction wrote into. */
export interface GenerateWrite {
  outcome: GenerateOutcome;
  divisionId: string;
  competitionId: string;
  /** The stage's kind: whether it has a table to refold after the write (`REAL_TABLE_KINDS`). */
  kind: string;
  /** Only with `ledger: "step"`: the `fixtures_generated` payload this pass did NOT append (`fixture_ids` and, for a
   *  Swiss seating, its seat audit), for the history step that ran it to record on its own row. */
  ledgerPayload?: Record<string, unknown>;
  /** W4 T8 (FX-G2): the fixtures a knockout reconcile changed in place, or deleted to regenerate — the publish names
   *  them so their match centres refetch. Absent on every other write (a plain Generate changes no existing fixture). */
  changedFixtureIds?: string[];
}

/** What a Generate press may ask for beyond "generate". */
export interface GenerateOptions {
  /** Swiss only, round 1 only: pair this round with this mode instead of the
   *  round-1 default. Never stored — `stages.config` is untouched; the
   *  `fixtures_generated` ledger row records it. Refused (422) on any other
   *  stage kind, round, or press. */
  pairing?: SwissPairingMode;
  /** W4 B2 fix round 2 (item 2): Start's own reconcile of a root knockout drawn before its roster moved — seats change in
   *  place, and a redraw is refused (KO_START_NEEDS_UPDATE_DRAW) instead of run. Never sent by a client: `startDivision`
   *  sets it. */
  inPlaceOnly?: boolean;
  /** W4 app B, Task 20 (C27): Start on a FROZEN board. A newcomer (an active entrant in no first-round seat) is not placed -
   *  placing is a schedule write the freeze binds - but MARKED WAITING (`entrants.knockout_waiting_stage_id`), as the late-entry
   *  path marks an arrival; a departed entrant is reconciled as on any board. Only with `inPlaceOnly`; never sent by a client. */
  waitNewcomers?: boolean;
  /** W4 B2 fix round 2 (item 5): the stage's setup in SEALED tables (streams, YouTube broadcasts), read on a privileged
   *  connection by `generateStageFixturesWrite`'s prelude — a knockout redraw refuses over it as over the rest. Never sent
   *  by a client. */
  sealedSetup?: SealedSetupCounts;
}

export interface StageRosterDriftEntrant {
  id: string;
  display_name: string;
}

export interface StageRosterDrift {
  /** Referenced by a fixture in this stage (home or away) but no longer in
   *  the active roster (withdrawn/disqualified) — a wrong name still on a
   *  board an organiser may have already shared publicly. */
  ghosts: StageRosterDriftEntrant[];
  /** Active in the division (registered/confirmed) but referenced by no
   *  fixture in this stage — registered after the last Generate, or Generate
   *  has never run since. */
  unplaced: StageRosterDriftEntrant[];
  /** W4 B2 fix round 2 (item 1): a ROOT knockout's first-round lines with an EMPTY place — a match with a seat nobody is
   *  on, or a bye with nobody on it. `deleteEntrant` leaves exactly this (the FK nulls the seat), and it is neither a ghost
   *  (nobody is named) nor an unplaced entrant (nobody is missing), so without it the banner, its Rebuild and Update draw
   *  all stayed hidden while Start and Generate refused. Zero on every other stage, and on a later round's seats (those
   *  wait on winners). */
  vacantLines: number;
  /** Organiser WORK attached to this stage's fixtures that a rebuild would
   *  take with them (F3 ultrareview finding 5). `delete from fixtures`
   *  CASCADEs into all three, and unlike a result none of them BLOCKS the
   *  rebuild: an organiser who has already appointed referees is exactly the
   *  organiser most likely to need a rebuild before match day, so refusing
   *  would make the feature useless when it matters most. Refusing is wrong,
   *  but so is destroying it silently — these counts let the confirm dialog
   *  name what the rebuild clears, so the choice is made with the cost
   *  visible. Zero for a stage with no board. */
  attachments: {
    /** `fixture_officials` — referee/umpire appointments (officials.ts). */
    officials: number;
    /** `lineups` — team sheets (fixtures.ts). */
    lineups: number;
    /** `device_links` — paired scoring devices (device-links.ts). */
    deviceLinks: number;
    /** W4 B2 fix round 2 (item 5) — the rest of the setup a match can carry BEFORE Start, each a CASCADE of the fixture
     *  delete and each written with no gate on the division's status:
     *  matches with stream setup — a live stream code (`fixture_stream_codes`, minted when the stream panel opens; its
     *  phone pairings cascade with it) or per-match stream settings (`fixture_stream_settings`, the destination pre-pick).
     *  One match with both counts once: what the organiser redoes is that match's stream. An ENDED code is history, not
     *  setup, and is not counted. */
    streams: number;
    /** `youtube_broadcasts` — broadcasts Go live created on YouTube (youtube/prepare.ts); the replay link goes with them. */
    youtubeBroadcasts: number;
    /** `fixture_availability` — players' availability answers and check-ins (me.ts). */
    availability: number;
    /** `fixture_calls` — Match Day court calls (match-day-call.ts). */
    calls: number;
  };
}

/** The two kinds of `StageRosterDrift.attachments` kept in SEALED tables (V430, V479: RLS forced, no policy, no app_user
 *  grant — "every read goes through the app's non-tenant client"), so a `withTenant` transaction cannot count them (42501):
 *  matches with stream setup, and YouTube broadcasts. W4 B2 fix round 2, item 5. */
export type SealedSetupCounts = Pick<StageRosterDrift["attachments"], "streams" | "youtubeBroadcasts">;

// L3/#414 pass 3 — REAL_TABLE_KINDS are the kinds a carry-over may source
// from: league/group/swiss. Carry-over (seedNextStage below, and
// computeSeedProposal's propose-time guard since F6) refuses every other kind,
// because what a progression actually READS from a source is the PoolTable
// that tablesForCompletedStage / sourcesToTables builds — and for every OTHER
// kind that table comes from `placementTable`, which zeroes played/won/drawn/
// lost/points and metrics (engine competition/progression.ts). Carrying from
// one would seed the next stage with fabricated zeros instead of refusing
// outright.
//
// Corrected 2026-09-15 (F6 review round 1) — this used to claim
// REAL_TABLE_KINDS were "the only kinds whose standings snapshot carries
// actual points/metrics (folded via completeTableStage)" and lumped americano
// in with the bracket kinds as snapshotting placements. Both halves were wrong
// about americano, and the error propagated out of here into F6's organiser
// copy before review caught it. What is actually true:
//
//   - americano IS in engine-db/competition.ts's TABLE_KINDS, so its own
//     completion snapshot folds REAL points via completeTableStage — but over
//     the EPHEMERAL per-round PAIR entrants (Jul3/08 §3). That is precisely why
//     the progression path never reads that snapshot: americanoPlacementTables
//     (below) re-derives personal points, maps them onto the division's
//     individual entrants, and returns `placementTable(ordered)`. Both the
//     on_complete and the setup path go through it. So americano does reach a
//     carry as zeroed placements like the rest — by a different ROUTE than the
//     old comment described, which is the part that was wrong.
//   - ladder is `placementTable(config.ladder_order)` and the bracket kinds are
//     `placementTable(bracketRanks(...))`, both written at completion time by
//     completeStageIfReady — those two the old comment had right.
//
// The refusal set is therefore correct as shipped; only its stated reason was
// not. Do not "simplify" this back to a claim about completeTableStage.
//
// BRACKET_KINDS mirrors engine-db/competition.ts's own list — losersOfRound
// only makes sense sourced from one of these.
export const REAL_TABLE_KINDS = new Set(["league", "group", "swiss"]);

// Exported (F3 review item 5): stage-seeding.ts's sourcesToTables needs the
// SAME set to know when a source needs bracket data for a roundLosers take
// rule — see loadBracketFixtures' own export note below.
export const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);