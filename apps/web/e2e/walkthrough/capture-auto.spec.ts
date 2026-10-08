// Capture QR v2 PR-2 (plan T8; spec §7.1–§7.3, W7, A4, A12, A15, A16) — AUTOMATIC STREAMING, walked against a real
// production server on RELAY_DRIVERS=fake.
//
// What this file proves that no unit test can: the switch's whole seam, from its REAL producers to its real consumers
// (AGENTS.md failure class 1). The organiser turns the switch on through the real `PUT …/stream-settings`; a phone pairs
// through the panel's OWN paste code (`helpers/fake-capture-phone.ts`, now with the phone's Automatic switch,
// `captureMode`); the MATCH IS STARTED ON A DEVICE LINK — the `/score/<token>` page a courtside scorer holds, never the
// console — and the phone's next beat is what starts the broadcast (§7.2: "any scoring surface's match start"). The
// result goes in through the same device link's door, and the phone's beat after the tuned delay is what stops it.
// Every observation is read where a person or the phone would read it: the phone's beat answers, the organiser's read
// model (`GET …/stream-phone`, parsed by its zod schema), the panel's own Stop and Go live, and the rows they leave.
//
// THE ENVIRONMENT IS A PREMISE, ASSERTED (beforeEach — a module-level throw would abort the whole leg). The server must
// run the fake drivers on ENV_NAME local or ci, and the two PR-2 tunables SHORTENED: AUTO_STOP_AFTER_RESULT_SECONDS
// (180 s by default, three minutes after the result) and AUTO_START_RETRY_SECONDS (60 s between refused attempts).
// This process reads the SAME variables to derive its budgets and waits (AGENTS.md #20); e2e.yml sets them on both the
// server and the Playwright step, and e2e-ci-wiring.test.ts pins that every tunable is set in both places.
//
// Single-sport (generic) by design: auto start keys on `fixtures.status = 'in_play'` and auto stop on `finished_at`,
// both written by the one scoring path for every sport (FP8), and nothing here reads a sport rule.
//
// Every rig is a FRESH org: balances, grants and the switch are org- or fixture-level, and the leg runs fully parallel.
import { test, expect, request as playwrightRequest, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate } from "../helpers";
import { grantRigPackCredits, setRigPlan, signInAs } from "../overlay-kit";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import {
  disposeFakePhones,
  pairPhoneOnFixture,
  pairedPhone,
  type BeatAnswer,
  type FakeCapturePhone,
} from "../helpers/fake-capture-phone";
import { StreamPhone, StreamSettings } from "../../src/server/api-v1/schemas";
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
  AUTO_STOP_AFTER_RESULT_SECONDS,
  POLL_NEAR_SECONDS,
  POLL_STARTING_SECONDS,
} from "../../src/server/relay/config";

// ===========================================================================
// The environment (asserted in beforeEach)
// ===========================================================================

const ENV_PROBLEMS: string[] = [];
/** A whole number from this process's env, parsed as the SERVER parses that name; null + a recorded problem when it is
 *  missing or junk, so the beforeEach names every gap at once. `below`: the default it must be shortened from;
 *  `atLeast`: the floor a case's own arithmetic needs — the stream-slot pool's one env read (final review m-3). */
const wholeEnv = envGuard(ENV_PROBLEMS);
/** Each "not yet" assertion below beats ONCE inside a window this long (right after the result, right after a refusal):
 *  shorter than a beat's own round trip on a loaded runner and the "not yet" half could no longer be told from a slow
 *  "already". */
const NOT_YET_FLOOR_S = 5;
const AUTO_STOP_S = wholeEnv("AUTO_STOP_AFTER_RESULT_SECONDS", { below: AUTO_STOP_AFTER_RESULT_SECONDS, atLeast: NOT_YET_FLOOR_S }) ?? AUTO_STOP_AFTER_RESULT_SECONDS;
const RETRY_S = wholeEnv("AUTO_START_RETRY_SECONDS", { below: AUTO_START_RETRY_SECONDS, atLeast: NOT_YET_FLOOR_S }) ?? AUTO_START_RETRY_SECONDS;
const FAKE_CONNECT_MS = wholeEnv("FAKE_INGEST_CONNECT_AFTER_MS") ?? FAKE_CONNECT_AFTER_MS_DEFAULT;
if (!process.env.DATABASE_URL) ENV_PROBLEMS.push("DATABASE_URL is not set");

// ===========================================================================
// Clocks — every wait DERIVED from the constants that set its pace (AGENTS.md #20)
// ===========================================================================
/** The keep-alive's cadence: a paired phone beats every POLL_STARTING_SECONDS (the helper's own interval). */
const BEAT_MS = POLL_STARTING_SECONDS * 1_000;
/** A beat must OBSERVE the fake ingest's connect: the fake connects FAKE_CONNECT_MS after its input is made, and the
 *  tick's ingest reads are coalesced, at most one per POLL_NEAR_SECONDS — then the next beat that names the sid. */
const INGEST_SEEN_MS = FAKE_CONNECT_MS + POLL_NEAR_SECONDS * 1_000 + 2 * BEAT_MS + 5_000;
const AUTO_STOP_MS = AUTO_STOP_S * 1_000;
const RETRY_MS = RETRY_S * 1_000;
/** An automatic stop is made by the first tick at or after `finished_at + delay`; a beat naming the sid is a tick, and
 *  the phone names it every BEAT_MS — so at most one beat late, plus a round trip. */
const AUTO_STOP_LATE_MS = 2 * BEAT_MS + 5_000;
/** The window a "nothing starts / nothing stops" assertion watches: the retry spacing (a refused or skipped attempt may
 *  repeat after it) plus two beats that would act on it. */
const QUIET_WINDOW_MS = RETRY_MS + 2 * BEAT_MS;
/** A DB stamp and an app-clock stamp, both on one host here and in CI: 1 s covers the round trip between them. */
const CLOCKS_MS = 1_000;
const SEED_MS = 60_000;
const NAV_MS = 30_000;
/** The device link's `/score/<token>` page: the Confirm card, the Start tap, the pad mounting. */
const PAD_MS = 30_000;

