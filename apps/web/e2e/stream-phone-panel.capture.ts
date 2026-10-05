// The organiser stream panel's phone-capture states (capture QR v2 §6.12, Option B rev 2): a visual gate at 1280, 768
// and 320, cropped to the panel.
//
// A CAPTURE HARNESS, not a spec: `.capture.ts` falls outside every project's `testMatch` except `gallery`, and the
// PHONE_PANEL_SHOTS_DIR guard makes it a no-op without one. It goes live through the fake relay drivers, so it never
// runs in CI's parallel leg, where it would compete for the fake's stream capacity. Run it deliberately, against a
// production server started with CAPTURE_QR_V2_ALWAYS=1 (FAKE_INGEST_CONNECT_AFTER_MS ≥ 20000 holds the warming state
// still for its shot):
//
//   PHONE_PANEL_SHOTS_DIR=/tmp/panel PLAYWRIGHT_BASE=http://localhost:PORT E2E_PROD_TARGET=1 DATABASE_URL=… \
//     pnpm exec playwright test --project=gallery e2e/stream-phone-panel.capture.ts
//
// The flag-off shots need a server WITHOUT the override (and with no PostHog key, so `fallback: false` answers):
// add PHONE_PANEL_FLAG_OFF=1 and the harness takes only those states (B8 re-review item 2: the credit purchase stays).
//
// The ask-10 shot (07b) is REAL, not staged (B8 re-review item 1): a paired phone goes live and then stops checking in,
// and the server's own countdown arms. It needs the session to stay in warming past ask 10's end — a server started
// with FAKE_INGEST_CONNECT_AFTER_MS ≥ 150000 — so it is its own pass: add PHONE_PANEL_ASK10=1 and the harness takes
// only that state.
//
// WHAT IS REAL AND WHAT IS STAGED. The phone, the code, the pairing, Go live, warming, live, Stop, Ended and the restart
// line are the product's own: a real code minted by the panel, claimed by a real beat through the capture route, and a
// real session on the fake ingest. Some states cannot be reached on a clock a harness can wait for (silence, the
// server's countdowns, a paused camera, a legacy session with no pairing, a restart allowance spent), so each is STAGED
// by rewriting the REAL answer of `stream-phone` or `current` in flight: the real response is fetched, and only the named
// fields change. The state machine behind them is the server suites' and T12's walkthrough's, not this file's.
//
// B8 review m-1: the phone-lost (09) and paused (10) states run on a SECOND live session whose destination REALLY does
// not receive — its stream key carries the fake platform's never-accepting prefix (fakes.ts FAKE_CONNECTING_KEY_PREFIX),
// so `current`'s output is the server's own `connecting`, past D3's 30 s, and only the phone's half is staged.
//
// THE GATE HAS ITS OWN VACUOUS MODE (AGENTS.md class 10): every image is checked to exist and to differ from every
// other, at least one state per width is required, and the control-set diff (320 vs 1280, membership, order and
// repeats) runs on what was captured — a state that never opened would fail its marker wait first.
import { test, expect, request as pwRequest, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
import { setRigPlan, signInAs } from "./overlay-kit";
import { expectQrDecodesAsPainted, qrModulesOf } from "./helpers/qr-enlarge";

const DIR = process.env.PHONE_PANEL_SHOTS_DIR;
const FLAG_OFF = process.env.PHONE_PANEL_FLAG_OFF === "1";
const ASK10 = process.env.PHONE_PANEL_ASK10 === "1";
/** Desktop, tablet, phone — the house bar (AGENTS.md). Heights are each device's own; the crop is the panel. */
const WIDTHS = [
  { w: 1280, h: 900 },
  { w: 768, h: 1024 },
  { w: 320, h: 640 },
] as const;
/** The panel polls `current` and `stream-phone` every STREAM_POLL_MS (5 s); a staged answer shows on the next poll. */
const POLL_WAIT_MS = 15_000;
/** Copy from the dictionary itself, never typed here. */
const EN = JSON.parse(readFileSync(join(import.meta.dirname, "../src/dictionaries/en/ui.json"), "utf8")) as Record<string, string>;
/** The fake platform's never-accepting key prefix, read from the fake itself (fakes.ts), never typed here. */
const CONNECTING_PREFIX = /export const FAKE_CONNECTING_KEY_PREFIX = "([^"]+)";/.exec(
  readFileSync(join(import.meta.dirname, "../src/server/relay/fakes.ts"), "utf8"),
)![1]!;
/** D3's hold (stream-session-view.ts OUTPUT_WARNING_AFTER_MS, 30 s) plus a poll, plus slack. */
const D3_WAIT_MS = 75_000;

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

