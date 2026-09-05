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
import {
  HIDDEN_PASS_KEYS,
  SELLABLE_PASS_KEYS,
  formatMinor,
  passPrice,
  proPrice,
} from "@/lib/currency";
import { feeCrossoverMinor, readableMinor } from "@/lib/pricing-crossover";
import { PASS_RUNG_MARKETING_KEY } from "@/lib/pass-ladder";
import enMarketing from "@/dictionaries/en/marketing.json";

/** Each rung's usd price AS THE PAGE RENDERS IT — derived, never typed. W3
 *  repriced both rungs onto charm points ("$15" became "$11.99"), and a typed
 *  string would have turned a legitimate reprice into a page regression. */
const M_PRICE = formatMinor(passPrice("usd", "event_pass"), "usd");
const L_PRICE = formatMinor(passPrice("usd", "event_pass_l"), "usd");
/** Every rung's ladder label as the LIVE page would render it, keyed by rung.
 *  Read from the dictionary, so the sweep below enumerates what the page can
 *  say rather than a list typed here. */
const RUNG_LABEL: Record<string, string> = { event_pass: "M", event_pass_l: "L" };
/** The entry rung's ladder label, from the dictionary the page renders it from. */
const M_RUNG = (enMarketing as Record<string, string>)[PASS_RUNG_MARKETING_KEY.event_pass];

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

describe("/pricing renders only the Event Pass rungs that are on sale", () => {
  /** Every rung the ladder actually rendered, read out of the markup rather
   *  than inferred — `data-pass-rung` is written per row by the page. */
  const laddered = (markup: string): string[] =>
    [...markup.matchAll(/data-pass-rung="([^"]+)"/g)].map((m) => m[1]!);

  it("enumerates the ladder and finds exactly the sellable rungs", async () => {
    const { markup, text } = await render();
    expect(markup, "the ladder block itself").toContain("data-pass-ladder");
    // ENUMERATED, not asserted-absent. A `not.toContain("Event Pass L")` passes
    // on a page that renders nothing at all; this compares the rendered SET to
    // the authority, so a ladder that lost its only row fails just as loudly as
    // one that grew a row it should not have.
    expect(laddered(markup)).toEqual([...SELLABLE_PASS_KEYS]);

    // The positive half, in full: the rung that IS on sale, with its own price
    // and its own caps read from the matrix rather than written in copy.
    expect(text).toContain(M_PRICE);
    expect(text).toContain("Up to 10 divisions, 128 entrants each");

    // …and the negative half, stated against the hidden list rather than a
    // literal, and about the CAPS and the LABEL as well as the price — L's
    // price alone could plausibly appear in unrelated FAQ prose.
    for (const hidden of HIDDEN_PASS_KEYS) {
      expect(laddered(markup), `${hidden} is off sale`).not.toContain(hidden);
    }
    expect(text, "L's caps are its whole sales pitch").not.toContain("Up to 20 divisions");
    expect(text).not.toContain("unlimited entrants");
    expect(text, "the L price point").not.toContain(L_PRICE);
    // Anti-vacuity for all three: L's price is a real, DIFFERENT number, and
    // something really is hidden.
    expect(M_PRICE).not.toBe(L_PRICE);
    expect(HIDDEN_PASS_KEYS.length).toBeGreaterThan(0);
  });

  it("drops the ladder's two-size framing when only one size is on sale", async () => {
    // "from" reads as a floor and the note says "either way … Choose your size
    // when you check out" — both are statements about a CHOICE. Suppressed by
    // the rung count rather than deleted, so putting L back on sale restores
    // them without a copy change or a re-translation.
    const { text } = await render();
    const note = (enMarketing as Record<string, string>)["pricing.pass.ladderNote"]!;
    expect(SELLABLE_PASS_KEYS.length).toBe(1);
    expect(text).not.toContain(note);
    expect(text).not.toContain("Choose your size");
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
    // Asserted on the SELLABLE rung, because that is the only one the ladder
    // renders. It used to ride on L's live null cap; with L off sale the rule
    // needs a fixture that exercises it on the rung that is still quoted, or it
    // stops being tested at all.
    const { markup, text } = await render(
      LIVE.map((r) =>
        r.plan_key === "event_pass" && r.feature_key === "entrants.per_division.max"
          ? { ...r, int_value: null }
          : r,
      ),
    );
    expect(markup).toContain("data-pass-ladder");
    expect(text).toContain("unlimited entrants");
  });

  it("suppresses the ladder rather than quoting a figure it does not have", async () => {
    // A DB unreachable at build makes `loadMatrix` fail soft to `{}`; a missing
    // row read through `?? null` would advertise an UNLIMITED pass for M's price.
    // Absence must suppress, never embellish.
    //
    // The dropped rows are the SELLABLE rung's now. Dropping L's would prove
    // nothing: the guard only looks at rungs it is going to quote, which is
    // correct — a hidden rung's missing row must not take the live offer down.
    const { markup, text } = await render(LIVE.filter((r) => r.plan_key !== "event_pass"));
    expect(markup, "no rung may be priced from a row that isn't there").not.toContain(
      "data-pass-ladder",
    );
    // No cap is quoted for a rung whose row is gone. Anchored on the LADDER's
    // own phrasing ("Up to …"), because the card's static feature bullet also
    // says "128 entrants each" and is not what this rule is about.
    expect(text).not.toContain("Up to 10 divisions, 128 entrants each");
    expect(text).not.toContain("Up to 10 divisions");
    // …and the card still renders. Suppressing the ladder must not take the
    // Event Pass offer down with it.
    expect(text).toContain(M_PRICE);
  });

  it("keeps selling when a HIDDEN rung's matrix rows are missing entirely", async () => {
    // The other direction, and it is the dormancy half: the ladder must not
    // consult a rung it does not render. Before the sellable list existed this
    // fixture took the whole ladder down, because the guard demanded caps for
    // every rung in PASS_KEYS.
    const { markup, text } = await render(LIVE.filter((r) => r.plan_key !== "event_pass_l"));
    expect(markup).toContain("data-pass-ladder");
    expect(text).toContain(M_PRICE);
    expect(text).toContain("Up to 10 divisions, 128 entrants each");
  });
});

