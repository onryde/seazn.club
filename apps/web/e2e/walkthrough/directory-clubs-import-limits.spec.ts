import { test, expect } from "@playwright/test";
import { failOnNativeDialog } from "../helpers";
import {
  dismissConsent,
  freshOrg,
  invalidateOrgEntitlements,
  liveLimit,
  participantCsv,
  setEntitlementOverrideSql,
  stamp,
  waitForHydration,
} from "../directory-kit";

/**
 * The organiser's bulk-load journey: one club by hand, then CSVs through
 * /import until a plan cap refuses one — and the proof that the refusal wrote
 * nothing.
 *
 * ## Two caps, two lifecycle stages, two feature keys
 *
 * `import.bulk` is checked in `createImport` (usecases/imports.ts) on the
 * UPLOAD, against `rows.length`, before a single row is planned. `clubs.max`
 * is checked in `commitImport`, against `count(*) from clubs + plannedClubs`,
 * on the COMMIT of an already-previewed plan. Different keys, different
 * moments, different halves of the wizard. A spec that exercised one would be
 * proving one gate twice, and the wizard's own paywall branch is shared — the
 * SAME `setPaywallFeature` state renders both — so only the `data-feature`
 * value distinguishes them. It is also the only place either key reaches the
 * DOM (`UpgradeGate` in its non-compact form is a `div[data-feature="…"]`;
 * nothing else on the page names an entitlement key), which is why both
 * assertions are attribute-anchored rather than copy-anchored.
 *
 * ## Why the caps are OVERRIDDEN and the catalog is separately ASSERTED
 *
 * Two different jobs. `liveLimit` proves the matrix rows still EXIST: `getLimit`
 * resolves a missing row to 0 and refuses everything, so a deleted row would
 * otherwise surface as a baffling 402 three steps downstream instead of a
 * named failure here. The override then pins a small deterministic cap so the
 * CSVs stay tiny — the live community `clubs.max` is 20-ish and the live
 * `import.bulk` is 50, and deriving the journey from those would mean uploading
 * fifty rows to make a point about the fifty-first.
 *
 * `setEntitlementOverrideSql` writes `org_entitlement_overrides` by raw SQL and
 * invalidates NOTHING, while `lib/entitlements.ts` caches every resolution for
 * `ENT_TTL_SECONDS = 300`. `liveLimit` IS a first resolution — the entitlements
 * route runs every value through `getLimit` — so it warms the cache for exactly
 * the keys this spec then overrides. Every override below is therefore followed
 * by `invalidateOrgEntitlements` before the next read. Skipping it is green on a
 * machine with no `REDIS_URL` (lib/cache.ts is fail-open) and red on a
 * Redis-backed target, which is the worst shape a miss can have.
 *
 * ## What the "club count is unchanged" assertion actually pins
 *
 * It pins that the refusal WROTE NOTHING, and it is genuinely load-bearing:
 * moving `executePlan` ahead of the cap check so its writes land and are then
 * refused turns it red while every other assertion here stays green (measured).
 *
 * What it does NOT isolate is atomicity. In this code path the `clubs.max`
 * check is a PRE-FLIGHT aggregate — `count(*) + plannedClubs`, evaluated before
 * `executePlan` writes a row — so "nothing was written" is guaranteed twice
 * over: by the check's placement AND by the surrounding transaction. Each
 * covers for the other, and a mutant that removes only the transaction leaves
 * this green because the check still fires first. Read it as "the refusal is
 * pre-flight and total", not as "the commit is one transaction"; the latter is
 * true (`commitImport` opens exactly one `withTenant`) but is not what any
 * assertion here can witness.
 *
 * Both counts are PINNED to a number, before and after, never asserted as
 * "unchanged". `toHaveCount(n)` against a locator that resolves to zero
 * elements is satisfied by n = 0, so an "unchanged" pair of zeroes would pass
 * for a stamp that matches nothing at all.
 *
 * ## Fresh org
 *
 * The walkthrough project's storageState is a shared Pro org — its club table
 * carries every other spec's leavings, so `count(*) from clubs` would be
 * whatever the leg happened to run first, and no cap could be crossed
 * deterministically. `freshOrg` also arrives on `community`, where
 * `clubs.hierarchy` is granted (all five plan keys carry it), so the club-shaped
 * ops below are refused for their COUNT and never for the feature itself.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** The overridden `clubs.max`. Small enough that three CSV rows cross it from
 *  a two-club org, large enough that the hand-created club and the first CSV
 *  both fit under it. */
