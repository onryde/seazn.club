/**
 * Match Day online, Task 8 - the board panel, TAPPED against the real server (owner rule 2026-11-01: every event under test is tapped;
 * the API only reaches a state). One organiser on an organisation of their own (the freeze is organisation-wide, so the shared e2e
 * organisation must never see it), at 1280 unless a test says otherwise:
 *
 *   1. A LIVE board loaded straight from `?board=<fixture id>`: the real chessground board mounts with every piece, the two clocks show
 *      (the idle side its base, the side to move counting down in the browser), the presence marks on a seated board read "here" and "off"
 *      (and the board of nobody reads "away"), and a tap on another board's row switches the panel without a reload to a board with no
 *      game ("no game yet" plus the seats' words, no position).
 *   2. A board HELD for the organiser with two flags: the reason card, both flag cards, "Let the game go on" closes exactly those flags
 *      (kept on file under the organiser's name) and the panel re-reads without a reload; "Settle the result now" -> Draw decides the game.
 *   3. A CANCELLED board with an open flag: its flag card and "Mark as reviewed" (a cancelled board offers no settle); the press closes the
 *      flag and the board leaves the list.
 *   4. A link hold of an OLDER round (a league board held for a Lichess link, round 2 now open): it lands from `?board=` wearing its round's
 *      chip, and Settle -> "No result" abandons it (the league's void), the ledger carrying the organiser's own marked abandon.
 *   5. FROZEN vs unfrozen on the SAME board: "+5 min" (a START press) is there unfrozen; a freeze that lands under the open page is answered
 *      402 and the panel words it as the freeze (never "failed"), the press is gone on this same document, the FINISH decision stays; reloaded
 *      frozen, the board is still read and the press is still absent.
 *   6. A view-only member: the same flagged, held board reads with the flags stripped to their kind and time (chips, no details), no reason
 *      card, no decisions, nothing to press - and the organiser's page, the pair, has all of them.
 *
 * Task 9 (both players' cameras in the board panel) adds the describe at the foot of this file, run against the REAL producer - the loader's
 * `sides`, the shell's joins and the join route - never a fixture prop:
 *   7. A live board whose division REQUIRES cameras, both players here: the page asks the join route for BOTH meetings, White's first; the tiles
 *      say what the real route answered (the local server has no video vendor, so VIDEO_UNAVAILABLE) and the outage card is offered; letting the
 *      board play without video takes the cameras away.
 *   8. A view-only member of the same organisation reads the board and never asks the join route for anything.
 *   9. VIDEO_BUSY (the join route answered in the browser - the local server has no vendor budget, so it cannot answer BUSY itself): the tile
 *      waits ("Waiting for capacity"), is never an error, and the client's own ladder asks again until the route answers something else.
 *  10. Board A, then B, then A: each visit asks once per meeting, and nothing is asked for a board that has been left.
 *  11. MD-R33 with cameras: a HELD board with cameras, flags and a 168-character reason still has its whole decision on a 1280 x 800 screen -
 *      in English AND in Dutch (the longest words), the cameras' fold press on the state row (MD-R36) and the folded strip ONE line.
 *
 * Expected copy comes from the dictionaries and the declared constants, never from the page. Not covered here, on purpose: the phone widths
 * (e2e/mobile/match-surfaces.spec.ts), and a SUCCESSFUL video join (RealtimeKit is unreachable locally; the unit suites run the real join chain
 * over an SDK double - match-day/__tests__/match-day-online-driven.test.tsx).
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { formatClock } from "../src/components/public-site/match-room/clock-math";
import { TAG, apiJson, expectNoHorizontalScroll, invalidateOrgEntitlements, loginUi, setEntitlementOverrideSql, setOrgPlanBySql, withDb } from "./helpers";
import { dismissConsent, freshOrg } from "./directory-kit";
import { cancelFlaggedSql } from "./match-day-online-kit";
import { putArrival } from "./match-day-kit";
import { CLOCK, fill, roundGameSql, seedOnlineRound, uiEn, type RoundBoard, type SeededRound } from "./match-room-kit";

// ── budget (class 20): a derived ceiling, never one flat number ──────────────────────────────────────────────────────────────────
const SEED_MS = 120_000; // login + org + plan + four linked players + the division through the API
const NAV_MS = 25_000; // a page load or a client navigation
const ACT_MS = 8_000; // one tap, its request and the assertion that follows
const budget = (navs: number, acts: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS;

const NAMES = ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"];
/** Ten legal plies (an Italian): the rules judge them in roundGameSql. No capture among them, so all 32 pieces stand. */
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c2c3", "d7d6"];

type Day = { orgId: string; round: SeededRound; matchDay: string };

/** The organiser's own organisation on Pro, one online division of four players (two boards a round). */
async function seedDay(page: Page, label: string, opts: { stage: "swiss" | "league"; camera?: "optional" | "required" }): Promise<Day> {
  const { orgId } = await freshOrg(page, label);
  await dismissConsent(page);
  await setOrgPlanBySql({ orgId }, "pro");
  await invalidateOrgEntitlements(page.request, orgId);
  const round = await seedOnlineRound(page.request, NAMES, { stage: opts.stage, open: true, ...(opts.camera ? { camera: opts.camera } : {}) });
  return { orgId, round, matchDay: `/o/${round.slugs.org}/c/${round.slugs.comp}/match-day` };
}

