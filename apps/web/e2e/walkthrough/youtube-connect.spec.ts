// YouTube Connect (spec 2026-10-27, plan T20) - the whole feature walked by hand through a REAL production server on the FAKE YouTube
// (YOUTUBE_DRIVER=fake) and the fake relay drivers: connect a channel through consent and the picker, put a match on it, Go live,
// Stop, Go live again, let the end rule run, read the replay on the public page, lose the grant, disconnect.
//
// THIS FILE DECLARES 13 TESTS (EXPECTED_TESTS below): connect x2 widths, connect -> Go live, same video after a Stop, new video after
// a Stop past the grace, the refusal copy, the replay parts, the made-for-kids replay (a link out, decided per broadcast), the
// reconnect-needed badge, Disconnect, Disconnect's three outcomes, two matches on one channel, and the consent links. Every test
// registers itself through `spec()`, and `beforeEach` fails if the count is not 13 - so a deleted or renamed-away test cannot leave a green run that proved less. Each test also states its own premise before
// the action (the row is there BEFORE Disconnect, the sweep has a dead grant to find BEFORE it runs) and reports what it counted:
// a loop that read nothing is a failure, not a pass.
//
// What each assertion reads: the SCREEN (testid / role, copy taken from the dictionaries - never typed, except the one sentence and
// the URLs the spec and Google's policies fix, which are pinned twice: against the constant and as a typed literal), plus the FAKE'S OWN
// view of what happened through its control route (`state`: the broadcasts YouTube holds for the fixture, oldest first, with their
// life). Tokens, streams and videos are addressed only by the handles `state` returns (R6): the fake is one process shared by every
// test in the leg, so a control that names no handle (`reset`, an unscoped `failNext` / `autoVideo`) is never called from here.
//
// HOW TIME IS ADVANCED. The server has no clock override (SessionDeps.now is `new Date()`), so "the match stopped more than the
// grace ago" is made the way the end rule itself reads it: the `ended_at` of the sessions on that broadcast is stamped back past
// `YOUTUBE_GRACE_MINUTES` (imported from lib/youtube, the one declaration server/youtube/end-rule.ts re-exports, so the wait moves with
// the rule). Go live then finds the broadcast DUE and claims it `ending` (prepare.ts
// step 2); no tick is needed for that. The END STEP - what turns a due broadcast into a finished replay part - IS the cron tick, and
// the tick (like the daily relay-sweep) is GLOBAL: it ticks every open session on the server. Two tests need it, so they take the
// WHOLE stream-slot pool first (capture-phone.spec.ts W22's exclusion): while they hold it no other stream test has a session open.
//
// ONE SPORT (generic), by design: nothing under src/server/youtube/ or the connect panel reads a sport (`grep -i sport` finds none) - connect,
// prepare, the end rule, the end step and Disconnect see a fixture, a connection and a broadcast, never a scoring module. Sport coverage belongs
// to the Go live walkthroughs (streaming-destinations, stream-relay); a sport sweep here would repeat one path N times.
// Every rig is a FRESH org on a Pro owner. The walkthrough project runs at one desktop viewport; the Streaming page's phone layout is
// walked once (connect at 320). Layout evidence for the panel, the picker and the replay player lives in the *.shots.spec.ts files.
import { test, expect, type Locator, type Page, type PlaywrightTestArgs, type PlaywrightTestOptions, type PlaywrightWorkerArgs, type PlaywrightWorkerOptions, type Route, type TestInfo, type APIRequestContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll } from "../helpers";
import { setRigPlan, signInAs } from "../overlay-kit";
import { waitForHydration } from "../directory-kit";
import { storeCameraOnly } from "../helpers/stream-mode";
import { selectTarget, targetPicker } from "../helpers/stream-target-picker";
import {
  FAKE_CONNECT_MS,
  POLL_WAIT_MS,
  POOL_SLOT_WAIT_MS,
  cycleMs,
  liveWaitMs,
  releaseStreamSlot,
  takeStreamSlot,
  takeWholePool,
} from "../helpers/stream-slot-pool";
import { disposeFakePhones, pairedPhone } from "../helpers/fake-capture-phone";
import {
  GOOGLE_PRIVACY_URL,
  GOOGLE_THIRD_PARTY_ACCESS_URL,
  YOUTUBE_DEAD_GRANT_PURGE_DAYS,
  YOUTUBE_GRACE_MINUTES,
  YOUTUBE_GUIDELINES_URL,
  YOUTUBE_TOS_URL,
  youtubeWatchUrl,
} from "../../src/lib/youtube";

// ===========================================================================
// The count this file must meet
// ===========================================================================
const EXPECTED_TESTS = 13;
const registered: string[] = [];
type SpecBody = (args: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, info: TestInfo) => Promise<void> | void;
/** `test()`, remembering the name: the guard in `beforeEach` counts what this file REGISTERED, in every worker. */
function spec(name: string, body: SpecBody): void {
  registered.push(name);
  test(name, body);
}
test.beforeEach(() => {
  expect(registered.length, `youtube-connect.spec.ts declares ${EXPECTED_TESTS} tests (see its header); ${registered.length} registered: ${registered.join(" | ")}`).toBe(EXPECTED_TESTS);
});

// ===========================================================================
// Kit (file-local; the streaming-destinations.spec.ts / youtube-panel.shots.spec.ts shapes)
// ===========================================================================
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// Clocks - DERIVED from the constants that set the pace (AGENTS.md class 20), never a flat literal.
const LIVE_WAIT_MS = liveWaitMs(FAKE_CONNECT_MS);
const CYCLE_MS = cycleMs(FAKE_CONNECT_MS);
const SEED_MS = 60_000;
const NAV_MS = 30_000;
/** One mutation round trip: the request and the `router.refresh()` that re-reads the list. */
const SAVE_MS = POLL_WAIT_MS;
const SLOT_WAIT_MS = POOL_SLOT_WAIT_MS;
/** A connect through the fake Google: the start, the authorize hop, the callback and the landing (three navigations). */
const CONNECT_MS = 3 * NAV_MS;
/** The longest this file holds a pool key: the replay test's two go-live -> stop cycles, the tick and its polls. */
const POOL_HOLD = { file: "youtube-connect.spec.ts", holdMs: 2 * CYCLE_MS + 6 * POLL_WAIT_MS } as const;
/** The credits key is stream-credits.spec.ts's, taken for the instant of a global call; a wait of one cycle is the sibling's. */
const CREDITS_KEY_WAIT_MS = CYCLE_MS;
const budget = (c: { navs: number; cycles?: number; slot?: boolean; connects?: number }): number =>
  Math.max(
    90_000,
    (c.slot ? SLOT_WAIT_MS : 0) + SEED_MS + (c.connects ?? 1) * CONNECT_MS + (c.cycles ?? 0) * CYCLE_MS + c.navs * NAV_MS + 30_000,
  );

/** The end rule's grace after a Stop (D4): lib/youtube's own declaration, the one server/youtube/end-rule.ts re-exports. */
const GRACE_MINUTES = ((): number => {
  if (!Number.isInteger(YOUTUBE_GRACE_MINUTES) || YOUTUBE_GRACE_MINUTES <= 0) {
    throw new Error(`YOUTUBE_GRACE_MINUTES is ${YOUTUBE_GRACE_MINUTES}: the spec's "past the grace" has no meaning`);
  }
  return YOUTUBE_GRACE_MINUTES;
})();
/** A Stop this many minutes ago is past the grace: the broadcast is due. */
const PAST_GRACE_MINUTES = GRACE_MINUTES + 1;

// Copy, from the dictionaries themselves.
type Dict = Record<string, string>;
const EN_UI = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Dict;
const en = (key: string, vars: Record<string, string | number> = {}): string => {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (vars[v] === undefined) throw new Error(`${key}: no value for {${v}}`);
    return String(vars[v]);
  });
};

const cronSecret = (): string => {
  const s = process.env.CRON_SECRET?.trim();
  if (!s) throw new Error("CRON_SECRET is not set: export the value the server under test was started with (this file posts the cron tick and the relay sweep)");
  return s;
};

const rigsThisTest: { request: APIRequestContext; orgId: string }[] = [];
const streamSlot = (): Promise<void> => takeStreamSlot(POOL_HOLD);
const wholePool = () => takeWholePool(POOL_HOLD, { creditsKeyWaitMs: CREDITS_KEY_WAIT_MS });

interface SessionRow { id: string; fixture_id: string | null; state: string; ended_at: Date | null; youtube_broadcast_id: string | null; target_id: string }
async function sessionsOf(orgId: string): Promise<SessionRow[]> {
  return withDb(async (sql) => [
    ...(await sql<SessionRow[]>`
      select id, fixture_id, state, ended_at, youtube_broadcast_id, target_id from fixture_stream_sessions where org_id = ${orgId} order by created_at`),
  ]);
}
const ACTIVE = new Set(["requested", "provisioning", "warming", "live", "ending"]);
const TERMINAL = new Set(["completed", "failed"]);

