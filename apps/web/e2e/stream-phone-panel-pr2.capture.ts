// Capture QR v2 PR-2 (spec §7.1, §7.4, §7.5; T10–T12): the organiser panel's PR-2 states as a VISUAL gate at 1280, 768
// and 320, cropped to the panel — each compared by eye with the owner-approved mockup Option A
// (.superpowers/sdd/2026-10-07-capture-qr-v2-pr2/mockups/option-a-inline-line*.png).
//
// A CAPTURE HARNESS, not a spec: `.capture.ts` is matched only by the `gallery` project, and the PHONE_PANEL_PR2_SHOTS_DIR
// guard makes it a no-op without one. It goes live through the fake relay drivers, so it never runs in CI's parallel leg.
// Run it deliberately, against a production server started with CAPTURE_QR_V2_ALWAYS=1 and RELAY_DRIVERS=fake:
//
//   PHONE_PANEL_PR2_SHOTS_DIR=/tmp/pr2 PLAYWRIGHT_BASE=http://localhost:PORT E2E_PROD_TARGET=1 DATABASE_URL=… \
//     pnpm exec playwright test --project=gallery e2e/stream-phone-panel-pr2.capture.ts
//
// WHAT IS REAL AND WHAT IS STAGED. The code, the pairing, the switch (tapped, saved), Go live, waiting, live and the
// switched-off org are the product's own. The phone's readings and the server's verdicts over them (an amber reason, a
// confirmed not-ready, a refusal, a takeover) are STAGED by rewriting the REAL answer of `stream-phone` in flight — only
// the named fields change. Each verdict is driven for real, through the phone's beats, by
// e2e/walkthrough/capture-panel-pr2.spec.ts; this file only pictures them.
//
// THE GATE HAS ITS OWN VACUOUS MODE (AGENTS.md class 10): every image is checked to exist and to differ from every
// other, every state is captured at every width, and the control-set diff (320 vs 1280: membership, order, repeats) runs
// on what was captured — a state that never opened fails its marker wait first.
import { test, expect, request as pwRequest, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, invalidateOrgEntitlements, setBoolEntitlementOverrideSql,
} from "./helpers";
import { setRigPlan, signInAs } from "./overlay-kit";

const DIR = process.env.PHONE_PANEL_PR2_SHOTS_DIR;
const WIDTHS = [
  { w: 1280, h: 900 },
  { w: 768, h: 1024 },
  { w: 320, h: 640 },
] as const;
const POLL_WAIT_MS = 15_000;
const EN = JSON.parse(readFileSync(join(import.meta.dirname, "../src/dictionaries/en/ui.json"), "utf8")) as Record<string, string>;
const en = (k: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), EN[k] ?? `MISSING:${k}`);

test.use({ storageState: { cookies: [], origins: [] } });

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for the rig");
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

interface Rig { orgId: string; fixtureId: string; fixturePath: string }

