// Streaming R1, lane D — the Phone tab's SESSION LIFECYCLE, walked by hand (owner-approved inventory
// `.superpowers/sdd/2026-09-13-streaming-r1/walkthrough-inventory.md`, File A: A1–A11).
//
// Every case drives a REAL production server on RELAY_DRIVERS=fake: the fake ingest connects a phone
// FAKE_CONNECT_MS after its input is made, exactly as the organiser's own phone would after a scan, and the
// server — never the client — flips warming → live on the tab's own 5-s read. Setup reaches a state by SQL or the
// API (a fresh org, a destination, a session already live for the "Stop is always reachable" cases); the action a
// case is about is TAPPED. Credit assertions read BOTH the page and the ledger (org_stream_credits, summed by
// bucket), and every expected balance is derived from V426's `streaming.credits.monthly` row for the rig's plan
// (setRigPlan), never typed.
//
// Single-sport (generic) by design: the Phone tab, the session lifecycle and the credit ledger are org- and
// fixture-level and read no sport; the only sport-shaped surface on this panel (the OBS preview) is not in scope.
//
// Every rig is a FRESH org of its own: the balance, the monthly grant and every override a case writes
// (streaming.relay / streaming.overlay / competitions.max_active) are ORG-WIDE, and the walkthrough leg runs fully
// parallel — a shared org would let one case's consume move another case's balance (overlay-kit.ts's reasoning).
//
// Existing coverage NOT duplicated here: stream-overlay.spec.ts's community gate + credits card and its
// switched-off state; stream-credits-admin.spec.ts's staff panel. The credit-ledger walkthrough (monthly grant,
// rollover, upgrade, Stripe packs, event passes) is its own file.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
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
  seedVenueWithCourts,
  setBoolEntitlementOverrideSql,
  setEntitlementOverrideSql,
} from "../helpers";
import { grantRigPackCredits, setRigPlan, signInAs } from "../overlay-kit";
import { OUTPUT_WARNING_AFTER_MS, STREAM_POLL_MS } from "../../src/lib/stream-session-view";
import { STREAM_KIND_BRAND } from "../../src/components/v2/stream-platform-mark";
import { STREAM_CREDIT_PACKS } from "../../src/lib/stream-credit-packs";
import {
  FAKE_CONNECT_AFTER_MS_DEFAULT,
  FAKE_CONNECTING_KEY_PREFIX,
  FAKE_REJECT_KEY_PREFIX,
  FakeIngest,
  fakeRecoveringKey,
} from "../../src/server/relay/fakes";
import { MAX_DURATION_MINUTES } from "../../src/server/relay/config";

// ===========================================================================
// Kit (file-local)
// ===========================================================================

/** helpers.ts's withDb is module-private — the stream-credits-admin.spec.ts local copy, same shape. */
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

// Clocks. Every wait is DERIVED from the constants that set the pace — the fake ingest's connect delay and the Phone
// tab's poll — never a flat literal (AGENTS.md class 20): a change to either moves every budget with it.
/** The fake ingest reads "connected" this long after its input was created (server/relay/fakes.ts). A server started
 *  with FAKE_INGEST_CONNECT_AFTER_MS overrides it (CI sets it on the server AND this process, e2e.yml); parsed as
 *  strictly as fakes.ts parses it, so a junk value fails here rather than budgeting from NaN. */
const FAKE_CONNECT_MS = ((): number => {
  const raw = process.env.FAKE_INGEST_CONNECT_AFTER_MS;
  if (raw === undefined) return FAKE_CONNECT_AFTER_MS_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new Error(`FAKE_INGEST_CONNECT_AFTER_MS must be whole milliseconds, got ${JSON.stringify(raw)}`);
  return Number(raw);
})();
const LIVE_WAIT_MS = FAKE_CONNECT_MS + 2 * STREAM_POLL_MS + 5_000;
/** One poll plus slack — a state the next read must already show. */
const POLL_WAIT_MS = STREAM_POLL_MS + 5_000;
/** A seed (SQL org + API competition) plus one page load; the floor under every test's budget. */
const SEED_MS = 60_000;
/** A whole go-live → stop cycle in the browser. */
const CYCLE_MS = LIVE_WAIT_MS + 3 * POLL_WAIT_MS;
/** One fixture-page load, the budget openFixture waits for (spec 2026-09-30 §2: every open is now a full page load where
 *  a run-sheet row's toggle was not). Each case adds `NAVS * NAV_MS`, NAVS counted by reading the case. */
const NAV_MS = 30_000;

// ---------------------------------------------------------------------------
// The deployment's stream capacity. Admission refuses a start once the ingest's storage headroom, after every ACTIVE
// session's max-duration reservation, is below one more reservation (domain/session.ts `admit`: headroom <
// maxDurationMinutes → storage_exhausted). Reservations are counted across the WHOLE deployment, so parallel workers
// going live at once are refused as a storage fault ("Recording storage is full"), not a product one — the first run
// of this file at 4 workers lost A1@320 exactly that way. The capacity is DERIVED from the fake's own storage limit and
// the config's max duration, and handed out as Postgres advisory locks held for the test: keys [BASE, BASE + CAPACITY).
// This file takes ONLY the first CAPACITY − 1 keys, one per case (A5 included); the last key is the credits
// walkthrough's (stream-credits.spec.ts, SLOT_LOCK_BASE + 2 at the fake's capacity of 3 — controller allocation
// 2026-09-29) and is never taken here: streamSlot cannot reach it. Every test stops its streams in teardown, so a red
// case cannot hold a reservation for five hours.
// ---------------------------------------------------------------------------
const STREAM_CAPACITY = Math.floor(new FakeIngest().storage.totalStorageMinutesLimit / MAX_DURATION_MINUTES);
const FILE_SLOTS = STREAM_CAPACITY - 1;
const SLOT_LOCK_BASE = 7_301_130_000;
/** Waiting for a slot: every other holder finishing at most one test's streaming (A3 streams twice). */
const SLOT_WAIT_MS = 3 * CYCLE_MS;

let lease: (() => Promise<void>) | null = null;
const rigsThisTest: { request: APIRequestContext; orgId: string }[] = [];

/** Take ONE of this file's FILE_SLOTS keys before the test's first go-live; held until teardown (a second call in the
 *  same test reuses it). Keys are only ever [BASE, BASE + FILE_SLOTS): the last capacity key is never taken here. */
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
        lease = () => sql.end(); // a session-level advisory lock is released with its connection
        return;
      }
    }
    if (Date.now() > deadline) {
      await sql.end();
      throw new Error(`none of this file's ${FILE_SLOTS} stream slot(s) free after ${SLOT_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Teardown: stop every stream the test's rigs still hold — through the product's own Stop, as the rig's owner — and
 *  force any that will not stop, so a red case never keeps a reservation. Then free the slot. */
async function teardownStreams(): Promise<void> {
  try {
    for (const { request, orgId } of rigsThisTest.splice(0)) {
      const open = await withDb((sql) => sql<{ id: string; fixture_id: string }[]>`
        select id, fixture_id from fixture_stream_sessions where org_id = ${orgId} and state not in ('completed', 'failed')`);
      for (const s of open) await request.post(`/api/v1/fixtures/${s.fixture_id}/stream-sessions/${s.id}/stop`).catch(() => null);
      if (open.length === 0) continue;
      await expect
        .poll(async () => (await sessionsOf({ orgId })).filter((s) => s.state !== "completed" && s.state !== "failed").length, {
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

test.afterEach(async () => {
  await teardownStreams();
});

// Copy, from the dictionaries themselves — never typed here, so a copy edit moves the expectation with it.
type Dict = Record<string, string>;
const readDict = (locale: "en" | "es" | "fr"): Dict =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8")) as Dict;
const EN_UI = readDict("en");
const ES_UI = readDict("es");
const FR_UI = readDict("fr");
function fill(dict: Dict, key: string, vars: Record<string, string | number>): string {
  const raw = dict[key];
  if (raw === undefined) throw new Error(`ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (vars[v] === undefined) throw new Error(`${key}: no value for {${v}}`);
    return String(vars[v]);
  });
}
const en = (key: string, vars: Record<string, string | number> = {}): string => fill(EN_UI, key, vars);
const es = (key: string, vars: Record<string, string | number> = {}): string => fill(ES_UI, key, vars);
const fr = (key: string, vars: Record<string, string | number> = {}): string => fill(FR_UI, key, vars);
/** The balance chip's own words for `n`. */
const creditsChip = (n: number, t: typeof en = en): string =>
  n === 1 ? t("stream.phone.credits.one") : t("stream.phone.credits.other", { n });
/** A pill's text, matched exactly, when either of two states is a correct answer at that instant. */
const eitherPill = (...keys: string[]): RegExp => new RegExp(`^(${keys.map((k) => en(k)).join("|")})$`);

interface RelayFixture { id: string; no: number }
interface RelayRig {
  orgId: string;
  divisionId: string;
  divPath: string;
  fixtures: RelayFixture[];
  /** V426's `streaming.credits.monthly` for the rig's plan — read from plan_entitlements by setRigPlan, never typed:
   *  every balance assertion's expected value. */
  monthlyRate: number;
  tag: string;
}

/**
 * A fresh org on `plan` with ONE generic division of `entrants` entrants and its generated league fixtures, the owner
 * signed in on `page`. NOTHING here reads a fixture page: the monthly grant happens on its first read (R3b),
 * so a case decides when. Seeded on pro (pro's limits build the competition), then moved to `plan` (setRigPlan).
 */
async function seedRelayRig(page: Page, opts: { plan?: string; entrants?: number; names?: string[] } = {}): Promise<RelayRig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+rly-${tag}@resend.dev`;
  const orgSlug = `rly-org-${tag}`;
  const orgId = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"Relay Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"Relay Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return newOrgId;
  });

  await signInAs(page, ownerEmail);
  const request = page.request;
  rigsThisTest.push({ request, orgId });
  const label = `Relay ${tag}`;
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: label,
    visibility: "public",
  });
  if (comp.status >= 300 || !comp.data) throw new Error(`relay rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: label.slice(0, 40),
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  if (div.status >= 300 || !div.data) throw new Error(`relay rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
  const n = opts.entrants ?? 2;
  const ents = await addEntrantsViaApi(request, div.data.id, Array.from({ length: n }, (_, i) => opts.names?.[i] ?? `Side ${String.fromCharCode(65 + i)} ${tag}`));
  if (ents.status >= 300 || ents.ids.length !== n) throw new Error(`relay rig: entrants -> ${ents.status} (${ents.ids.length}/${n})`);
  const { fixtureIds } = await createStageAndGenerate(request, div.data.id);
  // A league of n plays n(n-1)/2 — the rig's own premise, so a generator change cannot hand a case fewer rows than
  // it indexes into.
  expect(fixtureIds.length, "relay rig: a league's fixture count").toBe((n * (n - 1)) / 2);
  const fixtures = await withDb(async (sql) => [
    ...(await sql<RelayFixture[]>`select id, fixture_no as no from fixtures where division_id = ${div.data!.id} order by fixture_no`),
  ]);
  expect(fixtures.map((f) => f.id).sort(), "relay rig: every generated fixture has a run-sheet number").toEqual([...fixtureIds].sort());

  const { monthlyMatchCredits } = await setRigPlan(orgId, opts.plan ?? "pro");
  return { orgId, divisionId: div.data.id, divPath: `/o/${orgSlug}/c/${comp.data.slug}/d/${div.data.slug}`, fixtures, monthlyRate: monthlyMatchCredits, tag };
}

// The ledger, read the way the product reads it (creditBreakdown's sums).
interface LedgerRow { reason: string; bucket: string; delta: number; session_id: string | null }
interface Ledger { monthly: number; pack: number; total: number; rows: LedgerRow[] }
async function ledger(orgId: string): Promise<Ledger> {
  const rows = await withDb(async (sql) => [
    ...(await sql<LedgerRow[]>`
      select reason, bucket, delta, session_id from org_stream_credits where org_id = ${orgId} order by created_at, id`),
  ]);
  const sum = (b: string) => rows.filter((r) => r.bucket === b).reduce((a, r) => a + r.delta, 0);
  const monthly = sum("monthly");
  const pack = sum("pack");
  return { monthly, pack, total: monthly + pack, rows };
}

interface SessionRow {
  id: string; fixture_id: string | null; state: string; fail_reason: string | null; end_reason: string | null;
  started_at: Date | null; ended_at: Date | null;
}
async function sessionsOf(where: { orgId: string } | { fixtureId: string }): Promise<SessionRow[]> {
  return withDb(async (sql) => [
    ...(await ("orgId" in where
      ? sql<SessionRow[]>`
          select id, fixture_id, state, fail_reason, end_reason, started_at, ended_at from fixture_stream_sessions
           where org_id = ${where.orgId} order by created_at`
      : sql<SessionRow[]>`
          select id, fixture_id, state, fail_reason, end_reason, started_at, ended_at from fixture_stream_sessions
           where fixture_id = ${where.fixtureId} order by created_at`)),
  ]);
}
/** The session row a tap just made on this fixture — the newest. */
async function latestSession(fixtureId: string): Promise<SessionRow> {
  const rows = await sessionsOf({ fixtureId });
  expect(rows.length, "the fixture has a session row").toBeGreaterThan(0);
  return rows[rows.length - 1]!;
}

/** SQL setup: bring the MONTHLY bucket down to `keep` with the rollover's own row shape ('expire', monthly) — to reach
 *  "balance N" on a plan whose rate is higher. No-op when it is already there. */
async function drainMonthlyTo(orgId: string, keep: number): Promise<void> {
  const l = await ledger(orgId);
  const excess = l.monthly - keep;
  if (excess <= 0) return;
  await withDb(
    (sql) => sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
                 values (${orgId}, ${-excess}, 'expire', 'monthly', ${l.total - excess}, 'e2e: reach a lower balance')`,
  );
}

/** SETUP: a distinct destination (A19 dedupes on url + key, so the key carries a nonce). D6: the body names a platform,
 *  never a url — the server fills the platform's preset ingest url. */
