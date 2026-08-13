import { test, expect } from "@playwright/test";
import { apiJson, TAG, divisionPath } from "./helpers";

// D3 schedule health (design doc bench-product-value/designs/2026-08-13-
// schedule-health-design.md). What a unit/integration test cannot pin: the
// panel actually renders 5 bars off a real GET in a real browser, and
// offender expansion actually works — see wave 1's post-mortem
// (docs/superpowers/specs/bench-product-value/portfolio-prompts/_INDEX.md):
// every e2e defect that wave was in a spec authored-but-never-run. This one
// IS run — see the implementer's final report for the raw counts.
//
// The board is HAND-ASSIGNED (not run through `/schedule/auto`'s solver):
// the solver's own placement choices are not something this spec controls,
// and "offender expansion" needs at least one real offender to expand.
// Pinning E1 to Court 1 for all 3 of its round-robin fixtures guarantees a
// courtBalance offender (ratio 0, |F_e|=3 meets C_min); the same [15min,
// 225min] gap pattern every entrant gets guarantees a sub-100 restSpread
// score with real offenders too. Both derived from the SAME formulas the
// engine suite already proves in isolation — this spec exists to prove the
// WIRING (a real POST persisting a real board, a real GET reading it back,
// a real click revealing the real list), not to re-prove the arithmetic.
const DAY = "2026-09-10";

interface GenFixture {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

function findFixture(fixtures: GenFixture[], a: string, b: string): GenFixture {
  const f = fixtures.find(
    (x) => (x.home_entrant_id === a && x.away_entrant_id === b) || (x.home_entrant_id === b && x.away_entrant_id === a),
  );
  if (!f) throw new Error(`no generated fixture between ${a} and ${b}`);
  return f;
}

async function seedAppliedLeague(request: import("@playwright/test").APIRequestContext) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Health E2E ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Health",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  const entrants = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: "E1", seed: 1 },
    { kind: "individual", display_name: "E2", seed: 2 },
    { kind: "individual", display_name: "E3", seed: 3 },
    { kind: "individual", display_name: "E4", seed: 4 },
  ]);
  const [e1, e2, e3, e4] = entrants.data!.map((e) => e.id);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const stageId = stage.data!.id;
  const gen = await apiJson<{ fixtures: GenFixture[] }>(request, `/api/v1/stages/${stageId}/generate`, "POST");
  const fixtures = gen.data!.fixtures;

  await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: `${DAY}T00:00:00.000Z`,
      endAt: `${DAY}T23:59:00.000Z`,
      matchMinutes: 60,
      gapMinutes: 0,
      courts: ["Court 1", "Court 2"],
      perEntrantMinRest: 0,
      sessionWindows: [{ from: `${DAY}T09:00:00.000Z`, to: `${DAY}T21:00:00.000Z` }],
    },
  });

  // Court 1 carries every one of E1's fixtures (courtBalance offender for
  // E1: ratio 0). Every entrant's own 3 matches land at the SAME [15min,
  // 225min] gap pattern relative to their own span (restSpread offender for
  // everyone: ideal=120min, p=(0.875+0)/2=0.4375, score 56 — independently
  // re-derivable from health.test.ts's own worked examples, same formula).
  //
  // C1: the generator's circle method (seed 1 fixed, 2/3/4 rotate) pairs
  // round 1 = (e1,e4)+(e2,e3), round 2 = (e1,e3)+(e2,e4), round 3 =
  // (e1,e2)+(e3,e4) — confirmed against a live board, not assumed. The three
  // time slots below are matched to THAT round order (round order is now a
  // hard H6 gate); the original narrative order — (e1,e2) first — put round
  // 3 at 09:00 and round 1 at 15:00, a genuine violation the apply now
  // (correctly) 409s on. Which opponent sits in which slot is otherwise
  // irrelevant to the offender guarantees above: those depend only on E1
  // playing all three slots on Court 1 and every entrant playing one match
  // per slot, never on pairing identity.
  const assignments = [
    { f: findFixture(fixtures, e1, e4), at: "09:00", court: "Court 1" },
    { f: findFixture(fixtures, e2, e3), at: "09:00", court: "Court 2" },
    { f: findFixture(fixtures, e1, e3), at: "10:15", court: "Court 1" },
    { f: findFixture(fixtures, e2, e4), at: "10:15", court: "Court 2" },
    { f: findFixture(fixtures, e1, e2), at: "15:00", court: "Court 1" },
    { f: findFixture(fixtures, e3, e4), at: "15:00", court: "Court 2" },
  ].map(({ f, at, court }) => ({
    fixture_id: f.id,
    scheduled_at: `${DAY}T${at}:00.000Z`,
    court_label: court,
  }));

  const applied = await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
    assignments,
    source: "manual",
  });
  expect(applied.status).toBeLessThan(300);

  return { divisionId, stageId };
}

