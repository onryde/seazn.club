import { test, expect, type Page } from "@playwright/test";
import { apiJson, mintLoginPathBySql, seedScoredDivision, TAG } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import {
  assertPropagatedUnderPoll,
  expectObservableIdle,
  measurePropagation,
  padPollMs,
  watchFixtureRealtime,
} from "./realtime-propagation-kit";

// Courtside device-link scoring: an editor mints a one-per-fixture dl_ token;
// the token alone opens the score pad and authorises event writes. Pro-only.

const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";

test("device link opens the pad anonymously and authorises scoring", async ({
  request,
  browser,
  playwright,
}) => {
  const { fixtureIds } = await (async () => {
    const seeded = await seedScoredDivision(request, ["Echo", "Foxtrot"], { decide: false });
    const gen = await apiJson<{ fixtures: { id: string }[] }>(
      request,
      `/api/v1/stages/${seeded.stageId}/generate`,
      "POST",
    );
    return { fixtureIds: gen.data!.fixtures.map((f) => f.id) };
  })();
  const fixtureId = fixtureIds[0]!;

  const minted = await apiJson<{ id: string; secret: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}/device-links`,
    "POST",
    { label: "Court 1" },
  );
  expect(minted.status).toBe(201);
  const secret = minted.data!.secret;
  expect(secret.startsWith("dl_")).toBe(true);

  // A signed-out browser opens the pad from the token alone. Explicit empty
  // state: `browser.newContext()` inherits `use.storageState` from
  // playwright.config.ts, so a bare context carries the e2e organiser's
  // cookie and the word "anonymously" would be a claim this test cannot make.
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await anonCtx.newPage();
    await page.goto(`/score/${secret}`);
    await expect(page.getByText(/Echo|Foxtrot/).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await anonCtx.close();
  }

  // Control BEFORE the grant: no cookie and no token is refused outright. If
  // this ever passes, the contexts below are carrying the organiser's session
  // and every success under them is measuring the cookie, not the link.
  const noCred = await playwright.request.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const anon = await noCred.get(`/api/v1/fixtures/${fixtureId}/state`);
    expect(anon.status()).toBe(401);
    expect(((await anon.json()) as { error?: { code?: string } }).error?.code).toBe(
      "UNAUTHENTICATED",
    );
  } finally {
    await noCred.dispose();
  }

  // The token is also the API credential for this fixture's events.
  const dlApi = await playwright.request.newContext({
    baseURL: BASE,
    // `playwright.request.newContext()` inherits `use.storageState` too, and
    // here it is NOT harmless the way it is in the refusal test below: this is
    // a SUCCESS claim, so an inherited editor cookie authorises the read and
    // the write with no token at all. Measured 2026-09-03 — with the
    // Authorization header deleted and the context left bare, this test still
    // passed.
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  try {
    const state = await dlApi.get(`/api/v1/fixtures/${fixtureId}/state`);
    expect(state.ok()).toBe(true);
    const lastSeq = ((await state.json()) as { data: { last_seq: number } }).data.last_seq;
    const event = await dlApi.post(`/api/v1/fixtures/${fixtureId}/events`, {
      data: { expected_seq: lastSeq, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
    });
    expect(event.ok()).toBe(true);
  } finally {
    await dlApi.dispose();
  }
});

// The seam the test above and the realtime test below BOTH miss, because each
// drives one end directly: `/score/<dl_>` opens the real pad, and the pad's own
// live-update hook mints its own realtime token from a SEPARATE public endpoint
// (`useFixtureStream`, not the transport). That request is the only place the
// `auth` prop matters, and the chain that carries it —
// device-score-pad -> registry -> PadHostV3 -> usePadPipeline -> useFixtureStream
// — silently dropped it at the PadHostV3 mount, so every device-link pad asked
// for the token anonymously, was refused on a private competition, and fell
// back to the 15s poll with no error. Only a real browser on the real page can
// see this: the route's own e2e and the hook's own unit test both supply the
// header themselves.
// Budget derived from the waits below plus the API seeding ahead of them, not
// a flat literal: move either wait and the budget moves with it. A flat 60s
// against a derived cost is a latent red, and the way it reds is misleading —
// on a `setTimeout` Playwright prints whichever `expect.poll` was in flight, so
// a wall-clock overrun would surface as "the pad never asked for a realtime
// token", a data-shaped lie, above the timeout line.
const PAD_MOUNT_MS = 20_000; // boot the page and paint an entrant name; then Start → the pad
const TOKEN_WAIT_MS = 20_000; // then the mount effect's token round trip
const REALTIME_SEED_MS = 40_000; // seed + generate + mint + goto, generously

test("the device-link pad sends its dl_ token to the realtime-token door", async ({
  request,
  browser,
}) => {
  // Two mounts: the Confirm card, then the pad Start mounts (scorer sheets §4.5.1).
  test.setTimeout(REALTIME_SEED_MS + 2 * PAD_MOUNT_MS + TOKEN_WAIT_MS);
  const seeded = await seedScoredDivision(request, ["Sierra", "Tango"], { decide: false });
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${seeded.stageId}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;

  const minted = await apiJson<{ secret: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}/device-links`,
    "POST",
    { label: "Court 7" },
  );
  expect(minted.status).toBe(201);
  const secret = minted.data!.secret;

  // Signed OUT, for the same reason the test above says: `browser.newContext()`
  // inherits `use.storageState`, and an organiser cookie would authorise the
  // token door by itself and make the header irrelevant. No cookies, only a
  // seeded consent choice, so the banner cannot sit over the Start button.
  const anonCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  // Hoisted out of the try so `finally` can unroute it — see the note there.
  const page = await anonCtx.newPage();
  try {
    // Armed BEFORE the navigation: the hook fires this request from its mount
    // effect, so a listener attached after `goto` resolves is a race.
    const authHeaders: (string | undefined)[] = [];
    const tokenStatuses: number[] = [];
    await page.route("**/api/v1/public/fixtures/*/realtime-token", async (route) => {
      authHeaders.push(route.request().headers()["authorization"]);
      // The DOOR'S ANSWER, not only the request. Asserting the header alone is
      // the vacuous half: the pad can go on sending a perfectly correct
      // `Bearer dl_` while the route's device-link bypass
      // (`realtime-token/route.ts:25,46`) regresses underneath it, and the pad
      // drops back to the 15s poll with this test still green.
      const response = await route.fetch();
      tokenStatuses.push(response.status());
      await route.fulfill({ response });
    });

    await page.goto(`/score/${secret}`);
    // A not-yet-started scan opens on the Confirm card (scorer sheets §4.5.1);
    // the pad — and so its stream and its token request — mounts on Start.
    await expect(page.getByText(/Sierra|Tango/).first()).toBeVisible({ timeout: PAD_MOUNT_MS });
    expect(tokenStatuses, "no pad before Start, so no token request yet").toEqual([]);
    await page.getByTestId("score-start-match").click();
    // The pad itself has to be on screen, or a missing token request below
    // would only mean the pad never mounted.
    await expect(page.locator('[data-role="pad-v3"]')).toBeVisible({ timeout: PAD_MOUNT_MS });

    // Polled on the ANSWER, which the handler pushes after the header, so this
    // one wait covers both halves without spending a second budget on it.
    await expect
      .poll(() => tokenStatuses.length, {
        timeout: TOKEN_WAIT_MS,
        message: "the pad never asked for a realtime token, or the door never answered",
      })
      .toBeGreaterThan(0);

    // Shape AND value. A reachability-only assertion (`is there a header`)
    // would pass on a session pad's empty string, and `/^Bearer dl_/` alone
    // would pass on some OTHER fixture's live link — the exact-secret check is
    // what makes this the pad's own credential for THIS fixture.
    expect(authHeaders[0]).toMatch(/^Bearer dl_/);
    expect(authHeaders[0]).toBe(`Bearer ${secret}`);

    // And the door ANSWERED, rather than refusing at `route.ts:26`. Deliberately
    // not claimed: that the device-link branch (`:25`) is what granted it —
    // `fixtureRealtimeEligible` (`:23`) keys on the fixture's ORG holding the
    // `realtime` feature, and this seeded fixture's org may well hold it, so a
    // 200 here does not isolate the bypass. The cross-fixture test at the bottom
    // of this file is what pins that branch in isolation (403 anonymous, 200 with
    // the link, 403 one fixture over). What this adds is the half that test
    // cannot have: the same grant reached through the REAL pad, so a refusal
    // that sent the pad back to the 15s poll can no longer pass as green.
    expect(tokenStatuses[0]).toBe(200);
  } finally {
    // Retire the route BEFORE the context goes, or `route.fetch()` above dies
    // with "Request context disposed" (CI run 35706434734). The pad re-requests
    // its token on every resubscribe, so a callback is routinely still in
    // flight when the test body ends — this is not a rare race. Playwright's
    // own error names this as the cure; `ignoreErrors` is what makes it safe
    // for the in-flight callback rather than merely moving the throw.
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await anonCtx.close();
  }
});

