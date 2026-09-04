import { describe, it, expect } from "vitest";
import {
  ALL_PLAN_KEYS,
  PASS_KEYS,
  SUPPORTED_CURRENCIES,
  formatMinor,
  passPrice,
  proPrice,
  type Currency,
} from "@/lib/currency";
import { money, passMinor, proMinor, passLabel, proAnnualPerMonthLabel } from "../../../e2e/price-kit";

/**
 * The e2e suite cannot import `@/lib/currency` at RUNTIME.
 *
 * Playwright runs `apps/web` as ESM (`"type": "module"`), and `currency.ts`
 * pulls the seed in as a bare `import stripePlans from "@/config/…json"`. The
 * `@/` alias resolves fine under Playwright's transform; Node's ESM loader then
 * refuses the JSON itself — `needs an import attribute of "type: json"` — so a
 * spec that imports `formatMinor` collects ZERO tests and the whole file
 * disappears from the run. (Verified: `playwright test --list` on a scratch
 * spec importing `formatMinor` prints "No tests found".) That is why
 * `e2e/price-kit.ts` reads the seed itself, with the attribute, and restates
 * the format rule.
 *
 * A restated rule is a second authority, and a second authority drifts. This
 * file is the thing that stops it: every function in the kit is compared to the
 * production one it mirrors, over every currency and every SKU the seed
 * carries, so a change to `formatMinor` or to a price point moves the e2e
 * expectations with it — or reds here, naming what to fix — instead of surfacing
 * as an e2e failure on `main` after a merge.
 *
 * Reference-only, no DB, so it runs everywhere.
 */
describe("e2e/price-kit mirrors lib/currency", () => {
  it("formats every amount the way the pages do", () => {
    // The seed's own amounts, plus the shapes that separate the two branches of
    // formatMinor's whole/fractional rule: a whole amount drops the decimals, a
    // fractional one keeps them. A kit that only ever saw charm prices would
    // pass with the rule inverted.
    const probes = new Set<number>([0, 1, 99, 100, 999, 1199, 1499, 4499, 8899, 100_00, 499900]);
    for (const currency of SUPPORTED_CURRENCIES) {
      for (const key of PASS_KEYS) probes.add(passPrice(currency, key));
      for (const interval of ["monthly", "annual"] as const) {
        probes.add(proPrice(interval, currency));
        probes.add(Math.round(proPrice(interval, currency) / 12));
      }
    }
    expect(probes.size).toBeGreaterThan(20);
    for (const currency of SUPPORTED_CURRENCIES) {
      for (const minor of probes) {
        expect(money(minor, currency), `${minor} ${currency}`).toBe(formatMinor(minor, currency));
      }
    }
  });

  it("reads the same price points out of the same seed", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      for (const key of PASS_KEYS) {
        expect(passMinor(key, currency), `${key} ${currency}`).toBe(passPrice(currency, key));
        expect(passLabel(key, currency)).toBe(formatMinor(passPrice(currency, key), currency));
      }
      for (const interval of ["monthly", "annual"] as const) {
        expect(proMinor(interval, currency), `pro ${interval} ${currency}`).toBe(
          proPrice(interval, currency),
        );
      }
      // The pricing page's annual framing is `round(annual / 12)`, formatted —
      // pricing-v3.spec.ts asserts the rendered string, so the kit has to agree
      // on the rounding as well as on the price.
      expect(proAnnualPerMonthLabel(currency), `annual/12 ${currency}`).toBe(
        formatMinor(Math.round(proPrice("annual", currency) / 12), currency),
      );
    }
  });

  it("defaults to the currency the e2e suite actually runs in", () => {
    // Playwright's default locale is en-US, so `currencyFromAcceptLanguage`
    // lands the specs on usd and every bare call in them omits the currency.
    // If that default ever moved, the specs would assert a price nothing
    // renders.
    const usd: Currency = "usd";
    expect(passMinor("event_pass")).toBe(passPrice(usd, "event_pass"));
    expect(passLabel("event_pass")).toBe(formatMinor(passPrice(usd, "event_pass"), usd));
    expect(money(1199)).toBe(formatMinor(1199, usd));
  });

  it("is not blind to a rung the seed grows", () => {
    // Anti-vacuity for the loops above: PASS_KEYS is the union the kit is typed
    // against, and every member has to be a seed row it can price.
    expect(PASS_KEYS.length).toBeGreaterThanOrEqual(2);
    expect(ALL_PLAN_KEYS).toContain("pro");
    for (const key of PASS_KEYS) expect(passMinor(key, "usd")).toBeGreaterThan(0);
  });
});
