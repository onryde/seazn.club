import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  type SeededOrg,
  type SeededCompetition,
} from "../settings-support";
import { addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, seedVenueWithCourts, TAG } from "../helpers";
import { routes } from "../../src/lib/routes";

/**
 * Match Day C7 — the org Competitions home, walked by an organiser (owner rulings 2026-11-01, progress.md 534-543).
 *
 * One organiser's path, through the real UI, from the top nav to Match Day:
 *   1. Setup (API): a fresh organisation with four competitions — one with a match TODAY, a Draft one with a match today, one
 *      with nothing scheduled, and a finished one. A fresh org so the deck holds exactly these two and nothing another spec left.
 *   2. Open the org home by TAPPING the nav's Dashboard link: the page is titled "Competitions"; the today deck holds both
 *      competitions with a match today, each with Open Match Day; the one with nothing scheduled is a quiet card ending in B's
 *      stub; there is no Directory button on the page (the nav keeps it); the finished one is hidden.
 *   3. Flip "Show finished": the finished competition appears.
 *   4. Tap Open Match Day: Match Day for that competition, with its court list.
 * Every step asserts what a person sees, and the page holds without sideways scroll, at 1280 and at 320.
 *
 * `mode: "default"` for the reason `draft-unlisted-org-home.spec.ts` gives: `beforeAll` seeds an org against a Pro user capped
 * at five owned orgs, so the two widths share one org (both only READ it — the switch's state is the URL).
 */
test.describe.configure({ mode: "default" });

