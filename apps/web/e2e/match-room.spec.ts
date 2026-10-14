/**
 * T14 — the match room, in a browser, against the real server.
 *
 * Every room here is entered COLD — a fresh context with no session and no
 * history, the way a player arrives from the invite's personal link — except
 * where a test signs a player in to prove the session entry. Seeding is in
 * match-room-kit.ts, which says what is SQL and why.
 *
 * Nothing here reaches Lichess, by construction (the kit's stored tokens can
 * never be opened, and no test lets both players check in). The board's move
 * leaves the browser for real and is caught at the browser's edge: what it
 * sends is asserted, and the answer it gets back is the act route's own
 * refusal envelope. The move's round trip through Lichess is the Task 17
 * walkthrough's, with its Lichess fixture server; the server half (claim →
 * create → act → both boards read) is external-play-room-game.test.ts.
 *
 * Expected boards come from chess.js (the rules), expected copy from the
 * dictionary or the owner-approved canvas — never from the room's code.
 */
import { test, expect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { Chess } from "chess.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "../src/lib/consent";
import { apiJson, loginUi, withDb } from "./helpers";
import {
  bridgeRow,
  checkedInAt,
  fill,
  longName,
  playScopes,
  seedGameSql,
  seedMatchRoom,
  uiEn,
  type SeededRoom,
} from "./match-room-kit";

test.describe.configure({ mode: "parallel" });

const ALL_WIDTHS = [320, 360, 375, 390, 430, 768, 834, 1280];
/** Board-vs-build captures (owner's canvas), only when asked for, never committed. */
const SHOTS = process.env.ROOM_SHOTS_DIR;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 768 ? 1024 : 700 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`), fullPage: true, caret: "initial" });
  }
  if (original) await page.setViewportSize(original);
}

/** A fresh context: no session, no history — the invite link opened in a new browser. */
async function cold(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: test.info().project.use.baseURL });
  if (SHOTS) {
    // The canvas draws the room, not the site's cookie notice: answered in
    // advance for a capture run only (gallery.capture.ts's bypass).
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

/** Every console error a room page logged in this test: a room that works
 *  says nothing (React's dev warnings land here too — an unknown element, a
 *  hydration mismatch, a missing key). Checked after each test. */
const consoleErrors: string[] = [];
/** Chrome's notice about the SITE's report-only CSP header (proxy.ts, every
 *  page) — not the room's to fix. Matched whole, so nothing else hides here. */
const SITE_WIDE = new Set([
  "The Content Security Policy directive 'upgrade-insecure-requests' is ignored when delivered in a report-only policy.",
]);
test.beforeEach(() => {
  consoleErrors.length = 0;
});
test.afterEach(() => {
  expect(consoleErrors, "the room's browser console stays quiet").toEqual([]);
});

async function openRoom(ctx: BrowserContext, room: SeededRoom, token: string, width = 1280): Promise<Page> {
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !SITE_WIDE.has(m.text())) consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
  await page.setViewportSize({ width, height: 900 });
  const res = await page.goto(`${room.roomPath}?t=${encodeURIComponent(token)}`);
  expect(res?.status(), "the room renders").toBe(200);
  await expect(page.getByTestId("match-room")).toBeVisible();
  return page;
}

const screenOf = (page: Page) => page.getByTestId("match-room").getAttribute("data-screen");

async function noSidewaysScroll(page: Page, widths: number[]): Promise<number> {
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(100);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, `no horizontal page scroll at ${width}px`).toBeLessThanOrEqual(client);
    checked += 1;
  }
  return checked;
}

/** An element's painted box, by test id (the first, attached). */
async function boxOf(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId(testId).first().boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return box;
}

/** The drawn order of a phone column: each box wholly below the one before. */
async function stackedTopDown(page: Page, ids: string[]): Promise<number> {
  let checked = 0;
  for (let i = 1; i < ids.length; i += 1) {
    const above = await boxOf(page, ids[i - 1]!);
    const below = await boxOf(page, ids[i]!);
    expect(above.y + above.height, `${ids[i - 1]} sits above ${ids[i]}`).toBeLessThanOrEqual(below.y + 1);
    checked += 1;
  }
  return checked;
}

/** The desktop composition: `id` sits in the aside, right of the board. */
async function inAside(page: Page, id: string): Promise<void> {
  const board = await boxOf(page, "room-board");
  const box = await boxOf(page, id);
  expect(box.x, `${id} is in the aside, right of the board`).toBeGreaterThanOrEqual(board.x + board.width);
  expect(box.y, `${id} starts level with the board, not under it`).toBeLessThan(board.y + board.height / 2);
}

/** Chrome's own line for a request the test cut off at the browser's edge. */
const CUT_OFF = /net::ERR_INTERNET_DISCONNECTED/;

// ------------------------------------------------------------- the board

type Square = string;
const FILES = "abcdefgh";
/** The canvas's square colours (chessboard.js): light #f0d9b5, dark #b58863. */
const SQUARE = { light: "rgb(240, 217, 181)", dark: "rgb(181, 136, 99)" } as const;

/** Pieces as chessground drew them: square → "white pawn". */
async function piecesOnBoard(page: Page): Promise<Record<Square, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const el of document.querySelectorAll("[data-testid=room-board-surface] cg-board piece")) {
      const p = el as HTMLElement & { cgKey?: string };
      if (p.classList.contains("ghost") || p.classList.contains("fading") || !p.cgKey) continue;
      out[p.cgKey] = [...p.classList].filter((c) => c !== "anim" && c !== "dragging").join(" ");
    }
    return out;
  });
}

/** The same map from the rules: chess.js's board for a FEN. */
function piecesOf(fen: string): Record<Square, string> {
  const out: Record<Square, string> = {};
  const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" } as const;
  for (const row of new Chess(fen).board()) {
    for (const sq of row) {
      if (sq) out[sq.square] = `${sq.color === "w" ? "white" : "black"} ${names[sq.type]}`;
    }
  }
  return out;
}

async function squaresWith(page: Page, cls: string): Promise<Square[]> {
  return page.evaluate((c) => {
    const keys: string[] = [];
    for (const el of document.querySelectorAll(`[data-testid=room-board-surface] cg-board square.${c}`)) {
      const k = (el as HTMLElement & { cgKey?: string }).cgKey;
      if (k) keys.push(k);
    }
    return keys.sort();
  }, cls);
}

/** The centre of a square, as the player sees the board. */
async function centreOf(page: Page, sq: Square, orientation: "white" | "black"): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("room-board-surface").boundingBox();
  if (!box) throw new Error("the board has no box");
  const file = FILES.indexOf(sq[0]!);
  const rank = Number(sq[1]) - 1;
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const size = box.width / 8;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}

/** Click a square. */
async function tap(page: Page, sq: Square, orientation: "white" | "black"): Promise<void> {
  const { x, y } = await centreOf(page, sq, orientation);
  await page.mouse.click(x, y);
}

/** The piece chessground drew under a square's centre (its own key), or null. */
async function pieceUnder(page: Page, sq: Square, orientation: "white" | "black"): Promise<string | null> {
  const { x, y } = await centreOf(page, sq, orientation);
  return page.evaluate(
    ([px, py]) => {
      for (const el of document.querySelectorAll("[data-testid=room-board-surface] cg-board piece")) {
        const r = el.getBoundingClientRect();
        if (px >= r.left && px < r.right && py >= r.top && py < r.bottom) return (el as HTMLElement & { cgKey?: string }).cgKey ?? null;
      }
      return null;
    },
    [x, y] as const,
  );
}

async function boardReady(page: Page): Promise<void> {
  await expect(page.locator("[data-testid=room-board-surface] cg-board piece").first()).toBeAttached({ timeout: 20_000 });
  // Painted, not just mounted: the board fills its square frame (a cascade
  // once left it 0px tall — every piece drawn, none visible, none tappable),
  // and the middle of the board is the board under a finger.
  await expect
    .poll(async () => {
      const b = await page.locator("[data-testid=room-board-surface] cg-board").boundingBox();
      return b ? Math.round(b.height) > 100 && Math.abs(b.height - b.width) <= 2 : false;
    })
    .toBe(true);
  const hit = await page.getByTestId("room-board-surface").evaluate((surface) => {
    const r = surface.getBoundingClientRect();
    return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("cg-board");
  });
  expect(hit, "a tap on the board lands on the board").toBe(true);
}

/** Catch the room's act POSTs at the browser's edge and answer each with the
 *  act route's own refusal envelope (RoomActOut), so nothing goes further. */
async function catchActs(
  page: Page,
  opts: { hold?: boolean } = {},
): Promise<{ bodies: unknown[]; urls: string[]; release: () => void }> {
  let release = () => {};
  const gate = opts.hold ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  const seen = { bodies: [] as unknown[], urls: [] as string[], release: () => release() };
  await page.route("**/external-play/room/act**", async (route: Route) => {
    seen.urls.push(route.request().url());
    seen.bodies.push(route.request().postDataJSON());
    await gate; // a held answer is the move in flight to Lichess
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { ok: false, reconcile: true, reason: "not_your_turn_or_over" }, requestId: "e2e" }),
    });
  });
  return seen;
}

// ------------------------------------------------------------- the tests

test("cold link: the check-in, its fixed way back, a 43-character opponent, no sideways scroll at eight widths", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [longName(), longName()] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);

  expect(await screenOf(p)).toBe("checkin");
  await expect(p.getByText(uiEn["externalPlay.room.checkin.title"]!, { exact: true })).toBeVisible();
  // The canvas's line, with the opponent's FULL name and the clock spelled out.
  await expect(p.getByText(`You play White against ${room.black.name} · 10 minutes + 5 seconds`)).toBeVisible();
  await expect(p.getByTestId("room-checkin-opponent")).toHaveText(
    fill("externalPlay.room.checkin.opponentNotIn", { name: room.black.name }),
  );
  await expect(p.getByTestId("room-checkin-cta")).toBeEnabled();
  await expect(p.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.cta"]!);
  await expect(p.getByTestId("room-checkin-countdown")).toContainText(/\d+:\d\d/);
  await shoot(p, "checkin");

  const checked = await noSidewaysScroll(p, ALL_WIDTHS);
  expect(checked, "anti-vacuity: every width").toBe(ALL_WIDTHS.length);
  // The opponent's line is a sentence about them, not a name: at the
  // narrowest phone a 43-character name must not cut its end ("…hasn't
  // checked in yet") off.
  await p.setViewportSize({ width: 320, height: 800 });
  const clipped = await p.getByTestId("room-checkin-opponent").evaluate((row) =>
    [...row.querySelectorAll("span")].some((s) => s.scrollWidth > s.clientWidth + 1),
  );
  expect(clipped, "the opponent's check-in line is whole at 320").toBe(false);

  // The header's back arrow is a FIXED link to the fixture page, never
  // history.back(): this tab came from an email, so its "back" leaves the site.
  expect(await p.getByTestId("room-back").evaluate((el) => el.tagName)).toBe("A");
  await expect(p.getByTestId("room-back")).toHaveAttribute("href", room.fixturePath);
  await p.getByTestId("room-back").click();
  await p.waitForURL((u) => u.pathname === room.fixturePath);
  await ctx.close();
});

test("check in through the UI: the seat is stamped, the opponent sees it, and no game is asked for", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  expect(await checkedInAt(room.fixtureId, room.white.personId), "empty case: nobody is in before the click").toBeNull();

  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await p.getByTestId("room-checkin-cta").click();
  await expect(p.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
  await expect(p.getByTestId("room-checkin-cta")).toBeDisabled();
  expect(await checkedInAt(room.fixtureId, room.white.personId), "the server stamped the check-in").not.toBeNull();
  // One player in asks for nothing: no create was sent, no game recorded.
  expect(await bridgeRow(room.fixtureId)).toMatchObject({ status: "pending", challenge_id: null, create_sent_at: null, last_error: null });

  // Second visit: the server's state, not the tab's memory.
  await p.reload();
  await expect(p.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);

  // The opponent, signed in (the session entry), sees White is in.
  const other = await cold(browser);
  const q = await other.newPage();
  await loginUi(q, room.black.email, room.roomPath);
  await q.waitForURL((u) => u.pathname === room.roomPath);
  expect(await screenOf(q)).toBe("checkin");
  await expect(q.getByTestId("room-checkin-opponent")).toHaveText(
    fill("externalPlay.room.checkin.opponentIn", { name: room.white.name }),
  );
  await expect(q.getByText(`You play Black against ${room.white.name}`)).toBeVisible();
  await expect(q.getByTestId("room-checkin-cta")).toBeEnabled();
  expect(await bridgeRow(room.fixtureId), "still nothing asked of Lichess").toMatchObject({ challenge_id: null, create_sent_at: null });
  await ctx.close();
  await other.close();
});

test("a game in play: each board reads the ledger — colour, pieces, last move, clocks, turn — and the controls match at 320 and 1280", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [longName(), longName()] });
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5"], whiteMs: 582_000, blackMs: 497_000 });

  let boards = 0;
  for (const [who, me] of [
    ["white", room.white],
    ["black", room.black],
  ] as const) {
    const ctx = await cold(browser);
    const p = await openRoom(ctx, room, me.token);
    expect(await screenOf(p)).toBe("live");
    await boardReady(p);
    await expect(p.locator("[data-testid=room-board-surface] .cg-wrap")).toHaveClass(new RegExp(`orientation-${who}`));
    expect(await piecesOnBoard(p), `${who}'s board is the ledger's position`).toEqual(piecesOf(fen));
    expect(await squaresWith(p, "last-move"), "the last move is marked").toEqual(["e5", "e7"]);
    // The canvas's coordinates: file letters in lower case, as painted, and
    // every label in the OPPOSITE colour of the square it sits on (ranks on
    // the left file, letters on the bottom rank, from this player's side).
    const files = await p.locator("[data-testid=room-board-surface] coords.files").evaluate((el) => (el as HTMLElement).innerText.replace(/\s+/g, ""));
    expect(files).toBe("abcdefgh");
    const labels = await p.locator("[data-testid=room-board-surface] coords").evaluateAll((all) =>
      all.flatMap((c) =>
        [...c.children].map((k) => ({ files: c.classList.contains("files"), text: (k as HTMLElement).innerText.trim(), colour: getComputedStyle(k).color })),
      ),
    );
    const leftFile = who === "white" ? "a" : "h";
    const bottomRank = who === "white" ? "1" : "8";
    let painted = 0;
    for (const l of labels) {
      const sq = l.files ? `${l.text}${bottomRank}` : `${leftFile}${l.text}`;
      const dark = (FILES.indexOf(sq[0]!) + Number(sq[1])) % 2 === 1; // a1 is dark
      expect(l.colour, `${who}: the label on ${sq}`).toBe(dark ? SQUARE.light : SQUARE.dark);
      painted += 1;
    }
    expect(painted, "anti-vacuity: 8 ranks + 8 files").toBe(16);
    // White to move: White's clock runs, Black's stands at the ledger's 8:17.
    const mine = p.getByTestId("room-clock-you");
    const theirs = p.getByTestId("room-clock-opponent");
    await expect(who === "white" ? mine : theirs).toHaveAttribute("data-active", "true");
    await expect(who === "white" ? theirs : mine).toContainText("8:17");
    await expect(who === "white" ? mine : theirs).toContainText(/9:(4[0-2]|3\d)/);
    await expect(p.getByTestId("room-resign")).toHaveText(uiEn["externalPlay.room.resign"]!);
    await expect(p.getByTestId("room-draw")).toHaveText(uiEn["externalPlay.room.offerDraw"]!);
    // Cameras off: no tile, no pill, no notice.
    await expect(p.getByTestId("room-tile-strip")).toHaveCount(0);
    await expect(p.getByTestId("room-camera-notice")).toHaveCount(0);

    // One DOM at every width: the same controls, in the same order, none twice.
    const controls = async () =>
      p.getByTestId("match-room").evaluate((root) =>
        [...root.querySelectorAll("a[data-testid], button[data-testid]")]
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => el.getAttribute("data-testid")!),
      );
    await p.setViewportSize({ width: 320, height: 800 });
    const phone = await controls();
    await p.setViewportSize({ width: 1280, height: 900 });
    const desk = await controls();
    expect(phone.length, "anti-vacuity: controls were found").toBeGreaterThanOrEqual(3);
    expect(phone).toEqual(desk);
    expect(new Set(phone).size, "no control is drawn twice").toBe(phone.length);
    expect(await noSidewaysScroll(p, [320, 768, 1280])).toBe(3);
    if (who === "white") await shoot(p, "live");
    boards += 1;
    await ctx.close();
  }
  expect(boards, "anti-vacuity: both players' rooms").toBe(2);
});

test("the board: legal dots from the rules, a move sent as UCI with the personal link, a refused move put back", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const rules = new Chess(fen);
  const dests = (from: Square) =>
    rules
      .moves({ square: from as never, verbose: true })
      .map((m) => m.to)
      .sort();

  // Not your turn: Black's pieces do not move, so no dots.
  const bctx = await cold(browser);
  const b = await openRoom(bctx, room, room.black.token);
  await boardReady(b);
  expect(await pieceUnder(b, "b8", "black"), "the tap lands on Black's knight, seen from Black's side").toBe("b8");
  await tap(b, "b8", "black");
  await b.waitForTimeout(300); // two frames: a dot, if one were coming, is painted
  expect(await squaresWith(b, "move-dest"), "the player not to move gets no destinations").toEqual([]);
  expect(await squaresWith(b, "selected"), "nor a selection").toEqual([]);
  await bctx.close();

  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  const acts = await catchActs(p, { hold: true });
  let cases = 0;
  for (const from of ["g1", "d2", "f1"]) {
    expect(await pieceUnder(p, from, "white"), `the tap lands on ${from}`).toBe(from);
    await tap(p, from, "white");
    // chessground repaints on the next frame: poll, never read once.
    await expect.poll(() => squaresWith(p, "move-dest"), { message: `the dots from ${from} are the rules' moves` }).toEqual(dests(from));
    expect(dests(from).length, `anti-vacuity: ${from} has moves`).toBeGreaterThan(0);
    await tap(p, from, "white"); // deselect
    await expect.poll(() => squaresWith(p, "move-dest")).toEqual([]);
    cases += 1;
  }
  expect(cases).toBe(3);

  await tap(p, "g1", "white");
  await tap(p, "f3", "white");
  await expect.poll(() => acts.bodies.length).toBe(1);
  expect(acts.bodies[0]).toEqual({ kind: "move", uci: "g1f3" });
  expect(new URL(acts.urls[0]!).searchParams.get("t"), "the act carries the personal link").toBe(room.white.token);
  // While the move is in flight the knight stays where the player put it —
  // it does not jump back to g1 for the round trip and then reappear — and a
  // routine re-read of the SAME position landing meanwhile (a fresh snapshot,
  // equal by value) does not put it back either.
  const played = new Chess(fen);
  played.move({ from: "g1", to: "f3" });
  const reread = await p.waitForResponse(
    (r) => r.request().method() === "GET" && /\/external-play\/room(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search),
    { timeout: 15_000 },
  );
  expect(reread.status(), "a poll read the room while the move was in flight").toBe(200);
  await p.waitForTimeout(200); // that read has rendered
  expect(await piecesOnBoard(p), "the moved knight stays on f3 while the move is sent").toEqual(piecesOf(played.fen()));
  acts.release();
  // The refusal puts the knight back where the ledger has it.
  await expect.poll(() => piecesOnBoard(p)).toEqual(piecesOf(fen));
  expect((await bridgeRow(room.fixtureId))?.move_count, "nothing was played").toBe(2);
  // Seam C2 (canvas MoveRefusedPhone): Lichess refused it — the amber
  // notice says so, and the re-read that follows every act keeps it.
  const notice = p.getByTestId("room-move-notice");
  await expect(notice).toHaveAttribute("data-kind", "refused");
  await expect(notice).toContainText(uiEn["externalPlay.room.notice.refused.title"]!);
  await expect(notice).toContainText(uiEn["externalPlay.room.notice.refused.body"]!);
  await p.waitForResponse((r) => r.request().method() === "GET" && /\/external-play\/room$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
  await p.waitForTimeout(200);
  await expect(notice, "the re-read of the same board keeps it").toHaveAttribute("data-kind", "refused");
  await inAside(p, "room-move-notice");
  await p.setViewportSize({ width: 320, height: 800 });
  expect(await stackedTopDown(p, ["room-clocks-strip", "room-move-notice", "room-board", "room-controls"]), "anti-vacuity: pairs").toBe(3);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "c2-refused");
  await ctx.close();
});

