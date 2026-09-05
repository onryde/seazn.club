// THE APPROVED WORDING of the four-locale dictionary strings that make claims
// about the Event Pass and the extra-organisation rate.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// Sibling of _approved-copy.ts, which does the same job for the help articles,
// and it exists for the same measured reason.
//
// Every rule in dictionary-copy-truth reads the sentence and decides whether it
// is false. Four independent measurements in this wave say that shape scores on
// the examples its author imagined and collapses on anyone else's:
//
//   task 3: 12/12 on its own tuned set, 6/30 on a fresh set by the same author
//   task 4: 16/16 on its own rewordings, 0/32 on an adversarial set
//   task 4 round 2: still 0/9 on the reviewer's percentage-shaped rate clauses
//
// And the falsehood that survived TWO rounds of vocabulary widening was not
// exotic at all — pricing.faq.groups.a said "half your plan's rate", bare, in
// all four locales, three cards from the answer that had just been corrected to
// "no more than half". The pattern for it EXISTED (en.halfClaim spells that
// phrase out); nothing ever pointed the rule at that key.
//
// This file is the positive half. It does not generalise, so there is no
// phrasing that evades it, and it does not depend on anyone remembering to
// write a pattern for a claim family: the string either is the approved string
// or it is not.
//
// ── IF A TEST SENT YOU HERE ──────────────────────────────────────────────────
// The test is a GATE, not a bug. You changed one of these strings, and the
// change needs one deliberate step before it ships:
//
//   1. Read your new wording against the code it describes — the source of
//      truth is named in each entry's `why`, and it is a file path, not a
//      memory.
//   2. Paste the failing test's "on disk:" string into that entry's `text`.
//   3. Say in the commit message what changed and what you checked it against.
//
// Because all four locales sit side by side, a translation that drifts from the
// English is visible here as a diff rather than invisible in another file.
import type { DictionaryLocale } from "@/lib/copy-truth";

export interface ApprovedValue {
  /** Which dictionary file the key lives in. */
  file: "marketing" | "ui";
  /** Flat dotted key. Dictionaries are FLAT JSON — never nested. */
  key: string;
  /** What the string claims, and the code that decides whether it is true. */
  why: string;
  /** The approved wording, per locale. */
  text: Record<DictionaryLocale, string>;
}

