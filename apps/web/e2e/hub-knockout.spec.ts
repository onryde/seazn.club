import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  scoreFixture,
  expectNoHorizontalScroll,
} from "./helpers";

// The competition hub's Knockout tab in a real browser (plan
// docs/superpowers/plans/2026-09-13-hub-knockout-tab.md, Task 3).
//
// What the unit suite cannot see, and this file exists for: CSS folds (the
// Rounds|Draw switch is `max-lg:hidden`, the tree `hidden lg:block`), a URL
// that a tap writes and a reload reads back, the layout effect that scrolls
// the pressed round chip into its rail, and the tree's real width. Every
// bracket is seeded through the product's own API — results go in as
// `generic.result` events and later rounds fill through the engine's own
// `onDecided`, never by SQL — and every expected round, view id and champion
// is read back out of the PUBLIC hub document the page itself renders from,
// so the test moves with the document rather than asserting a table typed in
// here.
//
// Each assertion that something is SHOWN has its opposite somewhere in this
// file, so none of them passes on an element that is simply always there, or
// never there:
//   switch visible at 1280            ↔ attached-but-hidden at 390/768, absent for double elim
//   tree visible after the Draw tap   ↔ absent in Rounds, attached-but-hidden at 390/768
//   rail opens on the semi-finals     ↔ quarter-finals and final chips not pressed
//   both division headings under All  ↔ one heading after a division chip
//   `mh-tab-knockout` on a knockout   ↔ absent on a league-only competition
//   pressed chip inside the rail      ↔ the same chip is clipped at scrollLeft 0

// ---------------------------------------------------------------------------
// Budget (AGENTS.md 20): derived from what the seeding actually does, so a
// bigger bracket raises the ceiling with it instead of timing out and
// reporting itself as a data defect.
// ---------------------------------------------------------------------------

/** One API round trip against a local production build, with headroom for a
 *  machine other sessions are also loading. */
const API_CALL_MS = 1_500;
/** One navigation or tap plus the web-first assertions that follow it — the
 *  config's own `expect` timeout, because one slow assertion may use all of
 *  it. */
const STEP_MS = 15_000;
const FLOOR_MS = 60_000;
/** A fill poll's own ceiling: a decided match fills the next round's slot
 *  inside the scoring write, so this only waits out a slow response. */
const FILL_POLL_MS = 20_000;

/** How many fixtures to score in each bracket round, in seq order. */
const EIGHT_SCORED = [4, 1] as const; // every quarter-final, one semi-final
const SIXTEEN_SCORED = [8, 4, 2, 1] as const; // the whole draw
const FIRST_DIVISION_SCORED = [2] as const;
const SECOND_DIVISION_SCORED = [1] as const;

/** API calls one knockout division costs: division create + read, entrants,
 *  stage create + generate, start; then per scored round one fixtures read
 *  (a fill poll's first try) and two per score (`scoreFixture` reads the seq
 *  before it posts). */
const divisionCalls = (scored: readonly number[]) =>
  6 + scored.reduce((calls, n) => calls + 1 + 2 * n, 0);
/** Competition create + hub document read, around each competition's divisions. */
const COMPETITION_CALLS = 2;
const SEED_CALLS =
  1 + // the active org's slug
  COMPETITION_CALLS + divisionCalls(EIGHT_SCORED) +
  COMPETITION_CALLS + divisionCalls(SIXTEEN_SCORED) +
  COMPETITION_CALLS + divisionCalls(FIRST_DIVISION_SCORED) + divisionCalls(SECOND_DIVISION_SCORED) +
  COMPETITION_CALLS + divisionCalls([]) + // double elimination, unplayed
  COMPETITION_CALLS + 5; // league: division create + read, entrants, stage create + generate
const SEED_BUDGET_MS = FLOOR_MS + SEED_CALLS * API_CALL_MS;

const budget = (steps: number) => Math.max(FLOOR_MS, steps * STEP_MS);

// ---------------------------------------------------------------------------
// The document's shapes, as far as this file reads them
// (`server/public-site/competition-hub-schema.ts`).
// ---------------------------------------------------------------------------

