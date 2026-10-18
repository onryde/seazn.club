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
import { SOUND_SIGNATURE } from "../src/components/public-site/match-room/room-sound-synth";
import { HANDOVER_COVER_MS } from "../src/components/public-site/match-room/camera-handover";
import { LINE_ABANDON_AFTER_MS, LINE_POLL_MIN_MS, LINE_POLL_MS, SEAT_ASK_WINDOW_S } from "../src/components/public-site/match-room/room-snapshot";
import { WINDOW_OPEN_LEAD_MS } from "../src/server/external-play/window";
import { apiJson, loginUi, withDb } from "./helpers";
import { REALTIMEKIT_FIXTURE_ENV, REALTIMEKIT_FIXTURE_URL, startRealtimeKitFixtureServer, type RealtimeKitFixtureServer } from "./realtimekit-fixture-server";
import { mintMatchRoomLink } from "./match-room-link";
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

async function shoot(page: Page, name: string, widths: number[] = [320, 768, 1280]): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize();
  for (const width of widths) {
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

/** D16 (§5.6.3): a camera that has a seat reports its state to the server. Several tests below STAGE a seat answer (a
 *  participant id and a token the SDK will refuse) that names no participant on file, and the server's one answer for a
 *  seat in no meeting is the room's 404 - which Chrome logs as a console error naming no URL but this one. That 404 is the
 *  staging's, not the room's: a production seat answer always names the participant it just stored. The D16 pill test
 *  below stores its participants and takes NO exemption, so a 404 there fails it. */
function isStagedSeatReport404(m: import("@playwright/test").ConsoleMessage): boolean {
  return /^Failed to load resource: the server responded with a status of 404/.test(m.text()) && /\/external-play\/room\/camera-report/.test(m.location().url);
}

async function openRoom(ctx: BrowserContext, room: SeededRoom, token: string, width = 1280): Promise<Page> {
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !SITE_WIDE.has(m.text()) && !isStagedSeatReport404(m)) consoleErrors.push(m.text().slice(0, 300));
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

/** T17B fix 2 (D12): every painted box in the room lies inside the viewport, at each width. The page CLIPS
 *  (globals.css `html, body { overflow-x: clip }`), so a box past the right edge is cut off, never scrolled to — and
 *  noSidewaysScroll cannot see it (the owner's Open 4: the right clock, the camera tile, the pill, the buttons and the
 *  help text ran off a desktop window with no scrollbar). Names the offenders; counts boxes and widths. */
async function nothingPastTheEdge(page: Page, widths: number[]): Promise<number> {
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const out = await page.getByTestId("match-room").evaluate((root) => {
      const vw = document.documentElement.clientWidth;
      const bad: string[] = [];
      let boxes = 0;
      for (const el of [root, ...root.querySelectorAll("*")]) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        boxes += 1;
        if (r.right > vw + 0.5 || r.left < -0.5) {
          const id = (el as HTMLElement).dataset?.testid ?? String((el as HTMLElement).className ?? "").slice(0, 70);
          bad.push(`${el.tagName.toLowerCase()}[${id}] ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        }
      }
      return { bad: bad.slice(0, 10), boxes };
    });
    expect(out.boxes, `anti-vacuity: boxes painted at ${width}px`).toBeGreaterThan(20);
    expect(out.bad, `nothing past the edge at ${width}px`).toEqual([]);
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
  // T17B fix 2 (D7): the cascade, not the class list — Tailwind v4's preflight gives <button> the arrow; the hand
  // must win while it can be pressed, and must NOT show once it is disabled.
  const cursor = () => p.getByTestId("room-checkin-cta").evaluate((el) => getComputedStyle(el).cursor);
  expect(await cursor(), "a pressable button shows the hand").toBe("pointer");
  await p.getByTestId("room-checkin-cta").click();
  await expect(p.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
  await expect(p.getByTestId("room-checkin-cta")).toBeDisabled();
  expect(await cursor(), "a disabled one does not").toBe("not-allowed");
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
  expect(await stackedTopDown(p, ["room-clock-opponent", "room-move-notice", "room-board", "room-clock-you", "room-controls"]), "anti-vacuity: pairs").toBe(4);
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

test("T17B fix 2, D12: the live room under a camera policy — clocks, board, camera tile, notice, controls — is painted inside the window at every desktop width (1024–1440), the laptop's 1100 and the phones", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [longName(), longName()], cameraPolicy: "required" });
  await seedGameSql(room, { moves: ["e2e4", "e7e5"], whiteMs: 300_000, blackMs: 296_000 });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  expect(await screenOf(p)).toBe("live");
  // The owner's room had a LIVE camera; no browser here can make a RealtimeKit peer, so the camera is staged (controller
  // hypothesis: a real <video>'s intrinsic width, 1280 px, unconstrained): a 1280x720 canvas stream goes into the tile's OWN
  // <video>, unhidden as a stream unhides it. The opponent's pill is REAL since D16 (it is a field of the snapshot, the
  // opponent's own report relayed): nobody has reported, so it is the "unknown" pill - the longest of the three texts, so the
  // widest the pill ever gets beside a 43-character name.
  await expect(p.getByTestId("room-presence-pill"), "the real pill, the empty-case state").toHaveAttribute("data-state", "unknown");
  const intrinsic = await p.getByTestId("room-own-tile").evaluate(async (tile) => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    canvas.getContext("2d")!.fillRect(0, 0, 1280, 720);
    const video = tile.querySelector("video")!;
    video.classList.remove("hidden");
    video.srcObject = canvas.captureStream(5);
    await video.play().catch(() => {});
    await new Promise((r) => (video.videoWidth > 0 ? r(null) : video.addEventListener("loadedmetadata", r, { once: true })));
    return video.videoWidth;
  });
  expect(intrinsic, "the staged stream is the wide one").toBe(1280);
  // The right column's parts are there to be measured (the premise of the sweep).
  for (const id of ["room-clock-opponent", "room-clock-you", "room-tile-strip", "room-controls", "room-camera-notice", "room-presence-pill"]) {
    await expect(p.getByTestId(id), id).toBeVisible();
  }
  const WIDTHS = [1024, 1100, 1180, 1280, 1366, 1440, 768, 834, 320, 375];
  expect(await nothingPastTheEdge(p, WIDTHS), "anti-vacuity: widths").toBe(WIDTHS.length);
  expect(await noSidewaysScroll(p, WIDTHS)).toBe(WIDTHS.length);
  await shoot(p, "d12-live-camera");
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

test("T17B fix 2, D13: at the mover's flag the room locks — the board takes no move, Resign and Offer draw are off, it says it is confirming with Lichess; held, that the organiser is; the result replaces it — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, longName()] });
  // White to move, 4 s on its clock as at the last move (now). The kit's Lichess tokens can never be opened (its
  // header), so the server's read behind a clock-zero report would answer 503: the report is answered here, at the
  // browser's edge, as "nothing to read yet" — and counted, so the lock is seen to coincide with the room asking.
  // The server's held read is the walkthrough's (chess-external-play.spec.ts, D11).
  await seedGameSql(room, { moves: ["e2e4", "e7e5"], whiteMs: 4_000, blackMs: 240_000 });
  const ctx = await cold(browser);
  let zeroReports = 0;
  await ctx.route("**/external-play/room/clock-zero*", async (route: Route) => {
    zeroReports += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { reconciled: false }, requestId: "e2e" }) });
  });
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  // The pair first: above zero, the board and the actions are White's.
  expect(await screenOf(p)).toBe("live");
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "true");
  await expect(p.getByTestId("room-resign")).toBeEnabled();
  await expect(p.getByTestId("room-draw")).toBeEnabled();
  await expect(p.getByTestId("room-flag-notice")).toHaveCount(0);

  // At zero: locked, and the room says why.
  await expect(p.getByTestId("room-flag-notice")).toHaveAttribute("data-kind", "lichess", { timeout: 15_000 });
  await expect(p.getByTestId("room-flag-notice")).toHaveText(uiEn["externalPlay.room.flag.lichess"]!);
  await expect(p.getByTestId("room-clock-you")).toContainText("0:00.0");
  await expect.poll(() => zeroReports, { message: "the room reported the clock at zero" }).toBeGreaterThanOrEqual(1);
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "false");
  await expect(p.getByTestId("room-resign")).toBeDisabled();
  await expect(p.getByTestId("room-draw")).toBeDisabled();
  await expect(p.getByText(uiEn["externalPlay.room.yourMove"]!, { exact: true }), "nobody is told 'your move' at 0:00.0").toHaveCount(0);
  // White's own knight, White to move: a tap selects nothing on a flagged board.
  expect(await pieceUnder(p, "g1", "white")).toBe("g1");
  await tap(p, "g1", "white");
  await p.waitForTimeout(300); // two frames: a dot, if one were coming, is painted
  expect(await squaresWith(p, "move-dest"), "no destinations at the flag").toEqual([]);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "flag-lichess");

  // D11 (b): Lichess has not settled it a minute after the flag — held for the organiser (reconcile's write, here
  // by hand). The organiser is confirming it; never the generic held line.
  await withDb(
    (sql) => sql`
      update fixture_external_play
         set status = 'needs_organiser', needs_reason = 'clock_flag_unsettled', updated_at = now()
       where fixture_id = ${room.fixtureId}`,
  );
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "a poll reads the hold" }).toBe("held");
  await expect(p.getByTestId("room-flag-notice")).toHaveAttribute("data-kind", "organiser");
  await expect(p.getByTestId("room-flag-notice")).toHaveText(uiEn["externalPlay.room.flag.organiser"]!);
  await expect(p.getByTestId("room-seam-held")).toHaveCount(0);
  expect(await noSidewaysScroll(p, ALL_WIDTHS)).toBe(ALL_WIDTHS.length);
  await shoot(p, "flag-organiser");

  // The organiser records it (what the queue's settle writes): the result replaces the lock.
  const started = await apiJson(page.request, `/api/v1/fixtures/${room.fixtureId}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const result = await apiJson(page.request, `/api/v1/fixtures/${room.fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "boardgame.result",
    payload: { winner: room.black.entrantId, method: "time" },
  });
  expect(result.status, JSON.stringify(result.error)).toBeLessThan(300);
  await expect.poll(() => screenOf(p), { timeout: 20_000, message: "a poll reads the result" }).toBe("over");
  await expect(p.getByTestId("room-result")).toContainText(uiEn["externalPlay.room.over.lost"]!);
  await expect(p.getByTestId("room-flag-notice")).toHaveCount(0);
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
  // hold freezes White's seat (V454 revoked_seat); the next poll reads it.
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
  expect(await stackedTopDown(p, ["room-clock-opponent", "room-revoked-notice", "room-board", "room-clock-you", "room-back-to-fixture"]), "anti-vacuity: pairs").toBe(4);
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
  const column = o.board ? ["room-clock-opponent", "room-seat-held-notice", "room-board", "room-clock-you", "room-back-to-fixture"] : ["room-seat-held-notice", "room-back-to-fixture"];
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
  expect(await stackedTopDown(p, ["room-clock-opponent", "room-revoked-notice", "room-board", "room-clock-you", "room-back-to-fixture"]), "anti-vacuity: pairs").toBe(4);
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
  for (const id of ["room-board", "room-clock-opponent", "room-clock-you", "room-own-tile", "room-tile-strip", "room-checkin-cta", "room-controls"]) {
    await expect(p.getByTestId(id), id).toHaveCount(0);
  }
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor), "a white card (canvas)").toBe("rgb(255, 255, 255)");
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "b-off");
  await ctx.close();
});

test("T17B fix 2, D10: the organiser's No result before any game, then its void — the room says the board is closed, never 'setting up', at every width; it asks for nothing, and a re-pair opens it again", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const ctx = await cold(browser);
  const before = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(before), "the pair: an open board is the check-in").toBe("checkin");
  // The measured stg sequence (fixture 0a45d044), through the organiser's own APIs: No result, then the undo.
  const settled = await apiJson(page.request, `/api/v1/fixtures/${room.fixtureId}/external-play/resolve`, "POST", { kind: "no_result" });
  expect(settled.status, JSON.stringify(settled.error)).toBeLessThan(300);
  await expect.poll(() => screenOf(before), { timeout: 25_000, message: "premise: the room reads the No result" }).toBe("over");
  const abandon = await withDb(async (sql) => {
    const [e] = await sql<{ id: string; seq: number; type: string }[]>`
      select id, seq, type from score_events where fixture_id = ${room.fixtureId} order by seq desc limit 1`;
    return e!;
  });
  expect(abandon.type, "premise: the settle wrote the abandon").toBe("core.abandon");
  const voided = await apiJson(page.request, `/api/v1/fixtures/${room.fixtureId}/events`, "POST", {
    expected_seq: abandon.seq, // seq is 1-based: the next expected is the count so far
    type: "core.void",
    payload: { event_id: abandon.id },
  });
  expect(voided.status, JSON.stringify(voided.error)).toBeLessThan(300);
  expect((await bridgeRow(room.fixtureId))?.status, "premise: the bridge stays closed, with no game").toBe("finished");
  // D10b: the tab that showed the No result reads on — slowly (SETTLED_POLL_MS), and at once when it comes back into
  // view — so the void reaches it without a reload.
  await before.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => screenOf(before), { timeout: 10_000, message: "the open tab reads the void" }).toBe("boardClosed");
  await before.close();
  // The players open their rooms after the void — where stg hung on "Setting up" for good.
  // Every page of this context, from before its first paint (a mount claim fires at hydration).
  const posts: string[] = [];
  ctx.on("request", (r) => {
    if (r.method() === "POST" && /\/external-play\/room/.test(new URL(r.url()).pathname)) posts.push(new URL(r.url()).pathname);
  });
  const pages: Page[] = [];
  let checked = 0;
  for (const me of [room.white, room.black]) {
    const p = await openRoom(ctx, room, me.token);
    expect(await screenOf(p), "the first paint: the closed board").toBe("boardClosed");
    const card = p.getByTestId("room-state-board-closed");
    await expect(card.getByRole("heading", { name: uiEn["externalPlay.room.state.boardClosed.title"]! })).toBeVisible();
    await expect(card).toContainText(uiEn["externalPlay.room.state.boardClosed.body"]!);
    await expect(card.getByTestId("room-back-to-fixture")).toHaveAttribute("href", room.fixturePath);
    for (const id of ["room-board", "room-clock-opponent", "room-clock-you", "room-own-tile", "room-checkin-cta", "room-controls", "room-state-creating"]) {
      await expect(p.getByTestId(id), id).toHaveCount(0);
    }
    if (me === room.white) {
      expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
      await shoot(p, "d10-board-closed");
    }
    pages.push(p);
    checked++;
  }
  expect(checked).toBe(2);
  expect(posts, "nothing claimed or sent on a closed board").toEqual([]);
  // A Swiss re-pair deletes the closed row (stages.ts clearSwissFixtureSeats, M-10); the room reads on and opens it.
  await withDb((sql) => sql`delete from fixture_external_play where fixture_id = ${room.fixtureId}`);
  await expect.poll(() => screenOf(pages[0]!), { timeout: 25_000, message: "re-paired: the check-in again" }).toBe("checkin");
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
  expect(await stackedTopDown(p, ["room-clock-opponent", "room-move-notice", "room-board", "room-clock-you", "room-controls"]), "anti-vacuity: pairs").toBe(4);
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
  expect(await stackedTopDown(p, ["room-clock-opponent", "room-board", "room-clock-you", "room-move-notice", "room-controls"]), "anti-vacuity: pairs").toBe(4);
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
  expect(await stackedTopDown(p, ["room-clock-opponent", "room-move-notice", "room-board", "room-clock-you"]), "anti-vacuity: pairs").toBe(3);
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
  expect(await stackedTopDown(w, ["room-clock-opponent", "room-move-notice", "room-board", "room-clock-you", "room-controls"]), "anti-vacuity: pairs").toBe(4);
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
  // T17B fix 2 (m2): a failed assertion must not leave this test's own browser running.
  try {
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
  } finally {
    await camBrowser.close();
  }
});

test("T17B fix 2, D15: camera required — the camera is tested ON THE PAGE before Check in: before, testing, live, each refusal with Test again, a camera that stops; Check in releases the test camera BEFORE the seat is asked for — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    cameraPolicy: "required",
  });
  type W = { __tracks: MediaStreamTrack[]; __hold: Promise<void> | null; __release: (() => void) | null; __fail: string | null };
  // Every camera track the page is handed, so the test reads their state; and, on demand, a held ask (the transient
  // "testing" state, drawn) or a named refusal (each failure reached). Otherwise the REAL getUserMedia answers.
  const instrument = (ctx: BrowserContext) =>
    ctx.addInitScript(() => {
      const w = window as unknown as W;
      w.__tracks = [];
      w.__hold = null;
      w.__release = null;
      w.__fail = null;
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
        if (w.__hold) await w.__hold;
        if (w.__fail) throw new DOMException("e2e", w.__fail);
        const s = await real(c);
        w.__tracks.push(...s.getTracks());
        return s;
      };
    });
  const tracks = (p: Page) => p.evaluate(() => (window as unknown as W).__tracks.map((t) => [t.kind, t.readyState]));
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  // A player who pressed Block: the camera permission DENIED, and no fake UI to answer for them. Measured: only the
  // full Chromium's headless mode then answers NotAllowedError — headless-shell answers NotSupportedError to any
  // ask without the fake UI, and the fake UI grants even a denied permission. `playwright install chromium` ships it.
  const denyBrowser = await browser.browserType().launch({ channel: "chromium", args: ["--use-fake-device-for-media-stream"] });
  try {
    const ctx = await cold(camBrowser);
    await ctx.grantPermissions(["camera"]);
    await instrument(ctx);
    const p = await openRoom(ctx, room, room.white.token);
    expect(await screenOf(p)).toBe("checkin");
    const cta = p.getByTestId("room-checkin-cta");
    const testCta = p.getByTestId("room-checkin-test-cta");
    const failure = p.getByTestId("room-checkin-test-failure");

    // Before the test: Check in waits, and the page says how to open it. Nothing asked for yet.
    await expect(cta).toBeDisabled();
    await expect(testCta).toHaveText(uiEn["externalPlay.room.checkin.test.cta"]!);
    await expect(p.getByText(uiEn["externalPlay.room.checkin.test.needed"]!)).toBeVisible();
    expect(await tracks(p)).toEqual([]);
    expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
    await shoot(p, "d15-before");

    // Testing: the ask held open — the test button waits and says so; Check in still waits.
    await p.evaluate(() => {
      const w = window as unknown as W;
      w.__hold = new Promise<void>((r) => (w.__release = r));
    });
    await testCta.click();
    await expect(testCta).toBeDisabled();
    await expect(testCta).toHaveText(uiEn["externalPlay.room.checkin.test.starting"]!);
    await expect(cta).toBeDisabled();
    await shoot(p, "d15-testing");
    await p.evaluate(() => {
      const w = window as unknown as W;
      w.__hold = null;
      w.__release?.();
    });

    // Live: the preview painted a frame of the camera, and only then does Check in open.
    await expect(cta).toBeEnabled({ timeout: 10_000 });
    await expect(p.getByTestId("room-own-tile")).toHaveAttribute("data-stream", "on");
    await expect(p.getByTestId("room-own-tile")).toContainText(uiEn["externalPlay.room.checkin.cameraOn"]!);
    await expect(testCta, "a working camera needs no test button").toHaveCount(0);
    expect(await tracks(p), "the camera only — no microphone").toEqual([["video", "live"]]);
    expect(await noSidewaysScroll(p, ALL_WIDTHS)).toBe(ALL_WIDTHS.length);
    await shoot(p, "d15-live");

    // The camera stops before Check in (unplugged, taken by another app): Check in waits again, and says so.
    await p.evaluate(() => (window as unknown as W).__tracks[0]!.dispatchEvent(new Event("ended")));
    await expect(failure).toHaveAttribute("data-failure", "ended");
    await expect(failure).toHaveText(uiEn["externalPlay.room.checkin.test.ended"]!);
    await expect(cta).toBeDisabled();
    await shoot(p, "d15-ended");

    // Each refusal the brief names, in its own words, with Test again — and Check in waits after each (counted).
    let refused = 0;
    for (const [name, kind] of [["NotFoundError", "notFound"], ["NotReadableError", "inUse"], ["OverconstrainedError", "other"]] as const) {
      await p.evaluate((n) => ((window as unknown as W).__fail = n), name);
      await testCta.click();
      await expect(failure, name).toHaveAttribute("data-failure", kind);
      await expect(failure, name).toHaveText(uiEn[`externalPlay.room.checkin.test.${kind}`]!);
      await expect(testCta, name).toHaveText(uiEn["externalPlay.room.checkin.test.again"]!);
      await expect(cta, name).toBeDisabled();
      expect(await noSidewaysScroll(p, ALL_WIDTHS)).toBe(ALL_WIDTHS.length);
      await shoot(p, `d15-${kind}`);
      refused += 1;
    }
    expect(refused).toBe(3);

    // Test again, the camera back: live again.
    await p.evaluate(() => ((window as unknown as W).__fail = null));
    await testCta.click();
    await expect(cta).toBeEnabled({ timeout: 10_000 });

    // Check in: the test camera is released BEFORE the seat is asked for (read as the claim arrives). The verdict is
    // composed at the route, as the D2 test below does (no browser here can make a RealtimeKit peer).
    const atClaim: unknown[] = [];
    await p.route(
      (u) => /\/external-play\/room$/.test(u.pathname),
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        if (atClaim.length === 0) atClaim.push(await tracks(p));
        const read = await route.fetch({ method: "GET" });
        const snapshot = ((await read.json()) as { data: unknown }).data;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: { snapshot, seat: { seated: false, reason: "camera_starting", participant: { participantId: "e2e-part", authToken: "e2e-rtk" } }, create: null },
            requestId: "e2e",
          }),
        });
      },
    );
    await cta.click();
    await expect(cta, "the seat is being asked: the D2 wait").toHaveText(uiEn["externalPlay.room.checkin.cameraStarting"]!);
    expect(atClaim, "every test track had ended when the seat was asked for").toEqual([[["video", "ended"], ["video", "ended"]]]);
    await expect(testCta, "handed over: no test to press").toHaveCount(0);
    await ctx.close();
    // The SDK then joins with the token composed above, and the vendor's SDK refuses it, as it refuses the kit's own
    // tokens: expected here, and only here (the D2 test's browser has no camera, so its SDK never joins).
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Invalid auth token provided\. /.test(e)));

    // A real refusal: the browser's own answer to a camera the player blocked.
    const dctx = await cold(denyBrowser);
    await instrument(dctx);
    const d = await openRoom(dctx, room, room.black.token);
    const cdp = await dctx.newCDPSession(d);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.send("Browser.setPermission", {
      permission: { name: "camera" },
      setting: "denied",
      origin: new URL(d.url()).origin,
      browserContextId: targetInfo.browserContextId,
    });
    expect(await d.evaluate(() => navigator.permissions.query({ name: "camera" as PermissionName }).then((r) => r.state)), "premise: blocked").toBe("denied");
    expect(await screenOf(d)).toBe("checkin");
    await d.getByTestId("room-checkin-test-cta").click();
    await expect(d.getByTestId("room-checkin-test-failure")).toHaveAttribute("data-failure", "denied");
    await expect(d.getByTestId("room-checkin-test-failure")).toHaveText(uiEn["externalPlay.room.checkin.test.denied"]!);
    await expect(d.getByTestId("room-checkin-test-cta")).toHaveText(uiEn["externalPlay.room.checkin.test.again"]!);
    await expect(d.getByTestId("room-checkin-cta")).toBeDisabled();
    expect(await noSidewaysScroll(d, ALL_WIDTHS)).toBe(ALL_WIDTHS.length);
    await shoot(d, "d15-denied");
    await dctx.close();
  } finally {
    await camBrowser.close();
    await denyBrowser.close();
  }
});

test("T17B fix 2, D23: Check in under camera required — the tile is NEVER blank between the test camera's stop and the SDK's video: the preview's last frame, mirrored as the live one, labelled, laid over the tile; the picture goes at the bound and the words stay until the wait is over — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    cameraPolicy: "required",
  });
  type Sample = { t: number; video: boolean; picture: boolean; words: boolean };
  type W = { __tile: { log: Sample[]; mark: number; stop: boolean } };
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const ctx = await cold(camBrowser);
    await ctx.grantPermissions(["camera"]);
    const p = await openRoom(ctx, room, room.white.token);
    expect(await screenOf(p)).toBe("checkin");
    const cta = p.getByTestId("room-checkin-cta");
    const tile = p.getByTestId("room-own-tile");
    await p.getByTestId("room-checkin-test-cta").click();
    await expect(cta, "the preview painted a frame: Check in opens").toBeEnabled({ timeout: 10_000 });
    await expect(tile).toHaveAttribute("data-stream", "on");
    await expect(p.getByTestId("room-own-tile-frozen"), "no cover while the test camera is on show").toHaveCount(0);

    // The preview, read BEFORE Check in: how the live video is mirrored, how bright it is, how big the tile is.
    const before = await p.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="room-own-tile"] video')!;
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 48;
      const g = c.getContext("2d")!;
      g.drawImage(v, 0, 0, 64, 48);
      const px = g.getImageData(0, 0, 64, 48).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
      // Tailwind v4's -scale-x-100 is the `scale` property, not `transform`: read both, so any mirroring counts.
      const cs = getComputedStyle(v);
      return { transform: `${cs.transform}|${cs.scale}`, luma: sum / (px.length / 4), size: [v.videoWidth, v.videoHeight] };
    });
    expect(before.luma, "premise: the fake camera's picture is not black").toBeGreaterThan(20);
    expect(before.transform, "premise: the preview is mirrored").not.toBe("none|none");

    // The seat is answered camera_starting with NO participant, so the SDK never joins — it neither paints a frame nor
    // fails (a participant would make it join the fixture's opaque token and fail at once, which ends the cover by the
    // camera's failure: the next test). What ends the wait here is the room's own poll budget. (The SDK's own frame
    // removing the cover is proven at the seam, room-camera-test-wiring.)
    await p.route(
      (u) => /\/external-play\/room$/.test(u.pathname),
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        const read = await route.fetch({ method: "GET" });
        const snapshot = ((await read.json()) as { data: unknown }).data;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: { snapshot, seat: { seated: false, reason: "camera_starting", participant: null }, create: null },
            requestId: "e2e",
          }),
        });
      },
    );
    // One sample per painted frame, from before the click: is the tile showing a playing video, or the cover?
    await p.evaluate(() => {
      const w = window as unknown as W;
      w.__tile = { log: [], mark: 0, stop: false };
      document.addEventListener(
        "click",
        (e) => {
          if ((e.target as Element).closest('[data-testid="room-checkin-cta"]')) w.__tile.mark = performance.now();
        },
        true,
      );
      const tick = () => {
        const t = document.querySelector('[data-testid="room-own-tile"]');
        const v = t?.querySelector("video");
        const video = !!v && getComputedStyle(v).display !== "none" && v.videoWidth > 0 && v.srcObject !== null;
        const picture = !!t?.querySelector('[data-testid="room-own-tile-frozen"] canvas');
        const words = !!t?.querySelector('[data-testid="room-own-tile-connecting"]');
        w.__tile.log.push({ t: performance.now(), video, picture, words });
        if (!w.__tile.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await cta.click();
    const frozen = p.getByTestId("room-own-tile-frozen");
    await expect(frozen, "the cover is up the moment the test camera stops").toBeVisible({ timeout: 2_000 });
    await expect(tile).toHaveAttribute("data-stream", "off");
    await expect(frozen.getByTestId("room-own-tile-connecting")).toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
    // D23-fix m6: the live region was mounted (empty) before the cover and speaks the same words now.
    await expect(p.getByTestId("room-own-tile-announce")).toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
    await expect(cta, "the D2 wait is the SDK's, untouched").toHaveText(uiEn["externalPlay.room.checkin.cameraStarting"]!);

    // The cover is the preview's last frame: a picture (not black), as bright as the preview was, drawn at the
    // preview's proportions, mirrored exactly as the live video was, and filling the tile.
    const cover = await p.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="room-own-tile-frozen"] canvas')!;
      const g = c.getContext("2d")!;
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      const seen = new Set<number>();
      for (let i = 0; i < px.length; i += 4) {
        sum += 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
        seen.add(((px[i]! >> 4) << 8) | ((px[i + 1]! >> 4) << 4) | (px[i + 2]! >> 4));
      }
      const r = c.getBoundingClientRect();
      const tr = document.querySelector('[data-testid="room-own-tile"]')!.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return {
        transform: `${cs.transform}|${cs.scale}`,
        luma: sum / (px.length / 4),
        colours: seen.size,
        size: [c.width, c.height],
        fills: Math.abs(r.width - tr.width) < 1 && Math.abs(r.height - tr.height) < 1 && Math.abs(r.left - tr.left) < 1 && Math.abs(r.top - tr.top) < 1,
      };
    });
    expect(cover.transform, "mirrored exactly as the live preview was").toBe(before.transform);
    expect(cover.colours, "a picture, not a flat fill").toBeGreaterThan(4);
    expect(Math.abs(cover.luma - before.luma), `as bright as the preview (${cover.luma.toFixed(0)} vs ${before.luma.toFixed(0)})`).toBeLessThan(before.luma * 0.35);
    expect(cover.size, "the preview's proportions").toEqual(before.size.map((n) => Math.min(n, (n * 640) / Math.max(...before.size))));
    expect(cover.fills, "it fills the tile").toBe(true);
    // The words are READ, not just present: hit-tested at their centre, they are what is on top there — never the
    // picture painted over them — and they lie inside the tile, at every width.
    let widthsRead = 0;
    for (const width of [320, 768, 1280]) {
      await p.setViewportSize({ width, height: 900 });
      await p.waitForTimeout(100);
      const label = await p.evaluate(() => {
        const l = document.querySelector('[data-testid="room-own-tile-connecting"]')!.getBoundingClientRect();
        const t = document.querySelector('[data-testid="room-own-tile"]')!.getBoundingClientRect();
        const top = document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2);
        return {
          onTop: !!top?.closest('[data-testid="room-own-tile-connecting"]'),
          inside: l.left >= t.left - 0.5 && l.right <= t.right + 0.5 && l.top >= t.top - 0.5 && l.bottom <= t.bottom + 0.5,
          width: l.width,
        };
      });
      expect(label.onTop, `the words are on top of the picture at ${width}px`).toBe(true);
      expect(label.inside, `the words lie inside the tile at ${width}px`).toBe(true);
      expect(label.width, `the words have a box at ${width}px`).toBeGreaterThan(40);
      widthsRead += 1;
    }
    expect(widthsRead, "anti-vacuity: widths").toBe(3);
    // Layout: nothing past an edge and no sideways scroll, with the cover up (the bound is eight seconds: be quick).
    expect(await noSidewaysScroll(p, [320, 768, 1280]), "anti-vacuity: widths").toBe(3);
    expect(await nothingPastTheEdge(p, [320, 768, 1280]), "anti-vacuity: widths").toBe(3);
    await shoot(p, "d23-covering");

    // The picture's bound (D23-fix m1): the PICTURE goes at eight seconds, the words stay over the silhouette.
    const announce = p.getByTestId("room-own-tile-announce");
    await expect(frozen.locator("canvas"), "the picture goes at its bound").toHaveCount(0, { timeout: 15_000 });
    await expect(frozen.getByTestId("room-own-tile-connecting"), "and the words stay over the silhouette").toBeVisible();
    await expect(announce).toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
    await expect(cta, "the D2 wait is still the SDK's").toHaveText(uiEn["externalPlay.room.checkin.cameraStarting"]!);
    await shoot(p, "d23-connecting", [320, 768, 1280]);
    // How this wait ends: the seat is never answered here (the SDK cannot join offline), so the room's own poll budget on
    // camera_starting runs out — the words go with it, the live region empties, and Check in is offered again.
    await expect(frozen, "the words end with the poll budget").toHaveCount(0, { timeout: 40_000 });
    await expect(announce).toHaveText("");
    await expect(cta, "the budget spent: Check in is offered again").toHaveText(uiEn["externalPlay.room.checkin.cta"]!);
    await p.waitForTimeout(300);
    const { log, mark } = await p.evaluate(() => {
      const w = window as unknown as W;
      w.__tile.stop = true;
      return { log: w.__tile.log, mark: w.__tile.mark };
    });
    expect(mark, "premise: the click was seen").toBeGreaterThan(0);
    const after = log.filter((f) => f.t >= mark);
    const lastPicture = after.filter((f) => f.picture).at(-1)!;
    const lastWords = after.filter((f) => f.words).at(-1)!;
    const lived = after.filter((f) => f.t <= lastWords.t);
    expect(after.filter((f) => f.picture).length, "anti-vacuity: painted frames under the picture (counted)").toBeGreaterThan(30);
    expect(lived.filter((f) => f.words && !f.picture).length, "anti-vacuity: painted frames of the words alone (counted)").toBeGreaterThan(30);
    expect(
      lived.filter((f) => !f.video && !f.picture && !f.words).length,
      `no painted frame between the click and the words' end showed a blank tile (${lived.length} frames checked)`,
    ).toBe(0);
    // Positive pair: the sampler CAN see a blank tile — once the words have gone the tile is the silhouette.
    const afterWords = after.filter((f) => f.t > lastWords.t);
    expect(afterWords.filter((f) => !f.video && !f.picture && !f.words).length, "the sampler sees the blank that follows the wait").toBeGreaterThan(0);
    const pictureFor = lastPicture.t - mark;
    expect(pictureFor, "the picture is held for its bound, no less").toBeGreaterThanOrEqual(HANDOVER_COVER_MS - 100);
    expect(pictureFor, "and let go soon after it").toBeLessThanOrEqual(HANDOVER_COVER_MS + 3_000);
    expect(lastWords.t, "the words outlast the picture").toBeGreaterThan(lastPicture.t + 1_000);
    await ctx.close();
  } finally {
    await camBrowser.close();
  }
});

test("T17B fix 2, D23-fix: a camera that FAILS ends the cover at once — the words are not left standing over a camera that is not coming", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    cameraPolicy: "required",
  });
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const ctx = await cold(camBrowser);
    await ctx.grantPermissions(["camera"]);
    const p = await openRoom(ctx, room, room.white.token);
    const cta = p.getByTestId("room-checkin-cta");
    await p.getByTestId("room-checkin-test-cta").click();
    await expect(cta, "the preview painted a frame: Check in opens").toBeEnabled({ timeout: 10_000 });
    // The seat answer carries a participant, so the SDK joins the fixture's opaque token — and refuses it at once:
    // the camera's own status is `failed`.
    await p.route(
      (u) => /\/external-play\/room$/.test(u.pathname),
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        const read = await route.fetch({ method: "GET" });
        const snapshot = ((await read.json()) as { data: unknown }).data;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: { snapshot, seat: { seated: false, reason: "camera_starting", participant: { participantId: "e2e-part", authToken: "e2e-rtk" } }, create: null },
            requestId: "e2e",
          }),
        });
      },
    );
    const frozen = p.getByTestId("room-own-tile-frozen");
    const clicked = Date.now();
    await cta.click();
    // The picture is up for no more than the moments before the SDK refuses; the bound is eight seconds, so anything
    // standing at three seconds was held by something other than the clock.
    await expect(frozen, "the cover is gone long before the picture's bound: the camera failed").toHaveCount(0, { timeout: 3_000 });
    expect(Date.now() - clicked, "well inside the picture's bound").toBeLessThan(HANDOVER_COVER_MS - 2_000);
    await expect(p.getByTestId("room-own-tile-announce"), "and the live region is emptied").toHaveText("");
    // The route handler above awaits route.fetch: closing the context under one in flight ends it with "Response has been
    // disposed" (1 whole-file run in 3, D23 re-review 2). Drop the route first, ignoring the handlers still running.
    await p.unrouteAll({ behavior: "ignoreErrors" });
    await ctx.close();
    // The SDK refuses the opaque token composed above: expected here, and only here.
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Invalid auth token provided\. /.test(e)));
  } finally {
    await camBrowser.close();
  }
});

