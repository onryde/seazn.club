// The pass/Pro crossover, derived — never typed.
//
// The figure this computes is the one thing /pricing never said: the pass is
// cheaper up front and dearer per pound of entry fees, so for a one-month
// competition the two offers cross exactly once. The page read as "the pass is
// cheaper", full stop, which pushes volume at the one-time sku.
//
// Both halves are pinned here: the ARITHMETIC against hand-worked cases, and
// the LIVE figure against the catalogue and `plan_entitlements` — so a reprice
// or a fee re-cut moves the test with the product instead of leaving it
// asserting yesterday's number.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { feeCrossoverMinor, readableMinor } from "../pricing-crossover";
import {
  PASS_KEYS,
  SELLABLE_PASS_KEYS,
  SUPPORTED_CURRENCIES,
  formatMinor,
  passPrice,
  proPrice,
} from "../currency";
import { lowestPricedRung, rungNamingRequired } from "../pass-ladder";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("feeCrossoverMinor — where a month of Pro overtakes the pass", () => {
  it("solves the crossing, not an approximation of it", () => {
    // $11.99 pass at 4% vs $14.99/mo Pro at 2%: the $3.00 sticker gap is
    // recovered by the 2-point fee gap at $150 of entry fees.
    const at = feeCrossoverMinor({
      passMinor: 1199,
      proMonthlyMinor: 1499,
      passFeePercent: 4,
      proFeePercent: 2,
    });
    expect(at).toBe(15000);
    // …and it really is a crossing: check both totals AT the point, and that
    // the ordering flips either side of it. A formula that merely returns a
    // plausible number passes an equality check on itself; this does not.
    const cost = (fees: number, sticker: number, fee: number) => sticker + (fees * fee) / 100;
    expect(cost(15000, 1199, 4)).toBe(cost(15000, 1499, 2));
    expect(cost(14000, 1199, 4)).toBeLessThan(cost(14000, 1499, 2));
    expect(cost(16000, 1199, 4)).toBeGreaterThan(cost(16000, 1499, 2));
  });

  it("moves with the fee ladder rather than staying put", () => {
    // Halving the fee GAP doubles the volume it takes to recover the sticker
    // gap — the property a hardcoded threshold cannot have.
    expect(
      feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 3, proFeePercent: 2 }),
    ).toBe(30000);
    // …and widening the sticker gap moves it the other way.
    expect(
      feeCrossoverMinor({ passMinor: 999, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: 2 }),
    ).toBe(25000);
  });

  it("says nothing when the two offers never cross", () => {
    // Pro cheaper up front: it already wins everywhere, so there is no
    // threshold — and the line must vanish rather than reverse its meaning.
    expect(
      feeCrossoverMinor({ passMinor: 1999, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: 2 }),
    ).toBeNull();
    // Equal stickers: same thing, from the other side.
    expect(
      feeCrossoverMinor({ passMinor: 1499, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: 2 }),
    ).toBeNull();
    // Same fee on both: the pass is simply cheaper, for ever. (Also the
    // division by zero this guard stands in front of.)
    expect(
      feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 2, proFeePercent: 2 }),
    ).toBeNull();
    // Pass fee LOWER than Pro's: it dominates on both axes.
    expect(
      feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 1, proFeePercent: 2 }),
    ).toBeNull();
  });

  it("says nothing when a rate could not be read", () => {
    // A missing `plan_entitlements` row must not be rendered as a rate. Same
    // rule lib/pass-comparison.ts applies to this exact column.
    for (const missing of [null, undefined]) {
      expect(
        feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: missing, proFeePercent: 2 }),
      ).toBeNull();
      expect(
        feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: missing }),
      ).toBeNull();
    }
  });
});

describe("readableMinor — a threshold a person can hold in their head", () => {
  it("keeps two significant figures of the major unit", () => {
    expect(readableMinor(15000)).toBe(15000); // $150
    expect(readableMinor(10000)).toBe(10000); // £100
    expect(readableMinor(500000)).toBe(500000); // ₹5,000
    expect(readableMinor(15037)).toBe(15000); // not $150.37
    expect(readableMinor(123456)).toBe(120000); // $1,200, not $1,234.56
  });

  it("never rounds a small figure away to nothing", () => {
    expect(readableMinor(742)).toBe(700); // $7
    expect(readableMinor(149)).toBe(100); // $1, not $0
  });

  it("returns 0 for a figure there is nothing to render", () => {
    expect(readableMinor(0)).toBe(0);
    expect(readableMinor(-5000)).toBe(0);
  });
});