async function addTargetApi(
  page: Page,
  orgId: string,
  t: { label: string; kind?: "youtube" | "twitch"; streamKey?: string },
): Promise<{ id: string; label: string }> {
  const res = await apiJson<{ id: string; label: string }>(page.request, `/api/v1/orgs/${orgId}/stream-targets`, "POST", {
    kind: t.kind ?? "youtube",
    label: t.label,
    streamKey: t.streamKey ?? `e2e-${randomBytes(6).toString("hex")}`,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`addTargetApi -> ${res.status} ${JSON.stringify(res.error)}`);
  return res.data!;
}

/** The picker's option for a destination (T8): its name and its platform, e.g. "Club (YouTube)". */
const optionText = (label: string, kind: keyof typeof STREAM_KIND_BRAND = "youtube"): string => `${label} (${STREAM_KIND_BRAND[kind]})`;

/** SETUP: a session LIVE through the API — create, then read `current` (the server's tick) until it goes live. */
async function goLiveApi(page: Page, fixtureId: string, targetId: string): Promise<{ id: string }> {
  await streamSlot();
  const made = await apiJson<{ id: string }>(page.request, `/api/v1/fixtures/${fixtureId}/stream-sessions`, "POST", {
    mode: "passthrough",
    targetId,
  });
  if (made.status !== 201 && made.status !== 200) throw new Error(`goLiveApi create -> ${made.status} ${JSON.stringify(made.error)}`);
  let seen: { id: string; state: string } | null = null;
  await expect
    .poll(
      async () => {
        const cur = await apiJson<{ id: string; state: string } | null>(page.request, `/api/v1/fixtures/${fixtureId}/stream-sessions/current`);
        seen = cur.data ?? null;
        return seen?.state;
      },
      { message: "the setup session never went live", timeout: LIVE_WAIT_MS, intervals: [1_000] },
    )
    .toBe("live");
  return { id: seen!.id };
}

/** The fixture's organiser page — where the stream panel lives (spec 2026-09-30 §2). Its loader read GRANTS the month
 *  (R3b), exactly as the division page's did before the move. */
async function openFixture(page: Page, rig: RelayRig, f: RelayFixture, query = ""): Promise<void> {
  await page.goto(`${rig.divPath}/f/${f.no}${query}`);
  await expect(page.locator('[data-role="console-scoring"], [data-role="console-stream"]').first(), `fixture ${f.no}'s console rendered`).toBeAttached({ timeout: 30_000 });
}

/** The division fixtures tab on the filter it MOUNTS on — no filter tapped (B3 fix round 1, I-2): where the run sheet's
 *  chip (T6) shows a session that is up. */
async function openRunSheet(page: Page, rig: RelayRig): Promise<void> {
  await page.goto(`${rig.divPath}?tab=fixtures`);
  await expect(page.locator('[data-testid="run-sheet"]'), "the fixtures tab rendered no run sheet").toHaveCount(1, { timeout: 30_000 });
}
const filterChip = (page: Page, value: string): Locator => page.locator(`[data-testid="run-sheet-filter"] [data-filter="${value}"]`);
const rowOf = (page: Page, f: RelayFixture): Locator => page.locator(`li[data-fixture-no="${f.no}"]`);

/** Where a streamed row's chip sits (B3 fix round 1, owner option a) — the time cell, the entrant-names link, the chip and
 *  the row action, read from the live DOM. Below 768 the chip is on LINE 2 beside the action, and line 1 is the time and
 *  the names alone; at ≥768 the row is the one-line desktop row as it was: time, chip, names, action. */
async function expectChipPlacement(row: Locator, width: number): Promise<void> {
  const g = await row.evaluate((li) => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom };
    };
    const line1 = li.querySelector('[data-row-line="1"]');
    return {
      line1: box(line1),
      time: box(line1?.firstElementChild ?? null),
      names: box(li.querySelector('[data-row-line="1"] a')),
      chip: box(li.querySelector('[data-testid="run-sheet-stream-chip"]')),
      action: box(li.querySelector("[data-row-action]")),
    };
  });
  expect(g.time && g.names && g.chip && g.action && g.line1, `@${width}: every part of the row was found`).toBeTruthy();
  const { time, names, chip, action, line1 } = g as { [k in keyof typeof g]: NonNullable<(typeof g)[k]> };
  const mid = (b: { t: number; b: number }) => (b.t + b.b) / 2;
  if (width < 768) {
    expect(chip.t, `@${width}: the chip is below line 1 (the names)`).toBeGreaterThanOrEqual(names.b - 1);
    expect(mid(chip) >= action.t && mid(chip) <= action.b, `@${width}: the chip sits on the action's line`).toBe(true);
    expect(chip.r, `@${width}: the chip is left of the action`).toBeLessThanOrEqual(action.l + 1);
    expect(names.r, `@${width}: the names run to the end of line 1 — nothing else shares it`).toBeGreaterThanOrEqual(line1.r - 2);
  } else {
    const oneLine = [chip, names, action].every((b) => mid(b) >= time.t - 8 && mid(b) <= time.b + 8);
    expect(oneLine, `@${width}: one desktop line`).toBe(true);
    expect(time.r <= chip.l + 1 && chip.r <= names.l + 1 && names.r <= action.l + 1, `@${width}: time, chip, names, action`).toBe(true);
  }
}

/** The width's own Stream control — the desktop button at ≥768, the strip icon below. Exactly one is visible. */
const streamControl = (page: Page): Locator =>
  page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');

/** Open Stream and the Phone tab — the organiser's own way in. Returns the panel's scope (was: the run-sheet row). */
async function openPhoneTab(page: Page, rig: RelayRig, f: RelayFixture): Promise<Locator> {
  await openFixture(page, rig, f);
  const control = streamControl(page);
  await expect(control, `fixture ${f.no} offers exactly one visible Stream control`).toHaveCount(1, { timeout: 30_000 });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  // The body renders with its tabs in the same commit, so once it is attached a zero count means the stop-only mount.
  await expect(scope, `fixture ${f.no}'s Stream control opened its body`).toBeAttached({ timeout: 30_000 });
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click(); // the stop-only mount has no tabs
  await expect(
    scope.locator('[data-phone-body], [data-testid="stream-stop-probe"], [data-testid="stream-switched-off"]').first(),
  ).toBeAttached({ timeout: 30_000 });
  return scope;
}

/** The Stop dialog: confirm it with its own label (the page's locale) once it is armed. */
async function confirmStop(page: Page, t: typeof en = en): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const ok = dialog.getByRole("button", { name: t("stream.phone.stop"), exact: true });
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(dialog).toHaveCount(0, { timeout: POLL_WAIT_MS });
}

// `summary` (B5 review m-5): a disclosure's toggle is a control a person reaches like any other.
const CONTROLS = "button, a[href], select, input:not([type=hidden]), textarea, summary, [role=radio], [role=tab]";

/** Every visible control inside `scope`, in DOM order, as `testid` (or `tag:text`) — the set a person can reach.
 *  Compared across widths by membership, ORDER and repeats (AGENTS.md "verify with a control-set diff"). */
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

/**
 * The 44-px phone floor, HIT-TESTED (AGENTS.md class 2 — boundingBox measures paint, not what a thumb reaches). For
 * every visible control in `scope`: its box is ≥ `min` tall, and `elementFromPoint` at the centre and 2 px inside the
 * top and bottom edges lands on the control itself (or inside it). Returns how many it checked; callers pin > 0.
 */
async function expectTapTargets(scope: Locator, min = 44): Promise<number> {
  const handles = await scope.locator(CONTROLS).all();
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

/** Screenshots: the visual evidence for the report. `VISUAL_DIR` when a run collects them, else the test's own dir. */
async function shot(target: Locator, name: string): Promise<void> {
  await target.screenshot({ path: join(process.env.VISUAL_DIR ?? test.info().outputPath(), name) });
}

/** A crop of `target` with `pad` px of what surrounds it — for a control too small to read alone (a dot that overhangs
 *  its button, the phone twin's badge on its icon). */
async function shotAround(page: Page, target: Locator, name: string, pad = 24): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  const vp = page.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  await page.screenshot({
    path: join(process.env.VISUAL_DIR ?? test.info().outputPath(), name),
    clip: { x, y, width: Math.min(vp.width, b.x + b.width + pad) - x, height: Math.min(vp.height, b.y + b.height + pad) - y },
  });
}

