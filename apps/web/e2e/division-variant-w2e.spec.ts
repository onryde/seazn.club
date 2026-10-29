// W2e Task 29 (owner D1/D2; rule rows BM-VAR-1, TN-CF-1) - what an organiser sees and what is stored, through the product.
//
//   1. A new badminton division is 3x15: the builder opens on bwf-3x15, prints the BWF date note under the picker, and the
//      division it creates stores 15 / 15 (the engine's own bwf-3x15 numbers, read from the module, never typed here).
//   2. Settings switches it to the 3x21 variant and the stored format becomes 21 / 21 / cap 30: the target variant's numbers
//      win over the old variant's (the first build kept setTo 15 beside the new cap).
//   3. A tennis division asked for best of 1 with a match tie-break is refused in the editor, in the reader's language and
//      beside the fields, and nothing is saved; mended, it saves.
//
// Every string comes from the dictionary the product renders. Serial: 2 and 3 read what 1 and the rig made.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { BWF_3X15_FROM } from "../src/lib/variant-label-keys";
import { TAG, apiJson, competitionPath, createCompetitionViaUi, divisionPath } from "./helpers";

const L = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The BWF note is a dated line (W2e T33a): shown until BWF's day, gone from it. What this run should see is read off the clock against
 *  the one constant, and the date it prints is the same instant written day-month in English - never a typed "4 January 2027". */
const HINT_LIVE = Date.now() < Date.parse(BWF_3X15_FROM);
const HINT_TEXT = L["variant.badminton.hint3x15"]!.replace(
  "{date}",
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(Date.parse(BWF_3X15_FROM)),
);

const STEP_MS = 20_000;
const POLL_MS = 20_000;

test.describe.configure({ mode: "serial" });

/** The engine's own presets: the numbers a division stores are read from here. */
function preset(sport: string, variant: string): Record<string, unknown> {
  const found = builtinModules.find((m) => m.key === sport);
  if (!found) throw new Error(`no sport module ${sport}`);
  const row = (found.variants as Record<string, Record<string, unknown>>)[variant];
  if (!row) throw new Error(`no variant ${sport}/${variant}`);
  return row;
}

let compId = "";
let badmintonDivId = "";

type Division = { config: Record<string, unknown>; variant_key: string };

test("D2 a new badminton division is bwf-3x15: the builder opens on it, says why, and stores 15 / 15", async ({ page, request }) => {
  test.setTimeout(Math.max(120_000, 6 * STEP_MS));
  const to15 = preset("badminton", "bwf-3x15");
  const to21 = preset("badminton", "bwf");
  expect(to15.setTo, "premise: the two variants disagree on the target").not.toBe(to21.setTo);

  compId = await createCompetitionViaUi(page, `Variant W2e ${TAG}`, "public");
  await page.goto(await competitionPath(request, compId, "/d/new"));
  await page.getByRole("textbox").first().fill(`Singles ${TAG}`);
  await page.getByRole("combobox", { name: "Sport", exact: true }).selectOption("badminton");

  const picker = page.getByTestId("division-builder-variant");
  await expect(picker).toHaveValue("bwf-3x15", { timeout: STEP_MS });
  // Labelled, not the raw key: the picker prints the dictionary's words for both formats.
  await expect(picker.locator("option:checked")).toHaveText(L["variant.badminton.bwf3x15"]!);
  await expect(picker.locator(`option[value="bwf"]`)).toHaveText(L["variant.badminton.bwf"]!);
  const hint = page.getByTestId("division-variant-hint");
  if (HINT_LIVE) {
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(HINT_TEXT);
  } else {
    await expect(hint, "from BWF's day the dated note is gone").toHaveCount(0);
  }
  // The note is not on a sport that has none: it is the picker's state, not a fixed banner.
  await page.getByRole("combobox", { name: "Sport", exact: true }).selectOption("tennis");
  await expect(page.getByTestId("division-variant-hint")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Sport", exact: true }).selectOption("badminton");
  await expect(page.getByTestId("division-builder-variant")).toHaveValue("bwf-3x15");

  await page.getByRole("button", { name: L["wizard.tab.scheduling"], exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: STEP_MS });
  const slug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const list = await apiJson<{ id: string; slug: string }[]>(request, `/api/v1/competitions/${compId}/divisions`);
  badmintonDivId = list.data!.find((d) => d.slug === slug)!.id;

  const division = await apiJson<Division>(request, `/api/v1/divisions/${badmintonDivId}`);
  expect(division.status).toBe(200);
  expect(division.data!.variant_key).toBe("bwf-3x15");
  expect(division.data!.config.setTo, "the stored target is the 3x15 variant's").toBe(to15.setTo);
  expect(division.data!.config.setTo).toBe(15);
  expect(division.data!.config.finalSetTo).toBe(to15.finalSetTo);
});

test("D2 Settings switches the division to 3x21: the stored format is the target variant's, not the old one's", async ({ page, request }) => {
  test.setTimeout(Math.max(120_000, 6 * STEP_MS));
  const to21 = preset("badminton", "bwf");
  const open = async () => {
    await page.goto(await divisionPath(request, badmintonDivId, "?tab=settings"));
    await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: STEP_MS });
    await page.getByRole("button", { name: /Format/ }).click();
  };
  await open();
  const picker = page.getByTestId("division-settings-variant");
  await expect(picker).toHaveValue("bwf-3x15", { timeout: STEP_MS });
  if (HINT_LIVE) await expect(page.getByTestId("division-variant-hint")).toHaveText(HINT_TEXT);
  else await expect(page.getByTestId("division-variant-hint")).toHaveCount(0);

  await picker.selectOption("bwf");
  await page.getByRole("button", { name: L["divset.saveRules"], exact: true }).click();
  await expect(page.getByText(L["divset.notice.rulesSaved"])).toBeVisible({ timeout: STEP_MS });
  await expect
    .poll(async () => (await apiJson<Division>(request, `/api/v1/divisions/${badmintonDivId}`)).data, { timeout: POLL_MS })
    .toMatchObject({
      variant_key: "bwf",
      config: { setTo: to21.setTo, finalSetTo: to21.finalSetTo, cap: to21.cap },
    });
  expect((await apiJson<Division>(request, `/api/v1/divisions/${badmintonDivId}`)).data!.config.setTo).toBe(21);

  // The way back: the 3x15 numbers, not 3x21's carried over (the sequence, not just the one direction).
  await open();
  await expect(page.getByTestId("division-settings-variant")).toHaveValue("bwf");
  await page.getByTestId("division-settings-variant").selectOption("bwf-3x15");
  await page.getByRole("button", { name: L["divset.saveRules"], exact: true }).click();
  await expect(page.getByText(L["divset.notice.rulesSaved"])).toBeVisible({ timeout: STEP_MS });
  const to15 = preset("badminton", "bwf-3x15");
  await expect
    .poll(async () => (await apiJson<Division>(request, `/api/v1/divisions/${badmintonDivId}`)).data, { timeout: POLL_MS })
    .toMatchObject({
      variant_key: "bwf-3x15",
      config: { setTo: to15.setTo, finalSetTo: to15.finalSetTo, cap: to15.cap },
    });
});

