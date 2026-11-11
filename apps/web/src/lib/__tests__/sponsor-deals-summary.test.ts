// Sponsor deals, Task 16 - `dealSummary`: the one sentence the Add deal sheet shows above its button, "what will happen" in the
// club's own words. Every expected sentence below is typed from the mockup of record (screen 3, the three summaries verbatim) or
// from the rules (spec §5.2 the go-live table, §8a one live deal per sponsor, and server/sponsors/deal-apply.ts steps 3-4:
// a live deal keeps its sponsor on the pages, a deal waiting to go live hides a sponsor with none) - never read back from
// lib/sponsor-deals.ts.
//
// The function returns KEYS + PARAMS (the i18n house rule bans dynamic `msg()` keys and a client-safe lib has no dictionary), so
// each test renders the parts through the real English dictionary exactly as the sheet does, and the key sweep proves every key
// it can answer exists in all four locales with the placeholders its params fill.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero checked is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   S1  hidden clause   `currentlyShown &&` dropped                       -> "the hidden-until clause" pair
//   S2  hidden clause   `!i.otherLive` dropped                             -> "a live deal keeps the sponsor on the pages"
//   S3  queue           the `otherLive` branch dropped                     -> the 16-combination sweep
//   S4  whole org       `scopeName !== null` ignored                       -> "the whole organisation"
//   S5  guard           the complimentary + on_payment refusal dropped     -> "refuses the combination the server refuses"
//   S6  promotion       `!i.promotesWaiting` dropped from the hidden clause -> "ending the current deal now promotes"
import { describe, expect, it } from "vitest";
import {
  DealRuleError,
  GO_LIVE_RULES,
  PAYMENT_METHODS,
  dealSummary,
  goLiveRulesFor,
  type GoLiveRule,
  type PaymentMethod,
  type SummaryParts,
} from "../sponsor-deals";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const LOCALES: Record<string, Dict> = { en: uiEn as unknown as Dict, es: uiEs as unknown as Dict, fr: uiFr as unknown as Dict, nl: uiNl as unknown as Dict };
const en = LOCALES.en!;

/** The parts as the sheet renders them: each through the dictionary, joined by a space. */
const say = (parts: SummaryParts, dict: Dict = en): string => parts.map((p) => t(dict, p.key, p.params)).join(" ");

const BASE = {
  sponsorName: "Ridge Gold Physiotherapy",
  packageName: "Gold Season",
  scopeName: "Season 2026/27" as string | null,
  method: "online" as PaymentMethod,
  rule: "on_payment" as GoLiveRule,
  amount: "£600",
  email: "accounts@ridgegoldphysio.co.uk" as string | null,
  otherLive: false,
  currentlyShown: false,
};

describe("the three summaries on the mockup, word for word (screen 3)", () => {
  it("paid plan: online invoice, live when paid", () => {
    expect(say(dealSummary(BASE))).toBe(
      "Ridge Gold Physiotherapy gets Gold Season for Season 2026/27. We email an invoice for £600 to accounts@ridgegoldphysio.co.uk. They go live when it is paid.",
    );
  });

  it("community: offline, after I approve", () => {
    expect(
      say(dealSummary({ ...BASE, sponsorName: "Northbank Print", packageName: "Silver Season", method: "offline", rule: "on_approval", amount: "£300", email: null })),
    ).toBe("Northbank Print gets Silver Season for Season 2026/27 at £300, paid by bank transfer or cash. Once you mark it paid, it waits for your approval.");
  });

  it("complimentary, straight away", () => {
    expect(
      say(dealSummary({ ...BASE, sponsorName: "Tidewell Garage", packageName: "Partner", scopeName: "Winter League 2026/27", method: "complimentary", rule: "immediate", amount: "£120", email: null })),
    ).toBe("Tidewell Garage gets Partner for Winter League 2026/27, free. They go live as soon as you save.");
  });
});

