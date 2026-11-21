/**
 * Match Day online (Task 10) - the Arbiter Panel's sequences, in a browser, against the real server, now on Match Day's own panels.
 *
 * This file REPLACES `arbiter-panel.spec.ts` (the page it drove, `/o/.../d/.../arbiter`, is gone: owner MD-R3, no redirect). Every flow that
 * spec proved has a home: here, in `match-day-board-panel.spec.ts` / `match-day-round-panel.spec.ts` (Tasks 7-9), in `online-chess-desk.spec.ts`
 * and `checkin-extend.spec.ts` (the round column's flows, now the round panel's), or in `e2e/mobile/match-surfaces.spec.ts` (the phone widths).
 * The mapping table is in the Task 10 report; the one-line reasons for what was NOT ported are on the tests below that say "not ported".
 *
 * The organiser's half goes through the product: a public competition, a boardgame division played online (camera REQUIRED where a test needs
 * video, set before the round opens as D9 allows), four linked players, a stage, Start and round 1 opened through the open-round route. Three
 * facts no API writes are seeded by SQL, and each says why (the same three the Arbiter Panel's spec seeded):
 *  - the players' Lichess links (match-room-kit.ts: linking is an OAuth trip to lichess.org);
 *  - a game's ledger on a board, written the way T9/T10 leave it (`roundGameSql`, White the home side);
 *  - a board's flags, in the notes their producers write (reconcile's out-of-band adoption, the sweep's camera report).
 * Video: the server runs with no RealtimeKit, so a join is the route's real VIDEO_UNAVAILABLE - or, where a test needs a joinable room, the join
 * route is answered in the browser (`wire`) with a token the real SDK cannot connect with. What is proven is Match Day's half: which sides it
 * asks for, that it sends no DELETE and makes one join per open, the states it paints and the controls a person touches.
 *
 * Expected copy comes from the dictionary, expected boards and moves from the rules (chess.js, FIDE move numbering), never from the panel's code.
 */
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { QUIET_POLL_MS } from "../src/components/v2/desk/band-poll";
import { apiJson, loginUi, TAG, withDb } from "./helpers";
import { putArrival } from "./match-day-kit";
import {
  boardPanelUrl,
  budgetFor,
  expectSeatWord,
  focus,
  inviteRowCount,
  openRoundPanel,
  openRoundSent,
  recordedOpenNotices,
  recordOpenNotices,
  refreshNow,
  watchOpenRoundPosts,
} from "./match-day-online-kit";
import { fill, longName, roundGameSql, seedOnlineRound, seedSeatInvite, uiEn, type RoundBoard, type SeededRound } from "./match-room-kit";

test.describe.configure({ mode: "parallel" });

/** What Match Day writes to the audit log with a video override (D11) - typed here from the product's own record of it. */
const OVERRIDE_NOTE = "Video unavailable: let this board play without video from Match Day.";

// Ten legal plies (an Italian): the rules judge them in roundGameSql. No capture among them.
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c2c3", "d7d6"];
/** FIDE: after N plies the move being played is floor(N/2) + 1. */
const moveBeingPlayed = (plies: number) => Math.floor(plies / 2) + 1;
/** FIDE: ply P belongs to move ceil(P/2). */
const moveOfPly = (ply: number) => Math.ceil(ply / 2);

// ── seeding ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const FOUR = () => [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"];

/** One online round of four (two boards), camera REQUIRED, round 1 open: what the Arbiter Panel's `seedRound` seeded. */
async function seedRound(request: Parameters<typeof seedOnlineRound>[0], names: string[] = FOUR(), opts: Parameters<typeof seedOnlineRound>[2] = {}): Promise<SeededRound> {
  return seedOnlineRound(request, names, { camera: "required", open: true, ...opts });
}

/** Both players of a board have ARRIVED: the room, the player on file in it, a counted check-in and a presence row (the loader's `joinable`). */
async function arrive(r: SeededRound, board: RoundBoard, sides: readonly ("home" | "away")[] = ["home", "away"]): Promise<void> {
  for (const side of sides) await putArrival(board.fixtureId, r.orgId, side, board[side].personId);
}

/** A room whose player has NOT arrived: the meeting row and the player's participant row, and nothing else (what a claim refused for its
 *  camera leaves). No check-in, no presence row. Returns the meeting id and the participant id. */
async function putPreMinted(fixtureId: string, orgId: string, side: "home" | "away", personId: string): Promise<{ meetingId: string; participantId: string }> {
  return withDb(async (sql) => {
    const meetingId = `e2e-mtg-${side}-${randomUUID().slice(0, 8)}`;
    const room = await sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      select f.id, ${side}, ${orgId}, ${meetingId}, f.home_entrant_id, f.away_entrant_id
        from fixtures f where f.id = ${fixtureId}`;
    expect(room.count, `pre-minted room ${side} for ${fixtureId}`).toBe(1);
    const participantId = `e2e-pp-${side}-${randomUUID().slice(0, 8)}`;
    const player = await sql`
      insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
      values (${fixtureId}, ${side}, ${personId}, 'player', ${participantId})`;
    expect(player.count, `the ${side} player on file for ${fixtureId}`).toBe(1);
    return { meetingId, participantId };
  });
}

/** The arrival SIGNALS, one at a time, for a side `putPreMinted` made: the counted check-in (the flag-off join's proof) and the presence row
 *  (the flag-on join's proof). */
async function stampCheckIn(fixtureId: string, orgId: string, personId: string): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      insert into fixture_availability (fixture_id, person_id, org_id, status, checked_in_at)
      values (${fixtureId}, ${personId}, ${orgId}, 'in', now())
      on conflict (fixture_id, person_id) do update set checked_in_at = now()`;
    expect(res.count, "the check-in").toBe(1);
  });
}
async function putPresence(fixtureId: string, side: "home" | "away", personId: string, room: { meetingId: string; participantId: string }): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, joined_at, source)
      values (${room.meetingId}, ${`e2e-peer-${side}-${randomUUID().slice(0, 8)}`}, ${fixtureId}, ${side}, ${room.participantId}, ${personId}, now(), 'webhook')`;
    expect(res.count, "the presence row").toBe(1);
  });
}

/** A board's two flags, in their producers' note formats: out-of-band play and a camera gap. */
async function flagBoard(orgId: string, board: RoundBoard): Promise<{ off: { from: string; to: string } }> {
  const from = new Date(Date.now() - 20 * 60_000);
  from.setUTCMilliseconds(0);
  const to = new Date(from.getTime() + 95_000);
  const off = { from: from.toISOString().replace(".000Z", "Z"), to: to.toISOString().replace(".000Z", "Z") };
  await withDb(async (sql) => {
    await sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
        (${board.fixtureId}, ${orgId}, 'out_of_band_play', null,
         ${`plies 2-5 (${LINE.slice(1, 5).join(" ")}) played at Lichess, not through Seazn; camera required`}),
        (${board.fixtureId}, ${orgId}, 'camera_lost', ${board.away.personId},
         ${`camera off 95 s of 1800 s in the match: ${off.from} to ${off.to} (its own off/on events agree); from 2 camera connections over 1 session; camera required`})`;
  });
  return { off };
}

// ── page vocabulary ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const decision = (page: Page) => page.getByTestId("arbiter-decision");
const status = (page: Page) => decision(page).getByRole("status");
const outage = (page: Page) => page.getByTestId("arbiter-outage");
const tiles = (page: Page) => page.getByTestId("md-camera-tile");
const tileOf = (page: Page, colour: "white" | "black") => page.locator(`[data-testid="md-camera-tile"][data-colour="${colour}"]`);
const wordOf = (page: Page, colour: "white" | "black") => tileOf(page, colour).getByTestId("md-camera-word");
/** A BOARD in focus. The default focus on a wide screen is a round (`data-online="round"`), so "no board opened" is no board panel, not no focus. */
const boardFocus = (page: Page) => page.locator('[data-testid="md-focus"][data-online="board"]');
const rowOf = (page: Page, board: RoundBoard) => page.locator(`[data-testid="md-board-row"][data-fixture-id="${board.fixtureId}"]`);
const roundRow = (page: Page, r: SeededRound, roundNo: number) => page.locator(`[data-testid="md-round-row"][data-key="${r.stageId}:${roundNo}"]`);

async function noSidewaysScroll(page: Page, widths: number[]): Promise<number> {
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, `no horizontal page scroll at ${width}px`).toBeLessThanOrEqual(client);
    checked += 1;
  }
  return checked;
}

/** Every button's WHOLE label is painted at each width - nothing cut short (a truncated label scrolls inside its own box). Counted. */
async function labelsFit(page: Page, buttons: Locator, widths: number[]): Promise<number> {
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    const boxes = await buttons.evaluateAll((els) => els.map((el) => ({ label: el.textContent ?? "", fits: el.scrollWidth <= el.clientWidth })));
    expect(boxes.length, `${width}px: premise, the buttons render`).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.fits, `${width}px: "${b.label}" shows all of its label`).toBe(true);
      checked += 1;
    }
  }
  return checked;
}

type Deferred = { promise: Promise<void>; release(): void };
const deferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>((res) => (release = res));
  return { promise, release };
};
type JoinAnswer = "mint" | { status: number; code: string };

