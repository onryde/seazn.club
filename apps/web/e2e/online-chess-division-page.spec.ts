// Owner staging test 2026-10-19, in a real browser: an online (Lichess) chess division's PAGE.
//   - the header chip names the sport as the word "Chess" (not the stored key "Boardgame");
//   - until the division is started the fixtures tab says so, once ("Start the division to open rounds for online play.");
//   - after Start the line is gone, and the tab hands the round over to the Arbiter Panel: no Open round control on the tab
//     any more (phase 2 moved it into the panel's round column), and the one entry card reads "Round 1 is ready to open".
// The cards' markup is stages-panel-start-hint.test.tsx's and the page's gates are online-start-hint-wiring.test.tsx's;
// this is the sequence, driven through the real page and the real Start.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { TAG, apiJson, competitionPath, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
import { fill, uiEn } from "./match-room-kit";

const SHOTS = process.env.ROOM_SHOTS_DIR;

test("online chess division: the header says Chess; the fixtures tab says to start the division, and stops saying it once started", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Start hint ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Hint Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", clock: { base: 600, increment: 5 }, onlinePlay: "lichess" },
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.data!.id}/entrants`, "POST", [
    { kind: "individual", display_name: `Hint Ada ${TAG}`, seed: 1, members: [] },
    { kind: "individual", display_name: `Hint Bo ${TAG}`, seed: 2, members: [] },
  ]);
  expect(ents.status, JSON.stringify(ents.error)).toBeLessThan(300);
  await createStageAndGenerate(request, div.data!.id);
  const base = await competitionPath(request, comp.data!.id, `/d/${div.data!.slug}`);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}?tab=fixtures`);
  const chip = page.locator("main .chip").first();
  await expect(chip).toContainText(uiEn["sport.boardgame"]!);
  await expect(chip, "the sport's word, not its stored key").not.toContainText(/boardgame/i);
  const hint = page.getByTestId("online-start-hint");
  await expect(hint).toHaveCount(1);
  await expect(hint).toHaveText(uiEn["externalPlay.openRound.startFirst"]!);
  await expect(page.getByTestId("open-round"), "no Open round control while it waits").toHaveCount(0);
  await expect(
    page.getByTestId("arbiter-entry-status").filter({ hasText: fill("arbiter.entry.status.ready", { round: 1 }) }),
    "not started: nothing is ready to open yet, so the entry card cannot say so",
  ).toHaveCount(0);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 800 });
    await expect(hint).toBeVisible();
    await expectNoHorizontalScroll(page);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `start-hint-${width}.png`), fullPage: true, caret: "initial" });
    }
  }

  // Started: the line is gone. The control that opens a round is NOT on this tab (it lives in the panel's round column); the tab
  // keeps one entry card, and it says round 1 is ready to open.
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
  await page.goto(`${base}?tab=fixtures`);
  const entry = page.getByTestId("arbiter-entry");
  await expect(entry, "started: the one way into the panel is on the tab").toHaveCount(1);
  await expect(entry.getByTestId("arbiter-entry-status")).toHaveAttribute("data-kind", "ready");
  await expect(entry.getByTestId("arbiter-entry-status")).toHaveText(fill("arbiter.entry.status.ready", { round: 1 }));
  await expect(entry.getByRole("link", { name: uiEn["arbiter.entry.link"]!, exact: true })).toBeVisible();
  await expect(page.getByTestId("open-round"), "started: Open round is the panel's, not the tab's").toHaveCount(0);
  await expect(page.getByTestId("online-start-hint"), "started: nothing left to say").toHaveCount(0);
});
