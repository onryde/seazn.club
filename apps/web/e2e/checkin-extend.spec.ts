/**
 * Spec 2026-10-09 §3.2.2 - the arbiter adds time to a check-in, in a browser, against the real server.
 *
 * The organiser's half goes through the product (match-room-kit.ts `seedOnlineRound`: a public competition, a boardgame division
 * played online, four linked players, a league stage, Start, round 1 opened through the open-round route). Nobody is checked in, so
 * every board's check-in is open and each player's room shows the deadline countdown. What no API writes is seeded by SQL, and
 * says why: the players' Lichess links (an OAuth trip to lichess.org) and a game's ledger (made at Lichess by T9/T10; the kit
 * writes it the way they leave it).
 *
 *  1. ONE board: the arbiter presses "+5 min (3 left)" on the panel - the board's closing time moves, the button counts down, the
 *     audit row names the organiser, and the PLAYER'S open room, with no reload, counts down from five minutes later. The other
 *     board's room does not move (the inert-seam class: a number stored on the row that the room never reads).
 *  2. The ROUND: "+5 min to the round" on the Fixtures tab's Open round control extends the open boards and says why it left one
 *     alone (a game is on it); the arbiter panel's own round bar does the same and stops offering itself at the cap.
 *  3. The bar: both surfaces with their answers painted, at 320, 768 and 1280 - no sideways scroll, every button's whole label,
 *     a 44px target.
 *
 * Expected copy comes from the dictionary and the numbers from lib/checkin-extend.ts - never from the code under test.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MINUTES, CHECKIN_EXTEND_STEP_MS } from "../src/lib/checkin-extend";
import { apiJson, withDb } from "./helpers";
import { fill, longName, roundGameSql, seedOnlineRound, uiEn, type SeededRound } from "./match-room-kit";
import { mintMatchRoomLink } from "./match-room-link";

test.describe.configure({ mode: "parallel" });

/** Captures for the visual sign-off, only when asked for, never committed. */
const SHOTS = process.env.CHECKIN_EXTEND_SHOTS_DIR;
const WIDTHS = [320, 768, 1280] as const;
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"];

const NAMES = () => ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"];

/** A dictionary line as a regex: the given slots filled, every other slot (a local time of day) any HH:MM. */
function lineRe(key: string, vars: Record<string, string | number> = {}): RegExp {
  const raw = uiEn[key];
  if (raw === undefined) throw new Error(`checkin-extend.spec: no en copy for ${key}`);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    raw
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (!m) return esc(part);
        return m[1]! in vars ? esc(String(vars[m[1]!])) : "\\d{1,2}:\\d{2}";
      })
      .join(""),
  );
}
const boardLabel = (left: number) => fill("externalPlay.checkinExtend.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, left });
const roundLabel = fill("externalPlay.checkinExtend.round", { minutes: CHECKIN_EXTEND_STEP_MINUTES });

type Extension = { ms: number; n: number };
async function extensionOf(fixtureId: string): Promise<Extension> {
  return withDb(async (sql) => {
    const [row] = await sql<{ ms: number; n: number }[]>`
      select checkin_extra_ms as ms, checkin_extensions as n from fixture_external_play where fixture_id = ${fixtureId}`;
    expect(row, `a bridge row for ${fixtureId} (was the round opened?)`).toBeDefined();
    return row!;
  });
}
async function auditRows(fixtureId: string): Promise<{ actor: string; note: { scope: string; extensions: number; addedMs: number; deadlineAt: string } }[]> {
  return withDb(async (sql) => {
    const rows = await sql<{ actor: string; note: string }[]>`
      select actor_user_id as actor, note from online_chess_audit
       where fixture_id = ${fixtureId} and kind = 'checkin_extend' order by created_at, id`;
    return rows.map((r) => ({ actor: r.actor, note: JSON.parse(r.note) }));
  });
}

/** A player's room, opened cold on their personal link (no session), as the invite email opens it. */
async function openPlayerRoom(browser: import("@playwright/test").Browser, r: SeededRound, boardIdx: number): Promise<Page> {
  const board = r.boards[boardIdx]!;
  const open = await withDb(async (sql) => {
    const [row] = await sql<{ id: string; opened_at: Date }[]>`
      select id, opened_at from stage_round_opens where stage_id = ${r.stageId} and round_no = 1`;
    return { id: row!.id, openedAt: new Date(row!.opened_at) };
  });
  const token = await mintMatchRoomLink({ fixtureId: board.fixtureId, personId: board.home.personId, roundOpenId: open.id, openedAt: open.openedAt });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto(`${r.publicBase}/fixtures/${board.fixtureId}/play?t=${encodeURIComponent(token)}`);
  expect(res?.status(), "the room renders").toBe(200);
  await expect(page.getByTestId("match-room")).toBeVisible();
  return page;
}

/** The room's deadline countdown, "m:ss", in seconds. */
async function countdownSeconds(p: Page): Promise<number> {
  // The face renders only after mount (the server's clock is not the viewer's): wait for it before reading.
  await expect(p.getByTestId("room-checkin-countdown")).toContainText(/\d+:\d\d/);
  const text = await p.getByTestId("room-checkin-countdown").innerText();
  const m = /(\d+):(\d\d)/.exec(text);
  if (!m) throw new Error(`no m:ss in the countdown: ${JSON.stringify(text)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 768 ? 1024 : 700 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`), fullPage: true, caret: "initial" });
  }
}

