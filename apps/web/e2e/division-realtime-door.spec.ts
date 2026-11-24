import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate } from "./helpers";

// Realtime push nudges, Task 13 (plan 2026-11-24, spec §4.2 and §5 "E2E"): the
// competition hub, the organiser slideshow and the organiser schedule board ask
// the competition's division door (`GET /api/v1/public/competitions/{id}/realtime-token`)
// for the token that admits them to PRIVATE `division:{id}` topics — and when
// the door refuses (403), each page still updates on its own poll, silently.
//
// CI's e2e runs on a stub Supabase project with no Realtime socket, so nothing
// here waits for a push: the door's CALL is the seam this file proves, and the
// poll is the liveness it proves. Timing of a real push lives in the STG-local
// probe `e2e/probes/realtime-nudge-division.spec.ts` (CS-4).
//
// The poll intervals are read out of the source, not typed here, so a change
// of cadence moves this file with it (same reason as hub-knockout.spec.ts's
// `hubPollMs`: a spec that imports a src module whose chain reaches a JSON
// import fails to COLLECT).
//
// Applies to another sport: N/A (no sport rules; a generic score league).

function constFrom(relative: string, name: string): number {
  const source = readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");
  const match = new RegExp(`export const ${name} = ([\\d_]+);`).exec(source);
  if (!match) return Number.NaN;
  return Number(match[1]!.replaceAll("_", ""));
}
const HUB_POLL_MS = constFrom("components/public-site/use-live-competition.ts", "HUB_POLL_MS");
const SLIDESHOW_POLL_MS = constFrom("components/v2/slideshow.tsx", "SLIDESHOW_POLL_MS");
const BOARD_POLL_MS = constFrom("components/v2/board/use-board-actions.ts", "BOARD_POLL_MS");

/** On top of one poll interval: the refetch, React's render, a busy runner. */
const LAND_SLACK_MS = 10_000;
const API_CALL_MS = 1_500;
const FLOOR_MS = 60_000;
/** Org; competition; division create; entrants; stage + generate; start; fixtures; one fixture's state + start; hub. */
const SEED_CALLS = 1 + 1 + 1 + 1 + 2 + 1 + 1 + 2 + 1;
const SEED_BUDGET_MS = FLOOR_MS + SEED_CALLS * API_CALL_MS;

const DOOR = /\/api\/v1\/public\/competitions\/([^/]+)\/realtime-token$/;
const isDoor = (url: string, competitionId: string) => DOOR.exec(new URL(url).pathname)?.[1] === competitionId;
const isRefresh = (req: Request, path: string) =>
  req.method() === "GET" && new URL(req.url()).pathname === path && new URL(req.url()).searchParams.has("_rsc");

async function activeOrgSlug(request: APIRequestContext) {
  const orgs = await apiJson<{ id: string; slug: string }[]>(request, "/api/orgs");
  const active = (await request.storageState()).cookies.find((c) => c.name === "seazn_org")?.value;
  const org = orgs.data?.find((o) => o.id === active) ?? orgs.data?.[0];
  if (!org) throw new Error("no org for the e2e session");
  return org.slug;
}

async function startFixture(request: APIRequestContext, fixtureId: string) {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(state.status, JSON.stringify(state.error)).toBe(200);
  const begun = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "core.start",
    payload: {},
  });
  expect(begun.status, JSON.stringify(begun.error)).toBeLessThan(300);
}

/** Refuse the door the way the server would for a non-entitled org: the page must poll, with no error UI. */
async function refuseDoor(page: Page, competitionId: string) {
  let refused = 0;
  await page.route(
    (url) => isDoor(url.href, competitionId),
    async (route) => {
      refused += 1;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "realtime not available" }, requestId: "e2e" }),
      });
    },
  );
  return () => refused;
}

