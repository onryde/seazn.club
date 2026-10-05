// Capture QR v2 §11.1.5 (T12) — the PHONE ROUTES, walked against a real production server on RELAY_DRIVERS=fake.
//
// The phone is `helpers/fake-capture-phone.ts`: Seazn Capture as an HTTP client that reads the QR text FROM THE PANEL'S
// PASTE-CODE FIELD and drives the real descriptor GET, beats POST and start POST with it (AGENTS.md failure class 1 —
// the panel's own output through the real consumer, never a fixture on both ends). Every answer is parsed by the zod
// twin of the published contract and must be `private, no-store`.
//
// The organiser's half is TAPPED in the panel; the phone's half is the HTTP the app would send. Setup reaches a state by
// SQL or the API (a fresh org, a destination, a drained balance, a finished fixture's backdated stamp). The input the
// fake ingest made for a session is driven through the T7 control route, `POST /api/internal/relay/fake-ingest/{id}`,
// which overrides its connect timer — the only way a lost phone's video can stop on a fake driver.
//
// THE ENVIRONMENT IS A PREMISE, ASSERTED (beforeEach). The server must run the fake drivers on ENV_NAME local or ci (the
// control route answers "Unknown fake input" for an id it never made), and the R10 tunables shortened, so A14, ask 10
// and W19 run in seconds: DEAD_PHONE_TAKEOVER_SECONDS, PHONE_LOST_LIVE_MINUTES and PHONE_SILENT_FLOOR_SECONDS. This
// process reads the SAME variables to derive its budgets (AGENTS.md #20), so each is required here too, as is
// FAKE_INGEST_CONNECT_AFTER_MS (ask 10 holds an input before it connects) and CRON_SECRET (W22). PHONE_SILENT_SLACK_SECONDS
// is not tunable (I-3): every silence below is max(floor, cadence + slack), computed from the config's own constants.
//
// Single-sport (generic) by design: the phone routes, the session lifecycle and the ledger are fixture- and org-level and
// read no sport (the stream-relay walkthrough's own reasoning).
//
// Every rig is a FRESH org: balances, grants and overrides are org-wide and the leg runs fully parallel.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  scoreFixture,
  setBoolEntitlementOverrideSql,
} from "../helpers";
import { grantRigPackCredits, setRigPlan, signInAs } from "../overlay-kit";
import {
  disposeFakePhones,
  fakeCapturePhone,
  newPhoneRequest,
  pairedPhone,
  readPanelQrText,
  type FakeCapturePhone,
} from "../helpers/fake-capture-phone";
import { STREAM_POLL_MS } from "../../src/lib/stream-session-view";
import { FAKE_CONNECT_AFTER_MS_DEFAULT, FakeIngest } from "../../src/server/relay/fakes";
import {
  CODE_GRACE_AFTER_FINISH_MINUTES,
  DEAD_PHONE_TAKEOVER_SECONDS,
  FREE_RESTARTS_PER_WINDOW,
  MAX_DURATION_MINUTES,
  PHONE_LOST_LIVE_MINUTES,
  PHONE_SILENT_FLOOR_SECONDS,
  PHONE_SILENT_SLACK_SECONDS,
  POLL_FAR_SECONDS,
  POLL_NEAR_SECONDS,
  RECONNECT_QUIET_SECONDS,
} from "../../src/server/relay/config";

// ===========================================================================
// The environment (asserted in beforeEach — a module-level throw would abort the whole leg, not this file)
// ===========================================================================

const ENV_PROBLEMS: string[] = [];
/** A positive whole number from this process's env, parsed as strictly as the server's `tunable()`; null + a recorded
 *  problem when it is missing or junk, so the beforeEach names every gap at once. */
function wholeEnv(name: string, opts: { below?: number } = {}): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    ENV_PROBLEMS.push(`${name} is not set`);
    return null;
  }
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    ENV_PROBLEMS.push(`${name}=${JSON.stringify(raw)} is not a positive whole number`);
    return null;
  }
  if (opts.below !== undefined && Number(raw) >= opts.below) {
    ENV_PROBLEMS.push(`${name}=${raw} is not shortened (the default is ${opts.below}); the walkthrough budgets assume a tuned server`);
  }
  return Number(raw);
}
const TAKEOVER_S = wholeEnv("DEAD_PHONE_TAKEOVER_SECONDS", { below: DEAD_PHONE_TAKEOVER_SECONDS }) ?? DEAD_PHONE_TAKEOVER_SECONDS;
const LOST_LIVE_MIN = wholeEnv("PHONE_LOST_LIVE_MINUTES", { below: PHONE_LOST_LIVE_MINUTES }) ?? PHONE_LOST_LIVE_MINUTES;
const SILENT_FLOOR_S = wholeEnv("PHONE_SILENT_FLOOR_SECONDS", { below: PHONE_SILENT_FLOOR_SECONDS }) ?? PHONE_SILENT_FLOOR_SECONDS;
const FAKE_CONNECT_MS = wholeEnv("FAKE_INGEST_CONNECT_AFTER_MS") ?? FAKE_CONNECT_AFTER_MS_DEFAULT;
if (!process.env.CRON_SECRET?.trim()) ENV_PROBLEMS.push("CRON_SECRET is not set (W22 posts the cron tick)");
if (!process.env.DATABASE_URL) ENV_PROBLEMS.push("DATABASE_URL is not set");

// ===========================================================================
// Clocks — every wait DERIVED from the constants that set its pace (AGENTS.md #20)
// ===========================================================================
const LIVE_WAIT_MS = FAKE_CONNECT_MS + 2 * STREAM_POLL_MS + 5_000;
/** One poll plus slack — a state the next read must already show. */
const POLL_WAIT_MS = STREAM_POLL_MS + 5_000;
const SEED_MS = 60_000;
const NAV_MS = 30_000;
const CYCLE_MS = LIVE_WAIT_MS + 3 * POLL_WAIT_MS;
/** How late a server-timed end may land after its deadline: it is made by the next tick, and the panel's poll IS the
 *  tick — one poll, plus the read's own round trip. */
const END_LATE_MS = STREAM_POLL_MS + 3_000;
/** I-2's window (re-review n-1): the first poll after the start is issued within one STREAM_POLL_MS; an answer slower than
 *  a poll lets the NEXT poll through, one STREAM_POLL_MS later, and the newest of them lands — then the `current` read.
 *  The count of answers is what the test holds to one; this only bounds the clock around it. */
const I2_WINDOW_MS = 2 * STREAM_POLL_MS + 2 * POLL_WAIT_MS;
/** §6.9: how long after its last beat a phone answered `cadence` is silent — max(floor, cadence + slack), with the
 *  config's slack (not tunable) and the server's tuned floor. The rule's own arithmetic, not `silentAfterMs`. */
const silentAfterMs = (cadenceS: number): number => Math.max(SILENT_FLOOR_S, cadenceS + PHONE_SILENT_SLACK_SECONDS) * 1_000;
const W19_MS = LOST_LIVE_MIN * 60_000;
const QUIET_MS = RECONNECT_QUIET_SECONDS * 1_000;

// ===========================================================================
// Kit (file-local; the stream-relay walkthrough's shapes)
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

// The deployment's stream capacity (stream-relay.spec.ts's derivation): admission refuses a start once the ingest's
// storage headroom is below one more max-duration reservation. Keys [BASE, BASE + CAPACITY − 1) are the pool this file
// SHARES with stream-relay.spec.ts and directory-stream-destinations.spec.ts; the last key is stream-credits.spec.ts's
// and is never taken here.
const STREAM_CAPACITY = Math.floor(new FakeIngest().storage.totalStorageMinutesLimit / MAX_DURATION_MINUTES);
const POOL_SLOTS = STREAM_CAPACITY - 1;
const SLOT_LOCK_BASE = 7_301_130_000;
/** The longest any holder in the pool streams: this file's W23 (five go-live → stop cycles). */
const LONGEST_HOLD_MS = (FREE_RESTARTS_PER_WINDOW + 2) * CYCLE_MS;
const SLOT_WAIT_MS = 2 * LONGEST_HOLD_MS;

let lease: (() => Promise<void>) | null = null;
const rigsThisTest: { request: APIRequestContext; orgId: string }[] = [];

