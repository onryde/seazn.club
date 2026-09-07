/**
 * Truth-in-copy guards (v17 gap wave 7, #298 / #299).
 *
 * D22's discipline — "every number a plan card quotes must be the number the
 * resolver enforces" (lib/__tests__/pricing-cards.test.ts) — applied to the
 * surfaces D22 never reached, starting with the product descriptions Stripe
 * renders to a buyer inside Checkout. Nothing generates that prose; it is
 * hand-written, so something has to compare it to `plan_entitlements`.
 *
 * A PLAIN MODULE, not a test file, because Tasks 3, 4 and 7 of this wave import
 * these lists to scan help articles and four-locale dictionaries. Exporting them
 * from a `*.test.ts` made every importer re-run this file's own suite (measured:
 * a 4-test probe reported 21).
 *
 * ── HOW THESE GUARDS ARE BUILT, AND WHY ─────────────────────────────────────
 * Wave 6 shipped two copy guards that passed while the copy said the opposite
 * of the truth. Both failures are designed against here:
 *
 *  1. A DENYLIST OF PHRASINGS lets the same falsehood through reworded — a
 *     guard banning "half price" and "same rate" was beaten by "at the same
 *     cost as the ones already on your bill". So these assert on the CLAIM'S
 *     VOCABULARY, not on sentences.
 *  2. A PRESENCE RULE is beaten identically from the other side — "must mention
 *     add-ons" was satisfied by "the add-ons you've bought STOP COUNTING", the
 *     exact inverse claim. So every presence rule below is PAIRED with a
 *     negative on the inverse claim, and every absence rule with an existence
 *     assertion (absence proves "not false", never "still stated").
 *
 * And the reason both shipped green: they were proved by REVERTING the copy,
 * which only shows the guard notices the one string it was written against.
 * Every guard here is therefore a PURE FUNCTION returning readable fault
 * labels, so "prove it by rewording" is a committed test rather than a manual
 * check that happened once. Same shape as config/__tests__/stripe-plans.test.ts's
 * holed clones.
 *
 * Callers assert `toEqual([])` on the fault array, never a bare `not.toMatch`:
 * an equality names every fault at once instead of stopping at the first, and
 * cannot be satisfied by a guard that silently scanned nothing.
 */
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { ALL_PLAN_KEYS, SELLABLE_PASS_KEYS } from "@/lib/currency";
import { planLabel } from "@/lib/plan-label";

// ── Surfaces ─────────────────────────────────────────────────────────────────

/** One customer-facing product in the Stripe seed.
 *
 *  BOTH customer-facing fields, deliberately. `name` is not metadata: Checkout
 *  renders the PRODUCT'S NAME as the line-item label (`lib/credit-packs.ts`
 *  and `lib/size-packs.ts` both pass `line_items: [{ price }]`, so Stripe reads
 *  the label off the product), and `scripts/stripe-sync.ts` syncs name and
 *  description together on every run — including against the shared test-mode
 *  account on every PR (ci.yml). So the name is what the buyer reads on the
 *  payment page, and until fix round 6 NOTHING read it: a probe carrying
 *  "Event Pass — yours forever, never expires", "Event Pass L — 10 AI schedule
 *  runs per division", "AI Credits — 4000" (seed: 40) and "Size Pack — +320
 *  entrants" (delta_each: 32) shipped 216 passed / 0 failed. Both flagship
 *  falsehoods of this wave, plus a 100x credit claim, all green. */
export interface DescribedEntry {
  section: string;
  key: string;
  /** `product.name` — the Checkout line-item label. */
  name: string;
  description: string;
}

/** Keys of the seed that are developer notes or scalars, never a product list. */
export const NON_SECTION_KEY = /^\$comment|^currency$/;

/**
 * Every `product.name` AND `product.description` in the seed, found by WALKING
 * it.
 *
 * Deliberately NOT a hand-written list of sections. The sibling seed guard kept
 * one and v17 #293 found `org_addons` had escaped it for a whole wave — a list
 * is itself the thing that must be remembered. `describedSections` below lets a
 * test assert the walk reaches every non-comment key, so a new section is
 * covered the day it is written.
 *
 * FIX ROUND 6: the same failure one field over. The walk was general about
 * SECTIONS and hardcoded about FIELDS — it read `description` and nothing read
 * `name` at all, so every rule built on this output was blind to the string
 * Checkout actually shows the buyer. A missing `name` is a FAULT, not a skip:
 * stripe-sync sends it on every run, so an entry without one is a product with
 * no label rather than a product this walk may ignore.
 */
export function describedEntries(seed: Record<string, unknown>): DescribedEntry[] {
  const out: DescribedEntry[] = [];
  for (const [section, value] of Object.entries(seed)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const record = entry as { key?: unknown; product?: { name?: unknown; description?: unknown } };
      const description = record.product?.description;
      if (typeof description !== "string") continue;
      const name = record.product?.name;
      out.push({
        section,
        key: typeof record.key === "string" ? record.key : "(unkeyed)",
        name: typeof name === "string" ? name : "",
        description,
      });
    }
  }
  return out;
}

/** The seed keys that ought to carry descriptions — everything but the
 *  `$comment*` notes and the top-level `currency` scalar. */
export function describedSections(seed: Record<string, unknown>): string[] {
  return Object.keys(seed).filter((k) => !NON_SECTION_KEY.test(k));
}

// ── Numeric pins ─────────────────────────────────────────────────────────────

/**
 * A number matched as a WHOLE TOKEN — the only correct shape for pinning copy
 * against a matrix figure.
 *
 * `expect(copy).toContain(String(n))` is a SUBSTRING test, so it is satisfied by
 * any figure that merely contains the digits: `"10"` by `"100"`, `"5"` by
 * `"50"`, `"128"` by `"1280"`, `"20"` by `"200"`. Every one of those is a live
 * 10x overclaim of a paid entitlement that ships green.
 *
 * This lives HERE, in the shared module, and not as a local const in one suite,
 * because that is exactly how the defect spread: the whole-token form was
 * written for `f3` in one round and left on its neighbours twelve lines below,
 * then left again on five more sites in two other suites. One helper, imported
 * by every caller, is what makes "fixed" a property of the repo rather than of
 * a line.
 *
 * Lookbehind/lookahead rather than `\b`: a digit's neighbours are the only
 * thing that can widen it, and `\b` would reject a legitimate "$29" or "+25".
 */
export function wholeNumber(n: number): RegExp {
  return new RegExp(`(?<!\\d)${n}(?!\\d)`);
}


// ── Claim vocabularies ───────────────────────────────────────────────────────

/**
 * v17 Phase 2 (V322, db/migration/deltas/V322__retire_ai_run_cap.sql) deleted
 * `scheduling.ai.runs_per_division.max` from every plan — AI runs are metered
 * by the credit wallet on every tier now, not a graded per-division count.
 * (Verified: the key has zero rows in plan_entitlements.)
 *
 * These describe the CLAIM — "a quantified allowance of AI runs, allotted per
 * division/competition/event" — not the sentence that used to make it, so a
 * reworded reintroduction is caught too. Fix round 1 widened this after three
 * measured misses: "an allowance of AI schedule runs for each division",
 * "AI scheduling: three runs a division", and "a monthly quota of AI schedule
 * generations per division" all previously returned no faults.
 *
 * The unit noun is deliberately broad (runs/generations/invocations/jobs) and
 * the quantifier deliberately optional, because the falsehood is the PER-UNIT
 * ALLOWANCE, not the digit.
 */
export const RETIRED_AI_RUN_CAP_PATTERNS = [
  // The historical phrasing, kept for traceability.
  /\d+\s+AI\s+schedule\s+runs/i,
  // "<n> runs per division", "runs a competition", "runs for each event".
  // Fix round 2: `every` was missing from the distributive list, so
  // "5 schedule runs for every division" returned no fault (measured).
  // Fix round 2: `attempts` was not a unit noun, so "AI scheduling is limited to
  // 5 attempts per division" scanned clean.
  /\b(runs?|generations?|invocations?|jobs?|attempts?|tries|uses?|calls?)\b[^.;]{0,20}\b(per|for\s+each|for\s+every|each|every|a)\s+(division|competition|event)\b/i,
  // Fix round 2: the allowance stated with NO unit noun at all — "Each division
  // may be scheduled by AI up to 20 times." A count of "times" is the unit.
  /\b(per|for\s+each|each|every)\s+(division|competition|event)\b[^.;]{0,60}\b(?:up\s+to\s+)?\d+\s+times?\b/i,
  // An AI/scheduling subject, then a run noun, then the per-unit allotment —
  // catches the three measured misses, which put words between the two.
  /\b(AI|scheduling)\b[^.;]{0,40}\b(runs?|generations?|invocations?|jobs?)\b[^.;]{0,20}\b(per|for\s+each|for\s+every|each|every|a)\s+(division|competition|event)\b/i,
  /\bper[-\s](division|competition|event)\s+(AI\s+)?(schedule\s+)?(runs?|generations?)\b/i,
  // Fix round 2 (task 3): the same claim with the UNIT NOUN FIRST — "each
  // division gets its own AI schedule generations" put the per-unit phrase
  // ahead of the run noun, so none of the four patterns above could reach it.
  // Deliberately excludes a bare "a" (as in "a competition"), which reads as an
  // article rather than a distributive here and would match ordinary prose.
  // The window is 60, not the 20 the other direction uses: prose puts the
  // allowance between the two ("every competition comes with its own allowance
  // of scheduling runs" — 43 characters, measured green at 40).
  /\b(per|for\s+each|each|every)\s+(division|competition|event)\b[^.;]{0,60}\b(runs?|generations?|invocations?|jobs?)\b/i,
  // A counted allowance, digits or words.
  /\b\d+\s+(AI|scheduling)\s+(schedule\s+)?(runs?|generations?)\b/i,
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\s+(AI\s+)?(schedule\s+)?runs?\b/i,
];

/**
 * V328/V334 (`org_has_feature`) lock the Event Pass to the competition's own
 * lifecycle: it stops applying once the competition is archived or completed,
 * or more than 7 days past its end date. It does NOT last "for the event's
 * lifetime", or any synonym of that.
 *
 * Vocabulary of UNBOUNDED DURATION. Fix round 1 widened it after three measured
 * misses: "it stays yours for as long as you want", "The upgrade does not
 * lapse", and "Once bought, it is yours to keep".
 *
 * SCOPE — READ BEFORE REUSING. This list is for PASS copy only. Credit packs
 * legitimately never expire (D2, purchased credits are permanent), so several
 * of these patterns are TRUE statements about credits. Never run this against
 * the whole seed, and when Tasks 3/4/7 point it at a help article or a
 * dictionary, scope it to the pass's own paragraph/keys first.
 *
 * Within that scope the patterns are still chosen so a CORRECT sentence ("the
 * pass stops applying after the competition ends") cannot match — the one
 * concessive requires its subject, so "even after you cancel" cannot match
 * either.
 */
