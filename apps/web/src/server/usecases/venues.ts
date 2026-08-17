import "server-only";
// Venues & courts as entities (D5/P8): courts were config-level strings
// (`fixtures.venue`/`court_label`, free text) with no reuse across
// competitions, no availability, no filtering. This usecase is the CRUD +
// calendar surface for the new `venues`/`courts`/`court_hours`/
// `court_exceptions` tables (V367). No consumer switch this session —
// `court_label` keeps working untouched; `fixtures.court_id` is written by
// nobody yet (P9 migrates stored schedule configs and switches readers).
//
// org_id is denormalized onto courts/court_hours/court_exceptions (session
// ruling, see docs/superpowers/plans/2026-08-17-p8-session-status.md) and
// pinned to the parent by a composite FK in V367 — every insert here must
// pass org_id explicitly (unlike stages/fixtures, these tables have no
// `set_org_from_parent` trigger; a value that disagreed with the parent
// would fail the FK, not silently pass).
import { z } from "zod";
import type postgres from "postgres";
import { dayKeyInTz, hhmmInTz, weekdayOfYmd, type Weekday } from "@seazn/engine/scheduling/tz";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";

// db.ts declares its own `Tx` internally but does not export it — every
// usecase that needs the transaction type redeclares this same one-liner
// (see discipline.ts/entrants.ts/exports.ts for the precedent).
type Tx = postgres.TransactionSql;

// 0 = Sunday, matching `weekdayOfYmd`'s own `getUTCDay()`-based convention
// (see V367's header comment) — court_hours.weekday and the advisory
// stranded-fixture check below both key off this same order.
const WEEKDAY_LABELS: readonly Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Fixture statuses that still need a court (per the owner ruling: the
 *  archive gate keys on STATUS, never date). Everything else — decided,
 *  finalized, abandoned, forfeited, cancelled — is history. */
const UNPLAYED_FIXTURE_STATUSES = ["scheduled", "in_play"] as const;

// ---------------------------------------------------------------------------
// Typed error codes (repo convention: ALL_CAPS_SNAKE — see capacity-guard.ts's
// CAPACITY_IMPOSSIBLE_CODE and schemas.ts:3107's ruling. The design doc's
// `court.in_use`/`venue.not_empty` are i18n-key-shaped, not this tree's typed
// HttpError code convention; ported to the repo's actual spelling).
// ---------------------------------------------------------------------------

export const VENUE_NOT_FOUND_CODE = "VENUE_NOT_FOUND";
export const VENUE_NOT_EMPTY_CODE = "VENUE_NOT_EMPTY";
export const VENUE_IN_USE_CODE = "VENUE_IN_USE";
export const COURT_NOT_FOUND_CODE = "COURT_NOT_FOUND";
export const COURT_IN_USE_CODE = "COURT_IN_USE";
export const COURT_HOURS_OVERLAP_CODE = "COURT_HOURS_OVERLAP";
export const COURT_EXCEPTION_DUPLICATE_DATE_CODE = "COURT_EXCEPTION_DUPLICATE_DATE";
export const COURT_NAME_TAKEN_CODE = "COURT_NAME_TAKEN";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface VenueRow {
  id: string;
  org_id: string;
  name: string;
  address: string | null;
  sort: number;
  archived_at: string | null;
  created_at: string;
}

export interface CourtRow {
  id: string;
  venue_id: string;
  org_id: string;
  name: string;
  sort: number;
  tags: string[];
  archived_at: string | null;
  created_at: string;
}

export interface CourtHoursRange {
  weekday: number;
  open_min: number;
  close_min: number;
}

export interface CourtException {
  date: string;
  closed: boolean;
  open_min: number | null;
  close_min: number | null;
}

export interface CourtWithCalendar extends CourtRow {
  hours: CourtHoursRange[];
  exceptions: CourtException[];
}

export interface VenueWithCourts extends VenueRow {
  courts: CourtWithCalendar[];
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const CreateVenueInput = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).nullish(),
  sort: z.number().int().default(0),
});
export type CreateVenueInput = z.infer<typeof CreateVenueInput>;

export const PatchVenueInput = CreateVenueInput.partial();
export type PatchVenueInput = z.infer<typeof PatchVenueInput>;

export const CreateCourtInput = z.object({
  name: z.string().min(1).max(200),
  sort: z.number().int().default(0),
  tags: z.array(z.string().min(1).max(40)).max(50).default([]),
});
export type CreateCourtInput = z.infer<typeof CreateCourtInput>;

