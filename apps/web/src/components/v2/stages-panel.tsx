"use client";

// Fixture console per stage (PROMPT-15 task 1, rebuilt per v3/04 §3): rounds
// grouped with date ranges, competition-timezone rendering, pinned
// unscheduled section with an auto-schedule CTA, "Now playing" strip, inline
// reschedule with undo, bye/void ghost rows, sticky round headers on mobile,
// print via the DocModel timetable export. Scoring lives on the fixture page.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { routes } from "@/lib/routes";
import { ClientDateRange, ClientTime } from "@/components/client-time";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { TipCallout } from "@/components/ui/tip";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { seedingErrorMessage } from "@/lib/seeding-error";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { resolveSlotLabel } from "@/lib/slot-label";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { parseRoundRoleKey } from "@seazn/engine/competition";
import { TagChipInput } from "@/components/ui/tag-chip-input";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { DocumentsMenu } from "@/components/v2/board/documents-menu";
import { ScheduleResultStrip } from "@/components/v2/board/result-strip";
import { DateTimeField } from "./shared/datetime-field";
import { boardSlotTimes } from "./shared/time-options";
import { windowsToDailyHours } from "@/lib/schedule-board";
import { courtDisplayName, type BoardConfig } from "@/components/v2/board/types";
// P9 pass 4d: item 1 — this panel's per-fixture court editor used to seed
// from and PATCH the frozen `court_label` text column, which 400s against
// PatchFixture's `.strict()` schema (only `court_id` is a valid key now).
// `courtGroups`/`resolveCourtNames` are the SAME shared pieces the board's
// own `courtNamesById` and the settings tab's `CourtMultiPicker` already use
// — reused here rather than a third court-name/court-picker implementation.
import { courtGroups, flattenCourts, resolveCourtNames } from "@/components/v2/shared/court-multi-picker";
// P9: the BOARD-side Venue (no `hours`/`exceptions`) — this panel shows and
// picks courts, it never reads a calendar. See court-multi-picker.tsx.
import type { Venue } from "@/components/v2/shared/court-multi-picker";
import type { PatchFixture } from "@/server/api-v1/schemas";
import { zonedTimeInput } from "@/lib/zoned-datetime";
import type { z } from "zod";
import type { ApplyScheduleRequest, ScheduleMetrics, ScheduleSolverInfo } from "@/server/api-v1/schemas";
// D2 capacity pre-check — client-safe leaf only, see capacity-input.ts's
// header for why this file must never reach @seazn/engine/scheduling (the
// solver barrel) or capacity-guard.ts (server-only). P10 §4/Task 6: the
// verdict itself no longer comes from a local capacityInputForFixtures +
// assessCapacity call — see useCapacityReport's own header for why — this
// file only builds the WIRE BODY the hook sends, which still needs
// dayKeyInTz/ymdAddDays/zonedTimeToUtc for the window math.
import { dayKeyInTz, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling/tz";
import {
  useCapacityReportsByStage,
  type CapacityReportConfig,
  type CapacityRequest,
  type UseCapacityReportResult,
} from "@/lib/use-capacity-report";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface StageRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: Record<string, unknown> | null;
  status: string;
}
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
  /** Organiser setup that a rebuild clears along with the fixtures — see
   *  StageRosterDrift.attachments (usecases/stages.ts) for why these do not
   *  BLOCK the rebuild the way a recorded result does. Optional: hand-built
   *  props in this panel's own __tests__ predate the field. */
  attachments?: { officials: number; lineups: number; deviceLinks: number };
}

interface Props {
  divisionId: string;
  /** The division's event-ledger head (`DivisionRow.seq`, gap 10) at render
   *  time — this panel's `autoScheduleStage` (#pins-ui, owner ruling
   *  2026-08-12) sends it as `expected_seq` on the apply, exactly as the
   *  board's own optimistic-concurrency token does. Without it a lock toggled
   *  while the solve was running was silently overwritten by the stale
   *  proposal (`assertFreshSeq` no-ops on an absent token) — this panel never
   *  held the division's watermark before, so it never had anything to send. */
  divisionSeq: number;
  /** Competition id — the Admit tickets export is competition-scoped. */
  competitionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  stages: StageRow[];
  fixtures: FixtureRow[];
  entrantNames: Record<string, string>;
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
  /** Competition timezone (schedule settings) — every time renders in it. */
  tz: string;
  /** The GOVERNING venue clock (`settings.orgTz`, #448), resolved server-side.
   *  Distinct from `tz`, which is display-only and which a division may
   *  override: the board-slot grid must be anchored on this one or the offered
   *  times drift off the board by the offset difference. */
  orgTz: string;
  /** Documents menu goes through the Jul3/06 / v12 exports (Pro `exports` gate). */
  canExport: boolean;
}

// PROMPT-66: stage kinds that accept an ad-hoc match (standings fold every
// fixture there). Bracket kinds have no slot for a loose fixture; ladder /
// americano have their own on-demand mechanisms.
const ADHOC_STAGE_KINDS = new Set(["league", "group", "swiss"]);

const FIXTURE_STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-600",
  in_play: "bg-amber-100 text-amber-700",
  decided: "bg-sky-100 text-sky-700",
  finalized: "bg-emerald-100 text-emerald-700",
  abandoned: "bg-slate-100 text-slate-400",
  forfeited: "bg-red-50 text-red-500",
  cancelled: "bg-slate-100 text-slate-400",
};

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

/** What `capacityRequestForStage` hands to `useCapacityReportsByStage` for
 *  one stage — `null` when there is nothing to even ask the server yet
 *  (settings not loaded, or incomplete). A thin alias of the hook's own
 *  general-purpose `CapacityRequest`, kept under this panel's established
 *  name for its own test file and callers. */
export type CapacityStageRequest = CapacityRequest;

