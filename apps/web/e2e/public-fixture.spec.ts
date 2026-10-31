// R4 sponsors on stream, S10 — clicks on a public match count for THAT match (owner rulings D15 + R8 + R7; spec
// 2026-10-27 §3.7). Run by CI only (e2e.yml, `parallel` project — it joins by the default testMatch; never locally).
//
// Two real-server facts the vitest seams cannot see:
//   1. The match page's sponsor board, TAPPED in a browser at 320 / 768 / 1280 (ruling R17: the widths are looped here,
//      since only mobile.spec.ts runs in the width projects): the board renders below the match centre, the page has no
//      horizontal scroll with a 43-character title sponsor, the tap opens the sponsor's own site in a new tab through
//      `/s/…`, and a `sponsor_clicks` row lands with this fixture and `match`.
//   2. A stream short code typed as a viewer types it (`seazn.club/s/<CODE>`): 302 to the sponsor, and each visit is a
//      `stream` row for the code's fixture — twice is two rows.
// The sponsor's site is fulfilled by a route stub, so no test leaves the box. The expected values are the spec's
// (`?f=<fixture>&src=match`, `stream`), never read off the page under test.
import { expect, test, type Page } from "@playwright/test";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, withDb } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { SPONSOR_SHORT_CODE_ALPHABET, SPONSOR_SHORT_CODE_MAX_LENGTH } from "../src/lib/sponsor-short-code";

const SPONSOR_HOST = "sponsor-s10.example";
/** A realistic long title sponsor (AGENTS.md: a 43-character name is what found the last phone overflow). */
const LONG_TITLE = "Northbank Regional Building Society & Trust";

interface Rig {
  orgId: string;
  fixtureId: string;
  publicPath: string;
  titleId: string;
  goldId: string;
}

/** A public, started division with one fixture, and two competition-scoped sponsors (title + gold) on the shared Pro
 *  org — scoped to THIS competition, so no other spec's sponsors can reach this page. */
async function rig(page: Page): Promise<Rig> {
  const request = page.request;
  const org = await activeOrg(page);
  const suffix = `${TAG}-${Math.random().toString(36).slice(2, 6)}`;
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Sponsor Clicks ${suffix}`,
    visibility: "public",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status).toBe(201);
  expect((await addEntrantsViaApi(request, div.data!.id, ["Click One", "Click Two"])).status).toBe(201);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a two-entrant league seats one fixture").toBe(1);
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);

  const mk = async (name: string, tier: "title" | "gold") => {
    const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.id}/sponsors`, "POST", {
      name,
      tier,
      url: `https://${SPONSOR_HOST}/${tier}`,
      competition_id: comp.data!.id,
    });
    expect(res.status, JSON.stringify(res.error)).toBe(201);
    return res.data!.id;
  };
  const titleId = await mk(LONG_TITLE, "title");
  const goldId = await mk(`Harbour Motors ${suffix}`, "gold");
  return {
    orgId: org.id,
    fixtureId: fixtureIds[0]!,
    publicPath: `/shared/${org.slug}/${comp.data!.slug}/${div.data!.slug}/fixtures/${fixtureIds[0]}`,
    titleId,
    goldId,
  };
}

const clicksOf = (sponsorId: string) =>
  withDb((sql) => sql<{ fixture_id: string | null; source: string }[]>`
    select fixture_id, source from sponsor_clicks where sponsor_id = ${sponsorId} order by at, id`).then((rows) =>
    rows.map((r) => ({ fixture_id: r.fixture_id, source: r.source })),
  );

for (const width of [320, 768, 1280] as const) {
  test.describe(`the match page sponsor board at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the match page sponsor board counts a click for that match", async ({ page, context }) => {
      const r = await rig(page);
      // The sponsor's own site, stubbed: the tap must reach it, but nothing leaves the box.
      await context.route(`https://${SPONSOR_HOST}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Sponsor</title><h1>Sponsor</h1>" }),
      );

      await page.goto(r.publicPath);
      await dismissCookieBanner(page);
      const board = page.getByTestId("mh-sponsors");
      await expect(board).toBeVisible();
      // Below the match centre (the perimeter of the ground), never above the score.
      const centreBox = await page.getByTestId("mc-root").boundingBox();
      const boardBox = await board.boundingBox();
      expect(centreBox && boardBox && boardBox.y >= centreBox.y + centreBox.height - 1, "the board sits below the match centre").toBe(true);
      // R8: the title sponsor leads the board — the long name WRAPS, so the page never scrolls sideways.
      await expect(page.getByTestId("mh-sponsors-title")).toContainText(LONG_TITLE);
      await expectNoHorizontalScroll(page);

      // Every tracked link on the board is this match's (spec §3.7): `?f=<this fixture>&src=match`.
      const hrefs = await board.locator('a[href^="/s/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
      expect(hrefs.sort()).toEqual(
        [r.titleId, r.goldId].map((id) => `/s/${id}?f=${r.fixtureId}&src=match`).sort(),
      );

      // The tap a spectator makes: the gold panel opens the sponsor's site in a new tab, through the tracked redirect.
      const link = board.locator(`a[href^="/s/${r.goldId}?"]`);
      await link.scrollIntoViewIfNeeded();
      const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
      await popup.waitForURL(`https://${SPONSOR_HOST}/gold`);
      await expect.poll(() => clicksOf(r.goldId), { timeout: 15_000 }).toEqual([{ fixture_id: r.fixtureId, source: "match" }]);
      // Only the tapped sponsor counted.
      expect(await clicksOf(r.titleId)).toEqual([]);
    });
  });
}

test("a stream click counts: the short code a viewer types redirects and records a `stream` click for its match", async ({ page }) => {
  const r = await rig(page);
  // The code S5 mints for (sponsor, fixture), written straight to its table here: minting needs a live overlay poll
  // with a planned break (S15's walkthrough drives that). The mint → card → route seam is pinned in vitest
  // (app/s/__tests__/route.test.ts). Drawn from the declared alphabet at the longest length, so no other run collides.
  // The first character is a LETTER, so the lowercase probe below is a different string from the code.
  const letters = [...SPONSOR_SHORT_CODE_ALPHABET].filter((c) => c !== c.toLowerCase());
  const pick = (from: readonly string[]) => from[Math.floor(Math.random() * from.length)]!;
  const code = [pick(letters), ...Array.from({ length: SPONSOR_SHORT_CODE_MAX_LENGTH - 1 }, () => pick([...SPONSOR_SHORT_CODE_ALPHABET]))].join("");
  await withDb((sql) => sql`
    insert into sponsor_short_codes (code, org_id, sponsor_id, fixture_id) values (${code}, ${r.orgId}, ${r.goldId}, ${r.fixtureId})`);

  for (let visit = 1; visit <= 2; visit++) {
    // A query on a code is ignored: the code is the whole tag.
    const res = await page.request.get(`/s/${code}?src=site`, { maxRedirects: 0 });
    expect(res.status(), `visit ${visit}`).toBe(302);
    expect(res.headers()["location"]).toBe(`https://${SPONSOR_HOST}/gold`);
  }
  await expect
    .poll(() => clicksOf(r.goldId), { timeout: 15_000 })
    .toEqual([
      { fixture_id: r.fixtureId, source: "stream" },
      { fixture_id: r.fixtureId, source: "stream" },
    ]);
  // The lowercase form is not a code (the case rule lib/sponsor-short-code.ts declares): a 404, no row.
  expect((await page.request.get(`/s/${code.toLowerCase()}`, { maxRedirects: 0 })).status()).toBe(404);
});
