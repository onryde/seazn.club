// ONE organiser's club night, after somebody pulls out — driven through the
// screens, in the order it happens to them.
//
// A player who leaves mid-tournament is not a delete. She keeps the results
// she earned, she keeps her place in the record, and the draw she was
// qualified for must not quietly rearrange itself around her. PR #820 built
// four refusals for that, and they are only trustworthy TOGETHER: each one
// alone is equally satisfied by a product that simply removed her.
//
//   1. she is not offered in a ladder challenge picker;
//   2. she cannot be seeded into a bracket;
//   3. her standings row stays, and is MARKED;
//   4. her line in a drawn bracket resolves as a walkover — the survivors do
//      NOT slide up into new pairings.
//
// WHY A WALKTHROUGH, given #820 already shipped specs. `withdrawn-entrant-
// seeding.spec.ts`, `withdrawn-entrant-public-board.spec.ts` and
// `ladder-withdrawn-challenge.spec.ts` each prove one of these well, and none
// of them is redundant. What none of them does is the JOURNEY: every one of
// them performs the withdrawal over HTTP (`POST /entrants/{id}/withdraw`),
// which is the one step in this whole story that an organiser actually does
// with their hands — through a `btn-danger` behind a confirmation dialog that
// spells out the fixture surgery about to happen. A product where that button
// is wired to nothing passes all three of those specs. It also does not
// follow one departure across the surfaces it touches: entrants, then the
// draw, then the standings a spectator reads.
//
// WHAT IS A REACH AND WHAT IS THE TEST. Per this folder's README: the
// competition, the field, the stages and the scoring of the league are
// REACHES over the API. The withdrawal itself and every consequence claimed
// above are done and read in the browser.
//
// THE DIFFERENTIAL THAT MAKES §4 REAL. The organiser withdraws the
// SECOND-placed qualifier, never the last. With four qualifiers a bracket
// pairs 1v4 and 2v3, so:
//   - keeping the published positions leaves 1v4 an ordinary match and turns
//     2v3 into a walkover for 3;
//   - re-seeding the survivors 1..3 would pair them 1-v-bye and 2v3 — where
//     "2" and "3" are now the OLD third and fourth, a pairing that never
//     existed in the published draw.
// Withdrawing the LAST qualifier produces the same shape either way, which is
// why this file does not do that.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll, scoreFixture } from "../helpers";

/** The product's own words, from the dictionaries it renders — never retyped
 *  here, so a copy change reds this file instead of leaving it asserting
 *  yesterday's sentence. The standings chip is drawn by
 *  `components/public-site/standings-table.tsx`, which reads the PUBLIC
 *  dictionary even on the organiser's own tab. */
const UI = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const PUBLIC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/public.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The wait every `goto` and every state read in this file is given. */
const STEP_MS = 20_000;
/** A reach or a relayout is a fraction of a page load, not a page load. */
const REACH_MS = STEP_MS / 4;

/** Each test's budget is derived from ITS OWN list of full page loads, never a
 *  literal beside it (AGENTS.md 20 — a blown budget reports as whichever
 *  assertion was in flight, i.e. as a data defect). Adding a `goto` without
 *  adding a line here shrinks the allowance per step, so the lists are
 *  asserted against the journey at the top of each test. */
const CUP_NAVIGATIONS = [
  "?tab=fixtures — the proposal, before she leaves",
  "?tab=entrants — where the organiser withdraws her",
  "?tab=fixtures — the proposal, after she leaves",
  "?tab=fixtures — after the short draw is confirmed",
  "?tab=standings — her row, marked",
] as const;
const LADDER_NAVIGATIONS = [
  "?tab=fixtures — both pickers offer her",
  "?tab=entrants — where the organiser withdraws her",
  "?tab=fixtures — neither picker offers her",
] as const;
/** The cup journey scores six league matches over the API. */
const CUP_API_SCORES = 6;
/** 1280 / 768 / 320 at the end of each test. */
const WIDTH_CHECKS = 3;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface FixtureRow {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
}

async function fixturesOf(request: APIRequestContext, divisionId: string): Promise<FixtureRow[]> {
  const res = await apiJson<FixtureRow[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, `GET /divisions/${divisionId}/fixtures`).toBe(200);
  expect(res.data, "the fixtures read must carry rows").toBeDefined();
  return res.data!;
}

async function newCompetition(request: APIRequestContext, name: string): Promise<string> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name,
    visibility: "private",
  });
  expect(comp.status, `competition POST → ${comp.status} ${JSON.stringify(comp.error)}`).toBe(201);
  return comp.data!.id;
}

async function newDivision(
  request: APIRequestContext,
  compId: string,
  name: string,
): Promise<string> {
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  expect(div.status, `division POST → ${div.status} ${JSON.stringify(div.error)}`).toBe(201);
  return div.data!.id;
}

