// Filling Stripe's HOSTED checkout page, in a way that does not depend on
// where the machine running the browser happens to be.
//
// This exists because of a CI failure that could not reproduce locally. The
// three walkthroughs that pay through Connect each carried their OWN verbatim
// copy of the fill sequence (one of them said "copied verbatim from
// registration-connect.spec.ts" in a comment), and every copy hard-coded a UK
// postcode:
//
//     await postal.fill("SW1A 1AA");
//
// Stripe renders the hosted page for the BUYER's location. From a UK desktop
// that is a "Postcode" field which takes it. From a GitHub runner -- AWS
// us-east -- it is a US "ZIP" field that strips non-digits, so "SW1A 1AA"
// became "11", the form said "Your ZIP is incomplete", the Pay button never
// submitted, and all three specs sat in `waitForURL(/register\/status/)` until
// the 120s timeout. The error surfaced as a navigation timeout, which reads
// like a slow redirect rather than a form that was never valid.
//
// The same geography moves the money: with Adaptive Pricing the US-located
// buyer is offered "US $42.22" beside "GB £30.00", and the specs assert GBP.
//
// So pin both rather than detect either, and keep it in ONE place -- three
// copies of an assumption is how one wrong assumption became three red tests.
import type { Page } from "@playwright/test";

/**
 * Fill the hosted-checkout card form with the Stripe test card, having first
 * pinned currency and billing country so the page renders the same everywhere.
 *
 * Stops short of submitting: callers screenshot between filling and paying,
 * and they differ in what they do afterwards.
 */
export async function fillHostedCheckout(page: Page, cardholder: string): Promise<void> {
  // Stripe serves a skeleton first and hydrates the form after. Waiting for
  // the field beats a fixed pause, which fails as "element not found" against
  // a grey placeholder and reads like a rotted selector.
  await page.locator("#cardNumber").waitFor({ state: "visible", timeout: 60_000 });

  // Currency first: switching it re-renders the totals.
  // Only present when Adaptive Pricing offers a local alternative, i.e. never
  // when running from the UK -- hence the count() guard rather than a wait.
  const gbp = page.getByRole("group", { name: /Choose currency/i }).getByRole("button", { name: /£/ });
  if (await gbp.count()) {
    // The ACTIVE currency renders disabled; a live £ button means GBP is not
    // currently selected, so clicking it is what we want.
    if (await gbp.first().isEnabled()) {
      await gbp.first().click();
      await page.waitForTimeout(500);
    }
  }

  // Country before postal: changing it swaps the postal field between a US
  // ZIP (digits, 5) and a UK postcode (alphanumeric), and clears what is there.
  const country = page.locator("#billingCountry");
  if (await country.count()) {
    await country.selectOption("GB");
    await page.waitForTimeout(500);
  }

  await page.locator("#cardNumber").fill("4242424242424242");
  await page.locator("#cardExpiry").fill("12/34");
  await page.locator("#cardCvc").fill("123");

  const holder = page.locator("#billingName");
  if (await holder.count()) await holder.fill(cardholder);

  const postal = page.locator("#billingPostalCode");
  if (await postal.count()) await postal.fill("SW1A 1AA");
}
