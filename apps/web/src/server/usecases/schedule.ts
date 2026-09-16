import "server-only";
// Scheduling console use-cases (doc 12, PROMPT-17): schedule-settings PUT,
// the pure auto pass (propose only), transactional apply, single-fixture move,
// full-board validation, publish, and the division start action. The engine
// stays pure — this module converts DB rows ↔ engine inputs (epoch ms) and
// owns every persist.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { requireFeature } from "@/lib/entitlements";
import { cacheDel, cacheDelPattern, sendAfterDeleteOrBound } from "@/lib/cache";
import { rateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { publishDivisionUpdate, publishFixtureUpdate } from "@/lib/realtime";
import { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED, REASON_CODE } from "@/lib/schedule-board";
import { resolveVenueTz } from "@/lib/tz";
import { buildCourtDirectory } from "@/lib/court-directory";
import { log } from "@/server/logger";
import { EngineError } from "@seazn/engine/core";
import {
  boardMetrics,
  buildSchedule,
  calendarDaysCovering,
  conflictKey,
  dayKeyInTz,
  deltaConflicts,
  isBlockingConflict,
  roundOrderConflicts,
  slotFixtures,
  TIER_COUNT,
  validateAssignments,
  validateInstructionRules,
  ymdAddDays,
  zonedTimeToUtc,
  type Assignment,
  type BuildResult,
  type Conflict,
  type ConflictDetail,
  type HardConstraint,
  type CourtCalendar,
  type OrderDependency,
  type RuleFixture,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { appendDivisionEvent } from "@/server/engine-db";
import { legacyConflictDetail } from "@/server/api-v1/conflict-detail-legacy";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  ScheduleConfig,
  type ApplyScheduleRequest,
  type AutoScheduleRequest,
  type PublishScheduleRequest,
  type PutScheduleSettings,
  type ScheduleConflict,
  type ScheduleMetrics,
  type ScheduleSolverInfo,
  type StartDivisionRequest,
} from "@/server/api-v1/schemas";
import { sendOfficialAssignmentChangedEmail } from "@/lib/email";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { capacityInputForFixtures, guardCapacity } from "./capacity-guard";
import {
  candidateCourtsByFixture,
  guardNoMatchingCourt,
  guardNoMatchingCourtPerFixture,
  requiredCourtTagsByFixture,
  resolveCandidateCourts,
  resolveCourtCalendars,
  courtCalendarsForDivision,
  strandedCourtIdsForDivision,
  guardNoUsableCourtWindows,
  tagQualifiedCourtIdsByFixture,
  unionRequiredCourtTags,
} from "./court-candidates";
import { buildEngineConstraints } from "./engine-constraints";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { generateStageFixturesUnpublished } from "./stages";
import { schedulingAiModel, toRuleFixture } from "./schedule-ai";

type Tx = postgres.TransactionSql;

const MS_PER_MIN = 60_000;
const ms = (v: string | Date): number => new Date(v).getTime();
const iso = (t: number): string => new Date(t).toISOString();

// Every schedule write invalidates both public cache layers (the same pattern
// as scoring, doc 09 §3 / doc 12 §2) and refreshes any open boards.
// Exported for the #350 joint apply (competition-schedule-apply.ts), which fires
// it once per written division AFTER its single transaction commits — same
// placement as `applySchedule`, not a second copy of the invalidation list.
export function afterScheduleWrite(
  divisionId: string,
  competitionId: string,
  reason: "schedule" | "publish" | "start",
  /** R10d n2: every fixture this write changed. A write that moves no single
   *  fixture (publish, start) passes its division's fixtures, read in its own
   *  transaction, never found by a keyspace SCAN. */
  fixtureIds: readonly string[],
): void {
  fireDivisionRevalidate(divisionId, competitionId);
  sweepPublicKey(`pub:v1:div:${divisionId}:*`);
  // W2 — the competition HUB document (`pub:v1:hub:{competitionId}`) carries
  // every fixture's kick-off time and venue, so a RESCHEDULE makes it stale
  // exactly as a score does. Scoring's own `invalidatePublicCache` drops the
  // same key; a hub whose matches go stale on a reschedule is precisely the
  // defect that costs a spectator the trip.
  //
  // R10c m1: scoring's shape. The key is literal, so it goes out in one direct
  // DEL instead of a SCAN over the whole keyspace, and the division push waits
  // for that DEL, never longer than PUSH_AFTER_DELETE_BOUND_MS, exactly once. A
  // push sent first sends the hub's refetch to a Redis copy the delete has not
  // reached yet. The glob's SCAN above is not waited on: no push depends on it.
  //
  // R10d n2: the match centre and the overlay read `pub:v1:fixture:{id}`
  // (`publicFixture`, usecases/public.ts), a 30s cache of a fixture's kick-off,
  // venue and court. Every fixture this write changed has its key in the SAME
  // one DEL and its `fixture:{id}` push in the same bounded send, so an open
  // match centre refetches now instead of at its poll, and never before the
  // delete. A write that changed more than SCHEDULE_FIXTURE_PUSH_CAP fixtures
  // (a whole-division apply, publish or start) still drops every key but sends
  // no per-fixture push: one write must not fan out hundreds of broadcasts, and
  // those match centres catch up on their poll.
  const keys = [`pub:v1:hub:${competitionId}`, ...fixtureIds.map((id) => `pub:v1:fixture:${id}`)];
  // F4: never left to reject unhandled, for the reason `sweepPublicKey` gives.
  const deleted = cacheDel(...keys).catch((err: unknown) => {
    log.error({ err, keys }, "schedule: a public Redis delete failed (the write stands)");
  });
  const pushFixtures = fixtureIds.length <= SCHEDULE_FIXTURE_PUSH_CAP;
  sendAfterDeleteOrBound(deleted, () => {
    void publishDivisionUpdate(divisionId, reason);
    if (pushFixtures) for (const id of fixtureIds) void publishFixtureUpdate(id, "schedule");
  });
}

/** R10d n2: a schedule write that changed MORE fixtures than this sends no
 *  per-fixture push. Its DEL still drops every one of their keys. */
export const SCHEDULE_FIXTURE_PUSH_CAP = 50;

/** A public Redis sweep, not awaited, that can never reject unhandled (P1
 *  round 2, F4). `cacheDelPattern` fails open inside its own try, but its
 *  `client()` call sits outside it (cache.ts), and ioredis's constructor throws
 *  synchronously on a REDIS_URL it cannot parse — every call would reject. */
function sweepPublicKey(pattern: string): void {
  void cacheDelPattern(pattern).catch((err: unknown) => {
    log.error({ err, pattern }, "schedule: a public Redis sweep failed (the write stands)");
  });
}

// A fixture the auto pass / board may still move; everything else on the
// timetable is a fixed obstacle (doc 12 §6: decided fixtures are immutable —
// rain-rescheduling touches remaining fixtures only).
export const MOVABLE_STATUS = "scheduled";
// Statuses that still occupy a court (cancelled/abandoned ones do not).
export const OCCUPYING = ["scheduled", "in_play", "decided", "finalized", "forfeited"];
/** Court-holding statuses the auto pass will NOT re-place: the fixed board of a
 *  part-played competition (a rain-delay repair over a morning that is already
 *  `decided` is the canonical case).
 *
 *  DERIVED, never copied, and derived exactly ONCE — here. A hand-typed list
 *  rots silently the day `OCCUPYING` grows a member, and so does a second
 *  `.filter()` written elsewhere. Both the #350 joint builder
 *  (`competition-schedule-ai.ts`) and the court-removal guard below import
 *  this one, so there is no way for them to disagree about what "fixed" means. */
export const FIXED_OCCUPYING = OCCUPYING.filter((s) => s !== MOVABLE_STATUS);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

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

/** The PUBLIC payload of GET/PUT /api/v1/divisions/{id}/schedule-settings.
 *
 *  The route returns the two boundary functions below unmapped, so this shape
 *  IS the wire. The key is `tz` — not `displayTz` — because it is pinned by the
 *  `ScheduleSettings` response schema and documented in openapi/v1.json;
 *  renaming it would break every existing client. `orgTz` is deliberately NOT
 *  here: it was only ever serialised as an undocumented extra.
 *  Pinned by `__tests__/schedule-settings-wire.test.ts`. */
export interface ScheduleSettingsWire {
  division_id: string;
  config: ScheduleConfig;
  /** RESOLVED venue zone (V305) — the DISPLAY lane, `ScheduleSettingsOut.displayTz`. */
  tz: string;
  updated_at: string;
}

/** Internal → wire. The one place the display zone is renamed back to `tz`. */
function toWire(s: ScheduleSettingsOut): ScheduleSettingsWire {
  return {
    division_id: s.division_id,
    config: s.config,
    tz: s.displayTz,
    updated_at: s.updated_at,
  };
}

/** Does a config use the Pro constraint solver (doc 12 §5)? Community keeps
 *  quick-start + basic auto: one court, no rest/blackout/session constraints. */
function usesConstraints(config: ScheduleConfig): boolean {
  return (
    config.perEntrantMinRest > 0 ||
    config.blackouts.length > 0 ||
    config.sessionWindows.length > 0 ||
    config.courts.length > 1 ||
    // constraints v2 (Jul3/04 §6): the whole family rides the same Pro key
    config.constraints !== undefined
  );
}

export async function putScheduleSettings(
  auth: AuthCtx,
  divisionId: string,
  input: PutScheduleSettings,
): Promise<ScheduleSettingsWire> {
  if (usesConstraints(input.config)) {
    await requireFeature(auth.orgId, "scheduling.constraints");
  }
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  return withTenant(auth.orgId, async (tx) => {
    // The competition's own dates and the org zone come back with the division:
    // the containment guard below needs all three, and a second round trip for
    // two date columns on a hot endpoint is not worth it. `::text` is load
    // bearing — postgres hands a bare `date` back as a Date object, and
    // `zonedTimeToUtc` wants the `YYYY-MM-DD` key, not a JS date in the server's
    // own zone.
    const [division] = await tx<
      {
        competition_id: string;
        starts_on: string | null;
        ends_on: string | null;
        org_tz: string | null;
      }[]
    >`
      select d.competition_id,
             c.starts_on::text as starts_on,
             c.ends_on::text   as ends_on,
             o.timezone        as org_tz
      from divisions d
      join competitions c on c.id = d.competition_id
      left join organizations o on o.id = d.org_id
      where d.id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    assertNotFrozen(frozen, division.competition_id);
    // COURT-REMOVAL GUARD (date/time UX P08). Dropping a court that still
    // carries a fixture the schedule CANNOT relocate orphans that fixture: the
    // board grid stops drawing the column, so the card becomes invisible and
    // unmovable while still occupying the timetable. Refuse the whole save
    // rather than repairing it — the organiser is the only one who can say
    // whether the fixture or the court was the mistake.
    //
    // Two disjoint reasons a fixture cannot be relocated, and the refusal names
    // which one applies, because they need opposite remedies:
    //   * PINNED — `fixtures.schedule_locked`. Exempt from AUTO's own cleanup
    //     filter, and REFLOW's move-minimising objective leaves it put.
    //   * FIXED OCCUPANCY — `FIXED_OCCUPYING`, i.e. holds a court but is not
    //     `MOVABLE_STATUS`. Immutable by design (doc 12 §6). There is no pin to
    //     release here, so reporting one sends the organiser hunting for a
    //     setting that does not exist.
    // Everything still `scheduled` and unlocked is deliberately NOT blocked:
    // AUTO relocates those correctly today and refusing them would be a
    // regression, not a fix.
    //
    // THAT PREMISE DOES NOT HOLD ON A FROZEN DIVISION, and this arm does not
    // yet account for it. Once `divisions.schedule_locked` is set, every path
    // that could relocate a `scheduled` fixture refuses: `applySchedule` and
    // `moveFixture` (below), and `shiftDivisionSchedule`
    // (`schedule-plus.ts`). So removing a court from a frozen division strands
    // its fixtures on a court the settings no longer list, with no in-product
    // way to move them until someone unfreezes.
    //
    // Deliberately left as-is rather than guarded, and the reasons are
    // recorded so the next reader can weigh them rather than re-derive them:
    // this is a SETTINGS write, and the freeze as ruled binds board writes;
    // the damage is bounded, because `boardCourtColumns`
    // (`schedule-board.tsx`) back-fills a column for a court the settings
    // dropped, so the cards do not vanish; and unfreezing restores every
    // relocation path. If that trade is ever revisited, the fix is a
    // `divisionLockState` guard on the courts-removal arm only — not on the
    // whole save, which would refuse edits that touch no court at all.
    //
    // Placed BEFORE the upsert on purpose. Everything below this point writes,
    // so a rejection here leaves the stored config completely unchanged — the
    // atomicity half of the acceptance criteria, pinned by tests that re-read
    // the OTHER config fields after the refusal rather than only catching.
    //
    // Neither predicate is a fresh definition. "Pinned" is the clear path's:
    // history.ts `clearableFixtures` reads the column into
    // `locked: f.schedule_locked` and the engine gates on
    // `if (scope.excludeLocked && f.locked)`. "Fixed" is `FIXED_OCCUPYING`
    // above, derived once from OCCUPYING/MOVABLE_STATUS and shared with the
    // #350 joint builder. A second copy of either is exactly the fork this
    // area has already been bitten by.
    const stored = await loadSettings(tx, divisionId);

    // CONTAINMENT GUARD. A division's schedule window must sit inside its
    // competition's own dates. Nothing checked this before — not the wire
    // schema, not this use-case, not a DB constraint — so a division could be
    // timetabled entirely outside the competition it belongs to, and
    // `SlotConfig.window` is resolved from THIS range (`applyWindow`), never
    // from `competitions.starts_on/ends_on`, so the solver had no idea either.
    //
    // Only checked when the range CHANGED. That is the same stance the write
    // gate below this function takes — refuse what this change introduces, not
    // what the product already allowed to be stored. A division whose dates
    // already sit outside its competition must stay editable, or the organiser
    // cannot fix its courts or match length without first fixing dates they may
    // not own; and the range is fixable through this very endpoint.
    //
    // Bounds are wall-clock days ON THE ORG CLOCK (#397/#448), converted rather
    // than computed: a DST day is 23 or 25 hours long, so adding 86_400_000 is
    // wrong twice a year. `ends_on` is inclusive as a date, so its bound is the
    // START of the following day — exactly how `applyWindow` and `windowBounds`
    // already read an end date.
    const tzForWindow = resolveVenueTz(null, division.org_tz);
    const rangeChanged =
      (input.config.startAt ?? null) !== (stored.config.startAt ?? null) ||
      (input.config.endAt ?? null) !== (stored.config.endAt ?? null);
    if (rangeChanged) {
      const compFrom =
        division.starts_on !== null
          ? zonedTimeToUtc(division.starts_on, "00:00", tzForWindow)
          : null;
      const compTo =
        division.ends_on !== null
          ? zonedTimeToUtc(ymdAddDays(division.ends_on, 1), "00:00", tzForWindow)
          : null;
      const startsBefore =
        compFrom !== null && !!input.config.startAt && ms(input.config.startAt) < compFrom;
      const endsAfter = compTo !== null && !!input.config.endAt && ms(input.config.endAt) >= compTo;
      const outside: string[] = [];
      if (startsBefore) outside.push(`starts before the competition opens on ${division.starts_on}`);
      if (endsAfter) outside.push(`ends after the competition closes on ${division.ends_on}`);
      if (outside.length > 0) {
        // The English sentence stays EXACTLY as it was, because it is still
        // what a non-browser client (the public API, a curl) reads — the /api/v1
        // envelope has no locale to render into and this repo has no
        // server-side i18n at all (no Accept-Language read anywhere under
        // src/server). Localization happens at the ONE place that knows the
        // reader's locale: the organiser's own panel, which maps the code below
        // through `scheduleWindowErrorMessage` and falls back to this string
        // for any client that does not.
        //
        // WHICH BOUND was crossed rides in `extra` as two booleans rather than
        // being re-derived by parsing the sentence — a parse would break the
        // moment the copy is edited, and the copy is the part most likely to
        // be edited.
        throw new HttpError(
          422,
          `this division's schedule ${outside.join(" and ")} — widen the competition dates, or bring the division inside them`,
          "SCHEDULE_OUTSIDE_COMPETITION",
          {
            startsBefore,
            endsAfter,
            competitionStartsOn: division.starts_on,
            competitionEndsOn: division.ends_on,
          },
        );
      }
    }

    const removedCourts = stored.config.courts.filter(
      (court) => !input.config.courts.includes(court),
    );
    if (removedCourts.length > 0) {
      // One row per offending court, with the two reasons counted separately.
      // A pinned-AND-decided fixture counts once, as pinned: the pin is the
      // thing the organiser can actually act on.
      //
      // P9 pass 3a: `removedCourts` holds court IDS (`ScheduleConfig.courts`
      // has been `CourtId[]` since pass 1) — this guard queried
      // `court_label = any(removedCourts)` for one whole pass, which could
      // never match (a uuid against a free-text label), so it was silently
      // inert: a court could be removed out from under a pinned or in-play
      // fixture with nothing refusing it. Keying on `court_id` restores it.
      // "fixed" and "in_play" are split, not one combined count: they need
      // DIFFERENT remedies. A completed/decided/finalized/forfeited fixture
      // can have its court archived right now (`archiveCourt`,
      // `UNPLAYED_FIXTURE_STATUSES` in venues.ts blocks only on
      // scheduled/in_play). An in_play fixture cannot — it's still one of
      // archiveCourt's own UNPLAYED_FIXTURE_STATUSES, so pointing the
      // organiser at "archive it instead" for a live match sends them
      // straight into a SECOND 409 with no remedy at all (review finding,
      // P9 fix 3 follow-up: the two guards' status sets overlap on exactly
      // "in_play", which the original single `fixed` count could not tell
      // apart from a genuinely archivable one).
      const blocked = await tx<{ court_id: string; pinned: number; in_play: number; fixed: number }[]>`
        select court_id,
               count(*) filter (where schedule_locked)::int as pinned,
               count(*) filter (where not schedule_locked and status = 'in_play')::int as in_play,
               count(*) filter (
                 where not schedule_locked and status = any(${FIXED_OCCUPYING}) and status != 'in_play'
               )::int as fixed
        from fixtures
        where division_id = ${divisionId}
          and court_id = any(${removedCourts})
          and (schedule_locked or status = any(${FIXED_OCCUPYING}))
        group by court_id
        order by court_id`;
      if (blocked.length > 0) {
        // Names every offending court and every count, so the organiser does
        // not discover the next blocker only after clearing the first. A
        // name, never a bare uuid — resolved here rather than joined into
        // the query above so the fallback (a resolver miss) stays a single,
        // obvious `?? r.court_id` rather than a second query shape.
        const courtNames = await courtNamesById(tx);
        const detail = blocked
          .map((r) => {
            const why = [
              ...(r.pinned > 0 ? [`${r.pinned} pinned`] : []),
              ...(r.in_play > 0 ? [`${r.in_play} in play`] : []),
              ...(r.fixed > 0 ? [`${r.fixed} completed`] : []),
            ];
            return `${courtNames.get(r.court_id) ?? r.court_id} (${why.join(" + ")})`;
          })
          .join(", ");
        // `code` + `extra` let the panel (`lib/schedule-error.ts`) pick the
        // remedy that actually applies instead of always saying "unpin or
        // reschedule" — a court blocked purely by a completed fixture has
        // neither a pin to release nor a future slot to move (P9 fix 3).
        // `SCHEDULE_COURT_STILL_IN_USE`, never venues.ts's `COURT_IN_USE` —
        // same shape of problem, different guard, different remedy set.
        throw new HttpError(
          409,
          `cannot remove a court that still holds fixtures the schedule cannot move: ${detail} — unpin or reschedule them first`,
          "SCHEDULE_COURT_STILL_IN_USE",
          {
            courtsDetail: detail,
            anyPinned: blocked.some((r) => r.pinned > 0),
            anyInPlay: blocked.some((r) => r.in_play > 0),
            anyFixed: blocked.some((r) => r.fixed > 0),
          },
        );
      }
    }
    // tz is tri-state (V305). An ABSENT key must not clobber the stored value:
    // the division settings form no longer offers a timezone at all, so every
    // console save omits it, and a save may never move a division's venue zone.
    const tzTouched = input.tz !== undefined;
    await tx`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${divisionId}, ${tx.json(input.config as never)}, ${input.tz ?? null}, now())
      on conflict (division_id) do update
        set config = excluded.config,
            tz = case when ${tzTouched} then excluded.tz else schedule_settings.tz end,
            updated_at = now()`;
    return toWire(await loadSettings(tx, divisionId));
  });
}

export async function getScheduleSettings(
  auth: AuthCtx,
  divisionId: string,
): Promise<ScheduleSettingsWire> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return toWire(await loadSettings(tx, divisionId));
  });
}