export const APPROVED_DICTIONARY_COPY: ApprovedValue[] = [
  {
    file: "marketing",
    key: "pricing.pass.note",
    why: "the pass's DURATION, on the public pricing card. It said 'Yours for the event's lifetime' until this wave. Source of truth: V328/V334 (org_has_feature's pass arm drops out once the competition is archived/completed or 7 days past ends_on) and lib/entitlements.ts isPassLocked.",
    text: {
      en: "One-time. No subscription. Yours while the competition is running.",
      es: "Pago único. Sin suscripción. Tuyo mientras la competición está en curso.",
      fr: "Ponctuel. Sans abonnement. À vous tant que la compétition est en cours.",
      nl: "Eenmalig. Geen abonnement. Van jou zolang de competitie loopt.",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.crossover",
    why: "which of the two offers is cheaper, and the volume of entry fees at which that flips. Every figure is interpolated live — the two prices from config/stripe-plans.json via lib/currency's passPrice/proPrice, both rates from registration.fee_percent in plan_entitlements (V397: pass 4, pro 2), and the crossing itself from lib/pricing-crossover.ts's feeCrossoverMinor. So the NUMBERS cannot rot; the WORDS decide which side of the threshold each offer is on, and a reword that swaps them sells the one-time sku to the organisers the recurring one is cheaper for. Suppressed entirely when a rate is unreadable or the ladder stops crossing, so this sentence never appears without both rates behind it. THE DURATION CLAUSE IS LOAD-BEARING and was missing for a wave: feeCrossoverMinor solves a one-time pass against ONE MONTH of Pro, so the threshold is only the answer for a competition of about that length. Read without it the line recommended Pro to a three-month event at $300/mo of entry fees — $62.97 on Pro against $47.99 on the pass — i.e. it was wrong for exactly the long seasons it matters most to. The page has no duration input and must not invent one; the sentence states its own assumption instead, and pricing-crossover.test.ts scans all four locales for a competition tied to a month in one clause. IT ALSO NAMES ITS RUNG, and did not for a wave: the figure is solved for ONE rung (`lowestPricedRung` over SELLABLE_PASS_KEYS — the entry rung, which the in-app picker pre-selects; it read PASS_KEYS until the L rung came off sale on 2026-09-05, and reading the sellable list is what stops a crossing ever being solved for a rung the checkout would refuse) while the card sells BOTH, and “this is the cheaper option” was therefore printed beside an L rung it is false of. L at 4499 is dearer than a month of Pro at 1499 AND dearer per pound, so the two never cross at any volume and `feeCrossoverMinor` returns null for that shape — the suppression rule was already right, the sentence's SCOPE was not. `{rung}` and `{pass}` are interpolated from the same rung the number came from, so the claim and its subject cannot drift apart; pricing-crossover.test.ts scans all four locales for both tokens and pricing-page.test.tsx reads the rendered paragraph.",
    text: {
      en: "On a competition running about a month, the {rung} pass ({pass}) is the cheaper option up to about {amount} of entry fees; above that it is Pro at {pro}/mo — a {proFee}% platform fee against {passFee}%. The pass is one-time, so a longer competition puts that threshold higher.",
      es: "En una competición de aproximadamente un mes, el pase {rung} ({pass}) es la opción más barata hasta unos {amount} de cuotas de inscripción; por encima de eso lo es Pro a {pro}/mes: una comisión de plataforma del {proFee}% frente al {passFee}%. El pase es de pago único, así que una competición más larga sitúa ese umbral más alto.",
      fr: "Sur une compétition d’environ un mois, le pass {rung} ({pass}) est l’option la moins chère jusqu’à environ {amount} de frais d’inscription ; au-delà, c’est Pro à {pro}/mois — {proFee} % de frais de plateforme contre {passFee} %. Le pass est ponctuel : une compétition plus longue place ce seuil plus haut.",
      nl: "Bij een competitie van ongeveer een maand is de {rung}-pass ({pass}) de goedkoopste keuze tot ongeveer {amount} aan inschrijfgelden; daarboven is dat Pro voor {pro}/mnd — {proFee}% platformkosten tegen {passFee}%. De pass is eenmalig, dus bij een langere competitie ligt die grens hoger.",
    },
  },
  {
    file: "marketing",
    key: "pricing.faq.eventPass.a",
    why: "what the pass buys, for how long, and the size of the one-time credit grant. REWRITTEN 2026-09-05 (owner decision: the L rung comes off sale): the answer described two sizes and told the reader to 'pick the size at checkout', and there is one size on sale, so both halves were describing a purchase that cannot be made. It now describes the rung a buyer can actually reach. Every figure re-read against the code before this text was pinned: caps from plan_entitlements (event_pass = 10 divisions, 128 entrants per division), the grant from PASS_CREDIT_GRANT.event_pass in lib/pricing-cards.ts (25), the 4% / 5% fee pair from registration.fee_percent on event_pass and on community (V397), the duration from V328/V334. Pinned per locale by 'the Event Pass answer quotes the live caps of every rung on sale' in dictionary-copy-truth, which reads SELLABLE_PASS_KEYS and additionally forbids the HIDDEN rung's numbers appearing here — the L rung said 'no entrant limit at all' in all four locales for a whole wave after V392 gave it a real 512-entrant cap, so no rule anywhere lets a cap go back to a word. The rung's own matrix is still checked (pricing-matrix.test.ts, entitlements-sql-parity.test.ts): dormant, not deleted.",
    text: {
      en: "One competition, for as long as it’s running. The pass ({pass}) gives that competition 10 divisions and 128 entrants per division. You also get advanced formats, exports and realtime, a one-time AI credit top-up (+25 AI credits), and a 4% platform fee on its entry fees instead of Community’s 5% — and it stops counting against your free active-competition slot. A competition holds one pass and keeps it. Your club logo and card entry fees work on every plan already, pass or no pass. Other competitions in your org stay on Community limits.",
      es: "Una competición, mientras está en curso. El pase ({pass}) le da a esa competición 10 divisiones y 128 participantes por división. Además obtienes formatos avanzados, exportaciones y tiempo real, una recarga de créditos de IA de una sola vez (+25 créditos de IA), y una comisión de plataforma del 4% sobre sus cuotas de inscripción en lugar del 5% de Community — y deja de contar en tu cupo gratuito de competiciones activas. Una competición tiene un solo pase y lo conserva. El logotipo de tu club y las cuotas con tarjeta ya funcionan en todos los planes, con pase o sin él. Otras competiciones de tu organización se mantienen con los límites de Community.",
      fr: "Une compétition, tant qu’elle est en cours. Le pass ({pass}) donne à cette compétition 10 divisions et 128 participants par division. Vous bénéficiez aussi des formats avancés, des exports et du temps réel, d’une recharge ponctuelle de crédits IA (+25 crédits IA), ainsi que de 4 % de frais de plateforme sur ses frais d’inscription au lieu des 5 % de Communauté — et elle cesse de compter dans votre quota gratuit de compétition active. Une compétition détient un seul pass et le conserve. Le logo de votre club et les frais d’inscription par carte fonctionnent déjà sur tous les forfaits, avec ou sans pass. Les autres compétitions de votre organisation restent soumises aux limites Communauté.",
      nl: "Één competitie, zolang ze loopt. De pass ({pass}) geeft die competitie 10 divisies en 128 deelnemers per divisie. Je krijgt ook geavanceerde formats, exports en realtime, een eenmalige AI-creditbijboeking (+25 AI-credits), plus 4% platformkosten op de inschrijfgelden in plaats van de 5% van Community — en telt de competitie niet meer mee voor je gratis actieve-competitieplek. Een competitie heeft één pass en houdt die. Het logo van je club en inschrijfgelden per kaart werken al bij elk abonnement, met of zonder pass. Andere competities in je organisatie blijven op de Community-limieten.",
    },
  },
  {
    file: "marketing",
    key: "pricing.faq.upgraded.a",
    why: "what happens to a pass when the org is on Pro and when Pro is cancelled. Source of truth: V344 org_has_feature — since #327/#337 the pass arm applies under ANY plan and only ever grants, and lib/entitlements.ts overlays the two matrices as the BETTER of each axis (lib/pass-vs-plan.ts). So 'the pass sits dormant', which V338's community-only arm made true, is now false: an L holder who subscribes to Pro keeps L's 512-entrant cap against Pro's 256 (V392 capped the rung; it had been unlimited) AND gains Pro's uncapped divisions. The canceled arm still resolves 'community', and pass rows are deleted only on refund/dispute (usecases/billing-events.ts, lib/billing.ts), never on a plan change.",
    text: {
      en: "While you're on Pro, Pro's limits apply across the whole organisation — and on the competition you passed, the two are read together: whichever limit is higher wins, so nothing the pass bought is taken back. If you ever cancel Pro the pass carries that competition on its own, for as long as it is still running — a pass is tied to the competition it was bought for and stops with it.",
      es: "Mientras estés en Pro se aplican los límites de Pro en toda la organización — y en la competición con pase se leen los dos juntos: gana el límite más alto, así que no se pierde nada de lo que compraste. Si alguna vez cancelas Pro, el pase sostiene esa competición por sí solo mientras siga en curso: un pase está ligado a la competición para la que se compró y termina con ella.",
      fr: "Tant que vous êtes en Pro, les limites de Pro s'appliquent à toute l'organisation — et sur la compétition dotée d'un pass, les deux sont lues ensemble : la limite la plus élevée l'emporte, donc rien de ce que le pass a acheté n'est repris. Si vous annulez Pro, le pass porte seul cette compétition tant qu'elle est en cours : un pass est lié à la compétition pour laquelle il a été acheté et s'arrête avec elle.",
      nl: "Zolang je Pro hebt gelden de limieten van Pro voor de hele organisatie — en op de competitie met pass worden de twee samen gelezen: de hoogste limiet wint, dus niets van wat de pass kocht wordt teruggenomen. Zeg je Pro op, dan draagt de pass die competitie alleen, zolang ze nog loopt: een pass hoort bij de competitie waarvoor hij gekocht is en stopt daarmee.",
    },
  },
  {
    file: "marketing",
    key: "pricing.faq.groups.a",
    why: "the extra-organisation rate, and the entry-fee rate a Community org drops to on joining. 'half your plan's rate' unqualified is false — the seed FLOORS the rider to the charm grid (usd pro monthly 1499 -> 699 = 46.6%), so only 'no more than half' is true in every plan x interval x currency combination. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape. The 5% -> 2% clause is registration.fee_percent in plan_entitlements, re-cut by V397 (it read 8% -> 2%).",
    text: {
      en: "Yes. A subscription is a billing group: it can hold several organisations under one card and one invoice, and each organisation after the first costs no more than half your plan’s rate. Every organisation in the group runs on the group’s plan, so joining a Pro group takes an organisation’s entry-fee rate from 5% to 2%. Payouts are untouched — each organisation keeps its own Stripe account and its own bank details.",
      es: "Sí. Una suscripción es un grupo de facturación: puede incluir varias organizaciones con una sola tarjeta y una sola factura, y cada organización a partir de la primera cuesta no más de la mitad de la tarifa de tu plan. Todas las organizaciones del grupo funcionan con el plan del grupo, así que unirse a un grupo Pro baja la comisión de inscripción de una organización del 5% al 2%. Los pagos no cambian: cada organización conserva su propia cuenta de Stripe y sus propios datos bancarios.",
      fr: "Oui. Un abonnement est un groupe de facturation : il peut réunir plusieurs organisations sous une seule carte et une seule facture, et chaque organisation après la première coûte au plus la moitié du tarif de votre forfait. Toutes les organisations du groupe fonctionnent avec le forfait du groupe : rejoindre un groupe Pro fait passer les frais d’inscription d’une organisation de 5 % à 2 %. Les reversements ne changent pas : chaque organisation conserve son propre compte Stripe et ses propres coordonnées bancaires.",
      nl: "Ja. Een abonnement is een facturatiegroep: het kan meerdere organisaties omvatten met één kaart en één factuur, en elke organisatie na de eerste kost hoogstens de helft van het tarief van je abonnement. Elke organisatie in de groep draait op het abonnement van de groep, dus toetreden tot een Pro-groep brengt het inschrijfkostenpercentage van een organisatie van 5% naar 2%. Uitbetalingen veranderen niet: elke organisatie houdt haar eigen Stripe-account en haar eigen bankgegevens.",
    },
  },
  // ── The Pro Plus CARD (v17 gap wave 7, #299) ───────────────────────────────
  //
  // `pricing.faq.proPlus.a` was the ANSWER three cards down the page; it is
  // deleted with the plan (retired-plan copy sweep, V392). These
  // six keys are the CARD itself — the frame plus its five bullets — and until
  // this task they were the only Pro Plus surface nothing pinned. The result was
  // a page that disagreed with itself: the FAQ had dropped "AI-assisted
  // scheduling" as a differentiator while the card two screens above still sold
  // it. Pinned as its own claim family, the way the pass-permanence and
  // half-rate families already are.
  //
  // The frame is pinned WITH the bullets deliberately: "Everything in Pro,
  // plus…" is what makes each bullet an assertion of exclusivity, so a reword
  // that drops it would leave the differentiator rules with nothing to scope to.
  {
    file: "marketing",
    key: "pricing.plus.note",
    why: "the frame the five Pro Plus card bullets are read under. It is what turns each bullet into a claim of EXCLUSIVITY, so dropping it silently changes what f1-f5 mean. Source of truth: app/[lang]/(marketing)/pricing/page.tsx renders it directly above the f1-f5 list.",
    text: {
      en: "Everything in Pro, plus…",
      es: "Todo lo de Pro, más…",
      fr: "Tout ce qu'offre Pro, plus…",
      nl: "Alles van Pro, plus…",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f1",
    why: "unlimited members, teams and clubs. Source of truth: plan_entitlements members.max / teams.max / clubs.max — all null (unlimited) on pro_plus, and capped on pro (15 / 40 / 20), so the claim is both true and a genuine differentiator.",
    text: {
      en: "Unlimited members, teams & clubs",
      es: "Miembros, equipos y clubes ilimitados",
      fr: "Membres, équipes et clubs illimités",
      nl: "Onbeperkt aantal leden, teams & clubs",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f2",
    why: "the entry-fee platform rate on Pro Plus. Source of truth: plan_entitlements registration.fee_percent — 1 on pro_plus against 2 on pro and 8 on community.",
    text: {
      en: "1% platform fee on entry fees",
      es: "Comisión de plataforma del 1% en las cuotas de inscripción",
      fr: "Frais de plateforme de 1 % sur les frais d'inscription",
      nl: "1% platformkosten op inschrijfgelden",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f3",
    why: "THE BULLET THIS TASK FIXED. It read 'AI-assisted scheduling' (four locales) under the 'Everything in Pro, plus…' frame while plan_entitlements grants scheduling.ai on ALL FIVE plan keys — community, event_pass, event_pass_l, pro and pro_plus — so it differentiated nothing. The replacement is the one AI claim the matrix does back: ai.credits.monthly is 10 / 60 / 200, so pro_plus really does carry the largest monthly grant. It is a COMPARATIVE, judged by localeCreditLeadershipFaults against those numbers, not by a boolean grant. Its English mirror, PLUS_CARD_FEATURES[2] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18): V392 removed `pro_plus` from `plans` outright, so the comparative now reads over community 5 / pro 25 / enterprise 500 and enterprise is a Contact-us strip rather than a priced card. Nothing renders this key; pruning the locale trees is W3's.",
    text: {
      en: "Largest monthly AI credit grant",
      es: "Mayor dotación mensual de créditos de IA",
      fr: "La plus grosse dotation mensuelle de crédits IA",
      nl: "Grootste maandelijkse AI-credittegoed",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f4",
    why: "automatic officials assignment. Source of truth: plan_entitlements officials.auto — false on community and pro, true on pro_plus, so it is a real differentiator under the frame.",
    text: {
      en: "Auto officials assignment",
      es: "Asignación automática de árbitros",
      fr: "Attribution automatique des officiels",
      nl: "Automatische toewijzing van officials",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.f5",
    why: "write-scoped API keys and priority support. Source of truth: plan_entitlements api.write and support.priority — both false on community and pro, true on pro_plus. (api.access is granted on pro, so the WRITE qualifier is load-bearing and must not be dropped in translation. There is no `api.read` key — it appeared in this note for two rounds and exists nowhere in the migrations or the source.)",
    text: {
      en: "Write API access & priority support",
      es: "Acceso de escritura a la API y soporte prioritario",
      fr: "Accès API en écriture et assistance prioritaire",
      nl: "Schrijftoegang tot de API & prioritaire ondersteuning",
    },
  },
  {
    file: "ui",
    key: "upgrade.intro",
    why: "the in-app Event Pass purchase page, read immediately before paying (/o/[orgSlug]/c/[compSlug]/upgrade). Same duration claim as pricing.pass.note. Source of truth: V328/V334.",
    text: {
      en: "One payment upgrades this competition while it’s running — no subscription, and it stays in place even if you never go Pro.",
      es: "Un solo pago mejora esta competición mientras está en curso — sin suscripción, y se mantiene aunque nunca pases a Pro.",
      fr: "Un seul paiement améliore cette compétition tant qu’elle est en cours — pas d’abonnement, et cela reste en place même si vous ne passez jamais à Pro.",
      nl: "Eén betaling upgradet deze competitie zolang ze loopt — geen abonnement, en dat blijft zo, ook als je nooit Pro neemt.",
    },
  },
  {
    file: "ui",
    key: "upgrade.active.body",
    why: "the same page once the pass is held. Source of truth: V328/V334.",
    text: {
      en: "This competition is upgraded while it’s running — divisions, entrants, formats, fees, branding and exports are all unlocked here.",
      es: "Esta competición está mejorada mientras está en curso — divisiones, participantes, formatos, cuotas, personalización y exportaciones están todos desbloqueados aquí.",
      fr: "Cette compétition est améliorée tant qu’elle est en cours — divisions, participants, formats, frais, image de marque et exports sont tous débloqués ici.",
      nl: "Deze competitie is geüpgraded zolang ze loopt — divisies, deelnemers, formats, kosten, branding en exports zijn hier allemaal ontgrendeld.",
    },
  },
  {
    file: "ui",
    key: "billing.passOffer.note",
    why: "the Settings -> Billing offer card (components/billing-pass-offer.tsx). Two claims: the pass's duration (V328/V334) and that a passed competition stops counting against competitions.max_active — the latter is TRUE, enforced by `not exists (select 1 from competition_passes ...)` in usecases/competitions.ts and usecases/entitlement-freeze.ts.",
    text: {
      en: "From {price} once, upgrade a single competition while it’s running — and a competition with a pass stops counting against your active-competition limit.",
      es: "Desde {price} una sola vez, mejora una única competición mientras está en curso: y una competición con pase deja de contar para tu límite de competiciones activas.",
      fr: "À partir de {price} en une fois, améliorez une seule compétition tant qu’elle est en cours — et une compétition avec un pass cesse de compter dans votre limite de compétitions actives.",
      nl: "Vanaf {price} eenmalig upgrade je één competitie zolang ze loopt — en een competitie met een pass telt niet meer mee voor je limiet van actieve competities.",
    },
  },
  {
    file: "marketing",
    key: "pricing.final.subhead",
    why: "the closing CTA under the cards, and it makes three claims at once: that signing up needs no card, that a SINGLE EVENT can be upgraded (the Event Pass, competition-scoped per V328/V334), and that the whole club can be upgraded instead (Pro/Pro Plus, org-scoped). Found by PRICING_KEY_DISPOSITION, which is the point of that rule — nobody had noticed this string made a claim at all. NO-CARD source of truth: there is no `customers.create` call anywhere in non-test source (only createTaxId / createBalanceTransaction / customers.update / customers.retrieve), so nothing mints a Stripe customer on sign-up; the customer id arrives on the subscription/session at checkout (lib/billing.ts). Rounds 4-5 cited a usecases/orgs module for this; no such file has ever existed in this repo, so that citation sent every reader nowhere.",
    text: {
      en: "No card required. Upgrade a single event, or the whole club, when it grows.",
      es: "Sin tarjeta. Mejora un solo evento, o todo el club, cuando crezca.",
      fr: "Aucune carte requise. Améliorez un seul événement, ou tout le club, lorsqu'il grandit.",
      nl: "Geen kaart nodig. Upgrade één evenement of de hele club wanneer die groeit.",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.included",
    why: "the Event Pass column when a PAID org views it (pass-cta.ts `included`). It said \"Your plan already includes everything here\", which asserts Pro superset-of-pass — the same claim #337 records as INTENDED BUT NOT TRUE TODAY: entrants.per_division.max is null (unlimited) on event_pass_l against 256 on pro, so an L pass really would lift a Pro org’s entrant cap. pricing.faq.upgraded.a was already rewritten in this wave to assert neither; this string was the last surface still asserting it, and PRICING_KEY_DISPOSITION exempted it as a button label whose stated reason was “they identify a card, they do not describe what it grants”. Replaced with the reason that IS true and resolver-backed: V338 org_has_feature requires the resolved plan to be ‘community’ for the pass arm to apply, so a pass held by a paid org sits dormant — the same wording pricing.faq.upgraded.a uses.",
    text: {
      en: "Your plan applies across the whole organisation, so a pass would sit dormant.",
      es: "Tu plan se aplica a toda la organización, así que un pase quedaría inactivo.",
      fr: "Votre formule s’applique à toute l’organisation : un pass resterait en veille.",
      nl: "Je abonnement geldt voor de hele organisatie, dus een pass zou slapend blijven.",
    },
  },
  // ── Every /pricing string that quotes MONEY or an ALLOWANCE (fix round 1) ──
  //
  // Added after a fresh probe set — written once the card rules were final —
  // found two of this class open and invisible: `pricing.plus.per` flipped from
  // "/month" to "/year" beside a monthly figure, and the Pro Plus credit chip
  // re-sold a monthly allowance as a one-time top-up. Both are one-word edits,
  // both make a money claim false, and neither touched a card array.
  //
  // Most of these interpolate their NUMBER from the matrix or the seed, which is
  // exactly why the words around it need pinning: the figure stays right while
  // the sentence stops meaning what it meant. `PRICING_KEY_DISPOSITION` in
  // dictionary-copy-truth.test.ts now makes every `pricing.*` key either pinned
  // here or exempt with a reason, so this list cannot quietly stop growing.
  {
    file: "marketing",
    key: "pricing.credits.perMonth",
    why: "the Community and Pro credit chips. The COUNT is interpolated live from ai.credits.monthly, so the pin guards the CADENCE around it — \"/ month\" is the claim, and re-wording it to a one-time top-up (or vice versa) makes the chip false while the number stays right. Source of truth: plan_entitlements ai.credits.monthly, rendered by pricing/page.tsx.",
    text: {
      en: "{count} AI credits / month",
      es: "{count} créditos de IA / mes",
      fr: "{count} crédits IA / mois",
      nl: "{count} AI-credits / maand",
    },
  },
  {
    file: "marketing",
    key: "pricing.credits.passGrant",
    why: "the Event Pass credit chip. The pass has NO ai.credits.monthly row — the grant is the one-time PASS_CREDIT_GRANT in lib/pricing-cards.ts — so \"one-time\" is the load-bearing word and a recurring re-wording is the exact inverse claim RECURRING_GRANT_PATTERNS exists for. Entitlements v18 W2 T5 sized it BY RUNG and the chip named both, because the card sold both. REWRITTEN 2026-09-05 (owner decision: the L rung off sale): it names the grant of the rung actually being offered, interpolated from PASS_CREDIT_GRANT indexed by the cheapest SELLABLE rung — the same rung the headline price above it quotes, so the two figures on this card are about one product. The single-{count} shape is the one this chip carried BEFORE the ladder, and the defect that ended it (M's 25 printed beside L's price) cannot recur while the price and the grant are read from the same key; pricing/page.tsx derives both from `offeredRung`. It still renders unconditionally while the ladder above it is suppressed whenever loadMatrix fails soft, so it is the one credit figure a buyer is guaranteed to see.",
    text: {
      en: "+{count} AI credits, one-time",
      es: "+{count} créditos de IA, una sola vez",
      fr: "+{count} crédits IA, une seule fois",
      nl: "+{count} AI-credits, eenmalig",
    },
  },
  {
    file: "marketing",
    key: "pricing.credits.perMonthOperator",
    why: "the Pro Plus credit chip. Same cadence claim as pricing.credits.perMonth, plus \"operator wallet\" (SPEC-2 §11: the wallet is org-scoped and shared across a billing group). Measured as a gap — re-selling this monthly allowance as a one-time top-up was invisible to every rule.",
    text: {
      en: "{count} AI credits / month · operator wallet",
      es: "{count} créditos de IA / mes · monedero de operador",
      fr: "{count} crédits IA / mois · portefeuille opérateur",
      nl: "{count} AI-credits / maand · operator-portemonnee",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.per",
    why: "the billing period beside Pro Plus’s headline price. pricing/page.tsx renders the MONTHLY amount here (plusMonthly), so \"/month\" is a claim about what the number means; \"/year\" beside a monthly figure understates the price by 12x. Source of truth: config/stripe-plans.json seazn_pro_plus_monthly.",
    text: {
      en: "/month",
      es: "/mes",
      fr: "/mois",
      nl: "/maand",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.per",
    why: "the unit beside the Event Pass price. The pass is bought per COMPETITION, once (V328/V334, and lib/billing.ts:884 is the ONLY non-test `insert into competition_passes` — one row per competition) — not per month and not per org. Rounds 4-5 cited a usecases/competition-passes module; no such file has ever existed in this repo.",
    text: {
      en: " / event",
      es: " / evento",
      fr: " / événement",
      nl: " / evenement",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.from",
    why: "the qualifier marking the pass price as a FLOOR. v17 #294 put two rungs on sale, so the quoted figure is the cheapest of two; ticketTiers sets this prefix and pricing-cards.test.ts asserts only the pass carries it. Dropping the word states M’s price as the product’s.",
    text: {
      en: "from",
      es: "desde",
      fr: "à partir de",
      nl: "vanaf",
    },
  },
  {
    file: "marketing",
    key: "pricing.community.price",
    why: "Community’s headline price. It is genuinely free — no plans row, no Stripe price, and config/stripe-plans.json has no community product — so this is the one card where a price word is a claim about the absence of a charge.",
    text: {
      en: "Free",
      es: "Gratis",
      fr: "Gratuit",
      nl: "Gratis",
    },
  },
  {
    file: "marketing",
    key: "pricing.addons.credits",
    why: "the credit-pack add-on line. FIX ROUND 2: this hardcoded \"$10\" in all four locales and rendered statically, while every other price on /pricing goes through formatMinor(…, currency) behind the CurrencySwitcher — and config/stripe-plans.json `packs` prices the cheapest pack at eur 900 / gbp 800 / aud 1500 / inr 79900, so the literal was false in FOUR of the five supported currencies (#191's defect). The amount is now interpolated as {price} from lib/currency.ts lowestCreditPackAmount(), so what is pinned here is the WORDING around it: \"from\" is load-bearing because larger packs cost more. Packs never expire (D2), which is why no duration qualifier belongs here. NOTE the previous version of this note asserted the claim was true and named `credit_packs`, an identifier that does not exist — the JSON key is `packs`.",
    text: {
      en: "AI credits from {price}",
      es: "Créditos de IA desde {price}",
      fr: "Crédits IA à partir de {price}",
      nl: "AI-credits vanaf {price}",
    },
  },
  {
    file: "marketing",
    key: "pricing.addons.org",
    why: "the extra-organisation add-on label. Its RATE is the “no more than half the base rate” claim pinned on pricing.faq.groups.a and verified against the seed’s graduated tiers by riderClaimShape.",
    text: {
      en: "Extra org",
      es: "Organización adicional",
      fr: "Organisation supplémentaire",
      nl: "Extra organisatie",
    },
  },
  {
    file: "marketing",
    key: "pricing.addons.sizePack",
    why: "the size-pack add-on label. Raises the entrant limit by a fixed delta (config/stripe-plans.json, +32 each) and is a ONE-OFF, not a subscription — the seed price carries no interval, which task 7’s guard asserts.",
    text: {
      en: "Size pack",
      es: "Paquete de tamaño",
      fr: "Pack de taille",
      nl: "Size-pack",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.ladder.caps",
    why: "the M rung’s caps in the ladder list. Both numbers are interpolated live from plan_entitlements (divisions.per_competition.max / entrants.per_division.max on event_pass), so the pin guards the words around them — “Up to” is what makes them ceilings rather than allocations.",
    text: {
      en: "Up to {divisions} divisions, {entrants} entrants each",
      es: "Hasta {divisions} divisiones, {entrants} participantes cada una",
      fr: "Jusqu’à {divisions} divisions, {entrants} participants chacune",
      nl: "Tot {divisions} divisies, {entrants} deelnemers per divisie",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.ladder.capsUnlimited",
    why: "the L rung’s caps. entrants.per_division.max is NULL on event_pass_l, so this variant must SAY unlimited rather than print a number — quoting M’s 128 here is the exact defect v17 #294 was filed for.",
    text: {
      en: "Up to {divisions} divisions, unlimited entrants",
      es: "Hasta {divisions} divisiones, participantes ilimitados",
      fr: "Jusqu’à {divisions} divisions, participants illimités",
      nl: "Tot {divisions} divisies, onbeperkt deelnemers",
    },
  },
  // ── THE IN-APP COMPARISON PANEL (fix round 4) ─────────────────────────────
  //
  // `billing.community.f1-f7` and `billing.pro.f1-f7`, rendered in Settings →
  // Billing. Added because round 3 argued that polarity-against-the-matrix was
  // "strictly stronger" than a pin, and that was MEASURABLY FALSE: polarity
  // checks the hand-written key→feature mapping and NEVER READS THE STRING, so
  // restoring the original defect verbatim — f5 "Entry fees (Stripe payouts)"
  // under a ✗ — shipped 109/109 green. Measured rate on copy mutations: 2/11.
  //
  // The two are COMPLEMENTS, not substitutes. Polarity fails when the MATRIX
  // moves under fixed copy; the pin fails when the COPY moves under a fixed
  // matrix. Neither sees the other's defect.
  {
    file: "ui",
    key: "billing.community.f1",
    why: "Community’s active-competition cap, in the in-app Settings → Billing panel (rendered with a ✓). Source of truth: plan_entitlements competitions.max_active on community. Pinned numerically against that row by pricing-cards.test.ts. W2 (entitlements v18, V392) re-cut the cap 10 -> 3; the panel and the public Community card both said 10, overselling the free tier threefold in four languages.",
    text: {
      en: "3 active competitions",
      es: "3 competiciones activas",
      fr: "3 compétitions actives",
      nl: "3 actieve competities",
    },
  },
  {
    file: "ui",
    key: "billing.community.f2",
    why: "Community’s division and entrant caps, same panel, ✓ row. Source of truth: plan_entitlements divisions.per_competition.max and entrants.per_division.max on community. Both digits are asserted against those rows, as WHOLE TOKENS, in all four locales — but only since fix round 5: the divisions digit was asserted by nothing while this sentence already claimed it was, and the entrants digit used toContain, which passed “640 entrants” for a cap of 64. If you are re-approving this row, the check behind it is pricing-cards.test.ts ‘billing.community.f1/f2 carry the live caps’.",
    text: {
      en: "4 divisions, 64 entrants each",
      es: "4 divisiones, 64 participantes cada una",
      fr: "4 divisions, 64 participants chacune",
      nl: "4 divisies, elk 64 deelnemers",
    },
  },
  {
    file: "ui",
    key: "billing.community.f3",
    why: "Community’s public-dashboard cap, ✓ row. Source of truth: plan_entitlements dashboard.public.max on community. The number is asserted as a whole token, not a substring — a `toContain(\"1\")` would have passed “10 public dashboards”. W2: the cap has been 3 (V392) and is now 2 (V395), and this row said 1 through all three values — the plural changes with it in every language. The tightening to 2 is only honest because the same wave stopped `assertPublicQuota` counting finished and passed competitions, so the cap meters live surfaces rather than history.",
    text: {
      en: "2 public dashboards",
      es: "2 paneles públicos",
      fr: "2 tableaux de bord publics",
      nl: "2 openbare dashboards",
    },
  },
  {
    file: "ui",
    key: "billing.community.f4",
    why: "that Community can take online registrations AND card entry fees, ✓ row, at the 5% platform cut. Source of truth: plan_entitlements registration.enabled / registration.paid (both true on community) and registration.fee_percent (5 since V397, which re-cut the whole ladder to 5/4/2/1 for the additive fee model; it was 8). THIS ROW WAS FALSE until fix round 3: it read “Free-event registration”, the exact framing pricing-cards.ts records the public card being corrected away from, while f5 separately denied entry fees outright.",
    text: {
      en: "Online registration & entry fees (5%)",
      es: "Inscripción online y cuotas de inscripción (5%)",
      fr: "Inscription en ligne et frais d’inscription (5 %)",
      nl: "Online inschrijving & inschrijfgelden (5%)",
    },
  },
  {
    file: "ui",
    key: "billing.community.f5",
    why: "what Community does NOT get — rendered with a ✗. Source of truth: plan_entitlements exports.branded and dashboard.player_profiles, both false on community. THIS ROW WAS FALSE until fix round 3: it read “Entry fees (Stripe payouts)” with a ✗ while registration.paid is TRUE on community, i.e. it told a Community org it could not take money.",
    text: {
      en: "Branded exports & player cards",
      es: "Exportaciones con tu marca y fichas de jugador",
      fr: "Exports à votre image et fiches joueur",
      nl: "Exports met je eigen merk & spelerskaarten",
    },
  },
  {
    file: "ui",
    key: "billing.community.f6",
    why: "the org theme colour and badge removal, ✗ row. Source of truth: plan_entitlements dashboard.theme AND dashboard.branding, both false on community — TWO rows since V396 split them, and the row names both things, so both are pinned. THIS ROW WAS FALSE until fix round 3: it read “Branding & exports” with a ✗ while `branding` AND `exports` are both TRUE on community (V310) — only dashboard.branding and exports.branded are denied.",
    text: {
      en: "Theme colour & badge removal",
      es: "Color del tema y quitar la insignia",
      fr: "Couleur du thème et retrait du badge",
      nl: "Themakleur & badge verwijderen",
    },
  },
  {
    file: "ui",
    key: "billing.community.f7",
    why: "realtime scoring, ✗ row. Source of truth: plan_entitlements realtime, false on community.",
    text: {
      en: "Realtime scoreboard",
      es: "Marcador en tiempo real",
      fr: "Tableau des scores en temps réel",
      nl: "Realtime scorebord",
    },
  },
  {
    file: "ui",
    key: "billing.pro.f1",
    why: "Pro’s competition and division allowances, ✓ row. Source of truth: plan_entitlements competitions.max_active (still null — unlimited) and divisions.per_competition.max (20 since V392) on pro. The two rows used to share one word and W2 split them: one bullet covering two rows outlives a change to either, which is exactly how this came to promise unlimited divisions against a cap the resolver enforces at 20. The check behind it now requires the WORD for the null row and the NUMBER for the capped one, and forbids any other digit.",
    text: {
      en: "Unlimited competitions, 20 divisions each",
      es: "Competiciones ilimitadas, 20 divisiones cada una",
      fr: "Compétitions illimitées, 20 divisions chacune",
      nl: "Onbeperkt aantal competities, 20 divisies elk",
    },
  },
  {
    file: "ui",
    key: "billing.pro.f2",
    why: "Pro’s entrant cap, ✓ row. Source of truth: plan_entitlements entrants.per_division.max on pro; the digit is asserted against that row in all four locales.",
    text: {
      en: "256 entrants per division",
      es: "256 participantes por división",
      fr: "256 participants par division",
      nl: "256 deelnemers per divisie",
    },
  },
  {
    file: "ui",
    key: "billing.pro.f3",
    why: "that Pro takes online registrations and entry fees at its own platform cut. Source of truth: plan_entitlements registration.enabled / registration.paid and registration.fee_percent (2) on pro; the percentage is asserted against that row.",
    text: {
      en: "Online registration + entry fees (2%)",
      es: "Inscripción en línea + cuotas de inscripción (2%)",
      fr: "Inscription en ligne + frais d'inscription (2 %)",
      nl: "Online inschrijving + inschrijfgelden (2%)",
    },
  },
  {
    file: "ui",
    key: "billing.pro.f4",
    why: "player stats and scorecard entry, ✓ row. Source of truth: plan_entitlements stats.player, true on pro and false on community. Was \"Ball-by-ball & rally scoring\" until W1 (entitlements v18, owner ruling 2026-08-30): V390 deleted scoring.ball_by_ball and scoring.rally_by_rally outright, so that bullet stood in a ✓ column pinned to no row at all — and sold Community a capability it now has in full.",
    text: {
      en: "Player stats & scorecards",
      es: "Estadísticas de jugadores y planillas",
      fr: "Statistiques des joueurs et feuilles de match",
      nl: "Spelersstatistieken & scorekaarten",
    },
  },
  {
    file: "ui",
    key: "billing.pro.f5",
    why: "the org theme colour, ✓ row — the same row Community’s f6 denies, and the row SPEC-1 §5 once ticked for the Event Pass in error. Source of truth: plan_entitlements dashboard.theme, true on pro. It was `dashboard.branding` until V396: that key gated the colour AND badge removal, V395 made badge removal enterprise-only, and this ✓ row would have gone false while the string still promised Pro its branding. The STRING is unchanged and correct — “Custom branding” is the colour — only the row it is pinned to moved.",
    text: {
      en: "Custom branding",
      es: "Marca personalizada",
      fr: "Personnalisation de la marque",
      nl: "Aangepaste branding",
    },
  },
  {
    file: "ui",
    key: "billing.pro.f6",
    why: "exports, ✓ row. Source of truth: plan_entitlements `exports`, true on pro — note it is ALSO true on community, so this row is honest but is not a differentiator; the differentiator is exports.branded.",
    text: {
      en: "CSV / PDF exports",
      es: "Exportaciones CSV / PDF",
      fr: "Exports CSV / PDF",
      nl: "CSV / PDF-exports",
    },
  },
  {
    file: "ui",
    key: "billing.pro.f7",
    why: "realtime scoring, ✓ row. Source of truth: plan_entitlements realtime, true on pro.",
    text: {
      en: "Realtime scoreboard",
      es: "Marcador en tiempo real",
      fr: "Tableau des scores en temps réel",
      nl: "Realtime scorebord",
    },
  },
  // ── The Pro Plus ROADMAP block (fix round 1, I3) ───────────────────────────
  //
  // `pricing.plus.soonLabel` + `soon1-8`, under the Pro Plus card. Added because
  // the block was covered by NOTHING — not by a vocabulary, not by a pin, and
  // not by the card's own coverage assertion, which listed two arrays and so
  // codified the omission rather than merely forgetting it.
  //
  // Measured: flipping `soonLabel` to "Included now" reclassifies EIGHT
  // undelivered features as shipped, in whichever locale it is done, and the
  // whole suite stayed green. That is a direct breach of SPEC-1 §6's ethics
  // guardrail and it reads in review as a harmless copy tweak.
  //
  // There is no row to pin this to: availability is not in plan_entitlements,
  // and SPEC-1 §9 deliberately seeds `domains.custom` on pro_plus while the DNS
  // product is unbuilt (`pricing-matrix.ts` never renders that row), so the
  // matrix would say "shipped" about a feature that is not. This gate is the
  // guard, which is exactly the case the approved-wording shape exists for.
  {
    file: "marketing",
    key: "pricing.plus.soonLabel",
    why: "the ROADMAP LABEL under the Pro Plus card, and the single highest-leverage string on /pricing: it is what classifies the eight items below as NOT YET AVAILABLE. Measured in fix round 1 — flipping it to \"Included now\" advertised eight undelivered features as shipped and every test stayed green. SPEC-1 §6 requires the roadmap to read as ambition and never as a paywall; §9 keeps domains.custom seeded-but-unshipped, so plan_entitlements cannot decide this and the pin is the only guard. Re-approving means confirming the block is still a roadmap.",
    text: {
      en: "Coming soon",
      es: "Próximamente",
      fr: "Bientôt disponible",
      nl: "Binnenkort",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon1",
    why: "Pro Plus ROADMAP item 1 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[0] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Multi-org command centre",
      es: "Centro de mando multiorganización",
      fr: "Centre de commande multi-organisations",
      nl: "Commandocentrum voor meerdere organisaties",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon2",
    why: "Pro Plus ROADMAP item 2 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[1] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Shared templates & branding across orgs",
      es: "Plantillas y marca compartidas entre organizaciones",
      fr: "Modèles et identité partagés entre organisations",
      nl: "Gedeelde sjablonen & branding over organisaties",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon3",
    why: "Pro Plus ROADMAP item 3 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[2] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Cross-competition analytics",
      es: "Analíticas entre competiciones",
      fr: "Analyses inter-compétitions",
      nl: "Analyses over competities heen",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon4",
    why: "Pro Plus ROADMAP item 4 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[3] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Custom domain & white-label",
      es: "Dominio propio y marca blanca",
      fr: "Domaine personnalisé et marque blanche",
      nl: "Eigen domein & white-label",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon5",
    why: "Pro Plus ROADMAP item 5 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[4] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "SSO / SAML",
      es: "SSO / SAML",
      fr: "SSO / SAML",
      nl: "SSO / SAML",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon6",
    why: "Pro Plus ROADMAP item 6 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[5] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "SLA & dedicated support",
      es: "SLA y soporte dedicado",
      fr: "SLA et support dédié",
      nl: "SLA & toegewijde ondersteuning",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon7",
    why: "Pro Plus ROADMAP item 7 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[6] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Data export & warehouse",
      es: "Exportación de datos y data warehouse",
      fr: "Export de données et entrepôt de données",
      nl: "Data-export & datawarehouse",
    },
  },
  {
    file: "marketing",
    key: "pricing.plus.soon8",
    why: "Pro Plus ROADMAP item 8 (SPEC-1 §6) — badged \"coming soon\", NOT purchasable and NOT built. Its English mirror, PLUS_COMING_SOON[7] in lib/pricing-cards.ts, was DELETED in W2 (entitlements v18) along with the whole Pro Plus card — the plan is gone from `plans` and nothing renders this key any more. The approval stands only as a record; pruning the four locale trees is W3's. Re-approving means confirming the feature is still unshipped; shipping it means deleting it from this list and from PLUS_COMING_SOON in the same commit. Nothing in plan_entitlements records shipped-ness — SPEC-1 §9 deliberately seeds domains.custom on pro_plus while the DNS product is unbuilt — so no matrix pin is possible and this gate is the guard.",
    text: {
      en: "Bulk & scheduled automation",
      es: "Automatización masiva y programada",
      fr: "Automatisation en masse et planifiée",
      nl: "Bulk- & geplande automatisering",
    },
  },
  // ── The extra-organisation TIP (v17 gap wave 7, task 7, #299) ──────────────
  //
  // A FOURTH surface of the half-rate claim, and the one that showed the axis
  // was still not closed. `pricing.faq.groups.a` and the Pro Plus FAQ answer
  // were corrected earlier in this wave; this key said "half your plan's rate",
  // bare, in all four locales the whole time — the same phrase, the same
  // pattern (`en.halfClaim` spells it out), and again nothing pointed the rule
  // at the key. Third occurrence of that defect in one wave.
  //
  // It is also the key that showed `config/tips.ts` is NOT what renders:
  // `components/ui/tip.tsx` reads msg(`tips.${id}.body`) from these
  // dictionaries, so correcting the TypeScript literal alone would have changed
  // nothing a customer sees. The mirror between the two is asserted in
  // dictionary-copy-truth.test.ts for exactly that reason.
  {
    file: "ui",
    key: "tips.billing.extra-org.body",
    why: "the extra-organisation rate, in the ⓘ tip beside the billing-group controls. 'half your plan's rate' unqualified is false — the seed FLOORS the rider to the charm grid (usd pro monthly 1499 -> 699 = 46.6%), so only 'no more than half' is true in every plan x interval x currency combination. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape. The 2%/5% clause is registration.fee_percent in plan_entitlements, re-cut by V397 (community 8 -> 5); pro_plus is gone (V392) and aud is gone (V393), so both are out of the arithmetic above.",
    text: {
      en: "Each organisation after the first costs no more than half the base rate. It also moves to your plan's entry-fee cut — 2% on Pro, instead of the 5% a free organisation pays.",
      es: "Cada organización después de la primera cuesta no más de la mitad de la tarifa base. También pasa a la comisión de inscripción de tu plan: 2 % en Pro, en lugar del 5 % que paga una organización gratuita.",
      fr: "Chaque organisation après la première coûte au plus la moitié du tarif de base. Elle passe aussi à la commission d'inscription de votre formule — 2 % sur Pro, au lieu des 5 % que paie une organisation gratuite.",
      nl: "Elke organisatie na de eerste kost hoogstens de helft van het basistarief. Ze gaat ook over op het inschrijfgeldpercentage van je abonnement — 2% op Pro, in plaats van de 5% die een gratis organisatie betaalt.",
    },
  },
  // ── The remaining three half-rate surfaces (v17 gap wave 7, task 7 round 2) ──
  //
  // Round 1 reported these as a follow-up and scoped them out. That was the
  // wrong call and the review ruled them in: leaving the identical falsehood on
  // surfaces ADJACENT to the ones just corrected is how this claim family has
  // survived four rounds. With these three the axis is closed — every key in
  // the repo that states the extra-organisation rate is pinned, which is what
  // makes `HALF_CLAIM_KEYS` a decision instead of a list somebody stopped
  // adding to.
  //
  // Two of the three were invisible to `en.halfClaim` as it stood ("half
  // price", "half the plan rate"), so the vocabulary was widened in the same
  // change. The pin does not depend on that widening — it never did — but the
  // secondary net should not have a hole this claim has already walked through.
  {
    file: "marketing",
    key: "pricing.matrix.orgs.max_owned.note",
    why: "the extra-organisation rate, in the /pricing comparison matrix's own footnote on the orgs.max_owned row. Said 'half your plan's rate' bare. Same arithmetic as pricing.faq.groups.a: the seed rounds the rider DOWN (usd pro 1900 -> 900 = 47.4%) while eur/aud are exact halves, so only 'no more than half' is true in all twenty plan x interval x currency combinations. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape. The entry-fee half of the sentence is registration.fee_percent and is unchanged.",
    text: {
      en: "Each extra organisation costs no more than half the base rate, and takes your plan's entry-fee rate",
      es: "Cada organización adicional cuesta no más de la mitad de la tarifa base y adopta la comisión de inscripción de tu plan",
      fr: "Chaque organisation supplémentaire coûte au plus la moitié du tarif de base et adopte le taux de frais d'inscription de votre forfait",
      nl: "Elke extra organisatie kost hoogstens de helft van het basistarief en krijgt het inschrijfkostenpercentage van je abonnement",
    },
  },
  {
    file: "ui",
    key: "orgNew.bill.addToExistingHint",
    why: "the extra-organisation rate, sitting directly above the create-organisation picker's 'add to an existing bill' control — so it is read as the rate that choice will charge. Said 'half price', which en.halfClaim did not match and nl.halfClaim did not match either ('voor de helft van de prijs' needed the determiner to be optional); both were widened. Source of truth: config/stripe-plans.json graduated tiers, via riderClaimShape.",
    text: {
      en: "Every extra organisation costs no more than half the base rate, on the same card and invoice.",
      es: "Cada organización adicional cuesta no más de la mitad de la tarifa base, en la misma tarjeta y factura.",
      fr: "Chaque organisation supplémentaire coûte au plus la moitié du tarif de base, sur la même carte et la même facture.",
      nl: "Elke extra organisatie kost hoogstens de helft van het basistarief, op dezelfde kaart en factuur.",
    },
  },
  {
    file: "ui",
    key: "billing.group.attach.confirmCharge",
    why: "the extra-organisation rate AND the attach charge's TIMING, in the confirmation dialog — the last sentence a payer reads before agreeing, and the only one of these surfaces asserted by e2e (billing-groups.spec.ts, billing-groups-journey.spec.ts), which move with it. RATE: said 'half your plan's rate' bare; source of truth is config/stripe-plans.json's graduated tiers, via riderClaimShape. TIMING: said 'charged now', which is FALSE. attachOrgToGroup bills entirely through syncGroupQuantity, whose only Stripe mutation is subscriptions.update with proration_behavior 'create_prorations' (billing-groups.ts:327-330) — booked onto the NEXT INVOICE, exactly like the add-on paths. No invoices.create, no invoices.pay, no always_invoice, no payment_behavior anywhere in that file; previewAttachCharge uses invoices.createPreview, which is read-only. `charged = raising` is a proration flag, not a statement that money moved. I asserted the opposite here in round 2 on the strength of a stale comment at billing-groups.ts:215-217, which is now corrected — the comment was contradicted by billing-events.ts:738-740 in the same repo.",
    text: {
      en: "{org} moves onto this plan straight away, and your bill goes up by no more than half the base rate — prorated to the rest of this period and added to your next invoice.",
      es: "{org} pasa a este plan de inmediato y tu factura sube no más de la mitad de la tarifa base, prorrateado al resto de este periodo y añadido a tu próxima factura.",
      fr: "{org} passe sur cette formule immédiatement, et votre facture augmente d'au plus la moitié du tarif de base — au prorata du reste de la période et ajouté à votre prochaine facture.",
      nl: "{org} gaat meteen over op dit abonnement en je factuur stijgt met hoogstens de helft van het basistarief — naar rato van de rest van deze periode en toegevoegd aan je volgende factuur.",
    },
  },
  {
    file: "ui",
    key: "billing.group.attach.confirmChargeAmount",
    why: "the SAME dialog when previewAttachCharge returns a figure — billing-group-panel.tsx:233-238 substitutes this for confirmCharge whenever the preview is non-null, so it is the sentence most payers actually see and it carried the identical 'goes up by {amount} now' falsehood. Timing source of truth: billing-groups.ts:327-330 (create_prorations, next invoice). The AMOUNT itself is Stripe's own proration arithmetic via invoices.createPreview (billing-groups.ts:136-142), which is read-only and charges nothing.",
    text: {
      en: "Straight away, and your bill goes up by {amount} — prorated to the rest of this period and added to your next invoice.",
      es: "De inmediato, y tu factura sube {amount}, prorrateado al resto de este periodo y añadido a tu próxima factura.",
      fr: "Immédiatement, et votre facture augmente de {amount} — au prorata du reste de la période et ajouté à votre prochaine facture.",
      nl: "Meteen, en je factuur stijgt met {amount} — naar rato van de rest van deze periode en toegevoegd aan je volgende factuur.",
    },
  },
  // ── The attach dialog's THIRD body, and the bound its second was missing ──
  // (v17 gap wave 7, task 7, round 4)
  {
    file: "ui",
    key: "billing.group.attach.confirmTrial",
    why: "the attach dialog on the TRIAL path, which had no body of its own and therefore read the CHARGED one. `attachConfirmKey` selected on `freeSlots` alone, and `freeSlots = max(0, quantity_paid - onBill)` is 0 during a trial because syncGroupQuantity deliberately freezes quantity_paid while trialing (billing-groups.ts:357-362) — so a trialing payer was told their bill goes up and the amount lands on the next invoice, when `raising` is false (`&& !trialing`, :326), proration_behavior is \"none\", and previewAttachCharge returns null at :129. Nothing is prorated at all. groups.md:43 said the opposite two sections away. Source of truth: billing-groups.ts:129, :326, :357-362.",
    text: {
      en: "{org} moves onto this plan straight away and rides your free trial to the same end date — nothing is charged and nothing is added to a bill now. It is first billed when the trial converts.",
      es: "{org} pasa a este plan de inmediato y se acoge a tu prueba gratuita hasta la misma fecha de finalización: no se cobra nada ni se añade nada a ninguna factura ahora. Se factura por primera vez cuando termine la prueba.",
      fr: "{org} passe sur cette formule immédiatement et suit votre essai gratuit jusqu'à la même date de fin — rien n'est prélevé et rien n'est ajouté à une facture maintenant. La première facturation intervient à la conversion de l'essai.",
      nl: "{org} gaat meteen over op dit abonnement en loopt mee met je gratis proefperiode tot dezelfde einddatum — er wordt nu niets in rekening gebracht en niets aan een factuur toegevoegd. De eerste facturatie volgt wanneer de proefperiode overgaat.",
    },
  },
  {
    file: "ui",
    key: "billing.group.attach.confirmFree",
    why: "the attach dialog when a PAID slot is free. 'there is nothing to pay now' is literally true — no charge, and no proration reaches the next invoice — but it was materially incomplete: syncGroupQuantity still RAISES the Stripe item quantity, so the renewal invoice bills the extra seat at the full rider rate. groups.md:90 already carried the bound ('at no extra charge UNTIL RENEWAL'), as does detach.mode.release.body; this dialog was the only one of the four surfaces that omitted it, and once its sibling started naming the next invoice explicitly the pair read as 'charged -> next invoice / free -> nothing, full stop'. Source of truth: billing-groups.ts:327-330 (the quantity write happens on every path) and the quantity_paid bookkeeping at :355-370.",
    text: {
      en: "{org} moves onto this plan straight away. You have a slot you have already paid for, so there is nothing to pay now — and nothing is added to your next invoice. From your next renewal onwards it is billed like any other organisation on the bill.",
      es: "{org} pasa a este plan de inmediato. Tienes una plaza que ya has pagado, así que no hay nada que pagar ahora ni se añade nada a tu próxima factura. A partir de tu próxima renovación se factura como cualquier otra organización de la cuenta.",
      fr: "{org} passe sur cette formule immédiatement. Vous avez une place déjà payée : il n'y a donc rien à payer maintenant, et rien n'est ajouté à votre prochaine facture. À partir de votre prochain renouvellement, elle est facturée comme toute autre organisation de la facture.",
      nl: "{org} gaat meteen over op dit abonnement. Je hebt een plek die je al betaald hebt, dus er is nu niets te betalen en er wordt niets aan je volgende factuur toegevoegd. Vanaf je volgende verlenging wordt ze gefactureerd als elke andere organisatie op de rekening.",
    },
  },
  // ── The END of a pass's life (v17 gap #301) ────────────────────────────────
  // Added by the W8 review round, and the reason is measured, not precautionary:
  // this is now the most on-topic pass-lifecycle copy in the app and it was the
  // only pass copy nothing scanned. A control mutation rewrote
  // `reasonTerminal` wholesale and shipped 208/208 GREEN.
  //
  // It cost a live falsehood to find out. `pass.entry.ended.nextBody` shipped
  // saying "Pro lifts the same limits" — false for an `event_pass_l` holder,
  // and contradicted by the comparison table five rows ABOVE it on the same
  // screen (Event Pass L: unlimited entrants; Pro: 256). That is issue #337,
  // which `pricing.faq.upgraded.a` above already documents and deliberately
  // steers around; the in-app string walked into it because nothing pointed a
  // rule at these keys.
  {
    file: "ui",
    key: "pass.entry.ended",
    why: "the ENDED state's name, on <CompetitionPassEntry>, the /upgrade ticket stub and the dashboard seal. It must not read as deleted or refunded: the pass ROW is untouched and the receipt still lists it (server/usecases/billing-manage.ts getPassPurchases — qualified, because lib/billing-manage.ts also exists). Source of truth: lib/entitlements.ts passLockReason (any non-null reason = ended) and its SQL twin V338's pass arm.",
    text: {
      en: "Event Pass ended",
      es: "Pase de evento finalizado",
      fr: "Event Pass terminé",
      nl: "Event Pass beëindigd",
    },
  },
  {
    file: "ui",
    key: "pass.entry.ended.reasonTerminal",
    why: "WHY a pass stopped applying on the `terminal` arm. Two claims: nothing is deleted (true — the row survives; only refund/dispute deletes it, usecases/billing-events.ts) and the pass has stopped lifting LIMITS (true of the competition's own caps, via V338's pass arm requiring a non-terminal status). Deliberately says 'its limits', NOT the org's: #347 records that usecases/competitions.ts:88 and entitlement-freeze.ts still exempt on bare row existence, so the org-level active-competition quota is a claim this sentence must not make.",
    text: {
      en: "Nothing is deleted — this competition is finished or archived, so its Event Pass has stopped lifting its limits.",
      es: "No se ha eliminado nada — esta competición está finalizada o archivada, así que su pase de evento ha dejado de ampliar sus límites.",
      fr: "Rien n'est supprimé — cette compétition est terminée ou archivée, donc son Event Pass a cessé de relever ses limites.",
      nl: "Er wordt niets verwijderd — deze competitie is afgerond of gearchiveerd, dus de Event Pass verhoogt de limieten niet meer.",
    },
  },
  {
    file: "ui",
    key: "pass.entry.ended.reasonPastEnds",
    why: "WHY a pass stopped applying on the `past_ends_on` arm, plus the one action that reverses it. 'Update the end date' is honest — the rule reads competitions.ends_on live (entitlements.ts passLockReason, PASS_END_GRACE_DAYS = 7, strict <) so moving the date does restore the pass. Bound worth knowing: the resolver caches for ENT_TTL_SECONDS = 300 and no competition write invalidates it, so the advice takes up to 5 minutes to take effect.",
    text: {
      en: "Nothing is deleted — this competition is past its end date, so its Event Pass has stopped lifting its limits. Update the end date if it is still running.",
      es: "No se ha eliminado nada — esta competición ha superado su fecha de fin, así que su pase de evento ha dejado de ampliar sus límites. Actualiza la fecha de fin si sigue en marcha.",
      fr: "Rien n'est supprimé — cette compétition a dépassé sa date de fin, donc son Event Pass a cessé de relever ses limites. Modifiez la date de fin si elle est toujours en cours.",
      nl: "Er wordt niets verwijderd — deze competitie is voorbij de einddatum, dus de Event Pass verhoogt de limieten niet meer. Pas de einddatum aan als de competitie nog loopt.",
    },
  },
  {
    file: "ui",
    key: "pass.entry.ended.nextBody",
    why: "what is still true once the pass has ended, on the /upgrade page's Pro panel. MUST NOT claim Pro is a superset of the pass — that is #337: plan_entitlements gives event_pass_l entrants.per_division.max = null (unlimited, V341) against pro's 256 (V270), so 'the same limits' is FALSE for an L holder AND is contradicted by the comparison table on the same screen. The approved wording claims only BREADTH (every competition, not just this one) and CONTINUITY (next season), both of which hold for either rung. Source of truth: V341, V270, and upgrade/page.tsx's own header note.",
    text: {
      en: "The pass and its receipt stay on this competition. Pro raises every competition in {org}, not just this one — and keeps raising them next season.",
      es: "El pase y su recibo se quedan en esta competición. Pro mejora todas las competiciones de {org}, no solo esta, y las sigue mejorando la próxima temporada.",
      fr: "Le pass et son reçu restent attachés à cette compétition. Pro améliore toutes les compétitions de {org}, pas seulement celle-ci, et continue de les améliorer la saison prochaine.",
      nl: "De pass en de bon blijven bij deze competitie. Pro upgradet elke competitie in {org}, niet alleen deze — en blijft dat volgend seizoen doen.",
    },
  },
  {
    file: "ui",
    key: "pass.entry.ended.nextEdition",
    why: "the one thing the product can still say YES to. A pass cannot be re-bought for THIS competition (decision #248 Q4, enforced by api/billing/pass-checkout/route.ts and the competition_passes PK on competition_id), but the next edition is a NEW competition and can hold its own pass — so this link must point at competition creation, never at a re-purchase. CADENCE-NEUTRAL on purpose: it said \"next year's edition\" until a weekly ladder and a monthly league both hit it, and nothing in the product makes a competition annual. \"Edition\" carries the continuity the sentence needs without naming an interval the data does not have.",
    text: {
      en: "Create the next edition",
      es: "Crear la próxima edición",
      fr: "Créer la prochaine édition",
      nl: "Volgende editie aanmaken",
    },
  },
  // ── THE THREE PLAN CARDS' BULLETS (entitlements v18 W2) ────────────────────
  //
  // These 22 keys did not exist until this wave. `/pricing` and the home ticket
  // stubs rendered three hardcoded ENGLISH arrays from lib/pricing-cards.ts, in
  // every locale — a Spanish visitor read a localised crossover sentence, a
  // localised FAQ and a localised comparison matrix, then three cards of
  // English. The arrays now hold dictionary KEYS, and every figure they quote
  // is interpolated from plan_entitlements rather than typed into four locale
  // files (a number written into copy goes stale under the row it describes;
  // written into four locales it goes stale four times and is fixed once).
  //
  // So what is pinned here is the WORDING, in four locales side by side — which
  // rows each bullet claims and how it frames them. The NUMBERS are pinned
  // elsewhere and better: lib/__tests__/pricing-cards.test.ts re-renders every
  // card from the live matrix, and lib/__tests__/pricing-card-i18n.test.ts
  // forbids a digit appearing in any of these values in any locale.
  {
    file: "marketing",
    key: "pricing.community.f1",
    why: "Community's active-competition and division caps, on the public card. BOTH figures are interpolated from plan_entitlements at render time (competitions.max_active and divisions.per_competition.max on plan_key 'community', live 3 and 4) — lib/pricing-cards.ts declares the rows and lib/__tests__/pricing-cards.test.ts re-renders the card from the live matrix and asserts both appear, so the numbers cannot rot. What is pinned here is the SENTENCE: which two allowances it names, and that it names them as caps rather than as a grant. Bullet 1 read '10 active competitions' against a cap V392 re-cut to 3 — the card oversold the free tier threefold.",
    text: {
      en: "{competitions} active competitions, {divisions} divisions",
      es: "{competitions} competiciones activas, {divisions} divisiones",
      fr: "{competitions} compétitions actives, {divisions} divisions",
      nl: "{competitions} actieve competities, {divisions} divisies",
    },
  },
  {
    file: "marketing",
    key: "pricing.community.f2",
    why: "Community's entrant ceiling. entrants.per_division.max on 'community' (live 64), interpolated. The words pinned here scope it PER DIVISION — dropping that qualifier turns a per-division cap into an org-wide one, which is the same class of error the plans article shipped when it gave the pass Community's number.",
    text: {
      en: "{entrants} entrants per division",
      es: "{entrants} participantes por división",
      fr: "{entrants} participants par division",
      nl: "{entrants} deelnemers per divisie",
    },
  },
  {
    file: "marketing",
    key: "pricing.community.f3",
    why: "the formats a free organiser can actually run. No number and no matrix row of its own: formats.advanced is what the Event Pass LIFTS, so this bullet names the ones below that line (league, groups, knockout, swiss). Naming an advanced format here would sell what the resolver refuses on Community.",
    text: {
      en: "League, groups + knockout & swiss formats",
      es: "Formatos de liga, grupos + eliminatoria y suizo",
      fr: "Formats championnat, poules + élimination directe et suisse",
      nl: "Competitie-, poule- + knock-out- en Zwitserse formats",
    },
  },
  {
    file: "marketing",
    key: "pricing.community.f4",
    why: "that Community can take online registrations AND card entry fees, at a rate. registration.fee_percent on 'community' is interpolated (live 5); registration.paid and registration.enabled are the boolean rows behind the claim, pinned by CARD_SURFACES in lib/__tests__/pricing-cards.test.ts. V310: charging entry fees is free on every plan and only the platform cut differs, so this must not read as though payment were a paid unlock.",
    text: {
      en: "Online registration & entry fees ({fee}% fee)",
      es: "Inscripción en línea y cuotas de inscripción (comisión del {fee}%)",
      fr: "Inscription en ligne et frais d’inscription ({fee} % de commission)",
      nl: "Online inschrijving & inschrijfgelden ({fee}% kosten)",
    },
  },
  {
    file: "marketing",
    key: "pricing.community.f5",
    why: "live standings and a public dashboard on the free tier. dashboard.public.max >= 1 on 'community' is the row; it is INT-shaped, so 1 -> 0 makes the bullet false with no boolean moving, which is why CARD_SURFACES pins it with an atLeast rather than as a boolean.",
    text: {
      en: "Live standings & public dashboard",
      es: "Clasificación en directo y panel público",
      fr: "Classement en direct et tableau de bord public",
      nl: "Live stand & openbaar dashboard",
    },
  },
  {
    file: "marketing",
    key: "pricing.community.f6",
    why: "that a free competition is listed publicly. discovery.listed on 'community'. Deliberately NOT a share-loop claim: V395 (owner ruling 2026-09-03) made dashboard.player_profiles, embeds.enabled and news.auto paid on Free, so a bullet naming any of those would sell what the resolver now refuses.",
    text: {
      en: "Listed on the seazn.club showcase",
      es: "Listado en el escaparate de seazn.club",
      fr: "Référencé sur la vitrine seazn.club",
      nl: "Vermeld in de seazn.club-etalage",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.f1",
    why: "the pass's DURATION, on its own card. V328/V334 (org_has_feature) bind the pass arm to the competition's own lifecycle — it drops out once the competition is archived or completed, or more than 7 days past its end date — so the pass is bounded, not permanent. 'forever' was false here for a whole wave (v17 gap wave 7). The scope word is load-bearing too: ONE competition, not the organisation.",
    text: {
      en: "Upgrades ONE competition while it runs",
      es: "Mejora UNA competición mientras se disputa",
      fr: "Améliore UNE compétition tant qu’elle se déroule",
      nl: "Upgradet ÉÉN competitie zolang die loopt",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.f2",
    why: "the size a pass buys. divisions.per_competition.max and entrants.per_division.max on 'event_pass' (live 10 and 128), both interpolated. It named BOTH rungs' ceilings until the owner took the L rung off sale on 2026-09-05; the second half then advertised 512 entrants with no checkout behind it, so it went. 'the pass bullet names the division cap of every rung on sale, and no other' in lib/__tests__/pricing-cards.test.ts reads SELLABLE_PASS_KEYS and reds if a withdrawn rung's numbers come back.",
    text: {
      en: "{divisions} divisions, {entrants} entrants each",
      es: "{divisions} divisiones, {entrants} participantes cada una",
      fr: "{divisions} divisions, {entrants} participants chacune",
      nl: "{divisions} divisies, elk {entrants} deelnemers",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.f3",
    why: "the formats the pass unlocks over Community. formats.advanced on 'event_pass'. Named as EXAMPLES (double elimination, ladders) rather than as the complete set, because the row is a single boolean and enumerating it would make the copy owe an update to every format added behind it.",
    text: {
      en: "Advanced formats — double elim, ladders",
      es: "Formatos avanzados: doble eliminación y escaleras",
      fr: "Formats avancés — double élimination, échelles",
      nl: "Geavanceerde formats — dubbele eliminatie, ladders",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.f4",
    why: "the pass's platform fee, AS A SAVING. Both rates are interpolated — registration.fee_percent on 'event_pass' and on 'community' (live 4 against 5, V397's additive ladder 5/4/2/1). Two rows on purpose: quoting only the pass's own rate would survive Community's moving and stop being a saving at all, and this is the bullet a buyer does the arithmetic with.",
    text: {
      en: "{fee}% platform fee on entry fees, not {communityFee}%",
      es: "Comisión de plataforma del {fee}% sobre las cuotas de inscripción, no del {communityFee}%",
      fr: "{fee} % de frais de plateforme sur les frais d’inscription, au lieu de {communityFee} %",
      nl: "{fee}% platformkosten op inschrijfgelden, niet {communityFee}%",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.f5",
    why: "the two boolean grants the pass lifts that a buyer can see on a public page: exports.branded and dashboard.player_profiles. NOT 'custom branding & PDF/XLSX exports' — branding and exports are both true for Community (V310), so that wording sold the pass something it does not add.",
    text: {
      en: "Branded exports & public player cards",
      es: "Exportaciones personalizadas y fichas públicas de jugador",
      fr: "Exports personnalisés et fiches joueurs publiques",
      nl: "Exports met huisstijl & openbare spelerskaarten",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.f6",
    why: "sponsorship. sponsors.tiers and sponsors.monetize on 'event_pass' — the paid half is what makes this a pass claim rather than a Community one, so both halves are load-bearing.",
    text: {
      en: "Sponsor tiers & paid sponsorship packages",
      es: "Niveles de patrocinadores y paquetes de patrocinio de pago",
      fr: "Niveaux de sponsors et offres de sponsoring payantes",
      nl: "Sponsorniveaus & betaalde sponsorpakketten",
    },
  },
  {
    file: "marketing",
    key: "pricing.pass.f7",
    why: "realtime on the passed competition. The realtime row on 'event_pass'. Same feature the comparison table calls 'Realtime scoreboard & slideshow', worded to match so a reader comparing card to table is reading one claim.",
    text: {
      en: "Realtime scoreboard & slideshow",
      es: "Marcador y presentación en tiempo real",
      fr: "Tableau de score et diaporama en temps réel",
      nl: "Live scorebord & diavoorstelling",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f1",
    why: "Pro's competition and division allowances — the bullet that had to SPLIT. competitions.max_active is null on pro (unlimited) while divisions.per_competition.max is 20 since V392, so one bullet covering both rows outlived a change to either and came to promise a cap the resolver enforces at 20. The division figure is interpolated; 'unlimited' is a word about a NULL row, and CARD_SURFACES faults it the moment that row takes a number.",
    text: {
      en: "Unlimited competitions, {divisions} divisions each",
      es: "Competiciones ilimitadas, {divisions} divisiones cada una",
      fr: "Compétitions illimitées, {divisions} divisions chacune",
      nl: "Onbeperkt aantal competities, elk {divisions} divisies",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f2",
    why: "Pro's entrant ceiling. entrants.per_division.max on 'pro' (live 256), interpolated, per division for the same reason Community's is.",
    text: {
      en: "{entrants} entrants per division",
      es: "{entrants} participantes por división",
      fr: "{entrants} participants par division",
      nl: "{entrants} deelnemers per divisie",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f3",
    why: "Pro's platform fee. registration.fee_percent on 'pro' (live 2), interpolated. Stated as a rate on entry fees rather than as an unlock — taking entry fees is free on every plan since V310.",
    text: {
      en: "Entry fees at a {fee}% platform fee",
      es: "Cuotas de inscripción con una comisión de plataforma del {fee}%",
      fr: "Frais d’inscription avec {fee} % de frais de plateforme",
      nl: "Inschrijfgelden met {fee}% platformkosten",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f4",
    why: "the one scoring row that is still Pro-only. It read 'Ball-by-ball & rally scoring, player stats' until W1 (owner ruling 2026-08-30); V390 deleted scoring.ball_by_ball and scoring.rally_by_rally from plan_entitlements, so two thirds of that sentence pointed at no row AND sold Community something it already has. stats.player is the survivor and is what this names.",
    text: {
      en: "Player stats & scorecards",
      es: "Estadísticas de jugadores y planillas",
      fr: "Statistiques des joueurs et feuilles de match",
      nl: "Spelersstatistieken & scorekaarten",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f5",
    why: "four boolean Pro grants in one line: officials rows, exports, api.access and scoring.device_links. A list rather than four bullets because none of them is the reason anyone buys Pro; each is pinned individually by CARD_SURFACES so the compression cannot hide one going false.",
    text: {
      en: "Officials, exports, API keys, device links",
      es: "Árbitros, exportaciones, claves de API y vinculación de dispositivos",
      fr: "Officiels, exports, clés API et liaison d’appareils",
      nl: "Officials, exports, API-sleutels en apparaatkoppelingen",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f6",
    why: "how a Pro org's public pages LOOK. dashboard.theme on 'pro' — the key V396 split out of dashboard.branding. It replaced a badge-removal claim: V395 (owner ruling 2026-09-03) made badge removal enterprise-only, so every self-serve plan carries the badge and that bullet promised a row Pro no longer holds. Replaced rather than dropped, because the card should keep a visual-differentiator claim and this is one the matrix backs.",
    text: {
      en: "Your club colours on public pages & slideshow",
      es: "Los colores de tu club en las páginas públicas y la presentación",
      fr: "Les couleurs de votre club sur les pages publiques et le diaporama",
      nl: "De kleuren van je club op openbare pagina’s & de diavoorstelling",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f7",
    why: "discipline.enforced on 'pro' (v16 league-ops, V293). Suspensions tracked automatically, which is a claim about enforcement rather than about record-keeping — Community can still write a card into a match.",
    text: {
      en: "Suspensions & discipline tracking",
      es: "Seguimiento de suspensiones y disciplina",
      fr: "Suivi des suspensions et de la discipline",
      nl: "Schorsingen & disciplineregistratie",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f8",
    why: "two officials rows in one bullet: officials.auto (V392 brought it down to Pro from the deleted tier above it, so the Pro card can make this claim for the first time) and officials.marks (V294). Folded together rather than added as a tenth bullet; both are pinned in CARD_SURFACES.",
    text: {
      en: "Auto officials assignment & ratings",
      es: "Asignación automática de árbitros y valoraciones",
      fr: "Attribution automatique des officiels et notations",
      nl: "Automatische toewijzing van officials & beoordelingen",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.f9",
    why: "news.auto on 'pro' (V295). Drafted, not published — the word matters, because the feature writes a draft for a human to send.",
    text: {
      en: "Auto-drafted result posts",
      es: "Publicaciones de resultados redactadas automáticamente",
      fr: "Articles de résultats rédigés automatiquement",
      nl: "Automatisch opgestelde wedstrijdverslagen",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.per",
    why: "the '/month' suffix beside the Pro card's headline figure, and the word that decides whether the number above it is read as a monthly or a yearly price. Source of truth: config/stripe-plans.json plans[pro].prices.monthly.interval = 'month'; with the annual toggle ON the page divides the ANNUAL amount by twelve (pricing/page.tsx) so the suffix stays true in both toggle states. It was the literal '/month' in every locale until 2026-09-05, on a page whose every other price honours the currency switcher.",
    text: {
      en: "/month",
      es: "/mes",
      fr: "/mois",
      nl: "/maand",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.annualBilled",
    why: "the yearly TOTAL under the per-month figure, shown while the annual toggle is on. {total} is interpolated by pricing/page.tsx from proPrice('annual', currency) — never typed into a locale file, because the seed prices each market independently (usd 12899 / eur 10899 / gbp 8899 / inr 499900) and a figure frozen into copy goes stale four times and is corrected once. The words are the claim that this amount is charged ONCE A YEAR rather than monthly.",
    text: {
      en: "{total} billed yearly",
      es: "{total} facturado al año",
      fr: "{total} facturé à l'année",
      nl: "{total} per jaar gefactureerd",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.annualSaving",
    why: "WHAT PAYING YEARLY IS WORTH, in the emerald badge on the Pro card. It said 'save 30%' — hardcoded English, and false in every market: derived from config/stripe-plans.json the base tier saves 28.29% usd / 30.08% eur / 32.52% gbp / 30.45% inr, and the extra-organisation rider 23.71% / 24.89% / 26.54% / 30.35%. No single percentage can be right, so the claim is a FLOOR read off the ladder — a year costs 8.10 to 9.16 monthly payments at the eight live price points, so 'more than two months free' is true everywhere with room. DELIBERATELY THE SAME WORDING as pricing.faq.annual.a and billing.annualSaves: one fact, one sentence, and dictionary-copy-truth's annual suite judges all three against annualPricePoints() together.",
    text: {
      en: "more than two months free",
      es: "más de dos meses gratis",
      fr: "plus de deux mois offerts",
      nl: "meer dan twee maanden gratis",
    },
  },
  {
    file: "marketing",
    key: "pricing.pro.monthlyNote",
    why: "shown in place of the yearly line when the toggle is OFF, and it makes two claims: that this price is billed monthly, and that the interval can be changed later. Source of truth for the second, RE-CHECKED against the tree rather than assumed: POST /api/billing/interval -> applyIntervalChange in lib/billing-manage.ts swaps the subscription's price with proration, with GET /api/billing/interval/preview quoting the charge first, and components/billing-manage.tsx renders the control (billing.intervalChange.toYearly / .toMonthly). So 'any time' is the product's behaviour, not a marketing flourish.",
    text: {
      en: "Billed monthly · switch to yearly any time",
      es: "Facturación mensual · cambia a anual cuando quieras",
      fr: "Facturation mensuelle · passez à l'annuel à tout moment",
      nl: "Maandelijkse facturering · stap altijd over op jaarlijks",
    },
  },
];
