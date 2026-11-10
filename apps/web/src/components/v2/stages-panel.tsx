"use client";

// Fixture console per stage (PROMPT-15 task 1, rebuilt per v3/04 §3): rounds
// grouped with date ranges, competition-timezone rendering, the "N to
// schedule" count (Task 2, "remove auto-schedule from the fixtures page" —
// scheduling itself lives on the Schedule page, see ScheduleBoard/
// AutoScheduleMode; Match Day E1 item 1 removed the card's footer link to it,
// the count line is the card's one statement of the number), "Now playing"
// strip, inline reschedule with undo, bye/void ghost rows, sticky round bars,
// print via the DocModel timetable export. Scoring lives on the fixture page.
//
// Match Day E1 (owner, 2026-11-01): a stage card's header reads [actions | divider
// | settings] - the stage rail (Generate/Pair, Unpair, Complete + its ⓘ, Add match,
// Delete) on the left, the Match rules / Points / Tie-breaks buttons on the right -
// and its rows sit under one bar per round (the round's name, "N of M played", and
// its time span), not under day headings.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { routes } from "@/lib/routes";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ruleRefusalText } from "@/lib/rule-errors";
import { SWISS_ABANDONED_BOARDS_REASON, abandonedBoardsOf } from "@/lib/swiss-abandoned-refusal";
import { ABANDONED_MATCHES_REASON, heldMatchesOf } from "@/lib/abandoned-matches-refusal";
import { rulesWriteErrorText } from "@/lib/config-issue-copy";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import { isSwissRefusalCode, swissRefusalKey } from "@/lib/swiss-refusals";
import { isUndoRefusalCode, undoRefusalText } from "@/lib/undo-refusals";
import { isKnockoutRefusalCode, knockoutRefusalText } from "@/lib/knockout-refusals";
import { knockoutUpdateDrawOffered } from "@/lib/bracket-reconcile";
import { swissRoundsWarnNotice, type SwissRoundsNotice } from "@/lib/swiss-rounds";
import { swissRefusalText } from "@/lib/swiss-refusal-text";
import { nextRoundNoticeOf, nextRoundText, type NextRoundNotice } from "@/lib/swiss-next-round";
import {
  NO_PAIRING_ACTION_KEY,
  noPairingDetailsOf,
  noPairingFinishPlan,
  noPairingNotice,
  noPairingText,
  type NoPairingNotice,
} from "@/lib/swiss-no-pairing";
import {
  swissFinishConfirm,
  swissFinishedNotice,
  swissFinishNotReadyText,
  swissFinishPlanOf,
  type SwissFinishAnswer,
  type SwissFinishPlan,
} from "@/lib/swiss-finish-plan";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import type { HoldState } from "@/server/relay/domain/session";
import { useConfirm } from "@/components/ui/confirm-provider";
import { ChevronRight } from "lucide-react";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { useNow } from "@/components/public-site/match-centre/use-now";
import { seedingErrorMessage } from "@/lib/seeding-error";
import { scoringErrorText } from "@/lib/scoring-vocab";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { DEFAULT_MATCH_MINUTES, isUnscheduledFixture } from "@/lib/division-phase";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { parseRoundRoleKey, type PointsRule } from "@seazn/engine/competition";
import { TagChipInput } from "@/components/ui/tag-chip-input";
// Per-stage rules row (design §T5, D7; W2c Task 17). Match Day C2: the format, points and tie-breaks are the ONE component
// each (`components/v2/rules/`), the same the division builder and the Division rules strip render, so the editors cannot
// drift. The table itself comes from `@/lib/match-rules`.
import { hydrateRuleValues, ruleOptionText, type RuleMsg } from "@/lib/match-rules";
import { moduleFor } from "@/lib/rule-scope";
import { mergedStageRules } from "@/lib/stage-decider-off";
import { sportLabel } from "@/lib/scoring-vocab";
import type { StageKind } from "@seazn/engine/core";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { DecidersNotice } from "@/components/v2/stage-rules/deciders-off-notice";
import { MatchFormatEditor } from "@/components/v2/rules/match-format-editor";
import { PointsEditor, stagePointsHeadline } from "@/components/v2/rules/points-editor";
import { LockLine } from "@/components/v2/rules/lock-line";
import { describeDeciders, describeMatchRules } from "@/server/public-site/describe-rules";
import { rulesLineText } from "@/lib/rules-line";
import { showKindPill, tiesSummary } from "@/lib/stage-card/layout";
import { stageCardCollapse, stageCounts, unitLabelKey } from "@/lib/stage-card/summaries";
import { pointsDiffer, stageTakesPoints } from "@/components/v2/stage-rules/stage-points-model";
import { TiebreaksEditor, stageLikeOf } from "@/components/v2/rules/tiebreaks-editor";
import { DivisionRulesStrip, TOGGLE_OFF, TOGGLE_ON, type DivisionRulesStripProps, type RulesPanel } from "@/components/v2/rules/division-rules-strip";
import { BracketPanel } from "@/components/v2/bracket-panel";
import { WithReasonTip } from "@/components/v2/desk/reason-tip";
import { bracketAccess, bracketPlacement } from "@/lib/bracket-view";
import { inheritedOrder as inheritedOrderOf, stagePooled, takesBestNthFrom, tiebreaksDiffer } from "@/components/v2/stage-rules/stage-tiebreaks-model";
import type { StageTableRules } from "@/server/api-v1/schemas";
import { isStagePreset, resolvedStageCfg, stageFormatSaveFragment } from "@/components/v2/stage-rules/stage-row-model";
import { Modal } from "@/components/modal";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { DocumentsMenu } from "@/components/v2/board/documents-menu";
import { DateTimeField } from "./shared/datetime-field";
import { boardSlotTimes } from "./shared/time-options";
import { windowsToDailyHours } from "@/lib/schedule-board";
import type { BoardConfig } from "@/components/v2/board/types";
// `resolveCourtNames`/`flattenCourts` are the SAME shared pieces the board's
// own `courtNamesById` and the settings tab's `CourtMultiPicker` already use
// — reused here rather than a third court-name implementation. `courtGroups`
// left with them until fix round 4: it fed `FixtureLine`'s per-fixture court
// picker, which had no production render site once the run sheet replaced
// that row, and went with it (court placement lives on the schedule board —
// fix round 1, IMPORTANT 6).
import { resolveCourtNames } from "@/components/v2/shared/court-multi-picker";
// P9: the BOARD-side Venue (no `hours`/`exceptions`) — this panel shows
// courts, it never reads a calendar. See court-multi-picker.tsx.
import type { Venue } from "@/components/v2/shared/court-multi-picker";
import { zonedTimeInput } from "@/lib/zoned-datetime";
// W3 item 6 — one definition of "this swiss stage is between rounds, not
// drifted", shared with the page's tests rather than restated in each.
import { rosterDriftShown, swissAwaitingPairing } from "@/lib/roster-drift-eligibility";
import {
  latestSwissRoundWithAnySeat,
  nextUnseatedSwissRound,
  swissRoundHasPlayedResult,
} from "@/lib/swiss-shell";
// The Swiss shape legend (owner-approved 2026-09-22, option B) — the one line
// under a swiss stage's title. Pure derivation + copy assembly live there; see
// that module's header for why the match count is taken from the FIELD and
// never from a count of the fixture rows.
import { swissLegendRound, swissStageLegend, swissLegendText } from "@/lib/swiss-legend";
import { lateEntryNoticeText, swissLatecomerCounts, swissLatecomerLines } from "@/lib/swiss-late-entry-notice";
import { swissCutDriftOf, swissCutDriftText, type SwissCutDrift } from "@/lib/swiss-cut-drift";
import { knockoutCutDriftOf, knockoutCutDriftText, type KnockoutCutDrift } from "@/lib/knockout-cut-drift";
// Swiss round-1 pairing (spec 2026-09-22-swiss-round-one-pairing, "UI") — the
// split button's menu. Client-safe leaves only: never the
// `@seazn/engine/scheduling` barrel (the whole solver; `@seazn/scheduler` is the grpc side).
import {
  SWISS_PAIRING_NOT_SWISS_CODE,
  SWISS_PAIRING_ROUND_ONE_ONLY_CODE,
  type SwissPairingMode,
} from "@/lib/swiss-pairing";
import { swissPairingMenuFor, swissUnpairChangeHint, type EntrantSwissFirstRounds } from "@/lib/swiss-pairing-menu";
import { swissDoorRefusalText } from "@/lib/swiss-door-refusal";
import { ROOT_KNOCKOUT_KINDS, isRunningRootSwiss } from "@/lib/open-entry-stages";
// Competition Desk W2 (Task 4) — the run sheet's grouping builder + the
// component that renders it. `isBye` (and, inside `buildRunSheet` itself,
// `BRACKET_STAGE_KINDS`) are the SINGLE authorities now (R2a/R10,
// docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md) —
// this file's own former copies are deleted below.
import { buildRunSheet, isBye, latchedOpen, roundDone, type RunSheetFixture, type RunSheetOnlinePlay } from "@/lib/run-sheet-groups";
import type { ForfeitEntrantStatuses } from "@/lib/forfeit-tag";
import { RUN_SHEET_FILTER_LABEL, RunSheet, RunSheetFilterBar, runSheetHasRows, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { isOnlineGameExists } from "@/lib/open-round";
import { venueNoun } from "@/lib/venue";
import { OnlineGameExistsNotice } from "@/components/v2/online-game-exists-notice";
// Competition Desk W3 (Task 2) — the stage rail takes the three header
// action controls (Generate/Complete/Delete). See stage-rail.tsx's own
// header for why it stays presentational (props only, no data hook).
import { StageRail, stageRailActions } from "@/components/v2/desk/stage-rail";
import { KnockoutWaitingStrip } from "@/components/v2/desk/knockout-waiting-strip";
import type { KnockoutWaitingEntrant } from "@/server/usecases/knockout-desk";
import type { SwissRoundsRefusal } from "@/components/v2/desk/swiss-rounds-dialog";
import type { SwissRoundControl } from "@/lib/swiss-rounds-edit";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
type MsgPlural = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** The `reshaped` half of POST /stages/{id}/generate — Swiss only, and absent
 *  unless the shell set actually moved. Mirrors `SwissReshapeResult`
 *  (api-v1/schemas.ts); snake_case because it is the wire, not a view model. */
export interface SwissReshapeWire {
  matches_added: number;
  matches_removed: number;
  byes_added: number;
  byes_removed: number;
}

interface StageRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: Record<string, unknown> | null;
  status: string;
}
/** The panels a stage card opens inline from its header: the three rules panels and (E1 item 3) the bracket tree. */
type StagePanelKey = RulesPanel | "bracket";

