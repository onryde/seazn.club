// ONE organiser running a Swiss Knockout — the format whose Swiss stage is
// stored as Neighbours (rank-adjacent, "Hammes") — from the moment the round-1
// shells exist to round 2 paired off the table. The question the organiser put
// was the round-1 pairing: with no results yet the only rank is the seed, so
// "neighbours" meant seed 1 v seed 2, and the strongest two met in round one.
// Round 1 now defaults to top-vs-bottom, and the desk's split button lets the
// organiser pick Neighbours for that one press.
//
// ── WHAT IS A REACH AND WHAT IS THE TEST (this folder's README rule) ───────
// REACH, over the API: the competition, the division, the two stages exactly
// as the Swiss Knockout template ships them, eight entrants seeded 1..8, Start
// (which mints every round's empty shells), and round 1's RESULTS — a result
// is not what this file is about.
// THE TEST, in the browser: the split button closed and open at 320/768/1280,
// the menu's keyboard, Pair next with no pick, Unpair, the ▾ → Neighbours pick,
// Pair next again, Unpair and a plain Pair next (the pick must not come back),
// the round-2 menu read-only, and Pair next for round 2 — each press read back
// from the wire AND from the fixtures the server wrote.
//
// ── WHERE THE NUMBERS COME FROM ───────────────────────────────────────────
// Never a typed table (AGENTS.md 19). Round-1 pairs come from `roundOnePairs`,
// which computes them with the engine's own `pairRound`; round-2 pairs come
// from `pairRound` again, fed the standings the server itself serves; every
// sentence comes from the dictionary the page renders. Fold and Neighbours
// differ at every step, and each test asserts that they do before relying on
// it — a check both modes pass would witness nothing.
//
// This file began as Task 4's capture spec (`zz-task4-capture.spec.ts`). Its
// request-body check is still the only test that proves the pick reaches the
// POST — the unit suite renders the rail and cannot press it.
import { test, expect, type Page, type Locator, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG, apiJson, addEntrantsViaApi, divisionPath, expectNoHorizontalScroll } from "../helpers";
import { pairRound, pairKey, type SwissStanding } from "@seazn/engine/scheduling/swiss";
import type { EntrantId } from "@seazn/engine/core";
// Pure, client-safe leaves (the swiss ones are guarded against the server-only
// scheduling barrel by their own unit test), so they load under Playwright.
import { roundOnePairs, type SwissPairingMode } from "@/lib/swiss-pairing";
import { SWISS_PAIRING_HINT_PAIRS } from "@/lib/swiss-pairing-menu";
import { swissRoundsForFieldSize } from "@/lib/swiss-rounds";

// Every step after the setup reads the state the step before it left.
test.describe.configure({ mode: "serial" });

/** The product's own words, from the dictionaries it renders — never retyped,
 *  so a copy change moves the assertion with it (Task 4 review M6), and the
 *  French legs prove the menu is translated rather than hard-coded (M4). */
const dictionary = (locale: "en" | "fr") =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
const EN = dictionary("en");
const FR = dictionary("fr");
type Dict = typeof EN;

/** `{name}` placeholders, filled the way `useMsg` fills them. */
const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
const say = (dict: Dict, key: string, vars: Record<string, string | number> = {}): string => {
  const template = dict[key];
  expect(template, `dictionary has no "${key}"`).toBeDefined();
  return fill(template!, vars);
};

const WIDTHS = [320, 768, 1280] as const;
/** Eight: fold (1v5…) and Neighbours (1v2…) disagree on every board, and the
 *  hint has more pairs than it prints, so its trailing "…" is exercised. */
const N = 8;
/** What the Swiss Knockout picker stamps on the Swiss stage for this field. */
const ROUNDS = swissRoundsForFieldSize(N);
/** Top half qualifies. The knockout exists so the desk carries TWO stage cards,
 *  each with a rail — the shape the organiser actually has. */
const QUALIFY = N / 2;
const SWISS_NAME = "Swiss";

