// ONE organiser's path through a League + Finals draw, from the wizard to a
// named seat becoming a real person — driven through the screens.
//
// THE DEFECT THIS EXISTS FOR (owner report, 2026-09-21). On `?tab=fixtures`
// the bracket TREE and the draw LIST under it both showed a Finals whose
// semi-finals read "Rank 1 vs Rank 4" and whose final read "TBD vs TBD —
// Awaiting draw", while the SCHEDULE showed that same fixture as "Winner of
// R1·1 vs Winner of R1·2". Three surfaces, two of them wrong, each one
// individually correct against its own test.
//
// WHY A WALKTHROUGH AND NOT ANOTHER SLICE. `run-sheet.spec.ts` now asserts
// the two panels agree at 1280 and `mobile.spec.ts` does the same at the
// seven phone widths, but both of those stop at the drawn-and-unplayed
// state. What no slice covers is the JOURNEY: that the words an organiser
// reads on the day they build the draw are still the right words after the
// draw is confirmed, and that they turn into a NAME at the moment the match
// that feeds the seat is decided. A label that is right at setup and stale
// afterwards is the same defect one screen later.
//
// THE SHAPE, and why it is the template rather than a hand-built stage list.
// `STAGE_TEMPLATES.league_ko` — what an organiser gets by picking "League +
// Finals" in the wizard — is `timing: "setup"`, and that is the only shape
// affected: the plain `generateStageFixtures` stamps `slot.winner_match`
// into `*_slot_label`, so a plain knockout never showed this.
// `generateProgressionSetupFixtures` deliberately leaves a sibling-fed seat's
// stored label NULL (`stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒
// sibling-fed"), so the FEED EDGES are the only thing that knows who feeds
// that seat. Driving the real template is what keeps this test about the
// product rather than about a stage payload typed into a test file.
//
// WHAT IS A REACH AND WHAT IS THE TEST. Per this folder's README: entrants,
// generation and the scoring of eight matches are REACHES over the API — the
// pad is walked tap by tap in `scorepad-v3-*.spec.ts` and replaying it here
// would buy this leg nothing but minutes. Every step this file makes a CLAIM
// about — the wizard, the tree, the list, the seeding confirmation, and the
// three states the final's two seats pass through — is done and read in the
// browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  competitionPath,
  createCompetitionViaUi,
  divisionPath,
  expectNoHorizontalScroll,
  scoreFixture,
} from "../helpers";

/** Every user-facing string this file asserts comes from the dictionary the
 *  product renders, never retyped here (house pattern). A copy change reds
 *  this file, which is the point. */
const L = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The shipped sentence for a winner-fed seat, composed the way
 *  `resolveSlotLabel` composes it — `{ext}` filled from `slot.match_ref`,
 *  never concatenated by hand here. */
const feeder = (round: number, seq: number): string =>
  L["slot.winner_match"]!.replace(
    "{ext}",
    L["slot.match_ref"]!.replace("{round}", String(round)).replace("{seq}", String(seq)),
  );

/** The wait every `goto` and every state read in this file is given. */
const STEP_MS = 20_000;

/** `division-builder.tsx`'s own default for the `qualified` knob. Pinned
 *  because it is what decides the bracket has TWO rounds — and therefore a
 *  sibling-fed seat at all (AGENTS.md 19: pin what a control opens at). */
const QUALIFIERS = 4;

