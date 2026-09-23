import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
  expectNoHorizontalScroll,
  seedVenueWithCourts,
} from "./helpers";

// Schedule-board knockout round codes (2026-09-23): a knockout card's chip
// reads its round ROLE ("QF", "SF", "F", "3rd") instead of the generic
// "R{n}", an empty seat's placeholder reads "Winner of QF·1", and a compact
// legend row names every code in view. The unit suites prove the builder and
// the components; this file proves the SEAM — the server read carrying
// `third_place`/`lane` all the way to a rendered chip on the real page,
// through BOTH mounts a desktop organiser sees (the grid and the tray), and
// the legend wrapping at 320px without a horizontal scroll.
//
// Every expected string comes from the English dictionary itself (e2e cannot
// import the JSON-backed src modules — read off disk instead), so a copy
// change moves this file with it.
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const fill = (key: string, vars: Record<string, string | number> = {}): string => {
  const template = UI_EN[key];
  if (template === undefined) throw new Error(`no en dictionary key ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
};

interface ListedFixture {
  id: string;
  round_no: number;
  seq_in_round: number;
  third_place: boolean;
}

const START = new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString();
/** An instant on the seeded day, `minutes` after START. */
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();

async function createCompetition(request: APIRequestContext): Promise<string> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Round Codes ${TAG}`,
    visibility: "private",
  });
  expect(comp.data?.id, `competition create → ${comp.status}`).toBeTruthy();
  return comp.data!.id;
}

/** One division of `names.length` entrants with a single generated stage of
 *  `kind`, scheduled on `courtIds`; returns its fixtures (nothing placed). */