/** A page load, or a poll of the server's own record. */
const STEP_MS = 20_000;
/** A click, a keyboard press, a local assertion: a fraction of a page load. */
const REACH_MS = STEP_MS / 4;
/** A Pair next / Unpair round trip regenerates the stage server-side. */
const GENERATE_MS = 20_000;
/** Each budget is DERIVED from the journey its test performs (AGENTS.md 20): a
 *  blown flat budget reports as whichever assertion was in flight — i.e. as a
 *  data defect. Each test passes the counts it actually performs. */
const budgetFor = (navs: number, acts: number, generates: number): number =>
  Math.max(60_000, navs * STEP_MS + acts * REACH_MS + generates * GENERATE_MS);

type Fx = {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string } | null;
};

let divisionId = "";
let swissId = "";
/** Entrant id → seed, as READ BACK from the server — see the setup's proof. */
let seedOf = new Map<string, number>();

async function hitTest(loc: Locator, label: string) {
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  expect(box, `${label}: no box`).not.toBeNull();
  // Paint is not reach (AGENTS.md 2): the control must be what a tap at its
  // centre actually lands on.
  const hit = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, `${label}: elementFromPoint at centre is not the control`).toBe(true);
  expect(box!.height, `${label}: height under 44`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${label}: width under 44`).toBeGreaterThanOrEqual(44);
}

async function noHScroll(page: Page, label: string) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `${label}: horizontal page scroll`).toBeLessThanOrEqual(m.iw);
}

async function axeRail(page: Page, width: number, label: string) {
  // Both stage cards' rails: the knockout's is the same markup, and a closed
  // phone sheet is `hidden`, which axe skips.
  const selector = width < 768 ? '[data-testid="stage-rail-sheet"]' : '[data-testid="stage-rail"]';
  const axe = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa"]).analyze();
  const blocking = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`), `${label}: axe serious/critical`).toEqual([]);
}

async function capture(rail: Locator, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await rail.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function fixturesOf(page: Page): Promise<Fx[]> {
  const res = await apiJson<Fx[]>(page.request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, `GET /divisions/${divisionId}/fixtures`).toBe(200);
  return (res.data ?? []).filter((f) => f.stage_id === swissId);
}

const seated = (f: Fx) => f.home_entrant_id !== null && f.away_entrant_id !== null;

/** "AvB" by SEED, lower seed first, boards sorted by their lower seed. */
const bySeed = (pairs: ReadonlyArray<readonly [number, number]>): string[] =>
  pairs
    .map(([a, b]) => (a < b ? [a, b] : [b, a]))
    .sort((x, y) => x[0]! - y[0]!)
    .map(([a, b]) => `${a}v${b}`);

/** Round `round`'s seated boards, as the server wrote them, by seed. */
async function roundPairs(page: Page, round: number): Promise<string[]> {
  return bySeed(
    (await fixturesOf(page))
      .filter((f) => f.round_no === round && seated(f))
      .map((f) => [seedOf.get(f.home_entrant_id!)!, seedOf.get(f.away_entrant_id!)!] as const),
  );
}

/** Round 1 as the product promises it for this field and mode. */
const roundOne = (mode: SwissPairingMode): string[] => bySeed(roundOnePairs(N, mode));

/** The hint under one option, built from the derivation the hint promises
 *  (`roundOnePairs`) and the dictionary's own pair template. The ", " joiner
 *  and the trailing "…" are code, not copy — they are in no dictionary. */
function hint(dict: Dict, mode: SwissPairingMode): string {
  const pairs = roundOnePairs(N, mode);
  const shown = pairs
    .slice(0, SWISS_PAIRING_HINT_PAIRS)
    .map(([a, b]) => say(dict, "schedule.pairing.pair", { a, b }))
    .join(", ");
  return pairs.length > SWISS_PAIRING_HINT_PAIRS ? `${shown}…` : shown;
}

/** The Swiss stage's card. The knockout is a second card with a rail of its
 *  own, so every control is found INSIDE this one. */
const swissCard = (page: Page): Locator =>
  page
    .locator("section.card")
    .filter({ has: page.getByRole("heading", { level: 3, name: `1. ${SWISS_NAME}`, exact: true }) });

/** Load the fixtures tab at `width` and return the Swiss rail's box — the phone
 *  sheet below `md` (opened only when its trigger shows, AGENTS.md 22), the
 *  inline rail above it. */
async function openRail(page: Page, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  const card = swissCard(page);
  await expect(card, "the Swiss stage card is not on the fixtures tab").toHaveCount(1, { timeout: STEP_MS });
  const trigger = card.getByTestId("stage-rail-trigger");
  if (await trigger.isVisible()) {
    await trigger.click();
    const sheet = card.getByTestId("stage-rail-sheet");
    await expect(sheet).toBeVisible();
    return sheet;
  }
  const rail = card.getByTestId("stage-rail");
  await expect(rail).toBeVisible({ timeout: STEP_MS });
  return rail;
}

/**
 * Tap ▾ and return the menu once it is the one for `round`. Right after a Pair
 * next or an Unpair the database is ahead of the page: a menu opened before the
 * page takes the press in is stamped with the OLD round, and the refresh that
 * moves the stage on closes it (the rail's round stamp, by design). So the ▾ is
 * re-tapped only while the menu is closed, until the menu names `round`.
 */
async function openMenuFor(card: Locator, round: number): Promise<Locator> {
  const menu = card.getByTestId("stage-pairing-menu");
  await expect(async () => {
    if ((await menu.count()) === 0) await card.getByTestId("stage-pairing-toggle").click();
    await expect(menu).toHaveAttribute("aria-label", say(EN, "schedule.pairing.groupLabel", { round }), {
      timeout: REACH_MS / 2,
    });
  }).toPass({ timeout: STEP_MS });
  return menu;
}

/** Every generate POST the page sends for the Swiss stage, body verbatim. */
function recordPairPresses(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes(`/stages/${swissId}/generate`)) bodies.push(r.postData() ?? "");
  });
  return bodies;
}

