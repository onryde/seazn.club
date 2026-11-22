import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, competitionPath, divisionPath, expectNoHorizontalScroll, showAllFormats, stageCardOf } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { STAGE_TEMPLATES, buildTemplateStages } from "../src/lib/format-templates";
import { crossPoolDraw } from "@seazn/engine/scheduling";
import { swissDrawSeed } from "../src/lib/swiss-draw";
import { dictString, uiString } from "./spectator-w2-kit";
import { rowToggle, saveRoster, seedPair, seedPlayer, storedMembers, uiEn } from "./entrant-rename-kit";
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

// W5 app PR B Task 7 (C5; X-ADJ-4; R24 pick 15 A). The organiser deducts three points from a started league through the desk - the stage
// card's More, "Adjust points…", the dialog - and the public table re-ranks and says why under it. Driven through the real routes (the
// division, Start, the scorer's result door) and the real screens, the desk at 1280, 768 and 320 (the dialog opened at each, the write
// made once), the public Standings tab at 1280, 768 and 320. Copy is the shipped dictionaries' (`uiString`, `dictString`), never typed.
// Expected values are the rule's: generic pays 3 for a win, so the two winners are level on 3 and −3 leaves the adjusted one on 0.
test.describe("X-ADJ-4 Adjust points", () => {
  test("X-ADJ-4 the organiser deducts three points and the table says why", async ({ page, request }) => {
    test.setTimeout(180_000);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `XADJ4 ${TAG}`, visibility: "public" });
    expect(comp.status).toBe(201);
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(div.status).toBe(201);
    const names = ["Marsh Lane Wanderers Community Football Club", "Harbour Vale", "Dunmore Park", "Kilbride Rovers"].map((n) => `${n} ${TAG}`);
    const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.data!.id}/entrants`, "POST", names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })));
    expect(ents.status).toBe(201);
    const ids = ents.data!.map((e) => e.id);
    const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", [{ seq: 1, kind: "league", name: "League", config: { legs: 1 } }]);
    expect(stages.status).toBe(201);
    const stageId = stages.data![0]!.id;
    expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBe(200);
    const lines = (await apiJson<Fx[]>(request, `/api/v1/divisions/${div.data!.id}/fixtures`)).data!;
    const between = (x: string, y: string) => lines.find((f) => [f.home_entrant_id, f.away_entrant_id].sort().join() === [x, y].sort().join())!;
    for (const [w, l] of [[ids[0]!, ids[1]!], [ids[2]!, ids[3]!]]) {
      const f = between(w, l);
      const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: 0, type: "generic.result", payload: f.home_entrant_id === w ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 } });
      expect(res.status).toBe(201);
    }
    type Row = { entrantId: string; rank: number | null; points: number };
    const table = async () => [...(await apiJson<{ rows: Row[] }>(request, `/api/v1/stages/${stageId}/standings`)).data!.rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    const before = await table();
    expect(before.slice(0, 2).map((r) => r.points), "premise: the two winners are level on 3").toEqual([3, 3]);
    const top = before[0]!.entrantId;
    const rival = before[1]!.entrantId;
    const topName = names[ids.indexOf(top)]!;
    const REASON = "fielded an ineligible player";

    // The desk: the dialog opens from More at every width; the write is made once, at the first.
    let desk = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(await divisionPath(request, div.data!.id, "?tab=fixtures"), { waitUntil: "load" });
      await dismissCookieBanner(page);
      const card = stageCardOf(page, stageId);
      await expect(card, `${width}: the stage card`).toBeVisible({ timeout: 20_000 });
      const trigger = card.getByTestId("stage-rail-trigger");
      if (await trigger.isVisible()) await trigger.click();
      await card.getByTestId("stage-more").click();
      const item = card.getByTestId("stage-adjust-points");
      await expect(item, `${width}: the item, in the dictionary's words`).toContainText(uiString("en", "stage.more.adjustPoints"));
      await item.click();
      const dialog = page.getByTestId("adjust-points-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(uiString("en", "adjustPoints.title", { stage: "League" }));
      const select = dialog.getByTestId("adjust-points-entrant");
      await expect(select).toBeEnabled();
      await expect(select.locator("option"), `${width}: Choose plus the four members`).toHaveCount(5);
      // B3 ruling 4: an amount past 999 is named under the stepper and Apply waits; 999 itself is taken. Nothing is written here.
      await select.selectOption(top);
      await dialog.getByTestId("adjust-points-reason").fill(REASON);
      const field = dialog.getByTestId("adjust-points-delta");
      await field.fill("1000");
      await expect(dialog.getByTestId("adjust-points-range"), `${width}: the bound, in the dictionary's words`).toHaveText(
        uiString("en", "roundrobin.refusal.RR_ADJUST_OUT_OF_RANGE", { max: "999" }),
      );
      await expect(dialog.getByTestId("adjust-points-apply"), `${width}: past the bound, Apply waits`).toBeDisabled();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/b3-range-${width}.png`, fullPage: false });
      await field.fill("-999");
      await expect(dialog.getByTestId("adjust-points-range")).toHaveCount(0);
      await expect(dialog.getByTestId("adjust-points-apply"), `${width}: 999 either way is taken`).toBeEnabled();
      await field.fill("");
      await dialog.getByTestId("adjust-points-reason").fill("");
      if (desk === 0) {
        await select.selectOption(top);
        for (let i = 0; i < 3; i++) await dialog.getByTestId("adjust-points-decrease").click();
        await expect(dialog.getByTestId("adjust-points-amount")).toHaveText(uiString("en", "adjustPoints.amount.points.other", { amount: "\u22123" }));
        await expect(dialog.getByTestId("adjust-points-apply"), "no reason: Apply waits").toBeDisabled();
        await dialog.getByTestId("adjust-points-reason").fill(REASON);
        await dialog.getByTestId("adjust-points-apply").click();
        await expect(dialog.getByTestId("adjust-points-notice")).toHaveText(uiString("en", "adjustPoints.applied"));
      }
      // The adjustment in force, with its Undo, at every width.
      const row = dialog.locator('[data-testid^="adjust-points-row-"]');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(topName);
      await expect(row).toContainText(REASON);
      await expect(row.locator('[data-testid^="adjust-points-undo-"]')).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/xadj4-dialog-${width}.png`, fullPage: false });
      await dialog.getByTestId("adjust-points-close").click();
      await expect(dialog).toBeHidden();
      desk++;
    }
    expect(desk).toBe(3);

    // The fold: the adjusted winner on 0, below the rival she was level with.
    const after = await table();
    expect(after[0]!.entrantId).toBe(rival);
    expect(after.find((r) => r.entrantId === top)!.points).toBe(0);

    // The public table says why, under it, at every width.
    const orgs = await apiJson<{ slug: string }[]>(request, "/api/orgs");
    const orgSlug = (orgs.data ?? (orgs as unknown as { slug: string }[]))[0]!.slug;
    await page.goto(`/live/${orgSlug}/${comp.data!.slug}/${div.data!.slug}?tab=standings`);
    await dismissCookieBanner(page);
    const body = dictString("en", "table.adjustmentNote.points.other", { amount: "\u22123", reason: REASON, date: "" }).replace(/[,.]?\s*\.?$/, "");
    let pub = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const note = page.getByTestId(`standings-adjustment-note-${top}`).filter({ visible: true }).first();
      await expect(note, `${width}: the footnote`).toBeVisible();
      await expect(note).toContainText(dictString("en", "table.adjustmentNote.lead", { name: topName }));
      await expect(note).toContainText(body);
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/xadj4-public-${width}.png`, fullPage: true });
      pub++;
    }
    expect(pub).toBe(3);
  });
});

test.describe("B3 ruling 3 a carried table names the adjustment it carries", () => {
  test("the next stage's table says the −3 was carried from the first, under it, at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(180_000);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `B3C ${TAG}`, visibility: "public" });
    expect(comp.status).toBe(201);
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(div.status).toBe(201);
    const names = ["Marsh Lane Wanderers Community Football Club", "Harbour Vale", "Dunmore Park", "Kilbride Rovers"].map((n) => `${n} ${TAG}`);
    const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.data!.id}/entrants`, "POST", names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })));
    expect(ents.status).toBe(201);
    const ids = ents.data!.map((e) => e.id);
    const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", [
      { seq: 1, kind: "league", name: "Table", config: { legs: 1 } },
      {
        seq: 2,
        kind: "league",
        name: "Super pool",
        config: { legs: 1 },
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "on_complete", carry: "points" },
      },
    ]);
    expect(stages.status).toBe(201);
    const [first, second] = stages.data!.map((x) => x.id) as [string, string];
    expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBe(200);
    const lines = (await apiJson<Fx[]>(request, `/api/v1/divisions/${div.data!.id}/fixtures`)).data!.filter((f) => f.home_entrant_id && f.away_entrant_id);
    expect(lines, "premise: every line of four").toHaveLength(6);
    for (const f of lines) {
      const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: 0, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
      expect(res.status).toBe(201);
    }
    const REASON = "fielded an ineligible player";
    const adjusted = ids[0]!;
    expect((await apiJson(request, `/api/v1/stages/${first}/adjustments`, "POST", { entrant_id: adjusted, delta: -3, reason: REASON })).status).toBe(201);
    expect((await apiJson(request, `/api/v1/stages/${first}/complete`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/stages/${second}/generate`, "POST")).status).toBeLessThan(300);

    const orgs = await apiJson<{ slug: string }[]>(request, "/api/orgs");
    const orgSlug = (orgs.data ?? (orgs as unknown as { slug: string }[]))[0]!.slug;
    await page.goto(`/live/${orgSlug}/${comp.data!.slug}/${div.data!.slug}?tab=standings`);
    await dismissCookieBanner(page);
    const carried = dictString("en", "table.adjustmentNote.points.carried.other", { amount: "\u22123", stage: "Table", reason: REASON, date: "" }).replace(/[,.]?\s*\.?$/, "");
    const own = dictString("en", "table.adjustmentNote.points.other", { amount: "\u22123", reason: REASON, date: "" }).replace(/[,.]?\s*\.?$/, "");
    let checked = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const notes = page.getByTestId(`standings-adjustment-note-${adjusted}`).filter({ visible: true });
      await expect(notes.filter({ hasText: carried }), `${width}: the carried table names it`).toHaveCount(1);
      await expect(notes.filter({ hasText: own }).filter({ hasNotText: "carried" }), `${width}: the first table keeps its own line`).toHaveCount(1);
      await expect(notes.filter({ hasText: carried }).first()).toContainText(dictString("en", "table.adjustmentNote.lead", { name: names[0]! }));
      await expectNoHorizontalScroll(page);
      if (process.env.W5B_SHOTS) await page.screenshot({ path: `${process.env.W5B_SHOTS}/b3-carried-${width}.png`, fullPage: true });
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// ===========================================================================================================================
// W5 app PR B, Task 8 (T5-a, T5-c): the seven round-robin ROWS, each through the real desk and the page a person opens, and the
// badminton doubles league. One describe per row (`ROWS`, counted and asserted below): the seats on the public Standings tab, a late
// entry (X-CU-7, X-CU-9), a withdrawal on one side of the cut line (X-PO-2, X-WDT-7), the field played out, one points adjustment made
// in the desk's dialog BEFORE Complete (X-ADJ-1..4), Complete, and the frozen cut: Qualified / Out on every table, then the same
// markers once the next stage is seated from the draft (X-QS-1, X-QS-2). The pooled rows also drive the pool of one (X-BD-5 / C38): refused by name, nothing written.
//
// Every expected value comes from the rulebook, never from a page or the code under test: in each table the HIGHER SEED wins every
// meeting (1-0), so a member's wins are the number of actives seeded below her, a win pays 3 (the generic variant), a leaver is
// ranked last whatever she scored (X-WDT-7), and an adjustment is added to the points the table folds before its order is read.
// `modelTable` is that arithmetic, and it refuses a tie (a tie would be broken by a rule this spec does not model). The pool a
// newcomer lands in and the pools' membership are read off the stage's own lines, never assumed - the late entrant takes the
// product's pick (the smallest pool), and the model follows the lines.
//
// Setup (competition, entrants, the stages a template builds, Generate, Start, the scorer's result door, Complete, the draft's confirm)
// is the real API; the late entry and the withdrawal are the routes the desk's Add and Withdraw call (app PR A's X-CU-7 / X-CU-11 and
// X-WDT specs drive those forms by hand); the points adjustment is made BY HAND in the stage card's dialog. What the desk shows - who is
// seated, who went through, what the table says of the leaver - is read on the public Standings tab at 1280, 768 and 320.

const pad2 = (i: number) => String(i).padStart(2, "0");

type RowKey = "league" | "league_ko" | "groups_ko" | "group_stepladder" | "group_playoffs" | "group_only" | "group_group_ko";
interface RowSpec {
  key: RowKey;
  /** The rule ids this row's test carries in its title. */
  ids: string;
  /** The field at Start, before the late entry (the late entrant is seed n + 1). */
  n: number;
  /** Pools in the first stage; 0 is a league. */
  pools: number;
  /** Seats the first stage hands the next one, in all (an even share of every pool); 0 when the row has no cut. */
  qualified: number;
  /** The seed of the entrant who withdraws, and the side of the cut her place was on (a guard, checked against the seeds). */
  leaver: { seed: number; side: "above" | "below" | "none" };
  /** The points adjustment, made in the desk's dialog (the late entrant is seed n + 1). */
  adjust: { seed: number; delta: number };
}

/** The gallery's field for `group_group_ko`: one of the catalog's own offered sizes (asserted), pools of four. */
const GALLERY_FIELD = 12;

const ROWS: RowSpec[] = [
  { key: "league", ids: "X-PO-1, X-CU-7, X-WDT-7, X-ADJ-1, X-ADJ-4", n: 6, pools: 0, qualified: 0, leaver: { seed: 3, side: "none" }, adjust: { seed: 1, delta: -30 } },
  { key: "league_ko", ids: "X-CU-7, X-WDT-7, X-ADJ-1, X-ADJ-4, X-QS-1, X-QS-2", n: 6, pools: 0, qualified: 4, leaver: { seed: 2, side: "above" }, adjust: { seed: 1, delta: -30 } },
  { key: "groups_ko", ids: "X-PO-1, X-PO-2, X-CU-7, X-WDT-7, X-ADJ-1, X-ADJ-4, X-QS-1, X-QS-2", n: 8, pools: 2, qualified: 4, leaver: { seed: 3, side: "above" }, adjust: { seed: 1, delta: -30 } },
  { key: "group_stepladder", ids: "X-CU-7, X-WDT-7, X-ADJ-1, X-ADJ-4, X-QS-1, X-QS-2", n: 6, pools: 0, qualified: 4, leaver: { seed: 6, side: "below" }, adjust: { seed: 3, delta: -30 } },
  { key: "group_playoffs", ids: "X-CU-7, X-WDT-7, X-ADJ-1, X-ADJ-4, X-QS-1, X-QS-2", n: 6, pools: 0, qualified: 4, leaver: { seed: 5, side: "below" }, adjust: { seed: 7, delta: 30 } },
  { key: "group_only", ids: "X-PO-1, X-PO-2, X-CU-7, X-WDT-7, X-ADJ-1, X-ADJ-4", n: 8, pools: 2, qualified: 0, leaver: { seed: 6, side: "none" }, adjust: { seed: 2, delta: -30 } },
  { key: "group_group_ko", ids: "X-PO-1, X-PO-2, X-CU-7, X-CU-9, X-WDT-7, X-ADJ-1, X-ADJ-4, X-QS-1, X-QS-2", n: GALLERY_FIELD, pools: GALLERY_FIELD / 4, qualified: (GALLERY_FIELD / 4) * 2, leaver: { seed: 4, side: "above" }, adjust: { seed: 1, delta: -30 } },
];

const SUPER_GROUPS = JSON.parse(readFileSync(fileURLToPath(new URL("../src/server/templates/catalog/super-groups.json", import.meta.url)), "utf8")) as {
  divisions: { entrantCountOptions: number[]; stages: { kind: string; poolSize?: number }[] }[];
};

type Line = Fx & { status: string; round_no: number };
const SETTLED = new Set(["decided", "finalized", "forfeited", "abandoned", "voided", "cancelled"]);

async function rowLines(request: APIRequestContext, divisionId: string, stageId?: string): Promise<Line[]> {
  const all = await apiJson<Line[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return (all.data ?? []).filter((f) => stageId === undefined || f.stage_id === stageId);
}

/** A pool's members are the entrants its lines name; a league is one pool, keyed "". */
function membersByPool(lines: Line[]): Map<string, string[]> {
  const pools = new Map<string, Set<string>>();
  for (const f of lines) for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id) pools.set(f.pool_id ?? "", (pools.get(f.pool_id ?? "") ?? new Set()).add(id));
  return new Map([...pools].map(([k, s]) => [k, [...s]]));
}

interface Seeded {
  competitionId: string;
  divisionId: string;
  /** Entrant id <-> seed (1-based) <-> display name. */
  idOf: Map<number, string>;
  seedOf: Map<string, number>;
  nameOf: Map<string, string>;
  /** The root table (the division's entry stage), and the stage its cut feeds with that stage's name. */
  tableId: string;
  nextId: string | null;
  nextName: string | null;
}

const rowName = (key: string, seed: number) => `${key} P${pad2(seed)} ${TAG}`;

/** The division a row plays: `n` seeded entrants, the stages its template builds (through the PR A gallery's `super-groups` for
 *  `group_group_ko`), and - unless `start: false` - every stage generated (the later stages first: their progression is `setup`) and
 *  the division started. */
async function seedRow(request: APIRequestContext, row: RowSpec, o: { n?: number; start?: boolean } = {}): Promise<Seeded> {
  const n = o.n ?? row.n;
  let competitionId: string;
  let divisionId: string;
  let stages: { id: string; seq: number; kind: string; name: string }[] = [];
  if (row.key === "group_group_ko") {
    expect(SUPER_GROUPS.divisions[0]!.entrantCountOptions, "premise: the catalog offers the field this row plays").toContain(GALLERY_FIELD);
    const made = await apiJson<{ competitionId: string; visibility: string; divisions: { id: string }[] }>(request, "/api/v1/competitions/from-template", "POST", {
      template_key: "super-groups",
      name: `${row.key} ${TAG}`,
      ends_on: "2030-12-31",
      visibility: "public",
      sport_key: "generic",
      variant_key: "score",
      entrant_kind: "individual",
      entrant_count: GALLERY_FIELD,
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    expect(made.data!.visibility, "premise: the competition is public (the cap did not turn it private)").toBe("public");
    expect(made.data!.divisions, "one division").toHaveLength(1);
    competitionId = made.data!.competitionId;
    divisionId = made.data!.divisions[0]!.id;
    const listed = await apiJson<{ id: string; seq: number; kind: string; name: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`);
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    stages = [...listed.data!].sort((a, b) => a.seq - b.seq);
    expect(stages.map((s) => s.kind), "the gallery's shape: table, table, bracket").toEqual(SUPER_GROUPS.divisions[0]!.stages.map((s) => s.kind));
  } else {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${row.key} ${TAG}`, visibility: "public" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    competitionId = comp.data!.id;
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    divisionId = div.data!.id;
  }
  const field = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
    Array.from({ length: n }, (_, i) => ({ kind: "individual", display_name: rowName(row.key, i + 1), seed: i + 1 })));
  expect(field.status, JSON.stringify(field.error)).toBe(201);
  if (row.key !== "group_group_ko") {
    const drafts = buildTemplateStages(row.key, { qualified: row.qualified || 4, poolCount: row.pools || 2, swissRounds: 3, legs: 1 });
    const made = await apiJson<{ id: string; kind: string; name: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST",
      drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })));
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    stages = made.data!.map((s, i) => ({ ...s, seq: i + 1 }));
  }
  if (o.start !== false) {
    for (const s of [...stages].reverse()) expect((await apiJson(request, `/api/v1/stages/${s.id}/generate`, "POST")).status, `generate ${s.name}`).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
  }
  const idOf = new Map(field.data!.map((e, i) => [i + 1, e.id]));
  return {
    competitionId,
    divisionId,
    idOf,
    seedOf: new Map(field.data!.map((e, i) => [e.id, i + 1])),
    nameOf: new Map(field.data!.map((e, i) => [e.id, rowName(row.key, i + 1)])),
    tableId: stages[0]!.id,
    nextId: row.qualified > 0 ? stages[1]!.id : null,
    nextName: row.qualified > 0 ? stages[1]!.name : null,
  };
}

/** The arithmetic of the rulebook (see the header). `pools` is membership by pool (a league is one pool, ""); the result gives each
 *  member's place within her pool, her points and her wins. A tie is refused: the order must be the rulebook's alone. */
function modelTable(pools: Map<string, string[]>, seedOf: Map<string, number>, leaverId: string | null, adj: { id: string; delta: number } | null) {
  const out = new Map<string, { pool: string; rank: number; points: number; won: number }>();
  for (const [pool, members] of pools) {
    const actives = members.filter((id) => id !== leaverId).sort((a, b) => seedOf.get(a)! - seedOf.get(b)!);
    const scored = actives.map((id, i) => ({ id, won: actives.length - 1 - i, points: 3 * (actives.length - 1 - i) + (adj !== null && id === adj.id ? adj.delta : 0) }));
    scored.sort((a, b) => b.points - a.points);
    expect(new Set(scored.map((s) => s.points)).size, `premise: pool "${pool}" has no tie, so its order is the rulebook's alone`).toBe(scored.length);
    scored.forEach((s, i) => out.set(s.id, { pool, rank: i + 1, points: s.points, won: s.won }));
    if (leaverId !== null && members.includes(leaverId)) out.set(leaverId, { pool, rank: actives.length + 1, points: 0, won: 0 });
  }
  return out;
}

