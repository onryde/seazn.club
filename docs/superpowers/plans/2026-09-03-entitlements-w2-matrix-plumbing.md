# W2 — matrix & plumbing (entitlements v18)

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

### T8b — the copy V391 has ALREADY falsified

The brief sends the four locale dictionaries to W3. That ruling's stated reason is
that two waves must never edit one tree at the same time — and W3 has not started,
so the reason does not bind here. What does bind is the standing rule that a
migration changing rows a copy surface quotes is ONE unit of work with the fix to
that copy. V391 has already made these false; shipping the wave without them tells
customers a 512-entrant cap is unlimited.

| surface | claim | truth after V391 |
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
- **Migration `V392`**: `organizations.currency` carries
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

### T12 — `scorers.max` is enforced but invisible (found 2026-09-03)

V391 turned `scorers.max` from a dormant 1/1 into a real differentiator (Free **2**,
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
