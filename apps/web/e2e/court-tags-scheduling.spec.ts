import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
  activeOrgIdFromRequest,
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
  expect(after.court_name).toBe(untagged.name);

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
