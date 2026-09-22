// ONE organiser renames a pair, three ways, and follows each rename to every
// screen that names the pair — driven through the console, in the order it
// happens to them.
//
// Reported from production 2026-09-22: pair "Sankar & Ritwik" swapped Ritwik
// for Venkatesh and kept the name "Sankar & Ritwik". `display_name` was derived
// once at create, the roster save never touched it, and no screen could rename
// it. Three fixes, each one a control the organiser uses by hand here:
//
//   1. a roster save renames a pair whose name was derived from its people —
//      and the new name reaches the entrant row, the fixtures tab, the
//      standings and the public division page at once, not after the public
//      page's 30-second cache runs out;
//   2. the Name field on an expanded card: a name typed there and followed
//      straight away by a click on Save roster keeps BOTH (the field saves on
//      blur, which fires on that click's mousedown), and a pair with a name of
//      its own keeps it through a later roster swap;
//   3. the ✎ in the player directory: a player's rename moves every pair name
//      that was built from it, and leaves a pair's own name alone.
//
// WHY A WALKTHROUGH, given e2e/entrant-rename.spec.ts. That file proves each
// edge on its own — an emptied field, Escape, the IME rule, the public cache
// control — in a separate test with a separate pair. What none of its tests do
// is follow ONE pair through all three renames, where each rename starts from
// what the previous one left: the Name field on a pair the roster save just
// renamed, a directory rename of a player whose pair now carries a name of its
// own.
//
// WHAT IS A REACH AND WHAT IS THE TEST. Per this folder's README: the org, the
// public competition, its two divisions, the players, the pairs, the league
// fixtures and the one result that brings the standings into being are
// REACHES over the API. Every rename, and every screen the
// renames are read back from, is done in the browser.
import { test, expect } from "@playwright/test";
import { TAG, divisionPath, failOnNativeDialog, scoreFixture } from "../helpers";
import { closeOpenContexts } from "../spectator-public-helpers";
import { waitForHydration } from "../directory-kit";
import { division, leagueFixtures, mintSpectatorOrg, publicCompetition } from "../spectator-w2-kit";
import {
  GENERIC,
  PUBLIC_DIVISION_TTL_MS,
  derivedFrom,
  personPencil,
  publicDivision,
  rowToggle,
  saveRoster,
  seedPair,
  seedPerson,
  shown,
  stagePartnerSwap,
  storedMembers,
  storedName,
  swapPartner,
} from "../entrant-rename-kit";

/** The wait one full page load, and the reads on it, are given. */
const STEP_MS = 15_000;

/** Every full page load the journey makes, in order. The budget is derived
 *  from this list (AGENTS.md 20: a blown budget reports as whichever assertion
 *  was in flight, i.e. as a data defect), and the test counts its own loads
 *  and checks the count against the list at the end, so a load added without
 *  a line here fails loudly instead of quietly thinning the allowance. */
const LOADS = [
  "console: Doubles entrants (the swap is staged)",
  "public: Doubles, warm",
  "public: Doubles, after the swap",
  "public: Doubles standings",
  "console: Doubles fixtures",
  "console: Doubles standings",
  "console: Doubles entrants (name + Save roster)",
  "console: Doubles entrants, reloaded",
  "console: Doubles entrants, reloaded after the second swap",
  "console: Doubles fixtures, after the second swap",
  "public: Doubles, after the second swap",
  "console: directory",
  "public: Mixed, warm",
  "public: Mixed, after the player's rename",
  "console: Mixed entrants",
  "console: Doubles entrants, after the player's rename",
  "public: Doubles, after the player's rename",
] as const;

/** Seeding the org, two divisions, seven players, four pairs and two leagues. */
const SETUP_MS = 30_000;

test.setTimeout(SETUP_MS + LOADS.length * STEP_MS);

// Spectator contexts are closed here, never in a `finally` (a timeout skips it).
test.afterEach(async () => {
  await closeOpenContexts();
});

