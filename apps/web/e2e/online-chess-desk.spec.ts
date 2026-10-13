/**
 * T16 — the organiser's and the spectator's online-chess surfaces, in a
 * browser, against the real server:
 *
 *  - the Open round control (D12): a round PAIRED and not opened, the
 *    confirmation that names who it invites, and every pairing invited after;
 *  - the online-play queue: a held board settled from it, a flagged board let
 *    go on — and the run sheet's chips that point at both;
 *  - Unpair refused while a game is on file, with the way to the arbiter panel;
 *  - "Your board": a signed-in player's door into their room, nobody else's;
 *  - the public watch panel: the game's position, view-only, kept current by
 *    the poll, and the not-opened line before the round opens;
 *  - /me's Lichess card for an entered player who is not linked.
 *
 * The organiser's half goes through the product (match-room-kit.ts:
 * seedOnlineRound / seedMatchRoom). What no API writes is seeded by SQL, and
 * each says why: the players' Lichess links (an OAuth trip to lichess.org),
 * a game's ledger (made at Lichess by T9/T10; the kit writes it the way they
 * leave it), and fair-play flags (their producers need a game moving at
 * Lichess and a RealtimeKit meeting — the producer → loader read is vitest's,
 * external-play-flagged-and-run-sheet.test.ts).
 *
 * Expected copy comes from the dictionary, expected positions from the rules
 * (chess.js) — never from the code under test.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Chess } from "chess.js";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "../src/lib/consent";
import { loginUi, withDb } from "./helpers";
import {
  fill,
  longName,
  roundGameSql,
  seedGameSql,
  seedMatchRoom,
  seedOnlineRound,
  uiEn,
  type RoundBoard,
  type SeededRound,
} from "./match-room-kit";

test.describe.configure({ mode: "parallel" });

/** Captures for the visual sign-off, only when asked for, never committed. */
const SHOTS = process.env.DESK_SHOTS_DIR;

/** The watch panel's poll interval, read from its source (a client module this
 *  runner cannot import): a budget derived from the constant moves with it. */
const POLL_MS = (() => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/components/public-site/match-centre/use-live-fixture.ts", import.meta.url)),
    "utf8",
  );
  const m = /export const POLL_MS = ([\d_]+);/.exec(src);
  if (!m) throw new Error("online-chess-desk: POLL_MS not found in use-live-fixture.ts");
  return Number(m[1]!.replaceAll("_", ""));
})();

// Eight legal plies (an Italian). The rules judge them in the kit.
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6"];

const vs = (a: string, b: string) => `${a} ${uiEn["schedule.vs"]} ${b}`;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 768 ? 1024 : 700 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`), fullPage: true, caret: "initial" });
  }
  if (original) await page.setViewportSize(original);
}

async function noSidewaysScroll(page: Page, widths = [320, 768, 1280]): Promise<number> {
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, `no horizontal page scroll at ${width}px`).toBeLessThanOrEqual(client);
    checked += 1;
  }
  return checked;
}

/** A fresh context: no session — a stranger opening a shared link. */
async function cold(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: test.info().project.use.baseURL });
  if (SHOTS) {
    // A capture run draws the surface, not the site's cookie notice.
    await ctx.addInitScript(
      (a: { k: string; vk: string; v: string }) => {
        try {
          window.localStorage.setItem(a.k, "rejected");
          window.localStorage.setItem(a.vk, a.v);
        } catch {
          // storage refused: the notice shows, the capture still runs
        }
      },
      { k: CONSENT_KEY, vk: CONSENT_VERSION_KEY, v: COOKIE_POLICY_VERSION },
    );
  }
  return ctx;
}

const fixtureNo = (fixtureId: string) =>
  withDb(async (sql) => {
    const [row] = await sql<{ n: number }[]>`select fixture_no as n from fixtures where id = ${fixtureId}`;
    return row!.n;
  });
const runSheetRow = async (page: Page, board: RoundBoard) => page.locator(`li[data-fixture-no="${await fixtureNo(board.fixtureId)}"]`);

/** Two flags on a board, in their producers' note formats (reconcile's
 *  out-of-band adoption, the sweep's job-5 camera report; see the header). */
async function flagBoard(r: SeededRound, board: RoundBoard): Promise<void> {
  const from = new Date(Date.now() - 20 * 60_000).toISOString();
  const to = new Date(Date.now() - 20 * 60_000 + 95_000).toISOString();
  await withDb(async (sql) => {
    await sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
        (${board.fixtureId}, ${r.orgId}, 'out_of_band_play', null,
         ${`plies 2-5 (${LINE.slice(1, 5).join(" ")}) played at Lichess, not through Seazn; camera required`}),
        (${board.fixtureId}, ${r.orgId}, 'camera_lost', ${board.away.personId},
         ${`camera off 95 s of 1800 s in the match: ${from} to ${to} (its own off/on events agree); from 2 camera connections over 1 session; camera required`})`;
  });
}