// The eight valid (method, rule) pairs, typed from spec §5.2: "When paid" is not offered for a complimentary deal, so there are
// 3 + 3 + 2 of them, and each is a different promise. Fixed inputs so the sentences can be typed out whole.
const WHOLE = {
  sponsorName: "Northbank Print", packageName: "Silver Season", scopeName: "Season 2026/27", amount: "£300", email: "pay@northbank.example",
  currentlyShown: false,
} as const;
const HEAD = {
  online: "Northbank Print gets Silver Season for Season 2026/27. We email an invoice for £300 to pay@northbank.example.",
  offline: "Northbank Print gets Silver Season for Season 2026/27 at £300, paid by bank transfer or cash.",
  complimentary: "Northbank Print gets Silver Season for Season 2026/27, free.",
} as const;
const EXPECTED: Record<string, string> = {
  "online/on_payment": `${HEAD.online} They go live when it is paid.`,
  "online/immediate": `${HEAD.online} They go live straight away, before payment arrives.`,
  "online/on_approval": `${HEAD.online} Once it is paid, it waits for your approval.`,
  "offline/on_payment": `${HEAD.offline} They go live when you mark it paid.`,
  "offline/immediate": `${HEAD.offline} They go live straight away, before payment arrives.`,
  "offline/on_approval": `${HEAD.offline} Once you mark it paid, it waits for your approval.`,
  "complimentary/immediate": `${HEAD.complimentary} They go live as soon as you save.`,
  "complimentary/on_approval": `${HEAD.complimentary} It waits for your approval.`,
};
const QUEUED = "Northbank Print is already live under another deal, so this one waits for it to end first.";

