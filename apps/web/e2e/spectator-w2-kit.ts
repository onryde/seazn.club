// Shared harness for the spectator W2 walkthroughs (Task 17):
//   - walkthrough/spectator-org-home.spec.ts — the org home's chips and order
//   - walkthrough/spectator-player.spec.ts   — the player card
//   - walkthrough/spectator-hub.spec.ts      — the competition hub's tabs
//
// It lives at `e2e/` ROOT for the reason `spectator-public-helpers.ts` records:
// Playwright's WALKTHROUGH pattern collects every file in `e2e/walkthrough/` as
// a spec, and a spec importing another "test file" fails to collect.
//
// Budgets here are built from the product's own constants, read out of the
// SOURCE text rather than imported (AGENTS.md #20). An import would pull the
// hook's module graph into the spec (`@/lib/client`, dictionaries) and risk the
// whole file failing to collect; `hub-knockout.spec.ts:117-135` records the
// same choice. The reads throw from INSIDE a test, never at module scope: a
// module-scope throw collects zero tests and reads as green.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { apiJson, setEntitlementOverrideSql, setOrgLocaleSql, setOrgPlanBySql } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { openContexts } from "./spectator-public-helpers";

// ---------------------------------------------------------------------------
// The product's clocks
// ---------------------------------------------------------------------------

const WEB_ROOT = new URL("../", import.meta.url);

function sourceText(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, WEB_ROOT)), "utf8");
}

/** `export const NAME = 15_000;` out of a source file, or a throw naming the
 *  file — a renamed constant must fail loudly, never fall back to a guess. */