// Settings row or the parsed defaults — the board and quick-start work
// without an explicit PUT (single court, no constraints).
export async function loadSettings(tx: Tx, divisionId: string): Promise<ScheduleSettingsOut> {
  // Left-join from divisions so the org zone is available even when the
  // division has no settings row yet (quick-start, board before first PUT).
  const [row] = await tx<
    {
      config: unknown | null;
      tz: string | null;
      org_tz: string | null;
      updated_at: string | null;
    }[]
  >`
    select ss.config, ss.tz, o.timezone as org_tz, ss.updated_at
    from divisions d
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o on o.id = d.org_id
    where d.id = ${divisionId}`;
  return {
    division_id: divisionId,
    config: ScheduleConfig.parse(row?.config ?? {}),
    // A division that already holds its own tz keeps winning, silently and
    // forever — the console can no longer set one, but it must never move.
    displayTz: resolveVenueTz(row?.tz, row?.org_tz),
    // Deliberately NOT resolveVenueTz(row?.tz, …): the division override must not
    // leak into the governing clock, or two divisions of one competition would
    // disagree about which calendar day a fixture is on (#397, design §2.1).
    orgTz: resolveVenueTz(null, row?.org_tz),
    // postgres hands timestamptz back as a Date, so the declared `string` was a
    // lie the wire hid (JSON.stringify(Date) already emits this exact ISO
    // string). Normalise here so `ScheduleSettings.parse` actually accepts it.
    updated_at:
      row?.updated_at !== null && row?.updated_at !== undefined
        ? new Date(row.updated_at).toISOString()
        : new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Engine input assembly
// ---------------------------------------------------------------------------

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

// Scope locks (Jul3/03 §4, 22 Jun two-site safety): fixtures matching a
// division's locked_scopes entry are treated exactly like pinned fixtures.
//
// P9 pass-3a-FIX: `courts`/`venues` hold real `courts.id`/`venues.id` values,
// not organiser-typed names — V374's third migration block rewrote every
// stored `locked_scopes` row from names to ids the same way pass 1 rewrote
// `schedule_settings.config.courts`. `scopeLocked` below matches on
// `court_id`/`venue_id` accordingly, never the legacy `court_label`/`venue`
// columns.
export interface LockedScope {
  /** Real `courts.id` values (V374 cutover). */
  courts?: string[];
  /** Real `venues.id` values (V374 cutover). */
  venues?: string[];
  pool_ids?: string[];
}

export function scopeLocked(
  f: Pick<FixtureLite, "court_id" | "venue_id" | "pool_id">,
  scopes: readonly LockedScope[],
): boolean {
  return scopes.some(
    (s) =>
      (s.courts !== undefined && f.court_id !== null && s.courts.includes(f.court_id)) ||
      (s.venues !== undefined && f.venue_id !== null && s.venues.includes(f.venue_id)) ||
      (s.pool_ids !== undefined && f.pool_id !== null && s.pool_ids.includes(f.pool_id)),
  );
}

// Exported for the #350 joint apply: a locked division must abort a joint write
// on exactly the terms it aborts a single-division one.
export async function divisionLockState(
  tx: Tx,
  divisionId: string,
): Promise<{ frozen: boolean; scopes: LockedScope[] }> {
  const [row] = await tx<{ schedule_locked: boolean; locked_scopes: LockedScope[] }[]>`
    select schedule_locked, locked_scopes from divisions where id = ${divisionId}`;
  return { frozen: row?.schedule_locked ?? false, scopes: row?.locked_scopes ?? [] };
}

/**
 * Which of a division's stages are round-robin-generated — `kind in
 * ('league', 'group')`, `stages.ts`'s own `generate()` switch (everything
 * else — knockout/page_playoff/double_elim/stepladder, plus swiss/americano/
 * ladder generated outside that switch entirely — is bracket- or
 * round-sequence-shaped some OTHER way).
 *
 * C1 (2026-08-12 round-order design): round attaches to round-robin-
 * generated fixtures ONLY. `fixtures.round_no` is one shared column
 * populated for EVERY stage kind (a bracket's own round, a swiss round, a
 * stepladder leg — F1 (2026-08-17) names every one of them by position via
 * roundRole()/roundRoleLabel(), never derived from this column alone), so
 * which stages may forward it as a scheduling ORDERING input is
 * not derivable from a `FixtureLite` row alone; this is the one query that
 * resolves it, so `toAssignment` and the schedulable builder can both ask
 * it the SAME question rather than guessing from the row itself. Without
 * this gate, a division that mixes a league stage with a stepladder — the
 * design doc's own motivating symptom — would compare the two stages'
 * independent 1-based round sequences as if they were one.
 */
export async function roundRobinStageIds(tx: Tx, divisionId: string): Promise<Set<string>> {
  const rows = await tx<{ id: string }[]>`
    select id from stages where division_id = ${divisionId} and kind in ('league', 'group')`;
  return new Set(rows.map((r) => r.id));
}

/** C1 fix-loop (G2/3rd instance). The same "sequence" identity `calendar.ts`'s
 *  round-order pair scan groups by — `(divisionId, stageId, poolId)`, `??
 *  ""`-normalized — mirrored HERE rather than imported, because this is a
 *  caller-side SELECTION question (which rows belong with the moved
 *  fixture(s) for THIS gate call), not a comparison rule; `calendar.ts`'s own
 *  logic is untouched. Every caller of `roundRobinSequenceSiblings` below
 *  must build its `keys` set with this same function, or the two silently
 *  drift the way `poolId`-only once did.
 *
 *  EXPORTED (C1 final-review, 4th instance of this exact bug class):
 *  `competition-schedule-apply.ts`'s joint per-division loop is a THIRD
 *  caller with the identical shape (a caller-scoped `mine`/`proposed` subset
 *  checked pairwise, an `untouched` sibling pool outside it) — reusing this
 *  function rather than re-deriving the key locally is deliberate, because a
 *  forked key is this codebase's own recurring bug (see the drift warning
 *  above, now three call sites strong). */
export function roundRobinSequenceKey(f: Pick<FixtureLite, "division_id" | "stage_id" | "pool_id">): string {
  return `${f.division_id}|${f.stage_id}|${f.pool_id ?? ""}`;
}

/** Already-placed fixtures sharing one of `keys`' round-robin sequence
 *  identity, excluding `exclude` (the fixture(s) a caller already lists
 *  explicitly in its own `assignments`/`proposed`).
 *
 *  This is the fix for `moveFixture`, `applySchedule`'s partial-apply gate,
 *  and (C1 final-review) `applyCompetitionSchedule`'s own per-division loop:
 *  all three compare their checked set PAIRWISE for round order
 *  (`validateAssignments`, scoped to its `assignments` parameter alone by
 *  design — see its own comment on the grouping key), and the checked side
 *  used to be only the fixture(s) a caller explicitly named. A fixture
 *  sitting only in `existing`/`untouched` can never be paired against
 *  anything, so a one- or few-fixture write could never detect a
 *  round-order violation against an untouched, already-placed round-robin
 *  sibling.
 *
 *  Every call site must pull this SAME result into its checked set on BOTH
 *  sides of its delta comparison (the current-position side and the
 *  proposed side) — the set composition has to be identical on both sides or
 *  the write gate reads every pre-existing violation among the siblings as
 *  newly introduced and blocks a move that never touched them (see each call
 *  site's own comment). `keys` empty (a non-round-robin move) short-circuits
 *  to no widening at all, matching prior behaviour exactly. */
export function roundRobinSequenceSiblings(
  all: readonly FixtureLite[],
  keys: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
): FixtureLite[] {
  if (keys.size === 0) return [];
  return all.filter(
    (f) =>
      !exclude.has(f.id) &&
      f.scheduled_at !== null &&
      f.court_id !== null &&
      keys.has(roundRobinSequenceKey(f)),
  );
}

const FIXTURE_LITE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round", "ext_key",
  "home_entrant_id", "away_entrant_id",
  // P9 pass 3a: court_id/venue_id are the real identity; court_label/venue
  // ride along read-only, for scopeLocked alone (see FixtureLite's comment).
  "scheduled_at", "court_id", "venue_id", "court_label", "venue", "status", "schedule_locked",
  "winner_to_fixture", "loser_to_fixture",
] as const;

export async function divisionFixtures(tx: Tx, divisionId: string): Promise<FixtureLite[]> {
  return tx<FixtureLite[]>`
    select ${tx(FIXTURE_LITE_COLS)} from fixtures
    where division_id = ${divisionId} and status in ${tx(OCCUPYING)}
    order by round_no, seq_in_round, id`;
}

/** id -> name for every court this org has configured (P9 pass 3a). The
 *  DERIVED, read-only name a response carries beside a `court_id` — see the
 *  dispatch ruling on `ScheduleAssignment`/`ScheduleConflictDetail`.
 *  Deliberately NOT filtered to non-archived: an archived court can still
 *  carry a real, already-placed fixture (ruling 3, candidate-courts.ts) or a
 *  historical conflict, and both must still render a name, not a bare uuid.
 *  Relies on `withTenant`'s RLS context for org scoping — the same
 *  convention `court-candidates.ts`'s `orgCourtMetas` already uses. */
export async function courtNamesById(tx: Tx): Promise<Map<string, string>> {
  // P9 review wave 2: VENUE-QUALIFIED, not the bare `courts.name`. A court name
  // is unique only WITHIN its venue (`courts_venue_name_active_idx` is scoped
  // per venue), so two venues may legally each name one "Court 1" — and every
  // consumer of this map was then showing them identically. That is not only a
  // display defect: `officials-ai.ts` prices a run on the count of DISTINCT
  // court values in its pack, so two same-named courts collapsed into one and
  // the credit rung came out under the run the organiser actually got.
  //
  // `buildCourtDirectory` is the one implementation of that rule (the board,
  // the picker and the AI pack already go through it) and it also settles the
  // residual ties — including an archived and an active court sharing a venue
  // AND a name, which the partial index permits once a name is freed.
  const rows = await tx<{ id: string; name: string; venue_name: string; tags: string[] }[]>`
    select c.id, c.name, v.name as venue_name, c.tags
    from courts c
    join venues v on v.id = c.venue_id
    order by v.sort, v.name, c.sort, c.name, c.id`;
  return new Map([...buildCourtDirectory(rows)].map(([id, info]) => [id, info.label]));
}

/** id -> name for every venue this org has configured (P9 pass 3a) — the
 *  `venue_id` sibling of {@link courtNamesById}, same reasoning throughout. */
export async function venueNamesById(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx<{ id: string; name: string }[]>`select id, name from venues`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** id -> venue_id for every court this org has configured (P9 review #5) —
 *  the SERVER-SIDE source of truth for which venue a court belongs to, so a
 *  fixture's `venue_id` can be DERIVED from its `court_id` rather than
 *  trusted from client input (see `applySchedule`/`moveFixture`'s writes). A
 *  supplied `venue_id` must never be able to disagree with the court's own
 *  venue. Deliberately NOT filtered to non-archived — same reasoning as
 *  `courtNamesById`: an archived court can still carry an already-placed
 *  fixture, and its venue_id must still resolve. Relies on `withTenant`'s
 *  RLS context for org scoping, same convention as `courtNamesById`/
 *  `venueNamesById`. */
/** court id -> its venue id. The venue a fixture sits in is DERIVED from the
 *  court it is on, never taken from the client: `courts.venue_id` and the
 *  composite FK already guarantee the two agree, so a supplied `venue_id`
 *  could only ever disagree. Exported for the JOINT apply path
 *  (competition-schedule-apply.ts), which must resolve it identically. */
export async function courtVenueIds(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx<{ id: string; venue_id: string }[]>`select id, venue_id from courts`;
  return new Map(rows.map((r) => [r.id, r.venue_id]));
}

// person ids per entrant, for cross-division overlap warnings (doc 06 §4.3).
export async function peopleByEntrant(tx: Tx, entrantIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (entrantIds.length === 0) return map;
  const rows = await tx<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members where entrant_id in ${tx(entrantIds)}`;
  for (const r of rows) {
    (map.get(r.entrant_id) ?? map.set(r.entrant_id, []).get(r.entrant_id)!).push(r.person_id);
  }
  return map;
}

// D4a (P5): a TBD/seeded fixture's null side(s) contribute NO people here, so
// crossPersonClash structurally skips a not-yet-filled slot — there is no
// person to clash on until confirm fills it (design: "Person-level
// constraints (crossPersonClash) skip TBD slots until filled — recorded
// limitation, re-validate on fill"). confirmSeedProposal (stages.ts)
// re-runs validateSchedule straight after its fillSlot commit so a clash that
// only becomes REAL once real entrants land surfaces as a warning then, not
// silently forever — this function needs no change for that, since it
// already reads whatever fixtures.*_entrant_id holds at call time.
function peopleOf(f: FixtureLite, people: Map<string, string[]>): string[] {
  return [
    ...(f.home_entrant_id ? (people.get(f.home_entrant_id) ?? []) : []),
    ...(f.away_entrant_id ? (people.get(f.away_entrant_id) ?? []) : []),
  ];
}

/** A DB fixture row as the engine's `Assignment`.
 *
 *  `poolId`/`divisionId` are stamped (#446). They are not decoration: the
 *  verifier resolves a pool- or division-targeted `restByGroup` and
 *  `startWindows` entry off exactly these two fields
 *  (`effectiveRestMinutes`/`startWindowFor`), and the placer resolves the same
 *  rules off the twin fields on `SchedulableFixture` (built at :523 from the
 *  same row). Dropping them here is what made a pool rule bind for
 *  Auto-schedule and evaporate the moment an organiser dragged a card.
 *
 *  Optionality follows the `SchedulableFixture` builder exactly: `division_id`
 *  is NOT NULL so it is always stamped; `pool_id` is nullable and the key is
 *  omitted rather than set to `undefined`, because `Assignment.poolId` is an
 *  optional string and the verifier tests it with `!== undefined`.
 *
 *  `movable` (C1, 2026-08-12 round-order design) is `!f.schedule_locked` —
 *  the established "pinned" predicate this codebase already uses
 *  (`clearableFixtures`'s own `locked: f.schedule_locked`, the COURT-REMOVAL
 *  GUARD above). Always stamped, unconditionally: `Assignment.movable`
 *  defaults to `true` when absent, so this is a safe no-op for the
 *  round-order pair scan on its own, and it matches `divisionId`'s own
 *  always-present convention (`schedule_locked` is NOT NULL, same as
 *  `division_id`).
 *
 *  `roundNo` is gated on `roundRobinStageIds`, an OPTIONAL 4th parameter —
 *  not read unconditionally off `f.round_no` the way `movable` reads off
 *  `f.schedule_locked`, because `fixtures.round_no` is one shared column
 *  populated for EVERY stage kind (bracket rounds, swiss rounds, stepladder
 *  legs all reuse it for display), and forwarding it for a non-round-robin
 *  stage would compare two independent round sequences as if they were one
 *  — the design doc's own motivating symptom. Omitted (not `undefined`)
 *  when the parameter itself is omitted: existing callers that do not pass
 *  it keep their exact pre-C1 behaviour, and round-order enforcement is
 *  correctly inert wherever it is not threaded through (`competition-
 *  schedule-apply.ts`, `schedule-ai.ts`'s AI-plan path, `person-merge.ts` —
 *  deferred this session; see the task report).
 *
 *  `stageId` (C1 fix-loop, Finding 2) is stamped UNCONDITIONALLY, the same
 *  way `divisionId` is — `fixtures.stage_id` is `NOT NULL`, no gate needed.
 *  It rides along regardless of whether `roundNo` itself is forwarded on
 *  this call: `calendar.ts`'s round-order grouping key only reads it off
 *  rows that already carry a `roundNo`, so a `stageId` on a round-less
 *  Assignment is simply never consulted. `calendar.ts`'s own comment on the
 *  grouping key explains WHY it is needed at all — `poolId` alone cannot
 *  tell two round-robin-kind stages in one division apart when neither has
 *  a pool (two `league` stages, say), which is exactly the shape
 *  `roundRobinStageIds` itself already has to return a SET for. */
export function toAssignment(
  f: FixtureLite,
  matchMinutes: number,
  people: Map<string, string[]>,
  roundRobinStageIds?: ReadonlySet<string>,
): Assignment {
  const start = ms(f.scheduled_at as string | Date);
  return {
    fixtureId: f.id,
    // P9 pass 3a: court_id, not the legacy court_label — `SlotConfig.courts`
    // has held real court uuids since pass 1 (`ScheduleConfig.courts:
    // z.array(CourtId)`), so an Assignment fed the OLD label could never
    // match a configured court string again; occupancy tracking and
    // double-booking detection would have gone silently blind the moment
    // this cutover's other half (the config side) landed. See
    // court-id-lattice-equivalence.test.ts — the lattice itself is a pure
    // representation swap either way.
    court: f.court_id ?? "",
    startAt: start,
    endAt: start + matchMinutes * MS_PER_MIN,
    entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
    people: peopleOf(f, people),
    ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
    divisionId: f.division_id,
    stageId: f.stage_id,
    ...(roundRobinStageIds?.has(f.stage_id) ? { roundNo: f.round_no } : {}),
    movable: !f.schedule_locked,
  };
}

// Direct-feed dependencies (doc 12 §2 warn.order): the source fixture's
// winner/loser feeds the target, so the target must not start earlier.
export function feedDependencies(fixtures: readonly FixtureLite[]): OrderDependency[] {
  const ids = new Set(fixtures.map((f) => f.id));
  const deps: OrderDependency[] = [];
  for (const f of fixtures) {
    for (const target of [f.winner_to_fixture, f.loser_to_fixture]) {
      if (target !== null && ids.has(target)) {
        deps.push({ fixtureId: target, dependsOn: f.id, direct: true });
      }
    }
  }
  return deps;
}

/** A sibling division's board, in the TWO shapes the engine needs it in (#462).
 *
 *  `assignments` is the court occupancy — what it has always been. `ruleFixtures`
 *  is the rule identity of those same rows, and it is not decoration: the day-cap
 *  tally counts only the `existing` entries it can NAME
 *  (`existing.filter((e) => fixtureById.has(e.fixtureId))`, where `fixtureById`
 *  comes from `config.ruleFixtures`), and every `terminal`/`ext_key` selector
 *  resolves through the same list. An `Assignment` cannot carry `extKey` or
 *  `winnerTo` — the fields are not on the type — so serving occupancy alone made
 *  a competition-scoped rule undercount by exactly the number of cross-division
 *  fixtures involved, in the direction that reports a breached board as clean.
 *
 *  Returned as a pair rather than as a second exported query on purpose: the two
 *  halves describe the same rows, and a caller that fetched one without the
 *  other is the defect. Both must reach `validateAssignments` — the occupancy as
 *  `existing`, the identity through `toVerifyConfig`'s `extraRuleFixtures`. */
export interface SiblingBoard {
  assignments: Assignment[];
  ruleFixtures: RuleFixture[];
}

// Sibling divisions' timetables (doc 06 §4.3): fixed court occupancy for the
// pass, and the source of cross-division person-overlap warnings. Durations
// use each sibling's own matchMinutes when it has settings.
export async function siblingAssignments(
  tx: Tx,
  divisionId: string,
  competitionId: string,
  fallbackMatchMinutes: number,
  /** Further divisions to leave out, on top of `divisionId` itself.
   *
   *  Added for the #350 joint pack: when several divisions of a competition are
   *  planned together the others are not "siblings" whose board is fixed — they
   *  are in the same run and their movable fixtures are being re-placed. Serving
   *  them here hands a division the rest of the run's own work as immovable
   *  obstacles, and since siblings carry NO division identity a caller cannot
   *  tell those entries from a genuinely-outside division's booking. Excluding
   *  them at the source is what makes "this obstacle is from outside the run" a
   *  fact instead of a slot-key guess. */
  excludeDivisionIds: readonly string[] = [],
): Promise<SiblingBoard> {
  const excluded = [...new Set([divisionId, ...excludeDivisionIds])];
  const rows = await tx<FixtureLite[]>`
    select ${tx(FIXTURE_LITE_COLS)} from fixtures
    where division_id in (select id from divisions
                          where competition_id = ${competitionId} and id not in ${tx(excluded)})
      and scheduled_at is not null and court_id is not null
      and status in ${tx(OCCUPYING)}`;
  if (rows.length === 0) return { assignments: [], ruleFixtures: [] };
  const settings = await tx<{ division_id: string; config: unknown }[]>`
    select division_id, config from schedule_settings
    where division_id in ${tx([...new Set(rows.map((r) => r.division_id))])}`;
  const minutes = new Map(
    settings.map((s) => [s.division_id, ScheduleConfig.parse(s.config).matchMinutes]),
  );
  const entrantIds = [
    ...new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id])),
  ].filter((e): e is string => e !== null);
  const people = await peopleByEntrant(tx, entrantIds);
  return {
    assignments: rows.map((r) =>
      toAssignment(r, minutes.get(r.division_id) ?? fallbackMatchMinutes, people),
    ),
    // Through the ONE builder (#447/#443), like every other RuleFixture in the
    // codebase — `winnerTo` and `extKey` are different namespaces that both type
    // as `string | null`, so a literal here would type-check and bind nothing.
    // `FIXTURE_LITE_COLS` already selects all five columns it reads.
    ruleFixtures: rows.map(rowToRuleFixture),
  };
}

export function toSlotConfig(settings: ScheduleSettingsOut, now: number): SlotConfig {
  const c = settings.config;
  const window = applyWindow(settings);
  const startAtMs = c.startAt ? ms(c.startAt) : now;
  const horizonMinutes =
    window !== undefined && Number.isFinite(window.to)
      ? Math.floor((window.to - startAtMs) / MS_PER_MIN) - c.matchMinutes
      : 0;
  return {
    startAt: startAtMs,
    // #399: the days the competition actually runs, so a card dragged outside
    // them is refused instead of badged. Delta-gated at the write, so a board
    // already sitting outside its dates stays editable.
    ...(window !== undefined ? { window } : {}),
    // The SOLVER has to respect the same bound, or the auto pass proposes a
    // board the apply gate then refuses: `slotFixtures` searches to
    // `startAt + horizonMinutes` and cannot emit a `window` conflict of its own,
    // so an over-subscribed division would come back with cards past its end
    // date and 409 on apply. Bounded here it reports `no_slot` (CAP), which is
    // the truth.
    //
    // `horizonMinutes` bounds the match START, so the match LENGTH comes off it
    // — a match starting exactly at the window's end would finish outside it —
    // and it floors rather than ceils, because a rounded-up minute is a minute
    // outside the window. A non-positive result means the end date is not after
    // the start date: a config error, and clamping it to zero would answer every
    // fixture with CAP as if the day were merely full. Left unbounded there, so
    // the auto pass behaves exactly as it did and the apply gate is what speaks.
    ...(window !== undefined && Number.isFinite(window.to) && horizonMinutes > 0
      ? { horizonMinutes }
      : {}),
    matchMinutes: c.matchMinutes,
    gapMinutes: c.gapMinutes,
    courts: [...c.courts],
    perEntrantMinRest: c.perEntrantMinRest,
    blackouts: c.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: ms(b.from),
      to: ms(b.to),
    })),
    sessionWindows: c.sessionWindows.map((w) => ({ from: ms(w.from), to: ms(w.to) })),
    // constraints v2 (Jul3/04 §3): ISO → epoch ms for the pure pass, through the
    // ONE builder (#458) the AI verify seams also go through, so this config and
    // the config a proposal is judged against cannot drift apart again.
    //
    // `hard: true` — the DURABLE typed rules (#398) ride `constraints.hard` on
    // this path, never the top-level `hard` field, because `effectiveHard`
    // MERGES the two and setting both would count every durable rule twice
    // (#447). The top-level field is where a run puts the stream it COMPILED
    // from an instruction, which is why the AI seams route them the other way.
    // Riding `toSlotConfig` rather than the wrapper below is deliberate too:
    // every existing caller gets them with no second place to remember.
    ...(c.constraints !== undefined
      ? {
          constraints: buildEngineConstraints(c.constraints, {
            fieldFairness: c.constraints.fieldFairness,
            parallelism: c.constraints.parallelism,
            crossPersonClash: c.constraints.crossPersonClash,
            hard: true,
          }),
        }
      : {}),
  };
}

