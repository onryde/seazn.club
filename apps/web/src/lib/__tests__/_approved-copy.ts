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
    why: "the pass's SCOPE — one competition, and only while that competition runs. Source of truth: lib/entitlements.ts (org_has_feature, PASS_END_GRACE_DAYS) and V328/V334. RE-APPROVED 2026-11-22 (Task 14a rewrite): same scope, house voice.",
    text: "An Event Pass upgrades one competition while it is running. You pay once, and there is no subscription. It suits the event that comes round once or twice a year: the club championship, a fundraiser, a school sports day.",
  },
  {
    id: "event-pass.md#fee-lock",
    find: /^The pass's lower platform fee applies/,
    why: "what an entrant is charged after the pass ends. Source of truth: server/usecases/registrations/checkout-completion.ts — it is the ONLY writer of competitions.fee_percent, its `and fee_percent is null` makes the stamp first-wins, and it records what the first paid CARD entry was actually charged (an offline entry carries no rate). A pass bought after that entry cannot lower the locked rate. RE-APPROVED 2026-11-22 (Task 14a rewrite): the same three cases — locked on the pass rate, locked before the pass, and unlocked — in house voice.",
    text: "The pass's lower platform fee applies to entries paid by card while the pass applies. If the competition takes its first paid card entry while the pass applies, its platform fee is locked at the pass's rate for every later entry, even after the pass ends. If it took a paid card entry before you bought the pass, its platform fee stays locked at the rate that first entry was charged. After the pass ends, a competition with no paid card entry yet follows your plan's rate.",
  },
];

/** `content/help/billing/event-pass-ends.md` — split out of event-pass.md in
 *  Task 14a (2026-11-22). The "when it stops" paragraph moved here with it. */
export const APPROVED_PASS_ENDS: ApprovedParagraph[] = [
  {
    id: "event-pass-ends.md#when-it-stops",
    find: /^An Event Pass lifts its competition while/,
    why: "WHEN the pass stops applying. Source of truth: lib/entitlements.ts (PASS_END_GRACE_DAYS = 7, completed/archived) and V334. Moved from event-pass.md#when-it-stops in Task 14a; driven on the helpview environment (7 days past the end date still active, 8 days past ended).",
    text: "An Event Pass lifts its competition while the competition is running. It stops applying when:",
  },
  {
    id: "event-pass-ends.md#ended-reason-end-date",
    find: /^- Nothing is deleted — this competition is past its end date/,
    why: "the product's own banner, quoted verbatim: dictionaries/en/ui.json `pass.entry.ended.reasonPastEnds`. It is a pass-duration claim in no allowlisted FORM, so it is pinned word for word instead — a change to the product string must be re-read here. Source of truth for the state it reports: lib/entitlements.ts (`past_ends_on`, PASS_END_GRACE_DAYS).",
    text: "- Nothing is deleted — this competition is past its end date, so its Event Pass has stopped lifting its limits. Update the end date if it is still running.",
  },
];

