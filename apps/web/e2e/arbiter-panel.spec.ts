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
import { apiJson, createStageAndGenerate, linkPersonToUserBySql, loginUi, TAG, withDb } from "./helpers";
import { CLOCK, fill, longName, seedLichessLink, seedUser, uiEn } from "./match-room-kit";

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

async function seedRound(request: import("@playwright/test").APIRequestContext, names: string[]): Promise<Round> {
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
    // Exact: the run sheet's flag chips and the queue's "Review in arbiter panel" (T16) also lead there.
    await page.getByRole("link", { name: uiEn["arbiter.entry.link"], exact: true }).click();
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

  // I-3 (controller ruling, fix round 2): "No result" is VOID — an abandon, no points, no absence — and in ANY knockout
  // the server refuses it (a knockout game needs a winner), so it is not offered there — on the panel or on the
  // division's queue — and the settle says why. The knockout board here FEEDS a next match: the hiding is the
  // knockout's, not a final's. The pairs: a league board offers it, and settling it reads back as No result; a winner
  // still settles the knockout board, through the real server.
  test("I-3: a league board settles No result as VOID; on a knockout line that feeds a next match No result is hidden and the settle says why, panel and queue; no sideways scroll at 320, 768 or 1280", async ({
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
    await expect(page.getByTestId("arbiter-settle-knockout")).toHaveCount(0);
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
    expect(voided.ledger, "the abandon, its reason the organiser's own decision").toEqual([
      { type: "core.abandon", payload: { reason: uiEn["externalPlay.resolve.abandonReason.none"] } },
    ]);
    // The panel reads it back as No result.
    await page.goto(`${r.arbiterPath}?fixture=${b1.fixtureId}`);
    await expect(page.getByText(uiEn["arbiter.status.noResult"]!, { exact: true })).toBeVisible();
    await shoot(page, "arbiter-league-no-result");

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
    const winners = [fill("externalPlay.settle.wins", { name: b2.home.name }), fill("externalPlay.settle.wins", { name: b2.away.name })];

    // The division's queue: the held card's settle, opened.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    const row = page.getByTestId(`external-play-queue-row-${b2.fixtureId}`);
    await row.getByTestId("external-play-settle-toggle").click();
    await expect(row.getByTestId("external-play-settle").getByRole("button")).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(row.getByTestId("external-play-settle-knockout")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);
    await shoot(page, "queue-knockout-settle");
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the queue").toBe(3);

    // The arbiter panel: the same three, the same sentence.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${r.arbiterPath}?fixture=${b2.fixtureId}`);
    const settle2 = decision(page).getByRole("button", { name: uiEn["arbiter.decide.settle"] });
    await settle2.click();
    await expect(settle2).toHaveAttribute("aria-expanded", "true");
    const choices2 = page.getByTestId("arbiter-settle").getByRole("button");
    await expect(choices2).toHaveText([...winners, uiEn["externalPlay.resolve.draw"]!]);
    await expect(page.getByTestId("arbiter-settle-knockout")).toHaveText(uiEn["arbiter.decide.knockoutNeedsWinner"]!);
    await shoot(page, "arbiter-knockout-settle");
    expect(await noSidewaysScroll(page, [320, 768, 1280]), "the panel").toBe(3);

    // The pair: a winner settles the knockout board.
    await page.setViewportSize({ width: 1280, height: 900 });
    await choices2.filter({ hasText: winners[0]! }).click();
    await expect(status(page)).toHaveText(uiEn["arbiter.notice.settled"]);
    const settled = await withDb(async (sql) => {
      const [x] = await sql<{ kind: string | null; homeWon: boolean }[]>`
        select outcome->>'kind' as kind, (outcome->>'winner') = home_entrant_id::text as "homeWon" from fixtures where id = ${b2.fixtureId}`;
      return x!;
    });
    expect(settled).toEqual({ kind: "win", homeWon: true });
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
      const participantId = `e2e-${fixtureId.slice(0, 8)}-${minted.length + 1}`; // boardOf() reads the middle
      minted.push(participantId);
      await route.fulfill({ json: { ok: true, data: { authToken: "e2e-not-a-token", participantId, white: [], black: [] } } });
    });
    await page.route(/\/external-play\/arbiter\/[^/]+$/, async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      handedBack.push(decodeURIComponent(route.request().url().split("/").pop()!));
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
    await expect(tiles(page)).toHaveCount(2);
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
    await expect(tiles(page), "the pinned board's tiles stay").toHaveCount(2);
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
});
