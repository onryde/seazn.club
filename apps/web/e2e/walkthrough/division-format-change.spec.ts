/**
 * FMT5 (owner-approved 2026-11-03) — the division's format, changed from the Fixtures tab's Division rules card, walked by an
 * organiser end to end:
 *
 *   1. Build: a division with entrants and no stage. The card says "No format yet"; Format opens the builder's own picker,
 *      its estimates worked out for the division's REAL entrants; League saves with no confirm (nothing to clear), and the
 *      chip names it.
 *   2. Generate and schedule: the league's fixtures, some of them given a time on a court, and Remote scoring links on two
 *      of them through the real routes, one of them then revoked and reissued (so three links stand and two are live).
 *   3. The old Settings › Format address lands on the Fixtures tab with the Format dialog open.
 *   4. Format again: the confirm names what the change clears, counted from the board (the stage by name, the unplayed
 *      fixtures, the time slots on courts, the LIVE remote-scoring links that stop working - fix round 1, controller ruling
 *      I1: never the revoked one); Clear and change rebuilds the stages, and the fixtures, their schedule and every link are
 *      gone.
 *   5. One result: the Format button is greyed and says why ("Format is locked once scoring starts"), the old address opens
 *      no dialog, and the server refuses even a preview.
 *
 * Every state the owner looks at is shot at 320, 768, 1024 and 1280 with no horizontal page scroll. Every sentence asserted
 * is read from the dictionary (`uiEn`); every count is derived from the board the test built (a single round robin of n
 * plays n(n-1)/2), never from the code under test. One sport (generic) on purpose: the card and the dialog are drawn the same
 * way for every sport, and the server's sweep across sports is its own DB suite (format-change.test.ts).
 */
import { test, expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, scoreFixture, seedVenueWithCourts, withDb } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { uiEn } from "../match-room-kit";
import { STAGE_TEMPLATES } from "../../src/lib/format-templates";
import { formatButton, openFormatDialog, pickFormat, saveFormatDialog } from "../helpers/rules-strip";

const NAV_MS = 20_000;
const ACT_MS = 4_000;
const SEED_MS = 45_000;
const WIDTHS = [320, 768, 1024, 1280] as const;
const SHOT_MS = 3_000;
const budget = (navs: number, acts: number, shots: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS + shots * WIDTHS.length * SHOT_MS;

const ENTRANTS = ["Ana", "Ben", "Cy", "Di", "Eve", "Fin"];
/** A single round robin of n plays every pair once. */
const roundRobin = (n: number) => (n * (n - 1)) / 2;
/** The en plural form for a count (the dictionaries' `.one` / `.other`). */
const plural = (key: string, count: number, vars: Record<string, string | number> = {}): string => {
  const text = uiEn[`${key}.${count === 1 ? "one" : "other"}`];
  expect(text, `the dictionary holds ${key}`).toBeDefined();
  return Object.entries({ count, ...vars }).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text!);
};

async function seedDivision(request: APIRequestContext): Promise<{ divisionId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `FMT5 ${TAG}`, visibility: "private" });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Format Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const ents = await addEntrantsViaApi(request, div.data!.id, ENTRANTS.map((n) => `${n} ${TAG}`));
  expect(ents.ids, "entrants").toHaveLength(ENTRANTS.length);
  return { divisionId: div.data!.id };
}

