import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
  activeOrgIdFromRequest,
  seedVenueWithCourts,
} from "./helpers";

// P9's own acceptance criteria (portfolio pass 5), beyond converting the
// specs that already existed off the retired court_label wire shape:
//
//   1. Tag a court, require that tag on a division, auto-schedule, and
//      confirm the board only ever lands on the tagged court — RUNNABLE,
//      below. Not just the positive case: a "validate is green" claim
//      proves nothing on its own unless the same check can also go red for
//      a real violation, so the second half forces a fixture onto the
//      untagged court directly and confirms /validate's court_tag_mismatch
//      conflict (P9 pass 2c — packages/engine/src/scheduling/calendar.ts,
//      wired into the wire response by usecases/schedule.ts's
//      validateScheduleIn) actually catches it. Verified read-only against
//      that engine/usecase code this session: `moveFixture` (the single-
//      fixture PATCH handler) never wires courtTagQualifiedIds into its own
//      verifier call — only validateScheduleIn does — so PATCHing a
//      fixture onto a tag-mismatched court succeeds (200) and it is
//      /validate, not the write itself, that reports the conflict.
//
//   2. The court multi-picker meant to replace the free-text court list on
//      the schedule board's Settings tab (`/schedule?tab=settings`,
//      StandaloneScheduleSettings in components/v2/board/settings-panel.tsx)
//      — NOT BUILT YET as of this writing (confirmed: that panel still
//      renders a plain <input> list, courts: string[], same shape
//      division-builder.tsx's creation wizard uses — settings-panel.tsx
//      ~lines 491-534). test.fixme() below so this file stays green until
//      the picker ships. The intended selector is a checkbox per REAL
//      court, named by the court's own NAME (never a bare id) — the most
//      idiomatic multi-select shape given the sibling required-court-tags
//      picker on division-settings.tsx (TagChipInput) already leans on
//      accessible names rather than data-testid throughout this codebase.
//      The section label ("Courts", boardset.venuesLabel) and the Save
//      button ("Save settings", boardset.save) are read verbatim off
//      src/dictionaries/en/ui.json and are unlikely to change even once the
//      list becomes a picker — the surrounding assumptions (that this
//      lands on THIS tab, as a checkbox list) are the part to revisit if
//      the real implementation differs.

interface FixtureRow {
  id: string;
  scheduled_at: string | null;
  court_id: string | null;
  court_name: string | null;
  /** #622 — the round-scoped spec sorts a knockout's fixtures by round to tell
   *  the final from the semis. Always served (`Fixture` in schemas.ts); the
   *  original spec above simply had no use for it. */
  round_no: number;
}
const getFixture = async (request: APIRequestContext, id: string): Promise<FixtureRow> =>
  (await apiJson<FixtureRow>(request, `/api/v1/fixtures/${id}`)).data!;

interface ScheduleConflictRow {
  fixture_id: string;
  code: string;
  blocking: boolean;
  details?: { kind?: string; court?: string; court_name?: string };
}

/** One venue, one court tagged "clay", one plain — `seedVenueWithCourts`
 *  (helpers.ts) has no per-court tags param, so this is built directly
 *  rather than extending a helper every other converted spec now depends
 *  on for a need only this file has. */