async function streamSlot(): Promise<void> {
  if (lease) return;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for the stream-slot lease");
  expect(POOL_SLOTS, "the fake's capacity leaves this pool at least one slot").toBeGreaterThanOrEqual(1);
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
    idle_timeout: 0,
  });
  const deadline = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    for (let i = 0; i < POOL_SLOTS; i++) {
      const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${SLOT_LOCK_BASE + i}::bigint) as ok`;
      if (row?.ok) {
        lease = () => sql.end();
        return;
      }
    }
    if (Date.now() > deadline) {
      await sql.end();
      throw new Error(`none of the pool's ${POOL_SLOTS} stream slot(s) free after ${SLOT_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** stream-credits.spec.ts budgets waiting out one other holder of ITS key at that holder's go-live and teardown
 *  (`LIVE_MS + NAV_MS` there; restated, a spec cannot import another spec). W22 waits no longer than one go-live → stop
 *  cycle for it, which covers that hold. */
const CREDITS_KEY_WAIT_MS = CYCLE_MS;
/** How often W22 asks for the whole pool. Each ask takes nothing it cannot keep, so it can ask often; a sibling polls a
 *  free key every 500 ms, and the whole pool is only ever free between two of their asks. */
const WHOLE_POOL_POLL_MS = 100;

/**
 * W22's exclusion (B9 review m-3; re-review n-2). The cron tick is GLOBAL — it ticks every open session on the server —
 * and in CI this file shares a server and a parallel shard with the other stream walkthroughs, whose held-WAITING rows
 * rely on nothing ticking them. Every session any of them opens is opened under one of the deployment's STREAM_CAPACITY
 * slot keys (the pool [BASE, BASE + CAPACITY − 1), shared with stream-relay and directory, and stream-credits'
 * BASE + CAPACITY − 1), held until its teardown has driven the session terminal. Holding EVERY key therefore means no
 * other test has a session open: the tick can reach this test's own and nothing else.
 *
 * Taken so that WAITING for it holds nothing (n-2: W22 used to wait for the other keys while holding its own and the
 * credits key, which stretched every sibling's wait by the whole of W22's):
 *  - the pool, BEFORE W22's go-live, all or nothing: each round asks for every pool key in key order and, short of the
 *    whole set, gives back what it got, so a sibling waiting on the pool never waits on W22's wait — only on its run;
 *  - stream-credits' key, only at the tick (`credits()`), once W22 holds the pool, and released right after it: credits
 *    waits for it at most the few seconds of a tick, never W22's run. Held at the start it would be W22's whole run, past
 *    credits' own budget.
 * The bound a sibling can wait on W22 is therefore W22's run from its go-live to its teardown: the go-live, the W19
 * window and the late tick, credits' key (instant unless stream-credits shares the shard and is mid-hold, then at most
 * CREDITS_KEY_WAIT_MS), and the end landing — measured at 79 s (b9-report.md, the "W22 pool" annotation), inside the
 * 3 × CYCLE_MS that stream-relay and directory budget a pool wait at. Only with stream-credits in the same shard and
 * mid-hold at the tick can it run past that, by at most CREDITS_KEY_WAIT_MS.
 * W22 holds both pool keys only while nobody else holds either, so it never overlaps W23's hold.
 */
async function wholePool(): Promise<{ pool: number; waitedMs: number; credits: () => Promise<{ release: () => Promise<void> }> }> {
  if (lease) throw new Error("wholePool: this test already holds a key — take the pool BEFORE any streamSlot()");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for the stream-slot lease");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
    idle_timeout: 0,
  });
  const pool = Array.from({ length: POOL_SLOTS }, (_, i) => SLOT_LOCK_BASE + i);
  const creditsKey = SLOT_LOCK_BASE + POOL_SLOTS;
  const from = Date.now();
  for (;;) {
    const got: number[] = [];
    for (const k of pool) {
      const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${k}::bigint) as ok`;
      if (!row?.ok) break;
      got.push(k);
    }
    if (got.length === pool.length) break;
    for (const k of got) await sql`select pg_advisory_unlock(${k}::bigint)`;
    if (Date.now() - from > SLOT_WAIT_MS) {
      await sql.end();
      throw new Error(`W22's exclusion: the ${pool.length} pool key(s) were never free together in ${SLOT_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, WHOLE_POOL_POLL_MS));
  }
  // The lease: every key on this connection goes with it, at teardown, once the session is terminal.
  lease = () => sql.end();
  const waitedMs = Date.now() - from;
  const credits = async (): Promise<{ release: () => Promise<void> }> => {
    const deadline = Date.now() + CREDITS_KEY_WAIT_MS;
    for (;;) {
      const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${creditsKey}::bigint) as ok`;
      if (row?.ok) {
        return {
          release: async () => {
            await sql`select pg_advisory_unlock(${creditsKey}::bigint)`;
          },
        };
      }
      if (Date.now() > deadline) throw new Error(`W22's exclusion: stream-credits' key still held after ${CREDITS_KEY_WAIT_MS} ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  return { pool: pool.length, waitedMs, credits };
}

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
    const release = lease;
    lease = null;
    await release?.();
  }
}

test.beforeEach(async ({ request }) => {
  expect(ENV_PROBLEMS, "capture-phone.spec.ts needs a tuned fake-driver environment (see the file header)").toEqual([]);
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
function en(key: string, vars: Record<string, string | number> = {}): string {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (vars[v] === undefined) throw new Error(`${key}: no value for {${v}}`);
    return String(vars[v]);
  });
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A sentence whose `{placeholders}` carry server-measured durations: the copy, with each placeholder any text. With
 *  `lead`, the strip's whole text — its lead line (a plain key) and then the sentence (§6.12's waiting strip). */
function enPattern(key: string, lead?: string): RegExp {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`ui.json has no ${key}`);
  const parts = raw.split(/\{\w+\}/).map(escapeRe);
  expect(parts.length, `${key} carries at least one placeholder`).toBeGreaterThan(1);
  return new RegExp(`^${lead === undefined ? "" : escapeRe(en(lead))}${parts.join(".+?")}$`);
}
const creditsChip = (n: number): string => (n === 1 ? en("stream.phone.credits.one") : en("stream.phone.credits.other", { n }));

interface Fx { id: string; no: number }
interface Rig { orgId: string; divisionId: string; divPath: string; fixtures: Fx[]; monthlyRate: number; tag: string }