// ===========================================================================
// The stream-slot pool (e2e/helpers/stream-slot-pool.ts) — SHARED with capture-phone, stream-relay, directory and
// capture-panel-pr2. Every session any of them opens is opened under one of the pool's advisory-lock keys, held until its
// teardown has driven the session terminal. capture-phone's W22 holds the WHOLE pool while it posts the GLOBAL cron tick
// — so a session opened here without a key could be ticked (and ended) by it. An AUTOMATIC start opens a session on a
// beat, not a tap: every test below takes its key BEFORE the match starts, which is the instant a beat can first start one.
// ===========================================================================
/** This file's longest hold: A12 + A15 — an automatic start to live, the Stop, the quiet window, a Go live, the result and
 *  the automatic stop. The pool's limit judges it (here, in beforeEach, with every other environment problem). */
const OWN_LONGEST_HOLD_MS = 2 * INGEST_SEEN_MS + 4 * POLL_WAIT_MS + QUIET_WINDOW_MS + AUTO_STOP_MS + AUTO_STOP_LATE_MS;
const POOL_HOLD = { file: "capture-auto.spec.ts", holdMs: OWN_LONGEST_HOLD_MS } as const;
const SLOT_WAIT_MS = POOL_SLOT_WAIT_MS;
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

/** One pool key, held until teardown; a second call in the same test reuses it. */
const streamSlot = (): Promise<void> => takeStreamSlot(POOL_HOLD);