export const PatchCourtInput = CreateCourtInput.partial();
export type PatchCourtInput = z.infer<typeof PatchCourtInput>;

const CourtHourRangeInput = z
  .object({
    weekday: z.number().int().min(0).max(6),
    open_min: z.number().int().min(0).max(1440),
    close_min: z.number().int().min(0).max(1440),
  })
  .refine((r) => r.open_min < r.close_min, {
    message: "open_min must be before close_min",
    path: ["close_min"],
  });

const CourtExceptionInput = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
    closed: z.boolean(),
    // `.default(null)` is load-bearing, not decoration: `.nullish()` alone
    // infers `open_min?: number | null | undefined`, which is not assignable
    // to `CourtException.open_min: number | null`. Normalising an omitted
    // value to null at the parse boundary keeps the internal type strict
    // instead of widening it to carry `undefined` down to the DB layer.
    open_min: z.number().int().min(0).max(1440).nullish().default(null),
    close_min: z.number().int().min(0).max(1440).nullish().default(null),
  })
  .refine(
    (e) =>
      e.closed
        ? e.open_min == null && e.close_min == null
        : e.open_min != null && e.close_min != null && e.open_min < e.close_min,
    {
      message:
        "a closed exception must omit open/close minutes; an open exception needs both, open before close",
    },
  );

export const PutCourtCalendarInput = z.object({
  hours: z.array(CourtHourRangeInput).max(200).default([]),
  exceptions: z.array(CourtExceptionInput).max(500).default([]),
});
export type PutCourtCalendarInput = z.infer<typeof PutCourtCalendarInput>;

// ---------------------------------------------------------------------------
// Pure validation helpers (no DB — unit-tested directly)
// ---------------------------------------------------------------------------

/** Trim, lowercase, dedupe (first-seen order), drop empties. Tags are
 *  free-form org-scoped slugs — there is no global registry (design doc,
 *  "Tag semantics"). */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Multiple ranges per weekday are allowed; two ranges on the same weekday
 * must not overlap. Equal start times count as an overlap too (the DB pk on
 * (court_id, weekday, open_min) would otherwise surface as a raw
 * constraint-violation 500 instead of this clean 422) — sorting by open_min
 * and comparing each pair to its predecessor catches both in one pass.
 * Back-to-back ranges (one's close_min == the next's open_min) are NOT an
 * overlap.
 */
export function assertNoHoursOverlap(hours: readonly CourtHoursRange[]): void {
  const byWeekday = new Map<number, CourtHoursRange[]>();
  for (const h of hours) {
    const list = byWeekday.get(h.weekday) ?? [];
    list.push(h);
    byWeekday.set(h.weekday, list);
  }
  for (const [weekday, ranges] of byWeekday) {
    const sorted = [...ranges].sort((a, b) => a.open_min - b.open_min);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.open_min < sorted[i - 1]!.close_min) {
        throw new HttpError(
          422,
          `Overlapping hours on weekday ${weekday}`,
          COURT_HOURS_OVERLAP_CODE,
          { weekday },
        );
      }
    }
  }
}

function assertNoDuplicateExceptionDates(exceptions: readonly CourtException[]): void {
  const seen = new Set<string>();
  for (const e of exceptions) {
    if (seen.has(e.date)) {
      throw new HttpError(
        422,
        `Duplicate exception date ${e.date}`,
        COURT_EXCEPTION_DUPLICATE_DATE_CODE,
        { date: e.date },
      );
    }
    seen.add(e.date);
  }
}

/**
 * Resolves the windows open for a court on one calendar date: an exception
 * row for that date wins OUTRIGHT over the weekday's court_hours rows
 * (closed ⇒ no windows at all); with no exception, the weekday's hours apply
 * verbatim (possibly several ranges, possibly none). Pure, no I/O.
 *
 * This is NOT P10's `usableWindows` (packages/engine/src/scheduling/
 * court-windows.ts, session ruling #2) — that function additionally
 * intersects session windows and subtracts blackouts, both of which need
 * `ScheduleConfig`, out of scope this session. This helper is the P8-owned
 * subset: hours-vs-exception precedence only.
 */