async function teardownStreams(): Promise<void> {
  try {
    for (const { request, orgId } of rigsThisTest.splice(0)) {
      const open = (await sessionsOf(orgId)).filter((s) => ACTIVE.has(s.state));
      for (const s of open) await request.post(`/api/v1/fixtures/${s.fixture_id}/stream-sessions/${s.id}/stop`).catch(() => null);
      if (open.length === 0) continue;
      await expect
        .poll(async () => (await sessionsOf(orgId)).filter((s) => ACTIVE.has(s.state)).length, { timeout: POLL_WAIT_MS })
        .toBe(0)
        .catch(() =>
          withDb((sql) => sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'unknown', ended_at = now()
                               where org_id = ${orgId} and state not in ('completed', 'failed')`),
        );
    }
  } finally {
    await releaseStreamSlot();
  }
}

test.afterEach(async () => {
  // The phones paired for a Go live stop beating before the streams are stopped.
  try {
    await disposeFakePhones();
  } finally {
    await teardownStreams();
  }
});

// ---------------------------------------------------------------------------
// The rig: a Pro owner, a public league of generic matches
// ---------------------------------------------------------------------------
interface Rig {
  orgId: string;
  orgSlug: string;
  tag: string;
  compSlug: string | null;
  divSlug: string | null;
  divisionId: string | null;
  divPath: string | null;
  fixtures: { id: string; no: number }[];
}

/** A fresh org on pro, its owner signed in on `page`. With `entrants`, ONE generic league division too (a destination can only be held
 *  by a match) whose fixtures all store Camera only (R2006: the CI server names a compositor image, so every start would be composed). */
async function seedRig(page: Page, opts: { entrants?: number } = {}): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+ytc-${tag}@resend.dev`;
  const orgSlug = `ytc-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"YT Connect Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"YT Connect Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return newOrgId;
  });
  await signInAs(page, ownerEmail);
  rigsThisTest.push({ request: page.request, orgId });
  const rig: Rig = { orgId, orgSlug, tag, compSlug: null, divSlug: null, divisionId: null, divPath: null, fixtures: [] };
  if (opts.entrants) {
    const request = page.request;
    const label = `YTC ${tag}`;
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: label, visibility: "public" });
    if (comp.status >= 300 || !comp.data) throw new Error(`rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
      name: label.slice(0, 40), sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    if (div.status >= 300 || !div.data) throw new Error(`rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
    const n = opts.entrants;
    const ents = await addEntrantsViaApi(request, div.data.id, Array.from({ length: n }, (_, i) => `Side ${String.fromCharCode(65 + i)} ${tag}`));
    if (ents.status >= 300 || ents.ids.length !== n) throw new Error(`rig: entrants -> ${ents.status}`);
    const { fixtureIds } = await createStageAndGenerate(request, div.data.id);
    expect(fixtureIds.length, "rig: a league's fixture count").toBe((n * (n - 1)) / 2);
    await storeCameraOnly(request, fixtureIds);
    rig.fixtures = await withDb(async (sql) => [...(await sql<Rig["fixtures"]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id} order by fixture_no`)]);
    rig.compSlug = comp.data.slug;
    rig.divSlug = div.data.slug;
    rig.divisionId = div.data.id;
    rig.divPath = `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}`;
  }
  await setRigPlan(orgId, "pro");
  return rig;
}

// ---------------------------------------------------------------------------
// The fake YouTube's control route - handles only
// ---------------------------------------------------------------------------
interface FakeState { connectionId: string | null; tokenHandle: string | null; broadcasts: { videoId: string; life: string; streamId: string | null }[] }

async function fake(page: Page, body: Record<string, unknown>): Promise<unknown> {
  const res = await page.request.post("/api/internal/youtube/fake", { data: body });
  expect(res.status(), `the fake YouTube's control route refused ${String(body.op)}: ${await res.text()}`).toBe(200);
  const json = (await res.json()) as { ok?: boolean; data?: unknown };
  expect(json.ok, `${String(body.op)}: the envelope says ok`).toBe(true);
  return json.data;
}
/** Where YouTube stands for this fixture: its connection, the handle of the connection's token, and its broadcasts, oldest first. */
async function fakeState(page: Page, fixtureId: string): Promise<FakeState> {
  return (await fake(page, { op: "state", fixtureId })) as FakeState;
}
/** The grant's handle, asserted present: a fixture whose destination is not a connected channel and that has no broadcast has none, and an op
 *  scoped to `null` would be unscoped.
 *
 *  `state` resolves the fixture's destination through the same resolver the panel's picker and the phone's start use (`fixtureStreamTarget`:
 *  a saved choice, else the org's oldest live destination), so it names the grant Go live will use even when NOTHING is saved - which is
 *  the case here: with ONE destination the picker shows it chosen and a tap on it is not a pick, so no write is made. This walk never
 *  saves a destination; the unsaved default is the path under test. */
async function handleOf(page: Page, fixtureId: string): Promise<string> {
  const s = await fakeState(page, fixtureId);
  expect(s.tokenHandle, "PREMISE: the fixture's destination is the connected channel, so the fake can name its grant").not.toBeNull();
  return s.tokenHandle!;
}
/** Broadcasts go live the moment they are bound, so they can complete as replay parts. Scoped to the grant's channel. */
async function autoVideoOn(page: Page, tokenHandle: string): Promise<void> {
  await fake(page, { op: "autoVideo", on: true, tokenHandle });
}

// ---------------------------------------------------------------------------
// The Streaming page: connect through the fake Google
// ---------------------------------------------------------------------------
type Chan = { id: string; title: string };
/** Channel ids unique to this run: the fake numbers its fresh channels from 1, and the database outlives it. */
const channel = (title: string): Chan => ({ id: `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`, title });

async function openStreaming(page: Page): Promise<void> {
  await page.goto("/streaming");
  await expect(page.getByTestId("youtube-connect-empty").or(page.getByTestId("youtube-connect")), "the Streaming page rendered its connect control").toBeVisible({ timeout: NAV_MS });
}

/** Tell the fake which channels the NEXT grant has (and, with `sub`, which Google account it is), then take the real consent round trip:
 *  open the consent card, tick the box, Continue. The 303 the start answers with carries the OAuth state; the fake is told about it
 *  before the browser follows (the recipe of youtube-panel.shots.spec.ts's `connectChannel`). `atConsent` runs with the card open and
 *  the box unticked - the place to assert what the card shows before the person has agreed. */
async function connectChannel(
  page: Page,
  channels: Chan[],
  trigger: "youtube-connect" | "youtube-connect-empty",
  opts: { sub?: string; atConsent?: () => Promise<void> } = {},
): Promise<void> {
  let fired = 0;
  const handler = async (route: Route) => {
    const start = await route.fetch({ maxRedirects: 0 });
    expect(start.status(), "SETUP: the start answers with the 303 to the authorize hop").toBe(303);
    const state = new URL(start.headers()["location"] ?? "", "http://localhost").searchParams.get("state");
    expect(state, "SETUP: the start's Location carries the OAuth state").toBeTruthy();
    await fake(page, { op: "setChannels", channels, state });
    if (opts.sub !== undefined) await fake(page, { op: "grantSub", sub: opts.sub, state });
    fired++;
    await route.fulfill({ response: start });
  };
  await page.route("**/api/youtube/connect", handler);
  try {
    // A click on server-rendered markup before React hydrates is DROPPED: the card never opens.
    const opener = page.getByTestId(trigger);
    await waitForHydration(opener);
    await opener.click();
    const submit = page.getByTestId("youtube-connect-submit");
    await expect(submit, "Continue is disabled until the box is ticked").toBeDisabled();
    await opts.atConsent?.();
    await page.getByTestId("youtube-consent").check();
    await Promise.all([page.waitForURL(/\/streaming\?youtube=/), submit.click()]);
    expect(fired, "the channel offer ran once for this connect").toBe(1);
  } finally {
    await page.unroute("**/api/youtube/connect", handler);
  }
}

const channelRows = (page: Page): Locator => page.getByTestId("youtube-channel-row");
const rowTitled = (page: Page, title: string): Locator => channelRows(page).filter({ has: page.getByTestId("youtube-channel-title").filter({ hasText: title }) });

interface TargetRef { id: string; connectionId: string; title: string }
/** Connect ONE channel (the grant offers just it, so the callback lands `connected`) and read its destination off the row. */
async function connectOne(page: Page, c: Chan, trigger: "youtube-connect" | "youtube-connect-empty", opts: { sub?: string; atConsent?: () => Promise<void> } = {}): Promise<TargetRef> {
  await connectChannel(page, [c], trigger, opts);
  const row = rowTitled(page, c.title);
  await expect(row, `the connected channel ${c.title} has its row`).toHaveCount(1, { timeout: NAV_MS });
  const id = await row.getAttribute("data-target-id");
  const connectionId = await row.getAttribute("data-connection-id");
  expect(id, "the row names its destination").toBeTruthy();
  expect(connectionId, "the row names its connection").toBeTruthy();
  return { id: id!, connectionId: connectionId!, title: c.title };
}

// ---------------------------------------------------------------------------
// The fixture's Stream panel
// ---------------------------------------------------------------------------
async function openPhoneTab(page: Page, rig: Rig, no: number): Promise<Locator> {
  await page.goto(`${rig.divPath}/f/${no}`);
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control, `fixture ${no} offers exactly one visible Stream control`).toHaveCount(1, { timeout: NAV_MS });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: NAV_MS });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  await expect(scope.locator("[data-phone-body]")).toBeAttached({ timeout: NAV_MS });
  return scope.locator("[data-phone-body]");
}

