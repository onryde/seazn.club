import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { buildTemplateStages } from "../src/lib/format-templates";
import { dictString } from "./spectator-w2-kit";

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
  return { divisionId, names: { a2: nameOf.get(five[1]!)!, a5: nameOf.get(five[4]!)!, b2: nameOf.get(four[1]!)! } };
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