/** The organiser's own hands: find her row on the entrants tab, press
 *  Withdraw, and confirm the dialog that spells out the fixture surgery.
 *  This is the step every existing spec performs over HTTP — and the only
 *  step in this story a person actually does. */
async function withdrawThroughTheScreen(page: Page, name: string): Promise<void> {
  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row, `no entrants row for ${name}`).toHaveCount(1);
  // "Withdraw" is HARDCODED ENGLISH in `entrants-panel.tsx` — it is not in
  // any dictionary, so unlike every other string this file asserts it cannot
  // be read from one. Recorded here rather than silently retyped: the control
  // an organiser presses to remove somebody from a competition renders in
  // English in all four locales, which is a real gap in a different file.
  await row.getByRole("button", { name: "Withdraw", exact: true }).click();
  // The dialog is not decoration: it is where the policy is stated, so the
  // journey goes through it rather than around it.
  // `alertdialog`, not `dialog` — `confirm-provider.tsx` uses the alert role,
  // and `getByRole("dialog")` does not match it.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: STEP_MS });
  await expect(dialog, "the confirmation does not name who is leaving").toContainText(name);
  const go = dialog.getByRole("button", { name: UI["confirm.withdrawEntrant.label"]!, exact: true });
  // The danger button arms on its own tick (`disabled={!armed}`), so waiting
  // on the state is the difference between a click and a dropped click.
  await expect(go).toBeEnabled({ timeout: STEP_MS });
  await go.click();
  await expect(dialog).toBeHidden({ timeout: STEP_MS });
  // Her row STAYS, and now says so. A product that deleted her also passes
  // "she is not offered" everywhere below, so this is the assertion that
  // tells the two apart.
  await expect(row, "her entrants row vanished — she was deleted, not withdrawn").toHaveCount(1);
  // A VALUE, not copy: the status badge prints `entrant.status` verbatim
  // (`entrants-panel.tsx`), so this asserts the column the server wrote — the
  // same string `DEPARTED_STATUSES` holds — and not a translated word.
  await expect(row).toContainText("withdrawn", { timeout: STEP_MS });
}

test.describe.configure({ mode: "serial" });