test("T17B fix 2, D21-fix-4 (I1): what the REAL browser puts on the wire - the first seat POST holds nothing and sends no body; the next names the participant the first answer handed over", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    cameraPolicy: "required",
  });
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const ctx = await cold(camBrowser);
    await ctx.grantPermissions(["camera"]);
    const p = await openRoom(ctx, room, room.white.token);
    const cta = p.getByTestId("room-checkin-cta");
    await p.getByTestId("room-checkin-test-cta").click();
    await expect(cta, "the preview painted a frame: Check in opens").toBeEnabled({ timeout: 10_000 });
    // Every seat answer is composed here as camera_starting WITH a token (no browser can make a RealtimeKit peer), so the
    // room keeps asking on the schedule's first step (1 s). The bodies are read off the request the browser really made:
    // the e2e's other composed answers never looked at what was SENT, which is how this hop went unpinned (review I1).
    const sent: (string | null)[] = [];
    await p.route(
      (u) => /\/external-play\/room$/.test(u.pathname),
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        sent.push(route.request().postData());
        const read = await route.fetch({ method: "GET" });
        const snapshot = ((await read.json()) as { data: unknown }).data;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: { snapshot, seat: { seated: false, reason: "camera_starting", participant: { participantId: "e2e-part", authToken: "e2e-rtk" } }, create: null },
            requestId: "e2e",
          }),
        });
      },
    );
    await cta.click();
    await expect.poll(() => sent.length, { message: "the room re-asks on its own back-off", timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    expect(sent[0], "the first claim: the room held nothing, so no body at all").toBeNull();
    expect(JSON.parse(sent[1]!), "the re-ask names the participant the first answer handed over").toEqual({ heldParticipantId: "e2e-part" });
    // Drop the route first: closing the context under a handler's route.fetch in flight ends it with "Response has been disposed".
    await p.unrouteAll({ behavior: "ignoreErrors" });
    await ctx.close();
    // The SDK refuses the opaque token composed above: expected here, and only here.
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Invalid auth token provided\. /.test(e)));
  } finally {
    await camBrowser.close();
  }
});