export const FALSE_PASS_PERMANENCE_PATTERNS = [
  /\blifetime\b/i,
  /\bforever\b/i,
  /\bpermanentl?y?\b/i,
  // Fix round 2 (task 3): the separator was a required literal space, so the
  // hyphenated "never-ending" — the most natural way an editor writes this —
  // walked straight through. The participles are covered for the same reason.
  /\bnever[-\s](expir(es?|ing)|laps(es?|ing)|end(s|ing)?)\b/i,
  /\bdoes\s+not\s+(expire|lapse|end)\b/i,
  /\bindefinitely\b/i,
  /\bfor\s+good\b/i,
  /\bno\s+expir(y|ation|ing)\b/i,
  /\bno\s+time\s+limit\b/i,
  /\byours\s+to\s+keep\b/i,
  /\b(stays?|remains?)\s+yours\b/i,
  /\bas\s+long\s+as\s+you\s+(want|like|wish|need|choose)\b/i,
  /\b(even|keeps?\s+working)\s+(after|once)\s+(it|the\s+(competition|event))\b/i,
  // Fix round 1 (task 4): forms of the same claim that the list above could not
  // reach. `never expire` was covered only because the plural verb happens to
  // share a stem with the singular; the negated-auxiliary and the
  // lifetime-adverbial forms had no entry at all.
  /\b(do|does|will)\s+not\s+(expire|lapse|end|stop|run\s+out)\b/i,
  /\b(don['’]t|doesn['’]t|won['’]t)\s+(expire|lapse|end|stop|run\s+out)\b/i,
  /\bnever\s+(?:ever\s+)?(stops?|stop|runs?\s+out)\b/i,
  /\bfor\s+life\b/i,
  /\bin\s+perpetuity\b/i,
  /\bno\s+end\s+date\b/i,
  // Fix round 1, second pass. An ADVERSARIAL set — permanence claims written
  // the way a speaker writes them rather than the way the rules above were
  // written — scored 0/8 in English and 0/32 across the four locales. Every
  // pattern above names a specific WORD; none names the CLAIM FAMILY. These
  // three families are what generalise:
  //   1. absence-of-an-end nouns,
  //   2. endurance verbs,
  //   3. "always" bound to a retention word (bare "always" is far too common
  //      in true copy to ban, so it is only a fault when it governs keeping).
  /\bno\s+(end|cut[-\s]?off|expiry|expiration|deadline)\b/i,
  /\bno\s+limit\s+on\s+(how\s+long|time|duration)\b/i,
  /\bwithout\s+(end|expiry|expiration)\b/i,
  /\b(endures?|persists?|carries\s+on|sticks\s+around|remains?\s+in\s+force)\b/i,
  /\bfor\s+the\s+rest\s+of\s+(time|your\s+life)\b/i,
  /\b(keeps?|yours|stays?|remains?)\b[^.;,]{0,24}\balways\b|\balways\b[^.;,]{0,24}\b(yours|keep|keeps|stays?|remains?)\b/i,
  /\b(no\s+matter\s+what|whatever\s+happens)\b/i,
];

/**
 * The POSITIVE half of the duration claim: a limiting conjunction that GOVERNS
 * an activity word. "while it's active" binds the pass to a condition; "active
 * immediately" is a claim of immediate start and NO end, and must not satisfy a
 * rule meant to assert a bound.
 *
 * ── WHY THIS IS A GRAMMATICAL RELATION AND NOT A CHARACTER DISTANCE ──────────
 * Two rounds of this rule were written as `conjunction … {0,N} … activity word`
 * and BOTH were wrong, in opposite directions:
 *
 *   N=30  rejected TRUE copy — "until the competition is archived or no longer
 *         active" is 41 characters, and read as "never states the bound".
 *   N=60  accepted FALSE copy — "Buy it during the summer and your competition
 *         stays active" has no bound at all, but the two words are close
 *         enough. Measured: 3 of 3 no-bound sentences passed at 60.
 *
 * A distance cannot tell governing from adjacent, so neither number was ever
 * going to be right. What actually distinguishes them is CLAUSE MEMBERSHIP: in
 * the true sentence the activity word is the predicate of the clause the
 * conjunction introduces; in the false one a NEW SUBJECT ("and your
 * competition") has started a new clause and the conjunction governs nothing.
 *
 * So the relation is expressed directly: from the conjunction to the activity
 * word there may be no clause boundary — no sentence punctuation, no comma, and
 * no coordinator followed by a determiner (which is a new subject, i.e. a new
 * clause). Distance is unbounded, because a long clause is still one clause.
 *
 * Note "or no longer active" survives this: `or` is followed by an adverb, not
 * a determiner, so it coordinates a predicate rather than starting a clause.
 * That is exactly the distinction the character windows could not draw.
 */
const CLAUSE_BREAK: Record<string, string> = {
  en: String.raw`(?:\b(?:and|or|but|so|then|yet)\s+(?:the|a|an|your|our|my|its|their|this|that|these|those|it|we|you|they)\b)`,
  es: String.raw`(?:\b(?:y|e|o|u|pero|así\s+que)\s+(?:el|la|los|las|un|una|tu|tus|su|sus|este|esta|ese|esa)\b)`,
  fr: String.raw`(?:\b(?:et|ou|mais|donc)\s+(?:le|la|les|un|une|ton|ta|tes|votre|vos|son|sa|ses|ce|cette|ces)\b)`,
  nl: String.raw`(?:\b(?:en|of|maar|dus)\s+(?:de|het|een|je|jouw|uw|zijn|haar|dit|dat|deze|die)\b)`,
};

/**
 * Build the bounded-scope rule for one language from its own vocabulary.
 *
 * A BUILDER, not four copies: the four locale rules in `LOCALE_CLAIMS` and the
 * English rule below are the SAME grammatical claim in different words, and the
 * previous shape had each of them carrying its own `{0,60}`. When the window
 * turned out to be wrong it was wrong in five places. Now the relation lives
 * here and a language supplies only nouns and conjunctions.
 */
export function boundedScopeGrammarSource(
  conjunctions: string[],
  activity: string[],
  locale: keyof typeof CLAUSE_BREAK = "en",
  forbiddenComplement: string[] = [],
): string {
  const guard =
    forbiddenComplement.length === 0 ? "" : String.raw`(?!\s*(?:${forbiddenComplement.join("|")}))`;
  return (
    String.raw`\b(?:${conjunctions.join("|")})\b` +
    guard +
    String.raw`(?:(?!${CLAUSE_BREAK[locale]})[^.:;!?,])*?` +
    String.raw`\b(?:${activity.join("|")})\b`
  );
}

/**
 * `runs`/`running` are activity words because that is how the help articles
 * phrase the same bound ("upgrades one competition while it runs"). The
 * conjunction is still required, so widening the activity list cannot let an
 * unbounded claim through.
 *
 * The source is exported separately from the compiled pattern because the four
 * locale rules must compile the SAME source through `claim()` (Unicode `\b`,
 * for the accented-character bug task 4 measured) while this one is only ever
 * tested against English values, and `claim` is defined further down the file.
 *
 * FIX ROUND 2 — three more ways a conjunction failed to govern, all measured by
 * the reviewer against copy stating no bound at all:
 *
 *  - `during` takes a NOUN PHRASE, never a clause, so "During checkout your
 *    Event Pass becomes active" put the activity word in a different clause with
 *    nothing joining them. It survives only with a competition-shaped
 *    complement, which is the one reading that IS a temporal bound ("during the
 *    event the pass runs").
 *  - "Until NOW nobody could keep a competition active without Pro" is a
 *    statement about the past, not a bound.
 *  - "While BROWSING the pricing page you can keep every competition active" —
 *    a gerund complement has no subject, so the clause the conjunction
 *    introduces is not about the competition at all.
 */
export const BOUNDED_SCOPE_GRAMMAR_SOURCE = boundedScopeGrammarSource(
  [
    "while",
    String.raw`for\s+as\s+long\s+as`,
    String.raw`as\s+long\s+as`,
    "until",
    String.raw`during\s+(?:the\s+|that\s+|this\s+|its\s+|your\s+)?(?:competition|event|season|tournament|pass)`,
  ],
  ["active", "running", "runs", "open", "live", String.raw`under\s*way`],
  "en",
  [String.raw`now\b`, String.raw`\w+ing\b`],
);

export const BOUNDED_SCOPE_GRAMMAR = new RegExp(BOUNDED_SCOPE_GRAMMAR_SOURCE, "i");

/** The INVERSE of the pass's one-time credit grant: the pass tops the wallet up
 *  ONCE (`PASS_CREDIT_GRANT`; neither rung has an `ai.credits.monthly` row), so
 *  any recurring framing is a false claim, not a rewording. */
export const RECURRING_GRANT_PATTERNS = [
  /\bmonthly\b/i,
  /\bevery\s+month\b/i,
  /\beach\s+month\b/i,
  /\bper\s+month\b/i,
  /\ba\s+month\b/i,
  /\brecurring\b/i,
  // Fix round 2 (M4): the list was MONTHLY-ONLY, but the claim being guarded is
  // "the grant repeats" — a yearly or weekly framing is the same falsehood, and
  // the pass grants once. Verified against all 12 seed descriptions: none of
  // these fire on true copy today.
  /\b(annual|annually|yearly)\b/i,
  /\b(a|per|every|each)\s+year\b/i,
  /\b(weekly|quarterly|daily)\b/i,
  /\b(a|per|every|each)\s+(week|quarter|day)\b/i,
  /\b(renews?|renewing|renewal|tops?\s+up\s+again|again\s+each)\b/i,
  /\b(per|each|every)\s+billing\s+(period|cycle)\b/i,
];

/**
 * Each entry maps a feature_key to the vocabulary a card or description would
 * use to CLAIM it — broad enough that "AI-powered scheduling" and "AI-assisted
 * scheduling" are the same claim, because they are.
 *
 * Boolean features only: the unlimited-scale claims (members/teams/clubs) are
 * int-shaped and are checked separately against their caps.
 *
 * RENAMED in W2 (entitlements v18). It was `PLUS_DIFFERENTIATOR_VOCAB`, framed
 * by Pro Plus's "Everything in Pro, plus …" — and that plan is gone: V393
 * deleted `pro_plus` from `plans` outright. The LIST is unchanged and still
 * earns its keep, because `crossCardExclusivityFaults` asks it a question about
 * EVERY card rather than one tier: does any card claim a feature its own plan
 * does not grant? `officials.auto` is what keeps it non-vacuous today — V393
 * moved that key down to Pro when Pro Plus went, and the Pro card now says so.
 */
export const EXCLUSIVE_CLAIM_VOCAB: Array<[feature: string, claim: RegExp]> = [
  // Task 4 widened this to BOTH WORD ORDERS. It required "AI" before
  // "schedul…", so "scheduling with AI built in" — an ordinary way to write the
  // same claim, and the order every other language uses — returned no fault
  // (measured). The alternation costs nothing and closes the hole for every
  // surface that imports this list.
  ["scheduling.ai", /\bAI\b[^,.;]{0,20}\bschedul|\bschedul\w*\b[^,.;]{0,20}\bAI\b/i],
  ["officials.auto", /\bauto\w*\b[^,.;]{0,20}\bofficials?\b|\bofficials?\b[^,.;]{0,20}\bauto/i],
  ["api.write", /\bwrite\s+API\b/i],
  ["support.priority", /\bpriority\s+support\b/i],
];

// ── Guards, as pure fault-returning functions ────────────────────────────────

/** Retired-feature scan. Returns the source of every pattern that matched. */
export function retiredRunCapFaults(text: string): string[] {
  return RETIRED_AI_RUN_CAP_PATTERNS.filter((p) => p.test(text)).map(
    (p) => `quotes the retired per-division AI-run cap: ${p.source}`,
  );
}

/** A pass rung's key and the copy that sells it — BOTH customer-facing strings.
 *
 *  `name` is optional only so the rewording proofs below can stay one-liners;
 *  the real seed always has one, and `describedNameFaults` makes a missing name
 *  a fault in its own right. Where a rule has a negative half and a positive
 *  half, the NEGATIVE half reads `rungText()` (name + description — a falsehood
 *  is a falsehood in either) and the POSITIVE half stays on the description,
 *  which is the only one of the two with room to state a bound. */
export interface Rung {
  key: string;
  name?: string;
  description: string;
}

/** What a buyer actually reads for a rung: the Checkout line-item label and the
 *  product description, scanned as one body of copy. */
export const rungText = (r: Rung): string => (r.name ? `${r.name} | ${r.description}` : r.description);

/**
 * The pass's DURATION claim, both halves at once:
 *  - NEGATIVE: no unbounded-duration vocabulary anywhere in the description;
 *  - POSITIVE: the description must still SAY it is bounded. Without this half
 *    the guard only proves "not false" — deleting the qualifier entirely would
 *    pass, and a buyer would be told nothing about when the pass stops.
 *
 * The positive half is CLAUSE-SCOPED to the opening scope statement (before the
 * feature list's colon), because a vocabulary rule is otherwise satisfied by the
 * wrong clause in the same sentence — "10 active competitions" further down
 * would answer a question it was never asked.
 *
 * Two ways that scoping was defeated in fix round 1, both now faults:
 *  - NO COLON at all made `split(":")[0]` return the whole description, so the
 *    feature list answered for the scope statement. Measured: dropping one
 *    character took the wrong-clause fixture from red to green.
 *  - Any bare "active" satisfied it, so "active immediately" — a claim of
 *    immediate start and NO end — passed a rule meant to assert a bound. The
 *    bound's GRAMMAR is now required: a limiting conjunction governing it.
 */
export function passDurationFaults(rungs: Rung[]): string[] {
  const faults: string[] = [];
  for (const rung of rungs) {
    const { key, description } = rung;
    // NEGATIVE half over name AND description. "Seazn Club Event Pass — yours
    // forever, never expires" is the wave's flagship falsehood written into the
    // Checkout line-item label, and it shipped green while this scanned the
    // description alone.
    const text = rungText(rung);
    for (const pattern of FALSE_PASS_PERMANENCE_PATTERNS) {
      if (pattern.test(text)) {
        faults.push(`${key}: claims unbounded duration (${pattern.source})`);
      }
    }
    const colon = description.indexOf(":");
    if (colon === -1) {
      faults.push(
        `${key}: no ":" separating the scope statement from the feature list — the bound cannot be scoped`,
      );
      continue;
    }
    // A limiting conjunction that GOVERNS the activity word — see
    // BOUNDED_SCOPE_GRAMMAR for why the window is 60 and not 30.
    if (!BOUNDED_SCOPE_GRAMMAR.test(description.slice(0, colon))) {
      faults.push(`${key}: opening clause never states the pass is bounded to an active competition`);
    }
  }
  return faults;
}

/** The grant declared for a rung key, or `undefined` for a key `PASS_CREDIT_GRANT`
 *  does not know. Deliberately NOT defaulted: an unrecognised rung must be a
 *  fault in its own right, because the alternative — judging it against some
 *  other rung's number — is how a third rung would ship advertising M's grant. */
const grantForRung = (key: string): number | undefined =>
  (PASS_CREDIT_GRANT as Record<string, number | undefined>)[key];

/** Every grant this product declares, for the surfaces that describe BOTH rungs
 *  in one body of copy and so cannot be judged against a single number. */
/**
 * The credit grants the pass copy may quote — the grants of the rungs ON SALE.
 *
 * Not `Object.values(PASS_CREDIT_GRANT)`, which is every rung's grant including
 * the withdrawn ones (owner decision 2026-09-05 took the L rung off sale). It
 * feeds BOTH directions of the scan below, and each needs the sellable set for
 * its own reason: the positive half would demand a figure for a size no reader
 * can buy, and the negative half would then WAIVE that same figure — so an
 * article still advertising the withdrawn rung's top-up would read as correct.
 * Narrowing it makes a leftover +35 a fault, which is what it is.
 *
 * The full declaration is still checked, in the place where it is a claim about
 * the SEED rather than about copy: `pass-credit-grant.test.ts` pins every
 * rung's grant and keeps the two distinct.
 */
const DECLARED_GRANTS: readonly number[] = SELLABLE_PASS_KEYS.map((k) => PASS_CREDIT_GRANT[k]);

/**
 * The pass's CREDIT claim, PER RUNG. This is also the POSITIVE PAIRING for the
 * retired AI-run-cap scan: that scan is absence-shaped, so alone it proves only
 * that we stopped quoting a dead cap — never that we replaced it with the
 * mechanism that is actually live. Requiring the grant to be STATED closes it.
 *
 * Four ways to be wrong, all covered: not mentioned; a DIFFERENT number (drift);
 * THE OTHER RUNG'S number — which is a plain drift check only while the grant is
 * flat, and becomes the likeliest real defect the moment it is not (M's copy was
 * copied to make L's, and 25 read as correct on both); or sold as recurring.
 *
 * Entitlements v18 / W2 T5: this used to read one flat `PASS_CREDIT_GRANT` and
 * its own comment asserted the grant "is flat and never reads `pass_key`". Both
 * halves now key off the rung, so quoting 25 on L is a fault and quoting 50 on M
 * is a fault — where before, one of those two was the required wording and the
 * other was invisible.
 */
export function passCreditGrantFaults(rungs: Rung[]): string[] {
  const faults: string[] = [];
  for (const rung of rungs) {
    const { key, description } = rung;
    const text = rungText(rung);
    const grant = grantForRung(key);
    if (grant === undefined) {
      // Anti-vacuity: with no declared grant every check below would pass on
      // silence, so an unknown rung would be the ONE product this rule exempts.
      faults.push(`${key}: no credit grant is declared for this rung`);
      continue;
    }
    // POSITIVE half: only the description has room to state the grant.
    if (!description.includes(`+${grant} AI credits`)) {
      faults.push(`${key}: does not state the +${grant} AI credit grant`);
    }
    // NEGATIVE halves over name AND description.
    for (const match of text.matchAll(/(\d+)\s*AI\s+credits?/gi)) {
      if (Number(match[1]) !== grant) {
        faults.push(`${key}: quotes ${match[1]} AI credits, but the grant is ${grant}`);
      }
    }
    for (const pattern of RECURRING_GRANT_PATTERNS) {
      if (pattern.test(text)) {
        faults.push(`${key}: sells the one-time grant as recurring (${pattern.source})`);
      }
    }
  }
  return faults;
}

/**
 * ── SCORING DETAIL IS NEVER FOR SALE (entitlements v18 / W1, owner ruling
 * 2026-08-30) ───────────────────────────────────────────────────────────────
 *
 * `scoring.ball_by_ball`, `scoring.rally_by_rally` and `scoring.match_timeline`
 * were deleted from `plan_entitlements` by V390 and their server gate was
 * deleted from `scoreEvent` and the batch importer. How much detail a scorer
 * records is now a UX choice (`PadSpec.fidelity`), not a price boundary.
 *
 * Copy is the half that does not move on its own. A string that still tells a
 * customer that ball-by-ball, rally-by-rally, a match timeline or a recording
 * detail level costs money is the worst of the two possible errors: a free org
 * either pays for something it already has, or never tries the feature at all.
 * Free in the product and paid on the page is strictly worse than paid in both.
 *
 * SHAPE: the caller supplies `[id, text]` pairs — one dictionary key and its
 * value, or one help-article SENTENCE and its article slug. A sentence, not a
 * whole article: "every plan can charge entry fees" and "cricket scores ball by
 * ball" are two true claims that share a page, and a window that crossed the
 * full stop between them would read them as one false one.
 *
 * It is deliberately a PAIR test. Naming the capability is fine (the help tree
 * has to, to explain it) and naming a plan is fine (the billing articles have
 * to). Only the two TOGETHER assert a price, and only that is a fault.
 */
export const SCORING_DETAIL =
  /\b(ball[- ]by[- ]ball|rally[- ]by[- ]rally|match[- ]timelines?|recording detail|scoring detail|detail levels?)\b/i;

/** The plan NAMES, case-sensitive on purpose: they are proper nouns, and
 *  matching them case-insensitively would read "a pro scorer" and "the
 *  community pitch" as pricing claims. `Pro`/`Pro Plus`/`Event Pass` are
 *  untranslated in every locale (`pricing.table.pro` is "Pro" in all four), so
 *  this half is shared; only `Community` has a localised form, added per
 *  locale below. */
export const PAID_PLAN_NAME = /\b(Pro Plus|Pro|Event Pass|Community)\b/;

/** The price VERBS, case-insensitive — these are ordinary words wherever they
 *  appear, and a sentence-initial "Upgrade" must read the same as an inline
 *  one. */
export const PAID_VERB = /\b(upgrades?|upgrading|upgraded|paid plan|entitled|entitlement|unlocks?|plans?)\b/i;

/** The AFFIRMATION, and the reason this rule is not simply "never say `plan`
 *  near `detail`". The truthful sentence the help tree now has to be able to
 *  write — "every level is available on every plan" — names a detail level AND
 *  a plan, and would otherwise be the one string the rule most wants to allow.
 *  A text that says the thing is free is exempt, whatever else it says. */
export const SCORING_FREE_AFFIRMATION =
  /\b(on every plan|on all plans|on any plan|whatever your plan|no matter (?:your|which) plan|at no extra cost|costs nothing|free on every plan|never a paid feature|is never for sale)\b/i;

/**
 * ── ONE LANGUAGE'S WORTH OF THE RULE ────────────────────────────────────────
 *
 * FIX ROUND 3. The first three versions of this guard were ENGLISH ONLY while
 * its dictionary consumer scanned all four locales, so every Spanish, French
 * and Dutch value was measured against vocabulary that cannot occur in it and
 * could say anything at all. Eleven realistic localised paywall strings passed
 * silently; only the English control fired.
 *
 * NOT NATIVE-SPEAKER AUDITED — and deliberately not invented either. Every
 * non-English term below is lifted from copy this product already ships
 * (`board.ai.error.upgrade`, `settings.upgrade.brandColor`,
 * `addOns.extraOrg.error.planCannot`, `billing.planChange.toPro` in each
 * locale), and `dictionary-copy-truth.test.ts` asserts each locale's
 * vocabulary still matches those live strings — so this is evidence, not my
 * translation, and it reds if the product's own upsell wording moves away from
 * it. A native speaker should still WIDEN these lists; the report says so.
 */
export interface ScoringFreeVocabulary {
  /** Phrases naming scoring DEPTH, beyond the band labels passed in by the
   *  caller (those are read from the dictionary, never typed here). */
  detail: RegExp;
  /** Plan names — case-SENSITIVE, proper nouns. */
  planName: RegExp;
  /** Price verbs — case-insensitive. */
  paidVerb: RegExp;
  /** Ways of saying "this costs nothing", which exempt the text. */
  affirmation: RegExp;
}

export const SCORING_FREE_VOCABULARY: Readonly<Record<string, ScoringFreeVocabulary>> = {
  en: {
    detail: SCORING_DETAIL,
    planName: PAID_PLAN_NAME,
    paidVerb: PAID_VERB,
    affirmation: SCORING_FREE_AFFIRMATION,
  },
  es: {
    detail: /\b(bola a bola|punto a punto|cronolog[íi]a del partido|nivel de detalle|detalle de (?:grabaci[óo]n|registro))\b/i,
    planName: /\b(Pro Plus|Pro|Pase de Evento|Community|Comunidad)\b/,
    paidVerb: /\b(planes?|mejora[rs]?|actualiza[rs]?|requiere[ns]?|necesita[ns]?|de pago|desbloquea[rns]?|suscripci[óo]n|cambia[rs]? a|pasar a)\b/i,
    affirmation: /\b(en todos los planes|en cualquier plan|en cada plan|sin coste adicional|sin costo adicional|es gratis|gratuito en todos)\b/i,
  },
  fr: {
    detail: /\b(balle par balle|[ée]change par [ée]change|chronologie du match|niveau de d[ée]tail|d[ée]tail d'enregistrement)\b/i,
    planName: /\b(Pro Plus|Pro|Pass [ÉE]v[ée]nement|Community|Communaut[ée])\b/,
    paidVerb: /\b(forfaits?|plans?|mise à niveau|n[ée]cessite|requiert|payante?s?|d[ée]bloque[rz]?|abonnement|passer à|passez à)\b/i,
    affirmation: /\b(sur tous les forfaits|sur tous les plans|sur n'importe quel forfait|sur chaque forfait|sans frais suppl[ée]mentaires|est gratuit|gratuit sur tous)\b/i,
  },
  nl: {
    detail: /\b(bal[- ]voor[- ]bal|rally[- ]voor[- ]rally|wedstrijdtijdlijn|detailniveau|opnamedetail)\b/i,
    planName: /\b(Pro Plus|Pro|Event Pass|Community)\b/,
    paidVerb: /\b(abonnementen?|plannen?|plan|upgrades?|upgraden|vereist|betaalde?|ontgrendel[tn]?|overstappen naar|stap over op)\b/i,
    affirmation: /\b(op elk abonnement|op alle abonnementen|op elk plan|op alle plannen|zonder extra kosten|is gratis|gratis op elk)\b/i,
  },
};

/** Literal text → a regex-safe fragment. The band labels come from the
 *  dictionary, so they can contain anything a translator writes. */
function literalAlternation(terms: readonly string[]): RegExp | null {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return null;
  const escaped = cleaned.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")})`, "i");
}

export interface ScoringFreeOptions {
  /** Which language `strings` are written in. Defaults to English — the help
   *  tree is English-only by standing rule. An unknown locale is a FAULT, not
   *  a silent skip: a locale with no vocabulary is a locale nothing scans. */
  locale?: string;
  /**
   * The band labels a customer actually reads, e.g. the four values of
   * `pad.recording.band.0-3` for this locale.
   *
   * PASSED IN, NEVER TYPED HERE (fix round 3). The guard's own vocabulary said
   * "match timeline" while the product renders "Full timeline" — so the three
   * labels this wave shipped were invisible to the one rule that exists to
   * stop them being sold. Reading them from the dictionary means a future
   * rename moves the guard with the label instead of leaving it behind, and it
   * is the only way the non-English locales get them at all ("Cronología
   * completa", "Chronologie complète", "Volledige tijdlijn").
   */
  bandLabels?: readonly string[];
}

export function scoringFreeClaimFaults(
  strings: ReadonlyArray<readonly [id: string, text: string]>,
  options: ScoringFreeOptions = {},
): string[] {
  const locale = options.locale ?? "en";
  const vocabulary = SCORING_FREE_VOCABULARY[locale];
  if (!vocabulary) {
    return [`${locale}: no scoring-free vocabulary — every string in this locale is unscanned`];
  }
  const bandLabels = literalAlternation(options.bandLabels ?? []);
  const faults: string[] = [];
  for (const [id, text] of strings) {
    if (vocabulary.affirmation.test(text)) continue;
    const namesDetail = vocabulary.detail.test(text) || (bandLabels?.test(text) ?? false);
    if (namesDetail && (vocabulary.planName.test(text) || vocabulary.paidVerb.test(text))) {
      faults.push(`${id}: presents scoring detail as paid: "${text.slice(0, 120)}"`);
    }
  }
  return faults;
}

/** A rung's live caps, as the matrix holds them. `null` means unlimited. */
export interface RungCaps {
  key: string;
  entrants: number | null;
  divisions: number | null;
}

/**
 * Every cap a rung's description quotes must be that rung's OWN live cap:
 *  - a numeric cap must appear as "<n> entrants" / "<n> divisions";
 *  - a NULL cap must be said in words ("unlimited entrants"), and the copy must
 *    then quote no entrant number at all — a null cap with a number beside it is
 *    the M-rung ceiling sold to an L buyer;
 *  - and no rung may quote ANOTHER rung's distinct figure, which is how one
 *    size's ceiling comes to read as "the pass's" limit.
 */
export function capClaimFaults(rungs: Rung[], caps: RungCaps[]): string[] {
  const faults: string[] = [];
  const capsFor = (key: string) => caps.find((c) => c.key === key);

  for (const rung of rungs) {
    const { key, description } = rung;
    // NEGATIVE halves (a figure that is wrong, or another rung's) read name AND
    // description; POSITIVE halves ("must quote its own cap") stay on the
    // description, which is where the seed states caps.
    const text = rungText(rung);
    const own = capsFor(key);
    if (!own) {
      faults.push(`${key}: no live caps resolved for this rung`);
      continue;
    }

    if (own.entrants === null) {
      if (!/\bunlimited\s+entrants\b/i.test(description)) {
        faults.push(`${key}: entrant cap is unlimited but the copy never says so`);
      }
      for (const match of text.matchAll(/(\d[\d,]*)\s+entrants\b/gi)) {
        faults.push(`${key}: quotes "${match[1]} entrants" for an unlimited cap`);
      }
    } else {
      if (!description.includes(`${own.entrants} entrants`)) {
        faults.push(`${key}: does not quote its live entrant cap (${own.entrants})`);
      }
      // …and it may not ALSO say "unlimited". W2 (entitlements v18, V393) gave
      // the L rung a real 512-entrant cap where it had been null, and every
      // surface describing it said "unlimited entrants". Quoting the number
      // BESIDE the word would have satisfied the branch above while the
      // sentence a buyer reads still promised no ceiling — the one direction a
      // presence-only rule cannot see, because the word stays readable as true.
      if (/\bunlimited\s+entrants\b/i.test(text)) {
        faults.push(
          `${key}: calls its entrant cap unlimited, but the matrix caps it at ${own.entrants}`,
        );
      }
    }

    if (own.divisions === null) {
      if (!/\bunlimited\s+divisions\b/i.test(description)) {
        faults.push(`${key}: division cap is unlimited but the copy never says so`);
      }
    } else {
      if (!description.includes(`${own.divisions} divisions`)) {
        faults.push(`${key}: does not quote its live division cap (${own.divisions})`);
      }
      if (/\bunlimited\s+divisions\b/i.test(text)) {
        faults.push(
          `${key}: calls its division cap unlimited, but the matrix caps it at ${own.divisions}`,
        );
      }
    }

    // Cross-rung contamination. Skipped where two rungs genuinely share a
    // figure — there the number is not evidence of anything.
    for (const other of caps) {
      if (other.key === key) continue;
      if (other.entrants !== null && other.entrants !== own.entrants) {
        if (text.includes(`${other.entrants} entrants`)) {
          faults.push(`${key}: quotes ${other.key}'s entrant cap (${other.entrants})`);
        }
      }
      if (other.divisions !== null && other.divisions !== own.divisions) {
        if (text.includes(`${other.divisions} divisions`)) {
          faults.push(`${key}: quotes ${other.key}'s division cap (${other.divisions})`);
        }
      }
    }
  }
  return faults;
}

/**
 * WHICH PLAN a paywall sentence attributes a feature to, against the row.
 *
 * `lib/feature-copy.ts`'s `FEATURE_REASONS` is the one map every 402 and every
 * `<UpgradeGate>` reads, keyed by `plan_entitlements.feature_key`, so each entry
 * is a claim about a SPECIFIC row and can be judged against that row alone — no
 * vocabulary, no guessing which feature a sentence is about.
 *
 * Two directions, because W2 moved keys BOTH ways in one wave and each
 * direction lies differently:
 *
 *  - a key community GRANTS, described as "a Pro feature". V390 freed the three
 *    scoring-detail keys and V393 brought `officials.auto` down to Pro; a reason
 *    left behind sells an upgrade for something the reader already has, and the
 *    gate it belongs to can no longer fire, so nobody ever sees it be wrong.
 *  - a key community does NOT grant, described as free / on every plan. V396
 *    made `dashboard.player_profiles`, `embeds.enabled` and `news.auto` paid on
 *    Free and V397 took the accent colour off it; a reason left behind promises
 *    a capability the resolver refuses, which is the more expensive direction —
 *    the reader is told they have it, tries, and is stopped.
 *
 * The second direction caught a live one the day it was written: V396's own
 * `dashboard.branding` reason still ended "your own club logo and colours work
 * on every plan" after V397 priced the colour at Pro.
 *
 * A reason for a key with NO ROW is a fault too, not a skip: the resolver
 * answers 0/false for a missing row, so such a sentence describes a refusal
 * nothing can lift, and `?? true` would have read a deleted key as free.
 */
export interface PaywallReason {
  /** `plan_entitlements.feature_key`. */
  key: string;
  text: string;
}

/**
 * The noun class a "this belongs to a paid tier" sentence actually uses in
 * this codebase — not just "feature".
 *
 * W3 fix round 2 (item 4): `FEATURE_REASONS["formats.double_elim"]` read
 * "Double-elimination brackets are a Pro FORMAT" — one word away from the "a
 * Pro feature" phrasing `PRO_ATTRIBUTION` matched, which is exactly how it
 * evaded `freeClaimFaults` while community had granted the row since V393.
 * Widening to "format" ALONE would have been the same mistake with a
 * shorter fuse: `discovery.featured` ships "is a Pro PERK" today, matched by
 * neither the old pattern nor a "feature|format" one — found only by reading
 * every noun this file's own copy actually uses, which is the check the
 * item's finding demands rather than "add the one word that just bit us".
 * `plan`/`tier`/`add-on` are included on the same reasoning even though no
 * shipped sentence currently uses them: a vocabulary sized to today's copy is
 * the same fragility one wave later.
 */
const PAID_TIER_NOUN = "(?:features?|formats?|perks?|plans?|tiers?|add-ons?)";

/**
 * "…is a Pro feature", "…are Pro formats", "needs a Pro plan", "upgrade to
 * Pro".
 *
 * DELIBERATELY NOT "needs a bigger plan". That is a QUOTA sentence — the
 * allowance is used up — and every quota key legitimately has a community
 * allowance, so treating it as a plan attribution reported
 * `divisions.per_competition.max`, `stages.per_division.max` and `import.bulk`
 * as falsehoods on this guard's first run. A cap sentence says "you have used
 * yours", not "this belongs to Pro".
 *
 * Two shapes for the noun clause, not one: "is a/an Pro NOUN" (singular, with
 * article — "is a Pro feature") and "is/are Pro NOUN(s)" (no article, either
 * number — "are Pro formats"). `formats.advanced`'s own TRUE reason uses the
 * second shape ("Americano, ladders … are Pro formats"), which is why both
 * have to be recognised: a vocabulary that only matched the false claim's
 * shape and not the true claim's own would be an accident of which sentence
 * happened to get fixed first, not a rule.
 */
export const PRO_ATTRIBUTION = new RegExp(
  String.raw`\b(?:is|are)\s+(?:a|an)\s+(?:Pro|paid)\s+${PAID_TIER_NOUN}\b` +
    String.raw`|\b(?:is|are)\s+Pro\s+${PAID_TIER_NOUN}\b` +
    String.raw`|\b(?:is|are)\s+on\s+Pro\b` +
    String.raw`|\bneeds?\s+(?:a\s+)?Pro\s+plan\b` +
    String.raw`|\bupgrade\s+to\s+Pro\b`,
  "i",
);
// "…is on Pro and the Event Pass" was added 2026-09-05 with the twelve reasons
// that now name both plans. Without it those sentences match no PAID
// attribution at all, so a trailing contrast clause ("…the flat partner strip
// is free on every plan") becomes the only thing the vocabulary sees and the
// reason reads as a claim that the GATED capability is free — which is exactly
// the false positive the `attributesFree` comment below describes. Measured:
// rewording `sponsors.tiers` and `sponsors.monetize` produced precisely that
// pair of phantom faults until this alternative existed.

/**
 * "…is an Enterprise feature", the Contact-us tier's own attribution.
 *
 * Its own pattern rather than a `(?:Pro|Enterprise)` alternation inside
 * `PRO_ATTRIBUTION`, because the two make DIFFERENT claims about the same row:
 * a Pro attribution says pro grants it, an Enterprise attribution says pro does
 * NOT. Folding them together would have had this guard demand that
 * `dashboard.branding` — badge removal, enterprise-only since V396 — be granted
 * on Pro, which is the very thing the sentence says it is not.
 */
/**
 * "…and the Event Pass", the sentence naming the other plan that grants a key.
 *
 * Only used NEGATIVELY: a "Pro feature" claim is a fault when a pass rung also
 * grants the key and the sentence does NOT say so. Deliberately loose — any
 * mention of the pass is enough, because the claim being tested is "did we tell
 * them", not "did we phrase it a particular way".
 */
export const PASS_ATTRIBUTION = /\bevent\s+pass\b/i;

// Same noun-class widening as `PRO_ATTRIBUTION`, and the same reasoning: an
// Enterprise attribution keyed to "feature" alone is one synonym from the
// identical evasion, even though no shipped Enterprise sentence has used a
// different noun yet.
export const ENTERPRISE_ATTRIBUTION = new RegExp(
  String.raw`\b(?:is|are)\s+(?:a|an)\s+Enterprise\s+${PAID_TIER_NOUN}\b` +
    String.raw`|\b(?:is|are)\s+Enterprise\s+${PAID_TIER_NOUN}\b` +
    String.raw`|\bneeds?\s+(?:an\s+)?Enterprise\s+plan\b`,
  "i",
);

/** "…works on every plan", "free on every plan", "included on every plan". */
export const FREE_ATTRIBUTION =
  /\b(?:work|works|available|included|free)\b[^.;]{0,24}\bon\s+every\s+plan\b|\bon\s+every\s+plan\b[^.;]{0,24}\b(?:free|included)\b|\bfree\s+for\s+everyone\b/i;

export function freeClaimFaults(
  reasons: PaywallReason[],
  rows: Record<string, Record<string, { bool: boolean | null; int: number | null }>>,
): string[] {
  if (reasons.length === 0) return ["no paywall reasons — this rule examines nothing"];
  if (Object.keys(rows).length === 0) {
    return ["no plan_entitlements rows — the reasons were compared against nothing"];
  }
  const faults: string[] = [];
  let judged = 0;

  for (const { key, text } of reasons) {
    const row = rows[key]?.community;
    const proRow = rows[key]?.pro;
    // A reason for a key the matrix does not hold at all. Only reported for a
    // sentence that actually attributes a plan — a reason may legitimately
    // describe something that is not a row (see `import.bulk`, which quotes a
    // cap and names no plan).
    const attributesPro = PRO_ATTRIBUTION.test(text);
    const attributesEnterprise = ENTERPRISE_ATTRIBUTION.test(text);
    // A free claim counts as a claim about THIS key only when the sentence
    // makes no paid attribution at all. Several reasons pair the two on
    // purpose — "Sponsor tiers … are a Pro feature — the flat partner strip is
    // free on every plan", "Removing the seazn.club badge is an Enterprise
    // feature — your own club logo works on every plan" — where the free half
    // is a CONTRAST about a different capability. Reading it as a claim about
    // the gated key reported five honest sentences as falsehoods on this
    // guard's first two runs.
    const attributesFree = !attributesPro && !attributesEnterprise && FREE_ATTRIBUTION.test(text);
    if (!attributesPro && !attributesEnterprise && !attributesFree) continue;
    judged += 1;
    if (!rows[key]) {
      faults.push(`${key}: attributes a plan, but plan_entitlements has no such feature`);
      continue;
    }
    // The resolver's own two shapes, and they must not be merged. `hasFeature`
    // reads `bool_value === true` EXACTLY; `getLimit` reads `int_value`, where
    // NULL means unlimited and no row means 0.
    //
    // A bool row carries `int_value = NULL`, so "int is null therefore
    // unlimited" reads every DENIED boolean as granted — measured on the first
    // run of this guard, which reported `embeds.enabled` (community false,
    // int null) as free. The discriminator is which COLUMN is populated.
    const grants = (r: { bool: boolean | null; int: number | null } | undefined): boolean =>
      r !== undefined && (r.bool !== null ? r.bool === true : r.int === null || r.int > 0);
    const communityGrants = grants(row);
    if ((attributesPro || attributesEnterprise) && communityGrants) {
      const named = attributesPro ? "Pro" : "Enterprise";
      faults.push(`${key}: calls it ${named === "Pro" ? "a Pro" : "an Enterprise"} feature, but community already grants it`);
    }
    if (attributesFree && !communityGrants) {
      faults.push(`${key}: says it works on every plan, but community does not grant it`);
    }
    // …and the Pro half of a "Pro feature" claim has to be true as well. V396
    // took `dashboard.branding` off Pro, which is the shape that makes a
    // paywall point a Pro subscriber at an upgrade they already bought.
    if (attributesPro && proRow !== undefined && !grants(proRow)) {
      faults.push(`${key}: calls it a Pro feature, but pro does not grant it either`);
    }
    // …and the EVENT PASS, which not one of the rules above can see. They
    // reason about community, pro and enterprise only, so "a Pro feature" for a
    // key a pass rung ALSO grants satisfies every one of them — while telling a
    // pass holder to go and buy an upgrade they are already holding. That is
    // precisely the failure the Pro rule above exists to catch, one plan over.
    //
    // Three sentences sat wrong behind that blind spot until 2026-09-05:
    // `stats.player`, `scoring.audit_export` and `discipline.enforced`, all
    // granted to both rungs by V393 and all still reading "is a Pro feature".
    // The guard was written before the pass held anything worth naming, and
    // nothing widened it when V393 made it hold four things.
    if (attributesPro && !PASS_ATTRIBUTION.test(text)) {
      const rungs = (["event_pass", "event_pass_l"] as const).filter((rung) =>
        grants(rows[key]?.[rung]),
      );
      if (rungs.length > 0) {
        faults.push(
          `${key}: calls it a Pro feature without naming the Event Pass, which grants it too (${rungs.join(", ")})`,
        );
      }
    }
    // …and the ENTERPRISE claim, judged the other way round: naming the
    // Contact-us tier asserts that PRO does not have it. A key Pro grants,
    // sold as enterprise-only, sends a paying subscriber to a sales
    // conversation for something already on their bill.
    if (attributesEnterprise) {
      if (proRow !== undefined && grants(proRow)) {
        faults.push(`${key}: calls it an Enterprise feature, but pro grants it`);
      }
      const entRow = rows[key]?.enterprise;
      if (entRow !== undefined && !grants(entRow)) {
        faults.push(`${key}: calls it an Enterprise feature, but enterprise does not grant it`);
      }
    }
  }

  if (judged === 0) {
    faults.push(
      "no reason attributed a plan — the attribution vocabulary has gone stale and this rule examined nothing",
    );
  }
  return faults;
}

// `plusDifferentiatorFaults` and `localePlusDifferentiatorFaults` were DELETED
// here in W2 (entitlements v18). Both judged the "Everything in Pro, plus …"
// frame against `pro_plus` grants, and V393 deleted that plan from `plans` and
// `plan_entitlements` outright — so every call reported the same four faults
// ("claims officials.auto, which has no rows in plan_entitlements", and so on)
// about a card `/pricing` no longer renders. A guard whose subject is gone does
// not fail safe; it fails LOUD, about nothing, and hides the guards that are
// still telling the truth.
//
// What survives, because the QUESTION survives: `EXCLUSIVE_CLAIM_VOCAB` above,
// read by `crossCardExclusivityFaults` in pricing-cards.test.ts — does any card
// claim a feature its own plan does not grant? That is asked of every card and
// needs no tier above Pro. The four LOCALE vocabularies that fed the deleted
// locale guard went with it (`LocaleClaims.plusClaims`).

// ── The extra-organisation rider rate ────────────────────────────────────────

/** A graduated price as the seed holds it: tier 1 is the plan base, tier 2+ the
 *  per-extra-organisation rider. */
export interface TieredPrice {
  lookup_key: string;
  unit_amount: number;
  currency_options?: Record<string, number>;
  tiers?: Array<{
    up_to: number | string;
    unit_amount: number;
    currency_options?: Record<string, number>;
  }>;
}

export interface PricedPlan {
  key: string;
  product: { name?: string; description: string };
  prices: Record<string, TieredPrice>;
}

/** Which comparison a piece of rider copy LICENSES, or null if it makes no
 *  statement about the rate at all. Checked most-specific first, because "no
 *  more than half the base rate" also contains "half the base rate".
 *
 *  Extracted in fix round 6 so the plan descriptions, the `org_addons` product
 *  NAMES and the add-on descriptions are all judged by one detector. The probe
 *  that motivated it put "Seazn Club Extra Organisation — Pro, half the base
 *  rate" — the unqualified claim, on the Checkout line-item label — into the
 *  seed, and nothing read it. */
export function riderClaimIn(text: string): "under" | "atMost" | "exactly" | null {
  if (/\b(a\s+little\s+|just\s+)?under\s+half\b/i.test(text)) return "under";
  if (/\b(no\s+more\s+than|at\s+most|up\s+to)\s+half\b/i.test(text)) return "atMost";
  if (/\bhalf\s+the\s+base\s+rate\b/i.test(text)) return "exactly";
  return null;
}

/** usd rides `unit_amount`; the rest are SET points in `currency_options`. */
export const SEED_CURRENCIES = ["usd", "eur", "gbp", "inr"] as const;

const amountIn = (
  node: { unit_amount: number; currency_options?: Record<string, number> },
  currency: string,
): number | undefined =>
  currency === "usd" ? node.unit_amount : node.currency_options?.[currency];

/**
 * The extra-organisation rider rate, against the claim the copy makes about it.
 *
 * Both plan descriptions quote the rider as a fraction of the base. That claim
 * was measurably false: at $19/$9 the rider is 47.4% of Pro and at $39/$19 it is
 * 48.7% of Pro Plus, because the seed derives it as "half the base rounded DOWN"
 * (its own `$comment_tiers`). It erred in the buyer's favour — but a price move
 * flips it silently to OVER half, and then the copy overcharges.
 *
 * ROUNDING DOWN IS NOT THE SAME AS "UNDER HALF": in eur and aud on
 * `seazn_pro_monthly` the halves are whole units (1800→900, 2800→1400), so the
 * rider is EXACTLY half. Only a "no more than half" claim is true in all twenty
 * (plan × interval × currency) combinations, and the claim shape below is what
 * decides which comparison this guard enforces — so the copy and the arithmetic
 * can never drift apart in either direction.
 *
 * Anchored on `lookup_key`, never on position: each rider's `currency_options`
 * block appears twice in the file (the graduated tier and the matching
 * `org_addons` price carry identical numbers).
 */
export function riderRateFaults(plans: PricedPlan[]): string[] {
  const faults: string[] = [];
  for (const plan of plans) {
    const description = plan.product.description;

    // Which comparison the COPY licenses — read over the NAME as well as the
    // description, because both are customer-facing and stripe-sync writes both.
    const claim = riderClaimIn(
      plan.product.name ? `${plan.product.name} | ${description}` : description,
    );

    if (claim === null) {
      faults.push(`${plan.key}: makes no statement about the extra-organisation rate`);
      continue;
    }

    for (const [interval, price] of Object.entries(plan.prices)) {
      const base = price.tiers?.find((t) => t.up_to === 1);
      const rider = price.tiers?.find((t) => t.up_to === "inf");
      if (!base || !rider) {
        faults.push(`${price.lookup_key}: no graduated base/rider tiers to compare`);
        continue;
      }
      // The seed's own invariant: tier 1 always equals the headline amount, so
      // "the base rate" is unambiguous.
      if (base.unit_amount !== price.unit_amount) {
        faults.push(
          `${price.lookup_key}: tier 1 (${base.unit_amount}) is not the headline amount (${price.unit_amount})`,
        );
      }
      for (const currency of SEED_CURRENCIES) {
        const baseAmount = amountIn(base, currency);
        const riderAmount = amountIn(rider, currency);
        if (baseAmount === undefined || riderAmount === undefined) {
          faults.push(`${price.lookup_key} ${currency}: no ${interval} price point to compare`);
          continue;
        }
        const half = baseAmount / 2;
        const label = `${price.lookup_key} ${currency}: rider ${riderAmount} vs base ${baseAmount}`;
        if (riderAmount > half) {
          faults.push(`${label} — OVER half, the copy undercharges against what we bill`);
        } else if (claim === "under" && riderAmount === half) {
          faults.push(`${label} — exactly half, but the copy claims UNDER half`);
        } else if (claim === "exactly" && riderAmount !== half) {
          faults.push(`${label} — not exactly half, but the copy claims half with no qualifier`);
        }
      }
    }
  }
  return faults;
}


// -- The annual saving, against the seed's own ladder -------------------------
//
// `pricing.faq.annual.a` and `billing.annualSaves` both said "annual billing
// saves 30%", in all four locales, on two live surfaces. After the charm
// reprice no currency saves 30%, and no SINGLE percentage can be right,
// because the seed prices each market independently:
//
//   base tier   usd 28.29%   eur 30.08%   gbp 32.52%   inr 30.45%
//   rider tier  usd 23.71%   eur 24.89%   gbp 26.54%   inr 30.35%
//
// A global percentage is therefore not a stale number to re-cut; it is the
// wrong SHAPE of claim, and re-cutting it would put the next reprice straight
// back here. The copy states a FLOOR instead -- "a year up front costs less
// than ten monthly payments in every currency we bill in, so annual is more
// than two months free" -- which is true at all eight price points with room,
// survives a per-market reprice, and errs towards the customer.
//
// The rider tier is in scope because a subscription can hold several
// organisations on one bill (`pricing.faq.groups.a`), so a reader on the
// /pricing FAQ may be buying either rung, and the claim has to hold for what
// they actually pay.

/** One place the annual claim can be checked: a currency on a graduated tier. */
export interface AnnualPricePoint {
  lookupKey: string;
  /** "base" (the first organisation) or "rider" (each one after it). */
  tier: string;
  currency: string;
  monthly: number;
  annual: number;
  /** How many MONTHLY payments a year up front costs. */
  monthsPaid: number;
}

/**
 * Every monthly/annual pair in the seed, per currency AND per graduated tier.
 *
 * Anchored on the tiers rather than the headline amounts, because a claim made
 * about "annual billing" is made to everyone who can buy annually, and the
 * rider rung saves visibly less than the base one -- which is the whole reason
 * a single percentage cannot be true.
 */
export function annualPricePoints(plans: PricedPlan[]): AnnualPricePoint[] {
  const points: AnnualPricePoint[] = [];
  for (const plan of plans) {
    const monthlyPrice = plan.prices.monthly;
    const annualPrice = plan.prices.annual;
    if (!monthlyPrice || !annualPrice) continue;
    for (const [tier, upTo] of [
      ["base", 1],
      ["rider", "inf"],
    ] as const) {
      const m = monthlyPrice.tiers?.find((t) => t.up_to === upTo);
      const a = annualPrice.tiers?.find((t) => t.up_to === upTo);
      if (!m || !a) continue;
      for (const currency of SEED_CURRENCIES) {
        const monthly = amountIn(m, currency);
        const annual = amountIn(a, currency);
        if (monthly === undefined || annual === undefined || monthly <= 0) continue;
        points.push({
          lookupKey: annualPrice.lookup_key,
          tier,
          currency,
          monthly,
          annual,
          monthsPaid: annual / monthly,
        });
      }
    }
  }
  return points;
}

/**
 * The published floor against every price point, in BOTH directions.
 *
 * `monthsFree` is the claim the copy makes, and it is a floor: a year must cost
 * at most `12 - monthsFree` monthly payments EVERYWHERE, or the claim
 * overpromises in some market -- the failure mode "saves 30%" already had.
 *
 * `staleBeyond` is the loose side, and it is loose on purpose. A floor cannot
 * become false by a price moving in the customer's favour, so nothing would
 * ever red if a reprice doubled the discount and left the copy underselling it
 * by a year. The bound sits far enough out (five months, against a live spread
 * of 2.8-3.9) that an ordinary re-cut does not trip it, and close enough that a
 * claim which has stopped describing the product does.
 */
export function annualSavingFaults(
  points: readonly AnnualPricePoint[],
  claim: { monthsFree: number; staleBeyond: number },
): string[] {
  if (points.length === 0) {
    return ["annual saving: no monthly/annual price points at all — this check would pass vacuously"];
  }
  if (claim.staleBeyond <= claim.monthsFree) {
    return [
      `annual saving: staleBeyond (${claim.staleBeyond}) must exceed monthsFree (${claim.monthsFree}), or the two bounds cross and every point faults`,
    ];
  }
  const faults: string[] = [];
  for (const p of points) {
    const where = `${p.lookupKey} ${p.currency} (${p.tier}): ${p.annual} a year against ${p.monthly} a month`;
    const free = 12 - p.monthsPaid;
    if (free < claim.monthsFree) {
      faults.push(
        `${where} — ${free.toFixed(2)} months free, but the copy promises more than ${claim.monthsFree}`,
      );
    } else if (free > claim.staleBeyond) {
      faults.push(
        `${where} — ${free.toFixed(2)} months free, far beyond the ${claim.monthsFree} the copy claims: the floor has stopped describing the product and should be re-cut`,
      );
    }
  }
  return faults;
}

/**
 * How each locale states the annual claim.
 *
 * Three parts per language, all required, because a presence rule on one word
 * is satisfied by copy that says the opposite: this module's own header records
 * a "must mention add-ons" gate passing on "the add-ons you've bought STOP
 * COUNTING". The numeral, the unit and the giveaway together cannot be
 * satisfied by an accident.
 *
 * The numerals are WORDS, not digits, and that is load-bearing: the paired
 * negative in `dictionary-copy-truth.test.ts` bans a bare percentage from these
 * values, and a digit vocabulary here would make the two rules argue.
 */
export const ANNUAL_SAVING_CLAIM: Record<
  string,
  { numeral: RegExp; unit: RegExp; giveaway: RegExp }
> = {
  en: { numeral: /\btwo\b/i, unit: /\bmonths?\b/i, giveaway: /\bfree\b/i },
  es: { numeral: /\bdos\b/i, unit: /\bmeses\b/i, giveaway: /\bgratis\b/i },
  fr: { numeral: /\bdeux\b/i, unit: /\bmois\b/i, giveaway: /\bofferts?\b/i },
  nl: { numeral: /\btwee\b/i, unit: /\bmaanden\b/i, giveaway: /\bgratis\b/i },
};

/** A locale value that fails to state the annual claim, part by part, so the
 *  fault names WHICH half of the sentence went missing. */
export function annualClaimFaults(values: readonly LocalisedValue[]): string[] {
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    const claim = ANNUAL_SAVING_CLAIM[locale];
    if (!claim) {
      faults.push(`${locale}/${key}: no annual claim vocabulary for this locale`);
      continue;
    }
    if (!value) {
      faults.push(`${locale}/${key}: missing`);
      continue;
    }
    for (const [part, pattern] of Object.entries(claim)) {
      if (!pattern.test(value)) {
        faults.push(`${locale}/${key}: states no ${part} — "${value}"`);
      }
    }
  }
  return faults;
}

/** A standalone extra-organisation add-on price, as `org_addons` holds it. */
export interface OrgAddon {
  key: string;
  plan_key: string;
  product?: { name?: string; description?: string };
  price: { lookup_key: string; unit_amount: number; currency_options?: Record<string, number> };
}

/**
 * `riderRateFaults` pins the "no more than half" claim to the GRADUATED TIERS
 * only. The same money is also charged through `org_addons` (v17 #293 — buy a
 * slot instead of changing plan), and nothing pinned the two together: all ten
 * amounts agree today, so the copy holds, but an add-on price could drift over
 * half the base with that guard still green and the sentence still on the page.
 *
 * Parity is the right rule rather than a second half-the-base comparison: the
 * add-on and the rider are two ways of billing one thing, so they must be the
 * same number, and equality then carries `riderRateFaults`'s ≤-half verdict
 * across to the add-on for free.
 *
 * Checked in BOTH directions. A missing add-on for a plan that has a rider is a
 * fault too — otherwise deleting the `org_addons` section would make this guard
 * examine nothing and report clean, which is exactly how #293 escaped the
 * sibling seed guard's hand-written section list for a whole wave.
 */
export function orgAddonRiderFaults(plans: PricedPlan[], addons: OrgAddon[]): string[] {
  const faults: string[] = [];
  const byKey = new Map(plans.map((p) => [p.key, p]));
  const pinned = new Set<string>();

  for (const addon of addons) {
    const plan = byKey.get(addon.plan_key);
    if (!plan) {
      faults.push(`${addon.key}: plan_key "${addon.plan_key}" matches no plan in the seed`);
      continue;
    }
    const monthly = plan.prices.monthly;
    const rider = monthly?.tiers?.find((t) => t.up_to === "inf");
    if (!monthly || !rider) {
      faults.push(`${addon.key}: ${addon.plan_key} has no graduated monthly rider to compare against`);
      continue;
    }
    pinned.add(plan.key);
    for (const currency of SEED_CURRENCIES) {
      const addonAmount = amountIn(addon.price, currency);
      const riderAmount = amountIn(rider, currency);
      if (addonAmount === undefined || riderAmount === undefined) {
        faults.push(
          `${addon.key} ${currency}: no price point on ${addonAmount === undefined ? "the add-on" : `${monthly.lookup_key}'s rider`}`,
        );
        continue;
      }
      if (addonAmount !== riderAmount) {
        faults.push(
          `${addon.key} ${currency}: add-on charges ${addonAmount} but ${monthly.lookup_key}'s rider is ${riderAmount} — the "no more than half" copy is pinned to the rider only`,
        );
      }
    }

    // …and the add-on's OWN customer-facing strings must not make the rate
    // claim the arithmetic does not support. The seed rounds the rider DOWN in
    // usd (1900 -> 900 = 47.4%) while eur/aud land on exact halves, so "half
    // the base rate" UNQUALIFIED is false in most currencies — only "no more
    // than half" holds everywhere. Nothing read these strings until fix round
    // 6, and a probe that put exactly that claim in the Checkout line-item
    // label ("Seazn Club Extra Organisation — Pro, half the base rate") shipped
    // 216 passed / 0 failed.
    const addonText = [addon.product?.name, addon.product?.description].filter(Boolean).join(" | ");
    const addonClaim = riderClaimIn(addonText);
    if (addonClaim === "exactly" || addonClaim === "under") {
      faults.push(
        `${addon.key}: its product copy claims the rider is ${addonClaim === "under" ? "UNDER" : "exactly"} half the base rate, but only "no more than half" is true in every currency`,
      );
    }
  }

  for (const plan of plans) {
    if (plan.prices.monthly?.tiers?.some((t) => t.up_to === "inf") && !pinned.has(plan.key)) {
      faults.push(
        `${plan.key}: charges a graduated extra-organisation rider but no org_addons entry pins it to the copy`,
      );
    }
  }
  return faults;
}

// ── Quantities written into a product NAME ───────────────────────────────────

/**
 * A seed product whose NAME quotes a quantity the seed itself holds one field
 * away — "Seazn Club AI Credits — 40" beside `credits: 40`, "Seazn Club Size
 * Pack — +32 entrants" beside `delta_each: 32`.
 */
export interface QuantifiedProduct {
  key: string;
  name: string;
  /** the seed field the figure is supposed to be, named for the fault label. */
  field: string;
  quantity: number;
}

/**
 * A quantity in a product NAME must be the seed's own quantity.
 *
 * These names are not decoration. Checkout renders the product's name as the
 * line-item label (`credit-packs.ts` / `size-packs.ts` both send
 * `line_items: [{ price }]`, so the label comes off the product), so "AI
 * Credits — 4000" beside a `credits: 40` grant is a 100x claim on the payment
 * page itself — and `stripe-sync.ts` pushes it to the shared test-mode account
 * on every PR. Nothing read a product name before fix round 6.
 *
 * TWO rules, because either alone has an obvious hole:
 *  - the seed's own figure must be there as a WHOLE TOKEN (`toContain("40")` is
 *    satisfied by "4000" — see `wholeNumber`);
 *  - and NO OTHER figure may be, or the honest number can simply be joined by a
 *    fictional one ("AI Credits — 40 (4000 with Pro)").
 *
 * ANTI-VACUITY is the caller's job in one respect this function cannot cover —
 * an empty `products` array returns `[]` — so `describedNameFaults` below pairs
 * with it: it makes a MISSING name a fault, so a section cannot quietly stop
 * being scanned by losing the field this rule reads.
 */
export function productNameQuantityFaults(products: QuantifiedProduct[]): string[] {
  const faults: string[] = [];
  for (const { key, name, field, quantity } of products) {
    if (!wholeNumber(quantity).test(name)) {
      faults.push(`${key}: product name "${name}" does not quote its ${field} (${quantity})`);
    }
    for (const match of name.matchAll(/\d[\d,]*/g)) {
      const found = Number(match[0].replace(/,/g, ""));
      if (found !== quantity) {
        faults.push(`${key}: product name quotes ${found}, but ${field} is ${quantity}`);
      }
    }
  }
  return faults;
}

/** Every seed entry that carries a description must carry a NAME too.
 *
 *  `stripe-sync.ts` sends `name` on every run, so an entry without one is a
 *  product with no Checkout label — and, more to the point here, an entry that
 *  every name-reading rule above would silently skip. Making absence a fault is
 *  what stops "the guard covers this section" decaying into "the guard finds
 *  nothing to look at in this section". */
export function describedNameFaults(entries: DescribedEntry[]): string[] {
  return entries
    .filter((e) => e.name.trim().length === 0)
    .map((e) => `${e.section}/${e.key}: has a product.description but no product.name`);
}

// ── Help-article prose ───────────────────────────────────────────────────────
//
// The same falsehoods this module was written for are also on the help pages,
// and prose needs shaping before a claim vocabulary can be pointed at it:
//
//  - FRONTMATTER IS NOT BODY COPY. `plans.md`'s `description:` covers all four
//    plans at once and truthfully says Community is "free forever" — scanning it
//    as pass copy would red on a true sentence. It is stripped, deliberately, so
//    a frontmatter claim is out of scope here rather than silently covered.
//  - LINK TARGETS ARE NOT PROSE. `#the-platform-fee-on-entry-fees` reads as a
//    sentence about fees to any regex; links are reduced to their text.
//  - EMPHASIS BREAKS SENTENCES. `**…first paid entry** the fee is **locked**`
//    splits wrongly on `.` inside `**`, which matters because the fee-lock rule
//    below is deliberately SENTENCE-scoped.
//
// These regexes are English-only. That is correct today — `content/help/**` is a
// single English tree (`HELP_ROOT`, no locale segment, and /help is not nested
// under /[lang]) — but it is an assumption, not a property: if the help tree
// ever gains locales, every rule here silently stops covering them.

/** Strip YAML frontmatter. See the note above on why it is out of scope. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/** Markdown reduced to the words a reader actually reads. */
export function plainProse(markdown: string): string {
  return markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]+/g, "");
}

/**
 * The article split at the granularity a claim is made and qualified at: a
 * paragraph, a list item, or a table row.
 *
 * Blank lines alone are too coarse — `event-pass.md`'s fine print is one block
 * of eleven bullets, and a qualifier in bullet 3 would then answer for the claim
 * in bullet 8. That is the "wrong clause in the same sentence" defeat one level
 * up, and it is why every rule below scopes to a block rather than the file.
 */
export function proseBlocks(markdown: string): string[] {
  return claimSurfaces(markdown)
    .filter((surface) => surface.kind === "prose")
    .map((surface) => surface.text);
}

/** Where in an article a claim can be made. */
export type ClaimSurfaceKind = "frontmatter" | "heading" | "prose";

export interface ClaimSurface {
  kind: ClaimSurfaceKind;
  /** The frontmatter key, for a `frontmatter` surface. */
  field?: string;
  /** The words a reader actually reads, normalised like a prose block. */
  text: string;
}

/**
 * EVERY user-visible surface of an article, not just its paragraphs.
 *
 * ── WHY THIS EXISTS (fix round 3) ────────────────────────────────────────────
 * `proseBlocks` strips frontmatter and filters headings, so until now EVERY rule
 * in this module was blind to both — while `_approved-copy.ts` claimed to pin
 * "the WHOLE article". A reviewer put the wave's two flagship falsehoods into a
 * heading and into `description:` and the suite stayed 42/0. Measured delivery
 * rates: 0/36 through a heading, 0/24 through frontmatter, against 12/12 for the
 * same sentences as paragraphs.
 *
 * Neither surface is decorative. `app/help/[...slug]/page.tsx` renders
 * `description` as the LEAD PARAGRAPH under the title and emits it as page
 * metadata, and `help-search.tsx` shows it as the search-result snippet — so a
 * false `description` is the first sentence a reader sees and the one they see
 * before they even open the page. Headings are read by everyone who skims.
 *
 * `proseBlocks` keeps its old contract (prose only) by being DERIVED from this,
 * so the two cannot drift apart the way the comment and the code just did.
 *
 * Frontmatter fields are included unless their value is purely numeric (`order:
 * 3`), which is deliberately inclusive: a field added later is covered by
 * default, and covering it costs one deliberate re-approval rather than a silent
 * hole.
 */
export function claimSurfaces(markdown: string): ClaimSurface[] {
  const surfaces: ClaimSurface[] = [];
  const normalise = (text: string): string => plainProse(text).replace(/\s+/g, " ").trim();

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (frontmatter) {
    for (const line of frontmatter[1]!.split(/\r?\n/)) {
      const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!field) continue;
      const value = field[2]!.trim().replace(/^["']|["']$/g, "");
      if (value.length === 0 || /^\d+(?:\.\d+)?$/.test(value)) continue;
      surfaces.push({ kind: "frontmatter", field: field[1]!, text: normalise(value) });
    }
  }

  for (const block of stripFrontmatter(markdown).split(/\n{2,}/)) {
    for (const piece of block
      .split(/\n(?=\s*#{1,6}\s)/)
      .flatMap((part) => part.split(/\n(?=\s*(?:[-*+]\s|\|))/))) {
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(piece);
      const text = normalise(heading ? heading[1]! : piece);
      if (text.length === 0) continue;
      surfaces.push({ kind: heading ? "heading" : "prose", text });
    }
  }
  return surfaces;
}

/**
 * The surfaces the SENTENCE-level rules read: prose and frontmatter.
 *
 * Headings are deliberately NOT here, and this is a limit rather than an
 * oversight: a heading is a fragment, so sentence-shaped rules mis-read it
 * ("When a pass stops applying" is a true heading that no approved form fits).
 * Headings are covered by the inventory gate, which does not read them.
 */
export function claimTexts(markdown: string): string[] {
  return claimSurfaces(markdown)
    .filter((surface) => surface.kind !== "heading")
    .map((surface) => surface.text);
}

/** Sentences of a block, after `plainProse` has made `.` mean what it says. */
export function sentences(block: string): string[] {
  return block.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/** A `## Heading` section's body, or null if the heading is gone. Null is a
 *  fault at the call site, never a silent empty scan. */
export function markdownSection(markdown: string, heading: RegExp): string | null {
  const lines = stripFrontmatter(markdown).split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// ── The entry-fee rate lock (V312, db/migration/deltas/V316__competition_fee_lock.sql)
//
// `effectiveFeePercentFor` (server/usecases/registrations.ts) reads
// `competitions.fee_percent ?? feePercentFor(org)`: once a competition has taken
// a paid entry its rate is STAMPED and every later entry pays that same rate,
// immune to a plan change, a group detach, a downgrade — or an Event Pass
// expiring. The help tree said the opposite, twice, in the two places a reader
// looks when their pass is ending.
//
// Note the fee's own vocabulary is bounded by sentence punctuation on both
// sides: "…entry fees? No — every plan can charge entry fees" is two claims, not
// one, and a window that crossed the `?` would read them as one.

// A bare percentage is a fee subject here: "Community's 8% applies again to
// every later entrant" makes the whole claim without using the word "fee", and
// was measured green before this alternative existed. Precision comes from the
// reversion VERB, which no honest sentence in these articles pairs with a rate.
const FEE_SUBJECT = String.raw`(?:platform\s+fees?|entry[-\s]fee\s+rate|fee\s+rate|fee\s+percentage|\bfees?\b|(?:plan|we|platform)\s+charges?\b|\bcharged\b|\bpricing\b|\d+(?:\.\d+)?\s*%)`;
const FEE_REVERSION_VERB = String.raw`(?:returns?|reverts?|goes?\s+back|went\s+back|drops?\s+back|falls?\s+back|switch(?:es)?\s+back|rises?|climbs?|jumps?|resets?|moves?|applies\s+again|is\s+restored)`;

/** "…and the platform fee returns to your plan's rate" — the claim, not the
 *  sentence, in either word order. */
export const FEE_REVERSION_PATTERNS = [
  new RegExp(`${FEE_SUBJECT}[^.;:!?]{0,80}\\b${FEE_REVERSION_VERB}\\b`, "i"),
  new RegExp(`\\b${FEE_REVERSION_VERB}\\b[^.;:!?]{0,80}${FEE_SUBJECT}`, "i"),
];

const FEE_LOCK_WORD = String.raw`(?:locked|locks|lock|fixed|frozen|pinned|stays?\s+at|does\s+not\s+(?:rise|change|move))`;
// `card` is optional-but-recognised throughout: the trigger is the first paid
// CARD entry (an offline entry carries no rate and leaves the competition
// unlocked — see the comment above the stamp in registrations.ts), so copy that
// says so precisely must satisfy this, not fall through it.
const PAID_ENTRY_TRIGGER = String.raw`(?:first\s+(?:paid\s+)?(?:card\s+)?(?:entry|entrant|registration|payment|payer)|(?:already\s+)?(?:taken|took|had|has\s+had)\s+(?:a|its|the)\s+(?:first\s+)?paid\s+(?:card\s+)?(?:entry|registration)|no\s+paid\s+(?:card\s+)?(?:entry|entrant)|never\s+took\s+a\s+paid\s+(?:card\s+)?(?:entry|entrant))`;

/**
 * Does this block state the lock — a fee subject, a lock word AND the trigger
 * that fires it, all in ONE SENTENCE?
 *
 * All three, together, because each pair alone is satisfiable by the wrong
 * clause: "your refund lock date" plus "every paid entry" two sentences apart
 * would otherwise read as a statement about the platform fee, and a lock with no
 * trigger tells a reader nothing about whether their own competition is locked.
 */
export function statesFeeLock(block: string): boolean {
  const subject = new RegExp(FEE_SUBJECT, "i");
  const lock = new RegExp(FEE_LOCK_WORD, "i");
  const trigger = new RegExp(PAID_ENTRY_TRIGGER, "i");
  return sentences(block).some((s) => subject.test(s) && lock.test(s) && trigger.test(s));
}

/**
 * ── THE SHAPE FIX (fix round 1) ──────────────────────────────────────────────
 *
 * Round 1 of this rule detected the CLAIM by its verb — "the fee RETURNS to your
 * plan's rate" — and required the qualifier somewhere in the same block. Both
 * halves were defeated at once by a reviewer who simply ADDED a false sentence
 * and kept the true one:
 *
 *   "After the event closes, later entrants are charged 8% again, and the 5%
 *    you were enjoying no longer applies."
 *
 * The verb list had no "charged … again" and no "no longer applies", so the
 * claim was never detected; and even had it been, the true sentence elsewhere in
 * the block would have excused it. Measured detection rate: 1 in 12 rewordings.
 *
 * A verb list is an open set — there is no end to the ways English says "goes
 * back up" — so this now detects the TOPIC instead, which is closed: a sentence
 * is about the rate after the pass if it names a RATE and names the pass ENDING.
 * You cannot make the false claim without doing both. Whatever such a sentence
 * says, it must carry the lock ITSELF.
 *
 * Two granularity rules follow from the same defeat:
 *  - the claim and its excuse must be the SAME SENTENCE. A true qualifier
 *    elsewhere in the block excused a false claim beside it (measured).
 *  - `feeLockStatedFaults` stays, because a topic rule is vacuous on an article
 *    that never raises the topic.
 */
export const RATE_MENTION = new RegExp(FEE_SUBJECT, "i");
export const PASS_ENDING_MENTION =
  /\b(after|once|when)\b[^.;:!?]*\b(ends?|ended|ending|closes?|closed|finish\w*|over|expir\w*|stops?|stopped|lapses?|archiv\w*|completed?)\b|(?:\b(?:revok\w+|refund\w*|chargeback)\b[^.;:!?]*\bpass\b|\bpass\b[^.;:!?]*\b(?:revok\w+|refund\w*|chargeback)\b)|\b(no\s+longer|later\s+entrants?|downgrad\w+|when\s+the\s+pass|after\s+the\s+pass|after\s+(?:that|then|it)|pass\s+(?:ends?|stops?|expires?|lapses?|does))\b/i;

/** Is this sentence about the entry-fee rate once the pass is no longer in
 *  force? Either by TOPIC (a rate plus an ending) or by the round-1 verb list,
 *  which still catches "the platform fee returns to your plan's rate" in a
 *  clause with no ending word of its own. Union, not replacement: the verb list
 *  was too narrow to be the only detector, not wrong. */
export function mentionsRateAfterPass(sentence: string): boolean {
  if (FEE_REVERSION_PATTERNS.some((p) => p.test(sentence))) return true;
  return RATE_MENTION.test(sentence) && PASS_ENDING_MENTION.test(sentence);
}

/**
 * Every sentence about the entry-fee rate AFTER a pass ends must state the lock.
 *
 * The topic is deliberately high-recall and the requirement precise — the
 * inverse of round 1, which had a precise claim detector and a loose excuse.
 */
export function unqualifiedFeeReversionFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      if (!mentionsRateAfterPass(sentence)) continue;
      if (statesFeeLock(sentence)) continue;
      faults.push(
        `${label}: "${sentence.slice(0, 72)}…" talks about the entry-fee rate after the pass ends without stating the first-paid-entry lock (V312)`,
      );
    }
  }
  return faults;
}

/**
 * CRITICAL 2, fix round 1 — a falsehood this task's own round-1 copy shipped.
 *
 * The locked rate is NOT a constant. `registrations.ts` is the only writer of
 * `competitions.fee_percent`, its `where … and fee_percent is null` makes it
 * first-wins, and `lockRate = chargedFeePercent ?? reg.fee_percent` records what
 * the first paid CARD entry was actually billed (offline entries carry no rate
 * and leave the competition unlocked). So a competition that took a paid entry
 * BEFORE its pass was bought is locked at the pre-pass rate, and the pass cannot
 * lower it. Round 1 wrote "a late entrant pays the same 5% as the first one",
 * which is true only of the case it happened to have in mind.
 *
 * FIX ROUND 2 — the rule fired only on a literal `\d+\s*%`, which is one way of
 * naming a rate out of several. Measured misses: "drops to THE PASS RATE for
 * every remaining entry" and "stays at THE EVENT PASS RATE" name it by brand,
 * and "five per cent" spells it out. All three make exactly the claim the digit
 * version makes.
 *
 * So the detector is now "names a PARTICULAR rate" — a figure, a spelled-out
 * figure, or a branded one — and the verdict flips to an allowlist: a sentence
 * that says a particular rate persists must ALSO name the condition that decides
 * it, the first paid card entry. That condition is the whole content of the
 * rule; a sentence without it is asserting the rate is a constant, which it is
 * not.
 */
// NOTE the missing `\b` after `%`: a word boundary needs a word character on
// one side, and `% ` has none — `/\b5\s*%\b/` can never match "5% as". That is
// how the first draft of this rule returned no fault for the very sentence it
// was written against.
export const NAMES_A_PARTICULAR_RATE =
  /\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*per\s*cent\b|\b\d+(?:\.\d+)?\s*percent\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+per\s*cent\b|\b(?:the\s+)?(?:Event\s+)?pass(?:'s|’s)?\s+(?:own\s+|cheaper\s+|discounted\s+)?(?:rate|fee|percentage)\b|\b(?:cheaper|discounted)\s+rate\b/i;

export function lockedRateConstantFaults(label: string, passProse: string): string[] {
  const faults: string[] = [];
  const lock = new RegExp(FEE_LOCK_WORD, "i");
  const persists =
    /\b(stays?|remains?|keeps?|rides?|goes?\s+on|carries?\s+on|drops?\s+to|falls?\s+to|pays?|charged|applies)\b/i;
  // NOT merely "a first paid entry is mentioned": round 1's falsehood said
  // "Once a competition has taken its first paid entry … a late entrant pays the
  // same 5% as the first one" — it named the trigger and still asserted a
  // constant. What licenses naming a rate is the condition that the first entry
  // was taken WHILE THE PASS WAS LIVE, which is the only case where the pass's
  // own rate is the one locked in.
  const condition =
    /\bfirst\s+(?:paid\s+)?(?:card\s+)?(?:entry|entrant|payment)\b[^.;:!?]*\b(?:while|before|after|during)\b[^.;:!?]*\bpass\b/i;
  for (const block of claimTexts(passProse)) {
    for (const sentence of sentences(block)) {
      if (!NAMES_A_PARTICULAR_RATE.test(sentence)) continue;
      if (!lock.test(sentence) && !persists.test(sentence)) continue;
      if (condition.test(sentence)) continue;
      faults.push(
        `${label}: "${sentence.slice(0, 88)}" says a particular rate carries on without naming what decides it. The locked rate is whatever the FIRST PAID CARD ENTRY was charged — for a competition that already had one, that is the PRE-PASS rate, and the pass cannot lower it.`,
      );
    }
  }
  return faults;
}

/**
 * POSITIVE half, and the reason the negative above is not enough on its own:
 * deleting every mention of the fee would satisfy it perfectly while telling an
 * organiser nothing about the rate their entrants will be charged after the pass
 * ends. Absence proves "not false", never "still stated".
 */
export function feeLockStatedFaults(label: string, markdown: string): string[] {
  return claimTexts(markdown).some(statesFeeLock)
    ? []
    : [`${label}: never states that the entry-fee rate locks at the first paid entry (V312)`];
}

/**
 * The retired-cap scan, sentence by sentence, with two exemptions the seed does
 * not need: prose is allowed to say the cap is GONE, and prose is allowed to
 * state the genuinely live HOURLY rate limit.
 *
 * `retiredRunCapFaults` bans the vocabulary outright, which is right for a
 * product description — nothing there ever needs to mention a dead feature. An
 * article does: "there is no per-division run cap any more" is an accurate,
 * useful sentence for a reader who remembers the old limits, and round 1 forced
 * it out of `plans.md`. A guard that bans true sentences gets worked around.
 *
 * The first exemption is deliberately narrow: the denial must be in the SAME
 * sentence and the sentence must quote NO NUMBER. "There is no per-division run
 * cap; each division gets 5" is two sentences and reds on the second, and "no
 * cap beyond 20 runs a division" reds on its own digit.
 *
 * The second exemption (#303) is for the OTHER live number:
 * `rateLimit('ai-plan:'+divisionId, {max:5, windowSeconds:3600})` in
 * `schedule-ai.ts` (and its officials twin in `officials-ai.ts`) is a genuine,
 * still-enforced BURST BRAKE — "5 AI runs an hour per division" — and its shape
 * ("<n> runs … per division") is indistinguishable from the retired LIFETIME
 * cap to `RETIRED_AI_RUN_CAP_PATTERNS`, which was written before this rate
 * limit existed as a separate, undocumented mechanism. Scoped to "hour" only
 * (not day/week/month, which name no real mechanism): a sentence naming an
 * hourly window is describing the rate limit, not the retired lifetime table.
 * This is narrow enough that a compound sentence asserting BOTH a true hourly
 * window AND a fictitious lifetime count in the same breath could still slip
 * through — accepted, because splitting that hybrid claim into one sentence
 * each is the far more natural way to write it, and the anti-vacuity corpus
 * below still requires the base pattern to fire on a true positive.
 */
export function retiredRunCapProseFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  const denial = /\b(no|not|never|without|isn'?t|aren'?t|dropped|retired|removed|gone|scrapped)\b/i;
  const hourlyRateLimit = /\b(?:an?|per|every)\s+hour\b|\bhourly\b/i;
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      const hits = retiredRunCapFaults(sentence);
      if (hits.length === 0) continue;
      if (denial.test(sentence) && !/\d/.test(sentence)) continue;
      if (hourlyRateLimit.test(sentence)) continue;
      faults.push(...hits.map((h) => `${label}: "${sentence.slice(0, 72)}…" ${h}`));
    }
  }
  return faults;
}

/**
 * v17 gap #303: `content/help/scheduling/ai-scheduling.md` said "Officials AI
 * runs are not metered — once you have automatic officials assignment, you can
 * restaff as often as you like." That is false on every tier: both AI phases
 * spend the SAME shared credit wallet, one credit per run, reserved-then-settled
 * by the identical `spendCredit(walletId, orgId, 1, …)` call in
 * `schedule-ai.ts:aiPlanForDivision` and `officials-ai.ts:officialsAiPlanForDivision`
 * (SPEC-2 §5.2) — including the no-instruction default spread, which makes no
 * model call but still runs through `spendCredit` and is settled on success.
 *
 * The claim family is "an AI run costs nothing / has no limit", independent of
 * which phase it names — a reworded falsehood about schedule runs would be
 * exactly as false. Denial-of-the-CAP prose ("there is no per-division cap any
 * more") is a different, TRUE claim and must not trip this: the vocabulary here
 * is scoped to UNMETERED/FREE/UNCAPPED, not to the retired count itself (that is
 * `RETIRED_AI_RUN_CAP_PATTERNS`, a sibling rule).
 */
export const AI_RUN_UNMETERED_PATTERNS = [
  /\bnot\s+metered\b/i,
  /\bunmetered\b/i,
  /\brestaff\s+as\s+often\s+as\s+you\s+like\b/i,
  /\brun\s+it\s+as\s+often\s+as\s+you\s+like\b/i,
  /\b(?:as\s+often\s+as\s+you\s+(?:like|want|wish))\b[^.;]{0,20}\bno\s+(?:cost|charge)\b/i,
  /\b(?:officials?|schedul\w*)\s+(?:AI\s+)?(?:runs?|generations?|passes?)\s+(?:are|is)\s+free\b/i,
  /\bcosts?\s+nothing\s+to\s+(?:run|restaff|regenerate)\b/i,
  /\buncapped\b[^.;]{0,20}\b(?:runs?|generations?|passes?)\b|\b(?:runs?|generations?|passes?)\b[^.;]{0,20}\buncapped\b/i,
];

/** The positive pairing: an article that raises this claim family must also
 *  SAY the run is metered by the credit wallet — deleting the whole paragraph
 *  would otherwise satisfy the negative half for free. */
export function unmeteredAiRunProseFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      for (const pattern of AI_RUN_UNMETERED_PATTERNS) {
        if (pattern.test(sentence)) {
          faults.push(
            `${label}: "${sentence.slice(0, 72)}…" claims an AI run is unmetered/free — every run, schedule or officials, on any plan, spends one AI credit (SPEC-2 §5.2)`,
          );
        }
      }
    }
  }
  return faults;
}

