// Standings qualification status, as a phone and a desktop actually draw it
// (spec 2026-09-22 §5, Option B; plan Task 7 Step 6). The unit suites pin
// WHICH markup the division page and the embed emit; they run with no DOM,
// so none of them can see the four things this file measures in Chromium:
//
//  1. the page never scrolls sideways at 320, 768 or 1280 with the cut line,
//     the legend and a realistic long entrant name in the table;
//  2. every rank trigger is a 40px target — `elementFromPoint` at its centre
//     and 19.5px either side of it, both ways, lands inside the button (not a
//     `boundingBox()`, which measures paint, AGENTS.md #2);
//  3. the LAST row's popover opens upward and stays inside the table's scroll
//     box — the box clips a panel hanging below the final row, and the cut
//     line (a `<tr>` of its own) must never take `tr:last-child` from it;
//  4. a phone shows the SAME controls as a desktop — the same markers on the
//     same rows, the same cut line and legend — not a groomed shrink.
//
// The scene: a public generic league of six, single round robin (five rounds),
// four played, and a knockout "Finals" taking places 1–2. Round 5's pairings
// are read back and the results arranged around them so the table holds every
// marker kind: one entrant clear (Through), one a win from it, two level on
// points and split on difference (their popovers carry the tie note), and two
// out of reach. Those kinds are the builder's, read off the page; this file
// asserts only that each kind is present, never which entrant holds it —
// that is the qualification e2e's job (plan Task 10).
//
// Cropped screenshots of the standings panel with a popover open are written
// to this test's own output directory (`testInfo.outputPath`).
//
// Plan Task 8 adds the competition hub: the Table tab at the same three widths
// (the same four measurements, plus the cut row's own geometry — under the hub
// table's `table-fixed`, a cut cell spanning more columns than the header
// shows crushes the name column, so the row must span exactly the table at
// each width, folded and unfolded), and the Overview's preview at 320, which
// keeps the markers and the line but drops the legend (controller ruling OQ3).
//
// Task 8 fix round 1: an open popover is `position: fixed`, placed from its
// trigger inside the viewport's 16px gutters, because the table's scroll box
// clipped it (the hub's four-part popover showed 157 of its 178px). So every
// open panel here is asserted WHOLE ON SCREEN — fixed, inside the gutters, and
// not scrolling its own text — against the viewport, not the table's box; no
// ancestor may carry a transform or filter that would contain a fixed panel;
// and an open panel must follow its trigger when the page or the table's own
// box scrolls. Pictures are viewport-only: a `fullPage` capture paints a
// fixed element at its viewport offset inside a much taller image.
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, expectNoHorizontalScroll, scoreFixture } from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import { API_CALL_MS, FLOOR_MS, activeOrgSlug, dictString, division, publicCompetition, scheduleFixture, spectator } from "./spectator-w2-kit";

test.describe.configure({ mode: "serial" });

/** Six names, one of them long enough to wrap its cell at 320 (AGENTS.md: a
 *  missing `min-w-0` showed only with a realistic 43-character name). */
const NAMES = [
  "Alder Park",
  "Harbour Shuttles",
  "Northgate BC",
  "Riverside Smash Badminton Club Seniors",
  "Delta Racquets",
  "Kestrel",
].map((n) => `${n} ${TAG}`);