export function resolveCourtDay(
  hours: readonly CourtHoursRange[],
  exceptions: readonly CourtException[],
  weekday: number,
  date: string,
): { open_min: number; close_min: number }[] {
  const exception = exceptions.find((e) => e.date === date);
  if (exception) {
    if (exception.closed) return [];
    return [{ open_min: exception.open_min!, close_min: exception.close_min! }];
  }
  return hours
    .filter((h) => h.weekday === weekday)
    .map((h) => ({ open_min: h.open_min, close_min: h.close_min }))
    .sort((a, b) => a.open_min - b.open_min);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const VENUE_COLS = ["id", "org_id", "name", "address", "sort", "archived_at", "created_at"] as const;
const COURT_COLS = [
  "id", "venue_id", "org_id", "name", "sort", "tags", "archived_at", "created_at",
] as const;

/** A SQL `date` column comes back from postgres.js as a `Date` at UTC
 *  midnight; extract the wall date with UTC getters so the host's local
 *  timezone can never shift it by a day. */
function toDateStr(d: string | Date): string {
  if (typeof d === "string") return d.slice(0, 10);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Venues with their courts nested, each court carrying its full calendar
 *  (hours + exceptions). There is no separate GET for courts or a court's
 *  calendar in the API surface (design doc, "API surface (P8)") — this is
 *  the one read path everything hangs off. Three flat queries + in-memory
 *  assembly rather than N+1 per court.
 *
 *  Archived venues AND archived courts are hidden by default, both keyed
 *  off the same `opts.includeArchived` flag (same parameter name/shape/
 *  default as `listDivisions`' opt-in; `?archived=1` at the route). Owner
 *  review finding 1 (2026-08-17): courts used to stay unconditionally
 *  filtered to active-only regardless of this flag, which made an archived
 *  court unreachable by any endpoint — there is still no separate GET for a
 *  single court, so this list is the ONLY way the UI's archived-courts
 *  toggle (amendment A5) can ever see one. */
export async function listVenues(
  auth: AuthCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<VenueWithCourts[]> {
  return withTenant(auth.orgId, async (tx) => {
    const venues = await tx<VenueRow[]>`
      select ${tx(VENUE_COLS)} from venues
      ${opts.includeArchived ? tx`` : tx`where archived_at is null`}
      order by sort, name, id`;
    const courts = await tx<CourtRow[]>`
      select ${tx(COURT_COLS)} from courts
      ${opts.includeArchived ? tx`` : tx`where archived_at is null`}
      order by sort, name, id`;
    const hours = await tx<(CourtHoursRange & { court_id: string })[]>`
      select court_id, weekday, open_min, close_min from court_hours
      order by court_id, weekday, open_min`;
    const exceptions = await tx<
      { court_id: string; date: string | Date; closed: boolean; open_min: number | null; close_min: number | null }[]
    >`
      select court_id, date, closed, open_min, close_min from court_exceptions
      order by court_id, date`;

    const hoursByCourt = new Map<string, CourtHoursRange[]>();
    for (const h of hours) {
      const list = hoursByCourt.get(h.court_id) ?? [];
      list.push({ weekday: h.weekday, open_min: h.open_min, close_min: h.close_min });
      hoursByCourt.set(h.court_id, list);
    }
    const exceptionsByCourt = new Map<string, CourtException[]>();
    for (const e of exceptions) {
      const list = exceptionsByCourt.get(e.court_id) ?? [];
      list.push({
        date: toDateStr(e.date),
        closed: e.closed,
        open_min: e.open_min,
        close_min: e.close_min,
      });
      exceptionsByCourt.set(e.court_id, list);
    }
    const courtsByVenue = new Map<string, CourtWithCalendar[]>();
    for (const c of courts) {
      const list = courtsByVenue.get(c.venue_id) ?? [];
      list.push({
        ...c,
        hours: hoursByCourt.get(c.id) ?? [],
        exceptions: exceptionsByCourt.get(c.id) ?? [],
      });
      courtsByVenue.set(c.venue_id, list);
    }
    return venues.map((v) => ({ ...v, courts: courtsByVenue.get(v.id) ?? [] }));
  });
}

export async function createVenue(auth: AuthCtx, input: CreateVenueInput): Promise<VenueRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const [v] = await tx<VenueRow[]>`
      insert into venues (org_id, name, address, sort)
      values (${auth.orgId}, ${input.name}, ${input.address ?? null}, ${input.sort})
      returning ${tx(VENUE_COLS)}`;
    return v!;
  });
  log.info({ orgId: auth.orgId, venueId: row.id }, "venue_created");
  return row;
}

export async function patchVenue(
  auth: AuthCtx,
  id: string,
  patch: PatchVenueInput,
): Promise<VenueRow> {
  const cols = Object.keys(patch);
  if (cols.length === 0) throw new HttpError(400, "empty patch");
  const row = await withTenant(auth.orgId, async (tx) => {
    const [v] = await tx<VenueRow[]>`
      update venues set ${tx(patch as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(VENUE_COLS)}`;
    if (!v) throw new HttpError(404, "venue not found", VENUE_NOT_FOUND_CODE);
    return v;
  });
  log.info({ orgId: auth.orgId, venueId: id }, "venue_updated");
  return row;
}

/** Courts must be removed first (soft-block — design doc's "reassign
 *  first"): a venue with courts is 409 VENUE_NOT_EMPTY, never a cascade.
 *
 *  Owner review finding 3 (2026-08-17): the "has no courts" SELECT and the
 *  DELETE are separate statements, so under READ COMMITTED (`withTenant`
 *  sets no isolation level) a court created concurrently between the two
 *  used to be silently cascade-deleted instead of blocking this call — the
 *  same bug CLASS this repo already shipped once (the `uniqueSlug`
 *  check-then-insert race). Closed in BOTH layers: `for update` below locks
 *  the venue row so this call and a concurrent `createCourt` (which takes
 *  the same lock on its own venue lookup) always serialize on it — whichever
 *  commits first is the state the other one sees; and `courts.venue_id` is
 *  now `on delete restrict` (V367), so if this application-level guard is
 *  ever bypassed some other way the database refuses the delete loudly
 *  instead of cascading a venue's courts away silently. */
export async function deleteVenue(auth: AuthCtx, id: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<{ id: string }[]>`
      select id from venues where id = ${id} for update`;
    if (!existing) throw new HttpError(404, "venue not found", VENUE_NOT_FOUND_CODE);
    const [court] = await tx<{ id: string }[]>`
      select id from courts where venue_id = ${id} limit 1`;
    if (court) {
      throw new HttpError(
        409,
        "Delete this venue's courts first",
        VENUE_NOT_EMPTY_CODE,
      );
    }
    await tx`delete from venues where id = ${id}`;
  });
  log.info({ orgId: auth.orgId, venueId: id }, "venue_deleted");
}

