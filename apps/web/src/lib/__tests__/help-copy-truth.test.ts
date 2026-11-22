// Truth-in-copy guards for the BILLING HELP ARTICLES (v17 gap wave 7, task 3).
//
// Sibling of `plan-copy-truth.test.ts`, which points the same pure functions in
// `@/lib/copy-truth` at `stripe-plans.json`. Split rather than extended because
// the two surfaces need different scoping — a seed description is one product's
// claim, an article is a page of mixed claims about four plans — and because
// that file's own header says it is the application to the seed.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`. CI's unit job has no
// DATABASE_URL and its Postgres steps select `src/server src/lib` and `src/app`
// (.github/workflows/ci.yml). From `src/__tests__/` the whole
// `describe.skipIf(!HAS_DB)` half would run in no job at all and report pending
// on a green exit 0.
//
// SCOPE — three sibling articles are deliberately NOT scanned here; see
// KNOWN_GAPS below. Each is a real defect with a real issue, and listing them
// as data rather than leaving them silently unscanned is the point.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import stripePlans from "@/config/stripe-plans.json";
import { sql } from "@/lib/db";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import {
  aiOfficialsPlanGateFaults,
  BOUNDED_SCOPE_GRAMMAR,
  FEE_LADDER_PLAN_KEYS,
  mentionsRateAfterPass,
  feeLadderFaults,
  feeLadderRows,
  feeLadderTables,
  passFeeRowFaults,
  DURATION_ALLOWLIST,
  FEE_RATE_ALLOWLIST,
  approvedFormsExercised,
  feeLockStatedFaults,
  goldenParagraphFaults,
  inventoryFaults,
  jointUndoFaults,
  claimTexts,
  LOCALE_CLAIMS,
  localeHalfClaimFaults,
  riderClaimShape,
  type LocalisedValue,
  unapprovedClaimFaults,
  lockedRateConstantFaults,
  markdownSection,
  PLAN_CAP_AXES,
  PLAN_KEY_BY_LABEL,
  planCapProseClaims,
  planCapProseFaults,
  planCapTableFaults,
  planCapTables,
  type PlanCapLookup,
  multiDivisionBoardPlanGateFaults,
  plainProse,
  passBoundProseFaults,
  passCreditProseFaults,
  type PricedPlan,
  proseBlocks,
  sentences,
  retiredRunCapProseFaults,
  scoringFreeClaimFaults,
  riderRateFaults,
  statesFeeLock,
  unmeteredAiRunProseFaults,
  unqualifiedFeeReversionFaults,
} from "@/lib/copy-truth";
import {
  ALL_PLAN_KEYS,
  HIDDEN_PASS_KEYS,
  PASS_KEYS,
  SELLABLE_PASS_KEYS,
} from "@/lib/currency";
import { HELP_ARTICLE_SLUGS, helpUrl } from "@/lib/help";
import { allHelpArticles } from "@/server/help-content";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import { resolveHelpTokens } from "@/server/help-tokens";
import { TIPS } from "@/config/tips";
import { attachConfirmKey } from "@/lib/billing-group-view";
import {
  allAuditedSources,
  allSourceFiles,
  allStrippedSources,
  blankedInsideLiteralFaults,
  citationFaults,
  citationsIn,
  codeOnly,
  freezeCheckedUrlPrefixes,
  freezeCheckedWriteRoutes,
  headersObjects,
  stripComments,
  helpArticle,
  helpArticleBySlug,
  webSource,
} from "./_help-copy";
import {
  APPROVED_EVENT_PASS,
  APPROVED_EVENT_PASS_INVENTORY,
  APPROVED_BUY_PASS_INVENTORY,
  APPROVED_PASS_ENDS,
  APPROVED_PASS_ENDS_INVENTORY,
  APPROVED_PLANS_PASS,
  APPROVED_PLANS_INVENTORY,
  APPROVED_ADD_ONS_INVENTORY,
  APPROVED_GROUPS_INVENTORY,
  APPROVED_ADD_ORG_INVENTORY,
  APPROVED_REMOVE_ORG_INVENTORY,
  APPROVED_HANDOVER_INVENTORY,
  APPROVED_CREATE_ORG_INVENTORY,
} from "./_approved-copy";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/**
 * Articles this task fixed, and therefore scans.
 *
 * NOT a directory walk. Two siblings this task fixed were `billing/downgrade.md`
 * (the same unqualified fee-reversion claim these guards ban — see the new
 * describe block below, `billing/downgrade.md is gated too`) and
 * `scheduling/ai-scheduling.md`, since split into the `scheduling/ai-*` pages (the retired per-division run-cap table AND the
 * false "officials AI runs are not metered" claim — see
 * `the AI Schedule pages are gated too`, further down). Both moved out of
 * this list and into real scans once #303 corrected the copy. What remains
 * below is a real gap with a real issue, and listing it as data rather than
 * leaving it silently unscanned is the point.
 *
 * #365: `scheduling/ai-officials.md` was the THIRD copy of #303's unmetered-run
 * falsehood, plus its own "Automatic officials assignment is a Pro Plus
 * feature" — untouched because #303's guard was only ever invoked on
 * `ai-scheduling.md` by name. Fixed here (see `scheduling/ai-officials.md is
 * gated too`, further down) and the unmetered-run guard is now run over EVERY
 * article in the tree (see `no help article anywhere claims an AI run is
 * unmetered/free`, further down) rather than added as a fourth named file — so
 * a fourth copy reds this suite instead of waiting for someone to notice.
 */
const KNOWN_GAPS = [
  "lib/pricing-cards.ts + e2e/pro-plus-tier.spec.ts — card bullets pinned verbatim (#303)",
  "config/tips.ts + dictionaries/*/ui.json — tips.schedule.save-points.body is stale on BOTH sides vs schedule.checkpoints.max (community 2 since V319, pro 5, pro_plus unlimited); documented as the tip-mirror exception in dictionary-copy-truth.test.ts (#303)",
  "content/help/** link TARGETS are invisible to the inventory gate — claimSurfaces reduces [text](/url) to text, so repointing a URL raises 0 faults (sibling of the link-TITLE hole, #338)",
  "app/globals.css .competition-prose table — the horizontal scroll box added for #299 is NOT keyboard-reachable: it needs tabindex=0, and renderHelpMarkdown's sanitiser (server/help-content.ts) drops the attribute, so it cannot be set from Markdown. Needs a rehype step or a wrapper element (#303)",
  "app/globals.css .competition-prose table — `display: block` is what gives that scroll box its overflow, and it drops the implicit table role in some assistive tech (row/column relationships stop being announced). Mitigation is an explicit role=\"table\"/rowgroup set, which the same sanitiser strips (#303)",
  // ── Round 4 bookkeeping: the residuals, named rather than left implicit ────
  "THE AXIS IS CIRCULAR. `claiming` is computed by running `en.halfClaim` over the tree, so an article only joins the half-rate axis — and therefore only earns a gate — if that vocabulary already matches it. The vocabulary has been measured at 0/12 and 0/24, so an article stating the rate in an unseen shape is invisible to the axis AND ungated. The axis narrows the ungated set; it does not close it (#303)",
  "THE FOURTH ARTICLE. `billing/plans.md` states the plan org caps and the fee ladder and is inventory-gated. `billing/downgrade.md`, the `scheduling/ai-*` pages and `scheduling/ai-officials.md` now carry the fee-lock/run-cap/unmetered-run vocabulary scans (below), which is real coverage but NOT the word-for-word inventory gate — a reword that stays inside the vocabulary's blind spots is still possible. `billing/credits.md`, `billing/operator.md` and every other non-billing, non-scheduling article remain fully ungated and unscanned, defended only by the vocabulary above (#303, #365)",
  "COMMENTS OWNED BY A CLOSING TOKEN SURVIVE `codeOnly` — NOT just the JSX idiom. `forEachChild` never visits TOKENS, so any comment whose nearest owner is a closing token is never blanked: `{/* … */}`, but equally an end-of-block comment on its own line, a comment in an empty block, the last call argument, the last array element, the last object property, the end of an interface body, a `switch`, or an `if`. Only an end-of-file comment is blanked. Measured tree-wide: 569 comment lines / 32,229 chars across 168 of 1,460 files. Direction is FAIL-SAFE — a negative scan can red on a comment that mentions a banned idiom, but can never miss real code — which is why it is recorded rather than fixed. Recorded as .tsx-only in round 5; that scoping was wrong and would have left the next reader hunting a JSX bug (#338)",
  "LITERAL-FREE SPANS ARE UNAUDITED, AND THIS ONE IS FAIL-OPEN. `blankedInsideLiteralFaults` proves every changed character lies OUTSIDE every string/regex/template-part/JSX literal, which closes the historical family (a `/*` inside a string ate 193 lines of division-settings.tsx) — proven by a length-preserving blank across every file raising 14,857 faults. It does NOT audit a stripper that eats a span containing NO literal at all. Constructed and it PASSES: blanking the largest literal-free span per file ships 79/79 green while destroying 1,061,443 chars across 1,341 of 1,460 files, largest single span 11,831 chars in server/usecases/billing-events.ts — LARGER than the 11,384 the historical bug actually ate. So this is not a corner case, it is most of the tree. THE COST ESTIMATE IN THE TASK 7 REPORT IS WRONG and that is the part that matters: closing this does NOT need a re-parse-and-compare 'doubling the walk'. It is a string check on the CHANGED CHARACTERS ONLY — take each maximal run of changed offsets, extend across neighbouring changed/space chars, require that span's raw text to be comments and whitespace only. O(changed chars), no re-parse, sub-millisecond per file. A wrong cost estimate is what stops a thing ever being closed (#338)",
  "FRONTMATTER PARSER DIVERGENCE, STILL LIVE. `server/help-content.ts`'s parseFrontmatter splits on `indexOf(\":\")` and is last-wins, so an indented `  description:` or a spaced `description :` is still RENDERED as the article's description while `copy-truth.ts`'s claimSurfaces regex (`^([A-Za-z_][\\w-]*):`) does not match it — the field scores 0 gate faults and is invisible to every rule. A falsehood delivered that way ships green (#303)",
];

const eventPass = helpArticle("event-pass");
const plans = helpArticle("plans");
/** Task 14a split the old event-pass.md into three pages: what the pass is,
 *  buying one, and when one ends. Every pass-prose guard that ran over the old
 *  single article now runs over all three, each on its own. */
const buyPass = helpArticle("buy-an-event-pass");
const passEnds = helpArticle("event-pass-ends");
const PASS_PAGES: ReadonlyArray<readonly [label: string, text: string]> = [
  ["event-pass.md", eventPass],
  ["buy-an-event-pass.md", buyPass],
  ["event-pass-ends.md", passEnds],
];

/** The pass's own copy, and ONLY the pass's own copy. `plans.md` truthfully
 *  says Community is "free forever" two headings up; a permanence scan over the
 *  whole file would red on a true sentence. */
const plansPassSection = markdownSection(plans, /Event Pass/);
const feeLadderSection = markdownSection(plans, /platform fee/i);
const groupsSection = markdownSection(plans, /several organisations/i);

/** The paragraphs the GATE pins word for word. The allowlists skip them: the
 *  gate permits exactly one wording, which is stricter than any set of forms. */
const GATED = [...APPROVED_EVENT_PASS, ...APPROVED_PASS_ENDS, ...APPROVED_PLANS_PASS].map((p) => p.text);

describe("billing help articles say what the resolver enforces", () => {
  it("names the gaps it does not cover, so an unscanned article is a decision", () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
  });

  // The section extractors return null when a heading is renamed. Null must be
  // a fault, never a silently empty scan — `passBoundProseFaults("", ...)` on an
  // empty string would report clean.
  it("finds the sections every guard below scopes itself to", () => {
    expect(plansPassSection, "plans.md has no '## Event Pass' heading").not.toBeNull();
    expect(feeLadderSection, "plans.md has no platform-fee heading").not.toBeNull();
    expect(groupsSection, "plans.md has no billing-group heading").not.toBeNull();
    expect(proseBlocks(eventPass).length).toBeGreaterThan(20);
    expect(PASS_PAGES.length, "the three pass pages").toBe(3);
    for (const [label, text] of PASS_PAGES) {
      expect(proseBlocks(text).length, `${label} scans as nothing`).toBeGreaterThan(8);
    }
    expect(proseBlocks(plansPassSection!).length).toBeGreaterThan(2);
  });

  // ── THE GATE (fix round 2) ────────────────────────────────────────────────
  // Every generalising rule in this file has now been beaten by a reword — three
  // rounds, three denylists, measured 1/12 then 0/12 by people who did not write
  // them. These four paragraphs are pinned word for word instead. There is no
  // phrasing that evades this, because it is not looking at phrasing.
  // The PRIMARY gate. Measured, after the allowlist below was final: a fresh
  // adversarial set scored 6/30 while the reviewer's own set — which the rules
  // had been tuned against — scored 12/12. Four rounds of lexical rules, four
  // demonstrations that they score well only on the examples they were written
  // for. This one does not read the words at all: the pass's copy either is the
  // copy that was approved, or it is not.
  it("the pass's copy is the copy that was approved, paragraph for paragraph", () => {
    expect(inventoryFaults("event-pass.md", eventPass, APPROVED_EVENT_PASS_INVENTORY)).toEqual([]);
    expect(inventoryFaults("buy-an-event-pass.md", buyPass, APPROVED_BUY_PASS_INVENTORY)).toEqual([]);
    expect(inventoryFaults("event-pass-ends.md", passEnds, APPROVED_PASS_ENDS_INVENTORY)).toEqual([]);
    expect(
      inventoryFaults("plans.md", plans, APPROVED_PLANS_INVENTORY),
    ).toEqual([]);
  });

  // Task 14b fix round 1: the three pages split out of groups.md carry its
  // attach, detach and handover money copy, so each is pinned word for word
  // like the pass split above. NOT in GATED_ARTICLES: that set is the half-rate
  // axis, and none of these pages makes the half-rate claim.
  it("the bill pages split out of groups.md are the copy that was approved", () => {
    const pages = [
      ["add-an-organisation.md", helpArticle("add-an-organisation"), APPROVED_ADD_ORG_INVENTORY],
      ["remove-an-organisation.md", helpArticle("remove-an-organisation"), APPROVED_REMOVE_ORG_INVENTORY],
      ["hand-over-a-bill.md", helpArticle("hand-over-a-bill"), APPROVED_HANDOVER_INVENTORY],
    ] as const;
    for (const [label, text, approved] of pages) {
      expect(approved.length, `${label}: an inventory this short gates nothing`).toBeGreaterThan(8);
      expect(inventoryFaults(label, text, [...approved])).toEqual([]);
    }
    expect(pages.length).toBe(3);
  });

  it("the approved paragraphs still say exactly what was approved", () => {
    expect(goldenParagraphFaults("event-pass.md", eventPass, APPROVED_EVENT_PASS)).toEqual([]);
    expect(goldenParagraphFaults("event-pass-ends.md", passEnds, APPROVED_PASS_ENDS)).toEqual([]);
    expect(
      goldenParagraphFaults("plans.md#event-pass", plansPassSection!, APPROVED_PLANS_PASS),
    ).toEqual([]);
  });

  // ── THE ALLOWLIST (fix round 2) ───────────────────────────────────────────
  // The gate covers four paragraphs; this covers every OTHER sentence in the
  // pass's copy, which is where a new falsehood gets added. A sentence making
  // either claim must match an approved FORM — so a wording nobody predicted
  // fails by default instead of passing by default.
  it("makes every pass-duration claim in an approved form", () => {
    for (const [label, text] of PASS_PAGES) {
      expect(unapprovedClaimFaults(label, text, DURATION_ALLOWLIST, GATED), label).toEqual([]);
    }
    expect(
      unapprovedClaimFaults("plans.md#event-pass", plansPassSection!, DURATION_ALLOWLIST, GATED),
    ).toEqual([]);
  });

  it("makes every entry-fee-rate claim in an approved form", () => {
    for (const [label, text] of PASS_PAGES) {
      expect(unapprovedClaimFaults(label, text, FEE_RATE_ALLOWLIST, GATED), label).toEqual([]);
    }
    expect(unapprovedClaimFaults("plans.md", plans, FEE_RATE_ALLOWLIST, GATED)).toEqual([]);
  });

  // ANTI-VACUITY for the allowlists. A `classifies` list that drifts narrow
  // sweeps nothing in, every sentence passes, and the rule reports clean while
  // examining nothing — this wave's most repeated failure. If the real articles
  // stop exercising an approved form, either the copy or the form is dead.
  it("exercises the approved forms it offers, rather than sweeping nothing in", () => {
    // Over the three pass pages together: the split put the "stops on a named
    // condition" form on event-pass-ends.md and buy-an-event-pass.md.
    const exercised = (allowlist: typeof DURATION_ALLOWLIST) => [
      ...new Set(PASS_PAGES.flatMap(([, text]) => approvedFormsExercised(text, allowlist))),
    ];
    const duration = exercised(DURATION_ALLOWLIST);
    const fee = exercised(FEE_RATE_ALLOWLIST);
    expect(duration.length, "no duration sentence was classified at all").toBeGreaterThan(1);
    expect(fee.length, "no fee-rate sentence was classified at all").toBeGreaterThan(0);
  });

  it("quotes no retired per-division AI-run cap", () => {
    for (const [label, text] of PASS_PAGES) {
      expect(retiredRunCapProseFaults(label, text), label).toEqual([]);
    }
    expect(retiredRunCapProseFaults("plans.md", plans)).toEqual([]);
  });

  it("sells the Event Pass as bounded, and says what bounds it", () => {
    for (const [label, text] of PASS_PAGES) {
      expect(passBoundProseFaults(label, text), label).toEqual([]);
    }
    expect(passBoundProseFaults("plans.md#event-pass", plansPassSection!)).toEqual([]);
  });

  it("states the one-time credit grant, at the right size, in both articles", () => {
    expect(passCreditProseFaults("event-pass.md", eventPass)).toEqual([]);
    expect(passCreditProseFaults("plans.md#event-pass", plansPassSection!)).toEqual([]);
  });

  // The V312 fee lock, both halves. `event-pass.md` claimed twice that the fee
  // "returns to your plan's rate" when the pass stops — false for any
  // competition that has taken a paid entry, which is every competition an
  // organiser is reading this page about.
  it("never says the entry-fee rate reverts without the first-paid-entry lock", () => {
    for (const [label, text] of PASS_PAGES) {
      expect(unqualifiedFeeReversionFaults(label, text), label).toEqual([]);
    }
    expect(unqualifiedFeeReversionFaults("plans.md", plans)).toEqual([]);
  });

  // The extra-organisation rate, taken from the help article and judged against
  // the seed's real tier amounts by the SAME function that judges the Stripe
  // description (`riderRateFaults`, task 1). The claim and the arithmetic have
  // to come from different places or the comparison proves nothing.
  //
  // `plans.md` said "each one after that is half". At $19/$9 the rider is 47.4%
  // of Pro and at $39/$19 it is 48.7% of Pro Plus, so a bare "half" was false in
  // usd — while in eur and aud the halves land on whole units and it is exactly
  // half, which is why the wording is "no more than half" and not "under half".
  it("quotes an extra-organisation rate the seed's tiers actually charge", () => {
    // Task 14a: plans.md's billing-group section no longer quotes the rate — it
    // sends the reader to billing/groups.md, which does. The check follows the
    // claim to the page that makes it, and plans.md is held to making none.
    const groupsPage = helpArticleBySlug("billing/groups");
    expect(groupsSection!, "plans.md must point at the page that states the rate").toContain(
      "(/help/billing/groups)",
    );
    expect(plainProse(groupsSection!), "plans.md quotes a rider rate again").not.toMatch(
      /\bhalf\b|\$\d/,
    );
    const claimed = (stripePlans.plans as unknown as PricedPlan[]).map((plan) => ({
      ...plan,
      product: { description: plainProse(groupsPage) },
    }));
    expect(riderRateFaults(claimed)).toEqual([]);

    // Task 14b: groups.md used to spell out the usd riders ("$6.99/month"),
    // pinned here to the seed. Typed plan figures are banned in help now and a
    // price cannot be a token, so the page states the rate's SHAPE (judged
    // above against every tier) and sends the reader to the live prices. What
    // this pins instead: no typed amount in any currency comes back, the link
    // is there, and every plan still has the rider tier the shape is judged on.
    for (const plan of stripePlans.plans) {
      const rider = plan.prices.monthly.tiers.find((t) => t.up_to === "inf");
      expect(rider, `${plan.key} has no monthly rider tier`).toBeDefined();
    }
    expect(plainProse(groupsPage), "groups.md types a price again").not.toMatch(/[$€£₹]\s?\d/);
    expect(groupsPage, "groups.md must send the reader to the live prices").toContain("(/pricing)");
  });

  // Fix round 1, critical 2: round 1 shipped "a late entrant pays the same 5%
  // as the first one". The lock records what the FIRST PAID CARD ENTRY was
  // charged, so a competition that took one before its pass was bought is
  // locked at the pre-pass rate and the pass cannot lower it.
  it("never names a constant percentage as the locked rate", () => {
    for (const [label, text] of PASS_PAGES) {
      expect(lockedRateConstantFaults(label, text), label).toEqual([]);
    }
    expect(lockedRateConstantFaults("plans.md#event-pass", plansPassSection!)).toEqual([]);
  });

  it("states the lock, rather than merely omitting the false claim", () => {
    expect(feeLockStatedFaults("event-pass.md", eventPass)).toEqual([]);
    // The page a reader lands on when their pass has ended states it too.
    expect(feeLockStatedFaults("event-pass-ends.md", passEnds)).toEqual([]);

    // ANTI-VACUITY, the backstop for an all-negative rule: the check above
    // would also pass on an article that simply never mentions the fee, and the
    // one above it would pass because there was nothing left to qualify. So a
    // block must still make the reversion claim AND carry its qualifier — that
    // is the paragraph a reader with an ending pass actually needs.
    const qualified = proseBlocks(eventPass)
      .flatMap((block) => sentences(block))
      .filter((sentence) => mentionsRateAfterPass(sentence) && statesFeeLock(sentence));
    expect(
      qualified.length,
      "no block both states what happens to the rate and qualifies it — the guards above are passing on silence",
    ).toBeGreaterThan(0);
  });
});

// The two KNOWN_GAPS entries #303 actually fixed — closed as real scans rather
// than left as prose that merely LOOKS corrected. "Trust the code, not the
// drifted line number" applies here too: `helpArticle`/`helpArticleBySlug`
// throw on a missing/empty file, so a moved or emptied article reds instead of
// silently scanning nothing.
describe("billing/downgrade.md is gated too (#303)", () => {
  const downgrade = helpArticle("downgrade");

  it("never says the entry-fee rate reverts without the first-paid-entry lock", () => {
    expect(unqualifiedFeeReversionFaults("downgrade.md", downgrade)).toEqual([]);
  });

  it("states the lock, rather than merely omitting the false claim", () => {
    expect(feeLockStatedFaults("downgrade.md", downgrade)).toEqual([]);

    // ANTI-VACUITY, same shape as the event-pass/plans check above.
    const qualified = proseBlocks(downgrade)
      .flatMap((block) => sentences(block))
      .filter((sentence) => mentionsRateAfterPass(sentence) && statesFeeLock(sentence));
    expect(
      qualified.length,
      "no block both states what happens to the rate and qualifies it — the guards above are passing on silence",
    ).toBeGreaterThan(0);
  });

  it("quotes no retired per-division AI-run cap", () => {
    expect(retiredRunCapProseFaults("downgrade.md", downgrade)).toEqual([]);
  });

  // MUTATION PROOF: the exact unqualified sentence #303 found at line 28
  // ("back on Community the rate returns to 8%", no V312 qualifier) must red
  // both guards above — this is what "the guard would have caught it" means,
  // demonstrated rather than asserted.
  it("reds on the exact unqualified sentence #303 found", () => {
    const reverted = downgrade.replace(
      /What can change is the platform fee\.[\s\S]*?follows Community's rate\./,
      "What changes is the platform fee: back on Community the rate returns to **8%**, where Pro is 2% and Pro Plus 1%. See the fee ladder.\n\n**Passed competitions keep their own rate.** A competition covered by an Event Pass stays at **5%** after the downgrade, and keeps everything else the pass grants — bigger limits, branded exports, sponsor tiers and packages — while the rest of the org sits on Community.",
    );
    expect(reverted, "the replacement never matched — the article moved").not.toBe(downgrade);
    expect(unqualifiedFeeReversionFaults("x", reverted)).not.toEqual([]);
    expect(feeLockStatedFaults("x", reverted)).not.toEqual([]);
  });
});