async function seedTaggedCourts(
  request: APIRequestContext,
  venueName: string,
): Promise<{
  tagged: { id: string; name: string };
  untagged: { id: string; name: string };
}> {
  const orgId = await activeOrgIdFromRequest(request);
  const venue = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/venues`, "POST", {
    name: venueName,
  });
  const venueId = venue.data!.id;
  const tagged = await apiJson<{ id: string }>(
    request,
    `/api/v1/orgs/${orgId}/venues/${venueId}/courts`,
    "POST",
    { name: "Clay Court", tags: ["clay"] },
  );
  const untagged = await apiJson<{ id: string }>(
    request,
    `/api/v1/orgs/${orgId}/venues/${venueId}/courts`,
    "POST",
    { name: "Hard Court" },
  );
  return {
    tagged: { id: tagged.data!.id, name: "Clay Court" },
    untagged: { id: untagged.data!.id, name: "Hard Court" },
  };
}

test("a division that requires a court tag is auto-scheduled only onto courts carrying it, and /validate stays green until a fixture is forced off it", async ({
  request,
}) => {
  const { tagged, untagged } = await seedTaggedCourts(request, `E2E Tag Venue ${TAG}`);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Court Tag ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Tagged Courts",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;

  // Requires "clay" — only the tagged court qualifies, even though BOTH
  // courts are configured candidates below. Isolates the tag filter as the
  // one thing deciding placement, rather than relying on the "empty
  // configured list falls back to every org court" default.
  const patched = await apiJson(request, `/api/v1/divisions/${divisionId}`, "PATCH", {
    required_court_tags: ["clay"],
  });
  expect(patched.status).toBe(200);

  await addEntrantsViaApi(request, divisionId, ["Ash", "Brook", "Clay", "Dune"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length).toBe(6); // 4-entrant round robin

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [tagged.id, untagged.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);

  const auto = await apiJson<{
    assignments: {
      fixture_id: string;
      scheduled_at: string;
      court_id: string;
      court_name: string | null;
    }[];
  }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  expect(auto.status).toBe(200);
  expect(auto.data!.assignments.length).toBe(6);
  // Every placed assignment is on the TAGGED court, never the untagged one
  // — court-candidates.ts's resolveCandidateCourts is what narrows this.
  // Asserted by NAME (not just id): a client reading this response never
  // needs to resolve a bare uuid itself.
  for (const a of auto.data!.assignments) {
    expect(a.court_id).toBe(tagged.id);
    // `toContain`, not `toBe`: the name is VENUE-QUALIFIED whenever another
    // court in the same org shares the bare name, and CI's shared Pro org
    // accumulates courts across specs — so this legitimately reads
    // "Clay Court (E2E Tag Venue …)" there and "Clay Court" on a fresh org.
    // What matters is that a NAME comes back and never a bare uuid.
    expect(a.court_name).toContain(tagged.name);
    expect(a.court_name).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  }

  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    {
      assignments: auto.data!.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    },
  );
  expect(applied.status).toBe(200);
  expect(applied.data!.applied).toBe(6);

  // /validate is green: an auto-scheduled board never violated its own tag
  // requirement.
  const clean = await apiJson<{ conflicts: ScheduleConflictRow[] }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule/validate`,
    "POST",
  );
  expect(clean.status).toBe(200);
  expect(clean.data!.conflicts.some((c) => c.details?.kind === "court_tag_mismatch")).toBe(false);

  // NEGATIVE CONTROL. Force one fixture onto the untagged court directly —
  // a plain PATCH, not through the solver — and confirm /validate now
  // reports court_tag_mismatch for exactly that fixture: blocking (the
  // engine's isBlockingConflict treats every reason:"court" conflict as
  // one), coded conflict.court (REASON_CODE["court"], lib/schedule-board.ts
  // — the same code court_double_booking uses, since both are
  // reason:"court"), and naming the offending court by NAME as well as id.
  const offender = fixtureIds[0]!;
  const before = await getFixture(request, offender);
  expect(before.court_id).toBe(tagged.id);
  const moved = await apiJson(request, `/api/v1/fixtures/${offender}`, "PATCH", {
    court_id: untagged.id,
  });
  expect(moved.status).toBe(200);
  const after = await getFixture(request, offender);
  expect(after.court_id).toBe(untagged.id);
  // `court_name` is a DERIVED display name, and P9's A12 disambiguates a name
  // shared by more than one court in the org as `Name (Venue)`. Two tests in
  // this file seed a court called "Hard Court" into the SAME org from different
  // venues (`seedTaggedCourts`, called here and by the #622 round-role test),
  // so whether this reads "Hard Court" or "Hard Court (E2E Tag Venue …)"
  // depends on which of them has seeded by now — an order dependency that was
  // latent on main and surfaced when P9.5 added two more tests to the file and
  // changed the worker timing.
  //
  // Asserted on the identity, tolerant of the disambiguation: the point of the
  // line is that the fixture now reports the UNTAGGED court, not which of two
  // equally correct renderings of that court's name came back.
  expect(after.court_name).toMatch(/^Hard Court($| \()/);

  const dirty = await apiJson<{ conflicts: ScheduleConflictRow[] }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule/validate`,
    "POST",
  );
  expect(dirty.status).toBe(200);
  const mismatch = dirty.data!.conflicts.find(
    (c) => c.fixture_id === offender && c.details?.kind === "court_tag_mismatch",
  );
  expect(mismatch, "moved a fixture onto the untagged court and /validate did not report it").toBeTruthy();
  expect(mismatch!.code).toBe("conflict.court");
  // Review wave 2 ruling: REPORTED but NOT blocking. `court_tag_mismatch`
  // shares `reason: "court"` with double-booking, and blocking it meant that
  // adding a tag requirement to a division whose board already existed
  // hard-refused publish with no override — the retroactive-invalidation
  // outcome ruling 3 exists to prevent. The organiser sees it and decides.
  expect(mismatch!.blocking).toBe(false);
  expect(mismatch!.details!.court).toBe(untagged.id);
  // Venue-qualified when the bare name collides elsewhere in the org — see the
  // auto-pass assertion above for why this is `toContain`.
  expect(mismatch!.details!.court_name).toContain(untagged.name);
  expect(mismatch!.details!.court_name).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);

  // Every OTHER fixture is still on the tagged court and reports nothing —
  // the conflict is scoped to the one fixture actually moved.
  const untouchedIds = fixtureIds.filter((id) => id !== offender);
  for (const id of untouchedIds) {
    expect((await getFixture(request, id)).court_id).toBe(tagged.id);
  }
  expect(
    dirty.data!.conflicts.filter((c) => c.details?.kind === "court_tag_mismatch"),
  ).toHaveLength(1);
});

test.fixme(
  "schedule setup: the court picker selects real courts, never free text (PENDING — picker not built yet, P9 follow-up)",
  async ({ page, request }) => {
    const orgId = await activeOrgIdFromRequest(request);
    const venue = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/venues`, "POST", {
      name: `E2E Picker Venue ${TAG}`,
    });
    const venueId = venue.data!.id;
    const names = ["Center Court", "Practice Court", "Back Court"];
    const courtIds: Record<string, string> = {};
    for (const name of names) {
      const court = await apiJson<{ id: string }>(
        request,
        `/api/v1/orgs/${orgId}/venues/${venueId}/courts`,
        "POST",
        { name },
      );
      courtIds[name] = court.data!.id;
    }

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Court Picker ${TAG}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Picker Division",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const divisionId = div.data!.id;

    await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=settings"));

    // Intended shape: a "Courts" section (boardset.venuesLabel — unchanged
    // by the picker work) containing one checkbox per real org court, named
    // by the court's own name. Select two of the three, leave the third
    // (the decoy) unpicked. Not scoped to a container locator: the section
    // wrapper's own role/name (region? group? plain div?) is exactly the
    // kind of detail this test cannot know before the picker exists — three
    // distinctly-named checkboxes are unambiguous without one.
    await page.getByRole("checkbox", { name: "Center Court" }).check();
    await page.getByRole("checkbox", { name: "Practice Court" }).check();
    await expect(page.getByRole("checkbox", { name: "Back Court" })).not.toBeChecked();

    await page.getByRole("button", { name: "Save settings" }).click();

    const saved = await apiJson<{ config: { courts: string[] } }>(
      request,
      `/api/v1/divisions/${divisionId}/schedule-settings`,
    );
    expect(new Set(saved.data!.config.courts)).toEqual(
      new Set([courtIds["Center Court"]!, courtIds["Practice Court"]!]),
    );
    expect(saved.data!.config.courts).not.toContain(courtIds["Back Court"]!);
  },
);

