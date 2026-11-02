import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, divisionPath, expectNoHorizontalScroll, fixturePath, scoreFixture, stageCardOf } from "./helpers";
import { fill, uiEn } from "./match-room-kit";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

// W3 ruling 258 (owner "yes add both", 2026-11-02; ruling 259: no reason or notes field). T15 shipped the disqualification
// cascade server-side only (`PATCH /entrants/{id}` {status:"disqualified"} -> `withdrawEntrantCascade`), and nothing in the
// UI sent it: the owner picked "disqualified" in a MATCH's forfeit dialog - a per-match award - and the player was paired in
// round 2. Now the Entrants row carries Disqualify beside Withdraw, and the forfeit dialog says its own reason is this match
// only. Everything here is driven with the organiser's hands (the row's button, its confirm, the dialog's radios); the rig is
// over the API. Whole file, never a -g slice (AGENTS.md rule 21).
//
// Scope, on purpose: ONE sport (generic) and INDIVIDUAL entrants only. The Entrants panel and the PATCH it sends are
// sport-agnostic (no sport key reaches either), and the kinds (individual / pair / team) x statuses x setup / started sweep is
// the unit test `entrants-panel-disqualify.test.tsx` - this file proves the seam end to end through a real browser, once per
// cascade policy (Swiss walkover, league walkover). Ruling 261: the button exists only once the division has started.

const STEP_MS = 20_000;
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Fx {
  id: string;
  stage_id: string;
  fixture_no: number;
  round_no: number;
  seq_in_round: number;
  status: string;
  ext_key?: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind: string; winner?: string; loser?: string | null; reason?: string } | null;
}
const isByeRow = (f: Fx) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");

async function divisionFixtures(request: APIRequestContext, divisionId: string): Promise<Fx[]> {
  const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return all.data ?? [];
}

/** A generic division with `n` individual entrants seeded 1..n; returns the ids and the names the screen prints. */
async function division(request: APIRequestContext, label: string, n: number) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const names = Array.from({ length: n }, (_, i) => `${label} S${i + 1} ${TAG}`);
  const added = await addEntrantsViaApi(request, div.data!.id, names, "individual");
  expect(added.status, "entrants added").toBeLessThan(300);
  expect(added.ids).toHaveLength(n);
  const nameOf = new Map(added.ids.map((id, i) => [id, names[i]!]));
  return { divisionId: div.data!.id, ids: added.ids, names, nameOf };
}

/** A started Swiss with round 1 paired: Start mints every round's shells, one Generate seats round 1. */
async function startedSwiss(request: APIRequestContext, label: string, n: number, rounds: number) {
  const d = await division(request, label, n);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${d.divisionId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds } });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const started = await apiJson(request, `/api/v1/divisions/${d.divisionId}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBe(200);
  const paired = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(paired.status, `pair round 1: ${JSON.stringify(paired.error)}`).toBe(200);
  const round = async (r: number) => (await divisionFixtures(request, d.divisionId)).filter((f) => f.stage_id === stage.data!.id && f.round_no === r).sort((a, b) => a.seq_in_round - b.seq_in_round);
  const boards = async (r: number) => (await round(r)).filter((f) => !isByeRow(f) && f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect((await boards(1)).length, "premise: round 1 is paired").toBe(Math.floor(n / 2));
  return { ...d, stageId: stage.data!.id, round, boards };
}

/** The run sheet opens on "Today" on a match day, which hides an untimed row: read it under All. */
async function showAllFixtures(page: Page) {
  const all = page.locator('[data-testid="run-sheet-filter"] [data-filter="all"]');
  await all.click({ timeout: STEP_MS });
  await expect(all).toHaveAttribute("aria-pressed", "true");
}

/** The organiser's path: the Entrants tab, the row's Disqualify, its confirmation. Answers the PATCH the UI sent. */
async function disqualifyThroughTheScreen(page: Page, request: APIRequestContext, divisionId: string, entrantId: string, name: string) {
  await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
  await dismissCookieBanner(page);
  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row, `one entrants row for ${name}`).toHaveCount(1, { timeout: STEP_MS });
  await expect(row.locator("[data-entrant-status]"), "premise: in the field").not.toHaveAttribute("data-entrant-status", "disqualified");
  await row.getByTestId("entrant-row-disqualify").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: STEP_MS });
  await expect(dialog, "the confirm names the entrant").toContainText(fill("confirm.disqualifyEntrant.title", { name }));
  // Ruling 260: the lead, then WITHDRAW's own body (the same cascade, said once) - read from the dictionary, never retyped here.
  await expect(dialog, "and says it is the withdrawal's effect on their matches").toContainText(uiEn["confirm.disqualifyEntrant.lead"]!);
  await expect(dialog, "in Withdraw's own words").toContainText(uiEn["confirm.withdrawEntrant.body"]!);
  await expect(dialog, "and not the first draft's untrue promise").not.toContainText("Results already played stand");
  const go = dialog.getByRole("button", { name: uiEn["confirm.disqualifyEntrant.label"]!, exact: true });
  await expect(go).toBeEnabled({ timeout: STEP_MS });
  // Bounded by its own clock: a button that never sends the PATCH must fail HERE, by name, not by running out the test's budget.
  const sent = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/v1/entrants/${entrantId}` && res.request().method() === "PATCH", { timeout: STEP_MS });
  await go.click();
  const res = await sent;
  await expect(dialog).toBeHidden({ timeout: STEP_MS });
  await expect(row.locator("[data-entrant-status]"), "the status chip reads disqualified").toHaveAttribute("data-entrant-status", "disqualified", { timeout: STEP_MS });
  await expect(row.locator("[data-entrant-status]")).toHaveText(uiEn["entrants.status.disqualified"]!);
  return { row, res, body: (await res.json()) as { data?: { status?: string; cascade?: Record<string, unknown> } } };
}

