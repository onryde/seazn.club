import { test, expect } from "@playwright/test";
import { loginUi, apiJson, TAG } from "./helpers";

// F5 remainder: build.ts's per-value i18n fallbacks (BuildOpts.i18n's new
// resultVs/courtUnassigned/rotaNoDuties/rotaResponse*/entrantTbd fields —
// see packages/engine/src/exports/build.ts and exports.ts's exportChrome()).
// This spec covers the gaps a real product flow can actually reach today
// — the timetable's undecided-result "vs" separator and its per_pitch
// "no court" grouping heading. entrantTbd/rotaNoDuties/rotaResponse* have no
// reachable path through the current product (a fresh fixture's home/away
// always resolves to a string before it reaches build.ts, and the rota query
// only ever returns officials who already have at least one duty) — those are
// proven at the engine/vitest layer instead: build.test.ts and exports.test.ts
// (exports.ts's exportChrome, unit-tested directly, no DB needed).
//
// Repair pass: the roster's sign-at-start block and the rota's sign-on/off
// block (rosterSignatures/rotaSignatures) ARE reachable here — unlike the
// fields above, both print unconditionally on every section, so this test
// also exports a roster (the entrants already created below suffice) and an
// officials rota (one real duty assignment, added below).
//
// A rendered PDF's content stream is compressed (pdfkit's default), so
// grepping the response bytes for "vs"/"Unassigned" would prove nothing
// either way — that is what the vitest DocModel-level assertions are for.
// This test's job is the thing only a real HTTP round-trip can show: the new
// fallback-resolution code does not error for a French-locale org's freshly
// generated (courtless, undecided) fixtures.
//
// Own empty storageState + loginUi, the credits-tab-shots/f3-day-one-shots
// idiom — an isolated fresh org, never the shared AUTH_STATE session every
// other spec in this project reuses. Mutating a SHARED org's default_locale
// would leak French copy into every other test running against it in the
// same parallel shard.
test.use({ storageState: { cookies: [], origins: [] } });

test("a French-locale org's day-one timetable export still renders (F5 remainder)", async ({
  page,
}) => {
  await loginUi(page, `f5-fr-locale-${Date.now()}@example.com`, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `F5 FR Locale ${Date.now()}`,
  });
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  const orgId = created.data!.id;

  const locale = await apiJson(page.request, `/api/orgs/${orgId}`, "PATCH", {
    default_locale: "fr",
  });
  expect(locale.status, JSON.stringify(locale.error)).toBe(200);

  const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `FR Locale ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  const div = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await apiJson(page.request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: `FR Alice ${TAG}`, seed: 1 },
    { kind: "individual", display_name: `FR Bob ${TAG}`, seed: 2 },
  ]);
  expect(entrants.status, JSON.stringify(entrants.error)).toBe(201);

  const stage = await apiJson<{ id: string }>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League", config: {} },
  );
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);

  // No court, no result — the day-one default that used to render the
  // engine's hardcoded "Unassigned"/"vs" regardless of locale.
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  expect(gen.status, JSON.stringify(gen.error)).toBe(200);

  const res = await page.request.get(
    `/api/v1/divisions/${divisionId}/exports/timetable?format=pdf&pageBreaks=per_pitch`,
  );
  expect(res.status()).toBe(200);
  const bytes = await res.body();
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

  // Repair pass: the roster's sign-at-start block (rosterSignatures) —
  // FR Alice/FR Bob above are registered entrants, so this section already
  // exists; no day-one state to engineer.
  const rosterRes = await page.request.get(`/api/v1/divisions/${divisionId}/exports/roster?format=pdf`);
  expect(rosterRes.status()).toBe(200);
  expect((await rosterRes.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Repair pass: the rota's sign-on/off block (rotaSignatures) — the rota
  // query only returns officials with >=1 duty, so give it one real
  // assignment first (same idiom as officials-directory.spec.ts).
  const official = await apiJson<{ id: string }>(page.request, "/api/v1/officials", "POST", {
    display_name: `FR Ref ${TAG}`,
    role_keys: ["referee"],
  });
  expect(official.status, JSON.stringify(official.error)).toBe(201);
  const assign = await apiJson(page.request, `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/officials`, "PATCH", {
    set: [{ official_id: official.data!.id, role_key: "referee", locked: false }],
  });
  expect(assign.status, JSON.stringify(assign.error)).toBe(200);

  const rotaRes = await page.request.get(`/api/v1/divisions/${divisionId}/exports/officials_rota?format=pdf`);
  expect(rotaRes.status()).toBe(200);
  expect((await rotaRes.body()).subarray(0, 5).toString()).toBe("%PDF-");
});
