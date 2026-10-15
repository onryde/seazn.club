/**
 * Online chess on OUR page, end to end (design 2026-10-09) — and the Task 9
 * public-page regressions it grew from.
 *
 * Task 9 (kept, unchanged): an OTB board has no watch panel and no door to a
 * room; a live online board is WATCHED on the public page and links to no
 * Lichess game (D3); a held board is settled from the organiser's queue.
 *
 * Task 17 (the serial describe below): the product-level proof of the venue.
 * The organiser OPENS a Swiss round through the run sheet (D12); four players
 * seat themselves through the SERVER-verified camera preflight (states 2, 3
 * and 4 on the way, 9 on the board); our server creates each Lichess game and
 * submits both sides' moves; a resign and an unwatched flag are written as
 * results — never as forfeits; round 2 waits for the organiser, and is
 * opened by the same control. Plus D12's negative: a round paired but never
 * opened, long past its scheduled time, seats and forfeits nobody.
 *
 * Both outside services are LOCAL fixture servers the spec starts —
 * e2e/lichess-fixture-server.ts (4321) and e2e/realtimekit-fixture-server.ts
 * (4322) — and the SERVER UNDER TEST must already point at them:
 * LICHESS_BASE_URL, REALTIMEKIT_BASE_URL and REALTIMEKIT_FIXTURE_ENV's five
 * credentials (e2e.yml, ci-local.sh, docs/runbooks/e2e-local.md). Unset, the
 * server would call lichess.org and Cloudflare with fake tokens; the first
 * call each half makes is asserted with a message that names the variables.
 * The runner and the server share LICHESS_TOKEN_KEK, AUTH_SECRET and
 * CRON_SECRET (the tokens are sealed and the links minted here).
 *
 * Nothing leaves the machine. The real RealtimeKit SDK is handed the video
 * fixture's opaque participant token, which it refuses at `init` before any
 * network call (measured: not one off-machine request), so the player's own
 * camera fails CLOSED in the page (camera state "failed") — which is what
 * makes state 2's card and state 9's banner reachable. Each player's browser
 * context also aborts every request and websocket to any host but the app's,
 * the backstop for anything else (realtime, telemetry). Presence is told to
 * the fixture by `setLivePublisher`, the ONLY way anyone is present there —
 * the seat is the SERVER's call on the meeting's word, never the page's.
 * Expected values come from the moves and clock this spec chooses, the
 * dictionary, or the fixture's own record of what it was sent — never from
 * the code under test.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Chess } from "chess.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  apiJson,
  divisionPath,
  fixturePath,
  forfeitEventCountSql,
  loginUi,
  matchRoomPathBySql,
  resultEventCountSql,
  roundOpenedAtSql,
  seedFixtureExternalPlaySql,
  seedRosteredFixture,
  setFixtureScheduledAtSql,
  TAG,
  withDb,
} from "../helpers";
import { publicFixturePath } from "../spectator-public-helpers";
import {
  boardPainted,
  bridgeRow,
  checkedInAt,
  fill,
  seedGameSql,
  seedMatchRoom,
  seedOnlineRound,
  tapMove,
  uiEn,
  type RoundBoard,
  type RoundPlayer,
  type SeededRound,
} from "../match-room-kit";
import { LICHESS_FIXTURE_PORT, startLichessFixtureServer, type LichessFixtureServer } from "../lichess-fixture-server";
import {
  REALTIMEKIT_FIXTURE_PORT,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../realtimekit-fixture-server";
import { DEADLINE_AFTER_MS, LICHESS_TIMEOUT_MS, WINDOW_OPEN_LEAD_MS } from "../../src/server/external-play/window";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "../../src/lib/consent";
import { routes } from "../../src/lib/routes";

test.describe.configure({ mode: "parallel" });
// A synthetic camera, so getUserMedia resolves in a player's page (Task 17).
// It does NOT grant a seat — realtimekit-fixture-server.ts's design note. A
// launch option, so file-wide (Playwright refuses it per describe); the Task 9
// tests open no camera.
test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } });

/** T17B fix 2, D15: under camera "required" the check-in tests the camera ON THE PAGE before Check in opens — this
 *  file's browsers run Chromium's fake camera, so the test passes as a player's would. A board without the duty has
 *  no test: nothing to do. */
async function passCameraTest(p: Page): Promise<void> {
  const camera = p.getByTestId("room-checkin-test-cta");
  if ((await camera.count()) === 0) return;
  await camera.click();
  await expect(p.getByTestId("room-checkin-cta"), "the tested camera opens Check in").toBeEnabled({ timeout: 15_000 });
}