/** Pick the connected channel as the match's destination in the panel's picker, and read the closed field back. With one destination this is the
 *  default already showing, so the tap writes nothing (see `handleOf`); with several it is a real pick. */
async function pickChannel(body: Locator, t: TargetRef): Promise<void> {
  await selectTarget(body, t.id);
  await expect(targetPicker(body).getByTestId("stream-target-name"), "the closed field names the picked channel").toHaveText(t.title);
}

async function confirmStop(page: Page): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const ok = dialog.getByRole("button", { name: en("stream.phone.stop"), exact: true });
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(dialog).toHaveCount(0, { timeout: POLL_WAIT_MS });
}

const pill = (body: Locator): Locator => body.getByTestId("stream-state-pill");

/** Go live from the panel and wait for the pill to read live. The premise (Go live is there to press) is asserted first. */
async function goLive(body: Locator): Promise<void> {
  const go = body.getByTestId("stream-go-live");
  await expect(go, "PREMISE: Go live is on offer").toBeEnabled({ timeout: SAVE_MS });
  await go.click();
  await expect(pill(body), "the session is live").toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
}

/** Stop from the panel, and wait until the session is TERMINAL in the database with an ended_at (the end rule reads that). */
async function stopMatch(page: Page, body: Locator, orgId: string, fixtureId: string): Promise<void> {
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(pill(body), "the panel reads ended").toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
  await expect
    .poll(async () => (await sessionsOf(orgId)).filter((s) => s.fixture_id === fixtureId && ACTIVE.has(s.state)).length, {
      message: "the stopped session reaches a terminal state", timeout: CYCLE_MS, intervals: [1_000],
    })
    .toBe(0);
  const mine = (await sessionsOf(orgId)).filter((s) => s.fixture_id === fixtureId);
  expect(mine.length, "PREMISE: the fixture has sessions").toBeGreaterThan(0);
  expect(mine.every((s) => TERMINAL.has(s.state) && s.ended_at !== null), "every session is terminal and stamped with its Stop").toBe(true);
}

/** Back from an ended card to a fresh Go live (the same destination stays chosen). */
async function startAnother(body: Locator, t: TargetRef): Promise<void> {
  await body.getByTestId("stream-again").click();
  await expect(pill(body)).toHaveText(en("stream.phone.state.idle"));
  if ((await targetPicker(body).getAttribute("data-value")) !== t.id) await pickChannel(body, t);
}

/** The Stop was `PAST_GRACE_MINUTES` ago: stamp back the sessions on this broadcast, the way the end rule reads them. Returns how many
 *  sessions it moved - zero is a failure (a rule applied to nothing is the vacuous "it ended"). */
async function agePastGrace(fixtureId: string, videoId: string): Promise<number> {
  const moved = await withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      update fixture_stream_sessions s
         set ended_at = s.ended_at - make_interval(mins => ${PAST_GRACE_MINUTES}::int)
        from youtube_broadcasts b
       where s.youtube_broadcast_id = b.id and b.fixture_id = ${fixtureId} and b.yt_broadcast_id = ${videoId}
         and s.state in ('completed', 'failed') and s.ended_at is not null
       returning s.id`;
    return rows.length;
  });
  expect(moved, `the sessions on ${videoId} were aged past the ${GRACE_MINUTES}-minute grace`).toBeGreaterThan(0);
  return moved;
}

interface BroadcastRow { id: string; yt_broadcast_id: string | null; state: string; connection_id: string }
async function broadcastRows(fixtureId: string): Promise<BroadcastRow[]> {
  return withDb(async (sql) => [
    ...(await sql<BroadcastRow[]>`select id, yt_broadcast_id, state, connection_id from youtube_broadcasts where fixture_id = ${fixtureId} order by created_at, id`),
  ]);
}

/** A rig with a connected channel chosen on fixture 1, a paired phone and the fake told to take video: the state every Go live test starts from.
 *  Takes the stream slot AFTER the choice (nothing is live yet) and before the phone, as the siblings do. */
async function readyToGoLive(page: Page, rig: Rig, c: Chan, opts: { slot?: boolean } = {}): Promise<{ t: TargetRef; body: Locator; handle: string; fixtureId: string }> {
  await openStreaming(page);
  const t = await connectOne(page, c, "youtube-connect-empty");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f.no);
  await pickChannel(body, t);
  const handle = await handleOf(page, f.id);
  await autoVideoOn(page, handle);
  if (opts.slot !== false) await streamSlot();
  await pairedPhone(page); // W5: Go live needs a paired phone
  return { t, body, handle, fixtureId: f.id };
}

// ===========================================================================
// 1-2. connect: consent -> picker -> row (at 1280 and at 320)
// ===========================================================================
for (const width of [1280, 320] as const) {
  spec(`connect @${width}: the consent card (Connect is disabled until ticked) -> two channels lead to the picker -> the picked one is the row, with its name and the Unlisted badge`, async ({ page }) => {
    test.setTimeout(budget({ navs: 6 }));
    await page.setViewportSize({ width, height: width < 768 ? 700 : 900 });
    const rig = await seedRig(page);
    const first = channel(`Riverside FC ${randomBytes(2).toString("hex")}`);
    const second = channel(`Riverside Juniors ${randomBytes(2).toString("hex")}`);

    await openStreaming(page);
    // PREMISE: nothing is connected yet, and the card is closed.
    await expect(channelRows(page), "PREMISE: no channel is connected before the round trip").toHaveCount(0);
    await expect(page.getByTestId("youtube-connect-form"), "PREMISE: the consent card is closed").toHaveCount(0);

    let consentRead = 0;
    await connectChannel(page, [first, second], "youtube-connect-empty", {
      atConsent: async () => {
        // The card's defaults are the safe ones: Unlisted, not made for kids; and until the box is ticked it says what is missing.
        await expect(page.getByTestId("youtube-connect-form")).toBeVisible();
        await expect(page.getByTestId("youtube-privacy-unlisted")).toBeChecked();
        await expect(page.getByTestId("youtube-kids-no")).toBeChecked();
        await expect(page.getByTestId("youtube-consent")).not.toBeChecked();
        await expect(page.getByTestId("youtube-connect-submit")).toBeDisabled();
        await expect(page.getByTestId("youtube-consent-required")).toHaveText(en("streaming.youtube.consent.required"));
        if (width < 768) await expectNoHorizontalScroll(page);
        consentRead++;
      },
    });
    expect(consentRead, "the consent card was read before the box was ticked").toBe(1);

    // Two channels -> the picker (not a row, not the connected banner).
    await expect(page).toHaveURL(/\/streaming\?youtube=pick&pending=[0-9a-f-]{36}$/);
    const picker = page.getByTestId("youtube-picker");
    await expect(picker).toBeVisible({ timeout: NAV_MS });
    const offered = picker.getByTestId("youtube-picker-channel");
    await expect(offered, "the picker offers both of the Google account's channels").toHaveCount(2, { timeout: NAV_MS });
    await expect(channelRows(page), "nothing is connected until a channel is picked").toHaveCount(0);
    await expect(page.getByTestId("youtube-picker-connect"), "Connect is disabled until a channel is chosen").toBeDisabled();
    if (width < 768) await expectNoHorizontalScroll(page);

    // Pick the SECOND (so a picker that connected the first would be seen).
    await offered.nth(1).check();
    await page.getByTestId("youtube-picker-connect").click();
    await expect(channelRows(page), "exactly the one picked channel is a row").toHaveCount(1, { timeout: NAV_MS });
    const row = channelRows(page).first();
    await expect(row.getByTestId("youtube-channel-title"), "the row shows the picked channel's name").toHaveText(second.title);
    await expect(row.getByTestId("youtube-channel-meta"), "the row shows the Unlisted badge").toContainText(en("streaming.youtube.privacy.unlisted"));
    await expect(page.getByTestId("youtube-landing")).toHaveAttribute("data-code", "connected");
    await expect(page.getByTestId("youtube-landing")).toContainText(en("streaming.youtube.landing.connected"));
    await expect(row.getByTestId("youtube-disconnect"), "a connected channel can be disconnected").toBeVisible();
    await expect(page.getByText(first.title), "the channel that was not picked is nowhere on the page").toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // The API is the witness: one destination, the picked channel's, Unlisted, connected.
    const list = await apiJson<{ id: string; youtube: { channelId: string; channelTitle: string; privacy: string; status: string } | null }[]>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`);
    expect(list.status).toBe(200);
    expect(list.data!.map((t) => [t.youtube?.channelId, t.youtube?.channelTitle, t.youtube?.privacy, t.youtube?.status]), "the org's destinations: the one picked channel")
      .toEqual([[second.id, second.title, "unlisted", "connected"]]);
  });
}