/**
 * The precondition for BOTH joint-undo pattern families below: the sentence has
 * to be about undoing something. Without it the patterns read as claims about
 * anything plural, and two TRUE sentences in `ai-scheduling.md` fired — the
 * batch discount ("scheduling divisions together is never a worse deal than
 * scheduling them one at a time") and the apply's own atomicity ("Applying
 * writes every division together"). Exported because the module-wide
 * anti-vacuity walk in `dictionary-copy-truth.test.ts` only sees exports.
 */
export const JOINT_UNDO_SUBJECT =
  /\b(?:undo|undoes|undone|restor\w+|rewinds?|rewound|reverts?|reverses?|rolls?\s+back|rolled\s+back|puts?\s+[^.;]{0,30}back|putting\s+[^.;]{0,30}back)\b/i;

/**
 * A joint apply is ATOMIC; the joint undo is not (#386, #392).
 *
 * `ai-scheduling.md` once said a joint apply gives *"each division its own
 * before-AI save point, so one undo puts the whole thing back."* That was false
 * and was corrected. Nothing stopped it coming back, and after #386 the shape of
 * the mechanism moved TOWARDS the false sentence without reaching it: the undo
 * is now one competition-scoped call
 * (`POST /competitions/{id}/schedule/restore`, driven by
 * `components/v2/board/ai-joint-apply.ts:undoJointApply`) that rewinds every
 * division the apply wrote, in sorted order, under one lock — so it can no
 * longer be abandoned half-way by a closed tab. It still reports per-division
 * failures rather than rolling the successes back. One request is not one
 * outcome, and an editor reading the changelog is exactly who would write that
 * it is.
 *
 * This is the one help claim on this surface about whether the organiser's work
 * survives a failure, which is the claim they will act on: told the undo is
 * all-or-nothing, an organiser who sees it fail assumes the board is untouched
 * and does nothing, when in fact some divisions went back and some did not.
 *
 * SCOPE: joint-scheduling copy only. A single-division undo genuinely does put
 * everything back in one step, `scheduling/undo.md` says so, and that sentence
 * must stay writable — a guard that bans a true sentence gets worked around
 * rather than obeyed. Every pattern therefore requires a PLURAL/collective
 * object ("every division", "the whole apply", "both"), never a bare "undo puts
 * everything back".
 */
