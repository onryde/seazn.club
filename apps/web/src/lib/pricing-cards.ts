import { formatMinor, proPrice, type Currency, type PassKey } from "@/lib/currency";
// Mutually referential with pass-ladder (it reads PASS_CREDIT_GRANT from here).
// Safe and deliberate: neither side touches the other at module scope — both
// references sit inside function bodies — so there is no initialisation order
// in which either binding is unset. Both modules are pure, with no `server-only`
// and no module-scope `sql`.
import { lowestPassRung } from "@/lib/pass-ladder";

// Single source for plan-card bullets — shared by /pricing and the home
// ticket stubs so the two can never drift (design/v3/12 §4.8).
// V311 (D22): these numbers are pinned against the live matrix by
// lib/__tests__/pricing-cards.test.ts. Moving a cap means moving the copy here
// AND in billing.community.* / billing.pro.* across all four dictionaries.
export const FREE_FEATURES = [
  // 3, not 10: V392 (entitlements v18 W2 T1) re-cut community's active
  // competition cap. The number is quoted here and in billing.community.f1
  // across four dictionaries; `cardMatrixFaults` pins this one and
  // pricing-cards.test.ts pins those.
  "3 active competitions, 4 divisions",
  "64 entrants per division",
  "League, groups + knockout & swiss formats",
  // V310: charging entry fees is free on every plan — only the platform cut
  // differs (5 / 4 / 2 / 1% since V397). "Free-event" undersold Community and made the
  // pass look like it unlocked payment rather than a cheaper rate.
  "Online registration & entry fees (5% fee)",
  "Live standings & public dashboard",
  "Listed on the seazn.club showcase",
];

// Every bullet here must be something the event_pass column actually LIFTS off
// community. "Custom branding & PDF/XLSX exports" was neither: `branding` and
// `exports` are true for Community (V310) and `dashboard.branding` — the org
// theme colour — stays denied to the pass. The real grant is `exports.branded`.
// The first four are also the home-page stub (ticketTiers slices them).
export const PASS_FEATURES = [
  // v17 gap wave 7 (#298): "forever" was false. V328/V334 (`org_has_feature`)
  // bind the pass to the competition's OWN lifecycle — the pass arm drops out
  // once the competition is archived or completed, or more than 7 days past its
  // end date. This is the same bound `pricing.pass.note` and `upgrade.intro`
  // state in all four dictionaries; the bullets on this card are hardcoded
  // English (the pass/Community/Pro cards render these arrays directly), so the
  // sentence has to be corrected HERE as well as there.
  "Upgrades ONE competition while it runs",
  // v17 #294 made this line name BOTH rungs' ceilings, because leading with
  // M's alone read as "an Event Pass caps at 128" — the exact limit an L buyer
  // was paying to remove. Owner decision 2026-09-05 took the L rung off sale,
  // so the second half now names an offer with no checkout behind it: the card
  // would be advertising 512 entrants that nothing on the site will sell. It
  // goes, and the line is M's ceilings again — which is the whole ladder now.
  //
  // The figures stay written out rather than derived because this array is the
  // card's hardcoded English (see the header above); `capClaimFaults`
  // (lib/copy-truth.ts) is what holds them to `plan_entitlements`, including
  // the rule that a numeric cap may not also be called unlimited.
  "10 divisions, 128 entrants each",
  "Advanced formats — double elim, ladders",
  "4% platform fee on entry fees, not 5%",
  "Branded exports & public player cards",
  "Sponsor tiers & paid sponsorship packages",
  "Realtime scoreboard & slideshow",
  // v17 (SPEC-6 A1): the retired "10 AI schedule runs per division" line is
  // gone — the graded run cap became the credit wallet (V322). The pass's
  // credit story is the dedicated credits line on the card (PASS_CREDIT_GRANT),
  // not a bullet, so it reads as one of the two v17 differentiators (fee % +
  // credits) rather than being buried in the list.
];

// v17 AI credit wallet (SPEC-6 A1 / A7): the Event Pass tops the org wallet up
// by a one-time grant when a competition is upgraded. Unlike the monthly plan
// grants (community/pro), the pass has NO `ai.credits.monthly` row in
// plan_entitlements — it is a one-off top-up, so this is the single source for
// the number the pricing card quotes. Pinned by pricing-cards.test.ts.
//
// ENTITLEMENTS V18 / W2 T5 (design R9, owner ruling 2026-09-03): the grant is
// now PER RUNG — M grants 25, L grants 35. It was flat, and the reason recorded
// for that (`L buys a bigger competition, not more credits`) was reversed: a
// bigger competition is exactly the one that needs more AI scheduling.
//
// W2 T12 (owner ruling 2026-09-03) re-cut L from 50 to 35, in the same pass
// that took Pro's monthly grant 35 -> 25 and its trial 20 -> 15 (V394). The
// rungs still differ — that is the whole point of pricing the grant — but L is
// no longer double M. Every figure in the copy that quotes it moved with this
// line; `passCreditGrantFaults` / `passCreditProseFaults` /
// `localeCreditGrantFaults` (lib/copy-truth.ts) read the constant, so a half
// update reds rather than shipping.
//
// A `Record` keyed by `PassKey`, not two constants and not a lookup with a
// default: `tsc` then enumerates every reader the day a third rung is added,
// which is the same discipline `recordPassPurchase`'s required `passKey` and
// `PASS_RUNG_MARKETING_KEY` already apply. There is deliberately NO fallback
// anywhere — a `?? 25` would restore the flat grant silently for a new rung.
//
// The credits are a ONE-TIME TOP-UP and they STAY: no expiry, no clawback on
// downgrade, no cap (`recordPassGrant` writes the never-expiring `pack` bucket).
// The only thing that pulls them back is a refund of the pass itself
// (`recordPassRefund`), which is money returned rather than a grant expiring.
export const PASS_CREDIT_GRANT: Record<PassKey, number> = {
  event_pass: 25,
  event_pass_l: 35,
};