test("a move through the REAL server: a grant downgraded mid-game is refused by T2's gate before Lichess, and the room asks to re-link", async ({
  page,
  browser,
}) => {
  // Nothing intercepted: the board's move goes to the real act route and the
  // real usecase. Every act asks the play grant first (play.ts step 4), so a
  // grant that lost a play scope after the game began is refused there — the
  // server's own answer, before any token is opened or Lichess is called.
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  expect(await screenOf(p)).toBe("live");

  const dropped = playScopes()[0]!;
  const left = await withDb(async (sql) => {
    const rows = await sql<{ scopes: string[] }[]>`
      update user_external_accounts set scopes = array_remove(scopes, ${dropped})
       where user_id = ${room.white.userId} and provider = 'lichess'
      returning scopes`;
    return rows;
  });
  expect(left.length, "White's grant was found and narrowed").toBe(1);
  expect(left[0]!.scopes).not.toContain(dropped);

  const answered = p.waitForResponse((r) => r.request().method() === "POST" && /\/external-play\/room\/act(\?|$)/.test(new URL(r.url()).pathname));
  await tap(p, "g1", "white");
  await tap(p, "f3", "white");
  const res = await answered;
  expect(res.request().postDataJSON(), "the board sent the move it was given").toEqual({ kind: "move", uci: "g1f3" });
  expect(new URL(res.url()).searchParams.get("t")).toBe(room.white.token);
  expect(res.status()).toBe(200);
  expect(await res.json(), "the server's own refusal").toMatchObject({
    ok: true,
    data: { ok: false, reconcile: false, reason: "lichess_reconsent_required" },
  });

  await expect.poll(() => screenOf(p)).toBe("relink");
  await expect(p.getByTestId("room-state-relink")).toBeVisible();
  const href = new URL((await p.getByTestId("room-relink").getAttribute("href"))!, "http://x");
  expect(href.pathname, "re-link starts the Lichess link flow").toBe("/api/auth/lichess");
  expect(href.searchParams.get("org")).toBe(room.fixturePath.split("/")[2]);
  expect(href.searchParams.get("next"), "and comes back to this room, with its link").toBe(
    `${room.roomPath}?t=${encodeURIComponent(room.white.token)}`,
  );
  // The re-link screen survives the room's next read (the read never asks the grant).
  await p.waitForResponse((r) => r.request().method() === "GET" && /\/external-play\/room$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
  await p.waitForTimeout(200);
  expect(await screenOf(p)).toBe("relink");
  expect((await bridgeRow(room.fixtureId))?.move_count, "nothing was played").toBe(2);
  await ctx.close();
});

test("a held board (review I2): a game nobody may act on reads as held — the board view-only, no \"your move\", no game actions, the held notice — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, longName()] });
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  // The pair first: on the live board, White (to move) may move.
  expect(await screenOf(p)).toBe("live");
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "true");
  await expect(p.getByTestId("room-clock-you")).toHaveAttribute("data-active", "true");
  await expect(p.getByTestId("room-resign")).toBeVisible();

  // A mid-game diagnosis: play.ts refuses every act on such a board (its
  // frozenSeats), so the room must not offer one. The next poll reads it.
  await withDb(
    (sql) => sql`
      update fixture_external_play
         set status = 'needs_organiser', needs_reason = 'provider_error', updated_at = now()
       where fixture_id = ${room.fixtureId}`,
  );
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "a poll reads the hold" }).toBe("held");
  await expect(p.getByTestId("room-seam-held")).toContainText(uiEn["externalPlay.room.state.held.title"]!);
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "false");
  await boardReady(p);
  expect(await piecesOnBoard(p), "the board is still the ledger's").toEqual(piecesOf(fen));
  await expect(p.getByTestId("room-clock-you")).toHaveAttribute("data-active", "false");
  await expect(p.getByTestId("room-clock-opponent")).toHaveAttribute("data-active", "false");
  await expect(p.getByText(uiEn["externalPlay.room.yourMove"]!, { exact: true })).toHaveCount(0);
  await expect(p.getByTestId("room-resign")).toHaveCount(0);
  await expect(p.getByTestId("room-draw")).toHaveCount(0);
  await expect(p.getByTestId("room-abort")).toHaveCount(0);
  // White's own piece, White to move: a tap selects nothing on a held board.
  expect(await pieceUnder(p, "g1", "white")).toBe("g1");
  await tap(p, "g1", "white");
  await p.waitForTimeout(300); // two frames: a dot, if one were coming, is painted
  expect(await squaresWith(p, "move-dest"), "no destinations on a held board").toEqual([]);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "held");
  await ctx.close();
});