async function teardownStreams(): Promise<void> {
  try {
    for (const { request, orgId } of rigsThisTest.splice(0)) {
      const open = await withDb((sql) => sql<{ id: string; fixture_id: string }[]>`
        select id, fixture_id from fixture_stream_sessions where org_id = ${orgId} and state not in ('completed', 'failed')`);
      for (const s of open) await request.post(`/api/v1/fixtures/${s.fixture_id}/stream-sessions/${s.id}/stop`).catch(() => null);
      if (open.length === 0) continue;
      await expect
        .poll(async () => (await sessionsOf(orgId)).filter((s) => s.state !== "completed" && s.state !== "failed").length, {
          timeout: POLL_WAIT_MS,
        })
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

test.beforeEach(async ({ request }) => {
  expect(ENV_PROBLEMS, "capture-auto.spec.ts needs a tuned fake-driver environment (see the file header)").toEqual([]);
  // The SERVER runs the fake drivers on local/ci: its control route knows the word "Unknown fake input" — on any other
  // deployment it is a bare 404 "Not found".
  const probe = await request.post(`/api/internal/relay/fake-ingest/e2e-probe-${randomBytes(4).toString("hex")}`, { data: { state: "unknown" } });
  expect(probe.status(), "the fake-ingest control route answers (RELAY_DRIVERS=fake, ENV_NAME local or ci)").toBe(404);
  expect(await probe.text()).toContain("Unknown fake input");
});

test.afterEach(async () => {
  try {
    await disposeFakePhones();
  } finally {
    await teardownStreams();
  }
});

// Copy, from the dictionary itself.
const EN_UI = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
function en(key: string): string {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`ui.json has no ${key}`);
  return raw;
}

// ===========================================================================
// The rig
// ===========================================================================

interface Fx { id: string; no: number; home: string; away: string }
interface Rig { orgId: string; ownerId: string; divisionId: string; divPath: string; fixtures: Fx[]; monthlyRate: number; origin: string }

/** A fresh Pro org, signed in as its owner, with one generic league STARTED (a device link can score it). */
async function seedRig(page: Page, opts: { entrants?: number } = {}): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+capauto-${tag}@resend.dev`;
  const orgSlug = `capauto-org-${tag}`;
  const { orgId, ownerId } = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"Auto Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Auto Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return { orgId: newOrgId, ownerId: userId };
  });
  await signInAs(page, ownerEmail);
  rigsThisTest.push({ request: page.request, orgId });
  const label = `Auto ${tag}`;
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: label, visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`auto rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: label.slice(0, 40), sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  if (div.status >= 300 || !div.data) throw new Error(`auto rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
  const n = opts.entrants ?? 2;
  const ents = await addEntrantsViaApi(page.request, div.data.id, Array.from({ length: n }, (_, i) => `Side ${String.fromCharCode(65 + i)} ${tag}`));
  if (ents.status >= 300 || ents.ids.length !== n) throw new Error(`auto rig: entrants -> ${ents.status} (${ents.ids.length}/${n})`);
  const { fixtureIds } = await createStageAndGenerate(page.request, div.data.id);
  expect(fixtureIds.length, "auto rig: a league's fixture count").toBe((n * (n - 1)) / 2);
  // A device link scores a STARTED division (device-links.spec.ts's setup).
  const started = await apiJson(page.request, `/api/v1/divisions/${div.data.id}/start`, "POST");
  expect(started.status, `auto rig: start the division: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const fixtures = await withDb(async (sql) => [
    ...(await sql<Fx[]>`select id, fixture_no as no, home_entrant_id as home, away_entrant_id as away
                          from fixtures where division_id = ${div.data!.id} order by fixture_no`),
  ]);
  const { monthlyMatchCredits } = await setRigPlan(orgId, "pro");
  return {
    orgId, ownerId, divisionId: div.data.id, divPath: `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}`, fixtures,
    monthlyRate: monthlyMatchCredits, origin: new URL(page.url()).origin,
  };
}
const fixturePath = (rig: Rig, f: Fx): string => `${rig.divPath}/f/${f.no}`;

async function addTargetApi(page: Page, orgId: string, label: string): Promise<{ id: string; label: string }> {
  const res = await apiJson<{ id: string; label: string }>(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", {
    kind: "youtube", label, streamKey: `e2e-${randomBytes(6).toString("hex")}`,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`addTargetApi -> ${res.status} ${JSON.stringify(res.error)}`);
  return res.data!;
}

/** The organiser's switch, through the real route. Returns the answer, parsed by its schema. */
async function putAutoStream(page: Page, f: Fx, on: boolean): Promise<StreamSettings> {
  const res = await apiJson<StreamSettings>(page.request, `/api/v1/fixtures/${f.id}/stream-settings`, "PUT", { autoStream: on });
  expect(res.status, `PUT stream-settings {autoStream: ${on}}: ${JSON.stringify(res.error)}`).toBe(200);
  return StreamSettings.parse(res.data);
}

/** The organiser's read model, parsed by its schema (the panel reads exactly this). */
async function readPhone(page: Page, f: Fx): Promise<StreamPhone> {
  const res = await apiJson<StreamPhone>(page.request, `/api/v1/fixtures/${f.id}/stream-phone`);
  expect(res.status, `GET stream-phone: ${JSON.stringify(res.error)}`).toBe(200);
  return StreamPhone.parse(res.data);
}

interface SessionRow {
  id: string; fixture_id: string | null; state: string; end_reason: string | null; start_cause: string; pairing_id: string | null;
  created_by: string; first_ingest_at: Date | null; phone_beat_at: Date | null; ended_at: Date | null; created_at: Date;
}
async function sessionsOf(orgId: string): Promise<SessionRow[]> {
  return withDb(async (sql) => [
    ...(await sql<SessionRow[]>`
      select id, fixture_id, state, end_reason, start_cause, pairing_id, created_by, first_ingest_at, phone_beat_at, ended_at, created_at
        from fixture_stream_sessions where org_id = ${orgId} order by created_at`),
  ]);
}
async function sessionRow(id: string): Promise<SessionRow> {
  const [row] = await withDb((sql) => sql<SessionRow[]>`
    select id, fixture_id, state, end_reason, start_cause, pairing_id, created_by, first_ingest_at, phone_beat_at, ended_at, created_at
      from fixture_stream_sessions where id = ${id}`);
  expect(row, `session ${id} exists`).toBeTruthy();
  return row!;
}
/** The newest session on a fixture, waited for. */
async function newestSession(orgId: string, fixtureId: string, timeout: number, notIn: string[] = []): Promise<SessionRow> {
  let found: SessionRow | undefined;
  await expect
    .poll(async () => {
      found = (await sessionsOf(orgId)).filter((s) => s.fixture_id === fixtureId && !notIn.includes(s.id)).at(-1);
      return found?.id ?? null;
    }, { message: "the fixture has a new session row", timeout, intervals: [500] })
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
interface SettingsRow {
  auto_stream: boolean; auto_started_at: Date | null; auto_start_session_id: string | null; auto_start_blocked_at: Date | null;
  auto_start_attempted_at: Date | null; auto_start_refusal: string | null;
}
async function settingsOf(fixtureId: string): Promise<SettingsRow | null> {
  const [row] = await withDb((sql) => sql<SettingsRow[]>`
    select auto_stream, auto_started_at, auto_start_session_id, auto_start_blocked_at, auto_start_attempted_at, auto_start_refusal
      from fixture_stream_settings where fixture_id = ${fixtureId}`);
  return row ?? null;
}
async function pairingOf(phone: FakeCapturePhone, fixtureId: string): Promise<string> {
  const [row] = await withDb((sql) => sql<{ id: string }[]>`
    select p.id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
     where c.fixture_id = ${fixtureId} and p.phone = ${phone.id} and p.ended_at is null`);
  expect(row, "the phone holds a current pairing on the fixture").toBeTruthy();
  return row!.id;
}
async function finishedAtOf(fixtureId: string): Promise<Date> {
  const [row] = await withDb((sql) => sql<{ finished_at: Date | null; status: string }[]>`
    select finished_at, status from fixtures where id = ${fixtureId}`);
  expect(row?.finished_at, `the fixture's result stamped finished_at (status ${row?.status})`).toBeTruthy();
  return row!.finished_at!;
}
interface LedgerRow { reason: string; delta: number }
async function ledger(orgId: string): Promise<{ total: number; rows: LedgerRow[] }> {
  const rows = await withDb(async (sql) => [
    ...(await sql<LedgerRow[]>`select reason, delta from org_stream_credits where org_id = ${orgId} order by created_at, id`),
  ]);
  return { total: rows.reduce((a, r) => a + r.delta, 0), rows };
}
/** SQL setup: bring the org's balance to `keep` with the rollover's own row shape ('expire', monthly). */
async function drainMonthlyTo(orgId: string, keep: number): Promise<void> {
  const l = await ledger(orgId);
  const excess = l.total - keep;
  if (excess <= 0) return;
  await withDb((sql) => sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
                            values (${orgId}, ${-excess}, 'expire', 'monthly', ${keep}, 'e2e: reach a lower balance')`);
}

// ===========================================================================
// The device link — the courtside scorer's surface ("any scoring surface", §7.2)
// ===========================================================================

interface DeviceLink { id: string; secret: string; api: APIRequestContext }
const deviceLinks: DeviceLink[] = [];
test.afterEach(async () => {
  for (const l of deviceLinks.splice(0)) await l.api.dispose().catch(() => undefined);
});

/** Mint a device link for one fixture (the organiser's session), and the link's OWN HTTP client: cookie-less, the
 *  `Bearer dl_` the pad presents — so every write below is attributed to the link, never to the organiser. */
async function mintDeviceLink(page: Page, rig: Rig, f: Fx): Promise<DeviceLink> {
  const minted = await apiJson<{ id: string; secret: string }>(page.request, `/api/v1/fixtures/${f.id}/device-links`, "POST", { label: `Court ${f.no}` });
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  expect(minted.data!.secret.startsWith("dl_"), "a device link's secret").toBe(true);
  const api = await playwrightRequest.newContext({
    baseURL: rig.origin,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${minted.data!.secret}` },
  });
  const link = { id: minted.data!.id, secret: minted.data!.secret, api };
  deviceLinks.push(link);
  return link;
}

/** One event through the device link's door (`POST …/events` with the link's Bearer — the write the pad makes). */
async function deviceLinkEvent(link: DeviceLink, f: Fx, type: string, payload: Record<string, unknown>): Promise<void> {
  const state = await link.api.get(`/api/v1/fixtures/${f.id}/state`);
  expect(state.status(), "the link reads its fixture's state").toBe(200);
  const lastSeq = ((await state.json()) as { data: { last_seq: number } }).data.last_seq;
  const res = await link.api.post(`/api/v1/fixtures/${f.id}/events`, { data: { expected_seq: lastSeq, type, payload } });
  expect(res.status(), `${type} through the device link: ${await res.text()}`).toBe(201);
}

/** THE MATCH START ON THE COURTSIDE PAD: a signed-out browser opens `/score/<token>`, the Confirm card, and taps Start —
 *  the pad's own `core.start`, through its own Bearer dl_. Returns once the fixture is in play. */
async function startOnScorePad(browser: Browser, link: DeviceLink, f: Fx): Promise<void> {
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const device = await ctx.newPage();
    await device.goto(`/score/${link.secret}`);
    await expect(device.getByTestId("scan-confirm"), "a not-yet-started fixture opens on the Confirm card").toBeVisible({ timeout: PAD_MS });
    await device.getByTestId("score-start-match").click();
    await expect(device.locator('[data-role="pad-v3"]'), "the pad mounts once Start is tapped").toBeVisible({ timeout: PAD_MS });
  } finally {
    await ctx.close();
  }
  await expect
    .poll(async () => (await withDb((sql) => sql<{ status: string }[]>`select status from fixtures where id = ${f.id}`))[0]?.status, {
      message: "the pad's Start put the fixture in play", timeout: POLL_WAIT_MS, intervals: [300],
    })
    .toBe("in_play");
}
/** The courtside result: the link's own `generic.result`. Returns the fixture's `finished_at` (V430's trigger). */
async function resultOnDeviceLink(link: DeviceLink, f: Fx): Promise<Date> {
  await deviceLinkEvent(link, f, "generic.result", { p1Score: 2, p2Score: 1 });
  return finishedAtOf(f.id);
}
/** THE SCORING SURFACE MARKER: which device link wrote the fixture's newest event of `type` (null: not a device link). */
async function surfaceOf(f: Fx, type: string): Promise<{ device_link_id: string | null } | null> {
  const [row] = await withDb((sql) => sql<{ device_link_id: string | null }[]>`
    select device_link_id from score_events where fixture_id = ${f.id} and type = ${type} order by seq desc limit 1`);
  return row ?? null;
}

