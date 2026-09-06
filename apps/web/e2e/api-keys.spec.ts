import { test, expect, type PlaywrightWorkerArgs } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// Platform API keys (Pro): mint → use with Bearer auth → revoke → rejected.
// Scopes are read < score < manage (v3/08 §2, PROMPT-37); a read key 403s on
// manage routes; community lacks api.access entirely.

const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";

/**
 * A request context that carries the API KEY AND NOTHING ELSE.
 *
 * `storageState: { cookies: [], origins: [] }` is LOAD-BEARING, not tidiness.
 * `playwright.request.newContext()` inherits the project's `use.storageState`
 * exactly as `browser.newContext()` does — measured here: a bare context came
 * back holding `seazn_session` + `seazn_org`, and `GET /api/v1/competitions`
 * with **no Authorization header at all** answered 200. `requireAuth`
 * (server/api-v1/auth.ts) takes the Bearer branch first, so a live key still
 * decided those responses — but nothing in the test said so. Anything that
 * stopped the key path being REACHED (the `sc_` prefix test in
 * `bearerToken()`, the token branch in `requireAuth`, a proxy eating the
 * header) would have fallen through to the signed-in Pro cookie and returned
 * the same 200. The suite that exists to prove API keys work would have gone
 * green over a dead API-key path.
 *
 * With the jar emptied, every status below is the key's doing. Test 1 keeps
 * both halves of that as live assertions rather than a comment.
 */
async function keyContext(playwright: PlaywrightWorkerArgs["playwright"], secret: string) {
  const ctx = await playwright.request.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  await expectNoSession(ctx);
  return ctx;
}

/** The same context with no credential of any kind — the anonymous control. */
async function anonContext(playwright: PlaywrightWorkerArgs["playwright"]) {
  const ctx = await playwright.request.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
  });
  await expectNoSession(ctx);
  return ctx;
}

/**
 * The F8 regression guard, and the reason it lives in the constructors rather
 * than at a call site: dropping the empty `storageState` above is a silent,
 * invisible revert. Every status in this file stays exactly the same, because
 * the Bearer branch wins while the key is live — the tests only stop being
 * able to WITNESS a dead key path. Nothing observable changes until the day it
 * matters. So the emptiness of the jar is asserted, not assumed.
 */
async function expectNoSession(ctx: { storageState: () => Promise<{ cookies: unknown[] }> }) {
  expect(
    (await ctx.storageState()).cookies,
    "this context must carry no session — a cookie here can answer for the key",
  ).toHaveLength(0);
}

test.describe.serial("api keys", () => {
  let orgId: string;
  let keyId: string;
  let secret: string;
  // Something real for the key to open, created by the SESSION in the key's
  // own org — so "the key works" can mean "it reads THIS org's competition",
  // not "some 200 came back".
  let competitionId: string;

  test("pro org mints a read key that authorises /api/v1", async ({ page, playwright }) => {
    orgId = (await activeOrg(page)).id;
    const created = await apiJson<{ id: string; secret: string }>(
      page.request,
      `/api/v1/orgs/${orgId}/api-keys`,
      "POST",
      { name: `e2e ${TAG}`, scopes: ["read"] },
    );
    expect(created.status).toBe(201);
    keyId = created.data!.id;
    secret = created.data!.secret;
    expect(secret.startsWith("sc_")).toBe(true);

    const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
      name: `api key subject ${TAG}`,
      ends_on: "2030-12-31",
    });
    expect(comp.status).toBe(201);
    competitionId = comp.data!.id;

    // --- the two controls that make a 200 below attributable to the KEY ----
    // (a) The session alone opens this endpoint. This is why a key test must
    //     carry no cookies; if this ever stops being true the reason for
    //     `keyContext`'s empty jar has gone away and this test should say so.
    expect((await page.request.get("/api/v1/competitions")).status()).toBe(200);
    // (b) With neither cookie nor key, the door is shut — so a 200 is not
    //     "the endpoint is public".
    const anon = await anonContext(playwright);
    try {
      expect((await anon.get("/api/v1/competitions")).status()).toBe(401);
      expect((await anon.get(`/api/v1/competitions/${competitionId}`)).status()).toBe(401);
    } finally {
      await anon.dispose();
    }

    // --- the key, alone, opens what its scope covers -----------------------
    const keyApi = await keyContext(playwright, secret);
    try {
      const list = await keyApi.get("/api/v1/competitions");
      expect(list.status()).toBe(200);
      expect(((await list.json()) as { ok: boolean }).ok).toBe(true);

      // And it resolves to the key's OWN org: this competition, by id. A key
      // minted for another org is 401 here (auth.ts: `key.org_id !== orgId`),
      // so this pins WHICH org answered, not merely that one did.
      const one = await keyApi.get(`/api/v1/competitions/${competitionId}`);
      expect(one.status()).toBe(200);
      expect(((await one.json()) as { data: { id: string } }).data.id).toBe(competitionId);
    } finally {
      await keyApi.dispose();
    }
  });

  test("a read key is refused on manage routes (scope enforcement)", async ({ playwright }) => {
    const keyApi = await keyContext(playwright, secret);
    try {
      // The 403 has to come from the scope check. POST /competitions now
      // authenticates before it parses, so the body no longer decides which
      // refusal comes back — but it is kept valid so this probe stays about
      // scope even if that order is ever reversed again. The order itself is
      // pinned by api/v1/competitions/__tests__/create-auth-order.test.ts.
      const res = await keyApi.post("/api/v1/competitions", {
        data: { name: `Nope ${TAG}`, ends_on: "2030-12-31" },
      });
      expect(res.status()).toBe(403);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message ?? "").toContain("manage");

      // The refusal is about SCOPE, not a dead key: the same key, same
      // context, still opens its read door. Without this a revoked or
      // mistyped secret could reach the 403 for the wrong reason.
      expect((await keyApi.get(`/api/v1/competitions/${competitionId}`)).status()).toBe(200);
    } finally {
      await keyApi.dispose();
    }
  });

  test("community orgs lack api.access", async ({ browser }) => {
    // Deliberately session-based — this asserts what a signed-in COMMUNITY
    // organiser gets when they try to mint a key, so the cookie jar is the
    // subject here rather than a leak. `storageState` is explicit, so nothing
    // is inherited from the project's Pro state.
    const ctx = await browser.newContext({ storageState: "e2e/.auth/community.json" });
    try {
      const cPage = await ctx.newPage();
      const communityOrg = await activeOrg(cPage);
      const res = await apiJson(cPage.request, `/api/v1/orgs/${communityOrg.id}/api-keys`, "POST", {
        name: `e2e ${TAG}`,
        scopes: ["read"],
      });
      expect(res.status).toBe(402);
    } finally {
      await ctx.close();
    }
  });

  test("a revoked key stops working", async ({ page, playwright }) => {
    const keyApi = await keyContext(playwright, secret);
    try {
      // Positive control first: this key opens the door it is about to lose.
      // A bare "revoked ⇒ 401" is also satisfied by a key that never worked.
      expect((await keyApi.get(`/api/v1/competitions/${competitionId}`)).status()).toBe(200);

      const revoked = await page.request.delete(`/api/v1/orgs/${orgId}/api-keys/${keyId}`);
      expect(revoked.ok()).toBe(true);

      // Same context, same secret, same doors — now shut.
      expect((await keyApi.get(`/api/v1/competitions/${competitionId}`)).status()).toBe(401);
      expect((await keyApi.get("/api/v1/competitions")).status()).toBe(401);
    } finally {
      await keyApi.dispose();
    }
  });
});
