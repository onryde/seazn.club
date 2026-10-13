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
 *    the poll, and the not-opened line before the round opens; from the
 *    round's open, the start position with the waiting line (T17 round B,
 *    option B), and a first move that moves nothing on the page;
 *  - /me's Lichess card for an entered player who is not linked, its 44px
 *    controls hit-tested, and the re-link's grant disclosure;
 *  - T16 fix round 1: the Open round confirmation's earlier-round note (R1),
 *    the run sheet's quiet connection chip (I3), "Mark as reviewed" on a
 *    finished flagged board, the fixture page's Live header while the game is
 *    played (R3), the division list's watch links (I4), and the Lichess card
 *    on the registration's consent step (I5).
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
import { apiJson, loginUi, withDb } from "./helpers";
import {
  CLOCK,
  fill,
  longName,
  roundGameSql,
  seedGameSql,
  seedMatchRoom,
  seedLichessLink,
  seedOnlineRound,
  seedUser,
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

/** R2's readable "signed in" hint (lib/session-hint.ts SESSION_HINT_COOKIE), read from its source: a client module
 *  this runner does not import. */
const SESSION_HINT = (() => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/session-hint.ts", import.meta.url)), "utf8");
  const m = /export const SESSION_HINT_COOKIE = "([^"]+)";/.exec(src);
  if (!m) throw new Error("online-chess-desk: SESSION_HINT_COOKIE not found in session-hint.ts");
  return m[1]!;
})();

/** The public site's own English dictionary (the match centre's header words). */
const publicEn = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/public.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The division's public Fixtures list: each fixture row's own link, by the fixture it opens. */
const listRow = (page: Page, fixtureId: string) => page.locator(`a[href$="/fixtures/${fixtureId}"]`);

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

/** M5: a control a thumb can hit — at least 44px tall at 320, and a tap at its centre lands on it (paint is not hit:
 *  `boundingBox()` measures the one, `elementFromPoint` the other). */