/**
 * Can this row control be tapped as the page FIRST PAINTS? No scrollIntoView, no horizontal manipulation of any kind: only the
 * PAGE is scrolled, and only vertically, to bring the row on screen. The entrants card is a `.scroll-x` box, so a table that is
 * too wide for it is exactly the defect (ruling 261: a third button made the 768 table overflow its card and pushed Delete out
 * of it, under the fade). Measured: the card was never scrolled, it has nothing to scroll to (no overflow), the control lies
 * wholly inside it, and the element at the control's centre IS the control. (The card's 16px padding leaves a button in the last
 * column a few px inside the 24px right-edge fade on EVERY `.scroll-x-fade` table - that strip is decoration, `pointer-events:
 * none`, and not a reach defect, so it is reported in `fadeOverlapPx` and not asserted.)
 */
async function reachAtFirstPaint(btn: Locator) {
  return btn.evaluate((el) => {
    const card = el.closest(".scroll-x");
    if (card === null) return { error: "the control is not inside a .scroll-x card" } as const;
    const top = el.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight - 48) window.scrollBy(0, top - window.innerHeight / 3);
    const fadePx = Number.parseFloat(getComputedStyle(card, "::after").width) || 0;
    const c = card.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      cardScrollLeft: card.scrollLeft,
      cardOverflowPx: Math.max(0, card.scrollWidth - card.clientWidth - 1),
      insideCard: r.left >= c.left && r.right <= c.right,
      fadeOverlapPx: Math.max(0, Math.round(r.right - (c.right - fadePx))),
      hit: at !== null && el.contains(at),
    } as const;
  });
}

/**
 * The row's action controls on one division, at 1280, 768 and 320: the expected ones are there (and the others are not), the
 * page never scrolls sideways, and each is tappable. At 1280 and 768 that is proven at FIRST PAINT (`reachAtFirstPaint`: the card does not overflow, the control is inside it); at 320
 * the card is a scroll card by design (a phone-width table scrolls inside its box), so there the control is scrolled into view
 * and then hit-tested - that is a reachability check, not a first-paint one. Returns how many controls it proved tappable.
 */
async function rowActionsAtThreeWidths(page: Page, request: APIRequestContext, divisionId: string, name: string, present: string[], absent: string[]) {
  let tapped = 0;
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
    await dismissCookieBanner(page);
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: STEP_MS });
    await expectNoHorizontalScroll(page);
    for (const id of absent) await expect(row.getByTestId(id), `${width}: ${id} is not offered on this division`).toHaveCount(0);
    for (const id of present) {
      const btn = row.getByTestId(id);
      await expect(btn, `${width}: ${id} is on the row`).toHaveCount(1);
      if (width === 320) {
        // The positive pair of the "no overflow" reads above: at a phone width the SAME measurement sees the card overflow.
        const overflowPx = await btn.evaluate((el) => {
          const card = el.closest(".scroll-x")!;
          return card.scrollWidth - card.clientWidth;
        });
        expect(overflowPx, `${width}: the card is a scroll card here, so the overflow read can see overflow`).toBeGreaterThan(0);
        await btn.scrollIntoViewIfNeeded();
        const hit = await btn.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { onScreen: r.left >= 0 && r.right <= window.innerWidth + 1, hit: at !== null && el.contains(at) };
        });
        expect(hit, `${width}: ${id} can be tapped once its card is scrolled to it`).toEqual({ onScreen: true, hit: true });
      } else {
        const reach = await reachAtFirstPaint(btn);
        expect(reach, `${width}: ${id} can be tapped at first paint, with no scrolling`).toMatchObject({ cardScrollLeft: 0, cardOverflowPx: 0, insideCard: true, hit: true });
      }
      tapped++;
    }
    await expectNoHorizontalScroll(page);
  }
  return tapped;
}