describe("every valid method x rule x other-live combination says its own thing (the sweep)", () => {
  it("the 16 combinations (counted), against sentences typed from the rules", () => {
    let checked = 0;
    for (const method of PAYMENT_METHODS) {
      for (const rule of goLiveRulesFor(method)) {
        for (const otherLive of [false, true]) {
          const typed = EXPECTED[`${method}/${rule}`];
          expect(typed, `premise: a typed sentence for ${method}/${rule}`).toBeDefined();
          // Queued behind a live deal (§8a): "goes live straight away" would be false, so an immediate deal drops that promise and
          // says it waits; the others keep the condition they wait on and add the wait.
          const expected = !otherLive ? typed! : rule === "immediate" ? `${typed!.slice(0, typed!.lastIndexOf(" They go live"))} ${QUEUED}` : `${typed!} ${QUEUED}`;
          expect(say(dealSummary({ ...WHOLE, method, rule, otherLive })), `${method}/${rule}/otherLive=${otherLive}`).toBe(expected);
          checked++;
        }
      }
    }
    expect(checked, "8 valid pairs x 2").toBe(16);
    expect(Object.keys(EXPECTED).length, "the typed table covers exactly the valid pairs").toBe(8);
  });

  it("refuses the combination the server refuses: a complimentary deal cannot go live on payment (422 on_payment_needs_payment)", () => {
    expect(goLiveRulesFor("complimentary"), "premise: the sheet never offers it").not.toContain("on_payment");
    expect(() => dealSummary({ ...WHOLE, method: "complimentary", rule: "on_payment", otherLive: false })).toThrow(DealRuleError);
    expect(GO_LIVE_RULES.length, "premise: the rule list is the three the brief names").toBe(3);
  });

  it("an online deal with no billing email yet still reads: it names the amount and leaves the address out", () => {
    expect(say(dealSummary({ ...WHOLE, method: "online", rule: "on_payment", email: null, otherLive: false }))).toBe(
      "Northbank Print gets Silver Season for Season 2026/27. We email an invoice for £300. They go live when it is paid.",
    );
  });

  it("the whole organisation (no scope) says so, on every method", () => {
    const heads: Record<string, string> = {
      online: "Northbank Print gets Silver Season for the whole organisation. We email an invoice for £300 to pay@northbank.example.",
      offline: "Northbank Print gets Silver Season for the whole organisation at £300, paid by bank transfer or cash.",
      complimentary: "Northbank Print gets Silver Season for the whole organisation, free.",
    };
    let checked = 0;
    for (const method of PAYMENT_METHODS) {
      const first = say(dealSummary({ ...WHOLE, scopeName: null, method, rule: "immediate", otherLive: false }));
      expect(first.startsWith(heads[method]!), method).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("the hidden-until clause (spec §8a, deal-apply.ts step 4)", () => {
  const HIDDEN = "Northbank Print is hidden from your pages until then.";
  const base = { ...WHOLE, method: "offline", rule: "on_payment", otherLive: false } as const;

  it("a sponsor on the pages today, whose new deal does not go live now, is told it comes off until then", () => {
    for (const rule of ["on_payment", "on_approval"] as const) {
      expect(say(dealSummary({ ...base, rule, currentlyShown: true })), rule).toMatch(new RegExp(`${HIDDEN.replace(/[.]/g, "\\.")}$`));
    }
  });

  it("the positive pair: nothing to hide when it goes live now, when the sponsor is not on the pages anyway", () => {
    expect(say(dealSummary({ ...base, rule: "immediate", currentlyShown: true })), "goes live straight away").not.toContain("hidden");
    expect(say(dealSummary({ ...base, currentlyShown: false })), "already hidden").not.toContain("hidden");
    expect(say(dealSummary({ ...base, method: "complimentary", rule: "immediate", currentlyShown: true })), "complimentary, straight away").not.toContain("hidden");
  });

  it("a live deal keeps the sponsor on the pages, so a deal queued behind it hides nothing", () => {
    // deal-apply.ts step 3: a live deal sets the sponsor active whatever else is queued. `otherLive` is the EFFECTIVE flag - false once
    // "End the current deal now" is ticked, and then the sponsor IS hidden until the new deal goes live.
    for (const rule of GO_LIVE_RULES) {
      expect(say(dealSummary({ ...base, rule, otherLive: true, currentlyShown: true })), `${rule} behind a live deal`).not.toContain("hidden");
    }
    expect(say(dealSummary({ ...base, rule: "on_payment", otherLive: false, currentlyShown: true })), "the same deal, current one ended").toContain("hidden");
  });
});

describe("ending the current deal now promotes a deal already waiting behind it, so the sponsor stays on the pages (deal-apply.ts step 2)", () => {
  const HIDDEN = "Northbank Print is hidden from your pages until then.";
  const base = { ...WHOLE, method: "offline", rule: "on_payment", otherLive: false, currentlyShown: true } as const;

  it("with promotesWaiting, no rule says hidden; without it the same deal does (the differential, 2 rules x 2 methods counted)", () => {
    let checked = 0;
    for (const method of ["online", "offline"] as const) {
      for (const rule of ["on_payment", "on_approval"] as const) {
        const input = { ...base, method, rule };
        expect(say(dealSummary({ ...input, promotesWaiting: true })), `${method}/${rule} promoted`).not.toContain("hidden");
        expect(say(dealSummary({ ...input, promotesWaiting: false })), `${method}/${rule} not promoted`).toContain(HIDDEN);
        expect(say(dealSummary(input)), `${method}/${rule} flag absent reads as not promoted`).toContain(HIDDEN);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("it changes nothing else in the sentence: the head and the go-live clause are the same with or without it", () => {
    const withIt = say(dealSummary({ ...base, promotesWaiting: true }));
    const without = say(dealSummary({ ...base, promotesWaiting: false }));
    expect(without.startsWith(withIt), "the hidden clause is the only difference").toBe(true);
    expect(without.slice(withIt.length).trim()).toBe(HIDDEN);
  });
});

describe("every key the summary can answer exists in all four locales, with the placeholders its params fill (counted)", () => {
  it("sweeps every combination x scope x email x shown, and every locale", () => {
    const seen = new Map<string, Set<string>>();
    let combos = 0;
    for (const method of PAYMENT_METHODS) {
      for (const rule of goLiveRulesFor(method)) {
        for (const otherLive of [false, true]) {
          for (const scopeName of ["Spring Cup", null]) {
            for (const email of ["a@b.example", null]) {
              for (const currentlyShown of [false, true]) {
                combos++;
                for (const part of dealSummary({ ...WHOLE, method, rule, otherLive, scopeName, email, currentlyShown })) {
                  const names = seen.get(part.key) ?? new Set<string>();
                  for (const k of Object.keys(part.params)) names.add(k);
                  seen.set(part.key, names);
                }
              }
            }
          }
        }
      }
    }
    expect(combos, "8 pairs x 2 x 2 x 2 x 2").toBe(128);
    expect(seen.size, "the distinct keys the summary can answer").toBeGreaterThanOrEqual(12);
    let checked = 0;
    for (const [key, params] of seen) {
      for (const [locale, dict] of Object.entries(LOCALES)) {
        const text = dict[key];
        expect(typeof text, `${locale} ${key}`).toBe("string");
        const placeholders = new Set([...(text as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
        // Every placeholder is filled by a param (never a literal "{name}" on screen) ...
        for (const p of placeholders) expect(params.has(p), `${locale} ${key}: {${p}} has no param`).toBe(true);
        // ... and every param is used by the English sentence, so a locale cannot silently drop what the others say.
        if (locale === "en") for (const p of params) expect(placeholders.has(p), `en ${key}: param ${p} is unused`).toBe(true);
        checked++;
      }
    }
    expect(checked, "keys x 4 locales").toBe(seen.size * 4);
  });
});