test("T17B fix 2, D23-fix-2: a seat claim that FAILS ends the cover at once — the words are not left standing for a minute with the button enabled", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    cameraPolicy: "required",
  });
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const ctx = await cold(camBrowser);
    await ctx.grantPermissions(["camera"]);
    const p = await openRoom(ctx, room, room.white.token);
    const cta = p.getByTestId("room-checkin-cta");
    await p.getByTestId("room-checkin-test-cta").click();
    await expect(cta, "the preview painted a frame: Check in opens").toBeEnabled({ timeout: 10_000 });
    // The first claim is held, then FAILS (a 500): no seat, no participant, the camera never starts.
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => (fail = resolve));
    let claims = 0;
    await p.route(
      (u) => /\/external-play\/room$/.test(u.pathname),
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        claims += 1;
        await failing;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "E2E_DOWN" }, requestId: "e2e" }) });
      },
    );
    const frozen = p.getByTestId("room-own-tile-frozen");
    const clicked = Date.now();
    await cta.click();
    await expect(frozen, "premise: the cover is up while the claim is in flight").toBeVisible();
    expect(claims, "premise: one claim, held").toBe(1);
    await expect(p.getByTestId("room-own-tile-announce"), "premise: the live region speaks while it is up").toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
    fail();
    // Gone at once — well inside the picture's own bound, so only the failure can have taken it down.
    await expect(frozen, "the failed claim ends the cover").toHaveCount(0, { timeout: 3_000 });
    expect(Date.now() - clicked, "well inside the picture's bound").toBeLessThan(HANDOVER_COVER_MS - 2_000);
    await expect(p.getByTestId("room-own-tile-announce"), "the live region is emptied").toHaveText("");
    await expect(cta, "Check in is offered again").toBeEnabled();
    await expect(cta).toHaveText(uiEn["externalPlay.room.checkin.cta"]!);
    // And it STAYS gone: the picture's bound and the words' stand-in would both have fired inside this wait.
    await p.waitForTimeout(HANDOVER_COVER_MS - 4_000);
    await expect(frozen, "nothing resurfaces").toHaveCount(0);
    await ctx.close();
    // The failed claim is this test's own 500: the browser logs it, expected here and only here.
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Failed to load resource: the server responded with a status of 500/.test(e)));
  } finally {
    await camBrowser.close();
  }
});