/** m:ss / h:mm:ss — the ended chip's format (_THEMES.md §8a), computed here from the DB's own instants. */
function duration(startedAt: Date, endedAt: Date): string {
  const total = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : String(m)}:${String(s).padStart(2, "0")}`;
}

const WIDTHS = [320, 768, 1280] as const;

// ===========================================================================
// A1 — the full run, once per width
// ===========================================================================
for (const width of WIDTHS) {
  test(`A1 @${width}: add a destination (in Directory, D1) → pick it → Go live → QR while the camera warms → LIVE (pill, REC, a ticking clock) → Stop → ENDED with its duration and "1 credit used"; the ledger holds one monthly consume`, async ({
    page,
  }) => {
    const NAVS = 3; // openPhoneTab, Directory → Streaming, openPhoneTab again
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 60_000 + NAVS * NAV_MS);
    await page.setViewportSize({ width, height: 900 });
    const rig = await seedRelayRig(page);
    const rate = rig.monthlyRate;
    expect(rate, "V426: the plan grants at least one match a month").toBeGreaterThanOrEqual(1);
    const f = rig.fixtures[0]!;
    const row = await openPhoneTab(page, rig, f);
    const panel = row.getByTestId("stream-panel");
    const body = row.locator("[data-phone-body]");
    await expect(body).toBeAttached();
    const pill = body.getByTestId("stream-state-pill");

    // IDLE. The balance is the monthly grant the page's own read just made (R3b), at the plan's rate.
    await expect(pill).toHaveText(en("stream.phone.state.idle"));
    await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(rate));
    expect((await ledger(rig.orgId)).monthly, "the page's read granted exactly the plan's rate").toBe(rate);
    const goLive = body.getByTestId("stream-go-live");
    await expect(goLive, "no destination yet: Go live is offered but cannot start").toBeDisabled();
    // T8 (D1): no inline add — the empty state, and the way to Directory.
    await expect(body.getByTestId("stream-dest-empty")).toHaveText(en("stream.dest.empty"));
    await expect(body.getByTestId("stream-target"), "no select over nothing").toHaveCount(0);
    await expect(body.getByTestId("stream-target-add"), "D1: no inline add").toHaveCount(0);
    await expect(body.getByTestId("stream-manage-destinations")).toHaveAttribute("href", "/directory?tab=streaming");
    await expect(body.getByTestId("stream-chain"), "§3.2: no destination, no path to draw").toHaveCount(0);
    // §3.1 (T9b): Phone is the default tab, and the disabled "With scorebug — Coming soon" control is gone.
    await expect(row.getByTestId("stream-tab-phone")).toHaveAttribute("aria-selected", "true");
    await expect(body.getByTestId("stream-mode-scorebug")).toHaveCount(0);
    // §2: idle — the Stream control has no dot and reads "Stream".
    await expect(streamControl(page)).not.toHaveAttribute("data-dot", /./);
    await expect(streamControl(page)).toHaveAccessibleName(en("stream.button"));
    await expectNoHorizontalScroll(page);
    // T9b: Manage destinations, Go live and Buy more (the feed-mode radios are gone with the mode itself).
    if (width === 320) expect(await expectTapTargets(body), "idle controls hit-tested").toBeGreaterThanOrEqual(3);
    await shot(panel, `A1-${width}-1-idle.png`);

    // ADD A DESTINATION — in Directory → Streaming (D1: the one place destinations are managed), tapped through its form.
    const label = `YT ${width} ${randomBytes(2).toString("hex")}`;
    await page.goto("/directory?tab=streaming");
    await page.getByTestId("stream-dest-empty-add").click();
    const form = page.getByTestId("stream-dest-form");
    await form.getByTestId("stream-dest-platform-youtube").click();
    await form.getByTestId("stream-dest-name").fill(label);
    await form.getByTestId("stream-dest-key").fill(`e2e-${randomBytes(6).toString("hex")}`);
    if (width === 320) expect(await expectTapTargets(form), "destination form controls hit-tested").toBeGreaterThan(3);
    await form.getByTestId("stream-dest-save").click();
    await expect(form, "a saved destination closes the form").toHaveCount(0, { timeout: POLL_WAIT_MS });
    const saved = await withDb((sql) => sql<{ label: string }[]>`select label from org_stream_targets where org_id = ${rig.orgId}`);
    expect(saved.map((t) => t.label), "the destination row is the one the form saved").toEqual([label]);
    // …and back on the match, the picker offers it, selected.
    await openPhoneTab(page, rig, f);
    await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(label));
    await expect(goLive, "the positive half: with a destination, Go live can start").toBeEnabled();
    const chain = body.getByTestId("stream-chain");
    await expect(chain).toHaveAttribute("data-phone", "notConnected");
    await expect(chain).toHaveAttribute("data-dest", "notLive");

    // GO LIVE → the QR while the camera warms.
    await streamSlot(); // this test's share of the deployment's stream capacity
    await goLive.click();
    await expect(body.getByTestId("stream-qr"), "the QR is drawn in the browser").toBeVisible({ timeout: POLL_WAIT_MS });
    await expect(pill).toHaveText(eitherPill("stream.phone.state.provisioning", "stream.phone.state.warming"));
    // §2: waiting for the phone — the Stream control's dot is amber, still "Stream".
    await expect(streamControl(page)).toHaveAttribute("data-dot", "amber");
    const session = await latestSession(f.id);
    const payload = JSON.parse(await body.getByTestId("stream-qr-text").inputValue()) as { v?: number; sid?: string };
    expect(payload.sid, "the paste code IS the QR payload, for THIS session").toBe(session.id);
    await expect(body.getByTestId("stream-qr")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(chain).toHaveAttribute("data-phone", "waiting");
    await expect(chain).toHaveAttribute("data-link1", "connecting");
    // Everything that reads the QR state goes first — it lasts only until the server's first read after the connect.
    await shot(panel, `A1-${width}-2-qr.png`);
    await expectNoHorizontalScroll(page);
    if (width === 320) expect(await expectTapTargets(body), "QR-state controls hit-tested").toBeGreaterThan(0);
    // One shot, no retry: the checks above measured the QR state, not what came after it.
    await expect(body.getByTestId("stream-qr"), "the QR state outlasted every check made of it").toBeVisible({ timeout: 1 });

    // LIVE — decided by the server on the tab's own poll.
    await expect(pill).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
    // §3.3 (T9b): "On air" and the elapsed clock; the pill is for assistive tech now (the chain shows the state).
    await expect(body.getByTestId("stream-on-air")).toHaveText(en("stream.onAir"));
    await expect(body.getByTestId("stream-on-air")).toBeVisible();
    await expect(body.getByTestId("stream-rec"), "no REC badge in the tab").toHaveCount(0);
    // §2: the Stream button reads the SAME session — red dot and "Live" while live, on whichever twin this width shows.
    await expect(streamControl(page)).toHaveAttribute("data-dot", "red");
    const elapsed = body.getByTestId("stream-elapsed");
    await expect(elapsed).toHaveText(/^\d+:\d{2}$/);
    const first = await elapsed.innerText();
    await expect(elapsed, "the elapsed clock ticks every second while live").not.toHaveText(first, { timeout: 5_000 });
    await expect(body.getByTestId("stream-qr"), "live: the QR is gone").toHaveCount(0);
    // §3.2's live-ok row: every live case here streams to an `ok` destination — the D3 case's positive twin.
    await expect(chain).toHaveAttribute("data-dest", "live");
    await expect(chain).toHaveAttribute("data-link2", "flowing");
    await expect(body.getByTestId("stream-output-warning")).toHaveCount(0);
    // §3.3: the health chips are Details — CLOSED until opened (class 19: what it opens at), then the ingest chip leads.
    const details = body.getByTestId("stream-details");
    await expect(details).toBeAttached();
    await expect(body.getByTestId("stream-health"), "Details opens closed").not.toBeVisible();
    await details.locator("summary").click();
    await expect(body.getByTestId("stream-health")).toBeVisible();
    await expect(body.getByTestId("stream-health-chip").first()).toHaveText(en("stream.health.ingest.connected"));
    // One credit consumed at go-live, drawn from the free monthly bucket (V426), and the chip is the projection's.
    await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(rate - 1));
    const live = await ledger(rig.orgId);
    expect(live.rows.filter((r) => r.reason === "consume"), "exactly one consume, this session's, from the monthly bucket").toEqual([
      expect.objectContaining({ delta: -1, bucket: "monthly", session_id: session.id }),
    ]);
    expect(live.total).toBe(rate - 1);
    await expectNoHorizontalScroll(page);
    if (width === 320) expect(await expectTapTargets(body), "live controls hit-tested").toBeGreaterThan(0);
    await shot(panel, `A1-${width}-3-live.png`);

    // STOP, confirmed.
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(pill).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
    const ended = (await sessionsOf({ fixtureId: f.id })).find((s) => s.id === session.id)!;
    expect(ended, "the row is completed, stopped by the organiser").toMatchObject({ state: "completed", end_reason: "stopped" });
    expect(ended.started_at && ended.ended_at, "a stream that went live has both instants").toBeTruthy();
    await expect(body.getByTestId("stream-ended-duration")).toHaveText(
      en("stream.phone.ended.duration", { duration: duration(ended.started_at!, ended.ended_at!) }),
    );
    await expect(body.getByTestId("stream-credit-used")).toHaveText(en("stream.phone.ended.credits"));
    await expect(body.getByTestId("stream-end-reason")).toHaveText(en("stream.phone.ended.reason.stopped"));
    await expect(body.getByTestId("stream-ended-never-live")).toHaveCount(0);
    await expect(chain, "§3.2: ended draws no chain").toHaveCount(0);
    expect((await ledger(rig.orgId)).total, "stopping spends nothing more").toBe(rate - 1);
    await expectNoHorizontalScroll(page);
    if (width === 320) expect(await expectTapTargets(body), "ended controls hit-tested").toBeGreaterThan(0);
    await shot(panel, `A1-${width}-4-ended.png`);
  });
}

// ===========================================================================
// A2 — which bucket pays: the free monthly credit first, the bought one never before it
// ===========================================================================
test("A2: monthly + 2 bought → Go live draws the MONTHLY credit (monthly − 1, pack still 2) — on the chip, on the split after a reload, and in the ledger", async ({
  page,
}) => {
  const NAVS = 2; // openPhoneTab twice (the reload is the second)
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 30_000 + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRelayRig(page, { plan: "community" });
  const rate = rig.monthlyRate;
  expect(rate, "V426: community grants at least one match").toBeGreaterThanOrEqual(1);
  const bought = 2;
  await grantRigPackCredits(rig.orgId, bought);
  const target = await addTargetApi(page, rig.orgId, { label: "A2 destination" });
  const f = rig.fixtures[0]!;
  let row = await openPhoneTab(page, rig, f);
  let body = row.locator("[data-phone-body]");
  await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(rate + bought));
  // The positive half of the post-go-live split check below: both buckets held → the split is shown.
  await expect(body.getByTestId("stream-credits-split")).toHaveText(en("stream.credits.split", { m: rate, p: bought }));
  await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(target.label));

  await streamSlot(); // this test's share of the deployment's stream capacity
  await body.getByTestId("stream-go-live").click();
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
  await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(rate + bought - 1));

  const after = await ledger(rig.orgId);
  expect({ monthly: after.monthly, pack: after.pack }, "the free credit is spent first; the bought ones are untouched").toEqual({
    monthly: rate - 1,
    pack: bought,
  });
  expect(after.rows.filter((r) => r.reason === "consume").map((r) => r.bucket)).toEqual(["monthly"]);

  // A reload reads the split fresh from the page: it shows only while BOTH buckets hold credits.
  row = await openPhoneTab(page, rig, f);
  body = row.locator("[data-phone-body]");
  await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(rate + bought - 1), { timeout: POLL_WAIT_MS });
  if (rate - 1 > 0) {
    await expect(body.getByTestId("stream-credits-split")).toHaveText(en("stream.credits.split", { m: rate - 1, p: bought }));
  } else {
    // monthly 0 → nothing to split. A pack-first draw would leave "{rate} free · {bought − 1} bought" here instead.
    await expect(body.getByTestId("stream-credits-split")).toHaveCount(0);
  }
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
});

// ===========================================================================
// A3 — the free restart (§5.2): stopped, restarted within the window, nothing more spent — at balance 0 AND with
// credits left (the window must waive the spend, not merely the balance gate)
// ===========================================================================
const A3_BALANCES = [
  // One credit to spend (SQL setup drains the month to 1), so the restart happens at balance 0.
  { id: "at balance 0", plan: "community", drainTo: 1 },
  // The plan's whole month, so the restart happens with credits left — a restart that consumed would show it here.
  { id: "with credits left", plan: "pro", drainTo: null },
] as const;

for (const v of A3_BALANCES) {
  test(`A3 (${v.id}): a stopped match restarts FREE inside the reuse window — the restart line shows and Go live stays (no forced chooser), it goes live again, the balance chip does not move, and the ledger still holds ONE consume`, async ({
    page,
  }) => {
    const NAVS = 2; // openFixture (the grant) + openPhoneTab
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + 2 * CYCLE_MS + 30_000 + NAVS * NAV_MS);
    await page.setViewportSize({ width: 1280, height: 900 });
    const rig = await seedRelayRig(page, { plan: v.plan });
    const target = await addTargetApi(page, rig.orgId, { label: "A3 destination" });
    const f = rig.fixtures[0]!;
    await openFixture(page, rig, f); // the fixture page's read grants the month
    if (v.drainTo !== null) await drainMonthlyTo(rig.orgId, v.drainTo);
    const start = v.drainTo ?? rig.monthlyRate;
    const left = start - 1; // after the first run's one consume
    if (v.drainTo === null) expect(left, "premise: the plan's month leaves credits after one match").toBeGreaterThanOrEqual(1);
    expect((await ledger(rig.orgId)).total, "premise: the credits held before the first run").toBe(start);
    const row = await openPhoneTab(page, rig, f);
    const body = row.locator("[data-phone-body]");
    const pill = body.getByTestId("stream-state-pill");
    const chip = body.getByTestId("stream-balance");
    const expectChip = async (n: number, why: string) => {
      if (n >= 1) await expect(chip, why).toHaveText(creditsChip(n));
      else await expect(chip, `${why} (balance 0: no chip)`).toHaveCount(0);
    };
    await expectChip(start, "before the first run");
    await expect(body.getByTestId("stream-restart-free"), "nothing consumed yet → no reuse window, no restart line").toHaveCount(0);
    await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(target.label));

    // First run: go live (one credit), stop.
    await streamSlot(); // this test's share of the deployment's stream capacity
    await body.getByTestId("stream-go-live").click();
    await expect(pill).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
    await expectChip(left, "the first run spent one credit");
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(pill).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
    await expect(body.getByTestId("stream-credit-used"), "the first run spent the credit").toHaveText(en("stream.phone.ended.credits"));
    const firstSession = await latestSession(f.id);
    expect((await ledger(rig.orgId)).total, "premise: one credit spent").toBe(left);

    // Start another → idle INSIDE the window: the restart line, and Go live — not the forced chooser.
    await body.getByTestId("stream-again").click();
    await expect(pill).toHaveText(en("stream.phone.state.idle"));
    await expect(body.getByTestId("stream-restart-free")).toHaveText(en("stream.phone.restartFree"));
    await expect(body.locator('[data-testid^="stream-buy-pack-"]'), "no forced chooser inside the reuse window").toHaveCount(0);
    const goLive = body.getByTestId("stream-go-live");
    await expect(goLive).toBeEnabled();
    await expectChip(left, "idle again, nothing more spent");
    await shot(row.getByTestId("stream-panel"), `A3-restart-free-${left === 0 ? "at-0" : "credits-left"}.png`);

    // Second run: live again, free.
    await goLive.click();
    await expect(pill).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
    await expectChip(left, "the restart is live and the chip has not moved");
    const second = await latestSession(f.id);
    expect(second.id, "the restart is a NEW session on the same fixture").not.toBe(firstSession.id);
    const l = await ledger(rig.orgId);
    expect(l.rows.filter((r) => r.reason === "consume"), "still ONE consume — the first run's").toEqual([
      expect.objectContaining({ session_id: firstSession.id, delta: -1 }),
    ]);
    expect(l.total, "the restart spent nothing").toBe(left);
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(pill).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
    // D3: a restart used nothing, so its ended card claims no credit (the first card's chip above is the positive half).
    await expect(body.getByTestId("stream-ended-duration")).toBeVisible();
    await expect(body.getByTestId("stream-credit-used")).toHaveCount(0);
  });
}

// ===========================================================================
// A4 — no credits and no window: the chooser, and no way to Go live
// ===========================================================================
test("A4: balance 0 with the reuse window CLOSED → the forced credits chooser and no Go live; the same org's fixture that just streamed (window open) still offers Go live", async ({
  page,
}) => {
  const NAVS = 4; // openFixture (the grant) + three openPhoneTab
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + POLL_WAIT_MS + 30_000 + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRelayRig(page, { plan: "community", entrants: 3 });
  const target = await addTargetApi(page, rig.orgId, { label: "A4 destination" });
  const [played, fresh] = rig.fixtures as [RelayFixture, RelayFixture];
  await openFixture(page, rig, played); // the fixture page's read grants the month
  await drainMonthlyTo(rig.orgId, 1);
  // SETUP: spend the last credit on `played` and stop it.
  const live = await goLiveApi(page, played.id, target.id);
  const stop = await page.request.post(`/api/v1/fixtures/${played.id}/stream-sessions/${live.id}/stop`);
  expect(stop.status(), "setup stop").toBeLessThan(300);
  expect((await ledger(rig.orgId)).total, "premise: balance 0").toBe(0);

  // The fresh fixture: nothing to restart, nothing to spend.
  const row = await openPhoneTab(page, rig, fresh);
  const body = row.locator("[data-phone-body]");
  const tiles = body.locator('[data-testid^="stream-buy-pack-"]');
  // The tiles are the pack catalogue's own (lib/stream-credit-packs.ts), in its order — never a count typed here.
  expect(STREAM_CREDIT_PACKS.length, "the catalogue sells packs").toBeGreaterThan(0);
  await expect(tiles).toHaveCount(STREAM_CREDIT_PACKS.length);
  expect(
    await tiles.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid"))),
    "one tile per catalogue pack, in the catalogue's order",
  ).toEqual(STREAM_CREDIT_PACKS.map((p) => `stream-buy-pack-${p.size}`));
  await expect(body.getByTestId("stream-credits-monthly")).toHaveText(
    rig.monthlyRate === 1 ? en("stream.credits.monthlyNote.one") : en("stream.credits.monthlyNote.other", { n: rig.monthlyRate }),
  );
  await expect(body.getByTestId("stream-go-live")).toHaveCount(0);
  await expect(body.getByTestId("stream-target")).toHaveCount(0);
  await expect(body.getByTestId("stream-state-pill"), "credits-only: no Ready pill").toHaveCount(0);
  await expect(body.getByTestId("stream-credits-close"), "a forced chooser has nothing behind it to close to").toHaveCount(0);
  await expect(body.getByTestId("stream-balance")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(row.getByTestId("stream-panel"), "A4-forced-chooser.png");

  // The positive half, same org, same balance 0: the fixture that just streamed is inside its window.
  const playedRow = await openPhoneTab(page, rig, played);
  const playedBody = playedRow.locator("[data-phone-body]");
  // `current` answers the finished session; Start another puts the tab back to idle.
  await playedBody.getByTestId("stream-again").click();
  await expect(playedBody.getByTestId("stream-go-live")).toBeEnabled();
  await expect(playedBody.getByTestId("stream-restart-free")).toBeVisible();
  await expect(playedBody.locator('[data-testid^="stream-buy-pack-"]')).toHaveCount(0);

  // Close's positive half: with a credit the chooser is not forced — Buy more opens it, and an OPENED chooser has Close.
  await grantRigPackCredits(rig.orgId, 1);
  const again = (await openPhoneTab(page, rig, fresh)).locator("[data-phone-body]");
  await expect(again.getByTestId("stream-balance"), "a bought credit: balance 1").toHaveText(creditsChip(1));
  await expect(again.getByTestId("stream-go-live"), "not forced: Go live is back").toBeEnabled();
  await expect(again.locator('[data-testid^="stream-buy-pack-"]'), "not forced: no chooser until asked").toHaveCount(0);
  await again.getByTestId("stream-buy-more").click();
  await expect(again.locator('[data-testid^="stream-buy-pack-"]')).toHaveCount(STREAM_CREDIT_PACKS.length);
  const close = again.getByTestId("stream-credits-close");
  await expect(close, "an opened chooser says how to put it away").toHaveText(en("stream.credits.close"));
  await close.click();
  await expect(again.locator('[data-testid^="stream-buy-pack-"]'), "Close hands the controls back").toHaveCount(0);
  await expect(again.getByTestId("stream-go-live")).toBeEnabled();
});

// ===========================================================================
// A5 — a second tab tries to start what is already running
// ===========================================================================
test("A5: a SECOND TAB taps Go live — on the same match it is refused active_session and shows the running stream; on another match with the same destination it is refused target_in_use naming the match and its court; ONE session row either way", async ({
  page,
}) => {
  const NAVS = 4; // openPhoneTab on each tab, then tab 2's second match, then the Open Match link
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 60_000 + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRelayRig(page, { entrants: 3 });
  const target = await addTargetApi(page, rig.orgId, { label: "A5 destination" });
  const [f1, f2] = rig.fixtures as [RelayFixture, RelayFixture];
  const courtName = `Centre Court ${rig.tag}`;
  const { courts } = await seedVenueWithCourts(page.request, [courtName], { orgId: rig.orgId });
  expect(courts.length, "setup: one court").toBe(1);
  await withDb((sql) => sql`update fixtures set court_id = ${courts[0]!.id} where id = ${f1.id}`);

  // Both tabs open on f1, idle.
  const tab2 = await page.context().newPage();
  await tab2.setViewportSize({ width: 1280, height: 900 });
  const body1 = (await openPhoneTab(page, rig, f1)).locator("[data-phone-body]");
  const body2 = (await openPhoneTab(tab2, rig, f1)).locator("[data-phone-body]");
  await expect(body2.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.idle"));

  // ONE slot, like every other case: the refused starts need no room. Since F-A5 (owner ruling 2026-09-29) admission
  // answers a fixture's own running stream straight after the plan gates, so the double start below reads "already
  // running" however full the deployment is; target_in_use is decided before admission altogether. (The order itself
  // is pinned by domain/__tests__/session.test.ts — reaching storage_exhausted here would mean filling the deployment,
  // which needs stream-credits.spec.ts's key too.)
  await streamSlot();
  await body1.getByTestId("stream-go-live").click();
  // Any running state will do — the double start is the subject, not the QR. (Under heavy load the create plus the
  // tab's first read can outlast FAKE_CONNECT_MS, and the tab then shows LIVE without ever drawing the QR.)
  await expect(body1.getByTestId("stream-state-pill")).toHaveText(
    eitherPill("stream.phone.state.provisioning", "stream.phone.state.warming", "stream.phone.state.live"),
    { timeout: POLL_WAIT_MS },
  );
  expect((await sessionsOf({ fixtureId: f1.id })).length, "tab 1's tap made the session").toBe(1);
  // Tab 2 still shows idle (idle does not poll), and its tap is the double start.
  await expect(body2.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.idle"));
  await body2.getByTestId("stream-go-live").click();
  await expect(body2.getByTestId("stream-create-error")).toHaveText(en("stream.error.active_session"));
  // …and the refusal's read shows the stream that IS running, not a second one.
  await expect(body2.getByTestId("stream-state-pill")).toHaveText(
    eitherPill("stream.phone.state.provisioning", "stream.phone.state.warming", "stream.phone.state.live"),
  );
  expect((await sessionsOf({ fixtureId: f1.id })).length, "ONE session row on the fixture").toBe(1);

  // Another match, the SAME destination, while f1 holds it.
  const row3 = await openPhoneTab(tab2, rig, f2);
  const body3 = row3.locator("[data-phone-body]");
  await expect(body3.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(target.label));
  await body3.getByTestId("stream-go-live").click();
  // T3 (spec §3.3, §5.5): the refusal names the MATCH and its court — f1's own number through the locale's
  // breadcrumb.match — and says whether f1's phone is live or still awaited. f1 may be in either state at this instant
  // (the create above does not wait for live), so either full sentence is right; nothing else is.
  const f1Match = en("stream.inUse.matchCourt", { match: en("breadcrumb.match", { no: f1.no }), court: courtName });
  const inUse = [en("stream.inUse.live", { label: target.label, match: f1Match }), en("stream.inUse.waiting", { label: target.label, match: f1Match })];
  const escaped = inUse.map((t) => t.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"));
  await expect(body3.getByTestId("stream-create-error")).toHaveText(new RegExp(`^(${escaped.join("|")})$`));
  await expect(body3.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.idle"));
  const all = await sessionsOf({ orgId: rig.orgId });
  expect(all.map((s) => s.fixture_id), "ONE session in the org — f1's; the refused start wrote nothing").toEqual([f1.id]);
  await shot(row3.getByTestId("stream-panel"), "A5-target-in-use.png");
  // T8: the refusal links the holding match's page — tapped, it lands on f1 with its Stream control.
  const open = body3.getByTestId("stream-in-use-open");
  await expect(open).toHaveText(en("stream.inUse.open", { match: en("breadcrumb.match", { no: f1.no }) }));
  await expect(open).toHaveAttribute("href", `${rig.divPath}/f/${f1.no}`);
  await open.click();
  await tab2.waitForURL((u) => u.pathname === `${rig.divPath}/f/${f1.no}`, { timeout: NAV_MS });
  await expect(streamControl(tab2), "the holding match's page offers its Stream control").toHaveCount(1, { timeout: NAV_MS });
  await tab2.close();

  // Tidy: tab 1 stops its own stream once it is live.
  await expect(body1.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
  await body1.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(body1.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
});

// ===========================================================================
// A6 — a destination that refuses the stream: FAILED, its reason, and a way back
// ===========================================================================
test("A6: a destination that refuses the stream key → FAILED with the target_rejected reason and Try again; no credit spent; Try again returns to a startable tab", async ({
  page,
}) => {
  const NAVS = 1; // openPhoneTab
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 30_000 + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRelayRig(page);
  // A stream KEY the FAKE ingest reports as rejecting the output — its scripted refusal (server/relay/fakes.ts
  // `outputState`: a key starting FAKE_REJECT_KEY_PREFIX; D6 made the url a server preset, so no host can carry it).
  // The literal is fakes.ts FAKE_REJECT_KEY_PREFIX: an e2e file cannot import server code. The real ingest reports the
  // same output state when a platform refuses the key.
  const FAKE_REJECT_KEY_PREFIX = "reject-";
  const target = await addTargetApi(page, rig.orgId, {
    label: "A6 refused", kind: "youtube", streamKey: `${FAKE_REJECT_KEY_PREFIX}${randomBytes(6).toString("hex")}`,
  });
  const f = rig.fixtures[0]!;
  const row = await openPhoneTab(page, rig, f);
  const body = row.locator("[data-phone-body]");
  await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(rig.monthlyRate));
  await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(target.label));

  await streamSlot(); // this test's share of the deployment's stream capacity
  await body.getByTestId("stream-go-live").click();
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.failed"), { timeout: LIVE_WAIT_MS });
  await expect(body.getByTestId("stream-fail-reason")).toHaveText(en("stream.fail.target_rejected"));
  const s = await latestSession(f.id);
  expect(s, "the row failed for the destination").toMatchObject({ state: "failed", fail_reason: "target_rejected" });
  const l = await ledger(rig.orgId);
  const net = l.rows.filter((r) => r.session_id === s.id).reduce((a, r) => a + r.delta, 0);
  expect(net, "a stream the destination refused costs nothing, net").toBe(0);
  expect(l.total).toBe(rig.monthlyRate);
  await expectNoHorizontalScroll(page);
  await shot(row.getByTestId("stream-panel"), "A6-failed.png");

  await body.getByTestId("stream-retry").click();
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.idle"));
  await expect(body.getByTestId("stream-fail-reason")).toHaveCount(0);
  await expect(body.getByTestId("stream-go-live")).toBeEnabled();
  await expect(body.getByTestId("stream-balance")).toHaveText(creditsChip(rig.monthlyRate));
});

// ===========================================================================
// D3 — the destination not receiving while live (spec 2026-09-30 §3.2, §9.4; the round-1 regression)
// ===========================================================================
// The Signal path through a whole live session whose destination does not receive at first: the phone connects, the
// destination dials (Connecting) — and at the 30 s line, not before, the amber warning shows with the stream STILL LIVE
// and Stop one tap away (D3: a warning, never an ending). Then the destination starts receiving and the warning clears,
// and Stop ends it. The fake decides when the destination receives: `fakeRecoveringKey` (server/relay/fakes.ts) reads
// `connecting` for RECOVER_MS after the input connects, then `ok` — no test-only route, no sleep. Every wait below is
// derived from OUTPUT_WARNING_AFTER_MS, the poll and the fake's connect (AGENTS.md class 20).
/** The destination receives this long after the phone connects. Live is at most one poll plus slack after the connect,
 *  so the warning holds from (live + 30 s) to (connect + RECOVER_MS): at least RECOVER_MS − 30 s − POLL_WAIT_MS of
 *  window, which is two whole polls — the warning is observed on screen, never inferred. */
const RECOVER_MS = OUTPUT_WARNING_AFTER_MS + 2 * POLL_WAIT_MS + 2 * STREAM_POLL_MS;
/** An answer from `current` is on screen well inside a fifth of a poll (a render, not a network trip). */
const RENDER_MS = STREAM_POLL_MS / 5;
/** "Just before the line": the last two polls under OUTPUT_WARNING_AFTER_MS. */
const NEAR_LINE_MS = OUTPUT_WARNING_AFTER_MS - 2 * STREAM_POLL_MS;
/** One `current` answer as the page received it — the SERVER's own measure of the destination (M6). */
interface CurrentAnswer { at: number; live: boolean; notOk: boolean; elapsedMs: number | null }
/** Records every answer the page gets from this fixture's `current`, with the moment it landed. */
function recordCurrentAnswers(page: Page, fixtureId: string): CurrentAnswer[] {
  const answers: CurrentAnswer[] = [];
  page.on("response", (r) => {
    if (r.request().method() !== "GET" || !new URL(r.url()).pathname.endsWith(`/fixtures/${fixtureId}/stream-sessions/current`)) return;
    void r
      .json()
      .then((j: { data?: { state?: string; output?: { state: string; elapsedMs: number } | null } | null }) => {
        const v = j.data ?? null;
        answers.push({
          at: Date.now(),
          live: v?.state === "live",
          notOk: !!v?.output && v.output.state !== "ok",
          elapsedMs: v?.output?.elapsedMs ?? null,
        });
      })
      .catch(() => {});
  });
  return answers;
}
const atTheLine = (a: CurrentAnswer): boolean =>
  a.live && a.notOk && a.elapsedMs !== null && a.elapsedMs >= OUTPUT_WARNING_AFTER_MS;
for (const width of [320, 1280] as const) {
  test(`D3 @${width}: live, the destination Connecting → at 30 s (not before) the amber warning, still live, Stop enabled → receiving resumes and it clears → Stop`, async ({
    page,
  }) => {
    const NAVS = 1; // openPhoneTab
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + LIVE_WAIT_MS + RECOVER_MS + 4 * POLL_WAIT_MS + NAVS * NAV_MS);
    await page.setViewportSize({ width, height: 900 });
    const rig = await seedRelayRig(page);
    const target = await addTargetApi(page, rig.orgId, {
      label: `D3 ${width}`, kind: "youtube", streamKey: fakeRecoveringKey(RECOVER_MS, randomBytes(6).toString("hex")),
    });
    const f = rig.fixtures[0]!;
    const answers = recordCurrentAnswers(page, f.id);
    const scope = await openPhoneTab(page, rig, f);
    const body = scope.locator("[data-phone-body]");
    const panel = scope.getByTestId("stream-panel");
    const chain = body.getByTestId("stream-chain");
    const warning = body.getByTestId("stream-output-warning");
    await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(target.label));
    // READY: the chain is drawn to the picked destination — all slate (§3.2's idle row).
    await expect(chain).toHaveAttribute("data-phone", "notConnected");
    await expect(chain).toHaveAttribute("data-dest", "notLive");

    await streamSlot();
    await body.getByTestId("stream-go-live").click();
    // WAITING: the phone half amber, link 1 animated — the phone connecting.
    await expect(chain).toHaveAttribute("data-phone", "waiting", { timeout: POLL_WAIT_MS });
    await expect(chain).toHaveAttribute("data-link1", "connecting");
    await expect(chain).toHaveAttribute("data-dest", "notLive");

    // LIVE: the phone and Seazn lime, the destination still dialling — Connecting, no warning yet.
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
    await expect(chain).toHaveAttribute("data-phone", "connected");
    await expect(chain).toHaveAttribute("data-link1", "flowing");
    await expect(chain).toHaveAttribute("data-dest", "connecting");
    await expect(chain).toHaveAttribute("data-link2", "connecting");
    await expect(warning, "under the 30 s line: no warning").toHaveCount(0);
    // §2: the Stream button reads the same session — red while live and the destination still inside its 30 s.
    const control = streamControl(page);
    await expect(control).toHaveAttribute("data-dot", "red");
    await shot(panel, `D3-${width}-1-connecting.png`);
    // The Stream control itself (B5 review m-10): the desktop button at 1280, the phone header's Video icon + badge at 320.
    await shotAround(page, control, `D3-${width}-button-1-red.png`);

    // THE 30 s LINE, both sides of it, on the SERVER's measure (M6: `output.elapsedMs` in each answer; the browser's
    // clock decides nothing). The page may warn only on an answer AT or past the line. So, sampled every RENDER_MS
    // until the first such answer lands: while every answer so far is under the line, the warning is ABSENT — and at
    // least one sample must see the last polls under it (elapsed in [NEAR_LINE_MS, line)) already on screen, so the
    // hold reaches the boundary instead of ending early. Then the first answer at the line puts it on screen within a
    // poll. A lowered threshold warns on an under-the-line answer, and reds the hold (B5 review I-2).
    const early: string[] = [];
    let nearSamples = 0;
    let samples = 0;
    await expect
      .poll(
        async () => {
          if (answers.some(atTheLine)) return true;
          const now = Date.now();
          const shown = await warning.count();
          samples++;
          if (shown > 0) {
            // The answer that drew it may still be parsing on this side: give it a render's time before calling it early.
            await page.waitForTimeout(RENDER_MS);
            if (answers.some(atTheLine)) return true;
            early.push(`on screen with every answer under the line (latest ${answers.at(-1)?.elapsedMs ?? "none"} ms)`);
            return false;
          }
          const onScreen = answers.filter((x) => x.at <= now - RENDER_MS).at(-1);
          if (onScreen?.live && onScreen.notOk && onScreen.elapsedMs !== null && onScreen.elapsedMs >= NEAR_LINE_MS) nearSamples++;
          return false;
        },
        { message: "no answer reached the 30 s line", timeout: OUTPUT_WARNING_AFTER_MS + 2 * POLL_WAIT_MS, intervals: [RENDER_MS] },
      )
      .toBe(true);
    const under = answers.filter((x) => x.live && !atTheLine(x)).map((x) => x.elapsedMs);
    test.info().annotations.push({ type: "d3-line", description: `@${width}: ${samples} samples, ${nearSamples} near the line; live answers under it: ${JSON.stringify(under)}` });
    expect(early, "the warning did not show before the 30 s line").toEqual([]);
    expect(nearSamples, "the hold saw the last polls under the line ON SCREEN (zero would be a hold that ended early)").toBeGreaterThan(0);
    await expect(warning, "the first answer at the line puts the warning on screen").toHaveCount(1, { timeout: POLL_WAIT_MS });
    await expect(warning).toBeVisible();
    await expect(warning).toHaveAttribute("role", "status");
    await expect(warning).toContainText(en("stream.output.warning", { platform: STREAM_KIND_BRAND.youtube }));
    await expect(chain).toHaveAttribute("data-dest", "notReceiving");
    await expect(chain).toHaveAttribute("data-link2", "problem");
    // §2: D3 turns the Stream button's dot amber; it still reads "Live" (desktop text, or the phone twin's name).
    await expect(control).toHaveAttribute("data-dot", "amber");
    await expect(control).toHaveAccessibleName(en("stream.buttonLive"));
    await shotAround(page, control, `D3-${width}-button-2-amber.png`);
    await expect(chain, "the phone half never moves for the destination").toHaveAttribute("data-phone", "connected");
    const open = warning.getByTestId("stream-output-open-directory");
    await expect(open).toHaveAttribute("href", "/directory?tab=streaming");
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveText(en("stream.output.openDirectory"));
    // D3: a warning, never an ending — the session is live on the server, and Stop is right there.
    const cur = await apiJson<{ state: string } | null>(page.request, `/api/v1/fixtures/${f.id}/stream-sessions/current`);
    expect(cur.data?.state, "still live on the server: no auto-end").toBe("live");
    await expect(body.getByTestId("stream-stop")).toBeVisible();
    await expect(body.getByTestId("stream-stop")).toBeEnabled();
    await expectNoHorizontalScroll(page);
    if (width === 320) expect(await expectTapTargets(body), "warned-state controls hit-tested").toBeGreaterThan(1);
    await shot(panel, `D3-${width}-2-warning.png`);

    // RECEIVING RESUMES: the destination accepts; the next read is ok — the warning clears, the destination is Live.
    await expect(warning, "the warning clears once the destination receives").toHaveCount(0, {
      timeout: RECOVER_MS - OUTPUT_WARNING_AFTER_MS + 2 * POLL_WAIT_MS,
    });
    await expect(chain).toHaveAttribute("data-dest", "live");
    await expect(chain).toHaveAttribute("data-link2", "flowing");
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"));
    await expect(control, "receiving again: the dot is red again").toHaveAttribute("data-dot", "red");
    await shot(panel, `D3-${width}-3-receiving.png`);

    // STOP.
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
    await expect(warning).toHaveCount(0);
    await expect(chain, "ended draws no chain (§3.2)").toHaveCount(0);
    // §2: over — no dot, and the control is "Stream" again.
    await expect(control).not.toHaveAttribute("data-dot", /./);
    await expect(control).toHaveAccessibleName(en("stream.button"));
    await shotAround(page, control, `D3-${width}-button-3-none.png`);
  });
}

// ===========================================================================
// A1b — ONE `current` poller per fixture page (spec §2, T9b), counted in the browser
// ===========================================================================
// Review #21: the node harness renders no effects, so only a browser can count. The page is opened ON a live session —
// the organiser coming back to the match — so EVERY reader (the provider, both Stream twins, the Phone tab) mounts on a
// session that polls: a reader that mounted on an idle fixture never polls, whoever owns it, so a second poller is
// invisible on the page that tapped Go live (B5: the mutant `enabled: true` survived a window counted there).
/** The witness's window, in poll periods (T9b brief: K = 4). */
const POLLER_K = 4;
for (const width of [320, 1280] as const) {
  test(`A1b @${width}: a fixture page opened on a LIVE session runs ONE current poll — the Stream control, both twins and the Phone tab read it — and it stops when the stream ends`, async ({
    page,
  }) => {
    const NAVS = 2; // openFixture (the grant), openPhoneTab on the live session
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + LIVE_WAIT_MS + 2 * POLLER_K * STREAM_POLL_MS + 5 * POLL_WAIT_MS + NAVS * NAV_MS);
    await page.setViewportSize({ width, height: 900 });
    const rig = await seedRelayRig(page);
    const target = await addTargetApi(page, rig.orgId, { label: `A1b ${width}` });
    const f = rig.fixtures[0]!;
    await openFixture(page, rig, f); // the fixture page's read grants the month
    await goLiveApi(page, f.id, target.id);
    let currentGets = 0;
    page.on("request", (r) => {
      if (r.method() === "GET" && new URL(r.url()).pathname.endsWith(`/fixtures/${f.id}/stream-sessions/current`)) currentGets++;
    });
    const scope = await openPhoneTab(page, rig, f);
    const body = scope.locator("[data-phone-body]");
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: POLL_WAIT_MS });
    const control = streamControl(page);
    await expect(control, "the Stream control reads the same session").toHaveAttribute("data-dot", "red");
    // K periods see K GETs, give or take the window's edges; one extra poller per reader multiplies it. A measurement
    // window, not a wait for a state.
    const before = currentGets;
    await page.waitForTimeout(POLLER_K * STREAM_POLL_MS);
    const polled = currentGets - before;
    test.info().annotations.push({ type: "one-poller", description: `${polled} GETs of current in ${POLLER_K} poll periods @${width}` });
    expect(polled, "the session poll really ran").toBeGreaterThanOrEqual(POLLER_K - 1);
    expect(polled, "ONE poller: a second one would double this").toBeLessThanOrEqual(POLLER_K + 1);

    // B5 review m-7: the page-scope poll STOPS when the session ends — the provider polls with the panel closed too, so a
    // terminal session that kept polling would cost a read every period for as long as the page stays open.
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
    await expect(control, "over: no dot").not.toHaveAttribute("data-dot", /./);
    const atEnd = currentGets;
    await page.waitForTimeout(POLLER_K * STREAM_POLL_MS);
    const after = currentGets - atEnd;
    test.info().annotations.push({ type: "poll-stops", description: `${after} GETs of current in ${POLLER_K} poll periods after Stop @${width}` });
    expect(after, "ended: the poll stopped (one read in flight at most)").toBeLessThanOrEqual(1);
  });
}

// ===========================================================================
// A7 — Stop is always reachable, whatever took the panel away
// ===========================================================================
/** The no-stream page's measurement window, in poll periods: an enabled provider reads on mount, at once. */
const NO_MOUNT_POLLS = 2;
const A7_SWITCHES = [
  {
    id: "a",
    name: "the relay switched off by override",
    apply: (orgId: string) => setBoolEntitlementOverrideSql(orgId, "streaming.relay", false),
    // The fixture keeps its panel (the overlay is still granted); its Phone tab holds the probe beside the switched-off line.
    inPanel: true,
  },
  {
    id: "b",
    name: "the competition frozen by the plan's competition cap",
    apply: (orgId: string) => setEntitlementOverrideSql(orgId, "competitions.max_active", 0),
    inPanel: false,
  },
  {
    id: "c",
    name: "streaming switched off (the overlay override)",
    apply: (orgId: string) => setBoolEntitlementOverrideSql(orgId, "streaming.overlay", false),
    inPanel: false,
  },
] as const;

for (const sw of A7_SWITCHES) {
  test(`A7(${sw.id}): a LIVE stream, then ${sw.name} → the stop probe still shows it live, and fits and is tappable at 1280 and 320 → Stop (at 320) → ended`, async ({ page }) => {
    const NAVS = 3; // openFixture (the grant) + openPhoneTab + the page again once it is over
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 30_000 + NAVS * NAV_MS + NO_MOUNT_POLLS * STREAM_POLL_MS);
    await page.setViewportSize({ width: 1280, height: 900 });
    const rig = await seedRelayRig(page);
    const target = await addTargetApi(page, rig.orgId, { label: `A7${sw.id} destination` });
    const f = rig.fixtures[0]!;
    await openFixture(page, rig, f); // the fixture page's read grants the month
    const live = await goLiveApi(page, f.id, target.id);

    await sw.apply(rig.orgId);
    await invalidateOrgEntitlements(page.request, rig.orgId);

    let probe: Locator;
    if (sw.inPanel) {
      const row = await openPhoneTab(page, rig, f);
      await expect(row.getByTestId("stream-switched-off")).toContainText(en("stream.phone.switchedOff"));
      await expect(row.locator("[data-phone-body]"), "no Phone tab body behind the switch").toHaveCount(0);
      probe = row.getByTestId("stream-stop-probe");
    } else {
      // Spec 2026-09-30 §2 (F1): the panel is gone, and the fixture page's Stop-only mount replaces the division page's
      // probe stack — one tap on the width's Stream control, then the probe alone (no tabs, no Phone tab body).
      const scope = await openPhoneTab(page, rig, f);
      await expect(scope.getByTestId("stream-panel"), "the panel is gone").toHaveCount(0);
      await expect(scope.getByTestId("stream-tab-phone"), "the Stop-only mount has no tabs").toHaveCount(0);
      probe = scope.getByTestId("stream-stop-probe");
      // The page it sits on names the fixture (the probe itself needs no label here: the page IS the fixture).
      const header = page.locator("header h1");
      await expect(header, "the fixture page names its match").toContainText(`Side A ${rig.tag}`);
      await expect(header).toContainText(`Side B ${rig.tag}`);
    }
    await expect(probe).toHaveCount(1, { timeout: POLL_WAIT_MS });
    await expect(probe.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"));
    await expectNoHorizontalScroll(page);
    await shot(probe, `A7${sw.id}-probe.png`);
    // The phone the organiser actually holds: the probe fits, and its Stop is a real 44-px target there.
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(probe.getByTestId("stream-stop")).toBeVisible();
    await expectNoHorizontalScroll(page);
    expect(await expectTapTargets(probe), "the probe's controls hit-tested at 320").toBeGreaterThan(0);
    await shot(probe, `A7${sw.id}-probe-320.png`);
    await probe.getByTestId("stream-stop").click();
    await confirmStop(page);
    // The probe renders nothing once nothing is up.
    await expect(probe).toHaveCount(0, { timeout: POLL_WAIT_MS });
    const row = (await sessionsOf({ fixtureId: f.id })).find((s) => s.id === live.id)!;
    expect(row, "the tap ended the stream").toMatchObject({ state: "completed", end_reason: "stopped" });

    // B5 review m-1: once it is over, a page with no stream to show mounts no Stream control — and its session provider,
    // always mounted now so a refresh never remounts the console, reads NOTHING (`enabled` false). The panel case keeps
    // its panel (the overlay is still granted), so only the stop-only switches reach a page with no stream mount.
    if (!sw.inPanel) {
      let gets = 0;
      page.on("request", (r) => {
        if (r.method() === "GET" && new URL(r.url()).pathname.endsWith(`/fixtures/${f.id}/stream-sessions/current`)) gets++;
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      // Not `openFixture`: a frozen match with no stream renders neither the Scoring section nor the Stream card.
      await page.goto(`${rig.divPath}/f/${f.no}`);
      await expect(page.locator("header h1"), "the fixture page rendered").toContainText(`Side A ${rig.tag}`);
      await expect(streamControl(page), "no stream on this page: no Stream control").toHaveCount(0);
      await page.waitForTimeout(NO_MOUNT_POLLS * STREAM_POLL_MS);
      expect(gets, "no stream mount: the provider reads nothing (an enabled one reads on mount)").toBe(0);
    }
  });
}

// ===========================================================================
// A7(d) — Review Focus 4: a FINALIZED match has no Scoring section, so Stream lives in the fallback card
// ===========================================================================
// The Scoring section (and the Stream button beside its heading) renders only while the match can still be scored. A
// stream outlives the whistle — the organiser finalizes, and the camera is still on air — so the console carries Stream
// in its own card then (`console-stream`), and Stop must still be one tap away there, at 1280 and on the phone.
test("A7(d): a LIVE stream on a match that is then FINALIZED → no Scoring section; the fallback Stream card opens the panel on its Phone tab showing LIVE, fits at 1280 and 320 → Stop (at 320) → ended", async ({
  page,
}) => {
  const NAVS = 3; // openFixture (the grant) + openPhoneTab + the reload at 320
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 30_000 + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRelayRig(page);
  const target = await addTargetApi(page, rig.orgId, { label: "A7d destination" });
  const f = rig.fixtures[0]!;
  await openFixture(page, rig, f); // the fixture page's read grants the month
  const live = await goLiveApi(page, f.id, target.id);
  // SETUP: start the division (scoring is closed until then), the result, then the finalize — through the API, the
  // requests the desk and the console themselves send.
  const started = await apiJson(page.request, `/api/v1/divisions/${rig.divisionId}/start`, "POST");
  expect(started.status, `setup start -> ${JSON.stringify(started.error)}`).toBe(200);
  await scoreFixture(page.request, f.id, 2, 1);
  const state = await apiJson<{ last_seq: number; status: string }>(page.request, `/api/v1/fixtures/${f.id}/state`);
  const fin = await apiJson(page.request, `/api/v1/fixtures/${f.id}/finalize`, "POST", { expected_seq: state.data!.last_seq });
  expect(fin.status, `setup finalize from ${state.data!.status}: ${JSON.stringify(fin.error)}`).toBe(200);

  const scope = await openPhoneTab(page, rig, f);
  const card = page.locator('[data-role="console-stream"]');
  await expect(page.locator('[data-role="console-scoring"]'), "premise: a finalized match has no Scoring section").toHaveCount(0);
  await expect(card, "the fallback card holds Stream").toHaveCount(1);
  await expect(card.locator('[data-role="fixture-stream-body"]'), "the panel opened INSIDE the fallback card").toHaveCount(1);
  const body = scope.locator("[data-phone-body]");
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: POLL_WAIT_MS });
  await expectNoHorizontalScroll(page);
  await shot(card, "A7d-fallback.png");
  // B3 fix round 1, Minor 6: the organiser at the court opens it on a PHONE, through the strip icon — a fresh load at
  // 320 with the panel closed: the card hides while closed, and the strip icon opens it, Stop inside.
  await page.setViewportSize({ width: 320, height: 900 });
  await page.reload();
  await expect(card, "closed on a phone, the empty fallback card hides").toBeHidden({ timeout: NAV_MS });
  const phoneIcon = page.locator('[data-role="fixture-stream-phone"]');
  await expect(phoneIcon, "the strip's Stream icon").toBeVisible();
  await phoneIcon.click();
  await expect(card, "the strip icon opens the fallback card on the phone").toBeVisible();
  const phoneTab = card.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-stop")).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(await expectTapTargets(body), "live controls hit-tested at 320, in the fallback card").toBeGreaterThan(0);
  await shot(card, "A7d-fallback-320.png");
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
  const row = (await sessionsOf({ fixtureId: f.id })).find((s) => s.id === live.id)!;
  expect(row, "the tap ended the stream").toMatchObject({ state: "completed", end_reason: "stopped" });
});

// ===========================================================================
// A12 — the run sheet's chip (spec 2026-09-30 §2, T6): the division's path to Stop
// ===========================================================================
// The panel lives on the fixture page; the run sheet keeps a chip per fixture with a session up. The whole loop, TAPPED:
// Go live on the fixture page → the division's chip reads WAITING while the camera warms → the chip opens the fixture
// page with the panel open, whose poll brings it LIVE → the chip reads LIVE → the chip again, Stop → the chip is gone
// while the row stays. WAITING is observable because the server flips warming → live only on a read of `current` (the
// Phone tab's poll) and nothing reads it while the organiser is on the division — its premise is read from the DB.
// B3 fix round 1, I-2: the whole loop runs on the filter the sheet MOUNTS on (a match day's "Today"), on an UNTIMED
// fixture — the row "Today" hides unless a stream is up — never by tapping "All" first.
const A12_NAMES = ["Riverside Rackets Badminton Club Seniors", "Northgate Shuttlers Academy Development", "Canal Street Drop Shots Social Section"];
for (const width of [320, 1280] as const) {
  test(`A12 @${width}: on a MATCH DAY, under the sheet's default "Today", Go live on an UNTIMED fixture → its chip reads WAITING, then (after the chip opens the panel) LIVE → the chip leads to Stop → after Stop the untimed row leaves "Today" and shows under "All" with no chip`, async ({
    page,
  }) => {
    const NAVS = 6; // openPhoneTab, run sheet (waiting), chip → fixture page, run sheet (live), chip → fixture page, run sheet (gone)
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 60_000 + NAVS * NAV_MS);
    await page.setViewportSize({ width, height: 900 });
    // Realistic ~40-character club names (AGENTS.md: a truncation defect shows only with a realistic name).
    const rig = await seedRelayRig(page, { entrants: 3, names: A12_NAMES });
    await addTargetApi(page, rig.orgId, { label: `A12 destination ${width}` });
    // The streamed fixture is UNTIMED — a walk-up match, the shape "Today" hides (I-2). A second fixture is timed NOW,
    // which makes the division's phase match_day (the sheet then mounts on "Today") and is "Today"'s own positive row;
    // the third stays untimed and unstreamed — the row "Today" must still hide.
    const [f, timedToday, plain] = rig.fixtures as [RelayFixture, RelayFixture, RelayFixture];
    // A division still in `setup` reads "setting_up" whatever its fixtures say (division-phase.ts rule 1) — a match day
    // is a STARTED division, started through the request the desk itself sends.
    const started = await apiJson(page.request, `/api/v1/divisions/${rig.divisionId}/start`, "POST");
    expect(started.status, `start -> ${JSON.stringify(started.error)}`).toBe(200);
    await withDb((sql) => sql`update fixtures set scheduled_at = now() where id = ${timedToday.id}`);
    const fixturePath = `${rig.divPath}/f/${f.no}`;

    // 1. Go live — tapped on the fixture page — and leave as soon as the QR says the camera is warming.
    const body = (await openPhoneTab(page, rig, f)).locator("[data-phone-body]");
    await streamSlot(); // this test's share of the deployment's stream capacity
    await body.getByTestId("stream-go-live").click();
    await expect(body.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });

    // 2. The division, on the filter it mounts on: "Today" (premise). WAITING, with the premise read from the DB (nothing
    //    has read `current` since the QR).
    await openRunSheet(page, rig);
    await expect(filterChip(page, "today"), "premise: a match day mounts the sheet on Today").toHaveAttribute("aria-pressed", "true");
    await expect(rowOf(page, timedToday), "premise: Today's own row is on the sheet").toHaveCount(1);
    await expect(rowOf(page, plain), "the positive pair: an untimed row with no stream stays hidden under Today").toHaveCount(0);
    const chip = rowOf(page, f).getByTestId("run-sheet-stream-chip");
    const warming = await latestSession(f.id);
    expect(["requested", "provisioning", "warming"], `premise: the session is still waiting (${warming.state})`).toContain(warming.state);
    await expect(chip, "the untimed streamed row is kept under Today, with its chip").toHaveAttribute("data-state", "waiting");
    await expect(chip).toHaveText(en("runsheet.stream.waiting"));
    await expect(chip).toHaveAttribute("href", `${fixturePath}?stream=open`);
    await expectNoHorizontalScroll(page);
    await expectChipPlacement(rowOf(page, f), width);
    if (width === 320) {
      // The phone floor, hit-tested on the chip itself (expectTapTargets scans descendants; the chip has none).
      await chip.scrollIntoViewIfNeeded();
      const hit = await chip.evaluate((el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const lands = [r.top + r.height / 2, r.top + 2, r.bottom - 2].filter((y) => {
          const h = document.elementFromPoint(cx, y);
          return !!h && (h === el || el.contains(h));
        }).length;
        return { h: r.height, lands };
      });
      expect(hit, "the chip is a 44-px tap target at 320, really hit there").toEqual({ h: expect.any(Number), lands: 3 });
      expect(hit.h).toBeGreaterThanOrEqual(43.5);
    }
    await shot(rowOf(page, f), `A12-chip-waiting-${width}.png`);

    // 3. The chip opens the fixture page with the panel open on its Phone tab; the tab's poll brings it LIVE.
    await chip.click();
    await expect.poll(() => new URL(page.url()).pathname, { message: "the chip lands on THIS fixture's page", timeout: NAV_MS }).toBe(fixturePath);
    const opened = page.locator('[data-role="fixture-stream-body"] [data-phone-body]');
    await expect(opened, "the chip opened the Stream panel on its Phone tab").toBeVisible({ timeout: NAV_MS });
    await expect(opened.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });

    // 4. The division again, still on its default filter: LIVE.
    await openRunSheet(page, rig);
    await expect(filterChip(page, "today")).toHaveAttribute("aria-pressed", "true");
    await expect(chip).toHaveAttribute("data-state", "live");
    await expect(chip).toHaveText(en("runsheet.stream.live"));
    await expectNoHorizontalScroll(page);
    await expectChipPlacement(rowOf(page, f), width);
    if (width === 320) {
      // AGENTS.md "phone composition": the phone row offers the SAME controls as the desktop row — membership, order and
      // repeats, from the live DOM — only placed differently. One DOM: the diff proves nothing was twinned or dropped.
      const phone = await controlSet(rowOf(page, f));
      await page.setViewportSize({ width: 1280, height: 900 });
      await expectChipPlacement(rowOf(page, f), 1280);
      const desk = await controlSet(rowOf(page, f));
      expect(phone, "the row's control set at 320 equals 1280's").toEqual(desk);
      expect(phone, "anti-vacuity: the set carries the chip, the names and the action").toEqual(
        expect.arrayContaining(["run-sheet-stream-chip"]),
      );
      // The untimed row's time cell is plain text, not a control: names link, chip, row action.
      expect(phone.length, "anti-vacuity: names, chip, action").toBeGreaterThanOrEqual(3);
      await page.setViewportSize({ width, height: 900 });
    }
    await shot(rowOf(page, f), `A12-chip-live-${width}.png`);

    // 5. The chip is the path to Stop.
    await chip.click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_MS }).toBe(fixturePath);
    const stop = page.locator('[data-role="fixture-stream-body"]').getByTestId("stream-stop");
    await expect(stop, "Stop, one tap from the chip").toBeVisible({ timeout: NAV_MS });
    await stop.click();
    await confirmStop(page);
    await expect
      .poll(async () => (await latestSession(f.id)).state, { message: "the Stop ended the session", timeout: POLL_WAIT_MS })
      .toBe("completed");

    // 6. After Stop, on the default "Today": nothing is up, so the untimed row is hidden again (Today's own row is the
    //    positive twin — the sheet did render); under "All" the row is there with no chip.
    await openRunSheet(page, rig);
    await expect(filterChip(page, "today")).toHaveAttribute("aria-pressed", "true");
    await expect(rowOf(page, timedToday), "the sheet rendered: Today's own row").toHaveCount(1);
    await expect(rowOf(page, f), "nothing up: the untimed row leaves Today").toHaveCount(0);
    await filterChip(page, "all").click();
    await expect(rowOf(page, f), "the fixture's row is on the sheet under All").toHaveCount(1);
    await expect(chip, "no session up, no chip").toHaveCount(0);
  });
}

