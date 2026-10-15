import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg, failOnNativeDialog, competitionPath } from "./helpers";

// PROMPT-32 acceptance: match-day cards navigate, ConfirmDialog replaced
// window.confirm everywhere, and the visibility picker surfaces the share
// URL with unchanged noindex behaviour.

test("card grid: competition card renders match-day anatomy and navigates", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Card Nav ${TAG}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);

  await page.goto("/dashboard");
  const card = page
    .locator("article")
    .filter({ hasText: `Card Nav ${TAG}` })
    .first();
  await expect(card).toBeVisible();
  // Status chip vocabulary (v3/03 §1): a fresh competition reads "Draft".
  await expect(card.getByText("Draft", { exact: true })).toBeVisible();
  // Whole card is the click target (stretched link).
  await card.getByRole("link", { name: `Card Nav ${TAG}` }).click();
  // PROMPT-30: cards navigate to the slug URL.
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/?]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: `Card Nav ${TAG}` })).toBeVisible();
});

test("destructive action uses ConfirmDialog — a native confirm() fails the test", async ({
  page,
  request,
}) => {
  // Clubs delete is a canonical destructive flow reachable on every plan.
  const club = await apiJson<{ id: string; name: string }>(request, "/api/v1/clubs", "POST", {
    name: `Doomed Club ${TAG}`,
  });
  expect(club.status).toBeLessThan(300);

  failOnNativeDialog(page); // any window.confirm/alert = instant failure
  // Delete moved to the club hub's danger zone (the directory list is read/create only).
  await page.goto(`/clubs/${club.data!.id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  // The app-owned dialog, not the browser's.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/its teams stay/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Delete club" }).click();

  // Confirming lands back on the directory, with the club gone from the list.
  await page.waitForURL(/\/directory\?tab=clubs/);
  await expect(page.getByRole("link", { name: new RegExp(`Doomed Club ${TAG}`) })).toHaveCount(0);
});

// A refused delete used to put its reason in the tab's top banner — off-screen
// from the danger zone at every width (320: ~1136px above the fold), so the
// organiser saw nothing happen. It now renders beside the Delete button. The
// widths are the house screenshot bar; 320 is where the banner was furthest.
// The organiser is scrolled just far enough to see the button (its bottom on
// the viewport's bottom edge): an outcome appended under it lands below the
// fold there (measured ~10px under at all three widths), so the danger zone
// brings it into view.
test("a refused club delete shows its reason beside the Delete button, on screen at 1280, 768 and 320", async ({
  page,
  request,
}) => {
  const club = await apiJson<{ id: string }>(request, "/api/v1/clubs", "POST", { name: `Kept Club ${TAG}` });
  expect(club.status).toBeLessThan(300);
  const clubPath = `/clubs/${club.data!.id}`;
  const reason = `Club still has entries in a live division (${TAG}).`;
  const refusals: string[] = [];
  await page.route(`**/api/v1/clubs/${club.data!.id}`, (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    refusals.push(route.request().url());
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: "CONFLICT", message: reason } }),
    });
  });

  const widths = [1280, 768, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 800 });
    await page.goto(clubPath);
    const del = page.getByRole("button", { name: "Delete", exact: true });
    await del.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - window.innerHeight + 1));
    await expect(del, `${width}px: the button sits on the bottom edge`).toBeInViewport({ ratio: 1 });
    await del.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete club" }).click();

    const alert = page.getByRole("alert").filter({ hasText: reason });
    await expect(alert, `${width}px: the reason renders once`).toHaveCount(1);
    await expect(alert, `${width}px: the reason is wholly on screen`).toBeInViewport({ ratio: 1 });
    // It sits in the danger zone, under the button — not in the top banner.
    const danger = page.locator("section").filter({ has: page.getByRole("button", { name: "Delete", exact: true }) });
    await expect(danger.getByRole("alert").filter({ hasText: reason })).toHaveCount(1);
    const [button, said] = await Promise.all([
      danger.getByRole("button", { name: "Delete", exact: true }).boundingBox(),
      alert.boundingBox(),
    ]);
    expect(said!.y, `${width}px: below the button`).toBeGreaterThanOrEqual(button!.y + button!.height);
    // Refused: still on the club, which still exists.
    expect(new URL(page.url()).pathname).toBe(clubPath);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px: no horizontal page scroll`).toBeLessThanOrEqual(0);
  }
  expect(refusals).toHaveLength(widths.length);
  const still = await apiJson<{ id: string }>(request, `/api/v1/clubs/${club.data!.id}`, "GET");
  expect(still.status).toBe(200);
});

test("visibility picker: Link only surfaces a copyable URL; public page stays noindex", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Vis Flip ${TAG}`,
    visibility: "private",
  });
  expect(comp.status).toBeLessThan(300);
  const orgSlug = (await activeOrg(page)).slug;

  await page.goto(await competitionPath(page.request, comp.data!.id, "/settings"));
  // Radio cards speak plain language (v3/03 §7).
  await expect(page.getByText("Only your team can see it.")).toBeVisible();
  await page.getByRole("radio", { name: /link only/i }).check();
  // The consequence is immediate: share URL + copy affordance appear.
  await expect(page.getByText(`/shared/${orgSlug}/${comp.data!.slug}`).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /copy link/i })).toBeVisible();
  await page.getByRole("button", { name: /save settings/i }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();

  // Keys/noindex behaviour unchanged: unlisted pages serve a robots noindex.
  const res = await page.request.get(`/shared/${orgSlug}/${comp.data!.slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/noindex/);
});
