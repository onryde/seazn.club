// Court stream (spec 2026-11-14; web plan Task 14) — the WHOLE feature walked against a real production server on the fake
// relay and the fake YouTube: one phone on one court, three matches in a row.
//
// The desk links Court 2 to a connected channel (the court's QR comes back from the real route); a fake capture phone in
// Automatic claims it by that QR over the real beat route; Stream is switched on for A and B and left off for C. Then, in order:
//   - A starts on the courtside device link (the pad's own core.start) → the phone's NEXT beat starts one automatic session on the
//     court's channel, and the phone hears go-live; it publishes and the video is seen (one credit is consumed);
//   - A's result goes in → B starts inside A's tail → the phone's next beat starts B and ENDS A (a handover, not the tail), the phone
//     hears go-live for B, and B's video is seen (a second credit);
//   - the Stream switch is turned OFF on B while it is live → B keeps streaming (R5: off is the next-match intent, never a Stop);
//   - C starts (its switch is off) → nothing starts, beat after beat, through a whole retry window;
//   - B's result goes in → the tail ends B, and the phone hears over;
//   - C is still playing and nothing starts; org_stream_credits holds exactly two `consume` rows: A's session and B's.
// The match page's panel for A is opened while A waits for its phone and again while it is live: it names the court's phone and mints
// no code of its own (Task 13), at 1280 and at 320. With COURT_STREAM_SHOTS_DIR set the panel is photographed there.
//
// What a unit test cannot see and this proves: the seams between the desk's link, the court's code, the phone's beats, the court's
// resolver, the start and its handover, the tail, and the ledger — each driven from its real producer (AGENTS.md failure class 1).
// The server runs the fake drivers on ENV_NAME local or ci with the two automatic-streaming tunables SHORTENED and
// COURT_MIN_APP_VERSION set (the phone's build is above it, capture O13), as capture-auto.spec.ts's header lays out; every wait
// is derived from the same variables this process reads (AGENTS.md #20).
//
// R3 (an organiser-started session is never displaced), R4 (a handover-ended match in play is latched) and the latches' other halves
// are the money suite's (court-stream-money.test.ts); this walk takes the automatic path the whole way, where neither applies.
import { test, expect, request as playwrightRequest, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, seedVenueWithCourts } from "../helpers";
import { setRigPlan, signInAs } from "../overlay-kit";
import { waitForHydration } from "../directory-kit";
import { middayZoneFor, withinToday } from "../midday-zone";
import { storeCameraOnly } from "../helpers/stream-mode";
import { captureQrV2Text, type CaptureQrV2 } from "../../src/lib/capture-qr";
import { disposeFakePhones, fakeCapturePhone, newPhoneRequest, type BeatAnswer, type FakeCapturePhone } from "../helpers/fake-capture-phone";
import { StreamPhone } from "../../src/server/api-v1/schemas";
import { FAKE_CONNECT_AFTER_MS_DEFAULT } from "../../src/server/relay/fakes";
import {
  POLL_WAIT_MS,
  POOL_SLOT_WAIT_MS,
  envGuard,
  poolHoldProblem,
  releaseStreamSlot,
  takeStreamSlot,
} from "../helpers/stream-slot-pool";
import {
  AUTO_START_RETRY_SECONDS,
  COURT_AUTO_STOP_AFTER_RESULT_SECONDS,
  POLL_NEAR_SECONDS,
  POLL_STARTING_SECONDS,
} from "../../src/server/relay/config";

// ===========================================================================
// The environment (asserted in beforeEach)
// ===========================================================================

const ENV_PROBLEMS: string[] = [];
const wholeEnv = envGuard(ENV_PROBLEMS);
/** Each "not yet" assertion below beats ONCE inside a window this long: shorter than a beat's round trip on a loaded runner and
 *  the "not yet" half could no longer be told from a slow "already". */