// ── THE ASSUMPTION UNDER THE LINE ───────────────────────────────────────────
//
// `feeCrossoverMinor` compares a ONE-TIME pass against ONE MONTH of Pro. That
// is stated in the module header and in this suite's own title, and it was
// stated NOWHERE the buyer could read it: /pricing rendered the answer and not
// the question, so for a season the sentence recommended the wrong offer.
//
// The arithmetic below is the evidence. It is deliberately built from the same
// function the page calls — the M-month crossing is `feeCrossoverMinor` with M
// months of Pro on the other side, so nothing here re-implements the formula it
// is checking.
describe("the crossing is a ONE-MONTH crossing, and the copy has to say so", () => {
  // The live usd ladder, spelled out once: $11.99 pass at 4%, $14.99/mo Pro at
  // 2%. Pinned against the catalogue in the DB-backed block below, so a reprice
  // moves both together.
  const PASS = 1199;
  const PRO_MONTH = 1499;
  const fees = (total: number, sticker: number, rate: number) => sticker + (total * rate) / 100;

  /** The crossing over `months` of competition, in TOTAL entry fees. */
  const crossingOver = (months: number): number | null =>
    feeCrossoverMinor({
      passMinor: PASS,
      proMonthlyMinor: PRO_MONTH * months,
      passFeePercent: 4,
      proFeePercent: 2,
    });

  it("recommends the WRONG offer for a season, if read without the assumption", async () => {
    // The worked case that opened this finding: a three-month event taking $300
    // a month in entry fees is well above the $150 the line quotes, so the line
    // as it stood said "Pro". It is not: the pass is bought once and Pro is
    // billed three times.
    const monthlyFees = 30000;
    const months = 3;
    const passTotal = fees(monthlyFees * months, PASS, 4);
    const proTotal = fees(monthlyFees * months, PRO_MONTH * months, 2);
    expect(passTotal).toBe(4799); // $47.99
    expect(proTotal).toBe(6297); // $62.97
    expect(passTotal).toBeLessThan(proTotal);
    // …and $300/mo is comfortably past the threshold the sentence quotes, which
    // is exactly why the unqualified sentence was false.
    expect(monthlyFees).toBeGreaterThan(readableMinor(crossingOver(1)!));
  });

  it("puts the real three-month crossing far above the one-month one", () => {
    // Same shape, from the other side: at three months the offers actually
    // cross at ~$550 a month, not $150.
    const oneMonth = crossingOver(1)!;
    const threeMonths = crossingOver(3)!;
    expect(oneMonth).toBe(15000); // $150 of fees, over one month
    expect(threeMonths / 3).toBeCloseTo(54966.67, 1); // ~$550 a month, over three
    expect(threeMonths / 3).toBeGreaterThan(oneMonth * 3);
  });

  it("moves MONOTONICALLY with the length of the competition", () => {
    // The property the copy leans on when it says a longer competition puts the
    // threshold higher. It holds for every ladder that renders a line at all:
    // F(M) = k*P/M - k*R with k = 100/(proFee - passFee) < 0, so dF/dM > 0
    // whenever the pass is the cheaper sticker. A one-off pair of numbers would
    // not show that; the sweep does.
    const perMonth = [1, 2, 3, 6, 12].map((m) => crossingOver(m)! / m);
    for (let i = 1; i < perMonth.length; i += 1) {
      expect(perMonth[i], `${i + 1} months must clear the previous rung`).toBeGreaterThan(
        perMonth[i - 1]!,
      );
    }
  });
});

