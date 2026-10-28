// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/**
 * P9 pass 5 — a full schedule round on an org with TWO VENUES (not one venue
 * with two courts, which is the shape every other court-seeding suite in
 * this file — `autoScheduleSuite` immediately above included — already
 * uses). `ScheduleConfig.courts` is a plain array of court ids with no venue
 * structure of its own (V374 cutover), so a build that silently only ever
 * resolved courts through ONE venue's row would still pass every existing
 * "2 distinct courts" check in this file if it happened to seed both under
 * the same venue. This suite is the one place cross-venue resolution is the
 * thing under test: two venues, one court each, both configured as build
 * candidates, and the assertion is that the solved board used BOTH venues'
 * courts, not just one.
 */
export async function twoVenueScheduleSuite(): Promise<void> {
  const s = newSession();
  const orgId = (await signIn(s, `delivered+smoke-two-venue-${tag}@resend.dev`)).org_id;
  await setPlan(orgId, "pro", s);

  const venueNorth = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `North Sports Hall ${tag}` }),
  );
  const venueSouth = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `South Leisure Centre ${tag}` }),
  );
  const courtNorth = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${venueNorth.id}/courts`, "POST", {
      name: "Hall Court",
    }),
  );
  const courtSouth = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${venueSouth.id}/courts`, "POST", {
      name: "Centre Court",
    }),
  );

  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Two Venue ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Two Venues",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(
    s,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: `TV ${n}${tag}`,
      seed: i + 1,
    })),
  );
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const generated = v1data<{ fixtures: { id: string }[] }>(
    await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures;
  check("two venues: a 4-entrant round robin generated 6 fixtures", generated.length === 6);

  const START = "2026-09-22T09:00:00.000Z";
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: START,
      matchMinutes: 30,
      gapMinutes: 0,
      // Both venues' courts configured as candidates — the point is which
      // ones the SOLVER actually chooses, not "empty falls back to every
      // org court".
      courts: [courtNorth.id, courtSouth.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });

  interface AutoRun {
    assignments: {
      fixture_id: string;
      scheduled_at: string;
      court_id: string;
      court_name: string | null;
    }[];
    metrics?: { placed: number; total: number };
  }
  const build = v1data<AutoRun>(
    await v1(s, `/api/v1/stages/${stage.id}/schedule/auto`, "POST", { only_unlocked: false }),
  );
  check(
    "two venues: build placed every fixture, with a real court name on each",
    (build?.assignments ?? []).length === 6 &&
      build?.metrics?.placed === 6 &&
      (build?.assignments ?? []).every(
        (a) => a.court_name === "Hall Court" || a.court_name === "Centre Court",
      ),
  );
  const usedCourtIds = new Set((build?.assignments ?? []).map((a) => a.court_id));
  check(
    // Not just "2 distinct courts" — autoScheduleSuite already proves that
    // shape for a single-venue board. This is the one place the two courts
    // used are asserted to come from two DIFFERENT venues.
    "two venues: the board used courts from BOTH venues, not one",
    usedCourtIds.has(courtNorth.id) && usedCourtIds.has(courtSouth.id),
  );

  const applied = v1data<{ applied: number }>(
    await v1(s, `/api/v1/stages/${stage.id}/schedule/apply`, "POST", {
      assignments: (build?.assignments ?? []).map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    }),
  );
  check("two venues: the full cross-venue board applied", applied?.applied === 6);

  const validated = v1data<{ conflicts: unknown[] }>(
    await v1(s, `/api/v1/divisions/${div.id}/schedule/validate`, "POST"),
  );
  check(
    "two venues: /validate is clean after a real cross-venue schedule round",
    (validated?.conflicts ?? []).length === 0,
  );
}
