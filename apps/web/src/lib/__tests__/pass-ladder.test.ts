// The Event Pass rung ladder (v17 #294, spec A7).
//
// This is the data half of the M/L picker: the two rungs, in order, each with
// the price the buyer is quoted and the caps that are the WHOLE reason to pick
// one over the other. It is pure so the numbers can be pinned without Postgres;
// the caps themselves are read live from `plan_entitlements` by the upgrade page
// and handed in, exactly as the comparison table on that page reads them.
//
// What these tests protect: a rung whose advertised price came from the OTHER
// rung's price point. That is invisible on the page (both are plausible dollar
// amounts) and invisible to the charge (the charge resolves
// `plans.stripe_price_id_onetime` by key), so the only place it can be caught is
// here, comparing the two.
import { describe, expect, it } from "vitest";
import {
  PASS_LOCK_REASON_KEY,
  PASS_RUNG_NAME_KEY,
  PASS_RUNG_SIZE_KEY,
  lowestPassRung,
  lowestPricedRung,
  passActiveLabel,
  passActiveLabels,
  passCheckoutErrorKey,
  passEndedReasons,
  passLadderOptions,
} from "../pass-ladder";
import { PASS_LOCK_REASONS } from "@/lib/entitlements";
import {
  HIDDEN_PASS_KEYS,
  PASS_KEYS,
  SELLABLE_PASS_KEYS,
  SUPPORTED_CURRENCIES,
  passPrice,
} from "@/lib/currency";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import uiEn from "@/dictionaries/en/ui.json";
import seed from "@/config/stripe-plans.json";

/**
 * Each rung's price point, READ FROM THE SEED and keyed by rung — never typed
 * here. A typed pair freezes today's amounts and reds on the next legitimate
 * reprice (W3 moved every one of them onto charm points), which teaches the
 * next editor to retype the constants instead of re-checking the claim.
 *
 * It is NOT tautological against `passPrice`: the assertions below pin which
 * OPTION carries which RUNG's amount, so a ladder that handed M the L price
 * point still fails — the exact defect this file exists for. The seed, rather
 * than `passPrice`, so the pin does not route through the same reader the
 * subject does.
 */
const SEED_PASS_PRICE = Object.fromEntries(
  seed.passes.map((pass) => [
    pass.key,
    (currency: string): number =>
      currency === "usd"
        ? pass.price.unit_amount
        : (pass.price.currency_options as Record<string, number>)[currency]!,
  ]),
) as Record<"event_pass" | "event_pass_l", (currency: string) => number>;

/** Caps for the rungs the ladder actually renders — one entry per SELLABLE
 *  rung, which is what `PassRungCaps` is now keyed by. A hidden rung's caps are
 *  not asked for, because the ladder never quotes them. */
const CAPS = {
  event_pass: { entrants: 128, divisions: 10 },
} as const;

describe("passLadderOptions", () => {
  // THE LADDER IS A SELLING SURFACE, so it renders `SELLABLE_PASS_KEYS` and not
  // `PASS_KEYS` (owner decision 2026-09-05, the L rung off sale). Enumerated
  // against the authority rather than against a typed list of rungs: a
  // `not.toContain("event_pass_l")` would also pass on a ladder that rendered
  // nothing at all, and the positive half is what stops that.
  it("renders exactly the rungs on sale, in the authority's order", () => {
    const options = passLadderOptions("usd", CAPS);
    expect(options.map((o) => o.key)).toEqual([...SELLABLE_PASS_KEYS]);
    // The positive: the entry rung is really there, priced and capped.
    expect(options[0]).toMatchObject({
      key: "event_pass",
      amountMinor: SEED_PASS_PRICE.event_pass("usd"),
      entrants: 128,
      divisions: 10,
      credits: PASS_CREDIT_GRANT.event_pass,
    });
    // …and the negative, stated against the hidden list rather than a literal.
    for (const hidden of HIDDEN_PASS_KEYS) {
      expect(options.map((o) => o.key), `${hidden} is off sale`).not.toContain(hidden);
    }
    // Anti-vacuity for that loop: something IS hidden, and the ladder is
    // genuinely shorter than the full rung set because of it.
    expect(HIDDEN_PASS_KEYS.length).toBeGreaterThan(0);
    expect(options.length).toBe(PASS_KEYS.length - HIDDEN_PASS_KEYS.length);
  });

  it("prices in the requested currency", () => {
    const options = passLadderOptions("gbp", CAPS);
    expect(options[0]!.amountMinor).toBe(SEED_PASS_PRICE.event_pass("gbp"));
    // The gbp points must actually DIFFER from the usd ones, or this case
    // passes while `passLadderOptions` ignores its currency argument entirely.
    expect(SEED_PASS_PRICE.event_pass("gbp")).not.toBe(SEED_PASS_PRICE.event_pass("usd"));
  });

  it("never lets two rungs share a price point, in any supported currency", () => {
    // The failure this exists for: a rung that silently reads the OTHER rung's
    // price point. It used to be asked of the ladder, which now renders one
    // rung and could not witness it — so it is asked of `passPrice` over every
    // rung instead, hidden ones included. That is deliberate: this is a rule
    // over the SEED, and a dormant rung's price rotting into the live one's is
    // exactly what would make putting L back on sale a silent mis-sale.
    // Asserted as a joined string so the reporter NAMES the currency.
    const same = SUPPORTED_CURRENCIES.filter((c) => {
      const amounts = PASS_KEYS.map((k) => passPrice(c, k));
      return new Set(amounts).size !== amounts.length;
    });
    expect(same.join(", ")).toBe("");
    // Anti-vacuity: there is more than one rung to collide.
    expect(PASS_KEYS.length).toBeGreaterThan(1);
  });

  it("carries the option's OWN credit grant, indexed by its own key", () => {
    // Entitlements v18 W2 T5 (design R9): the grant is sized by rung. The
    // failure this exists for is a card advertising one rung's number beside
    // another's price — `credits: PASS_CREDIT_GRANT.event_pass` hardcoded for
    // every option type-checks, and that is the mistake this catches.
    //
    // With one rung on sale the ladder cannot witness a cross-rung swap on its
    // own, so this pins the INDEXING (every option's credits equal its own
    // key's grant) and `pass-credit-grant.test.ts` keeps the two rungs' grants
    // distinct in the declaration.
    for (const option of passLadderOptions("usd", CAPS)) {
      expect(option.credits, option.key).toBe(PASS_CREDIT_GRANT[option.key]);
    }
    expect(PASS_CREDIT_GRANT.event_pass_l).not.toBe(PASS_CREDIT_GRANT.event_pass);
  });
});