/**
 * D2 capacity pre-check gate (review fix, Finding 2): the Auto-schedule
 * button's `disabled` condition and the "blocked reason" line below it now
 * SHARE this one predicate — they used to inline the same expression twice,
 * which is how they could have silently drifted. FAILS OPEN: a check that
 * could not complete (`.failed` — useCapacityReport's own doc comment) never
 * blocks, even when the last report it ever received said "impossible".
 * Before this fix, a real fetch failure (500, network drop, a 4xx schema
 * rejection) was swallowed identically to a superseded abort, so `.report`
 * kept returning that OLD verdict forever — an actionable control frozen
 * with no visible reason. Solve is hard-blocked ONLY on a genuinely FRESH
 * `impossible` verdict (owner ruling); a stale guess, whether merely
 * catching up (`.stale`) or actually broken (`.failed`), is not one — a
 * catching-up check still gates on the last KNOWN verdict (unchanged), but
 * a broken one must not.
 */
export function capacityGateBlocks(cap: UseCapacityReportResult | undefined): boolean {
  if (cap?.failed) return false;
  return cap?.report?.verdict === "impossible";
}

/**
 * D2 capacity pre-check for ONE stage (P10 §4/Task 6): pure, exported so it
 * is unit-testable with hand-built inputs directly, matching the ORIGINAL
 * capacityForStage's own reasoning — `scheduleSettings.config` arrives via
 * a `useEffect` fetch (`renderToStaticMarkup` never fires effects — see
 * component-ui-i18n memory), so a render-level test cannot exercise this.
 *
 * No longer computes a verdict itself — see useCapacityReport's own header
 * for why the report can only come from the server now. This function's
 * whole job is the MAPPING: which fixtures belong to this stage, and the
 * wire-shaped config to send alongside them. `null` covers both "nothing
 * to assess" (no bounded window — the actual skip is useCapacityReport's
 * own job, see `hasAssessableWindow`) and "settings haven't loaded yet" —
 * the button must stay enabled either way, matching "client hint, server
 * authority": an unloaded precheck must never read as a false
 * "impossible".
 *
 * `venues` (review fix, finding 5): defaulted to `[]` so every pre-existing
 * caller/test keeps compiling unchanged. Real callers should always pass the
 * panel's own `venues` prop — see the courts fallback below.
 */
export function capacityRequestForStage(
  stageId: string,
  fixtures: readonly Pick<FixtureRow, "id" | "stage_id" | "status" | "home_entrant_id" | "away_entrant_id" | "pool_id">[],
  config: DivisionScheduleSettings["config"] | undefined,
  orgTz: string,
  venues: readonly Venue[] = [],
): CapacityStageRequest {
  if (config === undefined || config.matchMinutes === undefined || config.gapMinutes === undefined) return null;
  const movable = fixtures.filter((f) => f.stage_id === stageId && f.status === "scheduled");
  // `id` is free (FixtureRow above already carries it) and lets an `id`-kind
  // fixture_on_date/fixture_on_weekday selector resolve into a forcedDemand
  // floor server-side too. `extKey`/`winnerTo` (CapacityFixtureInput's other
  // two RuleFixture-identity fields, capacity-input.ts) are NOT available
  // here — `FixtureRow` never fetches `ext_key`/`winner_to_fixture`, and
  // neither is even in the public API schema — so a `terminal`/`ext_key`
  // selector cannot resolve and stays undercounted on this card. Same
  // "client hint, server authority" split as demandCap.
  return {
    fixtures: movable.map((f) => ({
      home: f.home_entrant_id ?? undefined,
      away: f.away_entrant_id ?? undefined,
      poolId: f.pool_id ?? undefined,
      id: f.id,
    })),
    config: {
      // Review fix (finding 5): `ScheduleConfig.courts` defaults to `[]` and
      // is never nullish, so `?? ["Court 1"]` never actually fired in the
      // real app — a division that never configured courts sent `courts:
      // []` -> supply 0 -> verdict "impossible" -> Auto-schedule wrongly
      // disabled, even though the server build falls back to every
      // non-archived org court. Same effectiveCourts fallback
      // settings-panel.tsx's capacityRequestFromDraft already uses, reused
      // rather than a second implementation of "which courts count as
      // unconstrained" — and the `["Court 1"]` literal is gone: it was also
      // a guaranteed 400 against CapacityPrecheckInput's `z.uuid()` schema
      // had it ever reached the wire.
      courts:
        config.courts && config.courts.length > 0
          ? config.courts
          : flattenCourts(venues).map((c) => c.id),
      sessionWindows: (config.sessionWindows ?? []).map((w) => ({ from: Date.parse(w.from), to: Date.parse(w.to) })),
      blackouts: (config.blackouts ?? []).map((b) => ({
        ...(b.court !== undefined ? { court: b.court } : {}),
        from: Date.parse(b.from),
        to: Date.parse(b.to),
      })),
      matchMinutes: config.matchMinutes,
      gapMinutes: config.gapMinutes,
      perEntrantMinRest: config.perEntrantMinRest ?? 0,
      window:
        config.startAt || config.endAt
          ? {
              from: config.startAt
                ? zonedTimeToUtc(dayKeyInTz(Date.parse(config.startAt), orgTz), "00:00", orgTz)
                : -Infinity,
              to: config.endAt
                ? zonedTimeToUtc(ymdAddDays(dayKeyInTz(Date.parse(config.endAt), orgTz), 1), "00:00", orgTz)
                : Infinity,
            }
          : undefined,
    },
  };
}