interface FixtureRow {
  id: string;
  stage_id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

interface Seed {
  divisionPath: string;
  embedPath: string;
  hubPath: string;
}
let seed: Seed;
let seedContext: BrowserContext | undefined;

test.beforeAll(async ({ browser }) => {
  // org, competition, division + read, two stages, entrants, generate, start,
  // list = 10; twelve results at two calls each; one kick-off; a few
  // standings polls.
  test.setTimeout(Math.max(FLOOR_MS, (10 + 12 * 2 + 1 + 6) * API_CALL_MS));
  seedContext = await browser.newContext();
  const request: APIRequestContext = seedContext.request;
  const org = await activeOrgSlug(request);
  const competition = await publicCompetition(request, { name: `Qual layout ${TAG}`, orgId: org.id });
  const div = await division(request, competition.id, { name: "Open league", sport_key: "generic", variant_key: "score" });

  const league = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  expect(league.status, JSON.stringify(league.error)).toBeLessThan(300);
  const finals = await apiJson(request, `/api/v1/divisions/${div.id}/stages`, "POST", {
    seq: 2,
    kind: "knockout",
    name: "Finals",
    config: {},
    progression: {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
      timing: "on_complete",
    },
  });
  expect(finals.status, JSON.stringify(finals.error)).toBeLessThan(300);
  const added = await addEntrantsViaApi(request, div.id, NAMES);
  expect(added.status, "the whole field was created").toBe(201);

  const gen = await apiJson(request, `/api/v1/stages/${league.data!.id}/generate`, "POST");
  expect(gen.status, JSON.stringify(gen.error)).toBeLessThan(300);
  const started = await apiJson(request, `/api/v1/divisions/${div.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  const listed = await apiJson<FixtureRow[]>(request, `/api/v1/divisions/${div.id}/fixtures`);
  const fixtures = (listed.data ?? []).filter((f) => f.stage_id === league.data!.id);
  expect(fixtures, "a single round robin of six is fifteen fixtures").toHaveLength(15);
  const lastRound = Math.max(...fixtures.map((f) => f.round_no));
  const last = fixtures.filter((f) => f.round_no === lastRound);
  expect(last, "the last round seats all six").toHaveLength(3);

  // Strength from the LAST round's pairings: its three pairs are strongest v
  // weakest, second v fifth, third v fourth. Every earlier match goes to the
  // stronger side, by the gap in strength — so after four rounds the table
  // reads 12 · 9 · 6 · 6 · 3 · 0, the two on 6 split on difference.
  const strength = new Map<string, number>();
  last.forEach((f, i) => {
    strength.set(f.home_entrant_id!, 6 - i);
    strength.set(f.away_entrant_id!, 1 + i);
  });
  for (const f of fixtures.filter((x) => x.round_no !== lastRound)) {
    const home = strength.get(f.home_entrant_id!)!;
    const away = strength.get(f.away_entrant_id!)!;
    const margin = Math.abs(home - away);
    await scoreFixture(request, f.id, home > away ? 1 + margin : 1, home > away ? 1 : 1 + margin);
  }
  // One last-round match gets a kick-off a week out. The hub's Overview
  // previews its tables only once something is NEXT UP: with nothing
  // scheduled it sits on its dates rung, which shows no tables at all.
  await scheduleFixture(request, last[0]!.id, new Date(Date.now() + 7 * 86_400_000).toISOString());
  // The standings fold runs after each result commits; the public page reads
  // the snapshot, and a snapshot that trails its fixtures shows no status.
  await expect
    .poll(
      async () => {
        const st = await apiJson<{ rows: { played: number }[] }>(request, `/api/v1/stages/${league.data!.id}/standings`);
        return (st.data?.rows ?? []).reduce((n, r) => n + r.played, 0);
      },
      { timeout: 30_000 },
    )
    .toBe(24);

  seed = {
    divisionPath: `/shared/${org.slug}/${competition.slug}/${div.slug}?tab=standings`,
    embedPath: `/embed/divisions/${div.id}/standings`,
    hubPath: `/shared/${org.slug}/${competition.slug}`,
  };
});

test.afterEach(async () => {
  // Never `finally`: a Playwright timeout skips it.
  await closeOpenContexts();
});

test.afterAll(async () => {
  await seedContext?.close().catch(() => {});
});

/** Load `path` until its standings show the cut line (ISR can hand the first
 *  visitor a page rendered a moment before the last result folded). */
async function openWithCut(page: Page, path: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(path, { waitUntil: "load" });
        return page.getByTestId("qual-cut").count();
      },
      { timeout: 45_000, intervals: [1_000, 5_000] },
    )
    .toBe(1);
}

/** What a reader sees row by row: each entrant's name, marker and trigger
 *  name, and the cut line where it falls; then the legend. */
async function controlSet(scope: Locator): Promise<string[]> {
  const rows = await scope.locator('[role="region"] > table > tbody > tr').evaluateAll((trs) =>
    trs.map((tr) =>
      tr.getAttribute("data-testid") === "qual-cut"
        ? `cut | ${tr.textContent?.trim()}`
        : [
            tr.querySelector('th[scope="row"]')?.textContent?.trim() ?? "",
            tr.querySelector("[data-qual-marker]")?.getAttribute("data-qual-marker") ?? "none",
            tr.querySelector("button[aria-label]")?.getAttribute("aria-label") ?? "",
          ].join(" | "),
    ),
  );
  const legend = await scope.getByTestId("qual-legend").innerText();
  return [...rows, `legend | ${legend.replace(/\s+/g, " ")}`];
}

/** `elementFromPoint` at the trigger's centre and `inset` px either side of
 *  it, both ways — each must land inside the button. */
async function hitTest(button: Locator, inset: number) {
  return button.evaluate((el, d) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const points: [number, number][] = [
      [cx, cy],
      [cx - d, cy],
      [cx + d, cy],
      [cx, cy - d],
      [cx, cy + d],
    ];
    return {
      label: el.getAttribute("aria-label"),
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
      inside: points.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && el.contains(hit);
      }),
    };
  }, inset);
}

/** The page's own sideways extent, for the report beside the assertion. */
const pageWidths = (page: Page) =>
  page.evaluate(() => ({ scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: window.innerWidth }));

/** Screenshot the union of `boxes`, padded, from the VIEWPORT as the reader
 *  sees it — no `fullPage`, which paints a fixed panel at its viewport offset
 *  inside a taller image, and no scroll to the top, which would move a fixed
 *  panel after its trigger. The union must already be on screen. */
async function cropped(page: Page, path: string, boxes: Locator[]): Promise<void> {
  const rects = (await Promise.all(boxes.map((b) => b.boundingBox()))).filter((r) => r !== null);
  expect(rects, "a box to crop around has no layout").toHaveLength(boxes.length);
  const { width: vw, height: vh } = page.viewportSize()!;
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  expect(top, "the picture would start above the viewport").toBeGreaterThanOrEqual(0);
  expect(bottom, "the picture would end below the viewport").toBeLessThanOrEqual(vh);
  const pad = 8;
  const x = Math.max(0, Math.min(...rects.map((r) => r.x)) - pad);
  const y = Math.max(0, top - pad);
  const right = Math.min(vw, Math.max(...rects.map((r) => r.x + r.width)) + pad);
  await page.screenshot({ path, clip: { x, y, width: right - x, height: Math.min(vh, bottom + pad) - y } });
}

/** Scroll so `scope` starts 120px down the viewport, clear of the sticky site
 *  header and tab rail (~110px), so a picture of it and its open panel is
 *  what a reader sees with nothing painted across it. */
async function frame(scope: Locator): Promise<void> {
  await scope.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
}

/** Where an OPEN panel landed and whether it can be read whole. */
async function panelFit(panel: Locator) {
  return panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      position: getComputedStyle(el).position,
      side: el.dataset.side ?? "down",
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    };
  });
}

/** The fix's proof: the open panel is `fixed`, inside the viewport's 16px
 *  gutters, and its WHOLE text is visible — `clientHeight >= scrollHeight`.
 *  Clipped by the table's box, the hub's four-part panel was 157 of 178px. */
async function expectWholeOnScreen(panel: Locator, what: string) {
  const fit = await panelFit(panel);
  expect(fit.position, `${what}: the open panel is not fixed`).toBe("fixed");
  expect(fit.clientHeight, `${what}: the panel's text is cut off (${fit.clientHeight} of ${fit.scrollHeight}px)`).toBeGreaterThanOrEqual(
    fit.scrollHeight,
  );
  expect(fit.top, `${what}: above the viewport's top gutter`).toBeGreaterThanOrEqual(16 - 0.5);
  expect(fit.bottom, `${what}: below the viewport's bottom gutter`).toBeLessThanOrEqual(fit.vh - 16 + 0.5);
  expect(fit.left, `${what}: past the viewport's left gutter`).toBeGreaterThanOrEqual(16 - 0.5);
  expect(fit.right, `${what}: past the viewport's right gutter`).toBeLessThanOrEqual(fit.vw - 16 + 0.5);
  return fit;
}

/** Every ancestor that would make ITSELF the containing block of a `fixed`
 *  panel — a transform, a filter, containment — and so could clip it again.
 *  None may exist on any mount. */
async function fixedTraps(panel: Locator): Promise<string[]> {
  return panel.evaluate((el) => {
    const traps: string[] = [];
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const v = (prop: string) => cs.getPropertyValue(prop).trim();
      const hits = [
        ["transform", "none"],
        ["translate", "none"],
        ["scale", "none"],
        ["rotate", "none"],
        ["filter", "none"],
        ["backdrop-filter", "none"],
        ["perspective", "none"],
        ["container-type", "normal"],
      ]
        .filter(([prop, idle]) => v(prop!) !== "" && v(prop!) !== idle)
        .map(([prop]) => `${prop}:${v(prop!)}`);
      if (/layout|paint|strict|content/.test(v("contain"))) hits.push(`contain:${v("contain")}`);
      if (/transform|filter|perspective/.test(v("will-change"))) hits.push(`will-change:${v("will-change")}`);
      if (hits.length) traps.push(`${a.tagName.toLowerCase()}.${[...a.classList].join(".")} → ${hits.join(", ")}`);
    }
    return traps;
  });
}

/** Open the popover behind `button`; returns its panel. */
async function open(page: Page, button: Locator): Promise<Locator> {
  await button.click();
  const panel = page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
  await expect(panel).toBeVisible();
  return panel;
}

const shots: Record<number, string[]> = {};

for (const width of [1280, 768, 320] as const) {
  test(`division page at ${width}: markers, cut line and legend fit, the rank is a 40px target, the last row opens upward`, async ({ browser }, testInfo) => {
    const page = await spectator(browser, { width, height: 900 });
    await openWithCut(page, seed.divisionPath);
    const panel = page.locator("#panel-standings");
    const block = panel.getByTestId("qual-legend").locator("xpath=..");

    // Premise: the scene holds every marker kind, so the pictures show them.
    const kinds = await panel.locator("tbody [data-qual-marker]").evaluateAll((els) =>
      [...new Set(els.map((e) => e.getAttribute("data-qual-marker")))].sort(),
    );
    expect(kinds).toEqual(["needs_help", "out", "through", "win_k"]);
    await expect(panel.getByTestId("qual-legend")).toContainText(dictString("en", "table.qual.legend.open"));

    // 1. No sideways page scroll.
    const widths = await pageWidths(page);
    await expectNoHorizontalScroll(page);

    // 2. Every rank trigger is a 40px target: 19.5px either side of the
    //    centre at a phone width (a 38px box passes ±19, so ±19.5 is what
    //    proves the 40px floor); the centre everywhere.
    const triggers = panel.getByRole("button", { name: /^Rank \d+,/ });
    await expect(triggers).toHaveCount(6);
    const hits = [];
    for (const button of await triggers.all()) {
      const hit = await hitTest(button, width < 768 ? 19.5 : 0);
      hits.push(hit);
      expect(hit.inside, `${hit.label}: a tap there misses the trigger (${hit.width}×${hit.height})`).toEqual(
        hit.inside.map(() => true),
      );
    }

    // A middle row's popover — the tied row, whose panel carries the status,
    // the tie note and the what-if — then the last row's.
    const tied = panel.locator('button[data-testid^="standings-tie-"]').first();
    await expect(tied).toBeVisible();
    await frame(block);
    const tiedPanel = await open(page, tied);
    await expect(tiedPanel.getByTestId("qual-headline")).toBeVisible();
    await expect(tiedPanel.getByTestId("qual-tie-note")).toBeVisible();
    const tiedFit = await expectWholeOnScreen(tiedPanel, `division ${width}, tied row`);
    expect(await fixedTraps(tiedPanel), "an ancestor would contain the fixed panel").toEqual([]);
    const middle = testInfo.outputPath(`standings-qual-${width}.png`);
    await cropped(page, middle, [block, tiedPanel]);
    await page.keyboard.press("Escape");
    await expect(tiedPanel).toBeHidden();

    // 3. The last row opens UPWARD (spec §5), whole on screen.
    const lastRow = triggers.last();
    await frame(block);
    const lastPanel = await open(page, lastRow);
    // Measured against the popover ROOT, as standings-popovers.spec.ts does:
    // the button's hit area is stretched over the cell's padding by negative
    // margins, so the panel hangs from the chip it explains, not the button.
    const [pop, btn] = await Promise.all([lastPanel.boundingBox(), lastRow.locator("xpath=..").boundingBox()]);
    expect(pop!.y + pop!.height, "the last row's panel hangs below its trigger").toBeLessThanOrEqual(btn!.y + 0.5);
    await expectWholeOnScreen(lastPanel, `division ${width}, last row`);
    const lastShot = testInfo.outputPath(`standings-qual-${width}-last-row.png`);
    await cropped(page, lastShot, [block, lastPanel]);
    await page.keyboard.press("Escape");

    shots[width] = await controlSet(panel);
    const measured = { width, ...widths, hits, tiedFit, lastPanel: { panel: pop, trigger: btn }, controls: shots[width] };
    await testInfo.attach(`measurements-${width}.json`, { body: JSON.stringify(measured, null, 1), contentType: "application/json" });
    console.log(`MEASURED ${JSON.stringify(measured)}`);
  });
}

test("a phone shows the same controls as a desktop: markers, cut line, trigger names and legend", () => {
  expect(shots[320], "the 320 leg did not run").toBeDefined();
  expect(shots[1280], "the 1280 leg did not run").toBeDefined();
  expect(shots[320]).toEqual(shots[1280]);
  expect(shots[768]).toEqual(shots[1280]);
});

test("the embedded standings widget at 320: cut line, markers and an open popover, no sideways scroll", async ({ browser }, testInfo) => {
  const page = await spectator(browser, { width: 320, height: 900 });
  await openWithCut(page, seed.embedPath);
  const widths = await pageWidths(page);
  await expectNoHorizontalScroll(page);
  const legend = page.getByTestId("qual-legend");
  await expect(legend).toBeVisible();
  const block = legend.locator("xpath=..");
  const rank2 = page.getByRole("button", { name: /^Rank 2,/ });
  const hit = await hitTest(rank2, 19.5);
  expect(hit.inside).toEqual([true, true, true, true, true]);
  const panel = await open(page, rank2);
  await expect(panel.getByTestId("qual-headline")).toBeVisible();
  const fit = await expectWholeOnScreen(panel, "embed 320, rank 2");
  expect(await fixedTraps(panel), "an ancestor would contain the fixed panel").toEqual([]);
  await cropped(page, testInfo.outputPath("embed-standings-qual-320.png"), [block, panel]);
  console.log(`MEASURED ${JSON.stringify({ embed: 320, ...widths, hit, fit })}`);
});

// ── The competition hub (plan Task 8) ─────────────────────────────────────

/** The hub standings table that carries the cut — one division, one league
 *  stage, so exactly one on either tab. */
const hubTable = (page: Page, prefix: string) =>
  page.locator(`section[data-testid^="${prefix}"]`).filter({ has: page.getByTestId("qual-cut") });

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The cut row against the table it sits in: how many columns its VISIBLE
 *  cells span against how many the header shows, the horizontal extent of
 *  those cells against the table's own box, and the name column's width. */
async function cutGeometry(table: Locator) {
  return table.locator("table").evaluate((t) => {
    const shown = (el: Element) => getComputedStyle(el).display !== "none";
    const cut = t.querySelector('[data-testid="qual-cut"]')!;
    const cells = [...cut.children].filter(shown) as HTMLTableCellElement[];
    const rects = cells.map((c) => c.getBoundingClientRect());
    const box = t.getBoundingClientRect();
    return {
      headerCols: [...t.querySelectorAll("thead th")].filter(shown).length,
      cutCols: cells.reduce((n, c) => n + c.colSpan, 0),
      table: [box.left, box.right],
      cut: [Math.min(...rects.map((r) => r.left)), Math.max(...rects.map((r) => r.right))],
      name: t.querySelector("thead th:nth-child(2)")!.getBoundingClientRect().width,
    };
  });
}

/** A cut cell spanning more columns than the header shows makes grid
 *  columns the header never sized, and `table-fixed` shares the remainder
 *  with them — the name column went 88px → 29px in Chromium at 320. */
function expectCutSpansTable(g: Awaited<ReturnType<typeof cutGeometry>>) {
  expect(g.cutCols, "the cut row spans a different number of columns than the header shows").toBe(g.headerCols);
  expect(Math.abs(g.cut[0]! - g.table[0]!), "the cut row starts inside the table").toBeLessThanOrEqual(1);
  expect(Math.abs(g.cut[1]! - g.table[1]!), "the cut row stops short of the table's end").toBeLessThanOrEqual(1);
  expect(g.name, "the name column fell below its 96px floor").toBeGreaterThanOrEqual(96);
}

const hubShots: Record<number, string[]> = {};

for (const width of [1280, 768, 320] as const) {
  test(`hub Table tab at ${width}: markers, cut line and legend fit, the cut row spans the table, the rank is a 40px target`, async ({ browser }, testInfo) => {
    const page = await spectator(browser, { width, height: 900 });
    await openWithCut(page, `${seed.hubPath}?tab=table`);
    await expect(page.getByTestId("mh-tab-panel-table"), "?tab=table opened a different tab").toBeVisible();
    const table = hubTable(page, "mh-table-");
    await expect(table).toHaveCount(1);
    await expect(table.getByTestId("qual-legend")).toContainText(dictString("en", "table.qual.legend.open"));

    // Premise: every marker kind, as on the division page.
    const kinds = await table.locator("tbody [data-qual-marker]").evaluateAll((els) =>
      [...new Set(els.map((e) => e.getAttribute("data-qual-marker")))].sort(),
    );
    expect(kinds).toEqual(["needs_help", "out", "through", "win_k"]);

    // 1. No sideways page scroll; the cut row spans exactly the table.
    const widths = await pageWidths(page);
    await expectNoHorizontalScroll(page);
    const geometry = [await cutGeometry(table)];
    expectCutSpansTable(geometry[0]!);

    // 2. Every rank trigger is a 40px target (±19.5 at a phone width).
    const triggers = table.getByRole("button", { name: /^Rank \d+,/ });
    await expect(triggers).toHaveCount(6);
    const hits = [];
    for (const button of await triggers.all()) {
      const hit = await hitTest(button, width < 768 ? 19.5 : 0);
      hits.push(hit);
      expect(hit.inside, `${hit.label}: a tap there misses the trigger (${hit.width}×${hit.height})`).toEqual(
        hit.inside.map(() => true),
      );
    }

    // The tied row's ONE popover — status, if you lose, tie note, what-if —
    // WHOLE on screen. This is the fix round's proof: clipped by the table's
    // box it showed 157 of its 178px at every width.
    const tied = table.locator('button[data-testid*="-tie-"]').first();
    await expect(tied).toBeVisible();
    await expect(tied, "the tied row's trigger is the qualification one").toHaveAttribute("aria-label", /^Rank \d+,/);
    await frame(table);
    const tiedPanel = await open(page, tied);
    await expect(tiedPanel.getByTestId("qual-headline")).toBeVisible();
    await expect(tiedPanel.getByTestId("qual-tie-note")).toBeVisible();
    await expect(tiedPanel.getByTestId("qual-what-if")).toBeVisible();
    const tiedFit = await expectWholeOnScreen(tiedPanel, `hub ${width}, tied row`);
    expect(await fixedTraps(tiedPanel), "an ancestor would contain the fixed panel").toEqual([]);
    await cropped(page, testInfo.outputPath(`hub-table-${width}.png`), [table, tiedPanel]);
    await page.keyboard.press("Escape");
    await expect(tiedPanel).toBeHidden();

    // 3. The last row opens UPWARD (spec §5), whole on screen.
    const lastRow = triggers.last();
    await frame(table);
    const lastPanel = await open(page, lastRow);
    const [pop, btn] = await Promise.all([lastPanel.boundingBox(), lastRow.locator("xpath=..").boundingBox()]);
    expect(pop!.y + pop!.height, "the last row's panel hangs below its trigger").toBeLessThanOrEqual(btn!.y + 0.5);
    await expectWholeOnScreen(lastPanel, `hub ${width}, last row`);
    await cropped(page, testInfo.outputPath(`hub-table-${width}-last-row.png`), [table, lastPanel]);
    await page.keyboard.press("Escape");

    // A phone folds the long tail; unfolded, the cut row must follow it.
    if (width < 768) {
      const more = table.locator('[data-testid$="-more"]');
      await expect(more, "premise: the table has a long tail to unfold").toBeVisible();
      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      const unfolded = await cutGeometry(table);
      expect(unfolded.headerCols, "premise: unfolding shows more columns").toBeGreaterThan(geometry[0]!.headerCols);
      expectCutSpansTable(unfolded);
      geometry.push(unfolded);
      await expectNoHorizontalScroll(page);
      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "false");
    }

    hubShots[width] = await controlSet(table);
    const measured = {
      hub: width,
      ...widths,
      hits,
      geometry: geometry.map((g) => ({ ...g, table: g.table.map(r1), cut: g.cut.map(r1), name: r1(g.name) })),
      lastPanel: { panel: pop, trigger: btn },
      tiedFit,
      controls: hubShots[width],
    };
    await testInfo.attach(`hub-measurements-${width}.json`, { body: JSON.stringify(measured, null, 1), contentType: "application/json" });
    console.log(`MEASURED ${JSON.stringify(measured)}`);
  });
}