/** A `fixtures` row as a `RuleFixture`, by renaming its columns onto the ONE
 *  builder (#447).
 *
 *  Deliberately not a second RuleFixture literal. `winnerTo` must carry
 *  `fixtures.winner_to_fixture` — a uuid FK to `fixtures.id` — and `extKey` must
 *  carry `fixtures.ext_key`, nullable text in a different namespace with no
 *  converter. `RuleFixture` types both `string | null`, so a producer that swaps
 *  them type-checks and then binds NOTHING, silently: that is #443, and #443 was
 *  invisible precisely because a second copy of the join existed. This function
 *  therefore does one thing — rename `pool_id`→`pool`, `winner_to_fixture`→
 *  `feeds.winner_to` — and hands the result to `toRuleFixture`, which stays the
 *  only assignment of `winnerTo` in the codebase. `schedule-ai-repair.test.ts`
 *  guards that count across all three modules. */
export function rowToRuleFixture(
  f: Pick<FixtureLite, "id" | "ext_key" | "pool_id" | "division_id" | "winner_to_fixture">,
): RuleFixture {
  return toRuleFixture(
    { id: f.id, ext_key: f.ext_key, pool: f.pool_id, feeds: { winner_to: f.winner_to_fixture } },
    f.division_id,
  );
}

/** Everything the VERIFIER reads, for the board paths (#447).
 *
 *  `toSlotConfig` answers the placer's question ("where may a card go?") and a
 *  `SlotConfig` is structurally assignable to a `VerifyConfig` with `tz`, `hard`,
 *  `ruleFixtures` and `restByDivision` all `undefined` — which is exactly why
 *  handing one straight to `validateAssignments` compiled clean for four call
 *  sites while dropping every typed rule on the floor.
 *
 *  Two of those fields are load-bearing here and both are traps:
 *
 *    tz            `validateInstructionRules` wraps its ENTIRE typed-rule block
 *                  in `if (tz !== undefined)`, on purpose: every rule in it
 *                  needs a day boundary or a wall-clock time, and bucketing one
 *                  in UTC would report a violation the organiser never expressed.
 *                  So carrying the rules WITHOUT the zone is a fix that binds
 *                  nothing. It is `orgTz`, never `tz` — the org zone governs
 *                  every temporal boundary (#397), and the division's display
 *                  override must not move a rule's calendar day.
 *    ruleFixtures  the feeder→dependent half of `min_rest_minutes` iterates it,
 *                  and every `terminal`/`ext_key` selector resolves through it.
 *                  Without it those rules compile, display as enforced, and bind
 *                  nothing — the same failure shape as #443.
 *
 *  No `restByDivision`: that is the JOINT verifier's field, for the one pass per
 *  division `verifyJoint` runs. These paths verify one division against a fixed
 *  sibling board, which is a different question.
 *
 *  Returns `SlotConfig & VerifyConfig` so the auto pass can hand ONE object to
 *  both the placer and the verifier. A second builder for the second consumer is
 *  how the placer and the verifier drift apart. */
export function toVerifyConfig(
  settings: ScheduleSettingsOut,
  /** The division's own fixture rows — `divisionFixtures`, not just the movable
   *  ones. A selector may name a fixture this run cannot move, and a day cap
   *  counts every fixture on the day. */
  fixtures: readonly FixtureLite[],
  now: number,
  /** Rule identity for rows that are NOT this division's (#462) — in practice
   *  `siblingAssignments(...).ruleFixtures`.
   *
   *  Every caller that puts sibling assignments on the board must pass this, and
   *  the reason is asymmetric: omitting it does not disable a rule, it makes the
   *  rule QUIETLY UNDERCOUNT. A competition-scoped day cap tallies only the
   *  `existing` rows named in `ruleFixtures`, so an unnamed sibling card is on
   *  the board for court purposes and absent for rule purposes — a board that
   *  breaches the cap reports clean. There is no signal anywhere; that is why
   *  `siblingAssignments` returns the two halves together rather than leaving
   *  this to a second call a caller can simply not make. */
  extraRuleFixtures: readonly RuleFixture[] = [],
  /** P9.5: the candidate courts' own opening hours (`resolveCourtCalendars`).
   *
   *  A PARAMETER, not a field read off `settings.config`, for the reason
   *  `toSlotConfig` above copies every field by hand: this config is assembled
   *  explicitly, so anything merely added to the wire config is silently
   *  dropped here — an inert seam that typechecks, renders as enforced and
   *  binds nothing (the #443 shape, and the `tz` trap two doc paragraphs up).
   *  Loading it needs a `tx` and an already-resolved candidate set, neither of
   *  which `settings` carries, so the call site passes it in.
   *
   *  Omitted means "this path does not consult court calendars" — NOT "no court
   *  has any". Both the placer and the verifier read it off ONE object here, so
   *  the two cannot be handed different court hours. */
  courtCalendars?: readonly CourtCalendar[],
  /** P10 (A6/§1): archived-or-absent court ids among this run's OWN assigned
   *  courts (`strandedCourtIdsForDivision`, court-candidates.ts's sibling of
   *  `resolveCourtCalendars`). Same reasoning as `courtCalendars` immediately
   *  above — a PARAMETER because this config is assembled explicitly, not
   *  spread from `settings.config` — and same VerifyConfig-only shape as
   *  `courtTagQualifiedIds`: absent on `SlotConfig`, so `BuildInput.config`'s
   *  own narrower type does not name it either. It still reaches every
   *  `validateAssignments` call inside `build.ts`, because `greedySeed`'s
   *  `verifyConfig: BuildConfig = { ...config }` copies whatever the caller's
   *  actual object carries, structurally, at runtime — regardless of what
   *  `BuildInput.config`'s own type declares. Pinned by `build.test.ts`'s
   *  "does not cry infeasible over a pin sitting on a court the server flagged
   *  stranded" (0a74dbae7). Omitted means "no court in this run's assigned set
   *  is stranded" — NOT "the server never checked". */
  strandedCourtIds?: readonly string[],
): SlotConfig & VerifyConfig {
  return {
    ...toSlotConfig(settings, now),
    tz: settings.orgTz,
    ruleFixtures: [...fixtures.map(rowToRuleFixture), ...extraRuleFixtures],
    ...(courtCalendars !== undefined && courtCalendars.length > 0 ? { courtCalendars } : {}),
    ...(strandedCourtIds !== undefined && strandedCourtIds.length > 0 ? { strandedCourtIds } : {}),
  };
}

/** P10 (§3): the ONE place a `VerifyConfig` gets both its court signals —
 *  calendars AND stranded status. Five sites used to assemble a `VerifyConfig`
 *  by hand; four passed `courtCalendars` and `person-merge.ts:382` passed
 *  neither. Hand-assembly at five sites is how a blind sixth is born, so this
 *  resolves both (in parallel — the two queries are independent reads over the
 *  same open `tx`) and hands the result to `toVerifyConfig` above.
 *
 *  `assignedCourtIds` is the caller's OWN "which courts are actually in use on
 *  this board" set — never re-derived here, because what counts as "assigned"
 *  differs by caller (the whole division's board vs. one fixture's move) and a
 *  second opinion on that question is exactly the placer/verifier fork this
 *  subsystem keeps re-diagnosing. */
export async function verifyConfigForDivision(
  tx: Tx,
  settings: ScheduleSettingsOut,
  fixtures: readonly FixtureLite[],
  now: number,
  extraRuleFixtures: readonly RuleFixture[],
  divisionId: string,
  assignedCourtIds: readonly string[],
): Promise<SlotConfig & VerifyConfig> {
  const [courtCalendars, strandedCourtIds] = await Promise.all([
    courtCalendarsForDivision(tx, divisionId, settings.config.courts),
    strandedCourtIdsForDivision(tx, divisionId, assignedCourtIds),
  ]);
  return toVerifyConfig(settings, fixtures, now, extraRuleFixtures, courtCalendars, strandedCourtIds);
}

// ---------------------------------------------------------------------------
// Conflict taxonomy (doc 12 §2) — engine reasons → API codes. REASON_CODE is
// the single shared table in lib/schedule-board (isomorphic), so the AI diff
// panel maps blocking-row reasons through the exact same map client-side.
// ---------------------------------------------------------------------------

/**
 * `blocking` means PHYSICALLY IMPOSSIBLE, on every path (#399) — a court booked
 * twice, a human on two courts at once, a slot outside the competition's days, a
 * fixture before its feeder is done resting. It is the engine's one answer
 * (`isBlockingConflict`), so the board's red badges and the AI pipeline's
 * verdicts cannot drift apart the way they had.
 *
 * It deliberately does NOT mean "this write was refused". That is the DELTA, and
 * it lives in `assertNoNewBlocking` below. Folding the two together made a
 * report of an impossible board come back entirely in amber, because nothing in
 * a read-only report is ever newly introduced.
 */
/** `ConflictDetail`'s camelCase fields, snake_cased for the wire — the same
 *  casing `ScheduleConflict` uses throughout (`fixture_id`,
 *  `shortfall_minutes`). A plain rename, nothing derived; conditional spreads
 *  throughout so an absent field stays ABSENT rather than a present `undefined`
 *  (`mapConflicts`' own established idiom, just below). */
function toWireConflictDetail(d: ConflictDetail): NonNullable<ScheduleConflict["details"]> {
  return {
    kind: d.kind,
    ...(d.entrantIds !== undefined ? { entrant_ids: d.entrantIds } : {}),
    ...(d.personIds !== undefined ? { person_ids: d.personIds } : {}),
    ...(d.otherFixtureId !== undefined ? { other_fixture_id: d.otherFixtureId } : {}),
    ...(d.court !== undefined ? { court: d.court } : {}),
    // P9 pass 3a: reads `courtName` already resolved onto `d` by
    // `mapConflicts` below — this function itself does no db lookup.
    ...(d.courtName !== undefined ? { court_name: d.courtName } : {}),
    ...(d.day !== undefined ? { day: d.day } : {}),
    ...(d.otherDay !== undefined ? { other_day: d.otherDay } : {}),
    ...(d.weekday !== undefined ? { weekday: d.weekday } : {}),
    ...(d.requiredWeekday !== undefined ? { required_weekday: d.requiredWeekday } : {}),
    ...(d.requiredDate !== undefined ? { required_date: d.requiredDate } : {}),
    ...(d.time !== undefined ? { time: d.time } : {}),
    ...(d.requiredTime !== undefined ? { required_time: d.requiredTime } : {}),
    ...(d.ruleType !== undefined ? { rule_type: d.ruleType } : {}),
    ...(d.roundNo !== undefined ? { round_no: d.roundNo } : {}),
    ...(d.otherRoundNo !== undefined ? { other_round_no: d.otherRoundNo } : {}),
    ...(d.minutes !== undefined ? { minutes: d.minutes } : {}),
    ...(d.requiredMinutes !== undefined ? { required_minutes: d.requiredMinutes } : {}),
    ...(d.count !== undefined ? { count: d.count } : {}),
    ...(d.requiredCount !== undefined ? { required_count: d.requiredCount } : {}),
  };
}

/**
 * `court` on a `ConflictDetail` (P9 pass 3a) is a real `courts.id` now —
 * `court_double_booking`, `locked_slot_clash`, and `court_tag_mismatch`
 * (P9 pass 2c) are the three kinds that set it (via `Assignment.court`,
 * `toAssignment`'s own comment). `courtNames` is required, not defaulted,
 * so a caller cannot forget to resolve it and
 * silently ship a bare uuid in `details.court_name` / the legacy prose —
 * every call site below fetches it once (cheap: `select id, name from
 * courts`, RLS-scoped) and threads it through.
 *
 * Resolves onto a CLONE of `details` — the engine's own `Conflict[]` is
 * never mutated — via the engine's `ConflictDetail.courtName` field (see
 * its own doc comment): `legacyConflictDetail` is a pure function that
 * takes no second argument, so this is the one place a resolved name can
 * reach it.
 */
/** Attach the derived, venue-qualified court name to a conflict's details.
 *  Exported (review wave 3) so the AI-plan and joint-apply paths resolve
 *  identically instead of shipping a raw uuid to the organiser. */
export function withCourtNames(details: ConflictDetail, courtNames: ReadonlyMap<string, string>): ConflictDetail {
  if (details.court === undefined) return details;
  const courtName = courtNames.get(details.court);
  return courtName !== undefined ? { ...details, courtName } : details;
}

function mapConflicts(
  conflicts: readonly Conflict[],
  courtNames: ReadonlyMap<string, string>,
): ScheduleConflict[] {
  return conflicts.map((c) => {
    const details = c.details !== undefined ? withCourtNames(c.details, courtNames) : c.details;
    return {
      fixture_id: c.fixtureId,
      code: REASON_CODE[c.reason],
      // The rule the prompt teaches, carried through so the organiser's 409 and a
      // repair round cite the same token (#399).
      ...(c.rule !== undefined ? { rule: c.rule } : {}),
      ...(c.shortfallMinutes !== undefined ? { shortfall_minutes: c.shortfallMinutes } : {}),
      blocking: isBlockingConflict(c),
      // Structured (additive) and the deprecated derived English (back-compat,
      // C3 2026-08-13 design amendment) — both from the SAME `details`, so they
      // can never disagree. Omitted together: a `Conflict` the engine built
      // without a `details` entry gets neither, same as it got no `detail`
      // before this wave.
      ...(details !== undefined
        ? { details: toWireConflictDetail(details), detail: legacyConflictDetail(details) }
        : {}),
    };
  });
}

/**
 * The competition's own dates as an engine window (#399).
 *
 * Deliberately NOT the AI pack's resolved window: that one WIDENS onto whatever
 * is already scheduled and onto the compiled instruction, so nothing already on
 * the board could ever fall outside it — a window that can never be broken
 * enforces nothing. It also defaults to seven days when no end date is set, and
 * caging a board inside an invented week is not something an apply gate may do.
 *
 * Each bound is independently optional: an organiser who set only a start date
 * gets a floor and no ceiling.
 */
export function applyWindow(
  settings: ScheduleSettingsOut,
): { from: number; to: number } | undefined {
  const { startAt, endAt } = settings.config;
  if (!startAt && !endAt) return undefined;
  // The ORG zone governs every temporal boundary (#397): a day is a wall-clock
  // day where the organisation lives, and a DST day is 23 or 25 hours long, so
  // the bounds are converted rather than arithmetic on 86_400_000.
  const tz = settings.orgTz;
  return {
    from: startAt ? zonedTimeToUtc(dayKeyInTz(ms(startAt), tz), "00:00", tz) : -Infinity,
    // EXCLUSIVE end-of-last-day, matching `windowBounds` in the AI path: a match
    // ending at exactly midnight sits entirely on days inside the window.
    to: endAt ? zonedTimeToUtc(ymdAddDays(dayKeyInTz(ms(endAt), tz), 1), "00:00", tz) : Infinity,
  };
}

/**
 * The write gate (#399). Refuses only what THIS change introduced or worsened,
 * measured by running the identical verifier pass over the board as it stands
 * and taking the difference on conflict identity.
 *
 * Delta rather than absolute, because boards published before this wave may
 * legitimately carry person overlaps — they were warnings all along. Under an
 * absolute rule the organiser's next edit to such a board would 409 and they
 * would be stuck, unable to fix the very thing that is wrong.
 */
function assertNoNewBlocking(
  before: readonly Conflict[],
  after: readonly Conflict[],
  courtNames: ReadonlyMap<string, string>,
): void {
  const refused = deltaConflicts(before, after).filter(isBlockingConflict);
  if (refused.length > 0) {
    throw new EngineError("SCHEDULE_CONFLICT", "schedule change hits a blocking conflict", {
      conflicts: mapConflicts(refused, courtNames),
    });
  }
}

// ---------------------------------------------------------------------------
// Auto pass (propose only — doc 12 §4: nothing persisted)
// ---------------------------------------------------------------------------

/**
 * The lexicographic improvement targets `buildSchedule` walks: T0's placement
 * count, then days used, per-day span, per-day start offset, idle gap, court
 * balance.
 *
 * RE-EXPORTS the engine's `TIER_COUNT` rather than restating it. It used to be
 * a hand-written `4` with a comment claiming it "MIRRORS `TIER_COUNT` ...
 * which is module-private there" — and that comment was already wrong when it
 * was written: `build.ts` exports the constant precisely so this layer does not
 * need a copy (its own comment records the ruling, R17). The copy survived
 * anyway and had to be corrected by hand when the ladder went from four rungs
 * to six on 2026-08-13, which is the drift the export existed to prevent.
 *
 * Not free-floating either way: `buildSchedule` returns
 * `status: "already_optimal"` only when `tiersCompleted` reached the ladder's
 * length, so a run that comes back `already_optimal` states the engine's number
 * out loud. `__tests__/schedule-solver-telemetry.test.ts` drives exactly that
 * run and compares, so a ladder that grows or shrinks in the engine reds there
 * rather than shipping a wrong denominator to the board.
 */
export const TIERS_TOTAL = TIER_COUNT;

export interface AutoScheduleOut {
  assignments: {
    fixture_id: string;
    scheduled_at: string;
    ends_at: string;
    court_id: string;
    /** DERIVED, read-only (P9 pass 3a) — see `ScheduleAssignment` in schemas.ts. */
    court_name: string | null;
  }[];
  conflicts: ScheduleConflict[];
  /** Board quality of the proposal (Task 8's wire shape, filled here). */
  metrics: ScheduleMetrics;
  /** How the proposal was produced — telemetry, not policy. */
  solver: ScheduleSolverInfo;
}

/**
 * Everything the solve needs, read under one transaction and carried out of it.
 *
 * The split this type exists for is not tidiness. See `autoSchedule`.
 */
interface AutoSchedulePlan {
  schedulable: SchedulableFixture[];
  config: SlotConfig & VerifyConfig & { courts: string[] };
  board: Assignment[];
  /** D2 capacity guard inputs — carried out of the transaction alongside
   *  everything else `capacityInputForFixtures` needs, so phase 2 does not
   *  have to re-open a connection to ask for them. */
  divisionId: string;
  orgTz: string;
  /** The ORGANISER-DECLARED config (`declaredConfig`) — neither
   *  `boundSolverWindow`'s synthetic window-fill nor
   *  `withDefaultDaySpread`'s synthetic cap. See the guard call site's
   *  comment for why this is deliberately NOT the same object as `config`. */
  capacityConfig: SlotConfig & VerifyConfig & { courts: string[] };
  /** P9 pass 2b: the union of tags that produced `capacityConfig.courts` —
   *  division ∪ stage (`unionRequiredCourtTags`). Carried out of the
   *  transaction purely for the phase-2 `guardNoMatchingCourt` error
   *  payload; nothing else reads it. */
  requiredCourtTags: string[];
  /** P9 pass 3a: id -> name, resolved once in phase 1 (the only phase with
   *  a db connection) and carried out for phase 3's wire mapping
   *  (`court_name` on each proposed assignment, and any conflict whose
   *  `details.court` needs one). */
  courtNames: Map<string, string>;
  /**
   * The direct winner/loser feed edges of the whole division (#452).
   *
   * NOT OPTIONAL DECORATION, and the reason it is on the plan rather than
   * rebuilt at each use is that all three consumers must read the SAME list.
   * `slotFixtures` — the pass this wave replaced — walked fixtures in ascending
   * round order, so a dependent could not physically land before its feeder and
   * nothing had to be told about the edges. `buildSchedule` and `repairSchedule`
   * place by search and have no such structural guarantee: both take
   * `dependencies`, both encode it as a hard term, and `validateAssignments`
   * reports `order` only for the edges it is handed.
   *
   * With the list absent all three went blind at once, and the two holes lined
   * up into a wrong board rather than a missing warning: given a
   * `feeder_to_dependent` rest rule the repair solver "satisfied" it by moving
   * the final BEFORE its own semi-finals (measured: feeder end 09:30, final
   * start 08:30), `validateInstructionRules` skips a dependent placed before its
   * feeder on purpose, `order` had no edges to check — and the pass reported
   * `conflicts: []` on a board `applySchedule`, which has always passed
   * `feedDependencies(all)`, then answered with a blocking 409.
   */
  dependencies: OrderDependency[];
  placedNow: Assignment[];
  pinnedNow: Assignment[];
  frozen: string[];
  total: number;
}

/**
 * The auto pass: propose only, nothing persisted (doc 12 §4).
 *
 * THREE PHASES, AND THE BOUNDARIES ARE LOAD-BEARING.
 *
 *   1. READ, under one transaction, into an `AutoSchedulePlan`.
 *   2. SOLVE, with NO transaction open and no pooled connection held.
 *   3. MAP, pure.
 *
 * Phase 2 must not run inside phase 1's transaction, and this is a hard rule
 * rather than a preference. `withTenant` pins a pooled connection for the whole
 * callback, and the solve is now up to `AUTO_SOLVER_WALL_MS` spent on a remote
 * call to the placement CP-SAT service (BUILD/POLISH directly, REFLOW through
 * `reflowExisting` — since C4, 2026-08-14, none of the three modes calls z3 for
 * scheduling any more; that gRPC round trip has its own queueing on the service
 * side, `solver_busy`/`solver_unavailable` when it is saturated or unreachable)
 * — so a solve inside the transaction is tens of seconds of idle-in-transaction
 * per organiser click, and a handful of concurrent clicks exhausts the pool and
 * stalls DB traffic for the entire application.
 *
 * That hazard did not exist before this wave: the in-transaction work used to be
 * a synchronous `slotFixtures` pass. It arrived WITH the solver, which is
 * exactly why it is called out here rather than assumed to be obvious.
 *
 * There is no second transaction, because this use case writes nothing. If a
 * write tail is ever added it opens its own, after the solve.
 *
 * Pinned by `__tests__/schedule-auto-tx-boundary.test.ts`, structurally — it
 * asserts the solver is entered at transaction depth 0, not that the call was
 * fast, because a timing assertion is a flake on a loaded machine.
 */
