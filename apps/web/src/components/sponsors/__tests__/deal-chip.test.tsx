// Sponsor deals PR 2, Task 14 - the deal chip (components/sponsors/deal-chip.tsx) on a sponsor's row.
//
// Expected words come from the MOCKUP (screen 1: Live, Awaiting payment, Awaiting approval, Draft, Ended, No deal) and from
// spec §5.2 / lib/sponsor-deals.ts's own `DealChip` doc (Paid, Scheduled, "Live · awaiting payment", "Live · on hold") - typed
// here, never read back from the component. The set of chip KINDS is typed too: the engine's `dealChip()` is swept over every
// deal_status x payment_status and each answer must be one of them.
//
// "No new colours" is a property of the chip's classes: every colour class on a chip must come from the status-chip vocabulary
// (`CHIP_STYLE`, components/ui/status-chip.tsx), the house's one declaration of how lifecycle state paints.
//
// Killers (one at a time, restore from a cp backup):
//   C1  kind -> key    the `ended` entry of DEAL_CHIP_MSG points at `draft`           -> "each kind reads its words"
//   C2  variant        drop the `awaitingPayment` arm of the label                      -> "a live deal still unpaid"
//   C3  variant        drop the `onHold` arm of the label                               -> "a live deal parked by a dispute"
//   C4  vocabulary     a one-off `bg-amber-100` on the awaiting_payment chip            -> "no new colours"
//   C5  contrast       "No deal" keeps archived's `text-slate-400`                        -> "'No deal' reads at AA"
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DealChip, DEAL_CHIP_MSG } from "@/components/sponsors/deal-chip";
import { CHIP_STYLE } from "@/components/ui/status-chip";
import { dealChip, DEAL_STATUSES, PAYMENT_STATUSES, type SponsorDeal } from "@/lib/sponsor-deals";
import { LOCALES } from "@/lib/i18n-constants";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const DICTS: Record<string, Record<string, string>> = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };

/** lib/sponsor-deals.ts `DealChip["kind"]`, typed from its doc: a scheduled deal that is paid reads "paid". */
const KINDS = ["draft", "awaiting_payment", "paid", "scheduled", "awaiting_approval", "live", "ended"] as const;
/** The English words per kind: the mockup's chips, then spec §5.2's two derived ones. */
const EN: Record<(typeof KINDS)[number] | "none", string> = {
  draft: "Draft",
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  scheduled: "Scheduled",
  awaiting_approval: "Awaiting approval",
  live: "Live",
  ended: "Ended",
  none: "No deal",
};

const DEAL: SponsorDeal = {
  id: "d1", sponsor_id: "s1", package_id: "p1", deal_status: "draft", payment_status: "pending", payment_method: "online",
  go_live: "on_payment", package_name: "Gold Season", tier: "gold", includes_on_stream: false, competition_id: null,
  amount_cents: 60_000, currency: "gbp", sponsor_name: "Ridge Gold Physiotherapy", sponsor_email: null, ends_at: null,
  created_at: "2026-10-28T09:00:00.000Z", created_by: null, invoice_sent_at: null, paid_at: null, marked_paid_by: null,
  approved_at: null, approved_by: null, live_at: null, ended_at: null, ended_reason: null, parked_at: null, disputed_at: null,
  dispute_id: null, has_payment_intent: false, invoice_number: null,
};
const deal = (over: Partial<SponsorDeal> = {}): SponsorDeal => ({ ...DEAL, ...over });
const html = (d: SponsorDeal | null) => renderToStaticMarkup(<DealChip deal={d} />);
const text = (markup: string) => markup.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const classOf = (markup: string) => /class="([^"]*)"/.exec(markup)?.[1] ?? "";

