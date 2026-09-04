# W2 — matrix & plumbing (entitlements v18)

**This file supersedes `2026-09-03-entitlements-w2-matrix-and-plumbing.md`** (note the
"and"), which the W1 session wrote before W2 began and which was deleted in this wave. It
was a Tasks 0-9 skeleton that still named V391 for the matrix migration — now **V392**,
after main's own V391 collided with it — and carried none of the owner rulings made during
execution. Two plans for one wave is how the wrong one gets read; there is now one.

Branch `feat/entitlements-w2-matrix-plumbing`, cut from `main` @ `ae0751682`.
Brief: `../specs/2026-09-02-entitlements-v18-prompts/W2-matrix-and-plumbing.md`.
Design of record: `../specs/2026-09-02-entitlements-v18-three-tier-design.md`.
Decision log: `../specs/2026-09-02-entitlements-v18-prompts/_INDEX.md`.

W2 makes the three-tier matrix true in the database and in code. No customer-facing
surface work — that is W3.

## Owner decisions taken 2026-09-03, before any code

1. **Pro monthly base is USD 12, not 9**, and the whole set-point table re-anchors on
   it (the other four currencies are set points anchored on USD, not FX — leaving them
   at §3a would put AUD 12 = USD 12 and break the stated "AUD reads against a 15–20
   norm" rationale). AUD was removed outright later the same day (T10), so that
   rationale is now historical — the re-anchoring of EUR/GBP/INR still stands on its
   own, since each is a set point against a local norm rather than an FX conversion.
2. **Tier 2+ stays at §3a's rule — half the base**, rounded down to a whole major
   unit (INR to the nearest x99). A 60% rate ($7 extra org) was chosen and then
   REVERTED by the owner once its true cost was measured: `extraOrgPrice()`'s own
   comment says the prose "half your plan's rate" is repeated across four locales,
   and `extra-org-price-parity.test.ts` names the surfaces — 6 dictionary keys × 4
   locales, `config/tips.ts`, both seed product descriptions, 3 help articles and 2
   e2e specs, ~30 edits. Holding the ratio keeps W2 out of the dictionaries
   altogether, which is what the Pro Plus split ruling wanted. **The extra
   organisation is $6, not $7** — do not "restore" the 60% figure from an earlier
   draft of this file.

   Note the INR consequence of the x99 rule: ₹499 ÷ 2 = ₹249.50, and the nearest
   x99 below that is **₹199**, so INR tier 2+ is 40% of base rather than 50%. That
   is the rule working as written (today's ₹1,399 → ₹699 rounds the same way).

   **CORRECTION (2026-09-03).** An earlier version of this line claimed the parity
   guard "asserts at-most-half, not exactly-half". That was wrong, and was written
   from the test's header comment rather than its assertions — a grep standing in for
   a read. `extra-org-price-parity.test.ts` ALSO carried a lower bound of 45% of base,
   which ₹199 of ₹499 (39.9%) fails. The bound was re-derived as one rounding STEP
   below half (₹100 for INR, one major unit elsewhere), because rounding to a grid
   costs a fixed amount and so eats a larger fraction of a cheaper plan. It still
   kills a rider set to half of half.

   **Owner ruling 2026-09-03**, put explicitly with the alternative on the table:
   keep ₹499 and the re-derived bound. ₹599 would have landed the rider at 49.9%
   and needed no guard change; rejected because it costs the volume market R12 is
   courting 20%, and because the rounding error runs in the CUSTOMER's favour —
   they pay less than half, and no copy claims exactly half.

8. **Orphaned Pro Plus riders: left as-is, both parked tests deleted (owner ruling
   2026-09-03).** `isOrgAddonItem` matches `lookup_key` against the catalog set and
   `stripe-sync` never prunes, so a subscription still carrying
   `seazn_extra_org_pro_plus_monthly` is unrecognised — never re-priced, never
   synced, never alerted, and still billing. Sandbox-only, no real money, so the
   owner ruled it not worth code that outlives Pro Plus. **This is a known silent
   billing path and must be closed before a live Stripe catalogue exists** — it is
   recorded in `_INDEX.md` as owed, not fixed.
3. **Event Pass L rises** to 39 USD. Bounded by §3a's own prose on both sides:
   `3 × L ≥ annual` (the nudge) and `2 × L < annual` ("a two-tournament organiser is
   never pushed into a subscription"), which pins USD L to 33–49.
4. **Event Pass M stays 15** — the approved R14 mockups print it, and it gains nothing
   from moving.
5. **W2 ships a minimal safe "Contact us" CTA** (plan-label entry + upgrade-gate /
   plan-badge mailto). No design work; it exists only so an enterprise-gated feature
   cannot render an undefined plan label in the wave between W2 and W3. The DESIGNED
   pricing page and billing settings remain W3's.
6. **`pro-plus-tier.spec.ts` and `pricing-pro-plus.spec.ts` are deleted in W2**, with
   the replacement debt (`pricing-v18.spec.ts`, `enterprise-gate.spec.ts`) recorded in
   `_INDEX.md` as owed to W3.
7. Greenfield reconfirmed by the owner: no prod data. R7 stands — `pro_plus` deletes
   unconditionally, no grandfathering.

### The price table as it will be written (major units; the seed stores minor)

| | USD | EUR | GBP | INR |
|---|---|---|---|---|
| Pro monthly tier 1 | 12 | 10 | 9 | 499 |
| Pro monthly tier 2+ / extra org add-on | 6 | 5 | 4 | 199 |
| Pro annual tier 1 | 99 | 89 | 79 | 3,999 |
| Pro annual tier 2+ | 49 | 44 | 39 | 1,999 |
| Event Pass M | 15 | 14 | 12 | 599 |
| Event Pass L | 39 | 35 | 29 | 1,599 |
| Extra seat / month (hidden, R13) | 2 | 2 | 2 | 99 |
| Size pack +32 | 5 | 5 | 4 | 199 |
| AI credit packs | unchanged | | | |

**AUD is GONE** (ruling below, T10) — four currencies, not five. Its amounts are
struck from every row above; do not reinstate them from an earlier draft.

In minor units, as the seed stores them (USD rides `unit_amount`; `currency_options`
carries only `eur/gbp/inr`):

| | usd | eur | gbp | inr |
|---|---|---|---|---|
| pro monthly tier 1 / tier 2+ | 1200 / 600 | 1000 / 500 | 900 / 400 | 49900 / 19900 |
| pro annual tier 1 / tier 2+ | 9900 / 4900 | 8900 / 4400 | 7900 / 3900 | 399900 / 199900 |
| event_pass / event_pass_l | 1500 / 3900 | 1400 / 3500 | 1200 / 2900 | 59900 / 159900 |
| extra_org_pro | 600 | 500 | 400 | 19900 |
| extra_seat | 200 | 200 | 200 | 9900 |
| size_pack_32 | 500 | 500 | 400 | 19900 |

Rules, verified in all four currencies: annual ÷ monthly ∈ 8–9 (8.25 / 8.90 / 8.78 /
8.01); tier 2+ ≤ half the base (6≤6, 5≤5, 4≤4.5, 199≤249.5 monthly; 49≤49.5,
44≤44.5, 39≤39.5, 1999≤1999.5 annual); M < L < annual; 3 × L ≥ annual (117≥99,
105≥89, 87≥79, 4797≥3999); 2 × L < annual (78<99, 70<89, 58<79, 3198<3999).

Consequences to carry into W3: the design's "revenue per Pro org falls 53%" is now
~37%, and the approved mockups print the old $9/$15 pair. Both are W3's to amend.
§3a's own price table is superseded by the one above and must be rewritten there too,
so the spec does not contradict the seed. The "half the base rounded DOWN" RULE in
§3a survives unchanged.

## Premises re-pinned against the tree — eight corrections

The brief asks to be told when it is wrong. It is wrong in eight places.

1. **W1 is merged.** PR #704 merged 2026-09-03T09:11:53Z as `ae0751682`. W2 branches
   from `main`; there is no W1 branch to run against.
2. **`PASS_CREDIT_GRANT` has three read sites**, not two: `billing.ts:16`,
   `copy-truth.ts:40`, `pass-ladder.ts:12`. Defined `pricing-cards.ts:61`.
3. **`pass-credit.ts` is a different concept.** It credits a pass PURCHASE PRICE
   toward a subscription (`creditPassTowardSubscription`); it never imports the grant
   constant. Design §6 names it in error. Nothing owed there.
4. **Credits are DB-only.** `monthlyPerSeatByPlan` is the single read site, but the
   numbers live solely in `plan_entitlements` (`credits.ts:311-313`). No `10/60/200`
   literal exists in code — Free 5 / Pro 35 is a migration change, not a code change.
5. **The Pro Plus footprint is 28 non-test source files**, not the brief's 31 or the
   spec's 33 (51 if `src/config/*.json` and `scripts/` are counted). Plus 68 test
   files and 8 e2e specs.
6. **There are more plan-key mirrors than the brief's six.** The three `z.enum` sites
   are right (`types.ts:203`, `api/billing/plan/route.ts:6`, `.../preview/route.ts:6`),
   but `entitlement-admin.ts:37-43` (`ADMIN_PLAN_KEYS`) and `currency.ts:85-86,104`
   are unnamed mirrors, and `ADMIN_PLAN_KEYS` and `PRICING_PLAN_KEYS` independently
   hardcode the identical five-key list.
7. **Pass `competitions.max_active` "+1" needs no work.** There is no additive
   mechanism on `int_value` and no pass row for the key. The effect already exists as
   an exclusion: `competitions.ts:113-120` subtracts passed competitions out of the
   active count. Do not insert rows.
8. **`requireFeature` already takes a competition id.** `entitlements.ts:666-672`
   signs `requireFeature(orgId, featureKey, competitionId?)`; the three officials call
   sites simply never pass it. Call-site change only.

The brief's own corrections 1 (per-currency prices are not new plumbing) and 2
(officials has three sites) are confirmed true. Its correction 3 (31 files) is not.

## Resolver semantics — measured, and load-bearing for the migration

- **INT key:** only `int_value` is read (`getLimit`, `entitlements.ts:613-614`).
  `bool_value` on an int row is ignored noise, and the table has plenty of it
  (`clubs.max`/pro is `(t,20)`, `teams.max`/pro is `(t,40)`).
- **`int_value = NULL` means unlimited. A key with NO ROW resolves to 0** —
  `const base = row ? row.int_value : 0`. Deleting an int key DENIES it; it does not
  free it. Safe here only because nothing reads the four deleted keys.
- **BOOL key:** `bool_value === true`, strictly (`:460`). NULL or no row denies.
- **Pass overlay** (`resolveFromDb`, the `if (competitionId)` branch): bool can only
  GRANT; int is `betterInt` = max(), or min() for the single `LOWER_IS_BETTER` key
  `registration.fee_percent`. NULL is handled correctly as unlimited
  (`pass-vs-plan.ts:50-62`), so the no-op pass `teams.squad_max` rows cannot downgrade
  a Pro org. Deleting them is tidy-up, not a bug fix.

## Tasks

Sequenced so the guards fail in the intended order: **guard red → data changed →
copy true → guard green.** Expect a red tree from T1 until T8. Never weaken a guard
to get green.

### T1 — migration `V391__entitlements_v18.sql` + the matrix pin test
Order matters; the three FKs into `plans` (`subscriptions`, `plan_entitlements`,
`competition_passes`) have no cascade.

1. `insert into plans('enterprise', is_public=false)`.
2. Copy every `pro_plus` row to `plan_key='enterprise'`, then set
   `ai.credits.monthly = 500` and `registration.fee_percent = 1`.
3. Apply §2 to `community`, `pro`, `event_pass`, `event_pass_l` — 30 value changes,
   12 inserts, 2 row deletes. Table in `w2-delta.md` (workspace), reproduced in the
   migration's own header comment.
4. Delete the four inert keys on every plan: `officials.per_fixture.max`,
   `domains.custom`, `support.priority`, `stats.club_championship`.
5. `update subscriptions set plan_key='pro' where plan_key='pro_plus'`.
6. `delete from plan_entitlements where plan_key='pro_plus'`; `delete from plans where
   key='pro_plus'`. Unconditional (R7).

Pin test asserts every cell of the live matrix against §2 **parsed from the design
doc's own markdown**, not a table typed into the test — with anti-vacuity floors (a
minimum row count and all five plan columns present) so a parse that silently matches
nothing cannot pass.

### T2 — `PlanKey` and the mirrors
`PLAN_KEYS` becomes `["community","pro","enterprise"]`. The three `z.enum` sites, the
`plan-label.ts` map, `admin-plan.ts:136`, `pricing-matrix.ts:29-35`,
`entitlement-admin.ts:37-43` and `currency.ts:85-86,104` all converge onto derived
sets. `PRICING_PLAN_KEYS` (four purchasable columns) and `ADMIN_PLAN_KEYS` (five,
including enterprise) legitimately differ — they derive from one union rather than
being hand-listed twice.

### T3 — `featurePlan()` three-valued + the minimal Contact-us CTA
`ENTERPRISE_FEATURES = {api.write}` plus any int whose Pro value is the ceiling →
`"enterprise"`; everything else → `"pro"`. `scorers.max` and `officials.auto` leave
the set. `plan-label` gains an enterprise entry; `upgrade-gate` / `plan-badge` render
a `mailto:hello@seazn.club` CTA with the feature's human label prefilled.
Mutation check: delete the enterprise branch and the gate test must red.

### T4 — `stripe-plans.json` (real path `apps/web/src/config/stripe-plans.json`)
Write the table above into every price and tier's `unit_amount` + `currency_options`
(`eur/gbp/inr/aud`; USD rides `unit_amount`). Delete `plans[1]` (`pro_plus`) and
`org_addons[1]` (`extra_org_pro_plus`). R13: hide the extra seat — one dictionary key
and three help lines; the backend and the catalog price stay dormant and functional,
because no purchase UI exists to remove.

### T5 — per-rung pass credits
`PASS_CREDIT_GRANT: Record<"event_pass"|"event_pass_l", number> = {event_pass: 25,
event_pass_l: 50}`. The rung is already in scope at the grant site (`billing.ts:901`
inside `recordPassPurchase`, whose `passKey` is a required arg fed by
`passKeyForSession`). Update the three read sites and `passCreditGrantFaults`, whose
flat `+${PASS_CREDIT_GRANT} AI credits` literal and flat-number regex both break the
moment two rungs quote different numbers. Test with cases where the right answer
differs from the old constant.

### T6 — officials competition id
Pass the division's / stage's competition id at `autoAssignOfficials`,
`applyOfficialAssignments` and `sourceOfficials`. A Free org with a pass on
competition A runs auto-officials on A's division and is 402'd on B's. Mutation
check: drop the id from one call and the test must red.

### T7 — inert-key fallout
`entitlement-domains.ts:56` (`support.priority`), `feature-copy.ts:55`
(`stats.club_championship` reason), `scripts/smoke.ts:1950-1951,12217,12277`,
`org-addons-resolver.test.ts:138,145` (asserts `getLimit(...) === null`, which becomes
0), `pro-plus-matrix.test.ts`, `v17-phase1-matrix.test.ts`, `pricing-matrix.test.ts`,
`pricing-cards.test.ts`. `i18n-keys.ts` is generated — regenerate, never hand-merge.

### T8 — copy-truth guards
`copy-truth.ts` is pure (no DB import); it reds through its callers, which query
`plan_entitlements` live. Delete `plusDifferentiatorFaults`; teach `capClaimFaults`
that L is 512 and not "unlimited"; make `passCreditGrantFaults` per-rung; add
`enterpriseClaimFaults` (custom domain / white label / SSO may never read as included)
and `freeClaimFaults` (nothing may still call a now-free key "a Pro feature").
Deleting the `support.priority` row removes the matrix anchor for the "priority
support" claim regexes at `:396`, `:2121`, `:2210`, `:2296` — `enterpriseClaimFaults`
must replace that anchor in the same commit, not merely drop it.

**Carried from W1, and worse than briefed:** the per-locale paywall vocabulary lives
at `copy-truth.ts:589-614`, and the "es 148 / fr 115 / nl 133" liveness floor named in
the brief is a **stale measured comment** at `dictionary-copy-truth.test.ts:3402`. The
actual enforced floor is a single literal `50`, identical for every locale and both
axes. Widen the word lists and raise each floor to its own measured value.

### T8b — the copy V392 has ALREADY falsified

The brief sends the four locale dictionaries to W3. That ruling's stated reason is
that two waves must never edit one tree at the same time — and W3 has not started,
so the reason does not bind here. What does bind is the standing rule that a
migration changing rows a copy surface quotes is ONE unit of work with the fix to
that copy. V392 has already made these false; shipping the wave without them tells
customers a 512-entrant cap is unlimited.

| surface | claim | truth after V392 |
|---|---|---|
| `pricing.pass.ladder.capsUnlimited` | "unlimited entrants" (L) | 512 |
| `upgrade.ladder.entrantsUnlimited` | "Unlimited entrants" | 512 |
| `upgrade.ladder.divisionsUnlimited` | "Unlimited divisions" | Pro is 20 |
| `billing.pro.f1` | "Unlimited competitions & divisions" | divisions 20 |
| `upgrade.owned.nextBody` | "Pro … with unlimited divisions" | 20 |
| `tips.billing.event-pass.body` | "an L pass gives it unlimited entrants" | 512 |
| `pricing.meta.description` | "from $29 … Pro at $19/month" | $15 / $12 |
| `lib/pricing-cards.ts:43` | "20 & unlimited on L" | 512 |
| `lib/pricing-cards.ts:64` | "Unlimited competitions & divisions" | competitions yes, divisions 20 |

Seven dictionary keys in four locales, two code lines, and `config/tips.ts` (the
source the en dictionary mirrors). Prices elsewhere are interpolated — only two
hardcoded money lines per locale — so the price half of this is small.

**Scope discipline: W2 fixes ONLY the strings its own rows falsified.** Rebuilding
the cards from the dictionaries, and every "Pro Plus" string, stay W3's. Regenerate
`lib/i18n-keys.ts` rather than hand-merging it.

### T10 — remove AUD entirely (owner ruling 2026-09-03)

The owner chose full removal with the cost stated: **Australian clubs lose the
ability to collect entry fees in AUD.** AUD does two jobs here and this takes both.

- `SUPPORTED_CURRENCIES` in `lib/currency.ts` drops to four. `REGISTRATION_CURRENCIES`
  is DERIVED from it (one authority, explicit exclusions) so it follows automatically —
  do not add a second list.
- **Migration `V393`**: `organizations.currency` carries
  `CHECK (currency = ANY (ARRAY['usd','eur','gbp','inr','aud']))`. Alter it to drop
  `aud`. `org-currency.test.ts` fails if code and constraint disagree, which is the
  guard that makes this safe — do not weaken it. Greenfield, so no rows need
  converting, but the migration should FAIL LOUDLY if any org row is still `aud`
  rather than silently violating the new constraint.
- Every `currency_options` block in `stripe-plans.json` loses its `aud` entry, and
  copy-truth's `SEED_CURRENCIES` drops to four.
- The two label maps that hand-write `aud: "A$ AUD"` (`currency-switcher.tsx`,
  `org-registration-currency.tsx`) lose the row; both are `Record`s keyed on the
  type, so a missed one is a compile error rather than a blank option.

**The landmine that makes a PARTIAL removal worse than either end state:**
`amountFor` is `spec.currency_options?.[currency] ?? spec.unit_amount`. Drop `aud`
from the seed while leaving it in `SUPPORTED_CURRENCIES` and the pricing page renders
the USD number under an A$ symbol — no error, a wrong price. Seed and supported-list
must move in the SAME commit.

## Stripe sandbox — owner ruling, and two findings that change the work

**Ruling (2026-09-03): all billing testing runs against a real Stripe SANDBOX in
e2e or a walkthrough, never the hand-written fixture.** The fixture server's own
header agrees: "Only a real test-mode account settles whether Stripe bills a second
seat at half rate." It is used by ZERO e2e specs today — only by vitest unit tests —
so every `*.spec.ts` already resolves to real Stripe or to a dummy key.

**There is NO Stripe LIVE-mode catalogue** — owner, 2026-09-03: plans and prices exist
in the SANDBOX only. That bounds every risk below to test mode, and it means a
reprice cannot hurt a paying customer. It does not make the guards optional: the
sandbox is the only place the seed's shape is ever validated at all.

**Finding A — `stripe:sync` never prunes.** `scripts/stripe-sync.ts` iterates only the
seed's own collections and exits. It archives a price ONLY when a still-named
`lookup_key`'s amount has drifted (`:410-415`, `prices.update(p.id, {active:false})`),
which is exactly the reprice path this wave needs and is the reason the reprice works
at all — Stripe amounts are immutable, so a changed amount means a NEW price plus an
archived old one. But a seed entry that DISAPPEARS is never visited, so removing
`pro_plus` and `extra_org_pro_plus` leaves both active and purchasable in the sandbox,
where `planKeyForPrice` would resolve a real price id to a `plans` row this wave
deleted. No customer can reach it, so this is cleanup rather than an incident — but
W2 must still prove the mapper FAILS SAFE for an orphaned price id, because that is
the behaviour that would matter the day a live catalogue exists.

**Finding B — nothing checks the seed against live Stripe.** `stripe-plans.test.ts`
is seed-internal (unique lookup keys, currencies present, M < L). The one live sync
test uses a throwaway spec and says it "never touches the real seed's". No CI step
runs the `.live.` tests. So this wave rewrites every amount in five currencies and two
graduated tiers with no guard that Stripe accepted any of them. Add one: list live
prices by `lookup_key` and assert `unit_amount` and every `currency_options` entry
against the seed, gated on `BILLING_LIVE=1` and an `sk_test_` key like its neighbours.

**Sandbox proofs owed by this wave**, each driven through the real producer and
consumer, never a fixture:
1. `stripe:sync` against test mode, then the read-back guard above — this is the only
   thing that settles whether the new graduated tiers and four-currency options are
   accepted. Watch specifically whether REMOVING `aud` from an existing price's
   `currency_options` is honoured, or whether Stripe requires a new price for it;
   with no live catalogue, recreating under a transferred `lookup_key` is a free
   option if it is not.
2. The per-rung pass grant, end to end: real hosted Checkout with `4242…`, real
   `checkout.session.completed` returned by `stripe listen --forward-to`, wallet
   asserted at +25 for M and +50 for L. The path is
   `pass-checkout/route.ts` → `billing.ts` metadata → `billing-events.ts`
   `handleCheckoutCompleted` → `passKeyForSession` → `recordPassPurchase`, with a
   `passSessionRungMatchesPrice` guard in between that must be exercised, not assumed.
3. A Pro checkout at the NEW price, proving price-id resolution after the reprice.

There is no runbook for pointing a local run at the sandbox — `docs/runbooks/e2e-local.md`
documents only the CI dummies. Write one as part of this work.

### T11 — no FX fallback, ever (owner ruling 2026-09-03)

**"We must not fall back currency."** Two layers, and only one of them was covered.

**Covered already.** `stripe-sync.ts`'s `assertCurrencyCoverage` THROWS at sync time if
any price lacks a set point for a required currency, and its comment states the reason
exactly: "a hole does NOT fail at sync time — Stripe accepts the price and falls back to
ADAPTIVE PRICING, an FX-converted amount decided at render time from the buyer's IP …
Refusing to sync is the cheap failure; a silently FX-priced SKU in production is not."
`REQUIRED_CURRENCIES` is pinned to `SUPPORTED_CURRENCIES` by `stripe-sync.test.ts`, so
the four we sell in cannot develop a hole.

**NOT covered.** Stripe Checkout's Adaptive Pricing is an ACCOUNT-level default that
applies regardless of our seed. The SDK is explicit: `adaptive_pricing.enabled`
"Defaults to your dashboard setting". Nothing in this repo sets it, asserts it, or
mentions it. So a buyer in an unsupported currency — which, after T10, means every
Australian buyer — can be shown a Stripe-converted local amount we never set.

**The fix goes in code, not the Dashboard**, because a Dashboard toggle is an authority
nobody here owns and anyone can flip: pass `adaptive_pricing: { enabled: false }` on
BOTH Checkout Session creations (`billing.ts:186` subscription, `:329` pass). Both
already pass an explicit `currency: args.currency ?? "usd"`, so the session currency is
ours; this stops Stripe re-presenting it.

Tests: assert the param is sent on both paths; assert a created session comes back with
the currency we asked for, not a localised one. Mutation: drop the param and the test
must red. The sandbox run should then confirm a real session created for a non-supported
locale is denominated in USD.

Queued behind T5, which is editing `billing.ts` right now.

### T12 — V394: credits re-cut, squad cap raised, scorer seat deleted

Four changes in one migration plus their code and copy. All owner-ruled 2026-09-03.

**(0) The AI credit re-cut.** `ai.credits.monthly` pro **35 → 25**; `ai.credits.trial`
pro **20 → 15**; the pass grant becomes M **25** (unchanged) / L **50 → 35**. Free stays
**5** — the owner settled that separately: "AI Credit is fine, that's the selling point."
**The trial cut is PRO ONLY** — owner confirmed 2026-09-03 when the asymmetry was put to
them. Enterprise keeps `ai.credits.trial` 20 and `ai.credits.monthly` 500, deliberately.
So enterprise's trial is larger than Pro's, which is intended and not a drift to "fix":
enterprise is a staff-granted contact-us plan whose numbers are set per deal, not a rung
a customer self-serves onto. Touch `plan_key = 'pro'` only.

**This is rework of T5, not a fresh change.** T5 shipped the per-rung grant at 25/50 with
copy in four locales, and L's number is quoted in: the seed's `event_pass_l` product
description ("+50 AI credits"), three marketing keys and one ui key × 4 locales,
`config/tips.ts`, two English help articles, and two re-approved digest gates. Every one
moves to 35. Prefer interpolating from `PASS_CREDIT_GRANT` over writing a third literal.

Recorded consequence, raised and accepted: Pro's monthly grant (25) is now BELOW the
cheapest credit pack (40 credits for $10), so a customer whose only unmet need is AI is
better off buying a pack than upgrading. Coherent with the design's "credits are compute,
not packaging"; incoherent if credits are meant to pull people to Pro. The owner chose the
numbers with this stated.

Also check `localeCreditLeadershipFaults` (`copy-truth.ts:2782`) — it guards the claim
"the largest monthly AI credit grant" and still names `pro_plus` in its failure message,
a plan V392 deleted. It has to learn the new ordering (enterprise 500 > pro 25 >
community 5) as part of the copy sweep.

**(1) Free `teams.squad_max` 20 → 23.**

Design §2 justifies Free's squad cap as "Free =
one matchday squad". Measured against the engine's own declarations, it is not:
`football.ts` is `lineup: { size: 11, benchMax: 12 }` = **23**, and `icehockey.ts` is
`{ size: 6, benchMax: 17 }` = **23**. Cricket is 15 and volleyball 14, so those fit — but
a football or ice-hockey club cannot register its first full squad on Free at all. That is
the same "broken on night one" failure the design cites when it freed double-elimination.

Pro stays 40, which keeps the real distinction (matchday squad vs season roster). Do NOT
change the copy: "squads of 40" is a Pro claim and is unaffected.

Derive nothing here from the design doc — it says "cricket 15, football 23, rugby 23",
and RUGBY IS NOT IN THE ENGINE CATALOGUE. The sports that exist are football, cricket,
volleyball, badminton, tabletennis, icehockey and carrom. Use the engine's numbers.

**(2) DELETE the `scorers.max` cap; keep the scorer role.**

**(3) Fix the import-cap paywall message — it quotes a number that has never been right.**
`feature-copy.ts:82` says "Files over 20 rows need a Pro plan" and the comment at
`imports.ts:121` says "Community capped at 20 rows/file". The cap is **50** (per FILE,
checked as `withinLimit(orgId, "import.bulk", rows.length)` at preview time — unlimited
files, capped rows in each). A Free user refused at 60 rows is told the limit is 20 and
splits into three files when two would do. Predates W2, but it is a false customer-facing
claim in a file this wave already edits. Quote the cap from the entitlement rather than
hardcoding a third literal — a second hardcoded number is exactly how this one drifted.
The cap itself STAYS 50; the defect is the message.

#### Why the cap goes (owner ruling 2026-09-03)

**Ruling: delete the cap, do not deprecate the role in this wave.**

**CORRECTED 2026-09-03 — the owner was right and this plan was wrong twice.**
An earlier version of this entry claimed "officials cannot log in" and that officials
and scorers are not substitutes. Both are false, and the way they were reached is the
lesson: the `officials` table has no `user_id`, so the check stopped there — but the
link runs `officials.person_id → persons.user_id`. Then `/my-matches` was found to read
only `scorer_assignments`, and "officials have no surface" was concluded from it — but
`/me` carries a whole `OfficiatingLane` built on `me-officiating.ts`, and its own header
says "All plans, free included". A capability claim settled by two partial reads instead
of following the chain to its end.

**What is actually true.** `requireFixtureActor` (`server/api-v1/auth.ts`) grants an
ACCEPTED official both read AND score on a fixture with NO org role at all:

    if (!role) {
      // Non-member — the only remaining door is an *accepted* fixture_officials
      // assignment on this exact fixture. Covers both read and score.
      if (await acceptedOfficialCovers(user.id, fixtureId)) return ctx;

So a Free org delegates scoring today by adding an official, who claims their account,
accepts the fixture at `/me`, and scores it — no seat, no admin account, no device link.
The scorer role IS redundant for the volunteer-scores-a-match case, exactly as the owner
said. Device links stay Pro/Event-Pass only (owner reconfirmed 2026-09-03); they buy the
ANONYMOUS hand-over, which is a different product from a named official with a login.

What IS true: the scorer feature is half-built. `scorer_assignments` has three
production writers (`scorers.ts:125`, `invites.ts:86,136`) and **no UI anywhere** creates
one — grep across `components/` and `app/` returns nothing. The only path is inviting
somebody as a scorer with a default scope. That is what #244 meant by "dormant legacy".

So the cap is the part that is actually wrong, and it goes:
- It meters a capability the product gives away — W1 ruled scoring free on every plan.
- We would advertise "10 scorer seats" for a feature with no assignment UI, on a
  comparison table that (per #244) does not even carry the row.
- Deleting the key removes T12's original visibility problem at the root rather than
  restoring a row to two surfaces to describe something half-built.

Scope: migration **V394** deleting `scorers.max` from `plan_entitlements` (and any
`org_entitlement_overrides`), the two enforcement branches that read it
(`app/api/orgs/[id]/members/[userId]/role/route.ts` and `lib/invites.ts` — each falls
back to the `members.max` pool, which is the honest answer once the seat is not
separately sold), `feature-copy.ts`'s reason string, and every copy surface selling
scorer seats (design §3's Pro card says "10 staff + 10 scorer seats" — that claim dies
with the key, and by this wave's own rule the copy fix ships WITH the row deletion).

**Remember the resolver's edge: a key with NO ROW resolves to 0, not unlimited.** So the
call sites must stop asking for `scorers.max` entirely — leaving the read in place while
deleting the row would deny every scorer promotion instead of freeing it. That is the
single most likely way to get this wrong.

**Deprecating the ROLE is now viable and is recommended as its OWN wave, not this one.**
The blocking objection (Free loses delegated scoring) has dissolved — officials cover it
free. What remains is scope and risk, not principle: 21 non-test files (42 with tests),
`/my-matches`, `scorer_assignments`, six branches in `page-auth.ts`, and a live branch of
`requireFixtureActor` (`scoresViaAssignment` / `requireScorable`). That last one is an
AUTHORISATION path — the wrong edit there widens who can write score events. W2 is
already carrying a live pass-scoping defect and a red copy sweep; bolting an auth-path
deletion onto it is how a wave ships a security regression behind a green suite.

Sequence: delete the CAP here (small, and it removes a false claim), then take the role
in its own wave with its own review. Anything still creating scorer assignments —
`invites.ts`'s scorer-with-default-scope path — needs a migration story for existing rows
and a decision on what an org with live scorers sees the day it lands.

### T12-orig — the visibility finding this superseded (kept for the record)

V392 turned `scorers.max` from a dormant 1/1 into a real differentiator (Free **2**,
Pro **10**), and design §3's Pro card sells "10 staff + 10 scorer seats". The cap IS
enforced — `app/api/orgs/[id]/members/[userId]/role/route.ts:22` on a role change to
scorer, and `lib/invites.ts:67` on a scorer invite acceptance, against a pool separate
from `members.max`.

But both surfaces that would SHOW it were deliberately removed while it was dormant,
and neither decision was revisited by this wave:
- `entitlement-domains.ts:8` — "scorers.max is deliberately absent (#244): the seat is
  dormant legacy" → absent from `/admin` entitlements.
- `pricing-matrix.ts:117` — "scorers.max retired from the comparison (#244)" → not a row
  on the public pricing table.

Those calls were right at 1/1: a cap identical on both plans differentiates nothing.
They are wrong at 2/10 — we would advertise a seat count the comparison table does not
list. Restore the row in both, or the Pro card sells something the matrix page denies.

Two smoke checks also still assert the retired numbers and must be rewritten, not
deleted: `scripts/smoke.ts:1761` ("scorers.max = 1 on community, so exactly one fits")
and `:15421,15430` ("scorers.max (Pro = 1): a second scorer can't take a seat",
asserting 402). The second's NAME states the old rule, which is the shape this repo has
been bitten by before — read what it asserts, then move it to Free 2 / Pro 10.

### T14 — V394: grant `import.events` on every plan (owner ruling 2026-09-03)

Raised by the scheduler-bench session as "G4, blocked on W2". Verified before acting, and
it was NOT what the report said: `import.events` has zero rows AND exactly one reader —

    app/api/v1/divisions/[id]/events/import/route.ts:28
      await requireFeature(auth.orgId, "import.events"); // 402 during rollout

The 402 was a deliberate rollout kill-switch, not a forgotten matrix row, and the key
appears nowhere in design §2. So this is a FEATURE LAUNCH decision, not plumbing. It was
put to the owner as such, twice: ship or hold, then which plans.

**Ruling: ship it, TRUE on every plan — community, pro, enterprise, event_pass,
event_pass_l.** Rationale accepted: R9 says scoring detail is never a price boundary and
W1 already stripped the fidelity-band gate off this very importer, so gating the same
importer by plan would re-introduce the boundary R9 removed. The house pattern for imports
is a volume cap rather than a gate (`import.bulk` is 50 Free / 500 Pro); if event-import
volume needs bounding later, add a CAP key, do not convert this into a gate.

Scope:
- Migration **V394** inserting `import.events` bool true for all five plans.
- **Add the key to design §2** — `entitlements-v18-matrix.test.ts` parses that table, so a
  row in the database that §2 does not name is drift by construction.
- Update the `// 402 during rollout` comment at the call site; it is no longer true, and a
  stale comment saying a live feature is gated is how the next reader re-disables it.
- Check whether the key belongs in `ENTITLEMENT_DOMAINS` / the pricing comparison. It is
  true everywhere, so it differentiates nothing and probably should NOT be a pricing row —
  but say which, rather than leaving it to chance.
- `feature-copy.ts` reason string: with every plan granting it the 402 becomes unreachable
  for any org on a plan. Decide whether the reason stays for the no-plan case or goes.

Sequenced AFTER T12 (V394) because that task is in flight; do not send a mid-task
correction — this repo has had a subagent reject one as prompt injection.

**For the bench session:** this unblocks their G4 once W2 merges. Their G7 (`business`
seeded by V112, absent live) is CORRECT and was never blocked on W2 — the live catalogue
is community / enterprise / event_pass / event_pass_l / pro, `business` is long gone, and
"query the catalogue, never read it off migrations" remains the rule. W2 improves it:
`pro_plus` is deleted and `enterprise` added, the plan-key mirrors are converged onto one
union, and the live catalogue is now pinned against design §2 by a test.

### T15 — V394 part B: the three share loops become paid (owner ruling 2026-09-03)

**This REVERSES four cells V392 set eight hours ago**, and reverses design §2's growth
thesis. Recorded in full because a reader finding V392 and V394 disagreeing will otherwise
assume one is a mistake.

**Three loops move, not four.** An earlier draft also flipped `branding` (the org's own
logo) to false on Free. WITHDRAWN by the owner: a free club uploads its own logo. What we
sell is the removal of OUR badge, which is now enterprise-only — so Free keeps its identity
and loses only the amplification.

| key | Free | Pro | Pass M/L | note |
|---|---|---|---|---|
| `branding` (org logo) | **true — UNCHANGED** | true | true | flip WITHDRAWN, owner 2026-09-03: a free club uploads its own logo |
| `dashboard.player_profiles` | true → **false** | true | true | pass rows exist |
| `embeds.enabled` | true → **false** | true | **no row → INSERT true** | see trap below |
| `news.auto` | true → **false** | true | true | pass rows exist |

**The trap:** `embeds.enabled` has NO pass rows today. Flip Free to false without inserting
them and the Event Pass falls through to the community row and silently LOSES embeds — the
resolver only overlays what a pass row explicitly grants. Insert `event_pass` and
`event_pass_l` true in the same statement.

**`dashboard.branding`: SUPERSEDED, twice, within the hour — read only this version.**
Owner, final: **the badge is SHOWN on every plan except enterprise.** `dashboard.branding`
true means the badge is REMOVED, so the cells are community false, pro **true → false**,
event_pass false, event_pass_l false, enterprise true. Badge removal becomes an
ENTERPRISE-ONLY feature, which is exactly where R3 puts white label ("White label, custom
domain, write API, priority support → Contact Us").

An intermediate ruling set the pass rungs true. It was never built, so there is nothing to
revert — but note that this also moves **Pro**, which no earlier draft did. Design §2 marks
this cell "D7, never moves"; it has now moved, deliberately, and that note is the older
decision.

Net effect: every self-serve plan carries our badge, including Pro. The acquisition loop
survives the share-loop reversal after all — it just runs through public dashboards rather
than through profiles, embeds and posts.

**`dashboard.public.max`: Free 3 → 2, Pro ∞ → 10.** Pro loses "unlimited public
dashboards", so check `capClaimFaults` and any card copy claiming it.

**`assertPublicQuota` is the real defect, and BOTH remaining rulings land on it.**
Owner, 2026-09-03: the cap counts **ACTIVE public dashboards only**, and a passed
competition does not count against it.

`competitions.ts` `assertPublicQuota` today is a flat
`select count(*) from competitions where visibility = 'public'` — **no status filter and
no pass exclusion**. So a club that has run three seasons carries three public dashboards
for ever and is refused a fourth while nothing is running. That is not a policy gap, it is
a leak: the cap counts history rather than live surfaces, which is why 3 felt tight and 2
would have felt broken.

`assertActiveQuota` twenty lines above already solves both halves, and its own comment says
why — *"competition past that boundary was keeping a free slot for ever"*:

    where c.status in ${tx([...ACTIVE_COMPETITION_STATUSES])}
      and not exists (
        select 1 from competition_passes cp
         where cp.competition_id = c.id
           and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date))

Give `assertPublicQuota` the same two clauses. **Factor the shared predicate out rather
than copying it** — that function's header already states the intent ("the same predicate
the resolver uses, so the three sites cannot drift apart again"), and `assertPublicQuota`
is conspicuously not one of those three sites. Copying would make it a fourth place to
drift.

Its comment is stale too: "Community holds 1 public competition at a time" against a cap
of 2. Third stale hardcoded cap found in this area today.

**Why a row cannot do this:** `dashboard.public.max` is
an ORG-level integer and a pass can never lift one. Worse, the count has no pass exclusion:
`competitions.ts:131-141` is `select count(*) from competitions where visibility='public'`
then `withinLimit(orgId, "dashboard.public.max", count + 1)` — flat. `competitions.max_active`
solves the identical problem at `:113-120` by subtracting passed competitions out of the
count via a `not exists (… pass_applies …)` clause. Mirror that here: a passed competition's
public dashboard must not count against the org's cap. Same shape as this wave's "+1"
finding; do not try to express it as a matrix row.

Also stale and now more wrong: `feature-copy.ts` says "Your plan hosts one public dashboard
at a time" — the cap is 2 on Free and 10 on Pro. Quote the entitlement, do not hardcode a
fourth literal.

The counter-argument was put and overruled: design §2 made these three free as acquisition
loops ("Three share loops go free… Each one puts the badge in front of people who are not
yet customers"), and `news.auto` was itself an earlier "owner asked" free cell. The owner
chose value capture over the loop. Do not "restore" these to Free on the strength of the
design doc — the doc is now the older decision.

**Copy that this falsifies and must move WITH the rows** (the wave's standing rule):
- Design §2's four cells, or `entitlements-v18-matrix.test.ts` reds — it parses that table.
- Design §3's Free card, which sells "player profiles, embeds and auto-drafted posts
  (badge on)", and the "Why this attracts more customers" section built on the three loops.
- `lib/pricing-cards.ts`'s `FREE_FEATURES` array.
- The Free card bullets in all four locale dictionaries.
- Sweep B's planned `freeClaimFaults` must not treat these as free keys.

### T16 — the fee disclosure exists; name the rate and fix the stale one

**CORRECTED after the owner showed the live screen.** An earlier version of this entry
claimed the Connect page "mentions no fee, no percentage and no terms". That was WRONG. It
was reached by reading `page.tsx` and its two dictionary keys and never following into
`<OrgPaymentInstructions>`, which is the component that renders the CTA. Third product-fact
claim made from a partial read in one session — the other two were "officials cannot log
in" and "officials have no surface", both also wrong, both also settled by opening one more
file. A claim about what a PERSON SEES is only settled by driving the product.

**What is actually shipped**, in the onboarding card, directly above the "Resume Stripe
onboarding" button — `pay.stepGoLiveDetail`:

> "Charges enabled: divisions can take card entry fees, entries confirm on payment, and
> payouts land in your bank on Stripe's schedule — minus Stripe's processing fee and the
> platform fee for your plan."

That is disclosure at the point of consent, and it is well placed. Note it again describes
the ADDITIVE model, which the code does not implement — reinforcing that making the fee
additive implements what both the UI and the help already promise.

**What is actually owed, and it is smaller:**
1. **The rate is never shown anywhere near the decision.** `pay.stepGoLiveDetail` says "the
   platform fee for your plan" without saying what that is, and no `connect.*` string names
   a percentage. Add the resolved rate, READ FROM `registration.fee_percent`, never
   hardcoded.
2. **`tips.registration.platform-fee.body` is a live false claim** — "8% on Community, 5%
   on a competition with an Event Pass, 2% on Pro, **1% on Pro Plus**". Pro Plus is deleted,
   and every number changes when the fee goes additive. Four locales.
3. The same stale list in `registration/open-registration.md:19` and
   `getting-started/create-your-organisation.md:21`.

### T17 — V396: the public accent colour gets its own key (owner ruling 2026-09-03)

**`dashboard.branding` was overloaded and nobody knew.** It gates badge removal AND the
public accent/theme colour, in one SQL expression — `server/public-site/data.ts:361-363`:

    org_has_feature(o.id, 'dashboard.branding') as branded,
    case when org_has_feature(o.id, 'dashboard.branding')
         then o.branding else '{}'::jsonb end as branding,   -- accent/theme
    case when org_has_feature(o.id, 'branding') then o.logo_url end as logo_url

So the split was already HALF done: the logo rides `branding` (free), while colour and
badge share one key. The badge ruling turned that key off for Pro, and took Pro's brand
colour off its public pages with it — a visible downgrade a paying customer did not ask
for. Four smoke checks caught it and were left RED on purpose; silencing them would have
frozen a live regression as expected behaviour.

**Ruling: a NEW key for the colour, Pro and above.** Rejected: letting colour ride
`branding` (would give it to Free — the owner chose to keep it as a paid visual
differentiator).

- New key (suggest `dashboard.theme`): community **false**, pro **true**, enterprise
  **true**, and **no pass rows** — it is ORG-level, so a pass could never lift it and a row
  would be inert. Add it to design §2 or the pin test reds.
- `public-site/data.ts` — the `o.branding` jsonb case moves onto the new key.
  `dashboard.branding` keeps ONLY the `branded` badge flag.
- The four smoke checks then describe the truth again; do not edit them to match a defect.

**Smoke fallout this wave still owes** (from V395's partial run — 159 passed / 6 failed,
then `ERROR: fetch failed` aborted at check 165, so that is a FLOOR, not a green smoke):
- `billing-group: quotas are per org…` asserts `members.max === 15`; V392 made Pro **10**.
- `jul3 officials auto is Pro Plus only`; V392 gave `officials.auto` to **Pro**.
- `smoke.ts:2460` and `:2702` assert `dashboard.player_profiles` is free on Community —
  V395 made it **false**; unreached in that run, so unobserved and WILL fail.
- `smoke.ts:4797`/`:4801` assert the free `news.auto` toggle and a digest 402 — now true
  again; will pass, but re-read them rather than assuming.

### T18 — C4's fixture writes, and a stale comment found beside them

**C4 (reviewer pass 1, re-verified OUTSTANDING in pass 2): eleven raw-SQL writes of
`plan_key='pro_plus'` into a column with a live FK.** `scripts/smoke.ts:1998, 3438, 3694,
11467, 11972, 12136, 12464`; `e2e/ai-architect.spec.ts:82`;
`e2e/payments-hardening.spec.ts:955`; `e2e/schedule-panels.spec.ts:82, 119`. Plus
`e2e/helpers.ts:443`'s union still admitting the key.

A previous sweep repointed ~90 cases across 53 files and truthfully reported that — and
still missed every one of these, because `setPlan` takes a `string`, so no typecheck can
see them. **They fail only AFTER merge**, since e2e runs on push-to-main and never on a PR.
That is the whole reason this is high priority despite looking like test cleanup.

**A stale comment found while verifying a peer session's warning about the same file.**
`helpers.ts:1066-1073` documents `splitOrgIntoOwnGroupSql` with: "a new org joins its
creator's EXISTING group (lib/auth.ts createOrgForUser), so three orgs minted by one e2e
user are three orgs on ONE bill". **That contradicts the function it cites.**
`createOrgForUser` (`lib/auth.ts:303`) inserts a FRESH subscription inside its transaction
and attaches the new org to it — its own race comment says "each minted an org + a
Community group". The only writers that attach an org to an existing group are the explicit
usecases at `billing-groups.ts:975` and `:1260`. Fix the comment while narrowing the union
in the same file.

**What IS true and matters for this task:** `setOrgPlanBySql` (`helpers.ts:441-449`) is
GROUP-scoped — it resolves `requireGroupId` and updates `subscriptions where id = groupId`.
So repointing a fixture's plan moves every org sharing that group. For e2e orgs minted
through `createOrgForUser` that group holds exactly one org, so it is safe; it is only a
hazard where a spec has deliberately joined orgs. Check each of the eleven for which shape
it is before repointing.

### T19 — gate the officials import (owner ruling 2026-09-03: fix it in W2)

**`POST /api/v1/officials/import` bypasses `import.bulk` entirely.** Found by the
directory-walkthroughs session, confirmed independently here before acting.
`app/api/v1/officials/import/route.ts` calls `importOfficials`
(`server/usecases/officials.ts:278`), which has NO `requireFeature`, NO `withinLimit`, and
never mentions `import.bulk` — while the sibling path gates at `imports.ts:132`. So the
50-row Free cap is unenforceable through that route. API-only, no UI, which is why it went
unnoticed.

Ruled into W2: this wave exists to make the matrix true in code, and it is already fixing
that key's stale paywall message. A cap with a bypass is not a cap.

**The fix, mirroring the sibling exactly — do not invent a second shape:**
`importOfficials` parses `const [header, ...data] = table` at :285, so `data.length` is the
row count. Gate AFTER the header validation (:291) and BEFORE `return withTenant(...)`
(:293) — `withinLimit` queries the POOLED sql proxy while `withTenant` pins a connection
for its whole callback, and the sibling is pre-transaction for that reason.

    const quota = await withinLimit(auth.orgId, "import.bulk", data.length);
    if (!quota.ok) {
      throw new PaymentRequiredError("import.bulk", {
        limit: quota.limit,
        reason: bulkImportRowsReason(quota.limit),
      });
    }

Reuse `bulkImportRowsReason` — the sibling's comment explains that `extra` is spread AFTER
`reason` in both envelopes, which is what lets the paywall quote the real number instead of
a third hardcoded copy. Do not hardcode 50.

**Tests owed:** a Free org importing 51 officials rows is refused 402 with `feature_key`
`import.bulk` and the message quoting the LIVE cap; 50 succeeds; a Pro org's 51 succeeds.
Mutation: delete the gate and the refusal test must red. This is a live API route that
starts refusing, so it needs an e2e through the real HTTP door, not a usecase call.

**Greenfield, so no caller is broken today** — but it IS a behaviour change to a shipped
route, and the commit message should say so plainly.

### T20 — reviewer pass 3 findings (1 critical, 4 important)

**CRITICAL — the degrade note ships on the MINORITY create path.** V395 made competitions
public by default and degrade to private at the cap instead of 402ing. `createCompetition`
returns the full row so the wizard can diff requested-vs-created and render
`public-quota-degraded`. `instantiateTemplate` performs the identical degrade, but
`FromTemplateResult` (`server/api-v1/schemas.ts:945-953`) **carries no `visibility`**, so
the client has nothing to diff, and `components/v2/template-gallery.tsx:297` redirects
unconditionally. **The gallery is the DEFAULT path** — `/competitions/new` opens on it and
"start blank" is a button inside it (`e2e/helpers.ts:1622`). A Free org at its cap creates
from a template, gets a SILENTLY private competition, shares the link, and fans get a
private page. The e2e proved the wizard, which is the path fewer people take.

**IMPORTANT:**
1. `usecases/org-posts.ts:1590` vs the sweep at `:1655` — the digest 402 has a hole at
   `total === 0`, and a comment five lines above claims the two cannot differ. They do: a
   Free org with no competitions still mints a `weekly_digest`. Read what the code does,
   not what the comment promises.
2. `newsAutoCompetitionScope:1136-1143` is an N+1 resolver loop **inside the weekly cron**.
   `org_has_feature`'s 3-arg form does it in one query.
3. `templates.ts:187-188` keys the guard on `=== "public"` but the value on `?? "public"` —
   an omitted visibility skips the quota check entirely while still creating a public
   competition.

**C4 is bigger than the brief says — correct it before dispatching T18.** All seven
`smoke.ts` line numbers are STALE (the smoke rewrite `45180182a` shifted them 4-20 lines),
and **two sites were missing**: `scripts/repro-ai-bracket-frozen-feeder.ts:206` and a
SECOND union at `e2e/payments-hardening.spec.ts:137`. So it is **13 sites, not 11**. Re-pin
every one by grep before editing.

**C3:** every pass-1 "unlimited" site survives in the committed range, plus a new one —
`content/help/billing/plans.md:9`'s "1 public dashboard".

**Came back CLEAN, and worth recording so it is not re-litigated:** `assertPublicQuota` is
genuinely FACTORED, not copy-pasted — the predicate is `liveUnpassedCompetition`
(`entitlement-freeze.ts:16-45`), four call sites, no fourth copy, and
`billing-meter-parity.test.ts` guards the call site AND the fragment body separately. All
eight pass-lift offenders are really fixed, each resolver call carrying a competition id.
The digest scoping is proven by entrant-name presence/absence rather than a boolean.
`import.events` has two live readers, so the grant is not inert. Guard integrity: five
assertions removed against fifty-eight added, every removal read and replaced with the new
truth; no `.only`, no `xit`; the three added `skipIf` are the standard DB gate.

**The §2 pin is ONE-WAY, and three places claim it is not.**
`server/__tests__/entitlements-v18-matrix.test.ts` has five cases and every one iterates
rows PARSED OUT OF THE DESIGN DOC, asserting the database matches. Nothing goes the other
direction: nothing enumerates `plan_entitlements` and asks whether each key appears in §2.
The sibling `retired-matrix-keys.test.ts:30-87` is absence-only against a hardcoded list
and pins the `plans` table, not feature keys.

V395's header (`:3-5`), V396's header (`:3-4`) and this plan's T14 all rest on the sentence
"a row in the database that §2 does not name is drift by construction". **That guarantee
does not exist.** I wrote it, and it was repeated into two migration headers.

No live defect — `import.events` and `dashboard.theme` were both added to §2 in the same
commits, which is exactly the discipline those headers describe. The exposure is the NEXT
migration that forgets, whose author will have been told three times that it cannot happen.
A false guarantee is worse than no guarantee: it manufactures confidence where a reader
would otherwise check. Same shape as `passCreditProseFaults` reading only the first table
cell and believing it had scanned the row.

**Fix — one test case:** `select distinct feature_key from plan_entitlements`, subtract the
keys parsed from §2 and the known-deleted set, assert the remainder is empty. Then the
three headers become true instead of aspirational.

**Nobody has a green smoke on this branch** — the last run aborted at check 165.

### T9 — sweep and gates
Delete the two dead e2e specs. Rerun the 34 files that assert against
`plan_entitlements` and the 8 copy-truth importers (4 need a live DB). Unit, e2e,
smoke and regression per RULES.md. Judge vitest only from `--reporter=json
--outputFile`, confirming `.testResults[].name` resolves inside this worktree.

## Constraints

- Four locale dictionaries for any changed user-facing string; `lib/i18n-keys.ts` is
  generated. `content/help/**` is English-only and mostly W3's.
- The Event Pass overlay is competition-scoped only. A pass can never lift an
  org-level integer. Do not design around a capability that does not exist.
- DB schema is `seazn_club`, not `public`; the plans table's column is `key`.
- Never `git stash` in a worktree here. Never `UPDATE_GOLDEN=1`.
- Smoke is the PR-only gate; e2e runs on push-to-main only, so a PR carries no e2e
  signal — read `.github/workflows/e2e.yml` rather than trusting any summary of it.