export async function autoSchedule(
  auth: AuthCtx,
  stageId: string,
  body: AutoScheduleRequest,
): Promise<AutoScheduleOut> {
  // ---- Phase 0: the cooldown. Before the read, before the solver, before
  // anything that costs more than a Redis INCR.
  await rateLimit(`auto-schedule:${auth.orgId}`, autoScheduleCooldown());

  // ---- Phase 1: read. The connection goes back to the pool at the `}` below.
  const plan = await withTenant(auth.orgId, async (tx): Promise<AutoSchedulePlan> => {
    const [stage] = await tx<
      {
        division_id: string;
        competition_id: string;
        // P9 pass 2b: read straight off the SAME join the rest of this query
        // already makes rather than a second round trip — division's D5/P8
        // tags and the stage's own V367 sibling (its READ path, previously
        // unwired, see court-candidates.ts), unioned below for the
        // candidate-court resolve.
        stage_required_court_tags: string[];
        division_required_court_tags: string[];
      }[]
    >`
      select s.division_id, d.competition_id,
        s.required_court_tags as stage_required_court_tags,
        d.required_court_tags as division_required_court_tags
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    const settings = await loadSettings(tx, stage.division_id);
    const all = await divisionFixtures(tx, stage.division_id);
    // P9 pass 3a: resolved once here (the only phase with a connection) and
    // carried out via the plan for phase 3's wire mapping — see AutoSchedulePlan.
    const courtNames = await courtNamesById(tx);
    const { scopes } = await divisionLockState(tx, stage.division_id);
    // C1 (2026-08-12 round-order design). Resolved once, reused for both the
    // `schedulable` builder below and every `toAssignment` call in this
    // function — `obstacles` spans OTHER stages in this same division, so
    // without this a stepladder's own round_no (display numbering, not a
    // round-robin sequence) would ride along and get compared against this
    // stage's round-robin rounds as if they were one sequence.
    const roundRobin = await roundRobinStageIds(tx, stage.division_id);
    const entrantIds = [
      ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
    ].filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, entrantIds);

    // Movable: this stage's undecided fixtures. Fixed obstacles: everything
    // already on the timetable elsewhere in the division (other stages,
    // decided fixtures) plus sibling divisions.
    const movable = all.filter((f) => f.stage_id === stageId && f.status === MOVABLE_STATUS);
    const obstacles = all
      .filter((f) => !movable.includes(f))
      .filter((f) => f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    const siblings = await siblingAssignments(
      tx,
      stage.division_id,
      stage.competition_id,
      settings.config.matchMinutes,
    );

    // Pinned cards are fixed obstacles on EVERY mode, BUILD included (owner
    // ruling 2026-08-12, #pins-in-build) — scope-locked fixtures (Jul3/03 §4
    // two-site safety) pin the same way. Hoisted out of the `schedulable`
    // builder below because THREE things read it now — the `locked` anchor,
    // REFLOW's incumbent board, and the set `buildSchedule` may not move
    // (C4, 2026-08-14: `reflowExisting`'s `pinned` arg, frozen alongside
    // `placed` — see that function's own doc comment).
    //
    // `only_unlocked` used to gate this filter too, which was the bug: the
    // primary Auto-schedule button always posts `only_unlocked: false` (to
    // derive `mode: "build"` — see `AutoScheduleRequest` in schemas.ts), so
    // the gate silently zeroed this set on every BUILD call and a locked
    // fixture entered the solve fully movable. `only_unlocked` now steers
    // ONLY `mode` derivation, nowhere else; a lock is honoured regardless of
    // it, and `ignore_locks` is the one explicit way to suppress one.
    //
    // ONE predicate (`lockedFixtureIds`, below), reused as-is for POLISH's
    // `frozen` set at the return statement — a second hand-maintained copy of
    // "is this fixture locked" is exactly how the pin the solver honours and
    // the pin the caller sees drifted apart in the first place.
    const pinnedIds = lockedFixtureIds(movable, scopes, body.ignore_locks ?? false);

    // P9 pass 2b: the candidate court set for THIS stage — the organiser's
    // configured `settings.config.courts`, filtered to non-archived courts
    // carrying every tag the division OR the stage requires, through the
    // ONE engine filter (court-candidates.ts's own header explains why a
    // second, inlined tag-filter loop here is this subsystem's recurring
    // bug). `settingsForEngine` overrides ONLY `config.courts` — every other
    // read of `settings` below (matchMinutes, orgTz, …) stays untouched —
    // so `toVerifyConfig`/`toSlotConfig` need no changes of their own:
    // `courts: [...c.courts]` already does the right thing once the courts
    // it's handed already ARE the filtered set.
    const requiredCourtTags = unionRequiredCourtTags(
      stage.division_required_court_tags,
      stage.stage_required_court_tags,
    );
    // #622 review (finding #9): these two are independent reads over the same
    // open tx — `resolveCandidateCourts` resolves the STAGE-WIDE set,
    // `requiredCourtTagsByFixture` the per-fixture tag map `candidateCourtsByFixture`
    // narrows below — so there is no ordering dependency to serialise them for.
    const [candidateCourtIds, fixtureTags] = await Promise.all([
      resolveCandidateCourts(tx, stage.division_id, settings.config.courts, requiredCourtTags),
      requiredCourtTagsByFixture(tx, stage.division_id, stage.division_required_court_tags),
    ]);
    // #622: the stage-wide set above is now a FLOOR, not the whole answer. A
    // round-scoped tag narrows individual fixtures BELOW it (only the final
    // needs the championship court), so each movable fixture carries its own
    // `allowedCourts` and `config.courts` stays the stage-wide set — which is
    // exactly what the lattice needs, because a lattice narrowed to the
    // intersection would delete the slots the un-narrowed rounds must use.
    //
    // Resolved through the shared `requiredCourtTagsByFixture`/
    // `candidateCourtsByFixture` pair (fetched alongside `candidateCourtIds`
    // above), the SAME two `validateScheduleIn` and `buildSchedulePack`
    // resolve through, so the three cannot disagree about a fixture's
    // candidate set — the fork court-candidates.ts's header opens by warning
    // about, now with a third scope to fork over.
    const fixtureCandidates = await candidateCourtsByFixture(
      tx,
      stage.division_id,
      settings.config.courts,
      fixtureTags,
    );
    const settingsForEngine = {
      ...settings,
      config: { ...settings.config, courts: [...candidateCourtIds.ids] },
    };
    // P9.5: the candidate courts' own opening hours (V367). Scoped to the
    // candidate ids, which is what keeps an ARCHIVED court's existing cards
    // validating clean — an archived court is not a candidate, so it is absent
    // from this list, and `usableWindows` reads absent as unrestricted. "The
    // court is gone" is P10's stranded-fixture case (A6), not this one.
    const courtCalendars = await resolveCourtCalendars(tx, candidateCourtIds.ids);
    // P10 (A6/§1): this run's OWN assigned courts, so an existing card sitting
    // on a since-archived court is flagged on the very board this pass hands
    // back — not only on the NEXT /validate. `all`, not `movable`: an obstacle
    // card this run cannot move is still on the board this pass reports on.
    const strandedCourtIds = await strandedCourtIdsForDivision(
      tx,
      stage.division_id,
      [...new Set(all.map((f) => f.court_id).filter((c): c is string => c !== null))],
    );

    // #622: which of this stage's movable fixtures are narrowed BELOW the
    // stage-wide candidate set by a round-scoped tag, as `allowedCourts` for
    // the solver and the greedy placer. A fixture whose set already equals the
    // stage-wide one gets nothing at all — that is every fixture on every
    // board with no round rules, so the ordinary solve is unchanged down to
    // the wire bytes (`build.ts`'s `allowedCourtsFor`, and `model.py` section
    // 1c which emits no constraint for an unconstrained fixture).
    const stageWideCourts = new Set(candidateCourtIds.ids);
    const narrowedCourtsFor = (fixtureId: string): readonly string[] | undefined => {
      const ids = fixtureCandidates.get(fixtureId);
      if (ids === undefined) return undefined;
      if (ids.length === stageWideCourts.size && ids.every((id) => stageWideCourts.has(id))) {
        return undefined;
      }
      return ids;
    };
    const schedulable: SchedulableFixture[] = movable.map((f) => ({
      id: f.id,
      // C1 (2026-08-12 round-order design). `roundNo` used to be stamped
      // unconditionally — harmless while it was only a soft placement-order
      // hint for `slotFixtures`' own comparator, but `movable` is always
      // stage-scoped to ONE stage here (see the `movable` filter above), so
      // a bare stage-kind check is enough: gated the same way `toAssignment`
      // is, for the same reason (round is now a HARD constraint elsewhere,
      // not merely an ordering hint, so a bracket/stepladder stage's own
      // display-numbering round_no must not ride along as if it meant
      // round-robin order).
      ...(roundRobin.has(f.stage_id) ? { roundNo: f.round_no } : {}),
      ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
      divisionId: f.division_id,
      // C1 fix-loop (Finding 2). Unconditional, same as `divisionId` — see
      // `SchedulableFixture.stageId`'s own doc comment in `calendar.ts` for
      // why `build.ts`'s contamination guard needs it.
      stageId: f.stage_id,
      ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
      ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
      people: peopleOf(f, people),
      ...(pinnedIds.has(f.id)
        ? { locked: { court: f.court_id as string, startAt: ms(f.scheduled_at as string | Date) } }
        : {}),
      // #622 — omitted, never `[]`, when this fixture is not narrowed: an
      // empty array reads as UNCONSTRAINED everywhere downstream (the wire,
      // `slotFixtures`, `allowedCourtsFor`), so sending one would be
      // indistinguishable from the un-narrowed case anyway and would only
      // make the difference harder to see in a test snapshot.
      ...(narrowedCourtsFor(f.id) !== undefined
        ? { allowedCourts: narrowedCourtsFor(f.id) as readonly string[] }
        : {}),
    }));

    // ONE config for both halves of this pass (#447). The placer reads the
    // `SlotConfig` side, the typed-rule referee below reads the `VerifyConfig`
    // side, and neither can drift onto a different idea of the rules.
    // #462: the siblings' rule identity rides along with their court time. The
    // placer's day tally and the referee below both count only the `existing`
    // rows `ruleFixtures` names, so without this the auto pass proposes a board
    // that breaches a competition-scoped cap and then reports it clean.
    const board = [...obstacles, ...siblings.assignments];

    // Where the movable cards sit RIGHT NOW. REFLOW proposes from this rather
    // than from nothing, so it is split by whether this run may move the card.
    const placedNow = movable
      .filter((f) => !pinnedIds.has(f.id) && f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    const pinnedNow = movable
      .filter((f) => pinnedIds.has(f.id))
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));

    const declaredConfig = toVerifyConfig(
      settingsForEngine,
      all,
      roundToMinute(Date.now()),
      siblings.ruleFixtures,
      courtCalendars,
      strandedCourtIds,
    );
    const windowedConfig = boundSolverWindow(
      declaredConfig,
      schedulable,
      board,
      // REFLOW alone proposes cards that are already placed, so REFLOW alone
      // needs the window widened to contain them. Passing them on a BUILD
      // would stretch the lattice around a board that pass is about to
      // replace.
      body.mode === "reflow" ? [...placedNow, ...pinnedNow] : [],
      // The SAME feeds `buildSchedule` is handed below, so the window this
      // measures can actually fit a dependent after its feeders.
      feedDependencies(all),
    );
    // BUILD, with an organiser-set end date, only. POLISH and REFLOW are
    // contracts about NOT moving a card that doesn't need moving (R20/#452) —
    // a default the organiser never asked for would fight that on any board
    // that already exists across days one way, forcing churn to satisfy a cap
    // nobody set. A fresh BUILD has no existing board to disturb, which is
    // exactly the reported bug's shape — but only when `declaredConfig.window`
    // is finite, i.e. `endAt` was actually set: `boundSolverWindow` fills in
    // an UNFINISHED window from wherever the greedy seed's fixtures happened
    // to land, and that derived span is not a date range the organiser
    // configured, so a board with no end date at all must not get a cap it
    // never asked for either.
    const hasExplicitRange = declaredConfig.window !== undefined && Number.isFinite(declaredConfig.window.to);
    const config =
      body.mode === "build" && hasExplicitRange
        ? withDefaultDaySpread(windowedConfig, stage.division_id, schedulable.length)
        : windowedConfig;

    return {
      schedulable,
      config,
      // D2 capacity guard reads THIS, not `config` or even `windowedConfig`:
      // both carry SOLVER-CONVENIENCE machinery the organiser never
      // configured. `withDefaultDaySpread`'s injected max_fixtures_per_day
      // is a makespan-distribution NUDGE the solver/greedy already treat as
      // best-effort (a breach reports as a CAP conflict, never a refusal —
      // honoring it as a hard arithmetic bound is the placer/verifier fork
      // this codebase keeps naming as its recurring defect). And
      // `boundSolverWindow` FILLS IN a finite window from wherever the
      // greedy seed's fixtures happen to land when the organiser set no
      // `endAt` at all (its own doc comment, a few lines below) — feeding
      // THAT synthetic span into a precheck would refuse boards an
      // organiser never gave an end date to assess against in the first
      // place. `declaredConfig` is the one config built directly from
      // `settings.config` with neither adjustment — exactly what the
      // organiser configured, still carrying every rule they actually set
      // (constraints.hard from the Constraints tab).
      capacityConfig: declaredConfig,
      // P9 pass 2b: the NO_MATCHING_COURT guard (phase 2, no db connection
      // held) reads `capacityConfig.courts.length` — declaredConfig's, the
      // same "read declaredConfig, never windowedConfig/config" discipline
      // guardCapacity's own call site already established just below — and
      // needs the tags that produced it for the error payload, which is not
      // otherwise derivable once the transaction has closed.
      requiredCourtTags,
      courtNames,
      board,
      divisionId: stage.division_id,
      orgTz: settings.orgTz,
      // Over `all`, not over `movable`: `feedDependencies` keeps only edges whose
      // BOTH ends are in the list it is given, and a semi already decided (so not
      // movable) still constrains the final it feeds. The same argument every
      // other surface passes — `applySchedule`, the move gate and the board
      // report all call `feedDependencies(all)`.
      dependencies: feedDependencies(all),
      placedNow,
      pinnedNow,
      // Literally `pinnedIds`, not a second computation of it — see the
      // comment on `pinnedIds` above. POLISH's freeze set and the anchor the
      // solver sees must never be able to name a different set of fixtures.
      frozen: [...pinnedIds],
      total: schedulable.length,
    };
  });

  // ---- Phase 2: solve. Nothing below here holds a database connection.
  //
  // Three modes, ONE config (design D2), and — since C4 (2026-08-14, z3
  // retirement stage A) — ONE solver behind all three: `buildSchedule`, the
  // placement CP-SAT service. BUILD and POLISH call it directly, below.
  // REFLOW calls it through `reflowExisting`, which is not a thin wrapper:
  // `buildSchedule` has no "fewest cards moved" term of its own the way
  // z3's old ascending-k repair walk did, so `reflowExisting` freezes every
  // already-placed card (locked or not) via the same `frozen`/`current`
  // mechanism POLISH uses (R20) to keep that property without one — see
  // `reflowExisting`'s own doc comment for the full rationale, the accepted
  // trade-off, and the reconciliation this makes necessary.
  const { schedulable, config, board, dependencies, total } = plan;
  // P9 pass 2b: an empty candidate court set makes the solve unwinnable
  // before it starts — checked FIRST, ahead of capacity, because "no court
  // matches your tags" is a more specific, more actionable refusal than the
  // capacity guard would derive from a zero-court config on its own. Reads
  // `capacityConfig.courts` (declaredConfig, already the FILTERED set —
  // phase 1 fed it through `resolveCandidateCourts` before building
  // `declaredConfig`), the same "read declaredConfig" discipline
  // `guardCapacity` just below follows for the identical reason.
  guardNoMatchingCourt(plan.capacityConfig.courts, {
    requiredTags: plan.requiredCourtTags,
    divisionId: plan.divisionId,
    stageId,
  });
  // #622 review: the stage-wide guard above cannot see a round-scoped tag
  // that narrows a SINGLE fixture's own candidate set to empty while the
  // stage-wide set stays non-empty (other rounds still have candidates) —
  // see `guardNoMatchingCourtPerFixture`'s own doc comment.
  guardNoMatchingCourtPerFixture(schedulable, {
    requiredTags: plan.requiredCourtTags,
    divisionId: plan.divisionId,
    stageId,
  });
  // P9.5, edge matrix row 3: the same refusal one constraint over. If every
  // candidate court is CLOSED for the whole run — hours that miss the session
  // window, or a closed exception on the only day — the lattice would be empty
  // and the solver would answer "infeasible", which tells an organiser nothing
  // about the court calendar they just edited. Placed here, after the tag
  // guards and before capacity, for the same reason the tag guard sits ahead of
  // capacity: "no court is open then" is more specific and more actionable than
  // anything the capacity arithmetic would derive from an empty supply.
  //
  // Reads `plan.config`, which already carries the loaded calendars and the org
  // zone — the same object the placer and the verifier read, so the guard
  // cannot refuse a run the lattice would have allowed.
  //
  // BUILD ONLY. A reflow or polish already HAS a board, and its window is
  // widened to contain those cards — so an organiser who narrows the sole
  // court's hours to Mon-Fri under a Saturday board would make every candidate
  // court closed across that range and get a hard 422 with no
  // `acknowledge_warnings` route out and no edit that fixes it. That is exactly
  // the case `outside_court_hours` is carved out of `isBlockingConflict` to
  // keep advisory (calendar.ts, and conflict-detail.ts's header says so in as
  // many words), and this guard would have overridden that promise from the
  // other side. The empty-lattice argument only applies to a FRESH solve,
  // which is what `mode: "build"` is.
  if (body.mode === "build") {
    const cfg = plan.config;
    const span = cfg.window ?? { from: cfg.startAt, to: cfg.startAt };
    // `applyWindow` yields -Infinity/Infinity for an unbounded window, and
    // `dayKeyInTz(Infinity)` THROWS. An unbounded run also has no finite set of
    // days to prove closed, so there is nothing here to refuse.
    if (cfg.tz !== undefined && Number.isFinite(span.from) && Number.isFinite(span.to)) {
      guardNoUsableCourtWindows(
        cfg.courts,
        cfg.courtCalendars ?? [],
        { from: dayKeyInTz(span.from, cfg.tz), to: dayKeyInTz(span.to, cfg.tz) },
        { tz: cfg.tz, sessionWindows: cfg.sessionWindows, blackouts: cfg.blackouts },
        { divisionId: plan.divisionId },
      );
    }
  }
  // D2 capacity pre-check: arithmetic-provable impossibility refuses with a
  // typed 422 BEFORE either solver is reached — no db connection is held
  // here (phase 1 already closed), so this costs nothing a real solve
  // wouldn't have paid anyway. `guardCapacity` returns null and does
  // nothing when the config has no bounded window to assess.
  guardCapacity(capacityInputForFixtures(schedulable, plan.capacityConfig, plan.divisionId), {
    scope: "stage",
    divisionId: plan.divisionId,
    stageId,
  });
  /**
   * The organiser's board as it stands — every movable card that currently has a
   * time, whether or not this run may move it.
   *
   * POLISH ONLY, and that is the whole of ruling R20. `BuildInput.current` does
   * two things the engine cannot do for itself: it is the baseline `moved` and
   * `lost` are measured against, and it is where a `frozen` id with no `locked`
   * anchor gets pinned. Without it POLISH measured its churn against a board
   * greedy invented during the run — so a pass that relocated every card
   * reported "nothing moved" — and froze published cards onto slots nobody had
   * ever seen, which is the exact opposite of the mode's purpose.
   *
   * NOT sent on BUILD. A fresh full pass is not a rearrangement of anything, and
   * anchoring its churn to a board it was asked to replace would report every
   * card as moved by definition.
   *
   * EMPTY MEANS NO BOARD, and the array is withheld rather than sent empty. The
   * engine draws the same line (`input.current.length > 0 ? … : undefined`), so
   * this is belt-and-braces on today's engine rather than an independently
   * observable guard — kept because the alternative reading of `[]` is "every
   * card moved and every card was lost" on a stage nobody has ever scheduled,
   * and that is too sharp an edge to leave to one package's internals.
   */
  const currentBoard = [...plan.placedNow, ...plan.pinnedNow];
  /**
   * The solvers are called DIRECTLY. Nothing wraps them here, and the absence is
   * deliberate (R17).
   *
   * HOW THIS WAS LEARNT (history — z3 and its lock were deleted in C8, so
   * none of the machinery named here still exists). A `withZ3Teardown` helper
   * once wrapped this call with a `finally { await resetZ3() }` to hand the
   * WASM heap back. It was redundant — the engine already freed the heap
   * inside its own lock, which is where it had to happen for the bound to be
   * per solve rather than per burst — and it was actively harmful:
   *
   *   * that lock was a strict FIFO promise chain and `resetZ3` took it, so
   *     the no-op reset queued BEHIND every solve already waiting. Three
   *     concurrent clicks: the first solve finished at ~8s and its HTTP response
   *     landed at ~24s.
   *   * it defeated the queue cap outright. `buildSchedule` answers
   *     `solver_busy` with a greedy board WITHOUT reaching the solver, precisely
   *     so the third caller need not wait — and this `finally` made that
   *     immediate answer wait out two full budgets anyway.
   *
   * WHAT STILL APPLIES. There is no heap to tear down any more, but the second
   * bullet survives the solver that produced it: a solve is now an
   * out-of-process RPC carrying `autoSolverWallMs()`, so anything added at this
   * seam that awaits it — a wrapper, a limiter, an admission check moved below
   * the call — puts a refusal that costs nothing behind an answer that costs
   * tens of seconds. Pinned by `schedule-auto-solver-busy-latency.test.ts`,
   * which stages the contention by holding the placement client open (it used
   * to hold the z3 lock; C8 deleted that and the test with it, and this
   * restores the fact at the seam that replaced it).
   */
  const out: BuildResult | ReflowResult = await (body.mode === "reflow"
    ? // Pinned cards are handed separately from the rest: the solver may not
      // move them, but they are still part of the proposal it hands back.
      reflowExisting({
        schedulable,
        config,
        board,
        dependencies,
        placed: plan.placedNow,
        pinned: plan.pinnedNow,
      })
    : buildSchedule({
        fixtures: schedulable,
        config,
        existing: board,
        dependencies,
        wallMs: autoSolverWallMs(),
        ...(body.mode === "polish"
          ? {
              frozen: plan.frozen,
              ...(currentBoard.length > 0 ? { current: currentBoard } : {}),
            }
          : {}),
      }));

  /**
   * REFLOW's first-time-placement count, absent on the two modes that cannot
   * distinguish one. Read out here rather than through an `in` narrowing at the
   * spread below, where `ReflowResult` being assignable to `BuildResult` makes
   * the narrowed property `unknown`.
   *
   * ANNOTATED, and the `typeof` guard is not decoration: hoisting the `in` out
   * of the spread moved the problem rather than solving it. `in` on a type
   * that does not declare the key narrows the property to `{} | null`, which is
   * not assignable to `ScheduleSolverInfo["seeded"]` — and the object literal
   * below reports only its FIRST incompatible property, so for as long as
   * `status` was also wrong this error was invisible.
   */
  const seeded: number | undefined =
    "seeded" in out && typeof out.seeded === "number" ? out.seeded : undefined;

  // ---- Phase 3: map. Pure (courtNames was resolved in phase 1).
  return {
    assignments: out.assignments.map((a) => ({
      fixture_id: a.fixtureId,
      scheduled_at: iso(a.startAt),
      ends_at: iso(a.endAt),
      court_id: a.court,
      court_name: plan.courtNames.get(a.court) ?? null,
    })),
    // No baseline: the auto pass PROPOSES a board rather than editing one, so
    // every conflict in it is this proposal's own doing (#399).
    //
    // WIDER THAN IT USED TO BE, deliberately. This pass previously reported only
    // what the placer could not fit (`no_slot`, `start_window`, a pinned
    // collision) plus the typed-rule referee; it now also carries the FULL
    // verifier's rows, because `buildSchedule` and `reflowExisting` both run
    // `validateAssignments` over the board they produce. So rest and overlap
    // rows the auto pass never emitted can now appear.
    //
    // That is the point of the programme — a board that breaches a rule should
    // say so on the surface the organiser builds it from — but it has a sharp
    // edge worth naming: REFLOW is the DEFAULT mode, and on `timeout` or
    // `infeasible` it hands back the organiser's ORIGINAL board and verifies
    // THAT. A board they have been living with can therefore come back carrying
    // blocking rows they have never been shown before. Pinned exactly, board and
    // row for row, by `schedule-reflow-verifier-widening.test.ts`.
    //
    // `validateInstructionRules` derives its own rule stream and shares no row
    // with `validateAssignments` (which reads only the `min_rest_minutes`
    // subset, and only to raise a pair's bound), so the two lists concatenate
    // without double-reporting.
    conflicts: mapConflicts(
      [...out.conflicts, ...validateInstructionRules(out.assignments, config, board)],
      plan.courtNames,
    ),
    metrics: {
      makespan_minutes: out.metrics.makespanMinutes,
      worst_idle_gap_minutes: out.metrics.worstIdleGapMinutes,
      court_imbalance_minutes: out.metrics.courtImbalanceMinutes,
      placed: out.metrics.placed,
      total,
    },
    solver: {
      engine: out.engine,
      status: out.status,
      // Forwarded, never synthesised, and only ever present alongside
      // `status: "not_searched"` — see `ScheduleSolverInfo.not_searched_reason`.
      // `BuildResult` sets it on all six of `not_searched`'s exits; REFLOW's
      // `settle()` never reports `not_searched` at all, so this stays absent on
      // every REFLOW result, exactly like every other BUILD-only field here.
      ...(out.notSearchedReason !== undefined
        ? { not_searched_reason: out.notSearchedReason }
        : {}),
      // The mode the CALLER asked for, not a property of the result. `engine`
      // names what produced the board and cannot stand in for it: an expired
      // REFLOW and a BUILD that ran out before its first tier are both
      // `greedy` / `budget_expired` / `tiersCompleted: 0` / `tiers_total: 4`,
      // and only one of them was ever on a tier ladder.
      mode: body.mode,
      tiers_completed: out.tiersCompleted,
      tiers_total: TIERS_TOTAL,
      budget_expired: out.budgetExpired,
      elapsed_ms: out.elapsedMs,
      moved: out.moved,
      // Relocations and losses are separate counts since R21. Forwarded on every
      // mode: it is 0 wherever the run had no baseline to lose from, and that 0
      // is a fact rather than a placeholder.
      lost: out.lost,
      // REFLOW only — the one path that can tell a first-time placement from a
      // relocation. BUILD and POLISH re-place everything by definition, so the
      // distinction does not arise and the field stays off the payload.
      ...(seeded !== undefined ? { seeded } : {}),
      // Forwarded, never synthesised: absence on an `infeasible` result is
      // the engine SAYING the proof is about the board rather than the pins.
      ...(out.contradictoryPins !== undefined
        ? { contradictory_pins: [...out.contradictoryPins] }
        : {}),
      // `plan.frozen` IS `pinnedIds` (see `lockedFixtureIds`) — its length is
      // exactly the count of this stage's own fixtures held fixed by a lock
      // this run, on every mode, always present so a client never needs a
      // null check to render "N fixtures are locked and will be kept".
      locked_kept: plan.frozen.length,
    },
  };
}

/** How much room past the work the solver is given to rearrange inside, when the
 *  competition itself sets no end date. A day, not a year — and the size is
 *  MEASURED, not a taste: see `boundSolverWindow`. */
const SOLVER_SLACK_MS = 24 * 60 * MS_PER_MIN;

/**
 * The wall the auto pass gives a solver, overriding the engine's 30-second
 * default.
 *
 * `autoSchedule` is a SYNCHRONOUS request an organiser is watching, so the
 * engine's own cap is the wrong one here: measured on a 15-fixture, 2-court
 * board it is spent in full, every time, and hands back a 30-second HTTP
 * response for a board that stopped improving long before.
 *
 * 8 seconds is where a 15-fixture, 2-court board's measurements level off —
 * 2s and 5s differ (court imbalance 90 -> 30 minutes), 5s and 10s do not, and
 * small boards finish and prove themselves optimal in well under a second
 * regardless. THAT BOARD IS NOT REPRESENTATIVE. Re-measured on a 40-80 fixture,
 * 4-5 court board (`packages/engine/scripts/bench-build.ts --sizes=40,60,80
 * --per-entrant=2 --wall=8000` vs `--wall=20000`): 40 plateaus by 8s same as
 * before, but 60 keeps improving (makespan 1760->1600 at 8s, ->1480 at 20s,
 * idle only catches up at 20s) and 80 does not even reach a z3 result at 8s
 * (falls straight to greedy) while 20s gets one improved board. 20 seconds is
 * where THIS range levels off — re-run the sweep before moving it again.
 *
 * That sweep was z3's, and it is not re-runnable as written: BUILD solves
 * through the placement service now, and `bench-build.ts` was deleted with the
 * z3 tier encoder in `82553ec3`. The numbers above stand as the record that set
 * this constant; moving it means rebuilding the sweep against CP-SAT first.
 *
 * AND MOVING IT MOVES SOMETHING ELSE. `canSolveWithin` scales the R18 size
 * gate by `wallMs / 8_000`, and this wall is what the web layer passes, so
 * changing it silently re-tunes which boards reach the solver at all. #589.
 *
 * Expiring is ORDINARY, not a failure: `budget_expired` rides the wire and the
 * result strip says how many improvement targets the run got through. What is
 * NOT ordinary is reading the flag as "not optimal" — optimality is
 * `tiers_completed === tiers_total`; a term or metric drift exits a tier without
 * ever setting it.
 *
 * Task 13's bench sets the DETERMINISTIC budget (`rlimit`); this is only the
 * outer safety cap, and should be revisited once that lands.
 *
 * CONFIGURABLE AT RUNTIME, via `PLACEMENT_WALL_SECONDS` (seconds, to match the
 * service's own units). This is the caller's ASK. The service applies its own
 * independent CEILING, `PLACEMENT_WALL_SECONDS_MAX`, as a `min()` — so the wall
 * a board actually gets is the smaller of the two, and RAISING EITHER ONE ALONE
 * CHANGES NOTHING. Both, or no board's budget moves.
 *
 * Read per call rather than captured at module load: the value must come from
 * the running process's environment, so a `fly secrets set` takes effect on
 * restart without a rebuild. A module-scope read risks being evaluated during
 * the build instead, which would bake the wrong number in silently.
 */
const DEFAULT_AUTO_SOLVER_WALL_SECONDS = 10;

export function autoSolverWallMs(): number {
  const raw = process.env.PLACEMENT_WALL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUTO_SOLVER_WALL_SECONDS * 1_000;
  const seconds = Number(raw);
  // Refused, not defaulted, and deliberately: the failure this guards is a
  // typo'd env var that leaves every board silently running the old wall while
  // the operator believes they changed it. `config.py` refuses the same way on
  // its side of the wire. A loud failure on the one surface that reads this is
  // cheaper than a plausible, stable, wrong answer.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `PLACEMENT_WALL_SECONDS must be a finite number > 0, got ${JSON.stringify(raw)}. It is the ` +
        `solve budget in seconds asked of the placement service.`,
    );
  }
  return Math.round(seconds * 1_000);
}

/**
 * The per-ORG cooldown on the auto pass. Ten runs per five minutes.
 *
 * WHY PER-ORG AND NOT GLOBAL. The resource being protected is a SHARED,
 * capacity-constrained one: every solve (BUILD/POLISH directly, REFLOW
 * through `reflowExisting` — none of the three calls z3 for scheduling any
 * more, since C4, 2026-08-14) is a remote call to the placement service,
 * which admits only a small, fixed number of concurrent solves
 * (`PLACEMENT_MAX_WORKERS` on the service side — see `services/placement/
 * fly.toml`; this comment predates that cutover and its "one at a time via
 * `withZ3Lock`" framing is no longer literally accurate, but the underlying
 * shape — a small shared ceiling, not unlimited parallelism — still holds,
 * which is why the numbers below have not been revisited). The failure mode
 * is therefore one org monopolising a queue everybody shares, not aggregate
 * load — and a global limiter would punish precisely the tenants being
 * starved. The key is the org.
 *
 * WHERE THE NUMBERS COME FROM. Ten runs x `AUTO_SOLVER_WALL_MS` is bounded to
 * ~27% of an instance's solver capacity, whatever the wall is currently set
 * to — `max` stays 10 (the UX reason below is about button-presses, not
 * capacity, and does not move with the wall) and `windowSeconds` is re-derived
 * to hold the ratio: `10 * wallMs / 0.2667`. At `wallMs = 20_000` that is
 * 10 * 20 / 0.2667 = 750s (12.5 min). One org can never take more than ~27% of
 * an instance's solver capacity however hard it is driven — while a human
 * organiser iterating on a board is never blocked, because ten is enough to
 * try all three buttons (Auto / Re-flow / Polish) three times over with a
 * settings change between each. Anyone clicking faster than one run per 75
 * seconds sustained is not reading the results.
 *
 * `max` IS POLICY and is here to be moved. `windowSeconds` no longer is — it is
 * computed from the wall below, because the wall became an env var and a
 * hand-re-derived constant cannot track a value an operator can change without
 * touching this file.
 *
 * FAIL-OPEN, deliberately, and matching every other limiter on this surface
 * (`ai-plan` 5/hr, `ai-plan-competition` 3/hr, `ai-officials` 5/hr). A Redis
 * outage must not delete the feature for every tenant at once, and the queue cap
 * (`MAX_SOLVER_QUEUE`) still bounds what a burst can occupy while it is down.
 * Note this also makes the limiter INERT with no REDIS_URL — local dev, e2e and
 * the test suite — so it is a production control, and any test of it has to mock
 * `incrWindow` to make it real (`schedule-auto-cooldown.test.ts` does).
 *
 * IT MUST NOT SLOW THE FAST REFUSAL. `buildSchedule` answers `solver_busy` with
 * a greedy board WITHOUT taking the z3 lock once two solves are in flight,
 * precisely so the third caller need not wait out two full budgets — a
 * `withZ3Teardown` wrapper destroyed that property earlier in this wave and was
 * deleted for it. This limiter is one Redis INCR ahead of everything, on no
 * lock and no queue, so the refusal path is unchanged; pinned by
 * `schedule-auto-solver-busy-latency.test.ts`, which now runs with the limiter
 * live for exactly that reason.
 */
/** Ten runs. A UX number about button-presses, and it does NOT move with the
 *  wall — see the block above. */
const AUTO_SCHEDULE_COOLDOWN_MAX = 10;

/** The share of one instance's solver capacity a single org may occupy, ~27%.
 *  THIS is the invariant being held; `windowSeconds` is merely what holds it at
 *  the current wall. */
const AUTO_SCHEDULE_ORG_CAPACITY_SHARE = 0.2667;

/**
 * DERIVED, not a literal, now that the wall is an env var.
 *
 * It was `375` hardcoded, with a comment instructing whoever moved the wall to
 * re-derive it by hand. That instruction was correct and had already been
 * missed once — it sat at 750 (right for a 20 s wall) against a 10 s wall.
 * A hand-maintained constant cannot survive a value that an operator can now
 * change with `fly secrets set` and no code review at all: raising
 * `PLACEMENT_WALL_SECONDS` to 20 while this stayed 375 would silently double
 * one org's share of solver capacity, which is the exact ratio it exists to
 * hold. So it is computed instead. At the default 10 s wall this is
 * `10 * 10 / 0.2667 = 375`, byte-for-byte the value it replaces.
 */
export function autoScheduleCooldown(): RateLimitConfig {
  const wallSeconds = autoSolverWallMs() / 1_000;
  return {
    max: AUTO_SCHEDULE_COOLDOWN_MAX,
    windowSeconds: Math.round(
      (AUTO_SCHEDULE_COOLDOWN_MAX * wallSeconds) / AUTO_SCHEDULE_ORG_CAPACITY_SHARE,
    ),
  };
}

/**
 * A FINITE search window, replacing an open-ended one.
 *
 * IT REPLACES A BOUND THE VERIFIER ALSO READS — this is not a solver-only knob,
 * and pretending otherwise is how `mustContain` came to be needed. The returned
 * config is the SAME object handed to `validateAssignments` and
 * `validateInstructionRules`, so narrowing `window` narrows what counts as a
 * `window` conflict too. The clamp is therefore built to be wider than anything
 * the run can legally produce, never tighter, and every bound below is chosen on
 * that basis.
 *
 * `applyWindow` answers an open-ended competition with `±Infinity`, and for the
 * verifier that is exactly right — a bound nothing can breach enforces nothing.
 * The SOLVERS cannot take it: `buildGrid` derives its day buckets from this
 * window through `calendarDaysCovering`, and `dayKeyInTz(Infinity)` throws
 * `RangeError: Invalid time value`. A division with a start date and no end date
 * is the ordinary case, so unclamped the whole auto pass 500s on it.
 *
 * Two bounds that are NOT interchangeable:
 *
 *   * the open end is clamped to the WORK — the greedy board proves how much
 *     time these fixtures actually need, and the solver gets that plus
 *     `SOLVER_SLACK_MS` (one day) to rearrange inside. Wider is not free and not
 *     neutral: the lattice is capped
 *     at `MAX_SLOTS`, and `buildGrid` answers an overflow by returning NOTHING,
 *     which drops `buildSchedule` straight back onto the greedy board it was
 *     asked to improve. A 365-day horizon over two courts is ~35k slots — the
 *     solver would be silently inert on exactly the configs it exists for.
 *   * the open START is clamped to `config.startAt`, or to a pinned card if one
 *     sits earlier. A pin is admitted to the lattice unconditionally, so a
 *     window that excluded it would hand back a `window` conflict on a card
 *     nobody asked to move.
 *
 * A window with two finite bounds is returned untouched: the competition's own
 * dates are the answer whenever it has them.
 */
export function boundSolverWindow<T extends SlotConfig & VerifyConfig>(
  config: T,
  fixtures: readonly SchedulableFixture[],
  existing: readonly Assignment[],
  /**
   * Cards that will be IN the proposal already placed — REFLOW's incumbent
   * board. They must be inside the window even though nothing asked to move
   * them: `validateAssignments` bounds `assignments` and not `existing`, so a
   * card the organiser parked three days out would otherwise come back with a
   * BLOCKING `window` conflict the moment the clamp closed in front of it.
   * Empty for BUILD and POLISH, which propose from scratch.
   */
  mustContain: readonly Assignment[] = [],
  /** Bracket feeds, forwarded to the measuring greedy pass. Without them that
   *  pass places a dependent at the SAME instant as its feeders, so the span it
   *  measures is too short and the window handed to the solver cannot fit the
   *  dependent after them — the second route to the "2 of 3 placed" bug the
   *  ordering fix in `slotFixtures` closes. Optional: every pre-existing caller
   *  measures exactly as it did. */
  dependencies: readonly OrderDependency[] = [],
): T {
  const w = config.window;
  if (w !== undefined && Number.isFinite(w.from) && Number.isFinite(w.to)) return config;

  const pins = fixtures.flatMap((f) => (f.locked !== undefined ? [f.locked.startAt] : []));
  const from =
    w !== undefined && Number.isFinite(w.from)
      ? w.from
      : Math.min(config.startAt, ...pins, ...mustContain.map((a) => a.startAt));
  // MEASURED, not invented: the greedy pass is the same one `buildSchedule`
  // runs first, so this is the span the fixtures demonstrably occupy.
  const seed = slotFixtures({ fixtures, config, existing, dependencies });
  const to =
    w !== undefined && Number.isFinite(w.to)
      ? w.to
      : Math.max(
          from,
          ...seed.assignments.map((a) => a.endAt),
          ...pins.map((t) => t + config.matchMinutes * MS_PER_MIN),
          ...mustContain.map((a) => a.endAt),
        ) + SOLVER_SLACK_MS;
  return { ...config, window: { from, to } };
}

/**
 * The auto pass's default `max_fixtures_per_day`, applied only when the
 * organiser set none of their own for this division — and, at its one call
 * site, only for BUILD. POLISH and REFLOW exist specifically to NOT move a
 * card that doesn't need moving (R20 / #452); a default the organiser never
 * asked for would fight that on any board that already exists spread one way
 * across days, forcing churn to satisfy a cap nobody set. BUILD has no
 * existing board to disturb, which is exactly the reported bug's shape.
 *
 * The solver's own objective has nothing that spreads a board across a
 * multi-day window, and the 2026-08-13 day-aware rungs made that MORE true,
 * not less. It used to be that T1 minimised `makespanMinutes`, which pulled
 * every fixture toward the earliest reachable day; T1 is now
 * `days → day_span → day_start`, and its FIRST rung minimises the count of
 * calendar days used, which pulls in the same direction harder. Either way a
 * wide window and a tight one behave identically without a day cap forcing
 * the difference: a seven-day window and a one-day window both pile every
 * match onto day one.
 *
 * `max_fixtures_per_day` is the one hard rule that already does this, fully
 * wired end to end (`build-encode.ts` groups by `dayKeyInTz` and encodes an
 * `AtMost` per day) — an organiser can already set it through the AI parser
 * or the constraints panel. This only fills the gap for a run that set
 * neither: `ceil(fixtures / availableDays)` spreads them roughly evenly
 * across the window's own dates instead of leaving day two onward empty by
 * default. An explicit whole-division rule from either surface always wins
 * untouched — this never overwrites one.
 */
export function withDefaultDaySpread<T extends SlotConfig & VerifyConfig>(
  config: T,
  divisionId: string,
  fixtureCount: number,
): T {
  const existingHard = config.constraints?.hard ?? [];
  const hasExplicitCap = existingHard.some(
    (h) => h.type === "max_fixtures_per_day" && h.scope.kind === "division" && h.scope.divisionId === divisionId,
  );
  if (hasExplicitCap || fixtureCount <= 0 || config.window === undefined || config.tz === undefined) return config;

  // Same padded-by-one-day-at-each-end shape `build-grid.ts` and `repair.ts`
  // already rely on (`calendarDaysCovering`'s own doc comment) — undo the pad
  // rather than reimplement day counting a third way.
  const days = calendarDaysCovering(config.window, config.tz).length - 2;
  if (days <= 1) return config;

  const hard: HardConstraint[] = [
    ...existingHard,
    {
      type: "max_fixtures_per_day",
      count: Math.max(1, Math.ceil(fixtureCount / days)),
      scope: { kind: "division", divisionId },
    },
  ];
  return {
    ...config,
    constraints: {
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      ...config.constraints,
      hard,
    },
  };
}

/**
 * Fixtures the caller may not move this run: `schedule_locked`, or caught by
 * a `scopeLocked` scope lock, and currently placed (`scheduled_at` AND
 * `court_id` both set — a lock with nothing to anchor to has nothing to
 * pin). THE ONE PREDICATE, per ruling R5 for what a "frozen" card is: there
 * is no per-fixture published flag, so "the cards an entrant has already
 * been told about" is approximated by the cards the organiser pinned.
 *
 * SHARED, not duplicated. `pinnedIds` (the anchor the solver sees, every
 * mode) and `frozen` (POLISH's freeze set) used to be two hand-maintained
 * copies of this exact test — see the comment on `pinnedIds` above for how
 * they had already diverged (#pins-in-build). They are now the SAME `Set`,
 * built by one call to this function and reused, which also retires a
 * standing KNOWN GAP this function used to carry: `buildSchedule` anchors a
 * `frozen` id with no matching `locked` entry to greedy's own re-placement
 * rather than to where the card actually sits (`build.ts` Task 6/7). Because
 * `frozen` is now always a subset of `pinnedIds` by construction, every id it
 * names has a `locked` anchor too — that gap can no longer arise from this
 * call site.
 *
 * `ignoreLocks` (from `AutoScheduleRequest.ignore_locks`) is the one explicit
 * way to suppress every lock for this run. `only_unlocked` has no say over
 * this predicate at all — see `pinnedIds`.
 */
export function lockedFixtureIds(
  movable: readonly FixtureLite[],
  scopes: readonly LockedScope[],
  ignoreLocks: boolean,
): Set<string> {
  if (ignoreLocks) return new Set();
  return new Set(
    movable
      .filter(
        (f) =>
          (f.schedule_locked || scopeLocked(f, scopes)) &&
          f.scheduled_at !== null &&
          f.court_id !== null,
      )
      .map((f) => f.id),
  );
}

/**
 * REFLOW (C4, 2026-08-14 — z3 retirement stage A): routed through the same
 * placement CP-SAT service BUILD/POLISH already call, instead of z3's
 * ascending-k repair solver. `pinned` (schedule-locked) and `placed`
 * (already on the board, just not locked) are BOTH frozen for this solve —
 * the exact mechanism POLISH already uses (R20, `BuildInput.frozen` +
 * `current`, resolved by `publishedSlotOf` in `build.ts`) — because
 * `buildSchedule` has no "fewest cards moved" term of its own the way the
 * repair solver's ascending-k walk did; pinning every already-placed card is
 * what makes this mode keep that property without one. Owner's ruling on a
 * design gap this session found beyond the brief's literal "wiring" framing
 * — see the C4 status-log entry in
 * `docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md`.
 *
 * TRADE-OFF, explicitly accepted: REFLOW can no longer rearrange
 * already-placed UNLOCKED cards to resolve a conflict that exists AMONG
 * them — it can only place cards that have no slot yet, around everything
 * already placed. `repairSchedule` could do this (moving one of a colliding
 * pair); `buildSchedule` cannot, because neither `pinned` nor `placed` is
 * ever a free variable here. Proven non-crashing rather than assumed —
 * `schedule-reflow-cpsat.test.ts`'s two-card-collision case.
 *
 * RECONCILIATION BELOW IS NOT REDUNDANT PLUMBING, and that was measured, not
 * assumed. `buildSchedule`'s SUCCESS/`improved` exit anchors a `current`-only
 * frozen id correctly (its own `pinnedAssignments`), but every FALLBACK exit
 * — `already_optimal`, a proved tie, `verifier_rejected`, `not_searched` —
 * reports `seed.assignments`, the PLAIN unpinned greedy seed, which has no
 * idea a `current`-only id (no `.locked`) is supposed to stay put. Confirmed
 * empirically against unmodified `build.ts`: a two-fixture repro, both
 * `current`-anchored, mocked onto the `already_optimal` fallback, swapped
 * both fixtures' courts. That fallback is not a corner — it is the ORDINARY
 * shape of a reflow over a mostly-already-placed board (nothing to improve,
 * or the budget does not prove an improvement), so every frozen id's slot in
 * the board this function returns is read from `known` directly below,
 * never trusted off `buildSchedule`'s own `assignments`.
 */
/** A `BuildResult` plus the one fact only the REFLOW path is in a position to
 *  know: how many of `moved` were cards it placed for the first time rather than
 *  relocated. See `ScheduleSolverInfo.seeded` for why it is carried. */
type ReflowResult = BuildResult & { seeded: number };

async function reflowExisting(args: {
  schedulable: readonly SchedulableFixture[];
  /** Where the cards this run may move sit right now. */
  placed: readonly Assignment[];
  /** Cards this run may NOT move — obstacles to the solver, still part of the
   *  proposal it hands back. */
  pinned: readonly Assignment[];
  config: SlotConfig & VerifyConfig & { courts: string[] };
  board: readonly Assignment[];
  /** The division's direct feed edges — threaded to both `buildSchedule` and
   *  the fresh verifier pass below (see `AutoSchedulePlan.dependencies`). */
  dependencies: readonly OrderDependency[];
}): Promise<ReflowResult> {
  const startedAt = Date.now();
  const total = args.schedulable.length;
  /** Every card this run may not move, keyed by id — `placed` first so a
   *  fixture appearing in both (should never happen; `placed`/`pinned` are
   *  constructed as a partition upstream) resolves to its locked slot. */
  const known = new Map<string, Assignment>([
    ...args.placed.map((a) => [a.fixtureId, a] as const),
    ...args.pinned.map((a) => [a.fixtureId, a] as const),
  ]);
  const frozen = [...known.keys()];

  // A THIRD finding, beyond the reconciliation gap above: the placement
  // service's own wire contract refuses a request naming ZERO movable
  // fixtures ("fixtures must not be empty", `schema.py`) — silently, on a
  // validation branch that (unlike its siblings) carries no log call, so
  // this was found by reading the service's own source, not a log line.
  // Measured against the real service: `solveBuild` resolves (no
  // exception `buildSchedule`'s own catch would report) with
  // `status: "ERROR"`, which `buildSchedule` maps to `solver_unavailable`
  // — indistinguishable, from this caller's side, from a genuine outage.
  //
  // A reflow with nothing left to place — every schedulable fixture
  // already frozen — is the ORDINARY shape of "click Re-flow a second
  // time, nothing changed", not a corner, so `buildSchedule` must never
  // be asked in the first place here. Mirrors the OLD z3-repair path's
  // `clean, k=0` verdict for the identical shape: verify the untouched
  // board directly and hand it back.
  if (![...args.schedulable].some((f) => !known.has(f.id))) {
    const assignments = [...known.values()];
    return {
      assignments,
      conflicts: validateAssignments(assignments, args.config, args.board, args.dependencies),
      metrics: boardMetrics(assignments, args.config.courts, total),
      engine: "greedy",
      status: "ok",
      tiersCompleted: 0,
      budgetExpired: false,
      elapsedMs: Date.now() - startedAt,
      moved: 0,
      seeded: 0,
      rlimitSpent: 0,
      lnsWindowRlimits: [],
      lost: 0,
    };
  }

  const out = await buildSchedule({
    fixtures: args.schedulable,
    config: args.config,
    existing: args.board,
    dependencies: args.dependencies,
    wallMs: autoSolverWallMs(),
    frozen,
    // Empty means "no board" to `buildSchedule` (an empty array is NOT sent
    // as one) — mirrors the BUILD/POLISH call site's identical guard on
    // `currentBoard`, and matters here for the same reason: REFLOW's
    // ordinary case is a stage with nothing on it yet at all.
    ...(known.size > 0 ? { current: [...known.values()] } : {}),
  });

  // THE RECONCILIATION (see the doc comment above): every frozen id's slot
  // comes from `known`, never from `out.assignments`, regardless of which
  // exit produced them.
  const assignments = [
    ...out.assignments.filter((a) => !known.has(a.fixtureId)),
    ...known.values(),
  ];
  // Structured telemetry for the branch this session's finding is about: how
  // often the fallback actually NEEDED reconciling (not merely took the
  // fallback exit — the success path's own `pinnedAssignments` already
  // agrees with `known`, so this counts real corrections only). `log.warn`,
  // not `info`: a nonzero count means `buildSchedule`'s own board would have
  // silently relocated an already-placed card had this function trusted it.
  const outById = new Map(out.assignments.map((a) => [a.fixtureId, a] as const));
  const correctedCount = [...known.entries()].filter(([id, a]) => {
    const reported = outById.get(id);
    return reported === undefined || reported.court !== a.court || reported.startAt !== a.startAt;
  }).length;
  if (correctedCount > 0) {
    log.warn(
      { engine: out.engine, status: out.status, frozenCount: known.size, correctedCount },
      "schedule: reflow reconciled frozen cards back onto their known slots — buildSchedule's own board would have moved at least one",
    );
  }
  const presentIds = new Set(assignments.map((a) => a.fixtureId));
  const conflicts: Conflict[] = [
    ...validateAssignments(assignments, args.config, args.board, args.dependencies),
    // `validateAssignments` iterates the rows it is handed and cannot report
    // an ABSENCE, so a free fixture `buildSchedule` could not place needs
    // its diagnosis read off `out.conflicts` directly — the engine's own
    // `conflictsFor` machinery already does this better than a bare
    // `no_slot` could (greedy's diagnosis when there is one, a PROVEN
    // `no_slot` otherwise). Filtered to ids genuinely missing from the
    // RECONCILED board: a frozen id can be absent from `out.assignments` on
    // the fallback path above (its naive-seed placement disqualified for a
    // blocking conflict it would not have had at its real, reconciled slot)
    // without being absent here, and a stale row about it must not survive
    // reconciliation.
    ...out.conflicts.filter((c) => !presentIds.has(c.fixtureId)),
  ];

  // Every free (non-`known`) fixture that made it onto the board is a
  // first-time placement, by construction — `known` is exactly "already has
  // a slot", so its complement never did. It is now ALSO every relocation:
  // reconciliation above means a `known` id never moves, so `moved` and
  // `seeded` are always equal (a direct, testable consequence of the
  // churn-minimization ruling — see the sibling assertion in
  // `schedule-reflow-cpsat.test.ts`).
  const seeded = assignments.filter((a) => !known.has(a.fixtureId)).length;

  return {
    assignments,
    conflicts,
    metrics: boardMetrics(assignments, args.config.courts, total),
    // Forwarded, never re-derived — `out.engine` already says where the FREE
    // fixtures' placements came from: `"optimized"` on a genuine
    // improvement, `"greedy"` on every fallback, including "nothing needed
    // placing at all" (this mode's most common shape). Exactly how
    // BUILD/POLISH already report the same field.
    engine: out.engine,
    status: out.status,
    ...(out.notSearchedReason !== undefined ? { notSearchedReason: out.notSearchedReason } : {}),
    tiersCompleted: out.tiersCompleted,
    budgetExpired: out.budgetExpired,
    elapsedMs: Date.now() - startedAt,
    moved: seeded,
    seeded,
    rlimitSpent: out.rlimitSpent,
    lnsWindowRlimits: out.lnsWindowRlimits,
    // ALWAYS 0, and now BY CONSTRUCTION rather than by measurement: `known`
    // is unioned into `assignments` unconditionally above, so a `placed` or
    // `pinned` row can never be absent from the board this function
    // returns. Was a tripwire proven live by mocking a `repairSchedule` row
    // drop (`schedule-reflow-lost.test.ts`, retired with this change —
    // `repairSchedule` is not called on this path at all any more, so that
    // file's mock is inert; see the PR body for why deleting the guard is
    // safe rather than silent).
    lost: 0,
    ...(out.contradictoryPins !== undefined ? { contradictoryPins: out.contradictoryPins } : {}),
  };
}

const roundToMinute = (t: number): number => Math.ceil(t / MS_PER_MIN) * MS_PER_MIN;

// ---------------------------------------------------------------------------
// Apply (transactional persist — doc 12 §4)
// ---------------------------------------------------------------------------

export interface ApplyScheduleOut {
  applied: number;
  conflicts: ScheduleConflict[];
}

export async function applySchedule(
  auth: AuthCtx,
  stageId: string,
  input: ApplyScheduleRequest,
): Promise<ApplyScheduleOut> {
  // Manual assignment sets and pin changes are board editing. The gate stays,
  // but since V353 (#382) `scheduling.board` is granted on EVERY plan — an
  // organiser who could ask the AI for a schedule could not then drag one
  // fixture of it, which was backwards. The key is kept rather than deleted:
  // it is still what an entitlement override or a future tier moves.
  if (input.source === "manual" || input.assignments.some((a) => a.schedule_locked !== undefined)) {
    await requireFeature(auth.orgId, "scheduling.board");
  }
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const out = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    await assertFreshSeq(tx, stage.division_id, input.expected_seq);
    assertNotFrozen(frozen, stage.competition_id);

    const settings = await loadSettings(tx, stage.division_id);
    const all = await divisionFixtures(tx, stage.division_id);
    // P9 pass 3a — resolved once, used by the conflict mapping below.
    const courtNames = await courtNamesById(tx);
    // #5 fix — resolved once, used to DERIVE venue_id from each assignment's
    // court_id below (never trusted from the client's own a.venue_id).
    const courtVenues = await courtVenueIds(tx);
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    // C1 (2026-08-12 round-order design). This IS the write gate — the one
    // place a disordered board actually gets refused rather than merely
    // proposed — so round order has to be judged here, not only on the
    // auto-schedule preview. See `toAssignment`'s own doc comment.
    const roundRobin = await roundRobinStageIds(tx, stage.division_id);
    const byId = new Map(all.map((f) => [f.id, f]));
    for (const a of input.assignments) {
      const f = byId.get(a.fixture_id);
      if (!f || f.stage_id !== stageId) {
        throw new HttpError(422, `fixture ${a.fixture_id} is not part of this stage`);
      }
      if (f.status !== MOVABLE_STATUS) {
        throw new HttpError(422, `fixture ${a.fixture_id} is ${f.status} — decided fixtures are immutable`);
      }
      if (scopeLocked(f, lockState.scopes)) {
        throw new HttpError(422, `fixture ${a.fixture_id} is inside a locked scope`);
      }
    }

    const entrantIds = [
      ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
    ].filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, entrantIds);

    const proposed: Assignment[] = input.assignments.map((a) => {
      const f = byId.get(a.fixture_id) as FixtureLite;
      const start = ms(a.scheduled_at);
      return {
        fixtureId: a.fixture_id,
        court: a.court_id,
        startAt: start,
        endAt: start + settings.config.matchMinutes * MS_PER_MIN,
        entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
        people: peopleOf(f, people),
        // #446: the proposed card's own group identity, so a pool- or
        // division-targeted rule is applied to the placement being judged and
        // not only to the board it lands on. Same shape as `toAssignment`.
        ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
        divisionId: f.division_id,
        // C1 fix-loop (Finding 2): unconditional, same as `divisionId` just
        // above — `divisionFixtures` (below) is DIVISION-WIDE, so `all`, and
        // therefore `proposed`/`currentSlots`/`untouched`, can carry more
        // than one round-robin-kind stage's fixtures in ONE call. This is
        // the actual WRITE gate (the comment above `roundRobin`'s own
        // assignment explains why it has to be judged HERE), so it is the
        // one place this omission would have mattered most: without it,
        // `calendar.ts`'s grouping key falls back to `(divisionId, poolId)`
        // and two unpooled round-robin stages compare as one sequence again.
        stageId: f.stage_id,
        // C1 (2026-08-12 round-order design). Same shape as `toAssignment`
        // again — `f.round_no` is the fixture's own round, gated on stage
        // kind exactly as `toAssignment` gates it; `movable: true`
        // unconditionally, because every row here is a position THIS apply
        // is actively choosing, whatever lock state it ends up carrying
        // (`a.schedule_locked` below is the state AFTER this write, not a
        // fact about whether this apply itself may act on it).
        ...(roundRobin.has(f.stage_id) ? { roundNo: f.round_no } : {}),
        movable: true,
      };
    });
    const listed = new Set(input.assignments.map((a) => a.fixture_id));
    // C1 fix-loop (G2/3rd instance, re-scoped by the round-order-widening
    // fix-loop below). This apply's own round-robin siblings — same
    // (division, stage, pool) sequence as any LISTED fixture, already placed,
    // not themselves listed. They are needed ONLY so `roundOrderConflicts`
    // (the round-order-only pass below) can pair a listed fixture against an
    // untouched one — its pairwise scan is scoped to the set it is handed,
    // by design. See `roundRobinSequenceSiblings`'s own comment for the full
    // mechanism; this generalizes it to N listed fixtures rather than
    // exactly one (`moveFixture`'s shape below).
    //
    // They deliberately do NOT move into `assignments`/out of `untouched` for
    // the CORE gate below (rest/court/person/window/feed-order) — that was
    // the original, too-blunt fix: pulling a sibling out of `existing` made
    // it FOCAL for every rule family the gate checks, not just round order,
    // silently changing what rest/court/person judged a pre-existing board
    // against. Those families see the siblings exactly as they always did —
    // as fixed CONTEXT via `board`/`existing` below — so their verdicts stay
    // byte-identical to the pre-round-order gate.
    const widenKeys = new Set(
      input.assignments
        .map((a) => byId.get(a.fixture_id) as FixtureLite)
        .filter((f) => roundRobin.has(f.stage_id))
        .map(roundRobinSequenceKey),
    );
    const roundRobinSiblings = roundRobinSequenceSiblings(all, widenKeys, listed);
    const siblingIds = new Set(roundRobinSiblings.map((f) => f.id));
    // ORIGINAL composition — `siblingIds` stays IN here, matching every rule
    // family's pre-round-order behaviour (and origin/main's, byte for byte).
    const untouched = all
      .filter((f) => !listed.has(f.id) && f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    // Round-order-only checked set: the siblings, same representation as
    // `untouched`'s rows, added to BOTH delta sides below so a pre-existing
    // round-order violation among them reads as pre-existing rather than
    // newly introduced by a move that never touched them.
    const widenedSiblings = roundRobinSiblings.map((f) =>
      toAssignment(f, settings.config.matchMinutes, people, roundRobin),
    );
    const siblings = await siblingAssignments(
      tx,
      stage.division_id,
      stage.competition_id,
      settings.config.matchMinutes,
    );

    // #447: the VERIFY config, so the durable typed rules an organiser stored
    // are the rules this gate judges by. Warn-only — see `assertNoNewBlocking`.
    // P9.5 review finding 4: the apply gate sees court opening hours too, so a
    // board applied onto a closed court is reported HERE rather than only by
    // the next /validate run — two surfaces, one answer. P10 (§3): routed
    // through the ONE builder so this site gets the stranded-court signal too
    // — hand-assembly at five sites is how person-merge.ts ended up with
    // neither signal at all.
    // Review fix (finding 2): `all` alone only ever names courts a STORED
    // fixture already occupies. `proposed`'s own court_ids — the ones THIS
    // apply is actively placing fixtures onto — must be unioned in too, or
    // applying onto an archived court nothing else currently uses reports
    // clean HERE and only surfaces on the next /validate, contradicting the
    // "this apply gate sees ... the stranded-court signal too" comment just
    // above: it did not, until now.
    const assignedCourtIds = [
      ...new Set(
        [...all.map((f) => f.court_id), ...proposed.map((a) => a.court)].filter(
          (c): c is string => c !== null,
        ),
      ),
    ];
    const slotConfig = await verifyConfigForDivision(
      tx,
      settings,
      all,
      0,
      siblings.ruleFixtures,
      stage.division_id,
      assignedCourtIds,
    );
    const deps = feedDependencies(all);
    const board = [...untouched, ...siblings.assignments];
    // The SAME fixtures where they sit right now (#399). Anything the verifier
    // already says about this board is history, not this apply's doing — an
    // organiser whose board carries a pre-existing person overlap must still be
    // able to edit it, which is the only way they can ever fix it.
    // A fixture with no slot yet contributes nothing, so every conflict its
    // placement causes reads as introduced. Correct: it is.
    const currentSlots = input.assignments
      .map((a) => byId.get(a.fixture_id) as FixtureLite)
      .filter((f) => f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    // CORE families (window/start_window/court/blackout/rest/person_overlap/
    // instruction rules/feed-order): `includeRoundOrder=false` — this call is
    // byte-identical in shape to the pre-round-order gate, so its verdict is
    // too. Round order is judged SEPARATELY, immediately below, over the
    // widened set — merging only its `"order"` conflicts back in keeps every
    // other family blind to the siblings, exactly as it always was.
    const baseline = [
      ...validateAssignments(currentSlots, slotConfig, board, deps, false),
      ...roundOrderConflicts(currentSlots.concat(widenedSiblings), slotConfig.tz),
    ];
    const found = [
      ...validateAssignments(proposed, slotConfig, board, deps, false),
      ...roundOrderConflicts(proposed.concat(widenedSiblings), slotConfig.tz),
    ];
    assertNoNewBlocking(baseline, found, courtNames);
    // Scoped to the fixtures THIS apply actually listed (#461's contract,
    // `moveFixture`'s own return does the same) — the widened siblings above
    // exist so the round-order GATE can see them, not so their own (possibly
    // pre-existing and entirely unrelated) conflicts leak into a response
    // about fixtures the caller never named.
    const conflicts = mapConflicts(found.filter((c) => !siblingIds.has(c.fixtureId)), courtNames);

    const moves: { fixture: string; from: unknown; to: unknown }[] = [];
    for (const a of input.assignments) {
      const f = byId.get(a.fixture_id) as FixtureLite;
      // P9 pass 3a: writers stop writing court_label/venue (owner ruling,
      // FULL cutover) — court_id/venue_id only.
      //
      // #5 fix (P9 review): venue_id is DERIVED from a.court_id server-side,
      // via courts.venue_id — never trusted from the client's own a.venue_id.
      // No caller (use-board-actions.ts/ai-apply.ts/move-panel.tsx) has ever
      // sent venue_id; the old `coalesce(a.venue_id, venue_id)` therefore
      // left every freshly-scheduled fixture's venue_id NULL and, after a
      // move to a court in a different venue, stuck on the OLD venue — every
      // player-facing venue string (ICS LOCATION, /me, /my-matches, the
      // public fixture page + its JSON-LD) derives from this column.
      // a.court_id is a required field here (ApplyScheduleRequest's
      // Assignment, never nullable), and courts.venue_id is NOT NULL, so
      // this always resolves for a real, same-org court; a bogus court_id is
      // already rejected by fixtures' composite (court_id, org_id) FK before
      // venue_id's own correctness could matter.
      await tx`
        update fixtures set
          scheduled_at = ${a.scheduled_at},
          court_id = ${a.court_id},
          venue_id = ${courtVenues.get(a.court_id) ?? null},
          schedule_source = ${input.source},
          schedule_locked = ${a.schedule_locked ?? f.schedule_locked}
        where id = ${a.fixture_id}`;
      // `court` here is a courts.id, not a label — see moveFixture's
      // identical note on `schedule_edited`'s ledger payload; history.ts's
      // `execute()` replays `schedule_applied`/`schedule_shifted` the same way.
      moves.push({
        fixture: a.fixture_id,
        from: {
          at: f.scheduled_at !== null ? iso(ms(f.scheduled_at)) : null,
          court: f.court_id,
        },
        to: { at: a.scheduled_at, court: a.court_id },
      });
    }
    // One auditable ledger entry per apply (doc 12 §2 family: schedule_edited/…).
    const seq = await appendDivisionEvent(tx, stage.division_id, "schedule_applied", {
      stageId,
      source: input.source,
      moves,
      // Stamp the runtime model, not the client's constant: SCHEDULING_AI_MODEL
      // can override the model that actually ran, and the run ledger records the
      // truth — so trusting the client's `model` here would misrecord the audit.
      // The client field is still accepted (schema unchanged); it's just ignored.
      ...(input.ai
        ? { ai: { ...input.ai, instruction: input.ai.instruction.trim(), model: schedulingAiModel() } }
        : {}),
    });
    await tx`update divisions set seq = ${seq} where id = ${stage.division_id}`;
    return {
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
      applied: input.assignments.length,
      conflicts,
      // R10d n2: the fixtures this apply wrote, and only those.
      fixtureIds: input.assignments.map((a) => a.fixture_id),
    };
  });
  afterScheduleWrite(out.divisionId, out.competitionId, "schedule", out.fixtureIds);
  return { applied: out.applied, conflicts: out.conflicts };
}

/** GET /divisions/{id}/schedule/ai-last — recall the most recent AI-sourced
 *  schedule apply from the division ledger (v4/03 §10) plus the division's
 *  generation budget. `last` is the trimmed instruction + human summary +
 *  apply timestamp, or null when the division has never been AI-scheduled.
 *  `runs.used` counts the same 'schedule.ai_generated' rows the ai-plan
 *  orchestrator writes (failures never appear there); `runs.max` is always
 *  null now — v17 Phase 2 Task 5 (V322) retired the plan-graded per-division
 *  cap it used to resolve, replaced by the AI credit wallet, which meters
 *  spend rather than a per-division count (see `spendCredit` in
 *  schedule-ai.ts). Read-gated at route. */
export async function lastAiApply(
  auth: AuthCtx,
  divisionId: string,
): Promise<{
  last: { at: string; instruction: string; summary: string } | null;
  runs: { used: number; max: number | null };
}> {
  const { rows, used } = await withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      { created_at: Date; payload: { ai?: { instruction?: string; summary?: string } } }[]
    >`
      select created_at, payload from division_events
      where division_id = ${divisionId}
        and type = 'schedule_applied'
        and payload->>'source' = 'ai'
      order by seq desc limit 1`;
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where competition_id = ${division.competition_id}
        and type = 'schedule.ai_generated'
        and payload->>'division_id' = ${divisionId}`;
    return { rows, used: count?.n ?? 0 };
  });
  const ai = rows[0]?.payload.ai ?? {};
  return {
    last:
      rows.length === 0
        ? null
        : {
            at: iso(ms(rows[0]!.created_at)),
            instruction: ai.instruction ?? "",
            summary: ai.summary ?? "",
          },
    runs: { used, max: null },
  };
}