describe("/pricing's comparison table has no column for a rung nobody can buy", () => {
  const columns = (markup: string): string[] =>
    [...markup.matchAll(/data-pricing-column="([^"]+)"/g)].map((m) => m[1]!);

  it("enumerates the column set and finds no hidden rung in it", async () => {
    const { markup, text } = await render();
    const rendered = columns(markup);
    // The positive: the table is really there, with the free plan, the rung on
    // sale, and Pro. A negative-only assertion passes on a table that lost its
    // <thead> altogether.
    expect(markup).toContain("data-pricing-matrix");
    expect(rendered).toContain("community");
    expect(rendered).toContain("pro");
    for (const sellable of SELLABLE_PASS_KEYS) expect(rendered).toContain(sellable);
    // …and the negative.
    for (const hidden of HIDDEN_PASS_KEYS) {
      expect(rendered, `${hidden} has no column`).not.toContain(hidden);
      const label = (enMarketing as Record<string, string>)["pricing.table.pass"]!;
      expect(text, "no heading names the hidden rung").not.toContain(
        `${label} ${RUNG_LABEL[hidden]}`,
      );
    }
    // `enterprise` is the Contact-us strip, never a priced column (design §4).
    expect(rendered).not.toContain("enterprise");
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

  it("says WHICH RUNG it is true of — the card sells two and the crossing is one rung's", async () => {
    // The line is solved for ONE rung. Read without naming it, "this is the
    // cheaper option" is a claim about the whole Event Pass column, and it is
    // false of L: at L's price against a month of Pro, Pro is cheaper up front
    // AND per pound, so the two never cross. Scope, not suppression — the
    // suppression rule stays for the shapes that genuinely have no crossing.
    const { markup } = await render();
    const para = /<p[^>]*data-pass-crossover[^>]*>([\s\S]*?)<\/p>/.exec(markup);
    expect(para, "the comparator paragraph").not.toBeNull();
    const line = para![1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

    // The rung's own ladder label and its own price, TOGETHER — the two things
    // the list directly above it identifies each rung by. Both derived, neither
    // typed, and adjacency is what carries the meaning: a bare "M" would be
    // satisfied by any capital M on the line, and a bare price by the sticker
    // price the card already quotes twice.
    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      line,
      `the line must name the ${M_RUNG} rung beside its own price`,
    ).toMatch(new RegExp(`\\b${escape(M_RUNG)}\\b[^.;]{0,20}${escape(M_PRICE)}`));
    // …and NOT the other rung, which this sentence is not true of.
    expect(M_PRICE).not.toBe(L_PRICE);
    expect(line, "the line must not read as a claim about L").not.toContain(L_PRICE);
    // The claim itself is still intact around the scoping.
    expect(line).toContain(CROSSING);
    expect(line).toContain("2% platform fee against 4%");
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
