import { test, expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, divisionPath, expectNoHorizontalScroll } from "./helpers";
import { closeOpenContexts } from "./spectator-public-helpers";
import { activeOrgSlug, division, leagueFixtures, publicCompetition, spectator } from "./spectator-w2-kit";

// An entrant's name, after it was created (reported from production
// 2026-09-22): pair "Sankar & Ritwik" swapped Ritwik for Venkatesh and kept the
// name "Sankar & Ritwik" — `display_name` was derived once at create, the
// roster save never touched it, and no screen could rename it.
//
// Two fixes, both driven here through the real console:
//   - the Name field at the top of an expanded entrant card (rename by hand);
//   - a roster save that renames a pair whose name was derived from its people.
// Each is proven across a RELOAD, so what is asserted is what the server
// stored, not what the page optimistically kept on screen. One test follows
// both through to where a spectator reads the name: the division's fixtures tab
// and the public division page, whose cached copy the write must expire.

const GENERIC = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedDivision(request: APIRequestContext, label: string): Promise<string> {
  const comp = (await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${TAG}`,
    visibility: "private",
  })).data!;
  const div = (await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
    name: "Doubles",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC,
  })).data!;
  return div.id;
}

async function seedPerson(request: APIRequestContext, fullName: string): Promise<string> {
  const res = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: fullName });
  expect(res.status, `person create failed: ${JSON.stringify(res.error)}`).toBe(201);
  return res.data!.id;
}

/** A pair created the way the console's add form creates one — its people
 *  picked, its name their full names joined with " & ". */
async function seedPair(
  request: APIRequestContext,
  divisionId: string,
  people: { id: string; name: string }[],
  displayName = people.map((p) => p.name).join(" & "),
): Promise<string> {
  const res = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    {
      kind: "pair",
      display_name: displayName,
      members: people.map((p) => ({ person_id: p.id, is_captain: false, roles: [] })),
    },
  ]);
  expect(res.status, `pair create failed: ${JSON.stringify(res.error)}`).toBe(201);
  return res.data![0]!.id;
}

async function storedName(request: APIRequestContext, entrantId: string): Promise<string> {
  return (await apiJson<{ display_name: string }>(request, `/api/v1/entrants/${entrantId}`)).data!.display_name;
}

/** The entrant's row-header toggle — the button that expands its card. */
const rowToggle = (page: Page, name: string) =>
  page.getByRole("cell", { name }).getByRole("button", { name, exact: false });

/** In an expanded card's roster editor, by hand: remove `out` (its own row's
 *  "remove"), find and add `incoming`, then save the roster. */
async function swapPartner(page: Page, out: string, incoming: string): Promise<void> {
  const roster = page.getByTestId("entrant-roster");
  await expect(roster.getByText(out, { exact: true })).toBeVisible();
  await roster
    .locator("div", { has: page.getByText(out, { exact: true }) })
    .last()
    .getByRole("button", { name: "remove" })
    .click();
  await roster.getByPlaceholder("Find player…").fill(incoming);
  await roster.getByRole("button", { name: `+ ${incoming}` }).click();
  await roster.getByRole("button", { name: "Save roster" }).click();
}

// Spectator contexts are closed here, never in a `finally` (a timeout skips it).
test.afterEach(async () => {
  await closeOpenContexts();
});

test("rename a pair from its expanded card: the name persists across a reload", async ({ page }) => {
  const divisionId = await seedDivision(page.request, "Rename");
  const sankar = { id: await seedPerson(page.request, `Sankar ${TAG}`), name: `Sankar ${TAG}` };
  const ritwik = { id: await seedPerson(page.request, `Ritwik ${TAG}`), name: `Ritwik ${TAG}` };
  const oldName = `${sankar.name} & ${ritwik.name}`;
  const newName = `Court Kings ${TAG}`;
  const pairId = await seedPair(page.request, divisionId, [sankar, ritwik]);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=entrants"));
  await rowToggle(page, oldName).click();

  const field = page.getByTestId("entrant-name-field");
  // The field OPENS AT the current name — a blank or stale seed would be one
  // blur away from a bad rename.
  await expect(field).toHaveValue(oldName);
  // Labelled, so a screen reader announces what it edits.
  await expect(field).toHaveAccessibleName("Name");

  await field.fill(newName);
  await field.press("Enter");

  // The row header follows the save (router.refresh), without a reload…
  await expect(rowToggle(page, newName)).toBeVisible();
  await expect.poll(() => storedName(page.request, pairId)).toBe(newName);

  // …and it is what the server stored: after a reload the old name is gone.
  await page.reload();
  await expect(rowToggle(page, newName)).toBeVisible();
  await expect(page.getByRole("cell", { name: oldName })).toHaveCount(0);
});

test("an emptied Name field puts the name back and saves nothing", async ({ page }) => {
  const divisionId = await seedDivision(page.request, "Rename Empty");
  const a = { id: await seedPerson(page.request, `Asha ${TAG}`), name: `Asha ${TAG}` };
  const b = { id: await seedPerson(page.request, `Bilal ${TAG}`), name: `Bilal ${TAG}` };
  const name = `${a.name} & ${b.name}`;
  const pairId = await seedPair(page.request, divisionId, [a, b]);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=entrants"));
  await rowToggle(page, name).click();
  const field = page.getByTestId("entrant-name-field");
  await expect(field).toHaveValue(name);

  const patches: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes(`/api/v1/entrants/${pairId}`)) patches.push(r.url());
  });
  await field.fill("   ");
  await field.blur();

  await expect(field).toHaveValue(name);
  expect(patches).toHaveLength(0);
  expect(await storedName(page.request, pairId)).toBe(name);
  // Positive pair for the "nothing saved" claim: the same listener DOES see a
  // real rename go out, so an empty `patches` above is not a deaf listener.
  await field.fill(`${name} Renamed`);
  await field.blur();
  await expect.poll(() => patches.length).toBe(1);
  await expect.poll(() => storedName(page.request, pairId)).toBe(`${name} Renamed`);
});

test("swapping a pair's partner in the roster editor renames the pair to match", async ({ page }) => {
  const divisionId = await seedDivision(page.request, "Roster Rename");
  const sankar = { id: await seedPerson(page.request, `Sankar ${TAG}`), name: `Sankar ${TAG}` };
  const ritwik = { id: await seedPerson(page.request, `Ritwik ${TAG}`), name: `Ritwik ${TAG}` };
  const venkatesh = { id: await seedPerson(page.request, `Venkatesh ${TAG}`), name: `Venkatesh ${TAG}` };
  const oldName = `${sankar.name} & ${ritwik.name}`;
  // Sankar stays in his seat; Venkatesh takes Ritwik's.
  const expected = `${sankar.name} & ${venkatesh.name}`;
  const pairId = await seedPair(page.request, divisionId, [sankar, ritwik]);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=entrants"));
  await rowToggle(page, oldName).click();
  // Remove Ritwik, add Venkatesh, save.
  await swapPartner(page, ritwik.name, venkatesh.name);

  // The header renames itself, and the Name field follows (it must not keep
  // the old name for the next blur to write straight back).
  await expect(rowToggle(page, expected)).toBeVisible();
  await expect(page.getByTestId("entrant-name-field")).toHaveValue(expected);
  await expect.poll(() => storedName(page.request, pairId)).toBe(expected);

  await page.reload();
  await expect(rowToggle(page, expected)).toBeVisible();
  await expect(page.getByRole("cell", { name: oldName })).toHaveCount(0);
});

test("a custom pair name survives a roster swap untouched", async ({ page }) => {
  const divisionId = await seedDivision(page.request, "Custom Name");
  const a = { id: await seedPerson(page.request, `Asha ${TAG}`), name: `Asha ${TAG}` };
  const b = { id: await seedPerson(page.request, `Bilal ${TAG}`), name: `Bilal ${TAG}` };
  const c = { id: await seedPerson(page.request, `Chen ${TAG}`), name: `Chen ${TAG}` };
  const custom = `Smash Bros ${TAG}`;
  const pairId = await seedPair(page.request, divisionId, [a, b], custom);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=entrants"));
  await rowToggle(page, custom).click();
  await swapPartner(page, b.name, c.name);
  // The roster save landed — read off the server, not the editor's own state…
  await expect
    .poll(async () =>
      ((await apiJson<{ members: { person_id: string }[] }>(page.request, `/api/v1/entrants/${pairId}`)).data!
        .members.map((m) => m.person_id)
        .sort()
        .join(",")),
    )
    .toBe([a.id, c.id].sort().join(","));
  // …and the organiser's own name was left alone.
  expect(await storedName(page.request, pairId)).toBe(custom);
  await page.reload();
  await expect(rowToggle(page, custom)).toBeVisible();
});

/** A raw write behind the app's back — the control below needs one that fires
 *  no revalidation. The shape of helpers' private `withDb`. */
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { connection: { search_path: "seazn_club" }, ssl: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The first VISIBLE element carrying `text`. The public page also lists every
 *  entrant as an `<option>` in a hidden filter, which `getByText(...).first()`
 *  lands on. Negative checks stay on `getByText` alone, hidden copies included. */
const shown = (scope: Page | Locator, text: string) => scope.getByText(text).filter({ visible: true }).first();

/** The public division page's schedule, as a signed-out spectator in a FRESH
 *  context — never a reload in one tab, which the browser's HTTP cache can
 *  answer instead of the server. */
async function publicSchedule(browser: Browser, path: string): Promise<Page> {
  const page = await spectator(browser, { width: 1280, height: 900 });
  const res = await page.goto(path, { waitUntil: "load" });
  expect(res?.status(), `public division page ${path}`).toBe(200);
  await expect(page.locator("#panel-schedule")).toBeVisible();
  return page;
}

/** The public page's own cache lifetime for a division (`REVALIDATE_FAST`,
 *  `server/public-site/data.ts`). A new name inside this window can only have
 *  come from the write expiring the page, not from the cache running out. */
const PUBLIC_DIVISION_TTL_MS = 30_000;

test("a renamed pair reads the same on the fixtures tab and the public page, straight away", async ({
  page,
  browser,
}) => {
  test.slow();
  // A public league with fixtures, so the name has somewhere downstream to go.
  const org = await activeOrgSlug(page.request);
  const comp = await publicCompetition(page.request, { name: `Rename Walk ${TAG}`, orgId: org.id });
  const div = await division(page.request, comp.id, {
    name: "Doubles",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC,
  });
  const sankar = { id: await seedPerson(page.request, `Sankar ${TAG}`), name: `Sankar ${TAG}` };
  const ritwik = { id: await seedPerson(page.request, `Ritwik ${TAG}`), name: `Ritwik ${TAG}` };
  const venkatesh = { id: await seedPerson(page.request, `Venkatesh ${TAG}`), name: `Venkatesh ${TAG}` };
  const derived = `${sankar.name} & ${ritwik.name}`;
  const followed = `${sankar.name} & ${venkatesh.name}`;
  const renamed = `Court Kings ${TAG}`;
  const pairId = await seedPair(page.request, div.id, [sankar, ritwik]);
  const controlId = await seedPair(page.request, div.id, [], `Control Pair ${TAG}`);
  await seedPair(page.request, div.id, [], `Third Pair ${TAG}`);
  const fixtures = await leagueFixtures(page.request, div.id);
  expect(
    fixtures.filter((f) => f.home_entrant_id === pairId || f.away_entrant_id === pairId).length,
    "the pair plays at least one fixture",
  ).toBeGreaterThan(0);
  const publicPath = `/shared/${org.slug}/${comp.slug}/${div.slug}`;
  const consoleEntrants = await divisionPath(page.request, div.id, "?tab=entrants");
  const consoleFixtures = await divisionPath(page.request, div.id, "?tab=fixtures");

  // Warm the public page: it caches the pair under its created name. Each
  // clock starts BEFORE the load that fills the cache, so the bound errs long.
  const warmedAt = Date.now();
  const warm = await publicSchedule(browser, publicPath);
  await expect(shown(warm.locator("#panel-schedule"), derived)).toBeVisible();

  // Control — the page really is cached: a write that fires no revalidation is
  // NOT on the next load. Without this, a page that never cached would pass
  // every "straight away" assertion below vacuously.
  await withDb((sql) => sql`update entrants set display_name = ${`Control Moved ${TAG}`} where id = ${controlId}`);
  const control = await publicSchedule(browser, publicPath);
  await expect(shown(control.locator("#panel-schedule"), `Control Pair ${TAG}`)).toBeVisible();
  await expect(control.getByText(`Control Moved ${TAG}`)).toHaveCount(0);

  // Step 1 — the roster swap, by hand: Venkatesh takes Ritwik's seat.
  await page.goto(consoleEntrants);
  await rowToggle(page, derived).click();
  await swapPartner(page, ritwik.name, venkatesh.name);
  await expect(rowToggle(page, followed)).toBeVisible();

  // The organiser's fixtures tab names the pair by its new name…
  await page.goto(consoleFixtures);
  await expect(shown(page, followed)).toBeVisible();
  await expect(page.getByText(derived)).toHaveCount(0);
  // …and so does the public page, on its very next load.
  const swapSeenAt = Date.now();
  const afterSwap = await publicSchedule(browser, publicPath);
  await expect(shown(afterSwap.locator("#panel-schedule"), followed)).toBeVisible();
  await expect(afterSwap.getByText(derived)).toHaveCount(0);
  // The whole division document was expired, not one row patched: the control
  // pair's raw write surfaces with it.
  await expect(shown(afterSwap.locator("#panel-schedule"), `Control Moved ${TAG}`)).toBeVisible();
  expect(Date.now() - warmedAt, "the swap reached the public page inside its cache lifetime").toBeLessThan(
    PUBLIC_DIVISION_TTL_MS,
  );

  // Step 2 — the Name field, by hand.
  await page.goto(consoleEntrants);
  await rowToggle(page, followed).click();
  const field = page.getByTestId("entrant-name-field");
  await expect(field).toHaveValue(followed);
  await field.fill(renamed);
  await field.press("Enter");
  await expect(rowToggle(page, renamed)).toBeVisible();

  await page.goto(consoleFixtures);
  await expect(shown(page, renamed)).toBeVisible();
  await expect(page.getByText(followed)).toHaveCount(0);
  const afterRename = await publicSchedule(browser, publicPath);
  await expect(shown(afterRename.locator("#panel-schedule"), renamed)).toBeVisible();
  await expect(afterRename.getByText(followed)).toHaveCount(0);
  expect(Date.now() - swapSeenAt, "the rename reached the public page inside its cache lifetime").toBeLessThan(
    PUBLIC_DIVISION_TTL_MS,
  );
  expect(await storedName(page.request, pairId)).toBe(renamed);
});

test("the expanded card with its Name field never scrolls the page sideways at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const divisionId = await seedDivision(page.request, "Narrow");
  // A realistic long pair name — the shape that finds a missing min-w-0.
  const a = { id: await seedPerson(page.request, `Venkatasubramanian ${TAG}`), name: `Venkatasubramanian ${TAG}` };
  const b = { id: await seedPerson(page.request, `Chandrasekharan ${TAG}`), name: `Chandrasekharan ${TAG}` };
  const name = `${a.name} & ${b.name}`;
  await seedPair(page.request, divisionId, [a, b]);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=entrants"));
  await rowToggle(page, name).click();
  const field = page.getByTestId("entrant-name-field");
  await expect(field).toHaveValue(name);
  await expectNoHorizontalScroll(page);
  // The field is reachable and usable at this width, not merely present.
  const box = await field.boundingBox();
  expect(box, "the Name field has no box at 320px").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  // …and whole on screen. The expanded cell spans the entrants table, which is
  // wider than a phone and scrolls inside its card — so the page never scrolls
  // sideways, yet an uncapped field ran 384px wide off the card's right edge,
  // its end reachable only by swiping the table. Its right edge must sit
  // inside the card's visible box.
  const card = await page.locator("section.card").filter({ has: field }).boundingBox();
  expect(card, "the entrants card has no box at 320px").not.toBeNull();
  expect(box!.x + box!.width, "the Name field runs off the card's right edge").toBeLessThanOrEqual(
    card!.x + card!.width,
  );
});