test("Seam A, the Lichess link revoked: the frozen player's board dimmed and read-only, Seat on hold, Link Lichess again, Back to fixture — the opponent plays on; both frozen, each reads the neutral hold, never A (R2-1) — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, longName()] });
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  // The pair first: the live board, White to move.
  expect(await screenOf(p)).toBe("live");
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "true");

  // T12's mid-game diagnosis: White's grant was revoked on Lichess. The
  // hold freezes White's seat (V442 revoked_seat); the next poll reads it.
  const freeze = (seat: "white" | "both") =>
    withDb(
      (sql) => sql`
        update fixture_external_play
           set status = 'needs_organiser', needs_reason = 'token_revoked', revoked_seat = ${seat}, updated_at = now()
         where fixture_id = ${room.fixtureId}`,
    );
  await freeze("white");
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "a poll reads the freeze" }).toBe("revoked");
  const notice = p.getByTestId("room-revoked-notice");
  await expect(notice).toContainText(uiEn["externalPlay.room.state.revoked.title"]!);
  await expect(notice).toContainText(uiEn["externalPlay.room.state.revoked.body"]!);
  const relink = p.getByTestId("room-revoked-relink");
  await expect(relink).toHaveText(uiEn["externalPlay.room.state.revoked.relink"]!);
  const href = new URL((await relink.getAttribute("href"))!, "http://x");
  expect(href.pathname, "Link Lichess again starts the Lichess link flow").toBe("/api/auth/lichess");
  expect(href.searchParams.get("org")).toBe(room.fixturePath.split("/")[2]);
  expect(href.searchParams.get("next"), "and comes back to this room, with its link").toBe(`${room.roomPath}?t=${encodeURIComponent(room.white.token)}`);
  // Owner tweak 1: the room's own words for the way back.
  const back = p.getByTestId("room-back-to-fixture");
  await expect(back).toHaveText(uiEn["externalPlay.room.backToFixture"]!);
  await expect(back).toHaveAttribute("href", room.fixturePath);
  // The board: the ledger's, dimmed (canvas: opacity .5, grayscale .35), read-only, and says why.
  await boardReady(p);
  expect(await piecesOnBoard(p), "the board is still the ledger's").toEqual(piecesOf(fen));
  const surface = p.getByTestId("room-board-surface");
  await expect(surface).toHaveAttribute("data-movable", "false");
  await expect(surface).toHaveAttribute("aria-label", uiEn["externalPlay.room.board.seatOnHold"]!);
  const look = await p.getByTestId("room-board").evaluate((el) => ({ opacity: getComputedStyle(el).opacity, filter: getComputedStyle(el).filter }));
  expect(look).toEqual({ opacity: "0.5", filter: "grayscale(0.35)" });
  expect(await pieceUnder(p, "g1", "white")).toBe("g1");
  await tap(p, "g1", "white");
  await p.waitForTimeout(300); // two frames: a dot, if one were coming, is painted
  expect(await squaresWith(p, "move-dest"), "no destinations on a seat on hold").toEqual([]);
  // The clocks: yours reads Seat on hold, never "your move"; no game actions.
  const you = p.getByTestId("room-clock-you");
  await expect(you).toHaveAttribute("data-active", "false");
  await expect(you).toContainText(fill("externalPlay.room.colourSeatOnHold", { colour: uiEn["externalPlay.room.colour.white"]! }));
  await expect(p.getByText(uiEn["externalPlay.room.yourMove"]!, { exact: true })).toHaveCount(0);
  for (const id of ["room-resign", "room-draw", "room-abort", "room-controls"]) await expect(p.getByTestId(id), id).toHaveCount(0);
  // Desktop: the notice and the way back in the aside. Phone: the drawn column.
  await inAside(p, "room-revoked-notice");
  await p.setViewportSize({ width: 320, height: 800 });
  await expect(you).toContainText(uiEn["externalPlay.room.seatOnHold"]!);
  expect(await stackedTopDown(p, ["room-clocks-strip", "room-revoked-notice", "room-board", "room-back-to-fixture"]), "anti-vacuity: pairs").toBe(3);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "a-revoked");

  // The opponent's seat is not frozen: Black's board plays on.
  const bctx = await cold(browser);
  const b = await openRoom(bctx, room, room.black.token);
  expect(await screenOf(b), "the opponent's freeze leaves this board live").toBe("live");
  await expect(b.getByTestId("room-revoked-notice")).toHaveCount(0);
  // Both frozen (final re-review 2, R2-1): nobody can tell from "both" who changed, so neither player is told
  // their link was revoked — each reads the neutral hold, with no re-link.
  await freeze("both");
  await expect.poll(() => screenOf(b), { timeout: 20_000, message: "Black's poll reads both frozen" }).toBe("seatHeld");
  await expect(b.getByTestId("room-clock-you")).toContainText(fill("externalPlay.room.colourSeatOnHold", { colour: uiEn["externalPlay.room.colour.black"]! }));
  await expectNeutralHold(b, { board: true });
  await shoot(b, "a-seat-held");
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "White's poll reads both frozen" }).toBe("seatHeld");
  await expectNeutralHold(p, { board: true });
  await bctx.close();
  await ctx.close();
});

