// Owner, 2026-11-11: "can we have some description or legend in package under the panel for explain the different tier usage?" - the
// "What each tier gets" legend under the Packages tab's price list (components/sponsors/tier-legend.tsx).
//
// Every claim the legend makes has to be true in the code, so the words are written from what the code does:
//   - Title: the hero, under the competition name (`SponsorsHeroTitle`, components/public-site/sponsors-board.tsx).
//   - Gold / Silver: a logo PANEL on the sponsor board, Gold's larger (`PANEL` there: text-xl and a 32px logo, against Silver's
//     text-sm and a 24px one).
//   - Partner: NOT a panel - the board lists partners by name in a "Partners" line (`tickerRows`), no logo.
//   - Stream turns: `SPONSOR_TIER_WEIGHTS` (lib/sponsor-tiers.ts), the planner's turns per rotation (`weightedCycle`).
// The turns are interpolated from that constant at render, never typed into the copy. The test below proves the binding with a
// differential: it swaps the constant for four DISTINCT weights (the real ones repeat: silver and partner are both 1, so a swapped
// pair would hide) and requires every row to follow.
//
// vitest is `environment: "node"`: the legend is a stateless leaf read with `renderToStaticMarkup`. The look at 320/768/1280, the
// page order and the overflow are the e2e's (`e2e/sponsors-hub.spec.ts`, `mobile.spec.ts`'s hub sweep, run by CI).
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   L1  order     draw the tiers lowest first                                           -> "highest tier first"
//   L2  weight    type a literal in place of `SPONSOR_TIER_WEIGHTS[tier]`                -> "every row's turns follow the constant"
//   L3  swap      read silver's turns from the partner's weight                          -> "every row's turns follow the constant"
//   L4  words     give gold the silver sentence                                           -> "each row has its own tier's words"
//   L5  plan      draw the plan line on an organisation-wide plan                        -> "an organisation-wide plan: no plan line"
//   L6  plan      drop the plan line on a plan without tiers                              -> "a plan without tiers: the legend and its plan line"
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const weights = vi.hoisted(() => ({ override: null as Record<string, number> | null }));
vi.mock("@/lib/sponsor-tiers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sponsor-tiers")>();
  return {
    ...actual,
    get SPONSOR_TIER_WEIGHTS() {
      return weights.override ?? actual.SPONSOR_TIER_WEIGHTS;
    },
  };
});

import { TierLegend } from "@/components/sponsors/tier-legend";
import { SPONSOR_TIER_WEIGHTS, SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);

/** The legend's markup text, tags out and entities decoded, whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const legend = (tiersOrgWide: boolean) => renderToStaticMarkup(<TierLegend tiersOrgWide={tiersOrgWide} />);
/** Each row's `data-tier`, its chip words, its sentence and its turns line, in document order. */
function rowsOf(html: string): { tier: string; chip: string; what: string; turns: string }[] {
  return [...html.matchAll(/<li\b[^>]*data-testid="tier-legend-row"[^>]*data-tier="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => {
    const inner = m[2] ?? "";
    const part = (id: string) => textOf(new RegExp(`<span\\b[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</span>`).exec(inner)?.[1] ?? "");
    return { tier: m[1] ?? "", chip: part("tier-legend-chip"), what: part("tier-legend-what"), turns: part("tier-legend-turns") };
  });
}

/** The brief's order and words, typed here (the owner's request and the board's own behaviour), not read back from the component. */
const ORDER = ["title", "gold", "silver", "partner"] as const;
const CHIP_WORDS: Record<SponsorTier, string> = { title: "Title", gold: "Gold", silver: "Silver", partner: "Partner" };
const WHAT_KEYS: Record<SponsorTier, MessageKey> = {
  title: "sponsors.pkg.legend.tier.title",
  gold: "sponsors.pkg.legend.tier.gold",
  silver: "sponsors.pkg.legend.tier.silver",
  partner: "sponsors.pkg.legend.tier.partner",
};
/** English plural of "turn", typed from the language, not from the dictionary under test. */
const turnsLine = (n: number) => `${n} ${n === 1 ? "turn" : "turns"} in the stream rotation`;