type StRow = { entrantId: string; name: string | null; rank: number | null; points: number; won: number; status: string };

/** The stage's table as the API serves it, against the model: every member's name, place in her pool, points, wins and status. */
async function expectTable(request: APIRequestContext, stageId: string, model: ReturnType<typeof modelTable>, nameOf: Map<string, string>, leaverId: string, when: string) {
  const st = await apiJson<{ rows: StRow[] }>(request, `/api/v1/stages/${stageId}/standings`);
  expect(st.status, JSON.stringify(st.error)).toBe(200);
  const rows = st.data!.rows;
  expect(rows.length, `${when}: a row for every member, the leaver's too`).toBe(model.size);
  const cell = (id: string, rank: number | null, points: number, won: number, status: string) => (id === leaverId ? `${nameOf.get(id)}|${rank}|-|-|${status}` : `${nameOf.get(id)}|${rank}|${points}|${won}|${status}`);
  expect(rows.map((r) => cell(r.entrantId, r.rank, r.points, r.won, r.status)).sort(), when).toEqual(
    [...model].map(([id, m]) => cell(id, m.rank, m.points, m.won, id === leaverId ? "withdrawn" : "active")).sort(),
  );
}

/** The public Standings tab of a division: `/live/{org}/{comp}/{div}?tab=standings`, from the organiser's path. */
async function standingsUrl(request: APIRequestContext, divisionId: string): Promise<string> {
  const m = /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/?]+)/.exec(await divisionPath(request, divisionId));
  expect(m, "premise: the organiser path names the org, competition and division").not.toBeNull();
  return `/live/${m![1]}/${m![2]}/${m![3]}?tab=standings`;
}

