// Seazn-hosted video, Phase 1 Task 19: the whole Seazn path, walked through a REAL production server on the fake relay drivers, by an
// organiser and a spectator in two browser contexts. What the vitest suites cannot see (AGENTS.md classes 1, 2 and 15): the organiser's
// picker defaulting to Seazn; a spectator who opened the match page BEFORE kick-off (the island already reading the route, nothing
// drawn); a real Go live through the panel, the composed session going live on the compositor's beat, and that open page turning to
// the live player on the REAL (fake-driver) signed address; the Stop reaching it within ONE poll (the Task 15 review's r3); the interim
// replay: once the stream tick has locked the recording Cloudflare left behind, the page plays it in the same Seazn player
// (recommendation 2026-11-21, Task 14); and a SECOND Go live (Start another) reaching that same page within one poll too (the Task 19
// review's I1). The whole way, one document, and a player that never failed (a failed player re-reads early, which would fake both
// "within one poll" witnesses). Last, the database: no YouTube broadcast and no `addOutput` provider call for the match — a Seazn
// stream goes nowhere but Seazn.
//
// WHERE IT RUNS. Only on a server and a runner that both have SEAZN_HOSTED_LIVE=true (with SEAZN_VIDEO_ORIGINS naming the server's
// host): e2e.yml's `e2e-seazn` job. Everywhere else the flag is off, the org has no Seazn pick at all, and the case SKIPS by name — it
// never passes vacuously. The job also sets CRON_SECRET (the stream tick) and AUTH_SECRET (the compositor stand-in's job token).
//
// WHAT IS STOOD IN FOR, AND WHERE. Three providers, each only at its boundary:
//   * the compositor: its job token and heartbeat (helpers/sponsor-relay-standin.ts's recipe: `jobTokenFor`, every body through the
//     vendored contract), beating `playing` for the session's life, as the real one beats;
//   * Cloudflare's recording: the fake ingest finishes one recording of the session's programme input through the fake-ingest control
//     route (`{ recording: "ready" }`, FakeIngest.addRecording), because nothing in a server process makes a video otherwise;
//   * the Stream customer host: `playback.fake.invalid` never resolves, so the spectator's browser is answered by a manifest stand-in
//     (helpers/seazn-video-seed.ts `stubFakePlaybackHost`). The ADDRESS asserted is always the server's own.
//
// SINGLE-SPORT, ONE WIDTH: a Seazn stream reads no sport (the destination, the session and the video route are sport-agnostic) and a
// composed Go live takes the WHOLE stream-slot pool, so one run at 1280 is the walk; public-fixture.spec.ts and mobile/public-pages
// cover the player at the other widths.
//
// SECRETS: no job token, cron secret or signed address is ever put in an assertion message or a log line. A signed address is matched
// by a boolean poll (`addressIs`), so a red prints true/false, never the URL.
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, withDb } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { offeredTargetIds, targetPicker } from "../helpers/stream-target-picker";
import { FAKE_CONNECT_MS, poolHoldProblem, releaseStreamSlot, takeWholePool } from "../helpers/stream-slot-pool";
import { NAV_MS, seaznWalkClock } from "../helpers/seazn-hosted-clock";
import { disposeFakePhones, pairPhoneOnFixture } from "../helpers/fake-capture-phone";
import { EMPTY_JAR, expectContract, jobTokenFor, releaseStandInOrg, seedStandInOrg, type StandInOrg } from "../helpers/sponsor-relay-standin";
import { playsHlsNatively, signedAddressPattern, stubFakePlaybackHost } from "../helpers/seazn-video-seed";
import { routes } from "../../src/lib/routes";

// ===========================================================================
// Clocks — DERIVED from the constants that set the pace (AGENTS.md class 20): helpers/seazn-hosted-clock.ts, one term per wait in
// step order, where the CI wiring test also reads the walk's worst case to hold e2e-seazn's job timeout to it.
// ===========================================================================
const { LIVE_WAIT_MS, ONE_RE_READ_MS, END_MS, CALL_MS, CREDITS_KEY_WAIT_MS, HOLD_1_MS, HOLD_2_MS, WALK_MS } = seaznWalkClock(FAKE_CONNECT_MS);
const POOL_HOLD = {
  file: "seazn-hosted.spec.ts",
  holdMs: Math.max(HOLD_1_MS, HOLD_2_MS),
} as const;
// The declared hold is every sibling's wait (stream-slot-pool.ts): in the one mode that runs the walk, a hold past the pool's limit
// refuses at load — `playwright test --list` included — not after a seed and a pairing on CI.
if (process.env.SEAZN_HOSTED_LIVE === "true") {
  const problem = poolHoldProblem(POOL_HOLD);
  if (problem) throw new Error(problem);
}

