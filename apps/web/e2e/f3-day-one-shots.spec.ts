import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { loginUi, activeOrg, apiJson, TAG } from "./helpers";

// Screenshot evidence for F3's two new organiser surfaces (day-one fixtures
// plan, Task 5) before the PR leaves draft:
//   5a/5b — the roster-drift banner + Rebuild button, stages-panel.tsx,
//           shown when a stage's generated fixtures no longer match the
//           live entrant roster. Setup mirrors stage-roster-drift.spec.ts
//           (withdraw an entrant pre-start — Generate alone can never drop
//           a withdrawn name, only Rebuild can) without driving the click,
//           since we need the banner to survive all three viewport shots.
//   5c     — the pending-seed-proposal dot on the Fixtures tab label,
//           d/[divSlug]/page.tsx, `data-pending-seed-proposals`. Shown when
//           a timing:"setup" stage has a draft/stale proposal — ruling 14:
//           seeding stays propose-and-confirm, never auto-confirm, so a
//           computed proposal nobody has been told about can sit for a
//           while. Fetched on EVERY tab (not just fixtures), so this spec
//           captures it from Standings — that is the whole point of 5c.
//
// Own empty storageState + loginUi (auto-provisions a fresh org), matching
// credits-tab-shots.spec.ts's idiom — PROD_TARGET-safe, no shared account
// or magic-link rate limit. Auth lives on `page`'s browser context only, so
// setup calls go through `page.request` (shares cookies), never the
// separate top-level `request` fixture stage-roster-drift.spec.ts /
// stage-progression.spec.ts use — those run under the project's own
// pre-authenticated storageState instead, which this file deliberately
// opts out of.
test.use({ storageState: { cookies: [], origins: [] } });

const SHOTS =
  process.env.F3_SHOTS_DIR ?? resolve(process.cwd(), "../../.superpowers/sdd/shots/f3-day-one");

// Mirrors the project's own named viewports (playwright.config.ts:
// Desktop Chrome = 1280x720, tablet-768 = 768x1024, mobile-320 = 320x568)
// rather than one flat height for all three.
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 768, height: 1024 },
  { width: 320, height: 568 },
] as const;

/** Pre-dismiss the app-wide cookie-consent banner, exactly as auth.setup.ts
 *  does for every other spec. This file runs on an EMPTY storageState (the
 *  credits-tab-shots idiom), so it does not inherit that dismissal — and the
 *  banner is a fixed overlay that sat directly on top of the roster-drift
 *  banner in the first run. The DOM assertions still passed, so the shots
 *  looked "verified" while the picture showed a cookie dialog instead of the
 *  surface it was evidence for. Screenshot evidence has to be checked by
 *  LOOKING at it, not by the assertions that ran beside it.
 *  "rejected" keeps analytics off; both keys are required or the re-prompt
 *  logic reopens the banner. */
async function dismissConsent(page: Page): Promise<void> {
  const { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } = await import(
    "../src/lib/consent"
  );
  await page.evaluate(
    ([k, vk, v]) => {
      localStorage.setItem(k, "rejected");
      localStorage.setItem(vk, v);
    },
    [CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION] as const,
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

// The brief's literal formula (also credits-tab-shots.spec.ts's own inline
// check) — a page-level sanity gate, distinct from the geometry assertion
// below, which is the one doing real work against the `.scroll-x` trap.
async function assertNoHorizontalScroll(page: Page, width: number): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow, `no horizontal page scroll at ${width}px`).toBe(false);
}

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

