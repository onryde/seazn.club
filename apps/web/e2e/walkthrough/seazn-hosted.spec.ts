// Seazn-hosted video, Phase 1 Task 19: the whole Seazn path, walked through a REAL production server on the fake relay drivers, by an
// organiser and a spectator in two browser contexts. What the vitest suites cannot see (AGENTS.md classes 1, 2 and 15): the organiser's
// picker defaulting to Seazn, a real Go live through the panel, the composed session going live on the compositor's beat, the public
// match page's island reading the REAL video route and handing the REAL (fake-driver) signed address to the player, the Stop reaching
// that open page within ONE poll (the Task 15 review's r3), and the interim replay: once the stream tick has locked the recording
// Cloudflare left behind, the page plays it in the same Seazn player (recommendation 2026-11-21, Task 14). Last, the database: no
// YouTube broadcast and no `addOutput` provider call for the match — a Seazn stream goes nowhere but Seazn.
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
import { FAKE_CONNECT_MS, POLL_WAIT_MS, POOL_SLOT_WAIT_MS, liveWaitMs, releaseStreamSlot, takeWholePool } from "../helpers/stream-slot-pool";
import { disposeFakePhones, pairPhoneOnFixture } from "../helpers/fake-capture-phone";
import { EMPTY_JAR, expectContract, jobTokenFor, releaseStandInOrg, seedStandInOrg, type StandInOrg } from "../helpers/sponsor-relay-standin";
import { signedAddressPattern, stubFakePlaybackHost } from "../helpers/seazn-video-seed";
import { SEAZN_VIDEO_POLL_FLOOR_MS } from "../../src/components/public-site/match-centre/seazn-video-schedule";
import { routes } from "../../src/lib/routes";

// ===========================================================================
// Clocks — DERIVED from the constants that set the pace (AGENTS.md class 20)
// ===========================================================================
/** The org, the competition, its division started and its one fixture. */
const SEED_MS = 60_000;
/** One page load (the organiser's fixture page, the pairing tab, the spectator's match page). */
const NAV_MS = 30_000;
/** From the Go live tap until the panel reads live: the fake's connect and two organiser polls, plus slack (the pool's own). */
const LIVE_WAIT_MS = liveWaitMs(FAKE_CONNECT_MS);
/** The island's re-read: its floor (30 s, the schedule's own constant) plus slack. A Stop, and a newly signed recording, reach an open
 *  page on the NEXT read, so each of those waits is exactly one of these. */
const ONE_RE_READ_MS = SEAZN_VIDEO_POLL_FLOOR_MS + 15_000;
/** The Stop landing: the tap, the compositor's last beat, and the session reading completed (three polls-plus-slack). */
const END_MS = 3 * POLL_WAIT_MS;
/** One server round trip that is not a page: the recording control, the stream tick. */
const CALL_MS = POLL_WAIT_MS;

/** This file's one hold of the stream-slot pool: from before the Go live to the teardown's stop. A composed session reserves two
 *  matches of recording (R2004), so it takes the WHOLE pool, as every composed walkthrough does (overlay-compositor.spec.ts). */
const POOL_HOLD = {
  file: "seazn-hosted.spec.ts",
  holdMs: LIVE_WAIT_MS + NAV_MS + 3 * ONE_RE_READ_MS + END_MS + 2 * CALL_MS,
} as const;

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

// ===========================================================================
// Teardown: nothing this file opened outlives its test
// ===========================================================================
const rigs: StandInOrg[] = [];
const sessionsThisTest: { org: StandInOrg; fixtureId: string; compositor: Compositor | null }[] = [];
const viewers: BrowserContext[] = [];