interface Rig { orgId: string; fixtureId: string; fixturePath: string; tag: string }

/** A fresh org on pro (the relay and monthly credits), one generic division of two entrants and its one fixture. */
async function seedRig(page: Page): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const email = `delivered+cap-${tag}@resend.dev`;
  const orgSlug = `cap-org-${tag}`;
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
  const { fixtureIds } = await createStageAndGenerate(page.request, div.data!.id);
  expect(fixtureIds, "a league of two plays once").toHaveLength(1);
  const [f] = await withDb((sql) => sql<{ id: string; no: number }[]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id}`);
  await setRigPlan(orgId, "pro");
  return { orgId, fixtureId: f!.id, fixturePath: `/o/${orgSlug}/c/${comp.data!.slug}/d/${div.data!.slug}/f/${f!.no}`, tag };
}

/** Open the fixture's Stream control at desktop width and return the panel's scope (one DOM; resized per shot). */
async function openPanel(page: Page, rig: Rig): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(rig.fixturePath);
  // The crop is the panel: the cookie banner (fixed, bottom) is answered, and the sticky app header is put back in flow
  // so a crop scrolled under it is not painted over. Neither moves the panel's own layout.
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  // The banner mounts after hydration: wait for it briefly rather than sample once.
  await reject.waitFor({ state: "visible", timeout: 5_000 }).then(() => reject.click()).catch(() => undefined);
  await page.addStyleTag({ content: "header { position: static !important; }" });
  const control = page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
  await expect(control).toHaveCount(1, { timeout: 30_000 });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  await expect(scope).toBeAttached({ timeout: 30_000 });
  return scope;
}

// `summary`: a disclosure's toggle is a control a person reaches like any other.
const CONTROLS = "button, a[href], select, input:not([type=hidden]), textarea, summary, [role=radio], [role=tab]";
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

interface Shot { state: string; width: number; file: string; sha: string; controls: string[]; qrPx: number | null; qrModules: number | null }
const shots: Shot[] = [];

/** One state at every width: resize, settle, no horizontal page scroll, crop to the panel (or `target`). */
async function shoot(page: Page, scope: Locator, state: string, target?: Locator): Promise<void> {
  for (const { w, h } of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(450); // the QR's ResizeObserver re-snaps; the chain's caret re-places
    await expectNoHorizontalScroll(page);
    const file = join(DIR!, `${state}@${w}.png`);
    const el = target ?? scope;
    await el.scrollIntoViewIfNeeded();
    await el.screenshot({ path: file, animations: "disabled" });
    expect(existsSync(file), `${state}@${w} was written`).toBe(true);
    const qr = scope.getByTestId("stream-qr");
    const qrVisible = (await qr.count()) > 0 && (await qr.first().isVisible());
    shots.push({
      state, width: w, file,
      sha: createHash("sha256").update(readFileSync(file)).digest("hex"),
      controls: await controlSet(scope),
      qrPx: qrVisible ? Math.round((await qr.first().boundingBox())!.width * 100) / 100 : null,
      qrModules: qrVisible ? await qrModulesOf(qr.first()) : null,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Rewrite the REAL answer of a GET in flight: fetch it, change only what `edit` names inside the v1 envelope's `data`
 *  ({ ok, data, requestId }). A refused read passes through untouched. */
async function stage(page: Page, url: string, edit: (real: Record<string, unknown> | null) => unknown): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { ok?: boolean; data?: Record<string, unknown> | null };
    if (!body.ok) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: { ...body, data: edit(body.data ?? null) } });
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

/** The phone: a real claim, then a beat every 5 s, through the capture route (Bearer tok, no cookie). */
async function pairPhone(baseURL: string, qrText: string): Promise<{ stop: () => Promise<void> }> {
  const q = JSON.parse(qrText) as { v: number; code: string; slot: number; tok: string };
  expect(Object.keys(q), "the paste code is the QR's four keys").toEqual(["v", "code", "slot", "tok"]);
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

test.describe("capture QR v2 — the organiser panel's phone states", () => {
  test.skip(!DIR, "set PHONE_PANEL_SHOTS_DIR to capture");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    mkdirSync(DIR!, { recursive: true });
  });

  test.afterAll(() => {
    if (shots.length === 0) return;
    // Every image differs from every other (a state that never opened would repeat its neighbour).
    const bySha = new Map<string, string[]>();
    for (const s of shots) bySha.set(s.sha, [...(bySha.get(s.sha) ?? []), `${s.state}@${s.width}`]);
    const dupes = [...bySha.values()].filter((v) => v.length > 1);
    // The control-set diff, 320 against 1280, per state: membership, order and repeats.
    const states = [...new Set(shots.map((s) => s.state))];
    const diffs = states.flatMap((st) => {
      const wide = shots.find((s) => s.state === st && s.width === 1280)!.controls;
      const narrow = shots.find((s) => s.state === st && s.width === 320)!.controls;
      return JSON.stringify(wide) === JSON.stringify(narrow) ? [] : [{ state: st, wide, narrow }];
    });
    writeFileSync(join(DIR!, FLAG_OFF ? "shots-flag-off.json" : ASK10 ? "shots-ask10.json" : "shots.json"), JSON.stringify({ shots, dupes, diffs }, null, 2));
    expect(states.length, "states captured").toBeGreaterThan(0);
    expect(shots.length, "every state at every width").toBe(states.length * WIDTHS.length);
    expect(dupes, "two shots are pixel-identical").toEqual([]);
    expect(diffs, "the panel's control set differs between 320 and 1280").toEqual([]);
  });

  test("flag ON: every phone state, real where the product can reach it, staged where only a clock can", async ({ page, baseURL }) => {
    test.skip(FLAG_OFF || ASK10, "the flag-off and ask-10 runs take only their own states");
    test.setTimeout(10 * 60_000);
    const rig = await seedRig(page);
    const target = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
      kind: "youtube", label: "Riverside TV", streamKey: `e2e-${randomBytes(6).toString("hex")}`,
    });
    expect([200, 201]).toContain(target.status);
    // The second destination never receives (m-1): its key is the fake platform's dialling-forever shape.
    const silentDest = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
      kind: "twitch", label: "Northgate Live", streamKey: `${CONNECTING_PREFIX}${randomBytes(6).toString("hex")}`,
    });
    expect([200, 201]).toContain(silentDest.status);
    const PHONE = `**/api/v1/fixtures/${rig.fixtureId}/stream-phone`;
    const CURRENT = `**/api/v1/fixtures/${rig.fixtureId}/stream-sessions/current`;
    let phone: { stop: () => Promise<void> } | null = null;
    try {
      const scope = await openPanel(page, rig);
      await expect(scope.getByTestId("stream-tab-phone"), "the override shows the option").toBeVisible();

      // 1. Ready, no phone: the code card — a REAL code, minted on open.
      await expect(scope.getByTestId("stream-code-card")).toBeVisible({ timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-go-live")).toBeDisabled();
      await shoot(page, scope, "01-ready-no-phone");
      const qrText = await scope.getByTestId("stream-qr-text").inputValue();
      // §6.2's size gate: the QR as PAINTED, at every width, decodes to the paste code — the four keys, nothing else.
      for (const { w, h } of WIDTHS) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(450);
        await expectQrDecodesAsPainted(scope.getByTestId("stream-qr"), qrText, `the stream code @${w}`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // 2. Ready, paired: a real claim beat; the card folds, Go live enables.
      phone = await pairPhone(baseURL!, qrText);
      await expect(scope.getByTestId("stream-code-disclosure")).toBeVisible({ timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-go-live")).toBeEnabled();
      await shoot(page, scope, "02-ready-paired");

      // 3. Paired, the code shown again (the same code, re-shown), and 4. Revoke & reissue's confirm (declined).
      await scope.getByTestId("stream-code-disclosure").locator("summary").click();
      await expect(scope.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });
      expect(await scope.getByTestId("stream-qr-text").inputValue(), "the ensure re-shows the active code").toBe(qrText);
      await shoot(page, scope, "03-ready-paired-code-open");
      await scope.getByTestId("stream-code-reissue").click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await shoot(page, scope, "04-reissue-confirm", dialog);
      await dialog.getByRole("button", { name: /cancel/i }).click();
      await expect(dialog).toHaveCount(0);
      await scope.getByTestId("stream-code-disclosure").locator("summary").click();
      await expect(scope.getByTestId("stream-qr-text")).toHaveCount(0);

      // 5. Ready, silent (STAGED: §6.9's silence is minutes away): the real answer, the phone marked silent.
      let undo = await stage(page, PHONE, (r) => ({ ...r, phone: { ...(r!.phone as object), present: false, silent: true } }));
      await expect(scope.getByTestId("stream-phone-strip")).toHaveAttribute("data-icon", "alert", { timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-go-live")).toBeDisabled();
      await shoot(page, scope, "05-ready-silent");
      await undo();
      await expect(scope.getByTestId("stream-go-live")).toBeEnabled({ timeout: POLL_WAIT_MS });

      // 6. Go live (REAL) → waiting for the phone's video.
      await scope.getByTestId("stream-go-live").click();
      await expect(scope.getByTestId("stream-waiting")).toBeVisible({ timeout: POLL_WAIT_MS });
      await shoot(page, scope, "06-waiting");

      // 7. Warming with the server's countdown (STAGED fields: the countdown, as T9 serves it).
      undo = await stage(page, CURRENT, (r) => ({ ...r, countdown: { kind: "warming", reason: "no_inbound_timeout", elapsedMs: 45_000, remainingMs: 555_000 } }));
      await expect(scope.getByTestId("stream-phone-strip")).toHaveAttribute("data-tone", "amber", { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "07-waiting-countdown");
      await undo();

      // 8. Live (REAL: the fake ingest connects).
      await expect(scope.getByTestId("stream-stop")).toBeVisible({ timeout: 60_000 });
      await expect(scope.getByTestId("stream-phone-strip")).toHaveCount(0, { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "08-live");

      // 11. Live, a LEGACY session (STAGED: null pairing) — today's panel: no strip, no code line.
      undo = await stage(page, PHONE, (r) => ({ ...r, legacy: true, phone: null, code: null }));
      await expect(scope.getByTestId("stream-code-disclosure")).toHaveCount(0, { timeout: POLL_WAIT_MS });
      await shoot(page, scope, "11-live-legacy");
      await undo();
      await expect(scope.getByTestId("stream-code-disclosure")).toBeVisible({ timeout: POLL_WAIT_MS });

      // 12. Stop (REAL) → Ended, with the restart line, then 13. Start another → Ready with the restart line.
      await scope.getByTestId("stream-stop").click();
      const stop = page.getByRole("alertdialog");
      await expect(stop).toBeVisible();
      await stop.getByRole("button", { name: EN["stream.phone.stop"], exact: true }).click();
      await expect(scope.getByTestId("stream-ended")).toBeVisible({ timeout: 30_000 });
      await shoot(page, scope, "12-ended");
      await scope.getByTestId("stream-again").click();
      await expect(scope.getByTestId("stream-go-live")).toBeVisible({ timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-restart")).toBeVisible({ timeout: POLL_WAIT_MS });
      await shoot(page, scope, "13-ready-restarts");

      // 13b. Ready, the window's free restarts SPENT (STAGED: the allowance, as W23 serves it) — the mockup's own amber
      // "3 of 3 — this one uses 1 credit" (m-1).
      undo = await stage(page, CURRENT, (r) => ({ ...r, restart: { windowOpen: true, used: 3, limit: 3, free: false } }));
      // `current` rests at Ready (terminal, dismissed): re-opening the Phone tab reads it again, as opening it always does.
      await scope.getByTestId("stream-tab-obs").click();
      await scope.getByTestId("stream-tab-phone").click();
      await expect(scope.getByTestId("stream-restart")).toContainText(
        EN["stream.restart.usedCredit"]!.replace("{used}", "3").replace("{limit}", "3"), { timeout: POLL_WAIT_MS },
      );
      await shoot(page, scope, "13b-ready-restarts-limit");
      await undo();

      // The second session: the never-receiving destination, picked (a pick, the organiser's own), then Go live (REAL).
      await scope.getByTestId("stream-target").selectOption(silentDest.data!.id);
      await expect(scope.getByTestId("stream-go-live")).toBeEnabled({ timeout: POLL_WAIT_MS });
      await scope.getByTestId("stream-go-live").click();
      await expect(scope.getByTestId("stream-waiting")).toBeVisible({ timeout: POLL_WAIT_MS });

      // (7b, warming with the phone lost, is its own REAL pass: PHONE_PANEL_ASK10=1.)

      // Live (REAL), and the destination REALLY not receiving: D3's stream-key box once the server's 30 s have run.
      await expect(scope.getByTestId("stream-stop")).toBeVisible({ timeout: 60_000 });
      await expect(scope.getByTestId("stream-output-warning")).toHaveAttribute("data-cause", "destination", { timeout: D3_WAIT_MS });

      // 9. Live, the phone lost (STAGED: the input down, the server's live countdown, the phone silent; the output is the
      // server's own `connecting`, past 30 s) — D3 moves to the phone, and the strip replaces its box.
      const undoCur = await stage(page, CURRENT, (r) => ({
        ...r, ingest: { state: "disconnected", protocol: null },
        countdown: { kind: "live", reason: "phone_lost", elapsedMs: 160_000, remainingMs: 740_000 },
      }));
      let undoPhone = await stage(page, PHONE, (r) => ({ ...r, phone: { ...(r!.phone as object), present: false, silent: true } }));
      await expect(scope.getByTestId("stream-phone-strip")).toContainText("12 min", { timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-output-warning"), "the strip replaces D3's phone box").toHaveCount(0);
      await expect(scope.getByTestId("stream-chain")).toContainText(EN["stream.chain.word.notReceiving"]!);
      await shoot(page, scope, "09-live-phone-lost");
      await undoPhone();

      // 10. Live, paused (O5, STAGED): the input still down with NO countdown, the phone beating with notReady camera.
      await undoCur();
      const undoCur2 = await stage(page, CURRENT, (r) => ({ ...r, ingest: { state: "disconnected", protocol: null }, countdown: null }));
      undoPhone = await stage(page, PHONE, (r) => ({ ...r, phone: { ...(r!.phone as object), notReady: "camera" } }));
      await expect(scope.getByTestId("stream-phone-strip")).toHaveAttribute("data-icon", "pause", { timeout: POLL_WAIT_MS });
      await expect(scope.getByTestId("stream-chain")).toContainText(EN["stream.chain.word.notReceiving"]!);
      await shoot(page, scope, "10-live-paused");
      await undoPhone();
      await undoCur2();
    } finally {
      await phone?.stop();
      const open = await withDb((sql) => sql<{ id: string }[]>`
        select id from fixture_stream_sessions where fixture_id = ${rig.fixtureId} and state not in ('completed', 'failed')`);
      for (const s of open) await page.request.post(`/api/v1/fixtures/${rig.fixtureId}/stream-sessions/${s.id}/stop`).catch(() => null);
    }
  });

  test("flag OFF: the option is hidden — no Phone/OBS switch, the OBS overlay directly", async ({ page }) => {
    test.skip(!FLAG_OFF || ASK10, "needs a server without CAPTURE_QR_V2_ALWAYS (PHONE_PANEL_FLAG_OFF=1)");
    test.setTimeout(3 * 60_000);
    const rig = await seedRig(page);
    const scope = await openPanel(page, rig);
    await expect(scope.getByTestId("stream-lead")).toBeVisible({ timeout: 30_000 });
    await expect(scope.getByTestId("stream-tab-phone")).toHaveCount(0);
    await expect(scope.getByTestId("stream-tab-obs")).toHaveCount(0);
    // B8 re-review item 2: the credit purchase stays — the balance and Buy more under the overlay (a pro org holds its
    // monthly credits), then the chooser it opens.
    const section = scope.getByTestId("stream-credits-section");
    await expect(section.getByTestId("stream-buy-more")).toBeVisible({ timeout: POLL_WAIT_MS });
    await expect(section.getByTestId("stream-balance")).toBeVisible();
    await shoot(page, scope, "14-flag-off");
    await section.getByTestId("stream-buy-more").click();
    await expect(section.getByTestId("stream-buy-pack-5")).toBeVisible();
    await expect(section.getByTestId("stream-buy-pack-5")).toBeEnabled();
    await expect(section.getByTestId("stream-credits-close")).toBeVisible();
    await shoot(page, scope, "14b-flag-off-buy");
  });

  test("ask 10, REAL: a paired phone goes live, then stops checking in — the server's countdown arms, and the Phone node says what the strip says", async ({ page, baseURL }) => {
    test.skip(!ASK10, "needs a server with FAKE_INGEST_CONNECT_AFTER_MS ≥ 150000 (PHONE_PANEL_ASK10=1)");
    test.setTimeout(5 * 60_000);
    const rig = await seedRig(page);
    const target = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
      kind: "youtube", label: "Riverside TV", streamKey: `e2e-${randomBytes(6).toString("hex")}`,
    });
    expect([200, 201]).toContain(target.status);
    const CURRENT_URL = `/api/v1/fixtures/${rig.fixtureId}/stream-sessions/current`;
    let phone: { stop: () => Promise<void> } | null = null;
    try {
      const scope = await openPanel(page, rig);
      await expect(scope.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });
      phone = await pairPhone(baseURL!, await scope.getByTestId("stream-qr-text").inputValue());
      await expect(scope.getByTestId("stream-go-live")).toBeEnabled({ timeout: POLL_WAIT_MS });
      await scope.getByTestId("stream-go-live").click();
      await expect(scope.getByTestId("stream-waiting")).toBeVisible({ timeout: POLL_WAIT_MS });
      // The phone is lost right after go-live: no more beats. Nothing below is staged.
      await phone.stop();
      phone = null;
      const sentence = EN["stream.phone.countdown.warming.phone_lost"]!.split("{remaining}")[0]!.trim();
      await expect(scope.getByTestId("stream-phone-strip")).toContainText(sentence, { timeout: 120_000 });
      const node = scope.locator('[data-node="phone"]');
      await expect(node).toContainText(EN["stream.chain.word.notAnswering"]!);
      await expect(node.locator('[data-mark="bang"]'), "the '!' on the phone node").toHaveCount(1);
      await expect(scope.getByTestId("stream-chain")).not.toContainText(EN["stream.chain.word.starting"]!);
      // The folded "Paired" line's dot says it too (coordinator ruling): amber, from the same countdown.
      await expect(scope.getByTestId("stream-code-disclosure").locator("summary [data-tone]")).toHaveAttribute("data-tone", "amber");
      // The server's own numbers, read beside the shot: the evidence that the countdown is real.
      const real = (await (await page.request.get(CURRENT_URL)).json()) as { data: { state: string; countdown: unknown } };
      expect(real.data.state).toBe("warming");
      expect(real.data.countdown).toMatchObject({ kind: "warming", reason: "phone_lost" });
      writeFileSync(join(DIR!, "07b-current.json"), JSON.stringify({ at: new Date().toISOString(), state: real.data.state, countdown: real.data.countdown }, null, 2));
      await shoot(page, scope, "07b-waiting-phone-lost");
    } finally {
      await phone?.stop();
      const open = await withDb((sql) => sql<{ id: string }[]>`
        select id from fixture_stream_sessions where fixture_id = ${rig.fixtureId} and state not in ('completed', 'failed')`);
      for (const s of open) await page.request.post(`/api/v1/fixtures/${rig.fixtureId}/stream-sessions/${s.id}/stop`).catch(() => null);
    }
  });
});