test("schedule health: panel renders 5 bars after a real applied schedule, and offender expansion reveals a real list", async ({
  page,
  request,
}) => {
  const { divisionId } = await seedAppliedLeague(request);

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=health"));
  const panel = page.locator('[data-health-status="ready"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // 5, not 4 — league is table-shaped (TABLE_KINDS), so homeAwayAlternation
  // must be one of the five, not skipped.
  const cards = page.locator("[data-health-metric]");
  await expect(cards).toHaveCount(5, { timeout: 20_000 });
  await expect(page.locator('[data-health-metric="restSpread"]')).toBeVisible();
  await expect(page.locator('[data-health-metric="courtBalance"]')).toBeVisible();
  await expect(page.locator('[data-health-metric="gapDispersion"]')).toBeVisible();
  await expect(page.locator('[data-health-metric="homeAwayAlternation"]')).toBeVisible();
  await expect(page.locator('[data-health-metric="primeSlotFairness"]')).toBeVisible();

  // restSpread is the deliberately-guaranteed offender (see seedAppliedLeague's
  // comment) — expand it specifically, not "whichever card happens to have a
  // button first", so a regression that silently empties every OTHER card's
  // offender list could not still pass this by accident.
  const restSpreadCard = page.locator('[data-health-metric="restSpread"]');
  await expect(restSpreadCard).not.toHaveAttribute("data-health-score", "100");
  const showButton = restSpreadCard.getByRole("button", { name: /Show details/i });
  await expect(showButton).toBeVisible({ timeout: 20_000 });
  const offenderRowsBefore = await restSpreadCard.locator("li").count();
  expect(offenderRowsBefore).toBe(0); // collapsed — nothing rendered yet
  await showButton.click();
  const offenderRows = restSpreadCard.locator("li");
  await expect(offenderRows.first()).toBeVisible({ timeout: 20_000 });
  expect(await offenderRows.count()).toBeGreaterThan(0);
  await expect(restSpreadCard.getByRole("button", { name: /Hide details/i })).toBeVisible();
});

test("schedule health: 409 before any fixture is scheduled renders the panel's empty state, not an error", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Health E2E Empty ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "HealthEmpty",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: "X1", seed: 1 },
    { kind: "individual", display_name: "X2", seed: 2 },
  ]);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=health"));
  await expect(page.locator('[data-health-status="empty"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-health-metric]")).toHaveCount(0);
});