const NOT_YET_FLOOR_S = 5;
/** A court session's tail is its own tunable (O15, owner 2026-11-16): 30 s by default, not the per-fixture code's 180. */
const AUTO_STOP_S = wholeEnv("COURT_AUTO_STOP_AFTER_RESULT_SECONDS", { below: COURT_AUTO_STOP_AFTER_RESULT_SECONDS, atLeast: NOT_YET_FLOOR_S }) ?? COURT_AUTO_STOP_AFTER_RESULT_SECONDS;
const RETRY_S = wholeEnv("AUTO_START_RETRY_SECONDS", { below: AUTO_START_RETRY_SECONDS, atLeast: NOT_YET_FLOOR_S }) ?? AUTO_START_RETRY_SECONDS;
const FAKE_CONNECT_MS = wholeEnv("FAKE_INGEST_CONNECT_AFTER_MS") ?? FAKE_CONNECT_AFTER_MS_DEFAULT;
if (!process.env.DATABASE_URL) ENV_PROBLEMS.push("DATABASE_URL is not set");

// ===========================================================================
// Clocks — every wait DERIVED from the constants that set its pace
// ===========================================================================
const BEAT_MS = POLL_STARTING_SECONDS * 1_000;
/** A beat must OBSERVE the fake ingest's connect: it connects FAKE_CONNECT_MS after its input is made, the tick's ingest reads are
 *  coalesced to one per POLL_NEAR_SECONDS, and then the next beat that names the sid sees it. */
const INGEST_SEEN_MS = FAKE_CONNECT_MS + POLL_NEAR_SECONDS * 1_000 + 2 * BEAT_MS + 5_000;
const AUTO_STOP_MS = AUTO_STOP_S * 1_000;
const RETRY_MS = RETRY_S * 1_000;
const AUTO_STOP_LATE_MS = 2 * BEAT_MS + 5_000;
/** The window a "nothing starts" assertion watches: the retry spacing plus two beats that would act on it. */
const QUIET_WINDOW_MS = RETRY_MS + 2 * BEAT_MS;
const SEED_MS = 90_000;
const NAV_MS = 30_000;
/** The phone's build: above the server's COURT_MIN_APP_VERSION (1.0.14-1200). */
const COURT_PHONE_BUILD = "1.0.14-1300";

/** This file's one long hold: two videos seen, two quiet windows, a handover inside a tail, and polls between. The pool's limit judges it. */
const OWN_LONGEST_HOLD_MS = 2 * INGEST_SEEN_MS + 2 * QUIET_WINDOW_MS + AUTO_STOP_MS + AUTO_STOP_LATE_MS + 6 * POLL_WAIT_MS;
const POOL_HOLD = { file: "court-stream.spec.ts", holdMs: OWN_LONGEST_HOLD_MS } as const;
const holdProblem = poolHoldProblem(POOL_HOLD);
if (holdProblem) ENV_PROBLEMS.push(holdProblem);

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

const rigsThisTest: { request: APIRequestContext; orgId: string }[] = [];
const deviceLinks: { api: APIRequestContext }[] = [];

async function teardownStreams(): Promise<void> {
  try {
    for (const { request, orgId } of rigsThisTest.splice(0)) {
      const open = await withDb((sql) => sql<{ id: string; fixture_id: string }[]>`
        select id, fixture_id from fixture_stream_sessions where org_id = ${orgId} and state not in ('completed', 'failed')`);
      for (const s of open) await request.post(`/api/v1/fixtures/${s.fixture_id}/stream-sessions/${s.id}/stop`).catch(() => null);
      if (open.length === 0) continue;
      await expect
        .poll(async () => (await sessionsOf(orgId)).filter((s) => s.state !== "completed" && s.state !== "failed").length, { timeout: POLL_WAIT_MS })
        .toBe(0)
        .catch(() =>
          withDb((sql) => sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'unknown', end_reason = null, ended_at = now()
                               where org_id = ${orgId} and state not in ('completed', 'failed')`),
        );
    }
  } finally {
    await releaseStreamSlot();
  }
}

test.beforeEach(async ({ request }) => {
  expect(ENV_PROBLEMS, "court-stream.spec.ts needs a tuned fake-driver environment (see the file header)").toEqual([]);
  const probe = await request.post(`/api/internal/relay/fake-ingest/e2e-probe-${randomBytes(4).toString("hex")}`, { data: { state: "unknown" } });
  expect(probe.status(), "the fake-ingest control route answers (RELAY_DRIVERS=fake, ENV_NAME local or ci)").toBe(404);
  expect(await probe.text()).toContain("Unknown fake input");
});

test.afterEach(async () => {
  try {
    await disposeFakePhones();
    for (const l of deviceLinks.splice(0)) await l.api.dispose().catch(() => undefined);
  } finally {
    await teardownStreams();
  }
});

const EN_UI = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
function en(key: string, vars: Record<string, string> = {}): string {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`ui.json has no ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), raw);
}

/** A panel photograph, written only when COURT_STREAM_SHOTS_DIR is set. The file name names the state, never a code. */
async function shot(target: Page | Locator, name: string): Promise<void> {
  const dir = process.env.COURT_STREAM_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: join(dir, `${name}.png`) });
}

