// Truth-in-copy guards for the FOUR-LOCALE DICTIONARIES (v17 gap wave 7, task 4).
//
// Third sibling of `plan-copy-truth.test.ts` (the Stripe seed) and
// `help-copy-truth.test.ts` (the help tree). Same pure functions from
// `@/lib/copy-truth`, same "prove it by rewording" discipline — but this surface
// differs from both in the one way that matters:
//
//   THE SEED IS ONE ENGLISH FILE. THE HELP TREE IS ONE ENGLISH TREE.
//   THESE DICTIONARIES ARE FOUR FILES THAT ALL SAY THE SAME THING.
//
// Tasks 1-3 could point an English regex at their surface and be done. Doing
// that here certifies `en` and passes es/fr/nl in silence. Measured on the exact
// strings this task fixes, BEFORE the fix, with the shared
// `FALSE_PASS_PERMANENCE_PATTERNS`:
//
//   en pricing.pass.note  "Yours for the event's lifetime."        1 hit
//   es pricing.pass.note  "Tuyo durante toda la vida del evento."  0 hits
//   fr pricing.pass.note  "À vous pour toute la durée de …"        0 hits
//   nl pricing.pass.note  "…voor de hele levensduur van het …"     0 hits
//
// Four identical falsehoods, one red. So `LOCALE_CLAIMS` is keyed by locale,
// every vocabulary is cross-applied to every value, a retired-literal registry
// backs both up, and `localeCoverageFaults` makes an unguarded locale a FAULT.
// See the long header over that section in `@/lib/copy-truth` for why three
// layers rather than one.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`. CI's unit job has no
// DATABASE_URL and its Postgres steps select `src/server src/lib` and `src/app`
// (.github/workflows/ci.yml). From `src/__tests__/` the `describe.skipIf(!HAS_DB)`
// half would run in no job at all and report pending on a green exit 0.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import stripePlans from "@/config/stripe-plans.json";
import { sql } from "@/lib/db";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { FEATURE_REASONS } from "@/lib/feature-copy";
import {
  HIDDEN_PASS_KEYS,
  PASS_KEYS,
  SELLABLE_PASS_KEYS,
  passPrice,
  proPrice,
} from "@/lib/currency";
import { TIPS } from "@/config/tips";
import * as copyTruth from "@/lib/copy-truth";
import { APPROVED_DICTIONARY_COPY } from "./_approved-dictionary-copy";
import {
  ANNUAL_SAVING_CLAIM,
  annualClaimFaults,
  annualPricePoints,
  annualSavingFaults,
  SEED_CURRENCIES,
  approvedDictionaryFaults,
  sourceControlCharacterFaults,
  unexportedPatternFaults,
  DICTIONARY_LOCALES,
  type DictionaryLocale,
  type FeatureGrants,
  LOCALE_CLAIMS,
  type LocalisedValue,
  type PricedPlan,
  claim,
  collectPatterns,
  controlCharacterFaults,
  inertPatternFaults,
  riderRateFaults,
  scoringFreeClaimFaults,
  SCORING_FREE_VOCABULARY,
  sentences,
  localeCoverageFaults,
  localeCreditGrantFaults,
  localeCreditLeadershipFaults,
  localeHalfClaimFaults,
  localePassBoundFaults,
  localePassUncoveredFaults,
  beyondPlanCopyFaults,
  localePaidOverclaimFaults,
  retiredClaimFaults,
  valueClauses,
  riderClaimShape,
  wholeNumber,
} from "@/lib/copy-truth";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// Dictionaries are FLAT dotted-key JSON. Read as a flat record and looked up
// with `in`/indexing — never traversed as if "pricing.pass.note" were three
// nested objects, which is how a present key gets reported missing.
const load = (locale: string, file: string): Record<string, string> =>
  JSON.parse(readFileSync(`src/dictionaries/${locale}/${file}.json`, "utf8"));

