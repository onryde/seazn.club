import { test, expect, type Page } from "@playwright/test";
import { apiJson, TAG, linkPersonToUserBySql, expectNoHorizontalScroll } from "./helpers";

// S9/#418 (W7) — the career rollup, driven through the real product.
//
// The two surfaces this wave adds answer the SAME question with deliberately
// DIFFERENT scopes, and that difference is the whole acceptance criterion:
//
//   /me Career          sums every competition the player has ever been
//                       scored in, across clubs, because it is their own
//                       record.
//   public player card  totals only the sports inside the ONE competition
//                       the card belongs to.
//
// So the fixture below gives one person football goals in TWO separate
// competitions (2 and 3) plus a badminton point in a third. A scoping bug is
// then visible as a WRONG NUMBER rather than as a missing element: /me must
// read 5 goals and competition A's public card must read 2. Asserting only
// "a career section exists" would pass in both the correct and the broken
// state, which is the shape of vacuous assertion this repo has shipped before.

/** One football division in its own competition.
 *
 *  `as: "FW"` — `personId` scores `goals` goals.
 *  `as: "GK"`  — `personId` starts in goal and the OPPONENT scores them, so
 *  the same person accumulates `goals_conceded` in this division while
 *  scoring in others. A starting slot with `position_key: "GK"` is all the
 *  keeper fold needs; no `core.lineup.position` event is involved.
 *
 *  Both sides always get a real lineup: football's `applyGoal` rejects a
 *  scorer who is not on the pitch, so a one-sided lineup fails at the event. */
async function seedFootballGoals(
  page: Page,
  name: string,
  personId: string,
  opponentId: string,
  goals: number,
  as: "FW" | "GK" = "FW",
): Promise<{ competitionId: string; divisionId: string }> {
  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name,
    visibility: "public",
  });
  const competitionId = comp.data!.id;
  const div = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    { name: "Prem", sport_key: "football", variant_key: "11-a-side" },
  );
  const divisionId = div.data!.id;

  const ents = await apiJson<{ id: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      { kind: "team", display_name: `Home ${name}`, seed: 1, members: [{ person_id: personId }] },
      { kind: "team", display_name: `Away ${name}`, seed: 2, members: [{ person_id: opponentId }] },
    ],
  );
  const homeId = ents.data![0]!.id;
  const awayId = ents.data![1]!.id;

  const stage = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(page.request, `/api/v1/divisions/${divisionId}/start`, "POST");

  await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/lineups/${homeId}`, "PUT", {
    slots: [{ person_id: personId, slot: "starting", position_key: as, order_no: 1, roles: [] }],
  });
  await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/lineups/${awayId}`, "PUT", {
    slots: [
      {
        person_id: opponentId,
        slot: "starting",
        position_key: as === "GK" ? "FW" : "GK",
        order_no: 1,
        roles: [],
      },
    ],
  });

  const started = await apiJson<{ seq: number }>(
    page.request,
    `/api/v1/fixtures/${fixtureId}/events`,
    "POST",
    { expected_seq: 0, type: "core.start", payload: {} },
  );
  let seq = started.data!.seq;
  const scoringSide = as === "GK" ? awayId : homeId;
  const scoringPerson = as === "GK" ? opponentId : personId;
  for (let i = 0; i < goals; i += 1) {
    const goal = await apiJson<{ seq: number }>(
      page.request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      { expected_seq: seq, type: "football.goal", payload: { by: scoringSide, scorer: scoringPerson } },
    );
    expect(goal.status, `football.goal ${i + 1} rejected: ${JSON.stringify(goal.error)}`).toBeLessThan(300);
    seq = goal.data!.seq;
  }
  return { competitionId, divisionId };
}

/** Read the division leaderboard, which is what WRITES player_stat_snapshots
 *  (recomputePlayerStats runs on that read). The career surfaces are
 *  snapshot-only by design — they never recompute — so without this an
 *  organiser-never-looked division contributes nothing, and the test would be
 *  asserting against zeros for the wrong reason. */
async function materializeSnapshots(page: Page, divisionId: string): Promise<void> {
  const res = await apiJson(page.request, `/api/v1/divisions/${divisionId}/stats/players`);
  expect(res.status, `leaderboard read failed for ${divisionId}`).toBe(200);
}

/** Every metric VALUE rendered on one sport's career card. Read by value, not
 *  by label: the labels are engine-declared and translated, so pinning
 *  "Goals" would make this spec fail on a copy change rather than on the
 *  behaviour it is here to protect. */
async function cardValues(page: Page, sportKey: string): Promise<string[]> {
  const values = await page.getByTestId(`career-sport-${sportKey}`).locator("dd").allInnerTexts();
  return values.map((v) => v.trim());
}

