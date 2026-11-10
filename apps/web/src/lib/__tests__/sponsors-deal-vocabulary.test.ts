// Sponsor deals: one word for the thing, in every locale. A sponsor's purchase is a DEAL (es "acuerdo", fr "accord", nl "deal"); the
// pre-deals "order" is gone from every screen string (spec §3 vocabulary; batch I brief: "no 'order' left in any screen string").
//
// The component tests each guard ONE screen's words in English (package-list, sponsor-sheet, sponsor-list, deal-page); this is the one
// sweep over every `sponsors.*` value in all four dictionaries, so a string added to any screen in any locale cannot bring "order" back.
// The forbidden words are the locales' own words for an order: en `order(s)`, es `pedido(s)`, fr `commande(s)`, nl `bestelling(en)` /
// `order`. (es `orden` and fr `ordre` also mean "sort order" and are left out: no `sponsors.*` value uses either today, and a guard
// that flags a legitimate "sort order" would be deleted rather than read.)
//
// Anti-vacuity: the sweep reports how many values it read per locale and in total; zero read fails, the four locales must hold the
// SAME keys, and each locale's own word for "deal" must appear (a sweep that read the wrong namespace would find no deals).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Locale = (typeof LOCALES)[number];

/** The locale's word for an order (the thing a deal replaced), as a pattern. */
const ORDER_WORD: Record<Locale, RegExp> = {
  en: /\borders?\b/i,
  es: /\bpedidos?\b/i,
  fr: /\bcommandes?\b/i,
  nl: /\b(?:bestellingen|bestelling|orders?)\b/i,
};
/** The locale's word for a deal, which the sponsors screens use throughout. */
const DEAL_WORD: Record<Locale, RegExp> = {
  en: /\bdeals?\b/i,
  es: /\bacuerdos?\b/i,
  fr: /\baccords?\b/i,
  nl: /\bdeals?\b/i,
};

const DICT_DIR = join(process.cwd(), "src", "dictionaries");

/** Every `sponsors.*` entry of every dictionary file of the locale (flat JSON per namespace). */
function sponsorsValues(locale: Locale): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of readdirSync(join(DICT_DIR, locale)).filter((f) => f.endsWith(".json"))) {
    const dict = JSON.parse(readFileSync(join(DICT_DIR, locale, file), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(dict)) {
      if (key.startsWith("sponsors.") && typeof value === "string") out[key] = value;
    }
  }
  return out;
}

/** The sweep itself, over a given set of values: the keys whose value uses the locale's word for an order. */
export function orderFaults(locale: Locale, values: Record<string, string>): string[] {
  return Object.entries(values)
    .filter(([, value]) => ORDER_WORD[locale].test(value))
    .map(([key]) => key);
}

describe("the order word's patterns find an order (the sweep's own detector)", () => {
  it("each locale's pattern catches its own order sentence and passes its own deal sentence (8 counted)", () => {
    const cases: [Locale, string, boolean][] = [
      ["en", "Your order is paid", true],
      ["en", "Your deal is paid", false],
      ["es", "Tu pedido está pagado", true],
      ["es", "Tu acuerdo está pagado", false],
      ["fr", "Votre commande est payée", true],
      ["fr", "Votre accord est payé", false],
      ["nl", "Je bestelling is betaald", true],
      ["nl", "Je deal is betaald", false],
    ];
    let checked = 0;
    for (const [locale, text, isOrder] of cases) {
      expect(orderFaults(locale, { k: text }), `${locale}: ${text}`).toEqual(isOrder ? ["k"] : []);
      checked++;
    }
    expect(checked).toBe(8);
  });
});

