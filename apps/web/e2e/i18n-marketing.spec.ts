// Marketing [lang] routing (v5 i18n §5), proven on /start. Verified manually
// via SSR fetch during T8; this is the CI regression guard.
import { test, expect } from "@playwright/test";

test("localized /fr/start resolves and sets html lang after hydration", async ({ page }) => {
  const res = await page.goto("/fr/start");
  expect(res?.status()).toBe(200);
  // Root layout SSRs lang=en (kept static for ISR); HtmlLang corrects it client-side.
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test("a NON-marketing tree also corrects html lang — the [lang] segment is not the only fix", async ({
  page,
  context,
}) => {
  // §17.4. Until this shipped, `<HtmlLang>` was mounted ONLY in
  // [lang]/(marketing), so every other tree — console, public, admin — served
  // French, Spanish and Dutch copy under lang="en" and a screen reader
  // pronounced it with English rules. The root layout cannot fix it
  // server-side without opting the whole app into dynamic rendering
  // (resolve-locale.ts:17-18), so the correction is client-side: DictProvider
  // writes the server-resolved locale, and the root layout falls back to the
  // seazn_locale cookie where no provider is mounted.
  //
  // Driven through a real page rather than asserted about the source, because
  // "the component is mounted" and "the attribute is corrected" are different
  // claims and only this one is the finding.
  await context.addCookies([
    { name: "seazn_locale", value: "fr", url: "http://localhost:3100" },
  ]);
  const res = await page.goto("/login");
  expect(res?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test("no locale cookie leaves html lang at the served default, never blank", async ({ page }) => {
  // The negative half. A guess must never clobber the attribute with an empty
  // string or "undefined" — that is worse for a screen reader than plain "en",
  // and a cookie-driven correction is exactly the shape that regresses that way.
  await page.goto("/login");
  const lang = await page.locator("html").getAttribute("lang");
  expect(lang).toBeTruthy();
  expect(["en", "es", "fr", "nl"]).toContain(lang);
});

test("unprefixed /start serves en via rewrite (no redirect)", async ({ page }) => {
  const res = await page.goto("/start");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/start$/); // rewrite, not a redirect to /en/start
});

test("hreflang alternates present for all four locales + x-default", async ({ page }) => {
  await page.goto("/en/start");
  for (const l of ["en", "fr", "es", "nl", "x-default"]) {
    await expect(page.locator(`link[rel="alternate"][hreflang="${l}"]`)).toHaveCount(1);
  }
});

test("unsupported locale 404s", async ({ page }) => {
  const res = await page.goto("/de/start");
  expect(res?.status()).toBe(404);
});