/**
 * Shared predicate behind every archive-or-block gate (owner ruling, A3
 * amendment): true iff ANY of the given courts is referenced by a still
 * UNPLAYED fixture (`scheduled`/`in_play`). `archiveCourt` below calls this
 * with its own single id; `archiveVenue` calls it with every court the
 * venue owns — one rule, two call sites, so the venue gate can never drift
 * into a second copy of the court gate. An empty `courtIds` (a venue with
 * no courts at all) short-circuits to `false` without a query — postgres.js's
 * `tx(array)` IN-list helper does not accept an empty array.
 */
async function anyCourtHasUnplayedFixture(tx: Tx, courtIds: readonly string[]): Promise<boolean> {
  if (courtIds.length === 0) return false;
  const [unplayed] = await tx<{ id: string }[]>`
    select id from fixtures
    where court_id in ${tx(courtIds)} and status in ${tx(UNPLAYED_FIXTURE_STATUSES)}
    limit 1`;
  return !!unplayed;
}

/**
 * Archive-or-block, mirrored from `archiveCourt` transitively across every
 * court the venue owns (owner ruling, A3 amendment, D5/P8): a venue is
 * blocked from archiving iff any of its courts is referenced by an
 * UNPLAYED fixture, via the shared `anyCourtHasUnplayedFixture` predicate
 * above — never a second copy of the court rule. A venue whose courts
 * carry only COMPLETED-fixture history (or no fixture history, or no
 * courts at all) can always be archived. Idempotent: archiving an
 * already-archived venue is a no-op, not an error.
 */