// ---------------------------------------------------------------------------
// Single move (fixture PATCH, doc 12 §4) — used by the drag-and-drop board
// ---------------------------------------------------------------------------

export interface MoveInput {
  scheduled_at?: string | null;
  // P9 pass 3a: court_id/venue_id — see PatchFixture (schemas.ts). Mirrors
  // that schema's post-`.strict()`/`.partial()` shape structurally:
  // fixtures.ts's `patchFixture` destructures `{ officials, ...move }` off
  // an already-parsed `PatchFixture` and hands `move` straight to
  // `moveFixture` — no field-by-field mapping, so this interface has to
  // stay structurally assignable from `Omit<PatchFixture, "officials">` or
  // that call breaks.
  court_id?: string | null;
  venue_id?: string | null;
  schedule_locked?: boolean;
  expected_seq?: number;
}

/** Optimistic-concurrency guard (v3/11 gap 10): schedule writes may carry the
 *  division seq the client rendered from; a stale token means another admin
 *  edited the board since — 409 with the current seq so the client resyncs. */
// Exported for the #350 joint apply, which asserts it once per division inside
// ONE transaction: a stale token on any division must abort every division's
// write, and that only holds if both sides raise the identical SEQ_CONFLICT.
export async function assertFreshSeq(
  tx: Tx,
  divisionId: string,
  expectedSeq: number | undefined,
): Promise<void> {
  if (expectedSeq === undefined) return;
  const [row] = await tx<{ seq: string | number }[]>`
    select seq from divisions where id = ${divisionId}`;
  const actual = Number(row?.seq ?? 0);
  if (expectedSeq !== actual) {
    throw new EngineError("SEQ_CONFLICT", "schedule changed since you loaded it", {
      actualSeq: actual,
    });
  }
}