test("the hub's phone shows the same controls as its desktop: markers, cut line, trigger names and legend", () => {
  expect(hubShots[320], "the 320 leg did not run").toBeDefined();
  expect(hubShots[1280], "the 1280 leg did not run").toBeDefined();
  expect(hubShots[320]).toEqual(hubShots[1280]);
  expect(hubShots[768]).toEqual(hubShots[1280]);
});

test("the hub Overview's preview at 320: markers and the cut line, NO legend, no sideways scroll", async ({ browser }, testInfo) => {
  const page = await spectator(browser, { width: 320, height: 900 });
  await openWithCut(page, seed.hubPath);
  const preview = hubTable(page, "mh-table-preview-");
  await expect(preview).toHaveCount(1);
  // OQ3: the teaser keeps its markers and its line; the key to them is one
  // tap away on the Table tab.
  await expect(page.getByTestId("qual-legend")).toHaveCount(0);
  const rows = preview.locator("tbody tr[data-qual]");
  await expect(rows).toHaveCount(3);
  await expect(preview.locator("tbody [data-qual-marker]")).toHaveCount(3);

  const widths = await pageWidths(page);
  await expectNoHorizontalScroll(page);
  const geometry = await cutGeometry(preview);
  expectCutSpansTable(geometry);

  const triggers = preview.getByRole("button", { name: /^Rank \d+,/ });
  await expect(triggers).toHaveCount(3);
  const hits = [];
  for (const button of await triggers.all()) {
    const hit = await hitTest(button, 19.5);
    hits.push(hit);
    expect(hit.inside, `${hit.label}: a tap there misses the trigger (${hit.width}×${hit.height})`).toEqual(
      hit.inside.map(() => true),
    );
  }
  const first = triggers.first();
  await first.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const panel = await open(page, first);
  await expect(panel.getByTestId("qual-headline")).toBeVisible();
  await expectWholeOnScreen(panel, "overview 320, rank 1");
  expect(await fixedTraps(panel), "an ancestor would contain the fixed panel").toEqual([]);
  await cropped(page, testInfo.outputPath("hub-overview-320.png"), [preview, panel]);
  console.log(`MEASURED ${JSON.stringify({ overview: 320, ...widths, hits, geometry: { ...geometry, table: geometry.table.map(r1), cut: geometry.cut.map(r1), name: r1(geometry.name) } })}`);
});