test.afterEach(async () => {
  try {
    for (const v of viewers.splice(0)) await v.close().catch(() => {});
    await disposeFakePhones();
    for (const s of sessionsThisTest.splice(0)) {
      await s.compositor?.stop().catch(() => {});
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
test("Seazn pre-selected → Go live → the spectator sees the live player → Stop: it leaves the open page within one read → the recording, once the tick locks it, plays as the interim replay in the same player → no YouTube broadcast and no addOutput call", async ({
  browser,
}) => {
  test.skip(process.env.SEAZN_HOSTED_LIVE !== "true", "needs a server and runner with SEAZN_HOSTED_LIVE=true (e2e.yml's e2e-seazn job)");
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) throw new Error("CRON_SECRET is not set: export the value the server under test was started with (this walk posts the stream tick)");
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set: the compositor stand-in mints its job token with the server's own");
  const NAVS = 4; // the organiser's sign-in, the fixture page, the pairing tab, the spectator's match page
  test.setTimeout(SEED_MS + POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + NAVS * NAV_MS);

  const rig = await seedRig(browser);
  const page = rig.org.page;

  // 1. SEAZN PRE-SELECTED: the organiser opens the match's Stream panel and Seazn is the first destination and the one picked.
  let body = await openPhoneTab(page, rig.fixturePath);
  expect((await offeredTargetIds(body))[0], "Seazn is offered first").toBe(rig.seaznId);
  await expect(body.locator(`[data-testid="stream-target-option"][data-target-id="${rig.seaznId}"]`)).toHaveAttribute("aria-selected", "true");
  await body.getByTestId("stream-target").press("Escape");
  await expect(targetPicker(body), "picked with no choice of the organiser's own").toHaveAttribute("data-value", rig.seaznId);
  await expect(targetPicker(body).getByTestId("stream-target-name")).toHaveText(ui("stream.dest.kind.seazn"));

  // 2. GO LIVE, by tapping it. A composed Go live takes the whole pool first, and Go live needs a paired phone (W5).
  await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: 1 });
  await pairPhoneOnFixture(page, rig.fixturePath);
  body = await openPhoneTab(page, rig.fixturePath);
  await expect(targetPicker(body), "still Seazn after the reload").toHaveAttribute("data-value", rig.seaznId);
  const live = { org: rig.org, fixtureId: rig.fixtureId, compositor: null as Compositor | null };
  sessionsThisTest.push(live);
  await body.getByTestId("stream-go-live").click();
  let sid = "";
  await expect
    .poll(async () => {
      const rows = await withDb((sql) => sql<{ id: string; mode: string; destination_kind: string | null }[]>`
        select id, mode, destination_kind from fixture_stream_sessions where fixture_id = ${rig.fixtureId}`);
      sid = rows[0]?.id ?? "";
      return rows.map((r) => [r.destination_kind, r.mode]);
    }, { message: "the tap started one session, for Seazn, composed", timeout: POLL_WAIT_MS, intervals: [1_000] })
    .toEqual([["seazn", "composed"]]);

  // The compositor reads its session, then beats `playing` for its life.
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
  live.compositor = compositor(rig.org, sid, token);
  live.compositor.keepAlive(intervalMs);
  await expect(body.getByTestId("stream-state-pill"), "the organiser's panel reads live").toHaveText(ui("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
  const [programme] = await withDb((sql) => sql<{ id: string; uid: string }[]>`
    select id, ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme' and ingest_input_id is not null`);
  expect(programme, "premise: the live composed session has its programme input").toBeTruthy();

  // 3. THE SPECTATOR: signed out, on the public match page. The island's first read shows the live player, on the server's own
  //    signed address for the programme input.
  const viewerCtx = await browser.newContext({ storageState: EMPTY_JAR, viewport: { width: 1280, height: 900 } });
  viewers.push(viewerCtx);
  const viewer = await viewerCtx.newPage();
  await stubFakePlaybackHost(viewer);
  await viewer.goto(rig.publicPath);
  await dismissCookieBanner(viewer);
  const region = viewer.getByTestId("seazn-video");
  const player = viewer.locator('[data-testid="seazn-player"] video');
  await expect.poll(addressIs(player, programme!.uid), { message: "the live player holds the server's signed address for the programme input", timeout: ONE_RE_READ_MS }).toBe(true);
  await expect(region, "the region is the LIVE one").toHaveAttribute("aria-label", pub("seaznVideo.live"));
  await expect(region.locator("iframe"), "a Seazn stream is never an embed").toHaveCount(0);
  await expectNoHorizontalScroll(viewer);
  // The page must not reload from here on: a marker on the window survives only the same document.
  await viewer.evaluate(() => void ((window as unknown as { __seaznSameDocument: boolean }).__seaznSameDocument = true));
  const sameDocument = () => viewer.evaluate(() => (window as unknown as { __seaznSameDocument?: boolean }).__seaznSameDocument === true);

  // 4. STOP, by tapping it. The compositor's keep-alive is silenced first, and its last beat (`ended`) follows the organiser's stop.
  await live.compositor.stop();
  await body.getByTestId("stream-stop").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: ui("stream.phone.stop"), exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: POLL_WAIT_MS });
  const last = await page.request.post(`/api/internal/relay/sessions/${sid}/heartbeat`, { headers: { Authorization: `Bearer ${token}` }, data: { state: "stopped", exitReason: "ended" } });
  expect([200, 410], "the compositor's last beat is taken, or the session had already ended").toContain(last.status());
  await expect
    .poll(async () => {
      await page.request.get(`/api/v1/fixtures/${rig.fixtureId}/stream-sessions/current`).catch(() => null);
      return (await withDb((sql) => sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`))[0]?.state;
    }, { message: "the stopped session completes", timeout: END_MS, intervals: [1_000] })
    .toBe("completed");
  await expect(body.getByTestId("stream-state-pill"), "the organiser's panel reads ended").toHaveText(ui("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });

  // 5. THE OPEN PAGE LEARNS IT within one re-read (r3): the live player goes, and the match page stays, without a reload.
  await expect(region, "the live player left the open page within one re-read").toHaveCount(0, { timeout: ONE_RE_READ_MS });
  await expect(viewer.getByTestId("mc-court-card"), "the match page itself is still there").toBeVisible();
  expect(await sameDocument(), "no reload between live and ended").toBe(true);

  // 6. THE RECORDING: Cloudflare (the fake) finishes one of the programme input, and the stream tick's Seazn pass locks it.
  const made = await page.request.post(`/api/internal/relay/fake-ingest/${programme!.uid}`, { data: { recording: "ready" } });
  expect(made.status(), "the fake-ingest control finished a recording (RELAY_DRIVERS=fake, ENV_NAME local or ci)").toBe(200);
  const { videoId } = ((await made.json()) as { data: { videoId: string } }).data;
  expect(videoId, "the control named the recording").toBeTruthy();
  const tick = await page.request.post("/api/cron/stream-tick", { headers: { "x-cron-secret": cronSecret } });
  expect(tick.status(), "the stream tick runs").toBe(200);
  const seazn = ((await tick.json()) as { data?: { seazn?: { locked?: number } } }).data?.seazn;
  // The counters are the whole SERVER's; this test's own witness is the locked row below.
  expect(seazn?.locked ?? 0, "the tick's Seazn pass locked at least this recording").toBeGreaterThanOrEqual(1);
  const locked = await withDb((sql) => sql<{ input_row_id: string }[]>`select input_row_id from seazn_locked_videos where cf_video_id = ${videoId}`);
  expect(locked.map((r) => r.input_row_id), "locked once, on this session's programme input").toEqual([programme!.id]);

  // 7. THE INTERIM REPLAY: the open page's next read plays the recording, in the same Seazn player, still without a reload.
  await expect.poll(addressIs(player, videoId), { message: "the replay player holds the server's signed address for the recording", timeout: ONE_RE_READ_MS }).toBe(true);
  await expect(region, "the region is now the REPLAY one").toHaveAttribute("aria-label", pub("overlay.replay"));
  await expect(viewer.locator('[data-testid="seazn-player"]'), "one Seazn player on the page").toHaveCount(1);
  await expect(region.locator("iframe"), "the interim replay is the Seazn player, not an embed").toHaveCount(0);
  expect(await sameDocument(), "no reload between ended and the replay").toBe(true);
  await expectNoHorizontalScroll(viewer);

  // 8. NOWHERE BUT SEAZN: no YouTube broadcast, and no output added to any input, for this match. The provider-call rows are
  //    recorded (positive pair: the inputs this session made are there), so the zero is a reading, not an absent table.
  const calls = async () => withDb((sql) => sql<{ operation: string; n: number }[]>`
    select c.operation, count(*)::int as n from stream_provider_calls c
      join fixture_stream_sessions s on s.id = c.session_id
     where s.fixture_id = ${rig.fixtureId} group by c.operation`);
  await expect
    .poll(async () => (await calls()).find((r) => r.operation === "createLiveInput")?.n ?? 0, { message: "the session's provider calls are recorded", timeout: POLL_WAIT_MS })
    .toBeGreaterThanOrEqual(1);
  expect((await calls()).filter((r) => r.operation === "addOutput"), "no addOutput call for the match").toEqual([]);
  const [broadcasts] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where fixture_id = ${rig.fixtureId}`);
  expect(broadcasts!.n, "no YouTube broadcast for the match").toBe(0);
  const kinds = await withDb((sql) => sql<{ destination_kind: string | null }[]>`select destination_kind from fixture_stream_sessions where fixture_id = ${rig.fixtureId}`);
  expect(kinds.map((k) => k.destination_kind), "the match's only session was Seazn's").toEqual(["seazn"]);
});
