import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, competitionPath, divisionPath, expectNoHorizontalScroll, showAllFormats } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { buildTemplateStages } from "../src/lib/format-templates";
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
async function seedThreePools(request: APIRequestContext) {
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