interface FixtureRow {
  id: string;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

async function fixturesOf(request: APIRequestContext, divisionId: string): Promise<FixtureRow[]> {
  const res = await apiJson<FixtureRow[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, `GET /divisions/${divisionId}/fixtures`).toBe(200);
  expect(res.data, "the fixtures read must carry rows").toBeDefined();
  return res.data!;
}

test("an organiser builds a League + Finals draw, reads who feeds each seat, and watches one become a name", async ({
  page,
  request,
}) => {
  // Derived from the waits this test actually spends, never a flat literal
  // beside them (AGENTS.md 20): four full page loads at STEP_MS plus ~9
  // in-page state waits. Moving STEP_MS moves the budget with it.
  const PAGE_LOADS = 3;
  const UI_STEPS = 9;
  test.setTimeout(Math.max(60_000, PAGE_LOADS * STEP_MS + UI_STEPS * 2_000));

  // ---------------------------------------------------------------- the draw
  const compId = await createCompetitionViaUi(page, `Draw Feeders ${TAG}`, "private");

  // The division through the wizard, on the Format tab, picking the template
  // that ships two stages. `createDivisionViaUi` never visits that tab and
  // always ships one `league` stage, which has no sibling-fed seat in it.
  await page.goto(await competitionPath(request, compId, "/d/new"));
  await page.getByRole("textbox").first().fill(`Singles ${TAG}`);
  // `generic` explicitly: the wizard defaults to whichever sport sorts first
  // by NAME, and this journey scores eight matches through `generic.result`.
  // Leaving the default made the whole file fail at the first score with
  // `422 unknown event type` — a sport choice, not a scoring defect.
  await page.getByRole("combobox", { name: "Sport", exact: true }).selectOption("generic");
  await page.getByRole("button", { name: L["wizard.tab.format"], exact: true }).click();
  // The radio is `sr-only` inside its card `<label>`, and the label's text is
  // title + help, so an exact accessible-name match cannot address it.
  const leagueKo = page
    .locator("label")
    .filter({ has: page.locator('input[name="template"]') })
    .filter({ hasText: L["format.template.league_ko.label"] });
  await leagueKo.click();
  await expect(leagueKo.locator("input"), "the League + Finals radio did not take").toBeChecked();
  await page.getByRole("button", { name: L["wizard.tab.scheduling"], exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: STEP_MS });
  const divSlug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const divisions = await apiJson<{ id: string; slug: string }[]>(
    request,
    `/api/v1/competitions/${compId}/divisions`,
  );
  const divisionId = divisions.data!.find((d) => d.slug === divSlug)!.id;

  // What the wizard really built. Pinned, because every claim below depends
  // on it: two stages, the second a `timing: "setup"` progression taking the
  // top four — which is what makes the Finals two rounds, and therefore what
  // gives it a seat fed by a sibling rather than by a seed.
  const stages = await apiJson<
    { id: string; seq: number; kind: string; name: string; progression: unknown }[]
  >(request, `/api/v1/divisions/${divisionId}/stages`);
  expect(stages.status, `stages GET → ${stages.status}`).toBe(200);
  expect(
    stages.data!.map((s) => `${s.seq}:${s.kind}:${s.name}`),
    "League + Finals must ship a league stage then a knockout stage",
  ).toEqual(["1:league:League", "2:knockout:Finals"]);
  const leagueId = stages.data![0]!.id;
  const finalsId = stages.data![1]!.id;
  expect(
    stages.data![1]!.progression,
    "the Finals is not the setup-timed rank_order progression this defect lives in",
  ).toMatchObject({
    timing: "setup",
    placement: "rank_order",
    sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: QUALIFIERS }] }],
  });

  // REACH: the field, and both stages' fixtures.
  const names = [`Ada ${TAG}`, `Bo ${TAG}`, `Cy ${TAG}`, `Di ${TAG}`];
  const entrants = await addEntrantsViaApi(request, divisionId, names);
  expect(entrants.status, `entrants POST → ${entrants.status}`).toBeLessThan(300);
  const nameById = new Map(entrants.ids.map((id, i) => [id, names[i]!]));
  // Seed order IS the order `addEntrantsViaApi` created them in, and the
  // league below is scored so that order is also the final table — which is
  // what makes the semi-final pairings predictable enough to assert on.
  const seedOf = new Map(entrants.ids.map((id, i) => [id, i + 1]));

  const leagueGen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${leagueId}/generate`,
    "POST",
  );
  expect(leagueGen.status, `league generate → ${leagueGen.status}`).toBeLessThan(300);
  expect(leagueGen.data!.fixtures.length, "4 entrants, single round robin").toBe(6);

  const finalsGen = await apiJson<{ created: number; fixtures: { home_entrant_id: string | null }[] }>(
    request,
    `/api/v1/stages/${finalsId}/generate`,
    "POST",
  );
  expect(finalsGen.status, `finals generate → ${finalsGen.status}`).toBeLessThan(300);
  // Two semis + a final, every seat empty: the draw exists, nobody is in it.
  // Without this the whole file could run against a bracket with no
  // sibling-fed seat, and prove nothing.
  expect(finalsGen.data!.created, "the Finals should be two semis and a final").toBe(3);
  expect(finalsGen.data!.fixtures.every((f) => f.home_entrant_id === null)).toBe(true);

  const drawn = await fixturesOf(request, divisionId);
  const finalRow = drawn.find((f) => f.stage_id === finalsId && f.round_no === 2)!;
  expect(finalRow, "no round-2 fixture — nothing here is sibling-fed").toBeDefined();
  const semi1 = drawn.find((f) => f.stage_id === finalsId && f.round_no === 1 && f.seq_in_round === 1)!;
  const semi2 = drawn.find((f) => f.stage_id === finalsId && f.round_no === 1 && f.seq_in_round === 2)!;

  const R1_1 = feeder(1, 1);
  const R1_2 = feeder(1, 2);
  expect(R1_2, "the two feeder sentences are identical — nothing below could tell them apart").not.toBe(R1_1);

  // --------------------------------------------- what the organiser now sees
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const sheet = page.getByTestId("run-sheet");
  const tree = page.getByTestId("bracket-panel");
  await expect(sheet, "the draw list never rendered").toBeVisible({ timeout: STEP_MS });
  await expect(tree, "the bracket tree never rendered").toBeVisible({ timeout: STEP_MS });

  // The SAME match on both panels, tied by its per-division ordinal —
  // `data-fixture-no` on the list row, `/f/<no>` on the tree node's href.
  // Asserting each panel separately is exactly what let them drift apart.
  const listRowFor = (no: number): Locator => sheet.locator(`[data-fixture-no="${no}"]`);
  const treeNodeFor = (no: number): Locator => tree.locator(`a[href$="/f/${no}"]`);
  const finalInList = listRowFor(finalRow.fixture_no);
  const finalInTree = treeNodeFor(finalRow.fixture_no);
  await expect(finalInList, `no draw-list row for fixture ${finalRow.fixture_no}`).toHaveCount(1);
  await expect(finalInTree, `no tree node for fixture ${finalRow.fixture_no}`).toHaveCount(1);

  // STATE 1 — drawn, unplayed. The final names BOTH its feeders, on BOTH
  // panels. This is the state the owner reported as "TBD vs TBD".
  for (const where of [finalInList, finalInTree]) {
    await expect(where).toContainText(R1_1);
    await expect(where).toContainText(R1_2);
  }
  // The positive pair: the seeded semis DID render their own stored labels,
  // so an absent "Winner of" above would be a real absence, not a blank tab.
  await expect(sheet.getByText("Rank 1", { exact: false }).first()).toBeVisible();
  await expect(tree.getByText("Rank 1", { exact: false }).first()).toBeVisible();
  // …and nothing on this tab says TBD, on a bracket where every seat has
  // either a known seed or a known feeder.
  await expect(sheet.getByText(/^TBD$/)).toHaveCount(0);
  await expect(tree.getByText(/^TBD$/)).toHaveCount(0);
  await expect(sheet, "a raw dictionary key reached the screen").not.toContainText("slot.winner_match");

  // The standing UI bar, on the screen that carries the fix.
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(sheet.getByText(R1_1, { exact: false }).first()).toBeVisible({ timeout: STEP_MS });
    await expectNoHorizontalScroll(page);
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // ------------------------------------------------- the organiser plays on
  // REACH: start, then score the league so the table is A > B > C > D with no
  // tie anywhere — the seeding proposal then has nothing to resolve and can
  // be confirmed in one click, which is the journey this file is about.
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start → ${started.status}`).toBeLessThan(300);
  const leagueRows = (await fixturesOf(request, divisionId)).filter((f) => f.stage_id === leagueId);
  expect(leagueRows.length, "the league rows went missing").toBe(6);
  for (const f of leagueRows) {
    const homeSeed = seedOf.get(f.home_entrant_id!)!;
    const awaySeed = seedOf.get(f.away_entrant_id!)!;
    // The better seed always wins, so points are 9/6/3/0 — four distinct
    // totals, hence no tie-break, hence no tied row in the panel below.
    await scoreFixture(request, f.id, homeSeed < awaySeed ? 2 : 0, homeSeed < awaySeed ? 0 : 2);
  }
  const completed = await apiJson<{ completed: boolean; seed_proposal?: { status: string } }>(
    request,
    `/api/v1/stages/${leagueId}/complete`,
    "POST",
  );
  expect(completed.status, `complete → ${completed.status}`).toBeLessThan(300);
  expect(completed.data!.completed, "the league did not complete").toBe(true);
  expect(completed.data!.seed_proposal?.status, "no draft proposal to confirm").toBe("draft");

  // THROUGH THE SCREEN: the organiser confirms the draw.
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  const panel = page.locator('[data-progression-state="draft"]');
  await expect(panel, "the seeding proposal panel never appeared").toBeVisible({ timeout: STEP_MS });
  const confirmBtn = panel.getByRole("button", { name: "Confirm proposal" });
  // Nothing is tied, so it is actionable immediately — asserted, because a
  // disabled button here would mean the league produced a tie and the rest
  // of this journey is about a different scenario than the one described.
  await expect(confirmBtn, "the proposal has a tie to resolve — this league was meant to be clean").toBeEnabled();
  await confirmBtn.click();
  await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: STEP_MS });

  // STATE 2 — drawn AND seeded. The semis now hold real people…
  const seededSemi1 = listRowFor(
    (await fixturesOf(request, divisionId)).find((f) => f.id === semi1.id)!.fixture_no,
  );
  await expect(seededSemi1).toContainText(names[0]!); // top seed, seeded into R1·1
  // …and the final STILL names both its feeders, because neither semi has
  // been played. This is the step a slice cannot see: a label that was right
  // at setup and goes stale after the draw is the same defect, one screen on.
  for (const where of [finalInList, finalInTree]) {
    await expect(where).toContainText(R1_1);
    await expect(where).toContainText(R1_2);
  }
  await expect(sheet.getByText(/^TBD$/)).toHaveCount(0);

  // REACH: the first semi is played, top seed through.
  const seededRows = await fixturesOf(request, divisionId);
  const playedSemi = seededRows.find((f) => f.id === semi1.id)!;
  expect(playedSemi.home_entrant_id, "R1·1 was never seeded").not.toBeNull();
  const semiWinner = nameById.get(playedSemi.home_entrant_id!)!;
  await scoreFixture(request, playedSemi.id, 2, 0);

  // STATE 3 — one feeder resolved. The seat R1·1 fed is now a PERSON, and the
  // other seat still reads its feeder. Both halves matter: a fix that
  // replaced every label with a name, or none of them, passes half of this.
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
  await expect(sheet).toBeVisible({ timeout: STEP_MS });
  for (const where of [finalInList, finalInTree]) {
    await expect(where).toContainText(semiWinner);
    await expect(where, "the resolved seat still advertises its feeder").not.toContainText(R1_1);
    await expect(where, "the UNPLAYED seat lost its feeder").toContainText(R1_2);
  }
  await expect(sheet.getByText(/^TBD$/)).toHaveCount(0);
  await expect(tree.getByText(/^TBD$/)).toHaveCount(0);
  // The second semi is untouched by any of this — the positive pair for the
  // negative above, so "not R1_1" cannot pass because the page went blank.
  await expect(listRowFor(seededRows.find((f) => f.id === semi2.id)!.fixture_no)).toContainText(
    nameById.get(seededRows.find((f) => f.id === semi2.id)!.home_entrant_id!)!,
  );
  await expectNoHorizontalScroll(page);
});
