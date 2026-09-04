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
 * CSVs stay tiny. The live community numbers at the time of writing are
 * `clubs.max` 5, `import.bulk` 50 and `teams.max` 8 (queried from
 * `plan_entitlements`, not read off a migration — `imports.ts`'s own
 * "Community capped at 20 rows/file" comment is stale by a factor of 2.5). Driving `import.bulk` from its real
 * value would mean uploading fifty rows to make a point about the fifty-first;
 * and driving either from the catalog would make this spec's row arithmetic a
 * hostage to the next re-pricing, which is a change that should move the
 * CATALOG assertion above and nothing else.
 *
 * `teams.max` is the exception: it is asserted and never overridden, because
 * every CSV row below creates a team as well as a club and `commitImport`
 * checks it immediately after `clubs.max`. Nothing in this journey wants to
 * cross it, so the guard states the only thing that matters — the live row is
 * big enough to stay out of the way. A re-valued row then names itself up
 * front instead of 402ing on a key this spec never otherwise mentions, which
 * arrives as an opaque `committed` timeout three steps downstream.
 *
 * And each override is READ BACK through `liveLimit` after it is written. On a
 * target with no `REDIS_URL` the entitlement cache is inert and
 * `invalidateOrgEntitlements` is unfalsifiable by construction, so without the
 * read-back nothing here could tell an override that landed from one that
 * never did — on the machine where it matters, the one WITH a live cache.
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
 * It pins that the refusal WROTE NOTHING, and it is genuinely load-bearing.
 * Measured: hoisting `executePlan` ABOVE the cap check and raising the refusal
 * after the transaction has committed — the "writes land, then we say no" shape
 * — leaves the 402 and both `data-feature` assertions green and fails HERE,
 * `Expected: 2 / Received: 5`. Nothing else in this spec notices.
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
 * It is also counted on TWO registers, not one. An import writes clubs, teams
 * AND persons, so a change that pre-created this file's people before reaching
 * the cap gate would leak one orphan person per row of the refused file, every
 * time it was retried, while the club count stayed exactly where this spec
 * pinned it. The players tab is the
 * cheapest second witness — one row per CSV row, on a fresh org that has no
 * other people in it.
 *
 * Both counts are PINNED to a number, before and after, never asserted as
 * "unchanged". `toHaveCount(n)` against a locator that resolves to zero
 * elements is satisfied by n = 0, so an "unchanged" pair of zeroes would pass
 * for a stamp that matches nothing at all. Each is also pinned at a SECOND,
 * different value after the final commit, so a locator that had quietly
 * stopped matching could not sit at one constant and satisfy both.
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

/** The overridden `clubs.max`. Small enough that CSV #2 crosses it from a
 *  two-club org, large enough that the hand-created club and the first CSV
 *  both fit under it. */
const CAP = 3;
/** The overridden `import.bulk` — rows PER FILE, not per org, so it constrains
 *  the upload and nothing else. */
const ROWS = 5;
/** One club by hand, one from the first CSV. Written out rather than typed as
 *  "2" so the count assertions below say where each row came from. */
const HAND_CLUBS = 1;
const FIRST_CSV_CLUBS = 1;
/** The clubs in the file that gets REFUSED. Two, not three, and the margin is
 *  the point. `assertWithinLimit` refuses on `existing + planned > limit`, so
 *  three would put this org at 2 + 3 = 5 against a live community `clubs.max`
 *  of 5 — a single re-valuation (5 -> 4) away from a step that refuses on the
 *  PLAN and would go on passing with the override deleted. Two makes it 4, and
 *  the catalog guard asserts that distance against the live row rather than
 *  trusting this comment to stay true. */
const SECOND_CSV_CLUBS = 2;