export const FALSE_JOINT_UNDO_PATTERNS = [
  /\b(one|a\s+single|1)\s+(undo|click|step|restore)\b[^.;]{0,60}\b(all|every|whole|entire|both)\b/i,
  /\b(all|every|whole|entire|both)\s+(the\s+)?divisions?\b[^.;]{0,40}\b(at\s+once|in\s+one\s+(go|step|click))\b/i,
  /\b(all|every|whole|entire|both)\s+(the\s+)?divisions?\b[^.;]{0,40}\b(is|are)\s+(put|rolled|rewound|restored)\s+back\b[^.;]{0,20}\b(at\s+once|in\s+one\s+(go|step|click))\b/i,
  /\bundo\b[^.;]{0,40}\b(the\s+)?(whole|entire)\s+(thing|apply|run|schedule)\b/i,
  /\b(rolls?|reverses?|undoes)\s+(back\s+)?(the\s+)?(whole|entire)\s+(joint\s+)?(apply|run|schedule|thing)\b/i,
];

/**
 * The mirror falsehood, and the one that is live rather than historical (#386).
 *
 * Before #386 the joint undo WAS a browser loop over per-division restores, and
 * `ai-scheduling.md` described it as one — "undo restores them one at a time
 * rather than in a single step". That is now wrong: `undoJointApply` makes one
 * call, and the server rewinds every division under one competition lock.
 *
 * It fails in the same direction as the all-or-nothing claim: an organiser told
 * the undo runs division by division reads a half-restored board as the expected
 * outcome of a normal undo, rather than as the thing the console is naming for
 * them to retry.
 *
 * Every pattern requires the word "division" in the sentence, which is what
 * keeps `scheduling/undo.md`'s TRUE per-change prose ("Restore rewinds the
 * schedule … by undoing each change since, one by one") out of scope: that
 * sentence is about changes, not divisions.
 */
export const RETIRED_JOINT_UNDO_LOOP_PATTERNS = [
  /\bdivisions?\b[^.;]{0,80}\bone\s+(at\s+a\s+time|by\s+one)\b/i,
  /\bone\s+(at\s+a\s+time|by\s+one)\b[^.;]{0,80}\bdivisions?\b/i,
  /\b(one|a\s+separate|its\s+own|their\s+own)\s+(restore|undo|call|request)\s+(per|for\s+each)\s+divisions?\b/i,
  /\b(separate|individual)\s+(restores?|undos?|calls?|requests?)\b[^.;]{0,40}\b(per|for\s+each|one\s+per)\s+divisions?\b/i,
  /\b(restores?|undoes|rewinds?)\b[^.;]{0,40}\b(each|every)\s+divisions?\b[^.;]{0,40}\bin\s+turn\b/i,
];

/**
 * Joint-undo scan, sentence-scoped like {@link retiredRunCapProseFaults}.
 *
 * Reads `claimSurfaces` rather than `claimTexts`, i.e. HEADINGS TOO — the one
 * place this rule departs from its siblings. `claimSurfaces`' own header records
 * why: a reviewer put a wave's flagship falsehoods into a heading and into
 * `description:` and every sentence-scoped rule stayed green, because
 * `claimTexts` filters headings out. The usual objection (a heading is a
 * fragment, so sentence shapes mis-read it) does not bite here: these patterns
 * need a verb phrase and a collective object, which no heading in the tree has
 * by accident. "One undo puts the whole thing back" is a heading someone would
 * plausibly write.
 */
export function jointUndoFaults(label: string, markdown: string): string[] {
  const faults: string[] = [];
  for (const surface of claimSurfaces(markdown)) {
    for (const sentence of sentences(surface.text)) {
      // Every claim in this rule is about the UNDO. Without this gate the
      // patterns read as claims about anything plural, and two TRUE sentences in
      // this very article fire: "scheduling divisions together is never a worse
      // deal than scheduling them one at a time" (the batch discount) and
      // "Applying writes every division together". Both were caught by the
      // corpus test, which is what it is for.
      if (!JOINT_UNDO_SUBJECT.test(sentence)) continue;
      for (const p of FALSE_JOINT_UNDO_PATTERNS) {
        if (!p.test(sentence)) continue;
        faults.push(
          `${label}: "${sentence.slice(0, 72)}…" claims a joint undo is all-or-nothing — it is one call (#386) but NOT one outcome: it reports per-division failures and does not roll the successes back: ${p.source}`,
        );
      }
      for (const p of RETIRED_JOINT_UNDO_LOOP_PATTERNS) {
        if (!p.test(sentence)) continue;
        faults.push(
          `${label}: "${sentence.slice(0, 72)}…" describes the retired per-division undo loop — since #386 undo is ONE competition-scoped call (undoJointApply → POST /competitions/{id}/schedule/restore): ${p.source}`,
        );
      }
    }
  }
  return faults;
}

/**
 * v17 gap #365: `content/help/scheduling/ai-officials.md` said "Automatic
 * officials assignment is a Pro Plus feature." That sentence describes a REAL
 * gate — just not this one. `officials.ts`'s `officials.auto` feature key
 * (V290; `plan_entitlements` has `bool_value=true` for `pro_plus` only, `false`
 * for `pro`/`community` — measured against the local DB) gates a DIFFERENT,
 * deterministic "quick auto-assign" action (`autoAssignOfficials` /
 * `applyOfficialAssignments`, both call `requireFeature(auth.orgId,
 * "officials.auto")`), and `officials.md` correctly documents THAT gate. The
 * LLM-driven AI Officials architect this article is about is a separate code
 * path: `officials-ai.ts`'s own orchestrator comment states it directly — "the
 * AI officials path is NOT plan-gated" — `officialsAiPlanForDivision` never
 * calls `requireFeature` on any tier; it is metered by the AI credit wallet
 * instead (SPEC-1 §5, §7 / SPEC-2 §5.2), the same wallet the guard above
 * defends.
 *
 * DELIBERATELY NOT run tree-wide, unlike the guard above: the two features
 * share almost identical human phrasing ("automatic officials assignment … is
 * a Pro Plus feature") for two different gates, so a vocabulary broad enough to
 * catch the false claim in THIS article would also catch `officials.md`'s TRUE
 * one — the ambiguity is in the English, not in the regex. Scoping this
 * function's one call site to `ai-officials.md` (see
 * `help-copy-truth.test.ts`) is the fix; the pattern is written narrowly enough
 * that it does not currently match `officials.md`'s wording either (the
 * parenthetical "(propose/apply)" breaks the adjacency the first pattern
 * requires), but that is a bonus, not the safety mechanism.
 */
export function aiOfficialsPlanGateFaults(label: string, markdown: string): string[] {
  const patterns = [
    /\bautomatic\s+officials?\s+assignment\s+is\s+a\b[^.;]{0,20}\bpro\s+plus\b[^.;]{0,20}\bfeature\b/i,
    /\bAI\s+officials?\b[^.;]{0,40}\b(?:is|are)\s+a\b[^.;]{0,20}\bpro\s+plus\b[^.;]{0,20}\bfeature\b/i,
    /\bAI\s+officials?\b[^.;]{0,40}\brequires?\b[^.;]{0,20}\bpro\s+plus\b/i,
    /\bpro\s+plus\s+only\b[^.;]{0,40}\bAI\s+officials?\b|\bAI\s+officials?\b[^.;]{0,40}\bpro\s+plus\s+only\b/i,
  ];
  const faults: string[] = [];
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      for (const pattern of patterns) {
        if (pattern.test(sentence)) {
          faults.push(
            `${label}: "${sentence.slice(0, 72)}…" claims AI Officials needs Pro Plus — the AI officials path is NOT plan-gated (officials-ai.ts:officialsAiPlanForDivision never calls requireFeature); only the separate, deterministic officials.auto action is (officials.ts, V290, plan_entitlements pro_plus-only)`,
          );
        }
      }
    }
  }
  return faults;
}

/**
 * #382 review, finding 4: `content/help/scheduling/ai-scheduling.md` said "The
 * multi-division board is a **Pro** feature." Two things about that are now
 * wrong, and V353 (`db/migration/deltas/V353__open_scheduling_entitlements.sql`)
 * made both wrong at once, as a DATA change no compiler could see:
 *
 *   1. `scheduling.multi_division` is granted to `event_pass` and
 *      `event_pass_l`. A $29 pass lifts it for ONE competition, so naming Pro
 *      as the only door costs the sale the reader is closest to making —
 *      exactly the shape of the upgrade card in `localePassUncoveredFaults`.
 *   2. `scheduling.board` and `scheduling.constraints` are now true on EVERY
 *      plan key, so the board itself is not a paid feature at all. A sentence
 *      gating "the schedule board" on a plan is false however it is worded.
 *
 * TWO RULE SHAPES, because the two falsehoods differ. Gating the MULTI-DIVISION
 * board on Pro is INCOMPLETE rather than false — Pro really does lift it — so
 * it is a fault only when the sentence does not also name the pass; that keeps
 * the guard silent on the corrected copy, which states both doors. Gating the
 * BOARD ITSELF on any plan is false outright and needs no positive half.
 *
 * SCOPED TO ONE ARTICLE at its call site, like `aiOfficialsPlanGateFaults`
 * above and for the same reason: `board.md` and the plan pages legitimately
 * discuss what Pro adds, and a vocabulary broad enough to catch this claim
 * anywhere would catch true sentences elsewhere.
 */
export function multiDivisionBoardPlanGateFaults(label: string, markdown: string): string[] {
  const subject = String.raw`(?:multi[-\s]division|several\s+divisions|divisions?\s+at\s+once|competition[-\s]wide)`;
  const gate = String.raw`(?:is|are)\s+a\s+(?:\w+\s+){0,2}?pro\b|(?:requires?|needs?|takes)\s+(?:\w+\s+){0,2}?pro\b|pro[-\s]only|only\s+on\s+pro\b|available\s+on\s+pro\b`;
  // Pro as the ONLY door to planning several divisions together.
  const proOnlyDoor = [
    new RegExp(String.raw`\b${subject}\b[^.;]{0,60}\b(?:${gate})`, "i"),
    new RegExp(String.raw`\b(?:${gate})[^.;]{0,60}\b${subject}\b`, "i"),
  ];
  // THE EXEMPTION IS GONE (W2, entitlements v18). This used to clear the fault
  // when a sentence also named the Event Pass, on the premise that Pro and the
  // pass were the two doors to planning several divisions together. V393 made
  // `scheduling.multi_division` TRUE on community, so there is no door at all —
  // it is free on every plan key, and "needs Pro, or this competition's Event
  // Pass" became just as false as "needs Pro" alone. An exemption whose premise
  // has moved is a hiding place, so the rule now fires on any plan gate.
  // The board ITSELF sold as a paid feature — false on its own, no exemption.
  const boardIsPaid = [
    /\b(?:schedule|scheduling|drag[-\s]and[-\s]drop)\s+board\b[^.;]{0,40}\b(?:is|are)\s+a\s+(?:\w+\s+){0,2}?(?:pro|paid|premium)\b/i,
    /\b(?:schedule|scheduling)\s+board\b[^.;]{0,40}\b(?:requires?|needs?)\s+(?:\w+\s+){0,2}?(?:pro|a\s+paid\s+plan|an\s+upgrade)\b/i,
    /\b(?:upgrade|pro|a\s+paid\s+plan)\b[^.;]{0,40}\bto\s+(?:use|open|reach)\s+the\s+(?:schedule|scheduling)\s+board\b/i,
  ];

  const faults: string[] = [];
  for (const block of claimTexts(markdown)) {
    for (const sentence of sentences(block)) {
      for (const pattern of boardIsPaid) {
        if (pattern.test(sentence)) {
          faults.push(
            `${label}: "${sentence.slice(0, 72)}…" gates the schedule board on a plan — V353 grants scheduling.board and scheduling.constraints on every plan key`,
          );
        }
      }
      for (const pattern of proOnlyDoor) {
        if (pattern.test(sentence)) {
          faults.push(
            `${label}: "${sentence.slice(0, 72)}…" names Pro as a way to plan several divisions together — V393 grants scheduling.multi_division on EVERY plan key, community included, so any plan gate on it is false`,
          );
        }
      }
    }
  }
  return faults;
}

// ── The pass's duration and credit grant, in prose ───────────────────────────

/**
 * ── THE SHAPE FIX, second half (fix round 1) ─────────────────────────────────
 *
 * Round 1 ran `FALSE_PASS_PERMANENCE_PATTERNS` — a list of FALSEHOODS — over the
 * pass copy. A reviewer beat it in one line by writing a falsehood that was not
 * on the list, while leaving the true sentence in place so the positive half
 * stayed satisfied:
 *
 *   "The pass has no end date and applies for the life of the event."
 *
 * "no end date" and "life of" were both absent. Measured detection: 1 in 11.
 * That is inherent: the falsehoods are an OPEN set, so enumerating them is a
 * race the editor always wins.
 *
 * What is CLOSED is the set of grammatical forms English uses to state how long
 * something applies. There are only so many ways: a negated limit, a negated
 * stop, a maximal extent, a bare permanence adverb, a possessive, an open
 * personal extent, a concessive survival. Each form below is UNBOUNDED BY
 * CONSTRUCTION — none of them has a bounded reading in pass copy — so a new
 * falsehood has to be written in one of them to be a duration claim at all.
 *
 * The bounded ways of saying it are the other list: `BOUNDED_SCOPE_GRAMMAR`,
 * where a limiting conjunction governs an activity word. That is the sentence a
 * true pass description writes, and it is required, not merely permitted.
 */