async function tappable(page: Page, control: ReturnType<Page["getByTestId"]>, name: string): Promise<void> {
  await page.setViewportSize({ width: 320, height: 700 });
  // Centred, so the site's cookie notice (pinned to the bottom of a cold context) is not what the tap meets.
  await control.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await control.boundingBox();
  expect(box, `${name}: has a box`).not.toBeNull();
  expect(box!.height, `${name}: 44px tall at 320`).toBeGreaterThanOrEqual(44);
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (top === el || el.contains(top));
  });
  expect(hit, `${name}: a tap at its centre lands on it`).toBe(true);
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
    // R1, the empty case: round 1 has no earlier round, so no note.
    await expect(dialog.getByTestId("open-round-earlier")).toHaveCount(0);
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

    // R1: round 2's confirmation says round 1 is still being played (its boards still to be played), and opening
    // stays the organiser's call — the confirm is there. Cancel sends nothing.
    await page.setViewportSize({ width: 1280, height: 900 });
    await roundControl(2).getByTestId("open-round-cta").click();
    const second = page.getByTestId("open-round-confirm");
    await expect(second).toContainText(fill("runsheet.round.confirmTitle", { round: 2 }));
    const earlier = second.getByTestId("open-round-earlier");
    await expect(earlier).toHaveAttribute("role", "note");
    await expect(earlier.locator("[data-earlier-round]")).toHaveCount(1);
    await expect(earlier.locator('[data-earlier-round="1"]')).toHaveText(
      fill("runsheet.round.confirmEarlierInPlay.other", { round: 1, count: r.boards.length }),
    );
    await expect(page.getByTestId("open-round-confirm-confirm")).toBeEnabled();
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "open-round-earlier");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("open-round-confirm-cancel").click();
    await expect(second).toHaveCount(0);
    expect(await opens(), "Cancel opened nothing: round 1's open is still the only one").toBe(1);
  });

  test("the queue: a held board settled from it, a flagged board let go on — and the run sheet's chips point at both", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor", "Eli Brandt"], {
      camera: "required",
    });
    const [held, flagged, over] = [r.boards[0]!, r.boards[1]!, r.boards[2]!];
    await roundGameSql(held, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await roundGameSql(flagged, { moves: LINE });
    await flagBoard(r, flagged);
    // I3: our safeguard's connection problems on the flagged board, in the sweep's job-5 note format (see the header).
    await withDb(
      (sql) => sql`
        insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
          (${flagged.fixtureId}, ${r.orgId}, 'camera_connection_problems', ${flagged.home.personId},
           ${"61 s stamped as our side's camera connection problems, 1 stamp in the match: no time inside it; camera required"})`,
    );
    // A finished game whose flag is still open: its result through the organiser's own scoring API (what reconcile
    // writes), the flag reconcile's out-of-band adoption left behind.
    await roundGameSql(over, { moves: LINE });
    for (const [seq, event] of [
      [0, { type: "core.start", payload: {} }],
      [1, { type: "boardgame.result", payload: { winner: over.home.entrantId, method: "resign" } }],
    ] as const) {
      const res = await apiJson(request, `/api/v1/fixtures/${over.fixtureId}/events`, "POST", { expected_seq: seq, ...event });
      expect(res.status, JSON.stringify(res.error)).toBeLessThan(300);
    }
    await withDb(
      (sql) => sql`
        insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
          (${over.fixtureId}, ${r.orgId}, 'out_of_band_play', null,
           ${`plies 3-4 (${LINE.slice(2, 4).join(" ")}) played at Lichess, not through Seazn; camera required`})`,
    );

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
    // I3: our side's connection problems — the quiet chip, to the same panel; never counted as a camera flag.
    const connection = flaggedRow.getByTestId("run-sheet-connection-chip");
    await expect(connection).toHaveAttribute("data-state", "ours");
    await expect(connection).toHaveText(uiEn["arbiter.flag.connection.chipPlain"]!);
    await expect(connection).toHaveAttribute("href", `${r.arbiterPath}?fixture=${flagged.fixtureId}`);
    await expect(heldRow.getByTestId("run-sheet-connection-chip")).toHaveCount(0);

    // The queue: Held | Flagged, each board once.
    const queue = page.getByTestId("external-play-needs-result-queue");
    await expect(queue.getByTestId("external-play-held")).toContainText(fill("externalPlay.queue.heldHeading", { count: 1 }));
    await expect(queue.getByTestId("external-play-flagged")).toContainText(fill("externalPlay.queue.flaggedHeading", { count: 2 }));
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
    expect(flags, "all three flags closed and kept, resolved by an organiser").toEqual([
      { closed: true, role: expect.stringMatching(/^(owner|admin)$/) },
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
    await expect(flaggedRow.getByTestId("run-sheet-connection-chip")).toHaveCount(0);

    // A finished game's flags: nothing to let go on — "Mark as reviewed" closes them, and the queue says so.
    const overCard = queue.getByTestId(`external-play-flagged-${over.fixtureId}`);
    const review = overCard.getByTestId("external-play-go-on");
    await expect(review).toHaveText(uiEn["externalPlay.queue.markReviewed"]!);
    await review.click();
    await expect(answer).toHaveText(uiEn["externalPlay.queue.reviewed"]!);
    await expect(queue.getByTestId(`external-play-flagged-${over.fixtureId}`)).toHaveCount(0);
    const overFlags = await withDb(
      (sql) => sql<{ closed: boolean }[]>`select closed_at is not null as closed from fixture_play_flags where fixture_id = ${over.fixtureId}`,
    );
    expect(overFlags, "closed and kept").toEqual([{ closed: true }]);

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
  test("Your board: the signed-in player's door into THEIR room; a stranger gets nothing — and asks nothing (R2)", async ({ browser, request }) => {
    test.setTimeout(180_000 + 2 * POLL_MS);
    const room = await seedMatchRoom(request, { names: [longName(), "Bo Lindqvist"] });

    const ctx = await cold(browser);
    const p = await ctx.newPage();
    await loginUi(p, room.white.email, room.fixturePath);
    await p.waitForURL((u) => u.pathname === room.fixturePath);
    const card = p.getByTestId("your-board");
    // R2: signing in set the readable hint beside the session, so the island asks the lobby.
    expect((await ctx.cookies()).filter((c) => c.name === SESSION_HINT).map((c) => [c.value, c.httpOnly])).toEqual([["1", false]]);
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

    // Anonymous (R2): no session hint, so the island never asks the lobby — no 401 in a spectator's console — and
    // shows nothing. Absence is read only once the page's client has run: the watch panel's own poll has answered.
    const anon = await cold(browser);
    const a = await anon.newPage();
    const lobby: string[] = [];
    a.on("request", (req) => {
      if (req.url().includes(`/fixtures/${room.fixtureId}/external-play/lobby`)) lobby.push(req.url());
    });
    const polled = a.waitForResponse((res) => res.url().includes(`/api/v1/public/fixtures/${room.fixtureId}`), { timeout: POLL_MS + 30_000 });
    await a.goto(room.fixturePath);
    await expect(a.getByTestId("watch-panel")).toBeVisible();
    expect((await polled).status(), "premise: the page's client is running").toBe(200);
    expect(lobby, "no lobby request without the hint").toEqual([]);
    expect((await anon.cookies()).filter((c) => c.name === SESSION_HINT)).toEqual([]);
    await expect(a.getByTestId("your-board")).toHaveCount(0);
    await anon.close();
  });

  // T17 round B, D: a full-page capture draws the site's sticky header wherever the capture's viewport ended, which
  // put it across the "Your board" card in a 320 shot. This reads the live page instead: what a tap at each of the
  // card's lines meets, at rest and with the card scrolled up to the header.
  test("D: at 320 the site's sticky header sits over no line of Your board — at rest, and scrolled up to it", async ({ browser, request }) => {
    test.setTimeout(180_000);
    const room = await seedMatchRoom(request, { names: [longName(), "Bo Lindqvist"] });
    const ctx = await cold(browser);
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 320, height: 700 });
    await loginUi(p, room.white.email, room.fixturePath);
    await p.waitForURL((u) => u.pathname === room.fixturePath);
    const card = p.getByTestId("your-board");
    await expect(card).toHaveAttribute("data-state", "check_in", { timeout: 30_000 });
    /** Each line of the card that is fully on screen, hit-tested at its left, centre and right: a hit that lands in
     *  the sticky header is a line the header hides. */
    const read = () =>
      p.evaluate(() => {
        const header = document.querySelector("header.sticky")!.getBoundingClientRect();
        const cardEl = document.querySelector('[data-testid="your-board"]')!;
        const lines = [...cardEl.querySelectorAll("p"), ...cardEl.querySelectorAll('[data-testid="your-board-link"]')];
        let checked = 0;
        const hidden: string[] = [];
        for (const line of lines) {
          const r = line.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) continue;
          for (const x of [r.left + 4, r.left + r.width / 2, r.right - 4]) {
            const top = document.elementFromPoint(x, r.top + r.height / 2);
            if (top === null || !(top === line || line.contains(top))) hidden.push(`${line.textContent} at x=${Math.round(x)}`);
            checked += 1;
          }
        }
        return { headerTop: Math.round(header.top), headerBottom: Math.round(header.bottom), cardTop: Math.round(cardEl.getBoundingClientRect().top), lines: lines.length, checked, hidden };
      });

    await p.evaluate(() => window.scrollTo(0, 0));
    const rest = await read();
    expect(rest.lines, "anti-vacuity: title, state and the link").toBe(3);
    expect(rest.checked, "every line on screen at rest").toBe(9);
    expect(rest.headerTop, "at rest the header is at the top").toBe(0);
    expect(rest.cardTop, "the card starts below it").toBeGreaterThanOrEqual(rest.headerBottom);
    expect(rest.hidden).toEqual([]);
    if (SHOTS) await p.screenshot({ path: join(SHOTS, "d-your-board-rest-320.png"), caret: "initial" });

    // Scrolled until the card's top meets the header's bottom: the header stays put and the card reads in full.
    await p.evaluate(() => {
      const header = document.querySelector("header.sticky")!.getBoundingClientRect();
      window.scrollBy(0, document.querySelector('[data-testid="your-board"]')!.getBoundingClientRect().top - header.bottom);
    });
    const scrolled = await read();
    expect(scrolled.headerTop, "premise: the page did scroll, and the header stuck").toBe(0);
    expect(scrolled.cardTop, "premise: the card is up against the header").toBe(scrolled.headerBottom);
    expect(scrolled.checked).toBe(9);
    expect(scrolled.hidden).toEqual([]);
    if (SHOTS) await p.screenshot({ path: join(SHOTS, "d-your-board-scrolled-320.png"), caret: "initial" });

    // The positive pair: 24px further, the title's middle is under the header — and the hit-test says so.
    await p.evaluate(() => window.scrollBy(0, 24));
    const under = await read();
    expect(under.hidden.some((h) => h.startsWith(uiEn["externalPlay.yourBoard.title"]!)), JSON.stringify(under.hidden)).toBe(true);
    await ctx.close();
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
    await expect(panel).toHaveAttribute("data-state", "live", { timeout: 30_000 });
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

    // R3: the fixture is still `scheduled` (nothing writes in_play for a Lichess game), yet the header reads Live
    // while its game is being played — on the page as served, and after the poll.
    const status = await withDb(async (sql) => (await sql<{ s: string }[]>`select status as s from fixtures where id = ${room.fixtureId}`)[0]!.s);
    expect(status, "premise: the fixture row still says scheduled").toBe("scheduled");
    await expect(page.getByTestId("mc-live-pill")).toHaveText(publicEn["matchCentre.status.live"]!);
    await page.reload();
    await expect(page.getByTestId("mc-live-pill")).toHaveText(publicEn["matchCentre.status.live"]!, { timeout: 30_000 });
    await shoot(page, "watch-live-header");

    // I4: the division's Fixtures list says the board can be watched — a label inside the row's own link, which
    // opens this page, never Lichess.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${room.standingsPath}?tab=schedule`);
    const row = listRow(page, room.fixtureId).first();
    const watch = row.getByTestId("schedule-watch");
    await expect(watch).toHaveAttribute("data-kind", "live", { timeout: 30_000 });
    await expect(watch).toContainText(uiEn["externalPlay.watch.list.live"]!);
    await expect(row.locator("a")).toHaveCount(0);
    await expect(page.locator('a[href*="lichess.org"]')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "division-watch-live");
    await page.setViewportSize({ width: 1280, height: 900 });
    await row.click();
    await page.waitForURL((u) => u.pathname === room.fixturePath);
    await expect(page.getByTestId("watch-panel")).toBeVisible();
    await ctx.close();
  });

  test("option B: from the round's open, the board at the start position — names on their side, clocks at the initial time, the waiting line; the first move moves nothing", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000 + 4 * POLL_MS);
    const room = await seedMatchRoom(request, { names: [longName(), "Bo Lindqvist"] });
    const start = new Chess();
    // The division's clock as the kit set it (10+5): both faces read the base time, as a chess clock shows it.
    const initial = `${Math.floor(CLOCK.base / 60)}:${String(CLOCK.base % 60).padStart(2, "0")}`;

    const ctx = await cold(browser);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(room.fixturePath);
    const panel = page.getByTestId("watch-panel");
    await expect(panel).toHaveAttribute("data-state", "not_started", { timeout: 30_000 });
    const status = page.getByTestId("watch-status");
    await expect(status).toHaveAttribute("data-kind", "waiting");
    await expect(status).toHaveText(uiEn["externalPlay.watch.status.waiting"]!);
    const surface = page.getByTestId("room-board-surface");
    await expect(surface).toHaveAttribute("data-fen", start.fen());
    await expect(surface).toHaveAttribute("data-view-only", "true");
    await expect(page.locator("cg-board piece")).toHaveCount(32);
    await expect(page.getByTestId("watch-clock-white")).toContainText(room.white.name);
    await expect(page.getByTestId("watch-clock-black")).toContainText(room.black.name);
    await expect(page.getByTestId("watch-clock-white")).toContainText(initial);
    await expect(page.getByTestId("watch-clock-black")).toContainText(initial);
    await expect(panel).toContainText(uiEn["externalPlay.watch.viewOnly"]);
    await expect(page.locator('a[href*="lichess.org"]')).toHaveCount(0);
    // C: the header names the format by the time control — the kit's division declares Classical, and Lichess plays
    // 10+5 as Rapid.
    await expect(page.getByTestId("mc-meta-line")).toContainText(uiEn["variant.boardgame.rapid"]!);
    await expect(page.getByTestId("mc-meta-line")).not.toContainText(uiEn["variant.boardgame.classical"]!);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "b-not-started");

    /** Where the status line, the board and both clocks sit inside the panel, at a width — measured from the panel's
     *  own corner, because the page above it is not the panel's: a fixture with no time loses its "Time TBD" line
     *  when the header goes Live (fixture-subheading.ts, R11 C3), which moves the whole panel, not its contents. */
    const layout = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      return page.evaluate(() => {
        const panel = document.querySelector('[data-testid="watch-panel"]')!.getBoundingClientRect();
        const box = (id: string) => {
          const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
          return r ? [Math.round(r.left - panel.left), Math.round(r.top - panel.top), Math.round(r.width), Math.round(r.height)] : null;
        };
        return {
          status: box("watch-status"),
          board: box("room-board-surface"),
          white: box("watch-clock-white"),
          black: box("watch-clock-black"),
        };
      });
    };
    const WIDTHS = [320, 768, 1280];
    const before: Record<number, Awaited<ReturnType<typeof layout>>> = {};
    for (const w of WIDTHS) {
      before[w] = await layout(w);
      // The line belongs to the board: it starts where the board's column starts (at 768 that column is centred).
      expect(before[w]!.status?.[0], `the status line lines up with the board at ${w}px`).toBe(before[w]!.black?.[0]);
    }

    // The first move (labelled SQL, the kit's: T10's append of 1.e4) reaches the open page through the poll.
    await page.setViewportSize({ width: 1280, height: 900 });
    const { fen: afterE4 } = await seedGameSql(room, { moves: ["e2e4"] });
    await expect(surface).toHaveAttribute("data-fen", afterE4, { timeout: POLL_MS + 15_000 });
    await expect(panel).toHaveAttribute("data-state", "live");
    await expect(status).toHaveAttribute("data-kind", "black");
    await expect(status).toHaveText(uiEn["externalPlay.watch.status.blackToMove"]!);
    let compared = 0;
    for (const w of WIDTHS) {
      const after = await layout(w);
      for (const part of ["status", "board", "white", "black"] as const) {
        expect(before[w]![part], `${part} at ${w}px has a box`).not.toBeNull();
        expect(after[part], `${part} at ${w}px: the first move moved nothing`).toEqual(before[w]![part]);
        compared += 1;
      }
    }
    expect(compared, "anti-vacuity: 4 parts × 3 widths").toBe(12);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "b-first-move");

    // Further on (eight plies): White to move, the same line above the board.
    await page.setViewportSize({ width: 1280, height: 900 });
    const { fen } = await seedGameSql(room, { moves: LINE });
    await expect(surface).toHaveAttribute("data-fen", fen, { timeout: POLL_MS + 15_000 });
    await expect(status).toHaveAttribute("data-kind", "white");
    await expect(status).toHaveText(uiEn["externalPlay.watch.status.whiteToMove"]!);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "b-live");
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
    // R3, the other direction: no game being played — the header keeps "Scheduled", never Live.
    await expect(page.getByTestId("mc-live-pill")).toHaveCount(0);
    await expect(page.getByTestId("mc-result-chip")).toHaveText(publicEn["matchCentre.status.scheduled"]!);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "watch-not-opened");

    // I4: the division list says the round is not opened yet, on this board's row.
    await page.goto(`${room.standingsPath}?tab=schedule`);
    const watch = listRow(page, room.fixtureId).first().getByTestId("schedule-watch");
    await expect(watch).toHaveAttribute("data-kind", "not_opened", { timeout: 30_000 });
    await expect(watch).toHaveText(uiEn["externalPlay.watch.list.notOpened"]!);
    expect(await noSidewaysScroll(page)).toBe(3);
    await shoot(page, "division-watch-not-opened");
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
      await expect(card.getByTestId("lichess-scope"), "a first link has no re-link disclosure").toHaveCount(0);
      await tappable(p, card.getByTestId("lichess-link"), "Link");
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
      await expect(linked.getByTestId("lichess-relink")).toHaveCount(0);
      await tappable(q, linked.getByTestId("lichess-unlink"), "Unlink");
      // A grant from before the play scopes (labelled SQL: what an identity-only consent left on the row): the card
      // asks again, says what the new grant allows, and both controls stay thumb-sized.
      await withDb((sql) => sql`update user_external_accounts set scopes = array['email:read'] where user_id = ${room.black.userId} and provider = 'lichess'`);
      await q.setViewportSize({ width: 1280, height: 900 });
      await q.reload();
      await expect(linked.getByTestId("lichess-reconsent")).toBeVisible({ timeout: 30_000 });
      const scope = linked.getByTestId("lichess-scope");
      await expect(scope).toContainText(uiEn["settings.account.lichess.consent.title"]!);
      await expect(scope).toContainText(uiEn["settings.account.lichess.consent.scopes"]!);
      await tappable(q, linked.getByTestId("lichess-relink"), "Re-link");
      await tappable(q, linked.getByTestId("lichess-unlink"), "Unlink (re-link state)");
      expect(await noSidewaysScroll(q)).toBe(3);
      await shoot(q, "me-lichess-relink");
    } else {
      await expect(linked.getByTestId("lichess-not-configured")).toBeVisible();
    }
    await ctx2.close();
  });
});