/** The join route and the hand-back route, answered in the browser, in the order the browser sends. `log` is what the server side saw: a POST
 *  with its side and the participant it minted, and a DELETE should the browser ever send one. */
async function wire(page: Page, h: { post(side: "home" | "away", n: number): Promise<JoinAnswer> | JoinAnswer }): Promise<string[]> {
  const log: string[] = [];
  let posts = 0;
  await page.route(/\/external-play\/arbiter$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const { side } = route.request().postDataJSON() as { side: "home" | "away" };
    const n = (posts += 1);
    log.push(`POST ${side}`);
    const a = await h.post(side, n);
    if (a === "mint") {
      const participantId = `e2e-${side}-${n}`;
      log.push(`minted ${participantId}`);
      return route.fulfill({ json: { ok: true, data: { authToken: "e2e-not-a-token", participantId, side, players: [] } } });
    }
    return route.fulfill({ status: a.status, json: { ok: false, error: { code: a.code, message: a.code } } });
  });
  await page.route(/\/external-play\/arbiter\/[^/]+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const id = decodeURIComponent(route.request().url().split("/").pop()!);
    log.push(`DELETE ${id}`);
    await route.fulfill({ json: { ok: true, data: { removed: true } } });
  });
  return log;
}
const postsOf = (log: string[]) => log.filter((e) => e.startsWith("POST"));
const deletesOf = (log: string[]) => log.filter((e) => e.startsWith("DELETE"));

/** A new browser with no session: the cold visitor. */
async function coldContext(browser: Browser) {
  return browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: test.info().project.use.baseURL });
}

