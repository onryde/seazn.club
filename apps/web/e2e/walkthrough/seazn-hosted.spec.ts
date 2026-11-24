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
// The Task 25 replay case at the end of the file is the exception: it reads no flag and runs in either mode (see its note).
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
import {
  addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, invalidateOrgEntitlements, mintLoginPathBySql, setBoolEntitlementOverrideSql,
  setEntitlementOverrideSql, withDb,
} from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { offeredTargetIds, targetPicker } from "../helpers/stream-target-picker";
import { FAKE_CONNECT_MS, poolHoldProblem, releaseStreamSlot, takeWholePool } from "../helpers/stream-slot-pool";
import { NAV_MS, seaznWalkClock } from "../helpers/seazn-hosted-clock";
import { disposeFakePhones, pairPhoneOnFixture } from "../helpers/fake-capture-phone";
import { EMPTY_JAR, expectContract, jobTokenFor, releaseStandInOrg, seedStandInOrg, type StandInOrg } from "../helpers/sponsor-relay-standin";
import {
  finishSeaznMatch, lockRecordings, playsHlsNatively, seedPlayableReplays, seedSeaznMatch, signedAddressPattern, signedEmbedPattern,
  stubFakeEmbedHost, stubFakePlaybackHost,
} from "../helpers/seazn-video-seed";
import { routes } from "../../src/lib/routes";

// ===========================================================================
// Clocks — DERIVED from the constants that set the pace (AGENTS.md class 20): helpers/seazn-hosted-clock.ts, one term per wait in
// step order, where the CI wiring test also reads the walk's worst case to hold e2e-seazn's job timeout to it.
// ===========================================================================
const { LIVE_WAIT_MS, ONE_RE_READ_MS, END_MS, CALL_MS, FRESH_PAGE_MS, CREDITS_KEY_WAIT_MS, HOLD_1_MS, HOLD_2_MS, WALK_MS } = seaznWalkClock(FAKE_CONNECT_MS);
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
/** Task 33c: the owner's words, literal (2026-11-23, "the live action" 2026-11-24), never rebuilt from the code under test's template
 *  and constant (T33c review m2), so a wrong figure or a wrong word reds here. */
const DELAY_LINE = "Video runs about 15–20 seconds behind the live action.";
/** Owner 2026-11-23: Seazn's own destination is called "Seazn Hosted", a brand in every locale. Literal for the same reason. */
const SEAZN_BRAND = "Seazn Hosted";
/** Task 33f (owner 'Ok', 2026-11-24): the held box's one line names the video that is coming: a live on its way up, or the replay of a
 *  stream that has stopped. Literal for the same reason. */
const LIVE_COMING = "The live video will start here shortly";
const REPLAY_COMING = "The replay will be ready here in a few minutes";
/** The held box's status line(s) in a page's SERVER HTML, read inside the box's own section: the page's flight payload carries the island's
 *  labels, so BOTH lines are somewhere in the document and a bare `toContain` would pass for either. */
const heldLinesIn = (html: string): string[] => {
  const box = /<section data-testid="seazn-video-starting"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  return box === null ? [] : [...box[1]!.matchAll(/<p [^>]*role="status"[^>]*>(.*?)<\/p>/g)].map((m) => m[1]!);
};

// ===========================================================================
// Kit
// ===========================================================================
interface Rig { org: StandInOrg; fixtureId: string; fixturePath: string; publicPath: string; seaznId: string }

/** A fresh organiser on Pro (its own context: helpers/sponsor-relay-standin.ts), a PUBLIC competition with one started league fixture
 *  (the match page needs a division past setup), and the org's Seazn destination (V541's trigger). */
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
  expect(row?.seazn, "premise: V541 gave the org its Seazn destination").toBeTruthy();
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
 *  programme input the spectator's player will be handed. `whileWarming` (Task 33f) runs between the facts and the first beat, while
 *  the session is still on its way up (nothing but that beat makes it live). */