const CAP = 3;
/** The overridden `import.bulk` — rows PER FILE, not per org, so it constrains
 *  the upload and nothing else. */
const ROWS = 5;
/** One club by hand, one from the first CSV. Written out rather than typed as
 *  "2" so the count assertions below say where each row came from. */
const HAND_CLUBS = 1;
const FIRST_CSV_CLUBS = 1;

test("the importer refuses at two different caps, and writes nothing when it does", async ({
  page,
}) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "clubs");
  // The consent banner is `fixed bottom-4 … z-40` and intercepts pointer
  // events over the last card on a page — here, the wizard's Commit button.
  await dismissConsent(page);

  // --- (a) the catalog still HAS these rows -------------------------------
  // No hardcoded plan value: a re-valued row must move this test, and a
  // DELETED row must fail loudly right here rather than as a 402 later.
  const catalogClubsMax = await liveLimit(page, orgId, "clubs.max");
  const catalogBulk = await liveLimit(page, orgId, "import.bulk");
  expect(catalogClubsMax === null || catalogClubsMax > 0).toBe(true);
  expect(catalogBulk === null || catalogBulk > 0).toBe(true);

  // --- (b) pin small, deterministic caps for the journey itself -----------
  await setEntitlementOverrideSql(orgId, "clubs.max", CAP);
  await setEntitlementOverrideSql(orgId, "import.bulk", ROWS);
  // (a) resolved BOTH of these keys for this org and warmed the 300s cache.
  await invalidateOrgEntitlements(page.request, orgId);

  // --- one club, by hand, through the tab's own form ----------------------
  await page.goto("/directory?tab=clubs");
  const newClub = page.getByRole("button", { name: "New club" });
  // The counts and the button's presence are all satisfied by the SSR markup,
  // so none of them gate a click. Wait on a signal the server cannot emit.
  await waitForHydration(newClub);
  await newClub.click();
  const firstClub = `Harbour ${s}`;
  await page.getByLabel("Club name").fill(firstClub);
  await page.getByRole("button", { name: "Create" }).click();
  // Creating a club router.pushes to the club hub — the redirect is the only
  // confirmation the form gives.
  await expect(page).toHaveURL(/\/clubs\/[0-9a-f-]{36}/, { timeout: 15_000 });

  // Every club row in the register is `<Link href="/clubs/{id}">` with the club
  // name as its text (clubs-teams-list.tsx). Anchored on the HREF, not on a
  // role name: the file carries no testids and the accessible name also folds
  // in the crest's initials and an optional short name. Teams inside a club are
  // rendered as a COUNT, and standalone teams as a <button>, so this selects
  // clubs and only clubs. Filtered by the stamp so a future shared-fixture
  // change cannot quietly widen it.
  const clubRows = page.locator('a[href^="/clubs/"]').filter({ hasText: s });

  await page.goto("/directory?tab=clubs");
  await expect(clubRows).toHaveCount(HAND_CLUBS);

  // The link's own copy is `directory.clubs.import` = "Bulk import
  // participants", not "Import" — matched on the href, which is locale-stable.
  await page.locator('a[href="/import"]').click();
  await expect(page).toHaveURL(/\/import$/);

  const fileInput = page.locator('input[type="file"]');
  /** There is no submit button: the wizard uploads from the input's `change`
   *  handler, so an unhydrated input silently swallows the file. */
  const upload = async (csv: string, filename: string) => {
    await waitForHydration(fileInput);
    await fileInput.setInputFiles({
      name: filename,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  };

  const clubRowsCsv = (n: number, prefix: string) =>
    participantCsv(
      Array.from({ length: n }, (_, i) => ({
        club: `${prefix} ${i} ${s}`,
        team: `${prefix} ${i} U13 ${s}`,
        player: `Player ${prefix} ${i} ${s}`,
      })),
    );

  const committed = page.getByRole("heading", { name: "Import committed" });
  const clubsGate = page.locator('[data-feature="clubs.max"]');
  const bulkGate = page.locator('[data-feature="import.bulk"]');

  // --- CSV #1: one more club, under the cap. Commits. ---------------------
  await upload(clubRowsCsv(FIRST_CSV_CLUBS, "Alpha"), "one.csv");
  await expect(
    page.getByRole("heading", { name: `Preview — one.csv (${FIRST_CSV_CLUBS} rows)` }),
  ).toBeVisible();
  // `Commit import`, NOT `/commit import/i`: the same button reads "Fix errors
  // to commit" whenever any issue is `severity:"error"`, so an exact name is
  // what makes a blocked plan fail here instead of clicking a disabled button.
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(committed).toBeVisible({ timeout: 20_000 });

  await page.goto("/directory?tab=clubs");
  await expect(clubRows).toHaveCount(HAND_CLUBS + FIRST_CSV_CLUBS);

  // --- CSV #2: crosses clubs.max. Refused at COMMIT. ----------------------
  await page.goto("/import");
  await upload(clubRowsCsv(CAP, "Beta"), "over-cap.csv");
  await expect(
    page.getByRole("heading", { name: `Preview — over-cap.csv (${CAP} rows)` }),
  ).toBeVisible();
  // The plan the wizard is about to commit, in its own words. This is the one
  // assertion that can tell "the cap refused three new clubs" from "the CSV
  // parsed as nothing and the cap refused an empty plan" — `participantCsv`'s
  // Club/Team/Player headers are aliases resolved server-side
  // (import-parse.ts), and a rename there would otherwise leave every
  // assertion below passing for the wrong reason.
  await expect(
    page.locator("p").filter({ hasText: /clubs · .* teams · .* players/ }),
  ).toHaveText(new RegExp(`^${CAP} clubs · ${CAP} teams · ${CAP} players\\b`));

  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(clubsGate).toBeVisible({ timeout: 20_000 });
  await expect(bulkGate).toHaveCount(0);
  await expect(committed).toHaveCount(0);

  // The refusal wrote NOTHING — pinned to a number, not to "unchanged".
  await page.goto("/directory?tab=clubs");
  await expect(clubRows).toHaveCount(HAND_CLUBS + FIRST_CSV_CLUBS);

  // --- CSV #3: too many ROWS. Refused at CREATE, different key. -----------
  await page.goto("/import");
  await upload(clubRowsCsv(ROWS + 1, "Gamma"), "too-many-rows.csv");
  await expect(bulkGate).toBeVisible({ timeout: 20_000 });
  await expect(clubsGate).toHaveCount(0);
  // Never previewed at all: the refusal is ahead of `planImport`. The positive
  // pair for this negative is the two headings asserted VISIBLE above — the
  // same locator, on the same page, in the accepted case.
  await expect(page.getByRole("heading", { name: /^Preview — / })).toHaveCount(0);

  // --- raise clubs.max; the same file now commits -------------------------
  await setEntitlementOverrideSql(orgId, "clubs.max", CAP + 10);
  await invalidateOrgEntitlements(page.request, orgId);
  await page.goto("/import");
  await upload(clubRowsCsv(CAP, "Beta"), "over-cap.csv");
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(committed).toBeVisible({ timeout: 20_000 });

  // Only NOW do the three Beta clubs exist. The same file, the same plan, the
  // same wizard — the cap was the only thing that ever stood between them.
  await page.goto("/directory?tab=clubs");
  await expect(clubRows).toHaveCount(HAND_CLUBS + FIRST_CSV_CLUBS + CAP);
});