// #622 — ROUND-SCOPED tags, the third scope. The spec above proves the
// DIVISION scope end to end; this one proves that a tag attached to a single
// round ROLE constrains that round and leaves its siblings alone, which is the
// exact thing the stage scope could not express (QF, SF and the final share
// one `stages` row, so a stage tag is inherited by all three).
//
// The positive half is solver behaviour: the final must land on the tagged
// court. The proof that the SEMIS stayed unconstrained is deliberately NOT a
// solver assertion — which court a free fixture happens to get is the placer's
// choice and not a contract — but a /validate one, forcing each of the two
// fixtures onto the untagged court in turn. The final must report
// `court_tag_mismatch`; the semi must report nothing. That pair is
// deterministic, and it fails loudly against the pre-#622 behaviour in both
// directions: a stage-wide tag would flag the semi too, and no tag at all
// would flag neither.
test("a tag scoped to one round role constrains that round only: the final needs the tagged court, the semis do not (#622)", async ({
  request,
}) => {
  const { tagged, untagged } = await seedTaggedCourts(request, `E2E Round Tag Venue ${TAG}`);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Round Court Tag ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Round Tagged Courts",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;

  // NOTE the division is left UNTAGGED, unlike the spec above. The only tag
  // rule in play is the round one, so nothing else can account for the
  // placement — and a semi landing on the untagged court is legal.
  // DISTINCT from the tag test's entrant names above, deliberately. Persons are
  // get-or-created by NAME within an org, so two divisions seeded with the same
  // four names share the same person rows — and a shared person across two
  // boards scheduled at the same times is a cross-division `person_overlap`,
  // which IS blocking. That made the move below 409 instead of 200 whenever
  // both tests had run, an order-dependent failure with nothing to do with
  // round-scoped tags. Pre-existing on main; surfaced when P9.5 added tests to
  // this file and changed the worker timing.
  await addEntrantsViaApi(request, divisionId, ["Iris", "Juno", "Kite", "Lark"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Cup",
  });
  expect(fixtureIds.length).toBe(3); // 2 semis + final

  const rows = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  const finalRow = rows.reduce((a, b) => (b.round_no > a.round_no ? b : a));
  const semis = rows.filter((r) => r.id !== finalRow.id);
  expect(semis).toHaveLength(2);

  // The picker source: roles this stage's fixtures actually occupy, so an
  // organiser is offered "Final"/"Semi-final" rather than a round number.
  const before = await apiJson<{
    required_court_tags: string[];
    rounds: { round_role: string; required_court_tags: string[] }[];
    available_round_roles: string[];
  }>(request, `/api/v1/stages/${stageId}/court-tags`);
  expect(before.status).toBe(200);
  expect(before.data!.rounds).toEqual([]);
  expect(before.data!.available_round_roles).toContain("final");
  expect(before.data!.available_round_roles).toContain("semi_final");

  const put = await apiJson(request, `/api/v1/stages/${stageId}/court-tags`, "PUT", {
    rounds: [{ round_role: "final", required_court_tags: ["clay"] }],
  });
  expect(put.status).toBe(200);

  // Round rule persisted, and the STAGE-wide list is still empty — the two
  // scopes are stored and served separately, not folded together on write.
  const after = await apiJson<{
    required_court_tags: string[];
    rounds: { round_role: string; required_court_tags: string[] }[];
  }>(request, `/api/v1/stages/${stageId}/court-tags`);
  expect(after.data!.required_court_tags).toEqual([]);
  expect(after.data!.rounds).toEqual([{ round_role: "final", required_court_tags: ["clay"] }]);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [tagged.id, untagged.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);

  const auto = await apiJson<{
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
  }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  expect(auto.status).toBe(200);
  expect(auto.data!.assignments.length).toBe(3);

  // The final is on the tagged court because its ROUND says so.
  const finalAssignment = auto.data!.assignments.find((a) => a.fixture_id === finalRow.id);
  expect(finalAssignment, "the final was not scheduled at all").toBeTruthy();
  expect(finalAssignment!.court_id).toBe(tagged.id);

  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    {
      assignments: auto.data!.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    },
  );
  expect(applied.status).toBe(200);
  expect(applied.data!.applied).toBe(3);

  const clean = await apiJson<{ conflicts: ScheduleConflictRow[] }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule/validate`,
    "POST",
  );
  expect(clean.status).toBe(200);
  expect(clean.data!.conflicts.some((c) => c.details?.kind === "court_tag_mismatch")).toBe(false);

  // A SEMI on the untagged court is legal — no rule names its role. This is
  // the assertion that fails if round tags are resolved stage-wide.
  const semi = semis[0]!;
  const movedSemi = await apiJson(request, `/api/v1/fixtures/${semi.id}`, "PATCH", {
    court_id: untagged.id,
  });
  expect(movedSemi.status).toBe(200);
  const afterSemi = await apiJson<{ conflicts: ScheduleConflictRow[] }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule/validate`,
    "POST",
  );
  expect(afterSemi.status).toBe(200);
  expect(
    afterSemi.data!.conflicts.filter((c) => c.details?.kind === "court_tag_mismatch"),
    "a semi-final was reported for a tag rule that only names the final",
  ).toHaveLength(0);

  // The FINAL on the same court is not — reported, and non-blocking for the
  // reason ruling 3 gives (see the division-scoped spec above).
  const movedFinal = await apiJson(request, `/api/v1/fixtures/${finalRow.id}`, "PATCH", {
    court_id: untagged.id,
  });
  expect(movedFinal.status).toBe(200);
  const afterFinal = await apiJson<{ conflicts: ScheduleConflictRow[] }>(
    request,
    `/api/v1/divisions/${divisionId}/schedule/validate`,
    "POST",
  );
  expect(afterFinal.status).toBe(200);
  const mismatches = afterFinal.data!.conflicts.filter(
    (c) => c.details?.kind === "court_tag_mismatch",
  );
  expect(
    mismatches,
    "the final was moved off its required court and /validate stayed silent",
  ).toHaveLength(1);
  expect(mismatches[0]!.fixture_id).toBe(finalRow.id);
  expect(mismatches[0]!.code).toBe("conflict.court");
  expect(mismatches[0]!.blocking).toBe(false);
  expect(mismatches[0]!.details!.court).toBe(untagged.id);
});

