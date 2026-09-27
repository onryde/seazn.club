// THE APPROVED WORDING of the billing-help copy that keeps regressing —
// every surface of it, not only its paragraphs.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// Three consecutive rounds of the v17 truth-in-copy wave shipped or preserved a
// falsehood in this copy, and each round was caught by a person reading
// the copy against the code — never by a rule. The rules were all denylists
// (banned phrasings, banned vocabularies, banned "grammatical forms"), and a
// denylist can only contain what its author thought of. Measured, each time by
// someone other than the author: 1/12, then 0/12.
//
// This file is the other half of the answer. It does not generalise, so there is
// no phrasing that evades it: the surface either says the approved words or it
// does not.
//
// ── IF A TEST SENT YOU HERE ──────────────────────────────────────────────────
// The test is a GATE, not a bug. You changed one of these surfaces — a
// paragraph, a heading, a list item, a table row or a frontmatter field — and the
// change needs one deliberate step before it ships:
//
//   1. Read your new wording against the code it describes — the source of truth
//      is named in each entry's `why`, and it is a file path, not a memory.
//   2. Paste the failing test's "on disk:" string into that entry's `text`.
//   3. Say in the commit message what changed and what you checked it against.
//
// That is the step that was skipped three times. It costs a few minutes; the
// falsehoods it is meant to catch have each been about money an organiser is
// charged.
//
// The digests here are taken over NORMALISED text — `claimSurfaces` output, so
// markdown emphasis and link syntax are already stripped, headings are their
// text, and a frontmatter field is "<key>: <value>". Copy the digest the failure
// prints rather than recomputing one by hand.
import type { ApprovedParagraph } from "@/lib/copy-truth";

/** `content/help/billing/event-pass.md`. */
export const APPROVED_EVENT_PASS: ApprovedParagraph[] = [
  {
    id: "event-pass.md#opening",
    find: /^An Event Pass upgrades one competition/,
    why: "the pass's SCOPE — one competition, and only while that competition runs. Source of truth: lib/entitlements.ts (org_has_feature, PASS_END_GRACE_DAYS) and V328/V334.",
    text: "An Event Pass upgrades one competition while it runs — bigger limits, the organiser extras that make an event look the part, and a cheaper platform fee — without a monthly subscription.",
  },
  {
    id: "event-pass.md#when-it-stops",
    find: /^A pass lifts the plan while its competition is running/,
    why: "WHEN the pass stops applying. Source of truth: lib/entitlements.ts (PASS_END_GRACE_DAYS = 7, completed/archived) and V334.",
    text: "A pass lifts the plan while its competition is running. It stops once that competition is over:",
  },
  {
    id: "event-pass.md#fee-lock",
    find: /^Your entry-fee rate is the exception/,
    why: "what an entrant is charged after the pass ends. Source of truth: server/usecases/registrations.ts — it is the ONLY writer of competitions.fee_percent, its `and fee_percent is null` makes the stamp first-wins, and it records what the first paid CARD entry was actually charged (an offline entry carries no rate). A pass bought after that entry cannot lower the locked rate.",
    text: "Your entry-fee rate is the exception. A competition's platform fee is fixed by its first paid card entry: whatever rate that entrant was charged is the rate every later entry in that competition pays, and it does not move when the pass stops applying. So if the first card entry was taken while the pass was live, the pass's cheaper rate rides on to the end. If the competition had already taken a paid card entry before the pass was bought, it stays on the rate it locked in then — buying a pass does not lower an already-locked rate, so buy before you open entries, not after. Only a competition with no paid card entry yet follows your plan's live rate.",
  },
];

/** `content/help/billing/plans.md`, the `## Event Pass` section only. */
export const APPROVED_PLANS_PASS: ApprovedParagraph[] = [
  {
    id: "plans.md#event-pass-opening",
    find: /^One-time upgrade for a single competition/,
    why: "the pass's scope again, on the page most readers meet first. It said 'for that event's lifetime' until this wave, which V328/V334 contradict. Source of truth: lib/entitlements.ts. RE-APPROVED 2026-09-05 (owner decision: the L rung off sale): the trailing 'it comes in two sizes, and the only difference between them is how big that one event may get' went with the size ladder it introduced. The load-bearing half — 'while that competition is still running' — is untouched, which is the clause this fixture exists to hold.",
    text: "One-time upgrade for a single competition, while that competition is still running, without a subscription:",
  },
];