/** R2-1's neutral hold, as a player sees it: the held seam's two lines in A's slot, no re-link and no amber notice,
 *  the way back; the dimmed board exactly when a game is on file; the drawn column on a phone; no sideways scroll. */
async function expectNeutralHold(page: Page, o: { board: boolean }): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  const notice = page.getByTestId("room-seat-held-notice");
  await expect(notice).toContainText(uiEn["externalPlay.room.state.held.title"]!);
  await expect(notice).toContainText(uiEn["externalPlay.room.state.held.body"]!);
  for (const id of ["room-revoked-notice", "room-revoked-relink", "room-controls"]) await expect(page.getByTestId(id), id).toHaveCount(0);
  await expect(page.getByTestId("room-back-to-fixture")).toBeVisible();
  await expect(page.getByTestId("room-board")).toHaveCount(o.board ? 1 : 0);
  if (o.board) await inAside(page, "room-seat-held-notice");
  await page.setViewportSize({ width: 320, height: 800 });
  const column = o.board ? ["room-clocks-strip", "room-seat-held-notice", "room-board", "room-back-to-fixture"] : ["room-seat-held-notice", "room-back-to-fixture"];
  expect(await stackedTopDown(page, column), "anti-vacuity: pairs").toBe(column.length - 1);
  expect(await noSidewaysScroll(page, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
}

test("R2-1, mid-create: a player's change lands while the create is in flight — the changer reads A (no board), the other the neutral hold (no board, no re-link) — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, longName()] });
  // The hold an unlink or a re-link raises on a board whose create was sent and whose game is not on file:
  // account-changed.ts records the PAIRING's seat (White's, here) — staged as that row, the way this spec stages
  // every hold; the producer itself is driven in external-play-account-changed.test.ts.
  const staged = await withDb(
    (sql) => sql`
      update fixture_external_play
         set status = 'needs_organiser', needs_reason = 'account_changed', revoked_seat = 'white',
             create_sent_at = now(), last_error = 'lichess account changed: e2e', updated_at = now()
       where fixture_id = ${room.fixtureId} and challenge_id is null
      returning fixture_id`,
  );
  expect(staged, "premise: the board's bridge, no game on file").toHaveLength(1);
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "White reads the hold" }).toBe("revoked");
  await expect(p.getByTestId("room-revoked-relink")).toBeVisible();
  await expect(p.getByTestId("room-board")).toHaveCount(0);
  const bctx = await cold(browser);
  const b = await openRoom(bctx, room, room.black.token);
  await expect.poll(() => screenOf(b), { timeout: 20_000, message: "Black reads the hold" }).toBe("seatHeld");
  await expectNeutralHold(b, { board: false });
  await shoot(b, "a-seat-held-mid-create");
  await bctx.close();
  await ctx.close();
});