async function addDivision(
  request: APIRequestContext,
  competitionId: string,
  name: string,
  stage: { kind: "knockout" | "league" | "page_playoff" | "stepladder"; name: string; config?: Record<string, unknown> },
  names: string[],
  courtIds: string[],
): Promise<{ divisionId: string; fixtures: ListedFixture[] }> {
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  const added = await addEntrantsViaApi(request, divisionId, names);
  expect(added.ids.length).toBe(names.length);
  await createStageAndGenerate(request, divisionId, stage);
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: START,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: courtIds,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  expect(settings.status).toBe(200);
  const listed = await apiJson<ListedFixture[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(listed.status).toBe(200);
  return { divisionId, fixtures: listed.data! };
}

async function place(request: APIRequestContext, fixtureId: string, scheduledAt: string, courtId: string) {
  const placed = await apiJson(request, `/api/v1/fixtures/${fixtureId}`, "PATCH", {
    scheduled_at: scheduledAt,
    court_id: courtId,
  });
  expect(placed.status, `place ${fixtureId}`).toBe(200);
}

const find = (fixtures: ListedFixture[], round: number, seq: number) =>
  fixtures.find((f) => f.round_no === round && f.seq_in_round === seq && !f.third_place)!;

/** A private competition with one division of `names.length` entrants and a
 *  single generated stage of `kind`, on a one-court grid. The first-round
 *  first match is placed on the grid (so the GRID mount renders a card);
 *  everything else stays in the tray. */
async function seedBoard(
  request: APIRequestContext,
  stage: { kind: "knockout" | "league"; name: string; config?: Record<string, unknown> },
  names: string[],
): Promise<{ divisionId: string; fixtures: ListedFixture[]; placedId: string }> {
  const competitionId = await createCompetition(request);
  const { courts } = await seedVenueWithCourts(request, ["Court A"]);
  const { divisionId, fixtures } = await addDivision(
    request,
    competitionId,
    "Round Codes",
    stage,
    names,
    courts.map((c) => c.id),
  );
  const first = find(fixtures, 1, 1);
  await place(request, first.id, START, courts[0]!.id);
  return { divisionId, fixtures, placedId: first.id };
}

const ENTRANTS_8 = ["Ash", "Brook", "Clay", "Dune", "Elm", "Fern", "Glen", "Heath"];

const chip = (page: Page, fixtureId: string) =>
  page.locator(`[data-fixture-id="${fixtureId}"]`).getByTestId("board-round-code");

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

test.describe("schedule board — knockout round codes", () => {
  test("desktop: grid + tray chips read QF/SF/F/3rd, placeholders use the code, the legend names them", async ({
    page,
  }, testInfo) => {
    const { divisionId, fixtures, placedId } = await seedBoard(
      page.request,
      { kind: "knockout", name: "Knockout", config: { thirdPlace: true } },
      ENTRANTS_8,
    );
    // 8 entrants + bronze: QF ×4, SF ×2, final, third-place match.
    expect(fixtures).toHaveLength(8);
    const at = (round: number, seq: number) => fixtures.find((f) => f.round_no === round && f.seq_in_round === seq)!;
    const sf1 = at(2, 1);
    const final = fixtures.find((f) => f.round_no === 3 && !f.third_place)!;
    const bronze = fixtures.find((f) => f.third_place)!;

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));

    // GRID mount: the placed first quarter-final reads QF, its title the long name.
    const placedChip = page.getByTestId("board-tray").locator(`[data-fixture-id="${placedId}"]`);
    await expect(placedChip).toHaveCount(0);
    await expect(chip(page, placedId)).toHaveText(fill("bracket.roundShort.quarter"));
    await expect(chip(page, placedId)).toHaveAttribute("title", fill("bracket.round.quarter"));

    // TRAY mount: the other seven, and never a generic "R{n}" among them.
    const trayChips = page.getByTestId("board-tray").getByTestId("board-round-code");
    await expect(trayChips).toHaveCount(7);
    const trayCodes = (await trayChips.allTextContents()).map(normalise).sort();
    expect(trayCodes).toEqual(
      [
        fill("bracket.roundShort.thirdPlace"),
        fill("bracket.roundShort.final"),
        fill("bracket.roundShort.quarter"),
        fill("bracket.roundShort.quarter"),
        fill("bracket.roundShort.quarter"),
        fill("bracket.roundShort.semi"),
        fill("bracket.roundShort.semi"),
      ].sort(),
    );
    // The seam the bronze match rides on: `third_place` reached the chip.
    await expect(chip(page, bronze.id)).toHaveText(fill("bracket.roundShort.thirdPlace"));
    await expect(chip(page, final.id)).toHaveText(fill("bracket.roundShort.final"));

    // Placeholders: an empty semi seat names its feeder by CODE, not "R1·1".
    const sf1Card = page.locator(`[data-fixture-id="${sf1.id}"]`);
    const qfRef = (seq: number) => fill("slot.match_ref_code", { code: fill("bracket.roundShort.quarter"), seq });
    await expect(sf1Card).toContainText(fill("slot.winner_match", { ext: qfRef(1) }));
    await expect(sf1Card).toContainText(fill("slot.winner_match", { ext: qfRef(2) }));
    await expect(sf1Card).not.toContainText(fill("slot.match_ref", { round: 1, seq: 1 }));
    // The bronze match is fed by the semis' LOSERS.
    const sfRef1 = fill("slot.match_ref_code", { code: fill("bracket.roundShort.semi"), seq: 1 });
    await expect(page.locator(`[data-fixture-id="${bronze.id}"]`)).toContainText(
      fill("slot.loser_match", { ext: sfRef1 }),
    );

    // Screen-reader label carries the LONG round name.
    await expect(sf1Card.locator("button[aria-pressed]")).toHaveAttribute(
      "aria-label",
      new RegExp(`— ${fill("bracket.round.semi")}\\.`),
    );

    // Legend: every code in view — the card's own chip, then its name — in
    // bracket order, one entry per item and no dot separators between them.
    const legend = page.getByTestId("board-legend-rounds");
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute("aria-label", fill("board.roundLegend.aria"));
    // Exposed as a LIST by its accessible name (review M4: an unstyled list
    // loses its role in WebKit without the explicit `role="list"`).
    await expect(page.getByRole("list", { name: fill("board.roundLegend.aria") })).toBeVisible();
    // Each entry reads code, a real space, then the name — "QF Quarter-finals".
    await expect(legend.getByRole("listitem")).toHaveText([
      `${fill("bracket.roundShort.quarter")} ${fill("bracket.round.quarter")}`,
      `${fill("bracket.roundShort.semi")} ${fill("bracket.round.semi")}`,
      `${fill("bracket.roundShort.final")} ${fill("bracket.round.final")}`,
      `${fill("bracket.roundShort.thirdPlace")} ${fill("bracket.round.thirdPlace")}`,
    ]);
    expect(await legend.getByRole("listitem").first().textContent()).toBe(
      `${fill("bracket.roundShort.quarter")} ${fill("bracket.round.quarter")}`,
    );
    expect(await legend.textContent()).not.toContain("·");
    // Same chip as the card: the identical class attribute on both.
    const legendChipClass = await legend.locator('[data-round-code-chip="knockout"]').first().getAttribute("class");
    expect(legendChipClass).toBeTruthy();
    expect(await chip(page, placedId).getAttribute("class")).toBe(legendChipClass);

    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath("board-round-codes-1280.png") });
  });

  for (const width of [320, 768]) {
    test(`${width}px: the legend wraps inside the viewport, no horizontal scroll`, async ({ page }, testInfo) => {
      const { divisionId, placedId } = await seedBoard(
        page.request,
        { kind: "knockout", name: "Knockout", config: { thirdPlace: true } },
        ENTRANTS_8,
      );
      await page.setViewportSize({ width, height: 800 });
      await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));

      // The placed card is on the board at every width (agenda on phones).
      await expect(chip(page, placedId)).toHaveText(fill("bracket.roundShort.quarter"));
      const legend = page.getByTestId("board-legend-rounds");
      await expect(legend).toBeVisible();
      // The tray is a closed sheet below `lg`, but its codes are still listed.
      await expect(legend).toContainText(fill("bracket.round.thirdPlace"));
      const box = (await legend.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`board-round-codes-${width}.png`) });
    });
  }

  test("round-robin board keeps R{n} chips and shows NO round legend", async ({ page }) => {
    const { divisionId, placedId } = await seedBoard(page.request, { kind: "league", name: "League" }, [
      "Ash",
      "Brook",
      "Clay",
      "Dune",
    ]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));

    // Positive pair first: the board rendered its cards, with plain chips.
    await expect(chip(page, placedId)).toHaveText("R1");
    const trayChips = page.getByTestId("board-tray").getByTestId("board-round-code");
    await expect(trayChips).toHaveCount(5);
    for (const text of await trayChips.allTextContents()) expect(normalise(text)).toMatch(/^R\d+$/);
    await expect(chip(page, placedId)).not.toHaveAttribute("title", /./);
    // …and only then the absence.
    await expect(page.getByTestId("board-legend-rounds")).toHaveCount(0);
  });
});