// ===========================================================================
// A8 moved (T8): the platform list and the one-POST-per-save half now live in directory-stream-destinations.spec.ts
// (case 1 and the S sequence) — the form is Directory's (D1).
// ===========================================================================

// ===========================================================================
// A13 — a destination list that fails to load is an ERROR with Retry, never "none" (T8, spec §3.3)
// ===========================================================================
for (const width of [320, 1280] as const) {
  test(`A13 @${width}: the destination read FAILS → the load error with Retry, Go live disabled and never "no destinations"; Retry after the route recovers → the seeded destination, selected, and Go live enabled`, async ({
    page,
  }) => {
    const NAVS = 1; // openPhoneTab
    test.setTimeout(SEED_MS + 2 * POLL_WAIT_MS + NAVS * NAV_MS);
    await page.setViewportSize({ width, height: 900 });
    const rig = await seedRelayRig(page);
    const target = await addTargetApi(page, rig.orgId, { label: `A13 destination ${width}` });
    const LIST = "**/api/v1/orgs/*/stream-targets";
    let failed = 0;
    await page.route(LIST, (r) => {
      failed++;
      return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "boom" } }) });
    });
    const row = await openPhoneTab(page, rig, rig.fixtures[0]!);
    const body = row.locator("[data-phone-body]");
    const loadError = body.getByTestId("stream-dest-load-error");
    await expect(loadError).toBeVisible({ timeout: POLL_WAIT_MS });
    await expect(loadError).toContainText(en("stream.dest.loadError"));
    expect(failed, "the list read WAS refused").toBeGreaterThan(0);
    await expect(body.getByTestId("stream-dest-empty"), "an unread list is not an empty one").toHaveCount(0);
    await expect(body.getByTestId("stream-go-live")).toBeDisabled();
    await expectNoHorizontalScroll(page);
    if (width === 320) expect(await expectTapTargets(body), "load-error controls hit-tested").toBeGreaterThan(1);
    await shot(row.getByTestId("stream-panel"), `A13-${width}-load-error.png`);

    await page.unroute(LIST);
    await body.getByTestId("stream-dest-retry").click();
    await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(target.label), { timeout: POLL_WAIT_MS });
    await expect(loadError).toHaveCount(0);
    await expect(body.getByTestId("stream-go-live")).toBeEnabled();
  });
}

