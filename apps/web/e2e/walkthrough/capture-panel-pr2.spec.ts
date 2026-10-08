// Capture QR v2 PR-2 (spec §7.1, §7.4, §7.5; T10–T12) — the organiser panel's PR-2 surface, walked against a real
// production server on RELAY_DRIVERS=fake: the automatic-streaming switch, the phone-health line and its amber states,
// "Phone not ready", the automatic start's refusal, the Details data and the takeover notice. Built to the owner-approved
// mockup Option A (2026-10-07).
//
// EVERY STATE IS REACHED THROUGH THE REAL SEAMS (AGENTS.md failure class 1). The switch is TAPPED and the DB's
// `auto_stream` read back; the phone is `helpers/fake-capture-phone.ts` — Seazn Capture as an HTTP client that scans the
// panel's own paste code — and every reading, verdict and takeover comes from its BEATS through the real beat route, read
// back by the panel's real poll of the real read model. Nothing here stages an answer: an amber that shows is the server's
// `phone.health`, a "Phone not ready" is the server's beat-confirmed `notReadyShown`, a refusal is the server's own
// `auto_start_refusal`. (The visual gate for these states is `e2e/stream-phone-panel-pr2.capture.ts`.)
//
// The phone's beats are driven HERE (`drive`), not by the shared helper's keep-alive: a keep-alive beat would put the
// helper's defaults (87 %, thermal 0) back between two of this file's readings. The shared helper is used unchanged.
//
// THE ENVIRONMENT IS A PREMISE, ASSERTED (beforeEach): the fake drivers on ENV_NAME local or ci. Every budget is derived
// from the constants that set its pace — this process reads the same tunables the server does (AGENTS.md #20).
//
// Single-sport (generic) by design: the phone routes, the switch and the read model are fixture- and org-level and read
// no sport (capture-phone.spec.ts's reasoning).
//
// Every rig is a FRESH org; sessions are opened under the stream-slot pool this file SHARES with capture-phone.spec.ts,
// stream-relay.spec.ts and directory-stream-destinations.spec.ts (the same keys, the same capacity derivation), so the
// fake's capacity is never over-asked and capture-phone's W22 exclusion still holds.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TAG,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  setBoolEntitlementOverrideSql,
} from "../helpers";
import { setRigPlan, signInAs } from "../overlay-kit";
import {
  disposeFakePhones,
  fakeCapturePhone,
  newPhoneRequest,
  pairedPhone,
  readPanelQrText,
  type BeatBody,
  type FakeCapturePhone,
} from "../helpers/fake-capture-phone";
import { STREAM_POLL_MS } from "../../src/lib/stream-session-view";
import { FAKE_CONNECT_AFTER_MS_DEFAULT } from "../../src/server/relay/fakes";
import { POOL_SLOT_WAIT_MS, releaseStreamSlot, takeStreamSlot } from "../helpers/stream-slot-pool";
import {
  AUTO_STOP_AFTER_RESULT_SECONDS,
  DEAD_PHONE_TAKEOVER_SECONDS,
  HOT_THERMAL_STATUS,
  LOW_BATTERY_PERCENT,
  NOT_RESPONDING_BEATS,
  PHONE_NOT_READY_SHOW_AFTER_SECONDS,
  POLL_NEAR_SECONDS,
} from "../../src/server/relay/config";

// ===========================================================================
// The environment, and the clocks — every wait DERIVED from the constant that sets its pace
// ===========================================================================

/** A positive whole number from this process's env (the server's `tunable()` reads the same name), else the default. */
function tunedEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  return raw && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : fallback;
}
const FAKE_CONNECT_MS = tunedEnv("FAKE_INGEST_CONNECT_AFTER_MS", FAKE_CONNECT_AFTER_MS_DEFAULT);
const TAKEOVER_S = tunedEnv("DEAD_PHONE_TAKEOVER_SECONDS", DEAD_PHONE_TAKEOVER_SECONDS);
/** §7.1's figure as the SERVER states it: config.ts's AUTO_STOP_AFTER_RESULT_SECONDS through `tunable`, in whole minutes
 *  (≥ 1) — the constant's own meaning, not the panel's arithmetic read back. */
const AUTO_STOP_MIN = Math.max(1, Math.round(tunedEnv("AUTO_STOP_AFTER_RESULT_SECONDS", AUTO_STOP_AFTER_RESULT_SECONDS) / 60));

/** How often this file's phone beats: faster than the real cadence, so a reading changes on screen within a poll. */
const BEAT_MS = 2_500;
/** One poll plus slack — a state the next read must already show. A beat's change needs one beat AND one poll. */
const POLL_WAIT_MS = STREAM_POLL_MS + 5_000;
const BEAT_POLL_MS = BEAT_MS + POLL_WAIT_MS;
const LIVE_WAIT_MS = FAKE_CONNECT_MS + 2 * STREAM_POLL_MS + 5_000;
const SEED_MS = 60_000;
const NAV_MS = 30_000;
/** §6.9 (W8): a HELD phone is not responding after NOT_RESPONDING_BEATS answered cadences with no beat; an open session's
 *  phone is answered POLL_NEAR_SECONDS (poll-seconds.ts, row 2). */