/**
 * Every USER-VISIBLE SURFACE of `content/help/billing/event-pass.md`, in order,
 * as a digest: the frontmatter fields, every heading, and every paragraph, list
 * item and table row.
 *
 * FIX ROUND 3 — this used to say "every paragraph … the WHOLE article" while
 * pinning neither frontmatter nor headings, because `proseBlocks` filters both.
 * A reviewer delivered the wave's two flagship falsehoods through a heading and
 * through `description:` and the suite stayed green. Both surfaces are rendered:
 * `description` is the lead paragraph under the title, the page metadata, and
 * the search-result snippet.
 *
 * The whole article, because every paragraph of it is a claim about this one
 * product — there is no part of it that is not a statement about what a buyer
 * gets and for how long.
 *
 * See `inventoryFaults` for why this is a digest list and not prose, and the
 * header of this file for what to do when it fails.
 *
 * REGENERATED 2026-09-05 — the L rung came off sale (owner decision). Both
 * articles described a size the checkout will no longer sell, and `event-pass.md`
 * led with a two-column M-vs-L comparison table, which was the loudest instance
 * of it in the product. What changed, and what each change was read against
 * before it was re-pinned:
 *
 *   event-pass.md — 21 surfaces gone, 19 back: the "Two sizes: M and L" heading
 *   and its table became a one-column "The pass" table; the "pick the size
 *   before you buy" paragraph became "a competition holds one pass", with the
 *   over-128-entrant reader pointed at Pro; the entrants/divisions bullet, the
 *   AI-credit bullet, the ended-marker sentence, the closed-competition
 *   sentence, the on-Pro paragraph and the last three FAQ answers each lost
 *   their L clause. Every figure re-read against `plan_entitlements`
 *   (event_pass: 128 entrants, 10 divisions, 4% against community's 5%) and
 *   `PASS_CREDIT_GRANT.event_pass` (25).
 *
 *   plans.md — 6 surfaces gone, 5 back: the Event Pass section lost its
 *   two-bullet size ladder and its "sized with the pass" credit sentence.
 *   Same sources, same figures.
 *
 * AND AGAIN, same day, three more — all in event-pass.md, all the same
 * sentence fragment: the held marker "Event Pass M active" became
 * "Event Pass active". Owner-approved.
 *
 *   This is the HELD side, which the 2026-09-05 ruling deliberately left
 *   alone, so it needs its own justification rather than inheriting that one.
 *   The letter had become something a buyer meets ONLY AFTER paying: the buy
 *   button reads "Buy the pass", /pricing's ticket and matrix column read
 *   "Event Pass", and `config/stripe-plans.json` names this rung's product
 *   "Seazn Club Event Pass" — no letter on the checkout line or the receipt.
 *   So the active marker was the single place in the whole purchase naming a
 *   size, and it appeared after the money moved.
 *
 *   The L rung is UNCHANGED and still reads "Event Pass L active", which is
 *   what v17 #294 is about: a $44.99 buyer must not read their competition as
 *   holding the $11.99 product. The rule is `heldRungNeedsNaming` — name a
 *   held rung unless it is exactly the one rung on sale — so the letter comes
 *   back on its own the day a second rung does.
 *
 * RE-PINNED AGAIN 2026-09-07 — four surfaces, two per article, owner-approved
 * before the swap (entitlements v18 W3).
 *
 *   TWO were a FALSE PAID CLAIM, and they are the reason this is not a tidy-up.
 *   Both articles sold the pass as carrying "advanced formats including double
 *   elimination". Read against `plan_entitlements`: `formats.double_elim` is
 *   bool_value TRUE on community and has been since V393 — the format is free,
 *   and the pass was being credited with something every organiser already
 *   has. Replaced with "americano and ladders", which is `formats.advanced`,
 *   FALSE on community and true on both pass rungs, so the sentence now names
 *   what the money actually buys. This is the identical defect W3 fixed in
 *   `pricing.pass.f3`; the dictionaries have a guard for it
 *   (`localePaidOverclaimFaults`) and `content/help/**` did not, because that
 *   guard scans the four locale files and this tree has none. A matrix-backed
 *   guard now covers the billing articles too — see help-copy-truth.test.ts,
 *   "billing help does not sell a format community already grants".
 *
 *   TWO were the retired rung letter on a SELLING surface: plans.md's Event
 *   Pass bullet and event-pass.md's price-table header both read "Event Pass M
 *   — $11.99". The owner took the L rung off sale on 2026-09-05 and the suffix
 *   off every selling surface with it; `/pricing` and `/upgrade` were done in
 *   that wave and in `ad73763ca`, and the help tree still named a size that
 *   appears nowhere a reader can reach it. Figures re-read against
 *   `plan_entitlements` and unchanged (event_pass: 128 entrants, 10 divisions,
 *   4% against community's 5%).
 *
 * Nothing about a pass a customer already HOLDS changed: the "Event Pass M
 * active" marker, the receipt, and the pass's own grants are untouched, and the
 * rung is dormant in `plan_entitlements` rather than deleted.
 *
 * RE-PINNED 2026-09-24 — ONE surface added to event-pass.md, none changed or
 * moved: a "Device links and scorer sheets" bullet in "What the pass includes"
 * (surface 22, after "Advanced formats"). Owner-approved 2026-09-24 (relayed to
 * the implementer by the printable-scorer-sheets controller). The list had left
 * out a key the pass lifts. Read against: `lib/pass-features.ts`
 * (`scoring.device_links` is in PASS_FEATURES); `plan_entitlements` (community
 * FALSE — V240 seed, V117; event_pass and event_pass_l TRUE — V393); and
 * `server/usecases/device-links.ts`, whose ensure, Revoke & reissue and print
 * paths all resolve `requireFeature(…, "scoring.device_links", competition)`,
 * so a pass on THAT competition lifts it. No figure, price or window moved.
 */