/**
 * Schedule-aware single-fixture move: blocks on conflict.court / direct
 * warn.order (409 with the conflicts), otherwise persists and appends
 * `schedule_edited {fixture, from, to}` (doc 12 §2).
 *
 * RETURNS the conflict report it judged the destination by (#461). It always
 * computed one — the blocking gate needs it — and used to drop it, so the
 * WARN-level half was invisible to every caller: a drag that put a card into a
 * rest shortfall, past a stored typed rule or outside the competition's days
 * wrote silently and said nothing. The blocking half still throws, so anything
 * returned here is by construction non-blocking (or pre-existing, which the
 * delta gate deliberately allows). `[]` when the patch touched no timetable
 * field, so absence and emptiness are the same answer rather than two.
 *
 * These are THIS MOVE's conflicts, not the board's: `validateAssignments` is run
 * over the single proposed card. The whole-board report is `validateSchedule`,
 * and the console board refreshes from it after every drop.
 */
export async function moveFixture(
  auth: AuthCtx,
  fixtureId: string,
  patch: MoveInput,
): Promise<ScheduleConflict[]> {
  if (patch.schedule_locked !== undefined) {
    await requireFeature(auth.orgId, "scheduling.board");
  }
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const out = await withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      (FixtureLite & { competition_id: string })[]
    >`
      select f.id, f.stage_id, f.division_id, f.round_no, f.home_entrant_id,
             f.away_entrant_id, f.scheduled_at, f.court_id, f.venue_id,
             f.court_label, f.venue, f.pool_id,
             f.status, f.schedule_locked, f.winner_to_fixture, f.loser_to_fixture,
             d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + fixture.division_id}))`;
    await assertFreshSeq(tx, fixture.division_id, patch.expected_seq);
    assertNotFrozen(frozen, fixture.competition_id);

    // Single-fixture moves are board edits too — the whole-division freeze
    // must hold here exactly as it does for applySchedule (this is the route
    // the board's drag/keyboard move actually uses). Scope locks deliberately
    // do NOT bite on single moves (see history.test.ts — the board apply path
    // enforces them; a targeted move is the escape hatch).
    const lockState = await divisionLockState(tx, fixture.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }

    const movesTimetable = patch.scheduled_at !== undefined || patch.court_id !== undefined;
    if (movesTimetable && fixture.status !== MOVABLE_STATUS) {
      throw new HttpError(422, `fixture is ${fixture.status} — decided fixtures are immutable`);
    }

    const settings = await loadSettings(tx, fixture.division_id);
    // P9 pass 3a: resolved once, used for the conflict mapping below AND
    // (court/venue both) for the officials email built after this
    // transaction closes — see `change` at the end of this callback.
    const courtNames = await courtNamesById(tx);
    const venueNames = await venueNamesById(tx);
    // #5 fix — resolved once, used to DERIVE venue_id from the target
    // court_id below.
    const courtVenues = await courtVenueIds(tx);
    const nextAt = patch.scheduled_at !== undefined ? patch.scheduled_at : (fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null);
    const nextCourtId = patch.court_id !== undefined ? patch.court_id : fixture.court_id;

    let conflicts: ScheduleConflict[] = [];
    if (movesTimetable && nextAt !== null && nextCourtId !== null) {
      const all = await divisionFixtures(tx, fixture.division_id);
      const entrantIds = [
        ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
      ].filter((e): e is string => e !== null);
      const people = await peopleByEntrant(tx, entrantIds);
      // C1 (2026-08-12 round-order design). Same reason `applySchedule` reads
      // it: round order has to be judged HERE, on the write gate — see
      // `toAssignment`'s own doc comment.
      const roundRobin = await roundRobinStageIds(tx, fixture.division_id);
      const start = ms(nextAt);
      const proposed: Assignment = {
        fixtureId: fixture.id,
        court: nextCourtId,
        startAt: start,
        endAt: start + settings.config.matchMinutes * MS_PER_MIN,
        entrants: [fixture.home_entrant_id, fixture.away_entrant_id].filter(
          (e): e is string => e !== null,
        ),
        people: peopleOf(fixture, people),
        // #446 — this is the drag/keyboard move the issue describes: without
        // these two the dragged card resolves its rest to `perEntrantMinRest`
        // and its start bound to (-inf, +inf), so a pool rule the auto pass
        // honoured is silently absent at exactly the moment a human overrides it.
        ...(fixture.pool_id !== null ? { poolId: fixture.pool_id } : {}),
        divisionId: fixture.division_id,
        // C1 fix-loop (G2/3rd instance). Same shape as `applySchedule`'s own
        // `proposed` — `stageId` unconditional (`fixtures.stage_id` is NOT
        // NULL), `roundNo` gated on stage kind, `movable: true`
        // unconditionally because this call is actively choosing this
        // position, whatever lock state it ends up carrying. Without these
        // three, `proposed` could never enter `calendar.ts`'s round-order
        // `bySequence` grouping at all — a fixture with no `roundNo` is
        // skipped outright — so widening the sibling set below would still
        // catch nothing.
        stageId: fixture.stage_id,
        ...(roundRobin.has(fixture.stage_id) ? { roundNo: fixture.round_no } : {}),
        movable: true,
      };
      // C1 fix-loop (G2/3rd instance, re-scoped by the round-order-widening
      // fix-loop below). This fixture's own round-robin sequence siblings —
      // same (division, stage, pool), already placed. They exist ONLY so
      // `roundOrderConflicts` (the round-order-only pass below) can pair this
      // move against an untouched sibling — its scan is scoped to the set
      // it's handed, and the checked side here is always exactly one
      // fixture: `[proposed]` or `currentSlot`. A one-element array can never
      // contain a same-sequence PAIR, so no amount of correct `roundNo`/
      // `stageId` wiring on `proposed` ALONE would ever flag a violation
      // against an untouched sibling — the sibling has to be pulled into
      // round order's OWN checked set. See `roundRobinSequenceSiblings`'s own
      // comment for the full mechanism and why symmetry (both sides of the
      // delta, not just the proposed one) is what keeps a pre-existing
      // violation among siblings from reading as a false "new" block on a
      // move that never touched them.
      //
      // They deliberately do NOT move into `assignments`/out of `others` for
      // the CORE gate below — that was the original, too-blunt fix: pulling a
      // sibling out of `existing` made it FOCAL for every rule family, not
      // just round order, silently changing what rest/court/person judged a
      // pre-existing board against. Those families see the siblings exactly
      // as they always did — fixed CONTEXT via `board`/`existing` below.
      const roundRobinSiblings = roundRobinSequenceSiblings(
        all,
        roundRobin.has(fixture.stage_id) ? new Set([roundRobinSequenceKey(fixture)]) : new Set(),
        new Set([fixture.id]),
      );
      const siblingIds = new Set(roundRobinSiblings.map((f) => f.id));
      // ORIGINAL composition — `siblingIds` stays IN here, matching every
      // rule family's pre-round-order behaviour (and origin/main's, byte for
      // byte).
      const others = all
        .filter((f) => f.id !== fixture.id && f.scheduled_at !== null && f.court_id !== null)
        .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
      // Round-order-only checked set: this fixture's siblings, added to BOTH
      // delta sides below so a pre-existing round-order violation among them
      // reads as pre-existing rather than newly introduced by a move that
      // never touched them.
      const widenedSiblings = roundRobinSiblings.map((f) =>
        toAssignment(f, settings.config.matchMinutes, people, roundRobin),
      );
      const siblings = await siblingAssignments(
        tx,
        fixture.division_id,
        fixture.competition_id,
        settings.config.matchMinutes,
      );
      // #447: the dragged card is judged against the durable typed rules too.
        // Same as the apply gate: a card DRAGGED onto a court that is closed at
      // that time is flagged at the drag, not silently accepted and then
      // reported by the next /validate.
      // P10 (§3): routed through the ONE builder so a card dragged onto a
      // since-archived court is flagged the same way one dragged onto a
      // closed court already is — hand-assembly at five sites is how
      // person-merge.ts ended up with neither signal.
      // Review fix (finding 1): `all` alone only ever names courts a STORED
      // fixture already occupies — never `nextCourtId`, the drag TARGET
      // itself. So dragging a card onto an archived court no other fixture
      // currently sits on produced NO stranded_fixture conflict, despite the
      // comment above claiming this move is judged against the durable
      // typed rules "too". Unioning `nextCourtId` in is what actually makes
      // that true.
      const assignedCourtIds = [
        ...new Set(
          [...all.map((f) => f.court_id), nextCourtId].filter((c): c is string => c !== null),
        ),
      ];
      const slotConfig = await verifyConfigForDivision(
        tx,
        settings,
        all,
        0,
        siblings.ruleFixtures,
        fixture.division_id,
        assignedCourtIds,
      );
      const deps = feedDependencies(all);
      const board = [...others, ...siblings.assignments];
      // Where this card sits right now (#399). An unscheduled fixture has no
      // baseline, so every blocking conflict its first placement causes is
      // introduced — which is exactly what it is.
      const currentSlot =
        fixture.scheduled_at !== null && fixture.court_id !== null
          ? [toAssignment(fixture, settings.config.matchMinutes, people, roundRobin)]
          : [];
      // CORE families: `includeRoundOrder=false` — this call is
      // byte-identical in shape to the pre-round-order gate, so its verdict
      // is too. Round order is judged SEPARATELY, over the widened set —
      // merging only its `"order"` conflicts back in keeps every other
      // family blind to the siblings, exactly as it always was.
      const baseline = [
        ...validateAssignments(currentSlot, slotConfig, board, deps, false),
        ...roundOrderConflicts(currentSlot.concat(widenedSiblings), slotConfig.tz),
      ];
      const found = [
        ...validateAssignments([proposed], slotConfig, board, deps, false),
        ...roundOrderConflicts([proposed, ...widenedSiblings], slotConfig.tz),
      ];
      assertNoNewBlocking(baseline, found, courtNames);
      // Scoped to the fixture THIS move actually names (#461's contract) —
      // the widened siblings above exist so the round-order GATE can see
      // them, not so their own (possibly pre-existing and entirely
      // unrelated) conflicts leak into a response about a card the caller
      // never touched.
      conflicts = mapConflicts(found.filter((c) => !siblingIds.has(c.fixtureId)), courtNames);
    }

    // #5 fix (P9 review): venue_id is DERIVED from the court, server side —
    // never trusted from client input, which must never be able to disagree
    // with the court's own venue (courts.venue_id, composite-FK-guaranteed
    // to agree with org). `patch.venue_id` is intentionally never read
    // below; keeping it in MoveInput/PatchFixture's own type is harmless — a
    // caller sending it just has it silently ignored. Untouched (`fixture.
    // venue_id`) when court_id itself is untouched; derived from the target
    // court when set; cleared to null alongside a cleared court_id — there
    // is nothing left to derive a venue from once there is no court.
    const nextVenueId =
      patch.court_id !== undefined
        ? patch.court_id !== null
          ? (courtVenues.get(patch.court_id) ?? null)
          : null
        : fixture.venue_id;
    const values: Record<string, unknown> = {};
    if (patch.scheduled_at !== undefined) values.scheduled_at = patch.scheduled_at;
    if (patch.court_id !== undefined) {
      values.court_id = patch.court_id;
      values.venue_id = nextVenueId;
    }
    if (patch.schedule_locked !== undefined) values.schedule_locked = patch.schedule_locked;
    if (movesTimetable) values.schedule_source = "manual";
    if (Object.keys(values).length > 0) {
      await tx`
        update fixtures set ${tx(values as never, ...(Object.keys(values) as never[]))}
        where id = ${fixture.id}`;
    }

    if (movesTimetable || patch.schedule_locked !== undefined) {
      // P9 pass 3a: `court` in this ledger payload is a `courts.id`
      // (previously a free-text `court_label`) — `execute()` in history.ts
      // replays this event straight back into `fixtures.court_id` on
      // undo/redo, so it has to be the id, not a display name, or restore
      // would write a label into an id column.
      const seq = await appendDivisionEvent(tx, fixture.division_id, "schedule_edited", {
        fixture: fixture.id,
        from: {
          at: fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null,
          court: fixture.court_id,
          locked: fixture.schedule_locked,
        },
        to: {
          at: nextAt,
          court: nextCourtId,
          locked: patch.schedule_locked ?? fixture.schedule_locked,
        },
      });
      await tx`update divisions set seq = ${seq} where id = ${fixture.division_id}`;
    }

    // v11: officials who agreed to a slot must hear when it moves. Only real
    // timetable/venue changes notify, only non-declined assignments, only
    // officials with an email — assembled in-tx, sent after commit.
    //
    // #5 fix: the OLD second disjunct (`patch.venue_id !== undefined &&
    // patch.venue_id !== fixture.venue_id`) is now dead code, deliberately
    // removed rather than left misleading — venue_id can no longer change
    // independently of court_id (see nextVenueId's own comment above), and
    // any court_id change is already covered by the `fixture.court_id !==
    // nextCourtId` clause below.
    const timetableChanged =
      movesTimetable &&
      ((fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null) !== nextAt ||
        fixture.court_id !== nextCourtId);
    let changeNotices: {
      email: string; display_name: string; role_key: string; org_name: string;
      default_locale: string | null;
      home_name: string | null; away_name: string | null; venue_tz: string | null;
      home_slot_label: SlotLabel | null; away_slot_label: SlotLabel | null;
    }[] = [];
    if (timetableChanged) {
      changeNotices = await tx`
        select o.email, o.display_name, fo.role_key, org.name as org_name,
               org.default_locale,
               h.display_name as home_name, a.display_name as away_name,
               f.home_slot_label, f.away_slot_label,
               -- venue lane (V305): division override → org timezone → UTC
               coalesce(ss.tz, org.timezone, 'UTC') as venue_tz
        from fixture_officials fo
        join fixtures f on f.id = fo.fixture_id
        join officials o on o.id = fo.official_id
        join organizations org on org.id = o.org_id
        left join entrants h on h.id = ${fixture.home_entrant_id}
        left join entrants a on a.id = ${fixture.away_entrant_id}
        left join schedule_settings ss on ss.division_id = ${fixture.division_id}
        where fo.fixture_id = ${fixture.id}
          and fo.response <> 'declined' and o.email is not null`;
    }
    return {
      divisionId: fixture.division_id,
      competitionId: fixture.competition_id,
      // R10d n2: the one fixture this move wrote.
      fixtureId: fixture.id,
      conflicts,
      changeNotices,
      // P9 pass 3a: the officials-change EMAIL renders human text, so this
      // (internal-only — never the API response, which is just `conflicts`)
      // carries RESOLVED NAMES, not ids, unlike the ledger event above.
      change: {
        prevAt: fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null,
        nextAt,
        courtName: nextCourtId !== null ? (courtNames.get(nextCourtId) ?? null) : null,
        venueName: nextVenueId !== null ? (venueNames.get(nextVenueId) ?? null) : null,
      },
    };
  });
  for (const n of out.changeNotices) {
    // Copy locale for a document nobody is "viewing" — same reasoning as
    // exports.ts's exportLookup / calendar.ics/route.ts: the officials-change
    // notice email has no single reader whose cookie could be consulted, so
    // it uses the org's own default locale.
    const locale = toLocale(n.default_locale);
    const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
      msgFor(locale, k, v);
    void sendOfficialAssignmentChangedEmail(n.email, {
      orgName: n.org_name,
      officialName: n.display_name,
      roleKey: n.role_key,
      label: `${n.home_name ?? resolveSlotLabel(n.home_slot_label, lookup, "schedule.tbd")} vs ${n.away_name ?? resolveSlotLabel(n.away_slot_label, lookup, "schedule.tbd")}`,
      prevAt: out.change.prevAt,
      nextAt: out.change.nextAt,
      venueTz: n.venue_tz,
      court: out.change.courtName,
      venue: out.change.venueName,
    }).catch(() => {});
  }
  afterScheduleWrite(out.divisionId, out.competitionId, "schedule", [out.fixtureId]);
  return out.conflicts;
}