/** Beat explicitly (the keep-alive silenced) until the answer's state is `want`, the phone naming `sid` when given. */
async function beatUntil(phone: FakeCapturePhone, want: BeatAnswer["state"], timeout: number, partial: () => Parameters<FakeCapturePhone["beat"]>[0] = () => ({})): Promise<BeatAnswer> {
  let last: BeatAnswer | null = null;
  await expect
    .poll(async () => {
      last = (await phone.beat(partial())).ok;
      return last?.state ?? null;
    }, { message: `the phone hears ${want}`, timeout, intervals: [1_000] })
    .toBe(want);
  return last!;
}
const publishing = (sid: string) => () => ({ sid, state: "publishing" as const, transport: "srt" as const, delivery: "ok" as const });

// ===========================================================================
// 1 — W7/A4/A16: the match start on a DEVICE LINK starts the broadcast on the paired phone's next beat; switch off, none
// ===========================================================================
test("auto start from the courtside pad: switch on, a phone in Automatic, the match started on a device link → the phone's NEXT beat starts one automatic session and it hears go-live startedBy automatic; the same run with the switch off (never touched) starts nothing", async ({
  page,
  browser,
}) => {
  test.setTimeout(Math.max(
    180_000,
    SLOT_WAIT_MS + SEED_MS + 2 * NAV_MS + 2 * PAD_MS + 2 * POLL_WAIT_MS + INGEST_SEEN_MS + QUIET_WINDOW_MS + 30_000,
  ));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 4 });
  await addTargetApi(page, rig.orgId, "Auto destination");
  // Two fixtures that share no entrant (the league's first round), so both can be in play at once.
  const on = rig.fixtures[0]!;
  const off = rig.fixtures.find((f) => ![on.home, on.away].includes(f.home) && ![on.home, on.away].includes(f.away));
  expect(off, "premise: the league has a fixture disjoint from the first").toBeTruthy();

  expect(await putAutoStream(page, on, true), "the switch's answer: on, no destination chosen").toEqual({ targetId: null, autoStream: true });
  expect(await settingsOf(off!.id), "premise: the other fixture's switch was never touched (off by default, no row)").toBeNull();

  const phoneOn = await pairPhoneOnFixture(page, fixturePath(rig, on), { captureMode: "automatic" });
  const phoneOff = await pairPhoneOnFixture(page, fixturePath(rig, off!), { captureMode: "automatic" });
  expect([phoneOn.captureMode, phoneOff.captureMode], "both phones are in Automatic (A4's other half)").toEqual(["automatic", "automatic"]);
  // From here every beat is an explicit one, so the beat that starts the broadcast is one this test sent.
  phoneOn.silence();
  phoneOff.silence();
  const before = await phoneOn.beat();
  expect([before.ok?.state, before.ok?.autoAllowed], "before the match: waiting, and the switch reaches the phone").toEqual(["waiting", true]);
  const beforeOff = await phoneOff.beat();
  expect([beforeOff.ok?.state, beforeOff.ok?.autoAllowed], "the untouched fixture: waiting, autoAllowed false").toEqual(["waiting", false]);
  expect(await sessionsOf(rig.orgId), "a phone in Automatic does not start anything before the match starts").toEqual([]);

  const linkOn = await mintDeviceLink(page, rig, on);
  const linkOff = await mintDeviceLink(page, rig, off!);
  await streamSlot();
  await startOnScorePad(browser, linkOn, on);
  await startOnScorePad(browser, linkOff, off!);
  // The surface marker: the match was started on the device link, not the console (plan T8 Step 5's mutation target).
  expect(await surfaceOf(on, "core.start"), "the match start was written by THIS device link").toEqual({ device_link_id: linkOn.id });
  expect(await surfaceOf(off!, "core.start"), "…and the other fixture's by its own").toEqual({ device_link_id: linkOff.id });
  // The match start alone opens nothing: both phones are silenced, so the beat below is the ONE producer of the session.
  expect(await sessionsOf(rig.orgId), "no session between the match start and the phone's next beat").toEqual([]);

  // ONE beat after the match start: the broadcast exists when it is answered (§7.2 — postBeat starts it before it answers).
  const first = await phoneOn.beat();
  const sessions = await sessionsOf(rig.orgId);
  expect(sessions.length, "the phone's first beat after the match start opened exactly one session").toBe(1);
  const s = sessions[0]!;
  expect(s, "an AUTOMATIC start, on this fixture, on this phone's pairing, attributed to the code's issuer").toMatchObject({
    fixture_id: on.id, start_cause: "automatic", pairing_id: await pairingOf(phoneOn, on.id), created_by: rig.ownerId,
  });
  // Requested/provisioning answer waiting; armed answers go-live (§6.3.3) — and a go-live names who started it.
  expect(["waiting", "go-live"], "the starting beat's own answer: waiting while the session provisions, or go-live").toContain(first.ok?.state);
  if (first.ok?.state === "go-live") expect(first.ok, "a go-live on the starting beat names the automatic start").toMatchObject({ sid: s.id, startedBy: "automatic" });
  const heard = first.ok?.state === "go-live" ? first.ok : await beatUntil(phoneOn, "go-live", INGEST_SEEN_MS);
  expect(heard, "the phone hears go-live for THAT session, started automatically").toMatchObject({ state: "go-live", sid: s.id, startedBy: "automatic" });
  const settings = await settingsOf(on.id);
  expect(settings, "the switch row records the start: once (A16)").toMatchObject({ auto_stream: true, auto_start_session_id: s.id, auto_start_refusal: null, auto_start_blocked_at: null });
  expect(settings!.auto_started_at, "auto_started_at is stamped").not.toBeNull();
  const read = await readPhone(page, on);
  expect(read.auto, "the organiser's read: enabled, started, not blocked, no refusal").toMatchObject({ enabled: true, blocked: false, refusal: null, refusalAt: null });
  expect(read.auto!.startedAt, "…with the start's instant").not.toBeNull();
  expect(read.session, "…and the open session").toEqual({ id: s.id });

  // The negative pair, the same run: the untouched fixture is in play with a phone in Automatic — and starts nothing,
  // beat after beat, through a whole retry window (a refused or skipped attempt may repeat after it).
  const quietUntil = Date.now() + QUIET_WINDOW_MS;
  let offBeats = 0;
  while (Date.now() < quietUntil) {
    const a = await phoneOff.beat();
    offBeats++;
    expect([a.ok?.state, a.ok?.autoAllowed], `beat ${offBeats} on the switched-off fixture`).toEqual(["waiting", false]);
    await new Promise((r) => setTimeout(r, BEAT_MS));
  }
  expect(offBeats, "the switched-off fixture was beaten through the whole window").toBeGreaterThanOrEqual(2);
  expect((await sessionsOf(rig.orgId)).map((x) => x.fixture_id), "the switched-off fixture has no session; the switched-on one has its one").toEqual([on.id]);
  expect(await settingsOf(off!.id), "nothing wrote a switch row for it").toBeNull();
  expect((await readPhone(page, off!)).auto, "its read: no automatic state at all").toBeNull();
  // A16, once: more beats on the started fixture open nothing more.
  for (let i = 0; i < 2; i++) await phoneOn.beat(publishing(s.id)());
  expect((await sessionsOf(rig.orgId)).length, "still exactly one session").toBe(1);
});