test.describe("division realtime door: the hub, the slideshow and the board ask it, and poll when it refuses", () => {
  // One seeding for the file; NOT serial, so a red does not skip the rest (AGENTS.md 21).
  test.describe.configure({ mode: "default" });

  let orgSlug = "";
  let competition = { id: "", slug: "" };
  let liveFixtureId = "";
  /** A fixture on other entrants than the live one: the 403 test starts it while the page is open. */
  let laterFixtureId = "";

  test.beforeAll(async ({ playwright }, testInfo) => {
    testInfo.setTimeout(SEED_BUDGET_MS);
    const request = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: testInfo.project.use.storageState,
    });
    try {
      orgSlug = await activeOrgSlug(request);
      const comp = await apiJson<{ id: string; slug: string; visibility: string }>(request, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `RT Door ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
        visibility: "public",
      });
      expect(comp.status, JSON.stringify(comp.error)).toBe(201);
      expect(comp.data!.visibility).toBe("public");
      competition = { id: comp.data!.id, slug: comp.data!.slug };

      const created = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competition.id}/divisions`, "POST", {
        name: "League",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      const divisionId = created.data!.id;
      const added = await addEntrantsViaApi(request, divisionId, ["North", "South", "East", "West"]);
      expect(added.ids).toHaveLength(4);
      const { fixtureIds } = await createStageAndGenerate(request, divisionId);
      expect(fixtureIds.length).toBeGreaterThan(1);
      const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
      expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);

      const rows = await apiJson<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>(
        request,
        `/api/v1/divisions/${divisionId}/fixtures`,
      );
      expect(rows.status, JSON.stringify(rows.error)).toBe(200);
      const first = rows.data!.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
      const sides = new Set([first.home_entrant_id, first.away_entrant_id]);
      const other = rows.data!.find(
        (f) => f.id !== first.id && f.home_entrant_id !== null && f.away_entrant_id !== null && !sides.has(f.home_entrant_id) && !sides.has(f.away_entrant_id),
      );
      expect(other, "a round-robin of four has a fixture on the other two entrants").toBeTruthy();
      liveFixtureId = first.id;
      laterFixtureId = other!.id;

      // One match in play: the hub's live cadence (HUB_POLL_MS) and its reason to want a division channel.
      await startFixture(request, liveFixtureId);

      // The premise every hub test rests on: the document says realtime, so the hub asks.
      const hub = await apiJson<{ realtime: boolean; competitionId: string; matches: { fixtureId: string; bucket: string }[] }>(
        request,
        `/api/v1/public/orgs/${orgSlug}/competitions/${competition.slug}/hub`,
      );
      expect(hub.status).toBe(200);
      expect(hub.data!.competitionId).toBe(competition.id);
      expect(hub.data!.realtime, "premise: the e2e org is entitled to realtime").toBe(true);
      expect(hub.data!.matches.find((m) => m.fixtureId === liveFixtureId)?.bucket).toBe("live");
    } finally {
      await request.dispose();
    }
  });

  test("the hub asks the door for ITS competition, private and no-store, and the token is nowhere on the page", async ({ browser }, testInfo) => {
    expect(Number.isFinite(HUB_POLL_MS), "HUB_POLL_MS read out of use-live-competition.ts").toBe(true);
    // A spectator: no session cookie.
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      const asked = page.waitForResponse((res) => isDoor(res.url(), competition.id), { timeout: HUB_POLL_MS + LAND_SLACK_MS });
      await page.goto(`/live/${orgSlug}/${competition.slug}`);
      const res = await asked;
      expect(new URL(res.url()).search, "the door is asked with nothing in its query").toBe("");
      // 200, not "200 or 503": e2e.yml gives the server a stub Supabase project, an anon key and the JWT secret, so the
      // door MINTS (match-day.spec.ts asserts the same 200 on the same env). A 503 here is a server missing that env,
      // and must fail loudly rather than skip every token-leak check below.
      expect(res.status(), "the e2e server mints (e2e.yml: NEXT_PUBLIC_SUPABASE_URL, _ANON_KEY, SUPABASE_JWT_SECRET)").toBe(200);
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      const token = ((await res.json()) as { data: { token: string } }).data.token;
      expect(token.length).toBeGreaterThan(20);
      expect(await page.content(), "the token is in the page's HTML").not.toContain(token);
      expect(page.url()).not.toContain(token);

      // Browser storage, every key and every value, both areas. A canary proves the scan reads what a page holds (a
      // scan of an empty area would pass for any token); the token is then asked of the SAME dump.
      await page.evaluate(() => {
        localStorage.setItem("__scan_canary_local__", "canary-local");
        sessionStorage.setItem("__scan_canary_session__", "canary-session");
      });
      const stored = await page.evaluate(() => {
        const dump: { area: string; key: string; value: string }[] = [];
        for (const [area, store] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]] as const) {
          for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i)!;
            dump.push({ area, key, value: store.getItem(key) ?? "" });
          }
        }
        return dump;
      });
      expect(stored.map((e) => e.key), "the storage scan read nothing: it proves nothing").toEqual(
        expect.arrayContaining(["__scan_canary_local__", "__scan_canary_session__"]),
      );
      for (const entry of stored) {
        expect(entry.key, `${entry.area} key`).not.toContain(token);
        expect(entry.value, `${entry.area}[${entry.key}]`).not.toContain(token);
      }
      await expect(page.getByTestId("mh-root")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("hub, door refused (403): no error on screen, and a match that starts lands within one poll interval", async ({ browser, request }, testInfo) => {
    test.setTimeout(Math.max(FLOOR_MS, HUB_POLL_MS + 2 * LAND_SLACK_MS + 4 * API_CALL_MS));
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      const refused = await refuseDoor(page, competition.id);
      await page.goto(`/live/${orgSlug}/${competition.slug}`);
      const liveMarker = (fixtureId: string) => page.locator(`[data-testid="mh-match-${fixtureId}"] [data-testid="mh-match-live"]`);
      await expect(liveMarker(liveFixtureId).first()).toBeVisible();
      await expect.poll(refused, { message: "the hub never asked the door" }).toBe(1);
      await expect(page.locator('[data-testid="mh-root"][data-transport="poll"]')).toBeVisible();
      // The premise: the second match is not live on this page yet.
      await expect(liveMarker(laterFixtureId)).toHaveCount(0);

      await startFixture(request, laterFixtureId);
      await expect(liveMarker(laterFixtureId).first(), "the match that started never reached the page on the poll").toBeVisible({
        timeout: HUB_POLL_MS + LAND_SLACK_MS,
      });
      // The refusal stays silent and is not retried on every tick.
      expect(refused()).toBe(1);
    } finally {
      await context.close();
    }
  });

  test("organiser slideshow asks the door; refused (403), it still refreshes on its poll", async ({ page }) => {
    expect(Number.isFinite(SLIDESHOW_POLL_MS), "SLIDESHOW_POLL_MS read out of slideshow.tsx").toBe(true);
    test.setTimeout(Math.max(FLOOR_MS, SLIDESHOW_POLL_MS + 2 * LAND_SLACK_MS));
    const path = `/slideshow/competitions/${competition.id}`;
    const refused = await refuseDoor(page, competition.id);
    await page.goto(path);
    await expect.poll(refused, { message: "the slideshow never asked the door" }).toBe(1);
    const refreshed = await page.waitForRequest((req) => isRefresh(req, path), { timeout: SLIDESHOW_POLL_MS + LAND_SLACK_MS });
    expect(refreshed.url()).not.toContain("token");
    expect(refused()).toBe(1);
  });

  test("organiser board asks the door; refused (403), its 60 s safety net still refreshes it", async ({ page }) => {
    expect(Number.isFinite(BOARD_POLL_MS), "BOARD_POLL_MS read out of use-board-actions.ts").toBe(true);
    test.setTimeout(Math.max(FLOOR_MS, BOARD_POLL_MS + 2 * LAND_SLACK_MS));
    const path = `/o/${orgSlug}/c/${competition.slug}/schedule`;
    const refused = await refuseDoor(page, competition.id);
    await page.goto(path);
    await expect.poll(refused, { message: "the board never asked the door" }).toBe(1);
    const refreshed = await page.waitForRequest((req) => isRefresh(req, path), { timeout: BOARD_POLL_MS + LAND_SLACK_MS });
    expect(refreshed.url()).not.toContain("token");
    expect(refused()).toBe(1);
  });
});