export const APPROVED_EVENT_PASS_INVENTORY: string[] = [
  "7af62a47607d7223",
  "74fb0e84d81cf750",
  "7b44a9ceda103f3a",
  "0f6590c1fd0b70ad",
  "7d2b6bb67fc828d2",
  "9906a08781bbfbc3",
  "c8038bc5e87faf21",
  "d0495741c4edb2b5",
  "0db7160badf812ff",
  "976beed391d0884f",
  "0ba86d238db064af",
  "e6cf2a38bc6c024c",
  "dd3d5b5673e222ca",
  "b2cd535f2424c883",
  "a1fbda470105d463",
  "1f4d0c836719b26f",
  "193ac3fc3eb05678",
  "1b57ba96756ac962",
  "fcd1bcb9b15230dd",
  "9cdc77f8e4467e2c",
  "f8a66461cb7b0535",
  "00924962c38ce30e",
  "adede976a539f9fa",
  "219ccaea5a3878ae",
  "6feca5577c55cf2b",
  "170d10914abdbfe5",
  "32654b5a563aabb6",
  "d90e342a66f0ff56",
  "f1006b950ce393b1",
  "f39d96b7fbbbfc13",
  "665584fd0671d579",
  "3f3be96ac6e6be4e",
  "37f1d155a0e644b9",
  "3b3bc011debe7da5",
  "9a68888ef2d9aa1a",
  "4901d7ce5eea800a",
  "e83c931a71f7d62e",
  "81e902865f77d84a",
  "69fbd1e0e9c144ec",
  "8c072be7bd782c73",
  "a3ca58415ff21405",
  "774d4d6b3246dd97",
  "c42978cab6965d56",
  "331525dbff809017",
  "32654b5a563aabb6",
  "f9124c9f5c781c13",
  "f1006b950ce393b1",
  "1fe75e6f574e7583",
  "e561392e6cbc80d2",
  "0e1daac0eb19c834",
  "c5c24fdd24f71ce1",
  "867aceb779b0f4db",
  "4f264c9aab6192ce",
  "70414ad4d8194580",
  "ff1027402c486eac",
  "fa7fc864190f0cc0",
  "03c00c96e8e4b592",
  "f5f433f5d5994689",
  "813d51ff5b1e6a03",
  "fb4935c8a0600ef4",
  "2e4b128e7b5331ea",
  "09c784bdca897d29",
  "10c39c76a97d3772",
  "15be1bf424e38ba0",
  "d6294f4ea7c1dbb2",
  "2508d8869fe2a54a",
  "c503ebdc56e74a10",
  "3f08a1036ddefbd7",
  "49e759a1a332176d",
  "02427d5e988e6afa",
];

