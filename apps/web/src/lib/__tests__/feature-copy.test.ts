import { describe, it, expect } from "vitest";
import { doubleElimFormatReason, featurePlan, featureReason } from "@/lib/feature-copy";

/**
 * The vocabulary a price claim has to reach for. The ruling on the
 * `orgs.max_owned` refusal (v17 gap #293) is "name the purchase, never price
 * it" — a rule about what the sentence CLAIMS, which a denylist of specific
 * phrasings cannot express.
 *
 * Deliberately NOT a no-digits rule: the sentence's job is to state the caps
 * ("Community 1, Pro 5"), so digits are the thing it must keep.
 */
const PRICES_THE_RIDER =
  /[$£€]|\b(rates?|prices?|priced|pricing|costs?|fees?|half|double|cheaper|discount)\b/i;

describe("feature-copy V290", () => {
  it("maps Enterprise (Contact-us) features to \"enterprise\" (entitlements v18)", () => {
    // ENTERPRISE_FEATURES is api.write and NOTHING else: a key belongs there
    // only when no self-serve plan grants it at all. See
    // `entitlements-v18-enterprise-ceiling.test.ts` for the DB-derived proof.
    expect(featurePlan("api.write")).toBe("enterprise");
    // These two were briefly in that set, on the rule "every int key whose
    // Pro value is the ceiling" (design §4 states it that way and is WRONG).
    // If Pro is already unlimited, Pro is the cheapest plan that unlocks the
    // key. Sending them to enterprise showed a Community organiser hitting
    // the 3-competition cap a Contact-us mailto with the priced "Go Pro" link
    // suppressed — no self-serve way out of the highest-volume Free→Pro gate
    // in the product. They must offer a PRICE.
    expect(featurePlan("competitions.max_active")).toBe("pro");
    expect(featurePlan("dashboard.public.max")).toBe("pro");
    // pro_plus is retired (V391). officials.auto and scorers.max were its
    // above-Pro keys; entitlements v18 moves both to plain Pro (design §2/§4)
    // — a paywall for either must no longer point at Contact-us.
    expect(featurePlan("officials.auto")).toBe("pro");
    expect(featurePlan("scorers.max")).toBe("pro");
    // domains.custom / support.priority: T1 deleted both keys from
    // plan_entitlements entirely (inert-key removal). Nothing gates on them
    // any more, so where featurePlan lands them is moot — the ladder's
    // documented default (unknown/absent key → "pro") applies, same as any
    // other key nobody asks about.
    expect(featurePlan("domains.custom")).toBe("pro");
    expect(featurePlan("support.priority")).toBe("pro");
    expect(featurePlan("scheduling.board")).toBe("pro");
    expect(featurePlan("officials.roles_multi")).toBe("pro");
    // V302 (owner 2026-07-19): AI scheduling exists on every tier; Pro is the
    // next step up for the bool feature-flag itself.
    expect(featurePlan("scheduling.ai")).toBe("pro");
  });
  /**
   * `import.bulk`'s refusal must not restate its cap or name a plan.
   *
   * In the same spirit as PRICES_THE_RIDER above: a rule about what the
   * sentence CLAIMS, not a denylist of phrasings. The old copy — "Files over
   * 20 rows need a Pro plan" — was wrong twice over. The VALUE moved (live
   * community is 50, V319), and the KIND was wrong too: `import.bulk` is
   * dual-valued (a bool on Pro, an int cap on community), so a community org
   * has a real allowance rather than no access. An organiser refused at 51
   * rows and told the limit was 20 splits into two 26-row files, each of which
   * would have imported whole.
   *
   * Deliberately NOT the repo-wide "no digits" rule that `orgs.max_owned`
   * would fail — that sentence's job IS to state its caps. This one's job is
   * to name the remedy and leave the number to `plan_entitlements`.
   */
  it("import.bulk's refusal restates neither its cap nor a plan name", () => {
    const reason = featureReason("import.bulk");
    expect(reason, "the row cap belongs to plan_entitlements, not to copy").not.toMatch(/\d/);
    expect(reason, "import.bulk is dual-valued — a community org has a real allowance").not.toMatch(
      /\bPro(\s|\b)/,
    );
    // The positive pair: having said what it must not contain, pin that it
    // still does its job. A blank string satisfies both negatives above.
    expect(reason).toMatch(/split/i);
    expect(reason).toMatch(/upgrade/i);
  });

  it("has reasons for the new keys and none for the dead one", () => {
    expect(featureReason("schedule.checkpoints.max")).toMatch(/save.point/i);
    expect(featureReason("scheduling.ai")).toMatch(/AI Schedule/);
    // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322):
    // the graded per-division cap copy is gone — falls back to the generic
    // line, same as any other deleted key.
    expect(featureReason("scheduling.ai.runs_per_division.max")).toBe(
      "This feature needs a plan upgrade.",
    );
    // officials.assignment was deleted (D5) — falls back to the generic line.
    expect(featureReason("officials.assignment")).toBe("This feature needs a plan upgrade.");
  });

  // V391 (entitlements v18) deleted four inert keys from `plan_entitlements`.
  // Three of them used to be asserted in the case above as having reasons.
  // They moved here rather than being dropped, because the assertion that
  // matters INVERTED: a reason for a key no gate can raise is an upsell the
  // customer can never act on, and `domains.custom` / `support.priority` said
  // "Pro Plus" — a plan that no longer exists. The generic fallback is the
  // correct answer, and pinning it is what stops a reason drifting back in.
  it("has NO reason for any key V391 deleted — they fall back to the generic line", () => {
    for (const key of [
      "officials.per_fixture.max",
      "domains.custom",
      "support.priority",
      "stats.club_championship",
    ]) {
      expect(featureReason(key), key).toBe("This feature needs a plan upgrade.");
    }
    // Anti-vacuity: the generic line is what EVERY unknown string returns, so
    // the loop above would pass against a FEATURE_REASONS that had been
    // emptied entirely. A live key still carrying its own sentence is the
    // floor that says the map is intact.
    expect(featureReason("api.write")).not.toBe("This feature needs a plan upgrade.");
  });
  it("orgs.max_owned names the same remedy the 402's machine hint does (v17 gap #293)", () => {
    // The refusal ships TWO halves of one message: `{ offer: "extra_org" }` in
    // the body and this sentence next to it. If the copy drifts back to
    // "upgrade in Settings → Billing", the paywall tells the payer to do one
    // thing while the payload offers another, and nothing else notices.
    const reason = featureReason("orgs.max_owned");
    expect(reason).toMatch(/extra organisation/i);
    expect(reason).toMatch(/Add-ons/);
    // The CADENCE is the one commercial fact this sentence may state: it is
    // true on every plan and in every currency. Positive, and it pairs with
    // the absence below — the sentence must still NAME the purchase and its
    // rhythm, it just must not PRICE it.
    expect(reason).toMatch(/monthly/i);
    expect(reason).not.toMatch(PRICES_THE_RIDER);
  });

  it("the no-price rule survives a REWORD — it pins vocabulary, not two phrasings", () => {
    // The rule used to be `not.toMatch(/half/i)` + `not.toMatch(/same rate/i)`,
    // which is a denylist of two sentences rather than the ruling. Putting the
    // exact falsehood back in different words passed.
    //
    // Every claim below is plausible and every one is ~37% wrong for an ANNUAL
    // group: the plan price's second graduated tier (what the organisations
    // already on the bill cost) is 900/1900 a month but 7900/16300 a YEAR,
    // while the rider SKU sold here is monthly-only at 900/1900. The figure
    // belongs to the Add-ons page, which knows the currency and reads it from
    // the rider SKU.
    for (const reworded of [
      "buy an extra organisation at half your plan's rate",
      "buy an extra organisation at the same rate as the ones already on your bill",
      "buy an extra organisation at the same monthly cost as the ones on your bill",
      "buy an extra organisation for $9",
      "buy an extra organisation for £9 a month",
      "buy an extra organisation — €19 on Pro Plus",
      "an extra organisation is priced per month",
      "extra organisations are cheaper than a second bill",
      "there is no extra fee beyond your plan",
    ]) {
      expect(reworded).toMatch(PRICES_THE_RIDER);
    }

    // Discriminators, so the rule is not simply "reject every sentence": the
    // shipped copy passes, and so does the ONE set of numbers it must keep.
    // A no-digits rule would have been WRONG for exactly this reason — the
    // caps themselves are what the refusal is about.
    expect(featureReason("orgs.max_owned")).not.toMatch(PRICES_THE_RIDER);
    // "Pro Plus 10" dropped from this literal with the plan (V391) — the cap
    // list is Community/Pro only now, not a third tier's ceiling.
    expect("Community 1, Pro 5").not.toMatch(PRICES_THE_RIDER);
    expect("it's billed monthly on top of your current bill").not.toMatch(PRICES_THE_RIDER);
  });
  it("has copy for the v16 league-ops entitlements (V293/V294/V295, T84)", () => {
    expect(featureReason("discipline.enforced")).toBe(
      "Automatic suspension tracking is a Pro feature.",
    );
    expect(featureReason("officials.marks")).toBe("Rating your match officials is a Pro feature.");
    expect(featureReason("news.auto")).toBe("Auto-drafted result posts are a Pro feature.");
    expect(featurePlan("discipline.enforced")).toBe("pro");
    expect(featurePlan("officials.marks")).toBe("pro");
    expect(featurePlan("news.auto")).toBe("pro");
  });
});