test.describe("Match Day online - the Arbiter Panel's sequences", () => {
  // ── the desktop run: run sheet -> Match Day -> two boards (old arbiter-panel.spec.ts L332) ────────────────────────────────────
  test("desktop: from the division's entry card to two boards - flags read, decisions sent, the outage let go and audited", async ({ page, request }) => {
    test.setTimeout(240_000);
    const r = await seedRound(request);
    const [b1, b2] = r.boards as [RoundBoard, RoundBoard];
    await roundGameSql(b1, { moves: LINE });
    await arrive(r, b1);
    await roundGameSql(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    const { off } = await flagBoard(r.orgId, b2);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    // The way in is the entry card (the run sheet's flag chips lead to the same page, so the link is found INSIDE the card and by its exact
    // name). Board 2 is held and flagged, so the card's one line is the count of boards that need a decision.
    const entry = page.getByTestId("arbiter-entry");
    await expect(entry.getByTestId("arbiter-entry-status")).toHaveText(fill("arbiter.column.queue.one", { count: 1 }), { timeout: 30_000 });
    await expect(entry.getByTestId("arbiter-entry-status")).toHaveAttribute("data-kind", "attention");
    await entry.getByRole("link", { name: uiEn["arbiter.entry.link"]!, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${r.matchDayPath}$`));

    // The boards, each with its own state; the list is home.
    const rows = page.getByTestId("md-board-row");
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    // T17B fix 2 (D7): every board row shows the hand - read from the cascade, counted.
    // The rows are buttons and Tailwind's preflight gives a button the arrow, so the hand is a class the row must carry; the round row too.
    const cursors = await page.locator('[data-testid="md-board-row"], [data-testid="md-round-row"]').evaluateAll((els) => els.map((el) => getComputedStyle(el).cursor));
    expect(cursors.length, "anti-vacuity: both boards and the round's row are read").toBeGreaterThanOrEqual(3);
    expect(cursors.every((c) => c === "pointer"), `the hand on each row, read from the cascade: ${cursors.join(",")}`).toBe(true);
    await expect(rowOf(page, b1)).toHaveAttribute("data-state", "live");
    await expect(rowOf(page, b1)).toContainText(b1.home.name);
    await expect(rowOf(page, b2)).toHaveAttribute("data-state", "on_hold");
    await expect(rowOf(page, b2)).toContainText(fill("matchDay.online.flags.other", { count: 2 }));

    // Board 1: live at move 6, required and begun: the sweep's camera report is still to come.
    await rowOf(page, b1).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b1.fixtureId);
    await expect(page.getByTestId("md-online-state")).toContainText(fill("matchDay.online.word.live", { n: moveBeingPlayed(LINE.length) }));
    await expect(page.getByTestId("md-board-flags").getByText(uiEn["arbiter.flag.pending.chip"]!)).toBeVisible();
    await expect(page.getByTestId("md-board-flag")).toHaveCount(0);
    // Video required, RealtimeKit down: the join's real refusal paints BOTH tiles and the outage card; there is never audio.
    await expect(outage(page)).toBeVisible({ timeout: 30_000 });
    await expect(tiles(page)).toHaveCount(2);
    for (const colour of ["white", "black"] as const) await expect(wordOf(page, colour)).toHaveText(uiEn["arbiter.tile.unavailable"]!, { timeout: 15_000 });
    await expect(page.locator("audio")).toHaveCount(0);

    // Resync reaches the route; the kit's tokens never open, so the route refuses LICHESS_TOKEN_UNAVAILABLE before any request to Lichess - and the
    // panel says THAT, in the reader's words (a retry does not fix it), not a generic "try again".
    const resync = page.waitForResponse((q) => q.request().method() === "POST" && q.url().endsWith(`/fixtures/${b1.fixtureId}/external-play/resync`));
    await decision(page).getByRole("button", { name: uiEn["arbiter.decide.resync"]! }).click();
    const refused = await resync;
    expect(refused.status()).toBe(503);
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code).toBe("LICHESS_TOKEN_UNAVAILABLE");
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.resyncTokenUnavailable"]!);
    // Board 1 has no flag: nothing to "go on" from.
    await expect(decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"]! })).toHaveCount(0);

    // Board 2: its flags, read from the producers' notes.
    await rowOf(page, b2).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b2.fixtureId);
    // The live region is always mounted (a region must exist before its text does); board 1's answer is not board 2's.
    await expect(status(page), "board 1's answer does not follow to board 2").toHaveText("");
    const flags = page.getByTestId("md-board-flags");
    await expect(flags.getByText(uiEn["arbiter.flag.outOfBand.chip"]!)).toBeVisible();
    await expect(flags.getByText(fill("arbiter.flag.outOfBand.range.other", { count: 4, from: moveOfPly(2), to: moveOfPly(5) }))).toBeVisible();
    await expect(
      flags.getByText(fill("arbiter.flag.cameraOff.chip", { off: fill("arbiter.duration.minSec", { min: 1, sec: 35 }), window: fill("arbiter.duration.min", { min: 30 }) })),
    ).toBeVisible();
    await expect(flags.getByText(`${b2.away.name}: off`)).toBeVisible();
    await expect(flags.getByText(uiEn["arbiter.flag.cameraOff.agree"]!)).toBeVisible();
    await expect(page.getByTestId("md-online-state")).toHaveText(new RegExp(`^${uiEn["matchDay.online.word.onHold"]}`));
    expect(off.from < off.to).toBe(true);

    // "Let the game go on" (D10): exactly the flags on screen are closed - kept on file under the organiser's name - and the game is untouched.
    await decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"]! }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.wentOn"]!);
    const kept = await withDb(
      (sql) => sql<{ closed: boolean; role: string | null }[]>`
        select f.closed_at is not null as closed, m.role from fixture_play_flags f
          left join org_members m on m.user_id = f.resolved_by and m.org_id = f.org_id
         where f.fixture_id = ${b2.fixtureId}`,
    );
    const organiser = expect.stringMatching(/^(owner|admin)$/);
    expect(kept, "both flags closed and kept on record, resolved by an organiser").toEqual([
      { closed: true, role: organiser },
      { closed: true, role: organiser },
    ]);
    await expect(decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"]! }), "nothing is left to go on from").toHaveCount(0);

    // "Settle the result now": a board with a game on file is settled HERE - four outcomes in a league, by colour from the row (White is the home side).
    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"]! });
    await settle.click();
    await expect(settle).toHaveAttribute("aria-expanded", "true");
    const choices = page.getByTestId("arbiter-settle").getByRole("button");
    await expect(choices).toHaveText([
      fill("externalPlay.settle.wins", { name: b2.home.name }),
      fill("externalPlay.settle.wins", { name: b2.away.name }),
      uiEn["externalPlay.resolve.draw"]!,
      uiEn["externalPlay.resolve.noResult"]!,
    ]);
    await choices.filter({ hasText: uiEn["externalPlay.resolve.draw"]! }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]!);
    const settled = await withDb(async (sql) => {
      const [row] = await sql<{ status: string; outcome: { kind?: string } | null }[]>`select status, outcome from fixtures where id = ${b2.fixtureId}`;
      return row!;
    });
    expect(settled.status).toBe("decided");
    expect(settled.outcome).toMatchObject({ kind: "draw" });

    // Back to board 1: let it play without video. One audit record, the organiser's, with Match Day's note; the cameras follow the refresh.
    await rowOf(page, b1).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b1.fixtureId);
    await expect(outage(page)).toBeVisible({ timeout: 30_000 });
    // Board 1 has had moves (roundGameSql above), so the card offers to let it CARRY ON (MD-R37), not the seating words.
    await outage(page).getByRole("button", { name: uiEn["arbiter.outage.ctaStarted"]! }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.overridden"]!);
    await expect(outage(page)).toHaveCount(0);
    await expect(page.getByTestId("md-board-cameras"), "let go without video: no cameras").toHaveCount(0, { timeout: 30_000 });
    // Let go, there is no camera report to wait for - and no flag on board 1.
    await expect(page.getByTestId("md-board-flags").getByText(uiEn["arbiter.flag.pending.chip"]!)).toHaveCount(0);
    const audit = await withDb(
      (sql) => sql<{ note: string; role: string | null }[]>`
        select a.note, m.role from online_chess_audit a
          left join org_members m on m.user_id = a.actor_user_id and m.org_id = a.org_id
         where a.fixture_id = ${b1.fixtureId} and a.kind = 'video_override'`,
    );
    expect(audit).toEqual([{ note: OVERRIDE_NOTE, role: expect.stringMatching(/^(owner|admin)$/) }]);

    // A link to one board opens on it.
    await page.goto(boardPanelUrl(r, b2.fixtureId));
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b2.fixtureId, { timeout: 30_000 });
  });

  // ── the phone: the list is home (old L477, "the board picker") ────────────────────────────────────────────────────────────────
  test("phone: the list is home and a board opens full-screen with its way back; the colour stays beside a 43-character name; no sideways scroll at 320, 768 or 1280", async ({ page, request }) => {
    test.setTimeout(240_000);
    const r = await seedRound(request, [longName(), longName(), "Bo Lindqvist", "Chen Wei"]);
    const [b1, b2] = r.boards as [RoundBoard, RoundBoard];
    await roundGameSql(b1, { moves: LINE });
    await arrive(r, b1);
    await roundGameSql(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await flagBoard(r.orgId, b2);

    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(r.matchDayPath);
    await expect(page.getByTestId("md-list")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("md-board-row"), "the picker is the list: a row per board").toHaveCount(2);
    await expect(boardFocus(page), "no board is open until a row is tapped").toHaveCount(0);
    const row = rowOf(page, b1);
    const rowBox = await row.boundingBox();
    expect(rowBox!.height, "a row is a 44px target").toBeGreaterThanOrEqual(44);

    await row.click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b1.fixtureId);
    await expect(page.getByTestId("md-list"), "below md the list gives way to the panel").toBeHidden();
    const back = page.getByTestId("md-back");
    expect((await back.boundingBox())!.height, "the way back is a 44px target").toBeGreaterThanOrEqual(44);
    // Board 1's White has a 43-character name: it truncates, its colour does not (on a phone the colour is the only word saying which tile is White).
    const colour = tileOf(page, "white").getByText(`· ${uiEn["arbiter.colour.white"]}`);
    await expect(colour).toBeVisible();
    const inside = await colour.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const tile = el.closest("figure")!.getBoundingClientRect();
      return { width: b.width, right: b.right, tileRight: tile.right };
    });
    expect(inside.width, "the colour is painted").toBeGreaterThan(0);
    expect(inside.right, "the colour is inside its tile, not clipped by the name").toBeLessThanOrEqual(inside.tileRight + 0.5);
    await expect(page.getByTestId("md-board-flags").getByText(uiEn["arbiter.flag.pending.chip"]!)).toBeVisible();

    await back.click();
    await expect(page.getByTestId("md-list")).toBeVisible();
    await rowOf(page, b2).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b2.fixtureId);
    await expect(page.getByTestId("md-board-flags").getByText(uiEn["arbiter.flag.outOfBand.chip"]!)).toBeVisible();
    await expect(decision(page)).toBeVisible();
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
  });

  // ── not ported: "the watch-only line" (old L515) ──────────────────────────────────────────────────────────────────────────────
  // The Arbiter Panel's `arbiter.watchOnly` header line (T17B fix 2, D4) has no counterpart in Match Day: the board panel has no header line that
  // says "watch only" at all. What a view-only member DOES see is proven where it lives: match-day-board-panel.spec.ts "a view-only member and the
  // organiser read the SAME flagged, held board" (flags stripped to kind and time, no reason, no decisions) and the cameras describe's "a
  // view-only member reads the same board and never asks the join route for anything".

  // ── settle (old L590, I-3) ────────────────────────────────────────────────────────────────────────────────────────────────────
  test("I-3: a league board settles No result as VOID; in a Swiss and on a knockout line No result is hidden and the settle says why; both players absent, a line that feeds a next match offers the double walkover and it is written", async ({ page, request }) => {
    test.setTimeout(300_000);
    const r = await seedRound(request, ["Ines Duarte", "Tomasz Wrona", longName(), "Chen Wei"]);
    const [b1, b2] = r.boards as [RoundBoard, RoundBoard];
    await roundGameSql(b1, { moves: LINE });
    await roundGameSql(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await flagBoard(r.orgId, b2);

    // A league board: the four outcomes, No result among them.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(boardPanelUrl(r, b1.fixtureId));
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b1.fixtureId, { timeout: 30_000 });
    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"]! });
    await settle.click();
    await expect(settle).toHaveAttribute("aria-expanded", "true");
    const choices = page.getByTestId("arbiter-settle").getByRole("button");
    await expect(choices).toHaveText([
      fill("externalPlay.settle.wins", { name: b1.home.name }),
      fill("externalPlay.settle.wins", { name: b1.away.name }),
      uiEn["externalPlay.resolve.draw"]!,
      uiEn["externalPlay.resolve.noResult"]!,
    ]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveCount(0);
    await choices.filter({ hasText: uiEn["externalPlay.resolve.noResult"]! }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]!);
    const voided = await withDb(async (sql) => {
      const [f] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${b1.fixtureId}`;
      const ledger = await sql<{ type: string; payload: unknown }[]>`select type, payload from score_events where fixture_id = ${b1.fixtureId} order by seq`;
      return { fixture: f!, ledger };
    });
    expect(voided.fixture, "VOID: abandoned, nobody's result").toEqual({ status: "abandoned", outcome: null });
    // Rebase ruling D3 (W2c): the organiser's No result IS the settle, so the abandon carries `noResult: true`.
    expect(voided.ledger, "the abandon, its reason the organiser's own decision, marked as their No result").toEqual([
      { type: "core.abandon", payload: { reason: uiEn["externalPlay.resolve.abandonReason.none"], noResult: true } },
    ]);
    // The panel reads it back as No result.
    await page.goto(boardPanelUrl(r, b1.fixtureId));
    await expect(page.getByTestId("md-online-state")).toHaveText(uiEn["matchDay.online.word.noResult"]!, { timeout: 30_000 });

    const winners = [fill("externalPlay.settle.wins", { name: b2.home.name }), fill("externalPlay.settle.wins", { name: b2.away.name })];
    const settleOn = async (fixtureId: string) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(boardPanelUrl(r, fixtureId));
      await expect(focus(page)).toHaveAttribute("data-fixture-id", fixtureId, { timeout: 30_000 });
      const open = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"]! });
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      return page.getByTestId("arbiter-settle").getByRole("button");
    };

    // A Swiss: the held board's stage a Swiss - a void would hold the next round up, so No result is hidden, and the settle says why.
    await withDb((sql) => sql`update stages set kind = 'swiss' where id = (select stage_id from fixtures where id = ${b2.fixtureId})`);
    const swissChoices = await settleOn(b2.fixtureId);
    await expect(swissChoices).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.swissNeedsResult"]!);
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the Swiss panel").toBe(3);

    // A knockout line that feeds a next match.
    const feeds = await withDb(async (sql) => {
      const [f] = await sql<{ stage_id: string; division_id: string; org_id: string }[]>`select stage_id, division_id, org_id from fixtures where id = ${b2.fixtureId}`;
      await sql`update stages set kind = 'knockout' where id = ${f!.stage_id}`;
      const [next] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
        values (${f!.stage_id}, ${f!.division_id}, ${f!.org_id}, 2, 1, ${`nx-${randomUUID().slice(0, 6)}`}, 'scheduled')
        returning id`;
      await sql`update fixtures set winner_to_fixture = ${next!.id} where id = ${b2.fixtureId}`;
      return sql<{ w: string | null }[]>`select winner_to_fixture as w from fixtures where id = ${b2.fixtureId}`;
    });
    expect(feeds[0]!.w, "premise: the line feeds a next match - not a final").not.toBeNull();
    const knockoutChoices = await settleOn(b2.fixtureId);
    await expect(knockoutChoices).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the knockout panel").toBe(3);

    // Both players absent: W2b's double walkover, wherever W2b takes one. On a FINAL W2b refuses it (D19), so it is hidden there - the knockout
    // sentence stands in its place.
    const next = feeds[0]!.w!;
    await withDb(async (sql) => {
      await sql`update fixture_external_play set needs_reason = 'no_show_both' where fixture_id = ${b2.fixtureId}`;
      await sql`update fixtures set winner_to_fixture = null where id = ${b2.fixtureId}`;
    });
    const onFinal = await settleOn(b2.fixtureId);
    await expect(onFinal).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);

    // On a line that feeds a next match it is offered, by its own name, and the settle writes it.
    await withDb((sql) => sql`update fixtures set winner_to_fixture = ${next} where id = ${b2.fixtureId}`);
    const choices3 = await settleOn(b2.fixtureId);
    await expect(choices3).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!, uiEn["externalPlay.resolve.doubleWalkover"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveCount(0);
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the panel offering the double walkover").toBe(3);
    // Every label is shown whole: the winners - one a 43-character name - each on a row of their own, wrapping, and the double walkover on its
    // own row too; at every width, counted.
    expect(await labelsFit(page, choices3, [320, 768, 1280]), "every settle button, at every width").toBe(4 * 3);
    await page.setViewportSize({ width: 1280, height: 900 });
    const dw = choices3.filter({ hasText: uiEn["externalPlay.resolve.doubleWalkover"]! });
    expect(await dw.evaluate((el) => el.scrollWidth <= el.clientWidth), "the double walkover label fits").toBe(true);
    await dw.click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]!);
    const walkedOver = await withDb(async (sql) => {
      const [f] = await sql<{ status: string; kind: string | null }[]>`select status, outcome->>'kind' as kind from fixtures where id = ${b2.fixtureId}`;
      const ledger = await sql<{ type: string; payload: unknown }[]>`select type, payload from score_events where fixture_id = ${b2.fixtureId} order by seq`;
      return { fixture: f!, ledger };
    });
    expect(walkedOver.fixture, "W2b's double walkover").toEqual({ status: "forfeited", kind: "double_walkover" });
    expect(walkedOver.ledger).toEqual([{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }]);
  });

  // The old column's "Review" path (a held board's card in the round column selecting its board in place) has no counterpart here: the round
  // panel carries no queue card. The way from a held board to its decision is the list's "Needs a decision" row and `?board=`, which every
  // settle above and match-day-board-panel.spec.ts drive.

  // ── I-4: a real knockout (old L746) ───────────────────────────────────────────────────────────────────────────────────────────
  test("I-4: on a real knockout, a winner clicked on the panel settles the board for that player, and the next match seats them", async ({ page, request }) => {
    test.setTimeout(180_000);
    const r = await seedOnlineRound(request, ["Amara Osei", "Bo Lindqvist", longName(), "Chen Wei"], { stage: "knockout", open: true });
    const b2 = r.boards[1]!;
    await roundGameSql(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    const read = () =>
      withDb(async (sql) => {
        const [f] = await sql<{ status: string; home: string; away: string; outcome: Record<string, unknown> | null; next: string | null; slot: number | null }[]>`
          select status, home_entrant_id as home, away_entrant_id as away, outcome, winner_to_fixture as next, winner_to_slot as slot
            from fixtures where id = ${b2.fixtureId}`;
        const [n] = f!.next === null ? [] : await sql<{ home: string | null; away: string | null }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${f!.next}`;
        return { board: f!, next: n ?? null };
      });
    const before = await read();
    expect(before.board.next, "premise: the generator wired this semi-final to a next match").not.toBeNull();
    expect([1, 2], "premise: and to one of its two seats").toContain(before.board.slot);
    // Slot 1 is the home seat, 2 the away (the schema's feed edge, as fed-seats.ts reads it).
    const seat = before.board.slot === 1 ? "home" : "away";
    expect(before.next![seat], "premise: that seat waits for this board's winner").toBeNull();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(boardPanelUrl(r, b2.fixtureId));
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b2.fixtureId, { timeout: 30_000 });
    const open = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"]! });
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    const choices = page.getByTestId("arbiter-settle").getByRole("button");
    // White is the home player (roundGameSql): the panel names White first. No result is not offered in a knockout.
    const blackWins = fill("externalPlay.settle.wins", { name: b2.away.name });
    await expect(choices).toHaveText([fill("externalPlay.settle.wins", { name: b2.home.name }), blackWins, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);
    // Black - the away player (White, at home, carries a 43-character name) - wins: the side the panel sends is the one it names.
    await choices.filter({ hasText: blackWins }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]!);

    const after = await read();
    expect(after.board.status, "decided").toBe("decided");
    expect(after.board.outcome, "for the player the organiser named").toMatchObject({ kind: "win", winner: before.board.away, loser: before.board.home });
    expect(after.next![seat], "the next match seats the winner").toBe(before.board.away);
    expect(after.next![seat === "home" ? "away" : "home"], "and only that seat: the other semi-final is still to play").toBe(before.next![seat === "home" ? "away" : "home"]);
  });

  // ── I2: leaving sends no DELETE (old L793) ────────────────────────────────────────────────────────────────────────────────────
  test("I2: leaving - a board switch, a view toggle, the tab going away - sends no DELETE at all; one join POST per meeting per open", async ({ page, request }) => {
    test.setTimeout(180_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1, b2] = r.boards as [RoundBoard, RoundBoard];
    await roundGameSql(b1, { moves: LINE });
    await roundGameSql(b2, { moves: LINE.slice(0, 4) });
    await arrive(r, b1);
    await arrive(r, b2);
    // The server's RealtimeKit is unreachable here, so the JOIN is answered in the browser (`wire`) with a token the real SDK cannot connect with:
    // the tile reads `error`, so no answer is ever KEPT and every open POSTs exactly once per meeting. What is proven is Match Day's half: it never
    // sends a hand-back. A DELETE is counted where the browser SENDS it - the context's request event, which sees a keepalive request issued while
    // the page unloads - never in a route handler, which can miss one.
    const log = await wire(page, { post: () => "mint" });
    const deletes: string[] = [];
    page.context().on("request", (req) => {
      if (req.method() === "DELETE" && /\/external-play\/arbiter\//.test(new URL(req.url()).pathname)) deletes.push(req.url());
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(boardPanelUrl(r, b1.fixtureId));
    await expect.poll(() => postsOf(log), { message: "board 1 open: one POST per meeting, White's side first" }).toEqual(["POST home", "POST away"]);
    // A board switch away: board 2's two meetings are POSTed, board 1's are left with nothing sent.
    await rowOf(page, b2).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b2.fixtureId);
    await expect.poll(() => postsOf(log), { message: "board 2 open: one POST per meeting" }).toHaveLength(4);
    // ...and back: nothing was kept (no connect ever succeeds here), so the return is one more POST per meeting of board 1.
    await rowOf(page, b1).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b1.fixtureId);
    await expect.poll(() => postsOf(log), { message: "back on board 1: one POST per meeting per open" }).toHaveLength(6);
    // A view toggle on a phone (Cameras | Board) is a view, not a leave: nothing is sent.
    await page.setViewportSize({ width: 390, height: 800 });
    const toggle = page.getByTestId("md-camera-switch").getByRole("button");
    await expect(toggle).toHaveCount(2);
    await toggle.nth(0).click();
    await toggle.nth(1).click();
    await page.waitForTimeout(700);
    expect(postsOf(log), "a view toggle joined nothing").toHaveLength(6);

    // The tab going away.
    await page.goto(r.fixturesTab);
    await page.waitForTimeout(700); // a stray hand-back would have been sent by now
    expect(postsOf(log).length, "anti-vacuity: the POSTs it did send (board 1 twice, board 2 once, two meetings each)").toBe(6);
    expect(deletesOf(log), "no DELETE reached the stub").toEqual([]);
    expect(deletes, "and none was ever sent by the browser: board switch, view toggle, tab away").toEqual([]);
  });

  // ── I3: a link to a board that is not here (old L835) ─────────────────────────────────────────────────────────────────────────
  test("I3: a ?board= that is not here opens nothing - never another board - and the list stays home, with no notice", async ({ page, request }) => {
    test.setTimeout(240_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    // Another division of the same organiser: its board is not THIS day's.
    const elsewhere = await seedRound(request, ["Eli Novak", "Fay Osei", "Gus Ito", "Hana Berg"]);
    await page.setViewportSize({ width: 1280, height: 900 });
    let checked = 0;
    for (const asked of [randomUUID(), elsewhere.boards[0]!.fixtureId, "not-a-board"]) {
      const res = await page.goto(`${r.matchDayPath}?board=${encodeURIComponent(asked)}`);
      expect(res!.status(), asked).toBe(200);
      await expect(page.getByTestId("md-board-row"), `${asked}: the list is on screen`).toHaveCount(r.boards.length, { timeout: 30_000 });
      await expect(boardFocus(page), `${asked}: no board opened in its place`).toHaveCount(0);
      // Ignored as an unknown ?court= is: the default focus (a round), no notice. The positive pair of the absence above.
      await expect(focus(page), `${asked}: the default focus answers instead`).toHaveAttribute("data-online", "round");
      await expect(page.getByTestId("md-lost"), `${asked}: ignored with no notice`).toHaveCount(0);
      checked++;
    }
    expect(checked).toBe(3);
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
    // The positive pair: the same address with a board that IS here opens it.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(boardPanelUrl(r, r.boards[1]!.fixtureId));
    await expect(focus(page)).toHaveAttribute("data-fixture-id", r.boards[1]!.fixtureId, { timeout: 30_000 });
  });

  // ── N1: a board of an earlier round (old L861) ────────────────────────────────────────────────────────────────────────────────
  test("N1: with round 2 open, a HELD board of round 1 and a board of round 2 each open from ?board= and wear their own round's chip; an untroubled board of round 1 is not offered", async ({ page, request }) => {
    test.setTimeout(180_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1, b2] = r.boards as [RoundBoard, RoundBoard];
    // Design 5.5: a board of an EARLIER round reaches Match Day only while it needs a decision (held or flagged), under "Needs a decision" with its
    // round chip. Board 1 is held; board 2 plays on untroubled, so once round 2 is the listed round it is not on the page at all.
    await roundGameSql(b1, { moves: LINE.slice(0, 6), hold: "mismatch" });
    // Round 2, opened a minute after round 1 (open-round's stamp, by SQL): its boards are the stage's own round-2 pairings.
    const next = await withDb(async (sql) => {
      await sql`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
        select o.stage_id, o.org_id, 2, o.opened_at + interval '1 minute', o.opened_by
          from stage_round_opens o join fixtures f on f.stage_id = o.stage_id and f.round_no = o.round_no
         where f.id = ${b1.fixtureId}`;
      return sql<{ id: string }[]>`
        select n.id from fixtures n join fixtures f on f.stage_id = n.stage_id
         where f.id = ${b1.fixtureId} and n.round_no = 2
           and n.home_entrant_id is not null and n.away_entrant_id is not null and n.status <> 'cancelled'
         order by n.seq_in_round`;
    });
    expect(next.length, "round 2 has paired boards").toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    let checked = 0;
    for (const [id, roundNo, label] of [
      [next[0]!.id, 2, "the current round's board"],
      [b1.fixtureId, 1, "the earlier round's board"],
    ] as const) {
      await page.goto(boardPanelUrl(r, id));
      await expect(focus(page), `${label}: it opens`).toHaveAttribute("data-fixture-id", id, { timeout: 30_000 });
      await expect(focus(page).getByTestId("md-round-chip"), `${label}: it names the round it belongs to`).toHaveAttribute("title", fill("matchDay.online.roundN", { n: roundNo }));
      checked += 1;
    }
    expect(checked, "anti-vacuity: both boards read").toBe(2);
    // The negative pair of the earlier round's board: round 1's other board is neither held nor flagged and is not the listed round's, so it is
    // "left the list" - the address is ignored (the default focus, never another board in its place).
    await page.goto(boardPanelUrl(r, b2.fixtureId));
    await expect(page.getByTestId("md-board-row").first(), "the list is on screen").toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-testid="md-board-row"][data-fixture-id="${b2.fixtureId}"]`), "the untroubled earlier board is not listed").toHaveCount(0);
    await expect(boardFocus(page), "and its address opens no board").toHaveCount(0);
    // Design 5.2: the stage lists its LATEST opened round, so round 1 is no row of its own; its held board is listed under the round's row (5.5).
    await expect(roundRow(page, r, 1), "round 1 is not a row of its own once round 2 is open").toHaveCount(0);
    await expect(roundRow(page, r, 2), "round 2 is the stage's row").toHaveCount(1);
    await expect(rowOf(page, b1), "the held board of round 1 is listed").toHaveCount(1);
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
  });

  // ── N3: a board the organiser plays on (old L912) ─────────────────────────────────────────────────────────────────────────────
  test("N3: a board the organiser plays on is left out of their list, ONE line says so, and it cannot be opened by address; an organiser who plays nowhere sees both and no line", async ({ browser, page, request }) => {
    test.setTimeout(180_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1, b2] = r.boards as [RoundBoard, RoundBoard];
    // The organiser who plays: board 1's home player, made an admin of the club, signed in on their own browser (the shared Pro user stays as is).
    await withDb((sql) => sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${b1.home.userId}, 'admin')`);
    const own = await coldContext(browser);
    try {
      const p = await own.newPage();
      await loginUi(p, b1.home.email);
      await p.setViewportSize({ width: 1280, height: 900 });
      await p.goto(r.matchDayPath);
      await expect(p.getByTestId("md-board-row"), "only the board they do not play on").toHaveCount(1, { timeout: 30_000 });
      await expect(rowOf(p, b2)).toHaveCount(1);
      await expect(rowOf(p, b1), "never the board they play on: not watchable, not offered").toHaveCount(0);
      // Design 6.4: the board is unlisted AND one line says so - in the list where the board would be (the List column only: no panel repeats it).
      const ownLine = uiEn["matchDay.online.ownHidden"]!;
      const listLine = p.getByTestId("md-online").getByTestId("md-own-hidden");
      await expect(listLine, "one line in the list").toHaveCount(1);
      await expect(listLine).toHaveText(ownLine);
      await expect(listLine, "and it is on screen, not folded away").toBeVisible();
      await expect(focus(p).getByTestId("md-own-hidden"), "the panel repeats nothing").toHaveCount(0);
      // By address too: a board the viewer plays on is never opened (not as another board either).
      await p.goto(boardPanelUrl(r, b1.fixtureId));
      await expect(p.getByTestId("md-board-row")).toHaveCount(1, { timeout: 30_000 });
      await expect(boardFocus(p), "the address of their own board opens nothing").toHaveCount(0);
      await expect(focus(p), "the default focus answers instead").toHaveAttribute("data-online", "round");
      await expect(p.getByTestId("md-own-hidden"), "the line is still there by address (the list's)").toHaveCount(1);
      expect(await noSidewaysScroll(p, [320, 768, 1280])).toBe(3);
    } finally {
      await own.close();
    }
    // The positive pair: the club's owner plays nowhere - both boards.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.matchDayPath);
    await expect(page.getByTestId("md-board-row")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("md-own-hidden"), "and no line: nothing is left out of their list").toHaveCount(0);
    await page.goto(boardPanelUrl(r, b1.fixtureId));
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b1.fixtureId, { timeout: 30_000 });
  });

  // ── no page for anyone else (old L943) ────────────────────────────────────────────────────────────────────────────────────────
  test("no Match Day for anyone else: signed out it is the sign-in; a competition with no online division has no online block", async ({ browser, page, request }) => {
    test.setTimeout(180_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const cold = await coldContext(browser);
    try {
      const anon = await cold.newPage();
      await anon.goto(r.matchDayPath);
      await expect(anon.getByTestId("md-online")).toHaveCount(0);
      expect(new URL(anon.url()).pathname, "signed out lands on the sign-in, not on the page").not.toBe(r.matchDayPath);
    } finally {
      await cold.close();
    }

    // An over-the-board chess division of the same organiser: nothing online to run.
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Match Day OTB ${TAG} ${randomUUID().slice(0, 4)}`,
      visibility: "public",
    });
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Over the board",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical" },
    });
    expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
    const path = await withDb(async (sql) => {
      const [row] = await sql<{ org: string; comp: string }[]>`
        select o.slug as org, c.slug as comp
          from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
         where d.id = ${div.data!.id}`;
      return `/o/${row!.org}/c/${row!.comp}/match-day`;
    });
    const res = await page.goto(path);
    expect(res!.status()).toBe(200);
    await expect(page.getByTestId("md-board-row")).toHaveCount(0);
    await expect(page.getByTestId("md-online"), "no online block for an over-the-board division").toHaveCount(0);
    // The positive pair: the online competition's page has its block.
    await page.goto(r.matchDayPath);
    await expect(page.getByTestId("md-online")).toHaveCount(1, { timeout: 30_000 });
  });

  // ── the Arbiter Panel's old `/arbiter` address (MD-R3: no redirect) is pinned in the unit suite
  //    src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/arbiter-route-gone.test.ts (the route file no longer exists).

  // ── D9: a flag card reads its times in the venue's zone (old L985) ────────────────────────────────────────────────────────────
  // The zone pair this test needs: the venue (Tokyo) and the browser (New York) are never at one UTC offset, whatever zone the runner is in,
  // so the "(Tokyo time)" label is always owed and a face in the wrong zone is always a different string.
  const VENUE_ZONE = "Asia/Tokyo";
  const VENUE_CITY = "Tokyo"; // IANA's own name for the zone, typed from the zone id, not derived by the page
  const BROWSER_ZONE = "America/New_York";
  test.describe("a flag card reads its times in the venue's zone", () => {
    test.use({ timezoneId: BROWSER_ZONE });
    // T17B fix 2, D9 (measured live): a player connected from more than one place at the same time in the match. The flag is the sweep's job-5
    // note, seeded in the producer's format. Here: the card the organiser reads after the game, at every width, and "Mark as reviewed" closing it.
    test("T17B fix 2 (D9): a finished board's 'more than one device at once' card - the count, when, and why; no sideways scroll at 320, 768 or 1280; Mark as reviewed closes it under the organiser's name", async ({ page, request }) => {
      test.setTimeout(240_000);
      const r = await seedRound(request, FOUR());
      const board = r.boards[0]!;
      await roundGameSql(board, { moves: LINE });
      // The game is over: its result through the organiser's own scoring API (what reconcile writes).
      const homeEntrant = await withDb(async (sql) => {
        const [row] = await sql<{ id: string }[]>`select home_entrant_id as id from fixtures where id = ${board.fixtureId}`;
        return row!.id;
      });
      for (const [seq, event] of [
        [0, { type: "core.start", payload: {} }],
        [1, { type: "boardgame.result", payload: { winner: homeEntrant, method: "resign" } }],
      ] as const) {
        const res = await apiJson(request, `/api/v1/fixtures/${board.fixtureId}/events`, "POST", { expected_seq: seq, ...event });
        expect(res.status, JSON.stringify(res.error)).toBeLessThan(300);
      }
      const from = new Date(Date.now() - 20 * 60_000);
      from.setUTCMilliseconds(0);
      const to = new Date(from.getTime() + 340_000);
      await withDb(
        (sql) => sql`
          insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
            (${board.fixtureId}, ${r.orgId}, 'multiple_devices', ${board.home.personId},
             ${`2 camera connections at once for 340 s in the match: ${from.toISOString()} to ${to.toISOString()}; camera required`})`,
      );
      // The venue's zone, on THIS division only (a division zone beats the org's, and the org is shared with other specs).
      await withDb(
        (sql) => sql`
          insert into schedule_settings (division_id, tz, config) values (${r.divisionId}, ${VENUE_ZONE}, '{}'::jsonb)
          on conflict (division_id) do update set tz = excluded.tz`,
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(boardPanelUrl(r, board.fixtureId));
      await expect(focus(page)).toHaveAttribute("data-fixture-id", board.fixtureId, { timeout: 30_000 });
      const flags = page.getByTestId("md-board-flags");
      await expect(flags.getByText(fill("arbiter.flag.devices.chip", { count: 2 }), { exact: true })).toBeVisible({ timeout: 30_000 });
      // The card prints a time of day in the VENUE's zone, and names the venue after each one when the viewer's own UTC offset differs
      // ("15:56:10 (Tokyo time)"). The venue here is Tokyo and the browser is pinned to New York (describe above), so the two faces differ and the
      // test can tell them apart: the face worked out here, by Intl in the runner, in the VENUE's zone, with the dictionary's own label; and a
      // face read in the browser's zone must NOT be on the page.
      const browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(browserZone, "the browser is pinned to a zone other than the venue's").toBe(BROWSER_ZONE);
      const faceIn = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone }).format(at);
      const [vFrom, vTo] = [faceIn(from, VENUE_ZONE), faceIn(to, VENUE_ZONE)];
      const [bFrom, bTo] = [faceIn(from, BROWSER_ZONE), faceIn(to, BROWSER_ZONE)];
      expect([vFrom, vTo], "anti-vacuity: the venue's faces differ from the browser's, so a browser-zone face cannot pass").not.toEqual([bFrom, bTo]);
      expect(vFrom, "a face is HH:MM:SS").toMatch(/^\d{2}:\d{2}:\d{2}$/);
      const named = (face: string) => fill("arbiter.venueTime", { time: face, city: VENUE_CITY });
      const spansIn = (a: string, b: string) => fill("arbiter.flag.cameraOff.span", { from: named(a), to: named(b) });
      await expect(flags.getByText(fill("arbiter.flag.devices.spans", { name: board.home.name, count: 2, spans: spansIn(vFrom, vTo) }))).toBeVisible();
      await expect(
        flags.getByText(fill("arbiter.flag.devices.spans", { name: board.home.name, count: 2, spans: spansIn(bFrom, bTo) })),
        "the browser's own face is not what the page prints",
      ).toHaveCount(0);
      await expect(flags.getByText(uiEn["arbiter.flag.devices.why"]!)).toBeVisible();
      expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);

      await page.setViewportSize({ width: 1280, height: 900 });
      const review = decision(page).getByRole("button", { name: uiEn["externalPlay.queue.markReviewed"]! });
      await expect(review).toBeVisible();
      await review.click();
      await expect(status(page)).toHaveText(uiEn["externalPlay.queue.reviewed"]!);
      const kept = await withDb(
        (sql) => sql<{ kind: string; closed: boolean; role: string | null }[]>`
          select f.kind, f.closed_at is not null as closed, m.role from fixture_play_flags f
            left join org_members m on m.user_id = f.resolved_by and m.org_id = f.org_id
           where f.fixture_id = ${board.fixtureId}`,
      );
      expect(kept, "closed and kept on record, resolved by an organiser").toEqual([{ kind: "multiple_devices", closed: true, role: expect.stringMatching(/^(owner|admin)$/) }]);
      await expect(flags.getByText(fill("arbiter.flag.devices.chip", { count: 2 }), { exact: true })).toHaveCount(0);
    });
  });

  // ── D16 (spec 6.1 "Cameras"): the phone's Cameras | Board switch at every width (old L1121, "the switch at ${width}") ─────────────
  // The Arbiter Panel showed ONE player's camera at a time with a White | Black switch; Match Day shows BOTH tiles (each meeting its own join),
  // and the only switch left is the phone's view toggle - Cameras | Board - below lg. So the per-width question changed with the product:
  // at 1280 there is no switch (both tiles and the board are on screen together); at 768 and 320 there is, and it is a 44px target, hit-tested,
  // reachable by keyboard, and pressing it is a VIEW change that sends no DELETE and joins nothing again.
  for (const width of [1280, 768, 320] as const) {
    test(`the switch at ${width}: ${width >= 1024 ? "none from lg - both tiles and the board together" : "Cameras | Board is a 44px hit-tested target and a view change, not a leave"}; one join per meeting per open, no DELETE`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
      const [b1] = r.boards as [RoundBoard, RoundBoard];
      await roundGameSql(b1, { moves: LINE });
      await arrive(r, b1);
      const log = await wire(page, { post: () => "mint" });
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 700 });
      await page.goto(boardPanelUrl(r, b1.fixtureId));
      // The real loader's `sides` through the real page: White plays the home side, so THAT meeting is asked for first, then Black's.
      await expect.poll(() => log.slice(), { message: "one join per meeting, White's first" }).toEqual(["POST home", "minted e2e-home-1", "POST away", "minted e2e-away-2"]);
      await expect(tiles(page)).toHaveCount(2);
      await expect(tileOf(page, "white")).toContainText(b1.home.name);
      await expect(tileOf(page, "black")).toContainText(b1.away.name);
      for (const colour of ["white", "black"] as const) {
        await expect(wordOf(page, colour), "the minted token cannot connect: the tile says so").toHaveText(uiEn["arbiter.tile.error"]!);
      }
      const sw = page.getByTestId("md-camera-switch");
      if (width >= 1024) {
        await expect(sw, "from lg the board and the cameras are both on screen: no switch").toBeHidden();
        await expect(page.getByTestId("md-board-position")).toBeVisible();
        await expect(page.getByTestId("md-board-cameras")).toBeVisible();
      } else {
        const buttons = sw.getByRole("button");
        await expect(buttons).toHaveCount(2);
        await expect(buttons.nth(0)).toContainText(uiEn["matchDay.cameras.viewCameras"]!);
        await expect(buttons.nth(1)).toContainText(uiEn["matchDay.cameras.viewBoard"]!);
        // The target a person touches: at least 44 px tall and hit-tested - the centre of each button is the button.
        let hit = 0;
        for (const mode of ["cameras", "board"] as const) {
          const el = sw.locator(`[data-mode="${mode}"]`);
          await el.scrollIntoViewIfNeeded();
          const box = (await el.boundingBox())!;
          expect(box.height, `${mode}: tall enough at ${width}`).toBeGreaterThanOrEqual(44);
          expect(box.width, `${mode}: wide enough at ${width}`).toBeGreaterThanOrEqual(44);
          const probe = await el.evaluate((node) => {
            const b = node.getBoundingClientRect();
            const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            return { owns: top !== null && node.contains(top), covered: top === null ? "nothing" : top.outerHTML.slice(0, 160) };
          });
          expect(probe.owns, `${mode}: elementFromPoint at its centre is the button (found ${probe.covered})`).toBe(true);
          hit += 1;
        }
        expect(hit).toBe(2);
        // Exactly one view is pressed, and the other is hidden below lg: a live board with both players here opens on the cameras it is watching.
        const pressed = async () => buttons.evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")));
        expect((await pressed()).filter((p) => p === "true").length, "one view is on").toBe(1);
        const press = async (mode: "cameras" | "board") => {
          await sw.locator(`[data-mode="${mode}"]`).click();
          await expect(sw.locator(`[data-mode="${mode}"]`)).toHaveAttribute("aria-pressed", "true");
        };
        await press("board");
        await expect(page.getByTestId("md-board-position")).toBeVisible();
        await expect(page.getByTestId("md-board-cameras"), "Board: the cameras give way").toBeHidden();
        await press("cameras");
        await expect(page.getByTestId("md-board-cameras")).toBeVisible();
        await expect(page.getByTestId("md-board-position"), "Cameras: the board gives way").toBeHidden();
        // The KEYBOARD: Enter and Space both press it.
        await sw.locator('[data-mode="board"]').focus();
        await page.keyboard.press("Enter");
        await expect(sw.locator('[data-mode="board"]')).toHaveAttribute("aria-pressed", "true");
        await sw.locator('[data-mode="cameras"]').focus();
        await page.keyboard.press("Space");
        await expect(sw.locator('[data-mode="cameras"]')).toHaveAttribute("aria-pressed", "true");
      }
      await page.waitForTimeout(700);
      expect(log, "the whole conversation, in order: two POSTs, two mints, no DELETE - a view toggle is not a leave").toEqual(["POST home", "minted e2e-home-1", "POST away", "minted e2e-away-2"]);
      expect(postsOf(log).length, "anti-vacuity: the POSTs it did send").toBe(2);
      expect(deletesOf(log).length).toBe(0);
      expect(await noSidewaysScroll(page, [width])).toBe(1);
    });
  }

  // ── a side whose player has not arrived (old L1225, "a pre-minted room") ─────────────────────────────────────────────────────
  test("a side whose player has not arrived (a pre-minted room): its tile says so and NO join is POSTed across two polls; the join opens on the poll after the arrival signal; a NOT_STARTED refusal is asked again on the next poll; a closed room says it is closed", async ({ page, request }) => {
    test.setTimeout(240_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1, b2] = r.boards as [RoundBoard, RoundBoard];
    await roundGameSql(b1, { moves: LINE });
    await roundGameSql(b2, { moves: LINE.slice(0, 4) });
    // Board 1: only White's player (home) has checked in. Board 2: nobody has, but its home player's room was pre-minted (a claim refused for its camera).
    await arrive(r, b1, ["home"]);
    const preMinted = await putPreMinted(b2.fixtureId, r.orgId, "home", b2.home.personId);
    let refuseOnce = false;
    const log = await wire(page, {
      post: () => {
        if (!refuseOnce) return "mint";
        refuseOnce = false;
        return { status: 409, code: "VIDEO_MEETING_NOT_STARTED" };
      },
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(boardPanelUrl(r, b1.fixtureId));
    await expect.poll(() => log.slice()).toEqual(["POST home", "minted e2e-home-1"]);
    // The empty side: its tile says "Not checked in", and nothing was asked of it.
    await expect(wordOf(page, "black")).toHaveText(uiEn["arbiter.tile.notCheckedIn"]!);
    await expect(tileOf(page, "black")).toHaveAttribute("data-view", "notStarted");
    await expect(tileOf(page, "white")).not.toHaveAttribute("data-view", "notStarted");
    await page.waitForTimeout(700);
    expect(log, "a side with no room joins nothing and leaves nothing").toEqual(["POST home", "minted e2e-home-1"]);

    // Board 2: its home player's room is on file with the player's participant and NOTHING else. BOTH tiles say "Not checked in"; Match Day makes
    // no room and no join is POSTed - across two polls.
    await rowOf(page, b2).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b2.fixtureId);
    for (const colour of ["white", "black"] as const) await expect(wordOf(page, colour)).toHaveText(uiEn["arbiter.tile.notCheckedIn"]!);
    for (let i = 0; i < 2; i += 1) {
      await refreshNow(page);
      await page.waitForTimeout(700);
    }
    expect(log, "leaving board 1 sends nothing; a pre-minted side is not joined, poll after poll").toEqual(["POST home", "minted e2e-home-1"]);
    expect(postsOf(log), "no join for a board whose player has not arrived").toHaveLength(1);

    // The player arrives. The signal is the server's flag state: with the proof flag on (CI's server) the presence row, after first showing that a
    // counted check-in ALONE does not open the join; with it off (the local recipe) the check-in alone.
    const proofOn = process.env.EXTERNAL_PLAY_PRESENCE_PROOF === "1";
    if (proofOn) {
      await stampCheckIn(b2.fixtureId, r.orgId, b2.home.personId);
      await refreshNow(page);
      await page.waitForTimeout(700);
      expect(postsOf(log), "flag on: a check-in alone is not presence - still no join").toHaveLength(1);
      await putPresence(b2.fixtureId, "home", b2.home.personId, preMinted);
    } else {
      await stampCheckIn(b2.fixtureId, r.orgId, b2.home.personId);
    }
    // The next poll (a hidden tab coming back refreshes at once) marks the side joinable and the join opens with NO press.
    await refreshNow(page);
    await expect.poll(() => postsOf(log).length, { timeout: 30_000 }).toBe(2);
    expect(log.at(-2)).toBe("POST home");
    await expect(tileOf(page, "black"), "the other player has still not arrived").toHaveAttribute("data-view", "notStarted");

    // The re-open: a join the server refuses NOT_STARTED even though the loader marked the side joinable is asked again on the next poll. Forced
    // through a board switch away and back (a new join key), the next POST answered 409 once.
    await rowOf(page, b1).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b1.fixtureId);
    await expect.poll(() => postsOf(log).length, { timeout: 30_000 }).toBe(3);
    refuseOnce = true;
    await rowOf(page, b2).click();
    await expect(focus(page)).toHaveAttribute("data-fixture-id", b2.fixtureId);
    await expect.poll(() => postsOf(log).length, { timeout: 30_000 }).toBe(4);
    await expect(tileOf(page, "white"), "the refused join reads not started").toHaveAttribute("data-view", "notStarted");
    await refreshNow(page);
    await expect.poll(() => postsOf(log).length, { timeout: 30_000, message: "ONE poll later the join is POSTed again, with no press" }).toBe(5);
    expect(deletesOf(log), "no DELETE in the whole test").toHaveLength(0);

    // A room that has been closed is said so: ended, not "has not arrived".
    await withDb((sql) => sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${b2.fixtureId} and side = 'home'`);
    await refreshNow(page);
    await expect(tileOf(page, "white")).toHaveAttribute("data-view", "ended", { timeout: 30_000 });
    await expect(wordOf(page, "white")).toHaveText(uiEn["arbiter.tile.over"]!);
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
  });

  // ── a pairing card swaps the colours after a player has arrived (old L1323) ───────────────────────────────────────────────────
  test("a colour swap after a player has arrived: the labels move with the PERSON, the tile stays on the same player's room, and nothing is joined or left", async ({ page, request }) => {
    test.setTimeout(180_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1] = r.boards as [RoundBoard, RoundBoard];
    await roundGameSql(b1, { moves: LINE }); // white_side = home
    // Only the home player (White) has arrived.
    await arrive(r, b1, ["home"]);
    const log = await wire(page, { post: () => "mint" });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(boardPanelUrl(r, b1.fixtureId));
    await expect.poll(() => log.slice()).toEqual(["POST home", "minted e2e-home-1"]);
    await expect(tileOf(page, "white")).toContainText(b1.home.name);
    await expect(tileOf(page, "white")).toHaveAttribute("data-side", "home");

    // The colours swap (the bridge row's white_side is what the board lists read first).
    await withDb((sql) => sql`update fixture_external_play set white_side = 'away' where fixture_id = ${b1.fixtureId}`);
    await refreshNow(page);
    await expect(tileOf(page, "black")).toContainText(b1.home.name, { timeout: 30_000 });
    await expect(tileOf(page, "black"), "the same person, the other colour, the same meeting").toHaveAttribute("data-side", "home");
    await expect(tileOf(page, "white")).toContainText(b1.away.name);
    await expect(tileOf(page, "white")).toHaveAttribute("data-side", "away");
    // The room did not move: still the home player's, no leave, no new join.
    await page.waitForTimeout(700);
    expect(log, "a relabel is not a switch").toEqual(["POST home", "minted e2e-home-1"]);
    // And the reason follows the person: the away player (White now) has not arrived.
    await expect(wordOf(page, "white")).toHaveText(uiEn["arbiter.tile.notCheckedIn"]!);
  });
});