// ===========================================================================
// A9 — one control set, whatever the width
// ===========================================================================
test("A9: the Phone tab offers the SAME controls — membership, order and repeats — at 320 as at 1280, idle, waiting and live; Stream and Remote scoring are one open panel at a time, tapped at both widths", async ({ page }) => {
  const NAVS = 1; // openPhoneTab
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + 60_000 + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRelayRig(page);
  await addTargetApi(page, rig.orgId, { label: "A9 destination" });
  const f = rig.fixtures[0]!;
  const row = await openPhoneTab(page, rig, f);
  const body = row.locator("[data-phone-body]");
  await expect(body.getByTestId("stream-go-live")).toBeEnabled();

  // B3 fix round 1, Minor 5: ONE open panel at a time, TAPPED at both widths — `nextOpenPanel` is pinned as a pure pair
  // table; this is its click wiring through each width's own twins (the desktop buttons, then the strip icons).
  const handover = page.locator('[data-role="device-handover"]:visible, [data-role="device-handover-phone"]:visible');
  let swaps = 0;
  for (const w of [1280, 320]) {
    await page.setViewportSize({ width: w, height: 900 });
    const stream = streamControl(page);
    await expect(stream, `@${w}: one visible Stream control`).toHaveCount(1);
    await expect(handover, `@${w}: one visible Remote scoring control`).toHaveCount(1);
    await expect(stream, `@${w}: premise — Stream is open`).toHaveAttribute("aria-expanded", "true");
    await handover.click();
    await expect(handover, `@${w}: Remote scoring opened`).toHaveAttribute("aria-expanded", "true");
    await expect(stream, `@${w}: …and closed Stream`).toHaveAttribute("aria-expanded", "false");
    await expect(row, `@${w}: the Stream body is gone`).toHaveCount(0);
    await stream.click();
    await expect(stream, `@${w}: Stream opened`).toHaveAttribute("aria-expanded", "true");
    await expect(handover, `@${w}: …and closed Remote scoring`).toHaveAttribute("aria-expanded", "false");
    await expect(row, `@${w}: the Stream body is back`).toHaveCount(1);
    const phoneTab = row.getByTestId("stream-tab-phone");
    if (await phoneTab.count()) await phoneTab.click(); // a re-mounted panel opens on its default tab
    await expect(body.getByTestId("stream-go-live")).toBeEnabled();
    swaps++;
  }
  expect(swaps).toBe(2);
  await page.setViewportSize({ width: 1280, height: 900 });

  const compare = async (state: string, min: number): Promise<number> => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const wide = await controlSet(body);
    await page.setViewportSize({ width: 320, height: 900 });
    const narrow = await controlSet(body);
    expect(wide.length, `${state}: controls measured at 1280`).toBeGreaterThanOrEqual(min);
    expect(narrow, `${state}: 320 offers exactly 1280's controls, in order`).toEqual(wide);
    return wide.length;
  };
  const idle = await compare("idle", 4);
  await streamSlot(); // this test's share of the deployment's stream capacity
  await body.getByTestId("stream-go-live").click();
  // WAITING (B5 review m-5): the QR state is the third shape the tab takes; it lasts until the phone connects.
  await expect(body.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });
  const waiting = await compare("waiting", 1);
  await expect(body.getByTestId("stream-qr"), "the diff ran inside the waiting state").toBeVisible({ timeout: 1 });
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
  const live = await compare("live", 1);
  test.info().annotations.push({ type: "A9", description: `compared ${idle} idle, ${waiting} waiting and ${live} live controls` });
  await body.getByTestId("stream-stop").click();
  await confirmStop(page);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
});