test("an open panel follows its trigger: when the page scrolls, when the table's own box scrolls sideways, and when the viewport shrinks under it (hub, 320)", async ({ browser }) => {
  // A short viewport, so the page has room to scroll with the trigger centred.
  const page = await spectator(browser, { width: 320, height: 640 });
  await openWithCut(page, `${seed.hubPath}?tab=table`);
  const table = hubTable(page, "mh-table-");
  const region = table.locator('[role="region"]');
  // Unfolded, the long tail puts the table wider than its box: the box scrolls.
  const more = table.locator('[data-testid$="-more"]');
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  expect(await region.evaluate((el) => el.scrollWidth - el.clientWidth), "premise: the box scrolls sideways").toBeGreaterThan(20);

  const tied = table.locator('button[data-testid*="-tie-"]').first();
  await tied.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const panel = await open(page, tied);
  /** The panel against its trigger root: the offsets a panel that follows
   *  keeps, and where the trigger itself is. */
  const offsets = () =>
    panel.evaluate((el) => {
      const a = el.parentElement!.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      return {
        dx: p.left - a.left,
        dy: el.dataset.side === "up" ? a.top - p.bottom : p.top - a.bottom,
        anchorTop: a.top,
        anchorLeft: a.left,
      };
    });
  const before = await offsets();
  expect(before.anchorLeft - 6, "premise: the trigger clears the left gutter after a 6px sideways scroll").toBeGreaterThan(16);

  // The page, by 40px: the trigger rises, and the panel with it.
  expect(await page.evaluate(() => (window.scrollBy(0, 40), window.scrollY)), "premise: the page scrolls").toBeGreaterThan(0);
  await expect.poll(async () => (await offsets()).anchorTop, { message: "premise: the page scroll moved the trigger" }).toBeLessThan(before.anchorTop - 20);
  await expect.poll(async () => Math.abs((await offsets()).dy - before.dy), { message: "the panel stayed put when the page scrolled" }).toBeLessThanOrEqual(1);

  // The table's own box, sideways by 6px: only a CAPTURE-phase listener hears
  // it (a scroll event does not bubble).
  const left0 = (await offsets()).anchorLeft;
  await region.evaluate((el) => {
    el.scrollLeft += 6;
  });
  await expect.poll(async () => (await offsets()).anchorLeft, { message: "premise: the box scroll moved the trigger" }).toBeLessThan(left0 - 5);
  await expect.poll(async () => Math.abs((await offsets()).dx - before.dx), { message: "the panel stayed put when the table scrolled" }).toBeLessThanOrEqual(1);
  await expectWholeOnScreen(panel, "hub 320, after scrolling");

  // The viewport, shortened to end AT the panel's bottom: where it sat, it now
  // crosses the bottom gutter. Only the resize listener places it again.
  const fit = await panelFit(panel);
  const shorter = Math.floor(fit.bottom);
  expect(fit.bottom - fit.top, "premise: the shorter viewport still holds the whole panel").toBeLessThanOrEqual(shorter - 32);
  await page.setViewportSize({ width: 320, height: shorter });
  await expect
    .poll(async () => (await panelFit(panel)).bottom, { message: "the panel stayed put when the viewport shrank under it" })
    .toBeLessThanOrEqual(shorter - 16 + 0.5);
  await expectWholeOnScreen(panel, "hub 320, after the viewport shrank");
});