test.describe("online chess — registration (I5)", () => {
  /** The start can only be offered by a server with a Lichess client (see /me above). */
  const CONFIGURED = Boolean(process.env.LICHESS_CLIENT_ID);

  /** A public competition with one free, open online division (camera off) — registration through the product's own
   *  settings route. */
  async function openOnlineRegistration(request: Parameters<typeof seedOnlineRound>[0]) {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Sign-up ${Date.now() % 1e6}`,
      visibility: "public",
    });
    expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
    const name = `Online Rapid ${Date.now() % 1e5}`;
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name,
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
    });
    expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
    const settings = await apiJson(request, `/api/v1/divisions/${div.data!.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });
    expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
    return withDb(async (sql) => {
      const [row] = await sql<{ org: string; comp: string }[]>`
        select o.slug as org, c.slug as comp from competitions c join organizations o on o.id = c.org_id where c.id = ${comp.data!.id}`;
      return { divisionName: name, orgSlug: row!.org, registerPath: `/shared/${row!.org}/${row!.comp}/register` };
    });
  }

  /** WHO → (ENTRIES) → DETAILS → CONSENT, through the real stepper. A competition with one open division skips
   *  ENTRIES (its one entry is added for the player); with several, "Add an entry" on this division's card. */
  async function toConsent(page: Page, divisionName: string, who: { name: string; email: string }): Promise<void> {
    const next = () => page.getByRole("button", { name: /^next$/i }).click();
    await page.locator("#reg-who-name").fill(who.name);
    const email = page.locator("#reg-who-email");
    if (await email.isEditable()) await email.fill(who.email);
    await next();
    const add = page.getByRole("button", { name: uiEn["register.entries.add.individual"] });
    const roster = page.getByTestId("reg-roster-name").first();
    await expect(add.or(roster).first()).toBeVisible({ timeout: 20_000 });
    if (await add.isVisible()) {
      await page.locator("section, article, div").filter({ has: page.getByRole("heading", { name: divisionName }) }).last().getByRole("button", { name: uiEn["register.entries.add.individual"] }).click();
      await next();
    }
    await expect(roster).toBeVisible();
    if ((await roster.inputValue()) === "") await roster.fill(who.name);
    await next();
    await expect(page.getByTestId("reg-consent-grant")).toBeVisible({ timeout: 20_000 });
  }

  test("the consent step offers the link before signup, back to this registration; returning linked, it says who — the step kept", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const reg = await openOnlineRegistration(request);

    // A stranger: the card, its grant disclosure, and a start that comes back HERE.
    const anon = await cold(browser);
    const a = await anon.newPage();
    await a.setViewportSize({ width: 1280, height: 900 });
    await a.goto(reg.registerPath);
    await toConsent(a, reg.divisionName, { name: "Ada Okonkwo", email: `ada-${Date.now()}@example.test` });
    const card = a.getByTestId("register-lichess-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText(uiEn["register.lichess.title"]!);
    await expect(card).toContainText(uiEn["register.lichess.required"]!);
    await expect(card).toContainText(fill("register.lichess.lead.one", { divisions: reg.divisionName }));
    await expect(card).toContainText(uiEn["settings.account.lichess.consent.scopes"]!);
    await expect(card.getByTestId("register-lichess-linked")).toHaveCount(0);
    if (CONFIGURED) {
      const start = card.getByTestId("register-lichess-start");
      const href = new URL((await start.getAttribute("href"))!, "https://seazn.test");
      expect(href.origin, "same origin").toBe("https://seazn.test");
      expect(href.searchParams.get("org")).toBe(reg.orgSlug);
      expect(href.searchParams.get("next"), "the start comes back to this registration").toBe(reg.registerPath);
      await expect(card).toContainText(uiEn["register.lichess.returnHint"]!);
      await tappable(a, start, "Link my Lichess account");
    } else {
      await expect(card).toContainText(uiEn["settings.account.lichess.notConfigured"]!);
    }
    expect(await noSidewaysScroll(a)).toBe(3);
    await shoot(a, "register-lichess-unlinked");
    await anon.close();

    // A signed-in player with a link, as the callback leaves them: back on the register page with ?lichess=linked.
    // The draft and the step live in this tab's sessionStorage, so the stepper is where they left it.
    const player = await seedUser(`Bo Lindqvist ${Date.now() % 1e5}`);
    const lichessId = `e2e-reg-${Date.now() % 1e8}`;
    await seedLichessLink(player.userId, lichessId);
    const ctx = await cold(browser);
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 1280, height: 900 });
    await loginUi(p, player.email, reg.registerPath);
    await p.waitForURL((u) => u.pathname === reg.registerPath);
    await toConsent(p, reg.divisionName, { name: "Bo Lindqvist", email: player.email });
    await p.goto(`${reg.registerPath}?lichess=linked`);
    const back = p.getByTestId("register-lichess-card");
    await expect(p.getByTestId("reg-consent-grant"), "the step restored: CONSENT").toBeVisible({ timeout: 30_000 });
    await expect(back.getByTestId("register-lichess-linked")).toHaveText(fill("settings.account.lichess.linkedAs", { username: lichessId }));
    await expect(back.getByTestId("register-lichess-start")).toHaveCount(0);
    await expect(back.getByTestId("register-lichess-flash")).toHaveCount(0);
    expect(await noSidewaysScroll(p)).toBe(3);
    await shoot(p, "register-lichess-linked");
    await ctx.close();
  });
});