// ===========================================================================
// Copy, from the dictionaries themselves
// ===========================================================================
type Dict = Record<string, string>;
const dict = (file: string): Dict => JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/en/${file}`, import.meta.url)), "utf8")) as Dict;
const EN_UI = dict("ui.json");
const EN_PUBLIC = dict("public.json");
const copy = (d: Dict, key: string): string => {
  const raw = d[key];
  if (raw === undefined) throw new Error(`no ${key} in the en dictionary`);
  return raw;
};
const ui = (key: string) => copy(EN_UI, key);
const pub = (key: string) => copy(EN_PUBLIC, key);

// ===========================================================================
// Kit
// ===========================================================================
interface Rig { org: StandInOrg; fixtureId: string; fixturePath: string; publicPath: string; seaznId: string }

/** A fresh organiser on Pro (its own context: helpers/sponsor-relay-standin.ts), a PUBLIC competition with one started league fixture
 *  (the match page needs a division past setup), and the org's Seazn destination (V540's trigger). */
async function seedRig(browser: Browser): Promise<Rig> {
  const org = await seedStandInOrg(browser, "szh", { orgName: "Seazn Hosted Club" });
  rigs.push(org);
  const request = org.page.request;
  const comp = await apiJson<{ id: string; slug: string; visibility: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `Seazn Hosted ${org.orgSlug.slice(-8)}`, visibility: "public",
  });
  expect(comp.status, `the competition: ${JSON.stringify(comp.error)}`).toBe(201);
  expect(comp.data!.visibility, "premise: the competition is public").toBe("public");
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open", sport_key: "badminton", variant_key: "bwf",
  });
  expect(div.status, `the division: ${JSON.stringify(div.error)}`).toBe(201);
  expect((await addEntrantsViaApi(request, div.data!.id, ["Seazn Home", "Seazn Away"])).status).toBe(201);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a two-entrant league seats one fixture").toBe(1);
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status, "the division starts").toBeLessThan(300);
  const fixtureId = fixtureIds[0]!;
  // Kick-off 10 minutes on, as an organiser's schedule would set it: the spectator below opens the page before kick-off, and the
  // whole walk runs inside the hour either side of it, where the island holds its 30 s floor through empty answers (re-review N1).
  // So every wait below is one re-read for a viewer who simply keeps watching, with no help from the page's visibility.
  const [kicked] = await withDb((sql) => sql<{ scheduled_at: Date | null }[]>`
    update fixtures set scheduled_at = now() + interval '10 minutes' where id = ${fixtureId} returning scheduled_at`);
  expect(kicked?.scheduled_at, "premise: the fixture has its kick-off time").toBeInstanceOf(Date);
  const [row] = await withDb((sql) => sql<{ no: number; seazn: string | null }[]>`
    select f.fixture_no as no, (select id from org_stream_targets where org_id = ${org.orgId} and kind = 'seazn') as seazn
      from fixtures f where f.id = ${fixtureId}`);
  expect(row?.seazn, "premise: V540 gave the org its Seazn destination").toBeTruthy();
  return {
    org,
    fixtureId,
    fixturePath: `/o/${org.orgSlug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${row!.no}`,
    publicPath: routes.publicFixture(org.orgSlug, comp.data!.slug, div.data!.slug, fixtureId),
    seaznId: row!.seazn!,
  };
}

/** The organiser's Stream panel on the fixture page, on its Phone tab (stream-relay.spec.ts's openPhoneTab). */
async function openPhoneTab(page: Page, fixturePath: string): Promise<Locator> {
  await page.goto(fixturePath);
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control, "the fixture page offers exactly one visible Stream control").toHaveCount(1, { timeout: NAV_MS });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: NAV_MS });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  await expect(scope.locator("[data-phone-body]")).toBeAttached({ timeout: NAV_MS });
  return scope.locator("[data-phone-body]");
}

/** The compositor stand-in's beats for one session: every body through the vendored contract BEFORE it is sent, the reply after.
 *  `keepAlive` beats `playing` at the cadence the session's facts serve (a composed runner that misses three beats is lost);
 *  `stop` silences it and lets a beat on the wire land. Background failures are kept and thrown by `stop`, never swallowed. */
interface Compositor { sid: string; keepAlive: (intervalMs: number) => void; stop: () => Promise<void> }
function compositor(org: StandInOrg, sid: string, token: string): Compositor {
  const PLAYING = { state: "playing", programmePhase: "live" };
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  const problems: string[] = [];
  const beat = async (): Promise<void> => {
    const res = await org.page.request.post(`/api/internal/relay/sessions/${sid}/heartbeat`, { headers: { Authorization: `Bearer ${token}` }, data: PLAYING });
    if (res.status() !== 200) problems.push(`a keep-alive beat answered HTTP ${res.status()}`);
  };
  return {
    sid,
    keepAlive(intervalMs) {
      expectContract("heartbeat", PLAYING, "the stand-in's keep-alive body");
      timer = setInterval(() => {
        if (inFlight !== null) return;
        inFlight = beat().catch((e: unknown) => void problems.push(e instanceof Error ? e.message : String(e))).finally(() => (inFlight = null));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await inFlight;
      expect(problems, "the compositor stand-in's keep-alive beats").toEqual([]);
    },
  };
}

/** Matches the element's `data-src` against the server's signed address for `uid`, as a boolean: a red never prints the address. */
const addressIs = (el: Locator, uid: string) => async (): Promise<boolean> => {
  if ((await el.count()) !== 1) return false;
  return signedAddressPattern(uid).test((await el.getAttribute("data-src", { timeout: 1_000 }).catch(() => null)) ?? "");
};

/** The match centre itself: its court card, or — while the match's document has no tabs yet (before a point is scored) — the plain
 *  scoreboard it falls back to (match-centre.tsx). Either way the page the island sits in. */
const matchPage = (page: Page): Locator => page.locator('[data-testid="mc-court-card"], [data-testid="mc-fallback"]').first();

/** The spectator's page, watched: the island's reads of the video route counted, and a flag set if the player EVER showed its
 *  "unavailable" note. A player that fails asks the route again early (seazn-video-poll.ts `refreshSoon`), so without this flag a
 *  "within one poll" witness would also pass on a broken player; with it, the only way the page could change is the scheduled read. */
interface Viewer { page: Page; reads: () => number; neverFailed: () => Promise<boolean>; sameDocument: () => Promise<boolean>; reached: (uid: string) => () => Promise<boolean> }
async function openViewer(browser: Browser, rig: Rig): Promise<Viewer> {
  const ctx = await browser.newContext({ storageState: EMPTY_JAR, viewport: { width: 1280, height: 900 } });
  viewers.push(ctx);
  const page = await ctx.newPage();
  const stub = await stubFakePlaybackHost(page);
  const videoRoute = `/api/v1/public/fixtures/${rig.fixtureId}/video`;
  let reads = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === videoRoute) reads++;
  });
  await page.goto(rig.publicPath);
  await dismissCookieBanner(page);
  await page.evaluate(() => {
    const w = window as unknown as { __seaznSameDocument: boolean; __seaznUnavailableSeen: boolean };
    w.__seaznSameDocument = true;
    w.__seaznUnavailableSeen = false;
    const check = () => {
      if (document.querySelector('[data-testid="seazn-player-unavailable"]')) w.__seaznUnavailableSeen = true;
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    check();
  });
  const native = await playsHlsNatively(page);
  const player = page.locator('[data-testid="seazn-player"] video');
  return {
    page,
    reads: () => reads,
    neverFailed: () => page.evaluate(() => (window as unknown as { __seaznUnavailableSeen?: boolean }).__seaznUnavailableSeen === false),
    sameDocument: () => page.evaluate(() => (window as unknown as { __seaznSameDocument?: boolean }).__seaznSameDocument === true),
    // The address reached the browser's player, not just the attribute: hls.js asks the stand-in for the manifest at once (no media:
    // `preload="none"`), and a browser that plays HLS itself holds it as the element's own src (public-fixture.spec.ts's two paths).
    reached: (uid) => async () =>
      native
        ? signedAddressPattern(uid).test((await player.getAttribute("src", { timeout: 1_000 }).catch(() => null)) ?? "")
        : stub.requests.some((u) => signedAddressPattern(uid).test(u)),
  };
}

/** One Go live of the Seazn destination, by tapping it, and the compositor stand-in that makes it live: the session row (one new
 *  one, for Seazn, composed), its facts, the first beat through the vendored contract, the keep-alive, the live pill, and the
 *  programme input the spectator's player will be handed. */
async function goLiveSeazn(page: Page, body: Locator, rig: Rig, open: OpenSessions): Promise<{ sid: string; token: string; programme: { id: string; uid: string }; compositor: Compositor }> {
  const before = new Set((await withDb((sql) => sql<{ id: string }[]>`select id from fixture_stream_sessions where fixture_id = ${rig.fixtureId}`)).map((r) => r.id));
  await body.getByTestId("stream-go-live").click();
  let sid = "";
  await expect
    .poll(async () => {
      const rows = (await withDb((sql) => sql<{ id: string; mode: string; destination_kind: string | null }[]>`
        select id, mode, destination_kind from fixture_stream_sessions where fixture_id = ${rig.fixtureId}`)).filter((r) => !before.has(r.id));
      sid = rows[0]?.id ?? "";
      return rows.map((r) => [r.destination_kind, r.mode]);
    }, { message: "the tap started one new session, for Seazn, composed", timeout: CALL_MS, intervals: [1_000] })
    .toEqual([["seazn", "composed"]]);
  const token = await jobTokenFor(sid);
  let intervalMs = 0;
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/internal/relay/sessions/${sid}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status() !== 200) return `HTTP ${res.status()}`;
      const facts = ((await res.json()) as { data: { overlayUrl?: string; heartbeatIntervalMs?: number } }).data;
      intervalMs = facts.heartbeatIntervalMs ?? 0;
      return facts.overlayUrl && intervalMs > 0 ? "facts" : "facts without an overlayUrl or a cadence";
    }, { message: "the composed session's facts never served", timeout: LIVE_WAIT_MS, intervals: [1_000] })
    .toBe("facts");
  const first = { state: "playing", programmePhase: "live" };
  expectContract("heartbeat", first, "the stand-in's first beat");
  const beat = await page.request.post(`/api/internal/relay/sessions/${sid}/heartbeat`, { headers: { Authorization: `Bearer ${token}` }, data: first });
  expect(beat.status(), "the compositor's first beat is taken").toBe(200);
  expectContract("heartbeatReply", ((await beat.json()) as { data: unknown }).data, "the first beat's reply");
  const c = compositor(rig.org, sid, token);
  open.compositors.push(c);
  c.keepAlive(intervalMs);
  await expect(body.getByTestId("stream-state-pill"), "the organiser's panel reads live").toHaveText(ui("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
  const [programme] = await withDb((sql) => sql<{ id: string; uid: string }[]>`
    select id, ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme' and ingest_input_id is not null`);
  expect(programme, "premise: the live composed session has its programme input").toBeTruthy();
  return { sid, token, programme: programme!, compositor: c };
}

