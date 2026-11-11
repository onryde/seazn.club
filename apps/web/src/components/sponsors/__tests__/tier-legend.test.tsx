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
// Fix round 1 (owner feedback on stg; review I1, minors 1-5):
//   F1  board     draw the "one strip, one turn" sentence on an organisation-wide plan     -> "the board sentence is for a plan without tiers only"
//   F2  board     drop that sentence on a plan without tiers                               -> "the board sentence ... exact words"
//   F3  weight    read the sentence's turns from silver's weight, not the partner's        -> "the turns follow the PARTNER weight"
//   F4  link      draw the upgrade link for a viewer                                       -> "the upgrade link: editors on a plan without tiers only"
//   F5  link      drop the link's href (billingHref)                                        -> "the upgrade link goes to billing"
//   F6  fold      draw the legend without the phone fold                                    -> "folds below md"
//   F7  fold      let the fold start open on every list (startOpen ignored)                 -> "the fold starts open exactly when told to"
//   F8  fold      hide the section's own heading on md and up too                           -> "the heading is the toggle on a phone and the h3 from md"
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

// `sponsorCardOf` (the stream's card maker) is imported for one premise below; its three imports are inert here.
vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ hasFeature: vi.fn() }));
vi.mock("@/server/usecases/sponsors", () => ({ resolveSponsors: vi.fn() }));

