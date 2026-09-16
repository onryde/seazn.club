import { test, expect } from "@playwright/test";
import {
  apiJson,
  TAG,
  competitionPath,
  divisionPath,
  addEntrantsViaApi,
  expectNoHorizontalScroll,
} from "./helpers";

// PROMPT-28 formats: the new stage presets are reachable from the division
// builder, and a ladder division renders its challenge panel.
test("division builder exposes the Jul3/08 format presets", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Formats ${TAG}`,
    visibility: "private",
  });
  await page.goto(await competitionPath(page.request, comp.data!.id, "/d/new"));

  // The builder is tabbed; moving forward validates the current tab, so fill
  // the required division name before opening the Format tab.
  await page.getByRole("textbox").first().fill(`Formats ${TAG}`);
  await page.getByRole("button", { name: "Format", exact: true }).click();

  // The new presets are visible on the format picker.
  await expect(page.getByText("Triple round robin")).toBeVisible();
  await expect(page.getByText("Americano (padel)")).toBeVisible();
  await expect(page.getByText("Mexicano (padel)")).toBeVisible();
  await expect(page.getByText("Ladder", { exact: true })).toBeVisible();
  // L3/#414 pass 3 — the two new qualification-from-any-stage presets.
  await expect(page.getByText("Knockout + Plate", { exact: true })).toBeVisible();
  await expect(page.getByText("Qualifying + Main draw", { exact: true })).toBeVisible();
  // Swiss Playoff and Swiss Knockout. `exact` matters: the plain "Swiss" card
  // sits right beside them, and a substring match would resolve to whichever
  // came first.
  await expect(page.getByText("Swiss Playoff", { exact: true })).toBeVisible();
  await expect(page.getByText("Swiss Knockout", { exact: true })).toBeVisible();
  await expect(page.getByText("Swiss", { exact: true })).toBeVisible();

  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
});

// L3/#414 pass 3 / F3 review item 5: create a ko_plate competition from the
// template picker, complete the main draw, propose + confirm the plate's
// seed proposal, see the plate seeded from round-1 losers.
//
// F3 flipped every picker template's progression to `timing: "setup"` (day-
// one fixtures — the plate's TBD bracket exists before Main is even
// generated). Owner ruling 12 (2026-08-18, F3 index): seeding stays
// PROPOSE-AND-CONFIRM under `setup` timing, never auto-confirm — completing
// Main computes a draft seed proposal and returns it (`seed_proposal` on the
// completion response); `POST /generate` alone never seeds the plate, and
// nothing fills its TBD slots until an explicit propose + confirm. This spec
// used to assert the OLD `on_complete` wire shape (plain `qualified` on the
// completion response, auto-filled), which no picker template has emitted
// since that flip.
test("ko_plate template: completing the main draw computes a seed proposal; confirming it seeds the plate", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `KoPlate ${TAG}`,
    visibility: "private",
  });
  const competitionId = comp.data!.id;
  await page.goto(await competitionPath(page.request, competitionId, "/d/new"));
  await page.getByRole("textbox").first().fill(`KoPlate ${TAG}`);
  // The wizard defaults Sport to the catalog's first entry alphabetically
  // (division-builder.tsx: `sports[0]?.key`) — never "generic". Scoring the
  // fixtures below with `generic.result` needs the generic/score sport
  // explicitly selected, or the event 422s as unrecognised for whatever
  // sport happened to sort first. Scoped by label CONTAINMENT, not
  // getByLabel: the <label> wraps every <option> text too (all sports/
  // variants render as DOM text regardless of selection), so the computed
  // accessible name is "SportBadmintonBoardgame…Volleyball" — never the bare
  // "Sport" getByLabel(exact) would need.
  await page.locator("label", { hasText: "Sport" }).locator("select").selectOption({ label: "Generic" });
  await page.locator("label", { hasText: "Variant" }).locator("select").selectOption({ label: "Score" });
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page.getByText("Knockout + Plate", { exact: true }).click();
  await page.getByRole("button", { name: "Scheduling", exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: 20_000 });
  const slug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const divisions = await apiJson<{ id: string; slug: string }[]>(
    page.request,
    `/api/v1/competitions/${competitionId}/divisions`,
  );
  const divisionId = divisions.data!.find((d) => d.slug === slug)!.id;

  const stages = await apiJson<{ id: string; seq: number; kind: string; progression: unknown }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
  );
  expect(stages.data).toHaveLength(2);
  const main = stages.data!.find((s) => s.seq === 1)!;
  const plate = stages.data!.find((s) => s.seq === 2)!;
  expect(main.kind).toBe("knockout");
  expect(plate.kind).toBe("knockout");
  // ko_plate preset (format-templates.ts): plate's progression sources the
  // main draw's round-1 losers. `timing: "setup"` since F3 flipped every
  // picker template to day-one fixtures. `q` (round-1 loser count) defaults
  // to 4 (division-builder.tsx's `qualified` knob), never touched by this
  // test.
  expect(plate.progression).toMatchObject({
    sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
    placement: "rank_order",
    timing: "setup",
  });

  const { ids } = await addEntrantsViaApi(request, divisionId, [
    "Ann",
    "Bo",
    "Cy",
    "Di",
    "Ed",
    "Fi",
    "Gu",
    "Hy",
  ]);
  const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
  type Fx = {
    id: string;
    status: string;
    round_no: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  };

  // Day-one: the plate's TBD bracket exists before Main has even generated,
  // let alone been played — `timing: "setup"`'s whole point. Placeholder
  // slots only, no real entrants yet.
  const plateDayOne = await apiJson<{ created: number; fixtures: Fx[] }>(
    request,
    `/api/v1/stages/${plate.id}/generate`,
    "POST",
  );
  expect(plateDayOne.data!.created).toBe(3); // 4-entrant single elim
  expect(
    plateDayOne.data!.fixtures.every((f) => f.home_entrant_id === null && f.away_entrant_id === null),
  ).toBe(true);

  const gen = await apiJson<{ fixtures: Fx[] }>(
    request,
    `/api/v1/stages/${main.id}/generate`,
    "POST",
  );
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  const round1No = Math.min(...gen.data!.fixtures.map((f) => f.round_no));
  const round1 = gen.data!.fixtures.filter((f) => f.round_no === round1No);
  const namesById = new Map(ids.map((id, i) => [id, ["Ann", "Bo", "Cy", "Di", "Ed", "Fi", "Gu", "Hy"][i]!]));
  const expectedLoserNames = round1.map((f) =>
    (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99)
      ? namesById.get(f.away_entrant_id!)!
      : namesById.get(f.home_entrant_id!)!,
  );

  const decide = async (fid: string, a: number, b: number) => {
    const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fid}/state`);
    await apiJson(request, `/api/v1/fixtures/${fid}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: a, p2Score: b },
    });
  };
  for (let guard = 0; guard < 10; guard++) {
    const rows = (
      await apiJson<{ fixtures: Fx[] }>(request, `/api/v1/stages/${main.id}/generate`, "POST")
    ).data!.fixtures;
    const decidable = rows.filter(
      (f) => f.home_entrant_id && f.away_entrant_id && !["decided", "finalized"].includes(f.status),
    );
    if (decidable.length === 0) break;
    for (const f of decidable) {
      const homeWins = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
      await decide(f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
  }

  // "complete": setup timing never auto-fills — completeStage computes a
  // DRAFT seed proposal instead and returns it (owner ruling 12). The plate
  // stays exactly as TBD as it was on day one until an organiser confirms.
  const done = await apiJson<{ completed: boolean; seed_proposal?: { id: string; status: string } }>(
    request,
    `/api/v1/stages/${main.id}/complete`,
    "POST",
  );
  expect(done.data!.completed).toBe(true);
  expect(done.data!.seed_proposal?.status).toBe("draft");

  // "propose": explicit recompute — the real endpoint the progression panel
  // calls (completeStage's own auto-compute above is best-effort and gets
  // marked stale by this call).
  const proposal = await apiJson<{
    id: string;
    computed: { qualifiers: { entrantId: string; destinationSlot: string }[]; ties: unknown[] };
  }>(request, `/api/v1/stages/${plate.id}/seed-proposal`, "POST");
  expect(proposal.data!.computed.qualifiers).toHaveLength(4);
  expect(proposal.data!.computed.ties).toEqual([]);

  // "confirm": fills the plate's TBD fixtures through the same fillSlot
  // pathway intra-bracket advancement uses — `POST /generate` alone (already
  // called above, day one) never seeds it.
  const confirmed = await apiJson<{ filled: number }>(
    request,
    `/api/v1/stages/${plate.id}/seed-proposal/confirm`,
    "POST",
    { proposalId: proposal.data!.id },
  );
  expect(confirmed.data!.filled).toBe(4);

  // See the plate seeded: at least one round-1 loser's name renders on the
  // division page (desktop first, then 375px — no horizontal scroll at
  // either).
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  await expect(page.getByText(expectedLoserNames[0]!).first()).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByText(expectedLoserNames[0]!).first()).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
});

// Swiss Knockout: the picker builds it, the Top N knob reaches 3 (the shape
// the owner asked for and the one a power-of-two-only list cannot express),
// and the bracket that comes out the far end is the right shape IN THE
// BROWSER — one bye for the swiss winner, a real 2nd-v-3rd semi-final, and a
// Final already holding the bye entrant. Not "the API returned 200": the
// assertions below read the division page's own bracket panel and run sheet.
//
// BLOCKER worked around, deliberately and visibly (see
// server/usecases/__tests__/swiss-knockout-shape.test.ts's header for the
// full root cause): a swiss stage with no `config.rounds` can never complete,
// so the finals half is never seeded. The PUT below declares the rounds — the
// same shape the Settings tab writes — before any fixture exists. Delete it
// when the derived budget is made visible to the completion predicate.
test("swiss_knockout template: Top 3 builds a one-bye bracket the division page renders", async ({ page, request }) => {
  test.setTimeout(180_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `SwissKO ${TAG}`,
    visibility: "private",
  });
  const competitionId = comp.data!.id;
  await page.goto(await competitionPath(page.request, competitionId, "/d/new"));
  await page.getByRole("textbox").first().fill(`SwissKO ${TAG}`);
  // Generic/Score, for the same reason ko_plate above picks it: the wizard
  // defaults to the catalog's first sport and `generic.result` would 422.
  await page.locator("label", { hasText: "Sport" }).locator("select").selectOption({ label: "Generic" });
  await page.locator("label", { hasText: "Variant" }).locator("select").selectOption({ label: "Score" });
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page.getByText("Swiss Knockout", { exact: true }).click();

  // The knob: scoped by "Qualify to finals", NOT bare "Qualify" — the
  // "Qualifying + Main draw" picker card matches that too and the locator
  // goes strict-mode ambiguous.
  const qualify = page.locator("label", { hasText: "Qualify to finals" }).locator("select");
  // A reachability check would pass on any list, so pin the MEMBERSHIP: a
  // generic bracket makes 3 and 6 real shapes, and the power-of-two list the
  // other templates use cannot express the case this test then drives.
  await expect(qualify).toHaveValue("4");
  expect(
    await qualify.evaluate((e) => [...(e as HTMLSelectElement).options].map((o) => o.text)),
  ).toEqual(["Top 2", "Top 3", "Top 4", "Top 6", "Top 8", "Top 16"]);
  await qualify.selectOption({ label: "Top 3" });

  await page.getByRole("button", { name: "Scheduling", exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: 30_000 });
  const slug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const divisions = await apiJson<{ id: string; slug: string }[]>(
    page.request,
    `/api/v1/competitions/${competitionId}/divisions`,
  );
  const divisionId = divisions.data!.find((d) => d.slug === slug)!.id;

  type Stage = { id: string; seq: number; kind: string; config: Record<string, unknown>; progression: unknown };
  const stages = await apiJson<Stage[]>(page.request, `/api/v1/divisions/${divisionId}/stages`);
  expect(stages.data!.map((s) => s.kind)).toEqual(["swiss", "knockout"]);
  // What the picker actually sent: rank-adjacent pairing, and the knob's 3 —
  // not the template's default 4.
  expect(stages.data!.find((s) => s.seq === 1)!.config).toMatchObject({ pairing: "rank_adjacent" });
  expect(stages.data!.find((s) => s.seq === 2)!.progression).toMatchObject({
    sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
    placement: "rank_order",
    timing: "setup",
  });

  // ── blocker work-around, see this test's header ──
  const ko = stages.data!.find((s) => s.seq === 2)!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "PUT", [
    { seq: 1, kind: "swiss", name: "Swiss", config: { pairing: "rank_adjacent", rounds: 3 }, progression: null },
    { seq: 2, kind: "knockout", name: "Knockout", config: {}, progression: ko.progression },
  ]);
  const after = await apiJson<Stage[]>(page.request, `/api/v1/divisions/${divisionId}/stages`);
  const swissId = after.data!.find((s) => s.seq === 1)!.id;
  const koId = after.data!.find((s) => s.seq === 2)!.id;

  const names = ["Ann", "Bo", "Cy", "Di"];
  const { ids } = await addEntrantsViaApi(request, divisionId, names);
  const nameOf = new Map(ids.map((id, i) => [id, names[i]!]));
  const rank = (id: string | null) => names.indexOf(nameOf.get(id ?? "") ?? "zz");

  type Fx = { id: string; stage_id: string; status: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null };
  const fixturesOf = async (stageId: string): Promise<Fx[]> => {
    const all = await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
    return (all.data ?? []).filter((f) => f.stage_id === stageId);
  };

  // Day one: the bracket exists as placeholders before a ball is struck.
  const dayOne = await apiJson<{ created: number }>(request, `/api/v1/stages/${koId}/generate`, "POST");
  expect(dayOne.data!.created).toBe(3); // 2 round-0 lines + the Final
  await apiJson(request, `/api/v1/stages/${swissId}/generate`, "POST");
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  // Play the swiss out, TAPPING the organiser's own "Pair next round" control
  // between rounds rather than POSTing /generate — the pairing seam is only
  // proven through the control that actually issues it.
  const decide = async (fid: string, a: number, b: number) => {
    const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fid}/state`);
    await apiJson(request, `/api/v1/fixtures/${fid}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: a, p2Score: b },
    });
  };
  // 4 entrants get the field's own 3-round budget (lib/swiss-rounds.ts), and
  // the loop is written to that number rather than to "until nothing grows":
  // "Pair next round" stays on screen past the cap, so a growth-driven loop
  // reads its own last no-op tap as a failure.
  const SWISS_ROUNDS = 3;
  for (let round = 1; round <= SWISS_ROUNDS; round++) {
    for (const f of await fixturesOf(swissId)) {
      if (!f.home_entrant_id || !f.away_entrant_id) continue;
      if (["decided", "finalized"].includes(f.status)) continue;
      const homeWins = rank(f.home_entrant_id) < rank(f.away_entrant_id);
      await decide(f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    if (round === SWISS_ROUNDS) break;
    await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
    await page.getByRole("button", { name: /pair next round/i }).first().click();
    await expect
      .poll(async () => (await fixturesOf(swissId)).length, { timeout: 20_000 })
      .toBe(2 * (round + 1));
  }
  // Every pair met exactly once over those three rounds, so the table is
  // strict on wins: Ann > Bo > Cy > Di.
  expect(await fixturesOf(swissId)).toHaveLength(6);

  const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${swissId}/complete`, "POST");
  expect(done.data!.completed).toBe(true);
  const proposal = await apiJson<{ id: string; computed: { qualifiers: { entrantId: string }[] } }>(
    request,
    `/api/v1/stages/${koId}/seed-proposal`,
    "POST",
  );
  expect(proposal.data!.computed.qualifiers.map((q) => nameOf.get(q.entrantId))).toEqual(["Ann", "Bo", "Cy"]);
  await apiJson(request, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", {
    proposalId: proposal.data!.id,
  });

  // ── the shape, IN THE BROWSER ──
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  const bracket = page.getByTestId("bracket-panel");
  await expect(bracket.getByText("Cy", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(bracket.getByText("Bo", { exact: true }).first()).toBeVisible();
  // Two knockout round groups on the run sheet and no third: a Top 3 pads to
  // a 4-slot bracket, which is a semi-final round and a final. A quarter-final
  // here would mean the bracket was sized to 8.
  await expect(page.getByText("Knockout — Semi-finals")).toBeVisible();
  await expect(page.getByText("Knockout — Final", { exact: true })).toBeVisible();
  await expect(page.getByText("Quarter-final")).toHaveCount(0);
  // Di finished 4th and did not qualify: she is nowhere in the bracket.
  await expect(bracket.getByText("Di", { exact: true })).toHaveCount(0);

  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(bracket.getByText("Cy", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
});

test("ladder division renders the challenge panel", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Ladder ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Ladder", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  const divisionId = div.data!.id;
  await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    ["Alpha", "Bravo", "Charlie", "Delta"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1, kind: "ladder", name: "Ladder", config: { challengeRange: 2 },
  });

  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  // the ladder panel: challenge form + ranked entrants
  await expect(page.getByRole("button", { name: /issue challenge/i })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Alpha" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Charlie" })).toBeVisible();

  // issue a challenge: #3 (Charlie) challenges #1 (Alpha), within range 2
  await page.getByLabel("Challenger").selectOption({ label: "Charlie" });
  await page.getByLabel(/challenges \(must be above\)/i).selectOption({ label: "Alpha" });
  await page.getByRole("button", { name: /issue challenge/i }).click();

  // success clears the form (the challenge fixture was created) and no red
  // error banner appears
  await expect(page.getByLabel("Challenger")).toHaveValue("", { timeout: 20_000 });
  await expect(page.locator(".bg-red-50")).toHaveCount(0);
});

