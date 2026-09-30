// Directory → Streaming (spec 2026-09-30 §4 / §9.2; owner rulings D1, D2, D6) — the ONE place an organiser manages
// where their matches stream to, walked by hand through a REAL production server on RELAY_DRIVERS=fake.
//
// Every case asserts through the UI and reads the API (or the table) back as the witness. Setup reaches a state by SQL
// or the API (an org, a destination, a session waiting or live); the action a case is about is TAPPED. Copy is read from
// the dictionaries themselves (`en()`), never typed here, and every refusal is asserted to read the PAGE's own sentence
// — the route's English `message` is never what a person sees.
//
// Sport-agnostic by design: a destination reads no sport. The rigs that need a match seed ONE generic division (the
// stream walkthroughs' own seed); the "another platform" axis is swept instead (STREAM_PLATFORMS, and a legacy kind).
//
// Every rig is a FRESH org: destinations and sessions are org-wide, and the walkthrough leg runs fully parallel.
//
// Stream capacity (plan premise 11): a held destination needs a session, and every active session holds a share of the
// fake ingest's ONE storage pool. This file takes its slots from stream-relay.spec.ts's keys through the SAME advisory
// lock scheme (`SLOT_LOCK_BASE`, the first `STREAM_CAPACITY − 1` keys), so the two files share the relay file's slots
// and never the credits walkthrough's last key. Every test stops its streams in teardown.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll } from "../helpers";
import { setRigPlan, signInAs } from "../overlay-kit";
import { STREAM_POLL_MS } from "../../src/lib/stream-session-view";
import { STREAM_PLATFORMS, type StreamPlatform } from "../../src/lib/stream-destinations";
import { FAKE_CONNECT_AFTER_MS_DEFAULT, FakeIngest } from "../../src/server/relay/fakes";
import { MAX_DURATION_MINUTES } from "../../src/server/relay/config";

// ===========================================================================
// Kit (file-local; the stream-relay.spec.ts shapes)
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

// Clocks — copied from stream-relay.spec.ts (:73-88), DERIVED from the constants that set the pace (AGENTS.md class 20).
const FAKE_CONNECT_MS = ((): number => {
  const raw = process.env.FAKE_INGEST_CONNECT_AFTER_MS;
  if (raw === undefined) return FAKE_CONNECT_AFTER_MS_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new Error(`FAKE_INGEST_CONNECT_AFTER_MS must be whole milliseconds, got ${JSON.stringify(raw)}`);
  return Number(raw);
})();
const LIVE_WAIT_MS = FAKE_CONNECT_MS + 2 * STREAM_POLL_MS + 5_000;
const POLL_WAIT_MS = STREAM_POLL_MS + 5_000;
const SEED_MS = 60_000;
const CYCLE_MS = LIVE_WAIT_MS + 3 * POLL_WAIT_MS;
/** One page load (a Directory or fixture page). Each case adds `NAVS * NAV_MS`, NAVS counted by reading the case. */
const NAV_MS = 30_000;
/** One mutation round trip: the request and the `router.refresh()` that re-reads the list. */
const SAVE_MS = POLL_WAIT_MS;

const STREAM_CAPACITY = Math.floor(new FakeIngest().storage.totalStorageMinutesLimit / MAX_DURATION_MINUTES);
const FILE_SLOTS = STREAM_CAPACITY - 1;
const SLOT_LOCK_BASE = 7_301_130_000;
const SLOT_WAIT_MS = 3 * CYCLE_MS;

let lease: (() => Promise<void>) | null = null;
const rigsThisTest: { request: APIRequestContext; orgId: string }[] = [];

/** One of the relay file's FILE_SLOTS keys, held until teardown (premise 11). */
async function streamSlot(): Promise<void> {
  if (lease) return;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for the stream-slot lease");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
    idle_timeout: 0,
  });
  const deadline = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    for (let i = 0; i < FILE_SLOTS; i++) {
      const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${SLOT_LOCK_BASE + i}::bigint) as ok`;
      if (row?.ok) {
        lease = () => sql.end();
        return;
      }
    }
    if (Date.now() > deadline) {
      await sql.end();
      throw new Error(`none of the relay file's ${FILE_SLOTS} stream slot(s) free after ${SLOT_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

interface SessionRow { id: string; fixture_id: string | null; state: string }
async function sessionsOf(orgId: string): Promise<SessionRow[]> {
  return withDb(async (sql) => [
    ...(await sql<SessionRow[]>`select id, fixture_id, state from fixture_stream_sessions where org_id = ${orgId} order by created_at`),
  ]);
}
const ACTIVE = new Set(["requested", "provisioning", "warming", "live", "ending"]);

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
    const release = lease;
    lease = null;
    await release?.();
  }
}

test.afterEach(async () => {
  await teardownStreams();
});

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
const matchName = (no: number): string => en("breadcrumb.match", { no });
const BRAND: Record<StreamPlatform, string> = { youtube: "YouTube", twitch: "Twitch" };

// Keys. The shapes are the platforms' own (spec §4 "Key-shape warning"); the nonce keeps every key distinct, because a
// key already saved in the org is that destination (A19), not a new one.
const nonce = (n: number): string => randomBytes(n).toString("hex").slice(0, n);
const ytKey = (): string => `${nonce(4)}-${nonce(4)}-${nonce(4)}-${nonce(4)}-${nonce(4)}`;
const twitchKey = (): string => `live_${100000000 + Math.floor(Math.random() * 800000000)}_${randomBytes(15).toString("base64url").replace(/[-_]/g, "A").slice(0, 20)}`;
/** Spec §5.3: a key of 12+ characters shows its last 3; a shorter one shows none. */
const HINT_CHARS = 3;
const HINT_MIN = 12;
const hintOf = (key: string): string | null => (key.length < HINT_MIN ? null : key.slice(-HINT_CHARS));

interface Rig { orgId: string; orgSlug: string; tag: string; divPath: string | null; fixtures: { id: string; no: number }[] }

/** A fresh org on pro, its owner signed in on `page`. With `entrants`, ONE generic league division too (stream-relay's
 *  seed) — a destination can only be HELD by a match. */