test("T17B fix 2, D23-fix-3: ONE failed camera_starting poll does NOT end the cover — the room is still polling, so the words stand and the next poll goes out", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    cameraPolicy: "required",
  });
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const ctx = await cold(camBrowser);
    await ctx.grantPermissions(["camera"]);
    const p = await openRoom(ctx, room, room.white.token);
    const cta = p.getByTestId("room-checkin-cta");
    await p.getByTestId("room-checkin-test-cta").click();
    await expect(cta, "the preview painted a frame: Check in opens").toBeEnabled({ timeout: 10_000 });
    // Every claim is answered camera_starting with NO participant (the SDK neither joins nor fails: what ends the wait
    // is the room's own poll budget) — except the second, the first POLL, which is a 500. A 500 on a poll is what a
    // flaky connection does; the camera check is still running, and so is the cover.
    let claims = 0;
    let failedAt = 0;
    await p.route(
      (u) => /\/external-play\/room$/.test(u.pathname),
      async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue();
        claims += 1;
        if (claims === 2) {
          failedAt = Date.now();
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "E2E_FLAKE" }, requestId: "e2e" }) });
        }
        const read = await route.fetch({ method: "GET" });
        const snapshot = ((await read.json()) as { data: unknown }).data;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: { snapshot, seat: { seated: false, reason: "camera_starting", participant: null }, create: null }, requestId: "e2e" }),
        });
      },
    );
    const frozen = p.getByTestId("room-own-tile-frozen");
    const words = uiEn["externalPlay.room.checkin.connecting"]!;
    await cta.click();
    await expect(frozen, "premise: the cover is up").toBeVisible({ timeout: 2_000 });
    await expect.poll(() => failedAt, { message: "premise: the first poll failed", timeout: 6_000 }).toBeGreaterThan(0);
    // The poll AFTER the failed one is the proof the room carried on; by then the failure is over a second old.
    await expect.poll(() => claims, { message: "premise: the room polled on after the failure", timeout: 6_000 }).toBeGreaterThanOrEqual(3);
    expect(Date.now() - failedAt, "premise: the failure is behind us").toBeGreaterThan(900);
    await expect(frozen, "the cover stands: one failed poll is not the end of the camera check").toBeVisible();
    await expect(p.getByTestId("room-own-tile-announce"), "and still speaks").toHaveText(words);
    await expect(cta, "the check-in still reads that it is checking").toHaveText(uiEn["externalPlay.room.checkin.cameraStarting"]!);
    await p.unrouteAll({ behavior: "ignoreErrors" });
    await ctx.close();
    // The poll's 500 is this test's own: the browser logs it, expected here and only here.
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Failed to load resource: the server responded with a status of 500/.test(e)));
  } finally {
    await camBrowser.close();
  }
});

test("T17B fix 2: the seat's camera verdicts in the browser — a camera still starting keeps the check-in, its button waiting and the room re-asking on its back-off; a browser that refused it gets the blocked card, whose Reload reloads — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(p)).toBe("checkin");
  // No browser here can make a RealtimeKit peer (the SDK refuses the fixture's token), so the seat's VERDICT is
  // composed at the route: the room's own snapshot, read without side effects (a GET of the same link), and the
  // refusal the seat answers. The verdicts themselves are the real seat's, against the measured peer reports
  // (external-play-seat-camera.test.ts); this proves what the browser does with them.
  let verdict: "camera_starting" | "camera_blocked" = "camera_starting";
  let claims = 0;
  await p.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      claims += 1;
      const read = await route.fetch({ method: "GET" });
      const snapshot = ((await read.json()) as { data: unknown }).data;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: { snapshot, seat: { seated: false, reason: verdict, participant: { participantId: "e2e-part", authToken: "e2e-rtk" } }, create: null },
          requestId: "e2e",
        }),
      });
    },
  );

  await p.getByTestId("room-checkin-cta").click();
  await expect(p.getByTestId("room-checkin-cta"), "the button waits, and says why").toHaveText(uiEn["externalPlay.room.checkin.cameraStarting"]!);
  await expect(p.getByTestId("room-checkin-cta")).toBeDisabled();
  expect(await screenOf(p), "starting is never a card").toBe("checkin");
  const first = claims;
  // The first two re-asks fall 1 s and 3 s after the first answer (the D21 back-off: 1, 2, 4, 8 s).
  await expect.poll(() => claims, { timeout: 8_000, message: "the room re-asks on its own" }).toBeGreaterThanOrEqual(first + 2);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "camera-starting");

  verdict = "camera_blocked";
  // The third re-ask is 4 s after the second: the longest wait this test sits through.
  await expect.poll(() => screenOf(p), { timeout: 10_000, message: "the next re-ask lands the refusal" }).toBe("cameraBlocked");
  await expect(p.getByRole("heading", { name: uiEn["externalPlay.room.state.cameraBlocked.title"]! })).toBeVisible();
  await expect(p.getByText(uiEn["externalPlay.room.state.cameraBlocked.body"]!)).toBeVisible();
  await expect(p.getByTestId("room-checkin-cta"), "no check-in to press").toHaveCount(0);
  const atBlocked = claims;
  await p.waitForTimeout(3_000);
  expect(claims, "blocked is not re-asked: only a reload can cure it").toBe(atBlocked);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "camera-blocked");

  // The card's one action reloads the page (a new peer is the only way back).
  await p.setViewportSize({ width: 1280, height: 900 });
  const reloaded = p.waitForEvent("load");
  await p.getByTestId("room-state-reload").click();
  await reloaded;
  await expect(p.getByTestId("match-room")).toBeVisible();
  expect(await screenOf(p), "the fresh page is the check-in again").toBe("checkin");
  await ctx.close();
});

test("T17B fix 2, D21: a camera still starting is re-asked on the BACK-OFF — 1, 2, 4, then 8 seconds apart in a real browser, never once a second", async ({ page, browser }) => {
  // The ruling's table (controller, 2026-10-15), typed here, never read back from the room's constants. Every re-ask is
  // four RealtimeKit calls against an account-wide limit of 1,200 per five minutes, so the wait between them grows.
  const RULING_S = [1, 2, 4, 8];
  const reAsks = RULING_S.length;
  test.setTimeout(Math.max(120_000, (RULING_S.reduce((a, b) => a + b, 0) + 40) * 1_000));
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(p)).toBe("checkin");
  // Every claim is answered camera_starting with NO participant (the SDK never joins: only the room's own timer moves).
  const claimedAt: number[] = [];
  await p.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      claimedAt.push(Date.now());
      const read = await route.fetch({ method: "GET" });
      const snapshot = ((await read.json()) as { data: unknown }).data;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { snapshot, seat: { seated: false, reason: "camera_starting", participant: null }, create: null }, requestId: "e2e" }),
      });
    },
  );
  await p.getByTestId("room-checkin-cta").click();
  await expect
    .poll(() => claimedAt.length, { timeout: (RULING_S.reduce((a, b) => a + b, 0) + 12) * 1_000, message: "the claim, then every re-ask" })
    .toBeGreaterThanOrEqual(1 + reAsks);
  const gaps = claimedAt.slice(1, 1 + reAsks).map((t, i) => t - claimedAt[i]!);
  expect(gaps.length, "anti-vacuity: every wait was observed").toBe(reAsks);
  RULING_S.forEach((s, i) => {
    // A timer never fires early; the round trip only adds. The upper bound is slack for a loaded machine, not a target.
    expect(gaps[i], `wait ${i + 1} is at least ${s} s`).toBeGreaterThanOrEqual(s * 1_000 - 100);
    expect(gaps[i], `wait ${i + 1} is not lost: at most ${s} s and the slack`).toBeLessThan(s * 1_000 + 3_000);
  });
  // The differential a once-a-second poll cannot pass: seven seconds in, the claim and the 1 s and 3 s re-asks are all there is (7 s lands the 4th).
  const first = claimedAt[0]!;
  expect(claimedAt.filter((t) => t - first < 6_500).length, "re-asks in the first 6.5 s").toBeLessThanOrEqual(3);
  await p.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
});

