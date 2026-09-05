import { formatMinor, proPrice, type Currency, type PassKey } from "@/lib/currency";
// Mutually referential with pass-ladder (it reads PASS_CREDIT_GRANT from here).
// Safe and deliberate: neither side touches the other at module scope — both
// references sit inside function bodies — so there is no initialisation order
// in which either binding is unset. Both modules are pure, with no `server-only`
// and no module-scope `sql`.
import { lowestPassRung } from "@/lib/pass-ladder";
import { t, type TKey } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MatrixData } from "@/lib/pricing-matrix";

// Single source for plan-card bullets — shared by /pricing and the home
// ticket stubs so the two can never drift (design/v3/12 §4.8).
//
// ── THESE ARE KEYS, NOT SENTENCES (entitlements v18 W2) ─────────────────────
// Until this wave the three arrays below held plain ENGLISH STRINGS and both
// surfaces rendered them verbatim, in every locale. A Spanish visitor to
// /es/pricing read a localised crossover sentence, a localised FAQ and a
// localised comparison matrix, and then three cards of English bullets. It was
// deliberate once — the deleted Pro Plus card's own comment said its text "is
// fully localized, unlike the other three cards' hardcoded-English arrays" —
// and this wave changing five of those bullets' values is what made the debt
// due: "any new or CHANGED user-facing string → all four locale dictionaries".
//
// ── AND THE NUMBERS ARE INTERPOLATED, NOT WRITTEN ───────────────────────────
// Every figure a bullet quotes is a matrix claim, so each one names the
// `plan_entitlements` row it comes from and `cardBullets` fills it at render
// time. Copy that quotes a number goes stale under the row it describes — this
// programme has fixed exactly that four times (V393 re-cut community's
// active-competition cap to 3 against a card still promising 10; V396 took
// badge removal off Pro; V398 re-cut the fee ladder to 5/4/2/1; the withdrawn
// L rung's caps outlived its sale) — and a number typed into FOUR locale files
// goes stale four times and is corrected once. `pricing-card-i18n.test.ts`
// forbids a digit anywhere in these keys' copy, in any locale.
//
// What the copy still ASSERTS in words — that Pro's competitions are
// "unlimited", that a bullet's capability exists on its plan at all — is judged
// against the live matrix by `CARD_SURFACES` in `lib/__tests__/pricing-cards.test.ts`.

/** One bullet: the dictionary key it renders from, and the `plan_entitlements`
 *  rows its placeholders read.
 *
 *  `vars` maps a `{placeholder}` name to a `[feature_key, plan_key]` pair. The
 *  plan is NOT always the card's own — the Event Pass card quotes community's
 *  rate as the comparator its own rate is cheaper than. */
export interface CardBullet {
  key: TKey;
  vars?: Readonly<Record<string, readonly [feature: string, plan: string]>>;
}

// The pass card sells the rungs in `SELLABLE_PASS_KEYS`, which is `event_pass`
// alone since the owner took the L rung off sale (2026-09-05). Named literally
// rather than derived: the copy says "N divisions, M entrants each" in the
// singular, so a second rung coming back on sale is a COPY change, not a
// silently-picked plan key. `pricing-cards.test.ts`'s "the pass bullet names
// the division cap of every rung on sale, and no other" is what reds the day
// that happens, and it reads SELLABLE_PASS_KEYS rather than this file.
const PASS_RUNG = "event_pass";

export const FREE_CARD_BULLETS: readonly CardBullet[] = [
  // 3, not 10: V393 (entitlements v18 W2 T1) re-cut community's active
  // competition cap. Both figures are read from the matrix now, so this
  // sentence cannot be wrong about either of them again.
  {
    key: "pricing.community.f1",
    vars: {
      competitions: ["competitions.max_active", "community"],
      divisions: ["divisions.per_competition.max", "community"],
    },
  },
  { key: "pricing.community.f2", vars: { entrants: ["entrants.per_division.max", "community"] } },
  { key: "pricing.community.f3" },
  // V310: charging entry fees is free on every plan — only the platform cut
  // differs (5 / 4 / 2 / 1% since V398). "Free-event" undersold Community and
  // made the pass look like it unlocked payment rather than a cheaper rate.
  { key: "pricing.community.f4", vars: { fee: ["registration.fee_percent", "community"] } },
  { key: "pricing.community.f5" },
  { key: "pricing.community.f6" },
];

