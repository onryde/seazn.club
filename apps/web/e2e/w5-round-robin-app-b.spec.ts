import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, competitionPath, divisionPath, expectNoHorizontalScroll, showAllFormats } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { buildTemplateStages } from "../src/lib/format-templates";
import { crossPoolDraw } from "@seazn/engine/scheduling";
import { swissDrawSeed } from "../src/lib/swiss-draw";
import { dictString, uiString } from "./spectator-w2-kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// W5 round-robin app PR B, Task 4 (X-UP-1, X-UP-3; ST-G3; ruling 286, R24 pick 16 B). Best runners-up across UNEQUAL pools are
// compared on the smallest pool's matches: a larger pool's runner-up without her result against her pool's bottom row. The
// division's Standings tab says so under the group's tables, and lists the result it left out behind "Results left out".
// Driven through the real routes (the groups_ko card's own drafts, Generate, Start, the scorer's result door, Complete) and read
// on the page a person opens, at 1280, 768 and 320. Copy is the public dictionary's (`dictString`), never typed.

const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
type Fx = { id: string; stage_id: string; pool_id?: string | null; home_entrant_id: string | null; away_entrant_id: string | null };

/** 9 into 2 pools (5 and 4), Top 3: both winners and the better runner-up. Every meeting goes to the higher seed, 1-0 in the
 *  5-pool and 3-0 in the 4-pool, so the 5-pool's runner-up compared without her win over the 5th (RB5-U1, k = 1) is level on
 *  points with the 4-pool's and behind on diff: the 4-pool's runner-up is seated, on 3 matches each. */