/**
 * The WHOLE of `content/help/billing/plans.md`, on the same terms.
 *
 * FIX ROUND 3 — this used to pin only the `## Event Pass` section, so the same
 * falsehood pasted into a sibling section raised zero faults. Scoping by section
 * is exactly how the earlier fee mutation escaped (it landed in a fine-print
 * list, not in a named paragraph), and every section of this file makes a
 * money-bearing claim: the fee ladder, the extra-organisation rate, the
 * proration table. Pinning the section and calling it the file was the same
 * defect as pinning the paragraphs and calling it the article.
 *
 * The cost is that every edit to any plan's copy now needs a re-approval. That
 * is a real tax on whoever edits this page next; it is recorded in the wave
 * notes so it is not mistaken for a broken test.
 */
export const APPROVED_PLANS_INVENTORY: string[] = [
  "bc2337dbe88e419f",
  "6b5d30ec51106068",
  "5ef78cfff635a513",
  "1e9a3c2b4d3941d7",
  "e5ac72886c19cefc",
  "8ee85036b1264382",
  "c315a996027a99ea",
  "9a4d219f071cc7fb",
  "f7c7084faf0e9fab",
  "d5a0df90dfe35a6c",
  "01b10f014d674ec5",
  "4dfe30f3187b4fef",
  "19cc31042b1e3028",
  "2f2961e11a66159d",
  "0ba155341fe9b6f0",
  "f8caf2ade16bbe59",
  "1bd31d9b7a370257",
  "63402ce5db94d1d1",
  "d2190ce79f9684a3",
  "0feb98b86f880f7c",
  "a0b053e3cc5a3cc7",
  "beaab221487f9585",
  "5be7274033911d5c",
  "077d725be913cdc7",
  "0acb8e961819e27a",
  "af7307c82e8109ec",
  "da146eaf5a60a77b",
  "36e15d26466a260a",
  "03e4c9c866a25934",
  "d2190ce79f9684a3",
  "bc09bd75cc18ee11",
  "3ceba9b2fd13b8c6",
  "3c0bb9276a12a253",
  "0ca68a771384ef53",
  "6fa96bd59b17b841",
  "09c784bdca897d29",
  "951db7b9a2c1569d",
  "b6e5cea0e6333bb4",
  "7ddb02c1405c7f9d",
  "36cda4bf12f7677b",
  "c75ef841931dc4cd",
];