// Every bullet here must be something the event_pass column actually LIFTS off
// community. "Custom branding & PDF/XLSX exports" was neither: `branding` and
// `exports` are true for Community (V310) and `dashboard.branding` — the org
// theme colour — stays denied to the pass. The real grant is `exports.branded`.
// The first four are also the home-page stub (ticketTiers slices them).
export const PASS_CARD_BULLETS: readonly CardBullet[] = [
  // v17 gap wave 7 (#298): "forever" was false. V328/V334 (`org_has_feature`)
  // bind the pass to the competition's OWN lifecycle — the pass arm drops out
  // once the competition is archived or completed, or more than 7 days past its
  // end date. This is the same bound `pricing.pass.note` and `upgrade.intro`
  // state in all four dictionaries, and now this bullet states it in the same
  // four rather than in English alone.
  { key: "pricing.pass.f1" },
  // v17 #294 made this line name BOTH rungs' ceilings, because leading with
  // M's alone read as "an Event Pass caps at 128" — the exact limit an L buyer
  // was paying to remove. Owner decision 2026-09-05 took the L rung off sale,
  // so the second half named an offer with no checkout behind it: the card
  // would be advertising 512 entrants that nothing on the site will sell. It
  // went, and the line is the sellable rung's ceilings — which is the whole
  // ladder now.
  {
    key: "pricing.pass.f2",
    vars: {
      divisions: ["divisions.per_competition.max", PASS_RUNG],
      entrants: ["entrants.per_division.max", PASS_RUNG],
    },
  },
  { key: "pricing.pass.f3" },
  // BOTH rates, because the claim is a comparison: the pass is cheaper per
  // pound of entry fees THAN COMMUNITY. Quoting only the pass's own rate would
  // survive a change to community's and stop being a saving at all.
  {
    key: "pricing.pass.f4",
    vars: {
      fee: ["registration.fee_percent", PASS_RUNG],
      communityFee: ["registration.fee_percent", "community"],
    },
  },
  { key: "pricing.pass.f5" },
  { key: "pricing.pass.f6" },
  { key: "pricing.pass.f7" },
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
// that took Pro's monthly grant 35 -> 25 and its trial 20 -> 15 (V395). The
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

export const PRO_CARD_BULLETS: readonly CardBullet[] = [
  // HALF of this was true and half was not. `competitions.max_active` is still
  // null on pro; `divisions.per_competition.max` is 20 since V393. One bullet
  // covering two rows outlives a change to either, which is exactly how it
  // came to promise a cap the resolver enforces at 20.
  //
  // Only the division cap is interpolated: "Unlimited" is a claim about a NULL
  // row, which has no number to render. `CARD_SURFACES`'s `unlimited` regex is
  // what holds it — move `competitions.max_active` off null on pro and
  // `cardMatrixFaults` reds with "card claims UNLIMITED … but the matrix caps
  // pro at N".
  { key: "pricing.pro.f1", vars: { divisions: ["divisions.per_competition.max", "pro"] } },
  { key: "pricing.pro.f2", vars: { entrants: ["entrants.per_division.max", "pro"] } },
  { key: "pricing.pro.f3", vars: { fee: ["registration.fee_percent", "pro"] } },
  // W1 (entitlements v18, owner ruling 2026-08-30): was "Ball-by-ball & rally
  // scoring, player stats". V390 deleted `scoring.ball_by_ball` and
  // `scoring.rally_by_rally` from `plan_entitlements`, so two thirds of that
  // bullet promised rows that no longer exist — and, worse, sold a capability
  // Community now has in full. `stats.player` is the third of the three and is
  // still Pro-only, so the bullet keeps its row and loses its falsehood.
  { key: "pricing.pro.f4" },
  { key: "pricing.pro.f5" },
  // WAS "Remove the “Powered by Seazn” badge". V396 (W2 T15, owner ruling
  // 2026-09-03) made badge removal ENTERPRISE-only — every self-serve plan
  // carries the badge now, Pro included — so this bullet promised a row Pro no
  // longer holds. V397 then split the accent colour onto `dashboard.theme`,
  // which IS a Pro grant and is the visual differentiator the badge line used
  // to stand in for. Replaced rather than dropped: the card keeps a claim about
  // how a Pro org's public pages look, and it is one the matrix backs.
  { key: "pricing.pro.f6" },
  // v16 league-ops (T84): suspensions/discipline, official ratings and
  // auto-drafted news posts all seed true on Pro (V293/V294/V295).
  { key: "pricing.pro.f7" },
  // V393 brought `officials.auto` down from the deleted Pro Plus to Pro, so the
  // Pro card can make this claim for the first time. Folded into the ratings
  // bullet rather than added as a tenth: one bullet, two rows
  // (`officials.auto` + `officials.marks`), both pinned in CARD_SURFACES.
  { key: "pricing.pro.f8" },
  { key: "pricing.pro.f9" },
];

// The Pro Plus CARD ARRAYS were deleted here in W2 (entitlements v18, V393 +
// T2): `PLUS_CARD_FEATURES`, `PLUS_COMING_SOON` and the whole "Everything in
// Pro, plus…" surface. The plan does not exist — V393 deleted `pro_plus` from
// `plans` and `plan_entitlements` outright — and `/pricing` had already stopped
// rendering them: the page reads `pricing.plus.cta` as the PRO card's CTA label
// and nothing else from that family, and `components/marketing/plus-reveal.tsx`
// is imported by no page at all.
//
// Leaving them was not neutral. Every bullet was read under an EXCLUSIVITY
// frame, and four of the five named rows that no longer exist on any plan
// (`officials.auto` came back to Pro, `api.write` is enterprise-only,
// `support.priority` was deleted by V393, `clubs.hierarchy` is free) — so the
// guards that judged them reported five live falsehoods against a card nobody
// can see, which is noise that hides the real ones.
//
// The `pricing.plus.f1-5` / `soon1-8` DICTIONARY keys stay for now: pruning the
// four locale trees is W3's, and an unrendered key costs nothing while an
// unrendered ARRAY costs a guard's attention. Enterprise is a Contact-us strip
// (design §4), not a priced column, so nothing replaces this here.

/**
 * Render a card's bullets in one locale, filling every figure from the live
 * matrix.
 *
 * A bullet whose numbers are not all readable is DROPPED, not rendered with a
 * hole. Two reasons, and the first is the page's own standing rule for this
 * data: `loadPricingMatrix` fails soft to `{}` when the DB is unreachable at
 * build, and "absence must suppress the block, not embellish it" is exactly how
 * the M/L ladder above the bullets already behaves. The second is mechanical —
 * `interpolate` leaves an unknown `{name}` in the output VERBATIM, so a missing
 * row would otherwise ship a literal "{entrants} entrants per division" onto a
 * buyer's screen.
 *
 * A null `int_value` is a legitimate value meaning UNLIMITED, and it is not a
 * number a cap sentence can render, so it suppresses the bullet too. Nothing on
 * these three cards quotes an unlimited row through a placeholder — Pro's
 * "Unlimited competitions" says the word instead — so that branch costs no
 * copy today and cannot silently print "null divisions" tomorrow.
 */
export function cardBullets(
  d: Dict,
  bullets: readonly CardBullet[],
  matrix: MatrixData,
): string[] {
  const out: string[] = [];
  for (const bullet of bullets) {
    const vars: Record<string, number> = {};
    let readable = true;
    for (const [name, [feature, plan]] of Object.entries(bullet.vars ?? {})) {
      const value = matrix[feature]?.[plan]?.int_value;
      if (typeof value !== "number") {
        readable = false;
        break;
      }
      vars[name] = value;
    }
    if (!readable) continue;
    out.push(t(d, bullet.key, vars));
  }
  return out;
}

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
 *  Event Pass / Pro).
 *
 *  Takes the dictionary and the matrix rather than reading either itself: the
 *  home page is a Server Component that already has both in hand, and this
 *  module must stay pure (no `server-only`) because `lib/billing.ts` and
 *  `lib/pass-ladder.ts` import `PASS_CREDIT_GRANT` from it. */
