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
   norm" rationale).
2. **Tier 2+ is 60% of the base** — a 40% discount instead of §3a's 50% — rounded
   down to a whole major unit (INR to the nearest x99). Extra organisations get
   DEARER, not cheaper: $6 → $7, and a 3-org monthly group goes $24 → $26. The owner
   was asked which of the two readings of "40%" they meant and chose this one
   explicitly; do not "restore" the half-the-base rule.
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

| | USD | EUR | GBP | AUD | INR |
|---|---|---|---|---|---|
| Pro monthly tier 1 | 12 | 10 | 9 | 16 | 499 |
| Pro monthly tier 2+ / extra org add-on | 7 | 6 | 5 | 9 | 299 |
| Pro annual tier 1 | 99 | 89 | 79 | 139 | 3,999 |
| Pro annual tier 2+ | 59 | 53 | 47 | 83 | 2,399 |
| Event Pass M | 15 | 14 | 12 | 19 | 599 |
| Event Pass L | 39 | 35 | 29 | 55 | 1,599 |
| Extra seat / month (hidden, R13) | 2 | 2 | 2 | 3 | 99 |
| Size pack +32 | 5 | 5 | 4 | 7 | 199 |
| AI credit packs | unchanged | | | | |

In minor units, as the seed stores them (USD rides `unit_amount`; `currency_options`
carries only `eur/gbp/inr/aud`):

| | usd | eur | gbp | aud | inr |
|---|---|---|---|---|---|
| pro monthly tier 1 / tier 2+ | 1200 / 700 | 1000 / 600 | 900 / 500 | 1600 / 900 | 49900 / 29900 |
| pro annual tier 1 / tier 2+ | 9900 / 5900 | 8900 / 5300 | 7900 / 4700 | 13900 / 8300 | 399900 / 239900 |
| event_pass / event_pass_l | 1500 / 3900 | 1400 / 3500 | 1200 / 2900 | 1900 / 5500 | 59900 / 159900 |
| extra_org_pro | 700 | 600 | 500 | 900 | 29900 |
| extra_seat | 200 | 200 | 200 | 300 | 9900 |
| size_pack_32 | 500 | 500 | 400 | 700 | 19900 |

Rules, verified in all five currencies: annual ÷ monthly ∈ 8–9 (8.25 / 8.90 / 8.78 /
8.69 / 8.01); tier 2+ = 60% rounded down; M < L < annual; 3 × L ≥ annual (117≥99,
105≥89, 87≥79, 165≥139, 4797≥3999); 2 × L < annual (78<99, 70<89, 58<79, 110<139,
3198<3999).

Consequences to carry into W3: the design's "revenue per Pro org falls 53%" is now
~37%, and the approved mockups print the old $9/$15 pair. Both are W3's to amend.
§3a's "the graduated tier-2 rate = half the base rounded DOWN" is superseded by the
60% rule above and must be rewritten, not left to contradict the seed.

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