test("Seam A, the game on ANOTHER Lichess account (re-review 5 I-2): White re-links a different account mid-game — A with the account's line, Link Lichess again, read-only — the opponent plays on", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, longName()] });
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  // The pair first: the account the game was created on ⇒ the live board.
  expect(await screenOf(p)).toBe("live");
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "true");
  const linkedNow = `x-${Date.now().toString(36)}`;
  expect(linkedNow, "premise: a different account").not.toBe(room.white.lichessId);
  const relinked = await withDb(
    (sql) => sql`
      update user_external_accounts set external_user_id = ${linkedNow}, username = ${linkedNow}
       where user_id = ${room.white.userId} and provider = 'lichess'
      returning user_id`,
  );
  expect(relinked.length, "White's link was found and re-pointed").toBe(1);
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "a poll reads the other account" }).toBe("revoked");
  const notice = p.getByTestId("room-revoked-notice");
  await expect(notice).toHaveAttribute("data-reason", "account");
  // Re-review 6, N-2: the line names the account the game IS on (the
  // server's record), never the one linked now.
  await expect(notice).toContainText(fill("externalPlay.room.state.revoked.otherAccount", { username: room.white.lichessId }));
  await expect(notice).not.toContainText(linkedNow);
  // Nothing was revoked and no organiser was told: never those words here.
  await expect(notice).not.toContainText(uiEn["externalPlay.room.state.revoked.title"]!);
  await expect(notice).not.toContainText(uiEn["externalPlay.room.state.revoked.body"]!);
  const relink = p.getByTestId("room-revoked-relink");
  await expect(relink).toHaveText(uiEn["externalPlay.room.state.revoked.relink"]!);
  const href = new URL((await relink.getAttribute("href"))!, "http://x");
  expect(href.pathname, "Link Lichess again starts the Lichess link flow").toBe("/api/auth/lichess");
  expect(href.searchParams.get("next"), "and comes back to this room, with its link").toBe(`${room.roomPath}?t=${encodeURIComponent(room.white.token)}`);
  await boardReady(p);
  expect(await piecesOnBoard(p), "the board is still the ledger's").toEqual(piecesOf(fen));
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "false");
  for (const id of ["room-resign", "room-draw", "room-abort", "room-controls", "room-move-notice"]) await expect(p.getByTestId(id), id).toHaveCount(0);
  await inAside(p, "room-revoked-notice");
  // A long recorded name (longer than Lichess's 20 allows) WRAPS on a phone:
  // whole, never truncated — it is what the player signs in with.
  const long = "maximiliana_featherstonehaugh_w";
  await withDb((sql) => sql`update fixture_external_play set white_lichess_id = ${long}, updated_at = now() where fixture_id = ${room.fixtureId}`);
  await expect(notice, "a poll reads the long name").toContainText(fill("externalPlay.room.state.revoked.otherAccount", { username: long }), { timeout: 20_000 });
  await p.setViewportSize({ width: 320, height: 800 });
  const fit = await p.getByTestId("room-revoked-account").evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
  }));
  expect(fit.scroll, "the name is not clipped at 320").toBeLessThanOrEqual(fit.client);
  expect(fit.lines, "it wraps onto more lines").toBeGreaterThan(1);
  expect(await stackedTopDown(p, ["room-clocks-strip", "room-revoked-notice", "room-board", "room-back-to-fixture"]), "anti-vacuity: pairs").toBe(3);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "a-other-account");
  // The opponent's account is as recorded: Black's board plays on.
  const bctx = await cold(browser);
  const b = await openRoom(bctx, room, room.black.token);
  expect(await screenOf(b), "the opponent's board stays live").toBe("live");
  await expect(b.getByTestId("room-revoked-notice")).toHaveCount(0);
  await bctx.close();
  await ctx.close();
});

