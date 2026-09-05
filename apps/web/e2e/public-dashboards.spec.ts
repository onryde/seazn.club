import { test, expect } from "@playwright/test";
import {
  TAG,
  activeOrg,
  apiJson,
  invalidateOrgEntitlements,
  setEntitlementOverrideSql,
  startBlankCompetition,
} from "./helpers";

// Entitlements v18 W2 T15/F (owner ruling 2026-09-03): **competitions are
// public by default, and a create is never refused over the public-dashboard
// cap — it degrades to private and says so.**
//
// Both halves are customer-facing controls in a client component, and
// `apps/web` vitest runs `environment: "node"` with no DOM, so neither can be
// seen from a unit test: a builder suite cannot tell which radio a wizard
// OPENS on, and cannot tell whether the degraded path renders a note or an
// error banner. The server-side degrade is pinned in
// `src/server/usecases/__tests__/public-dashboard-quota.test.ts`; this is the
// part only a browser can answer.
//
// SERIAL. It flips an org-wide `dashboard.public.max` override on the shared
// account, which any concurrently running spec that creates a public
// competition would feel — the file is named in `playwright.config.ts`'s
// SERIAL_SPECS for exactly that reason.
test.describe.configure({ mode: "serial" });

// A `finally` is NOT enough to restore the cap, and both tests below used to
// rely on one. On a test-level TIMEOUT Playwright never unwinds the test frame,
// so `finally` never starts — widening the timeout does not help, because the
// abandonment is not a budget problem. `afterEach` IS honoured, and an async
// hook's awaits complete. Prior art with the same reasoning:
// `billing-states.spec.ts:14-28`, which revokes a superadmin flag this way.
//
// This matters more here than almost anywhere: the value being restored is
// `dashboard.public.max = 0` on the SHARED account. Leak it and every public
// competition created by the rest of the run degrades to private — which is
// precisely the failure that took out ten smoke checks in this wave.
//
// The org id is captured BEFORE the override is written, or the hook is a
// no-op in exactly the runs that need it.
const cappedOrgIds = new Set<string>();

async function capPublicDashboards(orgId: string, value: number): Promise<void> {
  cappedOrgIds.add(orgId);
  await setEntitlementOverrideSql(orgId, "dashboard.public.max", value);
}

// Takes `request` because the SQL write is only HALF the restore. The resolver
// caches entitlements in Redis for up to 300s, so against a Redis-backed target
// (PROD_TARGET) putting the row back to 50 while the cache still holds 0 leaves
// the leak exactly as it was — every public competition the rest of the run
// creates degrades silently to private, which is the failure this hook exists to
// prevent and the one that took out ten smoke checks in this wave.
//
// The in-test restores below have always paired the two. This hook was added to
// cover the case they cannot — a test-level TIMEOUT abandons `finally` — and
// shipped with only the write, so it fixed the skipped-cleanup half and
// reintroduced the stale-cache half. Both, or neither.
test.afterEach(async ({ request }) => {
  for (const id of cappedOrgIds) {
    await setEntitlementOverrideSql(id, "dashboard.public.max", 50);
    await invalidateOrgEntitlements(request, id);
  }
  cappedOrgIds.clear();
});

/** The competition the API knows by this name, or fail loudly. */
async function fetchByName(
  request: Parameters<typeof apiJson>[0],
  name: string,
): Promise<{ id: string; slug: string; visibility: string }> {
  const list = await apiJson<{ items: { id: string; slug: string; name: string; visibility: string }[] }>(
    request,
    "/api/v1/competitions?limit=100",
  );
  const match = list.data!.items.find((c) => c.name === name);
  if (!match) throw new Error(`competition '${name}' not found in the org's list`);
  return match;
}