/** `content/help/billing/plans.md`, the `## Event Pass` section only. */
export const APPROVED_PLANS_PASS: ApprovedParagraph[] = [
  {
    id: "plans.md#event-pass-opening",
    find: /^An Event Pass is a one-time payment that lifts one competition/,
    why: "the pass's scope again, on the page most readers meet first. It said 'for that event's lifetime' until this wave, which V328/V334 contradict. Source of truth: lib/entitlements.ts. RE-APPROVED 2026-09-05 (owner decision: the L rung off sale): the trailing 'it comes in two sizes, and the only difference between them is how big that one event may get' went with the size ladder it introduced. The load-bearing half — 'while that competition is still running' — is untouched, which is the clause this fixture exists to hold. RE-APPROVED 2026-11-22 (Task 14a rewrite): 'lifts one competition while it runs' carries the same clause; the caps are tokens (proseBlocks drops their underscores, which is why the text reads 'percompetition').",
    text: "An Event Pass is a one-time payment that lifts one competition while it runs. It raises that competition to {{plan:divisions.percompetition.max:eventpass}} divisions of {{plan:entrants.perdivision.max:eventpass}} entrants and adds most of Pro's features to it. There is no subscription.",
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
 *   (event_pass: 128 entrants, 10 divisions, 3% against community's 5%) and
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
 *
 * RE-PINNED 2026-11-02 — that bullet is REMOVED again, one surface gone, none
 * changed or moved (every later surface shifts up one position, digests intact).
 * Owner ruling 2026-11-02 ("make it free"): remote scoring (device links, the
 * scoring QR) and the printed scorer sheets that carry its links are free on
 * every plan, so a pass no longer lifts anything there and the bullet would
 * have sold a Community org what it already has. Read against: `V488`
 * (`scoring.device_links` true on every plan in `plans`); `lib/pass-features.ts`
 * (the key left PASS_FEATURES); `server/usecases/device-links.ts` (no gate call
 * remains). The removed digest was 00924962c38ce30e.
 */
/*
 * RE-PINNED 2026-11-22 (help programme, Task 14a — the billing rewrite). Every
 * surface of event-pass.md, plans.md and add-ons.md was rewritten in the house
 * voice and checked sentence by sentence: driven on the helpview environment
 * where a screen could be reached, code-read (file and line on the Task 14a
 * claim sheet, BL rows) where it could not — every checkout, invoice and
 * proration claim is code-read, because no Stripe sandbox was reachable. A
 * digest proves the wording was CHOSEN, not that it is true: review 1 found
 * three approved paragraphs false (API refusal text quoted as screen copy, a
 * finished competition said to stay finished, the extra organisation priced
 * without its seat), all corrected and re-pinned in fix round 1. Plan
 * figures are now `{{plan:<feature>:<plan>}}` tokens, resolved from
 * plan_entitlements at render, so no digest here pins a number.
 *
 *   event-pass.md — split into three pages. This one keeps what the pass is,
 *   what it changes (a Community / Event Pass / Pro comparison table), the fee
 *   lock (golden "event-pass.md#fee-lock") and where it is offered. Buying moved
 *   to buy-an-event-pass.md and ending to event-pass-ends.md, each now gated
 *   below. Read against lib/entitlements.ts (PASS_END_GRACE_DAYS = 7),
 *   lib/pass-features.ts and server/usecases/registrations/checkout-completion.ts.
 *
 *   plans.md — sections renamed ("Community, the free plan", …); the extra-
 *   organisation rate moved out to billing/groups.md (plans links to it).
 *
 *   add-ons.md — the size pack and extra seat are no longer described (no
 *   screen sells either); extra organisations, their timing, the floor and the
 *   annual divergence are restated. Read against server/usecases/extra-orgs.ts
 *   and lib/billing-group.ts.
 */
export const APPROVED_EVENT_PASS_INVENTORY: string[] = [
  "7af62a47607d7223",
  "df693590fa631354",
  "a9ea405a3ad2513e",
  "0a3180517e9fd935",
  "95589dd3a0ce9957",
  "c27678f55e74fd41",
  "d96820bb60012e5f",
  "72d25d5c1ac4d390",
  "7bc95c0f047118eb",
  "dc6c0d1b03ea81a7",
  "82eb863bafe621ef",
  "ea7a4ce7f746a7d3",
  "cc04b97bd05b9257",
  "38814ac79213129b",
  "6fd8f81c667c0c20",
  "08d435dfaa3d7aab",
  "50010d1a099d7766",
  "0cd616fcc55033d0",
  "fb9eba15c72d7d99",
  "09ae4cd5cfabd421",
  "ddb295ebbe24002f",
  "7bc08add4baa8871",
  "47575ba7b53d0edb",
  "a43842a611fc3a7a",
  "356e3e87f193429b",
  "b90d6ce033e2aacc",
  "363febc178ed3a6d",
  "013e3950b602f09c",
  "40fbc88927e20225",
  "73aa826ddff87619",
  "3442438e57357be2",
  "04f19471d6641a4d",
  "2c71ecc7e7b6fd93",
  "a0aa3d50e6ac79e4",
  "bf30ae9cd2bdbde8",
  "79fe07dbdd2047af",
  "5ca9255bef66b31f",
  "2cbb33072d1f7a5b",
  "5c8fc0ddc9ef6839",
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
  "742131b670aabf12",
  "c6896e734d6f2567",
  "06c3d80394b3a06f",
  "a1330a9ad92e694e",
  "fffb7fb8767c562c",
  "c4a523618fddf525",
  "5abd5d7c49b2abf8",
  "30b74e6a4b004fc6",
  "d024934a043c3d4e",
  "0a643f38160e341c",
  "ec1d53a0ec462394",
  "7bc95c0f047118eb",
  "b217a47301620eaf",
  "8bfb40fcd8ffe0f8",
  "527ba306d1edf38a",
  "6f9ac73dcaa3d891",
  "898f66f1950b3f2d",
  "bd2d0324288ca7d0",
  "b367086d899ca871",
  "bf503dea252a6126",
  "ef60e59e66b125f2",
  "b3d6a35eb89bf4aa",
  "8d492ed84863d364",
  "f5efc5625de91596",
  "a07947b88760f99c",
  "517e0c7d69b84931",
  "c61819aba823adc7",
  "5763f3e946991ded",
  "631d2073630b49af",
  "5394abf0df6228e4",
  "3051b1364a98c37a",
  "466b9af18f9265c5",
  "08d435dfaa3d7aab",
  "6fd8f81c667c0c20",
  "fb9eba15c72d7d99",
  "27d809e44bcd0c50",
  "de40e564e0c514b0",
  "85507f8c30071ee8",
  "1335362aa1c1d4ae",
  "fcfdfee6d9ddaac2",
  "64292216a6fb9bd2",
  "781ff1aa18a168a6",
  "f8caf2ade16bbe59",
  "3346f44e2631b5f2",
  "63402ce5db94d1d1",
  "d2190ce79f9684a3",
  "66c3e5bf1cd62bf3",
  "324e09b50ed2eba1",
  "050378df2e0b9f83",
  "fb6784c7c8704d6b",
  "e099a23869b52e2c",
  "bf4cd5d95fc08c3d",
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
 *    `server/usecases/billing-events/addon-pricing.ts:57-59`, and the product's own UI copy
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
 *    `components/org-sponsors.tsx`, `components/sponsors/package-list.tsx` and
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
  "95758731e8170665",
  "41f59869d0dbd02d",
  "e3cae01efe43902a",
  "ebaec4c9f5c3663d",
  "d5f73bda47875d4e",
  "6925f39c940c0bb0",
  "ba8d5bf6b0572fb2",
  "e614b13437ed5dc8",
  "bb63ca797ef10b05",
  "28f12b2b834df2df",
  "b8f5e542d445d9e6",
  "645896687d211be4",
  "bd670d22e1287fc6",
  "50f9b1680c2878b4",
  "10c158b6c7afaa0a",
  "8f551ce862d16274",
  "a4f8a535efd410b9",
  "463e04b079ea975c",
  "68121f9a4c367ac6",
  "5add2c71d059c34d",
  "121521cf75fbfacb",
  "14d38e2315c09ee7",
  "43f5dd1ed53b3332",
  "277dc6a416f9d610",
  "902edb76c61603ca",
  "960a7c4066c63744",
  "fcaf46e826f9dd6c",
  "16ff7beb0cc8f08f",
  "fc28ee19aff958ad",
  "b121e1d12d78af05",
  "62b8b329eb1d0fb5",
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
 * WHAT THIS ARTICLE ASSERTS, AND WHAT DECIDES IT (re-approved in Task 14b,
 * when the 3,300-word page was split by job; adding, removing and handing over
 * now live in add-an-organisation.md, remove-an-organisation.md and
 * hand-over-a-bill.md, which make NO half-rate claim and so are off the axis):
 *  - the extra-organisation rate, once ("What it costs") — `stripe-plans.json`'s
 *    graduated tiers via `riderClaimShape`; only "no more than half" is true in
 *    all twenty plan x interval x currency combinations. No price is typed: the
 *    page links /pricing and says the attach dialog shows the amount
 *    (`previewAttachCharge`, `billing-groups.ts:129`).
 *  - the organisation caps and the fee ladder — `{{plan:…}}` tokens, read from
 *    plan_entitlements at render.
 *  - the fee lock — first-wins stamp in
 *    `registrations/checkout-completion.ts:465`.
 *  - who pays and what the payer can open — `page-auth.ts:199-245`
 *    (`requireBillingPage`), the guest owner's `billing.billedBy.named`
 *    (`o/[orgSlug]/settings/billing/page.tsx:403-410`).
 *  - the every-organisation-suspended answer — `groupOrgLimit`
 *    (`lib/billing-group.ts:183-221`); its two claims are also pinned by
 *    `server/__tests__/help-groups-suspension.test.ts`.
 *  - the payer deleting their account — `app/api/users/me/route.ts:104-121`.
 *  - the Event Pass credit — `pass-credit.ts:297-330` (most recent pass of the
 *    buying org, 30 days, once per group).
 *
 *    THE GATE PROVES DELIBERATE, NEVER TRUE. Every surface above was re-read
 *    against the file named beside it before these digests were taken.
 */
export const APPROVED_GROUPS_INVENTORY: string[] = [
  "70406cfe0fe3385a",
  "9b34a88bcf6b26d7",
  "82ad58f71300bb0b",
  "100fc02796b81b33",
  "66adfe014ecc487d",
  "5598a40b219f6f07",
  "960ffcbe3004ff7a",
  "3bf48466197914f2",
  "4614431269bdad76",
  "32ab7fcccdf14c08",
  "9e428b3ee9865afa",
  "f78e9f343b9dc2e8",
  "d2190ce79f9684a3",
  "66c3e5bf1cd62bf3",
  "050378df2e0b9f83",
  "fb6784c7c8704d6b",
  "ad0fc64be53f1daf",
  "ddc8366bdf93737f",
  "6b8ffd79cfadc635",
  "28aee6c7e00e1c33",
  "15317f9c60cde9f8",
  "f5599c0a037f5c56",
  "63a4368110cb3fad",
  "6870f62c36ba5d08",
  "1f2344a2d5e86df6",
  "c671cb1822c10f6c",
  "2b57b36732a3e9fb",
  "9ad2895503dafd61",
  "09c784bdca897d29",
  "b9d586c7d2527beb",
  "6c9da5b6c3f7231a",
  "bdc4e8f0561e135c",
  "408f592f5e3fed13",
  "50ae94f06b03dedc",
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
 * org page lists Public competitions past draft — published, live, completed
 * or archived (`listOrgHomeCompetitions`: `status <> 'draft'`) — and a new
 * competition is a public draft reachable by link and open to register.
 * Re-approved again the same day (review item 8): "Public and published" read
 * as if a live or finished competition dropped off the page, which it does not.
 * Re-approved 2026-11-04 (LIVE1): the public page moved from `/shared/your-org`
 * to `/live/your-org` (`routes.publicHub(org)`; the org home under the
 * moved `(public)/live` tree still lists through `listOrgHomeCompetitions`
 * in `server/public-site/data.ts`); only the path changed, the claim did not.
 */
export const APPROVED_CREATE_ORG_INVENTORY: string[] = [
  "5a9aee8c75f74828",
  "c7abb53b293957ff",
  "7780e9adec7a42e1",
  "97afdcb5cc7373e9",
  "332fd65e1bd72032",
  "b29441d979e91695",
  "b389c86ad2de4a26",
  "75ff1142c46e7346",
  "09c784bdca897d29",
  "98cabe982ddf445c",
  "3b7f53eba6ec307f",
  "ec33da78b550dcac"
];

/** Every user-visible surface of `content/help/billing/buy-an-event-pass.md`,
 *  split out of event-pass.md in Task 14a (2026-11-22). Who can buy, the
 *  checkout, the refusals and when a competition closes to passes — each read
 *  against app/api/billing/pass-checkout/route.ts and lib/entitlements.ts
 *  and driven on the helpview environment (Task 14a claim sheet). Gated from day
 *  one: it is money copy. */
export const APPROVED_BUY_PASS_INVENTORY: string[] = [
  "c73139ddc9789671",
  "7a01d2f2cc74de5e",
  "dea2ec39ded036dd",
  "9df2569fa41e977b",
  "96ef6868cf0aa234",
  "9a140822010acac6",
  "92620ca2a81f2c5e",
  "fc61eeb129eefbd5",
  "d682fb5bdc0fb1f7",
  "d6bb793bdd9153a7",
  "676b8f60a1cf656c",
  "99472764b41be9b0",
  "ddb02a507c342d14",
  "141f98762fb2f282",
  "9b6c68dd4b483249",
  "a75386d8147ad724",
  "83a8e47b6c695587",
  "95247b4cc6e5b740",
  "93743129913b6a1d",
  "a283bab1ba1b5a75",
  "339db44a7d003dee",
  "b732633a6a2698b6",
  "dc372937dae68303",
  "18eeab7c0d735ce0",
  "f1431f56abbc20c2",
  "487e95de5aeef702",
  "73a088018b4b2fc5",
];

/** Every user-visible surface of `content/help/billing/event-pass-ends.md`,
 *  split out of event-pass.md in Task 14a (2026-11-22). When the pass stops,
 *  what the reader sees, what changes (the fee lock included) and how to get
 *  it back. Read against lib/entitlements.ts (PASS_END_GRACE_DAYS = 7) and
 *  driven on the helpview environment. */
export const APPROVED_PASS_ENDS_INVENTORY: string[] = [
  "439c53e3060bf1bf",
  "9827df5ad16103a6",
  "6378d548b3285eb4",
  "bffc0df00f8fcba4",
  "78cce18802fed1e4",
  "46c3efc6696e7d22",
  "42c716275dcfb6db",
  "ab11432b1bfa8fa7",
  "9e0763f9cb6d69a5",
  "7282a075449b6ef1",
  "d6bba59d1dfa2139",
  "c1c461919a1ffc35",
  "84d194ba50ecd90e",
  "de0809717f04dae5",
  "abb5cd5edd3443f2",
  "ca66f34c629d7358",
  "0d9b5c0aa957085e",
  "a254722b2d002e87",
  "5214ff60024f227c",
  "e31f9a2f6ea1ce2b",
  "67e0474fba7fabcb",
  "d8bcc184595b57d8",
  "e75c8da3b0fc3057",
  "c6170f9ab947f596",
  "bf350a0418ba9078",
  "7f889bb823d1e024",
  "72950fee3ebe84f2",
];
