// /pricing, rendered — the wave's headline buyer-facing surface.
//
// R14 (entitlements v18 W3) redesigned this page around a box-office ticket
// composition: a sport rail, an Event Pass TICKET with a two-slot stub (Size
// M + the pass/Pro crossover — the M/L ladder this file used to pin is gone,
// L is off sale), and a 320 per-plan ACCORDION beside the unchanged ≥768
// table. What was missing before still applies here: nothing renders these
// pieces except a real render — `pricing-rail.test.ts` and
// `pricing-crossover.test.ts` prove the DATA is correct, but only this file
// proves the PAGE actually paints it.
//
// Rendered through react-dom/server — vitest runs `environment: "node"` and
// this workspace has no jsdom (same pattern as upgrade-page.test.tsx). The
// dictionary and every pure pricing module are REAL, because the assertions
// are about the figures and copy a buyer actually reads.
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
import { PRICING_RAIL_SPORTS, pricingRailKey, PRICING_RAIL_FOOTER_KEY } from "@/lib/pricing-rail";
import { PRICING_PLAN_KEYS } from "@/lib/pricing-matrix";
import enMarketing from "@/dictionaries/en/marketing.json";
import esMarketing from "@/dictionaries/es/marketing.json";
import frMarketing from "@/dictionaries/fr/marketing.json";
import nlMarketing from "@/dictionaries/nl/marketing.json";
import {
  FREE_CARD_BULLETS,
  PASS_CARD_BULLETS,
  PRO_CARD_BULLETS,
  cardBullets,
} from "@/lib/pricing-cards";
import type { MatrixData } from "@/lib/pricing-matrix";
import type { Dict } from "@/lib/i18n-constants";

/** Each rung's usd price AS THE PAGE RENDERS IT — derived, never typed. W3
 *  repriced both rungs onto charm points ("$15" became "$11.99"), and a typed
 *  string would have turned a legitimate reprice into a page regression. */
const M_PRICE = formatMinor(passPrice("usd", "event_pass"), "usd");
const L_PRICE = formatMinor(passPrice("usd", "event_pass_l"), "usd");
/** The entry rung's ladder label, from the dictionary the page renders it from. */
const M_RUNG = (enMarketing as Record<string, string>)[PASS_RUNG_MARKETING_KEY.event_pass];

/**
 * The keys this page's Event Pass ticket renders from: the two V341 makes the
 * rungs differ on, plus `registration.fee_percent` for the fee pills and the
 * pass/Pro comparator.
 *
 * NOT a mirror of the live matrix. `event_pass_l`'s entrant cap is
 * deliberately NULL here because the unlimited branch is what the asymmetry
 * test below exists to pin (even though L itself never reaches the stub); the
 * live figures are pinned against `plan_entitlements` by
 * lib/__tests__/pricing-cards.test.ts and lib/__tests__/pricing-crossover.test.ts,
 * which is where that job belongs.
 */
const LIVE = [
  { plan_key: "community", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 4 },
  { plan_key: "event_pass", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 10 },
  { plan_key: "event_pass_l", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 20 },
  { plan_key: "community", feature_key: "entrants.per_division.max", bool_value: null, int_value: 64 },
  { plan_key: "event_pass", feature_key: "entrants.per_division.max", bool_value: null, int_value: 128 },
  // null int_value on a PRESENT row = unlimited.
  { plan_key: "event_pass_l", feature_key: "entrants.per_division.max", bool_value: null, int_value: null },
  // The fee ladder the fee pills and the comparator are derived from (V398:
  // community 5, pass 4, pro 2).
  { plan_key: "community", feature_key: "registration.fee_percent", bool_value: null, int_value: 5 },
  { plan_key: "event_pass", feature_key: "registration.fee_percent", bool_value: null, int_value: 4 },
  { plan_key: "event_pass_l", feature_key: "registration.fee_percent", bool_value: null, int_value: 4 },
  { plan_key: "pro", feature_key: "registration.fee_percent", bool_value: null, int_value: 2 },
  { plan_key: "community", feature_key: "competitions.max_active", bool_value: null, int_value: 3 },
  { plan_key: "pro", feature_key: "competitions.max_active", bool_value: null, int_value: null },
  { plan_key: "pro", feature_key: "divisions.per_competition.max", bool_value: null, int_value: 20 },
  { plan_key: "pro", feature_key: "entrants.per_division.max", bool_value: null, int_value: 256 },
];

