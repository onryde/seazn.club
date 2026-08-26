import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrgIdFromRequest,
  competitionPath,
  seedVenueWithCourts,
} from "./helpers";

// P9 review finding #4 — the COMPETITION (joint) board.
//
// The division board threads a `venues` prop into `<ScheduleBoard>`; the joint
// board did not, so the prop defaulted to `[]` and `courtNamesById` was empty
// on that entire page. Column headers, the swap button, MovePanel's court
// select and the settings card's court picker all rendered bare court UUIDs,
// and the picker offered nothing selectable at all.
//
// This is the one surface in that wave with NO court names whatsoever, so it
// is also the largest perceptual change — worth an actual look, not only an
// assertion. Note the fix makes rendered text SHORTER (a uuid is 36 chars, a
// court name is a handful), so it cannot newly overflow; what the shots are
// for is confirming the names are actually there and legible at each width.
//
// The no-horizontal-scroll check below is deliberately NOT the whole test: it
// passes on truncation, which is exactly how a 320px defect on the court
// picker survived a green gate earlier in this branch.
const SHOTS = process.env.JOINT_BOARD_SHOTS_DIR ?? null;

const WIDTHS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "tablet-768", width: 768, height: 1000 },
  { name: "mobile-320", width: 320, height: 800 },
] as const;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === null) return;
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

test("joint board renders court NAMES, never bare uuids, at every width", async ({
  page,
  request,
}) => {
  const orgId = await activeOrgIdFromRequest(request);
  const { courts } = await seedVenueWithCourts(request, ["Centre Court", "Court 2"], {
    orgId,
    venueName: `Joint Venue ${TAG}`,
  });

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Joint Courts ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;

  // Two divisions — the joint board only has a reason to exist with more than
  // one, and #4 was about the whole PAGE having no name map.
  for (const name of ["Alpha", "Bravo"]) {
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name,
        slug: `${name.toLowerCase()}-${TAG}`,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    // Give each division the real courts, so the board has columns to label.
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: "2030-06-01T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 0,
        courts: courts.map((c) => c.id),
        sessionWindows: [],
        blackouts: [],
      },
    });
  }

  await page.goto(await competitionPath(page.request, compId, "/schedule"), {
    waitUntil: "load",
  });

  for (const v of WIDTHS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.waitForTimeout(250);

    const body = (await page.locator("body").innerText()).trim();

    // The court names reach the page…
    expect(body, `court names missing at ${v.width}px`).toContain("Centre Court");
    // …and NOTHING on it is a raw uuid. This is the assertion that would have
    // failed before the `venues` prop was threaded: the same slots rendered
    // `8f1c9a3e-…` instead of a name.
    expect(body, `raw court uuid rendered at ${v.width}px`).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, `horizontal page scroll at ${v.width}px`).toBe(false);

    await shot(page, `joint-board-${v.name}`);
  }
});

// Comp-board stage picker: the page used to disambiguate a stage across
// divisions by baking the division into the stage NAME ("Alpha · League"),
// which is exactly why every pill on this board ran long — and a row of
// pills, one per stage per division, pushed the solver buttons into a
// ragged wrap. The board now carries ONE chip naming the target and a menu
// grouped by division behind it. Two divisions, each with a stage of the
// SAME name, is the shape that used to need the prefix — the menu's group
// headers carry that job now, and the stage names stay bare.
//
// A real browser is the only witness for the two claims that matter here:
// the menu actually OPENS from the chip (a <details> the unit harness sees
// as static markup either way), and picking from it re-aims the chip.
test("joint board picks a stage from a chip whose menu is grouped by division", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Joint Stages ${TAG}`,
    visibility: "private",
  });
  const compId = comp.data!.id;

  /** The one stage each division gets, in division order. */
  const divisionStageIds: string[] = [];
  for (const name of ["Alpha", "Bravo"]) {
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name,
        slug: `${name.toLowerCase()}-${TAG}`,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    // Same stage NAME in every division — the shape a prefix used to
    // disambiguate, now the group header's job instead.
    const stage = await apiJson<{ id: string }>(
      request,
      `/api/v1/divisions/${div.data!.id}/stages`,
      "POST",
      { seq: 1, kind: "league", name: "League" },
    );
    expect(stage.status, `stage created for ${name}`).toBeLessThan(300);
    divisionStageIds.push(stage.data!.id);
  }

  await page.goto(await competitionPath(page.request, compId, "/schedule"), {
    waitUntil: "load",
  });
  await shot(page, "joint-board-stage-picker-desktop");

  // The chip names both halves of the target, and defaults to the first
  // division's first stage.
  const chip = page.getByTestId("schedule-stage-picker");
  await expect(chip).toHaveCount(1);
  await expect(page.getByTestId("schedule-stage-picker-division")).toHaveText("Alpha");
  await expect(page.getByTestId("schedule-stage-picker-stage")).toHaveText("League");

  // Closed until clicked — a <details> keeps the menu in the DOM, so this is
  // a visibility claim, not an existence one.
  const options = page.getByTestId("schedule-stage");
  await expect(options.nth(0)).toBeHidden();
  await chip.click();
  await expect(options.nth(0)).toBeVisible();
  await shot(page, "joint-board-stage-picker-open");

  const groups = page.getByTestId("schedule-stage-group");
  await expect(groups).toHaveCount(2);
  await expect(page.getByTestId("schedule-stage-group-label").nth(0)).toHaveText("Alpha");
  await expect(page.getByTestId("schedule-stage-group-label").nth(1)).toHaveText("Bravo");

  // Bare, not "Alpha · League" / "Bravo · League" — the group header is what
  // now disambiguates the two identically-named stages.
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveText("League");
  await expect(options.nth(1)).toHaveText("League");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  // Picking re-aims the chip and closes the menu.
  await options.nth(1).click();
  await expect(page.getByTestId("schedule-stage-picker-division")).toHaveText("Bravo");
  await expect(chip).toHaveAttribute("data-stage-id", divisionStageIds[1]!);
  await expect(options.nth(1)).toBeHidden();

  // Escape closes it too — the dismiss rule DocumentsMenu already carries.
  await chip.click();
  await expect(options.nth(1)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options.nth(1)).toBeHidden();

  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(250);
  await shot(page, "joint-board-stage-picker-320");
  let overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow, "horizontal page scroll at 320px").toBe(false);

  // The OPEN menu must not push the page sideways either: a fixed-width
  // panel anchored to a chip that starts mid-row is the shape that overflows.
  await chip.click();
  await expect(options.nth(0)).toBeVisible();
  await shot(page, "joint-board-stage-picker-320-open");
  overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow, "horizontal page scroll at 320px with the menu open").toBe(false);
});