export function StagesPanel({ divisionId, divisionSeq, competitionId, orgSlug, compSlug, divSlug, stages, fixtures, entrantNames, venues = [], rosterDrift = {}, canEdit, tz, orgTz, canExport }: Props) {
  const msg = useMsg();
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
  // #622 tag suggestions for the per-stage editors below: every tag any court
  // in the loaded venues carries, ranked by use (the same rule
  // division-settings.tsx and venues-panel.tsx apply). Read off the `venues`
  // prop this panel already receives — never a second fetch per stage card.
  const courtTagSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of venues) for (const c of v.courts) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
  }, [venues]);
  // Optimistic-concurrency token (v3/11 gap 10), mirroring use-board-actions
  // .ts's `seqRef` for this panel's one division: the ref is what
  // `autoScheduleStage` reads/bumps between writes, resynced from the prop on
  // every server refresh so a write right after `router.refresh()` lands
  // never races a value that predates it.
  const divisionSeqRef = useRef(divisionSeq);
  useEffect(() => {
    divisionSeqRef.current = divisionSeq;
  }, [divisionSeq]);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // stage id in flight
  const [notice, setNotice] = useState<string | null>(null);
  // "Générer les matchs" precondition-not-met (design/fix-ui/03 §"misleading
  // success message"): distinct from `notice` (success, green) and `error`
  // (generic failure, red) — an amber, actionable "here's what to fix" state
  // so it's never confused with the "nothing new — up to date" success copy.
  const [warning, setWarning] = useState<string | null>(null);
  // Set after an inline reschedule lands: the notice grows an Undo button
  // that steps the division history back one event (Jul3/03).
  const [undoable, setUndoable] = useState(false);
  // PROMPT-66: stage id whose inline "Add match" form is open.
  const [addingTo, setAddingTo] = useState<string | null>(null);
  /** Board quality + solver telemetry from the last "Auto-schedule remaining"
   *  run, for the same result strip the board renders (Task 12).
   *
   *  This entry point hits the SAME endpoint the board does, so Task 9's report
   *  arrives here too. Rendering it on one surface and discarding it on the other
   *  is the asymmetry that made an organiser's answer depend on which page they
   *  happened to start from. Null whenever the wire did not carry the blocks —
   *  the strip stays away rather than reporting zeros. */
  const [lastRun, setLastRun] = useState<{
    metrics: ScheduleMetrics;
    solver: ScheduleSolverInfo;
  } | null>(null);
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

  // D2 capacity pre-check: per STAGE (matching the scope of the button below
  // and of the server guard on /stages/{id}/schedule/auto), from whatever
  // `scheduleSettings` the effect above already fetched — no second fetch.
  const capacityRequestByStage = useMemo(() => {
    const byStage = new Map<string, CapacityStageRequest>();
    for (const stage of stages) {
      byStage.set(
        stage.id,
        capacityRequestForStage(stage.id, fixtures, scheduleSettings?.config, orgTz, venues),
      );
    }
    return byStage;
  }, [scheduleSettings, stages, fixtures, orgTz, venues]);
  // The verdict itself is read live off ONE useCapacityReportsByStage
  // subscription (not one useCapacityReport call per stage — the button
  // below has to stay a DIRECT part of this component's own render output;
  // see the hook's own header for why a per-stage child component broke
  // pre-existing tests that locate it by testid).
  const capacityByStage = useCapacityReportsByStage(divisionId, capacityRequestByStage);

  async function undoLast() {
    setError(null);
    // The strip describes a board. Undo puts a DIFFERENT board back, so every
    // number on it — length, spread, "18 of 22 scheduled" — stops being true of
    // what the organiser is looking at. Same rule the board's own hook follows:
    // every write clears the report.
    setLastRun(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/undo`, { method: "POST", json: {} });
      setNotice(msg("schedule.notice.undone"));
      setUndoable(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("schedule.error.undoFailed"));
    }
  }

  // "Auto-schedule remaining" (v3/04 §3 item 3) — the board's propose+apply
  // pair for one stage, launched from the pinned unscheduled section. A
  // SECOND, independent implementation of the same propose+apply pair
  // use-board-actions.ts's `autoRun` runs for the board — see that file for
  // why the shape below (a `solve`/`applyOnce`/`propose` split, one silent
  // retry on SEQ_CONFLICT) is not shared code: same defect, same owner
  // ruling, two call sites the brief scoped separately.
  async function autoScheduleStage(stageId: string) {
    setError(null);
    setNotice(null);
    setLastRun(null);
    setBusy(stageId);
    try {
      type Proposal = {
        // P9: INFERRED from the schema the server validates against. A hand
        // written wire type is an assertion `apiV1<T>` never checks — that is
        // exactly how the board's apply shipped `court_label` and 400'd every
        // Auto-schedule run for the whole cutover.
        assignments: z.infer<typeof ApplyScheduleRequest>["assignments"];
        metrics?: ScheduleMetrics;
        solver?: ScheduleSolverInfo;
      };
      const solve = () =>
        apiV1<Proposal>(`/api/v1/stages/${stageId}/schedule/auto`, {
          method: "POST",
          json: { only_unlocked: true },
        });

      const applyOnce = (assignments: Proposal["assignments"], expectedSeq: number | undefined) =>
        apiV1<{ applied: number }>(`/api/v1/stages/${stageId}/schedule/apply`, {
          method: "POST",
          json: { assignments, source: "auto", expected_seq: expectedSeq },
        });

      // BEFORE the empty-proposal check, not after. This CTA fires from the
      // UNSCHEDULED section, so "the solver could place none of them" is the
      // ordinary shape of a bad run here — and it is exactly the run whose
      // report the organiser needs. Capturing after the check would hide the
      // strip on the only board that has to explain itself.
      const propose = async (): Promise<Proposal | null> => {
        const out = await solve();
        // OPTIONAL even though Task 9 populates both: a cached response, or a
        // server one deploy behind, carries neither, and a strip of zeros is
        // a worse answer than no strip.
        if (out.metrics && out.solver) setLastRun({ metrics: out.metrics, solver: out.solver });
        if (out.assignments.length === 0) {
          setNotice(msg("schedule.notice.nothingToSchedule"));
          return null;
        }
        return out;
      };

      const out = await propose();
      if (!out) return;

      let expectedSeq = divisionSeqRef.current;
      let applied: { applied: number };
      try {
        applied = await applyOnce(out.assignments, expectedSeq);
      } catch (err) {
        if (!(err instanceof ApiV1Error) || err.code !== "SEQ_CONFLICT") throw err;
        // #pins-ui, owner ruling 2026-08-12 — same treatment as the board's
        // autoRun: the lock toggled mid-solve, so silently re-solve ONCE
        // against the fresh board and apply THAT, rather than force the stale
        // (possibly now-illegal) proposal through or surface an error the
        // organiser did nothing to cause. `current_seq` rides on the 409
        // itself (server/api-v1/http.ts) — no need to wait on
        // `router.refresh()` to repopulate this panel's props first.
        expectedSeq = typeof err.extra.current_seq === "number" ? err.extra.current_seq : expectedSeq;
        const retryOut = await propose();
        if (!retryOut) return;
        // A SECOND SEQ_CONFLICT here is NOT caught — it propagates to the
        // outer catch and surfaces normally. Exactly one automatic retry.
        applied = await applyOnce(retryOut.assignments, expectedSeq);
      }
      divisionSeqRef.current = (expectedSeq ?? 0) + 1;
      setNotice(msg("schedule.notice.placed", { n: applied.applied }));
      setUndoable(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function act(stageId: string, action: "generate" | "complete" | "delete") {
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setWarning(null);
    // Generate/complete/delete all change which cards exist, so the last run's
    // "18 of 22 scheduled" is about a different stage. Cleared for the same
    // reason as `undoLast` above.
    setLastRun(null);
    setBusy(stageId);
    try {
      if (action === "delete") {
        await apiV1(`/api/v1/stages/${stageId}`, { method: "DELETE" });
        setNotice(msg("schedule.notice.stageDeleted"));
      } else if (action === "generate") {
        const out = await apiV1<{ created: number; existing: number }>(
          `/api/v1/stages/${stageId}/generate`,
          { method: "POST", json: {} },
        );
        setNotice(
          out.created > 0
            ? msg("schedule.notice.generated", { created: out.created, existing: out.existing })
            : msg("schedule.notice.nothingNew"),
        );
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
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        const classified = classifyActError(err, msg, locale);
        if (classified.tone === "warning") setWarning(classified.text);
        else setError(classified.text);
        if (classified.refresh) router.refresh();
      }
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
    setLastRun(null);
    setBusy(stageId);
    try {
      const out = await apiV1<{ created: number; existing: number; removed: number }>(
        `/api/v1/stages/${stageId}/rebuild`,
        { method: "POST", json: {} },
      );
      setNotice(msg("progression.rosterDrift.rebuiltNotice", { removed: out.removed }));
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
        if (blocked) {
          setWarning(blocked);
        } else {
          setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
        }
      }
    } finally {
      setBusy(null);
    }
  }

  if (stages.length === 0) {
    return <p className="text-sm text-slate-500">{msg("schedule.noStages")}</p>;
  }

  const nowPlaying = fixtures.filter((f) => f.status === "in_play");

  return (
    <div className="space-y-6">
      {canEdit && <TipCallout id="division.start-locks" />}
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
      {/* Directly under the green "Placed N matches" line, as on the board: the
          strip is the QUALIFICATION of that line. The notice counts what the
          apply wrote; only this says what the solver could not do. */}
      {lastRun && <ScheduleResultStrip metrics={lastRun.metrics} solver={lastRun.solver} />}
      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {/* Precondition-not-met (amber, actionable) — never the green success
          banner: "Générer les matchs" did nothing because the entrants can't
          fill the configured groups yet, not because it was already done. */}
      {warning && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p>
      )}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {/* Timezone honesty (v3/04 §3 item 2) + print (item 8). */}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-slate-500" data-testid="tz-caption">
          {msg("schedule.tz.caption", { tz })}
        </p>
        <div className="flex-1" />
        {canExport && <DocumentsMenu divisionId={divisionId} competitionId={competitionId} />}
      </div>

      {/* "Now playing" strip (item 4): in-play matches float above the rounds. */}
      {nowPlaying.length > 0 && (
        <section
          className="rounded-xl border border-amber-200 bg-amber-50/70 p-3"
          aria-label={msg("schedule.nowPlaying")}
        >
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-amber-800 uppercase">
            {msg("schedule.nowPlaying")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {nowPlaying.map((f) => (
              <li key={f.id}>
                <Link
                  href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 hover:border-amber-400"
                >
                  <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  {/* max-w + truncate (P6/D4b): a slot label ("Best 3 of the
                      3rd-place teams") runs far longer than a team name — an
                      in_play fixture always has both entrants filled in
                      practice (scoring an unfilled fixture 422s), so this is
                      a defensive floor, not the common case. */}
                  <span className="inline-block max-w-[9rem] truncate align-bottom">
                    {f.home_entrant_id
                      ? (entrantNames[f.home_entrant_id] ?? "?")
                      : resolveSlotLabel(f.home_slot_label ?? null, msg, "schedule.tbd")}
                  </span>{" "}
                  {msg("schedule.vs")}{" "}
                  <span className="inline-block max-w-[9rem] truncate align-bottom">
                    {f.away_entrant_id
                      ? (entrantNames[f.away_entrant_id] ?? "?")
                      : resolveSlotLabel(f.away_slot_label ?? null, msg, "schedule.tbd")}
                  </span>
                  {/* P9 pass 4d: resolved NAME first (venue-qualified when
                      ambiguous), the frozen label as a fallback — never a raw
                      court_id. */}
                  {courtDisplayName(f, courtNamesById) ? (
                    <span className="text-slate-500">· {courtDisplayName(f, courtNamesById)}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Active work first: completed stages sink to the bottom, so once the
          league wraps up the semis/final card is what the organiser lands on. */}
      {[...stages]
        .sort(
          (a, b) =>
            (a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0) ||
            a.seq - b.seq,
        )
        .map((stage) => {
        const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
        const rounds = [...new Set(stageFixtures.map((f) => f.round_no))].sort((a, b) => a - b);
        // Pinned unscheduled section (v3/04 §3 item 3): timetable-less rows
        // come out of the round lists; byes stay in place as ghosts.
        const unscheduled = stageFixtures.filter(
          (f) => f.scheduled_at === null && f.status === "scheduled" && !isBye(f),
        );
        const roundDates = (round: number): { from: string | null; to: string | null } => {
          const times = stageFixtures
            .filter((f) => f.round_no === round && f.scheduled_at !== null)
            .map((f) => f.scheduled_at as string)
            .sort();
          return { from: times[0] ?? null, to: times[times.length - 1] ?? null };
        };
        // League/group rounds display in ACTUAL earliest-kickoff order, not
        // generation order (round_no) — auto-scheduling (parallel courts) or a
        // manual reschedule can leave a later-numbered round with an earlier
        // kickoff than one before it, which would mislead an organiser reading
        // the round list for "what's next" (design/fix-ui/03 §"rounds out of
        // order"). Rounds with no scheduled fixture yet have no time to sort
        // by, so they fall back to round_no order after every dated round.
        // Bracket stages (splitRounds below) are structural, not chronological
        // (Quarter → Semi → Final), so they keep round_no order untouched.
        const orderedRounds = [...rounds].sort((a, b) => {
          const da = roundDates(a).from;
          const db = roundDates(b).from;
          if (da !== null && db !== null) return da < db ? -1 : da > db ? 1 : a - b;
          if (da !== null) return -1;
          if (db !== null) return 1;
          return a - b;
        });
        // Mirrors the server guard (deleteStage) EXACTLY: only the last stage
        // in the graph, and only when it owns no played fixtures. No "keep one
        // stage" rule — the server deletes the sole stage of a pure League too,
        // which is the only escape from the format lock once fixtures exist.
        const deletable =
          stage.seq === Math.max(...stages.map((s) => s.seq)) &&
          !stageFixtures.some((f) => ["in_play", "decided", "finalized"].includes(f.status));
        // Bracket stages: one card per named round (Quarter-finals, Semi-finals,
        // Final / Rung N) instead of one long card with anonymous round breaks.
        const splitRounds = BRACKET_KINDS.has(stage.kind) && rounds.length > 0;
        // F3 Task 5 (5a) — only ever non-empty for the one stage
        // getStageRosterDrift finds eligible (usecases/stages.ts); every
        // other stage's entry is absent or both arrays empty, so this is a
        // no-op read for the common case.
        const drift = rosterDrift[stage.id];
        const hasDrift = Boolean(drift && (drift.ghosts.length > 0 || drift.unplaced.length > 0));
        return (
          <div key={stage.id} className="space-y-6">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">
                {stage.seq}. {stage.name}
              </h3>
              <span className="chip">{stage.kind.replace(/_/g, " ")}</span>
              <span className={`badge ${stageStatusStyle(stage.status)}`}>{stageStatusLabel(msg, stage.status)}</span>
              <div className="flex-1" />
              {canEdit && stage.status !== "complete" && (
                <>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      // P6/D4b task B, scope item 2 — REVERSED (fix round 3,
                      // Critical 1, whole-branch review): this click used to
                      // be gated behind a "you'll lose N fixtures" confirm
                      // dialog whenever stageFixtures.length > 0. That
                      // premise was never checked against the code and is
                      // false — generateStageFixtures (stages.ts) is
                      // ADDITIVE ONLY. It builds `byKey` from the stage's
                      // existing fixtures and inserts only the generated
                      // rows missing from it (stages.ts:997-1031); any
                      // existing fixture that no longer matches the current
                      // rules is left in place, untouched, not discarded.
                      // The repo's only `delete from fixtures` are
                      // history.ts's checkpoint restore and a demo seed —
                      // neither is this code path. So the dialog blocked a
                      // routine, safe action (an organiser adding a late
                      // entrant, then clicking Generate again) behind a
                      // false data-loss warning.
                      //
                      // Deliberately NOT replaced with a truthful-but-vague
                      // "this won't remove stale fixtures" disclaimer either:
                      // there is no client-side way to tell whether any
                      // existing fixture actually IS stale (that diff is
                      // engine-only, server-side, out of this task's scope —
                      // same reason the old dialog computed a client-side
                      // "blast radius" instead of the real diff in the first
                      // place). A disclaimer with no computed fact behind it
                      // would just be new boilerplate to click through on
                      // every regenerate, forever, in place of one that
                      // named specific (if wrong) numbers. Regeneration is
                      // simply a normal, unguarded action now, same as the
                      // common first-generate case always was.
                      void act(stage.id, "generate");
                    }}
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                  >
                    {busy === stage.id
                      ? msg("schedule.working")
                      : stage.kind === "swiss"
                        ? msg("schedule.pairNext")
                        : msg("schedule.generate")}
                  </button>
                  {ADHOC_STAGE_KINDS.has(stage.kind) && stageFixtures.length > 0 && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setAddingTo(addingTo === stage.id ? null : stage.id)}
                      className="btn btn-ghost px-3 py-1.5 text-xs"
                    >
                      {msg("stage.addMatch.button")}
                    </button>
                  )}
                  {stageFixtures.length > 0 && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => act(stage.id, "complete")}
                      className="btn btn-primary px-3 py-1.5 text-xs"
                    >
                      {msg("schedule.complete")}
                    </button>
                  )}
                </>
              )}
              {canEdit && deletable && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: msg("confirm.deleteStage.title"),
                      body: msg("confirm.deleteStage.body", { name: stage.name }),
                      confirmLabel: msg("confirm.deleteStage.label"),
                      tone: "danger",
                    });
                    if (ok) void act(stage.id, "delete");
                  }}
                  className="btn btn-danger px-3 py-1.5 text-xs"
                >
                  {msg("schedule.delete")}
                </button>
              )}
            </header>

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
                className="border-b border-dashed border-amber-200 bg-amber-50 px-4 py-3"
                data-testid="roster-drift-banner"
                data-roster-drift-state={drift.ghosts.length > 0 ? "ghosts" : "unplaced"}
              >
                <p className="text-xs font-semibold text-amber-900">
                  {msg("progression.rosterDrift.heading")}
                </p>
                {drift.ghosts.length > 0 && (
                  <p className="mt-1 text-xs text-amber-800">
                    {msg("progression.rosterDrift.ghostsLabel")}{" "}
                    {drift.ghosts.map((e) => e.display_name).join(", ")}
                  </p>
                )}
                {drift.unplaced.length > 0 && (
                  <p className="mt-1 text-xs text-amber-800">
                    {msg("progression.rosterDrift.unplacedLabel")}{" "}
                    {drift.unplaced.map((e) => e.display_name).join(", ")}
                  </p>
                )}
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
              </div>
            )}

            {/* PROMPT-66: inline ad-hoc match form (replay / friendly / tie-breaker). */}
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

            {/* Pinned unscheduled section (item 3) — count + auto CTA. */}
            {unscheduled.length > 0 && (
              <div className="border-b border-dashed border-slate-200 bg-slate-50/60 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-slate-700">
                    {msg("schedule.unscheduled.title")}
                    <span className="ml-1.5 rounded-full bg-slate-200 px-1.5 text-[11px] font-medium text-slate-700">
                      {unscheduled.length}
                    </span>
                  </p>
                  {canEdit && stage.status !== "complete" && (
                    <button
                      type="button"
                      data-testid="stage-auto-schedule"
                      disabled={busy !== null || capacityGateBlocks(capacityByStage.get(stage.id))}
                      onClick={() => void autoScheduleStage(stage.id)}
                      className="btn btn-primary min-h-11 px-3 py-1 text-xs"
                    >
                      {busy === stage.id ? msg("schedule.working") : msg("schedule.unscheduled.cta")}
                    </button>
                  )}
                </div>
                {/* D2 capacity pre-check (owner ruling: Solve hard-blocked
                    ONLY on a genuinely FRESH "impossible" — "tight" is
                    advisory and never blocks, and per the review fix above,
                    neither does a check that FAILED to run at all). The full
                    card with bars/suggestions lives on the Settings tab;
                    this is just the reason the button here is disabled —
                    same shared `capacityGateBlocks` predicate the button's
                    own `disabled` reads, so the two can never disagree. */}
                {capacityGateBlocks(capacityByStage.get(stage.id)) && (
                  <p data-testid="stage-auto-schedule-blocked" className="mt-1.5 text-xs text-red-600">
                    {msg("schedule.capacity.blockedReason")}
                  </p>
                )}
                <ul className="mt-2 divide-y divide-slate-100">
                  {unscheduled.map((f) => (
                    <FixtureLine
                      key={f.id}
                      fixture={f}
                      href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                      entrantNames={entrantNames}
                      canEdit={canEdit}
                      tz={tz}
                      boardSlotOptions={boardSlotOptions}
                      venues={venues}
                      courtNames={courtNamesById}
                      onRescheduled={() => {
                        setNotice(msg("schedule.rescheduled"));
                        setUndoable(true);
                      }}
                    />
                  ))}
                </ul>
              </div>
            )}

            {stageFixtures.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-500">
                {canEdit ? msg("schedule.noFixtures.can") : msg("schedule.noFixtures.view")}
              </p>
            ) : splitRounds ? null : (
              <div className="divide-y divide-slate-100">
                {orderedRounds.map((round) => {
                  const dates = roundDates(round);
                  return (
                  <div key={round}>
                    {/* Sticky round header (items 1 + 7): label + date range. */}
                    <p className="sticky top-0 z-10 flex items-baseline gap-2 border-y border-slate-300 bg-slate-200 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {msg("schedule.round", { n: round })}
                      {dates.from && (
                        <span data-testid="round-dates" className="font-medium normal-case text-slate-500">
                          <ClientDateRange from={dates.from} to={dates.to} tz={tz} />
                        </span>
                      )}
                    </p>
                    <ul className="divide-y divide-slate-50">
                      {stageFixtures
                        .filter((f) => f.round_no === round && (f.scheduled_at !== null || isBye(f) || f.status !== "scheduled"))
                        .map((f) => (
                          <FixtureLine
                            key={f.id}
                            fixture={f}
                            href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                            entrantNames={entrantNames}
                            canEdit={canEdit}
                            tz={tz}
                            boardSlotOptions={boardSlotOptions}
                            venues={venues}
                            courtNames={courtNamesById}
                            onRescheduled={() => {
                              setNotice(msg("schedule.rescheduled"));
                              setUndoable(true);
                            }}
                          />
                        ))}
                    </ul>
                  </div>
                  );
                })}
              </div>
            )}

            {/* #622 — sits with the stage's other settings, last in the card so
                it never pushes the fixture list below the fold. */}
            <StageCourtTagsEditor
              stageId={stage.id}
              canEdit={canEdit}
              suggestions={courtTagSuggestions}
              msg={msg}
            />
          </section>

          {splitRounds &&
            rounds.map((round) => {
              const dates = roundDates(round);
              return (
              <section key={round} className="card overflow-hidden">
                <header className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50 px-4 py-2">
                  <h4 className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    {stage.name} — {bracketRoundLabel(msg, stage.kind, round, stageFixtures)}
                    {dates.from && (
                      <span data-testid="round-dates" className="normal-case text-slate-500">
                        <ClientDateRange from={dates.from} to={dates.to} tz={tz} />
                      </span>
                    )}
                  </h4>
                </header>
                <ul className="divide-y divide-slate-50">
                  {stageFixtures
                    .filter((f) => f.round_no === round && (f.scheduled_at !== null || isBye(f) || f.status !== "scheduled"))
                    .map((f) => (
                      <FixtureLine
                        key={f.id}
                        fixture={f}
                        href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                        entrantNames={entrantNames}
                        canEdit={canEdit}
                        tz={tz}
                        boardSlotOptions={boardSlotOptions}
                        venues={venues}
                        courtNames={courtNamesById}
                        onRescheduled={() => {
                          setNotice(msg("schedule.rescheduled"));
                          setUndoable(true);
                        }}
                      />
                    ))}
                </ul>
              </section>
              );
            })}
          </div>
        );
      })}

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
        onError(err instanceof Error ? err.message : msg("schedule.error.failed"));
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
        <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} className="select">
          {[2, 3, 4, 6, 8].map((n) => (
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

const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);

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
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "";
  const items = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
  return msg("progression.rosterDrift.alsoCleared", { items });
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
  const precondition = generatePreconditionMessage(err, msg);
  if (precondition) return { tone: "warning", text: precondition, refresh: false };
  // F3 ultrareview finding 10 — was `err.message` verbatim, i.e. raw English
  // regardless of locale for every SEEDING_* code this panel can raise
  // (generateProgressionSetupFixtures throws SEEDING_MAP_SOURCE_AMBIGUOUS
  // straight out of `generate`). The copy already existed in all four
  // errors.json; nothing on THIS path read it. No codes were added to that
  // allowlist — see seeding-error.ts's own scope note — this is a second
  // reader of copy that was already written and already tested.
  if (err instanceof ApiV1Error) {
    return { tone: "error", text: seedingErrorMessage(locale, err.code, err.message), refresh: false };
  }
  return {
    tone: "error",
    text: err instanceof Error ? err.message : msg("schedule.error.failed"),
    refresh: false,
  };
}

export function generatePreconditionMessage(err: unknown, msg: Msg): string | null {
  if (!(err instanceof ApiV1Error) || err.code !== "STAGE_NOT_READY") return null;
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

/** A bye: one side empty with an auto-advance award outcome (v3/04 §3 item 6). */
function isBye(f: FixtureRow): boolean {
  const o = f.outcome as { kind?: string } | null;
  return o?.kind === "award" && (f.home_entrant_id === null || f.away_entrant_id === null);
}

/** Voided fixtures render struck through with the reason (item 6). */
const VOID_STATUSES = new Set(["cancelled", "abandoned", "forfeited"]);

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
function bracketRoundLabel(msg: Msg, kind: string, roundNo: number, stageFixtures: readonly FixtureRow[]): string {
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

/** Localized played-fixture status; unknown values fall back to the raw token. */
function fixtureStatusLabel(msg: Msg, status: string): string {
  const key = `schedule.fstatus.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status.replace("_", " ") : label;
}

function outcomeText(msg: Msg, outcome: unknown, entrantNames: Record<string, string>): string | null {
  const o = outcome as { kind?: string; winner?: string } | null;
  if (!o?.kind) return null;
  const winner = entrantNames[o.winner ?? ""] ?? "?";
  switch (o.kind) {
    case "win":
      return msg("schedule.outcome.won", { name: winner });
    case "award":
      return msg("schedule.outcome.wonWo", { name: winner });
    case "draw":
      return msg("schedule.outcome.draw");
    case "tie":
      return msg("schedule.outcome.tie");
    case "no_result":
      return msg("schedule.outcome.noResult");
    default:
      return null;
  }
}

export function FixtureLine({
  fixture,
  href,
  entrantNames,
  canEdit,
  tz,
  boardSlotOptions,
  venues = [],
  courtNames,
  onRescheduled,
}: {
  fixture: FixtureRow;
  href: string;
  entrantNames: Record<string, string>;
  canEdit: boolean;
  tz?: string;
  /** Board slots for the inline "When" field — see `boardSlotOptionsFor`
   *  above. `undefined` lets `DateTimeField` fall back to quarter hours. */
  boardSlotOptions?: string[];
  /** Org venues with nested courts — feeds the court picker below (P9 pass
   *  4d, item 1). Same shape/default as StagesPanel's own `venues` prop. */
  venues?: Venue[];
  /** id -> venue-qualified display name (StagesPanel's `courtNamesById`) —
   *  see `courtDisplayName`'s own doc comment. */
  courtNames?: Record<string, string>;
  /** Fired after a schedule PATCH lands — the panel offers Undo (item 5). */
  onRescheduled?: () => void;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(
    fixture.scheduled_at ? toLocalInput(fixture.scheduled_at) : "",
  );
  // P9 pass 4d: seeded from court_id, never court_label — court_label is
  // FROZEN (no writer has touched it since the pass 3a cutover), so seeding
  // the editor from it showed stale/blank state the moment a fixture's court
  // had ever been set post-cutover. PatchFixture is `.strict()` and has no
  // `venue`/`court_label` key at all, so a save built from the old
  // venue/court text state 400'd unconditionally.
  const [courtId, setCourtId] = useState(fixture.court_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P9 review wave 3 ("Also yours"): archived-INCLUSIVE on purpose, unlike
  // `courtGroups(venues)` (used below for the SELECTABLE option list, which
  // must stay archived-filtered — you cannot newly pick an archived court).
  // This map's only job is resolving `courtId`'s venue_id for the save below,
  // and `courtId` can legitimately be an already-archived court's id (this
  // fixture was scheduled onto it before it was archived) — `courtGroups`
  // dropping that row silently cleared `venue_id` on every such save, even
  // though `court_id` itself was preserved.
  const courtById = new Map(venues.flatMap((venue) => venue.courts).map((c) => [c.id, c] as const));

  const home = fixture.home_entrant_id
    ? (entrantNames[fixture.home_entrant_id] ?? "?")
    : resolveSlotLabel(fixture.home_slot_label ?? null, msg, "schedule.tbd");
  const away = fixture.away_entrant_id
    ? (entrantNames[fixture.away_entrant_id] ?? "?")
    : resolveSlotLabel(fixture.away_slot_label ?? null, msg, "schedule.tbd");
  const decided = outcomeText(msg, fixture.outcome, entrantNames);

  // Bye ghost row (item 6): structural, not schedulable, no actions.
  if (isBye(fixture)) {
    const who = fixture.home_entrant_id ?? fixture.away_entrant_id;
    return (
      <li className="px-4 py-2 text-sm text-slate-500 italic">
        R{fixture.round_no} · {msg("schedule.bye", { name: entrantNames[who ?? ""] ?? "?" })}
      </li>
    );
  }

  // Typed by INFERRING from PatchFixture (server/api-v1/schemas.ts) — never
  // hand-declared. `apiV1<T>`'s `json` param is `unknown`, so a hand-rolled
  // wire type here is exactly how the court_label/venue 400 survived 175
  // commits: nothing caught a payload shape the schema no longer accepts.
  async function patchSchedule(json: PatchFixture) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}`, { method: "PATCH", json });
      setEditing(false);
      router.refresh();
      onRescheduled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  const saveSchedule = () =>
    patchSchedule({
      scheduled_at: when ? new Date(when).toISOString() : null,
      // A court now implies its venue, and the SERVER derives it: `moveFixture`
      // (schedule.ts) resolves `venue_id` from `courts.venue_id` and ignores
      // any `venue_id` a client sends, so the two can no longer disagree.
      // Still sent from the same selection so the optimistic local row matches
      // what the server will write.
      court_id: courtId || null,
      venue_id: (courtId ? courtById.get(courtId)?.venue_id : undefined) ?? null,
    });

  const unschedule = () => {
    setWhen("");
    void patchSchedule({ scheduled_at: null });
  };

  // Play state only matters once a match is under way / done; before that a
  // plain "scheduled" DB status is noise next to the timetable chip.
  const played = ["in_play", "decided", "finalized", "cancelled"].includes(fixture.status);
  const timed = !!fixture.scheduled_at;

  const voided = VOID_STATUSES.has(fixture.status);

  return (
    <li className="px-4 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <Link
          href={href}
          className={`min-w-0 sm:flex-1 text-sm hover:text-purple-700 ${
            voided ? "text-slate-500 line-through" : "text-slate-800"
          }`}
        >
          <span className="font-medium">{home}</span>
          <span className="mx-1.5 text-slate-400">{msg("schedule.vs")}</span>
          <span className="font-medium">{away}</span>
          {decided && !voided && <span className="ml-2 text-xs text-slate-500 no-underline">{decided}</span>}
        </Link>
        {/* Badges/buttons cluster — own line on mobile so it never collides
            with the team names above it (fix-ui audit 03-console-division.md). */}
        <div className="flex flex-wrap items-center gap-2 sm:contents">
          {/* Timetable chip — reflects whether the match has a kick-off time. */}
          <span
            className={`badge ${timed ? "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200" : "bg-slate-100 text-slate-500"}`}
            title={timed ? msg("schedule.chip.timedTitle") : msg("schedule.chip.untimedTitle")}
          >
            {timed ? (
              <>
                {msg("schedule.chip.scheduled")} · <ClientTime value={fixture.scheduled_at} mode="datetime" tz={tz} showZone />
              </>
            ) : (
              msg("schedule.chip.unscheduled")
            )}
            {/* P9 pass 4d: resolved NAME first (venue-qualified when
                ambiguous via courtNames), the frozen label next, then the
                ultimate bare-venue-text fallback for a fixture older than
                either cutover — never a raw court_id. */}
            {(() => {
              const text = courtDisplayName(fixture, courtNames) ?? fixture.venue;
              return text ? ` · ${text}` : "";
            })()}
          </span>
          {/* Play state only once it's under way / done. */}
          {played && (
            <span className={`badge ${FIXTURE_STATUS_STYLE[fixture.status] ?? ""}`}>
              {fixtureStatusLabel(msg, fixture.status)}
            </span>
          )}
          {/* Scoring pad. */}
          <Link href={href} className="btn btn-ghost px-3 py-1 text-xs">
            {decided ? msg("schedule.view") : fixture.status === "in_play" ? msg("schedule.scoreLive") : msg("schedule.score")}
          </Link>
          {/* Timetable controls only while the match is still movable — once
              it's in play or decided the server refuses moves anyway, so the
              buttons would just be a dead end. */}
          {canEdit && fixture.status === "scheduled" && (
            <button
              type="button"
              data-testid="fixture-schedule-toggle"
              onClick={() => setEditing(!editing)}
              className="btn btn-ghost px-3 py-1 text-xs"
            >
              {editing ? msg("schedule.close") : timed ? msg("schedule.editTime") : msg("schedule.schedule")}
            </button>
          )}
          {canEdit && fixture.status === "scheduled" && timed && !editing && (
            <button
              type="button"
              disabled={busy}
              onClick={unschedule}
              className="text-xs text-slate-500 hover:text-red-600 hover:underline"
            >
              {msg("schedule.unschedule")}
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <DateTimeField
            kind="datetime-local"
            label={msg("schedule.field.when")}
            value={when}
            onChange={setWhen}
            options={boardSlotOptions}
          />
          {/* P9 pass 4d, item 1: real court selection, grouped by venue —
              replaces the free-text venue/court inputs, which PATCHed the now-
              retired `venue`/`court_label` keys and 400'd against
              PatchFixture's `.strict()` schema. Built from the SAME
              `courtGroups` piece CourtMultiPicker uses (court-multi-picker.tsx)
              rather than a second court-picker implementation — a plain
              single-select `<optgroup>`-per-venue here, since one fixture ever
              has exactly one court (CourtMultiPicker's multi-select/reorder
              machinery has nothing to do). Offers every ACTIVE org court, not
              just the division's configured subset — a manual per-fixture
              override is not the auto-scheduler, and `courtGroups` already
              excludes archived venues/courts. Venue-qualifying the OPTION text
              itself is unnecessary here (unlike a flat list — MovePanel's
              dropdown, the board's column headers): each `<optgroup>` already
              names its venue, so two courts sharing a name never collide
              within the picker's own grouping. */}
          <label className="block">
            <span className="label">{msg("schedule.field.court")}</span>
            <select
              data-testid="fixture-court-select"
              value={courtId}
              onChange={(e) => setCourtId(e.target.value)}
              // `.input`'s own padding loses to `px-2 py-1 text-xs` under
              // Tailwind's utilities layer (S13/#422 W11). `min-h-11` survives it.
              className="input min-h-11 w-48 px-2 py-1 text-xs"
            >
              <option value="">{msg("board.unassigned")}</option>
              {courtGroups(venues).map(({ venue, courts }) => (
                <optgroup key={venue.id} label={venue.name}>
                  {courts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="fixture-save-schedule"
            disabled={busy}
            onClick={saveSchedule}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {busy ? msg("schedule.saving") : msg("schedule.save")}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      )}
    </li>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// PROMPT-66 — inline ad-hoc match form. Two entrant selects + an optional
// datetime; POSTs /stages/{id}/fixtures and refreshes. The server enforces the
// stage-kind policy; this form only shows on league/group/swiss stages.
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

  useEffect(() => {
    if (!open || loaded) return;
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
  }, [open, loaded, stageId, msg]);

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

  return (
    <div className="border-t border-slate-100 px-4 py-3" data-testid="stage-court-tags">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-baseline gap-2 text-left text-xs font-semibold text-slate-700"
      >
        <span>{msg("stagetags.title")}</span>
        {loaded && <span className="min-w-0 truncate font-normal text-slate-500">{summary}</span>}
      </button>

      {open && (
        // Everything stacks by default and only spreads out from `sm:` up —
        // the panel's own narrow-width idiom (FixtureLine, line ~1589). At
        // 320px nothing sits side by side, so nothing forces a page scroll.
        <div className="mt-3 flex flex-col gap-3">
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
                  className="btn btn-primary min-h-11 w-full px-3 py-1.5 text-xs sm:w-auto sm:self-start"
                >
                  {saving ? msg("schedule.working") : msg("stagetags.save")}
                </button>
              )}
            </>
          )}
          {notice !== null && <p className="text-xs text-green-700">{notice}</p>}
          {error !== null && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
