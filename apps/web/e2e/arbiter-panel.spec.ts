/**
 * T15 — the arbiter panel, in a browser, against the real server.
 *
 * The organiser's half goes through the product: a public competition, a
 * boardgame division played online with the camera REQUIRED (set before the
 * round opens, as D9 allows), four linked players, a league stage, Generate,
 * Start, round 1 opened through the open-round route. The panel is reached the
 * way an organiser reaches it: from the division's fixtures tab.
 *
 * Three facts no API writes are seeded by SQL, and each says why:
 * - the players' Lichess links (match-room-kit.ts: linking is an OAuth trip to
 *   lichess.org; the stored token can never be opened);
 * - a game's ledger on each board, written the way T9/T10 leave it (the kit's
 *   seedGameSql, which needs the room's colours — here White is the home side,
 *   recorded on the row, the way T9 records it);
 * - two flags on board 2, in the notes their producers write — reconcile's
 *   out-of-band adoption and the sweep's job-5 camera report. Producing them
 *   for real needs a game moving at Lichess and a RealtimeKit meeting; the
 *   producer → loader read is proven in vitest (external-play-reconcile.test.ts
 *   I5, external-play-sweep.test.ts job 5). Here the browser half is proven:
 *   what the loader reads is what the arbiter sees.
 *
 * Video: the server runs with RealtimeKit unreachable, so the panel's join is
 * the route's real VIDEO_UNAVAILABLE — which is exactly the state the
 * canvas's outage card exists for. The receive-only meeting itself (video
 * only, never audio, both tiles) is the loader's own suite
 * (components/v2/__tests__/arbiter-camera.test.ts) against the fake SDK.
 *
 * Expected copy comes from the dictionary, expected boards and moves from the
 * rules (chess.js, FIDE move numbering) — never from the panel's code.
 */
import { test, expect, type Page } from "@playwright/test";
import { Chess } from "chess.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiJson, createStageAndGenerate, linkPersonToUserBySql, TAG, withDb } from "./helpers";
import { CLOCK, fill, longName, seedLichessLink, seedUser, uiEn } from "./match-room-kit";

test.describe.configure({ mode: "parallel" });

/** Board-vs-build captures (owner's canvas), only when asked for, never committed. */
const SHOTS = process.env.ARBITER_SHOTS_DIR;

/** What the panel writes to the audit log with a video override (D11) — the
 *  record as the T15 brief states it, typed here, not imported from the panel. */
const OVERRIDE_NOTE = "Video unavailable: let this board play without video from the arbiter panel.";

type Player = { name: string; personId: string; lichessId: string };
type Board = { fixtureId: string; home: Player; away: Player };
type Round = {
  orgId: string;
  divisionId: string;
  fixturesTab: string;
  arbiterPath: string;
  /** Round 1's two boards, in fixture order (seq_in_round). */
  boards: [Board, Board];
};

