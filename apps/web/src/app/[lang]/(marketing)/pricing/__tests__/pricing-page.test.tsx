// /pricing, rendered — the wave's headline buyer-facing surface.
//
// What was missing. The M/L ladder on the Event Pass card is the only place a
// buyer sees both rungs priced side by side before choosing a competition, and
// nothing witnessed it: deleting the whole `<ul data-pass-ladder>` block left
// `tsc` at EXIT=0 and every unit suite green, because `pricing-matrix.test.ts`
// only proves the ROW BUILDER can produce five columns and `pricing-cards.test.ts`
// only proves the copy quotes the right numbers. Neither renders the page.
//
// It also pins the ladder's deliberate ASYMMETRY (see below), which is the one
// way the block can legitimately disappear.
//
// Rendered through react-dom/server — vitest runs `environment: "node"` and
// this workspace has no jsdom (same pattern as upgrade-page.test.tsx). The
// dictionary and every pure pricing module are REAL, because the assertions are
// about the figures and copy a buyer actually reads.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  rows: [] as {
    plan_key: string;
    feature_key: string;
    bool_value: boolean | null;
    int_value: number | null;
  }[],
}));

vi.mock("@/lib/db", () => ({ sql: () => Promise.resolve(h.rows) }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => null,
  getUserOrgs: async () => [],
  getActiveOrgId: async () => null,
}));
// The shell pulls in next/font and the nav/footer trees; none of that is what
// this test is about.
vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/analytics-track-mount", () => ({ TrackOnMount: () => null }));
// CurrencySwitcher is a client component and calls useRouter on render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/en/pricing",
  useSearchParams: () => new URLSearchParams(),
}));

import PricingPage from "../page";
import { formatMinor, passPrice, proPrice } from "@/lib/currency";
import { feeCrossoverMinor, readableMinor } from "@/lib/pricing-crossover";

/** Each rung's usd price AS THE PAGE RENDERS IT — derived, never typed. W3
 *  repriced both rungs onto charm points ("$15" became "$11.99"), and a typed
 *  string would have turned a legitimate reprice into a page regression. */
const M_PRICE = formatMinor(passPrice("usd", "event_pass"), "usd");
const L_PRICE = formatMinor(passPrice("usd", "event_pass_l"), "usd");

/**
 * The keys this page's Event Pass card renders from: the two V341 makes the
 * rungs differ on, plus `registration.fee_percent` for the pass/Pro comparator.
 *
 * NOT a mirror of the live matrix, and it never was — the header comment that
 * said so was wrong twice over. `event_pass_l`'s entrant cap is deliberately
 * NULL here because the unlimited branch is what two of the tests below exist
 * to pin, while V392 gave the live rung a real 512; and there was no fee row at
 * all despite the comment promising one. The live figures are pinned against
 * `plan_entitlements` by lib/__tests__/pricing-cards.test.ts and
 * lib/__tests__/pricing-crossover.test.ts, which is where that job belongs.
 */
const LIVE = [
  { plan_key: "community", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 4 },
  { plan_key: "event_pass", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 10 },
  { plan_key: "event_pass_l", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 20 },
  { plan_key: "community", feature_key: "entrants.per_division.max", bool_value: null, int_value: 64 },
  { plan_key: "event_pass", feature_key: "entrants.per_division.max", bool_value: null, int_value: 128 },
  // null int_value on a PRESENT row = unlimited. This is the figure the L rung
  // is sold on.
  { plan_key: "event_pass_l", feature_key: "entrants.per_division.max", bool_value: null, int_value: null },
  // The fee ladder the comparator is derived from (V397: community 5, pass 4,
  // pro 2). The pass costs MORE per pound of entry fees and less up front,
  // which is the whole shape of the crossing.
  { plan_key: "community", feature_key: "registration.fee_percent", bool_value: null, int_value: 5 },
  { plan_key: "event_pass", feature_key: "registration.fee_percent", bool_value: null, int_value: 4 },
  { plan_key: "event_pass_l", feature_key: "registration.fee_percent", bool_value: null, int_value: 4 },
  { plan_key: "pro", feature_key: "registration.fee_percent", bool_value: null, int_value: 2 },
];