export async function archiveVenue(auth: AuthCtx, id: string): Promise<VenueRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<VenueRow[]>`select ${tx(VENUE_COLS)} from venues where id = ${id}`;
    if (!existing) throw new HttpError(404, "venue not found", VENUE_NOT_FOUND_CODE);
    if (existing.archived_at !== null) return existing;
    // `for update` (owner review finding 3, same locking treatment as
    // `deleteVenue` above): dormant today — nothing writes
    // `fixtures.court_id` yet this session — but closes half the protocol
    // ahead of P9's writer, which will need to take a matching lock on a
    // court row before inserting a fixture that references it for the pair
    // to actually serialize.
    const courts = await tx<{ id: string }[]>`
      select id from courts where venue_id = ${id} for update`;
    if (await anyCourtHasUnplayedFixture(tx, courts.map((c) => c.id))) {
      throw new HttpError(
        409,
        "A court at this venue has an unplayed fixture — reassign it before archiving",
        VENUE_IN_USE_CODE,
      );
    }
    const [updated] = await tx<VenueRow[]>`
      update venues set archived_at = now() where id = ${id} returning ${tx(VENUE_COLS)}`;
    return updated!;
  });
  log.info({ orgId: auth.orgId, venueId: id }, "venue_archived");
  return row;
}

/** Restore an archived venue. Idempotent. Unlike `unarchiveCourt`, there is
 *  no name-collision to catch here — `venues` carries no name-uniqueness
 *  constraint at all (only `courts` does, and only among active courts;
 *  V367). Restores the VENUE ONLY: courts keep their own independent
 *  `archived_at`, untouched by this call — a court archived on its own
 *  before, during or after the venue's archive window stays exactly as it
 *  was. This is deliberate (owner ruling), NOT a gap to "fix" into a
 *  cascade: cascading would silently reverse an operator's separate,
 *  unrelated decision to archive that specific court.
 */
export async function unarchiveVenue(auth: AuthCtx, id: string): Promise<VenueRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<VenueRow[]>`select ${tx(VENUE_COLS)} from venues where id = ${id}`;
    if (!existing) throw new HttpError(404, "venue not found", VENUE_NOT_FOUND_CODE);
    if (existing.archived_at === null) return existing;
    const [updated] = await tx<VenueRow[]>`
      update venues set archived_at = null where id = ${id} returning ${tx(VENUE_COLS)}`;
    return updated!;
  });
  log.info({ orgId: auth.orgId, venueId: id }, "venue_unarchived");
  return row;
}

/** Owner review finding 3: `for update` on the venue lookup is the other
 *  half of `deleteVenue`'s lock — the two calls contend for the same venue
 *  row, so a delete in flight is waited out (and re-checked, not assumed)
 *  instead of a court landing under a venue that just disappeared.
 *
 *  Owner review finding 2: a unique violation on
 *  `courts_venue_name_active_idx` (a duplicate active name in this venue)
 *  used to fall through to a raw 500 — caught here the same way
 *  `unarchiveCourt` already catches its own instance of the identical
 *  constraint. */
export async function createCourt(
  auth: AuthCtx,
  venueId: string,
  input: CreateCourtInput,
): Promise<CourtRow> {
  const tags = normalizeTags(input.tags);
  const row = await withTenant(auth.orgId, async (tx) => {
    const [venue] = await tx<{ id: string }[]>`
      select id from venues where id = ${venueId} for update`;
    if (!venue) throw new HttpError(404, "venue not found", VENUE_NOT_FOUND_CODE);
    try {
      const [c] = await tx<CourtRow[]>`
        insert into courts (venue_id, org_id, name, sort, tags)
        values (${venueId}, ${auth.orgId}, ${input.name}, ${input.sort}, ${tx.array(tags)})
        returning ${tx(COURT_COLS)}`;
      return c!;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "23505") {
        throw new HttpError(
          409,
          `An active court is already named "${input.name}" in this venue`,
          COURT_NAME_TAKEN_CODE,
        );
      }
      throw err;
    }
  });
  log.info({ orgId: auth.orgId, courtId: row.id, venueId }, "court_created");
  return row;
}

/** Owner review finding 2: same `COURT_NAME_TAKEN` catch as `createCourt`
 *  above and `unarchiveCourt` below — a rename onto another active court's
 *  name hits the identical `courts_venue_name_active_idx` violation and
 *  used to fall through to a raw 500. */
export async function patchCourt(
  auth: AuthCtx,
  id: string,
  patch: PatchCourtInput,
): Promise<CourtRow> {
  const cols = Object.keys(patch);
  if (cols.length === 0) throw new HttpError(400, "empty patch");
  const dbPatch = {
    ...patch,
    ...(patch.tags ? { tags: sql.array(normalizeTags(patch.tags)) } : {}),
  };
  const row = await withTenant(auth.orgId, async (tx) => {
    let c: CourtRow | undefined;
    try {
      [c] = await tx<CourtRow[]>`
        update courts set ${tx(dbPatch as never, ...(cols as never[]))}
        where id = ${id} returning ${tx(COURT_COLS)}`;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "23505") {
        throw new HttpError(
          409,
          `An active court is already named "${patch.name ?? ""}" in this venue`,
          COURT_NAME_TAKEN_CODE,
        );
      }
      throw err;
    }
    if (!c) throw new HttpError(404, "court not found", COURT_NOT_FOUND_CODE);
    return c;
  });
  log.info({ orgId: auth.orgId, courtId: id }, "court_updated");
  return row;
}

