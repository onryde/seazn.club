// ONE organiser builds two divisions whose last stage is a bracket fed by a league — Group + Stepladder (generic scoring, a top five)
// and Group + Playoffs (badminton, a top four) — through the real division builder, plays each out, and withdraws one finalist
// part-way through the finals, driven on the organiser's own screens.
//
// THE RULES (W4 T25 / T8-f; rulebook RB4-S1, RB4-S2, RB4-S3, RB4-S7; X-SP-3, X-SP-5):
//   - Stepladder (top k from a table): the lowest two seeds play the first rung, each winner meets the next seed up, and the last
//     rung is against seed 1. k = 5 here: rung 1 = seeds 4 v 5, then 3, 2 and 1 each wait on the climber.
//   - Page playoff (exactly 4): Q1 = 1 v 2, E = 3 v 4, Q2 = Q1's loser v E's winner, Final = Q1's winner v Q2's winner.
//   - A withdrawal inside the finals WALKS the line over (never voids it) and the stage plays on.
//   - Both are offered as FINAL stages only (RB4-S6/S7): the builder's cards are Group + Stepladder and Group + Playoffs, and the
//     server refuses either standalone by name (T16, smoke).
//
// WHY A WALKTHROUGH. final-stage-withdrawal.test.ts proves the seating with the usecases and the smoke suite proves the whole format
// over HTTP. What neither can see is the organiser's own journey: that the builder's card produces THE stages the catalogue claims
// (with the Top N the organiser typed, and no Top N box at all for the fixed four), that the proposal's Confirm button on the
// finals card seats the right pairs, that the Withdraw button on the Entrants tab — the one step of this story a person does with
// their hands — leaves the finals playing on, and that the run sheet SAYS the line was walked over, with the winner named.
//
// WHAT IS A REACH AND WHAT IS THE TEST (this folder's README): the competition, the entrants, Generate and Start, the scoring of every
// match and the league's Complete are REACHES over the API. The builder (every field, both cards, Create), the proposal's Confirm and
// the withdrawal are DONE through the screen; the stored stages, seats and outcomes are read back from the API and the dictionaries
// supply every sentence.
//
// RANKS. Seats and who-walked-over-whom are asserted after the withdrawal. Rank ORDER is never asserted (controller ruling: rank proofs
// beyond seating are app-B's, carry C19): the stepladder test asserts RB4-S4's coverage (every qualifier ranked once, the withdrawn seed
// among them), and the page-playoff test, per RB4-S5 ("tests assert who plays whom, not that the stage completed"), presses Complete and
// RECORDS its answer as a test annotation without asserting it. The observed ranks go to the annotations for the report.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { buildTemplateStages } from "../../src/lib/format-templates";
import { TAG, addEntrantsViaApi, apiJson, competitionPath, divisionPath, expandStageCard, expectNoHorizontalScroll, openStagePanel, pickBuilderSport, scoreFixture, showAllFormats, stageCardOf } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { LATE_SPORTS, showAllFixtures, type Seated } from "../support/swiss-app-a-kit";

const UI = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
/** A dictionary sentence with its `{vars}` filled; a missing key fails the test rather than rendering "undefined". */
const say = (key: string, vars: Record<string, string | number> = {}): string => {
  const template = UI[key];
  expect(template, `dictionary has no "${key}"`).toBeDefined();
  return template!.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
};

/** The budget, derived from what each test does (AGENTS.md 20): a page load, a tap or read, and one API reach each get their own
 *  allowance, so adding a step moves the ceiling. Generous for `next dev`'s cold compiles; CI's prod build never reaches it. */
const NAV_MS = 40_000;
const ACT_MS = 4_000;
const REACH_MS = 1_500;
const budget = (navs: number, acts: number, reaches: number) => Math.max(120_000, navs * NAV_MS + acts * ACT_MS + reaches * REACH_MS);
const STEP_MS = 30_000;
const WIDTHS = [1280, 768, 320] as const;

/** The kit's seated fixture (what the sport scorers take) plus the two columns this story reads. */
type Row = Seated & {
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string; reason?: string } | null;
};
type StageRow = { id: string; kind: string; name: string; seq: number; status: string; config: Record<string, unknown>; progression: unknown };