async function goLiveSeazn(
  page: Page, body: Locator, rig: Rig, open: OpenSessions, whileWarming?: (sid: string) => Promise<void>,
): Promise<{ sid: string; token: string; programme: { id: string; uid: string }; compositor: Compositor }> {
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
  if (whileWarming) await whileWarming(sid);
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
  await expect(targetPicker(body).getByTestId("stream-target-name"), "the brand, \"Seazn Hosted\" (owner 11-23)").toHaveText(SEAZN_BRAND);

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
  const phone = await pairPhoneOnFixture(page, rig.fixturePath);
  body = await openPhoneTab(page, rig.fixturePath);
  await expect(targetPicker(body), "still Seazn after the reload").toHaveAttribute("data-value", rig.seaznId);
  const pool = await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: CREDITS_KEY_WAIT_MS });
  const first = await goLiveSeazn(page, body, rig, open);
  // Task 46: the phone's own beat answer, through the real beats route and the contract twin, tells what the relay last said —
  // the compositor stand-in beats `programmePhase: "live"`.
  await expect.poll(async () => {
    const a = (await phone.beat()).ok;
    if (a === null) return "refused";
    return a.state === "go-live" || a.state === "live" ? (a.delivery?.programmePhase ?? "no delivery") : a.state;
  }, { message: "the phone's live answer carries the relay's programme phase", timeout: CALL_MS, intervals: [1_000] }).toBe("live");

  // 4. THE OPEN PAGE TURNS LIVE on its next read, without a reload: the server's own signed address for the programme input, in the
  //    player and reaching it, on a player that has not failed. The page has shown nothing since it opened, but it is within the hour
  //    of its kick-off, so its reads stayed on the floor (re-review N1): a viewer who keeps watching sees Go live within ONE read.
  await expect.poll(addressIs(player, first.programme.uid), { message: "the open page's player holds the signed address for the programme input", timeout: ONE_RE_READ_MS }).toBe(true);
  await expect(region, "the region is the LIVE one").toHaveAttribute("aria-label", pub("seaznVideo.live"));
  // Task 33c (owner 2026-11-23): while the VIDEO is live, one line under the player says how far it runs behind the live action, inside the live
  // region and below the picture (never over it). Before kick-off (step 2) there was no region at all, so no line either.
  const delay = viewer.page.getByTestId("seazn-video-delay");
  await expect(delay, "the delay line, while live").toBeVisible();
  await expect(delay).toHaveText(DELAY_LINE);
  await expect(region.getByTestId("seazn-video-delay"), "inside the live region").toHaveCount(1);
  const [pictureBox, delayBox] = await Promise.all([viewer.page.locator('[data-testid="seazn-player"]').boundingBox(), delay.boundingBox()]);
  expect(pictureBox && delayBox, "both are laid out").toBeTruthy();
  expect(delayBox!.y, "under the picture, not over it").toBeGreaterThanOrEqual(pictureBox!.y + pictureBox!.height - 1);
  // Re-capture R2: where the live player sits, so the box that holds after the Stop (step 6) is held against it.
  const placeOf = (selector: string) => viewer.page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { top: r.top + window.scrollY, height: r.height };
  }, selector);
  const livePlace = await placeOf('[data-testid="seazn-player"]');
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
  // Re-capture R2: the box does not collapse when the Stop reaches the page. It holds, with its one quiet line, in the very place the live
  // player was, until the recording is locked (step 7) and takes its place (step 8).
  const starting = viewer.page.getByTestId("seazn-video-starting");
  await expect(starting, "the Stop leaves the player's box with its line, not a collapsed page").toBeVisible();
  // Task 33f: the stream has stopped, so the line says the REPLAY is coming (never the live, which it no longer is).
  await expect(starting.getByRole("status"), "the line names the replay").toHaveText(REPLAY_COMING);
  // Task 33c: the stream has ended, so the delay line is gone with the live player: no visible line, and the held box keeps no hidden row
  // for one either (a recording comes next, and its player has no line).
  await expect(viewer.page.getByTestId("seazn-video-delay"), "the delay line is gone after the Stop").toHaveCount(0);
  await expect(viewer.page.getByTestId("seazn-video-delay-reserved"), "and no row is held for it").toHaveCount(0);
  const heldPlace = await placeOf('[data-testid="seazn-video-frame"]');
  expect(Math.abs(heldPlace.top - livePlace.top), `the held box starts where the live player did (${heldPlace.top} vs ${livePlace.top})`).toBeLessThanOrEqual(1);
  expect(Math.abs(heldPlace.height - livePlace.height), `and is as tall (${heldPlace.height} vs ${livePlace.height})`).toBeLessThanOrEqual(1);
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
  await expect(starting, "the recording took the held box's place: the line is gone").toHaveCount(0);
  await expect(viewer.page.getByTestId("seazn-video-delay"), "Task 33c: a replay carries no delay line").toHaveCount(0);
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
  // 9a. BEFORE IT IS LIVE (Task 33f): while the second session warms (the stand-in has not beaten `playing` yet), a fresh look at the
  //     match page shows the held box saying the LIVE video is coming. The page is ISR (revalidate 30 s) and nothing has asked for its
  //     HTML since step 2, minutes ago, so the first look is answered stale and starts a fresh render; a later look carries the warming
  //     session. Read in the server HTML, the first paint a viewer opening the page now gets (the island's first read then shows the
  //     first half's recording, which is already locked). The open page (step 2's) is untouched.
  const lookWhileWarming = async (sid: string): Promise<void> => {
    const [row] = await withDb((sql) => sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`);
    expect(["requested", "provisioning", "warming"], "premise: the second session is still on its way up").toContain(row?.state);
    // Polled on the line itself: a stale render (no box) keeps it polling, and on a timeout the red prints what the box last said.
    await expect
      .poll(async () => heldLinesIn(await (await viewer.page.request.get(rig.publicPath)).text()), {
        message: "a fresh render of the match page: the held box says the LIVE video is coming, and only that",
        timeout: FRESH_PAGE_MS,
        intervals: [1_000],
      })
      .toEqual([LIVE_COMING]);
    const [still] = await withDb((sql) => sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`);
    expect(still?.state, "premise: and the session was not live yet when the page was read").not.toBe("live");
  };
  const second = await goLiveSeazn(page, body, rig, open, lookWhileWarming);
  expect(second.programme.uid, "premise: a new session publishes to a new programme input").not.toBe(first.programme.uid);
  await expect.poll(addressIs(player, second.programme.uid), { message: "the open page's player holds the NEW programme input's signed address", timeout: ONE_RE_READ_MS }).toBe(true);
  await expect(region, "the region is the LIVE one again").toHaveAttribute("aria-label", pub("seaznVideo.live"));
  await expect(region.getByTestId("seazn-video-delay"), "Task 33c: live again, so the delay line is back").toHaveText(DELAY_LINE);
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