// ===========================================================================
// 3. connect -> Go live
// ===========================================================================
spec("connect -> Go live: one channel connected, Go live on it, the session is live and the fake holds ONE bound broadcast for the match", async ({ page }) => {
  test.setTimeout(budget({ navs: 4, cycles: 1, slot: true }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const { t, body, fixtureId } = await readyToGoLive(page, rig, channel(`Riverside FC ${randomBytes(2).toString("hex")}`));

  // PREMISE: before Go live YouTube holds no broadcast for the match, and the org has no session.
  expect((await fakeState(page, fixtureId)).broadcasts, "PREMISE: no broadcast before Go live").toEqual([]);
  expect(await sessionsOf(rig.orgId), "PREMISE: no session before Go live").toEqual([]);

  await goLive(body);

  const sessions = await sessionsOf(rig.orgId);
  expect(sessions.length, "one session").toBe(1);
  expect(sessions[0]!.state).toBe("live");
  expect(sessions[0]!.target_id, "the session streams to the connected channel's destination").toBe(t.id);
  const state = await fakeState(page, fixtureId);
  expect(state.connectionId, "the broadcast is on the connected channel").toBe(t.connectionId);
  expect(state.broadcasts.length, "the fake holds ONE broadcast for the match").toBe(1);
  expect(state.broadcasts[0]!.life, "it is live on YouTube (the fake took video the moment it was bound)").toBe("live");
  const rows = await broadcastRows(fixtureId);
  expect(rows.map((r) => r.yt_broadcast_id), "the database's broadcast is the one YouTube holds").toEqual([state.broadcasts[0]!.videoId]);
  expect(sessions[0]!.youtube_broadcast_id, "the session is bound to that broadcast").toBe(rows[0]!.id);

  // The Streaming page agrees: the channel is held by this match (one open broadcast).
  await openStreaming(page);
  await expect(rowTitled(page, t.title)).toHaveCount(1);
  const view = await apiJson<{ id: string; youtube: { openBroadcasts: number } | null }[]>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`);
  expect(view.data!.find((x) => x.id === t.id)?.youtube?.openBroadcasts, "the connection reports its one open broadcast").toBe(1);
});

// ===========================================================================
// 4. Go live -> Stop -> Go live = the same video
// ===========================================================================
spec("Go live -> Stop -> Go live is the SAME video: the fake's broadcast count stays 1 and the panel shows live", async ({ page }) => {
  test.setTimeout(budget({ navs: 4, cycles: 2, slot: true }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const { t, body, fixtureId } = await readyToGoLive(page, rig, channel(`Riverside FC ${randomBytes(2).toString("hex")}`));

  await goLive(body);
  const first = (await fakeState(page, fixtureId)).broadcasts;
  expect(first.length, "PREMISE: one broadcast after the first Go live").toBe(1);
  const video = first[0]!.videoId;

  await stopMatch(page, body, rig.orgId, fixtureId);
  // PREMISE: the Stop did not end the broadcast - the channel is held for the grace, the video is still live on YouTube.
  expect((await fakeState(page, fixtureId)).broadcasts.map((b) => [b.videoId, b.life]), "PREMISE: the Stop left the video live").toEqual([[video, "live"]]);

  await startAnother(body, t);
  await goLive(body);

  const after = await fakeState(page, fixtureId);
  expect(after.broadcasts.length, "still ONE broadcast on YouTube: nothing was inserted").toBe(1);
  expect(after.broadcasts[0]!.videoId, "the same video").toBe(video);
  expect(after.broadcasts[0]!.life).toBe("live");
  const rows = await broadcastRows(fixtureId);
  expect(rows.length, "and one row of ours").toBe(1);
  const sessions = (await sessionsOf(rig.orgId)).filter((s) => s.fixture_id === fixtureId);
  expect(sessions.length, "two sessions ran").toBe(2);
  expect(new Set(sessions.map((s) => s.youtube_broadcast_id)), "both on the one broadcast").toEqual(new Set([rows[0]!.id]));
  expect(sessions.map((s) => s.state).sort(), "the first is over, the second is live").toEqual(["completed", "live"]);
  await expect(pill(body), "the panel shows live").toHaveText(en("stream.phone.state.live"));
});

// ===========================================================================
// 5. Stop > grace => a NEW video
// ===========================================================================
spec("Stop longer ago than the grace => the next Go live is a NEW video (the fake's count goes 1 -> 2) and the old one is claimed to end", async ({ page }) => {
  test.setTimeout(budget({ navs: 4, cycles: 2, slot: true }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const { t, body, fixtureId } = await readyToGoLive(page, rig, channel(`Riverside FC ${randomBytes(2).toString("hex")}`));

  await goLive(body);
  const video1 = (await fakeState(page, fixtureId)).broadcasts[0]!.videoId;
  await stopMatch(page, body, rig.orgId, fixtureId);
  expect((await broadcastRows(fixtureId)).map((r) => r.state), "PREMISE: inside the grace the broadcast is still open").not.toContain("ending");

  // Time passes: the Stop was longer ago than the end rule's grace.
  const aged = await agePastGrace(fixtureId, video1);
  expect(aged, "the one session on the broadcast was aged").toBe(1);

  await startAnother(body, t);
  await goLive(body);

  const after = await fakeState(page, fixtureId);
  expect(after.broadcasts.length, "a SECOND broadcast was inserted at YouTube").toBe(2);
  expect(after.broadcasts[0]!.videoId, "oldest first: the first video is still the first").toBe(video1);
  const video2 = after.broadcasts[1]!.videoId;
  expect(video2, "the new broadcast is a different video").not.toBe(video1);
  expect(after.broadcasts[1]!.life, "and it is live").toBe("live");
  const rows = await broadcastRows(fixtureId);
  expect(rows.map((r) => r.yt_broadcast_id), "our rows follow YouTube's, oldest first").toEqual([video1, video2]);
  // The due broadcast was claimed by Go live (the end step finishes it at YouTube); a tick that ran in between would have finished it already.
  expect(["ending", "complete"], "the old broadcast is on its way out").toContain(rows[0]!.state);
  const sessions = (await sessionsOf(rig.orgId)).filter((s) => s.fixture_id === fixtureId);
  expect(sessions.map((s) => s.youtube_broadcast_id), "the first session is on the first broadcast, the second on the second").toEqual([rows[0]!.id, rows[1]!.id]);
  await expect(pill(body), "the panel shows live").toHaveText(en("stream.phone.state.live"));
});

// ===========================================================================
// 6. the refusal copy
// ===========================================================================
/** The spec's sentence (design doc section 6.3, `youtube_live_not_enabled`), typed once: the dictionary is pinned to it. */
const LIVE_NOT_ENABLED_SENTENCE = "This channel isn't enabled for live yet. YouTube can take up to 24 hours.";

spec("refusal copy: a channel not enabled for live - Go live shows the spec's sentence, no session exists, and the channel goes live once YouTube allows it", async ({ page }) => {
  test.setTimeout(budget({ navs: 4, cycles: 1, slot: true }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const { t, body, handle, fixtureId } = await readyToGoLive(page, rig, channel(`Riverside FC ${randomBytes(2).toString("hex")}`));

  expect(en("stream.error.youtube_live_not_enabled"), "the dictionary carries the spec's sentence").toBe(LIVE_NOT_ENABLED_SENTENCE);
  // YouTube refuses the next broadcast insert on THIS channel with liveStreamingNotEnabled (scoped to the grant - the fake is shared).
  await fake(page, { op: "failNext", method: "insertBroadcast", code: "youtube_live_not_enabled", tokenHandle: handle });
  await expect(body.getByTestId("stream-youtube-refusal"), "PREMISE: no refusal is showing before Go live").toHaveCount(0);

  await body.getByTestId("stream-go-live").click();
  const block = body.getByTestId("stream-youtube-refusal");
  await expect(block, "the refusal block replaces Go live").toBeVisible({ timeout: SAVE_MS });
  await expect(block).toHaveAttribute("data-code", "youtube_live_not_enabled");
  await expect(body.getByTestId("stream-create-error"), "the spec's sentence").toHaveText(LIVE_NOT_ENABLED_SENTENCE);
  await expect(body.getByTestId("stream-go-live"), "Go live is gone while the refusal stands").toHaveCount(0);
  await expect(block).toContainText(en("stream.youtube.refused.nothing"));
  expect(await sessionsOf(rig.orgId), "no session exists").toEqual([]);
  expect((await fakeState(page, fixtureId)).broadcasts, "and YouTube holds no broadcast for the match").toEqual([]);

  // The sequence after a refusal: "Use another destination" clears it, and the SAME channel goes live once YouTube lets it (the refusal
  // was one failure, spent; it did not leave the channel stuck).
  await body.getByTestId("stream-youtube-pick-another").click();
  await expect(body.getByTestId("stream-youtube-refusal")).toHaveCount(0);
  await pickChannel(body, t);
  await goLive(body);
  const after = await fakeState(page, fixtureId);
  expect(after.broadcasts.length, "the retry made the match's one broadcast").toBe(1);
  expect((await sessionsOf(rig.orgId)).map((s) => s.state)).toEqual(["live"]);
});

// ===========================================================================
// 7. replay parts on the public page
// ===========================================================================
spec("replay links: two parts (a Stop past the grace, then a second video) are Part 1 and Part 2 on the public match page", async ({ page }) => {
  test.setTimeout(budget({ navs: 6, cycles: 2, slot: true }) + CREDITS_KEY_WAIT_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const f = rig.fixtures[0]!;
  // The tick below is GLOBAL (it ticks every open session on the server): take the WHOLE pool first, so no other test has one open.
  await openStreaming(page);
  const t = await connectOne(page, channel(`Riverside FC ${randomBytes(2).toString("hex")}`), "youtube-connect-empty");
  const body = await openPhoneTab(page, rig, f.no);
  await pickChannel(body, t);
  await autoVideoOn(page, await handleOf(page, f.id));
  const exclusive = await wholePool();
  const poolFrom = Date.now();
  await pairedPhone(page);

  // Part 1.
  await goLive(body);
  const video1 = (await fakeState(page, f.id)).broadcasts[0]!.videoId;
  await stopMatch(page, body, rig.orgId, f.id);
  await agePastGrace(f.id, video1);
  // Part 2: a NEW video.
  await startAnother(body, t);
  await goLive(body);
  const both = (await fakeState(page, f.id)).broadcasts;
  expect(both.length, "PREMISE: two videos on YouTube").toBe(2);
  const [v1, v2] = [both[0]!.videoId, both[1]!.videoId];
  expect(v1).toBe(video1);
  await stopMatch(page, body, rig.orgId, f.id);
  await agePastGrace(f.id, v2);

  // PREMISE: neither is a replay yet - the end step has not run.
  expect((await broadcastRows(f.id)).map((r) => r.state).filter((s) => s === "complete"), "PREMISE: no part is complete before the end step").toEqual([]);

  // The END STEP is the cron tick. Global: it runs once every key is ours and no other test has a session open.
  const credits = await exclusive.credits();
  try {
    const others = await withDb((sql) => sql<{ id: string }[]>`
      select id from fixture_stream_sessions where org_id <> ${rig.orgId} and state not in ('completed', 'failed')`);
    expect(others, "the global tick can reach no other test's session").toEqual([]);
    const tick = await page.request.post("/api/cron/stream-tick", { headers: { "x-cron-secret": cronSecret() } });
    expect(tick.status(), "the cron tick runs").toBe(200);
    const answer = (await tick.json()) as { data?: { youtube?: { ended?: number; failed?: number } } };
    // The counters are the whole SERVER's (every org's due broadcast), so a database that other suites have used carries failures this test
    // did not cause; what is asserted is the end step's reach (at least these two ended) and, below, THIS org's own two broadcasts.
    expect(answer.data?.youtube, "the tick reports its YouTube end step").toBeDefined();
    expect(answer.data!.youtube!.ended ?? 0, "the end step completed at least these two broadcasts").toBeGreaterThanOrEqual(2);
    test.info().annotations.push({ type: "end step", description: `ended ${answer.data!.youtube!.ended}, failed ${answer.data!.youtube!.failed} (server-wide)` });
  } finally {
    await credits.release();
    test.info().annotations.push({
      type: "replay pool",
      description: `waited ${exclusive.waitedMs} ms for the whole pool holding nothing; held it ${Date.now() - poolFrom} ms to the end of the tick (teardown releases it)`,
    });
  }
  await expect
    .poll(async () => (await broadcastRows(f.id)).map((r) => r.state), { message: "both broadcasts are complete parts", timeout: POLL_WAIT_MS })
    .toEqual(["complete", "complete"]);
  expect((await fakeState(page, f.id)).broadcasts.map((b) => b.life), "and YouTube completed both").toEqual(["complete", "complete"]);

  // The visitor: a published division, signed out. (The division is released by hand - the stage start has its own walkthroughs.)
  await withDb((sql) => sql`update divisions set status = 'active' where id = ${rig.divisionId!}`);
  await page.context().clearCookies();
  // Nothing is fetched from Google's hosts: the facade's picture is stubbed, and the player is never mounted (no tap).
  await page.route("https://i.ytimg.com/vi/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><rect width="480" height="360" fill="#16342a"/></svg>' }));
  await page.goto(`/shared/${rig.orgSlug}/${rig.compSlug}/${rig.divSlug}/fixtures/${f.id}`, { waitUntil: "load" });
  const player = page.getByTestId("replay-embed");
  await expect(player, "the public match page carries the replay player").toBeVisible({ timeout: NAV_MS });
  const tabs = player.getByRole("tab");
  await expect(tabs, "two parts: a tab rail with two tabs").toHaveCount(2);
  await expect(tabs.nth(0)).toHaveText(en("streaming.youtube.part", { n: 1 }));
  await expect(tabs.nth(1)).toHaveText(en("streaming.youtube.part", { n: 2 }));
  await expect(tabs.nth(0), "Part 1 is showing").toHaveAttribute("aria-selected", "true");
  await expect(player.getByTestId("replay-open"), "Part 1 opens the FIRST video").toHaveAttribute("href", youtubeWatchUrl(v1));
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(player.getByTestId("replay-open"), "Part 2 opens the SECOND video").toHaveAttribute("href", youtubeWatchUrl(v2));
  await expect(player.getByTestId("replay-facade"), "a part is a click-to-play facade, never an autoplaying iframe").toBeVisible();
  await expect(player.locator("iframe"), "no player is mounted until a tap").toHaveCount(0);
  expect(v1, "the two parts are two videos").not.toBe(v2);
});

// ===========================================================================
// 7b. a made-for-kids replay is a link out - decided per broadcast, per part (owner 2026-10-29; Google Developer Policies III.E.4.j)
// ===========================================================================
spec("made-for-kids replay: a part made while the channel was declared made-for-kids is a link to YouTube on the public page (no player, no thumbnail) at 1280 and 320; after the channel is flipped to not-for-kids the next part embeds and the first STILL links out", async ({ page, context }) => {
  test.setTimeout(budget({ navs: 12, cycles: 2, slot: true }) + CREDITS_KEY_WAIT_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const f = rig.fixtures[0]!;

  // The channel is declared MADE FOR KIDS at the consent card - the real producer of the connection's flag, not a row written by hand.
  await openStreaming(page);
  const chan = channel(`Riverside Juniors ${randomBytes(2).toString("hex")}`);
  const metaOf = (title: string, kids: boolean, p: Page): Promise<void> =>
    expect(rowTitled(p, title).getByTestId("youtube-channel-meta"), `the row says ${kids ? "made" : "not made"} for kids`)
      .toHaveText(`${en("streaming.youtube.privacy.unlisted")} · ${en(kids ? "streaming.youtube.row.kidsYes" : "streaming.youtube.row.kidsNo")}`, { timeout: SAVE_MS });
  const t = await connectOne(page, chan, "youtube-connect-empty", {
    atConsent: async () => {
      await expect(page.getByTestId("youtube-kids-no"), "PREMISE: the card's default is not made for kids").toBeChecked();
      await page.getByTestId("youtube-kids-yes").check();
    },
  });
  await metaOf(chan.title, true, page);

  const body = await openPhoneTab(page, rig, f.no);
  await pickChannel(body, t);
  await autoVideoOn(page, await handleOf(page, f.id));
  // The tick below is GLOBAL: the whole pool first, so no other test has a session open (replay links, above).
  const exclusive = await wholePool();
  const poolFrom = Date.now();
  await pairedPhone(page);

  // Part 1 - made while the channel is declared made for kids.
  await goLive(body);
  const v1 = (await fakeState(page, f.id)).broadcasts[0]!.videoId;
  await stopMatch(page, body, rig.orgId, f.id);
  await agePastGrace(f.id, v1);

  // The organiser flips the channel to NOT made for kids (Settings on the Streaming page, in a second tab so the match's panel stays put).
  // The connection moves; the broadcast already made keeps what it was made with.
  const settingsTab = await context.newPage();
  try {
    await openStreaming(settingsTab);
    const settingsRow = rowTitled(settingsTab, chan.title);
    await settingsRow.getByTestId("youtube-settings").click();
    await settingsRow.getByTestId("youtube-kids-no").check();
    await settingsRow.getByTestId("youtube-settings-save").click();
    await metaOf(chan.title, false, settingsTab);
  } finally {
    await settingsTab.close();
  }

  // Part 2 - a NEW video, made after the flip.
  await startAnother(body, t);
  await goLive(body);
  const both = (await fakeState(page, f.id)).broadcasts;
  expect(both.length, "PREMISE: two videos on YouTube").toBe(2);
  expect(both[0]!.videoId, "the first video is still the first").toBe(v1);
  const v2 = both[1]!.videoId;
  expect(v2, "the second part is a different video").not.toBe(v1);
  // The witness is a READ of the rows the producers wrote: each broadcast carries what it was made with.
  const stamps = await withDb((sql) => sql<{ yt_broadcast_id: string; made_for_kids: boolean }[]>`
    select yt_broadcast_id, made_for_kids from youtube_broadcasts where fixture_id = ${f.id} order by created_at, id`);
  expect(stamps.map((r) => [r.yt_broadcast_id, r.made_for_kids]), "part 1 was made for kids, part 2 was not: the flag follows the broadcast, not the connection").toEqual([[v1, true], [v2, false]]);
  await stopMatch(page, body, rig.orgId, f.id);
  await agePastGrace(f.id, v2);

  // The END STEP is the cron tick (global; the pool is ours).
  const credits = await exclusive.credits();
  try {
    const others = await withDb((sql) => sql<{ id: string }[]>`
      select id from fixture_stream_sessions where org_id <> ${rig.orgId} and state not in ('completed', 'failed')`);
    expect(others, "the global tick can reach no other test's session").toEqual([]);
    const tick = await page.request.post("/api/cron/stream-tick", { headers: { "x-cron-secret": cronSecret() } });
    expect(tick.status(), "the cron tick runs").toBe(200);
  } finally {
    await credits.release();
    test.info().annotations.push({
      type: "made-for-kids pool",
      description: `waited ${exclusive.waitedMs} ms for the whole pool holding nothing; held it ${Date.now() - poolFrom} ms to the end of the tick (teardown releases it)`,
    });
  }
  await expect
    .poll(async () => (await broadcastRows(f.id)).map((r) => r.state), { message: "both broadcasts are complete parts", timeout: POLL_WAIT_MS })
    .toEqual(["complete", "complete"]);
  // The end step ORs YouTube's own answer in and never clears the flag: the stamps are what they were.
  const after = await withDb((sql) => sql<{ yt_broadcast_id: string; made_for_kids: boolean }[]>`
    select yt_broadcast_id, made_for_kids from youtube_broadcasts where fixture_id = ${f.id} order by created_at, id`);
  expect(after.map((r) => [r.yt_broadcast_id, r.made_for_kids]), "completing the parts moved no flag").toEqual([[v1, true], [v2, false]]);

  // The visitor: a published division, signed out. What the browser FETCHES is recorded (the thumbnail host stays stubbed as in the sibling).
  await withDb((sql) => sql`update divisions set status = 'active' where id = ${rig.divisionId!}`);
  await page.context().clearCookies();
  await page.route("https://i.ytimg.com/vi/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><rect width="480" height="360" fill="#16342a"/></svg>' }));
  const googleFetches: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (host === "i.ytimg.com" || host.endsWith("youtube-nocookie.com") || host.endsWith("youtube.com")) googleFetches.push(r.url());
  });

  let widthsRead = 0;
  for (const width of [1280, 320] as const) {
    await page.setViewportSize({ width, height: width < 768 ? 700 : 900 });
    googleFetches.length = 0;
    await page.goto(`/shared/${rig.orgSlug}/${rig.compSlug}/${rig.divSlug}/fixtures/${f.id}`, { waitUntil: "load" });
    const player = page.getByTestId("replay-embed");
    await expect(player, `@${width}: the public match page carries the replay section`).toBeVisible({ timeout: NAV_MS });
    const tabs = player.getByRole("tab");
    await expect(tabs, `@${width}: two parts, two tabs`).toHaveCount(2);
    await expect(tabs.nth(0), `@${width}: Part 1 is showing`).toHaveAttribute("aria-selected", "true");

    // Part 1 (made for kids): the link-out card and nothing else.
    const card = player.getByTestId("replay-linkout");
    await expect(card, `@${width}: Part 1 is the link-out card`).toBeVisible();
    await expect(player.getByTestId("replay-facade"), `@${width}: no facade play button for a made-for-kids part`).toHaveCount(0);
    await expect(player.locator("iframe"), `@${width}: no player frame`).toHaveCount(0);
    await expect(player.locator("img"), `@${width}: no thumbnail`).toHaveCount(0);
    await expect(card).toContainText(en("streaming.youtube.replay.madeForKids"));
    const open = card.getByTestId("replay-linkout-open");
    await expect(open, `@${width}: the one link is to the FIRST video on YouTube`).toHaveAttribute("href", youtubeWatchUrl(v1));
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await expect(open).toContainText(en("streaming.youtube.replay.watch"));
    await expect(player.getByRole("tabpanel").locator("a"), `@${width}: exactly one link in the part`).toHaveCount(1);
    expect(googleFetches, `@${width}: the browser fetched nothing from YouTube's hosts for a made-for-kids part`).toEqual([]);
    // Real tap area and no overflow: the link is at least 44px tall, is what a tap at its centre hits, and the card sits inside the viewport.
    const box = (await open.boundingBox())!;
    expect(box.height, `@${width}: the link is a 44px target`).toBeGreaterThanOrEqual(44);
    const hit = await open.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top !== null && el.contains(top);
    });
    expect(hit, `@${width}: a tap at the link's centre lands on the link`).toBe(true);
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.x, `@${width}: the card starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width, `@${width}: the card ends inside the viewport`).toBeLessThanOrEqual(width);
    await expectNoHorizontalScroll(page);

    // Part 2 (made after the flip): the player's facade, the thumbnail, no link-out - the same page decides per part.
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(player.getByTestId("replay-facade"), `@${width}: Part 2 is the click-to-play facade`).toBeVisible();
    await expect(player.getByTestId("replay-linkout"), `@${width}: Part 2 is not a link-out`).toHaveCount(0);
    await expect(player.getByTestId("replay-open"), `@${width}: Part 2 opens the SECOND video`).toHaveAttribute("href", youtubeWatchUrl(v2));
    await expect(player.locator("iframe"), `@${width}: no player is mounted until a tap`).toHaveCount(0);
    // The positive pair of the "fetched nothing" claim above: this probe does see the thumbnail request when a part IS embedded.
    await expect.poll(() => googleFetches.filter((u) => u.startsWith("https://i.ytimg.com/")).length, { message: `@${width}: the embedded part fetched its thumbnail`, timeout: POLL_WAIT_MS }).toBeGreaterThan(0);

    // And back: the first part STILL links out - the flip moved the connection, not the part.
    await tabs.nth(0).click();
    await expect(card, `@${width}: Part 1 still links out`).toBeVisible();
    await expect(open).toHaveAttribute("href", youtubeWatchUrl(v1));
    widthsRead++;
  }
  expect(widthsRead, "both widths were read").toBe(2);
});

// ===========================================================================
// 8. reconnect needed
// ===========================================================================
spec("reconnect needed badge: the grant is killed at Google, the daily sweep finds it, and the row says Reconnect needed with the 7-day deletion warning", async ({ page }) => {
  test.setTimeout(budget({ navs: 5, slot: true }) + CREDITS_KEY_WAIT_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const f = rig.fixtures[0]!;
  await openStreaming(page);
  const t = await connectOne(page, channel(`Riverside FC ${randomBytes(2).toString("hex")}`), "youtube-connect-empty");
  const body = await openPhoneTab(page, rig, f.no);
  await pickChannel(body, t);
  const handle = await handleOf(page, f.id);

  // PREMISE: before the grant dies the row is healthy - no Reconnect, no purge warning.
  await openStreaming(page);
  const row = rowTitled(page, t.title);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("youtube-channel-status"), "PREMISE: the row is not asking for a reconnect").not.toHaveText(en("streaming.youtube.status.reconnectNeeded"));
  await expect(row.getByTestId("youtube-reconnect"), "PREMISE: no Reconnect button yet").toHaveCount(0);
  await expect(row.getByTestId("youtube-channel-purge"), "PREMISE: no deletion warning yet").toHaveCount(0);

  // The sweep is GLOBAL (it ticks every open session): the whole pool first.
  const exclusive = await wholePool();
  const credits = await exclusive.credits();
  try {
    const others = await withDb((sql) => sql<{ id: string }[]>`
      select id from fixture_stream_sessions where org_id <> ${rig.orgId} and state not in ('completed', 'failed')`);
    expect(others, "the global sweep can reach no other test's session").toEqual([]);
    await fake(page, { op: "killToken", tokenHandle: handle });
    const sweep = await page.request.post("/api/cron/relay-sweep", { headers: { "x-cron-secret": cronSecret() } });
    expect(sweep.status(), "the daily sweep runs").toBe(200);
    const answer = (await sweep.json()) as { data?: { youtube?: { checked?: number; reconnectNeeded?: number } } };
    expect(answer.data?.youtube, "the sweep reports its YouTube pass").toBeDefined();
    expect(answer.data!.youtube!.reconnectNeeded ?? 0, "the pass found the dead grant").toBeGreaterThanOrEqual(1);
  } finally {
    await credits.release();
  }

  await openStreaming(page);
  const after = rowTitled(page, t.title);
  await expect(after).toHaveCount(1);
  await expect(after.getByTestId("youtube-channel-status"), "the badge").toHaveText(en("streaming.youtube.status.reconnectNeeded"));
  await expect(after).toHaveAttribute("data-tone", "bad");
  await expect(after.getByTestId("youtube-reconnect"), "Reconnect is on offer").toBeVisible();
  // The warning names the purge clock: the number is the code's constant, and it is 7 (PO ruling, T19 fix round 1).
  await expect(after.getByTestId("youtube-channel-purge")).toHaveText(en("streaming.youtube.statusLine.reconnectPurge", { days: YOUTUBE_DEAD_GRANT_PURGE_DAYS }));
  expect(YOUTUBE_DEAD_GRANT_PURGE_DAYS, "the purge is seven days").toBe(7);
  await expect(after.getByTestId("youtube-channel-purge")).toContainText("7 days");
  const status = await withDb((sql) => sql<{ status: string }[]>`select status from org_youtube_connections where id = ${t.connectionId}`);
  expect(status.map((r) => r.status), "the connection is reconnect_needed in the database").toEqual(["reconnect_needed"]);
});

// ===========================================================================
// 9. Disconnect
// ===========================================================================
const disconnectDialog = (page: Page): Locator => page.getByRole("alertdialog");
async function tapDisconnect(page: Page, row: Locator, title: string): Promise<void> {
  await row.getByTestId("youtube-disconnect").click();
  const dialog = disconnectDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(en("streaming.youtube.disconnect.title", { name: title }));
  await dialog.getByRole("button", { name: en("streaming.youtube.disconnect.confirm"), exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: SAVE_MS });
}

spec("disconnect: refused while the match is live AND inside the grace after its Stop; once the end is due the disconnect succeeds, the row is gone and what Seazn stored from YouTube is purged", async ({ page }) => {
  test.setTimeout(budget({ navs: 8, cycles: 1, slot: true }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const { t, body, fixtureId } = await readyToGoLive(page, rig, channel(`Riverside FC ${randomBytes(2).toString("hex")}`));
  await goLive(body);
  const video = (await fakeState(page, fixtureId)).broadcasts[0]!.videoId;

  // 1. LIVE: refused, nothing changed.
  await openStreaming(page);
  let row = rowTitled(page, t.title);
  await expect(row, "PREMISE: the channel's row is there before Disconnect").toHaveCount(1);
  await tapDisconnect(page, row, t.title);
  await expect(row.getByTestId("youtube-error"), "the refusal is a sentence in the row").toHaveText(en("streaming.youtube.error.inUse"));
  await expect(rowTitled(page, t.title), "the channel is still connected").toHaveCount(1);
  await expect(page.getByTestId("youtube-disconnected"), "no disconnected notice").toHaveCount(0);
  expect((await withDb((sql) => sql<{ status: string }[]>`select status from org_youtube_connections where id = ${t.connectionId}`)).map((r) => r.status)).toEqual(["connected"]);
  expect((await fakeState(page, fixtureId)).broadcasts.map((b) => b.life), "YouTube's broadcast was not touched").toEqual(["live"]);

  // 2. INSIDE THE GRACE: the match has stopped, the channel is still held for a few minutes - still refused.
  const panel = await openPhoneTab(page, rig, rig.fixtures[0]!.no);
  await stopMatch(page, panel, rig.orgId, fixtureId);
  await openStreaming(page);
  row = rowTitled(page, t.title);
  await tapDisconnect(page, row, t.title);
  await expect(row.getByTestId("youtube-error"), "still held inside the grace").toHaveText(en("streaming.youtube.error.inUse"));
  await expect(rowTitled(page, t.title)).toHaveCount(1);

  // 3. PAST THE GRACE: the end is due, so the channel is free.
  await agePastGrace(fixtureId, video);
  await page.reload();
  row = rowTitled(page, t.title);
  await expect(row).toHaveCount(1);
  await tapDisconnect(page, row, t.title);
  const notice = page.getByTestId("youtube-disconnected");
  await expect(notice, "the page says what became of the channel").toBeVisible({ timeout: SAVE_MS });
  await expect(notice).toHaveAttribute("data-outcome", "revoked");
  await expect(notice).toContainText(en("streaming.youtube.disconnect.done", { name: t.title }));
  await expect(rowTitled(page, t.title), "the row is gone").toHaveCount(0, { timeout: SAVE_MS });
  await expect(channelRows(page), "and no channel is left").toHaveCount(0);

  // What Seazn stored from YouTube is gone: the connection is revoked, its broadcasts and keys are deleted. (That Disconnect also completes the
  // still-live video at YouTube is disconnect.test.ts's, against the fake's own `inspectBroadcast`: the control route's `state` reads OUR
  // broadcast rows, so once they are purged it has nothing left to say about the video, and the walkthrough does not claim it.)
  const conn = await withDb((sql) => sql<{ status: string; channel_id: string | null }[]>`select status, channel_id from org_youtube_connections where id = ${t.connectionId}`);
  expect(conn.map((c) => [c.status, c.channel_id]), "the connection is revoked and its channel id scrubbed").toEqual([["revoked", null]]);
  expect(await broadcastRows(fixtureId), "the broadcast rows are purged").toEqual([]);
  const keys = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from youtube_stream_keys where connection_id = ${t.connectionId}`);
  expect(keys[0]!.n, "and so are the pooled stream keys").toBe(0);
});