// Bug fix (2026-08-18): the "League + Playoffs" template's Pro gate read
// "Double-elimination brackets are a Pro format." even though its only
// gated stage is a Page playoff (kind "page_playoff"), not an actual
// double-elimination bracket. `formats.double_elim` legitimately gates BOTH
// kinds (owner ruling: sharing the entitlement is correct and intentional —
// a Page playoff is the four-team double-chance shape — see
// format-gates.ts's stageNeedsDoubleElimGate, which this does NOT change),
// so the fix is this per-kind wording resolver, not the gate condition.
describe("doubleElimFormatReason — formats.double_elim names the ACTUAL gated kind", () => {
  it("names the Page playoff format for a page_playoff stage, never double-elimination", () => {
    const reason = doubleElimFormatReason("page_playoff");
    expect(reason).toMatch(/page playoff/i);
    expect(reason).not.toMatch(/double.elimination/i);
  });

  it("keeps the existing double-elimination wording, byte-for-byte, for a double_elim stage", () => {
    // "a double-elim template keeps its current wording" (owner ruling) —
    // pinned against the live FEATURE_REASONS entry, not a copy of the
    // string, so the two can never quietly drift apart.
    expect(doubleElimFormatReason("double_elim")).toBe(featureReason("formats.double_elim"));
    expect(doubleElimFormatReason("double_elim")).toMatch(/double-elimination/i);
  });

  it("falls back to the double-elimination wording for any other kind (defensive default)", () => {
    expect(doubleElimFormatReason("knockout")).toBe(featureReason("formats.double_elim"));
  });
});