export function sourceConstant(relPath: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([\\d_]+);`).exec(sourceText(relPath));
  if (!match) throw new Error(`${name} not found as a numeric export in ${relPath}`);
  return Number(match[1]!.replaceAll("_", ""));
}

export interface W2Clock {
  /** The hub/org-home/player islands' poll while something is live. */
  hubPollMs: number;
  /** The same islands' poll while nothing is live. */
  hubIdlePollMs: number;
  /** Redis windows (inert without Redis, but they bound a missed DEL). */
  playerMatchesTtlMs: number;
  orgLiveTtlMs: number;
  /** ISR / `unstable_cache` windows. */
  revalidateFastMs: number;
  revalidateSlowMs: number;
}

export function w2Clock(): W2Clock {
  const hook = "src/components/public-site/use-live-competition.ts";
  const usecase = "src/server/usecases/public.ts";
  const data = "src/server/public-site/data.ts";
  return {
    hubPollMs: sourceConstant(hook, "HUB_POLL_MS"),
    hubIdlePollMs: sourceConstant(hook, "HUB_IDLE_POLL_MS"),
    playerMatchesTtlMs: sourceConstant(usecase, "PLAYER_MATCHES_TTL_SECONDS") * 1000,
    orgLiveTtlMs: sourceConstant(usecase, "ORG_LIVE_TTL_SECONDS") * 1000,
    revalidateFastMs: sourceConstant(data, "REVALIDATE_FAST") * 1000,
    revalidateSlowMs: sourceConstant(data, "REVALIDATE_SLOW") * 1000,
  };
}

/** One API round trip while seeding, on a machine other sessions also load. */
export const API_CALL_MS = 1_500;
/** One page step: a navigation, a tap, a settle. */
export const STEP_MS = 15_000;
/** On top of one poll interval: the refetch, React's render, a loaded machine. */
export const LAND_SLACK_MS = 5_000;
/** Nothing below this, whatever the arithmetic says. */
export const FLOOR_MS = 60_000;
/** One hub tab opened and scanned at one phone width (HB7). Harness work. */
export const TAB_CHECK_MS = 3_000;
/** One route loaded and scanned in one width project (MS1). Harness work. */
export const ROUTE_CHECK_MS = 5_000;
/** One capture-matrix state at one width: open, assert, settle, shoot. */
export const SHOT_STATE_MS = 4_000;
/** CSS transitions settle before a screenshot is taken. */
export const PAINT_SETTLE_MS = 250;

/** The owner's bar for a consent revoke reaching a FRESH visitor (ruling
 *  2026-09-16): the same 15s the player's own toggle is held to
 *  (`player-accounts.spec.ts`, "consent flip by the player revalidates the
 *  public card"). This is the assertion's limit, not a cost estimate. */
export const CONSENT_CLEAR_BAR_MS = 15_000;

// ---------------------------------------------------------------------------
// Dictionaries — read as JSON, never through `@/lib/i18n-runtime`
// ---------------------------------------------------------------------------

export type W2Locale = "en" | "es" | "fr" | "nl";
const dictionaries = new Map<string, Record<string, unknown>>();

function namespaceString(
  locale: W2Locale,
  namespace: "public" | "ui",
  key: string,
  vars: Record<string, string | number>,
): string {
  const file = `src/dictionaries/${locale}/${namespace}.json`;
  let dict = dictionaries.get(file);
  if (!dict) {
    dict = JSON.parse(sourceText(file)) as Record<string, unknown>;
    dictionaries.set(file, dict);
  }
  const raw = dict[key];
  if (typeof raw !== "string") throw new Error(`no string "${key}" in ${locale}/${namespace}.json`);
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** The `public` dictionary string for `key`, with `{vars}` filled. Throws on a
 *  missing key: a `TKey` accepts any string and a missing one RENDERS dotted,
 *  so a typo here must not become an assertion that passes on the dotted key. */
export function dictString(locale: W2Locale, key: string, vars: Record<string, string | number> = {}): string {
  return namespaceString(locale, "public", key, vars);
}

/** The same, from the `ui` dictionary — what a shared client component reads
 *  through `useMsg` (e.g. `ShareButton`'s `share.whatsapp`). */
export function uiString(locale: W2Locale, key: string, vars: Record<string, string | number> = {}): string {
  return namespaceString(locale, "ui", key, vars);
}

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

export interface MintedOrg {
  id: string;
  slug: string;
}

/** Point THIS request context's active-org cookie at `orgId`. The `request`
 *  fixture is per test, so every test that writes to a dedicated org calls
 *  this first; the shared Pro org stays the default for everything else. */
export async function switchActiveOrg(request: APIRequestContext, orgId: string): Promise<void> {
  const res = await apiJson(request, "/api/orgs/active", "POST", { org_id: orgId });
  if (res.status >= 300) throw new Error(`activate org ${orgId} -> ${res.status} ${JSON.stringify(res.error)}`);
}

/** A dedicated org owned by the signed-in Pro user, with its plan, locale and
 *  competition headroom set BEFORE anything reads it — entitlement changes may
 *  be served stale for up to five minutes (owner ruling), so nothing here is
 *  flipped after a first render. A new org is its own billing group, so a plan
 *  set here never reaches the shared Pro org. Leaves it active on `request`. */
export async function mintSpectatorOrg(
  request: APIRequestContext,
  opts: { name: string; plan: "pro" | "community"; locale?: W2Locale },
): Promise<MintedOrg> {
  const org = await apiJson<{ id: string; slug: string }>(request, "/api/orgs", "POST", { name: opts.name });
  if (!org.data?.id || !org.data.slug) {
    throw new Error(`org "${opts.name}" -> ${org.status} ${JSON.stringify(org.error)}`);
  }
  const { id, slug } = org.data;
  if (opts.plan === "pro") await setOrgPlanBySql({ orgId: id }, "pro");
  if (opts.locale && opts.locale !== "en") await setOrgLocaleSql(id, opts.locale);
  // Headroom, not a ledger: Community allows 3 active competitions and 2
  // published ones, and a create past the published cap silently comes back
  // PRIVATE (auth.setup.ts records that trap).
  await setEntitlementOverrideSql(id, "competitions.max_active", 50);
  await setEntitlementOverrideSql(id, "dashboard.public.max", 50);
  await switchActiveOrg(request, id);
  return { id, slug };
}

export async function activeOrgSlug(request: APIRequestContext): Promise<MintedOrg> {
  const orgs = await apiJson<{ id: string; slug: string }[]>(request, "/api/orgs");
  const state = await request.storageState();
  const activeId = state.cookies.find((c) => c.name === "seazn_org")?.value;
  const org = orgs.data?.find((o) => o.id === activeId) ?? orgs.data?.[0];
  if (!org) throw new Error("no org memberships for the signed-in user");
  return { id: org.id, slug: org.slug };
}

// ---------------------------------------------------------------------------
// Seeding through the real API
// ---------------------------------------------------------------------------

/** A PUBLIC competition in the request's active org. Asserts the org and the
 *  visibility it came back with: the create takes no org field, and a create
 *  over a cap degrades to private with a 201. */
export async function publicCompetition(
  request: APIRequestContext,
  opts: { name: string; orgId: string; startsOn?: string; endsOn?: string },
): Promise<{ id: string; slug: string }> {
  const res = await apiJson<{ id: string; slug: string; org_id: string; visibility: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    {
      name: opts.name,
      visibility: "public",
      ...(opts.startsOn ? { starts_on: opts.startsOn } : {}),
      ends_on: opts.endsOn ?? "2030-12-31",
    },
  );
  if (res.status !== 201 || !res.data) {
    throw new Error(`competition "${opts.name}" -> ${res.status} ${JSON.stringify(res.error)}`);
  }
  expect(res.data.org_id, `competition "${opts.name}" landed in the wrong org`).toBe(opts.orgId);
  expect(res.data.visibility, `competition "${opts.name}" degraded to private`).toBe("public");
  return { id: res.data.id, slug: res.data.slug };
}

/** Publish a competition the way the settings Status select does. Owner
 *  decision 2026-09-27: a DRAFT is reachable by link but listed nowhere — not
 *  on the org home, the sitemap, discovery or another competition's player
 *  card — so a spec that reads one of those publishes what it expects to see.
 *  Call it AFTER `leagueFixtures`: starting a division promotes a PUBLISHED
 *  competition to `live` (schedule.ts), which would change its chip and tier. */
export async function publishCompetition(request: APIRequestContext, competitionId: string): Promise<void> {
  const res = await apiJson<{ status: string }>(request, `/api/v1/competitions/${competitionId}`, "PATCH", {
    status: "published",
  });
  if (res.status >= 300 || res.data?.status !== "published") {
    throw new Error(`publish ${competitionId} -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

export async function division(
  request: APIRequestContext,
  competitionId: string,
  body: { name: string; sport_key: string; variant_key: string; config?: Record<string, unknown>; description?: string },
): Promise<{ id: string; slug: string }> {
  const created = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", body);
  if (!created.data) throw new Error(`division "${body.name}" -> ${created.status} ${JSON.stringify(created.error)}`);
  const read = await apiJson<{ id: string; slug: string }>(request, `/api/v1/divisions/${created.data.id}`);
  if (!read.data) throw new Error(`division read ${created.data.id} -> ${read.status}`);
  return { id: read.data.id, slug: read.data.slug };
}

export async function person(request: APIRequestContext, fullName: string, publicName: boolean): Promise<string> {
  const res = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
    full_name: fullName,
    consent: { public_name: publicName },
  });
  if (!res.data) throw new Error(`person "${fullName}" -> ${res.status} ${JSON.stringify(res.error)}`);
  return res.data.id;
}