// ===========================================================================
// The rig
// ===========================================================================

interface Fx { id: string; no: number; home: string; away: string }
interface Rig {
  orgId: string; divPath: string; competitionId: string; fixtures: Fx[]; origin: string;
  court2Id: string; court2Name: string;
}

/** A fresh Pro org signed in as its owner, one generic league of six STARTED (a device link scores a started division), two courts. */
async function seedRig(page: Page): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+courtstream-${tag}@resend.dev`;
  const orgSlug = `courtstream-org-${tag}`;
  const { orgId } = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"Court Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Court Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return { orgId: newOrgId };
  });
  await signInAs(page, ownerEmail);
  rigsThisTest.push({ request: page.request, orgId });
  const label = `Court ${tag}`;
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: label, visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`court rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: label.slice(0, 40), sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  if (div.status >= 300 || !div.data) throw new Error(`court rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
  const n = 6;
  const ents = await addEntrantsViaApi(page.request, div.data.id, Array.from({ length: n }, (_, i) => `Side ${String.fromCharCode(65 + i)} ${tag}`));
  if (ents.status >= 300 || ents.ids.length !== n) throw new Error(`court rig: entrants -> ${ents.status} (${ents.ids.length}/${n})`);
  await createStageAndGenerate(page.request, div.data.id);
  const started = await apiJson(page.request, `/api/v1/divisions/${div.data.id}/start`, "POST");
  expect(started.status, `court rig: start the division: ${JSON.stringify(started.error)}`).toBeLessThan(300);

  // Two courts; the division plans in the zone where the real clock reads midday, so "today" has room either side of now.
  const { courts } = await seedVenueWithCourts(page.request, [`Court 1 ${tag}`, `Court 2 ${tag}`], { orgId });
  const now = Date.now();
  const zone = middayZoneFor(now);
  const within = withinToday(now, zone);
  const settings = await apiJson(page.request, `/api/v1/divisions/${div.data.id}/schedule-settings`, "PUT", {
    tz: zone, config: { matchMinutes: 30, courts: courts.map((c) => c.id) },
  });
  expect(settings.status, `court rig: schedule settings: ${JSON.stringify(settings.error)}`).toBeLessThan(300);
  await setRigPlan(orgId, "pro");

  // Three matches no two of which share a side, so all three can be in play at once, queued on Court 2 in this order.
  const all = await withDb((sql) => sql<Fx[]>`
    select id, fixture_no as no, home_entrant_id as home, away_entrant_id as away from fixtures where division_id = ${div.data!.id} order by fixture_no`);
  const picked: Fx[] = [];
  for (const f of all) {
    if (picked.every((p) => ![p.home, p.away].includes(f.home) && ![p.home, p.away].includes(f.away))) picked.push(f);
    if (picked.length === 3) break;
  }
  expect(picked.length, "premise: a six-side league has three matches no two of which share a side").toBe(3);
  const court2 = courts[1]!;
  await withDb(async (sql) => {
    for (const [i, f] of picked.entries()) {
      await sql`update fixtures set court_id = ${court2.id}, scheduled_at = ${within(5 + i * 5)} where id = ${f.id}`;
    }
  });
  return {
    orgId, competitionId: comp.data.id, fixtures: [...picked], origin: new URL(page.url()).origin, court2Id: court2.id, court2Name: court2.name,
    divPath: `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}`,
  };
}
const fixturePath = (rig: Rig, f: Fx): string => `${rig.divPath}/f/${f.no}`;

// --- a connected channel, through the real consent round trip on the fake Google -------------------------------------------------

async function fake(page: Page, body: Record<string, unknown>): Promise<unknown> {
  const res = await page.request.post("/api/internal/youtube/fake", { data: body });
  expect(res.status(), `the fake YouTube's control route refused ${String(body.op)}: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { data?: unknown }).data;
}