describe("the legend: What each tier gets (owner, 2026-11-11)", () => {
  it("is a titled section with one row per tier, highest first: Title, Gold, Silver, Partner (4 checked)", () => {
    const html = legend(true);
    const rows = rowsOf(html);
    expect(rows.map((r) => r.tier), "highest tier first").toEqual([...ORDER]);
    expect([...SPONSOR_TIERS], "premise: the rows are the declared tier list, in its rank order").toEqual([...ORDER]);
    expect(rows.map((r) => r.chip), "each row is headed by its tier's own name").toEqual(ORDER.map((tier) => CHIP_WORDS[tier]));
    expect(html).toMatch(/<section\b[^>]*data-testid="tier-legend"[^>]*aria-labelledby="tier-legend-heading"/);
    expect(textOf(/<h3\b[^>]*id="tier-legend-heading"[^>]*>([\s\S]*?)<\/h3>/.exec(html)?.[1] ?? "")).toBe("What each tier gets");
    expect(rows.length, "anti-vacuity: the legend drew its rows").toBe(4);
  });

  it("each row has its own tier's words, and the four sentences differ (a swapped pair would show)", () => {
    const rows = rowsOf(legend(true));
    for (const r of rows) expect(r.what, `${r.tier}: its sentence`).toBe(msg(WHAT_KEYS[r.tier as SponsorTier]));
    expect(new Set(rows.map((r) => r.what)).size, "four different sentences").toBe(4);
    // What the board really does, in the words the owner reads (typed from sponsors-board.tsx's behaviour):
    expect(rows[0]!.what, "Title: under the competition name").toMatch(/under the competition name/);
    expect(rows[1]!.what, "Gold: a large logo panel").toMatch(/large/);
    expect(rows[2]!.what, "Silver: a smaller panel").toMatch(/smaller/);
    expect(rows[3]!.what, "Partner is a name in the Partners line, NOT a panel").toMatch(/Partners line/);
    expect(rows[3]!.what, "...and says nothing of a panel or a logo").not.toMatch(/panel|logo/i);
  });

  it("every row's stream turns follow SPONSOR_TIER_WEIGHTS at render: the real constant, then four distinct stand-ins (4 + 4 checked)", () => {
    let checked = 0;
    weights.override = null;
    for (const r of rowsOf(legend(true))) {
      expect(r.turns, `${r.tier}: the declared weight`).toBe(turnsLine(SPONSOR_TIER_WEIGHTS[r.tier as SponsorTier]));
      checked++;
    }
    // The real weights repeat (silver and partner are both 1), so they cannot tell a swap from the truth. Distinct ones can, and one
    // of them is 1 so the singular is exercised too.
    weights.override = { title: 7, gold: 5, silver: 4, partner: 1 };
    try {
      const turned = rowsOf(legend(true));
      expect(turned.map((r) => r.turns), "the rows follow the constant, not typed numbers").toEqual([
        turnsLine(7),
        turnsLine(5),
        turnsLine(4),
        turnsLine(1),
      ]);
      expect(turned[3]!.turns, "one turn is singular").toBe("1 turn in the stream rotation");
      checked += turned.length;
    } finally {
      weights.override = null;
    }
    expect(checked).toBe(8);
  });

  it("a plan without organisation-wide tiers still sees the legend, with the plan line: higher tiers and one-competition packages need a paid plan or an Event Pass (the upsell)", () => {
    const html = legend(false);
    expect(rowsOf(html), "a plan without tiers: the legend and its plan line").toHaveLength(4);
    const plan = /<p\b[^>]*data-testid="tier-legend-plan"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1];
    expect(plan, "a plan without tiers: the legend and its plan line").toBeDefined();
    expect(textOf(plan!)).toBe(
      "Higher tiers, and any package for one competition, need a paid plan or an Event Pass for that competition. Every plan can sell Partner for the whole organisation.",
    );
  });

  it("an organisation-wide plan (tiers on every competition) has nothing to be told: the same four rows and no plan line", () => {
    const html = legend(true);
    expect(rowsOf(html)).toHaveLength(4);
    expect(html, "an organisation-wide plan: no plan line").not.toContain("tier-legend-plan");
  });
});

describe("the new copy exists in all four locales, with its placeholders intact", () => {
  const LOCALES: [string, Dict][] = [
    ["en", en],
    ["es", uiEs as unknown as Dict],
    ["fr", uiFr as unknown as Dict],
    ["nl", uiNl as unknown as Dict],
  ];
  // [key, placeholders it must carry]. The turns key is a plural pair (`.one` / `.other`), each carrying {count}.
  const KEYS: [string, string[]][] = [
    ["sponsors.pkg.legend.heading", []],
    ["sponsors.pkg.legend.tier.title", []],
    ["sponsors.pkg.legend.tier.gold", []],
    ["sponsors.pkg.legend.tier.silver", []],
    ["sponsors.pkg.legend.tier.partner", []],
    ["sponsors.pkg.legend.turns.one", ["count"]],
    ["sponsors.pkg.legend.turns.other", ["count"]],
    ["sponsors.pkg.legend.plan", ["partner"]],
  ];

  it("every key in every locale, non-empty, carrying its placeholders (32 checked)", () => {
    let checked = 0;
    for (const [locale, dict] of LOCALES) {
      for (const [key, vars] of KEYS) {
        const raw = (dict as unknown as Record<string, string>)[key];
        expect(raw, `${locale} ${key}`).toBeTypeOf("string");
        expect(raw!.trim().length, `${locale} ${key}: not empty`).toBeGreaterThan(0);
        for (const v of vars) expect(raw, `${locale} ${key}: {${v}}`).toContain(`{${v}}`);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * KEYS.length);
  });

  it("the four tier sentences differ within each locale (a copy-pasted row would show)", () => {
    for (const [locale, dict] of LOCALES) {
      const sentences = ORDER.map((tier) => (dict as unknown as Record<string, string>)[WHAT_KEYS[tier]]);
      expect(new Set(sentences).size, locale).toBe(4);
    }
  });
});