/** A name's Qualified / Out marker on the page a person sees (hidden duplicates, like the Schedule panel's, are skipped), or null. */
const qualOf = (page: Page, name: string) =>
  page.locator("tr[data-qual]").filter({ hasText: name }).filter({ visible: true }).first().getAttribute("data-qual", { timeout: 2_000 }).catch(() => null);
const rowOf = (page: Page, name: string) => page.locator("tr").filter({ hasText: name }).filter({ visible: true }).first();

/** Adjust points BY HAND: the stage card's More, "Adjust points...", the dialog, the write, the notice. At 1280 (the desk). */
async function adjustByHand(page: Page, request: APIRequestContext, divisionId: string, stageId: string, entrantId: string, delta: number, reason: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(await divisionPath(request, divisionId, "?tab=fixtures"), { waitUntil: "load" });
  await dismissCookieBanner(page);
  const card = stageCardOf(page, stageId);
  await expect(card, "the stage card").toBeVisible({ timeout: 20_000 });
  const trigger = card.getByTestId("stage-rail-trigger");
  if (await trigger.isVisible()) await trigger.click();
  await card.getByTestId("stage-more").click();
  await card.getByTestId("stage-adjust-points").click();
  const dialog = page.getByTestId("adjust-points-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("adjust-points-entrant").selectOption(entrantId);
  await dialog.getByTestId("adjust-points-delta").fill(String(delta));
  await dialog.getByTestId("adjust-points-reason").fill(reason);
  await dialog.getByTestId("adjust-points-apply").click();
  await expect(dialog.getByTestId("adjust-points-notice")).toHaveText(uiString("en", "adjustPoints.applied"));
  await dialog.getByTestId("adjust-points-close").click();
  await expect(dialog).toBeHidden();
}

/** One row's whole season. See the header; each numbered step names the rule ids it carries. */
async function driveRow(page: Page, request: APIRequestContext, row: RowSpec) {
  const s = await seedRow(request, row);
  const fill = (key: string, vars: Record<string, string | number> = {}) => dictString("en", key, vars);
  const url = await standingsUrl(request, s.divisionId);
  const cutPer = row.qualified === 0 ? 0 : row.pools === 0 ? row.qualified : row.qualified / row.pools;

  // 1. The seats (X-PO-1): a Started table nobody has played shows every member, each pool its own table, and no marker (a level table has none).
  const started = await rowLines(request, s.divisionId, s.tableId);
  const startPools = membersByPool(started);
  expect(startPools.size, `${row.key}: ${row.pools || 1} table(s) at Start`).toBe(row.pools || 1);
  const evenSizes = Array.from({ length: row.pools || 1 }, (_, i) => Math.floor(row.n / (row.pools || 1)) + (i < row.n % (row.pools || 1) ? 1 : 0)).sort();
  expect([...startPools.values()].map((m) => m.length).sort(), "the field dealt as evenly as it divides (the rulebook's snake)").toEqual(evenSizes);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await dismissCookieBanner(page);
  let seats = 0;
  for (const id of s.nameOf.keys()) {
    await expect(page.getByText(s.nameOf.get(id)!, { exact: true }).first(), `seated: ${s.nameOf.get(id)}`).toBeAttached();
    seats++;
  }
  expect(seats, "every seat of the field is listed before a result").toBe(row.n);
  for (const k of "ABCDEFGH".slice(0, row.pools)) await expect(page.getByText(fill("table.poolLabel", { key: k }), { exact: false }).filter({ visible: true }).first(), `Group ${k}`).toBeVisible();
  await expect(page.locator("tr[data-qual]").filter({ visible: true }), "a level table has no Qualified / Out").toHaveCount(0);

  // 2. A late entry (X-CU-7): the seed after the field, one line against every member of her table, none in any other stage (X-CU-9).
  //    A table nothing has played is offered a Rebuild instead (`rebuild_offered`), so one result - on the first line that is not the
  //    leaver's - puts the stage in play first.
  const leaverFirst = s.idOf.get(row.leaver.seed)!;
  const opener = started.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.home_entrant_id !== leaverFirst && f.away_entrant_id !== leaverFirst)!;
  expect(opener, "premise: a first line that is not the leaver's").toBeTruthy();
  const openerRes = await apiJson(request, `/api/v1/fixtures/${opener.id}/events`, "POST", {
    expected_seq: 0, type: "generic.result", payload: s.seedOf.get(opener.home_entrant_id!)! < s.seedOf.get(opener.away_entrant_id!)! ? { p1Score: 1, p2Score: 0 } : { p1Score: 0, p2Score: 1 },
  });
  expect(openerRes.status, JSON.stringify(openerRes.error)).toBe(201);
  const lateSeed = row.n + 1;
  const late = await apiJson<{ id: string; late_entry?: { case: string } }[]>(request, `/api/v1/divisions/${s.divisionId}/entrants`, "POST",
    [{ kind: "individual", display_name: rowName(row.key, lateSeed), seed: lateSeed }]);
  expect(late.status, JSON.stringify(late.error)).toBe(201);
  const lateId = late.data![0]!.id;
  expect(late.data![0]!.late_entry?.case, "a started table takes the newcomer as catch-up lines").toBe("catch_up");
  s.idOf.set(lateSeed, lateId);
  s.seedOf.set(lateId, lateSeed);
  s.nameOf.set(lateId, rowName(row.key, lateSeed));
  const all = await rowLines(request, s.divisionId);
  const hers = all.filter((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId);
  expect(hers.length, "she has lines").toBeGreaterThan(0);
  expect(hers.every((f) => f.stage_id === s.tableId), "she joins the entry table only - a fed stage takes nobody").toBe(true);
  const pools = membersByPool(all.filter((f) => f.stage_id === s.tableId));
  const herPool = [...pools.values()].find((m) => m.includes(lateId))!;
  expect(hers.length, "one catch-up line against every other member of her table").toBe(herPool.length - 1);
  expect([...pools.values()].reduce((sum, m) => sum + m.length, 0), "every entrant is in exactly one table").toBe(row.n + 1);

  // 3. A withdrawal on one side of the cut line (X-PO-2, X-WDT-7). The side is checked against the seeds: the leaver's place, had she
  //    stayed, is inside the per-table cut ("above") or outside it ("below").
  const leaverId = s.idOf.get(row.leaver.seed)!;
  const leaversPool = [...pools.values()].find((m) => m.includes(leaverId))!;
  const had = [...leaversPool].sort((a, b) => s.seedOf.get(a)! - s.seedOf.get(b)!).indexOf(leaverId) + 1;
  if (row.leaver.side === "above") expect(had, "premise: she was inside the cut").toBeLessThanOrEqual(cutPer);
  if (row.leaver.side === "below") expect(had, "premise: she was outside the cut").toBeGreaterThan(cutPer);
  if (row.leaver.side === "none") expect(cutPer, "premise: this row has no cut").toBe(0);
  const out = await apiJson<{ policy: string }>(request, `/api/v1/entrants/${leaverId}/withdraw`, "POST");
  expect(out.status, JSON.stringify(out.error)).toBe(200);
  expect(out.data?.policy, "nothing of hers was played: under half, her lines are taken out").toBe("expunge");
  const afterLeave = await rowLines(request, s.divisionId, s.tableId);
  const leaversLines = afterLeave.filter((f) => f.home_entrant_id === leaverId || f.away_entrant_id === leaverId);
  expect(leaversLines.length, "her lines stay on the board").toBe(leaversPool.length - 1);
  expect(leaversLines.every((f) => f.status === "abandoned"), "and are taken out").toBe(true);
  await page.goto(url);
  for (const id of s.nameOf.keys()) await expect(page.getByText(s.nameOf.get(id)!, { exact: true }).first(), `still listed: ${s.nameOf.get(id)}`).toBeAttached();
  await expect(rowOf(page, s.nameOf.get(leaverId)!), "the leaver's row stays on the table").toBeVisible();
  // One result is in (the opener): the table it is in now has verdicts for the rows still in the field; a level table (every other pool)
  // has none, a departed row has none, and a row with no cut to read has none either.
  const marked = cutPer > 0 ? pools.get(opener.pool_id ?? "")!.filter((id) => id !== leaverId) : [];
  await expect(page.locator("tr[data-qual]").filter({ visible: true }), "verdicts only in the table that has a result, and never on the leaver").toHaveCount(marked.length);
  for (const id of marked) expect(await qualOf(page, s.nameOf.get(id)!), `${s.nameOf.get(id)} carries a live verdict`).not.toBeNull();
  expect(await qualOf(page, s.nameOf.get(leaverId)!), "the leaver carries none").toBeNull();

  // 4. The field plays out: in every table the higher seed wins every meeting.
  let played = 0;
  for (const f of afterLeave) {
    if (SETTLED.has(f.status) || f.home_entrant_id === null || f.away_entrant_id === null) continue;
    if (f.home_entrant_id === leaverId || f.away_entrant_id === leaverId) continue;
    const homeWins = s.seedOf.get(f.home_entrant_id)! < s.seedOf.get(f.away_entrant_id)!;
    const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: 0, type: "generic.result", payload: homeWins ? { p1Score: 1, p2Score: 0 } : { p1Score: 0, p2Score: 1 } });
    expect(res.status, JSON.stringify(res.error)).toBe(201);
    played++;
  }
  const expectedLines = [...pools.values()].reduce((sum, m) => {
    const actives = m.includes(leaverId) ? m.length - 1 : m.length;
    return sum + (actives * (actives - 1)) / 2;
  }, 0);
  expect(played + 1, "every line between two actives (the opener's included): a round robin of each table's actives").toBe(expectedLines);
  const before = modelTable(pools, s.seedOf, leaverId, null);
  await expectTable(request, s.tableId, before, s.nameOf, leaverId, "played out, before the adjustment");

  // 5. One points adjustment, by hand in the desk's dialog (X-ADJ-1, X-ADJ-4): it moves the adjusted entrant in the table the cut reads.
  const adjustedId = s.idOf.get(row.adjust.seed)!;
  const REASON = "points adjustment ruled by the organiser";
  await adjustByHand(page, request, s.divisionId, s.tableId, adjustedId, row.adjust.delta, REASON);
  const model = modelTable(pools, s.seedOf, leaverId, { id: adjustedId, delta: row.adjust.delta });
  expect(model.get(adjustedId)!.rank, "premise: the adjustment moves her (differential)").not.toBe(before.get(adjustedId)!.rank);
  await expectTable(request, s.tableId, model, s.nameOf, leaverId, "after the adjustment");

  // 6. Complete, and the frozen cut (X-QS-1, X-QS-2): Qualified / Out on every table, from the final order, then the same once seated.
  expect((await apiJson(request, `/api/v1/stages/${s.tableId}/complete`, "POST")).status, "Complete").toBe(200);
  const want = new Map<string, "qualified" | "out" | null>();
  for (const [id, m] of model) want.set(s.nameOf.get(id)!, id === leaverId || cutPer === 0 ? null : m.rank <= cutPer ? "qualified" : "out");
  const expectedThrough = new Set([...model].filter(([id, m]) => cutPer > 0 && id !== leaverId && m.rank <= cutPer).map(([id]) => id));
  const readMarkers = async (when: string) => {
    let checked = 0;
    for (const [name, kind] of want) {
      if (kind === null) continue;
      await expect.poll(() => qualOf(page, name), `${when}: ${name}`).toBe(kind);
      checked++;
    }
    return checked;
  };
  const readPage = async (when: string) => {
    await page.reload();
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of want.keys()) await expect(page.getByText(name, { exact: true }).first(), `${when} ${width}: ${name} still listed`).toBeAttached();
      await expect(rowOf(page, s.nameOf.get(leaverId)!), `${when} ${width}: the leaver's row stays`).toBeVisible();
      expect(await qualOf(page, s.nameOf.get(leaverId)!), `${when} ${width}: a leaver reads neither Qualified nor Out`).toBeNull();
      // X-ADJ-4: the table says why, under it - the adjusted entrant's footnote names her and the reason.
      const note = page.getByTestId(`standings-adjustment-note-${adjustedId}`).filter({ visible: true }).first();
      await expect(note, `${when} ${width}: the adjustment's footnote`).toBeVisible();
      await expect(note).toContainText(fill("table.adjustmentNote.lead", { name: s.nameOf.get(adjustedId)! }));
      await expect(note).toContainText(REASON);
      if (cutPer === 0) {
        await expect(page.locator("tr[data-qual]").filter({ visible: true }), `${when} ${width}: no cut, no marker`).toHaveCount(0);
        await expect(page.getByTestId("qual-legend").filter({ visible: true })).toHaveCount(0);
      } else {
        const checked = await readMarkers(`${when} ${width}`);
        expect(checked, "every member who stayed carries a verdict").toBe(row.n);
        const legend = page.getByTestId("qual-legend").filter({ visible: true }).first();
        await expect(legend).toContainText(fill("table.qual.legend.qualified"));
        await expect(legend, "a finished table has nothing still open").not.toContainText(fill("table.qual.legend.open"));
        await expect(page.getByText(fill("table.qual.cutFrozen.other", { n: cutPer, next: s.nextName! }), { exact: false }).filter({ visible: true }), `${when} ${width}: each table says its cut went through`).toHaveCount(row.pools || 1);
      }
      await expectNoHorizontalScroll(page);
      widths++;
    }
    expect(widths).toBe(3);
  };
  await page.goto(url);
  await dismissCookieBanner(page);
  await readPage("completed");
  if (cutPer === 0) return;

  // The draft the desk offers is the same set the markers froze (the seam: the page and the seating agree), and confirming seats it.
  const proposal = await apiJson<Draft>(request, `/api/v1/stages/${s.nextId}/seed-proposal`, "POST");
  expect(proposal.status, JSON.stringify(proposal.error)).toBe(201);
  expect(new Set(proposal.data!.computed.qualifiers.map((q) => q.entrantId)), "the draft seats exactly who the markers say went through").toEqual(expectedThrough);
  expect(proposal.data!.computed.qualifiers, "anti-vacuity: the draft seats the cut").toHaveLength(row.qualified);
  expect(proposal.data!.computed.ties, "the order is the rulebook's alone: no tie to pick").toHaveLength(0);
  const confirmed = await apiJson(request, `/api/v1/stages/${s.nextId}/seed-proposal/confirm`, "POST", { proposalId: proposal.data!.id });
  expect(confirmed.status, JSON.stringify(confirmed.error)).toBe(200);
  await readPage("seated");
}

