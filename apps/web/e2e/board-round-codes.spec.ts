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

/** A private competition with one division of `names.length` entrants and a
 *  single generated stage of `kind`, on a one-court grid. The first-round
 *  first match is placed on the grid (so the GRID mount renders a card);
 *  everything else stays in the tray. */
async function seedBoard(
  request: APIRequestContext,
  stage: { kind: "knockout" | "league"; name: string; config?: Record<string, unknown> },
  names: string[],
): Promise<{ divisionId: string; fixtures: ListedFixture[]; placedId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Round Codes ${TAG}`,
    visibility: "private",
  });
  expect(comp.data?.id, `competition create → ${comp.status}`).toBeTruthy();
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Round Codes",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divisionId = div.data!.id;
  const added = await addEntrantsViaApi(request, divisionId, names);
  expect(added.ids.length).toBe(names.length);
  await createStageAndGenerate(request, divisionId, stage);
  const { courts } = await seedVenueWithCourts(request, ["Court A"]);
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: START,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: courts.map((c) => c.id),
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  expect(settings.status).toBe(200);
  const listed = await apiJson<ListedFixture[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(listed.status).toBe(200);
  const fixtures = listed.data!;
  const first = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
  const placed = await apiJson(request, `/api/v1/fixtures/${first.id}`, "PATCH", {
    scheduled_at: START,
    court_id: courts[0]!.id,
  });
  expect(placed.status).toBe(200);
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
    await expect(chip(page, placedId)).toHaveText("QF");
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
    await expect(chip(page, bronze.id)).toHaveText("3rd");
    await expect(chip(page, final.id)).toHaveText("F");

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

    // Legend: every code in view, with its name, in bracket order.
    const legend = page.getByTestId("board-legend-rounds");
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute("aria-label", fill("board.roundLegend.aria"));
    expect(normalise((await legend.textContent()) ?? "")).toBe(
      [
        `${fill("bracket.roundShort.quarter")}${fill("bracket.round.quarter")}`,
        `${fill("bracket.roundShort.semi")}${fill("bracket.round.semi")}`,
        `${fill("bracket.roundShort.final")}${fill("bracket.round.final")}`,
        `${fill("bracket.roundShort.thirdPlace")}${fill("bracket.round.thirdPlace")}`,
      ].join("·"),
    );

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
      await expect(chip(page, placedId)).toHaveText("QF");
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