/**
 * The WHOLE of `content/help/billing/add-ons.md` (v17 gap wave 7, task 7, #299).
 *
 * WHY A BRAND-NEW ARTICLE IS GATED FROM DAY ONE, rather than after it has
 * carried a falsehood the way the two above did. Everything on this page is a
 * statement about money an organiser is charged — what each add-on costs, on
 * what cadence, who may buy it, and what happens when it stops — and it makes
 * the rate claim (`no more than half the base rate`) that this wave has now
 * spent four rounds correcting on other surfaces. The two articles above were
 * pinned only after a lexical rule was measured at 1/12, 0/12, 6/30 and 1/40
 * against sets their own authors had not written; there is no reason to repeat
 * that experiment on a page whose claims are the same shape.
 *
 * ── A GATE PROVES DELIBERATE, NEVER TRUE ─────────────────────────────────────
 * Round 1 of this article was inventory-approved and shipped THREE false money
 * claims, and the `why` notes below named the very files that contradicted
 * them. That is not a defect in the gate; it is the gate's contract. Approving
 * a digest records that somebody chose these words — it cannot record that they
 * checked them. So each bullet below now states WHAT IS ASSERTED, in the words
 * the article uses, next to the code that decides it. Re-approving means
 * reading the file and confirming the assertion still holds, not re-recording
 * a hash.
 *
 * WHAT THE ARTICLE ASSERTS, AND WHAT DECIDES IT:
 *
 *  - "the credits themselves never expire", one-time, whole-wallet.
 *    `config/stripe-plans.json` `packs[]` (no `interval`), and
 *    `lib/entitlements.ts` `addonBonusForWallet` keying the sum on
 *    `coalesce(group_subscription_id, org_id)`.
 *
 *  - "raises ONE organisation's member limit by one", monthly, payer-only, and
 *    "added to your next invoice rather than charged on the spot".
 *    `server/usecases/extra-seats.ts` — `requireBillingOwner` (payer gate), a
 *    subscription ITEM on the group's existing subscription (`:79`), and
 *    `proration_behavior: "create_prorations"` on create/raise (`:75`, `:83`)
 *    against `"none"` on removal (`:64`). ROUND 1 SAID "charged pro rata
 *    straight away" AND WAS WRONG: `create_prorations` books the adjustment
 *    onto the NEXT INVOICE rather than charging immediately — stated in
 *    `server/usecases/billing-events.ts:738-740`, and the product's own UI copy
 *    already had it right (`en/ui.json` `addOns.extraOrg.prorateUp`, which
 *    deliberately does not say "now").
 *
 *  - "raises ONE competition's limit by 32", permanent, stacking, owner-gated,
 *    "never lifts an organisation-wide limit".
 *    `server/usecases/size-pack-checkout.ts` (owner-of-the-competition's-org
 *    gate; the group card only when that owner IS the payer; a 30s idempotency
 *    bucket that does NOT block a genuine second pack) and
 *    `stripe-plans.json` `size_packs[0]`. The scope claim is
 *    `addonBonusForWallet`'s `target_competition_id` predicate: a comp-scoped
 *    row cannot match an org-level cap read.
 *
 *  - "Pro covers 5 and Pro Plus covers 10" — `plan_entitlements.orgs.max_owned`,
 *    set by V314. Asserted against the LIVE matrix, not restated here.
 *
 *  - "no more than half the base rate" for a slot INSIDE the plan, and "on a
 *    monthly bill it matches that half rate exactly, and on an annual bill it
 *    does not … about a third more over a year".
 *    `lib/org-addons.ts:95-107` names this exact trap: the rider is a MONTHLY
 *    price on every plan, so an annual Pro group pays 900/month (~10800/year)
 *    for a rider against 7900/year for an in-plan slot. Measured from the seed:
 *    Pro $108/yr vs $79/yr (+36.7%), Pro Plus $228/yr vs $163/yr (+39.9%).
 *    ROUND 1 SAID "charged at exactly that same rate" AND WAS WRONG — an
 *    unqualified comparative price claim one clause after the one it had just
 *    qualified.
 *
 *  - "An extra seat stops you adding members, and makes the ones over the
 *    limit read-only … owners never are."
 *    `frozenMemberIds` (`entitlement-freeze.ts:103`) reads
 *    `getLimit(orgId, "members.max")`, which SUMS the add-on bonus, and exempts
 *    owners explicitly. ROUND 2 SAID "re-checked on every write" AND OVERSTATED
 *    IT: `assertMemberNotFrozen` has exactly ONE production call site,
 *    `server/api-v1/auth.ts:213-214`, gated on `via: session` AND
 *    `scope === "write"` AND `role === "admin"` — a bearer token returns from
 *    `apiKeyAuth` first, so API-KEY writes are never freeze-checked. What IS
 *    enforced everywhere is ADMISSION: `lib/invites.ts:63-69` counts the quota
 *    and throws `PaymentRequiredError` inside the same transaction as the
 *    invite grant. Role changes among owner/admin/viewer no longer check seats
 *    (the scorer pool and its promotion gate were retired in #707).
 *
 *    ROUND 3'S REPLACEMENT WAS ALSO WRONG about the surface: it said "enforced
 *    on our public API today", but on that API the normal caller is a bearer
 *    `sc_` key and `server/api-v1/auth.ts:204` (`if (token) return apiKeyAuth(...)`) returns
 *    BEFORE the check — so API-key clients are not checked either. (Cited as
 *    `server/api-v1/auth.ts:210` for two rounds; :210 is a comment.)
 *
 *    AND ROUND 3'S OTHER HALF WAS FALSE OUTRIGHT. It said the freeze reaches
 *    "not the app's own screens". `lib/client-v1.ts:23-27` sends only
 *    `Content-Type` — no `Authorization` — so an in-app component hitting
 *    `/api/v1/orgs/**` takes the SESSION branch of `requireOrgAuth` and IS
 *    freeze-checked. Five screens write through it: `components/api-keys.tsx`
 *    (Settings → API), `components/news/composer.tsx`,
 *    `components/org-sponsors.tsx`, `components/sponsor-packages.tsx` and
 *    `components/org-payment-instructions.tsx`. An admin over `members.max`
 *    would have read this article, been told the app was exempt, and then hit a
 *    402 in Settings → API and the news composer.
 *
 *    THE GUARD PINNED THAT FALSEHOOD, and the reason generalises: it counted
 *    the 13 `app/api/v1/**` routes reaching `requireOrgAuth` and never asked
 *    WHO CALLS THEM. Counting a surface proves its SIZE, never its REACH. It
 *    now discovers the in-app callers, requires each to be declared with the
 *    surface name the copy uses, requires the copy to name every one, and
 *    asserts no caller sends an `Authorization` header — which is the fact that
 *    makes them session-authenticated and therefore freeze-checked.
 *
 *  - "An extra organisation does not freeze anything … what it loses is the
 *    ability to add another."
 *    `orgs.max_owned` IS NOT A FREEZE AXIS. `entitlement-freeze.ts` freezes
 *    exactly two things — `competitions.max_active` (`:64`) and `members.max`
 *    (`:104`) — and `lib/billing-group.ts:411-414` states the cap is
 *    ADMISSION-ONLY: `assertWithinGroupCap` checks `count + 1 > limit` on the
 *    way IN and "is never re-evaluated against organisations that already
 *    exist". ROUND 1 CLAIMED THE EXCESS FREEZES AND WAS WRONG. The companion
 *    claim — that you cannot cancel your way over the line — is the 423 usage
 *    floor in `server/usecases/extra-orgs.ts:144-166`.
 *
 *  - "nothing is deleted" — `lib/entitlements.ts` `COUNTING_ADDON_STATUSES`:
 *    'canceled' is frozen-not-deleted (V323).
 *
 * NOT PINNED BY THIS INVENTORY, and therefore free to rot: link TARGETS.
 * `claimSurfaces` reduces `[text](/url)` to `text`, so repointing a `mailto:`
 * or a help URL raises zero faults here. (Distinct from the link-TITLE hole,
 * filed as #338.)
 */