test("setup: a Swiss Knockout, eight entrants seeded 1..8, round-1 shells minted", async ({ request }) => {
  // 7 API writes and reads; Start mints the shells.
  test.setTimeout(budgetFor(0, 7, 1));
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Swiss pairing ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, `competition POST → ${JSON.stringify(comp.error)}`).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: `Swiss pairing ${TAG}`,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division POST → ${JSON.stringify(div.error)}`).toBe(201);
  divisionId = div.data!.id;

  // The two stages as the Swiss Knockout template builds them (the same shape
  // `scripts/smoke.ts`'s swissKnockoutSuite POSTs): a Neighbours Swiss with the
  // picker's rounds, then a knockout fed by the top of its table.
  const stages = await apiJson(request, `/api/v1/divisions/${divisionId}/stages`, "POST", [
    { seq: 1, kind: "swiss", name: SWISS_NAME, config: { pairing: "rank_adjacent", rounds: ROUNDS }, progression: null },
    {
      seq: 2,
      kind: "knockout",
      name: "Knockout",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: QUALIFY }] }],
        placement: "rank_order",
        timing: "setup",
      },
    },
  ]);
  expect(stages.status, `stages POST → ${JSON.stringify(stages.error)}`).toBe(201);
  const listed = await apiJson<{ id: string; seq: number; kind: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
  );
  swissId = listed.data!.find((s) => s.seq === 1 && s.kind === "swiss")!.id;

  const added = await addEntrantsViaApi(
    request,
    divisionId,
    Array.from({ length: N }, (_, i) => `Seed ${i + 1} ${TAG}`),
  );
  expect(added.status).toBe(201);
  expect(added.ids).toHaveLength(N);

  // The seed map is READ BACK, not assumed from the POST order, and it must be
  // exactly 1..N one each: `roundOnePairs` speaks in seed POSITIONS, which are
  // seeds only then — otherwise every pair assertion below would compare
  // positions to positions and could not fail.
  const field = await apiJson<{ id: string; seed: number | null }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
  );
  const ours = (field.data ?? []).filter((e) => added.ids.includes(e.id));
  expect(
    ours.map((e) => e.seed).sort((a, b) => (a ?? 0) - (b ?? 0)),
    "the field is not seeded 1..N, one seed each",
  ).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  seedOf = new Map(ours.map((e) => [e.id, e.seed!]));

  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start → ${JSON.stringify(started.error)}`).toBe(200);
  const minted = (await apiJson<Fx[]>(request, `/api/v1/divisions/${divisionId}/fixtures`)).data!.filter(
    (f) => f.stage_id === swissId,
  );
  expect(minted, "Start did not mint every round's shells").toHaveLength(ROUNDS * (N / 2));
  expect(minted.some(seated), "Start seated somebody before Pair next").toBe(false);
});