/** Screenshot the board region only — from just above the round legend down
 *  `height` px — so a capture shows the cards, not the page chrome. Scrolls to
 *  the top first: a `fullPage` clip is in DOCUMENT coordinates, and
 *  `boundingBox()` is viewport-relative. */
async function shootBoard(page: Page, path: string, height: number) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await page.getByTestId("board-legend-rounds").boundingBox())!;
  const width = page.viewportSize()!.width;
  await page.screenshot({ path, fullPage: true, clip: { x: 0, y: Math.max(0, box.y - 56), width, height } });
}

test.describe("schedule board — knockout codes beside a round-robin division", () => {
  // The owner's own concern: a COMPETITION board carrying a knockout division
  // and a round-robin one on the same day — QF/SF chips beside plain R1/R2
  // chips on one grid, and a "Winner of QF·n" placeholder placed ON the grid.
  test("competition board: QF/SF and R1/R2 chips side by side, placeholder on the grid", async ({ page }, testInfo) => {
    const request = page.request;
    const competitionId = await createCompetition(request);
    const { courts } = await seedVenueWithCourts(request, ["Court A", "Court B"]);
    const courtIds = courts.map((c) => c.id);
    const ko = await addDivision(
      request,
      competitionId,
      "Boys Singles",
      { kind: "knockout", name: "Knockout", config: { thirdPlace: true } },
      ENTRANTS_8,
      courtIds,
    );
    const rr = await addDivision(
      request,
      competitionId,
      "Girls Singles",
      { kind: "league", name: "League" },
      ["Iris", "Juno", "Kira", "Lune"],
      courtIds,
    );
    // Knockout on Court A: the four quarter-finals, then the first semi.
    for (const seq of [1, 2, 3, 4]) await place(request, find(ko.fixtures, 1, seq).id, at((seq - 1) * 30), courtIds[0]!);
    const sf1 = find(ko.fixtures, 2, 1);
    await place(request, sf1.id, at(120), courtIds[0]!);
    // Round-robin on Court B: both round-1 matches, then both round-2 ones.
    const rrR1 = find(rr.fixtures, 1, 1);
    const rrR2 = find(rr.fixtures, 2, 1);
    await place(request, rrR1.id, at(0), courtIds[1]!);
    await place(request, find(rr.fixtures, 1, 2).id, at(30), courtIds[1]!);
    await place(request, rrR2.id, at(60), courtIds[1]!);
    await place(request, find(rr.fixtures, 2, 2).id, at(90), courtIds[1]!);

    const divBoard = await divisionPath(request, ko.divisionId, "/schedule");
    const compBoard = divBoard.replace(/\/d\/[^/]+\/schedule$/, "/schedule");
    expect(compBoard).not.toBe(divBoard);
    const qf1 = find(ko.fixtures, 1, 1);
    const qfRef1 = fill("slot.match_ref_code", { code: fill("bracket.roundShort.quarter"), seq: 1 });

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(compBoard);
      // Both kinds of chip on ONE board, each on its own division's card.
      await expect(chip(page, qf1.id)).toHaveText(fill("bracket.roundShort.quarter"));
      await expect(chip(page, sf1.id)).toHaveText(fill("bracket.roundShort.semi"));
      await expect(chip(page, rrR1.id)).toHaveText("R1");
      await expect(chip(page, rrR2.id)).toHaveText("R2");
      // The heavier variant is the knockout one only.
      await expect(chip(page, qf1.id)).toHaveAttribute("data-round-code-chip", "knockout");
      await expect(chip(page, rrR1.id)).toHaveAttribute("data-round-code-chip", "plain");
      // The placeholder is on the BOARD (placed), not only in the tray.
      await expect(page.getByTestId("board-tray").locator(`[data-fixture-id="${sf1.id}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-fixture-id="${sf1.id}"]`)).toContainText(
        fill("slot.winner_match", { ext: qfRef1 }),
      );
      // The legend names only the knockout's codes — R{n} needs no key.
      const legend = page.getByTestId("board-legend-rounds");
      await expect(legend).toBeVisible();
      await expect(legend).toContainText(fill("bracket.round.quarter"));
      await expect(legend).not.toContainText("R1");
      const box = (await legend.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await expectNoHorizontalScroll(page);
      await shootBoard(page, testInfo.outputPath(`v2-comp-${width}.png`), width === 320 ? 1000 : 760);
    }

    // The knockout DIVISION board, same day.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${divBoard}?tab=board`);
    await expect(chip(page, qf1.id)).toHaveText(fill("bracket.roundShort.quarter"));
    await expect(page.locator(`[data-fixture-id="${sf1.id}"]`)).toContainText(
      fill("slot.winner_match", { ext: qfRef1 }),
    );
    await expectNoHorizontalScroll(page);
    await shootBoard(page, testInfo.outputPath("v2-division-1280.png"), 760);
  });
});