const render = async (rows = LIVE, lang = "en") => {
  h.rows = rows;
  const markup = renderToStaticMarkup(await PricingPage({ params: Promise.resolve({ lang }) }));
  // Tailwind ships class names like `text-2xl` and `basis-full` in every class
  // list, so copy guards must run on stripped text, not on HTML.
  const text = markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  // React escapes `& < > " '` in a text node, so a bullet reading "Online
  // registration & entry fees" arrives as "&amp;" and every `toContain` on a
  // dictionary value silently misses. `plain` is the text a reader sees.
  const plain = text
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return { markup, text, plain };
};

describe("/pricing's box office board (R14)", () => {
  /** Every sport the rail actually rendered, read out of the markup rather
   *  than inferred — `data-rail-sport` is written per slot by the page. */
  const railed = (markup: string): string[] =>
    [...markup.matchAll(/data-rail-sport="([^"]+)"/g)].map((m) => m[1]!);

  it("enumerates the rail and finds exactly the mockup's ten sports, in order", async () => {
    const { markup, plain } = await render();
    expect(markup, "the rail itself").toContain("data-pricing-rail");
    // ENUMERATED, not asserted one at a time — a slot lost from the rail
    // fails this the same way an extra one does.
    expect(railed(markup)).toEqual([...PRICING_RAIL_SPORTS]);
    for (const sport of PRICING_RAIL_SPORTS) {
      expect(plain, sport).toContain((enMarketing as Record<string, string>)[pricingRailKey(sport)]);
    }
  });

  it("prints the foot line, and never a raw generic label", async () => {
    const { markup, plain } = await render();
    expect(markup).toContain("data-rail-footer");
    expect(plain).toContain((enMarketing as Record<string, string>)[PRICING_RAIL_FOOTER_KEY]);
    // `generic` is the board's foot line, never an eleventh rail SLOT.
    expect(railed(markup)).not.toContain("generic");
  });
});

