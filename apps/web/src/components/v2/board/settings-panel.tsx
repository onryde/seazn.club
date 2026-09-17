"use client";

// Scheduling settings (doc 12 §3) — extracted from the board monolith in the
// v3 split. Play hours expose the engine's sessionWindows as plain daily
// times: the auto pass and validator already refuse slots outside them, the
// panel just never offered the knob.
//
// EVERY ABSOLUTE TIME HERE IS ON THE VENUE CLOCK (`orgTz`, #448), never the
// browser's. `startAt`, the end DATE and the play-hours expansion are all read
// out of and written back into instants through `@/lib/zoned-datetime`, which
// takes the zone explicitly. It used to be `new Date(localInput)` /
// `toLocalInput(iso)`, i.e. the organiser's own zone — self-consistent on
// screen, so the mistake was invisible, and off by the whole offset in the
// instant the solver actually reads.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RestFloorNote, restFloorNoteShown } from "@/components/v2/rest-floor-note";
import { apiV1 } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { dailyHoursToWindows, windowsToDailyHours } from "@/lib/schedule-board";
import { divisionEndBounds, divisionStartBounds, type CompetitionWindow } from "@/lib/date-order";
import {
  isoFromZonedDateTime,
  isoFromZonedParts,
  zonedDateInput,
  zonedDateTimeInput,
} from "@/lib/zoned-datetime";
import type { BoardConfig } from "./types";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { Tip } from "@/components/ui/tip";
import { useMsg, useLocale } from "@/components/i18n/dict-provider";
import { settingsErrorText } from "@/lib/schedule-error";
import { pluralizeVenue } from "@/lib/venue";
// P9 scope item 5: the court multi-picker replaces the free-text court list
// below. `venues` is fetched server-side (`listVenues`) and threaded down —
// see the component's own header for why it isn't fetched client-side here.
import { CourtMultiPicker, flattenCourts } from "@/components/v2/shared/court-multi-picker";
// P9: BOARD-side Venue — no calendar (see court-multi-picker.tsx).
import type { Venue } from "@/components/v2/shared/court-multi-picker";
// D2 capacity pre-check (design doc bench-product-value/designs/2026-08-13-
// capacity-precheck-design.md): CLIENT-SAFE leaf — see capacity-input.ts's
// header for why this file must never reach `@seazn/engine/scheduling`
// (the barrel) or `capacity-guard.ts` (server-only). P10 §4/Task 6: the
// report itself no longer comes from a local `capacityInputForFixtures` +
// `assessCapacity` call — see useCapacityReport's own header for why —
// this file only builds the WIRE BODY the hook sends, which still needs
// `dayKeyInTz`/`ymdAddDays`/`zonedTimeToUtc` for the window math.
import { dayKeyInTz, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling/tz";
import type { CapacityFixtureInput } from "@/lib/capacity-input";
import { useCapacityReport, type CapacityReportConfig } from "@/lib/use-capacity-report";
import { CapacityCard } from "@/components/v2/board/capacity-card";

/** The end DATE field bounds a whole day, so it is stored as that day's last
 *  minute. One definition, used by the PUT and by the play-hours expansion. */
const DAY_END_HHMM = "23:59";

/**
 * Review fix (finding 4): `gapMinutes`/`rest` fed their onChange handlers a
 * bare `Number(e.target.value)`, unlike `matchMinutes`' own `|| 30` guard —
 * harmless while this only fed a local computation, not harmless now it is a
 * wire body (`capacityRequestFromDraft` below, sent by `useCapacityReport`
 * every keystroke). Typing `-` yields NaN (serialises to `null`); `1.5`
 * yields a non-integer — both rejected by CapacityPrecheckInput's
 * `z.number().int().min(0)` (capacity-guard.ts) -> 400 -> one retry ->
 * `failed: true`, so the card sticks on "check failed" until the organiser
 * edits something else. Applied at the SAME point matchMinutes' guard
 * already lives (the onChange handler) so the STATE itself is always valid,
 * not just one downstream call site — the PUT save body benefits too.
 * Floors to 0 (both fields' own `min={0}`), matching `Number("")`'s own
 * existing 0 coercion for an emptied field.
 */
export function sanitizeNonNegativeInt(raw: string): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * D2 capacity pre-check (P10 §4/Task 6): this panel's own live draft state
 * (startAt/endAt/matchMinutes/gapMinutes/rest/courts — NEVER `config.*` for
 * those four numeric knobs, the same "live, not last-saved" reasoning the
 * removed useMemo carried) -> the wire body `useCapacityReport` sends.
 * `sessionWindows`/`blackouts`/`constraints` come off `config` UNCHANGED
 * (last-saved): this panel's play-hours fields only expand into
 * `sessionWindows` on Save, and live-previewing that expansion is out of
 * scope here — same split the removed useMemo documented.
 *
 * Pure and exported so it is unit-testable without a fetch/effect-capable
 * render: renderToStaticMarkup (this repo's client-component convention)
 * never fires an effect, so a report computed behind useCapacityReport
 * cannot be observed that way any more — this is what
 * settings-panel-capacity.test.tsx asserts against instead now.
 *
 * An empty `courts` selection falls back to every non-archived org court
 * (`flattenCourts(venues)`), mirroring `resolveCandidateCourts`'
 * server-side "empty configuredCourtIds means UNCONSTRAINED" rule — feeding
 * the raw (possibly empty) draft selection straight through would
 * under-report supply relative to what Save will actually schedule
 * against.
 */
export function capacityRequestFromDraft(
  fixtures: readonly {
    id: string;
    status: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    pool_id: string | null;
  }[],
  draft: {
    startAt: string;
    endAt: string;
    matchMinutes: number;
    gapMinutes: number;
    rest: number;
    courts: string[];
  },
  config: BoardConfig,
  orgTz: string,
  venues: Venue[],
): { fixtures: CapacityFixtureInput[]; config: CapacityReportConfig } {
  const startIso =
    draft.startAt === "" ? null : (isoFromZonedDateTime(draft.startAt, orgTz) ?? config.startAt ?? null);
  const endIso =
    draft.endAt === "" ? null : (isoFromZonedParts(draft.endAt, DAY_END_HHMM, orgTz) ?? config.endAt ?? null);
  const window =
    startIso === null && endIso === null
      ? undefined
      : {
          from: startIso ? zonedTimeToUtc(dayKeyInTz(Date.parse(startIso), orgTz), "00:00", orgTz) : -Infinity,
          to: endIso ? zonedTimeToUtc(ymdAddDays(dayKeyInTz(Date.parse(endIso), orgTz), 1), "00:00", orgTz) : Infinity,
        };
  const movable = fixtures.filter((f) => f.status === "scheduled"); // MOVABLE_STATUS (schedule.ts) — a client component can't import it (server-only)
  const effectiveCourts = draft.courts.length > 0 ? draft.courts : flattenCourts(venues).map((c) => c.id);
  return {
    // `id` lets an `id`-kind fixture_on_date/fixture_on_weekday selector
    // resolve into a forcedDemand floor server-side too. `extKey`/`winnerTo`
    // are NOT available here — the page's fetched fixture list never
    // carries `ext_key`/`winner_to_fixture`, and neither is in the public
    // API schema — so a `terminal`/`ext_key` selector cannot resolve and
    // stays undercounted on this card. Same "client hint, server
    // authority" split as demandCap.
    fixtures: movable.map((f) => ({
      home: f.home_entrant_id ?? undefined,
      away: f.away_entrant_id ?? undefined,
      poolId: f.pool_id ?? undefined,
      id: f.id,
    })),
    config: {
      courts: effectiveCourts,
      sessionWindows: config.sessionWindows.map((w) => ({ from: Date.parse(w.from), to: Date.parse(w.to) })),
      blackouts: config.blackouts.map((b) => ({
        ...(b.court !== undefined ? { court: b.court } : {}),
        from: Date.parse(b.from),
        to: Date.parse(b.to),
      })),
      matchMinutes: draft.matchMinutes,
      gapMinutes: draft.gapMinutes,
      perEntrantMinRest: draft.rest,
      window,
      ...(config.constraints !== undefined ? { constraints: config.constraints } : {}),
    },
  };
}

/** Self-contained wrapper for RSC pages (constraints tab): owns the saved/
 *  error notice the board would otherwise host. Opens expanded — on a
 *  settings tab a collapsed one-liner would just be a second click. */
export function StandaloneScheduleSettings(props: {
  divisionId: string;
  config: BoardConfig;
  canEdit: boolean;
  constraintsAllowed: boolean;
  venueCap?: string;
  /** Org venues with nested courts, for the court multi-picker (P9 scope
   *  item 5) — see {@link SettingsPanel}. Optional/defaulted so no other
   *  caller of this wrapper breaks; omitted, the picker shows the
   *  Directory pointer exactly as it would for a courtless org. */
  venues?: Venue[];
  /** The VENUE clock (`settings.orgTz`, #448). See {@link SettingsPanel}. */
  orgTz: string;
  /** The parent competition's own dates. See {@link SettingsPanel}. */
  competitionWindow?: CompetitionWindow;
  /** D2 capacity pre-check: the division's own fixtures, EVERY status — this
   *  panel filters to movable itself (see {@link SettingsPanel}'s doc
   *  comment). Optional so no OTHER caller of this wrapper breaks; omitted,
   *  the capacity card simply never renders (report is always null with
   *  zero fixtures). Structural, matching `FixtureRow` (stages.ts), so the
   *  page's already-fetched list passes straight through with no mapping. */
  fixtures?: readonly {
    id: string;
    status: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    pool_id: string | null;
  }[];
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const locale = useLocale();
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <SettingsPanel
        {...props}
        defaultOpen
        // Courts moved to their own tab next to Constraints (`CourtsPanel`) —
        // this card would otherwise show the same picker twice.
        showCourts={false}
        onSaved={() => {
          setError(null);
          setNotice(msg("boardset.saved"));
          router.refresh();
        }}
        onError={(err) => {
          setNotice(null);
          // Same resolver the board uses, so the settings TAB and the board's
          // inline settings card cannot disagree about how a refusal reads —
          // they are the same save against the same endpoint.
          setError(settingsErrorText(err, locale, msg("boardset.error")));
        }}
      />
    </div>
  );
}

/** Localized tab label for the Courts tab, same pattern as
 *  `HealthTabLabel` (health-panel.tsx) — a tiny client leaf so the page
 *  component (no request scope in its own test harness) never has to
 *  resolve a locale itself just to label one tab. */
export function CourtsTabLabel() {
  const msg = useMsg();
  return <>{msg("schedule.courts.tabLabel")}</>;
}

/**
 * The court picker, on its own tab next to Constraints — split out of
 * {@link SettingsPanel} so picking which courts a division's auto-scheduler
 * may use is not buried inside the hours/match-length settings card. Saves
 * against the SAME `schedule-settings` PUT the rest of that panel uses,
 * spreading `config` through unchanged and overriding only `courts` — the
 * two tabs can never disagree about any other field because neither of them
 * ever sends one it doesn't own.
 */
export function CourtsPanel({
  divisionId,
  config,
  canEdit,
  venueCap = "Court",
  venues = [],
  onSaved,
  onError,
}: {
  divisionId: string;
  config: BoardConfig;
  canEdit: boolean;
  venueCap?: string;
  venues?: Venue[];
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const msg = useMsg();
  const [courts, setCourts] = useState<string[]>([...config.courts]);
  const [saving, setSaving] = useState(false);
  // Singular, lowercase — `removeVenue` ("Remove {venue} {n}") reads it as
  // one court's own name.
  const venue = venueCap.toLowerCase();
  // Plural, CAPITALISED — `venuesLabel` is a heading ("{venue}" alone, e.g.
  // "Pitches"). `venueCap` alone is singular ("Court", "Pitch"), and naively
  // suffixing "s" in the old template broke on "Pitch" -> "Pitchs" instead of
  // "Pitches" (`pluralizeVenue` handles that).
  const venuePluralCap = pluralizeVenue(venueCap);
  // Plural, lowercase — `venuesDesc` reads `{venue}` mid-sentence ("Pick the
  // {venue} this schedule can use…").
  const venuePlural = venuePluralCap.toLowerCase();

  async function save() {
    setSaving(true);
    try {
      // No `tz` key (V305, see SettingsPanel's own save): an absent tz leaves
      // the stored value alone.
      await apiV1(`/api/v1/divisions/${divisionId}/schedule-settings`, {
        method: "PUT",
        json: { config: { ...config, courts } },
      });
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-6 p-5">
      {/* No separate heading here — `CourtMultiPicker` already renders
          `label`/`description` itself (court-multi-picker.tsx:290-291); a
          second copy above it duplicated the same two lines on screen. */}
      <div className="sm:max-w-[calc(50%-0.5rem)]">
        <CourtMultiPicker
          venues={venues}
          value={courts}
          onChange={setCourts}
          disabled={!canEdit}
          label={msg("boardset.venuesLabel", { venue: venuePluralCap })}
          description={msg("boardset.venuesDesc", { venue: venuePlural })}
          emptyTitle={msg("courtPicker.emptyTitle")}
          emptyBody={msg("courtPicker.emptyBody")}
          directoryLinkLabel={msg("courtPicker.directoryLink")}
          selectedLabel={msg("courtPicker.selected", { n: courts.length })}
          noneSelectedLabel={msg("courtPicker.noneSelected")}
          unknownCourtLabel={msg("courtPicker.unknownCourt")}
          moveUpLabel={msg("venues.court.moveUp")}
          moveDownLabel={msg("venues.court.moveDown")}
          removeLabelFor={(n) => msg("boardset.removeVenue", { venue, n })}
        />
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={saving} onClick={save} className="btn btn-primary">
            {saving ? msg("boardset.saving") : msg("boardset.save")}
          </button>
        </div>
      )}
    </section>
  );
}

/** Self-contained wrapper for RSC pages (courts tab): owns the saved/error
 *  notice the board would otherwise host, same pattern as
 *  {@link StandaloneScheduleSettings}. */
export function StandaloneCourtsSettings(props: {
  divisionId: string;
  config: BoardConfig;
  canEdit: boolean;
  venueCap?: string;
  venues?: Venue[];
}) {
  const msg = useMsg();
  const locale = useLocale();
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <CourtsPanel
        {...props}
        onSaved={() => {
          setError(null);
          setNotice(msg("boardset.saved"));
          router.refresh();
        }}
        onError={(err) => {
          setNotice(null);
          setError(settingsErrorText(err, locale, msg("boardset.error")));
        }}
      />
    </div>
  );
}

export function SettingsPanel({
  divisionId,
  config,
  canEdit,
  constraintsAllowed,
  venueCap = "Court",
  venues = [],
  orgTz,
  competitionWindow,
  defaultOpen = false,
  showCourts = true,
  onSaved,
  onError,
  fixtures = [],
  viewerPlan,
}: {
  divisionId: string;
  config: BoardConfig;
  canEdit: boolean;
  constraintsAllowed: boolean;
  venueCap?: string;
  /** Org venues with nested courts (`listVenues` shape, venues.ts) — feeds
   *  the court multi-picker (P9 scope item 5) below. Defaulted to `[]`
   *  rather than required: several existing test call sites construct this
   *  panel without it, and an empty list degrades to the picker's own
   *  "no courts yet" Directory pointer rather than a crash. */
  venues?: Venue[];
  /** False on the division schedule page, whose `StandaloneScheduleSettings`
   *  passes it through as `false` — courts moved to their own tab there
   *  (`CourtsPanel`), so this card would otherwise show the same picker
   *  twice. Defaults true: every other caller (the competition board's
   *  inline mount, existing tests) is unaffected. */
  showCourts?: boolean;
  fixtures?: readonly {
    id: string;
    status: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    pool_id: string | null;
  }[];
  /** The VENUE clock every absolute time on this panel is read and written on
   *  (`settings.orgTz`, #448 — NOT `settings.tz`, the display lane a division
   *  may override). Required rather than defaulted: a wrong zone here stores the
   *  wrong instant and looks correct on the way back out. */
  orgTz: string;
  /** The parent COMPETITION's own `starts_on`/`ends_on`. The server refuses a
   *  division whose schedule range leaves this window (schedule.ts CONTAINMENT
   *  GUARD → 422), so both date fields carry it as `min`/`max` and an unset
   *  start seeds its date half from the competition's opening day. Optional:
   *  omitted, the fields are unbounded exactly as before and the server stays
   *  the authority — the same "client hint, server authority" split the
   *  capacity precheck on this panel already follows. */
  competitionWindow?: CompetitionWindow;
  defaultOpen?: boolean;
  onSaved: () => void;
  onError: (err: unknown) => void;
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(defaultOpen);
  const [startAt, setStartAt] = useState(
    config.startAt
      ? zonedDateTimeInput(config.startAt, orgTz)
      : // No stored start: seed the DATE half from the competition's opening
        // day and leave the time blank. A bare `YYYY-MM-DD` is exactly what
        // `splitValue` reads as "date set, time unset", and
        // `isoFromZonedDateTime` returns null for it — so this pre-fills the
        // calendar without inventing a time-of-day, and a save before the
        // organiser picks one still writes the same `null` it writes today.
        (competitionWindow?.startsOn ?? ""),
  );
  const [endAt, setEndAt] = useState(config.endAt ? zonedDateInput(config.endAt, orgTz) : "");
  const [matchMinutes, setMatchMinutes] = useState(config.matchMinutes);
  const [gapMinutes, setGapMinutes] = useState(config.gapMinutes);
  const [rest, setRest] = useState(config.perEntrantMinRest);
  // Courts: real `courts.id` uuids picked from the org's own court list (P9
  // scope item 5). On the division schedule page these move to their own tab
  // (`CourtsPanel`/`showCourts={false}`, passed by `StandaloneScheduleSettings`)
  // — this stays live on any OTHER caller (the competition board's inline
  // mount, division-builder wizard) that still wants courts on this same card.
  const [courts, setCourts] = useState<string[]>([...config.courts]);
  const [saving, setSaving] = useState(false);
  const [hoursError, setHoursError] = useState<string | null>(null);
  // Prefill only when the stored windows are a uniform daily pattern —
  // hand-built windows show as "custom" and stay put. Nothing in the app writes
  // a non-uniform set (this panel is the only writer, and it always expands one
  // daily pattern), so that state arrives through the API. `boardset
  // .customWindows` used to send organisers to the constraints panel to edit
  // them; that panel has never had a session-window editor, so the copy now
  // states the situation instead of pointing at a dead end.
  const daily = windowsToDailyHours(config.sessionWindows, orgTz);
  const customWindows = config.sessionWindows.length > 0 && daily === null;
  const [playFrom, setPlayFrom] = useState(daily?.from ?? "");
  const [playTo, setPlayTo] = useState(daily?.to ?? "");

  // LIVE state for the three numbers, not `config.*` — the rest-floor note has
  // to move as the organiser types or it explains the value they just replaced.
  // `constraints` comes off `config` unchanged: this panel never edits it.
  const restNoteConfig = {
    perEntrantMinRest: rest,
    matchMinutes,
    gapMinutes,
    ...(config.constraints !== undefined ? { constraints: config.constraints } : {}),
  };

  // D2 capacity pre-check (P10 §4/Task 6): the report itself now comes from
  // the server — see useCapacityReport's own header for why a client
  // computation could only ever overstate supply. This panel's job is only
  // to build the wire body from its own LIVE draft state
  // (capacityRequestFromDraft, above) and hand it to the hook; the hook
  // debounces, aborts a superseded request, and holds the previous report
  // (marked stale) while a newer one is pending.
  // When this panel doesn't show the court picker (`showCourts={false}`,
  // division schedule page), preview capacity against the last SAVED court
  // selection instead of a live draft — there is no picker here to draft
  // against, and the Courts tab has its own save.
  const capacityRequest = capacityRequestFromDraft(
    fixtures,
    { startAt, endAt, matchMinutes, gapMinutes, rest, courts: showCourts ? courts : config.courts },
    config,
    orgTz,
    venues,
  );
  const {
    report: capacityReport,
    stale: capacityStale,
    // Review fix (Finding 1): threaded through to CapacityCard below so a
    // real fetch failure (distinct from a superseded abort) actually
    // surfaces here instead of silently defaulting to `false` — see
    // useCapacityReport's and CapacityCard's own `failed` doc comments.
    failed: capacityFailed,
  } = useCapacityReport(divisionId, capacityRequest.fixtures, capacityRequest.config);

  // "Add a court" can only offer a REAL, currently-unselected org court now
  // (no more fabricating "Court N" out of thin air) — the next one in the
  // org's own venue/sort order that isn't already in `courts`. `undefined`
  // when every real court is already selected, the org has none, or this
  // panel doesn't show courts at all (`showCourts={false}`): the suggestion
  // itself still renders (CapacityCard), just without an Apply button, which
  // reads better than a button that silently does nothing or edits a picker
  // that isn't on screen.
  const nextAddableCourt = showCourts
    ? flattenCourts(venues).find((c) => !courts.includes(c.id))?.id
    : undefined;
  const applyCapacitySuggestion = {
    add_day: () => setEndAt((e) => (e === "" ? e : ymdAddDays(e, 1))),
    ...(nextAddableCourt !== undefined
      ? {
          // Review wave 2: the next court is chosen INSIDE the updater from
          // `cs`, not from the render-time `nextAddableCourt` the closure
          // captured. Two clicks before a re-render both appended the same id,
          // so `config.courts` held a duplicate — deduped later by
          // `candidateCourts`, but double-counted by this panel's own capacity
          // supply figure in between, which is the number the organiser is
          // looking at when they click.
          add_court: () =>
            setCourts((cs) => {
              if (cs.length >= 50) return cs;
              const next = flattenCourts(venues).find((c) => !cs.includes(c.id))?.id;
              return next === undefined ? cs : [...cs, next];
            }),
        }
      : {}),
    shorten_match: (s: { amount: number }) => setMatchMinutes((m) => Math.max(1, m - s.amount)),
    shrink_gap: (s: { amount: number }) => setGapMinutes((g) => Math.max(0, g - s.amount)),
    // No `raise_cap`: that knob is a durable division rule on the
    // Constraints tab, not local draft state on this panel (see
    // CapacityCard's onApply doc comment).
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-purple-600 hover:underline">
        {msg("boardset.title")} ({config.courts.length} {venueCap.toLowerCase()}{config.courts.length === 1 ? "" : "s"}, {msg("boardset.sum.matches", { n: config.matchMinutes })}
        {config.gapMinutes > 0 ? msg("boardset.sum.gap", { n: config.gapMinutes }) : ""}
        {config.perEntrantMinRest > 0 ? msg("boardset.sum.rest", { n: config.perEntrantMinRest }) : ""}
        {daily ? msg("boardset.sum.play", { from: daily.from, to: daily.to }) : customWindows ? msg("boardset.sum.custom") : ""})
      </button>
    );
  }

  async function save() {
    setHoursError(null);
    // Resolved ONCE, on the venue clock, and reused by both the play-hours
    // expansion and the PUT below. Converting the same field twice is how the
    // window the solver is given and the window the organiser sees drift apart.
    //
    // A non-empty field that will not parse falls back to the STORED instant
    // rather than to null: `<input type="datetime-local">` cannot emit such a
    // value, and if one ever arrived, silently clearing the schedule's start is
    // the worst of the available outcomes.
    const startIso =
      startAt === "" ? null : (isoFromZonedDateTime(startAt, orgTz) ?? config.startAt ?? null);
    // The end DATE bounds a day, so it stores that day's last minute AT THE
    // VENUE — 23:59 on the organiser's clock is a different instant, and on a
    // far-enough zone a different day.
    const endIso =
      endAt === "" ? null : (isoFromZonedParts(endAt, DAY_END_HHMM, orgTz) ?? config.endAt ?? null);
    // A range that runs backwards is refused HERE, before anything is sent.
    //
    // The `min=` on the end-date input is advisory only: this panel saves from a
    // click handler, not a form submit, so nothing enforces it. Left unchecked
    // the reversed pair persists happily and the damage is invisible —
    // `applyWindow` turns it into `SlotConfig.window`, and `calendar.ts` places
    // a fixture only when `startAt >= w.from && endAt <= w.to`, which NOTHING
    // satisfies when `from > to`. The organiser gets an empty board and no
    // error. (`PutScheduleSettings` now refuses it server-side too; this exists
    // so the message lands in the panel instead of arriving as a raw 422.)
    //
    // Compared as instants, never as strings: both sides are built by
    // `isoFromZonedParts` on the venue clock, and comparing the raw `YYYY-MM-DD`
    // text of two fields that carry different times of day is how this check
    // would quietly stop working.
    if (startIso !== null && endIso !== null && Date.parse(endIso) < Date.parse(startIso)) {
      setHoursError(msg("boardset.datesError"));
      return;
    }
    // Play hours → session windows. Both set: expand across the schedule
    // span. Both blank: clear a previously-uniform pattern (all hours play),
    // but never clobber hand-built windows. Half-filled or inverted: refuse.
    let sessionWindows = config.sessionWindows;
    const hoursTouched = playFrom !== "" || playTo !== "";
    if (hoursTouched) {
      const expandFrom = startIso ?? config.startAt ?? new Date().toISOString();
      const expanded = dailyHoursToWindows(playFrom, playTo, expandFrom, endIso, orgTz);
      if (!expanded) {
        setHoursError(msg("boardset.hoursError"));
        return;
      }
      sessionWindows = expanded;
    } else if (!customWindows) {
      sessionWindows = [];
    }
    setSaving(true);
    try {
      // No `tz` key (V305): the venue timezone is an ORGANISATION setting now
      // and is inherited. Omitting it is load-bearing — the PUT treats an
      // absent tz as "leave the stored value alone", so divisions that already
      // carry their own zone keep it instead of being silently reset.
      await apiV1(`/api/v1/divisions/${divisionId}/schedule-settings`, {
        method: "PUT",
        json: {
          config: {
            ...config,
            startAt: startIso,
            endAt: endIso,
            matchMinutes,
            gapMinutes,
            perEntrantMinRest: rest,
            // `showCourts=false` (division schedule page): courts are edited
            // on their own tab now, and `...config` above already carries the
            // last-saved value through unchanged — nothing to override here.
            ...(showCourts ? { courts } : {}),
            sessionWindows,
          },
        },
      });
      // Board's inline card collapses back to its one-liner; the settings
      // TAB stays open — saving is not leaving (organiser feedback).
      if (!defaultOpen) setOpen(false);
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  }

  const constrained = !constraintsAllowed;
  const venue = venueCap.toLowerCase();
  // See CourtsPanel's own doc comments on these two — `venuesLabel` is a
  // heading (capitalised), `venuesDesc` reads mid-sentence (lowercase).
  const venuePluralCap = pluralizeVenue(venueCap);
  const venuePlural = venuePluralCap.toLowerCase();
  // Field markup mirrors the division-creation wizard — one input system
  // everywhere (default-size .input, wizard hint lines, courts as a list).
  return (
    <section className="card space-y-6 p-5">
      <div>
        <h4 className="text-sm font-semibold text-slate-700">{msg("boardset.title")}</h4>
        <p className="mt-0.5 text-xs text-slate-500">{msg("boardset.desc")}</p>
        {/* Start, end and play hours are all read and written on the VENUE
            clock, so the panel says which one that is. An organiser running an
            event in another zone otherwise has no way to know whether "09:00"
            means theirs or the venue's. Reuses the caption the stages panel
            already shows over fixture times — already translated everywhere. */}
        <p className="mt-0.5 text-xs text-slate-400">{msg("schedule.tz.caption", { tz: orgTz })}</p>
      </div>

      <CapacityCard
        report={capacityReport}
        stale={capacityStale}
        failed={capacityFailed}
        onApply={applyCapacitySuggestion}
        venueLabel={venue}
      />

      {constrained && <UpgradeGate feature="scheduling.constraints" compact viewerPlan={viewerPlan} />}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* DateTimeField owns the whole <label>, so each hint moves from inside
            it to a sibling <div> — a hint inside a <label> joins the control's
            accessible name anyway. The <div> becomes the grid item that
            `label.block` was, and measures identical at 1280 and 375. */}
        <div>
          <DateTimeField
            kind="datetime-local"
            label={msg("boardset.startAt")}
            value={startAt}
            {...divisionStartBounds(competitionWindow)}
            onChange={setStartAt}
            disabled={!canEdit}
          />
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.startAtHint")}</span>
        </div>
        <div>
          <DateTimeField
            kind="date"
            label={msg("boardset.endAt")}
            value={endAt}
            // Was `min={startAt.slice(0, 10)}` — the same own-start floor, now
            // taking the LATER of that and the competition's opening day, plus
            // the competition's closing day as a ceiling. `divisionEndBounds`
            // slices the start with `startDay`, so the floor is still one
            // expression shared with `endDateIsBackwards`.
            {...divisionEndBounds(competitionWindow, startAt)}
            onChange={setEndAt}
            disabled={!canEdit}
          />
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.endAtHint")}</span>
        </div>
        <fieldset className="block">
          <legend className="label">{msg("boardset.playHours")}</legend>
          {customWindows ? (
            <p className="text-xs text-slate-500">{msg("boardset.customWindows")}</p>
          ) : (
            // `labelHidden`: the legend above already says "Play hours", so a
            // second visible line per input is duplication — and the extra
            // `.label` row pushed this cell 20px taller than the match-length
            // field sharing its grid row. The label element still renders and
            // still wraps the control, which is what names it; that is strictly
            // more than the bare `aria-label` these two carried before.
            // `min-w-0 flex-1` keeps the halves equal-width the way the bare
            // `w-full` inputs were before they gained a wrapper.
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1" data-testid="settings-day-start">
                <DateTimeField
                  kind="time"
                  label={msg("boardset.playFrom")}
                  labelHidden
                  value={playFrom}
                  onChange={setPlayFrom}
                  disabled={!canEdit}
                />
              </div>
              <span className="text-sm text-slate-500">–</span>
              <div className="min-w-0 flex-1" data-testid="settings-day-end">
                <DateTimeField
                  kind="time"
                  label={msg("boardset.playUntil")}
                  labelHidden
                  value={playTo}
                  onChange={setPlayTo}
                  disabled={!canEdit}
                />
              </div>
            </div>
          )}
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.playHoursHint")}</span>
        </fieldset>
        <label className="block">
          <span className="label">{msg("boardset.matchLength")}</span>
          <input data-testid="settings-match-minutes" type="number" min={1} max={1440} inputMode="numeric" value={matchMinutes} onChange={(e) => setMatchMinutes(Number(e.target.value) || 30)} className="input w-full" disabled={!canEdit} />
        </label>
        <label className="block">
          <span className="label">{msg("boardset.gap")}</span>
          <input data-testid="settings-gap-minutes" type="number" min={0} inputMode="numeric" value={gapMinutes} onChange={(e) => setGapMinutes(sanitizeNonNegativeInt(e.target.value))} className="input w-full" disabled={!canEdit} />
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.gapHint", { venue })}</span>
        </label>
        {/* A <div> with an explicit htmlFor rather than a wrapping <label>:
            `Tip` renders a <button>, and a button inside a <label> forwards its
            click to the control. Same shape the constraints panel's copy of
            this field uses. The other fields in this grid keep their wrapping
            label — only this one hosts a tip. */}
        <div className="block">
          <span className="label flex items-center gap-1">
            {/* Literal ids, not `useId()`: the hand-rolled dispatcher in
                `_hook-harness.tsx` does not implement useId, so it throws
                `resolveDispatcher(...).useId is not a function` and reds five
                unrelated datetime suites. A duplicate is unreachable today —
                the division route forces `showSettings={false}` and the
                competition route mounts one `SettingsPanel`. */}
            <label htmlFor="boardset-rest">{msg("boardset.rest")}</label>
            {/* Same tip id as the Constraints tab's field. Both write a
                DIFFERENT stored value for one idea and the engine resolves
                them with MAX (`effectiveRestMinutes`, #459), so the losing
                field otherwise looks broken — type 10 beside a 30 and nothing
                changes, with nothing on screen saying why. */}
            <Tip id="schedule.min-rest" small />
          </span>
          {/* The hint used to sit INSIDE the wrapping <label>, so it formed part
              of the input's accessible name. Splitting the label out to host the
              tip would have dropped it entirely; `aria-describedby` keeps it, and
              as a description rather than a name — which is what it always was. */}
          {/* The floor note joins the described set only when it RENDERS —
              `aria-describedby` pointing at an absent id is a dangling
              reference, and an always-rendered empty span is an empty
              description. `restFloorNoteShown` is the component's own
              predicate, so the attribute and the markup cannot disagree. */}
          <input id="boardset-rest" aria-describedby={restFloorNoteShown(restNoteConfig, "perEntrantMinRest") ? "boardset-rest-hint boardset-rest-floor" : "boardset-rest-hint"} type="number" min={0} inputMode="numeric" value={rest} onChange={(e) => setRest(sanitizeNonNegativeInt(e.target.value))} className="input w-full" disabled={!canEdit || constrained} />
          <span id="boardset-rest-hint" className="mt-0.5 block text-xs text-slate-400">
            {msg("boardset.restHint")}{constrained ? msg("boardset.proSuffix") : ""}
          </span>
          {/* Live state, not `config.*`, for `rest`/`matchMinutes`/`gapMinutes`
              — the note has to move as the organiser types or it explains the
              value they just replaced. `constraints` comes off `config`
              unchanged: this panel never edits it. */}
          <RestFloorNote id="boardset-rest-floor" field="perEntrantMinRest" config={restNoteConfig} />
        </div>
      </div>

      {showCourts && (
        <div className="sm:max-w-[calc(50%-0.5rem)]">
          {/* P9 scope item 5: real org courts, multi-selected and ordered —
              replaces the old free-text "Court 1"/"Court 2" name list. */}
          <CourtMultiPicker
            venues={venues}
            value={courts}
            onChange={setCourts}
            disabled={!canEdit}
            label={msg("boardset.venuesLabel", { venue: venuePluralCap })}
            description={msg("boardset.venuesDesc", { venue: venuePlural })}
            emptyTitle={msg("courtPicker.emptyTitle")}
            emptyBody={msg("courtPicker.emptyBody")}
            directoryLinkLabel={msg("courtPicker.directoryLink")}
            selectedLabel={msg("courtPicker.selected", { n: courts.length })}
            noneSelectedLabel={msg("courtPicker.noneSelected")}
            unknownCourtLabel={msg("courtPicker.unknownCourt")}
            moveUpLabel={msg("venues.court.moveUp")}
            moveDownLabel={msg("venues.court.moveDown")}
            removeLabelFor={(n) => msg("boardset.removeVenue", { venue, n })}
          />
        </div>
      )}

      {hoursError && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{hoursError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <button type="button" disabled={saving} onClick={save} className="btn btn-primary">
            {saving ? msg("boardset.saving") : msg("boardset.save")}
          </button>
        )}
        {!defaultOpen && (
          <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost">
            {msg("boardset.close")}
          </button>
        )}
      </div>
    </section>
  );
}
