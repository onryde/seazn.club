import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, addEntrantsViaApi, createStageAndGenerate, TAG } from "./helpers";

// S10/#419 W8 — the three acceptance criteria the chassis session deferred to
// a real browser: the offline queue survives tab death, scoring continues
// with the network down, and the queue drains in order on reconnect with no
// duplicates (docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/
// S10-419-w8-chassis-renderer.md, "E2E (Playwright)"). Drives
// `/score/harness?fixture=<uuid>` (SCOREPAD_V2_HARNESS=1) in `?fixture=` mode
// only — real session cookie, real `/api/v1/fixtures/{id}/events`, real
// ledger, real 409s. The no-fixture in-page-ledger mode is explicitly NOT
// evidence about the server contract (harness-client.tsx's own header) and
// nothing here is judged on it.
//
// SPORT CHOICE: `generic`'s `generic.score` tally action (packages/engine/
// src/sports/generic/generic.ts) is the only REPEATABLE action in the whole
// engine cheap enough to drive without a real roster — `generic.result`
// (every other module's terminal card) fires once and settles the match, so
// it cannot produce "several queued events". `generic.score` still declares
// a REQUIRED `side` attribution (`by: EntrantId`) though, which the S10
// chassis session left unwired in the harness (attribution picker is a typed
// seam, "a later pass" per its own header) — wiring it was this session's
// harness change (harness-client.tsx), because the alternative (submit
// without `by`) is a 422 the engine's own zod schema throws, which is not
// evidence about the QUEUE at all.
//
// TWO WAYS OF GOING "OFFLINE", DELIBERATELY DIFFERENT PER SCENARIO:
//  - Airplane mode uses the real `context.setOffline()` — mandated by the
//    brief, and safe here because that scenario never navigates again.
//  - Tab death and the 409 scenario use `page.route(...).abort()` scoped to
//    the fixture's own events endpoint instead. Still a REAL network-layer
//    failure (fetch() rejects exactly as it would fully offline —
//    transport.ts's appendEvent catches it as the same "network-error"
//    branch), never a JS/transport stub — but `context.setOffline(true)`
//    blocks EVERY request from the page, including a `page.reload()`'s own
//    document fetch, and tab death's whole claim depends on a real reload
//    succeeding mid-scenario. The standalone `request` fixture (a separate
//    APIRequestContext, never a browser request) is untouched by either
//    mechanism, which is what lets it act as a genuine out-of-band writer in
//    the 409 scenario.
//
// WHY QUEUE DEPTH IS READ FROM INDEXEDDB, NOT THE STATUS PILL:
// pad-renderer.tsx's queue label is a single string that shows EITHER the
// offline message OR a "{count} queued" count, never both (queueAttention's
// own ternary) — so there is no visible text that carries a reliable digit
// while a drain is blocked. `queueRowCount` below reads the exact same
// durable object store queue.ts's own `depth()` reads (queue-store.ts's
// "pending-events"), directly via IndexedDB from inside the browser — still
// the real, durable, browser-owned queue, just not routed through a label
// that structurally cannot show a number and the offline banner at once. The
// offline/synced TEXT assertions below (read from the shipped dictionary,
// never retyped — this pad's copy is localized) cover "the pad shows an
// explicit state"; the IndexedDB reads cover "how many, exactly".
const uiEn = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const ADD_POINTS_LABEL = uiEn["pad.generic.action.addPoints"];
const OFFLINE_TEXT = uiEn["scorepad.queue.offline"];
const SYNCED_TEXT = uiEn["scorepad.queue.synced"];

const QUEUE_DB_NAME = "scorepad-harness-generic";
const PENDING_STORE = "pending-events";

interface GenericFixture {
  fixtureId: string;
  home: string;
  away: string;
}

/**
 * A fresh, undecided, 2-entrant `generic`/`score` fixture, entirely via API.
 * `seedScoredDivision` (helpers.ts:986) does not fit: it always settles every
 * fixture with a `generic.result` (this suite needs an UNDECIDED fixture to
 * append repeatable `generic.score` events onto) and returns no fixture or
 * entrant ids (this suite needs both — the harness's `?fixture=` and its new
 * `?home=`/`?away=` params, see page.tsx). `createStageAndGenerate` (:859)
 * and `addEntrantsViaApi` (:842) DO fit and are reused as-is.
 */