// Joint (competition-scope) variant — coordinator addendum, D3 Scope item 2
// ("+ joint competition aggregation"), added after this session's initial
// pass under-scoped it. API-level, same shape `capacity-precheck.spec.ts`'s
// last assertion already uses in this file family ("server is the
// authority" — a real HTTP round trip through the real route, no UI to
// drive since no dedicated joint panel exists yet). Two divisions in ONE
// competition, one scheduled and one deliberately left unscheduled, so the
// response proves "report every division, never short-circuit on the
// first" — the shape `aiPlanForCompetition`'s own capacity guard uses.
test("schedule health (joint): one applied + one unscheduled division both report, and the embedded stage report matches the standalone route exactly", async ({
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Health Joint E2E ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;

  // Division 1: scheduled, via the SAME hand-assigned recipe as the single-
  // stage test above (asymmetric, guarantees real offenders).
  const div1 = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "JointA", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const div1Id = div1.data!.id;
  const entrants1 = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div1Id}/entrants`, "POST", [
    { kind: "individual", display_name: "J1", seed: 1 },
    { kind: "individual", display_name: "J2", seed: 2 },
    { kind: "individual", display_name: "J3", seed: 3 },
    { kind: "individual", display_name: "J4", seed: 4 },
  ]);
  const [j1, j2, j3, j4] = entrants1.data!.map((e) => e.id);
  const stage1 = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div1Id}/stages`, "POST", {
    seq: 1, kind: "league", name: "League",
  });
  const stage1Id = stage1.data!.id;
  const gen1 = await apiJson<{ fixtures: GenFixture[] }>(request, `/api/v1/stages/${stage1Id}/generate`, "POST");
  const fx1 = gen1.data!.fixtures;
  await apiJson(request, `/api/v1/divisions/${div1Id}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: `${DAY}T00:00:00.000Z`, endAt: `${DAY}T23:59:00.000Z`,
      matchMinutes: 60, gapMinutes: 0, courts: ["Court 1", "Court 2"], perEntrantMinRest: 0,
      sessionWindows: [{ from: `${DAY}T09:00:00.000Z`, to: `${DAY}T21:00:00.000Z` }],
    },
  });
  // C1: same round-order fix as seedAppliedLeague above — round 1 =
  // (j1,j4)+(j2,j3), round 2 = (j1,j3)+(j2,j4), round 3 = (j1,j2)+(j3,j4),
  // matched to ascending time so the apply is not a genuine H6 violation.
  const assignments1 = [
    { f: findFixture(fx1, j1, j4), at: "09:00", court: "Court 1" },
    { f: findFixture(fx1, j2, j3), at: "09:00", court: "Court 2" },
    { f: findFixture(fx1, j1, j3), at: "10:15", court: "Court 1" },
    { f: findFixture(fx1, j2, j4), at: "10:15", court: "Court 2" },
    { f: findFixture(fx1, j1, j2), at: "15:00", court: "Court 1" },
    { f: findFixture(fx1, j3, j4), at: "15:00", court: "Court 2" },
  ].map(({ f, at, court }) => ({ fixture_id: f.id, scheduled_at: `${DAY}T${at}:00.000Z`, court_label: court }));
  const applied1 = await apiJson(request, `/api/v1/stages/${stage1Id}/schedule/apply`, "POST", { assignments: assignments1, source: "manual" });
  expect(applied1.status).toBeLessThan(300);

  // Division 2: generated but deliberately never scheduled.
  const div2 = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "JointB", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const div2Id = div2.data!.id;
  await apiJson(request, `/api/v1/divisions/${div2Id}/entrants`, "POST", [
    { kind: "individual", display_name: "K1", seed: 1 },
    { kind: "individual", display_name: "K2", seed: 2 },
  ]);
  const stage2 = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div2Id}/stages`, "POST", {
    seq: 1, kind: "league", name: "League",
  });
  await apiJson(request, `/api/v1/stages/${stage2.data!.id}/generate`, "POST");

  // The standalone stage report — the value the joint response's embedded
  // entry must match EXACTLY.
  const standalone = await apiJson<{
    stageId: string; computedAt: string;
    metrics: { key: string; score: number; explanation: { key: string; params?: Record<string, number> }; offenders: unknown[] }[];
  }>(request, `/api/v1/stages/${stage1Id}/schedule/health`, "GET");
  expect(standalone.status).toBe(200);

  const joint = await apiJson<{
    competitionId: string;
    divisions: {
      divisionId: string;
      stages: (
        | { stageId: string; status: "empty" }
        | { stageId: string; status: "ready"; computedAt: string; metrics: typeof standalone.data extends { metrics: infer M } ? M : never }
      )[];
    }[];
    combined: { metrics: { key: string; score: number }[] };
  }>(request, `/api/v1/competitions/${compId}/schedule/health`, "GET");
  expect(joint.status).toBe(200);
  expect(joint.data!.divisions).toHaveLength(2);

  const jointDiv1 = joint.data!.divisions.find((d) => d.divisionId === div1Id);
  const jointDiv2 = joint.data!.divisions.find((d) => d.divisionId === div2Id);
  expect(jointDiv1?.stages[0]?.status).toBe("ready");
  expect(jointDiv2?.stages[0]?.status).toBe("empty");

  // The exact-match cross-check: no second implementation, no tz drift.
  const embedded = jointDiv1!.stages[0] as { status: "ready"; metrics: unknown };
  expect(JSON.stringify(embedded.metrics)).toBe(JSON.stringify(standalone.data!.metrics));

  expect(joint.data!.combined.metrics.map((m) => m.key).sort()).toEqual(["gapDispersion", "primeSlotFairness"]);

  const unknown = await apiJson(request, `/api/v1/competitions/00000000-0000-0000-0000-000000000000/schedule/health`, "GET");
  expect(unknown.status).toBe(404);
});