const NOT_RESPONDING_MS = NOT_RESPONDING_BEATS * POLL_NEAR_SECONDS * 1_000;
/** FP16 / R-2: "Phone not ready" waits for a beat this long into the stretch (NOT tunable). */
const NOT_READY_MS = PHONE_NOT_READY_SHOW_AFTER_SECONDS * 1_000;

// ===========================================================================
// Kit (file-local; capture-phone.spec.ts's shapes — a spec cannot import another spec)
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

// The stream-slot pool (e2e/helpers/stream-slot-pool.ts), shared with capture-phone, capture-auto, stream-relay and
// directory. This file's longest hold is the health walk, from its Go live to its teardown: the live wait, six reading
// changes (a beat and a poll each), the not-responding silence and four polls — its budget's own terms.
const POOL_HOLD = {
  file: "capture-panel-pr2.spec.ts",
  holdMs: LIVE_WAIT_MS + 6 * BEAT_POLL_MS + NOT_RESPONDING_MS + 4 * POLL_WAIT_MS,
} as const;
const SLOT_WAIT_MS = POOL_SLOT_WAIT_MS;

const rigsThisTest: { request: APIRequestContext; orgId: string }[] = [];
const drivers: (() => void)[] = [];

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
        .poll(async () => (await withDb((sql) => sql<{ n: number }[]>`
          select count(*)::int as n from fixture_stream_sessions where org_id = ${orgId} and state not in ('completed', 'failed')`))[0]!.n, {
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
  expect(process.env.DATABASE_URL, "DATABASE_URL is set (the rig is seeded by SQL)").toBeTruthy();
  // The SERVER runs the fake drivers on local/ci: its control route knows "Unknown fake input".
  const probe = await request.post(`/api/internal/relay/fake-ingest/e2e-probe-${randomBytes(4).toString("hex")}`, { data: { state: "unknown" } });
  expect(probe.status(), "the fake-ingest control route answers (RELAY_DRIVERS=fake, ENV_NAME local or ci)").toBe(404);
  expect(await probe.text()).toContain("Unknown fake input");
});

test.afterEach(async () => {
  for (const stop of drivers.splice(0)) stop();
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
/** A plural key's English form for `count` — the `.one` / `.other` pair, chosen by the platform's own rules. */
const enPlural = (key: string, count: number): string => en(`${key}.${new Intl.PluralRules("en").select(count)}`, { count });
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A sentence whose `{placeholders}` are the server's seconds: the copy, each placeholder a run of digits. */
function enDigits(key: string, vars: Record<string, string | number> = {}): RegExp {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`ui.json has no ${key}`);
  const filled = raw.replace(/\{(\w+)\}/g, (m, v: string) => (vars[v] === undefined ? m : String(vars[v])));
  return new RegExp(filled.split(/\{\w+\}/).map(escapeRe).join("\\d+"));
}
/** §7.4's line, from its own parts' copy: "Phone · 78% charging · 2.4 Mbps · heard N s ago" (the seconds the server's). */
function healthLinePattern(parts: { percent?: number; charging?: boolean; mbps?: string }): RegExp {
  const words = [escapeRe(en("stream.phoneLine.phone"))];
  if (parts.percent !== undefined) words.push(escapeRe(en(parts.charging ? "stream.phoneLine.charging" : "stream.phoneLine.notCharging", { n: parts.percent })));
  if (parts.mbps !== undefined) words.push(escapeRe(en("stream.health.bitrate", { n: parts.mbps })));
  words.push(enDigits("stream.phoneLine.heard").source);
  return new RegExp(words.join(" · "));
}

interface Fx { id: string; no: number }
interface Rig { orgId: string; divPath: string; fixtures: Fx[]; tag: string }

async function seedRig(page: Page, opts: { orgTz?: string } = {}): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+cap2-${tag}@resend.dev`;
  const orgSlug = `cap2-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"Capture Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Capture Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    if (opts.orgTz) await sql`update organizations set timezone = ${opts.orgTz} where id = ${newOrgId}`;
    return newOrgId;
  });
  await signInAs(page, ownerEmail);
  rigsThisTest.push({ request: page.request, orgId });
  const label = `Capture2 ${tag}`;
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: label, visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: label.slice(0, 40), sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  if (div.status >= 300 || !div.data) throw new Error(`rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
  const ents = await addEntrantsViaApi(page.request, div.data.id, [`Side A ${tag}`, `Side B ${tag}`]);
  if (ents.status >= 300 || ents.ids.length !== 2) throw new Error(`rig: entrants -> ${ents.status}`);
  await createStageAndGenerate(page.request, div.data.id);
  const fixtures = await withDb(async (sql) => [
    ...(await sql<Fx[]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id} order by fixture_no`),
  ]);
  expect(fixtures.length, "rig: a league of two plays once").toBe(1);
  await setRigPlan(orgId, "pro");
  return { orgId, divPath: `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}`, fixtures, tag };
}

async function addTargetApi(page: Page, orgId: string, label: string): Promise<void> {
  const res = await apiJson(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", {
    kind: "youtube", label, streamKey: `e2e-${randomBytes(6).toString("hex")}`,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`addTargetApi -> ${res.status} ${JSON.stringify(res.error)}`);
}

const streamControl = (page: Page): Locator => page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
const panelScope = (page: Page): Locator => page.locator('[data-role="fixture-stream-body"]');