export async function entrants(
  request: APIRequestContext,
  divisionId: string,
  rows: { kind: "individual" | "team"; name: string; members: string[] }[],
): Promise<string[]> {
  const res = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    rows.map((r, i) => ({
      kind: r.kind,
      display_name: r.name,
      seed: i + 1,
      members: r.members.map((person_id) => ({ person_id })),
    })),
  );
  if (!res.data || res.data.length !== rows.length) {
    throw new Error(`entrants for ${divisionId} -> ${res.status} ${JSON.stringify(res.error)}`);
  }
  return res.data.map((e) => e.id);
}

export interface FixtureRow {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

/** A league stage generated and the division started; the fixtures come back
 *  with their sides, so a caller never assumes which pairing is first. */
export async function leagueFixtures(request: APIRequestContext, divisionId: string): Promise<FixtureRow[]> {
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  if (!stage.data) throw new Error(`stage for ${divisionId} -> ${stage.status} ${JSON.stringify(stage.error)}`);
  const gen = await apiJson(request, `/api/v1/stages/${stage.data.id}/generate`, "POST");
  if (gen.status >= 300) throw new Error(`generate ${stage.data.id} -> ${gen.status} ${JSON.stringify(gen.error)}`);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  if (started.status >= 300) throw new Error(`start ${divisionId} -> ${started.status} ${JSON.stringify(started.error)}`);
  const list = await apiJson<FixtureRow[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  if (!list.data?.length) throw new Error(`fixtures for ${divisionId} -> ${list.status}`);
  return list.data;
}

export async function scheduleFixture(request: APIRequestContext, fixtureId: string, iso: string): Promise<void> {
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}`, "PATCH", { scheduled_at: iso });
  if (res.status >= 300) throw new Error(`schedule ${fixtureId} -> ${res.status} ${JSON.stringify(res.error)}`);
}

/** Posts events to one fixture tracking `seq` itself: one state read, then each
 *  write's own returned `seq`. Half the round trips of `mustPost`, which reads
 *  state before every event — a tennis set is ~50 of them. */
export async function eventStream(request: APIRequestContext, fixtureId: string) {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) throw new Error(`state ${fixtureId} -> ${state.status}`);
  let seq = state.data.last_seq;
  let posted = 0;
  return {
    async post(type: string, payload: Record<string, unknown>): Promise<void> {
      const res = await apiJson<{ seq: number }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
        expected_seq: seq,
        type,
        payload,
      });
      if (res.status >= 300 || typeof res.data?.seq !== "number") {
        throw new Error(
          `${type} #${posted + 1} on ${fixtureId} -> ${res.status} ${JSON.stringify(res.error)} payload=${JSON.stringify(payload)}`,
        );
      }
      seq = res.data.seq;
      posted += 1;
    },
    get posted() {
      return posted;
    },
  };
}