interface FixtureRow {
  id: string;
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** D4b (P6) — {key, params} i18n pattern ref while the matching
   *  *_entrant_id is null (V360's fixtures.home/away_slot_label). */
  home_slot_label?: SlotLabel | null;
  away_slot_label?: SlotLabel | null;
  scheduled_at: string | null;
  /** FROZEN legacy text (no writer has touched either since P9 pass 3a) —
   *  kept only as a read fallback for a pre-cutover fixture that never got a
   *  real court_id. Never seed an editor from these, never PATCH them —
   *  `PatchFixture` is `.strict()` and has no `venue`/`court_label` key. */
  venue: string | null;
  court_label: string | null;
  /** P9 pass 4d: the fixture's REAL court identity — mirrors
   *  `FixtureRow.court_id`/`court_name` (stages.ts's server-side type, which
   *  `FIXTURE_COLS` has selected since pass 3c-2). */
  court_id: string | null;
  /** DERIVED display name for `court_id` — never render `court_id` itself
   *  (a raw uuid). Falls back to `court_label` via `courtDisplayName`. */
  court_name: string | null;
  /** Competition Desk W2 (Task 4) — venue-qualified display name, mirrors
   *  `FixtureRow.venue_name` (usecases/stages.ts). Optional for the same
   *  reason `ext_key` etc. below are: pre-existing hand-built test props in
   *  this panel's own `__tests__` predate the field. Feeds the run sheet's
   *  day-header venue clause and `RunSheetRow`'s `courtLabel` fallback. */
  venue_name?: string | null;
  /** Competition Desk W2 (Task 4) — any officials recorded on the fixture,
   *  mirrors `FixtureRow.officials` (usecases/stages.ts). Optional, same
   *  reason as `venue_name` above. `fixtureRowAction`'s "no scorer" input is
   *  `officials.length > 0`, derived at ITS call site (`RunSheetRow`), never
   *  here. */
  officials?: unknown[];
  status: string;
  outcome: unknown;
  /** F1 (2026-08-17) — the engine's bracket-position role, persisted on
   *  fixtures (V368) and selected by usecases/stages.ts's FIXTURE_COLS.
   *  Optional here for the same reason it's optional on the shared
   *  FixtureRow this local type otherwise mirrors: real rows always carry
   *  it, but pre-existing hand-built test fixtures in this panel's own
   *  __tests__ don't. */
  ext_key?: string | null;
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
  /** The bracket FEED edges (V214__fixtures.sql): which fixture this one's winner/loser
   *  advances into, and which seat there (1 = home, 2 = away). Mirrors
   *  `FixtureRow.winner_to_fixture` etc. on the shared server type;
   *  `listDivisionFixtures` selects them, and `feedLabels()` turns them into
   *  the "Winner of R1·1" the run sheet renders for a seat whose stored
   *  `*_slot_label` is null. Optional for the same reason `ext_key` and the
   *  four below it are: pre-existing hand-built test props predate them. */
  winner_to_fixture?: string | null;
  winner_to_slot?: number | null;
  loser_to_fixture?: string | null;
  loser_to_slot?: number | null;
  /** W2c Task 19 (S4): mirrors `FixtureRow.format_changed` - the run sheet's "Format changed" chip. Optional like the
   *  fields above: hand-built test props predate it. */
  format_changed?: boolean;
}

/** Adapts this panel's hand-declared `FixtureRow` to `RunSheetFixture`
 *  (run-sheet-groups.ts, a `Pick` of the SHARED `@/server/usecases/stages`
 *  type) — needed only because `home_slot_label`/`away_slot_label`/
 *  `venue_name`/`officials` are OPTIONAL here (pre-existing hand-built test
 *  props predate them) but REQUIRED on the shared wire type `RunSheetFixture`
 *  picks from. The real page always sends every field (`listDivisionFixtures`
 *  selects them all); this only normalises the gap for TypeScript and for any
 *  hand-built test fixture that omits one. */
function toRunSheetFixture(f: FixtureRow): RunSheetFixture {
  return {
    ...f,
    home_slot_label: f.home_slot_label ?? null,
    away_slot_label: f.away_slot_label ?? null,
    venue_name: f.venue_name ?? null,
    officials: f.officials ?? [],
  };
}

/** Adapts this panel's rows to `feedLabels()`'s input — the same normalising
 *  job `toRunSheetFixture` above does, for the same reason: the four feed
 *  columns are OPTIONAL here (hand-built test props predate them) and
 *  REQUIRED on `FeedRow` (lib/schedule-board.ts), which the schedule pages
 *  feed straight from their own `tx<FeedRow[]>` read. Normalising here rather
 *  than widening `FeedRow` keeps the board's contract untouched — a row that
 *  genuinely has no edge and a row from a caller that never selected the
 *  columns are the same thing to the builder: not a feeder. */
function toFeedRow(f: FixtureRow): FeedRow {
  return {
    id: f.id,
    round_no: f.round_no,
    seq_in_round: f.seq_in_round,
    winner_to_fixture: f.winner_to_fixture ?? null,
    winner_to_slot: f.winner_to_slot ?? null,
    loser_to_fixture: f.loser_to_fixture ?? null,
    loser_to_slot: f.loser_to_slot ?? null,
  };
}

/** F3 Task 5 (5a) — getStageRosterDrift's wire shape (usecases/stages.ts),
 *  hand-declared like StageRow/FixtureRow above: this panel only ever reads
 *  these two fields. */
interface RosterDriftEntrant {
  id: string;
  display_name: string;
}
interface RosterDrift {
  ghosts: RosterDriftEntrant[];
  unplaced: RosterDriftEntrant[];
  /** A root knockout's first-round lines with an empty place (an entrant deleted) — StageRosterDrift.vacantLines. Optional:
   *  hand-built props in this panel's own __tests__ predate the field (read as none, `rosterDriftShown`). */
  vacantLines?: number;
  /** Organiser setup that a rebuild clears along with the fixtures — see
   *  StageRosterDrift.attachments (usecases/stages.ts) for why these do not
   *  BLOCK the rebuild the way a recorded result does. Optional: hand-built
   *  props in this panel's own __tests__ predate the field. */
  attachments?: {
    officials: number;
    lineups: number;
    deviceLinks: number;
    streams: number;
    youtubeBroadcasts: number;
    availability: number;
    calls: number;
  };
}

interface Props {
  divisionId: string;
  /** Competition id — the Admit tickets export is competition-scoped. */
  competitionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  stages: StageRow[];
  fixtures: FixtureRow[];
  entrantNames: Record<string, string>;
  /** W3 T15 ruling 2 — entrant id → status (the page's roster read), threaded to the run sheet's rows only: a
   *  DISQUALIFIED entrant's cascade walkover is worded as the disqualification, never as a withdrawal. Optional, so the
   *  existing `stages-panel-*.test.tsx` props stay valid; absent, a walkover is worded by its reason alone. */
  entrantStatuses?: ForfeitEntrantStatuses;
  /** The ids of the entrants who are IN THE FIELD — the division roster
   *  filtered to the server's own `status in ('registered','confirmed')`
   *  predicate (the page derives it as the complement of `DEPARTED_STATUSES`,
   *  the one place that vocabulary is spelled; the equivalence is pinned by
   *  `swiss-legend.test.ts`).
   *
   *  Feeds the swiss shape legend and the round-1 pairing menu's field size
   *  and seed hint, and NOTHING else. Ids rather than a bare
   *  count because a swiss stage carrying `config.qualified` pairs only the
   *  qualifiers still in the field, which is an intersection, not a number —
   *  the same resolution `generateStageFixturesWrite` performs.
   *
   *  Optional for the same reason `venues`/`rosterDrift` are: a dozen
   *  pre-existing `stages-panel-*.test.tsx` files build props without it.
   *  ABSENT means "roster unknown" and renders NO legend — never a match count
   *  of zero dressed up as a fact. */
  activeEntrantIds?: string[];
  /** Entrant id -> seed (`null` = unseeded), the whole roster. Feeds ONLY the
   *  round-1 pairing hint's R1 check (`swissFieldSeedsNumbered`): the hint
   *  prints "1v6, 2v7…" as seed numbers only when the field's seeds really
   *  are 1..N in pairing order. Optional like `activeEntrantIds`; ABSENT means
   *  "seeds unknown" and the hint falls back to its generic line. */
  entrantSeeds?: Record<string, number | null>;
  /** W3 T9 (T8 review m8): entrant id -> its stored first Swiss round and the stage it belongs to (V486/V487). Feeds
   *  ONLY the round-1 pairing menu, so its field is the server's round field (a late player whose first round is
   *  ahead is not in it). Optional like `entrantSeeds`; ABSENT means everyone plays from round 1. */
  entrantSwissFirstRounds?: EntrantSwissFirstRounds;
  /** Org venues with nested courts (`listVenues` shape, venues.ts) — feeds
   *  the per-fixture court editor's picker and the venue-qualified display
   *  name (P9 pass 4d, item 1). Same prop shape schedule-board.tsx's own
   *  `venues` already uses for the identical purpose. Defaults to `[]` below
   *  so existing hand-built test props don't all need updating. */
  venues?: Venue[];
  /** F3 Task 5 (5a) — keyed by stage id, computed server-side by
   *  getStageRosterDrift. Only ever non-empty for the one root stage whose
   *  fixtures reference the live roster (see that function's own doc
   *  comment) — every other stage is absent or `{ghosts:[],unplaced:[]}`.
   *  Optional: pre-existing hand-built props in this panel's own __tests__
   *  predate this field. */
  rosterDrift?: Record<string, RosterDrift>;
  canEdit: boolean;
  /** Match Day PB3 (m7): may this viewer settle a held match? `canEdit` is the page's `editable` - the billing freeze folded in -
   *  and a frozen competition keeps its settle (a settle is a score event; scoring is not freeze-gated). The page hands the
   *  organiser's own right here. Absent means `canEdit`, which is the safe direction for a caller that never heard of the freeze. */
  canSettle?: boolean;
  /** The division's sport. Every sport has the per-stage rules row since W2c Task 17 (which fields it shows is the
   *  engine's `ruleKeys`, not a list of sports here). Optional for the same reason `venues` is: a dozen
   *  pre-existing `stages-panel-*.test.tsx` files build props without it, and an absent sport renders no row, which is
   *  the safe direction. */
  sportKey?: string;
  /** The division's variant key (`divisions.variant_key`): narrows the stage's rule fields and names its preset. Null
   *  or absent is "not narrowed", the engine's own rule. */
  variantKey?: string | null;
  /** The division's `config` — the base the stage's `rules` fragment overlays.
   *  Needed because the format row's SUMMARY must state the number the stage
   *  will actually be played at, which for an inherited stage lives entirely
   *  in the division. Never used to hydrate the EDITOR (see StageFormatRow). */
  divisionConfig?: Record<string, unknown>;
  /** The public dictionary's rules-line slice (`rulesLineDict`: the `format.rules.*` keys). The format row's chips are the
   *  public line's own clauses, which live in the PUBLIC dictionary, not the console's; absent, the row shows no chips. */
  ruleDict?: Dict;
  /** The public dictionary's `format.points.*` slice (`pointsLineDict`): the stage points section previews its rule in the
   *  public stage line's own words (W2c Task 18). Absent, the section shows no preview. */
  pointsDict?: Dict;
  /** Stage ids whose match format is LOCKED, resolved server-side by
   *  `formatLockedStageIds` (usecases/stage-rules.ts) from the same predicate
   *  the PUT refuses on. Deliberately a server fact rather than anything
   *  derived here: the only client-visible signal is `fixtures.status`, which
   *  is non-monotonic (voiding a start moves it back to `scheduled`), so a
   *  panel deriving the lock from it would offer an Edit button whose save
   *  comes back 409. */
  formatLockedStageIds?: string[];
  /** W2d final review I1: stage id → the points its PIN pays, for the pinned table stages (`listPinnedStagePoints`,
   *  usecases/stage-qualification.ts, the one loader). A pinned stage's points card says these when it has no rule of its
   *  own, never `divisionConfig`: a division points save after the pin never reaches the stage. Optional like
   *  `formatLockedStageIds`: absent, every card reads the live division (an unpinned stage's answer). */
  pinnedStagePoints?: Record<string, PointsRule>;
  /** W2d Task 15: stage id → its table rules as the API serves them (`listStagesWithTableRules`, the one loader): the order it
   *  ranks by, the layer it came from, its pin and the sport's default. The Tie-breaks section is mounted for a table stage
   *  that has one; absent (a stage whose rules do not read), it shows none rather than a guessed order (R3). */
  stageTableRules?: Record<string, StageTableRules>;
  /** Match Day C3: the settings panels every stage card opens with (a test hook, like `DivisionRulesStrip`'s `initialOpen`; the page
   *  never sets it - the cards open closed). */
  initialOpenPanels?: readonly StagePanelKey[];
  /** Match Day PB1: the ids of stages whose card has something on it a person must see. A COMPLETED card starts folded to one line
   *  (owner 2026-11-02) - unless its id is in here, in which case it starts open. The seam for a warning that lives on a finished
   *  stage (W3's Swiss cut-drift notice feeds it). Optional: absent, nothing asks for attention and every completed card folds. */
  attentionStageIds?: readonly string[];
  /** Match Day E1 item 3: entrant id -> resolved crest URL, for the bracket tree a knockout card opens (the page's own
   *  `entrantLogos`, the same map it hands every other panel). Optional: absent, the tree draws no crests. */
  entrantBadges?: Record<string, string | null>;
  /** Match Day E1 item 3: fixture id -> its scoreline headline, for the same tree (`listFixtureHeadlines`, the page's own map). */
  headlines?: Record<string, string>;
  /** Match Day E1 fix round 1 (m2): the division's pools in display order with their labels (`poolLabelsInOrder`, built by the page), so a
   *  group stage's card names the pool on each round's bar. Optional: absent, the bars are the plain round. */
  pools?: readonly { id: string; label: string }[];
  /** Competition timezone (schedule settings) — every time renders in it. */
  tz: string;
  /** The GOVERNING venue clock (`settings.orgTz`, #448), resolved server-side.
   *  Distinct from `tz`, which is display-only and which a division may
   *  override: the board-slot grid must be anchored on this one or the offered
   *  times drift off the board by the offset difference. */
  orgTz: string;
  /** Documents menu goes through the Jul3/06 / v12 exports (Pro `exports` gate). */
  canExport: boolean;
  /** The division's resolved `schedule_settings.config.matchMinutes`
   *  (`page.tsx`, already falling back to `defaultMatchMinutes()`) — the
   *  grace in the run sheet's "Needs result" filter, which is
   *  `division-phase.ts`'s `result_missing`, the same predicate the "Needs
   *  you" panel counts (max-effort review, finding 2).
   *
   *  Resolved SERVER-side and passed down rather than read here: this panel's
   *  own `scheduleSettings` fetch runs only `if (canEdit)`, so a viewer would
   *  never have it, and `ScheduleConfig` lives under `@/server` where a client
   *  component cannot import it.
   *
   *  Optional for the same reason `venues`/`rosterDrift` above are —
   *  a dozen pre-existing `stages-panel-*.test.tsx` files build props without
   *  it. The fallback is `DEFAULT_MATCH_MINUTES`, the schema's own default
   *  pinned by `division-phase.test.ts`, never a number typed in here. */
  matchMinutes?: number;
  viewerPlan: ViewerPlan;
  /** Spec 2026-09-30 §2 (T6) — each fixture with a stream session up, as a person reads it (`openStreamStates`, read by
   *  the division page for an organiser). Each run-sheet row shows a "● Live" / "● Waiting for phone" chip linking to
   *  its fixture page with `?stream=open` — the division's path to Stop; the panel itself lives on the fixture page.
   *  Optional like `venues`: the pre-existing `stages-panel-*.test.tsx` props build without it (no chips). */
  streamStates?: Record<string, HoldState>;
  /** W2a fix round 1 (M10) — the recorded abandons awaiting their settle (ids; the division page's
   *  `listFixturesAwaitingSettle`), threaded to the run sheet so each row reads held. Optional: none by default. */
  awaitingSettle?: readonly string[];
  /** T16 — each online chess board's camera, flags and hold (`listRunSheetOnlinePlay`, read by the division page for
   *  an organiser), threaded to the run sheet's chips. Optional: none by default. */
  onlinePlay?: Record<string, RunSheetOnlinePlay>;
  /** The division plays online and has not been started, so no round can be opened yet (`listOpenRounds` answers
   *  none until it starts). The page sets it from the SAME gates as the Arbiter Panel's entry (an organiser who can act, a chess
   *  division that plays online now, the club offered online chess) plus the shared not-started predicate
   *  (`divisionScoringClosed`); true ⇒ the first stage card says to start the division - the Start button is on this tab, while the
   *  round itself is opened in the panel (phase 2, spec 2026-10-24-arbiter-round-column-design.md §8). Optional: absent ⇒ no hint. */
  onlineAwaitsStart?: boolean;
  /** Where the Arbiter Panel is, or null when it would not answer (online play off, the club not offered online chess; the page
   *  decides, with `canEdit`). T16 (T19 carry): a refused Unpair / Rebuild sends the organiser there when an online game stands
   *  behind a board it would clear (409 ONLINE_GAME_EXISTS) - null ⇒ the notice alone. Phase 2: it also decides whether the run
   *  sheet's online chips are links into the panel at all (null ⇒ plain text, never a link to a 404). */
  arbiterHref?: string | null;
  /** W3 T10 — the division's own status (`divisions.status`), for the rail's "Add late player" gate
   *  (`swissLateEntryOffered`: offered only once the division has started). Optional: absent ⇒ never offered. */
  divisionStatus?: string;
  /** W3 T12 Phase 2 (X-SW-17) — each Swiss stage's round count and "Add a round" state as the server judges them
   *  (`listSwissRoundControls`, read by the division page for an organiser on this tab). Drives the rail's "Rounds: N ·
   *  Edit" chip and More menu item. Optional: absent ⇒ neither (a viewer; the pre-existing panel tests). */
  swissRoundControls?: Record<string, SwissRoundControl>;
  /** W3 T17 (RB3-19, X-SW-25) — per Swiss stage id, who a correction moved across the cut AFTER the knockout began
   *  (`getSwissCutDrift`, read by the division page for an organiser on this tab; a stage with no drift is absent). Drives
   *  the amber "the bracket stands" notice in that stage's card. Optional: absent ⇒ none (a viewer; the older panel tests). */
  swissCutDrift?: Readonly<Record<string, SwissCutDrift>>;
  /** W4 T14 (RB4-Q5, X-QM-4): who a correction inside a completed knockout moved across its cut, by stage id, once the stage
   *  it feeds has started (`getKnockoutCutDrift`). Absent, or no entry: no notice. */
  knockoutCutDrift?: Readonly<Record<string, KnockoutCutDrift>>;
  /** Match Day B2 (spec 2026-10-31 §9): Match Day's address, handed down ONLY on a match day to an organiser who can edit (the
   *  division page asks the one `needsYouHome` rule the competition page's Open Match Day asks). The run sheet's unscheduled
   *  rows then carry "Find a court" (the word follows `sportKey`: pitch, table, board, rink). null/absent ⇒ not a match day: no link. */
  matchDayHref?: string | null;
  /** Match Day C2: the Division rules strip at the top of the tab (the division's match format, points and tie-break order).
   *  Built by the page, which reads what it needs; absent, no strip. */
  rulesStrip?: DivisionRulesStripProps;
  /** W4 T19 (X-LE-10; R24 pick 1A) — the players waiting to join a started root knockout (`listKnockoutWaiting`, read by the
   *  division page for an organiser on this tab): each stage card lists its own in a "Waiting to join the bracket" strip with
   *  one "Add to bracket" tap. Optional: absent ⇒ no strip (a viewer; the pre-existing panel tests). */
  knockoutWaiting?: readonly KnockoutWaitingEntrant[];
  /** W4 T20 (K5 "shown"; R24 pick 3A): each stage's draw seed, stage id -> the seed its newest Generate drew with
   *  (`listStageDrawSeeds`). A stage that drew nothing is absent; only a knockout-family card shows one. */
  drawSeeds?: Readonly<Record<string, number>>;
}

// PROMPT-66: stage kinds that accept an ad-hoc match (standings fold every
// fixture there). Bracket kinds have no slot for a loose fixture; ladder /
// americano have their own on-demand mechanisms. Swiss is out (W3 RB3-15 A,
// X-SW-21): the system pairs its rounds, and the server refuses the match by
// name; the rail shows that guidance in the trigger's place. Mirrors
// `ADHOC_STAGE_KINDS` in server/usecases/stages.ts.
const ADHOC_STAGE_KINDS = new Set(["league", "group"]);

/**
 * The slice of GET /api/v1/divisions/{id}/schedule-settings this panel reads
 * (quarter-hour-time-select design, "stages-panel does not currently hold the
 * division's schedule config"). Hand-declared rather than importing
 * `ScheduleSettingsWire`/`ScheduleSettings` wholesale — same stance as
 * `StageRow`/`FixtureRow` above: this panel only ever reads these three
 * fields off the response.
 *
 * THE ANCHOR IS RESOLVED ON `orgTz`, WHICH THIS WIRE DOES NOT CARRY. The
 * endpoint serves only `tz` — the resolved DISPLAY zone (`displayTz`
 * internally), which a division may override for display alone. Anchoring the
 * slot grid on it is the #448 defect: on a division with a stored zone
 * override the whole offered grid shifts by the offset difference, so every
 * time the organiser picks lands hours away from the board the rest of the
 * fixtures sit on.
 *
 * So `orgTz` arrives as a PROP instead, resolved server-side by the division
 * page exactly as the schedule page already resolves it for the board
 * (`resolveVenueTz(null, page.org.timezone)`). That keeps the governing clock
 * correct without widening this wire — the alternative (adding `orgTz` to the
 * response) means editing schemas.ts, usecases/schedule.ts and the exact-key
 * assertion in `schedule-settings-wire.test.ts`, for a value the rendering
 * pages already hold.
 */
interface DivisionScheduleSettings {
  config: {
    startAt?: string | null;
    matchMinutes?: number;
    gapMinutes?: number;
    /** Play hours, stored as instants. Clips the offered grid to the hours the
     *  division actually plays — without it the list walks to midnight and
     *  offers slots after the day is over. */
    sessionWindows?: BoardConfig["sessionWindows"];
    /** D2 capacity pre-check (widened, not a new fetch — the endpoint already
     *  serves the whole config; this panel just reads more of what it gets
     *  back). `endAt` is the one field that decides whether there is a
     *  bounded window to assess at all. */
    endAt?: string | null;
    courts?: string[];
    perEntrantMinRest?: number;
    blackouts?: BoardConfig["blackouts"];
  };
  tz: string;
}

/**
 * Board slots for this panel's two fixture-level clock fields (fixture
 * "When", add-match "When") — never quarter hours (design doc "Why
 * fixture-level fields differ": a 40/0 board's matches sit on
 * `09:00, 09:40, 10:20`, off any quarter-hour grid).
 *
 * `undefined` means "no explicit list" — `DateTimeField` falls back to
 * quarter hours on its own (design rule 2) when `options` is omitted, so a
 * fetch that hasn't landed yet, a failed fetch, a division with no settings
 * row (`startAt`/`matchMinutes` absent), or a config that resolves to fewer
 * than 2 slots must all land here rather than an empty or single-entry list.
 */
export function boardSlotOptionsFor(
  settings: DivisionScheduleSettings | null,
  /** The GOVERNING venue clock (#448) — never `settings.tz`, see above. */
  orgTz: string,
): string[] | undefined {
  if (settings === null) return undefined;
  // Whole thing behind one try, including the destructure: a response
  // missing `config` entirely (a mocked/mismatched wire, a future version
  // skew) must fall back the same as a malformed `startAt`, never crash the
  // panel mid-render — same "never surface a picker with no usable options"
  // stance as the fewer-than-2-slots case below.
  try {
    const { startAt, matchMinutes, gapMinutes, sessionWindows } = settings.config;
    if (startAt === undefined || startAt === null || matchMinutes === undefined) return undefined;
    const anchor = zonedTimeInput(startAt, orgTz);
    if (anchor === "") return undefined;
    // Same clipping the move panel applies, from the same helper — a grid that
    // ran past the division's play hours here and stopped at them there would
    // be two different answers to "which slots exist" on one board.
    const daily = windowsToDailyHours(sessionWindows ?? [], orgTz);
    const slots = boardSlotTimes({
      anchor,
      matchMinutes,
      gapMinutes: gapMinutes ?? 0,
      playFrom: daily?.from,
      playTo: daily?.to,
    });
    return slots.length >= 2 ? slots : undefined;
  } catch {
    return undefined;
  }
}

// Review finding m3: `CapacityStageRequest`, `capacityGateBlocks` and
// `capacityRequestForStage` lived here, and were DELETED with this wave.
// They were the Auto-schedule CTA's D2 capacity pre-check; Task 2 moved
// scheduling off the fixtures page entirely (owner ruling), which left all
// three exported, commented as if live, and called by nothing but their own
// test file. `stages-panel-capacity.test.tsx` went with them — it existed
// solely for these two functions, so keeping it would have been ~80 lines of
// tests guarding code no screen can reach. `git log -- apps/web/src/components/v2/stages-panel.tsx`
// has the full implementations if the pre-check is ever wanted on the
// Schedule page, where the control now lives.

/** How often the run sheet re-reads the clock. Its NOW line and "result
 *  missing" turn on kick-off times and match length, both whole minutes, so a
 *  minute tick is as fresh as anything it can show without re-rendering this
 *  whole panel every second. */
const RUN_SHEET_NOW_TICK_MS = 60_000;

export function StagesPanel({ divisionId, competitionId, orgSlug, compSlug, divSlug, stages, fixtures, entrantNames, entrantBadges, headlines, pools, activeEntrantIds, entrantSeeds, entrantSwissFirstRounds, venues = [], rosterDrift = {}, canEdit, canSettle, sportKey, variantKey = null, divisionConfig = {}, ruleDict, pointsDict, formatLockedStageIds = [], pinnedStagePoints = {}, stageTableRules = {}, tz, orgTz, canExport, matchMinutes = DEFAULT_MATCH_MINUTES, viewerPlan, streamStates, awaitingSettle, onlinePlay, onlineAwaitsStart = false, arbiterHref = null, matchDayHref = null, rulesStrip, initialOpenPanels, attentionStageIds, divisionStatus, swissRoundControls, entrantStatuses, swissCutDrift, knockoutCutDrift, knockoutWaiting = [], drawSeeds = {} }: Props) {
  const msg = useMsg();
  // Owner-approved redesign, "Option A" (Task 10 follow-up) — the stage
  // card body's fixtures-progress summary, below. `useMsgPlural`, the
  // non-throwing sibling of `usePlural` (dict-provider.tsx) and `useMsg`'s
  // own counterpart: this component is rendered bare (no `<DictProvider>`)
  // by several of this file's own unit tests, so the throwing `usePlural`
  // would red all of them for an unrelated reason.
  const msgPlural = useMsgPlural();
  // Only for Intl.ListFormat in attachmentWarning below — the rebuild
  // confirm dialog joins its "this also clears …" list per locale. The
  // non-throwing reader on purpose: this panel is rendered bare (no
  // DictProvider) throughout its own component tests, and the locale is
  // formatting-only here.
  const locale = useLocaleOrDefault();
  const confirmDialog = useConfirm();
  const router = useRouter();
  // P9 pass 4d: id -> venue-qualified display name, reusing the SAME
  // `resolveCourtNames`/`buildCourtDirectory` rule the board's own
  // `courtNamesById` applies (schedule-board.tsx) — never a second
  // "is this name ambiguous" implementation. Feeds both the "now playing"
  // strip below and every FixtureLine's badge/editor.
  const courtNamesById = useMemo(() => resolveCourtNames(venues), [venues]);
  // The draw list's feeder labels, keyed by fixture id — "Winner of R1·3" for
  // a seat no result has filled yet, instead of "TBD".
  //
  // Built from the WHOLE division fixture list, here, because this is the one
  // place that holds it: `<RunSheet>` only ever sees `blocks`, which
  // `buildRunSheet` has already grouped and filtered (R7(c) drops an untimed
  // plain-league bye outright), so a seat's label would otherwise depend on
  // whether its feeder happened to survive grouping.
  //
  // `feedLabels` is the schedule board's own builder, unchanged and
  // un-forked — the two organiser surfaces that render these same fixtures
  // now resolve an empty seat through ONE function and ONE pair of dictionary
  // keys, which is exactly the drift this closes. It needs no query of its
  // own: the four feed columns ride `listDivisionFixtures`'s existing select.
  const runSheetFeedLabels = useMemo(() => feedLabels(fixtures.map(toFeedRow)), [fixtures]);
  // #622 tag suggestions for the per-stage editors below: every tag any court
  // in the loaded venues carries, ranked by use (the same rule
  // division-settings.tsx and venues-panel.tsx apply). Read off the `venues`
  // prop this panel already receives — never a second fetch per stage card.
  const courtTagSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of venues) for (const c of v.courts) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
  }, [venues]);
  const [error, setError] = useState<string | null>(null);
  // W3 T13 — "Finish the Swiss now" under a red line whose Swiss refusal offers it (`canFinish: true` with its plan: a
  // Pair's shrunk-field 409, the More menu's Add a round at the hard maximum). Keyed to the line's own text, so any later
  // line — another refusal, another write — never keeps a stale button.
  const [finishOffer, setFinishOffer] = useState<{ stageId: string; plan: SwissFinishPlan; text: string } | null>(null);
  // W3 app-B T4 (SW-H1 on the desk; X-SW-3) — a Pair next refused SWISS_NO_LEGAL_PAIRING: the amber notice that names the
  // round and the reason with its recovery inside it (Finish after round k). Keys, not text, so the sentence follows the
  // locale; `plan` is the Finish it confirms (null: not offered). Cleared by any later act() / Swiss write, exactly as the
  // red line is.
  const [pairingRefusal, setPairingRefusal] = useState<{ stageId: string; notice: NoPairingNotice; plan: SwissFinishPlan | null } | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // stage id in flight
  const [notice, setNotice] = useState<string | null>(null);
  // "Générer les matchs" precondition-not-met (design/fix-ui/03 §"misleading
  // success message"): distinct from `notice` (success, green) and `error`
  // (generic failure, red) — an amber, actionable "here's what to fix" state
  // so it's never confused with the "nothing new — up to date" success copy.
  const [warning, setWarning] = useState<string | null>(null);
  // W3 app-B T7 (X-SW-10): the look-ahead's caution after a Pair that landed - the NEXT round may not be possible (or could
  // not be checked in time). Its own amber line, never folded into `warning`: a stage above its safe maximum also carries the
  // round-count caution on the same answer, and one paragraph would run the two together. The verdict and the round it
  // follows, not text, so the sentence follows the locale; cleared by every later act() / Swiss write, as `warning` is.
  const [nextRound, setNextRound] = useState<NextRoundNotice | null>(null);
  // T16: a refused Unpair / Rebuild over a board an online game stands behind (OnlineGameExistsNotice).
  const [gameExists, setGameExists] = useState(false);
  // Set after an inline reschedule lands: the notice grows an Undo button
  // that steps the division history back one event (Jul3/03).
  const [undoable, setUndoable] = useState(false);
  // PROMPT-66: stage id whose inline "Add match" form is open.
  const [addingTo, setAddingTo] = useState<string | null>(null);
  // Task 10 — stage id whose phone "Stage tools" bottom sheet is open.
  // Owned here, not as a local `useState` inside `<StageRail>` (stage-
  // rail.tsx's own header explains why: `expandWithHooks`, the test harness
  // two unrelated unit tests already walk `<StageRail>` through, is
  // deliberately read-only and throws on any stateful hook). Same
  // shared-single-value shape as `addingTo` just above — only one stage's
  // sheet can usefully be open at a time, since a second open sheet would be
  // a second `position:fixed` overlay stacked on the first.
  const [openRailFor, setOpenRailFor] = useState<string | null>(null);
  // Board slots for the fixture "When" / add-match "When" fields (quarter-
  // hour-time-select design). This panel doesn't otherwise hold the
  // division's schedule config, so it's fetched once here; a failed fetch or
  // a division with no settings row leaves this null and `boardSlotOptionsFor`
  // falls back to quarter hours. Fetched only for editors — viewers never see
  // either field this feeds.
  const [scheduleSettings, setScheduleSettings] = useState<DivisionScheduleSettings | null>(null);
  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    apiV1<DivisionScheduleSettings>(`/api/v1/divisions/${divisionId}/schedule-settings`)
      .then((data) => {
        if (!cancelled) setScheduleSettings(data);
      })
      .catch(() => {
        // Falls back to quarter hours (design rule 2) — nothing to surface.
      });
    return () => {
      cancelled = true;
    };
  }, [divisionId, canEdit]);
  const boardSlotOptions = boardSlotOptionsFor(scheduleSettings, orgTz);

  // Competition Desk W2 (Task 4) — the run sheet's own filter segment. It mounts on "All" ALWAYS (Match Day PB1, owner
  // 2026-11-02): it used to open on "Today" on a match day, which hid every other round of the division behind a chip an
  // organiser had to find. Match Day is where "today" lives now. (Spec 2026-09-30 §2: the checkout return lands on the fixture
  // page, so D2's `initialRunSheetFilter` is gone.)
  const [filter, setFilter] = useState<RunSheetFilter>("all");
  // Match Day C3: which of each stage's three settings panels (Match rules / Points / Tie-breaks) is open, as `${stageId}:${panel}`.
  // Owned here, like `addingTo` and `openRailFor`, so the header's buttons (stateless inline JSX: the test harness never walks a
  // nested component's render) and the panels they open share it. Several can be open at once.
  const [openPanels, setOpenPanels] = useState<ReadonlySet<string>>(
    () => new Set(stages.flatMap((st) => (initialOpenPanels ?? []).map((panel) => `${st.id}:${panel}`))),
  );
  const panelOpen = (stageId: string, panel: StagePanelKey): boolean => openPanels.has(`${stageId}:${panel}`);
  // Match Day PB1: which completed cards the person has folded / opened by hand, by stage id - their tap over the card's default
  // (`stageCardCollapse`). Kept for the page visit and nothing longer: no storage, a reload starts every card from its default again.
  const [stageToggled, setStageToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // Controller ruling 2: the card's default is decided the FIRST time it is seen and then held (`latchedOpen`): a stage that completes
  // during the visit stays open. And the stages with a warning on them at the last render (review m3): a warning that ARRIVES clears a
  // person's fold, so it is never hidden behind a choice made before it existed. Both are written during render, never in an effect.
  const [stageLatch, setStageLatch] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [attentionWas, setAttentionWas] = useState<ReadonlySet<string>>(() => new Set(attentionStageIds ?? []));
  const togglePanel = (stageId: string, panel: StagePanelKey) =>
    setOpenPanels((prev) => {
      const next = new Set(prev);
      const key = `${stageId}:${panel}`;
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const closePanel = (stageId: string, panel: RulesPanel) => {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      next.delete(`${stageId}:${panel}`);
      return next;
    });
    // Save / Cancel / Use-division unmount the very button the keyboard was on. Hand focus back to the header button that opened the
    // panel (review M-5 of the stage-rules row: focus follows the editor in AND out); on a phone that button is hidden (the three
    // live in the "Stage tools" sheet there), so the sheet's own trigger takes it.
    requestAnimationFrame(() => {
      const card = document.querySelector(`section[data-stage-id="${stageId}"]`);
      const tool = card?.querySelector<HTMLElement>(`[data-testid="stage-tool-${panel}"]`);
      const target = tool !== null && tool !== undefined && tool.offsetParent !== null ? tool : card?.querySelector<HTMLElement>('[data-testid="stage-rail-trigger"]');
      target?.focus();
    });
  };
  // Competition Desk W2 (Task 4/C5) — the run sheet's NOW rule. Never at
  // module scope (that freezes at first import, so NOW would stick to deploy
  // time), and never a bare `Date.now()` in this body either: that only moved
  // when something unrelated re-rendered the panel. `useNow` re-reads it on a
  // tick, so the NOW line and "result missing" advance on their own. Declared
  // above the empty-stages early return, as every hook must be.
  const nowMs = useNow(RUN_SHEET_NOW_TICK_MS);

  async function undoLast() {
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/undo`, { method: "POST", json: {} });
      setNotice(msg("schedule.notice.undone"));
      setUndoable(false);
      router.refresh();
    } catch (err) {
      setError(undoRefusalMessage(err, msg));
    }
  }

  // W3 T12 Phase 2 (X-SW-17) — the Swiss stage writes outside `act`: the rounds dialog's Save and "Add a round" (the
  // rail's More item, and the recovery a SWISS_ROUNDS_LOCKED refusal offers in the dialog). (The chess colours switch was
  // a third until UI5 item 4 removed it: a chess Swiss always balances colours.)
  // Each resolves null when it landed (said in the notice channel, the page refreshed), else the refusal; `report` says
  // it in this panel's own error line too — false when the dialog says it inside itself. A refusal refreshes the page as
  // well (T12 Fix round 1, review m4): these doors offer only what the desk's last read says goes through, so a server
  // refusal means that read is stale — after a LOCKED answer the chip turns fixed and More offers Add a round.
  async function swissStageWrite(
    stageId: string,
    write: () => Promise<string>,
    report: boolean,
    refusalOf: (err: unknown) => SwissRoundsRefusal = (err) => swissStageRefusal(err, msg, msgPlural, locale),
  ): Promise<SwissRoundsRefusal | null> {
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setWarning(null);
    setNextRound(null);
    setPairingRefusal(null);
    setBusy(stageId);
    try {
      setNotice(await write());
      router.refresh();
      return null;
    } catch (err) {
      const refusal = refusalOf(err);
      if (report) setError(refusal.text);
      const plan = report ? swissFinishPlanOf(refusal.extra) : null;
      setFinishOffer(plan ? { stageId, plan, text: refusal.text } : null);
      // T13 Fix round 1 (review I1): on a phone the line is said under the Stage-tools sheet; close it so the refusal and
      // its recovery show. (`open` drives the phone sheet only; at md and up the rail is inline either way.)
      if (report) setOpenRailFor(null);
      if (err instanceof ApiV1Error) router.refresh();
      return refusal;
    } finally {
      setBusy(null);
    }
  }

  const saveSwissRounds = (stageId: string, rounds: number) =>
    swissStageWrite(
      stageId,
      async () => {
        const out = await apiV1<{
          rounds: number;
          swiss_rounds: SwissRoundsNotice | null;
          shells?: { slots_freed?: number };
        }>(`/api/v1/stages/${stageId}`, {
          method: "PATCH",
          json: { rounds },
        });
        // Above the safe maximum: the same amber caution a Generate's answer carries (T11).
        setWarning(out.swiss_rounds ? swissRoundsWarnNotice(out.swiss_rounds, msgPlural) : null);
        // T12 Fix round 1 (review m3): removed rounds that held a time or court free it — said, as a Rebuild says it.
        const freed = out.shells?.slots_freed ?? 0;
        const saved = msgPlural("schedule.notice.roundsSaved", out.rounds);
        return freed > 0 ? `${saved} ${msgPlural("schedule.notice.roundsSlotsFreed", freed)}` : saved;
      },
      false,
    );

  const addSwissRoundTo = (stageId: string, from: "more" | "dialog") =>
    swissStageWrite(
      stageId,
      async () => {
        const out = await apiV1<{ rounds: number }>(`/api/v1/stages/${stageId}/swiss/add-round`, { method: "POST", json: {} });
        return msg("schedule.notice.roundAdded", { round: out.rounds });
      },
      from === "more",
    );

  // W3 T13 (RB3-20, X-SW-26) — "Finish the Swiss now": the rail's More item, the rounds dialog's recovery and the red
  // line's. Confirmed first (danger: rounds go for good, Undo cannot reverse it), then posted; the panel says the answer.
  const finishSwissStage = async (stageId: string, plan: SwissFinishPlan): Promise<SwissRoundsRefusal | null> => {
    if (!(await confirmDialog(swissFinishConfirm(plan, msg)))) return null;
    return swissStageWrite(
      stageId,
      async () => {
        const out = await apiV1<SwissFinishAnswer>(`/api/v1/stages/${stageId}/swiss/finish`, { method: "POST", json: {} });
        // Fix round 1 (review m5): `completed: false` is not "finished" — said as such.
        return swissFinishedNotice(out, msg, msgPlural);
      },
      true,
      (err) => swissFinishRefusal(err, msg, msgPlural, locale),
    );
  };

  async function act(
    stageId: string,
    action: "generate" | "complete" | "delete" | "unpair",
    // Swiss round 1 only: the organiser's split-button pick, already reduced
    // to "the non-default mode, or nothing" by `swissPairingOverride`.
    opts?: { pairing?: SwissPairingMode },
  ): Promise<boolean> {
    // Resolves whether the action LANDED — the rail's split button clears its
    // round-1 pick only on `true` (review M2). A refused or failed action is
    // caught and shown below, and resolves `false`.
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setWarning(null);
    setNextRound(null);
    setPairingRefusal(null);
    setGameExists(false);
    setBusy(stageId);
    try {
      if (action === "delete") {
        await apiV1(`/api/v1/stages/${stageId}`, { method: "DELETE" });
        setNotice(msg("schedule.notice.stageDeleted"));
      } else if (action === "generate") {
        const out = await apiV1<GenerateNoticeWire>(`/api/v1/stages/${stageId}/generate`, {
          method: "POST",
          // `{}` stays the body for every ordinary press — the server still
          // accepts it and applies its own default.
          json: opts?.pairing ? { pairing: opts.pairing } : {},
        });
        setNotice(generateNoticeText(out, msg, msgPlural, locale));
        // W3 T11 review m1: a caution, not a success — the amber channel.
        setWarning(generateWarningText(out, msgPlural));
        // W3 app-B T7 (X-SW-10): and the look-ahead's caution, in its own line. Pair next is pressed inside the phone's
        // Stage-tools sheet and the line is said outside it, so - as a refusal does - a caution closes the sheet to be
        // seen; the ordinary Pair leaves it as it was.
        const next = nextRoundNoticeOf(out);
        setNextRound(next);
        if (next !== null) setOpenRailFor(null);
      } else if (action === "unpair") {
        const out = await apiV1<{ cleared: number; round: number }>(
          `/api/v1/stages/${stageId}/unpair`,
          { method: "POST", json: {} },
        );
        setNotice(msg("schedule.notice.unpaired", { round: out.round }));
      } else {
        const out = await apiV1<{
          completed: boolean;
          qualified?: { entrants: string[] };
          next_stage_fixtures?: number;
          division_completed?: boolean;
        }>(`/api/v1/stages/${stageId}/complete`, { method: "POST", json: {} });
        setNotice(
          !out.completed
            ? msg("schedule.notice.notReady")
            : out.division_completed
              ? msg("schedule.notice.divisionFinished")
              : out.next_stage_fixtures !== undefined
                ? msg("schedule.notice.advanced", {
                    n: out.qualified?.entrants.length ?? "",
                    gen: out.next_stage_fixtures,
                  })
                : msg("schedule.notice.completed"),
        );
      }
      router.refresh();
      return true;
    } catch (err) {
      // Unreadable details (a stale server) read null: the generic Swiss branch below says the generic sentence.
      const noPairing = err instanceof ApiV1Error && err.code === "SWISS_NO_LEGAL_PAIRING" ? noPairingDetailsOf(err.extra) : null;
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        if (action === "unpair" && isOnlineGameExists(err)) {
          setGameExists(true);
        } else if (action === "unpair") {
          setError(msg("schedule.error.unpairFailed"));
        } else if (noPairing !== null) {
          // W3 app-B T4 (SW-H1; X-SW-3): the amber notice that says WHY and carries the recovery — never the red line, and
          // never the "nothing new" a round that seated nobody used to read as. Finish is the only recovery (Change rounds
          // was dropped: a refusal past round 1 follows a started round, and the count is fixed from then on). Finish
          // needs a readable round count, so with none the plan is null and the sentence stops promising it too. The
          // phone's Stage-tools sheet closes, as the generic branch below does, so the notice is what shows.
          const stageRounds = swissRoundControls?.[stageId]?.rounds ?? stages.find((s) => s.id === stageId)?.config?.rounds;
          const plan = noPairingFinishPlan(noPairing, stageRounds);
          setPairingRefusal({ stageId, notice: noPairingNotice(plan ? noPairing : { ...noPairing, canFinish: false }), plan });
          setOpenRailFor(null);
        } else if (err instanceof ApiV1Error && isSwissRefusalCode(err.code)) {
          // W3 T11: a Swiss refusal (SWISS_ROUNDS_ABOVE_MAX on a Generate or Pair next) in the reader's language, with
          // what to do next — never the server's English sentence. T13: and Finish under it when the refusal offers it.
          const text = swissRefusalText(err.code, err.extra, msg, msgPlural);
          setError(text);
          const plan = swissFinishPlanOf(err.extra);
          setFinishOffer(plan ? { stageId, plan, text } : null);
          // T13 Fix round 1 (review I1): Pair next is pressed inside the phone's Stage-tools sheet, and this line — with the
          // Finish it may offer — is said outside it. Close the sheet so the refusal and its recovery are what shows.
          setOpenRailFor(null);
        } else {
          // The stage list lets an early Generate on a waiting stage name
          // both stages (generatePreconditionMessage).
          const classified = classifyActError(
            err,
            msg,
            locale,
            (id) => stages.find((s) => s.id === id)?.name,
            matchNamerFor(fixtures, entrantNames),
          );
          if (classified.tone === "warning") setWarning(classified.text);
          else setError(classified.text);
          if (classified.refresh) router.refresh();
        }
      }
      return false;
    } finally {
      setBusy(null);
    }
  }

  // F3 Task 5 (5b) — replace, not top up: confirm (destructive, so the same
  // danger-tone dialog as delete), then POST /rebuild. Never auto-run
  // (ruling 7, restated in the F3 Task 5 plan) — this only ever runs from
  // the organiser's own click on the banner above.
  async function rebuildStage(stageId: string) {
    const ok = await confirmDialog({
      title: msg("progression.rosterDrift.confirmTitle"),
      body: [msg("progression.rosterDrift.confirmBody"), attachmentWarning(rosterDrift[stageId], msg, locale)]
        .filter(Boolean)
        .join(" "),
      confirmLabel: msg("progression.rosterDrift.confirmLabel"),
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setWarning(null);
    setNextRound(null);
    // Final review m1: a refusal notice (and its live Finish) describes the stage this Rebuild replaces — cleared, as act and
    // swissStageWrite clear it.
    setPairingRefusal(null);
    setGameExists(false);
    setBusy(stageId);
    try {
      const out = await apiV1<{ created: number; existing: number } & RebuiltOutcome>(
        `/api/v1/stages/${stageId}/rebuild`,
        { method: "POST", json: {} },
      );
      setNotice(rebuiltNotice(out, msg));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        // 409 STAGE_HAS_RESULTS (hard constraint 1): a ghost can be reported
        // by getStageRosterDrift even when its fixture already has a result
        // — the signal and the guard are independent (plan, required test
        // coverage) — so this is a real, reachable outcome, not just a
        // defence-in-depth 422 the UI never offers a button for.
        const blocked = rebuildBlockedMessage(err, msg);
        if (isOnlineGameExists(err)) {
          setGameExists(true);
        } else if (blocked) {
          setWarning(blocked);
        } else {
          setError(rebuildErrorText(err, msg, msgPlural));
        }
      }
    } finally {
      setBusy(null);
    }
  }

  if (stages.length === 0) {
    // The division's rules stay reachable with no stage yet (Match Day C2: the strip is their one editor).
    return (
      <div className="space-y-6">
        {rulesStrip !== undefined && <DivisionRulesStrip {...rulesStrip} />}
        {/* Fix round 1 (review m9): the pointer at the Format button is an editor's - a reader has no such button. */}
        <p className="text-sm text-slate-500" data-testid="stages-empty">{msg(canEdit ? "schedule.noStages" : "schedule.noStagesReader")}</p>
      </div>
    );
  }

  // Competition Desk W2 (Task 4) + Match Day C3: the division's run sheet, `buildRunSheet` over EVERY stage's fixtures (day groups
  // merged across every non-bracket stage, one bracket block per bracket stage, one "Not yet scheduled" group last - owner rulings
  // A2/3). C3 mounts it once PER STAGE (`RunSheet embedded`, narrowed to the stage, inside that stage's card) under ONE filter bar
  // above the cards. `nowMs` is the panel's ticking `useNow` clock (C5), never a module-scope `Date.now()`.
  const runSheetBlocks = buildRunSheet({ fixtures: fixtures.map(toRunSheetFixture), stages, tz, nowMs });
  const runSheetProps = {
    blocks: runSheetBlocks,
    stages,
    tz,
    orgTz,
    nowMs,
    matchMinutes,
    entrantNames,
    // W3 T15 ruling 2: a DISQUALIFIED entrant's cascade walkover is worded as the disqualification on every row (merge with
    // Match Day #1103: the division-wide mount that carried it is gone; each stage card's sheet spreads these props).
    entrantStatuses,
    courtNames: courtNamesById,
    // R35 - the panel already holds these for `StageCourtTagsEditor` and the (retired) FixtureLine picker; they now reach each
    // row's inline editor instead of a second venues fetch.
    venues,
    canEdit,
    canSettle: canSettle ?? canEdit,
    hrefFor: (f: { fixture_no: number }) => routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no),
    filter,
    onFilter: setFilter,
    boardSlotOptions,
    onRescheduled: () => {
      setNotice(msg("schedule.rescheduled"));
      setUndoable(true);
    },
    streamStates,
    awaitingSettle,
    onlinePlay,
    arbiterHrefFor: arbiterHref === null ? undefined : (fixtureId: string) => routes.divisionArbiter(orgSlug, compSlug, divSlug, fixtureId),
    matchDayHref: matchDayHref ?? undefined,
    /* Fix round 1 (I1): "Find a pitch / table / board / rink", by the division's sport (an absent one is the court). */
    venueNoun: venueNoun(sportKey),
    /* An unfilled bracket seat is named by its FEEDER ("Winner of R1·3"), not "TBD" - the same `feedLabels()` builder the schedule
       board renders these very fixtures with. Derived from the WHOLE division fixture list (never `blocks`, which is grouped and
       filtered), and never a second query. */
    feedLabels: runSheetFeedLabels,
    pools,
  };
  // Does the filter leave ANY row in ANY stage? When none does, the panel says so once (with the way back) and the stage sheets stay
  // quiet instead of each repeating it.
  const anyRowsKept = runSheetHasRows(runSheetBlocks, filter, {
    stageId: null,
    tz,
    today: dayKeyInTz(nowMs, tz),
    nowMs,
    matchMinutes,
    streamStates,
    onlinePlay,
  });

  return (
    <div className="space-y-6">
      {rulesStrip !== undefined && <DivisionRulesStrip {...rulesStrip} />}
      {notice && (
        <p className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
          {undoable && (
            <button
              type="button"
              data-testid="schedule-undo"
              onClick={() => void undoLast()}
              className="font-semibold underline hover:no-underline"
            >
              {msg("schedule.undo")}
            </button>
          )}
        </p>
      )}
      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {/* Precondition-not-met (amber, actionable) — never the green success
          banner: "Générer les matchs" did nothing because the entrants can't
          fill the configured groups yet, not because it was already done. */}
      {warning && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="schedule-warning">
          {warning}
        </p>
      )}
      {/* W3 app-B T7 (X-SW-10): the Pair landed and the next round may not be possible. The house amber channel, a line of its
          own beside the caution above; no button - the way out (Finish after the round just paired) is said in the sentence,
          and the rail offers it once that round is decided. */}
      {nextRound && (
        <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="swiss-next-round-warning">
          {nextRoundText(nextRound, msg)}
        </p>
      )}
      {/* W3 app-B T4 (SW-H1; X-SW-3): Pair next refused for want of a legal pairing. Amber like the caution above, and the
          recovery sits INSIDE it so the organiser reads the reason and acts in one place: Finish after round k (the house
          confirm, then the stage's finish route). A full-width button on a phone, auto width from `sm`. */}
      {pairingRefusal && (
        <div
          role="status"
          data-testid="schedule-pairing-refusal"
          className="flex flex-col gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <p>{noPairingText(pairingRefusal.notice, msg)}</p>
          {pairingRefusal.plan !== null && (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                data-testid="schedule-pairing-finish"
                disabled={busy !== null}
                onClick={() => void finishSwissStage(pairingRefusal.stageId, pairingRefusal.plan!)}
                className="btn btn-primary min-h-11 px-3 py-1.5 text-sm"
              >
                {msg(NO_PAIRING_ACTION_KEY.finish, { n: pairingRefusal.plan.after })}
              </button>
            </div>
          )}
        </div>
      )}
      {gameExists && <OnlineGameExistsNotice arbiterHref={arbiterHref} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600" data-testid="schedule-error">
          {error}
        </p>
      )}
      {error && finishOffer?.text === error && (
        <button
          type="button"
          data-testid="schedule-finish-swiss"
          disabled={busy !== null}
          onClick={() => void finishSwissStage(finishOffer.stageId, finishOffer.plan)}
          className="btn btn-ghost min-h-11 self-start px-3 py-1.5 text-sm"
        >
          {msg("stage.more.finishSwiss")}
        </button>
      )}

      {/* Print (item 8). The tz caption that used to sit beside this moved
          into `<RunSheet>`, under its filter segment (Competition Desk W2,
          Task 4/C2) — same `data-testid="tz-caption"`, so nothing that
          locates it by testid needs to change. `DocumentsMenu` itself is
          UNCHANGED here for now: it moves to the stage rail in Task 5, which
          does not exist yet. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1" />
        {canExport && <DocumentsMenu divisionId={divisionId} competitionId={competitionId} />}
      </div>

      {/* Match Day B1 (spec 2026-10-31 §9, "remove the Now playing banner"): the in-play strip that floated above the rounds
          is gone — what is being played is Match Day's to show. The run sheet below still lists every match, in play or not. */}

      {/* Competition Desk (2026-09-02, task 6): stages always in seq order —
          the old complete-sinks-last rule reshuffled a running division's own
          progression order, which fought the phase/attention model's stage
          identification (both key off `seq`). */}
      {/* Match Day C3: the division's fixtures filter, then the stage cards, each holding its own stage's rows. The wrapper keeps the
          `run-sheet` testid the desk's tests and page-level scans know (one per division, absent when there are no fixtures). */}
      <div data-testid={runSheetBlocks.length > 0 ? "run-sheet" : undefined} className="space-y-6">
        {runSheetBlocks.length > 0 && (
          <div className="card">
            <RunSheetFilterBar
              blocks={runSheetBlocks}
              tz={tz}
              nowMs={nowMs}
              matchMinutes={matchMinutes}
              onlinePlay={onlinePlay}
              filter={filter}
              onFilter={setFilter}
            />
          </div>
        )}
        {runSheetBlocks.length > 0 && !anyRowsKept && (
          <div data-testid="run-sheet-empty" className="card px-4 py-10 text-center">
            <p className="text-sm text-slate-500">
              {msg("runsheet.emptyFilter.message", { filter: msg(RUN_SHEET_FILTER_LABEL[filter]) })}
            </p>
            {filter !== "all" && (
              <button
                type="button"
                data-testid="run-sheet-empty-show-all"
                onClick={() => setFilter("all")}
                className="btn btn-ghost mt-3 min-h-11 px-3 text-xs"
              >
                {msg("runsheet.filter.all")}
              </button>
            )}
          </div>
        )}
      {[...stages]
        .sort((a, b) => a.seq - b.seq)
        .map((stage) => {
        const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
        // Pinned unscheduled section (v3/04 §3 item 3): count + CTA now live
        // on `<StageRail>` (Task 4, fix round 1 — see stage-rail.tsx's own
        // header for the harness fix that made this possible) — this is only
        // the count itself; the row LIST renders once, division-wide, in the
        // `<RunSheet>` mounted below.
        //
        // `isUnscheduledFixture`, never a fourth hand-written copy of the same
        // two clauses (max-effort review, finding 11 — "three numbers describe
        // the same fact"). It is the W1 ledger's own predicate, and it is what
        // the run sheet's chip a few centimetres below this badge already asks,
        // so the two cannot answer differently. The stage badge stays a
        // DIFFERENT number from the chip — per-stage against division-wide —
        // which is exactly why the heading beside it now names its scope.
        const unscheduled = stageFixtures.filter(
          (f) =>
            isUnscheduledFixture({ status: f.status, scheduledAt: f.scheduled_at }) &&
            !isBye(toRunSheetFixture(f)),
        );
        // Owner-approved redesign, "Option A" (Task 10 follow-up) — the
        // stage card BODY used to say nothing beyond the header (measured:
        // 814x234px of nothing but a title and a rule). This computes the
        // fixtures-progress COUNTS line below, from data already fetched
        // here (`stageFixtures`, per-fixture `status`) — no new query, no
        // new prop drilling. Byes excluded throughout, the SAME
        // `!isBye(toRunSheetFixture(f))` guard `unscheduled` above already
        // uses — the two counts must never disagree about what counts as a
        // real fixture. "N done" is NOT filtered here: it is `roundDone`
        // (below, beside `stageCounts`), the SAME number the stage's round
        // bars add up to - a walkover, a settled abandonment and a
        // cancellation are done, a match held for its settle is not.
        // `in_play` gets its OWN clause (never folded into "done"), and a
        // held match its own too. "N to schedule" is `isUnscheduledFixture`,
        // which requires `status === "scheduled"`, so a settled match is
        // never "to schedule" - no match is counted by two clauses.
        //
        // Owner ruling (this round, "remove the progress bar, keep the
        // counts line"): a solid-bar-plus-visual-weight summary earned its
        // place only while it could show MIXED state — with every fixture
        // scheduled it rendered as a full-width block that said nothing the
        // text below did not say better, on a card whose real job is the
        // actions beneath it. The void Option A was built to fill is closed
        // by Option B's stacking, not by the bar, so removing it does not
        // reopen that gap. `stageInPlay` below now feeds ONLY
        // the counts line; `stageNonByeCount` also still gates the whole
        // block below (an all-bye stage renders neither the counts nor,
        // formerly, the bar).
        const stageInPlay = stageFixtures.filter(
          (f) => f.status === "in_play" && !isBye(toRunSheetFixture(f)),
        );
        const stageNonByeCount = stageFixtures.filter((f) => !isBye(toRunSheetFixture(f))).length;
        // D12 (T16): online boards whose round nobody has opened — not invited, not playable, owing nothing yet.
        const stageNotOpened = stageFixtures.filter((f) => onlinePlay?.[f.id]?.unopened === true);
        // Match Day C3: the buttons follow the stage's state. `stageCounts` over ALL the stage's fixtures - Swiss unseated shells and
        // byes included - and never behind a fallback: a count that quietly read zero would unlock Complete over matches the card
        // cannot see. (It throws on a status the schema does not have, which is the loud failure we want.) The Complete hint's N is the
        // stage's matches, byes out.
        // A HELD match is open: `needs_decision`, or a plain abandon the page lists as awaiting its settle (`awaitingSettle`, the
        // list the run sheet's own rows read - not re-derived here), which keeps `status = 'abandoned'` while the verdict is owed.
        const awaitingIds = new Set(awaitingSettle ?? []);
        const counts = stageCounts(stageFixtures, awaitingIds);
        // Match Day E1 fix round 1 (controller ruling): the counts line's "N done" is the SAME number the stage's round bars add up to -
        // `roundDone` over the stage's real matches (byes out), i.e. `stageCounts`' settled bucket with a held match open. It used to be a
        // strict "decided / finalized" filter of its own, which read "1 played" beside the bar's "2 of 3 done" once a walkover existed.
        const stageDone = roundDone(stageFixtures.map(toRunSheetFixture), awaitingIds).done;
        // The stage's three settings buttons, built ONCE: the header row (from `md`) and the "Stage tools" sheet's top rows (below `md`,
        // an editor only) are the same list. Points and Tie-breaks only on a table stage whose rules read.
        const takesPoints = stageTakesPoints(stage.kind);
        // Match Day E1 item 3: a single-elimination knockout's tree opens from here too - LAST in the group, for everyone who can read the
        // card (the page used to draw it above the cards for every viewer). `bracketPlacement` is the one predicate for who draws what:
        // a double-elimination layout or a stepladder is not a card's to draw and keeps its place on the page.
        const bracketInCard = bracketPlacement(stage.kind, stageFixtures) === "card";
        // SCF fix round 1 (owner 2026-11-03: "every knockout stage card gets a Bracket button"): EVERY bracket-kind card carries the button,
        // and `bracketAccess` says what it does - open the tree in the card (`toggle`), jump to the page's tree (`link`, the double
        // elimination layout and the stepladder, whose trees stay on the page), or sit greyed with its reason until there is something to
        // show (`generate`: no fixtures yet; `unavailable`: fixtures no view can draw - never a button that opens nothing).
        const bracketKind = bracketAccess(stage.kind, stageFixtures);
        const settingsTools: { panel: StagePanelKey; label: string; access?: "link" | "generate" | "unavailable" }[] = [
          ...(sportKey === undefined
            ? []
            : [
                { panel: "format" as const, label: msg("rulesStrip.format") },
                ...(takesPoints ? [{ panel: "points" as const, label: msg("stagePoints.title") }] : []),
                ...(takesPoints && stageTableRules[stage.id] !== undefined
                  ? [{ panel: "tiebreaks" as const, label: msg("stageTiebreaks.title") }]
                  : []),
              ]),
          ...(bracketKind === null
            ? []
            : [{ panel: "bracket" as const, label: msg("bracket.title"), ...(bracketKind === "toggle" ? {} : { access: bracketKind }) }]),
        ];
        // One tool button, drawn for the header row (`sheet` false) and the phone sheet (true): a toggle that opens its panel, a link to
        // the page's tree, or a greyed button whose reason rides a bubble (`aria-disabled`, not `disabled`: it stays in the tab order, so
        // the reason is reachable by keyboard and by finger - the Complete button's pattern). A closure, not a component, on purpose:
        // `renderIsland` never invokes a nested function component's render (see the legend note below).
        const toolButton = (tool: (typeof settingsTools)[number], sheet: boolean) => {
          const prefix = sheet ? "stage-sheet-tool" : "stage-tool";
          const base = sheet
            ? "flex min-h-11 w-full items-center rounded-lg border px-3 text-left text-sm font-semibold"
            : "inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-semibold";
          const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600";
          if (tool.access === "link") {
            return (
              <a
                key={tool.panel}
                href={`#bracket-${stage.id}`}
                data-testid={`${prefix}-${tool.panel}`}
                onClick={sheet ? () => setOpenRailFor(null) : undefined}
                className={`${base} ${focus} ${TOGGLE_OFF}`}
              >
                {tool.label}
              </a>
            );
          }
          if (tool.access !== undefined) {
            const hintId = `${prefix}-bracket-hint-${stage.id}`;
            return (
              <WithReasonTip
                key={tool.panel}
                id={hintId}
                align="end"
                // Fix round 2 (controller ruling, review m6): only someone who can generate is told to "Generate fixtures" (`canEdit` is the
                // rail's own gate for its Generate button); a viewer - including an organiser whose billing froze editing - gets a neutral line.
                reason={msg(tool.access === "generate" ? (canEdit ? "bracket.generateFirst" : "bracket.appearsOnceGenerated") : "bracket.unavailable")}
                reasonTestId={`${prefix}-bracket-hint`}
              >
                <button
                  type="button"
                  aria-disabled="true"
                  aria-describedby={hintId}
                  data-testid={`${prefix}-${tool.panel}`}
                  className={`${base} ${focus} ${TOGGLE_OFF} cursor-help opacity-50`}
                >
                  {tool.label}
                </button>
              </WithReasonTip>
            );
          }
          const on = panelOpen(stage.id, tool.panel);
          return (
            <button
              key={tool.panel}
              type="button"
              data-testid={`${prefix}-${tool.panel}`}
              aria-expanded={on}
              aria-controls={`stage-panel-${stage.id}-${tool.panel}`}
              onClick={() => {
                togglePanel(stage.id, tool.panel);
                if (sheet) setOpenRailFor(null);
              }}
              className={`${base} ${focus} ${on ? TOGGLE_ON : TOGGLE_OFF}`}
            >
              {tool.label}
            </button>
          );
        };
        // Held keeps Complete locked but is not "in play": it waits for the organiser, and the card says so in its own clause.
        const stageHeld = stageFixtures.filter(
          (f) => (f.status === "needs_decision" || awaitingIds.has(f.id)) && !isBye(toRunSheetFixture(f)),
        );
        // Match Day PB1 (owner 2026-11-02): a completed stage is one line - number and name, the Completed pill and "N of M done" - until
        // someone opens it. Its settings buttons and actions fold away with the body (their panels render in the body, so a button that
        // opened an unseen panel would be a lie); they come back on open. Open by default when something on the card wants a person.
        const attention = attentionStageIds?.includes(stage.id) === true;
        const collapse = stageCardCollapse({
          status: stage.status,
          realMatches: stageNonByeCount,
          openMatches: counts.inPlay + counts.unplayed,
          attention,
          panelOpen: [...openPanels].some((key) => key.startsWith(`${stage.id}:`)),
        });
        // Ruling 2: the default as first seen, moving only toward open (a non-complete stage is open, so one that completes stays so).
        const latchWas = stageLatch.get(stage.id);
        const latched = latchedOpen(latchWas, collapse.startsOpen);
        if (latched !== latchWas) setStageLatch((prev) => new Map(prev).set(stage.id, latched));
        // m3: a warning that arrives since the last render drops the person's fold (the latch above already reads it as open).
        if (attention !== attentionWas.has(stage.id)) {
          setAttentionWas((prev) => {
            const next = new Set(prev);
            if (attention) next.add(stage.id);
            else next.delete(stage.id);
            return next;
          });
          if (attention && stageToggled.has(stage.id)) {
            setStageToggled((prev) => {
              const next = new Map(prev);
              next.delete(stage.id);
              return next;
            });
          }
        }
        // The person's tap over the default - and only while the card has a toggle: a stage that stops being complete is never folded
        // behind a choice made when it was (`folded` asks `collapsible` first).
        const cardOpen = stageToggled.get(stage.id) ?? latched;
        const folded = collapse.collapsible && !cardOpen;
        const stageBodyId = `stage-body-${stage.id}`;
        // Match Day E1 item 1: the card's old footer row ("To schedule in this stage N ->", a link to the Schedule page) is gone - the
        // counts line above the rows already says "N to schedule" in the card's own words (`stage-progress-counts`).
        // Mirrors the server guard (deleteStage) EXACTLY: only the last stage
        // in the graph, and only when it owns no played fixtures. No "keep one
        // stage" rule — the server deletes the sole stage of a pure League too.
        // Changing the stages before it is the Format button's (FMT5: the
        // Division rules card rebuilds the whole graph until the first result).
        const deletable =
          stage.seq === Math.max(...stages.map((s) => s.seq)) &&
          // W2a: a held (`needs_decision`) fixture was PLAYED — same rule as deleteStage's server guard.
          !stageFixtures.some((f) => ["in_play", "decided", "finalized", "needs_decision"].includes(f.status));
        const swissShellFixtures = stageFixtures.map((f) => ({ ...f, ext_key: f.ext_key ?? null }));
        const swissHasUnseated =
          stage.kind === "swiss" && nextUnseatedSwissRound(swissShellFixtures) !== null;
        // PARTLY seated counts (2026-09-22). This asked `latestSeatedSwissRound`
        // for a WHOLLY seated round, so an organiser who deleted an entrant
        // before Start — leaving one board with a single null slot — lost the
        // Unpair button entirely, on the one round that needed it. It must stay
        // the same predicate the server's `unpairSwissRound` uses, or the page
        // renders a control that 500s.
        const canUnpairSwiss = (() => {
          if (stage.kind !== "swiss") return false;
          const latest = latestSwissRoundWithAnySeat(swissShellFixtures);
          return latest !== null && !swissRoundHasPlayedResult(swissShellFixtures, latest);
        })();
        // Swiss round-1 pairing — the split button's menu, or null (not Swiss,
        // no shells minted yet, or no round waiting: review ruling R3). The
        // field is `activeEntrantIds` — the page's registered/confirmed set,
        // the same one swissGen pairs (R2) — and the seeds feed the R1 check
        // that decides whether the hint may print seed numbers at all.
        const swissPairingMenu = swissPairingMenuFor({
          kind: stage.kind,
          config: stage.config,
          fixtures: swissShellFixtures,
          activeEntrantIds,
          entrantSeeds,
          stageId: stage.id,
          entrantFirstRounds: entrantSwissFirstRounds,
          // X-SW-30 (W3 T14, SW-L12): from round 2 the menu's read-only line adds "Unpair, then Pair next" (after a
          // corrected result or roster) — said only while that is true: a running root Swiss (the ONE predicate behind
          // the late-add rail) whose Unpair button is on offer on this same card.
          changeByUnpair: isRunningRootSwiss(stage) && canUnpairSwiss,
        });
        // Batch-4 m2: the same line beside Unpair when no Pair next menu carries it (every round seated).
        const unpairChangeHint = swissUnpairChangeHint({
          kind: stage.kind,
          fixtures: swissShellFixtures,
          changeByUnpair: isRunningRootSwiss(stage) && canUnpairSwiss,
        });
        // The swiss shape legend (owner-approved 2026-09-22, option B) — the
        // one line under this stage's title. `null` for every non-swiss kind,
        // which is why nothing else on this card changes shape.
        //
        // `stageFixtures.length` is the THIRD figure (the rows this stage
        // holds today) and is deliberately NOT the source of the match count:
        // the whole point is that the rows can be stale — minted for an older
        // field — and the legend has to say what the CURRENT field needs so
        // the disagreement is visible. See lib/swiss-legend.ts's header.
        //
        // `stage.status` is the STAGE's own (`pending | active | complete`) —
        // the same value the badge two blocks down renders. On `complete` the
        // legend withholds the per-round clause, because a post-event
        // disqualification shrinks the field and would otherwise make a stage
        // that played perfectly correctly read as mis-sized.
        //
        // W3 T10 (T9 concern): sized for the round the next Pair seats, over the same round field the pairing menu
        // above reads — a late player whose first round is still ahead is not counted in it.
        const swissLegend = swissStageLegend({
          kind: stage.kind,
          status: stage.status,
          config: stage.config,
          activeEntrantIds,
          fixtureCount: stageFixtures.length,
          round: swissLegendRound(swissShellFixtures),
          stageId: stage.id,
          entrantFirstRounds: entrantSwissFirstRounds,
        });
        // SCF: the sentence that stands where Add match would be on a Swiss stage (it has none: the system pairs its rounds and the server refuses
        // the match, SWISS_ADHOC_REFUSED). Same gates the rail drew it under: an editor, a stage that is not finished, one with fixtures.
        const swissAdhocNote =
          canEdit && stage.kind === "swiss" && stage.status !== "complete" && stageFixtures.length > 0
            ? msg(swissRefusalKey("SWISS_ADHOC_REFUSED"))
            : null;
        // SCF fix round 1 (review I1): the "Unpair, then Pair next" line batch-4 m2 put beside Unpair for the final round is information too - a
        // ~105-char sentence in the actions row is what the owner called a mess - so it joins the legend line beside the sentence above, under the
        // gates the rail drew it under: an editor (the rail is his), a Swiss with Unpair on offer, and `swissUnpairChangeHint` (every round seated,
        // round 2 on, a running root Swiss). The Pair next menu carries the same copy while a round waits, so it shows in exactly one place.
        const swissUnpairNote =
          canEdit && stage.kind === "swiss" && canUnpairSwiss && unpairChangeHint
            ? msg("schedule.pairing.changeHint")
            : null;
        // The sentences after the legend, in reading order; each is one span on the legend line, joined by " · ".
        const legendNotes = [
          swissAdhocNote ? { testid: "stage-swiss-adhoc-note", text: swissAdhocNote } : null,
          swissUnpairNote ? { testid: "stage-unpair-hint", text: swissUnpairNote } : null,
        ].filter((n): n is { testid: string; text: string } => n !== null);
        // W3 T10 (X-SW-14 UI half) — the pending-latecomer count: entrants stamped for the round the next Pair seats,
        // and any who arrived after the last round had started. A desk notice, so organisers only.
        const swissLatecomers =
          stage.kind === "swiss" && canEdit
            ? swissLatecomerLines(
                swissLatecomerCounts({
                  stageId: stage.id,
                  rounds: stage.config.rounds,
                  fixtures: swissShellFixtures,
                  activeEntrantIds,
                  entrantFirstRounds: entrantSwissFirstRounds,
                }),
              )
            : [];
        // W3 T17 (RB3-19): the cut-drift warning this card carries, if any - the ONE predicate (`swissCutDriftOf`) the page's
        // `attentionStageIds` is built from too, so the card that has the notice is the card that starts open.
        const cutDrift = swissCutDriftOf(stage, canEdit, swissCutDrift);
        const knockoutDrift = knockoutCutDriftOf(stage, canEdit, knockoutCutDrift);
        // W4 T19: this card's waiting players (`listKnockoutWaiting` already leaves out a finished stage and a departed player).
        const waitingHere = knockoutWaiting.filter((w) => w.stageId === stage.id);
        // W4 T20: a drawn knockout's seed, by the card's own stage id (`0` is a seed: an absent one is `undefined`).
        const drawSeed = ROOT_KNOCKOUT_KINDS.includes(stage.kind) ? drawSeeds[stage.id] : undefined;
        // F3 Task 5 (5a) — only ever non-empty for the one stage
        // getStageRosterDrift finds eligible (usecases/stages.ts); every
        // other stage's entry is absent or both arrays empty, so this is a
        // no-op read for the common case.
        const drift = rosterDrift[stage.id];
        // W4 B2 fix round 2 (item 1): an empty first-round place (a deleted entrant) is drift too — `rosterDriftShown` is the
        // one test, read by the banner below and by Update draw's offer.
        const hasDrift = rosterDriftShown(drift);
        // W4 B2 fix round 1 (item 6): a root knockout drawn before its roster moved is `active` before Start, so Generate comes
        // back as "Update draw" (place a newcomer / vacate a withdrawal in place) until the division starts.
        const updateDraw = knockoutUpdateDrawOffered({
          stage,
          divisionStatus,
          fixtureCount: stageFixtures.length,
          // Byes out: a bye line is stored `forfeited`, so `counts.played` reads every bracket with a bye as begun.
          matchesBegun: stageFixtures.filter((f) => !isBye(toRunSheetFixture(f)) && f.status !== "scheduled").length,
          rosterDrifted: hasDrift,
        });
        // The stage's required court tags: built ONCE and drawn once, at the card's foot, for an editor and a viewer alike (Match Day E1
        // item 1 - it used to ride in the rail's sheet for an editor, which is now the header's actions group and has no room for it).
        const courtTagsEditor = (
          <StageCourtTagsEditor stageId={stage.id} canEdit={canEdit} suggestions={courtTagSuggestions} msg={msg} />
        );
        // The stage's actions (Generate / Pair next, Complete stage, Add match, Delete): built once, mounted in the card's HEADER (Match Day E1
        // item 1). From `md` they are the header's actions group, left of a thin divider and the settings buttons; below `md` the same
        // controls are the Stage tools sheet behind its one trigger, which rides the header too. An editor only (a viewer gets none).
        // W3 T12/T13 + batch-4 (merge with Match Day #1103): the round count's facts and writes for a Swiss stage, built once for the rail's Rounds
        // button and More and for the divider's question below. Absent for every other kind.
        const swissRoundsRail =
          stage.kind === "swiss" && swissRoundControls?.[stage.id]
            ? {
                control: swissRoundControls[stage.id]!,
                fixtures: swissShellFixtures,
                onSave: saveSwissRounds,
                onAddRound: addSwissRoundTo,
                onFinish: finishSwissStage,
              }
            : undefined;
        // SCF (owner pick, Option A): the thin divider between the actions group and the settings buttons belongs to the SETTINGS group (it is
        // that group's first child, below), so it can never be stranded on a line of its own when the header wraps. It is drawn when the actions
        // group draws a control - the rail's own answer (`stageRailActions`), asked here with the same facts - because a divider beside nothing
        // is a stray line. A viewer has no actions group at all.
        const railHasActions =
          canEdit &&
          stageRailActions({
            stage,
            counts,
            fixtureCount: stageFixtures.length,
            adhoc: ADHOC_STAGE_KINDS.has(stage.kind),
            swissHasUnseated,
            canUnpairSwiss,
            deletable,
            swissRounds: swissRoundsRail,
            updateDraw,
          }).hasActions;
        const railEl = canEdit ? (
          <div data-testid="stage-rail" className="min-w-0 max-md:w-full md:flex md:items-center">
          <StageRail
            stage={stage}
            canEdit={canEdit}
            busy={busy}
            fixtureCount={stageFixtures.length}
            counts={counts}
            matchCount={stageNonByeCount}
            deletable={deletable}
            onAct={(stageId, action, opts) => act(stageId, action, opts)}
            onDelete={(s) => {
              void (async () => {
                const ok = await confirmDialog({
                  title: msg("confirm.deleteStage.title"),
                  body: msg("confirm.deleteStage.body", { name: s.name }),
                  confirmLabel: msg("confirm.deleteStage.label"),
                  tone: "danger",
                });
                if (ok) void act(s.id, "delete");
              })();
            }}
            addingTo={addingTo}
            onToggleAddMatch={(stageId) => setAddingTo(addingTo === stageId ? null : stageId)}
            open={openRailFor === stage.id}
            onToggleOpen={(stageId) => setOpenRailFor(openRailFor === stageId ? null : stageId)}
            adhoc={ADHOC_STAGE_KINDS.has(stage.kind)}
            swissHasUnseated={swissHasUnseated}
            canUnpairSwiss={canUnpairSwiss}
            swissPairingMenu={swissPairingMenu}
            // W3 T10/T12/T13 + batch-4 (merge with Match Day #1103): the late-add More, the Rounds chip and the fed-Swiss More ride
            // the rail, so they sit in the header's actions group from `md` and in the Stage tools sheet below it - one DOM, each
            // testid once. The expressions are the ones W3 wrote on the retired `stage-rail` mount, unchanged.
            lateEntry={
              divisionStatus === undefined
                ? undefined
                : {
                    divisionStatus,
                    roundSeated: latestSwissRoundWithAnySeat(swissShellFixtures) !== null,
                    href: `${routes.division(orgSlug, compSlug, divSlug, "entrants")}#add-entrant`,
                    // W4 T19 (X-LE-3): the division's stages, so a started ROOT knockout offers the same item as "Add to bracket".
                    division: stages,
                  }
            }
            swissRounds={swissRoundsRail}
            updateDraw={updateDraw}
            toolsSlot={
              settingsTools.length > 0 ? (
                <div data-testid="stage-sheet-tools" className="flex flex-col gap-2 md:hidden">
                  {settingsTools.map((tool) => toolButton(tool, true))}
                </div>
              ) : null
            }
          />
          </div>
        ) : null;
        return (
          <div key={stage.id} className="space-y-6">
          <section className="card" data-stage-id={stage.id}>
            {/* Competition Desk W3 Task 5 introduced a two-column desktop
                layout here — `stage-sheet` beside a 280px `stage-rail`
                column — RETIRED by "Option B" (controller measurement,
                owner sign-off session, superseding Task 5/Ruling T5-A and
                Task 10's own first round): a 280px column stacking five
                items (toolbar, progress bar, court tags, unscheduled
                badge+CTA) forced the CARD to whatever height the RAIL
                needed (CSS equal-height grid-row stretch), and no amount of
                body content could ever close that gap — measured
                `body=262px rail=262px content=99px VOID=163px`, 62% empty,
                at 1280. No body content short of a fixture list could have
                fixed it; the fix is architectural, not a bigger body.
                `stage-sheet` and `stage-rail` are now two ordinary STACKED
                blocks (this file's own DOM order — sheet, then rail), full
                card width at every size, `md:` and up included. Card height
                is now content height; there is no column, therefore no
                void. */}
              <div data-testid="stage-sheet" className="min-w-0">
                <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-3">
                  <h3 className="min-w-0 text-sm font-semibold text-slate-800">
                    {collapse.collapsible ? (
                      <button
                        type="button"
                        data-testid="stage-collapse-toggle"
                        aria-expanded={cardOpen}
                        aria-controls={stageBodyId}
                        onClick={() => setStageToggled((prev) => new Map(prev).set(stage.id, !cardOpen))}
                        className="-my-1 flex min-h-11 min-w-0 items-center gap-2 rounded-lg pr-2 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
                      >
                        <ChevronRight
                          aria-hidden="true"
                          strokeWidth={2}
                          className={`h-4 w-4 shrink-0 text-slate-500 motion-safe:transition-transform ${cardOpen ? "rotate-90" : ""}`}
                        />
                        <span className="min-w-0">
                          {stage.seq}. {stage.name}
                        </span>
                      </button>
                    ) : (
                      <>
                        {stage.seq}. {stage.name}
                      </>
                    )}
                  </h3>
                  {/* Item 1: the kind pill only when the name does not already say the kind ("1. League" next to a "league"
                      pill said the word twice). */}
                  {showKindPill(stage.name, stage.kind) && <span className="chip">{stage.kind.replace(/_/g, " ")}</span>}
                  <span className={`badge ${stageStatusStyle(stage.status)}`}>{stageStatusLabel(msg, stage.status)}</span>
                  {folded && (
                    <span data-testid="stage-collapsed-summary" className="min-w-0 text-xs text-slate-600">
                      {msgPlural("runsheet.round.done", stageNonByeCount, { done: stageDone, total: stageNonByeCount })}
                    </span>
                  )}
                  {/* Match Day C3 (owner-approved mock, option 2): the stage's three settings open from here, inline under the
                      header. From `md` up the buttons sit in the header's row. Below `md` an editor finds the same three as the
                      TOP ROWS of the "Stage tools" sheet (controller ruling, review round 1: one phone trigger per card, not a
                      second "Stage settings" one), so the header row is `max-md:hidden` for an editor; a viewer has no sheet
                      (the rail renders nothing for them), so theirs stays on screen at every width. Points and Tie-breaks only
                      for a table stage; a viewer gets the same buttons and reads each panel. */}
                  {!folded && (railEl !== null || settingsTools.length > 0) && (
                    <div
                      data-testid="stage-controls"
                      className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 ${canEdit ? "max-md:w-full md:ml-auto" : "ml-auto"}`}
                    >
                      {railEl}
                      {settingsTools.length > 0 && (
                        // SCF: the divider and the settings buttons are ONE group that never splits (`flex`, no wrap): the divider is its first
                        // child, so wherever the header wraps the group, the divider shares its line with the buttons. The buttons wrap among
                        // themselves inside `stage-tools`. Not re-indented with what it holds, to keep this change small in a file others edit.
                        <div data-testid="stage-tools-group" className={`flex min-w-0 items-center gap-3 ${canEdit ? "max-md:hidden" : ""}`}>
                        {railHasActions && (
                          // From `xl` (1280) only (fix round 1, review m1; controller ruling): below it the busiest Swiss state wraps this group onto
                          // its own line, where a rule that leads the line divides nothing from its left - the line break already separates the groups.
                          <span aria-hidden="true" data-testid="stage-controls-divider" className="hidden h-6 w-px shrink-0 bg-slate-300 xl:block" />
                        )}
                        <div data-testid="stage-tools" className={`flex min-w-0 flex-wrap items-center gap-2 ${canEdit ? "max-md:hidden" : ""}`}>
                          {settingsTools.map((tool) => toolButton(tool, false))}
                        </div>
                        </div>
                      )}
                    </div>
                  )}
                  {/* The swiss shape legend. `w-full` inside the header's own
                      `flex-wrap`, so it takes the SECOND line under the title
                      and chips at every width rather than adding a row of
                      chrome of its own — the stage card is already tall on
                      phones. No width-conditional class at all (and none is
                      wanted: the same sentence is the right answer at 320 and
                      at 1280); it simply wraps, which is why it carries
                      `min-w-0` and no `whitespace-nowrap`. Rendered for BOTH
                      viewers — this is information, not an action, so unlike
                      the rail it has no `canEdit` gate.

                      Built inline rather than as a child component on purpose:
                      this file's unit tests walk the panel with `renderIsland`,
                      whose `walk()` never invokes a nested function
                      component's render (see stage-rail.tsx's header for the
                      full investigation), so a `<SwissLegend>` here would be
                      invisible to them. */}
                  {!folded && (swissLegend || legendNotes.length > 0) && (
                    <div className="w-full min-w-0 text-xs text-slate-500">
                      {swissLegend && (
                        <p data-testid="stage-swiss-legend" className="inline min-w-0">
                          {swissLegendText(swissLegend, { t: msg, plural: msgPlural })}
                        </p>
                      )}
                      {/* SCF (owner pick, Option A): the Swiss "paired by the system" sentence (W3 RB3-15 A / X-SW-21, ruling 252 - the copy is
                          unchanged) moved here from the actions row, where it stood in place of the Add match button the stage cannot have.
                          It is information, not an action: it joins the legend line, "5 rounds · 3 matches per round · 15 fixtures · Swiss
                          rounds are paired by the system. Add friendlies in another stage." It shows under the gates it always had (the rail
                          drew it for an editor of a running Swiss with fixtures), so a viewer and a finished or empty stage see none. The
                          final round's "Unpair, then Pair next" line (fix round 1, I1) follows it the same way. */}
                      {legendNotes.map((note, i) => (
                        <Fragment key={note.testid}>
                          {(swissLegend || i > 0) && <span aria-hidden="true"> · </span>}
                          <span data-testid={note.testid}>{note.text}</span>
                        </Fragment>
                      ))}
                    </div>
                  )}
                  {/* W3 T10 — under the legend, in the header (never inside the
                      rail's phone fold): a count that changes what the
                      organiser does next. Same quiet line as the legend. */}
                  {!folded && swissLatecomers.map((line) => (
                    <p
                      key={"plural" in line ? line.plural : line.key}
                      data-testid="stage-swiss-latecomer"
                      className="w-full min-w-0 text-xs text-slate-500"
                    >
                      {lateEntryNoticeText(line, { t: msg, plural: msgPlural })}
                    </p>
                  ))}
                  {/* W4 T20 (K5 "shown"; R24 pick 3A): the draw's seed, one muted line under the header like the legend - the number
                      that replays this bracket (RB4-D4), so an organiser can say which draw they are looking at. Information, not an
                      action: both viewers see it. Only a knockout that DREW at random has one (a seeded or fed bracket has none). */}
                  {/* Owner option B (2026-11-09): "Random draw · #…", with what the number means beside it as a second muted line -
                      plain text, always shown (no tooltip to reach by hover or keyboard), wrapping at any width. */}
                  {!folded && drawSeed !== undefined && (
                    <>
                      <p data-testid="stage-draw-seed" data-draw-seed={drawSeed} className="w-full min-w-0 text-xs text-slate-500">
                        {msg("knockout.drawSeed", { seed: drawSeed })}
                      </p>
                      <p data-testid="stage-draw-seed-hint" className="w-full min-w-0 text-xs text-slate-500">
                        {msg("knockout.drawSeedHint")}
                      </p>
                    </>
                  )}
                </header>

                {/* Match Day PB1: the card's body, one element so the toggle has something to control. `hidden` (not unmounted) while the
                    card is folded: the run sheet inside keeps its filter and its round toggles, and the panels keep their drafts. Not indented
                    with the blocks it holds, to keep this change to two lines of a file other branches are editing. */}
                <div id={stageBodyId} hidden={folded}>
                {/* W4 T19 (X-LE-10; R24 pick 1A): the players who arrived after the draw and wait to join this knockout, each with
                    one "Add to bracket". An organiser's strip, drawn only while someone waits here; a tap that seats them says so in
                    the panel's own notice line (it outlives the strip), one that cannot leaves its reason and exits in the row. */}
                {canEdit && waitingHere.length > 0 && (
                  <KnockoutWaitingStrip
                    stageId={stage.id}
                    waiting={waitingHere}
                    names={entrantNames}
                    registrationsHref={routes.competitionRegistration(orgSlug, compSlug, "registrants", divisionId)}
                    onRebuild={() => void rebuildStage(stage.id)}
                    onPlaced={(said) => {
                      setError(null);
                      setNotice(said.done.length > 0 ? said.done.join(" ") : null);
                      setWarning(said.todo.length > 0 ? said.todo.join(" ") : null);
                    }}
                  />
                )}
                {/* W3 T17 (RB3-19, X-SW-25) — a result of this Swiss was corrected after its knockout began: the bracket
                    stands (no seat moves), and the desk says who today's table would have cut instead. The house amber
                    notice (the roster-drift banner's treatment), polite (role="status"), never a dialog. The sentence and
                    its name lists are `swissCutDriftText` (lib/swiss-cut-drift.ts), so a test can read them. It sits INSIDE the folded body
                    (PB1): a completed card starts as one line, so the page lists these stages in `attentionStageIds` - from the same
                    `swissCutDriftOf` this reads - and the card starts open. */}
                {cutDrift && (
                  <div
                    role="status"
                    data-testid="swiss-cut-drift-warning"
                    className="border-b border-dashed border-amber-200 bg-amber-50 px-4 py-3"
                  >
                    <p className="min-w-0 break-words text-xs font-medium leading-relaxed text-amber-900">
                      {swissCutDriftText(cutDrift, entrantNames, locale, msgPlural)}
                    </p>
                  </div>
                )}
                {/* W4 T14 (RB4-Q5, X-QM-4): the same notice for a corrected knockout, whose bracket stands once the stage it feeds has
                    started (before that, the correction re-proposes it). Same treatment, same place, same fold rule. */}
                {knockoutDrift && (
                  <div
                    role="status"
                    data-testid="knockout-cut-drift-warning"
                    className="border-b border-dashed border-amber-200 bg-amber-50 px-4 py-3"
                  >
                    <p className="min-w-0 break-words text-xs font-medium leading-relaxed text-amber-900">
                      {knockoutCutDriftText(knockoutDrift, entrantNames, locale, msgPlural)}
                    </p>
                  </div>
                )}

                {/* F3 Task 5 (5a/5b) — the board no longer matches the roster:
                    a withdrawn entrant is still named on a fixture, an added
                    entrant has none yet, or both. Reuses the house "needs
                    attention" treatment (progression-panel.tsx's amber
                    border/background + data-* state hook), never auto-run —
                    the organiser presses Rebuild. Gated the same as Generate/
                    Complete just above: once the stage is complete the rebuild
                    would always refuse (every fixture has a result by then), so
                    there is nothing actionable left to show. */}
                {canEdit && stage.status !== "complete" && hasDrift && drift && (
                  <div
                    className={
                      swissAwaitingPairing(stage.kind, drift)
                        ? "border-b border-dashed border-slate-200 bg-slate-50 px-4 py-3"
                        : "border-b border-dashed border-amber-200 bg-amber-50 px-4 py-3"
                    }
                    data-testid="roster-drift-banner"
                    data-roster-drift-state={
                      drift.ghosts.length > 0
                        ? "ghosts"
                        : swissAwaitingPairing(stage.kind, drift)
                          ? "swiss-awaiting-pairing"
                          : drift.unplaced.length > 0
                            ? "unplaced"
                            : "vacant"
                    }
                  >
                    <p
                      className={
                        swissAwaitingPairing(stage.kind, drift)
                          ? "text-xs font-semibold text-slate-800"
                          : "text-xs font-semibold text-amber-900"
                      }
                    >
                      {msg(
                        swissAwaitingPairing(stage.kind, drift)
                          ? "progression.rosterDrift.swissHeading"
                          : "progression.rosterDrift.heading",
                      )}
                    </p>
                    {drift.ghosts.length > 0 && (
                      <p className="mt-1 text-xs text-amber-800">
                        {msg("progression.rosterDrift.ghostsLabel")}{" "}
                        {drift.ghosts.map((e) => e.display_name).join(", ")}
                      </p>
                    )}
                    {drift.unplaced.length > 0 && (
                      <p
                        className={
                          swissAwaitingPairing(stage.kind, drift)
                            ? "mt-1 text-xs text-slate-700"
                            : "mt-1 text-xs text-amber-800"
                        }
                      >
                        {msg(
                          swissAwaitingPairing(stage.kind, drift)
                            ? "progression.rosterDrift.swissLabel"
                            : "progression.rosterDrift.unplacedLabel",
                        )}{" "}
                        {drift.unplaced.map((e) => e.display_name).join(", ")}
                      </p>
                    )}
                    {(drift.vacantLines ?? 0) > 0 && (
                      <p className="mt-1 text-xs text-amber-800" data-testid="roster-drift-vacant">
                        {msg("progression.rosterDrift.vacantLabel", { count: drift.vacantLines ?? 0 })}
                      </p>
                    )}
                    {swissAwaitingPairing(stage.kind, drift) && (
                      <p className="mt-1 text-xs text-slate-600">{msg("progression.rosterDrift.swissNote")}</p>
                    )}
                    {/* No destructive remedy for a swiss stage that is merely
                        between rounds. "Rebuild fixtures" deletes the round
                        and regenerates it — which, on an odd roster, sits
                        somebody out again (so the banner returns) while
                        discarding the officials, team sheets and device links
                        attached to those fixtures. Offering that as the fix
                        for a stage where nothing is wrong is the defect W3
                        item 6 was chartered to remove; `Generate` for the
                        next round is the real call to action, and it already
                        renders in the rail above. Ghosts still get the
                        button: a withdrawn entrant named on a live fixture IS
                        drift, on swiss exactly as anywhere else. */}
                    {!swissAwaitingPairing(stage.kind, drift) && (
                      <button
                        type="button"
                        data-testid="roster-drift-rebuild"
                        disabled={busy !== null}
                        onClick={() => void rebuildStage(stage.id)}
                        className="btn btn-danger mt-2 min-h-11 px-3 py-1.5 text-xs"
                      >
                        {busy === stage.id
                          ? msg("progression.rosterDrift.rebuilding")
                          : msg("progression.rosterDrift.rebuildCta")}
                      </button>
                    )}
                  </div>
                )}

                {/* PROMPT-66: inline ad-hoc match form (replay / friendly / tie-breaker).
                    Competition Desk W3 Task 3 — only the OPEN TRIGGER moved onto
                    StageRail (data-testid="stage-add-match"); this form stays
                    mounted here, deliberately, because it reads `boardSlotOptions`
                    below, which also feeds `<RunSheet>` further down this file.
                    Do not move this form to "finish" the rail move — that would
                    fork `boardSlotOptions` into two derivations. */}
                {addingTo === stage.id && (
                  <AddMatchForm
                    msg={msg}
                    stageId={stage.id}
                    entrantNames={entrantNames}
                    boardSlotOptions={boardSlotOptions}
                    onDone={() => {
                      setAddingTo(null);
                      router.refresh();
                    }}
                    onCancel={() => setAddingTo(null)}
                  />
                )}

                {/* Per-stage rules (design 2026-09-17 §T5; W2c Task 17 extends them to every sport; Match Day C3 makes the card
                    read as a summary line with the three settings opening inline from the header's buttons). Deliberately NOT on
                    StageRail - that rail is the stage's actions and the rules are a reversible setting the API refuses outright
                    once the stage has started. (Spelling the class names out here would feed the Tailwind scanner, which reads
                    comments and emits junk CSS for anything class-shaped.) */}
                {sportKey !== undefined && (
                  <StageRulesArea
                    msg={msg}
                    stageId={stage.id}
                    sportKey={sportKey}
                    kind={stage.kind as StageKind}
                    variantKey={variantKey}
                    divisionConfig={divisionConfig}
                    ruleDict={ruleDict}
                    pointsDict={pointsDict}
                    stageConfig={stage.config}
                    locked={formatLockedStageIds.includes(stage.id)}
                    pinnedPoints={pinnedStagePoints[stage.id] ?? null}
                    tiebreaks={
                      stageTableRules[stage.id] === undefined
                        ? null
                        : stageLikeOf(stage, stageTableRules[stage.id]!, stagePooled(stage), takesBestNthFrom(stage, stages))
                    }
                    inheritedOrder={
                      stageTableRules[stage.id] === undefined || rulesStrip === undefined
                        ? undefined
                        : inheritedOrderOf(rulesStrip.divisionTiebreakers, stageTableRules[stage.id]!)
                    }
                    canEdit={canEdit}
                    onSaved={() => router.refresh()}
                    formatOpen={panelOpen(stage.id, "format")}
                    pointsOpen={panelOpen(stage.id, "points")}
                    tiebreaksOpen={panelOpen(stage.id, "tiebreaks")}
                    onClose={(panel) => closePanel(stage.id, panel)}
                  />
                )}

                {/* Match Day E1 item 3 (owner 2026-11-01): the bracket tree, INSIDE the knockout stage's card, closed until the header's
                    Bracket button (or the phone sheet's row) opens it. The existing panel, unchanged: it keeps its own horizontal
                    scroller, and `min-w-0` here is what lets that scroller shrink to the card instead of widening the page. The
                    `fixtures` it draws from are this stage's; `divisionFixtures` is the whole division's, for the feeder labels. */}
                {bracketInCard && panelOpen(stage.id, "bracket") && (
                  <div id={`stage-panel-${stage.id}-bracket`} data-testid="stage-bracket" className="min-w-0 border-b border-slate-100 px-4 py-3">
                    <BracketPanel
                      kind={stage.kind}
                      fixtures={stageFixtures}
                      divisionFixtures={fixtures}
                      entrantNames={entrantNames}
                      {...(entrantBadges === undefined ? {} : { entrantBadges })}
                      {...(headlines === undefined ? {} : { headlines })}
                      orgSlug={orgSlug}
                      compSlug={compSlug}
                      divSlug={divSlug}
                    />
                  </div>
                )}

                {/* Owner-approved redesign, "Option A" — the body's fixtures-
                    progress counts line. Renders for a stage that HAS
                    fixtures (guarded on `stageNonByeCount > 0`, not merely
                    `stageFixtures.length > 0`, so a stage that is somehow
                    all-bye falls through safely); a stage with none keeps
                    the existing "no fixtures yet" message just below,
                    unchanged, never both.

                    Owner ruling (this round): the bar that used to sit
                    above this line is GONE — it only earned its place while
                    it could show mixed state, and with every fixture
                    scheduled it rendered as a solid full-width block that
                    said nothing this text does not say better, carrying the
                    most visual weight on a card whose real job is the
                    actions below it. The void Option A built the bar to
                    fill was closed by Option B's stacking, not by the bar,
                    so its removal reopens nothing. This line remains the
                    card's one statement of where the stage is up to. */}
                {stageFixtures.length > 0 && stageNonByeCount > 0 && (
                  <div className="px-4 py-3" data-testid="stage-progress">
                    {/* Suppress any clause whose count is zero (_RULES.md:
                        "an empty cell is not information" — this programme
                        has already shipped "· 0 in play" on every settled
                        row once). Counted through `plural()`
                        (`msgPlural`/`useMsgPlural`) — this programme has
                        shipped "1 fixtures" five times; never a bare
                        `${n} played`. */}
                    {(() => {
                      // Match Day E1 fix round 1 (m3): "N to schedule" is the way to the division schedule - it replaces the card's
                      // removed footer link, so the one clause that names unscheduled matches is also where an organiser goes to place them.
                      const clauses: { text: string; href?: string }[] = [
                        stageDone > 0 ? { text: msgPlural("schedule.progress.done", stageDone) } : null,
                        stageInPlay.length > 0 ? { text: msgPlural("schedule.progress.inPlay", stageInPlay.length) } : null,
                        stageHeld.length > 0 ? { text: msgPlural("schedule.progress.held", stageHeld.length) } : null,
                        unscheduled.length > 0
                          ? { text: msgPlural("schedule.progress.toSchedule", unscheduled.length), href: routes.divisionSchedule(orgSlug, compSlug, divSlug) }
                          : null,
                        stageNotOpened.length > 0 ? { text: msgPlural("schedule.progress.notOpened", stageNotOpened.length) } : null,
                      ].filter((c): c is { text: string; href?: string } => c !== null);
                      return clauses.length > 0 ? (
                        // `mt-1.5` retired with the bar above it — this
                        // line is now the wrapper's only child, and the
                        // wrapper's own `py-3` already supplies its top
                        // spacing; keeping the margin would just add an
                        // unintended extra 6px nobody asked for.
                        <p className="text-xs text-slate-500" data-testid="stage-progress-counts">
                          {clauses.map((c, i) => (
                            <Fragment key={c.text}>
                              {i > 0 && " · "}
                              {c.href === undefined ? (
                                c.text
                              ) : (
                                <Link
                                  href={c.href}
                                  data-testid="stage-progress-to-schedule"
                                  className="font-medium text-slate-700 underline underline-offset-2 hover:text-purple-700 max-md:inline-flex max-md:min-h-11 max-md:items-center"
                                >
                                  {c.text}
                                </Link>
                              )}
                            </Fragment>
                          ))}
                        </p>
                      ) : null;
                    })()}
                  </div>
                )}

                {/* An online division that has not started: one line, on the first stage only (the start is the division's, not a
                    stage's). The Start button is on this tab; the round itself is opened in the Arbiter Panel. */}
                {canEdit && onlineAwaitsStart && stage.seq === Math.min(...stages.map((s) => s.seq)) && (
                  <p className="px-4 py-3 text-xs text-slate-500" data-testid="online-start-hint">
                    {msg("externalPlay.openRound.startFirst")}
                  </p>
                )}

                {/* Match Day C3 (spec §12 item 9): the stage's own fixtures sit IN the card, under the summary and the panels -
                    no "View N fixtures" trip to a separate list. The rows are the run sheet's own (`RunSheet embedded`: the same
                    `buildRunSheet` blocks, the same rows, the same filter), narrowed to this stage; the filter itself is the one
                    bar above the cards. */}
                {stageFixtures.length > 0 && (
                  <RunSheet
                    {...runSheetProps}
                    embedded
                    quietEmpty={!anyRowsKept}
                    stageId={stage.id}
                    endsCard={false /* something always follows the sheet in the card: an editor's rail, a viewer's court-tags line (review m3) */}
                  />
                )}

                {/* An `on_complete` progression stage (what "Add stage"
                    creates) gets no fixtures until the stage before it
                    completes, so "generate them when entrants are
                    registered" was wrong advice there — it names the stage
                    it is waiting on instead (owner-approved "Option 1,
                    wording only"). Every other empty stage keeps today's
                    copy. */}
                {stageFixtures.length === 0 && (() => {
                  const waitingOn = progressionWaitSource(stage, stages);
                  return (
                    <p className="px-4 py-4 text-sm text-slate-500" data-testid="stage-no-fixtures">
                      {waitingOn
                        ? msg(canEdit ? "schedule.noFixtures.awaitingCan" : "schedule.noFixtures.awaitingView", {
                            stage: waitingOn.name,
                          })
                        : canEdit
                          ? msg("schedule.noFixtures.can")
                          : msg("schedule.noFixtures.view")}
                    </p>
                  );
                })()}

                {/* The stage's required court tags, at the foot of the card for everyone (an editor edits them, a viewer reads them). */}
                {courtTagsEditor}
                </div>
              </div>

          </section>
          </div>
        );
      })}

      </div>

      {canEdit && (
        <AddStageForm
          divisionId={divisionId}
          nextSeq={Math.max(0, ...stages.map((s) => s.seq)) + 1}
          onDone={(noticeMsg) => {
            setNotice(noticeMsg);
            router.refresh();
          }}
          onError={setError}
          onPaywall={setPaywallFeature}
        />
      )}
    </div>
  );
}

// Follow-up stage (e.g. finals after a league). Qualification resolves from
// the previous stage's final table; if that stage is already complete the
// server seeds + generates on the spot. Kind labels are format names (kept
// canonical/English, like the format gallery).
const ADD_KINDS = [
  { key: "knockout", label: "Knockout" },
  { key: "stepladder", label: "Stepladder" },
  { key: "double_elim", label: "Double elimination" },
] as const;

/** The follow-up stage's progression rule — pure, so the POST body shape is
 *  unit-testable without the interactive hook-harness (same reasoning as
 *  generatePreconditionMessage below: AddStageForm is a nested stateful
 *  component, opaque to the harness's one-level-deep expansion). F2: was
 *  `{ topN }`; `rankRange` is the collapsed survivor (owner ruling 4).
 *  `timing: "on_complete"` because this form always tries to /generate
 *  immediately after creating the stage, falling back to "seed on
 *  completion" only via STAGE_NOT_READY below — exactly on_complete
 *  semantics (F2 plan Decision 1), never the propose/confirm "setup" flow. */
export function addStageProgression(topN: number) {
  return {
    sources: [{ stage: "previous" as const, take: [{ kind: "rankRange" as const, from: 1, to: topN }] }],
    placement: "rank_order" as const,
    timing: "on_complete" as const,
  };
}

/**
 * The stage an `on_complete` progression stage is still waiting on, or null.
 *
 * Mirrors the server's own refusal exactly (stages.ts generateStageFixtures'
 * pre-flight → STAGE_NOT_READY `previous_stage_incomplete`): a progression
 * whose timing is `on_complete`, not yet seeded (`config.qualified` absent),
 * whose IMMEDIATELY previous stage by seq is not complete. That stage is also
 * the one whose completion seeds and generates this one (seedNextStage), so it
 * is the stage the empty card names. Null whenever the server would NOT refuse
 * Generate — no progression, `setup` timing, already seeded, no earlier stage,
 * or that stage already complete — so the card keeps today's copy there.
 * Exported pure, for the same no-DOM reason as `addStageProgression`.
 */
export function progressionWaitSource<S extends { seq: number; status: string }>(
  stage: { seq: number; config: Record<string, unknown>; progression: Record<string, unknown> | null },
  stages: readonly S[],
): S | null {
  if (stage.progression?.timing !== "on_complete") return null;
  if (Array.isArray(stage.config.qualified)) return null;
  let previous: S | null = null;
  for (const s of stages) {
    if (s.seq < stage.seq && (previous === null || s.seq > previous.seq)) previous = s;
  }
  if (previous === null || previous.status === "complete") return null;
  return previous;
}

/** The Add-stage form's Top N choices: every whole number in FORMAT_BOUNDS.qualify. */
const ADD_STAGE_TOP_N: readonly number[] = Array.from(
  { length: FORMAT_BOUNDS.qualify.max - FORMAT_BOUNDS.qualify.min + 1 },
  (_, i) => FORMAT_BOUNDS.qualify.min + i,
);

export function AddStageForm({
  divisionId,
  nextSeq,
  onDone,
  onError,
  onPaywall,
}: {
  divisionId: string;
  nextSeq: number;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
  onPaywall: (featureKey: string) => void;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Finals");
  const [kind, setKind] = useState<string>("knockout");
  const [topN, setTopN] = useState(4);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    onError("");
    onPaywall("");
    try {
      const stage = await apiV1<{ id: string }>(`/api/v1/divisions/${divisionId}/stages`, {
        method: "POST",
        json: {
          seq: nextSeq,
          kind,
          name: name.trim() || "Finals",
          config: {},
          progression: addStageProgression(topN),
        },
      });
      try {
        const gen = await apiV1<{ created: number }>(`/api/v1/stages/${stage.id}/generate`, {
          method: "POST",
          json: {},
        });
        onDone(msg("schedule.notice.stageAdded", { n: gen.created, topN }));
      } catch (err) {
        // Previous stage not complete yet — the stage exists; completion will
        // seed + generate it.
        if (err instanceof ApiV1Error && err.code === "STAGE_NOT_READY") {
          onDone(msg("schedule.notice.stageAddedLater"));
        } else {
          throw err;
        }
      }
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        onPaywall(String(err.extra.feature_key ?? ""));
      } else {
        onError(addStageErrorText(err, msg));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost text-xs">
        {msg("schedule.addStage")}
      </button>
    );
  }

  return (
    <section className="card flex flex-wrap items-end gap-3 p-4">
      <label className="block">
        <span className="label">{msg("schedule.field.stageName")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="input w-40"
        />
      </label>
      <label className="block">
        <span className="label">{msg("schedule.field.format")}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="select">
          {ADD_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="label">{msg("schedule.field.qualifyFrom")}</span>
        {/* Match Day D1 fix round 1 (M4): every Top N the builder and Settings take (FORMAT_BOUNDS.qualify, 2-32), was a
            fixed [2, 3, 4, 6, 8]. A select, not a number box: it cannot hold a value outside its options. */}
        <select data-format-bound="qualify" value={topN} onChange={(e) => setTopN(Number(e.target.value))} className="select">
          {ADD_STAGE_TOP_N.map((n) => (
            <option key={n} value={n}>
              {msg("schedule.topN", { n })}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={add} className="btn btn-primary text-xs">
        {busy ? msg("schedule.adding") : msg("schedule.addStageBtn")}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost text-xs">
        {msg("schedule.cancel")}
      </button>
    </section>
  );
}

/**
 * F3 Task 5 (5b) — the rebuild-click classifier, mirroring
 * generatePreconditionMessage's shape just below (same pure/exported-for-
 * direct-unit-testing rationale). rebuildStageFixtures (usecases/stages.ts)
 * refuses 409 STAGE_HAS_RESULTS the moment any fixture in the stage already
 * carries a score, is in progress, or is completed — this turns that refusal
 * into the actionable, localized amber banner rather than the generic red
 * error text. Every other error (including the defence-in-depth 422
 * STAGE_NOT_ROOT this panel's own gating never triggers) falls through to
 * the caller's generic handling, same as generatePreconditionMessage's null.
 */
/**
 * F3 ultrareview finding 5 — the sentence appended to the rebuild confirm
 * dialog naming the organiser SETUP the rebuild clears along with the
 * fixtures: referee appointments, team sheets, paired scoring devices. All
 * three CASCADE off `delete from fixtures` and none of them blocks the
 * rebuild (a result does; see rebuildStageFixtures' guard) — so without this
 * the dialog said "every fixture is deleted and regenerated" while silently
 * also dropping a Saturday's worth of appointments.
 *
 * Returns "" when there is nothing attached, so the common case adds no
 * boilerplate to click through — only non-zero pieces are listed. Joined
 * with `Intl.ListFormat` on the caller's own locale rather than a hardcoded
 * ", " and " and ": the conjunction and the separator differ per language,
 * and this repo's four dictionaries would otherwise need two more keys that
 * exist only to spell out punctuation. Exported (pure) for the same reason
 * rebuildBlockedMessage is: testable without a jsdom harness.
 */
export function attachmentWarning(drift: RosterDrift | undefined, msg: Msg, locale: string): string {
  const a = drift?.attachments;
  if (!a) return "";
  const parts = [
    a.officials > 0 ? msg("progression.rosterDrift.alsoOfficials", { count: a.officials }) : null,
    a.lineups > 0 ? msg("progression.rosterDrift.alsoLineups", { count: a.lineups }) : null,
    a.deviceLinks > 0 ? msg("progression.rosterDrift.alsoDevices", { count: a.deviceLinks }) : null,
    // W4 B2 fix round 2 (item 5): the rest of the setup a match can carry before Start, each a cascade of the delete.
    a.streams > 0 ? msg("progression.rosterDrift.alsoStreams", { count: a.streams }) : null,
    a.youtubeBroadcasts > 0 ? msg("progression.rosterDrift.alsoBroadcasts", { count: a.youtubeBroadcasts }) : null,
    a.availability > 0 ? msg("progression.rosterDrift.alsoAvailability", { count: a.availability }) : null,
    a.calls > 0 ? msg("progression.rosterDrift.alsoCalls", { count: a.calls }) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "";
  const items = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
  const cleared = msg("progression.rosterDrift.alsoCleared", { items });
  // Owner ruling Q4 (2026-09-23): the cascade takes every printed QR on this
  // stage with it — say so in the one dialog that precedes it.
  return a.deviceLinks > 0 ? `${cleared} ${msg("progression.rosterDrift.sheetsStop")}` : cleared;
}

/** POST /stages/{id}/generate's answer, as far as the desk's notice reads it (`GenerateResult`). */
export type GenerateNoticeWire = {
  created: number;
  existing: number;
  reshaped?: SwissReshapeWire;
  swiss_rounds?: SwissRoundsNotice;
  /** W3 app-B T7 (X-SW-10): the look-ahead's verdict on the round after the one just seated, with that round. Read by
   *  `nextRoundNoticeOf`, which drops a verdict it cannot name a round for. */
  swiss_next_round?: "unpairable" | "unknown";
  swiss_paired_round?: number;
  /** W4 T8 (FX-G2): a root knockout's Generate over existing lines — what it reconciled (`GenerateResult.reconcile`). */
  reconcile?: {
    kind: "noop" | "in_place" | "regenerated";
    placed: string[];
    vacated: string[];
    /** Every seat emptied, a deleted entrant's included (no id to list) — fix round 1, I2. */
    vacated_seats: number;
    slots?: { kept: number; freed: number; unscheduled: number };
  };
};

/**
 * The green notice after a Generate — what was minted or paired, then (Swiss) what reshaped. The round-count warning
 * (W3 T11, X-SW-16) is NOT part of it: it is a caution, so it goes in the panel's amber channel (`generateWarningText`,
 * review m1). The panel's one composition, exported so the render test and the island read the same lines.
 */
export function generateNoticeText(out: GenerateNoticeWire, msg: Msg, msgPlural: MsgPlural, locale: string): string {
  return [
    reconcileNotice(out.reconcile, msg, msgPlural) ??
      (out.created > 0
        ? msg("schedule.notice.generated", { created: out.created, existing: out.existing })
        : msg("schedule.notice.nothingNew")),
    // Swiss pre-Start: this press may also have resized rounds nobody
    // paired, deleting boards along with the times and courts pinned on
    // them. Silent before this; `reshapeNotice` returns null when
    // nothing moved, so the ordinary Pair reads exactly as it did.
    reshapeNotice(out.reshaped, msg, msgPlural, locale),
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

/**
 * W4 T8 (FX-G2): what a knockout's Generate over existing lines did, in the organiser's words — or null, so the ordinary
 * line stands: a first Generate (no `reconcile`), and the named no-op, which IS "up to date". A redraw says so (the old
 * line counted only what it created, as if nothing had been taken away); a change in place counts the newcomers placed
 * and the departed taken out, each clause dropped at zero.
 */
export function reconcileNotice(reconcile: GenerateNoticeWire["reconcile"], msg: Msg, msgPlural: MsgPlural): string | null {
  if (reconcile === undefined || reconcile.kind === "noop") return null;
  if (reconcile.kind === "regenerated") {
    // B2 fix round 1 (I1): a redraw deletes every line and draws new ones, so it says what became of the slots (Rebuild's
    // own line, dropped for a bracket nobody laid out — the server then reports 0/0/0) and that printed sheets, which name
    // the old lines, stop working. It never claims every match kept its time: a redraw's new lines have none to keep.
    const slots = reconcile.slots;
    return [
      msg("schedule.notice.reconcileRedrawn"),
      slots && slots.kept + slots.freed + slots.unscheduled > 0
        ? msg("progression.rosterDrift.rebuiltSlots", { kept: slots.kept, freed: slots.freed, unscheduled: slots.unscheduled })
        : null,
      msg("progression.rosterDrift.sheetsStop"),
    ]
      .filter((c): c is string => c !== null)
      .join(" ");
  }
  const clauses = [
    reconcile.placed.length > 0 ? msgPlural("schedule.notice.reconcilePlaced", reconcile.placed.length) : null,
    // The SEATS emptied, not the ids listed: a deleted entrant's seat has no id left (fix round 1, I2).
    reconcile.vacated_seats > 0 ? msgPlural("schedule.notice.reconcileVacated", reconcile.vacated_seats) : null,
  ].filter((c): c is string => c !== null);
  return clauses.length > 0 ? clauses.join(" ") : null;
}

/**
 * W3 T11 (X-SW-16): the amber line after a Generate whose answer carries `swiss_rounds` — the count is above the field's
 * safe maximum (`warn`), or a running Swiss's field shrank under it while this round still paired (`shrunk`). Null for
 * every other answer, so an ordinary Pair shows no amber line.
 */
export function generateWarningText(out: GenerateNoticeWire, msgPlural: MsgPlural): string | null {
  return swissRoundsWarnNotice(out.swiss_rounds, msgPlural);
}

/**
 * What a Swiss Generate/Pair-next ALSO did to the rounds nobody paired.
 *
 * Before Start the reconcile resizes every unseated round to the current
 * field, which can delete surplus boards — and a deleted board takes its
 * `scheduled_at` and `court_id` with it. The organiser used to be told only
 * how many fixtures were seated, so three rounds' worth of pinned times could
 * vanish on one press with nothing on screen about it. That silence is the
 * defect this closes.
 *
 * Returns `null` when nothing moved, which is the overwhelmingly common Pair —
 * a no-op must stay silent rather than announce four zeroes. Every clause is
 * suppressed at zero for the same reason (`_RULES.md`: "an empty cell is not
 * information"), and every count goes through `plural()` rather than a bare
 * `${n} matches`, which is this programme's own repeat offender.
 *
 * Matches and byes are counted apart because they are not the same thing to an
 * organiser: a match needs a court and a slot, a bye needs neither. Copy says
 * "match", never "board" — board is internal vocabulary, and `board.*` in these
 * dictionaries already means the scheduling board.
 *
 * Exported (pure) for the same reason `attachmentWarning` is: `apps/web` vitest
 * runs in `environment: "node"`, so this is testable only outside the component.
 */
export function reshapeNotice(
  reshaped: SwissReshapeWire | undefined,
  msg: Msg,
  msgPlural: MsgPlural,
  locale: string,
): string | null {
  if (!reshaped) return null;
  const clauses = [
    reshaped.matches_added > 0
      ? msgPlural("schedule.notice.reshapedMatchesAdded", reshaped.matches_added)
      : null,
    reshaped.matches_removed > 0
      ? msgPlural("schedule.notice.reshapedMatchesRemoved", reshaped.matches_removed)
      : null,
    reshaped.byes_added > 0
      ? msgPlural("schedule.notice.reshapedByesAdded", reshaped.byes_added)
      : null,
    reshaped.byes_removed > 0
      ? msgPlural("schedule.notice.reshapedByesRemoved", reshaped.byes_removed)
      : null,
  ].filter((c): c is string => c !== null);
  if (clauses.length === 0) return null;
  // `Intl.ListFormat` on the caller's locale rather than a hardcoded ", "/" and ":
  // the separator and the conjunction differ per language, and the four
  // dictionaries would otherwise need keys that exist only to spell punctuation.
  const changes = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    clauses,
  );
  const head = msg("schedule.notice.reshaped", { changes });
  // The lost layout is the part that matters, so it is said outright — but only
  // when something was actually removed.
  return reshaped.matches_removed > 0
    ? `${head} ${msg("schedule.notice.reshapedSlotsCleared")}`
    : head;
}

/** The part of POST /stages/{id}/rebuild's answer the notice reads (`RebuildResult`, schemas.ts). */
export interface RebuiltOutcome {
  removed: number;
  slots: { kept: number; freed: number; unscheduled: number };
}

/**
 * W3 T1 (X-RB-1, #840): the notice after a Rebuild. A rebuild keeps every slot
 * (time, court, venue or pin) whose (pool, round, seq) survives, so the
 * organiser is told what did NOT survive — slots freed because no rebuilt
 * fixture inherits them, and fixtures at a new position with nothing to
 * inherit — but only when there is such a thing. A rebuild that kept every
 * slot stays the one-line notice it always was, and so does one of a stage
 * nobody laid out: the server counts `unscheduled` only when the stage had a
 * layout (`carrySlots`), so it reports 0/0/0. Exported pure, like the
 * classifiers below.
 */
export function rebuiltNotice(out: RebuiltOutcome, msg: Msg): string {
  const head = msg("progression.rosterDrift.rebuiltNotice", { removed: out.removed });
  const { kept, freed, unscheduled } = out.slots;
  if (freed + unscheduled === 0) return head;
  return `${head} ${msg("progression.rosterDrift.rebuiltSlots", { kept, freed, unscheduled })}`;
}

export function rebuildBlockedMessage(err: unknown, msg: Msg): string | null {
  if (!(err instanceof ApiV1Error) || err.code !== "STAGE_HAS_RESULTS") return null;
  return msg("progression.rosterDrift.blockedNotice");
}

/**
 * "Générer les matchs" precondition failure (design/fix-ui/03 §"misleading
 * success message"): generateStageFixtures throws STAGE_NOT_READY with
 * `data.reason: "group_too_few_entrants"` when a group stage passed the
 * total-entrant gate but can't pair fixtures once split across its
 * configured groups. Returns the actionable, localized reason to show as a
 * distinct (amber, non-success) banner — or null for every other error,
 * which the caller falls through to the generic red error banner for.
 * Exported (pure, no state) so this classification is unit-testable without
 * a DOM/jsdom harness, which this repo's component tests don't set up.
 */
/**
 * How a failed generate/complete/delete is shown to the organiser: amber
 * (something specific to fix) vs red (it failed), and whether the board
 * needs re-reading. Exported pure for the same reason its two siblings above
 * are — this panel's tests render it with renderToStaticMarkup, which never
 * fires a handler, so a classifier left inline in the catch block is untested
 * code on the path an organiser only reaches when something has gone wrong.
 */
export function classifyActError(
  err: unknown,
  msg: Msg,
  locale: Locale,
  stageName?: StageNameLookup,
  matchName?: MatchNameLookup,
): { tone: "warning" | "error"; text: string; refresh: boolean } {
  // F3 ultrareview finding 4 — the completion COMMITTED in its own
  // transaction; only the next stage's seed proposal failed afterwards
  // (completeStage, usecases/stages.ts). Amber, because the stage really is
  // complete and the organiser has one concrete thing to fix — and a refresh,
  // because otherwise the board keeps showing a completed stage as active and
  // the next click lands on an already-complete stage.
  if (err instanceof ApiV1Error && err.code === "STAGE_COMPLETED_SEEDING_FAILED") {
    return {
      tone: "warning",
      text: msg("schedule.error.completedSeedingFailed", { reason: err.message }),
      refresh: true,
    };
  }
  // Swiss round-1 pairing, review ruling R4 — the server refused the pick
  // (the round moved on under the desk, or the stage is not Swiss). Its
  // `*_MESSAGE` is English wire text and must never reach the desk, so the
  // CODE maps to a dictionary line. Amber and a refresh, the
  // STAGE_COMPLETED_SEEDING_FAILED shape above: nothing failed server-side,
  // but the board that offered the pick is stale.
  if (
    err instanceof ApiV1Error &&
    (err.code === SWISS_PAIRING_ROUND_ONE_ONLY_CODE || err.code === SWISS_PAIRING_NOT_SWISS_CODE)
  ) {
    return { tone: "warning", text: msg("schedule.pairing.error.roundOneOnly"), refresh: true };
  }
  // W2b D11 (spec §5.4 corner 3): Complete refused because a departed entrant still holds a seat in a line that
  // decided nobody. Amber — one match to record — named in the reader's language (`scoringErrorText`), never the
  // server's English sentence with its ids.
  if (err instanceof ApiV1Error && err.code === "STAGE_SEAT_DEPARTED") {
    return { tone: "warning", text: scoringErrorText(err.code, err.message, msg, "schedule.error.failed", err.extra), refresh: false };
  }
  // W4 T6 (AN-2): Complete refused because a line of the bracket is still owed a result (STAGE_HAS_UNDECIDED_FIXTURES:
  // a third-place match unplayed beside a decided final). Amber — matches to finish — in the reader's language, never
  // the server's English sentence.
  // B3 fix round 1 (review #6): a sentence that names something (KO_LATE_ENTRY_FED_STAGE's `{stage}`) takes it from the
  // envelope's fields, which the server sends beside the code (`knockoutRefusal(code, details)` → `err.extra`).
  if (err instanceof ApiV1Error && isKnockoutRefusalCode(err.code)) {
    return { tone: "warning", text: knockoutRefusalText(err.code, err.extra, msg), refresh: false };
  }
  const precondition = generatePreconditionMessage(err, msg, stageName, matchName);
  if (precondition) return { tone: "warning", text: precondition, refresh: false };
  // F3 ultrareview finding 10 — was `err.message` verbatim, i.e. raw English
  // regardless of locale for every SEEDING_* code this panel can raise
  // (generateProgressionSetupFixtures throws SEEDING_MAP_SOURCE_AMBIGUOUS
  // straight out of `generate`). The copy already existed in all four
  // errors.json; nothing on THIS path read it. No codes were added to that
  // allowlist — see seeding-error.ts's own scope note — this is a second
  // reader of copy that was already written and already tested.
  const rule = ruleRefusalOf(err, msg);
  if (rule !== null) return { tone: "error", text: rule, refresh: false };
  if (err instanceof ApiV1Error) {
    return { tone: "error", text: seedingErrorMessage(locale, err.code, err.message), refresh: false };
  }
  return {
    tone: "error",
    text: err instanceof Error ? err.message : msg("schedule.error.failed"),
    refresh: false,
  };
}

/** What "Undo" beside a notice says when the server refuses it. The played
 *  refusal (a match the change touches has a result or scoring recorded) is said
 *  locally, off the CODE — the server's sentence is English, and
 *  history-panel.tsx gives the same refusal the same sentence. Anything else
 *  keeps its own message, which is the one an organiser can quote. */
export function undoRefusalMessage(err: unknown, msg: Msg): string {
  if (err instanceof ApiV1Error && err.code === PLAYED_REFUSAL_CODE) return msg("history.error.played");
  // W3 T5 (X-SW-28): Undo of Pair next over a started round, or across an undo barrier — a Swiss one, or since W4 T5
  // (K1) a confirmed draw (SEED_CONFIRM_NOT_UNDOABLE), each through its own family's key.
  if (err instanceof ApiV1Error && isUndoRefusalCode(err.code)) return undoRefusalText(err.code, err.extra, msg);
  return ruleRefusalOf(err, msg) ?? (err instanceof Error ? err.message : msg("schedule.error.undoFailed"));
}

/** W3 T12 Fix round 1 (review m1): a refused Swiss stage write — the rounds dialog's Save, Add a round — in the reader's
 *  language, never the server's English sentence: a Swiss refusal with what to do next, a frozen
 *  timetable and a rule lock such as FIXTURE_HAS_OWN_FORMAT through `swissDoorRefusalText` — the ONE mapping the Entrants
 *  tab's recovery doors read too (batch-4 review I1) — and anything else (STAGE_NOT_READY) through this panel's own
 *  classifier. Exported pure for `classifyActError`'s reason. */
export function swissStageRefusal(err: unknown, msg: Msg, msgPlural: MsgPlural, locale: Locale): SwissRoundsRefusal {
  if (!(err instanceof ApiV1Error)) {
    return { code: "", extra: {}, text: err instanceof Error ? err.message : msg("schedule.error.failed") };
  }
  const text = swissDoorRefusalText(err.code, err.extra, msg, msgPlural) ?? classifyActError(err, msg, locale).text;
  return { code: err.code, extra: err.extra, text };
}

/** W3 T13 Fix round 1 (review I2): a refused Finish, as `swissStageRefusal` says it — except the R3 backstop
 *  (STAGE_NOT_READY: the stage could not complete on rounds 1..k), whose wire sentence is English, said here. */
export function swissFinishRefusal(err: unknown, msg: Msg, msgPlural: MsgPlural, locale: Locale): SwissRoundsRefusal {
  const refusal = swissStageRefusal(err, msg, msgPlural, locale);
  const notReady = swissFinishNotReadyText(refusal.code, msg);
  return notReady === null ? refusal : { ...refusal, text: notReady };
}

/** W2c batch-3 M1: a rule-lock refusal (`FIXTURE_HAS_OWN_FORMAT` from a rebuild, an Undo or a Swiss reshape, and the
 *  rest of `lib/rule-errors.ts`) said in the reader's language off its code — never the server's English sentence. */
function ruleRefusalOf(err: unknown, msg: Msg): string | null {
  return err instanceof ApiV1Error ? ruleRefusalText(err.code, err.extra, msg) : null;
}

/** Rebuild's red line when the refusal is not the amber STAGE_HAS_RESULTS (`rebuildBlockedMessage`). Exported pure for
 *  the reason `classifyActError` is: the panel's tests never fire the handler. A Swiss refusal (W3 T11 review I1: a
 *  Rebuild mints again, so SWISS_ROUNDS_ABOVE_MAX against today's field) is said in the reader's language with what to
 *  do next — never the server's English sentence. */
export function rebuildErrorText(err: unknown, msg: Msg, msgPlural: MsgPlural): string {
  if (err instanceof ApiV1Error && isSwissRefusalCode(err.code)) return swissRefusalText(err.code, err.extra, msg, msgPlural);
  // W4 T15 (X-PL-1, X-QM-5): a Rebuild draws the root again, so it can be refused for the field's size.
  if (err instanceof ApiV1Error && isKnockoutRefusalCode(err.code)) return knockoutRefusalText(err.code, err.extra, msg);
  return ruleRefusalOf(err, msg) ?? (err instanceof Error ? err.message : msg("schedule.error.failed"));
}

/** Add stage's red line, exported pure for the reason `rebuildErrorText` is. A Top N from a knockout that is no whole round (W4 T15,
 *  X-QM-2) is said in the reader's language; any other refusal keeps its own message. */
export function addStageErrorText(err: unknown, msg: Msg): string {
  if (err instanceof ApiV1Error && isKnockoutRefusalCode(err.code)) return knockoutRefusalText(err.code, err.extra, msg);
  return err instanceof Error ? err.message : msg("schedule.error.failed");
}

/** Stage id → its name on this board, or undefined when the board does not
 *  hold that stage. */
export type StageNameLookup = (stageId: string) => string | undefined;

/** Fixture id → who plays it ("Ana – Ben"), or undefined when the board does not hold that match (or its seats are
 *  not both filled). Names a held match in the Complete-stage refusal. */
export type MatchNameLookup = (fixtureId: string) => string | undefined;

/** The board's lookup for a held match: "Ana – Ben" from the fixture's two seats (an entrant it cannot name reads "?"),
 *  undefined when the board does not hold the fixture or a seat is empty - the caller then says round and number. */
export function matchNamerFor(
  fixtures: readonly { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[],
  entrantNames: Readonly<Record<string, string>>,
): MatchNameLookup {
  return (id) => {
    const f = fixtures.find((x) => x.id === id);
    return f?.home_entrant_id && f.away_entrant_id
      ? `${entrantNames[f.home_entrant_id] ?? "?"} – ${entrantNames[f.away_entrant_id] ?? "?"}`
      : undefined;
  };
}

export function generatePreconditionMessage(
  err: unknown,
  msg: Msg,
  stageName?: StageNameLookup,
  matchName?: MatchNameLookup,
): string | null {
  if (!(err instanceof ApiV1Error) || err.code !== "STAGE_NOT_READY") return null;
  // An `on_complete` progression stage pressed Generate before its source
  // stage completed (the stage "Add stage" creates — see
  // progressionWaitSource). Was the server's English sentence in a red
  // banner; now an amber notice naming both stages. The ids come from the
  // envelope (api-v1/http.ts) and the names from this board. A board that
  // cannot name one of them is stale (it renders every stage of the
  // division), so that case says the same thing without the names — still
  // amber, still never the wire text.
  if (err.extra.reason === "previous_stage_incomplete") {
    const source = stageName?.(String(err.extra.previousStageId ?? ""));
    const stage = stageName?.(String(err.extra.stageId ?? ""));
    return source && stage
      ? msg("schedule.error.previousStageIncomplete", { source, stage })
      : msg("schedule.error.previousStageIncompleteUnnamed");
  }
  // W2c P-7 / X-AB-5 (fix round 1, I2): the next Swiss round is not drawn while an abandoned board has no result. The
  // boards ride the envelope (api-v1/http.ts, lib/swiss-abandoned-refusal.ts); an organiser reads WHICH to settle, in
  // their own language. A shape that does not parse keeps the code's own copy (null here), never a guess.
  if (err.extra.reason === SWISS_ABANDONED_BOARDS_REASON) {
    const boards = abandonedBoardsOf(err.extra);
    if (boards === null) return null;
    const named = boards.map((b) => msg("schedule.error.swissAbandonedRef", { round: b.round, board: b.board })).join(", ");
    return msg(boards.length === 1 ? "schedule.error.swissAbandonedOne" : "schedule.error.swissAbandonedMany", { boards: named });
  }
  // W2c X-AB-5 (fix round 2, N2): Complete stage is refused while a table stage holds a match for the organiser's settle.
  // Named by its players where this board can (it renders every match of the division), else by round and number - in
  // the reader's language, never the wire sentence. A shape that does not parse keeps the code's own copy (null).
  if (err.extra.reason === ABANDONED_MATCHES_REASON) {
    const held = heldMatchesOf(err.extra);
    if (held === null) return null;
    const named = held
      .map((h) => matchName?.(h.fixtureId) ?? msg("schedule.error.heldMatchRef", { round: h.round, board: h.board }))
      .join(", ");
    return msg(held.length === 1 ? "schedule.error.completeHeldOne" : "schedule.error.completeHeldMany", { matches: named });
  }
  if (err.extra.reason === "group_too_few_entrants") {
    const groups = Number(err.extra.groups ?? 1);
    return groups > 1
      ? msg("schedule.error.tooFewGroupEntrants", {
          required: Number(err.extra.required ?? groups * 2),
          have: Number(err.extra.entrants ?? 0),
          groups,
        })
      : msg("schedule.error.tooFewEntrants");
  }
  // F2a (P7 follow-up): the SEEDED-path analogue — a `.progression`
  // (timing: "setup") group stage whose placed seeds can't fill its
  // configured pools
  // (generateSeededStageFixtures) throws this reason instead. Same
  // actionable-banner treatment; distinct copy because the shortfall is in
  // QUALIFIERS the seeding rules produce, not in registered entrants.
  if (err.extra.reason === "seeded_pool_too_few_qualifiers") {
    const groups = Number(err.extra.groups ?? 1);
    // P7 fix round (Major, whole-branch review): groups<=1 (an ungrouped
    // seeded kind, or a group stage left at pools.count's default of 1)
    // used to fall back to the PLAIN path's tooFewEntrants copy ("add at
    // least 2 entrants to this stage first") — unactionable here, since a
    // a `.progression` (timing: "setup") stage's entrants are synthetic
    // slot:N seeds minted from its take rules (stages.ts:1399-1403), not
    // rows a user can add.
    // The seeded path's real lever is the seeding rules or the source
    // stage's qualifier count, so it gets its own copy, never tooFewEntrants.
    return groups > 1
      ? msg("schedule.error.tooFewSeededQualifiers", {
          required: Number(err.extra.required ?? groups * 2),
          have: Number(err.extra.qualifiers ?? 0),
          groups,
          stranded: Number(err.extra.stranded ?? 0),
        })
      : msg("schedule.error.tooFewQualifiers", {
          qualifiers: Number(err.extra.qualifiers ?? 0),
          stranded: Number(err.extra.stranded ?? 0),
        });
  }
  return null;
}

/** Voided fixtures render struck through with the reason (item 6). EXPORTED
 *  (Competition Desk W2, Task 4/R13-style) — `run-sheet-row.tsx` reuses this
 *  SAME set for the run sheet's rows rather than a second copy. */
export const VOID_STATUSES = new Set(["cancelled", "abandoned", "forfeited"]);

/**
 * Localized played-fixture status; unknown values fall back to the raw token.
 *
 * RESTORED (max-effort review, finding 6). This function was deleted with
 * `FixtureLine`, and the run sheet shipped with no replacement — so a
 * cancelled, abandoned or forfeited row rendered struck through with NO reason
 * given, indistinguishable from each other and, for a screen-reader user, from
 * an ordinary played match (CSS `line-through` is not announced). The design of
 * record names it explicitly: "Status is carried by the dot colour + sub-line
 * copy (`fixtureStatusLabel` stays as the sub-line source)"
 * (competition-desk-design.md:232-234).
 *
 * The `schedule.fstatus.*` keys it reads never left the four dictionaries —
 * they retain other readers on the board — so this restores a live string
 * rather than adding one. EXPORTED for `run-sheet-row.tsx`, the same way
 * `outcomeText` and `VOID_STATUSES` above are: one authority, no second copy.
 */
export function fixtureStatusLabel(msg: Msg, status: string): string {
  const key = `schedule.fstatus.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status.replace("_", " ") : label;
}

// F1 Task 4: named bracket rounds by POSITION (roundRole), never by match
// count or a stage-wide max — a double-elim's losers bracket has more
// rounds than its winners bracket, so ranking round_no across the whole
// stage (the old `maxRound`) skews every winners-side name past round 1.
// roundRoleFor ranks `roundNo` within its own lane instead.
//
// page_playoff round 1 holds BOTH Qualifier 1 and the Eliminator (they
// share a round and a match count — ext_key is the only way to tell them
// apart, spec 05 §2.3) — this panel renders one card per round_no, so
// splitting them into two cards is a structural change outside this fix's
// scope (same "known disagreement" the F1 plan itself calls out). That one
// case keeps its existing merged "Qualifiers" header; round 2 (Qualifier 2)
// and the Final each hold exactly one fixture and resolve through the same
// roundRole() as every other bracket kind.
// EXPORTED (Competition Desk W2, Task 4/R13) — `run-sheet.tsx` calls this
// same function for a bracket block's round sub-headers rather than writing
// a second labeller. `stageFixtures`' type is narrowed to just the six
// fields this function reads: the run sheet passes `RunSheetFixture[]`
// (run-sheet-groups.ts), which does not carry every field this file's own
// `FixtureRow` does, and a `Pick` lets BOTH shapes satisfy the parameter
// without a hand-rolled second type.
export function bracketRoundLabel(
  msg: Msg,
  kind: string,
  roundNo: number,
  stageFixtures: readonly Pick<FixtureRow, "round_no" | "lane" | "is_final" | "third_place" | "conditional" | "ext_key">[],
): string {
  if (kind === "page_playoff" && roundNo === 1) return msg("bracket.qualifiers");
  const first = stageFixtures.find((f) => f.round_no === roundNo);
  if (!first) return msg("schedule.round", { n: roundNo });
  const laneFixtures = stageFixtures.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
  return roundRoleLabel(
    msg,
    roundRoleFor(
      laneFixtures,
      {
        round_no: roundNo,
        lane: first.lane ?? null,
        is_final: first.is_final === true,
        third_place: first.third_place === true,
        conditional: first.conditional === true,
      },
      kind,
      first.ext_key ?? null,
    ),
  );
}

function stageStatusStyle(status: string): string {
  if (status === "active") return "bg-amber-100 text-amber-700";
  if (status === "complete") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-600";
}

/** Localized stage status; unknown values fall back to the raw token. */
function stageStatusLabel(msg: Msg, status: string): string {
  if (status === "active") return msg("schedule.sstatus.active");
  if (status === "complete") return msg("schedule.sstatus.complete");
  if (status === "pending") return msg("schedule.sstatus.pending");
  return status;
}

// W2b loop H F2: moved to `lib/outcome-text.ts`, so the fixture console reads the run sheet's words; re-exported here
// for this module's existing importers (`run-sheet-row.tsx`, the tests).
export { outcomeText } from "@/lib/outcome-text";

// PROMPT-66 — inline ad-hoc match form. Two entrant selects + an optional
// datetime; POSTs /stages/{id}/fixtures and refreshes. The server enforces the
// stage-kind policy; this form only shows on league/group stages.
function AddMatchForm({
  msg,
  stageId,
  entrantNames,
  boardSlotOptions,
  onDone,
  onCancel,
}: {
  msg: Msg;
  stageId: string;
  entrantNames: Record<string, string>;
  /** Board slots for the "When" field — see `boardSlotOptionsFor` above.
   *  `undefined` lets `DateTimeField` fall back to quarter hours. */
  boardSlotOptions?: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const options = Object.entries(entrantNames).sort((a, b) => a[1].localeCompare(b[1]));
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");
  const [when, setWhen] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await apiV1(`/api/v1/stages/${stageId}/fixtures`, {
        method: "POST",
        json: {
          home_entrant_id: home,
          away_entrant_id: away,
          ...(when !== "" ? { scheduled_at: new Date(when).toISOString() } : {}),
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-dashed border-slate-200 bg-slate-50/60 px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="label flex flex-col gap-1 text-xs">
          {msg("stage.addMatch.home")}
          <select className="input min-h-11 py-1.5 text-sm" value={home} onChange={(e) => setHome(e.target.value)}>
            <option value="" />
            {options.map(([id, name]) => (
              <option key={id} value={id} disabled={id === away}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="label flex flex-col gap-1 text-xs">
          {msg("stage.addMatch.away")}
          <select className="input min-h-11 py-1.5 text-sm" value={away} onChange={(e) => setAway(e.target.value)}>
            <option value="" />
            {options.map(([id, name]) => (
              <option key={id} value={id} disabled={id === home}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <DateTimeField
          kind="datetime-local"
          label={msg("stage.addMatch.when")}
          value={when}
          onChange={setWhen}
          options={boardSlotOptions}
        />
        <button
          type="button"
          className="btn btn-primary px-3 py-1.5 text-xs"
          disabled={saving || home === "" || away === "" || home === away}
          onClick={() => void submit()}
        >
          {saving ? msg("schedule.working") : msg("stage.addMatch.button")}
        </button>
        <button type="button" className="btn btn-ghost px-3 py-1.5 text-xs" onClick={onCancel}>
          {msg("schedule.cancel")}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">{msg("stage.addMatch.hint")}</p>
      {error !== null && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * The stage card's rules row (design §T5, owner ruling D7 "Option A"; W2c Task 17 extends it to every sport and adds
 * Deciders, If abandoned and the lock line, owner pick A on mockup S1 and S4).
 *
 * THE SUBTLE PART, and the reason this component exists rather than a few
 * inline lines: `hydrateRuleValues` is called with TWO DIFFERENT INPUTS here,
 * and swapping them is a data-loss defect, not a refactor.
 *
 *  - The SUMMARY line reads the EFFECTIVE config (`{...division, ...rules}`),
 *    because "Best of 3 · Same as division" has to state the number the stage
 *    will actually be played at, and an inherited stage's own fragment is
 *    empty.
 *  - The CHIPS under it (review I-1) say the same effective format in the public line's own words: the stage's division
 *    and its rules resolved (`resolvedStageCfg`), described by the public describers (`stageSummaryClauses`). Closed, they
 *    are the saved rules; open, they follow the edit (round 2), exactly as the notice does.
 *  - The EDITOR hydrates the FRAGMENT ONLY (`stage.config.rules`). In a
 *    fragment a key's ABSENCE means "inherit the division". Hydrating the
 *    editor from the merge would arrive with every field filled, and the first
 *    save would PUT all of them — pinning the stage to today's division format
 *    forever, an override the organiser never asked for.
 *
 * A future reader will see one function called twice and want to simplify it.
 * Don't.
 *
 * What a Save sends is only what the organiser CHANGED, and the endpoint merges it (`stageFormatSaveFragment`).
 */
function StageRulesArea({
  msg,
  stageId,
  sportKey,
  kind,
  variantKey,
  divisionConfig,
  ruleDict,
  pointsDict,
  stageConfig,
  locked,
  pinnedPoints,
  tiebreaks,
  inheritedOrder,
  canEdit,
  onSaved,
  formatOpen,
  pointsOpen,
  tiebreaksOpen,
  onClose,
}: {
  msg: Msg;
  stageId: string;
  sportKey: string;
  kind: StageKind;
  variantKey: string | null;
  divisionConfig: Record<string, unknown>;
  ruleDict: Dict | undefined;
  pointsDict: Dict | undefined;
  stageConfig: Record<string, unknown>;
  locked: boolean;
  /** I1: the points this stage's pin pays (`pinnedStagePoints`), null while it reads the live layers. */
  pinnedPoints: PointsRule | null;
  /** W2d Task 15: the stage as the Tie-breaks section reads it, null where its table rules do not read. */
  tiebreaks: ReturnType<typeof stageLikeOf> | null;
  /** Match Day C3: the order this stage would rank by if it followed the division today (`inheritedOrder`), or undefined where
   *  the page gave no division order to compare with (then only a stage's OWN order is said to differ). */
  inheritedOrder: readonly TiebreakerKey[] | undefined;
  canEdit: boolean;
  onSaved: () => void;
  /** Which of the card's three settings panels are open (the header's buttons own the state, as `openRailFor` does). */
  formatOpen: boolean;
  pointsOpen: boolean;
  tiebreaksOpen: boolean;
  onClose: (panel: RulesPanel) => void;
}) {
  const sportModule = useMemo(() => moduleFor(sportKey), [sportKey]);
  const readOnly = locked || !canEdit;
  /** The fragment a stage opens its editor with - the fragment IN FORCE (see the header), never the merge. */
  const hydrateFrom = (inForce: Record<string, unknown>) => stageFormatEditorValues(sportKey, { ...stageConfig, rules: inForce }, divisionConfig);
  const [values, setValues] = useState<Record<string, string>>(() =>
    formatOpen && !readOnly ? hydrateFrom(stageRulesInForce(null, stageConfig.rules)) : {},
  );
  /** What the editor was opened with - the save path diffs against this so "the organiser touched nothing" can never be
   *  mistaken for a clear. */
  const [opened, setOpened] = useState<Record<string, string>>(values);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the last Save/Clear answered (the PUT's own `rules`), kept until the page's props move on. `onSaved` is
   *  `router.refresh()`, which is NOT awaited: for a moment after the PUT the props are still the pre-save ones, and an
   *  editor reopened in that window used to hydrate from them (batch-5 review Q2). See `stageRulesInForce`. */
  const [saved, setSaved] = useState<SavedStageRules | null>(null);
  /** The props' `rules` as of the last commit, for `save()` to read AFTER its await (the closure's own copy may be older
   *  than a refresh that landed while the PUT was in flight). Written in an effect, read in handlers - never in render. */
  const propRules = useRef<unknown>(stageConfig.rules);
  useEffect(() => {
    propRules.current = stageConfig.rules;
  }, [stageConfig.rules]);

  const rules = useMemo(() => stageRulesInForce(saved, stageConfig.rules), [saved, stageConfig.rules]);
  const overridden = Object.keys(rules).length > 0;

  // The Match format panel opening hydrates the editor from the fragment in force (the render-phase transition: no effect sets
  // state). Closing it discards the draft, so a reopened panel always starts from what is stored.
  const [wasOpen, setWasOpen] = useState(formatOpen);
  if (formatOpen !== wasOpen) {
    setWasOpen(formatOpen);
    if (formatOpen && !readOnly) {
      const hydrated = hydrateFrom(rules);
      setValues(hydrated);
      setOpened(hydrated);
      setError(null);
    }
  }

  // Review M-5: focus follows the editor IN - the panel an organiser just opened takes focus, so the keyboard lands on the fields
  // (a read-only panel is only read, and keeps focus where it was).
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formatOpen && !readOnly) editorRef.current?.focus();
  }, [formatOpen, readOnly]);

  // SUMMARY - effective config. See the header.
  const effective = useMemo(() => ({ ...divisionConfig, ...rules }), [divisionConfig, rules]);
  // The rules this stage would store if Save were pressed now, for the notice while the editor is open: the stored
  // rules with the fragment a Save would send merged in (the endpoint's own merge, `mergedStageRules`).
  const noticeRules = useMemo(
    () => (formatOpen ? (mergedStageRules(rules, stageFormatSaveFragment(sportKey, rules, opened, values, divisionConfig)) ?? {}) : rules),
    [formatOpen, rules, sportKey, opened, values, divisionConfig],
  );
  const resolved = useMemo(
    () => (sportModule === null ? null : resolvedStageCfg(sportModule, divisionConfig, kind, noticeRules)),
    [sportModule, divisionConfig, kind, noticeRules],
  );
  // The stage as it is SAVED (not the draft): what the summary line states.
  const resolvedSaved = useMemo(
    () => (sportModule === null ? null : resolvedStageCfg(sportModule, divisionConfig, kind, rules)),
    [sportModule, divisionConfig, kind, rules],
  );

  if (sportModule === null) return null;

  const mode = readOnly ? "locked" : "edit";
  const state = locked ? "locked" : overridden ? "overridden" : "inherited";
  const preset = overridden && isStagePreset(sportModule, kind, variantKey, rules);
  const takesPoints = stageTakesPoints(kind);

  // THE ONE-LINE SUMMARY (spec §12 items 5, 6, 12): format · points · ties, each said once, in the words of the public line and
  // the sport's own unit ("game", not "set", for badminton). The panels below say the rest.
  // The format's clauses, and how a level match ends where the kind has a way to (a knockout's extra time and penalties ARE its
  // format; a league has none, so its line stays short). The abandon policy is the panel's to say, not the line's.
  const formatClauses =
    ruleDict === undefined || resolvedSaved === null
      ? null
      : [...(describeMatchRules(sportKey, sportModule, resolvedSaved) ?? []), ...describeDeciders(sportModule, kind, resolvedSaved)];
  const formatText =
    formatClauses !== null && formatClauses.length > 0 && ruleDict !== undefined
      ? rulesLineText(ruleDict, formatClauses)
      : stageFormatHeadline(sportKey, effective, msg);
  const pointsText = takesPoints
    ? stagePointsHeadline({ module: sportModule, kind, stageConfig, divisionConfig, stored: stageConfig.points, pinned: pinnedPoints, pointsDict }, msg)
    : null;
  const tiesSteps =
    takesPoints && tiebreaks !== null
      ? tiesSummary(tiebreaks.tableRules.tiebreakers.keys, (k) => msg(unitLabelKey(k, sportKey)), msg("stageCard.summary.then"))
      : null;
  const parts = [formatText, pointsText, tiesSteps === null ? null : msg("stageCard.summary.ties", { steps: tiesSteps })].filter(
    (x): x is string => x !== null && x !== "",
  );
  // "A stage that differs says so" (item 12): which of the three sections no longer follow the division.
  const differs = [
    overridden ? msg("rulesStrip.format") : null,
    takesPoints && pointsDiffer(sportModule, divisionConfig, { kind, config: stageConfig }, stageConfig.points, pinnedPoints) ? msg("stagePoints.title") : null,
    takesPoints && tiebreaks !== null && tiebreaksDiffer(tiebreaks.tableRules, inheritedOrder) ? msg("stageTiebreaks.title") : null,
  ].filter((x): x is string => x !== null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Always a non-empty fragment object, NEVER `null` or `{}`: either clears the override and is reserved for the
      // explicit "Use division rules" control below. A Save that reached it would turn "I changed one field" into "I
      // cleared everything" (`stageFormatSaveFragment` falls back to the stored fragment rather than send an empty one).
      const out = await apiV1<{ rules: Record<string, unknown> | null }>(`/api/v1/stages/${stageId}/rules`, {
        method: "PUT",
        json: { rules: stageFormatSaveFragment(sportKey, rules, opened, values, divisionConfig) },
      });
      setSaved({ against: propRules.current, rules: out.rules ?? {} });
      onClose("format");
      onSaved();
    } catch (err) {
      // W2c P-5: a refused fragment names its problem (CONFIG_INVALID `issues`), localized where this app owns it.
      setError(rulesWriteErrorText(err, msg));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setError(null);
    try {
      const out = await apiV1<{ rules: Record<string, unknown> | null }>(`/api/v1/stages/${stageId}/rules`, {
        method: "PUT",
        json: { rules: null },
      });
      setSaved({ against: propRules.current, rules: out.rules ?? {} });
      onClose("format");
      onSaved();
    } catch (err) {
      // W2c Task 19: the same reader as Save - a rule-lock refusal in the reader's language, never the wire's English.
      setError(rulesWriteErrorText(err, msg));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid={`stage-format-row-${stageId}`} className="min-w-0">
      {/* The summary: always on the card, the panels below only when their header button is on. */}
      <div className="space-y-1 border-b border-slate-100 px-4 py-3" data-testid="stage-format" data-stage-format-state={state}>
        {parts.length > 0 && (
          <p className="min-w-0 text-xs text-slate-700" data-testid="stage-format-summary">
            {parts.join(" · ")}
          </p>
        )}
        {preset && (
          <span
            className="inline-block rounded-full border border-teal-700/30 bg-teal-50 px-2 py-0.5 text-[11px] text-teal-900"
            data-testid="stage-format-preset"
          >
            {msg("stageRules.preset.knockout", { sport: sportLabel(sportKey, msg) })}
          </span>
        )}
        {locked && <LockLine testId="stage-locked" />}
        {differs.length > 0 && (
          <p className="min-w-0 text-xs font-medium text-purple-800" data-testid="stage-differs">
            {msg("stageCard.summary.differs", { parts: differs.join(", ") })}
          </p>
        )}
        {error !== null && !formatOpen && <p className="text-xs text-red-600">{error}</p>}
        {/* Closed, the card still says a stage that holds level matches (every decider off) does so - the notice is the panel's
            while it is open (live to the draft) and the summary's otherwise, never both. */}
        {!formatOpen && <DecidersNotice module={sportModule} kind={kind} resolved={resolved} />}
      </div>

      {formatOpen && (
        <div
          id={`stage-panel-${stageId}-format`}
          role="region"
          aria-label={msg("rulesStrip.format")}
          className="space-y-3 border-b border-dashed border-slate-200 bg-slate-50/60 px-4 py-3 outline-none"
          data-testid="stage-format-editor"
          data-mode={mode}
          ref={editorRef}
          tabIndex={-1}
        >
          {/* `inherited`: the fragment's blanks fall back to the DIVISION, so a stage that names no best-of but
              inherits best of 1 still gets the single "Points to win" field (owner ruling 2026-09-25). */}
          <MatchFormatEditor
            scope="stage"
            mode={mode}
            started={locked}
            showLockLine={false}
            sportKey={sportKey}
            module={sportModule}
            kind={kind}
            variant={variantKey}
            values={values}
            onChange={setValues}
            disabled={saving}
            divisionConfig={divisionConfig}
            resolved={resolved}
            ruleDict={ruleDict}
          />
          <DecidersNotice module={sportModule} kind={kind} resolved={resolved} />
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
                data-testid="stage-format-save"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? msg("schedule.working") : msg("schedule.stageFormat.save")}
              </button>
              <button
                type="button"
                className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
                data-testid="stage-format-cancel"
                disabled={saving}
                onClick={() => onClose("format")}
              >
                {msg("schedule.cancel")}
              </button>
              {overridden && (
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
                  data-testid="stage-format-clear"
                  disabled={saving}
                  onClick={() => void clear()}
                >
                  {msg("schedule.stageFormat.useDivision")}
                </button>
              )}
            </div>
          )}
          {!readOnly && <p className="text-xs text-slate-500">{msg("schedule.stageFormat.hint")}</p>}
          {error !== null && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
      {/* W2c Task 18 (S3): the stage's own points, a table stage only (a bracket has no table to rank). Its own PUT arm and
          its own lock: the same `readOnly` the format panel uses (a started stage, or a viewer). */}
      {pointsOpen && takesPoints && (
        <div id={`stage-panel-${stageId}-points`} className="min-w-0">
          <PointsEditor
            scope="stage"
            mode={mode}
            started={locked}
            showLockLine={false}
            stageId={stageId}
            module={sportModule}
            kind={kind}
            stageConfig={stageConfig}
            divisionConfig={divisionConfig}
            stored={stageConfig.points}
            pointsDict={pointsDict}
            pinned={pinnedPoints}
            onSaved={onSaved}
          />
        </div>
      )}
      {/* W2d Task 15 (spec §9): the stage's tie-break order, on a table stage whose rules read. Its lock is the server's own
          (`formatLockedStageIds`): editable from generate until the first score (OC2). */}
      {tiebreaksOpen && takesPoints && tiebreaks !== null && (
        <div id={`stage-panel-${stageId}-tiebreaks`} className="min-w-0">
          <TiebreaksEditor
            scope="stage"
            mode={mode}
            started={locked}
            showLockLine={false}
            stage={tiebreaks}
            module={sportModule}
            divisionConfig={divisionConfig}
            stageConfig={stageConfig}
            inheritedOrder={inheritedOrder}
            onSaved={onSaved}
          />
        </div>
      )}
    </div>
  );
}

/** The PUT's answer to a Save/Clear, tagged with the props' `rules` it was made against. */
export interface SavedStageRules {
  /** The row's `stageConfig.rules` prop when the save landed: while the prop is still THIS object the page has not
   *  re-read the stage since, and `rules` is newer than it. */
  readonly against: unknown;
  /** What the stage stores now (`{}` for a clear). */
  readonly rules: Record<string, unknown>;
}

/**
 * The rules fragment the Match format row works from (batch-5 review Q2). Its summary, its editor's hydration and a
 * Save's untouched-field diff all read this ONE value: the PUT's own answer while the page's props still predate it
 * (`saved.against` is the very object the prop still holds), the props' own the moment they are anything else - the
 * refresh landed, or another save arrived with it. No timers and no race left to lose: the row never waits for the
 * refresh, and never keeps its own copy past it.
 */
export function stageRulesInForce(saved: SavedStageRules | null, propRules: unknown): Record<string, unknown> {
  if (saved !== null && saved.against === propRules) return saved.rules;
  return isPlainRules(propRules) ? propRules : {};
}

/** `stages.config.rules` as a plain object, or nothing. A JSON `null` and a
 *  non-object both mean "no override" — never spread either into a config. */
function isPlainRules(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the format EDITOR opens with: the stage's own `rules` FRAGMENT, and
 * nothing else. Exported as its own function — like `boardSlotOptionsFor`
 * above — because the distinction it encodes cannot be tested through the
 * rendered row: the editor only hydrates on click, and this panel's tests run
 * in `environment: "node"` with no DOM to click.
 *
 * It takes `stageConfig`, NOT the effective config, and that is the whole
 * point. In a fragment a key's absence means "inherit the division"; hydrating
 * from `{...divisionConfig, ...rules}` would fill every field, and the first
 * save would PUT all of them and pin the stage to today's division format.
 */
export function stageFormatEditorValues(
  sportKey: string,
  stageConfig: Record<string, unknown>,
  divisionConfig: Record<string, unknown> = {},
): Record<string, string> {
  // `divisionConfig` is the fragment's `inherited`, never a source of values: it only gives a scaled field its scale (cricket's
  // overs count in the division's over length - five on The Hundred - which a fragment that names an innings does not
  // carry). A key the fragment omits still reads blank.
  return hydrateRuleValues(sportKey, isPlainRules(stageConfig.rules) ? stageConfig.rules : {}, divisionConfig);
}

/**
 * The fragment a Save PUTs. It lives in `stage-rules/stage-row-model.ts` (pure, with its unit killers) and is
 * re-exported so the panel's tests and the row keep one import. See there for the rules: only what changed, a blanked
 * field as null, an untouched save re-sends the stored fragment verbatim, never an empty one.
 */
export { stageFormatSaveFragment };

/**
 * "Best of 3" for the summary line — the `bestOf` field's OWN option label,
 * looked up through `SPORT_RULES`, never a string assembled here. A change to
 * the table's labels moves this line with it (AGENTS.md rule 19).
 *
 * Reads the EFFECTIVE config, unlike `stageFormatEditorValues` above: the line
 * must state the number the stage will actually be played at, and an inherited
 * stage's own fragment is empty.
 *
 * Returns null when the effective config names no `bestOf` at all, in which
 * case the row shows its state clause alone rather than inventing a number.
 */
export function stageFormatHeadline(
  sportKey: string,
  effective: Record<string, unknown>,
  msg: RuleMsg,
): string | null {
  const raw = hydrateRuleValues(sportKey, effective).bestOf;
  if (raw === undefined) return null;
  // The saved value may be valid while THIS sport's picker does not offer it —
  // badminton offers [1,3,5] while `{"bestOf":7}` is a perfectly good config
  // (D9). `ruleOptionText` borrows the label from a peer sport that
  // does offer it, so the line reads "Best of 7 · Stage override" as the
  // design table specifies without assembling an English string here. It is
  // the SAME lookup `MatchRuleFields` labels its synthetic option with: the
  // two shipped from separate code paths and disagreed on screen. Verified in
  // the browser — before the borrow, the live walkthrough stage read
  // "5 · Stage override" directly under "Best of 3 · Locked". (That original
  // case was `bestOf: 5` against a picker offering [1,3]; the owner widened
  // badminton to [1,3,5] on 2026-09-20, so 5 is now the sport's OWN label.)
  return ruleOptionText(sportKey, "bestOf", raw, msg) ?? raw;
}

// #622 — per-stage required court tags, stage-wide and per round role.
//
// Deliberately its own component with its own state and its own fetch rather
// than more state on StagesPanel: the panel already renders N stage cards from
// props, and hoisting a per-stage GET into it would mean N in-flight requests
// on every mount for a control most organisers never open. The fetch fires on
// FIRST OPEN instead (the `loaded` guard) — the same "soft enhancement, swallow
// the failure" posture division-settings.tsx takes for its tag suggestions,
// except a load failure here IS surfaced, because an empty editor that silently
// failed to load would look like "no requirement" and a Save would then wipe
// real rules.
export function StageCourtTagsEditor({
  stageId,
  canEdit,
  suggestions,
  msg,
}: {
  stageId: string;
  canEdit: boolean;
  suggestions: string[];
  msg: Msg;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [stageTags, setStageTags] = useState<string[]>([]);
  const [rounds, setRounds] = useState<{ round_role: string; required_court_tags: string[] }[]>([]);
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Owner request (competition desk W3, on top of Option B) — the collapsed
  // summary row becomes a real button that opens a modal; the fetch itself
  // stays gated on `open && !loaded` for an EDITING viewer, byte for byte
  // (brief: "still loads on open"). A non-editing viewer gets no button and
  // no modal at all (see the render branch below) — they have no `open` to
  // set, so `!open` alone would never fetch anything and the current value
  // the brief requires them to see would never load. `canEdit` widens the
  // gate for exactly that case: `!open && canEdit` is the skip condition
  // (identical to the old `!open` when `canEdit` is true, since `open` can
  // only ever become true through the button THIS component itself renders
  // only when `canEdit`); when `canEdit` is false the skip condition drops
  // to `false`, so this fetches once on mount instead, same effect-cleanup
  // shape as before.
  useEffect(() => {
    if (loaded || (!open && canEdit)) return;
    let cancelled = false;
    apiV1<{
      stage_id: string;
      required_court_tags: string[];
      rounds: { round_role: string; required_court_tags: string[] }[];
      available_round_roles: string[];
    }>(`/api/v1/stages/${stageId}/court-tags`)
      .then((data) => {
        if (cancelled) return;
        setStageTags(data.required_court_tags);
        setRounds(data.rounds);
        setAvailableRoles(data.available_round_roles);
        setLoaded(true);
        setLoadError(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(true);
        setError(err instanceof Error ? err.message : msg("stagetags.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, loaded, canEdit, stageId, msg]);

  /** A role key becomes text in exactly one place repo-wide (round-role-label
   *  .ts). An unparseable key is rendered RAW rather than hidden: the server
   *  accepts any RoundRoleKey the engine knows, and a client that is one
   *  release behind must still show the organiser what rule exists. */
  const roleLabel = (key: string): string => {
    const role = parseRoundRoleKey(key);
    return role === null ? key : roundRoleLabel(msg, role);
  };

  // Derived, never stored: a `setLoading(true)` in the effect body is exactly
  // the cascading-render pattern the lint rule rejects, and the state it would
  // hold is already implied by open + not-loaded + no-error.
  const loading = open && !loaded && !loadError;

  const unusedRoles = availableRoles.filter((r) => !rounds.some((row) => row.round_role === r));

  const summary =
    rounds.length > 0
      ? msg("stagetags.summary.rounds", { n: rounds.length })
      : stageTags.length > 0
        ? stageTags.join(", ")
        : msg("stagetags.any");

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      // Both keys always sent: `rounds` is a whole-list replace server-side, so
      // omitting it would leave deleted rows alive (route.ts PUT contract).
      await apiV1(`/api/v1/stages/${stageId}/court-tags`, {
        method: "PUT",
        json: { required_court_tags: stageTags, rounds },
      });
      setNotice(msg("stagetags.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("stagetags.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // Owner request - a non-editing viewer gets no button and no modal at all, just the current value as plain text. Match Day E1 item 1:
  // the panel mounts this ONE element at the card's foot for an editor and a viewer alike (`{courtTagsEditor}`), so the early return here
  // is the only thing that tells the two apart. It is safe - every hook above has already run unconditionally, so this branches on JSX
  // only, never a hook. Byte-identical `data-testid` either way, so a reader locating the value does not care which branch rendered it.
  if (!canEdit) {
    return (
      <div className="border-t border-slate-100 px-4 py-3" data-testid="stage-court-tags">
        <p className="text-xs font-semibold text-slate-700">
          {msg("stagetags.title")}
          {loaded && <span className="ml-1 font-normal text-slate-500">· {summary}</span>}
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-slate-100 px-4 py-3" data-testid="stage-court-tags">
      {/* Owner request, competition desk W3 (on top of Option B) — a real
          button, not the old 248x16px inline-disclosure summary row (well
          under the 44px tap floor). Shows the label AND the current value
          together ("Required court tags · Any court") so it reads as a
          setting at a glance, matching what the collapsed row already
          showed once loaded — `{loaded && ...}` is byte-identical to the
          old inline version, never re-derived. Opens a MODAL instead of
          expanding inline; the editor body inside is untouched. */}
      <button
        type="button"
        data-testid="stage-court-tags-trigger"
        // `setOpen(!open)`, not `setOpen(true)` — matches the OLD inline
        // disclosure's own toggle semantics and keeps this button usable as
        // BOTH open and close for anything driving it directly (the modal
        // itself covers the trigger visually once open, in a real browser,
        // so a genuine second CLICK can never reach it there — this is a
        // no-op for real users, not a UX change; it only matters for a
        // caller that fires `onClick` programmatically, e.g. a test).
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-11 w-full min-w-0 items-center gap-1.5 text-left text-xs font-semibold text-slate-700 hover:text-slate-900"
      >
        <span>{msg("stagetags.title")}</span>
        {loaded && <span className="min-w-0 truncate font-normal text-slate-500">· {summary}</span>}
        <span aria-hidden="true" className="ml-auto shrink-0 text-slate-400">
          ›
        </span>
      </button>

      {open && (
        // Reuse `components/modal.tsx` rather than a third bottom-sheet
        // variant (brief), EXACTLY as it ships — controller ruling C-2: a
        // first attempt moved modal.tsx's own `sm:` breakpoint to `md:`
        // ("scoped to this one file"), and the full suite caught it anyway
        // (`pass-checkout-parity.test.tsx`) — `Modal` is also imported by
        // `billing-actions.tsx`, `buy-credits.tsx`, `admin-credits-
        // panel.tsx`, `registration-hub-config-panel.tsx` and `template-
        // gallery.tsx`, so moving its OWN breakpoint is the same product-
        // wide blast radius as moving the shared `.modal-overlay`/
        // `.sheet-handle` CSS classes would have been — a different route
        // to an identical reach, not a smaller one. Ruling 15 ("unify on
        // `md:`") governs the DESK, not every shared primitive it happens
        // to reach. So this modal stays `sm:`-breakpointed like every
        // other `<Modal>` in the product; the difference between a sheet
        // under 640px and one under 768px is not worth a product-wide
        // change for this one popup. Title is the same "Required court
        // tags" the trigger button shows, so the modal header and the
        // control that opened it read as the same setting. `onClose` just
        // flips `open` back — `loaded`/`stageTags`/
        // `rounds` all stay in this component's own state, so reopening
        // shows whatever was last edited, exactly like the old inline
        // expand/collapse never re-fetched either.
        <Modal title={msg("stagetags.title")} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            {loading && <p className="text-xs text-slate-500">{msg("stagetags.loading")}</p>}
            {loaded && (
              <>
                <p className="text-xs text-slate-500">{msg("stagetags.desc")}</p>
                <TagChipInput
                  value={stageTags}
                  onChange={setStageTags}
                  suggestions={suggestions}
                  disabled={!canEdit}
                  label={msg("stagetags.stageLabel")}
                  placeholder={msg("tags.placeholder")}
                  addLabel={msg("tags.add")}
                  removeLabelFor={(tag) => msg("tags.remove", { tag })}
                  suggestionsLabel={msg("tags.suggestions")}
                />

                <div className="flex flex-col gap-3 border-t border-dashed border-slate-200 pt-3">
                  <p className="text-xs font-semibold text-slate-700">{msg("stagetags.rounds.heading")}</p>
                  {availableRoles.length === 0 && rounds.length === 0 ? (
                    <p className="text-xs text-slate-500">{msg("stagetags.rounds.none")}</p>
                  ) : (
                    <>
                      {rounds.map((row, i) => (
                        <div key={row.round_role} className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="text-xs font-medium text-slate-700">{roleLabel(row.round_role)}</span>
                            {canEdit && (
                              <button
                                type="button"
                                className="btn btn-ghost px-2 py-1 text-xs"
                                onClick={() => setRounds(rounds.filter((_, j) => j !== i))}
                              >
                                {msg("stagetags.rounds.remove")}
                              </button>
                            )}
                          </div>
                          <TagChipInput
                            value={row.required_court_tags}
                            onChange={(next) =>
                              setRounds(rounds.map((r, j) => (j === i ? { ...r, required_court_tags: next } : r)))
                            }
                            suggestions={suggestions}
                            disabled={!canEdit}
                            label={msg("stagetags.rounds.tagsLabel", { round: roleLabel(row.round_role) })}
                            placeholder={msg("tags.placeholder")}
                            addLabel={msg("tags.add")}
                            removeLabelFor={(tag) => msg("tags.remove", { tag })}
                            suggestionsLabel={msg("tags.suggestions")}
                          />
                        </div>
                      ))}
                      {canEdit && unusedRoles.length > 0 && (
                        // Adding a round is a one-tap select, not a select+button
                        // pair: the choice IS the action, and a second control
                        // would be one more thing to fit at 320px.
                        <label className="label flex flex-col gap-1 text-xs">
                          {msg("stagetags.rounds.add")}
                          <select
                            className="input min-h-11 w-full py-1.5 text-sm"
                            value=""
                            onChange={(e) => {
                              if (e.target.value === "") return;
                              setRounds([...rounds, { round_role: e.target.value, required_court_tags: [] }]);
                            }}
                          >
                            <option value="" />
                            {unusedRoles.map((role) => (
                              <option key={role} value={role}>
                                {roleLabel(role)}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </>
                  )}
                </div>

                {canEdit && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save()}
                    className="btn btn-primary min-h-11 w-full px-3 py-1.5 text-xs md:w-auto md:self-start"
                  >
                    {saving ? msg("schedule.working") : msg("stagetags.save")}
                  </button>
                )}
              </>
            )}
            {notice !== null && <p className="text-xs text-green-700">{notice}</p>}
            {error !== null && <p className="text-xs text-red-600">{error}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