export const DURATION_EXTENT_FORMS: Array<[form: string, pattern: RegExp]> = [
  ["a negated limit", /\bno\s+(end\s*(?:date)?|expiry|expiration|time\s+limit|deadline|cut[-\s]?off|final\s+date|last\s+day)\b/i],
  [
    "a negated stop",
    // NOT `switch off`: "a grace window, so the pass doesn't switch off
    // mid-finals" is true copy about the 7-day grace, and banning it was a
    // measured false positive. The absolute form is kept below.
    /\b(never|does\s+not|doesn'?t|will\s+not|won'?t|cannot|can'?t)\s+(expire|end|lapse|stop|run\s+out|finish|be\s+removed)\w*/i,
  ],
  ["a hyphenated permanence", /\bnever[-\s](expir|laps|end)\w*\b/i],
  ["an absolute non-stop", /\bnever\s+(switch(?:es)?\s+off|goes?\s+away|comes?\s+off)\b/i],
  [
    "a maximal extent",
    /\bfor\s+(?:the\s+|its\s+|your\s+)?(life|lifetime|whole\s+life|entire\s+life|rest\s+of\s+time|all\s+time)\b|\blifetime\b/i,
  ],
  [
    "an unqualified permanence",
    /\b(forever|for\s+ever|for\s+good|permanentl?y?|in\s+perpetuity|indefinitely|open[-\s]ended|everlasting|always\s+applies)\b/i,
  ],
  ["a possessive permanence", /\b(yours\s+to\s+keep|(stays?|remains?)\s+yours)\b/i],
  ["an open personal extent", /\bas\s+long\s+as\s+you\s+(want|like|wish|need|choose)\b/i],
  [
    "a concessive survival",
    /\b(keeps?\s+(working|applying|going)|still\s+applies|stays?\s+in\s+force|carries\s+on)\b[^.;:!?]*\b(even\s+)?(after|once|beyond)\b|\b(even|keeps?\s+working)\s+(after|once)\s+(it|the\s+(competition|event))\b/i,
  ],
];

/**
 * "This sentence says how long the pass applies." High recall on purpose — it
 * only decides whether a sentence must be BOUNDED, and every bounded phrasing
 * satisfies that requirement trivially.
 */
export const DURATION_CLAIM = new RegExp(
  [
    // A duration ADVERBIAL — "for <a stretch of time>". Round 1 used
    // "<verb> … for", which matched "bought outright FOR THAT EVENT" and three
    // other true sentences: any preposition near any verb is not a claim about
    // duration. The object has to BE a time.
    String.raw`\bfor\s+(?:the\s+|its\s+|your\s+|that\s+|this\s+)?(?:life|lifetime|duration|rest|remainder|whole|entire|ever|good|as\s+long\s+as|\d+\s+(?:day|week|month|year)s?)\b`,
    // NOT a bare "while"/"until"/"during". It was here on the theory that a
    // bounded form is a duration claim which then satisfies the rule trivially
    // — but the theory is circular, and it red-flagged a true sentence whose
    // "while" is CONDITIONAL, not temporal: "So while you're on a paid plan,
    // upgrade prompts don't offer the pass at all" says nothing about how long
    // anything lasts. A genuinely bounded sentence passes on its own merits.
    // Explicitly asking or answering "how long".
    String.raw`\b(?:no\s+end|expiry|expiration|how\s+long|life\s+of|lifetime|forever|permanent|in\s+perpetuity|indefinitely)\w*`,
  ].join("|"),
  "i",
);

/**
 * The pass's duration, in prose. Three rules, and the third is the one round 1
 * was missing:
 *
 *  1. NEGATIVE — no unbounded extent form anywhere in the pass's copy.
 *  2. POSITIVE — the opening paragraph must state the bound in its own words,
 *     so deleting the true sentence fails.
 *  3. PER-SENTENCE — every sentence that makes a duration claim at all must be
 *     a bounded one. This is what makes ADDING a false sentence fail: rule 1
 *     needs the falsehood to be on a list, rule 2 is satisfied by the surviving
 *     true sentence, but rule 3 judges the new sentence on its own.
 *
 * SCOPING IS LOAD-BEARING, and measured: `plans.md` truthfully says Community is
 * "free forever" and `credits.md` truthfully says pack credits "never expire".
 * Both are extent-form hits and both are correct — these forms are falsehoods
 * only about the PASS. Pass it pass copy, nothing else.
 */
export function passBoundProseFaults(label: string, passProse: string): string[] {
  const faults: string[] = [];
  // Scanned over prose AND frontmatter; the opening-paragraph rule below still
  // reads the first PROSE block, because a `description:` is not the article's
  // scope statement even though it is the first thing rendered.
  const blocks = claimTexts(passProse);

  for (const block of blocks) {
    for (const sentence of sentences(block)) {
      const bounded = BOUNDED_SCOPE_GRAMMAR.test(sentence);
      for (const [form, pattern] of DURATION_EXTENT_FORMS) {
        if (!pattern.test(sentence)) continue;
        faults.push(
          `${label}: "${sentence.slice(0, 72)}…" states the pass's duration as ${form} — an unbounded extent`,
        );
      }
      // FIX ROUND 2: the `namesStop` exemption that used to sit here is GONE.
      // It was a false-green widener with ZERO coverage — rule 3 flagged no
      // sentence of either real article, so nothing exercised it, yet it was
      // reachable and exempted "It applies for the whole duration, and stops
      // once that competition is over." Naming a stop condition is now an
      // APPROVED FORM in `DURATION_ALLOWLIST`, where it is exercised, rather
      // than an escape hatch here.
      if (DURATION_CLAIM.test(sentence) && !bounded) {
        faults.push(
          `${label}: "${sentence.slice(0, 72)}…" says how long the pass applies without bounding it to a running competition`,
        );
      }
    }
  }

  const [opening] = proseBlocks(passProse);
  if (opening === undefined) {
    faults.push(`${label}: no prose to scan — the section is empty or its heading moved`);
  } else if (!BOUNDED_SCOPE_GRAMMAR.test(opening)) {
    faults.push(
      `${label}: the opening paragraph never states the pass is bounded to a running competition`,
    );
  }
  return faults;
}

/**
 * Every AI-credit figure in the pass's own copy, against `PASS_CREDIT_GRANT`.
 *
 * Two directions, because a table writes the figure on the other side of the
 * noun ("| AI credits | +25, one-time | +35, one-time |") and a sentence writes
 * it in front ("a one-time top-up of 25 AI credits"). A guard that only read one
 * of them would leave the comparison table — the first thing a buyer looks at —
 * unchecked.
 *
 * Paired with the positive: EVERY declared grant must actually be stated, and
 * every block that states one must say it is one-time. The recurring vocabulary
 * is the inverse claim, and a block that quotes the right number monthly is
 * worse than one that quotes nothing.
 *
 * Entitlements v18 / W2 T5: these articles describe BOTH rungs in one body of
 * prose — a two-column table, a "both sizes" sentence — so there is no rung in
 * scope to judge a figure against, and this reads the declared SET instead. That
 * makes the positive half strictly stronger than the flat version it replaces:
 * it was satisfied by any single mention of the grant, and now L's 50 cannot be
 * dropped by an editor who only updated the sentence about M.
 */
export function passCreditProseFaults(label: string, passProse: string): string[] {
  const faults: string[] = [];
  const stated = new Set<number>();
  for (const block of claimTexts(passProse)) {
    const figures = [
      ...block.matchAll(/(?:\+\s*)?(\d[\d,]*)\s+AI\s+credits?\b/gi),
      // The number-after form needs a SEPARATOR, not merely proximity: a free
      // window of a few characters read "…25 AI credits, and a 5% platform fee"
      // as a claim of 5 AI credits (measured). A table cell or a colon is what
      // actually puts a figure after the label.
      ...block.matchAll(/\bAI\s+credits?\b\s*[:|]\s*\+?\s*(\d[\d,]*)\b/gi),
      // ...and EVERY FURTHER COLUMN of the same row. The form above stops at the
      // first cell after the label, which was harmless while both rungs granted
      // the same number and is a hole the moment they do not: in
      // "| AI credits | +25, one-time | +35, one-time |" the L column was never
      // read, so L's figure could be anything at all (measured — the two-rung
      // table passed with L's cell still saying +25). Both the pipe AND the `+`
      // are required, which is what keeps this off the "5% platform fee" a few
      // characters further along the same row; that false positive is the reason
      // the form above needs a separator in the first place.
      ...(/\bAI\s+credits?\b\s*[:|]/i.test(block) ? block.matchAll(/\|\s*\+(\d[\d,]*)\b/g) : []),
    ].map((m) => Number(m[1]!.replace(/,/g, "")));
    if (figures.length === 0) continue;

    const snippet = block.slice(0, 48);
    for (const figure of figures) {
      if (!DECLARED_GRANTS.includes(figure)) {
        faults.push(
          `${label}: "${snippet}…" quotes ${figure} AI credits, but the pass grants ${DECLARED_GRANTS.join(" / ")}`,
        );
      }
    }
    if (!/\b(one[-\s]time|once|single\s+top[-\s]?up)\b/i.test(block)) {
      faults.push(`${label}: "${snippet}…" states the credit grant without saying it is one-time`);
    } else {
      for (const figure of figures) if (DECLARED_GRANTS.includes(figure)) stated.add(figure);
    }
    for (const pattern of RECURRING_GRANT_PATTERNS) {
      if (pattern.test(block)) {
        faults.push(`${label}: "${snippet}…" sells the one-time grant as recurring (${pattern.source})`);
      }
    }
  }
  for (const grant of DECLARED_GRANTS) {
    if (!stated.has(grant)) {
      faults.push(`${label}: never states the one-time +${grant} AI credit grant`);
    }
  }
  return faults;
}

// ── FOUR-LOCALE DICTIONARY COPY ──────────────────────────────────────────────
//
// Everything above this line is an ENGLISH regex pointed at an ENGLISH-ONLY
// surface: `stripe-plans.json` (one seed, English descriptions) and
// `content/help/**` (a single English tree — HELP_ROOT has no locale segment).
// That was correct for tasks 1-3 and it is a TRAP for task 4.
//
// `src/dictionaries/*/marketing.json` and `*/ui.json` are FOUR files each. Point
// `FALSE_PASS_PERMANENCE_PATTERNS` at them and it reds on `en` and passes
// silently on es/fr/nl — measured, before this task's fix, on the exact strings
// it was written for:
//
//   en pricing.pass.note     "Yours for the event's lifetime."        → 1 hit
//   es pricing.pass.note     "Tuyo durante toda la vida del evento."  → 0 hits
//   fr pricing.pass.note     "À vous pour toute la durée de …"        → 0 hits
//   nl pricing.pass.note     "…voor de hele levensduur van het …"     → 0 hits
//
// All four say the same false thing. A guard that reds only on `en` is not a
// guard on this surface — it is a guard that certifies a falsehood in three
// languages. So the claim vocabularies below are keyed BY LOCALE, and
// `localesAreCovered` makes a locale with no vocabulary a FAULT rather than a
// silent pass. Adding a fifth dictionary directory reds this suite on day one.
//
// Three layers, deliberately, because each covers what the others cannot:
//
//  1. VOCABULARY, per locale — the general rule. Catches a reworded falsehood
//     in the language it is written in. Holes are possible (nobody can enumerate
//     a language), which is why it is not the only layer.
//  2. THE SAME VOCABULARIES, CROSS-APPLIED to every locale. Free, and it closes
//     the failure mode wave 6 actually shipped: a Spanish/French/Dutch surface
//     rendering new ENGLISH prose. An English falsehood pasted into `nl` is
//     caught by the English list; a French one in `es` by the French list.
//  3. RETIRED LITERALS — the exact prose this task removed, from all four
//     files, checked against all four values. This layer CANNOT have a hole,
//     and it pins fragments the vocabularies deliberately omit: French "pour
//     toute la durée" is a permanence claim about the pass but a TRUE bound in
//     other sentences, so it is a retired literal rather than a vocabulary
//     entry (a guard that rejects true prose teaches its next editor to route
//     around it).
//
// And every absence rule here is paired with a POSITIVE: `bounded` must match,
// in that locale's own grammar. Absence proves "not false", never "still
// stated" — deleting the sentence would otherwise be the cheapest way to green.

export const DICTIONARY_LOCALES = ["en", "es", "fr", "nl"] as const;
export type DictionaryLocale = (typeof DICTIONARY_LOCALES)[number];

/**
 * `\b` AND `\w` ARE ASCII-ONLY IN JAVASCRIPT, AND THAT SILENTLY VOIDS A GUARD
 * WRITTEN IN A LANGUAGE WITH ACCENTS.
 *
 * There is no word boundary between a space and "à" — both are non-word
 * characters to `\b` — so `/\bà\s+vie\b/i` does not match "Valable à vie". Nor
 * does `/\bmoitié\b/i` match "la moitié du tarif": the trailing `\b` sits
 * between "é" and a space, two non-word characters again. `\w` fails the same
 * way, so `/asignaci\w*\s+autom/i` cannot reach "asignación automática".
 *
 * MEASURED, on the first run of this task's suite: the French permanence list
 * returned ZERO faults for a value that plainly said "à vie", and the French
 * "au plus la moitié" qualifier read as absent when it was right there. A guard
 * that cannot match its own language is worse than no guard — it reports clean.
 *
 * So every non-English pattern is built through here: `\b` becomes the Unicode
 * definition of a word boundary and `\w` a Unicode word character, under the
 * `u` flag. English patterns keep plain literals; they are ASCII by definition
 * and are shared with the seed and help guards.
 */
const UNICODE_WORD = String.raw`[\p{L}\p{N}_]`;
const UNICODE_BOUNDARY = `(?:(?<=${UNICODE_WORD})(?!${UNICODE_WORD})|(?<!${UNICODE_WORD})(?=${UNICODE_WORD}))`;

/**
 * The expansion is ~90 characters per `\b`, which turns a fault label into an
 * unreadable blob — and an unreadable fault is one nobody acts on. The written
 * source is kept here and `describeClaim` hands it back for labels.
 */
const CLAIM_SOURCE = new WeakMap<RegExp, string>();

export function claim(source: string): RegExp {
  const compiled = new RegExp(
    source.replaceAll(String.raw`\w`, UNICODE_WORD).replaceAll(String.raw`\b`, UNICODE_BOUNDARY),
    "iu",
  );
  CLAIM_SOURCE.set(compiled, source);
  return compiled;
}

/** What a pattern says, as it was written. */
export function describeClaim(pattern: RegExp): string {
  return CLAIM_SOURCE.get(pattern) ?? pattern.source;
}

/** One language's way of making each claim these dictionaries make. */
export interface LocaleClaims {
  /** Unbounded duration. Deliberately EXCLUDES the "unlimited" family
   *  (`ilimitado`/`illimité`/`onbeperkt`), which is a TRUE claim about the L
   *  rung's entrant cap in three of these very strings. */
  permanence: RegExp[];
  /** A limiting conjunction GOVERNING an activity word — the positive half.
   *  Same shape and 60-character window as `BOUNDED_SCOPE_GRAMMAR`, for the
   *  same measured reason: at 30 it rejected true copy. */
  bounded: RegExp;
  /** Recurring cadence — the inverse of the pass's one-time credit grant. */
  recurring: RegExp[];
  /** "the largest monthly AI credit grant" — the TRUE differentiator that
   *  replaced the false AI-scheduling one. Its own regex because it is a
   *  COMPARATIVE, not a boolean grant. */
  creditLeadership: RegExp;
  /** Any claim about half the base rate, qualified or not. */
  halfClaim: RegExp;
  /** …and the "no more than" qualifier that makes it true. */
  atMostHalf: RegExp;
  /** The entry-fee/rate subject. A permanence claim about THIS is the V312 fee
   *  lock, which is true — see `isRateClause`. */
  rateSubject: RegExp;
  /** The pass/upgrade subject. Its presence in a clause overrides the rate
   *  exemption, so the exemption cannot become a hiding place. */
  passSubject: RegExp;
}

export const LOCALE_CLAIMS: Record<DictionaryLocale, LocaleClaims> = {
  en: {
    // The English half is the SAME list the seed and help guards use. Sharing
    // it is the point: a pattern added for task 1 or 3 must not have to be
    // remembered again here.
    permanence: FALSE_PASS_PERMANENCE_PATTERNS,
    bounded: BOUNDED_SCOPE_GRAMMAR,
    recurring: RECURRING_GRANT_PATTERNS,
    creditLeadership: /\b(largest|biggest|highest)\b[^,.;]{0,30}\bcredit/i,
    // WIDENED, fix round 4. The first three alternatives are the phrases the
    // corrected copy uses; the last two are the ones the SHIPPED copy used and
    // this pattern could not see — "half price" (`orgNew.bill.addToExistingHint`,
    // `groups.md`'s frontmatter, "the extra half-price rate" in its Q&A) and a
    // bare "half the rate" / "half the plan rate"
    // (`getting-started/create-your-organisation.md`, `groups.md:41`). Four key
    // families and two whole help articles carried the claim in a shape this
    // regex did not match, which is why the axis in the suites below is the
    // primary defence and this is the secondary one. Widening it moves the
    // committed lexical rates, which are re-measured rather than adjusted.
    halfClaim:
      /\bhalf\s+the\s+base\s+rate\b|\bhalf\s+(your|the)\s+plan['’]s\s+rate\b|\bhalf[-\s]price[ds]?\b|\bhalf\s+the\s+(plan\s+)?rate\b/i,
    atMostHalf: /\b(no\s+more\s+than|at\s+most|up\s+to)\s+half\b/i,
    rateSubject: /\b(platform\s+fees?|entry[-\s]fees?|fees?|rates?|percentage|commission)\b|\d+(\.\d+)?\s*%/i,
    passSubject: /\b(pass|passes|upgrade[ds]?|competition|event)\b/i,
  },
  es: {
    // Fix round 1: this list was SINGULAR-VERB-ONLY and therefore inert. Every
    // verb below was spelled out in one inflection ("nunca caduca"), so the
    // plural the shipped copy actually used — "los pases nunca caducan" — went
    // undetected, in the key this round had to fix. The verbs are now STEMS
    // with `\w*`, which covers number, person and tense at once, and each form
    // of the claim is listed rather than each sentence that makes it.
    permanence: [
      // A — lifetime adverbials.
      String.raw`\bde\s+por\s+vida\b`,
      String.raw`\bpara\s+siempre\b`,
      String.raw`\btoda\s+(la|su)\s+vida\b`,
      String.raw`\bde\s+(manera|forma)\s+(permanente|indefinida)\b`,
      String.raw`\bindefinidamente\b`,
      String.raw`\bpor\s+tiempo\s+(ilimitado|indefinido)\b`,
      String.raw`\bsiempre\s+(tuy[oa]s?|activ[oa]s?|válid[oa]s?)\b`,
      // B — negated termination, BOTH ORDERS, verb inflected. `nunca`/`jamás`
      // take the full stem list; a bare `no` takes only the unambiguous expiry
      // verbs, because "la competición no termina hasta el domingo" is ordinary
      // true prose and must not red.
      String.raw`\b(nunca|jamás)\s+(?:se\s+)?(caduc|expir|venc|termin|acab|finaliz|prescrib)\w*`,
      String.raw`\bno\s+(?:se\s+)?(caduc|expir|venc|prescrib)\w*`,
      String.raw`\b(caduc|expir|venc|termin|acab|finaliz|prescrib)\w*\s+(nunca|jamás)\b`,
      // C — absence of a limit.
      String.raw`\bsin\s+(fecha\s+de\s+)?(caducidad|vencimiento|expiración)\b`,
      String.raw`\bsin\s+límite\s+de\s+tiempo\b`,
      // D — permanence adjectives/adverbs, inflected.
      String.raw`\bpermanente(s|mente)?\b`,
      // E — retention.
      String.raw`\bes\s+tuy[oa]s?\s+(para\s+siempre|y\s+lo\s+conservas)\b`,
      String.raw`\b(sigue|siguen|seguirá|seguirán)\s+siendo\s+tuy[oa]s?\b`,
      // F — absence of an end, endurance verbs, and guarded "siempre".
      String.raw`\bno\s+(tiene|tienen)\s+fin\b`,
      String.raw`\bno\s+hay\s+(fecha\s+límite|fin|caducidad|vencimiento)\b`,
      String.raw`\bsin\s+(fin|fecha\s+límite|plazo)\b`,
      String.raw`\b(perdur|permanec|subsist)\w*`,
      String.raw`\bsigue\w*\s+vigente\b`,
      String.raw`\bpara\s+el\s+resto\s+del\s+tiempo\b`,
      String.raw`\bsiempre\b[^.;,]{0,24}\b(tuy|activ|válid|acompañ|conserv|dispon)\w*|\b(tuy|activ|válid|acompañ|conserv)\w*[^.;,]{0,24}\bsiempre\b`,
    ].map(claim),
    bounded: claim(
      boundedScopeGrammarSource(
        ["mientras", String.raw`hasta\s+que`, String.raw`durante\s+el\s+tiempo\s+que`],
        ["activ[ao]s?", String.raw`en\s+curso`, String.raw`en\s+marcha`, "abiert[ao]s?", "dure", "dura", String.raw`se\s+juegue`],
        "es",
      ),
    ),
    recurring: [
      String.raw`\bmensual(es|mente)?\b`,
      String.raw`\bal\s+mes\b`,
      String.raw`\bcada\s+mes\b`,
      String.raw`\bpor\s+mes\b`,
      String.raw`\brecurrente\b`,
      // #338 item 3: this list was MONTHLY-ONLY, so a yearly or weekly framing
      // of the same one-time-grant falsehood — "cada año", "anuales", "en cada
      // renovación" — scored 0/9 across all four locales. Same claim, other
      // cadence; the family, not the month, is what has to be false.
      String.raw`\banual(es|mente)?\b`,
      String.raw`\bal\s+año\b`,
      String.raw`\bcada\s+año\b`,
      String.raw`\bpor\s+año\b`,
      String.raw`\bsemanal(es|mente)?\b`,
      String.raw`\bcada\s+semana\b`,
      String.raw`\btrimestral(es|mente)?\b`,
      String.raw`\brenovaci\w*\b`,
      String.raw`\ben\s+cada\s+renovaci\w*\b`,
    ].map(claim),
    creditLeadership: claim(String.raw`\b(mayor|más\s+grande)\b[^,.;]{0,30}\bcréditos?\b`),
    halfClaim: claim(String.raw`\bmitad\s+de\s+(la\s+tarifa\s+base|la\s+tarifa\s+de\s+tu\s+plan|precio|tarifa)\b`),
    atMostHalf: claim(String.raw`\b(no\s+más\s+de|como\s+máximo|a\s+lo\s+sumo|máximo)\s+(la\s+)?mitad\b`),
    rateSubject: claim(String.raw`\b(comisi\w*|tarifa|tasa|porcentaje)\b|\d+(\.\d+)?\s*%`),
    passSubject: claim(String.raw`\b(pase|pases|mejora\w*|competici\w*|evento)\b`),
  },
  fr: {
    // Fix round 1: same defect as es. `n['’]expire\s+(jamais|pas)` pinned the
    // THIRD-PERSON SINGULAR, so the shipped plural "les pass n'expirent jamais"
    // was invisible. Stems and `\w*` now carry the inflection, and the
    // verb-then-`jamais` order is matched without requiring the negator, since
    // that is where the plural actually broke.
    permanence: [
      // A — lifetime adverbials.
      String.raw`\bà\s+vie\b`,
      String.raw`\bpour\s+toujours\b`,
      String.raw`\bà\s+jamais\b`,
      String.raw`\bdéfinitivement\b`,
      String.raw`\bindéfiniment\b`,
      String.raw`\bde\s+(manière|façon)\s+(permanente|définitive)\b`,
      String.raw`\bà\s+durée\s+(illimitée|indéterminée)\b`,
      String.raw`\bpour\s+de\s+bon\b`,
      // B — negated termination: circumfix `ne … jamais`, elided `n'…`, and the
      // bare verb-then-`jamais` order.
      String.raw`\bn['’](expir|arrêt|achèv|termin|fini)\w*\s+(jamais|pas)\b`,
      String.raw`\bne\s+(?:s['’]|se\s+)?(expir|arrêt|achèv|termin|fini)\w*\s+(jamais|pas)\b`,
      String.raw`\b(expir|arrêt|achèv|termin)\w*\s+jamais\b`,
      // C — absence of a limit.
      String.raw`\bsans\s+(date\s+d['’])?(expiration|échéance)\b`,
      String.raw`\bsans\s+limite\s+de\s+(temps|durée)\b`,
      // D — permanence adjectives/adverbs, inflected.
      String.raw`\bpermanent\w*\b`,
      // E — retention.
      String.raw`\brest\w*\s+(valable|acquis|actif|active)s?\s+(à\s+vie|indéfiniment|pour\s+toujours)\b`,
      // F — absence of an end, endurance verbs, and guarded "toujours".
      String.raw`\bjamais\s+fin\b`,
      String.raw`\baucun(e)?\s+(date\s+limite|échéance|fin|terme)\b`,
      String.raw`\baucune\s+limite\s+de\s+(temps|durée)\b`,
      String.raw`\bsans\s+(fin|terme)\b`,
      String.raw`\bpas\s+de\s+(terme|fin|limite|date\s+limite)\b`,
      String.raw`\b(demeur|subsist|perdur)\w*`,
      String.raw`\bpour\s+la\s+vie\b`,
      String.raw`\btoujours\b[^.;,]{0,24}\b(vôtre|gard|valable|actif|active|conserv)\w*|\b(gard|valable|actif|active|conserv)\w*[^.;,]{0,24}\btoujours\b`,
    ].map(claim),
    bounded: claim(
      boundedScopeGrammarSource(
        [
          String.raw`tant\s+qu\w*`,
          String.raw`pendant\s+qu\w*`,
          String.raw`jusqu['’]à\s+ce\s+qu\w*`,
          String.raw`aussi\s+longtemps\s+qu\w*`,
        ],
        [String.raw`activ\w*`, String.raw`en\s+cours`, String.raw`ouvert\w*`, String.raw`se\s+déroule`, "dure"],
        "fr",
      ),
    ),
    recurring: [
      String.raw`\bmensuel(le|s|les)?\b`,
      String.raw`\bpar\s+mois\b`,
      String.raw`\bchaque\s+mois\b`,
      String.raw`\brécurrent(e|s)?\b`,
      // #338 item 3 — the yearly/weekly twin of the same falsehood: "chaque
      // année", "annuels", "à chaque renouvellement" all scored 0/9.
      String.raw`\bannuel(le|s|les)?\b`,
      String.raw`\bpar\s+an\b`,
      String.raw`\bchaque\s+année\b`,
      String.raw`\btous\s+les\s+ans\b`,
      String.raw`\bhebdomadaire(s)?\b`,
      String.raw`\bchaque\s+semaine\b`,
      String.raw`\btrimestriel(le|s|les)?\b`,
      String.raw`\brenouvellement(s)?\b`,
      String.raw`\bà\s+chaque\s+renouvellement\b`,
    ].map(claim),
    creditLeadership: claim(String.raw`\bplus\s+(grosse|grande|élevée|important\w*)\b[^,.;]{0,30}\bcrédits?\b|\bcrédits?\b[^,.;]{0,30}\bla\s+plus\s+(élevée|grande|grosse|important\w*)\b`),
    halfClaim: claim(String.raw`\bmoitié\s+du\s+(tarif\s+de\s+base|tarif\s+de\s+votre\s+forfait|prix)\b|\bmoitié\s+prix\b`),
    atMostHalf: claim(String.raw`\b(au\s+plus|pas\s+plus\s+de|au\s+maximum|maximum)\s+(la\s+)?moitié\b`),
    rateSubject: claim(String.raw`\b(frais|commission|taux|pourcentage)\b|\d+(\.\d+)?\s*%`),
    passSubject: claim(String.raw`\b(pass|am\u00e9lioration\w*|comp\u00e9tition\w*|\u00e9v\u00e9nement\w*)\b`),
  },
  nl: {
    // Fix round 1: same defect again — the verbs were enumerated as finite
    // singular forms (`verloopt|vervalt|eindigt`), so the shipped plural
    // "passes verlopen nooit" matched nothing. Note Dutch needs BOTH `verloop`
    // and `verlop` as stems: "verloopt" has two o's and "verlopen" has one, so
    // neither is a prefix of the other and a single stem silently covers half
    // the paradigm.
    permanence: [
      String.raw`\blevensduur\b(?!\s+van\s+(de|het)\s+competitie)`,  // M2: a lifetime OF THE COMPETITION is a bound, not a permanence claim
      // "voor het hele verloop" — the nl wording of `billing.passOffer.note`,
      // which reached for a different metaphor than the other three keys. Proof
      // that a vocabulary written from ONE string per language is not a
      // vocabulary; the positive `bounded` rule is what actually caught it.
      String.raw`\b(hele|volledige)\s+(verloop|duur)\b`,
      // A — lifetime adverbials.
      String.raw`\bvoor\s+altijd\b`,
      String.raw`\bvoorgoed\b`,
      String.raw`\beeuwig\w*\b`,
      String.raw`\bvoor\s+onbepaalde\s+tijd\b`,
      String.raw`\bonbeperkt\s+(geldig|houdbaar)\b`,
      String.raw`\b(altijd|permanent)\s+(geldig|actief)\b`,
      // B — negated termination, both orders, verb inflected.
      String.raw`\bnooit\s+(?:meer\s+)?(verloop|verlop|verval|eindig|stop|afloop|aflop)\w*`,
      String.raw`\b(verloop|verlop|verval|eindig|stop|afloop|aflop)\w*\s+(nooit|niet)\b`,
      // C — absence of a limit.
      String.raw`\bgeen\s+(vervaldatum|einddatum|tijdslimiet|houdbaarheidsdatum|verloopdatum|vervaltermijn)\b`,
      // D — permanence adjectives, inflected.
      String.raw`\bpermanent\w*\b`,
      // E — retention.
      String.raw`\baltijd\s+van\s+jou\b`,
      String.raw`\b(blijft|blijven)\s+(altijd\s+)?(geldig|actief|van\s+jou)\b`,
      // F — absence of an end, endurance verbs, and guarded "altijd".
      String.raw`\bgeen\s+(einde|afkapdatum|termijn)\b`,
      String.raw`\bzonder\s+(einde|termijn)\b`,
      String.raw`\bkent\s+geen\s+einde\b`,
      String.raw`\b(blijft|blijven)\s+(bestaan|staan|gelden)\b`,
      String.raw`\bhoudt?\s+niet\s+op\b`,
      String.raw`\b(duurt|geldt|loopt)\s+onbeperkt\b`,
      String.raw`\bhele\s+leven\b`,
      String.raw`\baltijd\b[^.;,]{0,24}\b(van\s+jou|houdt?|geldig|actief|bewaar)\w*|\b(houdt?|geldig|actief)\w*[^.;,]{0,24}\baltijd\b`,
    ].map(claim),
    bounded: claim(
      boundedScopeGrammarSource(
        ["zolang", "terwijl", "totdat", String.raw`tot\s+de`],
        ["loopt", "actief", "open", "bezig", "duurt", "draait"],
        "nl",
      ),
    ),
    recurring: [
      String.raw`\bmaandelijks(e)?\b`,
      String.raw`\bper\s+maand\b`,
      String.raw`\b(elke|iedere)\s+maand\b`,
      String.raw`\bterugkerend(e)?\b`,
      // #338 item 3 — the yearly/weekly twin of the same falsehood: "elk jaar",
      // "jaarlijks", "bij elke verlenging" all scored 0/9.
      String.raw`\bjaarlijks(e)?\b`,
      String.raw`\bper\s+jaar\b`,
      String.raw`\b(elk|ieder)\s+jaar\b`,
      String.raw`\bwekelijks(e)?\b`,
      String.raw`\b(elke|iedere)\s+week\b`,
      String.raw`\bper\s+kwartaal\b`,
      String.raw`\bverlenging(en)?\b`,
      String.raw`\bbij\s+elke\s+verlenging\b`,
    ].map(claim),
    creditLeadership: claim(String.raw`\b(grootste|hoogste)\b[^,.;]{0,30}\bcredit`),
    // `\bhelft\s+van\s+het\s+…` required "het", so the shipped
    // `orgNew.bill.addToExistingHint` — "voor de helft van DE prijs" — was
    // invisible, the Dutch twin of the English "half price" hole. The
    // determiner is now optional and `prijs` joins the noun list.
    halfClaim: claim(
      String.raw`\bhelft\s+van\s+(het|de)\s+(basistarief|prijs|tarief\s+van\s+je\s+abonnement)\b|\bhalve\s+(prijs|tarief)\b`,
    ),
    atMostHalf: claim(String.raw`\b(hoogstens|maximaal|ten\s+hoogste|niet\s+meer\s+dan)\s+(de\s+)?helft\b`),
    rateSubject: claim(String.raw`\b(kosten|tarief|percentage|commissie)\b|\d+(\.\d+)?\s*%`),
    passSubject: claim(String.raw`\b(pass|passes|upgrade\w*|competitie\w*|evenement\w*)\b`),
  },
};

/**
 * The structural rule that makes everything above non-optional: the vocabulary
 * map must cover exactly the locales that EXIST. A dictionary directory with no
 * entry here is unguarded copy, and it must red rather than pass — that is the
 * whole difference between "we guard the pricing copy" and "we guard the
 * English pricing copy and hope".
 *
 * Checked in BOTH directions. A stale entry for a deleted locale is a fault too:
 * it makes the map look like it covers more than it does, and a cross-applied
 * vocabulary for a language nobody ships is dead weight that hides a real gap.
 */
export function localeCoverageFaults(localesOnDisk: string[]): string[] {
  const faults: string[] = [];
  const covered = new Set<string>(Object.keys(LOCALE_CLAIMS));
  for (const locale of localesOnDisk) {
    if (!covered.has(locale)) {
      faults.push(
        `${locale}/: a dictionary locale with no entry in LOCALE_CLAIMS — its copy is scanned by nothing`,
      );
    }
  }
  for (const locale of covered) {
    if (!localesOnDisk.includes(locale)) {
      faults.push(`${locale}: LOCALE_CLAIMS covers a locale that no longer exists on disk`);
    }
  }
  return faults;
}

/** One dictionary value under scan. */
export interface LocalisedValue {
  locale: DictionaryLocale;
  key: string;
  value: string;
}

/**
 * Layers 1 + 2: every locale's permanence vocabulary against every locale's
 * value, plus that locale's OWN positive bound.
 *
 * Cross-application is what stops "we translated it" from meaning "we guarded
 * it". The previous wave shipped a Spanish/French/Dutch surface carrying new
 * English prose; under this rule the English list reds on the Dutch value, and
 * the fault label names which language's vocabulary fired so the reader knows
 * whether they are looking at a falsehood or a mistranslation.
 *
 * The POSITIVE half is deliberately the locale's OWN grammar and nothing else:
 * a Dutch value satisfying the English "while … running" would mean the Dutch
 * page renders English, which is the bug, not the fix.
 */
/**
 * A dictionary value split at the boundaries a claim's SUBJECT can change:
 * sentence punctuation, commas, and the dashes/colons this copy uses to join
 * two statements. One clause, one subject — which is what makes it possible to
 * ask "what is this permanence claim ABOUT".
 */
export function valueClauses(value: string): string[] {
  return value
    .split(/[.:;!?]+|\s+[—–-]\s+|,/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * "THE PASS NEVER ENDS" IS FALSE. "THE LOCKED RATE NEVER CHANGES" IS TRUE.
 * The permanence vocabulary cannot tell them apart on its own — `for good`,
 * `permanentemente`, `définitivement` and `permanent` are all in it, and the
 * V312 fee lock is a genuine forever-claim about a different subject. Task 3
 * has just rewritten the fee-lock prose, so this would have started firing on
 * true copy the moment that wording reached a guarded dictionary value.
 *
 * The discriminator is the SUBJECT OF THE CLAUSE, not the words in it: a
 * permanence hit is a pass falsehood unless its clause is about the rate AND
 * says nothing about the pass. Requiring both halves is what stops the
 * exemption becoming a hole — "a 5% platform fee, and the pass lasts forever"
 * mentions the fee, but it also mentions the pass, so it still reds.
 */
/**
 * A NEW SUBJECT, for the purpose of asking what a permanence claim is about.
 *
 * This is `CLAUSE_BREAK` plus pronouns. The bounded-scope rule can ignore
 * pronouns because it looks for a conjunction governing an activity word; this
 * rule cannot, because "the 5% rate AND IT lasts forever" is precisely the
 * shape where the rate stops being the subject.
 */
/**
 * THE COORDINATOR ALONE IS THE BREAK — deliberately coarser than
 * `CLAUSE_BREAK`, which requires a following determiner.
 *
 * A first cut required coordinator + determiner/pronoun and scored 8/9: it
 * missed Spanish "…al 5% de comisión y dura para siempre", because Spanish is
 * PRO-DROP. "y dura" starts a new predicate with no pronoun to detect, and no
 * regex is going to reliably tell a verb from a noun across four languages.
 *
 * So attribution stops at any coordinator. The cost is a true sentence like
 * "the fee is locked and stays locked for good", which now reds. That trade is
 * deliberate and it is the right way round HERE, because this rule is the
 * SECONDARY net: `approvedDictionaryFaults` pins the copy that actually ships,
 * so a false positive costs one reword on unpinned copy, while a false negative
 * is how this wave shipped the same falsehood four times.
 *
 * Note the difference from `CLAUSE_BREAK`, which must stay precise: it decides
 * whether a bound was STATED, where rejecting true prose would be the expensive
 * error.
 */
const SUBJECT_BREAK: Record<DictionaryLocale, string> = {
  en: String.raw`\b(?:and|or|but|so|then|yet|while|whereas)\b`,
  es: String.raw`\b(?:y|e|o|u|pero|aunque|mientras)\b`,
  fr: String.raw`\b(?:et|ou|mais|donc|alors|tandis)\b`,
  nl: String.raw`\b(?:en|of|maar|dus|terwijl)\b`,
};

/**
 * IS THIS PERMANENCE CLAIM ABOUT THE RATE, OR ABOUT THE PASS?
 *
 * Fix round 1 answered this by DROPPING any clause where a rate was mentioned
 * and the pass was not — and that opened a percentage-shaped hole in the rule
 * it was repairing. Measured 0/9: "It is a one-off at the 5% rate and it lasts
 * forever" went green, because the clause names a rate and the pass only ever
 * appears as the pronoun "it". Pass copy quotes percentages constantly, so the
 * exemption sat exactly on the surface it was guarding.
 *
 * The repair is to narrow the MATCH, not to remove text from the scan. A
 * permanence hit is exempt only when the rate is the noun that hit actually
 * governs, which requires all three:
 *   1. a rate word appears BEFORE the permanence match (the nearest one wins);
 *   2. no NEW SUBJECT intervenes — "and it", "et cela", "en de" start a new
 *      clause, so the rate is no longer the subject;
 *   3. the pass is not named in between, which would make the claim about it.
 *
 * Everything else is scanned. The rule fails closed: an unattributable claim
 * ("It lasts forever") is treated as a claim about the pass.
 */
function permanenceHitIsAboutRate(
  locale: DictionaryLocale,
  clause: string,
  matchIndex: number,
): boolean {
  const { rateSubject, passSubject } = LOCALE_CLAIMS[locale];
  const before = clause.slice(0, matchIndex);

  // The NEAREST preceding rate word — a rate mentioned earlier, with a new
  // subject after it, is not the subject of this claim.
  const rate = new RegExp(rateSubject.source, rateSubject.flags.includes("g") ? rateSubject.flags : `${rateSubject.flags}g`);
  let lastRateEnd = -1;
  for (const m of before.matchAll(rate)) lastRateEnd = m.index! + m[0].length;
  if (lastRateEnd === -1) return false;

  const between = clause.slice(lastRateEnd, matchIndex);
  if (new RegExp(SUBJECT_BREAK[locale], "iu").test(between)) return false;
  if (passSubject.test(between)) return false;
  return true;
}

export function localePassBoundFaults(values: LocalisedValue[]): string[] {
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    if (value.trim().length === 0) {
      faults.push(`${locale} ${key}: empty — nothing to scan, so every rule below passes vacuously`);
      continue;
    }
    // EVERY clause is scanned. What varies is whether an individual hit is
    // attributed to the rate (true, the V312 lock) or to the pass (false) —
    // see `permanenceHitIsAboutRate`. Fix round 1 dropped whole clauses here
    // and that was a regression: a clause quoting a percentage stopped being
    // scanned at all.
    const clauses = valueClauses(value);
    for (const [vocabLocale, claims] of Object.entries(LOCALE_CLAIMS)) {
      for (const pattern of claims.permanence) {
        const hit = clauses.some((clause) => {
          const found = pattern.exec(clause);
          return found !== null && !permanenceHitIsAboutRate(locale, clause, found.index);
        });
        if (hit) {
          faults.push(
            `${locale} ${key}: claims the pass has unbounded duration in ${vocabLocale} vocabulary (${describeClaim(pattern)})`,
          );
        }
      }
    }
    if (!LOCALE_CLAIMS[locale].bounded.test(value)) {
      faults.push(
        `${locale} ${key}: never states, in ${locale}, that the pass is bounded to a running competition`,
      );
    }
  }
  return faults;
}

/**
 * Layer 3. `retired` is the prose this task deleted, per locale; every value is
 * checked against ALL of it, not just its own language's share.
 *
 * Why a literal list is worth keeping next to a vocabulary: the vocabularies
 * cannot include French "pour toute la durée" (true of a bound, false of the
 * pass) or Dutch "voor de helft van het basistarief" (true once "hoogstens" is
 * in front of it). Those are precisely the fragments a translator restores by
 * accident, and a literal has no hole.
 */
export function retiredClaimFaults(values: LocalisedValue[], retired: string[]): string[] {
  const faults: string[] = [];
  if (retired.length === 0) {
    return ["retired-claim registry is empty — this layer would examine nothing"];
  }
  for (const { locale, key, value } of values) {
    const haystack = value.toLowerCase();
    for (const phrase of retired) {
      if (haystack.includes(phrase.toLowerCase())) {
        faults.push(`${locale} ${key}: still carries the retired claim "${phrase}"`);
      }
    }
  }
  return faults;
}

/** The one-time credit grant, in a language-independent way: the FIGURE. Digits
 *  are the same in all four locales, which is what makes this checkable without
 *  a fourth vocabulary — and it is paired with the recurring-cadence negative so
 *  "+25 AI credits every month" cannot satisfy it.
 *
 *  Entitlements v18 / W2 T5: `grants` is the SET the pass declares (25 on M, 50
 *  on L), because the string this is pointed at — the /pricing FAQ answer — is
 *  one sentence covering both rungs. Every declared grant must appear, so an
 *  answer that quotes M's and forgets L's is a fault; and any OTHER `+N` is
 *  still drift. An empty set would examine nothing, so it is a fault too. */
export function localeCreditGrantFaults(
  values: LocalisedValue[],
  grants: readonly number[],
): string[] {
  const faults: string[] = [];
  if (grants.length === 0) return ["credit-grant set is empty — this rule would examine nothing"];
  for (const { locale, key, value } of values) {
    for (const grant of grants) {
      if (!value.includes(`+${grant}`)) {
        faults.push(`${locale} ${key}: does not state the one-time +${grant} AI credit grant`);
      }
    }
    for (const match of value.matchAll(/\+(\d[\d,]*)\b/g)) {
      const figure = Number(match[1]!.replace(/,/g, ""));
      if (!grants.includes(figure)) {
        faults.push(
          `${locale} ${key}: quotes +${figure}, but the pass grants +${grants.join(" / +")}`,
        );
      }
    }
    for (const pattern of LOCALE_CLAIMS[locale].recurring) {
      if (pattern.test(value)) {
        faults.push(`${locale} ${key}: sells the one-time grant as recurring (${describeClaim(pattern)})`);
      }
    }
  }
  return faults;
}

/** `plan_entitlements` boolean rows, as `{ feature: { plan: granted } }`. */
export type FeatureGrants = Record<string, Record<string, boolean>>;

/**
 * #382 review, finding 1 — the sibling claim, pointed the other way.
 *
 * `localePlusDifferentiatorFaults` judges "Pro Plus adds X over the PLANS
 * below it". This judges "Pro adds X the PASS never covers" — the upgrade
 * page's Pro card (`upgrade.proCard.body`), shown to a community organiser
 * with no pass, which is exactly the organiser who has just been stopped by
 * the `scheduling.multi_division` gate and sent here to buy something.
 *
 * V353 made that card argue against the purchase it is sitting next to. It
 * listed "the schedule board" among the things the pass never covers, while
 * V353 granted `scheduling.board` to every plan AND `scheduling.multi_division`
 * to the pass — so the $29 Event Pass shown directly above now covers, for this
 * competition, the very capability the Pro card says it never covers.
 * "Officials" was the same shape: `officials.marks` and `officials.roles_multi`
 * are true on community and on the pass, and `officials.auto` is pro_plus-only,
 * so no officials capability is a Pro-over-pass advantage at all.
 *
 * WHY THE GRANTS AND NOT A BANNED PHRASE, same reasoning as the sibling: if a
 * later migration took `scheduling.board` off the pass, "the pass never covers
 * the schedule board" becomes TRUE and this guard must fall silent.
 *
 * A feature with NO `event_pass` row is genuinely uncovered, not unknown: the
 * pass overlay in `resolveFromDb` falls THROUGH to the plan row for any key the
 * pass matrix omits, so an absent row means the pass adds nothing on that axis.
 * That is why `stats.player` and `api.access` — neither of which has an
 * `event_pass` row — stay in the card as real Pro advantages.
 *
 * Anti-vacuity, as everywhere here: a value that names no recognised capability
 * has had this guard examine nothing, and that is itself a fault. Without it,
 * deleting the list would pass.
 */
export function localePassUncoveredFaults(
  values: LocalisedValue[],
  grants: FeatureGrants,
): string[] {
  // Kept local rather than added to `LOCALE_CLAIMS`, following
  // `aiOfficialsPlanGateFaults`: this vocabulary is scoped to ONE claim on ONE
  // key, and the non-English halves go through `claim()` because `\b` and `\w`
  // are ASCII-only in JavaScript (see the header over `LOCALE_CLAIMS`).
  const vocab: Array<[feature: string, byLocale: Record<DictionaryLocale, RegExp>]> = [
    [
      "scheduling.board",
      {
        en: /\b(schedule|scheduling|multi-division)\s+board\b/i,
        es: claim(String.raw`\btabler\w*\s+de\s+(planificaci\w+|programaci\w+|horarios)\b`),
        fr: claim(String.raw`\btableau\s+de\s+(planification|programmation)\b`),
        nl: claim(String.raw`\bplanningsbord\b|\bplanningsboard\b`),
      },
    ],
    [
      "officials.marks",
      {
        en: /\bofficials?\b|\breferees?\b/i,
        es: claim(String.raw`\boficiales\b|\b\wrbitros\b`),
        fr: claim(String.raw`\bofficiels\b|\barbitres\b`),
        nl: claim(String.raw`\bofficials\b|\bscheidsrechters\b`),
      },
    ],
    [
      "stats.player",
      {
        en: /\bplayer\s+stat(istic)?s\b/i,
        es: claim(String.raw`\bestad\wsticas\s+de\s+jugadores\b`),
        fr: claim(String.raw`\bstatistiques\s+des\s+joueurs\b`),
        nl: claim(String.raw`\bspelersstatistieken\b`),
      },
    ],
    [
      "api.access",
      {
        en: /\bAPI\b/i,
        es: claim(String.raw`\bAPI\b`),
        fr: claim(String.raw`\bAPI\b`),
        nl: claim(String.raw`\bAPI\b`),
      },
    ],
  ];

  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    let recognised = 0;
    for (const [feature, byLocale] of vocab) {
      if (!byLocale[locale].test(value)) continue;
      recognised += 1;
      const row = grants[feature];
      if (!row) {
        faults.push(`${locale} ${key}: names ${feature}, which has no rows in plan_entitlements`);
        continue;
      }
      if (row.event_pass) {
        faults.push(
          `${locale} ${key}: sells ${feature} as something the Event Pass never covers, but event_pass grants it`,
        );
      }
      if (!row.pro) {
        faults.push(`${locale} ${key}: sells ${feature} as a Pro advantage, but pro does not grant it`);
      }
    }
    if (recognised === 0) {
      faults.push(
        `${locale} ${key}: names no recognised capability — the ${locale} vocabulary has gone stale and this guard examined nothing`,
      );
    }
  }
  return faults;
}

/**
 * ── THE INVERSE OF `localePassUncoveredFaults`, AND OF `freeClaimFaults` ────
 *
 * `freeClaimFaults` catches a paywall REASON calling a pass-granted key "a Pro
 * feature" — twelve of them, W2 (entitlements v18) 2026-09-05. Both misreads
 * are the same class pointed opposite ways: a plan attribution that has gone
 * stale against `plan_entitlements`. But `freeClaimFaults` is keyed to ONE ROW
 * per sentence — `lib/feature-copy.ts`'s `FEATURE_REASONS` map is
 * `feature_key -> reason`, so the guard always knows which row a reason is
 * ABOUT. A pricing-card bullet carries no such key: "Advanced formats —
 * double elim, ladders" is free prose illustrating ONE row
 * (`formats.advanced`, the actual paid differentiator) with EXAMPLES, and one
 * of those examples is itself a SEPARATE row (`formats.double_elim`) that
 * community has granted since the V393 growth cell — Free already had double
 * elimination. The bullet's own header ("Advanced formats") was true; its
 * illustrative half was the concrete claim a reader believes, and it was
 * false. `pricing-cards.test.ts`'s `cardBooleanFaults` cannot see this either:
 * it only proves a claimed row IS granted to the plans that claim it, never
 * that an EXAMPLE beside the claim names a DIFFERENT, already-free row.
 *
 * So — like `localePassUncoveredFaults` — this guard recognises capabilities
 * by VOCABULARY (a phrase can appear in prose with no key attached), but it
 * judges each recognised phrase against ITS OWN feature_key rather than the
 * row the bullet nominally illustrates, because the phrase is the half a
 * reader actually believes.
 *
 * DERIVED FROM THE LIVE MATRIX, NEVER A HARDCODED OFFENDING SET: an entry
 * names a PHRASE and the feature_key it is a claim about; whether quoting
 * that phrase is currently false is read from `grants` on every call, so the
 * day a migration moves that cell the other way, this rule falls silent on
 * its own — exactly as `localePassUncoveredFaults`'s own "must fall silent
 * when the matrix moves" case proves for its half of this pair.
 *
 * THE VOCABULARY IS DELIBERATELY SMALL, and every entry is commented with why
 * it exists — a wide "any capability word" list is unreviewable and, per the
 * header note over this file, exactly the shape ("A DENYLIST OF PHRASINGS")
 * that lets the same falsehood back in reworded. Three entries:
 *
 *  - `formats.double_elim`: the phrase THIS TASK'S DEFECT USED ("double elim"
 *    / "double elimination"). Community grants it, so any bullet naming it is
 *    a fault regardless of which row the bullet is nominally selling.
 *  - `formats.advanced`: "americano" / "ladders", the examples the fixed
 *    copy uses instead (design doc
 *    2026-09-02-entitlements-v18-three-tier-design.md §2: "americano,
 *    ladders, custom brackets, feeds"). Community does NOT grant this row, so
 *    these phrases must NEVER fault — carrying them here is what makes the
 *    rule DISCRIMINATING rather than a blanket "double elim" ban: it proves
 *    the guard is judging the MATRIX, not pattern-matching a banned word,
 *    because the same shape of entry (a phrase mapped to a feature_key) reds
 *    for one row and stays silent for the other, on the same bullet.
 *  - `stats.player`: "player stats", the W3-A defect's own phrase (2026-09-06,
 *    V399). `stats.player` (the per-division RECORD) went free on every plan
 *    in that migration — the SAME falsehood class `formats.double_elim`
 *    demonstrated one wave earlier, on the survivor of that fix
 *    (`pricing.pro.f4` had already been through one rewrite, W1, for a
 *    DIFFERENT reason, and still carried a claim that went false under it).
 *    No discriminating sibling entry is needed here the way `formats.advanced`
 *    pairs with `formats.double_elim`: the still-gated half of the same split,
 *    `stats.player.career`, is described with a DIFFERENT phrase ("career
 *    stats") that this pattern does not match at all — the discrimination is
 *    structural (the two feature keys' example phrases share no words), not a
 *    second vocabulary entry standing guard over one that would otherwise be
 *    a blanket ban.
 *
 * ANTI-VACUITY, both halves: `PAID_OVERCLAIM_VOCAB.length === 0` is checked
 * FIRST, before any loop — an empty vocabulary would otherwise fall through
 * every string and return `[]`, indistinguishable from "scanned and clean".
 * (Three vacuous "empty set answers no to every question" defects have
 * shipped in this repo already; this is that failure mode's precondition,
 * caught before the loop rather than left to be inferred from silence.) The
 * SECOND half — the vocabulary must actually MATCH at least one real shipped
 * string, not just be non-empty — is proved in
 * `dictionary-copy-truth.test.ts` against the literal pre-fix wording this
 * task replaced, never a synthetic fixture: a vocabulary that only recognises
 * strings nobody ships is equally silent.
 */
export const PAID_OVERCLAIM_VOCAB: Array<[feature: string, byLocale: Record<DictionaryLocale, RegExp>]> = [
  [
    "formats.double_elim",
    {
      en: /\bdouble[- ]elim(?:ination)?\b/i,
      es: claim(String.raw`\bdoble\s+eliminaci[oó]n\b`),
      fr: claim(String.raw`\bdouble\s+[ée]limination\b`),
      nl: claim(String.raw`\bdubbele\s+eliminatie\b`),
    },
  ],
  [
    "formats.advanced",
    {
      en: /\b(americano|ladders?)\b/i,
      es: claim(String.raw`\b(americano|escaleras?)\b`),
      fr: claim(String.raw`\b(americano|[ée]chelles?)\b`),
      nl: claim(String.raw`\b(americano|ladders?)\b`),
    },
  ],
  [
    "stats.player",
    {
      en: /\bplayer\s+stats\b/i,
      es: claim(String.raw`\bestad[ií]sticas\s+de\s+jugador(?:es)?\b`),
      fr: claim(String.raw`\bstatistiques\s+(?:des?\s+)?joueurs?\b`),
      nl: claim(String.raw`\bspelers?statistieken\b`),
    },
  ],
];

/**
 * Every plan name this product prints, in the ONE spelling all four locales
 * use.
 *
 * Untranslated on purpose, and that is what makes this rule locale-robust
 * rather than an English guard silently passing three dictionaries: "Pro",
 * "Event Pass" and "Enterprise" are proper nouns here and ship identically in
 * es/fr/nl (`upgrade.rung.m` is "Event Pass M" in all four). A rule phrased
 * around English GRAMMAR — `PRO_ATTRIBUTION` and its siblings above — cannot
 * make that claim, which is why those take a per-locale vocabulary and this
 * does not.
 *
 * Its own constant rather than reusing `PAID_PLAN_NAME`: that one is missing
 * Enterprise, and widening it would change what several unrelated rules judge.
 */
export const ANY_PLAN_NAME = /\b(?:Pro Plus|Pro|Event Pass|Enterprise|Community)\b/i;

/**
 * The beyond-plan card's sentence — shown ONLY to an org already on a paid
 * plan, when a gate fired because of that plan's own ceiling (v18 W3-B).
 *
 * It must name no plan at all, in any locale. Every other paywall sentence in
 * this product exists to attribute a capability to a tier; this one is shown
 * to a reader for whom every such attribution is either something they already
 * hold ("Pro") or a negotiation a sentence cannot conduct ("Enterprise"). The
 * failure it guards against is concrete and was the shipped behaviour: the
 * card said "See plans & upgrade" to an org whose plan was in that list.
 *
 * ANTI-VACUITY, both halves. An empty `values` is reported rather than passing
 * — a rule that examines nothing is the failure mode this file has hit twice —
 * and so is a call that supplies fewer than the four dictionaries, because a
 * plan name reaching only `fr` is exactly the shape a locale-blind sweep
 * misses.
 */
export function beyondPlanCopyFaults(values: readonly LocalisedValue[]): string[] {
  if (values.length === 0) {
    return ["no beyond-plan copy supplied — this rule would examine nothing"];
  }
  const faults: string[] = [];
  const seen = new Set(values.map((v) => v.locale));
  for (const locale of DICTIONARY_LOCALES) {
    if (!seen.has(locale)) faults.push(`${locale}: beyond-plan copy was not supplied`);
  }
  for (const { locale, key, value } of values) {
    if (value.trim() === "") {
      faults.push(`${locale} ${key}: empty — the card would render a heading over nothing`);
      continue;
    }
    const named = ANY_PLAN_NAME.exec(value);
    if (named) {
      faults.push(
        `${locale} ${key}: names "${named[0]}" to a reader who already holds the top self-serve tier`,
      );
    }
  }
  return faults;
}

export function localePaidOverclaimFaults(
  values: LocalisedValue[],
  grants: FeatureGrants,
): string[] {
  // STATE THE EMPTY CASE FIRST — see the header comment above for why.
  if (PAID_OVERCLAIM_VOCAB.length === 0) {
    return ["paid-overclaim vocabulary is empty — this rule would examine nothing"];
  }
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    for (const [feature, byLocale] of PAID_OVERCLAIM_VOCAB) {
      if (!byLocale[locale].test(value)) continue;
      const row = grants[feature];
      if (!row) {
        faults.push(`${locale} ${key}: names ${feature}, which has no rows in plan_entitlements`);
        continue;
      }
      if (row.community) {
        faults.push(
          `${locale} ${key}: sells ${feature} as a paid differentiator, but community already grants it`,
        );
      }
    }
  }
  return faults;
}

/**
 * The comparative "the largest monthly AI credit grant". A boolean-grant guard
 * cannot judge it: it is true only while ONE plan's `ai.credits.monthly` is
 * strictly greater than every other plan's, so it is checked against the
 * numbers, in every locale.
 *
 * Paired both ways, like every presence rule here: the claim must be STATED (an
 * answer that just deletes it tells a buyer nothing about what they get) and it
 * must be TRUE.
 *
 * W2 (entitlements v18): the leading plan is now an ARGUMENT. It was hardcoded
 * `pro_plus`, and V393 deleted that plan — so the guard compared `undefined`
 * against everything, reported the claim false in four locales, and named a
 * plan that no longer exists in its own failure message. The live ordering is
 * enterprise 500 > pro 25 > community 5 (V393 + V395), and enterprise is a
 * Contact-us strip rather than a priced card, so a caller has to say which plan
 * its copy is claiming leadership FOR rather than inherit yesterday's answer.
 */
export function localeCreditLeadershipFaults(
  values: LocalisedValue[],
  monthlyGrants: Record<string, number | null>,
  leader: string,
): string[] {
  const faults: string[] = [];
  const lead = monthlyGrants[leader];
  const others = Object.entries(monthlyGrants).filter(([plan]) => plan !== leader);
  const leads =
    typeof lead === "number" &&
    others.length > 0 &&
    others.every(([, value]) => typeof value === "number" && value < lead);

  for (const { locale, key, value } of values) {
    const stated = LOCALE_CLAIMS[locale].creditLeadership.test(value);
    if (!stated) {
      faults.push(`${locale} ${key}: never claims the largest monthly AI credit grant`);
    } else if (!leads) {
      faults.push(
        `${locale} ${key}: claims the largest monthly AI credit grant, but ${leader} grants ${lead} against ${others
          .map(([plan, v]) => `${plan}=${v}`)
          .join(", ")}`,
      );
    }
  }
  return faults;
}

/**
 * Which comparison the extra-organisation rate ACTUALLY licenses, derived from
 * the seed rather than asserted.
 *
 * "exactly" only if every rider in every plan × interval × currency is exactly
 * half; otherwise the honest claim is "no more than half". Measured on today's
 * seed: `seazn_pro_monthly` eur 1800→900 and aud 2800→1400 are exactly 50.0%,
 * while usd is 47.4% — so a bare "half" is false in usd and "under half" is
 * false in eur. Only "no more than half" is true in all twenty combinations,
 * and deriving the shape here is what keeps the copy honest in EITHER direction
 * if a price moves.
 */
export function riderClaimShape(plans: PricedPlan[]): "exactly" | "atMost" {
  for (const plan of plans) {
    for (const price of Object.values(plan.prices)) {
      const base = price.tiers?.find((t) => t.up_to === 1);
      const rider = price.tiers?.find((t) => t.up_to === "inf");
      if (!base || !rider) return "atMost";
      for (const currency of SEED_CURRENCIES) {
        const baseAmount = amountIn(base, currency);
        const riderAmount = amountIn(rider, currency);
        if (baseAmount === undefined || riderAmount === undefined) return "atMost";
        if (riderAmount !== baseAmount / 2) return "atMost";
      }
    }
  }
  return "exactly";
}

/**
 * The half-rate sentence, four locales, against the shape the seed licenses.
 *
 * Paired, again: the claim must be MADE (an answer that drops it leaves a buyer
 * with no idea what a second organisation costs) and it must carry the
 * qualifier the arithmetic requires. And note the guard is not "always demand
 * 'no more than'" — if every rider became an exact half, `riderClaimShape`
 * returns "exactly" and an unqualified "half the base rate" stops being a
 * fault, because it stops being false.
 */
export function localeHalfClaimFaults(
  values: LocalisedValue[],
  shape: "exactly" | "atMost",
): string[] {
  const faults: string[] = [];
  for (const { locale, key, value } of values) {
    const claims = LOCALE_CLAIMS[locale];
    // CLAUSE-SCOPED, not value-scoped. Value-scoped was wrong-clause
    // satisfaction — the third occurrence of that defect in this wave: append
    // a bare "each extra one at half the base rate" to a value whose EARLIER
    // clause already said "no more than half", and the qualifier from the first
    // clause answered for the second. The qualifier has to be in the clause
    // that makes the claim, or it qualifies nothing.
    const claiming = valueClauses(value).filter((c) => claims.halfClaim.test(c));
    if (claiming.length === 0) {
      faults.push(`${locale} ${key}: makes no statement about the extra-organisation rate`);
      continue;
    }
    if (shape !== "atMost") continue;
    for (const clause of claiming) {
      if (!claims.atMostHalf.test(clause)) {
        faults.push(
          `${locale} ${key}: "${clause.slice(0, 56)}" quotes half the base rate with no "no more than" qualifier, but the seed's riders are not all exactly half`,
        );
      }
    }
  }
  return faults;
}

// ── THE APPROVED-WORDING GATE, for four-locale dictionary values ─────────────
//
// The positive half of this file's guards, and the one that does not depend on
// anyone having imagined the right falsehood.
//
// Every rule above reads a sentence and decides whether it is false. Four
// independent measurements in this wave say that shape scores on the examples
// its author imagined and collapses on anyone else's — task 3 went 12/12 to
// 6/30, task 4 went 16/16 to 0/32, and a percentage-shaped rate clause scored
// 0/9 against a rule written specifically about rate clauses. Worse, the
// falsehood that survived two rounds of widening (`pricing.faq.groups.a`, "half
// your plan's rate", four locales) had a pattern written for it ALREADY; nobody
// had pointed the rule at that key.
//
// A pinned string has neither failure mode. It does not generalise, so no
// rewording evades it, and it needs no claim-family coverage — the value either
// is the approved value or it is not. The vocabulary rules stay as the
// SECONDARY net, for copy that is not yet pinned.

/** One approved dictionary value, in every locale. See `_approved-dictionary-copy.ts`. */
export interface ApprovedValue {
  file: "marketing" | "ui";
  key: string;
  why: string;
  text: Record<DictionaryLocale, string>;
}

/**
 * The gate. `read(file, locale)` returns the flat dictionary — flat dotted keys,
 * never nested traversal.
 *
 * The fault carries the on-disk string verbatim so the reviewer's step is to
 * read it against `why` and paste it in, not to retype it. A missing key is a
 * fault of its own: an approved entry pointing at nothing is a rule that has
 * quietly stopped covering anything.
 */
export function approvedDictionaryFaults(
  approved: ApprovedValue[],
  read: (file: "marketing" | "ui", locale: DictionaryLocale) => Record<string, string>,
): string[] {
  const faults: string[] = [];
  if (approved.length === 0) return ["the approved-copy inventory is empty — this gate examines nothing"];
  for (const entry of approved) {
    for (const locale of DICTIONARY_LOCALES) {
      const onDisk = read(entry.file, locale)[entry.key];
      if (typeof onDisk !== "string") {
        faults.push(`${locale} ${entry.key}: approved but ABSENT from ${entry.file}.json`);
        continue;
      }
      const want = entry.text[locale];
      if (want === undefined) {
        faults.push(`${entry.key}: no approved ${locale} wording — every locale must be approved together`);
        continue;
      }
      if (onDisk !== want) {
        faults.push(
          [
            `${locale} ${entry.key}: wording changed and has not been re-approved.`,
            `  what it claims: ${entry.why}`,
            `  approved: ${want}`,
            `  on disk:  ${onDisk}`,
          ].join("\n"),
        );
      }
    }
  }
  return faults;
}

// ── MODULE-WIDE ANTI-VACUITY ─────────────────────────────────────────────────
//
// TWICE IN THIS WAVE A GUARD HAS PASSED WHILE EXAMINING NOTHING, and neither
// was caught by the suite that owned it:
//
//  1. the French permanence list could not match its own language, because JS
//     `\b` is ASCII-only and `/\bà\s+vie\b/` never fires (task 4 found it);
//  2. `DURATION_CLAIM` matched NOTHING AT ALL — a stray control character where
//     `\b` belonged, introduced by tooling — and the suite stayed green because
//     a sibling rule happened to cover the same fixtures (task 3 found it).
//
// Both are the same class: a pattern that is *syntactically* valid, compiles
// without error, and silently matches nothing. Every assertion built on it then
// reports clean. This makes every other guard in the file untrustworthy, so the
// check belongs to the MODULE rather than to any one rule.
//
// `collectPatterns` walks the module's exported values — including patterns
// nested in arrays, in `LOCALE_CLAIMS`, and in the `[feature, RegExp]` tuples —
// so a pattern cannot escape by being somewhere new. A caller then asserts:
//   - no pattern source contains a CONTROL CHARACTER (defect 2's signature);
//   - every pattern matches at least one string in a known-positive corpus
//     (defect 1's signature: a pattern that can never fire).
// Adding a pattern therefore requires adding a fixture it matches, which is the
// cheapest possible proof that the pattern does something.

/** One regex found anywhere in the module's exports, with the path to it. */
export interface LocatedPattern {
  path: string;
  pattern: RegExp;
}

export function collectPatterns(module: Record<string, unknown>): LocatedPattern[] {
  const found: LocatedPattern[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string): void => {
    if (node instanceof RegExp) {
      found.push({ path, pattern: node });
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
  };
  for (const [name, value] of Object.entries(module)) walk(value, name);
  return found;
}

/** Control characters are never intentional in a hand-written pattern; they are
 *  what a broken edit leaves behind where an escape belonged. */
const CONTROL_CHARACTER = /[\x00-\x1F\x7F]/;

export function controlCharacterFaults(patterns: LocatedPattern[]): string[] {
  return patterns
    .filter(({ pattern }) => CONTROL_CHARACTER.test(pattern.source))
    .map(
      ({ path, pattern }) =>
        `${path}: pattern source contains a control character (U+${pattern.source
          .split("")
          .find((c) => CONTROL_CHARACTER.test(c))!
          .charCodeAt(0)
          .toString(16)
          .padStart(4, "0")}) — almost certainly a mangled escape`,
    );
}

/**
 * `collectPatterns` walks module EXPORTS, so a top-level pattern that is not
 * exported is invisible to it — and seven were, including `DURATION_CLAIM`,
 * which this very check names as reason #2 for existing. Measured: a literal
 * U+0001 in `DURATION_CLAIM` left the suite 36/36 green, while the identical
 * byte in an exported pattern redded three tests.
 *
 * So the reachability is enforced at the SOURCE level rather than trusted: any
 * top-level `const NAME = <pattern>` that is not exported is a fault, because
 * nothing downstream can see it. `CONTROL_CHARACTER` is the one legitimate
 * exception — it is the checker, not a claim, and demanding it match a
 * known-positive fixture would mean putting a control character in the corpus.
 *
 * #338 item 4 (second vacuity hole): this was LINE-SHAPED — `=\s*(\/|new
 * RegExp\b|claim\()` requires the pattern to sit immediately after the `=`,
 * so it sees `const NAME = /…/` but not a pattern one token further in, inside
 * a CONTAINER. `const ZZ_PROBE_LIST: RegExp[] = [/(?!x)x-inert/i]` shipped
 * green: the `=` is followed by `[`, not `/`, so the line never matched at
 * all — invisible to `collectPatterns` (it only walks exports) AND to this
 * check (it only recognised the pattern immediately after `=`). Now it looks
 * for a regex literal, `new RegExp(`, or `claim(` ANYWHERE after the `=` on
 * the same line, so it does not matter how many array or object brackets sit
 * between them.
 *
 * Deliberately NOT exported-container-transparent across MULTIPLE lines: a
 * declaration whose regex literal is on a later line than `const NAME =` is
 * still invisible to this check, the same residual limit the line-based scan
 * always had. Recorded rather than fixed — closing it needs a token walk of
 * the whole declaration, not a per-line regex.
 */
const PATTERN_SHAPED = /=[^\n]*?(?:\/(?:[^/\\\n]|\\.)+\/[a-z]*\b|new\s+RegExp\s*\(|claim\s*\()/;
export const UNEXPORTED_PATTERN_ALLOWLIST = ["CONTROL_CHARACTER", "PATTERN_SHAPED"];

export function unexportedPatternFaults(moduleSource: string): string[] {
  const faults: string[] = [];
  for (const line of moduleSource.split("\n")) {
    const match = /^const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/.exec(line);
    if (!match || !PATTERN_SHAPED.test(line)) continue;
    const name = match[1]!;
    if (UNEXPORTED_PATTERN_ALLOWLIST.includes(name)) continue;
    faults.push(
      `${name}: a top-level pattern that is not exported — collectPatterns cannot see it, so it is exempt from every anti-vacuity rule below. Add \`export\`.`,
    );
  }
  return faults;
}

/**
 * The control-character scan, run over the module's RAW SOURCE rather than over
 * compiled patterns. Belt and braces: it catches a mangled escape anywhere in
 * the file — in a non-exported const, in a `String.raw` fragment that is only
 * ever composed into another pattern, or in ordinary prose — none of which the
 * compiled-pattern scan can reach. Tabs and newlines are legitimate source.
 */
export function sourceControlCharacterFaults(moduleSource: string): string[] {
  const faults: string[] = [];
  moduleSource.split("\n").forEach((line, i) => {
    const found = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.exec(line);
    if (found) {
      faults.push(
        `line ${i + 1}: literal control character U+${found[0]!.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()} in the source — almost certainly a mangled escape`,
      );
    }
  });
  return faults;
}

/** Every pattern must fire on SOMETHING. One that matches nothing in the corpus
 *  is either dead or untested, and the two are indistinguishable from here. */
export function inertPatternFaults(patterns: LocatedPattern[], corpus: string[]): string[] {
  return patterns
    .filter(({ pattern }) => !corpus.some((text) => pattern.test(text)))
    .map(
      ({ path, pattern }) =>
        `${path}: matches nothing in the known-positive corpus (${describeClaim(pattern)}) — it is inert, and every assertion resting on it reports clean`,
    );
}

// ── The fee ladder table, against the matrix ─────────────────────────────────

/** Which `plan_entitlements.plan_key`s a fee-ladder row is a claim about. The
 *  Event Pass row is a claim about BOTH rungs — they share the 5% rate, and a
 *  rung whose rate moved would otherwise be invisible in this table. */
export const FEE_LADDER_PLAN_KEYS: Record<string, string[]> = {
  Community: ["community"],
  "Event Pass": ["event_pass", "event_pass_l"],
  Pro: ["pro"],
  // W2 (entitlements v18): "Pro Plus" -> "Enterprise". V393 deleted `pro_plus`
  // from `plans`, and the 1% floor moved onto `enterprise` — so the ladder's
  // bottom rung kept its rate and changed its name. The LABEL is what a reader
  // sees in the table, which is why this map is keyed on it rather than on the
  // plan key: a row nobody can buy any more is still a row that lies.
  Enterprise: ["enterprise"],
};

/** `| Community | 5% |` rows, from a markdown fee table. */
export function feeLadderRows(section: string): Array<{ plan: string; percent: number }> {
  const rows: Array<{ plan: string; percent: number }> = [];
  for (const line of section.split("\n")) {
    const match = /^\|\s*([^|]+?)\s*\|\s*(\d+(?:\.\d+)?)\s*%\s*\|/.exec(plainProse(line));
    if (match) rows.push({ plan: match[1]!, percent: Number(match[2]) });
  }
  return rows;
}

/** One fee-ladder table found in an article: its header line, and its rows. */
export interface FeeLadderTable {
  header: string;
  rows: Array<{ plan: string; percent: number }>;
}

/**
 * EVERY fee-ladder table in a markdown article, found by SHAPE rather than by
 * heading — and this function exists because the guard below was scoped to one
 * FILE for a whole wave.
 *
 * `feeLadderFaults` was called with `markdownSection(plans.md, /platform fee/i)`
 * and nothing else, while `billing/groups.md` and `registration/card-payments.md`
 * carried their own copies of the same table. Both still read `| Pro Plus | 1% |`
 * after plans.md had been corrected, because nothing pointed the rule at them —
 * the scoping decision lived at a call site several hundred lines from the
 * function that looked authoritative.
 *
 * Shape, not filename and not heading: a run of contiguous `|` lines counts as a
 * fee ladder when EITHER its header mentions a fee (so a table whose plan names
 * were all renamed at once is still caught) OR at least two of its rows name a
 * plan the ladder knows (so a table whose heading was reworded still is). Either
 * alone has a blind spot; the disjunction has neither.
 *
 * Deliberately NOT matched: `billing/event-pass.md`'s comparison table, whose
 * fee row is TRANSPOSED — `| Platform fee on entry fees | 4% | 4% |`, one column
 * per rung rather than one row per plan. Its header names the two rungs and
 * their prices, and its first cell is empty, so neither clause fires. That row
 * is a fee claim and it is guarded, by `passFeeRowFaults` below; it is a
 * different rule because it is a different table.
 */
export function feeLadderTables(markdown: string): FeeLadderTable[] {
  const tables: FeeLadderTable[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const rows = feeLadderRows(run.join("\n"));
      const named = rows.filter((r) => FEE_LADDER_PLAN_KEYS[r.plan]).length;
      if (/\bfees?\b/i.test(run[0]!) || named >= 2) tables.push({ header: run[0]!, rows });
    }
    run = [];
  };
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("|")) run.push(line.trim());
    else flush();
  }
  flush();
  return tables;
}

/**
 * The transposed fee row — one column per Event Pass rung — against the live
 * matrix.
 *
 * `event-pass.md` sells both rungs side by side, so its fee claim is a ROW of
 * rates rather than a column of plans, and `feeLadderTables` cannot read it.
 * The rule it can still enforce without inferring which column is which rung:
 * EVERY rate in that row must be a rate some pass rung actually charges, and
 * the rungs must all charge the same one. Both rungs have shared a rate since
 * V270, and if they ever stop, this reds — which is the right outcome, because
 * a two-rung table with two different rates needs a guard that knows its
 * column order, and nobody should discover that silently.
 */
export function passFeeRowFaults(
  label: string,
  markdown: string,
  passRates: Record<string, number | null>,
): string[] {
  const keys = Object.keys(passRates);
  if (keys.length === 0) return [`${label}: no pass rates supplied — this scan would pass vacuously`];
  const rates = new Set(keys.map((k) => passRates[k]));
  const line = markdown
    .split("\n")
    .map((l) => plainProse(l.trim()))
    .find((l) => /^\|\s*Platform fee/i.test(l));
  if (!line) return [`${label}: no transposed "Platform fee" row found — the table's shape changed`];
  const quoted = [...line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  const faults: string[] = [];
  // One rate per rung the table sells, DERIVED from what the caller supplied —
  // it was a hardcoded 2 while the article sold two rungs, and a literal beside
  // a derived quantity is a latent red: the L rung came off sale on 2026-09-05,
  // the table lost its second column, and the guard failed on an article that
  // had just been made correct.
  if (quoted.length < keys.length) {
    faults.push(
      `${label}: the fee row quotes ${quoted.length} rate(s), but the table sells ${keys.length} rung(s)`,
    );
  }
  if (rates.size > 1) {
    faults.push(
      `${label}: the pass rungs no longer share one rate (${keys.map((k) => `${k}=${passRates[k]}`).join(", ")}) — this row cannot say which column is which, so it needs a column-aware guard`,
    );
    return faults;
  }
  const [live] = [...rates];
  for (const percent of quoted) {
    if (percent !== live) {
      faults.push(`${label}: the fee row quotes ${percent}%, but every pass rung enforces ${live}%`);
    }
  }
  return faults;
}

/**
 * The published fee ladder against `registration.fee_percent`, both ways: a row
 * quoting a rate we do not charge, and a plan we charge that the table has
 * stopped listing. The second matters as much — the table is the page a reader
 * is sent to from four other articles, and a silently dropped row reads as "that
 * plan has no platform fee".
 */
export function feeLadderFaults(
  rows: Array<{ plan: string; percent: number }>,
  live: Record<string, number | null>,
  /**
   * Which ladder LABELS this table must carry. Defaults to all of them, which
   * is right for a table headed "Plan"; a table headed "The group's plan"
   * legitimately omits Event Pass, because a competition-scoped pass is not a
   * plan a billing group can be on and a row for it would be a falsehood
   * rather than a completeness win. The caller declares the subset WITH ITS
   * REASON, so an omission is a recorded decision instead of a silent gap —
   * which is the failure this whole function has already had once, at a
   * different level (it was scoped to a single file while three articles
   * carried the table).
   */
  require: readonly string[] = Object.keys(FEE_LADDER_PLAN_KEYS),
): string[] {
  const faults: string[] = [];
  const seen = new Set<string>();
  for (const label of require) {
    if (!FEE_LADDER_PLAN_KEYS[label]) {
      faults.push(`fee ladder: required label "${label}" is not a ladder row at all`);
    }
  }
  for (const { plan, percent } of rows) {
    const keys = FEE_LADDER_PLAN_KEYS[plan];
    if (!keys) {
      faults.push(`fee ladder: row "${plan}" matches no plan key`);
      continue;
    }
    seen.add(plan);
    for (const key of keys) {
      if (live[key] !== percent) {
        faults.push(`fee ladder: "${plan}" quotes ${percent}%, but ${key} enforces ${live[key]}%`);
      }
    }
  }
  for (const plan of require) {
    if (!seen.has(plan)) faults.push(`fee ladder: no row for ${plan}`);
  }
  return faults;
}

// ── Per-plan CAPACITY claims, against the matrix ─────────────────────────────
//
// WHY THIS EXISTS, AND WHY IT IS NOT `feeLadderFaults` WITH DIFFERENT COLUMNS.
//
// `directory/clubs-and-teams.md` published a four-row, three-column table of
// per-plan limits in which NINE of twelve value cells disagreed with
// `plan_entitlements` — Community's clubs cap read 2 against a live 5, Pro's
// teams cap read 40 against a live 100, and Pro's squad cap read "Unlimited"
// against a hard 40, so an organiser was promised no squad limit and refused at
// the 41st player. Every one of those cells sat inside ~4,000 passing tests.
//
// Nothing red because nothing looked. The fee ladder has a guard; the SCALE
// axes had none, and the two shapes a scale claim takes are exactly the two
// shapes a prose regex cannot read:
//
//   1. A TABLE puts the noun in the column HEADER and the value in a cell, so
//      `/unlimited\s+squad/` never matches `| Pro | 20 | 40 | Unlimited |`.
//      This is the same blind spot `uncappedEntrantCells` was written for in
//      `help-copy-truth.test.ts` after it shipped in the pass comparison table;
//      it has now shipped twice, on two different axes, so the rule is
//      generalised here rather than copied a third time.
//   2. PROSE ELIDES THE NOUN across a clause boundary. "Community orgs get 3
//      members total across all roles; Pro is unlimited" says nothing about
//      members in the clause that carries the falsehood, so word adjacency
//      cannot see it either. The reader carries the noun across the semicolon
//      and so does `planCapProseClaims` below.
//
// Both halves are driven by SHAPE over every article `allHelpArticles()`
// returns — never a filename list, which is the scoping mistake
// `feeLadderTables`' own header records.

/** How a reader names one capped scale axis: as a table COLUMN, and as a NOUN. */
export interface PlanCapAxis {
  /** The `plan_entitlements.feature_key` the claim is about. */
  feature: string;
  /** A table column header, matched WHOLE — a header cell is a label, not prose. */
  column: RegExp;
  /** The noun the same axis takes in a sentence. */
  noun: RegExp;
}

/**
 * The org-scale axes a help article quotes per plan.
 *
 * `teams?` is NEGATIVE-LOOKAHEAD'd against "team member(s)", which is what
 * `plans.md` calls a SEAT: without it "10 team members" reads as a teams.max
 * claim of 10 against a live 100 and the guard reds on true copy. Measured, not
 * anticipated — it was two of the three faults the first sweep of this tree
 * reported, and both were the rule mis-reading correct prose.
 *
 * `entrants.per_division.max` and `divisions.per_competition.max` are NOT here.
 * They are already guarded, by name and by cell, in the Event Pass block of
 * `help-copy-truth.test.ts`; a second rule over the same claim would make each
 * of them individually unkillable by mutation, which is the "two guards
 * covering for each other" failure this repo has shipped before.
 */
export const PLAN_CAP_AXES: readonly PlanCapAxis[] = [
  { feature: "clubs.max", column: /^clubs$/i, noun: /\bclubs?\b/i },
  { feature: "teams.max", column: /^teams$/i, noun: /\bteams?(?!\s+members?\b)\b/i },
  { feature: "teams.squad_max", column: /^squad(\s+size)?$/i, noun: /\bsquads?\b/i },
  { feature: "members.max", column: /^(team\s+)?(members|seats)$/i, noun: /\b(members?|seats?)\b/i },
];

/**
 * Every live plan's DISPLAY NAME to its `plans.key` — the vocabulary both halves
 * below read row labels and prose with.
 *
 * Derived, never hand-typed: `ALL_PLAN_KEYS` is pinned against
 * `select key from plans` by `retired-matrix-keys.test.ts`, and `planLabel` is
 * the same labeller every display call site uses, so a plan that is renamed or
 * retired moves this map with it instead of leaving a guard matching a name
 * nobody can buy. Longest label first at every use site, so "Event Pass L" is
 * never read as "Event Pass" with a stray L.
 */
export const PLAN_KEY_BY_LABEL: Record<string, string> = Object.fromEntries(
  ALL_PLAN_KEYS.map((key) => [planLabel(key), key]),
);

/**
 * The live matrix, as a lookup with THREE outcomes — and the third is the point.
 *
 *   a number   the cap the resolver enforces
 *   null       a row exists with a null `int_value`: genuinely UNLIMITED
 *   undefined  NO ROW AT ALL
 *
 * `getLimit` (lib/entitlements.ts) reads `row ? row.int_value : 0`, so the
 * middle and the third case are opposite answers — unlimited versus refuse
 * everything — and a guard that collapses them into "no number" cannot tell a
 * true "Unlimited" cell from a plan that has no such grant.
 */
export type PlanCapLookup = (feature: string, planKey: string) => number | null | undefined;

/** One value cell of a per-plan capacity table. */
export interface PlanCapCell {
  /** The row label as printed, e.g. "Event Pass". */
  plan: string;
  planKey: string;
  /** The column header as printed, e.g. "Squad size". */
  axis: string;
  feature: string;
  /** The cell's text, formatting stripped. */
  value: string;
}

/** One per-plan capacity table found in an article. */
export interface PlanCapTable {
  header: string;
  cells: PlanCapCell[];
  /** Row labels that are not live plan names — reported, never skipped. */
  unknownRows: string[];
}

/** What a cell says when the cap is genuinely unlimited. "None" is NOT here and
 *  must not be: in a limits column it reads as ZERO, and accepting it would let
 *  a cell say the opposite of unlimited and still satisfy a null matrix row. */
export const UNLIMITED_CELL = /^(unlimited|unbounded|no limit|∞)$/i;
/** A cell that is a bare figure, and nothing else: "20 per club" is a
 *  qualified claim this rule must not read as the cap 20. EXPORTED, like every
 *  pattern in this module, so the module-wide anti-vacuity walk in
 *  `dictionary-copy-truth.test.ts` can prove it still fires. */
export const NUMBER_CELL = /^(\d[\d,]*)$/;

/**
 * EVERY per-plan capacity table in an article, found by SHAPE: a `|` run whose
 * second line is a markdown separator, and at least one of whose column headers
 * names an axis in `PLAN_CAP_AXES`.
 *
 * Keyed on the HEADER, not the heading and not the filename, for the reason
 * `feeLadderTables` records: a guard scoped by name looks authoritative and its
 * real scope lives at a call site hundreds of lines away.
 *
 * @param planKeyByLabel maps a printed row label to a `plans.key`. Passed in
 *   rather than built here so the vocabulary comes from `ALL_PLAN_KEYS` through
 *   `planLabel` — the DB-free authority `retired-matrix-keys.test.ts` already
 *   pins against `select key from plans` — and no guard hand-types a plan name.
 */
export function planCapTables(
  markdown: string,
  planKeyByLabel: Record<string, string>,
): PlanCapTable[] {
  const lines = markdown.split("\n");
  const tables: PlanCapTable[] = [];
  const cellsOf = (line: string): string[] =>
    plainProse(line.trim()).replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim().startsWith("|")) continue;
    const next = lines[i + 1];
    if (!next || !/^\s*\|[\s:|-]+\|\s*$/.test(next)) continue;

    const header = cellsOf(lines[i]!);
    const mapped = new Map<number, PlanCapAxis>();
    header.forEach((h, col) => {
      if (col === 0) return; // the row-label column
      const axis = PLAN_CAP_AXES.find((a) => a.column.test(h));
      if (axis) mapped.set(col, axis);
    });
    if (mapped.size === 0) continue;

    const table: PlanCapTable = { header: lines[i]!.trim(), cells: [], unknownRows: [] };
    for (let r = i + 2; r < lines.length && lines[r]!.trim().startsWith("|"); r++) {
      const row = cellsOf(lines[r]!);
      const planKey = planKeyByLabel[row[0] ?? ""];
      if (!planKey) {
        table.unknownRows.push(row[0] ?? "");
        continue;
      }
      for (const [col, axis] of mapped) {
        if (col >= row.length) continue;
        table.cells.push({
          plan: row[0]!,
          planKey,
          axis: header[col]!,
          feature: axis.feature,
          value: row[col]!,
        });
      }
    }
    tables.push(table);
  }
  return tables;
}