/** The fixture page, its Stream control, the Phone tab. */
async function openPhoneTabScope(page: Page, rig: Rig, f: Fx): Promise<Locator> {
  await page.goto(`${rig.divPath}/f/${f.no}`);
  const control = streamControl(page);
  await expect(control, `fixture ${f.no} offers exactly one visible Stream control`).toHaveCount(1, { timeout: NAV_MS });
  await control.click();
  const scope = panelScope(page);
  await expect(scope).toBeAttached({ timeout: NAV_MS });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  return scope;
}
async function openPhoneTab(page: Page, rig: Rig, f: Fx): Promise<Locator> {
  const body = (await openPhoneTabScope(page, rig, f)).locator("[data-phone-body]");
  await expect(body).toBeAttached({ timeout: NAV_MS });
  return body;
}

/** The fixture's saved switch, as the DB holds it (`fixture_stream_settings.auto_stream`); null with no settings row. */
async function autoStreamOf(fixtureId: string): Promise<boolean | null> {
  const [r] = await withDb((sql) => sql<{ auto_stream: boolean }[]>`select auto_stream from fixture_stream_settings where fixture_id = ${fixtureId}`);
  return r?.auto_stream ?? null;
}

/** The phone's beats, driven by this file: the helper's keep-alive is stopped (its defaults would overwrite a reading),
 *  and every BEAT_MS the phone says `body()` — carrying the sid it holds, `publishing`, once it heard go-live. */
function drive(phone: FakeCapturePhone, body: () => Partial<BeatBody>): () => void {
  phone.silence();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const live = phone.sid !== null ? { sid: phone.sid, state: "publishing" as const, transport: "srt" as const, delivery: "ok" as const } : {};
    void phone.beat({ ...live, ...body() }).catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, BEAT_MS);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  drivers.push(stop);
  return stop;
}

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
async function setIngest(request: APIRequestContext, inputId: string, state: "connected" | "disconnected"): Promise<void> {
  const res = await request.post(`/api/internal/relay/fake-ingest/${inputId}`, { data: { state } });
  expect(res.status(), `fake-ingest ${inputId} -> ${state}`).toBe(200);
}
/** Organiser Go live, tapped; returns the new session's id. */
async function tapGoLive(body: Locator, rig: Rig, f: Fx): Promise<string> {
  await streamSlot();
  const goLive = body.getByTestId("stream-go-live");
  await expect(goLive).toBeEnabled({ timeout: POLL_WAIT_MS });
  await goLive.click();
  let id: string | null = null;
  await expect
    .poll(async () => {
      const [r] = await withDb((sql) => sql<{ id: string }[]>`
        select id from fixture_stream_sessions where org_id = ${rig.orgId} and fixture_id = ${f.id} order by created_at desc limit 1`);
      id = r?.id ?? null;
      return id;
    }, { message: "the fixture has a session row", timeout: POLL_WAIT_MS })
    .not.toBeNull();
  return id!;
}
async function untilLive(body: Locator): Promise<void> {
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
}
/** §7.5: the takeover's instant as the venue's clock prints it (en-GB, 24 h — format.ts `fmtTime`'s house shape). */
const venueTime = (at: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(at);
/** B7 review M-5: every READING on the phone line sits on one line (only the model and the waiting sentence may wrap). The
 *  lines a part spans are the distinct tops of its fragments — an inline box with a child span reports one rect per run. */
async function expectReadingsUnbroken(strip: Locator, where: string, opts: { wraps?: boolean } = {}): Promise<void> {
  const parts = await strip.getByTestId("stream-phone-line").locator("[data-line-part]")
    .evaluateAll((els) => els.map((e) => [e.getAttribute("data-line-part"), new Set([...e.getClientRects()].map((r) => Math.round(r.top))).size] as const));
  const readings = parts.filter(([kind]) => kind !== "model" && kind !== "waiting");
  expect(readings.map(([k]) => k), `${where}: the line's readings (anti-vacuity)`).toEqual(["phone", "battery", "bitrate", "heard"]);
  for (const [kind, lines] of readings) expect(lines, `${where}: the ${kind} reading is on one line`).toBe(1);
  if (!opts.wraps) return;
  const lineTops = await strip.getByTestId("stream-phone-line").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  });
  expect(lineTops, `${where}: PREMISE — the line wraps at this width, so a split was possible`).toBeGreaterThan(1);
}

async function lastTakeoverAt(fixtureId: string): Promise<Date> {
  let at: Date | null = null;
  await expect
    .poll(async () => {
      const [r] = await withDb((sql) => sql<{ at: Date | null }[]>`
        select max(p.ended_at) as at from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
         where c.fixture_id = ${fixtureId} and p.end_cause = 'replaced'`);
      at = r?.at ?? null;
      return at;
    }, { message: "a pairing was replaced", timeout: POLL_WAIT_MS })
    .not.toBeNull();
  return at!;
}

