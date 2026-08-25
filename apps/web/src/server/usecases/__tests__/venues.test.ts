// Venues & courts (P8/D5a): CRUD + weekly-hours/exception calendar
// validation, tag hygiene, deletion-block guards, and cross-org RLS
// isolation. The pure validation helpers (hours overlap, exception
// precedence, tag hygiene) need no DB and are never skipped; the CRUD +
// isolation suite needs real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import {
  assertNoHoursOverlap,
  normalizeTags,
  createVenue,
  patchVenue,
  deleteVenue,
  listVenues,
  archiveVenue,
  unarchiveVenue,
  archiveCourt,
  unarchiveCourt,
  createCourt,
  patchCourt,
  deleteCourt,
  putCourtCalendar,
  PutCourtCalendarInput,
} from "../venues";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

describe("venues usecase — pure validation", () => {
  describe("normalizeTags", () => {
    it("trims, lowercases, dedupes and drops empties", () => {
      expect(normalizeTags(["  Clay ", "clay", "GRASS", "", "  ", "Hard"])).toEqual([
        "clay",
        "grass",
        "hard",
      ]);
    });

    it("empty input yields empty output", () => {
      expect(normalizeTags([])).toEqual([]);
    });
  });

  describe("assertNoHoursOverlap", () => {
    it("allows multiple non-overlapping ranges on the same weekday", () => {
      expect(() =>
        assertNoHoursOverlap([
          { weekday: 1, open_min: 540, close_min: 660 }, // 09:00-11:00
          { weekday: 1, open_min: 720, close_min: 840 }, // 12:00-14:00
        ]),
      ).not.toThrow();
    });

    it("allows the same range repeated on different weekdays", () => {
      expect(() =>
        assertNoHoursOverlap([
          { weekday: 1, open_min: 540, close_min: 660 },
          { weekday: 2, open_min: 540, close_min: 660 },
        ]),
      ).not.toThrow();
    });

    it("rejects two overlapping ranges on the same weekday", () => {
      expect(() =>
        assertNoHoursOverlap([
          { weekday: 3, open_min: 540, close_min: 660 }, // 09:00-11:00
          { weekday: 3, open_min: 600, close_min: 720 }, // 10:00-12:00 overlaps
        ]),
      ).toThrow(expect.objectContaining({ status: 422, code: "COURT_HOURS_OVERLAP" }));
    });

    it("rejects two ranges sharing the same start time", () => {
      expect(() =>
        assertNoHoursOverlap([
          { weekday: 4, open_min: 540, close_min: 600 },
          { weekday: 4, open_min: 540, close_min: 660 },
        ]),
      ).toThrow(expect.objectContaining({ code: "COURT_HOURS_OVERLAP" }));
    });

    it("back-to-back ranges (close == next open) do not overlap", () => {
      expect(() =>
        assertNoHoursOverlap([
          { weekday: 5, open_min: 540, close_min: 600 },
          { weekday: 5, open_min: 600, close_min: 660 },
        ]),
      ).not.toThrow();
    });
  });

  // resolveCourtDay's own unit coverage (exception-vs-weekday precedence)
  // was deleted with the function itself (P10 §2) — it was a fourth private
  // copy of the window rule, and the wire-normalisation case ("omitted
  // open/close minutes parse to null, not undefined") that used to close
  // this describe block is preserved below, now asserted directly against
  // the zod schema instead of through the deleted helper.
  it("PutCourtCalendarInput: omitted open/close minutes parse to null, not undefined", () => {
    // `.nullish()` alone parses an omitted field to `undefined`, which is not
    // a `CourtException`. Only tsc could see that — vitest never typechecks —
    // so this asserts the normalisation as behaviour rather than as a type.
    const parsed = PutCourtCalendarInput.parse({
      hours: [],
      exceptions: [{ date: "2026-08-18", closed: true }],
    });
    const exception = parsed.exceptions[0]!;
    expect(exception.open_min).toBeNull();
    expect(exception.close_min).toBeNull();
    expect(Object.hasOwn(exception, "open_min")).toBe(true);
  });
});