/** Every navigation goes through here, so the count each test checks its budget list against is MEASURED. */
let visits = 0;
const visit = async (page: Page, url: string): Promise<void> => {
  visits += 1;
  await page.goto(url);
};

async function stageRows(request: APIRequestContext, divisionId: string, stageId: string): Promise<Row[]> {
  const res = await apiJson<Row[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, `GET fixtures → ${JSON.stringify(res.error)}`).toBe(200);
  return (res.data ?? []).filter((f) => f.stage_id === stageId).sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
}
const pair = (f: Row | undefined) => [f?.home_entrant_id ?? "-", f?.away_entrant_id ?? "-"].sort().join("|");
const pairOf = (a: string | null | undefined, b: string | null | undefined) => [a ?? "-", b ?? "-"].sort().join("|");

/** The builder, end to end: Add division → Who plays → Format (the card, its Top N) → Division rules (the variant) → Review → Create.
 *  Returns the new division's id. Every control is the organiser's own; nothing is posted from here. */
async function buildThroughTheBuilder(
  page: Page,
  request: APIRequestContext,
  competitionId: string,
  o: { name: string; sport: "generic" | "badminton"; template: "group_stepladder" | "group_playoffs"; qualify: number | null; variant: string | null },
): Promise<string> {
  await visit(page, await competitionPath(request, competitionId));
  await dismissCookieBanner(page);
  await page.getByRole("link", { name: `+ ${say("action.addDivision")}`, exact: true }).click();
  await page.waitForURL(/\/d\/new$/, { timeout: STEP_MS });
  const builder = page.getByTestId("division-builder");
  await expect(page.getByTestId("division-builder-name")).toBeVisible({ timeout: STEP_MS });

  // 1 Who plays: a name and a sport (picked on purpose, never the builder's opening one).
  await page.getByTestId("division-builder-name").fill(o.name);
  await pickBuilderSport(page, o.sport);
  await page.getByTestId("division-builder-next").click();
  await expect(builder).toHaveAttribute("data-step", "format");

  // 2 Format: the card by its template key, its label from the dictionary; Top N only where the format asks for one.
  await showAllFormats(page);
  const card = page.locator(`label[data-template="${o.template}"]`);
  await expect(card, `one ${o.template} card`).toHaveCount(1);
  await expect(card).toContainText(say(`format.template.${o.template}.label`));
  await card.click();
  await expect(card.locator("input")).toBeChecked();
  const top = page.getByLabel(say("wizard.qualify"), { exact: true });
  if (o.qualify === null) {
    await expect(top, "a fixed four: the builder asks for no Top N").toHaveCount(0);
  } else {
    await expect(top, "a stepladder takes the organiser's Top N").toHaveCount(1);
    await top.fill(String(o.qualify));
    await expect(top).toHaveValue(String(o.qualify));
  }

  // 3 Division rules: the variant, only where the sport's default is not the one the scoring below needs.
  await page.getByTestId("division-builder-next").click();
  await expect(builder).toHaveAttribute("data-step", "rules");
  if (o.variant !== null) {
    const variant = page.getByTestId("division-builder-rules").getByTestId("division-settings-variant");
    await expect(variant, "the rules step offers the variant select").toHaveCount(1);
    await variant.selectOption(o.variant);
    await expect(variant).toHaveValue(o.variant);
  }

  // 4 Review: the receipt names the format (and the Top N where one was typed), then Create.
  await page.getByTestId("division-builder-next").click();
  await expect(builder).toHaveAttribute("data-step", "review");
  const format = page.locator('[data-review-row="format"]');
  await expect(format).toContainText(say(`format.template.${o.template}.label`));
  if (o.qualify === null) await expect(format, "a fixed four: the receipt prints no Top N").not.toContainText(say("divBuilder.review.top", { count: 4 }));
  else await expect(format).toContainText(say("divBuilder.review.top", { count: o.qualify }));
  await expectNoHorizontalScroll(page);
  await page.getByTestId("division-builder-create").click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: STEP_MS });
  const slug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const list = await apiJson<{ id: string; slug: string }[]>(request, `/api/v1/competitions/${competitionId}/divisions`);
  const made = (list.data ?? []).find((d) => d.slug === slug);
  expect(made, `the division ${slug} is in the competition's list`).toBeDefined();
  return made!.id;
}