/** A board's two flags, in their producers' note formats (match-day-online.spec.ts says the same): out-of-band play and a camera gap. */
async function flagBoard(orgId: string, board: RoundBoard): Promise<void> {
  const from = new Date(Date.now() - 20 * 60_000);
  from.setUTCMilliseconds(0);
  const to = new Date(from.getTime() + 95_000);
  const stamp = (d: Date) => d.toISOString().replace(".000Z", "Z");
  await withDb(async (sql) => {
    await sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
        (${board.fixtureId}, ${orgId}, 'out_of_band_play', null,
         ${`plies 2-5 (${LINE.slice(1, 5).join(" ")}) played at Lichess, not through Seazn; camera required`}),
        (${board.fixtureId}, ${orgId}, 'camera_lost', ${board.away.personId},
         ${`camera off 95 s of 1800 s in the match: ${stamp(from)} to ${stamp(to)} (its own off/on events agree); from 2 camera connections over 1 session; camera required`})`;
  });
}

const FLAG_KINDS = ["camera_lost", "out_of_band_play"];

const panel = (page: Page) => page.getByTestId("md-focus");
const decision = (page: Page) => page.getByTestId("arbiter-decision");
const rowOf = (page: Page, board: RoundBoard) => page.locator(`[data-testid="md-board-row"][data-fixture-id="${board.fixtureId}"]`);
const noReloadMark = (page: Page) => page.evaluate(() => ((window as unknown as { __noReload?: boolean }).__noReload = true));
const noReloadHeld = (page: Page) => page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload);

/** Every flag of a board and whether it is closed, with the role of whoever resolved it (the organiser's own, kept on file). */
const flagRows = (fixtureId: string) =>
  withDb(
    (sql) => sql<{ kind: string; closed: boolean; role: string | null }[]>`
      select f.kind, f.closed_at is not null as closed, m.role from fixture_play_flags f
        left join org_members m on m.user_id = f.resolved_by and m.org_id = f.org_id
       where f.fixture_id = ${fixtureId} order by f.kind`,
  );

// File scope, as freshOrg requires: a bare context inherits the shared organiser's session, and a freeze must never touch that org.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Match Day online - the board panel", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a live board loaded from ?board=: the real board with its pieces, both clocks (the side to move counts down), the presence marks here/off/away, and a tap on a board with no game", async ({ page }) => {
    test.setTimeout(budget(4, 6));
    const { orgId, round: r, matchDay } = await seedDay(page, `mdbl${TAG}`.slice(0, 14), { stage: "swiss", camera: "optional" });
    const [live, idle] = r.boards as [RoundBoard, RoundBoard];
    await roundGameSql(live, { moves: LINE });
    // White (the home side) is here with nothing said about its camera; Black is here and its own browser says the camera is OFF.
    await putArrival(live.fixtureId, orgId, "home", live.home.personId);
    await putArrival(live.fixtureId, orgId, "away", live.away.personId, { cameraOff: true });

    await page.goto(`${matchDay}?board=${live.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-online", "board", { timeout: 30_000 });
    await expect(panel(page)).toHaveAttribute("data-fixture-id", live.fixtureId);
    await expect(panel(page)).toHaveAttribute("data-state", "live");
    await expect(panel(page).getByRole("heading", { level: 2 }).first(), "the header names the board and its players").toContainText(`${live.home.name} v ${live.away.name}`);
    await expect(panel(page).getByTestId("md-open-pad"), "the match page is one press away").toHaveAttribute("href", new RegExp(`^/o/${r.slugs.org}/c/${r.slugs.comp}/d/${r.slugs.div}/f/\\d+$`));

    // The real chessground board, from the read: ten plies in, no capture, so all 32 pieces; White to move.
    const position = page.getByTestId("md-board-position");
    await expect(position, "the board's position is on screen").toBeVisible({ timeout: 30_000 });
    await expect(position.locator("cg-board piece"), "the real board mounted with every piece").toHaveCount(32);
    await expect(position).toHaveAttribute("data-turn", "white");
    await expect(page.getByTestId("md-board-nogame")).toHaveCount(0);

    // Both clocks: Black's, not running, keeps its base; White's runs and the browser counts it down (the shell's tick, no poll between).
    const white = position.getByTestId("md-board-clock-white");
    const black = position.getByTestId("md-board-clock-black");
    await expect(white).toHaveAttribute("data-active", "true");
    await expect(black).toHaveAttribute("data-active", "false");
    await expect(position.getByTestId("md-board-clock-black-time"), "the side not to move keeps its base").toHaveText(formatClock(CLOCK.base * 1000));
    const whiteTime = position.getByTestId("md-board-clock-white-time");
    const seconds = async () => {
      const [m, s] = ((await whiteTime.textContent()) ?? "").split(":").map(Number);
      return (m ?? NaN) * 60 + (s ?? NaN);
    };
    // Before the viewer's clock is known (the first frame) nothing runs and a side reads its base, so wait for the first tick to put White below it.
    await expect.poll(seconds, { timeout: 15_000, message: "White has been running since the last move, so below its base" }).toBeLessThan(CLOCK.base);
    const first = await seconds();
    await expect.poll(seconds, { timeout: 15_000, message: "the running clock keeps moving with no new read" }).toBeLessThan(first);

    // The marks: on the seats of the panel, and the list's own row says the same, White first.
    const seatMark = (colour: "white" | "black") => page.locator(`[data-testid="md-board-seat"][data-colour="${colour}"] [data-testid="md-presence"]`);
    await expect(seatMark("white")).toHaveAttribute("data-mark", "here");
    await expect(seatMark("black")).toHaveAttribute("data-mark", "off");
    await expect(rowOf(page, live).getByTestId("md-presence")).toHaveCount(2);
    await expect(rowOf(page, live).getByTestId("md-presence").nth(0)).toHaveAttribute("data-mark", "here");
    await expect(rowOf(page, live).getByTestId("md-presence").nth(1)).toHaveAttribute("data-mark", "off");
    await expect(rowOf(page, idle).getByTestId("md-presence"), "the board nobody has come to: both seats away").toHaveCount(2);
    for (const i of [0, 1]) await expect(rowOf(page, idle).getByTestId("md-presence").nth(i)).toHaveAttribute("data-mark", "away");
    await expectNoHorizontalScroll(page);

    // A tap on the other board's row: the panel is that board's, without a reload, and it has no game to draw.
    await noReloadMark(page);
    await rowOf(page, idle).click();
    await expect(panel(page)).toHaveAttribute("data-fixture-id", idle.fixtureId);
    await expect(page.getByTestId("md-board-nogame"), "no game yet: said, not an empty box").toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("md-board-nogame")).toHaveText(uiEn["matchDay.board.noGame"]!);
    await expect(page.getByTestId("md-board-position")).toHaveCount(0);
    await expect(page.getByTestId("md-board-seat-words"), "each seat says where its player stands").toHaveCount(2);
    expect(await noReloadHeld(page), "no reload: the same document").toBe(true);

    // The same board loaded fresh from the address (the other half of the door).
    await page.goto(`${matchDay}?board=${idle.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", idle.fixtureId, { timeout: 30_000 });
    await expect(page.getByTestId("md-board-nogame")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("md-board-position")).toHaveCount(0);
  });

  test("a held board with two flags: the reason and both flag cards; 'Let the game go on' closes exactly those flags and the panel re-reads without a reload; 'Settle the result now' -> Draw decides it", async ({ page }) => {
    test.setTimeout(budget(2, 8));
    const { orgId, round: r, matchDay } = await seedDay(page, `mdbh${TAG}`.slice(0, 14), { stage: "swiss" });
    const held = r.boards[1]!;
    await roundGameSql(held, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await flagBoard(orgId, held);

    await page.goto(`${matchDay}?board=${held.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", held.fixtureId, { timeout: 30_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "on_hold");
    await expect(page.getByTestId("md-board-hold"), "the editor is told WHY the board waits").toHaveAttribute("data-reason", "mismatch");
    const flags = page.getByTestId("md-board-flag");
    await expect(flags, "both flags are cards").toHaveCount(2, { timeout: 30_000 });
    expect(await flags.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")).sort())).toEqual(FLAG_KINDS);
    await expect(page.getByTestId("md-board-flags").getByText(uiEn["arbiter.flag.outOfBand.chip"]!)).toBeVisible();
    await expect(page.getByTestId("md-board-flags").getByText(uiEn["arbiter.flag.cameraOff.agree"]!)).toBeVisible();
    await expect(page.getByTestId("md-board-position"), "the game on file is drawn").toBeVisible();

    // "Let the game go on": exactly the flags on screen are closed and kept under the organiser's name; the game is untouched.
    await noReloadMark(page);
    const goOn = decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"] });
    await expect(goOn).toHaveCount(1);
    await goOn.click();
    await expect(decision(page).getByRole("status")).toHaveText(uiEn["arbiter.notice.wentOn"]!);
    const organiser = expect.stringMatching(/^(owner|admin)$/);
    expect(await flagRows(held.fixtureId), "both flags closed and kept on record, resolved by an organiser").toEqual([
      { kind: "camera_lost", closed: true, role: organiser },
      { kind: "out_of_band_play", closed: true, role: organiser },
    ]);
    await expect(page.getByTestId("md-board-flag"), "the panel re-reads: the closed flags are gone").toHaveCount(0, { timeout: 30_000 });
    await expect(goOn, "nothing is left to go on from").toHaveCount(0);
    expect(await noReloadHeld(page), "no reload: the same document").toBe(true);

    // "Settle the result now": the game is on file, so it is settled HERE - by colour. A Swiss round has no No result (it needs every game decided),
    // and says so under the three outcomes it does offer. Draw.
    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
    await settle.click();
    await expect(settle).toHaveAttribute("aria-expanded", "true");
    const choices = page.getByTestId("arbiter-settle").getByRole("button");
    await expect(choices).toHaveText([
      fill("externalPlay.settle.wins", { name: held.home.name }),
      fill("externalPlay.settle.wins", { name: held.away.name }),
      uiEn["externalPlay.resolve.draw"]!,
    ]);
    await expect(page.getByTestId("arbiter-settle-guidance"), "the Swiss refusal, in words").toHaveText(uiEn["arbiter.decide.swissNeedsResult"]!);
    await choices.filter({ hasText: uiEn["externalPlay.resolve.draw"]! }).click();
    await expect(decision(page).getByRole("status")).toHaveText(uiEn["arbiter.notice.settled"]!);
    const settled = await withDb(async (sql) => {
      const [row] = await sql<{ status: string; outcome: { kind?: string } | null }[]>`select status, outcome from fixtures where id = ${held.fixtureId}`;
      return row!;
    });
    expect(settled.status).toBe("decided");
    expect(settled.outcome).toMatchObject({ kind: "draw" });
    // The list's own read follows the press: the board is over.
    await expect(panel(page)).toHaveAttribute("data-state", "result", { timeout: 30_000 });
  });

  test("(MD-R33/R34) a held board is two columns from lg - the board capped at 420 / 42% on the left, the decision above the fold on the right - and one column, in the DOM's order, below lg", async ({ page }) => {
    test.setTimeout(budget(4, 2));
    const { orgId, round: r, matchDay } = await seedDay(page, `mdbg${TAG}`.slice(0, 14), { stage: "swiss" });
    const held = r.boards[1]!;
    await roundGameSql(held, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await flagBoard(orgId, held);

    /** Page coordinates (scroll added back) of the first element with this test id, with the scroll the page was at. */
    const box = (id: string) =>
      page.getByTestId(id).first().evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { left: b.left + window.scrollX, top: b.top + window.scrollY, right: b.right + window.scrollX, bottom: b.bottom + window.scrollY, width: b.width, height: b.height, scrollY: window.scrollY };
      });
    const open = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${matchDay}?board=${held.fixtureId}`);
      await expect(panel(page)).toHaveAttribute("data-fixture-id", held.fixtureId, { timeout: 30_000 });
      await expect(page.getByTestId("md-board-position"), "the game on file is drawn").toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("md-board-flag"), "both flags are cards").toHaveCount(2, { timeout: 30_000 });
      await expect(decision(page)).toBeVisible();
      await expect(page.getByTestId("md-board-hold")).toBeVisible();
      await expectNoHorizontalScroll(page);
    };

    // 1280 x 800, the screen an organiser has: the whole decision is on it without a scroll.
    await open(1280, 800);
    const dec = await box("arbiter-decision");
    expect(dec.scrollY, "measured from the top of the page").toBe(0);
    expect(dec.top, "the decision starts on the screen").toBeGreaterThanOrEqual(0);
    expect(dec.bottom, `the decision ends inside the 800px screen (it ended at ${Math.round(dec.bottom)})`).toBeLessThanOrEqual(800);
    const pos = await box("md-board-position");
    const grid = await box("md-board-grid");
    const left = await box("md-board-left");
    const head = await box("md-board-head");
    expect(pos.width, "the board is capped at 420").toBeLessThanOrEqual(420.5);
    expect(pos.width, "and it is a real board, not a collapsed one").toBeGreaterThan(300);
    expect(Math.abs(left.top - head.top), "the two columns start at the same height").toBeLessThanOrEqual(1);
    expect(head.left, "the right column is to the right of the board's").toBeGreaterThanOrEqual(left.right - 1);
    expect(head.right, "and it fills the width the board leaves").toBeGreaterThanOrEqual(grid.right - 1);
    // The right column reads state -> why it is held -> decision -> flags (the lg order), whatever the DOM order is.
    const rows = [await box("md-online-state"), await box("md-board-hold"), await box("arbiter-decision"), await box("md-board-flags")];
    expect(rows.map((b) => b.top), "state, why, decision, flags: each starts below the one before").toEqual([...rows.map((b) => b.top)].sort((a, b) => a - b));
    expect(new Set(rows.map((b) => Math.round(b.top))).size, "four distinct rows").toBe(4);
    // A one-column phone would put the decision below the board; here it sits in the column BESIDE it.
    expect(dec.left, "the decision is in the right column, beside the board").toBeGreaterThanOrEqual(left.right - 1);
    expect(dec.top, "and starts above the board's own foot, not a board's height down").toBeLessThan(pos.bottom + 40);

    // 1024 x 768, the narrowest lg: the board gives way (42% of the panel), nothing overflows.
    await open(1024, 768);
    // B6 (T8 minor): and Settle - the last button of the decision - is whole on that screen (it was half below the fold with the two quiet decisions stacked).
    const settle1024 = await decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] }).evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top + window.scrollY, bottom: b.bottom + window.scrollY, scrollY: window.scrollY };
    });
    expect(settle1024.scrollY, "measured from the top of the page").toBe(0);
    expect(settle1024.bottom, `Settle ends inside the 768px screen at 1024 (it ended at ${Math.round(settle1024.bottom)})`).toBeLessThanOrEqual(768);
    const pos1024 = await box("md-board-position");
    const grid1024 = await box("md-board-grid");
    expect(grid1024.width, "the panel is real").toBeGreaterThan(300);
    expect(pos1024.width, `the board is at most 42% of the panel (${Math.round(pos1024.width)} of ${Math.round(grid1024.width)})`).toBeLessThanOrEqual(grid1024.width * 0.42 + 1);
    expect(pos1024.width).toBeGreaterThan(150);
    expect((await box("md-board-head")).left, "still two columns").toBeGreaterThanOrEqual((await box("md-board-left")).right - 1);

    // 768: below lg, ONE column in the DOM's own order - state, board, why, flags, decision.
    await open(768, 1024);
    const phone = [await box("md-online-state"), await box("md-board-position"), await box("md-board-hold"), await box("md-board-flags"), await box("arbiter-decision")];
    expect(phone.map((b) => Math.round(b.top)), "state, board, why, flags, decision: each below the one before").toEqual([...phone.map((b) => Math.round(b.top))].sort((a, b) => a - b));
    expect(new Set(phone.map((b) => Math.round(b.top))).size, "five distinct rows").toBe(5);
    const posPhone = await box("md-board-position");
    const gridPhone = await box("md-board-grid");
    expect(posPhone.width, "the board keeps its one-column width: the whole panel, up to its 560 cap").toBeGreaterThanOrEqual(Math.min(560, gridPhone.width) - 1);
  });

  test("a cancelled board with an open flag: its flag card and 'Mark as reviewed' (no settle on a cancelled board); the press closes the flag and the board leaves the list", async ({ page }) => {
    test.setTimeout(budget(2, 4));
    const { orgId, round: r, matchDay } = await seedDay(page, `mdbc${TAG}`.slice(0, 14), { stage: "swiss" });
    const cancelled = r.boards[1]!;
    await cancelFlaggedSql(orgId, cancelled.fixtureId);

    await page.goto(`${matchDay}?board=${cancelled.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", cancelled.fixtureId, { timeout: 30_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "cancelled");
    await expect(page.getByTestId("md-board-flag"), "the flag the board was cancelled with").toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("md-board-flag")).toHaveAttribute("data-kind", "out_of_band_play");
    await expect(decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] }), "a cancelled board is never settled").toHaveCount(0);
    const review = decision(page).getByRole("button", { name: uiEn["externalPlay.queue.markReviewed"] });
    await expect(review).toHaveCount(1);
    await review.click();
    await expect.poll(async () => (await flagRows(cancelled.fixtureId)).map((f) => f.closed), { timeout: 15_000 }).toEqual([true]);
    // Nothing is left to decide on it, so it leaves the list; the shell says so by name rather than opening another board.
    await expect(page.getByTestId("md-lost"), "the board left the list").toBeVisible({ timeout: 45_000 });
  });

  test("a link hold of an OLDER round (a league board, round 2 open): it opens from ?board= wearing its round's chip, and Settle -> No result abandons it (the ledger carries the organiser's own marked abandon)", async ({ page }) => {
    test.setTimeout(budget(3, 6));
    const { round: r, matchDay } = await seedDay(page, `mdbo${TAG}`.slice(0, 14), { stage: "league" });
    const old = r.boards[0]!;
    // What the open's own skip leaves on a board whose player has not linked Lichess (open-round.ts `heldBoards`).
    await withDb(
      (sql) => sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'lichess_unlinked', updated_at = now() where fixture_id = ${old.fixtureId}`,
    );
    // Round 2 opens (a league pairs every round at Generate): round 1's board is now an EARLIER round's, on no round's list but "Needs a decision".
    const opened = await apiJson(page.request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo: 2 });
    expect(opened.status, `round 2 opened: ${JSON.stringify(opened.error)}`).toBeLessThan(300);

    await page.goto(`${matchDay}?board=${old.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", old.fixtureId, { timeout: 30_000 });
    await expect(panel(page).getByTestId("md-round-chip"), "it names the round it belongs to").toHaveAttribute("title", fill("matchDay.online.roundN", { n: 1 }));
    await expect(page.getByTestId("md-board-hold")).toHaveAttribute("data-reason", "lichess_unlinked");
    await expect(page.getByTestId("md-board-nogame")).toBeVisible();

    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
    await settle.click();
    await expect(settle).toHaveAttribute("aria-expanded", "true");
    const choices = page.getByTestId("arbiter-settle").getByRole("button");
    await expect(choices, "a league board: four outcomes, No result among them").toHaveCount(4);
    await expect(page.getByTestId("arbiter-settle-guidance"), "a league's void is not refused").toHaveCount(0);
    await choices.filter({ hasText: uiEn["externalPlay.resolve.noResult"]! }).click();
    await expect(decision(page).getByRole("status").or(page.getByTestId("md-lost"))).toBeVisible({ timeout: 45_000 });

    const voided = await withDb(async (sql) => {
      const [f] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${old.fixtureId}`;
      const ledger = await sql<{ type: string; payload: unknown }[]>`select type, payload from score_events where fixture_id = ${old.fixtureId} order by seq`;
      return { fixture: f!, ledger };
    });
    expect(voided.fixture, "VOID: abandoned, nobody's result").toEqual({ status: "abandoned", outcome: null });
    // no-result.ts: the abandon's reason is the HOLD's, in the club's words; marked as the organiser's own No result.
    expect(voided.ledger, "the abandon, its reason the hold's, marked as the organiser's No result").toEqual([
      { type: "core.abandon", payload: { reason: uiEn["externalPlay.resolve.abandonReason.lichess_unlinked"], noResult: true } },
    ]);
  });

  test("frozen vs unfrozen on the SAME board: '+5 min' is there unfrozen; a freeze under an open page answers 402 in the freeze's words, the press goes (same document) and the finishing decision stays; reloaded frozen, the board is read and the press stays gone", async ({ page }) => {
    test.setTimeout(budget(3, 6));
    const { orgId, round: r, matchDay } = await seedDay(page, `mdbf${TAG}`.slice(0, 14), { stage: "swiss" });
    const board = r.boards[0]!;
    const url = `${matchDay}?board=${board.fixtureId}`;
    await page.goto(url);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", board.fixtureId, { timeout: 30_000 });
    await expect(panel(page)).toHaveAttribute("data-state", "checking_in");
    const extend = decision(page).getByTestId("arbiter-extend-board");
    await expect(extend, "unfrozen: the START press is on the board").toHaveCount(1, { timeout: 30_000 });
    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
    await expect(settle, "the finishing decision is there too").toHaveCount(1);

    // The freeze: a limit of one, and a second, newer competition holds the running place (frozen-competition.spec.ts).
    const other = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Running ${TAG}`, visibility: "private" });
    expect(other.status, `the running competition: ${JSON.stringify(other.error)}`).toBe(201);
    await setEntitlementOverrideSql(orgId, "competitions.max_active", 1);
    await invalidateOrgEntitlements(page.request, orgId);

    // The page loaded before the freeze still offers the press; the server answers it 402, and the board says the freeze.
    await noReloadMark(page);
    const sent = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes(`/fixtures/${board.fixtureId}/external-play/extend-checkin`));
    await extend.click();
    expect((await sent).status(), "the freeze's own status").toBe(402);
    await expect(decision(page).getByRole("status")).toHaveText(uiEn["runsheet.round.err.frozen"]!);
    await expect(decision(page).getByRole("status")).not.toContainText(uiEn["externalPlay.checkinExtend.refused.failed"]!);
    // MD-R30: the 402 is the page learning the competition froze. The press is gone now, on this document, and the freeze's answer stays.
    await expect(extend, "after a driven 402 the START press is gone, without a reload").toHaveCount(0);
    await expect(decision(page).getByRole("status")).toHaveText(uiEn["runsheet.round.err.frozen"]!);
    await expect(settle, "a FINISH decision is not the freeze's: scoring is exempt").toHaveCount(1);
    expect(await noReloadHeld(page), "no reload: the same document").toBe(true);

    await page.goto(url);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", board.fixtureId, { timeout: 30_000 });
    await expect(page.getByTestId("md-board-seats"), "frozen keeps the read").toBeVisible();
    await expect(extend, "frozen: the same board has no START press").toHaveCount(0);
    await expect(settle, "frozen: the finishing decision stays").toHaveCount(1);
  });

  test("a view-only member and the organiser read the SAME flagged, held board: the member sees the flags as kind-and-time chips, no reason, nothing to press; the organiser sees cards, the reason and the decisions", async ({ page, browser }) => {
    test.setTimeout(budget(4, 2));
    const { orgId, round: r, matchDay } = await seedDay(page, `mdbv${TAG}`.slice(0, 14), { stage: "swiss" });
    const held = r.boards[1]!;
    await roundGameSql(held, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await flagBoard(orgId, held);
    const url = `${matchDay}?board=${held.fixtureId}`;

    // The pair: the organiser's page.
    await page.goto(url);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", held.fixtureId, { timeout: 30_000 });
    await expect(page.getByTestId("md-board-flag")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("md-board-hold")).toHaveCount(1);
    await expect(decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"] })).toHaveCount(1);
    const detail = fill("arbiter.flag.outOfBand.range.other", { count: 4, from: 1, to: 3 });
    await expect(page.getByTestId("md-board-flags").getByText(detail), "the organiser reads the flag's details").toBeVisible();

    const viewer = await viewerPage(browser, orgId);
    try {
      const vp = viewer.page;
      await vp.goto(url);
      await expect(panel(vp)).toHaveAttribute("data-fixture-id", held.fixtureId, { timeout: 45_000 });
      await expect(vp.getByTestId("md-board-position"), "the game is the viewer's to watch").toBeVisible({ timeout: 30_000 });
      const flags = vp.getByTestId("md-board-flag");
      await expect(flags, "the flags still render, stripped").toHaveCount(2);
      expect(await flags.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")).sort()), "kind and time, nothing else").toEqual(FLAG_KINDS);
      await expect(vp.getByTestId("md-board-flags")).toContainText(uiEn["matchDay.board.flagsViewer"]!);
      await expect(vp.getByTestId("md-board-flags").getByText(detail), "no flag details reach a viewer").toHaveCount(0);
      await expect(vp.getByTestId("md-board-flags").getByRole("button"), "no press on a flag").toHaveCount(0);
      await expect(vp.getByTestId("md-board-hold"), "the reason is the editor's").toHaveCount(0);
      await expect(vp.getByTestId("arbiter-decision"), "no decisions for a view-only reader").toHaveCount(0);
      await expect(vp.getByTestId("arbiter-outage")).toHaveCount(0);
      await expect(vp.getByRole("button", { name: uiEn["arbiter.decide.goOn"] })).toHaveCount(0);
      await expect(vp.getByRole("button", { name: uiEn["arbiter.decide.settle"] })).toHaveCount(0);
    } finally {
      await viewer.close();
    }
    // The viewer wrote nothing: both flags are still open.
    expect((await flagRows(held.fixtureId)).map((f) => f.closed), "a view-only member closed nothing").toEqual([false, false]);
  });
});

// ── Task 9: both players' cameras in the board panel ─────────────────────────────────────────────────────────────────────────────

/** Every POST the page makes to the join route, in the order it makes them: the fixture (by id) and the side it asked for. */
function joinPosts(page: Page): { fixtureId: string; side: string }[] {
  const posts: { fixtureId: string; side: string }[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const m = /\/api\/v1\/fixtures\/([^/]+)\/external-play\/arbiter$/.exec(new URL(req.url()).pathname);
    if (m) posts.push({ fixtureId: m[1]!, side: (req.postDataJSON() as { side: string }).side });
  });
  return posts;
}
const cameras = (page: Page) => page.getByTestId("md-cameras");
const tiles = (page: Page) => page.getByTestId("md-camera-tile");
const tileOf = (page: Page, colour: "white" | "black") => page.locator(`[data-testid="md-camera-tile"][data-colour="${colour}"]`);
const wordOf = (page: Page, colour: "white" | "black") => tileOf(page, colour).getByTestId("md-camera-word");

test.describe("Match Day online - the cameras in the board panel (Task 9)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /** A live board of a division that REQUIRES cameras, both players here (rooms, participants and presence on file: what the loader calls joinable). */
  async function liveWithArrivals(page: Page, label: string) {
    const day = await seedDay(page, label, { stage: "swiss", camera: "required" });
    const live = day.round.boards[0]!;
    await roundGameSql(live, { moves: LINE });
    await putArrival(live.fixtureId, day.orgId, "home", live.home.personId);
    await putArrival(live.fixtureId, day.orgId, "away", live.away.personId);
    return { ...day, live };
  }

  test("a live board that requires cameras, both players here: the page asks the join route for BOTH meetings, White's first; the tiles say what the real route answered; the outage card is offered and letting the board play without video takes the cameras away", async ({ page }) => {
    test.setTimeout(budget(2, 6));
    const { round: r, matchDay, live } = await liveWithArrivals(page, `mdc1${TAG}`.slice(0, 14));
    const posts = joinPosts(page);
    await page.goto(`${matchDay}?board=${live.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", live.fixtureId, { timeout: 30_000 });
    await expect(page.getByTestId("md-board-position"), "the board is drawn beside the cameras").toBeVisible({ timeout: 30_000 });
    await expect(cameras(page)).toBeVisible();
    await expect(tiles(page)).toHaveCount(2);
    await expect(tiles(page).first(), "White is the left tile").toHaveAttribute("data-colour", "white");
    await expect(tileOf(page, "white")).toContainText(live.home.name);
    await expect(tileOf(page, "black")).toContainText(live.away.name);
    // The real producer: the loader's `sides` -> the shell's keys -> the join route. White plays the home side (roundGameSql), so it is asked for first.
    await expect.poll(() => posts.map((p) => `${p.fixtureId === live.fixtureId ? "live" : p.fixtureId}:${p.side}`), { timeout: 30_000, message: "one POST per meeting, White's first" }).toEqual(["live:home", "live:away"]);
    // The local server has no video vendor, so the route's own answer is VIDEO_UNAVAILABLE: a tile word, never a thrown error.
    await expect(wordOf(page, "white")).toHaveText(uiEn["arbiter.tile.unavailable"]!, { timeout: 15_000 });
    await expect(wordOf(page, "black")).toHaveText(uiEn["arbiter.tile.unavailable"]!);
    await expect(tileOf(page, "white")).toHaveAttribute("data-view", "unavailable");
    // ... and it is the produced answer that offers the outage card (the seam T8 left for this task).
    const outage = page.getByTestId("arbiter-outage");
    await expect(outage, "the vendor is down: the card that lets the board play without video").toBeVisible();
    // The vendor being down is not retried by the ladder (only a busy vendor is): two seconds later, still two POSTs.
    await page.waitForTimeout(2_000);
    expect(posts, "no ladder for an unavailable vendor").toHaveLength(2);
    // The board is at move 6: a move was played, so the card says CARRY ON without video and that camera evidence stops here (MD-R37).
    await expect(outage).toContainText(uiEn["arbiter.outage.bodyStarted"]!);
    await expect(outage).not.toContainText(uiEn["arbiter.outage.body"]!);
    await outage.getByRole("button", { name: uiEn["arbiter.outage.ctaStarted"] }).click();
    // The board is let go without video: the panel re-reads, and no cameras are offered for it any more.
    await expect(page.getByTestId("md-board-cameras"), "let go without video: no cameras").toHaveCount(0, { timeout: 30_000 });
    await expect(outage).toHaveCount(0);
    await expect(page.getByTestId("md-board-position"), "the board is still there").toBeVisible();
    expect(r.boards.length).toBe(2);
  });

  test("a view-only member reads the same board and never asks the join route for anything; the organiser's page, the pair, does", async ({ page, browser }) => {
    test.setTimeout(budget(3, 2));
    const { orgId, matchDay, live } = await liveWithArrivals(page, `mdc2${TAG}`.slice(0, 14));
    const url = `${matchDay}?board=${live.fixtureId}`;
    const posts = joinPosts(page);
    await page.goto(url);
    await expect(tiles(page)).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(() => posts.length, { timeout: 30_000, message: "the organiser's page joins both meetings" }).toBe(2);

    const viewer = await viewerPage(browser, orgId);
    try {
      const vp = viewer.page;
      const viewerPosts = joinPosts(vp);
      await vp.goto(url);
      await expect(panel(vp)).toHaveAttribute("data-fixture-id", live.fixtureId, { timeout: 45_000 });
      await expect(vp.getByTestId("md-board-position"), "the game is the viewer's to watch").toBeVisible({ timeout: 30_000 });
      await expect(vp.getByTestId("md-cameras"), "no cameras for a view-only member").toHaveCount(0);
      await expect(vp.getByTestId("md-board-cameras")).toHaveCount(0);
      await vp.waitForTimeout(3_000);
      expect(viewerPosts, "a view-only member asks the join route for nothing").toEqual([]);
    } finally {
      await viewer.close();
    }
  });

  test("VIDEO_BUSY (route answered in the browser): the tiles wait - never an error, no retry button - and the client's own ladder asks again by itself until the route says something else", async ({ page }) => {
    test.setTimeout(budget(2, 3));
    const { matchDay, live } = await liveWithArrivals(page, `mdc3${TAG}`.slice(0, 14));
    // STUBBED, and why: the join route only answers VIDEO_BUSY when a vendor budget exists (the check-in line has first call on it), and the local server
    // has none. The first two asks of each meeting are answered BUSY, every later one VIDEO_UNAVAILABLE - the client's own ladder (500 ms, 1 s) walks them.
    const asked: Record<string, number> = { home: 0, away: 0 };
    await page.route(/\/external-play\/arbiter$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const { side } = route.request().postDataJSON() as { side: "home" | "away" };
      asked[side] = (asked[side] ?? 0) + 1;
      const code = asked[side]! <= 2 ? "VIDEO_BUSY" : "VIDEO_UNAVAILABLE";
      return route.fulfill({ status: 503, json: { ok: false, error: { code, message: code } } });
    });
    await page.goto(`${matchDay}?board=${live.fixtureId}`);
    await expect(tiles(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(tileOf(page, "white")).toHaveAttribute("data-view", "busy", { timeout: 15_000 });
    await expect(wordOf(page, "white")).toHaveText(uiEn["arbiter.tile.busy"]!);
    await expect(wordOf(page, "black")).toHaveText(uiEn["arbiter.tile.busy"]!);
    await expect(page.getByText(uiEn["arbiter.tile.error"]!, { exact: true }), "a busy vendor is not 'Video couldn't load'").toHaveCount(0);
    await expect(page.getByTestId("md-camera-retry"), "nothing to press: it asks again by itself").toHaveCount(0);
    await expect(page.getByTestId("arbiter-outage"), "busy is not the outage").toHaveCount(0);
    // The ladder: 500 ms and 1 s later each meeting has asked a third time and got the vendor's other answer.
    await expect(wordOf(page, "white")).toHaveText(uiEn["arbiter.tile.unavailable"]!, { timeout: 15_000 });
    await expect(wordOf(page, "black")).toHaveText(uiEn["arbiter.tile.unavailable"]!);
    expect(asked, "three asks a side: BUSY, BUSY, then the answer").toEqual({ home: 3, away: 3 });
    await expect(page.getByTestId("arbiter-outage"), "now the vendor is down, the card is offered").toBeVisible();
  });

  test("board A, then B, then A: each visit asks once per meeting, in order, and nothing is asked for the board that was left", async ({ page }) => {
    test.setTimeout(budget(3, 6));
    const day = await seedDay(page, `mdc4${TAG}`.slice(0, 14), { stage: "swiss", camera: "required" });
    const [a, b] = day.round.boards as [RoundBoard, RoundBoard];
    for (const board of [a, b]) {
      await roundGameSql(board, { moves: LINE });
      await putArrival(board.fixtureId, day.orgId, "home", board.home.personId);
      await putArrival(board.fixtureId, day.orgId, "away", board.away.personId);
    }
    const posts = joinPosts(page);
    const seen = () => posts.map((p) => `${p.fixtureId === a.fixtureId ? "A" : p.fixtureId === b.fixtureId ? "B" : p.fixtureId}:${p.side}`);
    await page.goto(`${day.matchDay}?board=${a.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", a.fixtureId, { timeout: 30_000 });
    await expect.poll(seen, { timeout: 30_000 }).toEqual(["A:home", "A:away"]);
    await rowOf(page, b).click();
    await expect(panel(page)).toHaveAttribute("data-fixture-id", b.fixtureId, { timeout: 15_000 });
    await expect.poll(seen, { timeout: 30_000 }).toEqual(["A:home", "A:away", "B:home", "B:away"]);
    await expect(tileOf(page, "white")).toContainText(b.home.name);
    await rowOf(page, a).click();
    await expect(panel(page)).toHaveAttribute("data-fixture-id", a.fixtureId, { timeout: 15_000 });
    // A's meetings are asked for again (a refusal is never kept), once each - and B is not asked for again after it was left.
    await expect.poll(seen, { timeout: 30_000 }).toEqual(["A:home", "A:away", "B:home", "B:away", "A:home", "A:away"]);
    await page.waitForTimeout(2_000);
    expect(seen(), "two seconds later: no extra ask").toHaveLength(6);
  });

  test("(MD-R37) the outage card on a board where nothing has been played (both players arrived, the vendor down) offers to let it START without video - the seating sentence; the live board of the first test says CARRY ON", async ({ page }) => {
    test.setTimeout(budget(1, 2));
    const day = await seedDay(page, `mdc6${TAG}`.slice(0, 14), { stage: "swiss", camera: "required" });
    const pre = day.round.boards[0]!;
    await putArrival(pre.fixtureId, day.orgId, "home", pre.home.personId);
    await putArrival(pre.fixtureId, day.orgId, "away", pre.away.personId);
    await page.goto(`${day.matchDay}?board=${pre.fixtureId}`);
    await expect(panel(page)).toHaveAttribute("data-fixture-id", pre.fixtureId, { timeout: 30_000 });
    await expect(page.getByTestId("md-board-position"), "premise: no game is on file, so no board is drawn").toHaveCount(0);
    const outage = page.getByTestId("arbiter-outage");
    await expect(outage, "the real route answered VIDEO_UNAVAILABLE for the arrived players").toBeVisible({ timeout: 30_000 });
    await expect(outage).toHaveAttribute("data-started", "false");
    await expect(outage).toContainText(uiEn["arbiter.outage.body"]!);
    await expect(outage).not.toContainText(uiEn["arbiter.outage.bodyStarted"]!);
    await expect(outage.getByRole("button", { name: uiEn["arbiter.outage.cta"] })).toBeVisible();
    await expect(outage.getByRole("button", { name: uiEn["arbiter.outage.ctaStarted"] })).toHaveCount(0);
  });

  // MD-R36: English AND Dutch (its words are the longest in the folded strip and in the reason), the 168-character account change in both and
  // the short mismatch in English. The measured bottoms are attached to the run (annotation "MD-R33 measure"), not printed.
  const DECISION_HEADROOM = 40;
  /** CI's fonts wrap the long Dutch reason about 24px taller than this machine's (CI run 44950623241: the decision ended at 762.7 where it measured 739 here, the B10
   *  class). The pin below is therefore taken against the screen minus that allowance too, so a local pass predicts CI's instead of sitting 21px from it. */
  const CI_WRAP_ALLOWANCE = 24;
  /** Fix round 2: Settle at 1024 x 768 keeps real headroom too (the long Dutch reason measured 764 against 768 = 4px, and CI's fonts wrap a line differently: the B10
   *  class). 20px is the least the review asked for; the right column's gaps and the hold and decision cards' padding are tighter from lg up to buy it (and the 1280 pin's CI allowance below), never the type. */
  const SETTLE_HEADROOM_1024 = 20;
  for (const locale of ["en", "nl"] as const) {
    test(`(MD-R33 with cameras, ${locale}) a HELD board with cameras, two flags and a LONG reason - the 168-character account change${locale === "en" ? " as well as the short mismatch" : ""} - keeps its whole decision on a 1280 x 800 screen, the cameras at the right column's top, their fold press on the state row`, async ({ page }) => {
      test.setTimeout(budget(4, 4));
      await page.context().addCookies([{ name: "seazn_locale", value: locale, url: new URL(page.url() === "about:blank" ? (process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000") : page.url()).origin }]);
      const day = await seedDay(page, `${locale === "en" ? "mdc5" : "mdc7"}${TAG}`.slice(0, 14), { stage: "swiss", camera: "required" });
      const [longHeld, shortHeld] = day.round.boards as [RoundBoard, RoundBoard];
      let flagged = 0;
      for (const [board, hold] of [[longHeld, "account_changed"], [shortHeld, "mismatch"]] as const) {
        await roundGameSql(board, { moves: LINE.slice(0, 6), hold });
        await flagBoard(day.orgId, board);
        await putArrival(board.fixtureId, day.orgId, "home", board.home.personId);
        await putArrival(board.fixtureId, day.orgId, "away", board.away.personId);
        flagged += 1;
      }
      expect(flagged).toBe(2);
      const box = (id: string) =>
        page.getByTestId(id).first().evaluate((el) => {
          const b = el.getBoundingClientRect();
          return { left: b.left + window.scrollX, top: b.top + window.scrollY, right: b.right + window.scrollX, bottom: b.bottom + window.scrollY, scrollY: window.scrollY };
        });
      let checked = 0;
      const measured = locale === "en" ? ([[longHeld, "a 168-character reason"], [shortHeld, "a short reason"]] as const) : ([[longHeld, "a 168-character reason"]] as const);
      for (const [board, label] of measured) {
        await page.goto(`${day.matchDay}?board=${board.fixtureId}`);
        await expect(panel(page)).toHaveAttribute("data-fixture-id", board.fixtureId, { timeout: 30_000 });
        await expect(page.getByTestId("md-board-position")).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("md-board-flag"), "both flags are cards").toHaveCount(2, { timeout: 30_000 });
        await expect(decision(page)).toBeVisible();
        await expect(cameras(page), `${label}: the cameras are on the board`).toBeVisible();
        await expect(cameras(page), "a held board opens with its cameras folded").toHaveAttribute("data-folded", "true");
        await expectNoHorizontalScroll(page);
        if (board === longHeld) {
          const reason = await page.getByTestId("md-board-hold").innerText();
          expect(reason.length, "premise: the reason is the long one").toBeGreaterThan(160);
        }
        const dec = await box("arbiter-decision");
        expect(dec.scrollY, "measured from the top of the page").toBe(0);
        test.info().annotations.push({ type: "MD-R33 measure", description: `${locale} / ${label}: decision bottom ${Math.round(dec.bottom)}` });
        // B7: real headroom, not 9px. The two quiet decisions share a row from lg, which took ~50px off the column; the pin keeps 40 of them, so a taller font
        // (CI's, an older Dutch translation) moves the line without breaking it - and a change that eats the headroom is told at once, before it eats the screen.
        expect(dec.bottom, `${locale} / ${label}: the decision ends ${DECISION_HEADROOM}px inside the 800px screen, and a CI wrap (${CI_WRAP_ALLOWANCE}px) more still fits (it ended at ${Math.round(dec.bottom)})`).toBeLessThanOrEqual(800 - DECISION_HEADROOM - CI_WRAP_ALLOWANCE);
        // MD-R36: the fold's press is on the state row (not in the strip), and the folded strip is ONE line in every language.
        await expect(cameras(page).getByTestId("md-cameras-toggle"), "the strip carries no toggle of its own").toHaveCount(0);
        const state = await box("md-online-state");
        const toggle = await box("md-cameras-toggle");
        expect(toggle.top, `${locale}: the press shares the state word's row`).toBeLessThan(state.bottom);
        expect(toggle.bottom, `${locale}: ... and does not sit below it`).toBeGreaterThan(state.top);
        const strip = await box("md-cameras");
        expect(strip.bottom - strip.top, `${locale}: the folded strip is one line (it is ${Math.round(strip.bottom - strip.top)}px)`).toBeLessThanOrEqual(24);
        // B10 (CI wrapped this strip to 44px under its fonts and this machine's did not): one line BY CONSTRUCTION, whatever the font. Squeeze the strip's column to
        // 120px - narrower than the two words in any typeface - and it must still be one line, the words cut (ellipsis) with their whole text in the title.
        const squeezed = await page.getByTestId("md-board-cameras").evaluate((el) => {
          const wrap = el as HTMLElement;
          const before = wrap.style.width;
          wrap.style.width = "120px";
          const strip = wrap.querySelector('[data-testid="md-cameras"]')!.getBoundingClientRect();
          const words = [...wrap.querySelectorAll<HTMLElement>('[data-testid="md-camera-word"]')];
          const out = {
            height: strip.bottom - strip.top,
            words: words.length,
            cut: words.filter((w) => w.scrollWidth > w.clientWidth).length,
            titled: words.filter((w) => (w.getAttribute("title") ?? "").trim() !== "" && w.getAttribute("title") === (w.textContent ?? "")).length,
          };
          wrap.style.width = before;
          return out;
        });
        expect(squeezed.words, `${locale}: both tiles' words were measured`).toBe(2);
        expect(squeezed.height, `${locale}: squeezed to 120px the folded strip is still one line (it is ${Math.round(squeezed.height)}px)`).toBeLessThanOrEqual(24);
        expect(squeezed.cut, `${locale}: ... which cut the words (a squeeze that cuts nothing proves nothing)`).toBeGreaterThan(0);
        expect(squeezed.titled, `${locale}: ... and each carries its whole word as its title`).toBe(2);
        // The right column reads: state, cameras, why it is held, the decision, the flags - each starts below the one before.
        const left = await box("md-board-left");
        const rows = [await box("md-online-state"), await box("md-board-cameras"), await box("md-board-hold"), await box("arbiter-decision"), await box("md-board-flags")];
        expect(rows.map((r) => Math.round(r.top)), `${label}: state, cameras, why, decision, flags`).toEqual([...rows.map((r) => Math.round(r.top))].sort((x, y) => x - y));
        expect(new Set(rows.map((r) => Math.round(r.top))).size, "five distinct rows").toBe(5);
        expect(rows[1]!.left, "the cameras are in the right column, beside the board").toBeGreaterThanOrEqual(left.right - 1);
        checked += 1;
      }
      expect(checked, "every reason was measured").toBe(measured.length);
      // B6 (review): the 1024 x 768 pin of the (MD-R33/R34) test above holds the SHORT reason only. The hold line is the tallest thing in the right column, and the
      // 1024 column is the narrowest lg one, so the same screen with the 168-character account change (and, in Dutch, the longest quiet labels) must still show
      // Settle - the decision's last button - whole, in every language this test runs. The button is the one decision control that opens a panel (aria-controls).
      await page.setViewportSize({ width: 1024, height: 768 });
      let settleChecked = 0;
      for (const [board, label] of measured) {
        await page.goto(`${day.matchDay}?board=${board.fixtureId}`);
        await expect(panel(page)).toHaveAttribute("data-fixture-id", board.fixtureId, { timeout: 30_000 });
        await expect(page.getByTestId("md-board-flag"), "both flags are cards").toHaveCount(2, { timeout: 30_000 });
        await expect(decision(page)).toBeVisible();
        await expectNoHorizontalScroll(page);
        if (board === longHeld) expect((await page.getByTestId("md-board-hold").innerText()).length, "premise: the reason is the long one").toBeGreaterThan(160);
        const settleButton = decision(page).locator("button[aria-expanded][aria-controls]");
        await expect(settleButton, "the decision has ONE button that opens a panel: Settle").toHaveCount(1);
        const settle = await settleButton.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return { bottom: b.bottom + window.scrollY, scrollY: window.scrollY };
        });
        expect(settle.scrollY, "measured from the top of the page").toBe(0);
        // Where the right column's height goes at the narrowest lg (heights, not tops: a row that grows is the one to trim).
        const rowsAt1024 = await Promise.all(["md-online-state", "md-cameras-toggle", "md-open-pad", "md-board-cameras", "md-board-hold", "arbiter-decision", "md-board-flags"].map(async (id) => {
          if ((await page.getByTestId(id).count()) === 0) return `${id} -`;
          const b = await page.getByTestId(id).first().evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, left: r.left, right: r.right };
          });
          return `${id} y${Math.round(b.top)}-${Math.round(b.bottom)} x${Math.round(b.left)}-${Math.round(b.right)}`;
        }));
        const decisionParts = await decision(page).evaluate((el) =>
          [...el.querySelectorAll(":scope > *, :scope > [data-testid='arbiter-quiet-decisions'] > *")].map((c) => {
            const r = c.getBoundingClientRect();
            return `${c.tagName.toLowerCase()} y${Math.round(r.top + window.scrollY)}-${Math.round(r.bottom + window.scrollY)} x${Math.round(r.left)}-${Math.round(r.right)}`;
          }),
        );
        test.info().annotations.push({ type: "MD-R33 measure", description: `${locale} / ${label} at 1024x768: Settle bottom ${Math.round(settle.bottom)} (${rowsAt1024.join(", ")}) decision parts: ${decisionParts.join(" | ")}` });
        expect(settle.bottom, `${locale} / ${label}: Settle ends ${SETTLE_HEADROOM_1024}px inside the 768px screen at 1024 (it ended at ${Math.round(settle.bottom)})`).toBeLessThanOrEqual(768 - SETTLE_HEADROOM_1024);
        settleChecked += 1;
      }
      expect(settleChecked, "every reason was measured at 1024").toBe(measured.length);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${day.matchDay}?board=${longHeld.fixtureId}`);
      await expect(cameras(page)).toBeVisible({ timeout: 30_000 });
      // The toggle: unfolded the tiles are video boxes; folded again they are status lines.
      await page.getByTestId("md-cameras-toggle").click();
      await expect(cameras(page)).toHaveAttribute("data-folded", "false");
      await page.getByTestId("md-cameras-toggle").click();
      await expect(cameras(page)).toHaveAttribute("data-folded", "true");
    });
  }
});

/** A view-only member of the organisation, signed in on a page of their own (match-day.spec.ts `viewerPage`, here by org id). `close()` frees the seat. */
async function viewerPage(browser: Browser, orgId: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `delivered+t8-viewer-${TAG}-${tag}@resend.dev`;
  const userId = await withDb(async (sql) => {
    const [u] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${email}, ${"T8 Viewer " + tag}, true) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, 'viewer')`;
    return u!.id;
  });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await loginUi(page, email);
  await page.request.post("/api/onboarding/complete", { data: {} }).catch(() => undefined);
  return {
    page,
    close: async () => {
      try {
        await context.close();
      } finally {
        await withDb((sql) => sql`delete from org_members where org_id = ${orgId} and user_id = ${userId}`);
      }
    },
  };
}