/**
 * Every capacity cell against the matrix, in all THREE directions.
 *
 * The third is the one that had never been checked anywhere: a plan with NO row
 * for an axis is not capped by that plan at all, and a cell printing either a
 * number or "Unlimited" invents a grant. `directory/clubs-and-teams.md` gave
 * the Event Pass a 2/2/20 row copied from Community's, which is a claim the
 * pass makes nowhere — `resolveFromDb` INNER JOINs `plan_entitlements` on the
 * pass key, so a key the pass matrix omits falls through to the org's own plan,
 * and all four of these axes are resolved with no `competitionId` anyway, which
 * means the pass overlay arm never even runs for them.
 */
export function planCapTableFaults(
  label: string,
  tables: readonly PlanCapTable[],
  live: PlanCapLookup,
): string[] {
  const faults: string[] = [];
  for (const table of tables) {
    for (const row of table.unknownRows) {
      faults.push(`${label}: capacity table row "${row}" is not a live plan name`);
    }
    for (const cell of table.cells) {
      const cap = live(cell.feature, cell.planKey);
      const where = `${label}: ${cell.plan}/${cell.axis}`;
      if (cap === undefined) {
        if (NUMBER_CELL.test(cell.value) || UNLIMITED_CELL.test(cell.value)) {
          faults.push(
            `${where} says "${cell.value}", but ${cell.planKey} has no ${cell.feature} row — that plan does not set this cap at all, so a figure here invents a grant`,
          );
        }
      } else if (cap === null) {
        if (!UNLIMITED_CELL.test(cell.value)) {
          faults.push(
            `${where} says "${cell.value}", but ${cell.feature} is unlimited on ${cell.planKey}`,
          );
        }
      } else if (!NUMBER_CELL.test(cell.value) || Number(cell.value.replace(/,/g, "")) !== cap) {
        faults.push(
          `${where} says "${cell.value}", but the matrix caps ${cell.feature} at ${cap} on ${cell.planKey}`,
        );
      }
    }
  }
  return faults;
}

