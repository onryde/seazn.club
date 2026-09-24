import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  scoreFixture,
  seedVenueWithCourts,
  type OrgInfo,
} from "./helpers";
import { DRAW_BYE_SLOT_LABEL, isSitOutBye } from "../src/lib/fixture-bye";

// F4/P2 (wave B): a subscribed calendar is a surface an organiser hands out
// to other people, so the day-one final has to be IN it, served as real
// bytes over HTTP — not merely proven in a unit test. `request`-only, no
// `page` — this spec has no UI to check at any width, so it must NOT join
// the seven-width viewport matrix in mobile.spec.ts (a separate filename
// already keeps it out of every mobile-*/tablet-* project's testMatch;
// playwright.config.ts's "parallel" project testIgnore is [SERIAL_SPECS,
// /mobile\.spec\.ts/], so this file lands there like knockout.spec.ts does).
//
// Fixture: a plain 4-entrant knockout stage reproduces "a fixture that
// exists but has no time" without needing a catalogue template. A knockout's
// generate() call inserts ALL rounds' fixture rows up front (Task 1 —
// bracketToGen/generateStageFixtures, apps/web/src/server/usecases/
// stages.ts:1117-1155): any fixture whose home/away is fed by ANOTHER
// fixture from the SAME generate() batch (semi -> final here) is written
// with a { key: "slot.winner_match", params: { round, seq } } label — no
// entrant, no scheduled_at — resolved at render time to "Winner of {ref}".
// Same mechanism proved directly against buildDivisionDocModel in
// apps/web/src/server/usecases/__tests__/exports.test.ts's bracket tests.
// The division is left in its just-generated status (never /start'd,
// nothing scheduled): calendar.ics/route.ts:43 notes public_fixtures_v
// NULLs scheduled_at for every fixture while divisions.status = 'setup',
// which is exactly the "exists but unscheduled" shape this feature targets
// — so the final's slot-labelled placeholder is what proves the SUMMARY
// text, and the null scheduled_at (real, not just view-masked) is what
// proves the TENTATIVE/all-day/DTSTART;VALUE=DATE branch.
test("the public .ics carries an unscheduled final as a tentative all-day event", async ({
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Cal ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, "create competition").toBeLessThan(300);
  const compId = comp.data!.id;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status, "create division").toBeLessThan(300);
  const divisionId = div.data!.id;

  await addEntrantsViaApi(request, divisionId, ["Seed1", "Seed2", "Seed3", "Seed4"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Cup",
  });
  expect(fixtureIds.length, "4-entrant knockout: 2 semis + 1 final").toBe(3);

  const fixtures = await Promise.all(
    fixtureIds.map((id) =>
      apiJson<{
        id: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
      }>(request, `/api/v1/fixtures/${id}`).then((r) => r.data!),
    ),
  );
  const final = fixtures.find((f) => !f.home_entrant_id && !f.away_entrant_id);
  expect(final, "the final's slots are unresolved before either semi is played").toBeTruthy();

  // /shared/... needs the org/competition/division SLUGS, not ids — resolved
  // via the API rather than hardcoded, since this is a freshly-seeded org and
  // no demo slug is guaranteed to exist.
  const compData = await apiJson<{ org_id: string; slug: string }>(
    request,
    `/api/v1/competitions/${compId}`,
  );
  const divData = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);
  const orgs = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === compData.data!.org_id)?.slug;
  expect(orgSlug, "the current session must be a member of the org that owns this competition").toBeTruthy();

  const url = `/shared/${orgSlug}/${compData.data!.slug}/${divData.data!.slug}/calendar.ics`;
  const res = await request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/calendar");

  const body = await res.text();
  expect(body).toContain("BEGIN:VEVENT");
  expect(body).toContain("STATUS:TENTATIVE");
  expect(body).toContain("DTSTART;VALUE=DATE:");
  // The label, not the placeholder — anchored on `Winner of` so a bare
  // "TBD" cannot satisfy it.
  expect(body).toMatch(/SUMMARY:.*Winner of /);
  expect(body).not.toMatch(/SUMMARY:TBD vs TBD/);
  // The event is keyed on the FINAL's own fixture id specifically, not just
  // some tentative event somewhere in the feed — this is what lets a client
  // calendar update the same event in place once the fixture is scheduled,
  // rather than duplicating it.
  expect(body).toContain(`UID:${final!.id}@seazn.club`);
});