// ---------------------------------------------------------------------------
// Anonymous spectators
// ---------------------------------------------------------------------------

/** A spectator's page: no session, cookie consent already answered so no
 *  banner covers what is measured, an optional zone. Closed by the file's
 *  `afterEach(closeOpenContexts)` — never a `finally`, which a timeout skips. */
export async function spectator(
  browser: Browser,
  opts: { width: number; height?: number; timezoneId?: string },
): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width: opts.width, height: opts.height ?? 844 },
    ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}),
  });
  openContexts.push(ctx);
  return ctx.newPage();
}

/** A spectator's request context with EMPTY storage. A bare
 *  `request.newContext()` inherits the project's signed-in state. Dispose it. */
export async function anonymousRequest(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000",
    storageState: { cookies: [], origins: [] },
  });
}

/** GET a public JSON document as a spectator; `{status, data}` with `data` the
 *  body's `data` envelope when present. */
export async function publicJson<T>(path: string): Promise<{ status: number; data: T | undefined }> {
  const anon = await anonymousRequest();
  try {
    const res = await anon.get(path);
    const body = (await res.json().catch(() => undefined)) as { data?: T } | undefined;
    return { status: res.status(), data: body?.data };
  } finally {
    await anon.dispose();
  }
}

// ---------------------------------------------------------------------------
// Player stats: a READ folds nothing
// ---------------------------------------------------------------------------
//
// Option-B stats merge (owner rulings 2026-09-16/17): a result, undo, import or
// config write schedules the division's fold after its response. A stats or hub
// read only queues a reconcile, after its own response, at most once a minute
// per division; it refolds only when the snapshot is behind a SETTLED fixture or
// a settled input. The fold itself reads every event in the division, a match
// still in play included (`foldDivision`, no status filter), and a refresh that
// finds the ledger moved at all refolds everything it reads.

const REFRESH_SOURCE = "src/server/usecases/player-stats-refresh.ts";