test("Seam B, online chess off: one calm card — no board, clocks or camera — and Back to fixture, at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(p), "the pair: online chess offered, the check-in").toBe("checkin");
  // Every e2e server runs ONLINE_CHESS_ALWAYS=1, so the flag cannot be off
  // here; when it is, the server answers `onlineChessOff` for a board with no
  // game (external-play-room.test.ts). That one field is set at the
  // browser's edge on the server's own read; everything else is the server's.
  let edited = 0;
  await p.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok, "the server read the room").toBe(true);
      body.data.onlineChessOff = true;
      edited += 1;
      await route.fulfill({ response: res, json: body });
    },
  );
  await expect.poll(() => screenOf(p), { timeout: 25_000, message: "the next poll (IDLE_POLL_MS) reads it" }).toBe("offForClub");
  expect(edited, "anti-vacuity: reads answered").toBeGreaterThanOrEqual(1);
  const card = p.getByTestId("room-off-for-club");
  await expect(card.getByRole("heading", { name: uiEn["externalPlay.room.state.offForClub.title"]! })).toBeVisible();
  await expect(card).toContainText(uiEn["externalPlay.room.state.offForClub.body"]!);
  const back = card.getByTestId("room-back-to-fixture");
  await expect(back).toHaveText(uiEn["externalPlay.room.backToFixture"]!);
  await expect(back).toHaveAttribute("href", room.fixturePath);
  for (const id of ["room-board", "room-clocks-strip", "room-own-tile", "room-tile-strip", "room-checkin-cta", "room-controls"]) {
    await expect(p.getByTestId(id), id).toHaveCount(0);
  }
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor), "a white card (canvas)").toBe("rgb(255, 255, 255)");
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "b-off");
  await ctx.close();
});

test("Seam C1, offline: a read with no answer shows You're offline — reconnecting… between the clocks and the board; the next answered read ends it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  await expect(p.getByTestId("room-move-notice"), "the empty case: no notice on a clean board").toHaveCount(0);
  // The connection drops: the room's reads get no answer at all.
  let cut = 0;
  const offline = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    cut += 1;
    await route.abort("internetdisconnected");
  };
  const isRead = (u: URL) => /\/external-play\/room$/.test(u.pathname);
  await p.route(isRead, offline);
  const notice = p.getByTestId("room-move-notice");
  await expect(notice).toHaveAttribute("data-kind", "offline", { timeout: 15_000 });
  await expect(notice).toContainText(uiEn["externalPlay.room.notice.offline.title"]!);
  await expect(notice).toContainText(uiEn["externalPlay.room.notice.offline.body"]!);
  expect(cut, "anti-vacuity: reads cut off").toBeGreaterThanOrEqual(1);
  await expect(p.getByTestId("room-board-surface"), "the board plays on").toHaveAttribute("data-movable", "true");
  await inAside(p, "room-move-notice");
  await p.setViewportSize({ width: 320, height: 800 });
  expect(await stackedTopDown(p, ["room-clocks-strip", "room-move-notice", "room-board", "room-controls"]), "anti-vacuity: pairs").toBe(3);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "c1-offline");
  // Back online: the next read that gets an answer ends it.
  await p.unroute(isRead, offline);
  await expect(notice, "an answered read ends C1").toHaveCount(0, { timeout: 15_000 });
  expect(await screenOf(p)).toBe("live");
  // The browser's own lines for the reads this test cut off, and nothing else.
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !CUT_OFF.test(e)));
  await ctx.close();
});

test("a move a RULE refused (400): C3 under the board — the room is not gone, it re-reads at once, keeps polling, puts the board back and keeps the line", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  const reads: number[] = [];
  p.on("response", (r) => {
    if (r.request().method() === "GET" && /\/external-play\/room$/.test(new URL(r.url()).pathname)) reads.push(r.status());
  });
  let readsAtAct = -1;
  // A rule refusing the move (notice routing ruling: 400 — the move string
  // itself), as v1 answers it. The board sends chess.js-legal UCI, so only an
  // interception reaches C3 in a browser.
  await p.route("**/external-play/room/act**", async (route: Route) => {
    readsAtAct = reads.length;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: "INVALID_UCI", message: "Not a move" }, requestId: "e2e" }),
    });
  });
  await tap(p, "g1", "white");
  await tap(p, "f3", "white");
  await expect.poll(() => readsAtAct, { message: "the move was sent" }).toBeGreaterThanOrEqual(0);
  // One re-read at once, then the live poll carries on (LIVE_POLL_MS, 3 s):
  // three reads after the refusal, every one answered.
  await expect.poll(() => reads.length - readsAtAct, { timeout: 20_000, message: "the room keeps reading" }).toBeGreaterThanOrEqual(3);
  expect(reads.slice(readsAtAct).every((s) => s === 200), `reads after the 400: ${reads.slice(readsAtAct).join(",")}`).toBe(true);
  expect(await screenOf(p), "still the live board, never the gone card").toBe("live");
  await expect.poll(() => piecesOnBoard(p), { message: "the knight is back where the ledger has it" }).toEqual(piecesOf(fen));
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "true");
  // Seam C3 (canvas MoveInvalidPhone): a rule refused it — the purple line
  // under the board, kept through every read since (the board did not change).
  const notice = p.getByTestId("room-move-notice");
  await expect(notice).toHaveAttribute("data-kind", "invalid");
  await expect(notice).toHaveText(uiEn["externalPlay.room.notice.invalid"]!);
  await inAside(p, "room-move-notice");
  await p.setViewportSize({ width: 320, height: 800 });
  expect(await stackedTopDown(p, ["room-clocks-strip", "room-board", "room-move-notice", "room-controls"]), "anti-vacuity: pairs").toBe(3);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "c3-invalid");
  // The browser's own notice of the 400 it was handed (Chrome logs every
  // failed fetch): this test's refusal and nothing else.
  const own = consoleErrors.filter((e) => /status of 400/.test(e));
  expect(own.length, "the one refused act").toBeLessThanOrEqual(1);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/status of 400/.test(e)));
  await ctx.close();
});

test("play's 404, a move racing into a hold (re-review 5 I-1): C2 — never C3 — then the re-read shows the board held, and no notice comes back when the hold lifts at the same ply", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  expect(await screenOf(p)).toBe("live");
  await expect(p.getByTestId("room-move-notice"), "the empty case: no notice on a clean board").toHaveCount(0);
  // The room's reads wait at a gate, so the hold lands while this client
  // still shows the live board — the race the review found.
  const isRead = (u: URL) => /\/external-play\/room$/.test(u.pathname);
  let open!: () => void;
  const opened = new Promise<void>((done) => (open = done));
  let gated = 0;
  const gate = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    gated += 1;
    await opened;
    await route.continue();
  };
  await p.route(isRead, gate);
  await p.waitForTimeout(1_000); // a read already in flight lands before the hold
  const setHold = (on: boolean) =>
    withDb(
      (sql) => sql`
        update fixture_external_play
           set status = ${on ? "needs_organiser" : "live"}, needs_reason = ${on ? "provider_error" : null}, updated_at = now()
         where fixture_id = ${room.fixtureId}`,
    );
  await setHold(true);
  // Nothing intercepted on the act: the REAL server refuses the move (play.ts:
  // no playable game on a provider_error hold) with its 404.
  const answered = p.waitForResponse((r) => r.request().method() === "POST" && /\/external-play\/room\/act$/.test(new URL(r.url()).pathname));
  await tap(p, "g1", "white");
  await tap(p, "f3", "white");
  const res = await answered;
  expect(res.request().postDataJSON(), "the board sent the move").toEqual({ kind: "move", uci: "g1f3" });
  expect(res.status(), "play's own 404").toBe(404);
  const notice = p.getByTestId("room-move-notice");
  await expect(notice, "C2 — the board, not a rule").toHaveAttribute("data-kind", "refused");
  await expect(notice).toContainText(uiEn["externalPlay.room.notice.refused.title"]!);
  await expect(notice).toContainText(uiEn["externalPlay.room.notice.refused.body"]!);
  await expect(notice).not.toContainText(uiEn["externalPlay.room.notice.invalid"]!);
  await expect.poll(() => piecesOnBoard(p), { message: "the knight is back where the ledger has it" }).toEqual(piecesOf(fen));
  expect(gated, "anti-vacuity: the re-read is waiting at the gate").toBeGreaterThanOrEqual(1);
  await p.setViewportSize({ width: 320, height: 800 });
  expect(await stackedTopDown(p, ["room-clocks-strip", "room-move-notice", "room-board"]), "anti-vacuity: pairs").toBe(2);
  await shoot(p, "c2-play-404");
  // The gate opens (every read from now passes straight through): the read
  // says what the board is — held — and that screen outranks the notice,
  // which is gone with it.
  open();
  await expect.poll(() => screenOf(p), { timeout: 15_000, message: "the re-read shows the hold" }).toBe("held");
  await expect(notice).toHaveCount(0);
  // The hold lifts at the SAME ply: the live board, and no stale notice.
  await setHold(false);
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "a poll reads the lift" }).toBe("live");
  expect(await piecesOnBoard(p), "the same ply").toEqual(piecesOf(fen));
  await expect(notice, "never back after the lift").toHaveCount(0);
  await p.waitForTimeout(3_500); // one more poll
  await expect(notice).toHaveCount(0);
  expect(await noSidewaysScroll(p, [320, 768, 1280]), "anti-vacuity: widths").toBe(3);
  // The browser's own line for play's 404, and nothing else.
  const own = consoleErrors.filter((e) => /status of 404/.test(e));
  expect(own.length, "the one refused act").toBeLessThanOrEqual(1);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/status of 404/.test(e)));
  await ctx.close();
});