describe("/pricing's Event Pass ticket sells only the rung that is on sale", () => {
  it("the stub quotes the M rung's price, caps and one-time credits — never L's", async () => {
    const { markup, text } = await render();
    expect(markup, "the stub itself").toContain("data-pass-stub");
    expect(markup, 'the M slot').toContain('data-pass-stub-slot="m"');
    expect(text).toContain(M_PRICE);
    expect(text).toContain("10 divisions × 128 entrants");
    expect(text).toContain("+25 AI credits");

    // The negative half, about the CAPS and the PRICE, not just the ladder
    // markup — L's price alone could plausibly appear in unrelated FAQ prose.
    for (const hidden of HIDDEN_PASS_KEYS) expect(markup, hidden).not.toContain(`"${hidden}"`);
    expect(text, "L's caps are its whole sales pitch").not.toContain("20 divisions × unlimited");
    expect(text, "the L price point").not.toContain(L_PRICE);
    // Anti-vacuity: L's price is a real, DIFFERENT number, and something
    // really is hidden.
    expect(M_PRICE).not.toBe(L_PRICE);
    expect(HIDDEN_PASS_KEYS.length).toBeGreaterThan(0);
  });

  it("honours a null ENTRANT cap as unlimited rather than dropping the caps line", async () => {
    const { text } = await render(
      LIVE.map((r) =>
        r.plan_key === "event_pass" && r.feature_key === "entrants.per_division.max"
          ? { ...r, int_value: null }
          : r,
      ),
    );
    expect(text).toContain("10 divisions × unlimited entrants");
  });

  it("drops the caps line rather than quoting a figure it does not have, but keeps selling", async () => {
    // A DB unreachable at build makes `loadMatrix` fail soft to `{}`; a
    // missing row read through `?? null` would advertise an UNLIMITED pass
    // for M's price. Absence must suppress, never embellish — and it must
    // not take the whole offer down with it.
    const { text } = await render(LIVE.filter((r) => r.plan_key !== "event_pass"));
    expect(text, "no cap may be quoted from a row that isn't there").not.toContain(
      "divisions × 128 entrants",
    );
    expect(text, "the stub still sells").toContain(M_PRICE);
  });

  it("keeps selling when the HIDDEN rung's matrix rows are missing entirely", async () => {
    // The dormancy half: the stub must not consult a rung it does not
    // render. It reads `event_pass` alone, so `event_pass_l`'s rows going
    // missing must be invisible to it.
    const { text } = await render(LIVE.filter((r) => r.plan_key !== "event_pass_l"));
    expect(text).toContain(M_PRICE);
    expect(text).toContain("10 divisions × 128 entrants");
  });

  it("never claims a multiplier anywhere on the page", async () => {
    // 2.03x in USD but 1.96x in GBP and 2.25x in INR, so any "double" framing
    // is false in some currency (ledger copy constraint, T2). "double
    // elimination" is a BRACKET FORMAT and reaches this page in the matrix row
    // label (`pricing.matrix.formats.double_elim`), so it is stripped first.
    // W3 fix round 1 removed it from the pass bullet (`pricing.pass.f3`)
    // separately — that example oversold community's own double-elim grant —
    // but the strip stays regardless of which surface names the format.
    const { text } = await render();
    const priceCopy = text.toLowerCase().replace(/double elim(ination)?/g, "");
    expect(priceCopy).not.toMatch(/\bdouble\b|\btwice\b|\b2×\b|\b2x\b/);
    expect(priceCopy).not.toContain("best value");
  });
});

// ── W3 fix round 2, item 1: the crossover paragraph is unreadable at 84px
// (two-up phone columns). Owner-specified shape: the stub's two slots stack
// as full-width row cards on every width the stub grid ever renders at
// (phone AND the narrow desktop stub column) — never a 2-up phone
// comparison. `crossoverStubLine` is truthy against the default LIVE fixture
// (community/pro fee rows both present), so this render exercises the
// two-slot case the bug lived in.
describe("/pricing's Event Pass stub: row cards, not a 2-up phone comparison (W3 fix round 2)", () => {
  it("never renders the stub's two slots as a 2-up grid — always one column", async () => {
    const { markup } = await render();
    expect(markup, "the crossover slot must actually be present for this case").toContain(
      "data-pass-crossover",
    );
    const gridClass = /class="([^"]*)"[^>]*>\s*<div[^>]*data-pass-stub-slot="m"/.exec(
      markup,
    )?.[1];
    expect(gridClass, "the stub's grid wrapper").toBeTruthy();
    expect(gridClass).toContain("grid-cols-1");
    expect(gridClass).not.toContain("grid-cols-2");
  });

  it("keeps the price and its per-event suffix on one line", async () => {
    const { markup } = await render();
    const priceMatch = /<p[^>]*data-pass-price[^>]*>([\s\S]*?)<\/p>/.exec(markup);
    expect(priceMatch, "the price line").not.toBeNull();
    expect(priceMatch![0]).toMatch(/class="[^"]*\bwhitespace-nowrap\b[^"]*"/);
    // Positive pair: the price AND its suffix are both actually inside it.
    const inner = priceMatch![1]!.replace(/<[^>]*>/g, "").trim();
    expect(inner).toContain(M_PRICE);
    expect(inner).toContain((enMarketing as Record<string, string>)["pricing.pass.per"]!.trim());
  });
});