test("an organiser renames a pair three ways, and every screen that names it follows", async ({
  page,
  browser,
}) => {
  failOnNativeDialog(page);
  let loads = 0;
  const visit = async (path: string) => {
    loads += 1;
    await page.goto(path);
  };
  const spectate = async (path: string, panel?: string) => {
    loads += 1;
    return publicDivision(browser, path, panel);
  };

  // ---- Reach: a public league whose pair "Sankar & Ritwik" is in fixtures ----
  // A dedicated org, because the directory's Players tab lists only an org's
  // OLDEST 200 people (directory-kit's `freshOrg`), and the shared PRO org has
  // far more than that: the players seeded here would never be on the page.
  const org = await mintSpectatorOrg(page.request, { name: `Rename Walk ${TAG}`, plan: "pro" });
  const comp = await publicCompetition(page.request, { name: `Rename Walk ${TAG}`, orgId: org.id });
  const doubles = await division(page.request, comp.id, {
    name: "Doubles",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC,
  });
  const mixed = await division(page.request, comp.id, {
    name: "Mixed",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC,
  });
  const player = async (name: string) => ({ id: await seedPerson(page.request, name), name });
  const sankar = await player(`Sankar ${TAG}`);
  const ritwik = await player(`Ritwik ${TAG}`);
  const venkatesh = await player(`Venkatesh ${TAG}`); // the spare
  const asha = await player(`Asha ${TAG}`);
  const bilal = await player(`Bilal ${TAG}`);
  const chen = await player(`Chen ${TAG}`);
  const dev = await player(`Dev ${TAG}`);

  const created = derivedFrom(sankar, ritwik);
  const pairId = await seedPair(page.request, doubles.id, [sankar, ritwik]);
  const doublesRivals = derivedFrom(bilal, chen);
  await seedPair(page.request, doubles.id, [bilal, chen]);
  // Sankar also plays Mixed, in a pair named after its people.
  const mixedPair = derivedFrom(sankar, asha);
  const mixedPairId = await seedPair(page.request, mixed.id, [sankar, asha]);
  await seedPair(page.request, mixed.id, [dev, chen]);
  const doublesFixtureRows = await leagueFixtures(page.request, doubles.id);
  const played = doublesFixtureRows.find((f) => f.home_entrant_id === pairId || f.away_entrant_id === pairId);
  expect(played, "the pair plays a Doubles fixture").toBeDefined();
  // One result, so the Doubles standings exist: a league's table is written
  // when a result lands, and before one there is no table to name anybody.
  await scoreFixture(page.request, played!.id, 2, 1);
  expect((await leagueFixtures(page.request, mixed.id)).length, "Mixed has a fixture").toBeGreaterThan(0);

  const publicDoubles = `/shared/${org.slug}/${comp.slug}/${doubles.slug}`;
  const publicMixed = `/shared/${org.slug}/${comp.slug}/${mixed.slug}`;
  const doublesEntrants = await divisionPath(page.request, doubles.id, "?tab=entrants");
  const doublesFixtures = await divisionPath(page.request, doubles.id, "?tab=fixtures");
  const doublesStandings = await divisionPath(page.request, doubles.id, "?tab=standings");
  const mixedEntrants = await divisionPath(page.request, mixed.id, "?tab=entrants");

  // ---- 1. The roster save renames the pair, everywhere, at once ----
  // Staged first (Ritwik out, Venkatesh in, not saved), so the cache-lifetime
  // bound below spans only the warm load, the save and the next load.
  const followed = derivedFrom(sankar, venkatesh);
  await visit(doublesEntrants);
  await rowToggle(page, created).click();
  await stagePartnerSwap(page, ritwik.name, venkatesh.name);

  // The public page's first load caches it under the created name.
  const doublesWarmedAt = Date.now();
  const warm = await spectate(publicDoubles);
  await expect(shown(warm.locator("#panel-schedule"), created)).toBeVisible();

  await saveRoster(page).click();
  await expect(rowToggle(page, followed)).toBeVisible();

  const afterSwap = await spectate(publicDoubles);
  await expect(shown(afterSwap.locator("#panel-schedule"), followed)).toBeVisible();
  await expect(afterSwap.getByText(created)).toHaveCount(0);
  expect(Date.now() - doublesWarmedAt, "the swap reached the public page inside its cache lifetime").toBeLessThan(
    PUBLIC_DIVISION_TTL_MS,
  );
  const publicStandings = await spectate(`${publicDoubles}?tab=standings`, "standings");
  await expect(shown(publicStandings.locator("#panel-standings"), followed)).toBeVisible();
  await expect(publicStandings.getByText(created)).toHaveCount(0);

  await visit(doublesFixtures);
  await expect(shown(page, followed)).toBeVisible();
  await expect(page.getByText(created)).toHaveCount(0);
  await visit(doublesStandings);
  await expect(shown(page, followed)).toBeVisible();
  await expect(page.getByText(created)).toHaveCount(0);

  // ---- 2. A name of their own, typed and saved with a roster edit ----
  // The name is typed, and the organiser's very next click is Save roster, with
  // no blur first. The field's blur fires on that click's mousedown; both the
  // name and the roster edit must land.
  const smash = `Smash Bros ${TAG}`;
  await visit(doublesEntrants);
  await rowToggle(page, followed).click();
  await stagePartnerSwap(page, venkatesh.name, ritwik.name);
  await page.getByTestId("entrant-name-field").fill(smash);
  await saveRoster(page).click();
  await expect.poll(() => storedMembers(page.request, pairId)).toBe([sankar.id, ritwik.id].sort().join(","));
  await expect.poll(() => storedName(page.request, pairId)).toBe(smash);
  loads += 1;
  await page.reload();
  await expect(rowToggle(page, smash)).toBeVisible();

  // A later swap keeps the organiser's name: nothing derives over it.
  await rowToggle(page, smash).click();
  await swapPartner(page, ritwik.name, venkatesh.name);
  await expect.poll(() => storedMembers(page.request, pairId)).toBe([sankar.id, venkatesh.id].sort().join(","));
  loads += 1;
  await page.reload();
  await expect(rowToggle(page, smash)).toBeVisible();
  await expect(page.getByRole("cell", { name: followed })).toHaveCount(0);
  expect(await storedName(page.request, pairId)).toBe(smash);
  await visit(doublesFixtures);
  await expect(shown(page, smash)).toBeVisible();
  await expect(page.getByText(followed)).toHaveCount(0);
  const afterSmash = await spectate(publicDoubles);
  await expect(shown(afterSmash.locator("#panel-schedule"), smash)).toBeVisible();
  await expect(afterSmash.getByText(followed)).toHaveCount(0);

  // ---- 3. A player renamed from the directory ----
  // Sankar is in two pairs now: "Smash Bros" in Doubles (a name of its own) and
  // "Sankar & Asha" in Mixed (built from his name). Only the second follows.
  // The directory is loaded and the ✎ opened BEFORE the public page is warmed
  // (review 2, R2-5), so the cache-lifetime bound below spans the warm load,
  // the rename and the next load, never a console page load.
  const renamed = { ...sankar, name: `Sankar Krishnan ${TAG}` };
  await visit("/directory?tab=players");
  await waitForHydration(personPencil(page, sankar.name));
  await personPencil(page, sankar.name).click();
  const field = page.getByTestId("person-name-field");
  await expect(field).toHaveValue(sankar.name);

  const mixedWarmedAt = Date.now();
  const mixedWarm = await spectate(publicMixed);
  await expect(shown(mixedWarm.locator("#panel-schedule"), mixedPair)).toBeVisible();

  await field.fill(renamed.name);
  await field.press("Enter");
  await expect(personPencil(page, renamed.name)).toBeVisible();

  const mixedFollowed = derivedFrom(renamed, asha);
  const mixedAfter = await spectate(publicMixed);
  await expect(shown(mixedAfter.locator("#panel-schedule"), mixedFollowed)).toBeVisible();
  await expect(mixedAfter.getByText(mixedPair)).toHaveCount(0);
  expect(
    Date.now() - mixedWarmedAt,
    "the player's rename reached the public page inside its cache lifetime",
  ).toBeLessThan(PUBLIC_DIVISION_TTL_MS);
  expect(await storedName(page.request, mixedPairId)).toBe(mixedFollowed);

  await visit(mixedEntrants);
  await expect(rowToggle(page, mixedFollowed)).toBeVisible();
  await expect(page.getByRole("cell", { name: mixedPair })).toHaveCount(0);

  // "Smash Bros" is the organiser's own name, and stays.
  const smashIfDerived = derivedFrom(renamed, venkatesh);
  await visit(doublesEntrants);
  await expect(rowToggle(page, smash)).toBeVisible();
  await expect(page.getByRole("cell", { name: smashIfDerived })).toHaveCount(0);
  const doublesAfter = await spectate(publicDoubles);
  await expect(shown(doublesAfter.locator("#panel-schedule"), smash)).toBeVisible();
  await expect(doublesAfter.getByText(smashIfDerived)).toHaveCount(0);
  // The rivals' pair never moved through any of it.
  await expect(shown(doublesAfter.locator("#panel-schedule"), doublesRivals)).toBeVisible();
  expect(await storedName(page.request, pairId)).toBe(smash);

  expect(loads, "a page load was added or removed without updating LOADS").toBe(LOADS.length);
});