export const APPROVED_ADD_ONS_INVENTORY: string[] = [
  "58a683b53e5184b9",
  "3c91c5603471c7ec",
  "4fead1c6b8b471ba",
  "535adfa4bbb23fb0",
  "7bc95c0f047118eb",
  "ecd4ad8f51fde6ab",
  "7a3863a273a702d6",
  "fe1787304c8e8f0c",
  "696896c6174d0812",
  "81f45d76b157c68a",
  "5cbbcf82d4703a2e",
  "628281436c3b5d97",
  "57ab4cb8d1c7ae64",
  "dd3682cfbbbd86eb",
  "904600a779329e0b",
  "81ba6ce07303ccdc",
  "2884caabfd4cb14f",
  "bbaba7db595534ff",
  "80ea0dd21adfd486",
  "00df8be3e9bd06ef",
  "df7321201a99bd2c",
  "7151ed1350e7f11f",
  "7d1518387c5c90e4",
  "d1d87a9a3dbdeb8e",
  "b50fa0d68d469172",
  "43d91a56e8035992",
  "7e9eaa52377fc2e6",
  "89e6a00cfa216278",
  "e0bc899381ce86af",
  "fe061d7659564782"
];

/**
 * The WHOLE of `content/help/billing/groups.md` (v17 gap wave 7, task 7, round 3).
 *
 * GATED BECAUSE THE VOCABULARY WAS MEASURED AT 0/24 ON IT. Off-vocabulary false
 * rate claims pasted into this file — "costs 50% of the base rate", "half as
 * much as the first", "half of what the plan costs", plus native es/fr/nl —
 * shipped 119/119 green, as did an entire new help article. The same edit to
 * the gated `add-ons.md` redded immediately.
 *
 * That number also bears on the computed half-rate axis in
 * `help-copy-truth.test.ts`: the axis is computed THROUGH `en.halfClaim`, so
 * membership was being decided by a regex that catches almost nothing. Gating
 * the two articles on the axis is what makes the axis mean something.
 *
 * WHAT THIS ARTICLE ASSERTS, AND WHAT DECIDES IT:
 *  - the extra-organisation rate, five times — `stripe-plans.json`'s graduated
 *    tiers via `riderClaimShape`; only "no more than half" is true in all
 *    twenty plan x interval x currency combinations.
 *  - WHEN THE ATTACH CHARGE LANDS. `attachOrgToGroup` bills entirely through
 *    `syncGroupQuantity`, whose only Stripe mutation is
 *    `subscriptions.update` with `create_prorations`
 *    (`billing-groups.ts:327-330`) — the NEXT invoice, not the card, and the
 *    same behaviour the add-on paths have. Round 2 said "charged now" on six
 *    surfaces here on the strength of a stale comment.
 *  - the dunning window — real, but it is the next INVOICE that can fail;
 *    nothing is attempted against the card at attach.
 *  - "Removing never refunds, and adding never takes money from your card there
 *    and then" (`## No refunds, and the freed slot`). ROUND 5: this said
 *    "adding ALWAYS CHARGES IMMEDIATELY", false three ways — prorations book to
 *    the next invoice (`billing-groups.ts:327-330`), a freed-slot attach raises
 *    no proration at all (`previewAttachCharge:122`, `raising` requires
 *    `active > quantity_paid`), and a trial attach charges nothing (`:123`,
 *    `:320`). It also contradicted line 41 of this same article, which round 3
 *    had corrected.
 *
 *    THE GATE FROZE IT FAITHFULLY FOR TWO ROUNDS. That is not a failure of the
 *    gate; it is the gate's contract, and this wave's thesis in one line: an
 *    inventory proves a wording was DELIBERATE, never that it was TRUE. Only
 *    reading the sentence against `billing-groups.ts` found it, which is the
 *    step the fixture exists to force and which nobody had performed on this
 *    paragraph.
 *  - the freed slot, the fee lock, payouts, the detach modes — see the
 *    per-section notes in `server/usecases/billing-groups.ts`.
 */
