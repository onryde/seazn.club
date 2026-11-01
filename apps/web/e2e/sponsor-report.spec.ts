// R4 sponsors on stream, S14 - the public sponsor report, /r/sponsor/[token] (spec 2026-10-27 §5.2, §7). Run by CI only (e2e.yml,
// the `parallel` project: it joins by the default testMatch; never locally).
//
// What the vitest seams (node environment, no browser, no Next server) cannot see:
//   1. The page OPENS WITHOUT A LOGIN, in a real browser with an empty cookie jar: a 200, served `no-store`, noindex, the
//      figures under their labels - and at 320, 768 and 1280 with no horizontal scroll, a 43-character match name truncating
//      inside its card rather than pushing the page wide (R17: the widths are looped here with `test.use({ viewport })`).
//   2. Print: the chrome (the print button, the cookie banner) is gone under `print` media and the showings are still there.
//   3. The real Next 404: an unknown, a malformed, a revoked and a deleted sponsor's token each answer HTTP 404 with the
//      SAME body (byte-equal `main`), noindex - and a link answers 200 right up to its revoke (no cache in between).
// The figures are typed from the rows this file seeds (two closed showings of 8 s and 15 s, one still open; two stream visits and
// one site visit), never read back from the page. Frames need the private bucket (no Supabase in CI e2e), so every showing here
// is the placeholder; the signed-url path is pinned in vitest (report-public.test.ts, page.test.tsx). The rate limit is inert
// without Redis (CI e2e has none); its branch is pinned in page.test.tsx.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, withDb } from "./helpers";
import { releaseSettingsOrg, seedCompetition, seedSettingsOrg, type SeededOrg } from "./settings-support";
import { fmtOnScreen, reportLinkPath } from "../src/lib/sponsor-report";

/** Copy read from the dictionary the page renders from, never retyped. */
const UI: Record<string, string> = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"));
const ui = (key: string, vars: Record<string, string | number> = {}): string => {
  const v = UI[key];
  if (v === undefined) throw new Error(`en/ui.json has no ${key}`);
  return v.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
};

const SPONSOR = "Harbourside Building Supplies and Timber Co";
const HOME = "Harbourside Building Supplies and Timber Co";
const AWAY = "Kingsway Northern Athletic Club Under 21s B";
const SHOWN_MS = [8_000, 15_000]; // the two closed showings; a third is still open
const EMPTY_JAR = { cookies: [], origins: [] };

let org: SeededOrg;
let token: string;

/** A browser context with no cookie and no storage at all: the sponsor, who has never signed in. */
async function anonymous(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ storageState: EMPTY_JAR, viewport });
  expect((await ctx.cookies()).map((c) => c.name), "no session in the jar").toEqual([]);
  return ctx.newPage();
}