// The AI Schedule article was split by task (help programme, Task 11a). The gates
// below ran on `scheduling/ai-scheduling` alone; they now run on EVERY page the
// split produced, so a retired cap or an "unmetered" claim cannot hide in one of
// the new pages. `AI_SCHEDULING_PAGES.length` is pinned so a page dropped from
// the list (or from the tree) is a red, never a smaller green.
const AI_SCHEDULING_PAGES = [
  "scheduling/ai-scheduling",
  "scheduling/ai-instructions",
  "scheduling/ai-dates",
  "scheduling/ai-review",
  "scheduling/ai-credits",
  "scheduling/ai-several-divisions",
] as const;

describe("the AI Schedule pages are gated too (#303)", () => {
  // The joint page carries the #391 hourly-limit sentence checked further down.
  const aiScheduling = helpArticleBySlug("scheduling/ai-several-divisions");
  const pages = AI_SCHEDULING_PAGES.map((slug) => ({ slug, text: helpArticleBySlug(slug) }));

  it("covers all six pages, each with prose to scan", () => {
    expect(pages).toHaveLength(6);
    for (const p of pages) expect(p.text.length, p.slug).toBeGreaterThan(1000);
  });

  it("quotes no retired per-division AI-run cap", () => {
    for (const p of pages) expect(retiredRunCapProseFaults(`${p.slug}.md`, p.text), p.slug).toEqual([]);
  });

  it("never claims an AI run — schedule or officials — is unmetered", () => {
    for (const p of pages) expect(unmeteredAiRunProseFaults(`${p.slug}.md`, p.text), p.slug).toEqual([]);
  });

  // MUTATION PROOF, both halves #303 found: the retired lifetime-quota table,
  // and "Officials AI runs are not metered".
  it("reds on the exact retired table and the exact unmetered claim #303 found", () => {
    const oldTable = `## Run quotas

AI Schedule needs no upgrade — it runs on **every plan, Community included**. What your plan sets is how many times you can run it: each **schedule generation** counts against a per-division quota.

| Plan | AI schedule generations per division |
| --- | --- |
| Community | 5 |
| Event Pass | 10 |
| Pro | 20 |
| Pro Plus | 50 |

The quota is a **lifetime total per division** — it doesn't reset weekly or monthly, and a new division starts a fresh count. Refine and repair each use one generation. A run that fails or times out **does not** count. Separately, every plan has a burst brake of **5 AI runs per hour per division**. **Officials AI runs are not metered** — once you have automatic officials assignment, you can restaff as often as you like.`;
    expect(retiredRunCapProseFaults("x", oldTable)).not.toEqual([]);
    expect(unmeteredAiRunProseFaults("x", oldTable)).not.toEqual([]);
  });

  // ── #391: the JOINT run's own burst brake ───────────────────────────────────
  //
  // `rateLimit('ai-plan-competition:' + competitionId, { max: 3, windowSeconds:
  // 3600 })` (server/usecases/competition-schedule-ai/) is a second, tighter
  // brake keyed to a DIFFERENT subject than the documented per-division 5/hour.
  // The article named both single-division brakes and was silent about this one,
  // which reads as "same as above" to an organiser who has just been refused.
  //
  // Scoped to ONE SENTENCE, not to the article. The obvious form —
  // `expect(aiScheduling).toMatch(/competition/i)` — is vacuous here: the article
  // already says "competition" a dozen times about the board, the window and the
  // fee. A limit is a claim only if one sentence carries the number AND its
  // subject; split across paragraphs it is two half-claims a reader can't join.
  const jointHourlyClaims = (md: string): string[] =>
    claimTexts(md)
      .flatMap(sentences)
      .filter((s) => /\bjoint\b/i.test(s) && /\b(?:an?|per|every)\s+hour\b/i.test(s));

  it("states the joint run's own hourly limit, and that it is competition-keyed (#391)", () => {
    const claims = jointHourlyClaims(aiScheduling);
    // The number follows the code: if `max` is retuned, this article is wrong
    // and the fix is the article, never the assertion.
    const claim = claims.find((s) => /\b3\b/.test(s) && /\bcompetition\b/i.test(s));
    expect(
      claim,
      `no sentence states the joint 3-an-hour, per-competition brake. Sentences naming a joint hourly limit: ${JSON.stringify(claims)}`,
    ).toBeDefined();
  });

  // ANTI-VACUITY for the above: the block as it stood before #391 — two bullets
  // that documented the other two joint limits — yields no claim at all. Without
  // this, a mis-globbed article or a helper that matches nothing reads as "the
  // limit is documented".
  it("finds no joint hourly claim in the two-bullet block #391 replaced", () => {
    const beforeChange = `Two more limits worth knowing:

- A joint run needs **at least two divisions**. To schedule one on its own, open its own schedule page.
- The whole run is capped at **500 fixtures to place**, the same ceiling a single division has. Over that, run the divisions in smaller groups.`;
    expect(jointHourlyClaims(beforeChange)).toEqual([]);
  });
});

// ── #392: the joint UNDO is not all-or-nothing ────────────────────────────────
//
// The apply is atomic; the undo is not. After #386 it is ONE competition-scoped
// call that rewinds every division under one lock — but it reports per-division
// failures rather than rolling the successes back, so "one undo puts the whole
// thing back" stays a lie in the direction that costs the organiser work. The
// article carried that sentence once, it was corrected, and nothing stopped it
// coming back.
describe("joint undo copy guard (#392)", () => {
  const aiScheduling = helpArticleBySlug("scheduling/ai-several-divisions");

  it("fires on the sentence that was actually wrong", () => {
    expect(
      jointUndoFaults(
        "x",
        "Each division gets its own before-AI save point, so one undo puts the whole thing back.",
      ),
    ).not.toEqual([]);
  });

  it("fires on the synonyms an editor would reach for", () => {
    for (const s of [
      "A single undo restores every division at once.",
      "One click puts all the divisions back.",
      "Undo rolls back the whole joint apply in one step.",
      "One restore puts both divisions back.",
      "Undo reverses the entire run.",
      "Every division is put back at once.",
    ]) {
      expect(jointUndoFaults("x", s), s).not.toEqual([]);
    }
  });

  // Fix round 3's lesson, applied ahead of time: this rule reads HEADINGS and
  // frontmatter as well as prose, because that is where a falsehood was hidden
  // last time and because `description:` is rendered as the lead paragraph.
  it("fires on the same claim made in a heading or in frontmatter", () => {
    expect(jointUndoFaults("x", "## One undo puts the whole thing back\n")).not.toEqual([]);
    expect(
      jointUndoFaults("x", "---\ndescription: A single undo restores every division at once.\n---\n\nBody.\n"),
    ).not.toEqual([]);
  });

  // The OTHER falsehood in the same family, and the live one: until #386 the
  // undo really was a browser loop over per-division restores, and the article
  // said so. It is now one competition-scoped call. A sentence describing the
  // retired loop is as false as the all-or-nothing one and fails in the same
  // direction — it tells the organiser a half-finished undo is expected.
  it("fires on copy describing the retired per-division undo loop", () => {
    for (const s of [
      "Each division gets its own before-AI save point, and undo restores them one at a time rather than in a single step.",
      "Undo puts the divisions back one by one.",
      "The console sends one request per division when you undo.",
      "Undo makes a separate restore for each division.",
    ]) {
      expect(jointUndoFaults("x", s), s).not.toEqual([]);
    }
  });

  it("does not fire on the true sentence", () => {
    expect(
      jointUndoFaults(
        "x",
        "Each division gets its own before-AI save point, and a restore that fails doesn't stop the rest going back.",
      ),
    ).toEqual([]);
  });

  // The SCOPE half. A single-division undo really does put everything back in
  // one step, and `scheduling/undo.md` says so; a guard that bans the true
  // sentence gets worked around rather than obeyed.
  it("does not fire on true single-division undo copy", () => {
    for (const s of [
      "It first creates a before-AI save point, so undo puts everything back exactly as it was.",
      "Undo steps back one change, redo steps forward.",
      "Restore rewinds the schedule to the bookmark by undoing each change since, one by one.",
      // The two the first draft of the patterns caught, both TRUE and both from
      // this same article. They are why the rule is gated on an undo/restore
      // subject rather than on plurality alone.
      "Applying writes every division together — all of them or none.",
      "Those three divisions get the budget 6 credits buys while being charged 5 — the batch discount lowers the price, never the capability, so scheduling divisions together is never a worse deal than scheduling them one at a time.",
    ]) {
      expect(jointUndoFaults("x", s), s).toEqual([]);
    }
    expect(jointUndoFaults("undo.md", helpArticleBySlug("scheduling/undo"))).toEqual([]);
  });

  it("returns nothing, and does not throw, on an empty or claim-free corpus", () => {
    expect(jointUndoFaults("x", "")).toEqual([]);
    expect(jointUndoFaults("x", "# Courts\n\nA court is the label you typed in.\n")).toEqual([]);
  });

  it("the real article is clean", () => {
    // ANTI-VACUITY, the thing this whole describe exists for: a scan over an
    // empty corpus finds nothing and reads exactly like a scan over a clean
    // one. So pin that the article loaded, that it splits into sentences, and
    // that some of those sentences are about undo — i.e. there was something
    // here to be wrong.
    expect(aiScheduling.length).toBeGreaterThan(1000);
    const undoSentences = claimTexts(aiScheduling)
      .flatMap(sentences)
      .filter((s) => /\bundo\b/i.test(s));
    expect(undoSentences.length).toBeGreaterThan(2);
    expect(jointUndoFaults("ai-several-divisions.md", aiScheduling)).toEqual([]);
    // …and the claim cannot come back in any sibling page either.
    for (const slug of AI_SCHEDULING_PAGES) {
      expect(jointUndoFaults(`${slug}.md`, helpArticleBySlug(slug)), slug).toEqual([]);
    }
  });

  // MUTATION PROOF against the article itself: the paragraph as it read before
  // this guard existed must be caught by it.
  it("reds on the joint-undo paragraph the article used to carry", () => {
    const oldParagraph =
      "Undo works the other way round. Each division gets its own **before-AI** save point, so one undo puts the whole thing back.";
    expect(jointUndoFaults("ai-scheduling.md", oldParagraph)).not.toEqual([]);
  });
});

