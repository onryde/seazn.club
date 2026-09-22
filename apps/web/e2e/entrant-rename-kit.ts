// The pieces both entrant-rename specs drive the console with:
// e2e/entrant-rename.spec.ts (the edge cases, one per test) and
// e2e/walkthrough/entrant-rename-walkthrough.spec.ts (one organiser's whole
// journey). Seeding goes through the real API; everything named `stage…`,
// `save…` or `…pencil` is a control the organiser drives by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { rosterDerivedName } from "../src/lib/entrant-roster-name";
import { apiJson } from "./helpers";
import { uniqueName } from "./directory-kit";
import { spectator } from "./spectator-w2-kit";

/** The console's own copy, read from the dictionary rather than retyped. */
export const uiEn = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The name the console gives a pair of these people: the create-time join
 *  itself (`rosterDerivedName`), never a hand-typed " & ". */
export const derivedFrom = (...people: { name: string }[]) => rosterDerivedName(people.map((p) => p.name));

/** A score-only generic league, so fixtures exist without a sport's rules. */
export const GENERIC = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

export async function seedPerson(request: APIRequestContext, fullName: string): Promise<string> {
  const res = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: fullName });
  expect(res.status, `person create failed: ${JSON.stringify(res.error)}`).toBe(201);
  return res.data!.id;
}

/** A player whose name no other test shares. `TAG` is per WORKER, so two tests
 *  that ran in one worker each made a "Venkatesh {TAG}" in the shared org, and
 *  the roster editor's player search then offered both: a strict-mode red
 *  that depended on which worker a test landed in. */
export async function seedPlayer(request: APIRequestContext, label: string): Promise<{ id: string; name: string }> {
  const name = uniqueName(label);
  return { id: await seedPerson(request, name), name };
}

/** A pair created the way the console's add form creates one — its people
 *  picked, its name the create-time join of their full names. */
export async function seedPair(
  request: APIRequestContext,
  divisionId: string,
  people: { id: string; name: string }[],
  displayName = derivedFrom(...people),
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

/** The entrant's name as the SERVER holds it. */
export async function storedName(request: APIRequestContext, entrantId: string): Promise<string> {
  return (await apiJson<{ display_name: string }>(request, `/api/v1/entrants/${entrantId}`)).data!.display_name;
}

/** The entrant's member ids as the SERVER holds them, sorted. */
export async function storedMembers(request: APIRequestContext, entrantId: string): Promise<string> {
  const res = await apiJson<{ members: { person_id: string }[] }>(request, `/api/v1/entrants/${entrantId}`);
  return res.data!.members.map((m) => m.person_id).sort().join(",");
}

/** The entrant's row-header toggle — the button that expands its card. */
export const rowToggle = (page: Page, name: string) =>
  page.getByRole("cell", { name }).getByRole("button", { name, exact: false });

/** In an expanded card's roster editor, by hand: remove `out` (its own row's
 *  "remove"), then find and add `incoming`. Nothing is saved yet. */
export async function stagePartnerSwap(page: Page, out: string, incoming: string): Promise<void> {
  const roster = page.getByTestId("entrant-roster");
  await expect(roster.getByText(out, { exact: true })).toBeVisible();
  await roster
    .locator("div", { has: page.getByText(out, { exact: true }) })
    .last()
    .getByRole("button", { name: "remove" })
    .click();
  await roster.getByPlaceholder("Find player…").fill(incoming);
  await roster.getByRole("button", { name: `+ ${incoming}` }).click();
}

export const saveRoster = (page: Page) =>
  page.getByTestId("entrant-roster").getByRole("button", { name: "Save roster" });

/** Stage the swap, then save the roster. */
export async function swapPartner(page: Page, out: string, incoming: string): Promise<void> {
  await stagePartnerSwap(page, out, incoming);
  await saveRoster(page).click();
}

/** The ✎ beside a player's name in the directory. Its name comes from the
 *  dictionary, so a visible-label change moves the specs with it. */
export const personPencil = (page: Page, name: string) =>
  page.getByRole("button", { name: uiEn["persons.rename"]!.replace("{name}", name), exact: true });

/** The first VISIBLE element carrying `text`. The public page also lists every
 *  entrant as an `<option>` in a hidden filter, which `getByText(...).first()`
 *  lands on. Negative checks stay on `getByText` alone, hidden copies included. */
export const shown = (scope: Page | Locator, text: string) =>
  scope.getByText(text).filter({ visible: true }).first();

/** A public division page as a signed-out spectator in a FRESH context — never
 *  a reload in one tab, which the browser's HTTP cache can answer instead of
 *  the server. `path` may carry `?tab=`; the panel it opens is awaited. */
export async function publicDivision(browser: Browser, path: string, panel = "schedule"): Promise<Page> {
  const page = await spectator(browser, { width: 1280, height: 900 });
  const res = await page.goto(path, { waitUntil: "load" });
  expect(res?.status(), `public division page ${path}`).toBe(200);
  await expect(page.locator(`#panel-${panel}`)).toBeVisible();
  return page;
}

/** The public page's own cache lifetime for a division (`REVALIDATE_FAST`,
 *  `server/public-site/data.ts`). A new name inside this window can only have
 *  come from the write expiring the page, not from the cache running out. */
export const PUBLIC_DIVISION_TTL_MS = 30_000;