/** Connect one channel and return its destination (`org_stream_targets.id`) — what a court link streams to (O9). */
async function connectChannel(page: Page, title: string): Promise<string> {
  const channel = { id: `UC${randomBytes(11).toString("hex")}`, title };
  let fired = 0;
  const handler = async (route: Route) => {
    const start = await route.fetch({ maxRedirects: 0 });
    expect(start.status(), "SETUP: the connect start answers with the 303 to the authorize hop").toBe(303);
    const state = new URL(start.headers()["location"] ?? "", "http://localhost").searchParams.get("state");
    expect(state, "SETUP: the start's Location carries the OAuth state").toBeTruthy();
    await fake(page, { op: "setChannels", channels: [channel], state });
    fired++;
    await route.fulfill({ response: start });
  };
  await page.goto("/streaming");
  await page.route("**/api/youtube/connect", handler);
  try {
    const opener = page.getByTestId("youtube-connect-empty").or(page.getByTestId("youtube-connect"));
    await expect(opener).toBeVisible({ timeout: NAV_MS });
    await waitForHydration(opener);
    await opener.click();
    const submit = page.getByTestId("youtube-connect-submit");
    await page.getByTestId("youtube-consent").check();
    await page.getByTestId("youtube-consent-minors").check();
    await expect(submit).toBeEnabled();
    await Promise.all([page.waitForURL(/\/streaming\?youtube=/), submit.click()]);
    expect(fired, "the channel offer ran once for this connect").toBe(1);
  } finally {
    await page.unroute("**/api/youtube/connect", handler);
  }
  const row = page.getByTestId("youtube-channel-row").filter({ has: page.getByTestId("youtube-channel-title").filter({ hasText: title }) });
  await expect(row, "the connected channel has its row").toHaveCount(1, { timeout: NAV_MS });
  const id = await row.getAttribute("data-target-id");
  expect(id, "the row names its destination").toBeTruthy();
  return id!;
}

// --- the desk's calls --------------------------------------------------------------------------------------------------------------