test("career rollup: /me sums across competitions, the public card stays scoped to one", async ({
  page,
}) => {
  // The empty state first, while this user still has no scored person — the
  // section renders in BOTH states, so proving the empty one has to happen
  // before the fixture below makes it impossible. Kept in this test rather
  // than its own: a sibling test would race, since every test in this file
  // signs in as the same pro user and /me is per-user, not per-test.
  await page.goto("/me");
  await expect(page.getByTestId("me-career")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("me-career-empty")).toBeVisible();

  const player = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Career Player ${TAG}`,
    consent: { public_name: true },
  });
  const rival = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Career Rival ${TAG}`,
    consent: { public_name: true },
  });
  const playerId = player.data!.id;

  // Two football competitions, DIFFERENT goal counts — 2 here, 3 in B — plus
  // a third where the same person keeps goal and concedes one. That third is
  // the "kept goal in some matches, played out in others" case: it must land
  // on ONE football card carrying both sets of numbers, not two half cards.
  const a = await seedFootballGoals(page, `Career A ${TAG}`, playerId, rival.data!.id, 2);
  const b = await seedFootballGoals(page, `Career B ${TAG}`, playerId, rival.data!.id, 3);
  const k = await seedFootballGoals(page, `Career K ${TAG}`, playerId, rival.data!.id, 1, "GK");

  // A second sport, so /me owes TWO cards and the "one card per sport"
  // criterion is testable at all. Badminton via the entrant fallback
  // (`wonBy` only, no lineup) — the v1-era shape S8/#417 wired.
  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Career C ${TAG}`,
    visibility: "public",
  });
  const bdiv = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "badminton", variant_key: "bwf" },
  );
  const badmintonDivisionId = bdiv.data!.id;
  const bents = await apiJson<{ id: string }[]>(
    page.request,
    `/api/v1/divisions/${badmintonDivisionId}/entrants`,
    "POST",
    [
      { kind: "individual", display_name: `Solo ${TAG}`, seed: 1, members: [{ person_id: playerId }] },
      { kind: "individual", display_name: `Foe ${TAG}`, seed: 2, members: [{ person_id: rival.data!.id }] },
    ],
  );
  const bstage = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/divisions/${badmintonDivisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const bgen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${bstage.data!.id}/generate`,
    "POST",
  );
  const bfixture = bgen.data!.fixtures[0]!.id;
  await apiJson(page.request, `/api/v1/divisions/${badmintonDivisionId}/start`, "POST");
  const bstarted = await apiJson<{ seq: number }>(
    page.request,
    `/api/v1/fixtures/${bfixture}/events`,
    "POST",
    { expected_seq: 0, type: "core.start", payload: {} },
  );
  const rally = await apiJson(page.request, `/api/v1/fixtures/${bfixture}/events`, "POST", {
    expected_seq: bstarted.data!.seq,
    type: "badminton.rally",
    payload: { wonBy: bents.data![0]!.id },
  });
  expect(rally.status, `badminton.rally rejected: ${JSON.stringify(rally.error)}`).toBeLessThan(300);

  for (const d of [a.divisionId, b.divisionId, k.divisionId, badmintonDivisionId]) {
    await materializeSnapshots(page, d);
  }

  // ---- the API contract: ?group=sport, org-scoped ------------------------
  const career = await apiJson<{
    sports: { sport_key: string; metrics: { key: string; value: number }[]; divisions: number; matches: number }[];
  }>(page.request, `/api/v1/persons/${playerId}/stats?group=sport`);
  expect(career.status).toBe(200);
  const football = career.data!.sports.find((s) => s.sport_key === "football");
  expect(football, "no football career row").toBeDefined();
  expect(football!.metrics.find((m) => m.key === "goals")?.value).toBe(5);
  expect(football!.divisions).toBe(3);
  // One card, both roles: the outfield goals above and the keeper's conceded
  // goal from the third division sit on the SAME football row.
  expect(football!.metrics.find((m) => m.key === "goals_conceded")?.value).toBe(1);
  expect(career.data!.sports.some((s) => s.sport_key === "badminton")).toBe(true);

  // Ungrouped stays per-division, unchanged — the param is additive.
  const perDivision = await apiJson<{ divisions: { division_id: string }[] }>(
    page.request,
    `/api/v1/persons/${playerId}/stats`,
  );
  expect(perDivision.status).toBe(200);
  expect(perDivision.data!.divisions.length).toBeGreaterThanOrEqual(3);

  // ---- /me: cross-competition totals, the player's own view --------------
  // Ask the app who is signed in rather than rebuilding the email from TAG:
  // TAG is evaluated per process, so this worker's `proEmail()` names an
  // account auth.setup never created.
  const whoami = await apiJson<{ id: string }>(page.request, "/api/users/me");
  expect(whoami.status, "whoami failed — is the storageState session live?").toBe(200);
  await linkPersonToUserBySql(playerId, whoami.data!.id);
  await page.goto("/me");
  await expect(page.getByTestId("me-career")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("me-career-empty")).toHaveCount(0);
  expect(await cardValues(page, "football")).toContain("5");
  await expect(page.getByTestId("career-sport-badminton")).toBeVisible();

  // ---- the public card: ONE competition only -----------------------------
  const orgs = await apiJson<{ id: string; slug: string }[]>(page.request, "/api/orgs");
  const compA = await apiJson<{ org_id: string; slug: string }>(
    page.request,
    `/api/v1/competitions/${a.competitionId}`,
  );
  const orgSlug = orgs.data!.find((o) => o.id === compA.data!.org_id)!.slug;
  await page.goto(`/shared/${orgSlug}/${compA.data!.slug}/players/${playerId}`);

  const publicCareer = page.getByTestId("player-career");
  await expect(publicCareer).toBeVisible({ timeout: 20_000 });
  // The number is the assertion. Competition A alone scored 2; the cross-
  // competition total is 5. A card that leaks scope reads 5 here.
  const publicFootball = await cardValues(page, "football");
  expect(publicFootball).toContain("2");
  expect(publicFootball).not.toContain("5");
  // …and a sport played only in ANOTHER competition has no card at all.
  await expect(page.getByTestId("career-sport-badminton")).toHaveCount(0);

  // The testid probe itself is anchored on `="`: React serialises an omitted
  // prop as "$undefined", so a bare `data-testid` substring match would be
  // satisfied in both the rendered and the omitted state.
  const html = await page.content();
  expect(html).toContain('data-testid="player-career"');

  // Responsive bar: desktop, tablet, and both narrow references.
  for (const width of [1280, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(publicCareer).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  await page.goto("/me");
  for (const width of [1280, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("me-career")).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});