test("americano renders the rotation grid", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Americano ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Padel", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
  );
  const divisionId = div.data!.id;
  // americano needs individuals backed by persons
  const players = [];
  for (let i = 0; i < 8; i++) {
    const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: `Padel ${i + 1} ${TAG}`,
      consent: {},
    });
    players.push({
      kind: "individual", display_name: `Player ${i + 1}`, seed: i + 1,
      members: [{ person_id: p.data!.id, is_captain: false, roles: [] }],
    });
  }
  await apiJson(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", players);
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 5 } },
  );
  await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  // the rotation grid: mode chip + round cards + courts (scoped to the panel)
  const grid = page.getByLabel("Americano rotation");
  await expect(grid.getByText("americano", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(grid.getByRole("heading", { name: "Round 1" })).toBeVisible();
  await expect(grid.getByText(/Court 1/).first()).toBeVisible();

  // in-grid scoring: fill the first match's two score boxes and save
  const scoreInputs = grid.getByRole("spinbutton");
  await scoreInputs.nth(0).fill("24");
  await scoreInputs.nth(1).fill("18");
  await grid.getByRole("button", { name: /save score/i }).first().click();

  // the match flips to scored and the personal-points leaderboard populates
  await expect(grid.getByText(/✓ scored/).first()).toBeVisible({ timeout: 20_000 });
  await expect(grid.getByRole("heading", { name: "Personal points" })).toBeVisible();
  // the scored pair's players now carry 24 points on the leaderboard
  await expect(grid.getByRole("cell", { name: "24", exact: true }).first()).toBeVisible();
});