// P9.5 (D5b.5, court hours) + the P95-windows i18n pass — two BOARD-level
// tests (not API-only, unlike everything above) proving a conflict CODE
// renders as real localized copy, never the raw wire string.
//
// `conflicts-panel.tsx`'s own `conflictLabel(code)` resolves
// `board.conflict.${code}` through the active locale's dictionary, falling
// back to the hand-maintained `CONFLICT_LABEL` table (types.ts) and only then
// to the bare code itself. Both codes exercised here share that same
// resolution path with `court_tag_mismatch` above (`conflict.court`) or were
// entirely unmapped before this pass (`conflict.start_window` — before P9.5
// neither the dictionary key nor the CONFLICT_LABEL fallback existed for it,
// so the board rendered the bare string `conflict.start_window` verbatim).
//
// Both are hand-placed via the normal PATCH/move path, not the solver, then
// read off the BOARD's own conflicts panel — located by ARIA role + name, the
// same convention scheduling-constraints.spec.ts's own `badge`/`panel`
// locators use (`conflicts-panel.tsx` exposes no `data-*` hook to grab
// instead). UNLIKE that file's stated convention, these two tests DO assert
// on the rendered English — the copy itself, resolved end to end from the
// dictionary, is the thing under test here, not row count or blocking state.
const conflictsBadge = (page: Page) =>
  page.getByRole("button", { name: /conflicts? — open the list/ });