/** A court referenced by ANY fixture (played or not) is 409 COURT_IN_USE —
 *  `fixtures.court_id` is `on delete restrict`, so this check is a friendly
 *  message ahead of a DDL guarantee, not the only thing stopping the delete.
 *  A court with only COMPLETED-fixture history can still be archived
 *  instead (`archiveCourt`) — hard delete stays reserved for a court with
 *  no fixture reference at all. Deleting a clean court cascades its own
 *  court_hours/court_exceptions rows (FK on delete cascade). */
export async function deleteCourt(auth: AuthCtx, id: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<{ id: string }[]>`select id from courts where id = ${id}`;
    if (!existing) throw new HttpError(404, "court not found", COURT_NOT_FOUND_CODE);
    const [fixture] = await tx<{ id: string }[]>`
      select id from fixtures where court_id = ${id} limit 1`;
    if (fixture) {
      throw new HttpError(
        409,
        "This court has fixture history — archive it instead, or reassign every fixture first",
        COURT_IN_USE_CODE,
      );
    }
    await tx`delete from courts where id = ${id}`;
  });
  log.info({ orgId: auth.orgId, courtId: id }, "court_deleted");
}

/**
 * Archive-or-block (owner ruling, D5/P8 amendment): a court referenced by
 * any UNPLAYED fixture (`scheduled`/`in_play` — still needs somewhere to
 * happen) is 409 COURT_IN_USE, same as delete; a court referenced only by
 * COMPLETED fixtures (or none at all) can always be archived — that is the
 * end state a permanently-lost hall needs, since `deleteCourt` stays
 * blocked by its fixture history forever. Idempotent: archiving an
 * already-archived court is a no-op, not an error.
 */
export async function archiveCourt(auth: AuthCtx, id: string): Promise<CourtRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    // `for update` (owner review finding 3, same locking treatment as
    // `deleteVenue`/`archiveVenue`): dormant today for the same reason —
    // see `archiveVenue`'s comment on its own courts lookup.
    const [existing] = await tx<CourtRow[]>`
      select ${tx(COURT_COLS)} from courts where id = ${id} for update`;
    if (!existing) throw new HttpError(404, "court not found", COURT_NOT_FOUND_CODE);
    if (existing.archived_at !== null) return existing;
    if (await anyCourtHasUnplayedFixture(tx, [id])) {
      throw new HttpError(
        409,
        "This court has an unplayed fixture — reassign it before archiving",
        COURT_IN_USE_CODE,
      );
    }
    const [updated] = await tx<CourtRow[]>`
      update courts set archived_at = now() where id = ${id} returning ${tx(COURT_COLS)}`;
    return updated!;
  });
  log.info({ orgId: auth.orgId, courtId: id }, "court_archived");
  return row;
}

/** Restore an archived court. Idempotent. The freed name (see V367's
 *  partial unique index) may have been taken by a new active court in the
 *  meantime — that DB-level collision is caught here and reported as a
 *  typed 409 rather than a raw constraint-violation 500. */
export async function unarchiveCourt(auth: AuthCtx, id: string): Promise<CourtRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<CourtRow[]>`select ${tx(COURT_COLS)} from courts where id = ${id}`;
    if (!existing) throw new HttpError(404, "court not found", COURT_NOT_FOUND_CODE);
    if (existing.archived_at === null) return existing;
    try {
      const [updated] = await tx<CourtRow[]>`
        update courts set archived_at = null where id = ${id} returning ${tx(COURT_COLS)}`;
      return updated!;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "23505") {
        throw new HttpError(
          409,
          `An active court is already named "${existing.name}" in this venue`,
          COURT_NAME_TAKEN_CODE,
        );
      }
      throw err;
    }
  });
  log.info({ orgId: auth.orgId, courtId: id }, "court_unarchived");
  return row;
}