interface FixtureRow {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  lane?: string | null;
  third_place?: boolean;
}
interface HubRound {
  key: string;
  label: string;
  lane: string | null;
  fixtureIds: string[];
}
interface HubView {
  id: string;
  divisionSlug: string;
  stageId: string;
  kind: string;
  rounds: HubRound[];
  drawable: boolean;
  championFixtureId: string | null;
}
interface HubDoc {
  tabs: string[];
  knockouts: HubView[];
  matches: { fixtureId: string }[];
}
interface Seeded {
  compSlug: string;
  divisionSlugs: string[];
  doc: HubDoc;
}

// ---------------------------------------------------------------------------
// Seeding, through the real API
// ---------------------------------------------------------------------------

async function publicCompetition(request: APIRequestContext, label: string) {
  const res = await apiJson<{ id: string; slug: string; visibility: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    {
      ends_on: "2030-12-31",
      name: `${label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
      visibility: "public",
    },
  );
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  // A create over the public-dashboard cap degrades to private with a 201
  // rather than refusing, and a private competition 404s off /shared/*.
  expect(res.data!.visibility).toBe("public");
  return res.data!;
}

async function genericDivision(request: APIRequestContext, competitionId: string, name: string) {
  const created = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    {
      name,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  const read = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/divisions/${created.data!.id}`,
  );
  expect(read.status).toBe(200);
  return read.data!;
}

async function divisionFixtures(request: APIRequestContext, divisionId: string) {
  const res = await apiJson<FixtureRow[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!;
}

/** A single-elimination stage's rounds in bracket order, each in seq order,
 *  third-place match left out. */
function bracketRounds(rows: readonly FixtureRow[]): FixtureRow[][] {
  const byRound = new Map<number, FixtureRow[]>();
  for (const row of rows) {
    if (row.third_place === true) continue;
    byRound.set(row.round_no, [...(byRound.get(row.round_no) ?? []), row]);
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, round]) => round.sort((a, b) => a.seq_in_round - b.seq_in_round));
}

/**
 * Score the first `scored[r]` fixtures of each round r, home side winning.
 * Round r+1's slots fill from round r's winners, so each round waits until the
 * fixtures it is about to score have both sides.
 */