test("T17B fix 2 (D5): under a camera policy the check-in's privacy line says what the opponent's room is set up to show — naming nobody — at every width", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`], cameraPolicy: "required" });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(p)).toBe("checkin");
  const line = p.getByTestId("room-checkin-privacy");
  await expect(line).toHaveText(uiEn["externalPlay.room.checkin.privacy"]!);
  // Typed from the controller's ruling, never read back from the dictionary alone.
  await expect(line).toHaveText("Your opponent can't see your camera. Your organiser can watch it live; it isn't recorded.");
  const text = (await line.textContent()) ?? "";
  for (const name of [room.black.name, room.white.name, "Ada", "Bo"]) expect(text, `names nobody: ${name}`).not.toContain(name);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "checkin-privacy");
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

// ------------------------------------------------------- D19: move sounds
//
// The sounds are heard at the browser's own AudioContext — the real WebAudio path, no test hook in the room: an init
// script counts the contexts made and records the first frequency each oscillator is given. Every sound's first tone
// is its signature (room-sound-synth.ts SOUND_SIGNATURE, a frequency no other sound starts with), so a group of
// oscillators made together reads back as one named sound. What each ply SHOULD sound like is typed from the rules
// (a capture, a check), never read from the room's code.

const SOUND_SPY = () => {
  const w = window as unknown as {
    __ctxs: AudioContext[];
    __tones: { t: number; hz: number }[];
    AudioContext: typeof AudioContext;
  };
  w.__ctxs = [];
  w.__tones = [];
  const Real = w.AudioContext;
  if (!Real) return;
  const proto = Real.prototype;
  const create = proto.createOscillator;
  proto.createOscillator = function (this: AudioContext) {
    const osc = create.call(this);
    const set = osc.frequency.setValueAtTime.bind(osc.frequency);
    let first = true;
    osc.frequency.setValueAtTime = (v: number, t: number) => {
      if (first) w.__tones.push({ t: performance.now(), hz: v });
      first = false;
      return set(v, t);
    };
    return osc;
  };
  const Counted = function (this: unknown, ...a: ConstructorParameters<typeof AudioContext>) {
    const c = new Real(...a);
    w.__ctxs.push(c);
    return c;
  } as unknown as typeof AudioContext;
  Counted.prototype = proto;
  w.AudioContext = Counted;
};

/** The sounds the room has played, by name: oscillators made within a few ms of each other are one sound. */
async function soundsPlayed(page: Page): Promise<string[]> {
  const tones = await page.evaluate(() => (window as unknown as { __tones: { t: number; hz: number }[] }).__tones);
  const byHz = new Map(Object.entries(SOUND_SIGNATURE).map(([s, hz]) => [hz, s]));
  const out: string[] = [];
  let lastT = -Infinity;
  for (const { t, hz } of tones) {
    if (t - lastT > 5) out.push(byHz.get(hz) ?? `unknown ${hz}`);
    lastT = t;
  }
  return out;
}
const contexts = (page: Page) => page.evaluate(() => (window as unknown as { __ctxs: AudioContext[] }).__ctxs.map((c) => c.state));

/** The next position on the bridge row, as Lichess reports it: the SAME game (its id kept), the move list grown. */
async function playOn(room: SeededRoom, moves: string[], o: { whiteMs?: number; drawOfferBy?: "white" | "black" | null; finished?: boolean } = {}) {
  await withDb(async (sql) => {
    const res = await sql`
      update fixture_external_play
         set moves_uci = ${sql.json(moves)},
             move_count = ${moves.length},
             last_move_at = now(),
             white_ms = coalesce(${o.whiteMs ?? null}::int, white_ms),
             draw_offer_by = ${o.drawOfferBy ?? null},
             status = ${o.finished ? "finished" : "live"},
             game_over_at = ${o.finished ? sql`now()` : null},
             finished_at = ${o.finished ? sql`now()` : null},
             updated_at = now()
       where fixture_id = ${room.fixtureId}`;
    if (res.count !== 1) throw new Error(`playOn: no bridge row for ${room.fixtureId}`);
  });
}
/** The position after `moves`, by the rules. */
function fenOf(moves: string[]): string {
  const c = new Chess();
  for (const m of moves) c.move({ from: m.slice(0, 2), to: m.slice(2, 4), ...(m.length > 4 ? { promotion: m[4] } : {}) });
  return c.fen();
}
const atPly = (page: Page, ply: number) => expect(page.getByTestId("room-board")).toHaveAttribute("data-ply", String(ply));

test("T17B fix 2, D19: move sounds — none before a tap or on load; each new ply its own sound; the own drop at once; a jump silent; the switch remembered", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const line = ["e2e4"];
  await seedGameSql(room, { moves: line });
  const ctx = await cold(browser);
  await ctx.addInitScript(SOUND_SPY);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  const toggle = p.getByTestId("room-sound");
  await expect(toggle, "a player's room: sounds on by default").toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAttribute("aria-label", uiEn["externalPlay.room.sound.label"]!);

  // Before any tap: a new ply makes no sound, and no AudioContext is even made.
  line.push("d7d5");
  await playOn(room, line);
  await atPly(p, 2);
  await p.waitForTimeout(300);
  expect(await contexts(p), "nothing before a gesture").toEqual([]);
  expect(await soundsPlayed(p)).toEqual([]);

  // A tap anywhere is the gesture.
  await p.getByTestId("room-clock-opponent").click();
  await expect.poll(() => contexts(p)).toEqual(["running"]);

  // Each new ply, live, with the sound the rules say it is (the player is White).
  const heard: string[] = [];
  const steps: [string, string][] = [
    ["e4d5", "capture"], // White takes, from another device: the player's own capture
    ["d8d5", "capture"], // Black recaptures
    ["b1c3", "move"], // White, quiet
    ["d5e5", "check"], // Black's queen checks
  ];
  for (const [uci, sound] of steps) {
    line.push(uci);
    await playOn(room, line);
    await atPly(p, line.length);
    heard.push(sound);
    await expect.poll(() => soundsPlayed(p), { message: `${uci} sounds as a ${sound}` }).toEqual(heard);
  }
  expect(heard.length, "anti-vacuity: plies heard").toBe(steps.length);

  // Two plies in one read (a reconnect, a missed broadcast): replayed silently.
  line.push("f1e2", "a7a6");
  await playOn(room, line);
  await atPly(p, line.length);
  await p.waitForTimeout(500);
  expect(await soundsPlayed(p), "a jump of two plies is silent").toEqual(heard);

  // The opponent offers a draw: once.
  await playOn(room, line, { drawOfferBy: "black" });
  await expect(p.getByTestId("room-draw-offer")).toBeVisible();
  heard.push("offer");
  await expect.poll(() => soundsPlayed(p)).toEqual(heard);
  await playOn(room, line);
  await expect(p.getByTestId("room-draw-offer")).toHaveCount(0);

  // The player's own move sounds at the DROP — while it is still in flight — and the refusal adds nothing.
  const acts = await catchActs(p, { hold: true });
  await tap(p, "g1", "white");
  await tap(p, "f3", "white");
  await expect.poll(() => acts.bodies.length).toBe(1);
  heard.push("move");
  await expect.poll(() => soundsPlayed(p), { message: "heard before any answer" }).toEqual(heard);
  acts.release();
  await expect.poll(() => piecesOnBoard(p)).toEqual(piecesOf(fenOf(line)));
  await p.waitForTimeout(500);
  expect(await soundsPlayed(p), "the refusal and its re-read are silent").toEqual(heard);

  // Switched off: a new ply is silent — and the choice survives a reload.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  line.push("g1f3");
  await playOn(room, line);
  await atPly(p, line.length);
  await p.waitForTimeout(500);
  expect(await soundsPlayed(p), "off is off").toEqual(heard);
  if (SHOTS) await shoot(p, "sound-off");
  await p.reload();
  await boardReady(p);
  await expect(p.getByTestId("room-sound"), "remembered on this device").toHaveAttribute("aria-pressed", "false");

  // On again: the press plays a short preview (it is itself the gesture), then the end of the game sounds.
  await p.getByTestId("room-sound").click();
  await expect(p.getByTestId("room-sound")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => soundsPlayed(p), { message: "the preview" }).toEqual(["move"]);
  if (SHOTS) await shoot(p, "sound-on");
  line.push("e7e6");
  await playOn(room, line, { finished: true });
  await expect(p.getByTestId("match-room"), "the game is over: the room leaves the live board").not.toHaveAttribute("data-screen", "live");
  await expect.poll(() => soundsPlayed(p), { message: "the last ply ended the game: one sound, the end" }).toEqual(["move", "end"]);
  expect(await noSidewaysScroll(p, [320, 768, 1280]), "anti-vacuity: widths").toBe(3);
  await ctx.close();
});

test("T17B fix 2, D19: low time — once, when the player's OWN running clock crosses 10 s", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: ["e2e4"] });
  const ctx = await cold(browser);
  await ctx.addInitScript(SOUND_SPY);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  await p.getByTestId("room-clock-opponent").click();
  await expect.poll(() => contexts(p)).toEqual(["running"]);
  // Black replies; White's clock now runs from 14 s.
  await playOn(room, ["e2e4", "e7e5"], { whiteMs: 14_000 });
  await atPly(p, 2);
  await expect.poll(() => soundsPlayed(p), { message: "the reply, then the crossing" }).toEqual(["opponentMove", "lowTime"]);
  await p.waitForTimeout(2_000);
  expect(await soundsPlayed(p), "once").toEqual(["opponentMove", "lowTime"]);
  await ctx.close();
});

test("T17B fix 2, D19: storage blocked — the switch still works on the page, and nothing throws", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: ["e2e4"] });
  const ctx = await cold(browser);
  await ctx.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  await ctx.addInitScript(SOUND_SPY);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  const toggle = p.getByTestId("room-sound");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => soundsPlayed(p), { message: "turned back on: the preview plays" }).toEqual(["move"]);
  await ctx.close();
});

// ------------------------------------------------- D24: the clocks by viewer
//
// T17B fix 2, D24 (owner request, stg v797): while the game is live the OPPONENT's clock is a bar above the board and
// the player's own a bar below it — by VIEWER, never by colour; each bar is the board's width; the move-sounds switch
// sits in the player's own bar. Once a RESULT is shown the owner keeps today's layout: both clocks side by side above
// the board, the result card and the ways on below it.

/** The seconds a clock face reads ("9:42" -> 582, "0:19.7" -> 19.7), the first face in the text. */
function faceSeconds(text: string | null): number {
  const m = /(\d+):(\d\d)(?:\.(\d))?/.exec(text ?? "");
  if (!m) throw new Error(`no clock face in "${text}"`);
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
}
const faceOf = (page: Page, id: "room-clock-you" | "room-clock-opponent") => page.getByTestId(id).locator("span.font-display");

test("T17B fix 2, D24: the opponent's clock above the board, mine below — both colours, each bar the board's width at 320, 768, 1100 and 1280 — the sound switch in MY bar, the header without one", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: ["e2e4", "e7e5"], whiteMs: 582_000, blackMs: 497_000 });
  const WIDTHS = [320, 768, 1100, 1280];
  let framed = 0;
  let sides = 0;
  for (const [who, me, them] of [
    ["white", room.white, room.black],
    ["black", room.black, room.white],
  ] as const) {
    const ctx = await cold(browser);
    const p = await openRoom(ctx, room, me.token);
    expect(await screenOf(p)).toBe("live");
    await boardReady(p);
    const theirs = p.getByTestId("room-clock-opponent");
    const mine = p.getByTestId("room-clock-you");
    // By viewer: the opponent's name and colour above, "You" below — Black's page too.
    await expect(theirs).toContainText(them.name);
    await expect(theirs).toContainText(uiEn[who === "white" ? "externalPlay.room.colour.black" : "externalPlay.room.colour.white"]!);
    await expect(mine).toContainText(uiEn["externalPlay.room.you"]!);
    await expect(mine).not.toContainText(them.name);
    // White to move: the dark bar is wherever the side to move sits for THIS viewer.
    await expect(who === "white" ? mine : theirs).toHaveAttribute("data-active", "true");
    await expect(who === "white" ? theirs : mine).toHaveAttribute("data-active", "false");
    // The switch: in my bar, not in the header, not in the opponent's bar; a real 44px target.
    await expect(mine.getByTestId("room-sound")).toHaveCount(1);
    await expect(theirs.getByTestId("room-sound")).toHaveCount(0);
    await expect(p.getByTestId("room-header").getByTestId("room-sound")).toHaveCount(0);
    await expect(p.getByTestId("room-sound")).toHaveCount(1);
    for (const width of WIDTHS) {
      await p.setViewportSize({ width, height: 900 });
      await p.waitForTimeout(150);
      const opp = await boxOf(p, "room-clock-opponent");
      const board = await boxOf(p, "room-board");
      const you = await boxOf(p, "room-clock-you");
      expect(opp.y + opp.height, `${who}@${width}: the opponent's bar is above the board`).toBeLessThanOrEqual(board.y + 1);
      expect(board.y + board.height, `${who}@${width}: my bar is below the board`).toBeLessThanOrEqual(you.y + 1);
      for (const [name, bar] of [["opponent", opp], ["you", you]] as const) {
        expect(Math.abs(bar.width - board.width), `${who}@${width}: the ${name} bar is the board's width`).toBeLessThanOrEqual(2);
        expect(Math.abs(bar.x - board.x), `${who}@${width}: the ${name} bar lines up with the board`).toBeLessThanOrEqual(2);
      }
      // A real tap target: the paint box is not the tap area, so hit-test the centre.
      const toggle = mine.getByTestId("room-sound");
      const tb = (await toggle.boundingBox())!;
      expect(Math.min(tb.width, tb.height), `${who}@${width}: the switch is 44px`).toBeGreaterThanOrEqual(43.5);
      expect(tb.x + tb.width, `${who}@${width}: the switch is inside my bar`).toBeLessThanOrEqual(you.x + you.width + 0.5);
      const hit = await toggle.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top === el || (top !== null && el.contains(top));
      });
      expect(hit, `${who}@${width}: the centre of the switch hits the switch`).toBe(true);
      if (width >= 768) await inAside(p, "room-controls");
      framed += 1;
    }
    // D12's probe, extended to the clock rows: every painted box (the bars included) is inside the window.
    expect(await nothingPastTheEdge(p, [320, 768, 1024, 1100, 1280]), "anti-vacuity: widths").toBe(5);
    expect(await noSidewaysScroll(p, [320, 360, 768, 1100, 1280])).toBe(5);
    // The switch works from its new place, and is remembered (its setting reads from the same box).
    const toggle = mine.getByTestId("room-sound");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await shoot(p, `d24-live-${who}`, [320, 768, 1100, 1280]);
    sides += 1;
    await ctx.close();
  }
  expect(sides, "anti-vacuity: both colours").toBe(2);
  expect(framed, "anti-vacuity: colours x widths").toBe(2 * WIDTHS.length);
});

test("T17B fix 2, D24: the layout follows the game — live is the opponent above and me below; the RESULT is both clocks side by side above the board with the result card below (both colours), no switch in either bar", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  const moves = ["e2e4", "e7e5"];
  await seedGameSql(room, { moves, whiteMs: 582_000, blackMs: 497_000 });
  let overs = 0;
  const pages: [string, Page][] = [];
  const ctxs = [];
  for (const [who, me] of [
    ["white", room.white],
    ["black", room.black],
  ] as const) {
    const ctx = await cold(browser);
    ctxs.push(ctx);
    const p = await openRoom(ctx, room, me.token);
    expect(await screenOf(p), who).toBe("live");
    await boardReady(p);
    const opp = await boxOf(p, "room-clock-opponent");
    const you = await boxOf(p, "room-clock-you");
    expect(you.y, `${who}: live, my bar is BELOW the opponent's`).toBeGreaterThan(opp.y + opp.height);
    await expect(p.getByTestId("room-sound"), `${who}: live has the switch`).toHaveCount(1);
    pages.push([who, p]);
  }
  // Lichess ends the game (Black's page and White's alike): the room leaves the live board.
  await playOn(room, moves, { finished: true });
  for (const [who, p] of pages) {
    await expect.poll(() => screenOf(p), { timeout: 20_000, message: `${who}: the game is over` }).toBe("over");
    await boardReady(p);
    for (const width of [320, 768, 1100, 1280]) {
      await p.setViewportSize({ width, height: 900 });
      await p.waitForTimeout(150);
      const opp = await boxOf(p, "room-clock-opponent");
      const you = await boxOf(p, "room-clock-you");
      const board = await boxOf(p, "room-board");
      const result = await boxOf(p, "room-result");
      expect(Math.abs(opp.y - you.y), `${who}@${width}: the two clocks sit on one row`).toBeLessThanOrEqual(2);
      expect(opp.x + opp.width, `${who}@${width}: the opponent's on the left, mine on the right`).toBeLessThanOrEqual(you.x + 1);
      expect(Math.max(opp.y + opp.height, you.y + you.height), `${who}@${width}: both above the board`).toBeLessThanOrEqual(board.y + 1);
      expect(result.y, `${who}@${width}: the result card is BELOW the board`).toBeGreaterThanOrEqual(board.y + board.height - 1);
      const back = await boxOf(p, "room-back-to-fixture");
      expect(back.y, `${who}@${width}: the ways on follow the result`).toBeGreaterThanOrEqual(result.y + result.height - 1);
    }
    await expect(p.getByTestId("room-sound"), `${who}: the result has no switch`).toHaveCount(0);
    expect(await nothingPastTheEdge(p, [320, 768, 1280]), "anti-vacuity: widths").toBe(3);
    await shoot(p, `d24-over-${who}`, [320, 768, 1100, 1280]);
    overs += 1;
  }
  expect(overs, "anti-vacuity: both colours").toBe(2);
  for (const c of ctxs) await c.close();
});