test.describe("online chess — the organiser's desk", () => {
  test("Open round (D12): paired, not opened — the confirmation names who it invites; opened, each pairing reads what was sent", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"], { open: false });
    const opens = () =>
      withDb(async (sql) => (await sql`select 1 from stage_round_opens where stage_id = ${r.stageId} and round_no = 1`).length);
    expect(await opens(), "the empty case first: nothing opened").toBe(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    // One control per round the organiser can act on, found by its heading.
    const roundControl = (n: number) =>
      page.getByTestId("open-round").filter({ has: page.getByRole("heading", { name: fill("runsheet.round.heading", { round: n }) }) });
    const control = roundControl(1);
    await expect(control).toHaveAttribute("data-state", "paired", { timeout: 30_000 });
    // Of the paired rounds only the lowest is the next to open: round 2 has no control yet.
    await expect(page.getByTestId("open-round")).toHaveCount(1);
    await expect(control).toHaveAttribute("data-uninvited-count", "4");
    await expect(control.getByTestId("open-round-state")).toHaveText(uiEn["runsheet.round.paired"]);
    for (const b of r.boards) {
      await expect(control.getByTestId(`open-round-pending-${b.fixtureId}`)).toContainText(uiEn["runsheet.round.notInvited"]);
    }
    // The run sheet says it on every board of a round nobody opened — a league
    // pairs every round at Generate, so that is every board of the stage now.
    const unopened = () =>
      withDb(async (sql) => {
        const [row] = await sql<{ n: number }[]>`
          select count(*)::int as n from fixtures f
           where f.stage_id = ${r.stageId}
             and not exists (select 1 from stage_round_opens o where o.stage_id = f.stage_id and o.round_no = f.round_no)`;
        return row!.n;
      });
    const before = await unopened();
    expect(before, "every round of the league is paired, none opened").toBeGreaterThan(r.boards.length);
    await expect(page.getByTestId("run-sheet-round-unopened")).toHaveCount(before);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "open-round-paired");

    // The confirmation: how many players, which pairings — and Cancel sends nothing.
    await page.setViewportSize({ width: 1280, height: 900 });
    await control.getByTestId("open-round-cta").click();
    const dialog = page.getByTestId("open-round-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(fill("runsheet.round.confirmTitle", { round: 1 }));
    await expect(dialog).toContainText(fill("runsheet.round.confirmBody.other", { count: 4 }));
    let named = 0;
    for (const b of r.boards) {
      const row = dialog.getByTestId(`open-round-invitee-${b.fixtureId}`);
      await expect(row).toContainText(b.home.name);
      await expect(row).toContainText(b.away.name);
      named += 1;
    }
    expect(named, "anti-vacuity: every pairing named").toBe(2);
    await shoot(page, "open-round-confirm");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("open-round-confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    expect(await opens(), "Cancel opened nothing").toBe(0);

    await control.getByTestId("open-round-cta").click();
    await expect(page.getByTestId("open-round-confirm-confirm")).toHaveText(fill("runsheet.round.confirmCta.other", { count: 4 }));
    await page.getByTestId("open-round-confirm-confirm").click();
    const notice = control.getByTestId("open-round-notice");
    await expect(notice).toBeVisible();
    expect(await opens(), "one open, stamped by the route").toBe(1);
    // What the open sent, read from the ledger it stamps (a seat's emailed_at). The e2e
    // servers run with no mail provider (RESEND_API_KEY unset, locally and in CI), so
    // every send fails here and the honest answer is "0 invited" with a reason per
    // board; the sent path is vitest's (external-play-open-round*.test.ts).
    const stamps = await withDb(
      (sql) => sql<{ fixture_id: string; sent: number }[]>`
        select fixture_id, ((white_emailed_at is not null)::int + (black_emailed_at is not null)::int) as sent
          from fixture_external_play where fixture_id in ${sql(r.boards.map((b) => b.fixtureId))}`,
    );
    expect(stamps.length, "a bridge row per board of the opened round").toBe(r.boards.length);
    const sent = stamps.reduce((n, x) => n + x.sent, 0);
    const lines = notice.locator("p");
    await expect(lines.first()).toHaveText(fill(sent === 1 ? "externalPlay.openRound.invited.one" : "externalPlay.openRound.invited.other", { count: sent }));
    const unsent = r.boards.filter((b) => stamps.find((x) => x.fixture_id === b.fixtureId)!.sent === 0);
    await expect(lines).toHaveCount(1 + unsent.length);
    for (const [i, b] of unsent.entries()) {
      await expect(lines.nth(1 + i)).toHaveText(
        fill("runsheet.round.skipLine", {
          board: fill("arbiter.boardNo", { n: r.boards.indexOf(b) + 1 }),
          reason: uiEn["externalPlay.openRound.skipped.sendFailed"]!,
        }),
      );
    }
    // After the refresh the round is OPEN either way; what is still owed follows the stamps.
    await expect(control).toHaveAttribute("data-state", "open");
    // And round 2, paired at Generate (a league pairs every round), is now the next to open.
    await expect(roundControl(2)).toHaveAttribute("data-state", "paired");
    await expect(page.getByTestId("open-round")).toHaveCount(2);
    await expect(control).toHaveAttribute("data-uninvited-count", String(4 - sent));
    if (sent === 0) {
      // Opened, and nobody reached: the control says so and offers the open again.
      await expect(control).toHaveAttribute("data-press", "reopen");
      await expect(control.getByTestId("open-round-state")).toHaveText(uiEn["runsheet.round.reopenState"]);
      for (const b of r.boards) {
        await expect(control.getByTestId(`open-round-pending-${b.fixtureId}`)).toContainText(uiEn["runsheet.round.notInvited"]);
      }
    } else if (sent === 4) {
      await expect(control).toHaveAttribute("data-press", "none");
      await expect(control.getByTestId("open-round-cta")).toHaveCount(0);
      for (const b of r.boards) {
        await expect(control.getByTestId(`open-round-already-${b.fixtureId}`)).toContainText(uiEn["runsheet.round.invited"]);
      }
    }
    // Round 1's boards stop saying it; the later rounds, still unopened, keep it.
    expect(await unopened(), "round 1's boards left the unopened set").toBe(before - r.boards.length);
    await expect(page.getByTestId("run-sheet-round-unopened")).toHaveCount(before - r.boards.length);
    for (const b of r.boards) await expect((await runSheetRow(page, b)).getByTestId("run-sheet-round-unopened")).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "open-round-open");
  });

  test("the queue: a held board settled from it, a flagged board let go on — and the run sheet's chips point at both", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"], { camera: "required" });
    const [held, flagged] = [r.boards[0]!, r.boards[1]!];
    await roundGameSql(held, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await roundGameSql(flagged, { moves: LINE });
    await flagBoard(r, flagged);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    // The run sheet: the held board says it needs a decision, the flagged one counts its camera flag.
    const heldRow = await runSheetRow(page, held);
    const flaggedRow = await runSheetRow(page, flagged);
    await expect(heldRow.getByTestId("run-sheet-online-held-chip")).toHaveAttribute(
      "aria-label",
      fill("runsheet.online.heldName", { match: vs(held.home.name, held.away.name) }),
      { timeout: 30_000 },
    );
    await expect(flaggedRow.getByTestId("run-sheet-camera-chip")).toHaveText(fill("runsheet.camera.flag.one", { count: 1 }));
    await expect(flaggedRow.getByTestId("run-sheet-camera-chip")).toHaveAttribute("href", `${r.arbiterPath}?fixture=${flagged.fixtureId}`);
    await expect(heldRow.getByTestId("run-sheet-camera-chip")).toHaveCount(0);
    await expect(flaggedRow.getByTestId("run-sheet-online-held-chip")).toHaveCount(0);

    // The queue: Held | Flagged, each board once.
    const queue = page.getByTestId("external-play-needs-result-queue");
    await expect(queue.getByTestId("external-play-held")).toContainText(fill("externalPlay.queue.heldHeading", { count: 1 }));
    await expect(queue.getByTestId("external-play-flagged")).toContainText(fill("externalPlay.queue.flaggedHeading", { count: 1 }));
    await expect(queue.getByTestId(`external-play-queue-row-${held.fixtureId}`)).toBeVisible();
    const flaggedCard = queue.getByTestId(`external-play-flagged-${flagged.fixtureId}`);
    await expect(flaggedCard).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "queue-held-flagged");

    // Let the game go on: exactly the flags shown are closed, under the organiser's name; the game is untouched.
    await page.setViewportSize({ width: 1280, height: 900 });
    await flaggedCard.getByTestId("external-play-go-on").click();
    const answer = queue.getByTestId("external-play-queue-status");
    await expect(answer).toHaveText(uiEn["arbiter.notice.wentOn"]);
    await expect(queue.getByTestId(`external-play-flagged-${flagged.fixtureId}`)).toHaveCount(0);
    // Its row gone with the refresh, the answer stays on screen.
    await expect(answer).toBeVisible();
    const flags = await withDb(
      (sql) => sql<{ closed: boolean; role: string | null }[]>`
        select f.closed_at is not null as closed, m.role from fixture_play_flags f
          left join org_members m on m.user_id = f.resolved_by and m.org_id = f.org_id
         where f.fixture_id = ${flagged.fixtureId}`,
    );
    expect(flags, "both flags closed and kept, resolved by an organiser").toEqual([
      { closed: true, role: expect.stringMatching(/^(owner|admin)$/) },
      { closed: true, role: expect.stringMatching(/^(owner|admin)$/) },
    ]);
    const live = await withDb(async (sql) => {
      const [row] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${flagged.fixtureId}`;
      return row!.status;
    });
    expect(live, "going on changes no result").toBe("live");
    // No open camera flag left on a live, camera-required board: the chip reads "Camera ok".
    await expect(flaggedRow.getByTestId("run-sheet-camera-chip")).toHaveAttribute("data-state", "ok");
    await expect(flaggedRow.getByTestId("run-sheet-camera-chip")).toHaveText(uiEn["runsheet.camera.ok"]!);

    // Settle the held board: White (the home side, on the row) wins.
    const heldCard = queue.getByTestId(`external-play-queue-row-${held.fixtureId}`);
    await heldCard.getByTestId("external-play-settle-toggle").click();
    const whiteWins = heldCard.getByTestId("external-play-resolve-home_wins");
    await expect(whiteWins).toHaveText(fill("externalPlay.settle.wins", { name: held.home.name }));
    await whiteWins.click();
    // 45 s: under `next dev` the resolve route's first POST compiles (~15-20 s); a prod server answers at once.
    await expect(queue.getByTestId(`external-play-queue-row-${held.fixtureId}`)).toHaveCount(0, { timeout: 45_000 });
    await expect(answer).toHaveText(uiEn["arbiter.notice.settled"]);
    const state = await withDb(async (sql) => {
      const [row] = await sql<{ status: string; outcome: { kind?: string; winner?: string } | null }[]>`
        select status, outcome from fixtures where id = ${held.fixtureId}`;
      return row!;
    });
    expect(state.status).toBe("decided");
    expect(state.outcome).toMatchObject({ kind: "win", winner: held.home.entrantId });
    await expect(heldRow.getByTestId("run-sheet-online-held-chip")).toHaveCount(0);
  });

  test("Unpair while a game is on file: refused, the round stays paired, and the notice leads to the arbiter panel", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const r = await seedOnlineRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"], { stage: "swiss" });
    await roundGameSql(r.boards[0]!, { moves: LINE.slice(0, 4) });
    const seated = () =>
      withDb(async (sql) => {
        const rows = await sql`
          select 1 from fixtures where stage_id = ${r.stageId} and round_no = 1
             and home_entrant_id is not null and away_entrant_id is not null`;
        return rows.length;
      });
    expect(await seated()).toBe(2);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    await expect(page.getByTestId("online-game-exists")).toHaveCount(0);
    await page.getByTestId("stage-unpair").click();
    const notice = page.getByTestId("online-game-exists");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    expect(await seated(), "the refusal left both boards paired").toBe(2);
    const link = notice.getByTestId("online-game-exists-link");
    await expect(link).toHaveText(uiEn["externalPlay.gameExistsCta"]);
    await expect(link).toHaveAttribute("href", r.arbiterPath);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "unpair-game-exists");
    await page.setViewportSize({ width: 1280, height: 900 });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${r.arbiterPath}$`));
    await expect(page.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] })).toBeVisible();
  });
});