// ===========================================================================
// T10 — the switch: tapped at three widths, read back from the DB
// ===========================================================================
for (const width of [1280, 768, 320] as const) {
  test(`T10 @${width}: the switch under the picker writes auto_stream on and off (the DB re-read), its caption names the server's delay, no horizontal scroll`, async ({
    page,
  }) => {
    test.setTimeout(SEED_MS + 2 * NAV_MS + 6 * POLL_WAIT_MS);
    await page.setViewportSize({ width, height: 900 });
    const rig = await seedRig(page);
    await addTargetApi(page, rig.orgId, "T10 destination");
    const f = rig.fixtures[0]!;
    const body = await openPhoneTab(page, rig, f);
    await pairedPhone(page);

    const sw = body.getByTestId("stream-auto-switch");
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute("role", "switch");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(sw).toContainText(en("stream.auto.switch"));
    await expect(body.getByTestId("stream-auto-hint"), "off: no caption").toHaveCount(0);
    await expect(body.getByTestId("stream-auto-operator"), "off: no operator hint, though the phone is in Operator").toHaveCount(0);
    expect(await autoStreamOf(f.id), "premise: nothing saved yet").not.toBe(true);
    // The switch sits under the destination picker (Option A).
    const [pickerBox, switchBox] = [await body.getByTestId("stream-target").boundingBox(), await sw.boundingBox()];
    expect(switchBox!.y, "under the picker").toBeGreaterThan(pickerBox!.y);
    expect(switchBox!.height, "the 44 px floor").toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);

    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: POLL_WAIT_MS });
    await expect(body.getByTestId("stream-auto-hint")).toHaveText(enPlural("stream.auto.switchHint", AUTO_STOP_MIN));
    await expect.poll(() => autoStreamOf(f.id), { message: "the tap SAVED the switch", timeout: POLL_WAIT_MS }).toBe(true);
    // Owner-approved 2026-10-08: the paired phone beats in Operator (the fake's default mode, read back by the server) — on,
    // the hint under the switch says it won't start on its own, and the switch names it.
    const opHint = body.getByTestId("stream-auto-operator");
    await expect(opHint).toHaveText(en("stream.auto.operatorHint"), { timeout: POLL_WAIT_MS });
    const opHintId = await opHint.getAttribute("id");
    await expect(sw).toHaveAttribute("aria-describedby", new RegExp(`(^| )${escapeRe(opHintId!)}( |$)`));
    const hintBox = await opHint.boundingBox();
    expect(hintBox!.y, "under the switch").toBeGreaterThanOrEqual((await sw.boundingBox())!.y + (await sw.boundingBox())!.height - 1);
    await expectNoHorizontalScroll(page);
    // A reload reads the server's answer, not the tap's memory.
    const again = await openPhoneTab(page, rig, f);
    await expect(again.getByTestId("stream-auto-switch")).toHaveAttribute("aria-checked", "true", { timeout: POLL_WAIT_MS });

    await again.getByTestId("stream-auto-switch").click();
    await expect(again.getByTestId("stream-auto-switch")).toHaveAttribute("aria-checked", "false", { timeout: POLL_WAIT_MS });
    await expect.poll(() => autoStreamOf(f.id), { message: "the second tap saved it OFF", timeout: POLL_WAIT_MS }).toBe(false);
    await expect(again.getByTestId("stream-auto-operator"), "off again: the operator hint goes").toHaveCount(0);
    await expect(again.getByTestId("stream-auto-error"), "no failure line").toHaveCount(0);
  });
}

test("T10 entitlement: an org with the relay switched off sees the switched-off state and NO switch; switched back on, the switch", async ({ page }) => {
  test.setTimeout(SEED_MS + 3 * NAV_MS + 4 * POLL_WAIT_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "T10 gate destination");
  const f = rig.fixtures[0]!;
  await setBoolEntitlementOverrideSql(rig.orgId, "streaming.relay", false);
  await invalidateOrgEntitlements(page.request, rig.orgId);
  const denied = await openPhoneTabScope(page, rig, f);
  await expect(denied.getByTestId("stream-switched-off"), "denied: the switched-off state").toBeVisible({ timeout: NAV_MS });
  await expect(denied.getByTestId("stream-auto-switch"), "denied: no switch").toHaveCount(0);

  await setBoolEntitlementOverrideSql(rig.orgId, "streaming.relay", true);
  await invalidateOrgEntitlements(page.request, rig.orgId);
  const granted = await openPhoneTab(page, rig, f);
  await expect(granted.getByTestId("stream-auto-switch"), "granted: the switch").toBeVisible({ timeout: NAV_MS });
});

