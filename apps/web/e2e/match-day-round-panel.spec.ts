/**
 * Match Day online, Task 7 - the round panel, TAPPED against the real server (owner rule 2026-11-01: every event under test is
 * tapped; the API only reaches a state). One organiser on an organisation of their own (the freeze is organisation-wide, so the shared
 * e2e organisation must never see it), at 1280 unless a test says otherwise:
 *
 *   1. A round PAIRED and not opened, loaded straight from `?round=<stage>:<n>`: the panel names its state, lists the pairings and
 *      offers ONE primary "Open round"; the confirmation is the run sheet's; the open's POST goes to this round's stage, and the panel
 *      moves to check-in WITHOUT a reload (the shell's own quiet read, not the Next router's).
 *   2. Checking in: "Not here yet" for both boards, Resend and "+5 min" on a row, and "+5 min to the round" - each a real POST that
 *      answers on screen.
 *   3. Round 1 decided on both boards: "Pair next round" (MD-R15) is offered, pressed once, answers "paired"; round 2 is then "ready
 *      to open" on round 1's own panel; its press goes to round 2's panel, whose "Open round" opens it (O4: the press is only on the
 *      round's own panel).
 *   4. A board held for a Lichess link, window running: the block says why and the round's press reads "Open round 1 again"; the
 *      press re-opens the round, the board (now linked) leaves the hold. With the window run out the block says the window closed
 *      and offers no press that would loop silently.
 *   5. FROZEN vs unfrozen on the SAME view at the real `md-round-open-cta` (O4): loaded unfrozen it is there; a freeze that lands
 *      under that open page is answered 402 and the panel words it as the freeze (never "failed"); reloaded frozen, the pairings stay
 *      and the press is gone.
 *   6. 768: "Round N" never wraps inside the list's row title (controller carry, T6); no sideways scroll.
 *
 * Expected copy comes from the dictionaries and the declared constants, never from the page. Not covered here, on purpose: an OLDER
 * stage's row of a two-stage division (the unit suite posts to the row's own stage - round-focus.test.tsx), and the 320 capture
 * (screenshots, not an assertion).
 */
import { test, expect, type Page } from "@playwright/test";
import { DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS } from "../src/server/external-play/window";
import { TAG, apiJson, expectNoHorizontalScroll, invalidateOrgEntitlements, setEntitlementOverrideSql, setOrgPlanBySql, withDb } from "./helpers";
import { dismissConsent, freshOrg } from "./directory-kit";
import { backdateOpenSql, openAnswerOf, openRoundSent } from "./arbiter-column-kit";
import { fill, seedOnlineRound, seedSeatInvite, uiEn, type SeededRound } from "./match-room-kit";