async function seedRig(page: Page, opts: { plan?: string; entrants?: number } = {}): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+cap-${tag}@resend.dev`;
  const orgSlug = `cap-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"Capture Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Capture Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return newOrgId;
  });
  await signInAs(page, ownerEmail);
  rigsThisTest.push({ request: page.request, orgId });
  const label = `Capture ${tag}`;
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: label, visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`capture rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: label.slice(0, 40), sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  if (div.status >= 300 || !div.data) throw new Error(`capture rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
  const n = opts.entrants ?? 2;
  const ents = await addEntrantsViaApi(page.request, div.data.id, Array.from({ length: n }, (_, i) => `Side ${String.fromCharCode(65 + i)} ${tag}`));
  if (ents.status >= 300 || ents.ids.length !== n) throw new Error(`capture rig: entrants -> ${ents.status} (${ents.ids.length}/${n})`);
  const { fixtureIds } = await createStageAndGenerate(page.request, div.data.id);
  expect(fixtureIds.length, "capture rig: a league's fixture count").toBe((n * (n - 1)) / 2);
  const fixtures = await withDb(async (sql) => [
    ...(await sql<Fx[]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id} order by fixture_no`),
  ]);
  const { monthlyMatchCredits } = await setRigPlan(orgId, opts.plan ?? "pro");
  return { orgId, divisionId: div.data.id, divPath: `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}`, fixtures, monthlyRate: monthlyMatchCredits, tag };
}

interface LedgerRow { reason: string; bucket: string; delta: number; session_id: string | null }
async function ledger(orgId: string): Promise<{ total: number; rows: LedgerRow[] }> {
  const rows = await withDb(async (sql) => [
    ...(await sql<LedgerRow[]>`select reason, bucket, delta, session_id from org_stream_credits where org_id = ${orgId} order by created_at, id`),
  ]);
  return { total: rows.reduce((a, r) => a + r.delta, 0), rows };
}
const consumes = (l: { rows: LedgerRow[] }): LedgerRow[] => l.rows.filter((r) => r.reason === "consume");

interface SessionRow {
  id: string; fixture_id: string | null; state: string; end_reason: string | null; fail_reason: string | null; start_cause: string;
  pairing_id: string | null; first_ingest_at: Date | null; phone_beat_at: Date | null; ended_at: Date | null; created_at: Date;
}
async function sessionsOf(orgId: string): Promise<SessionRow[]> {
  return withDb(async (sql) => [
    ...(await sql<SessionRow[]>`
      select id, fixture_id, state, end_reason, fail_reason, start_cause, pairing_id, first_ingest_at, phone_beat_at, ended_at, created_at
        from fixture_stream_sessions where org_id = ${orgId} order by created_at`),
  ]);
}
async function sessionRow(id: string): Promise<SessionRow> {
  const [row] = await withDb((sql) => sql<SessionRow[]>`
    select id, fixture_id, state, end_reason, fail_reason, start_cause, pairing_id, first_ingest_at, phone_beat_at, ended_at, created_at
      from fixture_stream_sessions where id = ${id}`);
  expect(row, `session ${id} exists`).toBeTruthy();
  return row!;
}
interface PairingRow { id: string; phone: string; ended_at: Date | null; end_cause: string | null; last_beat_at: Date; answered_poll_seconds: number }
async function pairingsOf(fixtureId: string): Promise<PairingRow[]> {
  return withDb(async (sql) => [
    ...(await sql<PairingRow[]>`
      select p.id, p.phone, p.ended_at, p.end_cause, p.last_beat_at, p.answered_poll_seconds
        from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
       where c.fixture_id = ${fixtureId} order by p.claimed_at, p.id`),
  ]);
}
async function eventsOf(sessionId: string): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  return withDb(async (sql) => [
    ...(await sql<{ type: string; payload: Record<string, unknown> }[]>`
      select type, payload from fixture_stream_events where session_id = ${sessionId} order by occurred_at, id`),
  ]);
}
/** The newest connected poll sample — the instant W19's video clock starts from. */
async function lastConnectedAt(sessionId: string): Promise<Date | null> {
  const [r] = await withDb((sql) => sql<{ at: Date | null }[]>`
    select max(sampled_at) as at from fixture_stream_samples where session_id = ${sessionId} and source = 'poll' and ingest_state = 'connected'`);
  return r?.at ?? null;
}

async function addTargetApi(page: Page, orgId: string, label: string): Promise<{ id: string; label: string }> {
  const res = await apiJson<{ id: string; label: string }>(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", {
    kind: "youtube", label, streamKey: `e2e-${randomBytes(6).toString("hex")}`,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`addTargetApi -> ${res.status} ${JSON.stringify(res.error)}`);
  return res.data!;
}

/** SQL setup: bring the org's balance to `keep` with the rollover's own row shape ('expire', monthly). */
async function drainMonthlyTo(orgId: string, keep: number): Promise<void> {
  const l = await ledger(orgId);
  const excess = l.total - keep;
  if (excess <= 0) return;
  await withDb((sql) => sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
                            values (${orgId}, ${-excess}, 'expire', 'monthly', ${keep}, 'e2e: reach a lower balance')`);
}

const streamControl = (page: Page): Locator => page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');