test.beforeAll(async ({ request }) => {
  expect(SPONSOR.length, "Review Focus 5's realistic name").toBe(43);
  expect(AWAY.length).toBe(43);
  org = await seedSettingsOrg(request, { plan: "pro", label: "sponsor-report" });
  const comp = await seedCompetition(request, org.orgId, { name: "Summer League" });
  const division = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "T20", sport_key: "cricket", variant_key: "t20", config: {} });
  expect(division.status, JSON.stringify(division.error)).toBe(201);
  const entrants = await addEntrantsViaApi(request, division.data!.id, [HOME, AWAY], "team");
  expect(entrants.status).toBe(201);
  const { fixtureIds } = await createStageAndGenerate(request, division.data!.id);
  expect(fixtureIds.length, "premise: two entrants seat one fixture").toBe(1);
  const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", { name: SPONSOR, tier: "gold", url: "https://harbourside.example/" });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const sponsorId = made.data!.id;
  // The writers' own rows (the overlay read path and the /s/ route write them in production), straight into their tables.
  await withDb(async (sql) => {
    const air = (moment: string, start: string, ms: number | null) => sql`
      insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, moment_id, source, break_kind, style, started_at, ended_at)
      values (${org.orgId}, ${sponsorId}, ${SPONSOR}, ${fixtureIds[0]!}, ${moment}, 'rotation', 'over_end', 'lower_third',
              ${new Date(start)}, ${ms === null ? null : new Date(new Date(start).getTime() + ms)})`;
    await air("5:sponsor.over_end", "2026-06-02T10:00:00.000Z", SHOWN_MS[0]!);
    await air("9:sponsor.over_end", "2026-06-03T10:00:00.000Z", SHOWN_MS[1]!);
    await air("12:sponsor.over_end", "2026-06-04T10:00:00.000Z", null);
    for (const source of ["stream", "stream", "site"]) {
      await sql`insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source, at) values (${org.orgId}, ${sponsorId}, ${fixtureIds[0]!}, ${source}, '2026-06-02T10:01:00Z')`;
    }
  });
  const link = await apiJson<{ id: string; url: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors/${sponsorId}/report-links`, "POST", { competitionId: null, from: "2026-06-01", to: "2026-06-30" });
  expect(link.status, JSON.stringify(link.error)).toBe(201);
  token = link.data!.url.split("/").at(-1)!;
  expect(reportLinkPath(token), "S13's url is the page's path").toBe(link.data!.url);
});
test.afterAll(async ({ request }) => {
  await releaseSettingsOrg(request, org);
});

for (const width of [320, 768, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, storageState: EMPTY_JAR });

    test("opens with no login: 200, no-store, noindex, the figures under their labels, no horizontal scroll, long names truncated", async ({ page, context }) => {
      expect((await context.cookies()).map((c) => c.name), "no session in the jar").toEqual([]);
      const res = await page.goto(reportLinkPath(token));
      expect(res?.status()).toBe(200);
      expect(res?.headers()["cache-control"] ?? "", "never cached").toContain("no-store");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      await expect(page.getByTestId("sponsor-report")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(ui("sponsorReport.heading", { sponsor: SPONSOR, org: org.name }));

      // The figures, typed from the seeded rows: 23 s over the two closed showings, three showings, two stream visits, viewers a dash.
      await expect(page.getByTestId("report-on-screen")).toHaveText(fmtOnScreen("en", SHOWN_MS[0]! + SHOWN_MS[1]!));
      await expect(page.getByText(ui("sponsorReport.stat.onScreen.other", { count: 3 }), { exact: true })).toBeVisible();
      await expect(page.getByTestId("report-stream-visits")).toHaveText("2");
      await expect(page.getByText(ui("sponsorReport.stat.visits.other"), { exact: true })).toBeVisible();
      await expect(page.getByTestId("report-viewers").locator('[aria-hidden="true"]')).toHaveText("—");
      await expect(page.getByTestId("report-viewers").locator(".sr-only")).toHaveText(ui("sponsorReport.notAvailable"));

      // Each showing: three cards, each the placeholder (no frame store in CI), the open one still being counted.
      const cards = page.getByTestId("report-showing");
      await expect(cards).toHaveCount(3);
      await expect(page.getByTestId("report-frame-missing")).toHaveCount(3);
      await expect(cards.filter({ hasText: ui("sponsorReport.showing.open") })).toHaveCount(1);
      const name = ui("sponsorReport.match.sides", { home: HOME, away: AWAY });
      const line = cards.first().getByTitle(name);
      await expect(line).toHaveText(name);
      const box = await line.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(box.scroll, `the 86-character match line truncates inside its card at ${width}px`).toBeGreaterThan(box.client);
      await expectNoHorizontalScroll(page);
      expect(await page.locator("body").innerText(), "the token is not printed on the page").not.toContain(token);
    });
  });
}

test("print: the chrome goes (the print button, the cookie banner), the report stays", async ({ browser }) => {
  const page = await anonymous(browser);
  await page.goto(reportLinkPath(token));
  const print = page.getByRole("button", { name: new RegExp(ui("sponsorReport.print")) });
  await expect(print).toBeVisible();
  // The banner mounts after hydration for a visitor who has not answered it: wait for it, so its print rule is really tested.
  const banner = page.getByTestId("cookie-consent");
  await expect(banner, "premise: a first-time visitor sees the banner").toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(print).toBeHidden();
  await expect(banner).toBeHidden();
  await expect(page.getByTestId("report-showing")).toHaveCount(3);
  await expect(page.getByTestId("report-showing").first()).toBeVisible();
  await page.context().close();
});

test("the 404: unknown, malformed, revoked and deleted-sponsor tokens answer 404 with the same body; a link is live right up to its revoke", async ({ browser, request }) => {
  const page = await anonymous(browser);
  // A second sponsor and two links of its own: one revoked, then the sponsor deleted under the other.
  const second = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", { name: "Ridge Cycles", tier: "partner" });
  expect(second.status, JSON.stringify(second.error)).toBe(201);
  const mint = async () => {
    const l = await apiJson<{ id: string; url: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors/${second.data!.id}/report-links`, "POST", { competitionId: null, from: "2026-06-01", to: "2026-06-30" });
    expect(l.status, JSON.stringify(l.error)).toBe(201);
    return { id: l.data!.id, path: l.data!.url };
  };
  const revoked = await mint();
  const orphaned = await mint();

  // Live: 200 - then revoked, and the very next load is the 404 (nothing cached it).
  expect((await page.goto(revoked.path))?.status()).toBe(200);
  const del = await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsor-report-links/${revoked.id}`, "DELETE");
  expect(del.status, JSON.stringify(del.error)).toBe(200);
  expect((await page.goto(revoked.path))?.status(), "revoked: the very next load").toBe(404);
  expect((await page.goto(orphaned.path))?.status(), "the other link still opens").toBe(200);
  const gone = await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsors/${second.data!.id}`, "DELETE");
  expect(gone.status, JSON.stringify(gone.error)).toBe(200);

  const bodies: string[] = [];
  const cases: [string, string][] = [
    ["unknown (a well-formed token nobody holds)", reportLinkPath("Zm9yZ2VkLXRva2VuLW5vYm9keS1ob2xkcy10aGlzLTQz")],
    ["malformed", reportLinkPath("not-a-token")],
    ["revoked", revoked.path],
    ["its sponsor deleted", orphaned.path],
  ];
  for (const [label, path] of cases) {
    const res = await page.goto(path);
    expect(res?.status(), label).toBe(404);
    await expect(page.locator('meta[name="robots"]').first(), label).toHaveAttribute("content", /noindex/);
    const main = page.getByTestId("sponsor-report-not-found");
    await expect(main, label).toBeVisible();
    await expect(main).toContainText(ui("sponsorReport.notFound.title"));
    bodies.push(await main.evaluate((el) => el.outerHTML));
  }
  expect(bodies).toHaveLength(cases.length);
  expect(new Set(bodies).size, "one body for every way a token fails").toBe(1);
  await page.context().close();
});