async function seedRig(page: Page, opts: { entrants?: number } = {}): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+dsd-${tag}@resend.dev`;
  const orgSlug = `dsd-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"Dest Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Dest Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return newOrgId;
  });
  await signInAs(page, ownerEmail);
  rigsThisTest.push({ request: page.request, orgId });
  let divPath: string | null = null;
  let fixtures: Rig["fixtures"] = [];
  if (opts.entrants) {
    const request = page.request;
    const label = `Dest ${tag}`;
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
    fixtures = await withDb(async (sql) => [
      ...(await sql<Rig["fixtures"]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id} order by fixture_no`),
    ]);
    divPath = `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}`;
  }
  await setRigPlan(orgId, "pro");
  return { orgId, orgSlug, tag, divPath, fixtures };
}

interface Target { id: string; kind: string; label: string; watchUrl: string | null; keyHint: string | null; inUse: { matchNo: number | null; state: string; href: string | null } | null }
async function listApi(page: Page, orgId: string): Promise<Target[]> {
  const res = await apiJson<Target[]>(page.request, `/api/v1/orgs/${orgId}/stream-targets`);
  expect(res.status, "the list reads").toBe(200);
  return res.data!;
}
async function addTargetApi(page: Page, orgId: string, t: { label: string; kind?: StreamPlatform; streamKey?: string }): Promise<Target> {
  const res = await apiJson<Target>(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", {
    kind: t.kind ?? "youtube", label: t.label, streamKey: t.streamKey ?? ytKey(),
  });
  if (res.status !== 201) throw new Error(`addTargetApi -> ${res.status} ${JSON.stringify(res.error)}`);
  return res.data!;
}
/** SETUP: a session made through the API and NOT read — WAITING (the server flips warming → live only on a read of
 *  `current`, so nothing here advances it). The premise is asserted from the table. */
async function holdWaiting(page: Page, fixtureId: string, targetId: string): Promise<void> {
  await streamSlot();
  const made = await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/stream-sessions`, "POST", { mode: "passthrough", targetId });
  if (made.status !== 201 && made.status !== 200) throw new Error(`holdWaiting -> ${made.status} ${JSON.stringify(made.error)}`);
}
/** SETUP: read `current` (the server's tick) until the fixture's session is live. */
async function untilLive(page: Page, fixtureId: string): Promise<void> {
  await expect
    .poll(async () => (await apiJson<{ state: string } | null>(page.request, `/api/v1/fixtures/${fixtureId}/stream-sessions/current`)).data?.state, {
      message: "the setup session never went live", timeout: LIVE_WAIT_MS, intervals: [1_000],
    })
    .toBe("live");
}
/** SETUP: stop the fixture's session through the API and read until it is no longer active. */
async function stopApi(page: Page, orgId: string, fixtureId: string): Promise<void> {
  const s = (await sessionsOf(orgId)).find((r) => r.fixture_id === fixtureId && ACTIVE.has(r.state));
  expect(s, "a session to stop").toBeTruthy();
  const res = await page.request.post(`/api/v1/fixtures/${fixtureId}/stream-sessions/${s!.id}/stop`);
  expect(res.status(), "stop answered").toBeLessThan(300);
  await expect
    .poll(async () => {
      await apiJson(page.request, `/api/v1/fixtures/${fixtureId}/stream-sessions/current`);
      return (await sessionsOf(orgId)).filter((r) => ACTIVE.has(r.state)).length;
    }, { timeout: CYCLE_MS, intervals: [1_000] })
    .toBe(0);
}

async function openStreaming(page: Page): Promise<Locator> {
  await page.goto("/directory?tab=streaming");
  const panel = page.getByTestId("stream-destinations");
  await expect(panel, "the Streaming tab rendered its panel").toBeVisible({ timeout: NAV_MS });
  return panel;
}
const rowOf = (page: Page, id: string): Locator => page.locator(`[data-testid="stream-dest-row"][data-target-id="${id}"]`);
const rows = (page: Page): Locator => page.getByTestId("stream-dest-row");

/** A row action, the width's own way: the ⋯ menu below 768, the inline button at and above it. */
async function tapAction(row: Locator, which: "rename" | "replace" | "remove", width: number): Promise<void> {
  if (width < 768) {
    await row.getByTestId("stream-dest-menu").click();
    await row.getByTestId(`stream-dest-menu-${which}`).click();
  } else {
    await row.getByTestId(`stream-dest-${which}`).click();
  }
}
/** The Remove dialog: its title names the destination; confirmed with its own label. Returns the dialog's body text. */
async function confirmRemove(page: Page, label: string): Promise<string> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(en("streamDest.confirmRemove.title", { label }));
  const text = (await dialog.textContent()) ?? "";
  await dialog.getByRole("button", { name: en("streamDest.remove"), exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: SAVE_MS });
  return text;
}
/** Add through the form. `opener` is the list's add button, or the empty state's own. */
async function addViaForm(page: Page, d: { platform: StreamPlatform; label: string; key: string; watch?: string }, opener: "stream-dest-add" | "stream-dest-empty-add" = "stream-dest-add"): Promise<Locator> {
  const form = page.getByTestId("stream-dest-form");
  if ((await form.count()) === 0) await page.getByTestId(opener).click();
  await expect(form).toBeVisible();
  await form.getByTestId(`stream-dest-platform-${d.platform}`).click();
  await expect(form.getByTestId(`stream-dest-platform-${d.platform}`)).toHaveAttribute("aria-checked", "true");
  await form.getByTestId("stream-dest-name").fill(d.label);
  await form.getByTestId("stream-dest-key").fill(d.key);
  if (d.watch !== undefined) await form.getByTestId("stream-dest-watch").fill(d.watch);
  await form.getByTestId("stream-dest-save").click();
  return form;
}
async function shot(target: Locator, name: string): Promise<void> {
  await target.screenshot({ path: join(process.env.VISUAL_DIR ?? test.info().outputPath(), name) });
}

// The fixture panel — the picker's side of the sequence (stream-relay.spec.ts's openFixture / openPhoneTab / confirmStop).
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
async function confirmStop(page: Page): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const ok = dialog.getByRole("button", { name: en("stream.phone.stop"), exact: true });
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(dialog).toHaveCount(0, { timeout: POLL_WAIT_MS });
}

/** Every mutation the page sends to the destination routes, by method — a double tap or a locked tap is counted here. */
function mutationLog(page: Page): { method: string; url: string }[] {
  const log: { method: string; url: string }[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && /\/api\/v1\/orgs\/[^/]+\/stream-targets/.test(r.url())) log.push({ method: r.method(), url: r.url() });
  });
  return log;
}

