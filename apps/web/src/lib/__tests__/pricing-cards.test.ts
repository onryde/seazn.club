import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  PASS_CREDIT_GRANT,
  ticketTiers,
} from "../pricing-cards";
import {
  HIDDEN_PASS_KEYS,
  PASS_KEYS,
  SELLABLE_PASS_KEYS,
  SUPPORTED_CURRENCIES,
  formatMinor,
  lowestCreditPackAmount,
  passPrice,
} from "../currency";
import stripePlans from "@/config/stripe-plans.json";
import {
  BOUNDED_SCOPE_GRAMMAR,
  FALSE_PASS_PERMANENCE_PATTERNS,
  type FeatureGrants,
  EXCLUSIVE_CLAIM_VOCAB,
  localeCreditLeadershipFaults,
  wholeNumber,
} from "@/lib/copy-truth";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("pricing cards", () => {
  it("stub bullets are drawn from the shared /pricing arrays (drift guard)", () => {
    const [community, pass, pro] = ticketTiers("usd");
    expect(community!.bullets.every((b) => FREE_FEATURES.includes(b))).toBe(true);
    expect(pass!.bullets.every((b) => PASS_FEATURES.includes(b))).toBe(true);
    expect(pro!.bullets.every((b) => PRO_FEATURES.includes(b))).toBe(true);
    expect(community!.bullets.length).toBeGreaterThanOrEqual(3);
  });
  it("prices come from lib/currency (multi-currency stays correct)", () => {
    // Formatted from the SEED's own points, not from amounts typed here — W3
    // moved every price onto a charm point and a typed pair would red on the
    // next legitimate reprice while pinning nothing about the formatting or
    // the currency routing this case exists for.
    const [, passUsd, proUsd] = ticketTiers("usd");
    expect(passUsd!.price).toBe(formatMinor(passPrice("usd", "event_pass"), "usd"));
    expect(proUsd!.price).toBe(formatMinor(stripePlans.plans[0]!.prices.monthly.unit_amount, "usd"));
    expect(proUsd!.period).toBe("/mo");
    const [, passInr] = ticketTiers("inr");
    expect(passInr!.price).not.toBe(passUsd!.price);
    expect(passInr!.price).toContain("₹");
  });
  // v17 #294: the home stub still leads with M's price, because M is what the
  // lowest rung costs — but with two rungs on sale that figure is a FLOOR, not
  // the price. Unprefixed it reads as "an Event Pass costs $15", which is
  // false for half the product. Community has no prefix: Free really is free.
  it("marks the Event Pass price as a floor, and only that one", () => {
    const [community, pass, pro] = ticketTiers("usd");
    expect(pass!.prefix, "the pass is a ladder, so its price is a 'from'").toBeTruthy();
    expect(community!.prefix).toBeUndefined();
    expect(pro!.prefix).toBeUndefined();
  });

  /**
   * FIX ROUND 2 — the add-on line quoted a HARDCODED "$10" in all four locales
   * while every other price on /pricing goes through `formatMinor(…, currency)`
   * behind the CurrencySwitcher. The seed's cheapest pack was eur 900 / gbp 800 /
   * aud 1500 / inr 79900 when that was written — AUD has since been dropped and
   * the INR packs re-anchored to 39900 — so the literal was false in FOUR of the
   * five currencies of the day, exactly the defect #191 was filed for on the
   * pass copy.
   *
   * Pinned to the SEED, not to a number: the floor is the smallest amount in the
   * switched currency, so adding a cheaper pack moves the advertised "from".
   */
  it("the credit-pack floor is the seed's cheapest pack, in every currency", () => {
    const packs = (stripePlans as { packs?: Array<{ price: { unit_amount: number; currency_options?: Record<string, number> } }> }).packs ?? [];
    expect(packs.length, "the seed has no credit packs to advertise").toBeGreaterThan(1);
    for (const currency of SUPPORTED_CURRENCIES) {
      const amounts = packs.map((p) =>
        currency === "usd" ? p.price.unit_amount : p.price.currency_options?.[currency],
      );
      expect(amounts.every((a) => typeof a === "number"), `${currency}: a pack has no price point`).toBe(true);
      expect(lowestCreditPackAmount(currency), currency).toBe(Math.min(...(amounts as number[])));
    }
    // The defect itself: the non-usd currencies must NOT resolve to usd's floor,
    // or a hardcoded "$10" would have been accidentally right and this guard
    // would prove nothing.
    const usd = lowestCreditPackAmount("usd");
    const differing = SUPPORTED_CURRENCIES.filter((c) => c !== "usd" && lowestCreditPackAmount(c) !== usd);
    expect(differing.length, "every currency matched usd — the seed lost its price points").toBeGreaterThan(2);
  });

  /**
   * THE HOME STUB MUST STILL STATE THE BOUND (fix round 2, fresh probe H1).
   *
   * `ticketTiers` slices the first four bullets, and bullet 1 is the only place
   * either surface says when the pass stops. Changing the slice to 1..5 drops it
   * from the home page entirely — no string edited, no pin disturbed, and the
   * home page then sells a one-off upgrade with no duration at all. Every guard
   * was green.
   *
   * Asserted as the PROPERTY rather than the slice indices: whatever the stub
   * carries, it must still make the bounded claim.
   */
  it("the home Event Pass stub still says what bounds the pass", () => {
    const [, pass] = ticketTiers("usd");
    expect(pass!.bullets.some((b) => BOUNDED_SCOPE_GRAMMAR.test(b)), pass!.bullets.join(" | ")).toBe(
      true,
    );
    // …and the rule is not vacuous: a stub built from the same array MINUS the
    // duration bullet must fail it.
    expect(PASS_FEATURES.slice(1, 5).some((b) => BOUNDED_SCOPE_GRAMMAR.test(b))).toBe(false);
  });

  it("only the Event Pass glows", () => {
    expect(ticketTiers("usd").map((t) => Boolean(t.glow))).toEqual([false, true, false]);
  });

  // v17 (SPEC-6 A1): the graded per-division run cap became the credit wallet
  // (V322). The dead "10 AI schedule runs per division" bullet must stay gone —
  // the pass's credit story is the dedicated credits line, not a bullet.
  it("the retired AI-run-cap bullet is gone from the Event Pass card", () => {
    expect(PASS_FEATURES.join(" | ")).not.toMatch(/AI schedule runs/i);
    expect(PASS_FEATURES.join(" | ")).not.toMatch(/runs per division/i);
  });

  // The Event Pass credit grant is a one-time top-up with NO ai.credits.monthly
  // row in plan_entitlements, so pricing-cards is its single source. Pin it so
  // the card copy and the wallet grant can't silently diverge.
  //
  // Entitlements v18 W2 T5 (design R9): PER RUNG — 25 on M, 35 on L (W2 T12
  // re-cut L from 50 alongside Pro's monthly grant, owner ruling 2026-09-03).
  // The pin is both figures AND their inequality: a Record whose two values
  // were equal would satisfy every rung-keyed read in the codebase while
  // restoring exactly the flat grant this wave retired.
  it("the Event Pass card quotes a one-time credit grant per rung — 25 on M, 35 on L", () => {
    expect(PASS_CREDIT_GRANT).toEqual({ event_pass: 25, event_pass_l: 35 });
    expect(PASS_CREDIT_GRANT.event_pass_l).toBeGreaterThan(PASS_CREDIT_GRANT.event_pass);
    // Every rung the product can sell has a grant — no rung falls through to a
    // default, because there is deliberately no default to fall through to.
    expect(Object.keys(PASS_CREDIT_GRANT).sort()).toEqual([...PASS_KEYS].sort());
  });

  // v17 #294 — the L rung's $59 price point, per-currency, alongside M's. Both
  // rungs are resolved by `passKey` from the SAME stripe-plans.json `passes`
  // array stripe-sync seeds Stripe from, so a quoted price cannot drift from
  // the price object Stripe holds for that rung.
  it("passPrice resolves both Event Pass rungs, keyed by passKey", () => {
    // Both rungs read from the seed rather than typed: the claim is that
    // `passKey` picks the right ENTRY and `currency` the right point inside it.
    const bySeedKey = (key: string) => stripePlans.passes.find((p) => p.key === key)!.price;
    const m = bySeedKey("event_pass");
    const l = bySeedKey("event_pass_l");
    expect(passPrice("usd", "event_pass")).toBe(m.unit_amount);
    expect(passPrice("usd", "event_pass_l")).toBe(l.unit_amount);
    expect(passPrice("gbp", "event_pass_l")).toBe(l.currency_options.gbp);
    expect(passPrice("eur", "event_pass_l")).toBe(l.currency_options.eur);
    expect(passPrice("inr", "event_pass_l")).toBe(l.currency_options.inr);
    // The rungs must be priced apart, or "keyed by passKey" is unwitnessable.
    expect(m.unit_amount).not.toBe(l.unit_amount);
  });

  // `passKey` is REQUIRED (no default), so a surface that forgets the rung is a
  // compile error rather than a page that quotes $29 for a $59 purchase. The
  // per-currency sweep is what makes that guarantee real: if any currency ever
  // resolved both rungs to the same amount, the picker would render two
  // identical prices and no other test would notice.
  it("quotes a DIFFERENT price for M and L in every supported currency", () => {
    const same = SUPPORTED_CURRENCIES.filter(
      (c) => passPrice(c, "event_pass") === passPrice(c, "event_pass_l"),
    );
    expect(same.join(", ")).toBe("");
    for (const c of SUPPORTED_CURRENCIES) {
      expect(passPrice(c, "event_pass_l"), `${c}: L must quote above M`)
        .toBeGreaterThan(passPrice(c, "event_pass"));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v17 gap wave 7 (#298 / #299) — THE TWO CARD BULLETS THAT CONTRADICTED THE
// MATRIX, and the shape of guard this wave has paid five times to learn.
//
// Two false bullets, from opposite directions:
//
//   PASS_FEATURES[0]      "Upgrades ONE competition, forever" — V328/V334 bind
//                         the pass to the competition's own lifecycle.
//   PLUS_CARD_FEATURES[2] "AI-assisted scheduling", under an "Everything in
//                         Pro, plus…" frame — `scheduling.ai` is true on all
//                         five plan keys, so it differentiated nothing.
//
// ── WHY THE PRIMARY RULE HERE IS A PINNED STRING ─────────────────────────────
// A denylist of phrasings does not work, and this wave measured that five
// times: guards scored 15/15 and 32/32 against probes their own authors wrote,
// then 0/24 and 0/32 against a reviewer's; one went 12/12 to 6/30 on a fresh
// set by the SAME author an hour later. Any rule that reads the sentence scores
// on the examples its author imagined.
//
// So the primary net is an INVENTORY: the approved bullets, pinned verbatim,
// with a `why` naming the code that decides the claim. It cannot be evaded by
// rewording and needs nobody to have imagined the right falsehood. The
// vocabulary (imported from @/lib/copy-truth — never forked) is the SECONDARY
// net, and its recall is measured below against a set written after these rules
// were final, with both numbers committed.
// ─────────────────────────────────────────────────────────────────────────────

/** One card's approved bullet list. */
interface ApprovedBullets {
  /** The exported array, by name. */
  array: string;
  /** What the bullets claim, and the code that decides whether it is true.
   *  A file path, so re-approval means re-reading the code — not re-recording
   *  a snapshot. */
  why: string;
  bullets: readonly string[];
}

const APPROVED_CARD_BULLETS: ApprovedBullets[] = [
  {
    array: "FREE_FEATURES",
    why: "the Community card on /pricing (and, sliced, the home ticket stub). Numbers pinned to the live matrix by CARD_SURFACES below: competitions.max_active, divisions.per_competition.max, entrants.per_division.max and registration.fee_percent, all on plan_key 'community'. The remaining bullets name capabilities community genuinely has (registration.paid, discovery.listed, dashboard.public.max >= 1). W2 (entitlements v18, V392): bullet 1 read '10 active competitions' against a cap V392 re-cut to 3 — the card oversold the free tier threefold. It quotes NO share loop: V395 (owner ruling 2026-09-03) made dashboard.player_profiles, embeds.enabled and news.auto paid on Free, so a bullet naming any of them would sell what the resolver now refuses.",
    bullets: [
      "3 active competitions, 4 divisions",
      "64 entrants per division",
      "League, groups + knockout & swiss formats",
      "Online registration & entry fees (5% fee)",
      "Live standings & public dashboard",
      "Listed on the seazn.club showcase",
    ],
  },
  {
    array: "PASS_FEATURES",
    why: "the Event Pass card on /pricing (and, sliced, the home ticket stub). Bullet 1 is the pass's DURATION — V328/V334 `org_has_feature` drop the pass arm once the competition is archived/completed or 7 days past ends_on, so it is bounded, not permanent; that is asserted by passBulletDurationFaults. BULLET 2 CHANGED 2026-09-05 (owner decision: the L rung comes off sale): it read '10 divisions, 128 entrants each — 20 divisions & 512 entrants on L' and now reads M's ceilings alone, because the second half advertised a size with no checkout behind it. Re-read against the code before re-pinning: plan_entitlements gives event_pass 10 divisions and 128 entrants per division, and registration.fee_percent is 4 on event_pass against 5 on community (V397's additive ladder 5/4/2/1) — both still pinned to the live matrix by CARD_SURFACES below, which now names only the rungs in SELLABLE_PASS_KEYS. The withdrawn rung's own numbers are still checked where that is a claim about the SEED rather than about copy (pricing-matrix.test.ts, entitlements-sql-parity.test.ts), so the dormant matrix cannot rot; capClaimFaults still faults any surface that calls a numeric cap unlimited, which is the rule L's own cap needed after V392 gave it a real 512. Bullets 3 and 5-7 name boolean grants (formats.advanced, exports.branded, dashboard.player_profiles, sponsors.*, realtime) that the pass lifts off community.",
    bullets: [
      "Upgrades ONE competition while it runs",
      "10 divisions, 128 entrants each",
      "Advanced formats — double elim, ladders",
      "4% platform fee on entry fees, not 5%",
      "Branded exports & public player cards",
      "Sponsor tiers & paid sponsorship packages",
      "Realtime scoreboard & slideshow",
    ],
  },
  {
    array: "PRO_FEATURES",
    why: "the Pro card on /pricing (and, sliced, the home ticket stub). Pinned to the live matrix by CARD_SURFACES below: competitions.max_active is null on pro but divisions.per_competition.max is 20 since V392, so the one bullet that covered both rows had to split into 'Unlimited competitions, 20 divisions each'; entrants.per_division.max is 256 and registration.fee_percent is 2. The capability bullets are boolean pro grants (stats.player, scoring.device_links, api.access, exports, dashboard.theme for the club colours (V395 took badge removal off Pro, so the badge bullet became false, and V396 split the accent colour onto its own Pro key — that is what replaced it), officials.auto (V392 brought it down from the deleted Pro Plus), discipline.enforced, news.auto, officials.marks). It must NOT claim a pro_plus-only feature — crossCardExclusivityFaults judges that against the rows. W1 (entitlements v18, owner ruling 2026-08-30): bullet 4 was 'Ball-by-ball & rally scoring, player stats'. V390 deleted scoring.ball_by_ball and scoring.rally_by_rally from plan_entitlements — recording detail is free on every plan — so two thirds of that sentence pointed at no row and sold Community something it already has. Only stats.player survives of the three, and it is what the bullet now names.",
    bullets: [
      "Unlimited competitions, 20 divisions each",
      "256 entrants per division",
      "Entry fees at a 2% platform fee",
      "Player stats & scorecards",
      "Officials, exports, API keys, device links",
      "Your club colours on public pages & slideshow",
      "Suspensions & discipline tracking",
      "Auto officials assignment & ratings",
      "Auto-drafted result posts",
    ],
  },
  // The `PLUS_CARD_FEATURES` and `PLUS_COMING_SOON` entries were DELETED here in
  // W2 (entitlements v18) with the arrays themselves — see the note in
  // lib/pricing-cards.ts. Both described the Pro Plus card, a card `/pricing`
  // stopped rendering and a plan V392 deleted from `plans`. The roadmap
  // inventory was the only thing standing between a one-word edit and eight
  // undelivered features reading as shipped, and that argument still holds for
  // the `pricing.plus.soon1-8` DICTIONARY keys — which is why those stay
  // approved in `_approved-dictionary-copy.ts` (four locales) rather than
  // following the arrays out. Nothing renders them; pruning them is W3's.
];

const LIVE_CARD_BULLETS: Record<string, readonly string[]> = {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
};

/**
 * The gate, as a pure fault-returning function so "prove it by rewording" is a
 * committed test rather than a manual check that happened once.
 *
 * An approved entry naming an array that does not exist is a fault of its own —
 * otherwise renaming the export would leave this gate examining nothing and
 * reporting clean, which is the exact failure this wave found five times.
 */
function approvedBulletFaults(
  approved: ApprovedBullets[],
  live: Record<string, readonly string[]>,
): string[] {
  if (approved.length === 0) return ["the approved-bullet inventory is empty — this gate examines nothing"];
  const faults: string[] = [];
  for (const entry of approved) {
    const onDisk = live[entry.array];
    if (!onDisk) {
      faults.push(`${entry.array}: approved but no such export — the gate is pointing at nothing`);
      continue;
    }
    if (onDisk.length !== entry.bullets.length) {
      faults.push(
        `${entry.array}: ${onDisk.length} bullets on disk, ${entry.bullets.length} approved`,
      );
    }
    for (let i = 0; i < Math.max(onDisk.length, entry.bullets.length); i += 1) {
      const want = entry.bullets[i];
      const got = onDisk[i];
      if (want === got) continue;
      faults.push(
        [
          `${entry.array}[${i}]: wording changed and has not been re-approved.`,
          `  what it claims: ${entry.why}`,
          `  approved: ${want ?? "(no bullet)"}`,
          `  on disk:  ${got ?? "(no bullet)"}`,
        ].join("\n"),
      );
    }
  }
  return faults;
}

/**
 * The SECONDARY net for the pass card's duration claim, both halves at once.
 *
 * Absence alone proves "not false", never "still stated": bullet 1 is the only
 * place the /pricing pass card says anything about when the upgrade stops, so a
 * reword that simply deletes the qualifier would leave a buyer told nothing —
 * and would pass an absence-shaped rule. Hence the positive half.
 *
 * Both patterns are IMPORTED. `FALSE_PASS_PERMANENCE_PATTERNS` and
 * `BOUNDED_SCOPE_GRAMMAR` are the same rules the Stripe seed, the help tree and
 * the four dictionaries are held to, so a pattern added for any of them covers
 * this card the same day.
 */
function passBulletDurationFaults(bullets: readonly string[]): string[] {
  const faults: string[] = [];
  if (bullets.length === 0) return ["no bullets — nothing to scan, so every rule below passes vacuously"];
  // Joined with ". " so a claim cannot reach across two bullets: every window in
  // the imported vocabulary is bounded by sentence punctuation, and a reader
  // reads each bullet as its own statement.
  const joined = bullets.join(". ");
  for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
    if (pattern.test(joined)) faults.push(`claims unbounded duration (${pattern.source})`);
  }
  if (!bullets.some((b) => BOUNDED_SCOPE_GRAMMAR.test(b))) {
    faults.push("no bullet states the pass is bounded to a running competition");
  }
  return faults;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX ROUND 1 (I2) — THE CARD'S NUMBERS, PINNED TO THE MATRIX AND NOT TO A
// SECOND COPY OF THEMSELVES.
//
// The inventory above is copy↔copy. That is the right primary net against an
// EDIT, and it is worth nothing against a MIGRATION: with the numbers pinned
// only to a literal in a test, moving `members.max` from null to 500 left
// "Unlimited members, teams & clubs" green, and so did moving every fee
// percentage on every card. Measured against a 10-probe battery of falsehoods
// that keep every true string: 1 caught.
//
// Worse, four of those probes LOOKED caught. `pricing-cards.test.ts` also
// carries the help-article suites (plans.md's fee-ladder table, add-a-division),
// which do read the matrix — so a fee move redded the file while the card was
// guarded by nothing. A red in the file is not a red on the surface, and that is
// the vacuity trap this wave keeps paying for.
//
// So: a DECLARATIVE claim table, iterated. A literal in a test is a second copy
// of the claim, not a check of it — the same lesson task 1 applied to the Stripe
// seed with `capFor(cap, rung.key)`.
// ─────────────────────────────────────────────────────────────────────────────

/** `plan_entitlements.int_value`, by feature and plan. `null` means unlimited;
 *  a MISSING plan key means no row at all, which is a fault, not "unlimited". */
type Matrix = Record<string, Record<string, number | null>>;

interface CardClaim {
  /** `plan_entitlements.feature_key`. */
  feature: string;
  /** The `plan_key` this bullet is making the claim ABOUT — not necessarily the
   *  card's own plan: the pass card quotes community's 8% as its comparator. */
  plan: string;
  /** How the bullets must render a NUMERIC value. Built from the live value, so
   *  a matrix move changes what is required rather than what is compared. */
  says: (value: number) => RegExp;
  /** How they must render a NULL (unlimited) value. Absent means the card has no
   *  approved wording for "unlimited", so a null value is itself a fault. */
  unlimited?: RegExp;
  /**
   * Plans this claim asserts do NOT have the same allowance.
   *
   * Only meaningful under the "Everything in Pro, plus…" frame: "Unlimited
   * members, teams & clubs" is not merely a fact about pro_plus, it is a claim
   * that Pro is capped. Moving `members.max` on PRO to null makes the Plus
   * card's bullet stop differentiating anything, with every string on both
   * cards still word-for-word true (fresh probe G6).
   *
   * `containmentFaults` reads the SAME list in the other direction — see there
   * for why one field has to serve both.
   */
  exclusiveAgainst?: string[];
  /**
   * Which way is BETTER for the buyer. Default "higher" — an allowance.
   *
   * `registration.fee_percent` is the exception and the containment rule found
   * it on its first run: pro is 2% and pro_plus is 1%, so a naive "the higher
   * plan's number must be at least the lower plan's" reported the true
   * arrangement as a broken containment claim. A rate is a COST; containing it
   * means charging no MORE.
   */
  betterWhen?: "higher" | "lower";
}

/**
 * A CAPABILITY bullet: "we do X on this plan", against the boolean row.
 *
 * Added after the numeric pins, because a FRESH probe set written once those
 * were final scored 1/10 against them — every miss was a capability bullet.
 * `dashboard.branding` going false on pro while the Pro card still promises
 * "Remove the Powered by Seazn badge" is the same falsehood class as a moved
 * cap, and it was invisible: nothing on any card read a boolean row except the
 * four in `PLUS_DIFFERENTIATOR_VOCAB`.
 */
interface CardBooleanClaim {
  feature: string;
  /** EVERY plan the card sells. The Event Pass card sells two rungs out of one
   *  bullet list, and naming only `event_pass` let `formats.advanced` go false
   *  on `event_pass_l` with the card still promising advanced formats to an L
   *  buyer (measured — fresh probe G1). */
  plans: string[];
  /** The bullet that asserts it. Required to MATCH the shipped copy — see
   *  `cardBooleanFaults` for why that is the positive half and not a formality. */
  says: RegExp;
  /** For INT-shaped capabilities: the bullet is true while the row is null
   *  (unlimited) or at least this. `dashboard.public.max` going 1 -> 0 makes
   *  "Live standings & public dashboard" false without any boolean moving. */
  atLeast?: number;
}

/** One `plan_entitlements` row, both columns, because a capability can be
 *  expressed either way and the card cannot tell which. */
interface EntitlementRow {
  bool: boolean | null;
  int: number | null;
}
type RowsByFeature = Record<string, Record<string, EntitlementRow>>;

interface CardSurface {
  array: string;
  /** The `plan_key` this card sells, for the cross-card exclusivity rule.
   *  `null` for a surface that sells no plan (the roadmap). */
  plan: string | null;
  claims: CardClaim[];
  booleans?: CardBooleanClaim[];
  /** Required when `claims` is empty: why this surface quotes no matrix value.
   *  An undocumented empty table is the omission that hid the roadmap block. */
  noMatrixClaims?: string;
  /**
   * Bullets attributed to NO matrix row, each with its reason.
   *
   * ── WHY THIS FIELD EXISTS ────────────────────────────────────────────────
   * Everything above is a HAND-WRITTEN LIST, and a hand-written list is the
   * thing that silently stops covering something — v17 #293 lost `org_addons`
   * from the seed guard's section list for a whole wave exactly this way.
   *
   * Measured here: once the numeric and capability pins were final, a FRESH
   * probe set scored 1/10, and five of the misses were simply bullets nobody
   * had thought to enumerate (`exports` on Pro, `registration.enabled` and
   * `dashboard.public.max` on Community, `clubs.hierarchy` on Pro Plus, and the
   * L rung on the Pass card). No additional pattern fixes that. Only making the
   * ENUMERATION ITSELF checkable does.
   *
   * `cardBulletAttributionFaults` therefore requires every bullet to be claimed
   * by some rule or listed here: forgetting one is a red, and exempting one is a
   * decision with a reason attached.
   */
  unclaimed?: Record<string, string>;
}

/** Every rung the Event Pass card sells out of ONE bullet list. */
/** The rungs the Event Pass CARD sells — the sellable set, not every rung
 *  (owner decision 2026-09-05 took the L rung off sale).
 *
 *  These entries judge SHIPPED COPY, so their subject is what the card offers.
 *  Keeping a withdrawn rung here would red the card for a rung it no longer
 *  mentions, which is a false alarm about a real page. The dormant rung's own
 *  matrix is still checked, in the two places where that is a claim about the
 *  SEED rather than about copy: `entitlements-sql-parity.test.ts`'s
 *  full-outer-join diff (every key must exist on both rungs, with exactly two
 *  documented overrides) and `pricing-matrix.test.ts`'s live-ladder cases. */
const PASS_RUNGS = [...SELLABLE_PASS_KEYS];

const CARD_SURFACES: CardSurface[] = [
  {
    array: "FREE_FEATURES",
    plan: "community",
    claims: [
      { feature: "competitions.max_active", plan: "community", says: (n) => new RegExp(`\\b${n}\\s+active\\s+competitions\\b`, "i") },
      { feature: "divisions.per_competition.max", plan: "community", says: (n) => new RegExp(`\\b${n}\\s+divisions\\b`, "i") },
      { feature: "entrants.per_division.max", plan: "community", says: (n) => new RegExp(`\\b${n}\\s+entrants\\s+per\\s+division\\b`, "i") },
      { feature: "registration.fee_percent", plan: "community", says: (n) => new RegExp(`\\(${n}%\\s+fee\\)`, "i") },
    ],
    booleans: [
      { feature: "registration.paid", plans: ["community"], says: /\bonline registration & entry fees\b/i },
      { feature: "registration.enabled", plans: ["community"], says: /\bonline registration\b/i },
      { feature: "discovery.listed", plans: ["community"], says: /\blisted on the seazn\.club showcase\b/i },
      // INT-shaped: "public dashboard" is true while the org may publish at
      // least one. 1 -> 0 makes the bullet false with no boolean moving.
      { feature: "dashboard.public.max", plans: ["community"], says: /\bpublic dashboard\b/i, atLeast: 1 },
    ],
    unclaimed: {
      // Found by the residue check the moment attribution became per-claim:
      // "public dashboard" was covered by dashboard.public.max while "Live
      // standings" beside it was covered by nothing.
      "Live standings":
        "the standings table is core engine output (packages/engine), produced on every plan and gated by no row. The GATED standings features are `standings.carry_over` and `standings.custom_points`, both Pro-only, and neither is claimed on this card.",
      "League, groups + knockout & swiss formats":
        "the base formats are the engine's own repertoire (packages/engine), not a plan_entitlements row — `formats.advanced` and `formats.double_elim` are the GATED ones and are claimed on the Pass card. Nothing here is plan-conditional.",
    },
  },
  {
    array: "PASS_FEATURES",
    plan: "event_pass",
    claims: [
      { feature: "divisions.per_competition.max", plan: "event_pass", says: (n) => new RegExp(`\\b${n}\\s+divisions\\b`, "i") },
      { feature: "entrants.per_division.max", plan: "event_pass", says: (n) => new RegExp(`\\b${n}\\s+entrants\\s+each\\b`, "i") },
      { feature: "registration.fee_percent", plan: "event_pass", betterWhen: "lower", says: (n) => new RegExp(`\\b${n}%\\s+platform\\s+fee\\b`, "i") },
      // The `event_pass_l` twin of the line above was DROPPED on 2026-09-05
      // with the rung's sale. It existed because one bullet sold both rungs, so
      // both had to charge what it quoted (fix round 2: L's fee was card-guarded
      // by nothing — moving it 5 -> 8 red only the help article, never the card
      // selling it). The card no longer sells L, so the claim is no longer a
      // claim about L; L's own 4% is pinned against the matrix by
      // `pricing-matrix.test.ts`'s fee-ladder case and by the help article's
      // fee table, whose `FEE_LADDER_PLAN_KEYS["Event Pass"]` still names both
      // rungs.
      // The comparator the same bullet makes: "…not 5%". It is a claim about
      // COMMUNITY's rate sitting on the pass card, and it goes stale the moment
      // community's fee moves — which is exactly what F5 of the battery did.
      { feature: "registration.fee_percent", plan: "community", says: (n) => new RegExp(`\\bnot\\s+${n}%`, "i") },
      // The two `event_pass_l` CAP claims went with the rung's sale on
      // 2026-09-05. They pinned the "— 20 divisions & 512 entrants on L" half
      // of bullet 2, and that half is gone from the copy: the card would
      // otherwise advertise, in figures, a size no checkout will sell.
      //
      // Worth keeping the history, because it is the shape to restore if the
      // rung goes back on sale rather than one to reinvent: L's entrant cap was
      // NULL, so the copy said so in words (a null cap with a number beside it
      // is M's ceiling sold to an L buyer, the defect v17 #294 was filed for);
      // V392 then gave L a real 512, and the divisions half — pinned until then
      // by a single `20 & unlimited` regex reading BOTH rungs out of one phrase
      // — could not survive the word going away. Each rung's number ended up
      // matched on its own, scoped to "on L" so M's figures could not satisfy
      // it. `capClaimFaults` still faults any surface that calls a numeric cap
      // unlimited, whichever rung it is about.
    ],
    // Every rung the card SELLS — `PASS_RUNGS` above, which is the sellable
    // set. A capability that went false on a rung this list sells still
    // misleads a buyer (fresh probe G1, missed when these named `event_pass`
    // only); one that goes false on a withdrawn rung misleads nobody, because
    // nothing on this card is offering it.
    booleans: [
      { feature: "formats.advanced", plans: PASS_RUNGS, says: /\badvanced formats\b/i },
      { feature: "formats.double_elim", plans: PASS_RUNGS, says: /\bdouble elim\b/i },
      { feature: "exports.branded", plans: PASS_RUNGS, says: /\bbranded exports\b/i },
      { feature: "dashboard.player_profiles", plans: PASS_RUNGS, says: /\bpublic player cards\b/i },
      { feature: "sponsors.tiers", plans: PASS_RUNGS, says: /\bsponsor tiers\b/i },
      { feature: "sponsors.monetize", plans: PASS_RUNGS, says: /\bpaid sponsorship packages\b/i },
      { feature: "realtime", plans: PASS_RUNGS, says: /\brealtime scoreboard\b/i },
    ],
    unclaimed: {
      "Upgrades ONE competition while it runs":
        "the pass's DURATION, not a feature grant. V328/V334 `org_has_feature` decide it and `passBulletDurationFaults` asserts both halves of it — the permanence vocabulary and the required bound.",
    },
  },
  {
    array: "PRO_FEATURES",
    plan: "pro",
    claims: [
      {
        feature: "competitions.max_active",
        plan: "pro",
        says: (n) => new RegExp(`\\b${n}\\s+(?:active\\s+)?competitions\\b`, "i"),
        unlimited: /\bunlimited\s+competitions\b/i,
      },
      {
        // V392 capped Pro at 20 divisions per competition; `competitions.max_active`
        // is still null. The bullet that covered both rows with one "Unlimited
        // competitions & divisions" therefore had to split, and the `unlimited`
        // alternative goes with it — leaving it would let the word satisfy a
        // row that now holds a number.
        feature: "divisions.per_competition.max",
        plan: "pro",
        says: (n) => new RegExp(`\\b${n}\\s+divisions\\b`, "i"),
      },
      { feature: "entrants.per_division.max", plan: "pro", says: (n) => new RegExp(`\\b${n}\\s+entrants\\s+per\\s+division\\b`, "i") },
      { feature: "registration.fee_percent", plan: "pro", betterWhen: "lower", says: (n) => new RegExp(`\\b${n}%\\s+platform\\s+fee\\b`, "i") },
    ],
    booleans: [
      // W1 (entitlements v18, owner ruling 2026-08-30): the `scoring.ball_by_ball`
      // and `scoring.rally_by_rally` claims are GONE, not reworded — V390 deleted
      // both rows from `plan_entitlements`, so the Pro card can no longer promise
      // either. `stats.player` is what is left of that bullet, and it is real.
      { feature: "stats.player", plans: ["pro"], says: /\bplayer stats\b/i },
      { feature: "api.access", plans: ["pro"], says: /\bAPI keys\b/i },
      { feature: "scoring.device_links", plans: ["pro"], says: /\bdevice links\b/i },
      // The same bullet names four things; each is its own row, and `exports`
      // and `officials.marks` were missed when only two of the four were pinned.
      { feature: "exports", plans: ["pro"], says: /\bofficials, exports\b/i },
      { feature: "officials.marks", plans: ["pro"], says: /\bofficials, exports\b/i },
      // WAS the badge bullet, `dashboard.branding`. V395 (W2 T15) made badge
      // removal enterprise-only — Pro carries the badge now — so that claim
      // became false on the card selling it, which is exactly the falsehood
      // class this rule was built for. V396 split the accent COLOUR onto
      // `dashboard.theme`, which Pro does grant, and that is the bullet's
      // subject now.
      { feature: "dashboard.theme", plans: ["pro"], says: /\byour club colours on public pages\b/i },
      { feature: "discipline.enforced", plans: ["pro"], says: /\bsuspensions & discipline tracking\b/i },
      // ONE bullet, TWO rows. V392 brought `officials.auto` down from the
      // deleted Pro Plus to Pro, so the Pro card can say it for the first time
      // — and `crossCardExclusivityFaults` needs at least one card to make a
      // claim its vocabulary recognises, or that rule examines nothing.
      { feature: "officials.auto", plans: ["pro"], says: /\bauto officials assignment\b/i },
      { feature: "officials.marks", plans: ["pro"], says: /\bauto officials assignment & ratings\b/i },
      { feature: "news.auto", plans: ["pro"], says: /\bauto-drafted result posts\b/i },
    ],
  },
  // The `PLUS_CARD_FEATURES` and `PLUS_COMING_SOON` surfaces were DELETED here
  // in W2 (entitlements v18), with the arrays. Between them they declared nine
  // claims against `pro_plus` rows, and V392 deleted every one of those rows —
  // so the guards went on reporting five live falsehoods ("promises
  // support.priority, but pro_plus does not grant it") about a card nobody can
  // open. A guard whose subject is gone does not go quiet; it goes loud about
  // nothing, and buries the ones still telling the truth.
];

/**
 * Every number a card quotes, against the row that decides it.
 *
 * Both directions are faults, which is the point:
 *  - a numeric row the copy does not quote (the matrix moved under the copy);
 *  - a numeric row while the copy says "unlimited" (the cap arrived and the
 *    copy still promises none) — the F1 probe, and the one that reads most
 *    plausibly in review;
 *  - a null row the copy never calls unlimited, or has no wording for at all.
 *
 * A MISSING row is a fault too. `?? null` would read "no row" as "unlimited"
 * and quietly certify a card against a feature key that no longer exists.
 */
function cardMatrixFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  matrix: Matrix,
): string[] {
  if (surfaces.length === 0) return ["no card surfaces — this rule examines nothing"];
  const faults: string[] = [];
  let claimsChecked = 0;

  for (const surface of surfaces) {
    const bullets = live[surface.array];
    if (!bullets) {
      faults.push(`${surface.array}: no such export — its matrix claims are pinned to nothing`);
      continue;
    }
    if (surface.claims.length === 0) {
      if (!surface.noMatrixClaims) {
        faults.push(
          `${surface.array}: quotes no matrix value and gives no reason — an empty claim table must be a decision, not a silence`,
        );
      }
      continue;
    }
    const joined = bullets.join(". ");
    for (const claim of surface.claims) {
      const row = matrix[claim.feature];
      if (!row || !(claim.plan in row)) {
        faults.push(
          `${surface.array}: plan_entitlements has no ${claim.plan}/${claim.feature} row — the bullet is pinned to nothing`,
        );
        continue;
      }
      claimsChecked += 1;
      const value = row[claim.plan]!;
      if (value === null) {
        if (!claim.unlimited) {
          faults.push(
            `${surface.array}: ${claim.plan}/${claim.feature} is unlimited but this card has no approved wording for an unlimited value`,
          );
        } else if (!claim.unlimited.test(joined)) {
          faults.push(
            `${surface.array}: ${claim.plan}/${claim.feature} is unlimited but the card never says so`,
          );
        }
        // …and, under an exclusivity frame, that the lower plans are NOT also
        // unlimited. Without this the bullet can quietly stop differentiating
        // anything while every string on both cards stays true.
        for (const lower of claim.exclusiveAgainst ?? []) {
          if (claim.plan in row && lower in row && row[lower] === null) {
            faults.push(
              `${surface.array}: sells unlimited ${claim.feature} as a differentiator, but ${lower} is unlimited too`,
            );
          }
        }
        continue;
      }
      if (claim.unlimited?.test(joined)) {
        faults.push(
          `${surface.array}: card claims UNLIMITED ${claim.feature}, but the matrix caps ${claim.plan} at ${value}`,
        );
      }
      if (!claim.says(value).test(joined)) {
        faults.push(
          `${surface.array}: does not quote the live ${claim.plan}/${claim.feature} (${value}) — expected ${claim.says(value).source}`,
        );
      }
    }
  }

  if (claimsChecked === 0) {
    faults.push("no claim resolved a live row — this rule compared the cards against nothing");
  }
  return faults;
}

/**
 * Every CAPABILITY a card promises, against the boolean row that grants it.
 *
 * BOTH HALVES, and the positive one is what stops this rotting:
 *  - the bullet the claim describes must still BE on the card. A claim whose
 *    regex matches nothing is a pin examining nothing, and it would go on
 *    reporting clean forever after the bullet it named was reworded away;
 *  - and the plan must actually grant it.
 *
 * Deliberately one-directional on the other axis: a card need not list every
 * boolean its plan has. Requiring that would red every time a migration added a
 * feature, which is not a copy defect.
 */
function cardBooleanFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  rows: RowsByFeature,
): string[] {
  const faults: string[] = [];
  let checked = 0;
  for (const surface of surfaces) {
    const bullets = live[surface.array];
    if (!bullets || !surface.booleans) continue;
    const joined = bullets.join(". ");
    for (const claim of surface.booleans) {
      if (!claim.says.test(joined)) {
        faults.push(
          `${surface.array}: no bullet matches ${claim.says.source} — the copy this ${claim.feature} pin describes is gone, so the pin examines nothing`,
        );
        continue;
      }
      for (const plan of claim.plans) {
        const row = rows[claim.feature]?.[plan];
        if (!row) {
          faults.push(
            `${surface.array}: plan_entitlements has no ${plan}/${claim.feature} row — the bullet is pinned to nothing`,
          );
          continue;
        }
        checked += 1;
        // INT-shaped capability: null is unlimited, otherwise it must clear the
        // floor the bullet implies.
        if (claim.atLeast !== undefined) {
          if (row.int !== null && row.int < claim.atLeast) {
            faults.push(
              `${surface.array}: promises ${claim.feature}, but ${plan} allows only ${row.int}`,
            );
          }
          continue;
        }
        if (row.bool !== true) {
          faults.push(
            `${surface.array}: promises ${claim.feature}, but ${plan} does not grant it`,
          );
        }
      }
    }
  }
  if (checked === 0) {
    faults.push("no capability claim matched a bullet — this rule examined nothing");
  }
  return faults;
}

/**
 * ── THE RULE THAT MAKES THE OTHER RULES CHECKABLE ────────────────────────────
 *
 * Every bullet on every card must be ATTRIBUTED: matched by a numeric claim, a
 * capability claim, the duration grammar, or the differentiator vocabulary — or
 * else listed in `unclaimed` with a reason.
 *
 * This exists because everything above is a hand-written list, and the measured
 * failure of a hand-written list is not that its rules are weak but that it
 * silently stops covering something. A fresh probe set written after the
 * numeric and capability pins were final scored 1/10, and five of the nine
 * misses were bullets nobody had enumerated. Adding five more entries fixes
 * those five; making the enumeration self-checking fixes the class.
 *
 * A STALE exemption is a fault too: an `unclaimed` key naming a bullet that no
 * longer exists is an exemption doing nothing, which is how a list rots back
 * into silence.
 */
/**
 * The vocabulary a CLAIM is made in, derived from the feature keys themselves.
 *
 * Not a hand-written noun list: the tokens are the `plan_entitlements`
 * feature_key segments the cards actually declare, so a new feature brings its
 * own word with it. Stopwords are the structural halves of a key (`per`, `max`,
 * `enabled`) that carry no marketing meaning.
 */
const CLAIM_TOKEN_STOPWORDS = new Set([
  "per", "max", "min", "value", "enabled", "monthly", "percent", "hierarchy", "public", "listed",
]);

/**
 * A lexicon token matches a residue word if either is a PREFIX of the other.
 *
 * `\b${token}` alone was prefix-match in ONE direction, so the lexicon's
 * `credits` never matched the copy's `credit` — "Largest monthly AI credit
 * grant" appended to PRO_FEATURES was green (measured). Stemming both ways
 * costs nothing and covers singular/plural in either position.
 */
function tokenMatchesResidue(token: string, residue: string): boolean {
  const stem = token.slice(0, Math.max(4, token.length - 1));
  return new RegExp(`\\b${stem}`, "i").test(residue);
}

function claimTokens(allFeatureKeys: string[]): string[] {
  // EVERY feature key in plan_entitlements, not merely the ones a card happens
  // to declare. Deriving the lexicon from the declared subset made the rule
  // circular: a bullet naming a feature nobody had declared contained no
  // recognised token and sailed through, which is the exact hole this rule
  // exists to close ("Custom domain & white-label" on the Pro card).
  const fromFeatures = allFeatureKeys
    .flatMap((feature) => feature.split(/[._]/))
    .filter((word) => word.length >= 4 && !CLAIM_TOKEN_STOPWORDS.has(word));
  // Quantity words are claims in their own right and belong to no feature key.
  return [...new Set([...fromFeatures, "unlimited"])];
}

/**
 * ── ATTRIBUTION, PER CLAIM RATHER THAN PER BULLET (fix round 2, blocking 3) ──
 *
 * Round 1 accepted a bullet the moment ANY declared claim matched a FRAGMENT of
 * it, so a second claim could ride along inside the same bullet untouched.
 * Measured 0/3 by the reviewer, and every miss is a sentence a marketer would
 * plausibly write:
 *
 *   Pro card       "Unlimited entrants while your competition runs"
 *                  — attributed by BOUNDED_SCOPE_GRAMMAR; pro caps at 256.
 *   Community card "Branded exports on your public dashboard"
 *                  — attributed by the dashboard.public.max regex;
 *                    `exports.branded` is FALSE on community.
 *   Community card "64 entrants per division, with unlimited clubs & teams"
 *                  — attributed by says(64); `clubs.max` on community is 5.
 *
 * The fix is a RESIDUE check. Blank out every span a declared claim (or a
 * recorded exemption) actually matches, then require the leftovers to contain no
 * claim vocabulary. A claim cannot hide behind its neighbour, because its own
 * words are still sitting in the residue.
 *
 * `BOUNDED_SCOPE_GRAMMAR` and `PLUS_DIFFERENTIATOR_VOCAB` are NO LONGER blanket
 * attributors — they attributed whole bullets while proving nothing about the
 * numbers in them, which is how the first two misses passed.
 */
function cardBulletAttributionFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  matrix: Matrix,
  allFeatureKeys: string[],
): string[] {
  const faults: string[] = [];
  const tokens = claimTokens(allFeatureKeys);
  if (tokens.length < 10) return ["the claim vocabulary is nearly empty — this rule examines nothing"];

  for (const surface of surfaces) {
    const bullets = live[surface.array];
    if (!bullets) continue;
    const exemptions = surface.unclaimed ?? {};

    for (const [phrase, why] of Object.entries(exemptions)) {
      if (!bullets.some((b) => b.includes(phrase))) {
        faults.push(
          `${surface.array}: "${phrase}" is exempted but appears in no bullet — a stale exemption covers nothing`,
        );
      }
      if (why.length <= 20) {
        faults.push(`${surface.array}: "${phrase}" has an empty exemption reason`);
      }
    }
    // A surface that quotes no matrix value at all (the roadmap) is exempt
    // wholesale, with the reason recorded on `noMatrixClaims`.
    if (surface.claims.length === 0 && surface.noMatrixClaims) continue;

    for (const bullet of bullets) {
      // Every pattern that genuinely matches THIS bullet, blanked out of it.
      const patterns: RegExp[] = [];
      for (const claim of surface.claims) {
        const value = matrix[claim.feature]?.[claim.plan];
        if (value === undefined) continue;
        if (value !== null) patterns.push(claim.says(value));
        if (claim.unlimited) patterns.push(claim.unlimited);
      }
      for (const claim of surface.booleans ?? []) patterns.push(claim.says);

      // Spans are collected against the ORIGINAL bullet and blanked afterwards.
      // Blanking sequentially made the rule ORDER-DEPENDENT: `competitions`'
      // "Unlimited competitions" erased the prefix that `divisions`' own
      // "Unlimited competitions & divisions" needed, so a correctly declared
      // claim reported as unattributed. Overlapping claims are normal — three
      // rows sit behind "Unlimited members, teams & clubs".
      const covered: boolean[] = new Array(bullet.length).fill(false);
      const mark = (pattern: RegExp) => {
        const global = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
        for (const match of bullet.matchAll(global)) {
          const at = match.index ?? 0;
          for (let i = at; i < at + match[0].length; i += 1) covered[i] = true;
        }
      };
      for (const pattern of patterns) mark(pattern);
      for (const phrase of Object.keys(exemptions)) {
        let at = bullet.indexOf(phrase);
        while (at !== -1) {
          for (let i = at; i < at + phrase.length; i += 1) covered[i] = true;
          at = bullet.indexOf(phrase, at + 1);
        }
      }
      const residue = [...bullet].map((ch, i) => (covered[i] ? " " : ch)).join("");
      const matchedSomething = covered.some(Boolean);

      // ── CONJOIN, DO NOT REPLACE (fix round 3, blocking 1) ─────────────────
      // Round 2 replaced "any unattributed bullet is a fault" with "a residue
      // carrying a known token is a fault". That was a NET REGRESSION, proved
      // at the parent commit: seven probes redded before the change and were
      // green after it — "Run as many events at once as you like" on Community
      // (which caps at 10 two bullets above), "Round-the-clock phone helpline"
      // and "Your own dedicated success manager" on Pro, and four more. Each
      // makes a plan claim in words no feature key happens to contain, so the
      // lexicon sees nothing and the residue rule shrugs.
      //
      // The lexicon catches a claim about a feature we HAVE. The completeness
      // rule catches a claim about anything else. Both, always.
      const leftover = tokens.filter((token) => tokenMatchesResidue(token, residue));
      if (leftover.length > 0) {
        faults.push(
          `${surface.array}: "${bullet}" makes an unattributed claim about ${leftover.join(", ")} — the words "${residue.replace(/\s+/g, " ").trim()}" are matched by no declared claim and by no recorded exemption`,
        );
        continue;
      }
      if (!matchedSomething) {
        faults.push(
          `${surface.array}: "${bullet}" is attributed to no matrix row and is not exempted — every bullet must be a claim someone checked or a decision someone recorded`,
        );
      }
    }
  }
  return faults;
}

// `containmentFaults` was DELETED here in W2 (entitlements v18). It judged the
// "Everything in Pro, plus…" frame in the direction nobody else guarded — a
// HIGHER plan quietly losing something the card one column left still promises
// — and it was scoped to `pricing.plus.note`, a frame `/pricing` no longer
// renders for a plan V392 deleted. Enterprise is a Contact-us strip, not a
// column that claims to contain Pro, so there is no superset frame left to
// enforce. If W3 gives the enterprise strip a "everything in Pro, plus…"
// sentence, this rule is what it owes.

/**
 * FIX ROUND 1 (I4) — THE CARDS, AGAINST EACH OTHER.
 *
 * A bullet can be true of the card it is on and false against the card beside
 * it. That is the class that pulled `PLUS_CARD_FEATURES` into this task's scope
 * in the first place — the FAQ dropped "AI-assisted scheduling" while the card
 * above went on selling it — and it was still open in the other direction:
 * appending "Auto officials assignment" to `PRO_FEATURES` was green, which would
 * have the Pro card claim the exact feature the Plus card sells as its
 * exclusive.
 *
 * Judged against the ROWS, not against a banned phrase, so it falls silent the
 * day a migration grants the feature lower down — and that is exactly what
 * happened. V392 deleted Pro Plus and moved `officials.auto` down to Pro, so
 * the Pro card now carries that bullet and this rule reports it clean. The
 * probe below still reds when the grant is taken away underneath it, which is
 * the only thing that makes the silence mean anything.
 */
function crossCardExclusivityFaults(
  surfaces: CardSurface[],
  live: Record<string, readonly string[]>,
  grants: FeatureGrants,
): string[] {
  const faults: string[] = [];
  let recognised = 0;
  for (const surface of surfaces) {
    if (surface.plan === null) continue;
    const bullets = live[surface.array];
    if (!bullets) continue;
    const joined = bullets.join(". ");
    for (const [feature, claim] of EXCLUSIVE_CLAIM_VOCAB) {
      if (!claim.test(joined)) continue;
      recognised += 1;
      const row = grants[feature];
      if (!row) {
        faults.push(`${surface.array}: claims ${feature}, which has no rows in plan_entitlements`);
        continue;
      }
      if (!row[surface.plan]) {
        faults.push(
          `${surface.array}: the ${surface.plan} card claims ${feature}, but ${surface.plan} does not grant it — and the Pro Plus card sells it as exclusive`,
        );
      }
    }
  }
  // Anti-vacuity. The Pro card matches one entry today (`officials.auto`,
  // brought down from the deleted Pro Plus by V392); a vocabulary that
  // stopped matching anything would have this rule examine nothing and report
  // clean, which is how five guards in this wave were found inert.
  if (recognised === 0) {
    faults.push(
      "no card matched any differentiator vocabulary — this rule examined nothing",
    );
  }
  return faults;
}

describe("the /pricing card bullets say what plan_entitlements enforces", () => {
  // THE GATE, first, because it is the rule that does not depend on anyone
  // having imagined the right falsehood.
  it("matches the approved wording, bullet for bullet", () => {
    expect(approvedBulletFaults(APPROVED_CARD_BULLETS, LIVE_CARD_BULLETS)).toEqual([]);
  });

  /**
   * …and it covers EVERY array `/pricing` renders as a claim.
   *
   * FIX ROUND 1 (I3). The previous round listed exactly two arrays here, which
   * did not merely forget the other three — it CODIFIED the omission, so the
   * assertion that was supposed to prove coverage was the thing certifying the
   * gap. `FREE_FEATURES`, `PRO_FEATURES` and the whole `PLUS_COMING_SOON`
   * roadmap were outside every rule in the file.
   *
   * The list is derived from the module's own exports rather than typed out
   * again, so an array added to `pricing-cards.ts` reds here until someone
   * decides whether it makes a claim.
   *
   * FIVE became THREE in W2 (entitlements v18): `PLUS_CARD_FEATURES` and
   * `PLUS_COMING_SOON` went with the Pro Plus card. The count is asserted as
   * well as derived, for the reason it always was — deriving both sides from
   * the same exports makes this a tautology, and the number is what catches an
   * array being quietly DROPPED as well as one being added.
   */
  it("pins every card array pricing-cards.ts exports", async () => {
    const cards: Record<string, unknown> = await import("../pricing-cards");
    const exportedArrays = Object.entries(cards)
      .filter(([, v]) => Array.isArray(v) && v.every((x) => typeof x === "string"))
      .map(([k]) => k)
      .sort();
    expect(exportedArrays.length, "found no string arrays — the module's shape changed").toBe(3);
    expect(APPROVED_CARD_BULLETS.map((e) => e.array).sort()).toEqual(exportedArrays);
    expect(CARD_SURFACES.map((s) => s.array).sort()).toEqual(exportedArrays);
    for (const entry of APPROVED_CARD_BULLETS) {
      expect(entry.why.length, `${entry.array} has no source-of-truth note`).toBeGreaterThan(40);
      expect(entry.bullets.length, `${entry.array} has no bullets`).toBeGreaterThan(3);
    }
  });

  // THE PASS BULLET, by vocabulary as well — the secondary net.
  it("never sells the Event Pass as permanent, and still says what bounds it", () => {
    expect(passBulletDurationFaults(PASS_FEATURES)).toEqual([]);
  });

  // The "mirrors the en dictionary the card actually renders" test was DELETED
  // here in W2 (entitlements v18). It pinned `PLUS_CARD_FEATURES` against
  // `pricing.plus.f1-5` and `PLUS_COMING_SOON` against `pricing.plus.soon1-8`,
  // and the arrays are gone with the Pro Plus card. The three cards that remain
  // (`FREE_FEATURES`, `PASS_FEATURES`, `PRO_FEATURES`) are rendered from the
  // arrays THEMSELVES — /pricing passes them straight to the card components —
  // so there is no second copy to drift from, which is why they never had a
  // mirror test and do not gain one now.
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, not by reverting.
//
// The arrays above are (and must stay) correct, so every assertion in the block
// above passes whether or not the guard covers the claim. Restoring the exact
// bullet this task removed is NOT proof; that is what let two wave-6 guards ship
// green. These point the same pure functions at the copy a future editor
// plausibly writes.
// ─────────────────────────────────────────────────────────────────────────────
describe("the card-bullet guards survive a rewording", () => {
  /** The bullets exactly as they shipped before this task — a holed clone, the
   *  same shape as config/__tests__/stripe-plans.test.ts uses. */
  const PRE_FIX: Record<string, readonly string[]> = {
    PASS_FEATURES: ["Upgrades ONE competition, forever", ...PASS_FEATURES.slice(1)],
    // W2 (entitlements v18): the two bullets THIS wave replaced, so the gate is
    // proved against copy that actually shipped rather than only against the
    // one a much older task removed.
    PRO_FEATURES: [
      "Unlimited competitions & divisions",
      ...PRO_FEATURES.slice(1, 5),
      "Remove the “Powered by Seazn” badge",
      ...PRO_FEATURES.slice(6),
    ],
    FREE_FEATURES: ["10 active competitions, 4 divisions", ...FREE_FEATURES.slice(1)],
  };

  it("reds on the exact copy this task replaced", () => {
    const faults = approvedBulletFaults(APPROVED_CARD_BULLETS, PRE_FIX).join("\n");
    expect(faults).toContain("PASS_FEATURES[0]");
    expect(faults).toContain("Upgrades ONE competition, forever");
    // The Pro card's two W2 falsehoods: a division cap V392 set to 20 sold as
    // unlimited, and badge removal V395 moved to enterprise still promised.
    expect(faults).toContain("PRO_FEATURES[0]");
    expect(faults).toContain("Unlimited competitions & divisions");
    expect(faults).toContain("PRO_FEATURES[5]");
    expect(faults).toContain("Remove the “Powered by Seazn” badge");
    // …and the Community card overselling the free tier threefold.
    expect(faults).toContain("FREE_FEATURES[0]");
    expect(faults).toContain("10 active competitions");
  });

  // The gate is not a snapshot of the array: it must red when an approved array
  // stops existing, or renaming the export silently switches the gate off.
  it("reds when an approved array is renamed out from under it", () => {
    expect(approvedBulletFaults(APPROVED_CARD_BULLETS, { PASS_FEATURES }).join(" ")).toContain(
      "PRO_FEATURES: approved but no such export",
    );
    expect(approvedBulletFaults([], LIVE_CARD_BULLETS)).toEqual([
      "the approved-bullet inventory is empty — this gate examines nothing",
    ]);
  });

  // …and a bullet APPENDED, which changes no approved string at all.
  it("reds on an extra Pro bullet nobody approved", () => {
    expect(
      approvedBulletFaults(APPROVED_CARD_BULLETS, {
        ...LIVE_CARD_BULLETS,
        PRO_FEATURES: [...PRO_FEATURES, "AI-powered scheduling"],
      }).join(" "),
    ).toContain("10 bullets on disk, 9 approved");
  });

  // The vocabulary half, on permanence claims written fresh — none of these is
  // the sentence this task deleted.
  it("catches the pass bullet reworded to promise permanence", () => {
    for (const reworded of [
      "Upgrades ONE competition, permanently",
      "Upgrades ONE competition — yours to keep",
      "Upgrades ONE competition for life",
      "Upgrades ONE competition; the upgrade never expires",
      "Upgrades ONE competition and it does not lapse",
      "Upgrades ONE competition for as long as you want",
      "Upgrades ONE competition with no expiry",
      "Upgrades ONE competition in perpetuity",
    ]) {
      expect(
        passBulletDurationFaults([reworded, ...PASS_FEATURES.slice(1)]).join(" "),
        reworded,
      ).toContain("claims unbounded duration");
    }
  });

  // The positive half, defeated from the other side: the bound DELETED rather
  // than contradicted, which an absence-shaped rule is happiest with.
  it("catches the bound being dropped rather than contradicted", () => {
    expect(passBulletDurationFaults(["Upgrades ONE competition", ...PASS_FEATURES.slice(1)])).toEqual([
      "no bullet states the pass is bounded to a running competition",
    ]);
    // "active" with no limiting conjunction is a claim of immediate start and NO
    // end — it must not satisfy a rule meant to assert a bound.
    expect(
      passBulletDurationFaults(["Upgrades ONE competition — active immediately", ...PASS_FEATURES.slice(1)]),
    ).toEqual(["no bullet states the pass is bounded to a running competition"]);
    // …and an emptied array is a fault, never a clean scan.
    expect(passBulletDurationFaults([])).toEqual([
      "no bullets — nothing to scan, so every rule below passes vacuously",
    ]);
  });

  /**
   * ── THE HONEST NUMBER ────────────────────────────────────────────────────────
   *
   * The eight rewordings above were written alongside these rules, so they
   * partly measure my own memory. THESE ten were written AFTER the rules were
   * final — ordinary editorial prose for a marketing bullet, deliberately
   * avoiding the words the vocabulary enumerates. No rule was adjusted to
   * accommodate any of them.
   *
   * Both rates are asserted so a regression reads as a number rather than a
   * boolean, and so that widening the vocabulary has to be a deliberate edit.
   */
  const FRESH_PERMANENCE = [
    "Upgrades ONE competition — no take-backs",
    "Upgrades ONE competition, and nothing switches it off later",
    "Upgrades ONE competition; it will still be there next season",
    "Upgrades ONE competition, settled in one payment",
    "Upgrades ONE competition — not time-boxed",
    "Upgrades ONE competition, and we never claw it back",
    "Upgrades ONE competition. It outlives the event itself",
    "Upgrades ONE competition — consider it done from then on",
    "Upgrades ONE competition, with no use-by date",
    "Upgrades ONE competition that outlasts the season",
  ];

  it("records what the vocabulary catches on prose it has never seen", () => {
    const caught = FRESH_PERMANENCE.filter(
      (line) => passBulletDurationFaults([line, ...PASS_FEATURES.slice(1)]).length > 0,
    );
    expect(FRESH_PERMANENCE.length).toBe(10);
    // Every one of these DROPS the bound as well as implying permanence, so the
    // POSITIVE half catches all ten. That is the measurement worth having: the
    // negative half — the permanence vocabulary itself — catches far fewer.
    expect(caught.length, "the paired rule's recall on unseen prose").toBe(10);
    const byVocabulary = FRESH_PERMANENCE.filter((line) =>
      FALSE_PASS_PERMANENCE_PATTERNS.some((p) => p.test(line)),
    );
    // MEASURED, not predicted: I expected 1 (guessing "no use-by date" would
    // reach the `no (end|cut-off|expiry|expiration|deadline)` family — it does
    // not; "use-by date" is not in the list). The real number is ZERO. That is
    // the sixth independent measurement of the same property in this wave, and
    // it is why the gate above is the primary rule and this is the backstop.
    expect(
      byVocabulary.length,
      "the VOCABULARY's own recall on unseen prose — update deliberately, and say why",
    ).toBe(0);
  });

  /**
   * …AND WHAT ACTUALLY PROTECTS THE SHIPPED COPY.
   *
   * The same ten sentences, put into the real array: the inventory gate reds on
   * 10 of 10, because it does not care how the falsehood is phrased. This is the
   * whole argument for the architecture, made as a measurement rather than an
   * assertion.
   */
  it("the inventory gate catches all 10, where the vocabulary alone caught 0", () => {
    const missed = FRESH_PERMANENCE.filter(
      (line) =>
        approvedBulletFaults(APPROVED_CARD_BULLETS, {
          ...LIVE_CARD_BULLETS,
          PASS_FEATURES: [line, ...PASS_FEATURES.slice(1)],
        }).length === 0,
    );
    expect(missed, `the gate missed: ${missed.join(" | ")}`).toEqual([]);
  });

  /**
   * The same measurement for a falsehood that is not a permanence claim at all:
   * ten fresh ways to sell AI scheduling as something a paid plan adds. The gate
   * reds on all ten; `EXCLUSIVE_CLAIM_VOCAB` — the shared claim vocabulary — is
   * the secondary net and is measured beside it.
   *
   * Moved from the Pro Plus card to the PRO card in W2, because that card is
   * gone and the falsehood is not: `scheduling.ai` is true on every plan key
   * there is, so selling it as something Pro adds is exactly as untrue as
   * selling it as something Pro Plus added.
   */
  const FRESH_AI_SCHEDULING = [
    "Smart fixture generation",
    "Let the assistant build your schedule",
    "Machine-drafted fixture lists",
    "Automatic draw building",
    "Our model plans your rounds for you",
    "Intelligent scheduling assistance",
    "AI-drafted fixtures",
    "Scheduling, done for you by AI",
    "One-click AI draws",
    "Fixtures written by the AI architect",
  ];

  it("the gate reds on every fresh way of re-selling AI scheduling", () => {
    const missed = FRESH_AI_SCHEDULING.filter(
      (line) =>
        approvedBulletFaults(APPROVED_CARD_BULLETS, {
          ...LIVE_CARD_BULLETS,
          PRO_FEATURES: [...PRO_FEATURES.slice(0, 3), line, ...PRO_FEATURES.slice(4)],
        }).length === 0,
    );
    expect(FRESH_AI_SCHEDULING.length).toBe(10);
    expect(missed, `the gate missed: ${missed.join(" | ")}`).toEqual([]);
  });
});

// D22, the standing version of it. The bug V311 fixes was NOT a code bug: the
// cards and the help pages had advertised "32 players" and "5 seasons" for a
// release while plan_entitlements said 16 and 1, and nothing anywhere compared
// the two. These bullets and the in-app billing panel are hand-written prose —
// they cannot be generated from the matrix — so this is the comparison.
//
// Every number a plan card quotes must be the number the resolver enforces. If
// you are here because you moved a cap: change the copy, in all four
// dictionaries, not this test.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("plan-card copy quotes the numbers the matrix enforces", () => {
  // The row must EXIST. `int_value` is legitimately null on this column (it
  // means unlimited), so `row?.int_value ?? null` cannot distinguish "no row"
  // from "unlimited" — and a missing row would sail on to assert the copy
  // contains the literal string "null entrants per division", which reads as a
  // copy bug rather than the matrix gap it actually is. Fail at the source.
  const capFor = async (feature: string, plan: string): Promise<number | null> => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
      where plan_key = ${plan} and feature_key = ${feature}`;
    expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
    return row!.int_value;
  };

  const dict = (locale: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/dictionaries/${locale}/ui.json`, "utf8"));

  const marketing = (locale: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/dictionaries/${locale}/marketing.json`, "utf8"));

  const LOCALES = ["en", "fr", "es", "nl"];

  it("the Community card quotes the live entrant and competition caps", async () => {
    const entrants = await capFor("entrants.per_division.max", "community");
    const comps = await capFor("competitions.max_active", "community");
    const bullets = FREE_FEATURES.join(" | ");
    expect(bullets).toContain(`${entrants} entrants per division`);
    expect(bullets).toMatch(new RegExp(`\\b${comps} active competitions?\\b`));
  });

  it("the Event Pass card quotes the live pass entrant cap", async () => {
    const entrants = await capFor("entrants.per_division.max", "event_pass");
    expect(PASS_FEATURES.join(" | ")).toContain(`${entrants} entrants each`);
  });

  it("the Pro card quotes the live pro entrant cap", async () => {
    const entrants = await capFor("entrants.per_division.max", "pro");
    expect(PRO_FEATURES.join(" | ")).toContain(`${entrants} entrants per division`);
  });

  // v17 (SPEC-6 A1): the /pricing card credit lines render the live
  // `ai.credits.monthly` value straight off plan_entitlements (no hardcoded
  // second source). This pins the numbers so a matrix move surfaces as a
  // failing test rather than as silent marketing drift.
  //
  // W2 (entitlements v18) re-cut all three: community 10 -> 5 and pro 60 -> 35
  // (V392), pro 35 -> 25 (V394), and the 200 belonged to `pro_plus`, a plan
  // V392 deleted — enterprise carries 500. LITERALS on purpose: reading them
  // back out of the same table the cards read would make this a tautology.
  it("plan_entitlements grants the credit-line numbers the cards quote (5 / 25 / 500)", async () => {
    expect(await capFor("ai.credits.monthly", "community")).toBe(5);
    expect(await capFor("ai.credits.monthly", "pro")).toBe(25);
    expect(await capFor("ai.credits.monthly", "enterprise")).toBe(500);
  });

  // The in-app billing panel is a SECOND hand-written copy of the same claims,
  // localised four ways. Numerals are identical across these locales, so the
  // digits are checkable without reading the prose around them — and a
  // half-updated translation set is exactly how the drift started.
  // Fix round 3: f3 quotes `dashboard.public.max` and was the one numeric row of
  // this panel nothing read. Its neighbours f4-f7 are pinned by polarity in
  // dictionary-copy-truth.test.ts; this closes the panel's numeric axis.
  it("billing.community.f3 carries the live public-dashboard cap in all four locales", async () => {
    const dashboards = await capFor("dashboard.public.max", "community");
    expect(dashboards, "community must have a finite public-dashboard cap").not.toBeNull();
    for (const locale of LOCALES) {
      // A WHOLE TOKEN, not a substring. `toContain("1")` passed "10 public
      // dashboards" — the pin read as green on a value ten times the cap.
      expect(dict(locale)["billing.community.f3"], `${locale} f3`).toMatch(
        new RegExp(`(?<!\\d)${dashboards}(?!\\d)`),
      );
    }
  });

  // FIX ROUND 4: the two percentages in this panel were pinned by nothing, while
  // `registration.fee_percent` sits in the matrix at 8 and 2. The 8% is the one
  // fix round 3 introduced into f4 — a number I added and did not pin.
  it("the panel's platform-fee percentages are the matrix's, in all four locales", async () => {
    for (const [key, plan] of [
      ["billing.community.f4", "community"],
      ["billing.pro.f3", "pro"],
    ] as Array<[string, string]>) {
      const pct = await capFor("registration.fee_percent", plan);
      expect(pct, `${plan} must have a finite fee`).not.toBeNull();
      for (const locale of LOCALES) {
        expect(dict(locale)[key], `${locale} ${key}: the live ${plan} fee`).toMatch(
          new RegExp(`(?<!\\d)${pct}\\s?%`),
        );
        // …and it must not quote the OTHER plan's rate, which is how a panel row
        // comes to describe the wrong column.
        const other = await capFor("registration.fee_percent", plan === "pro" ? "community" : "pro");
        expect(dict(locale)[key], `${locale} ${key}: must not quote ${other}%`).not.toMatch(
          new RegExp(`(?<!\\d)${other}\\s?%`),
        );
      }
    }
  });

  /**
   * FIX ROUND 5. These three used `toContain(String(n))`, which is a SUBSTRING
   * test: re-approved edits 10 -> "100 active competitions", 64 -> "640
   * entrants" and 256 -> "2560 entrants" all shipped green. I fixed exactly
   * this for `f3` last round and left it on its neighbours — the whole-token
   * form was already written twelve lines above.
   *
   * `f2` also carries the DIVISION cap, which nothing asserted at all while its
   * `why` claimed "both digits are asserted against those rows". Added here, so
   * the sentence and the check agree.
   *
   * FIX ROUND 6. …and I left it on FIVE MORE sites in this file and two in
   * `dictionary-copy-truth.test.ts`, because round 5 fixed the rows it had in
   * front of it and never grepped. Three were demonstrably live: the /pricing
   * FAQ claiming 50/100 organisations against a live 5/10, the Event Pass tip
   * claiming 1280 entrants against 128, and the same FAQ taking a competition
   * to 200 divisions against 20. Every remaining `toContain(String(n))` in this
   * file now routes through here, and the regex itself moved to
   * `@/lib/copy-truth`'s `wholeNumber` so there is ONE definition for both
   * suites instead of a form that has to be re-remembered per call site.
   */
  const quotesCap = (value: string | undefined, cap: number | null, label: string) => {
    expect(cap, `${label}: the matrix has no finite value to pin`).not.toBeNull();
    // A WHOLE TOKEN. `(?<!\d)n(?!\d)` is the form; a bare `toContain` reads a
    // ten-times-larger figure as a match.
    expect(value, label).toMatch(wholeNumber(cap!));
  };

  it("billing.community.f1/f2 carry the live caps, as whole numbers, in all four locales", async () => {
    const entrants = await capFor("entrants.per_division.max", "community");
    const comps = await capFor("competitions.max_active", "community");
    const divisions = await capFor("divisions.per_competition.max", "community");
    for (const locale of LOCALES) {
      const d = dict(locale);
      quotesCap(d["billing.community.f1"], comps, `${locale} f1 competitions.max_active`);
      quotesCap(d["billing.community.f2"], divisions, `${locale} f2 divisions.per_competition.max`);
      quotesCap(d["billing.community.f2"], entrants, `${locale} f2 entrants.per_division.max`);
    }
  });

  it("billing.pro.f2 carries the live pro entrant cap in all four locales", async () => {
    const entrants = await capFor("entrants.per_division.max", "pro");
    for (const locale of LOCALES) {
      quotesCap(dict(locale)["billing.pro.f2"], entrants, `${locale} billing.pro.f2`);
    }
  });

  /**
   * …and `billing.pro.f1`, whose exemption reason claimed it was "pinned against
   * competitions.max_active / divisions.per_competition.max". Nothing asserted
   * it: null -> 10 redded no panel rule, and "500 competitions & divisions" was
   * green.
   *
   * W2 (entitlements v18) is the case that rule was written for and never saw:
   * V392 capped `divisions.per_competition.max` on pro at 20 while
   * `competitions.max_active` stayed null, so ONE of the two rows the sentence
   * covered stopped being unlimited. The old assertion — "say unlimited, and
   * carry no digit at all" — would have to be WEAKENED to accept the truth,
   * which is the signal that it was asserting the wrong thing: it pinned the
   * shape of a sentence rather than the two rows underneath it.
   *
   * Now each row is judged on its own. The word is required for the row that is
   * genuinely unlimited, the number for the row that is not, and a digit is no
   * longer forbidden — it is REQUIRED, and required to be the live one.
   */
  it("billing.pro.f1 says unlimited for the unlimited row and quotes the cap for the capped one", async () => {
    const comps = await capFor("competitions.max_active", "pro");
    const divisions = await capFor("divisions.per_competition.max", "pro");
    expect(comps, "pro competitions.max_active").toBeNull();
    expect(divisions, "pro divisions.per_competition.max").not.toBeNull();
    const UNLIMITED: Record<string, RegExp> = {
      en: /\bunlimited\b/i,
      es: /\bilimitad/i,
      fr: /\billimit/i,
      nl: /\bonbeperkt/i,
    };
    for (const locale of LOCALES) {
      const value = dict(locale)["billing.pro.f1"]!;
      expect(value, `${locale} f1: must say unlimited (competitions)`).toMatch(UNLIMITED[locale]!);
      quotesCap(value, divisions, `${locale} f1 divisions.per_competition.max`);
      // …and it must not quote the OTHER row's absence as a number. Pro's
      // competition cap is null; any second figure here would be one.
      expect(
        (value.match(/\d+/g) ?? []).filter((d) => d !== String(divisions)),
        `${locale} f1: quotes a figure no row backs`,
      ).toEqual([]);
    }
  });

  // ── v17 #294: the same D22 discipline, now for TWO rungs ──────────────────
  //
  // Every surface below is hand-written prose that quotes a cap, and each one
  // described only the M rung before this task. The numerals are identical
  // across en/fr/es/nl, so the digits are checkable without reading the prose
  // around them — the same reasoning the four-locale tests above rely on.

  it("the /pricing FAQ answer names the live caps and price of the rung ON SALE", async () => {
    // Was "…names the L rung's live caps and its price". Owner decision
    // 2026-09-05 took L off sale, so the answer describes the rung a reader can
    // actually buy — and this asks the same question of that rung, plus the
    // negative that stops the narrowing from being a way to stop looking.
    for (const rung of SELLABLE_PASS_KEYS) {
      const divisions = await capFor("divisions.per_competition.max", rung);
      const entrants = await capFor("entrants.per_division.max", rung);
      for (const locale of LOCALES) {
        const answer = marketing(locale)["pricing.faq.eventPass.a"];
        expect(answer, `${locale}: no answer`).toBeTruthy();
        // Whole token: `toContain("20")` was satisfied by "200 divisions".
        quotesCap(answer, divisions, `${locale}: ${rung}'s division cap`);
        quotesCap(answer, entrants, `${locale}: ${rung}'s entrant cap`);
        // The price must be INTERPOLATED, never written down: `{pass}` is
        // substituted with the switched currency at render time, so a hardcoded
        // "$11.99" here would show dollars to a GBP visitor — the exact bug
        // #191 was filed for on this rung's copy.
        expect(answer, `${locale}: interpolated price`).toContain("{pass}");
      }
    }
    // The withdrawn rung's price token must be GONE, or the page would still
    // interpolate a price for a size it does not sell. `{passL}` no longer
    // exists in `faqVars` either, so a leftover token would render literally.
    for (const locale of LOCALES) {
      expect(marketing(locale)["pricing.faq.eventPass.a"], locale).not.toContain("{passL}");
    }
    expect(HIDDEN_PASS_KEYS.length).toBeGreaterThan(0);
  });

  // GAP B from T3's sweep: this tip said "64 entrants per division" while the
  // live matrix has said 128 since V319 — a PRE-EXISTING content bug, wrong by
  // half, independent of the L rung. Pinning it against the matrix is what
  // stops it recurring; naming L is what this wave adds.
  it("the Event Pass tip quotes the live M entrant cap and L's ceiling", async () => {
    const mEntrants = await capFor("entrants.per_division.max", "event_pass");
    const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
    const communityEntrants = await capFor("entrants.per_division.max", "community");
    expect(mEntrants).toBe(128);
    for (const locale of LOCALES) {
      const body = dict(locale)["tips.billing.event-pass.body"];
      expect(body, `${locale}: no tip body`).toBeTruthy();
      // Whole tokens: `toContain("128")` was satisfied by "1280 entrants".
      quotesCap(body, mEntrants, `${locale}: M entrant cap`);
      quotesCap(body, lDivisions, `${locale}: L division cap`);
      // The bug itself: the tip must never quote COMMUNITY's cap as the
      // pass's. The tip describes only what the pass grants, so this figure
      // has no legitimate reason to appear in it.
      expect(body, `${locale}: must not quote community's cap`).not.toContain(
        String(communityEntrants),
      );
    }
  });

  it("the Event Pass help article presents both rungs with their live caps", async () => {
    const article = readFileSync("content/help/billing/event-pass.md", "utf8");
    const mEntrants = await capFor("entrants.per_division.max", "event_pass");
    const mDivisions = await capFor("divisions.per_competition.max", "event_pass");
    const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
    // V392 gave L a real 512-entrant cap where it had been null. The article
    // said "unlimited entrants" for as long as the row was null, and that
    // sentence is now a live overclaim of 512 — so the assertion inverts: the
    // number must be quoted, and the word must be GONE. Keeping only the
    // positive half would let a page say both.
    const lEntrants = await capFor("entrants.per_division.max", "event_pass_l");
    expect(lEntrants, "L's entrant cap is a number now, not null").not.toBeNull();
    expect(article).toContain(`**${mEntrants} entrants**`);
    expect(article).toContain(`**${mDivisions} divisions**`);
    expect(article).toContain(`**${lDivisions} divisions**`);
    expect(article).toContain(`**${lEntrants} entrants**`);
    expect(article.toLowerCase(), "L's cap is 512, not unlimited").not.toContain(
      "unlimited entrants",
    );
    // Same 64-for-128 defect as the tip, in the "Can I buy a pass on top of
    // Pro?" answer, which compared Pro's 256 against "the pass's 64".
    expect(article).not.toMatch(/pass(?:'s|es)?\s+64\b/i);
  });

  // The article a buyer opens at the exact moment a cap bites, and the one the
  // v17 #294 sweep MISSED — it stopped at `content/help/billing/`, so this file
  // went on stating M's ceilings as *the pass's* ("128 under an Event Pass…
  // 10 under a pass") for the whole wave. An L buyer read the two numbers they
  // had just paid $59 to remove.
  //
  // Pinned the same way as its billing-section siblings: against the live
  // matrix, and against the shape of the defect (a ceiling attributed to "a
  // pass" with no rung beside it).
  it("the add-a-division article gives BOTH rungs, at their live caps", async () => {
    const md = readFileSync("content/help/getting-started/add-a-division.md", "utf8");
    /** One `**Question?**` line — the answers are scoped so a figure that
     *  belongs to the divisions answer cannot satisfy the entrants one. */
    const answer = (question: string) =>
      md.split("\n").find((l) => l.startsWith(`**${question}`)) ?? "";

    const entrants = answer("How many entrants");
    expect(entrants, "no entrants answer").toBeTruthy();
    expect(entrants).toContain(`**${await capFor("entrants.per_division.max", "community")}**`);
    expect(entrants).toContain(`**${await capFor("entrants.per_division.max", "event_pass")}**`);
    expect(entrants).toContain(`**${await capFor("entrants.per_division.max", "pro")}**`);
    // L's cap was NULL and the answer said so in words ("no limit at all").
    // V392 made it 512, so the words are the defect now and the number is the
    // claim — asserted in both directions so a page cannot carry both.
    const lEntrants = await capFor("entrants.per_division.max", "event_pass_l");
    expect(lEntrants, "L's entrant cap is a number now").not.toBeNull();
    expect(entrants).toContain(`**${lEntrants}**`);
    expect(entrants.toLowerCase(), "L is capped at 512").not.toContain("no limit at all");

    const divisions = answer("How many divisions");
    expect(divisions, "no divisions answer").toBeTruthy();
    expect(divisions).toContain(`**${await capFor("divisions.per_competition.max", "community")}**`);
    expect(divisions).toContain(
      `**${await capFor("divisions.per_competition.max", "event_pass")}**`,
    );
    expect(divisions).toContain(
      `**${await capFor("divisions.per_competition.max", "event_pass_l")}**`,
    );

    // THE defect, in both answers: a ceiling handed to "an Event Pass" / "a
    // pass" with no size beside it states one rung's limit as the product's.
    // Requiring both size letters in each answer is what the pre-fix text
    // fails — it named neither.
    for (const [name, line] of [
      ["entrants", entrants],
      ["divisions", divisions],
    ] as const) {
      expect(line, `${name}: names the M rung`).toMatch(/\*\*M\*\*/);
      expect(line, `${name}: names the L rung`).toMatch(/\*\*L\*\*/);
    }
  });

  // `content/help/billing/plans.md` was the ONE help article with no test
  // reading it — its sibling `event-pass.md` (which it links to) has been
  // pinned above since T6. That gap is not hypothetical: plans.md is exactly
  // where the "64 entrants" rot survived V319 *and* V341, describing the pass
  // with Community's cap for two migrations, and it is `order: 1` in the
  // billing section — the first thing a reader deciding what to buy opens.
  describe("the plans-at-a-glance article quotes the matrix, not remembered numbers", () => {
    const article = () => readFileSync("content/help/billing/plans.md", "utf8");

    /** One `## ` section's body. Scoped because the article legitimately quotes
     *  FOUR plans' caps, so a page-wide assertion about any single number can
     *  neither confirm nor deny which plan it belongs to — the precise reason
     *  "64 entrants" read as correct here while describing the wrong plan. */
    const section = (heading: string): string => {
      const md = article();
      const start = md.indexOf(`## ${heading}`);
      expect(start, `no "## ${heading}" section`).toBeGreaterThan(-1);
      const rest = md.slice(start + 3);
      const end = rest.indexOf("\n## ");
      return end === -1 ? rest : rest.slice(0, end);
    };

    it("gives each Event Pass rung its own live caps, and neither the other's", async () => {
      const mEntrants = await capFor("entrants.per_division.max", "event_pass");
      const mDivisions = await capFor("divisions.per_competition.max", "event_pass");
      const lDivisions = await capFor("divisions.per_competition.max", "event_pass_l");
      const lEntrants = await capFor("entrants.per_division.max", "event_pass_l");
      expect(lEntrants, "L's entrant cap is a number since V392").not.toBeNull();

      const pass = section("Event Pass");
      expect(pass, "M's entrant cap").toContain(`**${mEntrants} entrants**`);
      expect(pass, "M's division cap").toContain(`**${mDivisions} divisions**`);
      expect(pass, "L's division cap").toContain(`**${lDivisions} divisions**`);
      expect(pass, "L's entrant cap").toContain(`**${lEntrants} entrants**`);
      expect(pass.toLowerCase(), "L is capped at 512, not unlimited").not.toContain(
        "unlimited entrants",
      );
    });

    it("never describes the pass with Community's entrant cap — the bug that lived here", async () => {
      const communityEntrants = await capFor("entrants.per_division.max", "community");
      const proEntrants = await capFor("entrants.per_division.max", "pro");
      const pass = section("Event Pass");
      // Both neighbours: the rot was Community's number, but Pro's would read
      // just as plausibly and would oversell the pass rather than undersell it.
      expect(pass, "community's cap").not.toContain(String(communityEntrants));
      expect(pass, "pro's cap").not.toContain(String(proEntrants));
    });

    it("quotes each plan's own live entrant cap in its own section", async () => {
      const cases: Array<[string, string]> = [
        ["Community", "community"],
        ["Pro", "pro"],
      ];
      for (const [heading, planKey] of cases) {
        const entrants = await capFor("entrants.per_division.max", planKey);
        expect(section(heading), `${heading} entrants`).toContain(
          `${entrants} entrants per division`,
        );
      }
      // Enterprise's cap is NULL in the matrix, so the article must say so in
      // words rather than print a number. It was Pro Plus's section until W2;
      // V392 deleted that plan and enterprise took its place at the top of the
      // ladder (design §4 — a Contact-us tier, not a priced one).
      expect(await capFor("entrants.per_division.max", "enterprise")).toBeNull();
      expect(section("Enterprise").toLowerCase()).toContain("unlimited entrants per division");
    });

    it("quotes the live monthly credit allowances", async () => {
      // The same three numbers the /pricing cards render live. Here they are
      // hand-written prose, in a table-shaped sentence, four plans deep.
      const md = article();
      for (const plan of ["community", "pro", "enterprise"]) {
        const credits = await capFor("ai.credits.monthly", plan);
        quotesCap(md, credits, `${plan} credits`);
      }
    });

    it("quotes the live platform fee in its table ROW, for every plan", async () => {
      // The fee table is the article's densest claim about money and the only
      // place a reader compares every plan at once. Asserted as the whole ROW,
      // not as a bare "5%" anywhere in the file: the pass section separately
      // mentions "a 5% platform fee", so an unscoped search finds a match even
      // when the table itself has drifted.
      const md = article();
      const fee = async (plan: string) => await capFor("registration.fee_percent", plan);
      const rows: Array<[string, number | null]> = [
        ["Community", await fee("community")],
        ["Pro", await fee("pro")],
        ["Enterprise", await fee("enterprise")],
      ];
      for (const [label, pct] of rows) {
        expect(md, `${label} fee row`).toContain(`| ${label} | ${pct}% |`);
      }
      // ONE "Event Pass" row covers both rungs, which is only honest while they
      // charge the same. If a rung's fee ever moves, this fails and the article
      // needs two rows — the same reasoning that gave each rung its own column
      // on /pricing.
      const m = await fee("event_pass");
      const l = await fee("event_pass_l");
      expect(l, "the rungs share one fee row, so they must share a fee").toBe(m);
      expect(md, "Event Pass fee row").toContain(`| Event Pass | ${m}% |`);
    });
  });

  // ── The boolean grants behind the capability bullets ──────────────────────
  //
  // The three tests that lived here — "the Pro Plus card claims only
  // differentiators Pro Plus actually has", its pre-fix probe, and "the AI
  // claim the card does make is the one the credit rows back" — were DELETED in
  // W2 (entitlements v18) with the card they judged. What they were protecting
  // is not lost: `crossCardExclusivityFaults` below asks the same question of
  // every card that still exists, and `localeCreditLeadershipFaults` survives
  // in copy-truth.ts with the leading plan as an ARGUMENT (it hardcoded
  // `pro_plus`, which V392 deleted), exercised by dictionary-copy-truth.test.ts
  // against the live ordering — enterprise 500 > pro 25 > community 5.

  const boolGrants = async (features: string[]): Promise<FeatureGrants> => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no rows for these features").toBeGreaterThan(0);
    const out: FeatureGrants = {};
    for (const row of rows) (out[row.feature_key] ??= {})[row.plan_key] = row.bool_value === true;
    return out;
  };

  // `scheduling.ai` is granted on EVERY plan key there is, which is why no card
  // may sell it as something a plan adds. Asserted as the whole set rather than
  // key by key: a plan APPEARING (enterprise, V392) or DISAPPEARING (pro_plus,
  // same migration) is exactly the change that would make a per-key spot check
  // read as clean.
  it("scheduling.ai is granted on every plan, so it differentiates nothing", async () => {
    expect((await boolGrants(["scheduling.ai"]))["scheduling.ai"]).toEqual({
      community: true,
      enterprise: true,
      event_pass: true,
      event_pass_l: true,
      pro: true,
    });
  });

  // ── FIX ROUND 1 (I2 / I4): every card number against its row ───────────────

  /** The live matrix, for exactly the features the claim tables name. */
  const cardMatrix = async (): Promise<Matrix> => {
    const features = [...new Set(CARD_SURFACES.flatMap((s) => s.claims.map((c) => c.feature)))];
    // Four features, and it is the count that matters: the Pro Plus card's own
    // claims (members.max / teams.max / clubs.max) left with it in W2, so this
    // floor moved down by three. Anything lower means a claim table was emptied.
    expect(features.length, "the claim tables name no features").toBeGreaterThanOrEqual(4);
    const rows = await sql<{ feature_key: string; plan_key: string; int_value: number | null }[]>`
      select feature_key, plan_key, int_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no rows for the card features").toBeGreaterThan(0);
    const out: Matrix = {};
    for (const row of rows) (out[row.feature_key] ??= {})[row.plan_key] = row.int_value;
    return out;
  };

  it("quotes every cap and fee at the value the matrix holds, on every card", async () => {
    expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, await cardMatrix())).toEqual([]);
  });

  /**
   * …and it is a CHECK, not a second copy. Each probe below moves the matrix
   * under copy that stays word-for-word identical — the shape the whole rule
   * exists for, and the shape that scored 1/10 before this round.
   *
   * Committed rather than run once: a literal in a test looks exactly like a
   * check until someone moves the thing it was supposed to be checking.
   */
  it("reds when the matrix moves under copy that never changed", async () => {
    const live = await cardMatrix();
    const moved = (feature: string, plan: string, value: number | null): Matrix => ({
      ...live,
      [feature]: { ...live[feature], [plan]: value },
    });
    const cases: Array<[string, Matrix, string]> = [
      ["competitions.max_active null -> 3", moved("competitions.max_active", "pro", 3), "card claims UNLIMITED competitions.max_active, but the matrix caps pro at 3"],
      ["community fee 8 -> 12", moved("registration.fee_percent", "community", 12), "does not quote the live community/registration.fee_percent (12)"],
      ["event_pass fee 5 -> 7", moved("registration.fee_percent", "event_pass", 7), "does not quote the live event_pass/registration.fee_percent (7)"],
      ["pro fee 2 -> 4", moved("registration.fee_percent", "pro", 4), "does not quote the live pro/registration.fee_percent (4)"],
      ["community divisions 4 -> 2", moved("divisions.per_competition.max", "community", 2), "does not quote the live community/divisions.per_competition.max (2)"],
      ["community comps 3 -> 7", moved("competitions.max_active", "community", 7), "does not quote the live community/competitions.max_active (7)"],
      ["community entrants 64 -> 16", moved("entrants.per_division.max", "community", 16), "does not quote the live community/entrants.per_division.max (16)"],
      ["pro entrants 256 -> 64", moved("entrants.per_division.max", "pro", 64), "does not quote the live pro/entrants.per_division.max (64)"],
      ["pro divisions 20 -> 6", moved("divisions.per_competition.max", "pro", 6), "does not quote the live pro/divisions.per_competition.max (6)"],
      // The two `event_pass_l` probes here died with the rung's sale
      // (2026-09-05): the card no longer claims L's caps, so moving them can
      // no longer make the card false and a probe expecting a fault would be
      // asserting the opposite of the truth. Both directions the pass card can
      // still be wrong in are covered by the two rows above — the entry rung's
      // fee, and the caps it quotes — plus the entrant/division probes below.
      ["pass entrants 128 -> 300", moved("entrants.per_division.max", "event_pass", 300), "does not quote the live event_pass/entrants.per_division.max (300)"],
      ["pass divisions 10 -> 12", moved("divisions.per_competition.max", "event_pass", 12), "does not quote the live event_pass/divisions.per_competition.max (12)"],
      // …and the UNLIMITED direction, which the deleted Pro Plus probes used to
      // carry alone. Pro's competition cap is the only null a card still calls
      // unlimited, so it is the one that keeps that branch exercised.
      ["pro competitions null -> 40", moved("competitions.max_active", "pro", 40), "card claims UNLIMITED competitions.max_active, but the matrix caps pro at 40"],
    ];
    for (const [label, matrix, expected] of cases) {
      expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, matrix).join(" | "), label).toContain(
        expected,
      );
    }
    // A DELETED row must be a fault, not "unlimited". `?? null` would have read
    // a vanished feature key as an unlimited allowance and certified the card.
    // W2 made this the LIVE case rather than the hypothetical one: V392 and
    // V394 between them deleted five feature keys outright.
    const withoutEntrants = { ...live };
    delete withoutEntrants["entrants.per_division.max"];
    expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, withoutEntrants).join(" | ")).toContain(
      "plan_entitlements has no community/entrants.per_division.max row",
    );
    // …and an empty matrix must not read as clean.
    expect(cardMatrixFaults(CARD_SURFACES, LIVE_CARD_BULLETS, {}).join(" | ")).toContain(
      "compared the cards against nothing",
    );
    expect(cardMatrixFaults([], LIVE_CARD_BULLETS, live)).toEqual([
      "no card surfaces — this rule examines nothing",
    ]);
    // An empty claim table with no stated reason is a fault; with one, it is a
    // decision. This is what stopped the roadmap being silently uncovered.
    expect(
      cardMatrixFaults(
        [{ array: "FREE_FEATURES", plan: null, claims: [] }, ...CARD_SURFACES],
        LIVE_CARD_BULLETS,
        live,
      ).join(" | "),
    ).toContain("an empty claim table must be a decision, not a silence");
  });

  /**
   * The capability bullets, against the boolean rows.
   *
   * This rule exists because of a FRESH probe set written after the numeric
   * pins were final: 10 falsehoods, 1 caught. Every miss was a capability
   * bullet — `dashboard.branding` going false on pro while the Pro card still
   * promises to remove the badge, `realtime` going false on event_pass while
   * the Pass card still sells a realtime scoreboard. Same falsehood class as a
   * moved cap, invisible to a rule that only reads `int_value`.
   */
  /** Both columns of every row the capability claims name. A capability can be
   *  boolean or int-shaped and the card cannot tell which, so the guard reads
   *  the row rather than a column. */
  const capabilityRows = async (): Promise<RowsByFeature> => {
    const features = [
      ...new Set(CARD_SURFACES.flatMap((s) => (s.booleans ?? []).map((c) => c.feature))),
    ];
    expect(features.length, "no capability claims declared").toBeGreaterThan(15);
    const rows = await sql<
      { feature_key: string; plan_key: string; bool_value: boolean | null; int_value: number | null }[]
    >`select feature_key, plan_key, bool_value, int_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no capability rows").toBeGreaterThan(0);
    const out: RowsByFeature = {};
    for (const row of rows) {
      (out[row.feature_key] ??= {})[row.plan_key] = { bool: row.bool_value, int: row.int_value };
    }
    return out;
  };

  /**
   * The capability bullets, against the rows.
   *
   * This rule exists because of a fresh probe set written after the numeric
   * pins were final: 10 falsehoods, 1 caught, every miss a capability bullet.
   * `dashboard.branding` going false on pro while the Pro card still promises
   * to remove the badge is the same falsehood class as a moved cap, invisible
   * to a rule that only reads `int_value`.
   */
  it("promises no capability its plan does not grant, on any card", async () => {
    const rows = await capabilityRows();
    expect(cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, rows)).toEqual([]);

    // …and it is a check, not a restatement. Each of these revokes a grant and
    // leaves the bullet promising it word for word.
    const revoke = (feature: string, plan: string, patch: Partial<EntitlementRow>): RowsByFeature => ({
      ...rows,
      [feature]: { ...rows[feature], [plan]: { ...rows[feature]![plan]!, ...patch } },
    });
    for (const [feature, plan, patch, expected] of [
      // WAS `dashboard.branding`. V395 made badge removal enterprise-only and
      // V396 split the accent colour onto `dashboard.theme`, so the Pro card's
      // visual claim is the colour and this probe follows it.
      ["dashboard.theme", "pro", { bool: false }, "PRO_FEATURES: promises dashboard.theme, but pro does not grant it"],
      ["realtime", "event_pass", { bool: false }, "PASS_FEATURES: promises realtime, but event_pass does not grant it"],
      // THE L RUNG — fresh probe G1. The card sells both rungs from one list, so
      // These two probed `event_pass_l` while the card sold both rungs — a
      // capability lost on L alone misled an L buyer. With the rung off sale
      // (2026-09-05) the card makes no claim about it, so they are repointed at
      // the rung the card DOES sell rather than deleted: the failure they exist
      // for — a bullet promising a boolean the plan behind it does not grant —
      // is unchanged, only its subject moved.
      ["formats.advanced", "event_pass", { bool: false }, "PASS_FEATURES: promises formats.advanced, but event_pass does not grant it"],
      ["sponsors.monetize", "event_pass", { bool: false }, "PASS_FEATURES: promises sponsors.monetize, but event_pass does not grant it"],
      ["api.access", "pro", { bool: false }, "PRO_FEATURES: promises api.access, but pro does not grant it"],
      // Fresh probes G2 / G4 / G5 — bullets that were simply not enumerated.
      ["exports", "pro", { bool: false }, "PRO_FEATURES: promises exports, but pro does not grant it"],
      ["registration.enabled", "community", { bool: false }, "FREE_FEATURES: promises registration.enabled, but community does not grant it"],
      ["discovery.listed", "community", { bool: false }, "FREE_FEATURES: promises discovery.listed, but community does not grant it"],
      ["news.auto", "pro", { bool: false }, "PRO_FEATURES: promises news.auto, but pro does not grant it"],
      // V392 brought `officials.auto` down to Pro; the Pro card says so, so it
      // owes a probe like every other capability bullet.
      ["officials.auto", "pro", { bool: false }, "PRO_FEATURES: promises officials.auto, but pro does not grant it"],
      // Fresh probe G3 — an INT-shaped capability. No boolean moves at all.
      ["dashboard.public.max", "community", { int: 0 }, "FREE_FEATURES: promises dashboard.public.max, but community allows only 0"],
    ] as Array<[string, string, Partial<EntitlementRow>, string]>) {
      expect(
        cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, revoke(feature, plan, patch)).join(" | "),
        `${plan}/${feature}`,
      ).toContain(expected);
    }

    // THE POSITIVE HALF. A claim whose bullet has been reworded away must red,
    // or the pin quietly stops examining anything — the failure five guards in
    // this wave shipped with.
    expect(
      cardBooleanFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PRO_FEATURES: PRO_FEATURES.filter((b) => !/colours/i.test(b)) },
        rows,
      ).join(" | "),
    ).toContain("the copy this dashboard.theme pin describes is gone");
    // …and a deleted row is a fault, not a pass.
    const withoutNews = { ...rows };
    delete withoutNews["news.auto"];
    expect(cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, withoutNews).join(" | ")).toContain(
      "plan_entitlements has no pro/news.auto row",
    );
    expect(cardBooleanFaults(CARD_SURFACES, LIVE_CARD_BULLETS, {}).join(" | ")).toContain(
      "this rule examined nothing",
    );
  });

  /**
   * …AND THE RULE THAT MAKES THE ENUMERATION ITSELF CHECKABLE.
   *
   * Every bullet claimed by something, or exempted with a reason. This is the
   * structural answer to a fresh set scoring 1/10 while the tuned set scored
   * 10/10: the rules were not weak, the LIST was incomplete, and nothing could
   * tell the difference.
   */
  /** EVERY feature key the matrix holds — the attribution lexicon is derived
   *  from these, so a bullet naming a feature no card declared is still
   *  recognised as making a claim. */
  const allFeatureKeys = async (): Promise<string[]> => {
    const rows = await sql<{ feature_key: string }[]>`
      select distinct feature_key from plan_entitlements`;
    expect(rows.length, "plan_entitlements has no features").toBeGreaterThan(30);
    return rows.map((r) => r.feature_key);
  };

  it("attributes every bullet on every card to a row or a recorded decision", async () => {
    expect(
      cardBulletAttributionFaults(
        CARD_SURFACES,
        LIVE_CARD_BULLETS,
        await cardMatrix(),
        await allFeatureKeys(),
      ),
    ).toEqual([]);
  });

  it("reds on a bullet nobody attributed, and on an exemption that covers nothing", async () => {
    const matrix = await cardMatrix();
    const features = await allFeatureKeys();
    const faults = (live: Record<string, readonly string[]>, surfaces = CARD_SURFACES) =>
      cardBulletAttributionFaults(surfaces, live, matrix, features).join(" | ");

    // A bullet naming a feature NO card declared. The lexicon is built from the
    // whole matrix precisely so this is still recognised as a claim.
    expect(
      faults({ ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Custom domain & white-label"] }),
      // Reported via `custom` (from `domains.custom`) rather than `domain` —
      // the lexicon holds the key's own segments, and singular/plural need not
      // match for the bullet to be flagged.
    ).toContain('"Custom domain & white-label" makes an unattributed claim');

    // ── THE REVIEWER'S THREE, each a second claim riding inside a bullet whose
    //    first claim IS declared. All three were green under per-bullet
    //    attribution; the residue check is what sees them.
    expect(
      faults({ ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Unlimited entrants while your competition runs"] }),
      "Pro caps entrants at 256, and the duration grammar used to attribute this whole bullet",
    ).toContain('"Unlimited entrants while your competition runs" makes an unattributed claim');
    expect(
      faults({ ...LIVE_CARD_BULLETS, FREE_FEATURES: [...FREE_FEATURES, "Branded exports on your public dashboard"] }),
      "exports.branded is FALSE on community; the dashboard regex used to cover the whole bullet",
    ).toContain('"Branded exports on your public dashboard" makes an unattributed claim');
    expect(
      faults({ ...LIVE_CARD_BULLETS, FREE_FEATURES: [...FREE_FEATURES, "64 entrants per division, with unlimited clubs & teams"] }),
      "clubs.max on community is 5; says(64) used to attribute the whole bullet",
    ).toContain('"64 entrants per division, with unlimited clubs & teams" makes an unattributed claim');

    // ── THE SEVEN THAT THE ROUND-2 REWRITE LET THROUGH ────────────────────
    //
    // Every one of these redded under the old "any unattributed bullet is a
    // fault" rule and went GREEN under the residue rule that replaced it,
    // because each makes a plan claim in words no `plan_entitlements` feature
    // key happens to contain. Measured by the reviewer in worktrees at the
    // parent commit and at mine. They are the reason the two rules are now
    // conjoined rather than swapped.
    for (const [array, bullet, why] of [
      ["FREE_FEATURES", "Run as many events at once as you like", "community caps competitions.max_active at 10, two bullets above"],
      ["FREE_FEATURES", "Remove the Powered by Seazn badge", "dashboard.branding is false on community"],
      ["PRO_FEATURES", "Round-the-clock phone helpline", "no support entitlement of any kind on pro"],
      ["PRO_FEATURES", "Your own dedicated success manager", "same — support.priority is pro_plus-only"],
      ["PRO_FEATURES", "White-glove onboarding for your first season", "no row grants this on any plan"],
      ["PRO_FEATURES", "Ship data straight to your warehouse nightly", "the warehouse export is coming-soon, not shipped"],
      ["PRO_FEATURES", "Your own web address, fully white-labelled", "domains.custom is pro_plus-only and unshipped"],
    ] as Array<[string, string, string]>) {
      expect(
        faults({ ...LIVE_CARD_BULLETS, [array]: [...(LIVE_CARD_BULLETS[array] ?? []), bullet] }),
        `${array}: "${bullet}" — ${why}`,
      ).toContain(`"${bullet}"`);
    }

    // …and the prefix-match hole beside them: the lexicon holds `credits` while
    // the copy says `credit`, so a one-directional `\b${token}` never fired.
    expect(
      faults({ ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Largest monthly AI credit grant"] }),
      "the Plus card's own bullet, moved to Pro, where it is false",
    ).toContain('"Largest monthly AI credit grant"');

    // A stale exemption: the phrase it names is gone, so it covers nothing and
    // hides whatever replaced it.
    const stale: CardSurface[] = CARD_SURFACES.map((s) =>
      s.array === "PASS_FEATURES"
        ? { ...s, unclaimed: { ...s.unclaimed, "Upgrades ONE competition, forever": "the old wording" } }
        : s,
    );
    expect(faults(LIVE_CARD_BULLETS, stale)).toContain("is exempted but appears in no bullet");

    // …and an exemption with no real reason is not an exemption.
    const empty: CardSurface[] = CARD_SURFACES.map((s) =>
      s.array === "FREE_FEATURES" ? { ...s, unclaimed: { ...s.unclaimed, "Live standings": "n/a" } } : s,
    );
    expect(faults(LIVE_CARD_BULLETS, empty)).toContain("has an empty exemption reason");
  });

  it("no card claims a feature its own plan does not grant", async () => {
    const grants = await boolGrants([
      "scheduling.ai",
      "officials.auto",
      "api.write",
      "support.priority",
    ]);
    expect(crossCardExclusivityFaults(CARD_SURFACES, LIVE_CARD_BULLETS, grants)).toEqual([]);
    // THE PROBE, repointed in W2. It used to append "Auto officials assignment"
    // to the Pro card — a contradiction while `officials.auto` was Pro Plus's
    // exclusive. V392 granted that key to Pro, so the Pro card now says it and
    // the sentence is TRUE; the probe would assert a fault that must not exist.
    // `api.write` is the key that plays the old role: enterprise-only, and
    // enterprise is a Contact-us strip rather than a card.
    expect(
      crossCardExclusivityFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Write API access"] },
        grants,
      ).join(" | "),
    ).toContain("the pro card claims api.write, but pro does not grant it");
    // …and the negative case: if a migration granted it to pro, saying so on the
    // Pro card becomes true and this rule must fall silent. That is not
    // hypothetical any more — it is exactly what happened to `officials.auto`,
    // which the shipped Pro card now claims and this rule reports clean.
    expect(
      crossCardExclusivityFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PRO_FEATURES: [...PRO_FEATURES, "Write API access"] },
        { ...grants, "api.write": { ...grants["api.write"], pro: true } },
      ),
    ).toEqual([]);
    // Anti-vacuity: the rule must be examining something. Exactly ONE card
    // matches the vocabulary today — the Pro card's `officials.auto` bullet —
    // where the deleted Plus card used to match three, so this rule is one
    // reword away from examining nothing and the backstop matters more, not
    // less, than it did.
    expect(
      crossCardExclusivityFaults(
        CARD_SURFACES,
        { ...LIVE_CARD_BULLETS, PRO_FEATURES: ["More of everything"] },
        grants,
      ),
    ).toEqual(["no card matched any differentiator vocabulary — this rule examined nothing"]);
  });

  it("the pass bullet names the division cap of every rung on sale, and no other", async () => {
    // Was "…names both rungs' division caps": the bullet read
    // "10 divisions, 128 entrants each — 20 divisions & 512 entrants on L".
    // With L off sale (2026-09-05) that second half advertised a size with no
    // checkout behind it, so it went.
    const bullets = PASS_FEATURES.join(" | ");
    for (const rung of SELLABLE_PASS_KEYS) {
      const divisions = await capFor("divisions.per_competition.max", rung);
      // A whole token. "10 divisions" is also a substring of "110 divisions",
      // so the unit noun does not save the left boundary.
      expect(bullets, `${rung}'s division cap, as a whole number`).toMatch(
        new RegExp(`${wholeNumber(divisions!).source}\\s+divisions`),
      );
    }
    // …and the withdrawn rung's ceiling is not still being sold. Its numbers
    // are the whole reason someone would want it, so they are exactly what must
    // not survive on the card.
    for (const rung of HIDDEN_PASS_KEYS) {
      const divisions = await capFor("divisions.per_competition.max", rung);
      const entrants = await capFor("entrants.per_division.max", rung);
      expect(bullets, `${rung}'s division cap is off sale`).not.toMatch(
        new RegExp(`${wholeNumber(divisions!).source}\\s+divisions`),
      );
      expect(bullets, `${rung}'s entrant cap is off sale`).not.toMatch(wholeNumber(entrants!));
      // Anti-vacuity: the two rungs' caps really differ, so "does not quote L"
      // is not satisfied by L and M holding the same number.
      expect(divisions).not.toBe(await capFor("divisions.per_competition.max", "event_pass"));
    }
    expect(HIDDEN_PASS_KEYS.length).toBeGreaterThan(0);
  });
});
