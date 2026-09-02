import { test, expect } from "@playwright/test";
import { apiJson, mintLoginPathBySql, seedScoredDivision, TAG } from "./helpers";

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

  // A signed-out browser opens the pad from the token alone.
  const anonCtx = await browser.newContext();
  try {
    const page = await anonCtx.newPage();
    await page.goto(`/score/${secret}`);
    await expect(page.getByText(/Echo|Foxtrot/).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await anonCtx.close();
  }

  // The token is also the API credential for this fixture's events.
  const dlApi = await playwright.request.newContext({
    baseURL: BASE,
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

test("device links are Pro-only", async ({ browser }) => {
  // A fresh user auto-provisions their own community org, so this test never
  // competes with journey-community for the SHARED community org's single
  // active-competition slot (a real race under parallel workers).
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(await mintLoginPathBySql(`e2e-dlgate-${TAG}@example.com`));
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