/** The longest a scheduled fold can take to land, from the refresh module's
 *  own `REFRESH_TIMING`: every lock backoff, the one blocking try and one
 *  statement's ceiling. A renamed field throws, never a guessed budget. Call it
 *  inside a test (see the header). */
export function statsFoldLandMs(): number {
  const block = /export const REFRESH_TIMING\b[^=]*=\s*\{([\s\S]*?)\n\};/.exec(sourceText(REFRESH_SOURCE))?.[1] ?? "";
  const ms = (raw: string | undefined, name: string) => {
    const n = Number((raw ?? "").trim().replaceAll("_", ""));
    if (raw === undefined || !Number.isFinite(n)) throw new Error(`REFRESH_TIMING.${name} not found in ${REFRESH_SOURCE}`);
    return n;
  };
  const backoffs = (/backoffMs: \[([^\]]*)\]/.exec(block)?.[1] ?? "").split(",").filter((v) => v.trim() !== "");
  if (backoffs.length === 0) throw new Error(`REFRESH_TIMING.backoffMs not found in ${REFRESH_SOURCE}`);
  return (
    backoffs.reduce((sum, v) => sum + ms(v, "backoffMs"), 0) +
    ms(/lockTimeoutMs: ([\d_]+)/.exec(block)?.[1], "lockTimeoutMs") +
    ms(/statementTimeoutMs: ([\d_]+)/.exec(block)?.[1], "statementTimeoutMs")
  );
}

/** Poll a division's public stats JSON until a scheduled fold has landed: its
 *  rows appear. Spaced out, because every public v1 route shares one per-IP
 *  rate limit. */
export async function awaitStatsFold(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  budgetMs: number,
): Promise<void> {
  const path = `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/divisions/${divSlug}/stats`;
  await expect
    .poll(async () => (await publicJson<{ rows?: unknown[] }>(path)).data?.rows?.length ?? 0, {
      message: `the stats fold never landed: ${path} served no rows within ${budgetMs}ms`,
      timeout: budgetMs,
      intervals: [500, 1_000, 2_000],
    })
    .toBeGreaterThan(0);
}

/** Marks the open page so an assertion can prove it was never reloaded or
 *  navigated: a `load` counter, a `window` marker only a reload clears, and
 *  the pathname (lifted from `hub-knockout.spec.ts`'s R10 test). */
export async function noReloadGuard(page: Page): Promise<(where: string) => Promise<void>> {
  const pathname = new URL(page.url()).pathname;
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  await page.evaluate(() => {
    (window as unknown as { __w2SamePage?: boolean }).__w2SamePage = true;
  });
  return async (where: string) => {
    expect(loads, `${where}: a load event fired, so the page reloaded`).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __w2SamePage?: boolean }).__w2SamePage === true),
      `${where}: the in-page marker is gone, so the document was replaced`,
    ).toBe(true);
    expect(new URL(page.url()).pathname, `${where}: the page navigated`).toBe(pathname);
  };
}

/** Resolves once the page's own fetch of `apiPath` has come back, so a write
 *  posted next lands in a known place in the poll cycle. */
export async function lineUpOnPoll(page: Page, apiPath: string, timeout: number): Promise<boolean> {
  return page
    .waitForResponse((res) => new URL(res.url()).pathname === apiPath, { timeout })
    .then(
      () => true,
      () => false,
    );
}

/** The hub's line-up: at once when realtime is up, else after a poll tick. */
export async function lineUpOnHubTransport(page: Page, apiPath: string, timeout: number): Promise<string | null> {
  return Promise.race([
    page
      .locator('[data-testid="mh-root"][data-transport="realtime"]')
      .waitFor({ timeout })
      .then(
        () => "realtime",
        () => null,
      ),
    lineUpOnPoll(page, apiPath, timeout).then((ok) => (ok ? "a poll tick" : null)),
  ]);
}