// ===========================================================================
// 10. Disconnect's three outcomes
// ===========================================================================
spec("disconnect outcomes: a Google account another channel still uses keeps its grant, and a revoke Google would not confirm points the organiser at Google - each its own notice", async ({ page }) => {
  test.setTimeout(budget({ navs: 6, connects: 2 }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const f = rig.fixtures[0]!;
  const sub = `acct-${randomUUID()}`;
  const chA = channel(`Riverside FC ${randomBytes(2).toString("hex")}`);
  const chB = channel(`Riverside Juniors ${randomBytes(2).toString("hex")}`);
  await openStreaming(page);
  const a = await connectOne(page, chA, "youtube-connect-empty", { sub });
  const b = await connectOne(page, chB, "youtube-connect", { sub });
  await expect(channelRows(page), "PREMISE: two channels on ONE Google account").toHaveCount(2);

  // Channel A is the match's destination (the org's oldest, so the default; the pick below confirms the picker shows it).
  const body = await openPhoneTab(page, rig, f.no);
  await pickChannel(body, a);
  const handleA = await handleOf(page, f.id);
  expect((await fakeState(page, f.id)).connectionId, "PREMISE: the grant the fake names is channel A's, not B's").toBe(a.connectionId);
  await openStreaming(page);

  // B first: A still runs on the same account, so Seazn keeps the grant and says why.
  await tapDisconnect(page, rowTitled(page, chB.title), chB.title);
  let notice = page.getByTestId("youtube-disconnected");
  await expect(notice).toBeVisible({ timeout: SAVE_MS });
  await expect(notice).toHaveAttribute("data-outcome", "skipped_shared_account");
  await expect(notice).toContainText(en("streaming.youtube.disconnect.doneShared", { name: chB.title }));
  await expect(notice.getByTestId("youtube-disconnected-google-link"), "a grant left on purpose needs no Google link").toHaveCount(0);
  await expect(rowTitled(page, chB.title)).toHaveCount(0, { timeout: SAVE_MS });
  await expect(rowTitled(page, chA.title), "A is untouched").toHaveCount(1);
  const bRow = await withDb((sql) => sql<{ status: string; last_error_code: string | null }[]>`select status, last_error_code from org_youtube_connections where id = ${b.connectionId}`);
  expect(bRow.map((r) => [r.status, r.last_error_code]), "B is revoked locally, with the skip recorded").toEqual([["revoked", "revoke_skipped_shared_grant"]]);
  await notice.getByTestId("youtube-disconnected-dismiss").click();
  await expect(notice).toHaveCount(0);

  // A now: it is the only channel on the account, so Seazn asks Google to revoke - and Google does not answer.
  await fake(page, { op: "failNext", method: "revoke", code: "youtube_unavailable", tokenHandle: handleA });
  await tapDisconnect(page, rowTitled(page, chA.title), chA.title);
  notice = page.getByTestId("youtube-disconnected");
  await expect(notice).toBeVisible({ timeout: SAVE_MS });
  await expect(notice).toHaveAttribute("data-outcome", "not_confirmed");
  await expect(notice, "an unconfirmed revoke is an alert").toHaveAttribute("role", "alert");
  await expect(notice, "the sentence names what Seazn could not confirm and where to do it").toContainText(
    en("streaming.youtube.disconnect.doneUnconfirmed", { name: chA.title, link: en("streaming.youtube.disconnect.googleLink") }),
  );
  const link = notice.getByTestId("youtube-disconnected-google-link");
  await expect(link, "the notice links the organiser to their Google account's third-party access page").toHaveAttribute("href", GOOGLE_THIRD_PARTY_ACCESS_URL);
  await expect(link).toHaveAttribute("href", "https://security.google.com/settings/security/permissions");
  await expect(rowTitled(page, chA.title)).toHaveCount(0, { timeout: SAVE_MS });
  await expect(channelRows(page), "no channel is left").toHaveCount(0);
});

// ===========================================================================
// 11. two matches on one channel
// ===========================================================================
spec("two matches on one channel: both go live together, each on its own broadcast and key, and neither is refused as target_in_use", async ({ page, context }) => {
  test.setTimeout(budget({ navs: 6, cycles: 1, slot: true }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 3 });
  const [f1, f2] = [rig.fixtures[0]!, rig.fixtures[1]!];
  expect(rig.fixtures.length, "PREMISE: three matches in the league").toBe(3);
  await openStreaming(page);
  const t = await connectOne(page, channel(`Riverside FC ${randomBytes(2).toString("hex")}`), "youtube-connect-empty");

  // Match 1 on this tab, match 2 on another tab of the same browser (one organiser, two courts).
  const page2 = await context.newPage();
  await page2.setViewportSize({ width: 1280, height: 900 });
  const body1 = await openPhoneTab(page, rig, f1.no);
  const body2 = await openPhoneTab(page2, rig, f2.no);
  await pickChannel(body1, t);
  await pickChannel(body2, t);
  const handle = await handleOf(page, f1.id);
  expect(await handleOf(page, f2.id), "both matches name the same grant").toBe(handle);
  await autoVideoOn(page, handle);
  await streamSlot();
  await pairedPhone(page);
  await pairedPhone(page2);

  // Both Go live presses are answered by the sessions route; neither may be TARGET_IN_USE.
  const answers: { status: number; code: string | undefined }[] = [];
  for (const p of [page, page2]) {
    p.on("response", async (r) => {
      if (r.request().method() === "POST" && /\/api\/v1\/fixtures\/[^/]+\/stream-sessions$/.test(r.url())) {
        const j = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
        answers.push({ status: r.status(), code: j.error?.code });
      }
    });
  }
  await Promise.all([goLive(body1), goLive(body2)]);

  expect(answers.length, "both Go live presses reached the sessions route").toBe(2);
  expect(answers.map((a) => a.code), "no TARGET_IN_USE (a channel is not a pasted key)").toEqual([undefined, undefined]);
  expect(answers.every((a) => a.status < 300), `both answered 2xx (${JSON.stringify(answers)})`).toBe(true);
  await expect(body1.getByTestId("stream-create-error")).toHaveCount(0);
  await expect(body2.getByTestId("stream-create-error")).toHaveCount(0);
  const s1 = await fakeState(page, f1.id);
  const s2 = await fakeState(page, f2.id);
  expect(s1.connectionId, "both on the one connected channel").toBe(t.connectionId);
  expect(s2.connectionId).toBe(t.connectionId);
  expect(s1.broadcasts.length, "match 1 has its own broadcast").toBe(1);
  expect(s2.broadcasts.length, "match 2 has its own broadcast").toBe(1);
  expect(s1.broadcasts[0]!.videoId, "two different videos").not.toBe(s2.broadcasts[0]!.videoId);
  expect(s1.broadcasts[0]!.streamId, "on two different stream keys").not.toBe(s2.broadcasts[0]!.streamId);
  expect([s1.broadcasts[0]!.life, s2.broadcasts[0]!.life], "both live on YouTube").toEqual(["live", "live"]);
  const sessions = (await sessionsOf(rig.orgId)).filter((s) => ACTIVE.has(s.state));
  expect(sessions.map((s) => s.state), "two sessions live at once").toEqual(["live", "live"]);
  expect(new Set(sessions.map((s) => s.target_id)), "on one destination").toEqual(new Set([t.id]));
});

// ===========================================================================
// 12. the consent links
// ===========================================================================
spec("consent links: every link the consent card renders is read from the page - each path of ours returns 200 and each external link is one of the two pinned YouTube URLs, in a new tab (external pages are not fetched); the privacy page's YouTube section links Google's policy, the revocation page and the terms at the exact URLs", async ({ page }) => {
  test.setTimeout(budget({ navs: 5 }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedRig(page);

  // The URLs are the code's constants, and each is pinned to the URL the policy fixes (a constant changed in one place moves only one).
  expect(YOUTUBE_TOS_URL).toBe("https://www.youtube.com/t/terms");
  expect(GOOGLE_PRIVACY_URL, "Google's privacy policy exactly as Developer Policies III.A.2 spell it").toBe("http://www.google.com/policies/privacy");
  expect(GOOGLE_THIRD_PARTY_ACCESS_URL).toBe("https://security.google.com/settings/security/permissions");
  expect(YOUTUBE_GUIDELINES_URL).toBe("https://www.youtube.com/t/community_guidelines");

  // 1. The consent card, where the person agrees.
  await openStreaming(page);
  const opener = page.getByTestId("youtube-connect-empty");
  await waitForHydration(opener);
  await opener.click();
  const card = page.getByTestId("youtube-connect-form");
  await expect(card).toBeVisible();
  let cardLinks = 0;
  for (const [href, minimum] of [[YOUTUBE_TOS_URL, 2], [YOUTUBE_GUIDELINES_URL, 1]] as const) {
    const links = card.locator(`a[href="${href}"]`);
    expect(await links.count(), `the consent card links ${href}`).toBeGreaterThanOrEqual(minimum);
    for (const l of await links.all()) {
      await expect(l, `${href} opens in a new tab without handing over the opener`).toHaveAttribute("target", "_blank");
      await expect(l).toHaveAttribute("rel", /noopener/);
      cardLinks++;
    }
  }
  expect(cardLinks, "the card's external links were read").toBeGreaterThanOrEqual(3);

  // EVERY link the card renders, read from the page (not only the ones named above): a path of ours must resolve, an external one must be
  // one of the two pinned URLs. External pages are never fetched (this run has no business depending on youtube.com being up), so for
  // them the claim is the exact URL and the new-tab attributes, not a status.
  const hrefs = await card.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  expect(hrefs.length, "anti-vacuity: the consent card renders links").toBeGreaterThan(0);
  const unique = [...new Set(hrefs)];
  const paths = unique.filter((h) => h.startsWith("/"));
  const externals = unique.filter((h) => h.startsWith("https://"));
  expect(paths.length + externals.length, `every link on the card is a path of ours or an https URL (no mailto:, javascript: or bare fragment): ${unique.join(" ")}`).toBe(unique.length);
  expect(paths, "the card links our privacy policy and nothing else of ours").toEqual(["/legal/privacy"]);
  expect([...externals].sort(), "the card's external links are exactly the two YouTube URLs").toEqual([YOUTUBE_GUIDELINES_URL, YOUTUBE_TOS_URL].sort());
  for (const l of await card.locator("a[href]").all()) {
    await expect(l, "every link on the card opens in a new tab").toHaveAttribute("target", "_blank");
    await expect(l).toHaveAttribute("rel", /noopener/);
  }
  let fetched = 0;
  for (const path of paths) {
    const resolved = await page.request.get(path);
    expect(resolved.status(), `${path} resolves`).toBe(200);
    if (path === "/legal/privacy") expect(await resolved.text(), "and lands on the page that has the YouTube section").toContain('id="youtube-api-services"');
    fetched++;
  }
  expect(fetched, "anti-vacuity: every path the card links was fetched").toBe(paths.length);
  expect(fetched).toBeGreaterThan(0);

  // 2. The privacy page's YouTube section: the three links the Developer Policies require (III.A.2).
  await page.goto("/legal/privacy#youtube-api-services");
  const section = page.locator("#youtube-api-services");
  await expect(section, "the YouTube section is on the privacy page").toBeVisible({ timeout: NAV_MS });
  await expect(section).toContainText("YouTube API Services");
  let sectionLinks = 0;
  for (const href of [YOUTUBE_TOS_URL, GOOGLE_PRIVACY_URL, GOOGLE_THIRD_PARTY_ACCESS_URL]) {
    const l = section.locator(`a[href="${href}"]`);
    await expect(l, `the YouTube section links ${href}`).toHaveCount(1);
    await expect(l).toHaveAttribute("target", "_blank");
    await expect(l).toHaveAttribute("rel", /noopener/);
    sectionLinks++;
  }
  expect(sectionLinks, "the privacy page's three required links were read").toBe(3);
  // The same three, as the typed literals.
  await expect(section.locator('a[href="https://www.youtube.com/t/terms"]')).toHaveCount(1);
  await expect(section.locator('a[href="http://www.google.com/policies/privacy"]')).toHaveCount(1);
  await expect(section.locator('a[href="https://security.google.com/settings/security/permissions"]')).toHaveCount(1);
});
