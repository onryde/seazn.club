import { test, expect, type Page } from "@playwright/test";
import { failOnNativeDialog } from "../helpers";
import { freshOrg, stamp } from "../directory-kit";

/**
 * The organiser's identity journey on /directory?tab=players, driven by hand.
 *
 * Test A asserts the duplicate queue in BOTH directions — that a real duplicate
 * is proposed, and that a same-name pair with DIFFERING dobs is suppressed. The
 * suppression case is the one no existing spec makes, and it is what a
 * "suggest everything" mutant dies on.
 *
 * Fresh org, deliberately. The walkthrough project's storageState is the shared
 * PRO org, and the Players tab renders only the OLDEST 200 persons
 * (`PlayersTab` in src/app/directory/page.tsx passes `limit: 200`; `listPersons`
 * orders by `created_at, id` ascending) — so a person created late in a shared
 * org is not on the page at all, and every assertion below would pass or fail
 * on who else ran first.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const roster = (page: Page) => page.getByRole("table", { name: "Players" });
const queue = (page: Page) => page.getByRole("region", { name: "Possible duplicates" });

/**
 * Enter one player through the form the organiser uses, and return the id the
 * roster row carries.
 *
 * The count-before / poll-to-`before + 1` dance is not ceremony. This spec
 * enters the SAME name three times on purpose, and the roster is a real table:
 * a locator reading "the row for Alex Morgan" resolves to two elements on the
 * second call, at which point Playwright aborts on a strict-mode violation
 * instead of asserting anything. Counting first also makes a silently-refused
 * submit a red here rather than a confusing `null` id below.
 *
 * `nth(before)` is the row this call created because `listPersons` orders by
 * `created_at, id` ASCENDING — the newest matching row is always last.
 */
async function addPerson(
  page: Page,
  opts: { name: string; dob?: string },
): Promise<string> {
  const rows = roster(page).getByRole("row", { name: new RegExp(escapeRe(opts.name)) });
  const before = await rows.count();

  await page.getByLabel("Full name").fill(opts.name);
  if (opts.dob) await page.getByLabel("DOB (eligibility only)").fill(opts.dob);
  await page.getByRole("button", { name: "Add player" }).click();

  await expect
    .poll(() => rows.count(), {
      timeout: 15_000,
      message: `roster row for "${opts.name}" after Add player`,
    })
    .toBe(before + 1);

  const id = await rows.nth(before).locator("[data-merge-pick]").getAttribute("data-merge-pick");
  if (!id) throw new Error(`no person id on the row for "${opts.name}"`);
  return id;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the duplicate queue proposes a real pair and suppresses a false one", async ({ page }) => {
  failOnNativeDialog(page);
  const s = stamp();
  await freshOrg(page, "identity");
  await page.goto("/directory?tab=players");

  // One human, entered twice: same folded name, same dob. The queue's entry
  // ticket is a shared normalised name; the matching dob raises the rank.
  const twinName = `Alex Morgan ${s}`;
  const keepId = await addPerson(page, { name: twinName, dob: "1990-04-02" });
  const dupeId = await addPerson(page, { name: twinName, dob: "1990-04-02" });

  // A DIFFERENT human who happens to share the name. A differing non-null dob
  // SUPPRESSES the pair outright (person-duplicates.ts) — it is the strongest
  // evidence in the data that these are two people.
  const otherId = await addPerson(page, { name: twinName, dob: "1986-11-19" });

  await page.reload();

  const pair = queue(page).locator(`[data-candidate="${keepId}:${dupeId}"]`);
  await expect(pair).toBeVisible({ timeout: 15_000 });

  // data-evidence-on, NOT mere presence: all three chips always render
  // (duplicates-panel.tsx — "Three signals, always all three"), so a presence
  // assertion would pass on its own inversion. The `false` below is what proves
  // these three read a varying attribute rather than three identical `true`s.
  await expect(pair.locator('[data-evidence-kind="name"]')).toHaveAttribute(
    "data-evidence-on",
    "true",
  );
  await expect(pair.locator('[data-evidence-kind="dob"]')).toHaveAttribute(
    "data-evidence-on",
    "true",
  );
  // Nobody has been entered into an entrant, so the third signal must be off.
  await expect(pair.locator('[data-evidence-kind="shared_entrant"]')).toHaveAttribute(
    "data-evidence-on",
    "false",
  );

  // The suppression. The third person must appear in NO pair, in either order.
  for (const id of [keepId, dupeId]) {
    await expect(queue(page).locator(`[data-candidate="${otherId}:${id}"]`)).toHaveCount(0);
    await expect(queue(page).locator(`[data-candidate="${id}:${otherId}"]`)).toHaveCount(0);
  }
  // And the queue holds exactly the one pair — assertable only because the org
  // is this spec's own.
  await expect(queue(page).locator("[data-candidate]")).toHaveCount(1);
});