test("the wizard opens on Public, and at the cap it creates a PRIVATE competition with a note instead of a 402", async ({
  page,
}) => {
  const org = await activeOrg(page);
  const openName = `Public Default ${TAG}`;
  const cappedName = `Capped Default ${TAG}`;

  // Room to spare, so the first create is a clean read of the DEFAULT rather
  // than of the cap.
  await setEntitlementOverrideSql(org.id, "dashboard.public.max", 50);
  await invalidateOrgEntitlements(page.request, org.id);

  try {
    await page.goto("/competitions/new");
    await startBlankCompetition(page);
    await page.getByPlaceholder("Summer Championship 2026").fill(openName);
    await page.getByLabel(/^Ends on/i).fill("2030-12-31");

    // THE DEFAULT, read off the control the organiser sees — deliberately
    // WITHOUT touching the visibility picker, because the thing under test is
    // what the wizard opens on. Until V396 this was Private.
    await expect(page.getByRole("radio", { name: /^public/i })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^private/i })).not.toBeChecked();

    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/o\/[^/]+\/c\/(?!new$)[^/?]+$/, { timeout: 20_000 });
    // And the default REACHED the row, not just the radio: an untouched
    // picker whose value never got into the payload would look identical here.
    expect((await fetchByName(page.request, openName)).visibility).toBe("public");

    // Now the cap is met however many public dashboards the org already has:
    // a limit of 0 refuses the very first one, so this does not depend on
    // what any other spec left behind.
    await capPublicDashboards(org.id, 0);
    await invalidateOrgEntitlements(page.request, org.id);

    await page.goto("/competitions/new");
    await startBlankCompetition(page);
    await page.getByPlaceholder("Summer Championship 2026").fill(cappedName);
    await page.getByLabel(/^Ends on/i).fill("2030-12-31");
    await page.getByRole("button", { name: /create/i }).click();

    // NOT a 402, NOT an error, and NOT a redirect: the competition exists and
    // the organiser is told what happened to it, with a way to fix it and a
    // way onward.
    const note = page.getByTestId("public-quota-degraded");
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText(cappedName);
    await expect(note.getByRole("link", { name: /upgrade|plan|billing/i }).first()).toBeVisible();
    // The form is GONE, so the same night cannot be created twice by a second
    // press of a button sitting under the note.
    await expect(page.getByRole("button", { name: /^create competition$/i })).toHaveCount(0);

    const created = await fetchByName(page.request, cappedName);
    expect(created.visibility).toBe("private");

    await note.getByRole("button", { name: /continue/i }).click();
    await page.waitForURL(new RegExp(`/c/${created.slug}$`), { timeout: 20_000 });
  } finally {
    // Never leave the shared account at a cap of 0 — a failure above would
    // otherwise degrade every public competition the rest of the run creates.
    await setEntitlementOverrideSql(org.id, "dashboard.public.max", 50);
    await invalidateOrgEntitlements(page.request, org.id);
  }
});

test("the TEMPLATE GALLERY at the cap shows the same note — it does not redirect into a silently private competition", async ({
  page,
}) => {
  // T20 CRITICAL (reviewer pass 3, 2026-09-03). The wizard above proved the
  // MINORITY path: `/competitions/new` opens on the template gallery and
  // "start blank" is a button inside it, so the gallery is what most
  // organisers actually use. It POSTed /competitions/from-template and
  // redirected UNCONDITIONALLY, because `FromTemplateResult` carried no
  // visibility for it to diff — so a Free org at its cap created from a
  // template, landed on the competition page as if nothing had happened, and
  // shared a link that 404s for every fan (`public_fixtures_v` filters
  // `visibility = any('{public,unlisted}')`).
  //
  // Only a browser can answer this: the server-side degrade is unit-pinned in
  // `src/server/usecases/__tests__/templates.test.ts`, and no `environment:
  // "node"` test can see a redirect that should not have happened.
  //
  // slam128 for the same reason format-templates.spec.ts picks it: it sits
  // behind neither formats.double_elim nor formats.advanced, so the flow is
  // proven on the same tier whichever auth project runs it.
  const org = await activeOrg(page);
  const cappedName = `Capped Template ${TAG}`;

  await capPublicDashboards(org.id, 0);
  await invalidateOrgEntitlements(page.request, org.id);

  try {
    await page.goto(`/o/${org.slug}/c/new`);
    await expect(page.getByTestId("template-gallery")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("template-card-slam128").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByLabel("Name", { exact: false }).fill(cappedName);
    await sheet.getByLabel("Ends on", { exact: false }).fill("2030-12-31");
    await page.getByTestId("template-detail-submit").click();

    const note = page.getByTestId("public-quota-degraded");
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText(cappedName);
    await expect(note.getByRole("link", { name: /upgrade|plan|billing/i }).first()).toBeVisible();
    // THE REGRESSION: the redirect must NOT have fired. Asserted on the URL
    // rather than on the note alone — a note that renders for a beat while the
    // router navigates past it would satisfy the visibility check and still
    // ship the bug.
    expect(new URL(page.url()).pathname.endsWith("/c/new")).toBe(true);
    // And the "Use this template" button is gone with the form, so the same
    // event cannot be created twice by a second press.
    await expect(page.getByTestId("template-detail-submit")).toHaveCount(0);

    const created = await fetchByName(page.request, cappedName);
    expect(created.visibility).toBe("private");

    // The way onward still works — the competition exists, this is not an error.
    await page.getByTestId("template-degraded-continue").click();
    await page.waitForURL(new RegExp(`/c/${created.slug}$`), { timeout: 20_000 });
  } finally {
    await setEntitlementOverrideSql(org.id, "dashboard.public.max", 50);
    await invalidateOrgEntitlements(page.request, org.id);
  }
});