/** No horizontal page scroll, and every given button shows its whole label inside a 44px-tall target, at each width. Counted. */
async function barHolds(page: Page, buttons: () => Locator, label: string): Promise<number> {
  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, `${label}: no horizontal page scroll at ${width}px`).toBeLessThanOrEqual(client);
    const boxes = await buttons().evaluateAll((els) =>
      els.map((el) => ({ text: el.textContent ?? "", fits: el.scrollWidth <= el.clientWidth, h: el.getBoundingClientRect().height })),
    );
    expect(boxes.length, `${label} ${width}px: premise, the buttons render`).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.fits, `${label} ${width}px: "${b.text}" shows all of its label`).toBe(true);
      expect(b.h, `${label} ${width}px: "${b.text}" is a 44px target`).toBeGreaterThanOrEqual(44);
      checked += 1;
    }
    checked += 1;
  }
  return checked;
}

const desk = (page: Page) => page.getByTestId("open-round").first();
/** The decision region (its accessible name is the heading's; the per-board heading is the phone's). */
const decision = (page: Page) => page.getByRole("region", { name: uiEn["arbiter.decide.heading"] });

test.describe("the check-in extension", () => {
  test("one board: +5 min on the panel moves the board's closing time, is audited, and the player's open room counts down from five minutes later", async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const r = await seedOnlineRound(request, NAMES());
    const [b1, b2] = r.boards as [SeededRound["boards"][number], SeededRound["boards"][number]];
    const room1 = await openPlayerRoom(browser, r, 0);
    const room2 = await openPlayerRoom(browser, r, 1);
    const before1 = await countdownSeconds(room1);
    const before2 = await countdownSeconds(room2);
    expect(before1, "premise: a countdown of a few minutes, inside the unextended window").toBeGreaterThan(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    await expect(page.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] })).toBeVisible();
    const press = page.getByTestId("arbiter-extend-board");
    await expect(press, "the check-in is open, nobody is on a game: a press is offered, counting its presses").toHaveText(boardLabel(CHECKIN_EXTEND_MAX));
    await expect(page.getByTestId("arbiter-extend-closes")).toHaveText(lineRe("externalPlay.checkinExtend.closesAt"));

    const answer = page.waitForResponse((q) => q.request().method() === "POST" && q.url().endsWith(`/fixtures/${b1.fixtureId}/external-play/extend-checkin`));
    await press.click();
    expect((await answer).status()).toBe(200);
    await expect(decision(page).getByRole("status")).toHaveText(lineRe("externalPlay.checkinExtend.notice.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, n: 1 }));
    await expect(press, "the press counts down").toHaveText(boardLabel(CHECKIN_EXTEND_MAX - 1));

    // The row, the audit and nothing else moved.
    expect(await extensionOf(b1.fixtureId)).toEqual({ ms: CHECKIN_EXTEND_STEP_MS, n: 1 });
    expect(await extensionOf(b2.fixtureId), "the other board is untouched").toEqual({ ms: 0, n: 0 });
    const audit = await auditRows(b1.fixtureId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.note).toMatchObject({ scope: "board", extensions: 1, addedMs: CHECKIN_EXTEND_STEP_MS });
    expect(await auditRows(b2.fixtureId)).toHaveLength(0);

    // THE LIVE SEAM: the player's room, never reloaded, re-reads its snapshot and counts down from five minutes later. The room's
    // idle poll reaches it (the realtime nudge is not available to a local HS256 server); the budget is the poll's reach, not a guess.
    await expect
      .poll(async () => countdownSeconds(room1), { timeout: 60_000, message: "board 1's room counts down from the extended deadline" })
      .toBeGreaterThan(before1 + (CHECKIN_EXTEND_STEP_MS / 1000) - 90);
    const after1 = await countdownSeconds(room1);
    expect(after1, "the room never shows MORE than the five minutes added").toBeLessThanOrEqual(before1 + CHECKIN_EXTEND_STEP_MS / 1000 + 2);
    // ... and the neighbour's does not move (the same poll has run for it).
    expect(await countdownSeconds(room2), "board 2's room is on its own, unextended deadline").toBeLessThanOrEqual(before2);

    // A reload is the same truth: the snapshot a fresh read carries.
    await room1.reload();
    await expect(room1.getByTestId("room-checkin-countdown")).toBeVisible();
    expect(await countdownSeconds(room1)).toBeGreaterThan(before1 + CHECKIN_EXTEND_STEP_MS / 1000 - 90);
  });

  test("the round: +5 min on the Fixtures tab extends the open boards and says why one was left alone; the panel's bar does the same and stops at the cap", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const r = await seedOnlineRound(request, NAMES());
    const [b1, b2] = r.boards as [SeededRound["boards"][number], SeededRound["boards"][number]];
    await roundGameSql(b1, { moves: LINE });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    const control = desk(page);
    await expect(control.getByTestId("open-round-extend-cta")).toHaveText(roundLabel);
    await expect(control.getByTestId("open-round-extend")).toContainText(fill("externalPlay.checkinExtend.roundHint.one", { count: 1 }));
    await control.getByTestId("open-round-extend-cta").click();
    const notice = control.getByTestId("open-round-extend-notice");
    await expect(notice).toContainText(fill("externalPlay.checkinExtend.notice.round.one", { minutes: CHECKIN_EXTEND_STEP_MINUTES, count: 1 }));
    await expect(notice, "and the board a game is on, said in words").toContainText(fill("externalPlay.checkinExtend.skip.gameStarted.one", { count: 1 }));
    expect(await extensionOf(b1.fixtureId), "the board with a game on it is not moved").toEqual({ ms: 0, n: 0 });
    expect(await extensionOf(b2.fixtureId)).toEqual({ ms: CHECKIN_EXTEND_STEP_MS, n: 1 });
    expect((await auditRows(b2.fixtureId)).map((a) => a.note.scope)).toEqual(["round"]);
    expect(await auditRows(b1.fixtureId)).toHaveLength(0);

    // The arbiter panel: board 1 (a game is on it) offers no press; board 2 offers two more, and the round bar presses it again.
    await page.goto(r.arbiterPath);
    await expect(page.getByTestId("arbiter-extend-board"), "board 1 has a game on it: no per-board press").toHaveCount(0);
    await expect(page.getByTestId("arbiter-extend-round-cta")).toHaveText(roundLabel);
    await page.goto(`${r.arbiterPath}?fixture=${b2.fixtureId}`);
    await expect(page.getByTestId("arbiter-extend-board")).toHaveText(boardLabel(CHECKIN_EXTEND_MAX - 1));
    for (let press = 2; press <= CHECKIN_EXTEND_MAX; press++) {
      await page.getByTestId("arbiter-extend-round-cta").click();
      const lines = page.getByTestId("arbiter-extend-round-notice");
      await expect(lines).toContainText(fill("externalPlay.checkinExtend.notice.round.one", { minutes: CHECKIN_EXTEND_STEP_MINUTES, count: 1 }));
      await expect(lines).toContainText(fill("externalPlay.checkinExtend.skip.gameStarted.one", { count: 1 }));
      expect(await extensionOf(b2.fixtureId)).toEqual({ ms: press * CHECKIN_EXTEND_STEP_MS, n: press });
    }
    // At the cap nothing is left to extend: the bar and the per-board press go, the last answer stays.
    await expect(page.getByTestId("arbiter-extend-round-cta")).toHaveCount(0);
    await expect(page.getByTestId("arbiter-extend-board")).toHaveCount(0);
    await expect(page.getByTestId("arbiter-extend-round-notice")).toContainText(fill("externalPlay.checkinExtend.notice.round.one", { minutes: CHECKIN_EXTEND_STEP_MINUTES, count: 1 }));
    expect((await auditRows(b2.fixtureId)).length).toBe(CHECKIN_EXTEND_MAX);

    // And the cap holds at the door, not only on the screen.
    const over = await apiJson(request, `/api/v1/fixtures/${b2.fixtureId}/external-play/extend-checkin`, "POST");
    expect([over.status, over.error?.code]).toEqual([409, "CHECKIN_EXTEND_CAP"]);
    expect(await extensionOf(b2.fixtureId)).toEqual({ ms: CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS, n: CHECKIN_EXTEND_MAX });
  });

  test("the bar at 320, 768 and 1280: the panel and the Fixtures tab, buttons and answers painted - no sideways scroll, whole labels, 44px targets", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // Two boards, both with their check-in open and no game on either: nothing is capped while the answers are on screen
    // (board 1 takes 3 presses in all, the cap, only after the panel has been looked at).
    const r = await seedOnlineRound(request, [longName(), longName(), "Chen Wei", "Dara Okafor"]);
    const b1 = r.boards[0]!;

    // The arbiter panel: a board press and the round bar, with the board's answer and the round's both painted.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${r.arbiterPath}?fixture=${b1.fixtureId}`);
    await page.getByTestId("arbiter-extend-board").click();
    await expect(decision(page).getByRole("status")).toHaveText(lineRe("externalPlay.checkinExtend.notice.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, n: 1 }));
    await page.getByTestId("arbiter-extend-round-cta").click();
    await expect(page.getByTestId("arbiter-extend-round-notice")).toContainText(
      fill("externalPlay.checkinExtend.notice.round.other", { minutes: CHECKIN_EXTEND_STEP_MINUTES, count: 2 }),
    );
    // Board 1 has had two presses and has one left; the board's own answer is still on screen beside the round's.
    await expect(page.getByTestId("arbiter-extend-board")).toHaveText(boardLabel(CHECKIN_EXTEND_MAX - 2));
    await shoot(page, "arbiter-panel-extend");
    expect(
      await barHolds(
        page,
        () => page.locator('[data-testid="arbiter-extend-board"], [data-testid="arbiter-extend-round-cta"]'),
        "arbiter panel",
      ),
      "anti-vacuity: widths x (two buttons + page)",
    ).toBe(WIDTHS.length * 3);

    // The Fixtures tab: the control with its round press and, after a press, its answer (board 2 is still extendable, so the press stays).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    await desk(page).getByTestId("open-round-extend-cta").click();
    // Board 1's third press (the cap) and board 2's second: both are extended, none skipped.
    await expect(desk(page).getByTestId("open-round-extend-notice")).toContainText(
      fill("externalPlay.checkinExtend.notice.round.other", { minutes: CHECKIN_EXTEND_STEP_MINUTES, count: 2 }),
    );
    await shoot(page, "fixtures-tab-extend");
    expect(
      await barHolds(page, () => desk(page).getByTestId("open-round-extend-cta"), "fixtures tab"),
      "anti-vacuity: widths x (button + page)",
    ).toBe(WIDTHS.length * 2);
  });
});