// ===========================================================================
// Teardown: nothing this file opened outlives its test
// ===========================================================================
interface OpenSessions { org: StandInOrg; fixtureId: string; compositors: Compositor[] }
const rigs: StandInOrg[] = [];
const sessionsThisTest: OpenSessions[] = [];
const viewers: BrowserContext[] = [];

test.afterEach(async () => {
  try {
    for (const v of viewers.splice(0)) await v.close().catch(() => {});
    await disposeFakePhones();
    for (const s of sessionsThisTest.splice(0)) {
      for (const c of s.compositors) await c.stop().catch(() => {});
      const open = await withDb((sql) => sql<{ id: string }[]>`
        select id from fixture_stream_sessions where fixture_id = ${s.fixtureId} and state not in ('completed', 'failed')`);
      for (const { id } of open) {
        await s.org.page.request.post(`/api/v1/fixtures/${s.fixtureId}/stream-sessions/${id}/stop`).catch(() => null);
        const token = await jobTokenFor(id);
        await s.org.page.request.post(`/api/internal/relay/sessions/${id}/heartbeat`, { headers: { Authorization: `Bearer ${token}` }, data: { state: "stopped", exitReason: "ended" } }).catch(() => null);
      }
      // A session that will not end never keeps its reservation: forced terminal (V410: a failed session carries no end_reason).
      await withDb(async (sql) => {
        await sql`update fixture_stream_sessions set state = 'completed', ended_at = now()
                   where fixture_id = ${s.fixtureId} and end_reason is not null and state not in ('completed', 'failed')`;
        await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'unknown', end_reason = null, ended_at = now()
                   where fixture_id = ${s.fixtureId} and end_reason is null and state not in ('completed', 'failed')`;
      });
    }
  } finally {
    await releaseStreamSlot();
    for (const org of rigs.splice(0)) await releaseStandInOrg(org).catch(() => {});
  }
});

// ===========================================================================
// The walk
// ===========================================================================
test("Seazn pre-selected → a spectator opens the page before kick-off → Go live reaches it → Stop: the live player leaves within one read → the tick's recording plays as the interim replay → a second Go live reaches the same page within one read → no YouTube broadcast and no addOutput call", async ({
  browser,
}) => {
  test.skip(process.env.SEAZN_HOSTED_LIVE !== "true", "needs a server and runner with SEAZN_HOSTED_LIVE=true (e2e.yml's e2e-seazn job)");
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) throw new Error("CRON_SECRET is not set: export the value the server under test was started with (this walk posts the stream tick)");
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set: the compositor stand-in mints its job token with the server's own");
  test.setTimeout(WALK_MS);

  const rig = await seedRig(browser);
  const page = rig.org.page;
  const open: OpenSessions = { org: rig.org, fixtureId: rig.fixtureId, compositors: [] };
  sessionsThisTest.push(open);

  // 1. SEAZN PRE-SELECTED: the organiser opens the match's Stream panel and Seazn is the first destination and the one picked.
  let body = await openPhoneTab(page, rig.fixturePath);
  expect((await offeredTargetIds(body))[0], "Seazn is offered first").toBe(rig.seaznId);
  await expect(body.locator(`[data-testid="stream-target-option"][data-target-id="${rig.seaznId}"]`)).toHaveAttribute("aria-selected", "true");
  await body.getByTestId("stream-target").press("Escape");
  await expect(targetPicker(body), "picked with no choice of the organiser's own").toHaveAttribute("data-value", rig.seaznId);
  await expect(targetPicker(body).getByTestId("stream-target-name")).toHaveText(ui("stream.dest.kind.seazn"));

  // 2. BEFORE KICK-OFF (the plan's arm 3: LIVE on, no session yet, the match resolving to Seazn): a signed-out spectator opens the public
  //    match page at 1280. The island is mounted and reading the route, and draws nothing yet.
  const viewer = await openViewer(browser, rig);
  await expect.poll(viewer.reads, { message: "the island reads the video route before kick-off", timeout: NAV_MS }).toBeGreaterThanOrEqual(1);
  const region = viewer.page.getByTestId("seazn-video");
  const player = viewer.page.locator('[data-testid="seazn-player"] video');
  await expect(region, "nothing to show before kick-off").toHaveCount(0);
  await expect(matchPage(viewer.page), "the match page itself is there").toBeVisible();
  await expectNoHorizontalScroll(viewer.page);

  // 3. GO LIVE, by tapping it. Go live needs a paired phone (W5); a composed Go live takes the whole pool first.
  await pairPhoneOnFixture(page, rig.fixturePath);
  body = await openPhoneTab(page, rig.fixturePath);
  await expect(targetPicker(body), "still Seazn after the reload").toHaveAttribute("data-value", rig.seaznId);
  const pool = await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: CREDITS_KEY_WAIT_MS });
  const first = await goLiveSeazn(page, body, rig, open);

  // 4. THE OPEN PAGE TURNS LIVE on its next read, without a reload: the server's own signed address for the programme input, in the
  //    player and reaching it, on a player that has not failed. The page has shown nothing since it opened, but it is within the hour
  //    of its kick-off, so its reads stayed on the floor (re-review N1): a viewer who keeps watching sees Go live within ONE read.
  await expect.poll(addressIs(player, first.programme.uid), { message: "the open page's player holds the signed address for the programme input", timeout: ONE_RE_READ_MS }).toBe(true);
  await expect(region, "the region is the LIVE one").toHaveAttribute("aria-label", pub("seaznVideo.live"));
  await expect.poll(viewer.reached(first.programme.uid), { message: "the live address reached the browser's player", timeout: CALL_MS }).toBe(true);
  await expect(region.locator("iframe"), "a Seazn stream is never an embed").toHaveCount(0);
  expect(await viewer.neverFailed(), "the live player never failed").toBe(true);
  expect(await viewer.sameDocument(), "no reload between kick-off and live").toBe(true);
  await expectNoHorizontalScroll(viewer.page);

  // 5. STOP, by tapping it. The compositor's keep-alive is silenced first, and its last beat (`ended`) follows the organiser's stop.
  await first.compositor.stop();
  await body.getByTestId("stream-stop").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: ui("stream.phone.stop"), exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: CALL_MS });
  const last = await page.request.post(`/api/internal/relay/sessions/${first.sid}/heartbeat`, { headers: { Authorization: `Bearer ${first.token}` }, data: { state: "stopped", exitReason: "ended" } });
  expect([200, 410], "the compositor's last beat is taken, or the session had already ended").toContain(last.status());
  await expect
    .poll(async () => {
      await page.request.get(`/api/v1/fixtures/${rig.fixtureId}/stream-sessions/current`).catch(() => null);
      return (await withDb((sql) => sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${first.sid}`))[0]?.state;
    }, { message: "the stopped session completes", timeout: END_MS, intervals: [1_000] })
    .toBe("completed");
  await expect(body.getByTestId("stream-state-pill"), "the organiser's panel reads ended").toHaveText(ui("stream.phone.state.ended"), { timeout: CALL_MS });

  // 6. THE OPEN PAGE LEARNS IT within one re-read (r3): the live player goes, the match page stays, without a reload, and not
  //    because the player failed (a failed player re-reads early).
  await expect(region, "the live player left the open page within one re-read").toHaveCount(0, { timeout: ONE_RE_READ_MS });
  await expect(matchPage(viewer.page), "the match page itself is still there").toBeVisible();
  expect(await viewer.neverFailed(), "the live player left on a scheduled read, never by failing").toBe(true);
  expect(await viewer.sameDocument(), "no reload between live and ended").toBe(true);

  // 7. THE RECORDING: Cloudflare (the fake) finishes one of the programme input, and the stream tick's Seazn pass locks it. The tick is
  //    GLOBAL, so it runs only once every key is this test's — the pool since before the Go live, stream-credits' now (W22's
  //    exclusion, capture-phone.spec.ts) — and no other org has a session open.
  const made = await page.request.post(`/api/internal/relay/fake-ingest/${first.programme.uid}`, { data: { recording: "ready" } });
  expect(made.status(), "the fake-ingest control finished a recording (RELAY_DRIVERS=fake, ENV_NAME local or ci)").toBe(200);
  const { videoId } = ((await made.json()) as { data: { videoId: string } }).data;
  expect(videoId, "the control named the recording").toBeTruthy();
  const creditsKey = await pool.credits();
  try {
    const others = await withDb((sql) => sql<{ id: string }[]>`
      select id from fixture_stream_sessions where org_id <> ${rig.org.orgId} and state not in ('completed', 'failed')`);
    expect(others, "the global tick can reach no other test's session").toEqual([]);
    const tick = await page.request.post("/api/cron/stream-tick", { headers: { "x-cron-secret": cronSecret } });
    expect(tick.status(), "the stream tick runs").toBe(200);
    const seazn = ((await tick.json()) as { data?: { seazn?: { locked?: number } } }).data?.seazn;
    // The counters are the whole SERVER's; this test's own witness is the locked row below.
    expect(seazn?.locked ?? 0, "the tick's Seazn pass locked at least this recording").toBeGreaterThanOrEqual(1);
  } finally {
    await creditsKey.release();
  }
  const locked = await withDb((sql) => sql<{ input_row_id: string }[]>`select input_row_id from seazn_locked_videos where cf_video_id = ${videoId}`);
  expect(locked.map((r) => r.input_row_id), "locked once, on this session's programme input").toEqual([first.programme.id]);
  // Hold 1 ends: the session is terminal and the tick has run. The replay check below needs no slot.
  await releaseStreamSlot();

  // 8. THE INTERIM REPLAY: the open page's next read plays the recording, in the same Seazn player, reaching it, still without a reload.
  //    Since the Stop the page has had empty answers; near kick-off they hold the floor (re-review N1), so this is one read too.
  await expect.poll(addressIs(player, videoId), { message: "the replay player holds the server's signed address for the recording", timeout: ONE_RE_READ_MS }).toBe(true);
  await expect(region, "the region is now the REPLAY one").toHaveAttribute("aria-label", pub("overlay.replay"));
  await expect.poll(viewer.reached(videoId), { message: "the recording's address reached the browser's player", timeout: CALL_MS }).toBe(true);
  await expect(viewer.page.locator('[data-testid="seazn-player"]'), "one Seazn player on the page").toHaveCount(1);
  await expect(region.locator("iframe"), "the interim replay is the Seazn player, not an embed").toHaveCount(0);
  expect(await viewer.neverFailed(), "the replay player has not failed").toBe(true);
  expect(await viewer.sameDocument(), "no reload between ended and the replay").toBe(true);
  await expectNoHorizontalScroll(viewer.page);

  // 9. A SECOND GO LIVE (I1): the organiser starts another; the page that is playing the first half's recording turns to the NEW
  //    programme input's live player on its next read — not at the recording token's refresh point, ~55 minutes on.
  await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: CREDITS_KEY_WAIT_MS });
  await body.getByTestId("stream-again").click();
  await expect(body.getByTestId("stream-state-pill"), "back to a fresh Go live").toHaveText(ui("stream.phone.state.idle"), { timeout: CALL_MS });
  await expect(targetPicker(body), "the match's pick is still Seazn").toHaveAttribute("data-value", rig.seaznId);
  const second = await goLiveSeazn(page, body, rig, open);
  expect(second.programme.uid, "premise: a new session publishes to a new programme input").not.toBe(first.programme.uid);
  await expect.poll(addressIs(player, second.programme.uid), { message: "the open page's player holds the NEW programme input's signed address", timeout: ONE_RE_READ_MS }).toBe(true);
  await expect(region, "the region is the LIVE one again").toHaveAttribute("aria-label", pub("seaznVideo.live"));
  await expect.poll(viewer.reached(second.programme.uid), { message: "the second live address reached the browser's player", timeout: CALL_MS }).toBe(true);
  expect(await viewer.neverFailed(), "the page turned live on a scheduled read, never by a failing player").toBe(true);
  expect(await viewer.sameDocument(), "no reload between the replay and the second live").toBe(true);

  // 10. NOWHERE BUT SEAZN: no YouTube broadcast, and no output added to any input, for this match. The provider-call rows are recorded
  //     (positive pair: the inputs EACH session made are there — by session, since one composed provision alone makes two, its camera
  //     and its programme), so the zero is a reading, not an absent table.
  const calls = async () => withDb((sql) => sql<{ session_id: string; operation: string; n: number }[]>`
    select c.session_id, c.operation, count(*)::int as n from stream_provider_calls c
      join fixture_stream_sessions s on s.id = c.session_id
     where s.fixture_id = ${rig.fixtureId} group by c.session_id, c.operation`);
  await expect
    .poll(async () => {
      const rows = await calls();
      return [first.sid, second.sid].map((sid) => rows.some((r) => r.session_id === sid && r.operation === "createLiveInput" && r.n >= 1));
    }, { message: "each session's own createLiveInput calls are recorded (the first, then the second)", timeout: CALL_MS })
    .toEqual([true, true]);
  expect((await calls()).filter((r) => r.operation === "addOutput"), "no addOutput call for the match").toEqual([]);
  const [broadcasts] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where fixture_id = ${rig.fixtureId}`);
  expect(broadcasts!.n, "no YouTube broadcast for the match").toBe(0);
  const kinds = await withDb((sql) => sql<{ destination_kind: string | null }[]>`select destination_kind from fixture_stream_sessions where fixture_id = ${rig.fixtureId}`);
  expect(kinds.map((k) => k.destination_kind), "the match's two sessions were both Seazn's").toEqual(["seazn", "seazn"]);
});