// ===========================================================================
// T10 + T11 — live: the read-only line, the phone-health line from real beats, each amber the server names, Details
// ===========================================================================
test("T10/T11 live: 'Automatic: stops about N minutes after the result'; the health line from the phone's own readings; battery low, hot over it, stalled over both (the server's priority); Details' data used and app version; silence → not responding", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + LIVE_WAIT_MS + 6 * BEAT_POLL_MS + NOT_RESPONDING_MS + 4 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "Health destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page);
  // The fixture is not in play, so an automatic phone and the switch on start nothing by themselves (§7.2 in_play).
  let reading: Partial<BeatBody> = {
    mode: "automatic", battery: { percent: 78, charging: true, drainPctPerHour: null }, thermal: 0, bitrateKbps: 2400, dataUsedMB: 245,
  };
  const stop = drive(phone, () => reading);

  // FP14 / Q-D: Ready, paired — the phone's model and mode; neither Details chip, no bitrate, no "null".
  const strip = body.getByTestId("stream-phone-strip");
  await expect(strip, "Ready: the model and the mode").toHaveText(`Pixel 8 · ${en("stream.phone.mode.automatic")}`, { timeout: BEAT_POLL_MS });
  for (const id of ["stream-phone-data-used", "stream-phone-app-version", "stream-details"]) await expect(body.getByTestId(id), `pre-live: no ${id}`).toHaveCount(0);

  await body.getByTestId("stream-auto-switch").click();
  await expect.poll(() => autoStreamOf(f.id), { timeout: POLL_WAIT_MS }).toBe(true);
  await expect(body.getByTestId("stream-auto-hint"), "PREMISE: the switch reads on").toBeVisible({ timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-auto-operator"), "on, the phone in Automatic: no operator hint").toHaveCount(0);
  await tapGoLive(body, rig, f);
  await untilLive(body);

  // §7.1: the read-only line, the server's figure.
  await expect(body.getByTestId("stream-auto-live")).toHaveText(enPlural("stream.auto.liveLine", AUTO_STOP_MIN), { timeout: POLL_WAIT_MS });

  // §7.4: the line, from the readings the phone sent — slate.
  await expect(strip).toHaveText(healthLinePattern({ percent: 78, charging: true, mbps: "2.4" }), { timeout: BEAT_POLL_MS });
  await expect(strip).toHaveAttribute("data-tone", "slate");
  await expect(body.getByTestId("stream-chain"), "healthy: the phone node is the runner's own 'Connected'").toHaveAttribute("data-phone", "connected");
  // The phone → Seazn link flows while the video arrives; the destination's link is recorded to prove it never moves below.
  const chainEl = body.getByTestId("stream-chain");
  await expect(chainEl, "healthy: link 1 flows").toHaveAttribute("data-link1", "flowing");
  const link2Healthy = await chainEl.getAttribute("data-link2");
  expect(link2Healthy, "premise: link 2 is drawn").toBeTruthy();
  // Details (Q-D): the runner's chips, then data used and the app version.
  await body.getByTestId("stream-details").locator("summary").click();
  await expect(body.getByTestId("stream-phone-data-used")).toHaveText(en("stream.phone.dataUsed", { n: 245 }));
  await expect(body.getByTestId("stream-phone-app-version")).toHaveText(en("stream.phone.appVersion", { version: "1.4.0" }));

  // Each amber, from the phone's readings through the SERVER's verdict — and its priority with more than one true.
  const lead = strip.locator("p.font-medium");
  reading = { ...reading, battery: { percent: LOW_BATTERY_PERCENT - 6, charging: false, drainPctPerHour: null } };
  await expect(lead, "battery low").toHaveText(en("stream.phone.health.battery_low", { n: LOW_BATTERY_PERCENT - 6 }), { timeout: BEAT_POLL_MS });
  await expect(strip).toHaveAttribute("data-tone", "amber");
  await expect(strip.getByTestId("stream-phone-line")).toHaveText(healthLinePattern({ percent: LOW_BATTERY_PERCENT - 6, charging: false, mbps: "2.4" }));
  reading = { ...reading, thermal: HOT_THERMAL_STATUS };
  await expect(lead, "hot outranks battery low").toHaveText(en("stream.phone.health.hot"), { timeout: BEAT_POLL_MS });
  await expect(chainEl, "hot (the phone still sends): link 1 still flows").toHaveAttribute("data-link1", "flowing");
  reading = { ...reading, delivery: "stalled" };
  await expect(lead, "stalled outranks both").toHaveText(en("stream.phone.health.stalled"), { timeout: BEAT_POLL_MS });
  await expect(body.locator('[data-node="phone"] [data-mark="bang"]'), "stalled: the node's '!'").toHaveCount(1);
  // Owner ruling 2026-10-08: the video is not reaching Seazn — the Seazn node says so, from the same server verdict.
  await expect(body.getByTestId("stream-chain"), "stalled: the Seazn node waits for video").toHaveAttribute("data-seazn", "waitingVideo");
  await expect(body.locator('[data-node="seazn"]')).toContainText(en("stream.chain.word.waitingVideo"));
  // Owner ruling 2026-10-08 (B8): and the phone → Seazn link stops drawing as flowing — the chain's amber dashes, drawn by
  // the class the component paints. The Seazn → destination link does not move.
  await expect(chainEl, "stalled: link 1 is the problem style").toHaveAttribute("data-link1", "problem");
  await expect(chainEl.locator(".stream-link-problem"), "stalled: the dashes are painted (one link)").toHaveCount(1);
  await expect(chainEl, "stalled: link 2 is unchanged").toHaveAttribute("data-link2", link2Healthy!);
  // The phone at 320: the amber strip and its line fit, and every reading stays on one line (B7 review M-5: "2.4 Mbps"
  // once broke across two).
  await page.setViewportSize({ width: 320, height: 800 });
  await expectNoHorizontalScroll(page);
  await expectReadingsUnbroken(strip, "320, stalled (the small line under the lead)");
  await page.setViewportSize({ width: 1280, height: 900 });
  // Back to healthy: the amber goes with the server's verdict.
  reading = { ...reading, delivery: "ok", thermal: 0, battery: { percent: 78, charging: true, drainPctPerHour: null } };
  await expect(strip, "healthy again").toHaveAttribute("data-tone", "slate", { timeout: BEAT_POLL_MS });
  await expect(body.getByTestId("stream-chain"), "healthy: Seazn receives again").toHaveAttribute("data-seazn", "receiving");
  await expect(chainEl, "healthy: link 1 flows again").toHaveAttribute("data-link1", "flowing");
  // M-5's own case: the healthy line is the strip's only text (full size) — at 320 it wraps, and "2.4 Mbps" once split.
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(strip).toHaveText(healthLinePattern({ percent: 78, charging: true, mbps: "2.4" }), { timeout: BEAT_POLL_MS });
  await expectReadingsUnbroken(strip, "320, healthy (the line alone)", { wraps: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const bad of ["null", "undefined", "NaN", "0 Mbps"]) expect(await strip.textContent(), bad).not.toContain(bad);
  // B7 review M-3: the line is the SERVER's stopApplies (the tick's own predicate). The phone switched to Operator means the
  // automatic stop would not happen — no line; back in Automatic, the line again.
  reading = { ...reading, mode: "operator" };
  await expect(body.getByTestId("stream-auto-live"), "the phone in Operator: no automatic stop, no line").toHaveCount(0, { timeout: BEAT_POLL_MS });
  reading = { ...reading, mode: "automatic" };
  await expect(body.getByTestId("stream-auto-live"), "back in Automatic").toHaveText(enPlural("stream.auto.liveLine", AUTO_STOP_MIN), { timeout: BEAT_POLL_MS });

  // W8: the phone falls silent while its video still arrives — not responding after NOT_RESPONDING_BEATS cadences.
  stop();
  const quietFrom = Date.now();
  await expect(lead, "not responding").toHaveText(enDigits("stream.phone.health.not_responding"), { timeout: NOT_RESPONDING_MS + 2 * POLL_WAIT_MS });
  expect(Date.now() - quietFrom, "not before W8's beats").toBeGreaterThanOrEqual(NOT_RESPONDING_MS - BEAT_MS - STREAM_POLL_MS);
  await expect(body.getByTestId("stream-chain")).toHaveAttribute("data-phone", "notAnswering");
  await expect(body.getByTestId("stream-state-pill"), "still live: the video arrives").toHaveText(en("stream.phone.state.live"));
});

// ===========================================================================
// T11 — waiting: "Phone not ready" only on the server's beat-confirmed hold
// ===========================================================================
test("T11 waiting: a not-ready that FLAPS (each stretch shorter than the constant) is never shown; a HOLD of at least the constant is; a new reason shows at once; the clear takes it away", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + 30_000 + NOT_READY_MS + 3 * BEAT_POLL_MS + 2 * BEAT_POLL_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  await addTargetApi(page, rig.orgId, "Not-ready destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page);
  let notReady: BeatBody["notReady"] = null;
  // The realistic phone: once it hears go-live it holds the sid and is CONNECTING (its video held off below), saying
  // whatever not-ready it has.
  drive(phone, () => ({ notReady, ...(phone.sid !== null ? { state: "connecting" as const, delivery: "unknown" as const } : {}) }));
  const sid = await tapGoLive(body, rig, f);
  // Hold the video off: the fake would connect FAKE_CONNECT_MS after it made the input.
  await setIngest(page.request, await inputIdBySql(sid), "disconnected");
  await expect(body.getByTestId("stream-waiting")).toBeVisible({ timeout: POLL_WAIT_MS });
  const strip = body.getByTestId("stream-phone-strip");
  const notReadyLine = (reason: string) => en("stream.phone.notReady.line", { reason: en(`stream.phone.notReady.reason.${reason}`) });
  /** "Phone not ready:" — the line's own words before its reason, whatever the reason. */
  const NOT_READY_WORDS = en("stream.phone.notReady.line", { reason: "" }).trim();
  expect(NOT_READY_WORDS.length, "premise: the line has words of its own").toBeGreaterThan(0);

  // The flap: camera for three beats, clear for one — longer IN TOTAL than the constant, never as long in one stretch.
  const STRETCH_BEATS = Math.floor((NOT_READY_MS - BEAT_MS) / BEAT_MS) - 4;
  expect(STRETCH_BEATS * BEAT_MS, "premise: each flap stretch is shorter than the constant").toBeLessThan(NOT_READY_MS);
  expect(STRETCH_BEATS, "premise: a stretch is at least two beats").toBeGreaterThanOrEqual(2);
  const flapUntil = Date.now() + NOT_READY_MS + 3 * BEAT_MS;
  let samples = 0;
  let sawCamera = 0;
  let beat = 0;
  while (Date.now() < flapUntil) {
    notReady = beat % (STRETCH_BEATS + 1) < STRETCH_BEATS ? "camera" : null;
    beat++;
    const until = Date.now() + BEAT_MS;
    while (Date.now() < until) {
      const text = (await strip.textContent()) ?? "";
      expect(text, "a flap is never shown").not.toContain(NOT_READY_WORDS);
      const read = await apiJson<{ phone: { notReady: string | null; notReadyShown: boolean } | null }>(page.request, `/api/v1/fixtures/${f.id}/stream-phone`, "GET");
      expect(read.data?.phone?.notReadyShown, "the server never confirms a flap").toBe(false);
      if (read.data?.phone?.notReady === "camera") sawCamera++;
      samples++;
      await page.waitForTimeout(500);
    }
  }
  expect(samples, "anti-vacuity: the flap was sampled").toBeGreaterThan(10);
  expect(sawCamera, "anti-vacuity: the server DID hear the flap's not-ready").toBeGreaterThan(0);

  // The flap may have ended mid-stretch: clear it, and wait until the SERVER has heard the clear (its stretch clock
  // reset), so the hold's clock below starts at this test's own instant.
  notReady = null;
  await expect
    .poll(async () => {
      const facts = (await apiJson<{ phone: { notReady: string | null } | null }>(page.request, `/api/v1/fixtures/${f.id}/stream-phone`, "GET")).data?.phone;
      return facts ? facts.notReady : "no phone facts";
    }, {
      message: "the server heard the clear",
      timeout: BEAT_POLL_MS,
    })
    .toBeNull();
  // The hold: camera, continuously.
  notReady = "camera";
  const holdFrom = Date.now();
  await expect(strip, "the hold is shown").toContainText(notReadyLine("camera"), { timeout: NOT_READY_MS + BEAT_POLL_MS + BEAT_MS });
  expect(Date.now() - holdFrom, "not before the constant").toBeGreaterThanOrEqual(NOT_READY_MS - BEAT_MS);
  await expect(strip).toHaveAttribute("data-tone", "amber");
  // A new reason inside the same stretch shows at once — held: "turn the phone sideways".
  notReady = "held";
  await expect(strip, "the new reason").toContainText(notReadyLine("held"), { timeout: BEAT_POLL_MS });
  // The clear.
  notReady = null;
  await expect(strip, "the clear").not.toContainText(NOT_READY_WORDS, { timeout: BEAT_POLL_MS });
  await expect(strip).toContainText(en("stream.phone.waitingVideo"));
});

// ===========================================================================
// T11 — the automatic start's refusal, from the server's own attempt
// ===========================================================================
test("T11 refusal: switch on, an automatic phone, the match in play and NO destination → 'Automatic start couldn't begin: …' with Manage destinations; the switch off retires it (the server's gate)", async ({
  page,
}) => {
  test.setTimeout(SEED_MS + NAV_MS + 6 * BEAT_POLL_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page);
  drive(phone, () => ({ mode: "automatic" }));
  await expect(body.getByTestId("stream-dest-empty"), "premise: no destination").toBeVisible();
  await body.getByTestId("stream-auto-switch").click();
  await expect.poll(() => autoStreamOf(f.id), { timeout: POLL_WAIT_MS }).toBe(true);
  await withDb((sql) => sql`update fixtures set status = 'in_play' where id = ${f.id}`);

  const strip = body.getByTestId("stream-phone-strip");
  await expect(strip).toContainText(en("stream.auto.refused", { reason: en("stream.auto.refusal.no_destination") }), { timeout: 2 * BEAT_POLL_MS });
  await expect(strip).toHaveAttribute("data-tone", "amber");
  const [row] = await withDb((sql) => sql<{ r: string | null }[]>`select auto_start_refusal as r from fixture_stream_settings where fixture_id = ${f.id}`);
  expect(row?.r, "the server stored the refusal it served").toBe("no_destination");
  const manage = strip.getByTestId("stream-auto-remedy-manage");
  await expect(manage).toHaveText(en("stream.dest.manage"));
  await expect(manage).toHaveAttribute("href", "/directory?tab=streaming");
  await page.setViewportSize({ width: 320, height: 800 });
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The sequence: the switch off — the automatic start can no longer fire, so the server stops serving its refusal.
  await body.getByTestId("stream-auto-switch").click();
  await expect.poll(() => autoStreamOf(f.id), { timeout: POLL_WAIT_MS }).toBe(false);
  await expect(strip, "the refusal retired").toHaveText(`Pixel 8 · ${en("stream.phone.mode.automatic")}`, { timeout: BEAT_POLL_MS });
});

// ===========================================================================
// T12 — the takeover notice: a second phone at Ready; a dead phone's takeover while live
// ===========================================================================
test("T12 Ready: a second phone claims → the amber notice names ITS model and the venue's time, without Stop; the fold says Paired · that model; the X dismisses it across a reload; a NEW takeover shows again", async ({
  page,
}) => {
  test.setTimeout(SEED_MS + 4 * NAV_MS + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const TZ = "Asia/Kolkata"; // not the server's zone, not UTC: a time printed on any other clock reads differently
  const rig = await seedRig(page, { orgTz: TZ });
  await addTargetApi(page, rig.orgId, "Takeover destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  await pairedPhone(page);
  await expect(body.getByTestId("stream-takeover"), "no takeover yet").toHaveCount(0);

  const qrText = await readPanelQrText(page);
  const second = await fakeCapturePhone(page, await newPhoneRequest(new URL(page.url()).origin), { qrText });
  const claimed = await second.beat({ claim: "new", device: { model: "Galaxy S24" } });
  expect(claimed.status, "the second phone's claim is answered").toBe(200);
  expect(claimed.ok!.state, "a claim at Ready takes the slot (T2)").not.toMatch(/^(taken|replaced)$/);
  second.keepAlive();
  const at = await lastTakeoverAt(f.id);
  const notice = body.getByTestId("stream-takeover");
  await expect(notice.getByTestId("stream-takeover-text")).toHaveText(en("stream.takeover.line", { model: "Galaxy S24", time: venueTime(at, TZ) }), { timeout: 2 * POLL_WAIT_MS });
  await expect(notice).toHaveAttribute("role", "status");
  await expect(body.getByTestId("stream-code-disclosure").locator("summary")).toContainText(`${en("stream.code.paired")} · Galaxy S24`);
  await page.setViewportSize({ width: 320, height: 800 });
  await expectNoHorizontalScroll(page);
  // The fold's label at a phone width: "Paired · Galaxy S24" whole — the link beside it gives way, the label does not.
  const pairedLabel = body.getByTestId("stream-code-paired");
  await expect(pairedLabel).toHaveText(`${en("stream.code.paired")} · Galaxy S24`);
  expect(await pairedLabel.evaluate((el) => el.scrollWidth - el.clientWidth), "320: the fold's 'Paired · model' is not truncated").toBeLessThanOrEqual(0);
  const x = notice.getByTestId("stream-takeover-dismiss");
  const box = await x.boundingBox();
  expect([box!.width, box!.height], "the X is 44 px on a phone").toEqual([44, 44]);
  await page.setViewportSize({ width: 1280, height: 900 });

  await x.click();
  await expect(notice, "dismissed").toHaveCount(0);
  const again = await openPhoneTab(page, rig, f);
  await expect(again.getByTestId("stream-code-disclosure")).toBeAttached({ timeout: POLL_WAIT_MS });
  await page.waitForTimeout(STREAM_POLL_MS + 1_000); // one more poll: the dismissal must hold past it
  await expect(again.getByTestId("stream-takeover"), "the dismissal survives a reload (this takeover's instant)").toHaveCount(0);

  // A NEW takeover — another instant — shows again.
  const third = await fakeCapturePhone(page, await newPhoneRequest(new URL(page.url()).origin), { qrText: await readPanelQrText(page) });
  const third1 = await third.beat({ claim: "new", device: { model: "iPhone 15" } });
  expect(third1.status).toBe(200);
  third.keepAlive();
  await expect(again.getByTestId("stream-takeover-text")).toContainText("(iPhone 15)", { timeout: 2 * POLL_WAIT_MS });

  // B7 review I-2: Revoke & reissue IS the answer to a takeover — the server stops serving it with the old code, so the
  // notice goes with it (no dismissal involved: this takeover was never dismissed).
  const fold = again.getByTestId("stream-code-disclosure");
  if ((await fold.getAttribute("open")) === null) await fold.locator("summary").click();
  await again.getByTestId("stream-code-reissue").click();
  const dialog = page.getByRole("alertdialog");
  const [reissued] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/fixtures/${f.id}/stream-code/reissue`, { timeout: POLL_WAIT_MS }),
    dialog.getByRole("button", { name: en("stream.code.reissue.confirm.button"), exact: true }).click(),
  ]);
  expect(reissued.status(), "the reissue answered").toBe(200);
  await expect(again.getByTestId("stream-takeover"), "reissued: the notice is gone").toHaveCount(0, { timeout: 2 * POLL_WAIT_MS });
  await page.waitForTimeout(STREAM_POLL_MS + 1_000); // one more poll: it must stay gone
  await expect(again.getByTestId("stream-takeover"), "and stays gone past the next poll").toHaveCount(0);
});

test("T12 live: the phone dies (no beat, no video) and a second phone takes over → the notice names Stop while the session is live", async ({
  page,
}) => {
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAV_MS + LIVE_WAIT_MS + TAKEOVER_S * 1_000 + 6 * POLL_WAIT_MS + 30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const TZ = "Asia/Kolkata";
  const rig = await seedRig(page, { orgTz: TZ });
  await addTargetApi(page, rig.orgId, "Live takeover destination");
  const f = rig.fixtures[0]!;
  const body = await openPhoneTab(page, rig, f);
  const phone = await pairedPhone(page, { mode: "publishing" });
  const qrText = await readPanelQrText(page);
  const sid = await tapGoLive(body, rig, f);
  await untilLive(body);
  await expect(body.getByTestId("stream-takeover"), "no takeover yet").toHaveCount(0);

  // A14: the phone dies — no beat, and its video stops.
  phone.silence();
  await setIngest(page.request, await inputIdBySql(sid), "disconnected");
  const second = await fakeCapturePhone(page, await newPhoneRequest(new URL(page.url()).origin), { qrText });
  await expect
    .poll(async () => {
      const state = (await second.beat({ claim: "new", device: { model: "Galaxy S24" } })).ok?.state ?? "refused";
      return state !== "taken" && state !== "replaced" && state !== "refused";
    }, {
      message: "the dead phone's slot is taken over (A14)",
      timeout: TAKEOVER_S * 1_000 + 3 * POLL_WAIT_MS,
      intervals: [1_000],
    })
    .toBe(true);
  second.keepAlive();
  const at = await lastTakeoverAt(f.id);
  await expect(body.getByTestId("stream-state-pill"), "premise: still live").toHaveText(en("stream.phone.state.live"));
  await expect(body.getByTestId("stream-takeover-text")).toHaveText(en("stream.takeover.lineLive", { model: "Galaxy S24", time: venueTime(at, TZ) }), {
    timeout: 2 * POLL_WAIT_MS,
  });
});
