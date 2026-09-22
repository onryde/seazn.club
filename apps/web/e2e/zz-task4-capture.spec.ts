// Swiss round-1 pairing split button, driven in the browser at 320/768/1280: closed, round-1 menu, the pick reaching the server, round-2 read-only — hit-tested, no horizontal scroll, axe-clean, each state captured.
import { test, expect, type Page, type Locator, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { TAG, apiJson, addEntrantsViaApi, divisionPath } from "./helpers";

// Round 2 reads the round-1 state the earlier tests leave behind.
test.describe.configure({ mode: "serial" });

const WIDTHS = [320, 768, 1280] as const;
const N = 10;

type Fx = {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
};

let divisionId = "";
let swissId = "";
let seedOf = new Map<string, number>();

async function hitTest(loc: Locator, label: string) {
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  expect(box, `${label}: no box`).not.toBeNull();
  const hit = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  console.log(`${label}: ${Math.round(box!.width)}x${Math.round(box!.height)} hit=${hit}`);
  expect(hit, `${label}: elementFromPoint at centre is not the control`).toBe(true);
  expect(box!.height, `${label}: height under 44`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${label}: width under 44`).toBeGreaterThanOrEqual(44);
}

async function noHScroll(page: Page, label: string) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  console.log(`${label}: scrollWidth=${m.sw} innerWidth=${m.iw}`);
  expect(m.sw, `${label}: horizontal page scroll`).toBeLessThanOrEqual(m.iw);
}

async function axeRail(page: Page, selector: string, label: string) {
  const axe = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(`${label}: axe ${axe.violations.length} violations, ${blocking.length} blocking`, axe.violations.map((v) => `${v.id}/${v.impact}`));
  expect(blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`), `${label}: axe serious/critical`).toEqual([]);
}

async function capture(rail: Locator, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await rail.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function fixturesOf(page: Page): Promise<Fx[]> {
  return ((await apiJson<Fx[]>(page.request, `/api/v1/divisions/${divisionId}/fixtures`)).data ?? []).filter(
    (f) => f.stage_id === swissId,
  );
}

/** Round `round`'s seated boards as "AvB" by SEED, lower seed first, sorted. */
async function roundPairs(page: Page, round: number): Promise<string[]> {
  return (await fixturesOf(page))
    .filter((f) => f.round_no === round && f.home_entrant_id && f.away_entrant_id)
    .map((f) => [seedOf.get(f.home_entrant_id!)!, seedOf.get(f.away_entrant_id!)!].sort((a, b) => a - b).join("v"))
    .sort((a, b) => Number(a.split("v")[0]) - Number(b.split("v")[0]));
}

/** Load the fixtures tab at `width` and return the rail's box — the phone
 *  sheet below `md` (opened, AGENTS rule 22), the inline rail above it. */
async function openRail(page: Page, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  const trigger = page.getByTestId("stage-rail-trigger");
  if (await trigger.isVisible()) {
    await trigger.click();
    await expect(page.getByTestId("stage-rail-sheet")).toBeVisible();
    return page.getByTestId("stage-rail-sheet");
  }
  await expect(page.getByTestId("stage-rail")).toBeVisible();
  return page.getByTestId("stage-rail");
}

const railSelector = (width: number) => (width < 768 ? '[data-testid="stage-rail-sheet"]' : '[data-testid="stage-rail"]');

test("setup: a Hammes Swiss stage, ten entrants seeded 1..10, shells minted", async ({ request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Swiss pairing ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Swiss pairing ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  divisionId = div.data!.id;
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3, pairing: "rank_adjacent" },
  });
  expect(stage.status).toBe(201);
  swissId = stage.data!.id;
  const { ids } = await addEntrantsViaApi(request, divisionId, Array.from({ length: N }, (_, i) => `Seed ${i + 1} ${TAG}`));
  expect(ids).toHaveLength(N);
  seedOf = new Map(ids.map((id, i) => [id, i + 1]));
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status).toBe(200);
});