/** `drive` titles: the row key first, then what the test is, then the rule ids. */
let registeredRows = 0;
for (const row of ROWS) {
  registeredRows++;
  test.describe(`${row.key}: ${row.ids}`, () => {
    test(`${row.ids} - a late entry, a leaver ${row.leaver.side === "none" ? "mid-table" : `${row.leaver.side} the line`}, one points adjustment${row.qualified > 0 ? " and the frozen cut" : " and a table with no cut"}, at 1280, 768 and 320`, async ({ page, request }) => {
      test.setTimeout(300_000);
      await driveRow(page, request, row);
    });

    if (row.pools > 0) {
      test(`X-BD-5 a pool of one is refused by name and writes nothing (${row.key})`, async ({ page, request }) => {
        test.setTimeout(150_000);
        // 2P - 1 entrants dealt into P pools: the snake leaves one pool holding ONE entrant, which the draw refuses (C38; every pool needs 2).
        const s = await seedRow(request, row, { n: 2 * row.pools - 1, start: false });
        const refused = await apiJson(request, `/api/v1/stages/${s.tableId}/generate`, "POST");
        expect(refused.status).toBe(422);
        expect(refused.error?.code).toBe("STAGE_NOT_READY");
        const extra = refused.error as unknown as { reason: string; groups: number; entrants: number; required: number; suggested: number | null };
        expect(extra.reason, "the refusal's own reason").toBe("group_too_few_entrants");
        expect([extra.groups, extra.entrants, extra.required], "groups, entrants, and the 2-per-group floor").toEqual([row.pools, 2 * row.pools - 1, row.pools * 2]);
        if (extra.suggested !== null) expect(extra.suggested, "the count that works is fewer pools").toBeLessThan(row.pools);
        expect(await rowLines(request, s.divisionId), "nothing was written").toHaveLength(0);

        // The desk says it in the reader's words, from the same refusal (the dictionary's sentence, never the server's English).
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(await divisionPath(request, s.divisionId, "?tab=fixtures"));
        await dismissCookieBanner(page);
        const card = stageCardOf(page, s.tableId);
        await expect(card).toBeVisible({ timeout: 20_000 });
        const vars = { required: extra.required, have: extra.entrants, groups: extra.groups };
        const key = typeof extra.suggested === "number" && extra.suggested >= 2 ? "schedule.error.tooFewGroupEntrantsSuggest" : "schedule.error.tooFewGroupEntrantsAdd";
        const sentence = uiString("en", key, extra.suggested !== null ? { ...vars, suggested: extra.suggested } : vars);
        const answered = page.waitForResponse((r) => r.url().endsWith(`/api/v1/stages/${s.tableId}/generate`) && r.request().method() === "POST");
        await card.getByTestId("stage-generate").click();
        expect((await answered).status(), "the desk's Generate gets the same refusal").toBe(422);
        let widths = 0;
        for (const width of [1280, 768, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(page.getByText(sentence, { exact: false }).filter({ visible: true }).first(), `${width}: the refusal reads in the dictionary's words`).toBeVisible();
          await expectNoHorizontalScroll(page);
          widths++;
        }
        expect(widths).toBe(3);
        expect(await rowLines(request, s.divisionId), "the desk's attempt wrote nothing either").toHaveLength(0);
      });
    }
  });
}

test.describe("the seven round-robin rows are all driven", () => {
  test("every template whose first stage is a table has a row, and so does the gallery's table -> table -> bracket (7 rows)", () => {
    const knobs = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
    const tableFirst = STAGE_TEMPLATES.filter((t) => ["league", "group"].includes(t.build(knobs)[0]?.kind ?? "")).map((t) => t.key);
    expect(tableFirst.length, "anti-vacuity: the registry names round-robin templates").toBeGreaterThan(0);
    const gallery = SUPER_GROUPS.divisions[0]!.stages.map((st) => st.kind);
    expect(gallery, "the super-groups template is table, table, bracket").toEqual(["group", "group", "knockout"]);
    expect([...tableFirst, "group_group_ko"].sort(), "every round-robin row of the registry plus the gallery's has a describe here").toEqual(ROWS.map((r) => r.key).sort());
    expect(ROWS).toHaveLength(7);
    expect(registeredRows, "one describe registered per row").toBe(7);
    expect(new Set(ROWS.map((r) => r.key)).size, "no row twice").toBe(7);
  });
});

// W5 app PR B Task 8 (T5-c): the badminton DOUBLES league walkthrough. Pairs, not individuals: a late pair joins a started league
// (X-CU-7, catch-up lines), a pair that loses a partner in the roster editor withdraws (ruling 282, X-RP-3 - the editor's own Save),
// and the table ranks the rest on wins (badminton is wins-first) with the leaver last (X-WDT-7). Matches are walkovers (a real
// result is 42+ rallies; a walkover credits 2-0 in games and counts the same way, BD-WO-1). The better pair (by the order made
// here) wins every meeting. At 1280, 768 and 320, no horizontal scroll.
test.describe("badminton doubles league", () => {
  test("X-CU-7, X-RP-3 (ruling 282), X-WDT-7 a late pair, a pair that loses a partner withdraws, and the table", async ({ page, request }) => {
    test.setTimeout(300_000);
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Doubles ${TAG}`, visibility: "public" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Doubles", sport_key: "badminton", variant_key: "bwf", config: {} });
    expect(div.status, JSON.stringify(div.error)).toBe(201);
    const divisionId = div.data!.id;
    // Five pairs, best first; the third will lose a partner.
    const names = [`Doubles Pair 1 ${TAG}`, `Doubles Pair 2 ${TAG}`, "Harbourside Shuttlers Badminton Club Ladies", `Doubles Pair 4 ${TAG}`, `Doubles Pair 5 ${TAG}`];
    expect(names[2]!.length, "premise: the leaver carries a realistic 43-character name").toBe(43);
    const players: { id: string; name: string }[][] = [];
    for (let i = 0; i < 5; i++) players.push([await seedPlayer(request, `Dbl${i + 1}a`), await seedPlayer(request, `Dbl${i + 1}b`)]);
    const pairIds: string[] = [];
    for (let i = 0; i < 5; i++) pairIds.push(await seedPair(request, divisionId, players[i]!, names[i]!));
    const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League", config: {} });
    expect(stage.status, JSON.stringify(stage.error)).toBe(201);
    const stageId = stage.data!.id;
    expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
    expect(await rowLines(request, divisionId, stageId), "five pairs: ten lines").toHaveLength(10);

    // A table nothing has played is offered a Rebuild, not catch-up lines: one walkover (not the leaver's line) puts the league in play.
    const opening = (await rowLines(request, divisionId, stageId)).find((f) => f.home_entrant_id !== pairIds[2] && f.away_entrant_id !== pairIds[2])!;
    const openerLoser = pairIds.indexOf(opening.home_entrant_id!) < pairIds.indexOf(opening.away_entrant_id!) ? opening.away_entrant_id! : opening.home_entrant_id!;
    const openRes = await apiJson(request, `/api/v1/fixtures/${opening.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: openerLoser, reason: "walkover" } });
    expect(openRes.status, JSON.stringify(openRes.error)).toBe(201);

    // A late pair (X-CU-7): two new people, one line against every pair.
    const lateName = `Doubles Late Pair ${TAG}`;
    const latePeople = [await seedPlayer(request, "DblLateA"), await seedPlayer(request, "DblLateB")];
    const add = await apiJson<{ id: string; late_entry?: { case: string } }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
      [{ kind: "pair", display_name: lateName, members: latePeople.map((p) => ({ person_id: p.id, is_captain: false, roles: [] })) }]);
    expect(add.status, JSON.stringify(add.error)).toBe(201);
    const lateId = add.data![0]!.id;
    expect(add.data![0]!.late_entry?.case, "a started league takes the late pair as catch-up lines").toBe("catch_up");
    const ranked = [...pairIds, lateId]; // best first: the late pair plays last in the order
    const nameOfId = new Map(ranked.map((id, i) => [id, i < 5 ? names[i]! : lateName]));
    const linesNow = await rowLines(request, divisionId, stageId);
    expect(linesNow.filter((f) => f.home_entrant_id === lateId || f.away_entrant_id === lateId), "one line against each of the five pairs").toHaveLength(5);
    expect(linesNow, "six pairs: fifteen lines").toHaveLength(15);

    // Ruling 282, through the desk's roster editor: dropping a partner withdraws the pair (X-RP-3) and takes her lines out.
    const leaverId = pairIds[2]!;
    const goes = players[2]![1]!;
    const roster = await storedMembers(request, leaverId);
    await page.goto(await divisionPath(request, divisionId, "?tab=entrants"));
    await dismissCookieBanner(page);
    const toggle = rowToggle(page, names[2]!);
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    const box = page.getByTestId("entrant-roster");
    await expect(box.getByText(goes.name, { exact: true })).toBeVisible();
    await box.locator("div", { has: page.getByText(goes.name, { exact: true }) }).last().getByRole("button", { name: uiEn["entrants.roster.remove"] }).click();
    const sent = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/entrants/${leaverId}` && r.request().method() === "PATCH", { timeout: 30_000 });
    await saveRoster(page).click();
    expect((await sent).status(), "the roster editor's Save").toBe(200);
    await expect.poll(async () => (await apiJson<{ status: string }>(request, `/api/v1/entrants/${leaverId}`)).data!.status, { timeout: 20_000 }).toBe("withdrawn");
    expect(await storedMembers(request, leaverId), "the pair's record keeps both people").toBe(roster);
    const taken = (await rowLines(request, divisionId, stageId)).filter((f) => f.home_entrant_id === leaverId || f.away_entrant_id === leaverId);
    expect(taken, "five lines were hers (one against each other pair, the late pair's included)").toHaveLength(5);
    expect(taken.every((f) => f.status === "abandoned"), "all taken out").toBe(true);

    // The field plays out by walkover: the pair earlier in `ranked` wins every meeting (the loser's side forfeits).
    const rank = new Map(ranked.map((id, i) => [id, i]));
    let played = 0;
    for (const f of (await rowLines(request, divisionId, stageId)).filter((l) => !SETTLED.has(l.status))) {
      const [h, a] = [f.home_entrant_id!, f.away_entrant_id!];
      const loser = rank.get(h)! < rank.get(a)! ? a : h;
      const res = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: loser, reason: "walkover" } });
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      played++;
    }
    expect(played + 1, "five actives: ten meetings, the opener's among them").toBe(10);

    // The table: wins first. The actives in order of `ranked` win 4, 3, 2, 1, 0 matches; the leaver is last with her row kept.
    const actives = ranked.filter((id) => id !== leaverId);
    const st = await apiJson<{ rows: StRow[] }>(request, `/api/v1/stages/${stageId}/standings`);
    expect(st.status, JSON.stringify(st.error)).toBe(200);
    const got = st.data!.rows.map((r) => `${r.name}|${r.rank}|${r.entrantId === leaverId ? "-" : r.won}|${r.status}`).sort();
    const want = [
      ...actives.map((id, i) => `${nameOfId.get(id)}|${i + 1}|${actives.length - 1 - i}|active`),
      `${names[2]}|${actives.length + 1}|-|withdrawn`,
    ].sort();
    expect(got, "the doubles table: wins first, the leaver last").toEqual(want);

    // The page: every pair listed (the leaver's row stays), at 1280, 768 and 320.
    await page.goto(await standingsUrl(request, divisionId));
    let widths = 0;
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const id of ranked) await expect(page.getByText(nameOfId.get(id)!, { exact: true }).first(), `${width}: ${nameOfId.get(id)}`).toBeAttached();
      await expect(rowOf(page, names[2]!), `${width}: the leaver's row stays`).toBeVisible();
      await expectNoHorizontalScroll(page);
      widths++;
    }
    expect(widths).toBe(3);
  });
});

