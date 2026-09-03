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
    // what the wizard opens on. Until V395 this was Private.
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
    await setEntitlementOverrideSql(org.id, "dashboard.public.max", 0);
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