// ===========================================================================
// 2 — W7/§7.3: the automatic stop, AUTO_STOP_AFTER_RESULT_SECONDS after the result; a broadcast started after the
//     result is never stopped (A15's other half)
// ===========================================================================
test("auto stop: the match streams automatically, the result goes in on the device link, and the phone's first beat after the tuned delay hears over auto_stopped (not one before it); a broadcast the organiser starts AFTER the result is never auto-stopped", async ({
  page,
}) => {
  test.setTimeout(Math.max(
    180_000,
    SLOT_WAIT_MS + SEED_MS + NAV_MS + 2 * INGEST_SEEN_MS + 2 * (AUTO_STOP_MS + AUTO_STOP_LATE_MS) + 4 * POLL_WAIT_MS + 30_000,
  ));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  expect(rig.monthlyRate, "premise: the plan's month pays for two broadcasts").toBeGreaterThanOrEqual(2);
  const target = await addTargetApi(page, rig.orgId, "Auto stop destination");
  const f = rig.fixtures[0]!;
  await putAutoStream(page, f, true);
  const phone = await pairPhoneOnFixture(page, fixturePath(rig, f), { captureMode: "automatic" });
  phone.keepAlive("publishing");
  const link = await mintDeviceLink(page, rig, f);
  await streamSlot();
  await deviceLinkEvent(link, f, "core.start", {});
  const s = await newestSession(rig.orgId, f.id, BEAT_MS + POLL_WAIT_MS);
  expect(s.start_cause, "the broadcast started automatically").toBe("automatic");
  await untilDbState(s.id, ["live"], 2 * INGEST_SEEN_MS, "the automatic broadcast goes live (the phone publishing its sid)");

  // The result, courtside. From here the beats are explicit, each one a tick of the session (it names the sid).
  phone.silence();
  const finishedAt = await resultOnDeviceLink(link, f);
  expect(await surfaceOf(f, "generic.result"), "the result was written by the device link").toEqual({ device_link_id: link.id });
  const notYet = await phone.beat(publishing(s.id)());
  expect(notYet.ok, "a beat inside the delay: still live — the stop waits for AUTO_STOP_AFTER_RESULT_SECONDS").toMatchObject({ state: "live", sid: s.id });
  const over = await beatUntil(phone, "over", AUTO_STOP_MS + AUTO_STOP_LATE_MS, publishing(s.id));
  expect(over, "the phone hears over, auto_stopped, for its broadcast").toMatchObject({ state: "over", sid: s.id, endReason: "auto_stopped" });
  const ended = await sessionRow(s.id);
  expect([ended.state, ended.end_reason], "the session ended auto_stopped").toEqual(["completed", "auto_stopped"]);
  const lag = ended.ended_at!.getTime() - finishedAt.getTime();
  expect(lag, `the stop came no sooner than the delay after the result (${lag} ms)`).toBeGreaterThanOrEqual(AUTO_STOP_MS - CLOCKS_MS);
  expect(lag, `…and within a beat of it (${lag} ms)`).toBeLessThanOrEqual(AUTO_STOP_MS + AUTO_STOP_LATE_MS);

  // A broadcast the organiser starts AFTER the result: the switch is still on, the phone still in Automatic, the delay
  // long past — and it is never stopped (session_predates_result, A15's other half).
  const late = await apiJson<{ sessionId: string }>(page.request, `/api/v1/fixtures/${f.id}/stream-sessions`, "POST", { mode: "passthrough", targetId: target.id });
  expect(late.status, `the organiser's Go live after the result: ${JSON.stringify(late.error)}`).toBe(201);
  const lateSid = late.data!.sessionId;
  const goLive = await beatUntil(phone, "go-live", INGEST_SEEN_MS);
  expect(goLive, "the phone hears the organiser's go-live").toMatchObject({ sid: lateSid, startedBy: "organiser" });
  // Ticks past the moment the stop WOULD be due for it: every beat names its sid; watch the delay and two beats more.
  const dueBy = Math.max(Date.now(), finishedAt.getTime() + AUTO_STOP_MS) + 2 * BEAT_MS;
  let ticks = 0;
  while (Date.now() < dueBy) {
    const a = await phone.beat(publishing(lateSid)());
    expect(a.ok?.state, `tick ${ticks + 1}: the post-result broadcast is not over`).not.toBe("over");
    ticks++;
    await new Promise((r) => setTimeout(r, BEAT_MS));
  }
  const lateRow = await sessionRow(lateSid);
  expect(ticks, "the post-result broadcast was ticked through the window").toBeGreaterThanOrEqual(2);
  expect(lateRow.phone_beat_at!.getTime(), "…including after the stop would have been due").toBeGreaterThan(finishedAt.getTime() + AUTO_STOP_MS);
  expect([lateRow.state === "completed" || lateRow.state === "failed", lateRow.end_reason], "it is still open, never auto-stopped").toEqual([false, null]);
});

