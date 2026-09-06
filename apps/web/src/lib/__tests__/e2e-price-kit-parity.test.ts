import { describe, it, expect } from "vitest";
import {
  ALL_PLAN_KEYS,
  HIDDEN_PASS_KEYS,
  PASS_KEYS,
  SELLABLE_PASS_KEYS,
  SUPPORTED_CURRENCIES,
  formatMinor,
  passPrice,
  proPrice,
  type Currency,
} from "@/lib/currency";
import { ORG_ADDONS, orgAddonPriceMinor } from "@/lib/org-addons";
import { ORG_ADDON_PLAN_KEYS } from "@/lib/org-addon-plans";
import {
  HIDDEN_PASS_RUNGS,
  ORG_ADDON_RIDER_PLANS,
  SELLABLE_PASS_RUNGS,
  money,
  orgAddonLabel,
  orgAddonMinor,
  passMinor,
  proMinor,
  passLabel,
  proAnnualPerMonthLabel,
} from "../../../e2e/price-kit";

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

  // WHICH RUNGS ARE ON SALE, restated in the kit for the same reason every
  // price is: a VALUE import of `SELLABLE_PASS_KEYS` from a spec drags the
  // app's bare `stripe-plans.json` import into Playwright's ESM loader, the
  // loader refuses the JSON, and the importing spec collects ZERO TESTS. That
  // is a whole file silently leaving the run, which is worse than a stale
  // literal — so the lists are mirrored, and mirrored means guarded here.
  //
  // ORDER matters as well as membership: the e2e ladder assertion compares the
  // rendered control set to `SELLABLE_PASS_RUNGS` element for element, and a
  // reordered mirror would make that comparison fail against a correct page.
  it("mirrors the sellable and hidden rung lists exactly, in order", () => {
    expect([...SELLABLE_PASS_RUNGS]).toEqual([...SELLABLE_PASS_KEYS]);
    expect([...HIDDEN_PASS_RUNGS]).toEqual([...HIDDEN_PASS_KEYS]);
    // …and together they are still the whole ladder, so a rung added to
    // `PASS_KEYS` cannot land in neither list and vanish from the e2e suite's
    // view of the shop.
    expect([...SELLABLE_PASS_RUNGS, ...HIDDEN_PASS_RUNGS].sort()).toEqual([...PASS_KEYS].sort());
    // Anti-vacuity: something really is on sale, and something really is
    // hidden, or both assertions above are about empty arrays.
    expect(SELLABLE_PASS_RUNGS.length).toBeGreaterThan(0);
    expect(HIDDEN_PASS_RUNGS.length).toBeGreaterThan(0);
  });

  // The extra-organisation rider (v17 gap #293). Mirrored here for TWO reasons
  // at once — `lib/org-addons.ts` opens with `import "server-only"` and pulls
  // the seed in as a bare JSON import — so `settings-add-ons-drive.spec.ts`
  // could not quote the price it asserts without this kit.
  it("prices the extra-organisation rider exactly as the Add-ons tab does", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      for (const entry of ORG_ADDONS) {
        expect(orgAddonMinor(entry.planKey, currency), `${entry.planKey} ${currency}`).toBe(
          orgAddonPriceMinor(entry.planKey, currency),
        );
        // The RENDERED string, because the stepper asserts prose, not a number.
        expect(orgAddonLabel(entry.planKey, currency)).toBe(
          formatMinor(orgAddonPriceMinor(entry.planKey, currency)!, currency),
        );
      }
      // The null branch, guarded rather than assumed. `orgAddonPriceMinor`
      // returns null — not 0 — for a plan with no rider SKU, and 0 would read
      // to a customer as a free add-on. Community is the live case: the tab
      // renders `addOns.communityNotice` instead of a stepper on the strength
      // of exactly this answer.
      expect(orgAddonMinor("community", currency)).toBeNull();
      expect(orgAddonPriceMinor("community", currency)).toBeNull();
    }
    // Anti-vacuity for the loop above: the seed really does sell a rider
    // somewhere, or every assertion in it is about an empty list.
    expect(ORG_ADDONS.length).toBeGreaterThan(0);
    expect(ORG_ADDON_RIDER_PLANS).toEqual([...ORG_ADDON_PLAN_KEYS]);
    expect(ORG_ADDON_RIDER_PLANS).not.toContain("community");
  });
});
