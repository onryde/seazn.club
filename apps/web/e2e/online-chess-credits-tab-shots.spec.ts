import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { activeOrg, expectNoHorizontalScroll, setOrgPlanBySql } from "./helpers";
import { dismissConsent, freshOrg } from "./directory-kit";
import { seedMatchRoom } from "./match-room-kit";
import { ONLINE_SIZES } from "../src/lib/online-chess-package";

// Online Chess credits, Task 13 - screenshot evidence for Settings -> Credits with an ONLINE CHESS package row in the history,
// in English and Spanish at 1280, 768 and 320 (the new row is the one that carries a division name and a size, and the Spanish
// sentence is the longest of the four locales' - exactly where a page would push sideways).
//
// The row is made the way the product makes it: a division paid at "Pay and open the round" (the open-round route, 402 then pay),
// not seeded into the ledger - so the row photographed is the one a customer's own payment leaves behind.
//
// Own blank session and a brand-new org (freshOrg), so the ledger holds this payment and nothing else of a shared org's.
// The pictures go to CREDITS_SHOTS_DIR (the default is the programme's own shots folder, outside the repo's tracked files);
// the spec asserts the six pictures EXIST and DIFFER from one another, so a capture that drew the same page six times fails.
test.use({ storageState: { cookies: [], origins: [] } });

const SHOTS =
  process.env.CREDITS_SHOTS_DIR ??
  resolve(process.cwd(), "../../.superpowers/sdd/shots/oc-credits-tab");
const WIDTHS = [1280, 768, 320] as const;
const LOCALES = ["en", "es"] as const;
type Locale = (typeof LOCALES)[number];

const dictOf = (locale: Locale): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"));
const say = (locale: Locale, key: string, vars: Record<string, string | number>): string => {
  const raw = dictOf(locale)[key];
  if (raw === undefined) throw new Error(`${locale}/ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (!(v in vars)) throw new Error(`say(${locale}, ${key}): no value for {${v}}`);
    return String(vars[v]);
  });
};

const DIVISION = "Open Rapid"; // seedMatchRoom's division name (match-room-kit.ts)

test("Settings -> Credits shows the Online Chess package row, en and es, at 1280, 768 and 320, with no sideways scroll", async ({ page }) => {
  test.setTimeout(300_000);
  mkdirSync(SHOTS, { recursive: true });
  await freshOrg(page, "occredits");
  await dismissConsent(page);
  const org = await activeOrg(page);
  await setOrgPlanBySql({ orgId: org.id }, "pro");
  await seedMatchRoom(page.request, { names: ["Ana Petrova", "Bo Lindqvist"], stage: "knockout" });

  const origin = new URL(page.url()).origin;
  const files: string[] = [];
  for (const locale of LOCALES) {
    await page.context().addCookies([{ name: "seazn_locale", value: locale, url: origin }]);
    // The row's own sentence, from the dictionary: the first payment names the division and the size it paid at (the smallest).
    const sentence = say(locale, "settings.credits.stream.kind.onlinePackagePaid", { division: DIVISION, size: ONLINE_SIZES[0]! });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/o/${org.slug}/settings/credits`, { waitUntil: "load" });
      const history = page.getByTestId("credits-stream-history");
      await expect(history, `${locale} ${width}: the history is a table`).toBeVisible({ timeout: 30_000 });
      await expect(history.getByText(sentence, { exact: false }).first(), `${locale} ${width}: the package row`).toBeVisible();
      await expectNoHorizontalScroll(page);
      const file = resolve(SHOTS, `credits-oc-package-${locale}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      files.push(file);
    }
  }

  expect(files, "2 locales x 3 widths").toHaveLength(6);
  const hashes = files.map((f) => createHash("sha256").update(readFileSync(f)).digest("hex"));
  expect(new Set(hashes).size, "six pictures, all different").toBe(6);
  await shotNote(page, files);
});

/** The report's note on what was captured (attached to the test so a run's HTML report carries the list). */
async function shotNote(_page: Page, files: string[]): Promise<void> {
  await test.info().attach("oc-credits-shots", { body: files.join("\n"), contentType: "text/plain" });
}