async function seedOrg(): Promise<{ auth: AuthCtx; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ven " + suffix}, ${"ven-" + suffix})
    returning id`;
  // Defensive (division-delete.test.ts precedent): a fresh unit-test DB may
  // not have run sync:sports.
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null }, orgId };
}

/** A fixture referencing `courtId`, standing up the full competition ->
 *  division -> stage chain a fixture needs. `status` drives the archive
 *  gate (unplayed = scheduled/in_play, everything else = history).
 *  `divisionId` is returned alongside for callers that also need to seed
 *  that division's `schedule_settings` (match duration, blackouts, session
 *  windows — see `setDivisionScheduleConfig`). */
async function seedFixtureOnCourt(
  auth: AuthCtx,
  courtId: string,
  status: string,
  scheduledAt?: string,
): Promise<{ fixtureId: string; divisionId: string }> {
  const comp = await createCompetition(auth, {
    name: `Comp ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
    ends_on: "2030-12-31",
  });
  const division = await createDivision(auth, comp.id, {
    name: "Div",
    slug: `div-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name)
    values (${division.id}, 1, 'league', 'Stage 1')
    returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, court_id, status, scheduled_at)
    values (${stageId}, ${division.id}, 1, 1, ${courtId}, ${status}, ${scheduledAt ?? null})
    returning id`;
  return { fixtureId, divisionId: division.id };
}

/** Writes one division's `schedule_settings.config` directly — standing in
 *  for `putScheduleSettings` (a different usecase, out of scope here) the
 *  same way every other `schedule_settings`-seeding test in this repo
 *  writes the row directly. `org_id` is deliberately omitted: unlike
 *  venues/courts/court_hours/court_exceptions (see this file's own header
 *  comment on `venues.ts`), `schedule_settings` DOES carry a
 *  `trg_set_org` BEFORE INSERT trigger (V114) that fills it in from
 *  `division_id`'s parent. */
async function setDivisionScheduleConfig(
  divisionId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, config, updated_at)
    values (${divisionId}, ${sql.json(config as never)}, now())
    on conflict (division_id) do update set config = excluded.config, updated_at = now()`;
}

/** Owner review finding 3, mutation-proving the race fix: `Promise.all` of
 *  two calls PROVES NOTHING here — verified on this repo's own `uniqueSlug`
 *  check-then-insert race fix, where the "lucky" non-colliding interleaving
 *  (one call's transaction fully commits before the other even starts) is
 *  the COMMON one, so a bare Promise.all test passed against the BROKEN code
 *  too. Poll instead until a session is actually parked waiting on a lock,
 *  then the caller releases the held lock and observes a deterministic, real
 *  interleaving. Row-level `FOR UPDATE` contention shows up in
 *  `pg_stat_activity.wait_event_type = 'Lock'` (a `transactionid` wait
 *  internally) — not as a `pg_locks` row scoped to the `venues`/`courts`
 *  relation, which is why this checks activity rather than trying to join
 *  `pg_locks` to a specific table.
 *
 *  This poll only proves contention if T1 ALREADY HOLDS the lock when the
 *  contender starts. Every caller therefore awaits a `locked` handshake
 *  resolved from inside T1's transaction before launching the contender:
 *  starting both from the same tick races T1's own `for update` against the
 *  contender's whole transaction, and on a fast runner the contender wins
 *  outright — it locks, checks, commits, and no session ever waits, so this
 *  poll times out (observed on CI 2026-08-19, `archiveCourt` leg). A timeout
 *  here also strands T1's open transaction, which then blocks `afterAll`'s
 *  cleanup deletes into a hook timeout. */
async function waitForLockContention(timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from pg_stat_activity where wait_event_type = 'Lock'`;
    if (row!.n !== "0") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitForLockContention: no session waiting on a lock within ${timeoutMs}ms`);
}

describe.skipIf(!HAS_DB)("venues usecase — DB", () => {
  const orgIds: string[] = [];

  afterAll(async () => {
    for (const id of orgIds) {
      // Competitions FIRST (cascades divisions -> stages -> fixtures) so no
      // fixture is left referencing a court by the time organizations'
      // cascade reaches venues -> courts. `delete from organizations` alone
      // fans out through BOTH paths in one statement, and empirically
      // (verified) still trips `fixtures.court_id`'s ON DELETE RESTRICT even
      // though it is DEFERRABLE INITIALLY DEFERRED — deferring only helps an
      // explicit multi-statement transaction that fixes ordering before
      // COMMIT, not a single statement's own internal cascade resolution.
      await sql`delete from competitions where org_id = ${id}`;
      // Courts NEXT (owner review finding 3, 2026-08-17): courts.venue_id is
      // now ON DELETE RESTRICT too (this migration shipped ON DELETE CASCADE
      // initially) — a court left under a venue would block organizations'
      // cascade into venues the same way a fixture used to block courts.
      // courts.org_id is denormalized, so this doesn't need to join venues.
      await sql`delete from courts where org_id = ${id}`;
      await sql`delete from organizations where id = ${id}`;
    }
  });

  async function org(): Promise<{ auth: AuthCtx; orgId: string }> {
    const seeded = await seedOrg();
    orgIds.push(seeded.orgId);
    return seeded;
  }

  it("creates, lists, patches and deletes a venue", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Riverside Courts", address: null, sort: 0 });
    expect(venue.name).toBe("Riverside Courts");

    const listed = await listVenues(auth);
    expect(listed.map((v) => v.id)).toContain(venue.id);

    const patched = await patchVenue(auth, venue.id, { name: "Riverside Courts (renamed)" });
    expect(patched.name).toBe("Riverside Courts (renamed)");

    await deleteVenue(auth, venue.id);
    const afterDelete = await listVenues(auth);
    expect(afterDelete.map((v) => v.id)).not.toContain(venue.id);
  });

  it("creates and patches a court with tag hygiene, then deletes it", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, {
      name: "Court 1",
      sort: 0,
      tags: ["  Clay ", "clay", "GRASS"],
    });
    expect(court.tags).toEqual(["clay", "grass"]);

    const patched = await patchCourt(auth, court.id, { tags: ["Hard", "hard", " "] });
    expect(patched.tags).toEqual(["hard"]);

    await deleteCourt(auth, court.id);
    const listed = await listVenues(auth);
    const v = listed.find((x) => x.id === venue.id)!;
    expect(v.courts.map((c) => c.id)).not.toContain(court.id);
  });

  it("blocks deleting a venue that still has courts (409 VENUE_NOT_EMPTY)", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Busy Park", address: null, sort: 0 });
    await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await expect(deleteVenue(auth, venue.id)).rejects.toMatchObject({
      status: 409,
      code: "VENUE_NOT_EMPTY",
    });
  });

  it("blocks deleting a court referenced by a fixture (409 COURT_IN_USE)", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Arena", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });

    await seedFixtureOnCourt(auth, court.id, "scheduled");

    await expect(deleteCourt(auth, court.id)).rejects.toMatchObject({
      status: 409,
      code: "COURT_IN_USE",
    });
  });

  it("archiveCourt allows archiving a court referenced only by COMPLETED fixtures", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "History Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await seedFixtureOnCourt(auth, court.id, "finalized");

    const archived = await archiveCourt(auth, court.id);
    expect(archived.archived_at).not.toBeNull();
    // Idempotent: archiving an already-archived court is a no-op, not an error.
    const archivedAgain = await archiveCourt(auth, court.id);
    expect(archivedAgain.archived_at).toEqual(archived.archived_at);
  });

  it("archiveCourt blocks a court referenced by an UNPLAYED fixture (409 COURT_IN_USE)", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Live Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await seedFixtureOnCourt(auth, court.id, "scheduled");

    await expect(archiveCourt(auth, court.id)).rejects.toMatchObject({
      status: 409,
      code: "COURT_IN_USE",
    });
  });

  it("archived courts are excluded from listVenues by default, and archiving frees the name for reuse", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Reuse Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court A", sort: 0, tags: [] });
    await archiveCourt(auth, court.id);

    const listed = await listVenues(auth);
    const v = listed.find((x) => x.id === venue.id)!;
    expect(v.courts.map((c) => c.id)).not.toContain(court.id);

    // Name frees up: a NEW active court with the same name in the same
    // venue must be allowed now that the old one is archived (partial
    // unique index on (venue_id, name) where archived_at is null).
    const reused = await createCourt(auth, venue.id, { name: "Court A", sort: 0, tags: [] });
    expect(reused.id).not.toBe(court.id);
  });

  it("unarchiveCourt restores a court, and 409s COURT_NAME_TAKEN if another active court now holds the name", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Restore Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court B", sort: 0, tags: [] });
    await archiveCourt(auth, court.id);

    const restored = await unarchiveCourt(auth, court.id);
    expect(restored.archived_at).toBeNull();
    // Idempotent.
    const restoredAgain = await unarchiveCourt(auth, court.id);
    expect(restoredAgain.archived_at).toBeNull();

    await archiveCourt(auth, court.id);
    await createCourt(auth, venue.id, { name: "Court B", sort: 0, tags: [] });
    await expect(unarchiveCourt(auth, court.id)).rejects.toMatchObject({
      status: 409,
      code: "COURT_NAME_TAKEN",
    });
  });

  it("archiveVenue succeeds when its courts carry only COMPLETED fixtures, drops out of listVenues by default, and reappears with includeArchived", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "History Venue", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await seedFixtureOnCourt(auth, court.id, "finalized");

    const archived = await archiveVenue(auth, venue.id);
    expect(archived.archived_at).not.toBeNull();

    const listed = await listVenues(auth);
    expect(listed.map((v) => v.id)).not.toContain(venue.id);

    const withArchived = await listVenues(auth, { includeArchived: true });
    expect(withArchived.map((v) => v.id)).toContain(venue.id);

    // Idempotent: archiving an already-archived venue is a no-op, not an error.
    const archivedAgain = await archiveVenue(auth, venue.id);
    expect(archivedAgain.archived_at).toEqual(archived.archived_at);
  });

  it("archiveVenue blocks when ANY court under it is referenced by an UNPLAYED fixture (409 VENUE_IN_USE)", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Live Venue", address: null, sort: 0 });
    const courtA = await createCourt(auth, venue.id, { name: "Court A", sort: 0, tags: [] });
    const courtB = await createCourt(auth, venue.id, { name: "Court B", sort: 0, tags: [] });
    // Court A's fixture is history; Court B's is still unplayed — the venue
    // gate must key on ANY court, not just the first one checked.
    await seedFixtureOnCourt(auth, courtA.id, "finalized");
    await seedFixtureOnCourt(auth, courtB.id, "scheduled");

    await expect(archiveVenue(auth, venue.id)).rejects.toMatchObject({
      status: 409,
      code: "VENUE_IN_USE",
    });
  });

  it("unarchiveVenue restores the venue only — courts keep their own independent archived_at", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Restore Venue", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await archiveCourt(auth, court.id);
    await archiveVenue(auth, venue.id);

    const restored = await unarchiveVenue(auth, venue.id);
    expect(restored.archived_at).toBeNull();

    // The court was archived independently BEFORE the venue archive — this
    // call must not cascade and restore it too.
    const [courtRow] = await sql<{ archived_at: string | null }[]>`
      select archived_at from courts where id = ${court.id}`;
    expect(courtRow!.archived_at).not.toBeNull();

    // Idempotent.
    const restoredAgain = await unarchiveVenue(auth, venue.id);
    expect(restoredAgain.archived_at).toBeNull();
  });

  it("PUT calendar reports an advisory strandedFixtureCount for unplayed fixtures now outside the new hours", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Advisory Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    // Tuesday 21:00 UTC (org has no timezone set -> UTC fallback); weekday 2
    // with 0 = Sunday, matching the engine tz module's getUTCDay() convention.
    await seedFixtureOnCourt(auth, court.id, "scheduled", "2026-08-18T21:00:00.000Z");

    const narrow = await putCourtCalendar(auth, court.id, {
      hours: [{ weekday: 2, open_min: 540, close_min: 1020 }], // 09:00-17:00
      exceptions: [],
    });
    expect(narrow.strandedFixtureCount).toBe(1);

    const wide = await putCourtCalendar(auth, court.id, {
      hours: [{ weekday: 2, open_min: 540, close_min: 1320 }], // 09:00-22:00
      exceptions: [],
    });
    expect(wide.strandedFixtureCount).toBe(0);
  });

  // -------------------------------------------------------------------
  // P10 §2: countStrandedFixtures moved onto the engine's usableWindows.
  // Three defects the old resolveCourtDay-based predicate carried, each
  // pinned here because each is a behavior a naive rewrite could still get
  // wrong: it tested only the fixture's START minute, it never looked at
  // blackouts/session windows at all, and it read organizations.timezone
  // raw instead of through the same resolveVenueTz resolver settings.orgTz
  // uses. 2026-08-18 is a Tuesday (weekday 2, 0 = Sunday), matching the
  // existing advisory-count test above.
  // -------------------------------------------------------------------

  it("counts a fixture that STARTS inside hours but ENDS after close as stranded", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Duration Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    // Court open Tue 09:00-10:00. A 60-minute fixture starting 09:30 fits the
    // START (inside 09:00-10:00) but ends 10:30, thirty minutes past close.
    // The old predicate tested only the start minute and called this a fit.
    const { divisionId } = await seedFixtureOnCourt(
      auth,
      court.id,
      "scheduled",
      "2026-08-18T09:30:00.000Z",
    );
    await setDivisionScheduleConfig(divisionId, { matchMinutes: 60 });

    const res = await putCourtCalendar(auth, court.id, {
      hours: [{ weekday: 2, open_min: 540, close_min: 600 }], // Tue 09:00-10:00
      exceptions: [],
    });
    expect(res.strandedFixtureCount).toBe(1);
  });

  it("counts a fixture sitting inside a blackout as stranded, even though the court is open all day", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Blackout Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    // Court open all day, so ONLY the blackout can strand this fixture — the
    // old predicate never looked at schedule_settings.config.blackouts at all.
    const { divisionId } = await seedFixtureOnCourt(
      auth,
      court.id,
      "scheduled",
      "2026-08-18T09:00:00.000Z",
    );
    await setDivisionScheduleConfig(divisionId, {
      matchMinutes: 30,
      blackouts: [{ from: "2026-08-18T08:00:00.000Z", to: "2026-08-18T10:00:00.000Z" }],
    });

    const res = await putCourtCalendar(auth, court.id, {
      hours: [{ weekday: 2, open_min: 0, close_min: 1440 }], // open all day
      exceptions: [],
    });
    expect(res.strandedFixtureCount).toBe(1);
  });

  it("resolves the org timezone through the same resolveVenueTz resolver settings.orgTz uses, not organizations.timezone read raw", async () => {
    const { auth, orgId } = await org();
    const venue = await createVenue(auth, { name: "TZ Guard Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    // A non-IANA value in organizations.timezone. resolveVenueTz treats
    // anything isValidIana rejects as absent and falls back to UTC; reading
    // the column raw (the old `org?.timezone ?? "UTC"`, which substitutes
    // only on null/undefined) fed this straight to the Intl-backed day/weekday
    // helpers instead, which throw on an unrecognised zone.
    await sql`update organizations set timezone = 'not-a-real-zone' where id = ${orgId}`;
    await seedFixtureOnCourt(auth, court.id, "scheduled", "2026-08-18T09:30:00.000Z"); // Tue 09:30 UTC

    const res = await putCourtCalendar(auth, court.id, {
      hours: [{ weekday: 2, open_min: 540, close_min: 600 }], // Tue 09:00-10:00, post-UTC-fallback
      exceptions: [],
    });
    expect(res.strandedFixtureCount).toBe(0);
  });

  it("PUT calendar replaces hours + exceptions atomically and round-trips", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Calendar Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });

    await putCourtCalendar(auth, court.id, {
      hours: [
        { weekday: 1, open_min: 540, close_min: 660 },
        { weekday: 1, open_min: 720, close_min: 840 },
      ],
      exceptions: [{ date: "2026-09-01", closed: true, open_min: null, close_min: null }],
    });

    const listed = await listVenues(auth);
    const c = listed.find((v) => v.id === venue.id)!.courts.find((x) => x.id === court.id)!;
    expect(c.hours).toEqual([
      { weekday: 1, open_min: 540, close_min: 660 },
      { weekday: 1, open_min: 720, close_min: 840 },
    ]);
    expect(c.exceptions).toEqual([
      { date: "2026-09-01", closed: true, open_min: null, close_min: null },
    ]);

    // A second PUT fully REPLACES — the first exception must be gone.
    await putCourtCalendar(auth, court.id, {
      hours: [{ weekday: 2, open_min: 600, close_min: 720 }],
      exceptions: [],
    });
    const listed2 = await listVenues(auth);
    const c2 = listed2.find((v) => v.id === venue.id)!.courts.find((x) => x.id === court.id)!;
    expect(c2.hours).toEqual([{ weekday: 2, open_min: 600, close_min: 720 }]);
    expect(c2.exceptions).toEqual([]);
  });

  it("PUT calendar rejects overlapping hours before writing anything (422)", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Strict Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });

    await expect(
      putCourtCalendar(auth, court.id, {
        hours: [
          { weekday: 1, open_min: 540, close_min: 660 },
          { weekday: 1, open_min: 600, close_min: 720 },
        ],
        exceptions: [],
      }),
    ).rejects.toMatchObject({ status: 422, code: "COURT_HOURS_OVERLAP" });

    // Nothing was written — the pre-write assertNoHoursOverlap check ran
    // before the transaction opened.
    const listed = await listVenues(auth);
    const c = listed.find((v) => v.id === venue.id)!.courts.find((x) => x.id === court.id)!;
    expect(c.hours).toEqual([]);
  });

  it("cross-org: another org cannot write or read a venue it doesn't own", async () => {
    const { auth: authA } = await org();
    const { auth: authB } = await org();
    const venueA = await createVenue(authA, { name: "Org A Courts", address: null, sort: 0 });

    // WRITE rejected — RLS makes org A's row invisible to org B's tenant conn.
    await expect(patchVenue(authB, venueA.id, { name: "hijacked" })).rejects.toMatchObject({
      status: 404,
      code: "VENUE_NOT_FOUND",
    });
    await expect(deleteVenue(authB, venueA.id)).rejects.toMatchObject({
      status: 404,
      code: "VENUE_NOT_FOUND",
    });
    // Referencing org A's venue as a parent from org B is blocked the same
    // way — the venue lookup inside createCourt is RLS-scoped too.
    await expect(
      createCourt(authB, venueA.id, { name: "Sneaky Court", sort: 0, tags: [] }),
    ).rejects.toMatchObject({ status: 404, code: "VENUE_NOT_FOUND" });

    // READ rejected — org B's list never contains org A's venue.
    const listedByB = await listVenues(authB);
    expect(listedByB.map((v) => v.id)).not.toContain(venueA.id);
  });

  // ---------------------------------------------------------------------
  // Owner review findings, 2026-08-17
  // ---------------------------------------------------------------------

  it("finding 1: includeArchived also reveals archived courts — unreachable before, since there is no single-court GET", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Include Archived Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court A", sort: 0, tags: [] });
    await archiveCourt(auth, court.id);

    const defaultListed = await listVenues(auth);
    const vDefault = defaultListed.find((x) => x.id === venue.id)!;
    expect(vDefault.courts.map((c) => c.id)).not.toContain(court.id);

    const withArchived = await listVenues(auth, { includeArchived: true });
    const vWithArchived = withArchived.find((x) => x.id === venue.id)!;
    expect(vWithArchived.courts.map((c) => c.id)).toContain(court.id);
  });

  it("finding 2: createCourt 409s COURT_NAME_TAKEN instead of a raw 500 on a duplicate active name", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Dup Park", address: null, sort: 0 });
    await createCourt(auth, venue.id, { name: "Court X", sort: 0, tags: [] });

    await expect(
      createCourt(auth, venue.id, { name: "Court X", sort: 0, tags: [] }),
    ).rejects.toMatchObject({ status: 409, code: "COURT_NAME_TAKEN" });
  });

  it("finding 2: patchCourt 409s COURT_NAME_TAKEN instead of a raw 500 when renamed onto a taken active name", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Dup Park 2", address: null, sort: 0 });
    const courtA = await createCourt(auth, venue.id, { name: "Court Y", sort: 0, tags: [] });
    await createCourt(auth, venue.id, { name: "Court Z", sort: 0, tags: [] });

    await expect(patchCourt(auth, courtA.id, { name: "Court Z" })).rejects.toMatchObject({
      status: 409,
      code: "COURT_NAME_TAKEN",
    });
  });

  it("finding 3: deleteVenue refuses loudly instead of cascading a venue's courts away, even if the application guard is bypassed (DB-level backstop)", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Backstop Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });

    // Raw SQL, deliberately bypassing deleteVenue's own "has no courts"
    // guard entirely — proves the DDL guarantee (courts.venue_id is now ON
    // DELETE RESTRICT, not CASCADE), not the application-level check.
    await expect(sql`delete from venues where id = ${venue.id}`).rejects.toThrow();

    const [survivor] = await sql<{ id: string }[]>`select id from courts where id = ${court.id}`;
    expect(survivor?.id).toBe(court.id);
  });

  it("finding 3: deleteVenue's row lock closes the race — a court that lands mid-check is seen, not missed (409, never a silent cascade)", async () => {
    const { auth, orgId } = await org();
    const venue = await createVenue(auth, { name: "Race Park A", address: null, sort: 0 });

    let releaseT1 = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    let t1Locked = () => {};
    const locked = new Promise<void>((resolve) => {
      t1Locked = resolve;
    });
    let insertedCourtId = "";
    const t1 = sql.begin(async (tx1) => {
      // Mirrors createCourt's own locking SELECT — holds the venue row FOR
      // UPDATE, inserts a court, then PAUSES before committing.
      await tx1`select id from venues where id = ${venue.id} for update`;
      const [c] = await tx1<{ id: string }[]>`
        insert into courts (venue_id, org_id, name, sort, tags)
        values (${venue.id}, ${orgId}, 'Racer Court', 0, '{}')
        returning id`;
      insertedCourtId = c!.id;
      t1Locked();
      await gate;
    });

    // T1 must already HOLD the lock before the contender starts — see
    // waitForLockContention's note on why this handshake is required.
    await Promise.race([locked, t1]);
    const deleteCall = deleteVenue(auth, venue.id);

    // Proves genuine contention, not a lucky non-overlapping interleave.
    await waitForLockContention();
    releaseT1();
    await t1;

    await expect(deleteCall).rejects.toMatchObject({ status: 409, code: "VENUE_NOT_EMPTY" });
    const [survivor] = await sql<{ id: string }[]>`
      select id from courts where id = ${insertedCourtId}`;
    expect(survivor?.id).toBe(insertedCourtId);
  });

  it("finding 3: createCourt's row lock closes the race — once a concurrent delete commits, the loser 404s instead of inserting under a gone venue", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Race Park B", address: null, sort: 0 });

    let releaseT1 = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    let t1Locked = () => {};
    const locked = new Promise<void>((resolve) => {
      t1Locked = resolve;
    });
    const t1 = sql.begin(async (tx1) => {
      // Mirrors deleteVenue's own locking SELECT — holds the venue row FOR
      // UPDATE (the venue has no courts yet, so the real guard would pass),
      // then PAUSES before actually deleting it.
      await tx1`select id from venues where id = ${venue.id} for update`;
      t1Locked();
      await gate;
      await tx1`delete from venues where id = ${venue.id}`;
    });

    // T1 must already HOLD the lock before the contender starts — see
    // waitForLockContention's note on why this handshake is required.
    await Promise.race([locked, t1]);
    const createCall = createCourt(auth, venue.id, { name: "Late Court", sort: 0, tags: [] });

    await waitForLockContention();
    releaseT1();
    await t1;

    await expect(createCall).rejects.toMatchObject({ status: 404, code: "VENUE_NOT_FOUND" });
  });

  it("finding 3: archiveCourt's row lock is taken BEFORE the fixture-check — a fixture-writer that lands while it waits is seen, not raced past", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Race Park C", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });

    // Stand up a fixture chain (competition -> division -> stage) WITHOUT
    // yet inserting the fixture itself — T1 below inserts the fixture,
    // after taking the SAME lock archiveCourt takes, so the two genuinely
    // contend for the resource finding 3 is about. A test that only proved
    // "archiveCourt eventually succeeds after some unrelated lock is
    // released" would pass even with the fix reverted (the final UPDATE
    // takes an equivalent lock implicitly) — this exercises the ordering
    // that actually matters: whether the fixture-CHECK runs before or
    // after the lock is acquired.
    const comp = await createCompetition(auth, {
      name: `Comp ${randomUUID().slice(0, 6)}`,
      visibility: "private",
      branding: {},
      ends_on: "2030-12-31",
    });
    const division = await createDivision(auth, comp.id, {
      name: "Div",
      slug: `div-${randomUUID().slice(0, 6)}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, seq, kind, name)
      values (${division.id}, 1, 'league', 'Stage 1') returning id`;

    let releaseT1 = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    let t1Locked = () => {};
    const locked = new Promise<void>((resolve) => {
      t1Locked = resolve;
    });
    const t1 = sql.begin(async (tx1) => {
      // Simulates a future fixture-writer (P9, not built yet this session):
      // locks the court row FOR UPDATE — the same lock archiveCourt takes —
      // then inserts an UNPLAYED fixture referencing it, then pauses before
      // committing.
      await tx1`select id from courts where id = ${court.id} for update`;
      await tx1`
        insert into fixtures (stage_id, division_id, round_no, seq_in_round, court_id, status)
        values (${stageId}, ${division.id}, 1, 1, ${court.id}, 'scheduled')`;
      t1Locked();
      await gate;
    });

    // T1 must already HOLD the lock before the contender starts — see
    // waitForLockContention's note on why this handshake is required.
    await Promise.race([locked, t1]);
    const archiveCall = archiveCourt(auth, court.id);

    await waitForLockContention();
    releaseT1();
    await t1;

    // archiveCourt must see the fixture that landed while it waited — not
    // archive on a stale "no unplayed fixture" read taken before the lock.
    await expect(archiveCall).rejects.toMatchObject({ status: 409, code: "COURT_IN_USE" });
  });

  it("finding 4: fixtures.court_id FK is composite — a court from a different org cannot be referenced (DB-level cross-org guard)", async () => {
    const { auth: authA } = await org();
    const { auth: authB } = await org();
    const venueA = await createVenue(authA, { name: "Org A Venue", address: null, sort: 0 });
    const courtA = await createCourt(authA, venueA.id, { name: "Court A1", sort: 0, tags: [] });

    // Nothing writes fixtures.court_id yet this session (P9's job) — reach
    // straight for the DB-level guarantee via the same raw insert
    // seedFixtureOnCourt uses, just pointed at a FOREIGN org's court. Before
    // finding 4, the single-column `references courts(id)` FK accepted this
    // (courtA.id is a real, valid court id) even though it belongs to a
    // different org than the fixture chain built here under org B.
    await expect(seedFixtureOnCourt(authB, courtA.id, "scheduled")).rejects.toThrow();
  });

  it("finding 5: courts_active_idx was dropped as redundant against courts_venue_name_active_idx", async () => {
    const schema = process.env.DB_SCHEMA ?? "seazn_club";
    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where schemaname = ${schema} and tablename = 'courts'`;
    const names = indexes.map((i) => i.indexname);
    expect(names).not.toContain("courts_active_idx");
    expect(names).toContain("courts_venue_name_active_idx");
  });

  it("finding 6: cross-org — another org cannot patch, delete, archive, unarchive, or set a calendar for a court it doesn't own", async () => {
    const { auth: authA } = await org();
    const { auth: authB } = await org();
    const venueA = await createVenue(authA, { name: "Org A Arena", address: null, sort: 0 });
    const courtA = await createCourt(authA, venueA.id, { name: "Court A1", sort: 0, tags: [] });

    await expect(patchCourt(authB, courtA.id, { name: "hijacked" })).rejects.toMatchObject({
      status: 404,
      code: "COURT_NOT_FOUND",
    });
    await expect(deleteCourt(authB, courtA.id)).rejects.toMatchObject({
      status: 404,
      code: "COURT_NOT_FOUND",
    });
    await expect(archiveCourt(authB, courtA.id)).rejects.toMatchObject({
      status: 404,
      code: "COURT_NOT_FOUND",
    });
    await expect(unarchiveCourt(authB, courtA.id)).rejects.toMatchObject({
      status: 404,
      code: "COURT_NOT_FOUND",
    });
    await expect(
      putCourtCalendar(authB, courtA.id, { hours: [], exceptions: [] }),
    ).rejects.toMatchObject({ status: 404, code: "COURT_NOT_FOUND" });
  });

  it("finding 7: PUT calendar rejects two exceptions sharing the same date (422 COURT_EXCEPTION_DUPLICATE_DATE)", async () => {
    const { auth } = await org();
    const venue = await createVenue(auth, { name: "Dup Exception Park", address: null, sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });

    await expect(
      putCourtCalendar(auth, court.id, {
        hours: [],
        exceptions: [
          { date: "2026-09-01", closed: true, open_min: null, close_min: null },
          { date: "2026-09-01", closed: false, open_min: 600, close_min: 720 },
        ],
      }),
    ).rejects.toMatchObject({ status: 422, code: "COURT_EXCEPTION_DUPLICATE_DATE" });
  });
});