// ── THE LINE ITSELF, IN ALL FOUR LOCALES ────────────────────────────────────
//
// The fix for the above is copy, not arithmetic — the page has no duration
// input and inventing one would be a different product. So the sentence names
// the competition length it assumes, and this is the guard that it does.
//
// It is NOT a verbatim pin (`lib/__tests__/_approved-dictionary-copy.ts` already
// holds one). It asks a structural question: does the sentence tie a COMPETITION
// to a MONTH, in the same breath? The four strings as they shipped tie the
// MONTH to the entry fees and never mention the competition at all, which is
// precisely the omission — so they are kept below as a retired registry and
// asserted to FAIL this scan. Without that half the scan would be a rule nobody
// has ever seen red.
describe("the /pricing crossover line states its own assumption, in every locale", () => {
  const HERE = join(fileURLToPath(import.meta.url), "..");
  const KEY = "pricing.pass.crossover";

  /** The noun pair that has to appear together, per locale. */
  const VOCABULARY = {
    en: { subject: "competition", period: "month" },
    es: { subject: "competición", period: "mes" },
    fr: { subject: "compétition", period: "mois" },
    nl: { subject: "competitie", period: "maand" },
  } as const;
  type Locale = keyof typeof VOCABULARY;
  const LOCALES = Object.keys(VOCABULARY) as Locale[];

  /** Every index of `needle` in `hay`, case-insensitively. */
  const indices = (hay: string, needle: string): number[] => {
    const out: number[] = [];
    const h = hay.toLowerCase();
    const n = needle.toLowerCase();
    for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + 1)) out.push(i);
    return out;
  };

  /**
   * A locale FAULTS unless its subject and period nouns sit inside one phrase.
   * 40 characters is a clause, not a sentence: it is short enough that
   * "…entry fees a month, this is the cheaper option" (the retired wording,
   * whose only `competition` is absent entirely) cannot satisfy it by accident,
   * and long enough to survive a reword of the phrase between them.
   */
  const NEAR = 40;
  const durationFaults = (values: Record<Locale, string>): string[] =>
    LOCALES.flatMap((locale) => {
      const { subject, period } = VOCABULARY[locale];
      const subjects = indices(values[locale], subject);
      const periods = indices(values[locale], period);
      if (subjects.length === 0) return [`${locale}: never mentions the ${subject}`];
      if (periods.length === 0) return [`${locale}: never mentions a ${period}`];
      const closest = Math.min(
        ...subjects.flatMap((a) => periods.map((b) => Math.abs(a - b))),
      );
      return closest <= NEAR
        ? []
        : [`${locale}: ${subject} and ${period} are ${closest} chars apart — not one claim`];
    });

  /**
   * Whether the crossing must literally name the rung it is true of —
   * `rungNamingRequired`, IMPORTED from lib/pass-ladder.ts rather than
   * redeclared here.
   *
   * It began life as a local copy in this file, and then W3 needed the same
   * question answered by the in-app buy page (`pass-upgrade.tsx`'s button and
   * size stamp, `upgrade/page.tsx`'s comparison header) — which is exactly how
   * two surfaces end up disagreeing about one ruling. Promoted to the module
   * that owns the ladder; this file keeps its wording, not its own arithmetic.
   *
   * Its own truth table is pinned in `pass-rung-naming.test.ts` against
   * LITERAL counts. That separation matters: every assertion below derives its
   * expectation from this same predicate, so a mutation to the predicate moves
   * the expectation with it and none of them could witness it.
   */

  /**
   * A locale FAULTS if it drops `{pass}` — the crossing is always true of
   * ONE specific rung's price, sellable count or not — and, separately,
   * FAULTS if its `{rung}` token disagrees with `rungNamingRequired`:
   * missing when required, present when it must not be. `{rung}` alone
   * would not be enough even when required — a token can be interpolated
   * with anything — but the price living beside it in `{pass}` is checked
   * unconditionally, which is how the ladder directly above the line
   * identifies each rung too.
   */
  const rungFaults = (values: Record<Locale, string>, sellableCount: number): string[] => {
    const mustName = rungNamingRequired(sellableCount);
    return LOCALES.flatMap((locale) => {
      const value = values[locale];
      const hasPass = value.includes("{pass}");
      const hasRung = value.includes("{rung}");
      if (!hasPass) return [`${locale}: the claim names no pass price — missing {pass}`];
      if (mustName && !hasRung) {
        return [`${locale}: ${sellableCount} rungs on sale and the claim names no rung — missing {rung}`];
      }
      if (!mustName && hasRung) {
        return [
          `${locale}: ${sellableCount} rung(s) on sale and the claim names one anyway — {rung} must not appear`,
        ];
      }
      return [];
    });
  };

  const live = (): Record<Locale, string> =>
    Object.fromEntries(
      LOCALES.map((locale) => {
        const file = join(HERE, "..", "..", "dictionaries", locale, "marketing.json");
        const dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
        const value = dict[KEY];
        expect(value, `${locale}/marketing.json has no ${KEY}`).toBeTypeOf("string");
        return [locale, value!];
      }),
    ) as Record<Locale, string>;

  it("names the competition length the crossing assumes", () => {
    expect(durationFaults(live())).toEqual([]);
  });

  it("would have caught the wording that shipped without it", () => {
    // The retired strings, verbatim. Four identical omissions, one scan: this
    // is the mutation for a guard that cannot otherwise be seen failing.
    const RETIRED: Record<Locale, string> = {
      en: "Up to about {amount} of entry fees a month, this is the cheaper option; above that it is Pro at {pro}/mo — a {proFee}% platform fee against {passFee}%.",
      es: "Hasta unos {amount} de cuotas de inscripción al mes, esta es la opción más barata; por encima de eso lo es Pro a {pro}/mes: una comisión de plataforma del {proFee}% frente al {passFee}%.",
      fr: "Jusqu’à environ {amount} de frais d’inscription par mois, c’est l’option la moins chère ; au-delà, c’est Pro à {pro}/mois — {proFee} % de frais de plateforme contre {passFee} %.",
      nl: "Tot ongeveer {amount} aan inschrijfgelden per maand is dit de goedkoopste keuze; daarboven is dat Pro voor {pro}/mnd — {proFee}% platformkosten tegen {passFee}%.",
    };
    expect(durationFaults(RETIRED)).toHaveLength(LOCALES.length);
    // …and no live string may simply BE one of them.
    const now = live();
    for (const locale of LOCALES) expect(now[locale]).not.toBe(RETIRED[locale]);
  });

  it("still carries every figure the line is built from", () => {
    // The rewrite must not drop a placeholder: `t()` leaves an unknown token
    // alone, so a lost `{passFee}` would render as literal braces on the card
    // rather than failing anything. `{rung}` is NOT unconditional — see
    // "names the rung the crossing is true of" below, which pins it against
    // SELLABLE_PASS_KEYS instead of requiring it here regardless of count.
    for (const [locale, value] of Object.entries(live())) {
      for (const token of ["{amount}", "{pro}", "{proFee}", "{passFee}", "{pass}"]) {
        expect(value, `${locale} lost ${token}`).toContain(token);
      }
    }
    // …and when more than one rung IS on sale, `{rung}` becomes one of those
    // unconditional figures too — folded in here rather than a fifth
    // standalone assertion, since it is the same "nothing may be dropped"
    // property, just gated on the live sellable count.
    if (rungNamingRequired(SELLABLE_PASS_KEYS.length)) {
      for (const [locale, value] of Object.entries(live())) {
        expect(value, `${locale} lost {rung}`).toContain("{rung}");
      }
    }
  });

  // ── …and WHICH OFFER it is true of ────────────────────────────────────────
  //
  // The second half of the same class of defect as the duration clause above.
  // The crossing is solved for ONE rung. When the card sells TWO, reading it
  // without a rung says "this is the cheaper option" of the whole Event Pass
  // column — and that was false of L, which never crosses Pro at any volume
  // (4499 up front against a month of Pro at 1499, and the dearer rate per
  // pound as well, so `feeCrossoverMinor` returns null for it). Naming the
  // rung is what made the sentence true of the thing it sat beside.
  //
  // PREMISE CHANGED 2026-09-05 (entitlements v18 W3): the L rung came off
  // sale, so the card sells only ONE rung now, and the owner separately
  // approved dropping the rung suffix from every customer-facing selling
  // surface — the ticket stub and the matrix column header both now read
  // plain "Event Pass". Naming a rung letter here that appears nowhere else
  // on the page is the confusion that decision removed, so the live wording
  // dropped `{rung}` and kept `{pass}` (the price alone still identifies
  // which offer the line is about, unambiguously, with one rung on sale).
  // The reasoning above stays live rather than deleted: it is exactly what
  // fires again the day a second rung returns to sale — `rungFaults` is
  // gated on SELLABLE_PASS_KEYS.length rather than "always require {rung}"
  // or "never require {rung}" specifically so that day flips it back on its
  // own. Do not restore `{rung}` to the live strings while one rung sells.
  it("names the rung the crossing is true of", () => {
    expect(rungFaults(live(), SELLABLE_PASS_KEYS.length)).toEqual([]);
  });

  it("would have caught the wording that shipped without it", () => {
    // The strings as they shipped, verbatim, from the wave where the card
    // sold two rungs — every figure live, every one of them silent about
    // which rung. Same shape as the retired registry above: a scan nobody
    // has ever seen fail is not a scan. Checked against a synthetic
    // two-rung count rather than the live (now one-rung) SELLABLE_PASS_KEYS,
    // since that is the state this wording shipped in and the state the
    // rule must still catch it in.
    const RETIRED: Record<Locale, string> = {
      en: "For a competition running about a month, up to about {amount} of entry fees this is the cheaper option; above that it is Pro at {pro}/mo — a {proFee}% platform fee against {passFee}%. The pass is one-time, so a longer competition puts that threshold higher.",
      es: "Para una competición de aproximadamente un mes, hasta unos {amount} de cuotas de inscripción esta es la opción más barata; por encima de eso lo es Pro a {pro}/mes: una comisión de plataforma del {proFee}% frente al {passFee}%. El pase es de pago único, así que una competición más larga sitúa ese umbral más alto.",
      fr: "Pour une compétition d’environ un mois, jusqu’à environ {amount} de frais d’inscription, c’est l’option la moins chère ; au-delà, c’est Pro à {pro}/mois — {proFee} % de frais de plateforme contre {passFee} %. Le pass est ponctuel : une compétition plus longue place ce seuil plus haut.",
      nl: "Voor een competitie van ongeveer een maand is dit tot ongeveer {amount} aan inschrijfgelden de goedkoopste keuze; daarboven is dat Pro voor {pro}/mnd — {proFee}% platformkosten tegen {passFee}%. De pass is eenmalig, dus bij een langere competitie ligt die grens hoger.",
    };
    expect(rungFaults(RETIRED, 2)).toHaveLength(LOCALES.length);
    const now = live();
    for (const locale of LOCALES) expect(now[locale]).not.toBe(RETIRED[locale]);
  });

  // ── Both directions, and the empty case, on the derived rule itself ───────
  //
  // The two tests above only ever exercise `rungFaults` at the sellable count
  // this repo happens to be in right now (1) or the count the retired wording
  // shipped in (2). Neither, alone, proves the rule actually FLIPS — a rule
  // hardcoded to "never require {rung}" would pass the first and, coupled
  // with a RETIRED string that is ALSO missing {pass}, would still pass the
  // second by accident (see the {pass} branch in `rungFaults`). These pin the
  // rule directly, both directions, plus the empty-set case named in the
  // brief: a rule whose every other case is "does this contain X" answers no
  // to everything when the set is empty and lands on a default, which is
  // exactly the vacuous shape that has shipped bugs in this repo before. Zero
  // sellable rungs is not a state SELLABLE_PASS_KEYS should ever actually be
  // in, but the FUNCTION must not treat it as "nothing to check" either.
  const NAMED: Record<Locale, string> = {
    en: "The {rung} pass ({pass}) crosses Pro at {amount}, {proFee}% against {passFee}%.",
    es: "El pase {rung} ({pass}) cruza con Pro en {amount}, {proFee}% frente a {passFee}%.",
    fr: "Le pass {rung} ({pass}) croise Pro à {amount}, {proFee}% contre {passFee}%.",
    nl: "De {rung}-pass ({pass}) kruist Pro bij {amount}, {proFee}% tegen {passFee}%.",
  };
  const UNNAMED: Record<Locale, string> = {
    en: "The pass ({pass}) crosses Pro at {amount}, {proFee}% against {passFee}%.",
    es: "El pase ({pass}) cruza con Pro en {amount}, {proFee}% frente a {passFee}%.",
    fr: "Le pass ({pass}) croise Pro à {amount}, {proFee}% contre {passFee}%.",
    nl: "De pass ({pass}) kruist Pro bij {amount}, {proFee}% tegen {passFee}%.",
  };
  const NO_PASS: Record<Locale, string> = {
    en: "This crosses Pro at {amount}, {proFee}% against {passFee}%.",
    es: "Esto cruza con Pro en {amount}, {proFee}% frente a {passFee}%.",
    fr: "Cela croise Pro à {amount}, {proFee}% contre {passFee}%.",
    nl: "Dit kruist Pro bij {amount}, {proFee}% tegen {passFee}%.",
  };

  it("requires the rung letter once a second rung is on sale, and forbids it with one", () => {
    // Two sellable rungs: unnamed wording faults, named wording does not.
    expect(rungFaults(UNNAMED, 2)).toHaveLength(LOCALES.length);
    expect(rungFaults(NAMED, 2)).toEqual([]);
    // One sellable rung (today's live state): the reverse.
    expect(rungFaults(NAMED, 1)).toHaveLength(LOCALES.length);
    expect(rungFaults(UNNAMED, 1)).toEqual([]);
  });

  it("is not vacuous against an empty rung set — {pass} is still required", () => {
    // Zero sellable rungs must not read as "nothing to check": the naming
    // requirement follows `rungNamingRequired`'s `> 1` (false at 0, same as
    // at 1 — nothing to disambiguate FROM either way), but the {pass} check
    // is unconditional, so a line naming no pass at all still faults.
    expect(rungNamingRequired(0)).toBe(false);
    expect(rungFaults(NO_PASS, 0)).toHaveLength(LOCALES.length);
    expect(rungFaults(UNNAMED, 0)).toEqual([]);
    expect(rungFaults(NAMED, 0)).toHaveLength(LOCALES.length);
  });
});