async function sharedPath(
  request: import("@playwright/test").APIRequestContext,
  competitionId: string,
  divisionId: string,
  fixtureId: string,
): Promise<string> {
  const org = await apiJson<{ id: string; slug: string }[]>(request, "/api/orgs");
  const comp = await apiJson<{ org_id: string; slug: string }>(
    request,
    `/api/v1/competitions/${competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);
  expect(comp.status).toBe(200);
  expect(div.status).toBe(200);
  const orgSlug = org.data?.find((o) => o.id === comp.data!.org_id)?.slug;
  expect(orgSlug, "org slug for competition").toBeTruthy();
  return publicFixturePath(orgSlug!, comp.data!.slug, div.data!.slug, fixtureId);
}

test("OTB boardgame: no Play CTA on public page; console pad still mounts", async ({ page }) => {
  test.setTimeout(120_000);
  const homeName = `EP OTB Home ${TAG}`;
  const awayName = `EP OTB Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `EP OTB ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });

  const pub = await sharedPath(page.request, fx.competitionId, fx.divisionId, fx.fixtureId);
  await page.goto(pub);
  await expect(page.locator("main"), "the match centre rendered").toContainText(`EP OTB ${TAG}`, { timeout: 20_000 });
  // Over the board: nothing online to watch, no door to a room (the positive
  // pair is the next test, on an online division).
  await expect(page.getByTestId("watch-panel")).toHaveCount(0);
  await expect(page.getByTestId("your-board")).toHaveCount(0);

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(page.locator('[data-testid="score-pad"]')).toBeVisible({ timeout: 20_000 });
});

test("a live online board: the public page watches the game here and links to no Lichess game", async ({ page }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`EP Live Home ${TAG}`, `EP Live Away ${TAG}`] });
  // Four legal plies, judged by chess.js in the kit; the FEN is the rules', not the page's.
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5", "g1f3", "b8c6"] });

  const res = await page.goto(room.fixturePath);
  expect(res?.status(), "the public fixture page renders with a game on file").toBe(200);
  await expect(page.getByTestId("watch-panel")).toHaveAttribute("data-state", "live", { timeout: 20_000 });
  await expect(page.getByTestId("watch-board")).toBeAttached();
  await expect(page.getByTestId("room-board-surface")).toHaveAttribute("data-fen", fen);
  await expect(page.getByTestId("room-board-surface")).toHaveAttribute("data-view-only", "true");
  await expect(page.locator('a[href*="lichess.org"]')).toHaveCount(0);
});

test("needs_organiser queue: organiser can resolve from division page", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `EP Queue ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: `EP Queue Home ${TAG}` }],
    away: [{ fullName: `EP Queue Away ${TAG}` }],
    emitCoreStart: false,
  });

  await seedFixtureExternalPlaySql(fx.fixtureId, {
    status: "needs_organiser",
    needsReason: "provider_error",
    lastError: "e2e-needs-organiser",
    challengeId: `e2eNeedsOrg-${TAG}`,
  });

  await page.goto(await divisionPath(page.request, fx.divisionId));
  await expect(page.getByTestId("external-play-needs-result-queue")).toBeVisible({
    timeout: 20_000,
  });
  const row = page.getByTestId(`external-play-queue-row-${fx.fixtureId}`);
  await expect(row).toBeVisible();
  // T16: the four outcomes sit behind the card's "Settle" toggle (canvas HoldQueue).
  await row.getByTestId("external-play-settle-toggle").click();
  await row.getByTestId("external-play-resolve-draw").click();
  await expect(page.getByTestId(`external-play-queue-row-${fx.fixtureId}`)).toHaveCount(0, {
    timeout: 20_000,
  });

  const state = await apiJson<{ status: string; outcome: { kind?: string } | null }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status).toBe(200);
  expect(state.data?.status).toBe("decided");
  expect(state.data?.outcome).toMatchObject({ kind: "draw" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 17 — the venue, end to end, on the local fixture servers.
// ─────────────────────────────────────────────────────────────────────────────

/** A curated control nobody has played LIVE yet (controller addendum 2: 3+0,
 *  10+5, 10+0 and 15+0 were): 5+3 — Lichess's estimate 300 + 40 x 3 = 420 s,
 *  blitz, so the Board API plays it (M12's line is 180 s). */
const TC = { base: 300, increment: 3 } as const;
const OPENING = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"] as const;

/** The room's poll cadences, read from its source (a client module the runner
 *  cannot import), so the budget below moves when they do. */
const USE_ROOM = readFileSync(
  fileURLToPath(new URL("../../src/components/public-site/match-room/use-room.ts", import.meta.url)),
  "utf8",
);
const constant = (name: string): number => {
  const m = new RegExp(`export const ${name} = ([\\d_]+);`).exec(USE_ROOM);
  if (!m) throw new Error(`use-room.ts no longer exports ${name} as a literal`);
  return Number(m[1]!.replace(/_/g, ""));
};
const LIVE_POLL_MS = constant("LIVE_POLL_MS");
const IDLE_POLL_MS = constant("IDLE_POLL_MS");

// The budget, DERIVED (AGENTS.md failure class 20): every scripted action is a
// round trip through our server that may wait out one Lichess call, and the
// OTHER player's page learns of it on its next poll. A flat timeout beside
// those costs would report a blown clock as "expected 6 plies, received 5".
const PER_ACTION_MS = LICHESS_TIMEOUT_MS / 2 + LIVE_POLL_MS + 2_000;
const SEED_MS = 60_000;
const budget = (actions: number) => Math.max(120_000, SEED_MS + actions * PER_ACTION_MS + 2 * IDLE_POLL_MS);

const NOT_POINTED = (what: string) =>
  `the server under test made NO ${what} call to the local fixture server. It is almost certainly still pointed at ` +
  `the real service — set LICHESS_BASE_URL=http://127.0.0.1:${LICHESS_FIXTURE_PORT}, ` +
  `REALTIMEKIT_BASE_URL=http://127.0.0.1:${REALTIMEKIT_FIXTURE_PORT} and the five REALTIMEKIT_FIXTURE_ENV ` +
  `credentials on the SERVER process (docs/runbooks/e2e-local.md), not just on this runner`;

/** T17 review M3: no create call reaching the stub has a second cause the environment message would hide — the server
 *  never TRIED. So the poll's failure reads the bridge row as it stands and names the cause it shows: `token_unavailable`
 *  (measured 2026-10-13 with the runner on another LICHESS_TOKEN_KEK: the server cannot open the tokens this runner
 *  sealed), or a hold; only a clean row is blamed on where the server points. */
async function expectLichessReached(calls: () => number, fixtureId: string, timeout: number): Promise<void> {
  try {
    await expect.poll(calls, { timeout }).toBeGreaterThan(0);
  } catch (e) {
    const row = await bridgeRow(fixtureId);
    const seen = row === null ? "no bridge row at all" : JSON.stringify({ status: row.status, last_error: row.last_error, needs_reason: row.needs_reason });
    const cause =
      row?.last_error === "token_unavailable"
        ? "it could not open the players' sealed Lichess tokens: the SERVER's LICHESS_TOKEN_KEK is not this runner's (docs/runbooks/e2e-local.md, step 5)"
        : row?.needs_reason
          ? `the product held the board (needs_reason ${row.needs_reason})`
          : row?.last_error
            ? `its create failed before reaching Lichess (last_error ${row.last_error})`
            : null;
    const why = cause === null ? NOT_POINTED("Lichess") : `the server under test made NO Lichess call because it never tried — ${cause}`;
    throw new Error(`${why}. The bridge row reads ${seen}.\n${(e as Error).message}`);
  }
}

/** T17 review M5: the bridge row and the stub hold the same clocks, both as at the last move, each stamped on its own
 *  side of one local HTTP hop. A charged move's elapsed time differs by at most the difference of two such hops, and
 *  each side has paid two moves by ply 6 — 2.5 s covers that under load, and stays under the 3 s increment, so a lost
 *  increment or a centisecond/millisecond slip (x10) still reds. Measured 2026-10-13: 0-10 ms apart over three runs (the
 *  pages' reads re-take Lichess's clocks, T11). */
const CLOCK_TOLERANCE_MS = 2_500;

const CRON = () => ({ "x-cron-secret": process.env.CRON_SECRET ?? "" });

type SweepReport = { skipped: boolean; reconciled: number; noShows: number; failures: unknown[] };

/** One pass of the 5-minute cron, as the cron repo fires it. A pass that
 *  found another holding the lock did NOTHING (`skipped`), so it is retried,
 *  never counted as a pass that looked. */
async function sweep(page: Page): Promise<SweepReport> {
  for (let i = 0; i < 10; i++) {
    const res = await page.request.post("/api/cron/external-play", { headers: CRON() });
    expect(res.status(), "CRON_SECRET must be the server's (docs/runbooks/e2e-local.md)").toBe(200);
    const report = ((await res.json()) as { data: SweepReport }).data;
    if (!report.skipped) return report;
    await page.waitForTimeout(1_000);
  }
  throw new Error("the sweep's lock was held for 10 s: another pass never finished");
}

/** The cron fires every five minutes and re-reads a board at most once a
 *  tick, backing off to hourly for a board that tells it nothing
 *  (sweep.ts reReadAfterMs). A test cannot wait a tick, so it ages the
 *  board's last read past the longest of those waits — "nobody has looked
 *  for an hour" — and the next pass reads it as the cron's would. */
async function nobodyReadItForAnHour(fixtureId: string): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      update fixture_external_play set last_polled_at = now() - interval '61 minutes' where fixture_id = ${fixtureId}`;
    if (res.count !== 1) throw new Error(`no bridge row to age for ${fixtureId}`);
  });
}

test.describe("online chess on our page — the venue, end to end (Task 17)", () => {
  test.describe.configure({ mode: "serial" });
  let lichess: LichessFixtureServer;
  let video: RealtimeKitFixtureServer;
  let round: SeededRound;
  const contexts: BrowserContext[] = [];
  /** Every off-machine host a player's browser tried, and was refused. */
  const blocked = new Set<string>();

  test.beforeAll(async () => {
    lichess = await startLichessFixtureServer();
    video = await startRealtimeKitFixtureServer();
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await lichess?.close();
    await video?.close();
  });

  /** A player's browser: no session (the invite link is the identity), a
   *  camera grant, and NOTHING reachable but the app. */
  async function playerContext(browser: Browser): Promise<BrowserContext> {
    const base = test.info().project.use.baseURL!;
    const app = new URL(base).host;
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: base, permissions: ["camera"] });
    // The site's cookie notice, answered as a player answers it on arrival —
    // otherwise it sits over the board's bottom-left squares (g8 from Black's
    // side) and swallows the tap.
    await ctx.addInitScript(
      (a: { k: string; vk: string; v: string }) => {
        try {
          window.localStorage.setItem(a.k, "rejected");
          window.localStorage.setItem(a.vk, a.v);
        } catch {
          // storage refused: the notice shows; tapMove's hit test says so
        }
      },
      { k: CONSENT_KEY, vk: CONSENT_VERSION_KEY, v: COOKIE_POLICY_VERSION },
    );
    await ctx.route(
      (u) => u.host !== app,
      (r) => {
        blocked.add(new URL(r.request().url()).host);
        return r.abort("internetdisconnected");
      },
    );
    await ctx.routeWebSocket(
      (u) => u.host !== app,
      (ws) => {
        blocked.add(`ws:${new URL(ws.url()).host}`);
        return ws.close();
      },
    );
    contexts.push(ctx);
    return ctx;
  }

  async function openRoom(ctx: BrowserContext, board: RoundBoard, player: RoundPlayer, width = 1280): Promise<Page> {
    const page = await ctx.newPage();
    await page.setViewportSize({ width, height: 900 });
    const res = await page.goto(await matchRoomPathBySql(board.fixtureId, player.personId));
    expect(res?.status(), "the room renders").toBe(200);
    await expect(page.getByTestId("match-room")).toBeVisible();
    return page;
  }

  const screen = (page: Page) => page.getByTestId("match-room");

  // The cron sweep is GLOBAL — it reads every game on file, in every org —
  // so a Lichess call made for another spec's board is not this board's. A
  // call FOR these players carries one of their tokens (sealed by this spec)
  // or names one of their accounts.
  const lichessCallsFor = (players: RoundPlayer[]) =>
    lichess.calls.filter((c) =>
      players.some((p) => (p.lichessToken !== null && c.token === p.lichessToken) || c.path.includes(p.lichessId)),
    );
  /** Meetings and participants on file for a board, and participants minted
   *  at the video fixture for its players — every trace a video call leaves. */
  async function videoTracesFor(board: RoundBoard): Promise<number> {
    const [row] = await withDb(
      (sql) => sql<{ n: number }[]>`
        select ((select count(*) from fixture_video_meetings where fixture_id = ${board.fixtureId})
              + (select count(*) from fixture_video_participants where fixture_id = ${board.fixtureId}))::int as n`,
    );
    const minted = [board.home, board.away].filter((p) => video.participantFor(p.personId) !== null).length;
    return row!.n + minted;
  }
  const participantOf = (p: RoundPlayer) => {
    const rec = video.participantFor(p.personId);
    if (!rec) throw new Error(`no RealtimeKit participant was minted for ${p.name}`);
    return rec.id;
  };

  async function claimByLink(page: Page, board: RoundBoard, p: RoundPlayer) {
    const path = await matchRoomPathBySql(board.fixtureId, p.personId);
    const t = new URL(path, "http://x").searchParams.get("t")!;
    const res = await page.request.post(`/api/v1/fixtures/${board.fixtureId}/external-play/room?t=${encodeURIComponent(t)}`);
    expect(res.status(), `claim for ${p.name}`).toBe(200);
    return ((await res.json()) as { data: { seat: { seated: boolean; reason?: string } | null } }).data;
  }

  async function actByLink(page: Page, board: RoundBoard, p: RoundPlayer, body: unknown) {
    const path = await matchRoomPathBySql(board.fixtureId, p.personId);
    const t = new URL(path, "http://x").searchParams.get("t")!;
    const res = await page.request.post(`/api/v1/fixtures/${board.fixtureId}/external-play/room/act?t=${encodeURIComponent(t)}`, { data: body });
    expect(res.status(), `act ${JSON.stringify(body)} for ${p.name}`).toBe(200);
    return ((await res.json()) as { data: { ok: boolean } }).data;
  }

  /** Which seat of a board plays White — recorded on the game (T9). */
  async function colours(board: RoundBoard): Promise<{ white: RoundPlayer; black: RoundPlayer }> {
    const side = await withDb(async (sql) => {
      const [r] = await sql<{ white_side: "home" | "away" | null }[]>`
        select white_side from fixture_external_play where fixture_id = ${board.fixtureId}`;
      return r?.white_side ?? null;
    });
    if (side === null) throw new Error(`no colours recorded for ${board.fixtureId}`);
    return side === "home" ? { white: board.home, black: board.away } : { white: board.away, black: board.home };
  }

  async function fixtureState(page: Page, fixtureId: string) {
    const s = await apiJson<{ status: string; outcome: unknown }>(page.request, `/api/v1/fixtures/${fixtureId}/state`);
    expect(s.status).toBe(200);
    return s.data!;
  }

  async function lastResultWinner(fixtureId: string): Promise<string | null> {
    return withDb(async (sql) => {
      const [r] = await sql<{ winner: string | null }[]>`
        select payload->>'winner' as winner from score_events
         where fixture_id = ${fixtureId} and type = 'boardgame.result' order by seq desc limit 1`;
      return r?.winner ?? null;
    });
  }

  test("D12: a round PAIRED but never OPENED, long past its scheduled time, seats nobody and forfeits nobody", async ({ page, browser, request }) => {
    test.setTimeout(budget(2));
    const r = await seedOnlineRound(request, [`Una Opened ${TAG}`, `Vic Unopened ${TAG}`], {
      open: false,
      camera: "required",
      playable: true,
      clock: TC,
    });
    const board = r.boards[0]!;
    // Past BOTH the T-10 lead and the T+20 deadline: a window anchored on
    // scheduled_at instead of the open would read "closed, nobody came".
    const longPast = new Date(Date.now() - (WINDOW_OPEN_LEAD_MS + DEADLINE_AFTER_MS + 60_000)).toISOString();
    await setFixtureScheduledAtSql(board.fixtureId, longPast);
    expect(await roundOpenedAtSql(r.stageId, 1), "premise: paired, NOT opened").toBeNull();
    // No invite exists for an unopened round, so there is no link to mint.
    await expect(matchRoomPathBySql(board.fixtureId, board.home.personId)).rejects.toThrow(/not opened/);
    for (const p of [board.home, board.away]) lichess.registerToken(p.lichessToken!, p.lichessId);

    // The player signed in (the session entry) finds the room shut, says why,
    // and offers no check-in.
    const ctx = await playerContext(browser);
    const p = await ctx.newPage();
    const roomPath = routes.sharedFixturePlay(r.slugs.org, r.slugs.comp, r.slugs.div, board.fixtureId);
    await loginUi(p, board.home.email, roomPath);
    await p.goto(roomPath);
    await expect(screen(p)).toHaveAttribute("data-screen", "notOpened", { timeout: 20_000 });
    await expect(p.getByTestId("room-state-not-opened")).toBeVisible();
    await expect(p.getByTestId("room-checkin-cta")).toHaveCount(0);
    // And the seat itself, asked for directly, is refused for the same reason.
    const claim = await p.request.post(`/api/v1/fixtures/${board.fixtureId}/external-play/room`);
    expect(claim.status()).toBe(200);
    expect(((await claim.json()) as { data: { seat: { reason?: string } | null } }).data.seat).toMatchObject({ seated: false, reason: "round_not_open" });

    // The sweep — the thing that would mark a field absent — forfeits nobody.
    await sweep(page);
    expect(
      await forfeitEventCountSql(board.fixtureId),
      "the sweep forfeited a board whose round was never opened — it is anchoring on scheduled_at, not the open",
    ).toBe(0);
    const bridge = await bridgeRow(board.fixtureId);
    expect(bridge?.challenge_id ?? null, "no game was asked for").toBeNull();
    expect(bridge?.create_sent_at ?? null, "no create was sent").toBeNull();
    const sent = lichessCallsFor([board.home, board.away]);
    expect(sent.map((c) => `${c.method} ${c.path}`), "nothing reached Lichess for this board").toEqual([]);
    expect(await videoTracesFor(board), "nothing reached the video service for this board").toBe(0);
    await ctx.close();
  });

  test("the organiser opens Swiss round 1 from the run sheet: the stamp and the invites, and nothing reaches Lichess or video yet", async ({ page, request }) => {
    test.setTimeout(budget(2));
    round = await seedOnlineRound(request, [`Ada White ${TAG}`, `Bo Black ${TAG}`, `Cy Third ${TAG}`, `Di Fourth ${TAG}`], {
      open: false,
      camera: "required",
      stage: "swiss",
      playable: true,
      clock: TC,
    });
    expect(round.boards, "four players pair into two boards").toHaveLength(2);
    for (const b of round.boards) {
      for (const p of [b.home, b.away]) lichess.registerToken(p.lichessToken!, p.lichessId);
    }
    expect(await roundOpenedAtSql(round.stageId, 1), "the empty case: nothing opened").toBeNull();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(round.fixturesTab);
    const control = page.getByTestId("open-round").filter({ has: page.getByRole("heading", { name: fill("runsheet.round.heading", { round: 1 }) }) });
    await expect(control).toHaveAttribute("data-state", "paired", { timeout: 30_000 });
    await control.getByTestId("open-round-cta").click();
    await page.getByTestId("open-round-confirm-confirm").click();
    await expect(control.getByTestId("open-round-notice")).toBeVisible({ timeout: 20_000 });

    const stamp = await roundOpenedAtSql(round.stageId, 1);
    expect(stamp, "the open stamped stage_round_opens").not.toBeNull();
    let rows = 0;
    for (const b of round.boards) {
      expect(await bridgeRow(b.fixtureId), "a bridge row per board, waiting for its players").toMatchObject({
        status: "pending",
        challenge_id: null,
      });
      rows++;
    }
    expect(rows).toBe(2);
    // D12 couples the stamp and the invites — and nothing else. A game is asked
    // for only when both players are seated; a meeting only when one arrives.
    const everyone = round.boards.flatMap((b) => [b.home, b.away]);
    expect(lichessCallsFor(everyone).length, "opening a round makes no Lichess call").toBe(0);
    let traces = 0;
    for (const b of round.boards) traces += await videoTracesFor(b);
    expect(traces, "opening a round makes no video call").toBe(0);
  });

  test("final review P10: a grant narrowed AT LICHESS shows the re-link screen as the room loads — asked once per load, never by the polls", async ({ browser }) => {
    test.setTimeout(budget(3));
    // Board 2's first player: board 1's seating test, next, is left exactly as it was. Nobody here checks in.
    const b = round.boards[1]!;
    const p = b.home;
    const token = p.lichessToken!;
    /** Lichess's token test asked about THIS player's token (lila: no auth, the token in the body). */
    const asked = () => lichess.calls.filter((c) => c.method === "POST" && c.path === "/api/token/test" && Object.hasOwn(c.body, token)).length;
    const before = asked();
    lichess.setTokenScopes(token, ["challenge:read"]); // narrowed at lichess.org: no play scope left
    const ctx = await playerContext(browser);
    const page = await openRoom(ctx, b, p);
    await expect(screen(page), "Lichess's word, at once — no act was needed").toHaveAttribute("data-screen", "relink", { timeout: 30_000 });
    await expect(page.getByTestId("room-state-relink")).toBeVisible();
    expect(asked() - before, "asked once, for the load").toBe(1);
    const shots = process.env.ROOM_SHOTS_DIR;
    if (shots) {
      for (const width of [320, 768, 1280]) {
        await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 768 ? 1024 : 700 });
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${shots}/p10-relink-on-load-${width}.png`, fullPage: true, caret: "initial" });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    // The room's own read does not ask again: the answer is the page load's.
    await page.waitForResponse((r) => r.request().method() === "GET" && /\/external-play\/room$/.test(new URL(r.url()).pathname), { timeout: IDLE_POLL_MS + 10_000 });
    await expect(screen(page)).toHaveAttribute("data-screen", "relink");
    expect(asked() - before, "the poll asked Lichess nothing").toBe(1);
    // The grant back at Lichess: the next load asks again, and the room is the check-in.
    lichess.setTokenScopes(token, ["board:play", "challenge:write", "challenge:read"]);
    await page.reload();
    await expect(screen(page)).toHaveAttribute("data-screen", "checkin", { timeout: 30_000 });
    expect(asked() - before, "a reload is a new load").toBe(2);
    expect(await checkedInAt(b.fixtureId, p.personId), "nobody was seated").toBeNull();
    await ctx.close();
  });

  let white: Page;
  let black: Page;
  let boardA: RoundBoard;
  let A: { white: RoundPlayer; black: RoundPlayer };
  let gameA: string;

  test("board 1 seats only on the SERVER's word: camera required (2), lost (3), video down (4) — then both in, and the game made at Lichess", async ({ browser }) => {
    test.setTimeout(budget(10));
    boardA = round.boards[0]!;
    // Colours are recorded at creation (T9), so the players are first and
    // second here, White and Black only once the game exists.
    const first = boardA.home;
    const second = boardA.away;

    // ── state 2: required, nobody live ────────────────────────────────────
    const ctx1 = await playerContext(browser);
    const p1 = await openRoom(ctx1, boardA, first);
    await expect(screen(p1)).toHaveAttribute("data-screen", "checkin");
    await passCameraTest(p1);
    await p1.getByTestId("room-checkin-cta").click();
    await expect.poll(() => video.participantFor(first.personId) !== null, { message: NOT_POINTED("RealtimeKit"), timeout: 20_000 }).toBe(true);
    await expect(screen(p1), "the meeting reports nobody: the seat is refused").toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    await expect(p1.getByTestId("room-state-camera-required")).toBeVisible();
    // The server made the player's OWN meeting (D16, §5.6.1: one per player) and their participant. The claim that MINTS a
    // participant reads nothing - nobody can have joined with a token that did not exist yet (D21-fix-3, §5.6.8) - so the
    // refusal is the server's own word, and the READ is the retry's (asserted below).
    const asked = video.calls.map((c) => c.route);
    expect(asked.filter((r) => r === "POST /meetings"), "the first player's claim makes ONE meeting - theirs").toHaveLength(1);
    expect(asked).toContain("POST /meetings/:id/participants");
    expect(asked, "a minting claim reads no session").not.toContain("GET /meetings/:id/active-session");
    expect(await checkedInAt(boardA.fixtureId, first.personId), "a refused seat stamps nothing").toBeNull();
    expect(lichessCallsFor([first, second]).length, "one seat asks Lichess for nothing").toBe(0);

    // The meeting now reports them present; Try again re-asks, and seats.
    video.setLivePublisher(participantOf(first), true);
    const beforeRetry = video.calls.length;
    await p1.getByTestId("room-state-retry").click();
    await expect(screen(p1)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    await expect(p1.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
    expect(await checkedInAt(boardA.fixtureId, first.personId), "seated on the meeting's word").not.toBeNull();
    // M6: the seat came from a FRESH presence read, made after the press — not from the refusal's earlier answer.
    const reAsked = video.calls.slice(beforeRetry).map((c) => c.route);
    expect(reAsked, "Try again re-read the meeting's session").toContain("GET /meetings/:id/active-session");
    expect(reAsked, "and who is in it").toContain("GET /sessions/:id/participants");

    // ── state 3: was live, is not — a reload re-asks ──────────────────────
    video.setLivePublisher(participantOf(first), false);
    await p1.reload();
    await expect(screen(p1), "a player who HAD passed is told the camera was lost").toHaveAttribute("data-screen", "cameraLost", { timeout: 30_000 });
    await expect(p1.getByTestId("room-state-camera-lost")).toBeVisible();
    video.setLivePublisher(participantOf(first), true);
    await p1.getByTestId("room-state-retry").click();
    await expect(screen(p1)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });

    // ── state 4: the video service is down — never "camera off" ───────────
    video.setUnavailable(true);
    const ctx2 = await playerContext(browser);
    const p2 = await openRoom(ctx2, boardA, second);
    await passCameraTest(p2);
    await p2.getByTestId("room-checkin-cta").click();
    await expect(screen(p2)).toHaveAttribute("data-screen", "videoDown", { timeout: 30_000 });
    await expect(p2.getByTestId("room-state-video-down")).toBeVisible();
    expect(lichessCallsFor([first, second]).length, "nothing is created while a seat is refused").toBe(0);
    video.setUnavailable(false);
    await p2.getByTestId("room-state-retry").click();
    await expect(screen(p2), "back up: the camera is asked for, not assumed").toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    video.setLivePublisher(participantOf(second), true);
    await p2.getByTestId("room-state-retry").click();

    // ── both seated: OUR server makes the game at Lichess ─────────────────
    await expectLichessReached(() => lichessCallsFor([first, second]).length, boardA.fixtureId, 30_000);
    await expect.poll(async () => (await bridgeRow(boardA.fixtureId))?.challenge_id ?? null, { timeout: 30_000 }).not.toBeNull();
    gameA = (await bridgeRow(boardA.fixtureId))!.challenge_id!;
    A = await colours(boardA);
    const challenges = lichessCallsFor([first, second]).filter((c) => c.method === "POST" && c.path.startsWith("/api/challenge/"));
    expect(challenges.map((c) => c.path), "one challenge, one accept").toEqual([`/api/challenge/${A.black.lichessId}`, `/api/challenge/${gameA}/accept`]);
    // White's token challenges Black's account; Black's token accepts — each
    // the token THIS spec sealed for that player, opened by the server.
    expect(challenges[0]!.token).toBe(A.white.lichessToken);
    expect(challenges[1]!.token).toBe(A.black.lichessToken);
    // The clock this spec chose, as Lichess was asked for it.
    expect(challenges[0]!.body).toMatchObject({ "clock.limit": String(TC.base), "clock.increment": String(TC.increment), rated: "false" });
    expect(lichess.game(gameA)).toMatchObject({ status: "started", white: A.white.lichessId, black: A.black.lichessId });

    white = A.white === first ? p1 : p2;
    black = A.white === first ? p2 : p1;
    for (const pg of [white, black]) {
      await expect(screen(pg)).toHaveAttribute("data-screen", "live", { timeout: IDLE_POLL_MS + 10_000 });
    }
  });

  test("six moves tapped on OUR board reach Lichess exactly as played, both boards agree, and the camera-off banner (9) stays up", async () => {
    test.setTimeout(budget(OPENING.length + 2));
    const rules = new Chess();
    const faceSecs = (text: string | null): number => {
      const m = /(\d+):(\d\d)(?:\.(\d))?/.exec(text ?? "");
      if (!m) throw new Error(`no clock face in "${text}"`);
      return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
    };
    // T17B fix 2, D24: my own clock RUNS again as soon as the server has answered my move and the opponent has replied
    // — the increment I was shown at the drop is no longer pinned (it would be, for up to its 10 s, if the guess were
    // not retired by the ply the answer brings). Two readings a little over a second apart must differ.
    let runningChecked = 0;
    const expectOwnClockRuns = async (pg: Page, plies: number) => {
      const face = pg.getByTestId("room-clock-you").locator("span.font-display");
      const a = faceSecs(await face.textContent());
      await pg.waitForTimeout(1_250);
      const b = faceSecs(await face.textContent());
      expect(b, `after ${plies} plies my clock runs: ${a} then ${b}`).toBeLessThan(a);
      runningChecked += 1;
    };
    for (const [i, uci] of OPENING.entries()) {
      const mover = i % 2 === 0 ? white : black;
      const orientation = i % 2 === 0 ? "white" : "black";
      await expect(mover.getByTestId("room-board")).toHaveAttribute("data-ply", String(i), { timeout: LIVE_POLL_MS + 10_000 });
      await boardPainted(mover);
      if (i >= 2) await expectOwnClockRuns(mover, i);
      await tapMove(mover, uci, orientation);
      rules.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
      // What Lichess was sent is what was played, in order.
      await expect.poll(() => lichess.game(gameA)?.movesUci ?? [], { timeout: LICHESS_TIMEOUT_MS }).toEqual(OPENING.slice(0, i + 1));
      await expect.poll(async () => (await bridgeRow(boardA.fixtureId))?.move_count, { timeout: LICHESS_TIMEOUT_MS }).toBe(i + 1);
    }
    // M5: the clocks our ledger holds are Lichess's (the stub's), as at the
    // last move, both sides — White to move after six plies.
    const atLichess = lichess.game(gameA)!;
    const ours = (await bridgeRow(boardA.fixtureId))!;
    expect(ours.move_count, "premise: the ledger holds all six").toBe(OPENING.length);
    let clocksChecked = 0;
    for (const side of ["white", "black"] as const) {
      const mine = side === "white" ? ours.white_ms : ours.black_ms;
      expect(mine, `${side}: a clock on the ledger`).not.toBeNull();
      // From the rulebook: two charged moves each earned the increment, so
      // nobody holds more than the base plus two increments.
      expect(atLichess.clockMs[side]).toBeLessThanOrEqual((TC.base + 2 * TC.increment) * 1000);
      expect(Math.abs(mine! - atLichess.clockMs[side]), `${side}: ours ${mine} vs Lichess ${atLichess.clockMs[side]}`).toBeLessThanOrEqual(CLOCK_TOLERANCE_MS);
      clocksChecked += 1;
    }
    expect(clocksChecked, "anti-vacuity: both clocks").toBe(2);
    test.info().annotations.push({
      type: "clocks-after-six",
      description: `ours ${ours.white_ms}/${ours.black_ms} vs Lichess ${atLichess.clockMs.white}/${atLichess.clockMs.black}`,
    });

    // Placement, side to move and castling rights, from the rules — the move
    // counters are bookkeeping two correct writers may disagree on.
    const position = rules.fen().split(" ").slice(0, 3).join(" ");
    for (const pg of [white, black]) {
      await expect(pg.getByTestId("room-board")).toHaveAttribute("data-ply", String(OPENING.length), { timeout: LIVE_POLL_MS + 10_000 });
      const fen = await pg.getByTestId("room-board-surface").getAttribute("data-fen");
      expect(fen?.split(" ").slice(0, 3).join(" ")).toBe(position);
      // State 9: the camera duty stands and this browser's camera never came
      // up (the SDK's join is refused at the browser's edge) — the banner sits
      // ON the live board, never instead of it.
      await expect(pg.getByTestId("room-camera-off")).toBeVisible();
    }
    // T17B fix 2, D24: after six plies White is to move, so BLACK's clock stands still — and what BOTH pages paint for
    // it is the ledger's number. The increment each page showed at the drop of its own moves (the optimistic add) is
    // gone, not added to: the face reads the ledger's black_ms within a second, never that plus the increment.
    const blackLedger = (await bridgeRow(boardA.fixtureId))!.black_ms! / 1000;
    let faces = 0;
    for (const [pg, bar] of [
      [white, "room-clock-opponent"],
      [black, "room-clock-you"],
    ] as const) {
      const seen = faceSecs(await pg.getByTestId(bar).locator("span.font-display").textContent());
      expect(Math.abs(seen - blackLedger), `${bar}: the page paints the ledger's ${blackLedger} s for Black, not ${seen}`).toBeLessThanOrEqual(1.5);
      expect(seen, `${bar}: never more than the base plus the increments Black earned (2)`).toBeLessThanOrEqual(TC.base + 2 * TC.increment);
      faces += 1;
    }
    expect(faces, "anti-vacuity: both pages").toBe(2);
    expect(runningChecked, "anti-vacuity: every turn from ply 2 on (the movers at plies 2..5)").toBe(OPENING.length - 2);
    // Whatever the pages tried to reach off the machine (and were refused),
    // on the record — measured 2026-10-13: nothing (see the file header).
    test.info().annotations.push({ type: "blocked-hosts", description: [...blocked].join(", ") || "none" });
  });

  test("White resigns: Lichess's resign IS the result — Black wins, nothing is forfeited, written once", async ({ page }) => {
    test.setTimeout(budget(3));
    await white.getByTestId("room-resign").click();
    await white.getByTestId("room-resign-confirm-confirm").click();
    await expect.poll(() => lichess.game(gameA)?.status, { timeout: LICHESS_TIMEOUT_MS }).toBe("resign");
    expect(lichess.game(gameA)?.winner, "M9's late branch: two plies and more is a resign").toBe("black");
    await expect.poll(async () => (await fixtureState(page, boardA.fixtureId)).status, { timeout: 30_000 }).toBe("decided");
    expect(await lastResultWinner(boardA.fixtureId), "the winner is Black's entrant").toBe(A.black.entrantId);
    expect(await forfeitEventCountSql(boardA.fixtureId), "a resign was written as a forfeit").toBe(0);
    expect(await resultEventCountSql(boardA.fixtureId)).toBe(1);
    for (const pg of [white, black]) {
      await expect(screen(pg)).toHaveAttribute("data-screen", "over", { timeout: IDLE_POLL_MS + 10_000 });
    }
  });

  test("a live game nobody is watching is closed by the cron sweep — its own held read is the one Lichess flags it on (D11)", async ({ page }) => {
    test.setTimeout(budget(8));
    const boardB = round.boards[1]!;
    // Round 2 cannot pair while a round-1 board is unresolved: the organiser's
    // Generate is refused now (and board 1 is decided), so a pairing that ran
    // early cannot hide behind the later assertions.
    const early = await apiJson(page.request, `/api/v1/stages/${round.stageId}/generate`, "POST", {});
    // T17 review M2: the refusal is the engine's, by name — a 401, 403 or 500 is not "round 2 cannot pair yet".
    expect({ status: early.status, code: early.error?.code }, `generate with board 2 open: ${JSON.stringify(early.error)}`).toEqual({
      status: 422,
      code: "STAGE_NOT_READY",
    });

    // Both seated through the room's own claim, the camera on the meeting's
    // word (the UI half of this was board 1's), then two plies on the board.
    for (const p of [boardB.home, boardB.away]) {
      expect((await claimByLink(page, boardB, p)).seat).toMatchObject({ seated: false, reason: "camera_required" });
      video.setLivePublisher(participantOf(p), true);
      await claimByLink(page, boardB, p);
    }
    await expect.poll(async () => (await bridgeRow(boardB.fixtureId))?.challenge_id ?? null, { timeout: 30_000 }).not.toBeNull();
    const gameB = (await bridgeRow(boardB.fixtureId))!.challenge_id!;
    const B = await colours(boardB);
    expect(await actByLink(page, boardB, B.white, { kind: "move", uci: "d2d4" })).toMatchObject({ ok: true });
    expect(await actByLink(page, boardB, B.black, { kind: "move", uci: "d7d5" })).toMatchObject({ ok: true });
    expect(lichess.game(gameB)?.movesUci).toEqual(["d2d4", "d7d5"]);

    // Nobody is watching: no page is open on this board, so no poll, clock
    // tick or move can fire a reconcile — the sweep is the only trigger left.
    // White is to move and White's clock runs out at Lichess.
    lichess.expireClock(gameB);

    await nobodyReadItForAnHour(boardB.fixtureId);
    const s1 = await sweep(page);
    expect(s1.reconciled, "the pass read the board").toBeGreaterThanOrEqual(1);
    // M8 (spec §5.2): board 1's game ended at its resign, so this pass took its
    // rooms down — deactivated at RealtimeKit, then stamped. D16 (§5.6.1): a room PER PLAYER, so both of them.
    const meetingsA = await withDb((sql) => sql<{ side: string; meeting_id: string; ended_at: Date | null }[]>`
      select side, meeting_id, ended_at from fixture_video_meetings where fixture_id = ${boardA.fixtureId} order by side`);
    expect(meetingsA.map((m) => m.side), "board 1 had a meeting for each player").toEqual(["away", "home"]);
    expect(new Set(meetingsA.map((m) => m.meeting_id)).size, "and they are two different meetings at the vendor").toBe(2);
    for (const m of meetingsA) {
      expect(video.meetingStatus(m.meeting_id), `board 1's ${m.side} room is closed at RealtimeKit`).toBe("INACTIVE");
      expect(m.ended_at, `and ${m.side}'s stamped ended`).not.toBeNull();
    }
    // T17B fix 2, D11: the first read after expiry says `started`, White at 0
    // — and a first-line read never flags it (lila flags from an OPEN stream's
    // check, 7 s in; the fixture server models that, FLAG_CHECK_MS). So the
    // sweep reads once more on a HELD stream, and Lichess flags it there. We
    // declare no flag from our own arithmetic: the result is Lichess's.
    expect(lichess.game(gameB)?.status, "Lichess flagged it on the held read").toBe("outoftime");
    expect((await fixtureState(page, boardB.fixtureId)).status, "decided on the sweep's own settling read").toBe("decided");
    expect(await lastResultWinner(boardB.fixtureId), "out of time: the side NOT to move wins").toBe(B.black.entrantId);

    await nobodyReadItForAnHour(boardB.fixtureId);
    await sweep(page);
    expect((await fixtureState(page, boardB.fixtureId)).status, "a second sweep changes nothing").toBe("decided");
    // A Lichess timeout is a NORMAL win, not a forfeit (§3.6).
    expect(await forfeitEventCountSql(boardB.fixtureId), "a timeout was written as a forfeit").toBe(0);
    // And exactly once: a third sweep is a no-op.
    const once = await resultEventCountSql(boardB.fixtureId);
    expect(once).toBe(1);
    await nobodyReadItForAnHour(boardB.fixtureId);
    await sweep(page);
    expect(await resultEventCountSql(boardB.fixtureId), "the sweep wrote the result twice").toBe(once);
  });

  test("round 2 waits for the organiser: paired on Generate, silent until opened, then opened by the same control and played", async ({ page, browser }) => {
    test.setTimeout(budget(8));
    const stamp1 = await roundOpenedAtSql(round.stageId, 1);
    const round2 = () =>
      withDb((sql) => sql<{ id: string; home: string | null; away: string | null }[]>`
        select id, home_entrant_id as home, away_entrant_id as away from fixtures
         where stage_id = ${round.stageId} and round_no = 2 order by seq_in_round`);
    // A Swiss round is NOT paired by the last result of the round before: it
    // waits for the organiser's Generate (swiss STAGE_NOT_READY until then).
    const seated2 = <R extends { home: string | null; away: string | null }>(rows: R[]) => rows.filter((f) => f.home !== null && f.away !== null);
    expect(seated2(await round2()), "round 2 paired itself").toHaveLength(0);

    const everyone = round.boards.flatMap((b) => [b.home, b.away]);
    const callsBefore = lichessCallsFor(everyone).length;
    const paired = await apiJson(page.request, `/api/v1/stages/${round.stageId}/generate`, "POST", {});
    expect(paired.status, `generate round 2: ${JSON.stringify(paired.error)}`).toBeLessThan(300);
    const boards2 = seated2(await round2());
    expect(boards2.length, "four players pair into two round-2 boards").toBe(2);
    // Paired is not opened: no stamp, no invite, no call — each alone could
    // be satisfied by the other being broken.
    expect(await roundOpenedAtSql(round.stageId, 2)).toBeNull();
    for (const f of boards2) expect(await bridgeRow(f.id), `no bridge for ${f.id} before the open`).toBeNull();
    expect(lichessCallsFor(everyone).length - callsBefore, "pairing round 2 called Lichess for its players").toBe(0);
    for (const f of boards2) {
      const [v] = await withDb((sql) => sql<{ n: number }[]>`
        select (select count(*) from fixture_video_meetings where fixture_id = ${f.id})::int as n`);
      expect(v!.n, `pairing round 2 made a meeting for ${f.id}`).toBe(0);
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(round.fixturesTab);
    const control = page.getByTestId("open-round").filter({ has: page.getByRole("heading", { name: fill("runsheet.round.heading", { round: 2 }) }) });
    await expect(control).toHaveAttribute("data-state", "paired", { timeout: 30_000 });
    await control.getByTestId("open-round-cta").click();
    await page.getByTestId("open-round-confirm-confirm").click();
    await expect(control.getByTestId("open-round-notice")).toBeVisible({ timeout: 20_000 });
    const stamp2 = await roundOpenedAtSql(round.stageId, 2);
    expect(stamp2, "round 2 opened").not.toBeNull();
    expect(stamp2!.getTime(), "a NEW stamp, after round 1's").toBeGreaterThan(stamp1!.getTime());
    for (const f of boards2) expect(await bridgeRow(f.id)).toMatchObject({ status: "pending" });

    // Both halves wired to each other: round 2's first board is played — its
    // two players seat on the meeting's word and the game is made.
    const players = new Map(round.boards.flatMap((b) => [b.home, b.away]).map((p) => [p.entrantId, p]));
    const b2: RoundBoard = { fixtureId: boards2[0]!.id, home: players.get(boards2[0]!.home!)!, away: players.get(boards2[0]!.away!)! };
    const ctx = await playerContext(browser);
    const p = await openRoom(ctx, b2, b2.home);
    await passCameraTest(p);
    await p.getByTestId("room-checkin-cta").click();
    await expect(screen(p)).toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    video.setLivePublisher(participantOf(b2.home), true);
    await p.getByTestId("room-state-retry").click();
    await expect(screen(p)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    expect((await claimByLink(page, b2, b2.away)).seat).toMatchObject({ seated: false, reason: "camera_required" });
    video.setLivePublisher(participantOf(b2.away), true);
    await claimByLink(page, b2, b2.away);
    await expect.poll(async () => (await bridgeRow(b2.fixtureId))?.challenge_id ?? null, { timeout: 30_000 }).not.toBeNull();
    const game2 = (await bridgeRow(b2.fixtureId))!.challenge_id!;
    expect(lichess.game(game2)?.status, "round 2's game is live at Lichess").toBe("started");
    await expect(screen(p)).toHaveAttribute("data-screen", "live", { timeout: IDLE_POLL_MS + 10_000 });
  });

  test("N-2: a re-paired board's newcomer checks in to a FRESH meeting — unpaired, the old room closed by the sweep, re-paired, re-opened", async ({ page, browser, request }) => {
    test.setTimeout(budget(8));
    // Its own Swiss round: round 1 above carries games, and Unpair refuses a round with a game on file.
    const r = await seedOnlineRound(request, [`Ed Repair ${TAG}`, `Flo Repair ${TAG}`, `Gus Repair ${TAG}`, `Hal Repair ${TAG}`], {
      camera: "required",
      stage: "swiss",
      clock: TC,
    });
    expect(r.boards, "four players pair into two boards").toHaveLength(2);
    const people = new Map(r.boards.flatMap((b) => [b.home, b.away]).map((p) => [p.entrantId, p]));
    const pairs = () =>
      withDb((sql) => sql<{ id: string; home: string | null; away: string | null }[]>`
        select id, home_entrant_id as home, away_entrant_id as away from fixtures
         where stage_id = ${r.stageId} and round_no = 1 order by seq_in_round`);
    const meetingsOf = (fixtureId: string) =>
      withDb((sql) => sql<{ meeting_id: string; ended_at: Date | null }[]>`
        select meeting_id, ended_at from fixture_video_meetings where fixture_id = ${fixtureId}`);
    const participantsOf = async (fixtureId: string) =>
      (await withDb((sql) => sql<{ person_id: string | null }[]>`
        select person_id from fixture_video_participants where fixture_id = ${fixtureId} order by created_at, id`)).map((x) => x.person_id);

    // The first pairing: one player per board arrives. Nobody is live, so the seat is refused — but the meeting is
    // asked before the seat (board 1's seating test), so each board now has its meeting, with that player in it.
    const old = new Map<string, string>();
    for (const b of r.boards) {
      expect((await claimByLink(page, b, b.home)).seat, `${b.home.name}: premise — the seat waits on the camera`).toMatchObject({
        seated: false,
        reason: "camera_required",
      });
      const [m] = await meetingsOf(b.fixtureId);
      expect(m, `${b.fixtureId}: premise — the first pairing's meeting`).toBeDefined();
      expect(await participantsOf(b.fixtureId), `${b.fixtureId}: premise — its first player is in it`).toEqual([b.home.personId]);
      old.set(b.fixtureId, m!.meeting_id);
    }

    // The organiser unpairs the round from the run sheet.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    await page.getByTestId("stage-unpair").click();
    await expect.poll(async () => (await pairs()).filter((f) => f.home !== null || f.away !== null).length, { timeout: 30_000 }).toBe(0);

    // Nobody played, so the room closes at the round's deadline: the cron's pass ends each meeting (sweep.ts job 3,
    // "nobody played"). A test cannot wait out DEADLINE_AFTER_MS, so the round's open is aged past it — the one SQL
    // write here, as nobodyReadItForAnHour ages a read — and the REAL pass ends the meetings, at RealtimeKit too.
    await withDb(async (sql) => {
      const res = await sql`
        update stage_round_opens set opened_at = opened_at - (${DEADLINE_AFTER_MS + 2 * 60_000} * interval '1 millisecond')
         where stage_id = ${r.stageId} and round_no = 1`;
      if (res.count !== 1) throw new Error(`no open on file to age for ${r.stageId}`);
    });
    await expect
      .poll(
        async () => {
          await sweep(page);
          let ended = 0;
          for (const fixtureId of old.keys()) if ((await meetingsOf(fixtureId))[0]?.ended_at) ended++;
          return ended;
        },
        { timeout: 60_000, message: "the sweep ended both old meetings" },
      )
      .toBe(old.size);
    for (const meetingId of old.values()) expect(video.meetingStatus(meetingId), "ended at RealtimeKit, not only on file").toBe("INACTIVE");

    // Re-paired as neighbours (the seed paired top against bottom), so board 1 gets a player new to it. The pairing
    // menu's own presses are swiss-round-one-pairing.spec.ts's; this is the body its Pair next sends.
    const repaired = await apiJson(page.request, `/api/v1/stages/${r.stageId}/generate`, "POST", { pairing: "rank_adjacent" });
    expect(repaired.status, `re-pair round 1: ${JSON.stringify(repaired.error)}`).toBeLessThan(300);
    const board1 = r.boards[0]!;
    const now1 = (await pairs()).find((f) => f.id === board1.fixtureId)!;
    const wasOn1 = new Set([board1.home.entrantId, board1.away.entrantId]);
    const newcomerId = [now1.home, now1.away].find((e) => e !== null && !wasOn1.has(e));
    expect(newcomerId, "premise — the re-pair put a player new to board 1 on it").toBeDefined();
    const newcomer = people.get(newcomerId!)!;
    const reBoard1: RoundBoard = { fixtureId: board1.fixtureId, home: people.get(now1.home!)!, away: people.get(now1.away!)! };
    expect(await meetingsOf(board1.fixtureId), "premise — the old, ended meeting is still on file before the re-open").toHaveLength(1);

    // The organiser re-opens round 1 from the same control: nobody is bound to its open any more, so it offers it again.
    await page.goto(r.fixturesTab);
    const control = page.getByTestId("open-round").filter({ has: page.getByRole("heading", { name: fill("runsheet.round.heading", { round: 1 }) }) });
    await expect(control).toHaveAttribute("data-press", "reopen", { timeout: 30_000 });
    const stampBefore = await roundOpenedAtSql(r.stageId, 1);
    const mark = video.calls.length;
    await control.getByTestId("open-round-cta").click();
    await page.getByTestId("open-round-confirm-confirm").click();
    await expect(control.getByTestId("open-round-notice")).toBeVisible({ timeout: 20_000 });
    expect((await roundOpenedAtSql(r.stageId, 1))!.getTime(), "the re-open stamped a new window").toBeGreaterThan(stampBefore!.getTime());
    let gone = 0;
    for (const [fixtureId, meetingId] of old) {
      expect(await meetingsOf(fixtureId), `${fixtureId}: the old meeting's row went with the re-open`).toEqual([]);
      expect(video.calls.slice(mark).filter((c) => c.path.includes(meetingId)), "an ended meeting is not asked again").toEqual([]);
      gone++;
    }
    expect(gone).toBe(2);

    // The newcomer follows their link and checks in: the room asks for a meeting, and gets a NEW one.
    const ctx = await playerContext(browser);
    const p = await openRoom(ctx, reBoard1, newcomer);
    await expect(screen(p)).toHaveAttribute("data-screen", "checkin");
    await passCameraTest(p);
    const [claim] = await Promise.all([
      p.waitForResponse((res) => res.request().method() === "POST" && /\/external-play\/room$/.test(new URL(res.url()).pathname)),
      p.getByTestId("room-checkin-cta").click(),
    ]);
    const claimBody = await claim.text();
    expect(claim.status(), `the check-in is answered, not refused: ${claimBody.slice(0, 200)}`).toBe(200);
    expect(claimBody, "never the old meeting's end").not.toContain("VIDEO_MEETING_ENDED");
    await expect(screen(p), "nobody live yet: the seat waits on the camera").toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    const fresh = await meetingsOf(board1.fixtureId);
    expect(fresh, "one meeting on file").toHaveLength(1);
    expect(fresh[0]!.meeting_id, "a fresh meeting, never the old one").not.toBe(old.get(board1.fixtureId));
    expect(fresh[0]!.ended_at).toBeNull();
    expect(video.meetingStatus(fresh[0]!.meeting_id), "live at RealtimeKit").toBe("ACTIVE");
    const part = video.participantFor(newcomer.personId);
    expect(part?.meetingId, "the newcomer's participant is in the new meeting").toBe(fresh[0]!.meeting_id);
    expect(await participantsOf(board1.fixtureId), "only the newcomer — the old player went with the old meeting").toEqual([newcomer.personId]);

    // The meeting reports them present; Try again seats them on its word.
    video.setLivePublisher(part!.id, true);
    await p.getByTestId("room-state-retry").click();
    await expect(screen(p)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    await expect(p.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
    expect(await checkedInAt(board1.fixtureId, newcomer.personId), "seated in the new meeting").not.toBeNull();
    await ctx.close();
  });

  test("R2-2: the lobby path — re-paired with NO re-open, the newcomer signs in, takes Your board into the room and checks in to a FRESH meeting; the old room is ended and the player who moved is not in it", async ({ page, browser, request }) => {
    test.setTimeout(budget(8));
    // Its own Swiss round, for the same reason as N-2's.
    const r = await seedOnlineRound(request, [`Ida Lobby ${TAG}`, `Jo Lobby ${TAG}`, `Kai Lobby ${TAG}`, `Lu Lobby ${TAG}`], {
      camera: "required",
      stage: "swiss",
      clock: TC,
    });
    expect(r.boards, "four players pair into two boards").toHaveLength(2);
    const people = new Map(r.boards.flatMap((b) => [b.home, b.away]).map((p) => [p.entrantId, p]));
    const pairs = () =>
      withDb((sql) => sql<{ id: string; home: string | null; away: string | null }[]>`
        select id, home_entrant_id as home, away_entrant_id as away from fixtures
         where stage_id = ${r.stageId} and round_no = 1 order by seq_in_round`);
    const meetingsOf = (fixtureId: string) =>
      withDb((sql) => sql<{ meeting_id: string; ended_at: Date | null }[]>`
        select meeting_id, ended_at from fixture_video_meetings where fixture_id = ${fixtureId}`);
    const participantsOf = async (fixtureId: string) =>
      (await withDb((sql) => sql<{ person_id: string | null }[]>`
        select person_id from fixture_video_participants where fixture_id = ${fixtureId} order by created_at, id`)).map((x) => x.person_id);

    // The first pairing: both players of board 1 arrive. Nobody is live, so each seat is refused — but each is now
    // a participant in a room of their OWN (D16, §5.6.1: a meeting per player).
    const board1 = r.boards[0]!;
    for (const pl of [board1.home, board1.away]) {
      expect((await claimByLink(page, board1, pl)).seat, `${pl.name}: premise — the seat waits on the camera`).toMatchObject({
        seated: false,
        reason: "camera_required",
      });
    }
    const roomsOf = (fixtureId: string) =>
      withDb((sql) => sql<{ side: string; meeting_id: string }[]>`
        select side, meeting_id from fixture_video_meetings where fixture_id = ${fixtureId} order by side`);
    const oldRooms = await roomsOf(board1.fixtureId);
    expect(oldRooms.map((x) => x.side), "premise — a room each for the first pairing's two players").toEqual(["away", "home"]);
    expect(new Set(oldRooms.map((x) => x.meeting_id)).size, "premise — two different meetings at the vendor").toBe(2);
    expect(new Set(await participantsOf(board1.fixtureId)), "premise — both first players on file").toEqual(new Set([board1.home.personId, board1.away.personId]));
    expect(video.participantFor(board1.home.personId)?.meetingId, "premise — the home player is in the home room").toBe(oldRooms.find((x) => x.side === "home")!.meeting_id);
    expect(video.participantFor(board1.away.personId)?.meetingId, "premise — the away player is in the away room").toBe(oldRooms.find((x) => x.side === "away")!.meeting_id);

    // The organiser unpairs and re-pairs — and does NOT re-open: the round's window stands, so the lobby still says
    // "check in" to whoever the board now names.
    const stamp = await roundOpenedAtSql(r.stageId, 1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    await page.getByTestId("stage-unpair").click();
    await expect.poll(async () => (await pairs()).filter((f) => f.home !== null || f.away !== null).length, { timeout: 30_000 }).toBe(0);
    const repaired = await apiJson(page.request, `/api/v1/stages/${r.stageId}/generate`, "POST", { pairing: "rank_adjacent" });
    expect(repaired.status, `re-pair round 1: ${JSON.stringify(repaired.error)}`).toBeLessThan(300);
    expect((await roundOpenedAtSql(r.stageId, 1))!.getTime(), "premise — no re-open: the same window").toBe(stamp!.getTime());
    const now1 = (await pairs()).find((f) => f.id === board1.fixtureId)!;
    const wasOn1 = new Set([board1.home.entrantId, board1.away.entrantId]);
    const newcomer = people.get([now1.home, now1.away].find((e) => e !== null && !wasOn1.has(e))!)!;
    const stayed = [now1.home, now1.away].find((e) => e !== null && wasOn1.has(e));
    const mover = [board1.home, board1.away].find((pl) => pl.entrantId !== stayed)!;
    expect(newcomer, "premise — the re-pair put a player new to board 1 on it").toBeDefined();
    expect([now1.home, now1.away], "premise — the player who moved is no longer on board 1").not.toContain(mover.entrantId);
    for (const room of oldRooms) expect(video.meetingStatus(room.meeting_id), `premise — the old ${room.side} room is still live before anyone comes in`).toBe("ACTIVE");

    // The newcomer signs in on the public fixture page; Your board is their door.
    const ctx = await playerContext(browser);
    const p = await ctx.newPage();
    const fixturePage = publicFixturePath(r.slugs.org, r.slugs.comp, r.slugs.div, board1.fixtureId);
    await loginUi(p, newcomer.email, fixturePage);
    await p.waitForURL((u) => u.pathname === fixturePage);
    const card = p.getByTestId("your-board");
    await expect(card, "the lobby offers the check-in").toHaveAttribute("data-state", "check_in", { timeout: 30_000 });
    await card.getByTestId("your-board-link").click();
    await p.waitForURL((u) => u.pathname === routes.sharedFixturePlay(r.slugs.org, r.slugs.comp, r.slugs.div, board1.fixtureId));
    await expect(screen(p)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    await passCameraTest(p);
    const [claim] = await Promise.all([
      p.waitForResponse((res) => res.request().method() === "POST" && /\/external-play\/room$/.test(new URL(res.url()).pathname)),
      p.getByTestId("room-checkin-cta").click(),
    ]);
    const claimBody = await claim.text();
    expect(claim.status(), `the check-in is answered, not refused: ${claimBody.slice(0, 200)}`).toBe(200);
    await expect(screen(p), "nobody live yet: the seat waits on the camera").toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });

    // (a) a fresh meeting for the newcomer's own side, never an old one; (b) BOTH old rooms ended at RealtimeKit (the first pairing's
    // pair is gone, so neither room serves the new one), their rosters gone with their rows.
    const fresh = await meetingsOf(board1.fixtureId);
    expect(fresh, "one meeting on file: the newcomer's").toHaveLength(1);
    for (const room of oldRooms) {
      expect(fresh[0]!.meeting_id, "a fresh meeting, never the first pairing's").not.toBe(room.meeting_id);
      expect(video.meetingStatus(room.meeting_id), `the first pairing's ${room.side} room is ended — no old token is live in it`).toBe("INACTIVE");
    }
    expect(video.meetingStatus(fresh[0]!.meeting_id), "live at RealtimeKit").toBe("ACTIVE");
    const part = video.participantFor(newcomer.personId);
    expect(part?.meetingId, "the newcomer's participant is in the new meeting").toBe(fresh[0]!.meeting_id);
    expect(await participantsOf(board1.fixtureId), "only the newcomer — the player who moved is not in it").toEqual([newcomer.personId]);
    const moverRoom = oldRooms.find((x) => x.side === (mover.personId === board1.home.personId ? "home" : "away"))!;
    expect(video.participantFor(mover.personId)?.meetingId, "the mover's only participant is in their own ended room").toBe(moverRoom.meeting_id);

    // The meeting reports them present; Try again seats them on its word.
    video.setLivePublisher(part!.id, true);
    await p.getByTestId("room-state-retry").click();
    await expect(screen(p)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    await expect(p.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
    expect(await checkedInAt(board1.fixtureId, newcomer.personId), "seated in the new meeting").not.toBeNull();
    await ctx.close();
  });
  test("R3-1: the player who STAYED keeps their room open through the re-pair — when the newcomer's arrival retires their meeting, their page re-claims the seat on its own (no tap, no reload), lands in the NEW meeting, and the game is made under `required`", async ({ page, browser, request }) => {
    test.setTimeout(budget(10));
    // Its own Swiss round, for the same reason as N-2's; playable, so the game can really be made at the fixture.
    const names = [`Mo Stay ${TAG}`, `Ned Stay ${TAG}`, `Ola Stay ${TAG}`, `Pia Stay ${TAG}`];
    const r = await seedOnlineRound(request, names, { camera: "required", stage: "swiss", clock: TC, playable: true });
    expect(r.boards, "four players pair into two boards").toHaveLength(2);
    for (const b of r.boards) for (const pl of [b.home, b.away]) lichess.registerToken(pl.lichessToken!, pl.lichessId);
    const people = new Map(r.boards.flatMap((b) => [b.home, b.away]).map((p) => [p.entrantId, p]));
    const pairs = () =>
      withDb((sql) => sql<{ id: string; home: string | null; away: string | null }[]>`
        select id, home_entrant_id as home, away_entrant_id as away from fixtures
         where stage_id = ${r.stageId} and round_no = 1 order by seq_in_round`);
    const meetingsOf = (fixtureId: string) =>
      withDb((sql) => sql<{ meeting_id: string; ended_at: Date | null }[]>`
        select meeting_id, ended_at from fixture_video_meetings where fixture_id = ${fixtureId}`);
    const participantsOf = async (fixtureId: string) =>
      (await withDb((sql) => sql<{ person_id: string | null }[]>`
        select person_id from fixture_video_participants where fixture_id = ${fixtureId} order by created_at, id`)).map((x) => x.person_id);
    const isRoom = (u: string) => /\/external-play\/room$/.test(new URL(u).pathname);

    // The top seed sits on the same board under both pairings (fold, then rank_adjacent): the one who stays.
    const board1 = r.boards.find((b) => [b.home, b.away].some((pl) => pl.name === names[0]))!;
    expect(board1, "premise — the top seed is paired in round 1").toBeDefined();
    const stayer = [board1.home, board1.away].find((pl) => pl.name === names[0])!;

    // ── the stayer checks in ALONE under the first pairing, and keeps the room open ──
    // Alone: with both in, the game would be made, and a board with a game is never re-paired (M-10).
    const sctx = await playerContext(browser);
    const sp = await openRoom(sctx, board1, stayer);
    await expect(screen(sp)).toHaveAttribute("data-screen", "checkin");
    await passCameraTest(sp);
    await sp.getByTestId("room-checkin-cta").click();
    await expect(screen(sp), "nobody live yet: the seat waits on the camera").toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    const first = video.participantFor(stayer.personId)!;
    video.setLivePublisher(first.id, true);
    await sp.getByTestId("room-state-retry").click();
    await expect(screen(sp)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    await expect(sp.getByTestId("room-checkin-cta")).toHaveText(uiEn["externalPlay.room.checkin.done"]!);
    expect(await checkedInAt(board1.fixtureId, stayer.personId), "premise — seated in the first pairing's meeting").not.toBeNull();
    const [old] = await meetingsOf(board1.fixtureId);
    expect(old?.meeting_id, "premise — the stayer's participant is in the first pairing's meeting").toBe(first.meetingId);
    // From here on the stayer's page is never touched: no tap, no reload.
    await sp.evaluate(() => {
      (window as unknown as { __r31Stayed?: boolean }).__r31Stayed = true;
    });
    const stayerClaims: string[] = [];
    sp.on("request", (req) => {
      if (req.method() === "POST" && isRoom(req.url())) stayerClaims.push(req.url());
    });

    // ── the organiser unpairs; the stayer's page reads on, untouched, through a gap longer than one poll ──
    // Fix round 4b: a real unpair → re-pair gap lasts minutes, so the page's own polls land inside it. Every such read
    // finds a board that names nobody, and the room must keep reading — never stop on it as if the board were gone.
    const stamp = await roundOpenedAtSql(r.stageId, 1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    await page.getByTestId("stage-unpair").click();
    await expect.poll(async () => (await pairs()).filter((f) => f.home !== null || f.away !== null).length, { timeout: 30_000 }).toBe(0);
    // A read that started before the clear may still answer the old board: the gap's reads are the ones that do not.
    const gapRead = () =>
      sp.waitForResponse((res) => res.request().method() === "GET" && isRoom(res.url()) && res.status() !== 200, {
        timeout: IDLE_POLL_MS + 10_000,
      });
    const firstInGap = await gapRead();
    const secondInGap = await gapRead(); // one whole poll interval later: the room is still reading
    expect([firstInGap.status(), secondInGap.status()], "each read inside the gap: the board is being re-paired").toEqual([409, 409]);
    expect(((await secondInGap.json()) as { error: { code: string } }).error.code).toBe("ROOM_BEING_REPAIRED");
    await expect(screen(sp), "the stayer is told, in place of the old pairing").toHaveAttribute("data-screen", "repairing");
    await expect(sp.getByTestId("room-state-repairing")).toContainText(uiEn["externalPlay.room.state.repairing.title"]!);
    expect(stayerClaims, "nothing claimed in the gap").toEqual([]);

    // ── the organiser re-pairs, with NO re-open ──
    const repaired = await apiJson(page.request, `/api/v1/stages/${r.stageId}/generate`, "POST", { pairing: "rank_adjacent" });
    expect(repaired.status, `re-pair round 1: ${JSON.stringify(repaired.error)}`).toBeLessThan(300);
    expect((await roundOpenedAtSql(r.stageId, 1))!.getTime(), "premise — no re-open: the same window").toBe(stamp!.getTime());
    const now1 = (await pairs()).find((f) => f.id === board1.fixtureId)!;
    expect([now1.home, now1.away], "premise — the top seed stayed on the board").toContain(stayer.entrantId);
    const newcomer = people.get([now1.home, now1.away].find((e) => e !== null && e !== stayer.entrantId)!)!;
    expect([board1.home.entrantId, board1.away.entrantId], "premise — the other player on the board is new to it").not.toContain(newcomer.entrantId);
    // The board is paired again: the page, still polling, reads it on its own.
    const readBack = sp.waitForResponse((res) => res.request().method() === "GET" && isRoom(res.url()), { timeout: IDLE_POLL_MS + 10_000 });
    expect((await readBack).status(), "the stayer's room reads the re-paired board").toBe(200);
    await expect(screen(sp), "still checked in, nothing to do").toHaveAttribute("data-screen", "checkin");
    expect(stayerClaims, "premise — nothing re-claimed yet: the first pairing's room is still live").toEqual([]);
    expect(video.meetingStatus(old!.meeting_id), "premise — the stayer's room is live until someone new comes in").toBe("ACTIVE");

    // ── the newcomer arrives by the lobby; their seat retires the stayer's meeting ──
    const nctx = await playerContext(browser);
    const np = await nctx.newPage();
    const fixturePage = publicFixturePath(r.slugs.org, r.slugs.comp, r.slugs.div, board1.fixtureId);
    await loginUi(np, newcomer.email, fixturePage);
    await np.waitForURL((u) => u.pathname === fixturePage);
    const card = np.getByTestId("your-board");
    await expect(card, "the lobby offers the check-in").toHaveAttribute("data-state", "check_in", { timeout: 30_000 });
    await card.getByTestId("your-board-link").click();
    await np.waitForURL((u) => u.pathname === routes.sharedFixturePlay(r.slugs.org, r.slugs.comp, r.slugs.div, board1.fixtureId));
    await expect(screen(np)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    // The stayer's own re-claim, if it comes, comes by itself: watched from before the retire.
    const reclaim = sp.waitForResponse((res) => res.request().method() === "POST" && isRoom(res.url()), { timeout: IDLE_POLL_MS + 20_000 });
    await passCameraTest(np);
    await np.getByTestId("room-checkin-cta").click();
    await expect(screen(np), "nobody live yet: the seat waits on the camera").toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    // The newcomer's claim retired the first pairing's room (the row is gone from the file, and the room is ended at the vendor).
    const nowOn = await meetingsOf(board1.fixtureId);
    expect(nowOn.length, "premise — the newcomer's own room is on file").toBeGreaterThanOrEqual(1);
    expect(nowOn.map((m) => m.meeting_id), "premise — a fresh meeting, never the first pairing's").not.toContain(old!.meeting_id);
    expect(video.meetingStatus(old!.meeting_id), "premise — the stayer's room was ended under them").toBe("INACTIVE");

    // ── R3-1: the stayer's page re-claims by itself, into a NEW meeting of THEIR OWN (D16: a room per player) ──
    const answer = await reclaim;
    expect(answer.status(), "the stayer's quiet re-claim is answered").toBe(200);
    const seat = ((await answer.json()) as { data: { seat: { participant: { participantId: string } | null } | null } }).data.seat;
    const second = video.participantFor(stayer.personId)!;
    const sideOf = (entrantId: string | null) => (now1.home === entrantId ? "home" : "away");
    const rooms = await withDb((sql) => sql<{ side: string; meeting_id: string }[]>`
      select side, meeting_id from fixture_video_meetings where fixture_id = ${board1.fixtureId} order by side`);
    expect(rooms.map((x) => x.side), "a room each for the new pairing's two players").toEqual(["away", "home"]);
    expect(rooms.map((x) => x.meeting_id), "neither is the first pairing's").not.toContain(old!.meeting_id);
    const stayerRoom = rooms.find((x) => x.side === sideOf(stayer.entrantId))!;
    const newcomerRoom = rooms.find((x) => x.side === sideOf(newcomer.entrantId))!;
    expect(stayerRoom.meeting_id, "two different meetings at the vendor").not.toBe(newcomerRoom.meeting_id);
    expect(second.meetingId, "the stayer's new participant is in the stayer's OWN new room").toBe(stayerRoom.meeting_id);
    expect(video.participantFor(newcomer.personId)?.meetingId, "and the newcomer's in theirs").toBe(newcomerRoom.meeting_id);
    expect(seat?.participant?.participantId, "and its token is the one the page was handed").toBe(second.id);
    expect(new Set(await participantsOf(board1.fixtureId)), "both players of the new pairing are on file").toEqual(
      new Set([stayer.personId, newcomer.personId]),
    );
    expect(stayerClaims, "one quiet re-claim, not a loop").toHaveLength(1);

    // Each browser joins the meeting with the token it was handed (the fixture is told; it never trusts a page).
    video.setLivePublisher(second.id, true);
    video.setLivePublisher(video.participantFor(newcomer.personId)!.id, true);
    await np.getByTestId("room-state-retry").click();

    // ── both seated on the meeting's word: the game is made under `required` ──
    await expectLichessReached(() => lichessCallsFor([stayer, newcomer]).length, board1.fixtureId, 30_000);
    await expect.poll(async () => (await bridgeRow(board1.fixtureId))?.challenge_id ?? null, { timeout: 30_000 }).not.toBeNull();
    await expect(screen(sp), "the stayer's page goes live with no tap and no reload").toHaveAttribute("data-screen", "live", {
      timeout: IDLE_POLL_MS + 10_000,
    });
    expect(
      await sp.evaluate(() => (window as unknown as { __r31Stayed?: boolean }).__r31Stayed === true),
      "the stayer's page was never reloaded",
    ).toBe(true);
    expect(stayerClaims, "still one re-claim").toHaveLength(1);
    await nctx.close();
    await sctx.close();
  });

  test("I2: the player who stays RELOADS inside the re-pair gap — the re-pair card, never 'not available'; the page re-asks itself, lands in the room once re-paired, and is seated in the NEW meeting with no further action", async ({ page, browser, request }) => {
    test.setTimeout(budget(10));
    // Its own Swiss round, as R3-1's: playable, so the game can really be made at the fixture.
    const names = [`Qi Reload ${TAG}`, `Ray Reload ${TAG}`, `Sol Reload ${TAG}`, `Tao Reload ${TAG}`];
    const r = await seedOnlineRound(request, names, { camera: "required", stage: "swiss", clock: TC, playable: true });
    expect(r.boards, "four players pair into two boards").toHaveLength(2);
    for (const b of r.boards) for (const pl of [b.home, b.away]) lichess.registerToken(pl.lichessToken!, pl.lichessId);
    const people = new Map(r.boards.flatMap((b) => [b.home, b.away]).map((p) => [p.entrantId, p]));
    const pairs = () =>
      withDb((sql) => sql<{ id: string; home: string | null; away: string | null }[]>`
        select id, home_entrant_id as home, away_entrant_id as away from fixtures
         where stage_id = ${r.stageId} and round_no = 1 order by seq_in_round`);
    const meetingsOf = (fixtureId: string) =>
      withDb((sql) => sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${fixtureId}`);
    const isRoom = (u: string) => /\/external-play\/room$/.test(new URL(u).pathname);
    const board1 = r.boards.find((b) => [b.home, b.away].some((pl) => pl.name === names[0]))!;
    expect(board1, "premise — the top seed is paired in round 1").toBeDefined();
    const stayer = [board1.home, board1.away].find((pl) => pl.name === names[0])!;

    // ── the stayer checks in ALONE under the first pairing ──
    const sctx = await playerContext(browser);
    const sp = await openRoom(sctx, board1, stayer);
    await expect(screen(sp)).toHaveAttribute("data-screen", "checkin");
    await passCameraTest(sp);
    await sp.getByTestId("room-checkin-cta").click();
    await expect(screen(sp)).toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    const first = video.participantFor(stayer.personId)!;
    video.setLivePublisher(first.id, true);
    await sp.getByTestId("room-state-retry").click();
    await expect(screen(sp)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    expect(await checkedInAt(board1.fixtureId, stayer.personId), "premise — checked in").not.toBeNull();
    const [old] = await meetingsOf(board1.fixtureId);
    expect(old?.meeting_id, "premise — seated in the first pairing's meeting").toBe(first.meetingId);

    // ── the organiser unpairs; the stayer RELOADS inside the gap ──
    const stamp = await roundOpenedAtSql(r.stageId, 1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(r.fixturesTab);
    await page.getByTestId("stage-unpair").click();
    await expect.poll(async () => (await pairs()).filter((f) => f.home !== null || f.away !== null).length, { timeout: 30_000 }).toBe(0);
    const reloaded = await sp.reload();
    expect(reloaded?.status(), "the page renders, never the error boundary").toBe(200);
    await expect(screen(sp), "the re-pair card").toHaveAttribute("data-screen", "repairing");
    await expect(sp.getByTestId("room-state-repairing")).toContainText(uiEn["externalPlay.room.state.repairing.title"]!);
    await expect(sp.getByText(uiEn["externalPlay.room.state.unavailable.body"]!), "never 'it may belong to other players'").toHaveCount(0);
    let widths = 0;
    for (const width of [320, 768, 1280]) {
      await sp.setViewportSize({ width, height: width === 1280 ? 900 : width === 768 ? 1024 : 700 });
      await sp.waitForTimeout(250);
      const { scroll, client } = await sp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(scroll, `no horizontal page scroll at ${width}px`).toBeLessThanOrEqual(client);
      widths += 1;
      if (process.env.ROOM_SHOTS_DIR) await sp.screenshot({ path: `${process.env.ROOM_SHOTS_DIR}/i2-repairing-on-load-${width}.png`, fullPage: true, caret: "initial" });
    }
    expect(widths, "anti-vacuity: widths").toBe(3);
    // Everything the page does from here, it does by itself.
    const stayerClaims: string[] = [];
    sp.on("request", (req) => {
      if (req.method() === "POST" && isRoom(req.url())) stayerClaims.push(req.url());
    });
    // It re-asks itself (router.refresh) at the room's cadence — and stays on the card while the gap lasts.
    const asked = await sp.waitForRequest((req) => req.headers()["rsc"] === "1" && new URL(req.url()).pathname.endsWith("/play"), {
      timeout: IDLE_POLL_MS + 10_000,
    });
    expect(asked.method(), "a re-ask of the page").toBe("GET");
    await expect(screen(sp), "still the gap").toHaveAttribute("data-screen", "repairing");

    // ── the organiser re-pairs, with NO re-open; the page lands in the room on its own ──
    const landed = sp.waitForResponse((res) => res.request().method() === "POST" && isRoom(res.url()), { timeout: IDLE_POLL_MS + 20_000 });
    const repaired = await apiJson(page.request, `/api/v1/stages/${r.stageId}/generate`, "POST", { pairing: "rank_adjacent" });
    expect(repaired.status, `re-pair round 1: ${JSON.stringify(repaired.error)}`).toBeLessThan(300);
    expect((await roundOpenedAtSql(r.stageId, 1))!.getTime(), "premise — no re-open").toBe(stamp!.getTime());
    const now1 = (await pairs()).find((f) => f.id === board1.fixtureId)!;
    expect([now1.home, now1.away], "premise — the top seed stayed on the board").toContain(stayer.entrantId);
    const newcomer = people.get([now1.home, now1.away].find((e) => e !== null && e !== stayer.entrantId)!)!;
    // The room's own re-entry claim (checked in, cameras on) — no tap.
    const answer = await landed;
    expect(answer.status(), "the landing claim is answered").toBe(200);
    await expect(screen(sp), "in the room again").not.toHaveAttribute("data-screen", "repairing");
    const fresh = await meetingsOf(board1.fixtureId);
    expect(fresh, "one meeting on file: the stayer's own").toHaveLength(1);
    expect(fresh[0]!.meeting_id, "a NEW meeting: the first pairing's is retired").not.toBe(old!.meeting_id);
    expect(video.meetingStatus(old!.meeting_id)).toBe("INACTIVE");
    const second = video.participantFor(stayer.personId)!;
    expect(second.meetingId, "the stayer's participant is in the NEW meeting").toBe(fresh[0]!.meeting_id);
    const seat = ((await answer.json()) as { data: { seat: { participant: { participantId: string } | null } | null } }).data.seat;
    expect(seat?.participant?.participantId, "and the page holds its token").toBe(second.id);

    // ── the newcomer arrives by the lobby; the game is made under `required` ──
    const nctx = await playerContext(browser);
    const np = await nctx.newPage();
    const fixturePage = publicFixturePath(r.slugs.org, r.slugs.comp, r.slugs.div, board1.fixtureId);
    await loginUi(np, newcomer.email, fixturePage);
    await np.waitForURL((u) => u.pathname === fixturePage);
    const card = np.getByTestId("your-board");
    await expect(card).toHaveAttribute("data-state", "check_in", { timeout: 30_000 });
    await card.getByTestId("your-board-link").click();
    await np.waitForURL((u) => u.pathname === routes.sharedFixturePlay(r.slugs.org, r.slugs.comp, r.slugs.div, board1.fixtureId));
    await expect(screen(np)).toHaveAttribute("data-screen", "checkin", { timeout: 20_000 });
    await passCameraTest(np);
    await np.getByTestId("room-checkin-cta").click();
    await expect(screen(np)).toHaveAttribute("data-screen", "cameraRequired", { timeout: 30_000 });
    // D16: the newcomer gets a room of their own; the stayer's is the one the landing made, untouched.
    const both = (await meetingsOf(board1.fixtureId)).map((m) => m.meeting_id);
    expect(both, "two rooms on file now, the stayer's among them").toHaveLength(2);
    expect(both, "the stayer's room is still the one the landing made").toContain(fresh[0]!.meeting_id);
    expect(video.participantFor(newcomer.personId)?.meetingId, "the newcomer is in the OTHER room").toBe(both.find((id) => id !== fresh[0]!.meeting_id));
    video.setLivePublisher(second.id, true);
    video.setLivePublisher(video.participantFor(newcomer.personId)!.id, true);
    await np.getByTestId("room-state-retry").click();
    await expectLichessReached(() => lichessCallsFor([stayer, newcomer]).length, board1.fixtureId, 30_000);
    await expect.poll(async () => (await bridgeRow(board1.fixtureId))?.challenge_id ?? null, { timeout: 30_000 }).not.toBeNull();
    await expect(screen(sp), "the reloaded page goes live with no tap").toHaveAttribute("data-screen", "live", { timeout: IDLE_POLL_MS + 10_000 });
    expect(stayerClaims, "one claim after the reload — the room's own landing — never a loop").toHaveLength(1);
    await nctx.close();
    await sctx.close();
  });
});
