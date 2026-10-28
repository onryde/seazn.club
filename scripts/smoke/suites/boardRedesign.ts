// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, html, v1, v1data } from "../harness.ts";

// --- Board redesign (2026-08-10): legend duplicated below the grid, and
// blackout windows highlighted on the grid. Own tiny 2-division rig,
// additive only — isolated from schedRegV3Suite's much larger one so this
// never risks any of that suite's assertions. Competition dates are pinned
// explicitly (both here AND on the division's own schedule config) because
// the board's initial `day` is `days[0]`, derived from competitionStart/
// competitionEnd with no URL override — smoke has no browser, so it only
// ever sees whatever day the SSR'd page opens on by default.
export async function boardRedesignSuite(admin: Session, orgSlug: string): Promise<void> {
  const redesignOrgId = admin.cookies["seazn_org"];
  const redesignVenue = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${redesignOrgId}/venues`, "POST", {
      name: `Board Redesign Venue ${tag}`,
    }),
  );
  const redesignCourtA = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${redesignOrgId}/venues/${redesignVenue.id}/courts`, "POST", {
      name: "A",
    }),
  );
  const redesignCourtB = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${redesignOrgId}/venues/${redesignVenue.id}/courts`, "POST", {
      name: "B",
    }),
  );
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      starts_on: "2026-10-05",
      ends_on: "2026-10-06",
      name: `Board redesign ${tag}`,
      visibility: "public",
    }),
  );

  const divA = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Board Redesign A",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${divA.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Redesign A P1", seed: 1 },
    { kind: "individual", display_name: "Redesign A P2", seed: 2 },
  ]);
  const stageA = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${divA.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  await v1(admin, `/api/v1/divisions/${divA.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-05T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [redesignCourtA.id, redesignCourtB.id],
      perEntrantMinRest: 0,
      blackouts: [
        {
          court: redesignCourtA.id,
          from: "2026-10-05T09:00:00.000Z",
          to: "2026-10-05T09:30:00.000Z",
        },
      ],
      sessionWindows: [],
    },
  });
  const genA = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stageA.id}/generate`, "POST"),
  );
  // Court B, same time — outside the court-A-scoped blackout — so a real
  // FixtureBlock renders on the initial page load for the pin-icon check.
  await v1(admin, `/api/v1/fixtures/${genA.fixtures[0].id}`, "PATCH", {
    scheduled_at: "2026-10-05T09:00:00.000Z",
    court_id: redesignCourtB.id,
  });

  // Division B exists purely so the division-filter legend has 2+ divisions
  // to render at all (BoardLegend returns null at divisions.length <= 1).
  const divB = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Board Redesign B",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${divB.id}/entrants`, "POST", [
    { kind: "individual", display_name: "Redesign B P1", seed: 1 },
    { kind: "individual", display_name: "Redesign B P2", seed: 2 },
  ]);
  await v1(admin, `/api/v1/divisions/${divB.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });

  const board = await html(admin, `/o/${orgSlug}/c/${comp.slug}/schedule`);
  check("board redesign: page renders (pro)", board.status === 200);
  check(
    "board redesign: blackout cell marked on the grid",
    board.body.includes('data-blackout="true"'),
  );
  check(
    "board redesign: legend renders twice (above the grid and below it)",
    (board.body.match(/aria-label="Filter by division"/g) ?? []).length === 2,
  );
  check(
    "board redesign: no raw pin emoji in the markup (real fixture is on screen)",
    board.body.includes("Redesign A P1") && !board.body.includes("\u{1F4CC}"),
  );
}