// ===========================================================================
// A10 — Spanish, all the way through
// ===========================================================================
test("A10: in Spanish (es) the Phone tab reads Spanish through idle → live → ended — no English string from the stream dictionary leaks", async ({
  page,
}) => {
  const NAVS = 2; // openPhoneTab in English, then in Spanish
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + POLL_WAIT_MS + 30_000 + NAVS * NAV_MS);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rig = await seedRelayRig(page);
  await addTargetApi(page, rig.orgId, { label: "Destino A10" });
  const f = rig.fixtures[0]!;

  // The English that must NOT appear: every stream.* string whose Spanish differs, by its literal pieces.
  const english = Object.keys(EN_UI)
    .filter((k) => k.startsWith("stream.") && ES_UI[k] !== undefined && EN_UI[k] !== ES_UI[k])
    .flatMap((k) =>
      EN_UI[k]!.split(/\{\w+\}/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 5 && !ES_UI[k]!.includes(s))
        .map((s) => ({ k, s })),
    );
  expect(english.length, "English stream strings to scan for").toBeGreaterThan(20);
  const hits = (text: string) => english.filter(({ s }) => text.includes(s));

  // The scan's positive half: the SAME tab in English is caught by it — so an empty result below means Spanish, not a
  // scan that can find nothing.
  const enText = await (await openPhoneTab(page, rig, f)).locator("[data-phone-body]").innerText();
  expect(hits(enText).length, "the scan finds the English tab's own strings").toBeGreaterThanOrEqual(1);

  await page.context().addCookies([{ name: "seazn_locale", value: "es", url: new URL(page.url()).origin }]);
  const row = await openPhoneTab(page, rig, f);
  const body = row.locator("[data-phone-body]");
  const leaks = async (state: string) => {
    const text = await body.innerText();
    expect(text.length, `${state}: the tab has text to scan`).toBeGreaterThan(0);
    expect(hits(text), `${state}: English leaked into the Spanish tab`).toEqual([]);
  };

  await expect(body.getByTestId("stream-state-pill")).toHaveText(es("stream.phone.state.idle"));
  await expect(body.getByTestId("stream-go-live")).toHaveText(es("stream.phone.goLive"));
  await leaks("idle");
  await streamSlot(); // this test's share of the deployment's stream capacity
  await body.getByTestId("stream-go-live").click();
  await expect(body.getByTestId("stream-state-pill")).toHaveText(es("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
  await expect(body.getByTestId("stream-stop")).toHaveText(es("stream.phone.stop"));
  await leaks("live");
  await shot(row.getByTestId("stream-panel"), "A10-es-live.png");
  await body.getByTestId("stream-stop").click();
  await confirmStop(page, es);
  await expect(body.getByTestId("stream-state-pill")).toHaveText(es("stream.phone.state.ended"), { timeout: POLL_WAIT_MS });
  await expect(body.getByTestId("stream-credit-used")).toHaveText(es("stream.phone.ended.credits"));
  await expect(body.getByTestId("stream-end-reason")).toHaveText(es("stream.phone.ended.reason.stopped"));
  await leaks("ended");
  await shot(row.getByTestId("stream-panel"), "A10-es-ended.png");
});

// ===========================================================================
// A11 — the QR at 320 zoomed to 125%
// ===========================================================================
test("A11: at 320 px zoomed to 125% (a 256-px CSS viewport at 1.25 device px per CSS px) the QR and its paste code fit their box and the page", async ({
  browser,
}) => {
  const NAVS = 1; // openPhoneTab
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + CYCLE_MS + NAVS * NAV_MS);
  // Browser zoom at 125% on a 320-px screen IS a 256-CSS-px layout viewport at 1.25 device pixels per CSS px.
  const ctx = await browser.newContext({
    storageState: test.info().project.use.storageState as string,
    viewport: { width: Math.round(320 / 1.25), height: 700 },
    deviceScaleFactor: 1.25,
  });
  const page = await ctx.newPage();
  try {
    const rig = await seedRelayRig(page);
    await addTargetApi(page, rig.orgId, { label: "A11 destination" });
    const row = await openPhoneTab(page, rig, rig.fixtures[0]!);
    const body = row.locator("[data-phone-body]");
    await streamSlot(); // this test's share of the deployment's stream capacity
    await body.getByTestId("stream-go-live").click();
    await expect(body.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });
    const fit = await body.evaluate((b) => {
      const r = (id: string) => b.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
      const qr = r("stream-qr");
      const box = r("stream-qr-box");
      const field = r("stream-qr-field");
      return {
        vw: document.documentElement.clientWidth,
        qr: { l: qr.left, r: qr.right, t: qr.top, b: qr.bottom, w: qr.width, h: qr.height },
        box: { l: box.left, r: box.right, t: box.top, b: box.bottom },
        field: { l: field.left, r: field.right },
      };
    });
    expect(fit.vw, "the zoomed viewport").toBe(256);
    expect(fit.qr.w, "the symbol is drawn at a scannable size").toBeGreaterThan(100);
    expect(Math.abs(fit.qr.w - fit.qr.h), "square").toBeLessThan(1);
    expect(fit.qr.l, "the QR starts inside its box").toBeGreaterThanOrEqual(fit.box.l - 0.5);
    expect(fit.qr.r, "the QR ends inside its box").toBeLessThanOrEqual(fit.box.r + 0.5);
    expect(fit.qr.t, "the QR's top is inside its box").toBeGreaterThanOrEqual(fit.box.t - 0.5);
    expect(fit.qr.b, "the QR's bottom is inside its box").toBeLessThanOrEqual(fit.box.b + 0.5);
    expect(fit.box.l, "the box starts inside the viewport").toBeGreaterThanOrEqual(-0.5);
    expect(fit.box.r, "the box ends inside the viewport").toBeLessThanOrEqual(fit.vw + 0.5);
    expect(fit.field.l, "the paste code starts inside the viewport").toBeGreaterThanOrEqual(-0.5);
    expect(fit.field.r, "the paste code ends inside the viewport").toBeLessThanOrEqual(fit.vw + 0.5);
    // No box of the stream panel reaches past the viewport (the page-wide check, scoped to what this walkthrough
    // owns). The page-level scan below is RECORDED, not asserted: at 256 CSS px the app header's icon row overflows —
    // D-A11, the site header, not the Phone tab, ACCEPTED by the owner 2026-09-29 (not to be fixed; A1 @320 proves the
    // page clean at 100%). Every overflowing box is listed with whether it sits inside the panel, and the panel's share
    // must be none. Only ELIGIBLE boxes count — painted, and not inside a scroll/clip container (whose overflow is
    // reachable or clipped, never page overflow) — so the panel count below is the number the verdict really covered.
    const scan = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const panel = document.querySelector('[data-testid="stream-panel"]');
      let panelEligible = 0;
      const over: { el: string; right: number; inPanel: boolean }[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        let contained = false;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") { contained = true; break; }
        }
        if (contained) continue;
        const inPanel = !!panel && panel.contains(el);
        if (inPanel) panelEligible++;
        if (r.right > vw + 1) {
          over.push({ el: `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 3).join(".")}`, right: Math.round(r.right), inPanel });
        }
      }
      return { vw, panelEligible, over };
    });
    test.info().annotations.push({ type: "A11", description: `${scan.panelEligible} eligible panel box(es) scanned` });
    expect(scan.panelEligible, "the panel's eligible boxes were scanned").toBeGreaterThan(10);
    expect(scan.over.filter((o) => o.inPanel), "nothing in the stream panel reaches past the zoomed viewport").toEqual([]);
    if (scan.over.length > 0) {
      test.info().annotations.push({ type: "D-A11 accepted by owner 2026-09-29", description: JSON.stringify(scan.over.slice(0, 5)) });
    }
    await shot(row.getByTestId("stream-panel"), "A11-320-at-125pct-qr.png");
    await page.screenshot({ path: join(process.env.VISUAL_DIR ?? test.info().outputPath(), "A11-320-at-125pct-page.png") });
  } finally {
    try {
      await teardownStreams(); // before the context goes: the stop is made as this context's signed-in owner
    } finally {
      await ctx.close(); // even when the teardown throws
    }
  }
});

