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
  // W2: the CARD BULLETS interpolate their figures from this same matrix, so
  // the rows they read joined the fixture. `competitions.max_active` is NULL on
  // pro on purpose — that is the "Unlimited competitions" branch, and a row
  // that is merely ABSENT would drop the bullet instead of rendering the word.
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
 * English on a Spanish page. That is the leak this catches.
 *
 * Scoped to the CARD BULLETS. `ProPriceCard`'s own chrome ("Annual billing",
 * "Billed monthly · switch to yearly any time", the "/month" suffix and the
 * emerald "save 30%") was hardcoded English in every locale when this comment
 * was first written; it was fixed on 2026-09-05, and the guard that holds it is
 * the SOURCE SCAN, not this file. What this file adds for it is the one thing a
 * source scan cannot do at all — see the raw-key rule below.
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
   * string, not a throw — the dotted key itself, painted onto the page.
   *
   * This rule exists because it happened, in the commit that localised the Pro
   * card. The page asked for `pricing.pro.name`, which reads like the sibling
   * of `pricing.community.name` and `pricing.pass.name` and does not exist (the
   * Pro column's label has only ever lived on `pricing.table.pro`). So the card
   * painted the literal string "pricing.pro.name" as its tier eyebrow, in all
   * four locales, past 175 green tests — including the source scan, which saw a
   * `t()` call and was satisfied, and `i18n:check`, which compares locales to
   * each other and cannot know what the code asks for.
   *
   * It was found by opening /fr/pricing. This is the assertion that means the
   * next one is found by CI instead: a source scan proves the copy came from a
   * dictionary, and only a render proves the dictionary answered.
   */
  it.each(["en", "es", "fr", "nl"])(
    "paints no raw dictionary key on /%s/pricing",
    async (locale) => {
      const { plain } = await render(LIVE, locale);
      const raw = [...plain.matchAll(/\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){2,}\b/g)]
        .map((m) => m[0])
        // A version-shaped or file-shaped token is not a key. Nothing on this
        // page has one today; the exclusion keeps the rule affordable rather
        // than tuned down later by someone it inconveniences.
        .filter((tok) => !/^\d|\.(?:tsx?|json|com|club|io)$/.test(tok));
      expect(raw, `${locale}: a dictionary lookup missed and rendered its key`).toEqual([]);
    },
  );

  // ANTI-VACUITY: the matcher above must actually recognise a key when one is
  // on the page, or "no raw keys" is a sentence about a regex that matches
  // nothing. Both real shapes — the one that shipped, and a deeper one.
  it("would have caught the key that shipped", () => {
    const probe = /\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){2,}\b/g;
    for (const key of ["pricing.pro.name", "pricing.faq.annual.a", "billing.intervalChange.toYearly"]) {
      expect([...`Pro ${key} $10.75`.matchAll(probe)].map((m) => m[0]), key).toEqual([key]);
    }
    // …and it must not fire on the prices, glyphs and sentences that legitimately
    // share the page, or the rule is unaffordable.
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
      // The leak, stated as the ABSENCE of the English the page used to ship.
      // Every one of these is a full bullet, so it cannot collide with a
      // matrix row label or an FAQ clause by accident.
      for (const bullet of english) {
        expect(plain, `${locale}: English leaked — "${bullet}"`).not.toContain(bullet);
      }
      // Anti-vacuity: the two sets really are different, so "no English" is not
      // satisfied by the locale happening to equal en.
      expect(translated.filter((b) => english.includes(b)), `${locale} is not translated`).toEqual([]);
    },
  );

  it("still quotes the live caps and fee rates in a non-English locale", async () => {
    // The FIGURES are locale-free data and must survive translation — a
    // translator dropping "{entrants}" produces a grammatical Spanish sentence
    // that no longer names the cap, and only the numbers can witness it.
    const { plain } = await render(LIVE, "es");
    for (const figure of ["3", "4", "64", "5%", "10", "128", "256", "20", "2%"]) {
      expect(plain, `es: the ${figure} figure`).toContain(figure);
    }
    // …and nothing shipped a raw placeholder.
    expect(plain, "an unfilled placeholder reached the page").not.toMatch(/\{[a-z]\w*\}/i);
  });
});