/** One per-plan capacity claim made in PROSE. */
export interface PlanCapClaim {
  /** The clause it was read out of, for a fault a human can locate. */
  clause: string;
  planKey: string;
  feature: string;
  /** `null` when the claim is an unlimited WORD rather than a figure. */
  quoted: number | null;
}

export const UNLIMITED_WORD = /\b(unlimited|unbounded|no limit|∞)\b/i;
/** Between an unlimited word and the noun it governs: list glue and nothing
 *  else — words, commas, and/or, whitespace. A digit or any other punctuation
 *  ends the reach, which is what stops "Unlimited active competitions, 20
 *  divisions in each, ... 10 team members" from reading as an unlimited claim
 *  about seats four items down the same sentence. */
export const LIST_GLUE = /^[a-z\-,\s]*$/i;
const GLUE_REACH = 60;

/**
 * Per-plan capacity claims made in prose, attributed the way a READER
 * attributes them.
 *
 * Three rules, each of which was measured against the whole help tree rather
 * than reasoned about, because the first two shapes tried had a 3-in-4 false
 * positive rate:
 *
 *  - THE PLAN comes from the section HEADING when the heading names exactly one
 *    ("## Pro — $14.99/month"), and only otherwise from plan names in the clause.
 *    Heading-first is load-bearing: `plans.md`'s Enterprise paragraph opens
 *    "Everything in Pro, plus unlimited ... teams, clubs and organisations",
 *    which is TRUE of enterprise and false of the pro named inside it.
 *  - THE AXIS is the noun the unlimited word GOVERNS — reachable across list
 *    glue only. "unlimited seats, teams, clubs and organisations" claims all
 *    four; "Unlimited active competitions, 20 divisions in each" claims none of
 *    them.
 *  - AN ELIDED NOUN is carried from earlier in the same SENTENCE. That is the
 *    whole of finding 2: "Community orgs get 3 members total across all roles;
 *    Pro is unlimited" puts the falsehood in a clause with no noun in it.
 *
 * Figures are collected too, not just unlimited words, so a wrong NUMBER in
 * prose reds the same way a wrong number in a cell does.
 */
export function planCapProseClaims(
  markdown: string,
  planKeyByLabel: Record<string, string>,
): PlanCapClaim[] {
  const claims: PlanCapClaim[] = [];
  const labels = Object.keys(planKeyByLabel).sort((a, b) => b.length - a.length);
  const plansIn = (text: string): string[] => {
    const keys: string[] = [];
    let rest = text;
    for (const label of labels) {
      const re = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(rest)) {
        keys.push(planKeyByLabel[label]!);
        rest = rest.replace(re, " ");
      }
    }
    return keys;
  };

  let headingPlan: string | null = null;
  for (const raw of markdown.split("\n")) {
    if (raw.startsWith("#")) {
      const named = plansIn(plainProse(raw));
      headingPlan = named.length === 1 ? named[0]! : null;
      continue;
    }
    if (raw.trimStart().startsWith("|")) continue; // tables are the other half
    for (const sentence of plainProse(raw).split(/(?<=[.!?])\s+/)) {
      let carried: string[] = [];
      for (const clause of sentence.split(/[;—]/)) {
        const present = PLAN_CAP_AXES.map((axis) => ({ axis, hit: axis.noun.exec(clause) })).filter(
          (x): x is { axis: PlanCapAxis; hit: RegExpExecArray } => x.hit !== null,
        );
        if (present.length > 0) carried = present.map((p) => p.axis.feature);

        const inClause = plansIn(clause);
        const targets = headingPlan ? [headingPlan] : inClause;
        if (targets.length === 0) continue;

        // Figures: "3 members", "10 team members", "20 clubs".
        for (const { axis } of present) {
          const source = axis.noun.source.replace(/^\\b|\\b$/g, "");
          const re = new RegExp(`\\b(\\d[\\d,]*)\\s+(?:[a-z-]+\\s+){0,1}(?:${source})`, "gi");
          for (const m of clause.matchAll(re)) {
            for (const planKey of targets) {
              claims.push({
                clause: clause.trim(),
                planKey,
                feature: axis.feature,
                quoted: Number(m[1]!.replace(/,/g, "")),
              });
            }
          }
        }

        // Unlimited words, over the axes they reach.
        const unlimited = UNLIMITED_WORD.exec(clause);
        if (!unlimited) continue;
        const reached =
          present.length > 0
            ? present.filter(({ hit }) => governs(clause, unlimited, hit)).map(({ axis }) => axis.feature)
            : carried;
        for (const feature of reached) {
          for (const planKey of targets) {
            claims.push({ clause: clause.trim(), planKey, feature, quoted: null });
          }
        }
      }
    }
  }
  return claims;
}

/** Whether an unlimited word reaches a noun across list glue alone. */
function governs(clause: string, unlimited: RegExpExecArray, noun: RegExpExecArray): boolean {
  const [first, second] =
    noun.index >= unlimited.index + unlimited[0].length
      ? [unlimited.index + unlimited[0].length, noun.index]
      : [noun.index + noun[0].length, unlimited.index];
  if (second < first) return false;
  const span = clause.slice(first, second).replace(/\b(is|are|was|were)\b/g, "");
  return span.length <= GLUE_REACH && LIST_GLUE.test(span);
}

/** Prose capacity claims against the matrix — the same three directions as the
 *  table half, so the two shapes of the same falsehood get the same answer. */
export function planCapProseFaults(
  label: string,
  claims: readonly PlanCapClaim[],
  live: PlanCapLookup,
): string[] {
  const faults: string[] = [];
  for (const claim of claims) {
    const cap = live(claim.feature, claim.planKey);
    const where = `${label}: "${claim.clause.slice(0, 90)}"`;
    if (cap === undefined) {
      faults.push(
        `${where} makes a ${claim.feature} claim about ${claim.planKey}, which has no such row — that plan does not set this cap`,
      );
    } else if (claim.quoted === null) {
      if (cap !== null) {
        faults.push(`${where} calls ${claim.planKey} unlimited on ${claim.feature}, which the matrix caps at ${cap}`);
      }
    } else if (cap === null) {
      faults.push(`${where} quotes ${claim.quoted} for ${claim.planKey}/${claim.feature}, which the matrix leaves unlimited`);
    } else if (cap !== claim.quoted) {
      faults.push(`${where} quotes ${claim.quoted} for ${claim.planKey}/${claim.feature}, but the matrix says ${cap}`);
    }
  }
  return faults;
}

// ═════════════════════════════════════════════════════════════════════════════
// ALLOWLIST — APPROVED FORMS, NOT BANNED ONES  (fix round 2)
// ═════════════════════════════════════════════════════════════════════════════
//
// Three rounds of this wave widened the NEGATIVE side and lost three times. The
// measurements, all by someone other than the pattern's author:
//
//   round 0  the seed guards          defeated by a reword
//   round 1  topic + verb vocabulary  fee 1/12, permanence 1/11
//   round 2  "closed set of forms"    fee 0/12, permanence 0/12, constant 0/4
//
// Round 2's diagnosis is the one that matters, and it is correct: the forms were
// not closed. "A negated limit" was a word list — end|expiry|deadline|cut-off —
// so the same FORM with a different word walked straight through. It was a
// denylist wearing grammar's clothes. Every author scores well against their own
// rewordings and badly against a stranger's, because a denylist can only ever
// contain what its author thought of.
//
// THE SPACE OF FALSE PHRASINGS IS OPEN. THE SPACE OF APPROVED COPY IS CLOSED.
//
// So the verdict flips. A sentence that makes one of these claims must MATCH AN
// APPROVED FORM, and a wording nobody predicted fails by default.
//
// ── WHAT THIS LAYER ACTUALLY DELIVERS, MEASURED ──────────────────────────────
// Do not read the paragraph above as a claim that this catches these families.
// It does not. Against a committed set of twelve rewordings per family, with the
// inventory gate excluded, this layer scores:
//
//     duration   1/12        fee reversion   4/12
//
// (`help-copy-truth.test.ts` asserts both numbers EXACTLY, so widening this
// layer has to update them deliberately. An independent reviewer measured 1/12
// and 0/12 on its own sets — the agreement is the point.)
//
// THE INVENTORY GATE IS DOING THE WORK. This layer is a secondary net: it gives
// a specific, actionable failure where it does fire, and it covers articles the
// gate does not pin. It is not the reason a falsehood cannot ship.
//
// The cost is friction: a genuinely new true sentence also fails until someone
// approves a form for it.

/** A claim we police, as "how to spot one" plus "the ways we accept it". */
export interface ClaimAllowlist {
  /** What the claim is about, for the fault label. */
  kind: string;
  /** Broad, deliberately over-inclusive: does this sentence make such a claim?
   *  Recall matters here and precision does not, because the verdict is decided
   *  by `approved` below — a sentence swept in wrongly is one an approved form
   *  then accepts. */
  classifies: RegExp[];
  /** Narrow: the shapes this claim may take. Each is a SHAPE, and the fault
   *  label names which one matched so an editor can see what is on offer. */
  approved: Array<[form: string, pattern: RegExp]>;
  /** What to do about a fault, printed in the label. */
  guidance: string;
}