type Stage = { id: string; name: string; kind: string };
const stagesOf = async (request: APIRequestContext, divisionId: string): Promise<Stage[]> => {
  const res = await apiJson<Stage[]>(request, `/api/v1/divisions/${divisionId}/stages`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!;
};
const fixturesOf = (divisionId: string) =>
  withDb(async (sql) => {
    const [row] = await sql<{ n: number; timed: number }[]>`
      select count(*)::int as n, count(*) filter (where scheduled_at is not null)::int as timed from fixtures where division_id = ${divisionId}`;
    return row!;
  });

/** The division's Remote scoring links (or, once its fixtures are gone, the links of `fixtureIds`), and how many are revoked. */
const linksOf = (divisionId: string, fixtureIds: readonly string[] = []) =>
  withDb(async (sql) => {
    const [row] = await sql<{ n: number; revoked: number }[]>`
      select count(*)::int as n, count(*) filter (where dl.revoked_at is not null)::int as revoked
        from device_links dl
       where dl.fixture_id in (select id from fixtures where division_id = ${divisionId})
          or dl.fixture_id = any(${[...fixtureIds]}::uuid[])`;
    return row!;
  });

/** Shoot `name` at every width, with no horizontal page scroll at any of them. `prepare` runs after each resize. */
async function shoot(page: Page, testInfo: TestInfo, name: string, prepare?: () => Promise<void>): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    if (prepare) await prepare();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe("FMT5: the format, changed from the Division rules card", () => {
  test("build, generate and schedule, then change the format behind a confirm that names what it clears; one result locks it", async ({ page, request }, testInfo) => {
    test.setTimeout(budget(10, 27, 5));
    const { divisionId } = await seedDivision(request);
    const base = (await divisionPath(request, divisionId)).split("?")[0]!;
    await page.setViewportSize({ width: 1280, height: 900 });

    // ---- 1. Build. No stage yet: the card says so, and Format is live.
    const button = await formatButton(page, base);
    await dismissCookieBanner(page);
    const chip = page.getByTestId("division-rules-format-chip");
    await expect(chip).toHaveText(uiEn["formatChange.chip.none"]!);
    await expect(button, "nothing played: Format is live").not.toHaveAttribute("aria-disabled", "true");
    await shoot(page, testInfo, "1-card-before-generation", async () => {
      await expect(button).toBeVisible();
    });

    const build = await openFormatDialog(page, base);
    // The estimates are the division's own: six entrants, a League of every pair once.
    await expect(build.getByTestId("division-builder-estimate-league")).toContainText(plural("divBuilder.card.matches", roundRobin(ENTRANTS.length)));
    await pickFormat(build, "league");
    await shoot(page, testInfo, "2-picker-open", async () => {
      await expect(build.getByTestId("division-format-dialog")).toBeVisible();
    });
    await saveFormatDialog(build).click();
    await expect(build, "nothing generated: Save replaces the stages with no confirm").toHaveCount(0, { timeout: NAV_MS });
    await expect(chip).toHaveText(uiEn["format.template.league.label"]!);
    const league = await stagesOf(request, divisionId);
    expect(league.map((st) => st.kind), "one league stage").toEqual(["league"]);

    // ---- 2. Generate and schedule: every pair once, four of them given a time on one of two courts.
    const gen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${league[0]!.id}/generate`, "POST");
    expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
    expect(gen.data!.fixtures, "a single round robin").toHaveLength(roundRobin(ENTRANTS.length));
    const { courts } = await seedVenueWithCourts(request, ["Court 1", "Court 2"]);
    const SCHEDULED = 4;
    const start = Date.UTC(2030, 5, 1, 9, 0, 0);
    for (let i = 0; i < SCHEDULED; i++) {
      const res = await apiJson(request, `/api/v1/fixtures/${gen.data!.fixtures[i]!.id}`, "PATCH", {
        scheduled_at: new Date(start + i * 60 * 60_000).toISOString(),
        court_id: courts[i % courts.length]!.id,
      });
      expect(res.status, `schedule fixture ${i}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
    }
    expect(await fixturesOf(divisionId), "premise: the board the confirm must name").toEqual({ n: roundRobin(ENTRANTS.length), timed: SCHEDULED });
    // Remote scoring links, through the routes the console calls: Remote scoring on boards 0 and 1, then Revoke & reissue on
    // board 0 (its first link dies, a new one is minted). So three links stand, and two of them work.
    const linked = [gen.data!.fixtures[0]!.id, gen.data!.fixtures[1]!.id];
    for (const [i, fixtureId] of linked.entries()) {
      const minted = await apiJson<{ id: string }>(request, `/api/v1/fixtures/${fixtureId}/device-links`, "POST", { label: `FMT5 phone ${i + 1}` });
      expect(minted.status, `link ${i + 1}: ${JSON.stringify(minted.error)}`).toBeLessThan(300);
    }
    const reissued = await apiJson<{ id: string }>(request, `/api/v1/fixtures/${linked[0]!}/device-links/reissue`, "POST", { label: "FMT5 phone 1b" });
    expect(reissued.status, `reissue: ${JSON.stringify(reissued.error)}`).toBeLessThan(300);
    const LIVE_LINKS = linked.length;
    expect(await linksOf(divisionId), "premise: three links, the reissued board's first one revoked").toEqual({ n: LIVE_LINKS + 1, revoked: 1 });

    // ---- 3. The old Settings › Format address lands on the Fixtures tab with the dialog open.
    await page.goto(`${base}?tab=settings&section=format`);
    await page.waitForURL(/\?tab=fixtures&format=open$/, { timeout: NAV_MS });
    const landed = page.getByRole("dialog");
    await expect(landed.getByTestId("division-format-dialog")).toBeVisible({ timeout: NAV_MS });
    await shoot(page, testInfo, "5-old-url-landing", async () => {
      await expect(landed.getByTestId("division-format-dialog")).toBeVisible();
    });

    // ---- 4. Format again: the confirm names what the change clears, then Clear and change rebuilds.
    await pickFormat(landed, "groups_ko");
    await saveFormatDialog(landed).click();
    const clears = landed.getByTestId("division-format-clears");
    await expect(clears).toBeVisible({ timeout: NAV_MS });
    expect(await clears.locator("li").evaluateAll((ls) => ls.map((l) => l.getAttribute("data-clear"))), "what it clears, and nothing else").toEqual([
      "stages",
      "fixtures",
      "slots",
      "remoteLinks",
    ]);
    await expect(clears.locator('[data-clear="stages"]')).toHaveText(plural("formatChange.confirm.stages", 1, { names: league[0]!.name }));
    await expect(clears.locator('[data-clear="fixtures"]')).toHaveText(plural("formatChange.confirm.fixtures", roundRobin(ENTRANTS.length)));
    await expect(clears.locator('[data-clear="slots"]')).toHaveText(
      plural("formatChange.confirm.slots", SCHEDULED, { places: plural("divBuilder.places.court", courts.length) }),
    );
    await expect(clears.locator('[data-clear="remoteLinks"]'), "the live links only, never the revoked one").toHaveText(
      plural("formatChange.confirm.remoteLinks", LIVE_LINKS),
    );
    await expect(landed.getByText(uiEn["formatChange.confirm.sheetsStop"]!)).toBeVisible();
    await expect(landed.getByTestId("division-format-clear")).toHaveText(uiEn["formatChange.confirm.clear"]!);
    await shoot(page, testInfo, "3-clear-confirm", async () => {
      await expect(clears).toBeVisible();
    });
    await landed.getByTestId("division-format-clear").click();
    await expect(landed, "cleared and rebuilt: the dialog closes").toHaveCount(0, { timeout: NAV_MS });
    await expect(chip).toHaveText(uiEn["format.template.groups_ko.label"]!);
    const rebuilt = await stagesOf(request, divisionId);
    // The kinds the template itself declares (its build at any knobs: the kinds do not move with them).
    const groupsKo = STAGE_TEMPLATES.find((t) => t.key === "groups_ko")!.build({ qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 });
    expect(rebuilt.map((st) => st.kind), "the template's stages").toEqual(groupsKo.map((st) => st.kind));
    expect(rebuilt.length, "groups then a knockout").toBe(2);
    expect(rebuilt.map((st) => st.id), "new stages, not the league").not.toContain(league[0]!.id);
    expect(await fixturesOf(divisionId), "the fixtures and their schedule went with it").toEqual({ n: 0, timed: 0 });
    expect(await linksOf(divisionId, linked), "every link went with its board, the revoked one too").toEqual({ n: 0, revoked: 0 });

    // ---- 5. One result: the format locks.
    const groupGen = await apiJson<{ fixtures: { id: string }[] }>(request, `/api/v1/stages/${rebuilt[0]!.id}/generate`, "POST");
    expect(groupGen.status, `generate groups: ${JSON.stringify(groupGen.error)}`).toBeLessThan(300);
    const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
    expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
    await scoreFixture(request, groupGen.data!.fixtures[0]!.id, 2, 1);

    const locked = await formatButton(page, base);
    await expect(locked, "a result exists: Format is greyed").toHaveAttribute("aria-disabled", "true");
    const reason = page.getByTestId("division-rules-format-reason");
    // `force`: the button is aria-disabled on purpose (Playwright reads that as "not enabled" and would wait forever); a finger
    // taps it all the same.
    await locked.click({ force: true });
    await expect(reason, "a press on the greyed button says why").toBeVisible();
    await expect(reason).toHaveText(uiEn["formatChange.err.FORMAT_LOCKED"]!);
    await expect(page.getByRole("dialog"), "a greyed Format opens nothing").toHaveCount(0);
    await shoot(page, testInfo, "4-locked-with-reason", async () => {
      if ((await reason.getAttribute("data-open")) !== "true") await locked.click({ force: true });
      await expect(reason).toBeVisible();
    });

    // The old address still lands on the Fixtures tab, but opens no dialog over a locked format.
    await page.goto(`${base}?tab=format`);
    await page.waitForURL(/\?tab=fixtures&format=open$/, { timeout: NAV_MS });
    await expect(page.getByTestId("division-rules-format")).toHaveAttribute("aria-disabled", "true", { timeout: NAV_MS });
    await expect(page.getByRole("dialog"), "locked: the old address opens nothing").toHaveCount(0);

    // And the server agrees: even a preview is refused.
    const preview = await page.request.put(`/api/v1/divisions/${divisionId}/stages?dry_run=1`, {
      data: [{ seq: 1, kind: "league", name: "League", config: {}, progression: null }],
    });
    expect(preview.status()).toBe(409);
    expect(((await preview.json()) as { error?: { code?: string } }).error?.code).toBe("FORMAT_LOCKED");
    expect((await stagesOf(request, divisionId)).map((st) => st.id), "nothing moved").toEqual(rebuilt.map((st) => st.id));
  });
});
