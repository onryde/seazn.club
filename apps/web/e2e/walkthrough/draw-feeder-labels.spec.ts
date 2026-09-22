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
// THE SPECTATOR IS IN THIS FILE TOO, and deliberately in the SAME journey
// rather than a file of its own. The gap the owner reported is not "a public
// page is wrong" — it is that on the SAME DAY, on the SAME match, the
// organiser read "Winner of R1·1" and a spectator read "TBD". Only one
// test can witness that: one that has both readers look at one fixture at one
// moment. So this competition is PUBLIC, and after the draw is confirmed an
// anonymous context opens the share pages and reads the same final.
//
// THE VOCABULARY SPLIT IS DELIBERATE AND IS ASSERTED AS SUCH. The organiser
// board says "Winner of R1·1" (`slot.winner_match` + the board's short
// match ref); the public surfaces say "Winner of Semi-finals, match 1"
// (`knockout.feederWinner` + the rail's round name). Same `{round, seq}`, two
// vocabularies, on purpose. The spectator half below therefore asserts BOTH
// directions: the public phrase is present AND the organiser's phrasing is
// absent, because a "fix" that leaked the board's text onto a share page
// would pass a presence-only test.
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
// A genuinely signed-out context with the cookie banner already dismissed —
// the spectator surfaces' own helper, never a bare `browser.newContext()`
// (that one inherits the storage state and would read the pages as staff).
import { anonPage, closeOpenContexts, publicFixturePath } from "../spectator-public-helpers";

/** Every user-facing string this file asserts comes from the dictionary the
 *  product renders, never retyped here (house pattern). A copy change reds
 *  this file, which is the point. */
const L = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The PUBLIC dictionary — a different book from `ui.json` above, and that is
 *  the point: the two vocabularies are asserted against their own sources so a
 *  copy change in either one reds this file rather than passing by accident. */
const P = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/public.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The shipped sentence a PUBLIC surface gives a winner-fed seat:
 *  `knockout.feederWinner`, filled with the round's own NAME (never a round
 *  number, and never the board's `R1·1` ref). The round name is read off
 *  the page itself rather than recomputed here — see `SEMIS_CAPTION`. */
const publicFeeder = (round: string, seq: number): string =>
  P["knockout.feederWinner"]!.replace("{round}", round).replace("{seq}", String(seq));

/** The bracket's round captions, in either shape it renders: the two-sided
 *  tree paints them as direct-child spans, the column fallback as `h3`s. The
 *  first is round 1's — the round that feeds the final. */
const SEMIS_CAPTION = '[data-bracket="two-sided"] > div > span, [data-bracket="columns"] h3';

/** The shipped sentence for a winner-fed seat, composed the way
 *  `resolveSlotLabel` composes it — `{ext}` filled from `slot.match_ref`,
 *  never concatenated by hand here. */
const feeder = (round: number, seq: number): string =>
  L["slot.winner_match"]!.replace(
    "{ext}",
    L["slot.match_ref"]!.replace("{round}", String(round)).replace("{seq}", String(seq)),
  );

/** The shipped sentence for a seat still held by a SEED — `slot.rank_range`,
 *  what a setup progression stamps on every round-1 seat. From the dictionary
 *  for the same reason the feeder is: a retyped "Rank 1" is a second home for
 *  copy this file's header promises it never keeps. */
const seedSeat = (rank: number): string => L["slot.rank_range"]!.replace("{rank}", String(rank));

/** The wait every `goto` and every state read in this file is given. */
const STEP_MS = 20_000;

/**
 * THE BUDGET, derived from the steps rather than typed beside them.
 *
 * AGENTS.md 20: when a Playwright budget blows, the runner prints whichever
 * assertion was in flight — so a wall-clock overrun reports as "the final lost
 * its feeder", a DATA defect, ABOVE the timeout line. A flat literal beside a
 * growing test is therefore a latent misdiagnosis, and the first version of
 * this file had one: `PAGE_LOADS = 3` with a comment claiming four, against a
 * journey that really performs seven.
 *
 * `NAVIGATIONS` is the list itself, so adding a step moves the budget with it.
 * Each entry is one FULL page load — `waitForURL` included, because the wizard
 * navigates on submit and the wait is the page load, not a state read.
 */