// ---------------------------------------------------------------------------
// Validate (full board report — doc 12 §4)
// ---------------------------------------------------------------------------

/**
 * The full-board report, inside a transaction the CALLER owns (#230 item 2).
 *
 * Extracted from `validateSchedule` so the publish gate can run the identical
 * pass inside its own transaction, after its advisory lock, rather than growing
 * a second validation implementation. The placer/verifier fork is the recurring
 * defect in this subsystem — it has been re-derived three times — and "publish
 * sees exactly what the panel sees" is only a fact while there is ONE body here.
 *
 * `competitionId` is a parameter rather than a re-read: both callers have
 * already selected the division row, and re-selecting it inside would make the
 * gate's view of the world one statement newer than the lock's.
 *
 * THE OFFICIALS SQL BUCKETS ON `settings.orgTz`, NOT `settings.displayTz`.
 * "Which calendar day is this fixture on" is day math, and day math runs on the
 * governing clock (#397; and `ScheduleSettingsOut` says of `displayTz` in as
 * many words: "DISPLAY ONLY. Never use it to decide which calendar day something
 * is on"). The two diverge exactly when a division carries the V305 venue
 * override — `displayTz` is division → org → UTC, `orgTz` is org → UTC — and a
 * blackout is an ORG-level record, one row per official per date, shared by
 * every division they work; bucketing it per-division made one date mean two
 * different days inside one competition. Concretely: org Europe/London,
 * division America/New_York, fixture 02:00Z on 10 Aug. The display lane files
 * it under the 9th, so a blackout on the 10th raises nothing and one on the 9th
 * raises a phantom. Pre-existing, but #230 item 2 promoted this warning from an
 * advisory badge to a PUBLISH-GATE input, so both directions now cost the
 * organiser something: a missed acknowledge step, or a spurious one.
 * Pinned by `schedule-officials-day-zone.test.ts`, on a fixture where the two
 * zones disagree — one where they agree passes under either spelling.
 */
