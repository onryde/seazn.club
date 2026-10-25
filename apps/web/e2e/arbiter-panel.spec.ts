/**
 * T15 — the arbiter panel, in a browser, against the real server.
 *
 * The organiser's half goes through the product: a public competition, a
 * boardgame division played online with the camera REQUIRED (set before the
 * round opens, as D9 allows), four linked players, a league stage, Generate,
 * Start, round 1 opened through the open-round route. The panel is reached the
 * way an organiser reaches it: from the division's fixtures tab, by the one
 * entry card that tab keeps (phase 2 moved Open round and the queue into the
 * panel's round column, so the tab has no queue to settle from any more).
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
 * canvas's outage card exists for. (D16: a board has a camera meeting PER PLAYER, made when that player
 * checks in, and the arbiter only joins one that exists. No API here checks a player in, so the rows a
 * check-in leaves are seeded - `putRoom` - with vendor ids that are not real: the route finds the row, asks
 * the unreachable vendor for a participant, and is refused.) The receive-only meeting itself (video only,
 * never audio, one player's camera) is the loader's own suite (components/v2/__tests__/arbiter-camera.test.ts)
 * against the fake SDK; the White/Black switch's ORDER (leave, DELETE answered, then the next join) is
 * driven here through the real panel against a stubbed join route.
 *
 * Expected copy comes from the dictionary, expected boards and moves from the
 * rules (chess.js, FIDE move numbering) — never from the panel's code.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { Chess } from "chess.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOLDING_WORDS, type InviteWord } from "../src/lib/invite-status";
import { QUIET_POLL_MS } from "../src/components/v2/desk/band-poll";
import { DEADLINE_AFTER_MS } from "../src/server/external-play/window";
import {
  backdateOpenSql,
  budgetFor,
  cancelFlaggedSql,
  column,
  expectSeatWord,
  holdNoShowSql,
  inviteRowCount,
  openRoundSent,
  POLL_BUDGET_MS,
  recordedOpenNotices,
  recordOpenNotices,
  refreshNow,
  watchOpenRoundPosts,
} from "./arbiter-column-kit";
import { apiJson, createStageAndGenerate, linkPersonToUserBySql, loginUi, TAG, withDb } from "./helpers";
import { CLOCK, fill, longName, roundGameSql, seedLichessLink, seedOnlineRound, seedSeatInvite, seedUser, uiEn, type RoundBoard } from "./match-room-kit";

test.describe.configure({ mode: "parallel" });

/** Board-vs-build captures (owner's canvas), only when asked for, never committed. */
const SHOTS = process.env.ARBITER_SHOTS_DIR;

/** What the panel writes to the audit log with a video override (D11) — the
 *  record as the T15 brief states it, typed here, not imported from the panel. */
const OVERRIDE_NOTE = "Video unavailable: let this board play without video from the arbiter panel.";

type Player = { name: string; personId: string; lichessId: string; userId: string; email: string };
type Board = { fixtureId: string; home: Player; away: Player };
type Round = {
  orgId: string;
  divisionId: string;
  fixturesTab: string;
  arbiterPath: string;
  /** Round 1's two boards, in fixture order (seq_in_round). */
  boards: [Board, Board];
};