// ===========================================================================
// 3 — A12 + A15: the panel's Stop blocks a restart; a broadcast started again BY HAND is still auto-stopped
// ===========================================================================
test("A12 + A15: an automatic broadcast, the organiser's Stop on the panel → blocked, and more beats start nothing; the organiser's Go live by hand → the result → that broadcast is auto-stopped after the delay", async ({
  page,
}) => {
  test.setTimeout(Math.max(
    180_000,
    SLOT_WAIT_MS + SEED_MS + 2 * NAV_MS + OWN_LONGEST_HOLD_MS + 4 * POLL_WAIT_MS + 30_000,
  ));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  expect(rig.monthlyRate, "premise: the plan's month pays for two broadcasts").toBeGreaterThanOrEqual(2);
  await addTargetApi(page, rig.orgId, "A12 destination");
  const f = rig.fixtures[0]!;
  await putAutoStream(page, f, true);
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page, { captureMode: "automatic", mode: "publishing" });
  const link = await mintDeviceLink(page, rig, f);
  await streamSlot();
  await deviceLinkEvent(link, f, "core.start", {});
  const auto = await newestSession(rig.orgId, f.id, BEAT_MS + POLL_WAIT_MS);
  expect(auto.start_cause).toBe("automatic");
  await expect(body.getByTestId("stream-state-pill"), "the panel shows the automatic broadcast live").toHaveText(en("stream.phone.state.live"), { timeout: 2 * INGEST_SEEN_MS });

  // The organiser's Stop, on the panel.
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  const stopped = await untilDbState(auto.id, ["completed"], POLL_WAIT_MS, "the panel's Stop ends the broadcast");
  expect(stopped.end_reason, "the organiser's stop").toBe("stopped");
  const blocked = await settingsOf(f.id);
  expect(blocked!.auto_start_blocked_at, "A12: the panel's Stop stamped auto start off for this match").not.toBeNull();
  const read = await readPhone(page, f);
  expect(read.auto, "the organiser's read: blocked, the earlier start kept").toMatchObject({ enabled: true, blocked: true, refusal: null });
  // More beats (the keep-alive) through a whole retry window: no restart. (Witnesses A16's "once" as well as A12's block:
  // this broadcast also started automatically and ingested. The block ALONE is the next test's.)
  const beatsBefore = phone.beatsSent;
  await new Promise((r) => setTimeout(r, QUIET_WINDOW_MS));
  expect(phone.beatsSent - beatsBefore, "the phone kept beating through the window").toBeGreaterThanOrEqual(2);
  expect((await sessionsOf(rig.orgId)).map((x) => x.id), "no restart").toEqual([auto.id]);

  // The organiser's Go live by hand (always available, W7), on the panel: back to Ready from the ended broadcast first.
  await body.getByTestId("stream-again").click();
  const goLive = body.getByTestId("stream-go-live");
  await expect(goLive).toBeEnabled({ timeout: POLL_WAIT_MS });
  await goLive.click();
  const byHand = await newestSession(rig.orgId, f.id, POLL_WAIT_MS, [auto.id]);
  expect(byHand.start_cause, "the hand-started broadcast").toBe("organiser");
  await expect.poll(() => phone.sid, { message: "the phone holds the hand-started broadcast", timeout: INGEST_SEEN_MS }).toBe(byHand.id);

  // A15: the result → that broadcast is still auto-stopped, the delay after it.
  const finishedAt = await resultOnDeviceLink(link, f);
  const ended = await untilDbState(byHand.id, ["completed", "failed"], AUTO_STOP_MS + AUTO_STOP_LATE_MS + POLL_WAIT_MS, "A15: the hand-started broadcast ends after the result");
  expect(ended.end_reason, "A15: auto stop applies to a broadcast restarted by hand").toBe("auto_stopped");
  expect(ended.ended_at!.getTime() - finishedAt.getTime(), "no sooner than the delay").toBeGreaterThanOrEqual(AUTO_STOP_MS - CLOCKS_MS);
  await expect.poll(() => phone.lastOver, { message: "the phone hears over, auto_stopped", timeout: 2 * BEAT_MS + 5_000 })
    .toEqual({ sid: byHand.id, endReason: "auto_stopped" });
  await expect(body.getByTestId("stream-state-pill"), "the panel shows it ended").toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
});