// B1 (owner ruling 2026-08-24): the OLD ?entrant= predicate excluded every
// unresolved fixture by construction (both entrant ids are null on one,
// which satisfies neither `=== entrantId` comparison), so a subscribing
// player never received the final they were heading toward. Reuses the SAME
// 4-entrant knockout shape as the test above — one semi's own entrant is the
// subscriber here, and the still-unresolved final is what the fix must add
// back to THEIR feed specifically, not just the whole-division one already
// covered above.
test("the ?entrant= feed still carries an unresolved final that names neither side", async ({
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Cal Entrant ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  const compId = comp.data!.id;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;

  await addEntrantsViaApi(request, divisionId, ["Seed1", "Seed2", "Seed3", "Seed4"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Cup",
  });
  expect(fixtureIds.length, "4-entrant knockout: 2 semis + 1 final").toBe(3);

  const fixtures = await Promise.all(
    fixtureIds.map((id) =>
      apiJson<{
        id: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
      }>(request, `/api/v1/fixtures/${id}`).then((r) => r.data!),
    ),
  );
  const final = fixtures.find((f) => !f.home_entrant_id && !f.away_entrant_id);
  const semi = fixtures.find((f) => f.home_entrant_id !== null);
  expect(final, "the final's slots are unresolved before either semi is played").toBeTruthy();
  expect(semi, "a semi with a real entrant on it").toBeTruthy();
  const subscriberEntrantId = semi!.home_entrant_id!;

  const compData = await apiJson<{ org_id: string; slug: string }>(
    request,
    `/api/v1/competitions/${compId}`,
  );
  const divData = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);
  const orgs = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === compData.data!.org_id)?.slug;

  const res = await request.get(
    `/shared/${orgSlug}/${compData.data!.slug}/${divData.data!.slug}/calendar.ics?entrant=${subscriberEntrantId}`,
  );
  expect(res.status()).toBe(200);
  const body = await res.text();

  // The subscriber's own semi is still there…
  expect(body).toContain(`UID:${semi!.id}@seazn.club`);
  // …and so, now, is the final neither of its slots names this entrant.
  expect(
    body,
    "the ?entrant= feed dropped the final it is meant to route the subscriber toward",
  ).toContain(`UID:${final!.id}@seazn.club`);
});