async function setupGenericFixture(request: APIRequestContext, label: string): Promise<GenericFixture> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Scorepad e2e ${label} ${TAG}`,
    ends_on: "2030-12-31",
    visibility: "public",
  });
  expect(comp.status, `create competition: ${comp.error?.message ?? ""}`).toBe(201);
  const competitionId = comp.data!.id;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status, `create division: ${div.error?.message ?? ""}`).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await addEntrantsViaApi(request, divisionId, ["Alpha", "Bravo"], "individual");
  expect(entrants.status, "add entrants").toBe(201);

  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  expect(fixtureIds.length, "a 2-entrant league round-robin generates exactly one fixture").toBe(1);
  const fixtureId = fixtureIds[0]!;

  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start division: ${started.error?.message ?? ""}`).toBe(200);

  const fx = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }>(
    request,
    `/api/v1/fixtures/${fixtureId}`,
  );
  expect(fx.status, "read fixture").toBe(200);
  const home = fx.data!.home_entrant_id;
  const away = fx.data!.away_entrant_id;
  if (!home || !away) throw new Error(`fixture ${fixtureId} has no home/away entrant`);
  return { fixtureId, home, away };
}

function harnessUrl(fx: GenericFixture): string {
  const p = new URLSearchParams({
    fixture: fx.fixtureId,
    sport: "generic",
    variant: "score",
    home: fx.home,
    away: fx.away,
  });
  return `/score/harness?${p.toString()}`;
}

/** Counts rows in the pad's own durable IndexedDB queue — see the file
 *  header for why this, rather than the status pill, is this suite's source
 *  of truth for a NUMBER. */
async function queueRowCount(page: Page, dbName: string): Promise<number> {
  return page.evaluate(
    ({ name, store }) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction(store, "readonly");
          const countReq = tx.objectStore(store).count();
          countReq.onsuccess = () => {
            resolve(countReq.result);
            db.close();
          };
          countReq.onerror = () => reject(countReq.error ?? new Error("count failed"));
        };
        req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
      }),
    { name: dbName, store: PENDING_STORE },
  );
}

/** The fixture's full ledger from seq 0 — the no-duplicates oracle every
 *  scenario below reads instead of the UI (brief's own instruction). */
async function ledgerOf(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ seq: number; type: string; payload: unknown }[]> {
  const res = await apiJson<{ seq: number; type: string; payload: unknown }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `GET events: ${res.error?.message ?? ""}`).toBe(200);
  return res.data!;
}

/** Expand "Add points", fill the (cfg-derived, un-localized — view-model.ts's
 *  `deriveFieldPathLabel`) "Points" field, pick the Home side chip via its
 *  `data-value` (the real entrant id, never text), Confirm. Every call site
 *  below uses a DISTINCT points value so the final ledger assertion pins an
 *  exact payload per slot, not merely a count. */
async function pressAddPoints(page: Page, homeEntrantId: string, points: number): Promise<void> {
  await page.getByRole("button", { name: ADD_POINTS_LABEL, exact: true }).click();
  await page.getByLabel("Points", { exact: true }).fill(String(points));
  await page.locator(`[data-value="${homeEntrantId}"]`).click();
  await page.locator('[data-role="confirm"]').click();
}

function scoreEvents(entrantId: string, ...points: number[]): { type: string; payload: unknown }[] {
  return points.map((n) => ({ type: "generic.score", payload: { by: entrantId, points: n } }));
}