const localesOnDisk = readdirSync("src/dictionaries", { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/** Every value of `key` in `file`, one per locale. */
const across = (file: "marketing" | "ui", key: string): LocalisedValue[] =>
  DICTIONARY_LOCALES.map((locale) => ({ locale, key, value: load(locale, file)[key] ?? "" }));

// ── The keys this task owns ──────────────────────────────────────────────────
//
// `pricing.pass.note` and `pricing.faq.eventPass.a` are the PUBLIC pricing page;
// `upgrade.intro` and `upgrade.active.body` are the in-app purchase page a buyer
// reads immediately before paying (`/o/[orgSlug]/c/[compSlug]/upgrade`, rendered
// at page.tsx:430 as `t(dict, held ? "upgrade.active.body" : "upgrade.intro")`);
// `billing.passOffer.note` is the offer card in Settings → Billing
// (`components/billing-pass-offer.tsx:56`). Five keys, twenty values, one
// falsehood.
//
// `billing.passOffer.note` also makes a SECOND claim — that a passed
// competition stops counting against the active-competition limit. Verified
// TRUE against the resolver before touching the sentence and kept verbatim:
// `usecases/competitions.ts:88` and `usecases/entitlement-freeze.ts:69` both
// count with `not exists (select 1 from competition_passes …)`. Fixing a false
// clause is not a licence to quietly drop a true one.
/**
 * THE KEY AXIS IS AN INVENTORY, PINNED. Fix round 1 added
 * `pricing.faq.upgraded.a`, which sat on the SAME PAGE saying "passes never
 * expire" while the key two cards above it had already been corrected — and it
 * was invisible because deleting a key from this list left the suite green
 * while deleting a *locale* correctly reds. An axis that is not asserted is not
 * covered, and the asymmetry is what hid a live falsehood for a whole round.
 */
const PASS_BOUND_KEYS = [
  ["marketing", "pricing.pass.note"],
  ["marketing", "pricing.faq.eventPass.a"],
  ["marketing", "pricing.faq.upgraded.a"],
  ["ui", "upgrade.intro"],
  ["ui", "upgrade.active.body"],
  ["ui", "billing.passOffer.note"],
] as const;

// THE `pass.entry.ended.*` KEYS ARE PINNED, BUT DELIBERATELY NOT HERE — and
// getting that wrong is instructive enough to write down (W8 review round).
//
// They were added to this list first. Three tests redded, and the third is the
// one that matters: `localePassBoundFaults` requires every value here to
// POSITIVELY state that the pass is bounded to a running competition. That is
// exactly right for copy that SELLS the pass — disclosure of the bound is the
// whole point — and incoherent for copy about a pass that has already stopped,
// where the competition is by definition no longer running.
//
// So this list is not "all pass copy"; it is "copy that offers the pass and must
// therefore say what bounds it". The ended-lifecycle strings are a different
// claim family and are pinned by APPROVED_DICTIONARY_COPY instead, which is
// enforced independently (`approvedDictionaryFaults`) and is the half that
// forces a new wording to be justified against code in its `why`. That is the
// mechanism the missing gate cost us: `pass.entry.ended.nextBody` shipped
// claiming Pro "lifts the same limits", which #337 records as FALSE for an
// event_pass_l holder (unlimited entrants vs Pro's 256) and which the
// comparison table five rows above it on the same screen contradicts.

const PASS_BOUND_VALUES: LocalisedValue[] = PASS_BOUND_KEYS.flatMap(([file, key]) =>
  across(file, key),
);

/**
 * Every `pricing.faq.*.a` answer, classified. The /pricing FAQ is where the
 * missed key lived, so the question "which answers make a pass-duration claim"
 * is answered as DATA, computed from the dictionary — a NEW faq key reds this
 * suite until someone decides which side it falls on.
 *
 * A blanket permanence scan over all FAQ answers is the wrong tool and was
 * measured as such: `pricing.faq.card.a` truthfully says Community is "free
 * forever", and a repo-wide sweep found 18 keys with permanence hits of which
 * 17 are TRUE claims about other subjects (permanent deletion, credit packs
 * that genuinely never expire, the Community plan). Scoping is not laziness
 * here; it is the only way the rule stays honest.
 */
const FAQ_PASS_SCOPED = ["pricing.faq.eventPass.a", "pricing.faq.upgraded.a"];
const FAQ_EXEMPT: Record<string, string> = {
  "pricing.faq.card.a": "about payment details; its 'free forever' is Community's, and true",
  "pricing.faq.trialEnd.a": "about the trial ending; makes no pass-duration claim",
  "pricing.faq.fees.a": "about the fee ladder; a rate claim, guarded by the help-tree fee-lock rules",
  // W3 fix round 2, item 6: the dedicated Platform fee entry — no pass-
  // duration claim, so it sits beside pricing.faq.fees.a here rather than on
  // FAQ_PASS_SCOPED. Its own rate claim (three live percentages, and that the
  // fee is additive to Stripe's own) is pinned in APPROVED_DICTIONARY_COPY
  // instead, the same mechanism pricing.faq.fees.a's neighbour rate claims
  // already use.
  "pricing.faq.platformFee.a":
    "the dedicated platform-fee entry — no pass-duration claim, so it is not on FAQ_PASS_SCOPED. Its rate/additive claim is pinned verbatim in APPROVED_DICTIONARY_COPY instead, the same mechanism pricing.matrix.orgs.max_owned.note and pricing.pass.crossover already use",
  "pricing.faq.groups.a":
    "about billing groups — makes no pass-duration claim, but IS scanned for the half-rate claim via HALF_CLAIM_KEYS (its bare 'half your plan's rate' was live for two rounds)",
  "pricing.faq.currencies.a": "about currency pinning",
  "pricing.faq.annual.a": "about annual billing",
  "pricing.faq.cancel.a": "about cancelling Pro; no pass claim",
};

/** The one pass string that quantifies the credit grant. */
const PASS_CREDIT_VALUES = across("marketing", "pricing.faq.eventPass.a");
// W2 T5: the grant is per rung, so the figures come off the declaration rather
// than being typed here — a repricing moves these proofs with it.
const M_GRANT = PASS_CREDIT_GRANT.event_pass;
const L_GRANT = PASS_CREDIT_GRANT.event_pass_l;
const GRANTS: readonly number[] = Object.values(PASS_CREDIT_GRANT);
// …and the subset the SHIPPED answer is a claim about. The FAQ describes what a
// reader can buy, so it quotes the grants of the rungs on sale and no others
// (owner decision 2026-09-05 took the L rung off sale). `GRANTS` above stays the
// FULL declared set and is what the guard's own unit cases below exercise, so
// the rule keeps its two-grant teeth while the corpus check narrows.
const SELLABLE_GRANTS: readonly number[] = SELLABLE_PASS_KEYS.map((k) => PASS_CREDIT_GRANT[k]);

// `PLUS_VALUES` — `pricing.faq.proPlus.a`, the /pricing FAQ answer to "What's
// in Pro Plus?" — is DELETED here with the key itself (retired-plan copy sweep).
// V393 removed `pro_plus` from `plans`, and a question ABOUT a plan that does
// not exist has no true rewording: the answer went, not its wording. Its three
// scans (the anti-vacuity floor, the retired-claim registry, the half-rate
// axis) lose one input each; every one of them still has others.

/** #382 review, finding 1 — the Pro card on the per-competition upgrade page
 *  (`app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx`). A FOURTH key axis, and
 *  the reason it now exists: this card sits on the same screen as the Event
 *  Pass it was describing, and V353 moved what the pass covers without moving
 *  the card. Its own file, `ui.json`, not the marketing dictionary — this is
 *  console copy, shown after a gate has already stopped somebody. */
const PRO_CARD_BODY = across("ui", "upgrade.proCard.body");

/**
 * THE PRO PLUS CARD — a THIRD key axis, and the reason it now exists.
 *
 * `pricing.faq.proPlus.a` was the FAQ answer, three cards down the /pricing
 * page; it is deleted with the plan.
 * The card itself is six other keys, and nothing scanned them: task 4 removed
 * "AI-assisted scheduling" from the answer while the card two screens above
 * went on selling it, in all four locales. A page disagreeing with itself is
 * worse than either fixing both or fixing neither — and the axis, not the
 * vocabulary, is what was missing. The pattern for this falsehood already
 * existed (`LOCALE_CLAIMS[*].plusClaims["scheduling.ai"]`); nothing pointed it
 * at these keys.
 *
 * The five bullets are scanned as ONE value per locale because that is how a
 * reader reads them — under the `pricing.plus.note` frame, each one asserting
 * the lower plans lack it. Joined with ". " so a claim cannot reach ACROSS two
 * bullets: every window in these vocabularies is bounded by sentence
 * punctuation, and wrong-clause satisfaction has already appeared three times
 * in this wave.
 *
 * `PLUS_CARD_BULLET_KEYS` / `PLUS_CARD_KEYS` / `PLUS_SOON_KEYS` /
 * `PLUS_CARD_VALUES` retired here — R14 (entitlements v18 W3) deleted the
 * whole `pricing.plus.*` key family from every locale (see
 * `_approved-dictionary-copy.ts`'s header note on the same retirement).
 */

/**
 * ── THE PANEL'S ROW SET, DERIVED FROM THE PAGE (fix round 4) ────────────────
 *
 * Read out of `settings/billing/page.tsx` rather than typed here, so a NEW row
 * is covered the day it is written. A hand-written list was the gap: adding
 * `<li>✓ {t(dict,"billing.community.f8")}</li>` claiming "Unlimited AI schedule
 * credits", with the key in all four dictionaries, scored ZERO faults — the same
 * completeness hole the cards had two rounds ago, on a surface I had just built.
 */
const BILLING_PAGE = readFileSync("src/app/o/[orgSlug]/settings/billing/page.tsx", "utf8");
const PANEL_KEYS: string[] = [
  ...new Set(
    [...BILLING_PAGE.matchAll(/"(billing\.(?:community|pro)\.f\d+)"/g)].map((m) => m[1]!),
  ),
].sort();

/**
 * THE HALF-RATE CLAIM HAS ITS OWN KEY AXIS, and this is why.
 *
 * `localeHalfClaimFaults` was only ever called with the Pro Plus FAQ answer, so
 * `pricing.faq.groups.a` — which says "half your plan's rate", bare, in all four
 * locales, three FAQ cards away — was never scanned. `en.halfClaim` literally
 * spells that phrase out; the pattern existed and nothing pointed it at the key.
 *
 * The pass-permanence axis had been pinned last round. This one had not, and a
 * per-family axis is the only thing that makes "which keys make THIS claim" a
 * decision rather than an oversight.
 *
 * Fix round 4 (task 7) added the third key. `tips.billing.extra-org.body` said
 * "half your plan's rate", bare, in all four locales, through every earlier
 * round of this wave — the SAME phrase as `pricing.faq.groups.a`, matched by
 * the SAME pattern, and again nobody had pointed the rule at the key. An axis
 * is only a decision once every key that makes the claim is on it.
 */
const HALF_CLAIM_KEYS = [
  // `pricing.faq.proPlus.a` left this axis with the key (retired-plan copy
  // sweep). `pricing.faq.groups.a` — the falsehood that started the axis — is
  // still on it, so the family keeps a marketing-side member.
  "pricing.faq.groups.a",
  "pricing.matrix.orgs.max_owned.note",
];

/** …and the same axis in `ui.json`. `across()` takes one file, so the two live
 *  apart; both are pinned by the gate and both are asserted below. */
const HALF_CLAIM_UI_KEYS = [
  "tips.billing.extra-org.body",
  "orgNew.bill.addToExistingHint",
  "billing.group.attach.confirmCharge",
];
const HALF_CLAIM_VALUES: LocalisedValue[] = [
  ...HALF_CLAIM_KEYS.flatMap((key) => across("marketing", key)),
  ...HALF_CLAIM_UI_KEYS.flatMap((key) => across("ui", key)),
];

/**
 * Layer 3 — the literal prose this task deleted, from all four files, checked
 * against all four values of every guarded key.
 *
 * Two of these cannot be vocabulary entries without rejecting true copy, which
 * is exactly why the layer exists:
 *  - fr "pour toute la durée" is a permanence claim about the pass but a
 *    perfectly good BOUND in other sentences ("pendant toute la durée du
 *    match");
 *  - nl "voor de helft van het basistarief" becomes true the moment
 *    "hoogstens" is put in front of it, which is what this task did.
 *
 * Every literal here was checked against the REPLACEMENT copy as well as the
 * old, because a fragment can survive its own retirement: Spanish "a mitad de
 * la tarifa base" is a substring of the corrected "…de **la** mitad de la
 * tarifa base", so the retired form has to carry enough context ("adicional a
 * mitad…") to tell the two apart.
 */
// The three plan-ATTRIBUTION patterns `freeClaimFaults` reads (W2). They live
// in copy-truth's exports, so `inertPatternFaults` demands a fixture for each
// — and `ENTERPRISE_ATTRIBUTION` had none on the run it was added, which is
// the corpus doing exactly its job: a pattern nobody exercises makes every
// assertion resting on it report clean.
const ATTRIBUTION_POSITIVES = [
  // PRO_ATTRIBUTION — all four arms. The "is on Pro" arm was added 2026-09-05
  // with the twelve reasons that name both plans; without a fixture here it was
  // a pattern nothing proved, which is the exact defect the rule below exists
  // for. It was added WITHOUT one, in the same commit that added the pattern.
  "Custom tiebreaker order is a Pro feature.",
  "Player stats are on Pro and the Event Pass.",
  "this needs a Pro plan",
  "upgrade to Pro",
  // PASS_ATTRIBUTION. Used only negatively — a Pro claim is a fault when a pass
  // rung also grants the key and the sentence does not say so — but it is still
  // a pattern, and a pattern nobody can fire is a rule that examines nothing.
  "the Event Pass covers this competition",
  // ENTERPRISE_ATTRIBUTION — both arms, because the second ("needs an
  // Enterprise plan") is the one no shipped sentence uses today.
  "Write access via the API is an Enterprise feature",
  "this needs an Enterprise plan",
  // FREE_ATTRIBUTION
  "your own club logo works on every plan",
  "free for everyone",
];

const RETIRED_CLAIMS = [
  // en
  "for its lifetime",
  "survives forever",
  "event's lifetime",
  "AI-assisted scheduling",
  "one at half the base rate",
  // es
  "de por vida",
  "para siempre",
  "toda la vida del evento",
  "durante toda su vida",
  "asistida por IA",
  "adicional a mitad de la tarifa base",
  // fr
  "à vie",
  "pour toujours",
  "pour toute la durée de l",
  "pour toute sa durée",
  "assistée par IA",
  "à moitié du tarif de base",
  // nl
  "volledige levensduur",
  "hele levensduur",
  // The nl `billing.passOffer.note` reached for a different metaphor than the
  // other four keys ("voor het hele verloop", not "levensduur") — which is the
  // single best argument in this file for why a vocabulary built from one
  // string per language is not a vocabulary.
  "voor het hele verloop",
  "voor altijd",
  // RESTORED. This entry was deleted by mistake while pruning the corpus of
  // fixtures whose patterns went with `plusClaims` — the same literal appeared
  // in BOTH lists, and a line-based sweep took both copies. They are not the
  // same thing: the corpus proves a pattern fires, this list is the retired
  // wording itself, and the nl half of "holds the card's retired AI-scheduling
  // wording, in all four locales" is what caught the loss.
  "AI-ondersteunde planning",
  "organisatie voor de helft van het basistarief",
  // Fix round 1 — `pricing.faq.upgraded.a`. Two claims per locale: the
  // permanence one, and the "Pro covers everything the pass does" over-claim,
  // which is false for the L rung (event_pass_l allows unlimited entrants per
  // division; pro allows 256).
  "passes never expire",
  "covers everything the pass does",
  "nunca caducan",
  "cubre todo lo que hace el pase",
  "expirent jamais",
  "couvre tout ce que fait le pass",
  "verlopen nooit",
  "dekt alles wat de pass doet",
];

/**
 * Copy carrying the same falsehoods that this wave does NOT own. Named as data
 * rather than left silently unscanned, the way `help-copy-truth.test.ts` names
 * its own gaps — closing one then becomes a one-line move instead of a
 * rediscovery.
 */
const KNOWN_GAPS = [
  // CLOSED by task 5, then RETIRED by R14 (entitlements v18 W3):
  // `pricing.plus.f3` (the Pro Plus CARD's third bullet) was covered by
  // PLUS_CARD_VALUES and pinned in APPROVED_DICTIONARY_COPY, together with
  // the frame and the other four bullets, until W3 deleted the whole
  // `pricing.plus.*` family — nothing had rendered it since W2.
  // lib/pricing-cards.ts PLUS_CARD_FEATURES and e2e/pro-plus-tier.spec.ts
  // moved with it, in the same commit as task 5's fix.
  "config/tips.ts:82 — 'half your plan's rate', bare. Hardcoded English with no dictionary lookup, so it is a four-locale gap of its own class; routed to task 7, which is already editing that tip.",
  "content/help/scheduling/ai-scheduling.md, content/help/billing/downgrade.md — task 3's gaps, still open (#303).",
  "BOUNDED_SCOPE_GRAMMAR (and therefore all four `bounded` rules, which share its shape) decides a bound by PROXIMITY inside one sentence, not grammar: a coordinated clause such as 'buy during checkout and your competitions stay active' satisfies it. Task 3's review has this queued for a fix round; the locale rules deliberately delegate to it rather than fork it, so they inherit the repair.",
];

const BOUNDED: Record<DictionaryLocale, string> = {
  en: "One payment upgrades this competition while it's running — bigger limits and a cheaper fee.",
  es: "Un solo pago mejora esta competición mientras está en curso — límites mayores y menos comisión.",
  fr: "Un seul paiement améliore cette compétition tant qu’elle est en cours — des limites plus élevées.",
  nl: "Eén betaling upgradet deze competitie zolang ze loopt — ruimere limieten en lagere kosten.",
};

const REWORDINGS: Record<DictionaryLocale, string[]> = {
  en: [
    "The upgrade never expires.",
    "Passes never expire.",
    "The pass does not expire.",
    "These passes don't expire.",
    "It is yours for life.",
    "The upgrade runs in perpetuity.",
    "There is no end date.",
    "The pass never runs out.",
    "It will not lapse.",
    "The upgrade stays yours.",
    "Bought once, it is yours to keep.",
    "The pass is permanent.",
    "It lasts forever.",
    "The upgrade holds for good.",
    "It never stops.",
    "The pass lasts indefinitely.",
  ],
  es: [
    "La mejora nunca caduca.",
    "Los pases nunca caducan.",
    "El pase no caduca.",
    "Los pases no caducan.",
    "Las mejoras nunca expiran.",
    "El pase nunca vence.",
    "Los pases nunca vencen.",
    "Es tuyo de por vida.",
    "La mejora es permanente.",
    "Las mejoras son permanentes.",
    "El pase dura indefinidamente.",
    "Sin fecha de caducidad.",
    "Sin vencimiento.",
    "La mejora se conserva para siempre.",
    "El pase se mantiene de forma indefinida.",
    "Los pases caducan nunca.",
  ],
  fr: [
    "L'amélioration n'expire jamais.",
    "Les pass n'expirent jamais.",
    "Le pass n'expire pas.",
    "Les pass expirent jamais.",
    "L'amélioration ne se termine jamais.",
    "Les améliorations ne se terminent jamais.",
    "C'est à vous à vie.",
    "L'amélioration est permanente.",
    "Les pass sont permanents.",
    "Le pass dure indéfiniment.",
    "Sans date d'expiration.",
    "Sans échéance.",
    "L'amélioration vaut pour toujours.",
    "Le pass est acquis définitivement.",
    "Sans limite de durée.",
    "Le pass tient pour de bon.",
  ],
  nl: [
    "De upgrade verloopt nooit.",
    "Passes verlopen nooit.",
    "De pass vervalt nooit.",
    "Passes vervallen nooit.",
    "De upgrade eindigt nooit.",
    "De pass stopt nooit.",
    "Het is voorgoed van jou.",
    "De upgrade is permanent.",
    "De passes zijn permanent.",
    "Geen vervaldatum.",
    "Geen einddatum.",
    "De pass is onbeperkt geldig.",
    "De upgrade geldt voor onbepaalde tijd.",
    "De pass blijft altijd geldig.",
    "Het blijft eeuwig staan.",
    "De pass verloopt niet.",
  ],
};

/**
 * A FRESH adversarial set, written AFTER this round's rules were final —
 * ordinary editorial prose, including the five phrasings the reviewer cited.
 * No rule was adjusted to accommodate any of it. See the two tests that
 * measure against it: the vocabulary catches 1, the approved-wording gate 40.
 */
const FRESH: Record<DictionaryLocale, string[]> = {
  en: [
    "You will never lose it.",
    "There is no use-by date on a pass.",
    "Buy it once and it is settled.",
    "The upgrade is not time-boxed.",
    "Nothing takes it away later.",
    "It is a one-and-done purchase that stands.",
    "The pass will still be there next season.",
    "We do not claw the upgrade back.",
    "It outlives the event itself.",
    "Consider it yours from then on.",
  ],
  es: [
    "El pase no tiene fecha de caducidad.",
    "Nunca lo vas a perder.",
    "Cómpralo una vez y asunto resuelto.",
    "La mejora no está limitada en el tiempo.",
    "Nada te lo quita después.",
    "El pase seguirá ahí la próxima temporada.",
    "No retiramos la mejora.",
    "Sobrevive al propio evento.",
    "Considéralo tuyo a partir de entonces.",
    "La mejora no se retira jamás.",
  ],
  fr: [
    "Le pass ne s'éteint pas.",
    "Vous ne le perdrez jamais.",
    "Achetez-le une fois et c'est réglé.",
    "L'amélioration n'est pas limitée dans le temps.",
    "Rien ne vous le retire ensuite.",
    "Le pass sera encore là la saison prochaine.",
    "Nous ne reprenons pas l'amélioration.",
    "Il survit à l'événement lui-même.",
    "Considérez-le comme acquis dès lors.",
    "Le pass n'a pas de date de péremption.",
  ],
  nl: [
    "De pass wordt nooit ingetrokken.",
    "Je raakt hem nooit kwijt.",
    "Koop hem één keer en het is geregeld.",
    "De upgrade is niet in tijd beperkt.",
    "Niets neemt hem later weg.",
    "De pass staat er volgend seizoen nog.",
    "Wij halen de upgrade niet terug.",
    "Hij overleeft het evenement zelf.",
    "Beschouw hem vanaf dan als de jouwe.",
    "De pass heeft geen houdbaarheidsdatum.",
  ],
};

const ADVERSARIAL: Record<DictionaryLocale, string[]> = {
  en: [
    "The pass has no end.",
    "Once bought, it is yours for the rest of time.",
    "The upgrade carries on without limit.",
    "There is no cut-off.",
    "It sticks around no matter what.",
    "The pass endures.",
    "You keep it always.",
    "It remains in force whatever happens.",
  ],
  es: [
    "El pase no tiene fin.",
    "No hay fecha límite.",
    "La mejora perdura.",
    "El pase te acompaña siempre.",
    "El pase sigue activo siempre.",
    "Lo conservas sin límite de tiempo.",
    "La mejora queda ahí para el resto del tiempo.",
    "El pase permanece.",
  ],
  fr: [
    "Le pass ne prend jamais fin.",
    "Aucune date limite.",
    "Le pass demeure valable.",
    "Une fois acheté, c’est pour la vie.",
    "L’amélioration subsiste.",
    "Vous le gardez toujours.",
    "Le pass tient sans limite de durée.",
    "Il n’y a pas de terme.",
  ],
  nl: [
    "De pass kent geen einde.",
    "De pass blijft bestaan.",
    "De pass houdt niet op.",
    "Je houdt hem altijd.",
    "Er is geen afkapdatum.",
    "De upgrade blijft staan wat er ook gebeurt.",
    "De pass duurt onbeperkt.",
    "Het blijft je hele leven gelden.",
  ],
};

/**
 * The known-positive corpus for the module-wide anti-vacuity check.
 *
 * Every exported pattern in `@/lib/copy-truth` must match at least one line
 * here. It is assembled from the fixture sets this suite already maintains plus
 * a supplementary list for the rules owned by tasks 1 and 3 (the Stripe seed and
 * the help tree), so the check covers the WHOLE module — the point being that a
 * pattern which can never fire is invisible to the suite that owns it, as this
 * wave has now demonstrated twice.
 *
 * Adding a pattern therefore means adding a string it matches. That is the
 * cheapest possible proof that it does something, and it is enforced in both
 * directions: an unused fixture is a fault too.
 */
const KNOWN_POSITIVES: string[] = [
  ...ATTRIBUTION_POSITIVES,
  ...Object.values(REWORDINGS).flat(),
  ...Object.values(ADVERSARIAL).flat(),
  ...Object.values(BOUNDED),
  // ── The bound, in each language, and the activity words it can govern ──
  "the pass applies while the competition is open",
  "valid until the competition is live",
  "during the event the pass runs",
  "for as long as the competition is under way",
  "el pase se aplica mientras la competición está activa",
  "válido hasta que la competición esté abierta",
  "mientras dure la competición",
  "durante el tiempo que la competición esté en marcha",
  "mientras se juegue la competición",
  "hasta que dura la competición",
  "le pass s'applique tant que la compétition est ouverte",
  "pendant que la compétition est active",
  "jusqu'à ce que la compétition se déroule",
  "aussi longtemps que la compétition dure",
  "de pass geldt zolang de competitie actief is",
  "terwijl de competitie open is",
  "totdat de competitie bezig is",
  "tot de competitie draait",
  "zolang de competitie duurt",
  // ── Retired AI-run cap (task 1/3) ──
  "10 AI schedule runs per division",
  "three runs a division",
  "an allowance of AI schedule runs for each division",
  "a monthly quota of AI schedule generations per division",
  "per-division AI schedule runs",
  "each division gets its own AI schedule generations",
  "every competition comes with its own allowance of scheduling runs",
  "5 AI runs",
  "two schedule runs",
  "AI scheduling is limited to 5 attempts per division",
  "Each division may be scheduled by AI up to 20 times.",
  // ── AI runs claimed unmetered/free (#303) ──
  "Officials AI runs are not metered.",
  "The schedule pass is unmetered.",
  "You can restaff as often as you like.",
  "Just run it as often as you like.",
  "Run it as often as you like, at no cost.",
  "Officials AI runs are free.",
  "It costs nothing to restaff.",
  "AI schedule runs are uncapped.",
  // ── Joint undo claimed all-or-nothing, or described as the retired
  //    per-division loop (#392). One fixture per pattern in each family; the
  //    reverse check below (an unused fixture is a fault) keeps them honest.
  "Each division gets its own before-AI save point, so one undo puts the whole thing back.",
  "A single undo restores every division at once.",
  "Every division is put back at once.",
  "Undo reverses the entire run.",
  "Undo rolls back the whole joint apply in one step.",
  "Each division gets its own before-AI save point, and undo restores them one at a time.",
  "The undo goes one by one through the divisions.",
  "The console sends one request per division when you undo.",
  "Undo makes a separate restore for each division.",
  "Undo rewinds each division in turn.",
  // ── Scoring detail sold as paid (entitlements v18 / W1) ──
  //    One fixture per alternation of SCORING_DETAIL, and one each for the two
  //    halves of the price vocabulary, so a mangled escape in any of the three
  //    reds `inertPatternFaults` instead of silently matching nothing.
  "Ball-by-ball scoring is a Pro feature.",
  "Rally-by-rally is the finest level and needs a plan that includes it.",
  "Timeline and Detail need a plan that includes match-timeline scoring.",
  "Match timelines (scorers, cards, minutes) are a Pro feature.",
  "The recording detail you want is on Pro.",
  "One of the events needs a scoring detail your organisation isn't entitled to.",
  "Needs a detail level this plan doesn't include — upgrade to record it.",
  "Recording detail beyond Card is not included on Community.",
  "Every recording level is available on every plan.",
  // …and the same claim in the three languages the dictionaries are written in.
  //    One fixture per non-English `detail` and `affirmation` pattern — the
  //    `planName`/`paidVerb` halves already fire on the English lines above,
  //    because plan names are untranslated and "plan" is a Spanish/Dutch word.
  "La puntuación bola a bola requiere un plan Pro.",
  "Cada nivel de detalle está disponible en todos los planes.",
  "Le score balle par balle nécessite un forfait Pro.",
  "Chaque niveau de détail est disponible sur tous les forfaits.",
  "Bal-voor-bal scoren vereist een Pro-abonnement.",
  "Elk detailniveau is beschikbaar op elk abonnement.",
  // ── The annual saving, stated as a floor (entitlements v18 / W2) ──
  //    One line per locale, each carrying all three parts of
  //    `ANNUAL_SAVING_CLAIM` — numeral, unit and giveaway — so twelve patterns
  //    are proven live by four fixtures, and a mangled escape in any of them
  //    reds here instead of quietly matching nothing.
  "Paying yearly is more than two months free.",
  "Pagar por a\u00f1o son m\u00e1s de dos meses gratis.",
  "Payer \u00e0 l'ann\u00e9e, c'est plus de deux mois offerts.",
  "Per jaar betalen is meer dan twee maanden gratis.",
  // ── Per-plan CAPACITY claims (entitlements v18 / W2) ──
  //    Six one-word fixtures, because these patterns read TABLE CELLS rather
  //    than sentences: `PLAN_CAP_AXES[*].column` and the two cell patterns are
  //    `^…$`-anchored on purpose, so that "20 per club" is not read as the cap
  //    20 and "No change" is not read as a grant. A prose fixture matches none
  //    of them, and a pattern nothing matches is exactly what this list exists
  //    to catch.
  "Clubs",
  "Teams",
  "Squad size",
  "Members",
  "Unlimited",
  "23",
  // ── Task 3's APPROVED FORMS (the help-tree allowlist) ──
  // These are positives in the opposite sense to everything else here: they are
  // the shapes the help copy is ALLOWED to use, so each one is a real sentence
  // from content/help/billing/event-pass.md. A form that matches nothing is a
  // form no copy can satisfy, which would make the allowlist unusable rather
  // than merely inert — the same failure, from the other side.
  "Its end date passed more than 7 days ago, so the pass has stopped applying",
  "It does not carry to next season's edition — a new edition is a new competition",
  "the pass is bought outright for that event and survives a downgrade",
  "the pass is bound to the competition itself, not its name",
  "if the first card entry was taken while the pass was live, the pass's cheaper rate rides on",
  // ── Pro Plus differentiators, four languages ──
  "AI-assisted scheduling",
  "scheduling powered by AI",
  "auto officials assignment",
  "officials assigned automatically",
  "write API access",
  "priority support",
  "the largest monthly AI credit grant",
  "la mayor asignación mensual de créditos de IA",
  "la plus grosse dotation mensuelle de crédits IA",
  "automatische toewijzing van officials",
  "officials automatische toewijzing",
  "de grootste maandelijkse AI-credittoekenning",
  // ── The rider rate, four languages ──
  "each extra one at half the base rate",
  "at no more than half the base rate",
  "half your plan's rate",
  "cada una adicional a mitad de la tarifa base",
  "a mitad de precio",
  "por no más de la mitad de la tarifa base",
  "à moitié du tarif de base",
  "à moitié prix",
  "pour au plus la moitié du tarif de base",
  "voor de helft van het basistarief",
  "tegen halve prijs",
  "voor hoogstens de helft van het basistarief",
  // ── Recurring cadence (the inverse of the one-time grant) ──
  "25 AI credits monthly",
  "credits every month",
  "credits each month",
  "credits per month",
  "25 credits a month",
  "a recurring top-up",
  // M4: the recurring family beyond monthly — a yearly or weekly repeat is the
  // same falsehood about a one-time grant.
  "25 AI credits annually",
  "an annual credit grant",
  "25 credits a year",
  "credits weekly",
  "credits every week",
  "the grant renews",
  "credits each billing period",
  "créditos mensuales",
  "créditos al mes",
  "créditos cada mes",
  "créditos por mes",
  "un abono recurrente",
  "des crédits mensuels",
  "des crédits par mois",
  "des crédits chaque mois",
  "un crédit récurrent",
  "maandelijkse credits",
  "credits per maand",
  "elke maand credits",
  "iedere maand credits",
  "een terugkerende bijboeking",
  // #338 item 3 — the same recurring falsehood, yearly/weekly/quarterly, in
  // es/fr/nl (the English list already had this half; these three did not).
  "créditos anuales",
  "créditos al año",
  "cada año recibes créditos",
  "por año recibes créditos",
  "créditos semanales",
  "cada semana recibes créditos",
  "créditos trimestrales",
  "en cada renovación recibes créditos",
  "des crédits annuels",
  "des crédits par an",
  "chaque année vous recevez des crédits",
  "tous les ans vous recevez des crédits",
  "des crédits hebdomadaires",
  "chaque semaine vous recevez des crédits",
  "des crédits trimestriels",
  "à chaque renouvellement vous recevez des crédits",
  "jaarlijkse credits",
  "credits per jaar",
  "elk jaar credits",
  "wekelijkse credits",
  "elke week credits",
  "credits per kwartaal",
  "bij elke verlenging credits",
  // ── The V312 fee lock and its reversion claim (task 3) ──
  "the platform fee returns to your plan's rate",
  "the fee reverts to whatever your plan charges",
  "Community's 8% applies again to every later entrant",
  "the rate goes back to 8%",
  "the fee will rise once the event closes",
  "the 5% resets to the plan rate",
  "the fee rate moves to your plan's own rate",
  "the fee went back up",
  "the entry-fee rate drops back to the plan rate",
  "the fee falls back to your plan's rate",
  "the rate switches back after the pass ends",
  "the fee climbs to Community's rate",
  "the fee jumps to 8%",
  "the platform fee is restored to your plan's rate",
  "Once a competition has taken its first paid entry the platform fee it charges is locked for the rest of that competition.",
  "the fee is fixed after the first paid entry",
  "the rate is frozen once you have taken a paid registration",
  "the fee is pinned at the first paid entrant",
  "the rate stays at 5% after the first paid payment",
  "the fee does not rise once the competition has had its first paid entry",
  "the fee does not change after the first paid entry",
  "the fee does not move once the first paid entry lands",
  "a competition that never took a paid entrant keeps its plan rate",
  "no paid entry means the rate still follows your plan",
  "the competition has already taken a paid registration, so its fee is locked",
  "it took its first paid entry last week and the rate is locked",
  "the competition had a paid entry, so the fee is fixed",
  "the competition has had a paid registration and the rate is frozen",
  // ── The permanence claim about a RATE, which is TRUE and must be matchable ──
  "that 5% rate is locked for good",
  "esa comisión queda fijada permanentemente",
  "ce taux est verrouillé définitivement",
  "dat tarief staat permanent vast",
  // ── Fee ladder rows ──
  "| Community | 8% |",
  // ── Seed STRUCTURE, not copy: NON_SECTION_KEY names the seed keys that are
  //    developer notes or scalars rather than product lists. ──
  "$comment_tiers",
  "currency",
  // ── Permanence vocabulary whose exemplars this wave DELETED from the copy ──
  //
  // These are the reason the corpus exists rather than being derived from the
  // shipped strings: a pattern written to catch a falsehood has, by the time the
  // fix lands, nothing left in the repo to match. Without a fixture it becomes
  // indistinguishable from a pattern that never worked.
  "yours for the event's lifetime",
  "the pass has no expiry",
  "there is no time limit",
  "keep it as long as you want",
  "it keeps working after the competition ends",
  "the upgrade never switches off",
  "no limit on how long it lasts",
  "the upgrade holds without end",
  "tuyo durante toda la vida del evento",
  "el pase vale por tiempo indefinido",
  "el pase es siempre tuyo",
  "el pase es tuyo para siempre",
  "la mejora sigue siendo tuya",
  "un pase sin fin",
  "el pase sigue vigente",
  "le pass est à vous à jamais",
  "le pass vaut de manière permanente",
  "un pass à durée illimitée",
  "le pass ne se termine jamais",
  "le pass reste valable à vie",
  "aucune limite de durée",
  "un pass sans fin",
  "van jou voor de hele levensduur van het evenement",
  "de pass geldt voor het hele verloop",
  "de pass is voor altijd van jou",
  "de pass verloopt nooit meer",
  "de pass gaat nooit verlopen",
  "de upgrade is altijd van jou",
  "een pass zonder einde",
  // ── W3: `localePaidOverclaimFaults`'s vocabulary (formats.double_elim /
  //    formats.advanced) ──
  //
  // The four `formats.double_elim` exemplars are strings THIS TASK'S FIX
  // DELETED from `pricing.pass.f3` — same reason as the permanence exemplars
  // above: a pattern written to catch a falsehood has, once the fix lands,
  // nothing left in the repo to match. "americano" alone exercises all FOUR
  // locale forms of the `formats.advanced` pattern (the word is identical in
  // en/es/fr/nl), and it IS still live in `pricing.pass.f3` today — added here
  // too because this corpus is static and never reads the dictionary.
  "double elim",
  "doble eliminación",
  "double élimination",
  "dubbele eliminatie",
  "americano",
  // ── W3-A: `localePaidOverclaimFaults`'s THIRD vocabulary entry
  //    (stats.player) ──
  //
  // "player stats" is the phrase THIS TASK'S FIX DELETED from `pricing.pro.f4`
  // and `tips.billing.event-pass.body` (V399 froze `stats.player` true on
  // every plan) — same reasoning as the double-elim exemplars above: once the
  // fix lands, nothing left in the repo matches it, so this static corpus
  // carries it instead.
  "player stats",
  "estadísticas de jugadores",
  "statistiques des joueurs",
  "spelersstatistieken",
];

// FIX ROUND 4, CI BLOCKER. Round 3 added an `it` that calls `sql` inside this
// block while it was a bare `describe`, so a DB-less run threw
// "DATABASE_URL is not set" — and ci.yml's unit job has no DATABASE_URL, which
// means this PR redded that job on every push. Measured DB-less before the fix:
// 75 pass / 1 fail / 33 pending. The Postgres job selects `src/server src/lib`,
// so the gated half still runs there.
describe.skipIf(!HAS_DB)("the four-locale dictionaries say what the resolver enforces", () => {
  it("names the gaps it does not cover, so an unscanned string is a decision", () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
  });

  // The structural rule. Everything else in this file iterates
  // DICTIONARY_LOCALES; if that list drifts from the directories that actually
  // ship, the iteration is the thing that silently stops covering a language.
  it("guards every dictionary locale that exists, and no phantom ones", () => {
    expect(localesOnDisk).toEqual([...DICTIONARY_LOCALES].sort());
    expect(localeCoverageFaults(localesOnDisk)).toEqual([]);
    // …and a locale added tomorrow reds, rather than shipping unguarded.
    expect(localeCoverageFaults([...localesOnDisk, "de"])).toEqual([
      "de/: a dictionary locale with no entry in LOCALE_CLAIMS — its copy is scanned by nothing",
    ]);
  });

  // THE KEY AXIS, asserted the way the locale axis already was. Deleting a key
  // from PASS_BOUND_KEYS must red — before fix round 1 it did not, and that is
  // precisely how `pricing.faq.upgraded.a` stayed invisible.
  it("scans every key it claims to, so dropping one reds", () => {
    expect(PASS_BOUND_VALUES).toHaveLength(PASS_BOUND_KEYS.length * DICTIONARY_LOCALES.length);
    expect([...new Set(PASS_BOUND_VALUES.map((v) => v.key))].sort()).toEqual(
      [...new Set(PASS_BOUND_KEYS.map(([, k]) => k))].sort(),
    );
    expect(PASS_BOUND_KEYS.length).toBeGreaterThanOrEqual(6);
  });

  // …and the discovery rule that would have caught it: every FAQ answer on the
  // pricing page is either pass-scoped or exempt WITH A REASON. A new one is a
  // decision, not an omission.
  it("classifies every pricing FAQ answer as pass-scoped or exempt", () => {
    const en = load("en", "marketing");
    const answers = Object.keys(en)
      .filter((k) => /^pricing\.faq\..+\.a$/.test(k))
      .sort();
    expect(answers.length, "no FAQ answers found — the key shape changed").toBeGreaterThan(5);
    expect(answers).toEqual([...FAQ_PASS_SCOPED, ...Object.keys(FAQ_EXEMPT)].sort());
    // Every pass-scoped FAQ answer must actually be in the guarded set.
    for (const key of FAQ_PASS_SCOPED) {
      expect(PASS_BOUND_KEYS.some(([, k]) => k === key), `${key} classified pass-scoped but unguarded`).toBe(true);
    }
    // …and no exemption may be blank, so "exempt" always carries a why.
    for (const [key, why] of Object.entries(FAQ_EXEMPT)) {
      expect(why.length, `${key} has an empty exemption reason`).toBeGreaterThan(10);
    }
  });

  // Anti-vacuity for the whole file: every guard below is `toEqual([])` over a
  // scan, and a scan of nothing returns []. These are the inputs.
  it("actually has copy to scan, in every locale", () => {
    for (const { locale, key, value } of PASS_BOUND_VALUES) {
      expect(value, `${locale} ${key} is missing or empty`).toBeTruthy();
      expect(value.length, `${locale} ${key}`).toBeGreaterThan(20);
    }
    for (const claims of Object.values(LOCALE_CLAIMS)) {
      expect(claims.permanence.length).toBeGreaterThan(4);
      // `plusClaims` left `LocaleClaims` in W2 with the guard that read it —
      // see copy-truth.ts. The remaining two lists are what this floor covers.
      expect(claims.recurring.length).toBeGreaterThan(2);
    }
  });

  /**
   * THE GATE. Every rule below it reads a sentence and decides whether it is
   * false; this one asks only whether the sentence is the approved sentence.
   *
   * It is first because it is the rule that does not depend on anyone having
   * imagined the right falsehood — and because the falsehood that survived two
   * rounds of vocabulary widening (`pricing.faq.groups.a`) had a pattern
   * written for it already. Nothing had pointed the pattern at that key; a
   * pinned string needs no one to remember.
   */
  it("matches the approved wording, in every locale", () => {
    expect(
      approvedDictionaryFaults(APPROVED_DICTIONARY_COPY, (file, locale) => load(locale, file)),
    ).toEqual([]);
  });

  // …and the gate covers the keys that make the claims. An inventory that has
  // quietly stopped including a key is the failure this whole round was about.
  it("pins every key that makes a pass or rate claim", () => {
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    for (const [, key] of PASS_BOUND_KEYS) {
      expect(pinned.has(key), `${key} is scanned for pass claims but not pinned`).toBe(true);
    }
    for (const key of [...HALF_CLAIM_KEYS, ...HALF_CLAIM_UI_KEYS]) {
      expect(pinned.has(key), `${key} makes a half-rate claim but is not pinned`).toBe(true);
    }
    // The Pro Plus card and its roadmap (PLUS_CARD_KEYS / PLUS_SOON_KEYS) were
    // pinned here until R14 (entitlements v18 W3) deleted the whole
    // `pricing.plus.*` family — nothing had rendered it since W2.
    // FIX ROUND 4: the in-app comparison panel. Polarity never reads the string,
    // so without these the original f5 defect could be restored verbatim and
    // ship green — measured, 109/109.
    for (const key of PANEL_KEYS) {
      expect(pinned.has(key), `${key} is an in-app panel claim but is not pinned`).toBe(true);
    }
    // 236 -> 256: the five `pass.entry.ended.*` keys x four locales, pinned by
    // the W8 review round. 256 -> 252: entitlements v18 R13 hid the extra-seat
    // add-on, so `pricing.addons.seat` no longer exists to pin in any locale.
    // 252 -> 248: the retired-plan copy sweep deleted `pricing.faq.proPlus.a`,
    // the answer to a question about a plan V393 removed from `plans`.
    // 248 -> 252: `pricing.pass.crossover`, the pass-vs-Pro comparator W2 added
    // to the Event Pass card — the page priced both offers and never said which
    // one was cheaper, or from what volume of entry fees that changes.
    // 252 -> 340: the 22 plan-card bullets W2 moved out of `pricing-cards.ts`'s
    // hardcoded English arrays and into the four dictionaries. They are the
    // cards' claims about what each plan grants, and until this wave they were
    // not dictionary copy at all — /es/pricing rendered them in English.
    // 340 -> 356: the Pro card's own price chrome (`pricing.pro.per`,
    // `annualBilled`, `annualSaving`, `monthlyNote`), hardcoded English inside
    // `components/pro-price-card.tsx` until 2026-09-05 and therefore invisible
    // to every rule here — a key-shaped guard cannot classify a string that has
    // no key. `annualSaving` is the one that mattered: it read "save 30%" while
    // the FAQ two screens below already carried the corrected floor.
    // 356 -> 296: R14 (entitlements v18 W3) retired the `pricing.plus.*` family
    // outright (18 keys: the Pro Plus card's frame, its five bullets, its price
    // suffix, its eight-item roadmap) and the M/L ladder's two caps keys
    // (`pricing.pass.ladder.caps` / `.capsUnlimited`) — replaced by the Event
    // Pass ticket's stub, which quotes the same caps under new keys
    // (`pricing.pass.stub.caps` / `.capsUnlimited`) plus the new
    // `pricing.card.feePill` the Free/Pro cards both print. Net -15 keys.
    // 296 -> 300: W3 fix round 2 (item 6, controller extension) added
    // `pricing.matrix.fees.note`, the fees row's own additive-fee disclosure
    // — the same "full sentence quoting a rate, not a row label" shape
    // `orgs.max_owned.note` already is.
    // 300 -> 304: same round, item 6's main ask — the dedicated
    // `pricing.faq.platformFee.a` entry, naming three live rates and the
    // same additive disclosure. Net +2 keys.
    // A count, not a floor, so a DELETED pin reds too.
    expect(APPROVED_DICTIONARY_COPY.length * DICTIONARY_LOCALES.length).toBe(304);
    // Every entry must say what it claims and what decides it — a pin with no
    // `why` is a snapshot, and a snapshot teaches the next editor to re-record
    // rather than to re-check.
    for (const entry of APPROVED_DICTIONARY_COPY) {
      expect(entry.why.length, `${entry.key} has no source-of-truth note`).toBeGreaterThan(40);
    }
  });

  /**
   * ── EVERY `pricing.*` KEY IS A DECISION ──────────────────────────────────
   *
   * The structural version of this file's oldest lesson, applied to the whole
   * page instead of one claim family. `FAQ_EXEMPT` already forces every
   * `pricing.faq.*.a` answer to be classified; this forces every OTHER pricing
   * key to be classified too.
   *
   * It exists because a fresh probe set, written after the card rules were
   * final, found two live holes of the same shape — `pricing.plus.per` and
   * `pricing.credits.perMonthOperator`, both money claims, both one word from
   * false, both scanned by nothing. Neither was exotic; nobody had asked the
   * question "which pricing keys make a claim?" as DATA.
   *
   * A key matching no rule is a fault, so a string added to /pricing tomorrow
   * reds until someone decides which side it falls on. A rule matching no key is
   * a fault too — that is how a disposition list rots into decoration.
   */
  const PRICING_KEY_DISPOSITION: Array<{ match: RegExp; pinned: boolean; why: string }> = [
    {
      // `plus\.(note|f\d|soonLabel|soon\d)` retired here — R14 (entitlements
      // v18 W3) deleted the whole `pricing.plus.*` family, since nothing had
      // rendered it since W2.
      match: /^pricing\.pass\.note$/,
      pinned: true,
      why: "the pass card's duration note — claim-bearing copy, pinned verbatim",
    },
    {
      // `plus\.per` and `pass\.ladder\.caps\w*` retired with `pricing.plus.*`
      // and the M/L ladder UI (R14); the ladder's caps claim now lives on
      // `pass\.stub\.caps\w*`, and the fee pill on `card\.feePill` — both added
      // here rather than opening a new rule, since they are the SAME claim
      // class (a live number, words around it that decide what it means).
      match: /^pricing\.(credits\.\w+|addons\.(credits|seat|org|sizePack)|card\.feePill|pass\.(per|from|stub\.caps\w*)|community\.price)$/,
      pinned: true,
      why: "quotes money or an allowance — the number is interpolated live, so the words around it are the claim",
    },
    {
      // W2: the pass-vs-Pro comparator. It states WHICH offer is cheaper and up
      // to what volume of entry fees — a claim no `plan_entitlements` row makes
      // on its own, because it is derived from two prices and two rates at once.
      match: /^pricing\.pass\.crossover$/,
      pinned: true,
      why: "names the point where a month of Pro overtakes the Event Pass, and the two platform-fee rates that put it there. Every figure is live (lib/pricing-crossover.ts over stripe-plans.json + registration.fee_percent); the words are what say which side is which, and swapping them mis-sells the one-time sku",
    },
    {
      // W2 (entitlements v18): the three plan cards' bullets. They were
      // hardcoded English arrays in lib/pricing-cards.ts until this wave and
      // had no dictionary keys at all, which is exactly why nothing here
      // classified them — the most claim-bearing copy on the page was outside
      // the rule that exists to make every pricing string a decision, because
      // the rule can only see keys. Every figure they quote is now interpolated
      // from plan_entitlements, so what is pinned is the wording.
      match: /^pricing\.(community|pass|pro)\.f\d+$/,
      pinned: true,
      why: "the Community / Event Pass / Pro card bullets. Each names the plan_entitlements rows its card claims; the caps and fee rates inside them are interpolated live by cardBullets in lib/pricing-cards.ts, and the English rendering is judged against the matrix by CARD_SURFACES in lib/__tests__/pricing-cards.test.ts. Pinned here for the WORDS, in four locales side by side",
    },
    {
      // W2 (entitlements v18), 2026-09-05: the Pro card's PRICE CHROME. It was
      // hardcoded English in `components/pro-price-card.tsx` on every locale
      // until this task, so it had no keys and this rule could not see it —
      // the same blind spot the card bullets sat in one commit earlier, and
      // the reason "every pricing key is a decision" is only ever as wide as
      // the set of strings that HAVE keys.
      match: /^pricing\.pro\.(per|annualBilled|annualSaving|monthlyNote)$/,
      pinned: true,
      why: "the Pro card's price chrome: the /month suffix, the yearly total line, the annual saving and the monthly-billing note. Each one quotes or qualifies money, the figures inside them are interpolated live from stripe-plans.json, and the saving is the claim that stood on this card as a flat 'save 30%' — false in all four markets and contradicting the FAQ on the same page. Held against the seed's own ladder by the annual-saving suite below",
    },
    {
      match: /^pricing\.pro\.annualToggle$/,
      pinned: false,
      why: "the label on the Pro card's annual/monthly switch. It names the control; what either option costs is stated by pricing.pro.per, annualBilled and annualSaving, all three pinned",
    },
    {
      match: /^pricing\.faq\./,
      pinned: false,
      why: "answers are classified individually by FAQ_PASS_SCOPED / FAQ_EXEMPT above, and the claim-bearing ones are pinned there; questions make no claim",
    },
    {
      // MINOR, fix round 2. "Your plan already includes everything here" was
      // exempted by a rule whose stated reason is "they identify a card, they do
      // not describe what it grants" — it plainly described what a plan grants,
      // and it was FALSE against Event Pass L (unlimited entrants against pro's
      // 256, #337). Rewritten to the resolver-backed reason and pinned.
      match: /^pricing\.pass\.included$/,
      pinned: true,
      why: "explains why a paid org is not offered a pass. It asserted Pro superset-of-pass, which #337 records as untrue for the L rung; it now states the V338 dormancy rule instead",
    },
    {
      // FIX ROUND 2. This key is a whole SENTENCE quoting the extra-organisation
      // rate, not a label — and the "row labels" rule below formally certified
      // it exempt while it still said "half", bare, in all four locales. Its
      // three siblings had already been corrected. The rule written to make
      // every key a decision made the wrong decision about this one, which is
      // why the exempt side is now vocabulary-scanned as well as classified.
      match: /^pricing\.matrix\.orgs\.max_owned\.note$/,
      pinned: true,
      why: "a full sentence in the matrix quoting the extra-organisation rate — pinned by task 7 and scanned by HALF_CLAIM_KEYS; it is emphatically not a row label",
    },
    {
      // W3 fix round 2, item 6 (controller extension): the fees row's own
      // note discloses that the platform-fee percentage is ADDITIVE — charged
      // on top of Stripe's own processing fees, which V398's pure-margin
      // model made true and no copy on the page stated before this. The same
      // "full sentence quoting a rate, not a row label" shape
      // orgs.max_owned.note already is, so it is pinned the same way.
      match: /^pricing\.matrix\.fees\.note$/,
      pinned: true,
      why: "states that the platform fee is ADDITIVE to Stripe's own processing fees, not instead of it — a claim about how the two costs stack, which is exactly the sentence a buyer reading only the row's percentage would miss",
    },
    {
      match: /^pricing\.(?!matrix\.(orgs\.max_owned|fees)\.note$)(matrix|table)\./,
      pinned: false,
      why: "row labels and column headers of the comparison table. Every VALUE in that table is rendered live from plan_entitlements by lib/pricing-matrix.ts, so the labels name features rather than asserting anything about them. This rule once swallowed pricing.matrix.orgs.max_owned.note, a full sentence quoting a rate, so the exempt side is now scanned by the claim vocabularies too — pricing.matrix.fees.note is excluded the same way and for the same reason. pricing.matrix.enterpriseOnly.note stays IN this bucket: 'Enterprise only — talk to us' routes the reader, it asserts no checkable rate or grant, which is the same shape pricing.enterprise.link already is",
    },
    {
      match: /^pricing\.final\.subhead$/,
      pinned: true,
      why: "the closing CTA claims no card is required and names both upgrade paths — three claims in one sentence, and the key this rule found on its first run",
    },
    {
      match: /^pricing\.(meta\.\w+|eyebrow|title|subhead|final\.title)$/,
      pinned: false,
      why: "page chrome, SEO metadata and CTA headings — they set the scene rather than describing what any plan grants",
    },
    {
      // `heading` added here R14: "Bigger than a season?" is the same kind of
      // scene-setting question `text` already was, over the SSO/federations
      // strip rather than the sentence beside it.
      match: /^pricing\.enterprise\.(heading|text|link)$/,
      pinned: false,
      why: "the 'talk to us' strip's heading and prompt. `text` NAMES SSO, which is on the coming-soon roadmap, but both ask whether the reader needs more than Pro rather than stating we ship it",
    },
    {
      match: /^pricing\.(?!addons\.label$)\w+\.(name|cta|ctaSignedIn|popular|label)$/,
      pinned: false,
      why: "tier names, button labels and state text — they identify a card, they do not describe what it grants",
    },
    {
      // `ladderNote` retired with the M/L ladder UI (R14); `stub\.size` was
      // its ticket-era replacement ("Size {rung}") and is ITSELF retired here
      // (W3 fix round 2, item 2 — the owner ruling that "Size M" names a
      // distinction no customer can act on with one sellable rung). Renamed
      // to `stub\.label`, now a plain "Event Pass" with no rung reference at
      // all — still a sub-label identifying the stub slot, nothing more.
      match: /^pricing\.(community\.note|pass\.(rung\.\w|stub\.label)|addons\.label)$/,
      pinned: false,
      why: "sub-labels: the rung letters (M / L), the stub's price-card label and the add-ons heading. The claims they introduce are pinned on the keys that make them",
    },
    {
      // R14: the box-office board. Sport NAMES, translated, and a foot line
      // that names no plan or feature — nothing here claims what any plan
      // grants, so none of it belongs on the pinned side.
      match: /^pricing\.rail\./,
      pinned: false,
      why: "the sport-rail board (R14): ten sport names plus a foot line, none of which describe a plan's entitlements",
    },
  ];

  it("classifies every pricing.* key as pinned or exempt, with a reason", () => {
    const keys = Object.keys(load("en", "marketing")).filter((k) => k.startsWith("pricing."));
    expect(keys.length, "no pricing keys found — the key shape changed").toBeGreaterThan(100);
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    const unclassified: string[] = [];
    const ambiguous: string[] = [];
    const unpinned: string[] = [];
    const used = new Set<number>();
    for (const key of keys) {
      // EVERY match, not the first. `findIndex` made "exactly one rule" a claim
      // the test never checked: a broad early exempt rule silently swallowed
      // later keys, which is how the matrix note came to be certified a "row
      // label" while it quoted a rate.
      const matches = PRICING_KEY_DISPOSITION.map((rule, i) => (rule.match.test(key) ? i : -1)).filter(
        (i) => i !== -1,
      );
      if (matches.length === 0) {
        unclassified.push(key);
        continue;
      }
      if (matches.length > 1) {
        ambiguous.push(
          `${key}: matched by ${matches.map((i) => PRICING_KEY_DISPOSITION[i]!.match.source).join(" AND ")}`,
        );
        continue;
      }
      used.add(matches[0]!);
      if (PRICING_KEY_DISPOSITION[matches[0]!]!.pinned && !pinned.has(key)) unpinned.push(key);
    }
    expect(unclassified, "pricing keys matching no disposition rule").toEqual([]);
    expect(ambiguous, "pricing keys matched by more than one rule — the classification is not a decision").toEqual([]);
    expect(unpinned, "classified as pinned but absent from APPROVED_DICTIONARY_COPY").toEqual([]);
    // …and the inverse: a rule that matches nothing is decoration, and every
    // reason must be a real one.
    expect(
      PRICING_KEY_DISPOSITION.map((r, i) => (used.has(i) ? null : r.match.source)).filter(Boolean),
      "disposition rules matching no key",
    ).toEqual([]);
    for (const rule of PRICING_KEY_DISPOSITION) {
      expect(rule.why.length, rule.match.source).toBeGreaterThan(30);
    }
    // The rule itself must red on a new key nobody classified — the whole point.
    expect(
      ["pricing.plus.newBadge", "pricing.somethingElse"].filter((k) =>
        PRICING_KEY_DISPOSITION.some((rule) => rule.match.test(k)),
      ),
    ).toEqual([]);
  });

  /**
   * ── AND THE EXEMPT SIDE IS SCANNED, NOT TRUSTED (fix round 2, blocking 3) ──
   *
   * Classifying a key exempt records a decision about what it says TODAY. It
   * does nothing about what it says next month. Measured 0/2 in all four
   * locales: a permanence falsehood dropped into `pricing.community.note` and a
   * free-forever claim into `pricing.matrix.orgs.max_owned.note` were both
   * green, because "exempt" was the end of the conversation.
   *
   * So every exempt key is run through the SAME per-locale vocabularies the
   * pinned keys face. An exemption that stops being true now reds — which is the
   * fix already prescribed for `FAQ_EXEMPT` on #338, applied here at the same
   * time so the two sides of this file do not drift apart again.
   *
   * Scoped to the claim families that are FALSE of the subjects on this page:
   * pass permanence and the bare half-rate. Community's "free forever" is TRUE,
   * so the permanence scan is pointed at values that mention the pass or an
   * upgrade rather than at every string — the measured lesson from the
   * repo-wide sweep that found 18 hits of which 17 were true.
   */
  it("re-scans every exempt pricing key, so an exemption that stops being true reds", () => {
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    const exemptKeys = Object.keys(load("en", "marketing")).filter(
      (k) =>
        k.startsWith("pricing.") &&
        !pinned.has(k) &&
        !FAQ_PASS_SCOPED.includes(k) &&
        !HALF_CLAIM_KEYS.includes(k),
    );
    expect(exemptKeys.length, "no exempt keys to re-scan — this rule examines nothing").toBeGreaterThan(50);

    const values: LocalisedValue[] = exemptKeys.flatMap((key) => across("marketing", key));
    const faults: string[] = [];
    for (const { locale, key, value } of values) {
      if (value.length === 0) continue;
      const claims = LOCALE_CLAIMS[locale];
      // The half-rate claim is false BARE on every surface, whoever writes it.
      if (claims.halfClaim.test(value) && !claims.atMostHalf.test(value)) {
        faults.push(`${locale} ${key}: quotes half the base rate with no "no more than" qualifier`);
      }
      // Pass permanence, attributed CLAUSE BY CLAUSE. A value-level subject test
      // was measured wrong on the first run: `pricing.meta.description` says
      // "Free forever for small clubs" (Community — TRUE) in the same paragraph
      // as "Upgrade a single event from $29", so the pass subject in one clause
      // vouched for a permanence hit in another, and all four locales redded on
      // honest copy. That is the 18-hits-17-true false-positive class, and a
      // guard that rejects true prose teaches its next editor to route around it.
      for (const clause of valueClauses(value)) {
        if (!claims.passSubject.test(clause)) continue;
        if (!claims.permanence.some((p) => p.test(clause))) continue;
        faults.push(
          `${locale} ${key}: exempt, but "${clause.slice(0, 60)}" now claims the pass has unbounded duration`,
        );
        break;
      }
    }
    expect(faults).toEqual([]);

    // …and the scan FIRES. Both reviewer probes, in every locale, against the
    // real exempt keys they were dropped into.
    const probe = (key: string, add: Record<DictionaryLocale, string>) =>
      DICTIONARY_LOCALES.flatMap((locale) => {
        const value = `${load(locale, "marketing")[key] ?? ""} ${add[locale]}`;
        const claims = LOCALE_CLAIMS[locale];
        const half = claims.halfClaim.test(value) && !claims.atMostHalf.test(value);
        const permanence = valueClauses(value).some(
          (clause) =>
            claims.passSubject.test(clause) && claims.permanence.some((p) => p.test(clause)),
        );
        return half || permanence ? [] : [`${locale} ${key}`];
      });
    expect(
      probe("pricing.community.note", {
        en: "Your Event Pass upgrade lasts forever.",
        es: "La mejora del pase dura para siempre.",
        fr: "L’amélioration du pass dure pour toujours.",
        nl: "De pass-upgrade blijft voor altijd van jou.",
      }),
      "a permanence falsehood in an exempt key must red, in every locale",
    ).toEqual([]);
    expect(
      probe("pricing.addons.label", {
        en: "Each extra organisation is half the base rate.",
        es: "Cada organización adicional cuesta a mitad de la tarifa base.",
        fr: "Chaque organisation supplémentaire coûte à moitié du tarif de base.",
        nl: "Elke extra organisatie kost voor de helft van het basistarief.",
      }),
      "a bare half-rate claim in an exempt key must red, in every locale",
    ).toEqual([]);
  });

  /**
   * #338 item 2: DISCOVERY BEYOND ONE FILENAME SHAPE.
   *
   * Everything above this point discovers a new claim-making key only if it
   * matches `pricing.faq.*.a` (the FAQ classification) or the `pricing.*`
   * prefix (`PRICING_KEY_DISPOSITION`). Neither reaches `ui.json`, and neither
   * reaches a `marketing.json` key outside the `pricing.` namespace — which is
   * everywhere else: 408 marketing keys and the whole of `ui.json` at the time
   * this was written. Demonstrated: adding `pricing.pass.note2` and
   * `upgrade.footnote` in all four locales, carrying "Your pass has no use-by
   * date and keeps working after the competition ends" (the exact reviewer
   * probe from #338), shipped 40/40 green before this test existed.
   *
   * The fix is not a hand-written classification of every key — that is a list,
   * and a list is the thing that must be remembered (the same lesson
   * `describedEntries` recorded for the Stripe seed). Instead this scans EVERY
   * value in BOTH dictionary files, in all four locales, with the SAME
   * clause-scoped vocabularies the exempt-key re-scan above already trusts, and
   * requires a hit to be on a PINNED key. A key nobody pinned that starts
   * making one of these claims is discovered the moment it does — no filename
   * shape required. Measured against the two dictionaries as they stand today:
   * zero hits, so this costs nothing and reds the day either falsehood lands.
   */
  /** The scan itself, factored out so the mutation proof below calls the exact
   *  code under test rather than a re-implementation of it. `extra` injects
   *  additional {file,key,value} entries per locale, standing in for a key that
   *  does not exist on disk yet — the only way to prove discovery reaches a key
   *  nobody has written without actually writing one into the dictionaries. */
  const scanWholeDictionary = (
    extra: Array<{ file: "marketing" | "ui"; key: string; value: Record<DictionaryLocale, string> }> = [],
  ): string[] => {
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    const faults: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const claims = LOCALE_CLAIMS[locale];
      for (const file of ["marketing", "ui"] as const) {
        const dict = load(locale, file);
        const entries = [
          ...Object.entries(dict),
          ...extra.filter((e) => e.file === file).map((e) => [e.key, e.value[locale]] as const),
        ];
        for (const [key, value] of entries) {
          if (typeof value !== "string" || pinned.has(key)) continue;
          if (claims.halfClaim.test(value) && !claims.atMostHalf.test(value)) {
            faults.push(`${locale} ${file}.${key}: quotes half the base rate with no "no more than" qualifier`);
          }
          for (const clause of valueClauses(value)) {
            if (!claims.passSubject.test(clause)) continue;
            if (!claims.permanence.some((p) => p.test(clause))) continue;
            faults.push(
              `${locale} ${file}.${key}: unpinned, but "${clause.slice(0, 60)}" claims the pass has unbounded duration`,
            );
            break;
          }
          if (/\+\s*\d[\d,]*\s*AI\s+credits?/i.test(value) && claims.recurring.some((p) => p.test(value))) {
            faults.push(`${locale} ${file}.${key}: unpinned, but sells an AI-credit grant as recurring`);
          }
        }
      }
    }
    return faults;
  };

  it("discovers a new claim-making key ANYWHERE in marketing or ui, not just pricing.faq.*.a", () => {
    expect(scanWholeDictionary()).toEqual([]);

    // …and the scan FIRES, on the issue's own reviewer probe, injected as BRAND
    // NEW keys in a shape none of the axes above recognise (not
    // `pricing.faq.*.a`, not even `pricing.*`, and one of the two is in
    // `ui.json`).
    const NEW_KEY_PROBE: Record<DictionaryLocale, string> = {
      en: "Your pass has no use-by date and keeps working after the competition ends.",
      es: "Tu pase no tiene fecha de caducidad y sigue funcionando después de que termine la competición.",
      fr: "Votre pass n'a pas de date limite et continue de fonctionner après la fin de la compétition.",
      nl: "Je pass heeft geen houdbaarheidsdatum en blijft werken nadat de competitie is afgelopen.",
    };
    expect(
      scanWholeDictionary([{ file: "marketing", key: "pricing.pass.note2", value: NEW_KEY_PROBE }]),
      "a brand-new pricing.* key must still be caught even though it is not pricing.faq.*.a",
    ).not.toEqual([]);
    expect(
      scanWholeDictionary([{ file: "ui", key: "upgrade.footnote", value: NEW_KEY_PROBE }]),
      "a brand-new ui.json key must be caught too — this is the axis PRICING_KEY_DISPOSITION cannot reach",
    ).not.toEqual([]);
  });

  /**
   * FIX ROUND 2 — no /pricing string may hardcode a currency.
   *
   * `pricing.addons.credits` said "$10" in all four locales (es "desde 10 $",
   * fr "à partir de 10 $", nl "vanaf $10") and rendered statically, while every
   * other price on the page is interpolated behind the CurrencySwitcher. The
   * seed's cheapest pack was eur 900 / gbp 800 / aud 1500 / inr 79900 when that
   * was written (AUD is gone and INR is 39900 since W2), so it was false in four
   * of the five currencies of the day.
   *
   * Scanned as a CLASS rather than as that one key: any pricing value carrying a
   * currency symbol or an ISO code is the same defect (#191), whoever writes it
   * next. Amounts belong in a placeholder.
   */
  it("hardcodes no currency anywhere in the pricing copy", () => {
    // A symbol, or an amount with an ISO code. Deliberately not a bare digit:
    // caps, percentages and credit counts are locale-agnostic DATA and belong in
    // the copy.
    const CURRENCY = /[$£€₹]|\b\d[\d.,]*\s?(?:USD|EUR|GBP|INR)\b|\b(?:USD|EUR|GBP|INR)\s?\d/i;
    // SEO METADATA IS THE ONE HONEST EXCEPTION, and it is pinned rather than
    // waved through (below). A description is a SINGLE cached document served to
    // every visitor and to crawlers — there is no per-visitor currency to switch
    // to, unlike the page body, which does switch. Every other pricing string is
    // rendered per request and has no excuse.
    const METADATA_EXEMPT = new Set(["pricing.meta.description", "pricing.meta.title"]);
    const faults: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const dict = load(locale, "marketing");
      for (const [key, value] of Object.entries(dict)) {
        if (!key.startsWith("pricing.") || METADATA_EXEMPT.has(key)) continue;
        if (typeof value !== "string" || !CURRENCY.test(value)) continue;
        faults.push(`${locale} ${key}: hardcodes a currency ("${value}") — interpolate it instead`);
      }
    }
    expect(faults).toEqual([]);
    // …and the rule fires on the exact string this round removed, so it is not
    // passing because the pattern can never match.
    expect(CURRENCY.test("AI credits from $10"), "en, pre-fix").toBe(true);
    expect(CURRENCY.test("Créditos de IA desde 10 $"), "es, pre-fix").toBe(true);
    expect(CURRENCY.test("Crédits IA à partir de 10 $"), "fr, pre-fix").toBe(true);
    expect(CURRENCY.test("AI-credits vanaf $10"), "nl, pre-fix").toBe(true);
    expect(CURRENCY.test("Up to 20 divisions, unlimited entrants"), "a true cap line").toBe(false);
    // The replacement must actually interpolate, in every locale — otherwise
    // deleting the amount would satisfy the absence rule above.
    for (const locale of DICTIONARY_LOCALES) {
      expect(load(locale, "marketing")["pricing.addons.credits"], `${locale}`).toContain("{price}");
    }
  });

  /**
   * …and the exemption is a PIN, not a hole.
   *
   * `pricing.meta.description` quotes $29 and $19/month in all four locales and
   * cannot be currency-switched (one cached document, served to crawlers). That
   * makes it the one place a hardcoded amount is defensible — and therefore the
   * one place a stale amount would never be noticed. So the figures are checked
   * against the seed the page itself renders from: move a price and the meta
   * description reds instead of quietly advertising last quarter's.
   */
  it("pins the metadata's hardcoded amounts to the seed that sets them", () => {
    const pass = passPrice("usd", "event_pass") / 100;
    const pro = proPrice("monthly", "usd") / 100;
    // Both figures are the SEED's, never typed here — W3 repriced them onto
    // charm points ($15 -> $11.99, $12 -> $14.99) and a typed pair would have
    // reported a legitimate reprice as a copy regression. What IS asserted is
    // that they are usable as a pin: two finite, positive and DISTINCT amounts,
    // so a description that quoted one number twice cannot satisfy both regexes
    // below, and a reader that returned NaN cannot make them vacuous.
    for (const [label, amount] of [["the M rung", pass], ["Pro monthly", pro]] as const) {
      expect(Number.isFinite(amount), `${label}: the seed price is not a number`).toBe(true);
      expect(amount, `${label}: the seed price is not positive`).toBeGreaterThan(0);
    }
    expect(pass, "the pass and the plan must be priced apart for this pin to bite").not.toBe(pro);
    for (const locale of DICTIONARY_LOCALES) {
      const description = load(locale, "marketing")["pricing.meta.description"]!;
      expect(description, `${locale}: the pass price`).toMatch(
        new RegExp(`\\$\\s?${pass}\\b|\\b${pass}\\s?\\$`),
      );
      expect(description, `${locale}: Pro's monthly price`).toMatch(
        new RegExp(`\\$\\s?${pro}\\b|\\b${pro}\\s?\\$`),
      );
    }
  });

  /**
   * THE PIN PROVES DELIBERATE; THE SCAN PROVES TRUE — and the matrix note needs
   * both.
   *
   * `pricing.matrix.orgs.max_owned.note` is now pinned AND in HALF_CLAIM_KEYS.
   * Reverting its copy reds the pin, which is what a probe measures — but a
   * future editor who re-words it AND re-approves it would sail past the pin.
   * The scan is what still catches them, and it has to be shown to do so
   * independently, or "pinned" quietly becomes the only guard on a claim that
   * was false in eight of ten plan x currency pairs.
   */
  it("catches a bare half-rate in the matrix note even when it has been re-approved", () => {
    const bare: Record<DictionaryLocale, string> = {
      en: "Each extra organisation costs half the base rate, and takes your plan's entry-fee rate",
      es: "Cada organización adicional cuesta a mitad de la tarifa base y adopta la comisión de tu plan",
      fr: "Chaque organisation supplémentaire coûte à moitié du tarif de base et adopte le taux de votre forfait",
      nl: "Elke extra organisatie kost voor de helft van het basistarief en krijgt het percentage van je abonnement",
    };
    const values: LocalisedValue[] = DICTIONARY_LOCALES.map((locale) => ({
      locale,
      key: "pricing.matrix.orgs.max_owned.note",
      value: bare[locale],
    }));
    const faults = localeHalfClaimFaults(values, "atMost").join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: a re-approved bare "half" must still red`).toContain(
        `${locale} pricing.matrix.orgs.max_owned.note`,
      );
    }
    // …and the shipped wording does not.
    expect(
      localeHalfClaimFaults(across("marketing", "pricing.matrix.orgs.max_owned.note"), "atMost"),
    ).toEqual([]);
  });

  /**
   * ── THE SAME FIVE CLAIMS, ON THE OTHER SURFACE (fix round 2) ───────────────
   *
   * `billing.plus.f1-f5` in ui.json is the IN-APP Pro Plus upgrade panel
   * (app/o/[orgSlug]/settings/billing/page.tsx renders them as a ✓ list beside
   * Pro), and `pricing-cards.ts` has always described the two as "the same five
   * selling points". They were not: this wave corrected `pricing.plus.f3` on
   * /pricing while `billing.plus.f3` went on saying "AI-assisted scheduling" in
   * all four locales — the identical falsehood, on the surface a paying
   * customer actually reads before upgrading, found by a probe written after
   * the round-2 rules were final.
   *
   * Asserting the MIRROR is the structural fix. Two hand-maintained copies of
   * one claim set will diverge again; one of them being a copy of the other
   * cannot.
   */
  /**
   * ── THE IN-APP COMPARISON PANEL, AND WHY A MIRROR IS THE WRONG GUARD ──────
   *
   * `billing.community.f1-f7` and `billing.pro.f1-f7` render in Settings →
   * Billing as a two-column Community-vs-Pro table, and the ✓/✗ is POSITIONAL:
   * page.tsx marks community f1-f4 with ✓ and f5-f7 with ✗. So the falsehood
   * available here is not wording drift — it is a row in the wrong column.
   *
   * Three were:
   *   f5 "Entry fees (Stripe payouts)" ✗  — `registration.paid` is TRUE on
   *      community, and the public card sells "Online registration & entry fees
   *      (8% fee)". The panel was telling a Community org it cannot take money.
   *   f6 "Branding & exports" ✗           — `branding` and `exports` are BOTH
   *      true on community (V310). Only `exports.branded` and
   *      `dashboard.branding` are denied.
   *   f4 "Free-event registration"        — the exact framing pricing-cards.ts
   *      documents the public card being corrected AWAY from.
   *
   * A literal mirror against FREE_FEATURES/PRO_FEATURES would be the wrong
   * instrument: these panels are a different shape (seven slots, denial rows, no
   * home stub) and forcing them to be string-equal would be false discipline.
   * POLARITY AGAINST THE MATRIX is the guard that actually decides the question
   * — and it is strictly stronger, because it also fails when the matrix moves.
   *
   * Note what the comparison READS: the ✓/✗ lives in the JSX, not in the
   * dictionary, so the polarity here is declared alongside the key and pinned to
   * page.tsx by the positional assertion below. A guard that read only the
   * strings could never have seen this class — the fifth normaliser-shaped hole
   * this wave has found.
   */
  const PANEL_CLAIMS: Array<{
    key: string;
    plan: string;
    /** ✓ or ✗ in page.tsx, and therefore what the row asserts. */
    polarity: "granted" | "denied";
    /** Every feature the row names. ALL must agree with the polarity. */
    features: string[];
  }> = [
    { key: "billing.community.f4", plan: "community", polarity: "granted", features: ["registration.enabled", "registration.paid"] },
    { key: "billing.community.f5", plan: "community", polarity: "denied", features: ["exports.branded", "dashboard.player_profiles"] },
    // TWO rows since V397 split the accent colour off badge removal, and this
    // sentence names both things ("Theme colour & badge removal"). Pinning only
    // one of them would let the other move under the ✗ unnoticed.
    { key: "billing.community.f6", plan: "community", polarity: "denied", features: ["dashboard.branding", "dashboard.theme"] },
    { key: "billing.community.f7", plan: "community", polarity: "denied", features: ["realtime"] },
    // W1 (entitlements v18): was `["scoring.ball_by_ball", "scoring.rally_by_rally"]`
    // until V390 deleted both rows. The bullet is now the third capability that
    // sentence used to name — `stats.player` — which is the one of the three
    // that is still Pro-only.
    { key: "billing.pro.f4", plan: "pro", polarity: "granted", features: ["stats.player"] },
    // WAS `dashboard.branding`. V396 (W2 T15) made badge removal
    // enterprise-only, so that row went FALSE on pro and this ✓ would have been
    // a live falsehood; V397 split the accent colour — which is what "Custom
    // branding" means here — onto `dashboard.theme`, which pro does grant.
    { key: "billing.pro.f5", plan: "pro", polarity: "granted", features: ["dashboard.theme"] },
    { key: "billing.pro.f6", plan: "pro", polarity: "granted", features: ["exports"] },
    { key: "billing.pro.f7", plan: "pro", polarity: "granted", features: ["realtime"] },
  ];

  /**
   * ── THE ROADMAP LABEL, IN EVERY LANGUAGE (fix round 3) ────────────────────
   *
   * `pricing.plus.soonLabel` was pinned in four locales and asserted by an
   * ENGLISH LITERAL. So flipping es/fr/nl to "Ya incluido" and re-approving them
   * shipped green — the same eight-undelivered-features-reclassified breach that
   * was closed for English only.
   *
   * An ALLOWLIST, not a denylist: the label must MATCH a recognised way of
   * saying "not yet" in its own language. Nobody has to have imagined the right
   * falsehood — "Included now" simply is not a futurity form. Built through
   * `claim()` so the accented forms actually match (`\b` is ASCII-only in JS,
   * which has voided two guards in this wave already).
   */
  const FUTURITY_FORMS: Record<DictionaryLocale, RegExp> = {
    en: claim(String.raw`\b(coming\s+soon|soon|planned|roadmap|in\s+development|next\s+up|on\s+the\s+way)\b`),
    es: claim(String.raw`\b(pr[óo]ximamente|pronto|en\s+desarrollo|previsto|hoja\s+de\s+ruta|en\s+camino)\b`),
    fr: claim(String.raw`\b(bient[ôo]t|prochainement|[àa]\s+venir|en\s+d[ée]veloppement|feuille\s+de\s+route)\b`),
    nl: claim(String.raw`\b(binnenkort|gepland|in\s+ontwikkeling|routekaart|komt\s+eraan|op\s+komst)\b`),
  };

  /**
   * ── A ROW THAT MEANS "NOT YET" MUST NOT READ AS "INCLUDED" ────────────────
   *
   * Two surfaces make a NEGATIVE claim purely by WHERE they sit: the eight
   * roadmap items under the "Coming soon" label, and the ✗ rows of the in-app
   * Community panel. Nothing in the string itself says "not yet", so a reword
   * inverts the meaning while every structural guard stays green — the label is
   * still futurity, the polarity table still points at the same denied feature.
   *
   * Both misses on the strict copy-addition axis were this shape:
   *   soon4  -> "Custom domain & white-label — included forever, on every plan"
   *   f6     -> "Theme colour & badge removal, included"
   *
   * Guarded two ways, because either alone is escapable:
   *  1. SHAPE — a roadmap item is a bare label. Every one of the 32 shipped
   *     strings is a noun phrase with no clause break, so a sentence smuggled in
   *     beside it reds without anyone having to predict its words.
   *  2. VOCABULARY — availability and permanence wording, per locale, for the
   *     rewordings that stay short.
   */
  const AVAILABILITY_CLAIM: Record<DictionaryLocale, RegExp> = {
    en: claim(String.raw`\b(included|includes|available\s+now|live\s+now|already|on\s+every\s+plan|every\s+plan)\b`),
    es: claim(String.raw`\b(incluid[oa]s?|disponible\s+ya|ya\s+disponible|ya\s+incluid|en\s+todos\s+los\s+planes)\b`),
    fr: claim(String.raw`\b(inclus(e|es)?|d[ée]j[àa]\s+disponible|disponible\s+d[ée]s\s+maintenant|sur\s+tous\s+les\s+forfaits)\b`),
    nl: claim(String.raw`\b(inbegrepen|nu\s+beschikbaar|al\s+beschikbaar|bij\s+elk\s+abonnement)\b`),
  };

  /** A bare label: no clause break, no sentence. */
  const CLAUSE_BREAK_IN_LABEL = /[—–:;.]|,\s/;

  /**
   * …AND THE INVERSE, because every presence rule in this file is paired.
   *
   * A ✓ row asserts the plan HAS the thing. Fresh probe D3 inverted one in
   * Spanish alone — `billing.community.f4` "Inscripción online SIN cuotas de
   * inscripción" — and nothing objected: the polarity table checks the FEATURE
   * against the matrix, not the WORDING, so a row can keep its tick while its
   * text says the opposite. Exactly the defect this round fixed in the other
   * direction, one locale over.
   */
  const DENIAL_WORDING: Record<DictionaryLocale, RegExp> = {
    en: claim(String.raw`\b(without|excluded|not\s+included|no\s+entry\s+fees|unavailable)\b`),
    es: claim(String.raw`\b(sin|excluid[oa]s?|no\s+incluid|no\s+disponible)\b`),
    fr: claim(String.raw`\b(sans|exclu(e|s|es)?|non\s+inclus|pas\s+de|indisponible)\b`),
    nl: claim(String.raw`\b(zonder|geen|uitgesloten|niet\s+inbegrepen|niet\s+beschikbaar)\b`),
  };

  /**
   * ── THE THREE NEW MAPS, UNDER THE MODULE-WIDE ANTI-VACUITY RULES ──────────
   *
   * `FUTURITY_FORMS`, `AVAILABILITY_CLAIM` and `DENIAL_WORDING` live in this
   * FILE, not in `@/lib/copy-truth`, so `collectPatterns` — which walks the
   * module's exports — cannot see them. That is the known container-shape hole,
   * and a control character planted in any of the three escapes every existing
   * anti-vacuity rule while the suite stays green (two guards shipped inert in
   * this wave exactly that way, and a third was a NON-EXPORTED pattern).
   *
   * So they are walked here, by the same two rules: no control character in the
   * source, and every pattern must fire on a known-positive fixture.
   */
  it("keeps its own claim maps live, not merely compiled", () => {
    const maps: Array<[string, Record<DictionaryLocale, RegExp>]> = [
      ["FUTURITY_FORMS", FUTURITY_FORMS],
      ["AVAILABILITY_CLAIM", AVAILABILITY_CLAIM],
      ["DENIAL_WORDING", DENIAL_WORDING],
    ];
    const positives: Record<string, Record<DictionaryLocale, string>> = {
      FUTURITY_FORMS: { en: "Coming soon", es: "Próximamente", fr: "Bientôt disponible", nl: "Binnenkort" },
      AVAILABILITY_CLAIM: { en: "included", es: "ya incluido", fr: "déjà disponible", nl: "inbegrepen" },
      DENIAL_WORDING: { en: "without", es: "sin", fr: "sans", nl: "zonder" },
    };
    const faults: string[] = [];
    let fired = 0;
    for (const [name, map] of maps) {
      const locales = Object.keys(map).sort();
      // A map that has quietly stopped covering a locale is the failure
      // `localeCoverageFaults` exists for, applied to this file's own maps.
      expect(locales, `${name} does not cover every locale`).toEqual([...DICTIONARY_LOCALES].sort());
      for (const locale of DICTIONARY_LOCALES) {
        const pattern = map[locale];
        if (/[\x00-\x1F\x7F]/.test(pattern.source)) {
          faults.push(`${name}.${locale}: control character in the pattern source`);
          continue;
        }
        if (!pattern.test(positives[name]![locale])) {
          faults.push(`${name}.${locale}: fires on nothing — inert`);
          continue;
        }
        fired += 1;
      }
    }
    expect(faults).toEqual([]);
    expect(fired, "no pattern fired").toBe(maps.length * DICTIONARY_LOCALES.length);
    // …and the check itself is not vacuous: a planted control character reds.
    expect(/[\x00-\x1F\x7F]/.test(new RegExp("coming\u0001soon").source)).toBe(true);
  });

  it("keeps every 'not yet' row reading as 'not yet', in all four locales", () => {
    // The 8-item `pricing.plus.soon*` roadmap this test used to scan alongside
    // the panel's ✗ rows is retired — R14 (entitlements v18 W3) deleted the
    // whole `pricing.plus.*` family, roadmap included, since nothing had
    // rendered it since W2. The in-app Community panel's ✗ rows are an
    // unrelated, still-live surface and stay scanned below.
    const rows: Array<{ key: string; file: "marketing" | "ui"; shape: boolean }> = [
      // The ✗ column of the in-app Community panel — same negative-by-position
      // claim, different surface.
      { key: "billing.community.f5", file: "ui", shape: false },
      { key: "billing.community.f6", file: "ui", shape: false },
      { key: "billing.community.f7", file: "ui", shape: false },
    ];
    // The ✓ column, judged by the inverse rule (fresh probe D3).
    const TICKED: Array<{ key: string; file: "marketing" | "ui" }> = [
      { key: "billing.community.f1", file: "ui" },
      { key: "billing.community.f2", file: "ui" },
      { key: "billing.community.f3", file: "ui" },
      { key: "billing.community.f4", file: "ui" },
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ key: `billing.pro.f${n}`, file: "ui" as const })),
    ];
    const faults: string[] = [];
    let scanned = 0;
    for (const row of rows) {
      for (const locale of DICTIONARY_LOCALES) {
        const value = load(locale, row.file)[row.key];
        if (typeof value !== "string" || value.length === 0) {
          faults.push(`${locale} ${row.key}: missing`);
          continue;
        }
        scanned += 1;
        if (AVAILABILITY_CLAIM[locale].test(value)) {
          faults.push(`${locale} ${row.key}: "${value}" reads as already included`);
        }
        if (LOCALE_CLAIMS[locale].permanence.some((p) => p.test(value))) {
          faults.push(`${locale} ${row.key}: "${value}" makes a permanence claim`);
        }
        if (row.shape && CLAUSE_BREAK_IN_LABEL.test(value)) {
          faults.push(`${locale} ${row.key}: "${value}" is a sentence, not a roadmap label`);
        }
      }
    }
    for (const row of TICKED) {
      for (const locale of DICTIONARY_LOCALES) {
        const value = load(locale, row.file)[row.key];
        if (typeof value !== "string" || value.length === 0) {
          faults.push(`${locale} ${row.key}: missing`);
          continue;
        }
        scanned += 1;
        if (DENIAL_WORDING[locale].test(value)) {
          faults.push(`${locale} ${row.key}: "${value}" is shown with a ✓ but reads as a denial`);
        }
      }
    }
    expect(faults).toEqual([]);
    expect(scanned, "nothing scanned").toBe(
      (rows.length + TICKED.length) * DICTIONARY_LOCALES.length,
    );

    // ── THE TWO PROBES THAT DEFEATED THE ROUND-2 GUARDS ────────────────────
    const reds = (locale: DictionaryLocale, value: string, shape: boolean) =>
      AVAILABILITY_CLAIM[locale].test(value) ||
      LOCALE_CLAIMS[locale].permanence.some((p) => p.test(value)) ||
      (shape && CLAUSE_BREAK_IN_LABEL.test(value));

    for (const [locale, value] of [
      ["en", "Custom domain & white-label — included forever, on every plan"],
      ["es", "Dominio propio y marca blanca: incluido para siempre en todos los planes"],
      ["fr", "Domaine personnalisé et marque blanche — inclus pour toujours, sur tous les forfaits"],
      ["nl", "Eigen domein & white-label — voor altijd inbegrepen, bij elk abonnement"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(reds(locale, value, true), `${locale}: roadmap item re-approved as shipped`).toBe(true);
    }
    // Fresh probe D3, the inverse: a ✓ row inverted in ONE locale.
    for (const [locale, value] of [
      ["en", "Online registration without entry fees"],
      ["es", "Inscripción online sin cuotas de inscripción"],
      ["fr", "Inscription en ligne sans frais d’inscription"],
      ["nl", "Online inschrijving zonder inschrijfgelden"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(DENIAL_WORDING[locale].test(value), `${locale}: ticked row reading as a denial`).toBe(
        true,
      );
    }
    for (const [locale, value] of [
      ["en", "Theme colour & badge removal, included"],
      ["es", "Color del tema y quitar la insignia, incluido"],
      ["fr", "Couleur du thème et retrait du badge, inclus"],
      ["nl", "Themakleur & badge verwijderen, inbegrepen"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(reds(locale, value, false), `${locale}: denial row reworded as included`).toBe(true);
    }
  });

  it("the in-app panel's ticks and crosses agree with plan_entitlements", async () => {
    const features = [...new Set(PANEL_CLAIMS.flatMap((c) => c.features))];
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "no rows for the panel's features").toBeGreaterThan(0);
    const grants: Record<string, Record<string, boolean | null>> = {};
    for (const r of rows) (grants[r.feature_key] ??= {})[r.plan_key] = r.bool_value;

    const faults: string[] = [];
    let checked = 0;
    for (const claim of PANEL_CLAIMS) {
      for (const feature of claim.features) {
        const value = grants[feature]?.[claim.plan];
        if (value === undefined) {
          faults.push(`${claim.key}: no ${claim.plan}/${feature} row — the row is pinned to nothing`);
          continue;
        }
        checked += 1;
        if (claim.polarity === "granted" && value !== true) {
          faults.push(`${claim.key}: shown with a ✓ but ${claim.plan} does not grant ${feature}`);
        }
        if (claim.polarity === "denied" && value === true) {
          faults.push(`${claim.key}: shown with a ✗ but ${claim.plan} DOES grant ${feature}`);
        }
      }
    }
    expect(faults).toEqual([]);
    expect(checked, "the polarity table resolved no rows").toBeGreaterThan(8);

    // The rule fires: the three rows this round corrected, as they shipped.
    const flipped: Record<string, Record<string, boolean | null>> = {
      ...grants,
      "dashboard.theme": { ...grants["dashboard.theme"], community: true },
    };
    const refaults: string[] = [];
    for (const claim of PANEL_CLAIMS.filter((c) => c.key === "billing.community.f6")) {
      for (const feature of claim.features) {
        if (claim.polarity === "denied" && flipped[feature]?.[claim.plan] === true) {
          refaults.push(`${claim.key}: shown with a ✗ but ${claim.plan} DOES grant ${feature}`);
        }
      }
    }
    expect(refaults, "a ✗ row whose feature is granted must red").not.toEqual([]);
  });

  /**
   * ── READ THE POLARITY FROM THE RENDERED STRUCTURE, NOT FROM A LINE ────────
   *
   * NINTH NORMALISER HOLE, and it failed in BOTH directions. Round 3 did
   * `page.split("\n").find(l => l.includes('"key"'))` then `line.includes("✗")`.
   * Wrap the `<li>` the way prettier does — `✗{" "}` and `{t(dict, key)}` on
   * separate lines — and the key's line carries no marker at all:
   *   a GRANTED row rendered with a ✗  -> green (Blocking 2's exact shape, back)
   *   an honest DENIED row, rewrapped  -> false RED
   *
   * So the parser now takes the whole `<li>…</li>` element the key sits in and
   * asks whether a denial marker appears anywhere inside it. Swapping ✗ for an
   * em dash was already caught; this closes the wrap.
   */
  const liFor = (key: string): string | null => {
    const at = BILLING_PAGE.indexOf(`"${key}"`);
    if (at === -1) return null;
    const open = BILLING_PAGE.lastIndexOf("<li", at);
    const close = BILLING_PAGE.indexOf("</li>", at);
    if (open === -1 || close === -1) return null;
    return BILLING_PAGE.slice(open, close);
  };
  /** Any way the page marks a row as NOT granted. */
  const DENIAL_MARKER = /[✗✘×✕]|\bline-through\b/;

  it("declares the polarity the billing page actually renders", () => {
    let read = 0;
    for (const claim of PANEL_CLAIMS) {
      const li = liFor(claim.key);
      expect(li, `${claim.key} is not rendered inside an <li> by the billing page`).toBeTruthy();
      read += 1;
      const rendered = DENIAL_MARKER.test(li!) ? "denied" : "granted";
      expect(rendered, `${claim.key}: page.tsx renders ${rendered}`).toBe(claim.polarity);
    }
    expect(read, "no rows read from the page").toBe(PANEL_CLAIMS.length);

    // The parser must survive a prettier rewrap — the defect above.
    const wrapped = [
      '<li className="text-slate-300">',
      '  ✗{" "}',
      '  {t(dict, "billing.community.f6")}',
      "</li>",
    ].join("\n");
    expect(DENIAL_MARKER.test(wrapped), "a rewrapped denial row must still read as denied").toBe(
      true,
    );
    const wrappedTick = ['<li>', '  ✓{" "}', '  {t(dict, "billing.pro.f5")}', "</li>"].join("\n");
    expect(DENIAL_MARKER.test(wrappedTick), "a rewrapped tick row must not read as denied").toBe(
      false,
    );
  });

  /**
   * …AND EVERY ROW THE PAGE RENDERS MUST BE IN THE TABLE.
   *
   * The completeness rule the cards have had since fix round 1, which I did not
   * give this table when I built it. Adding an eighth `<li>` claiming "Unlimited
   * AI schedule credits" scored zero faults.
   */
  it("classifies every panel row the page renders, or exempts it with a reason", () => {
    const declared = new Set(PANEL_CLAIMS.map((c) => c.key));
    /**
     * Rows exempted from the polarity table because they make a QUANTITY claim
     * rather than a grant/deny one. Every reason names the test that pins it,
     * and the reasons are now checked rather than merely written — see below.
     */
    const numeric: Record<string, string> = {
      "billing.community.f1": "a CAP, not a grant — pinned as a whole token against competitions.max_active by pricing-cards.test.ts 'billing.community.f1/f2 carry the live caps'",
      "billing.community.f2": "two caps — divisions.per_competition.max AND entrants.per_division.max, both pinned as whole tokens by the same test (the divisions digit was asserted by nothing until fix round 5)",
      "billing.community.f3": "a cap — pinned as a whole token against dashboard.public.max",
      "billing.pro.f2": "a cap — pinned as a whole token against entrants.per_division.max",
      "billing.pro.f3": "a rate — pinned against registration.fee_percent, plus the inverse that it must not quote the other plan's rate",
    };
    /**
     * …and the OTHER quantity shape: a row whose claim is the WORD "unlimited"
     * because the rows behind it are null. Split out of `numeric` because the
     * predicate is the exact inverse — this one must quote NO number — and
     * folding the two together is what made the exemption uncheckable.
     */
    const unlimited: Record<string, string> = {};
    /**
     * …and a THIRD shape, which W2 (entitlements v18) created and neither of
     * the two above can describe: a row covering TWO matrix rows where one is
     * null and the other is a number.
     *
     * `billing.pro.f1` was in `unlimited` — "BOTH competitions.max_active and
     * divisions.per_competition.max are null on pro, so the claim is the WORD
     * and not a number". V393 capped pro at 20 divisions. Moving it to
     * `numeric` would have dropped the requirement to say "unlimited" for the
     * row that still is; leaving it here would have kept forbidding the digit
     * the truth now requires. Either single-class answer WEAKENS a predicate,
     * which is the tell that the class was wrong rather than the copy.
     *
     * A row here must do BOTH: say unlimited, and quote a number.
     */
    const mixed: Record<string, string> = {
      "billing.pro.f1": "TWO rows, one of each shape: competitions.max_active is null on pro (the WORD) and divisions.per_competition.max is 20 since V393 (the NUMBER). Pinned by pricing-cards.test.ts 'billing.pro.f1 says unlimited for the unlimited row and quotes the cap for the capped one', which also forbids any digit that is not the live division cap — so a second figure cannot ride in beside it.",
    };
    const unclassified = PANEL_KEYS.filter(
      (k) => !declared.has(k) && !(k in numeric) && !(k in unlimited) && !(k in mixed),
    );
    expect(unclassified, "panel rows in neither PANEL_CLAIMS nor the numeric list").toEqual([]);
    // …and the inverse: a declared row the page no longer renders is a rule
    // pointing at nothing.
    expect(
      PANEL_CLAIMS.map((c) => c.key).filter((k) => !PANEL_KEYS.includes(k)),
      "declared rows the page does not render",
    ).toEqual([]);
    /**
     * ── THE EXEMPTION NEEDS A CHECKABLE PREDICATE (fix round 5) ────────────
     *
     * Its only validation was `why.length > 20`, which is a written judgement,
     * not a checked one — the same shape as the FAQ_EXEMPT hole (#338 item 1).
     * Measured: deleting the BOOLEAN row `billing.community.f7` from
     * PANEL_CLAIMS, exempting it here with a 52-character reason, and flipping
     * `realtime` true on community shipped a false denial, 112/112 green.
     *
     * So the class is checked: a row exempted as "numeric" must actually quote
     * a number, in English, in the shipped copy. `f7` ("Realtime scoreboard")
     * contains no digit, so it cannot be laundered through this list.
     *
     * And the set is FROZEN by count, so growing it is a deliberate edit rather
     * than a quiet one.
     */
    const en = load("en", "ui");
    for (const [key, why] of Object.entries(numeric)) {
      expect(PANEL_KEYS, `${key} is classified but not rendered`).toContain(key);
      expect(why.length, `${key} has no reason`).toBeGreaterThan(20);
      const value = en[key];
      expect(value, `${key}: exempted as numeric but absent from en/ui.json`).toBeTruthy();
      expect(
        /\d/.test(value!),
        `${key}: exempted as NUMERIC but its copy ("${value}") quotes no number — a boolean row cannot be laundered through this list`,
      ).toBe(true);
    }
    // …and the inverse predicate for the unlimited rows: they must quote NO
    // number, and must say so in their own language.
    const UNLIMITED_WORD: Record<DictionaryLocale, RegExp> = {
      en: /\bunlimited\b/i,
      es: /\bilimitad/i,
      fr: /\billimit/i,
      nl: /\bonbeperkt/i,
    };
    for (const [key, why] of Object.entries(unlimited)) {
      expect(PANEL_KEYS, `${key} is classified but not rendered`).toContain(key);
      expect(why.length, `${key} has no reason`).toBeGreaterThan(20);
      for (const locale of DICTIONARY_LOCALES) {
        const value = load(locale, "ui")[key];
        expect(value, `${locale} ${key}: exempted as unlimited but absent`).toBeTruthy();
        expect(
          UNLIMITED_WORD[locale].test(value!),
          `${locale} ${key}: exempted as UNLIMITED but does not say so`,
        ).toBe(true);
        expect(/\d/.test(value!), `${locale} ${key}: quotes a number while claiming unlimited`).toBe(
          false,
        );
      }
    }

    // The MIXED rows: both predicates, because they make both claims.
    for (const [key, why] of Object.entries(mixed)) {
      expect(PANEL_KEYS, `${key} is classified but not rendered`).toContain(key);
      expect(why.length, `${key} has no reason`).toBeGreaterThan(20);
      for (const locale of DICTIONARY_LOCALES) {
        const value = load(locale, "ui")[key];
        expect(value, `${locale} ${key}: exempted as mixed but absent`).toBeTruthy();
        expect(
          UNLIMITED_WORD[locale].test(value!),
          `${locale} ${key}: exempted as MIXED but never says unlimited`,
        ).toBe(true);
        expect(
          /\d/.test(value!),
          `${locale} ${key}: exempted as MIXED but quotes no number — the capped row is unstated`,
        ).toBe(true);
      }
    }

    // All three sets FROZEN by content, so growing any of them is a deliberate
    // edit rather than a quiet one — the laundering route the reviewer measured.
    expect(
      [...Object.keys(numeric), ...Object.keys(unlimited), ...Object.keys(mixed)].sort(),
      "the exemption sets are frozen — adding a row must be deliberate",
    ).toEqual([
      "billing.community.f1",
      "billing.community.f2",
      "billing.community.f3",
      "billing.pro.f1",
      "billing.pro.f2",
      "billing.pro.f3",
    ]);
    expect(PANEL_KEYS.length, "the page renders no panel rows — the regex broke").toBeGreaterThan(12);
  });


  // "the in-app Pro Plus panel says exactly what the /pricing card says"
  // retired here — R14 (entitlements v18 W3) deleted `pricing.plus.*`
  // outright. `ui.json`'s `billing.plus.*` (the "in-app panel" half of this
  // comparison) is a SECOND orphan from the same Pro Plus retirement — no
  // component in this tree renders it either (verified 2026-09-06) — left
  // untouched here as out of a `/pricing`-page redesign's scope; a future
  // task should prune it from `ui.json` in all four locales and drop the two
  // tests below that still reference it (`billing.plus.f1-f5`).

  it("the in-app panel claims only differentiators Pro Plus has, and carries no retired prose", () => {
    const values: LocalisedValue[] = DICTIONARY_LOCALES.map((locale) => ({
      locale,
      key: "billing.plus.f1-f5",
      value: [1, 2, 3, 4, 5].map((n) => load(locale, "ui")[`billing.plus.f${n}`] ?? "").join(". "),
    }));
    for (const { locale, value } of values) {
      expect(value.length, `${locale}: the in-app panel is empty`).toBeGreaterThan(40);
    }
    expect(retiredClaimFaults(values, RETIRED_CLAIMS)).toEqual([]);
  });

  it("never sells the Event Pass as permanent, in any language, and says what bounds it", () => {
    expect(localePassBoundFaults(PASS_BOUND_VALUES)).toEqual([]);
  });

  it("carries none of the retired prose, in any locale", () => {
    expect(retiredClaimFaults(PASS_BOUND_VALUES, RETIRED_CLAIMS)).toEqual([]);
    // The Pro Plus CARD (`PLUS_CARD_VALUES`, which carried the four
    // AI-scheduling literals in RETIRED_CLAIMS for a whole round after the FAQ
    // answer had dropped them) is retired along with `pricing.plus.*` itself
    // (R14, entitlements v18 W3) — nothing had rendered it since W2.
  });

  // …and the registry really does hold the card's own retired wording, in every
  // locale. Without this the test above is satisfied by a registry that never
  // covered these four strings — absence proving "not false", never "scanned".
  it("holds the card's retired AI-scheduling wording, in all four locales", () => {
    for (const [locale, retired] of [
      ["en", "AI-assisted scheduling"],
      ["es", "Programación asistida por IA"],
      ["fr", "Planification assistée par IA"],
      ["nl", "AI-ondersteunde planning"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        retiredClaimFaults([{ locale, key: "pricing.plus.f3", value: retired }], RETIRED_CLAIMS),
        `${locale}: ${retired}`,
      ).not.toEqual([]);
    }
  });

  it("quotes the one-time credit grant at its live size, not as a recurring one", () => {
    expect(localeCreditGrantFaults(PASS_CREDIT_VALUES, SELLABLE_GRANTS)).toEqual([]);
    // Anti-vacuity: the narrowed set is a real, non-empty subset. An empty one
    // makes `localeCreditGrantFaults` fault by design, but a set that had
    // silently grown back to every rung would make this line assert the old
    // claim under a new name.
    expect(SELLABLE_GRANTS.length).toBeGreaterThan(0);
    expect(SELLABLE_GRANTS.length).toBeLessThan(GRANTS.length);
  });

  // The extra-organisation rate. The CLAIM comes from four dictionaries and the
  // ARITHMETIC from the seed — different places, or the comparison proves
  // nothing. `riderClaimShape` decides which qualifier is honest today.
  it("quotes an extra-organisation rate the seed's tiers actually charge", () => {
    const shape = riderClaimShape(stripePlans.plans as unknown as PricedPlan[]);
    expect(shape, "usd/eur land on exact halves while gbp is 44.4% — only 'no more than half' is true").toBe(
      "atMost",
    );
    expect(localeHalfClaimFaults(HALF_CLAIM_VALUES, shape)).toEqual([]);
    expect(HALF_CLAIM_VALUES).toHaveLength(
      (HALF_CLAIM_KEYS.length + HALF_CLAIM_UI_KEYS.length) * DICTIONARY_LOCALES.length,
    );
  });

  /**
   * THE KEY AXIS FOR THIS CLAIM FAMILY — the half that the length assertion
   * above cannot give it.
   *
   * `HALF_CLAIM_VALUES` is DERIVED from the two key lists, so
   * `toHaveLength((KEYS + UI_KEYS) * LOCALES)` compares a number with itself:
   * delete a key and both sides shrink together. Its sibling `PASS_BOUND_KEYS`
   * has had a floor since fix round 1 (`toBeGreaterThanOrEqual(6)`); this one
   * never got one.
   *
   * Worse, a deleted key falls out of BOTH rules. The exempt-side re-scan skips
   * anything in `HALF_CLAIM_KEYS` *and* anything pinned in
   * `_approved-dictionary-copy.ts` — and every half-claim key is pinned, so
   * removing it from the axis does not hand it back to the exempt scan; it
   * hands it to nothing.
   *
   * Probe H1, measured at 216 passed / 0 failed: drop `pricing.faq.groups.a`
   * from the list, revert its value to the bare "costs half your plan's rate"
   * in all four locales, re-approve it in the inventory. That is the exact
   * claim that is false in 8 of 10 plan x currency pairs, and the key that had
   * already survived two rounds of this wave.
   *
   * TWO rules, because each covers what the other cannot:
   *  - a FLOOR on each list. Circular or not, a list cannot shrink to nothing.
   *  - DERIVATION: run each locale's own `halfClaim` vocabulary over every
   *    `pricing.*` key and every `ui` key, and require the set it finds to be
   *    exactly the set declared. This closes the DELETION direction — the value
   *    still says "half", so the derived set still contains the key even after
   *    the list forgets it. It is circular in the OTHER direction (#338): a
   *    reword out of the vocabulary disappears from both sides at once, which
   *    is what `localeHalfClaimFaults` and the inventory are for.
   *
   * Derived across ALL FOUR locales, not `en` alone: an es/fr/nl value that
   * gains a rate claim on a key nobody declared is exactly the failure the
   * four-locale rules exist for. Measured — all four locales agree on all six
   * keys today, so the union costs nothing and reds if one drifts.
   */
  it("declares every key that actually makes the half-rate claim, and cannot shrink", () => {
    // FLOORS. Not derived from the lists — restated deliberately, because a
    // floor computed from the thing it bounds is not a floor.
    // 3 -> 2 in the retired-plan copy sweep, and ONLY because the third key was
    // DELETED WITH ITS SUBJECT: `pricing.faq.proPlus.a` answered "What's in Pro
    // Plus?" about a plan V393 removed from `plans`. A floor is lowered for a
    // deleted subject, never for a reword — a value that stops matching
    // `halfClaim` while its key survives reds the derivation below instead, and
    // that is the direction this floor cannot see.
    expect(HALF_CLAIM_KEYS.length, "the marketing half of the axis has been emptied").toBeGreaterThanOrEqual(2);
    expect(HALF_CLAIM_UI_KEYS.length, "the ui half of the axis has been emptied").toBeGreaterThanOrEqual(3);

    // DERIVATION, per file, over every locale's own vocabulary.
    for (const [file, declared] of [
      ["marketing", HALF_CLAIM_KEYS],
      ["ui", HALF_CLAIM_UI_KEYS],
    ] as const) {
      const derived = new Set<string>();
      for (const locale of DICTIONARY_LOCALES) {
        const dict = load(locale, file);
        const halfClaim = LOCALE_CLAIMS[locale].halfClaim;
        for (const [key, value] of Object.entries(dict)) {
          if (halfClaim.test(value)) derived.add(key);
        }
      }
      expect(
        [...derived].sort(),
        `${file}: a key whose copy makes the half-rate claim is not on the axis (or one on the axis no longer makes it)`,
      ).toEqual([...declared].sort());
    }
  });

  /**
   * `config/tips.ts` IS NOT WHAT RENDERS, and this is the guard that makes that
   * safe (v17 gap wave 7, task 7).
   *
   * `components/ui/tip.tsx` reads `msg("tips.<id>.title")` and
   * `msg("tips.<id>.body")` from these four dictionaries; the TypeScript
   * literals in `config/tips.ts` are the source of truth the en dictionary
   * mirrors, and nothing else. So correcting a falsehood in `tips.ts` alone is
   * a change no customer ever sees — a whole class of cosmetic fix that reads
   * as done. It was live here: `tips.billing.extra-org.body` carried "half your
   * plan's rate" in all four dictionaries while three other surfaces of the
   * same claim were being corrected.
   *
   * Pinned as a MIRROR (assert one equals the other) rather than as two pinned
   * strings, because that is what makes editing either one insufficient on its
   * own. `extra-org-price-parity.test.ts` already lists both as "copy that says
   * half"; this is what stops them drifting apart.
   */
  //
  // EN-ONLY, DELIBERATELY. `config/tips.ts` holds one English string per tip, so
  // there is nothing for es/fr/nl to mirror — a Dutch value that equalled the
  // TypeScript literal would mean the Dutch page renders English. What binds the
  // other three locales is `i18n:check` (every key present in every locale) plus
  // the approved-copy gate for the values that make a pinned claim. A tip whose
  // claim is NOT pinned can still drift in translation; that is the gap, and it
  // is the same one every unpinned dictionary value has.
  const TIP_MIRROR_EXCEPTIONS: Record<string, string> = {
    // PRE-EXISTING, and NOT this task's to fix: both sides are stale against
    // `plan_entitlements.schedule.checkpoints.max` (community 2 since V319, pro
    // 5, pro_plus unlimited). `tips.ts` says "One save point is free, Pro
    // includes five, Pro Plus is unlimited" — wrong about Community. The
    // dictionary says "One save point is free; more need Pro" — wrong about
    // Community AND silent about Pro Plus. Fixing it is a four-locale copy
    // change in a different claim family; listing it keeps it visible.
    "tips.schedule.save-points.body":
      "#303 — both sides stale vs schedule.checkpoints.max (community 2 since V319, pro 5, pro_plus unlimited). tips.ts says 'One save point is free' (V290's 1, not V319's 2); the dictionary says 'more need Pro' and is silent on Pro Plus. A four-locale copy change in a different claim family, tracked with this wave's other out-of-scope copy defects.",
  };

  it("keeps config/tips.ts and the en dictionary identical — a tips.ts-only fix is cosmetic", () => {
    const en = load("en", "ui");
    const drift: string[] = [];
    let compared = 0;
    for (const [id, tip] of Object.entries(TIPS)) {
      for (const field of ["title", "body"] as const) {
        const key = `tips.${id}.${field}`;
        if (key in TIP_MIRROR_EXCEPTIONS) continue;
        const onDisk = en[key];
        if (onDisk === undefined) {
          drift.push(`${key}: in config/tips.ts but ABSENT from en/ui.json`);
          continue;
        }
        compared += 1;
        if (onDisk !== tip[field]) {
          drift.push(
            [
              `${key}: config/tips.ts and en/ui.json disagree.`,
              `  tips.ts:    ${tip[field]}`,
              `  ui.json:    ${onDisk}`,
              "  ui.json is what renders (components/ui/tip.tsx). Fix BOTH, and all four locales.",
            ].join("\n"),
          );
        }
      }
    }
    expect(drift).toEqual([]);
    // ANTI-VACUITY: an exception list that grew to cover everything, or a TIPS
    // export that got renamed, would leave this comparing nothing.
    expect(compared, "the mirror compared nothing").toBeGreaterThan(40);
    for (const key of Object.keys(TIP_MIRROR_EXCEPTIONS)) {
      expect(key in en, `${key} is excepted but does not exist`).toBe(true);
    }
  });

  // …and the mirror really does fire. Absence of drift proves "identical" only
  // if a difference would have been reported.
  it("reports a tip whose dictionary value drifts from config/tips.ts", () => {
    const key = "tips.billing.extra-org.body";
    expect(load("en", "ui")[key], "the tip moved — re-point this guard").toBe(
      TIPS["billing.extra-org"].body,
    );
    expect(TIPS["billing.extra-org"].body).not.toBe(
      "Each organisation after the first is half your plan's rate.",
    );
    // The half-rate rule is what would have caught the drifted value, had it
    // ever been pointed at this key. It is now, and it fires on the old wording.
    expect(
      localeHalfClaimFaults(
        [{ locale: "en", key, value: "Each organisation after the first is half your plan's rate." }],
        "atMost",
      ),
    ).not.toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("the four-locale dictionaries match plan_entitlements", () => {
  const grantsFor = async (features: string[]): Promise<FeatureGrants> => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key = any(${features})`;
    expect(rows.length, "plan_entitlements returned no rows for the differentiator features").toBeGreaterThan(0);
    const out: FeatureGrants = {};
    for (const row of rows) {
      (out[row.feature_key] ??= {})[row.plan_key] = row.bool_value === true;
    }
    return out;
  };

  const monthlyCredits = async (): Promise<Record<string, number | null>> => {
    const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
      where feature_key = 'ai.credits.monthly'`;
    return Object.fromEntries(rows.map((r) => [r.plan_key, r.int_value]));
  };

  // Five tests lived here, all about the Pro Plus card and the FAQ answer under
  // it, and all five were DELETED in W2 (entitlements v18) — the plan is gone
  // from `plans` and `/pricing` renders neither surface. Two of them are worth
  // naming because their SUBJECT survives elsewhere:
  //
  //  • "scheduling.ai is granted on every plan, so it differentiates nothing"
  //    moved to pricing-cards.test.ts, where it now asserts the whole plan set
  //    (enterprise in, pro_plus out) rather than five hardcoded keys.
  //  • "the FAQ quotes each plan's live organisation cap" pinned `pro` and
  //    `pro_plus` org caps in four locales. `pro` is still 5 and still quoted;
  //    enterprise's cap is NULL, so the sentence a re-approval writes has to say
  //    so in WORDS. help-copy-truth.test.ts already enforces exactly that shape
  //    on the add-ons article, and W3 owns the /pricing FAQ's own rewrite.
  //
  // The credit-leadership guard itself survives and is exercised further down
  // with the live ordering (community 5 / pro 25 / enterprise 500) and with the
  // leader passed explicitly.

  // ── W2: the four caps in the Event Pass FAQ answer ────────────────────────
  //
  // `pricing.faq.eventPass.a` describes BOTH rungs in one sentence and quotes
  // four numbers. None of them was bound to anything, and it showed: V393 gave
  // the L rung a real 512-entrant cap where `int_value` had been null, and the
  // answer went on promising "no entrant limit at all" — in all four locales,
  // for a whole wave.
  //
  // It survived two guards that look like they cover it. `APPROVED_DICTIONARY_COPY`
  // pins the WORDING, which is a different question from whether the wording is
  // true. `capClaimFaults` is the rule for exactly this claim family and even
  // carries the V393 case in its own comment — but it is only ever called with
  // the rung DESCRIPTIONS (plan-copy-truth.test.ts), and nothing pointed it at
  // this key. A guard's scope is its call site, not its name.
  //
  // Two halves, deliberately, because either alone is satisfied by the bug: the
  // live numbers must be PRESENT with their nouns, and no locale may describe a
  // capped rung as uncapped. The vocabulary is per locale and built through
  // `claim()` — `\b` and `\w` are ASCII-only, so a French pattern written with
  // plain literals reports clean on "sans aucune limite".
  const RUNG_CAP_COPY: Record<
    DictionaryLocale,
    { entrants: string; divisions: string; uncapped: RegExp }
  > = {
    en: {
      entrants: "entrants",
      divisions: "divisions",
      uncapped: claim(String.raw`\b(unlimited|no\s+\w*\s*limit)\b`),
    },
    es: {
      entrants: "participantes",
      divisions: "divisiones",
      uncapped: claim(String.raw`\b(ilimitad\w*|sin\s+(ning\w+\s+)?l\w+mite)\b`),
    },
    fr: {
      entrants: "participants",
      divisions: "divisions",
      uncapped: claim(String.raw`\b(illimit\w*|sans\s+(aucune\s+)?limite)\b`),
    },
    nl: {
      entrants: "deelnemers",
      divisions: "divisies",
      uncapped: claim(String.raw`\b(onbeperkt\w*|geen\s+\w*limiet)\b`),
    },
  };

  /** Both rungs' live caps, from the table the resolver enforces. */
  const rungCaps = async (): Promise<
    Record<string, { entrants: number | null; divisions: number | null }>
  > => {
    const rows = await sql<{ plan_key: string; feature_key: string; int_value: number | null }[]>`
      select plan_key, feature_key, int_value from plan_entitlements
      where plan_key = any(${["event_pass", "event_pass_l"]})
        and feature_key = any(${["entrants.per_division.max", "divisions.per_competition.max"]})`;
    const out: Record<string, { entrants: number | null; divisions: number | null }> = {};
    for (const row of rows) {
      const cell = (out[row.plan_key] ??= { entrants: null, divisions: null });
      if (row.feature_key === "entrants.per_division.max") cell.entrants = row.int_value;
      else cell.divisions = row.int_value;
    }
    return out;
  };

  it("the Event Pass answer quotes the live caps of every rung on sale, and only those", async () => {
    const caps = await rungCaps();
    // The premise, read from the seed rather than asserted from memory: EVERY
    // rung is finite on both axes — hidden ones included, because the seed is
    // still a live thing that a later migration can move. If a rung is ever
    // uncapped again the sentence has to say so in words, and this test must be
    // rewritten rather than relaxed: an unlimited cap quoted as a number is the
    // same defect pointing the other way.
    for (const plan of PASS_KEYS) {
      expect(typeof caps[plan]?.entrants, `${plan} entrant cap`).toBe("number");
      expect(typeof caps[plan]?.divisions, `${plan} division cap`).toBe("number");
    }
    expect(caps.event_pass!.entrants).not.toBe(caps.event_pass_l!.entrants);

    for (const locale of DICTIONARY_LOCALES) {
      const answer = load(locale, "marketing")["pricing.faq.eventPass.a"];
      expect(answer, `${locale} has no pricing.faq.eventPass.a`).toBeDefined();
      const words = RUNG_CAP_COPY[locale];
      // The POSITIVE half: every rung on sale states both of its live caps.
      for (const plan of SELLABLE_PASS_KEYS) {
        for (const [n, noun] of [
          [caps[plan]!.entrants, words.entrants],
          [caps[plan]!.divisions, words.divisions],
        ] as const) {
          expect(
            answer!,
            `${locale} drops ${plan}'s live cap of ${n} ${noun}`,
          ).toMatch(claim(String.raw`\b` + n + String.raw`\s+` + noun + String.raw`\b`));
        }
      }
      // …and the NEGATIVE half, which is what stops narrowing the loop above
      // from being a way to stop looking. A withdrawn rung's caps left in this
      // answer would advertise, in figures, a size the checkout will not sell —
      // and they are the very figures that make the rung look worth buying.
      for (const plan of HIDDEN_PASS_KEYS) {
        for (const [n, noun] of [
          [caps[plan]!.entrants, words.entrants],
          [caps[plan]!.divisions, words.divisions],
        ] as const) {
          expect(
            answer!,
            `${locale} still quotes ${plan}'s ${n} ${noun}, and ${plan} is off sale`,
          ).not.toMatch(claim(String.raw`\b` + n + String.raw`\s+` + noun + String.raw`\b`));
        }
      }
      expect(
        answer!,
        `${locale} describes a capped rung as uncapped (${copyTruth.describeClaim(words.uncapped)})`,
      ).not.toMatch(words.uncapped);
    }
    // Anti-vacuity for the negative loop: something is genuinely hidden, and
    // the two rungs' caps really do differ, so "does not quote L's numbers" is
    // not accidentally satisfied by them being M's numbers.
    expect(HIDDEN_PASS_KEYS.length).toBeGreaterThan(0);
    expect(caps.event_pass!.divisions).not.toBe(caps.event_pass_l!.divisions);
  });

  // ── #382 review, finding 1: the Pro card on the UPGRADE page ──────────────
  //
  // `upgrade.proCard.body` is rendered to a community org with NO pass — the
  // organiser who has just hit the `scheduling.multi_division` gate and landed
  // on `?feature=scheduling.multi_division`, with the $29 Event Pass on the
  // same screen. Its "the pass never covers …" list named the schedule board
  // and officials, both of which V353 put on the pass. The card argued against
  // the purchase directly above it.
  //
  // Judged against the matrix, not against a banned phrase: if a migration ever
  // took `scheduling.board` off the pass, the old sentence would become true and
  // this must fall silent.
  it("the Pro card never sells the pass short, in all four locales (#382)", async () => {
    const grants = await grantsFor([
      "scheduling.board",
      "scheduling.multi_division",
      "officials.marks",
      "stats.player",
      "api.access",
    ]);
    // The premise, read from the seed rather than asserted from memory.
    expect(grants["scheduling.board"]!.event_pass, "V353 put the board on the pass").toBe(true);
    expect(grants["scheduling.multi_division"]!.event_pass).toBe(true);
    expect(grants["officials.marks"]!.event_pass).toBe(true);
    // `stats.player` LEFT this card in W2. V393 granted it to both pass rungs,
    // so "player stats … the pass never covers" became the same falsehood V353
    // created with the schedule board — a Pro card arguing against the $29
    // purchase sitting directly above it. `api.access` is the one claim left,
    // and it is still true: no `event_pass` row, so the overlay falls through
    // to community's false.
    expect(grants["stats.player"]?.event_pass ?? false, "V393 put player stats on the pass").toBe(true);
    expect(grants["api.access"]?.event_pass ?? false, "no event_pass row").toBe(false);

    expect(localePassUncoveredFaults(PRO_CARD_BODY, grants)).toEqual([]);
  });

  it("…and the pre-V353 card reds in every locale, so that is not silence (#382)", async () => {
    const grants = await grantsFor([
      "scheduling.board",
      "officials.marks",
      "stats.player",
      "api.access",
    ]);
    // The shipped strings, verbatim, before this fix. Given per locale so a
    // guard that only speaks English cannot pass this.
    const preFix: LocalisedValue[] = (
      [
        [
          "en",
          "Pro raises every competition in Riverside, not just this one — and adds the schedule board, player stats, officials and API access the pass never covers.",
        ],
        [
          "es",
          "Pro mejora todas las competiciones de Riverside, no solo esta — y añade el tablero de planificación, las estadísticas de jugadores, los oficiales y el acceso a la API que el pase nunca cubre.",
        ],
        [
          "fr",
          "Pro améliore toutes les compétitions de Riverside, pas seulement celle-ci — et ajoute le tableau de planification, les statistiques des joueurs, les officiels et l’accès API que le pass ne couvre jamais.",
        ],
        [
          "nl",
          "Pro upgradet elke competitie in Riverside, niet alleen deze — en voegt het planningsbord, spelersstatistieken, officials en API-toegang toe die de pass nooit dekt.",
        ],
      ] as Array<[DictionaryLocale, string]>
    ).map(([locale, value]) => ({ locale, key: "pre-fix", value }));

    const faults = localePassUncoveredFaults(preFix, grants).join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: the board claim must red`).toContain(
        `${locale} pre-fix: sells scheduling.board as something the Event Pass never covers`,
      );
      expect(faults, `${locale}: the officials claim must red`).toContain(
        `${locale} pre-fix: sells officials.marks as something the Event Pass never covers`,
      );
    }

    // ANTI-VACUITY: a card that names nothing at all is a fault of its own, so
    // "fixing" this by deleting the list cannot pass.
    for (const locale of DICTIONARY_LOCALES) {
      expect(
        localePassUncoveredFaults([{ locale, key: "empty", value: "Pro is better." }], grants),
        locale,
      ).toEqual([
        `${locale} empty: names no recognised capability — the ${locale} vocabulary has gone stale and this guard examined nothing`,
      ]);
    }

    // …and it must fall silent the day the matrix moves the other way: with the
    // board off the pass, the pre-fix sentence is TRUE about the board again.
    const lifted = {
      ...grants,
      "scheduling.board": { ...grants["scheduling.board"]!, event_pass: false },
    };
    expect(localePassUncoveredFaults(preFix, lifted).join(" | ")).not.toContain(
      "sells scheduling.board",
    );
  });

  // ── W3 fix round 1: `pricing.pass.f3` no longer illustrates the paid
  // `formats.advanced` row with an example ("double elim") that
  // `formats.double_elim` already grants to community ─────────────────────
  //
  // The INVERSE of the block above: `localePassUncoveredFaults` catches a
  // card selling something the PASS never covers when it does;
  // `localePaidOverclaimFaults` catches a card selling something as a PAID
  // differentiator when COMMUNITY already has it. See its header comment in
  // `@/lib/copy-truth` for the full reasoning.
  it("pricing.pass.f3 no longer oversells formats.double_elim, in all four locales", async () => {
    const grants = await grantsFor(["formats.double_elim", "formats.advanced"]);
    // The premise, read from the seed rather than asserted from memory.
    expect(grants["formats.double_elim"]!.community, "V393+ growth cell").toBe(true);
    expect(grants["formats.advanced"]!.community, "the real paid lift").toBe(false);

    expect(localePaidOverclaimFaults(across("marketing", "pricing.pass.f3"), grants)).toEqual([]);
  });

  it("…and the pre-fix 'double elim' wording reds in every locale, so that is not silence", async () => {
    const grants = await grantsFor(["formats.double_elim", "formats.advanced"]);
    // The shipped strings, verbatim, before this fix (W3 fix round 1).
    const preFix: LocalisedValue[] = (
      [
        ["en", "Advanced formats — double elim, ladders"],
        ["es", "Formatos avanzados: doble eliminación y escaleras"],
        ["fr", "Formats avancés — double élimination, échelles"],
        ["nl", "Geavanceerde formats — dubbele eliminatie, ladders"],
      ] as Array<[DictionaryLocale, string]>
    ).map(([locale, value]) => ({ locale, key: "pricing.pass.f3", value }));

    const faults = localePaidOverclaimFaults(preFix, grants).join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: the double-elim claim must red`).toContain(
        `${locale} pricing.pass.f3: sells formats.double_elim as a paid differentiator, but community already grants it`,
      );
      // DISCRIMINATING, not blanket: the very same string also names
      // "ladders"/"escaleras"/"échelles" (formats.advanced), which community
      // genuinely does NOT grant — that half must stay silent, or this guard
      // would just be a banned-word list wearing a matrix lookup as a costume.
      expect(faults, `${locale}: the ladders half must NOT red`).not.toContain(
        `${locale} pricing.pass.f3: sells formats.advanced`,
      );
    }

    // ANTI-VACUITY, both halves (see the header comment on
    // `localePaidOverclaimFaults` in copy-truth.ts): the vocabulary is
    // non-empty, and — proved here, not asserted — it just matched a real,
    // previously shipped string in every locale, not a fixture invented only
    // for this test.
    expect(copyTruth.PAID_OVERCLAIM_VOCAB.length).toBeGreaterThan(0);

    // …and it must fall silent the day the matrix moves the other way: if
    // formats.double_elim were ever gated off community again, the pre-fix
    // sentence would be true about it again.
    const lifted = {
      ...grants,
      "formats.double_elim": { ...grants["formats.double_elim"]!, community: false },
    };
    expect(localePaidOverclaimFaults(preFix, lifted).join(" | ")).not.toContain(
      "sells formats.double_elim",
    );
  });

  // ── W3 fix round 2, item 4: `upgrade.limit.formats` (ui.json) carried the
  // IDENTICAL "double elimination" false differentiator, on the upgrade
  // page's own comparison row — same defect, different surface, found while
  // fixing pricing.pass.f3 and owed to this round. Same guard, extended to
  // ui.json: `localePaidOverclaimFaults` takes any `LocalisedValue[]`, so
  // this is the same function reading a second file's key, not a second
  // mechanism.
  it("upgrade.limit.formats no longer oversells formats.double_elim, in all four locales", async () => {
    const grants = await grantsFor(["formats.double_elim", "formats.advanced"]);
    expect(localePaidOverclaimFaults(across("ui", "upgrade.limit.formats"), grants)).toEqual([]);
  });

  it("…and the pre-fix 'double elimination' wording on upgrade.limit.formats reds in every locale", async () => {
    const grants = await grantsFor(["formats.double_elim", "formats.advanced"]);
    // The shipped strings, verbatim, before this fix (W3 fix round 2).
    const preFix: LocalisedValue[] = (
      [
        ["en", "Advanced formats — double elimination, ladders, americano"],
        ["es", "Formatos avanzados — doble eliminación, escaleras, americano"],
        ["fr", "Formats avancés — double élimination, échelles, americano"],
        ["nl", "Geavanceerde formats — dubbele eliminatie, ladders, americano"],
      ] as Array<[DictionaryLocale, string]>
    ).map(([locale, value]) => ({ locale, key: "upgrade.limit.formats", value }));

    const faults = localePaidOverclaimFaults(preFix, grants).join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: the double-elim claim must red`).toContain(
        `${locale} upgrade.limit.formats: sells formats.double_elim as a paid differentiator, but community already grants it`,
      );
      // DISCRIMINATING: the same string also names "americano" and
      // "ladders"/"escaleras"/"échelles" (formats.advanced), which community
      // genuinely does NOT grant — that half must stay silent.
      expect(faults, `${locale}: the americano/ladders half must NOT red`).not.toContain(
        `${locale} upgrade.limit.formats: sells formats.advanced`,
      );
    }
  });

  // ── W3-B: the beyond-plan card. Shown ONLY to an org already on a paid
  // plan, when a gate fired because of that plan's own ceiling — the state
  // that used to render "See plans & upgrade →" pointing at a picker holding
  // the plan the reader was already paying for.
  //
  // Its own rule rather than a row in `localePaidOverclaimFaults`: that guard
  // asks whether a sentence oversells a key community already grants, which
  // is a question about the MATRIX. This one is about the READER — every plan
  // attribution is wrong here regardless of what any row says, because the
  // reader holds the top self-serve tier.
  it("the beyond-plan sentence names no plan, in all four locales", () => {
    expect(beyondPlanCopyFaults(across("ui", "upgrade.beyondPlan.body"))).toEqual([]);
  });

  it("…and a plan name in ANY ONE locale reds, with the other three silent", () => {
    const live = across("ui", "upgrade.beyondPlan.body");
    // The exact failure this exists for, injected into ONE locale: a
    // locale-blind sweep, or an English-grammar rule, passes this.
    const salted = live.map((v) =>
      v.locale === "fr" ? { ...v, value: `${v.value} Passez à Pro.` } : v,
    );
    const faults = beyondPlanCopyFaults(salted);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("fr upgrade.beyondPlan.body");
    expect(faults[0]).toContain('names "Pro"');
  });

  it("…and reports a call that examines nothing rather than passing", () => {
    // Both anti-vacuity halves. An empty call is the shape this file has been
    // burned by twice; a short call is the shape a locale-blind sweep takes.
    expect(beyondPlanCopyFaults([])).toEqual([
      "no beyond-plan copy supplied — this rule would examine nothing",
    ]);
    const enOnly = across("ui", "upgrade.beyondPlan.body").filter((v) => v.locale === "en");
    const faults = beyondPlanCopyFaults(enOnly).join(" | ");
    for (const locale of DICTIONARY_LOCALES.filter((l) => l !== "en")) {
      expect(faults).toContain(`${locale}: beyond-plan copy was not supplied`);
    }
    // …and an EMPTY string is not the same as a missing one: it is supplied,
    // it passes the coverage half, and it renders a card with a blank body.
    expect(
      beyondPlanCopyFaults(
        DICTIONARY_LOCALES.map((locale) => ({
          locale,
          key: "upgrade.beyondPlan.body",
          value: "   ",
        })),
      ),
    ).toHaveLength(DICTIONARY_LOCALES.length);
  });

  // ── W3-A (2026-09-06, V399): `pricing.pro.f4` named "player stats" as a Pro
  // differentiator until `stats.player` (the per-division RECORD) went free
  // on every plan in the same migration — the SAME falsehood class
  // `formats.double_elim` demonstrated one wave earlier, this time on a
  // bullet already rewritten once (W1) for an unrelated reason. Same guard,
  // a THIRD `PAID_OVERCLAIM_VOCAB` entry (`lib/copy-truth.ts`) rather than a
  // third mechanism.
  it("pricing.pro.f4 no longer oversells stats.player, in all four locales", async () => {
    const grants = await grantsFor(["stats.player", "stats.player.career"]);
    // The premise, read from the seed rather than asserted from memory.
    expect(grants["stats.player"]!.community, "W3-A: the record is free everywhere").toBe(true);
    expect(grants["stats.player.career"]!.community, "the rollup is the real paid lift").toBe(false);

    expect(localePaidOverclaimFaults(across("marketing", "pricing.pro.f4"), grants)).toEqual([]);
  });

  it("…and the pre-fix 'player stats' wording on pricing.pro.f4 reds in every locale, so that is not silence", async () => {
    const grants = await grantsFor(["stats.player", "stats.player.career"]);
    // The shipped strings, verbatim, before this fix (W3-A).
    const preFix: LocalisedValue[] = (
      [
        ["en", "Player stats & scorecards"],
        ["es", "Estadísticas de jugadores y planillas"],
        ["fr", "Statistiques des joueurs et feuilles de match"],
        ["nl", "Spelersstatistieken & scorekaarten"],
      ] as Array<[DictionaryLocale, string]>
    ).map(([locale, value]) => ({ locale, key: "pricing.pro.f4", value }));

    const faults = localePaidOverclaimFaults(preFix, grants).join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: the player-stats claim must red`).toContain(
        `${locale} pricing.pro.f4: sells stats.player as a paid differentiator, but community already grants it`,
      );
    }

    // ANTI-VACUITY (see the header comment on `localePaidOverclaimFaults` in
    // copy-truth.ts): the vocabulary just matched a real, previously shipped
    // string in every locale, not a fixture invented only for this test.
    expect(copyTruth.PAID_OVERCLAIM_VOCAB.length).toBeGreaterThan(0);

    // …and it must fall silent the day the matrix moves the other way: if
    // `stats.player` were ever gated off community again, the pre-fix
    // sentence would be true about it again.
    const lifted = {
      ...grants,
      "stats.player": { ...grants["stats.player"]!, community: false },
    };
    expect(localePaidOverclaimFaults(preFix, lifted).join(" | ")).not.toContain(
      "sells stats.player",
    );
  });

  // ── The SAME defect on a second surface, found while fixing pricing.pro.f4
  // and owed to the same round (same shape as `upgrade.limit.formats` being
  // owed alongside `pricing.pass.f3` in W3 fix round 2): the in-app Event
  // Pass tip (`tips.billing.event-pass.body`, rendered on the upgrade page,
  // `app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx`) told a buyer the pass
  // "adds ... player stats", which stopped being true the moment
  // `stats.player` went free — the pass still adds the career rollup, not
  // the per-division record.
  it("tips.billing.event-pass.body no longer oversells stats.player, in all four locales", async () => {
    const grants = await grantsFor(["stats.player", "stats.player.career"]);
    expect(localePaidOverclaimFaults(across("ui", "tips.billing.event-pass.body"), grants)).toEqual([]);
  });

  it("…and the pre-fix 'player stats' wording on the Event Pass tip reds in every locale", async () => {
    const grants = await grantsFor(["stats.player", "stats.player.career"]);
    // The shipped strings, verbatim, before this fix (W3-A).
    const preFix: LocalisedValue[] = (
      [
        [
          "en",
          "For this competition only: the pass gives it 128 entrants per division and up to 10 divisions. It adds branded exports, public player cards, player stats, auto officials assignment, discipline tracking, embeds, sponsor packages, the realtime scoreboard, a one-time AI credit top-up and a 4% platform fee instead of 5%. It is not Pro — your brand colour on public pages, API access and your organisation's own limits all stay Pro. A passed competition stops counting against your active-competition limit; the pass doesn't carry to next season's edition.",
        ],
        [
          "es",
          "Solo para esta competición: el pase le da 128 participantes por división y hasta 10 divisiones. Añade exportaciones con tu marca, fichas públicas de jugador, estadísticas de jugadores, asignación automática de árbitros, seguimiento disciplinario, embeds, paquetes de patrocinio, el marcador en tiempo real, una recarga única de créditos de IA y una comisión de plataforma del 4 % en lugar del 5 %. No es Pro — el color de marca en las páginas públicas, el acceso a la API y los límites de tu propia organización siguen siendo de Pro. Una competición con pase deja de contar para tu límite de competiciones activas; el pase no se transfiere a la edición de la próxima temporada.",
        ],
        [
          "fr",
          "Pour cette compétition uniquement : le pass lui donne 128 participants par division et jusqu'à 10 divisions. Il ajoute les exports personnalisés, les fiches joueurs publiques, les statistiques des joueurs, l'attribution automatique des officiels, le suivi disciplinaire, les embeds, les packs de sponsoring, le tableau de score en temps réel, une recharge ponctuelle de crédits IA et 4 % de frais de plateforme au lieu de 5 %. Ce n'est pas Pro — votre couleur de marque sur les pages publiques, l'accès API et les limites de votre propre organisation restent réservés à Pro. Une compétition couverte par un pass cesse de compter dans votre limite de compétitions actives ; le pass ne se reporte pas à l'édition de la saison suivante.",
        ],
        [
          "nl",
          "Alleen voor deze competitie: de pass geeft 128 deelnemers per divisie en tot 10 divisies. Hij voegt gebrande exports, openbare spelerskaarten, spelersstatistieken, automatische toewijzing van officials, tuchtregistratie, embeds, sponsorpakketten, het realtime scorebord, een eenmalige AI-creditbijboeking en 4% platformkosten in plaats van 5% toe. Het is geen Pro — je merkkleur op publieke pagina's, API-toegang en de limieten van je eigen organisatie blijven Pro. Een competitie met een pass telt niet langer mee voor je limiet aan actieve competities; de pass gaat niet mee naar de editie van het volgende seizoen.",
        ],
      ] as Array<[DictionaryLocale, string]>
    ).map(([locale, value]) => ({ locale, key: "tips.billing.event-pass.body", value }));

    const faults = localePaidOverclaimFaults(preFix, grants).join(" | ");
    for (const locale of DICTIONARY_LOCALES) {
      expect(faults, `${locale}: the player-stats claim must red`).toContain(
        `${locale} tips.billing.event-pass.body: sells stats.player as a paid differentiator, but community already grants it`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, in four languages, not by reverting.
//
// The dictionaries are (and must stay) correct, so every assertion above passes
// whether or not the guard covers the claim. These point the same pure functions
// at the copy a future editor — or a future TRANSLATOR — plausibly writes.
//
// Restoring the exact sentence this task removed is NOT proof. That is what let
// two guards ship green in wave 6. Every rewording below is a string that does
// not appear anywhere in the repo.
// ─────────────────────────────────────────────────────────────────────────────
describe("the dictionary guards survive a rewording, in every locale", () => {
  const v = (locale: DictionaryLocale, value: string): LocalisedValue[] => [
    { locale, key: "k", value },
  ];

  // The bound, said correctly, in each language. These are the fixtures the
  // negatives below are built on top of — if one of these ever reds, the guard
  // has started rejecting true copy.

  it("accepts a correctly bounded sentence in each language", () => {
    for (const locale of DICTIONARY_LOCALES) {
      expect(localePassBoundFaults(v(locale, BOUNDED[locale])), locale).toEqual([]);
    }
  });

  // ── DETECTION RATE, MEASURED ───────────────────────────────────────────────
  //
  // Fix round 1's central finding: the es/fr/nl vocabularies were
  // SINGULAR-VERB-ONLY, so the architecture above was carrying nothing. Review
  // measured 2 of 16 rewordings detected, with fr and nl at ZERO.
  //
  // This is the measurement itself, committed. Each fixture is the permanence
  // claim appended to that locale's CORRECT bounded sentence, so the value
  // still satisfies the positive rule and ONLY the vocabulary can catch it —
  // the "keep the true copy, add the false claim" shape, which is how a
  // translator actually reintroduces one. None of these strings is the retired
  // literal, and the list deliberately includes inflections, tenses and
  // periphrases the rules were not written against one-for-one.

  it("detects the permanence claim in EVERY locale, at a measured rate", () => {
    const scores: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const fixtures = REWORDINGS[locale];
      const missed = fixtures.filter(
        (reworded) => localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${reworded}`)).length === 0,
      );
      scores.push(`${locale} ${fixtures.length - missed.length}/${fixtures.length}`);
      expect(missed, `${locale} missed: ${missed.join(" | ")}`).toEqual([]);
    }
    // Recorded so a regression reads as a number, not a boolean.
    expect(scores).toEqual(["en 16/16", "es 16/16", "fr 16/16", "nl 16/16"]);
  });

  /**
   * …and the honest version of the same measurement.
   *
   * The fixtures above were written alongside the rules, so 16/16 partly
   * measures my own memory. THESE were written to defeat them: permanence
   * claims phrased the way a speaker phrases them, deliberately avoiding the
   * verb stems and adverbials the vocabulary enumerates. On the first run of
   * fix round 1's rebuilt vocabulary they scored **0/32 — including 0/8 in
   * English**, which is what a word-list buys you: it catches the words in it.
   *
   * What closed the gap was not more words but three CLAIM FAMILIES — absence
   * of an end, endurance verbs, and "always" bound to a retention word. Those
   * generalise; "caduca" does not.
   */

  /**
   * THE HONEST NUMBER, and the reason this suite's primary rule is now a pinned
   * string rather than a vocabulary.
   *
   * Written AFTER the rules were final for this round — ordinary editorial
   * prose, including the five phrasings the reviewer cited. No rule was
   * adjusted to accommodate any of it. Measured: **1 of 40**, with en, es and
   * fr at zero.
   *
   * That is not a bug to be fixed by widening. It is the third and fourth
   * independent measurement of the same property: a rule that reads the
   * sentence scores on the examples its author imagined. Task 3 went 12/12 to
   * 6/30, task 4 went 16/16 to 0/32 to 1/40. Every round of widening has moved
   * the tuned number and left the fresh one on the floor.
   *
   * The rate is asserted so that it stays VISIBLE. If someone widens the
   * vocabulary the number rises and they must update it deliberately — which is
   * the only way an improvement here is distinguishable from a coincidence.
   */
  it("records what the vocabulary actually catches on prose it has never seen", () => {
    const detected = Object.entries(FRESH).flatMap(([locale, lines]) =>
      lines.filter(
        (s) =>
          localePassBoundFaults(v(locale as DictionaryLocale, `${BOUNDED[locale as DictionaryLocale]} ${s}`))
            .length > 0,
      ),
    );
    const total = Object.values(FRESH).flat().length;
    expect(total).toBe(40);
    expect(
      detected.length,
      "the vocabulary's measured recall on unseen prose — update deliberately, and say why",
    ).toBe(1);
  });

  /**
   * …AND WHAT ACTUALLY PROTECTS THE SHIPPED COPY.
   *
   * The same 40 sentences, appended to the real approved values: the
   * approved-wording gate reds on **40 of 40**, because it does not care how
   * the falsehood is phrased. This is the whole argument for the architecture,
   * made as a measurement rather than an assertion.
   */
  it("the approved-wording gate catches all 40, where the vocabulary caught 1", () => {
    const entry = APPROVED_DICTIONARY_COPY.find((e) => e.key === "pricing.faq.eventPass.a")!;
    const missed: string[] = [];
    for (const [locale, lines] of Object.entries(FRESH) as Array<[DictionaryLocale, string[]]>) {
      for (const line of lines) {
        const tampered = `${entry.text[locale]} ${line}`;
        const faults = approvedDictionaryFaults([entry], (file, l) =>
          l === locale
            ? { ...load(l, file), [entry.key]: tampered }
            : load(l, file),
        );
        if (faults.length === 0) missed.push(`${locale}: ${line}`);
      }
    }
    expect(missed, `the gate missed: ${missed.join(" | ")}`).toEqual([]);
  });

  it("detects permanence claims written to DEFEAT the vocabulary, not to match it", () => {
    const scores: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const fixtures = ADVERSARIAL[locale];
      const missed = fixtures.filter(
        (reworded) => localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${reworded}`)).length === 0,
      );
      scores.push(`${locale} ${fixtures.length - missed.length}/${fixtures.length}`);
      expect(missed, `${locale} missed: ${missed.join(" | ")}`).toEqual([]);
    }
    expect(scores).toEqual(["en 8/8", "es 8/8", "fr 8/8", "nl 8/8"]);
  });

  /**
   * The other direction, and the reason the no-limit family is scoped to TIME.
   *
   * A bare "limit" noun is about whatever it limits. The first cut of the
   * family banned "aucune limite", which reds French `pricing.faq.eventPass.a`
   * — "sans aucune limite de participants" is a TRUE statement of the L rung's
   * unlimited entrant cap (measured; it was the only false positive across all
   * twenty-four shipped values). A guard that rejects true prose teaches its
   * next editor to route around it.
   */
  it("does not read an unlimited ENTRANT cap as an unlimited DURATION", () => {
    for (const [locale, honest] of [
      ["en", "the L pass takes it to 20 divisions and no entrant limit at all"],
      ["es", "el pase L lleva la misma competición a 20 divisiones y sin ningún límite de participantes"],
      ["fr", "le pass L porte la même compétition à 20 divisions et sans aucune limite de participants"],
      ["nl", "de L-pass tilt dezelfde competitie naar 20 divisies en helemaal geen deelnemerslimiet"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${honest}`)),
        `${locale}: ${honest}`,
      ).toEqual([]);
    }
  });

  /**
   * NEW-2, the regression fix round 1 introduced and this round removes.
   *
   * Round 1 answered "is this claim about the rate?" by DROPPING any clause
   * that named a rate and not the pass. Pass copy quotes percentages
   * constantly — `pricing.faq.eventPass.a` carries 5% in every locale — so the
   * exemption sat exactly on the surface it was guarding, and these nine went
   * GREEN (they had all redded before round 1). The repair narrows the MATCH
   * instead: a permanence hit is attributed to the rate only when no
   * coordinator and no pass noun intervene.
   */
  it("attributes a permanence claim to the pass even when the clause quotes a rate", () => {
    const missed = (
      [
        ["en", "It is a one-off at the 5% rate and it lasts forever."],
        ["en", "Your 5% fee and the bigger limits it brings never end."],
        ["en", "The 5% rate applies and it is yours to keep."],
        ["es", "Es un pago único al 5% de comisión y dura para siempre."],
        ["es", "Tu comisión del 5% y los límites que trae no caducan nunca."],
        ["fr", "C'est un paiement unique à 5 % de frais et cela dure pour toujours."],
        ["fr", "Vos 5 % de frais et les limites qu’il apporte ne se terminent jamais."],
        ["nl", "Jouw 5% kosten en de ruimere limieten kennen geen einde."],
        ["nl", "Het 5% tarief geldt en het blijft voor altijd van jou."],
      ] as Array<[DictionaryLocale, string]>
    ).filter(([locale, s]) => localePassBoundFaults(v(locale, `${BOUNDED[locale]} ${s}`)).length === 0);
    expect(missed, `still exempted: ${missed.map(([, s]) => s).join(" | ")}`).toEqual([]);
  });

  /**
   * "THE PASS NEVER ENDS" IS FALSE; "THE LOCKED RATE NEVER CHANGES" IS TRUE.
   *
   * The permanence vocabulary contains `for good`, `permanentemente`,
   * `définitivement` and `permanent` — all of which are legitimate ways to say
   * the V312 fee lock holds. Task 3 has just rewritten the fee-lock prose, so
   * without a subject test this fires on true copy the moment that wording
   * reaches a guarded value.
   */
  it("allows a permanence claim about the LOCKED RATE, whose subject is not the pass", () => {
    for (const [locale, rateClause] of [
      ["en", "once the first paid entry lands, that 5% rate is locked for good"],
      // No percentage anywhere in this one. All three round-1 fixtures happened
      // to carry a literal 5%, which hid en.rateSubject having no bare `fee`.
      ["en", "Its fee stays locked for good once a first entry is paid"],
      ["en", "The platform fee is fixed permanently after the first paid entry"],
      ["es", "tras la primera inscripción de pago, esa comisión del 5% queda fijada permanentemente"],
      ["fr", "dès la première inscription payante, ce taux de 5 % est verrouillé définitivement"],
      ["nl", "na de eerste betaalde inschrijving staat dat tarief van 5% permanent vast"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localePassBoundFaults(v(locale, `${BOUNDED[locale]} — ${rateClause}.`)),
        `${locale}: ${rateClause}`,
      ).toEqual([]);
    }
  });

  // …and the exemption is not a hiding place: a clause that names the RATE but
  // also names the PASS is still scanned, so "a 5% fee, and the pass lasts
  // forever" cannot smuggle the falsehood in behind a percentage.
  it("still reds when a rate clause also makes the claim about the pass", () => {
    expect(
      localePassBoundFaults(
        v("en", `${BOUNDED.en} — the 5% platform fee applies and the pass lasts forever.`),
      ).join(" "),
    ).toContain("unbounded duration");
    expect(
      localePassBoundFaults(v("fr", `${BOUNDED.fr} — ce taux de 5 % et le pass sont permanents.`)).join(
        " ",
      ),
    ).toContain("unbounded duration");
  });

  // THE POINT OF THE WHOLE TASK. Each of these is the permanence claim written
  // fresh in its own language — none of them is the sentence this task deleted.
  it("catches an unbounded pass claim in each language, reworded", () => {
    for (const [locale, reworded] of [
      ["en", "This competition is upgraded and the upgrade never expires."],
      ["en", "Buy once and the pass is yours to keep."],
      ["es", "Esta competición queda mejorada de forma indefinida."],
      ["es", "Págalo una vez y la mejora nunca caduca."],
      ["es", "La mejora es permanente para esa competición."],
      ["fr", "Cette compétition est améliorée définitivement."],
      ["fr", "Payez une fois : l’amélioration n’expire jamais."],
      ["fr", "L’amélioration est permanente pour cette compétition."],
      ["nl", "Deze competitie is voorgoed geüpgraded."],
      ["nl", "Betaal één keer; de upgrade vervalt nooit."],
      ["nl", "De upgrade is permanent voor die competitie."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localePassBoundFaults(v(locale, reworded)), `${locale}: ${reworded}`).not.toEqual([]);
    }
  });

  // Layer 2, and the failure mode the previous wave actually shipped: a
  // non-English surface rendering new ENGLISH prose. The English vocabulary must
  // fire on the Dutch value, and the French vocabulary on the Spanish one.
  it("catches one language's falsehood sitting in another language's file", () => {
    const faults = localePassBoundFaults([
      { locale: "nl", key: "k", value: `${BOUNDED.nl} Yours for the event's lifetime.` },
      { locale: "es", key: "k", value: `${BOUNDED.es} Válido à vie.` },
      { locale: "fr", key: "k", value: `${BOUNDED.fr} Válido de por vida.` },
    ]);
    expect(faults.join(" | ")).toContain("nl k: claims the pass has unbounded duration in en vocabulary");
    expect(faults.join(" | ")).toContain("es k: claims the pass has unbounded duration in fr vocabulary");
    expect(faults.join(" | ")).toContain("fr k: claims the pass has unbounded duration in es vocabulary");
  });

  // The positive half, defeated from the other side. An absence-shaped rule is
  // happiest when the claim is DELETED — leaving a buyer told nothing about when
  // the upgrade stops.
  it("catches the bound being dropped rather than contradicted", () => {
    for (const [locale, silent] of [
      ["en", "One payment upgrades this competition. Bigger limits and a cheaper fee."],
      ["es", "Un solo pago mejora esta competición. Límites mayores."],
      ["fr", "Un seul paiement améliore cette compétition. Des limites plus élevées."],
      ["nl", "Eén betaling upgradet deze competitie. Ruimere limieten."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localePassBoundFaults(v(locale, silent)), `${locale}: ${silent}`).toEqual([
        `${locale} k: never states, in ${locale}, that the pass is bounded to a running competition`,
      ]);
    }
    // …and an emptied key is a fault, never a clean scan.
    expect(localePassBoundFaults(v("en", "  "))).toEqual([
      "en k: empty — nothing to scan, so every rule below passes vacuously",
    ]);
  });

  // "Active" with no limiting conjunction is a claim of immediate start and NO
  // end. It must not satisfy a rule meant to assert a bound — the same defeat
  // `BOUNDED_SCOPE_GRAMMAR` was hardened against for the seed, re-proved in each
  // language because each has its own grammar for it.
  it("is not satisfied by a bare activity word without its conjunction", () => {
    for (const [locale, bare] of [
      ["en", "This competition is upgraded — active immediately, with bigger limits."],
      ["es", "Esta competición está mejorada — activa de inmediato, con límites mayores."],
      ["fr", "Cette compétition est améliorée — active immédiatement, limites plus élevées."],
      ["nl", "Deze competitie is geüpgraded — direct actief, met ruimere limieten."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localePassBoundFaults(v(locale, bare)), `${locale}: ${bare}`).not.toEqual([]);
    }
  });

  // Layer 3 on its own, including the two fragments the vocabularies cannot
  // hold without rejecting true prose.
  it("catches a retired literal restored in any single locale", () => {
    expect(
      retiredClaimFaults(v("fr", "Une compétition, pour toute sa durée."), RETIRED_CLAIMS),
    ).toEqual(['fr k: still carries the retired claim "pour toute sa durée"']);
    expect(
      retiredClaimFaults(v("nl", "elke extra organisatie voor de helft van het basistarief"), RETIRED_CLAIMS),
    ).toEqual(['nl k: still carries the retired claim "organisatie voor de helft van het basistarief"']);
    // …and the qualified Dutch sentence this task shipped is NOT a hit.
    expect(
      retiredClaimFaults(
        v("nl", "elke extra organisatie voor hoogstens de helft van het basistarief"),
        RETIRED_CLAIMS,
      ),
    ).toEqual([]);
    // An empty registry would make this layer examine nothing.
    expect(retiredClaimFaults(v("en", "anything"), [])).toEqual([
      "retired-claim registry is empty — this layer would examine nothing",
    ]);
  });

  it("catches a drifted, missing or recurring credit grant, in each language", () => {
    const both = `+${M_GRANT} AI credits con M, +${L_GRANT} con L`;
    for (const locale of DICTIONARY_LOCALES) {
      expect(localeCreditGrantFaults(v(locale, both), GRANTS), locale).toEqual([]);
    }
    // ENTITLEMENTS V18 W2 T5. This answer covers BOTH rungs in one sentence, so
    // the rule reads the declared SET — and the case that matters is the half
    // update: an editor who moves M's figure and leaves L's behind, or the
    // reverse. Each is now a fault; under the flat rule the first was the
    // required wording and the second was invisible.
    expect(localeCreditGrantFaults(v("en", `a one-time +${M_GRANT} AI credits`), GRANTS)).toEqual([
      `en k: does not state the one-time +${L_GRANT} AI credit grant`,
    ]);
    expect(localeCreditGrantFaults(v("en", `a one-time +${L_GRANT} AI credits`), GRANTS)).toEqual([
      `en k: does not state the one-time +${M_GRANT} AI credit grant`,
    ]);
    // A figure that is NEITHER rung's is still drift.
    expect(localeCreditGrantFaults(v("en", `${both} +40`), GRANTS).join(" ")).toContain(
      "quotes +40",
    );
    // Deletion.
    expect(
      localeCreditGrantFaults(v("en", "advanced formats, exports and realtime"), GRANTS),
    ).toEqual([
      `en k: does not state the one-time +${M_GRANT} AI credit grant`,
      `en k: does not state the one-time +${L_GRANT} AI credit grant`,
    ]);
    // ...and an empty grant set would examine nothing.
    expect(localeCreditGrantFaults(v("en", "anything"), [])).toEqual([
      "credit-grant set is empty — this rule would examine nothing",
    ]);
    // The inverse claim — right number, wrong cadence — in each language.
    for (const [locale, recurring] of [
      ["en", "+25 AI credits every month"],
      ["es", "+25 créditos de IA al mes"],
      ["fr", "+25 crédits IA par mois"],
      ["nl", "+25 AI-credits per maand"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localeCreditGrantFaults(v(locale, recurring), GRANTS).join(" "),
        `${locale}: ${recurring}`,
      ).toContain("sells the one-time grant as recurring");
    }
  });

  /**
   * #338 item 3: `{es,fr,nl}.recurring` was MONTHLY-ONLY, so a yearly, weekly or
   * quarterly framing of the same one-time-grant falsehood scored 0/9 — none of
   * these nine phrasings, one per locale per cadence, tripped anything before
   * this task widened the three lists. Reusing the issue's own nine examples
   * rather than inventing new ones: "cada año", "anuales", "en cada renovación"
   * (es); "chaque année", "annuels", "à chaque renouvellement" (fr); "elk jaar",
   * "jaarlijks", "bij elke verlenging" (nl).
   */
  it("catches the recurring-grant claim beyond monthly, in es/fr/nl", () => {
    for (const [locale, recurring] of [
      ["es", "Recibe +25 créditos de IA cada año."],
      ["es", "Créditos de IA anuales: +25."],
      ["es", "En cada renovación, +25 créditos de IA."],
      ["fr", "Recevez +25 crédits IA chaque année."],
      ["fr", "Crédits IA annuels : +25."],
      ["fr", "À chaque renouvellement, +25 crédits IA."],
      ["nl", "Ontvang elk jaar +25 AI-credits."],
      ["nl", "Jaarlijks +25 AI-credits."],
      ["nl", "Bij elke verlenging +25 AI-credits."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        localeCreditGrantFaults(v(locale, recurring), GRANTS).join(" "),
        `${locale}: ${recurring}`,
      ).toContain("sells the one-time grant as recurring");
    }
  });

  // ── The Pro Plus differentiators ──────────────────────────────────────────
  //
  // Four tests lived here and were DELETED in W2 (entitlements v18) with
  // `localePlusDifferentiatorFaults`, the guard they exercised. It judged the
  // "Everything in Pro, plus …" frame against `pro_plus` grants, and V393
  // deleted that plan from `plans` — so every call reported four faults about a
  // card `/pricing` no longer renders. The four LOCALE vocabularies that fed it
  // (`LocaleClaims.plusClaims`) went with it.
  //
  // What the deletion does NOT give up: the same question, asked of the cards
  // that still exist, by `crossCardExclusivityFaults` in pricing-cards.test.ts
  // over `EXCLUSIVE_CLAIM_VOCAB` — the identical list, renamed. `officials.auto`
  // is what keeps it non-vacuous: V393 moved that key down to Pro, and the Pro
  // card now claims it.

  // The LEADER is an argument now (W2): it was hardcoded `pro_plus`, a plan
  // V393 deleted, so the guard compared `undefined` against everything and
  // named a plan that does not exist in its own failure message. The live
  // ordering is enterprise 500 > pro 25 > community 5.
  it("judges the credit-leadership claim against the numbers, both ways", () => {
    const live = { community: 5, pro: 25, enterprise: 500 };
    for (const [locale, honest] of [
      ["en", "plus the largest monthly AI credit grant"],
      ["es", "más la mayor asignación mensual de créditos de IA"],
      ["fr", "plus la plus grosse dotation mensuelle de crédits IA"],
      ["nl", "plus de grootste maandelijkse AI-credittoekenning"],
    ] as Array<[DictionaryLocale, string]>) {
      expect(localeCreditLeadershipFaults(v(locale, honest), live, "enterprise"), locale).toEqual([]);
      // The claim stated while the matrix contradicts it — the lower plan
      // catching up, which leaves every string true and the comparative false.
      expect(
        localeCreditLeadershipFaults(v(locale, honest), { ...live, pro: 900 }, "enterprise").join(" "),
        locale,
      ).toContain("but enterprise grants 500");
      // …and the leader ARGUMENT itself has to bite: the same numbers, claimed
      // for the wrong plan. This is the case that shipped for a whole wave as
      // `undefined` and reported a plan nobody could buy.
      expect(
        localeCreditLeadershipFaults(v(locale, honest), live, "pro").join(" "),
        locale,
      ).toContain("but pro grants 25");
    }
    // Deletion: dropping the claim entirely.
    expect(localeCreditLeadershipFaults(v("en", "plus priority support"), live, "enterprise")).toEqual([
      "en k: never claims the largest monthly AI credit grant",
    ]);
  });

  // ── The extra-organisation rate ────────────────────────────────────────────

  it("catches a bare 'half the base rate' in each language", () => {
    for (const [locale, bare, qualified] of [
      ["en", "each extra one at half the base rate", "each extra one at no more than half the base rate"],
      [
        "es",
        "cada una adicional a mitad de la tarifa base",
        "cada una adicional por no más de la mitad de la tarifa base",
      ],
      [
        "fr",
        "chaque organisation supplémentaire à moitié du tarif de base",
        "chaque organisation supplémentaire pour au plus la moitié du tarif de base",
      ],
      [
        "nl",
        "elke extra organisatie voor de helft van het basistarief",
        "elke extra organisatie voor hoogstens de helft van het basistarief",
      ],
    ] as Array<[DictionaryLocale, string, string]>) {
      expect(localeHalfClaimFaults(v(locale, bare), "atMost").join(" "), `${locale} bare`).toContain(
        'quotes half the base rate with no "no more than" qualifier',
      );
      expect(localeHalfClaimFaults(v(locale, qualified), "atMost"), `${locale} qualified`).toEqual([]);
      // Deletion: an answer that simply stops saying what a second org costs.
      expect(localeHalfClaimFaults(v(locale, "Pro Plus cubre hasta 10."), "atMost")).toEqual([
        `${locale} k: makes no statement about the extra-organisation rate`,
      ]);
    }
  });

  // WRONG-CLAUSE SATISFACTION, the third occurrence of that defect in this
  // wave. The rule was value-scoped, so a bare "half the base rate" appended to
  // a corrected value stayed green: `atMostHalf` was satisfied by the EARLIER,
  // correct clause. A qualifier in another clause qualifies nothing.
  it("requires the qualifier in the clause that makes the claim, not merely somewhere", () => {
    const corrected = "Pro Plus covers up to 10, each extra one at no more than half the base rate";
    expect(localeHalfClaimFaults(v("en", corrected), "atMost"), "the corrected value").toEqual([]);
    // …and the same value with a second, unqualified claim appended.
    expect(
      localeHalfClaimFaults(
        v("en", `${corrected}. Extra organisations are billed at half the base rate.`),
        "atMost",
      ).join(" "),
      "an unqualified second clause must not be covered by the first",
    ).toContain('quotes half the base rate with no "no more than" qualifier');
  });

  // THE OTHER NEGATIVE CASE. "no more than half" is required because the seed's
  // riders are not all exact halves. If a price move made them all exact, a bare
  // "half" would become true and this guard must stop demanding the qualifier.
  it("stops demanding the qualifier if every rider becomes an exact half", () => {
    expect(localeHalfClaimFaults(v("en", "each extra one at half the base rate"), "exactly")).toEqual([]);
    // …and `riderClaimShape` is what decides that, from the seed, not a constant.
    const exact: PricedPlan[] = [
      {
        key: "x",
        product: { description: "" },
        prices: {
          monthly: {
            lookup_key: "x_monthly",
            unit_amount: 2000,
            tiers: [
              { up_to: 1, unit_amount: 2000, currency_options: { eur: 2000, gbp: 2000, inr: 2000 } },
              { up_to: "inf", unit_amount: 1000, currency_options: { eur: 1000, gbp: 1000, inr: 1000 } },
            ],
          },
        },
      },
    ];
    expect(riderClaimShape(exact)).toBe("exactly");
    // One odd currency is enough to make a bare "half" false again.
    exact[0]!.prices.monthly!.tiers![1]!.currency_options!.inr = 999;
    expect(riderClaimShape(exact)).toBe("atMost");
  });

  // `riderClaimShape` and `riderRateFaults` compute the same thing two ways and
  // were unpinned to each other. They must agree: whenever the shape is
  // "atMost", a description claiming a bare "half the base rate" has to be a
  // fault by the seed guard too, or the dictionary rule and the Stripe rule are
  // enforcing different arithmetic on the same number.
  it("agrees with the seed guard about what the riders actually charge", () => {
    const plans = stripePlans.plans as unknown as PricedPlan[];
    const shape = riderClaimShape(plans);
    const bare = plans.map((p) => ({
      ...p,
      product: { description: "Extra organisations are billed at half the base rate." },
    }));
    const qualified = plans.map((p) => ({
      ...p,
      product: { description: "Extra organisations are billed at no more than half the base rate." },
    }));
    if (shape === "atMost") {
      expect(riderRateFaults(bare), "shape says atMost, so a bare 'half' must fault").not.toEqual([]);
      expect(riderRateFaults(qualified), "…and the qualified claim must not").toEqual([]);
    } else {
      expect(riderRateFaults(bare), "shape says exactly, so a bare 'half' is true").toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-WIDE ANTI-VACUITY.
//
// Twice in this wave a guard has passed while examining nothing: the French
// permanence list could not match its own language (ASCII `\b`), and task 3's
// `DURATION_CLAIM` matched NOTHING AT ALL after a stray control character
// replaced a `\b` — with the suite green both times, carried by sibling rules.
//
// A pattern that compiles but can never fire makes every assertion resting on
// it report clean, so this check belongs to the whole module rather than to the
// rule that happened to break. It walks every exported RegExp — including ones
// nested in arrays, in LOCALE_CLAIMS, and in [feature, RegExp] tuples — and
// demands each one fire on something.
// ─────────────────────────────────────────────────────────────────────────────
describe("every pattern in @/lib/copy-truth does something", () => {
  const patterns = collectPatterns(copyTruth as unknown as Record<string, unknown>);
  const MODULE_SOURCE = readFileSync("src/lib/copy-truth.ts", "utf8");

  it("finds patterns everywhere they are declared, not just at the top level", () => {
    expect(patterns.length, "the walk found almost nothing — its shape assumption broke").toBeGreaterThan(
      80,
    );
    // Proof the walk actually descends: these three live at three different
    // depths (bare export, array element, and inside a tuple in a record).
    const paths = patterns.map((p) => p.path);
    expect(paths).toContain("BOUNDED_SCOPE_GRAMMAR");
    expect(paths.some((p) => /^FALSE_PASS_PERMANENCE_PATTERNS\[\d+\]$/.test(p))).toBe(true);
    // W2: this used to name `LOCALE_CLAIMS.fr.plusClaims[n][1]`, a tuple inside
    // a record inside a record — the deepest shape the walk had to reach. That
    // field went with `localePlusDifferentiatorFaults`, so the depth proof moves
    // to `EXCLUSIVE_CLAIM_VOCAB`, which is the same [feature, RegExp] tuple
    // shape at the top level, plus a genuine record-of-record path that still
    // exists. Both are asserted, so the walk cannot lose either descent.
    expect(paths.some((p) => /^EXCLUSIVE_CLAIM_VOCAB\[\d+\]\[1\]$/.test(p))).toBe(true);
    expect(paths.some((p) => /^LOCALE_CLAIMS\.fr\.permanence\[\d+\]$/.test(p))).toBe(true);
  });

  // Defect 2's signature: a mangled escape leaves a raw control character in the
  // source, and the pattern quietly stops matching.
  it("contains no control character in any pattern source", () => {
    expect(controlCharacterFaults(patterns)).toEqual([]);
  });

  // Defect 1's signature: a pattern that cannot fire. Every pattern must match
  // at least one line of the corpus — so adding a pattern means adding a string
  // it matches, which is the cheapest possible proof that it does something.
  it("fires on at least one known-positive fixture, every one of them", () => {
    expect(inertPatternFaults(patterns, KNOWN_POSITIVES)).toEqual([]);
  });

  // NEW-1: `collectPatterns` walks module EXPORTS, so a top-level pattern that is
  // not exported is invisible to every rule above. Seven were — including
  // DURATION_CLAIM, which this check cites as its own reason for existing.
  // Measured: a literal U+0001 in DURATION_CLAIM left this suite 36/36 green,
  // while the same byte in an exported pattern redded three tests.
  it("exports every top-level pattern, so none is exempt from the checks above", () => {
    expect(unexportedPatternFaults(MODULE_SOURCE)).toEqual([]);
  });

  /**
   * #338 item 4 (second vacuity hole), mutation-proven. The OLD `PATTERN_SHAPED`
   * required the pattern immediately after `=` and missed one wrapped in a
   * container: `const ZZ_PROBE_LIST: RegExp[] = [/(?!x)x-inert/i];` — a real
   * inert, unexported RegExp array — shipped clean because the `=` is followed
   * by `[`, not `/`. Same failure for `new RegExp(...)` and `claim(...)` a
   * bracket deep. All three must now red; a bare non-pattern const declaration
   * (a Record of STRINGS, e.g. the module's own `CLAUSE_BREAK`/`SUBJECT_BREAK`
   * shape) must still pass, or every plain lookup table in the file would need
   * an unnecessary `export`.
   */
  it("catches a pattern hidden inside a container, not just bare after '='", () => {
    expect(
      unexportedPatternFaults('const ZZ_PROBE_LIST: RegExp[] = [/(?!x)x-inert/i];'),
      "an array literal one bracket deep",
    ).toEqual([
      "ZZ_PROBE_LIST: a top-level pattern that is not exported — collectPatterns cannot see it, so it is exempt from every anti-vacuity rule below. Add `export`.",
    ]);
    expect(
      unexportedPatternFaults("const ZZ_PROBE_MAP: Record<string, RegExp> = { a: new RegExp('x') };"),
      "new RegExp(...) inside an object literal",
    ).not.toEqual([]);
    expect(
      unexportedPatternFaults("const ZZ_PROBE_CLAIM: RegExp[] = [claim('x')];"),
      "claim(...) inside an array literal",
    ).not.toEqual([]);
    // …and a plain lookup table of STRINGS — this module's own shape for
    // CLAUSE_BREAK/SUBJECT_BREAK — must not be swept in: it holds no RegExp at
    // all, so requiring `export` on it would be busywork, not a fix.
    expect(
      unexportedPatternFaults('const ZZ_NOT_A_PATTERN: Record<string, string> = { en: "x" };'),
      "a plain string lookup table is not pattern-shaped",
    ).toEqual([]);
  });

  // …and the control-character scan run over the RAW SOURCE, which reaches what
  // the compiled-pattern scan cannot: non-exported consts, String.raw fragments
  // that are only ever composed into other patterns, and ordinary prose.
  it("has no literal control character anywhere in its source", () => {
    expect(sourceControlCharacterFaults(MODULE_SOURCE)).toEqual([]);
  });

  // …and the corpus itself must not rot into a list nothing reads: if a fixture
  // matches no pattern at all, it is dead weight that hides the next gap.
  it("keeps no fixture that no pattern matches", () => {
    const unused = KNOWN_POSITIVES.filter((text) => !patterns.some(({ pattern }) => pattern.test(text)));
    expect(unused, "corpus lines matched by nothing").toEqual([]);
  });
});

// ── #404: the merge tip promised the opposite of what the tool now does ──────
//
// Before this wave a merge DELETED the absorbed record and could not be undone,
// and `tips.persons.merge.body` said exactly that — in four languages, sitting
// beside a button that now tombstones the record and is reversible from the
// merge log forever. Same failure shape as `pricing.pass.note` at the top of
// this file: one English fix would have certified `en` and left three locales
// telling organisers their merge is final.
//
// Guarded in both directions on purpose. The retired-literal registry alone is
// satisfied by an EMPTY string; the positive claim alone is satisfied by copy
// that mentions undo and still says the duplicate is deleted.
describe("the duplicate-merge tip (#404)", () => {
  const MERGE_TIP_VALUES = across("ui", "tips.persons.merge.body");

  /** The claim the tool retired, per locale — the deletion AND the finality,
   *  since a merge that "removes the duplicate" is the same lie told about the
   *  row rather than about the undo. */
  const RETIRED_MERGE_CLAIMS = [
    // en
    "can't be undone",
    "cannot be undone",
    "removes the duplicate",
    // es
    "no se puede deshacer",
    "elimina el duplicado",
    // fr
    "ne peut pas être annulée",
    "supprime le doublon",
    // nl
    "kan niet ongedaan worden gemaakt",
    "verwijdert dan het duplicaat",
  ];

  /** The word each locale's own Undo control uses (`persons.dupes.undo`), so
   *  the tip names the affordance the organiser will actually look for. */
  const UNDO_WORD: Record<DictionaryLocale, string> = {
    en: "undo",
    es: "deshacer",
    fr: "annuler",
    nl: "ongedaan",
  };

  it("is present and substantial in every locale", () => {
    for (const { locale, value } of MERGE_TIP_VALUES) {
      expect(value.length, `${locale} tips.persons.merge.body is empty or a stub`).toBeGreaterThan(
        60,
      );
    }
  });

  it("no longer claims the merge deletes the duplicate or cannot be undone", () => {
    expect(retiredClaimFaults(MERGE_TIP_VALUES, RETIRED_MERGE_CLAIMS)).toEqual([]);
  });

  it("tells the organiser the merge can be undone, in their own language", () => {
    for (const { locale, value } of MERGE_TIP_VALUES) {
      expect(
        value.toLowerCase(),
        `${locale} tips.persons.merge.body never names the undo ("${UNDO_WORD[locale]}")`,
      ).toContain(UNDO_WORD[locale]);
    }
  });

  // …and the registry really holds each locale's OLD sentence. Without this the
  // test above passes against a registry that never covered these four strings —
  // absence proving "not false" rather than "scanned".
  it("holds the retired wording for all four locales", () => {
    for (const [locale, retired] of [
      ["en", "Results are untouched — but a merge can't be undone."],
      ["es", "Los resultados no se tocan — pero una fusión no se puede deshacer."],
      ["fr", "Les résultats ne sont pas touchés — mais une fusion ne peut pas être annulée."],
      ["nl", "Resultaten blijven ongewijzigd — maar een samenvoeging kan niet ongedaan worden gemaakt."],
    ] as Array<[DictionaryLocale, string]>) {
      expect(
        retiredClaimFaults([{ locale, key: "tips.persons.merge.body", value: retired }], RETIRED_MERGE_CLAIMS),
        `${locale}: ${retired}`,
      ).not.toEqual([]);
    }
  });

  // The SECOND string in this dialog that described the old behaviour: the
  // account-link note. Task 8b made the merge carry `user_id` onto an unlinked
  // survivor, but all four locales still told the organiser the link would be
  // "left behind" / "perdu" / "se perderá" / "blijft achter" unless they swapped
  // — a warning about a data loss that no longer happens, shown beside a swap
  // control the organiser then has no reason to trust.
  it("does not claim the account link is lost, in any locale", () => {
    const values = across("ui", "persons.dupes.account.note");
    for (const { locale, value } of values) {
      expect(value.length, `${locale} persons.dupes.account.note is empty`).toBeGreaterThan(40);
    }
    expect(
      retiredClaimFaults(values, [
        // en
        "the link is left behind",
        "keep that one instead",
        // es
        "el vínculo se perderá",
        // fr
        "le lien sera perdu",
        // nl
        "blijft de koppeling achter",
      ]),
    ).toEqual([]);
  });

  // The registry in `@/config/tips` is the source the dictionaries are written
  // from; leaving it stale is how the lie comes back on the next translation
  // pass.
  it("is fixed at the source registry too, and points at the article that documents undo", () => {
    expect(retiredClaimFaults(
      [{ locale: "en", key: "TIPS.persons.merge.body", value: TIPS["persons.merge"].body }],
      RETIRED_MERGE_CLAIMS,
    )).toEqual([]);
    expect(TIPS["persons.merge"].helpSlug).toBe("players/duplicates");
  });
});

// ── The ended pass's one remaining link names no interval ────────────────────
//
// `pass.entry.ended.nextEdition` is the single "yes" left once a pass stops
// applying, and it renders on every competition that reaches that state — a
// weekly ladder and a monthly league included. It said "Create next year's
// edition" in all four locales, which told most of those organisers to come
// back in twelve months for an event that runs again on Tuesday.
//
// Nothing in the schema makes a competition annual: `starts_on`/`ends_on` are
// two dates, there is no recurrence field, and the ladder and league formats
// are first-class. So the label may claim CONTINUITY ("edition") but never a
// PERIOD. This is a copy-only invariant with no type to hold it, which is why
// it is pinned here as well as in APPROVED_DICTIONARY_COPY: that fixture keeps
// the four strings in step with the dictionaries, but it would happily pin a
// year back into all four at once.
describe("the ended-pass next-edition link (cadence-neutral)", () => {
  // One list applied to every locale — the words are distinct enough that a
  // per-locale split would only invite a translation to be added to the wrong
  // bucket and silently stop being checked.
  const PERIOD_WORDS = [
    "year",
    "annual",
    "season", // en
    "año",
    "anual",
    "temporada", // es
    "année",
    "annuel",
    "saison", // fr
    "jaar",
    "seizoen", // nl
  ];

  it("names no interval in any locale", () => {
    const faults = across("ui", "pass.entry.ended.nextEdition").flatMap(({ locale, value }) => {
      expect(value.length, `${locale} pass.entry.ended.nextEdition is empty`).toBeGreaterThan(0);
      return PERIOD_WORDS.filter((w) => value.toLowerCase().includes(w)).map(
        (w) => `${locale}: "${value}" names the period "${w}"`,
      );
    });
    expect(faults).toEqual([]);
  });
});

/**
 * ── NOTHING IN ANY DICTIONARY SELLS SCORING DETAIL (entitlements v18 / W1) ───
 *
 * V390 deleted `scoring.ball_by_ball`, `scoring.rally_by_rally` and
 * `scoring.match_timeline` from `plan_entitlements`, and the same wave deleted
 * their gate from `scoreEvent` and the batch importer. Every band of recording
 * detail is now free on every plan.
 *
 * The three tests this wave inherited already fail when a BULLET is pinned to a
 * row that no longer exists. None of them can see a sentence — an upsell reason,
 * a help paragraph, an error message — that names the capability and a price in
 * the same breath while pointing at no entitlement row at all. That is the
 * shape that survives a row deletion, and it is the one a customer reads.
 *
 * Scanned across ALL EIGHT dictionary files, not the two this file's other
 * rules read: `errors.json` and `emails.json` are where an upsell reason ends
 * up when it is not on the pricing page.
 */
describe("no dictionary string sells scoring detail (W1: it is free on every plan)", () => {
  const DICT_FILES = readdirSync("src/dictionaries/en")
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();

  /**
   * SENTENCE-scoped, exactly like the help consumer in `help-copy-truth.test.ts`
   * (review M-3). `scoringFreeClaimFaults` exempts a text that affirms the thing
   * is free, and that exemption is whole-text: feeding a multi-sentence value in
   * one piece would let "…on every plan." in sentence one excuse a paid claim in
   * sentence two. Splitting first makes the exemption cover only the sentence
   * that earns it. `tips.*` and the `emails.*` bodies are paragraphs, so this is
   * not hypothetical.
   */
  const valuesFor = (locale: DictionaryLocale): Array<readonly [string, string]> =>
    DICT_FILES.flatMap((file) =>
      Object.entries(
        JSON.parse(readFileSync(`src/dictionaries/${locale}/${file}.json`, "utf8")) as Record<
          string,
          unknown
        >,
      )
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .flatMap(([key, value]) =>
          sentences(value).map((s) => [`${locale}/${file}.json ${key}`, s] as const),
        ),
    );

  const everyValue = (): Array<readonly [string, string]> =>
    DICTIONARY_LOCALES.flatMap((locale) => valuesFor(locale));

  /**
   * The four band labels a customer READS, for one locale — `Result only /
   * Key moments / Full timeline / Every detail` in English, and the
   * translator's own words in the other three ("Cronología completa",
   * "Chronologie complète", "Volledige tijdlijn").
   *
   * READ FROM THE DICTIONARY, never typed into the guard (final review I-1):
   * the guard's own vocabulary said "match timeline" while the product renders
   * "Full timeline", so three of the four labels this wave shipped were
   * invisible to the rule that exists to stop them being sold. Deriving them
   * means a rename moves the guard with the label.
   */
  const bandLabelsFor = (locale: DictionaryLocale): string[] => {
    const ui = JSON.parse(readFileSync(`src/dictionaries/${locale}/ui.json`, "utf8")) as Record<
      string,
      string
    >;
    return [0, 1, 2, 3].map((band) => ui[`pad.recording.band.${band}`] ?? "");
  };

  /** Every locale scanned against ITS OWN vocabulary and ITS OWN band labels. */
  const scoringFreeFaults = (): string[] =>
    DICTIONARY_LOCALES.flatMap((locale) =>
      scoringFreeClaimFaults(valuesFor(locale), {
        locale,
        bandLabels: bandLabelsFor(locale),
      }),
    );

  it("scans every file, in every locale — not a subset", () => {
    expect(DICT_FILES, "a dictionary file appeared or vanished").toContain("ui");
    expect(DICT_FILES).toContain("marketing");
    expect(DICT_FILES).toContain("errors");
    expect(DICT_FILES.length).toBeGreaterThanOrEqual(7);
    expect(everyValue().length, "the scan resolved almost nothing").toBeGreaterThan(4000);
  });

  it("names no plan beside a scoring-detail phrase or a shipped band label, in any locale", () => {
    const faults = scoringFreeFaults();
    // The message argument carries the offending key into a CI JSON report —
    // `failureMessages` otherwise says only "expected [ Array(1) ] to deeply
    // equal []" and the locale/key/sentence lives in the terminal diff alone.
    expect(faults, faults.join(" | ")).toEqual([]);
  });

  /**
   * ── THE GUARD CAN SEE THE LABELS THIS WAVE SHIPPED (final review I-1) ──────
   *
   * Measured before this existed: setting `pad.recording.band.2` to
   * "Full timeline (Pro)" reddened NOTHING on the branch. The guard's
   * vocabulary said "match timeline"; the product says "Full timeline". Three
   * of the four labels a customer reads were invisible to the one rule that
   * exists to stop them being priced — and the two neighbouring tests that
   * look like they would catch it do not (`recording-chip.test.tsx` scans the
   * KEY, because its `t` echoes keys; `gallery.capture.ts` uses
   * `toContainText`).
   *
   * Driven per locale through the REAL producer, so a rename in any of the
   * four dictionaries moves this with it.
   */
  it("catches a plan name pinned to a band label, in every locale", () => {
    for (const locale of DICTIONARY_LOCALES) {
      const labels = bandLabelsFor(locale);
      expect(labels.filter((l) => l.length > 0), `${locale} band labels`).toHaveLength(4);
      for (const [band, label] of labels.entries()) {
        const faults = scoringFreeClaimFaults([[`${locale} band.${band}`, `${label} (Pro)`]], {
          locale,
          bandLabels: labels,
        });
        expect(faults, `${locale} band.${band} "${label} (Pro)" is not seen as a price`).toHaveLength(1);
      }
    }
  });

  /**
   * ── AND IT SPEAKS ALL FOUR LANGUAGES (final review I-1, second half) ───────
   *
   * `everyValue()` reads es/fr/nl; until this round the vocabulary was English
   * only, so those three locales were measured against words that cannot occur
   * in them and could say anything at all.
   *
   * NOT a translation I invented: each locale's vocabulary is asserted against
   * copy this product ALREADY SHIPS, read out of that locale's own dictionary
   * at run time. If the product's upsell wording drifts away from the words
   * this guard knows, this reds — which is the only honest way to hold a
   * vocabulary I cannot audit as a native speaker.
   */
  it("each locale's price vocabulary matches that locale's own live upsell copy", () => {
    // Each anchor names WHICH half it exercises. The verb anchor is the one
    // that matters — plan names are untranslated, so a `planName` match proves
    // nothing about the language. "Brand color requires" was an anchor here
    // for one run and is deliberately NOT: it is a sentence FRAGMENT whose
    // plan is named by the adjacent link, so English failed it while es/fr
    // passed on a coincidence of their verb lists. A bad anchor teaches the
    // vocabulary the wrong lesson — the fix was a better anchor, not a wider
    // English regex (`requires`/`needs` would flag "the toss needs Key moments
    // or above", which is a recording level, not a price).
    const ANCHORS: Array<[key: string, half: "planName" | "paidVerb"]> = [
      ["board.ai.error.upgrade", "paidVerb"],
      // Renamed in W2: the key was `…upgradeToProPlus` and named a plan V393
      // deleted. Still a `planName` anchor — "Pro" is untranslated in all four
      // locales, which is exactly what makes it the right half to test here.
      ["board.ai.error.upgradeToPro", "planName"],
      ["addOns.extraOrg.error.planCannot", "planName"],
      ["billing.planChange.toPro", "planName"],
    ];
    const misses: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const ui = JSON.parse(readFileSync(`src/dictionaries/${locale}/ui.json`, "utf8")) as Record<
        string,
        string
      >;
      const vocabulary = SCORING_FREE_VOCABULARY[locale];
      expect(vocabulary, `${locale} has no scoring-free vocabulary at all`).toBeDefined();
      for (const [key, half] of ANCHORS) {
        const value = ui[key];
        expect(value, `${locale} ${key} is missing — pick another anchor`).toBeTruthy();
        if (!vocabulary![half].test(value!)) {
          misses.push(`${locale} ${key} (${half}): "${value}" reads as no price at all`);
        }
      }

      // …and the vocabulary is LIVE in this language, not just able to pass
      // four hand-picked strings: it must fire across that locale's own
      // dictionary. Measured today — es 148 / fr 115 / nl 133 verb hits, and
      // 97 / 91 / 126 plan-name hits — so a floor of 50 is a real signal and
      // still far from the live numbers.
      const own = valuesFor(locale);
      const verbHits = own.filter(([, text]) => vocabulary!.paidVerb.test(text)).length;
      const nameHits = own.filter(([, text]) => vocabulary!.planName.test(text)).length;
      expect(verbHits, `${locale}: the price verbs fire on almost nothing in its own dictionary`).toBeGreaterThan(50);
      expect(nameHits, `${locale}: the plan names fire on almost nothing in its own dictionary`).toBeGreaterThan(50);
    }
    expect(misses, misses.join(" | ")).toEqual([]);

    // …and an unknown locale is a FAULT, never a silent skip: a locale with no
    // vocabulary is a locale nothing scans, which is the defect this fixes.
    expect(
      scoringFreeClaimFaults([["x", "Ball-by-ball scoring is a Pro feature."]], { locale: "de" }),
    ).toEqual(["de: no scoring-free vocabulary — every string in this locale is unscanned"]);
  });

  /**
   * ── AND THE MAP THAT HELD ALL THREE OF THEM (review I-1) ───────────────────
   *
   * `FEATURE_REASONS` is not a dictionary — it is hardcoded English in
   * `lib/feature-copy.ts` — so the file scan above cannot see it, and it is the
   * single most customer-visible surface this task cleaned: `featureReason()`
   * is what `<UpgradeGate>` renders as the paywall body (upgrade-gate.tsx:168)
   * and what `/admin/entitlements` prints. It is also where all three retired
   * upsell sentences LIVED, which makes it the likeliest place a future wave
   * puts one back.
   *
   * Measured before this test existed: re-adding
   * `"scoring.ball_by_ball": "Ball-by-ball scoring is a Pro feature."` to the
   * map left 249/249 copy tests green. The map is scanned WHOLE — every entry,
   * not a hand-kept key list, which is the shape that missed four help articles.
   */
  it("no entitlement upsell reason sells scoring detail either", () => {
    const reasons = Object.entries(FEATURE_REASONS).flatMap(([key, text]) =>
      sentences(text).map((s) => [`FEATURE_REASONS ${key}`, s] as const),
    );
    expect(reasons.length, "FEATURE_REASONS resolved almost nothing").toBeGreaterThan(30);
    const faults = scoringFreeClaimFaults(reasons);
    expect(faults, faults.join(" | ")).toEqual([]);

    // …and it is a check, not a restatement: the exact sentence V390 retired.
    expect(
      scoringFreeClaimFaults([
        ["FEATURE_REASONS scoring.ball_by_ball", "Ball-by-ball scoring is a Pro feature."],
      ]),
    ).toHaveLength(1);
  });

  /**
   * …and the rule fires. Each of these is a string that shipped in this repo
   * before W1, or the exact shape of one; a rule that returned `[]` for all of
   * them would be decoration. The last two are the NEGATIVE controls: naming
   * the capability alone, or the plan alone, is not a fault — the help tree and
   * the billing articles have to do both.
   */
  it("is a check, not a restatement", () => {
    const faults = scoringFreeClaimFaults([
      ["feature-copy", "Ball-by-ball scoring is a Pro feature."],
      ["feature-copy", "Match timelines (scorers, cards, minutes) are a Pro feature."],
      ["help/badminton", "Rally-by-rally is the finest level and needs a plan that includes it."],
      ["help/batch-import", "Needs a detail level this plan doesn't include."],
      ["help/fidelity", "Timeline and Detail need a plan that includes match-timeline scoring."],
      ["discipline", "Ball-by-ball attribution is itself a Pro feature."],
    ]);
    expect(faults).toHaveLength(6);
    expect(faults[0]).toContain("presents scoring detail as paid");

    expect(
      scoringFreeClaimFaults([
        ["ok/capability-only", "Cricket divisions score ball by ball: one tap per delivery."],
        ["ok/plan-only", "Custom branding and the API are Pro features."],
        ["ok/affirmation", "Every detail level is available on every plan."],
      ]),
      "naming the capability, or the plan, or saying it is free, is not a fault",
    ).toEqual([]);
  });

  /**
   * ── `everyValue()` REALLY SPLITS, MEASURED ON THE REAL DICTIONARIES ────────
   *
   * WHY THE SPLIT MATTERS (review M-3). `scoringFreeClaimFaults`'s affirmation
   * exemption is whole-TEXT by design — it has to be, or "every level is
   * available on every plan" could not be written at all. That makes splitting
   * the CALLER's job: a value fed in one piece lets an affirmation in sentence
   * one excuse a price claim in sentence two.
   *
   * WHY THIS TEST IS SHAPED THE WAY IT IS (re-review, fix round 2). My first
   * attempt at pinning this called `scoringFreeClaimFaults` on a synthetic
   * two-sentence string. The re-reviewer reverted `everyValue()`'s `.flatMap`
   * back to whole-text and ALL FIVE tests in this block stayed green: that test
   * pinned the SCANNER, which was never at risk, while the call site — the one
   * `.flatMap` this is actually about — went unexercised. A fixture on both
   * ends proves the fixture.
   *
   * So this drives the REAL producer over the REAL dictionaries, three ways,
   * each of which fails on its own if the split is reverted:
   *   1. the scan must yield strictly MORE entries than there are values —
   *      equality is exactly what whole-text produces;
   *   2. every entry it yields must BE one sentence, and a violation names the
   *      locale, file and key that slipped through;
   *   3. one real, stable multi-sentence key must appear as several entries,
   *      so the rule is not satisfied by dictionaries that happen to be
   *      one-sentence throughout.
   */
  it("splits real dictionary values into sentences at the call site, not just in principle", () => {
    // Counted independently of `everyValue`, by re-reading the files: a count
    // derived from the thing under test would move with it and prove nothing.
    let rawValues = 0;
    for (const locale of DICTIONARY_LOCALES) {
      for (const file of DICT_FILES) {
        const parsed = JSON.parse(
          readFileSync(`src/dictionaries/${locale}/${file}.json`, "utf8"),
        ) as Record<string, unknown>;
        rawValues += Object.values(parsed).filter((v) => typeof v === "string").length;
      }
    }
    const scanned = everyValue();
    expect(rawValues, "the independent count resolved almost nothing").toBeGreaterThan(4000);
    expect(
      scanned.length,
      `the scan yielded ${scanned.length} entries for ${rawValues} values — that is whole-text, not sentences`,
    ).toBeGreaterThan(rawValues);

    // 2. Nothing the scan hands to the guard may be more than one sentence.
    const unsplit = scanned
      .filter(([, text]) => sentences(text).length > 1)
      .map(([id, text]) => `${id}: ${sentences(text).length} sentences — "${text.slice(0, 60)}…"`);
    expect(unsplit, unsplit.slice(0, 3).join(" | ")).toEqual([]);

    // 3. …and it is not vacuous: a real value that IS several sentences, in
    //    every locale, must arrive as several entries. `cookie.message` is the
    //    stable one — three sentences in en/es/fr/nl.
    for (const locale of DICTIONARY_LOCALES) {
      const id = `${locale}/common.json cookie.message`;
      expect(
        scanned.filter(([entryId]) => entryId === id).length,
        `${id} must arrive split, or this rule is satisfied by a one-sentence dictionary`,
      ).toBeGreaterThan(1);
    }

    // …and the reason the split is load-bearing, stated against the scanner
    // itself: whole-text, the affirmation excuses the paid sentence beside it.
    const twoClaims =
      "Every detail level is available on every plan. Ball-by-ball scoring is a Pro feature.";
    expect(scoringFreeClaimFaults([["whole", twoClaims]])).toEqual([]);
    expect(
      scoringFreeClaimFaults(sentences(twoClaims).map((part) => ["split", part] as const)),
    ).toHaveLength(1);
  });
});

// =============================================================================
// THE ANNUAL SAVING - a claim no single number could have made true
// =============================================================================
//
// `pricing.faq.annual.a` and `billing.annualSaves` both said "annual billing
// saves 30%", in all four locales, on two live surfaces: the /pricing FAQ and
// the emerald hint under the Go Pro buttons in Settings -> Billing. Eight
// shipped strings, one claim, and after the charm reprice it is wrong in every
// market -- 28.29% usd, 30.08% eur, 32.52% gbp, 30.45% inr on the base tier,
// and 23.71-30.35% on the extra-organisation rider.
//
// The defect is not the NUMBER, it is the SHAPE. The seed prices each market
// independently, so no single percentage can be right, and re-cutting 30% to
// 28% would put the next reprice straight back here. The copy now states a
// floor derived from the ladder -- "a year up front costs less than ten
// monthly payments in every currency we bill in, so annual is more than two
// months free" -- and this suite holds the copy and the seed together in both
// directions.
describe("the annual saving the copy promises is one the seed delivers", () => {
  const ANNUAL_CLAIM = { monthsFree: 2, staleBeyond: 5 };
  const ANNUAL_KEYS = [
    ["marketing", "pricing.faq.annual.a"],
    // NOT in the brief, and found by grepping the dictionaries for a percentage
    // beside an annual word rather than by trusting the one key that was named.
    // It renders live in `settings/billing/page.tsx`, under two buttons that
    // already print the real monthly and annual-per-month prices -- so it was
    // contradicting arithmetic on its own screen.
    ["ui", "billing.annualSaves"],
    // THE THIRD SURFACE, 2026-09-05. The Pro pricing card said "save 30%" in
    // hardcoded English, on every locale, while the FAQ two screens below it
    // already carried the corrected claim -- the product contradicting itself
    // on one page. It is in THIS list rather than in a rule of its own because
    // one fact deserves one wording: the floor, the vocabulary and the
    // percentage ban now judge all three surfaces together, so a re-cut moves
    // them together or reds.
    ["marketing", "pricing.pro.annualSaving"],
  ] as const;
  const ANNUAL_VALUES: LocalisedValue[] = ANNUAL_KEYS.flatMap(([file, key]) =>
    across(file, key),
  );

  it("costs at most ten monthly payments, every currency and BOTH tiers", () => {
    const points = annualPricePoints(stripePlans.plans as unknown as PricedPlan[]);
    expect(annualSavingFaults(points, ANNUAL_CLAIM)).toEqual([]);
  });

  // ANTI-VACUITY: the check above is a loop over a derived list, and an empty
  // one passes. Four currencies on two graduated tiers is eight points, and the
  // rider tier must actually be among them -- it is the rung that saves least,
  // so a sweep that lost it would call a claim safe on the strength of the
  // generous half alone.
  it("actually compared every price point, the rider rung included", () => {
    const points = annualPricePoints(stripePlans.plans as unknown as PricedPlan[]);
    expect(points.length, "the point sweep collapsed").toBeGreaterThanOrEqual(
      SEED_CURRENCIES.length * 2,
    );
    expect(new Set(points.map((p) => p.tier))).toEqual(new Set(["base", "rider"]));
    expect(new Set(points.map((p) => p.currency))).toEqual(new Set(SEED_CURRENCIES));
  });

  // ...and the bound is a real bound, not one the numbers satisfy whatever they
  // are. A claim of five months free must FAIL on today's ladder, or the check
  // above is decoration: the live spread is 2.8-3.9 months, so 2 passes and 5
  // must not.
  it("would reject a floor the ladder does not reach", () => {
    const points = annualPricePoints(stripePlans.plans as unknown as PricedPlan[]);
    const overclaimed = annualSavingFaults(points, { monthsFree: 5, staleBeyond: 9 });
    expect(overclaimed.length, "a five-month claim passed on a ladder that gives under four").toBeGreaterThan(0);
    expect(overclaimed.join(" ")).toContain("but the copy promises more than 5");
  });

  // The loose side, proven the same way: a floor of half a month is TRUE at
  // every point and still a claim that has stopped describing the product.
  it("would reject a floor that has gone stale in the customer's favour", () => {
    const points = annualPricePoints(stripePlans.plans as unknown as PricedPlan[]);
    const stale = annualSavingFaults(points, { monthsFree: 0.5, staleBeyond: 1 });
    expect(stale.join(" ")).toContain("has stopped describing the product");
  });

  it("says it in all four locales, numeral and unit and giveaway", () => {
    expect(ANNUAL_VALUES).toHaveLength(ANNUAL_KEYS.length * DICTIONARY_LOCALES.length);
    // The vocabulary itself must cover every locale, or a locale with no entry
    // is checked by nothing and the sweep reports clean on untranslated copy.
    expect(
      Object.keys(ANNUAL_SAVING_CLAIM).sort(),
      "the claim vocabulary does not cover every locale",
    ).toEqual([...DICTIONARY_LOCALES].sort());
    expect(annualClaimFaults(ANNUAL_VALUES)).toEqual([]);
  });

  // THE INVERSE, because a presence rule alone is satisfied by copy that also
  // carries the falsehood. A percentage is exactly what these eight strings
  // used to be, and a percentage cannot be right here for any value: the eight
  // price points do not share one.
  it("quotes no percentage on either surface, in any locale", () => {
    const withPercent = ANNUAL_VALUES.filter((v) => /\d\s*%/.test(v.value));
    expect(
      withPercent.map((v) => `${v.locale}/${v.key}: ${v.value}`),
      "a single percentage cannot be true across four independently priced markets",
    ).toEqual([]);
  });

  // Each PART of the claim is separately killable, or a three-way vocabulary is
  // really a one-way one wearing a costume: without these, dropping the unit
  // and the giveaway from `ANNUAL_SAVING_CLAIM` leaves this suite green,
  // because the percentage probes below fail on the numeral alone.
  it("names WHICH half of the sentence went missing", () => {
    const missing: Array<[string, LocalisedValue]> = [
      ["giveaway", { locale: "en", key: "probe", value: "Annual billing costs two months less." }],
      ["numeral", { locale: "en", key: "probe", value: "Annual billing gives you months free." }],
      ["unit", { locale: "en", key: "probe", value: "Annual billing gets you two free." }],
    ];
    for (const [part, value] of missing) {
      expect(annualClaimFaults([value]).join(" "), `${value.value} must fail on ${part}`).toContain(
        `states no ${part}`,
      );
    }
    // ...and the true sentence passes all three, so the probes above are
    // measuring the vocabulary rather than an always-fault.
    expect(
      annualClaimFaults([
        { locale: "en", key: "probe", value: "Paying yearly is more than two months free." },
      ]),
    ).toEqual([]);
  });

  // ...and it must not come back as a word, either. The negative above is
  // lexical; this one is the reason it exists.
  it("catches the percentage returning, spelled out or reworded", () => {
    const reworded: LocalisedValue[] = [
      { locale: "en", key: "probe", value: "Yes — annual billing saves 30%, and it's the default." },
      { locale: "en", key: "probe", value: "Save 28 % by paying for the year." },
    ];
    for (const v of reworded) {
      expect(annualClaimFaults([v]).length, `${v.value} must fail the claim`).toBeGreaterThan(0);
      expect(/\d\s*%/.test(v.value), `${v.value} must trip the percentage ban`).toBe(true);
    }
  });
});

// ── Key-set parity across the four locales ───────────────────────────────────
//
// WHY NOTHING CAUGHT `nav.dashboard` BEING ENGLISH-ONLY FOR SEVERAL WAVES.
// `lib/i18n-keys.ts` is GENERATED FROM `en` ALONE, so the drift check it feeds
// answers "does this key exist?" by looking at exactly one locale. A key added
// to `en` and forgotten in `es`/`fr`/`nl` is invisible to it — 438 keys in `en`
// against 437 in each of the others, on `main` as well as here, and every
// existing guard in this file reads VALUES for keys it already knows about.
//
// This asks the question none of them do: do the four locales hold the SAME
// keys, file for file? A missing key does not throw at runtime — `t()` falls
// back — so the symptom is an English word on a Spanish page, which only a
// person looking at that page in that language will ever notice.
describe("every locale carries the same keys, file for file", () => {
  const dictionaryFiles = readdirSync("src/dictionaries/en")
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();

  // Anti-vacuity: a glob that matched nothing, or a locale list of one, would
  // make every assertion below pass by examining nothing at all.
  it("has files and locales to compare", () => {
    expect(dictionaryFiles.length).toBeGreaterThan(3);
    expect(DICTIONARY_LOCALES.length).toBeGreaterThan(1);
    expect(DICTIONARY_LOCALES).toContain("en");
  });

  for (const file of dictionaryFiles) {
    it(`${file}.json holds one key set across every locale`, () => {
      const enKeys = Object.keys(load("en", file));
      const faults: string[] = [];
      for (const locale of DICTIONARY_LOCALES.filter((l) => l !== "en")) {
        const theirs = new Set(Object.keys(load(locale, file)));
        // Both directions. A key present only in a translation is just as much
        // a drift as one missing from it, and it is the shape a rename leaves
        // behind — the old key orphaned in three locales, the new one in `en`.
        const missing = enKeys.filter((k) => !theirs.has(k));
        const extra = [...theirs].filter((k) => !enKeys.includes(k)).sort();
        if (missing.length > 0) {
          faults.push(`${locale} is missing ${missing.length}: ${missing.slice(0, 6).join(", ")}`);
        }
        if (extra.length > 0) {
          faults.push(`${locale} has ${extra.length} key(s) en does not: ${extra.slice(0, 6).join(", ")}`);
        }
      }
      expect(faults, `${file}.json key drift:\n  ${faults.join("\n  ")}`).toEqual([]);
    });
  }
});

// Final review m-7 (capture QR v2 PR-2): the Seazn node's stalled word (owner ruling 2026-10-08) is the chain's OWN waiting
// word plus what it waits for — "Waiting" → "Waiting for video" — in every locale, so the node reads as a kind of the waiting
// it sits beside. nl once said "Wacht op video" (a finite verb) beside "Wachten" (the chain's infinitive). Derived from the
// sibling key, never a literal: a change to the waiting word moves the expectation with it.
// Final review I-1: each "won't start" line sends the organiser to the Go live button — so it names that button by its own
// label, in every locale (the expectation is the sibling key, never a literal).
describe("each 'automatic start won't run' line names the locale's own Go live button", () => {
  it("stream.auto.wontStart.* contains stream.phone.goLive, in every locale", () => {
    const REASONS = ["stopped", "already_started", "already_streamed"];
    let checked = 0;
    for (const { locale, value: goLive } of across("ui", "stream.phone.goLive")) {
      expect(goLive, `${locale}: PREMISE — the button has a label`).not.toBe("");
      for (const r of REASONS) {
        const line = load(locale, "ui")[`stream.auto.wontStart.${r}`] ?? "";
        expect(line, `${locale} ${r}: names "${goLive}"`).toContain(goLive);
        checked++;
      }
    }
    expect(checked).toBe(REASONS.length * DICTIONARY_LOCALES.length);
  });
});

describe("the chain's 'Waiting for video' extends its own waiting word, in every locale", () => {
  it("stream.chain.word.waitingVideo starts with stream.chain.word.waiting and a space", () => {
    let checked = 0;
    for (const { locale, value: waiting } of across("ui", "stream.chain.word.waiting")) {
      const video = load(locale, "ui")["stream.chain.word.waitingVideo"] ?? "";
      expect(waiting, `${locale}: PREMISE — the waiting word exists`).not.toBe("");
      expect(video.startsWith(`${waiting} `), `${locale}: "${video}" extends "${waiting}"`).toBe(true);
      expect(video.length, `${locale}: it says what it waits for`).toBeGreaterThan(waiting.length + 1);
      checked++;
    }
    expect(checked).toBe(DICTIONARY_LOCALES.length);
  });
});
