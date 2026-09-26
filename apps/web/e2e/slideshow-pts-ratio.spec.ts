import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
// `with { type: "json" }` is REQUIRED (see v6-sports.spec.ts: without it the
// spec collects no tests at all under Node's ESM loader).
import enUi from "../src/dictionaries/en/ui.json" with { type: "json" };
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate } from "./helpers";

// The organiser noticeboard's standings slide carries the normal table's
// "Pts ratio" column when the division ranks on `point_ratio` (badminton, table
// tennis, volleyball, carrom by default), and is the slide it always was when
// it does not.
//
// The unit suites pin the builder (`slideshow-point-ratio.test.ts`), the board's
// grid and type (`slideshow-tv-rows.test.tsx`) and the public kiosk's page
// (`slideshow-labels.test.tsx`), each from hand-built inputs. What only the
// product shows is the whole path an organiser drives: a real badminton match
// scored through the ledger, folded into a standings snapshot, read by
// `/slideshow/divisions/[id]`, rendered by a real browser. That is this file.
//
// The negative has its positive pair: a generic division on the same board
// renders its table and NO ratio column, so the absence is the cascade's and not
// an empty or unhydrated board.
//
// The organiser board is always English (`slideshowLabels(DEFAULT_LOCALE)` in
// the page), so copy is taken from the en dictionary rather than typed.
//
// The board ROTATES every 9 s, so nothing here asserts across time: the table is
// read in ONE `evaluate` (an atomic snapshot of the slide on screen) and every
// assertion is made on that data. A locator assertion with a 15 s timeout
// straddles two slides — the first draft of this file did, and read the next
// slide's rows as "0 elements".

/** The board's column labels, from the dictionary the organiser board reads. */
const L = {
  entrant: enUi["slideshow.col.entrant"],
  played: enUi["slideshow.col.played"],
  won: enUi["slideshow.col.won"],
  drawn: enUi["slideshow.col.drawn"],
  lost: enUi["slideshow.col.lost"],
  points: enUi["slideshow.col.points"],
  pointRatio: enUi["slideshow.col.pointRatio"],
};
/** The header a slide had before the column existed, then the one with it. */
const HEADER = ["#", L.entrant, L.played, L.won, L.drawn, L.lost, L.points];
const HEADER_WITH_RATIO = [...HEADER, L.pointRatio];

/** One API round trip against a local production build, with headroom. */
const API_CALL_MS = 1_500;
const FLOOR_MS = 60_000;
/** Competition; badminton: division, entrants, stage + generate, start, then
 *  core.start and two game summaries (each a state read + an append) and a
 *  standings poll; generic: division, entrants, stage + generate. */
const SEED_CALLS = 1 + (1 + 1 + 2 + 1 + 1 + 1 + 2 * 2 + 3) + (1 + 1 + 2);
const SEED_BUDGET_MS = FLOOR_MS + SEED_CALLS * API_CALL_MS;

const DESKTOP = { width: 1280, height: 800 };

/** Append one event on the fixture's current sequence, retrying the
 *  optimistic-concurrency 409 (v6-sports.spec.ts's own `sendEvent`). */