/** The stored stages are the format catalogue's own drafts for this template at the typed knobs (the builder's door). */
async function expectStoredStages(request: APIRequestContext, divisionId: string, template: string, qualified: number): Promise<StageRow[]> {
  const res = await apiJson<StageRow[]>(request, `/api/v1/divisions/${divisionId}/stages`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  const stored = (res.data ?? []).sort((a, b) => a.seq - b.seq);
  const wanted = buildTemplateStages(template, { qualified, swissRounds: 5, poolCount: 2, legs: 1 });
  expect(stored.map((s) => s.kind), "the stored stage kinds are the template's").toEqual(wanted.map((s) => s.kind));
  expect(stored.map((s) => s.name), "and their names").toEqual(wanted.map((s) => s.name));
  expect(stored.map((s) => s.progression), "and their progression, the Top N the organiser typed").toEqual(wanted.map((s) => s.progression));
  expect(stored[0]!.config.legs, "the league is played once").toBe(1);
  return stored;
}

/** The organiser's own hands: the entrants row's Withdraw, then the confirmation dialog that spells out the consequence. */
async function withdrawThroughTheScreen(page: Page, name: string): Promise<void> {
  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row, `one entrants row for ${name}`).toHaveCount(1, { timeout: STEP_MS });
  await row.getByTestId("entrant-row-withdraw").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: STEP_MS });
  await expect(dialog, "the confirmation names who is leaving").toContainText(name);
  const go = dialog.getByRole("button", { name: say("confirm.withdrawEntrant.label"), exact: true });
  await expect(go).toBeEnabled({ timeout: STEP_MS });
  await go.click();
  await expect(dialog).toBeHidden({ timeout: STEP_MS });
  await expect(row, "the row stays: withdrawn, not deleted").toHaveCount(1);
  await expect(row.locator("[data-entrant-status]")).toHaveAttribute("data-entrant-status", "withdrawn", { timeout: STEP_MS });
}

/** The proposal on the finals card, confirmed with the button — no tie to resolve, asserted rather than assumed. */
async function confirmThroughTheScreen(page: Page): Promise<void> {
  const draft = page.locator('[data-progression-state="draft"]');
  await expect(draft, "the finals card offers the seeding proposal").toBeVisible({ timeout: STEP_MS });
  const confirm = draft.getByRole("button", { name: say("progression.confirmCta"), exact: true });
  await expect(confirm, "the league has no tie, so Confirm is enabled at once").toBeEnabled();
  await confirm.click();
  await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: STEP_MS });
}

/** A finished line on the run sheet reads "<winner> won (w/o)" for a walkover. */
const walkoverSentence = (winner: string) => say("schedule.outcome.wonTagged", { name: winner, tag: say("forfeit.tag.walkover") });

/** The sport's scorer: `winner` takes the line. */
async function playLine(request: APIRequestContext, sport: "generic" | "badminton", f: Row, winner: string): Promise<void> {
  if (sport === "generic") {
    await scoreFixture(request, f.id, f.home_entrant_id === winner ? 2 : 0, f.home_entrant_id === winner ? 0 : 2);
    return;
  }
  await LATE_SPORTS.find((s) => s.key === "badminton")!.win(request, f, winner);
}

async function completeStage(request: APIRequestContext, stageId: string) {
  const res = await apiJson<{ completed: boolean; division_completed?: boolean; events?: { type: string; finalRanks?: string[] }[] }>(request, `/api/v1/stages/${stageId}/complete`, "POST");
  expect(res.status, `complete → ${JSON.stringify(res.error)}`).toBeLessThan(300);
  return { ...res.data!, ranks: res.data!.events?.find((e) => e.type === "stage_completed")?.finalRanks ?? [] };
}