// ── W3 fix round 2, item 2: "Size M" / "Event Pass M" name a distinction no
// customer can act on with one sellable rung. Both surfaces read "Event
// Pass" now. UPDATE 2026-09-05: the crossover sentence's own naming of the
// rung (M_RUNG) is NOT untouched by this any more — the owner extended the
// same "no rung suffix on a selling surface" ruling to it, so it dropped
// `{rung}` too; see "names no rung — one is on sale…" further down this file
// and `pricing-crossover.test.ts`'s `rungFaults`.
describe("/pricing names the pass plainly — no rung suffix on a selling surface (W3 fix round 2)", () => {
  it("the ticket stub's price card reads \"Event Pass\", never \"Size M\"", async () => {
    const { markup } = await render();
    const label = /data-pass-stub-slot="m"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/
      .exec(markup)?.[1]
      ?.replace(/<[^>]*>/g, "")
      .trim();
    expect(label).toBe("Event Pass");
  });

  it("the comparison table's Event Pass column header carries no rung suffix", async () => {
    const label = (enMarketing as Record<string, string>)["pricing.table.pass"]!;
    expect(label).toBe("Event Pass");
  });

  it("never prints \"Size\" or a bare rung letter beside the pass name anywhere on the page", async () => {
    const { plain } = await render();
    expect(plain).not.toMatch(/\bSize M\b/);
    expect(plain).not.toContain("Event Pass M");
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
        `${label} L`,
      );
    }
    // `enterprise` is the Contact-us strip, never a priced column (design §4).
    expect(rendered).not.toContain("enterprise");
  });

  it("is a REAL table at desktop — visible with no click needed", async () => {
    const { markup } = await render();
    // `hidden md:block`: at ≥768 the table renders unconditionally.
    expect(markup).toMatch(/class="[^"]*\bhidden\b[^"]*\bmd:block\b[^"]*"[^>]*tabindex="0"/);
  });
});