// ===========================================================================
// 4 — A12 alone: the block is the ONLY thing that keeps a match from auto-starting — the differential is who stopped
// ===========================================================================
test("A12 alone: before the match, a hand-started broadcast that never ingested is stopped — by the organiser on the panel (Cancel), the match start then starts nothing (blocked); by the phone's own stop, the same match start auto-starts", async ({
  page,
  browser,
}) => {
  test.setTimeout(Math.max(
    180_000,
    SLOT_WAIT_MS + SEED_MS + 3 * NAV_MS + 2 * PAD_MS + 2 * (QUIET_WINDOW_MS + INGEST_SEEN_MS) + 8 * POLL_WAIT_MS + 30_000,
  ));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 4 });
  expect(rig.monthlyRate, "premise: the plan's month pays for three broadcasts").toBeGreaterThanOrEqual(3);
  await addTargetApi(page, rig.orgId, "A12 alone destination");
  const blockedF = rig.fixtures[0]!;
  const freeF = rig.fixtures.find((x) => ![blockedF.home, blockedF.away].includes(x.home) && ![blockedF.home, blockedF.away].includes(x.away))!;
  expect(freeF, "premise: a second fixture sharing no entrant").toBeTruthy();
  await putAutoStream(page, blockedF, true);
  await putAutoStream(page, freeF, true);

  /** A hand-started broadcast whose video never arrives: the fake input is held disconnected (the T7 control overrides its
   *  connect timer), so "no session of this fixture ever received ingest" keeps holding after it ends. */
  const handStartedNoIngest = async (body: Locator, f: Fx, notIn: string[]): Promise<SessionRow> => {
    const goLive = body.getByTestId("stream-go-live");
    await expect(goLive).toBeEnabled({ timeout: POLL_WAIT_MS });
    await goLive.click();
    const s = await newestSession(rig.orgId, f.id, POLL_WAIT_MS, notIn);
    let input: string | null = null;
    await expect.poll(async () => {
      const [r] = await withDb((sql) => sql<{ id: string | null }[]>`
        select ingest_input_id as id from fixture_stream_inputs where session_id = ${s.id} order by slot limit 1`);
      input = r?.id ?? null;
      return input;
    }, { message: "the session's fake input exists", timeout: POLL_WAIT_MS, intervals: [200] }).not.toBeNull();
    const held = await page.request.post(`/api/internal/relay/fake-ingest/${input}`, { data: { state: "disconnected" } });
    expect(held.status(), "hold the input disconnected").toBe(200);
    expect(s.start_cause).toBe("organiser");
    return s;
  };

  await streamSlot();
  // ---- the blocked fixture: Go live and stop, both on the panel, before the match starts ----
  // Nothing is on air (the video never arrives), so the panel offers Cancel, not Stop: the same stop route, the
  // organiser's own intent (plan R-3, FP12) — and nothing to confirm while nothing is on air.
  const bodyB = await openPhoneTab(page, rig, blockedF);
  const phoneB = await pairedPhone(page, { captureMode: "automatic", mode: "publishing" });
  const handB = await handStartedNoIngest(bodyB, blockedF, []);
  const cancel = bodyB.getByTestId("stream-cancel");
  await expect(cancel, "the panel waits for the video and offers Cancel").toBeVisible({ timeout: POLL_WAIT_MS });
  await cancel.click();
  const stoppedB = await untilDbState(handB.id, ["completed", "failed"], POLL_WAIT_MS, "the panel's Cancel ends it");
  expect([stoppedB.end_reason, stoppedB.first_ingest_at], "premise: stopped by the organiser, and it never ingested").toEqual(["stopped", null]);
  const sB = await settingsOf(blockedF.id);
  expect([sB!.auto_started_at, sB!.auto_start_blocked_at !== null], "premise: never auto-started; the panel's Cancel stamped the block").toEqual([null, true]);
  const linkB = await mintDeviceLink(page, rig, blockedF);
  await startOnScorePad(browser, linkB, blockedF);
  const beatsB = phoneB.beatsSent;
  await new Promise((r) => setTimeout(r, QUIET_WINDOW_MS));
  expect(phoneB.beatsSent - beatsB, "the phone kept beating, in Automatic, through the window").toBeGreaterThanOrEqual(2);
  expect((await sessionsOf(rig.orgId)).map((x) => x.id), "A12: the match start started NOTHING — only the block stood in the way").toEqual([handB.id]);
  expect((await readPhone(page, blockedF)).auto, "the read says why: blocked").toMatchObject({ enabled: true, blocked: true, startedAt: null, refusal: null });
  await phoneB.dispose();

  // ---- the differential: the same steps, but the PHONE stops the hand-started broadcast (not an organiser's Stop) ----
  // The A17 stop (`stopped: X`), which ends X as the phone's own stop and keeps the phone paired — T21's `ended` beat
  // would end the pairing too, and a rescan would be a second difference between the halves.
  const bodyF = await openPhoneTab(page, rig, freeF);
  const phoneF = await pairedPhone(page, { captureMode: "automatic", mode: "publishing" });
  const handF = await handStartedNoIngest(bodyF, freeF, [handB.id]);
  phoneF.silence();
  const own = await phoneF.stoppedBeat(handF.id);
  expect(own.ok, "the phone's own Stop: over").toMatchObject({ state: "over", sid: handF.id });
  const stoppedF = await untilDbState(handF.id, ["completed", "failed"], POLL_WAIT_MS, "the phone's Stop ends it");
  expect([stoppedF.end_reason, stoppedF.first_ingest_at], "premise: the phone stopped it, and it never ingested").toEqual(["operator_stopped", null]);
  expect((await settingsOf(freeF.id))!.auto_start_blocked_at, "the phone's own Stop stamps no block").toBeNull();
  phoneF.keepAlive("publishing");
  const linkF = await mintDeviceLink(page, rig, freeF);
  await startOnScorePad(browser, linkF, freeF);
  const autoF = await newestSession(rig.orgId, freeF.id, BEAT_MS + POLL_WAIT_MS, [handF.id]);
  expect(autoF.start_cause, "the positive half: the same match start auto-starts when nobody blocked it").toBe("automatic");
});