async function validateScheduleIn(
  tx: Tx,
  divisionId: string,
  competitionId: string,
): Promise<{ conflicts: ScheduleConflict[] }> {
  const settings = await loadSettings(tx, divisionId);
  const all = await divisionFixtures(tx, divisionId);
  const entrantIds = [
    ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
  ].filter((e): e is string => e !== null);
  const people = await peopleByEntrant(tx, entrantIds);
  // P9 pass 2b: court identity through the SAME resolveCandidateCourts the
  // build side calls — never a second, inlined tag-filter loop here. This
  // half stays DIVISION-scoped only: `settingsForEngine.config.courts` below
  // is dead weight for THIS path (`validateAssignments` has never read
  // `.courts` — the next comment), so there is nothing here for a stage's
  // own tags to usefully narrow. (Review finding #11: the OTHER half,
  // `courtTagQualifiedIds` below, DOES need the stage union — see that
  // comment.) And, deliberately, no guardNoMatchingCourt: this reports on a
  // board that may already EXIST, and an assignment sitting on a
  // since-archived or since-retagged court must keep validating clean
  // (ruling 3, candidate-courts.ts) — see court-candidates.ts's own doc
  // comment on guardNoMatchingCourt for why calling it here would be wrong,
  // not merely unnecessary.
  const [divisionForCourts] = await tx<{ required_court_tags: string[] }[]>`
    select required_court_tags from divisions where id = ${divisionId}`;
  const requiredCourtTags = divisionForCourts?.required_court_tags ?? [];
  const candidateCourtIds = await resolveCandidateCourts(
    tx,
    divisionId,
    settings.config.courts,
    requiredCourtTags,
  );
  const settingsForEngine = {
    ...settings,
    config: { ...settings.config, courts: [...candidateCourtIds.ids] },
  };
  // P9.5: the SAME loader the build path calls, so the lattice and this
  // verifier cannot be handed different opening hours — the placer/verifier
  // fork court-candidates.ts's header opens by warning about, now for the
  // court's calendar rather than its tags. Scoped to candidate ids for the
  // archived-court reason spelled out on the build side.
  const courtCalendars = await resolveCourtCalendars(tx, candidateCourtIds.ids);
  // P10 (A6/§1): this division's OWN assigned courts — never candidateCourtIds
  // here either, for the identical archived-court reason spelled out just
  // above: an archived court is already excluded from that set, so reusing it
  // would make the stranded-fixture conflict impossible to ever report.
  const strandedCourtIds = await strandedCourtIdsForDivision(
    tx,
    divisionId,
    [...new Set(all.map((f) => f.court_id).filter((c): c is string => c !== null))],
  );
  // P9 pass 2c: gives the VERIFIER a real consumer for the same constraint —
  // `candidateCourtIds` above (tag+archived filtered) becomes the new
  // `config.courts`, but `validateAssignments` has never read `.courts`
  // (this file's own false-premise history: candidate awareness on the
  // verify side was new plumbing, not a refactor). Deliberately a SEPARATE
  // resolution, not a reuse of `candidateCourtIds.ids`: that set already
  // excludes archived courts, and reusing it for the mismatch conflict would
  // retroactively red an assignment sitting on a since-archived court —
  // exactly what ruling 3 (candidate-courts.ts) forbids. See
  // `resolveTagQualifiedCourtIds`'s own doc comment for the archived-neutral
  // mechanics.
  //
  // Review finding #11 -> #622. This used to resolve against
  // `requiredCourtTags` alone (the DIVISION's tags), which made a
  // stage-level tag invisible to the verifier while `autoSchedule` honoured
  // it. #11 closed that with the closest safe approximation available at the
  // time: resolve once per STAGE and merge the QUALIFIED COURT SETS, so a
  // court qualifies board-wide if it satisfies ANY stage actually present.
  // Its own comment recorded why the required-tag LISTS could not simply be
  // flattened instead (`candidateCourts` reads a list as AND, so combining
  // two stages' tags demands a court carry tags from a stage a given fixture
  // has nothing to do with).
  //
  // #622 replaces the approximation with the exact answer, because a third
  // scope made the approximation's error reachable rather than merely
  // theoretical: with round-scoped tags, the union across stages ALSO unions
  // across rounds, so the championship court the final requires would satisfy
  // every quarter-final too and the conflict would never fire. The resolution
  // unit is the fixture, through the same shared pair `autoSchedule` and
  // `buildSchedulePack` use.
  //
  // `courtTagQualifiedIds` (the flat, division-wide list) is still sent
  // alongside as the fallback for any assignment whose fixture is not in the
  // map — an obstacle from another division, or a row for a fixture deleted
  // between the two reads. `validateAssignments` prefers the per-fixture
  // entry and falls back to the flat one; see its own doc comment.
  const fixtureTags = await requiredCourtTagsByFixture(tx, divisionId, requiredCourtTags);
  // #622 review (finding #9): the flat, division-wide fallback set used to be
  // its own separate `resolveTagQualifiedCourtIds` call — a third DB scan that,
  // for the overwhelmingly common case (no fixture's own stage/round narrows
  // beyond the division), re-resolved a tag union `tagQualifiedCourtIdsByFixture`
  // below already resolves and memoises for every fixture with no narrowing of
  // its own (`requiredCourtTagsByFixture`'s `unionRequiredCourtTags(divisionTags,
  // stageTags)` with an empty `stageTags` IS `requiredCourtTags`). A sentinel key
  // that cannot collide with a fixture uuid rides through the SAME memoised
  // resolver so the flat set costs nothing extra when a fixture already shares
  // its tag union, and still resolves independently on the rare board where
  // every fixture's own scope narrows past it.
  const FLAT_FALLBACK_KEY = "__division_flat__";
  const tagsForResolve = new Map(fixtureTags);
  tagsForResolve.set(FLAT_FALLBACK_KEY, requiredCourtTags);
  const qualifiedByFixtureAndFlat = await tagQualifiedCourtIdsByFixture(tx, tagsForResolve);
  const courtTagQualifiedIds = new Set<string>(qualifiedByFixtureAndFlat.get(FLAT_FALLBACK_KEY)!);
  const courtTagQualifiedIdsByFixture = new Map(qualifiedByFixtureAndFlat);
  courtTagQualifiedIdsByFixture.delete(FLAT_FALLBACK_KEY);
  // C1 follow-up (2026-08-12, task 3 / G1). This function backs BOTH
  // `validateSchedule` (the board's live conflict report) and, through
  // `assertPublishable`, `publishSchedule`/`startDivision` — the write gate.
  // Its own `toAssignment` call used to run with no `roundRobinStageIds` 4th
  // argument, so `roundNo` never reached the `Assignment`s handed to
  // `validateAssignments` below: round order was structurally invisible to
  // both the panel's badges and the publish/start gate, regardless of what
  // the board actually looked like — a round-robin division could publish or
  // start with a genuine round-order violation and nothing would show it.
  // Wired the same way `autoSchedule`/`applySchedule`/`reverifyBoards`
  // already are (`schedule.ts`'s own reference wiring; `person-merge.ts`).
  const roundRobin = await roundRobinStageIds(tx, divisionId);
  const assignments = all
    .filter((f) => f.scheduled_at !== null && f.court_id !== null)
    .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
  // P9 pass 3a — the same resolve every mapConflicts call needs.
  const courtNames = await courtNamesById(tx);
  const siblings = await siblingAssignments(
    tx,
    divisionId,
    competitionId,
    settings.config.matchMinutes,
  );
  const officialConflicts = await tx<{ fixture_id: string; code: string }[]>`
    -- declined: any assigned official said no
    select fo.fixture_id, 'warn.official_declined' as code
    from fixture_officials fo
    join fixtures f on f.id = fo.fixture_id
    where f.division_id = ${divisionId} and fo.response = 'declined'
    union
    -- unavailable: an accepted/pending official is blacked out on the
    -- fixture's calendar day, i.e. a schedule clash
    select fo.fixture_id, 'warn.official_unavailable' as code
    from fixture_officials fo
    join fixtures f on f.id = fo.fixture_id
    join officials o on o.id = fo.official_id
    join official_availability oa on oa.official_id = o.id
    where f.division_id = ${divisionId}
      and fo.response in ('accepted','pending')
      and f.scheduled_at is not null
      -- orgTz, NOT displayTz. See the long note above this function.
      -- (Backticks are banned in here: this is a tagged template.)
      and oa.date = (f.scheduled_at at time zone ${settings.orgTz})::date`;

  // A REPORT of the board as it stands. `blocking` here says "impossible", not
  // "refused" (#399) — the board paints those cards red, and it must keep
  // doing so for a court double-booking that is already on the timetable.
  // Nothing is written on this path, so no delta applies.
  return {
    conflicts: [
      ...mapConflicts(
        // #447: `toVerifyConfig`, so the board's own report shows the durable
        // typed rules the organiser stored — this is the surface the
        // constraints panel promises them on.
        validateAssignments(
          assignments,
          // P9 pass 2c: `courtTagQualifiedIds` is the one field
          // `toVerifyConfig` itself never sets (every OTHER caller of this
          // engine function omits it and keeps exactly today's behaviour —
          // calendar.ts's own comment on the field) — spread on at this ONE
          // call site rather than threaded through `toVerifyConfig`'s
          // parameter list, which would touch its other three callers
          // (autoSchedule, the AI planning path, every test in this
          // package) for a question only THIS path asks.
          {
            ...toVerifyConfig(
              settingsForEngine,
              all,
              0,
              siblings.ruleFixtures,
              courtCalendars,
              strandedCourtIds,
            ),
            courtTagQualifiedIds: [...courtTagQualifiedIds],
            // #622 — the per-fixture override. Both are sent: the map is the
            // exact answer for this division's own fixtures, the flat list is
            // what any OTHER row falls back to.
            courtTagQualifiedIdsByFixture,
          },
          siblings.assignments,
          feedDependencies(all),
        ),
        courtNames,
      ),
      ...officialConflicts.map((c) => ({ fixture_id: c.fixture_id, code: c.code as ScheduleConflict["code"], blocking: false })),
    ],
  };
}

export async function validateSchedule(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ conflicts: ScheduleConflict[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return validateScheduleIn(tx, divisionId, division.competition_id);
  });
}

// ---------------------------------------------------------------------------
// Publish & start (doc 12 §1 state machine)
// ---------------------------------------------------------------------------

export interface PublishScheduleOut {
  division_id: string;
  status: string;
  published: boolean;
}

// The two refusal codes now live in `lib/schedule-board` (isomorphic) so the
// board's confirm dialog can branch on them without importing this module.
// Re-exported unchanged: every server-side importer still reads them here.
export { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED };

/**
 * THE GATE, in one place, for the two actions that put a timetable in front of
 * players: publish, and start (which publishes on the way through).
 *
 * Deliberately not two copies of four lines. The publish gate and the start
 * gate must refuse the same boards with the same codes and the same payload —
 * that is what lets ONE confirm dialog in the console serve both buttons — and
 * a second copy is exactly how the placer and the verifier in this subsystem
 * drifted apart three times.
 *
 * It rejects CONFLICTS, never INCOMPLETENESS. `validateAssignments` reports
 * only on rows it is given as `assignments`, and `validateScheduleIn` builds
 * those from fixtures carrying BOTH a `scheduled_at` and a `court_id` — so
 * an empty or half-slotted board yields no assignments and therefore nothing to
 * report. Dozens of suites (and organisers) start divisions in exactly that
 * state; a gate that refused them would be the wrong gate.
 */
function assertPublishable(
  conflicts: readonly ScheduleConflict[],
  acknowledged: boolean,
): void {
  // Blocking is tested FIRST and independently of the flag. Folding the two
  // tests together — or testing the flag first — turns `acknowledge_warnings`
  // into an override for a physically impossible board.
  if (conflicts.some((c) => c.blocking)) {
    throw new HttpError(
      422,
      "this schedule cannot be published: the board has conflicts that must be fixed first",
      PUBLISH_BLOCKED,
      { conflicts },
    );
  }
  if (conflicts.length > 0 && !acknowledged) {
    throw new HttpError(
      422,
      "this schedule has warnings — confirm to publish it anyway",
      PUBLISH_UNACKNOWLEDGED,
      { conflicts },
    );
  }
}

/**
 * Record a publish on the division ledger. Returns the new seq.
 *
 * The report rides the event, so the ledger answers "what did this board look
 * like when it was published" — the question a dispute asks, and the one a count
 * of fixtures could never answer. Greenfield: older events carry
 * `fixturesScheduled` alone and no backfill is owed.
 *
 * Shared by `publishSchedule` and `startDivision` so a publish that happened on
 * the way into `active` is indistinguishable, in the ledger and in
 * `history-panel.tsx`, from one the organiser pressed Publish for.
 */
async function appendPublishedEvent(
  tx: Tx,
  divisionId: string,
  conflicts: readonly ScheduleConflict[],
  acknowledged: boolean,
  reason: string | undefined,
): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from fixtures
    where division_id = ${divisionId} and scheduled_at is not null`;
  return appendDivisionEvent(tx, divisionId, "schedule_published", {
    fixturesScheduled: n,
    conflicts,
    acknowledged,
    // Omitted rather than set to `undefined` — the payload is jsonb.
    ...(reason !== undefined ? { reason } : {}),
  });
}

/**
 * Publish the timetable (doc 12 §1.B step 4) — now behind a final validation
 * gate (#230 item 2).
 *
 * The board's conflicts panel is client-side and advisory, so before this gate
 * existed the only thing standing between a broken board and the public schedule
 * was whether the organiser happened to look at the panel recently. A settings
 * change, a new blackout, an entrant withdrawal or a cross-division edit moving
 * a shared court could all invalidate a board between the last look and the
 * publish, and publish counted fixtures with a `scheduled_at` and wrote.
 *
 * Three properties make this a gate rather than a second opinion:
 *
 *  - it runs `validateScheduleIn`, the SAME body the panel's `validateSchedule`
 *    runs. Not a publish-specific check: two validators is how the placer and
 *    the verifier drifted apart, three times.
 *  - it runs INSIDE this transaction and AFTER the advisory lock above, so no
 *    concurrent edit can land between the check and the event.
 *  - it is ABSOLUTE, not delta-based. `applySchedule`'s gate refuses only what a
 *    change introduced, so a dirty board stays editable; publish is the moment
 *    the board goes public, and "it was already broken" is not a reason to
 *    publish it broken.
 */
export async function publishSchedule(
  auth: AuthCtx,
  divisionId: string,
  input: PublishScheduleRequest = {},
): Promise<PublishScheduleOut> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const out = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    assertNotFrozen(frozen, division.competition_id);
    if (division.status === "completed") {
      throw new HttpError(422, "a completed division cannot publish a schedule");
    }

    // THE GATE. After the lock, before anything is written.
    const { conflicts } = await validateScheduleIn(tx, divisionId, division.competition_id);
    const acknowledged = input.acknowledge_warnings === true;
    assertPublishable(conflicts, acknowledged);

    const status = division.status === "setup" ? "scheduled" : division.status;
    if (status !== division.status) {
      await tx`update divisions set status = ${status} where id = ${divisionId}`;
    }
    const seq = await appendPublishedEvent(tx, divisionId, conflicts, acknowledged, input.reason);
    await tx`update divisions set seq = ${seq} where id = ${divisionId}`;
    // R10d n2: a publish moves no single fixture, so every public fixture
    // document of the division drops with the hub key.
    const fixtures = await tx<{ id: string }[]>`select id from fixtures where division_id = ${divisionId}`;
    return { competitionId: division.competition_id, status, fixtureIds: fixtures.map((f) => f.id) };
  });
  afterScheduleWrite(divisionId, out.competitionId, "publish", out.fixtureIds);
  return { division_id: divisionId, status: out.status, published: true };
}

export interface StartDivisionOut {
  division_id: string;
  status: string;
  started: boolean;
  generated: number;
}

/**
 * The "start tournament" action (doc 12 §1 — both modes end here). Quick-start
 * from setup generates the first stage's fixtures when none exist and, when
 * `roundMinutes` is configured, slots rolling times (round r at startAt +
 * (r−1)·roundMinutes). Scoring opens only after this (division_started).
 *
 * **Starting the tournament publishes the schedule** (#230 item 2 follow-up).
 * Not a second gate — the same one: `assertPublishable` over
 * `validateScheduleIn`, the same two codes, the same `acknowledge_warnings`
 * contract, so the console's confirm dialog serves Publish and Start with one
 * code path. Without this, the publish gate was a door beside an open window:
 * an organiser refused at Publish could press Start, `scoring.ts` opens scoring
 * on `active`, and the same broken timetable went live with nothing in the
 * ledger to say a publish had ever happened.
 *
 * Two orderings inside are load-bearing:
 *
 *  - the check runs AFTER the quick-start rolling-times write, in the same
 *    transaction. Before it, the board being judged does not exist yet — and a
 *    refusal rolls those times back with it, so a rejected start never leaves a
 *    half-slotted board behind.
 *  - `schedule_published` is appended BEFORE the status moves to `active`, and
 *    only when the division was still `setup`. `scheduled → active` is a start,
 *    not a second publish.
 */
export async function startDivision(
  auth: AuthCtx,
  divisionId: string,
  input: StartDivisionRequest = {},
): Promise<StartDivisionOut> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const pre = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    assertNotFrozen(frozen, division.competition_id);
    if (division.status === "completed") throw new HttpError(422, "division is completed");
    const [firstStage] = await tx<{ id: string; n: number }[]>`
      select s.id, (select count(*)::int from fixtures f where f.stage_id = s.id) as n
      from stages s where s.division_id = ${divisionId}
      order by s.seq limit 1`;
    if (!firstStage) throw new HttpError(422, "division has no stages to start");
    // Read here, ACTED ON below — see the two guards further down. The freeze
    // does not bind the start TRANSITION (that is deliberate: the design's own
    // customer story is freeze-then-publish, and `schedule-board.tsx` gates its
    // publish/start block on status while the freeze toggle fifteen lines above
    // reads `single.schedule_locked` — same component, same variable in scope,
    // different condition). It binds the two SCHEDULE WRITES this function can
    // make on the way through.
    return { ...division, firstStage, scheduleFrozen: (await divisionLockState(tx, divisionId)).frozen };
  });
  if (pre.status === "active") {
    return { division_id: divisionId, status: "active", started: false, generated: 0 };
  }

  // Quick-start: generate outside the status transaction (the generator takes
  // its own division lock).
  let generated = 0;
  if (pre.firstStage.n === 0) {
    // A start that GENERATES a stage's fixtures is creating the timetable, not
    // merely opening scoring on one — the widest schedule write in this
    // function. Refused on a frozen board, and refused HERE rather than at the
    // top of the function, so a start that generates nothing is untouched: the
    // freeze binds edits, and starting an already-built frozen board is the
    // intended path (see the pre-flight read above).
    if (pre.scheduleFrozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    // R10e: unpublished — this start publishes ONE write below, naming every
    // fixture of the division, the generated ones included.
    const outcome = await generateStageFixturesUnpublished(auth, pre.firstStage.id);
    generated = outcome.created;
  }

  const out = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    // R10d n2: a start moves no single fixture (it may generate the first stage
    // and write rolling times across it), so every public fixture document of
    // the division drops with the hub key. Read under the lock, after generation.
    const fixtureIds = (
      await tx<{ id: string }[]>`select id from fixtures where division_id = ${divisionId}`
    ).map((f) => f.id);
    if (!division || division.status === "active") return { started: false, fixtureIds };

    // Rolling quick-start times (doc 12 §1.A) — only for a straight
    // setup→active start; a published timetable is left untouched.
    const settings = await loadSettings(tx, divisionId);
    if (division.status === "setup" && settings.config.roundMinutes) {
      const startAt = settings.config.startAt
        ? ms(settings.config.startAt)
        : roundToMinute(Date.now());
      const step = settings.config.roundMinutes * MS_PER_MIN;
      const rounds = await tx<{ round_no: number }[]>`
        select distinct round_no from fixtures
        where stage_id = ${pre.firstStage.id} and scheduled_at is null
        order by round_no`;
      // The sweep below writes `scheduled_at` across the first stage, which is
      // a schedule edit whatever door it came through — so a frozen board
      // refuses it. Gated on `rounds.length`, not on reaching this branch: a
      // frozen division whose fixtures are already slotted has NOTHING for
      // this loop to write, and refusing it would break freeze-then-start for
      // no gain. Re-read inside THIS transaction rather than trusting the
      // pre-flight value, because this is where the write happens.
      if (rounds.length > 0 && (await divisionLockState(tx, divisionId)).frozen) {
        throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
      }
      for (const [i, r] of rounds.entries()) {
        await tx`
          update fixtures set scheduled_at = ${iso(startAt + i * step)}, schedule_source = 'auto'
          where stage_id = ${pre.firstStage.id} and round_no = ${r.round_no}
            and scheduled_at is null`;
      }
    }

    // THE GATE — the publish gate, reached by the other door. After the lock and
    // after the rolling-times write above, so it judges the board this call is
    // actually about to open scoring on.
    const { conflicts } = await validateScheduleIn(tx, divisionId, division.competition_id);
    const acknowledged = input.acknowledge_warnings === true;
    assertPublishable(conflicts, acknowledged);

    // Published on the way through, from `setup` only: this is the moment the
    // timetable goes in front of players, and the event is the only record
    // anywhere that it did (`history-panel.tsx` renders it).
    if (division.status === "setup") {
      await appendPublishedEvent(tx, divisionId, conflicts, acknowledged, input.reason);
    }

    await tx`update divisions set status = 'active' where id = ${divisionId}`;
    const seq = await appendDivisionEvent(tx, divisionId, "division_started", {
      from: division.status,
    });
    await tx`update divisions set seq = ${seq} where id = ${divisionId}`;
    return { started: true, fixtureIds };
  });
  afterScheduleWrite(divisionId, pre.competition_id, "start", out.fixtureIds);
  return { division_id: divisionId, status: "active", started: out.started, generated };
}