/** Scroll room past the page's end: the hub ends close under its table, so
 *  without it a trigger cannot be scrolled far enough up the screen. */
const SCROLL_ROOM = 'body::after { content: ""; display: block; height: 100vh; }';

test("an open panel closes once its trigger has left the screen or the table's box, stays open while any of it shows, and never moves the reader's focus or scroll (hub, 320)", async ({
  browser,
}) => {
  const page = await spectator(browser, { width: 320, height: 640 });
  await openWithCut(page, `${seed.hubPath}?tab=table`);
  await page.addStyleTag({ content: SCROLL_ROOM });
  const table = hubTable(page, "mh-table-");
  const region = table.locator('[role="region"]');
  const tied = table.locator('button[data-testid*="-tie-"]').first();
  const testid = await tied.getAttribute("data-testid");
  const panel = page.locator(`[id="${await tied.getAttribute("aria-controls")}"]`);
  // The popover root — the box the panel is placed from.
  const rootRect = () =>
    tied.locator("xpath=..").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null);
  const scrollY = () => page.evaluate(() => window.scrollY);

  // 1. The page. Opened by a tap that focuses nothing (iOS Safari does not
  //    focus a tapped button), so focus is on <body> throughout.
  await tied.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await tied.evaluate((el) => (el as HTMLElement).click());
  await expect(panel).toBeVisible();
  expect(await focused(), "premise: a tap that focuses nothing").toBe("BODY");
  // Scrolled up until only 2px of the trigger are left on screen: still open.
  await page.evaluate((dy) => window.scrollBy(0, dy), Math.round((await rootRect()).bottom) - 2);
  await expect.poll(async () => (await rootRect()).bottom, { message: "premise: a sliver of the trigger is on screen" }).toBeGreaterThan(0);
  expect((await rootRect()).bottom, "premise: only a sliver").toBeLessThanOrEqual(3);
  await expect(panel, "it closed while its trigger still showed").toBeVisible();
  // 4px more puts the whole trigger above the screen: closed.
  const y1 = await scrollY();
  await page.evaluate(() => window.scrollBy(0, 4));
  await expect.poll(async () => (await rootRect()).bottom, { message: "premise: the trigger is wholly above the screen" }).toBeLessThanOrEqual(0);
  await expect(panel, "the panel outlived its trigger (page scroll)").toBeHidden();
  await expect(tied).toHaveAttribute("aria-expanded", "false");
  expect(await focused(), "the close moved focus that was never in the popover").toBe("BODY");
  expect(await scrollY(), "the close scrolled the page").toBe(y1 + 4);

  // 2. Focus IN the panel (a tap on its text): the close hands it back to the
  //    button, as Esc does — without scrolling the page back to the button.
  await tied.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await tied.click();
  await expect(panel).toBeVisible();
  await panel.click({ position: { x: 8, y: 8 } });
  expect(await focused(), "premise: focus is in the panel").toBe(`${testid}-panel`);
  const y2 = await scrollY();
  const lift = Math.ceil((await rootRect()).bottom) + 1;
  // Read in the same task as the scroll, before its scroll event runs: a
  // hand-back that scrolls to the button would undo it, and a later read would
  // report that as a failed premise instead of the defect it is.
  const moved = await tied.locator("xpath=..").evaluate((el, dy) => {
    window.scrollBy(0, dy);
    return { y: window.scrollY, bottom: el.getBoundingClientRect().bottom };
  }, lift);
  expect(moved.bottom, "premise: the trigger is wholly above the screen").toBeLessThanOrEqual(0);
  expect(moved.y, "premise: the page scrolled").toBe(y2 + lift);
  await expect(panel, "the panel outlived its trigger (focus inside)").toBeHidden();
  expect(await focused(), "focus was in the panel, so it goes back to the button").toBe(testid);
  expect(await scrollY(), "handing focus back scrolled the page to the button").toBe(moved.y);

  // 3. The table's own box, sideways. Widened so its rank column can be
  //    scrolled out past the box's left edge while part of the trigger is
  //    still inside the SCREEN (x 0–16): only the box rule can close it.
  await page.addStyleTag({ content: 'section[data-testid^="mh-table-"] table { min-width: 720px; }' });
  await tied.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await region.evaluate((el) => {
    el.scrollLeft = 0;
  });
  const box = await region.evaluate((el) => el.getBoundingClientRect().left + el.clientLeft);
  const right0 = (await rootRect()).right;
  const range = await region.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(range, "premise: the box scrolls the trigger clear of its left edge").toBeGreaterThan(right0 - box + 2);
  await tied.click();
  await expect(panel).toBeVisible();
  // 2px of the trigger left inside the box: still open.
  await region.evaluate((el, by) => {
    el.scrollLeft = by;
  }, Math.floor(right0 - box - 2));
  await expect.poll(async () => (await rootRect()).right, { message: "premise: a sliver of the trigger inside the box" }).toBeLessThan(box + 3);
  expect((await rootRect()).right, "premise: a sliver, not none").toBeGreaterThan(box);
  await expect(panel, "it closed while its trigger still showed in the box").toBeVisible();
  // 4px more: none of it inside the box, though some is still on screen.
  await region.evaluate((el) => {
    el.scrollLeft += 4;
  });
  await expect.poll(async () => (await rootRect()).right, { message: "premise: the trigger is wholly out of the box" }).toBeLessThanOrEqual(box);
  expect((await rootRect()).right, "premise: but part of it is still on screen").toBeGreaterThan(0);
  await expect(panel, "the panel outlived its trigger (the box scrolled it away)").toBeHidden();
  await expect(tied).toHaveAttribute("aria-expanded", "false");
});