test.describe("online chess — the public fixture page", () => {
  test("Your board: the signed-in player's door into THEIR room; a stranger gets nothing", async ({ browser, request }) => {
    test.setTimeout(180_000);
    const room = await seedMatchRoom(request, { names: [longName(), "Bo Lindqvist"] });

    const ctx = await cold(browser);
    const p = await ctx.newPage();
    await loginUi(p, room.white.email, room.fixturePath);
    await p.waitForURL((u) => u.pathname === room.fixturePath);
    const card = p.getByTestId("your-board");
    // Opened a moment ago: the check-in window is open.
    await expect(card).toHaveAttribute("data-state", "check_in", { timeout: 30_000 });
    await expect(card).toContainText(uiEn["externalPlay.yourBoard.state.check_in"]);
    await expect(card.getByTestId("your-board-link")).toHaveAttribute("href", room.roomPath);
    await expect(p.locator('a[href*="lichess.org"]')).toHaveCount(0);
    expect(await noSidewaysScroll(p)).toBe(3);
    await shoot(p, "your-board");
    await p.setViewportSize({ width: 1280, height: 900 });
    await card.getByTestId("your-board-link").click();
    await p.waitForURL((u) => u.pathname === room.roomPath);
    await expect(p.getByTestId("match-room")).toBeVisible();
    await ctx.close();

    // Anonymous: the lobby refuses (401) and the island shows nothing.
    const anon = await cold(browser);
    const a = await anon.newPage();
    const asked = a.waitForResponse((res) => res.url().includes(`/fixtures/${room.fixtureId}/external-play/lobby`));
    await a.goto(room.fixturePath);
    expect((await asked).status()).toBe(401);
    await expect(a.getByTestId("watch-panel")).toBeVisible();
    await expect(a.getByTestId("your-board")).toHaveCount(0);
    await anon.close();
  });

  test("the watch panel: the game's position, view-only, no Lichess link, kept current by the poll — at 320, 768 and 1280", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000 + 2 * POLL_MS);
    const room = await seedMatchRoom(request, { names: [longName(), "Bo Lindqvist"] });
    const { fen } = await seedGameSql(room, { moves: LINE });
    const rules = new Chess(fen);
    expect(fen, "the seeded position is not the start").not.toBe(new Chess().fen());

    const ctx = await cold(browser);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(room.fixturePath);
    const panel = page.getByTestId("watch-panel");
    await expect(panel).toHaveAttribute("data-state", "board", { timeout: 30_000 });
    await expect(panel).toContainText(uiEn["externalPlay.watch.title"]);
    await expect(panel).toContainText(uiEn["externalPlay.watch.viewOnly"]);
    const surface = page.getByTestId("room-board-surface");
    await expect(surface).toHaveAttribute("data-fen", fen);
    await expect(surface).toHaveAttribute("data-view-only", "true");
    const pieces = rules.board().flat().filter((sq) => sq !== null).length;
    await expect(page.locator("cg-board piece")).toHaveCount(pieces);
    // The names by colour, as the room reports them.
    await expect(page.getByTestId("watch-clock-white")).toContainText(room.white.name);
    await expect(page.getByTestId("watch-clock-black")).toContainText(room.black.name);
    // White to move after eight plies (the rules): White's clock is the one running.
    expect(rules.turn()).toBe("w");
    await expect(page.getByTestId("watch-clock-white")).toHaveAttribute("data-active", "true");
    // View-only: a click on a piece selects nothing.
    await page.locator("cg-board piece").first().click({ force: true });
    await expect(page.locator("cg-board square.selected")).toHaveCount(0);
    await expect(page.locator('a[href*="lichess.org"]')).toHaveCount(0);
    let boxes = 0;
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await page.getByTestId("watch-board").boundingBox();
      expect(box && box.width > 0 && box.height > 0, `the board has a box at ${width}px`).toBe(true);
      boxes += 1;
    }
    expect(boxes).toBe(3);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "watch-board");

    // The next move reaches the open page with no reload (labelled SQL: T10's move append, here 5.d4).
    await page.setViewportSize({ width: 1280, height: 900 });
    rules.move({ from: "d2", to: "d4" });
    await withDb(
      (sql) => sql`
        update fixture_external_play
           set moves_uci = moves_uci || ${sql.json(["d2d4"])}, move_count = move_count + 1, last_move_at = now(), updated_at = now()
         where fixture_id = ${room.fixtureId}`,
    );
    await expect(surface).toHaveAttribute("data-fen", rules.fen(), { timeout: POLL_MS + 15_000 });
    await expect(page.getByTestId("watch-clock-black")).toHaveAttribute("data-active", "true");
    await ctx.close();
  });

  test("before the round opens, the watch panel says so — no board, no Your board", async ({ browser, request }) => {
    test.setTimeout(120_000);
    const room = await seedMatchRoom(request, { names: ["Ana Petrova", "Bo Lindqvist"], open: false });
    const ctx = await cold(browser);
    const page = await ctx.newPage();
    await page.goto(room.fixturePath);
    const panel = page.getByTestId("watch-panel");
    await expect(panel).toHaveAttribute("data-state", "not_opened", { timeout: 30_000 });
    await expect(panel).toContainText(uiEn["externalPlay.watch.notOpened"]);
    await expect(page.getByTestId("watch-board")).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "watch-not-opened");
    await ctx.close();
  });
});