export function ticketTiers(currency: Currency, d: Dict, matrix: MatrixData): TicketTier[] {
  return [
    {
      tier: t(d, "pricing.community.name"),
      price: t(d, "pricing.community.price"),
      bullets: cardBullets(d, FREE_CARD_BULLETS, matrix).slice(0, 4),
    },
    {
      tier: t(d, "pricing.pass.name"),
      // The LOWEST rung, marked as a floor — the stub has no room to compare
      // two, and "from" hands the reader to /pricing for the difference.
      //
      // DERIVED, not named. This read the literal "event_pass", which is honest
      // only while M is the cheapest rung — precisely the assumption
      // `lowestPassRung` exists to delete. A discount on L, or a rung added
      // underneath, now moves this number with it.
      prefix: t(d, "pricing.pass.from"),
      price: formatMinor(lowestPassRung(currency).amountMinor, currency),
      period: t(d, "home.stub.once"),
      bullets: cardBullets(d, PASS_CARD_BULLETS, matrix).slice(0, 4),
      glow: true,
    },
    {
      tier: t(d, "pricing.table.pro"),
      price: formatMinor(proPrice("monthly", currency), currency),
      period: t(d, "home.stub.perMonth"),
      bullets: cardBullets(d, PRO_CARD_BULLETS, matrix).slice(0, 4),
    },
  ];
}