describe("rung label maps", () => {
  it("name and size every rung that EXISTS, sellable or not, with no key reused", () => {
    // Keyed by PASS_KEYS and not by SELLABLE_PASS_KEYS on purpose. A rung taken
    // off sale is still a rung a held ticket has to NAME: an org that paid for
    // L and is shown the family name alone is being told it holds the other
    // product, on the only screen that says which it holds. So these two maps
    // stay complete while the LADDER shortens.
    //
    // A rung added to PASS_KEYS without a label here renders the raw plan key
    // on the ticket. tsc catches the omission; this catches the subtler slip —
    // two rungs pointing at ONE key, which labels L as M on a $44.99 purchase.
    for (const map of [PASS_RUNG_NAME_KEY, PASS_RUNG_SIZE_KEY]) {
      expect(PASS_KEYS.filter((k) => !map[k]).join(", ")).toBe("");
      expect(new Set(Object.values(map)).size).toBe(PASS_KEYS.length);
    }
    // …and the hidden rungs are genuinely among them, or "sellable or not" is
    // a claim about an empty set.
    for (const hidden of HIDDEN_PASS_KEYS) {
      expect(PASS_RUNG_NAME_KEY[hidden], `${hidden} must keep its name`).toBeTruthy();
    }
  });
});

describe("lowestPricedRung", () => {
  // The reducer, tested away from the seed. Against the LIVE price list M is
  // cheapest, so an implementation that simply returned "event_pass" would pass
  // every assertion in the sibling describe below — and would then quote $29
  // "from" on the day a rung is added under it, or the day L is discounted.
  it("picks the cheapest rung, whichever one that is", () => {
    const rungs = [
      { key: "event_pass", amountMinor: 9900 },
      { key: "event_pass_l", amountMinor: 1900 },
    ] as const;
    expect(lowestPricedRung(rungs).key).toBe("event_pass_l");
  });

  it("keeps the earlier rung when two are priced the same", () => {
    // Ordering is the tie-break, not chance: `passLadderOptions` renders M
    // first, and a "from" price that flipped rung between renders on equal
    // amounts would flip the NAME beside it too.
    const rungs = [
      { key: "event_pass", amountMinor: 2900 },
      { key: "event_pass_l", amountMinor: 2900 },
    ] as const;
    expect(lowestPricedRung(rungs).key).toBe("event_pass");
  });
});

