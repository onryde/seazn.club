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
import type { Frame, Page } from "@playwright/test";

// Stripe serves the hosted page in two layouts and picks one per session (seen
// on CI 2026-11-12: the same spec red on one run, green on its retry).
//
//   legacy:   the card form lives on the checkout page itself -- #cardNumber,
//             #cardExpiry, #cardCvc, #billingName, #billingCountry,
//             #billingPostalCode, and a "Choose currency" button group.
//   embedded: the card form is a Payment Element inside an iframe
//             (#payment-numberInput, #payment-expiryInput, #payment-cvcInput,
//             #payment-nameInput, #payment-countryInput,
//             #payment-postalCodeInput), the currency picker is radio inputs
//             (#currency-gbp) in another iframe, and Link's "Save my
//             information" box is ticked by default and asks for a phone.
//
// Waiting only for #cardNumber sat out 60s against a fully rendered embedded
// form and read like a slow page. So wait for EITHER, then fill the one shown.
type Layout = { kind: "legacy" } | { kind: "embedded"; form: Frame };

async function frameWith(page: Page, selector: string): Promise<Frame | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if (await frame.locator(selector).isVisible()) return frame;
    } catch {
      // A frame can detach while we look; the next poll sees the new one.
    }
  }
  return null;
}

async function waitForLayout(page: Page, timeoutMs: number): Promise<Layout> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator("#cardNumber").isVisible().catch(() => false)) return { kind: "legacy" };
    const form = await frameWith(page, "#payment-numberInput");
    if (form) return { kind: "embedded", form };
    // When the session offers more than one method, the legacy layout shows
    // them as an accordion with Card collapsed: open it. The row's own
    // <button> renders 0x0 (an expanded click area), so click the row.
    const cardRow = page.locator('[data-testid="card-accordion-item"]');
    if (await cardRow.isVisible().catch(() => false)) await cardRow.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Stripe hosted checkout: neither the legacy card form (#cardNumber) nor the embedded Payment Element ` +
      `(#payment-numberInput in an iframe) became visible within ${timeoutMs}ms at ${page.url()}`,
  );
}

/**
 * Fill the hosted-checkout card form with the Stripe test card, having first
 * pinned currency and billing country so the page renders the same everywhere.
 *
 * Stops short of submitting: callers screenshot between filling and paying,
 * and they differ in what they do afterwards. The Pay button is
 * `button[type=submit]` in both layouts.
 */
export async function fillHostedCheckout(page: Page, cardholder: string): Promise<void> {
  // Stripe serves a skeleton first and hydrates the form after. Waiting for
  // the field beats a fixed pause, which fails as "element not found" against
  // a grey placeholder and reads like a rotted selector.
  const layout = await waitForLayout(page, 60_000);
  if (layout.kind === "legacy") await fillLegacy(page, cardholder);
  else await fillEmbedded(page, layout.form, cardholder);
}

async function fillLegacy(page: Page, cardholder: string): Promise<void> {
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

async function fillEmbedded(page: Page, form: Frame, cardholder: string): Promise<void> {
  // Currency: radio inputs in their own iframe, only when Adaptive Pricing
  // offers a local alternative. The inputs are visually hidden behind their
  // labels, so click the element itself (HTMLElement.click runs the radio's
  // activation and fires the change the picker listens for).
  const currency = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("currency-selector"));
  if (currency) {
    const gbp = currency.locator("#currency-gbp");
    if ((await gbp.count()) && !(await gbp.isChecked())) {
      await gbp.evaluate((el) => (el as HTMLInputElement).click());
      await page.waitForTimeout(800);
    }
  }

  // Country before postal, as in the legacy layout.
  const country = form.locator("#payment-countryInput");
  if (await country.count()) {
    await country.selectOption("GB");
    await page.waitForTimeout(500);
  }

  await form.locator("#payment-numberInput").fill("4242424242424242");
  await form.locator("#payment-expiryInput").fill("12/34");
  await form.locator("#payment-cvcInput").fill("123");

  const holder = form.locator("#payment-nameInput");
  if (await holder.count()) await holder.fill(cardholder);

  const postal = form.locator("#payment-postalCodeInput");
  if ((await postal.count()) && (await postal.isVisible())) await postal.fill("SW1A 1AA");

  // Link's "Save my information for faster checkout" is ticked by default in
  // this layout and then wants a mobile number before Pay will submit.
  const linkOptIn = form.locator("#payment-linkOptInInput");
  if ((await linkOptIn.count()) && (await linkOptIn.isChecked())) {
    await linkOptIn.evaluate((el) => (el as HTMLInputElement).click());
    await page.waitForTimeout(300);
  }
}