/** The fixture page, its Stream control, the Phone tab. Returns the panel's `[data-phone-body]`. */
async function openPhoneTab(page: Page, rig: Rig, f: Fx): Promise<Locator> {
  await page.goto(`${rig.divPath}/f/${f.no}`);
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

/** The newest session on a fixture, waited for (a tap's row lands on the server's answer). */
async function newestSession(orgId: string, fixtureId: string, notIn: string[] = []): Promise<SessionRow> {
  let found: SessionRow | undefined;
  await expect
    .poll(async () => {
      found = (await sessionsOf(orgId)).filter((s) => s.fixture_id === fixtureId && !notIn.includes(s.id)).at(-1);
      return found?.id ?? null;
    }, { message: "the fixture has a new session row", timeout: POLL_WAIT_MS })
    .not.toBeNull();
  return found!;
}

/** The fake input a session streams to: the descriptor's own playbackUrl names it (`https://{host}/{uid}/manifest/…`). */
async function inputIdOf(phone: FakeCapturePhone): Promise<string> {
  let uid: string | null = null;
  await expect
    .poll(async () => {
      const d = await phone.get();
      if (d.ok && d.ok.state !== "waiting") uid = new URL(d.ok.playbackUrl).pathname.split("/")[1] ?? null;
      return uid;
    }, { message: "the descriptor names the session's input", timeout: POLL_WAIT_MS, intervals: [300] })
    .not.toBeNull();
  return uid!;
}
/** The same input id, read from the row the moment the input exists — for ask 10, which must flip it before the fake's
 *  connect timer (FAKE_CONNECT_MS after the input was made) fires, whatever state the session has reached. */
async function inputIdBySql(sessionId: string): Promise<string> {
  let uid: string | null = null;
  await expect
    .poll(async () => {
      const [r] = await withDb((sql) => sql<{ id: string | null }[]>`
        select ingest_input_id as id from fixture_stream_inputs where session_id = ${sessionId} order by slot limit 1`);
      uid = r?.id ?? null;
      return uid;
    }, { message: "the session's fake input exists", timeout: POLL_WAIT_MS, intervals: [200] })
    .not.toBeNull();
  return uid!;
}
/** T7's control: flip the fake input's state (overrides its connect timer). */
async function setIngest(request: APIRequestContext, inputId: string, state: "connected" | "disconnected" | "unknown"): Promise<void> {
  const res = await request.post(`/api/internal/relay/fake-ingest/${inputId}`, { data: { state } });
  expect(res.status(), `fake-ingest ${inputId} -> ${state}`).toBe(200);
}

/** Organiser Go live, tapped; waits for the row. */
async function tapGoLive(page: Page, body: Locator, rig: Rig, f: Fx, notIn: string[] = []): Promise<SessionRow> {
  await streamSlot();
  const goLive = body.getByTestId("stream-go-live");
  await expect(goLive).toBeEnabled({ timeout: POLL_WAIT_MS });
  await goLive.click();
  return newestSession(rig.orgId, f.id, notIn);
}
async function untilLive(body: Locator): Promise<void> {
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
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

// ===========================================================================
// W5 — no phone, no Go live (panel and server); the panel's own code pairs one
// ===========================================================================
test("W5: no phone → Go live disabled, the strip says pair first, and the API refuses phone_not_paired writing no row; a phone pairs through the panel's own paste code → the card folds to Paired and Go live is enabled", async ({
  page,
}) => {
  test.setTimeout(SEED_MS + 2 * NAV_MS + 4 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const target = await addTargetApi(page, rig.orgId, "W5 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const goLive = body.getByTestId("stream-go-live");

  await expect(body.getByTestId("stream-code-card"), "Ready with no phone: the code card").toBeVisible();
  await expect(goLive, "W5: no phone, no Go live").toBeDisabled();
  await expect(body.getByTestId("stream-phone-strip")).toHaveText(en("stream.phone.pairFirst"));
  await expect(body.getByTestId("stream-chain")).toHaveAttribute("data-phone", "notConnected");
  const refused = await apiJson(page.request, `/api/v1/fixtures/${f.id}/stream-sessions`, "POST", { mode: "passthrough", targetId: target.id });
  expect([refused.status, refused.error?.code], "the server refuses the Go live the panel withholds").toEqual([409, "phone_not_paired"]);
  expect(await sessionsOf(rig.orgId), "a W5 refusal writes no session row").toEqual([]);

  // The positive half: the panel's paste code, through the real claim route.
  const phone = await pairedPhone(page);
  expect(phone.qr.code, "the phone scanned the code the panel holds").toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
  await expect(goLive, "a present phone: Go live").toBeEnabled({ timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-phone-strip"), "a paired phone: no strip").toHaveCount(0);
  await expect(body.getByTestId("stream-chain")).toHaveAttribute("data-phone", "paired");
  const fold = body.getByTestId("stream-code-disclosure");
  await expect(fold.locator("summary")).toContainText(en("stream.code.paired"));
  await expect(fold.locator("summary [data-tone]")).toHaveAttribute("data-tone", "lime");
  const [pairing] = await pairingsOf(f.id);
  expect(pairing, "one pairing, this phone's, current").toMatchObject({ phone: phone.id, ended_at: null });
});

// ===========================================================================
// Operator start (§6.3.4) + I-2: the panel open at Ready picks a phone-started stream up within one poll
// ===========================================================================
test("operator start from the phone: 200 {sid}; the panel open at Ready shows it starting within ONE poll (no stale Go live, no active_session) and live after the connect; the phone hears go-live (operator), its GET carries cred and a second phone's does not; already_live and replaced refuse a second start; one consume", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + CYCLE_MS + I2_WINDOW_MS + 3 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "Operator destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const before = (await ledger(rig.orgId)).total;
  const phone = await pairedPhone(page, { mode: "publishing" });
  const goLive = body.getByTestId("stream-go-live");
  await expect(goLive, "premise: the panel rests at Ready with Go live").toBeEnabled({ timeout: POLL_WAIT_MS });

  // I-2 within ONE poll, counted in answers, not seconds (B9 review I-1): read-model requests issued after the start
  // resolved go through until one of their answers has been DELIVERED; from then on a request is HELD unanswered —
  // unless an earlier one is still in flight, because the panel keeps only the NEWEST read's answer
  // (fixture-stream-panel.tsx `phoneSeq`): holding the request that supersedes an in-flight answer would discard that
  // answer and leave the panel nothing to land (re-review n-1: a first answer slower than one poll was a false red).
  // So the panel can land exactly ONE answer after the start — the newest of the batch that went through — and a pickup
  // on any later answer never sees one and reds, however long it waits. Seconds are not the measure here, answers are:
  // I2_WINDOW_MS only bounds a server slower than a poll on the first answer, whose batch then lands on the next poll's.
  const READ_MODEL = new RegExp(`/api/v1/fixtures/${f.id}/stream-phone(\\?.*)?$`);
  let startDone = false;
  let delivered = 0;
  let inFlight = 0;
  const heldReads: (() => Promise<void>)[] = [];
  await page.route(READ_MODEL, async (route) => {
    if (!startDone) {
      await route.continue();
      return;
    }
    if (delivered > 0 && inFlight === 0) {
      heldReads.push(() => route.continue().catch(() => undefined));
      return;
    }
    inFlight++;
    try {
      const response = await route.fetch();
      await route.fulfill({ response });
      delivered++;
    } catch {
      await route.abort().catch(() => undefined); // the page went away mid-answer — nothing was delivered
    } finally {
      inFlight--;
    }
  });
  await streamSlot();
  const started = await phone.start();
  startDone = true;
  expect(started.status, `the operator's start: ${JSON.stringify(started.refusal)}`).toBe(200);
  const sid = started.ok!.sid;
  try {
    await expect(goLive, "I-2: no stale Go live once the phone has started — on the FIRST read-model answer after it").toHaveCount(0, { timeout: I2_WINDOW_MS });
    expect(delivered, "premise: a read-model answer issued after the start was delivered").toBeGreaterThanOrEqual(1);
  } finally {
    test.info().annotations.push({
      type: "I-2 hold",
      description: `${delivered} answer(s) delivered after the start (one batch: only its newest can land); ${heldReads.length} later read-model poll(s) held unanswered`,
    });
    await page.unroute(READ_MODEL);
    for (const release of heldReads.splice(0)) await release();
  }
  await expect(body.getByTestId("stream-create-error"), "nothing was tapped, nothing was refused").toHaveCount(0);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(
    new RegExp(`^(${["provisioning", "warming", "live"].map((s) => en(`stream.phone.state.${s}`)).join("|")})$`),
  );
  const row = await sessionRow(sid);
  expect(row, "the phone's start: cause operator, on the phone's pairing").toMatchObject({ fixture_id: f.id, start_cause: "operator" });
  const [pairing] = await pairingsOf(f.id);
  expect(row.pairing_id, "the session is held by the phone that started it").toBe(pairing!.id);

  // Requested / provisioning answer `waiting` (§6.3.3 row 5); the armed slot answers go-live, naming who started it.
  const heard: { a: Awaited<ReturnType<FakeCapturePhone["beat"]>>["ok"] } = { a: null };
  await expect
    .poll(async () => {
      heard.a = (await phone.beat()).ok;
      return heard.a?.state;
    }, { message: "the phone hears go-live while the session is armed", timeout: POLL_WAIT_MS, intervals: [500] })
    .toBe("go-live");
  expect(heard.a, "the phone hears its own start").toMatchObject({ state: "go-live", sid, startedBy: "operator" });
  await expect
    .poll(async () => (await phone.get()).ok?.state, { message: "the descriptor reaches the session shape", timeout: POLL_WAIT_MS, intervals: [500] })
    .toMatch(/^(warming|live)$/);
  const own = await phone.get();
  expect(own.ok && "cred" in own.ok && own.ok.cred, "the session's own phone gets cred").toBeTruthy();
  const second = await fakeCapturePhone(page, await newPhoneRequest(new URL(page.url()).origin), { qrText: JSON.stringify(phone.qr) });
  const other = await second.get();
  expect(other.ok?.state, "a second phone reads the open session").toMatch(/^(warming|live)$/);
  expect(other.ok && "cred" in other.ok, "…and never its cred").toBe(false);

  const again = await phone.start();
  expect([again.status, again.refusal], "T13: a second start names the running session and who started it").toEqual([
    409, expect.objectContaining({ code: "already_live", sid, startedBy: "operator" }),
  ]);
  const notCurrent = await second.start();
  expect([notCurrent.status, notCurrent.refusal?.code], "T12: a phone that is not the slot's current phone starts nothing").toEqual([409, "replaced"]);

  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
  await expect.poll(async () => consumes(await ledger(rig.orgId)).length, { timeout: POLL_WAIT_MS }).toBe(1);
  expect((await ledger(rig.orgId)).total, "one credit, at go-live").toBe(before - 1);
  expect((await sessionsOf(rig.orgId)).length, "ONE session row").toBe(1);

  // The organiser's Stop: the phone hears `over stopped`, then waits on the SAME code.
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
  const over = await phone.beat({ sid, state: "publishing" });
  expect(over.ok, "the phone that held it hears over, stopped").toMatchObject({ state: "over", sid, endReason: "stopped" });
  const waiting = await phone.beat();
  expect(waiting.ok?.state, "back to waiting on the same code").toBe("waiting");
  // §6.3.1: the descriptor serves the ENDED session (completed, its wire endReason, no cred) until a newer one exists —
  // so a phone that fetches after the end reads the right line.
  const after = (await phone.get()).ok;
  expect(after, "its descriptor: the ended session, stopped").toMatchObject({ state: "completed", sid, endReason: "stopped" });
  expect(after && "cred" in after, "…and no cred").toBe(false);
});

// ===========================================================================
// Operator start refusals (§6.7.2) — each gate, then the positive half on the same rig
// ===========================================================================
test("operator start refusals: no destination → 409 no_destination; balance 0 → 402 no_credit; the relay switched off by an override → 403 not_entitled; each writes no row and spends nothing — and with every gate open the same phone starts", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const f = rig.fixtures[0]!;
  await openPhoneTab(page, rig, f); // the read grants the month (R3b)
  const phone = await pairedPhone(page);

  const noDest = await phone.start();
  expect([noDest.status, noDest.refusal?.code], "no destination to stream to").toEqual([409, "no_destination"]);

  await addTargetApi(page, rig.orgId, "Refusals destination");
  await drainMonthlyTo(rig.orgId, 0);
  expect((await ledger(rig.orgId)).total, "premise: balance 0").toBe(0);
  const noCredit = await phone.start();
  expect([noCredit.status, noCredit.refusal?.code], "no credit and no reuse window").toEqual([402, "no_credit"]);

  await grantRigPackCredits(rig.orgId, 1);
  await setBoolEntitlementOverrideSql(rig.orgId, "streaming.relay", false);
  await invalidateOrgEntitlements(page.request, rig.orgId);
  const notEntitled = await phone.start();
  expect([notEntitled.status, notEntitled.refusal?.code], "the relay switched off for this org").toEqual([403, "not_entitled"]);

  expect(await sessionsOf(rig.orgId), "no refusal wrote a session row").toEqual([]);
  expect(consumes(await ledger(rig.orgId)), "no refusal spent a credit").toEqual([]);

  // The positive half: the same phone, every gate open.
  await setBoolEntitlementOverrideSql(rig.orgId, "streaming.relay", true);
  await invalidateOrgEntitlements(page.request, rig.orgId);
  await streamSlot();
  const ok = await phone.start();
  expect(ok.status, `with a destination, a credit and the relay on, the phone starts: ${JSON.stringify(ok.refusal)}`).toBe(200);
  expect((await sessionsOf(rig.orgId)).map((s) => s.id)).toEqual([ok.ok!.sid]);
});

// ===========================================================================
// A9 — a second phone at Ready takes the slot (the first is replaced); on a LIVE slot a new claim is taken
// ===========================================================================
test("A9: a second phone that scans at Ready takes the slot and the first hears replaced (a resume too); on a LIVE slot a third phone's claim is taken, and the broadcast is untouched", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + CYCLE_MS + 4 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "A9 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const qrText = await readPanelQrText(page);
  const origin = new URL(page.url()).origin;
  const a = await fakeCapturePhone(page, await newPhoneRequest(origin), { qrText });
  const b = await fakeCapturePhone(page, await newPhoneRequest(origin), { qrText });
  expect((await a.claim("new")).ok?.state, "A claims a free slot").toBe("waiting");
  expect((await b.claim("new")).ok?.state, "T2: B's fresh scan takes a slot that is not live").toBe("waiting");
  const replaced = await a.beat();
  expect(replaced.ok?.state, "T7: A's next beat — replaced").toBe("replaced");
  expect((await a.claim("resume")).ok?.state, "T6: A's resume does not win the slot back").toBe("replaced");
  const pairings = await pairingsOf(f.id);
  expect(pairings.map((p) => [p.phone, p.ended_at === null]), "A's pairing ended, B's current").toEqual([[a.id, false], [b.id, true]]);
  b.keepAlive("publishing");

  // Live, held by B.
  const session = await tapGoLive(page, body, rig, f);
  await untilLive(body);
  const c = await fakeCapturePhone(page, await newPhoneRequest(origin), { qrText });
  const taken = await c.claim("new");
  expect(taken.ok?.state, "T3: a fresh scan on a LIVE slot is taken").toBe("taken");
  expect((await a.beat()).ok?.state, "the replaced phone stays replaced").toBe("replaced");
  const row = await sessionRow(session.id);
  expect(row.state, "the broadcast is untouched").toBe("live");
  expect(row.pairing_id, "still B's").toBe(pairings[1]!.id);
  const events = await eventsOf(session.id);
  expect(events.filter((e) => e.type === "claim_refused").map((e) => e.payload.claimRow), "the refused claim is on the record").toEqual(["T3"]);
});

// ===========================================================================
// A14 — a dead phone's live slot is taken over: same sid, no second consume; the A17 edge
// ===========================================================================
test("A14: the live phone dies (beats stop, its input disconnects) → after the tuned takeover window a new phone's claim TAKES OVER the same sid, with cred, and no second consume; the dead phone hears replaced and its late stop is ignored (T24a); the new phone reconnects and the stream stays live", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + CYCLE_MS + TAKEOVER_S * 1_000 + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "A14 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const a = await pairedPhone(page, { mode: "publishing" });
  const session = await tapGoLive(page, body, rig, f);
  await untilLive(body);
  await expect.poll(async () => consumes(await ledger(rig.orgId)).length, { timeout: POLL_WAIT_MS }).toBe(1);
  const qrText = JSON.stringify(a.qr);
  const b = await fakeCapturePhone(page, await newPhoneRequest(new URL(page.url()).origin), { qrText });
  expect((await b.claim("new")).ok?.state, "T3 while A still beats and streams: taken").toBe("taken");

  // A dies: no more beats, and its video stops.
  const uid = await inputIdOf(a);
  a.silence();
  await setIngest(page.request, uid, "disconnected");
  const diedAt = Date.now();
  const took: { a: Awaited<ReturnType<FakeCapturePhone["claim"]>>["ok"] } = { a: null };
  await expect
    .poll(async () => {
      took.a = (await b.claim("new")).ok;
      return took.a?.state;
    }, { message: "B takes the dead slot over", timeout: TAKEOVER_S * 1_000 + 3 * POLL_WAIT_MS, intervals: [1_000] })
    .toMatch(/^(go-live|live)$/);
  expect(Date.now() - diedAt, "not before the tuned takeover window").toBeGreaterThanOrEqual(TAKEOVER_S * 1_000);
  expect(took.a && "sid" in took.a && took.a.sid, "the SAME broadcast").toBe(session.id);
  const own = await b.get();
  expect(own.ok && "cred" in own.ok && own.ok.cred, "the new phone gets the session's cred").toBeTruthy();
  const row = await sessionRow(session.id);
  const pairings = await pairingsOf(f.id);
  expect(row.pairing_id, "the session moved to B's pairing").toBe(pairings.find((p) => p.phone === b.id)!.id);
  expect((await eventsOf(session.id)).filter((e) => e.type === "phone_takeover").map((e) => e.payload.dead), "one dead-phone takeover").toEqual([true]);
  expect(consumes(await ledger(rig.orgId)), "no second consume").toHaveLength(1);

  // A comes back: replaced, and its late stop of the sid B now holds is ignored.
  expect((await a.beat()).ok?.state, "the dead phone hears replaced").toBe("replaced");
  const late = await a.stoppedBeat(session.id);
  expect(late.ok?.state, "T24a: a stop from a phone that is not current, of a sid the current phone holds").toBe("replaced");
  expect((await sessionRow(session.id)).state, "…ends nothing").toBe("live");
  expect((await eventsOf(session.id)).filter((e) => e.type === "stop_ignored").map((e) => e.payload.held)).toEqual([true]);

  // B reconnects: the stream stays live in the panel.
  b.keepAlive("publishing");
  await setIngest(page.request, uid, "connected");
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-chain")).toHaveAttribute("data-phone", "connected", { timeout: 2 * POLL_WAIT_MS });
});

// ===========================================================================
// T21 — the operator's Stop from the phone
// ===========================================================================
test("T21: the operator stops from the phone (an ended beat) → over; the panel ends with \"Stopped from the phone\"; the pairing ends with it, so Ready asks for a scan again", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + CYCLE_MS + 4 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "T21 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page, { mode: "publishing" });
  const session = await tapGoLive(page, body, rig, f);
  await untilLive(body);
  await expect.poll(() => phone.sid, { message: "the phone holds the broadcast", timeout: POLL_WAIT_MS }).toBe(session.id);

  phone.silence();
  const stopped = await phone.ended(session.id);
  expect(stopped.ok, "T21: over, stopped").toMatchObject({ state: "over", sid: session.id, endReason: "stopped" });
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-end-reason")).toHaveText(en("stream.phone.ended.reason.operator_stopped"));
  const row = await untilDbState(session.id, ["completed", "ending"], POLL_WAIT_MS, "the session ends");
  expect(row.end_reason, "the DB names the phone's stop").toBe("operator_stopped");
  const [pairing] = await pairingsOf(f.id);
  expect(pairing, "T21 ends the pairing too").toMatchObject({ phone: phone.id, end_cause: "operator_stopped" });
  expect(pairing!.ended_at).not.toBeNull();

  await body.getByTestId("stream-again").click();
  await expect(body.getByTestId("stream-phone-strip"), "a rescan is owed").toHaveText(en("stream.phone.pairFirst"), { timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-go-live")).toBeDisabled();
});

// ===========================================================================
// A17 — the late stop: closes its sid, idempotently, and never a newer one
// ===========================================================================
test("A17: a late stop (sid null, stopped X) from the current phone closes X as the phone's stop; a resend is harmless; after the organiser goes live again (Y), the same late stop of X leaves Y live", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + 2 * CYCLE_MS + 4 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "A17 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page);
  const x = await tapGoLive(page, body, rig, f);
  await untilLive(body);

  const late = await phone.stoppedBeat(x.id);
  expect(late.ok, "T23: the current phone's late stop closes X").toMatchObject({ state: "over", sid: x.id, endReason: "stopped" });
  await expect(body.getByTestId("stream-end-reason")).toHaveText(en("stream.phone.ended.reason.operator_stopped"), { timeout: POLL_WAIT_MS });
  expect((await untilDbState(x.id, ["completed", "ending"], POLL_WAIT_MS, "X ends")).end_reason).toBe("operator_stopped");
  const resend = await phone.stoppedBeat(x.id);
  expect(resend.ok, "T24: a resend of an ended sid is answered over, and changes nothing").toMatchObject({ state: "over", sid: x.id });
  const [pairing] = await pairingsOf(f.id);
  expect(pairing!.ended_at, "a late stop is not T21: the phone stays paired").toBeNull();

  await body.getByTestId("stream-again").click();
  const y = await tapGoLive(page, body, rig, f, [x.id]);
  await untilLive(body);
  const stale = await phone.stoppedBeat(x.id);
  expect(stale.ok, "the stale stop still names only X").toMatchObject({ state: "over", sid: x.id });
  expect((await sessionRow(y.id)).state, "never a newer one: Y stays live").toBe("live");
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"));
  expect((await sessionsOf(rig.orgId)).filter((s) => s.end_reason === "operator_stopped").map((s) => s.id)).toEqual([x.id]);
});

// ===========================================================================
// Ask 10 — a warming broadcast whose phone is lost; then W5 again (silent)
// ===========================================================================
test("ask 10: the phone dies as Go live is tapped (it never hears go-live, its video never arrives) → the warming countdown names the timeout, then the lost phone; the session ends phone_lost at last beat + max(floor, cadence + slack), spending nothing; Ready then says the phone stopped checking in and refuses Go live", async ({
  page,
}) => {
  const cadenceS = POLL_FAR_SECONDS; // the cadence an unscheduled fixture's phone is answered — asserted below
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + silentAfterMs(cadenceS) + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  const rig = await seedRig(page);
  const target = await addTargetApi(page, rig.orgId, "Ask 10 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const before = (await ledger(rig.orgId)).total;
  const phone = await pairedPhone(page);
  await expect(body.getByTestId("stream-go-live")).toBeEnabled({ timeout: POLL_WAIT_MS });
  const answered = phone.lastPollSeconds;
  expect(answered, "the phone was told its waiting cadence").not.toBeNull();

  phone.silence();
  await new Promise((r) => setTimeout(r, 1_000)); // a keep-alive beat already in flight lands before the tap
  const session = await tapGoLive(page, body, rig, f);
  // Hold the video off: the fake input would connect FAKE_CONNECT_MS after it was made.
  const uid = await inputIdBySql(session.id);
  await setIngest(page.request, uid, "disconnected");
  expect((await sessionRow(session.id)).first_ingest_at, "premise: no video yet (else ask 10 cannot apply)").toBeNull();
  const [pairing] = await pairingsOf(f.id);
  expect(pairing!.last_beat_at.getTime(), "premise: the phone's last beat came BEFORE the Go live — it never heard it").toBeLessThan(session.created_at.getTime());
  const cadence = pairing!.answered_poll_seconds;
  expect(cadence, "the stored cadence is the one the phone was answered").toBe(answered);
  // B9 review m-2: ask 10 arms at a beat age of max(RECONNECT_QUIET, cadence + POLL_NEAR) (phone-lost.ts); only when
  // that is LATER than the warming countdown's own quiet hold does the strip show the timeout first. The rig's fixture
  // is unscheduled, so its phone is answered the FAR cadence — the premise this case's order rests on.
  expect(cadence, "premise: the far cadence, so the warming timeout shows before ask 10 arms").toBe(POLL_FAR_SECONDS);
  expect(Math.max(RECONNECT_QUIET_SECONDS, cadence + POLL_NEAR_SECONDS), "premise: ask 10 arms after the quiet hold").toBeGreaterThan(RECONNECT_QUIET_SECONDS);
  const deadline = pairing!.last_beat_at.getTime() + silentAfterMs(cadence);

  const strip = body.getByTestId("stream-phone-strip");
  // The waiting strip: its lead ("Waiting for the phone's video"), then the countdown sentence.
  await expect(strip, "first the earliest end is the warming timeout").toHaveText(enPattern("stream.phone.countdown.warming.no_inbound_timeout", "stream.phone.waitingVideo"), {
    timeout: QUIET_MS + 2 * POLL_WAIT_MS,
  });
  // The four voices agree (B8 re-review ruling; stream-chain.ts captureLink1 / phoneDot): the timeout's countdown says
  // nothing of the phone, which still checks in — the node Starting, link 1 waiting's Connecting, the Paired dot lime.
  const chain = body.getByTestId("stream-chain");
  const pairedDot = body.getByTestId("stream-code-disclosure").locator("summary [data-tone]");
  await expect(chain, "the timeout: the node still Starting").toHaveAttribute("data-phone", "starting");
  await expect(chain, "the timeout: link 1 still Connecting").toHaveAttribute("data-link1", "connecting");
  await expect(pairedDot, "the timeout: the Paired dot lime").toHaveAttribute("data-tone", "lime");
  await expect(strip, "then the lost phone, once its owed beat is missing").toHaveText(enPattern("stream.phone.countdown.warming.phone_lost", "stream.phone.waitingVideo"), {
    timeout: Math.max(0, deadline - Date.now()) + POLL_WAIT_MS,
  });
  await expect(strip).toHaveAttribute("data-tone", "amber");
  await expect(chain, "the phone node says the same").toHaveAttribute("data-phone", "notAnswering");
  await expect(body.locator('[data-node="phone"] [data-mark="bang"]')).toHaveCount(1);
  await expect(chain, "ask 10: link 1 the amber dashes").toHaveAttribute("data-link1", "problem");
  await expect(pairedDot, "ask 10: the Paired dot amber").toHaveAttribute("data-tone", "amber");
  await expectNoHorizontalScroll(page);
  await body.screenshot({ path: join(test.info().outputPath(), "ask10-768-countdown.png"), timeout: NAV_MS });

  // It never went live, so the ended card says exactly that (P6), and carries no end-reason chip (P7); the reason is
  // the DB's — and the countdown above already named it.
  await expect(body.getByTestId("stream-ended-never-live")).toHaveText(en("stream.phone.ended.neverLive"), {
    timeout: Math.max(0, deadline - Date.now()) + END_LATE_MS + POLL_WAIT_MS,
  });
  await expect(body.getByTestId("stream-end-reason"), "P7: no reason chip on a session that never went live").toHaveCount(0);
  const ended = await sessionRow(session.id);
  expect(ended.end_reason, "the DB names the lost phone").toBe("phone_lost");
  expect(ended.ended_at!.getTime(), "not before §6.9's threshold").toBeGreaterThanOrEqual(deadline);
  expect(ended.ended_at!.getTime() - deadline, "within one poll of it").toBeLessThanOrEqual(END_LATE_MS);
  expect((await ledger(rig.orgId)).total, "a broadcast that never had video spends nothing").toBe(before);

  // W5 again, the other way in: the phone is now SILENT.
  await body.getByTestId("stream-again").click();
  await expect(strip).toHaveText(en("stream.phone.silent"), { timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-go-live")).toBeDisabled();
  const refused = await apiJson(page.request, `/api/v1/fixtures/${f.id}/stream-sessions`, "POST", { mode: "passthrough", targetId: target.id });
  expect([refused.status, refused.error?.code], "a silent phone is no phone").toEqual([409, "phone_not_paired"]);
});

// ===========================================================================
// W19 + W24 — a live phone lost: Reconnecting…, the countdown after the quiet hold, the end at its zero
// ===========================================================================
test("W19/W24 @320: live, then the phone's beats stop and its input disconnects → the phone node says Reconnecting…, after the quiet hold the countdown sentence, and the session ends phone_lost within one poll of the countdown's zero", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + CYCLE_MS + W19_MS + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 320, height: 800 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "W19 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page, { mode: "publishing" });
  const session = await tapGoLive(page, body, rig, f);
  await untilLive(body);
  await expect.poll(async () => (await sessionRow(session.id)).phone_beat_at, { message: "the phone beats its sid", timeout: 2 * POLL_WAIT_MS }).not.toBeNull();

  const uid = await inputIdOf(phone);
  expect(uid, "the descriptor's playbackUrl names the session's own input").toBe(await inputIdBySql(session.id));
  phone.silence();
  await setIngest(page.request, uid, "disconnected");
  const chain = body.getByTestId("stream-chain");
  await expect(chain, "W24: live with no input — Reconnecting…").toHaveAttribute("data-phone", "reconnecting", { timeout: 2 * POLL_WAIT_MS });
  await expect(body.locator('[data-node="phone"]')).toContainText(en("stream.chain.word.reconnecting"));
  await expect(body.getByTestId("stream-state-pill"), "still live").toHaveText(en("stream.phone.state.live"));

  // The deadline, from the DB's own instants: both silences, the shorter one counted down (§6.8.5).
  const row = await sessionRow(session.id);
  const video = await lastConnectedAt(session.id);
  const silentFrom = Math.max(row.phone_beat_at!.getTime(), (video ?? row.first_ingest_at!).getTime());
  const strip = body.getByTestId("stream-phone-strip");
  await expect(strip, "the countdown after the quiet hold").toHaveText(enPattern("stream.phone.countdown.live.phone_lost"), {
    timeout: Math.max(0, silentFrom + QUIET_MS - Date.now()) + 2 * POLL_WAIT_MS,
  });
  expect(Date.now() - silentFrom, "not before the quiet hold").toBeGreaterThanOrEqual(QUIET_MS - STREAM_POLL_MS);
  // The four voices agree under the countdown: the node Reconnecting… with its "!", link 1 the amber dashes, the
  // strip amber, the Paired dot amber (stream-chain.ts phoneDot: a phone_lost countdown).
  await expect(chain, "W24: the node still Reconnecting…").toHaveAttribute("data-phone", "reconnecting");
  await expect(body.locator('[data-node="phone"] [data-mark="bang"]'), "W24: the node's \"!\"").toHaveCount(1);
  await expect(chain, "W24: link 1 the amber dashes").toHaveAttribute("data-link1", "problem");
  await expect(strip, "W24: the strip amber").toHaveAttribute("data-tone", "amber");
  await expect(body.getByTestId("stream-code-disclosure").locator("summary [data-tone]"), "W24: the Paired dot amber").toHaveAttribute("data-tone", "amber");
  await expectNoHorizontalScroll(page);
  await body.screenshot({ path: join(test.info().outputPath(), "w24-320-countdown.png"), timeout: NAV_MS });

  // The chip names the TUNED window (class 19: LOST_LIVE_MIN is 1 here, so a "15" in the panel or its loader reds) —
  // and the copy carries it as a placeholder, or the expected sentence below would read the same whatever the window.
  expect(en("stream.phone.ended.reason.phone_lost", { minutes: LOST_LIVE_MIN }), "premise: the copy names the window")
    .not.toBe(en("stream.phone.ended.reason.phone_lost", { minutes: PHONE_LOST_LIVE_MINUTES }));
  await expect(body.getByTestId("stream-end-reason")).toHaveText(en("stream.phone.ended.reason.phone_lost", { minutes: LOST_LIVE_MIN }), {
    timeout: Math.max(0, silentFrom + W19_MS - Date.now()) + END_LATE_MS + POLL_WAIT_MS,
  });
  const ended = await sessionRow(session.id);
  expect(ended.end_reason).toBe("phone_lost");
  const deadline = Math.max(ended.phone_beat_at!.getTime(), ((await lastConnectedAt(session.id)) ?? ended.first_ingest_at!).getTime()) + W19_MS;
  expect(ended.ended_at!.getTime(), "W19 needs BOTH silences to reach the tuned limit").toBeGreaterThanOrEqual(deadline);
  expect(ended.ended_at!.getTime() - deadline, "made by the next poll's tick").toBeLessThanOrEqual(END_LATE_MS);
});

// ===========================================================================
// W22 — the same loss with NO panel open: the cron tick ends it
// ===========================================================================
test("W22: a live phone lost with nobody watching (the organiser has left the page) stays open past its W19 deadline until the cron tick, which ends it phone_lost", async ({
  page,
}) => {
  // Two waits: the whole pool before its go-live, and stream-credits' key at the tick (m-3, n-2).
  test.setTimeout(SLOT_WAIT_MS + CREDITS_KEY_WAIT_MS + SEED_MS + 2 * NAV_MS + CYCLE_MS + W19_MS + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "W22 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page, { mode: "publishing" });
  // The global tick (m-3) needs every key; the pool is taken now, whole, before the session opens (n-2: no key is held
  // while waiting for it). `tapGoLive`'s own slot call then finds the lease and takes nothing more.
  const exclusive = await wholePool();
  const poolFrom = Date.now();
  expect(exclusive.pool, "the pool: every key of the deployment's stream capacity but stream-credits'").toBe(STREAM_CAPACITY - 1);
  const session = await tapGoLive(page, body, rig, f);
  await untilLive(body);
  await expect.poll(async () => (await sessionRow(session.id)).phone_beat_at, { timeout: 2 * POLL_WAIT_MS }).not.toBeNull();
  const uid = await inputIdOf(phone);
  phone.silence();
  await setIngest(page.request, uid, "disconnected");
  await page.goto("/directory"); // no fixture page, no poll, no tick

  // Past the deadline by more than a poll: nothing has ended it.
  const row = await sessionRow(session.id);
  const deadline = Math.max(row.phone_beat_at!.getTime(), ((await lastConnectedAt(session.id)) ?? row.first_ingest_at!).getTime()) + W19_MS;
  await new Promise((r) => setTimeout(r, Math.max(0, deadline + END_LATE_MS - Date.now())));
  expect((await sessionRow(session.id)).state, "nobody watching, nothing ticked: still open past its deadline").toBe("live");

  // The tick is global (m-3): it runs only once every key is ours — the pool since before the go-live, stream-credits'
  // now — so no other walkthrough has a session open.
  const creditsKey = await exclusive.credits();
  try {
    const others = await withDb((sql) => sql<{ id: string }[]>`
      select id from fixture_stream_sessions where org_id <> ${rig.orgId} and state not in ('completed', 'failed')`);
    expect(others, "the global tick can reach no other test's session").toEqual([]);
    const tick = await page.request.post("/api/cron/stream-tick", { headers: { "x-cron-secret": process.env.CRON_SECRET! } });
    expect(tick.status(), "the cron tick runs").toBe(200);
    const answer = (await tick.json()) as { data?: { ticked?: number; ended?: number; failed?: number } };
    // Exclusive (n-3): the tick reached THIS session alone, ended it once, and failed nothing — a tick that ended it
    // twice, or reached another test's session, reds here.
    expect(answer.data, "the tick ticked and ended exactly this session, and failed none").toMatchObject({ ticked: 1, ended: 1, failed: 0 });
    const ended = await untilDbState(session.id, ["ending", "completed"], POLL_WAIT_MS, "the cron's end lands");
    expect(ended.end_reason).toBe("phone_lost");
  } finally {
    await creditsKey.release();
    test.info().annotations.push({
      type: "W22 pool",
      description: `waited ${exclusive.waitedMs} ms for the whole pool holding nothing; held it ${Date.now() - poolFrom} ms to the end landing (teardown releases it)`,
    });
  }
});

// ===========================================================================
// W23 — three free restarts per window; the fourth pays and becomes the next anchor
// ===========================================================================
test("W23: go live, then three restarts that reach video are free — the line counts them (0, 1, 2 of 3) — and before the fourth it reads (3 of 3) with the credit suffix; the fourth spends exactly one credit and its window starts again at 0", async ({
  page,
}) => {
  const RUNS = FREE_RESTARTS_PER_WINDOW + 2; // the first run, the free restarts, the paid one
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + RUNS * CYCLE_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "W23 destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  await pairedPhone(page);
  const start = (await ledger(rig.orgId)).total;
  expect(start, "premise: credits for two paid runs").toBeGreaterThanOrEqual(2);
  const line = body.getByTestId("stream-restart");
  await expect(line, "nothing spent yet: no window, no line").toHaveCount(0);

  const seen: string[] = [];
  for (let run = 0; run < RUNS; run++) {
    const paid = run === 0 || run === RUNS - 1;
    if (run > 0) {
      const used = run - 1;
      const atLimit = used >= FREE_RESTARTS_PER_WINDOW;
      await expect(line, `before run ${run + 1}`).toHaveText(
        en(atLimit ? "stream.restart.usedCredit" : "stream.restart.used", { used, limit: FREE_RESTARTS_PER_WINDOW }),
      );
      await expect(line).toHaveAttribute("data-tone", atLimit ? "amber" : "emerald");
    }
    const s = await tapGoLive(page, body, rig, f, seen);
    seen.push(s.id);
    await untilLive(body);
    await expect.poll(async () => (await sessionRow(s.id)).first_ingest_at, { message: `run ${run + 1} reached video`, timeout: POLL_WAIT_MS }).not.toBeNull();
    const spent = consumes(await ledger(rig.orgId));
    expect(spent.map((r) => r.session_id), `after run ${run + 1}: consumes`).toEqual(paid && run > 0 ? [seen[0], s.id] : [seen[0]]);
    await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(start - spent.length));
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
    await body.getByTestId("stream-again").click();
  }
  expect((await ledger(rig.orgId)).total, "exactly two credits for five runs: the first and the fourth restart").toBe(start - 2);
  await expect(line, "O4: the paid restart is the next anchor").toHaveText(en("stream.restart.used", { used: 0, limit: FREE_RESTARTS_PER_WINDOW }));
});

// ===========================================================================
// Revoke & reissue — the old code is dead at once, the new one pairs
// ===========================================================================
test("Revoke & reissue: the organiser confirms a new code → the old QR's beat, claim and GET are 401 code_ended, the panel shows the NEW code with no phone, and a phone that scans the new one pairs", async ({
  page,
}) => {
  test.setTimeout(SEED_MS + NAV_MS + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "Reissue destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const old = await pairedPhone(page);
  old.silence();

  const fold = body.getByTestId("stream-code-disclosure");
  if ((await fold.getAttribute("open")) === null) await fold.locator("summary").click();
  await body.getByTestId("stream-code-reissue").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(en("stream.code.reissue.confirm.title"));
  const [reissued] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/fixtures/${f.id}/stream-code/reissue`, { timeout: POLL_WAIT_MS }),
    dialog.getByRole("button", { name: en("stream.code.reissue.confirm.button"), exact: true }).click(),
  ]);
  expect(reissued.status(), "the reissue answered").toBe(200);
  await expect(dialog).toHaveCount(0, { timeout: POLL_WAIT_MS });

  for (const [what, call] of [
    ["beat", () => old.beat()],
    ["claim", () => old.claim("new")],
    ["GET", () => old.get()],
  ] as const) {
    const r = await call();
    expect([r.status, r.refusal?.code], `the old code's ${what}`).toEqual([401, "code_ended"]);
  }
  await expect(body.getByTestId("stream-code-card"), "no phone on the new code: the card again").toBeVisible({ timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-go-live")).toBeDisabled();
  const fresh = await pairedPhone(page);
  expect(fresh.qr.code, "the panel shows a NEW code").not.toBe(old.qr.code);
  await expect(body.getByTestId("stream-go-live"), "the new code's phone: Go live").toBeEnabled({ timeout: POLL_WAIT_MS });
  const codes = await withDb((sql) => sql<{ code: string; end_cause: string | null }[]>`
    select code, end_cause from fixture_stream_codes where fixture_id = ${f.id} order by created_at`);
  expect(codes, "the old code ended reissued; one active").toEqual([
    { code: old.qr.code, end_cause: "reissued" },
    { code: fresh.qr.code, end_cause: null },
  ]);
});

// ===========================================================================
// A finished fixture's code — 401 after the grace; a live broadcast past it keeps working
// ===========================================================================
test("finished fixture: the result is in and the grace has passed, but the phone is live → its beats and GET still serve; once the organiser stops, the next call ends the code (401) and a new phone cannot claim; the panel says the match is over", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + 2 * NAV_MS + CYCLE_MS + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "Finished destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page, { mode: "publishing" });
  const session = await tapGoLive(page, body, rig, f);
  await untilLive(body);

  // The result, through the requests the desk and the console send: the division starts (scoring is closed until it
  // does), then the score.
  const started = await apiJson(page.request, `/api/v1/divisions/${rig.divisionId}/start`, "POST");
  expect(started.status, `start the division -> ${JSON.stringify(started.error)}`).toBe(200);
  await scoreFixture(page.request, f.id, 2, 1);
  // The grace, passed: finished_at backdated (the trigger moves it only on a `status` write). The server's grace is
  // CODE_GRACE_AFTER_FINISH_MINUTES unless this env shortens it; past the longer of the two is past either.
  const graceMin = Math.max(CODE_GRACE_AFTER_FINISH_MINUTES, Number(process.env.CODE_GRACE_AFTER_FINISH_MINUTES ?? 0) || 0);
  const stamped = await withDb((sql) => sql<{ finished_at: Date | null }[]>`
    update fixtures set finished_at = now() - make_interval(mins => ${graceMin + 1}) where id = ${f.id} and finished_at is not null returning finished_at`);
  expect(stamped.length, "premise: the result finished the fixture").toBe(1);

  const beat = await phone.beat({ sid: session.id, state: "publishing" });
  expect(beat.ok?.state, "C2: an open session defers the expiry — the live phone is served").toBe("live");
  const own = await phone.get();
  expect(own.ok?.state).toBe("live");
  expect((await sessionRow(session.id)).state).toBe("live");

  phone.silence();
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
  await untilDbState(session.id, ["completed"], POLL_WAIT_MS, "the stop completes");
  const after = await phone.beat();
  expect([after.status, after.refusal?.code], "no open session: the code expires on this call").toEqual([401, "code_ended"]);
  const [code] = await withDb((sql) => sql<{ end_cause: string | null }[]>`select end_cause from fixture_stream_codes where fixture_id = ${f.id}`);
  expect(code?.end_cause, "C2's lazy expiry").toBe("expired");
  const stranger = await fakeCapturePhone(page, await newPhoneRequest(new URL(page.url()).origin), { qrText: JSON.stringify(phone.qr) });
  expect((await stranger.claim("new")).status, "nobody claims an ended code").toBe(401);

  const reopened = await openPhoneTab(page, rig, f);
  const again = reopened.getByTestId("stream-again");
  if (await again.count()) await again.click(); // `current` answers the ended session first
  await expect(reopened.getByTestId("stream-match-over")).toHaveText(en("stream.phone.matchOver"), { timeout: POLL_WAIT_MS });
  await expect(reopened.getByTestId("stream-qr"), "no QR for an ended code").toHaveCount(0);
  await expect(reopened.getByTestId("stream-go-live")).toHaveCount(0);
});

// ===========================================================================
// Panel states at the three widths (§6.12) — no horizontal page scroll anywhere
// ===========================================================================
test("panel states at 320, 768 and 1280: no phone, paired, waiting, live, ended — each fits every width with no horizontal page scroll", async ({
  page,
}) => {
  const WIDTHS = [320, 768, 1280] as const;
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + CYCLE_MS + 5 * WIDTHS.length * 5_000 + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "A destination with a long name for the narrow screens");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  let checked = 0;
  const atEveryWidth = async (state: string) => {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(body, `${state} @${w}: the panel is still open`).toBeVisible();
      await expectNoHorizontalScroll(page);
      await body.screenshot({ path: join(test.info().outputPath(), `states-${state}-${w}.png`) });
      checked++;
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  await expect(body.getByTestId("stream-code-card")).toBeVisible();
  await atEveryWidth("no-phone");
  await pairedPhone(page);
  await expect(body.getByTestId("stream-go-live")).toBeEnabled({ timeout: POLL_WAIT_MS });
  await atEveryWidth("paired");
  await tapGoLive(page, body, rig, f);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(new RegExp(`^(${en("stream.phone.state.provisioning")}|${en("stream.phone.state.warming")})$`), { timeout: POLL_WAIT_MS });
  await atEveryWidth("waiting");
  await untilLive(body);
  await atEveryWidth("live");
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
  await atEveryWidth("ended");
  expect(checked, "five states × three widths checked").toBe(5 * WIDTHS.length);
});