/** The finished division, at the three widths. A completed stage's run-sheet card folds shut, so what the organiser SEES of the finals is
 *  the bracket: the stepladder's rung list sits on the page, a page playoff's tree opens INSIDE its stage card from the Bracket button
 *  (Match Day E1 item 3; on a phone that button lives in the card's sheet, which `openStagePanel` handles). Its tile for the walked-over
 *  line must be on screen and name both sides, and the page must not scroll sideways. The tile's HEADLINE is not asserted: it is the
 *  engine's own score summary, which differs by sport (observed: generic prints "L — W/O", badminton "0 — 2" with no walkover word),
 *  so the walkover WORDING is asserted where it is one sentence for every sport, on the run sheet. Counts the widths it measured
 *  (zero would be a failure). */
async function widthSweep(
  page: Page,
  url: string,
  tile: { stageId: string; panel: "bracket-panel-ladder" | "bracket-panel-page"; inCard: boolean; fixtureNo: number; winner: string; loser: string },
): Promise<number> {
  let measured = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 720 : 900 });
    await visit(page, url);
    let scope: Page | Locator = page;
    if (tile.inCard) {
      const card = stageCardOf(page, tile.stageId);
      await expect(card, `the finals card is on the page at ${width}`).toBeVisible({ timeout: STEP_MS });
      await expandStageCard(card);
      await openStagePanel(card, "bracket");
      scope = card.getByTestId("stage-bracket");
    }
    const panel = scope.getByTestId(tile.panel);
    await expect(panel, `the ${tile.panel} is drawn at ${width}`).toBeVisible({ timeout: STEP_MS });
    const walked = panel.locator(`a[href$="/f/${tile.fixtureNo}"]`);
    await expect(walked, `one tile for the walked-over line at ${width}`).toHaveCount(1);
    await expect(walked).toBeVisible();
    await expect(walked, "the tile names who walked on").toContainText(tile.winner);
    await expect(walked, "and who withdrew").toContainText(tile.loser);
    await expectNoHorizontalScroll(page);
    measured++;
  }
  return measured;
}

/** Nothing in the finals was voided or abandoned: a withdrawal walks lines over (RB4-S3). */
const voidedIn = (rows: Row[]) => rows.filter((f) => f.status === "abandoned" || f.status === "void").length;

test.describe.configure({ mode: "serial" });