const NAVIGATIONS = [
  "/competitions/new — the competition wizard",
  "…and the competition page it lands on",
  "/d/new — the division wizard",
  "…and the division page it lands on",
  "?tab=fixtures — drawn and unplayed",
  "?tab=fixtures — after the seeding is confirmed",
  "/shared/… — the same draw, read by an anonymous spectator (both tabs)",
  "/shared/…/fixtures/<final> — the match centre a share link lands on",
  "/embed/divisions/<id>/bracket — the same draw in somebody else's page",
  "/shared/<org>/<comp>?tab=matches — the hub's own card for that match",
  "?tab=fixtures — after the first semi is decided",
] as const;
/** The API reaches this journey makes that cost real time: six league matches
 *  and one semi, each a `/state` read plus an `/events` POST. */
const API_SCORES = 7;
/** 1280 / 768 / 320 on the organiser tab, plus the spectator's own
 *  no-horizontal-scroll read — a relayout and a visibility wait each. */
const WIDTH_CHECKS = 4;
/** A reach or a relayout is a fraction of a page load, not a page load. */
const REACH_MS = STEP_MS / 4;
const BUDGET_MS = Math.max(
  120_000,
  NAVIGATIONS.length * STEP_MS + (API_SCORES + WIDTH_CHECKS) * REACH_MS,
);

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

// The anonymous contexts the spectator half opens are closed here, never in a
// `finally`: a Playwright timeout skips `finally` and never skips `afterEach`.
test.afterEach(closeOpenContexts);