/**
 * Every sentence making the claim must match an approved form.
 *
 * Returns the sentence AND the list of forms on offer, because the failure an
 * editor meets must be actionable: "this is not one of the four ways we say
 * this" is useless without the four ways.
 */
export function unapprovedClaimFaults(
  label: string,
  prose: string,
  allowlist: ClaimAllowlist,
  /** Paragraphs already pinned word-for-word by `goldenParagraphFaults`. They
   *  are excluded because the gate is STRICTER than any allowlist — it permits
   *  exactly one wording — so re-judging them here only adds forms that exist to
   *  describe sentences the generalising rules were never meant to cover. */
  gatedParagraphs: string[] = [],
): string[] {
  const faults: string[] = [];
  for (const block of claimTexts(prose)) {
    if (gatedParagraphs.includes(block)) continue;
    for (const sentence of sentences(block)) {
      if (!allowlist.classifies.some((p) => p.test(sentence))) continue;
      if (allowlist.approved.some(([, p]) => p.test(sentence))) continue;
      faults.push(
        `${label}: "${sentence.slice(0, 96)}" makes a ${allowlist.kind} claim in no approved form. ${allowlist.guidance} Approved forms: ${allowlist.approved.map(([form]) => form).join("; ")}.`,
      );
    }
  }
  return faults;
}

/** Which approved forms actually fired on this prose. The anti-vacuity backstop
 *  for an allowlist: a `classifies` list that has drifted narrow sweeps nothing
 *  in, every sentence passes, and the rule reports clean while examining
 *  nothing — the exact failure this wave has now hit three times. */
export function approvedFormsExercised(prose: string, allowlist: ClaimAllowlist): string[] {
  const fired = new Set<string>();
  for (const block of claimTexts(prose)) {
    for (const sentence of sentences(block)) {
      if (!allowlist.classifies.some((p) => p.test(sentence))) continue;
      for (const [form, pattern] of allowlist.approved) {
        if (pattern.test(sentence)) fired.add(form);
      }
    }
  }
  return [...fired];
}

// ── The pass's duration ──────────────────────────────────────────────────────

/**
 * Does this sentence say anything about how long the pass holds? Cast wide:
 * persistence, termination and extent vocabulary, in any combination. The two
 * rewordings that beat round 2 are both caught here — "the upgrade is yours
 * from then on and your competition never loses it" on `yours`/`never`/`loses`,
 * and "it applies for the entire duration" on the extent phrase — and then fail
 * because no approved form fits them.
 *
 * MEASURED AND NARROWED. The first draft used bare verbs — `stays`, `ends`,
 * `never`, `while`, `switch off` — and swept in seventeen true sentences that
 * make no duration claim at all ("your brand colour STAYS a Pro feature", "the
 * checkout quotes YOURS", "a competition is NEVER billed twice", "SO WHILE
 * you're on a paid plan"). An allowlist whose classifier over-fires forces
 * approved forms to be invented for sentences the rule was never about, and
 * those forms are then holes. So each entry below requires the predicate to be
 * about DURATION specifically, and several require the pass to be its subject.
 */
export const DURATION_CLAIM_CLASSIFIERS = [
  // An extent, named.
  /\bfor\s+(?:the\s+|its\s+|your\s+|that\s+|this\s+)?(?:life|lifetime|duration|rest|remainder|whole|entire)\b/i,
  /\b(?:from\s+(?:then|now)\s+on|for\s*ever|forever|for\s+good|in\s+perpetuity|indefinitely|open[-\s]ended|how\s+long|always\s+(?:applies|works|holds))\b/i,
  /\bpermanent\w*\b/i,
  // A bound, stated temporally — "while it runs", not "while you're on Pro".
  /\bwhile\b[^.;:!?]*\b(?:runs?|running|active|live|open|under\s*way)\b/i,
  /\b(?:until|for\s+as\s+long\s+as|as\s+long\s+as)\b[^.;:!?]*\b(?:runs?|running|active|live|open|over|archived?|completed?)\b/i,
  // A stop, or its denial, with the PASS as its subject.
  /\b(?:pass|upgrade)\b[^.;:!?]*\b(?:expires?|lapses?|runs?\s+out|stops?\s+(?:applying|working)|switch(?:es)?\s+off)\b|\b(?:expires?|lapses?|runs?\s+out|stops?\s+applying|switch(?:es)?\s+off)\b[^.;:!?]*\b(?:pass|upgrade)\b/i,
  /\bno\s+(?:end\s*date|expiry|expiration|time\s+limit|deadline|cut[-\s]?off|last\s+day)\b/i,
  /\bnever\s+(?:loses?|lose|expires?|ends?|lapses?|stops?|switch\w*|goes?\s+away|comes?\s+off|runs?\s+out)\b/i,
  /\bend\s*date\b/i,
  // Persistence, as a claim rather than as an ordinary verb.
  /\b(?:stays?|remains?|is)\s+yours\b|\byours\s+(?:to\s+keep|from)\b|\bto\s+keep\b/i,
  /\b(?:stays?|remains?)\s+in\s+force\b|\bkeeps?\s+(?:working|applying)\b|\bstill\s+applies\b|\bcarries?\s+on\b|\brides?\s+(?:on|along)\b|\bsurvives?\b/i,
];

/**
 * The ways this product's duration may truthfully be stated. Four, because the
 * behaviour has four parts: it is bounded to a running competition; it stops on
 * a named condition; it does not transfer to the next edition; and it outlives a
 * subscription lapse because it was bought outright.
 *
 * Each is anchored on the CONDITION, not on adjectives — that is what stops a
 * new falsehood slipping in as a variant. "Once bought, the upgrade is yours
 * from then on" matches none of the four, and cannot be made to without stating
 * a condition that is not true.
 */
export const APPROVED_DURATION_FORMS: Array<[form: string, pattern: RegExp]> = [
  ["bounded to a running competition (`while it runs`)", BOUNDED_SCOPE_GRAMMAR],
  [
    "stops on a named condition (`stops once the competition is completed or archived`)",
    /\bend\s*date\b[^.;:!?]*\bpassed\b|\bcompleted\s+or\s+archived\b|\b(stops?|ends?|switch(?:es)?\s+off|no\s+longer\s+applies|lifts?\s+off|drops?\s+back)\b[^.;:!?]*\b(once|when|after)\b[^.;:!?]*\b(completed?|archived?|over|finished?|end\s*date|\d+\s+days?)\b|\b(once|when|after)\b[^.;:!?]*\b(completed?|archived?|over|finished?|end\s*date|\d+\s+days?)\b[^.;:!?]*\b(stops?|ends?|switch(?:es)?\s+off|no\s+longer|drops?\s+back)\b/i,
  ],
  [
    "does not transfer to a new competition (`a new edition needs its own pass`)",
    /\b(does\s+not|doesn'?t|won'?t|never)\b[^.;:!?]*\bcarr(?:y|ies)\b[^.;:!?]*\b(next|new|another|season|edition|year)\b|\b(new|next|another)\b[^.;:!?]*\b(competition|edition|event)\b[^.;:!?]*\b(needs?|is)\b[^.;:!?]*\b(own\s+pass|new\s+pass|a\s+new\s+purchase)\b/i,
  ],
  [
    "outlives a subscription lapse, because it was bought outright for that event",
    /\bbought\s+outright\b|\bsurvives?\s+a\s+downgrade\b/i,
  ],
  [
    "bound to the competition itself, not to its name (`rename it freely`)",
    /\bbound\s+to\s+the\s+competition\b/i,
  ],
];

export const DURATION_ALLOWLIST: ClaimAllowlist = {
  kind: "pass-duration",
  classifies: DURATION_CLAIM_CLASSIFIERS,
  approved: APPROVED_DURATION_FORMS,
  guidance:
    "Rewrite it as one of the approved forms, or — if the product genuinely behaves a new way — add a form here and say why in the commit.",
};

// ── The entry-fee rate ───────────────────────────────────────────────────────

/**
 * A claim about what an entrant is charged, once the pass is no longer in force.
 *
 * Both halves are needed. Rate vocabulary alone sweeps in every true sentence
 * that merely quotes the 5% (there are nine), and the transition alone sweeps in
 * every sentence about the pass ending that says nothing about money. The
 * INTERSECTION is where the falsehood has to live, because the claim cannot be
 * made without naming both.
 *
 * Note the rate vocabulary is about a RATE, not about money in general: "only
 * the first charge sticks — the duplicate is refunded automatically" is a
 * statement about a duplicate payment, and was a measured false positive when
 * `charge` was in this list on its own.
 */
export const RATE_VOCABULARY =
  /\b(platform\s+fees?|entry[-\s]fees?|fee\s+rate|rates?|fees?|per\s*cent|percent|pricing|entry\s+costs?|costs?\s+you\s+more|cheaper|dearer|commission|\d+(?:\.\d+)?\s*%)\b/i;

export const PASS_TRANSITION_VOCABULARY =
  /\b(after|once|when)\b[^.;:!?]*\b(ends?|ended|ending|closes?|closed|finish\w*|over|expir\w*|stops?|stopped|lapses?|archiv\w*|completed?|handed\s+out|trophy)\b|\b(no\s+longer|later\s+(?:entrants?|entries|entry|payers?)|back\s+to|goes?\s+back|returns?\s+to|again|revert\w*|normal|standard|downgrad\w+|after\s+(?:that|then|it)|when\s+the\s+pass|after\s+the\s+pass|pass\s+(?:ends?|stops?|expires?|lapses?|does))\b|(?:\b(?:revok\w+|refund\w*|chargeback)\b[^.;:!?]*\bpass\b|\bpass\b[^.;:!?]*\b(?:revok\w+|refund\w*|chargeback)\b)/i;

// `(?=A)(?=B)` requires BOTH to match at the SAME index, which is almost never
// true of two different vocabularies — measured: it classified nothing at all,
// and the rule built on it reported clean over the whole article. The `.*`
// prefixes are what make each lookahead mean "somewhere in this sentence".
// (Caught by `approvedFormsExercised`, which exists for exactly this.)
export const FEE_RATE_CLAIM_CLASSIFIERS = [
  new RegExp(`(?=.*(?:${RATE_VOCABULARY.source}))(?=.*(?:${PASS_TRANSITION_VOCABULARY.source}))`, "i"),
];

/**
 * The three true things there are to say about the rate after a pass ends, all
 * of them anchored on the FIRST PAID CARD ENTRY, because that is the only thing
 * that decides the answer (`registrations.ts` is the sole writer of
 * `competitions.fee_percent`, and its `where … and fee_percent is null` makes it
 * first-wins).
 *
 * There is deliberately no form for "the rate goes back up", because there is no
 * true sentence of that shape: a competition that has taken a paid card entry
 * keeps its rate, and one that has not was never on the pass rate to begin with.
 */
export const APPROVED_FEE_RATE_FORMS: Array<[form: string, pattern: RegExp]> = [
  [
    "the lock (`the platform fee stays locked at what the first paid card entry was charged`)",
    new RegExp(`(?=.*${FEE_SUBJECT})(?=.*${FEE_LOCK_WORD})(?=.*${PAID_ENTRY_TRIGGER})`, "i"),
  ],
  [
    "the unlocked case (`a competition with no paid card entry yet follows your plan's rate`)",
    /\bno\s+paid\s+(?:card\s+)?(?:entry|entrant|registration)\b[^.;:!?]*\b(plan|live|standard)\b|\b(plan|live|standard)\b[^.;:!?]*\bno\s+paid\s+(?:card\s+)?(?:entry|entrant|registration)\b/i,
  ],
  [
    "the pass rate riding on, conditioned on when the first entry was taken",
    /\bfirst\s+(?:paid\s+)?(?:card\s+)?(?:entry|entrant|payment)\b[^.;:!?]*\b(while|before|after|during)\b[^.;:!?]*\bpass\b/i,
  ],
];

export const FEE_RATE_ALLOWLIST: ClaimAllowlist = {
  kind: "entry-fee-rate-after-the-pass",
  classifies: FEE_RATE_CLAIM_CLASSIFIERS,
  approved: APPROVED_FEE_RATE_FORMS,
  guidance:
    "The rate is decided by the FIRST PAID CARD ENTRY and nothing else — check registrations.ts before rewording.",
};

// ── A golden fixture over the two paragraphs that keep regressing ────────────

/** One paragraph whose exact wording has been read against the code and
 *  approved. `find` locates it; `text` is what it must say. */
export interface ApprovedParagraph {
  id: string;
  find: RegExp;
  text: string;
  why: string;
}

/**
 * The two paragraphs that carry this product's two most-regressed claims, pinned
 * WORD FOR WORD.
 *
 * Every rule above generalises, and generalising is how all three previous
 * rounds were beaten. This one does not generalise: it compares the paragraph to
 * an approved string. There is no phrasing that evades it, because it is not
 * looking at phrasing.
 *
 * The friction is deliberate and is the whole point. These paragraphs describe
 * money an organiser is charged, they have carried a falsehood in three
 * consecutive rounds, and the cost of changing them is now one deliberate
 * re-approval — which is a person reading the new words against
 * `registrations.ts` and `org_has_feature`, exactly the step that was skipped
 * each time.
 */
export function goldenParagraphFaults(
  label: string,
  markdown: string,
  approved: ApprovedParagraph[],
): string[] {
  const faults: string[] = [];
  const blocks = proseBlocks(markdown);
  for (const paragraph of approved) {
    const matches = blocks.filter((block) => paragraph.find.test(block));
    if (matches.length === 0) {
      faults.push(
        `${label}: the approved paragraph "${paragraph.id}" is GONE — renamed, split or deleted. It stated: ${paragraph.why} If that is intended, update the fixture; if not, this is the regression.`,
      );
      continue;
    }
    if (matches.length > 1) {
      faults.push(
        `${label}: "${paragraph.id}" matches ${matches.length} paragraphs, so this fixture is pinning an ambiguous target — tighten its \`find\`.`,
      );
      continue;
    }
    const actual = matches[0]!;
    if (actual === paragraph.text) continue;
    faults.push(
      [
        `${label}: the approved paragraph "${paragraph.id}" CHANGED.`,
        "",
        "  THIS TEST IS A GATE, NOT A BUG. This paragraph states " + paragraph.why,
        "  It has shipped a falsehood in three consecutive rounds of this wave, so",
        "  its wording is pinned and changing it requires a deliberate re-approval:",
        "  read the new text against server/usecases/registrations.ts (the fee lock)",
        "  and lib/entitlements.ts (the pass window), then paste it into",
        "  src/lib/__tests__/_approved-copy.ts.",
        "",
        `  approved: ${paragraph.text}`,
        `  on disk:  ${actual}`,
      ].join("\n"),
    );
  }
  return faults;
}

// ── THE INVENTORY GATE ───────────────────────────────────────────────────────
//
// Measured, after the allowlist above was final: a fresh adversarial set scored
// 6/30, while the reviewer's own set — which the rules had been tuned against —
// scored 12/12. Same author, same rules, twice the effort, and the gap is the
// whole story: EVERY LEXICAL RULE SCORES WELL AGAINST THE EXAMPLES IT WAS
// WRITTEN FOR AND BADLY AGAINST THE NEXT ONES. Four rounds of this wave have now
// demonstrated it (1/12, 0/12, 12/12-then-6/30). It is not a tuning problem.
//
// So the primary defence stops being about words. This pins the INVENTORY of the
// pass's own copy: a digest per paragraph, in order. A sentence added anywhere
// in it — in a new paragraph or inside an existing one — changes the inventory
// and fails, whatever it says, because nothing here is reading it.
//
// The cost is that every legitimate edit to this copy also fails until someone
// updates the fixture. That is the accepted trade: this article describes money
// an organiser is charged, it has carried a falsehood in three consecutive
// rounds, and the one step that would have caught all three — a person reading
// the new words against the code — is exactly what the fixture forces.
//
// Digests rather than the prose itself, so the fixture does not become a second
// copy of the article that reviewers must diff twice. The text is printed from
// disk when a check fails, so the failure is still actionable.

/**
 * FNV-1a, run twice from different offset bases and concatenated — 64 bits of
 * separation out of 32-bit integer arithmetic.
 *
 * Not cryptographic and does not need to be: the thing being detected is an
 * edit, not a forgery. Hand-rolled so this module keeps its zero-import surface
 * (`node:crypto` here would be one careless import away from a client bundle),
 * and in plain numbers rather than BigInt because `apps/web/tsconfig.json`
 * targets ES2017, which rejects BigInt literals outright (TS2737). An earlier
 * version of this comment blamed `tsconfig.scripts.json`, which in fact targets
 * es2022 — a false comment, in the module this wave exists to make truthful.
 */
function fnv1a(text: string, offsetBasis: number): number {
  let hash = offsetBasis;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function blockDigest(text: string): string {
  const low = fnv1a(text, 0x811c9dc5);
  const high = fnv1a(text, 0x9e3779b9);
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/** The digest of every prose block, in order. */
export function blockDigests(markdown: string): string[] {
  return proseBlocks(markdown).map(blockDigest);
}

const GATE_PREAMBLE = [
  "  THIS TEST IS A GATE, NOT A BUG.",
  "  The pass's copy is inventory-pinned. Four rounds of vocabulary rules failed",
  "  to catch a falsehood ADDED beside true sentences (measured 1/12, 0/12, and",
  "  6/30 against a fresh set), so what is checked here is that the copy is the",
  "  copy that was approved — not that it avoids any particular wording.",
  "",
  "  To make this pass: read your new text against the code it describes —",
  "  server/usecases/registrations.ts for the entry-fee lock, lib/entitlements.ts",
  "  for the pass window — then update the digests in",
  "  src/lib/__tests__/_approved-copy.ts and say in the commit what you checked.",
].join("\n");

/**
 * The pass's copy, paragraph by paragraph, against the approved inventory.
 *
 * Reports ADDED, REMOVED and CHANGED blocks separately, with the on-disk text
 * and the digest to paste, because a gate whose failure message is a hex string
 * is a gate people route around.
 */
export function inventoryFaults(label: string, markdown: string, approved: string[]): string[] {
  const surfaces = claimSurfaces(markdown);
  const blocks = surfaces.map((surface) =>
    surface.kind === "frontmatter" ? `${surface.field}: ${surface.text}` : surface.text,
  );
  const actual = blocks.map(blockDigest);
  if (approved.length === 0) {
    return [`${label}: the approved inventory is EMPTY, so this gate is checking nothing.`];
  }
  const faults: string[] = [];
  const actualSet = new Set(actual);

  // POSITIONAL, not set-membership (fix round 3). The set version raised ZERO
  // faults when two real paragraphs were SWAPPED, while its own message claimed
  // to catch "duplicated or reordered" — a comment promising more than the code
  // delivered, which is the exact defect this wave exists to remove. Order is
  // part of the approved copy: "It stops once that competition is over:" means
  // something different two paragraphs away from its bullets.
  // A PURE POSITIONAL SHIFT IS ONE FAULT, NOT SEVENTY-FIVE.
  //
  // Inserting a single heading into an 86-surface article used to produce 50
  // fault messages — every surface after it reported as "MOVED here from
  // position n-1". That is technically accurate and practically corrosive:
  // fifty near-identical failures push an editor to regenerate the digest array
  // wholesale, which is exactly the "re-record rather than re-check" behaviour
  // the gate exists to prevent. The noise was arguing against the gate's own
  // purpose.
  //
  // So the run of surfaces whose digest equals the approved digest `delta`
  // positions earlier is collapsed into one message naming the range and the
  // offset. Anything that is NOT a clean shift — a changed surface, one that is
  // in no inventory at all — still reports individually, because that is the
  // thing the reader has to read.
  let i = 0;
  while (i < blocks.length) {
    if (actual[i] === approved[i]) {
      i += 1;
      continue;
    }
    const movedFrom = approved.indexOf(actual[i]!);
    const delta = movedFrom === -1 ? null : movedFrom - i;
    if (delta !== null && delta !== 0) {
      // How far this constant offset holds. A shift that ends is a shift.
      let end = i;
      while (
        end < blocks.length &&
        actual[end] !== approved[end] &&
        approved.indexOf(actual[end]!) === end + delta
      ) {
        end += 1;
      }
      if (end - i > 1) {
        const moved = delta < 0 ? "LATER" : "EARLIER";
        faults.push(
          [
            `${label}: surfaces ${i + 1}-${end} of ${blocks.length} are approved copy that has SHIFTED ${Math.abs(delta)} position(s) ${moved}.`,
            "",
            "  This is a pure move, not an edit: every one of these surfaces still",
            "  says exactly what was approved. Something was INSERTED or REMOVED",
            "  above them — look for the individually-reported fault(s) elsewhere in",
            "  this list, fix that, and these resolve with it.",
            "",
            "  DO NOT regenerate the whole inventory to silence this. The array is",
            "  ordered, so a wholesale regeneration also re-approves whatever real",
            "  change caused the shift, unread — which is the failure this gate exists",
            "  to prevent.",
          ].join("\n"),
        );
        i = end;
        continue;
      }
    }
    const detail =
      movedFrom === -1
        ? `is NOT in the approved inventory`
        : `is approved copy, but MOVED here from position ${movedFrom + 1}`;
    faults.push(
      [
        `${label}: surface ${i + 1} of ${blocks.length} (${surfaces[i]!.kind}) ${detail}.`,
        "",
        GATE_PREAMBLE,
        "",
        `  digest: "${actual[i]}"`,
        `  text:   ${blocks[i]}`,
      ].join("\n"),
    );
    i += 1;
  }

  for (const digest of approved) {
    if (actualSet.has(digest)) continue;
    faults.push(
      [
        `${label}: an approved surface (digest "${digest}") is GONE from the article.`,
        "",
        GATE_PREAMBLE,
      ].join("\n"),
    );
  }

  if (faults.length === 0 && actual.length !== approved.length) {
    faults.push(
      `${label}: the article has ${actual.length} surfaces and the inventory has ${approved.length}.`,
    );
  }
  return faults;
}

// =============================================================================
// NO SHIPPED STRING MAY NAME A PLAN NOBODY CAN BUY
// =============================================================================
//
// The guard this file used to have for this was `plusDifferentiatorFaults`, and
// it was DELETED with the Pro Plus card in W2 — correctly, because it judged
// whether each differentiator was exclusive to a TIER, and there was no longer
// a tier. What went with it was the only thing in the repo that read the words
// "Pro Plus". The copy then went on saying them, in four locales, on /pricing
// and across seventeen help articles, with a green suite the whole time.
//
// So this rule is deliberately NOT the old one narrowed. It asks a question a
// retired tier cannot dodge by being reworded:
//
//   DOES THIS SENTENCE NAME A PLAN THE `plans` TABLE DOES NOT HOLD?
//
// TWO LAYERS, because neither can see what the other does.
//
//   A. DERIVED. A live plan name followed by a capitalised qualifier is a tier
//      that does not exist: "Pro" + "Plus". Nothing here is a list of banned
//      words — the vocabulary is `plans.name`, and the fault is the EXTENSION
//      of a live name into one that was never seeded. It therefore catches the
//      next invented tier ("Pro Elite", "Community Premium") as readily as the
//      last retired one, which a denylist written today cannot.
//
//   B. REGISTRY. A retired name that is NOT an extension of a live one —
//      `business` (V290) is the standing example — is unreachable from (A), so
//      the retired KEYS are declared (`RETIRED_PLAN_KEYS`, lib/plan-label.ts)
//      and their DISPLAY NAMES derived through the same `planLabel` the product
//      renders with. No guard hand-types a retired name.
//
// CASE-SENSITIVE, like `PAID_PLAN_NAME` above and for the same reason: plan
// names are proper nouns, they are untranslated in all four locales, and
// matching "pro plus" case-insensitively would read ordinary prose as a tier.

/** One shipped string that still names a retired plan, and why it may. */
export interface RetiredPlanExemption {
  /** Dictionary key, help path or tip id — matched against `LocalisedValue.key`. */
  where: string;
  /** The retired name it carries. ASSERTED to still be there, so an exemption
   *  whose string has since been fixed reds instead of quietly outliving it. */
  name: string;
  /** HOW MANY times, exactly. A licence for the occurrences that exist, not for
   *  the surface: one more reds, one fewer reds. */
  hits: number;
  /** Who owns the fix, and why it is not this change's. */
  why: string;
}

/** One retired-plan hit: the surface, and the name it must not carry. */
export interface RetiredPlanHit {
  locale: DictionaryLocale;
  key: string;
  name: string;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `name` is a live plan name plus one capitalised qualifier — the
 *  shape layer A already reports, so layer B must not report it twice. */
function extendsALivePlan(name: string, live: readonly string[]): boolean {
  return live.some(
    (base) => name.startsWith(base + " ") && /^[A-Z][a-z]+$/.test(name.slice(base.length + 1)),
  );
}

/**
 * Every plan-name-shaped phrase in `values` that `live` does not contain.
 *
 * `live` is `plans.name` — the whole vocabulary, not a sample. A caller with a
 * database asserts it against the table directly; a caller without one derives
 * it from `ALL_PLAN_KEYS` through `planLabel`, which
 * `retired-matrix-keys.test.ts` already pins to the table row for row.
 */
export function retiredPlanNameHits(
  values: LocalisedValue[],
  live: readonly string[],
  retired: readonly string[],
): RetiredPlanHit[] {
  const hits: RetiredPlanHit[] = [];
  const liveSet = new Set(live);
  // Longest first, so a two-word plan wins over its own first word and the
  // qualifier scan cannot read the rest of a real name as an extension.
  const bases = [...live].sort((a, b) => b.length - a.length).map(escapeForPattern);
  const extended = new RegExp("\\b(?:" + bases.join("|") + ")(?:\\s+[A-Z][a-z]+)+", "g");
  const registry = retired
    .filter((name) => !extendsALivePlan(name, live))
    .map((name) => ({ name, pattern: new RegExp("\\b" + escapeForPattern(name) + "\\b") }));
  for (const { locale, key, value } of values) {
    for (const match of value.matchAll(extended)) {
      const phrase = match[0]!;
      if (liveSet.has(phrase)) continue;
      hits.push({ locale, key, name: phrase });
    }
    for (const { name, pattern } of registry) {
      if (pattern.test(value)) hits.push({ locale, key, name });
    }
  }
  return hits;
}

/**
 * The hits that are NOT exempt.
 *
 * An exemption is keyed on surface AND name AND COUNT. The count is what makes
 * it a licence for the occurrences that exist rather than for the surface: a
 * SECOND "Pro Plus" added to an article that already carries four reds, which a
 * per-surface exemption would have waved through.
 */
export function retiredPlanNameFaults(
  values: LocalisedValue[],
  live: readonly string[],
  retired: readonly string[],
  exempt: readonly RetiredPlanExemption[],
): string[] {
  // ANTI-VACUITY, all three inputs. Every fault below is a MATCH, so an empty
  // vocabulary, an empty registry or an empty corpus each turn this rule into a
  // guard that reports clean while reading nothing — which is precisely the
  // state the repo was in between `plusDifferentiatorFaults` being deleted and
  // this arriving.
  if (live.length < 3) {
    return [
      "the live plan vocabulary has " +
        live.length +
        " names — too few to be plans.name; this rule would examine nothing",
    ];
  }
  if (retired.length === 0) {
    return ["the retired-plan registry is empty — layer B would examine nothing"];
  }
  if (values.length === 0) {
    return ["no copy was handed to the retired-plan scan — it would pass vacuously"];
  }
  const allowed = new Map(exempt.map((e) => [e.where + " " + e.name, e.hits]));
  const faults: string[] = [];
  for (const [surface, hits] of countRetiredPlanHits(values, live, retired)) {
    const licensed = allowed.get(surface) ?? 0;
    if (hits.length <= licensed) continue;
    const first = hits[0]!;
    faults.push(
      first.locale +
        " " +
        first.key +
        ': names "' +
        first.name +
        '" ' +
        hits.length +
        " time(s), " +
        licensed +
        " exempted — that is no plan in `plans`, so a customer cannot buy it and no shipped string may offer it",
    );
  }
  return faults;
}

/** Hits grouped by `key + name`, in first-seen order. */
function countRetiredPlanHits(
  values: LocalisedValue[],
  live: readonly string[],
  retired: readonly string[],
): Map<string, RetiredPlanHit[]> {
  const grouped = new Map<string, RetiredPlanHit[]>();
  for (const hit of retiredPlanNameHits(values, live, retired)) {
    const surface = hit.key + " " + hit.name;
    const bucket = grouped.get(surface);
    if (bucket) bucket.push(hit);
    else grouped.set(surface, [hit]);
  }
  return grouped;
}

/**
 * Exemptions that no longer cover what they were written for.
 *
 * The half that stops the list rotting. An exemption records "this string still
 * says it N times, and someone else owns the fix"; once the fix lands, the
 * entry is a standing licence for the falsehood to come back on that exact
 * surface. Asserted empty by the caller, so a repaired string forces its
 * exemption out with it — and an exemption for a surface that never said it is
 * reported the same way.
 */
export function staleRetiredPlanExemptions(
  values: LocalisedValue[],
  live: readonly string[],
  retired: readonly string[],
  exempt: readonly RetiredPlanExemption[],
): string[] {
  const counted = countRetiredPlanHits(values, live, retired);
  return exempt
    .map((entry) => {
      const actual = counted.get(entry.where + " " + entry.name)?.length ?? 0;
      if (actual === entry.hits) return null;
      return (
        entry.where +
        ': exempted for "' +
        entry.name +
        '" ' +
        entry.hits +
        " time(s), but that surface names it " +
        actual +
        " time(s) — re-count it or delete the exemption (" +
        entry.why +
        ")"
      );
    })
    .filter((fault): fault is string => fault !== null);
}