// ===========================================================================
// Task 25: the Seazn replay
// ===========================================================================
// Once the replay move has made a playable copy of each recording, the match page offers every part in the replay host's player (an
// embed frame, never the interim's <video>), labelled by its own number, and picking a part loads THAT part's signed embed. The move
// itself (discovery and the copy, across a stop and a restart) is proved by Task 24's fake-clock usecase tests; this seeds its output
// (helpers/seazn-video-seed.ts `seedPlayableReplays`: one playable row per locked recording) and drives the page. No Stop, tick or
// grace wait in the browser. The address asserted is always the server's own (the fake replay host's signer), matched by a boolean so a
// red never prints it; and our own route is never asked with a token. NOT gated on LIVE, unlike the walk: a playable replay plays
// whatever LIVE or REPLAY is (controller ruling, Task 25 brief), so this case runs wherever this file runs, LIVE on (e2e-seazn) or off,
// and proves that ruling in a browser. At 1280, then the same page at 320 for the sideways-scroll and fit check.
const REPLAY_SEED_MS = 60_000;
test("Task 25: two playable replays read Part 1 and Part 2 in the replay host's frame, kept out of PostHog's recordings; picking Part 2 loads part 2's signed embed; no sideways scroll at 1280 or 320", async ({ page, baseURL }) => {
  test.setTimeout(REPLAY_SEED_MS + NAV_MS + ONE_RE_READ_MS + 2 * NAV_MS);
  expect(baseURL, "premise: the project names the server").toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await seedSeaznMatch(page, { name: `Seazn Replay ${Date.now().toString(36)}`, live: true });
  try {
    await finishSeaznMatch(m);
    const bunny = await seedPlayableReplays(m, await lockRecordings(m, 2));
    expect(bunny, "premise: two playable parts").toHaveLength(2);
    const host = await stubFakeEmbedHost(page);
    // Our own requests: none may carry the host's token or its expiry (the island never puts an address in a query).
    const ownQueries: string[] = [];
    const ownHost = new URL(baseURL!).host;
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.host === ownHost) ownQueries.push(u.search);
    });
    await page.goto(m.publicPath);
    await dismissCookieBanner(page);

    const region = page.getByTestId("seazn-video");
    const tabs = region.getByRole("tab");
    const partLabel = (n: number) => pub("seaznVideo.part").replace("{n}", String(n));
    await expect(tabs, "the answer lists both parts, each by its own number").toHaveText([partLabel(1), partLabel(2)], { timeout: ONE_RE_READ_MS });
    await expect(tabs.first(), "part 1 is picked first").toHaveAttribute("aria-selected", "true");
    const frame = region.getByTestId("seazn-replay-frame");
    await expect(frame, "one frame").toHaveCount(1);
    await expect(region.locator("video"), "a playable copy plays in the host's frame, never the interim player").toHaveCount(0);
    for (const target of [region, page.getByTestId("seazn-replay-frame-box"), frame]) await expect(target).toHaveClass(/\bph-no-capture\b/);
    const frameHolds = (bunnyId: string) =>
      frame.evaluate((el, source) => new RegExp(source).test((el as HTMLIFrameElement).src), signedEmbedPattern(bunnyId).source);
    await expect.poll(() => frameHolds(bunny[0]!), { message: "the frame holds part 1's signed embed, the fake host's own" }).toBe(true);
    await expect.poll(() => host.requests.some((u) => signedEmbedPattern(bunny[0]!).test(u)), { message: "the browser loaded part 1's embed" }).toBe(true);

    await tabs.nth(1).click();
    await expect(tabs.nth(1), "part 2 is picked").toHaveAttribute("aria-selected", "true");
    await expect.poll(() => frameHolds(bunny[1]!), { message: "the frame now holds part 2's signed embed" }).toBe(true);
    await expect.poll(() => host.requests.some((u) => signedEmbedPattern(bunny[1]!).test(u)), { message: "the browser loaded part 2's embed" }).toBe(true);
    await expect(frame, "still one frame").toHaveCount(1);
    await expect(region.locator("video")).toHaveCount(0);
    expect(ownQueries.length, "premise: the page made requests of its own").toBeGreaterThan(0);
    expect(ownQueries.filter((q) => /token|expires/i.test(q)).length, "no request of ours carries a token or an expiry").toBe(0);

    await expectNoHorizontalScroll(page);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalScroll(page);
      const box = await page.getByTestId("seazn-replay-frame-box").boundingBox();
      expect(box, `${width}: the frame's box is laid out`).not.toBeNull();
      expect(box!.x, `${width}: inside the left edge`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${width}: inside the right edge`).toBeLessThanOrEqual(width);
      expect(box!.height, `${width}: the stage keeps its 200 px floor`).toBeGreaterThanOrEqual(200);
    }
  } finally {
    await finishSeaznMatch(m);
  }
});

// ===========================================================================
// Task 26: the organiser deletes a replay part, and downloads one
// ===========================================================================
// The organiser's Stream panel (Phone tab, the ended card) lists the fixture's Seazn replay parts. Each playable part has Download — a
// link to OUR download route, the ids and nothing else — and every part has Delete, which asks the house confirm (never the
// browser's) first. "Keep replay" sends nothing; "Delete replay" removes the part for everyone: the panel drops its row at once, the row
// reads deleted by this organiser, and the public match page no longer offers it. The bytes of a download, the streaming, the headers'
// hygiene and the org/role refusals are the route's vitest (download/__tests__/route.test.ts, over the replay fake holding the file):
// this e2e server's replay host holds no copy of the seeded parts, so the route's own answer here is its "host not ready" refusal (409,
// private) — asserted, so the link reaches the route rather than a 404 or a redirect to the host. Not gated on LIVE (as Task 25's
// case). At 1280, then 320 for the panel's fit (no sideways scroll, every action a 44 px target).
test("Task 26: the organiser's panel lists both parts with Download and Delete; Keep sends nothing; Delete removes part 2 for everyone — the panel row, the stored row and the public page", async ({ page }) => {
  test.setTimeout(REPLAY_SEED_MS + 3 * NAV_MS + 2 * CALL_MS + ONE_RE_READ_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await seedSeaznMatch(page, { name: `Seazn Delete ${Date.now().toString(36)}`, live: true });
  try {
    await finishSeaznMatch(m);
    const bunny = await seedPlayableReplays(m, await lockRecordings(m, 2));
    expect(bunny, "premise: two playable parts").toHaveLength(2);
    const ids = (await withDb((sql) => sql<{ id: string }[]>`select id from fixture_video_replays where fixture_id = ${m.fixtureId} order by part_no`)).map((r) => r.id);
    expect(ids, "premise: one row per part").toHaveLength(2);
    const deletes: string[] = [];
    page.on("request", (r) => { if (r.method() === "DELETE") deletes.push(new URL(r.url()).pathname); });

    const body = await openPhoneTab(page, m.fixturePath);
    const card = body.getByTestId("stream-seazn-replays");
    await expect(card.getByText(ui("stream.replay.seazn.title"))).toBeVisible({ timeout: CALL_MS });
    const rows = card.getByTestId("stream-seazn-replay");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(ui("stream.replay.seazn.part").replace("{n}", "1"));
    await expect(rows.nth(0), "a public competition's part is on the match page").toContainText(ui("stream.replay.seazn.ready"));
    const downloads = card.getByTestId("stream-seazn-replay-download");
    await expect(downloads).toHaveCount(2);
    for (const [i, id] of ids.entries()) {
      await expect(downloads.nth(i), `part ${i + 1}: the link is our route, the ids and nothing else`).toHaveAttribute("href", `/api/v1/fixtures/${m.fixtureId}/replays/${id}/download`);
      await expect(downloads.nth(i)).toHaveAttribute("download", "");
    }
    const answer = await page.request.get(`/api/v1/fixtures/${m.fixtureId}/replays/${ids[0]}/download`, { maxRedirects: 0 });
    expect(answer.status(), "the route answers itself (the e2e host holds no copy: not ready), never a redirect to the host").toBe(409);
    expect(answer.headers()["cache-control"] ?? "").toMatch(/private/);
    expect(answer.headers()["cache-control"] ?? "").toMatch(/no-store/);
    expect(answer.headers()["location"], "no redirect").toBeUndefined();

    // Keep: the house confirm (an alertdialog of ours, not the browser's), and nothing sent.
    let nativeDialog = false;
    page.on("dialog", (d) => { nativeDialog = true; void d.dismiss(); });
    const deleteButtons = card.getByTestId("stream-seazn-replay-delete");
    await expect(deleteButtons).toHaveCount(2);
    await deleteButtons.nth(1).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: CALL_MS });
    await expect(dialog).toContainText(ui("stream.replay.deletePartTitle").replace("{n}", "2"));
    await expect(dialog).toContainText(ui("stream.replay.deleteConfirm"));
    await dialog.getByRole("button", { name: ui("stream.replay.deleteKeep") }).click();
    await expect(dialog).toBeHidden();
    await expect(rows, "Keep: both parts stay").toHaveCount(2);
    expect(deletes, "Keep sends nothing").toEqual([]);

    // Delete part 2.
    await deleteButtons.nth(1).click();
    await expect(dialog).toBeVisible({ timeout: CALL_MS });
    await dialog.getByRole("button", { name: ui("stream.replay.delete") }).click();
    await expect(rows, "the deleted part leaves the panel").toHaveCount(1, { timeout: CALL_MS });
    await expect(rows.first(), "one part left: no part label").not.toContainText(ui("stream.replay.seazn.part").replace("{n}", "1"));
    expect(deletes, "one DELETE, to part 2's route").toEqual([`/api/v1/fixtures/${m.fixtureId}/replays/${ids[1]}`]);
    expect(nativeDialog, "never the browser's confirm()").toBe(false);
    const [stored] = await withDb((sql) => sql<{ state: string; deleted_reason: string | null; deleted_by: string | null; deleted_at: Date | null }[]>`
      select state, deleted_reason, deleted_by, deleted_at from fixture_video_replays where id = ${ids[1]}`);
    expect(stored?.state).toBe("deleted");
    expect(stored?.deleted_reason).toBe("organiser");
    expect(stored?.deleted_by, "deleted by the signed-in organiser").toBeTruthy();
    expect(stored?.deleted_at).toBeInstanceOf(Date);

    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalScroll(page);
      for (const action of [card.getByTestId("stream-seazn-replay-download"), card.getByTestId("stream-seazn-replay-delete")]) {
        const box = await action.first().boundingBox();
        expect(box, `${width}: laid out`).not.toBeNull();
        expect(box!.height, `${width}: a 44 px target`).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width, `${width}: inside the right edge`).toBeLessThanOrEqual(width);
      }
    }

    // The public page no longer offers part 2: the one part left plays in the frame, with no part picker.
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubFakeEmbedHost(page);
    await page.goto(m.publicPath);
    await dismissCookieBanner(page);
    const region = page.getByTestId("seazn-video");
    const frame = region.getByTestId("seazn-replay-frame");
    await expect(frame).toHaveCount(1, { timeout: ONE_RE_READ_MS });
    const frameHolds = (bunnyId: string) =>
      frame.evaluate((el, source) => new RegExp(source).test((el as HTMLIFrameElement).src), signedEmbedPattern(bunnyId).source);
    await expect.poll(() => frameHolds(bunny[0]!), { message: "part 1 still plays" }).toBe(true);
    await expect(region.getByRole("tab"), "one part: no picker, and no part 2").toHaveCount(0);
  } finally {
    await finishSeaznMatch(m);
  }
});

// ===========================================================================
// Task 31b (T31b review m1): the replays list WITHOUT the Stream panel
// ===========================================================================
// An organiser whose org lost the panel (here `streaming.overlay` switched off by an org-wide override — every plan grants it since
// V426, so an override is the one negative left; written on this test's OWN fresh org, never the shared Pro one) still owns the replays
// already made: the fixture page shows the list on its own (`[data-role="fixture-replays"]`, fixture-replays-section.tsx), the same
// card and the same routes, and no Stream control. Before the switch the same page shows the panel and NOT the list: never both, never
// neither (lib/fixture-stream-mount.ts `offersStandaloneReplays`). Download is the link the page gives, answered by the route itself
// (409 "not ready": this server's replay host holds no copy of a seeded part, as Task 26 says). Keep sends nothing. Delete removes the
// part, and the section re-reads the PAGE (`router.refresh`): part 1, deleted meanwhile from another tab, leaves with it — the one
// witness that the re-read happened, because the deleted part itself is hidden at once whether or not it did. Not gated on LIVE (as
// Tasks 25 and 26). At 1280, then 320 for the card's fit.
test("Task 31b: with the Stream panel switched off, the fixture page lists the replays on their own — no Stream control; Download is our route; Keep sends nothing; Delete removes the part and re-reads the page", async ({ browser }) => {
  test.setTimeout(REPLAY_SEED_MS + 30_000 + 3 * NAV_MS + 4 * CALL_MS);
  const org = await seedStandInOrg(browser, "szr", { orgName: "Seazn Replays Alone" });
  rigs.push(org);
  const page = org.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await seedSeaznMatch(page, { name: `Seazn Alone ${Date.now().toString(36)}`, live: true });
  try {
    expect(m.orgId, "premise: the match is this test's own org's (the override below is org-wide)").toBe(org.orgId);
    await finishSeaznMatch(m);
    expect(await seedPlayableReplays(m, await lockRecordings(m, 3)), "premise: three playable parts").toHaveLength(3);
    const ids = (await withDb((sql) => sql<{ id: string }[]>`select id from fixture_video_replays where fixture_id = ${m.fixtureId} order by part_no`)).map((r) => r.id);
    expect(ids, "premise: one row per part").toHaveLength(3);
    const replayPath = (id: string) => `/api/v1/fixtures/${m.fixtureId}/replays/${id}`;
    // Any Stream control in the page at all (the negative), and the one a person sees (the positive: openPhoneTab's locator).
    const streamControl = page.locator('[data-role="fixture-stream"], [data-role="fixture-stream-phone"]');
    const visibleStreamControl = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
    const section = page.locator('[data-role="fixture-replays"]');

    // Before: the panel is mounted, so the list is not on its own.
    await page.goto(m.fixturePath);
    await expect(visibleStreamControl, "entitled: the page offers the Stream control").toHaveCount(1, { timeout: NAV_MS });
    await expect(section, "entitled: no list on its own beside the panel").toHaveCount(0);

    // The panel goes: streaming.overlay off for this org (and its cached entitlements dropped).
    await setBoolEntitlementOverrideSql(org.orgId, "streaming.overlay", false);
    await invalidateOrgEntitlements(page.request, org.orgId);
    await page.goto(m.fixturePath);
    await expect(section, "the list stands alone").toBeVisible({ timeout: NAV_MS });
    await expect(streamControl, "and the page offers no Stream control").toHaveCount(0);
    await expect(section.getByRole("heading", { name: ui("stream.replay.seazn.title") })).toBeVisible();
    const rows = section.getByTestId("stream-seazn-replay");
    await expect(rows).toHaveCount(3);
    for (const n of [1, 2, 3]) await expect(rows.nth(n - 1)).toContainText(ui("stream.replay.seazn.part").replace("{n}", String(n)));

    // Download: the link the page gives is our route, and the route answers it itself.
    const downloads = section.getByTestId("stream-seazn-replay-download");
    await expect(downloads).toHaveCount(3);
    for (const [i, id] of ids.entries()) {
      await expect(downloads.nth(i), `part ${i + 1}: our route, the ids and nothing else`).toHaveAttribute("href", `${replayPath(id)}/download`);
      await expect(downloads.nth(i)).toHaveAttribute("download", "");
    }
    const href = await downloads.first().getAttribute("href");
    expect(href, "premise: the link has an address").toBeTruthy();
    const answer = await page.request.get(href!, { maxRedirects: 0 });
    expect(answer.status(), "the route answers itself without the panel's plan (the e2e host holds no copy: not ready), never a redirect").toBe(409);
    expect(answer.headers()["cache-control"] ?? "").toMatch(/private/);
    expect(answer.headers()["cache-control"] ?? "").toMatch(/no-store/);
    expect(answer.headers()["location"], "no redirect").toBeUndefined();

    // Keep: the house confirm, and nothing sent.
    const deletes: string[] = [];
    page.on("request", (r) => { if (r.method() === "DELETE") deletes.push(new URL(r.url()).pathname); });
    let nativeDialog = false;
    page.on("dialog", (d) => { nativeDialog = true; void d.dismiss(); });
    const deleteButtons = section.getByTestId("stream-seazn-replay-delete");
    await expect(deleteButtons).toHaveCount(3);
    await deleteButtons.nth(2).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: CALL_MS });
    await expect(dialog).toContainText(ui("stream.replay.deletePartTitle").replace("{n}", "3"));
    await dialog.getByRole("button", { name: ui("stream.replay.deleteKeep") }).click();
    await expect(dialog).toBeHidden();
    await expect(rows, "Keep: every part stays").toHaveCount(3);
    expect(deletes, "Keep sends nothing").toEqual([]);

    // Meanwhile, part 1 is deleted from another tab: this page still lists it until it reads the page again.
    const elsewhere = await page.request.delete(replayPath(ids[0]!));
    expect(elsewhere.status(), "premise: the other tab's delete").toBe(200);
    await expect(rows, "premise: this page has not re-read yet").toHaveCount(3);
    const sentBefore = deletes.length;

    // Delete part 3: it leaves at once, and the re-read takes part 1 with it — one part left, part 2.
    await deleteButtons.nth(2).click();
    await expect(dialog).toBeVisible({ timeout: CALL_MS });
    await dialog.getByRole("button", { name: ui("stream.replay.delete") }).click();
    await expect(rows, "part 3 hidden, and part 1 gone on the re-read: one part left").toHaveCount(1, { timeout: CALL_MS });
    await expect(downloads, "the part left is part 2").toHaveAttribute("href", `${replayPath(ids[1]!)}/download`);
    await expect(rows.first(), "one part left: no part label").not.toContainText(ui("stream.replay.seazn.part").replace("{n}", "2"));
    expect(deletes.slice(sentBefore), "one DELETE from this page, to part 3's route").toEqual([replayPath(ids[2]!)]);
    expect(nativeDialog, "never the browser's confirm()").toBe(false);
    const stored = await withDb((sql) => sql<{ state: string; deleted_reason: string | null; deleted_by: string | null }[]>`
      select state, deleted_reason, deleted_by from fixture_video_replays where fixture_id = ${m.fixtureId} order by part_no`);
    expect(stored.map((r) => [r.state, r.deleted_reason, r.deleted_by]), "parts 1 and 3 deleted by this organiser; part 2 kept").toEqual([
      ["deleted", "organiser", org.userId], ["playable", null, null], ["deleted", "organiser", org.userId],
    ]);
    await expect(streamControl, "still no Stream control after the re-read").toHaveCount(0);

    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalScroll(page);
      for (const action of [downloads, deleteButtons]) {
        const box = await action.first().boundingBox();
        expect(box, `${width}: laid out`).not.toBeNull();
        expect(box!.height, `${width}: a 44 px target`).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width, `${width}: inside the right edge`).toBeLessThanOrEqual(width);
      }
    }
  } finally {
    await finishSeaznMatch(m);
  }
});

// ===========================================================================
// Task 33d (T31b review m3): a member whose seat is paused sees the replays, never an action that answers 402
// ===========================================================================
// After a downgrade an org can hold more members than its plan's `members.max`: an ADMIN past the limit is read-only until the owner
// frees seats (doc 10 §2.4; the owner is never paused), and both replay routes answer that admin 402 (their write scope). So the list on
// its own (the org lost the panel: `streaming.overlay` off, as Task 31b) shows that admin every part, with neither Download nor Delete,
// and one line saying why; the routes still refuse them, and the part stays. The owner of the same org keeps both actions. The limit is
// an override on this test's OWN fresh org (members.max 1: the owner's own seat), never the shared Pro org. At 1280, then 320.
test("Task 33d: an admin whose seat is paused sees the replays with no Download or Delete and one line saying why; both routes still answer 402; the owner keeps both actions", async ({ browser }) => {
  test.setTimeout(REPLAY_SEED_MS + 2 * 30_000 + 4 * NAV_MS + 2 * CALL_MS);
  const org = await seedStandInOrg(browser, "szs", { orgName: "Seazn Paused Seat" });
  rigs.push(org);
  const page = org.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await seedSeaznMatch(page, { name: `Seazn Paused ${Date.now().toString(36)}`, live: true });
  let adminCtx: BrowserContext | null = null;
  let adminId: string | null = null;
  try {
    expect(m.orgId, "premise: the match is this test's own org's (the overrides below are org-wide)").toBe(org.orgId);
    await finishSeaznMatch(m);
    expect(await seedPlayableReplays(m, await lockRecordings(m, 1)), "premise: one playable part").toHaveLength(1);
    const [part] = await withDb((sql) => sql<{ id: string }[]>`select id from fixture_video_replays where fixture_id = ${m.fixtureId}`);
    expect(part, "premise: the part's row").toBeTruthy();
    const replayPath = `/api/v1/fixtures/${m.fixtureId}/replays/${part!.id}`;
    const stateOf = async () => (await withDb((sql) => sql<{ state: string }[]>`select state from fixture_video_replays where id = ${part!.id}`))[0]?.state;

    // The org loses the panel (as Task 31b) and seats: members.max 1 is the owner's own seat, so the admin added below is past it.
    const email = `delivered+${org.orgSlug}-admin@resend.dev`;
    adminId = await withDb(async (sql) => {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified) values (${email}, ${"Paused Admin"}, true) returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${org.orgId}, ${id}, 'admin')`;
      return id;
    });
    await setBoolEntitlementOverrideSql(org.orgId, "streaming.overlay", false);
    await setEntitlementOverrideSql(org.orgId, "members.max", 1);
    await invalidateOrgEntitlements(page.request, org.orgId);

    adminCtx = await browser.newContext({ storageState: EMPTY_JAR, viewport: { width: 1280, height: 900 } });
    const admin = await adminCtx.newPage();
    await admin.goto(await mintLoginPathBySql(email));
    await admin.waitForURL((u) => !u.pathname.startsWith("/magic-link") && !u.pathname.startsWith("/login"), { timeout: 30_000 });
    await dismissCookieBanner(admin);

    // The server stays the guard: both routes answer the paused admin 402, and the part stays.
    const refusedDelete = await admin.request.delete(replayPath);
    expect(refusedDelete.status(), "the paused seat's Delete: 402").toBe(402);
    const refusedDownload = await admin.request.get(`${replayPath}/download`, { maxRedirects: 0 });
    expect(refusedDownload.status(), "the paused seat's Download: 402").toBe(402);
    expect(await stateOf(), "the part stays").toBe("playable");

    // So the page offers the paused admin neither: every part and its state, and one line saying why.
    const section = admin.locator('[data-role="fixture-replays"]');
    const paused = section.getByTestId("stream-seazn-replays-paused");
    await admin.goto(m.fixturePath);
    await expect(section, "the list stands alone (no panel)").toBeVisible({ timeout: NAV_MS });
    await expect(section.getByTestId("stream-seazn-replay"), "the part is listed").toHaveCount(1);
    await expect(section.getByTestId("stream-seazn-replay")).toContainText(ui("stream.replay.seazn.ready"));
    await expect(section.getByTestId("stream-seazn-replay-download"), "no Download").toHaveCount(0);
    await expect(section.getByTestId("stream-seazn-replay-delete"), "no Delete").toHaveCount(0);
    await expect(paused, "one line").toHaveCount(1);
    await expect(paused).toHaveText(ui("stream.replay.seazn.seatPaused"));
    for (const width of [1280, 320]) {
      await admin.setViewportSize({ width, height: 900 });
      await expectNoHorizontalScroll(admin);
      const box = await paused.boundingBox();
      expect(box, `${width}: the line is laid out`).not.toBeNull();
      expect(box!.x, `${width}: inside the left edge`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${width}: inside the right edge`).toBeLessThanOrEqual(width);
    }

    // The owner of the same org is never paused: both actions, and no line.
    const ownerSection = page.locator('[data-role="fixture-replays"]');
    await page.goto(m.fixturePath);
    await expect(ownerSection, "the owner's list").toBeVisible({ timeout: NAV_MS });
    await expect(ownerSection.getByTestId("stream-seazn-replay-download"), "the owner: Download").toHaveCount(1);
    await expect(ownerSection.getByTestId("stream-seazn-replay-delete"), "the owner: Delete").toHaveCount(1);
    await expect(ownerSection.getByTestId("stream-seazn-replays-paused"), "the owner: no line").toHaveCount(0);
  } finally {
    await adminCtx?.close().catch(() => {});
    if (adminId !== null) {
      const id = adminId;
      await withDb((sql) => sql`delete from org_members where org_id = ${org.orgId} and user_id = ${id}`).catch(() => {});
    }
    await finishSeaznMatch(m);
  }
});