// P9 review wave 2, finding #5 — the widest-reaching defect in either review
// pass, and the one with NO end-to-end coverage until now.
//
// `applySchedule` wrote `court_id` but left `venue_id = coalesce(<absent>,
// venue_id)`, and no client sends `venue_id`. Since the cutover every
// player-facing venue string derives from `fixtures.venue_id`, so a scheduled
// fixture carried NO venue: the .ics lost its LOCATION line entirely, and /me,
// /my-matches and the public fixture page showed nothing. A unit test on the
// column proves the write; only this proves the bytes a subscriber's calendar
// actually receives.
//
// Deliberately over HTTP against the real route, for the same reason the case
// above is: a calendar is a surface an organiser hands to other people.
test("the public .ics carries the venue and court a fixture was scheduled onto", async ({
  request,
}) => {
  const { courts, venueId } = await seedVenueWithCourts(request, ["Centre Court"], {
    venueName: `ICS Venue ${TAG}`,
  });
  expect(venueId, "seeded a real venue").toBeTruthy();

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Cal Venue ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
    "POST",
    {
      name: "League",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;

  await addEntrantsViaApi(request, divisionId, ["A", "B"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "league",
    name: "League",
  });
  expect(fixtureIds.length).toBeGreaterThan(0);

  // Schedule through the SAME apply path the board uses. Note it sends
  // `court_id` ONLY — exactly like every real client, which is what made the
  // old coalesce leave `venue_id` null.
  const applied = await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
    assignments: [
      {
        fixture_id: fixtureIds[0]!,
        scheduled_at: "2030-06-01T09:00:00.000Z",
        court_id: courts[0]!.id,
      },
    ],
  });
  expect(applied.status, "apply the schedule").toBeLessThan(300);

  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST", {});

  const compData = await apiJson<{ org_id: string; slug: string }>(
    request,
    `/api/v1/competitions/${compId}`,
  );
  const divData = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);
  const orgs = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === compData.data!.org_id)?.slug;

  const res = await request.get(
    `/shared/${orgSlug}/${compData.data!.slug}/${divData.data!.slug}/calendar.ics`,
  );
  expect(res.status()).toBe(200);
  const body = await res.text();

  // The venue reaches the subscriber. Anchored on the LOCATION line itself,
  // not merely on the venue name appearing anywhere in the payload — the
  // name also occurs nowhere else here, but an unanchored check would start
  // passing the day it does.
  expect(body, "no LOCATION line at all — this is exactly what finding #5 caused").toMatch(
    /LOCATION:.*ICS Venue/,
  );
  // …and the court rides with it.
  expect(body).toMatch(/LOCATION:.*Centre Court/);
  // Never the raw identity.
  expect(body).not.toMatch(/LOCATION:.*[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

// #850 review round 3 (orchestrator reading of the owner's second-round ICS
// ruling): a knockout sit-out the DRAW made is not an event, wherever the
// bracket finds it — not only the first-round bye. A 3-entrant knockout with a
// third-place match is the plainest case: the draw's bye drops nobody into the
// third-place line, so once the real semi is played its loser is settled into
// third place with nobody to play. Before the fix that line carried the PLAIN
// bye label and went out as an all-day "X vs Bye" event. Over HTTP, against
// the real route; the played semi and the final are the positive pair, so an
// empty feed cannot pass.
test("a 3-entrant knockout's third-place bye is the draw's sit-out: the feed drops it and keeps the played semi and the final", async ({
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Cal 3P ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, "create competition").toBeLessThan(300);
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Cup",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, "create division").toBeLessThan(300);
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ash", "Beech", "Cherry"].map((n) => `${n} ${TAG}`));
  await createStageAndGenerate(request, divisionId, { kind: "knockout", name: "Cup", config: { thirdPlace: true } });
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST", {})).status).toBeLessThan(300);

  type Row = {
    id: string;
    status: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    home_slot_label: unknown;
    away_slot_label: unknown;
    outcome: unknown;
    is_final?: boolean;
    third_place?: boolean;
  };
  const list = async () => (await apiJson<Row[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!;
  const semi = (await list()).find((f) => f.status === "scheduled" && f.home_entrant_id && f.away_entrant_id);
  expect(semi, "the one real semi is playable").toBeTruthy();
  await scoreFixture(request, semi!.id, 2, 1);

  const rows = await list();
  const third = rows.find((f) => f.third_place)!;
  const final = rows.find((f) => f.is_final)!;
  const drawBye = rows.find((f) => f.id !== third.id && isSitOutBye(f, "knockout"))!;
  expect(drawBye, "premise: the first-round draw bye").toBeTruthy();
  expect(third.status, "the third-place line is settled once the semi is played").toBe("forfeited");
  expect(third.home_entrant_id === null ? third.home_slot_label : third.away_slot_label, "…as the draw's sit-out").toEqual(
    DRAW_BYE_SLOT_LABEL,
  );

  const compData = await apiJson<{ org_id: string; slug: string }>(request, `/api/v1/competitions/${compId}`);
  const divData = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);
  const orgs = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === compData.data!.org_id)?.slug;
  const res = await request.get(`/shared/${orgSlug}/${compData.data!.slug}/${divData.data!.slug}/calendar.ics`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body, "the third-place sit-out is not an event").not.toContain(`UID:${third.id}@seazn.club`);
  expect(body, "nor is the first-round draw bye").not.toContain(`UID:${drawBye.id}@seazn.club`);
  expect(body, "the played semi is").toContain(`UID:${semi!.id}@seazn.club`);
  expect(body, "and so is the final").toContain(`UID:${final.id}@seazn.club`);
});
