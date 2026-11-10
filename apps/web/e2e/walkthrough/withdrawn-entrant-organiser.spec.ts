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
//   4. while the seeding is still a DRAFT, the table closes up over her and
//      the next-ranked takes her place (RB4-V6, W4 rulebook §5, OWNER 274);
//      once the draw is CONFIRMED, a departure's line resolves as a walkover —
//      the survivors do NOT slide up into new pairings.
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
// SECOND-placed qualifier from the DRAFT, never the last. With four qualifiers
// a bracket pairs 1v4 and 2v3, so:
//   - RB4-V6 closes the league table up over her — Ada 1, Cleo 2, Dot 3, and
//     rank 4 empty (four entrants, four places: nobody below the cut) — so
//     R1·1 is the top qualifier's bye and R1·2 pairs the OLD third and fourth;
//   - keeping the published positions (the pre-W4 answer) would have left
//     1v4 an ordinary match and turned 2v3 into a walkover for 3.
// The two answers differ on BOTH lines. Withdrawing the LAST qualifier
// produces the same shape either way, which is why this file does not do that.
// Then, after the Confirm, a SECOND qualifier leaves the DRAWN bracket: her
// line walks over to her opponent, naming her (ruling 116), the top
// qualifier's bye is untouched, and nobody slides into a new pairing.
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
 *  adding a line here shrinks the allowance per step, so each test COUNTS its
 *  own page loads (`visit`) and compares the count with its list at the end.
 *  Not `LIST.length === 5` at the top: that compares two literals and passes
 *  over any journey at all, which is what the first version of this guard
 *  did. */
const CUP_NAVIGATIONS = [
  "?tab=fixtures — the proposal, before she leaves",
  "?tab=entrants — where the organiser withdraws her",
  "?tab=fixtures — the proposal, after she leaves",
  "?tab=fixtures — after the short draw is confirmed",
  "?tab=standings — her row, marked",
  "?tab=entrants — where a second qualifier withdraws, after the Confirm",
  "?tab=fixtures — her line walked over, the bye untouched",
] as const;
const LADDER_NAVIGATIONS = [
  "?tab=fixtures — both pickers offer her",
  "?tab=entrants — where the organiser withdraws her",
  "?tab=fixtures — neither picker offers her",
] as const;
/** Every navigation in this file goes through here, so the number each test
 *  checks its list against is MEASURED rather than declared. Reset at the top
 *  of each test — the two journeys have separate lists and separate budgets. */
let visits = 0;
const visit = async (p: Page, url: string): Promise<void> => {
  visits += 1;
  await p.goto(url);
};

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
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;
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
  // By TESTID, not by the word on the button. "Withdraw" WAS hardcoded English
  // in `entrants-panel.tsx` — this comment used to record that gap as a real
  // one — and it is `entrants.row.withdraw` in all four catalogues as of
  // 2026-09-22. Keying on the English literal would have broken this
  // walkthrough the moment the gap was closed, so the two moved together. The
  // label itself is pinned by `entrants-panel-row-i18n.test.tsx`; the confirm
  // button below stays on its dict value because it is READ from the dict.
  await row.getByTestId("entrant-row-withdraw").click();
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
  // A VALUE, not copy — same claim as before, now in the one place that still
  // carries it. The badge used to PRINT `entrant.status` verbatim and this
  // read the text; since 2026-09-22 it prints the translated word
  // (`entrants.status.*`) and publishes the raw column on
  // `data-entrant-status`, so a Dutch organiser's console would have failed a
  // text probe. The assertion is unchanged in substance: the column the server
  // wrote, the same string `DEPARTED_STATUSES` holds.
  await expect(
    row.locator("[data-entrant-status]"),
    "her row does not carry the status the server wrote",
  ).toHaveAttribute("data-entrant-status", "withdrawn", { timeout: STEP_MS });
}

test.describe.configure({ mode: "serial" });

