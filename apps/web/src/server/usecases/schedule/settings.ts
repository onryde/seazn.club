import "server-only";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { resolveVenueTz } from "@/lib/tz";
import { ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ScheduleConfig, type PutScheduleSettings } from "@/server/api-v1/schemas";
import { assertNotFrozen, frozenCompetitionIds } from "../entitlement-freeze";
import type { Tx, ScheduleSettingsOut } from "./types";
import { ms } from "./helpers";
import { FIXED_OCCUPYING, courtNamesById } from "./board";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

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