// ===========================================================================
// B5 — the Signal-path frame in EVERY panel state, at the three widths (T9b Step 5: the visual gate, kept as a walkthrough)
// ===========================================================================
// Driven through the product and the fake driver's own key prefixes (`connecting-` dials forever, `reject-` is refused)
// and `page.route` for the load error. Two chain states the fake cannot reach from a browser — the phone's signal lost
// while live (§3.2 "No signal") and `ending` (it lasts one read) — are the REAL projection of a live session changed on
// its way to the page into what the server sends in that state: the ingest's state for no signal; for ending the state,
// with ingest and output null (the poll reads both only while warming or live).
// Each state: no horizontal scroll, AA contrast in the panel (axe, counted), a crop. 768 is the width the D3 case lacks.

/** AA contrast inside the open Stream panel, by axe's own color-contrast rule. Returns how many nodes axe checked. */
async function expectPanelContrast(page: Page, state: string): Promise<number> {
  const axe = await new AxeBuilder({ page }).include('[data-role="fixture-stream-body"]').withRules(["color-contrast"]).analyze();
  const bad = axe.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary ?? v.id}`));
  expect(bad, `${state}: every text run in the panel reads at AA`).toEqual([]);
  const checked = axe.passes.reduce((n, r) => n + r.nodes.length, 0);
  expect(checked, `${state}: axe checked the panel's text (zero is a vacuous pass)`).toBeGreaterThan(0);
  return checked;
}

/** A realistic ~45-character destination name: the 320 picker must stop it before the chevron (B7). */
const LONG_DEST = "Riverside Badminton Club — Court 1 main feed";