for (const width of WIDTHS) {
  test(`round 1 at ${width}: closed split button, then the menu — options, hints, keyboard, Escape`, async ({ page }, testInfo) => {
    test.skip(divisionId === "", "setup did not run");
    const rail = await openRail(page, width);
    const toggle = page.getByTestId("stage-pairing-toggle");
    const generate = page.getByTestId("stage-generate");
    await expect(generate).toHaveText("Pair next round");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await hitTest(toggle, `${width} toggle`);
    await hitTest(generate, `${width} generate`);
    // One control: the toggle sits flush against Pair next, same height.
    const gb = (await generate.boundingBox())!;
    const tb = (await toggle.boundingBox())!;
    expect(Math.abs(gb.x + gb.width - tb.x), `${width}: toggle not flush with Pair next`).toBeLessThan(2);
    expect(Math.abs(gb.height - tb.height), `${width}: split halves differ in height`).toBeLessThan(1);
    await noHScroll(page, `${width} closed`);
    await capture(rail, testInfo, `task4-closed-${width}.png`);

    await toggle.click();
    const menu = page.getByTestId("stage-pairing-menu");
    await expect(menu).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toHaveAttribute("role", "radiogroup");
    await expect(menu).toHaveAttribute("aria-label", "Round 1 pairing");
    const fold = page.getByTestId("stage-pairing-fold");
    const adjacent = page.getByTestId("stage-pairing-rank_adjacent");
    await expect(fold).toHaveAttribute("aria-checked", "true");
    await expect(fold).toContainText("Top vs bottom (default)");
    await expect(fold).toContainText("1v6, 2v7, 3v8…");
    await expect(adjacent).toContainText("1v2, 3v4, 5v6…");
    await hitTest(fold, `${width} fold radio`);
    await hitTest(adjacent, `${width} adjacent radio`);
    await noHScroll(page, `${width} round-1 menu`);
    await axeRail(page, railSelector(width), `${width} round-1 menu`);
    await capture(rail, testInfo, `task4-round1-menu-${width}.png`);

    // Arrows move AND select (wrapping); Escape closes the menu only and
    // hands focus back to the toggle.
    await fold.focus();
    await page.keyboard.press("ArrowDown");
    await expect(adjacent).toHaveAttribute("aria-checked", "true");
    await expect(adjacent).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(fold).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(rail, `${width}: Escape in the menu closed the rail around it`).toBeVisible();
    await expect(toggle).toBeFocused();
  });
}

test("the pick reaches the server: Neighbours sends {pairing}, a default press sends {}", async ({ page }) => {
  test.skip(divisionId === "", "setup did not run");
  await openRail(page, 1280);
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(`/stages/${swissId}/generate`)) bodies.push(r.postData() ?? "");
  });
  await page.getByTestId("stage-pairing-toggle").click();
  await page.getByTestId("stage-pairing-rank_adjacent").click();
  await page.getByTestId("stage-generate").click();
  await expect.poll(() => roundPairs(page, 1), { timeout: 20_000 }).toEqual(["1v2", "3v4", "5v6", "7v8", "9v10"]);
  expect(bodies).toEqual(['{"pairing":"rank_adjacent"}']);
  // The press reset the selection and closed the menu.
  await expect(page.getByTestId("stage-pairing-menu")).toHaveCount(0);

  // Unpair, then a plain press: `{}` on the wire, top-vs-bottom in the DB.
  await page.getByTestId("stage-unpair").click();
  await expect.poll(async () => (await roundPairs(page, 1)).length, { timeout: 20_000 }).toBe(0);
  await expect(page.getByTestId("stage-generate")).toHaveText("Pair next round");
  await page.getByTestId("stage-generate").click();
  await expect.poll(() => roundPairs(page, 1), { timeout: 20_000 }).toEqual(["1v6", "2v7", "3v8", "4v9", "5v10"]);
  expect(bodies).toEqual(['{"pairing":"rank_adjacent"}', "{}"]);

  // Decide round 1 so round 2 is the one waiting.
  for (const f of await fixturesOf(page)) {
    if (f.round_no !== 1 || !f.home_entrant_id || !f.away_entrant_id) continue;
    const st = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${f.id}/state`);
    const res = await apiJson(page.request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    expect(res.status, `score fixture ${f.id}`).toBeLessThan(300);
  }
});

for (const width of WIDTHS) {
  test(`round 2 at ${width}: the menu opens read-only with the reason`, async ({ page }, testInfo) => {
    test.skip(divisionId === "", "setup did not run");
    const rail = await openRail(page, width);
    const toggle = page.getByTestId("stage-pairing-toggle");
    await expect(page.getByTestId("stage-generate")).toHaveText("Pair next round");
    await hitTest(toggle, `${width} round-2 toggle`);
    await toggle.click();
    const menu = page.getByTestId("stage-pairing-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-label", "Round 2 pairing");
    await expect(menu).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("stage-pairing-readonly")).toContainText("Neighbours on the table (1st v 2nd, 3rd v 4th…)");
    await expect(page.getByTestId("stage-pairing-hint")).toHaveText("Mode is chosen in round 1 only.");
    await expect(menu.locator('[role="radio"][aria-checked="false"]')).toHaveCount(0);
    await noHScroll(page, `${width} round-2 menu`);
    await axeRail(page, railSelector(width), `${width} round-2 menu`);
    await capture(rail, testInfo, `task4-round2-readonly-${width}.png`);
  });
}