test("promotion: the sheet opens on the last rank, Cancel puts the pawn back, a Knight is sent with its suffix", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const line = ["e2e4", "d7d5", "e4d5", "c7c6", "d5c6", "g8f6", "c6b7", "f6g4"];
  const { fen } = await seedGameSql(room, { moves: line });
  expect(new Chess(fen).moves({ square: "b7" as never }), "the rules offer the promotion").toContain("bxa8=N");

  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  const acts = await catchActs(p);

  await tap(p, "b7", "white");
  await tap(p, "a8", "white");
  await expect(p.getByTestId("room-promotion")).toBeVisible();
  await expect(p.getByTestId("room-promotion")).toContainText(fill("externalPlay.room.promote.title", { square: "a8" }));
  await shoot(p, "promotion");
  await p.getByTestId("room-promote-cancel").click();
  await expect(p.getByTestId("room-promotion")).toHaveCount(0);
  await expect.poll(() => piecesOnBoard(p)).toEqual(piecesOf(fen));
  expect(acts.bodies, "Cancel sends nothing").toEqual([]);

  await tap(p, "b7", "white");
  await tap(p, "a8", "white");
  await p.getByTestId("room-promote-n").click();
  await expect.poll(() => acts.bodies.length).toBe(1);
  expect(acts.bodies[0]).toEqual({ kind: "move", uci: "b7a8n" });
  await expect.poll(() => piecesOnBoard(p)).toEqual(piecesOf(fen));
  await ctx.close();
});

test("a draw offer: the player offered sees Decline and Accept draw; the one who offered sees Draw offered, parked", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: ["e2e4", "e7e5", "g1f3"], drawOfferBy: "black" });

  const wctx = await cold(browser);
  const w = await openRoom(wctx, room, room.white.token);
  // The canvas: "<first name> offers a draw / Making a move turns it down."
  await expect(w.getByTestId("room-draw-offer")).toContainText(
    fill("externalPlay.room.drawOfferIncoming", { name: room.black.name.split(" ")[0]! }),
  );
  await expect(w.getByTestId("room-draw-offer")).toContainText(uiEn["externalPlay.room.drawOfferHint"]!);
  await expect(w.getByTestId("room-draw-decline")).toHaveText(uiEn["externalPlay.room.declineDraw"]!);
  await expect(w.getByTestId("room-draw-accept")).toHaveText(uiEn["externalPlay.room.acceptDraw"]!);
  await expect(w.getByTestId("room-resign")).toBeVisible();
  await expect(w.getByTestId("room-draw-offered")).toHaveCount(0);
  await shoot(w, "draw-offer");
  // Notice routing (ruling 2026-10-12): a decline our server failed (a 503)
  // is never silent and never "isn't allowed" — the generic C2, in C2's place.
  await w.route("**/external-play/room/act**", (route: Route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: "unavailable", message: "Unavailable" }, requestId: "e2e" }),
    }),
  );
  await w.getByTestId("room-draw-decline").click();
  const notice = w.getByTestId("room-move-notice");
  await expect(notice).toHaveAttribute("data-kind", "failed");
  await expect(notice).toHaveText(uiEn["externalPlay.room.notice.failed"]!);
  await expect(notice).not.toContainText(uiEn["externalPlay.room.notice.invalid"]!);
  await inAside(w, "room-move-notice");
  await w.setViewportSize({ width: 320, height: 800 });
  expect(await stackedTopDown(w, ["room-clocks-strip", "room-move-notice", "room-board", "room-controls"]), "anti-vacuity: pairs").toBe(3);
  expect(await noSidewaysScroll(w, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(w, "c2-generic");
  const own = consoleErrors.filter((e) => /status of 503/.test(e));
  expect(own.length, "the one failed act").toBeLessThanOrEqual(1);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/status of 503/.test(e)));
  await wctx.close();

  const bctx = await cold(browser);
  const b = await openRoom(bctx, room, room.black.token);
  await expect(b.getByTestId("room-draw-offered")).toHaveText(uiEn["externalPlay.room.drawOffered"]!);
  await expect(b.getByTestId("room-draw-offered")).toBeDisabled();
  await expect(b.getByTestId("room-draw-accept")).toHaveCount(0);
  await expect(b.getByTestId("room-draw-decline")).toHaveCount(0);
  await bctx.close();
});

test("before both have moved: Draw after move 1 is parked, Abort game asks first, and Cancel sends nothing", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: [] });

  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(p)).toBe("live");
  const acts = await catchActs(p);
  await expect(p.getByTestId("room-draw")).toHaveText(uiEn["externalPlay.room.drawAfterMoveOne"]!);
  await expect(p.getByTestId("room-draw")).toBeDisabled();
  await expect(p.getByTestId("room-abort")).toHaveText(uiEn["externalPlay.room.abort"]!);
  await p.getByTestId("room-abort").click();
  await expect(p.getByRole("dialog")).toContainText(uiEn["externalPlay.room.abortConfirm.title"]!);
  await expect(p.getByRole("dialog")).toContainText(uiEn["externalPlay.room.abortConfirm.body"]!);
  await expect(p.getByRole("dialog").getByRole("button", { name: uiEn["externalPlay.room.abort"]!, exact: true })).toBeVisible();
  await expect(p.getByRole("dialog"), "no raw key paints").not.toContainText("externalPlay.");
  await shoot(p, "abort-confirm");
  await p.getByRole("dialog").getByRole("button", { name: uiEn["externalPlay.room.cancel"]! }).click();
  await expect(p.getByRole("dialog")).toHaveCount(0);
  expect(acts.bodies, "Cancel sends nothing").toEqual([]);
  await ctx.close();
});