export const APPROVED_GROUPS_INVENTORY: string[] = [
  "6dfdc975fd75c021",
  "56e3282cee657350",
  "889eb9bb8adb1b8f",
  "0b3f064c075f4830",
  "2c08e52c75400e40",
  "d9d2fda79e6acad3",
  "650ab572d939bca6",
  "f78e9f343b9dc2e8",
  "d2190ce79f9684a3",
  "0feb98b86f880f7c",
  "beaab221487f9585",
  "5be7274033911d5c",
  "a1d537317da5529d",
  "d5ddc1b7a27ed12b",
  "e12f4df63f6cc9ea",
  "03db06a1af2d3405",
  "8cca87480a6deb54",
  "696c2fcc2ecfec40",
  "a052c3f07ce2508c",
  "0efcbcbfd21cd2d3",
  "f3e48e76dfb4c932",
  "71f2718498988d98",
  "19f8dbd797ab2df3",
  "86457c10b518c75c",
  "670d6537399af0cb",
  "44b8772e6777bd12",
  "8d62189b191b015f",
  "bb6e0a58fdb569a4",
  "93cbb9e0a733ea84",
  "a082daadd09b8b31",
  "76f844d7c521260b",
  "99dafbaddeddd281",
  "ce62fde77df9f3cb",
  "af77535948d286c5",
  "791c29feee358ae2",
  "3b9f1b1cb23117b0",
  "afe3dfcd35264bc9",
  "45ac520e121a63aa",
  "845db4ff8eae0223",
  "3812af4fc53ba873",
  "7e50122fa44a6f4b",
  "f1eec393ae73101f",
  "e20498cfa56931d3",
  "858c8b7b0159c14f",
  "af0c83ae6240326a",
  "eb9b66040aaa25d8",
  "5b365c93cb4a5637",
  "7104f26a03ffde1e",
  "537d992c53d3e378",
  "cc5546e9475093dd",
  "68ae3680386824c4",
  "1687f37c2560ab80",
  "2a82d5d161253e15",
  "79756849efc57255",
  "25eb5c468a8a54a2",
  "9eb0591ae278ad76",
  "37e0ccd2e5e57b16",
  "80a8c63adbf7acf6",
  "aa38f07aed66bd26",
  "3b68d1b4c3fc4888",
  "cbfceb3121b039d5",
  "14babe148d741a28",
  "c1952e825277a576",
  "5a31bc0dd92a9d01",
  "529f239aa64eaa4e",
  "ef90d0b1078b0b3d",
  "7a89a4a943513245",
  "19438b187f04e834",
  "84701e090fcbf515",
  "ddc8366bdf93737f",
  "44a3cac6b1327242",
  "29c9a5af721c8abb",
  "a04e4219f607e695",
  "2b57b36732a3e9fb",
  "16727d4791a0a08b",
  "c5c32d350da1d6b1",
  "09c784bdca897d29",
  "3d324adb3ee0b927",
  "636714ad25e8f991",
  "1415f62ed176347a",
  "a83851ffc59ddfeb",
  "290e525981e1463d",
  "364b1c1d4b1409c9",
  "8d2ecf6ae325690e",
  "7dde35de16939fb2",
  "2f102e765460c832",
  "3b281af0174847e4"
];

