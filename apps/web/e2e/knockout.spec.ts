import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  scoreFixture,
  divisionPath,
  activeOrg,
} from "./helpers";

// Bracket progression (the engine path the league journeys never touch):
// semi winners must flow into the final via winner_to slots, and the scoring
// ledger's optimistic concurrency must reject stale writes.

interface FixtureRow {
  id: string;
  round_no: number | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome?: { winner_entrant_id?: string | null } | null;
}

async function seedKnockoutDivision(request: Parameters<typeof apiJson>[0]) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `KO ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
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
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  return { divisionId, fixtureIds };
}

async function getFixture(request: Parameters<typeof apiJson>[0], id: string) {
  return (await apiJson<FixtureRow>(request, `/api/v1/fixtures/${id}`)).data!;
}

test("knockout: semi winners advance into the final and decide the cup", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedKnockoutDivision(request);
  expect(fixtureIds.length).toBe(3); // 2 semis + final

  const fixtures = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  const semis = fixtures.filter((f) => f.home_entrant_id && f.away_entrant_id);
  const final = fixtures.find((f) => !f.home_entrant_id && !f.away_entrant_id);
  expect(semis.length).toBe(2);
  expect(final).toBeTruthy();

  // Home side wins both semis.
  const expectedFinalists = new Set(semis.map((s) => s.home_entrant_id!));
  for (const semi of semis) await scoreFixture(request, semi.id, 2, 0);

  // The final's slots fill from winner_to as each semi decides.
  await expect
    .poll(
      async () => {
        const f = await getFixture(request, final!.id);
        return [f.home_entrant_id, f.away_entrant_id].filter(Boolean).length;
      },
      { timeout: 20_000 },
    )
    .toBe(2);
  const filledFinal = await getFixture(request, final!.id);
  expect(expectedFinalists.has(filledFinal.home_entrant_id!)).toBe(true);
  expect(expectedFinalists.has(filledFinal.away_entrant_id!)).toBe(true);

  // Decide the cup; the fixtures tab shows the whole 3-match bracket.
  await scoreFixture(request, final!.id, 3, 1);
  const decidedFinal = await getFixture(request, final!.id);
  expect(["decided", "finalized"]).toContain(decidedFinal.status);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  // Competition Desk W2 (Task 4): the fixtures tab's run sheet gives each row
  // ONE action from `fixtureRowAction`'s ladder (Task 2), which labels a
  // decided/finalized fixture "Result" — not "View", the label the retired
  // `FixtureLine` used for the same state. All 3 bracket fixtures here are
  // decided, so all 3 show "Result". Pinned exactly (fix round 1 — a widened
  // `/^(Score|Result|View)/` would survive a regression that sent every
  // decided bracket row back to "Score").
  await expect(page.getByRole("link", { name: /^Result/ })).toHaveCount(3, {
    timeout: 20_000,
  });
});

test("scoring rejects a stale expected_seq with 409 SEQ_CONFLICT", async ({ request }) => {
  const { fixtureIds } = await seedKnockoutDivision(request);
  const fixtures = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  const semi = fixtures.find((f) => f.home_entrant_id && f.away_entrant_id)!;

  await scoreFixture(request, semi.id, 2, 0);

  // Replay the same write with the now-stale seq → optimistic concurrency 409.
  const stale = await apiJson(request, `/api/v1/fixtures/${semi.id}/events`, "POST", {
    expected_seq: 0,
    type: "generic.result",
    payload: { p1Score: 1, p2Score: 0 },
  });
  expect(stale.status).toBe(409);
  expect(stale.error?.code).toBe("SEQ_CONFLICT");
});

test("double-elim division renders the two-lane bracket on the fixtures tab (console gate)", async ({
  page,
  request,
}) => {
  // Same rig as the knockout seed, but a double_elim stage — the page gate
  // regressed once by only admitting kind === "knockout".
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `DE ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "DE Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["A", "B", "C", "D"]);
  await createStageAndGenerate(request, divisionId, { kind: "double_elim", name: "DE" });

  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  await expect(page.getByTestId("bracket-panel-de")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Winners bracket")).toBeVisible();
  await expect(page.getByText("Losers bracket")).toBeVisible();
});

// The public bracket tree (TwoSided in public-site/bracket.tsx) is the one
// bracket shape F1 (#606) left with no round captions at all — it was missed
// by every prior naming sweep because it rendered no text to be wrong. This
// division must be PUBLIC (unlike seedKnockoutDivision's private one, which
// 404s off /shared/*) to reach the surface the fix actually touched.
test("public bracket page names each round (Quarter/Semi/Final captions)", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `KO Public ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
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
  await createStageAndGenerate(request, divisionId, { kind: "knockout", name: "Cup" });

  const orgSlug = (await activeOrg(page)).slug;
  const compData = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${comp.data!.id}`);
  const divData = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);

  await page.goto(`/shared/${orgSlug}/${compData.data!.slug}/${divData.data!.slug}`);
  // The bracket tree lives under the "Standings" tab (Schedule is the default).
  await page.getByRole("tab", { name: "Standings" }).click();
  // SCOPED to that panel, and EXACT. `tabs.tsx` server-renders EVERY panel and
  // hides the inactive ones (`hidden={i !== active}`), so an unscoped
  // `getByText` keeps resolving inside the hidden Schedule panel — which names
  // this draw's rounds twice over: as the round view's group headings, and
  // inside "Winner of Semi-finals, match 1" slot labels. `.first()` then picks
  // a hidden node and waits out the timeout on a page that is rendering
  // correctly.
  // EXACT is the second half, and it is not decoration: that slot text
  // CONTAINS "Semi-finals" and the bracket prints it too (bracket.tsx), so a
  // scoped-but-loose locator would pass on a waiting side's label even if the
  // round CAPTIONS this test is named for disappeared entirely.
  const standings = page.locator("#panel-standings");
  await expect(standings.getByText("Semi-finals", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(standings.getByText("Final", { exact: true }).first()).toBeVisible();
});