// The claim the scoping exists for, measured against the live catalogue rather
// than asserted: the rung the sentence does NOT name has no crossing to name.
describe("the L rung is why the line has to say which rung it means", () => {
  it("never crosses Pro in any currency we sell in", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      // Same fee rate on both rungs (V398), so the ONLY thing separating them
      // is the sticker price — which is what makes L dominated on cost.
      expect(
        feeCrossoverMinor({
          passMinor: passPrice(currency, "event_pass_l"),
          proMonthlyMinor: proPrice("monthly", currency),
          passFeePercent: 4,
          proFeePercent: 2,
        }),
        `${currency}: L crosses Pro, so the scoping premise has changed`,
      ).toBeNull();
    }
  });

  it("and the rung the line IS about is the entry rung, in every currency", () => {
    // What `page.tsx` derives the sentence's subject from. If a reprice ever
    // makes L the cheapest rung, the line follows it rather than going stale.
    for (const currency of SUPPORTED_CURRENCIES) {
      const chosen = lowestPricedRung(
        PASS_KEYS.map((key) => ({ key, amountMinor: passPrice(currency, key) })),
      );
      expect(chosen.key, `${currency}`).toBe("event_pass");
      expect(
        feeCrossoverMinor({
          passMinor: chosen.amountMinor,
          proMonthlyMinor: proPrice("monthly", currency),
          passFeePercent: 4,
          proFeePercent: 2,
        }),
        `${currency}: the rung the line names must actually have a crossing`,
      ).not.toBeNull();
    }
  });
});