test("T17B fix 2, D24: the face shows tenths from 20 s — typed from the ruling at its edges (19.9, 19.7, 20.0, 20.3, 10.0, 9.95, 0.1) — never 0.0 while time remains", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  await seedGameSql(room, { moves: ["e2e4", "e7e5"] });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  // White is to move, so BLACK's clock (the opponent's bar) stands still at the ledger's value: an exact face to read.
  const table: [number, string][] = [
    [19_900, "0:19.9"],
    [19_700, "0:19.7"],
    [20_000, "0:20"],
    [20_300, "0:21"],
    [61_000, "1:01"],
    [10_000, "0:10.0"],
    [9_950, "0:09.9"],
    [100, "0:00.1"],
  ];
  let checked = 0;
  for (const [ms, face] of table) {
    await withDb(async (sql) => {
      await sql`update fixture_external_play set black_ms = ${ms}, updated_at = now() where fixture_id = ${room.fixtureId}`;
    });
    await p.reload();
    await boardReady(p);
    await expect(faceOf(p, "room-clock-opponent"), `${ms} ms reads ${face}`).toHaveText(face);
    checked += 1;
  }
  expect(checked, "anti-vacuity: faces").toBe(table.length);
  await ctx.close();
});

test("T17B fix 2, D24: my increment shows AT ONCE on my move — the clock jumps by the division's +5 while the move is still in flight, holds still, and a refusal restores the clock", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  // White to move with 40 s on the clock (the division is 10+5): enough to move in, low enough to read as tenths.
  await seedGameSql(room, { moves: ["e2e4", "e7e5"], whiteMs: 40_000, blackMs: 300_000 });
  const ctx = await cold(browser);
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  const mine = faceOf(p, "room-clock-you");
  const acts = await catchActs(p, { hold: true });
  const before = faceSeconds(await mine.textContent());
  await tap(p, "g1", "white");
  await tap(p, "f3", "white");
  await expect.poll(() => acts.bodies.length, { message: "the move is in flight" }).toBe(1);
  const atDrop = faceSeconds(await mine.textContent());
  // The division's increment is 5 s: the face jumped by it (less the moments between the two readings).
  expect(atDrop - before, `the clock read ${before}, then ${atDrop} with the move in flight`).toBeGreaterThan(3.5);
  expect(atDrop - before).toBeLessThan(5.2);
  // It holds still while the answer is out (Lichess stopped my clock when it got the move).
  const frozen = await mine.textContent();
  await p.waitForTimeout(900);
  expect(await mine.textContent(), "frozen while the move is in flight").toBe(frozen);
  // The refusal: the guess goes, the clock is the ledger's again and runs down from where it stood.
  acts.release();
  await expect(p.getByTestId("room-move-notice")).toHaveAttribute("data-kind", "refused");
  // Within 3 s of the answer: the guess's own 10 s expiry would also bring the clock back, but late — what restores it
  // here is the refusal.
  await expect
    .poll(async () => faceSeconds(await mine.textContent()), { message: "restored: below what it read before the drop", timeout: 3_000 })
    .toBeLessThan(before);
  const restored = faceSeconds(await mine.textContent());
  // Polled, not slept: the face ticks once a second, so a running clock is seen below `restored` within a few seconds,
  // and a stopped one never (a fixed 700 ms sleep crossed a tick boundary only 70% of the time).
  await expect
    .poll(async () => faceSeconds(await mine.textContent()), { message: "and running again", timeout: 3_000 })
    .toBeLessThan(restored);
  expect((await bridgeRow(room.fixtureId))?.move_count, "nothing was played").toBe(2);
  await ctx.close();
});

test("T17B fix 2, D24 (re-review I1, I2): a move dropped in time and still in flight when the SERVER's clock reaches zero is not a flag — no 'Time's up' over a live face, no clock-zero report; its refusal brings the lock and the report back", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  // White to move with 9 s on the clock as at the last move (seeded now): the server's zero is 9 s from here, the drop
  // lands a few seconds in, and the move is held past that zero. The division is 10+5, so the guess is ~10 s.
  const seededAt = Date.now();
  await seedGameSql(room, { moves: ["e2e4", "e7e5"], whiteMs: 9_000, blackMs: 300_000 });
  const ctx = await cold(browser);
  let zeroReports = 0;
  await ctx.route("**/external-play/room/clock-zero*", async (route: Route) => {
    zeroReports += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { reconciled: false }, requestId: "e2e" }) });
  });
  const p = await openRoom(ctx, room, room.white.token);
  await boardReady(p);
  const mine = faceOf(p, "room-clock-you");
  const acts = await catchActs(p, { hold: true });
  await tap(p, "g1", "white");
  await tap(p, "f3", "white");
  await expect.poll(() => acts.bodies.length, { message: "the move is in flight" }).toBe(1);
  const dropAt = Date.now();
  expect(dropAt, "premise: the drop is before the server's zero").toBeLessThan(seededAt + 9_000 - 1_000);
  // Past the server's zero, the move still out.
  await p.waitForTimeout(Math.max(0, seededAt + 9_000 + 900 - Date.now()));
  expect(Date.now() - dropAt, "premise: the guess (10 s) outlives this wait").toBeLessThan(9_000);
  expect(faceSeconds(await mine.textContent()), "the face is the guess, not 0:00").toBeGreaterThan(3);
  await expect(p.getByTestId("room-flag-notice"), "no 'Time's up' over a live face").toHaveCount(0);
  expect(zeroReports, "a move dropped in time is not a clock at zero: nothing reported").toBe(0);
  // The refusal: the guess goes, the server's zero is the face again, and the lock — and the report — return.
  acts.release();
  await expect(p.getByTestId("room-flag-notice")).toHaveAttribute("data-kind", "lichess", { timeout: 6_000 });
  await expect(p.getByTestId("room-clock-you")).toContainText("0:00.0");
  await expect(p.getByTestId("room-board-surface")).toHaveAttribute("data-movable", "false");
  await expect.poll(() => zeroReports, { message: "the room reports the zero it now sees" }).toBeGreaterThanOrEqual(1);
  expect((await bridgeRow(room.fixtureId))?.move_count, "nothing was played").toBe(2);
  await ctx.close();
});