test("TN-CF-1 tennis best of 1 with a match tie-break is refused in the editor, beside the fields; mended, it saves", async ({ page, request }) => {
  test.setTimeout(Math.max(120_000, 8 * STEP_MS));
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: `Tennis ${TAG}`,
    sport_key: "tennis",
    variant_key: "tour",
  });
  expect(div.status, `tennis division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const tennisDivId = div.data!.id;
  const before = (await apiJson<Division>(request, `/api/v1/divisions/${tennisDivId}`)).data!;
  const sentence = L["rules.err.bo1MatchTiebreak"]!;

  await page.goto(await divisionPath(request, tennisDivId, "?tab=settings"));
  await expect(page.getByTestId("division-settings")).toBeVisible({ timeout: STEP_MS });
  await page.getByRole("button", { name: /Format/ }).click();
  await page.getByLabel("Best of (sets)").selectOption("1");
  await page.getByLabel("Deciding set").selectOption("mtb10");
  // The sentence sits beside the fields it is about, before any Save...
  await expect(page.getByTestId("rule-field-bestOf").getByRole("alert")).toHaveText(sentence);
  await expect(page.getByTestId("rule-field-finalSet").getByRole("alert")).toHaveText(sentence);
  // ...and Save is answered with it, not with a request. The save's own answer is the banner (`division-settings-error`), a
  // node the two field alerts above are not: absent before Save, present with the sentence after it. Asserting the sentence
  // anywhere in the tab would pass on the field alerts alone, whatever Save did.
  const patches: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes(`/api/v1/divisions/${tennisDivId}`)) patches.push(r.url());
  });
  const banner = page.getByTestId("division-settings-error");
  await expect(banner, "no save banner before Save").toHaveCount(0);
  await page.getByRole("button", { name: L["divset.saveRules"], exact: true }).click();
  await expect(banner).toHaveText(sentence, { timeout: STEP_MS });
  await expect(page.getByText(L["divset.notice.rulesSaved"])).toHaveCount(0);
  expect(patches, "the refused format never left the browser").toEqual([]);
  const after = (await apiJson<Division>(request, `/api/v1/divisions/${tennisDivId}`)).data!;
  expect(after.config.bestOf, "nothing was saved").toBe(before.config.bestOf);

  // Mended: the deciding set is an ordinary set, and best of 1 saves.
  await page.getByLabel("Deciding set").selectOption("same");
  await expect(page.getByTestId("rule-field-bestOf").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: L["divset.saveRules"], exact: true }).click();
  await expect(page.getByText(L["divset.notice.rulesSaved"])).toBeVisible({ timeout: STEP_MS });
  await expect
    .poll(async () => (await apiJson<Division>(request, `/api/v1/divisions/${tennisDivId}`)).data?.config.bestOf, { timeout: POLL_MS })
    .toBe(1);
});
