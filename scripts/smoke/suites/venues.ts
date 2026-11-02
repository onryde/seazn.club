// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, timedFixture, smokeDb, v1, v1data } from "../harness.ts";

/** D5/P8 venues & courts: CRUD on the smoke org, a calendar PUT round-trip,
 *  and the two 409 codes that need real referential state to trigger —
 *  VENUE_NOT_EMPTY (a venue that still owns a court) needs nothing extra;
 *  COURT_IN_USE (a court a fixture references) needs `fixtures.court_id`
 *  set, which no application code writes yet this session (P9 wires the
 *  scheduler — see usecases/venues.ts's file header) — raw SQL is the only
 *  way to reach that state, so that one check self-gates on DATABASE_URL,
 *  same convention as configSnapshotSuite above. */
export async function venuesSuite(admin: Session, orgId: string): Promise<void> {
  const venue = v1data<{ id: string; name: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues`, "POST", {
      name: `Venue ${tag}`,
      address: "1 Main St",
    }),
  );
  check("venues: create venue", !!venue.id);

  const courtRes = await v1(admin, `/api/v1/orgs/${orgId}/venues/${venue.id}/courts`, "POST", {
    name: `Court ${tag}`,
    tags: ["Indoor", " hardwood "],
  });
  const court = v1data<{ id: string; name: string; tags: string[] }>(courtRes);
  check(
    "venues: create court normalises tags (trim/lowercase)",
    courtRes.status === 201 && court.tags.join(",") === "indoor,hardwood",
  );

  const patched = v1data<{ name: string; tags: string[] }>(
    await v1(admin, `/api/v1/orgs/${orgId}/courts/${court.id}`, "PATCH", {
      name: `Court ${tag} Renamed`,
    }),
  );
  check("venues: patch court renames it", patched.name === `Court ${tag} Renamed`);
  // fix/patch-schema-partial-defaults: the rename names no tags, so they stay (zod 4's `.partial()` used to fill `tags: []`).
  check("venues: patch court rename keeps its tags", patched.tags?.join(",") === "indoor,hardwood");

  const calRes = await v1(admin, `/api/v1/orgs/${orgId}/courts/${court.id}/calendar`, "PUT", {
    hours: [{ weekday: 1, open_min: 9 * 60, close_min: 17 * 60 }],
    exceptions: [{ date: "2030-12-25", closed: true, open_min: null, close_min: null }],
  });
  const cal = v1data<{ hours: { weekday: number }[]; exceptions: { date: string }[] }>(calRes);
  check(
    "venues: calendar PUT round-trips one range + one exception",
    calRes.status === 200 && cal.hours.length === 1 && cal.exceptions.length === 1,
  );

  const list = v1data<
    { id: string; courts: { id: string; hours: unknown[]; exceptions: unknown[] }[] }[]
  >(await v1(admin, `/api/v1/orgs/${orgId}/venues`));
  const listedCourt = list.find((v) => v.id === venue.id)?.courts.find((c) => c.id === court.id);
  check(
    "venues: list nests the court with its saved calendar",
    listedCourt?.hours.length === 1 && listedCourt?.exceptions.length === 1,
  );

  // VENUE_NOT_EMPTY: the venue still owns `court` above — no DB needed.
  const delVenue = await v1(admin, `/api/v1/orgs/${orgId}/venues/${venue.id}`, "DELETE");
  check(
    "venues: delete venue with courts -> 409 VENUE_NOT_EMPTY",
    delVenue.status === 409 && delVenue.json.error?.code === "VENUE_NOT_EMPTY",
  );

  if (!process.env.DATABASE_URL) {
    console.log("SKIP  venues: COURT_IN_USE check (DATABASE_URL not set)");
    // Nothing references the court at this point, so a plain delete-then-
    // delete cleans up fully. Left behind, these two rows trip the run's
    // OWN cleanup() at the very end with a raw FK violation rather than a
    // check failure — `courts.venue_id` is ON DELETE RESTRICT (V367 review
    // fix), so an org-cascade delete that reaches the venue row before the
    // court row is blocked outright. See the matching cleanup below.
    await v1(admin, `/api/v1/orgs/${orgId}/courts/${court.id}`, "DELETE");
    await v1(admin, `/api/v1/orgs/${orgId}/venues/${venue.id}`, "DELETE");
    return;
  }
  const db = smokeDb();
  try {
    const comp = v1data<{ id: string }>(
      await v1(admin, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `Venue Fixture ${tag}`,
        visibility: "private",
      }),
    );
    const fx = await timedFixture(admin, comp.id, {
      name: `Venue Fixture Div ${tag}`,
      sport_key: "generic",
      variant_key: "score",
      config: {
        resultMode: "score",
        allowDraws: true,
        points: { w: 3, d: 1, l: 0 },
        progressScore: false,
      },
      entrants: [
        { kind: "individual", display_name: "Venue Side A", seed: 1 },
        { kind: "individual", display_name: "Venue Side B", seed: 2 },
      ],
    });
    await db`update fixtures set court_id = ${court.id} where id = ${fx.fixtureId}`;
    const delCourt = await v1(admin, `/api/v1/orgs/${orgId}/courts/${court.id}`, "DELETE");
    check(
      "venues: delete court referenced by a fixture -> 409 COURT_IN_USE",
      delCourt.status === 409 && delCourt.json.error?.code === "COURT_IN_USE",
    );

    // Clean up: `courts.venue_id` is ON DELETE RESTRICT (V367 review fix) —
    // a venue+court left behind here trips the run's OWN cleanup() at the
    // very end with a raw FK violation ("update or delete on table venues
    // violates foreign key constraint courts_venue_id_org_id_fkey"), not a
    // check failure, so this isn't optional. Clear the artificial
    // `court_id` link first (this suite's own doing — nothing else writes
    // `fixtures.court_id` yet, see this file's header), then delete the
    // court, then the venue, now that neither blocks the other.
    await db`update fixtures set court_id = null where id = ${fx.fixtureId}`;
    const cleanCourt = await v1(admin, `/api/v1/orgs/${orgId}/courts/${court.id}`, "DELETE");
    check("venues: court deletes cleanly once unreferenced", cleanCourt.status === 200);
    const cleanVenue = await v1(admin, `/api/v1/orgs/${orgId}/venues/${venue.id}`, "DELETE");
    check("venues: venue deletes cleanly once its court is gone", cleanVenue.status === 200);
  } finally {
    await db.end();
  }
}