test("T17B fix 2, D21-fix-3 (owner decision): an optional camera seated with NO tile because the call budget was spent asks again for its token on a back-off - 'Connecting your camera' meanwhile, never 'off' - and the camera starts WITHOUT a reload; a tokenless seat that does not say so (Off, an override) never asks", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const room = await seedMatchRoom(page.request, {
    names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`],
    cameraPolicy: "optional",
  });
  // A fake capture device, so the camera the player grants is real and the room's SDK has something to join with.
  const camBrowser = await browser.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const ctx = await cold(camBrowser);
  await ctx.grantPermissions(["camera"]);
  // The seat is the REAL one - the real check-in, the real participant at the fixture vendor - with its answer rewritten
  // to the case the platform's call budget makes: seated, no token, and the explicit field that says one can still come.
  // The camera route then refuses twice (the budget is still spent) and hands over the real token on the third ask.
  let claims = 0;
  await ctx.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      claims += 1;
      const res = await route.fetch();
      const body = (await res.json()) as { data: { seat: unknown } };
      body.data.seat = { seated: true, participant: null, cameraRetry: true };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    },
  );
  const asks: number[] = [];
  await ctx.route(
    (u) => /\/external-play\/room\/camera$/.test(u.pathname),
    async (route: Route) => {
      asks.push(Date.now());
      // The third ask gets a token the SDK will refuse, as it refuses the kit's own (the fixture vendor is not a RealtimeKit
      // the browser can reach): the refusal is the proof that the late token reached the camera.
      const data = asks.length < 3 ? { participant: null, retry: true } : { participant: { participantId: "e2e-part-late", authToken: "e2e-rtk" }, retry: false };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data, requestId: "e2e" }) });
    },
  );
  const p = await openRoom(ctx, room, room.white.token);
  // A RELOAD is a `load`. Not `framenavigated`: the app router's own first-mount `history.replaceState` (same URL) is a
  // same-document navigation that lands after `openRoom` returns on a loaded machine - 8 ms after this listener, before
  // any click or ask - and counted as a reload here (D21-fix-4: the whole-file run was red on exactly that, 3 of 3).
  let navigations = 0;
  p.on("load", () => {
    navigations += 1;
  });
  const connecting = p.getByTestId("room-own-tile-connecting");
  await expect(connecting, "premise: before the seat, nothing says 'connecting'").toHaveCount(0);

  await p.getByTestId("room-checkin-cta").click();
  await expect(p.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
  expect(claims, "one seat call").toBe(1);
  // The tile says the camera is on its way, in the words it already has for that - quiet: no banner, no error.
  await expect(connecting).toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
  await expect(p.getByTestId("room-own-tile-announce"), "announced once, for a screen reader").toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
  await expect(p.getByTestId("room-camera-off"), "never 'camera off'").toHaveCount(0);
  await expect(p.getByTestId("room-own-tile")).toHaveAttribute("data-stream", "off");
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "d21f3-connecting");

  // The ruling's schedule: 2 s, then 4, then 8 (typed here from the ruling, not read from the code). Each answered
  // "still deferred" until the third, and no seat call repeats meanwhile - only the token is asked for.
  await expect.poll(() => asks.length, { timeout: 40_000, message: "the room asked for its token twice, both times answered 'still deferred'" }).toBe(2);
  expect(claims, "two asks in, no seat call was repeated: the camera route is the token's only door").toBe(1);
  await expect(connecting, "still waiting, still quiet").toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
  await expect(p.getByTestId("room-camera-off")).toHaveCount(0);
  await expect.poll(() => asks.length, { timeout: 40_000, message: "the room asked a third time" }).toBe(3);
  expect(asks[1]! - asks[0]!, "the second ask waits ~4 s after the first").toBeGreaterThanOrEqual(3_500);
  expect(asks[2]! - asks[1]!, "the third ask waits ~8 s after the second").toBeGreaterThanOrEqual(7_500);

  // The token arrived: the cover is gone and the camera session started with it - the SDK refuses the fixture's token,
  // which is what shows it was tried - with the page never reloaded.
  await expect(connecting).toHaveCount(0);
  await expect.poll(() => consoleErrors.some((e) => /^Invalid auth token provided\. /.test(e)), { timeout: 15_000, message: "the camera joined with the delivered token" }).toBe(true);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Invalid auth token provided\. /.test(e)));
  expect(navigations, "no reload").toBe(0);
  const settled = asks.length;
  await p.waitForTimeout(3_000);
  expect(asks.length, "holding a token, the room stops asking").toBe(settled);
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
  await camBrowser.close();

  // The pair: a tokenless seat that does NOT carry the field (camera Off, an organiser's override - the null is final)
  // is never asked about again, and its tile says nothing about connecting.
  const room2 = await seedMatchRoom(page.request, {
    names: [`Cy Mora ${Date.now() % 1e5}`, `Di Vance ${Date.now() % 1e5}`],
    cameraPolicy: "optional",
  });
  const ctx2 = await cold(browser);
  let asks2 = 0;
  await ctx2.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { data: { seat: unknown } };
      body.data.seat = { seated: true, participant: null };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    },
  );
  await ctx2.route(
    (u) => /\/external-play\/room\/camera$/.test(u.pathname),
    async (route: Route) => {
      asks2 += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { participant: null, retry: false }, requestId: "e2e" }) });
    },
  );
  const q = await openRoom(ctx2, room2, room2.white.token);
  await q.getByTestId("room-checkin-cta").click();
  await expect(q.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
  await q.waitForTimeout(2_000 + 3_000); // past the first ask's 2 s, with room to spare
  expect(asks2, "no explicit field, no ask: a null token alone is never read as 'try again'").toBe(0);
  await expect(q.getByTestId("room-own-tile-connecting")).toHaveCount(0);
  await ctx2.unrouteAll({ behavior: "ignoreErrors" });
  await ctx2.close();

  // …and the field is the server's to withdraw: flagged, asked once, answered "no token, and stop" (the budget has nothing to
  // do with it any more - the board was torn down, the policy changed) - the cover goes and the room never asks again, past
  // the next back-off step.
  const room3 = await seedMatchRoom(page.request, {
    names: [`Ev Sato ${Date.now() % 1e5}`, `Fay Ibe ${Date.now() % 1e5}`],
    cameraPolicy: "optional",
  });
  const ctx3 = await cold(browser);
  let asks3 = 0;
  await ctx3.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { data: { seat: unknown } };
      body.data.seat = { seated: true, participant: null, cameraRetry: true };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    },
  );
  await ctx3.route(
    (u) => /\/external-play\/room\/camera$/.test(u.pathname),
    async (route: Route) => {
      asks3 += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { participant: null, retry: false }, requestId: "e2e" }) });
    },
  );
  const w = await openRoom(ctx3, room3, room3.white.token);
  await w.getByTestId("room-checkin-cta").click();
  await expect(w.getByTestId("room-own-tile-connecting")).toHaveText(uiEn["externalPlay.room.checkin.connecting"]!);
  await expect.poll(() => asks3, { timeout: 10_000, message: "asked once, at the ruled 2 s" }).toBe(1);
  await expect(w.getByTestId("room-own-tile-connecting"), "the final null clears the cover").toHaveCount(0);
  await w.waitForTimeout(5_000); // past the 4 s step that would have been the second ask
  expect(asks3, "a final answer is final").toBe(1);
  await ctx3.unrouteAll({ behavior: "ignoreErrors" });
  await ctx3.close();
});


// ─── D16 (design §5.6.3) - the opponent's pill is the OTHER browser's own camera report ─────────────────────────────
//
// Each player is in a meeting of their own, so nothing of the opponent is visible from here: the pill is the opponent's
// browser's word, relayed by the server. This drives it through its REAL producer and consumer - a real camera session in
// one browser reports through the real route, the real server stores it on that player's own seat, and the other browser's
// real room reads it back into its pill. What cannot be real on this runner is the vendor: the RealtimeKit ports are closed
// here and no browser can make a RealtimeKit peer, so (as the D12 and D21-fix-3 tests do) the room/seat answer is rewritten
// to hand the camera a token the SDK will refuse - which is a real `failed` camera, and a `failed` camera reports `off` -
// and the two players' rooms and participants are the rows a check-in leaves, written by SQL. A `live` report needs a live
// peer; it is proven where the session is a unit (camera-session-report.test.ts) and at the route (external-play-camera-report).
//
// Typed from the ruling, never from the code: a report is a heartbeat every 30 s, and a report older than 75 s is unknown.
const RULED_HEARTBEAT_S = 30;
const RULED_STALE_S = 75;

test("D16: the opponent's pill is the OTHER browser's own camera report - a real session reports, the server relays it to the other room, a heartbeat keeps it fresh, silence makes it unknown - and the report lands on the reporter's own seat only", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const room = await seedMatchRoom(page.request, { names: [longName(), longName()], cameraPolicy: "required" });
  await seedGameSql(room, { moves: ["e2e4", "e7e5"], whiteMs: 300_000, blackMs: 296_000 });
  expect(room.whiteSide, "premise: the round is open, so the colours are known").not.toBeNull();
  const sideOf = { white: room.whiteSide!, black: room.whiteSide === "home" ? "away" : "home" } as const;

  // What a check-in leaves: both players checked in, a room each (per player, §5.6.1) and their participant. The meeting
  // ids are not real vendor ids.
  await withDb(async (sql) => {
    for (const colour of ["white", "black"] as const) {
      const who = room[colour];
      const side = sideOf[colour];
      await sql`
        insert into fixture_availability (fixture_id, person_id, org_id, status, checked_in_at)
        select f.id, ${who.personId}, f.org_id, 'in', now() from fixtures f where f.id = ${room.fixtureId}`;
      const m = await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        select f.id, ${side}, f.org_id, ${`e2e-mtg-${side}-${room.fixtureId.slice(0, 8)}`}, f.home_entrant_id, f.away_entrant_id
          from fixtures f where f.id = ${room.fixtureId}`;
      expect(m.count, `a room for ${colour}`).toBe(1);
      const p = await sql`
        insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
        values (${room.fixtureId}, ${side}, ${who.personId}, 'player', ${`e2e-part-${colour}`})`;
      expect(p.count, `a participant for ${colour}`).toBe(1);
    }
  });
  const reported = (colour: "white" | "black") =>
    withDb(async (sql) => {
      const [r] = await sql<{ state: string | null; at: Date | null }[]>`
        select camera_reported as state, camera_reported_at as at from fixture_video_participants
         where fixture_id = ${room.fixtureId} and side = ${sideOf[colour]} and preset = 'player'`;
      return r!;
    });

  // WHITE is the reporter: its seat answer is rewritten to carry a token the SDK refuses (as D21-fix-3's third ask does).
  const ctxWhite = await cold(browser);
  await ctxWhite.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const read = await route.fetch({ method: "GET" });
      const snapshot = ((await read.json()) as { data: unknown }).data;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: { snapshot, seat: { seated: true, participant: { participantId: "e2e-part-white", authToken: "e2e-rtk-refused" } }, create: null },
          requestId: "e2e",
        }),
      });
    },
  );
  // BLACK is the reader only: its seat is seated with no tile, so its camera never starts and reports nothing.
  const ctxBlack = await cold(browser);
  await ctxBlack.route(
    (u) => /\/external-play\/room$/.test(u.pathname),
    async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const read = await route.fetch({ method: "GET" });
      const snapshot = ((await read.json()) as { data: unknown }).data;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { snapshot, seat: { seated: true, participant: null }, create: null }, requestId: "e2e" }),
      });
    },
  );

  const black = await openRoom(ctxBlack, room, room.black.token);
  await boardReady(black);
  const blackPill = black.getByTestId("room-presence-pill");
  const whiteFirst = room.white.name.split(" ")[0]!;
  // Premise (the empty case): nobody has reported, so the pill is the empty ring - never "off" and never hidden.
  await expect(blackPill, "before any report: unknown").toHaveAttribute("data-state", "unknown");
  await expect(blackPill).toHaveText(fill("externalPlay.room.presence.unknown", { name: whiteFirst }));
  expect((await reported("white")).state, "premise: nothing stored").toBeNull();

  // White's page: its camera session fails to join the refused token - a real `failed` camera - and reports `off`.
  const wire: { state: string; heartbeat: boolean; at: number }[] = [];
  const white = await ctxWhite.newPage();
  white.on("console", (m) => {
    if (m.type() === "error" && !SITE_WIDE.has(m.text())) consoleErrors.push(m.text().slice(0, 300));
  });
  white.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
  white.on("request", (r) => {
    if (r.method() === "POST" && /\/external-play\/room\/camera-report/.test(r.url())) {
      const b = r.postDataJSON() as { state: string; heartbeat: boolean };
      wire.push({ state: b.state, heartbeat: b.heartbeat, at: Date.now() });
    }
  });
  await white.setViewportSize({ width: 1280, height: 900 });
  expect((await white.goto(`${room.roomPath}?t=${encodeURIComponent(room.white.token)}`))?.status()).toBe(200);
  await expect(white.getByTestId("match-room")).toBeVisible();

  // THE CHANGE: one report on the wire from the page, stored on WHITE's seat, and black's room reads it into its pill.
  await expect.poll(() => wire.length, { timeout: 30_000, message: "white's camera session sent its report" }).toBeGreaterThanOrEqual(1);
  expect(wire[0], "the first report is a CHANGE, and a failed camera is off").toMatchObject({ state: "off", heartbeat: false });
  await expect(blackPill, "black's room shows white's own report").toHaveAttribute("data-state", "off", { timeout: 20_000 });
  await expect(blackPill).toHaveText(fill("externalPlay.room.presence.off", { name: whiteFirst }));
  const first = await reported("white");
  expect(first.state, "stored on the reporter's own seat").toBe("off");
  expect((await reported("black")).state, "and not on the OTHER player's seat: black reported nothing").toBeNull();
  // The reader's own pill is the READER's opponent: white's room shows black, who has reported nothing.
  await expect(white.getByTestId("room-presence-pill"), "white's pill is black's word, not white's own").toHaveAttribute("data-state", "unknown");

  // THE HEARTBEAT: the same state again, ~30 s later, a heartbeat on the wire that refreshes the stored stamp and changes
  // nothing the other room sees.
  await expect
    .poll(() => wire.length, { timeout: (RULED_HEARTBEAT_S + 20) * 1000, message: "a second report, the heartbeat, came" })
    .toBeGreaterThanOrEqual(2);
  expect(wire[1], "the repeat of an acknowledged state is a heartbeat").toMatchObject({ state: "off", heartbeat: true });
  const gap = (wire[1]!.at - wire[0]!.at) / 1000;
  expect(gap, "…about every 30 s").toBeGreaterThanOrEqual(RULED_HEARTBEAT_S - 3);
  expect(gap).toBeLessThan(RULED_HEARTBEAT_S + 12);
  await expect
    .poll(async () => ((await reported("white")).at?.getTime() ?? 0) > first.at!.getTime(), { timeout: 10_000, message: "the heartbeat refreshed the stored stamp" })
    .toBe(true);
  expect((await reported("white")).state, "and changed no state").toBe("off");
  await expect(blackPill).toHaveAttribute("data-state", "off");

  // The pill fits at every width (the room's full bar), with 43-character names; captured when asked for.
  expect(await noSidewaysScroll(black, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(black, "d16-pill-off");

  // SILENCE: white's browser goes (no more heartbeats), and the report ages. Just inside the ruled stale line the pill still
  // shows it; just past it, unknown - never "off" for a camera nobody has heard from.
  await ctxWhite.close();
  await withDb((sql) => sql`
    update fixture_video_participants set camera_reported_at = now() - make_interval(secs => ${RULED_STALE_S - 15})
     where fixture_id = ${room.fixtureId} and side = ${sideOf.white} and preset = 'player'`);
  await black.waitForTimeout(7_000); // two polls
  await expect(blackPill, `${RULED_STALE_S - 15} s old (and ~7 s older by the time two polls have passed): still fresh`).toHaveAttribute("data-state", "off");
  await withDb((sql) => sql`
    update fixture_video_participants set camera_reported_at = now() - make_interval(secs => ${RULED_STALE_S + 3})
     where fixture_id = ${room.fixtureId} and side = ${sideOf.white} and preset = 'player'`);
  await expect(blackPill, `${RULED_STALE_S + 3} s old: unknown`).toHaveAttribute("data-state", "unknown", { timeout: 20_000 });
  await expect(blackPill).toHaveText(fill("externalPlay.room.presence.unknown", { name: whiteFirst }));
  expect(await noSidewaysScroll(black, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(black, "d16-pill-unknown");

  // The third state. A `live` report needs a live RealtimeKit peer, which no browser here can be, so this one report is WRITTEN
  // (staged, by SQL, as a fresh stamp); what is real is the consumer - the server's room read and black's pill.
  await withDb((sql) => sql`
    update fixture_video_participants set camera_reported = 'live', camera_reported_at = now()
     where fixture_id = ${room.fixtureId} and side = ${sideOf.white} and preset = 'player'`);
  await expect(blackPill, "a fresh live report").toHaveAttribute("data-state", "live", { timeout: 20_000 });
  await expect(blackPill).toHaveText(fill("externalPlay.room.presence.live", { name: whiteFirst }));
  expect(await noSidewaysScroll(black, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(black, "d16-pill-live");

  // The SDK refused white's token, as staged: that console error is the proof the camera was tried; nothing else is allowed.
  expect(consoleErrors.some((e) => /^Invalid auth token provided\. /.test(e)), "the camera joined with the staged token").toBe(true);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Invalid auth token provided\. /.test(e)));
  await ctxBlack.close();
});

// ─── Capacity (design 2026-10-09 §5.7, §6.1; plan: capacity-build-brief.md): the batch wait, the seat 429 wait and the check-in line ───
// Each state is reached the way a player reaches it - the real browser, the real room route, the real server - and only TIME and
// the other players' places are staged (by SQL, said where). The batch wait and the 429 wait spend no vendor call; the line does,
// so its describe starts the RealtimeKit fixture server the app server is pointed at (REALTIMEKIT_FIXTURE_ENV, port 4322).

/** The expected face of a time the page promises (spec §6.1 (1)): the instant rounded UP to the next whole minute, as a 24-hour
 *  clock in the BROWSER's own zone. Worked out here from the rule, not by the room's formatter; the zone is the browser's. */
async function promisedFace(p: Page, instantMs: number): Promise<string> {
  const upMs = Math.ceil(instantMs / 60_000) * 60_000;
  return p.evaluate((ms) => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)), upMs);
}

/** The seat claims (POST …/room) a context sends, with the time each left. */
function watchSeatClaims(ctx: BrowserContext): number[] {
  const at: number[] = [];
  ctx.on("request", (r) => {
    if (r.method() === "POST" && /\/external-play\/room$/.test(new URL(r.url()).pathname)) at.push(Date.now());
  });
  return at;
}

test("capacity, the batch wait: a board whose check-in group has not opened says when it will, in the viewer's zone and rounded up, sends no seat claim, and the room re-reads at the opening on its own — at every width", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  // STAGED: the round was opened so that this board's window opens in OPENS_IN_MS. A board's window opens WINDOW_OPEN_LEAD_MS before
  // its anchor (the round's opening, for the first batch), so the anchor is set that far past the instant wanted.
  const OPENS_IN_MS = 9_000;
  const opensAtMs = Date.now() + OPENS_IN_MS;
  const openedAt = new Date(opensAtMs + WINDOW_OPEN_LEAD_MS);
  await withDb((sql) => sql`update stage_round_opens set opened_at = ${openedAt} where id = ${room.roundOpen!.id}`);
  const token = await mintMatchRoomLink({ fixtureId: room.fixtureId, personId: room.white.personId, roundOpenId: room.roundOpen!.id, openedAt });

  const ctx = await cold(browser);
  const claims = watchSeatClaims(ctx);
  const p = await openRoom(ctx, room, token);
  expect(await screenOf(p), "the round is open and this board's group is not: the batch wait, not 'not opened'").toBe("batchWait");
  const face = await promisedFace(p, opensAtMs);
  await expect(p.getByTestId("room-batch-wait-time")).toHaveText(fill("externalPlay.room.state.batchWait.time", { time: face }));
  await expect(p.getByText(fill("externalPlay.room.state.batchWait.body", { time: face }))).toBeVisible();
  await expect(p.getByTestId("room-checkin-cta"), "no check-in to press yet").toHaveCount(0);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "capacity-batch-wait");

  // The opening: the room re-reads at it (plus a jitter of up to 2 s, spec §6.1 (1)) with nobody touching the page, and never before.
  // The deadline is the opening plus that jitter plus 3.5 s of slack - and NOT the 15 s idle poll's reach: the page's first read was
  // made at least OPENS_IN_MS - (the setup before it) earlier, so a lost timer would flip at the idle poll, at least 6 s after the
  // opening, which this deadline refuses (the timer is what is being proved, not the poll behind it).
  await expect
    .poll(() => screenOf(p), { timeout: Math.max(1_000, opensAtMs + 2_000 + 3_500 - Date.now()), message: "the batch opens and the page shows the check-in, on the timer" })
    .toBe("checkin");
  expect(Date.now(), "never before the door opens").toBeGreaterThanOrEqual(opensAtMs - 500);
  await expect(p.getByTestId("room-checkin-cta")).toBeVisible();
  expect(claims, "waiting sent no seat claim: the door was shut and the page knew").toEqual([]);
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await ctx.close();
});