async function playRounds(
  request: APIRequestContext,
  divisionId: string,
  scored: readonly number[],
) {
  for (const [r, count] of scored.entries()) {
    if (count === 0) continue;
    let targets: FixtureRow[] = [];
    await expect
      .poll(
        async () => {
          const round = bracketRounds(await divisionFixtures(request, divisionId))[r] ?? [];
          targets = round.slice(0, count);
          return (
            targets.length === count &&
            targets.every((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)
          );
        },
        { timeout: FILL_POLL_MS, message: `round ${r} never filled ${count} fixtures` },
      )
      .toBe(true);
    for (const fixture of targets) await scoreFixture(request, fixture.id, 2, 1);
  }
}

async function bracketDivision(
  request: APIRequestContext,
  competitionId: string,
  name: string,
  size: number,
  kind: "knockout" | "double_elim",
  scored: readonly number[],
) {
  const division = await genericDivision(request, competitionId, name);
  const names = Array.from({ length: size }, (_, i) => `${name} ${String(i + 1).padStart(2, "0")}`);
  const added = await addEntrantsViaApi(request, division.id, names);
  expect(added.ids).toHaveLength(size);
  const { fixtureIds } = await createStageAndGenerate(request, division.id, { kind, name: "Cup" });
  expect(fixtureIds.length).toBeGreaterThan(0);
  const started = await apiJson(request, `/api/v1/divisions/${division.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  await playRounds(request, division.id, scored);
  return division;
}

async function hubDoc(request: APIRequestContext, orgSlug: string, compSlug: string) {
  const res = await apiJson<HubDoc>(
    request,
    `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/hub`,
  );
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!;
}

async function activeOrgSlug(request: APIRequestContext) {
  const orgs = await apiJson<{ id: string; slug: string }[]>(request, "/api/orgs");
  const active = (await request.storageState()).cookies.find((c) => c.name === "seazn_org")?.value;
  const org = orgs.data?.find((o) => o.id === active) ?? orgs.data?.[0];
  if (!org) throw new Error("no org for the e2e session");
  return org.slug;
}

// ---------------------------------------------------------------------------
// Page handles
// ---------------------------------------------------------------------------

const hubUrl = (orgSlug: string, seeded: Seeded, query: string) =>
  `/shared/${orgSlug}/${seeded.compSlug}${query}`;

const roundChip = (page: Page, view: HubView, round: HubRound) =>
  page.getByTestId(`mh-knockout-round-${view.id}-${round.key}`);

/** The panel mounts only after the client has read `?tab=` — the first paint
 *  is the document's first tab — so every visit waits for it. */
async function openKnockout(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("mh-knockout")).toBeVisible();
  await expect(page.getByTestId("mh-tab-panel-knockout")).toBeVisible();
}

/** A rail's pressed and first chips, relative to the rail's own visible box. */
function railGeometry(rail: Locator) {
  return rail.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const relative = (chip: Element | null) => {
      if (chip === null) return null;
      const r = chip.getBoundingClientRect();
      return { left: r.left - box.left, right: r.right - box.left };
    };
    return {
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      pressed: relative(el.querySelector('[aria-pressed="true"]')),
      first: relative(el.querySelector("button")),
    };
  });
}
type RailGeometry = Awaited<ReturnType<typeof railGeometry>>;
const insideRail = (g: RailGeometry, chip: { left: number; right: number } | null) =>
  chip !== null && chip.left >= -0.5 && chip.right <= g.clientWidth + 0.5;

// ---------------------------------------------------------------------------

test.describe("competition hub: Knockout tab", () => {
  // One seeding for the whole file, so the tests run in order in one worker —
  // but NOT serial: a red here must not skip the tests after it (AGENTS.md
  // 21). A failure restarts the worker, which seeds again.
  test.describe.configure({ mode: "default" });

  let orgSlug = "";
  let eight: Seeded;
  let sixteen: Seeded;
  let twoDivisions: Seeded;
  let doubleElim: Seeded;
  let leagueOnly: Seeded;

  test.beforeAll(async ({ playwright }, testInfo) => {
    // A hook has its own clock; the test's `setTimeout` does not reach it.
    testInfo.setTimeout(SEED_BUDGET_MS);
    const request = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: testInfo.project.use.storageState,
    });
    try {
      orgSlug = await activeOrgSlug(request);

      {
        const comp = await publicCompetition(request, "Hub KO Eight");
        const div = await bracketDivision(request, comp.id, "Cup", 8, "knockout", EIGHT_SCORED);
        eight = { compSlug: comp.slug, divisionSlugs: [div.slug], doc: await hubDoc(request, orgSlug, comp.slug) };
      }
      {
        const comp = await publicCompetition(request, "Hub KO Sixteen");
        const div = await bracketDivision(request, comp.id, "Open", 16, "knockout", SIXTEEN_SCORED);
        sixteen = { compSlug: comp.slug, divisionSlugs: [div.slug], doc: await hubDoc(request, orgSlug, comp.slug) };
      }
      {
        const comp = await publicCompetition(request, "Hub KO Two");
        const a = await bracketDivision(request, comp.id, "Mens Cup", 4, "knockout", FIRST_DIVISION_SCORED);
        const b = await bracketDivision(request, comp.id, "Womens Cup", 4, "knockout", SECOND_DIVISION_SCORED);
        twoDivisions = {
          compSlug: comp.slug,
          divisionSlugs: [a.slug, b.slug],
          doc: await hubDoc(request, orgSlug, comp.slug),
        };
      }
      {
        const comp = await publicCompetition(request, "Hub KO Double");
        const div = await bracketDivision(request, comp.id, "Double", 4, "double_elim", []);
        doubleElim = { compSlug: comp.slug, divisionSlugs: [div.slug], doc: await hubDoc(request, orgSlug, comp.slug) };
      }
      {
        const comp = await publicCompetition(request, "Hub League Only");
        const div = await genericDivision(request, comp.id, "League");
        const added = await addEntrantsViaApi(request, div.id, ["L1", "L2", "L3", "L4"]);
        expect(added.ids).toHaveLength(4);
        const { fixtureIds } = await createStageAndGenerate(request, div.id);
        expect(fixtureIds.length).toBeGreaterThan(0);
        leagueOnly = { compSlug: comp.slug, divisionSlugs: [div.slug], doc: await hubDoc(request, orgSlug, comp.slug) };
      }
    } finally {
      await request.dispose();
    }

    // The documents the page will render, checked BEFORE any test leans on
    // them — a wrong seed must fail here, by name, not as a missing chip.
    const [eightView] = eight.doc.knockouts;
    expect(eight.doc.knockouts).toHaveLength(1);
    expect(eight.doc.tabs).toContain("knockout");
    expect(eightView!.id.startsWith(`${eight.divisionSlugs[0]}-`)).toBe(true);
    expect(eightView!.rounds.map((r) => r.fixtureIds.length)).toEqual([4, 2, 1]);
    expect(eightView!.drawable).toBe(true);
    expect(eightView!.championFixtureId).toBeNull();

    const [sixteenView] = sixteen.doc.knockouts;
    expect(sixteenView!.rounds.map((r) => r.fixtureIds.length)).toEqual([8, 4, 2, 1]);
    expect(sixteenView!.championFixtureId).toBe(sixteenView!.rounds[3]!.fixtureIds[0]);

    expect(twoDivisions.doc.knockouts.map((v) => v.divisionSlug)).toEqual(twoDivisions.divisionSlugs);

    expect(doubleElim.doc.knockouts).toHaveLength(1);
    expect(doubleElim.doc.knockouts[0]!.kind).toBe("double_elim");
    expect(doubleElim.doc.knockouts[0]!.drawable).toBe(false);

    expect(leagueOnly.doc.knockouts).toHaveLength(0);
    expect(leagueOnly.doc.tabs).not.toContain("knockout");
  });

  test("an 8-draw mid-event at 1280: opens on the first unfinished round; Draw writes view=draw, shows the tree, survives a reload", async ({
    page,
  }) => {
    test.setTimeout(budget(4));
    await page.setViewportSize({ width: 1280, height: 800 });
    const view = eight.doc.knockouts[0]!;
    const [quarters, semis, final] = view.rounds as [HubRound, HubRound, HubRound];

    await openKnockout(page, hubUrl(orgSlug, eight, "?tab=knockout"));
    await expect(page.getByTestId("mh-tab-knockout")).toBeVisible();

    // Every quarter-final is decided and one semi-final is: the rail opens on
    // the semi-finals — neither the first round nor the last.
    await expect(roundChip(page, view, semis)).toHaveAttribute("aria-pressed", "true");
    await expect(roundChip(page, view, quarters)).toHaveAttribute("aria-pressed", "false");
    await expect(roundChip(page, view, final)).toHaveAttribute("aria-pressed", "false");

    // That round's cards, and only that round's.
    const rounds = page.getByTestId(`mh-knockout-rounds-${view.id}`);
    await expect(rounds).toBeVisible();
    for (const id of semis.fixtureIds) await expect(rounds.getByTestId(`mh-match-${id}`)).toBeVisible();
    for (const id of [...quarters.fixtureIds, ...final.fixtureIds]) {
      await expect(page.getByTestId(`mh-match-${id}`)).toHaveCount(0);
    }
    // The decided semi's winner goes through; its undecided partner's winner
    // meets them — both naming the round after it, from the document.
    await expect(page.getByTestId(`mh-knockout-next-${semis.fixtureIds[0]}`)).toContainText(
      `goes through to the ${final.label}`,
    );
    await expect(page.getByTestId(`mh-knockout-next-${semis.fixtureIds[1]}`)).toContainText(
      `Winner meets `,
    );

    // Rounds is the default: no tree in the DOM at all.
    const tree = page.getByTestId(`mh-knockout-draw-${view.id}`);
    await expect(tree).toHaveCount(0);

    const drawChip = page.getByTestId("mh-knockout-view-draw");
    const roundsChip = page.getByTestId("mh-knockout-view-rounds");
    await expect(page.getByTestId("mh-knockout-view")).toBeVisible();
    await expect(roundsChip).toHaveAttribute("aria-pressed", "true");

    await drawChip.click();
    await expect(drawChip).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/[?&]view=draw(&|$)/);
    await expect(page).toHaveURL(/[?&]tab=knockout(&|$)/);
    await expect(tree).toBeVisible();
    await expect(rounds).toBeHidden();
    const finalColumn = page.getByTestId(`mh-knockout-col-${view.id}-${final.key}`);
    await expect(finalColumn).toBeVisible();
    await expect(finalColumn).toContainText(final.label);
    for (const round of view.rounds) {
      for (const id of round.fixtureIds) await expect(page.getByTestId(`mh-knockout-node-${id}`)).toBeVisible();
    }

    // An 8-draw fits: nothing to scroll inside the tree's region, nor on the page.
    const region = page.getByTestId(`mh-knockout-draw-region-${view.id}`);
    const fit = await region.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(fit.clientWidth).toBeGreaterThan(0);
    expect(fit.scrollWidth, JSON.stringify(fit)).toBeLessThanOrEqual(fit.clientWidth);
    await expectNoHorizontalScroll(page);

    // The URL is the state: a reload opens on the Draw.
    await page.reload();
    await expect(page.getByTestId("mh-knockout")).toBeVisible();
    await expect(tree).toBeVisible();
    await expect(drawChip).toHaveAttribute("aria-pressed", "true");

    // And Rounds takes the parameter out again.
    await roundsChip.click();
    await expect(roundsChip).toHaveAttribute("aria-pressed", "true");
    await expect(page).not.toHaveURL(/[?&]view=/);
    await expect(rounds).toBeVisible();
    await expect(tree).toHaveCount(0);
  });

  test("an 8-draw at 390 and 768: no switch and no tree even with view=draw, Rounds shown, no page scroll", async ({
    page,
  }) => {
    test.setTimeout(budget(2));
    const view = eight.doc.knockouts[0]!;
    const semis = view.rounds[1]!;
    for (const width of [390, 768]) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await openKnockout(page, hubUrl(orgSlug, eight, "?tab=knockout&view=draw"));
        // In the DOM — the bracket IS drawable — and folded away by CSS: the
        // negative of the 1280 test, not an element that never rendered.
        await expect(page.getByTestId("mh-knockout-view")).toBeAttached();
        await expect(page.getByTestId("mh-knockout-view")).toBeHidden();
        const tree = page.getByTestId(`mh-knockout-draw-${view.id}`);
        await expect(tree).toBeAttached();
        await expect(tree).toBeHidden();
        await expect(page.getByTestId(`mh-knockout-rounds-${view.id}`)).toBeVisible();
        await expect(roundChip(page, view, semis)).toHaveAttribute("aria-pressed", "true");
        for (const id of semis.fixtureIds) await expect(page.getByTestId(`mh-match-${id}`)).toBeVisible();
        await expectNoHorizontalScroll(page);
      });
    }
  });

  test("a finished 16-draw at 390: opens on the Final under the champion, with the pressed chip scrolled into its rail", async ({
    page,
  }) => {
    test.setTimeout(budget(3));
    await page.setViewportSize({ width: 390, height: 844 });
    const view = sixteen.doc.knockouts[0]!;
    const first = view.rounds[0]!;
    const final = view.rounds[view.rounds.length - 1]!;

    await openKnockout(page, hubUrl(orgSlug, sixteen, "?tab=knockout"));
    await expect(page.getByTestId(`mh-knockout-champion-${view.id}`)).toBeVisible();
    await expect(roundChip(page, view, final)).toHaveAttribute("aria-pressed", "true");
    await expect(roundChip(page, view, first)).toHaveAttribute("aria-pressed", "false");

    const rail = page.getByTestId(`mh-knockout-rail-${view.id}`);
    // Non-vacuous: the rail really overflows, and the Final chip sits past its
    // right edge when the rail is at rest — so seeing it means it was moved.
    let geometry = await railGeometry(rail);
    expect(geometry.scrollWidth, JSON.stringify(geometry)).toBeGreaterThan(geometry.clientWidth);
    expect(geometry.pressed!.right + geometry.scrollLeft, JSON.stringify(geometry)).toBeGreaterThan(
      geometry.clientWidth,
    );
    await expect
      .poll(async () => {
        geometry = await railGeometry(rail);
        return geometry.scrollLeft > 0 && insideRail(geometry, geometry.pressed);
      })
      .toBe(true);
    await expectNoHorizontalScroll(page);

    // On CHANGE too. The first chip is now clipped on the left; a DISPATCHED
    // click presses it without Playwright scrolling it into view first, so
    // only the tab's own effect can bring it back.
    geometry = await railGeometry(rail);
    expect(insideRail(geometry, geometry.first), JSON.stringify(geometry)).toBe(false);
    await roundChip(page, view, first).dispatchEvent("click");
    await expect(roundChip(page, view, first)).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => {
        const g = await railGeometry(rail);
        return insideRail(g, g.first) && g.scrollLeft < geometry.scrollLeft;
      })
      .toBe(true);
    for (const id of first.fixtureIds) await expect(page.getByTestId(`mh-match-${id}`)).toBeVisible();
  });

  test("two knockout divisions: All shows both; a division chip shows one and writes division=; a division= link opens on it", async ({
    page,
  }) => {
    test.setTimeout(budget(4));
    await page.setViewportSize({ width: 1280, height: 800 });
    const [a, b] = twoDivisions.divisionSlugs as [string, string];
    const headings = page.locator('[data-testid^="mh-knockout-heading-"]');
    const allChip = page.getByTestId("mh-knockout-division-all");

    await openKnockout(page, hubUrl(orgSlug, twoDivisions, "?tab=knockout"));
    await expect(allChip).toHaveAttribute("aria-pressed", "true");
    await expect(headings).toHaveCount(2);
    await expect(page.getByTestId(`mh-knockout-heading-${a}`)).toBeVisible();
    await expect(page.getByTestId(`mh-knockout-heading-${b}`)).toBeVisible();

    await page.getByTestId(`mh-knockout-division-${b}`).click();
    await expect(page.getByTestId(`mh-knockout-division-${b}`)).toHaveAttribute("aria-pressed", "true");
    await expect(allChip).toHaveAttribute("aria-pressed", "false");
    await expect(page).toHaveURL(new RegExp(`[?&]division=${b}(&|$)`));
    await expect(headings).toHaveCount(1);
    await expect(page.getByTestId(`mh-knockout-heading-${b}`)).toBeVisible();
    await expect(page.getByTestId(`mh-knockout-heading-${a}`)).toHaveCount(0);

    await allChip.click();
    await expect(allChip).toHaveAttribute("aria-pressed", "true");
    await expect(page).not.toHaveURL(/[?&]division=/);
    await expect(headings).toHaveCount(2);

    // The link a division page will one day redirect to.
    await openKnockout(page, hubUrl(orgSlug, twoDivisions, `?tab=knockout&division=${a}`));
    await expect(page.getByTestId(`mh-knockout-division-${a}`)).toHaveAttribute("aria-pressed", "true");
    await expect(headings).toHaveCount(1);
    await expect(page.getByTestId(`mh-knockout-heading-${a}`)).toBeVisible();
  });

  test("a double-elimination bracket at 1280: no Draw switch and no tree, even with view=draw", async ({ page }) => {
    test.setTimeout(budget(1));
    await page.setViewportSize({ width: 1280, height: 800 });
    const view = doubleElim.doc.knockouts[0]!;
    await openKnockout(page, hubUrl(orgSlug, doubleElim, "?tab=knockout&view=draw"));
    await expect(page.getByTestId(`mh-knockout-rounds-${view.id}`)).toBeVisible();
    await expect(page.getByTestId(`mh-knockout-rail-${view.id}`)).toBeVisible();
    await expect(page.getByTestId("mh-knockout-view")).toHaveCount(0);
    await expect(page.getByTestId(`mh-knockout-draw-${view.id}`)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test("a league-only competition has no Knockout tab, and a knockout link falls back", async ({ page }) => {
    test.setTimeout(budget(2));
    await page.setViewportSize({ width: 1280, height: 800 });
    const firstTab = leagueOnly.doc.tabs[0]!;

    await page.goto(hubUrl(orgSlug, leagueOnly, ""));
    await expect(page.getByTestId(`mh-tab-${firstTab}`)).toBeVisible();
    await expect(page.getByTestId("mh-tab-knockout")).toHaveCount(0);

    await page.goto(hubUrl(orgSlug, leagueOnly, "?tab=knockout"));
    await expect(page.getByTestId(`mh-tab-panel-${firstTab}`)).toBeVisible();
    await expect(page.getByTestId("mh-tab-knockout")).toHaveCount(0);
    await expect(page.getByTestId("mh-knockout")).toHaveCount(0);
  });
});