// W5 app PR B Task 8 (controller addition, owner discussion 2026-11-21): the public HUB at scale. One competition, 20 divisions (the
// Pro plan's per-competition limit) of 30 entrants each in mixed formats, started: the page a spectator opens first. Measured, at
// 1280, 768 and 320: the document's bytes, the server's time to first byte, the DOM node count - printed, annotated on the test, and held
// to a ceiling that was set after measuring (HUB_CEILING). A regression that grows the hub with its divisions fails here. The page must
// also list all twenty divisions: the count is read off the hub JSON and off the page's own chip (anti-vacuity), never assumed.
const HUB_DIVISIONS = 20;
const HUB_FIELD = 30;
// Measured 2026-11-21 against a fresh prod build of this branch (local, one machine): 3,885,322 bytes of document (decoded; 184 KB on the
// wire under gzip) for 2,856 fixtures - 99% of it ONE flight chunk, the competition's matches serialised into the page - 132 DOM nodes,
// and a time to first byte of 952 ms on the cold first load and 23-53 ms warm. The ceilings are 1.25x the bytes (the document grows with
// the fixtures: a regression that doubles the payload, or serialises the entrants a second time, fails), ~1.9x the nodes, and a TTFB far
// above the cold figure (CI's machine is slower and shared - the time is a tripwire for a blocked render, not a benchmark).
const HUB_CEILING = { htmlBytes: 4_900_000, domNodes: 250, ttfbMs: 6_000 };
test.describe("hub: a competition with many divisions", () => {
  test("20 divisions of 30 entrants in mixed formats: the hub lists all twenty, stays under its measured ceiling, and does not scroll sideways at 1280, 768 and 320", async ({ page, request }) => {
    test.setTimeout(300_000);
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Hub ${TAG}`, visibility: "public" });
    expect(comp.status, JSON.stringify(comp.error)).toBe(201);
    const formats = ["league", "groups_ko", "swiss", "knockout", "group_only"] as const;
    let started = 0;
    for (let d = 0; d < HUB_DIVISIONS; d++) {
      const format = formats[d % formats.length]!;
      const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: `Hub ${pad2(d + 1)} ${format}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
      expect(div.status, `division ${d + 1}: ${JSON.stringify(div.error)}`).toBe(201);
      const divisionId = div.data!.id;
      const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
        Array.from({ length: HUB_FIELD }, (_, i) => ({ kind: "individual", display_name: `Hub D${pad2(d + 1)} P${pad2(i + 1)} ${TAG}`, seed: i + 1 })));
      expect(ents.status, JSON.stringify(ents.error)).toBe(201);
      const drafts: ReturnType<typeof buildTemplateStages> = format === "swiss"
        ? [{ kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null }]
        : format === "knockout"
          ? [{ kind: "knockout", name: "Bracket", config: {}, progression: null }]
          : buildTemplateStages(format, { qualified: 8, poolCount: 4, swissRounds: 3, legs: 1 });
      const stages = await apiJson<{ id: string; kind: string }[]>(request, `/api/v1/divisions/${divisionId}/stages`, "POST",
        drafts.map((x, i) => ({ seq: i + 1, kind: x.kind, name: x.name, config: x.config, progression: x.progression })));
      expect(stages.status, JSON.stringify(stages.error)).toBe(201);
      if (format !== "swiss") for (const st of [...stages.data!].reverse()) expect((await apiJson(request, `/api/v1/stages/${st.id}/generate`, "POST")).status, `division ${d + 1} generate`).toBe(200);
      expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status, `division ${d + 1} start`).toBe(200);
      if (format === "swiss") expect((await apiJson(request, `/api/v1/stages/${stages.data![0]!.id}/generate`, "POST")).status, "Swiss round one").toBe(200);
      started++;
    }
    expect(started, "twenty divisions made and started").toBe(HUB_DIVISIONS);

    const orgs = await apiJson<{ slug: string }[]>(request, "/api/orgs");
    const orgSlug = (orgs.data ?? (orgs as unknown as { slug: string }[]))[0]!.slug;
    const hub = await apiJson<{ divisions: { entrantCount: number }[] }>(request, `/api/v1/public/orgs/${orgSlug}/competitions/${comp.data!.slug}/hub`);
    expect(hub.status, JSON.stringify(hub.error)).toBe(200);
    expect(hub.data!.divisions, "the hub JSON lists every division").toHaveLength(HUB_DIVISIONS);
    expect(hub.data!.divisions.reduce((sum, x) => sum + x.entrantCount, 0), "and every entrant").toBe(HUB_DIVISIONS * HUB_FIELD);

    const measured: Record<string, { htmlBytes: number; ttfbMs: number; domNodes: number }> = {};
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const res = await page.goto(`/live/${orgSlug}/${comp.data!.slug}`, { waitUntil: "load" });
      expect(res?.status()).toBe(200);
      await dismissCookieBanner(page);
      const htmlBytes = (await res!.body()).length;
      const { ttfbMs, domNodes } = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        return { ttfbMs: Math.round(nav.responseStart - nav.requestStart), domNodes: document.getElementsByTagName("*").length };
      });
      measured[String(width)] = { htmlBytes, ttfbMs, domNodes };
      await expect(page.getByTestId("mh-hero-divisions"), `${width}: the page's own count of divisions`).toHaveText(dictString("en", "landing.divisions.other", { count: HUB_DIVISIONS }));
      await expectNoHorizontalScroll(page);
    }
    console.log(`HUB-METRICS ${JSON.stringify({ divisions: HUB_DIVISIONS, field: HUB_FIELD, measured })}`);
    test.info().annotations.push({ type: "hub-metrics", description: JSON.stringify(measured) });
    expect(Object.keys(measured), "all three widths measured").toHaveLength(3);
    for (const [width, m] of Object.entries(measured)) {
      expect(m.htmlBytes, `${width}: the document's bytes`).toBeLessThanOrEqual(HUB_CEILING.htmlBytes);
      expect(m.domNodes, `${width}: the DOM node count`).toBeLessThanOrEqual(HUB_CEILING.domNodes);
      expect(m.ttfbMs, `${width}: time to first byte (ms)`).toBeLessThanOrEqual(HUB_CEILING.ttfbMs);
    }
  });
});