test("F3 Task 5a/5b — roster-drift banner + Rebuild button, real drift state, 1280/768/320", async ({
  page,
}) => {
  await loginUi(page, `delivered+f3-drift-${Date.now()}@resend.dev`, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `F3 Drift Shots ${Date.now()}`,
  });
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  const org = await activeOrg(page);

  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `F3 Drift ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  const div = await apiJson<{ id: string; slug: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const divSlug = div.data!.slug;

  const createEntrants = await apiJson(page.request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: `Drift Alice ${TAG}`, seed: 1 },
    { kind: "individual", display_name: `Drift Bob ${TAG}`, seed: 2 },
    { kind: "individual", display_name: `Drift Cleo ${TAG}`, seed: 3 },
  ]);
  expect(createEntrants.status, JSON.stringify(createEntrants.error)).toBe(201);
  const entrantsBefore = await apiJson<{ id: string; display_name: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/entrants`,
  );
  const aliceId = entrantsBefore.data!.find((e) => e.display_name === `Drift Alice ${TAG}`)!.id;

  const stage = await apiJson<{ id: string }>(page.request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const stageId = stage.data!.id;

  const gen = await apiJson<{ created: number; fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${stageId}/generate`,
    "POST",
  );
  expect(gen.status, JSON.stringify(gen.error)).toBe(200);
  expect(gen.data!.created).toBe(3); // 3-entrant round robin

  // Pre-start withdrawal — division.status is still "setup", NOT the
  // mid-tournament walkover cascade. Generate alone can never remove
  // Alice's name now; only Rebuild can.
  const withdrawn = await apiJson<{ policy: string }>(page.request, `/api/v1/entrants/${aliceId}/withdraw`, "POST");
  expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBe(200);
  expect(withdrawn.data!.policy).toBe("none");

  const addDee = await apiJson(page.request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: `Drift Dee ${TAG}`, seed: 4 },
  ]);
  expect(addDee.status, JSON.stringify(addDee.error)).toBe(201);

  for (const { width, height } of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${divSlug}?tab=fixtures`, { waitUntil: "load" });
    await dismissConsent(page);
    await page.reload({ waitUntil: "load" });

    // Real assertions, not just a screenshot: the banner names the actual
    // withdrawn entrant and carries the "ghosts" drift state, not merely
    // "some div rendered".
    const banner = page.getByTestId("roster-drift-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toHaveAttribute("data-roster-drift-state", "ghosts");
    await expect(banner).toContainText(`Drift Alice ${TAG}`);
    await expect(banner.getByTestId("roster-drift-rebuild")).toBeVisible();

    await page.waitForTimeout(200);
    await assertNoHorizontalScroll(page, width);
    await shot(page, `roster-drift-banner-${width}`);

    // F3 ultrareview finding 5 — the confirm dialog now names the organiser
    // SETUP the rebuild clears alongside the fixtures (referee appointments,
    // team sheets, paired devices), so the body is roughly twice as long as
    // the one this dialog shipped with. Shot at all three widths because a
    // longer body in a `max-h-[85dvh]` sheet is exactly where a 320px
    // regression would hide. This division has no officials or lineups
    // assigned, so the extra sentence is correctly ABSENT here — that IS the
    // common case, and "adds no boilerplate to click through when there is
    // nothing attached" is the behaviour worth pinning at the widths.
    await banner.getByTestId("roster-drift-rebuild").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("deleted and regenerated");
    await expect(dialog).not.toContainText("official assignment");
    await assertNoHorizontalScroll(page, width);
    await shot(page, `roster-drift-confirm-${width}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });

  }

  // …and the LONG copy, which is the one that can break a layout: with a
  // referee actually appointed, the dialog names what the rebuild clears
  // besides the fixtures (F3 ultrareview finding 5). Appointed once, then
  // shot at all three widths — a second pass rather than a branch inside the
  // loop above, so the no-attachments state stays covered at every width too.
  const official = await apiJson<{ id: string }>(page.request, `/api/v1/officials`, "POST", {
    display_name: `Ref Rita ${TAG}`,
    role_keys: ["referee"],
  });
  expect(official.status, JSON.stringify(official.error)).toBe(201);
  const assigned = await apiJson(
    page.request,
    `/api/v1/fixtures/${gen.data!.fixtures[0]!.id}/officials`,
    "PATCH",
    { set: [{ official_id: official.data!.id, role_key: "referee" }] },
  );
  expect(assigned.status, JSON.stringify(assigned.error)).toBe(200);

  for (const { width, height } of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${divSlug}?tab=fixtures`, { waitUntil: "load" });

    const banner = page.getByTestId("roster-drift-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await banner.getByTestId("roster-drift-rebuild").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // The count is real, and the sentence names what the organiser loses.
    await expect(dialog).toContainText("1 official assignment(s)");
    await expect(dialog).toContainText("set those up again");
    await assertNoHorizontalScroll(page, width);
    await shot(page, `roster-drift-confirm-attachments-${width}`);
    // Leave the board untouched: the rebuild itself is covered by
    // stage-roster-drift.spec.ts, and a rebuild here would clear the very
    // drift the next viewport iteration needs.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  }
});

test("F3 Task 5c — pending-seed-proposal dot on the Fixtures tab, visible from Standings, 1280/768/320", async ({
  page,
}) => {
  await loginUi(page, `delivered+f3-seed-dot-${Date.now()}@resend.dev`, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `F3 Seed Dot Shots ${Date.now()}`,
  });
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  const org = await activeOrg(page);

  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `F3 Seed Dot ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);

  const div = await apiJson<{ id: string; slug: string }>(
    page.request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Groups", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG },
  );
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const divSlug = div.data!.slug;

  const entrants = await apiJson<{ id: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `F3-E${i + 1} ${TAG}`, seed: i + 1 })),
  );
  expect(entrants.status, JSON.stringify(entrants.error)).toBe(201);

  // Two stages in one call: groups (4 pools of 2) feed a knockout via the
  // unified `progression` field (timing: "setup", topNPerGroup(2)) — the
  // exact shape stage-progression.spec.ts already proves end to end. Two
  // stages sits exactly at Community's stages.per_division.max (2), and 8
  // entrants is well under its entrants.per_division.max (32), so this
  // needs no plan upgrade.
  const stages = await apiJson<{ id: string; kind: string }[]>(
    page.request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 4 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  );
  expect(stages.status, JSON.stringify(stages.error)).toBe(201);
  const groupStageId = stages.data!.find((s) => s.kind === "group")!.id;
  const koStageId = stages.data!.find((s) => s.kind === "knockout")!.id;

  // TBD placeholder fixtures up front, before the group stage even starts —
  // required before computeSeedProposal can resolve destination slots.
  const koGen = await apiJson(page.request, `/api/v1/stages/${koStageId}/generate`, "POST");
  expect(koGen.status, JSON.stringify(koGen.error)).toBe(200);

  const groupGen = await apiJson<{ fixtures: { id: string }[] }>(
    page.request,
    `/api/v1/stages/${groupStageId}/generate`,
    "POST",
  );
  expect(groupGen.status, JSON.stringify(groupGen.error)).toBe(200);
  expect(groupGen.data!.fixtures).toHaveLength(4); // 4 pools of 2 -> 1 match each

  const started = await apiJson(page.request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);

  // Decide every group fixture (home always wins — deterministic enough to
  // reach "the group stage is complete"; exact seeding order isn't this
  // spec's job).
  for (const f of groupGen.data!.fixtures) {
    const state = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${f.id}/state`);
    const scored = await apiJson(page.request, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    expect(scored.status, JSON.stringify(scored.error)).toBe(201);
  }

  // Completing the source stage computes a DRAFT proposal for its dependent
  // timing:"setup" stage automatically (usecases/stages.ts) — nobody has
  // told the organiser yet. That gap is exactly what 5c's dot closes.
  const completed = await apiJson<{ completed: boolean; seed_proposal?: { id: string; status: string } }>(
    page.request,
    `/api/v1/stages/${groupStageId}/complete`,
    "POST",
  );
  expect(completed.status, JSON.stringify(completed.error)).toBe(200);
  expect(completed.data!.completed).toBe(true);
  expect(completed.data!.seed_proposal?.status).toBe("draft");

  for (const { width, height } of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    // Non-fixtures tab on purpose — 5c's whole point is that the dot is
    // visible from wherever the organiser actually is when the source
    // stage finishes, not only if they happen to be on Fixtures already.
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/d/${divSlug}?tab=standings`, { waitUntil: "load" });
    await dismissConsent(page);
    await page.reload({ waitUntil: "load" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const badge = page.locator("[data-pending-seed-proposals]");
    await expect(badge).toBeVisible({ timeout: 20_000 });
    // React serialises an omitted/undefined prop as the literal string
    // "$undefined" — anchor on the exact rendered value, not bare presence.
    await expect(badge).toHaveAttribute("data-pending-seed-proposals", "1");

    await page.waitForTimeout(200);
    await assertNoHorizontalScroll(page, width);

    // The house `.scroll-x` trap: the tab strip clips its own active tab
    // once tabs overflow, and neither the page-level no-scroll check above
    // nor a fullPage screenshot can see it (fullPage capture resets nested
    // scroll containers) — only a geometry check against the strip's own
    // clipped box can. Assert the badge sits inside it, not merely present
    // in the DOM.
    const navBox = await page.locator("nav.scroll-x").boundingBox();
    const badgeBox = await badge.boundingBox();
    expect(navBox, `nav.scroll-x strip not found at ${width}px`).not.toBeNull();
    expect(badgeBox, `badge box not found at ${width}px`).not.toBeNull();
    const navLeft = navBox!.x;
    const navRight = navBox!.x + navBox!.width;
    const badgeLeft = badgeBox!.x;
    const badgeRight = badgeBox!.x + badgeBox!.width;
    expect(
      badgeLeft >= navLeft - 1 && badgeRight <= navRight + 1,
      `badge box [${badgeLeft.toFixed(1)}, ${badgeRight.toFixed(1)}] falls outside the .scroll-x strip's ` +
        `visible box [${navLeft.toFixed(1)}, ${navRight.toFixed(1)}] at ${width}px — clipped out of view, ` +
        `not merely present in the DOM`,
    ).toBe(true);

    await shot(page, `pending-seed-proposal-dot-${width}`);
  }
});