describe("lowestPassRung", () => {
  // Every surface that quotes ONE number for a ladder ("Event Pass — from
  // $11.99") has to quote the floor. Before #294 they each passed the literal
  // "event_pass", which is right only for as long as M stays the cheapest rung
  // — and `tsc` cannot see that assumption at all.
  it("is the cheapest rung ON SALE in every supported currency", () => {
    const wrong = SUPPORTED_CURRENCIES.filter((c) => {
      const cheapest = Math.min(...SELLABLE_PASS_KEYS.map((k) => passPrice(c, k)));
      return lowestPassRung(c).amountMinor !== cheapest;
    });
    expect(wrong.join(", ")).toBe("");
  });

  it("never quotes a rung that is off sale, at any price", () => {
    // The load-bearing direction, and it is not the same claim as "cheapest".
    // If a hidden rung were ever discounted below the entry rung, a
    // `lowestPassRung` reading the full ladder would start quoting a price
    // nothing on the site will sell — a "from" figure the checkout refuses.
    // Reading the sellable list makes that structurally impossible; this
    // witnesses it.
    for (const c of SUPPORTED_CURRENCIES) {
      expect(HIDDEN_PASS_KEYS as readonly string[], c).not.toContain(lowestPassRung(c).key);
      expect(SELLABLE_PASS_KEYS as readonly string[], c).toContain(lowestPassRung(c).key);
    }
  });

  it("quotes M's real price point today, and names M as the rung it quoted", () => {
    expect(lowestPassRung("usd")).toEqual({
      key: "event_pass",
      amountMinor: SEED_PASS_PRICE.event_pass("usd"),
    });
    expect(lowestPassRung("gbp")).toEqual({
      key: "event_pass",
      amountMinor: SEED_PASS_PRICE.event_pass("gbp"),
    });
    // …and M is genuinely the cheaper rung in both, so "names M" is a claim
    // about the ORDER rather than a restatement of whichever rung came first.
    expect(SEED_PASS_PRICE.event_pass("usd")).toBeLessThan(SEED_PASS_PRICE.event_pass_l("usd"));
    expect(SEED_PASS_PRICE.event_pass("gbp")).toBeLessThan(SEED_PASS_PRICE.event_pass_l("gbp"));
  });

  it("never quotes the more expensive rung", () => {
    const over = SUPPORTED_CURRENCIES.filter(
      (c) => lowestPassRung(c).amountMinor > passPrice(c, "event_pass_l"),
    );
    expect(over.join(", ")).toBe("");
  });
});

describe("passActiveLabel", () => {
  // The held signal on the dashboard card, the competition header and
  // competition settings said a flat "Event Pass active" — the FAMILY name,
  // with nothing beside it naming the rung. An org that paid $59 for L reads
  // its competition as holding the $29 product.
  //
  // NARROWED 2026-09-07, and only for the rung on sale. The L half is
  // unchanged and is the half #294 was about. The M half went back to the
  // family name because the letter had become something a buyer met ONLY
  // AFTER paying: the buy button reads "Buy the pass", the /pricing ticket and
  // matrix column read "Event Pass", and Stripe's own product name for this
  // rung is "Seazn Club Event Pass" — so "Event Pass M active" was the one
  // place in the whole purchase naming a size, and it appeared after the
  // money moved. `heldRungNeedsNaming` states the rule; this pins what it
  // renders.
  it("names the rung that is actually held — when the rung needs naming", () => {
    expect(passActiveLabel(uiEn, "event_pass_l")).toBe("Event Pass L active");
    expect(passActiveLabel(uiEn, "event_pass")).toBe("Event Pass active");
    // The two must DIFFER, or an org holding L is being shown the product it
    // did not buy — which is the whole point of this test and cannot be
    // satisfied by both arms collapsing to the family name.
    expect(passActiveLabel(uiEn, "event_pass")).not.toBe(
      passActiveLabel(uiEn, "event_pass_l"),
    );
  });

  it("leaves no un-substituted placeholder in the rendered label", () => {
    // `t()` returns the literal `{rung}` when the caller forgets the var, and
    // three call sites would each have to remember. This helper is the reason
    // none of them can.
    for (const key of PASS_KEYS) expect(passActiveLabel(uiEn, key)).not.toContain("{");
  });

  it("labels each rung differently", () => {
    expect(passActiveLabel(uiEn, "event_pass")).not.toBe(passActiveLabel(uiEn, "event_pass_l"));
  });
});

describe("passActiveLabels", () => {
  // A server page holds the dict; only the client provider knows which rung is
  // held. So the page hands over BOTH finished strings and the island picks.
  it("carries a finished label for every rung the product sells", () => {
    const labels = passActiveLabels(uiEn);
    expect(PASS_KEYS.filter((k) => !labels[k]).join(", ")).toBe("");
    expect(new Set(Object.values(labels)).size).toBe(PASS_KEYS.length);
  });

  it("agrees with passActiveLabel rung for rung", () => {
    const labels = passActiveLabels(uiEn);
    for (const key of PASS_KEYS) expect(labels[key]).toBe(passActiveLabel(uiEn, key));
  });
});