// ── The live figure ─────────────────────────────────────────────────────────
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("the crossing the page will actually print", () => {
  const feeFor = async (plan: string): Promise<number | null> => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = ${plan} and feature_key = 'registration.fee_percent'`;
    expect(row, `plan_entitlements has no ${plan}/registration.fee_percent row`).toBeDefined();
    return row!.int_value;
  };

  it("is a real crossing in EVERY currency we sell in", async () => {
    const passFeePercent = await feeFor("event_pass");
    const proFeePercent = await feeFor("pro");
    // The premise of the line: the pass costs more per pound of entry fees.
    // If a re-cut ever ends that, the copy is wrong, not merely stale.
    expect(passFeePercent!).toBeGreaterThan(proFeePercent!);

    for (const currency of SUPPORTED_CURRENCIES) {
      const at = feeCrossoverMinor({
        passMinor: passPrice(currency, "event_pass"),
        proMonthlyMinor: proPrice("monthly", currency),
        passFeePercent,
        proFeePercent,
      });
      expect(at, `${currency} has no crossing`).not.toBeNull();
      expect(readableMinor(at!), `${currency} rounds away to nothing`).toBeGreaterThan(0);
    }
  });

  it("puts the usd crossing at $150 — derived from the catalogue and the matrix", async () => {
    const at = feeCrossoverMinor({
      passMinor: passPrice("usd", "event_pass"),
      proMonthlyMinor: proPrice("monthly", "usd"),
      passFeePercent: await feeFor("event_pass"),
      proFeePercent: await feeFor("pro"),
    });
    // Spelled out so a reprice that moves it is visible as a number, not just
    // as a green test. $11.99 pass / $14.99 Pro / 4% vs 2%.
    expect(formatMinor(readableMinor(at!), "usd")).toBe("$150");
  });
});