for (const width of WIDTHS) {
  test(`round 1 at ${width}: the split button, then its menu — options, hints, keyboard, Escape`, async ({
    page,
  }, testInfo) => {
    // Sheet trigger, ▾, four hit-tests, axe, two captures, focus + three keys.
    test.setTimeout(budgetFor(1, 13, 0));
    const rail = await openRail(page, width);
    const card = swissCard(page);
    const toggle = card.getByTestId("stage-pairing-toggle");
    const generate = card.getByTestId("stage-generate");
    await expect(generate).toHaveText(say(EN, "schedule.pairNext"));
    await expect(toggle).toHaveAttribute("aria-label", say(EN, "schedule.pairing.toggle"));
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The split button is the Swiss stage's alone: the knockout card below it
    // has a rail of its own and no ▾.
    await expect(page.getByTestId("stage-pairing-toggle"), "a ▾ on a stage that is not Swiss").toHaveCount(1);
    await hitTest(toggle, `${width} toggle`);
    await hitTest(generate, `${width} generate`);
    // One control: the toggle sits flush against Pair next, same height.
    const gb = (await generate.boundingBox())!;
    const tb = (await toggle.boundingBox())!;
    expect(Math.abs(gb.x + gb.width - tb.x), `${width}: toggle not flush with Pair next`).toBeLessThan(2);
    expect(Math.abs(gb.height - tb.height), `${width}: split halves differ in height`).toBeLessThan(1);
    await noHScroll(page, `${width} closed`);
    await capture(rail, testInfo, `closed-${width}.png`);

    await toggle.click();
    const menu = card.getByTestId("stage-pairing-menu");
    await expect(menu).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toHaveAttribute("role", "radiogroup");
    await expect(menu).toHaveAttribute("aria-label", say(EN, "schedule.pairing.groupLabel", { round: 1 }));
    const fold = card.getByTestId("stage-pairing-fold");
    const adjacent = card.getByTestId("stage-pairing-rank_adjacent");
    // Round 1 defaults to top-vs-bottom although the stage is stored as
    // Neighbours — the whole point of the change.
    await expect(fold).toHaveAttribute("aria-checked", "true");
    await expect(adjacent).toHaveAttribute("aria-checked", "false");
    await expect(fold).toContainText(`${say(EN, "schedule.pairing.fold")} (${say(EN, "schedule.pairing.default")})`);
    await expect(adjacent).toContainText(say(EN, "schedule.pairing.adjacent"));
    await expect(adjacent, "Neighbours is labelled the default in round 1").not.toContainText(
      say(EN, "schedule.pairing.default"),
    );
    // The seed numbers need the page → panel → menu wiring to pass the field
    // size AND the seeds (Task 4 review M3): drop either and the hint goes
    // generic. No unit test can see that seam; this can.
    expect(hint(EN, "fold"), "the two hints agree — neither assertion below could fail alone").not.toBe(
      hint(EN, "rank_adjacent"),
    );
    await expect(fold).toContainText(hint(EN, "fold"));
    await expect(adjacent).toContainText(hint(EN, "rank_adjacent"));
    await hitTest(fold, `${width} fold radio`);
    await hitTest(adjacent, `${width} adjacent radio`);
    await noHScroll(page, `${width} round-1 menu`);
    await axeRail(page, width, `${width} round-1 menu`);
    await capture(rail, testInfo, `round1-menu-${width}.png`);

    // Arrows move AND select (wrapping); Escape closes the menu only — not the
    // phone sheet around it — and hands focus back to the toggle.
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

test("round 1 in French: every line of the menu is the reader's language, none of it English", async ({
  page,
}, testInfo) => {
  // A load to set the cookie on, the rail; sheet trigger, ▾, a capture.
  test.setTimeout(budgetFor(2, 3, 0));
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  await page.context().addCookies([{ name: "seazn_locale", value: "fr", url: new URL(page.url()).origin }]);
  const rail = await openRail(page, 320);
  const card = swissCard(page);
  const toggle = card.getByTestId("stage-pairing-toggle");
  await expect(card.getByTestId("stage-generate")).toHaveText(say(FR, "schedule.pairNext"));
  await expect(toggle).toHaveAttribute("aria-label", say(FR, "schedule.pairing.toggle"));
  await toggle.click();
  const menu = card.getByTestId("stage-pairing-menu");
  await expect(menu).toHaveAttribute("aria-label", say(FR, "schedule.pairing.groupLabel", { round: 1 }));
  const fold = card.getByTestId("stage-pairing-fold");
  const adjacent = card.getByTestId("stage-pairing-rank_adjacent");
  // Positive first: the French is there…
  await expect(fold).toContainText(`${say(FR, "schedule.pairing.fold")} (${say(FR, "schedule.pairing.default")})`);
  await expect(fold).toContainText(hint(FR, "fold"));
  await expect(adjacent).toContainText(say(FR, "schedule.pairing.adjacent"));
  await expect(adjacent).toContainText(hint(FR, "rank_adjacent"));
  // …then the English is not. Each negative first proves the two catalogs
  // differ on it, so none is satisfied by a word the locales share.
  for (const key of ["schedule.pairing.fold", "schedule.pairing.adjacent", "schedule.pairing.default"]) {
    expect(say(FR, key), `"${key}" is identical in fr and en — the negative would witness nothing`).not.toBe(
      say(EN, key),
    );
    await expect(menu, `"${key}" rendered in English on a French page`).not.toContainText(say(EN, key));
  }
  expect(hint(FR, "fold")).not.toBe(hint(EN, "fold"));
  await expect(menu, "the seed pairs rendered with the English template").not.toContainText(hint(EN, "fold"));
  await capture(rail, testInfo, "fr-round1-menu-320.png");
});

test("Pair next, tapped: a plain press pairs top-vs-bottom; Unpair; Neighbours pairs neighbours; the pick never comes back", async ({
  page,
}) => {
  // The rail and one menu wait; the Neighbours tap and eight result writes;
  // four Pair next presses and two Unpairs.
  test.setTimeout(budgetFor(2, 9, 6));
  await openRail(page, 1280);
  const card = swissCard(page);
  const bodies = recordPairPresses(page);
  const generate = card.getByTestId("stage-generate");
  const unpair = card.getByTestId("stage-unpair");
  const fold = roundOne("fold");
  const adjacent = roundOne("rank_adjacent");
  expect(fold, "fold and Neighbours agree for this field — nothing below could tell them apart").not.toEqual(adjacent);

  // 1. No pick: the press sends `{}`, and the SERVER's round-1 default seats
  //    top-vs-bottom on a stage stored as Neighbours.
  await generate.click();
  await expect.poll(() => roundPairs(page, 1), { timeout: GENERATE_MS }).toEqual(fold);
  expect(bodies).toEqual(["{}"]);

  // 2. Unpair, tapped.
  await unpair.click();
  await expect.poll(async () => (await roundPairs(page, 1)).length, { timeout: GENERATE_MS }).toBe(0);
  await expect(generate).toHaveText(say(EN, "schedule.pairNext"));

  // 3. ▾ → Neighbours → Pair next: `{pairing}` on the wire, neighbours in the DB.
  await openMenuFor(card, 1);
  const neighbours = card.getByTestId("stage-pairing-rank_adjacent");
  await neighbours.click();
  await expect(neighbours).toHaveAttribute("aria-checked", "true");
  await generate.click();
  await expect.poll(() => roundPairs(page, 1), { timeout: GENERATE_MS }).toEqual(adjacent);
  expect(bodies).toEqual(["{}", '{"pairing":"rank_adjacent"}']);
  // The press that landed closed the menu.
  await expect(card.getByTestId("stage-pairing-menu")).toHaveCount(0);

  // 4. Unpair, then a plain press. The pick was for ONE press: were it kept,
  //    this press would send Neighbours again.
  await unpair.click();
  await expect.poll(async () => (await roundPairs(page, 1)).length, { timeout: GENERATE_MS }).toBe(0);
  // The DB is ahead of the page: Pair next re-enables when the Unpair POST
  // returns, before the refresh moves the rail back to round 1, and a press
  // that beats the refresh sends `{}` whether or not the pick was kept. So
  // the reset is read off the page itself: once the rail is back on round 1
  // (`openMenuFor` waits for the menu to name it), Top vs bottom must be the
  // checked radio again. A kept pick shows Neighbours checked here.
  const menuAgain = await openMenuFor(card, 1);
  const checked = menuAgain.getByRole("radio", { checked: true });
  await expect(checked, "the Neighbours pick outlived the press that used it").toHaveCount(1);
  await expect(checked).toHaveAttribute("data-testid", "stage-pairing-fold");
  await expect(checked).toContainText(say(EN, "schedule.pairing.fold"));
  await expect(card.getByTestId("stage-pairing-rank_adjacent")).toHaveAttribute("aria-checked", "false");
  const toggle = card.getByTestId("stage-pairing-toggle");
  await toggle.click();
  await expect(card.getByTestId("stage-pairing-menu")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await generate.click();
  await expect.poll(() => roundPairs(page, 1), { timeout: GENERATE_MS }).toEqual(fold);
  expect(bodies).toEqual(["{}", '{"pairing":"rank_adjacent"}', "{}"]);

  // REACH, not test: round 1 is played. The lower seed wins every board, by a
  // margin that shrinks as its seed grows, so the table after one round is not
  // a four-way tie on every criterion.
  for (const f of (await fixturesOf(page)).filter((x) => x.round_no === 1 && seated(x))) {
    const home = seedOf.get(f.home_entrant_id!)!;
    const away = seedOf.get(f.away_entrant_id!)!;
    const margin = N - Math.min(home, away);
    const st = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${f.id}/state`);
    const res = await apiJson(page.request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: home < away ? { p1Score: margin, p2Score: 0 } : { p1Score: 0, p2Score: margin },
    });
    expect(res.status, `score fixture ${f.id} → ${JSON.stringify(res.error)}`).toBeLessThan(300);
  }
});

for (const width of WIDTHS) {
  test(`round 2 at ${width}: the menu opens read-only, naming the stage's mode and why`, async ({
    page,
  }, testInfo) => {
    // Sheet trigger, a hit-test, ▾, axe, a capture.
    test.setTimeout(budgetFor(1, 5, 0));
    const rail = await openRail(page, width);
    const card = swissCard(page);
    const toggle = card.getByTestId("stage-pairing-toggle");
    await expect(card.getByTestId("stage-generate")).toHaveText(say(EN, "schedule.pairNext"));
    // Still tappable in round 2: a disabled control cannot explain itself on a
    // phone, where there is no hover.
    await hitTest(toggle, `${width} round-2 toggle`);
    await toggle.click();
    const menu = card.getByTestId("stage-pairing-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-label", say(EN, "schedule.pairing.groupLabel", { round: 2 }));
    await expect(menu).toHaveAttribute("aria-disabled", "true");
    await expect(card.getByTestId("stage-pairing-readonly")).toContainText(say(EN, "schedule.pairing.laterAdjacent"));
    await expect(card.getByTestId("stage-pairing-hint")).toHaveText(say(EN, "schedule.pairing.roundOneOnly"));
    // Positive pair for the negative below: the read-only line IS the one radio.
    await expect(menu.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1);
    await expect(menu.locator('[role="radio"][aria-checked="false"]'), "a choosable option in round 2").toHaveCount(0);
    await noHScroll(page, `${width} round-2 menu`);
    await axeRail(page, width, `${width} round-2 menu`);
    await capture(rail, testInfo, `round2-readonly-${width}.png`);
  });
}

test("round 2 in French: the read-only line and its reason are translated", async ({ page }) => {
  // A load to set the cookie on, the rail; sheet trigger, ▾.
  test.setTimeout(budgetFor(2, 2, 0));
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  await page.context().addCookies([{ name: "seazn_locale", value: "fr", url: new URL(page.url()).origin }]);
  await openRail(page, 320);
  const card = swissCard(page);
  await card.getByTestId("stage-pairing-toggle").click();
  const menu = card.getByTestId("stage-pairing-menu");
  await expect(menu).toHaveAttribute("aria-label", say(FR, "schedule.pairing.groupLabel", { round: 2 }));
  await expect(card.getByTestId("stage-pairing-readonly")).toContainText(say(FR, "schedule.pairing.laterAdjacent"));
  await expect(card.getByTestId("stage-pairing-hint")).toHaveText(say(FR, "schedule.pairing.roundOneOnly"));
  await expect(menu).not.toContainText(say(EN, "schedule.pairing.laterAdjacent"));
  await expect(menu).not.toContainText(say(EN, "schedule.pairing.roundOneOnly"));
});

test("Pair next, tapped for round 2: the stage's own Neighbours mode pairs off the table — the terminal state", async ({
  page,
}) => {
  // The standings poll, the rail, the round-3 menu wait; three width checks
  // and the fixtures read; one Pair next.
  test.setTimeout(budgetFor(3, 4, 1));
  const round1 = (await fixturesOf(page)).filter((f) => f.round_no === 1 && seated(f));
  expect(round1, "round 1 is not seated").toHaveLength(N / 2);
  expect(
    round1.every((f) => f.outcome?.kind === "win" && !!f.outcome.winner),
    "round 1 is not decided",
  ).toBe(true);

  // The table the server ranks round 2 by, as it SERVES it — polled, because
  // standings fold after each result lands.
  type Row = { entrantId: string; rank?: number; won: number };
  const table = async (): Promise<Row[]> =>
    (await apiJson<{ rows: Row[] }>(page.request, `/api/v1/stages/${swissId}/standings`)).data?.rows ?? [];
  await expect
    .poll(async () => (await table()).reduce((sum, r) => sum + r.won, 0), { timeout: STEP_MS })
    .toBe(N / 2);
  const rows = await table();
  expect(rows).toHaveLength(N);

  // What round 2 should be, from the engine's own pairing over those standings:
  // a point a win (swissGen's scoring), the table's rank, and round 1's boards
  // as the rematches to avoid. Derived for BOTH modes, and they must differ, or
  // this test could not tell the stage's Neighbours from top-vs-bottom.
  const wins = new Map(round1.map((f) => [f.outcome!.winner!, 1]));
  const standings: SwissStanding[] = rows.map((r, i) => ({
    entrantId: r.entrantId as EntrantId,
    score: wins.get(r.entrantId) ?? 0,
    rank: r.rank ?? i + 1,
  }));
  const played = new Set(
    round1.map((f) => pairKey(f.home_entrant_id! as EntrantId, f.away_entrant_id! as EntrantId)),
  );
  const expected = (mode: SwissPairingMode): string[] =>
    bySeed(
      pairRound(standings, { played }, mode === "rank_adjacent" ? { pairing: "rank_adjacent" } : {}).pairings.map(
        (p) => [seedOf.get(p.home)!, seedOf.get(p.away)!] as const,
      ),
    );
  expect(expected("rank_adjacent"), "Neighbours and top-vs-bottom agree on round 2 — the test is blind").not.toEqual(
    expected("fold"),
  );

  await openRail(page, 1280);
  const card = swissCard(page);
  const bodies = recordPairPresses(page);
  await card.getByTestId("stage-generate").click();
  await expect.poll(() => roundPairs(page, 2), { timeout: GENERATE_MS }).toEqual(expected("rank_adjacent"));
  // Nothing to pick in round 2, so nothing is sent: the stage's stored mode
  // decides, not a pick left over from round 1.
  expect(bodies).toEqual(["{}"]);

  // THE TERMINAL STATE, on the live page: round 3 waits, and its menu is
  // read-only too.
  const menu = await openMenuFor(card, 3);
  await expect(menu).toHaveAttribute("aria-disabled", "true");
  await expect(card.getByTestId("stage-pairing-readonly")).toContainText(say(EN, "schedule.pairing.laterAdjacent"));
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalScroll(page);
  }
});