// The harness route is `notFound()` unless the SERVER was started with
// SCOREPAD_V2_HARNESS=1 (page.tsx), so on a target that does not set it these
// three specs would fail on a missing button and read as a chassis defect.
// Skip instead — but LOUDLY, and only after PROVING the route is absent for
// that reason (a 404), never on a bare env-var read from the runner's own
// process, which says nothing about the server under test. A silent skip is
// the "test that cannot fail" shape this programme has shipped four times.
test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL ?? ""}/score/harness?sport=generic`);
  if (res.status() === 404) {
    console.warn(
      "[scorepad-offline] SKIPPED: /score/harness returned 404 — this server was started without SCOREPAD_V2_HARNESS=1. The durable-queue criteria are NOT covered by this run.",
    );
  }
  test.skip(res.status() === 404, "harness route disabled on this target (SCOREPAD_V2_HARNESS unset)");
});

test("tab death mid-queue: the durable queue survives a real reload and drains in order with no duplicates", async ({
  page,
  request,
}) => {
  const fx = await setupGenericFixture(request, "tabdeath");
  await page.goto(harnessUrl(fx));
  await expect(page.getByRole("button", { name: ADD_POINTS_LABEL, exact: true })).toBeVisible();

  const eventsUrl = (url: URL): boolean => url.pathname === `/api/v1/fixtures/${fx.fixtureId}/events`;
  await page.route(eventsUrl, (route) => route.abort());

  await pressAddPoints(page, fx.home, 1);
  await pressAddPoints(page, fx.home, 2);
  await pressAddPoints(page, fx.home, 3);

  await expect.poll(() => queueRowCount(page, QUEUE_DB_NAME)).toBe(3);
  await expect(page.getByTestId("scorepad-harness")).toContainText(OFFLINE_TEXT);
  expect((await ledgerOf(request, fx.fixtureId)).length, "nothing reached the server yet").toBe(0);

  // Tab death: a real reload, not a soft re-render. The route persists on
  // this `page` across the navigation (Playwright routes survive reload
  // until explicitly removed), so the fresh mount's own resume-drain attempt
  // still fails and the queue stays exactly as IndexedDB left it.
  await page.reload();
  await expect(page.getByRole("button", { name: ADD_POINTS_LABEL, exact: true })).toBeVisible();
  await expect
    .poll(() => queueRowCount(page, QUEUE_DB_NAME), {
      message: "the queue must survive a real reload — nothing in-memory did",
    })
    .toBe(3);
  expect((await ledgerOf(request, fx.fixtureId)).length, "still nothing on the server").toBe(0);

  await page.unrouteAll();
  // Nothing in the app polls "is the network back" independently — it only
  // reacts to mount, a `submit()` call, or a real `online` event. This
  // dispatches that exact signal without racing a second real reconnect.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect(page.getByTestId("scorepad-harness")).toContainText(SYNCED_TEXT);
  await expect.poll(() => queueRowCount(page, QUEUE_DB_NAME)).toBe(0);

  const ledger = await ledgerOf(request, fx.fixtureId);
  expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual(scoreEvents(fx.home, 1, 2, 3));
});

test("airplane mode: scoring continues offline, an explicit offline state and non-zero queue show, and the queue drains to empty on reconnect", async ({
  page,
  context,
  request,
}) => {
  const fx = await setupGenericFixture(request, "airplane");
  await page.goto(harnessUrl(fx));
  await expect(page.getByRole("button", { name: ADD_POINTS_LABEL, exact: true })).toBeVisible();

  // The real thing (brief's own requirement), not a stubbed transport —
  // this scenario never navigates again, so there is no reload for a
  // context-wide block to fight.
  await context.setOffline(true);

  await pressAddPoints(page, fx.home, 10);
  await pressAddPoints(page, fx.home, 20);

  await expect(page.getByTestId("scorepad-harness")).toContainText(OFFLINE_TEXT);
  await expect.poll(() => queueRowCount(page, QUEUE_DB_NAME)).toBe(2);
  expect((await ledgerOf(request, fx.fixtureId)).length, "nothing reached the server while offline").toBe(0);

  await context.setOffline(false);

  await expect(page.getByTestId("scorepad-harness")).toContainText(SYNCED_TEXT);
  await expect.poll(() => queueRowCount(page, QUEUE_DB_NAME)).toBe(0);

  const ledger = await ledgerOf(request, fx.fixtureId);
  expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual(scoreEvents(fx.home, 10, 20));
});

test("a 409 mid-drain resyncs against the ledger and completes with no duplicates", async ({ page, request }) => {
  const fx = await setupGenericFixture(request, "conflict");
  await page.goto(harnessUrl(fx));
  await expect(page.getByRole("button", { name: ADD_POINTS_LABEL, exact: true })).toBeVisible();

  const eventsUrl = (url: URL): boolean => url.pathname === `/api/v1/fixtures/${fx.fixtureId}/events`;
  await page.route(eventsUrl, (route) => route.abort());

  await pressAddPoints(page, fx.home, 5);
  await pressAddPoints(page, fx.home, 15);
  await expect.poll(() => queueRowCount(page, QUEUE_DB_NAME)).toBe(2);

  // Out-of-band: the standalone `request` fixture is its own
  // APIRequestContext (never a browser request, so page.route above never
  // sees it) landing a genuine, server-accepted write at expected_seq=0 —
  // the EXACT slot the client's first queued event still believes is free.
  // A different `by` AND a sentinel `points` value so content comparison
  // alone (pipeline.ts's resolveConflict) unambiguously reads this as
  // foreign, never "our own event replayed".
  const outOfBand = await apiJson(request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "generic.score",
    payload: { by: fx.away, points: 999 },
  });
  expect(outOfBand.status, `out-of-band append: ${outOfBand.error?.message ?? ""}`).toBe(201);

  await page.unrouteAll();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect(page.getByTestId("scorepad-harness")).toContainText(SYNCED_TEXT);
  await expect.poll(() => queueRowCount(page, QUEUE_DB_NAME)).toBe(0);

  // Every one of the three events, exactly once, out-of-band first (it
  // landed first, chronologically) then the client's own two in their
  // original submission order — each having renegotiated its expected_seq
  // exactly once around the foreign slot, per the S10 replay ruling.
  const ledger = await ledgerOf(request, fx.fixtureId);
  expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual([
    ...scoreEvents(fx.away, 999),
    ...scoreEvents(fx.home, 5, 15),
  ]);
});