async function seedRound(request: import("@playwright/test").APIRequestContext, names: string[]): Promise<Round> {
  const people: Player[] = [];
  for (const name of names) {
    const { userId } = await seedUser(name);
    const person = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: name,
      consent: { public_name: true },
    });
    expect(person.status, `person ${name}: ${JSON.stringify(person.error)}`).toBeLessThan(300);
    await linkPersonToUserBySql(person.data!.id, userId);
    const lichessId = `e2e-arb-${randomBytes(5).toString("hex")}`;
    await seedLichessLink(userId, lichessId);
    people.push({ name, personId: person.data!.id, lichessId });
  }
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Arbiter ${TAG} ${randomUUID().slice(0, 4)}`,
    visibility: "public",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open Rapid",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: CLOCK },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const divisionId = div.data!.id;
  // The division settings' own write (division-settings.tsx saveCameraPolicy),
  // before any round opens — after that it may only be relaxed (D9).
  const cam = await apiJson(request, `/api/v1/divisions/${divisionId}`, "PATCH", { camera_policy: "required" });
  expect(cam.status, `camera policy: ${JSON.stringify(cam.error)}`).toBeLessThan(300);

  const ents = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    people.map((p, i) => ({ kind: "individual", display_name: p.name, seed: i + 1, members: [{ person_id: p.personId }] })),
  );
  expect(ents.status, `entrants: ${JSON.stringify(ents.error)}`).toBeLessThan(300);
  const byEntrant = new Map(ents.data!.map((e, i) => [e.id, people[i]!]));

  const { stageId } = await createStageAndGenerate(request, divisionId);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const opened = await apiJson(request, `/api/v1/stages/${stageId}/open-round`, "POST", { roundNo: 1 });
  expect(opened.status, `open-round: ${JSON.stringify(opened.error)}`).toBeLessThan(300);

  return withDb(async (sql) => {
    const rows = await sql<{ id: string; home: string; away: string }[]>`
      select id, home_entrant_id as home, away_entrant_id as away from fixtures
       where stage_id = ${stageId} and round_no = 1 order by seq_in_round`;
    expect(rows.length, "four entrants pair into two boards in round 1").toBe(2);
    const [slug] = await sql<{ org: string; comp: string; div: string; org_id: string }[]>`
      select o.slug as org, c.slug as comp, d.slug as div, o.id as org_id
        from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
       where d.id = ${divisionId}`;
    const base = `/o/${slug!.org}/c/${slug!.comp}/d/${slug!.div}`;
    const boards = rows.map((r) => ({ fixtureId: r.id, home: byEntrant.get(r.home)!, away: byEntrant.get(r.away)! }));
    return {
      orgId: slug!.org_id,
      divisionId,
      fixturesTab: `${base}?tab=fixtures`,
      arbiterPath: `${base}/arbiter`,
      boards: [boards[0]!, boards[1]!],
    };
  });
}

/** A game on a board's ledger, as T9 (create) and T10 (moves) leave it, White
 *  the home side. `hold` puts it on the organiser's desk (needs_organiser). */
async function gameOn(board: Board, opts: { moves: string[]; hold?: "mismatch" }): Promise<void> {
  const rules = new Chess();
  for (const uci of opts.moves) rules.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
  await withDb(async (sql) => {
    const res = await sql`
      update fixture_external_play
         set status = ${opts.hold ? "needs_organiser" : "live"},
             needs_reason = ${opts.hold ?? null},
             challenge_id = ${`e2e${randomBytes(5).toString("hex")}`},
             white_side = 'home',
             white_lichess_id = ${board.home.lichessId},
             black_lichess_id = ${board.away.lichessId},
             moves_uci = ${sql.json(opts.moves)},
             move_count = ${opts.moves.length},
             started_at = now() - interval '30 minutes',
             last_move_at = now(),
             white_ms = ${CLOCK.base * 1000},
             black_ms = ${CLOCK.base * 1000},
             clock_increment_s = ${CLOCK.increment},
             updated_at = now()
       where fixture_id = ${board.fixtureId}`;
    expect(res.count, `bridge row for ${board.fixtureId}`).toBe(1);
  });
}

// Ten legal plies (an Italian): the rules judge them in gameOn.
const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c2c3", "d7d6"];
/** FIDE: after N plies the move being played is floor(N/2) + 1. */
const moveBeingPlayed = (plies: number) => Math.floor(plies / 2) + 1;
/** FIDE: ply P belongs to move ceil(P/2). */
const moveOfPly = (ply: number) => Math.ceil(ply / 2);

/** Board 2's two flags, in their producers' note formats (see the header). */
async function flagBoard(r: Round, board: Board): Promise<{ off: { from: string; to: string } }> {
  const from = new Date(Date.now() - 20 * 60_000);
  from.setUTCMilliseconds(0);
  const to = new Date(from.getTime() + 95_000);
  const off = { from: from.toISOString().replace(".000Z", "Z"), to: to.toISOString().replace(".000Z", "Z") };
  await withDb(async (sql) => {
    await sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note) values
        (${board.fixtureId}, ${r.orgId}, 'out_of_band_play', null,
         ${`plies 2-5 (${LINE.slice(1, 5).join(" ")}) played at Lichess, not through Seazn; camera required`}),
        (${board.fixtureId}, ${r.orgId}, 'camera_lost', ${board.away.personId},
         ${`camera off 95 s of 1800 s in the match: ${off.from} to ${off.to} (its own off/on events agree); from 2 camera connections over 1 session; camera required`})`;
  });
  return { off };
}