describe("scheduling/ai-officials.md is gated too (#365)", () => {
  const aiOfficials = helpArticleBySlug("scheduling/ai-officials");

  it("never claims AI Officials needs Pro Plus", () => {
    expect(aiOfficialsPlanGateFaults("ai-officials.md", aiOfficials)).toEqual([]);
  });

  it("never claims an AI run — schedule or officials — is unmetered", () => {
    expect(unmeteredAiRunProseFaults("ai-officials.md", aiOfficials)).toEqual([]);
  });

  // MUTATION PROOF, half 1 of #365: the exact "Automatic officials assignment
  // is a Pro Plus feature" sentence, established false against officials-ai.ts
  // and against plan_entitlements (the ONLY row for officials.auto is
  // pro_plus-only, and that gate lives in a different function, officials.ts's
  // autoAssignOfficials/applyOfficialAssignments).
  //
  // `officialsAiPlanForDivision` does hold ONE `requireFeature` —
  // `officials.roles_multi`, and only when the policy names more than one role
  // (officials-ai.ts:1037). It is not a plan gate in practice: V319 opened that
  // key on every plan including community, which is what makes the replacement
  // sentence true. Since the claim now rests on a matrix ROW rather than on the
  // absence of a call, the describe below pins the row.
  it("reds on the exact Pro-Plus-gate sentence #365 found", () => {
    const reverted = aiOfficials.replace(
      /You can draft and review on every plan\. Saving the officials when you apply needs [^\n]*?the same as \*\*Propose\*\* on the \[Officials tab\]\(\/help\/scheduling\/officials-assign\)\./,
      "Automatic officials assignment is a **Pro Plus** feature.",
    );
    expect(reverted, "the replacement never matched — the article moved").not.toBe(aiOfficials);
    expect(aiOfficialsPlanGateFaults("x", reverted)).not.toEqual([]);
  });

  // MUTATION PROOF, half 2 of #365: the exact "officials AI runs are not
  // metered … restaff as often as you like … effectively free" sentence —
  // established false against credits.ts's spendCredit, whose reserve/settle
  // wraps officialsAiPlanForDivision's ENTIRE call, including the
  // no-instruction default spread that makes no model call.
  it("reds on the exact unmetered sentence #365 found", () => {
    const reverted = aiOfficials.replace(
      /## What a run costs\n\n[\s\S]*?(?=\n\n## Review and apply)/,
      `## Run quotas

Unlike schedule generations, **officials AI runs are not metered** — restaff as often as you like. The empty-instruction default spread is produced without a model call at all, so it's effectively free.`,
    );
    expect(reverted, "the replacement never matched — the article moved").not.toBe(aiOfficials);
    expect(unmeteredAiRunProseFaults("x", reverted)).not.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #382 review, finding 4 — scheduling/ai-scheduling.md and what V353 opened.
//
// "The multi-division board is a **Pro** feature." was true when it was
// written. V353 granted `scheduling.multi_division` to `event_pass` and
// `event_pass_l`, and turned `scheduling.board`/`scheduling.constraints` on for
// every plan key. So the sentence named the one door that costs $29/month while
// the $29 ONE-TIME door — the pass, which lifts it for this competition — went
// unmentioned, and it implied the board itself was paid when it is not.
//
// The same lost-sale shape as the upgrade card in `dictionary-copy-truth`: the
// reader of this paragraph is an organiser who has just been stopped.
// ─────────────────────────────────────────────────────────────────────────────
describe("the AI Schedule pages gate the joint board on no plan at all", () => {
  const aiScheduling = helpArticleBySlug("scheduling/ai-several-divisions");

  it("never names a plan as a way to plan several divisions together", () => {
    for (const slug of AI_SCHEDULING_PAGES) {
      expect(multiDivisionBoardPlanGateFaults(`${slug}.md`, helpArticleBySlug(slug)), slug).toEqual([]);
    }
  });

  // MUTATION PROOF: the exact sentence #382's review found, restored. Without
  // this the guard above could be inert and read as clean.
  it("reds on the exact Pro-only sentence #382 found", () => {
    const reverted = aiScheduling.replace(
      // The anchor moved in W2: the sentence used to begin "Planning several
      // divisions together needs **Pro**, or this competition's **Event
      // Pass**". V393 made the key free on every plan, so the article gates
      // nothing and the anchor is the sentence that replaced it.
      /It is available on every plan, Community included\.[^\n]*/,
      "The multi-division board is a **Pro** feature.",
    );
    expect(reverted, "the replacement never matched — the article moved").not.toBe(aiScheduling);
    expect(multiDivisionBoardPlanGateFaults("x", reverted).join(" | ")).toContain(
      "names Pro as a way to plan several divisions together",
    );
  });

  // …and the SECOND falsehood V353 created, which the first rule cannot see:
  // the board itself sold as paid. Its own patterns, no pass exemption, because
  // naming the pass would not make it true.
  it("reds on a sentence gating the board itself on a plan", () => {
    for (const sentence of [
      "The schedule board is a **Pro** feature.",
      "The drag-and-drop board is a paid feature.",
      "The scheduling board requires **Pro**.",
      "You need to upgrade to Pro to use the schedule board.",
    ]) {
      expect(
        multiDivisionBoardPlanGateFaults("x", `# T\n\n${sentence}\n`).join(" | "),
        sentence,
      ).toContain("gates the schedule board on a plan");
    }
  });

  // INVERTED in W2 (entitlements v18). Naming the Event Pass used to CLEAR
  // this rule, because Pro and the pass were the two doors. V393 granted
  // `scheduling.multi_division` to community, so there is no door: both
  // sentences below are false now and both must red. The exemption is deleted
  // rather than left unexercised — an exemption whose premise has moved is a
  // hiding place, and this is the sentence someone would write to use it.
  it("no plan gate clears the guard — naming the Event Pass does not either", () => {
    const withoutPass = "# T\n\nPlanning several divisions together needs **Pro**.\n";
    const withPass =
      "# T\n\nPlanning several divisions together needs **Pro**, or this competition's **Event Pass**.\n";
    expect(multiDivisionBoardPlanGateFaults("x", withoutPass)).not.toEqual([]);
    expect(multiDivisionBoardPlanGateFaults("x", withPass)).not.toEqual([]);
    // …and the guard still has an OFF state, or "everything reds" would pass
    // this test just as well: the shipped article, which gates nothing.
    expect(multiDivisionBoardPlanGateFaults("ai-several-divisions.md", aiScheduling)).toEqual([]);
  });
});

/**
 * The matrix half of #382's finding 4, the same pairing `ai-officials.md` gets
 * above: the vocabulary scan forbids the false sentence coming back, but only a
 * row read can notice the article going stale again because the DATA moved. It
 * became wrong that way once already — V353 changed no TypeScript at all.
 */
describe.skipIf(!HAS_DB)("the AI pages' joint-board claim is the matrix's (#382)", () => {
  it("the pass lifts scheduling.multi_division, and the board is open to all", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key in ('scheduling.multi_division', 'scheduling.board')
      order by feature_key, plan_key`;
    // Canary: a typo'd key would return nothing and every assertion below would
    // pass vacuously.
    expect(rows.length, "no scheduling rows — the keys moved").toBeGreaterThan(6);
    const grant = (feature: string, plan: string) =>
      rows.find((r) => r.feature_key === feature && r.plan_key === plan)?.bool_value === true;

    // WHY THE ARTICLE MAY GATE NOTHING. This assertion is inverted from what it
    // was: community used to be false, which is what made "needs Pro, or this
    // competition's Event Pass" true and the guard's pass-exemption sensible.
    // V393 (entitlements v18 W2 T1) granted the key to community, so joint
    // planning is free on every plan and every plan gate on it is now false.
    for (const plan of ["community", "event_pass", "event_pass_l", "pro", "enterprise"]) {
      expect(grant("scheduling.multi_division", plan), `multi_division on ${plan}`).toBe(true);
    }
    // Why the board itself may not be described as paid.
    for (const plan of ["community", "event_pass", "event_pass_l", "pro", "enterprise"]) {
      expect(grant("scheduling.board", plan), `scheduling.board on ${plan}`).toBe(true);
    }
  });
});

/**
 * The "every plan, Community included" half of #365, pinned to the matrix
 * rather than to prose.
 *
 * The two guards above are VOCABULARY scans: they forbid the false sentence
 * from coming back. Neither can notice the opposite failure — the sentence
 * staying word-for-word identical while the thing it describes changes
 * underneath it. That is precisely how the article became wrong the first time.
 *
 * `officials.roles_multi` is the one entitlement `officialsAiPlanForDivision`
 * requires (and only for a multi-role policy). V319 set it true on every plan,
 * community included, which is what makes "it needs no upgrade" true today. Put
 * it back behind a paid tier and the article is false again with no edit to it,
 * so the row is what this asserts.
 */
describe.skipIf(!HAS_DB)("ai-officials.md's 'every plan' claim is the matrix's (#365)", () => {
  it("officials.roles_multi is open on every plan the matrix carries", async () => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements
      where feature_key = 'officials.roles_multi' order by plan_key`;
    // Canary: a typo'd feature key would return zero rows and every assertion
    // below would pass vacuously.
    expect(rows.length, "no officials.roles_multi rows — the gate's key moved").toBeGreaterThan(3);
    expect(
      rows.map((r) => r.plan_key),
      "the article names Community by name",
    ).toContain("community");
    expect(
      rows.filter((r) => r.bool_value !== true).map((r) => r.plan_key),
      "ai-officials.md says AI Officials runs on every plan — these plans no longer allow it",
    ).toEqual([]);
  });

  // The other half of the page's claim: SAVING the officials needs `officials.auto` (applyOfficialAssignments calls
  // requireFeature on it — the AI console's apply posts to the same route). The page says Pro, Enterprise or an Event
  // Pass can save, and Community cannot. Read from the matrix, never typed here.
  it("officials.auto is on for Pro, Enterprise and the Event Pass and off for Community", async () => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements
      where feature_key = 'officials.auto' order by plan_key`;
    expect(rows.length, "no officials.auto rows — the gate's key moved").toBeGreaterThan(3);
    const on = (plan: string) => rows.find((r) => r.plan_key === plan)?.bool_value === true;
    for (const plan of ["pro", "enterprise", "event_pass", "event_pass_l"]) {
      expect(on(plan), `ai-officials.md says ${plan} can save officials on apply`).toBe(true);
    }
    expect(on("community"), "ai-officials.md says Community cannot save officials on apply").toBe(false);
  });
});

/**
 * TREE-WIDE, #365. `unmeteredAiRunProseFaults` was invoked on exactly one
 * named article — `ai-scheduling.md` — until this task, which is precisely how
 * `ai-officials.md` carried the SAME false claim, untouched, since #303. Rather
 * than add a second name to a list (the shape that missed it the first time),
 * this scans EVERY article `allHelpArticles()` returns, so a THIRD copy of the
 * claim reds this suite on its own, wherever it lands, without anyone adding
 * its filename here first.
 *
 * `aiOfficialsPlanGateFaults` (the Pro-Plus-gate half of #365) is DELIBERATELY
 * NOT included in this tree-wide scan — see its JSDoc in `copy-truth.ts`:
 * `officials.md` states an almost identically worded TRUE claim about a
 * different, deterministic gate, and a vocabulary broad enough to catch the
 * false claim here would also catch that true one. That guard stays scoped to
 * `ai-officials.md` by name (above), which is the honest fix for a claim whose
 * truth depends on which article is making it, not on the words alone.
 */
const unmeteredFaultsAcrossTree = (
  extra: Array<{ slug: string; text: string }> = [],
): string[] => {
  const faults: string[] = [];
  for (const article of allHelpArticles().values()) {
    faults.push(...unmeteredAiRunProseFaults(`${article.slug}.md`, helpArticleBySlug(article.slug)));
  }
  for (const e of extra) {
    faults.push(...unmeteredAiRunProseFaults(`${e.slug}.md`, e.text));
  }
  return faults;
};

describe("no help article anywhere claims an AI run is unmetered/free (#365)", () => {
  it("the tree, as it stands today, makes the claim nowhere", () => {
    expect(unmeteredFaultsAcrossTree()).toEqual([]);
  });

  // ANTI-VACUITY, the point of scanning the tree rather than a list: a THIRD
  // copy of the claim, in an article nobody named here, must still red.
  it("would catch a third copy of the claim, in an article this list never named", () => {
    const faults = unmeteredFaultsAcrossTree([
      {
        slug: "some/other-article-nobody-named",
        text: "Officials AI runs are not metered on any plan — restaff as often as you like.",
      },
    ]);
    expect(faults.join(" ")).toContain("unmetered");
  });
});

describe.skipIf(!HAS_DB)("billing help articles quote the numbers the matrix enforces", () => {
  const capFor = async (feature: string, plan: string): Promise<number | null> => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
      where plan_key = ${plan} and feature_key = ${feature}`;
    expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
    return row!.int_value;
  };

  /**
   * Which ladder labels each published fee table must carry.
   *
   * A table absent from this map is required to carry ALL of them — the safe
   * default — so a NEW article growing a fee ladder is checked in full the day
   * it lands, and only a deliberate subset needs a line here.
   */
  const LADDER_REQUIREMENTS: Record<string, { require: string[]; why: string }> = {
    "billing/groups": {
      require: ["Community", "Pro", "Enterprise"],
      why: "the column is 'The group's plan'. An Event Pass upgrades ONE COMPETITION and is not a plan a billing group can sit on, so a row for it would be a falsehood rather than a completeness win — the article's own next line is 'Community holds 1 and Pro holds 5'.",
    },
  };

  it("EVERY published fee ladder is the fee the matrix charges, row for row", async () => {
    // WIDENED W3 (2026-09-04). This called `feeLadderFaults` on ONE section of
    // ONE article — `markdownSection(plans.md, /platform fee/i)` — while
    // `billing/groups.md` and `registration/card-payments.md` carried their own
    // copies of the same table. Both still read "| Pro Plus | 1% |" a whole
    // wave after plans.md had been corrected, because nothing pointed the rule
    // at them. The guard looked authoritative; its SCOPE lived at this call
    // site, hundreds of lines from the function.
    //
    // The sweep is by SHAPE, over every article `allHelpArticles()` returns —
    // never a filename list, which is the same mistake one level up.
    const live: Record<string, number | null> = {};
    for (const keys of Object.values(FEE_LADDER_PLAN_KEYS)) {
      for (const key of keys) live[key] = await capFor("registration.fee_percent", key);
    }

    const found: Array<{ slug: string; rows: number }> = [];
    const faults: string[] = [];
    for (const article of allHelpArticles().values()) {
      // RAW markdown, frontmatter included — `allHelpArticles` has stripped it,
      // and a fee table could as easily sit in a `description`.
      for (const table of feeLadderTables(helpArticleBySlug(article.slug))) {
        found.push({ slug: article.slug, rows: table.rows.length });
        const spec = LADDER_REQUIREMENTS[article.slug];
        for (const fault of feeLadderFaults(table.rows, live, spec?.require)) {
          faults.push(`${article.slug}: ${fault}`);
        }
      }
    }
    expect(faults).toEqual([]);

    // ── ANTI-VACUITY, because every line above is a loop ────────────────────
    // A sweep that matched nothing reports exactly what a clean tree reports.
    // Three articles publish this table today (plans, groups, card-payments);
    // the floor is stated as a floor so a FOURTH is a pass, not a red.
    expect(
      found.length,
      `fewer than three fee ladders found — the sweep has gone blind (found: ${JSON.stringify(found)})`,
    ).toBeGreaterThanOrEqual(3);
    expect(new Set(found.map((f) => f.slug)).size, "one article, scanned repeatedly").toBeGreaterThanOrEqual(3);
    for (const f of found) {
      expect(f.rows, `${f.slug}: a fee table with fewer than three rows is a shape change`).toBeGreaterThanOrEqual(3);
    }
    // …and every declared subset must name a table that EXISTS, or the
    // exemption is a licence for an article nobody publishes.
    for (const slug of Object.keys(LADDER_REQUIREMENTS)) {
      expect(found.some((f) => f.slug === slug), `${slug} declares a ladder subset but publishes no ladder`).toBe(true);
    }
  });

  /**
   * A TOKEN COMPARISON TABLE, read by its pairing. Task 14a moved the plan
   * figures in these tables to `{{plan:<feature>:<plan>}}` tokens, so a cell is
   * the live value by construction — what can still be wrong is WHICH token sits
   * in which cell. Each row label names a feature and each column header names
   * a plan; every cell must be that feature on that plan, or the literal "No
   * limit" where the matrix row is null. Returns the cells it compared so the
   * caller can prove it read something.
   */
  const ROW_FEATURES: ReadonlyArray<readonly [RegExp, string]> = [
    [/^active competitions$/i, "competitions.max_active"],
    [/^divisions/i, "divisions.per_competition.max"],
    [/^entrants per division$/i, "entrants.per_division.max"],
    [/^team members$/i, "members.max"],
    [/^public dashboards$/i, "dashboard.public.max"],
    [/^organisations on one bill$/i, "orgs.max_owned"],
    [/^ai credits a month$/i, "ai.credits.monthly"],
    [/^free match credits a month$/i, "streaming.credits.monthly"],
    [/^platform fee/i, "registration.fee_percent"],
  ];
  const tokenTableCells = async (label: string, markdown: string) => {
    const faults: string[] = [];
    const compared: string[] = [];
    let header: string[] | null = null;
    for (const line of markdown.split("\n")) {
      if (!line.trimStart().startsWith("|")) {
        header = null;
        continue;
      }
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (/^-+$/.test(cells[1] ?? "")) continue;
      if (header === null) {
        header = cells;
        continue;
      }
      // Two shapes (review m12): a FEATURE per row with a PLAN per column
      // (plans.md's limits, event-pass.md's comparison), or a PLAN per row with
      // a FEATURE per column (credits.md, match-credits.md, the fee ladder).
      const rowFeature = ROW_FEATURES.find(([re]) => re.test(cells[0] ?? ""))?.[1];
      const rowPlan = PLAN_KEY_BY_LABEL[cells[0] ?? ""];
      if (!rowFeature && !rowPlan) continue;
      for (let col = 1; col < cells.length; col++) {
        const feature = rowFeature ?? ROW_FEATURES.find(([re]) => re.test(header![col] ?? ""))?.[1];
        const planKey = rowFeature ? PLAN_KEY_BY_LABEL[header[col] ?? ""] : rowPlan;
        if (!feature || !planKey) continue;
        const cell = cells[col]!;
        const where = `${label}: "${cells[0]}" / ${header[col]}`;
        compared.push(where);
        const live = await capFor(feature, planKey);
        if (live === null) {
          if (!/^no limit$/i.test(cell)) faults.push(`${where} says "${cell}", but ${feature} is unlimited on ${planKey}`);
          continue;
        }
        // A token may be followed by words ("… for each organisation the
        // subscription pays for"), never preceded by a figure.
        const token = /^\{\{plan:([\w.]+):(\w+)\}\}%?(?:\s.*)?$/.exec(cell);
        if (!token) {
          faults.push(`${where} says "${cell}" — a figure here must be the {{plan:${feature}:${planKey}}} token`);
        } else if (token[1] !== feature || token[2] !== planKey) {
          faults.push(`${where} carries {{plan:${token[1]}:${token[2]}}}, but the row and column name ${feature} on ${planKey}`);
        }
      }
    }
    return { faults, compared };
  };

  // Was "the transposed pass fee row quotes the rate every rung on sale
  // enforces", over a one-column pass table. event-pass.md's table now compares
  // Community, Event Pass and Pro side by side, so the fee row is read by
  // column: the Event Pass cell must be the pass's own rate, and its neighbours
  // their own plans'.
  it("the pass comparison table pairs every cell with its own plan's live value", async () => {
    const { faults, compared } = await tokenTableCells("event-pass.md", eventPass);
    expect(faults).toEqual([]);
    // ANTI-VACUITY: three rows (divisions, entrants, platform fee) by three plans.
    expect(compared.length, "the comparison table was not read").toBe(9);
    expect(compared.filter((c) => c.includes("/ Event Pass")), "no Event Pass column").toHaveLength(3);
    // …and the Event Pass column is the rung on sale, read off the resolved page.
    const resolved = resolveHelpTokens(eventPass, await loadPricingMatrix());
    const feeRow = resolved.split("\n").find((l) => /^\|\s*Platform fee/i.test(l));
    expect(feeRow, "the fee row moved").toBeDefined();
    for (const key of SELLABLE_PASS_KEYS) {
      expect(feeRow!.split("|").map((c) => c.trim())[3], `${key}'s rate`).toBe(
        `${await capFor("registration.fee_percent", key)}%`,
      );
    }
  });

  it("plans.md's limits table pairs every cell with its own plan's live value", async () => {
    const { faults, compared } = await tokenTableCells("plans.md", plans);
    expect(faults).toEqual([]);
    // Eight rows by three plans, plus the fee ladder's four plan rows.
    expect(compared.length, "the limits table was not read").toBe(28);
  });

  it("the per-plan credit tables pair every cell with its own plan's live value (review m12)", async () => {
    for (const slug of ["credits", "match-credits"]) {
      const { faults, compared } = await tokenTableCells(`${slug}.md`, helpArticle(slug));
      expect(faults, slug).toEqual([]);
      // Community, Pro and Enterprise, one column each.
      expect(compared.length, `${slug}: the per-plan table was not read`).toBe(3);
    }
  });

  it("the Event Pass articles quote the live caps of the rungs on sale, and no others", async () => {
    // Read RESOLVED: the pages carry tokens, and a reader sees the numbers.
    const matrix = await loadPricingMatrix();
    const m = {
      entrants: await capFor("entrants.per_division.max", "event_pass"),
      divisions: await capFor("divisions.per_competition.max", "event_pass"),
    };
    const l = {
      entrants: await capFor("entrants.per_division.max", "event_pass_l"),
      divisions: await capFor("divisions.per_competition.max", "event_pass_l"),
    };
    // INVERTED by V393, which gave L a real 512-entrant cap where it had been
    // null. The word was the claim for as long as the row was null; now the
    // NUMBER is, and the word is the defect — asserted in both directions so a
    // page cannot carry "512 entrants" and "unlimited entrants" together. Kept
    // even though L is off sale: it is a claim about the SEED, and the rung is
    // dormant rather than deleted.
    expect(l.entrants, "L's entrant cap is a number since V393").not.toBeNull();
    // Anti-vacuity for the negatives below: the two rungs' figures differ, so
    // "the article does not quote L's numbers" cannot be satisfied by L and M
    // sharing a cap.
    expect(l.entrants).not.toBe(m.entrants);
    expect(l.divisions).not.toBe(m.divisions);

    for (const [label, text] of [
      ["event-pass.md", resolveHelpTokens(eventPass, matrix)],
      ["plans.md#event-pass", resolveHelpTokens(plansPassSection!, matrix)],
    ] as const) {
      expect(text, `${label}: M's entrant cap`).toContain(`${m.entrants} entrants`);
      expect(text, `${label}: M's division cap`).toContain(`${m.divisions} divisions`);
      // …and NOT the withdrawn rung's, which are the only reason a reader would
      // want it. An article that still lists 512 entrants is still selling L,
      // whatever the checkout does (owner decision 2026-09-05).
      expect(text, `${label}: L's division cap is off sale`).not.toContain(`${l.divisions} divisions`);
      expect(text, `${label}: L's entrant cap is off sale`).not.toContain(`${l.entrants} entrants`);
      expect(text, `${label}: no rung is described as uncapped`).not.toMatch(/\bunlimited\s+entrants\b/i);
      // ...and the same claim again, for the shape the regex above CANNOT see.
      // A prose sentence puts the two words together; a TABLE puts the noun in
      // the row label and the value in a cell, so "Entrants per division | 128 |
      // Unlimited" never matches `unlimited\s+entrants` and sailed through this
      // very assertion. That is not hypothetical: it shipped fourteen lines
      // above a bullet this wave had already corrected to 512, in the flagship
      // M-vs-L comparison table, in a row-set three of whose other rows were
      // edited at the same time. Row-label semantics, not word adjacency.
      expect(uncappedEntrantCells(text), `${label}: an entrants ROW still says unlimited`).toEqual(
        [],
      );
    }
  });

  // Markdown table rows whose LABEL cell names entrants, but whose value cells
  // claim no limit. Returns the offending "label: value" pairs so the failure
  // names the row rather than just asserting a boolean.
  const uncappedEntrantCells = (text: string): string[] => {
    const faults: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trimStart().startsWith("|")) continue;
      const [, label, ...values] = line.split("|").map((c) => c.trim());
      if (!label || !/entrant/i.test(label)) continue;
      for (const value of values) {
        if (/^(unlimited|unbounded|no limit|∞)$/i.test(value)) faults.push(`${label}: ${value}`);
      }
    }
    return faults;
  };

  // "the 'Community allows N' comparisons are Community's live caps" lived
  // here. event-pass.md no longer makes the comparison in prose: it is the
  // Community column of the comparison table, read cell by cell — against its
  // own plan, not the pass's — by the pairing test above.

  it("every monthly AI credit figure in plans.md is that plan's live grant", async () => {
    // `enterprise`, not `pro_plus`: V393 deleted that plan and moved the top
    // grant onto enterprise (500, re-cut from 200 in the same wave).
    // The monthly figures are the "AI credits a month" row of plans.md's limits
    // table; the pairing test above reads each cell against its own plan.
    const row = plans.split("\n").find((l) => /^\|\s*AI credits a month\s*\|/.test(l));
    expect(row, "plans.md lost its AI credits row").toBeDefined();
    for (const key of ["community", "pro", "enterprise"]) {
      expect(row, `${key}'s monthly grant`).toContain(`{{plan:ai.credits.monthly:${key}}}`);
    }
    // …and NO rung has a monthly row at all: the pass grant is a one-time
    // top-up. Asked of EVERY rung, hidden ones included — it is a fact about
    // the matrix, and a dormant rung that quietly grew a monthly credit row
    // would start paying a held pass a salary.
    for (const key of PASS_KEYS) {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${key} and feature_key = 'ai.credits.monthly'`;
      expect(row, `${key} must have no monthly credit row`).toBeUndefined();
    }
    // The ARTICLE, though, quotes the grant of the rung it sells and no other.
    for (const key of SELLABLE_PASS_KEYS) {
      expect(plansPassSection!, `${key}'s one-time grant`).toMatch(
        new RegExp(`\\b${PASS_CREDIT_GRANT[key]} AI credits\\b[^.]*\\bone time\\b`),
      );
    }
    for (const key of HIDDEN_PASS_KEYS) {
      expect(plans, `${key} is off sale`).not.toMatch(new RegExp(`\\b${PASS_CREDIT_GRANT[key]} AI credits`));
    }
    // The declaration keeps them distinct whether or not the copy says so, or
    // the negative above is satisfied by the two grants being one number.
    expect(PASS_CREDIT_GRANT.event_pass_l).not.toBe(PASS_CREDIT_GRANT.event_pass);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, not by reverting.
//
// The articles are (and must stay) correct, so every assertion above passes
// whether or not the guard covers the claim. These point the same pure functions
// at the copy a future editor plausibly writes instead: the falsehood said a
// different way, and — for each presence rule — its inverse and its deletion.
//
// Restoring the exact sentence this task removed is NOT proof. That is what let
// two guards ship green in wave 6.
// ─────────────────────────────────────────────────────────────────────────────
describe("the help-prose guards survive a rewording, not just a revert", () => {
  const LOCKED =
    "Once a competition has taken its first paid entry the platform fee it charges is locked for the rest of that competition.";

  // ── FIX ROUND 1: the mutations that beat the round-1 guards ───────────────
  // Both were made by ADDING a false sentence and KEEPING every true one, so
  // the positive halves stayed satisfied and only the negative had to fail —
  // which it did, because a list of falsehoods is an open set. These two are
  // the reviewer's own; the ten below are new ones neither guard was written
  // against.
  it("catches a false sentence ADDED beside the true one — fee", () => {
    const added =
      "After the event closes, later entrants are charged 8% again, and the 5% you were enjoying no longer applies.";
    expect(unqualifiedFeeReversionFaults("x", added), "the reviewer's mutation").not.toEqual([]);
    // …and in situ: appended to the real article, with every true sentence left
    // in place, exactly as it was mutated.
    expect(unqualifiedFeeReversionFaults("event-pass.md", `${eventPass}\n\n${added}\n`)).not.toEqual(
      [],
    );
  });

  it("catches a false sentence ADDED beside the true one — duration", () => {
    const added = "The pass has no end date and applies for the life of the event.";
    expect(passBoundProseFaults("x", `An Event Pass upgrades one competition while it runs.\n\n${added}`))
      .not.toEqual([]);
    expect(
      passBoundProseFaults("plans.md#event-pass", `${plansPassSection!}\n\n${added}\n`),
    ).not.toEqual([]);
  });

  // Five NEW rewordings of each falsehood, written to defeat the rule rather
  // than to confirm it. None appears in any pattern list.
  it("catches five fee rewordings the rule was not written against", () => {
    for (const reworded of [
      "Once the competition is over, entrants pay whatever your plan charges.",
      "When your pass lapses the cheaper rate stops and Community pricing takes over.",
      "After the pass expires we keep our usual 8% on every remaining entry.",
      "Refunding the pass puts the competition back on its plan pricing, fee included.",
      "The discount on entry fees only lasts while the pass does; after that it is gone.",
    ]) {
      expect(unqualifiedFeeReversionFaults("x", reworded), reworded).not.toEqual([]);
    }
  });

  it("catches five duration rewordings the rule was not written against", () => {
    for (const reworded of [
      "An Event Pass upgrades one competition while it runs. Once bought there is no cut-off date.",
      "An Event Pass upgrades one competition while it runs. The upgrade cannot expire.",
      "An Event Pass upgrades one competition while it runs. It stays in force even after the final.",
      "An Event Pass upgrades one competition while it runs. The pass applies for its whole life.",
      "An Event Pass upgrades one competition while it runs. Your competition keeps it in perpetuity.",
    ]) {
      expect(passBoundProseFaults("x", reworded), reworded).not.toEqual([]);
    }
  });

  // Critical 2's guard, proved the same way.
  it("catches a constant percentage sold as the locked rate", () => {
    for (const reworded of [
      // The exact sentence round 1 shipped.
      "Once a competition has taken its first paid entry, the platform fee is locked for the rest of it — a late entrant pays the same 5% as the first one.",
      "Your competition's fee is fixed at 5% for good once entries open.",
      "The locked rate is 5%, whatever happens to your plan.",
      "Buy a pass and the 5% stays locked in for every entry after it.",
      "Its platform fee is frozen at 5% from the first payment onwards.",
    ]) {
      expect(lockedRateConstantFaults("x", reworded), reworded).not.toEqual([]);
    }
    // …while attributing the locked rate to its SOURCE, with no number, passes.
    expect(
      lockedRateConstantFaults(
        "x",
        "Its platform fee stays locked at the rate the first payer was charged.",
      ),
    ).toEqual([]);
  });

  // The Minor: an accurate DENIAL of the retired cap must be writable.
  it("lets prose say the retired cap is gone, but not quote one", () => {
    expect(
      retiredRunCapProseFaults("x", "There is no per-division run cap any more."),
      "a true denial",
    ).toEqual([]);
    expect(
      retiredRunCapProseFaults("x", "There is no per-division run cap beyond 20 runs a division."),
      "a denial with a number in it is still a cap",
    ).not.toEqual([]);
    expect(
      retiredRunCapProseFaults("x", "Community gets 5 AI schedule runs per division."),
    ).not.toEqual([]);
  });

  // The second exemption (#303): the genuinely live HOURLY burst brake
  // (`rateLimit('ai-plan:'+divisionId, {max:5, windowSeconds:3600})`,
  // usecases/schedule-ai/) is shaped exactly like the retired lifetime table to the
  // base vocabulary, and must be writable — but ONLY when the sentence actually
  // names an hourly window. A day/week/month framing names no real mechanism
  // and must still red, same as any other invented allowance.
  it("lets prose state the live hourly burst brake, but not a monthly one", () => {
    expect(
      retiredRunCapProseFaults("x", "Every plan has a burst brake of 5 AI runs an hour per division."),
      "the true hourly rate limit",
    ).toEqual([]);
    expect(
      retiredRunCapProseFaults("x", "Community gets 5 AI schedule runs a month per division."),
      "a monthly per-division allowance is not a real mechanism and must still red",
    ).not.toEqual([]);
  });

  it("catches the fee-reversion claim however it is phrased", () => {
    for (const reworded of [
      // The two sentences this task removed…
      "the realtime board and sponsor tools stop, and the platform fee returns to your plan's rate.",
      "the sponsor tools simply switch off and the platform fee returns to your plan's rate, exactly like a downgrade.",
      // …and the same claim, none of which contain those words.
      "When the pass ends your entry-fee rate goes back to 8%.",
      "The platform fee reverts to whatever your plan charges.",
      "Community's 8% applies again to every later entrant.",
      "Expect the fee to rise back to your plan's percentage once the event closes.",
      "After that, the 5% you were enjoying resets to the plan rate.",
      "The fee rate simply moves to your plan's own rate.",
    ]) {
      expect(unqualifiedFeeReversionFaults("x", reworded), reworded).not.toEqual([]);
    }
  });

  // FIX ROUND 1 (Minor): the claim was matched block-wide while the excuse was
  // matched sentence-wide, so a true qualifier ANYWHERE in the block excused a
  // false claim beside it. Both are sentence-scoped now, and this is the test
  // that says so: the same two sentences pass or fail on whether the ONE
  // sentence making the claim also carries the lock.
  it("requires the lock in the SAME SENTENCE as the claim, not merely nearby", () => {
    const claim = "When the pass ends the entry-fee rate goes back to your plan's rate.";
    expect(unqualifiedFeeReversionFaults("x", claim), "unqualified").not.toEqual([]);
    // The lock in the next sentence of the same paragraph does NOT excuse it —
    // this exact shape passed in round 1.
    expect(unqualifiedFeeReversionFaults("x", `${claim} ${LOCKED}`), "next sentence").not.toEqual(
      [],
    );
    // Only the claim and its qualifier in one sentence passes.
    expect(
      unqualifiedFeeReversionFaults(
        "x",
        "When the pass ends, a competition that has taken its first paid card entry keeps the platform fee locked at what that entrant was charged.",
      ),
      "one sentence",
    ).toEqual([]);
  });

  it("is not satisfied by the lock sitting in a different block either", () => {
    const article = `- ${LOCKED}\n- When the pass ends the platform fee returns to your plan's rate.`;
    expect(unqualifiedFeeReversionFaults("x", article)).not.toEqual([]);
  });

  // The other half. An absence-shaped rule is happiest when the claim is
  // DELETED — which leaves an organiser knowing nothing about the rate their
  // entrants pay after the pass ends.
  it("catches the lock being deleted, not just contradicted", () => {
    expect(feeLockStatedFaults("x", "The pass gives you a 5% platform fee while it runs.")).toEqual(
      ["x: never states that the entry-fee rate locks at the first paid entry (V312)"],
    );
    expect(feeLockStatedFaults("x", LOCKED)).toEqual([]);
  });

  // …and a lock word with no trigger is not a statement of the lock: it tells a
  // reader a rate is fixed without saying what fixes it, so nobody can tell
  // whether their own competition is locked.
  it("requires the trigger, not merely the word 'locked'", () => {
    expect(statesFeeLock("Your platform fee is locked for the rest of the competition.")).toBe(
      false,
    );
    expect(statesFeeLock("Refunds before the refund lock date return the first paid entry.")).toBe(
      false,
    );
    expect(statesFeeLock(LOCKED)).toBe(true);
  });

  it("catches the retired AI-run cap in prose, including the unit-noun-first form", () => {
    for (const reworded of [
      "Community gets 5 AI schedule runs per division.",
      "each division gets its own AI schedule generations", // fix round 2
      "every competition comes with its own allowance of scheduling runs", // fix round 2
      "5 schedule runs for every division", // fix round 1: `every` was missing
      "the AI console allows 20 generations for each competition",
    ]) {
      expect(retiredRunCapProseFaults("x", reworded), reworded).not.toEqual([]);
    }
    // The live, credit-metered story, and the ordinary prose around it, are not
    // false positives. Every one of these is a real sentence in the two articles.
    for (const honest of [
      "AI Schedule runs on every plan, including Community.",
      "An Event Pass upgrades one competition while it runs.",
      "a Community org keeps all 10 free slots while its passed event runs",
      "Every organisation in the group runs on the group's plan.",
      "For the competition it covers, and every division inside it",
      "your organisation gets 10 AI credits a month to spend on AI scheduling and officials",
    ]) {
      expect(retiredRunCapProseFaults("x", honest), honest).toEqual([]);
    }
  });

  it("catches an unbounded pass claim in prose, and the bound being dropped", () => {
    const bounded = "An Event Pass upgrades one competition while it runs — bigger limits.";
    expect(passBoundProseFaults("x", bounded)).toEqual([]);

    for (const [label, reworded] of [
      ["the original", "One-time upgrade for a single competition, for that event's lifetime."],
      ["a synonym", `${bounded} It is yours forever.`],
      ["a third", `${bounded} The upgrade never expires.`],
      ["fix round 2 (hyphenated)", `${bounded} A never-ending upgrade.`],
      ["fix round 2 (participle)", `${bounded} It is never ending.`],
    ] as const) {
      expect(passBoundProseFaults("x", reworded), label).not.toEqual([]);
    }

    // Deletion, and wrong-clause satisfaction inside the opening paragraph.
    for (const silent of [
      "An Event Pass upgrades one competition — bigger limits and a cheaper fee.",
      "An Event Pass upgrades an active competition.",
      "An Event Pass is active immediately on one competition.",
    ]) {
      expect(passBoundProseFaults("x", silent), silent).toEqual([
        "x: the opening paragraph never states the pass is bounded to a running competition",
      ]);
    }
    // An empty section (a renamed heading, a deleted body) is a fault, never a
    // clean scan.
    expect(passBoundProseFaults("x", "")).toEqual([
      "x: no prose to scan — the section is empty or its heading moved",
    ]);
  });

  // fix round 2: the bound's window was 30 characters and rejected TRUE copy.
  // Both of these are sentences an editor writes; both read as "never states the
  // pass is bounded" before the widening.
  // FIX ROUND 1: the rule was `conjunction … {0,N} … activity word`, and both
  // values of N shipped a bug — 30 rejected true copy, 60 accepted copy with no
  // bound at all (3 of 3, measured). A distance cannot tell GOVERNING from
  // ADJACENT. The relation is now clause membership, and this table is the
  // evidence: seven true bounds and seven sentences where the two words are
  // near each other and the conjunction governs nothing.
  //
  // This is a SHARED dependency — task 4's four locale `bounded` rules are
  // built from the same `boundedScopeGrammarSource`, so a regression here is a
  // regression in es/fr/nl too.
  it("distinguishes a governing conjunction from a merely adjacent one", () => {
    for (const bounded of [
      "The pass lifts the plan until the competition is archived or no longer active: more entrants.",
      "One-time upgrade, for as long as the competition it covers is still open: more entrants.",
      "while it's active",
      "while that competition is still running",
      "An Event Pass upgrades one competition while it runs",
      "One-time upgrade, until the competition is no longer active",
      "the pass applies while the event is still open",
    ]) {
      expect(BOUNDED_SCOPE_GRAMMAR.test(bounded), `false red: ${bounded}`).toBe(true);
    }
    for (const unbounded of [
      // A new subject after a coordinator starts a new clause: the conjunction
      // is not governing "active" at all. All of these passed at {0,60}.
      "Buy it during the summer and your competition stays active.",
      "During checkout your card is charged and the pass is active",
      "You can buy while browsing the pricing page; your competition becomes active at once",
      "while you wait, the competition is not yet active",
      "Buy it during checkout. Your competitions stay active.",
      // …and no conjunction at all is still no bound.
      "One-time upgrade for a single competition, active immediately",
      "One-time upgrade for an active competition",
    ]) {
      expect(BOUNDED_SCOPE_GRAMMAR.test(unbounded), `false green: ${unbounded}`).toBe(false);
    }
  });

  // ANTI-VACUITY for rule 3. Rule 1 (the extent forms) would carry almost every
  // fixture above on its own, so a dead rule 3 would go unnoticed — and did:
  // a stray control character left `DURATION_CLAIM` matching nothing while this
  // suite stayed green. This asserts rule 3 fires where NO extent form does.
  it("faults an unbounded duration claim that matches no extent form", () => {
    const opening = "An Event Pass upgrades one competition while it runs.";
    const faults = passBoundProseFaults("x", `${opening} It applies for the entire duration and beyond.`);
    expect(
      faults.filter((f) => f.includes("without bounding it")),
      "rule 3 did nothing — DURATION_CLAIM may be dead",
    ).not.toEqual([]);
    expect(
      faults.filter((f) => f.includes("unbounded extent")),
      "an extent form fired, so this fixture proves nothing about rule 3",
    ).toEqual([]);
  });

  it("catches a drifted, missing or recurring credit grant in prose", () => {
    // Entitlements v18 W2 T5 (design R9): the grant is per rung. The rule reads
    // the grants of the rungs ON SALE (owner decision 2026-09-05 took the L
    // rung off sale), so a withdrawn rung's top-up is drift here rather than a
    // required figure — which is what stops the copy going on advertising it.
    // Every figure below is derived from the declaration; a repricing moves
    // these proofs with it.
    const grants = SELLABLE_PASS_KEYS.map((k) => PASS_CREDIT_GRANT[k]);
    const mGrant = PASS_CREDIT_GRANT.event_pass;
    const lGrant = PASS_CREDIT_GRANT.event_pass_l;
    expect(lGrant, "the two rungs must differ or none of this witnesses anything").not.toBe(mGrant);
    expect(grants, "the sellable set must be a real, smaller subset").toEqual([mGrant]);

    const honest = `- A one-time top-up of ${mGrant} AI credits, added to your wallet when you buy.`;
    expect(passCreditProseFaults("x", honest)).toEqual([]);
    // The table form, where the number sits on the other side of the noun.
    expect(passCreditProseFaults("x", `| AI credits | +${mGrant}, one-time |`)).toEqual([]);

    // THE MULTI-COLUMN READ, and it is the reason this case survives the ladder
    // shrinking. The rule's first matcher stops at the FIRST cell after the
    // label, which was harmless while both rungs granted the same number and is
    // a hole the moment they do not — measured: a two-rung table passed with
    // the second cell still saying M's figure. A second column with a wrong
    // number must fault, whatever the article happens to publish today.
    expect(
      passCreditProseFaults("x", `| AI credits | +${mGrant}, one-time | +40, one-time |`).join(" "),
    ).toContain(`quotes 40 AI credits, but the pass grants ${mGrant}`);

    // THE WITHDRAWN RUNG'S GRANT, left behind in the copy. It is now drift and
    // not a requirement: an article still promising the L top-up is still
    // selling L. This is the assertion that inverted on 2026-09-05.
    expect(
      passCreditProseFaults("x", `- A one-time top-up of ${lGrant} AI credits.`).join(" "),
    ).toContain(`quotes ${lGrant} AI credits, but the pass grants ${mGrant}`);

    // A figure that is no rung's at all is still drift.
    expect(passCreditProseFaults("x", "- A one-time top-up of 40 AI credits.").join(" ")).toContain(
      `quotes 40 AI credits, but the pass grants ${mGrant}`,
    );
    // The inverse claim: right number, wrong cadence.
    expect(
      passCreditProseFaults("x", `- ${mGrant} AI credits a month, once you buy.`).join(" "),
    ).toContain("sells the one-time grant as recurring");
    // Right number, no cadence at all — a reader cannot tell it does not repeat.
    expect(passCreditProseFaults("x", `- The pass adds ${mGrant} AI credits.`).join(" ")).toContain(
      "without saying it is one-time",
    );
    // Deletion — every grant that must be stated is named.
    expect(passCreditProseFaults("x", "- Branded exports and sponsor tiers.")).toEqual(
      grants.map((g) => `x: never states the one-time +${g} AI credit grant`),
    );
  });

  it("catches a fee-ladder row that drifts from the matrix, and one that vanishes", () => {
    // `enterprise`, not `pro_plus` — V393 deleted that plan and the 1% floor
    // moved onto enterprise, so the ladder's bottom rung kept its rate and
    // changed its name (see FEE_LADDER_PLAN_KEYS).
    const live = { community: 8, event_pass: 5, event_pass_l: 5, pro: 2, enterprise: 1 };
    const table = [
      "| Plan | Platform fee |",
      "| --- | --- |",
      "| Community | 8% |",
      "| Event Pass | 5% |",
      "| Pro | 2% |",
      "| Enterprise | 1% |",
    ].join("\n");
    expect(feeLadderFaults(feeLadderRows(table), live)).toEqual([]);

    // A rate the matrix does not charge.
    expect(
      feeLadderFaults(feeLadderRows(table.replace("| Pro | 2% |", "| Pro | 3% |")), live).join(" "),
    ).toContain('"Pro" quotes 3%, but pro enforces 2%');
    // One rung moving is a fault even though the other rung still matches.
    expect(feeLadderFaults(feeLadderRows(table), { ...live, event_pass_l: 4 }).join(" ")).toContain(
      "event_pass_l enforces 4%",
    );
    // A dropped row reads as "that plan has no platform fee".
    expect(
      feeLadderFaults(feeLadderRows(table.replace("| Event Pass | 5% |\n", "")), live),
    ).toEqual(["fee ladder: no row for Event Pass"]);
    // …and an empty table is not a clean scan.
    expect(feeLadderFaults(feeLadderRows("no table here"), live)).toHaveLength(
      Object.keys(FEE_LADDER_PLAN_KEYS).length,
    );
  });

  it("reads a token fee ladder: the rate is live by construction, so the pairing of label and cell is what is checked", () => {
    // Registration help renders each cell from the plan table (`{{plan:registration.fee_percent:<plan>}}`), so there is
    // no typed percent to compare. The rate cannot go stale; what can still go wrong is a label on the wrong plan's
    // cell, or a row that vanishes.
    const live = { community: 8, event_pass: 5, event_pass_l: 5, pro: 2, enterprise: 1 };
    const tok = (plan: string) => `{{plan:registration.fee_percent:${plan}}}`;
    const table = [
      "| Plan | Platform fee |",
      "| --- | --- |",
      `| Community | ${tok("community")}% |`,
      `| Event Pass | ${tok("event_pass")}% |`,
      `| Pro | ${tok("pro")}% |`,
      `| Enterprise | ${tok("enterprise")}% |`,
    ].join("\n");
    const rows = feeLadderRows(table);
    // anti-vacuity: four rows read, each a token row with the plan key the token names (underscore intact)
    expect(rows.map((r) => [r.plan, r.tokenPlan, r.percent])).toEqual([
      ["Community", "community", null],
      ["Event Pass", "event_pass", null],
      ["Pro", "pro", null],
      ["Enterprise", "enterprise", null],
    ]);
    expect(feeLadderFaults(rows, live)).toEqual([]);
    expect(feeLadderTables(table), "found by shape").toHaveLength(1);

    // A label on another plan's cell is a fault, even though every rate is live.
    expect(
      feeLadderFaults(feeLadderRows(table.replace(`| Pro | ${tok("pro")}% |`, `| Pro | ${tok("community")}% |`)), live),
    ).toEqual(['fee ladder: "Pro" reads the community cell, but its plan key is pro']);
    // A dropped row is still a fault: it would read as "that plan has no platform fee".
    expect(
      feeLadderFaults(feeLadderRows(table.replace(`| Event Pass | ${tok("event_pass")}% |\n`, "")), live),
    ).toEqual(["fee ladder: no row for Event Pass"]);
    // A token for another feature is not a fee cell: the row is not read, so it counts as missing.
    expect(
      feeLadderFaults(feeLadderRows(table.replace(tok("pro"), "{{plan:entrants.per_division.max:pro}}")), live),
    ).toEqual(["fee ladder: no row for Pro"]);
    // Either rung of the pass answers for the Event Pass label.
    expect(feeLadderFaults(feeLadderRows(table.replace(tok("event_pass"), tok("event_pass_l"))), live)).toEqual([]);
  });

  // ── THE WIDENED SWEEP, W3 ─────────────────────────────────────────────────

  it("finds a fee ladder by SHAPE, wherever in an article it sits", () => {
    // The failure this replaces: the rule was pointed at ONE section of ONE
    // file, so two other articles carried the same table unscanned.
    const ladder = [
      "| Plan | Platform fee |",
      "| --- | --- |",
      "| Community | 5% |",
      "| Pro | 2% |",
      "| Enterprise | 1% |",
    ].join("\n");
    const article = ["# Anything", "", "Some prose.", "", ladder, "", "More prose."].join("\n");
    expect(feeLadderTables(article)).toHaveLength(1);
    expect(feeLadderTables(article)[0]!.rows.map((r) => r.plan)).toEqual([
      "Community",
      "Pro",
      "Enterprise",
    ]);
    // Two copies in one article are two tables, not one — the drifted copy is
    // exactly the case that went unscanned for a wave.
    expect(feeLadderTables(`${article}\n\n${ladder}\n`)).toHaveLength(2);

    // Either clause alone finds it. A table whose HEADING was reworded away
    // from "fee" is still found by its plan names…
    const renamedHeader = ladder.replace("| Plan | Platform fee |", "| Tier | What we keep |");
    expect(feeLadderTables(renamedHeader), "found by its rows").toHaveLength(1);
    // …and a table whose plan names were ALL renamed at once is still found by
    // its header, so the rows can be reported as unrecognised rather than
    // vanishing from the sweep.
    const renamedRows = ladder.replace(/Community|Pro|Enterprise/g, "Mystery");
    expect(feeLadderTables(renamedRows), "found by its header").toHaveLength(1);

    // And it does NOT drag in a table that is not a fee ladder.
    const other = ["| Line | What it is |", "| --- | --- |", "| Tax | on the difference |"].join("\n");
    expect(feeLadderTables(other)).toEqual([]);
    // …including event-pass.md's TRANSPOSED shape, which has its own rule.
    const transposed = [
      "| | M — $11.99 | L — $44.99 |",
      "| --- | --- | --- |",
      "| Platform fee on entry fees | 4% | 4% |",
    ].join("\n");
    expect(feeLadderTables(transposed)).toEqual([]);
  });

  it("lets a table declare the subset it carries, and refuses a bad declaration", () => {
    const live = { community: 5, event_pass: 4, event_pass_l: 4, pro: 2, enterprise: 1 };
    const groupsShaped = [
      "| The group's plan | Platform fee on entries |",
      "| --- | --- |",
      "| Community | 5% |",
      "| Pro | 2% |",
      "| Enterprise | 1% |",
    ].join("\n");
    const rows = feeLadderRows(groupsShaped);
    // Without the declaration it is INCOMPLETE, which is the default and the
    // right default — a dropped row reads as "that plan has no platform fee".
    expect(feeLadderFaults(rows, live)).toEqual(["fee ladder: no row for Event Pass"]);
    // With it, the omission is a recorded decision.
    expect(feeLadderFaults(rows, live, ["Community", "Pro", "Enterprise"])).toEqual([]);
    // The declaration cannot excuse a WRONG RATE — only a missing row.
    expect(
      feeLadderFaults(
        feeLadderRows(groupsShaped.replace("| Pro | 2% |", "| Pro | 8% |")),
        live,
        ["Community", "Pro", "Enterprise"],
      ).join(" "),
    ).toContain('"Pro" quotes 8%, but pro enforces 2%');
    // …nor can it name a label that is not a ladder row at all, which is how a
    // typo would otherwise silently drop a plan from the required set.
    expect(feeLadderFaults(rows, live, ["Community", "Pro", "Enterprize"]).join(" ")).toContain(
      'required label "Enterprize" is not a ladder row at all',
    );
  });

  it("reads the transposed pass fee row, and refuses to guess when the rungs diverge", () => {
    const table = [
      "| | M — $11.99 | L — $44.99 |",
      "| --- | --- | --- |",
      "| Platform fee on entry fees | 4% | 4% |",
    ].join("\n");
    const rates = { event_pass: 4, event_pass_l: 4 };
    expect(passFeeRowFaults("x", table, rates)).toEqual([]);
    // A stale rate in either column.
    expect(passFeeRowFaults("x", table.replace("| 4% | 4% |", "| 5% | 4% |"), rates).join(" ")).toContain(
      "quotes 5%, but every pass rung enforces 4%",
    );
    // Fewer rates than the table sells rungs. The expected COUNT is derived
    // from the rates supplied, not typed: it was a hardcoded 2 in the rule
    // itself, and when the L rung came off sale on 2026-09-05 that literal
    // failed an article which had just been made correct.
    expect(passFeeRowFaults("x", table.replace("| 4% | 4% |", "| 4% | |"), rates).join(" ")).toContain(
      `quotes 1 rate(s), but the table sells ${Object.keys(rates).length} rung(s)`,
    );
    // Rungs that stop sharing a rate: the rule REFUSES rather than guessing
    // which column is which, and says what is needed instead.
    expect(passFeeRowFaults("x", table, { event_pass: 4, event_pass_l: 3 }).join(" ")).toContain(
      "needs a column-aware guard",
    );
    // The vacuity modes: no row, and no rates supplied.
    expect(passFeeRowFaults("x", "no table here", rates).join(" ")).toContain("the table's shape changed");
    expect(passFeeRowFaults("x", table, {}).join(" ")).toContain("would pass vacuously");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REGRESSION SET, AND WHY THE GATE EXISTS.
//
// Four rounds of this wave defended this copy with lexical rules. Every round
// scored well against the examples it was written for and badly against the
// next ones — measured, each time by someone who did not write the rules:
//
//   round 1   topic + verb vocabulary      fee 1/12, permanence 1/11
//   round 2   "closed set of forms"        fee 0/12, permanence 0/12, rate 0/4
//   round 3   allowlist of approved forms  reviewer's set 12/12, fresh set 6/30
//
// That last pair is the whole argument. Same author, same day, same rules: 12/12
// on the set the rules had been tuned against and 6/30 on a set written
// afterwards. Tuning is not convergence.
//
// The inventory gate takes the rates to 30/30 and 15/15 on those same two sets,
// because it does not read the sentence. Everything below is kept as a
// regression set so the lexical layer cannot silently rot, but the gate is what
// is actually load-bearing.
// ─────────────────────────────────────────────────────────────────────────────
describe("an added falsehood fails whatever it says", () => {
  const GATE_INPUTS = [...APPROVED_EVENT_PASS.map((p) => p.text)];

  /** Every guard, over the real article with one sentence ADDED — the shape all
   *  four lexical rounds missed. */
  const detects = (added: string): boolean => {
    const mutated = `${eventPass}\n\n${added}\n`;
    return (
      inventoryFaults("x", mutated, APPROVED_EVENT_PASS_INVENTORY).length > 0 ||
      goldenParagraphFaults("x", mutated, APPROVED_EVENT_PASS).length > 0 ||
      unapprovedClaimFaults("x", mutated, DURATION_ALLOWLIST, GATE_INPUTS).length > 0 ||
      unapprovedClaimFaults("x", mutated, FEE_RATE_ALLOWLIST, GATE_INPUTS).length > 0 ||
      passBoundProseFaults("x", mutated).length > 0 ||
      unqualifiedFeeReversionFaults("x", mutated).length > 0 ||
      lockedRateConstantFaults("x", mutated).length > 0
    );
  };

  // The reviewer's own rewordings, which beat round 3's allowlist.
  it("catches the two sentences that beat the previous round", () => {
    for (const added of [
      "Once bought, the upgrade is yours from then on and your competition never loses it.",
      "Once the trophy is handed out, entry costs return to normal and later entrants cost you more per head.",
    ]) {
      expect(detects(added), added).toBe(true);
    }
  });

  // A sample of the two fresh adversarial sets, chosen because NONE of them
  // shares vocabulary with any rule in this module — which is exactly why they
  // scored 6/30 before the gate and 30/30 after it.
  it("catches rewordings that share no vocabulary with any rule here", () => {
    for (const added of [
      "The upgrade outlives the event.",
      "A passed competition is passed for keeps.",
      "Whatever the season does, the upgrade abides.",
      "Sign-ups arriving after the closing whistle are charged the plan's percentage.",
      "Once the fixtures are done we go back to taking a bigger share of each entry.",
      "The competition is billed at the pass's number for every single entrant.",
      "Consider the upgrade banked.",
      "No calendar governs an Event Pass.",
    ]) {
      expect(detects(added), added).toBe(true);
    }
  });

  // …and the other two ways copy goes wrong, which a per-paragraph fixture alone
  // would miss: a falsehood edited INTO an existing paragraph, and a true
  // paragraph quietly deleted.
  it("catches an edit inside an existing paragraph, and a deletion", () => {
    const edited = eventPass.replace(
      "A new competition, even the next edition of the same event, needs its own pass.",
      "A new competition, even the next edition of the same event, keeps this pass.",
    );
    expect(edited, "the anchor moved — re-point this test").not.toBe(eventPass);
    expect(inventoryFaults("x", edited, APPROVED_EVENT_PASS_INVENTORY)).not.toEqual([]);

    const deleted = eventPass.replace(
      "- Anything outside this competition. Your other competitions stay on your plan.\n",
      "",
    );
    expect(deleted).not.toBe(eventPass);
    expect(inventoryFaults("x", deleted, APPROVED_EVENT_PASS_INVENTORY)).not.toEqual([]);
  });

  // The gate must fail LOUDLY. A hex digest with no prose is a gate people route
  // around, and this one will fire on every legitimate copy edit.
  it("explains itself when it fires", () => {
    const [fault] = inventoryFaults(
      "event-pass.md",
      `${eventPass}\n\nSomething new.\n`,
      APPROVED_EVENT_PASS_INVENTORY,
    );
    expect(fault).toContain("THIS TEST IS A GATE, NOT A BUG");
    expect(fault).toContain("_approved-copy.ts");
    expect(fault, "the on-disk text must be printed, not just its digest").toContain("Something new.");
  });

  // The gate tells the reader to read their wording against the code that writes
  // the fee lock. `usecases/registrations/` became a folder (src/server/MODULARIZATION.md)
  // and this used to pin the substring "usecases/registrations/", which kept passing
  // against the dead name. Pin the module that HOLDS the stamp, and make the
  // path a checked citation, so a move that strands it fails here.
  it("the fee-lock path the gate names is a real module, in both gate messages", () => {
    const FEE_LOCK_MODULE = "server/usecases/registrations/checkout-completion.ts";
    const [digestFault] = inventoryFaults(
      "event-pass.md",
      `${eventPass}\n\nSomething new.\n`,
      APPROVED_EVENT_PASS_INVENTORY,
    );
    const anchor = "After the pass ends, a competition with no paid card entry yet follows your plan's rate.";
    expect(eventPass, "the anchor moved — re-point this test").toContain(anchor);
    const [paragraphFault] = goldenParagraphFaults(
      "event-pass.md",
      eventPass.replace(anchor, "Every competition follows your plan's live rate."),
      APPROVED_EVENT_PASS,
    );
    expect(paragraphFault, "the paragraph gate did not fire").toContain("CHANGED");

    const namedBy = (fault: string) =>
      citationsIn("gate message", fault).filter((c) => c.path.startsWith("server/usecases/"));
    // ANTI-VACUITY: each message names the module at least once, and nothing
    // else under server/usecases/ sneaks past the resolver unchecked.
    for (const fault of [digestFault!, paragraphFault!]) {
      const named = namedBy(fault);
      expect(named.length, "the gate message cites no server module").toBeGreaterThan(0);
      expect([...new Set(named.map((c) => c.path))]).toEqual([FEE_LOCK_MODULE]);
      expect(citationFaults(named)).toEqual([]);
    }
  });

  /**
   * …AND THE CITATIONS IN THOSE FIXTURES MUST POINT AT SOMETHING.
   *
   * The gate's instruction is "read your new wording against the code named in
   * the `why`". A `why` naming a file that does not exist sends that reader
   * nowhere, and they approve on a citation instead of on a reading. Seven
   * review rounds of this wave have found `why` defects and every fix has been
   * by hand, one at a time; two of this round's twenty-one were files that have
   * never existed in this repo (`usecases/orgs.ts`,
   * `usecases/competition-passes.ts`).
   *
   * This settles that class mechanically. It does NOT settle the "cites the
   * wrong LINE" class — eighteen of this round's defects were that, ten of them
   * into `billing-groups.ts` and all short by the same 21 lines after one edit
   * moved the function — because checking that a line says what a sentence
   * claims is a reading, not a lookup. Claiming otherwise in this comment would
   * be the very defect the round is about.
   */
  it("every file a `why` cites exists, and every line it cites is in range", () => {
    const sources = [
      ["_approved-copy.ts", webSource("lib/__tests__/_approved-copy.ts")],
      ["_approved-dictionary-copy.ts", webSource("lib/__tests__/_approved-dictionary-copy.ts")],
    ] as const;
    const citations = sources.flatMap(([origin, src]) => citationsIn(origin, src));
    expect(citationFaults(citations)).toEqual([]);

    // ANTI-VACUITY. An extractor that found nothing would satisfy the above for
    // free, and a resolver that resolved everything would too.
    expect(citations.length, "no citations extracted — the pattern is not matching").toBeGreaterThan(80);
    expect(
      citations.some((c) => c.from !== null),
      "no line-numbered citation extracted",
    ).toBe(true);
    // …and it must actually reject. Both fault shapes, on constructed input.
    expect(
      citationFaults([{ origin: "probe", path: "usecases/orgs.ts", from: null, to: null }]),
    ).toEqual(['probe: cites "usecases/orgs.ts", which is not a file in this repo']);
    expect(
      citationFaults([
        { origin: "probe", path: "server/usecases/billing-groups.ts", from: 99_999, to: 99_999 },
      ]).join(" "),
    ).toContain("but apps/web/src/server/usecases/billing-groups.ts has");
    // A real file with a real line is clean, so the rule is not simply "reject".
    expect(
      citationFaults([{ origin: "probe", path: "lib/client-v1.ts", from: 23, to: 27 }]),
    ).toEqual([]);
    // The `tsx`-before-`ts` alternation, which is what made a first cut report
    // `components/api-keys.tsx` as the non-existent `components/api-keys.ts`.
    expect(citationsIn("p", "see components/api-keys.tsx for the shape")[0]!.path).toBe(
      "components/api-keys.tsx",
    );
    // An unused allowlist entry is a fault, so the list cannot become a place
    // for stale citations to hide.
    expect(citationFaults([], ["never/cited.ts"])).toEqual([
      'the citation allowlist names "never/cited.ts", which no why cites any more — remove it',
    ]);
  });

  // The reviewer's Important-1 set: sentences with no bound at all, which the
  // character-window versions of this rule accepted 5 out of 6 times.
  it("reads none of these as a statement that the pass is bounded", () => {
    for (const unbounded of [
      "During checkout your Event Pass becomes active.",
      "Until now nobody could keep a competition active without Pro.",
      "While browsing the pricing page you can keep every competition active.",
      "During the summer your competition stays open.",
      "Buy during checkout to make your competition live.",
    ]) {
      expect(BOUNDED_SCOPE_GRAMMAR.test(unbounded), unbounded).toBe(false);
    }
    // …so an article whose only candidate bound is one of them states no bound.
    expect(
      passBoundProseFaults(
        "x",
        "During checkout your Event Pass becomes active. It is a one-time upgrade for a single competition.",
      ),
    ).not.toEqual([]);
  });

  // Important 2's residual.
  it("catches the two run-cap phrasings that were still missing", () => {
    for (const quoted of [
      "AI scheduling is limited to 5 attempts per division.",
      "Each division may be scheduled by AI up to 20 times.",
    ]) {
      expect(retiredRunCapProseFaults("x", quoted), quoted).not.toEqual([]);
    }
  });

  // …and the locked-rate rule, no longer keyed on a literal `%`.
  it("catches a rate named by brand or spelled out, not just as a figure", () => {
    for (const named of [
      "Its platform fee drops to the pass rate for every remaining entry.",
      "After that it stays at the Event Pass rate.",
      "The locked rate is five per cent, whatever happens to your plan.",
      "Your competition is pinned to the pass's cheaper rate.",
    ]) {
      expect(lockedRateConstantFaults("x", named), named).not.toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX ROUND 3 — the surfaces the gate did not reach, and the honest rate.
// ─────────────────────────────────────────────────────────────────────────────
describe("every surface a reader sees is covered, not just the paragraphs", () => {
  const GATE_INPUTS = APPROVED_EVENT_PASS.map((p) => p.text);
  const detects = (mutated: string): boolean =>
    inventoryFaults("x", mutated, APPROVED_EVENT_PASS_INVENTORY).length > 0 ||
    goldenParagraphFaults("x", mutated, APPROVED_EVENT_PASS).length > 0 ||
    unapprovedClaimFaults("x", mutated, DURATION_ALLOWLIST, GATE_INPUTS).length > 0 ||
    unapprovedClaimFaults("x", mutated, FEE_RATE_ALLOWLIST, GATE_INPUTS).length > 0 ||
    passBoundProseFaults("x", mutated).length > 0 ||
    unqualifiedFeeReversionFaults("x", mutated).length > 0 ||
    lockedRateConstantFaults("x", mutated).length > 0;

  // `description` is rendered as the lead paragraph under the title
  // (app/help/[...slug]/page.tsx), emitted as page metadata, and shown as the
  // search-result snippet (help-search.tsx). It was unscanned by every rule in
  // the module: measured 0/24 before this, 12/12 after.
  it("catches a falsehood delivered through frontmatter", () => {
    for (const description of [
      "Buy once and the upgrade is yours for the lifetime of the event, with every entrant held at the cheaper rate.",
      "A one-time upgrade that never expires.",
      "Entry fees go back to 8% as soon as the event is archived.",
      "The Event Pass rate applies to every entry, whenever it arrives.",
    ]) {
      const mutated = eventPass.replace(/^description: .*$/m, `description: ${description}`);
      expect(mutated, "the frontmatter anchor moved").not.toBe(eventPass);
      expect(detects(mutated), description).toBe(true);
    }
  });

  // Headings were filtered by `proseBlocks` and therefore unscanned too:
  // measured 0/36 before, 12/12 after.
  it("catches a falsehood delivered through a heading", () => {
    for (const heading of [
      "Yours forever — the pass never expires and later entrants stay at 5%",
      "Buy once, covered for good",
      "Entry costs return to normal once the trophy is handed out",
      "An upgrade with no shelf life",
    ]) {
      const mutated = eventPass.replace("## One pass, one competition", `## ${heading}\n\n## One pass, one competition`);
      expect(mutated, "the heading anchor moved").not.toBe(eventPass);
      expect(detects(mutated), heading).toBe(true);
    }
  });

  // The gate is POSITIONAL. Set membership raised zero faults when two real
  // paragraphs were swapped, while its own message claimed to catch reordering.
  it("catches two approved paragraphs being swapped", () => {
    const first = "- Your brand colour on public pages. That stays on Pro.";
    const second = "- API access.";
    expect(eventPass.includes(`${first}\n${second}`), "the anchors moved").toBe(true);
    const swapped = eventPass.replace(`${first}\n${second}`, `${second}\n${first}`);
    expect(inventoryFaults("x", swapped, APPROVED_EVENT_PASS_INVENTORY)).not.toEqual([]);
  });

  // plans.md is pinned WHOLE, not by section: the same falsehood pasted into a
  // sibling section used to raise zero faults.
  it("covers plans.md outside the Event Pass section", () => {
    // The anchor is the heading WITHOUT its price. It carried "$12/month" and
    // broke the day W3 repriced Pro to $14.99 — correctly, because the
    // `not.toBe` below is what a mutation anchor is for, but a probe that reds
    // on every legitimate reprice teaches its next reader to retype the price
    // rather than to check the mutation still lands.
    const mutated = plans.replace(
      "## Pro, for every competition",
      "The pass has no end date and applies for the life of the event.\n\n## Pro, for every competition",
    );
    expect(mutated, "the section anchor moved").not.toBe(plans);
    expect(inventoryFaults("x", mutated, APPROVED_PLANS_INVENTORY)).not.toEqual([]);
  });

  // ── THE HONEST RATE ───────────────────────────────────────────────────────
  // Asserted EXACTLY, the way task 4 pinned its vocabulary at 1/40: the lexical
  // layer is a secondary net, and any widening of it must update these numbers
  // deliberately rather than quietly improving a claim nobody re-measures.
  // An independent reviewer measured 1/12 and 0/12 on its own sets.
  it("scores 1/12 and 4/12 on its own — the gate is doing the work", () => {
    const lexicalOnly = (added: string): boolean => {
      const m = `${eventPass}\n\n${added}\n`;
      return (
        unapprovedClaimFaults("x", m, DURATION_ALLOWLIST, GATE_INPUTS).length > 0 ||
        unapprovedClaimFaults("x", m, FEE_RATE_ALLOWLIST, GATE_INPUTS).length > 0 ||
        passBoundProseFaults("x", m).length > 0 ||
        unqualifiedFeeReversionFaults("x", m).length > 0 ||
        lockedRateConstantFaults("x", m).length > 0
      );
    };
    const duration = [
      "Once bought, the upgrade is yours from then on and your competition never loses it.",
      "The upgrade outlives the event.",
      "A passed competition is passed for keeps.",
      "Whatever the season does, the upgrade abides.",
      "Consider the upgrade banked.",
      "No calendar governs an Event Pass.",
      "Your pass sticks with the competition no matter what.",
      "The pass has no shelf life.",
      "Nobody can take the upgrade off a competition after checkout.",
      "Treat it as a one-off purchase that simply does not wear out.",
      "The upgrade will be there whenever you come back to the event.",
      "Buy it and the competition is covered from that day onward.",
    ];
    const fee = [
      "Once the trophy is handed out, entry costs return to normal and later entrants cost you more per head.",
      "Sign-ups arriving after the closing whistle are charged the plan's percentage.",
      "Once the fixtures are done we go back to taking a bigger share of each entry.",
      "Later sign-ups are billed at Community's percentage.",
      "Entrants who sign up after the final pay the full platform fee.",
      "The moment a competition is archived we take 8% again.",
      "Your take-home per entry shrinks once the pass is spent.",
      "Post-tournament entries carry the standard commission.",
      "When the event wraps up, your entrants go back to the standard 8%.",
      "The five per cent deal only covers entries taken before the event ends.",
      "Entry fees revert to the usual cut when the tournament finishes.",
      "Once the pass has done its job the cheaper rate is over.",
    ];
    expect(duration.filter(lexicalOnly).length, "lexical duration rate").toBe(1);
    expect(fee.filter(lexicalOnly).length, "lexical fee rate").toBe(4);
    // …and every one of them is caught once the gate is included.
    expect([...duration, ...fee].filter((s) => !detects(`${eventPass}\n\n${s}\n`))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK 7 — `content/help/billing/add-ons.md`, the article the shipped
// `billing.addons.extra-org` tip used to point around.
//
// It is GATED FROM DAY ONE rather than after it has carried a falsehood. See
// APPROVED_ADD_ONS_INVENTORY's header for the argument; the short version is
// that every paragraph of it is about money an organiser is charged, and it
// makes the very rate claim this wave has spent three rounds correcting.
//
// The only LEXICAL rule pointed at it is the half-rate one, reused whole from
// the dictionary guards — no new pattern is added anywhere for this article.
// That is deliberate: this wave's measured lesson is that a rule which reads
// the sentence scores on its author's imagination (1/12, 0/12, 6/30, 0/32,
// 1/40), so the answer to "cover a new page" is a pinned inventory, not another
// vocabulary. The pass-duration and fee-rate allowlists are deliberately NOT
// pointed here either: "the credits themselves never expire" is TRUE of a
// credit pack, and a guard that reds on true prose teaches the next editor to
// route around it.
// ─────────────────────────────────────────────────────────────────────────────
const addOns = helpArticle("add-ons");
const groups = helpArticle("groups");
/** Task 14b split groups.md by job: what joining costs now lives here. */
const addOrg = helpArticle("add-an-organisation");

/** Every inventory-gated help article, by slug. Shared by the axis describe and
 *  the rate measurements below so the two cannot disagree about what is gated. */
const GATED_ARTICLES: Record<string, string[]> = {
  "billing/add-ons": APPROVED_ADD_ONS_INVENTORY,
  "billing/groups": APPROVED_GROUPS_INVENTORY,
  "getting-started/create-your-organisation": APPROVED_CREATE_ORG_INVENTORY,
};

/** The seed rows this article quotes. Read from the seed, never restated — the
 *  claim and the number have to come from different places or the comparison
 *  proves nothing. */
const sizePack = stripePlans.size_packs.find((s) => s.key === "size_pack_32")!;
const orgAddons = stripePlans.org_addons;

/** The article as ONE value for the half-rate rule, joined the way
 *  `PLUS_CARD_VALUES` joins the Pro Plus bullets: with a full stop, so a
 *  qualifier cannot reach across two blocks. `claimTexts` covers frontmatter
 *  and prose (headings are a fragment, and are covered by the gate). */
const addOnsClaim = (text: string): LocalisedValue[] => [
  { locale: "en", key: "content/help/billing/add-ons.md", value: claimTexts(text).join(". ") },
];

describe("the add-ons article says what the billing code actually does", () => {
  it("is registered, non-empty, and has the surfaces the gate pins", () => {
    expect(HELP_ARTICLE_SLUGS).toContain("billing/add-ons");
    // The registry and the disk are gated both ways by
    // server/__tests__/help-content.test.ts; this asserts the tip that sent a
    // reader here resolves, which is the reason the article exists at all.
    expect(helpUrl(TIPS["billing.addons.extra-org"].helpSlug)).toBe("/help/billing/add-ons");
    expect(claimTexts(addOns).length, "the article scans as nothing").toBeGreaterThan(10);
    expect(APPROVED_ADD_ONS_INVENTORY.length, "an empty inventory gates nothing").toBeGreaterThan(20);
  });

  // THE GATE. Same rule, same reasons, as event-pass.md and plans.md above.
  it("is the copy that was approved, surface for surface", () => {
    expect(inventoryFaults("add-ons.md", addOns, APPROVED_ADD_ONS_INVENTORY)).toEqual([]);
  });

  // The extra-organisation rate, from the seed's own tiers. `riderClaimShape`
  // decides which qualifier is honest today, so if every rider ever became an
  // exact half a bare "half the base rate" stops being a fault — the guard is
  // not "always demand 'no more than'".
  it("quotes the extra-organisation rate in the shape the seed licenses", () => {
    const shape = riderClaimShape(stripePlans.plans as unknown as PricedPlan[]);
    expect(shape, "gbp (44.4%) and inr (40%) round DOWN while usd and eur are exact halves").toBe(
      "atMost",
    );
    expect(localeHalfClaimFaults(addOnsClaim(addOns), shape)).toEqual([]);
  });

  // ANTI-VACUITY for the rule above, both directions. An all-negative check
  // passes on an article that never mentions the rate at all, and a
  // presence-only check passes on one that states it wrongly.
  it("actually examines the rate sentence, rather than passing on silence", () => {
    const bare = addOns.replace(
      "costs no more than half the base rate",
      "costs half the base rate",
    );
    expect(bare, "the rate sentence moved — re-point this guard").not.toBe(addOns);
    expect(localeHalfClaimFaults(addOnsClaim(bare), "atMost")).not.toEqual([]);

    // …and deleting the claim is a fault too, not a way to pass. A buyer with
    // no idea what a second organisation costs is not better served than one
    // told the wrong number.
    const dropped = addOns.replace(/Each organisation after the first costs[^.]*\./, "");
    expect(dropped, "the rate sentence moved — re-point this guard").not.toBe(addOns);
    expect(localeHalfClaimFaults(addOnsClaim(dropped), "atMost")).not.toEqual([]);
  });

  // The three additive deltas, taken from the seed rather than restated. A
  // catalog edit that changes what a pack grants reds the page that sells it.
  it("quotes the seed's own add-on deltas", () => {
    // The EXTRA SEAT's delta used to be pinned here too. Entitlements v18 R13
    // hid that add-on: the article no longer names it, and the assertion could
    // not simply stay — `+1 each` is also the extra ORGANISATION's delta, so it
    // would have gone on passing against a row it no longer describes. A
    // vacuously-green assertion is worse than a deleted one, because it reads
    // as coverage. The seat's own catalog shape is still guarded, in
    // config/__tests__/stripe-plans.test.ts.
    // The SIZE PACK's delta went the same way in Task 14a, for the same
    // reason: the article no longer names an add-on nobody can buy from a
    // screen (see "says there is no add-on … only while that is still true"
    // below), and its catalog shape stays guarded in stripe-plans.test.ts.
    expect(sizePack.delta_each, "the size pack still exists in the catalog").toBeGreaterThan(0);
    expect(addOns, "a size pack is described again").not.toMatch(/size pack/i);
    expect(orgAddons.length, "no extra-organisation add-on to describe").toBeGreaterThan(0);
    for (const addon of orgAddons) {
      // The article spells the delta in words ("raises the limit by one").
      const WORDS: Record<number, string> = { 1: "one", 2: "two", 3: "three" };
      expect(WORDS[addon.delta_each], `${addon.key}'s delta has no word`).toBeDefined();
      expect(addOns, `${addon.key}'s delta`).toContain(`raises the limit by ${WORDS[addon.delta_each]}`);
      // Monthly-only is a CLAIM the article makes ("every month, whatever your
      // plan's own billing period"), so it is pinned to the seed, not assumed.
      expect(addon.price.interval, `${addon.key} is no longer monthly`).toBe("month");
    }
    // …and the one-time add-ons have no interval at all, which is what makes
    // "one-time" true of them and "every month" true of the recurring rider.
    expect(sizePack.price).not.toHaveProperty("interval");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE CLAIMS ROUND 1 GOT WRONG — pinned to the code, not to the gate.
//
// A GATE PROVES DELIBERATE, NEVER TRUE. Round 1 of this article was
// inventory-approved and shipped three false money claims; the fixture's own
// `why` notes named the files that contradicted them. Approving a digest
// records that somebody CHOSE these words — nothing more. So each of the three
// now has a rule that reads the code, and each asserts a known-positive on the
// same read before asserting the negative, so a rename reds rather than
// quietly making the guard vacuous.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// THE HALF-RATE CLAIM ACROSS THE WHOLE HELP TREE (fix round 2).
//
// Round 1 pinned the claim in the dictionaries and left the help tree alone.
// The review found it live in TWO articles — `billing/groups.md` six times
// (frontmatter included) and `getting-started/create-your-organisation.md`
// once, a file nothing in this wave had opened. Neither was scanned by any
// suite, and neither was in KNOWN_GAPS, so both were oversights rather than
// decisions.
//
// The fix is not "scan those two". It is to compute WHICH ARTICLES MAKE THE
// CLAIM from the tree itself: a new article that states the rate reds this
// suite until someone puts it on the axis. That is the same shape as
// `FAQ_PASS_SCOPED` in the dictionary suite, and it is the only version that
// survives somebody writing a fifth article.
// ─────────────────────────────────────────────────────────────────────────────
describe("every help article stating the extra-organisation rate states it honestly", () => {
  /** Article slug -> its claim text, for every article whose prose makes a
   *  half-rate claim in ANY shape the English vocabulary knows. Computed, not
   *  listed. */
  const claiming = new Map<string, string>();
  for (const article of allHelpArticles().values()) {
    // RAW, not `article.markdown`: `allHelpArticles` has already stripped the
    // frontmatter, and `groups.md` carried this very claim in its
    // `description:` — which is the lead paragraph, the page metadata and the
    // search snippet.
    const text = claimTexts(helpArticleBySlug(article.slug)).join(". ");
    if (LOCALE_CLAIMS.en.halfClaim.test(text)) claiming.set(article.slug, text);
  }

  /** The axis, pinned. Adding an article that states the rate is a decision. */
  const ON_THE_AXIS = [
    "billing/add-ons",
    "billing/groups",
    "getting-started/create-your-organisation",
  ];

  /** Every article on the axis is INVENTORY-GATED. Shared, so "what is gated"
   *  has one definition. */
  const GATES = GATED_ARTICLES;

  it("knows exactly which articles make the claim", () => {
    expect([...claiming.keys()].sort()).toEqual(ON_THE_AXIS);
    // ANTI-VACUITY: a vocabulary that drifted narrow would sweep nothing in and
    // every article below would pass by never being examined.
    expect(claiming.size, "no article was classified at all").toBeGreaterThan(2);
  });

  /**
   * ON THE AXIS MEANS GATED. Measured: off-vocabulary false rate claims pasted
   * into groups.md and create-your-organisation.md shipped 119/119 GREEN, and
   * so did a whole new help article; the same edit to the gated add-ons.md
   * redded at once. The vocabulary scored 0/24 on the reviewer's set.
   *
   * That number bites the axis itself, because the axis is computed THROUGH
   * `en.halfClaim`: membership was being decided by a regex that catches
   * almost nothing. So the axis is not the defence — the gate is — and this
   * assertion is what stops an article joining the axis without one.
   */
  it("gates every article on the axis, because the vocabulary cannot defend them", () => {
    for (const slug of ON_THE_AXIS) {
      expect(GATES[slug], `${slug} is on the half-rate axis but has no inventory`).toBeDefined();
      expect(GATES[slug]!.length, `${slug}'s inventory is empty`).toBeGreaterThan(8);
    }
    expect(Object.keys(GATES).sort(), "a gate exists for an article not on the axis").toEqual(
      ON_THE_AXIS,
    );
  });

  it("is the copy that was approved, surface for surface, in all of them", () => {
    for (const [slug, approved] of Object.entries(GATES)) {
      expect(allHelpArticles().has(slug), `${slug} is gated but not on disk`).toBe(true);
      expect(inventoryFaults(`${slug}.md`, helpArticleBySlug(slug), approved), slug).toEqual([]);
    }
  });

  // …and the gate catches what the vocabulary provably does not: the reviewer's
  // own off-vocabulary set, which shipped green against these two files.
  it("catches the off-vocabulary claims that scored 0/24 on the vocabulary", () => {
    const OFF_VOCABULARY = [
      "Each extra organisation costs 50% of the base rate.",
      "Every organisation after the first costs half as much as the first.",
      "An extra organisation is half of what the plan costs.",
      "Extra organisations come in at fifty percent of the base rate.",
    ];
    for (const slug of ON_THE_AXIS) {
      const markdown = helpArticleBySlug(slug);
      for (const added of OFF_VOCABULARY) {
        const mutated = `${markdown}\n\n${added}\n`;
        // The vocabulary: this is the 0/24 result, asserted rather than described.
        expect(
          LOCALE_CLAIMS.en.halfClaim.test(added),
          `${added} — if the vocabulary now catches this, re-measure the rate below`,
        ).toBe(false);
        // The gate: catches every one, because it is not reading them.
        expect(inventoryFaults("x", mutated, GATES[slug]!), `${slug} <- ${added}`).not.toEqual([]);
      }
    }
  });

  it("states it in the shape the seed licenses, in all of them", () => {
    const shape = riderClaimShape(stripePlans.plans as unknown as PricedPlan[]);
    for (const [slug, text] of claiming) {
      expect(
        localeHalfClaimFaults([{ locale: "en", key: `content/help/${slug}.md`, value: text }], shape),
        slug,
      ).toEqual([]);
    }
  });

  // …and the rule really fires on the wording each article actually shipped.
  // Absence of faults proves "honest" only if the dishonest form would fault.
  it("faults the exact phrasings these two articles carried", () => {
    for (const shipped of [
      "Every organisation after that is half the base rate",       // groups.md:13
      "extra organisations are half price",                        // groups.md frontmatter
      "The bill goes up by half the plan rate straight away",      // groups.md:41
      "that headroom is what the extra half-price rate buys",      // groups.md:137
      "each one after the first at half the rate",                 // create-your-organisation.md:25
      "each organisation after the first is half your plan's rate", // the dictionaries
    ]) {
      expect(
        localeHalfClaimFaults([{ locale: "en", key: "x", value: shipped }], "atMost"),
        shipped,
      ).not.toEqual([]);
    }
  });
});

describe("codeOnly strips comments and nothing else", () => {
  // Written against the shapes that defeated the hand-rolled version. Each one
  // is a real idiom in this repo, not a synthetic curiosity.
  const CASES: Array<[name: string, source: string, mustKeep: string, mustDrop: string]> = [
    [
      "a `/*` inside a string literal (the live defect)",
      'const a = <input accept="image/*" />;\n// gone\nconst b = 1;',
      'accept="image/*"',
      "gone",
    ],
    [
      "a `//` inside a regex literal",
      "const url = /https?:\\/\\//; // gone\nconst keep = 2;",
      "const keep = 2;",
      "gone",
    ],
    [
      "a `/*` inside a template literal spanning lines",
      "const t = `line one /* not a comment\nline two`; /* gone */\nconst keep = 3;",
      "line two`",
      "gone",
    ],
    [
      "an apostrophe in a block comment",
      "/* it's fine */\nconst keep = 4;",
      "const keep = 4;",
      "it's fine",
    ],
    [
      "a block comment containing a quote character",
      'const keep = 5; /* say "hello" */\nconst also = 6;',
      "const also = 6;",
      "hello",
    ],
  ];

  it.each(CASES)("keeps the code and drops the comment: %s", (_name, source, keep, drop) => {
    const stripped = codeOnly(source, "case.tsx");
    expect(stripped, "code was lost").toContain(keep);
    expect(stripped, "a comment survived").not.toContain(drop);
    // BLANKING, not deleting: offsets and line numbers must still line up, or a
    // fault message quoting a line number starts lying.
    expect(stripped.length).toBe(source.length);
    expect(stripped.split("\n").length).toBe(source.split("\n").length);
  });

  // ANTI-VACUITY: the cases must actually exercise the failure. Each `mustDrop`
  // has to be present before stripping, or "not.toContain" proves nothing.
  it("every case really contains what it claims to drop", () => {
    for (const [name, source, , drop] of CASES) {
      expect(source.includes(drop), `${name}: the fixture never contained "${drop}"`).toBe(true);
    }
  });

  /**
   * THE AUDIT ITSELF MUST FIRE. `blankedInsideLiteralFaults` is the per-file
   * recurrence guard, and the thing it replaced was vacuous by construction —
   * so it is exercised here against a deliberately BAD strip rather than only
   * against the real one, which is correct and therefore proves nothing.
   */
  it("faults a strip that blanks inside a literal, and passes the real one", () => {
    const source = 'const a = <input accept="image/*" />;\nconst b = "keep me";\n';
    const good = stripComments(source, "case.tsx");
    expect(blankedInsideLiteralFaults("case.tsx", source, good), "the real strip").toEqual([]);
    expect(good.literals.length, "no literals were found to audit").toBeGreaterThan(1);

    // The historical bug, reproduced: blank from the `/*` inside the string to
    // somewhere later, exactly as the old regex did — length-preserving, so the
    // round-4 invariant would still have called this clean.
    const from = source.indexOf("image/") + "image/".length;
    const to = source.indexOf("keep me");
    const chars = source.split("");
    for (let i = from; i < to; i += 1) if (chars[i] !== "\n") chars[i] = " ";
    const bad = { code: chars.join(""), literals: good.literals };
    expect(bad.code.length, "the bad strip must be length-preserving, like the real bug").toBe(
      source.length,
    );
    expect(bad.code.split("\n").length).toBe(source.split("\n").length);

    const faults = blankedInsideLiteralFaults("case.tsx", source, bad);
    expect(faults.length, "the audit did not notice code being eaten").toBeGreaterThan(0);
    expect(faults[0]).toContain("eating code");
  });

  // COMMENTS OWNED BY A CLOSING TOKEN ARE NOT BLANKED, and this records it
  // rather than implying otherwise. `forEachChild` never visits TOKENS, so a
  // comment whose nearest owner is a closing token survives the strip. This
  // case uses `{/* … */}` because it is the shortest reproduction, but the
  // mechanism is GENERAL — end-of-block comments, empty blocks, last call
  // arguments, last array elements, last object properties, ends of interface
  // bodies, `switch` and `if` blocks all survive too, in plain `.ts` as much as
  // in `.tsx`. Only an end-of-file comment is blanked. Measured tree-wide: 569
  // comment lines / 32,229 chars across 168 of 1,460 files.
  //
  // The direction is FAIL-SAFE (a negative scan may red on a comment that
  // mentions the idiom; it can never miss real code), which is why it is
  // recorded in KNOWN_GAPS rather than fixed. Round 5 recorded it as a `.tsx`
  // idiom problem; that scoping was wrong, and it is corrected here and in
  // KNOWN_GAPS — see also the FAIL-OPEN literal-free-span gap listed beside it.
  it("does NOT strip a comment owned by a closing token — recorded, fail-safe", () => {
    const source = "const x = <div>{/* jsxcomment */}<b>keep</b></div>;\n";
    const stripped = codeOnly(source, "case.tsx");
    expect(stripped, "code must survive regardless").toContain("<b>keep</b>");
    expect(stripped, "if this now strips, update KNOWN_GAPS and this test").toContain(
      "jsxcomment",
    );
  });
});

describe("the add-ons article's behaviour claims are pinned to the code", () => {
  // CLAIM: "An extra seat freezes members … An extra organisation does not
  // freeze anything." Round 1 said the excess freezes for BOTH.
  // TIMEOUT, deliberately, and THE TIMEOUT IS WHAT KEEPS THIS GREEN — not the
  // memoisation. This walks and TypeScript-parses ~1,400 files. It passed alone
  // and TIMED OUT at 8.4s against the 5s default in the full parallel run; a
  // guard that fails only under contention is worse than a slow one, because it
  // reads as flake and gets retried rather than read.
  //
  // `allAuditedSources()` memoises walk and parse so later consumers are ~3ms,
  // but the FIRST consumer still pays the whole cost: measured 1.65s alone and
  // 9.3s in the full run (file total 10.5s). Quoting the isolated figure would
  // be the same kind of optimism this wave keeps correcting elsewhere, so both
  // are here. The 60s is real headroom for a loaded machine, not decoration.
  //
  // RESTORED after #372 removed it. That removal measured this test ALONE
  // (2.1s) and read it as leftover padding — past the paragraph above, which
  // had already said the isolated figure is the misleading one. Re-measured
  // inside a full `vitest run` of all 532 files: 41.8s, and it failed on the
  // 30s config default. Allowlisted in inline-timeout-truth.test.ts, which is
  // what that allowlist is for.
  it("freezes exactly the two axes the article says, and orgs.max_owned is not one", { timeout: 60_000 }, () => {
    const source = webSource("server/usecases/entitlement-freeze.ts");
    const frozen = [...source.matchAll(/getLimit\(orgId,\s*"([^"]+)"\)/g)].map((m) => m[1]!);

    // KNOWN-POSITIVE FIRST: if `getLimit(orgId, "...")` is ever spelled another
    // way, this reds instead of the negative below passing on an empty list.
    expect(frozen.sort(), "the freeze axes changed — re-read the article").toEqual([
      "competitions.max_active",
      "members.max",
    ]);

    // THE NEGATIVE the prose depends on. `lib/billing-group.ts` states the org
    // cap is ADMISSION-ONLY (`count + 1 > limit` on the way IN, never
    // re-evaluated), so there is no freeze for an extra organisation to cause.
    expect(frozen, "orgs.max_owned is now a freeze axis — the article says it is not").not.toContain(
      "orgs.max_owned",
    );
    expect(
      webSource("lib/billing-group.ts"),
      "the ADMISSION-ONLY note is gone — re-check what an over-cap group can do",
    ).toContain("never re-evaluated against organisations that already exist");

    /*
     * THE EXTRA-ORGANISATION FLOOR, which nothing asserted at all.
     *
     * The article says the control refuses to go below a number, TWICE — once
     * where the add-on is bought and once in the paragraph this test is named
     * after. Round 6 corrected the first and left the second saying "the number
     * of organisations the group is standing on", which is the org count: the
     * exact quantity its own fix note had just called wrong. Only the inventory
     * digest covered either, and a digest proves DELIBERATE, never TRUE.
     *
     * `ridersInUse` is `clamp(liveOrgs - base - grantedBonus, 0, purchased)`, so
     * a Pro group with 6 live orgs has a floor of 1 — the RIDER count. Both
     * sentences now say that, and both are checked, because the fourth
     * adjacent-surface miss of this wave was a sentence sixteen lines from the
     * one being fixed.
     */
    const floorSource = webSource("lib/billing-group.ts");
    // KNOWN-POSITIVE: the arithmetic really is rider-shaped. If `ridersInUse`
    // is renamed or its formula changes, this reds instead of the copy rule
    // silently guarding nothing.
    expect(floorSource, "ridersInUse moved — re-read what the floor actually is").toContain(
      "const standingOnRiders = basis.liveOrgs - basis.base - basis.grantedBonus",
    );
    expect(floorSource).toContain("Math.max(0, Math.min(standingOnRiders, purchased))");
    // The copy must describe the RIDER count, both times it makes the claim…
    const floorClaims = addOns.match(/refuses to go below[^.:]*|cannot go below[^.:]*/gi) ?? [];
    expect(floorClaims.length, "the article stopped stating the extra-organisation floor").toBe(2);
    for (const claim of floorClaims) {
      expect(
        claim,
        `"${claim}" names a count of organisations, but the floor is the number STANDING ON an extra organisation (ridersInUse)`,
      ).toMatch(/standing\s+on\s+an\s+extra\s+organisation/i);
    }
    // …and must never fall back to the bare org-count wording, which is what
    // both sentences said before and reads as "you cannot go below 6".
    expect(addOns, "the floor is the rider count, not the organisation count").not.toMatch(
      /go below the number of organisations (the group is (actually )?(using|standing on)|it (has|holds))/i,
    );
    // The product string says it correctly and is the sentence a buyer sees at
    // the control itself; the article must agree with it rather than drift.
    // F16 split this into .one/.other (the flat key read "1 organisation...
    // are standing" at the commonest floor, min: 1); both halves carry the
    // same claim, checked here against .other for continuity with what this
    // assertion pinned before the split.
    expect(
      JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8"))["addOns.extraOrg.floorNote.other"],
      "the floorNote moved — the article was written to agree with it",
    ).toMatch(/standing on an extra organisation/i);

    // …and the article says the org half, so it cannot be dropped silently.
    // The SEAT half ("an extra seat stops you adding members") went with the
    // extra seat in Task 14a — no screen sells one, so add-ons.md no longer
    // names it. The member freeze it described is a downgrade fact, and is
    // pinned on downgrade.md here, where the article now states it.
    expect(addOns, "the org non-freeze").toMatch(/extra organisation does not freeze anything/i);
    const downgradeCopy = helpArticle("downgrade");
    expect(downgradeCopy, "the member freeze is stated").toMatch(
      /members who joined earliest are frozen first/i,
    );
    // The owner exemption is real (`frozenMemberIds` filters role === "owner").
    expect(source).toContain('r.role === "owner"');
    expect(downgradeCopy).toMatch(/Owners are never frozen/);
    // …and NOTHING renders a mark (fix round 6, M2). `frozenMemberIds` has one
    // production caller, `assertMemberNotFrozen`; no read model flags a member.
    // Competitions ARE flagged in read models, which is the contrast the module
    // header draws and the reason "marked" read as a UI promise it never kept.
    for (const [label, copy] of [["add-ons.md", addOns], ["downgrade.md", downgradeCopy]] as const) {
      expect(copy, `${label} must not promise a badge nobody renders`).not.toMatch(
        /(are|is)\s+marked\s+read-only|that\s+mark\s+is/i,
      );
    }
    expect(downgradeCopy, "…and must say how it actually behaves").toMatch(
      /their changes are refused\. Nothing on screen marks them in advance\./,
    );
    // Task 14a: the member-freeze REACH below was pinned on add-ons.md's
    // extra-seat paragraph. That paragraph went with the extra seat, and the
    // freeze is now explained where a reader meets it — downgrade.md — so every
    // reach assertion below reads that page instead.

    // HOW FAR THE SEAT FREEZE ACTUALLY REACHES. Round 2 said the limit is
    // "re-checked on every write". It is not: `assertMemberNotFrozen` has ONE
    // production call site, and it is gated three ways.
    const apiAuth = codeOnly(webSource("server/api-v1/auth.ts"), "auth.ts");
    // PER-FILE KNOWN-POSITIVE, not one global fixture. A walk over ~1,400
    // files with a single count assertion cannot notice that ONE file was
    // silently skipped — and one was: `codeOnly`'s first implementation ate
    // 198 lines of `components/v2/division-settings.tsx` because
    // `accept="image/*"` opened a phantom block comment, and a call planted
    // inside that span was invisible while the suite stayed green.
    //
    // `codeOnly` BLANKS rather than deletes, so length and line count are
    // invariants of a correct strip. Asserting them per file is what makes a
    // swallowed span impossible to miss, whatever swallows it.
    // PER-FILE AUDIT, and it is content-based this time. Round 4's version
    // asserted `stripped.length === raw.length` and an equal line count —
    // BOTH TRUE FOR EVERY INPUT, because `stripComments` blanks into
    // `source.split("")` and cannot change either. It examined nothing while
    // its comment claimed it made a swallowed span "impossible to miss": the
    // sixth instance of that shape in this wave, and the first I wrote while
    // fixing an instance of it.
    //
    // `blankedInsideLiteralFaults` asks the question that actually separates a
    // correct strip from the bug — did any character INSIDE a string, regex or
    // JSX literal change? The literal spans come from the AST, not from the
    // comment ranges, so this is independent of the decision it audits. The
    // historical bug blanked from a `/*` sitting inside `"image/*"`, squarely
    // inside a literal, and fails it loudly.
    const raws = new Map(allSourceFiles());
    const mangled: string[] = [];
    const callSites: string[] = [];
    for (const [file, stripped] of allAuditedSources()) {
      mangled.push(...blankedInsideLiteralFaults(file, raws.get(file)!, stripped));
      if (file.includes("__tests__") || file === "server/usecases/entitlement-freeze.ts") continue;
      if (stripped.code.includes("assertMemberNotFrozen")) callSites.push(file);
    }
    expect(
      mangled,
      "the comment strip is eating code — every negative scan over these files is unsound",
    ).toEqual([]);
    // ANTI-VACUITY: the audit must have had literals to look at. A parse that
    // silently produced none would pass the loop above on every file.
    const literalCount = allAuditedSources().reduce((n, [, s]) => n + s.literals.length, 0);
    expect(literalCount, "no literals were found in the whole tree — the parse is not working").toBeGreaterThan(
      5_000,
    );
    // …and the specific string that broke it, pinned as a regression.
    const divisionSettings = allAuditedSources().find(
      ([f]) => f === "components/v2/division-settings.tsx",
    );
    expect(divisionSettings, "the regression fixture moved — re-point it").toBeDefined();
    expect(
      divisionSettings![1].code,
      "a comment-opener inside a string literal must not open a comment",
    ).toContain('accept="image/*"');
    expect(callSites, "the freeze reaches further than the article says — re-read it").toEqual([
      "server/api-v1/auth.ts",
    ]);
    // …and that one site is admin-only, write-only, session-only: a bearer
    // token returns from `apiKeyAuth` before ever reaching it, so API-KEY
    // writes are never freeze-checked at all.
    expect(apiAuth).toContain('if (scope === "write" && role === "admin")');
    expect(apiAuth).toContain("if (token) return apiKeyAuth(req, token, orgId);");
    expect(downgradeCopy, "the article must not over-promise enforcement").not.toMatch(
      /re-?checked on every write/i,
    );
    // …and it must name the RIGHT surface. "our public API" was still wrong:
    // on that API the normal caller is a bearer `sc_` key, and `apiKeyAuth`
    // returns BEFORE the freeze check — so an API-key client is never checked
    // either.
    // "only" is deliberately gone from this sentence. It was there to mark the
    // freeze as narrow, and the freeze is not narrow — it reaches 83 write
    // routes across 17 URL prefixes. What IS exclusive is the API-key exemption,
    // which is what the clause now carries.
    // In house voice: "admins" for the signed-in role check, "API keys are
    // not affected" for the bearer branch that returns before it.
    expect(downgradeCopy, "…and must say where it IS enforced").toMatch(/The freeze applies to admins\./);
    // Review m1: "API keys are not affected" read as a contradiction beside
    // "API keys stop working" — the freeze only bites on Community, where
    // api.access is false. The page now says both halves in one sentence.
    expect(downgradeCopy, "…and that API-key clients are exempt").toMatch(
      /The freeze is separate from API keys, which stop working on Community anyway\./,
    );
    expect(downgradeCopy, "'blocks only …' understates the reach").not.toMatch(
      /blocks only signed-in admins/i,
    );

    /*
     * WHO CALLS THOSE ROUTES — AND THAT MEANS *ALL* OF THEM.
     *
     * Round 3 counted the 13 `app/api/v1/**` routes using `requireOrgAuth` and
     * called that coverage. Counting a surface proves its SIZE, never its
     * REACH, so the article was free to say the freeze reaches "not the app's
     * own screens" with this guard agreeing.
     *
     * Round 6 fixed the direction and got the SCOPE wrong the same way: it
     * discovered callers by the single URL prefix `/api/v1/orgs/`, found five
     * screens, and had the article name four. But the freeze lives in
     * `requireOrgAuth`, and `requireResourceAuth` DELEGATES TO IT
     * (`server/api-v1/auth.ts` — it resolves the org then calls
     * `requireOrgAuth(req, orgId, scope)`). Measured: **83 write-scoped route
     * files are freeze-checked, across 17 URL prefixes, and 47 component files
     * write through them.** `/api/v1/divisions/[id]` PATCH,
     * `/api/v1/entrants/[id]` PATCH, `/api/v1/fixtures/[id]` PATCH — the whole
     * editing product. A component planted on a `requireResourceAuth` route
     * shipped 285/0 GREEN while the same component on `/api/v1/orgs/...` redded:
     * the rule worked perfectly inside its slice and was silent on the other 85%.
     *
     * So the copy CANNOT be an enumeration, and this guard must not ask for one.
     * A four-screen list was wrong by an order of magnitude; a 47-file list in
     * prose would be unreadable and stale within a sprint. The copy states the
     * SCOPE ("most of the app") with examples marked as examples, and the guard
     * checks the thing that makes that scope claim true: the caller set is
     * BROAD, and the exemplars the copy names are really in it.
     */
    const freezeRoutes = freezeCheckedWriteRoutes();
    const prefixes = freezeCheckedUrlPrefixes(freezeRoutes);
    // KNOWN-POSITIVES on the same read. A walk that found nothing would make
    // every "is broad" assertion below fail loudly rather than pass quietly,
    // but the floors also say WHICH half broke.
    expect(freezeRoutes.length, "no freeze-checked write routes found — the walk is broken").toBeGreaterThan(50);
    expect(
      freezeRoutes,
      "the org-scoped write routes moved — re-point this guard",
    ).toContain("app/api/v1/orgs/[id]/api-keys/route.ts");
    expect(
      prefixes,
      "requireResourceAuth routes are no longer being reached — the freeze looks smaller than it is",
    ).toEqual(expect.arrayContaining(["/api/v1/orgs/", "/api/v1/divisions/", "/api/v1/entrants/"]));
    // …and `requireResourceAuth` really does delegate. If it ever stopped, the
    // 85% would genuinely leave the freeze's reach and the copy would need
    // re-reading — so the delegation is asserted, not assumed.
    expect(
      apiAuth,
      "requireResourceAuth no longer delegates to requireOrgAuth — the freeze's reach has changed",
    ).toMatch(/requireResourceAuth[\s\S]{0,400}?return\s+requireOrgAuth\(req,\s*orgId,\s*scope\)/);

    const callers = allStrippedSources()
      .filter(([f]) => f.startsWith("components/") && !f.includes("__tests__"))
      .filter(([, src]) => prefixes.some((p) => src.includes(p)))
      .map(([f]) => f)
      .sort();
    // THE SCOPE CLAIM, checked as a scope claim. "Most of the app" is true while
    // this set is large; if it ever shrank to a handful the sentence would be an
    // overstatement and somebody has to re-read it. Floor measured at 47.
    expect(
      callers.length,
      `the freeze now reaches only ${callers.length} component files — the article says "most of the app", and that is no longer obviously true`,
    ).toBeGreaterThan(30);
    // …and the discovery must genuinely SPAN BEYOND the `/api/v1/orgs/` slice,
    // which is the whole defect being fixed. A regression to prefix-on-`orgs`
    // would still clear the floor above by counting the same five files plus
    // noise, so require callers whose only freeze-checked routes are
    // `requireResourceAuth` ones. Measured: the large majority.
    const resourceOnlyCallers = allStrippedSources()
      .filter(([f]) => f.startsWith("components/") && !f.includes("__tests__"))
      .filter(([, src]) => !src.includes("/api/v1/orgs/"))
      .filter(([, src]) => prefixes.some((p) => p !== "/api/v1/orgs/" && src.includes(p)))
      .map(([f]) => f);
    expect(
      resourceOnlyCallers.length,
      "discovery has collapsed back to the /api/v1/orgs/ slice — requireResourceAuth routes are freeze-checked too, and they are 85% of the surface",
    ).toBeGreaterThan(20);

    // The copy must not read as a closed enumeration of a few screens…
    expect(downgradeCopy, "the freeze is not a four-screen corner of the product").not.toMatch(
      /\(API keys, News, Sponsors, Payments\)|not\s+the\s+app['’]s\s+own\s+screens/i,
    );
    // …must state the scope positively…
    expect(downgradeCopy, "the article must say how far the freeze actually reaches").toMatch(
      /blocked\s+across\s+most\s+of\s+the\s+app/i,
    );
    // …and every example it names must be a real caller, so the illustration is
    // not itself a falsehood.
    // "registrations" DROPPED from both this list and the article's own
    // example sentence (RS001 registration demolition):
    // components/v2/registrations-panel.tsx is deleted along with the rest of
    // the old org-console registration UI, and nothing replaces it as a
    // freeze-checked caller until RS004/RS005/RS009 ship the new
    // competition-level Registration hub. Naming it here would assert a file
    // that no longer exists.
    for (const [example, file] of [
      ["schedule board", "components/v2/schedule-board.tsx"],
      ["entrants", "components/v2/entrants-panel.tsx"],
      ["officials", "components/v2/officials-panel.tsx"],
      ["settings", "components/v2/division-settings.tsx"],
    ] as const) {
      expect(downgradeCopy, `the article stopped naming ${example}`).toContain(example);
      expect(
        callers,
        `the article names ${example} as an example, but ${file} no longer writes through a freeze-checked route`,
      ).toContain(file);
    }

    /*
     * …and WHY those callers are session-authenticated, read off the code that
     * decides it rather than asserted as prose.
     *
     * What matters is the HEADERS OBJECT: it carries `Content-Type` and nothing
     * else, so no request can present a bearer token, so none can take the
     * `apiKeyAuth` branch — which is exactly what leaves them on the session
     * branch and freeze-checked. Add an `Authorization` header anywhere in this
     * set and the corrected sentence becomes false again.
     *
     * READ OFF THE AST (`headersObjects`), because round 6's
     * `matchAll(/headers:\s*\{([^}]*)/g)` stopped at the FIRST `}` — which in
     * `lib/client-v1.ts` and `components/api-keys.tsx` is the one inside
     * `...(rest.headers ?? {})`. Everything after the spread was invisible:
     * measured, an `Authorization` added AFTER the spread in `api-keys.tsx`
     * shipped 285/0 GREEN while the same header in `org-sponsors.tsx`'s plain
     * object redded. The guard was blind at exactly the two files that matter.
     *
     * Scanned over EVERY discovered caller, not a hand-listed five — the spread
     * also means any caller can pass `Authorization` through `options.headers`,
     * so the caller-side objects are part of the same invariant.
     */
    /*
     * ONE EXEMPTION, AND ITS PREDICATE IS DECIDABLE.
     *
     * `device-score-pad.tsx` DOES send `Authorization: Bearer ${token}` — the
     * widened scan found it on its first run, which is the scan earning its
     * keep. It is a device-link surface: the token is a device-link token, and
     * `requireOrgAuth` calls `rejectDeviceLink(req)` FIRST, which throws 403 for
     * exactly those tokens. So it can never reach the freeze branch, and the
     * routes it uses (`/api/v1/fixtures/[id]/state`, `/events`, and since W2c
     * Task 15 the GET of `/rules` its pad reloads after a correction)
     * authenticate through `requireFixtureActor`, not `requireOrgAuth` at all
     * (`/rules`' PUT is organiser-only, and the pad never sends it). It matches the
     * caller walk only because OTHER `/api/v1/fixtures/` routes are
     * freeze-checked, so the prefix is a false positive for this file.
     *
     * The exemption is checked, not asserted: the rejection must still be in
     * `auth.ts`, the file must still send only a device-link bearer, and an
     * entry that has stopped sending `Authorization` at all is a FAULT — or the
     * list becomes the place a real regression hides.
     */
    const DEVICE_LINK_CALLERS = ["components/v2/device-score-pad.tsx"];
    expect(
      apiAuth,
      "requireOrgAuth no longer rejects device links — a device-link bearer can now reach the freeze branch, and this exemption is void",
    ).toMatch(/rejectDeviceLink\(req\)/);
    expect(
      apiAuth,
      "rejectDeviceLink no longer throws for a device-link token — re-read the exemption",
    ).toMatch(/function rejectDeviceLink[\s\S]{0,200}?deviceLinkToken\(req\)[\s\S]{0,200}?throw new HttpError\(\s*403/);

    let headerObjectCount = 0;
    let sawContentType = false;
    for (const file of ["lib/client-v1.ts", ...callers]) {
      const objects = headersObjects(webSource(file), file);
      const exempt = DEVICE_LINK_CALLERS.includes(file);
      if (exempt) {
        const authHeaders = objects.filter((o) => /Authorization/i.test(o));
        // A STALE EXEMPTION IS A FAULT. If this file stops sending a bearer at
        // all, it belongs back in the scanned set.
        expect(
          authHeaders.length,
          `${file} is exempted as a device-link surface but sends no Authorization header any more — remove the exemption`,
        ).toBeGreaterThan(0);
        for (const object of authHeaders) {
          expect(
            object,
            `${file}: the exemption covers DEVICE-LINK bearers only — this header is something else, and it would take the caller to the API-key branch`,
          ).toMatch(/Authorization:\s*`Bearer \$\{token\}`/);
        }
        continue;
      }
      for (const object of objects) {
        headerObjectCount += 1;
        if (/Content-Type/.test(object)) sawContentType = true;
        expect(
          object,
          `${file}: an Authorization header would move this caller to the API-key branch, which is NOT freeze-checked — the article's sentence would need re-reading`,
        ).not.toMatch(/Authorization/i);
      }
    }
    // ANTI-VACUITY on the extraction itself: a walk that parsed nothing would
    // satisfy every negative above for free.
    expect(headerObjectCount, "no headers object was extracted — the AST walk is not working").toBeGreaterThan(5);
    expect(sawContentType, "the extraction found no Content-Type — it is not reading real headers").toBe(true);
    // The AST must see PAST a spread, which is the hole this replaced.
    expect(
      headersObjects(
        'const r = fetch(u, { headers: { "Content-Type": "application/json", ...(rest.headers ?? {}), Authorization: "x" } });',
        "probe.ts",
      ).join(" "),
      "the extraction stops at the first closing brace again",
    ).toMatch(/Authorization/);
    // …and must NOT see JSX documentation text, which is what made a character
    // window look necessary (`api-keys.tsx` renders "Authorization: Bearer sc_…"
    // in a <code> block).
    expect(
      headersObjects('const El = () => <code>Authorization: Bearer sc_…</code>;', "probe.tsx"),
    ).toEqual([]);

    // The half that IS enforced everywhere is ADMISSION: an invite past
    // members.max is refused in the same transaction (role changes are not).
    expect(codeOnly(webSource("lib/invites.ts"), "invites.ts")).toContain('"members.max"');
    expect(downgradeCopy).toMatch(/invitation that would take you past the limit is refused/i);
  });

  // CLAIM: "added to your next invoice rather than charged on the spot."
  // Round 1 said "charged pro rata straight away" / "charges the difference now".
  it("raises with create_prorations, which bills next invoice — never always_invoice", () => {
    for (const file of ["server/usecases/extra-seats.ts", "server/usecases/extra-orgs.ts"]) {
      const source = webSource(file);
      // KNOWN-POSITIVE: the raise path really does set a proration behaviour.
      expect(source, `${file} sets no proration behaviour at all`).toContain(
        'proration_behavior: "create_prorations"',
      );
      // THE NEGATIVE: `always_invoice` is what would charge immediately.
      expect(source, `${file} now invoices immediately — the article says it does not`).not.toContain(
        "always_invoice",
      );
    }
    // Stated where the behaviour is documented, so the article and the comment
    // cannot drift apart.
    expect(webSource("server/usecases/billing-events/addon-pricing.ts")).toContain(
      "books those adjustments onto the next invoice rather than",
    );
    // BOTH raise paths say it. One would leave the other free to drift back to
    // "now" — which is exactly the shape round 1 shipped.
    // ONE, not two. The seat's own raise paragraph went with the extra-seat
    // advertisement (entitlements v18 R13); the extra-organisation paragraph is
    // the only place left that states the timing, and it still must. A count
    // rather than a floor, so re-adding the hidden add-on's copy reds and gets
    // read against `create_prorations` above.
    expect(
      addOns.match(/\*\*added to your next invoice\*\* rather than charged on the spot/g) ?? [],
      "the raise path must state the timing",
    ).toHaveLength(1);
    expect(addOns).not.toMatch(/charged pro rata straight away|the difference[^.]*\bnow\b/i);

    // The product's own UI copy already avoided "now" on this exact claim; the
    // article contradicting it was the tell. Pinned so they move together.
    const prorateUp = JSON.parse(
      readFileSync("src/dictionaries/en/ui.json", "utf8"),
    )["addOns.extraOrg.prorateUp"] as string;
    expect(prorateUp, "the UI copy that got this right").toBe(
      "You'll pay the difference for the rest of this billing period.",
    );
    expect(prorateUp).not.toMatch(/\bnow\b/i);
  });

  // CLAIM (groups.md + the attach dialog): the added organisation is prorated
  // onto the NEXT invoice, and nothing is charged at the moment of attach.
  //
  // ROUND 2 ASSERTED THE OPPOSITE, in this file's sibling fixture, on the
  // strength of a COMMENT (billing-groups.ts:206-207, "charged immediately")
  // that the code contradicted — the same defect this wave exists to remove,
  // committed while fixing it. The comment is corrected; this is what stops it
  // mattering again.
  it("attaches with create_prorations too — nothing charges a card at attach", () => {
    // CODE ONLY. The comment correcting this very defect names `always_invoice`,
    // so a raw scan would fire on its own explanation.
    const source = codeOnly(webSource("server/usecases/billing-groups.ts"), "billing-groups.ts");
    const withComments = webSource("server/usecases/billing-groups.ts");

    // KNOWN-POSITIVE: the quantity write really is here and really does set a
    // proration behaviour. Without this, a refactor that moved the call would
    // leave every negative below passing on a file that no longer bills.
    expect(source, "syncGroupQuantity's proration write moved").toContain(
      'proration_behavior: raising ? "create_prorations" : "none"',
    );

    // THE NEGATIVES the copy depends on. `always_invoice` is the idiom that
    // charges on the spot — it exists in this repo (lib/billing-manage.ts, the
    // PLAN-CHANGE path), so its absence here is a real distinction, not a
    // vacuous one.
    for (const immediate of ["always_invoice", "invoices.create(", "invoices.pay", "payment_behavior", "billing_cycle_anchor"]) {
      expect(source, `billing-groups.ts now uses ${immediate} — the attach copy says nothing is charged at attach`).not.toContain(
        immediate,
      );
    }
    // …and the distinction is real: the plan-change path DOES invoice at once.
    expect(
      codeOnly(webSource("lib/billing-manage.ts"), "billing-manage.ts"),
      "the always_invoice idiom vanished — re-check what still charges immediately",
    ).toContain('proration_behavior: "always_invoice"');

    // The preview is read-only. It is the only `invoices.*` call in the file,
    // and the dialog's figure comes from it.
    expect(source).toContain("invoices.createPreview");

    // The corrected comment, so the next reader is not caught the way I was.
    expect(withComments, "the stale 'charged immediately' comment is back").not.toContain(
      "seat is charged immediately",
    );

    // …and the copy says the true thing, in both the article and the dialog.
    // Task 14b: the attach-cost copy moved from groups.md to add-an-organisation.md.
    expect(addOrg).toMatch(/Nothing is charged to your card when an organisation joins\./);
    expect(addOrg).toMatch(/prorated to the rest of the current period and added to your next invoice/i);
    for (const page of [groups, addOrg]) {
      expect(page).not.toMatch(/charged now|charged to your card (straight away|at once|immediately)/i);
    }
    const ui = JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8")) as Record<string, string>;
    for (const key of ["billing.group.attach.confirmCharge", "billing.group.attach.confirmChargeAmount"]) {
      expect(ui[key], key).toMatch(/added to your next invoice/);
      expect(ui[key], key).not.toMatch(/\bnow\b/);
    }
  });

  // CLAIM (the attach dialog, round 4): the TRIAL path prorates nothing, so it
  // gets its own body rather than the charged one.
  it("gives the trial path its own confirm body, because freeSlots cannot see it", () => {
    const source = codeOnly(webSource("server/usecases/billing-groups.ts"), "billing-groups.ts");

    // KNOWN-POSITIVES: the three lines the claim rests on.
    expect(source, "the trial early-return in previewAttachCharge moved").toContain(
      'if (group.status === "trialing") return null;',
    );
    expect(source, "`raising` no longer excludes trialing").toContain("&& !trialing");
    expect(source, "the trialing flag moved").toContain('const trialing = group.status === "trialing";');

    // THE SELECTION. `freeSlots` is 0 during a trial (quantity_paid is frozen),
    // so the two-way version handed a trialing payer the CHARGED body.
    expect(attachConfirmKey(0, true)).toBe("billing.group.attach.confirmTrial");
    expect(attachConfirmKey(3, true), "the trial is the more specific truth").toBe(
      "billing.group.attach.confirmTrial",
    );
    expect(attachConfirmKey(0, false)).toBe("billing.group.attach.confirmCharge");
    expect(attachConfirmKey(1, false)).toBe("billing.group.attach.confirmFree");
    // …and the default must not silently reintroduce the bug for a caller that
    // forgets the argument — it is the CHARGED path that is wrong on a trial,
    // so the panel passing `trialing` explicitly is asserted too.
    expect(
      codeOnly(webSource("components/billing-group-panel.tsx"), "billing-group-panel.tsx"),
      "the panel stopped passing trialing",
    ).toContain("attachConfirmKey(freeSlots, trialing)");

    const ui = JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8")) as Record<string, string>;
    // The trial body must not promise an invoice line, and the charged one must.
    expect(ui["billing.group.attach.confirmTrial"]).toMatch(/nothing is added to a bill now/i);
    expect(ui["billing.group.attach.confirmTrial"]).not.toMatch(/added to your next invoice/i);
    expect(ui["billing.group.attach.confirmCharge"]).toMatch(/added to your next invoice/i);
    // …and the FREE body carries the renewal bound it was missing (N3): the
    // item quantity still rises, so the renewal invoice bills the seat.
    expect(ui["billing.group.attach.confirmFree"]).toMatch(/from your next renewal onwards/i);
    // groups.md already said the trial thing; the two must agree. Task 14b: the
    // sentence moved with the attach copy to add-an-organisation.md.
    expect(addOrg).toMatch(/rides your trial to the same end date\. Nothing is charged/i);

    // THE THREE BODIES MUST STAY DISCRIMINABLE, and the e2e negatives assert
    // that by string. This is where those strings are kept honest.
    //
    // Twice now a negative here has been written against a phrase that stopped
    // discriminating: `not.toContainText("charged now")` went vacuous when the
    // phrase left the product, and `not.toContainText("added to your next
    // invoice")` would have failed on TRUE copy the moment the free body
    // gained "nothing is added to your next invoice". A substring negative is
    // only as good as its exclusivity, so exclusivity is asserted.
    const bodies = {
      charge: ui["billing.group.attach.confirmCharge"]!,
      free: ui["billing.group.attach.confirmFree"]!,
      trial: ui["billing.group.attach.confirmTrial"]!,
    };
    const DISCRIMINATOR = "your bill goes up by";
    expect(bodies.charge, "the e2e discriminator left the charged body").toContain(DISCRIMINATOR);
    expect(bodies.free, "the e2e negative would now fail on true copy").not.toContain(DISCRIMINATOR);
    expect(bodies.trial, "the e2e negative would now fail on true copy").not.toContain(
      DISCRIMINATOR,
    );
    // `confirmChargeAmount` substitutes for `confirmCharge` whenever a preview
    // returns a figure, so it is the body most payers see and must carry the
    // discriminator too — otherwise the e2e positive passes on one rendering
    // and not the other.
    expect(ui["billing.group.attach.confirmChargeAmount"]).toContain(DISCRIMINATOR);

    // …and all three really are distinct sentences, so no pair can be confused.
    expect(new Set(Object.values(bodies)).size, "two attach bodies are identical").toBe(3);

    // ALL FOUR LOCALES, not just en. The e2e specs run in English, so the
    // discriminator only has to be exclusive there — but a translator merging
    // two of these bodies into one sentence would make the DIALOG ambiguous for
    // that locale's payers, which is the thing the exclusivity is protecting.
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const dict = JSON.parse(
        readFileSync(`src/dictionaries/${locale}/ui.json`, "utf8"),
      ) as Record<string, string>;
      const three = [
        dict["billing.group.attach.confirmCharge"],
        dict["billing.group.attach.confirmFree"],
        dict["billing.group.attach.confirmTrial"],
      ];
      expect(three.every((v) => typeof v === "string" && v.length > 0), `${locale}: a body is missing`).toBe(
        true,
      );
      expect(new Set(three).size, `${locale}: two attach bodies are identical`).toBe(3);
    }
  });

  // CLAIM: "There is no screen for buying a size pack" (was "Size packs have no
  // control in Settings yet either"; reworded when the page was proven against
  // the product, Task 8). True today and the single most rot-prone
  // sentence on the page: the day somebody builds either control, the article
  // starts telling customers to email support for a button that is on screen.
  // Nothing about the copy can detect that, so this watches the CODE.
  it("says there is no screen for buying a size pack only while that is still true", () => {
    // The purchase entry points. A control means a component or page reaching
    // for one of these — the API routes and the usecases themselves are not
    // evidence of a UI, which is exactly the distinction the sentence makes.
    for (const [addOn, route] of [
      ["extra seats", "/api/billing/extra-seats"],
      ["size packs", "/api/billing/size-pack-checkout"],
    ] as const) {
      const callers = allStrippedSources()
        .filter(([file]) => file.startsWith("components/") || file.startsWith("app/"))
        .filter(([file, source]) => !file.includes("__tests__") && source.includes(route))
        // The route handler itself lives under app/ and always mentions its own
        // path; it is the thing being called, not a caller.
        .filter(([file]) => !file.startsWith(`app${route}/`))
        .map(([file]) => file);
      expect(
        callers,
        `${addOn} now has a caller in the UI. For size packs, content/help/billing/add-ons.md still says there is no screen for buying a size pack and that sentence has to go; for extra seats, entitlements v18 R13 hid the add-on from the article altogether, so a purchase control appearing means the hide has been undone and the copy has to come back`,
      ).toEqual([]);
    }
    // KNOWN-POSITIVE on the same read: the routes DO exist, so the walk is
    // looking at a real tree and an empty result means "no UI", not "no files".
    const files = allStrippedSources();
    expect(files.length, "the source walk found nothing").toBeGreaterThan(200);
    expect(
      files.some(([f]) => f === "app/api/billing/extra-seats/route.ts"),
      "the extra-seats route moved — re-point this guard",
    ).toBe(true);
    // ONE, not two: R13 removed the extra-seat section, so only the size pack
    // still makes this claim. A count rather than a floor, so re-adding the
    // hidden add-on's copy reds here and gets read.
    // Task 14a: one sentence now covers both — "no add-on for more team
    // members" is the extra seat, "or for more entrants or divisions in one
    // competition" is the size pack. Exactly one, so a second copy gets read.
    expect(
      addOns.match(
        /There is no add-on for more team members, or for more entrants or divisions in one competition\./g,
      ) ?? [],
    ).toHaveLength(1);
  });

  // CLAIM (Task 14a fix round 1, review I5): an organisation that joins
  // through an extra place is charged TWICE — as a seat on the plan item, like
  // every organisation on the bill, and again as the recurring add-on. The
  // "annual rider costs at least a sixth more" sentence this test used to pin
  // priced only the add-on, and was retired with it; its seed-ratio loop went
  // too, because no sentence now makes that comparison. Code-read only: no
  // Stripe sandbox was reachable to drive it (owner question in the report).
  it("says an extra organisation pays its seat AND the add-on, because the code charges both", () => {
    const groups = webSource("server/usecases/billing-groups.ts");
    // KNOWN-POSITIVE: the plan item's quantity counts EVERY live organisation on
    // the group, extra-place ones included — there is no subtraction of riders.
    expect(groups, "syncGroupQuantity no longer counts every organisation — re-read the double charge").toMatch(
      /select count\(\*\)::text as n from organizations\s+where subscription_id = \$\{subscriptionId\} and deleted_at is null/,
    );
    // …and the add-on is a SEPARATE recurring monthly item.
    expect(orgAddons.length, "no extra-organisation add-on to describe").toBeGreaterThan(0);
    for (const addon of orgAddons) {
      expect(addon.price.interval, `${addon.key} is no longer monthly`).toBe("month");
    }
    expect(addOns, "the double charge is stated").toMatch(/An organisation that joins through an extra place is charged twice:/);
    expect(addOns).toContain("**As an organisation on the bill.**");
    expect(addOns).toContain("**For the extra place.**");
    expect(addOns).toMatch(/charged every month, even when your plan is billed yearly/);
    // …and the add-on-only comparisons cannot come back.
    expect(addOns).not.toMatch(/matches that half rate exactly|a sixth more|charged at exactly that same rate/i);
  });
});

describe.skipIf(!HAS_DB)("the add-ons article quotes the caps the matrix enforces", () => {
  // W2 (entitlements v18): the second plan was `pro_plus`, whose row V393
  // deleted. Enterprise took its place at the top of the ladder — and its cap
  // is NULL, so the two halves of this test are no longer symmetrical. Pro has
  // a number and the article must quote it; enterprise has none and the article
  // must say so in WORDS, because a null cap printed as a number is exactly the
  // failure the L rung taught this suite.
  it("names each plan's own organisation limit", async () => {
    const capFor = async (plan: string): Promise<number | null> => {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${plan} and feature_key = 'orgs.max_owned'`;
      expect(row, `plan_entitlements has no ${plan}/orgs.max_owned row`).toBeDefined();
      return row!.int_value;
    };
    const pro = await capFor("pro");
    expect(pro, "pro must have a finite org cap for this sentence").not.toBeNull();
    // The cap is a token on disk; the reader sees the resolved figure.
    expect(addOns, "the cap is the Pro token").toContain("Pro covers {{plan:orgs.max_owned:pro}}");
    const resolved = resolveHelpTokens(addOns, await loadPricingMatrix());
    expect(resolved, "Pro's live organisation cap").toContain(`Pro covers ${pro}`);

    const enterprise = await capFor("enterprise");
    expect(enterprise, "enterprise's org cap is unlimited").toBeNull();
    expect(addOns, "enterprise's null cap, in words").toMatch(/Enterprise\s+is\s+unlimited/i);
    // …and no number may be attached to it, which is how a null cap comes to be
    // sold as a ceiling.
    expect(addOns, "a figure quoted for an unlimited cap").not.toMatch(/Enterprise\s+covers\s+\d/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HONEST RATE, for the add-ons article.
//
// Asserted EXACTLY, the way the pass guards pin 1/12 and 4/12 and the
// dictionary guards pin 1/40: the lexical layer is a SECONDARY net, and any
// widening of it has to update these numbers deliberately rather than quietly
// improving a claim nobody re-measures.
//
// Two sets. The first is rewordings of the phrases `en.halfClaim` literally
// spells out — the set the pattern was written for. The second was written
// AFTER the rules above were final, is about the OTHER things this article
// claims (cadence, scope, who may buy, what lapsing does), and is what the next
// editor's mistake will actually look like.
// ─────────────────────────────────────────────────────────────────────────────
describe("the add-ons gate catches what the vocabulary cannot", () => {
  const lexicalOnly = (added: string): boolean =>
    localeHalfClaimFaults(addOnsClaim(`${addOns}\n\n${added}\n`), "atMost").length > 0;

  const gated = (added: string): boolean =>
    inventoryFaults("x", `${addOns}\n\n${added}\n`, APPROVED_ADD_ONS_INVENTORY).length > 0;

  /** Rewordings of the exact phrases the half-rate pattern names. */
  const PATTERNS_OWN_SET = [
    "Each organisation after the first costs half the base rate.",
    "Every extra organisation is half your plan's rate.",
    "Extra slots cost half the base rate each.",
    "Each one after the first is half the plan's rate.",
    "Extra organisations are half price.",
    "An extra organisation costs 50% of your plan's rate.",
    "Each extra organisation is priced at one half of the base rate.",
    "You pay half as much for every organisation after the first.",
    "The second organisation and every one after it costs 50% less.",
    "Extra organisations come in at half what the first one costs.",
    "Each organisation past the first is billed at half rate.",
    "A second organisation costs half of your plan.",
  ];

  /** Written after the rules were final, about this article's OTHER claims. */
  const FRESH_SET = [
    "An extra organisation is billed on the same cycle as your plan, so an annual bill pays for it once a year.",
    "Cancel an extra seat and any members over the limit are removed from the organisation.",
    "A size pack lifts your organisation's member limit as well.",
    "Any member of an organisation can buy an extra seat for it.",
    "Removing an extra organisation refunds the unused part of the month.",
    "Credit packs expire at the end of the billing period they were bought in.",
    "Extra organisations cost the same as your plan's own rate.",
    "You can drop your extra organisations to zero at any time, whatever the group is using.",
    "A size pack is charged every month for as long as the competition runs.",
    "Community organisations can buy extra organisations from Settings → Add-ons.",
    "Each extra organisation costs half your plan's rate.",
    "Buying a second size pack for the same competition replaces the first.",
  ];

  // RE-MEASURED after the vocabulary was widened in fix round 2, not adjusted
  // to keep a number green. `en.halfClaim` gained "half price" and a bare "half
  // the (plan) rate" — the two shapes the shipped help articles used — so the
  // pattern's own set moved 4 -> 5 ("Extra organisations are half price" is now
  // caught) while the fresh set did not move at all. That is the finding, and
  // it is the same one this wave keeps making: widening a vocabulary improves
  // it only against the examples the widener was looking at. The gate is
  // unmoved at 24/24 because it does not read the words.
  it("scores 5/12 and 1/12 lexically — the gate is doing the work", () => {
    expect(PATTERNS_OWN_SET.filter(lexicalOnly).length, "the pattern's own set").toBe(5);
    expect(FRESH_SET.filter(lexicalOnly).length, "a set written after the rules were final").toBe(1);
  });

  // …and every one of them fails once the gate is included, because the gate is
  // not reading them. This is the assertion that makes the two numbers above a
  // measurement rather than a hole.
  /**
   * ROUND 3, measured after these rules were final — and the number that
   * settles the argument.
   *
   * Twelve claims about what round 3 actually fixed: when the attach charge
   * lands, how far the seat freeze reaches, and rate shapes the WIDENED
   * vocabulary still has not seen. The vocabulary scores ZERO. It scored 5/12
   * on the set that was written around its own phrases, 1/12 on round 2's
   * fresh set, and 0/12 here; an independent reviewer measured 0/24 on a set
   * of their own. Four measurements, one conclusion.
   *
   * The gate scores 12/12 against all three gated articles, because it is not
   * reading them. This is the whole reason `groups.md` and
   * `create-your-organisation.md` are now gated rather than merely corrected.
   */
  const ROUND_3_FRESH = [
    "Adding an organisation takes the money off your card the moment you confirm.",
    "The proration for a new organisation is billed on the spot.",
    "You will see the charge on your statement within minutes of adding.",
    "A failed card at the moment you add will bounce the organisation back out of the group.",
    "Every extra organisation is billed at fifty per cent of what you already pay.",
    "The second organisation onwards costs one half of the headline price.",
    "Cancel a seat and everyone over the limit loses write access across the whole app.",
    "An over-limit member cannot use the API or the app until you buy the seat back.",
    "Owners are frozen along with everyone else once you are over the seat limit.",
    "Adding an organisation mid-year on an annual plan bills you a full extra year today.",
    "Your extra organisations renew on their own separate date.",
    "A group that goes over its organisation limit has its newest organisations switched off.",
  ];

  /**
   * ROUND 4, measured after round 4's rules were final. Twelve claims about
   * what round 4 fixed — the trial path's timing, the freed slot's renewal
   * bound, how far the seat freeze reaches — plus rate shapes the widened
   * vocabulary still has not seen.
   *
   * Lexical 0/12 again; gate 12/12 against each of the three gated articles,
   * 36/36 in total. That is the FIFTH independent set to land at ~0 lexical /
   * 100% gate (5/12 on the pattern's own phrases, 1/12, 0/12, a reviewer's
   * 0/24, and this). The conclusion is settled: stop widening vocabulary.
   */
  const ROUND_4_FRESH = [
    "Adding an organisation during your trial still prorates onto the next invoice.",
    "A trial group is billed for the extra organisation the moment the trial starts.",
    "Moving into a slot you already paid for keeps it free at every future renewal.",
    "A freed slot never costs you anything again.",
    "An over-limit member is blocked from the app until you buy the seat back.",
    "API keys stop working once you are over your member limit.",
    "Every extra organisation is billed at fifty per cent of what you already pay.",
    "The second organisation onwards costs one half of the headline price.",
    "Cancelling an extra organisation switches off your newest organisation.",
    "Your extra organisations renew on their own separate date.",
    "A size pack raises the entrant limit for every competition you run.",
    "Credit packs run out at the end of the year you bought them.",
  ];

  it("scores 0/12 lexically on round 4's set, and 36/36 through the gate", () => {
    const caughtLexically = ROUND_4_FRESH.filter(
      (claim) =>
        LOCALE_CLAIMS.en.halfClaim.test(claim) &&
        localeHalfClaimFaults([{ locale: "en", key: "x", value: claim }], "atMost").length > 0,
    );
    expect(caughtLexically, "the vocabulary now catches some of these — re-measure").toEqual([]);

    const escaped: string[] = [];
    for (const claim of ROUND_4_FRESH) {
      for (const [slug, approved] of Object.entries(GATED_ARTICLES)) {
        const mutated = `${helpArticleBySlug(slug)}\n\n${claim}\n`;
        if (inventoryFaults("x", mutated, approved).length === 0) escaped.push(`${slug} <- ${claim}`);
      }
    }
    expect(escaped).toEqual([]);
    expect(
      ROUND_4_FRESH.length * Object.keys(GATED_ARTICLES).length,
      "36 = 12 claims x 3 gated articles",
    ).toBe(36);
  });

  it("scores 0/12 lexically on round 3's set, and 12/12 through the gate", () => {
    const caughtLexically = ROUND_3_FRESH.filter(
      (claim) =>
        LOCALE_CLAIMS.en.halfClaim.test(claim) &&
        localeHalfClaimFaults([{ locale: "en", key: "x", value: claim }], "atMost").length > 0,
    );
    expect(caughtLexically, "the vocabulary now catches some of these — re-measure").toEqual([]);

    // …and every one of them reds against every gated article.
    const escaped: string[] = [];
    for (const claim of ROUND_3_FRESH) {
      for (const [slug, approved] of Object.entries(GATED_ARTICLES)) {
        const mutated = `${helpArticleBySlug(slug)}\n\n${claim}\n`;
        if (inventoryFaults("x", mutated, approved).length === 0) escaped.push(`${slug} <- ${claim}`);
      }
    }
    expect(escaped).toEqual([]);
  });

  it("catches all 24 once the inventory is included", () => {
    expect([...PATTERNS_OWN_SET, ...FRESH_SET].filter((s) => !gated(s))).toEqual([]);
  });

  // Delivered through the two surfaces that were measured at 0/24 and 0/36
  // before `claimSurfaces` existed. They are pinned here from the first commit.
  it("catches a falsehood delivered through frontmatter or a heading", () => {
    for (const description of [
      "Four ways to buy extra capacity, all of them billed once and none of them expiring.",
      "Extra organisations are half price on every plan.",
    ]) {
      const mutated = addOns.replace(/^description: .*$/m, `description: ${description}`);
      expect(mutated, "the frontmatter anchor moved").not.toBe(addOns);
      expect(inventoryFaults("x", mutated, APPROVED_ADD_ONS_INVENTORY), description).not.toEqual([]);
    }
    for (const heading of [
      "Extra seats — buy them yourself in Settings",
      "Size packs — refundable any time",
    ]) {
      const mutated = addOns.replace("## Credit packs", `## ${heading}\n\n## Credit packs`);
      expect(mutated, "the heading anchor moved").not.toBe(addOns);
      expect(inventoryFaults("x", mutated, APPROVED_ADD_ONS_INVENTORY), heading).not.toEqual([]);
    }
  });

  // The gate is POSITIONAL, and an edit INSIDE a paragraph is the mutation a
  // set-membership check misses. Both are asserted rather than assumed.
  it("catches an edit inside a paragraph, a deletion, and a reorder", () => {
    const edited = addOns.replace("does not freeze anything.", "removes the organisations over the limit.");
    expect(edited, "the anchor moved").not.toBe(addOns);
    expect(inventoryFaults("x", edited, APPROVED_ADD_ONS_INVENTORY)).not.toEqual([]);

    const deleted = addOns.replace(/\n## Who sees what[\s\S]*?(?=\n## If you remove)/, "\n");
    expect(deleted, "the section anchor moved").not.toBe(addOns);
    expect(inventoryFaults("x", deleted, APPROVED_ADD_ONS_INVENTORY)).not.toEqual([]);

    // The article has no table any more; two list items are swapped instead.
    const rows = /(- \*\*The payer\*\*[^\n]*)\n(- \*\*Another owner\*\*[^\n]*)\n/.exec(addOns);
    expect(rows, "the list items moved").not.toBeNull();
    const swapped = addOns.replace(rows![0], `${rows![2]}\n${rows![1]}\n`);
    expect(swapped, "the swap was a no-op").not.toBe(addOns);
    expect(inventoryFaults("x", swapped, APPROVED_ADD_ONS_INVENTORY)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The OpenAPI summaries are PUBLISHED SURFACE, and one of them was quoting a
// retired price. `/divisions/{id}/checkpoints` (POST) advertised the save-point
// quota as "1 free / 5 Pro / unlimited Pro Plus". Community has been 2 since
// V319 — so the spec every integrator reads, and every generated client's
// docstring, carried a false claim about what a plan includes.
//
// Found during #382 triage, in no issue. Exactly the class this file exists for:
// a number in prose that no longer matches the number the resolver enforces.
//
// Reading the SEEDED value rather than hardcoding 2 is the point — the next
// entitlement change fails this test instead of quietly re-staling the copy.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("the OpenAPI checkpoint summary quotes the seeded quota (#382)", () => {
  it("the checkpoint quota summary matches the seeded entitlement (#382)", async () => {
    const { ROUTES } = await import("@/server/api-v1/openapi");
    const [row] = await sql<{ int_value: number }[]>`
      select int_value from plan_entitlements
       where plan_key = 'community' and feature_key = 'schedule.checkpoints.max'`;
    expect(row, "no seeded community checkpoint quota to compare against").toBeDefined();

    const route = ROUTES.find(
      (r) => r.path === "/divisions/{id}/checkpoints" && r.method === "post",
    );
    expect(route, "the checkpoints POST route").toBeDefined();
    const summary = route!.summary ?? "";

    expect(summary).toContain(String(row!.int_value));
    expect(summary, "the retired '1 free' claim").not.toMatch(/\b1\s+free\b/);
  });

  it("also states what now happens AT the cap, since it no longer refuses", async () => {
    // #382 turned the refusal into a rolling window. A summary that names the
    // number but still implies a hard stop is the same class of stale claim.
    const { ROUTES } = await import("@/server/api-v1/openapi");
    const summary =
      ROUTES.find((r) => r.path === "/divisions/{id}/checkpoints" && r.method === "post")
        ?.summary ?? "";
    expect(summary.toLowerCase()).toContain("replaced");
  });
});

/**
 * ── NO HELP ARTICLE SELLS SCORING DETAIL (entitlements v18 / W1) ─────────────
 *
 * V390 deleted the three fidelity feature keys from `plan_entitlements` and the
 * same wave deleted their gate from `scoreEvent` and the batch importer. Every
 * band of recording detail is free on every plan, and the pad's Recording chip
 * is a picker with no lock, no plan name and nothing to unlock.
 *
 * TREE-WIDE for the reason `unmeteredFaultsAcrossTree` above is: the brief for
 * this task named six articles and MISSED four — `scoring/fidelity.md`,
 * `sports/badminton.md`, `sports/tabletennis.md` and `sports/volleyball.md` (then under `scoring/`)
 * — each of which told a reader in as many words that the finest level "needs a
 * plan that includes it". A guard scoped to a filename list would have shipped
 * all four. This one reds wherever the sentence lands, including in an article
 * nobody has written yet.
 *
 * SENTENCE-scoped, not article-scoped: `billing/plans.md` names every plan we
 * sell and `sports/cricket.md` explains ball-by-ball scoring at length. Both
 * are true; only the two claims INSIDE ONE SENTENCE assert a price.
 */
const scoringFreeFaultsAcrossTree = (
  extra: Array<{ slug: string; text: string }> = [],
): { faults: string[]; scanned: number } => {
  const pairs: Array<readonly [string, string]> = [];
  const push = (slug: string, markdown: string): void => {
    for (const block of claimTexts(markdown)) {
      for (const sentence of sentences(block)) pairs.push([`${slug}.md`, sentence] as const);
    }
  };
  for (const article of allHelpArticles().values()) push(article.slug, helpArticleBySlug(article.slug));
  for (const e of extra) push(e.slug, e.text);
  // English, and English only, by standing rule: `content/help/**` is one tree
  // with no translations. The band labels come from the dictionary rather than
  // this file, so a rename moves the guard with the label — the articles quote
  // "Key moments" / "Full timeline" / "Every detail" verbatim (final review
  // I-1: the guard's own vocabulary knew "match timeline" and none of these).
  const ui = JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8")) as Record<string, string>;
  const bandLabels = [0, 1, 2, 3].map((band) => ui[`pad.recording.band.${band}`] ?? "");
  return {
    faults: scoringFreeClaimFaults(pairs, { locale: "en", bandLabels }),
    scanned: pairs.length,
  };
};

describe("no help article anywhere prices scoring detail (W1: it is free on every plan)", () => {
  it("the tree, as it stands today, makes the claim nowhere", () => {
    const { faults, scanned } = scoringFreeFaultsAcrossTree();
    expect(scanned, "the scan resolved almost no sentences").toBeGreaterThan(1500);
    // The message argument carries the ARTICLE NAME into a CI JSON report: the
    // reporter's own `failureMessages` says only "expected [ Array(1) ] to
    // deeply equal []", and the filename lives in the terminal diff alone.
    expect(faults, faults.join(" | ")).toEqual([]);
  });

  // ANTI-VACUITY, in the exact shape the brief missed four times: an article
  // this list never names, saying it in the words those four used.
  it("would catch the claim in an article this list never named", () => {
    const { faults } = scoringFreeFaultsAcrossTree([
      {
        slug: "scoring/some-sport-nobody-named",
        text: "Rally-by-rally is the finest level and needs a plan that includes it.",
      },
    ]);
    expect(faults.join(" ")).toContain("presents scoring detail as paid");
  });

  // …and it does not fire on the two things the tree legitimately does: explain
  // the capability, and name the plans.
  it("leaves a true sentence alone", () => {
    const { faults } = scoringFreeFaultsAcrossTree([
      {
        slug: "scoring/probe-true",
        text: [
          "Cricket divisions score ball by ball: one tap per delivery.",
          "Pro covers 5 organisations and Pro Plus covers 10.",
          "Every detail level is available on every plan.",
        ].join("\n\n"),
      },
    ]);
    expect(faults.filter((f) => f.startsWith("scoring/probe-true"))).toEqual([]);
  });
});

// =============================================================================
// PER-PLAN CAPACITY CLAIMS - the scale axes nothing was scanning
// =============================================================================
//
// `directory/clubs-and-teams.md` shipped a twelve-cell per-plan limits table in
// which NINE cells disagreed with `plan_entitlements`, and the worst of them --
// "Pro | Squad size | Unlimited" against a hard `teams.squad_max` of 40 --
// promised an organiser no squad limit and refused them at the 41st player.
//
// The fee ladder had a guard. The SCALE axes had none: the tree was scanned for
// entrants, divisions, credits and fee rates, and never once for clubs, teams,
// squad size or seats. So the sweep below is by AXIS rather than by article, in
// both shapes a scale claim takes, over every article `allHelpArticles()`
// returns -- the same "shape, not filename" rule the fee ladder learned the hard
// way one wave earlier.
describe.skipIf(!HAS_DB)("no help article misquotes a per-plan capacity cap", () => {
  /**
   * The matrix, read ONCE and kept three-valued.
   *
   * `undefined` (no row) and `null` (a row with a null `int_value`) are OPPOSITE
   * answers -- `getLimit` reads `row ? row.int_value : 0`, so a missing row
   * refuses everything while a null one is unlimited -- and collapsing them is
   * exactly how the Event Pass came to publish a 2/2/20 row for caps it does not
   * set. Loaded as a Map of every (feature, plan) pair that EXISTS, so absence
   * is absence rather than a default.
   */
  const loadMatrix = async (): Promise<PlanCapLookup> => {
    const features = [...new Set(PLAN_CAP_AXES.map((a) => a.feature))];
    const rows = await sql<{ feature_key: string; plan_key: string; int_value: number | null }[]>`
      select feature_key, plan_key, int_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "no capacity rows at all - this sweep would pass vacuously").toBeGreaterThan(
      0,
    );
    const byPair = new Map(rows.map((r) => [`${r.feature_key} ${r.plan_key}`, r.int_value]));
    return (feature, planKey) => {
      const pair = `${feature} ${planKey}`;
      return byPair.has(pair) ? byPair.get(pair)! : undefined;
    };
  };

  const sweep = async (extra: { slug: string; text: string }[] = []) => {
    const live = await loadMatrix();
    // RESOLVED, as a reader sees it (Task 14a). Billing pages quote caps through
    // `{{plan:…}}` tokens; read raw, a token is no figure at all and the prose
    // half went inert. Resolved, a token pasted under the wrong plan reds here.
    const pricing = await loadPricingMatrix();
    const articles = [
      ...[...allHelpArticles().values()].map((a) => ({
        slug: a.slug,
        text: resolveHelpTokens(helpArticleBySlug(a.slug), pricing),
      })),
      ...extra,
    ];
    const faults: string[] = [];
    let cells = 0;
    let claims = 0;
    for (const { slug, text } of articles) {
      const tables = planCapTables(text, PLAN_KEY_BY_LABEL);
      const prose = planCapProseClaims(text, PLAN_KEY_BY_LABEL);
      cells += tables.reduce((n, t) => n + t.cells.length, 0);
      claims += prose.length;
      faults.push(...planCapTableFaults(`${slug}.md`, tables, live));
      faults.push(...planCapProseFaults(`${slug}.md`, prose, live));
    }
    return { faults, cells, claims };
  };

  it("the tree, as it stands today, quotes the matrix everywhere", async () => {
    const { faults } = await sweep();
    expect(faults).toEqual([]);
  });

  // -- ANTI-VACUITY ---------------------------------------------------------
  // Every assertion above is a loop, and a sweep that matched nothing reports
  // exactly what a clean tree reports. Both halves must have actually read
  // something, and the floors are floors so a new article is a pass.
  it("actually read the cells and the claims it says are clean", async () => {
    const { cells, claims } = await sweep();
    expect(
      cells,
      "no capacity TABLE cells were compared - the table half is inert",
    ).toBeGreaterThanOrEqual(12);
    expect(
      claims,
      "no capacity PROSE claims were compared - the prose half is inert",
    ).toBeGreaterThanOrEqual(4);
  });

  // ...and the vocabulary itself must be live. A label map built from a renamed
  // or emptied `ALL_PLAN_KEYS` matches no row label at all, and every table in
  // the tree then reports "not a live plan name" -- or, worse, is skipped.
  it("reads row labels with the vocabulary the product renders", () => {
    expect(PLAN_KEY_BY_LABEL["Community"]).toBe("community");
    expect(PLAN_KEY_BY_LABEL["Pro"]).toBe("pro");
    expect(PLAN_KEY_BY_LABEL["Enterprise"]).toBe("enterprise");
    expect(PLAN_KEY_BY_LABEL["Event Pass"]).toBe("event_pass");
    expect(Object.keys(PLAN_KEY_BY_LABEL).length, "the label vocabulary collapsed").toBe(
      ALL_PLAN_KEYS.length,
    );
  });

  // -- PROVING THE GUARD, by writing the falsehood a different way -----------
  // Not by restoring the nine cells this task corrected: that only shows the
  // rule notices the one table it was written against, which is how two guards
  // shipped green in wave 6. Each probe below is an article nothing names,
  // carrying the falsehood in a shape the corrected copy never had.

  it("catches a finite cap sold as Unlimited, in a column", async () => {
    const { faults } = await sweep([
      {
        slug: "probe/uncapped-cell",
        text: "| Plan | Squad size |\n| --- | --- |\n| Pro | Unlimited |\n",
      },
    ]);
    expect(faults.join(" ")).toContain("probe/uncapped-cell.md: Pro/Squad size");
    expect(faults.join(" ")).toContain("teams.squad_max");
  });

  it("catches a wrong FIGURE in a column, not just an unlimited word", async () => {
    const { faults } = await sweep([
      { slug: "probe/wrong-figure", text: "| Plan | Clubs |\n| --- | --- |\n| Community | 2 |\n" },
    ]);
    expect(faults.join(" ")).toContain("probe/wrong-figure.md: Community/Clubs");
  });

  it("catches an unlimited cap printed as a ceiling", async () => {
    const { faults } = await sweep([
      {
        slug: "probe/false-ceiling",
        text: "| Plan | Teams |\n| --- | --- |\n| Enterprise | 500 |\n",
      },
    ]);
    expect(faults.join(" ")).toContain("probe/false-ceiling.md: Enterprise/Teams");
    expect(faults.join(" ")).toContain("unlimited on enterprise");
  });

  it("catches a cap invented for a plan that sets none", async () => {
    const { faults } = await sweep([
      {
        slug: "probe/invented-grant",
        text: "| Plan | Clubs | Teams |\n| --- | --- | --- |\n| Event Pass | 2 | Unlimited |\n",
      },
    ]);
    expect(faults.join(" ")).toContain("Event Pass/Clubs");
    expect(faults.join(" ")).toContain("Event Pass/Teams");
    expect(faults.join(" ")).toContain("does not set this cap at all");
  });

  it("catches an unlimited word whose NOUN is a clause away - finding 2's shape", async () => {
    const { faults } = await sweep([
      {
        slug: "probe/elided-noun",
        text: "## Common questions\n\nCommunity orgs get 3 members total; Pro is unlimited.\n",
      },
    ]);
    expect(faults.join(" ")).toContain("calls pro unlimited on members.max");
  });

  it("catches the same elision written with a dash instead of a semicolon", async () => {
    const { faults } = await sweep([
      {
        slug: "probe/elided-dash",
        text: "## Common questions\n\nCommunity holds 3 seats — Pro has no limit at all.\n",
      },
    ]);
    expect(faults.join(" ")).toContain("calls pro unlimited on members.max");
  });

  it("catches a wrong figure in prose, attributed by its section heading", async () => {
    const { faults } = await sweep([
      {
        slug: "probe/heading-scoped",
        text: "## Pro - the club plan\n\nYou can create 40 teams.\n",
      },
    ]);
    expect(faults.join(" ")).toContain("quotes 40 for pro/teams.max");
  });

  // -- ...AND IT LEAVES TRUE COPY ALONE --------------------------------------
  // The half a fault-counting sweep cannot show. Each of these is a real
  // sentence shape from this tree that an earlier, noisier version of the rule
  // reported: they are the reason the attribution is heading-first, the reason
  // an unlimited word reaches only across list glue, and the reason "team
  // members" is not a teams claim.
  it("leaves true copy alone - heading beats a plan named inside the sentence", async () => {
    const { faults } = await sweep([
      {
        slug: "probe/true-copy",
        text: [
          "## Enterprise - talk to us",
          "Everything in Pro, plus unlimited seats, teams, clubs and organisations.",
          "## Pro - the club plan",
          "Unlimited active competitions, 20 divisions in each, 10 team members.",
        ].join("\n\n"),
      },
    ]);
    expect(faults.filter((f) => f.startsWith("probe/true-copy"))).toEqual([]);
  });
});

/**
 * The billing help sold a format community already has.
 *
 * `content/help/billing/plans.md` listed the Event Pass as carrying "advanced
 * formats including double elimination", and `event-pass.md` repeated it as a
 * bullet. `formats.double_elim` is TRUE on community and has been since V393 —
 * so both sentences named a free capability as a thing the $11.99 buys.
 *
 * This is the same defect W3 fixed in `pricing.pass.f3`, in a tree that guard
 * cannot see: `localePaidOverclaimFaults` scans the four DICTIONARIES, and
 * `content/help/**` is a separate English-only tree with no locale files at
 * all. One fix caught by a guard, an identical sentence three directories away
 * that no guard was looking at.
 *
 * Scoped to the BILLING articles on purpose. `divisions/bracket-view.md`
 * describes double elimination at length and must go on doing so — the claim
 * being forbidden is "this is what you are buying", not the format's existence.
 */
describe.skipIf(!HAS_DB)("billing help does not sell a format community already grants", () => {
  it("names no paid benefit that plan_entitlements gives away", async () => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements
      where feature_key = 'formats.double_elim' order by plan_key`;
    // Canary: a renamed key returns nothing and every assertion below passes
    // by examining an empty set.
    expect(rows.length, "no formats.double_elim rows — the key moved").toBeGreaterThan(3);
    const community = rows.find((r) => r.plan_key === "community")?.bool_value;

    const articles = [
      { file: "billing/plans.md", text: plans },
      { file: "billing/event-pass.md", text: eventPass },
    ];
    // Canary for the OTHER half: an article helper returning "" would make the
    // scan below find nothing and report clean.
    for (const a of articles) {
      expect(a.text.length, `${a.file} read as empty`).toBeGreaterThan(500);
    }

    const claims = articles.filter((a) => /double elimination/i.test(a.text)).map((a) => a.file);

    if (community === true) {
      expect(
        claims,
        "these billing articles sell double elimination, which community already grants — " +
          "say what the pass actually adds (formats.advanced: americano, ladders) instead",
      ).toEqual([]);
    } else {
      // The other branch, stated rather than left implicit: if the row is ever
      // taken off community the claim becomes TRUE and this guard must stop
      // forbidding it. Nothing is owed in that direction — the articles are
      // free to mention it or not — so this asserts the premise, not the copy.
      expect(community, "formats.double_elim has no community row at all").not.toBeUndefined();
    }
  });

  it("says what the pass DOES add, so the fix is not just a deletion", async () => {
    // The positive pair. Removing the false clause and leaving nothing behind
    // would satisfy the assertion above while making the article worse: a
    // buyer reading the pass's benefits would see one fewer, with no idea a
    // real format upgrade is included. `formats.advanced` IS false on
    // community, which is what makes this claim honest.
    const [row] = await sql<{ bool_value: boolean | null }[]>`
      select bool_value from plan_entitlements
      where feature_key = 'formats.advanced' and plan_key = 'community' limit 1`;
    expect(row, "plan_entitlements has no community/formats.advanced row").toBeDefined();
    expect(row!.bool_value, "formats.advanced is free — this claim is no longer honest").toBe(false);
    for (const [file, text] of [
      ["billing/plans.md", plans],
      ["billing/event-pass.md", eventPass],
    ] as const) {
      expect(text, `${file} no longer names the formats the pass adds`).toMatch(
        /americano|ladders/i,
      );
    }
  });
});
