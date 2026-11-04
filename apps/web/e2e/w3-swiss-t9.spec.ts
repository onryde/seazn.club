import { test, expect, type Page } from "@playwright/test";
// `with { type: "json" }` is REQUIRED (see v6-sports.spec.ts: without it the spec collects no tests at all under Node's ESM loader).
import enUi from "../src/dictionaries/en/ui.json" with { type: "json" };
import { apiJson, addEntrantsViaApi, competitionPath, createStageAndGenerate } from "./helpers";
import { LATE_SPORTS, startedSwiss, type Seated } from "./support/swiss-app-a-kit";
import { closeOpenContexts } from "./spectator-public-helpers";
import { spectator } from "./spectator-w2-kit";
import { routes } from "../src/lib/routes";

// W3 Swiss app-B Task 9 (ST-G21, plan 2026-10-31-w3-swiss-app-b.md) - the TV board and the public table show a Swiss stage's
// tie-break columns. Judged as a WHOLE file, never with `-g`; the describe sets serial mode for itself only (AGENTS.md class 21).
//
// The unit suites pin the builder (`slideshow-tiebreak-columns.test.ts`: which two columns, the public table's own cells), the
// board's grid and type (`slideshow-tv-rows.test.tsx`) and the public table's headers (`standings-table-view-headers.test.tsx`),
// each from hand-built or engine-built inputs. What only the product shows is the whole path an organiser drives: a real Swiss
// round scored through the scorer's events, folded into a standings snapshot, read by `/slideshow/divisions/[id]` and by the
// anonymous hub, drawn by a real browser. That is this file.
//
// The negative has its positive pair: a LEAGUE on the same board draws its table with no Buchholz header, so the absence is the
// cascade's and not an empty or unhydrated board.
//
// The ladders are a TV-board feature from Tailwind's `2xl` (1536px) up (owner ruling 2026-11-03) and fold below it
// (`max-2xl:hidden`). A text read cannot see that - the folded cells are still in the DOM, so `textContent` finds them at 1280 -
// so every width below is read as COMPUTED visibility (display, visibility and a painted box), in the same atomic snapshot as the
// text: shown at 1920 and at exactly 1536, hidden at 1535 and at 1280, with the page itself never scrolling sideways.
//
// The board ROTATES every 9 s, so nothing here asserts across time: the table is read in ONE `evaluate` (an atomic snapshot of
// the slide on screen), as `slideshow-pts-ratio.spec.ts` does. The organiser board is always English; its labels come from the
// en dictionary rather than being typed.

const L = {
  entrant: enUi["slideshow.col.entrant"],
  points: enUi["slideshow.col.points"],
};
/** The two ladders' words: the Buchholz NOTATION, printed as the engine labels it in every locale (owner, `NOTATION_HEADERS`). */
const LADDERS = ["Buchholz Cut-1", "Buchholz"] as const;

/** Tailwind's `2xl` (96rem): where the board starts to draw the ladders. Not read from the code under test. */
const LADDERS_FROM = 1536;
const TV = { width: 1920, height: 1080 };
const LAPTOP = { width: 1280, height: 800 };
/** One API round trip against a local production build, with headroom. */
const API_CALL_MS = 1_500;
const FLOOR_MS = 60_000;
/** Seed: start + pair (startedSwiss ~ 9 calls), make it public (2), two boards each a start and two games (2 x 3 x 2 calls), a
 *  standings poll, then the league beside it (competition-level division, entrants, stage). */
const SEED_CALLS = 9 + 2 + 12 + 3 + 6;
const SEED_BUDGET_MS = FLOOR_MS + SEED_CALLS * API_CALL_MS;

/** The clock is set by an effect: its presence means the board has hydrated. */
const clock = (page: Page) => page.locator("header span.tabular-nums");

interface BoardTable {
  header: string[];
  /** Per header cell: painted (display not none, visibility not hidden, a box with area) - computed, not attached. */
  headerShown: boolean[];
  rows: Record<string, { texts: string[]; shown: boolean[] }>;
  /** The page itself scrolls sideways. */
  pageScrolls: boolean;
}