/** Stores a pre-write copy of `url` in THIS browser's HTTP cache. Public JSON
 *  is `s-maxage=30, stale-while-revalidate=300`, so an island that dropped
 *  `cache: "no-store"` would be answered from this copy — which is the
 *  regression the live cases exist to catch. */
export async function primeBrowserCache(page: Page, url: string): Promise<void> {
  const status = await page.evaluate(async (u) => (await fetch(u, { cache: "reload" })).status, url);
  expect(status, `priming the browser cache with ${url}`).toBe(200);
}

/** Every absolutely-positioned box inside the scroll region(s) matched by
 *  `selector` whose containing block lies OUTSIDE that region. Such a box is
 *  not clipped by the region's `overflow-x`, so a `.sr-only` header label far
 *  along a wide table extends the PAGE's scroll width instead — a sideways
 *  scroll with no visible culprit (T17, HB9b). Reading the containing block
 *  (`offsetParent`) rather than a pixel overflow makes this independent of
 *  font metrics and name lengths. Boxes that are not rendered (a folded
 *  column, a hidden tab) have no `offsetParent` and are skipped. */
export async function absoluteEscapes(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const region of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      for (const el of Array.from(region.querySelectorAll<HTMLElement>("*"))) {
        if (getComputedStyle(el).position !== "absolute") continue;
        const block = el.offsetParent;
        if (block === null || block === region || region.contains(block)) continue;
        out.push(
          `${region.getAttribute("data-testid") ?? region.tagName.toLowerCase()} > ${el.tagName.toLowerCase()}.${String(
            el.className,
          )} anchored to ${block.tagName.toLowerCase()}`,
        );
      }
    }
    return out;
  }, selector);
}

// ---------------------------------------------------------------------------
// The owner's capture matrix (T17 inventory: "screens at 320/390/768/1024/1280,
// captured to the test's own output and NOT committed")
// ---------------------------------------------------------------------------

export const SCREEN_WIDTHS = [320, 390, 768, 1024, 1280] as const;

/** A screen state. `open` puts it on screen AND asserts it is the state named —
 *  a live chip that has not turned on yet is not a picture of "live". */
export interface ShotState {
  name: string;
  open: (page: Page) => Promise<void>;
}

async function shoot(page: Page, dir: string, state: ShotState, width: number): Promise<void> {
  await state.open(page);
  await page.waitForTimeout(PAINT_SETTLE_MS);
  await page.screenshot({ path: `${dir}/${state.name}-${width}.png` });
}

/** Every state at every width, each on a fresh anonymous spectator page. */
export async function shootStates(
  browser: Browser,
  dir: string,
  states: readonly ShotState[],
  widths: readonly number[] = SCREEN_WIDTHS,
): Promise<void> {
  for (const width of widths) {
    const page = await spectator(browser, { width, height: 900 });
    for (const state of states) await shoot(page, dir, state, width);
    await page.context().close();
  }
}

/** One state on the page ALREADY open (a live state a fresh load could miss),
 *  resized through every width and put back as it was. No navigation. */
export async function shootInPlace(
  page: Page,
  dir: string,
  state: ShotState,
  widths: readonly number[] = SCREEN_WIDTHS,
): Promise<void> {
  const original = page.viewportSize();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await shoot(page, dir, state, width);
  }
  if (original) await page.setViewportSize(original);
}

/** Every named state was captured at every width, and at each width no state
 *  is pixel-identical to the one before it (AGENTS.md #10: identical pictures
 *  mean nothing opened). */
export function expectDistinctShots(dir: string, names: readonly string[], widths: readonly number[] = SCREEN_WIDTHS): void {
  for (const width of widths) {
    for (const name of names) {
      expect(existsSync(`${dir}/${name}-${width}.png`), `${name} @${width} was not captured`).toBe(true);
    }
    for (let i = 1; i < names.length; i++) {
      const a = readFileSync(`${dir}/${names[i - 1]}-${width}.png`);
      const b = readFileSync(`${dir}/${names[i]}-${width}.png`);
      expect(a.equals(b), `${names[i - 1]} and ${names[i]} @${width} are pixel-identical`).toBe(false);
    }
  }
}
