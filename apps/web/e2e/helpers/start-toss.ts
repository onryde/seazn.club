import { expect, type Page } from "@playwright/test";

/**
 * S2-7 (TN-TS-1, engine 8.0.0): a TENNIS Start asks "Who serves first?" before it starts the match
 * (`StartMatchControl`, `v3/start-match-control.tsx`), and the answer sends `tennis.toss` and then `core.start`. Call this
 * right after clicking "Start match" on a tennis fixture. `home` (the default) is the serve order every tennis spec was
 * written against before the toss existed, so a spec that only needs a live match keeps its assertions unchanged.
 */
export async function answerStartToss(page: Page, side: "home" | "away" = "home"): Promise<void> {
  const question = page.getByTestId("score-start-toss");
  await expect(question).toBeVisible({ timeout: 20_000 });
  await question.getByTestId(`pad-dock-chip-${side}`).click();
}
