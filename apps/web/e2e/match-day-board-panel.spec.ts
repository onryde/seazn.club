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
 * Expected copy comes from the dictionaries and the declared constants, never from the page. Not covered here, on purpose: the phone widths
 * (e2e/mobile/match-surfaces.spec.ts), and the camera panes (Task 9: `cameras` is a seam this panel mounts when given).
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { formatClock } from "../src/components/public-site/match-room/clock-math";
import { TAG, apiJson, expectNoHorizontalScroll, invalidateOrgEntitlements, loginUi, setEntitlementOverrideSql, setOrgPlanBySql, withDb } from "./helpers";
import { dismissConsent, freshOrg } from "./directory-kit";
import { cancelFlaggedSql } from "./arbiter-column-kit";
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
async function seedDay(page: Page, label: string, opts: { stage: "swiss" | "league"; camera?: "optional" }): Promise<Day> {
  const { orgId } = await freshOrg(page, label);
  await dismissConsent(page);
  await setOrgPlanBySql({ orgId }, "pro");
  await invalidateOrgEntitlements(page.request, orgId);
  const round = await seedOnlineRound(page.request, NAMES, { stage: opts.stage, open: true, ...(opts.camera ? { camera: opts.camera } : {}) });
  return { orgId, round, matchDay: `/o/${round.slugs.org}/c/${round.slugs.comp}/match-day` };
}

/** One side's ARRIVAL as the presence read sees it (arbiter.ts `readPlayerPresence`): the room, the player on file in it, and a webhook presence
 *  row. `cameraOff` also stamps the browser's own fresh report "off" on the player's participant (the pill's word, `reportedCamera`). */
async function putArrival(fixtureId: string, orgId: string, side: "home" | "away", personId: string, opts: { cameraOff?: boolean } = {}): Promise<void> {
  await withDb(async (sql) => {
    const meetingId = `e2e-mtg-${side}-${randomUUID().slice(0, 8)}`;
    const room = await sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      select f.id, ${side}, ${orgId}, ${meetingId}, f.home_entrant_id, f.away_entrant_id from fixtures f where f.id = ${fixtureId}`;
    expect(room.count, `room ${side} for ${fixtureId}`).toBe(1);
    const participantId = `e2e-pp-${side}-${randomUUID().slice(0, 8)}`;
    const player = opts.cameraOff
      ? await sql`
          insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, camera_reported, camera_reported_at)
          values (${fixtureId}, ${side}, ${personId}, 'player', ${participantId}, 'off', now())`
      : await sql`
          insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
          values (${fixtureId}, ${side}, ${personId}, 'player', ${participantId})`;
    expect(player.count, `the ${side} player on file for ${fixtureId}`).toBe(1);
    const presence = await sql`
      insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, joined_at, source)
      values (${meetingId}, ${`e2e-peer-${side}-${randomUUID().slice(0, 8)}`}, ${fixtureId}, ${side}, ${participantId}, ${personId}, now(), 'webhook')`;
    expect(presence.count, `the ${side} player's presence row for ${fixtureId}`).toBe(1);
  });
}

/** A board's two flags, in their producers' note formats (arbiter-panel.spec.ts says the same): out-of-band play and a camera gap. */
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