/** Open a division's board at `viewport` and wait for it to hydrate. */
async function openBoard(page: Page, divisionId: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/slideshow/divisions/${divisionId}`);
  await expect(clock(page)).toBeAttached();
}

/** Read the standings slide whose caption is `caption` as one snapshot (the pts-ratio spec's reader): text and computed
 *  visibility of every cell in the SAME evaluate, so the rotation cannot put two slides between them. */
async function readBoard(page: Page, caption: string): Promise<BoardTable> {
  let table: BoardTable | null = null;
  await expect
    .poll(
      async () => {
        table = await page.evaluate((wanted) => {
          const shown = document.querySelector("main h2")?.textContent?.trim();
          if (shown !== wanted) return null;
          const grids = [...document.querySelectorAll("main div.grid")];
          const cells = (grid: Element) => [...grid.children].filter((c) => !c.hasAttribute("aria-hidden"));
          const painted = (el: Element) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
          };
          const text = (el: Element) => (el.textContent ?? "").trim();
          const header = grids.find((g) => !g.classList.contains("relative"));
          if (!header) return null;
          const rows: Record<string, { texts: string[]; shown: boolean[] }> = {};
          for (const row of grids.filter((g) => g.classList.contains("relative"))) {
            const cs = cells(row);
            rows[text(cs[1]!)] = { texts: cs.map(text), shown: cs.map(painted) };
          }
          const de = document.documentElement;
          return { header: cells(header).map(text), headerShown: cells(header).map(painted), rows, pageScrolls: de.scrollWidth > de.clientWidth };
        }, caption);
        if (table === null) await page.keyboard.press("ArrowRight");
        return table !== null;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  return table!;
}

/** The board at `width` (the page is already open): resize, then wait for the ladders' computed visibility to settle to `shown`. */
async function boardAtWidth(page: Page, caption: string, width: number, shown: boolean): Promise<BoardTable> {
  await page.setViewportSize({ width, height: TV.height });
  await expect
    .poll(async () => (await readBoard(page, caption)).headerShown.slice(-2).join(), { timeout: 15_000, intervals: [250], message: `the ladders are ${shown ? "painted" : "folded"} at ${width}px` })
    .toBe(`${shown},${shown}`);
  return readBoard(page, caption);
}

interface HubTable {
  /** `data-col` key -> the visible abbreviation over it. */
  headers: Record<string, string>;
  /** the entrant's <th> text (initials + name + chips) -> `data-col` key -> the cell's text. */
  rows: Record<string, Record<string, string>>;
}

/** The anonymous hub's Table tab: the Swiss division's table section (the page also holds the league's, so the section is
 *  scoped through its division's heading, `mh-table-heading-{slug}`), read in a single evaluate. */
async function hubTable(page: Page, hubUrl: string, divisionSlug: string): Promise<HubTable | string> {
  await page.goto(hubUrl, { waitUntil: "load" });
  try {
    await page.getByTestId("mh-tab-panel-table").waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return "no Table tab";
  }
  const sections = page.locator(`section:has([data-testid="mh-table-heading-${divisionSlug}"]) section[data-testid^="mh-table-"]`);
  const n = await sections.count();
  if (n !== 1) return `${n} tables under ${divisionSlug}`;
  return sections.first().evaluate((section) => {
    const headers: Record<string, string> = {};
    for (const th of section.querySelectorAll("thead th[data-col]")) {
      headers[th.getAttribute("data-col")!] = (th.querySelector("[aria-hidden]")?.textContent ?? "").trim();
    }
    const rows: Record<string, Record<string, string>> = {};
    for (const tr of section.querySelectorAll("tbody tr")) {
      const cells: Record<string, string> = {};
      for (const td of tr.querySelectorAll("td[data-col]")) cells[td.getAttribute("data-col")!] = (td.textContent ?? "").trim();
      // The entrant is the row's <th> (rank <td>, name <th>, then one <td data-col> per column); its text leads with the avatar's initials.
      if (Object.keys(cells).length > 0) rows[(tr.querySelector("th")?.textContent ?? "?").trim()] = cells;
    }
    return { headers, rows };
  });
}

test.describe("ST-G21 the board and the public table show Buchholz for a Swiss", () => {
  test.describe.configure({ mode: "serial" });
  test.afterEach(async () => {
    // Never `finally`: a Playwright timeout skips it.
    await closeOpenContexts();
  });

  const sport = LATE_SPORTS.find((s) => s.key === "badminton")!;
  let seeded: { divisionId: string; divisionSlug: string; stageId: string; names: string[]; hubUrl: string; leagueId: string };

  test.beforeAll(async ({ playwright }, testInfo) => {
    // A hook has its own clock; the test's `setTimeout` does not reach it.
    testInfo.setTimeout(SEED_BUDGET_MS);
    const request = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: testInfo.project.use.storageState,
    });
    try {
      // Badminton: its Swiss chain holds BOTH ladders and the points ratio (the widest board); four players, two boards a round.
      const g = await startedSwiss(request, sport, 4, 2, "ST-G21");
      const div = await apiJson<{ competition_id: string; slug: string }>(request, `/api/v1/divisions/${g.divisionId}`);
      expect(div.status, JSON.stringify(div.error)).toBe(200);
      const competitionId = div.data!.competition_id;
      const made = await apiJson<{ visibility: string }>(request, `/api/v1/competitions/${competitionId}`, "PATCH", { visibility: "public" });
      expect([made.status, made.data?.visibility], `a spectator can only read a public competition: ${JSON.stringify(made.error)}`).toEqual([200, "public"]);
      // The spectator hub, built by `routes.publicHub` (LIVE1) off the slugs in the organiser path `/o/{org}/c/{comp}`.
      const organiser = await competitionPath(request, competitionId);
      const slugs = /^\/o\/([^/]+)\/c\/([^/?]+)$/.exec(organiser);
      expect(slugs, `premise: an organiser competition path, got ${organiser}`).not.toBeNull();
      const hubUrl = `${routes.publicHub(slugs![1]!, slugs![2]!)}?tab=table`;

      // Round 1, both boards decided through the scorer's events: the losers' opponents scored, so their Buchholz is not zero.
      const boards = (await g.boards(1)) as Seated[];
      expect(boards, "premise: two boards in round 1").toHaveLength(2);
      for (const b of boards) await sport.win(request, b, b.home_entrant_id!);
      await expect
        .poll(
          async () => {
            const standings = await apiJson<{ rows: { played: number }[] }>(request, `/api/v1/stages/${g.stageId}/standings`);
            return standings.data?.rows.map((r) => r.played);
          },
          { timeout: 20_000 },
        )
        .toEqual([1, 1, 1, 1]);

      // The league beside it, on the same board: a table with no Buchholz in its cascade.
      const league = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
        name: "Table",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
      expect(league.status, JSON.stringify(league.error)).toBe(201);
      expect((await addEntrantsViaApi(request, league.data!.id, ["North", "South"])).ids).toHaveLength(2);
      await createStageAndGenerate(request, league.data!.id, { kind: "league", name: "Plain League" });

      seeded = { divisionId: g.divisionId, divisionSlug: div.data!.slug, stageId: g.stageId, names: g.names, hubUrl, leagueId: league.data!.id };
    } finally {
      await request.dispose();
    }
  });

  test("the organiser's board headers the two ladders after Pts and the ratio from 2xl up, each row prints its own - the cells the anonymous public table prints for the same entrants - and below 2xl they are folded", async ({ page, browser }, testInfo) => {
    testInfo.setTimeout(240_000);
    await openBoard(page, seeded.divisionId, TV);
    const board = await readBoard(page, "Swiss");
    await testInfo.attach("swiss-board-1920", { body: await page.locator("main").screenshot(), contentType: "image/png" });

    // The whole control set, membership and order: the old columns, Pts, the ratio, then the ladders last.
    expect(board.header.slice(0, 2)).toEqual(["#", L.entrant]);
    expect(board.header.slice(-2), "the two ladders close the header").toEqual([...LADDERS]);
    const pts = board.header.indexOf(L.points);
    expect(pts, "Pts is in the header").toBeGreaterThan(1);
    expect(board.header.slice(pts + 1, -2), "between Pts and the ladders: the ratio the cascade also holds, nothing else").toHaveLength(1);
    expect(Object.keys(board.rows).sort()).toEqual([...seeded.names].sort());
    for (const [name, row] of Object.entries(board.rows)) {
      expect(row.texts, `${name}'s cells: one under every header`).toHaveLength(board.header.length);
    }
    // PAINTED at a TV width: every header cell and every row cell, the ladders included (computed visibility, not attachment).
    expect(board.headerShown, "every header cell is painted at 1920").toEqual(board.header.map(() => true));
    for (const [name, row] of Object.entries(board.rows)) expect(row.shown, `${name}: every cell is painted at 1920`).toEqual(row.texts.map(() => true));
    expect(board.pageScrolls, "the page does not scroll sideways at 1920").toBe(false);

    // The public table: the same entrants, the same ladders, the same text. Polled: the hub document is cached for a moment.
    const page2 = await spectator(browser, { width: 1280, height: 900 });
    const cellsOf = (hub: HubTable, name: string, key: string) => hub.rows[Object.keys(hub.rows).find((n) => n.includes(name)) ?? ""]?.[key];
    await expect
      .poll(
        async () => {
          const hub = await hubTable(page2, seeded.hubUrl, seeded.divisionSlug);
          if (typeof hub === "string") return hub;
          if (hub.headers.buchholz_cut1 !== LADDERS[0] || hub.headers.buchholz !== LADDERS[1]) return `headers ${JSON.stringify(hub.headers)}`;
          const mismatched = seeded.names.filter((name) => {
            const texts = board.rows[name]!.texts;
            return texts[texts.length - 2] !== cellsOf(hub, name, "buchholz_cut1") || texts[texts.length - 1] !== cellsOf(hub, name, "buchholz");
          });
          return mismatched.length === 0 ? "equal" : `unequal: ${mismatched.join(", ")}`;
        },
        { timeout: 90_000, intervals: [2_000], message: "the board's ladder cells are the public table's" },
      )
      .toBe("equal");

    // Anti-vacuity: the ladders carry numbers, not only dashes or zeros (the losers' opponents scored).
    const values = Object.values(board.rows).flatMap((row) => row.texts.slice(-2));
    expect(values.every((v) => v !== "—"), "no dash: every row has a ledger").toBe(true);
    expect(values.some((v) => v !== "0"), "at least one ladder is not zero").toBe(true);

    // The breakpoint, on the same open page (a resize is a media-query change, not a reload): painted at exactly 2xl, folded one
    // pixel below it and at a 1280 laptop - the other columns untouched at every width.
    const kept = board.header.length - 2;
    for (const [width, shown] of [[LADDERS_FROM, true], [LADDERS_FROM - 1, false], [LAPTOP.width, false]] as const) {
      const at = await boardAtWidth(page, "Swiss", width, shown);
      expect(at.header, `the header's text does not change with the width (${width})`).toEqual(board.header);
      expect(at.headerShown.slice(0, kept), `${width}: the old columns stay painted`).toEqual(board.header.slice(0, kept).map(() => true));
      expect(at.headerShown.slice(-2), `${width}: the ladders' headers`).toEqual([shown, shown]);
      for (const [name, row] of Object.entries(at.rows)) expect(row.shown.slice(-2), `${width} ${name}: the ladders' cells`).toEqual([shown, shown]);
      expect(at.pageScrolls, `the page does not scroll sideways at ${width}`).toBe(false);
    }
    await testInfo.attach("swiss-board-1280-folded", { body: await page.locator("main").screenshot(), contentType: "image/png" });
  });

  test("a league beside it draws its table with no Buchholz header at a TV width either (the negative pair)", async ({ page }) => {
    await openBoard(page, seeded.leagueId, TV);
    const board = await readBoard(page, "Plain League");
    // The table IS on screen - its header and both rows, all painted - so the absence below is the cascade's, not an unhydrated,
    // empty or merely folded board (1920 is wider than the 2xl the ladders need).
    expect(board.header.slice(0, 2)).toEqual(["#", L.entrant]);
    expect(Object.keys(board.rows).sort()).toEqual(["North", "South"]);
    expect(board.headerShown, "every league header cell is painted").toEqual(board.header.map(() => true));
    for (const word of LADDERS) expect(board.header, word).not.toContain(word);
    expect(board.header.at(-1), "the league's header ends on Pts, as it always did").toBe(L.points);
  });
});