const conflictsPanel = (page: Page) => page.getByRole("region", { name: "Schedule conflicts" });

/** One venue, one court, with a `court_hours` row PUT onto it (P8/P9.5's
 *  calendar editor). Distinct from `seedTaggedCourts` above, which has no
 *  hours param and exists for the TAG scope, not the HOURS one. */
async function seedCourtWithHours(
  request: APIRequestContext,
  venueName: string,
  hours: { weekday: number; open_min: number; close_min: number }[],
): Promise<{ id: string }> {
  const orgId = await activeOrgIdFromRequest(request);
  const venue = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/venues`, "POST", {
    name: venueName,
  });
  const venueId = venue.data!.id;
  const court = await apiJson<{ id: string }>(
    request,
    `/api/v1/orgs/${orgId}/venues/${venueId}/courts`,
    "POST",
    { name: "Hours Court" },
  );
  const courtId = court.data!.id;
  const put = await apiJson(request, `/api/v1/orgs/${orgId}/courts/${courtId}/calendar`, "PUT", {
    hours,
    exceptions: [],
  });
  expect(put.status).toBe(200);
  return { id: courtId };
}

test("a fixture placed outside its court's declared hours shows a real localized label on the board, never the raw code (P9.5)", async ({
  page,
  request,
}) => {
  const weekday = new Date(Date.UTC(2026, 10, 4)).getUTCDay();
  const court = await seedCourtWithHours(request, `E2E Court Hours Venue ${TAG}`, [
    { weekday, open_min: 15 * 60, close_min: 20 * 60 },
  ]);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Court Hours Board ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Court Hours Board",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Elm", "Fir"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length).toBe(1);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 10, 4, 15, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [court.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);

  // Legitimately scheduled first, INSIDE hours — moveFixture's
  // MOVABLE_STATUS gate refuses to move a timetable for a fixture that was
  // never placed at all, same as the negative control above.
  const auto = await apiJson<{
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
  }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  expect(auto.status).toBe(200);
  expect(auto.data!.assignments.length).toBe(1);
  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    {
      assignments: auto.data!.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    },
  );
  expect(applied.status).toBe(200);

  // Hand-place it OUTSIDE the 15:00-20:00 window — the normal PATCH/move
  // path, not through the solver.
  const moved = await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}`, "PATCH", {
    court_id: court.id,
    scheduled_at: new Date(Date.UTC(2026, 10, 4, 9, 0)).toISOString(),
  });
  expect(moved.status, "a non-blocking conflict must never refuse the write").toBe(200);

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
  await expect(page.getByText("Elm").first()).toBeVisible({ timeout: 20_000 });

  await conflictsBadge(page).click();
  const list = conflictsPanel(page);
  await expect(list).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  const row = list.getByRole("listitem").first();
  // The dictionary value for `board.conflict.conflict.court` (en/ui.json) —
  // the exact label court_tag_mismatch/court_double_booking already render,
  // since outside_court_hours shares the same wire code (`conflict.court`,
  // REASON_CODE["court"]). Never the raw code, and never any bare
  // `conflict.*`/`warn.*`-shaped token.
  await expect(row).toContainText("court clash");
  const rowText = (await row.textContent()) ?? "";
  expect(rowText).not.toMatch(/\bconflict\.\w+\b/);
});

