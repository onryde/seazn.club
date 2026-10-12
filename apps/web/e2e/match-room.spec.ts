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

async function openRoom(ctx: BrowserContext, room: SeededRoom, token: string, width = 1280): Promise<Page> {
  const page = await ctx.newPage();
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