test.describe("online chess — /me", () => {
  /** Whether the server can start a Lichess link (lib/oauth.ts lichessConfigured: LICHESS_CLIENT_ID). The e2e
   *  servers share this process's environment; CI sets no client id, so there the card says so. */
  const CONFIGURED = Boolean(process.env.LICHESS_CLIENT_ID);

  test("an entered player who is not linked gets the Lichess card's Link; a linked one sees their account", async ({ browser, request }) => {
    test.setTimeout(150_000);
    const room = await seedMatchRoom(request, { names: [longName(), "Bo Lindqvist"], open: false });
    // Labelled SQL: the player unlinks (the real unlink also revokes at Lichess, a network call e2e never makes).
    await withDb((sql) => sql`delete from user_external_accounts where user_id = ${room.white.userId} and provider = 'lichess'`);

    const ctx = await cold(browser);
    const p = await ctx.newPage();
    await loginUi(p, room.white.email, "/me");
    await p.waitForURL((u) => u.pathname === "/me");
    const card = p.getByTestId("lichess-link-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    if (CONFIGURED) {
      await expect(card.getByTestId("lichess-link")).toHaveText(uiEn["settings.account.lichess.link"]!);
      await expect(card.getByTestId("lichess-linked-username")).toHaveCount(0);
    } else {
      await expect(card.getByTestId("lichess-not-configured")).toHaveText(uiEn["settings.account.lichess.notConfigured"]!);
    }
    expect(await noSidewaysScroll(p)).toBe(3);
    await shoot(p, "me-lichess-unlinked");
    await ctx.close();

    const ctx2 = await cold(browser);
    const q = await ctx2.newPage();
    await loginUi(q, room.black.email, "/me");
    await q.waitForURL((u) => u.pathname === "/me");
    const linked = q.getByTestId("lichess-link-card");
    await expect(linked).toBeVisible({ timeout: 30_000 });
    if (CONFIGURED) {
      await expect(linked.getByTestId("lichess-linked-username")).toContainText(room.black.lichessId);
      await expect(linked.getByTestId("lichess-unlink")).toBeVisible();
    } else {
      await expect(linked.getByTestId("lichess-not-configured")).toBeVisible();
    }
    await ctx2.close();
  });
});