async function linkCourt(page: Page, rig: Rig, targetId: string): Promise<{ id: string; qr: CaptureQrV2 }> {
  const res = await apiJson<{ id: string; qr: CaptureQrV2 | null; court_name: string }>(page.request, `/api/v1/competitions/${rig.competitionId}/court-streams`, "POST", {
    court_id: rig.court2Id, target_id: targetId,
  });
  expect(res.status, `the desk links the court: ${JSON.stringify(res.error)}`).toBe(201);
  expect(res.data!.qr, "the court's QR comes with the link").not.toBeNull();
  expect(res.data!.court_name, "the link names the court").toBe(rig.court2Name);
  return { id: res.data!.id, qr: res.data!.qr! };
}
async function putCourtSwitch(page: Page, f: Fx, on: boolean): Promise<void> {
  const res = await apiJson<{ on: boolean }>(page.request, `/api/v1/fixtures/${f.id}/court-stream`, "PUT", { on });
  expect(res.status, `the Stream switch ${on ? "on" : "off"}: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data).toEqual({ on });
}
async function readPhone(page: Page, f: Fx): Promise<StreamPhone> {
  const res = await apiJson<StreamPhone>(page.request, `/api/v1/fixtures/${f.id}/stream-phone`);
  expect(res.status, `GET stream-phone: ${JSON.stringify(res.error)}`).toBe(200);
  return StreamPhone.parse(res.data);
}

// --- the courtside scorer's device link -------------------------------------------------------------------------------------------

interface DeviceLink { id: string; api: APIRequestContext }
async function mintDeviceLink(page: Page, rig: Rig, f: Fx): Promise<DeviceLink> {
  const minted = await apiJson<{ id: string; secret: string }>(page.request, `/api/v1/fixtures/${f.id}/device-links`, "POST", { label: `Court 2 · ${f.no}` });
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  const api = await playwrightRequest.newContext({
    baseURL: rig.origin, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Authorization: `Bearer ${minted.data!.secret}` },
  });
  deviceLinks.push({ api });
  return { id: minted.data!.id, api };
}
async function deviceLinkEvent(link: DeviceLink, f: Fx, type: string, payload: Record<string, unknown>): Promise<void> {
  const state = await link.api.get(`/api/v1/fixtures/${f.id}/state`);
  expect(state.status(), "the link reads its fixture's state").toBe(200);
  const lastSeq = ((await state.json()) as { data: { last_seq: number } }).data.last_seq;
  const res = await link.api.post(`/api/v1/fixtures/${f.id}/events`, { data: { expected_seq: lastSeq, type, payload } });
  expect(res.status(), `${type} through the device link: ${await res.text()}`).toBe(201);
}
async function finishedAtOf(f: Fx): Promise<Date> {
  const [row] = await withDb((sql) => sql<{ finished_at: Date | null }[]>`select finished_at from fixtures where id = ${f.id}`);
  expect(row?.finished_at, "the result stamped finished_at").toBeTruthy();
  return row!.finished_at!;
}

// --- what the database says ---------------------------------------------------------------------------------------------------------

interface SessionRow {
  id: string; fixture_id: string | null; state: string; end_reason: string | null; start_cause: string; pairing_id: string | null;
  court_link_id: string | null; target_id: string | null; first_ingest_at: Date | null; ended_at: Date | null; created_at: Date;
}
async function sessionsOf(orgId: string): Promise<SessionRow[]> {
  return withDb(async (sql) => [
    ...(await sql<SessionRow[]>`
      select id, fixture_id, state, end_reason, start_cause, pairing_id, court_link_id, target_id, first_ingest_at, ended_at, created_at
        from fixture_stream_sessions where org_id = ${orgId} order by created_at, id`),
  ]);
}
async function sessionRow(id: string): Promise<SessionRow> {
  const [row] = await withDb((sql) => sql<SessionRow[]>`
    select id, fixture_id, state, end_reason, start_cause, pairing_id, court_link_id, target_id, first_ingest_at, ended_at, created_at
      from fixture_stream_sessions where id = ${id}`);
  expect(row, `session ${id} exists`).toBeTruthy();
  return row!;
}
async function newestSession(orgId: string, fixtureId: string, timeout: number): Promise<SessionRow> {
  let found: SessionRow | undefined;
  await expect
    .poll(async () => {
      found = (await sessionsOf(orgId)).filter((s) => s.fixture_id === fixtureId).at(-1);
      return found?.id ?? null;
    }, { message: "the fixture has a session row", timeout, intervals: [500] })
    .not.toBeNull();
  return found!;
}
async function untilDbState(id: string, states: string[], timeout: number, message: string): Promise<SessionRow> {
  let row: SessionRow | undefined;
  await expect
    .poll(async () => {
      row = await sessionRow(id);
      return states.includes(row.state);
    }, { message, timeout, intervals: [500] })
    .toBe(true);
  return row!;
}
async function handoverEvents(sessionId: string): Promise<{ to: string }[]> {
  const rows = await withDb((sql) => sql<{ payload: { to: string } }[]>`
    select payload from fixture_stream_events where session_id = ${sessionId} and type = 'court_handover'`);
  return rows.map((r) => r.payload);
}
async function consumeRows(orgId: string): Promise<{ session_id: string | null }[]> {
  return withDb((sql) => sql<{ session_id: string | null }[]>`
    select session_id from org_stream_credits where org_id = ${orgId} and reason = 'consume' order by created_at, id`);
}

const publishing = (sid: string) => () => ({ sid, state: "publishing" as const, transport: "srt" as const, delivery: "ok" as const });
/** Beat explicitly (the keep-alive silenced) until the answer's state is `want`, the phone naming `sid` when given. */
async function beatUntil(
  phone: FakeCapturePhone, want: BeatAnswer["state"], timeout: number, partial: () => Parameters<FakeCapturePhone["beat"]>[0] = () => ({}),
): Promise<BeatAnswer> {
  let last: BeatAnswer | null = null;
  await expect
    .poll(async () => {
      last = (await phone.beat(partial())).ok;
      return last?.state ?? null;
    }, { message: `the phone hears ${want}`, timeout, intervals: [1_000] })
    .toBe(want);
  return last!;
}

// --- the match page's panel ---------------------------------------------------------------------------------------------------------

const streamControl = (page: Page): Locator => page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
async function openPhoneTab(page: Page, rig: Rig, f: Fx): Promise<Locator> {
  await page.goto(fixturePath(rig, f));
  const control = streamControl(page);
  await expect(control, `fixture ${f.no} offers exactly one visible Stream control`).toHaveCount(1, { timeout: NAV_MS });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: NAV_MS });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  const body = scope.locator("[data-phone-body]");
  await expect(body).toBeAttached({ timeout: NAV_MS });
  return body;
}
/** What Task 13 promises of the panel for a court-streamed match: the court's line, no code of its own, no mint on the wire. */
async function expectCourtPanel(page: Page, rig: Rig, f: Fx, mints: string[]): Promise<Locator> {
  const body = await openPhoneTab(page, rig, f);
  const line = body.getByTestId("stream-court-line");
  await expect(line, "the panel names the court's phone").toBeVisible({ timeout: NAV_MS });
  await expect(line).toHaveText(en("stream.courtStreamed", { court: rig.court2Name }));
  for (const id of ["stream-code-card", "stream-code-disclosure", "stream-qr", "stream-qr-text", "stream-code-reissue", "stream-auto-switch"]) {
    await expect(body.getByTestId(id), `${id}: a court match has none of its own`).toHaveCount(0);
  }
  expect(mints, "opening the panel made no code of this match's own").toEqual([]);
  await expectNoHorizontalScroll(page);
  return body;
}

// ===========================================================================
// The walk
// ===========================================================================
test("court stream: link Court 2, claim it, A then B then C — A starts, B starts inside A's tail and takes the court, B's switch going off stops its video at once, C (switch off) streams nothing; two credits", async ({
  page,
}) => {
  test.setTimeout(Math.max(
    300_000,
    POOL_SLOT_WAIT_MS + SEED_MS + 4 * NAV_MS + OWN_LONGEST_HOLD_MS + 8 * POLL_WAIT_MS + 60_000,
  ));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const [A, B, C] = rig.fixtures as [Fx, Fx, Fx];
  const channelTitle = `Club channel ${TAG}`;
  const targetId = await connectChannel(page, channelTitle);
  await storeCameraOnly(page.request, [A.id, B.id, C.id]);
  // Any POST to a stream-code route is a mint or a re-show of a match's OWN code: a court-streamed match makes none.
  const mints: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/stream-code(\/|\?|$)/.test(r.url())) mints.push(r.url().replace(/^https?:\/\/[^/]+/, ""));
  });

  // 1 — the desk links Court 2; the phone claims it by the court's own QR, in Automatic.
  const link = await linkCourt(page, rig, targetId);
  expect(link.qr.exp, "a court's QR names the end of its day").toBeGreaterThan(Date.now() / 1000);
  const phone = await fakeCapturePhone(page, await newPhoneRequest(rig.origin), {
    qrText: captureQrV2Text(link.qr), captureMode: "automatic", appVersion: COURT_PHONE_BUILD,
  });
  const claimed = await phone.claim("new");
  expect(claimed.status, `the court's claim beat: ${JSON.stringify(claimed.refusal)}`).toBe(200);
  phone.silence();

  // 2 — A and B are switched on, C is left off.
  await putCourtSwitch(page, A, true);
  await putCourtSwitch(page, B, true);
  const readA = await readPhone(page, A);
  expect(readA.court, "A's read names the court whose phone streams it and the channel it streams to (final review I-1)").toEqual({ name: rig.court2Name, targetLabel: channelTitle });
  expect(readA.phone, "…and the court's phone is A's phone").toMatchObject({ present: true, mode: "automatic" });
  expect(readA.code, "…and A has no code of its own").toBeNull();
  expect((await readPhone(page, C)).court, "C's switch was never touched: its read is today's").toBeNull();
  const before = await phone.beat();
  expect([before.ok?.state, before.ok?.autoAllowed], "before any kickoff the phone waits").toEqual(["waiting", true]);
  expect(await sessionsOf(rig.orgId), "a phone in Automatic starts nothing before a match is in play").toEqual([]);

  // The panel while A waits for its phone to go live (Task 13): the court's line and Go live, and no code of A's own.
  const waiting = await expectCourtPanel(page, rig, A, mints);
  await expect(waiting.getByTestId("stream-go-live"), "Go live starts on the court's phone").toBeEnabled({ timeout: NAV_MS });
  await shot(page.getByTestId("stream-panel"), "t13-panel-court-ready-1280");
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoHorizontalScroll(page);
  await shot(page.getByTestId("stream-panel"), "t13-panel-court-ready-320");
  await page.setViewportSize({ width: 1280, height: 900 });

  // The courtside links, the one pool key, and A kicks off.
  const linkA = await mintDeviceLink(page, rig, A);
  const linkB = await mintDeviceLink(page, rig, B);
  const linkC = await mintDeviceLink(page, rig, C);
  await takeStreamSlot(POOL_HOLD);
  await deviceLinkEvent(linkA, A, "core.start", {});
  expect(await sessionsOf(rig.orgId), "the match start alone opens nothing: the phone's beat is the producer").toEqual([]);

  // 3 — A: the phone's next beat starts one automatic session on the court's channel, and it hears go-live.
  const first = await phone.beat();
  expect(["waiting", "go-live"], "the starting beat's own answer").toContain(first.ok?.state);
  const sessionA = await newestSession(rig.orgId, A.id, BEAT_MS + POLL_WAIT_MS);
  expect(sessionA, "an automatic start, on the court's link and channel").toMatchObject({
    fixture_id: A.id, start_cause: "automatic", court_link_id: link.id, target_id: targetId,
  });
  const heardA = first.ok?.state === "go-live" ? first.ok : await beatUntil(phone, "go-live", INGEST_SEEN_MS);
  expect(heardA, "the phone hears go-live for A, started automatically").toMatchObject({ state: "go-live", sid: sessionA.id, startedBy: "automatic" });
  phone.keepAlive("publishing");
  await untilDbState(sessionA.id, ["live"], 2 * INGEST_SEEN_MS, "A goes live once the phone's video is seen");
  expect((await consumeRows(rig.orgId)).map((r) => r.session_id), "A's first video took one credit").toEqual([sessionA.id]);
  const livePanel = await expectCourtPanel(page, rig, A, mints);
  await expect(livePanel.getByTestId("stream-stop"), "the desk's Stop for a court match is on the match page").toBeVisible({ timeout: NAV_MS });
  await shot(page.getByTestId("stream-panel"), "t13-panel-court-live-1280");
  phone.silence();

  // 4 — A's result, then B kicks off inside A's tail; the phone's next beat starts B and ENDS A (a handover, not the tail).
  await deviceLinkEvent(linkA, A, "generic.result", { p1Score: 2, p2Score: 1 });
  const finishedA = await finishedAtOf(A);
  await deviceLinkEvent(linkB, B, "core.start", {});
  const handoverBeat = await phone.beat(publishing(sessionA.id)());
  expect(["go-live", "over", "live", "waiting"], "the beat that starts B is answered").toContain(handoverBeat.ok?.state);
  const sessionB = await newestSession(rig.orgId, B.id, BEAT_MS + POLL_WAIT_MS);
  expect(sessionB, "B is its own automatic session on the same court link and channel").toMatchObject({
    fixture_id: B.id, start_cause: "automatic", court_link_id: link.id, target_id: targetId,
  });
  expect(sessionB.id, "…a new video, not A's").not.toBe(sessionA.id);
  const heardB = await beatUntil(phone, "go-live", INGEST_SEEN_MS, publishing(sessionA.id));
  expect(heardB, "the phone hears go-live for B").toMatchObject({ state: "go-live", sid: sessionB.id, startedBy: "automatic" });
  const endedA = await untilDbState(sessionA.id, ["ending", "completed"], POLL_WAIT_MS, "A ended when B started");
  expect(endedA.end_reason, "A ended by the handover").toBe("auto_stopped");
  expect(await handoverEvents(sessionA.id), "…and the handover names B").toEqual([{ to: sessionB.id }]);
  expect(endedA.ended_at!.getTime(), "A ended inside its own tail: B took the court, the tail did not").toBeLessThan(finishedA.getTime() + AUTO_STOP_MS);
  phone.keepAlive("publishing");
  await untilDbState(sessionB.id, ["live"], 2 * INGEST_SEEN_MS, "B goes live once the phone's video is seen");
  expect((await consumeRows(rig.orgId)).map((r) => r.session_id), "B's first video took the second credit").toEqual([sessionA.id, sessionB.id]);

  // 5 — O17 (owner, 2026-11-17: "switching Stream off should stop the video now"): Stream turned OFF on B while it is
  //     live ends B's video at once — the organiser's Stop, not the tail. (Until that ruling this step proved the
  //     opposite, R5: off never ended a live video.)
  const offAt = Date.now();
  await putCourtSwitch(page, B, false);
  phone.silence();
  const over = await beatUntil(phone, "over", 2 * BEAT_MS + POLL_WAIT_MS, publishing(sessionB.id));
  expect(over, "the phone hears over, stopped, for B").toMatchObject({ state: "over", sid: sessionB.id, endReason: "stopped" });
  const endedB = await untilDbState(sessionB.id, ["ending", "completed"], POLL_WAIT_MS, "B ended when its switch went off");
  expect(endedB.end_reason, "B ended by the organiser's Stop").toBe("stopped");
  expect(endedB.ended_at!.getTime(), "…at the switch, not a tail later").toBeLessThan(offAt + AUTO_STOP_MS);
  expect(await handoverEvents(sessionB.id), "…and nothing took the court from it").toEqual([]);

  // 6 — C kicks off with its switch off, and B is still in play with its switch off: nothing starts, beat after beat,
  //     through a whole retry window.
  await deviceLinkEvent(linkC, C, "core.start", {});
  const quietUntil = Date.now() + QUIET_WINDOW_MS;
  let beats = 0;
  while (Date.now() < quietUntil) {
    const a = await phone.beat();
    beats++;
    expect(a.ok?.state, `beat ${beats} with B and C in play, both switches off`).not.toBe("go-live");
    await new Promise((r) => setTimeout(r, BEAT_MS));
  }
  expect(beats, "the court was beaten through the whole window").toBeGreaterThanOrEqual(2);
  expect((await sessionsOf(rig.orgId)).map((s) => s.fixture_id), "C has no session; A and B have their one each").toEqual([A.id, B.id]);

  // 7 — B's result after its video was stopped: nothing restarts, and B's one session keeps its reason.
  await deviceLinkEvent(linkB, B, "generic.result", { p1Score: 2, p2Score: 0 });
  const quietAfter = Date.now() + QUIET_WINDOW_MS;
  let idle = 0;
  while (Date.now() < quietAfter) {
    const a = await phone.beat();
    idle++;
    expect(a.ok?.state, `beat ${idle} with only C in play`).not.toBe("go-live");
    await new Promise((r) => setTimeout(r, BEAT_MS));
  }
  expect(idle, "…beaten through the whole window").toBeGreaterThanOrEqual(2);
  expect((await sessionRow(sessionB.id)).end_reason, "B's result did not rewrite how its video ended").toBe("stopped");
  expect((await sessionsOf(rig.orgId)).map((s) => s.fixture_id), "still exactly A's and B's sessions: C was never streamed").toEqual([A.id, B.id]);

  // 8 — the money: exactly two credits, one per streamed match's video, none for C.
  expect((await consumeRows(rig.orgId)).map((r) => r.session_id), "org_stream_credits: exactly two consume rows, A's session and B's").toEqual([sessionA.id, sessionB.id]);
});
