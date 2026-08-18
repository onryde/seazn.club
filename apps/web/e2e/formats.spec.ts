import { test, expect } from "@playwright/test";
import {
  apiJson,
  TAG,
  competitionPath,
  divisionPath,
  addEntrantsViaApi,
  expectNoHorizontalScroll,
} from "./helpers";

// PROMPT-28 formats: the new stage presets are reachable from the division
// builder, and a ladder division renders its challenge panel.
test("division builder exposes the Jul3/08 format presets", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Formats ${TAG}`,
    visibility: "private",
  });
  await page.goto(await competitionPath(page.request, comp.data!.id, "/d/new"));

  // The builder is tabbed; moving forward validates the current tab, so fill
  // the required division name before opening the Format tab.
  await page.getByRole("textbox").first().fill(`Formats ${TAG}`);
  await page.getByRole("button", { name: "Format", exact: true }).click();

  // The new presets are visible on the format picker.
  await expect(page.getByText("Triple round robin")).toBeVisible();
  await expect(page.getByText("Americano (padel)")).toBeVisible();
  await expect(page.getByText("Mexicano (padel)")).toBeVisible();
  await expect(page.getByText("Ladder", { exact: true })).toBeVisible();
  // L3/#414 pass 3 — the two new qualification-from-any-stage presets.
  await expect(page.getByText("Knockout + Plate", { exact: true })).toBeVisible();
  await expect(page.getByText("Qualifying + Main draw", { exact: true })).toBeVisible();

  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
});

// L3/#414 pass 3: create a ko_plate competition from the template picker,
// complete the main draw, see the plate seeded from round-1 losers.
test("ko_plate template: completing the main draw seeds the plate", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `KoPlate ${TAG}`,
    visibility: "private",
  });
  const competitionId = comp.data!.id;
  await page.goto(await competitionPath(page.request, competitionId, "/d/new"));
  await page.getByRole("textbox").first().fill(`KoPlate ${TAG}`);
  // The wizard defaults Sport to the catalog's first entry alphabetically
  // (division-builder.tsx: `sports[0]?.key`) — never "generic". Scoring the
  // fixtures below with `generic.result` needs the generic/score sport
  // explicitly selected, or the event 422s as unrecognised for whatever
  // sport happened to sort first. Scoped by label CONTAINMENT, not
  // getByLabel: the <label> wraps every <option> text too (all sports/
  // variants render as DOM text regardless of selection), so the computed
  // accessible name is "SportBadmintonBoardgame…Volleyball" — never the bare
  // "Sport" getByLabel(exact) would need.
  await page.locator("label", { hasText: "Sport" }).locator("select").selectOption({ label: "Generic" });
  await page.locator("label", { hasText: "Variant" }).locator("select").selectOption({ label: "Score" });
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page.getByText("Knockout + Plate", { exact: true }).click();
  await page.getByRole("button", { name: "Scheduling", exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: 20_000 });
  const slug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const divisions = await apiJson<{ id: string; slug: string }[]>(
    page.request,
    `/api/v1/competitions/${competitionId}/divisions`,
  );
  const divisionId = divisions.data!.find((d) => d.slug === slug)!.id;

  const stages = await apiJson<{ id: string; seq: number; kind: string; progression: unknown }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
  );
  expect(stages.data).toHaveLength(2);
  const main = stages.data!.find((s) => s.seq === 1)!;
  const plate = stages.data!.find((s) => s.seq === 2)!;
  expect(main.kind).toBe("knockout");
  expect(plate.kind).toBe("knockout");
  // ko_plate preset (format-templates.ts): plate's progression sources the
  // main draw's round-1 losers, on_complete timing (F2 kept every template
  // writer's default timing unchanged — Decision 1). `q` (round-1 loser
  // count) defaults to 4 (division-builder.tsx's `qualified` knob), never
  // touched by this test.
  expect(plate.progression).toMatchObject({
    sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
    placement: "rank_order",
    timing: "on_complete",
  });

  const { ids } = await addEntrantsViaApi(request, divisionId, [
    "Ann",
    "Bo",
    "Cy",
    "Di",
    "Ed",
    "Fi",
    "Gu",
    "Hy",
  ]);
  const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
  type Fx = {
    id: string;
    status: string;
    round_no: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  };
  const gen = await apiJson<{ fixtures: Fx[] }>(
    request,
    `/api/v1/stages/${main.id}/generate`,
    "POST",
  );
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  const round1No = Math.min(...gen.data!.fixtures.map((f) => f.round_no));
  const round1 = gen.data!.fixtures.filter((f) => f.round_no === round1No);
  const namesById = new Map(ids.map((id, i) => [id, ["Ann", "Bo", "Cy", "Di", "Ed", "Fi", "Gu", "Hy"][i]!]));
  const expectedLoserNames = round1.map((f) =>
    (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99)
      ? namesById.get(f.away_entrant_id!)!
      : namesById.get(f.home_entrant_id!)!,
  );

  const decide = async (fid: string, a: number, b: number) => {
    const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fid}/state`);
    await apiJson(request, `/api/v1/fixtures/${fid}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: a, p2Score: b },
    });
  };
  for (let guard = 0; guard < 10; guard++) {
    const rows = (
      await apiJson<{ fixtures: Fx[] }>(request, `/api/v1/stages/${main.id}/generate`, "POST")
    ).data!.fixtures;
    const decidable = rows.filter(
      (f) => f.home_entrant_id && f.away_entrant_id && !["decided", "finalized"].includes(f.status),
    );
    if (decidable.length === 0) break;
    for (const f of decidable) {
      const homeWins = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
      await decide(f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
  }

  const done = await apiJson<{ completed: boolean; qualified?: { entrants: string[] } }>(
    request,
    `/api/v1/stages/${main.id}/complete`,
    "POST",
  );
  expect(done.data!.completed).toBe(true);
  expect(done.data!.qualified?.entrants).toHaveLength(4);
  await apiJson(request, `/api/v1/stages/${plate.id}/generate`, "POST");

  // See the plate seeded: at least one round-1 loser's name renders on the
  // division page (desktop first, then 375px — no horizontal scroll at
  // either).
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  await expect(page.getByText(expectedLoserNames[0]!).first()).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByText(expectedLoserNames[0]!).first()).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
});

test("ladder division renders the challenge panel", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Ladder ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Ladder", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["Alpha", "Bravo", "Charlie", "Delta"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1, kind: "ladder", name: "Ladder", config: { challengeRange: 2 },
  });

  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  // the ladder panel: challenge form + ranked entrants
  await expect(page.getByRole("button", { name: /issue challenge/i })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Alpha" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Charlie" })).toBeVisible();

  // issue a challenge: #3 (Charlie) challenges #1 (Alpha), within range 2
  await page.getByLabel("Challenger").selectOption({ label: "Charlie" });
  await page.getByLabel(/challenges \(must be above\)/i).selectOption({ label: "Alpha" });
  await page.getByRole("button", { name: /issue challenge/i }).click();

  // success clears the form (the challenge fixture was created) and no red
  // error banner appears
  await expect(page.getByLabel("Challenger")).toHaveValue("", { timeout: 20_000 });
  await expect(page.locator(".bg-red-50")).toHaveCount(0);
});

test("americano renders the rotation grid", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Americano ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Padel", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  const divisionId = div.data!.id;
  // americano needs individuals backed by persons
  const players = [];
  for (let i = 0; i < 8; i++) {
    const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: `Padel ${i + 1} ${TAG}`,
      consent: {},
    });
    players.push({
      kind: "individual", display_name: `Player ${i + 1}`, seed: i + 1,
      members: [{ person_id: p.data!.id, is_captain: false, roles: [] }],
    });
  }
  await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", players);
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 5 } },
  );
  await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  // the rotation grid: mode chip + round cards + courts (scoped to the panel)
  const grid = page.getByLabel("Americano rotation");
  await expect(grid.getByText("americano", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(grid.getByRole("heading", { name: "Round 1" })).toBeVisible();
  await expect(grid.getByText(/Court 1/).first()).toBeVisible();

  // in-grid scoring: fill the first match's two score boxes and save
  const scoreInputs = grid.getByRole("spinbutton");
  await scoreInputs.nth(0).fill("24");
  await scoreInputs.nth(1).fill("18");
  await grid.getByRole("button", { name: /save score/i }).first().click();

  // the match flips to scored and the personal-points leaderboard populates
  await expect(grid.getByText(/✓ scored/).first()).toBeVisible({ timeout: 20_000 });
  await expect(grid.getByRole("heading", { name: "Personal points" })).toBeVisible();
  // the scored pair's players now carry 24 points on the leaderboard
  await expect(grid.getByRole("cell", { name: "24", exact: true }).first()).toBeVisible();
});