export const PRO_FEATURES = [
  // HALF of this was true and half was not. `competitions.max_active` is still
  // null on pro; `divisions.per_competition.max` is 20 since V392. One bullet
  // covering two rows outlives a change to either, which is exactly how it
  // came to promise a cap the resolver enforces at 20.
  "Unlimited competitions, 20 divisions each",
  "256 entrants per division",
  "Entry fees at a 2% platform fee",
  // W1 (entitlements v18, owner ruling 2026-08-30): was "Ball-by-ball & rally
  // scoring, player stats". V390 deleted `scoring.ball_by_ball` and
  // `scoring.rally_by_rally` from `plan_entitlements`, so two thirds of that
  // bullet promised rows that no longer exist — and, worse, sold a capability
  // Community now has in full. `stats.player` is the third of the three and is
  // still Pro-only, so the bullet keeps its row and loses its falsehood.
  "Player stats & scorecards",
  "Officials, exports, API keys, device links",
  // WAS "Remove the “Powered by Seazn” badge". V395 (W2 T15, owner ruling
  // 2026-09-03) made badge removal ENTERPRISE-only — every self-serve plan
  // carries the badge now, Pro included — so this bullet promised a row Pro no
  // longer holds. V396 then split the accent colour onto `dashboard.theme`,
  // which IS a Pro grant and is the visual differentiator the badge line used
  // to stand in for. Replaced rather than dropped: the card keeps a claim about
  // how a Pro org's public pages look, and it is one the matrix backs.
  "Your club colours on public pages & slideshow",
  // v16 league-ops (T84): suspensions/discipline, official ratings and
  // auto-drafted news posts all seed true on Pro (V293/V294/V295).
  "Suspensions & discipline tracking",
  // V392 brought `officials.auto` down from the deleted Pro Plus to Pro, so the
  // Pro card can make this claim for the first time. Folded into the ratings
  // bullet rather than added as a tenth: one bullet, two rows
  // (`officials.auto` + `officials.marks`), both pinned in CARD_SURFACES.
  "Auto officials assignment & ratings",
  "Auto-drafted result posts",
];

// The Pro Plus CARD ARRAYS were deleted here in W2 (entitlements v18, V392 +
// T2): `PLUS_CARD_FEATURES`, `PLUS_COMING_SOON` and the whole "Everything in
// Pro, plus…" surface. The plan does not exist — V392 deleted `pro_plus` from
// `plans` and `plan_entitlements` outright — and `/pricing` had already stopped
// rendering them: the page reads `pricing.plus.cta` as the PRO card's CTA label
// and nothing else from that family, and `components/marketing/plus-reveal.tsx`
// is imported by no page at all.
//
// Leaving them was not neutral. Every bullet was read under an EXCLUSIVITY
// frame, and four of the five named rows that no longer exist on any plan
// (`officials.auto` came back to Pro, `api.write` is enterprise-only,
// `support.priority` was deleted by V392, `clubs.hierarchy` is free) — so the
// guards that judged them reported five live falsehoods against a card nobody
// can see, which is noise that hides the real ones.
//
// The `pricing.plus.f1-5` / `soon1-8` DICTIONARY keys stay for now: pruning the
// four locale trees is W3's, and an unrendered key costs nothing while an
// unrendered ARRAY costs a guard's attention. Enterprise is a Contact-us strip
// (design §4), not a priced column, so nothing replaces this here.

export interface TicketTier {
  tier: string;
  price: string;
  /** Small qualifier rendered BEFORE the price — "from" on a tier that is a
   *  ladder rather than a single price (v17 #294: the Event Pass sells at two
   *  rungs, so its cheapest is a floor, not the cost). Absent means the price
   *  is the price. */
  prefix?: string;
  period?: string;
  bullets: string[];
  glow?: boolean;
}

/** The three home-page ticket stubs (design/v3/12 §4.8): headline bullets
 *  only — the full matrix lives on /pricing. Home STAYS 3 stubs (Community /
 *  Event Pass / Pro) even after Pro Plus ships — /pricing carries the full
 *  4-offer ladder via PlusReveal's progressive disclosure. */
export function ticketTiers(currency: Currency): TicketTier[] {
  return [
    { tier: "Community", price: "Free", bullets: FREE_FEATURES.slice(0, 4) },
    {
      tier: "Event Pass",
      // The LOWEST rung, marked as a floor — the stub has no room to compare
      // two, and "from" hands the reader to /pricing for the difference.
      //
      // DERIVED, not named. This read the literal "event_pass", which is honest
      // only while M is the cheapest rung — precisely the assumption
      // `lowestPassRung` exists to delete. A discount on L, or a rung added
      // underneath, now moves this number with it.
      prefix: "from",
      price: formatMinor(lowestPassRung(currency).amountMinor, currency),
      period: " once",
      bullets: PASS_FEATURES.slice(0, 4),
      glow: true,
    },
    {
      tier: "Pro",
      price: formatMinor(proPrice("monthly", currency), currency),
      period: "/mo",
      bullets: PRO_FEATURES.slice(0, 4),
    },
  ];
}