for (const width of WIDTHS) {
  test(`B5 frame @${width}: no destinations → load error → Ready (a long name) → in use → Waiting → Live connecting → D3 → no signal → ending → Ended → Live ok → Failed → no credits — each fits, reads AA, and is captured`, async ({
    page,
  }) => {
    const NAVS = 9; // openPhoneTab ×8 (no-dest, load error, ready, in-use, D3, ok, failed, no credits) + the reload after the route
    const SESSIONS = 4; // the holder, D3, ok, failed
    test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAVS * NAV_MS + SESSIONS * CYCLE_MS + OUTPUT_WARNING_AFTER_MS + 6 * POLL_WAIT_MS);
    await page.setViewportSize({ width, height: 900 });
    const rig = await seedRelayRig(page, { entrants: 4 });
    expect(rig.fixtures.length, "premise: a fixture per state that starts a session").toBeGreaterThanOrEqual(6);
    expect(rig.monthlyRate, "premise (V426): the plan's month pays for the sessions below").toBeGreaterThanOrEqual(SESSIONS);
    const [fReady, fHold, fD3, fOk, fFail, fBroke] = rig.fixtures as [RelayFixture, RelayFixture, RelayFixture, RelayFixture, RelayFixture, RelayFixture];
    const captured: string[] = [];
    let axeNodes = 0;
    const capture = async (scope: Locator, state: string, opts: { axe?: boolean } = {}) => {
      await expectNoHorizontalScroll(page);
      if (opts.axe !== false) axeNodes += await expectPanelContrast(page, state);
      await shot(scope.getByTestId("stream-panel"), `B5-${width}-${String(captured.length + 1).padStart(2, "0")}-${state}.png`);
      captured.push(state);
    };

    // 1. NO DESTINATIONS.
    let scope = await openPhoneTab(page, rig, fReady);
    let body = scope.locator("[data-phone-body]");
    await expect(body.getByTestId("stream-dest-empty")).toHaveText(en("stream.dest.empty"));
    await capture(scope, "no-destinations");

    // 2. LOAD ERROR — the list route refused.
    const LIST = "**/api/v1/orgs/*/stream-targets";
    await page.route(LIST, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "boom" } }) }));
    scope = await openPhoneTab(page, rig, fReady);
    body = scope.locator("[data-phone-body]");
    await expect(body.getByTestId("stream-dest-load-error")).toContainText(en("stream.dest.loadError"), { timeout: POLL_WAIT_MS });
    await capture(scope, "load-error");
    await page.unroute(LIST);

    // 3. READY — the oldest destination offered, a long name stopped before the chevron.
    const long = await addTargetApi(page, rig.orgId, { label: LONG_DEST });
    const dialling = await addTargetApi(page, rig.orgId, { label: `Dialling ${width}`, streamKey: `${FAKE_CONNECTING_KEY_PREFIX}${randomBytes(6).toString("hex")}` });
    const refused = await addTargetApi(page, rig.orgId, { label: `Refused ${width}`, streamKey: `${FAKE_REJECT_KEY_PREFIX}${randomBytes(6).toString("hex")}` });
    scope = await openPhoneTab(page, rig, fReady);
    body = scope.locator("[data-phone-body]");
    const picker = body.getByTestId("stream-target");
    await expect(picker.locator("option:checked")).toHaveText(optionText(LONG_DEST));
    await expect(body.getByTestId("stream-go-live")).toBeEnabled();
    await expect(body.getByTestId("stream-chain")).toHaveAttribute("data-dest", "notLive");
    // B7 at every width: the field, its mark and its chevron stay inside the panel; the select keeps its chevron gutter.
    const fit = await picker.evaluate((sel: HTMLSelectElement) => {
      const panel = sel.closest('[data-testid="stream-panel"]')!.getBoundingClientRect();
      const r = sel.getBoundingClientRect();
      const chevron = sel.parentElement!.querySelector("svg")!.getBoundingClientRect();
      const css = getComputedStyle(sel);
      // B5 review m-4: where the text box ENDS (the field's right edge less its border and padding), against where the
      // chevron BEGINS — not the padding against the chevron's width, which `pr-5` would pass while overlapping it.
      const textEnd = r.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
      return { inside: r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5, chevronInside: chevron.right <= r.right && chevron.left >= r.left, textEnd, chevronLeft: chevron.left };
    });
    expect(fit.inside, "the picker stays inside the panel").toBe(true);
    expect(fit.chevronInside, "the chevron sits inside the field").toBe(true);
    expect(fit.textEnd, "the text stops before the chevron begins").toBeLessThanOrEqual(fit.chevronLeft + 0.5);
    await capture(scope, "ready-long-name");

    // 4. IN USE — another match holds the long-named destination; Go live here is refused on the picker.
    const holder = await goLiveApi(page, fHold.id, long.id);
    scope = await openPhoneTab(page, rig, fReady);
    body = scope.locator("[data-phone-body]");
    await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(LONG_DEST));
    await body.getByTestId("stream-go-live").click();
    await expect(body.getByTestId("stream-in-use-open")).toBeVisible({ timeout: POLL_WAIT_MS });
    await expect(body.getByTestId("stream-target")).toHaveAttribute("aria-invalid", "true");
    await expect(body.getByTestId("stream-go-live"), "held: Go live waits").toBeDisabled();
    await expect(body.getByTestId("stream-chain")).toHaveAttribute("data-dest", "inUse");
    await capture(scope, "in-use");
    expect((await page.request.post(`/api/v1/fixtures/${fHold.id}/stream-sessions/${holder.id}/stop`)).status(), "SETUP: the holder stops").toBe(200);
    await expect
      .poll(async () => (await sessionsOf({ fixtureId: fHold.id })).every((r) => r.state === "completed" || r.state === "failed"), { timeout: POLL_WAIT_MS })
      .toBe(true);

    // 5–10. WAITING → LIVE CONNECTING → D3 → (no signal, ending: the real projection, reshaped) → ENDED.
    scope = await openPhoneTab(page, rig, fD3);
    body = scope.locator("[data-phone-body]");
    const chain = body.getByTestId("stream-chain");
    await body.getByTestId("stream-target").selectOption(dialling.id);
    await body.getByTestId("stream-go-live").click();
    await expect(body.getByTestId("stream-qr")).toBeVisible({ timeout: POLL_WAIT_MS });
    await expect(chain).toHaveAttribute("data-phone", "waiting");
    // The QR lasts until the server's first read after the connect: the crop first, axe after it would outlast it.
    await capture(scope, "waiting", { axe: false });
    await expect(body.getByTestId("stream-qr"), "the QR state outlasted the crop").toBeVisible({ timeout: 1 });
    await expect(body.getByTestId("stream-state-pill")).toHaveText(en("stream.phone.state.live"), { timeout: LIVE_WAIT_MS });
    await expect(chain).toHaveAttribute("data-dest", "connecting");
    await expect(body.getByTestId("stream-output-warning")).toHaveCount(0);
    await capture(scope, "live-connecting");
    await expect(body.getByTestId("stream-output-warning")).toBeVisible({ timeout: OUTPUT_WARNING_AFTER_MS + 2 * POLL_WAIT_MS });
    await expect(chain).toHaveAttribute("data-dest", "notReceiving");
    await expect(streamControl(page)).toHaveAttribute("data-dot", "amber");
    await capture(scope, "d3-warning");
    const CURRENT = `**/api/v1/fixtures/${fD3.id}/stream-sessions/current`;
    const reshape = (change: (v: Record<string, unknown>) => void) =>
      page.route(CURRENT, async (r) => {
        const res = await r.fetch();
        const json = (await res.json()) as { data?: Record<string, unknown> | null };
        if (json.data) change(json.data);
        await r.fulfill({ response: res, json });
      });
    await reshape((v) => {
      v.ingest = { ...(v.ingest as Record<string, unknown>), state: "disconnected" };
    });
    await expect(chain).toHaveAttribute("data-phone", "noSignal", { timeout: POLL_WAIT_MS });
    await expect(chain).toHaveAttribute("data-link1", "problem");
    await capture(scope, "live-no-signal");
    await page.unroute(CURRENT);
    await reshape((v) => {
      // The real ending projection: the poll reads ingest and output only while warming or live (B5 review m-6).
      v.state = "ending";
      v.ingest = null;
      v.output = null;
    });
    await expect(chain).toHaveAttribute("data-dest", "ending", { timeout: POLL_WAIT_MS });
    await expect(body.getByTestId("stream-ending")).toBeVisible();
    await expect(streamControl(page), "ending: amber, the button says Stream").toHaveAttribute("data-dot", "amber");
    await capture(scope, "ending");
    await page.unroute(CURRENT);
    await expect(chain).toHaveAttribute("data-dest", "notReceiving", { timeout: POLL_WAIT_MS });
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(body.getByTestId("stream-ended")).toBeVisible({ timeout: POLL_WAIT_MS });
    await expect(body.getByTestId("stream-chain"), "ended draws no chain").toHaveCount(0);
    await capture(scope, "ended");

    // 11. LIVE OK.
    scope = await openPhoneTab(page, rig, fOk);
    body = scope.locator("[data-phone-body]");
    await expect(body.getByTestId("stream-target").locator("option:checked")).toHaveText(optionText(LONG_DEST));
    await body.getByTestId("stream-go-live").click();
    await expect(body.getByTestId("stream-chain")).toHaveAttribute("data-dest", "live", { timeout: LIVE_WAIT_MS });
    await expect(body.getByTestId("stream-on-air")).toHaveText(en("stream.onAir"));
    await expect(streamControl(page)).toHaveAttribute("data-dot", "red");
    if (width >= 768) {
      // B5 review m-3: in Live the picker is gone — the chain's destination node names it, in full, at ≥768.
      const destName = body.getByTestId("stream-chain-dest-name");
      await expect(destName).toContainText(`· ${LONG_DEST}`);
      const box = await destName.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      expect(box.cw, "premise: the name is laid out").toBeGreaterThan(0);
      expect(box.sw, "the destination's name is not cut off").toBeLessThanOrEqual(box.cw);
    }
    await capture(scope, "live-ok");
    await body.getByTestId("stream-stop").click();
    await confirmStop(page);
    await expect(body.getByTestId("stream-ended")).toBeVisible({ timeout: POLL_WAIT_MS });

    // 12. FAILED — the destination refuses the key.
    scope = await openPhoneTab(page, rig, fFail);
    body = scope.locator("[data-phone-body]");
    await body.getByTestId("stream-target").selectOption(refused.id);
    await body.getByTestId("stream-go-live").click();
    await expect(body.getByTestId("stream-failed")).toBeVisible({ timeout: LIVE_WAIT_MS });
    await capture(scope, "failed");

    // 13. NO CREDITS — the month spent, nothing bought, a match that never streamed (no free restart): the pack tiles
    //     alone (B3), no Go live and no chain.
    await drainMonthlyTo(rig.orgId, 0);
    expect((await ledger(rig.orgId)).total, "premise: no credit left").toBe(0);
    scope = await openPhoneTab(page, rig, fBroke);
    body = scope.locator("[data-phone-body]");
    await expect(body.locator('[data-testid^="stream-buy-pack-"]')).toHaveCount(STREAM_CREDIT_PACKS.length);
    await expect(body.getByTestId("stream-go-live")).toHaveCount(0);
    await expect(body.getByTestId("stream-chain")).toHaveCount(0);
    await capture(scope, "no-credits");

    test.info().annotations.push({ type: "b5-frame", description: `@${width}: ${captured.length} states, axe nodes ${axeNodes}: ${captured.join(", ")}` });
    expect(captured, "every state was reached and captured, in order").toEqual([
      "no-destinations", "load-error", "ready-long-name", "in-use", "waiting", "live-connecting", "d3-warning",
      "live-no-signal", "ending", "ended", "live-ok", "failed", "no-credits",
    ]);
  });
}

// B3 re-review N-1: the run-sheet row's LINE 2 on a 320 phone in FRENCH — the longest waiting chip of the four locales
// ("En attente du téléphone") beside the row action, with realistic ~40-character club names. Nothing on the line may
// pass the row, and the chip keeps its 44-px tap.
test("B5 N-1 @320 fr: a WAITING chip on a run-sheet row — line 2 fits the row, nothing clipped", async ({ page }) => {
  const NAVS = 3; // the fixture page (the month's grant), the run sheet in English, then in French
  test.setTimeout(SLOT_WAIT_MS + SEED_MS + NAVS * NAV_MS + POLL_WAIT_MS);
  await page.setViewportSize({ width: 320, height: 900 });
  const rig = await seedRelayRig(page, { entrants: 3, names: A12_NAMES });
  const target = await addTargetApi(page, rig.orgId, { label: "N-1 destination" });
  const f = rig.fixtures[0]!;
  await openFixture(page, rig, f); // the month's grant (R3b)
  await streamSlot();
  // WAITING, held: made through the API and never read (the server flips it live only on a read of `current`).
  const made = await apiJson<{ id: string }>(page.request, `/api/v1/fixtures/${f.id}/stream-sessions`, "POST", { mode: "passthrough", targetId: target.id });
  expect(made.status, `SETUP: create -> ${JSON.stringify(made.error)}`).toBe(201);
  await page.context().addCookies([{ name: "seazn_locale", value: "fr", url: new URL(page.url()).origin }]);
  await openRunSheet(page, rig);
  const row = rowOf(page, f);
  const chip = row.getByTestId("run-sheet-stream-chip");
  await expect(chip).toHaveAttribute("data-state", "waiting");
  await expect(chip).toHaveText(fr("runsheet.stream.waiting"));
  await expectNoHorizontalScroll(page);
  const g = await row.evaluate((li) => {
    const line2 = li.querySelector<HTMLElement>('[data-row-line="2"]')!;
    const rowBox = li.getBoundingClientRect();
    const parts = Array.from(line2.children).map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width };
    });
    const lineR = line2.getBoundingClientRect().right;
    return { rowL: rowBox.left, rowR: rowBox.right, lineR, scroll: line2.scrollWidth, client: line2.clientWidth, parts };
  });
  test.info().annotations.push({ type: "n-1", description: JSON.stringify(g) });
  expect(g.parts.length, "line 2 has parts to measure").toBeGreaterThan(1);
  expect(g.scroll, "line 2's content fits line 2").toBeLessThanOrEqual(g.client + 1);
  for (const p of g.parts) expect(p.r, `${p.tag} ends inside the row`).toBeLessThanOrEqual(g.rowR + 0.5);
  // The action keeps line 2's right edge whether or not the line wrapped, and never sits on the chip.
  const [, chipPart, actionPart] = g.parts as [unknown, { l: number; r: number; t: number; b: number }, { l: number; r: number; t: number; b: number }];
  expect(actionPart.r, "the action is right-aligned").toBeGreaterThanOrEqual(g.lineR - 1);
  const overlap = !(actionPart.l >= chipPart.r || actionPart.r <= chipPart.l || actionPart.t >= chipPart.b || actionPart.b <= chipPart.t);
  expect(overlap, "the chip and the action do not overlap").toBe(false);
  const chipBox = await chip.boundingBox();
  expect(chipBox!.height, "the chip keeps its 44-px tap").toBeGreaterThanOrEqual(43.5);
  await shot(row, "B5-N1-320-fr-waiting-row.png");
});