test("an organiser builds a League + Finals draw, reads who feeds each seat, and watches one become a name", async ({
  browser,
  page,
  request,
}) => {
  // Derived — see `BUDGET_MS` and the `NAVIGATIONS` list it is built from.
  test.setTimeout(BUDGET_MS);
  // The list is the budget's only input, so it must describe THIS test. A
  // navigation added below without a line up there silently shrinks the
  // allowance per step, which is the shape rule 20 exists to stop.
  expect(NAVIGATIONS.length, "the navigation list no longer describes this journey").toBe(11);

  // ---------------------------------------------------------------- the draw
  // PUBLIC, because the second half of this journey is a spectator reading the
  // same draw over the share link. Nothing else about the organiser half
  // depends on it.
  const compId = await createCompetitionViaUi(page, `Draw Feeders ${TAG}`, "public");

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
  await expect(sheet.getByText(seedSeat(1), { exact: false }).first()).toBeVisible();
  await expect(tree.getByText(seedSeat(1), { exact: false }).first()).toBeVisible();
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
  const confirmBtn = panel.getByRole("button", { name: L["progression.confirmCta"]!, exact: true });
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

  // ------------------------------------------- THE SAME MATCH, A SPECTATOR
  // Same fixture, same moment, a signed-out reader. This is the half the
  // owner's report is actually about: the organiser above has just read both
  // feeders off the final; a spectator opening the share link read "TBD".
  const [, orgSlug, compSlug, pubDivSlug] = (await divisionPath(request, divisionId)).match(
    /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/]+)$/,
  )!;
  const spectator = await anonPage(browser, { width: 1280, height: 900 });
  await spectator.goto(`/shared/${orgSlug}/${compSlug}/${pubDivSlug}`);
  // The share link lands on Schedule; the DRAW is one tab across. Tapping is
  // what a spectator does and costs no page load — and the panels are all in
  // the ISR payload, so the bracket is ATTACHED from the first byte and only
  // `hidden`. Asserting `toBeVisible` after the tap is therefore the assertion
  // that has to be made: a `toBeAttached` here would pass without the tap and
  // prove nothing about what anyone can read.
  await expect(spectator.locator("#panel-schedule"), "the public division page never rendered").toBeVisible({
    timeout: STEP_MS,
  });
  await spectator.getByRole("tab", { name: P["division.tab.standings"]!, exact: true }).click();
  const publicBracket = spectator.locator("[data-bracket]").first();
  await expect(publicBracket, "the public draw never rendered").toBeVisible({ timeout: STEP_MS });

  // The round's PUBLIC name, taken from the page's own caption rather than
  // recomputed here — the claim being made is that the final names the round
  // THIS page calls round 1, which a name typed into the test cannot check.
  // `textContent`, NOT `innerText`: the caption is `uppercase` in CSS and
  // `innerText` returns what is PAINTED — "SEMI-FINALS" — which would never
  // match the sentence the namer composes from the underlying word.
  const semisName = ((await spectator.locator(SEMIS_CAPTION).first().textContent()) ?? "").trim();
  expect(semisName, "the public bracket printed no round name to compose against").not.toBe("");
  expect(
    semisName,
    "the public bracket captioned round 1 with the board's short ref, not a round name",
  ).not.toMatch(/R\d/);
  const publicR1_1 = publicFeeder(semisName, 1);
  const publicR1_2 = publicFeeder(semisName, 2);
  expect(publicR1_2, "the two public feeder sentences are identical").not.toBe(publicR1_1);
  // …and they are NOT the organiser's sentences, or every assertion below
  // would pass in both vocabularies and witness nothing.
  expect(publicR1_1, "the public and board phrasings collapsed into one").not.toBe(R1_1);

  const publicFinal = publicBracket.locator(`a[href$="/fixtures/${finalRow.id}"]`);
  await expect(publicFinal, "no public bracket card for the final").toHaveCount(1);
  // BOTH seats, EXACTLY and IN ORDER, read off the two side spans' own
  // `title` — not `toContainText` on the card.
  //
  // Two reasons, and the second is a trap worth leaving written down. A
  // contains-check cannot tell "home is named" from "away is named", so it
  // passes on a half-fix. And the card's FOOTER carries its own "TBD" — the
  // schedule rail's word for a match with no result and no time (`copy.tbd`,
  // nothing to do with a seat) — so a card-level `not.toContainText("TBD")`
  // reds on a card whose seats are both perfectly named. It did, on the first
  // run of this test, against a build where the fix was working.
  const sideTitles = await publicFinal
    .locator("span[title]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("title")));
  expect(
    sideTitles,
    "the spectator's final does not name both its feeders in the public vocabulary",
  ).toEqual([publicR1_1, publicR1_2]);
  // Said as the symptom, so a future reader can see the defect in the test:
  // neither seat is the bracket's "to be decided" word any more.
  expect(sideTitles, "the spectator is still reading TBD on a seat").not.toContain(L["bracket.tbd"]!);
  // And the other direction — the deliberate split held. The board's "Winner
  // of R1·1" must never appear on a share page.
  expect(sideTitles, "the organiser's board vocabulary leaked onto a public page").not.toContain(R1_1);
  // The positive pair for that negative: a seeded semi still shows a real
  // person, so "no board text" cannot be passing on an empty card.
  await expect(
    publicBracket.locator(`a[href$="/fixtures/${semi1.id}"]`),
    "the public bracket rendered no entrant at all",
  ).toContainText(names[0]!);

  // Back on the tab the share link actually lands on. The schedule rail names
  // its waiting sides through a DIFFERENT path from the bracket beside it
  // (`slotLabels`, pre-resolved on the server), and a fix applied to one and
  // not the other is precisely the defect this file exists for, one tab over.
  await spectator.getByRole("tab", { name: P["division.tab.schedule"]!, exact: true }).click();
  const schedulePanel = spectator.locator("#panel-schedule");
  await expect(schedulePanel).toBeVisible();
  const scheduleFinal = schedulePanel.locator(`a[href$="/fixtures/${finalRow.id}"]`).first();
  await expect(scheduleFinal, "no schedule row for the final").toHaveCount(1);
  await expect(scheduleFinal, "the schedule rail's final lost its first feeder").toContainText(publicR1_1);
  await expect(scheduleFinal, "the schedule rail's final lost its second feeder").toContainText(publicR1_2);
  await expect(scheduleFinal, "the board's vocabulary leaked into the schedule rail").not.toContainText(R1_1);

  // The match centre — where a share link actually lands, and a separate read
  // (`match-centre-load.ts`) with its own stage-scoped query. A fix applied
  // only to the division page would leave this page saying TBD.
  await spectator.goto(publicFixturePath(orgSlug, compSlug, pubDivSlug, finalRow.id));
  const centre = spectator.locator("main");
  await expect(centre, "the match centre never rendered").toBeVisible({ timeout: STEP_MS });
  await expect(centre, "the match centre's home seat lost its feeder").toContainText(publicR1_1);
  await expect(centre, "the match centre's away seat lost its feeder").toContainText(publicR1_2);
  await expect(centre, "the organiser's board vocabulary leaked into the match centre").not.toContainText(
    R1_1,
  );
  await expectNoHorizontalScroll(spectator);

  // The embed widget — a THIRD read (`server/embed-data.ts`, its own explicit
  // select), rendering the same bracket component inside a stranger's page.
  // It is here because a read that omits the feed columns compiles clean and
  // returns undefined for them: without a surface that drives it, that select
  // is exactly the shape that ships inert.
  await spectator.goto(`/embed/divisions/${divisionId}/bracket`);
  const embedFinal = spectator.locator(`a[href$="/fixtures/${finalRow.id}"]`).first();
  await expect(embedFinal, "the embed bracket never rendered the final").toBeVisible({ timeout: STEP_MS });
  const embedTitles = await embedFinal
    .locator("span[title]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("title")));
  expect(embedTitles, "the embedded draw does not name the final's feeders").toEqual([
    publicR1_1,
    publicR1_2,
  ]);

  // The competition hub — its own read (`server/public-site/competition-hub.ts`,
  // `hubSides`) and the page most spectators actually land on first.
  // `?tab=matches` deliberately: that tab is the one built from `hubSides`,
  // the hub's own naming path. The hub lands on Overview, which shows a
  // selection rather than every match.
  await spectator.goto(`/shared/${orgSlug}/${compSlug}?tab=matches`);
  const hubFinal = spectator.locator(`a[href$="/fixtures/${finalRow.id}"]`).first();
  await expect(hubFinal, "the hub never showed the final").toBeVisible({ timeout: STEP_MS });
  await expect(hubFinal, "the hub's final lost its first feeder").toContainText(publicR1_1);
  await expect(hubFinal, "the hub's final lost its second feeder").toContainText(publicR1_2);

  // The subscribed CALENDAR — the one public surface with no page to open, and
  // therefore the one most likely to be left behind. Fetched through the
  // spectator's own signed-out context, never the staff `request`.
  //
  // TWO layers of RFC 5545 stand between the feed and a substring match, and
  // both of them red a perfectly correct calendar:
  //   1. FOLDING — any line over 75 octets continues on the next line, which
  //      begins with a space, splitting the sentence mid-word.
  //   2. TEXT ESCAPING — a comma inside a SUMMARY is written `\,`. The public
  //      feeder phrase has a comma in it ("Winner of Semi-finals, match 1"),
  //      so the raw body never contains the sentence as the dictionary spells
  //      it. This one cost a run: the calendar was already right.
  // Undo both, in that order, before asserting.
  const ics = await spectator.request.get(
    `/shared/${orgSlug}/${compSlug}/${pubDivSlug}/calendar.ics`,
  );
  expect(ics.status(), "the public calendar did not serve").toBe(200);
  const unfolded = (await ics.text()).replace(/\r\n /g, "").replace(/\\([,;\\])/g, "$1");
  expect(unfolded, "the calendar's final lost its first feeder").toContain(publicR1_1);
  expect(unfolded, "the calendar's final lost its second feeder").toContain(publicR1_2);
  expect(unfolded, "the organiser's board vocabulary leaked into the calendar").not.toContain(R1_1);

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