// ── The pass/Pro comparator, now inside the stub ─────────────────────────────
//
// The page priced both offers and left the buyer to work out which one costs
// them less, which reads as "the pass is cheaper" — true only below one
// threshold, and the threshold was stated nowhere. Naming it is the whole
// point, so the assertions below are about the FIGURE, not about the element
// being present. R14 moves this into the ticket's stub as its second slot;
// the underlying sentence and its correctness guards (pricing-crossover.test.ts)
// are unchanged.
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

  it("quotes the crossing and both fee rates, none of them typed, inside the stub", async () => {
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

  // PREMISE CHANGED 2026-09-05 (W3 fix round 2, item 2, the same ruling that
  // strips "Size M"/"Event Pass M" from the stub and the table header above):
  // with one rung sellable, naming it here printed a letter that exists
  // nowhere else on the page — the confusion dropping the suffix was for. So
  // this test now pins the OPPOSITE of what it pinned before: the line must
  // NOT name a rung. It is still true of exactly one rung, just identified by
  // its price alone rather than by letter — which is why M_PRICE (not
  // L_PRICE) staying in the line, unconditionally, is still asserted below.
  // `pricing-crossover.test.ts`'s `rungFaults`/`rungNamingRequired` pin the
  // same rule against SELLABLE_PASS_KEYS at the dictionary-string level; this
  // is the same rule read off the RENDERED page instead.
  it("names no rung — one is on sale, so the price alone is what the crossing is true of", async () => {
    const { markup } = await render();
    const para = /<p[^>]*data-pass-crossover[^>]*>([\s\S]*?)<\/p>/.exec(markup);
    expect(para, "the comparator paragraph").not.toBeNull();
    const line = para![1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

    // This test's premise: exactly one rung sellable. If that ever changes,
    // this test (and the dictionary copy it reads) needs to change with it —
    // see `rungFaults` in pricing-crossover.test.ts, which is what re-requires
    // the rung letter the moment SELLABLE_PASS_KEYS grows past one.
    expect(SELLABLE_PASS_KEYS.length, "this test's premise — see the comment above").toBe(1);

    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(line, `the line must not name the ${M_RUNG} rung`).not.toMatch(
      new RegExp(`\\b${escape(M_RUNG)}\\b`),
    );
    expect(M_PRICE).not.toBe(L_PRICE);
    expect(line, "the price still identifies which offer this is about").toContain(M_PRICE);
    expect(line, "the line must not read as a claim about L").not.toContain(L_PRICE);
    expect(line).toContain(CROSSING);
    expect(line).toContain("2% platform fee against 4%");
  });

  it("says nothing at all when a fee rate could not be read", async () => {
    const { markup, text } = await render(
      LIVE.filter((r) => !(r.feature_key === "registration.fee_percent" && r.plan_key === "pro")),
    );
    expect(markup).not.toContain("data-pass-crossover");
    expect(text).not.toContain(CROSSING);
    // …and the stub still sells. Suppressing the comparator must not take the
    // Event Pass offer down with it.
    expect(text).toContain(M_PRICE);
  });
});

// ── The fee pills (R14): Free and Pro both print `{fee}% platform fee`,
// derived from the SAME `registration.fee_percent` row the comparison table
// renders from — never a typed number.
describe("/pricing's fee pills are derived, never typed", () => {
  /** The pill's OWN text, scoped by its data attribute — never a bare
   *  substring search on the whole page. The crossover sentence in the stub
   *  also contains the phrase "…% platform fee against …%", so a page-wide
   *  `toContain("2% platform fee")` is satisfied by that sentence even when
   *  Pro's own pill is broken — measured: a mutant that hardcoded both pills
   *  to 5% survived a page-wide substring check and only reddened once the
   *  assertion was scoped to the pill element itself. */
  const pillText = (markup: string, attr: string): string | null => {
    const re = new RegExp(`${attr}[^>]*>([\\s\\S]*?)<\\/p>`);
    const m = re.exec(markup);
    return m ? m[1]!.trim() : null;
  };

  it("prints Free's and Pro's own rate, and they differ", async () => {
    const { markup } = await render();
    expect(pillText(markup, "data-community-fee-pill")).toBe("5% platform fee");
    expect(pillText(markup, "data-pro-fee-pill")).toBe("2% platform fee");
  });

  it("suppresses a pill it cannot read rather than printing a hole", async () => {
    const { markup } = await render(LIVE.filter((r) => r.feature_key !== "registration.fee_percent"));
    expect(pillText(markup, "data-community-fee-pill")).toBeNull();
    expect(pillText(markup, "data-pro-fee-pill")).toBeNull();
  });
});

// ── W3 fix round 2, item 6: a dedicated Platform fee FAQ entry, naming
// per-plan rates DERIVED from the live matrix (never typed) and stating the
// fee is ADDITIVE to Stripe's own processing — something no copy on the page
// stated before this. Names no specific Stripe rate (that is Stripe's to
// change).
describe("/pricing's FAQ has a dedicated Platform fee entry (W3 fix round 2, item 6)", () => {
  it("names all three live rates and states the fee is additive to Stripe's own", async () => {
    const { plain } = await render();
    const question = (enMarketing as Record<string, string>)["pricing.faq.platformFee.q"]!;
    const answerTemplate = (enMarketing as Record<string, string>)["pricing.faq.platformFee.a"]!;
    expect(plain, "the question").toContain(question);
    // The three LIVE rates (5/4/2, per the LIVE fixture) actually reach the
    // page, in the order the answer names them — not typed here.
    expect(plain).toMatch(/5%.{0,60}4%.{0,60}2%/s);
    // Additive, not instead of — the finding item 6 exists for.
    expect(answerTemplate.toLowerCase()).toMatch(/on top of|in addition|additive/);
    // Never pins a Stripe rate — checked on the SOURCE dictionary string, not
    // the rendered page, so a coincidental nearby "%" from an unrelated FAQ
    // answer can't produce a false pass or a false fail. The only digits this
    // answer may contain are the three {…Fee} placeholders, which are OUR
    // rates; Stripe's own rate is never named.
    expect(answerTemplate.replace(/\{[a-zA-Z]+\}/g, ""), "a bare digit outside a placeholder").not.toMatch(
      /\d/,
    );
  });

  it("suppresses the entry rather than printing an unfilled placeholder if a rate cannot be read", async () => {
    const { plain } = await render(LIVE.filter((r) => r.feature_key !== "registration.fee_percent"));
    expect(plain, "an unfilled placeholder must never reach the page").not.toMatch(/\{[a-z]\w*Fee\}/i);
    expect(plain).not.toContain(
      (enMarketing as Record<string, string>)["pricing.faq.platformFee.q"],
    );
  });

  it("is registered in FAQ_KEYS — a dictionary key nothing renders is an inert seam", async () => {
    const { plain } = await render();
    // A run of the answer's own static prose that carries no placeholder —
    // proves the KEY is wired into FAQ_KEYS and actually rendered, not just
    // present in the dictionary.
    expect(plain).toContain("Connect your club's Stripe account and payouts go straight to the club");
  });
});

// ── The comparison surfaces: a table at ≥768, a per-plan accordion at 320 —
// same `sections` data, two renderers.
describe("/pricing's table and its 320 accordion agree, row for row", () => {
  it("the accordion lists exactly PRICING_PLAN_KEYS, and no more", async () => {
    const { markup } = await render();
    expect(markup).toContain("data-pricing-accordion");
    const plans = [...markup.matchAll(/data-pricing-accordion-plan="([^"]+)"/g)].map((m) => m[1]!);
    expect(plans).toEqual([...PRICING_PLAN_KEYS]);
  });

  it("every accordion row's value matches the table's for the same plan", async () => {
    const { markup } = await render();
    // Pull the table's own cell text, keyed by (row label key, plan), out of
    // the SAME markup the accordion renders from — one source of truth
    // compared against itself through two renderers.
    const tableMatch = /<table[^>]*data-pricing-matrix[^>]*>([\s\S]*?)<\/table>/.exec(markup);
    expect(tableMatch, "the table itself").not.toBeNull();
    const tableHtml = tableMatch![1]!;
    const headerCols = [...tableHtml.matchAll(/data-pricing-column="([^"]+)"/g)].map((m) => m[1]!);

    const rowRe = /<tr>\s*<td class="font-medium[^"]*">([\s\S]*?)<\/tr>/g;
    const tableCells: Record<string, string[]> = {};
    for (const rowHtml of tableHtml.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
        m[1]!.replace(/<[^>]*>/g, "").trim(),
      );
      if (cells.length !== headerCols.length + 1) continue; // section header row
      tableCells[cells[0]!] = cells.slice(1);
    }
    void rowRe; // documents the row shape considered above; matched via match() instead

    // Now walk the accordion and compare each `dd` to the table's cell for
    // the same plan and the same row label text.
    for (const plan of headerCols) {
      const detailsRe = new RegExp(
        `data-pricing-accordion-plan="${plan}"[\\s\\S]*?<\\/details>`,
      );
      const detailsHtml = detailsRe.exec(markup)?.[0];
      expect(detailsHtml, `${plan} accordion section`).toBeTruthy();
      const rows = [...(detailsHtml ?? "").matchAll(
        /data-pricing-accordion-row="[^"]*"[^>]*>\s*<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g,
      )];
      expect(rows.length, `${plan} has rows`).toBeGreaterThan(0);
      const planIndex = headerCols.indexOf(plan);
      let checked = 0;
      for (const [, dtHtml, ddHtml] of rows) {
        const label = dtHtml!.replace(/<[^>]*>/g, "").trim();
        const value = ddHtml!.replace(/<[^>]*>/g, "").trim();
        const tableRow = tableCells[label];
        if (!tableRow) continue; // a row whose label carries a note line — matched loosely below
        expect(value, `${plan}/${label}`).toBe(tableRow[planIndex]);
        checked += 1;
      }
      expect(checked, `${plan}: nothing was actually compared`).toBeGreaterThan(3);
    }
  });

  // W3 fix round 2 (items 3 + 6): a row's noteKey used to render only in the
  // ≥768 table — the 320 accordion built its own `<dt>` with no note at all,
  // which would have made the fees row's additive-fee disclosure and the
  // enterprise-only routing note both INVISIBLE on a phone. `rule 22`-shaped:
  // a class-scan cannot see this, only a render can.
  it("renders a row's note on the phone accordion too, not just the ≥768 table", async () => {
    const { markup } = await render();
    // React escapes `'` as `&#x27;` in raw markup — unescape before comparing,
    // same as `render()`'s own `plain` field does for the whole page.
    const unescape = (s: string) => s.replace(/&#x27;|&#39;/g, "'");
    const noteText = (enMarketing as Record<string, string>)["pricing.matrix.fees.note"]!;

    const tableMatch = /<table[^>]*data-pricing-matrix[^>]*>([\s\S]*?)<\/table>/.exec(markup);
    expect(tableMatch, "the table itself").not.toBeNull();
    expect(unescape(tableMatch![1]!), "the table already carries the note").toContain(noteText);

    const accordionMatch = /data-pricing-accordion[\s\S]*$/.exec(markup)?.[0];
    expect(accordionMatch, "the accordion itself").toBeTruthy();
    expect(unescape(accordionMatch!), "the accordion must carry the same note").toContain(
      noteText,
    );
  });
});