describe("passCheckoutErrorKey", () => {
  // The buyer must never read the server's own words: they are hardcoded
  // English in a four-locale UI, and lib/http.ts returns a RAW `err.message`
  // on an unexpected 500 — a Stripe or Postgres exception string one throw away
  // from being rendered as purchase advice.
  it("tells a buyer to try the other size when a rung has no synced price (503)", () => {
    expect(passCheckoutErrorKey(503)).toBe("upgrade.buyError.rung");
  });

  it("treats every other refusal as a stale page, not as a bad rung", () => {
    // The route 400s for five different reasons — already holds a pass, plan
    // now covers it, no active org, competition gone, rung not in PASS_KEYS —
    // and 401/404 add two more. They differ in cause and NOT in remedy.
    //
    // 409 is deliberately NOT in this list any more (v17 gap #326): see below.
    // Neither is 410 (v17 gap #353) — same reason, different remedy.
    for (const status of [400, 401, 402, 404, 429]) {
      expect(passCheckoutErrorKey(status)).toBe("upgrade.buyError.stale");
    }
  });

  it("does NOT tell a buyer to reload a competition that is over (410)", () => {
    // v17 gap #353. The route refuses a purchase for a completed, archived or
    // past-grace competition, because the pass would apply to nothing. 410 sits
    // INSIDE the 4xx range, so only the arm ordering keeps it out of the stale
    // bucket — and "the page may be out of date, reload and try again" is a lie
    // to this reader twice over: reloading changes nothing, and on the terminal
    // arm nothing the buyer can do changes anything (#248 Q4 — one pass per
    // competition, forever, and this one was never bought).
    expect(passCheckoutErrorKey(410)).toBe("upgrade.buyError.ended");
    expect(passCheckoutErrorKey(410)).not.toBe(passCheckoutErrorKey(400));
    expect(passCheckoutErrorKey(410)).not.toBe(passCheckoutErrorKey(409));
  });

  it("does NOT tell an already-charged buyer to reload and try again (409)", () => {
    // The mint guard refused a payment that was taken, so the route freezes the
    // sale until staff resolve it. The 4xx bucket's whole premise — "the page is
    // out of date, reload" — is a confident lie to this reader: reloading
    // changes nothing and their money has already gone. Split out with its own
    // sentence for that reason, not for tidiness.
    expect(passCheckoutErrorKey(409)).toBe("upgrade.buyError.underReview");
    expect(passCheckoutErrorKey(409)).not.toBe(passCheckoutErrorKey(400));
  });

  it("says nothing it does not know for a 5xx, a rejected fetch or a missing secret", () => {
    for (const status of [500, 502, 504, null]) {
      expect(passCheckoutErrorKey(status)).toBe("upgrade.buyError.generic");
    }
  });
});

describe("PASS_LOCK_REASON_KEY / passEndedReasons", () => {
  const dict = uiEn;

  // W8 task 3 review, I-1. Every other assertion about these two sentences was
  // built FROM `passEndedReasons()` or FROM the Record — so swapping the
  // Record's two arms left the whole suite green, and the card would have told
  // an organiser whose competition merely ran past its end date that it was
  // "finished or archived", and told one whose competition had finished to go
  // and update the end date. The mapping is the thing most worth pinning and
  // was the one thing nothing pinned.
  //
  // Broken here by asserting against MEANING rather than against the mapping:
  // each reason's sentence has to talk about the situation that reason names.
  // A test that re-typed today's English would drift the first time the copy is
  // reworded; these two probes are about subject matter, not wording.
  it("points each reason at a sentence about that reason", () => {
    const terminal = passEndedReasons(dict).terminal;
    const pastEnds = passEndedReasons(dict).past_ends_on;

    // A finished/archived competition. Its next step is next season, NOT a date
    // edit — so the terminal sentence must not send anyone to the end date.
    expect(terminal).toMatch(/finished|archived/i);
    expect(terminal).not.toMatch(/end date/i);

    // A competition that merely ran past `ends_on` is often still being played,
    // and the date IS the fix. It must say so, and must not declare the
    // competition over.
    expect(pastEnds).toMatch(/end date/i);
    expect(pastEnds).not.toMatch(/finished|archived/i);
  });

  it("pins the two dictionary keys themselves", () => {
    // The literal keys, so a swap inside the Record is a diff in this file
    // rather than a silent re-pointing. Cheap, and it fails loudly in exactly
    // the case the review found.
    expect(PASS_LOCK_REASON_KEY).toEqual({
      terminal: "pass.entry.ended.reasonTerminal",
      past_ends_on: "pass.entry.ended.reasonPastEnds",
    });
  });

  it("covers every reason the resolver can return, with distinct real copy", () => {
    const reasons = passEndedReasons(dict);
    expect(Object.keys(reasons).sort()).toEqual([...PASS_LOCK_REASONS].sort());
    const sentences = Object.values(reasons);
    // Non-empty and non-identical: a missing dictionary key resolves to the key
    // name or to "", and two reasons sharing one sentence is the collapse the
    // separate arms exist to prevent.
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(20);
      expect(s).not.toMatch(/^pass\./);
    }
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