test.describe("W4 final stages: an organiser builds a league into stepladder finals and into a page playoff, plays them out, and a finalist withdraws", () => {
  test("Group + Stepladder (generic, top 5): the rungs seat the lowest two seeds first, a withdrawn seed's rung is walked over, and the ladder plays on to a winner", async ({ page, request }, testInfo) => {
    const NAVIGATIONS = [
      "competition page — Add division",
      "?tab=fixtures — the league completed, the proposal on the finals card",
      "?tab=entrants — where the organiser withdraws seed 3",
      "?tab=fixtures — the walkover on the run sheet",
      ...WIDTHS.map((w) => `?tab=fixtures at ${w}`),
    ] as const;
    const ACTS = 40;
    const REACHES = 14 + 15 + 4 + 4;
    test.setTimeout(budget(NAVIGATIONS.length, ACTS, REACHES));
    visits = 0;
    await page.setViewportSize({ width: 1280, height: 900 });

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 stepladder ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const K = 5;

    // ── 1. The builder ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    const divisionId = await buildThroughTheBuilder(page, request, comp.data!.id, {
      name: `Stepladder ${TAG}`,
      sport: "generic",
      template: "group_stepladder",
      qualify: K,
      variant: "score",
    });
    const division = await apiJson<{ sport_key: string; variant_key: string }>(request, `/api/v1/divisions/${divisionId}`);
    expect([division.data?.sport_key, division.data?.variant_key], "the sport and variant the organiser picked").toEqual(["generic", "score"]);
    const [league, ladder] = await expectStoredStages(request, divisionId, "group_stepladder", K);

    // ── REACH: six entrants, both stages drawn, Start, the league played (the better seed wins every line) and completed ──────────
    const names = Array.from({ length: 6 }, (_, i) => `SL S${i + 1} ${TAG}`);
    const added = await addEntrantsViaApi(request, divisionId, names);
    expect(added.status).toBe(201);
    const ids = added.ids;
    expect(ids, "six entrants, seeded 1..6").toHaveLength(6);
    const nameOf = new Map(ids.map((id, i) => [id, names[i]!]));
    const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
    for (const s of [league!, ladder!]) expect((await apiJson(request, `/api/v1/stages/${s.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    const leagueLines = await stageRows(request, divisionId, league!.id);
    expect(leagueLines, "a single round robin of six is fifteen lines").toHaveLength(15);
    for (const f of leagueLines) await playLine(request, "generic", f, seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)! ? f.home_entrant_id! : f.away_entrant_id!);
    const doneLeague = await completeStage(request, league!.id);
    expect(doneLeague.completed).toBe(true);
    expect(doneLeague.ranks, "the league's table is the seed order: nobody is tied").toEqual(ids);

    // ── 2. The proposal on the finals card, confirmed with the button ───────────────────────────────────────────────────────────
    await visit(page, await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    await confirmThroughTheScreen(page);
    const rungs = await stageRows(request, divisionId, ladder!.id);
    expect(rungs.map((f) => f.round_no), `k = ${K} is ${K - 1} rungs, one a round`).toEqual([1, 2, 3, 4]);
    // RB4-S1 on the record: the two lowest seeds first, then 3, 2 and 1, each waiting for the climber.
    expect(pair(rungs[0])).toBe(pairOf(ids[3], ids[4]));
    expect([pair(rungs[1]), pair(rungs[2]), pair(rungs[3])]).toEqual([pairOf(ids[2], null), pairOf(ids[1], null), pairOf(ids[0], null)]);
    expect(rungs.some((f) => f.home_entrant_id === ids[5] || f.away_entrant_id === ids[5]), "the sixth finisher is in no rung").toBe(false);
    // ...and on the screen: the first rung names its two seeds, each waiting rung names its fixed seed.
    await showAllFixtures(page);
    await expect(page.locator(`li[data-fixture-no="${rungs[0]!.fixture_no}"]`)).toContainText(nameOf.get(ids[3]!)!);
    await expect(page.locator(`li[data-fixture-no="${rungs[0]!.fixture_no}"]`)).toContainText(nameOf.get(ids[4]!)!);
    for (const [rung, seed] of [[rungs[1]!, ids[2]!], [rungs[2]!, ids[1]!], [rungs[3]!, ids[0]!]] as const) {
      await expect(page.locator(`li[data-fixture-no="${rung.fixture_no}"]`), `rung ${rung.round_no} names its fixed seed`).toContainText(nameOf.get(seed)!);
    }

    // ── REACH: rung 1 is played and seed 5 (the lower) climbs. ──────────────────────────────────────────────────────────────────
    await playLine(request, "generic", rungs[0]!, ids[4]!);
    const afterRungOne = await stageRows(request, divisionId, ladder!.id);
    expect(pair(afterRungOne[1]), "rung 2 is seed 3 v the climber (seed 5, never seed 4)").toBe(pairOf(ids[2], ids[4]));

    // ── 3. Seed 3 withdraws, through the screen, with rung 2 seated and not yet played ────────────────────────────────────────────
    await visit(page, await divisionPath(request, divisionId, "?tab=entrants"));
    await withdrawThroughTheScreen(page, names[2]!);

    // The record (X-SP-3): rung 2 walked over to the climber, rung 3 is the climber v seed 2, nothing voided, seed 3 on rung 2 only.
    const afterWithdraw = await stageRows(request, divisionId, ladder!.id);
    expect(afterWithdraw[1]).toMatchObject({ status: "forfeited" });
    expect(afterWithdraw[1]!.outcome, "rung 2 is a walkover to the climber, the withdrawal named").toMatchObject({ kind: "award", winner: ids[4], loser: ids[2], reason: "withdrew" });
    expect(pair(afterWithdraw[2]), "rung 3 is the climber v seed 2").toBe(pairOf(ids[1], ids[4]));
    expect(afterWithdraw[2]!.status).toBe("scheduled");
    expect(pair(afterWithdraw[3]), "the last rung still waits for seed 1's opponent").toBe(pairOf(ids[0], null));
    expect(voidedIn(afterWithdraw), "a withdrawal walks over and never voids").toBe(0);
    expect(afterWithdraw.filter((f) => f.home_entrant_id === ids[2] || f.away_entrant_id === ids[2]).map((f) => f.round_no), "seed 3 is on rung 2 only").toEqual([2]);

    // On the screen: the run sheet says rung 2 was a walkover, to the climber.
    await visit(page, await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    await expect(page.locator(`li[data-fixture-no="${afterWithdraw[1]!.fixture_no}"]`), "the run sheet shows the line, naming the walkover and its winner").toBeVisible({ timeout: STEP_MS });
    await expect(page.locator(`li[data-fixture-no="${afterWithdraw[1]!.fixture_no}"]`), "the run sheet names the walkover and its winner").toContainText(walkoverSentence(nameOf.get(ids[4]!)!), { timeout: STEP_MS });

    // ── REACH: the ladder plays on: seed 2 stops the climber, seed 1 wins it. ───────────────────────────────────────────────────
    await playLine(request, "generic", afterWithdraw[2]!, ids[1]!);
    const lastRung = (await stageRows(request, divisionId, ladder!.id))[3]!;
    expect(pair(lastRung), "the last rung: seed 1 v seed 2").toBe(pairOf(ids[0], ids[1]));
    await playLine(request, "generic", lastRung, ids[0]!);
    const doneLadder = await completeStage(request, ladder!.id);
    expect(doneLadder.completed, "the ladder completes with a finalist withdrawn").toBe(true);
    expect(doneLadder.division_completed, "and the division with it").toBe(true);
    // RB4-S4: "every seed appears in the final ranks", the withdrawn one included. Coverage only: the ORDER is app-B's (carry C19).
    expect([...doneLadder.ranks].sort(), "the five qualifiers are ranked once each, the withdrawn seed 3 among them, the sixth finisher in none").toEqual([...ids.slice(0, K)].sort());
    expect(voidedIn(await stageRows(request, divisionId, ladder!.id)), "nothing was voided on the way").toBe(0);
    // OBSERVED, not asserted (RB4-S4, app-B carry C19): where the withdrawn seed ranks.
    testInfo.annotations.push({ type: "observed finalRanks (seeds)", description: doneLadder.ranks.map((id) => seedOf.get(id)).join(", ") });

    // ── 4. The finished ladder, at three widths ─────────────────────────────────────────────────────────────────────────────────
    expect(await widthSweep(page, await divisionPath(request, divisionId, "?tab=fixtures"), { stageId: ladder!.id, panel: "bracket-panel-ladder", inCard: false, fixtureNo: afterWithdraw[1]!.fixture_no, winner: nameOf.get(ids[4]!)!, loser: nameOf.get(ids[2]!)! })).toBe(WIDTHS.length);
    expect(visits, "the NAVIGATIONS list is the navigations this test made").toBe(NAVIGATIONS.length);
  });

  test("Group + Playoffs (badminton): Q1 = 1 v 2 and E = 3 v 4, the loser of Q1 is walked out of Q2 by a withdrawal, and the Final is seated from the two winners", async ({ page, request }, testInfo) => {
    const NAVIGATIONS = [
      "competition page — Add division",
      "?tab=fixtures — the league completed, the proposal on the finals card",
      "?tab=entrants — where the organiser withdraws seed 1",
      "?tab=fixtures — the walkover on the run sheet",
      ...WIDTHS.map((w) => `?tab=fixtures at ${w}`),
    ] as const;
    const ACTS = 40;
    const REACHES = 16 + 10 * 6 + 6 + 8;
    test.setTimeout(budget(NAVIGATIONS.length, ACTS, REACHES));
    visits = 0;
    await page.setViewportSize({ width: 1280, height: 900 });

    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4 page playoff ${TAG}`, visibility: "private" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);

    // ── 1. The builder: badminton on BWF 3x21, a fixed four (no Top N box) ───────────────────────────────────────
    const divisionId = await buildThroughTheBuilder(page, request, comp.data!.id, {
      name: `Playoffs ${TAG}`,
      sport: "badminton",
      template: "group_playoffs",
      qualify: null,
      // The builder opens badminton on its 15-point preset; the kit's scorer plays 21-10 games, a final score only BWF 3x21 reaches.
      variant: "bwf",
    });
    const division = await apiJson<{ sport_key: string; variant_key: string }>(request, `/api/v1/divisions/${divisionId}`);
    expect([division.data?.sport_key, division.data?.variant_key], "the sport and variant the organiser picked").toEqual(["badminton", "bwf"]);
    const [league, playoffs] = await expectStoredStages(request, divisionId, "group_playoffs", 4);

    // ── REACH: five entrants (a fifth finisher the playoff does not take), drawn, Start, the league played and completed ────────────
    const names = Array.from({ length: 5 }, (_, i) => `PP S${i + 1} ${TAG}`);
    const added = await addEntrantsViaApi(request, divisionId, names);
    expect(added.status).toBe(201);
    const ids = added.ids;
    expect(ids, "five entrants, seeded 1..5").toHaveLength(5);
    const nameOf = new Map(ids.map((id, i) => [id, names[i]!]));
    const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
    for (const s of [league!, playoffs!]) expect((await apiJson(request, `/api/v1/stages/${s.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    const leagueLines = await stageRows(request, divisionId, league!.id);
    expect(leagueLines, "a single round robin of five is ten lines").toHaveLength(10);
    for (const f of leagueLines) await playLine(request, "badminton", f, seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)! ? f.home_entrant_id! : f.away_entrant_id!);
    const doneLeague = await completeStage(request, league!.id);
    expect(doneLeague.completed).toBe(true);
    expect(doneLeague.ranks, "the league's table is the seed order: nobody is tied").toEqual(ids);

    // ── 2. The proposal, confirmed with the button; Q1 and E seated, Q2 and the Final empty ────────────────────────────────────────
    await visit(page, await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    await confirmThroughTheScreen(page);
    const seated = await stageRows(request, divisionId, playoffs!.id);
    expect(seated, "Q1, E, Q2 and the Final").toHaveLength(4);
    const q1 = seated.find((f) => f.home_entrant_id === ids[0] || f.away_entrant_id === ids[0])!;
    const e = seated.find((f) => f.home_entrant_id === ids[2] || f.away_entrant_id === ids[2])!;
    expect(q1.id, "seeds 1 and 3 are on different lines").not.toBe(e.id);
    expect([q1.round_no, e.round_no], "Q1 and E are round one").toEqual([1, 1]);
    expect(pair(q1), "Q1 = 1 v 2").toBe(pairOf(ids[0], ids[1]));
    expect(pair(e), "E = 3 v 4").toBe(pairOf(ids[2], ids[3]));
    expect(seated.filter((f) => f.round_no > 1).map(pair), "Q2 and the Final wait for their feeders").toEqual([pairOf(null, null), pairOf(null, null)]);
    expect(seated.some((f) => f.home_entrant_id === ids[4] || f.away_entrant_id === ids[4]), "the fifth finisher is in no line").toBe(false);
    await showAllFixtures(page);
    for (const [line, a, b] of [[q1, ids[0]!, ids[1]!], [e, ids[2]!, ids[3]!]] as const) {
      const li = page.locator(`li[data-fixture-no="${line.fixture_no}"]`);
      await expect(li).toContainText(nameOf.get(a)!);
      await expect(li).toContainText(nameOf.get(b)!);
    }

    // ── REACH: Q1 (seed 2 wins) and E (seed 4 wins) are played: both are upsets, so Q2 is seed 1 v seed 4, never 2 v 3 ─────────────────
    await playLine(request, "badminton", q1, ids[1]!);
    await playLine(request, "badminton", e, ids[3]!);
    const afterOne = await stageRows(request, divisionId, playoffs!.id);
    const q2 = afterOne.find((f) => f.round_no === 2)!;
    const final = afterOne.find((f) => f.round_no === 3)!;
    expect(pair(q2), "Q2 = Q1's loser (seed 1) v E's winner (seed 4)").toBe(pairOf(ids[0], ids[3]));
    expect(pair(final), "the Final holds Q1's winner (seed 2) and waits").toBe(pairOf(ids[1], null));

    // ── 3. Seed 1, now due in Q2, withdraws — through the screen ────────────────────────────────────────────────────────────────
    await visit(page, await divisionPath(request, divisionId, "?tab=entrants"));
    await withdrawThroughTheScreen(page, names[0]!);

    // The record (X-SP-5): Q2 walked over to E's winner, the Final is Q1's winner v E's winner, nothing voided.
    const afterWithdraw = await stageRows(request, divisionId, playoffs!.id);
    const q2After = afterWithdraw.find((f) => f.id === q2.id)!;
    const finalAfter = afterWithdraw.find((f) => f.id === final.id)!;
    expect(q2After.status).toBe("forfeited");
    expect(q2After.outcome, "Q2 is a walkover to E's winner, the withdrawal named").toMatchObject({ kind: "award", winner: ids[3], loser: ids[0], reason: "withdrew" });
    expect(pair(finalAfter), "the Final: Q1's winner v E's winner").toBe(pairOf(ids[1], ids[3]));
    expect(finalAfter.status).toBe("scheduled");
    expect(voidedIn(afterWithdraw), "a withdrawal walks over and never voids").toBe(0);
    expect(afterWithdraw.filter((f) => f.home_entrant_id === ids[0] || f.away_entrant_id === ids[0]).map((f) => f.round_no).sort(), "seed 1 is on Q1 and Q2, never the Final").toEqual([1, 2]);

    // On the screen: the run sheet says Q2 was a walkover, to seed 4; the Final names its two finalists.
    await visit(page, await divisionPath(request, divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    await expect(page.locator(`li[data-fixture-no="${q2After.fixture_no}"]`), "the run sheet shows the line, naming the walkover and its winner").toBeVisible({ timeout: STEP_MS });
    await expect(page.locator(`li[data-fixture-no="${q2After.fixture_no}"]`), "the run sheet names the walkover and its winner").toContainText(walkoverSentence(nameOf.get(ids[3]!)!), { timeout: STEP_MS });
    const finalLine = page.locator(`li[data-fixture-no="${finalAfter.fixture_no}"]`);
    await expect(finalLine).toContainText(nameOf.get(ids[1]!)!);
    await expect(finalLine).toContainText(nameOf.get(ids[3]!)!);

    // ── REACH: the Final is played (seed 4 wins it) ───────────────────────────────────────────────────────────────────────────────
    await playLine(request, "badminton", finalAfter, ids[3]!);
    const afterFinal = await stageRows(request, divisionId, playoffs!.id);
    expect(afterFinal.find((f) => f.id === finalAfter.id)!.outcome, "the Final: seed 4 beat seed 2").toMatchObject({ winner: ids[3], loser: ids[1] });
    expect(afterFinal.every((f) => f.status === "decided" || f.status === "forfeited"), "all four lines are settled, Q2 walked over").toBe(true);
    expect(voidedIn(afterFinal), "nothing was voided on the way").toBe(0);
    // RB4-S5: a page-playoff withdrawal test "asserts who plays whom, not that the stage completed" — so Complete is pressed, its answer
    // is RECORDED, and nothing about it (completion, ranks) is asserted. The rank order is app-B's (carry C19).
    const finish = await apiJson<{ completed: boolean; division_completed?: boolean; events?: { type: string; finalRanks?: string[] }[] }>(request, `/api/v1/stages/${playoffs!.id}/complete`, "POST");
    const finishRanks = finish.data?.events?.find((e) => e.type === "stage_completed")?.finalRanks ?? [];
    testInfo.annotations.push({
      type: "observed complete (finalist withdrawn)",
      description: `HTTP ${finish.status}, completed=${finish.data?.completed}, division_completed=${finish.data?.division_completed}, finalRanks (seeds) ${finishRanks.map((id) => seedOf.get(id)).join(", ")}`,
    });

    // ── 4. The finished playoff, at three widths ──────────────────────────────────────────────────────────────────────────────
    expect(await widthSweep(page, await divisionPath(request, divisionId, "?tab=fixtures"), { stageId: playoffs!.id, panel: "bracket-panel-page", inCard: true, fixtureNo: q2After.fixture_no, winner: nameOf.get(ids[3]!)!, loser: nameOf.get(ids[0]!)! })).toBe(WIDTHS.length);
    expect(visits, "the NAVIGATIONS list is the navigations this test made").toBe(NAVIGATIONS.length);
  });
});