test("an organiser withdraws a qualifier from the draft and the survivors close up; a second one leaves the drawn bracket and her line walks over", async ({
  page,
  request,
}) => {
  test.setTimeout(
    Math.max(
      120_000,
      CUP_NAVIGATIONS.length * STEP_MS + (CUP_API_SCORES + WIDTH_CHECKS) * REACH_MS,
    ),
  );
  visits = 0; // settled against the COUNT at the end of this test

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
  await visit(page, fixturesUrl);
  const draftPanel = page.locator('[data-progression-state="draft"]');
  await expect(draftPanel, "the seeding proposal panel never appeared").toBeVisible({ timeout: STEP_MS });
  await expect(
    draftPanel.locator("select").filter({ hasText: quitter }).first(),
    "she is not offered even before she leaves — this test would prove nothing",
  ).toBeAttached();

  // ------------------------------------------------ the organiser's own hands
  await visit(page, await divisionPath(request, divisionId, "?tab=entrants"));
  await withdrawThroughTheScreen(page, quitter);

  // §2 — she cannot be seeded into the bracket. Read off the real <select>,
  // because a server-side filter says nothing about what a person is SHOWN.
  await visit(page, fixturesUrl);
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

  // THE CLAIM (RB4-V6). She left the DRAFT, so the table closed up over her:
  // Ada 1, Cleo 2, Dot 3, rank 4 empty. R1·1 (1v4) is the top qualifier's
  // bye — its empty seat stamped a bye at the Confirm and settled to the side
  // that holds the line…
  expect(
    seats(semis[0]!).filter((x) => x !== null),
    "R1·1 is not the top qualifier's bye: the table did not close up over her",
  ).toEqual([idOf.get(names[0]!)!]);
  expect(semis[0]!.status, "the top qualifier's bye is not settled").toBe("forfeited");
  expect(semis[0]!.outcome?.kind).toBe("award");
  expect(semis[0]!.outcome?.winner).toBe(idOf.get(names[0]!)!);
  // …and R1·2 (2v3) pairs the OLD third and fourth, an ordinary match to play —
  // a line the published positions (Ada v Dot, Cleo walked over) never had.
  expect(
    seats(semis[1]!).filter((x) => x !== null).sort(),
    "the survivors did not close up: R1·2 is not the old third against the old fourth",
  ).toEqual([idOf.get(names[2]!)!, idOf.get(names[3]!)!].sort());
  expect(semis[1]!.status, "R1·2 is not a match to play").toBe("scheduled");
  expect(semis[1]!.outcome).toBeNull();
  expect(semis.flatMap(seats), "a seat was filled with the player who left").not.toContain(quitterId);

  // And what the organiser SEES of it: the surviving name on that line, and
  // no seat anywhere still advertising a qualifier who has gone.
  await visit(page, fixturesUrl);
  // A settled bye does NOT render as an ordinary draw-list row: it takes
  // `desk/run-sheet-row.tsx`'s bye branch, which has no `data-fixture-no` at
  // all. (Looking for one is how this assertion first failed — worth
  // recording, because "the row is missing" and "the row is a bye" look
  // identical to a `data-fixture-no` probe, and only one of them is correct.)
  const byeLine = page.getByTestId("run-sheet-bye");
  await expect(byeLine, "R1·1 is not rendered as the top qualifier's settled bye").toHaveCount(1);
  await expect(byeLine, "the top qualifier is not named on her bye").toContainText(names[0]!);
  await expect(byeLine, "the departed qualifier is still printed in the draw").not.toContainText(quitter);
  // The OTHER semi is an ordinary, schedulable row — so the bye is one line,
  // not a stage-wide settle.
  const liveRow = page.locator(`[data-fixture-no="${semis[1]!.fixture_no}"]`);
  await expect(liveRow, `no draw-list row for fixture ${semis[1]!.fixture_no}`).toHaveCount(1);
  await expect(liveRow).toContainText(names[2]!);
  await expect(liveRow).toContainText(names[3]!);

  // §3 — her standings row STAYS, and carries the product's own word for it.
  await visit(page, await divisionPath(request, divisionId, "?tab=standings"));
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

  // §4, the DRAWN bracket — a second qualifier leaves after the Confirm. The
  // draw is published now, so her line is not re-seeded: it walks over to her
  // opponent and names her as the side that withdrew (ruling 116; the
  // cascade's `core.forfeit {reason: "withdrew"}`). Nobody is left below the
  // league's cut to take her seat, so no replacement can mask the walkover.
  const second = names[3]!;
  const secondId = idOf.get(second)!;
  await visit(page, await divisionPath(request, divisionId, "?tab=entrants"));
  await withdrawThroughTheScreen(page, second);
  const roundOne = async () =>
    (await fixturesOf(request, divisionId))
      .filter((f) => f.stage_id === finalsId && f.round_no === 1)
      .sort((a, b) => a.seq_in_round - b.seq_in_round);
  await expect
    .poll(async () => (await roundOne())[1]?.outcome ?? null, { timeout: STEP_MS, message: "her line did not walk over" })
    .toEqual({ kind: "award", winner: idOf.get(names[2]!)!, loser: secondId, reason: "withdrew" });
  const walked = await roundOne();
  expect(walked.map((f) => f.id), "the first round is the same two lines").toEqual(semis.map((f) => f.id));
  expect(walked[1]!.status, "her line is still a match to play").toBe("forfeited");
  // Nobody slid into a new pairing: both names stay in the seats they were
  // drawn into, hers included (ruling 116 names her where she stood)…
  expect(seats(walked[1]!).filter((x) => x !== null).sort(), "R1·2 was re-seeded").toEqual(
    [idOf.get(names[2]!)!, secondId].sort(),
  );
  // …and the top qualifier's bye is exactly as the Confirm left it.
  expect(
    { seats: seats(walked[0]!), status: walked[0]!.status, outcome: walked[0]!.outcome },
    "the other line moved",
  ).toEqual({ seats: seats(semis[0]!), status: semis[0]!.status, outcome: semis[0]!.outcome });
  // The drawn bracket carries both winners on: the final is Ada v Cleo.
  await expect
    .poll(
      async () => {
        const f = (await fixturesOf(request, divisionId)).find((x) => x.stage_id === finalsId && x.round_no === 2);
        return f === undefined ? null : seats(f).filter((x) => x !== null).sort();
      },
      { timeout: STEP_MS, message: "the final does not hold the two first-round winners" },
    )
    .toEqual([idOf.get(names[0]!)!, idOf.get(names[2]!)!].sort());

  // What the organiser SEES of it: the walkover is an ordinary row (a
  // withdrawal's walkover is not a bye), naming both sides; the bye is still
  // the sheet's only bye row.
  await visit(page, fixturesUrl);
  const walkedRow = page.locator(`[data-fixture-no="${semis[1]!.fixture_no}"]`);
  await expect(walkedRow, `no draw-list row for fixture ${semis[1]!.fixture_no}`).toHaveCount(1, { timeout: STEP_MS });
  await expect(walkedRow, "the walkover does not name who it went to").toContainText(names[2]!);
  await expect(walkedRow, "the walkover does not name who withdrew (ruling 116)").toContainText(second);
  await expect(byeLine, "the bye stopped being the sheet's one bye row").toHaveCount(1);
  await expect(byeLine, "the bye no longer names the top qualifier").toContainText(names[0]!);
  await expect(byeLine, "the walkover was drawn as a bye").not.toContainText(second);

  // The budget's premise, against what this test ACTUALLY did.
  expect(visits, "the cup navigation list no longer describes this journey").toBe(
    CUP_NAVIGATIONS.length,
  );
});

test("the same organiser withdraws a rung from the club ladder, and the challenge picker stops offering her", async ({
  page,
  request,
}) => {
  test.setTimeout(
    Math.max(120_000, LADDER_NAVIGATIONS.length * STEP_MS + WIDTH_CHECKS * REACH_MS),
  );
  visits = 0; // settled against the COUNT at the end of this test

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
  await visit(page, fixturesUrl);
  // BEFORE: both pickers offer her.
  await expect(
    page.locator("select").filter({ hasText: quitter }),
    "she was never offered — the refusal below would prove nothing",
  ).toHaveCount(2);

  await visit(page, await divisionPath(request, divisionId, "?tab=entrants"));
  await withdrawThroughTheScreen(page, quitter);

  // §1 — gone from both pickers…
  await visit(page, fixturesUrl);
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

  // The budget's premise, against what this test ACTUALLY did.
  expect(visits, "the ladder navigation list no longer describes this journey").toBe(
    LADDER_NAVIGATIONS.length,
  );
});