test.describe("schedule board — page playoff and stepladder codes beside a knockout", () => {
  // Board playoff codes (2026-09-23, owner-approved): a page playoff reads
  // Q1 / E / Q2 / F and a stepladder E1 / E2 / F, on ONE competition board with
  // a knockout (SF / F) — the page playoff's codes ride the one new column on
  // the board read (`ext_key`, page-playoff rows only), so this is the seam
  // proven end to end. The legend lists each format's rounds as one run, then
  // the shared F once.
  test("competition board: Q1/E/Q2/F and E1/E2/F chips, playoff placeholders, one legend in bracket order", async ({
    page,
  }, testInfo) => {
    const request = page.request;
    const competitionId = await createCompetition(request);
    const { courts } = await seedVenueWithCourts(request, ["Court A", "Court B", "Court C"]);
    const courtIds = courts.map((c) => c.id);
    const pp = await addDivision(
      request,
      competitionId,
      "Page Playoff",
      { kind: "page_playoff", name: "Playoffs" },
      ["Ash", "Brook", "Clay", "Dune"],
      courtIds,
    );
    const sl = await addDivision(
      request,
      competitionId,
      "Stepladder",
      { kind: "stepladder", name: "Ladder" },
      ["Elm", "Fern", "Glen", "Heath"],
      courtIds,
    );
    const ko = await addDivision(
      request,
      competitionId,
      "Knockout",
      { kind: "knockout", name: "Knockout" },
      ["Iris", "Juno", "Kira", "Lune"],
      courtIds,
    );
    // The generators' shapes: a page playoff is Q1 (1·1) and the Eliminator
    // (1·2) sharing round 1, then Q2, then the final; a 4-stepladder is three
    // single-match rounds; a 4-knockout two semis and a final.
    expect(pp.fixtures).toHaveLength(4);
    expect(sl.fixtures).toHaveLength(3);
    expect(ko.fixtures).toHaveLength(3);
    const q1 = find(pp.fixtures, 1, 1);
    const elim = find(pp.fixtures, 1, 2);
    const q2 = find(pp.fixtures, 2, 1);
    const ppFinal = find(pp.fixtures, 3, 1);
    const rung1 = find(sl.fixtures, 1, 1);
    const rung2 = find(sl.fixtures, 2, 1);
    const slFinal = find(sl.fixtures, 3, 1);
    const sf1 = find(ko.fixtures, 1, 1);
    const koFinal = find(ko.fixtures, 2, 1);
    // Court A the page playoff, Court B the stepladder, Court C the knockout.
    for (const [i, f] of [q1, elim, q2, ppFinal].entries()) await place(request, f.id, at(i * 30), courtIds[0]!);
    for (const [i, f] of [rung1, rung2, slFinal].entries()) await place(request, f.id, at(i * 30), courtIds[1]!);
    for (const [i, f] of [sf1, find(ko.fixtures, 1, 2), koFinal].entries()) {
      await place(request, f.id, at(i * 30), courtIds[2]!);
    }

    const compBoard = (await divisionPath(request, pp.divisionId, "/schedule")).replace(
      /\/d\/[^/]+\/schedule$/,
      "/schedule",
    );
    const code = {
      q1: fill("bracket.roundShort.qualifier1"),
      e: fill("bracket.roundShort.eliminator"),
      q2: fill("bracket.roundShort.qualifier2"),
      f: fill("bracket.roundShort.final"),
      e1: fill("bracket.roundShort.rung", { n: 1 }),
      e2: fill("bracket.roundShort.rung", { n: 2 }),
      sf: fill("bracket.roundShort.semi"),
    };
    const refTo = (c: string) => fill("slot.match_ref_code", { code: c, seq: 1 });

    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(compBoard);
      // Every chip, each on its own division's card, all the heavier variant.
      for (const [f, text] of [
        [q1, code.q1],
        [elim, code.e],
        [q2, code.q2],
        [ppFinal, code.f],
        [rung1, code.e1],
        [rung2, code.e2],
        [slFinal, code.f],
        [sf1, code.sf],
        [koFinal, code.f],
      ] as const) {
        await expect(chip(page, f.id), `${width}px ${f.id}`).toHaveText(text);
        await expect(chip(page, f.id)).toHaveAttribute("data-round-code-chip", "knockout");
      }
      // The long names, on the chip's title: the page playoff's own, and the
      // stepladder's board-only "Eliminator {n}" (never "Rung {n}").
      await expect(chip(page, elim.id)).toHaveAttribute("title", fill("bracket.round.eliminator"));
      await expect(chip(page, q1.id)).toHaveAttribute("title", fill("bracket.round.qualifier1"));
      await expect(chip(page, rung2.id)).toHaveAttribute("title", fill("bracket.round.eliminatorN", { n: 2 }));
      await expect(chip(page, rung2.id)).not.toHaveAttribute("title", fill("bracket.round.rung", { n: 2 }));
      // Placeholders name their feeders by code — the Eliminator as E·1, the
      // only Eliminator, though it is the second match of its round.
      const card = (id: string) => page.locator(`[data-fixture-id="${id}"]`);
      await expect(card(q2.id)).toContainText(fill("slot.loser_match", { ext: refTo(code.q1) }));
      await expect(card(q2.id)).toContainText(fill("slot.winner_match", { ext: refTo(code.e) }));
      await expect(card(q2.id)).not.toContainText(fill("slot.match_ref_code", { code: code.e, seq: 2 }));
      await expect(card(ppFinal.id)).toContainText(fill("slot.winner_match", { ext: refTo(code.q1) }));
      await expect(card(ppFinal.id)).toContainText(fill("slot.winner_match", { ext: refTo(code.q2) }));
      await expect(card(rung2.id)).toContainText(fill("slot.winner_match", { ext: refTo(code.e1) }));
      await expect(card(slFinal.id)).toContainText(fill("slot.winner_match", { ext: refTo(code.e2) }));
      // Screen-reader label: the long round name.
      await expect(card(elim.id).locator("button[aria-pressed]")).toHaveAttribute(
        "aria-label",
        new RegExp(`— ${fill("bracket.round.eliminator")}\\.`),
      );
      // Legend: each format's rounds as one run, the shared final once, last;
      // the page playoff's E and the stepladder's E1 both explained.
      const legend = page.getByTestId("board-legend-rounds");
      await expect(legend.getByRole("listitem")).toHaveText([
        `${code.sf} ${fill("bracket.round.semi")}`,
        `${code.q1} ${fill("bracket.round.qualifier1")}`,
        `${code.e} ${fill("bracket.round.eliminator")}`,
        `${code.q2} ${fill("bracket.round.qualifier2")}`,
        `${code.e1} ${fill("bracket.round.eliminatorN", { n: 1 })}`,
        `${code.e2} ${fill("bracket.round.eliminatorN", { n: 2 })}`,
        `${code.f} ${fill("bracket.round.final")}`,
      ]);
      const box = (await legend.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await expectNoHorizontalScroll(page);
      await shootBoard(page, testInfo.outputPath(`v3-comp-${width}.png`), width === 320 ? 1100 : 760);
    }
  });
});