// ===========================================================================
// S — the owner-named sequence, at 320 and 1280
// ===========================================================================
for (const width of [320, 1280] as const) {
  test(`S @${width}: empty → add YouTube → pick it on a match and Go live → Remove and Replace BLOCKED naming the match → Stop → Remove (a double tap sends ONE) → gone from the list AND the picker → re-add the same key restores the SAME destination → Replace key → add Twitch`, async ({
    page,
  }) => {
    const NAVS = 9; // directory ×5, fixture ×3, + the rig's sign-in
    const SAVES = 7; // add, remove, re-add, the A19 repeat, replace, twitch, + go live / stop round trips
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + NAVS * NAV_MS + SAVES * SAVE_MS);
    await page.setViewportSize({ width, height: width < 768 ? 700 : 900 });
    const rig = await seedRig(page, { entrants: 2 });
    const f = rig.fixtures[0]!;
    const log = mutationLog(page);

    // 1. EMPTY.
    let panel = await openStreaming(page);
    await expect(page.getByTestId("stream-dest-empty")).toContainText(en("streamDest.empty"));
    await expect(rows(page)).toHaveCount(0);
    await shot(panel, `S-${width}-1-empty.png`);
    await expectNoHorizontalScroll(page);

    // 2. ADD a YouTube destination, from the empty state's own button.
    const label = `Main court ${rig.tag}`;
    const key = ytKey();
    const form = await addViaForm(page, { platform: "youtube", label, key }, "stream-dest-empty-add");
    await expect(form, "a saved destination closes the form").toHaveCount(0, { timeout: SAVE_MS });
    let list = await listApi(page, rig.orgId);
    expect(list.map((t) => [t.kind, t.label, t.keyHint]), "the API holds the one destination the form saved").toEqual([["youtube", label, hintOf(key)]]);
    const id = list[0]!.id;
    await expect(rowOf(page, id).getByTestId("stream-dest-subline")).toContainText(`…${hintOf(key)}`);

    // 3. PICK it on a match and GO LIVE.
    let body = await openPhoneTab(page, rig, f.no);
    await body.getByTestId("stream-target").selectOption(id);
    await expect(body.getByTestId("stream-target").locator("option:checked")).toContainText(label);
    await streamSlot();
    await body.getByTestId("stream-go-live").click();
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });

    // 4. DIRECTORY: held — the badge names the match and links to it; Replace and Remove are locked, naming it.
    panel = await openStreaming(page);
    let row = rowOf(page, id);
    const badge = row.locator('[data-testid="stream-dest-badge"]:visible');
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveAttribute("data-state", "live");
    await expect(badge).toHaveText(en("streamDest.badge.live", { match: matchName(f.no) }));
    await expect(badge).toHaveAttribute("href", `${rig.divPath}/f/${f.no}`);
    const stopFirst = en("streamDest.stopFirst", { match: matchName(f.no) });
    const before = log.length;
    if (width < 768) {
      await row.getByTestId("stream-dest-menu").click();
      for (const which of ["replace", "remove"] as const) await expect(row.getByTestId(`stream-dest-menu-${which}`)).toHaveAttribute("aria-disabled", "true");
      await expect(row.getByTestId("stream-dest-locked")).toHaveText([stopFirst, stopFirst]);
      await shot(panel, `S-${width}-4-blocked-menu.png`);
      await row.getByTestId("stream-dest-menu-remove").click({ force: true }); // a real tap; `force` only skips Playwright's aria-disabled wait
    } else {
      for (const which of ["replace", "remove"] as const) {
        await expect(row.getByTestId(`stream-dest-${which}`)).toHaveAttribute("aria-disabled", "true");
        await expect(row.getByTestId(`stream-dest-${which}`)).toHaveAttribute("title", stopFirst);
      }
      await shot(panel, `S-${width}-4-blocked.png`);
      await row.getByTestId("stream-dest-remove").click({ force: true }); // a real tap; `force` only skips Playwright's aria-disabled wait
      await row.getByTestId("stream-dest-replace").click({ force: true });
      await expect(row.getByTestId("stream-dest-replace-form"), "a locked Replace opens nothing").toHaveCount(0);
    }
    await expect(page.getByRole("alertdialog"), "a locked Remove asks nothing").toHaveCount(0);
    expect(log.length, "a locked tap sends nothing").toBe(before);
    expect((await listApi(page, rig.orgId)).map((t) => t.id)).toEqual([id]);

    // 5. STOP, on the match.
    body = await openPhoneTab(page, rig, f.no);
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });

    // 6. REMOVE — released after Stop. A DOUBLE TAP (two clicks on one render) asks once and sends ONE DELETE.
    panel = await openStreaming(page);
    row = rowOf(page, id);
    await expect(row.locator('[data-testid="stream-dest-badge"]'), "released: no badge").toHaveCount(0);
    if (width < 768) await row.getByTestId("stream-dest-menu").click();
    const target = row.getByTestId(width < 768 ? "stream-dest-menu-remove" : "stream-dest-remove");
    await expect(target).not.toHaveAttribute("aria-disabled", "true");
    const deletesBefore = log.filter((r) => r.method === "DELETE").length;
    await target.evaluate((b: HTMLElement) => {
      b.click();
      b.click();
    });
    await expect(page.getByRole("alertdialog")).toHaveCount(1);
    const dialogText = await confirmRemove(page, label);
    expect(dialogText, "a platform row says re-adding the key restores it (D2)").toContain(en("streamDest.confirmRemove.body"));
    await expect(rows(page), "the row is gone from the list").toHaveCount(0, { timeout: SAVE_MS });
    expect(log.filter((r) => r.method === "DELETE").length - deletesBefore, "the double tap sent ONE DELETE").toBe(1);
    expect(await listApi(page, rig.orgId), "the API list excludes it").toEqual([]);
    // …and the fixture's picker no longer offers it.
    body = await openPhoneTab(page, rig, f.no);
    // The match reopens on its ENDED card (the latest session); Start another is the way back to the picker.
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
    await body.getByTestId("stream-again").click();
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.idle"));
    await expect(body.getByTestId("stream-target").locator(`option[value="${id}"]`), "gone from the fixture picker").toHaveCount(0);
    await expect(body.getByTestId("stream-dest-empty"), "the org's only destination is gone: the picker's empty state").toBeVisible();

    // 7. RE-ADD the same key under a new name: the SAME destination comes back (D2).
    panel = await openStreaming(page);
    const label2 = `Restored ${rig.tag}`;
    await addViaForm(page, { platform: "youtube", label: label2, key }, "stream-dest-empty-add");
    await expect(form).toHaveCount(0, { timeout: SAVE_MS });
    list = await listApi(page, rig.orgId);
    expect(list.map((t) => [t.id, t.label]), "the SAME id, restored under the new name").toEqual([[id, label2]]);
    await expect(rowOf(page, id)).toContainText(label2);

    // 7b. A19, owner decision (a): the same key AGAIN — now an active destination — under yet another name and a watch
    //     link. Nothing is added and nothing renamed: the form stays open and names the destination holding the key.
    const postsBefore = log.filter((r) => r.method === "POST").length;
    const again = await addViaForm(page, { platform: "youtube", label: `Third name ${rig.tag}`, key, watch: "https://www.youtube.com/@elsewhere" });
    await expect(page.getByTestId("stream-dest-error")).toHaveText(en("streamDest.error.duplicate", { label: label2 }), { timeout: SAVE_MS });
    await expect(again, "the form stays open").toBeVisible();
    expect(log.filter((r) => r.method === "POST").length - postsBefore, "one POST").toBe(1);
    expect((await listApi(page, rig.orgId)).map((t) => [t.id, t.label, t.watchUrl]), "nothing added, nothing renamed, no watch link applied")
      .toEqual([[id, label2, null]]);
    await expect(rows(page)).toHaveCount(1);
    await expectNoHorizontalScroll(page);
    await shot(panel, `fix1-A19-${width}-already-saved.png`);
    await again.getByTestId("stream-dest-cancel").click();
    await expect(again).toHaveCount(0);

    // 8. REPLACE KEY.
    const key2 = ytKey();
    row = rowOf(page, id);
    await tapAction(row, "replace", width);
    await row.getByTestId("stream-dest-replace-input").fill(key2);
    await expect(row.getByTestId("stream-dest-replace-warning"), "a well-formed key draws no warning").toHaveCount(0);
    await row.getByTestId("stream-dest-replace-save").click();
    await expect(row.getByTestId("stream-dest-replace-form")).toHaveCount(0, { timeout: SAVE_MS });
    await expect(row.getByTestId("stream-dest-subline")).toContainText(`…${hintOf(key2)}`);
    expect((await listApi(page, rig.orgId)).find((t) => t.id === id)?.keyHint, "the API's hint is the new key's").toBe(hintOf(key2));

    // 9. ADD TWITCH.
    const tLabel = `Twitch ${rig.tag}`;
    const tKey = twitchKey();
    await addViaForm(page, { platform: "twitch", label: tLabel, key: tKey });
    await expect(form.getByTestId("stream-dest-key-warning")).toHaveCount(0);
    await expect(form).toHaveCount(0, { timeout: SAVE_MS });
    list = await listApi(page, rig.orgId);
    expect(list.map((t) => [t.kind, t.label]), "YouTube (restored) then Twitch, oldest first").toEqual([["youtube", label2], ["twitch", tLabel]]);
    await expect(rows(page)).toHaveCount(2);
    await shot(panel, `S-${width}-9-two-platforms.png`);
    await expectNoHorizontalScroll(page);
  });
}