/** At the open panel's top and bottom edges (3px in, on its centre line):
 *  whether a hit-test lands in the panel, what it hit, and which sticky page
 *  chrome (the site header, the tab rail — sticky with a `top`) has a box at
 *  that point at all. The last is the premise: without chrome there, a green
 *  proves nothing. */
async function chromeHits(panel: Locator) {
  return panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const name = (n: Element | null) => (n ? `${n.tagName.toLowerCase()}.${[...n.classList].slice(0, 5).join(".")}` : "nothing");
    const chromeOf = (n: Element): Element | null => {
      for (let a: Element | null = n; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.position === "sticky" && cs.top !== "auto") return a;
      }
      return null;
    };
    return [r.top + 3, r.bottom - 3].map((y) => {
      const hit = document.elementFromPoint(x, y);
      const chrome = document
        .elementsFromPoint(x, y)
        .filter((n) => n !== el && !el.contains(n))
        .map(chromeOf)
        .find((c) => c !== null);
      return { y: Math.round(y), inPanel: hit !== null && el.contains(hit), hit: name(hit), chrome: chrome ? name(chrome) : null };
    });
  });
}

for (const [where, width] of [
  ["division", 320],
  ["division", 1280],
  ["hub", 320],
  ["hub", 1280],
] as const) {
  test(`${where} at ${width}: an upward panel pushed up under the sticky header and tab rail is painted OVER them`, async ({ browser }, testInfo) => {
    const page = await spectator(browser, { width, height: 900 });
    await openWithCut(page, where === "hub" ? `${seed.hubPath}?tab=table` : seed.divisionPath);
    await page.addStyleTag({ content: SCROLL_ROOM });
    const scope = where === "hub" ? hubTable(page, "mh-table-") : page.locator("#panel-standings");
    const lastRow = scope.getByRole("button", { name: /^Rank \d+,/ }).last();
    await frame(scope);
    const panel = await open(page, lastRow);
    await expect(panel, "premise: the last row's panel opens upward").toHaveAttribute("data-side", "up");
    // The page scrolled until the panel's top is 24px down the screen — under
    // the 52px site header — with its trigger still on screen, so it stays open.
    const top0 = await panel.evaluate((el) => el.getBoundingClientRect().top);
    await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(top0 - 24));
    await expect
      .poll(() => panel.evaluate((el) => el.getBoundingClientRect().top), { message: "premise: the panel followed its trigger up under the header" })
      .toBeLessThan(30);
    await expect(panel, "premise: still open (its trigger is on screen)").toBeVisible();
    await expect(panel, "premise: still upward").toHaveAttribute("data-side", "up");
    const hits = await chromeHits(panel);
    expect(hits[0]!.chrome, `premise: the sticky header is at the panel's top edge (y ${hits[0]!.y})`).not.toBeNull();
    for (const h of hits) {
      expect(h.inPanel, `y ${h.y}: ${h.hit} is painted over the panel (sticky chrome there: ${h.chrome})`).toBe(true);
    }
    console.log(`CHROME ${where} ${width} ${JSON.stringify(hits)}`);

    // The division page freezes its rank column: the open row's sticky rank
    // cell is raised to beat its z-10 neighbours, and no higher. Where that
    // cell sits under the z-30 tab rail, the RAIL is painted (a z-30 cell tied
    // the rail and won on DOM order). The point is below the panel, so the
    // top-layer panel cannot be what answers.
    if (where === "division") {
      const under = await lastRow.evaluate((el) => {
        const cell = el.closest("td")!.getBoundingClientRect();
        const rail = [...document.querySelectorAll("div")].find((d) => {
          const cs = getComputedStyle(d);
          return cs.position === "sticky" && cs.top === "54px";
        });
        const panelBottom = el.parentElement!.querySelector('[role="note"]')!.getBoundingClientRect().bottom;
        if (!rail) return { error: "no tab rail" };
        const r = rail.getBoundingClientRect();
        const top = Math.max(cell.top, r.top, panelBottom) + 2;
        const bottom = Math.min(cell.bottom, r.bottom) - 2;
        if (top >= bottom) return { error: `no point under both: ${Math.round(top)} ≥ ${Math.round(bottom)}` };
        const x = cell.left + cell.width / 2;
        const y = (top + bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        return { x: Math.round(x), y: Math.round(y), inRail: hit !== null && rail.contains(hit), inCell: hit !== null && el.closest("td")!.contains(hit) };
      });
      expect(under.error, "premise: the open row's rank cell is under the tab rail, below the panel").toBeUndefined();
      expect(under.inRail, `the open row's rank cell is painted over the tab rail at ${under.x},${under.y}`).toBe(true);
      expect(under.inCell).toBe(false);
    }
    const bottom = await panel.evaluate((el) => el.getBoundingClientRect().bottom);
    await page.screenshot({ path: testInfo.outputPath(`chrome-${where}-${width}.png`), clip: { x: 0, y: 0, width, height: Math.ceil(bottom) + 48 } });
  });
}