/** Local minutes-since-midnight for one fixture's `scheduled_at`, resolved
 *  in `tz` (DST-correct — reuses the engine's `Intl`-backed helpers, never
 *  hand-rolled). Returns the Ymd alongside so the caller can resolve the
 *  right weekday/exception for that specific date. */
function localFixtureSlot(scheduledAt: Date, tz: string): { ymd: string; weekday: number; minute: number } {
  const ms = scheduledAt.getTime();
  const ymd = dayKeyInTz(ms, tz);
  const weekday = WEEKDAY_LABELS.indexOf(weekdayOfYmd(ymd));
  const [h, m] = hhmmInTz(ms, tz).split(":").map(Number) as [number, number];
  return { ymd, weekday, minute: h * 60 + m };
}

/** Advisory-only (owner ruling): how many of this court's still-UNPLAYED
 *  fixtures now fall outside the just-written calendar. Non-blocking — the
 *  write already happened by the time this runs — because a real conflict
 *  code needs `usableWindows` (session windows, blackouts), which is P10's
 *  (out of scope this session; `ScheduleConfig` stays untouched). Uses the
 *  ORG's timezone uniformly rather than resolving each fixture's own
 *  division's `schedule_settings.tz` — a deliberate simplification for a
 *  best-effort count, not the scheduler's own authority. */
async function countStrandedFixtures(
  orgId: string,
  courtId: string,
  hours: readonly CourtHoursRange[],
  exceptions: readonly CourtException[],
): Promise<number> {
  const [org] = await sql<{ timezone: string | null }[]>`
    select timezone from organizations where id = ${orgId}`;
  const tz = org?.timezone ?? "UTC";
  const fixtures = await sql<{ scheduled_at: Date }[]>`
    select scheduled_at from fixtures
    where court_id = ${courtId} and scheduled_at is not null
      and status in ${sql(UNPLAYED_FIXTURE_STATUSES)}`;
  let stranded = 0;
  for (const f of fixtures) {
    const { ymd, weekday, minute } = localFixtureSlot(f.scheduled_at, tz);
    const windows = resolveCourtDay(hours, exceptions, weekday, ymd);
    const fits = windows.some((w) => minute >= w.open_min && minute < w.close_min);
    if (!fits) stranded++;
  }
  return stranded;
}

/** Full replace of a court's weekly hours + exceptions in ONE transaction —
 *  no per-row PATCH surface (design doc). Validated BEFORE the transaction
 *  opens, so a rejected write leaves the stored calendar untouched. Returns
 *  an ADVISORY count of unplayed fixtures the new calendar now strands
 *  (owner ruling — non-blocking; the real conflict code is P10's). */
export async function putCourtCalendar(
  auth: AuthCtx,
  courtId: string,
  input: PutCourtCalendarInput,
): Promise<{
  court_id: string;
  hours: CourtHoursRange[];
  exceptions: CourtException[];
  strandedFixtureCount: number;
}> {
  assertNoHoursOverlap(input.hours);
  assertNoDuplicateExceptionDates(input.exceptions);
  await withTenant(auth.orgId, async (tx) => {
    const [court] = await tx<{ id: string }[]>`select id from courts where id = ${courtId}`;
    if (!court) throw new HttpError(404, "court not found", COURT_NOT_FOUND_CODE);
    await tx`delete from court_hours where court_id = ${courtId}`;
    await tx`delete from court_exceptions where court_id = ${courtId}`;
    for (const h of input.hours) {
      await tx`
        insert into court_hours (court_id, org_id, weekday, open_min, close_min)
        values (${courtId}, ${auth.orgId}, ${h.weekday}, ${h.open_min}, ${h.close_min})`;
    }
    for (const e of input.exceptions) {
      await tx`
        insert into court_exceptions (court_id, org_id, date, closed, open_min, close_min)
        values (${courtId}, ${auth.orgId}, ${e.date}, ${e.closed},
                ${e.open_min ?? null}, ${e.close_min ?? null})`;
    }
  });
  const strandedFixtureCount = await countStrandedFixtures(
    auth.orgId,
    courtId,
    input.hours,
    input.exceptions,
  );
  log.info(
    {
      orgId: auth.orgId,
      courtId,
      hoursCount: input.hours.length,
      exceptionsCount: input.exceptions.length,
      strandedFixtureCount,
    },
    "court_calendar_replaced",
  );
  return { court_id: courtId, hours: input.hours, exceptions: input.exceptions, strandedFixtureCount };
}