/** The tag a DISQUALIFIED entrant's cascade walkover wears on the run sheet (T15 ruling 2): the walkover's "w/o", named in
 *  full as the disqualification, never as a withdrawal. */
const dqTag = (row: ReturnType<Page["locator"]>) => row.locator(`span[role="img"][aria-label="${uiEn["forfeit.tagFull.disqualifiedWalkover"]!}"]`);

test.describe("W3 ruling 258 - Disqualify from the Entrants tab", () => {
  test("a started Swiss: Disqualify walks the open board over (worded as the disqualification) and Pair next seats the player nowhere", async ({ page, request }) => {
    test.setTimeout(300_000);
    const sw = await startedSwiss(request, "DQ Swiss", 6, 3);
    const [board, ...others] = await sw.boards(1);
    const victim = board!.home_entrant_id!;
    const opponent = board!.away_entrant_id!;
    const victimName = sw.nameOf.get(victim)!;
    const opponentName = sw.nameOf.get(opponent)!;
    expect(others, "premise: two more round 1 boards").toHaveLength(2);
    expect(board!.status, "premise: her board is open").toBe("scheduled");
    await page.setViewportSize({ width: 1280, height: 900 });

    // (a) the screen: the button, the confirm, the status chip - and what the UI put on the wire.
    const { res, body } = await disqualifyThroughTheScreen(page, request, sw.divisionId, victim, victimName);
    expect(res.status(), "the PATCH answered").toBe(200);
    expect(res.request().postDataJSON(), "what the UI sent: the status, no reason, no notes (ruling 259)").toEqual({ status: "disqualified" });
    expect(body.data?.status).toBe("disqualified");
    expect(body.data?.cascade, "the cascade ran: one walkover over her open board").toMatchObject({ entrant_id: victim, status: "disqualified", policy: "walkover", walkovers: 1, voided: 0 });
    await expect(page.locator("tbody tr").filter({ hasText: victimName }).getByTestId("entrant-row-disqualify"), "a disqualified entrant is offered no second Disqualify").toHaveCount(0);
    await expect(page.locator("tbody tr").filter({ hasText: victimName }).getByTestId("entrant-row-reinstate"), "but the way back").toHaveCount(1);
    // The neighbour, positive pair: nobody else in the field was touched.
    await expect(page.locator("tbody tr").filter({ hasText: opponentName }).locator("[data-entrant-status]")).not.toHaveAttribute("data-entrant-status", "disqualified");

    // (b) the record and the run sheet: her open board is a walkover to the opponent, said as a disqualification.
    await expect.poll(async () => (await divisionFixtures(request, sw.divisionId)).find((f) => f.id === board!.id)?.status, { timeout: STEP_MS }).toBe("forfeited");
    const decided = (await divisionFixtures(request, sw.divisionId)).find((f) => f.id === board!.id)!;
    expect(decided.outcome).toMatchObject({ kind: "award", winner: opponent, loser: victim });
    await page.goto(await divisionPath(request, sw.divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const line = page.locator(`li[data-fixture-no="${board!.fixture_no}"]`);
    await expect(line).toBeVisible({ timeout: STEP_MS });
    await expect(line, "the run sheet names the winner, tagged as a walkover").toContainText(fill("schedule.outcome.wonTagged", { name: opponentName, tag: uiEn["forfeit.tag.walkover"]! }), { timeout: STEP_MS });
    await expect(dqTag(line).first(), "and the tag's reason in full is the disqualification").toBeAttached();
    const withdrewTag = line.locator(`span[role="img"][aria-label="${uiEn["forfeit.tagFull.withdrew"]!}"]`);
    await expect(withdrewTag, "never the withdrawal's words").toHaveCount(0);
    // Negative pair: another round 1 board of the same Swiss carries no such tag.
    await expect(dqTag(page.locator(`li[data-fixture-no="${others[0]!.fixture_no}"]`)), "an untouched board").toHaveCount(0);

    // (c) the next round: finish round 1, press Pair next on the stage card - the disqualified player is seated nowhere.
    for (const o of others) await scoreFixture(request, o.id, 2, 1);
    await page.reload({ waitUntil: "load" });
    await dismissCookieBanner(page);
    const card = stageCardOf(page, sw.stageId);
    await expect(card).toBeVisible({ timeout: STEP_MS });
    const railTrigger = card.getByTestId("stage-rail-trigger");
    if ((await railTrigger.isVisible()) && (await railTrigger.getAttribute("aria-expanded")) !== "true") await railTrigger.click();
    const pairNext = card.getByTestId("stage-generate");
    await expect(pairNext, "round 2 is next to pair").toHaveText(uiEn["schedule.pairNext"]!, { timeout: STEP_MS });
    await pairNext.click();
    await expect.poll(async () => (await sw.boards(2)).length, { timeout: 30_000, message: "round 2 was paired" }).toBe(2);
    const round2 = await sw.round(2);
    const seated = new Set(round2.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((id): id is string => id !== null));
    expect(seated.has(victim), "the disqualified player is seated in no round 2 row - board or bye").toBe(false);
    // The rulebook's count: 6 - 1 = 5 in the field, an odd Swiss field is two boards and a bye; every one of the five is seated.
    expect([...seated].sort(), "the five still in the field are all seated").toEqual(sw.ids.filter((id) => id !== victim).sort());
    expect(round2.filter(isByeRow), "an odd field of five takes one bye").toHaveLength(1);
  });

  test("a league: the same button, the same PATCH - her unplayed match walks over to its opponent, her played results stand, and the run sheet says disqualified", async ({ page, request }) => {
    test.setTimeout(240_000);
    const d = await division(request, "DQ League", 4);
    const { stageId } = await createStageAndGenerate(request, d.divisionId, { kind: "league", name: "League" });
    const started = await apiJson(request, `/api/v1/divisions/${d.divisionId}/start`, "POST");
    expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
    const victim = d.ids[1]!;
    const victimName = d.nameOf.get(victim)!;
    const all0 = (await divisionFixtures(request, d.divisionId)).filter((f) => f.stage_id === stageId);
    const mine = all0.filter((f) => f.home_entrant_id === victim || f.away_entrant_id === victim);
    const theirs = all0.filter((f) => f.home_entrant_id !== victim && f.away_entrant_id !== victim);
    // Premise from the format, not the code: a 4-team round robin gives every team three opponents, and three matches do not involve her.
    expect(mine.length, "she plays each of the other three once").toBe(3);
    expect(theirs.length, "and three matches do not involve her").toBe(3);
    // Spec 05 section 5 (the withdrawal policy a disqualification shares): a league entrant who has played MORE than is left walks
    // her remaining matches over and her results stand; with less than half played the whole record is voided instead. So play two
    // of her three first: two played, one to play.
    const [played1, played2, open] = mine as [Fx, Fx, Fx];
    for (const f of [played1, played2]) await scoreFixture(request, f.id, 2, 1);
    await expect.poll(async () => (await divisionFixtures(request, d.divisionId)).filter((f) => [played1.id, played2.id].includes(f.id)).map((f) => f.status), { timeout: STEP_MS }).toEqual(["decided", "decided"]);
    await page.setViewportSize({ width: 1280, height: 900 });

    const { res, body } = await disqualifyThroughTheScreen(page, request, d.divisionId, victim, victimName);
    expect(res.request().postDataJSON()).toEqual({ status: "disqualified" });
    expect(body.data?.cascade, "one match to play: one walkover, nothing voided").toMatchObject({ entrant_id: victim, status: "disqualified", policy: "walkover", walkovers: 1, voided: 0 });

    await expect.poll(async () => (await divisionFixtures(request, d.divisionId)).find((f) => f.id === open.id)?.status, { timeout: STEP_MS }).toBe("forfeited");
    const after = await divisionFixtures(request, d.divisionId);
    const forfeited = after.find((f) => f.id === open.id)!;
    const winner = forfeited.home_entrant_id === victim ? forfeited.away_entrant_id : forfeited.home_entrant_id;
    expect(forfeited.outcome, "a walkover to her opponent").toMatchObject({ kind: "award", winner, loser: victim });
    expect(after.filter((f) => [played1.id, played2.id].includes(f.id)).map((f) => f.status), "her played results stand").toEqual(["decided", "decided"]);
    expect(after.filter((f) => theirs.some((t) => t.id === f.id)).every((f) => f.status === "scheduled"), "the matches that do not involve her stand").toBe(true);

    await page.goto(await divisionPath(request, d.divisionId, "?tab=fixtures"));
    await showAllFixtures(page);
    const line = page.locator(`li[data-fixture-no="${open.fixture_no}"]`);
    await expect(line).toBeVisible({ timeout: STEP_MS });
    await expect(dqTag(line).first(), "the walkover is tagged as the disqualification").toBeAttached({ timeout: STEP_MS });
    await expect(line.locator(`span[role="img"][aria-label="${uiEn["forfeit.tagFull.withdrew"]!}"]`), "never the withdrawal's words").toHaveCount(0);
    await expect(dqTag(page.locator(`li[data-fixture-no="${played1.fixture_no}"]`)), "a result that stands is not a walkover").toHaveCount(0);
    await expect(dqTag(page.locator(`li[data-fixture-no="${theirs[0]!.fixture_no}"]`)), "a match that does not involve her").toHaveCount(0);
  });

  // Ruling 261: Disqualify is offered only once the division has STARTED (the flag that hides Delete). Before the start a
  // disqualification is a bare flip that Delete and Withdraw already cover, and the third button pushed Delete under the scroll
  // fade at 768. So a setup division's row is Withdraw + Delete, a started one's is Withdraw + Disqualify.
  test("a division still in setup: the row offers Withdraw and Delete and NO Disqualify; both tappable at first paint at 1280 and 768, by scrolling the card at 320", async ({ page, request }) => {
    test.setTimeout(180_000);
    const d = await division(request, "DQ Setup Konstantinopoulou", 4);
    const tapped = await rowActionsAtThreeWidths(page, request, d.divisionId, d.names[0]!, ["entrant-row-withdraw", "entrant-row-delete"], ["entrant-row-disqualify"]);
    expect(tapped, "controls proven tappable (2 per width x 3 widths)").toBe(6);
  });

  test("a started division: the row offers Withdraw and Disqualify and NO Delete; both tappable at first paint at 1280 and 768, by scrolling the card at 320", async ({ page, request }) => {
    test.setTimeout(240_000);
    const sw = await startedSwiss(request, "DQ Started Konstantinopoulou", 4, 2);
    const tapped = await rowActionsAtThreeWidths(page, request, sw.divisionId, sw.names[0]!, ["entrant-row-withdraw", "entrant-row-disqualify"], ["entrant-row-delete"]);
    expect(tapped, "controls proven tappable (2 per width x 3 widths)").toBe(6);
  });

  test("the forfeit dialog's disqualified reason says it decides this match only, at 1280 and 320; the walkover reason does not", async ({ page, request }) => {
    test.setTimeout(240_000);
    const sw = await startedSwiss(request, "DQ Hint", 4, 2);
    const board = (await sw.boards(1))[0]!;
    const started = await apiJson(request, `/api/v1/fixtures/${board.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
    let checked = 0;
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await fixturePath(request, board.id));
      await dismissCookieBanner(page);
      await page.getByTestId("score-forfeit").click({ timeout: STEP_MS });
      const d = page.getByTestId("forfeit-dialog");
      await expect(d).toBeVisible({ timeout: 10_000 });
      const hint = d.getByTestId("forfeit-dq-scope-hint");
      await expect(hint, `${width}: no side chosen, no hint`).toHaveCount(0);
      await d.getByTestId("forfeit-who-home").click();
      await expect(hint, `${width}: a side chosen, no reason yet`).toHaveCount(0);
      await d.getByTestId("forfeit-why-walkover").check();
      await expect(hint, `${width}: the walkover is not a disqualification`).toHaveCount(0);
      await d.getByTestId("forfeit-why-disqualified").check();
      await expect(hint, `${width}: the disqualification names its scope`).toHaveText(uiEn["forfeitDialog.dqScopeHint"]!);
      await expect(hint, `${width}: and it is on screen`).toBeInViewport();
      await expectNoHorizontalScroll(page);
      await d.getByTestId("forfeit-why-walkover").check();
      await expect(hint, `${width}: moving the choice off the disqualification takes it away`).toHaveCount(0);
      // Leave without recording: the match stays open (Cancel closes the dialog).
      await page.keyboard.press("Escape");
      await expect(d).toBeHidden();
      checked++;
    }
    expect(checked).toBe(2);
    const after = (await divisionFixtures(request, sw.divisionId)).find((f) => f.id === board.id)!;
    expect(after.status, "nothing was recorded: the dialog only explained").toBe("in_play");
  });
});