/** D16: one side's camera meeting, as a check-in leaves it. The meeting id is not a real vendor id (see the header). */
async function putRoom(fixtureId: string, orgId: string, side: "home" | "away"): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      select f.id, ${side}, ${orgId}, ${`e2e-mtg-${side}-${randomUUID().slice(0, 8)}`}, f.home_entrant_id, f.away_entrant_id
        from fixtures f where f.id = ${fixtureId}`;
    expect(res.count, `room ${side} for ${fixtureId}`).toBe(1);
  });
}

/** `stage`: the stage the generator builds (a league unless named — I-4 builds a real knockout, its next match wired
 *  by the generator itself). */
async function seedRound(
  request: import("@playwright/test").APIRequestContext,
  names: string[],
  stage?: { kind: string; name: string },
): Promise<Round> {
  const people: Player[] = [];
  for (const name of names) {
    const { userId, email } = await seedUser(name);
    const person = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: name,
      consent: { public_name: true },
    });
    expect(person.status, `person ${name}: ${JSON.stringify(person.error)}`).toBeLessThan(300);
    await linkPersonToUserBySql(person.data!.id, userId);
    const lichessId = `e2e-arb-${randomBytes(5).toString("hex")}`;
    await seedLichessLink(userId, lichessId);
    people.push({ name, personId: person.data!.id, lichessId, userId, email });
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

  const { stageId } = await createStageAndGenerate(request, divisionId, stage);
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
    // Both players of every board have checked in: a room each (the join then reaches the vendor, which is down).
    for (const b of boards) for (const side of ["home", "away"] as const) await putRoom(b.fixtureId, slug!.org_id, side);
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

/** M-5: every button's WHOLE label is painted at each width — nothing cut short (a truncated label scrolls inside its
 *  own box). Counted: buttons × widths. */
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
    // The way in is the entry card (the run sheet's flag chips lead there too, so the link is found INSIDE the card and by its exact
    // name). Board 2 is held and flagged, so the card's one line is the column title's own count: one board needs a decision.
    const entry = page.getByTestId("arbiter-entry");
    await expect(entry.getByTestId("arbiter-entry-status")).toHaveText(fill("arbiter.column.queue.one", { count: 1 }), { timeout: 30_000 });
    await expect(entry.getByTestId("arbiter-entry-status")).toHaveAttribute("data-kind", "attention");
    await entry.getByRole("link", { name: uiEn["arbiter.entry.link"]!, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${r.arbiterPath}$`));
    await expect(page.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] })).toBeVisible();

    // The boards, in board order, each with its own state; board 1 on screen.
    const buttons = boardsNav(page).getByRole("button");
    await expect(buttons).toHaveCount(2);
    // T17B fix 2 (D7): every board button shows the hand — read from the cascade, counted.
    const cursors = await buttons.evaluateAll((els) => els.map((el) => getComputedStyle(el).cursor));
    expect(cursors, "anti-vacuity + the hand on each board").toEqual(["pointer", "pointer"]);
    await expect(buttons.nth(0)).toContainText(fill("arbiter.boardNo", { n: 1 }));
    await expect(buttons.nth(0)).toContainText(b1.home.name);
    await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(buttons.nth(1)).toContainText(`${fill("arbiter.boardNo", { n: 2 })} · ${uiEn["arbiter.state.onHold"]} · ${fill("arbiter.flagCount.other", { count: 2 })}`);
    await expect(page.getByText(fill("arbiter.status.live", { move: moveBeingPlayed(LINE.length) }))).toBeVisible();
    // Required and begun: the sweep's camera report is still to come.
    await expect(page.getByText(uiEn["arbiter.flag.pending.chip"])).toBeVisible();
    await expect(page.getByText(uiEn["arbiter.flags.none"])).toHaveCount(0);

    // Video required, RealtimeKit down: the join's real refusal paints the pane
    // (D16: ONE player's, the other a press away) and the outage card.
    await expect(outage(page)).toBeVisible();
    await expect(tiles(page), "one pane, never two").toHaveCount(1);
    await expect(tiles(page).getByText(uiEn["arbiter.tile.unavailable"], { exact: true })).toHaveCount(1);
    await expect(page.locator("audio")).toHaveCount(0);

    // Resync reaches the route; the kit's tokens never open, so the route refuses
    // LICHESS_TOKEN_UNAVAILABLE before any request to Lichess — and the panel
    // says THAT, in the reader's words (T16: a retry does not fix it), not a
    // generic "try again".
    const resync = page.waitForResponse(
      (q) => q.request().method() === "POST" && q.url().endsWith(`/fixtures/${b1.fixtureId}/external-play/resync`),
    );
    await decision(page).getByRole("button", { name: uiEn["arbiter.decide.resync"] }).click();
    const refused = await resync;
    expect(refused.status()).toBe(503);
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code).toBe("LICHESS_TOKEN_UNAVAILABLE");
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.resyncTokenUnavailable"]!);
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

    // "Let the game go on" (T16, D10): exactly the flags on screen are closed —
    // kept on file under the organiser's name — and the game is untouched.
    await decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"] }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.wentOn"]);
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
    // Nothing is left to go on from.
    await expect(decision(page).getByRole("button", { name: uiEn["arbiter.decide.goOn"] })).toHaveCount(0);

    // "Settle the result now…" (T16): a board with a game on file is settled
    // HERE — four outcomes, by colour from the row (White is the home side).
    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
    await settle.click();
    await expect(settle).toHaveAttribute("aria-expanded", "true");
    const choices = page.getByTestId("arbiter-settle").getByRole("button");
    await expect(choices).toHaveText([
      fill("externalPlay.settle.wins", { name: b2.home.name }),
      fill("externalPlay.settle.wins", { name: b2.away.name }),
      uiEn["externalPlay.resolve.draw"]!,
      uiEn["externalPlay.resolve.noResult"]!,
    ]);
    await shoot(page, "arbiter-board2");
    await page.setViewportSize({ width: 1280, height: 900 });
    await choices.filter({ hasText: uiEn["externalPlay.resolve.draw"]! }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]);
    const settled = await withDb(async (sql) => {
      const [row] = await sql<{ status: string; outcome: { kind?: string } | null }[]>`
        select status, outcome from fixtures where id = ${b2.fixtureId}`;
      return row!;
    });
    expect(settled.status).toBe("decided");
    expect(settled.outcome).toMatchObject({ kind: "draw" });

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
    await expect(tiles(page).getByText(uiEn["arbiter.tile.overridden"], { exact: true })).toHaveCount(1);
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

  test("T17B fix 2 (D4): on a desktop the watch-only line sits UNDER the title, whole and inside the header, and the round line beside the title keeps its round number — at every desktop width, under a long stage name; at 320 and 768 it reads in the body; no sideways scroll at 320, 768 or 1280", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"]);
    await gameOn(r.boards[0]!, { moves: LINE });
    // A real stage name of a long-running league, so the round line takes its share of the header.
    const stage = "Championship Qualifiers Group A";
    await withDb((sql) => sql`update stages set name = ${stage} where id = (select stage_id from fixtures where id = ${r.boards[0]!.fixtureId})`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    await expect(page.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] })).toBeVisible();
    await expect(page.getByText(fill("arbiter.roundLine", { stage, round: 1 }))).toBeVisible();

    const line = uiEn["arbiter.watchOnly"]!;
    // lg (1024) is where the header line appears: its tightest width, then the common desktops.
    const DESKTOP = [1024, 1100, 1280, 1440];
    let checked = 0;
    for (const width of DESKTOP) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const inHeader = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) }).getByText(line, { exact: true });
      await expect(inHeader, `${width}px: the header carries the line`).toBeVisible();
      const m = await inHeader.evaluate((el) => {
        const header = el.closest("header")!;
        const hr = header.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(header).paddingRight);
        const r = el.getBoundingClientRect();
        const title = header.querySelector("h1")!.getBoundingClientRect();
        const round = [...header.querySelectorAll("span")].find((x) => /·/.test(x.textContent ?? ""))!;
        return {
          top: r.top,
          left: r.left,
          titleBottom: title.bottom,
          roundLeft: round.getBoundingClientRect().left,
          roundWhole: round.scrollWidth <= round.clientWidth,
          right: r.right,
          limit: hr.right - pad,
          headerFits: header.scrollWidth <= header.clientWidth,
          textFits: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1,
          inViewport: r.right <= document.documentElement.clientWidth,
          bottom: r.bottom,
          headerBottom: hr.bottom,
        };
      });
      expect(m.right, `${width}px: the line ends inside the header's padding`).toBeLessThanOrEqual(m.limit + 0.5);
      expect(m.headerFits, `${width}px: nothing in the header overflows it`).toBe(true);
      expect(m.textFits, `${width}px: every word of the line is painted`).toBe(true);
      expect(m.inViewport, `${width}px: on screen`).toBe(true);
      expect(m.bottom, `${width}px: inside the header, not hanging below it`).toBeLessThanOrEqual(m.headerBottom + 0.5);
      expect(m.top, `${width}px: under the title, never beside it`).toBeGreaterThanOrEqual(m.titleBottom - 0.5);
      expect(Math.abs(m.left - m.roundLeft), `${width}px: aligned with the round line it sits under`).toBeLessThanOrEqual(1);
      expect(m.roundWhole, `${width}px: the round line is whole — its round number painted`).toBe(true);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `arbiter-header-${width}.png`), clip: { x: 0, y: 0, width, height: 180 }, caret: "initial" });
      checked += 1;
    }
    expect(checked, "anti-vacuity: desktop widths").toBe(DESKTOP.length);
    // Below lg the line reads in the body, under the board picker — never the header.
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      await expect(page.locator("main").getByText(line, { exact: true }), `${width}px`).toBeVisible();
    }
    await shoot(page, "arbiter-header-long-stage");
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
  });

  // I-3 (controller ruling, fix round 2): "No result" is VOID — an abandon, no points, no absence — and in ANY knockout
  // the server refuses it (a knockout game needs a winner), so it is not offered there — on the panel, whether reached by the
  // board's own link or by its card's Review in the round column's queue — and the settle says why. The knockout board here FEEDS a next match: the hiding is the
  // knockout's, not a final's. The pairs: a league board offers it, and settling it reads back as No result; both
  // players absent, the double walkover is offered and written. Here the knockout is a league stage switched by SQL;
  // the knockout's own positive pair — a winner clicked on the panel, and the next match seating that winner — is the
  // I-4 test below, on a REAL knockout the generator wired.
  test("I-3: a league board settles No result as VOID; in a Swiss and on a knockout line No result is hidden and the settle says why, panel and the column's Review; both players absent, a knockout line that feeds a next match offers W2b's double walkover by name and writes it, a final hides it; no sideways scroll at 320, 768 or 1280", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const r = await seedRound(request, ["Ines Duarte", "Tomasz Wrona", longName(), "Chen Wei"]);
    const [b1, b2] = r.boards;
    await gameOn(b1, { moves: LINE });
    await gameOn(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await flagBoard(r, b2);

    // A league board: the four outcomes, No result among them.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${r.arbiterPath}?fixture=${b1.fixtureId}`);
    const settle = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
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
    await shoot(page, "arbiter-league-settle");
    await page.setViewportSize({ width: 1280, height: 900 });
    await choices.filter({ hasText: uiEn["externalPlay.resolve.noResult"]! }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]);
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
    await page.goto(`${r.arbiterPath}?fixture=${b1.fixtureId}`);
    await expect(page.getByText(uiEn["arbiter.status.noResult"]!, { exact: true })).toBeVisible();
    await shoot(page, "arbiter-league-no-result");

    const winners = [fill("externalPlay.settle.wins", { name: b2.home.name }), fill("externalPlay.settle.wins", { name: b2.away.name })];
    const settleOn = async (fixtureId: string) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${r.arbiterPath}?fixture=${fixtureId}`);
      const open = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      return page.getByTestId("arbiter-settle").getByRole("button");
    };
    // The queue lives in the round column now (the Fixtures tab has none): the held board's card says "Review board N", and Review puts
    // that board on screen with its decision area - the same area `settleOn` reaches by the link to the board. The page opens on board 1,
    // so the board on screen changing to board 2 is the Review's own doing.
    const columnSettle = async (fixtureId: string) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(r.arbiterPath);
      const card = page.locator(`[data-testid="arbiter-column-card"][data-kind="held"][data-fixture-id="${fixtureId}"]`);
      await expect(card.getByTestId("arbiter-column-review")).toHaveText(fill("arbiter.column.review", { board: 2 }));
      await expect(boardsNav(page).getByRole("button").nth(0)).toHaveAttribute("aria-pressed", "true");
      await card.getByTestId("arbiter-column-review").click();
      await expect(boardsNav(page).getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");
      await expect(page).toHaveURL(new RegExp(`\\?fixture=${fixtureId}$`));
      const open = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      return page.getByTestId("arbiter-settle");
    };

    // A Swiss (fix round 3): the held board's stage a Swiss — a void would hold the next round up, so No result is
    // hidden there too, and the settle says why, reached from the column's card and from the board's own link.
    await withDb((sql) => sql`update stages set kind = 'swiss' where id = (select stage_id from fixtures where id = ${b2.fixtureId})`);
    const swissFromCard = await columnSettle(b2.fixtureId);
    await expect(swissFromCard.getByRole("button")).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.swissNeedsResult"]!);
    const swissChoices = await settleOn(b2.fixtureId);
    await expect(swissChoices).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.swissNeedsResult"]!);
    await shoot(page, "arbiter-swiss-settle");
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the Swiss panel").toBe(3);

    // A knockout line that feeds a next match.
    const feeds = await withDb(async (sql) => {
      const [f] = await sql<{ stage_id: string; division_id: string; org_id: string }[]>`
        select stage_id, division_id, org_id from fixtures where id = ${b2.fixtureId}`;
      await sql`update stages set kind = 'knockout' where id = ${f!.stage_id}`;
      const [next] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
        values (${f!.stage_id}, ${f!.division_id}, ${f!.org_id}, 2, 1, ${`nx-${randomUUID().slice(0, 6)}`}, 'scheduled')
        returning id`;
      await sql`update fixtures set winner_to_fixture = ${next!.id} where id = ${b2.fixtureId}`;
      return sql<{ w: string | null }[]>`select winner_to_fixture as w from fixtures where id = ${b2.fixtureId}`;
    });
    expect(feeds[0]!.w, "premise: the line feeds a next match — not a final").not.toBeNull();

    // The column's queue: the held card's Review, then its settle, opened.
    const fromCard = await columnSettle(b2.fixtureId);
    await expect(fromCard.getByRole("button")).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);
    await shoot(page, "column-knockout-settle");
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the column's Review").toBe(3);

    // The arbiter panel: the same three, the same sentence.
    const choices2 = await settleOn(b2.fixtureId);
    await expect(choices2).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);
    await shoot(page, "arbiter-knockout-settle");
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the panel").toBe(3);

    // Both players absent (fix round 3): W2b's double walkover, wherever W2b takes one. On a FINAL W2b refuses it (D19),
    // so it is hidden there — the knockout sentence stands in its place.
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
    const dwFromCard = await columnSettle(b2.fixtureId);
    await expect(dwFromCard.getByRole("button")).toHaveText([
      ...winners,
      uiEn["externalPlay.resolve.draw"]!,
      uiEn["externalPlay.resolve.doubleWalkover"]!,
    ]);
    const choices3 = await settleOn(b2.fixtureId);
    await expect(choices3).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!, uiEn["externalPlay.resolve.doubleWalkover"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveCount(0);
    await shoot(page, "arbiter-knockout-double-walkover");
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the panel offering the double walkover").toBe(3);
    // Every label is shown whole (M-5, fix round 4): the winners — one a 43-character name — each on a row of their
    // own, wrapping, and the double walkover on its own row too; at every width, counted.
    expect(await labelsFit(page, choices3, [320, 768, 1280]), "every settle button, at every width").toBe(4 * 3);
    // Its label is never cut short (a row of its own): the button shows all of it.
    await page.setViewportSize({ width: 1280, height: 900 });
    const dw = choices3.filter({ hasText: uiEn["externalPlay.resolve.doubleWalkover"]! });
    expect(await dw.evaluate((el) => el.scrollWidth <= el.clientWidth), "the double walkover label fits").toBe(true);
    await dw.click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]);
    const walkedOver = await withDb(async (sql) => {
      const [f] = await sql<{ status: string; kind: string | null }[]>`select status, outcome->>'kind' as kind from fixtures where id = ${b2.fixtureId}`;
      const ledger = await sql<{ type: string; payload: unknown }[]>`select type, payload from score_events where fixture_id = ${b2.fixtureId} order by seq`;
      return { fixture: f!, ledger };
    });
    expect(walkedOver.fixture, "W2b's double walkover").toEqual({ status: "forfeited", kind: "double_walkover" });
    expect(walkedOver.ledger).toEqual([{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }]);
  });

  // I-4 (fix round 4): in a knockout the winner is the organiser's settle (No result is refused there), so its positive
  // pair runs through the real panel — the click, the route, resolveExternalPlay, and W2b's seat resolver — on a REAL
  // knockout: the stage created as one through the API, its next match and that match's seat wired by the generator.
  test("I-4: on a real knockout, a winner clicked on the panel settles the board for that player, and the next match seats them", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, ["Amara Osei", "Bo Lindqvist", longName(), "Chen Wei"], { kind: "knockout", name: "Knockout" });
    const [, b2] = r.boards;
    await gameOn(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    const read = () =>
      withDb(async (sql) => {
        const [f] = await sql<{ status: string; home: string; away: string; outcome: Record<string, unknown> | null; next: string | null; slot: number | null }[]>`
          select status, home_entrant_id as home, away_entrant_id as away, outcome, winner_to_fixture as next, winner_to_slot as slot
            from fixtures where id = ${b2.fixtureId}`;
        const [n] = f!.next === null ? [] : await sql<{ home: string | null; away: string | null }[]>`
          select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${f!.next}`;
        return { board: f!, next: n ?? null };
      });
    const before = await read();
    expect(before.board.next, "premise: the generator wired this semi-final to a next match").not.toBeNull();
    expect([1, 2], "premise: and to one of its two seats").toContain(before.board.slot);
    // Slot 1 is the home seat, 2 the away (the schema's feed edge, as fed-seats.ts reads it).
    const seat = before.board.slot === 1 ? "home" : "away";
    expect(before.next![seat], "premise: that seat waits for this board's winner").toBeNull();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${r.arbiterPath}?fixture=${b2.fixtureId}`);
    const open = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    const choices = page.getByTestId("arbiter-settle").getByRole("button");
    // White is the home player (gameOn): the panel names White first. No result is not offered in a knockout.
    const blackWins = fill("externalPlay.settle.wins", { name: b2.away.name });
    await expect(choices).toHaveText([fill("externalPlay.settle.wins", { name: b2.home.name }), blackWins, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-guidance")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);
    // Black — the away player (White, at home, carries a 43-character name) — wins: the side the panel sends is the
    // one it names.
    await choices.filter({ hasText: blackWins }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]);

    const after = await read();
    expect(after.board.status, "decided").toBe("decided");
    expect(after.board.outcome, "for the player the organiser named").toMatchObject({ kind: "win", winner: before.board.away, loser: before.board.home });
    expect(after.next![seat], "the next match seats the winner").toBe(before.board.away);
    expect(after.next![seat === "home" ? "away" : "home"], "and only that seat: the other semi-final is still to play").toBe(before.next![seat === "home" ? "away" : "home"]);
    await shoot(page, "arbiter-knockout-winner-settled");
  });

  test("I2: the panel hands each watch back — on a board switch, and when the tab goes away", async ({ page, request }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1, b2] = r.boards;
    await gameOn(b1, { moves: LINE });
    await gameOn(b2, { moves: LINE.slice(0, 4) });
    // The server's RealtimeKit is unreachable here, so the JOIN is answered
    // in the browser: a minted watch per open, as the route answers it. What
    // is proven is the panel's half — that it hands back the id it was given.
    // The route's own removal is the vitest suites' (route + usecase + sweep).
    const minted: string[] = [];
    const handedBack: string[] = [];
    await page.route(/\/external-play\/arbiter$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const fixtureId = route.request().url().split("/fixtures/")[1]!.split("/")[0]!;
      const { side } = route.request().postDataJSON() as { side: "home" | "away" };
      const participantId = `e2e-${fixtureId.slice(0, 8)}-${minted.length + 1}`; // boardOf() reads the middle
      minted.push(participantId);
      await route.fulfill({ json: { ok: true, data: { authToken: "e2e-not-a-token", participantId, side, players: [] } } });
    });
    // A hand-back is counted where the browser SENDS it — its request event — and page.route only answers it. The
    // tab-away DELETE is a keepalive request issued while the page unloads: CI's trace (run 38524988078, both
    // attempts) shows it sent with the right id, after the join had answered, yet never handed to this route, so a
    // count kept in the route handler read a release the panel had made as missing. The request event is the
    // signal the trace itself records. One that misses the route reaches the server, where the id is unknown.
    const handBack = /\/external-play\/arbiter\/[^/]+$/;
    page.context().on("request", (req) => {
      if (req.method() === "DELETE" && handBack.test(new URL(req.url()).pathname)) {
        handedBack.push(decodeURIComponent(req.url().split("/").pop()!));
      }
    });
    await page.route(handBack, async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      await route.fulfill({ json: { ok: true, data: { removed: true } } });
    });

    // The invariant at every step: every watch minted is handed back exactly
    // once, except the one on screen. (A dev server's StrictMode mounts the
    // panel twice, so board 1 may be opened, closed and opened again — the
    // first watch must then come back too.)
    const boardOf = (pid: string) => pid.split("-")[1];
    const settled = async (onScreen: Board | null, message: string) => {
      await expect
        .poll(
          () => {
            const live = minted.filter((pid) => !handedBack.includes(pid));
            return {
              live: live.map(boardOf),
              repeats: handedBack.length - new Set(handedBack).size,
              unknown: handedBack.filter((pid) => !minted.includes(pid)).length,
            };
          },
          { message },
        )
        .toEqual({ live: onScreen === null ? [] : [onScreen.fixtureId.slice(0, 8)], repeats: 0, unknown: 0 });
    };

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    await settled(b1, "board 1 on screen: its watch is the only one out");
    const onBoard1 = minted.length;
    expect(onBoard1, "anti-vacuity: board 1 minted").toBeGreaterThanOrEqual(1);

    await boardsNav(page).getByRole("button").nth(1).click();
    await expect(boardsNav(page).getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");
    await settled(b2, "board 2 on screen: board 1's watch handed back, a FRESH one for board 2");
    expect(minted.length, "the switch minted a new watch").toBeGreaterThan(onBoard1);

    // The tab going away: pagehide hands back the watch on screen.
    await page.goto(r.fixturesTab);
    await settled(null, "the tab left: nothing out");
    expect(handedBack.length, "anti-vacuity: every watch came back").toBe(minted.length);
  });

  test("I3: a link to a board that is not here says so — never another board — and offers the current round", async ({ page, request }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    // Another division of the same organiser: its board is not THIS panel's.
    const elsewhere = await seedRound(request, ["Eli Novak", "Fay Osei", "Gus Ito", "Hana Berg"]);
    await page.setViewportSize({ width: 1280, height: 900 });
    let checked = 0;
    for (const asked of [randomUUID(), elsewhere.boards[0].fixtureId, "not-a-board"]) {
      const res = await page.goto(`${r.arbiterPath}?fixture=${encodeURIComponent(asked)}`);
      expect(res!.status(), asked).toBe(200);
      await expect(page.getByText(uiEn["arbiter.requested.unavailable"], { exact: true })).toBeVisible();
      await expect(tiles(page), "no board opened in its place").toHaveCount(0);
      await expect(boardsNav(page)).toHaveCount(0);
      checked++;
    }
    expect(checked).toBe(3);
    await shoot(page, "arbiter-requested-unavailable");
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
    // The way back: the current round, opened on its first board.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("link", { name: uiEn["arbiter.requested.current"] }).click();
    await expect(page).toHaveURL(new RegExp(`${r.arbiterPath}$`));
    await expect(boardsNav(page).getByRole("button").nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(tiles(page)).toHaveCount(1);
  });

  test("N1: a pinned board of an earlier round says a newer round is open and offers it; the current round's board says nothing", async ({ page, request }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1] = r.boards;
    // Round 2, opened a minute after round 1 (open-round's stamp, by SQL):
    // its boards are the stage's own round-2 pairings.
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
    const older = page.getByText(uiEn["arbiter.olderRound"], { exact: true });
    const toCurrent = page.getByRole("link", { name: uiEn["arbiter.requested.current"] });
    await page.setViewportSize({ width: 1280, height: 900 });
    // The current round's board, pinned: its round, nothing to say.
    await page.goto(`${r.arbiterPath}?fixture=${next[0]!.id}`);
    await expect(boardsNav(page).getByRole("button")).toHaveCount(next.length);
    await expect(boardsNav(page).getByRole("button").nth(0)).toHaveAttribute("aria-pressed", "true");
    // The panel's own header (the site's gantry is a <header> too).
    const panelHeader = page.locator("header", { has: page.getByRole("heading", { level: 1, name: uiEn["arbiter.title"] }) });
    const roundIs = (n: number) => expect(panelHeader).toContainText(fill("arbiter.roundLine", { stage: "", round: n }).trim());
    await roundIs(2);
    await expect(older).toHaveCount(0);
    await expect(toCurrent).toHaveCount(0);
    // Round 1's board, pinned: still on screen, and the way to round 2.
    await page.goto(`${r.arbiterPath}?fixture=${b1.fixtureId}`);
    await roundIs(1);
    await expect(boardsNav(page).getByRole("button")).toHaveCount(2);
    await expect(boardsNav(page).getByRole("button").nth(0)).toContainText(b1.home.name);
    await expect(boardsNav(page).getByRole("button").nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(older).toBeVisible();
    await expect(tiles(page), "the pinned board's pane stays").toHaveCount(1);
    await shoot(page, "arbiter-older-round");
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
    await page.setViewportSize({ width: 1280, height: 900 });
    await toCurrent.click();
    await expect(page).toHaveURL(new RegExp(`${r.arbiterPath}$`));
    await roundIs(2);
    await expect(boardsNav(page).getByRole("button")).toHaveCount(next.length);
    await expect(boardsNav(page).getByRole("button").nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(older).toHaveCount(0);
  });

  test("N3: a board the organiser plays on is left out, and one line says why; an organiser who plays nowhere sees both and no line", async ({ browser, page, request }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1] = r.boards;
    const line = uiEn["arbiter.ownHidden.one"]!;
    // The organiser who plays: board 1's home player, made an admin of the
    // club, signed in on their own browser (the shared Pro user stays as is).
    await withDb((sql) => sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${b1.home.userId}, 'admin')`);
    const own = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: test.info().project.use.baseURL });
    try {
      const p = await own.newPage();
      await loginUi(p, b1.home.email);
      await p.setViewportSize({ width: 1280, height: 900 });
      await p.goto(r.arbiterPath);
      const buttons = boardsNav(p).getByRole("button");
      await expect(buttons).toHaveCount(1);
      await expect(buttons.nth(0)).toContainText(fill("arbiter.boardNo", { n: 2 }));
      await expect(p.getByText(line, { exact: true })).toBeVisible();
      await expect(p.getByText(uiEn["arbiter.ownRound"]!)).toHaveCount(0);
      await shoot(p, "arbiter-own-hidden");
      expect(await noSidewaysScroll(p, [320, 768, 1280])).toBe(3);
    } finally {
      await own.close();
    }
    // The positive pair: the club's owner plays nowhere — both boards, no line.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    await expect(boardsNav(page).getByRole("button")).toHaveCount(2);
    await expect(page.getByText(line, { exact: true })).toHaveCount(0);
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

  // T17B fix 2, D9 (measured live, JTcfKXow): a player connected from more than one place at the same time in the
  // match. The flag is the sweep's job-5 note, seeded in the producer's format (see the header: producing it for real
  // needs a RealtimeKit meeting; the producer → loader read is external-play-sweep.test.ts's D9 describe). Here: the
  // card the organiser reads after the game, at every width, and "Mark as reviewed" closing it on the record.
  test("T17B fix 2 (D9): a finished board's 'more than one device at once' card — the count, when, and why; no sideways scroll at 320, 768 or 1280; Mark as reviewed closes it under the organiser's name", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const r = await seedRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"]);
    const board = r.boards[0]!;
    await gameOn(board, { moves: LINE });
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

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${r.arbiterPath}?fixture=${board.fixtureId}`);
    const flags = page.getByRole("region", { name: fill("arbiter.flags.headingBoard", { n: 1 }) });
    await expect(flags.getByText(fill("arbiter.flag.devices.chip", { count: 2 }), { exact: true })).toBeVisible();
    // The times as the viewer's own clock says them (h23, like every flag card) — formatted by the browser, not the panel.
    const [hFrom, hTo] = await page.evaluate(
      ([a, b]) => {
        const f = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
        return [f.format(new Date(a!)), f.format(new Date(b!))];
      },
      [from.toISOString(), to.toISOString()],
    );
    const spans = fill("arbiter.flag.cameraOff.span", { from: hFrom!, to: hTo! });
    await expect(flags.getByText(fill("arbiter.flag.devices.spans", { name: board.home.name, count: 2, spans }))).toBeVisible();
    await expect(flags.getByText(uiEn["arbiter.flag.devices.why"]!)).toBeVisible();
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
    await shoot(page, "arbiter-d9-devices");

    await page.setViewportSize({ width: 1280, height: 900 });
    const review = decision(page).getByRole("button", { name: uiEn["externalPlay.queue.markReviewed"] });
    await expect(review).toBeVisible();
    await review.click();
    await expect(status(page)).toHaveText(uiEn["externalPlay.queue.reviewed"]!);
    const kept = await withDb(
      (sql) => sql<{ kind: string; closed: boolean; role: string | null }[]>`
        select f.kind, f.closed_at is not null as closed, m.role from fixture_play_flags f
          left join org_members m on m.user_id = f.resolved_by and m.org_id = f.org_id
         where f.fixture_id = ${board.fixtureId}`,
    );
    expect(kept, "closed and kept on record, resolved by an organiser").toEqual([
      { kind: "multiple_devices", closed: true, role: expect.stringMatching(/^(owner|admin)$/) },
    ]);
    await expect(flags.getByText(fill("arbiter.flag.devices.chip", { count: 2 }), { exact: true })).toHaveCount(0);
  });
  // ── D16 (§5.6.4, shape (b)): one player's camera at a time, and the switch between them ───────────────────────────
  //
  // The server's RealtimeKit is unreachable, so a SUCCESSFUL join cannot be had: the join route is answered in the browser
  // (as I2 does), with a participant the real SDK then fails to connect to ("e2e-not-a-token"). What is proven is the
  // panel's half through its real producer and consumer: which side it asks for, the order of a switch (the participant it
  // was given is deleted and the DELETE ANSWERED before the next join is sent), the states it paints, and the control a
  // person touches. The loader's own suite (arbiter-camera.test.ts) owns the camera.
  const SWITCH_WIDTHS = [1280, 768, 320] as const;
  const group = (page: Page) => page.getByRole("group", { name: uiEn["arbiter.switch.group"] });
  const switchButton = (page: Page, colour: "white" | "black") =>
    group(page).getByRole("button", { name: new RegExp(`^${uiEn[colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"]} · `) });
  const liveRegion = (page: Page) => page.locator('p[role="status"].sr-only');

  type Deferred = { promise: Promise<void>; release(): void };
  const deferred = (): Deferred => {
    let release!: () => void;
    const promise = new Promise<void>((res) => (release = res));
    return { promise, release };
  };
  type JoinAnswer = "mint" | { status: number; code: string };

  /** The join route and the hand-back route, answered in the browser, in the order the browser sends. `log` is what the
   *  server side saw: a POST with its side, the participant it minted, a DELETE and (after the test's gate) its answer. */
  async function wire(
    page: Page,
    h: { post(side: "home" | "away", n: number): Promise<JoinAnswer> | JoinAnswer; del?(id: string): Promise<void> },
  ): Promise<string[]> {
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
      await h.del?.(id);
      log.push(`DELETE answered ${id}`);
      await route.fulfill({ json: { ok: true, data: { removed: true } } });
    });
    return log;
  }

  for (const width of SWITCH_WIDTHS) {
    test(`the switch at ${width}: leave, DELETE answered, then the next join; a refusal on the tile asked for; keyboard; a 44px target hit-tested`, async ({
      page,
      request,
    }) => {
      test.setTimeout(150_000);
      const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
      const [b1] = r.boards;
      await gameOn(b1, { moves: LINE });
      const delGate = deferred();
      const post2Gate = deferred();
      const log = await wire(page, {
        post: async (side, n) => {
          if (n === 2) {
            await post2Gate.promise;
            return { status: 409, code: "VIDEO_MEETING_NOT_STARTED" };
          }
          if (n >= 4) return { status: 503, code: "VIDEO_UNAVAILABLE" };
          return "mint";
        },
        del: async (id) => {
          if (id === "e2e-home-1") await delGate.promise;
        },
      });
      const white = () => switchButton(page, "white");
      const black = () => switchButton(page, "black");

      await page.setViewportSize({ width, height: width === 1280 ? 900 : 700 });
      await page.goto(r.arbiterPath);
      // The real loader's `sides` through the real panel: White plays the home side, whose room is open, so THAT is asked for.
      await expect.poll(() => log.slice(), { message: "the first join asks for White's side" }).toEqual(["POST home", "minted e2e-home-1"]);
      await expect(white()).toHaveAttribute("aria-pressed", "true");
      await expect(black()).toHaveAttribute("aria-pressed", "false");
      await expect(white()).toContainText(b1.home.name);
      await expect(black()).toContainText(b1.away.name);
      await expect(tiles(page).getByText(uiEn["arbiter.tile.error"], { exact: true }), "the minted token cannot connect: the pane says so").toHaveCount(1);
      await expect(liveRegion(page)).toHaveText(uiEn["arbiter.tile.error"]!);

      // The target a person touches: at least 44 px tall and hit-tested - the centre of each button is the button.
      let hit = 0;
      for (const colour of ["white", "black"] as const) {
        const el = switchButton(page, colour);
        // A person scrolls to a control before touching it; elementFromPoint answers null for a point below the fold.
        await el.scrollIntoViewIfNeeded();
        const box = (await el.boundingBox())!;
        expect(box.height, `${colour}: tall enough at ${width}`).toBeGreaterThanOrEqual(44);
        expect(box.width, `${colour}: wide enough at ${width}`).toBeGreaterThanOrEqual(44);
        const probe = await el.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { owns: top !== null && node.contains(top), covered: top === null ? "nothing" : top.outerHTML.slice(0, 160), at: [r.left + r.width / 2, r.top + r.height / 2, window.innerWidth, window.innerHeight] };
        });
        expect(probe.owns, `${colour}: elementFromPoint at its centre is the button (found ${probe.covered} at ${probe.at.join(",")})`).toBe(true);
        hit += 1;
      }
      expect(hit).toBe(2);

      // 1. Black: the leave and the DELETE go out FIRST, and the next join waits for the DELETE's ANSWER.
      await black().click();
      await expect.poll(() => log.includes("DELETE e2e-home-1")).toBe(true);
      await page.waitForTimeout(700);
      expect(log, "the DELETE is unanswered: no second join yet").not.toContain("POST away");
      expect(log).not.toContain("DELETE answered e2e-home-1");
      delGate.release();
      await expect.poll(() => log.includes("POST away")).toBe(true);
      expect(log.indexOf("DELETE answered e2e-home-1"), "answered BEFORE the next join was sent").toBeGreaterThan(-1);
      expect(log.indexOf("DELETE answered e2e-home-1")).toBeLessThan(log.indexOf("POST away"));

      // 2. The join is in flight: the switch says so, to the eye and to assistive technology.
      await expect(black()).toHaveAttribute("aria-pressed", "true");
      await expect(black()).toHaveAttribute("aria-busy", "true");
      await expect(liveRegion(page)).toHaveText(fill("arbiter.switch.switching", { colour: uiEn["arbiter.colour.black"]! }));
      await expect(tiles(page).getByText(fill("arbiter.switch.switching", { colour: uiEn["arbiter.colour.black"]! }), { exact: true })).toBeVisible();
      if (width === 1280) await shoot(page, "arbiter-switch-in-flight");
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 700 });

      // 3. Refused (the player has not checked in): the refusal is on the tile asked for, and the way back is one press away.
      post2Gate.release();
      const notStarted = fill("arbiter.tile.notStarted", { name: b1.away.name });
      await expect(tiles(page).getByText(notStarted, { exact: true })).toBeVisible();
      await expect(liveRegion(page)).toHaveText(notStarted);
      await expect(black()).not.toHaveAttribute("aria-busy", "true");
      await expect(white(), "the other player is one press away").not.toHaveAttribute("aria-disabled", "true");
      if (width === 1280) await shoot(page, "arbiter-switch-refused-not-started");
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 700 });

      // 4. The way back, from the KEYBOARD (Enter): nothing was minted by the refused join, so there is nothing to delete.
      await white().focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => log.filter((e) => e.startsWith("POST")).length).toBe(3);
      await expect(white()).toHaveAttribute("aria-pressed", "true");
      await expect(tiles(page).getByText(uiEn["arbiter.tile.error"], { exact: true })).toHaveCount(1);

      // 5. And forth, with the SPACE bar: the participant minted by the third join is deleted before the fourth is sent.
      await black().focus();
      await page.keyboard.press("Space");
      await expect.poll(() => log.filter((e) => e.startsWith("POST")).length).toBe(4);
      await expect(tiles(page).getByText(uiEn["arbiter.tile.unavailable"], { exact: true }), "outage: the join's refusal, on the tile asked for").toHaveCount(1);
      await expect(outage(page)).toBeVisible();
      if (width === 1280) await shoot(page, "arbiter-switch-refused-outage");
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 700 });

      expect(log, "the whole conversation, in order").toEqual([
        "POST home", "minted e2e-home-1",
        "DELETE e2e-home-1", "DELETE answered e2e-home-1",
        "POST away",
        "POST home", "minted e2e-home-3",
        "DELETE e2e-home-3", "DELETE answered e2e-home-3",
        "POST away",
      ]);
      // The invariant, read off the log rather than typed: after every join the participant it minted is deleted, and the
      // delete answered, before the next join is sent.
      let pairs = 0;
      let minted: string | null = null;
      for (const e of log) {
        if (e.startsWith("minted ")) minted = e.slice("minted ".length);
        if (e.startsWith("POST ") && minted !== null) {
          expect(log.indexOf(`DELETE answered ${minted}`), `${minted} was deleted before ${e}`).toBeGreaterThan(-1);
          expect(log.indexOf(`DELETE answered ${minted}`)).toBeLessThan(log.indexOf(e, log.indexOf(`minted ${minted}`)));
          pairs += 1;
          minted = null;
        }
      }
      expect(pairs, "anti-vacuity: two mints each followed by a join").toBe(2);
      expect(await noSidewaysScroll(page, [width])).toBe(1);
    });
  }

  test("a side that has not checked in: the switch says so and refuses the press, no join is made for it, and the join opens when the player arrives", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1, b2] = r.boards;
    await gameOn(b1, { moves: LINE });
    await gameOn(b2, { moves: LINE.slice(0, 4) });
    // Board 1: only White's player (home) has checked in. Board 2: nobody has.
    await withDb(async (sql) => {
      await sql`delete from fixture_video_meetings where fixture_id = ${b1.fixtureId} and side = 'away'`;
      await sql`delete from fixture_video_meetings where fixture_id = ${b2.fixtureId}`;
    });
    const log = await wire(page, { post: () => "mint" });
    const white = () => switchButton(page, "white");
    const black = () => switchButton(page, "black");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    await expect.poll(() => log.slice()).toEqual(["POST home", "minted e2e-home-1"]);

    // The empty side: aria-disabled, its reason in words (and linked), and a press does nothing.
    await expect(black()).toHaveAttribute("aria-disabled", "true");
    await expect(black()).toContainText(uiEn["arbiter.switch.none"]!);
    const reasonId = await black().getAttribute("aria-describedby");
    expect(reasonId, "described by its reason").toBeTruthy();
    await expect(page.locator(`[id="${reasonId}"]`)).toHaveText(uiEn["arbiter.switch.none"]!);
    await expect(white()).not.toHaveAttribute("aria-disabled", "true");
    // Playwright treats aria-disabled as "not enabled" and waits for ever; a person can press it, and the press must do nothing.
    await black().click({ force: true });
    await page.waitForTimeout(700);
    expect(log, "a press on a side with no room joins nothing and leaves nothing").toEqual(["POST home", "minted e2e-home-1"]);
    await expect(white()).toHaveAttribute("aria-pressed", "true");
    await shoot(page, "arbiter-switch-other-side-not-arrived");
    await page.setViewportSize({ width: 1280, height: 900 });

    // Board 2: neither player has arrived. The pane says whose room it is; BOTH buttons refuse; the arbiter makes no room.
    await boardsNav(page).getByRole("button").nth(1).click();
    await expect(tiles(page).getByText(fill("arbiter.tile.notStarted", { name: b2.home.name }), { exact: true })).toBeVisible();
    await expect(white()).toHaveAttribute("aria-disabled", "true");
    await expect(black()).toHaveAttribute("aria-disabled", "true");
    // Leaving board 1's pane handed its participant back; board 2 made no join at all.
    await expect.poll(() => log.slice()).toEqual(["POST home", "minted e2e-home-1", "DELETE e2e-home-1", "DELETE answered e2e-home-1"]);
    await page.waitForTimeout(700);
    expect(log.filter((e) => e.startsWith("POST")), "no join for a board nobody has checked in to").toHaveLength(1);

    // The player arrives: the poll (a hidden tab coming back refreshes at once) reads the room and the join opens.
    await putRoom(b2.fixtureId, r.orgId, "home");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => log.filter((e) => e.startsWith("POST")).length, { timeout: 30_000 }).toBe(2);
    expect(log.at(-2)).toBe("POST home");
    await expect(white()).not.toHaveAttribute("aria-disabled", "true");
    await expect(black(), "the other player has still not arrived").toHaveAttribute("aria-disabled", "true");

    // A room that has been closed is said so: ended, not "has not arrived".
    await withDb((sql) => sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${b2.fixtureId} and side = 'home'`);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(white()).toHaveAttribute("aria-disabled", "true");
    await expect(white()).toContainText(uiEn["arbiter.switch.ended"]!);
    await expect(tiles(page).getByText(uiEn["arbiter.tile.over"], { exact: true })).toBeVisible();
    expect(await noSidewaysScroll(page, [320, 768, 1280])).toBe(3);
  });

  test("a pairing card swaps the colours after a player has arrived: the labels move with the PERSON, the pane stays on the same player's room", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const r = await seedRound(request, ["Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor"]);
    const [b1] = r.boards;
    await gameOn(b1, { moves: LINE }); // White_side = home
    // Only the home player (White) has arrived.
    await withDb((sql) => sql`delete from fixture_video_meetings where fixture_id = ${b1.fixtureId} and side = 'away'`);
    const log = await wire(page, { post: () => "mint" });
    const colourOf = async (page_: Page, name: string) =>
      (await group(page_).getByRole("button").filter({ hasText: name }).innerText()).split(" · ")[0]!.trim();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    await expect.poll(() => log.slice()).toEqual(["POST home", "minted e2e-home-1"]);
    expect(await colourOf(page, b1.home.name)).toBe(uiEn["arbiter.colour.white"]);
    await expect(tiles(page).locator("figcaption")).toContainText(`${b1.home.name} · ${uiEn["arbiter.colour.white"]}`);

    // The colours swap (the bridge row's white_side is what the board lists read first).
    await withDb((sql) => sql`update fixture_external_play set white_side = 'away' where fixture_id = ${b1.fixtureId}`);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(tiles(page).locator("figcaption")).toContainText(`${b1.home.name} · ${uiEn["arbiter.colour.black"]}`);
    expect(await colourOf(page, b1.home.name), "the same person, the other colour").toBe(uiEn["arbiter.colour.black"]);
    expect(await colourOf(page, b1.away.name)).toBe(uiEn["arbiter.colour.white"]);
    // The pane did not move: still the home player's room, no leave, no new join.
    await expect(switchButton(page, "black")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(700);
    expect(log, "a relabel is not a switch").toEqual(["POST home", "minted e2e-home-1"]);
    // And the reason follows the person: the away player (White now) has not arrived.
    await expect(switchButton(page, "white")).toHaveAttribute("aria-disabled", "true");
    await expect(switchButton(page, "white")).toContainText(uiEn["arbiter.switch.none"]!);
    await shoot(page, "arbiter-switch-after-colour-swap");
  });

});

// ─── the Arbiter Panel's round column at 1280 (phase 2, Task 13) ────────────────────────────────────────────────────────────────
// Spec 2026-10-24-arbiter-round-column-design.md. online-chess-desk.spec.ts drives the same column through the full Open round, the
// six invite words and the queue; these are the sequences it does not: a double-clicked confirmation, the invite words beside
// Resend and the hero's press, an Open from a page made stale, a Review that selects in place, Open round 2 while round 1 plays,
// the Fixtures tab's absences, and the two pieces of client state the column owns (the queue's reducer, the open-round hook).
// The e2e servers have no mail provider, so every invite row ends `dead` inside the open and every seat reads "Not delivered";
// `seedSeatInvite` writes the rows the worker and the provider's webhook would. The sweep that holds a no-show is a cron job that
// does not run here, so `holdNoShowSql` writes the row it leaves.
test.describe("arbiter round column", () => {
  /** The dictionary's one/other pair for a count, picked the way `plural()` picks it. */
  const pluralKey = (stem: string, count: number) => `${stem}.${count === 1 ? "one" : "other"}`;

  test("round column: before, open from the column, then check-in with each invite's word", async ({ page, request }) => {
    test.setTimeout(budgetFor(0, 360_000));
    // Eight players, four boards: each of the words below gets a board of its own, because Resend is a BOARD's (a board offers it
    // when either of its seats holds a mail: open-round-view.ts `canResend`).
    const names = [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei", "Dara Okafor", "Eli Brandt", "Fay Moreno", "Gus Hallberg"];
    // The seat count comes from what was ASKED for (four boards of two), not from the seeded boards' own seats: counting the
    // seats back out of `r.boards` would make the premise below a tautology.
    const BOARDS_ASKED = names.length / 2;
    const seatCount = BOARDS_ASKED * 2;
    const r = await seedOnlineRound(request, names, { open: false });
    const ids = r.boards.map((b) => b.fixtureId);
    expect(r.boards.length, "premise: eight players pair into four boards").toBe(BOARDS_ASKED);
    expect(r.boards.flatMap((b) => [b.home, b.away]).length, "premise: a board seats two, so the seeded seats are the seats asked for").toBe(seatCount);
    expect(await inviteRowCount(ids), "the empty case first: nothing is mailed before the open").toBe(0);

    const posts = watchOpenRoundPosts(page, r.stageId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    const col = column(page);
    await expect(col, "the round is paired and not opened").toHaveAttribute("data-phase", "before", { timeout: 30_000 });

    // C20a: a double click on the confirmation is ONE request, and one outbox row per player's address.
    const block = col.locator('[data-testid="arbiter-column-open"][data-round-no="1"]');
    await block.getByTestId("arbiter-column-open-cta").click();
    const confirm = page.getByTestId("arbiter-column-confirm-confirm");
    await expect(confirm).toHaveText(fill("runsheet.round.confirmCta.other", { count: seatCount }));
    await confirm.dblclick();
    await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
    expect(posts.roundNos(), "two clicks, one request").toEqual([1]);
    const opens = await withDb(
      async (sql) => (await sql`select 1 from stage_round_opens where stage_id = ${r.stageId} and round_no = 1`).length,
    );
    expect(opens, "one open, stamped once").toBe(1);
    expect(await inviteRowCount(ids), "one invite row per player's address: 2 x the boards asked for, none doubled").toBe(seatCount);

    // C4, the CI default: no mail provider, so every row ended dead and the hook released every seat. Every seat reads Not delivered,
    // no row offers Resend (no seat holds a mail), and the hero offers the round's reopen press, not a reinvite.
    let words = 0;
    for (const b of r.boards) {
      for (const colour of ["white", "black"] as const) {
        await expectSeatWord(page, b, colour, "not_delivered");
        words += 1;
      }
    }
    expect(words, "anti-vacuity: every seat of every board read").toBe(seatCount);
    await expect(col.getByTestId("arbiter-waiting-resend"), "nobody holds a mail, so no row offers Resend").toHaveCount(0);
    const press = col.getByTestId("arbiter-column-reinvite");
    await expect(press).toHaveText(uiEn["arbiter.column.reopenCta"]!);
    await press.click();
    const dialog = page.getByTestId("arbiter-column-reinvite-dialog");
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 1 }));
    await expect(page.getByTestId("arbiter-column-reinvite-dialog-confirm")).toHaveText(fill("arbiter.column.reopenConfirmCta.other", { count: seatCount }));
    await page.getByTestId("arbiter-column-reinvite-dialog-cancel").click();
    await expect(dialog).toHaveCount(0);
    expect(posts.roundNos(), "Cancel sent nothing").toEqual([1]);

    // The words the mail leaves. One seat per board, a different word on each: delivered, sent, delayed, and a bounce.
    const [b1, b2, b3, b4] = r.boards as [RoundBoard, RoundBoard, RoundBoard, RoundBoard];
    const seeded = [
      [b1, "delivered"],
      [b2, "sent"],
      [b3, "delayed"],
      [b4, "bounced"],
    ] as const;
    for (const [b, word] of seeded) await seedSeatInvite(b.fixtureId, "white", word);
    await page.reload();
    await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
    let read = 0;
    for (const [b, word] of seeded) {
      await expectSeatWord(page, b, "white", word);
      await expectSeatWord(page, b, "black", "not_delivered");
      read += 2;
    }
    expect(read, "anti-vacuity: every seat of the four boards read after the reload").toBe(seatCount);
    expect(new Set(seeded.map(([, w]) => w)).size, "four different words on four boards").toBe(4);

    // Resend: on the boards whose seat holds a mail (sent, delivered, delayed), not on the board whose only mail bounced.
    const resend = (b: RoundBoard) => col.locator(`[data-testid="arbiter-waiting-resend"][data-fixture-id="${b.fixtureId}"]`);
    for (const [b, word] of seeded) {
      await expect(resend(b), `${word}: Resend is offered exactly when a seat on the board holds the mail`).toHaveCount(HOLDING_WORDS.includes(word as InviteWord) ? 1 : 0);
    }
    const holding = seeded.filter(([, w]) => HOLDING_WORDS.includes(w as InviteWord)).length;
    expect(holding, "premise: three of the four words hold a seat").toBe(3);
    await expect(col.getByTestId("arbiter-waiting-resend")).toHaveCount(holding);
    // The press follows what is owed: a seat is owed unless its mail holds it, so it is now a reinvite of the seats not holding.
    await expect(press).toHaveText(fill("runsheet.round.inviteCta.other", { count: seatCount - holding }));
    // The rule is the BOARD's: the bounced board's other seat takes a mail, the bounced seat still reads Bounced, and the board offers
    // Resend. This pins a controller ruling, not a spec clause: Resend on a mixed Bounced + Delivered board is accepted behaviour,
    // because Delivered is not read, so the seat that bounced may still be owed a mail (Resend re-mails both seats of the board).
    await seedSeatInvite(b4.fixtureId, "black", "delivered");
    await page.reload();
    await expectSeatWord(page, b4, "white", "bounced");
    await expectSeatWord(page, b4, "black", "delivered");
    await expect(
      resend(b4),
      "controller ruling: one seat of the board holds a mail, so the board offers Resend (both seats are re-mailed) while its other seat still reads Bounced",
    ).toHaveCount(1);
    await expect(press).toHaveText(fill(pluralKey("runsheet.round.inviteCta", seatCount - holding - 1), { count: seatCount - holding - 1 }));

    // C27b: the mail server's word is Delivered, never "opened". Every invite chip and the help line, counted.
    const chipTexts = await col.getByTestId("arbiter-invite-word").allTextContents();
    expect(chipTexts.length, "anti-vacuity: every seat shows a chip").toBe(seatCount);
    const helpText = await col.getByTestId("arbiter-invite-help").textContent();
    expect(helpText, "the help line is on screen").toBe(uiEn["arbiter.invite.help"]);
    for (const text of [...chipTexts, helpText!]) expect(text, `"${text}" must not claim the mail was opened`).not.toMatch(/open/i);
    expect(posts.roundNos(), "nothing but the one open was sent").toEqual([1]);
  });

  test('round column: "already open" from a stale page', async ({ page, request }) => {
    test.setTimeout(budgetFor(0, 240_000));
    const names = [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"];
    const BOARDS_ASKED = names.length / 2;
    const seatCount = BOARDS_ASKED * 2;
    const r = await seedOnlineRound(request, names, { open: false });
    const ids = r.boards.map((b) => b.fixtureId);
    expect(r.boards.length, "premise: four players pair into two boards").toBe(BOARDS_ASKED);
    expect(r.boards.flatMap((b) => [b.home, b.away]).length, "premise: a board seats two, so the seeded seats are the seats asked for").toBe(seatCount);
    const posts = watchOpenRoundPosts(page, r.stageId);
    await page.setViewportSize({ width: 1280, height: 900 });
    // The Before phase with no round open polls at the quiet period (QUIET_POLL_MS). The test is stale only while that poll has not
    // fired, so the clock starts at the load and the premise below is checked twice: before the press and after the confirm. A slow
    // run fails here BY NAME, instead of flaking on a column that quietly refreshed itself.
    const QUIET_SLACK_MS = 30_000;
    const loadedAt = Date.now();
    const stillStale = (when: string) =>
      expect(Date.now() - loadedAt, `premise (${when}): the quiet poll (${QUIET_POLL_MS} ms) has not fired, so the page is still stale`).toBeLessThan(QUIET_POLL_MS - QUIET_SLACK_MS);
    await page.goto(r.arbiterPath);
    const col = column(page);
    await expect(col).toHaveAttribute("data-phase", "before", { timeout: 30_000 });
    const cta = col.locator('[data-testid="arbiter-column-open"][data-round-no="1"]').getByTestId("arbiter-column-open-cta");
    await expect(cta).toBeVisible();

    // Elsewhere (another tab, a second organiser) the round is opened, and every seat's mail is on its way: nobody is left to invite.
    // The page in front of the organiser has not heard (see the clock above).
    const opened = await apiJson(request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo: 1 });
    expect(opened.status, `open-round: ${JSON.stringify(opened.error)}`).toBeLessThan(300);
    for (const b of r.boards) for (const colour of ["white", "black"] as const) await seedSeatInvite(b.fixtureId, colour, "sent");
    const rowsBefore = await inviteRowCount(ids);
    expect(rowsBefore, "the other open queued one row per player's address").toBe(seatCount);
    await expect(col, "premise: the page is stale, it still says the round is not opened").toHaveAttribute("data-phase", "before");

    await recordOpenNotices(page);
    stillStale("before the press");
    await cta.click();
    const sent = openRoundSent(page, r.stageId);
    await page.getByTestId("arbiter-column-confirm-confirm").click();
    stillStale("after the confirm");
    const res = await sent;
    expect(res.status()).toBeLessThan(300);
    const body = ((await res.json()) as { data: { opened: boolean; reason?: string; skipped: unknown[] } }).data;
    expect(body, "the route answered that the round is already open, with nobody to invite").toEqual({ opened: false, reason: "already_open", skipped: [] });
    // The refresh that follows flips the column to check-in and takes the block, and its notice, away: the notice is read as it was drawn.
    await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
    const drawn = await recordedOpenNotices(page);
    expect(drawn, "the observer survived the flip (the page did not navigate)").not.toBeNull();
    expect(drawn!.at(-1), "the notice read: already open").toEqual([uiEn["externalPlay.openRound.alreadyOpen"]]);
    expect(posts.roundNos(), "one press, one request").toEqual([1]);
    expect(await inviteRowCount(ids), "the stale press queued nothing").toBe(rowsBefore);
    // And the page now shows the truth the press answered: every seat holds a mail, so nobody is owed and the hero has no press.
    await expectSeatWord(page, r.boards[0]!, "white", "sent");
    await expect(col.getByTestId("arbiter-column-reinvite"), "nobody is owed").toHaveCount(0);
  });

  test('round column: a held board is "Review board N" and selects in place', async ({ page, request }) => {
    test.setTimeout(budgetFor(0, 240_000));
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"]);
    const [b1, b2] = [r.boards[0]!, r.boards[1]!];
    // Board 2 is held (the sweep's and a mismatch's way to the organiser's desk); board 1 is the panel's default and stays checking in.
    await roundGameSql(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    const col = column(page);
    await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
    const nav = boardsNav(page).getByRole("button");
    await expect(nav).toHaveCount(2);
    await expect(nav.nth(0), "board 1 is on screen").toHaveAttribute("aria-pressed", "true");
    await expect(nav.nth(1)).toHaveAttribute("aria-pressed", "false");
    const pathBefore = new URL(page.url()).pathname;
    expect(pathBefore, "premise: the panel's own page").toBe(r.arbiterPath);

    const queue = col.getByTestId("arbiter-column-queue");
    await expect(queue.getByTestId("arbiter-column-queue-title")).toHaveText(fill("arbiter.column.queue.one", { count: 1 }));
    const card = queue.locator(`[data-testid="arbiter-column-card"][data-kind="held"][data-fixture-id="${b2.fixtureId}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("arbiter-column-card-chip")).toHaveText(uiEn["externalPlay.held.mismatch"]!);
    const review = card.getByTestId("arbiter-column-review");
    await expect(review).toHaveText(fill("arbiter.column.review", { board: 2 }));
    await expect(review, "a board of the round on screen is selected in place, not linked to").toHaveAttribute("data-target", "select");
    // `data-target` is the card's own claim; the element says what it is: a button with no href. A same-path <Link> (the defect this
    // card replaced) is an anchor with an href, and a soft navigation through it could keep the document alive, so the `__stay` mark
    // below cannot tell the two apart on its own.
    expect(await review.evaluate((el) => ({ tag: el.tagName, href: el.getAttribute("href") })), "Review is a button, not a link").toEqual({ tag: "BUTTON", href: null });

    // A mark on the live document: a navigation (the self-link defect this card replaced) would load a new one and lose it.
    await page.evaluate(() => {
      (window as unknown as { __stay?: string }).__stay = "same document";
    });
    await review.click();
    await expect(nav.nth(1), "the pressed state moves to board 2").toHaveAttribute("aria-pressed", "true");
    await expect(nav.nth(0)).toHaveAttribute("aria-pressed", "false");
    const after = new URL(page.url());
    expect(after.pathname, "the path is unchanged").toBe(pathBefore);
    expect(after.searchParams.get("fixture"), "the board on screen is recorded on the URL").toBe(b2.fixtureId);
    expect(await page.evaluate(() => (window as unknown as { __stay?: string }).__stay), "no navigation: the document is the same one").toBe("same document");

    // The decision area is board 2's: its Settle fieldset offers board 2's players (White is the home side, recorded on the row), and none of board 1's.
    await decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"]!, exact: true }).click();
    const settle = page.getByTestId("arbiter-settle");
    await expect(settle).toBeVisible();
    await expect(settle.getByRole("button", { name: fill("externalPlay.settle.wins", { name: b2.home.name }), exact: true })).toBeVisible();
    await expect(settle.getByRole("button", { name: fill("externalPlay.settle.wins", { name: b2.away.name }), exact: true })).toBeVisible();
    for (const stranger of [b1.home.name, b1.away.name]) {
      await expect(settle.getByText(stranger), `board 1's ${stranger} is not offered on board 2's settle`).toHaveCount(0);
    }
    await expect(page.getByRole("heading", { level: 2, name: new RegExp(`^${fill("arbiter.boardNo", { n: 2 })} · `) }), "the board heading is board 2's").toBeVisible();
  });

  test("round column: Open round 2 stays offered while round 1 plays, with the warning", async ({ page, request }) => {
    test.setTimeout(budgetFor(0, 240_000));
    // A league pairs every round at Generate, so round 2's pairings exist while round 1 plays.
    const names = [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"];
    const BOARDS_ASKED = names.length / 2;
    const seatCount = BOARDS_ASKED * 2;
    const r = await seedOnlineRound(request, names);
    const ids = r.boards.map((b) => b.fixtureId);
    expect(r.boards.length, "premise: four players pair into two boards").toBe(BOARDS_ASKED);
    expect(r.boards.flatMap((b) => [b.home, b.away]).length, "premise: a board seats two, so the seeded seats are the seats asked for").toBe(seatCount);
    for (const b of r.boards) await roundGameSql(b, { moves: LINE.slice(0, 4) });
    const round2 = await withDb((sql) => sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and round_no = 2 order by seq_in_round`);
    expect(round2.length, "premise: round 2 is paired, with as many boards as round 1").toBe(BOARDS_ASKED);
    expect(await inviteRowCount(round2.map((x) => x.id)), "the empty case first: round 2 has mailed nobody").toBe(0);

    const posts = watchOpenRoundPosts(page, r.stageId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    const col = column(page);
    await expect(col, "every board of round 1 has a game, so none is checking in").toHaveAttribute("data-phase", "playing", { timeout: 30_000 });
    const next = col.locator('[data-testid="arbiter-column-open"][data-round-no="2"]');
    await expect(next, "round 2 is offered").toHaveCount(1);
    await expect(next.getByRole("heading", { name: fill("runsheet.round.heading", { round: 2 }) })).toBeVisible();
    const press = next.getByTestId("arbiter-column-next");
    await expect(press, "quiet while a board plays: opening stays the organiser's call").toHaveAttribute("data-primary", "false");
    const earlierText = fill(pluralKey("runsheet.round.confirmEarlierInPlay", ids.length), { round: 1, count: ids.length });
    const inline = next.getByTestId("arbiter-column-earlier");
    await expect(inline, "the warning is on the page before the press").toHaveAttribute("role", "note");
    await expect(inline.locator("[data-earlier-round]")).toHaveCount(1);
    await expect(inline.locator('[data-earlier-round="1"]')).toHaveText(earlierText);

    await press.click();
    const dialog = page.getByTestId("arbiter-column-confirm");
    await expect(dialog).toContainText(fill("runsheet.round.confirmTitle", { round: 2 }));
    const note = dialog.getByTestId("open-round-earlier");
    await expect(note, "and again in the confirmation, naming the games").toHaveAttribute("role", "note");
    await expect(note.locator('[data-earlier-round="1"]')).toHaveText(earlierText);
    expect(posts.roundNos(), "asking sends nothing").toEqual([]);
    const confirm = page.getByTestId("arbiter-column-confirm-confirm");
    await expect(confirm).toHaveText(fill("runsheet.round.confirmCta.other", { count: seatCount }));
    await confirm.click();
    await expect(col, "round 2 opens beside the games still playing in round 1").toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
    await expect(col.getByTestId("arbiter-checkin-hero").getByRole("heading", { name: fill("runsheet.round.heading", { round: 2 }) })).toBeVisible();
    expect(posts.roundNos(), "the press asked for round 2").toEqual([2]);
    expect(await inviteRowCount(round2.map((x) => x.id)), "round 2's players were mailed").toBe(seatCount);
    expect(await inviteRowCount(ids), "round 1's games were not touched").toBe(seatCount);
  });

  test("Fixtures tab: no Open round, no queue, one entry line", async ({ page, request }) => {
    test.setTimeout(budgetFor(0, 300_000));
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"], { open: false });
    const b2 = r.boards[1]!;
    const total = await withDb(async (sql) => {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${r.stageId}`;
      return row!.n;
    });
    expect(total, "premise: a league of four is six games").toBeGreaterThan(r.boards.length);
    await page.setViewportSize({ width: 1280, height: 900 });

    // One state after another. Each is the entry card's line, from the ladder (lib/round-column.ts `entryStatus` / `entryLine`:
    // attention outranks check-in, check-in outranks ready). A control that is gone is looked for by its WORDS, beside a positive on
    // the same page - the entry card, its link and every run-sheet row - so an absence cannot pass on a page that rendered nothing.
    let states = 0;
    const read = async (kind: string, line: string, label: string) => {
      await page.goto(r.fixturesTab);
      const entry = page.getByTestId("arbiter-entry");
      await expect(entry, `${label}: the entry card is there`).toBeVisible({ timeout: 30_000 });
      await expect(entry.getByTestId("arbiter-entry-status"), `${label}: one entry line`).toHaveCount(1);
      await expect(entry.getByTestId("arbiter-entry-status")).toHaveAttribute("data-kind", kind);
      await expect(entry.getByTestId("arbiter-entry-status")).toHaveText(line);
      await expect(entry.getByRole("link", { name: uiEn["arbiter.entry.link"]!, exact: true }), `${label}: the way into the panel`).toBeVisible();
      await expect(page.locator("li[data-fixture-no]"), `${label}: the run sheet is on the page`).toHaveCount(total);
      for (const gone of ["runsheet.round.openCta", "runsheet.round.resend", "arbiter.column.reopenCta", "externalPlay.queue.markReviewed"]) {
        await expect(page.getByRole("button", { name: uiEn[gone]!, exact: true }), `${label}: no "${uiEn[gone]}" on the tab`).toHaveCount(0);
      }
      // Open round is also looked for as a link and as bare text, by its words: no test id stands for it here (nothing in the source
      // emits an "open-round" test id, so an absence of that id would pass on any page).
      await expect(page.getByRole("link", { name: uiEn["runsheet.round.openCta"]!, exact: true }), `${label}: no "Open round" link on the tab`).toHaveCount(0);
      await expect(page.getByText(uiEn["runsheet.round.openCta"]!, { exact: true }), `${label}: no "Open round" text on the tab`).toHaveCount(0);
      for (const n of [1, 2]) {
        await expect(page.getByRole("button", { name: fill("arbiter.column.review", { board: n }), exact: true })).toHaveCount(0);
        await expect(page.getByRole("link", { name: fill("arbiter.column.review", { board: n }), exact: true })).toHaveCount(0);
      }
      for (const gone of ["arbiter-round-column", "arbiter-column-queue", "arbiter-column-card", "arbiter-waiting"]) {
        await expect(page.getByTestId(gone), `${label}: ${gone} is the panel's`).toHaveCount(0);
      }
      states += 1;
    };

    await read("ready", fill("arbiter.entry.status.ready", { round: 1 }), "paired, not opened");
    // The positive pair of the words just proved absent: in this very state (paired, not opened) the PANEL offers Open round, once,
    // under the same words. So the tab's absence above is the tab leaving the control out, not the words failing to match it.
    await page.goto(r.arbiterPath);
    await expect(column(page), "the panel's column is there, before the open").toHaveAttribute("data-phase", "before", { timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: uiEn["runsheet.round.openCta"]!, exact: true }),
      "positive pair: the Arbiter Panel offers Open round, under the words the tab was searched for",
    ).toHaveCount(1);
    const opened = await apiJson(request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo: 1 });
    expect(opened.status, `open-round: ${JSON.stringify(opened.error)}`).toBeLessThan(300);
    await read("checkin", fill("arbiter.entry.status.checkin", { round: 1 }), "round 1 opened, window running");
    await roundGameSql(b2, { moves: LINE.slice(0, 6), hold: "mismatch" });
    await read("attention", fill("arbiter.column.queue.one", { count: 1 }), "a board needs a decision");
    await expect(page.getByTestId("run-sheet-online-held-chip"), "the run sheet's own chip still points at the held board").toHaveCount(1);
    await roundGameSql(b2, { moves: LINE.slice(0, 6) });
    await read("checkin", fill("arbiter.entry.status.checkin", { round: 1 }), "the board is let go, the window still running");
    // The window ends (round 1 opened long enough ago): no check-in is under way, and round 2 is the one waiting for its Open.
    await backdateOpenSql(r.stageId, 1, DEADLINE_AFTER_MS + 120_000);
    await read("ready", fill("arbiter.entry.status.ready", { round: 2 }), "round 1's window ended, round 2 is next");
    expect(states, "anti-vacuity: five states read").toBe(5);
  });

  test("round column: the queue keeps its own state across the check-in to playing flip", async ({ page, request }) => {
    // One poll is waited out for the flip; the rest is seeding (four players) and the page loads.
    test.setTimeout(budgetFor(1, 240_000));
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"]);
    const [b1, b2] = [r.boards[0]!, r.boards[1]!];
    // The queue's one piece of state of its own is a cancelled flagged board's "Mark as reviewed" (its card cannot be selected, so it
    // closes its review itself, with the queue's own reducer). A league pairs every round: a game of round 2 is cancelled and flagged.
    const [later] = await withDb((sql) => sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and round_no = 2 order by seq_in_round limit 1`);
    expect(later, "premise: round 2 is paired").toBeDefined();
    await cancelFlaggedSql(r.orgId, later!.id);
    await roundGameSql(b1, { moves: LINE.slice(0, 6), hold: "mismatch" });
    // Board 2 is the one still checking in. Its window has ENDED (the round was opened long enough ago), which is how a board comes to be
    // held: the sweep follows the deadline. The deadline passing alone changes nothing on screen.
    await backdateOpenSql(r.stageId, 1, DEADLINE_AFTER_MS + 120_000);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    const col = column(page);
    await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
    await expect(col.getByTestId("arbiter-checkin-clock"), "premise: board 2's window has ended").toHaveAttribute("data-kind", "closed");
    const queue = col.getByTestId("arbiter-column-queue");
    await expect(queue.getByTestId("arbiter-column-queue-title")).toHaveText(fill("arbiter.column.queue.other", { count: 2 }));
    const heldCard = (b: RoundBoard) => queue.locator(`[data-testid="arbiter-column-card"][data-kind="held"][data-fixture-id="${b.fixtureId}"]`);
    const flaggedCard = queue.locator(`[data-testid="arbiter-column-card"][data-kind="flagged"][data-fixture-id="${later!.id}"]`);
    await expect(heldCard(b1)).toHaveCount(1);
    await expect(flaggedCard).toHaveCount(1);
    await expect(flaggedCard.getByTestId("arbiter-column-review"), "a cancelled board cannot be selected: no Review").toHaveCount(0);

    // A mark on the queue's node and on the column's, so a remount (a new node) is told from a re-render.
    await queue.evaluate((el) => {
      (el as HTMLElement & { __probe?: string }).__probe = "queue";
    });
    await col.evaluate((el) => {
      (el as HTMLElement & { __probe?: string }).__probe = "column";
    });
    await flaggedCard.getByTestId("arbiter-column-mark-reviewed").click();
    // Its card goes with the refresh, so the answer stands where the card was: the queue's own status line, now visible.
    const answer = queue.getByTestId("arbiter-column-queue-status");
    await expect(answer).toHaveText(uiEn["externalPlay.queue.reviewed"]!, { timeout: 30_000 });
    await expect(flaggedCard).toHaveCount(0);
    // Playwright counts a 1px `sr-only` box as visible, so "now on screen" is the class that hides it from the eye, not toBeVisible.
    await expect(answer, "the answer stands where the card was, no longer screen-reader only").not.toHaveClass(/sr-only/);
    await expect(queue.getByTestId("arbiter-column-queue-title")).toHaveText(fill("arbiter.column.queue.one", { count: 1 }));
    const closed = await withDb(
      async (sql) => (await sql`select 1 from fixture_play_flags where fixture_id = ${later!.id} and closed_at is not null`).length,
    );
    expect(closed, "the flag was closed on the server").toBe(1);
    // The window is over and the phase has not moved: a deadline passing flips nothing; a board leaving check-in does.
    await expect(col).toHaveAttribute("data-phase", "checkin");

    // The sweep holds board 2 (no_show_both); the panel's own poll brings it in. The wait is the poll's period, from the constant.
    await holdNoShowSql(b2.fixtureId);
    await expect(col, "no board is checking in: the column flips to its playing phase").toHaveAttribute("data-phase", "playing", { timeout: POLL_BUDGET_MS });
    // The same queue, not a new one: the probe survived, so did the answer, and the new held board is in it.
    expect(await queue.evaluate((el) => (el as HTMLElement & { __probe?: string }).__probe), "the queue's node survived the flip").toBe("queue");
    expect(await col.evaluate((el) => (el as HTMLElement & { __probe?: string }).__probe), "the column's node survived the flip").toBe("column");
    await expect(answer, "the queue's own answer survived the flip").toHaveText(uiEn["externalPlay.queue.reviewed"]!);
    await expect(heldCard(b2)).toHaveCount(1);
    await expect(heldCard(b2).getByTestId("arbiter-column-card-chip")).toHaveText(uiEn["externalPlay.held.noShowBoth"]!);
    await expect(heldCard(b1)).toHaveCount(1);
    await expect(queue.getByTestId("arbiter-column-queue-title")).toHaveText(fill("arbiter.column.queue.other", { count: 2 }));
    await expect(queue.getByTestId("arbiter-column-queue-title")).toHaveAttribute("data-tone", "held");
  });

  test("round column: the open-round hook resets on a round change, and a press targets the round on screen", async ({ page, request }) => {
    // Two panel refreshes are waited for (each is the tab coming back, which refreshes at once), plus the seeding of a league of four.
    test.setTimeout(budgetFor(2, 240_000));
    const r = await seedOnlineRound(request, [longName(), "Ana Petrova", "Bo Lindqvist", "Chen Wei"]);
    const posts = watchOpenRoundPosts(page, r.stageId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.arbiterPath);
    const col = column(page);
    await expect(col).toHaveAttribute("data-phase", "checkin", { timeout: 30_000 });
    const hero = col.getByTestId("arbiter-checkin-hero");
    const heading = (round: number) => hero.getByRole("heading", { name: fill("runsheet.round.heading", { round }) });
    const press = col.getByTestId("arbiter-column-reinvite");
    const dialog = page.getByTestId("arbiter-column-reinvite-dialog");
    const confirm = page.getByTestId("arbiter-column-reinvite-dialog-confirm");
    const openByApi = async (roundNo: number) => {
      const res = await apiJson(request, `/api/v1/stages/${r.stageId}/open-round`, "POST", { roundNo });
      expect(res.status, `open round ${roundNo}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    };

    // A: a confirmation is open for round 1; round 2 is opened elsewhere and the panel brings it in.
    await expect(heading(1)).toBeVisible();
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 1 }));
    await openByApi(2);
    await refreshNow(page);
    await expect(heading(2), "round 2 is the round on screen").toBeVisible({ timeout: POLL_BUDGET_MS });
    await expect(dialog, "the confirmation for round 1 did not survive the round changing").toHaveCount(0);
    expect(posts.roundNos(), "the abandoned confirmation sent nothing").toEqual([]);
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 2 }));
    await confirm.click();
    await expect(page.getByTestId("arbiter-column-reinvite-notice"), "the press answered").toBeVisible({ timeout: 30_000 });
    expect(posts.roundNos(), "the press asked for round 2, not the round that was confirmed before").toEqual([2]);

    // B: the runner's in-flight flag outlives the reset (by design, rule R1: one request at a time). A press for round 2 is held in
    // flight; round 3 opens and comes in; the confirmation for round 3 is then tapped once while the old request is out (a dead tap:
    // nothing is sent), and tapped again after its answer (one request, for round 3).
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen = 0;
    await page.route(new RegExp(`/stages/${r.stageId}/open-round$`), async (route) => {
      seen += 1;
      if (seen === 1) await gate;
      await route.continue();
    });
    // The held answer's own wait must outlast the hold (the default 30 s would expire while the gate is shut), and "held" is proved,
    // not assumed: the route saw the request, and the answer has not arrived by the time of the dead tap below.
    const heldAnswer = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes(`/stages/${r.stageId}/open-round`), { timeout: 60_000 });
    let answered = false;
    heldAnswer.then(
      () => {
        answered = true;
      },
      () => {},
    );
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 2 }));
    await confirm.click();
    await expect.poll(() => posts.roundNos(), { message: "the second press for round 2 is out, held at the network" }).toEqual([2, 2]);
    expect(seen, "the route held exactly one request: the second press for round 2").toBe(1);
    expect(answered, "the held request has not been answered").toBe(false);
    await openByApi(3);
    await refreshNow(page);
    await expect(heading(3), "round 3 is the round on screen, with the old request still out").toBeVisible({ timeout: POLL_BUDGET_MS });
    await expect(dialog, "round 2's confirmation (busy) is gone with the reset").toHaveCount(0);
    await press.click();
    await expect(dialog).toContainText(fill("arbiter.column.reopenConfirmTitle", { round: 3 }));
    await confirm.click();
    // The dead tap: a request is sending nothing for 800 ms is not proof by itself, so the other half is the dialog still waiting.
    await page.waitForTimeout(800);
    expect(posts.roundNos(), "the tap landed while the old request was out: nothing was sent for round 3").toEqual([2, 2]);
    expect(seen, "the dead tap reached the route no more than the held request did").toBe(1);
    expect(answered, "the old request was still out at the dead tap: it was held, so the tap really was dead").toBe(false);
    await expect(dialog, "and the confirmation waits for another tap").toBeVisible();
    release();
    await heldAnswer;
    expect(answered, "the held request is answered once released").toBe(true);
    await expect(page.getByTestId("arbiter-column-reinvite-notice"), "round 2's answer shows nothing under round 3").toHaveCount(0);
    // After the answer the next tap goes. A tap that lands before the runner has cleared its flag is dead again, so it is retried.
    await expect(async () => {
      await confirm.click({ timeout: 2_000 });
      await expect.poll(() => posts.roundNos().filter((n) => n === 3).length, { timeout: 2_000 }).toBe(1);
    }).toPass({ timeout: 20_000 });
    expect(posts.roundNos(), "round 2's two presses, then exactly one for round 3").toEqual([2, 2, 3]);
    expect(seen, "the route saw the held request and round 3's one request, nothing else").toBe(2);
    await expect(page.getByTestId("arbiter-column-reinvite-notice"), "round 3's own answer").toBeVisible({ timeout: 30_000 });
  });
});