test("an organiser withdraws a qualifier, and the draw walks her line over instead of reseeding", async ({
  page,
  request,
}) => {
  test.setTimeout(
    Math.max(
      120_000,
      CUP_NAVIGATIONS.length * STEP_MS + (CUP_API_SCORES + WIDTH_CHECKS) * REACH_MS,
    ),
  );
  expect(CUP_NAVIGATIONS.length, "the navigation list no longer describes this journey").toBe(5);

  const compId = await newCompetition(request, `Withdraw Walkthrough ${TAG}`);
  const divisionId = await newDivision(request, compId, "Open");

  // REACH: four players, a league, and a Finals that takes all four —
  // `STAGE_TEMPLATES.league_ko`'s own shape, so this is the draw an organiser
  // gets from the wizard rather than one invented for a test.
  const names = [`Ada ${TAG}`, `Bea ${TAG}`, `Cleo ${TAG}`, `Dot ${TAG}`];
  const entrants = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })),
  );
  expect(entrants.status, `entrants POST → ${entrants.status}`).toBe(201);
  const idOf = new Map(entrants.data!.map((e) => [e.display_name, e.id]));

  const stages = await apiJson<{ id: string; kind: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      {
        seq: 2,
        kind: "knockout",
        name: "Finals",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status, `stages POST → ${stages.status}`).toBe(201);
  const leagueId = stages.data!.find((s) => s.kind === "league")!.id;
  const finalsId = stages.data!.find((s) => s.kind === "knockout")!.id;

  const koGen = await apiJson<{ created: number }>(request, `/api/v1/stages/${finalsId}/generate`, "POST");
  expect(koGen.status, `finals generate → ${koGen.status}`).toBeLessThan(300);
  expect(koGen.data!.created, "two semis and a final").toBe(3);
  const leagueGen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${leagueId}/generate`,
    "POST",
  );
  expect(leagueGen.status, `league generate → ${leagueGen.status}`).toBeLessThan(300);
  expect(leagueGen.data!.fixtures.length, "4 entrants, single round robin").toBe(6);

  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start → ${started.status}`).toBeLessThan(300);

  // REACH: score so the table is Ada > Bea > Cleo > Dot, four distinct point
  // totals. No tie means the seeding proposal below has nothing to resolve —
  // and it means the qualifier ORDER is known, which is what makes the
  // reseeding differential in this file's header assertable at all.
  const seedOf = new Map(names.map((n, i) => [idOf.get(n)!, i + 1]));
  for (const f of (await fixturesOf(request, divisionId)).filter((f) => f.stage_id === leagueId)) {
    const homeBetter = seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)!;
    await scoreFixture(request, f.id, homeBetter ? 2 : 0, homeBetter ? 0 : 2);
  }
  const completed = await apiJson<{ completed: boolean; seed_proposal?: { status: string } }>(
    request,
    `/api/v1/stages/${leagueId}/complete`,
    "POST",
  );
  expect(completed.status, `complete → ${completed.status}`).toBeLessThan(300);
  expect(completed.data!.seed_proposal?.status, "no draft proposal to work with").toBe("draft");

  const quitter = names[1]!; // the SECOND-placed qualifier — see the header
  const quitterId = idOf.get(quitter)!;

  // BEFORE, on the organiser's own screen: she IS offered. Without this half
  // the refusal below cannot tell a working filter from a picker that was
  // always empty.
  const fixturesUrl = await divisionPath(request, divisionId, "?tab=fixtures");
  await page.goto(fixturesUrl);
  const draftPanel = page.locator('[data-progression-state="draft"]');
  await expect(draftPanel, "the seeding proposal panel never appeared").toBeVisible({ timeout: STEP_MS });
  await expect(
    draftPanel.locator("select").filter({ hasText: quitter }).first(),
    "she is not offered even before she leaves — this test would prove nothing",
  ).toBeAttached();

  // ------------------------------------------------ the organiser's own hands
  await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
  await withdrawThroughTheScreen(page, quitter);

  // §2 — she cannot be seeded into the bracket. Read off the real <select>,
  // because a server-side filter says nothing about what a person is SHOWN.
  await page.goto(fixturesUrl);
  await expect(draftPanel).toBeVisible({ timeout: STEP_MS });
  await expect(
    draftPanel.locator("select").filter({ hasText: quitter }),
    "the picker still offers the player who left",
  ).toHaveCount(0);
  // …and the filter removed ONE player, not the list.
  for (const other of names.filter((n) => n !== quitter)) {
    await expect(
      draftPanel.locator("select").filter({ hasText: other }).first(),
      `${other} disappeared from the picker too`,
    ).toBeAttached();
  }

  // §4 — the organiser confirms the short draw, through the screen.
  const confirmBtn = draftPanel.getByRole("button", { name: UI["progression.confirmCta"]!, exact: true });
  await expect(confirmBtn, "the proposal has a tie to resolve — this league was meant to be clean").toBeEnabled();
  await confirmBtn.click();
  await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: STEP_MS });

  const semis = (await fixturesOf(request, divisionId))
    .filter((f) => f.stage_id === finalsId && f.round_no === 1)
    .sort((a, b) => a.seq_in_round - b.seq_in_round);
  expect(semis.length, "the Finals lost its first round").toBe(2);
  const seats = (f: FixtureRow) => [f.home_entrant_id, f.away_entrant_id];

  // THE CLAIM. R1·1 still holds the first and fourth qualifiers, as published
  // — the pairing a reseed would have destroyed…
  expect(
    seats(semis[0]!).filter((x) => x !== null).sort(),
    "the survivors were reseeded: the top qualifier is no longer facing the fourth",
  ).toEqual([idOf.get(names[0]!)!, idOf.get(names[3]!)!].sort());
  expect(semis[0]!.status, "R1·1 is not an ordinary match any more").toBe("scheduled");
  expect(semis[0]!.outcome).toBeNull();
  // …and R1·2, which held her, is a settled walkover to the third qualifier,
  // not a match waiting for a draw.
  expect(seats(semis[1]!), "her seat was refilled from somewhere").not.toContain(quitterId);
  expect(seats(semis[1]!).filter((x) => x !== null)).toEqual([idOf.get(names[2]!)!]);
  expect(semis[1]!.status, "her line is still a match to play").toBe("forfeited");
  expect(semis[1]!.outcome?.kind).toBe("award");
  expect(semis[1]!.outcome?.winner).toBe(idOf.get(names[2]!)!);

  // And what the organiser SEES of it: the surviving name on that line, and
  // no seat anywhere still advertising a qualifier who has gone.
  await page.goto(fixturesUrl);
  // A settled walkover does NOT render as an ordinary draw-list row: it takes
  // `run-sheet-row.tsx`'s bye branch, which has no `data-fixture-no` at all.
  // (Looking for one is how this assertion first failed — worth recording,
  // because "the row is missing" and "the row is a bye" look identical to a
  // `data-fixture-no` probe, and only one of them is the correct outcome.)
  const byeLine = page.getByTestId("run-sheet-bye");
  await expect(byeLine, "her line is not rendered as a settled bye").toHaveCount(1);
  await expect(byeLine, "the survivor is not named on the line he was awarded").toContainText(names[2]!);
  await expect(byeLine, "the departed qualifier is still printed in the draw").not.toContainText(quitter);
  // The OTHER semi is still an ordinary, schedulable row — so the walkover is
  // one line, not a stage-wide settle.
  const liveRow = page.locator(`[data-fixture-no="${semis[0]!.fixture_no}"]`);
  await expect(liveRow, `no draw-list row for fixture ${semis[0]!.fixture_no}`).toHaveCount(1);
  await expect(liveRow).toContainText(names[0]!);
  await expect(liveRow).toContainText(names[3]!);

  // §3 — her standings row STAYS, and carries the product's own word for it.
  await page.goto(await divisionPath(request, divisionId, "?tab=standings"));
  const chip = page.getByTestId("standings-withdrawn");
  // COUNT, not presence: "a chip exists somewhere" is equally satisfied by a
  // chip on every row, which is the opposite of what it means.
  await expect(chip, "exactly one entrant left this division").toHaveCount(1);
  await expect(chip).toHaveText(PUBLIC["table.withdrawn"]!);
  const markedRow = page.locator("tr").filter({ has: chip });
  await expect(markedRow, "the chip is on somebody else's row").toContainText(quitter);
  // The control: everyone else is still listed, and unmarked.
  for (const other of names.filter((n) => n !== quitter)) {
    await expect(page.locator("tr").filter({ hasText: other }).first()).toBeVisible();
  }

  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("the same organiser withdraws a rung from the club ladder, and the challenge picker stops offering her", async ({
  page,
  request,
}) => {
  test.setTimeout(
    Math.max(120_000, LADDER_NAVIGATIONS.length * STEP_MS + WIDTH_CHECKS * REACH_MS),
  );
  expect(LADDER_NAVIGATIONS.length, "the navigation list no longer describes this journey").toBe(3);

  // A SECOND division, because a ladder is a different shape from a cup and
  // the first test's division cannot be one. Same organiser, same evening.
  const compId = await newCompetition(request, `Withdraw Ladder ${TAG}`);
  const divisionId = await newDivision(request, compId, "Club ladder");

  const names = [`Rung One ${TAG}`, `Rung Two ${TAG}`, `Rung Three ${TAG}`, `Rung Four ${TAG}`];
  const entrants = await apiJson<{ id: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })),
  );
  expect(entrants.status, `entrants POST → ${entrants.status}`).toBe(201);
  const ids = entrants.data!.map((e) => e.id);

  const stages = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [{ seq: 1, kind: "ladder", name: "Club ladder", config: { challengeRange: 3 } }],
  );
  expect(stages.status, `stages POST → ${stages.status}`).toBe(201);
  // REACH: one real challenge seats `config.ladder_order` the way a live
  // ladder gets it. That array is written once and never pruned — which is
  // exactly why a departed player keeps the rung she earned.
  const seated = await apiJson<{ ladder_order: string[] }>(
    request,
    `/api/v1/stages/${stages.data![0]!.id}/challenges`,
    "POST",
    { challenger_id: ids[1]!, opponent_id: ids[0]! },
  );
  expect(seated.status, `challenge POST → ${seated.status}`).toBe(201);
  const order = seated.data!.ladder_order;
  const nameOf = new Map(entrants.data!.map((e) => [e.id, e.display_name]));
  const quitterId = order[2]!;
  const quitter = nameOf.get(quitterId)!;

  const fixturesUrl = await divisionPath(request, divisionId, "?tab=fixtures");
  await page.goto(fixturesUrl);
  // BEFORE: both pickers offer her.
  await expect(
    page.locator("select").filter({ hasText: quitter }),
    "she was never offered — the refusal below would prove nothing",
  ).toHaveCount(2);

  await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
  await withdrawThroughTheScreen(page, quitter);

  // §1 — gone from both pickers…
  await page.goto(fixturesUrl);
  await expect(
    page.locator("select").filter({ hasText: quitter }),
    "the challenge picker still offers the player who left",
  ).toHaveCount(0);
  // …but still ON the ladder, at the rung she earned, marked as departed.
  await expect(page.locator(`[data-ladder-withdrawn="${quitterId}"]`)).toBeVisible({ timeout: STEP_MS });
  const rungs = await page.locator("table tbody tr td:first-child").allTextContents();
  expect(rungs.map((t) => t.trim()), "the ladder closed up over her").toEqual(["1", "2", "3", "4"]);
  // Everyone else is still offered — one player removed, not the list.
  for (const id of order.filter((x) => x !== quitterId)) {
    await expect(
      page.locator("select").filter({ hasText: nameOf.get(id)! }).first(),
      `${nameOf.get(id)} disappeared from the picker too`,
    ).toBeAttached();
  }

  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
});
