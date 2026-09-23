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
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, expectNoHorizontalScroll, scoreFixture } from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import { API_CALL_MS, FLOOR_MS, activeOrgSlug, dictString, division, publicCompetition, spectator } from "./spectator-w2-kit";

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
}
let seed: Seed;
let seedContext: BrowserContext | undefined;

test.beforeAll(async ({ browser }) => {
  // org, competition, division + read, two stages, entrants, generate, start,
  // list = 10; twelve results at two calls each; a few standings polls.
  test.setTimeout(Math.max(FLOOR_MS, (10 + 12 * 2 + 6) * API_CALL_MS));
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

/** Screenshot the union of `boxes`, padded, clamped to the page. */
async function cropped(page: Page, path: string, boxes: Locator[]): Promise<void> {
  // `boundingBox()` is relative to the VIEWPORT and a `fullPage` clip to the
  // PAGE: scrolled, the crop lands `scrollY` too high, with the sticky site
  // header painted across the table. At the top the two coincide. An open
  // panel stays open — nothing closes it on scroll.
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const rects = (await Promise.all(boxes.map((b) => b.boundingBox()))).filter((r) => r !== null);
  expect(rects, "a box to crop around has no layout").toHaveLength(boxes.length);
  const pad = 8;
  const x = Math.max(0, Math.min(...rects.map((r) => r.x)) - pad);
  const y = Math.max(0, Math.min(...rects.map((r) => r.y)) - pad);
  const right = Math.max(...rects.map((r) => r.x + r.width)) + pad;
  const bottom = Math.max(...rects.map((r) => r.y + r.height)) + pad;
  const vw = page.viewportSize()!.width;
  await page.screenshot({ path, clip: { x, y, width: Math.min(right, vw) - x, height: bottom - y }, fullPage: true });
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
    const region = panel.locator('[role="region"]').first();
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
    await tied.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const tiedPanel = await open(page, tied);
    await expect(tiedPanel.getByTestId("qual-headline")).toBeVisible();
    await expect(tiedPanel.getByTestId("qual-tie-note")).toBeVisible();
    const middle = testInfo.outputPath(`standings-qual-${width}.png`);
    await cropped(page, middle, [block, tiedPanel]);
    await page.keyboard.press("Escape");
    await expect(tiedPanel).toBeHidden();

    // 3. The last row opens UPWARD, inside the scroll box that would clip it.
    const lastRow = triggers.last();
    await lastRow.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const lastPanel = await open(page, lastRow);
    // Measured against the popover ROOT, as standings-popovers.spec.ts does:
    // the button's hit area is stretched over the cell's padding by negative
    // margins, so the panel hangs from the chip it explains, not the button.
    const [box, pop, btn] = await Promise.all([
      region.boundingBox(),
      lastPanel.boundingBox(),
      lastRow.locator("xpath=..").boundingBox(),
    ]);
    expect(pop!.y + pop!.height, "the last row's panel hangs below its trigger").toBeLessThanOrEqual(btn!.y + 0.5);
    expect(pop!.y, "the last row's panel is clipped at the top of the box").toBeGreaterThanOrEqual(box!.y - 0.5);
    expect(pop!.x, "the panel runs out of the box on the left").toBeGreaterThanOrEqual(box!.x - 0.5);
    expect(pop!.x + pop!.width, "the panel runs out of the box on the right").toBeLessThanOrEqual(box!.x + box!.width + 0.5);
    const lastShot = testInfo.outputPath(`standings-qual-${width}-last-row.png`);
    await cropped(page, lastShot, [block, lastPanel]);
    await page.keyboard.press("Escape");

    shots[width] = await controlSet(panel);
    const measured = { width, ...widths, hits, lastPanel: { panel: pop, trigger: btn, box }, controls: shots[width] };
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
  await cropped(page, testInfo.outputPath("embed-standings-qual-320.png"), [block, panel]);
  console.log(`MEASURED ${JSON.stringify({ embed: 320, ...widths, hit })}`);
});