test("a start-window breach shows a real localized label on the board, not the raw 'conflict.start_window' string (P9.5)", async ({
  page,
  request,
}) => {
  const { courts } = await seedVenueWithCourts(request, ["Start Window Court"], {
    venueName: `E2E Start Window Venue ${TAG}`,
  });
  const court = courts[0]!;

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Start Window Board ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Start Window Board",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Gale", "Holt"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length).toBe(1);

  const notAfter = new Date(Date.UTC(2026, 10, 4, 12, 0)).toISOString();
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 10, 4, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [court.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
        constraints: {
          startWindows: [{ target: { kind: "division", id: divisionId }, notAfter }],
        },
      },
    },
  );
  expect(settings.status).toBe(200);

  // Legitimately scheduled first, INSIDE the window — same MOVABLE_STATUS
  // reasoning as the court-hours test above.
  const auto = await apiJson<{
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
  }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  expect(auto.status).toBe(200);
  expect(auto.data!.assignments.length).toBe(1);
  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    {
      assignments: auto.data!.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      source: "auto",
    },
  );
  expect(applied.status).toBe(200);

  // Hand-place it AFTER notAfter — breaches the bound. Non-blocking (H5 is
  // never in isBlockingConflict), so the write is not refused either.
  const moved = await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}`, "PATCH", {
    court_id: court.id,
    scheduled_at: new Date(Date.UTC(2026, 10, 4, 14, 0)).toISOString(),
  });
  expect(moved.status, "a non-blocking conflict must never refuse the write").toBe(200);

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
  await expect(page.getByText("Gale").first()).toBeVisible({ timeout: 20_000 });

  await conflictsBadge(page).click();
  const list = conflictsPanel(page);
  await expect(list).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  const row = list.getByRole("listitem").first();
  // `board.conflict.conflict.start_window` (en/ui.json): "outside a start
  // window". Before P9.5 this code had neither a dictionary key nor a
  // CONFLICT_LABEL fallback, so this rendered the bare string
  // `conflict.start_window` verbatim (see conflicts-panel.tsx's own comment).
  await expect(row).toContainText("outside a start window");
  const rowText = (await row.textContent()) ?? "";
  expect(rowText).not.toContain("conflict.start_window");
});