// ── budget (class 20): a derived ceiling, never one flat number ──────────────────────────────────────────────────────────────────
const SEED_MS = 120_000; // login + org + plan + four linked players + the division through the API
const NAV_MS = 25_000; // a page load or a client navigation
const ACT_MS = 8_000; // one tap, its request and the assertion that follows
const budget = (navs: number, acts: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS;

const NAMES = ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"];

/** The organiser's own organisation on Pro, with one Swiss division of four players (two boards a round, three rounds). */
async function seedDay(page: Page, label: string, opts: { open: boolean }): Promise<{ orgId: string; round: SeededRound; matchDay: string }> {
  const { orgId } = await freshOrg(page, label);
  await dismissConsent(page);
  await setOrgPlanBySql({ orgId }, "pro");
  await invalidateOrgEntitlements(page.request, orgId);
  const round = await seedOnlineRound(page.request, NAMES, { stage: "swiss", open: opts.open });
  return { orgId, round, matchDay: `/o/${round.slugs.org}/c/${round.slugs.comp}/match-day` };
}

const roundKey = (r: SeededRound, no: number) => `${r.stageId}:${no}`;
const panel = (page: Page) => page.getByTestId("md-focus");

/** Both boards of a round decided (1-0 each way), through the organiser's own scoring API - what reconcile writes when a game ends. */
async function decideRound(page: Page, r: SeededRound, no: number): Promise<void> {
  const boards = await withDb(
    (sql) => sql<{ id: string; home: string }[]>`select id, home_entrant_id as home from fixtures where stage_id = ${r.stageId} and round_no = ${no} order by seq_in_round`,
  );
  expect(boards.length, "premise: the round has its two boards").toBe(2);
  for (const b of boards) {
    for (const [seq, event] of [
      [0, { type: "core.start", payload: {} }],
      [1, { type: "boardgame.result", payload: { winner: b.home, method: "resign" } }],
    ] as const) {
      const res = await apiJson(page.request, `/api/v1/fixtures/${b.id}/events`, "POST", { expected_seq: seq, ...event });
      expect(res.status, `${b.id} seq ${seq}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    }
  }
}

// File scope, as freshOrg requires: a bare context inherits the shared organiser's session, and a freeze must never touch that org.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Match Day online - the round panel", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a paired round loaded from ?round=: Open round (one primary, the run sheet's confirmation, this stage's POST) moves the panel to check-in without a reload; Resend and +5 answer on screen", async ({ page }) => {
    test.setTimeout(budget(3, 14));
    const { round: r, matchDay } = await seedDay(page, `mdrp${TAG}`.slice(0, 14), { open: false });
    await page.goto(`${matchDay}?round=${roundKey(r, 1)}`);

    // 1. the panel is the row's own, in its phase, loaded from the address
    await expect(panel(page)).toHaveAttribute("data-key", roundKey(r, 1), { timeout: 30_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "before");
    await expect(page.getByTestId("arbiter-column-pairings").locator("li"), "both pairings are listed").toHaveCount(2);
    const cta = page.getByTestId("md-round-open-cta");
    await expect(cta, "one open press").toHaveCount(1);
    await expect(cta).toHaveAttribute("data-primary", "true");
    await expect(cta).toHaveText(uiEn["runsheet.round.openCta"]!);

    // marks the page, so a reload (a new document) is told from the shell's own quiet read
    await page.evaluate(() => ((window as unknown as { __noReload?: boolean }).__noReload = true));
    await cta.click();
    const dialog = page.getByTestId("md-round-confirm");
    await expect(dialog, "the confirmation is asked for, not sent").toBeVisible();
    const sent = openRoundSent(page, r.stageId);
    await page.getByTestId("md-round-confirm-confirm").click();
    const answer = await openAnswerOf(await sent);
    expect(answer.opened, "the round opened").toBe(true);
    await expect(panel(page), "the panel moves to check-in on the shell's own read").toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), "no reload: the same document").toBe(true);

    // 2. checking in: both boards wait; Resend and +5 on a row, +5 to the round
    const rows = page.getByTestId("arbiter-waiting-row");
    await expect(rows, "nobody has checked in: both boards are waited on").toHaveCount(2);
    await expect(page.getByTestId("arbiter-waiting-heading")).toHaveText(fill("arbiter.column.waiting.other", { count: 2 }));
    // The e2e server sends no mail, so no seat holds one and no row offers Resend (arbiter-panel.spec.ts says the same); one seat per board
    // is written the way the provider's hook leaves a sent mail, and the page is read again (a new document: the no-reload mark is done).
    for (const b of r.boards) await seedSeatInvite(b.fixtureId, "white", "sent");
    await page.reload();
    await expect(panel(page)).toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
    await expect(rows, "still both boards after the read").toHaveCount(2);
    await expect(page.getByTestId("arbiter-waiting-resend"), "a seat holds a mail on each board: each row offers Resend").toHaveCount(2);
    const first = rows.first();
    const extendSent = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes("/external-play/extend-checkin"));
    await first.getByTestId("arbiter-waiting-extend").click();
    expect((await extendSent).status(), "the board's +5 was taken").toBeLessThan(300);
    await expect(first.getByTestId("arbiter-waiting-extend-notice"), "and answers under the board it was pressed for").toBeVisible();
    const resendSent = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes("/external-play/resend"));
    await first.getByTestId("arbiter-waiting-resend").click();
    expect((await resendSent).status(), "Resend answered").toBeLessThan(300);
    await expect(first.getByTestId("arbiter-waiting-notice")).toBeVisible();
    const roundExtendSent = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes(`/stages/${r.stageId}/extend-checkin`));
    await page.getByTestId("arbiter-extend-round-cta").click();
    expect((await roundExtendSent).status(), "the round's +5 was taken").toBeLessThan(300);
    await expect(page.getByTestId("arbiter-extend-round-notice").locator("p").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("Pair next round once round 1 is decided (one press, 'paired'), round 2 is 'ready to open' on round 1's panel, and its own panel opens it", async ({ page }) => {
    test.setTimeout(budget(4, 16));
    const { round: r, matchDay } = await seedDay(page, `mdpn${TAG}`.slice(0, 14), { open: true });
    await decideRound(page, r, 1);
    await page.goto(`${matchDay}?round=${roundKey(r, 1)}`);
    await expect(panel(page)).toHaveAttribute("data-key", roundKey(r, 1), { timeout: 30_000 });
    expect(await page.getByTestId("md-round-ready").count(), "premise: round 2 is not paired yet, so there is no ready line").toBe(0);
    // MD-R31: every board is over, so the panel says "2 boards finished" and nothing above it (never "0 of 2 boards playing" over it)
    await expect(page.getByTestId("arbiter-column-finished")).toHaveText(fill("arbiter.column.finished.other", { count: 2 }));
    await expect(page.getByTestId("arbiter-column-playing"), "all over: no playing line").toHaveCount(0);

    const pair = page.getByTestId("md-round-pair-next");
    await expect(pair, "every board is over and the stage's next round is round 2: one press").toHaveCount(1);
    await expect(pair).toHaveText(uiEn["schedule.pairNext"]!);
    const generated = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes(`/stages/${r.stageId}/generate`));
    await pair.click();
    expect((await generated).status(), "the stage rail's own route paired round 2").toBeLessThan(300);
    await expect(page.getByTestId("md-round-pair-notice"), "the answer outlives the press").toContainText(fill("matchDay.round.pairedNotice", { round: 2 }));
    await expect(pair, "the press is gone once round 2 is paired").toHaveCount(0, { timeout: 30_000 });

    // M5: round 2 is ready to open, and ONE card says so: the answer's card carries the go-to press (no second "ready to open" card beside it);
    // the go-to press moves to round 2's panel, which opens it
    const go = page.getByTestId("md-round-pair").getByTestId("md-round-ready-go");
    await expect(go, "the paired card carries the go-to press").toHaveText(fill("matchDay.round.readyGo", { round: 2 }), { timeout: 30_000 });
    await expect(page.getByTestId("md-round-ready"), "and there is no second card saying the same").toHaveCount(0);
    await expect(page.getByTestId("md-round-pair-notice")).toContainText(fill("matchDay.round.pairedNotice", { round: 2 }));
    await expect(page.getByTestId("md-round-open-cta"), "round 1's panel never draws round 2's Open round").toHaveCount(0);
    await go.click();
    await expect(panel(page)).toHaveAttribute("data-key", roundKey(r, 2));
    await expect(panel(page)).toHaveAttribute("data-state", "before");
    const sent = openRoundSent(page, r.stageId);
    await page.getByTestId("md-round-open-cta").click();
    await page.getByTestId("md-round-confirm-confirm").click();
    const answer = await openAnswerOf(await sent);
    expect(answer.opened, "round 2 opened").toBe(true);
    const opened = await withDb((sql) => sql<{ round_no: number }[]>`select round_no from stage_round_opens where stage_id = ${r.stageId} order by round_no`);
    expect(opened.map((o) => o.round_no), "both rounds are open on the server").toEqual([1, 2]);
    await expect(panel(page)).toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
  });

  test("a board held for a Lichess link: the block says why, 'Open round 1 again' re-opens; with the window run out it says the window closed and offers no press", async ({ page }) => {
    test.setTimeout(budget(3, 10));
    const { round: r, matchDay } = await seedDay(page, `mdlh${TAG}`.slice(0, 14), { open: true });
    const held = r.boards[0]!;
    // What the open's own skip leaves on a board whose player has not linked Lichess (open-round.ts `heldBoards`).
    await withDb(
      (sql) => sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'lichess_unlinked', updated_at = now() where fixture_id = ${held.fixtureId}`,
    );
    await page.goto(`${matchDay}?round=${roundKey(r, 1)}`);
    await expect(panel(page)).toHaveAttribute("data-key", roundKey(r, 1), { timeout: 30_000 });
    const block = page.getByTestId("md-round-linkhold");
    await expect(block).toBeVisible();
    const board = block.getByTestId("md-round-linkhold-board");
    await expect(board).toHaveCount(1);
    await expect(board).toHaveAttribute("data-reason", "lichess_unlinked");
    await expect(board).toHaveAttribute("data-window-closed", "false");
    await expect(board.getByTestId("md-round-linkhold-reason")).toHaveText(uiEn["externalPlay.openRound.skipped.lichessUnlinked"]!);
    const again = page.getByTestId("md-round-reopen-cta");
    await expect(again, "the round's own press, named for what it does").toHaveText(fill("matchDay.round.openAgain", { round: 1 }));
    const sent = openRoundSent(page, r.stageId);
    await again.click();
    // M3: the dialog asks and confirms in the press's own words
    await expect(page.getByTestId("arbiter-column-reinvite-dialog"), "the dialog names the press").toContainText(fill("matchDay.round.openAgainTitle", { round: 1 }));
    await expect(page.getByTestId("arbiter-column-reinvite-dialog-confirm")).toHaveText(fill("matchDay.round.openAgain", { round: 1 }));
    await page.getByTestId("arbiter-column-reinvite-dialog-confirm").click();
    const answer = await openAnswerOf(await sent);
    expect(answer, "the open answered").toBeDefined();
    // the player IS linked (the seed links everyone), so the re-open takes the board out of the hold
    await expect(block, "the board left the hold").toHaveCount(0, { timeout: 30_000 });

    // The window run out, M1's two branches. Nobody is bound to the open: a re-open restarts the check-in, so the press is offered and the
    // sentence "the time to take a seat has passed" is NOT said beside it (it would contradict the press that starts the time again).
    await withDb(
      (sql) => sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'lichess_reconnect', updated_at = now() where fixture_id = ${held.fixtureId}`,
    );
    await backdateOpenSql(r.stageId, 1, DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + 120_000);
    await page.goto(`${matchDay}?round=${roundKey(r, 1)}`);
    await expect(panel(page)).toHaveAttribute("data-key", roundKey(r, 1), { timeout: 30_000 });
    await expect(page.getByTestId("md-round-linkhold-board")).toHaveAttribute("data-window-closed", "true");
    await expect(page.getByTestId("md-round-reopen-cta"), "nobody bound: the press restarts the check-in, and is offered").toHaveCount(1);
    await expect(page.getByTestId("md-round-linkhold-closed"), "so the page does not also say the time has passed").toHaveCount(0);
    // The press is "none" only when a re-open could not start the check-in again, i.e. another board is still bound to the open: the second
    // board holds a sent mail, which binds it. Then the closed word is said, and there is no press that would do nothing.
    await seedSeatInvite(r.boards[1]!.fixtureId, "white", "sent");
    await page.goto(`${matchDay}?round=${roundKey(r, 1)}`);
    await expect(panel(page)).toHaveAttribute("data-key", roundKey(r, 1), { timeout: 30_000 });
    const closedBoard = page.getByTestId("md-round-linkhold-board");
    await expect(closedBoard).toHaveAttribute("data-reason", "lichess_reconnect");
    await expect(closedBoard).toHaveAttribute("data-window-closed", "true");
    await expect(closedBoard.getByTestId("md-round-linkhold-closed")).toHaveText(uiEn["externalPlay.openRound.skipped.windowClosed"]!);
    await expect(page.getByTestId("md-round-reopen-cta"), "never a silent press that cannot invite").toHaveCount(0);
  });

  test("frozen vs unfrozen on the SAME view: the press is there unfrozen; a freeze under an open page answers 402 in the freeze's words; reloaded frozen, the pairings stay and the press is gone", async ({ page }) => {
    test.setTimeout(budget(4, 8));
    const { orgId, round: r, matchDay } = await seedDay(page, `mdfz${TAG}`.slice(0, 14), { open: false });
    const url = `${matchDay}?round=${roundKey(r, 1)}`;
    await page.goto(url);
    await expect(panel(page)).toHaveAttribute("data-key", roundKey(r, 1), { timeout: 30_000 });
    await expect(page.getByTestId("md-round-open-cta"), "unfrozen: the press is on the view").toHaveCount(1);

    // The freeze: a limit of one, and a second, newer competition holds the running place (frozen-competition.spec.ts).
    const other = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Running ${TAG}`, visibility: "private" });
    expect(other.status, `the running competition: ${JSON.stringify(other.error)}`).toBe(201);
    await setEntitlementOverrideSql(orgId, "competitions.max_active", 1);
    await invalidateOrgEntitlements(page.request, orgId);

    // The page loaded before the freeze still offers the press; the server answers it 402, and the panel says the freeze.
    await page.getByTestId("md-round-open-cta").click();
    await page.getByTestId("md-round-confirm-confirm").click();
    await expect(page.getByTestId("arbiter-column-open-notice"), "the freeze's own sentence").toContainText(uiEn["runsheet.round.err.frozen"]!);
    await expect(page.getByTestId("arbiter-column-open-notice")).not.toContainText(uiEn["runsheet.round.err.failed"]!);
    expect(await withDb((sql) => sql`select 1 from stage_round_opens where stage_id = ${r.stageId}`), "nothing opened").toHaveLength(0);
    // MD-R30: the 402 is the page learning the competition froze. The purple press does not stay live beside the freeze notice until a reload: it
    // is gone now, on this same document, while the answer stays said (no reload happened since the page was first read).
    await expect(page.getByTestId("md-round-open-cta"), "after a driven 402 the press is gone, without a reload").toHaveCount(0);
    await expect(page.getByTestId("arbiter-column-open-notice"), "and the freeze's answer is still on screen").toContainText(uiEn["runsheet.round.err.frozen"]!);

    await page.goto(url);
    await expect(panel(page)).toHaveAttribute("data-state", "before", { timeout: 30_000 });
    await expect(page.getByTestId("arbiter-column-pairings").locator("li"), "frozen keeps the read").toHaveCount(2);
    await expect(page.getByTestId("md-round-open-cta"), "frozen: the same view has no press").toHaveCount(0);
  });

  test("at 768 the list row's 'Round N' is one line, and nothing scrolls sideways", async ({ page }) => {
    test.setTimeout(budget(2, 2));
    await page.setViewportSize({ width: 768, height: 900 });
    const { round: r, matchDay } = await seedDay(page, `mdw7${TAG}`.slice(0, 14), { open: false });
    await page.goto(matchDay);
    const row = page.locator(`[data-testid="md-round-row"][data-key="${roundKey(r, 1)}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const tail = row.locator("span.whitespace-nowrap");
    await expect(tail).toHaveText(fill("matchDay.online.round", { division: "Open Rapid", round: 1 }).replace("Open Rapid · ", ""));
    const lines = await tail.evaluate((el) => el.getClientRects().length);
    expect(lines, "a no-wrap tail is one line box").toBe(1);
    await expectNoHorizontalScroll(page);
  });
});
