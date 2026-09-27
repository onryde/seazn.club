import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  seedSettingsOrg,
  releaseSettingsOrg,
  seedCompetition,
  type SeededOrg,
  type SeededCompetition,
} from "../settings-support";
import { apiJson, expectNoHorizontalScroll, TAG } from "../helpers";
import { closeOpenContexts } from "../spectator-public-helpers";
import { sourceConstant, spectator } from "../spectator-w2-kit";
import { routes } from "../../src/lib/routes";

/**
 * Owner decision 2026-09-27: a competition with `status = 'draft'` is UNLISTED
 * until it is published — reachable by its link (hub, registration, poster…),
 * noindexed, and enumerated on no listing surface — and publishing it is what
 * puts it on the organisation's page.
 *
 * One organiser's path, end to end, through the real producer (the settings
 * form's Status select → PATCH) and the real consumer (the anonymous org home
 * and hub). The unit suites prove each query and each robots value on its
 * own; only this crosses the seam between them — including the cache: the org
 * home a spectator loaded while the competition was a draft must list it after
 * the publish within the page's own revalidate window (`REVALIDATE_FAST`,
 * derived from source rather than typed here, AGENTS.md #19/#20).
 *
 * `mode: "default"` for the reason `settings-competition-drive.spec.ts` gives:
 * `beforeAll` seeds an org against a Pro user capped at five owned orgs.
 */
test.describe.configure({ mode: "default" });
test.afterEach(closeOpenContexts);

const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en ui dictionary key: ${key}`);
  return raw;
}

/** The org home and hub revalidate on this window at the latest; the write
 *  path expires the org tag, so it is usually the very next load. */
const LISTING_BOUND_MS = sourceConstant("src/server/public-site/data.ts", "REVALIDATE_FAST") * 1_000 + 15_000;
const NAV_MS = 20_000;
const COMMIT_MS = 12_000;
/** Anchored on `="` — a bare `noindex` probe also matches copy and scripts. */
const NOINDEX = /<meta name="robots" content="noindex, nofollow"/;

let org: SeededOrg;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "pro", label: "draft-unlisted" });
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

const chip = (page: Page, comp: SeededCompetition) => page.getByTestId(`mh-org-chip-${comp.id}`);
const card = (page: Page, comp: SeededCompetition) => page.locator(`a[href="/shared/${org.slug}/${comp.slug}"]`);

test("a new public draft is off the org home but open by link; publishing it from settings lists it", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(Math.max(120_000, 6 * NAV_MS + COMMIT_MS + 2 * LISTING_BOUND_MS));

  // A published neighbour, so the org home is POPULATED and "the draft is
  // absent" is read beside a card that is present (never an empty state).
  const listed = await seedCompetition(request, org.orgId, {
    name: `Listed Cup ${TAG}`,
    visibility: "public",
    status: "published",
  });
  const draft = await seedCompetition(request, org.orgId, { name: `Draft Cup ${TAG}`, visibility: "public" });
  const created = await apiJson<{ status: string; visibility: string }>(request, `/api/v1/competitions/${draft.id}`);
  expect(created.data?.status, "a new competition is a draft").toBe("draft");
  expect(created.data?.visibility, "…with public visibility").toBe("public");

  // 1. The org home — the spectator's first load, which also primes the page's
  //    cache with the draft left out.
  const anon = await spectator(browser, { width: 1280 });
  const home = await anon.goto(`/shared/${org.slug}`);
  expect(home?.status()).toBe(200);
  await expect(chip(anon, listed), "the published neighbour is listed").toBeVisible({ timeout: NAV_MS });
  await expect(chip(anon, draft), "the draft has no card").toHaveCount(0);
  await expect(card(anon, draft)).toHaveCount(0);

  // 2. The direct link still works — a draft is unlisted, not hidden — and
  //    keeps crawlers out. The published neighbour's hub is the positive pair.
  const hub = await anon.goto(`/shared/${org.slug}/${draft.slug}`);
  expect(hub?.status(), "the draft's hub serves by link").toBe(200);
  await expect(anon.getByRole("heading", { name: draft.name }).first()).toBeVisible({ timeout: NAV_MS });
  const draftHtml = await (await anon.request.get(`/shared/${org.slug}/${draft.slug}`)).text();
  expect(draftHtml, "the draft's hub is noindexed").toMatch(NOINDEX);
  const listedHtml = await (await anon.request.get(`/shared/${org.slug}/${listed.slug}`)).text();
  expect(listedHtml, "a published hub is not").not.toMatch(NOINDEX);

  // 3. The organiser sees why, and publishes from the Status select.
  await page.goto(routes.competitionSettings(org.slug, draft.slug));
  const hint = page.getByTestId("compset-draft-unlisted");
  await expect(hint).toHaveText(ui("compset.draftUnlisted"), { timeout: NAV_MS });
  const status = page.locator("label").filter({ hasText: new RegExp(`^${ui("compset.status")}`) }).locator("select");
  await status.selectOption("published");
  await expect(hint, "the hint follows the form, before any save").toHaveCount(0);
  const patched = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/competitions/${draft.id}`) && r.request().method() === "PATCH",
    { timeout: COMMIT_MS },
  );
  await page.getByRole("button", { name: ui("compset.save"), exact: true }).click();
  const res = await patched;
  expect(res.status(), `PATCH: ${await res.text()}`).toBe(200);
  expect((res.request().postDataJSON() as { status?: string }).status, "the form sent the status").toBe("published");
  const read = await apiJson<{ status: string }>(request, `/api/v1/competitions/${draft.id}`);
  expect(read.data?.status, "the row is published").toBe("published");

  // 4. The same spectator's org home now lists it, within the page's window.
  await expect(async () => {
    await anon.goto(`/shared/${org.slug}`);
    await expect(chip(anon, draft)).toBeVisible({ timeout: 2_000 });
  }, "the published competition reaches the org home").toPass({ timeout: LISTING_BOUND_MS });
  await expect(card(anon, draft)).toHaveCount(1);
  await expect(chip(anon, listed), "and its neighbour stays").toBeVisible();

  // …and its hub is indexable again.
  await expect
    .poll(async () => NOINDEX.test(await (await anon.request.get(`/shared/${org.slug}/${draft.slug}`)).text()), {
      message: "the published hub drops its noindex",
      timeout: LISTING_BOUND_MS,
    })
    .toBe(false);

  // The page with two cards holds at the narrowest width.
  const phone = await spectator(browser, { width: 320 });
  await phone.goto(`/shared/${org.slug}`);
  await expect(chip(phone, draft)).toBeVisible({ timeout: NAV_MS });
  await expectNoHorizontalScroll(phone);
});