async function seedUnequalGroups(request: APIRequestContext) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `XUP1 ${TAG}`, visibility: "private" });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  expect(div.status).toBe(201);
  const divisionId = div.data!.id;
  const field = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
    Array.from({ length: 9 }, (_, i) => ({ kind: "individual", display_name: `Unequal ${i + 1} ${TAG}`, seed: i + 1 })));
  expect(field.status).toBe(201);
  const seedOf = new Map(field.data!.map((e, i) => [e.id, i + 1]));
  const nameOf = new Map(field.data!.map((e) => [e.id, e.display_name]));
  const drafts = buildTemplateStages("groups_ko", { qualified: 3, poolCount: 2, swissRounds: 3, legs: 1 });
  const stages = await apiJson<{ id: string; kind: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST",
    drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })));
  expect(stages.status).toBe(201);
  const groupId = stages.data!.find((s) => s.kind === "group")!.id;
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;
  expect((await apiJson(request, `/api/v1/stages/${koId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/stages/${groupId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
  const lines = ((await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data ?? []).filter((f) => f.stage_id === groupId);
  const byPool = new Map<string, Set<string>>();
  for (const f of lines) for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id) byPool.set(f.pool_id ?? "", (byPool.get(f.pool_id ?? "") ?? new Set()).add(id));
  const pools = [...byPool.values()].map((s) => [...s].sort((a, b) => seedOf.get(a)! - seedOf.get(b)!)).sort((a, b) => b.length - a.length);
  expect(pools.map((p) => p.length), "9 into 2 pools: 5 and 4").toEqual([5, 4]);
  let scored = 0;
  for (const members of pools) {
    const [ws, ls] = members.length === 5 ? [1, 0] : [3, 0];
    for (const f of lines.filter((x) => members.includes(x.home_entrant_id!))) {
      const homeWins = members.indexOf(f.home_entrant_id!) < members.indexOf(f.away_entrant_id!);
      const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: 0, type: "generic.result", payload: homeWins ? { p1Score: ws, p2Score: ls } : { p1Score: ls, p2Score: ws },
      });
      expect(res.status).toBe(201);
      scored++;
    }
  }
  expect(scored, "every meeting of both pools").toBe(10 + 6);
  const done = await apiJson<{ completed: boolean }>(request, `/api/v1/stages/${groupId}/complete`, "POST");
  expect(done.status).toBe(200);
  const [five, four] = pools as [string[], string[]];
  return { divisionId, koId, names: { a2: nameOf.get(five[1]!)!, a5: nameOf.get(five[4]!)!, b2: nameOf.get(four[1]!)! } };
}

test.describe("X-UP-1 the runner-up compared on three matches", () => {
  test("the Standings tab says the runners-up were compared on 3 matches and names the result left out, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { divisionId, names } = await seedUnequalGroups(request);
    const fill = (key: string, vars: Record<string, string | number> = {}) => dictString("en", key, vars);
    const label = (k: string) => fill("table.poolLabel", { key: k });
    const fifth = fill("table.ordinal.other", { n: 5 });
    const line = fill("table.bestNth.basis.other", { who: fill("table.bestNth.who.2"), count: 3, against: fill("table.bestNth.against", { place: fifth, pools: label("A") }) });
    expect(line, "the owner-approved sentence, from the dictionary").toBe("Best runners-up compared on 3 matches (results v 5th in Group A not counted)");
    const leftOut = [
      fill("table.bestNth.leftOut.result", { name: names.a2, opponent: names.a5, place: fifth, pool: label("A") }),
      fill("table.bestNth.leftOut.none", { name: names.b2, pool: label("B") }),
    ];
    await page.goto(await divisionPath(request, divisionId, "?tab=standings"));
    await dismissCookieBanner(page);
    const note = page.getByTestId("standings-bestnth-basis");
    await expect(note.getByTestId("standings-bestnth-basis-line")).toHaveText(line);
    // The left-out results are behind the disclosure until opened (a summary click is the person's tap).
    const list = note.getByTestId("standings-bestnth-left-out");
    await expect(list).toBeHidden();
    await note.getByText(fill("table.bestNth.leftOut.title"), { exact: true }).click();
    await expect(list.locator("li")).toHaveText(leftOut);
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(note.getByTestId("standings-bestnth-basis-line")).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await note.screenshot({ path: `${process.env.W5B_SHOTS}/xup1-footnote-${width}.png` });
      widths++;
    }
    expect(widths).toBe(3);
  });
});

// W5 app PR B Task 6 (X-QS-1, X-QS-2; RB5-T14, ST-G17; R24 pick 17 A). A finished group keeps its cut, frozen: who went through
// reads Qualified, the rest Out, the cut line says the places WENT through, and the legend drops "Still open". Three pools of four,
// top two of each into the knockout (`seedThreePools`, the real routes to the groups' Complete). Completed and not yet seated, the
// markers freeze from each pool's final order; once the organiser confirms the knockout's proposal they read who it seated.
// Before Task 6 a finished table drew no marker, no line and no legend at all. (The best-Nth shape - K25 - is pinned in the
// unit and DB suites: its smallest e2e field, 9 into 2 pools top 3, is a 3-team bracket the confirm refuses, RB5-D10.)
test.describe("X-QS-1 the finished group still says who went through", () => {
  test("Qualified / Out on every pool's table, before and after the knockout is seated, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(150_000);
    const { divisionId, koId, poolOf, seedOf, nameOf } = await seedThreePools(request, "setup");
    const fill = (key: string, vars: Record<string, string | number> = {}) => dictString("en", key, vars);
    // the rulebook read by hand: the higher seed wins every meeting, so each pool's two best seeds went through
    const want = new Map<string, string>();
    for (const pool of ["A", "B", "C"]) {
      const members = [...poolOf].filter(([, p]) => p === pool).map(([id]) => id).sort((a, b) => seedOf.get(a)! - seedOf.get(b)!);
      members.forEach((id, i) => want.set(nameOf.get(id)!, i < 2 ? "qualified" : "out"));
    }
    expect(want.size, "every seat of the three pools is checked").toBe(12);
    const qualOf = (name: string) =>
      page.locator("tr[data-qual]").filter({ hasText: name }).filter({ visible: true }).first().getAttribute("data-qual", { timeout: 2_000 }).catch(() => null);
    const expectFrozen = async (when: string) => {
      for (const [name, kind] of want) await expect.poll(() => qualOf(name), `${when}: ${name}`).toBe(kind);
      const legend = page.getByTestId("qual-legend").filter({ visible: true }).first();
      await expect(legend).toContainText(fill("table.qual.legend.qualified"));
      await expect(legend).not.toContainText(fill("table.qual.legend.open"));
      await expect(page.getByText(fill("table.qual.cutFrozen.other", { n: 2, next: "Knockout" }), { exact: false }).filter({ visible: true })).toHaveCount(3);
    };
    await page.goto(await divisionPath(request, divisionId, "?tab=standings"));
    await dismissCookieBanner(page);
    await expectFrozen("completed, nobody seated");

    const proposal = await apiJson<{ id: string }>(request, `/api/v1/stages/${koId}/seed-proposal`, "POST");
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    const confirmed = await apiJson(request, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
    await page.reload();
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectFrozen(`seated, ${width}`);
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/xqs1-frozen-${width}.png`, fullPage: true });
      widths++;
    }
    expect(widths).toBe(3);
  });
});

