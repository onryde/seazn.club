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
  resolveCourtDay,
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

  describe("resolveCourtDay — exception override precedence", () => {
    const hours = [{ weekday: 2, open_min: 540, close_min: 1200 }]; // Tue 09:00-20:00

    it("falls back to the weekday's hours when no exception exists", () => {
      expect(resolveCourtDay(hours, [], 2, "2026-08-18")).toEqual([
        { open_min: 540, close_min: 1200 },
      ]);
    });

    it("a closed exception wins over the weekday's hours (no windows)", () => {
      const exceptions = [{ date: "2026-08-18", closed: true, open_min: null, close_min: null }];
      expect(resolveCourtDay(hours, exceptions, 2, "2026-08-18")).toEqual([]);
    });

    it("an open exception's own window wins over the weekday's hours", () => {
      const exceptions = [{ date: "2026-08-18", closed: false, open_min: 600, close_min: 720 }];
      expect(resolveCourtDay(hours, exceptions, 2, "2026-08-18")).toEqual([
        { open_min: 600, close_min: 720 },
      ]);
    });

    it("an exception on a different date does not affect this date", () => {
      const exceptions = [{ date: "2026-08-19", closed: true, open_min: null, close_min: null }];
      expect(resolveCourtDay(hours, exceptions, 2, "2026-08-18")).toEqual([
        { open_min: 540, close_min: 1200 },
      ]);
    });

    // Every case above hands the helper an EXPLICIT `open_min: null`. The wire
    // form of a closed exception omits the field entirely, and that path had no
    // coverage: `.nullish()` alone parsed it to `undefined`, which is not a
    // `CourtException`. Only tsc could see it — vitest never typechecks — so
    // this asserts the normalisation as behaviour rather than as a type.
    it("omitted open/close minutes parse to null, not undefined", () => {
      const parsed = PutCourtCalendarInput.parse({
        hours: [],
        exceptions: [{ date: "2026-08-18", closed: true }],
      });
      const exception = parsed.exceptions[0]!;
      expect(exception.open_min).toBeNull();
      expect(exception.close_min).toBeNull();
      expect(Object.hasOwn(exception, "open_min")).toBe(true);
      expect(resolveCourtDay(hours, parsed.exceptions, 2, "2026-08-18")).toEqual([]);
    });
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
 *  gate (unplayed = scheduled/in_play, everything else = history). */
async function seedFixtureOnCourt(
  auth: AuthCtx,
  courtId: string,
  status: string,
  scheduledAt?: string,
): Promise<{ fixtureId: string }> {
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
  return { fixtureId };
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
});