// ===========================================================================
// 5 — §7.2 refusal: no credit → the read serves the refusal; credits granted → the retry starts it, refusal cleared
// ===========================================================================
test("refusal: balance 0 → the automatic start is refused, the read serves auto.refusal no_credit, no session and nothing spent; credits granted → the next attempt AFTER the retry spacing starts it and the refusal clears", async ({
  page,
}) => {
  test.setTimeout(Math.max(
    180_000,
    SLOT_WAIT_MS + SEED_MS + NAV_MS + 2 * QUIET_WINDOW_MS + 6 * POLL_WAIT_MS + 30_000,
  ));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "Refusal destination");
  const f = rig.fixtures[0]!;
  // The panel's read grants the month (R3b, idempotent per month) — granted HERE, so the start's own ensure cannot grant
  // it again after the drain below.
  await openPhoneTab(page, rig, f);
  await expect.poll(async () => (await ledger(rig.orgId)).rows.some((r) => r.reason === "grant"), { message: "premise: the month was granted", timeout: POLL_WAIT_MS }).toBe(true);
  await drainMonthlyTo(rig.orgId, 0);
  expect((await ledger(rig.orgId)).total, "premise: balance 0").toBe(0);
  await putAutoStream(page, f, true);
  const phone = await pairedPhone(page, { captureMode: "automatic" });
  const link = await mintDeviceLink(page, rig, f);
  await streamSlot();
  await deviceLinkEvent(link, f, "core.start", {});

  let refused: StreamPhone["auto"] = null;
  await expect.poll(async () => {
    refused = (await readPhone(page, f)).auto;
    return refused?.refusal ?? null;
  }, { message: "the read serves the refusal", timeout: BEAT_MS + POLL_WAIT_MS, intervals: [500] }).toBe("no_credit");
  // From here every beat is an explicit one. The keep-alive beats every POLL_STARTING_SECONDS, which can EQUAL the retry
  // spacing (it does in CI), so its beats could only ever land after the spacing ran out — and a server that ignored the
  // spacing would pass on them. The beats below come every second instead.
  phone.silence();
  expect(refused, "refused: never started, not blocked, the attempt's instant").toMatchObject({ enabled: true, startedAt: null, blocked: false, refusal: "no_credit" });
  const refusedAt = new Date(refused!.refusalAt!).getTime();
  expect(Number.isFinite(refusedAt), "refusalAt is an instant").toBe(true);
  expect(await sessionsOf(rig.orgId), "a refused start writes no session row").toEqual([]);
  expect((await ledger(rig.orgId)).rows.filter((r) => r.reason === "consume"), "…and spends nothing").toEqual([]);
  expect((await ledger(rig.orgId)).total, "…and the start's own grant check gave nothing back (the month is granted once)").toBe(0);
  expect((await settingsOf(f.id))!.auto_started_at, "a refusal never stamps auto_started_at").toBeNull();

  // The spacing runs from the LATEST attempt's claim (the row's auto_start_attempted_at) — a keep-alive beat may have
  // made a second refused attempt between the read above and the silence, so the read's refusalAt can be the older one.
  const attempted = (await settingsOf(f.id))!.auto_start_attempted_at;
  expect(attempted, "the refused attempt's claim is stamped").not.toBeNull();
  expect(attempted!.getTime(), "…no earlier than the refusal the read served").toBeGreaterThanOrEqual(refusedAt);
  const dueAt = attempted!.getTime() + RETRY_MS;

  // Credit to spend, and a beat every second: each one answered INSIDE the spacing is a due start in every way but the
  // spacing — it must start nothing. The first one after the spacing starts the broadcast.
  await grantRigPackCredits(rig.orgId, 1);
  let beats = 0;
  let inside = 0;
  let s: SessionRow | undefined;
  const giveUpAt = dueAt + 2 * BEAT_MS + POLL_WAIT_MS;
  while (Date.now() < giveUpAt) {
    await phone.beat();
    const answeredAt = Date.now();
    beats++;
    const rows = await sessionsOf(rig.orgId);
    if (answeredAt < dueAt - CLOCKS_MS) {
      expect(rows, `beat ${beats}, answered ${dueAt - answeredAt} ms before the spacing runs out, with credit to spend: starts nothing`).toEqual([]);
      inside++;
    }
    if (rows.length > 0) {
      s = rows[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  expect(inside, "beats counted inside the spacing after the grant (none would leave the spacing untested)").toBeGreaterThanOrEqual(1);
  expect(s, `the retry started a session once the spacing ran out (${beats} beats)`).toBeDefined();
  expect(s!.start_cause, "the retry starts it automatically").toBe("automatic");
  expect(s!.created_at.getTime() - attempted!.getTime(), "the retry waited out AUTO_START_RETRY_SECONDS after the latest refused attempt").toBeGreaterThanOrEqual(RETRY_MS - CLOCKS_MS);
  const after = (await readPhone(page, f)).auto;
  expect(after, "the read: started, the refusal cleared").toMatchObject({ enabled: true, refusal: null, refusalAt: null, blocked: false });
  expect(after!.startedAt, "…with the start's instant").not.toBeNull();
  expect(phone.captureMode).toBe("automatic");
});

// ===========================================================================
// 6 — the switch's API (§7.1): 200 for the organiser, 404 for no such fixture, 403 for a device link; the phone hears it
// ===========================================================================
test("the switch over the API: the organiser's PUT answers 200 and the paired phone's next beat carries autoAllowed both ways; an unknown fixture is 404 and a device link is 403, each writing nothing", async ({
  page,
}) => {
  test.setTimeout(Math.max(120_000, SEED_MS + NAV_MS + 6 * POLL_WAIT_MS + 30_000));
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const f = rig.fixtures[0]!;
  const phone = await pairPhoneOnFixture(page, fixturePath(rig, f), { captureMode: "automatic" });
  phone.silence();
  expect((await phone.beat()).ok?.autoAllowed, "no settings row: autoAllowed false (off by default)").toBe(false);

  let checked = 0;
  for (const on of [true, false, true]) {
    expect(await putAutoStream(page, f, on), `PUT {autoStream: ${on}}`).toEqual({ targetId: null, autoStream: on });
    expect((await phone.beat()).ok?.autoAllowed, `the phone's next beat hears the switch ${on ? "on" : "off"}`).toBe(on);
    expect((await readPhone(page, f)).auto?.enabled, "the organiser's read follows").toBe(on);
    checked++;
  }
  expect(checked).toBe(3);
  const again = await putAutoStream(page, f, true);
  expect(again, "the same PUT twice answers the same").toEqual({ targetId: null, autoStream: true });

  const rowsBefore = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_settings where org_id = ${rig.orgId}`);
  const unknown = await apiJson(page.request, `/api/v1/fixtures/${randomUUID()}/stream-settings`, "PUT", { autoStream: true });
  expect(unknown.status, `an unknown fixture: ${JSON.stringify(unknown.error)}`).toBe(404);

  // The fixture's own device link: it opens THIS fixture's scoring door, and only that one (doc 13 §7).
  const link = await mintDeviceLink(page, rig, f);
  const byLink = await link.api.put(`/api/v1/fixtures/${f.id}/stream-settings`, { data: { autoStream: false } });
  expect(byLink.status(), `a device link's PUT: ${await byLink.text()}`).toBe(403);
  const rowsAfter = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_settings where org_id = ${rig.orgId}`);
  expect(rowsAfter[0]!.n, "no refusal wrote a row").toBe(rowsBefore[0]!.n);
  expect((await settingsOf(f.id))!.auto_stream, "…and the device link's PUT changed nothing").toBe(true);
});

// ===========================================================================
// Panel kit (capture-phone.spec.ts's shapes)
// ===========================================================================

const streamControl = (page: Page): Locator => page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');

/** The fixture page, its Stream control, the Phone tab. Returns the panel's `[data-phone-body]`. */
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

async function confirmStop(page: Page): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const ok = dialog.getByRole("button", { name: en("stream.phone.stop"), exact: true });
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(dialog).toHaveCount(0, { timeout: POLL_WAIT_MS });
}