test("capacity, the seat 429 wait: a refused check-in shows 'Try again in N s' from Retry-After, the button stays shut and NOTHING is sent until the time is up, then the same press seats — at every width", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`Bo Lind ${Date.now() % 1e5}`, `Ada Okonkwo ${Date.now() % 1e5}`] });
  // STAGED: this player has already used the seat door's 20 asks (D21-fix-4, KEEP 20) in a window that has WAIT_S seconds left.
  const WAIT_S = 7;
  await withDb(
    (sql) => sql`
      insert into fixture_seat_asks (fixture_id, person_id, route, window_started_at, asks)
      values (${room.fixtureId}, ${room.white.personId}, 'seat', now() - make_interval(secs => ${SEAT_ASK_WINDOW_S - WAIT_S}), 20)
      on conflict (fixture_id, person_id, route) do update
         set window_started_at = excluded.window_started_at, asks = excluded.asks`,
  );
  const ctx = await cold(browser);
  const claims = watchSeatClaims(ctx);
  const p = await openRoom(ctx, room, room.white.token);
  expect(await screenOf(p)).toBe("checkin");
  const cta = p.getByTestId("room-checkin-cta");
  const refused = p.waitForResponse((r) => r.request().method() === "POST" && /\/external-play\/room$/.test(new URL(r.url()).pathname));
  await cta.click();
  const res = await refused;
  const refusedAt = Date.now();
  expect(res.status(), "the real limiter refuses the 21st ask").toBe(429);
  const retryAfter = Number(res.headers()["retry-after"]);
  expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= SEAT_ASK_WINDOW_S, `a whole-second Retry-After inside the window (${res.headers()["retry-after"]})`).toBe(true);
  expect(retryAfter, "the window the test staged had about WAIT_S left").toBeGreaterThanOrEqual(WAIT_S - 3);
  expect(retryAfter).toBeLessThanOrEqual(WAIT_S);

  const countdown = p.getByTestId("room-seat-wait-countdown");
  await expect(countdown, "the wait is shown at once, from the header").toBeVisible();
  await expect(p.getByTestId("room-seat-wait")).toHaveAttribute("data-waiting", "true");
  await expect(p.getByText(uiEn["externalPlay.room.state.seatWait.title"]!, { exact: true }), "the title (the screen-reader copy beside it is the same words)").toBeVisible();
  const first = Number(/\d+/.exec(await countdown.innerText())![0]);
  expect(first, "the face starts at (or one tick under) Retry-After").toBeGreaterThanOrEqual(retryAfter - 1);
  expect(first).toBeLessThanOrEqual(retryAfter);
  await expect(cta, "the button is shut for the whole wait").toBeDisabled();
  expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
  await shoot(p, "capacity-seat-wait");
  // The wait is on the page, not just in the markup: the screen reader hears it start.
  await expect(p.getByTestId("room-seat-wait-announce")).toContainText(uiEn["externalPlay.room.state.seatWait.title"]!);

  // Nothing is sent while it runs - not by a tab coming back into view, not by anything else.
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await p.waitForTimeout(1_500);
  expect(claims.length, "only the refused press so far").toBe(1);
  // It ends on time: not before Retry-After, and the button comes back.
  await expect(cta).toBeEnabled({ timeout: (retryAfter + 4) * 1_000 });
  const waited = Date.now() - refusedAt;
  expect(waited, "not before Retry-After").toBeGreaterThanOrEqual(retryAfter * 1_000 - 250);
  expect(waited, "and not much after it").toBeLessThan(retryAfter * 1_000 + 3_500);
  expect(claims.length, "still nothing sent while it waited").toBe(1);
  await expect(p.getByTestId("room-seat-wait"), "the note is quiet").toHaveAttribute("data-waiting", "false");
  await expect(p.getByTestId("room-seat-wait-announce")).toContainText(uiEn["externalPlay.room.state.seatWait.ready"]!);

  // The same press, now, is answered: the window reopened.
  await cta.click();
  await expect.poll(() => checkedInAt(room.fixtureId, room.white.personId), { timeout: 15_000, message: "the seat is taken and the check-in stamped" }).not.toBeNull();
  expect(claims.length, "the second press went out").toBe(2);
  // The browser logs the refused request itself ("Failed to load resource ... 429"): expected here, exactly once, and only here.
  const refusedLogs = consoleErrors.filter((e) => /^Failed to load resource: the server responded with a status of 429 /.test(e));
  expect(refusedLogs.length, "the one refused press is the only 429 the console saw").toBe(1);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !refusedLogs.includes(e)));
  await ctx.close();
});

test.describe("capacity, the check-in line", () => {
  // One worker owns the fixture server's port for the whole block (the app server is pointed at 4322).
  test.describe.configure({ mode: "serial" });
  let fx: RealtimeKitFixtureServer;
  test.beforeAll(async () => {
    fx = await startRealtimeKitFixtureServer();
  });
  test.afterAll(async () => {
    await fx.close();
  });

  test("a player the budget is holding sees their place, is asked about nothing at the vendor, polls at the server's cadence on the line door, is told why when they fall to the back, and is let through when the line drains — at every width", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    fx.reset();
    // The line is per budget bucket: budgetKey(baseUrl, accountId) (budget.ts - server-only, so its format is restated here; if it
    // drifts the stay below is in another bucket, nobody is ahead, and the line card never appears: this test fails loudly).
    const bucket = `${REALTIMEKIT_FIXTURE_URL}|${REALTIMEKIT_FIXTURE_ENV.CLOUDFLARE_ACCOUNT_ID}`;
    const names = (n: string): [string, string] => [`Bo ${n} ${Date.now() % 1e5}`, `Ada ${n} ${Date.now() % 1e5}`];
    const room = await seedMatchRoom(page.request, { names: names("Lind"), cameraPolicy: "required" });
    const ahead = await seedMatchRoom(page.request, { names: names("Ahead"), cameraPolicy: "required" });
    const aheadId = { fixtureId: ahead.fixtureId, personId: ahead.white.personId };
    // STAGED: somebody else is waiting in this bucket, arrived 30 s ago, and keeps asking (refreshed each second until drained).
    await withDb(
      (sql) => sql`
        insert into fixture_seat_line (fixture_id, person_id, budget_key, first_claim_at, last_seen_at, last_gate, queued_at)
        values (${aheadId.fixtureId}, ${aheadId.personId}, ${bucket}, now() - interval '30 seconds', now(), 'held', now() - interval '30 seconds')`,
    );
    let keeping = true;
    const keep = setInterval(() => {
      if (keeping) void withDb((sql) => sql`update fixture_seat_line set last_seen_at = now() where fixture_id = ${aheadId.fixtureId} and person_id = ${aheadId.personId}`).catch(() => {});
    }, 1_000);
    const camBrowser = await page.context().browser()!.browserType().launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    try {
      const ctx = await cold(camBrowser);
      await ctx.grantPermissions(["camera"]);
      const claims = watchSeatClaims(ctx);
      const p = await openRoom(ctx, room, room.white.token);
      expect(await screenOf(p)).toBe("checkin");
      // The camera is tested on the page, then Check in is pressed (the D15 flow): the real claim reaches the gate.
      await p.getByTestId("room-checkin-test-cta").click();
      const cta = p.getByTestId("room-checkin-cta");
      await expect(cta).toBeEnabled({ timeout: 15_000 });
      await cta.click();

      // The line card: the place (behind the one waiting), the estimate, the instruction, when check-in closes. Not the button, not
      // the deadline countdown.
      const line = p.getByTestId("room-line");
      await expect(line).toBeVisible({ timeout: 15_000 });
      await expect(line).toHaveAttribute("data-position", "2");
      await expect(p.getByTestId("room-line-position")).toHaveText(fill("externalPlay.room.state.line.title", { position: 2 }));
      await expect(p.getByTestId("room-line-eta")).toContainText(/\d/);
      await expect(p.getByTestId("room-line-body")).toHaveText(fill("externalPlay.room.state.line.body", { seconds: LINE_ABANDON_AFTER_MS / 1_000 }));
      await expect(p.getByTestId("room-line-closes")).toBeVisible();
      await expect(p.getByTestId("room-checkin-cta"), "the line replaces the button").toHaveCount(0);
      await expect(p.getByTestId("room-checkin-countdown"), "and the deadline countdown").toHaveCount(0);
      await expect(p.getByTestId("room-line-left"), "nobody has left yet: no explanation").toHaveCount(0);
      expect(fx.calls.length, "held in line, the claim reached the vendor NOT AT ALL").toBe(0);
      expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
      await shoot(p, "capacity-line");

      // The cadence: the room asks again after the server's pollMs (3 s for the first five places), never faster than the floor,
      // and with no upper bound. Three more claims observed.
      await expect.poll(() => claims.length, { timeout: 30_000, message: "the room keeps asking" }).toBeGreaterThanOrEqual(4);
      const gaps = claims.slice(1, 4).map((t, i) => t - claims[i]!);
      expect(gaps.length, "anti-vacuity: three gaps").toBe(3);
      for (const g of gaps) {
        expect(g, "never faster than the floor").toBeGreaterThanOrEqual(LINE_POLL_MIN_MS - 100);
        expect(g, "the near cadence, as the server said").toBeGreaterThanOrEqual(LINE_POLL_MS - 150);
        expect(g, "and not lost").toBeLessThan(LINE_POLL_MS + 2_500);
      }
      // The door: the first press counted on the seat door, the polls on the line door (so a queued player never eats the 20).
      const asks = await withDb((sql) =>
        sql<{ route: string; asks: number }[]>`select route, asks from fixture_seat_asks where fixture_id = ${room.fixtureId} and person_id = ${room.white.personId} order by route`,
      );
      const byRoute = Object.fromEntries(asks.map((a) => [a.route, a.asks]));
      expect(byRoute.seat, "one press on the seat door").toBe(1);
      expect(byRoute.line, "the polls on the line door").toBeGreaterThanOrEqual(3);
      expect(fx.calls.length, "and still nothing at the vendor").toBe(0);

      // STAGED: the page went to sleep - the stay's last word is older than LINE_ABANDON_AFTER_MS. The next claim finds it lapsed,
      // starts a new stay at the back, and the room says why (once, on the claim that starts it; the card keeps it).
      await withDb(
        (sql) => sql`update fixture_seat_line set last_seen_at = now() - make_interval(secs => ${LINE_ABANDON_AFTER_MS / 1_000 + 5}) where fixture_id = ${room.fixtureId} and person_id = ${room.white.personId}`,
      );
      const left = p.getByTestId("room-line-left");
      await expect(left, "the card says why the player is at the back again").toBeVisible({ timeout: 15_000 });
      await expect(left).toHaveAttribute("data-left", "silent");
      await expect(left).toHaveText(uiEn["externalPlay.room.state.line.left"]!);
      await expect(line).toHaveAttribute("data-position", "2");
      const sawLeft = claims.length;
      await expect.poll(() => claims.length, { timeout: 15_000 }).toBeGreaterThan(sawLeft + 1);
      await expect(left, "and it stays for as long as the card shows").toBeVisible();
      expect(await noSidewaysScroll(p, ALL_WIDTHS), "anti-vacuity: widths").toBe(ALL_WIDTHS.length);
      await shoot(p, "capacity-line-left");

      // The line drains (the player ahead is served or gone): the next claim is let through, the card goes, and the vendor is
      // called for the first time - the mint.
      keeping = false;
      await withDb((sql) => sql`delete from fixture_seat_line where fixture_id = ${aheadId.fixtureId} and person_id = ${aheadId.personId}`);
      await expect(line, "the line is over for this player").toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => fx.calls.length, { timeout: 15_000, message: "the claim spends, now it may" }).toBeGreaterThan(0);
      expect(fx.calls.some((c) => /POST \/meetings$/.test(c.route)), "the meeting is minted only after the line let the claim through").toBe(true);
      await ctx.close();
      // The SDK then joins with the fixture's token, which the vendor's SDK refuses: expected here, and only here.
      consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/^Invalid auth token provided\. /.test(e)));
    } finally {
      keeping = false;
      clearInterval(keep);
      await camBrowser.close();
      // Leave the bucket as found: no stay of this test may hold a later test's optional claim.
      await withDb((sql) => sql`delete from fixture_seat_line where budget_key = ${bucket}`);
    }
    testInfo.annotations.push({ type: "capacity", description: "line card, cadence, door split, left, drain" });
  });
});