test("device links are Pro-only", async ({ browser }) => {
  // A fresh user auto-provisions their own community org, so this test never
  // competes with journey-community for the SHARED community org's single
  // active-competition slot (a real race under parallel workers).
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(await mintLoginPathBySql(`delivered+e2e-dlgate-${TAG}@resend.dev`));
    await page.waitForURL(/\/(me|onboarding|o\/)/, { timeout: 15_000 });
    await page.close();
    const req = ctx.request;
    const comp = await apiJson<{ id: string }>(req, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `DL Gate ${Date.now().toString(36)}`,
      visibility: "private",
    });
    const div = await apiJson<{ id: string }>(
      req,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    await apiJson(req, `/api/v1/divisions/${div.data!.id}/entrants`, "POST", [
      { kind: "individual", display_name: "A", seed: 1 },
      { kind: "individual", display_name: "B", seed: 2 },
    ]);
    const stage = await apiJson<{ id: string }>(req, `/api/v1/divisions/${div.data!.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    });
    const gen = await apiJson<{ fixtures: { id: string }[] }>(
      req,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );

    const minted = await apiJson(
      req,
      `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/device-links`,
      "POST",
      { label: "Court 1" },
    );
    expect(minted.status).toBe(402);
    expect(minted.error?.code).toBe("PAYMENT_REQUIRED");

    // Tidy up the throwaway org's slot (not strictly needed — the org is
    // private to this test).
    const archived = await apiJson(req, `/api/v1/competitions/${comp.data!.id}`, "PATCH", {
      status: "archived",
    });
    expect(archived.status).toBeLessThan(300);
  } finally {
    await ctx.close();
  }
});

// The guard that keeps "scoring detail is free" from meaning "open scoring":
// a dl_ token is minted for ONE fixture and must not reach another, even a
// sibling in the same division and org. The unit suite drives
// requireFixtureActor directly; only this test crosses the real HTTP boundary,
// where routing, auth resolution and the HttpError→wire mapping all run.
test("a device link cannot score a fixture it does not own", async ({ request, playwright }) => {
  const seeded = await seedScoredDivision(request, ["Kilo", "Lima", "Mike", "November"], {
    decide: false,
  });
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${seeded.stageId}/generate`,
    "POST",
  );
  const fixtureIds = gen.data!.fixtures.map((f) => f.id);
  // Two fixtures is the premise of the whole test — assert it rather than let
  // `other` come back undefined and the refusal be about a malformed id.
  expect(fixtureIds.length).toBeGreaterThan(1);
  const own = fixtureIds[0]!;
  const other = fixtureIds[1]!;

  const minted = await apiJson<{ secret: string }>(
    request,
    `/api/v1/fixtures/${own}/device-links`,
    "POST",
    { label: "Court 9" },
  );
  expect(minted.status).toBe(201);
  const secret = minted.data!.secret;

  const dlApi = await playwright.request.newContext({
    baseURL: BASE,
    // Explicit: request.newContext() inherits `use.storageState` (see the
    // realtime test below). Harmless here — requireFixtureActor takes the dl_
    // branch before it ever looks at a cookie — but "the token is the only
    // credential" has to be true, not merely intended.
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  try {
    // Read the victim's ledger with the EDITOR's context, before and after —
    // the link itself is not allowed to look, so it cannot be the witness.
    const before = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${other}/state`);
    expect(before.status).toBe(200);

    const refused = await dlApi.post(`/api/v1/fixtures/${other}/events`, {
      data: {
        expected_seq: before.data!.last_seq,
        type: "generic.result",
        payload: { p1Score: 9, p2Score: 0 },
      },
    });
    expect(refused.status()).toBe(403);
    const body = (await refused.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(body.error?.message).toBe("This device link is for a different fixture");

    // The refusal is a shut door, not a logged complaint: nothing landed.
    const after = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${other}/state`);
    expect(after.data!.last_seq).toBe(before.data!.last_seq);

    // The same door refuses reads, so the link cannot even watch the fixture.
    const peek = await dlApi.get(`/api/v1/fixtures/${other}/state`);
    expect(peek.status()).toBe(403);

    // Control: the token is live and the division is scorable — it writes to
    // its OWN fixture. Without this, a 403 from an expired link, an unstarted
    // division or a bad payload would read as the ownership refusal.
    const ownState = await dlApi.get(`/api/v1/fixtures/${own}/state`);
    expect(ownState.ok()).toBe(true);
    const lastSeq = ((await ownState.json()) as { data: { last_seq: number } }).data.last_seq;
    const allowed = await dlApi.post(`/api/v1/fixtures/${own}/events`, {
      data: { expected_seq: lastSeq, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
    });
    expect(allowed.status()).toBe(201);
  } finally {
    await dlApi.dispose();
  }
});

// The other door the same ownership predicate guards: the public realtime
// token. It is NOT reachable on the seeds the tests above use — the eligibility
// chain is `fixtureRealtimeEligible || isFixtureOfficial || <device link owns
// it>`, and fixtureRealtimeEligible reads `public_fixtures_v`, so a PUBLIC
// competition on a Pro org (which is what seedScoredDivision builds) returns
// true and short-circuits before the device-link branch is consulted. On a
// PRIVATE competition it returns false, and the device link is the whole
// authorisation. Without this test that route can `return true` and nothing in
// the repo notices.
test("a device link mints a realtime token for its own fixture only (private competition)", async ({
  request,
  playwright,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `DL Realtime ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/entrants`,
    "POST",
    ["Oscar", "Papa", "Quebec", "Romeo"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const ids = gen.data!.fixtures.map((f) => f.id);
  expect(ids.length).toBeGreaterThan(1);
  const own = ids[0]!;
  const other = ids[1]!;
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");

  const minted = await apiJson<{ secret: string }>(
    request,
    `/api/v1/fixtures/${own}/device-links`,
    "POST",
    { label: "Court 9" },
  );
  expect(minted.status).toBe(201);
  const secret = minted.data!.secret;

  // storageState EXPLICITLY empty on both. `playwright.config.ts` sets
  // `use: { storageState: AUTH_STATE }` and `playwright.request.newContext()`
  // inherits it exactly as `browser.newContext()` does — measured here: with
  // the bare options this test PASSED its own-fixture 200 and then got 200 for
  // the OTHER fixture too, because the inherited editor cookie made
  // `isFixtureOfficial()` true and short-circuited the device-link branch
  // before it was ever consulted. An anonymous curl against the same two
  // fixtures returned 200/403 correctly. Naming a variable `anon` proves
  // nothing; passing the empty state does.
  const emptyState = { cookies: [], origins: [] };
  const dlApi = await playwright.request.newContext({
    baseURL: BASE,
    storageState: emptyState,
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  const anon = await playwright.request.newContext({ baseURL: BASE, storageState: emptyState });
  try {
    // Precondition, first, because everything below is vacuous without it:
    // this fixture is NOT eligible on its own. If it ever returns 200 the
    // competition is public, or the context is signed in, and the two
    // assertions after it prove nothing.
    const noToken = await anon.get(`/api/v1/public/fixtures/${own}/realtime-token`);
    expect(noToken.status()).toBe(403);

    // So a 200 here is the device-link branch granting it, and nothing else.
    const ownToken = await dlApi.get(`/api/v1/public/fixtures/${own}/realtime-token`);
    expect(ownToken.status()).toBe(200);
    const granted = (await ownToken.json()) as { data: { token: string; channel: string } };
    expect(granted.data.channel).toBe(`fixture:${own}`);
    expect(granted.data.token.length).toBeGreaterThan(0);

    // The refusal this test exists for: the same live token, one fixture over.
    const crossToken = await dlApi.get(`/api/v1/public/fixtures/${other}/realtime-token`);
    expect(crossToken.status()).toBe(403);
  } finally {
    await dlApi.dispose();
    await anon.dispose();
  }
});

// ===========================================================================
// PROPAGATION FLOW (c) — the device chrome's own write reaching its own pad
// ===========================================================================
//
// `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` §6b
// enumerates four realtime propagation flows and records that three had no
// coverage at all. This is (c), and it is the OWNER'S REPORTED SYMPTOM in as
// many words: voiding (or starting) from the device-link chrome updates the
// outer panel instantly — it has its own `resync()` at
// `device-score-pad.tsx:171` — while the INNER v3 pad, which has no path to
// that resync at all, lags seconds behind, because the only way it can learn
// about a write it did not make is its own realtime stream.
//
// `device-score-pad.tsx` renders `<ScorePad initialEvents={...}/>` from a
// seed that never changes after the pad mounts, and the chrome's `resync()`
// writes only the chrome's own `live`/`events` state. So there is no seam
// between the two halves of this screen except the stream. That makes this
// the sharpest possible test of the stream: one browser tab, one fixture, and
// a value that can reach the pad by no other route.
//
// RE-POINTED (scorer sheets §4.5.1, Task 6). The inner pad now mounts only
// AFTER Start — a not-yet-started scan opens on the Confirm card — and it
// mounts SEEDED with the post-start ledger, so the chrome's own `core.start`
// is in the pad's seed and can no longer be the observed write (it would
// "arrive" by construction). The observed write is therefore a SECOND
// writer's: the organiser's `POST /events` over the API, after the device
// tapped Start and its pad mounted. Same clause, same budget: the device's
// inner pad must paint a write it did not make, faster than the poll.
//
// WHY THE ASSERTION IS A CLOCK AND NOT A WAIT. The stream falls back to a
// 15-second poll whenever realtime is unavailable, and the fallback is
// SILENT — it is exactly what the shipped defect produced. A test that merely
// waited for the pad to catch up would have passed all the way through that
// defect. `assertPropagatedUnderPoll` is the clause that can tell them apart,
// and it also asserts, unconditionally, that the pad asked at the
// realtime-token door and was let in.
//
// WHICH AUTHORISATION BRANCH THIS EXERCISES: the DEVICE-LINK one, and only
// it. The competition is seeded PRIVATE, so `fixtureRealtimeEligible`
// (`realtime-token/route.ts:23`, which reads `public_fixtures_v`) is false,
// and the browser holds no session cookie so `isFixtureOfficial` is false
// too. The `Bearer dl_` header the pad presents is the whole grant — asserted
// directly below rather than assumed, with an anonymous 403 control ahead of
// it so a competition that silently came back public cannot make the rest
// vacuous.
//
// THE BUDGET IS DERIVED, never a flat literal, for the reason recorded above
// `PAD_MOUNT_MS`: a wall-clock overrun prints whichever `expect.poll` was in
// flight, so an over-tight flat number would surface as "the pad never
// caught up" — a data-shaped lie about the product. There is no `HOLD_MS`
// term because this test taps no pad tile: Start is a chrome button, and the
// observed write goes straight to the API.
const FLOW_C_SEED_MS = 45_000; // competition + division + entrants + stage + generate + start + mint
const FLOW_C_MOUNT_MS = 20_000; // boot the page and paint the Confirm card; then Start → the pad
const FLOW_C_TOKEN_MS = 20_000; // the mount effect's realtime-token round trip
/** The "did it arrive at all" bound, deliberately WIDER than one poll tick:
 *  two ticks plus slack, so a write landing just after a tick still converges
 *  inside the budget and the failure we get is the honest one ("it took a
 *  poll") rather than a timeout. */
const PAD_POLL_MS = padPollMs();
const FLOW_C_CONVERGE_MS = 2 * PAD_POLL_MS + 5_000;

/** The chassis root. The device surface renders no `data-testid="score-pad"`
 *  wrapper — `scorepad-v3-partial-amend.spec.ts` and `scorepad-offline.spec.ts`
 *  both record the same fact — so this is the scope. */
const padV3 = (page: Page) => page.locator('[data-role="pad-v3"]');

/** The pad's own ledger size, as a string. `v3-activity-count` renders
 *  `events.length` (`v3/activity.tsx`), which is the shortest thing on this
 *  screen that moves when and only when the pad's ledger does — the scorebug
 *  for a not-yet-started fixture may legitimately paint the same "0 - 0"
 *  before and after `core.start`, and a test whose observable cannot change
 *  is the vacuous mode this whole exercise exists to avoid.
 *
 *  Never throws: a locator that is briefly absent across a re-render reports
 *  "", so the poll retries through it instead of dying inside it. */
async function padLedgerSize(page: Page): Promise<string> {
  const el = padV3(page).locator('[data-role="v3-activity-count"]').first();
  return ((await el.textContent().catch(() => null)) ?? "").trim();
}

test("a second writer's event reaches a device link's inner pad, mounted after Start, faster than the poll", async ({
  request,
  browser,
  playwright,
}) => {
  // Two mounts now: the Confirm card, then the pad Start mounts.
  test.setTimeout(FLOW_C_SEED_MS + 2 * FLOW_C_MOUNT_MS + FLOW_C_TOKEN_MS + FLOW_C_CONVERGE_MS);

  // PRIVATE, for the branch isolation described above — same seeding shape as
  // the cross-fixture realtime test directly above this one.
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `DL Propagate ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  expect(comp.status, `seed competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status, `seed division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/entrants`,
    "POST",
    ["Uniform", "Victor"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");

  const minted = await apiJson<{ secret: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}/device-links`,
    "POST",
    { label: "Court 11" },
  );
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  const secret = minted.data!.secret;

  // The control that makes the branch claim above non-vacuous: with no
  // credential at all this fixture's token door refuses. If it ever answers
  // 200 the competition is not private, the device-link branch is never
  // consulted, and the `Bearer dl_` assertion below proves nothing.
  const anonApi = await playwright.request.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const anonToken = await anonApi.get(`/api/v1/public/fixtures/${fixtureId}/realtime-token`);
    expect(
      anonToken.status(),
      "this competition must NOT be realtime-eligible on its own, or the device-link branch below is never reached",
    ).toBe(403);
  } finally {
    await anonApi.dispose();
  }

  // `consentedAnonymousState()` and not a bare `newContext()`: the latter
  // inherits `use.storageState` from playwright.config.ts and would sign this
  // "courtside device" in as the e2e organiser, making `isFixtureOfficial`
  // true and the device link irrelevant to everything below. The seeded
  // consent choice additionally keeps the cookie banner from mounting over
  // the pad mid-measurement.
  const deviceCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const device = await deviceCtx.newPage();
    // Armed BEFORE the navigation — the pad asks for its token from a mount
    // effect, so a listener attached after `goto` resolves is a race.
    const watch = await watchFixtureRealtime(device, fixtureId);
    await device.goto(`/score/${secret}`);

    // A not-yet-started scan opens on the Confirm card, with NO inner pad yet
    // (scorer sheets §4.5.1) — the empty case, before the device starts it.
    const start = device.locator('[data-testid="score-start-match"]');
    await expect(
      device.getByTestId("scan-confirm"),
      "a not-yet-started fixture opens on the Confirm card",
    ).toBeVisible({ timeout: FLOW_C_MOUNT_MS });
    await expect(padV3(device), "no inner pad before Start").toHaveCount(0);
    await start.click();

    await expect(
      padV3(device),
      "the v3 pad must render once Start is tapped — without it there is no inner surface to propagate TO",
    ).toBeVisible({ timeout: FLOW_C_MOUNT_MS });
    await expect
      .poll(() => watch.tokenStatuses.length, {
        timeout: FLOW_C_TOKEN_MS,
        message: "the pad never asked for a realtime token, or the door never answered",
      })
      .toBeGreaterThan(0);
    // Shape AND value: `/^Bearer dl_/` alone would pass on some other live
    // link, and a reachability-only check would pass on a session pad's
    // absent header.
    expect(watch.authHeaders[0]).toBe(`Bearer ${secret}`);

    // Not decoration. `padLedgerSize` reports "" for a locator that is not
    // there yet, so a pad still hydrating would hand `measurePropagation` a
    // `before` of "" and then "change" to "1" a few hundred milliseconds
    // later — a false realtime pass produced entirely by page load, with no
    // write involved at all. This settles the reading first and fails loudly
    // if it is still moving.
    const idle = await expectObservableIdle({
      read: () => padLedgerSize(device),
      what: "flow (c): the inner pad's ledger count before the second writer writes",
    });
    // The pad mounted SEEDED with the post-start ledger — the start is
    // already in it, so it cannot be what moves the count below.
    expect(idle, "the pad mounts seeded with the device's own core.start").toBe("1");

    // The SECOND writer: the organiser, over the API. The device is not
    // involved in this write at all, which is what makes its inner pad moving
    // a propagation fact rather than a local optimistic update.
    const fx = await apiJson<{ home_entrant_id: string }>(request, `/api/v1/fixtures/${fixtureId}`);
    expect(fx.status, `fixture read: ${JSON.stringify(fx.error)}`).toBe(200);
    const moved = await measurePropagation({
      what: "flow (c): an organiser's generic.score reaching the device's inner v3 pad",
      read: () => padLedgerSize(device),
      write: async () => {
        const posted = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
          expected_seq: 1,
          type: "generic.score",
          payload: { by: fx.data!.home_entrant_id, points: 1 },
          idempotency_key: crypto.randomUUID(),
        });
        expect(posted.status, `the organiser's write: ${JSON.stringify(posted.error)}`).toBe(201);
      },
      timeoutMs: FLOW_C_CONVERGE_MS,
    });

    assertPropagatedUnderPoll({
      where: "flow (c) second writer -> the device's inner pad",
      result: moved,
      watch,
      pollMs: PAD_POLL_MS,
    });

    // Positive pair for the count above. `measurePropagation` is satisfied by
    // ANY change, so on its own it cannot tell "the organiser's score arrived"
    // from "something else landed on this fixture". Pin both ends: the ledger
    // holds exactly the device's start and the organiser's score, and the
    // pad's own count agrees with it.
    const rows = await apiJson<{ type: string }[]>(
      request,
      `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
    );
    expect(
      (rows.data ?? []).map((e) => e.type),
      "the device's start, then the organiser's score — nothing else",
    ).toEqual(["core.start", "generic.score"]);
    expect(
      moved.after,
      "the pad's own ledger count must agree with the server's — a screen that moved to some other number is reading something else",
    ).toBe(String((rows.data ?? []).length));
  } finally {
    await deviceCtx.close();
  }
});