test("game over: the result from our record, the final board, Back to fixture and Standings, no game actions", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  // Fool's mate: Black mates on move 2.
  const { fen } = await seedGameSql(room, { moves: ["f2f3", "e7e5", "g2g4", "d8h4"], finished: true });
  expect(new Chess(fen).isCheckmate(), "the rules agree it is mate").toBe(true);
  // The result, through the organiser's own scoring API (what reconcile writes).
  const started = await apiJson(page.request, `/api/v1/fixtures/${room.fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const result = await apiJson(page.request, `/api/v1/fixtures/${room.fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "boardgame.result",
    payload: { winner: room.black.entrantId, method: "checkmate" },
  });
  expect(result.status, JSON.stringify(result.error)).toBeLessThan(300);

  let rooms = 0;
  for (const [me, headline] of [
    [room.black, "externalPlay.room.over.won"],
    [room.white, "externalPlay.room.over.lost"],
  ] as const) {
    const ctx = await cold(browser);
    const p = await openRoom(ctx, room, me.token);
    expect(await screenOf(p)).toBe("over");
    await expect(p.getByTestId("room-result")).toContainText(uiEn[headline]!);
    // The canvas's line: "Checkmate · 1–0" — here Black won.
    await expect(p.getByTestId("room-result")).toContainText("Checkmate · 0–1");
    await expect(p.getByTestId("room-result")).toContainText(uiEn["externalPlay.room.over.onFixture"]!);
    await boardReady(p);
    expect(await piecesOnBoard(p)).toEqual(piecesOf(fen));
    await expect(p.getByTestId("room-back-to-fixture")).toHaveAttribute("href", room.fixturePath);
    await expect(p.getByTestId("room-standings")).toHaveAttribute("href", room.standingsPath);
    await expect(p.getByTestId("room-resign")).toHaveCount(0);
    await expect(p.getByTestId("room-draw")).toHaveCount(0);
    if (me === room.black) await shoot(p, "over");
    rooms += 1;
    await ctx.close();
  }
  expect(rooms).toBe(2);
});

test("a link that does not resolve: the neutral card, never a 500, with the way back", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const ctx = await cold(browser);
  const p = await ctx.newPage();
  // Junk is refused; so is a real player's link with its signature altered.
  for (const t of ["not-a-link", room.white.token.slice(0, -4) + "AAAA"]) {
    const res = await p.goto(`${room.roomPath}?t=${encodeURIComponent(t)}`);
    expect(res?.status()).toBe(200);
    await expect(p.getByRole("heading", { name: uiEn["externalPlay.room.state.unavailable.title"]! })).toBeVisible();
    await expect(p.getByText(uiEn["externalPlay.room.state.unavailable.body"]!)).toBeVisible();
    await expect(p.getByRole("link", { name: uiEn["externalPlay.room.backToFixture"]! })).toHaveAttribute("href", room.fixturePath);
  }
  await shoot(p, "unavailable");
  await ctx.close();
});

test("fix round 4b: while the organiser re-pairs the round, the open room reads on through the gap on its own card — at every width — and the re-paired board's read takes it back", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(p)).toBe("checkin");
  // The gap as the server answers it to the board's own link (external-play-room.test.ts; the walkthrough drives the
  // real Unpair → Generate): every read inside it, until the board is paired again.
  let gap = true;
  let inGap = 0;
  await p.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (gap && route.request().method() === "GET") {
        inGap += 1;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { code: "ROOM_BEING_REPAIRED", message: "This board is being re-paired" }, requestId: "e2e" }),
        });
        return;
      }
      await route.continue();
    },
  );
  await expect.poll(() => screenOf(p), { timeout: 25_000, message: "the next poll (IDLE_POLL_MS) reads the gap" }).toBe("repairing");
  await expect(p.getByRole("heading", { name: uiEn["externalPlay.room.state.repairing.title"]! })).toBeVisible();
  await expect(p.getByText(uiEn["externalPlay.room.state.repairing.body"]!)).toBeVisible();
  await expect(p.getByTestId("room-checkin-cta"), "the old pairing's check-in is not offered").toHaveCount(0);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "repairing");
  const readsInGap = inGap;
  await expect.poll(() => inGap, { timeout: 25_000, message: "the room keeps reading through the gap" }).toBeGreaterThan(readsInGap);
  gap = false;
  await expect.poll(() => screenOf(p), { timeout: 25_000, message: "the re-paired board's read" }).toBe("checkin");
  // The gap's reads are the browser's own failed loads: expected here, and only those.
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/status of 409/.test(e)));
  await ctx.close();
});

test("T17B fix 1: the room's document may use the camera — served Permissions-Policy camera=(self), one header, and the browser agrees (a real camera request starts) — while the board's own public page may not", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  // Headless Chromium has no capture device (getUserMedia: NotSupportedError), which would hide a policy refusal.
  // Its fake device makes the request real, so "granted" vs "NotAllowedError" is the POLICY's answer alone — a
  // browser of this test's own, since launch flags are per browser (the project's is shared).
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const ctx = await cold(camBrowser);
  await ctx.grantPermissions(["camera"]);
  const p = await openRoom(ctx, room, room.white.token);
  /** What this DOCUMENT may use (Chromium: document.featurePolicy) and what a camera request answers. */
  const probe = () =>
    p.evaluate(async () => {
      const d = document as Document & { featurePolicy?: { allowsFeature(f: string): boolean } };
      const allows = d.featurePolicy
        ? { camera: d.featurePolicy.allowsFeature("camera"), microphone: d.featurePolicy.allowsFeature("microphone"), geolocation: d.featurePolicy.allowsFeature("geolocation") }
        : null;
      const camera = await navigator.mediaDevices.getUserMedia({ video: true }).then(
        (stream) => {
          for (const track of stream.getTracks()) track.stop();
          return "granted";
        },
        (err: Error) => err.name,
      );
      return { allows, camera };
    });
  const policiesOf = async (res: Awaited<ReturnType<Page["reload"]>>) =>
    (await res!.headersArray()).filter((h) => h.name.toLowerCase() === "permissions-policy").map((h) => h.value);

  // The room: reloaded so the test holds the DOCUMENT's own response (the policy is the document's, fixed at load).
  const roomRes = await p.reload();
  expect(roomRes?.status(), "the room renders").toBe(200);
  // Soft: a wrong header must not hide what the browser does with it — both are reported.
  expect.soft(await policiesOf(roomRes), "one header, the room's").toEqual(["camera=(self), microphone=(), geolocation=()"]);
  const inRoom = await probe();
  expect(inRoom.allows, "the browser lets the room use the camera — and nothing else").toEqual({ camera: true, microphone: false, geolocation: false });
  expect(inRoom.camera, "the room's camera request starts").toBe("granted");

  // The board's own public page — the lobby the player came from — keeps the camera off.
  const fixtureRes = await p.goto(room.fixturePath);
  expect(fixtureRes?.status()).toBe(200);
  expect(await policiesOf(fixtureRes), "one header, the site's").toEqual(["camera=(), microphone=(), geolocation=()"]);
  const onFixture = await probe();
  expect(onFixture.allows).toEqual({ camera: false, microphone: false, geolocation: false });
  expect(onFixture.camera, "refused by policy").toBe("NotAllowedError");
  // Chrome reports that refusal itself, as the policy violation it is: expected here, and only here.
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/Permissions policy violation: camera is not allowed/.test(e)));
  await ctx.close();
  await camBrowser.close();
});

test("round not opened: the player, signed in, is told so — no check-in", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    open: false,
  });
  const ctx = await cold(browser);
  const p = await ctx.newPage();
  await loginUi(p, room.white.email, room.roomPath);
  await p.waitForURL((u) => u.pathname === room.roomPath);
  expect(await screenOf(p)).toBe("notOpened");
  await expect(p.getByRole("heading", { name: uiEn["externalPlay.room.state.notOpened.title"]! })).toBeVisible();
  await expect(p.getByTestId("room-checkin-cta")).toHaveCount(0);
  await shoot(p, "not-opened");
  await ctx.close();
});