const read = (rel: string): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const UI = read("../../src/dictionaries/en/ui.json");
const CONSOLE = read("../../src/dictionaries/en/console.json");
function ui(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI[key];
  if (raw === undefined) throw new Error(`missing en ui dictionary key: ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), raw);
}

const NAV_MS = 20_000;

let org: SeededOrg;
let today: SeededCompetition;
let draft: SeededCompetition;
let quiet: SeededCompetition;
let done: SeededCompetition;
let courts: { id: string; name: string }[];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  try {
    const req = ctx.request;
    org = await seedSettingsOrg(req, { plan: "pro", label: "comp-home" });
    // Private: these are the organiser's own view; a public one would spend the plan's public-dashboard cap.
    today = await seedCompetition(req, org.orgId, { name: `Today Cup ${TAG}`, visibility: "private", status: "published" });
    draft = await seedCompetition(req, org.orgId, { name: `Draft Open ${TAG}`, visibility: "private", status: "draft" });
    quiet = await seedCompetition(req, org.orgId, { name: `Quiet League ${TAG}`, visibility: "private", status: "published" });
    done = await seedCompetition(req, org.orgId, { name: `Old Cup ${TAG}`, visibility: "private", status: "completed" });
    ({ courts } = await seedVenueWithCourts(req, [`Court A ${TAG}`, `Court B ${TAG}`], { orgId: org.orgId }));

    // An instant inside today's UTC day near now (clamped a minute inside either end), the day the divisions plan in.
    const now = Date.now();
    const d = new Date(now);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const within = (offsetMin: number) =>
      new Date(Math.min(dayStart + 86_400_000 - 60_000, Math.max(dayStart + 60_000, now + offsetMin * 60_000))).toISOString();

    // The two competitions with a match today: one division each, two players, the one match planned today on Court A.
    for (const [comp, at] of [
      [today, within(30)],
      [draft, within(45)],
    ] as const) {
      const div = await apiJson<{ id: string }>(req, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "Open singles",
        sport_key: "generic",
        variant_key: "score",
      });
      if (div.status >= 300 || !div.data) throw new Error(`division → ${div.status} ${JSON.stringify(div.error)}`);
      const nonce = Math.random().toString(36).slice(2, 6);
      const ents = await addEntrantsViaApi(req, div.data.id, [`Ana ${nonce}`, `Ben ${nonce}`]);
      if (ents.status >= 300 || ents.ids.length !== 2) throw new Error(`entrants → ${ents.status}`);
      const { fixtureIds } = await createStageAndGenerate(req, div.data.id);
      if (fixtureIds.length !== 1) throw new Error(`expected one fixture, got ${fixtureIds.length}`);
      const settings = await apiJson(req, `/api/v1/divisions/${div.data.id}/schedule-settings`, "PUT", {
        tz: "UTC",
        config: { matchMinutes: 30, courts: courts.map((c) => c.id) },
      });
      if (settings.status >= 300) throw new Error(`schedule settings → ${settings.status} ${JSON.stringify(settings.error)}`);
      const placed = await apiJson(req, `/api/v1/fixtures/${fixtureIds[0]}`, "PATCH", { scheduled_at: at, court_id: courts[0]!.id });
      if (placed.status >= 300) throw new Error(`place fixture → ${placed.status} ${JSON.stringify(placed.error)}`);
    }
  } finally {
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  if (!org) return;
  const ctx = await browser.newContext();
  try {
    await releaseSettingsOrg(ctx.request, org);
  } finally {
    await ctx.close();
  }
});

const deckRow = (page: Page, c: SeededCompetition): Locator => page.getByTestId("org-home-today-row").filter({ hasText: c.name });
const card = (page: Page, c: SeededCompetition): Locator => page.getByTestId("org-home-card").filter({ hasText: c.name });

for (const width of [1280, 320] as const) {
  test(`at ${width}: Competitions from the nav — today's two lead with Open Match Day, the quiet one ends in its stub, Show finished reveals the finished one, and Open Match Day lands on the court list`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });

    // 2. In through the nav, from one of the organisation's own pages (the competition page of the quiet one).
    await page.goto(routes.competition(org.slug, quiet.slug), { waitUntil: "load" });
    const navHome = page.getByRole("navigation").getByRole("link", { name: CONSOLE["nav.dashboard"], exact: true });
    await expect(navHome).toBeVisible({ timeout: NAV_MS });
    await navHome.click();
    await page.waitForURL((u) => u.pathname === routes.orgHome(org.slug), { timeout: NAV_MS });

    await expect(page.getByRole("heading", { level: 1, name: ui("org.home.title"), exact: true })).toBeVisible();
    await expect(page.getByText("Matchday console")).toHaveCount(0);

    // The today deck: exactly the two competitions with a match today, the Draft one included, each with Open Match Day.
    const deck = page.getByTestId("org-home-today");
    await expect(deck).toBeVisible();
    await expect(deck.getByRole("heading", { level: 2, name: ui("org.home.today.title"), exact: true })).toBeVisible();
    await expect(page.getByTestId("org-home-today-row")).toHaveCount(2);
    let deckChecked = 0;
    for (const c of [today, draft]) {
      const row = deckRow(page, c);
      await expect(row, c.name).toBeVisible();
      const open = row.getByRole("link", { name: ui("org.home.today.openFor", { name: c.name }) });
      await expect(open, c.name).toBeVisible();
      await expect(open, c.name).toHaveText(ui("desk.tools.openMatchDay"));
      // The match the deck names: Court A, today.
      await expect(row.getByTestId("org-home-today-match"), c.name).toContainText(`Court A ${TAG}`);
      deckChecked++;
    }
    expect(deckChecked).toBe(2);
    await expect(deckRow(page, draft).getByText(UI["chip.draft"]!, { exact: true })).toBeVisible();

    // The quiet one: a small card, not in the deck, ending in B's stub with its editor's action.
    await expect(deckRow(page, quiet)).toHaveCount(0);
    const quietCard = card(page, quiet);
    await expect(quietCard).toBeVisible();
    const stub = quietCard.getByTestId("org-home-stub");
    await expect(stub).toBeVisible();
    await expect(stub).toContainText(ui("card.progress.none"));
    await expect(stub.getByRole("link", { name: ui("org.home.stub.setUpFor", { name: quiet.name }) })).toBeVisible();
    await expect(quietCard.getByRole("link", { name: ui("org.home.today.openFor", { name: quiet.name }) })).toHaveCount(0);

    // No Directory button on the page; the nav keeps Directory (the positive pair).
    await expect(page.getByRole("main").getByRole("link", { name: CONSOLE["nav.directory"] })).toHaveCount(0);
    await expect(page.getByRole("navigation").getByRole("link", { name: CONSOLE["nav.directory"] })).toBeVisible();

    // The finished one is hidden until asked for.
    await expect(card(page, done)).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // 3. Show finished: the switch is off, says how many, and flipping it shows the finished competition.
    const toggle = page.getByRole("switch", { name: ui("org.home.showFinished", { n: 1 }) });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await page.waitForURL((u) => u.searchParams.get("finished") === "1", { timeout: NAV_MS });
    await expect(page.getByRole("switch", { name: ui("org.home.showFinished", { n: 1 }) })).toHaveAttribute("aria-checked", "true");
    const finished = page.locator('[data-testid="org-home-group"][data-group="finished"]');
    await expect(finished.getByRole("heading", { name: new RegExp(ui("org.home.group.finished"), "i") })).toBeVisible();
    await expect(finished.getByTestId("org-home-card").filter({ hasText: done.name })).toBeVisible();
    await expect(finished.getByTestId("org-home-card").filter({ hasText: done.name }).getByText(UI["chip.completed"]!, { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // 4. Open Match Day for Today Cup: Match Day for that competition, with its courts.
    await deckRow(page, today).getByRole("link", { name: ui("org.home.today.openFor", { name: today.name }) }).click();
    await page.waitForURL((u) => u.pathname === routes.competitionMatchDay(org.slug, today.slug), { timeout: NAV_MS });
    await expect(page.getByRole("heading", { level: 1, name: /^Match Day · / })).toBeVisible({ timeout: NAV_MS });
    const list = page.getByTestId("md-list");
    await expect(list).toBeVisible();
    let courtsSeen = 0;
    for (const c of courts) {
      await expect(page.getByTestId("md-court-row").filter({ hasText: c.name }), c.name).toBeVisible();
      courtsSeen++;
    }
    expect(courtsSeen).toBe(2);
    await expectNoHorizontalScroll(page);
  });
}