describe("no sponsors.* screen string in any locale says 'order'", () => {
  const read = Object.fromEntries(LOCALES.map((l) => [l, sponsorsValues(l)])) as Record<Locale, Record<string, string>>;

  it("reads the same sponsors.* keys in all four locales, and reports how many (zero fails)", () => {
    const counts = LOCALES.map((l) => `${l} ${Object.keys(read[l]).length}`);
    console.info(`sponsors vocabulary sweep: ${counts.join(", ")} sponsors.* values`);
    for (const l of LOCALES) expect(Object.keys(read[l]).length, `${l}: sponsors.* values read`).toBeGreaterThan(0);
    const keys = (l: Locale) => Object.keys(read[l]).sort();
    for (const l of LOCALES) expect(keys(l), `${l} has the keys en has`).toEqual(keys("en"));
  });

  it("every value of every locale, none of them an order (total counted)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      expect(orderFaults(l, read[l]), `${l}: strings that say order`).toEqual([]);
      checked += Object.keys(read[l]).length;
    }
    expect(checked, "values swept across the four locales").toBeGreaterThan(4 * 300);
  });

  it("each locale's own word for a deal is in use (the sweep read the sponsors screens, not an empty namespace)", () => {
    for (const l of LOCALES) {
      const using = Object.values(read[l]).filter((v) => DEAL_WORD[l].test(v)).length;
      expect(using, `${l}: values that say deal`).toBeGreaterThan(20);
    }
  });
});

// ---- what an Event Pass lifts, named truthfully ------------------------------------------------------------------------------------
// The pass lifts two entitlements on its own competition (lib/pass-comparison.ts: `sponsors.tiers`, `sponsors.monetize`): sponsor
// TIERS and ONLINE sponsor INVOICES. "Paid packages" was the pre-deals word for the second - a package is now a price list that every
// plan has (a Partner package is free of any plan), so copy that sells "paid packages" promises something no plan or pass gates.
// The truth is typed from those two entitlement names, never read from the copy.
describe("copy that says what the Event Pass lifts for sponsors: tiers and online invoices, and the pass covers only its own competition", () => {
  const UI: Record<Locale, Record<string, string>> = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<Locale, Record<string, string>>;
  /** The pre-deals phrase for the online-invoice entitlement, in each locale. */
  const PAID_PACKAGES: Record<Locale, RegExp> = {
    en: /paid packages/i,
    es: /paquetes de pago/i,
    fr: /offres payantes/i,
    nl: /betaalde pakketten/i,
  };
  const INVOICE: Record<Locale, RegExp> = { en: /invoices/i, es: /facturas/i, fr: /factures/i, nl: /facturen/i };
  const TIERS: Record<Locale, RegExp> = { en: /tiers/i, es: /niveles/i, fr: /niveaux/i, nl: /niveaus/i };
  const EVENT_PASS = /event pass/i;

  it("the pass-comparison row (upgrade.limit.sponsors) names tiers and online invoices in every locale, and no 'paid packages' (4 counted)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const row = UI[l]["upgrade.limit.sponsors"]!;
      expect(row, `${l}: ${row}`).not.toMatch(PAID_PACKAGES[l]);
      expect(row, `${l}: names the tiers`).toMatch(TIERS[l]);
      expect(row, `${l}: names the invoices`).toMatch(INVOICE[l]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the tier hints say a pass covers its own competition (the Event Pass is named), in every locale (8 counted)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      for (const key of ["sponsors.pkg.tiersHint", "sponsors.dealSheet.scopeTiersHint"]) {
        expect(UI[l][key], `${l} ${key}`).toMatch(EVENT_PASS);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("the help pages and the Stripe product descriptions that list what the pass carries do not sell 'paid packages' (4 files counted)", () => {
    const files = [
      join(process.cwd(), "content", "help", "billing", "plans.md"),
      join(process.cwd(), "content", "help", "billing", "event-pass.md"),
      join(process.cwd(), "src", "config", "stripe-plans.json"),
      join(process.cwd(), "src", "config", "tips.ts"),
    ];
    let checked = 0;
    for (const f of files) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/paid packages/i);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