async function seedRig(page: Page): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const email = `delivered+cap2-${tag}@resend.dev`;
  const orgSlug = `cap2-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"Capture Owner " + tag}, true) returning id`;
    const [{ id }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Capture Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${id}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${id}`;
    return id;
  });
  await signInAs(page, email);
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31", name: `Capture ${tag}`, visibility: "public",
  });
  expect(comp.status, "competition").toBeLessThan(300);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Capture ${tag}`.slice(0, 40), sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, "division").toBeLessThan(300);
  const ents = await addEntrantsViaApi(page.request, div.data!.id, ["Riverside Raptors", "Northgate Nomads"]);
  expect(ents.ids, "entrants").toHaveLength(2);
  await createStageAndGenerate(page.request, div.data!.id);
  const [f] = await withDb((sql) => sql<{ id: string; no: number }[]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id}`);
  await setRigPlan(orgId, "pro");
  return { orgId, fixtureId: f!.id, fixturePath: `/o/${orgSlug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${f!.no}` };
}

async function openPanel(page: Page, rig: Rig): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(rig.fixturePath);
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await reject.waitFor({ state: "visible", timeout: 5_000 }).then(() => reject.click()).catch(() => undefined);
  await page.addStyleTag({ content: "header { position: static !important; }" });
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control).toHaveCount(1, { timeout: 30_000 });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: 30_000 });
  const tab = scope.getByTestId("stream-tab-phone");
  if (await tab.count()) await tab.click();
  return scope;
}

const CONTROLS = "button, a[href], select, input:not([type=hidden]), textarea, summary, [role=radio], [role=tab], [role=switch]";
async function controlSet(scope: Locator): Promise<string[]> {
  return scope.evaluate((root, sel) => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue;
      out.push(el.dataset.testid ?? `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 30)}`);
    }
    return out;
  }, CONTROLS);
}

interface Shot { state: string; width: number; file: string; sha: string; controls: string[] }
const shots: Shot[] = [];
let pairedChecks = 0;

async function shoot(page: Page, scope: Locator, state: string): Promise<void> {
  for (const { w, h } of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await page.mouse.move(0, 0); // no hover left over from the last tap (a moved layout puts a button under the cursor)
    await page.waitForTimeout(450);
    await expectNoHorizontalScroll(page);
    // The fold's "Paired · Pixel 8" is whole at every width (the link beside it wraps first) — counted, never vacuous.
    const paired = scope.getByTestId("stream-code-paired");
    if ((await paired.count()) > 0 && (await paired.isVisible())) {
      expect(await paired.evaluate((el) => el.scrollWidth - el.clientWidth), `${state}@${w}: 'Paired · model' is not truncated`).toBeLessThanOrEqual(0);
      pairedChecks++;
    }
    const file = join(DIR!, `${state}@${w}.png`);
    await scope.scrollIntoViewIfNeeded();
    await scope.screenshot({ path: file, animations: "disabled" });
    expect(existsSync(file), `${state}@${w} was written`).toBe(true);
    shots.push({ state, width: w, file, sha: createHash("sha256").update(readFileSync(file)).digest("hex"), controls: await controlSet(scope) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function stage(page: Page, url: string, edit: (real: Record<string, unknown>) => unknown): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { ok?: boolean; data?: Record<string, unknown> | null };
    if (!body.ok || !body.data) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: { ...body, data: edit(body.data) } });
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

/** The phone: a real claim, then a beat every 5 s through the capture route (Bearer tok, no cookie). */
async function pairPhone(baseURL: string, qrText: string): Promise<{ stop: () => Promise<void> }> {
  const q = JSON.parse(qrText) as { v: number; code: string; slot: number; tok: string };
  const phone: APIRequestContext = await pwRequest.newContext({ baseURL });
  const id = randomBytes(16).toString("hex");
  const beat = (claim: "new" | null) => ({
    code: q.code, slot: q.slot, phone: id, claim, device: claim ? { model: "Pixel 8" } : null, sid: null,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), state: "paired", cause: null, notReady: null, startFailed: null,
    stopped: null, mode: "operator", transport: null, bitrateKbps: null, delivery: "unknown", deliveredLagS: null, audioOk: null,
    battery: { percent: 87, charging: false, drainPctPerHour: null }, thermal: 0, dataUsedMB: 0, appVersion: "1.4.0",
  });
  const send = (claim: "new" | null) =>
    phone.post(`/api/v1/capture/codes/${q.code}/beats`, { headers: { Authorization: `Bearer ${q.tok}` }, data: beat(claim) });
  const first = await send("new");
  expect(first.status(), `the claim beat: ${await first.text()}`).toBe(200);
  const timer = setInterval(() => void send(null).catch(() => null), 5_000);
  return { stop: async () => { clearInterval(timer); await phone.dispose(); } };
}

type Json = Record<string, unknown>;
const AUTO_ON = { enabled: true, startedAt: null, blocked: false, refusal: null, refusalAt: null, stopApplies: null };
const HEALTHY_BEAT = { battery: { percent: 78, charging: true, drainPctPerHour: null }, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 245.3 };
/** The read model's phone, with only `over` changed (the rest is the server's REAL answer). */
const phoneWith = (r: Json, over: Json): Json => ({ ...r, phone: { ...(r.phone as Json), ...over } });

test.describe("capture QR v2 PR-2 — the organiser panel's Option A states", () => {
  test.skip(!DIR, "set PHONE_PANEL_PR2_SHOTS_DIR to capture");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    mkdirSync(DIR!, { recursive: true });
  });

  test.afterAll(() => {
    if (shots.length === 0) return;
    const bySha = new Map<string, string[]>();
    for (const s of shots) bySha.set(s.sha, [...(bySha.get(s.sha) ?? []), `${s.state}@${s.width}`]);
    const dupes = [...bySha.values()].filter((v) => v.length > 1);
    const states = [...new Set(shots.map((s) => s.state))];
    const diffs = states.flatMap((st) => {
      const wide = shots.find((s) => s.state === st && s.width === 1280)!.controls;
      const narrow = shots.find((s) => s.state === st && s.width === 320)!.controls;
      return JSON.stringify(wide) === JSON.stringify(narrow) ? [] : [{ state: st, wide, narrow }];
    });
    writeFileSync(join(DIR!, "shots.json"), JSON.stringify({ shots, dupes, diffs }, null, 2));
    expect(states.length, "states captured").toBeGreaterThanOrEqual(20);
    expect(shots.length, "every state at every width").toBe(states.length * WIDTHS.length);
    expect(dupes, "two shots are pixel-identical").toEqual([]);
    expect(diffs, "the panel's control set differs between 320 and 1280").toEqual([]);
    expect(pairedChecks, "anti-vacuity: the fold's label was checked at every width of every paired state").toBeGreaterThanOrEqual(16 * WIDTHS.length);
  });

  test("every Option A state: real where the product reaches it, the phone's readings staged on the real answer", async ({ page, baseURL }) => {
    test.setTimeout(12 * 60_000);
    const rig = await seedRig(page);
    const target = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
      kind: "youtube", label: "Club channel", streamKey: `e2e-${randomBytes(6).toString("hex")}`,
    });
    expect([200, 201]).toContain(target.status);
    const PHONE = `**/api/v1/fixtures/${rig.fixtureId}/stream-phone`;
    let phone: { stop: () => Promise<void> } | null = null;
    try {
      const scope = await openPanel(page, rig);
      await expect(scope.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });
      phone = await pairPhone(baseURL!, await scope.getByTestId("stream-qr-text").inputValue());
      await expect(scope.getByTestId("stream-code-disclosure")).toBeVisible({ timeout: POLL_WAIT_MS });
      const strip = scope.getByTestId("stream-phone-strip");
      const sw = scope.getByTestId("stream-auto-switch");

      // 1. Ready, auto off (REAL): "Pixel 8 · Operator", the switch off.
      await expect(strip).toHaveText(`Pixel 8 · ${en("stream.phone.mode.operator")}`, { timeout: POLL_WAIT_MS });
      await expect(sw).toHaveAttribute("aria-checked", "false");
      await shoot(page, scope, "01-ready-auto-off");

      // 2. Ready, auto on (REAL: tapped and saved).
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-auto-hint")).toBeVisible();
      // The phone beats in Operator (REAL): the owner-approved hint under the switch (2026-10-08).
      await expect(scope.getByTestId("stream-auto-operator")).toHaveText(en("stream.auto.operatorHint"), { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "02-ready-auto-on");
      // 2b. The same, the phone in Automatic (STAGED: the beat's mode) — no hint.
      let undo = await stage(page, PHONE, (r) => phoneWith(r, { mode: "automatic" }));
      await expect(strip).toHaveText(`Pixel 8 · ${en("stream.phone.mode.automatic")}`, { timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-auto-operator")).toHaveCount(0);
      await shoot(page, scope, "02b-ready-auto-on-automatic");
      await undo();
      await expect(scope.getByTestId("stream-auto-operator")).toBeVisible({ timeout: POLL_WAIT_MS });

      // 9a. Takeover notice at Ready (STAGED: lastTakeover).
      undo = await stage(page, PHONE, (r) => ({ ...r, lastTakeover: { at: new Date(Date.now() - 120_000).toISOString(), model: "Pixel 8", elapsedMs: 120_000 } }));
      await expect(scope.getByTestId("stream-takeover")).toBeVisible({ timeout: POLL_WAIT_MS });
      await shoot(page, scope, "09a-takeover-ready");
      await undo();
      await expect(scope.getByTestId("stream-takeover")).toHaveCount(0, { timeout: POLL_WAIT_MS });

      // 10. Auto start refused: no credit (STAGED: auto.refusal) — Buy credits; 10b no destination — Manage destinations.
      undo = await stage(page, PHONE, (r) => ({ ...r, auto: { ...AUTO_ON, refusal: "no_credit", refusalAt: new Date().toISOString() } }));
      await expect(strip.getByTestId("stream-auto-remedy-buy")).toBeVisible({ timeout: POLL_WAIT_MS });
      await shoot(page, scope, "10-refused-no-credit");
      await undo();
      undo = await stage(page, PHONE, (r) => ({ ...r, auto: { ...AUTO_ON, refusal: "no_destination", refusalAt: new Date().toISOString() } }));
      await expect(strip.getByTestId("stream-auto-remedy-manage")).toBeVisible({ timeout: POLL_WAIT_MS });
      await shoot(page, scope, "10b-refused-no-destination");
      await undo();
      await expect(strip.getByTestId("stream-auto-remedy-manage")).toHaveCount(0, { timeout: POLL_WAIT_MS });

      // Go live (REAL), the video held off through the fake's control route so Waiting holds still.
      await scope.getByTestId("stream-go-live").click();
      await expect(scope.getByTestId("stream-waiting")).toBeVisible({ timeout: POLL_WAIT_MS });
      let uid: string | null = null;
      await expect.poll(async () => {
        const [r] = await withDb((sql) => sql<{ id: string | null }[]>`
          select i.ingest_input_id as id from fixture_stream_inputs i join fixture_stream_sessions s on s.id = i.session_id
           where s.fixture_id = ${rig.fixtureId} order by s.created_at desc, i.slot limit 1`);
        uid = r?.id ?? null;
        return uid;
      }, { timeout: POLL_WAIT_MS }).not.toBeNull();
      const ingest = async (state: "connected" | "disconnected") =>
        expect((await page.request.post(`/api/internal/relay/fake-ingest/${uid}`, { data: { state } })).status()).toBe(200);
      await ingest("disconnected");

      // 3a–3d. Waiting, the phone not ready (STAGED: the server's confirmed reason); 3e. the phone's start failed.
      for (const [state, reason] of [["03a-waiting-not-ready-camera", "camera"], ["03b-waiting-not-ready-sound", "sound"], ["03c-waiting-not-ready-network", "network"], ["03d-waiting-not-ready-held", "held"]] as const) {
        undo = await stage(page, PHONE, (r) => phoneWith(r, { notReady: reason, notReadyShown: true, notReadyForMs: 24_000, mode: "automatic" }));
        await expect(strip).toContainText(en("stream.phone.notReady.line", { reason: en(`stream.phone.notReady.reason.${reason}`) }), { timeout: POLL_WAIT_MS });
        await shoot(page, scope, state);
        await undo();
      }
      undo = await stage(page, PHONE, (r) => phoneWith(r, { startFailed: "start-error", mode: "automatic" }));
      await expect(strip).toContainText(en("stream.phone.startFailed"), { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "03e-waiting-start-failed");
      await undo();
      // 9c. Takeover notice while waiting — names Cancel (STAGED: lastTakeover; owner ruling 2026-10-08).
      undo = await stage(page, PHONE, (r) => ({ ...r, lastTakeover: { at: new Date(Date.now() - 60_000).toISOString(), model: "Pixel 8", elapsedMs: 60_000 } }));
      await expect(scope.getByTestId("stream-takeover-text")).toContainText("Cancel the stream", { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "09c-takeover-waiting");
      await undo();
      await expect(scope.getByTestId("stream-takeover")).toHaveCount(0, { timeout: POLL_WAIT_MS });

      // Live (REAL: the input connects).
      await ingest("connected");
      await expect(scope.getByTestId("stream-stop")).toBeVisible({ timeout: 60_000 });

      // 4. Live, healthy (STAGED readings; the switch REALLY on, the phone's mode staged automatic): the line, and §7.1's.
      // `stopApplies` is the server's (B7 review M-3): staged true here, as the real read answers for this session.
      const live = (over: Json) => (r: Json) => ({ ...phoneWith(r, { mode: "automatic", elapsedMs: 4_000, health: null, beat: HEALTHY_BEAT, ...over }), auto: { ...AUTO_ON, stopApplies: true } });
      undo = await stage(page, PHONE, live({}));
      await expect(scope.getByTestId("stream-auto-live")).toBeVisible({ timeout: POLL_WAIT_MS });
      await expect(strip).toContainText("2.4 Mbps", { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "04-live-healthy");
      // 4b. Details open: the runner's chips, then data used and the app version (Q-D).
      await scope.getByTestId("stream-details").locator("summary").click();
      await expect(scope.getByTestId("stream-phone-app-version")).toBeVisible();
      await shoot(page, scope, "04b-live-details");
      await scope.getByTestId("stream-details").locator("summary").click();
      await undo();

      // 5–8. Each amber the server names (STAGED `health` over matching readings).
      const ambers: [string, Json][] = [
        ["05-live-stalled", { health: "stalled", beat: { ...HEALTHY_BEAT, delivery: "stalled" } }],
        ["06-live-hot", { health: "hot", beat: { ...HEALTHY_BEAT, thermal: 3 } }],
        ["07-live-battery-low", { health: "battery_low", beat: { ...HEALTHY_BEAT, battery: { percent: 14, charging: false, drainPctPerHour: 9 } } }],
        ["08-live-not-responding", { health: "not_responding", notResponding: true, elapsedMs: 52_000 }],
      ];
      for (const [state, over] of ambers) {
        undo = await stage(page, PHONE, live(over));
        await expect(strip).toHaveAttribute("data-tone", "amber", { timeout: POLL_WAIT_MS });
        // Owner ruling 2026-10-08: stalled — the Seazn node waits for video; every other amber leaves it Receiving.
        await expect(scope.getByTestId("stream-chain")).toHaveAttribute("data-seazn", over.health === "stalled" ? "waitingVideo" : "receiving");
        await shoot(page, scope, state);
        await undo();
        await expect(strip).toHaveAttribute("data-tone", "slate", { timeout: POLL_WAIT_MS });
      }

      // 9b. Takeover notice while live — names Stop (STAGED: lastTakeover).
      undo = await stage(page, PHONE, (r) => ({ ...live({})(r), lastTakeover: { at: new Date(Date.now() - 60_000).toISOString(), model: "Pixel 8", elapsedMs: 60_000 } }));
      await expect(scope.getByTestId("stream-takeover-text")).toContainText("Stop the stream", { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "09b-takeover-live");
      await undo();

      // Stop (REAL).
      await scope.getByTestId("stream-stop").click();
      const stop = page.getByRole("alertdialog");
      await expect(stop).toBeVisible();
      await stop.getByRole("button", { name: EN["stream.phone.stop"], exact: true }).click();
      await expect(scope.getByTestId("stream-ended")).toBeVisible({ timeout: 30_000 });

      // 11. The relay switched off for this org (REAL: the entitlement override) — no switch, the switched-off state.
      await setBoolEntitlementOverrideSql(rig.orgId, "streaming.relay", false);
      await invalidateOrgEntitlements(page.request, rig.orgId);
      const denied = await openPanel(page, rig);
      await expect(denied.getByTestId("stream-switched-off")).toBeVisible({ timeout: 30_000 });
      await expect(denied.getByTestId("stream-auto-switch")).toHaveCount(0);
      await shoot(page, denied, "11-switched-off");
    } finally {
      await phone?.stop();
      const open = await withDb((sql) => sql<{ id: string }[]>`
        select id from fixture_stream_sessions where fixture_id = ${rig.fixtureId} and state not in ('completed', 'failed')`);
      for (const s of open) await page.request.post(`/api/v1/fixtures/${rig.fixtureId}/stream-sessions/${s.id}/stop`).catch(() => null);
    }
  });
});