test("the importer refuses at two different caps, and writes nothing when it does", async ({
  page,
}) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "clubs");
  // The consent banner is `fixed bottom-4 … z-40` and intercepts pointer
  // events over the last card on a page — here, the wizard's Commit button.
  await dismissConsent(page);

  // --- (a) the catalog still HAS these rows, and can carry the journey ----
  // No hardcoded plan value: a re-valued row must move this test, and a
  // DELETED row must fail loudly right here rather than as a 402 later
  // (`liveLimit` throws by name on a missing row, which `getLimit` would
  // otherwise resolve to 0 and refuse everything with).
  const catalogClubsMax = await liveLimit(page, orgId, "clubs.max");
  const catalogBulk = await liveLimit(page, orgId, "import.bulk");
  const catalogTeamsMax = await liveLimit(page, orgId, "teams.max");
  expect(catalogBulk === null || catalogBulk > 0).toBe(true);

  // `clubs.max` is overridden below, so its plan value has only one job: to be
  // loose enough that the PLAN could never be the thing that refuses CSV #2.
  // The day it is, the override is dead and the refusal proves nothing —
  // silently, and in the passing direction. Stated against the live row rather
  // than against the 5 written in the docblock, so a re-pricing moves it.
  const REFUSED_WOULD_BE = HAND_CLUBS + FIRST_CSV_CLUBS + SECOND_CSV_CLUBS;
  expect(
    catalogClubsMax === null || REFUSED_WOULD_BE <= catalogClubsMax,
    `community clubs.max is ${catalogClubsMax}; CSV #2 asks for ${REFUSED_WOULD_BE} clubs, which the PLAN would ` +
      "already refuse — the override under test would then be dead and this journey vacuous. Lower SECOND_CSV_CLUBS.",
  ).toBe(true);

  // `teams.max` is never overridden: this journey rides its live plan value,
  // because every CSV row below creates a team as well as a club and
  // `commitImport` checks it immediately after `clubs.max` (imports.ts). What
  // is asserted is that it stays OUT OF THE WAY — a re-valued row names itself
  // here instead of 402ing on a key this spec never mentions.
  const TEAMS_COMMITTED = FIRST_CSV_CLUBS + SECOND_CSV_CLUBS;
  expect(
    catalogTeamsMax === null || TEAMS_COMMITTED <= catalogTeamsMax,
    `community teams.max is ${catalogTeamsMax} and this journey commits ${TEAMS_COMMITTED} teams — ` +
      "the imports below would be refused on teams.max, not on the cap under test",
  ).toBe(true);

  // --- (b) pin small, deterministic caps for the journey itself -----------
  await setEntitlementOverrideSql(orgId, "clubs.max", CAP);
  await setEntitlementOverrideSql(orgId, "import.bulk", ROWS);
  // (a) resolved BOTH of these keys for this org and warmed the 300s cache.
  await invalidateOrgEntitlements(page.request, orgId);
  // ...and the resolver now says so. Without these two lines the invalidation
  // is unfalsifiable on this machine — `lib/cache.ts` is fail-open and
  // `REDIS_URL` is unset, so a missing invalidate is green here and red only
  // on a Redis-backed target. Reading the value back makes both calls
  // self-checking wherever the cache IS live, and catches an override that
  // never landed at all.
  expect(await liveLimit(page, orgId, "clubs.max"), "the clubs.max override did not take").toBe(CAP);
  expect(await liveLimit(page, orgId, "import.bulk"), "the import.bulk override did not take").toBe(ROWS);

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

  // The second register. `PersonsPanel` renders through `ResponsiveTable`,
  // which emits every row TWICE — a `hidden sm:block` <table> and an
  // `sm:hidden` card <ul>, both carrying `aria-label="Players"`. A CSS or
  // testid locator would therefore double-count; `getByRole` does not, because
  // the role engine skips what is hidden from the accessibility tree, and this
  // project runs Desktop Chrome. Scoped to that table so the duplicate-suggestion
  // panel above it (its own <li> list, not rows) cannot join in.
  const playerRows = page
    .getByRole("table", { name: "Players" })
    .getByRole("row")
    .filter({ hasText: s });

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
  await upload(clubRowsCsv(SECOND_CSV_CLUBS, "Beta"), "over-cap.csv");
  await expect(
    page.getByRole("heading", { name: `Preview — over-cap.csv (${SECOND_CSV_CLUBS} rows)` }),
  ).toBeVisible();
  // The plan the wizard is about to commit, in its own words. This is the one
  // assertion that can tell "the cap refused two new clubs" from "the CSV
  // parsed as nothing and the cap refused an empty plan" — `participantCsv`'s
  // Club/Team/Player headers are aliases resolved server-side
  // (import-parse.ts), and a rename there would otherwise leave every
  // assertion below passing for the wrong reason.
  await expect(
    page.locator("p").filter({ hasText: /clubs · .* teams · .* players/ }),
  ).toHaveText(
    new RegExp(`^${SECOND_CSV_CLUBS} clubs · ${SECOND_CSV_CLUBS} teams · ${SECOND_CSV_CLUBS} players\\b`),
  );

  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(clubsGate).toBeVisible({ timeout: 20_000 });
  await expect(bulkGate).toHaveCount(0);
  await expect(committed).toHaveCount(0);

  // The refusal wrote NOTHING — pinned to a number, not to "unchanged", and on
  // both registers the plan would have touched. A change that pre-created this
  // file's people before reaching the cap gate leaks persons and leaves the
  // club count untouched, so the clubs line alone cannot see it.
  await page.goto("/directory?tab=clubs");
  await expect(clubRows).toHaveCount(HAND_CLUBS + FIRST_CSV_CLUBS);
  await page.goto("/directory?tab=players");
  await expect(
    playerRows,
    "the refused import left people behind — clubs were rolled back, persons were not",
  ).toHaveCount(FIRST_CSV_CLUBS);

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
  expect(await liveLimit(page, orgId, "clubs.max"), "the raised clubs.max did not take").toBe(CAP + 10);
  await page.goto("/import");
  await upload(clubRowsCsv(SECOND_CSV_CLUBS, "Beta"), "over-cap.csv");
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(committed).toBeVisible({ timeout: 20_000 });

  // Only NOW do the two Beta clubs exist. The same file, the same plan, the
  // same wizard — the cap was the only thing that ever stood between them.
  await page.goto("/directory?tab=clubs");
  await expect(clubRows).toHaveCount(HAND_CLUBS + FIRST_CSV_CLUBS + SECOND_CSV_CLUBS);
  // The players count at a DIFFERENT value from the one it held at the
  // refusal: a locator that had quietly stopped matching would satisfy one
  // constant, never both.
  await page.goto("/directory?tab=players");
  await expect(playerRows).toHaveCount(FIRST_CSV_CLUBS + SECOND_CSV_CLUBS);
});
