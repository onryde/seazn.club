import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, type OrgInfo } from "./helpers";

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