// W5 app PR B Task 1 (X-PO-1 <- RB5-P1; B1 review m-3): pools are seating, so a Started group nobody has played is no longer "No
// standings yet" - its public division page shows each pool's table, every seat level. Two tables per stage is a new composition
// on screen: read at 1280, 768 and 320, no horizontal scroll.
test.describe("X-PO-1 a started two-pool group shows both pools level on its public page", () => {
  test("both pools' tables list every seat before a result, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(90_000);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `XPO1 ${TAG}`, visibility: "public" });
    expect(comp.status).toBe(201);
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(div.status).toBe(201);
    const names = Array.from({ length: 6 }, (_, i) => `Level ${i + 1} ${TAG}`);
    expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/entrants`, "POST", names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })))).status).toBe(201);
    const drafts = buildTemplateStages("groups_ko", { qualified: 2, poolCount: 2, swissRounds: 3, legs: 1 });
    const stages = await apiJson<{ id: string; kind: string }[]>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST",
      drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })));
    expect(stages.status).toBe(201);
    for (const s of [...stages.data!].reverse()) expect((await apiJson(request, `/api/v1/stages/${s.id}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBe(200);
    const orgs = await apiJson<{ slug: string }[]>(request, "/api/orgs");
    const orgSlug = (orgs.data ?? (orgs as unknown as { slug: string }[]))[0]!.slug;
    await page.goto(`/live/${orgSlug}/${comp.data!.slug}/${div.data!.slug}?tab=standings`);
    await dismissCookieBanner(page);
    const label = (k: string) => dictString("en", "table.poolLabel", { key: k });
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      // The hidden Schedule panel names the pools too: read the table the person sees.
      for (const k of ["A", "B"]) await expect(page.getByText(label(k), { exact: false }).filter({ visible: true }).first(), `${width}: ${label(k)}`).toBeVisible();
      // Every seat of both pools is listed (three each), before any result.
      for (const n of names) await expect(page.getByText(n, { exact: true }).first(), `${width}: ${n} seated`).toBeAttached();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/xpo1-level-pools-${width}.png`, fullPage: true });
      widths++;
    }
    expect(widths).toBe(3);
  });
});

// W5 app PR B Task 5 (FX-G5, ruling 281; RB5-D1, X-PD-1, X-PD-4, RB5-D10). Groups feed a knockout with no pool-mates in round one: the
// draw is the engine's, over the stored seed, and the Fixtures tab says which seed under the knockout's header - or, where no ordering
// keeps pool-mates apart, a red band naming the pool. Before Start, the builder warns of the shape that can be refused. Driven through
// the real routes (the groups_ko card's drafts, Generate, Start, the scorer's result door, Complete, the proposal and its confirm) and
// read on the page a person opens, at 1280, 768 and 320. Copy is the shipped dictionaries' (ui, errors), never typed.

type KoFx = Fx & { round_no: number; fixture_no: number | null };
const ERRORS_EN = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/errors.json", import.meta.url)), "utf8")) as Record<string, string>;
const fillErr = (key: string, vars: Record<string, string | number>) => ERRORS_EN[key]!.replace(/\{(\w+)\}/g, (w, k: string) => (k in vars ? String(vars[k]) : w));

/** 12 into 3 pools (snake: 4 each), Top 6 - every pool's winner and runner-up, into an 8-draw: the quarter-finals. Every meeting goes
 *  to the higher seed, so each pool finishes in seed order. Pools are lettered by their best seed (snake: A holds seed 1), and each wins
 *  by its own margin (A 4-0, B 3-0, C 2-0): a winner is +3m and a runner-up +m, so the cross-pool order is A1, B1, C1, A2, B2, C2 with no
 *  tie. A uniform score ties the winners across pools and the stored seed draws their order (X-PD-3) - another test's question. */
async function seedThreePools(request: APIRequestContext, timing: "setup" | "on_complete" = "setup") {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `XPD1 ${TAG}`, visibility: "private" });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  expect(div.status).toBe(201);
  const divisionId = div.data!.id;
  const field = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
    Array.from({ length: 12 }, (_, i) => ({ kind: "individual", display_name: `Cross ${i + 1} ${TAG}`, seed: i + 1 })));
  expect(field.status).toBe(201);
  const seedOf = new Map(field.data!.map((e, i) => [e.id, i + 1]));
  const nameOf = new Map(field.data!.map((e) => [e.id, e.display_name]));
  const drafts = buildTemplateStages("groups_ko", { qualified: 6, poolCount: 3, swissRounds: 3, legs: 1 });
  // on_complete (B2 review m-3): the knockout has no lines until the groups complete; completion seeds and draws it.
  const stages = await apiJson<{ id: string; kind: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST",
    drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression === null ? null : { ...d.progression, timing } })));
  expect(stages.status).toBe(201);
  const groupId = stages.data!.find((s) => s.kind === "group")!.id;
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;
  if (timing === "setup") expect((await apiJson(request, `/api/v1/stages/${koId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/stages/${groupId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
  const lines = ((await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data ?? []).filter((f) => f.stage_id === groupId);
  const byPool = new Map<string, Set<string>>();
  for (const f of lines) for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id) byPool.set(f.pool_id ?? "", (byPool.get(f.pool_id ?? "") ?? new Set()).add(id));
  const pools = [...byPool.values()].map((m) => [...m].sort((a, b) => seedOf.get(a)! - seedOf.get(b)!)).sort((a, b) => seedOf.get(a[0]!)! - seedOf.get(b[0]!)!);
  expect(pools.map((p) => p.length), "12 into 3 pools: 4 each").toEqual([4, 4, 4]);
  const poolOf = new Map(pools.flatMap((members, p) => members.map((id) => [id, "ABC"[p]!] as const)));
  let scored = 0;
  for (const f of lines) {
    const homeWins = seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)!;
    const m = 4 - "ABC".indexOf(poolOf.get(f.home_entrant_id!)!);
    const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: 0, type: "generic.result", payload: homeWins ? { p1Score: m, p2Score: 0 } : { p1Score: 0, p2Score: m },
    });
    expect(res.status).toBe(201);
    scored++;
  }
  expect(scored, "every meeting of the three pools").toBe(3 * 6);
  expect((await apiJson(request, `/api/v1/stages/${groupId}/complete`, "POST")).status).toBe(200);
  return { divisionId, koId, poolOf, seedOf, nameOf };
}

test.describe("X-PD-1 the quarter-finals cross the pools", () => {
  test("the Fixtures tab shows the cross-pool draw's seed, and the confirmed quarter-finals pair no pool-mates, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(150_000);
    const { divisionId, koId, poolOf, seedOf, nameOf } = await seedThreePools(request);
    const proposal = await apiJson<{ id: string; computed: { crossPoolDraw?: { seed: number; refused?: unknown } } }>(request, `/api/v1/stages/${koId}/seed-proposal`, "POST");
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    const drawSeed = proposal.data!.computed.crossPoolDraw?.seed;
    expect(drawSeed, "the proposal carries its stored draw seed").toEqual(expect.any(Number));
    expect(proposal.data!.computed.crossPoolDraw?.refused, "three pools top two always separate").toBeUndefined();

    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const card = page.locator(`section[data-stage-id="${koId}"]`);
    const seedLine = card.getByTestId("stage-cross-pool-draw-seed");
    await expect(seedLine).toHaveText(uiString("en", "knockout.crossPoolDrawSeed", { seed: drawSeed! }));
    await expect(seedLine).toHaveAttribute("data-draw-seed", String(drawSeed));
    await expect(card.getByTestId("stage-cross-pool-draw-seed-hint")).toHaveText(uiString("en", "knockout.crossPoolDrawSeedHint"));
    await expect(card.getByTestId("stage-cross-pool-refused")).toHaveCount(0);

    const confirmed = await apiJson(request, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
    expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
    const ko = ((await apiJson<KoFx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data ?? []).filter((f) => f.stage_id === koId);
    const first = Math.min(...ko.map((f) => f.round_no));
    const r1 = ko.filter((f) => f.round_no === first);
    const pairs = r1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    const byes = r1.filter((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null)).map((f) => (f.home_entrant_id ?? f.away_entrant_id)!);
    // differential: the fold (A1, B1, C1, A2, B2, C2) on the 8-draw's geometry pairs C1 with C2 at seeds 3 and 6 (RB5-D1's defect).
    expect(pairs, "6 into 8: two real quarter-finals").toHaveLength(2);
    for (const f of pairs) {
      const [h, a] = [f.home_entrant_id!, f.away_entrant_id!];
      expect(poolOf.get(h), `${nameOf.get(h)} v ${nameOf.get(a)}`).not.toBe(poolOf.get(a));
    }
    // RB5-D6 (X-PD-6): the two byes go to the draw's top two, A1 and B1 - the entrants' own seeds 1 and 2. The engine plan's X-PD-1 row
    // (W5 engine T6): A1, B1, C1, A2, B2, C2 into 8 is drawn A1, B1, C1, A2, C2, B2 - C2 v A2 (seeds 4, 6) and C1 v B2 (seeds 3, 5).
    expect(byes.map((id) => seedOf.get(id)).sort(), "byes to the top two pool winners").toEqual([1, 2]);
    expect(pairs.map((f) => [seedOf.get(f.home_entrant_id!)!, seedOf.get(f.away_entrant_id!)!].sort((x, y) => x - y).join("v")).sort(), "the rulebook's row").toEqual(["3v5", "4v6"]);

    await page.reload();
    await expect(seedLine, "the seed stays under the header once confirmed").toHaveAttribute("data-draw-seed", String(drawSeed));
    let checked = 0;
    for (const f of pairs) {
      const row = card.locator(`li[data-fixture-no="${f.fixture_no}"]`);
      await expect(row).toContainText(nameOf.get(f.home_entrant_id!)!);
      await expect(row).toContainText(nameOf.get(f.away_entrant_id!)!);
      checked++;
    }
    expect(checked, "both quarter-finals read on the page").toBe(2);
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await seedLine.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(seedLine).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/xpd1-seed-line-${width}.png` });
      widths++;
    }
    expect(widths).toBe(3);
  });

  test("m-3 a knockout seeded on_complete shows its cross-pool draw seed on the card too, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(150_000);
    // B2 review m-3: completion seeds the knockout itself (no proposal), and its draw records the seed on the seeding ledger.
    const { divisionId, koId, poolOf, nameOf } = await seedThreePools(request, "on_complete");
    const ko = ((await apiJson<KoFx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data ?? []).filter((f) => f.stage_id === koId);
    const first = Math.min(...ko.map((f) => f.round_no));
    const pairs = ko.filter((f) => f.round_no === first && f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(pairs, "completion drew the knockout: two real quarter-finals").toHaveLength(2);
    for (const f of pairs) expect(poolOf.get(f.home_entrant_id!), `${nameOf.get(f.home_entrant_id!)} v ${nameOf.get(f.away_entrant_id!)}`).not.toBe(poolOf.get(f.away_entrant_id!));
    // The stored seed: minted from the stage id (W4 K5) - nothing else stored one for a knockout that was never proposed.
    const drawSeed = swissDrawSeed(koId);
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const card = page.locator(`section[data-stage-id="${koId}"]`);
    const seedLine = card.getByTestId("stage-cross-pool-draw-seed");
    await expect(seedLine).toHaveText(uiString("en", "knockout.crossPoolDrawSeed", { seed: drawSeed }));
    await expect(seedLine).toHaveAttribute("data-draw-seed", String(drawSeed));
    await expect(card.getByTestId("stage-cross-pool-draw-seed-hint")).toHaveText(uiString("en", "knockout.crossPoolDrawSeedHint"));
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await seedLine.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(seedLine).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/m3-on-complete-seed-line-${width}.png` });
      widths++;
    }
    expect(widths).toBe(3);
  });

  test("X-PD-4 a refused draw is a red band on the knockout's card naming the pool, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(120_000);
    // 9 into pools of 5 and 4, Top 3: the best runner-up is the 4-pool's (Group B), so B1 and B2 are two of the three qualifiers and
    // the winners keep their places (RB5-D10): seed 1 has the bye and B1 meets B2 - no ordering separates them.
    const { divisionId, koId } = await seedUnequalGroups(request);
    const proposal = await apiJson<{ computed: { crossPoolDraw?: { refused?: { code: string } } } }>(request, `/api/v1/stages/${koId}/seed-proposal`, "POST");
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    expect(proposal.data!.computed.crossPoolDraw?.refused?.code).toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const card = page.locator(`section[data-stage-id="${koId}"]`);
    const band = card.getByTestId("stage-cross-pool-refused");
    await expect(band).toHaveText(fillErr("seeding.SEEDING_POOL_SEPARATION_IMPOSSIBLE", { pool: "B", count: 2, entrants: 3 }));
    await expect(band).toHaveAttribute("data-code", "SEEDING_POOL_SEPARATION_IMPOSSIBLE");
    await expect(card.getByTestId("stage-cross-pool-draw-seed"), "a refused draw shows no seed line").toHaveCount(0);
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await band.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(band).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/xpd4-red-band-${width}.png` });
      widths++;
    }
    expect(widths).toBe(3);
  });

  test("RB5-D10 the builder warns before Start that two groups into a top three can refuse the draw, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(90_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `RB5D10 ${TAG}`, visibility: "private" });
    expect(comp.status).toBe(201);
    await page.goto(await competitionPath(request, comp.data!.id));
    await dismissCookieBanner(page);
    await page.getByRole("link", { name: `+ ${uiString("en", "action.addDivision")}`, exact: true }).click();
    await page.waitForURL(/\/d\/new$/);
    await page.getByTestId("division-builder-name").fill(`Cup ${TAG}`);
    await page.getByTestId("division-builder-next").click();
    await showAllFormats(page);
    const groups = page.locator('label[data-template="groups_ko"]');
    await groups.click();
    await expect(groups.locator("input")).toBeChecked();
    const pools = page.locator('input[data-format-bound="pools"]');
    const top = page.locator('input[data-format-bound="qualify"]');
    const warning = page.getByTestId("division-builder-draw-can-refuse");
    const says = uiString("en", "divBuilder.format.drawCanRefuse");
    await pools.fill("2");
    await top.fill("3");
    await expect(warning, "X-PD-4's named case").toHaveText(says);
    await top.fill("4");
    await expect(warning, "Top 4 of two pools is whole pool places (X-PD-2)").toHaveCount(0);
    await top.fill("3");
    await expect(warning, "and again").toHaveText(says);
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await warning.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(warning).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/rb5d10-builder-warning-${width}.png` });
      widths++;
    }
    expect(widths).toBe(3);
  });
});