async function sendEvent(request: APIRequestContext, fixtureId: string, type: string, payload: unknown) {
  for (let attempt = 0; ; attempt++) {
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
    expect(state.status, `state before ${type}`).toBe(200);
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type,
      payload,
    });
    if (res.status === 201) return;
    if (res.status === 409 && attempt < 3) continue;
    throw new Error(`${type} -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

async function seed(request: APIRequestContext) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Pts ratio board ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    // The organiser board reads the console model, so a private competition
    // is enough — and a public one over the community cap silently downgrades.
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  // Badminton: one league match, scored 21-0, 21-0 through the ledger, so the
  // winner's points ledger is 42 won / 0 lost (an unbeaten ratio) and the
  // loser's is 0 won / 42 lost.
  const badminton = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "MS",
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  expect(badminton.status, JSON.stringify(badminton.error)).toBe(201);
  const badmintonId = badminton.data!.id;
  const entrants = await addEntrantsViaApi(request, badmintonId, ["Mina", "Rita"]);
  expect(entrants.ids).toHaveLength(2);
  const league = await createStageAndGenerate(request, badmintonId, { kind: "league", name: "Ratio League" });
  expect(league.fixtureIds).toHaveLength(1);
  expect((await apiJson(request, `/api/v1/divisions/${badmintonId}/start`, "POST")).status).toBe(200);
  const fixtureId = league.fixtureIds[0]!;
  await sendEvent(request, fixtureId, "core.start", {});
  await sendEvent(request, fixtureId, "badminton.game.summary", { home: 21, away: 0 });
  await sendEvent(request, fixtureId, "badminton.game.summary", { home: 21, away: 0 });
  // The board reads the stored snapshot: wait until the match is in it.
  await expect
    .poll(
      async () => {
        const standings = await apiJson<{ rows: { played: number }[] }>(request, `/api/v1/stages/${league.stageId}/standings`);
        return standings.data?.rows.map((r) => r.played);
      },
      { timeout: 20_000 },
    )
    .toEqual([1, 1]);

  // Generic: a sport whose cascade never names point_ratio.
  const generic = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Table",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(generic.status, JSON.stringify(generic.error)).toBe(201);
  const genericEntrants = await addEntrantsViaApi(request, generic.data!.id, ["North", "South"]);
  expect(genericEntrants.ids).toHaveLength(2);
  await createStageAndGenerate(request, generic.data!.id, { kind: "league", name: "Plain League" });

  return { badmintonId, genericId: generic.data!.id };
}

/** The clock is set by an effect: its presence means the board has hydrated. */
const clock = (page: Page) => page.locator("header span.tabular-nums");

interface StandingsTable {
  /** The header row's labels, in order. */
  header: string[];
  /** Each body row's visible cells in order, keyed by the entrant's name. */
  rows: Record<string, string[]>;
}

/** Open a division's board and read its standings slide as one snapshot. The
 *  board rotates, so step forward with the arrow key until the caption is on
 *  screen, and read header and rows inside the SAME evaluate. */
async function standingsTable(page: Page, divisionId: string, caption: string): Promise<StandingsTable> {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/slideshow/divisions/${divisionId}`);
  await expect(clock(page)).toBeAttached();
  let table: StandingsTable | null = null;
  await expect
    .poll(
      async () => {
        table = await page.evaluate((wanted) => {
          const shown = document.querySelector("main h2")?.textContent?.trim();
          if (shown !== wanted) return null;
          const grids = [...document.querySelectorAll("main div.grid")];
          const cells = (grid: Element) =>
            [...grid.children].filter((c) => !c.hasAttribute("aria-hidden")).map((c) => (c.textContent ?? "").trim());
          const header = grids.find((g) => !g.classList.contains("relative"));
          if (!header) return null;
          const rows: Record<string, string[]> = {};
          for (const row of grids.filter((g) => g.classList.contains("relative"))) {
            const texts = cells(row);
            rows[texts[1] ?? "?"] = texts;
          }
          return { header: cells(header), rows };
        }, caption);
        if (table === null) await page.keyboard.press("ArrowRight");
        return table !== null;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  return table!;
}

test.describe("organiser slideshow: the standings slide's Pts ratio column", () => {
  let seeded: Awaited<ReturnType<typeof seed>>;

  test.beforeAll(async ({ playwright }, testInfo) => {
    // A hook has its own clock; the test's `setTimeout` does not reach it.
    testInfo.setTimeout(SEED_BUDGET_MS);
    const request = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: testInfo.project.use.storageState,
    });
    try {
      seeded = await seed(request);
    } finally {
      await request.dispose();
    }
  });

  test("a badminton division's board headers the column and prints each row's ratio (unbeaten is the infinity sign)", async ({ page }, testInfo) => {
    const table = await standingsTable(page, seeded.badmintonId, "Ratio League");
    // For the ∞ glyph: it is not in every face the board's display font ships.
    await testInfo.attach("ratio-board-1280", { body: await page.locator("main").screenshot(), contentType: "image/png" });

    // The whole control set, membership and order: Pts, then the ratio last.
    expect(table.header).toEqual(HEADER_WITH_RATIO);
    expect(Object.keys(table.rows).sort()).toEqual(["Mina", "Rita"]);
    for (const [name, cells] of Object.entries(table.rows)) {
      expect(cells, `${name}'s cells: rank, entrant, P, W, D, L, Pts, ratio`).toHaveLength(HEADER_WITH_RATIO.length);
      expect(cells.slice(2, 3), `${name} played one`).toEqual(["1"]);
    }
    // Home won both games 21-0, and which of the two entrants is home is the
    // draw's, so the two ratios are asserted as a pair: 42 won / 0 lost is the
    // engine's infinity sign, 0 won / 42 lost is its 0.00.
    const ratios = Object.values(table.rows).map((cells) => cells.at(-1));
    expect(ratios.sort()).toEqual(["0.00", "∞"].sort());
  });

  test("a generic division's board renders its table with no ratio column (the negative pair)", async ({ page }) => {
    const table = await standingsTable(page, seeded.genericId, "Plain League");

    // The table IS on screen — its header and both rows — so the absence below
    // is the cascade's, not an unhydrated or empty board.
    expect(table.header).toEqual(HEADER);
    expect(Object.keys(table.rows).sort()).toEqual(["North", "South"]);
    for (const [name, cells] of Object.entries(table.rows)) {
      expect(cells, `${name}'s cells: rank, entrant, P, W, D, L, Pts`).toHaveLength(HEADER.length);
    }
    expect(table.header).not.toContain(L.pointRatio);
  });
});