/**
 * The WHOLE of `content/help/getting-started/create-your-organisation.md`
 * (v17 gap wave 7, task 7, round 3).
 *
 * A file nothing in this wave had opened until the review found it stating the
 * extra-organisation rate at `:25`. Small, and gated for the same measured
 * reason as `groups.md`: it is a funnel page, it quotes the fee ladder and the
 * plan org caps, and the vocabulary that was supposedly defending it scored
 * 0/24.
 *
 * WHAT IT ASSERTS: the fee ladder (8/5/2/1, `plan_entitlements`
 * `registration.fee_percent`), the plan org caps (5 / 10, `orgs.max_owned`,
 * V314), the extra-organisation rate (`riderClaimShape`), and that Community
 * can already take card entry fees.
 *
 * Surface 11 ("Who can see my organisation?") re-approved 2026-09-27 for the
 * owner decision that a DRAFT competition is unlisted until published: the
 * org page lists Public AND published only (`listOrgHomeCompetitions`), and a
 * new competition is a public draft reachable by link and open to register.
 */
export const APPROVED_CREATE_ORG_INVENTORY: string[] = [
  "5a9aee8c75f74828",
  "c7abb53b293957ff",
  "7780e9adec7a42e1",
  "97afdcb5cc7373e9",
  "332fd65e1bd72032",
  "b29441d979e91695",
  "b389c86ad2de4a26",
  "7e96998f849cb38b",
  "09c784bdca897d29",
  "98cabe982ddf445c",
  "ad7ae2d3a170de2f",
  "ec33da78b550dcac"
];