/**
 * ── THE SECONDARY, WEAKER GUARD: what a Spanish visitor actually reads ──────
 *
 * The PRIMARY guard for the plan-card bullets is the source scan in
 * `lib/__tests__/pricing-card-i18n.test.ts`. It has to be, because this test
 * CANNOT tell a dictionary lookup from a hardcoded Spanish literal — both
 * render the same bytes, so it would go on passing the moment someone pastes
 * translated prose back into the component and lets the other three locales
 * rot. Say that out loud rather than leave the next reader to assume the
 * rendered assertion is the one doing the work.
 *
 * What it DOES add, and the source scan cannot: it drives the real page
 * component, in the real locale, through `getDictionary`'s en-merge — so a key
 * that exists in `en` and is simply MISSING from `es` (parity-green if the key
 * were absent everywhere, and invisible to a per-file read) shows up here as
 * English on a Spanish page. That is the leak this catches. This also covers
 * every key R14 added (the rail, the stub, the fee pills, the enterprise
 * heading) — nothing about that set is special-cased below.
 */
describe("the plan cards speak the visitor's language", () => {
  const DICTS: Record<string, Dict> = {
    en: enMarketing as Dict,
    es: esMarketing as Dict,
    fr: frMarketing as Dict,
    nl: nlMarketing as Dict,
  };

  /** The fixture rows, in the shape `cardBullets` reads — so the expectations
   *  are what the page's own resolver produces for that locale, never a table
   *  of sentences typed into this file. */
  const FIXTURE: MatrixData = LIVE.reduce<MatrixData>((acc, r) => {
    (acc[r.feature_key] ??= {})[r.plan_key] = {
      bool_value: r.bool_value,
      int_value: r.int_value,
    };
    return acc;
  }, {});

  const bulletsIn = (locale: string): string[] => [
    ...cardBullets(DICTS[locale]!, FREE_CARD_BULLETS, FIXTURE),
    ...cardBullets(DICTS[locale]!, PASS_CARD_BULLETS, FIXTURE),
    ...cardBullets(DICTS[locale]!, PRO_CARD_BULLETS, FIXTURE),
  ];

  /**
   * ── THE RAW KEY, WHICH ONLY A RENDER CAN SEE ─────────────────────────────
   *
   * `t(dict, key)` RETURNS THE KEY when the key is missing. Not an empty
   * string, not a throw — the dotted key itself, painted onto the page. This
   * is the guard that would have caught the `pricing.pro.name` defect
   * (see git history), and it is what proves every R14 key actually resolves
   * in all four locales — including a locale simply missing a NEW key, which
   * `i18n:check`'s parity comparison would also catch, but a render is the
   * more direct proof for a page test.
   */
  it.each(["en", "es", "fr", "nl"])(
    "paints no raw dictionary key on /%s/pricing",
    async (locale) => {
      const { plain } = await render(LIVE, locale);
      const raw = [...plain.matchAll(/\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){2,}\b/g)]
        .map((m) => m[0])
        .filter((tok) => !/^\d|\.(?:tsx?|json|com|club|io)$/.test(tok));
      expect(raw, `${locale}: a dictionary lookup missed and rendered its key`).toEqual([]);
    },
  );

  it("would have caught the key that shipped", () => {
    const probe = /\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){2,}\b/g;
    for (const key of ["pricing.pro.name", "pricing.faq.annual.a", "billing.intervalChange.toYearly"]) {
      expect([...`Pro ${key} $10.75`.matchAll(probe)].map((m) => m[0]), key).toEqual([key]);
    }
    for (const notAKey of ["$128.99 billed yearly", "more than two months free", "2%", "u.s. only"]) {
      expect([...notAKey.matchAll(probe)].map((m) => m[0]), notAKey).toEqual([]);
    }
  });

  it("renders every card bullet in English on /en/pricing", async () => {
    const { plain } = await render(LIVE, "en");
    const expected = bulletsIn("en");
    expect(expected.length, "no bullets to check — the cards render nothing").toBe(22);
    for (const bullet of expected) expect(plain, bullet).toContain(bullet);
  });

  it.each(["es", "fr", "nl"])(
    "renders every card bullet in %s, and no English one, on that locale's page",
    async (locale) => {
      const { plain } = await render(LIVE, locale);
      const translated = bulletsIn(locale);
      const english = bulletsIn("en");
      expect(translated.length).toBe(22);

      for (const bullet of translated) {
        expect(plain, `${locale}: missing "${bullet}"`).toContain(bullet);
      }
      for (const bullet of english) {
        expect(plain, `${locale}: English leaked — "${bullet}"`).not.toContain(bullet);
      }
      expect(translated.filter((b) => english.includes(b)), `${locale} is not translated`).toEqual([]);
    },
  );

  it("still quotes the live caps and fee rates in a non-English locale", async () => {
    const { plain } = await render(LIVE, "es");
    for (const figure of ["3", "4", "64", "5%", "10", "128", "256", "20", "2%"]) {
      expect(plain, `es: the ${figure} figure`).toContain(figure);
    }
    expect(plain, "an unfilled placeholder reached the page").not.toMatch(/\{[a-z]\w*\}/i);
  });

  it("renders the rail's sport names translated, on a non-English locale", async () => {
    const { plain } = await render(LIVE, "fr");
    for (const sport of PRICING_RAIL_SPORTS) {
      const frValue = (frMarketing as Record<string, string>)[pricingRailKey(sport)]!;
      expect(plain, `fr: ${sport}`).toContain(frValue);
    }
  });
});

// ── Retired copy must never resurface — the two things W2/W3 explicitly
// removed from every purchasable surface.
describe("retired plans and rungs never reach the rendered page", () => {
  it("says nothing about Pro Plus, on any locale", async () => {
    for (const locale of ["en", "es", "fr", "nl"]) {
      const { plain } = await render(LIVE, locale);
      expect(plain.toLowerCase(), locale).not.toContain("pro plus");
    }
  });

  it("never renders the retired event_pass_l key as a rendered attribute", async () => {
    const { markup } = await render();
    expect(markup).not.toMatch(/data-pricing-column="event_pass_l"/);
    expect(markup).not.toMatch(/data-pricing-accordion-plan="event_pass_l"/);
    expect(markup).not.toMatch(/data-pass-stub-slot="event_pass_l"/);
  });
});