// ===========================================================================
// 1–4 — the form and the row actions, one org each
// ===========================================================================
test("1: add with the shape warning (it warns, never blocks) and both sides of the key-hint floor; the form offers exactly STREAM_PLATFORMS with no server field", async ({ page }) => {
  const NAVS = 2;
  test.setTimeout(SEED_MS + NAVS * NAV_MS + 3 * SAVE_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const log = mutationLog(page);
  await openStreaming(page);
  await page.getByTestId("stream-dest-empty-add").click();
  const form = page.getByTestId("stream-dest-form");

  // D6: the platforms are the one list's own, in its order, named by brand; no ingest url / server field.
  const radios = form.getByRole("radio");
  expect(STREAM_PLATFORMS.length, "the platform list names platforms").toBeGreaterThan(0);
  await expect(radios).toHaveCount(STREAM_PLATFORMS.length);
  let named = 0;
  for (const [i, p] of STREAM_PLATFORMS.entries()) {
    await expect(radios.nth(i)).toHaveAttribute("data-testid", `stream-dest-platform-${p}`);
    // The accessible name — the brand; the mark beside it is aria-hidden decoration.
    await expect(radios.nth(i)).toHaveAccessibleName(BRAND[p]);
    named++;
  }
  expect(named, "every platform was checked").toBe(STREAM_PLATFORMS.length);
  await expect(form.locator('[data-testid*="server"], [data-testid*="rtmp"]')).toHaveCount(0);

  // A key's NAME where the key belongs: warned, and Save stays enabled.
  const shortKey = "TestYouTube";
  expect(hintOf(shortKey), "premise: below the hint floor").toBeNull();
  await form.getByTestId("stream-dest-name").fill(`Short ${rig.tag}`);
  await form.getByTestId("stream-dest-key").fill(shortKey);
  await expect(form.getByTestId("stream-dest-key-warning")).toHaveText(en("streamDest.shape.youtube"));
  await expect(form.getByTestId("stream-dest-save")).toBeEnabled();
  await shot(form, "1-1280-add-warning.png");
  await form.getByTestId("stream-dest-save").click();
  await expect(form).toHaveCount(0, { timeout: SAVE_MS });
  const [short] = await listApi(page, rig.orgId);
  await expect(rowOf(page, short!.id).getByTestId("stream-dest-subline")).not.toContainText("key ends");
  await expect(rowOf(page, short!.id).getByTestId("stream-dest-subline")).toContainText(en("streamDest.sublineNoHint", { platform: "YouTube", date: "" }).trim());

  // A well-formed key: no warning, and its last three show.
  const longKey = "abcd-1234-efgh-5678-ijkl";
  await addViaForm(page, { platform: "youtube", label: `Long ${rig.tag}`, key: longKey });
  await expect(form.getByTestId("stream-dest-key-warning")).toHaveCount(0);
  await expect(form).toHaveCount(0, { timeout: SAVE_MS });
  const list = await listApi(page, rig.orgId);
  expect(list.map((t) => t.keyHint), "the API's hints: none for the short key, the last three for the long").toEqual([null, "jkl"]);
  await expect(rowOf(page, list[1]!.id).getByTestId("stream-dest-subline")).toContainText("…jkl");
  expect(log.filter((r) => r.method === "POST").length, "one POST per save").toBe(2);
});

test("2: Rename — the new name after the refresh, and in the API", async ({ page }) => {
  test.setTimeout(SEED_MS + 2 * NAV_MS + 2 * SAVE_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const t = await addTargetApi(page, rig.orgId, { label: `Old ${rig.tag}` });
  await openStreaming(page);
  const row = rowOf(page, t.id);
  await row.getByTestId("stream-dest-rename").click();
  await expect(row.getByTestId("stream-dest-rename-input")).toHaveValue(t.label);
  await row.getByTestId("stream-dest-rename-input").fill(`  New ${rig.tag}  `);
  await row.getByTestId("stream-dest-rename-save").click();
  await expect(row.getByTestId("stream-dest-rename-form")).toHaveCount(0, { timeout: SAVE_MS });
  await expect(row).toContainText(`New ${rig.tag}`);
  expect((await listApi(page, rig.orgId)).map((x) => x.label), "trimmed, as the server stores it").toEqual([`New ${rig.tag}`]);
});

test("3: Replace key — the subline and the API hint are the new key's; the same id", async ({ page }) => {
  test.setTimeout(SEED_MS + 2 * NAV_MS + 2 * SAVE_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const t = await addTargetApi(page, rig.orgId, { label: `Cam ${rig.tag}`, streamKey: "abcd-1234-efgh-5678-ijkl" });
  await openStreaming(page);
  const row = rowOf(page, t.id);
  await row.getByTestId("stream-dest-replace").click();
  await row.getByTestId("stream-dest-replace-input").fill("wxyz-9876-abcd-5432-efgh");
  await row.getByTestId("stream-dest-replace-save").click();
  await expect(row.getByTestId("stream-dest-replace-form")).toHaveCount(0, { timeout: SAVE_MS });
  await expect(row.getByTestId("stream-dest-subline")).toContainText("…fgh");
  expect((await listApi(page, rig.orgId)).map((x) => [x.id, x.keyHint])).toEqual([[t.id, "fgh"]]);
});

test("4: Remove — confirmed, the row is gone, the API list excludes it, and a DELETE after it is a 404", async ({ page }) => {
  test.setTimeout(SEED_MS + 2 * NAV_MS + 2 * SAVE_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const t = await addTargetApi(page, rig.orgId, { label: `Gone ${rig.tag}` });
  await openStreaming(page);
  await rowOf(page, t.id).getByTestId("stream-dest-remove").click();
  await confirmRemove(page, t.label);
  await expect(rowOf(page, t.id)).toHaveCount(0, { timeout: SAVE_MS });
  await expect(page.getByTestId("stream-dest-empty")).toBeVisible();
  expect(await listApi(page, rig.orgId)).toEqual([]);
  const again = await page.request.delete(`/api/v1/orgs/${rig.orgId}/stream-targets/${t.id}`);
  expect(again.status(), "an archived destination is not found").toBe(404);
  const [{ archived }] = await withDb((sql) => sql<{ archived: boolean }[]>`select archived_at is not null as archived from org_stream_targets where id = ${t.id}`);
  expect(archived, "D2: Remove ARCHIVES the row").toBe(true);
});

// ===========================================================================
// 5–6 — the in-use lock, and re-add restores
// ===========================================================================
test("5: the in-use lock — WAITING (refused, names the match), then LIVE, then Stop → Remove allowed", async ({ page }) => {
  const NAVS = 4;
  test.setTimeout(Math.max(120_000, SEED_MS + CYCLE_MS + SLOT_WAIT_MS) + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const f = rig.fixtures[0]!;
  const t = await addTargetApi(page, rig.orgId, { label: `Held ${rig.tag}` });
  const log = mutationLog(page);
  await holdWaiting(page, f.id, t.id);
  const [s] = await sessionsOf(rig.orgId);
  expect(["requested", "provisioning", "warming"], `premise: the session is WAITING (got ${s?.state})`).toContain(s?.state);

  await openStreaming(page);
  const row = rowOf(page, t.id);
  const badge = row.locator('[data-testid="stream-dest-badge"]:visible');
  await expect(badge).toHaveAttribute("data-state", "waiting");
  await expect(badge).toHaveText(en("streamDest.badge.waiting", { match: matchName(f.no) }));
  await expect(badge).toHaveAttribute("href", `${rig.divPath}/f/${f.no}`);
  const stopFirst = en("streamDest.stopFirst", { match: matchName(f.no) });
  for (const which of ["replace", "remove"] as const) {
    await expect(row.getByTestId(`stream-dest-${which}`)).toHaveAttribute("aria-disabled", "true");
    await expect(row.getByTestId(`stream-dest-${which}`)).toHaveAttribute("title", stopFirst);
  }
  await expect(row.getByTestId("stream-dest-rename"), "Rename is never locked").not.toHaveAttribute("aria-disabled", "true");
  await row.getByTestId("stream-dest-remove").click({ force: true }); // a real tap; `force` only skips Playwright's aria-disabled wait
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(log, "the locked Remove sent nothing").toEqual([]);
  await expect(row).toHaveCount(1);

  await untilLive(page, f.id);
  await page.reload();
  await expect(row.locator('[data-testid="stream-dest-badge"]:visible')).toHaveAttribute("data-state", "live");
  await expect(row.locator('[data-testid="stream-dest-badge"]:visible')).toHaveText(en("streamDest.badge.live", { match: matchName(f.no) }));

  await stopApi(page, rig.orgId, f.id);
  await page.reload();
  await expect(row.locator('[data-testid="stream-dest-badge"]')).toHaveCount(0);
  await expect(row.getByTestId("stream-dest-remove")).not.toHaveAttribute("aria-disabled", "true");
  await row.getByTestId("stream-dest-remove").click();
  await confirmRemove(page, t.label);
  await expect(row).toHaveCount(0, { timeout: SAVE_MS });
  expect(await listApi(page, rig.orgId)).toEqual([]);
});

test("6: re-add restores — Remove, then add the same key with a new name: the API returns the SAME id with the new name", async ({ page }) => {
  test.setTimeout(SEED_MS + 2 * NAV_MS + 3 * SAVE_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page);
  const key = ytKey();
  const t = await addTargetApi(page, rig.orgId, { label: `First ${rig.tag}`, streamKey: key });
  await openStreaming(page);
  await rowOf(page, t.id).getByTestId("stream-dest-remove").click();
  await confirmRemove(page, t.label);
  await expect(rowOf(page, t.id)).toHaveCount(0, { timeout: SAVE_MS });
  const form = await addViaForm(page, { platform: "youtube", label: `Second ${rig.tag}`, key }, "stream-dest-empty-add");
  await expect(form).toHaveCount(0, { timeout: SAVE_MS });
  expect((await listApi(page, rig.orgId)).map((x) => [x.id, x.label])).toEqual([[t.id, `Second ${rig.tag}`]]);
  await expect(rowOf(page, t.id)).toContainText(`Second ${rig.tag}`);
});

// ===========================================================================
// 7 — the empty state, at every width (the screenshots' empty and add-form states)
// ===========================================================================
test("7: the empty state — the copy and its own Add, which opens the form; captured at 320, 768 and 1280", async ({ page }) => {
  const WIDTHS = [320, 768, 1280] as const;
  test.setTimeout(SEED_MS + WIDTHS.length * 2 * NAV_MS);
  const rig = await seedRig(page);
  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const panel = await openStreaming(page);
    await expect(page.getByTestId("stream-dest-empty")).toContainText(en("streamDest.empty"));
    await expect(page.getByTestId("stream-dest-add"), "the list's own Add waits for a list").toHaveCount(0);
    await shot(panel, `7-${width}-empty.png`);
    await page.getByTestId("stream-dest-empty-add").click();
    const form = page.getByTestId("stream-dest-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("stream-dest-empty-add"), "its Add hides while the form is open").toHaveCount(0);
    await form.getByTestId("stream-dest-key").fill("TestYouTube");
    await expect(form.getByTestId("stream-dest-key-warning")).toBeVisible();
    await shot(panel, `7-${width}-add-warning.png`);
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked, "every width was checked").toBe(WIDTHS.length);
  expect(await listApi(page, rig.orgId), "nothing was saved").toEqual([]);
});

// ===========================================================================
// 8–9 — the phone ⋯ menu, and no horizontal scroll with three rows one held (one slot for both)
// ===========================================================================
test("8+9: three rows (one HELD, one Twitch, one legacy with an unreadable key) — the phone ⋯ menu hit-tested at 320, and no horizontal scroll at 320, 768 and 1280", async ({ page }) => {
  const WIDTHS = [320, 768, 1280] as const;
  test.setTimeout(Math.max(120_000, SEED_MS + CYCLE_MS + SLOT_WAIT_MS) + (WIDTHS.length + 1) * NAV_MS);
  const rig = await seedRig(page, { entrants: 2 });
  const f = rig.fixtures[0]!;
  const held = await addTargetApi(page, rig.orgId, { label: `Centre court ${rig.tag} — a long destination name`, streamKey: ytKey() });
  const tw = await addTargetApi(page, rig.orgId, { label: `Twitch ${rig.tag}`, kind: "twitch", streamKey: twitchKey() });
  // A legacy kind (spec §5.4: stored rows keep listing until removed) whose sealed key will not open.
  const [legacy] = await withDb((sql) => sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${rig.orgId}, 'facebook', ${"Old Facebook " + rig.tag}, '\\x00'::bytea) returning id`);
  await holdWaiting(page, f.id, held.id);

  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const panel = await openStreaming(page);
    await expect(rows(page)).toHaveCount(3);
    await expect(rowOf(page, legacy!.id).locator('[data-platform-mark="facebook"]')).toBeAttached();
    await expect(rowOf(page, legacy!.id).getByTestId("stream-dest-subline")).not.toContainText("key ends");
    await expect(rowOf(page, legacy!.id), "a legacy row never says 'again' (D6)").not.toContainText(/again/i);
    await expectNoHorizontalScroll(page);
    await shot(panel, `9-${width}-list-held.png`);
    checked++;
  }
  expect(checked, "every width was checked").toBe(WIDTHS.length);

  // 8 — at 320×568.
  await page.setViewportSize({ width: 320, height: 568 });
  const panel = await openStreaming(page);
  for (const r of await rows(page).all()) await expect(r.locator('[data-role="stream-dest-actions"]'), "no inline actions on a phone").toBeHidden();
  const row = rowOf(page, held.id);
  const menu = row.getByTestId("stream-dest-menu");
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.width, "⋯ is 44 wide").toBeGreaterThanOrEqual(44);
  expect(box.height, "⋯ is 44 tall").toBeGreaterThanOrEqual(44);
  const hit = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (h === el || el.contains(h));
  });
  expect(hit, "a tap at ⋯'s centre lands on ⋯").toBe(true);
  expect(await tapTargets(panel), "the panel's controls were hit-tested").toBeGreaterThan(3);
  await menu.click();
  await expect(row.getByRole("menuitem")).toHaveCount(3);
  await expect(row.getByTestId("stream-dest-locked")).toHaveText([
    en("streamDest.stopFirst", { match: matchName(f.no) }),
    en("streamDest.stopFirst", { match: matchName(f.no) }),
  ]);
  expect(await tapTargets(row.getByRole("menu")), "the menu's items were hit-tested").toBe(3);
  await shot(panel, "8-320-menu-open.png");
  // The free row's menu: nothing locked.
  await rowOf(page, tw.id).getByTestId("stream-dest-menu").click();
  await expect(rowOf(page, tw.id).getByTestId("stream-dest-locked")).toHaveCount(0);
});

/** The 44-px floor, hit-tested (stream-relay.spec.ts's expectTapTargets). Returns how many it checked. */
async function tapTargets(scope: Locator, min = 44): Promise<number> {
  const handles = await scope.locator("button, a[href], input:not([type=hidden]), [role=radio], [role=menuitem]").all();
  let checked = 0;
  const failures: string[] = [];
  for (const h of handles) {
    if (!(await h.isVisible())) continue;
    await h.scrollIntoViewIfNeeded();
    const res = await h.evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const id = el.dataset.testid ?? `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 30)}`;
      const cx = r.left + r.width / 2;
      const misses = [r.top + r.height / 2, r.top + 2, r.bottom - 2].filter((y) => {
        const hit = document.elementFromPoint(cx, y);
        return !(hit && (hit === el || el.contains(hit)));
      });
      return { id, h: r.height, misses: misses.length };
    });
    checked++;
    if (res.h < min - 0.5) failures.push(`${res.id}: ${res.h.toFixed(1)}px tall`);
    if (res.misses > 0) failures.push(`${res.id}: ${res.misses}/3 hit-test probes landed on something else`);
  }
  expect(failures, "every control reaches the 44-px floor and is really hit there").toEqual([]);
  return checked;
}

// ===========================================================================
// E — every refusal the Directory can meet, from a REAL server response, reads the page's own sentence
// ===========================================================================
test("E: refusals read the page's own copy — a bad watch link, a duplicate key, a destination a match took while the page was open (TARGET_IN_USE), a legacy key that will not open (TARGET_UNREADABLE), and a row a second tab already removed (404: refreshed, no error)", async ({
  page,
}) => {
  const NAVS = 5;
  test.setTimeout(Math.max(120_000, SEED_MS + CYCLE_MS + SLOT_WAIT_MS) + NAVS * NAV_MS + 8 * SAVE_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRig(page, { entrants: 2 });
  const f = rig.fixtures[0]!;
  const errorLine = page.getByTestId("stream-dest-error");
  const keyA = ytKey();
  const a = await addTargetApi(page, rig.orgId, { label: `Alpha ${rig.tag}`, streamKey: keyA });
  const b = await addTargetApi(page, rig.orgId, { label: `Bravo ${rig.tag}` });
  await openStreaming(page);

  // VALIDATION (400, the schema's watchUrl issue): a watch link off the platforms' hosts.
  const form = await addViaForm(page, { platform: "youtube", label: `Watch ${rig.tag}`, key: ytKey(), watch: "https://example.com/x" });
  await expect(errorLine).toHaveText(en("streamDest.error.watch"), { timeout: SAVE_MS });
  await expect(form, "the form stays open to fix it").toBeVisible();
  expect((await listApi(page, rig.orgId)).length, "nothing was saved").toBe(2);
  await form.getByTestId("stream-dest-cancel").click();

  // DESTINATION_DUPLICATE (409): Bravo's key replaced with Alpha's.
  await rowOf(page, b.id).getByTestId("stream-dest-replace").click();
  await rowOf(page, b.id).getByTestId("stream-dest-replace-input").fill(keyA);
  await rowOf(page, b.id).getByTestId("stream-dest-replace-save").click();
  await expect(errorLine).toHaveText(en("streamDest.error.duplicate", { label: a.label }), { timeout: SAVE_MS });
  expect((await listApi(page, rig.orgId)).find((t) => t.id === b.id)?.keyHint, "Bravo's key is unchanged").toBe(b.keyHint);
  await rowOf(page, b.id).getByTestId("stream-dest-replace-cancel").click();

  // 404 (a second tab removed it first): refreshed, never an error.
  const tab2 = await page.context().newPage();
  await tab2.setViewportSize({ width: 1280, height: 900 });
  await openStreaming(tab2);
  await rowOf(page, b.id).getByTestId("stream-dest-remove").click();
  await confirmRemove(page, b.label);
  await expect(rowOf(page, b.id)).toHaveCount(0, { timeout: SAVE_MS });
  await rowOf(tab2, b.id).getByTestId("stream-dest-remove").click();
  await confirmRemove(tab2, b.label);
  await expect(rowOf(tab2, b.id), "the stale tab refreshed the row away").toHaveCount(0, { timeout: SAVE_MS });
  await expect(tab2.getByTestId("stream-dest-error"), "a row already gone is not an error").toHaveCount(0);

  // TARGET_IN_USE (409): tab 2 still shows Alpha free; a match takes it; tab 2's Remove is refused naming the match, and
  // the refusal re-reads the list, so the row locks with its badge.
  await holdWaiting(page, f.id, a.id);
  await rowOf(tab2, a.id).getByTestId("stream-dest-remove").click();
  await confirmRemove(tab2, a.label);
  await expect(tab2.getByTestId("stream-dest-error")).toHaveText(en("streamDest.stopFirst", { match: matchName(f.no) }), { timeout: SAVE_MS });
  await expect(rowOf(tab2, a.id).getByTestId("stream-dest-remove")).toHaveAttribute("aria-disabled", "true", { timeout: SAVE_MS });
  await expect(rowOf(tab2, a.id).locator('[data-testid="stream-dest-badge"]:visible')).toHaveAttribute("data-state", "waiting");
  expect((await listApi(page, rig.orgId)).map((t) => t.id), "Alpha is still there").toContain(a.id);
  await tab2.close();

  // TARGET_UNREADABLE (422) on a legacy kind: Replace key cannot repair it — remove only, never "add it again".
  const [legacy] = await withDb((sql) => sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${rig.orgId}, 'kick', ${"Old Kick " + rig.tag}, '\\x00'::bytea) returning id`);
  const panel = await openStreaming(page);
  const lrow = rowOf(page, legacy!.id);
  await expect(lrow.getByTestId("stream-dest-subline")).toContainText("Kick");
  await lrow.getByTestId("stream-dest-replace").click();
  await lrow.getByTestId("stream-dest-replace-input").fill("anything-at-all-12345");
  await lrow.getByTestId("stream-dest-replace-save").click();
  await expect(errorLine).toHaveText(en("streamDest.error.unreadableLegacy"), { timeout: SAVE_MS });
  await expect(errorLine).not.toContainText(/again/i);
  await shot(panel, "E-1280-unreadable-legacy.png");
  await lrow.getByTestId("stream-dest-replace-cancel").click();
  await lrow.getByTestId("stream-dest-remove").click();
  const body = await confirmRemove(page, `Old Kick ${rig.tag}`);
  expect(body, "a legacy row's Remove says only YouTube and Twitch can be added").toContain(en("streamDest.confirmRemove.bodyLegacy"));
  expect(body).not.toMatch(/again/i);
  await expect(lrow).toHaveCount(0, { timeout: SAVE_MS });
});

// ===========================================================================
// O — a second org
// ===========================================================================
test("O: a second org lists none of the first org's destinations, and cannot rename, replace or remove one", async ({ page }) => {
  test.setTimeout(2 * SEED_MS + 2 * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const first = await seedRig(page);
  const t = await addTargetApi(page, first.orgId, { label: `Mine ${first.tag}` });
  await seedRig(page); // signs the page in as the SECOND org's owner
  await openStreaming(page);
  await expect(page.getByTestId("stream-dest-empty"), "the second org's Directory is empty").toBeVisible();
  await expect(rowOf(page, t.id)).toHaveCount(0);
  const base = `/api/v1/orgs/${first.orgId}/stream-targets`;
  const answers = [
    (await page.request.get(base)).status(),
    (await page.request.patch(`${base}/${t.id}`, { data: { label: "stolen" } })).status(),
    (await page.request.patch(`${base}/${t.id}`, { data: { streamKey: ytKey() } })).status(),
    (await page.request.delete(`${base}/${t.id}`)).status(),
  ];
  expect(answers.filter((s) => s < 400), `every cross-org call is refused (${answers.join(", ")})`).toEqual([]);
  expect(answers.length).toBe(4);
  const [row] = await withDb((sql) => sql<{ label: string; archived: boolean }[]>`
    select label, archived_at is not null as archived from org_stream_targets where id = ${t.id}`);
  expect(row, "the first org's destination is untouched").toEqual({ label: t.label, archived: false });
});

// ===========================================================================
// 10 — the fixture panel's picker, and "Manage destinations" (T8, D1)
// ===========================================================================
for (const width of [320, 768, 1280] as const) {
  test(`10 @${width}: the fixture panel's picker names each destination and its platform, offers no inline add, and 'Manage destinations' opens Directory → Streaming in a NEW tab`, async ({ page }) => {
    const NAVS = 2; // the fixture page, the new tab
    test.setTimeout(SEED_MS + NAVS * NAV_MS + SAVE_MS);
    await page.setViewportSize({ width, height: 900 });
    const rig = await seedRig(page, { entrants: 2 });
    const yt = await addTargetApi(page, rig.orgId, { label: `Court 1 ${rig.tag}` });
    const tw = await addTargetApi(page, rig.orgId, { label: `Twitch ${rig.tag}`, kind: "twitch", streamKey: twitchKey() });
    const body = await openPhoneTab(page, rig, rig.fixtures[0]!.no);
    await expect(body.getByTestId("stream-target").locator("option")).toHaveText([`${yt.label} (${BRAND.youtube})`, `${tw.label} (${BRAND.twitch})`]);
    await expect(body.getByTestId("stream-target-add"), "D1: no inline add").toHaveCount(0);
    await expect(body.locator('input[type="password"]'), "D1: no key field on the match").toHaveCount(0);
    const link = body.getByTestId("stream-manage-destinations");
    await expect(link).toHaveText(en("stream.dest.manage"));
    await expect(link).toHaveAttribute("target", "_blank");
    await expectNoHorizontalScroll(page);
    await shot(page.locator('[data-role="fixture-stream-body"]'), `10-${width}-picker.png`);
    const [tab] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
    await tab.waitForLoadState();
    await expect(tab).toHaveURL(/\/directory\?tab=streaming$/);
    await expect(tab.locator('a[href="/directory?tab=streaming"]'), "the Streaming tab is the current one").toHaveAttribute("aria-current", "page");
    await expect(tab.locator(`[data-testid="stream-dest-row"][data-target-id="${yt.id}"]`)).toBeVisible({ timeout: NAV_MS });
    await tab.close();
  });
}

// ===========================================================================
// I1 (B4 review) — the picker follows Directory WITHOUT a reload. "Manage destinations" opens Directory in a NEW tab
// (D1), so the organiser's round trip — add or remove there, come back — never remounts the match's tab: the return
// itself re-reads the list. Two pages in ONE context (the same signed-in organiser), the order an organiser takes.
// ===========================================================================
/** Back to the match's tab: brought to the front, then the return the browser announces. Headless Chromium keeps every
 *  page "visible", so the `visibilitychange` a real tab switch fires is dispatched here — the listener is the page's own. */
async function returnTo(page: Page): Promise<void> {
  await page.bringToFront();
  const visible = await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  });
  expect(visible, "premise: the page is visible, so its listener acts on the return").toBe("visible");
}

for (const width of [320, 1280] as const) {
  test(`I1 @${width}: no destinations → add in the NEW Directory tab → back: offered, Go live enabled → remove there → back: gone → a choice removed while the tab stayed open: Go live says it was removed and drops it`, async ({ page }) => {
    const NAVS = 3; // the rig's sign-in, the fixture page, the Directory tab
    const SAVES = 5; // add, remove, add, the API remove, the refused Go live
    test.setTimeout(SEED_MS + NAVS * NAV_MS + SAVES * SAVE_MS + 3 * SAVE_MS /* three returns */);
    const height = width < 768 ? 700 : 900;
    await page.setViewportSize({ width, height });
    const rig = await seedRig(page, { entrants: 2 });
    const f = rig.fixtures[0]!;
    const picker = (b: Locator) => b.getByTestId("stream-target");
    const goLive = (b: Locator) => b.getByTestId("stream-go-live");

    // 1. NO destinations: the empty copy, and Go live disabled.
    const body = await openPhoneTab(page, rig, f.no);
    await expect(body.getByTestId("stream-dest-empty")).toHaveText(en("stream.dest.empty"));
    await expect(picker(body)).toHaveCount(0);
    await expect(goLive(body)).toBeDisabled();

    // 2. Manage destinations → Directory in a NEW tab → add one there.
    const [dir] = await Promise.all([page.context().waitForEvent("page"), body.getByTestId("stream-manage-destinations").click()]);
    await dir.setViewportSize({ width, height });
    await dir.waitForLoadState();
    await expect(dir.getByTestId("stream-destinations")).toBeVisible({ timeout: NAV_MS });
    const first = `Court 1 ${rig.tag}`;
    const addForm = await addViaForm(dir, { platform: "youtube", label: first, key: ytKey() }, "stream-dest-empty-add");
    await expect(addForm).toHaveCount(0, { timeout: SAVE_MS });
    const [added] = await listApi(page, rig.orgId);
    expect(added?.label, "the API holds what the Directory tab saved").toBe(first);

    // 3. Back to the match (no reload): the picker offers it, picked, and Go live is enabled.
    await returnTo(page);
    await expect(picker(body).locator("option"), "the return re-read the list").toHaveText([`${first} (${BRAND.youtube})`], { timeout: SAVE_MS });
    await expect(picker(body)).toHaveValue(added!.id);
    await expect(goLive(body)).toBeEnabled();
    await expect(body.getByTestId("stream-dest-empty")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page.locator('[data-role="fixture-stream-body"]'), `fix1-I1-${width}-picker-after-return.png`);

    // 4. Remove it in Directory, come back: gone, and Go live disabled again.
    await dir.bringToFront();
    const row = rowOf(dir, added!.id);
    await tapAction(row, "remove", width);
    await confirmRemove(dir, first);
    await expect(row).toHaveCount(0, { timeout: SAVE_MS });
    await returnTo(page);
    await expect(body.getByTestId("stream-dest-empty"), "the return dropped the removed destination").toBeVisible({ timeout: SAVE_MS });
    await expect(picker(body)).toHaveCount(0);
    await expect(goLive(body)).toBeDisabled();

    // 5. A choice removed while this tab stayed OPEN (another organiser, no return to announce it): picked here, then
    //    Go live answers 404 — the tab says it was removed, re-reads, and drops it. Nothing starts.
    await dir.bringToFront();
    const second = `Court 2 ${rig.tag}`;
    await addViaForm(dir, { platform: "twitch", label: second, key: twitchKey() }, "stream-dest-empty-add");
    await expect(dir.getByTestId("stream-dest-form")).toHaveCount(0, { timeout: SAVE_MS });
    const [b] = await listApi(page, rig.orgId);
    await returnTo(page);
    await expect(picker(body)).toHaveValue(b!.id, { timeout: SAVE_MS });
    const removed = await page.request.delete(`/api/v1/orgs/${rig.orgId}/stream-targets/${b!.id}`);
    expect(removed.status(), "SETUP: removed elsewhere").toBe(200);
    await expect(picker(body), "premise: nothing told this tab yet").toHaveValue(b!.id);
    await goLive(body).click();
    await expect(body.getByTestId("stream-create-error")).toHaveText(en("stream.error.target_removed"), { timeout: SAVE_MS });
    await expect(body.getByTestId("stream-create-error")).not.toHaveText(en("stream.error.unknown"));
    await expect(body.getByTestId("stream-dest-empty"), "the stale choice is gone with it").toBeVisible();
    await expect(goLive(body)).toBeDisabled();
    expect(await sessionsOf(rig.orgId), "nothing started").toEqual([]);
    await expectNoHorizontalScroll(page);
    await shot(page.locator('[data-role="fixture-stream-body"]'), `fix1-I1-${width}-removed.png`);
    await dir.close();
  });
}