/** 12 into 4 pools of 3 (snake), Top 6 - the four winners and the two best runners-up into an 8-draw: byes to seeds 1 and 2, then
 *  4 v 5 and 3 v 6. Pools are lettered by their best seed. Every winner beats her runner-up 1-0 and her third by her pool's margin
 *  (A 8, B 7, C 6, D 5), so no two winners are level and they keep seeds 1-4; each runner-up beats her third by A 2, B 4, C 3, D 3 -
 *  B2 is the best runner-up, and C2 and D2 are level on every key for the last seat: one flagged tie. */
async function seedRunnersLevel(request: APIRequestContext) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `I1 ${TAG}`, visibility: "private" });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  expect(div.status).toBe(201);
  const divisionId = div.data!.id;
  const field = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
    Array.from({ length: 12 }, (_, i) => ({ kind: "individual", display_name: `Level ${i + 1} ${TAG}`, seed: i + 1 })));
  expect(field.status).toBe(201);
  const seedOf = new Map(field.data!.map((e, i) => [e.id, i + 1]));
  const nameOf = new Map(field.data!.map((e) => [e.id, e.display_name]));
  const drafts = buildTemplateStages("groups_ko", { qualified: 6, poolCount: 4, swissRounds: 3, legs: 1 });
  const stages = await apiJson<{ id: string; kind: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST",
    drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })));
  expect(stages.status).toBe(201);
  const groupId = stages.data!.find((s) => s.kind === "group")!.id;
  const koId = stages.data!.find((s) => s.kind === "knockout")!.id;
  expect((await apiJson(request, `/api/v1/stages/${koId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/stages/${groupId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
  const lines = ((await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data ?? []).filter((f) => f.stage_id === groupId);
  const byPool = new Map<string, Set<string>>();
  for (const f of lines) for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id) byPool.set(f.pool_id ?? "", (byPool.get(f.pool_id ?? "") ?? new Set()).add(id));
  const pools = [...byPool.values()].map((m) => [...m].sort((a, b) => seedOf.get(a)! - seedOf.get(b)!)).sort((a, b) => seedOf.get(a[0]!)! - seedOf.get(b[0]!)!);
  expect(pools.map((p) => p.map((id) => seedOf.get(id))), "the premise: the snake's pools").toEqual([[1, 8, 9], [2, 7, 10], [3, 6, 11], [4, 5, 12]]);
  const poolOf = new Map(pools.flatMap((members, p) => members.map((id) => [id, "ABCD"[p]!] as const)));
  const winnerMargin = { A: 8, B: 7, C: 6, D: 5 } as Record<string, number>;
  const runnerMargin = { A: 2, B: 4, C: 3, D: 3 } as Record<string, number>;
  let scored = 0;
  for (const f of lines) {
    const [h, a] = [f.home_entrant_id!, f.away_entrant_id!];
    const members = pools["ABCD".indexOf(poolOf.get(h)!)]!;
    const [hi, ai] = [members.indexOf(h), members.indexOf(a)];
    const winnerIndex = Math.min(hi, ai);
    const margin = winnerIndex === 1 ? runnerMargin[poolOf.get(h)!]! : Math.max(hi, ai) === 1 ? 1 : winnerMargin[poolOf.get(h)!]!;
    const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: 0, type: "generic.result", payload: hi < ai ? { p1Score: margin, p2Score: 0 } : { p1Score: 0, p2Score: margin },
    });
    expect(res.status).toBe(201);
    scored++;
  }
  expect(scored, "every meeting of the four pools").toBe(4 * 3);
  expect((await apiJson(request, `/api/v1/stages/${groupId}/complete`, "POST")).status).toBe(200);
  const [[a1, a2], [b1, b2], [c1, c2], [d1, d2]] = pools as [string, string][];
  return { divisionId, koId, poolOf, nameOf, a1: a1!, b1: b1!, c1: c1!, d1: d1!, a2: a2!, b2: b2!, c2: c2!, d2: d2! };
}

type Draft = { id: string; computed: { qualifiers: { rank: number; entrantId: string; destinationSlot: string }[]; ties: { slots: string[]; entrantIds: string[] }[]; crossPoolDraw?: { seed: number; refused?: unknown } } };

test.describe("I-1 a tie pick with another change on a drawn draft", () => {
  test("the pick re-draws round one: the desk shows the new draft with the changes cleared, and the change made again confirms, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(150_000);
    const s = await seedRunnersLevel(request);
    const proposal = await apiJson<Draft>(request, `/api/v1/stages/${s.koId}/seed-proposal`, "POST");
    expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
    const draft = proposal.data!;
    expect(draft.computed.crossPoolDraw?.refused, "the premise: drawn").toBeUndefined();
    expect(draft.computed.ties, "the premise: one flagged tie").toHaveLength(1);
    const tie = draft.computed.ties[0]!;
    expect(new Set(tie.entrantIds), "the premise: C2 and D2 level").toEqual(new Set([s.c2, s.d2]));
    const drafted = draft.computed.qualifiers.find((q) => q.destinationSlot === tie.slots[0])!.entrantId;
    const picked = drafted === s.c2 ? s.d2 : s.c2;
    // What the new draft must show: the engine's draw over the picked slate - the winners in place, then B2 and the pick.
    const redrawn = crossPoolDraw(
      [...[s.a1, s.b1, s.c1, s.d1].map((entrantId) => ({ entrantId, pool: s.poolOf.get(entrantId)!, tier: 1 })), ...[s.b2, picked].map((entrantId) => ({ entrantId, pool: s.poolOf.get(entrantId)!, tier: 2 }))],
      "single_elim",
      draft.computed.crossPoolDraw!.seed,
    ).order;
    expect(redrawn.indexOf(s.b2) + 1, "the premise: the re-draw moves B2").not.toBe(draft.computed.qualifiers.find((q) => q.entrantId === s.b2)!.rank);

    await page.goto(await divisionPath(request, s.divisionId, "?tab=fixtures"));
    await dismissCookieBanner(page);
    const panel = page.locator('[data-progression-state="draft"]');
    await expect(panel).toBeVisible();
    const rowOf = (slot: string) => panel.locator(`tr[data-progression-row="${slot}"] select`);
    const slotShowing = async (entrantId: string) => {
      const rows = await panel.locator("tr[data-progression-row]").evaluateAll((els) =>
        els.map((r) => ({ slot: r.getAttribute("data-progression-row")!, name: (r.querySelector("select") as HTMLSelectElement).selectedOptions[0]?.textContent ?? "" })));
      return rows.find((r) => r.name === s.nameOf.get(entrantId))?.slot;
    };
    const shown = async () =>
      (await panel.locator("tr[data-progression-row]").evaluateAll((els) =>
        els.map((r) => ({ rank: Number(r.querySelector("td")?.textContent), name: (r.querySelector("select") as HTMLSelectElement).selectedOptions[0]?.textContent ?? "" }))))
        .sort((x, y) => x.rank - y.rank)
        .map((r) => r.name);
    // The organiser picks the other runner-up for the tied seat and puts A2 where the draft shows B2.
    await rowOf(tie.slots[0]!).selectOption({ label: s.nameOf.get(picked)! });
    await rowOf((await slotShowing(s.b2))!).selectOption({ label: s.nameOf.get(s.a2)! });
    await panel.getByRole("button", { name: uiString("en", "progression.confirmCta") }).click();
    const alert = panel.getByRole("alert");
    await expect(alert).toHaveText(fillErr("seeding.proposalRedrawn", {}));
    const ko = async () => ((await apiJson<KoFx[]>(request, `/api/v1/divisions/${s.divisionId}/fixtures`)).data ?? []).filter((f) => f.stage_id === s.koId);
    expect((await ko()).filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null), "nothing seated").toHaveLength(0);
    // The desk now shows the new draft exactly: no tie left, the engine's seats, none of the changes made against the old seats.
    await expect(panel.locator('tr[data-progression-tied="true"]')).toHaveCount(0);
    await expect.poll(shown, { message: "the new draft, the changes cleared" }).toEqual(redrawn.map((id) => s.nameOf.get(id)!));
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await alert.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(alert).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/i1-redrawn-${width}.png` });
      widths++;
    }
    expect(widths).toBe(3);

    // The change made again, where the new draft shows B2.
    await page.setViewportSize({ width: 1280, height: 900 });
    await rowOf((await slotShowing(s.b2))!).selectOption({ label: s.nameOf.get(s.a2)! });
    await panel.getByRole("button", { name: uiString("en", "progression.confirmCta") }).click();
    await expect(page.locator('[data-progression-state="confirmed"]')).toBeVisible({ timeout: 30_000 });
    const lines = await ko();
    const first = Math.min(...lines.map((f) => f.round_no));
    const r1 = lines.filter((f) => f.round_no === first);
    const pairs = r1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(pairs, "6 into 8: two real round-one matches").toHaveLength(2);
    for (const f of pairs) expect(s.poolOf.get(f.home_entrant_id!), `${s.nameOf.get(f.home_entrant_id!)} v ${s.nameOf.get(f.away_entrant_id!)}`).not.toBe(s.poolOf.get(f.away_entrant_id!));
    const seated = new Set(r1.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((id): id is string => id !== null));
    expect([seated.has(picked), seated.has(s.a2), seated.has(s.b2)], "the pick and A2 seated, B2 (replaced) not").toEqual([true, true, false]);
  });
});