const render = async (rows = LIVE) => {
  h.rows = rows;
  const markup = renderToStaticMarkup(await PricingPage({ params: Promise.resolve({ lang: "en" }) }));
  // Tailwind ships class names like `text-2xl` and `basis-full` in every class
  // list, so copy guards must run on stripped text, not on HTML.
  return { markup, text: markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ") };
};

describe("/pricing renders the Event Pass M/L ladder", () => {
  it("shows BOTH rungs, each with its own price and its own caps", async () => {
    const { markup, text } = await render();
    expect(markup, "the ladder block itself").toContain("data-pass-ladder");
    // Both prices. M's alone was always on this page; L's is the new claim.
    // They must also DIFFER, or "each with its own price" is unwitnessable.
    expect(M_PRICE).not.toBe(L_PRICE);
    expect(text).toContain(M_PRICE);
    expect(text).toContain(L_PRICE);
    // Both rungs' caps, read from the matrix rather than written in copy.
    expect(text).toContain("Up to 10 divisions, 128 entrants each");
    expect(text).toContain("Up to 20 divisions, unlimited entrants");
    // The price is a FLOOR, not the price — the card must say so.
    expect(text.toLowerCase()).toContain("from");
  });

  it("never claims a multiplier — the L/M ratio is not uniform across currencies", async () => {
    const { text } = await render();
    // 2.03x in USD but 1.96x in GBP and 2.25x in INR, so any "double" framing
    // is false in some currency (ledger copy constraint, T2).
    //
    // "double elimination" / "double elim" is a BRACKET FORMAT and reaches
    // this page in unrelated places (the pass bullet, the matrix row label).
    // The strip is NECESSARY, not tidy: without it a page-wide /\bdouble\b/
    // would be permanently RED on a page that has never made a multiplier
    // claim, and the only way to get it green again would be to delete the
    // guard. Stripped, it has real teeth — it fails on "double the size",
    // "twice the price", "2×" and "2x" anywhere in the price copy.
    const priceCopy = text.toLowerCase().replace(/double elim(ination)?/g, "");
    expect(priceCopy).not.toMatch(/\bdouble\b|\btwice\b|\b2×\b|\b2x\b/);
    // Owner decision: no "best value" label anywhere on the ladder.
    expect(priceCopy).not.toContain("best value");
  });

  // ── The asymmetry, pinned ────────────────────────────────────────────────
  //
  // `entrants` needs only the ROW to exist — a null int_value there is
  // honoured as "unlimited", because that is exactly what L sells.
  // `divisions` additionally needs a NUMBER, because the copy reads "Up to
  // {divisions} divisions" and a null would render "Up to  divisions".
  //
  // That is deliberate, not an oversight — but it means an unlimited division
  // cap would take the whole L presentation off the card. The first test above
  // is what reds if that ever happens; these two pin the rule itself so the
  // behaviour is a documented choice rather than an accident.

  it("honours a null ENTRANT cap as unlimited rather than suppressing the ladder", async () => {
    const { markup, text } = await render();
    expect(markup).toContain("data-pass-ladder");
    expect(text).toContain("unlimited entrants");
  });

  it("suppresses the ladder rather than quoting a figure it does not have", async () => {
    // A DB unreachable at build makes `loadMatrix` fail soft to `{}`; a missing
    // row read through `?? null` would advertise an UNLIMITED pass for M's price.
    // Absence must suppress, never embellish.
    const { markup, text } = await render(LIVE.filter((r) => r.plan_key !== "event_pass_l"));
    expect(markup, "no rung may be priced from a row that isn't there").not.toContain(
      "data-pass-ladder",
    );
    // No cap is quoted for a rung whose row is gone.
    expect(text).not.toContain("Up to 20 divisions");
    expect(text).not.toContain("unlimited entrants");
    // …and the card still renders. Suppressing the ladder must not take the
    // Event Pass offer down with it.
    expect(text).toContain(M_PRICE);
    // Deliberately NOT a page-wide L-price negative. The FAQ answer interpolates
    // {passL} from stripe-plans.json, a STATIC file that is never unavailable —
    // so it keeps naming both rungs' prices even when the matrix read fails.
    // That is correct: the suppression rule guards against quoting a CAP we do
    // not have, not against quoting a price we always do.
    expect(text).toContain(L_PRICE);
  });
});

// ── The pass/Pro comparator ─────────────────────────────────────────────────
//
// The page priced both offers and left the buyer to work out which one costs
// them less, which reads as "the pass is cheaper" — true only below one
// threshold, and the threshold was stated nowhere. Naming it is the whole
// point, so the assertions below are about the FIGURE, not about the element
// being present.
describe("/pricing names where Pro overtakes the Event Pass", () => {
  /** The crossing as the page derives it: catalogue prices, matrix fee rates. */
  const CROSSING = formatMinor(
    readableMinor(
      feeCrossoverMinor({
        passMinor: passPrice("usd", "event_pass"),
        proMonthlyMinor: proPrice("monthly", "usd"),
        passFeePercent: 4,
        proFeePercent: 2,
      })!,
    ),
    "usd",
  );

  it("quotes the crossing and both fee rates, none of them typed", async () => {
    const { markup, text } = await render();
    expect(markup, "the comparator itself").toContain("data-pass-crossover");
    expect(CROSSING).toBe("$150");
    expect(text).toContain(CROSSING);
    // Both sides of the fee ladder, so the reader can check the arithmetic.
    expect(text).toContain("2% platform fee against 4%");
    // …and Pro's own price, since that is the other half of what they would pay.
    expect(text).toContain(`${formatMinor(proPrice("monthly", "usd"), "usd")}/mo`);
    // The crossing is a THIRD number, not either sticker price echoed back —
    // a comparator that printed one of those would satisfy a bare
    // "contains a currency amount" assertion.
    expect(CROSSING).not.toBe(M_PRICE);
    expect(CROSSING).not.toBe(formatMinor(proPrice("monthly", "usd"), "usd"));
  });

  it("says nothing at all when a fee rate could not be read", async () => {
    // `loadMatrix` fails soft to `{}` when the DB is unreachable at build. A
    // missing rate must take the sentence with it: a threshold computed from a
    // rate we do not have is a number invented at the point of sale.
    const { markup, text } = await render(
      LIVE.filter((r) => !(r.feature_key === "registration.fee_percent" && r.plan_key === "pro")),
    );
    expect(markup).not.toContain("data-pass-crossover");
    expect(text).not.toContain(CROSSING);
    // …and the card still sells. Suppressing the comparator must not take the
    // Event Pass offer down with it.
    expect(text).toContain(M_PRICE);
  });

  // The ladder shapes that have NO crossing at all — equal fees, a pass that is
  // cheaper per pound, a pass that costs more up front — are pinned in
  // lib/__tests__/pricing-crossover.test.ts rather than here. Measured: at this
  // level they are unkillable. `readableMinor`'s own "nothing to render" floor
  // catches the ±Infinity and NaN those shapes produce, so a page test for them
  // stays green with the helper's guard deleted, and would be decoration.
});