// ─── the round panel (old "arbiter round column" describe, L1369-1884) ────────────────────────────────────────────────────────────────
// online-chess-desk.spec.ts and checkin-extend.spec.ts drive the same panel through the full Open round, the invite words and the +5 presses;
// these are the sequences they do not: an Open from a page made stale, and the panel's own state across a change of round.
test.describe("Match Day online - the round panel's sequences", () => {
  test('"already open" from a stale page: the press answers already_open, queues nothing, and the panel then shows the truth', async ({ page, request }) => {
    test.setTimeout(budgetFor(1, 240_000));
    const names = [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"];
    const BOARDS_ASKED = names.length / 2;
    const seatCount = BOARDS_ASKED * 2;
    const r = await seedOnlineRound(request, names, { open: false });
    const ids = r.boards.map((b) => b.fixtureId);
    expect(r.boards.length, "premise: four players pair into two boards").toBe(BOARDS_ASKED);
    expect(r.boards.flatMap((b) => [b.home, b.away]).length, "premise: a board seats two, so the seeded seats are the seats asked for").toBe(seatCount);
    const posts = watchOpenRoundPosts(page, r.stageId);
    await page.setViewportSize({ width: 1280, height: 900 });
    // The day with nothing live polls at the quiet period (QUIET_POLL_MS). The test is stale only while that poll has not fired, so the clock
    // starts at the load and the premise below is checked twice: before the press and after the confirm. A slow run fails here BY NAME, instead of
    // flaking on a panel that quietly refreshed itself.
    const QUIET_SLACK_MS = 30_000;
    const loadedAt = Date.now();
    const stillStale = (when: string) =>
      expect(Date.now() - loadedAt, `premise (${when}): the quiet poll (${QUIET_POLL_MS} ms) has not fired, so the page is still stale`).toBeLessThan(QUIET_POLL_MS - QUIET_SLACK_MS);
    await openRoundPanel(page, r, "before");
    const cta = page.getByTestId("md-round-open-cta");
    await expect(cta).toBeVisible();

    // Elsewhere (another tab, a second organiser) the round is opened, and every seat's mail is on its way: nobody is left to invite. The page in
    // front of the organiser has not heard (see the clock above).
    const opened = await apiJson(request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo: 1 });
    expect(opened.status, `open-round: ${JSON.stringify(opened.error)}`).toBeLessThan(300);
    for (const b of r.boards) for (const colour of ["white", "black"] as const) await seedSeatInvite(b.fixtureId, colour, "sent");
    const rowsBefore = await inviteRowCount(ids);
    expect(rowsBefore, "the other open queued one row per player's address").toBe(seatCount);
    await expect(focus(page), "premise: the page is stale, it still says the round is not opened").toHaveAttribute("data-state", "before");

    await recordOpenNotices(page);
    stillStale("before the press");
    await cta.click();
    const sent = openRoundSent(page, r.stageId);
    await page.getByTestId("md-round-confirm-confirm").click();
    stillStale("after the confirm");
    const res = await sent;
    expect(res.status()).toBeLessThan(300);
    const answer = ((await res.json()) as { data: { opened: boolean; reason?: string; skipped: unknown[] } }).data;
    expect(answer, "the route answered that the round is already open, with nobody to invite").toEqual({ opened: false, reason: "already_open", skipped: [] });
    // The refresh that follows flips the panel to check-in and takes the block, and its notice, away: the notice is read as it was drawn.
    await expect(focus(page)).toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
    const drawn = await recordedOpenNotices(page);
    expect(drawn, "the observer survived the flip (the page did not navigate)").not.toBeNull();
    expect(drawn!.at(-1), "the notice read: already open").toEqual([uiEn["externalPlay.openRound.alreadyOpen"]]);
    expect(posts.roundNos(), "one press, one request").toEqual([1]);
    expect(await inviteRowCount(ids), "the stale press queued nothing").toBe(rowsBefore);
    // And the page now shows the truth the press answered: every seat holds a mail, so nobody is owed and the panel has no press.
    await expectSeatWord(page, r.boards[0]!, "white", "sent");
    await expect(page.getByTestId("arbiter-column-reinvite"), "nobody is owed").toHaveCount(0);
  });

  test("a change of round while a confirmation is open: the confirmation does not follow, a press targets the round on screen, and a held answer for the old round draws nothing under the new one", async ({ page, request }) => {
    test.setTimeout(budgetFor(0, 300_000));
    // A league pairs every round at Generate; three rounds of four players. Match Day lists the stage's LATEST opened round and the rounds paired
    // and not opened (design 5.2): with round 1 open, rounds 2 and 3 are "before" rows, each with its own panel. Round 1 is
    // opened through the route; rounds 2 and 3 are opened by "another organiser" (the route again) while the page is open.
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"], { open: true });
    const posts = watchOpenRoundPosts(page, r.stageId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRoundPanel(page, r, "checkin", 1);
    // The panel's block has no heading of its own: the section carries the round's name as its aria-label.
    const heading = (round: number) => focus(page).locator(`[aria-label="${fill("runsheet.round.heading", { round })}"]`);
    const press = page.getByTestId("arbiter-column-reinvite");
    const dialog = page.getByTestId("arbiter-column-reinvite-dialog");
    const confirm = page.getByTestId("arbiter-column-reinvite-dialog-confirm");
    const notice = page.getByTestId("arbiter-column-reinvite-notice");
    const goTo = async (roundNo: number) => {
      // The row of a round that only just became openable arrives on the shell's next read: bring it in now.
      await refreshNow(page);
      await expect(roundRow(page, r, roundNo), `round ${roundNo} is a row`).toBeVisible({ timeout: 30_000 });
      await roundRow(page, r, roundNo).click();
      await expect(focus(page), `round ${roundNo} is the panel on screen`).toHaveAttribute("data-key", `${r.stageId}:${roundNo}`, { timeout: 15_000 });
    };

    // A: a confirmation is open for round 1. It is a modal, so the organiser cannot walk to another round with it open; what CAN happen is the round
    // changing under it: another organiser opens round 2 (through the route, not through this page), and the shell's next read lists round 2 as the
    // stage's round and round 1 no longer. The confirmation goes with its round and nothing is sent.
    await expect(heading(1).first(), "round 1 is the round on screen").toBeVisible();
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 1 }));
    const opened2 = await apiJson(request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo: 2 });
    expect(opened2.status, `open round 2: ${JSON.stringify(opened2.error)}`).toBeLessThan(300);
    await refreshNow(page);
    await expect(dialog, "the confirmation for round 1 did not survive the round changing").toHaveCount(0, { timeout: 30_000 });
    await expect(roundRow(page, r, 1), "round 1 is no longer a row of its own: the stage lists its latest opened round").toHaveCount(0);
    expect(posts.roundNos(), "the abandoned confirmation sent nothing").toEqual([]);
    await goTo(2);
    await expect(focus(page), "round 2 is open").toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
    await expect(heading(2).first(), "round 2 is the round on screen").toBeVisible();
    // The positive pair of the last check below: a re-open pressed on round 2's own panel draws its answer there, and asks for round 2, not for
    // the round that was confirmed before.
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 2 }));
    await confirm.click();
    await expect(notice, "round 2's re-open answered under round 2").toBeVisible({ timeout: 30_000 });
    expect(posts.roundNos(), "the press asked for round 2").toEqual([2]);

    // B: round 2's answer is held on its way BACK (the server does the work at once, only the ANSWER waits at the gate), the organiser moves to
    // round 3 and confirms THERE: one request, for round 3, goes at once (the panels are separate, so no old request stands in its way), and the
    // held answer, once released, draws nothing under round 3.
    const gate = deferred();
    let seen = 0;
    let round2Done = false;
    await page.route(new RegExp(`/stages/${r.stageId}/open-round$`), async (route) => {
      seen += 1;
      if (seen !== 1) {
        await route.continue();
        return;
      }
      const answered = await route.fetch();
      round2Done = true;
      await gate.promise;
      await route.fulfill({ response: answered });
    });
    // Round 2's request only: round 3's own answer, which arrives first, must not stand for it.
    const heldAnswer = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().includes(`/stages/${r.stageId}/open-round`) && (res.request().postDataJSON() as { roundNo?: number } | null)?.roundNo === 2,
      { timeout: 60_000 },
    );
    let answered = false;
    heldAnswer.then(
      () => {
        answered = true;
      },
      () => {},
    );
    // Round 2 is open now, so its panel carries the re-open press: the second press for round 2, whose answer is held.
    await goTo(2);
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 2 }));
    await confirm.click();
    await expect.poll(() => posts.roundNos(), { message: "the second press for round 2 is out, held at the network" }).toEqual([2, 2]);
    expect(seen, "the route held exactly one request: the press for round 2 made after it was set").toBe(1);
    await expect.poll(() => round2Done, { message: "the server has done round 2's press; only its answer is held" }).toBe(true);
    expect(answered, "the held request has not been answered").toBe(false);
    // Round 2's confirmation is a modal that stays busy until its answer, so the organiser cannot click away: what happens is another organiser
    // opening round 3 (through the route) while the answer is held. The stage then lists round 3 and round 2 no longer; round 2's panel, busy
    // confirmation and all, goes with it.
    const opened3 = await apiJson(request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo: 3 });
    expect(opened3.status, `open round 3: ${JSON.stringify(opened3.error)}`).toBeLessThan(300);
    await refreshNow(page);
    await expect(dialog, "round 2's confirmation (busy) is gone with its panel").toHaveCount(0, { timeout: 30_000 });
    await goTo(3);
    await expect(focus(page), "round 3 is open").toHaveAttribute("data-state", "checkin", { timeout: 30_000 });
    await expect(heading(3).first(), "round 3 is the round on screen").toBeVisible();
    // Round 3's own press: one request, for round 3, goes at once while round 2's answer is still held.
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 3 }));
    await confirm.click();
    await expect.poll(() => posts.roundNos(), { message: "round 3's press goes at once, with round 2's answer still held" }).toEqual([2, 2, 3]);
    await expect(notice, "round 3's own answer").toBeVisible({ timeout: 30_000 });
    expect(answered, "round 2's answer was still held while round 3 answered").toBe(false);
    gate.release();
    await heldAnswer;
    expect(answered, "the held request is answered once released").toBe(true);
    await page.waitForTimeout(700);
    await expect(focus(page), "round 3 stays on screen").toHaveAttribute("data-key", `${r.stageId}:3`);
    await expect(notice, "round 2's answer shows nothing under round 3: only round 3's own notice is there").toHaveCount(1);
    await expect(heading(3).first(), "round 3 is still the round on screen").toBeVisible();
    expect(posts.roundNos(), "round 2's two presses, then exactly one for round 3").toEqual([2, 2, 3]);
    expect(seen, "the route saw the held request and round 3's one request, nothing else").toBe(2);
  });
});