async function noSidewaysScroll(page: Page, widths: number[]): Promise<number> {
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

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 768 ? 1024 : 700 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`), fullPage: true, caret: "initial" });
  }
}

const boardsNav = (page: Page) => page.getByRole("navigation", { name: uiEn["arbiter.boardsHeading"] });
const decision = (page: Page) => page.getByRole("region", { name: uiEn["arbiter.decide.heading"] });
const outage = (page: Page) => page.getByRole("region", { name: uiEn["arbiter.outage.title"] });
const status = (page: Page) => decision(page).getByRole("status");
const tiles = (page: Page) => page.locator("figure");

test.describe("arbiter panel", () => {
  test("desktop: from the run sheet to two boards — flags read, decisions sent, the outage let go and audited", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const r = await seedRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"]);
    const [b1, b2] = r.boards;
    await gameOn(b1, { moves: LINE });
    await gameOn(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    const { off } = await flagBoard(r, b2);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    await page.getByRole("link", { name: uiEn["arbiter.entry.link"] }).click();
    await expect(page).toHaveURL(new RegExp(`${r.arbiterPath}$`));
    await expect(page.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] })).toBeVisible();

    // The boards, in board order, each with its own state; board 1 on screen.
    const buttons = boardsNav(page).getByRole("button");
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toContainText(fill("arbiter.boardNo", { n: 1 }));
    await expect(buttons.nth(0)).toContainText(b1.home.name);
    await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(buttons.nth(1)).toContainText(`${fill("arbiter.boardNo", { n: 2 })} · ${uiEn["arbiter.state.onHold"]} · ${fill("arbiter.flagCount.other", { count: 2 })}`);
    await expect(page.getByText(fill("arbiter.status.live", { move: moveBeingPlayed(LINE.length) }))).toBeVisible();
    // Required and begun: the sweep's camera report is still to come.
    await expect(page.getByText(uiEn["arbiter.flag.pending.chip"])).toBeVisible();
    await expect(page.getByText(uiEn["arbiter.flags.none"])).toHaveCount(0);

    // Video required, RealtimeKit down: the join's real refusal paints both
    // tiles and the outage card.
    await expect(outage(page)).toBeVisible();
    await expect(tiles(page).getByText(uiEn["arbiter.tile.unavailable"], { exact: true })).toHaveCount(2);
    await expect(page.locator("audio")).toHaveCount(0);

    // Resync reaches the route; Lichess cannot be read here (the kit's tokens
    // never open, LICHESS_BASE_URL is unreachable), so it says it failed.
    const resync = page.waitForRequest((q) => q.method() === "POST" && q.url().endsWith(`/fixtures/${b1.fixtureId}/external-play/resync`));
    await decision(page).getByRole("button", { name: uiEn["arbiter.decide.resync"] }).click();
    await resync;
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.resyncFailed"]);
    // Board 1 has no flag: nothing to "go on" from.
    await expect(decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"] })).toHaveCount(0);

    // Board 2: its flags, read from the producers' notes.
    await buttons.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`${r.arbiterPath}\\?fixture=${b2.fixtureId}$`));
    await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(status(page)).toHaveText("");
    const flags = page.getByRole("region", { name: fill("arbiter.flags.headingBoard", { n: 2 }) });
    await expect(flags.getByText(uiEn["arbiter.flag.outOfBand.chip"])).toBeVisible();
    await expect(flags.getByText(fill("arbiter.flag.outOfBand.range.other", { count: 4, from: moveOfPly(2), to: moveOfPly(5) }))).toBeVisible();
    await expect(
      flags.getByText(fill("arbiter.flag.cameraOff.chip", { off: fill("arbiter.duration.minSec", { min: 1, sec: 35 }), window: fill("arbiter.duration.min", { min: 30 }) })),
    ).toBeVisible();
    await expect(flags.getByText(`${b2.away.name}: off`)).toBeVisible();
    await expect(flags.getByText(uiEn["arbiter.flag.cameraOff.agree"])).toBeVisible();
    await expect(page.getByText(uiEn["arbiter.status.onHold"], { exact: true })).toBeVisible();
    expect(off.from < off.to).toBe(true);

    // "Let the game go on" answers a flag and writes nothing.
    await decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"] }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.wentOn"]);
    const openFlags = await withDb((sql) => sql`select 1 from fixture_play_flags where fixture_id = ${b2.fixtureId} and closed_at is null`);
    expect(openFlags.length, "the flags stay on record").toBe(2);

    // "Settle the result now…" opens to the board's match page.
    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
    await settle.click();
    await expect(settle).toHaveAttribute("aria-expanded", "true");
    const fixtureNo = await withDb(async (sql) => {
      const [row] = await sql<{ n: number }[]>`select fixture_no as n from fixtures where id = ${b2.fixtureId}`;
      return row!.n;
    });
    await expect(decision(page).getByRole("link", { name: fill("arbiter.decide.settleLink", { n: 2 }) })).toHaveAttribute(
      "href",
      new RegExp(`/f/${fixtureNo}$`),
    );
    await shoot(page, "arbiter-board2");

    // Back to board 1: let it play without video. One audit record, the
    // organiser's, with the panel's note; the tiles follow the refresh.
    await page.setViewportSize({ width: 1280, height: 900 });
    await buttons.nth(0).click();
    await expect(outage(page)).toBeVisible();
    await shoot(page, "arbiter-outage");
    await page.setViewportSize({ width: 1280, height: 900 });
    await outage(page).getByRole("button", { name: uiEn["arbiter.outage.cta"] }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.overridden"]);
    await expect(outage(page)).toHaveCount(0);
    await expect(tiles(page).getByText(uiEn["arbiter.tile.overridden"], { exact: true })).toHaveCount(2);
    // Let go, there is no camera report to wait for — and no flag on board 1.
    await expect(page.getByText(uiEn["arbiter.flag.pending.chip"])).toHaveCount(0);
    await expect(page.getByText(uiEn["arbiter.flags.none"])).toBeVisible();
    const audit = await withDb(
      (sql) => sql<{ note: string; role: string | null }[]>`
        select a.note, m.role from online_chess_audit a
          left join org_members m on m.user_id = a.actor_user_id and m.org_id = a.org_id
         where a.fixture_id = ${b1.fixtureId} and a.kind = 'video_override'`,
    );
    expect(audit).toEqual([{ note: OVERRIDE_NOTE, role: expect.stringMatching(/^(owner|admin)$/) }]);

    // A link to one board opens on it.
    await page.goto(`${r.arbiterPath}?fixture=${b2.fixtureId}`);
    await expect(boardsNav(page).getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");
  });

  test("phone: the board picker switches boards; no sideways scroll at 320, 768 or 1280", async ({ page, request }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, [longName(), longName(), "Bo Lindqvist", "Chen Wei"]);
    const [b1, b2] = r.boards;
    await gameOn(b1, { moves: LINE });
    await gameOn(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await flagBoard(r, b2);

    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(r.arbiterPath);
    await expect(boardsNav(page)).toBeHidden();
    const picker = page.getByRole("combobox", { name: uiEn["arbiter.boardPicker"] });
    await expect(picker).toBeVisible();
    const box = await picker.boundingBox();
    expect(box!.height, "the picker is a 44px target").toBeGreaterThanOrEqual(44);
    await expect(picker.locator("option")).toHaveCount(2);
    // Board 1's White has a 43-character name: it truncates, its colour does not
    // (on a phone the colour is the only word saying which tile is White).
    const colour = tiles(page).nth(0).locator("figcaption").getByText(`· ${uiEn["arbiter.colour.white"]}`);
    await expect(colour).toBeVisible();
    const inside = await colour.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cap = el.closest("figcaption")!.getBoundingClientRect();
      return { width: r.width, right: r.right, capRight: cap.right };
    });
    expect(inside.width, "the colour is painted").toBeGreaterThan(0);
    expect(inside.right, "the colour is inside its caption, not clipped by the name").toBeLessThanOrEqual(inside.capRight + 0.5);
    await expect(page.getByRole("region", { name: uiEn["arbiter.flags.headingThis"] }).getByText(uiEn["arbiter.flag.pending.chip"])).toBeVisible();

    await picker.selectOption(b2.fixtureId);
    await expect(page).toHaveURL(new RegExp(`\\?fixture=${b2.fixtureId}$`));
    const flags = page.getByRole("region", { name: uiEn["arbiter.flags.headingThis"] });
    await expect(flags.getByText(uiEn["arbiter.flag.outOfBand.chip"])).toBeVisible();
    await expect(page.getByRole("region", { name: fill("arbiter.decide.headingBoard", { n: 2 }) })).toBeVisible();
    await shoot(page, "arbiter-phone-board2");
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
  });

  test("no panel for anyone else: signed out it is the sign-in, over the board it is not found", async ({ browser, page, request }) => {
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const cold = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: test.info().project.use.baseURL });
    try {
      const anon = await cold.newPage();
      await anon.goto(r.arbiterPath);
      await expect(anon.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] })).toHaveCount(0);
      expect(new URL(anon.url()).pathname).not.toBe(r.arbiterPath);
    } finally {
      await cold.close();
    }

    // An over-the-board chess division of the same organiser: no panel.
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Arbiter OTB ${TAG} ${randomUUID().slice(0, 4)}`,
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
      const [row] = await sql<{ org: string; comp: string; div: string }[]>`
        select o.slug as org, c.slug as comp, d.slug as div
          from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
         where d.id = ${div.data!.id}`;
      return `/o/${row!.org}/c/${row!.comp}/d/${row!.div}/arbiter`;
    });
    const res = await page.goto(path);
    expect(res!.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] })).toHaveCount(0);
  });
});