import { propsOf, renderIsland, expandWithHooks, walk } from "@/components/__tests__/_hook-harness";
import { SponsorsBoard } from "@/components/public-site/sponsors-board";
import { TierLegend } from "@/components/sponsors/tier-legend";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import { sponsorCardOf } from "@/server/sponsors/card-source";
import type { ResolvedSponsor } from "@/server/usecases/sponsors";
import { SPONSOR_TIER_WEIGHTS, SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
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

const BILLING = "/o/x/settings/billing";
type LegendProps = Parameters<typeof TierLegend>[0];
const legendProps = (tiersOrgWide: boolean, over: Partial<LegendProps> = {}): LegendProps => ({
  tiersOrgWide,
  billingHref: BILLING,
  canEdit: true,
  startOpen: false,
  ...over,
});
const legend = (tiersOrgWide: boolean, over: Partial<LegendProps> = {}) => renderToStaticMarkup(<TierLegend {...legendProps(tiersOrgWide, over)} />);
/** The text of the first `<tag data-testid=id>` ... `</tag>` (these elements hold only text and inline children). */
const textById = (html: string, id: string, tag = "p"): string | undefined => {
  const m = new RegExp(`<${tag}\\b[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</${tag}>`).exec(html);
  return m ? textOf(m[1] ?? "") : undefined;
};
/** The opening tag carrying `data-testid=id`. */
const tagById = (html: string, id: string): string | undefined => new RegExp(`<[a-z0-9]+\\b[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0];
const countById = (html: string, id: string) => (html.match(new RegExp(`data-testid="${id}"`, "g")) ?? []).length;
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

  it("a plan without organisation-wide tiers still sees the legend, with the plan line: what its pages do, then what needs a paid plan or an Event Pass (the upsell)", () => {
    const html = legend(false);
    expect(rowsOf(html), "a plan without tiers: the legend and its plan line").toHaveLength(4);
    expect(countById(html, "tier-legend-plan"), "a plan without tiers: the legend and its plan line").toBe(1);
    expect(textById(html, "tier-legend-plan-tiers")).toBe(
      "Higher tiers, and any package for one competition, need a paid plan or an Event Pass for that competition. Every plan can sell Partner for the whole organisation.",
    );
  });

  it("an organisation-wide plan (tiers on every competition) has nothing to be told: the same four rows and no plan line", () => {
    const html = legend(true);
    expect(rowsOf(html)).toHaveLength(4);
    expect(html, "an organisation-wide plan: no plan line").not.toContain("tier-legend-plan");
  });
});

// --- review I1: the legend must not promise what a plan's pages do not keep ----------------------------------------------------

/** "one turn" / "N turns", typed from the language; the number is the engine's own declaration, never a literal here. */
const turnsWord = (n: number) => (n === 1 ? "one turn" : `${n} turns`);
const boardLine = (n: number) => `On your plan every sponsor shows in one strip and takes ${turnsWord(n)} on stream, except on a competition with an Event Pass.`;

describe("I1: on a plan without tiers the legend says what its pages and its stream really do", () => {
  it("the board sentence is for a plan without tiers only: exact words there, absent on an organisation-wide plan (the positive and negative pair; 2 x 2 checked)", () => {
    let checked = 0;
    for (const canEdit of [true, false]) {
      const without = legend(false, { canEdit });
      expect(textById(without, "tier-legend-plan-board"), `a plan without tiers, edit=${canEdit}: the board sentence, exact words`).toBe(boardLine(SPONSOR_TIER_WEIGHTS.partner));
      expect(textOf(without), `edit=${canEdit}: it says one strip and no Partners line`).toContain("shows in one strip");
      checked++;
      const withTiers = legend(true, { canEdit });
      expect(countById(withTiers, "tier-legend-plan-board"), `an organisation-wide plan, edit=${canEdit}: the board sentence is for a plan without tiers only`).toBe(0);
      expect(textOf(withTiers), `edit=${canEdit}: nor are its words anywhere`).not.toMatch(/one strip|on your plan/i);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(4);
  });

  it("the turns follow the PARTNER weight, because a plan without tiers draws every card as a partner: the real constant, then stand-ins that differ from it and from every other tier's (5 checked)", () => {
    let checked = 0;
    weights.override = null;
    expect(textById(legend(false), "tier-legend-plan-board")).toBe(boardLine(SPONSOR_TIER_WEIGHTS.partner));
    checked++;
    try {
      // Partner 6 and every other tier 1: only a sentence reading the partner's weight can say 6.
      weights.override = { title: 1, gold: 1, silver: 1, partner: 6 };
      expect(textById(legend(false), "tier-legend-plan-board"), "partner 6, the rest 1").toBe(boardLine(6));
      checked++;
      // Partner 1 and every other tier different: the singular, and not silver's 4 or title's 7.
      weights.override = { title: 7, gold: 5, silver: 4, partner: 1 };
      expect(textById(legend(false), "tier-legend-plan-board"), "partner 1, the rest 7/5/4").toBe(boardLine(1));
      expect(textById(legend(false), "tier-legend-plan-board")).toContain("one turn");
      checked += 2;
      weights.override = { title: 7, gold: 5, silver: 2, partner: 3 };
      expect(textById(legend(false), "tier-legend-plan-board"), "partner 3, silver 2").toBe(boardLine(3));
      checked++;
    } finally {
      weights.override = null;
    }
    expect(checked).toBe(5);
  });

  it("premise (the claim is what the product does): on a plan without tiers the board draws ONE flat strip of every sponsor, and the stream draws every card as a partner (4 + 4 checked)", () => {
    const spons = (tier: SponsorTier): ResolvedSponsor => ({ id: `sp-${tier}`, name: `Sponsor ${tier}`, tier, url: null, logo: null, poster: null });
    const html = renderToStaticMarkup(
      <SponsorsBoard sponsors={SPONSOR_TIERS.map(spons)} tiered={false} dict={publicEn as unknown as Dict} clickTag={{ source: "site" }} includeTitle />,
    );
    expect(countById(html, "mh-sponsors-flat"), "one strip").toBe(1);
    for (const tier of SPONSOR_TIERS) expect(html, `${tier}: in the strip`).toContain(`Sponsor ${tier}`);
    for (const id of ["mh-sponsors-board", "mh-sponsors-title", "mh-sponsors-partners"]) expect(countById(html, id), `no ${id}`).toBe(0);
    let checked = 0;
    for (const tier of SPONSOR_TIERS) {
      const row = { id: `sp-${tier}`, name: tier, logo_path: null, tier, on_stream: true };
      expect(sponsorCardOf(row, false).tier, `${tier}: untiered, the stream's card is a partner`).toBe("partner");
      expect(sponsorCardOf(row, true).tier, `${tier}: tiered, it keeps its own tier (the pair)`).toBe(tier);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// --- minor 4: the plan line's way out ------------------------------------------------------------------------------------------

describe("the upgrade link on the plan line", () => {
  it("the upgrade link: editors on a plan without tiers only - present for that one pair, absent for the other three (4 checked)", () => {
    let checked = 0;
    for (const tiersOrgWide of [true, false]) {
      for (const canEdit of [true, false]) {
        const html = legend(tiersOrgWide, { canEdit });
        const want = !tiersOrgWide && canEdit ? 1 : 0;
        expect(countById(html, "tier-legend-upgrade"), `tiers=${tiersOrgWide} edit=${canEdit}`).toBe(want);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("the upgrade link goes to billing, reads the house 'Upgrade your plan', is a 44px tap target on a phone, and sits inside the plan line after its sentences", () => {
    const html = legend(false);
    const tag = tagById(html, "tier-legend-upgrade");
    expect(tag, "premise: the link is drawn").toBeDefined();
    expect(tag).toContain(`href="${BILLING}"`);
    expect(tag).toMatch(/max-md:min-h-11/);
    expect(textById(html, "tier-legend-upgrade", "a")).toBe(msg("sponsors.dealSheet.upgrade"));
    expect(msg("sponsors.dealSheet.upgrade")).not.toBe("sponsors.dealSheet.upgrade");
    const planStart = html.indexOf('data-testid="tier-legend-plan"');
    const planEnd = html.indexOf("</section>", planStart);
    expect(html.indexOf('data-testid="tier-legend-upgrade"', planStart), "inside the plan line").toBeGreaterThan(planStart);
    expect(html.indexOf('data-testid="tier-legend-upgrade"', planStart)).toBeLessThan(planEnd);
    expect(html.indexOf('data-testid="tier-legend-upgrade"')).toBeGreaterThan(html.indexOf('data-testid="tier-legend-plan-tiers"'));
    // The href is the one the caller passed, not a literal.
    expect(tagById(legend(false, { billingHref: "/o/other/settings/billing" }), "tier-legend-upgrade")).toContain('href="/o/other/settings/billing"');
  });
});

// --- fold below md (owner feedback: the legend is long on a phone) -----------------------------------------------------------------

describe("the legend folds below md: one DOM, the toggle md:hidden, md and up unchanged", () => {
  it("folds below md: one disclosure whose summary is the legend heading, its toggle phone-only, its body closed on first paint, the rows still in the one DOM (4 checked)", () => {
    const html = legend(false);
    expect(countById(html, "tier-legend-fold"), "one fold").toBe(1);
    expect((html.match(/data-role="phone-disclosure"/g) ?? []).length, "one disclosure").toBe(1);
    const toggle = /<button\b[^>]*data-role="phone-disclosure-toggle"[^>]*>/.exec(html)?.[0] ?? "";
    expect(toggle, "the toggle is phone-only: anchored, so max-md:hidden cannot satisfy it").toMatch(/class="[^"]*\smd:hidden"/);
    expect(toggle, "closed on first paint").toContain('aria-expanded="false"');
    expect(toggle, "named by the show label").toContain(`aria-label="${msg("sponsors.pkg.legend.show")}"`);
    expect(textOf(/<button\b[^>]*data-role="phone-disclosure-toggle"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "").startsWith("What each tier gets"), "the summary is the heading").toBe(true);
    const controls = /aria-controls="([^"]+)"/.exec(toggle)?.[1];
    expect(html, "the body it controls is folded below md").toMatch(new RegExp(`<div class="grid min-w-0 flex-1 grid-cols-\\[minmax\\(0,1fr\\)\\] max-md:hidden" id="${controls}">`));
    expect(rowsOf(html), "one DOM: the four rows are in the markup, folded not removed").toHaveLength(4);
  });

  it("the heading is the toggle on a phone and the h3 from md: the section's own h3 is max-md:hidden and nothing hides it at md", () => {
    const html = legend(true);
    const h3 = /<h3\b[^>]*id="tier-legend-heading"[^>]*>/.exec(html)?.[0] ?? "";
    expect(h3).toMatch(/class="[^"]*\bmax-md:hidden\b/);
    expect(h3, "nothing hides it at md and up").not.toMatch(/class="[^"]*(?:^|\s)(?:hidden|md:hidden|sr-only)(?:\s|")/);
    expect(html).toMatch(/aria-labelledby="tier-legend-heading"/);
    expect(textOf(/<h3\b[^>]*id="tier-legend-heading"[^>]*>([\s\S]*?)<\/h3>/.exec(html)?.[1] ?? ""), "still the heading").toBe("What each tier gets");
  });

  it("the fold starts open exactly when told to: the legend hands its startOpen to the disclosure (true and false, 2 checked), and that disclosure then opens after hydration only for true", () => {
    let checked = 0;
    for (const startOpen of [true, false]) {
      const tree = walk(expandWithHooks(TierLegend, legendProps(false, { startOpen })) as never);
      const fold = tree.find((el) => el.type === PhoneDisclosure);
      expect(fold, `startOpen=${startOpen}: the legend mounts a PhoneDisclosure`).toBeDefined();
      expect(propsOf(fold!).phoneStartOpen, `startOpen=${startOpen}`).toBe(startOpen);
      expect(propsOf(fold!).showLabel).toBe(msg("sponsors.pkg.legend.show"));
      expect(propsOf(fold!).hideLabel).toBe(msg("sponsors.pkg.legend.hide"));
      // The producer's own props into the real consumer, hydrated at a phone width: open exactly when told to.
      vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) });
      try {
        const island = renderIsland(PhoneDisclosure, propsOf(fold!) as never, undefined, { hydrate: true });
        const toggle = island.tree().find((el) => propsOf(el)["data-role"] === "phone-disclosure-toggle")!;
        expect(propsOf(toggle)["aria-expanded"], `startOpen=${startOpen}: open after hydration at 320`).toBe(startOpen);
      } finally {
        vi.unstubAllGlobals();
      }
      checked++;
    }
    expect(checked).toBe(2);
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
    ["sponsors.pkg.legend.planBoard.one", []],
    ["sponsors.pkg.legend.planBoard.other", ["count"]],
    ["sponsors.pkg.legend.show", []],
    ["sponsors.pkg.legend.hide", []],
  ];

  it("every key in every locale, non-empty, carrying its placeholders (48 checked)", () => {
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