describe("each chip kind reads its words, in all four locales", () => {
  it("every kind (and the no-deal chip) has a dictionary key present in en, es, fr and nl (8 checked)", () => {
    const keys = { ...DEAL_CHIP_MSG };
    expect(Object.keys(keys).sort(), "the map covers exactly the kinds, plus none").toEqual([...KINDS, "none"].sort());
    let checked = 0;
    for (const [kind, key] of Object.entries(keys)) {
      for (const locale of LOCALES) {
        const words = DICTS[locale]![key];
        expect(typeof words === "string" && words.trim().length > 0, `${kind} in ${locale}`).toBe(true);
        checked++;
      }
    }
    expect(checked, "8 kinds x 4 locales").toBe(32);
  });

  it("the two live variants have words in all four locales, and each is more than plain 'Live' (2 keys x 4 locales)", () => {
    const VARIANTS = ["sponsors.deal.chip.liveAwaitingPayment", "sponsors.deal.chip.liveOnHold"] as const;
    let checked = 0;
    for (const key of VARIANTS) {
      for (const locale of LOCALES) {
        const words = DICTS[locale]![key];
        expect(typeof words === "string" && words.trim().length > 0, `${key} in ${locale}`).toBe(true);
        const plain = DICTS[locale]!["sponsors.deal.chip.live"]!;
        expect(words!.startsWith(plain), `${key} in ${locale} starts from the locale's own Live`).toBe(true);
        expect(words!.length, `${key} in ${locale} says more than Live`).toBeGreaterThan(plain.length);
        // Translated: the other three locales do not ship the English sentence.
        if (locale !== "en") expect(words, `${key} in ${locale} is not the English`).not.toBe(DICTS.en![key]);
        checked++;
      }
    }
    expect(checked, "2 variants x 4 locales").toBe(8);
  });

  it("the English words are the mockup's (8 checked)", () => {
    let checked = 0;
    for (const kind of [...KINDS, "none"] as const) {
      expect(uiEn[DEAL_CHIP_MSG[kind] as keyof typeof uiEn], kind).toBe(EN[kind]);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("the engine's dealChip() answers only the typed kinds, over every status x payment (30 checked), and each renders its kind's words", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const deal_status of DEAL_STATUSES) {
      for (const payment_status of PAYMENT_STATUSES) {
        const d = deal({ deal_status, payment_status });
        const { kind } = dealChip(d);
        expect(KINDS as readonly string[], `${deal_status}/${payment_status}`).toContain(kind);
        seen.add(kind);
        const words = text(html(d));
        expect(words, `${deal_status}/${payment_status}`).toContain(EN[kind]);
        checked++;
      }
    }
    expect(checked, "6 statuses x 5 payments").toBe(30);
    expect(seen.size, "every kind is reachable from the sweep").toBe(KINDS.length);
  });

  it("no deal: the chip says so", () => {
    expect(text(html(null))).toBe("No deal");
  });
});

describe("a live deal's two variants (lib/sponsor-deals.ts DealChip doc)", () => {
  it("a live deal still unpaid reads 'Live · awaiting payment'; paid, plain 'Live' (both checked)", () => {
    expect(text(html(deal({ deal_status: "live", payment_status: "pending" })))).toBe("Live · awaiting payment");
    expect(text(html(deal({ deal_status: "live", payment_status: "failed" })))).toBe("Live · awaiting payment");
    expect(text(html(deal({ deal_status: "live", payment_status: "paid" })))).toBe("Live");
    // A complimentary live deal has nothing to pay: plain Live.
    expect(text(html(deal({ deal_status: "live", payment_status: "none", payment_method: "complimentary" })))).toBe("Live");
  });

  it("a live deal parked by a dispute reads 'Live · on hold'; unparked, plain 'Live' (both checked)", () => {
    const parked = deal({ deal_status: "live", payment_status: "paid", parked_at: "2026-11-01T10:00:00.000Z" });
    expect(text(html(parked))).toBe("Live · on hold");
    expect(text(html(deal({ deal_status: "live", payment_status: "paid", parked_at: null })))).toBe("Live");
  });

  it("an unpaid deal that is NOT live does not borrow the live words (the pair)", () => {
    expect(text(html(deal({ deal_status: "awaiting_payment", payment_status: "pending" })))).toBe("Awaiting payment");
    expect(text(html(deal({ deal_status: "scheduled", payment_status: "pending" })))).toBe("Scheduled");
    expect(text(html(deal({ deal_status: "scheduled", payment_status: "paid" })))).toBe("Paid");
  });
});

describe("the chip wears the status-chip vocabulary and invents no colour", () => {
  // The status chip's shape, plus `max-w-full`: a long chip (fr: "Actif · en attente de paiement") wraps inside a 320px row instead of
  // pushing the page sideways. Layout, not colour.
  const SHAPE = ["inline-flex", "shrink-0", "items-center", "gap-1.5", "rounded-full", "px-2.5", "py-0.5", "text-xs", "font-medium", "max-w-full"];

  it("every kind carries the status chip's shape and exactly one of its declared colour recipes (8 checked)", () => {
    // The status chip's recipes, plus the one deliberate contrast step for "No deal" (asserted on its own below): archived with its
    // slate-400 text taken to slate-500.
    const AA_ARCHIVED = CHIP_STYLE.archived.split(/\s+/).map((t) => (t === "text-slate-400" ? "text-slate-500" : t));
    const recipes = [...Object.values(CHIP_STYLE).map((r) => r.split(/\s+/)), AA_ARCHIVED].map((r) => [...r].sort().join(" "));
    let checked = 0;
    const samples: [string, SponsorDeal | null][] = [
      ["none", null],
      ["draft", deal({ deal_status: "draft" })],
      ["awaiting_payment", deal({ deal_status: "awaiting_payment" })],
      ["awaiting_approval", deal({ deal_status: "awaiting_approval" })],
      ["paid", deal({ deal_status: "scheduled", payment_status: "paid" })],
      ["scheduled", deal({ deal_status: "scheduled" })],
      ["live", deal({ deal_status: "live", payment_status: "paid" })],
      ["ended", deal({ deal_status: "ended", payment_status: "paid" })],
    ];
    for (const [label, d] of samples) {
      const tokens = classOf(html(d)).split(/\s+/).filter(Boolean);
      for (const t of SHAPE) expect(tokens, `${label} keeps ${t}`).toContain(t);
      const rest = tokens.filter((t) => !SHAPE.includes(t));
      const recipe = recipes.find((r) => r.split(" ").every((t) => rest.includes(t)));
      expect(recipe, `${label}: its colours (${rest.join(" ")}) are one of the status chip's recipes`).toBeDefined();
      // ... and nothing else: no class beyond the shape and that recipe.
      expect(rest.filter((t) => !recipe!.split(" ").includes(t)), `${label}: no class beyond the vocabulary`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("'No deal' reads at AA: slate-500 text, where the status chip's archived recipe is slate-400 (~2.6:1 on white; review m1)", () => {
    const tokens = classOf(html(null)).split(/\s+/);
    expect(tokens, "slate-500 is 4.8:1 on white").toContain("text-slate-500");
    expect(tokens, "not archived's 2.6:1 slate-400").not.toContain("text-slate-400");
    // The rest of the recipe is archived's quiet outline, unchanged ...
    for (const t of CHIP_STYLE.archived.split(/\s+/).filter((x) => x !== "text-slate-400")) expect(tokens, t).toContain(t);
    // ... and the status chip's own archived is left as it was (other screens wear it).
    expect(CHIP_STYLE.archived).toContain("text-slate-400");
    // Its pair: a deal's chip that is not "No deal" is not touched by the swap. A DRAFT is the witness: its own recipe is slate-600, so
    // a swap that leaked onto every chip would move it. (An ended chip is slate-500 already - the swap could not change it, so it
    // cannot witness anything; T14 re-review m1.)
    const draft = classOf(html(deal({ deal_status: "draft" }))).split(/\s+/);
    expect(draft, "a draft keeps its own slate-600").toContain("text-slate-600");
    expect(draft, "and did not take the No-deal swap").not.toContain("text-slate-500");
  });

  it("a live deal keeps the status chip's pulse dot; a parked one does not (it is not live on the pages)", () => {
    expect(html(deal({ deal_status: "live", payment_status: "paid" }))).toContain("chip-pulse-dot");
    expect(html(deal({ deal_status: "live", payment_status: "paid", parked_at: "2026-11-01T10:00:00.000Z" }))).not.toContain("chip-pulse-dot");
    expect(html(deal({ deal_status: "ended" }))).not.toContain("chip-pulse-dot");
  });

  it("the states a person must tell apart at a glance paint differently: live, draft, ended, awaiting approval, no deal (5 distinct)", () => {
    const paints = [
      html(deal({ deal_status: "live", payment_status: "paid" })),
      html(deal({ deal_status: "draft" })),
      html(deal({ deal_status: "ended" })),
      html(deal({ deal_status: "awaiting_approval" })),
      html(null),
    ].map((m) => classOf(m));
    expect(new Set(paints).size).toBe(5);
  });
});
