# Entitlements v18 — Free / Pro / Event Pass + Contact Us

Status: design, owner rulings taken 2026-09-02 (two rounds). Supersedes the
Pro Plus tier (`2026-07-18-pro-plus-tier-design.md`) and the Pro-Plus-specific
parts of the v17 gap remediation (`2026-07-26-v17-gap-remediation-design.md`
#293, #294). **Absorbs R9** (`2026-08-15-scoringpad-v3-prompts/R9-scoring-free.md`,
owner ruling 2026-08-30, registered and never run): scoring goes free, and R9
is this programme's first wave. Rulings from those documents NOT named here
still stand — in particular D7 (the "Powered by seazn.club" badge never moves
off Pro) and the pass-credit redemption model
(`2026-07-26-pass-credit-redemption-design.md`).

**Principle the whole programme is held to (R9): charge for leverage, never
for correctness.** Recording a match right, ranking a table right, scheduling
four divisions without a venue clash — never paywalled. What is sold is scale
(seats, teams, squads, organisations), operations (pads for volunteers, auto
officials, suspension tracking, API), reach (badge off, branded exports,
sponsors) and metered compute (AI credits).

**Growth principle added 2026-09-02:** every Free surface that a player or a
club shares — public player profiles, embeds, auto-drafted posts, public
dashboards — is free *with the badge on*. The badge is the ad; the share is
the distribution.

## Goal

Sell three things a customer can understand in one sentence each, and route
everything bespoke to a conversation:

| Offer | One-line sell | Value metric |
|---|---|---|
| **Free** | Run a club night. | 1 org, small caps, badge on |
| **Event Pass** (M $29 / L $59, one-time) | One tournament, fully powered. | competition size |
| **Pro** ($19/mo, $159/yr) | Your whole season. | organisation scale: seats, teams, squads, credits |
| **Contact Us** (dark `enterprise`) | Your federation. | unlimited + bespoke |

Pro Plus is retired. No public plan carries an unlimited team, squad, seat or
credit figure; only the dark `enterprise` plan does, and it is never
self-serve.

## Background facts (verified 2026-09-02, local DB at V389)

- Matrix lives in `plan_entitlements(plan_key, feature_key, bool_value,
  int_value)`; `int null = unlimited`, missing row = deny / fall through to the
  org's plan. Resolver `apps/web/src/lib/entitlements.ts`: override → Event
  Pass overlay → plan row → addon bonus. 60 keys today.
- **The Event Pass overlay runs only when the check carries a
  `competitionId`** (`entitlements.ts:361`, `if (competitionId) { … }`). A
  pass cannot lift org-level ints (`members.max`, `scorers.max`, `teams.max`,
  `teams.squad_max`, `orgs.max_owned`, `dashboard.public.max`). Bools can also
  be granted org-wide by `hasFeatureOnAnyPass` (V344 `org_has_feature`), ints
  cannot.
- `officials.auto` is enforced at `server/usecases/officials.ts:396,435`
  as `requireFeature(auth.orgId, "officials.auto")` — **no `competitionId`**,
  so a pass row would be invisible until the call passes the division's
  competition id. The route is `POST /divisions/{id}/officials/auto`, so the
  id is one join away.
- `scorers.max` is real: `org_members.role = 'scorer'` is its own pool
  (`lib/invites.ts:67`), offered in `components/org-team.tsx`, excluded from
  the billing usage count (`billing.usage.scorerNote`). Free 1, Pro 1 today.
- `news.auto` gates both auto-drafted result posts and the weekly digest
  (`server/usecases/org-posts.ts:4,394,478`; `news.digestUpsell`). The
  drafting in `org-posts.ts` spends no AI credits (no `reserve()` call).
- Save points = `schedule.checkpoints.max` ("Delete this save point?" in
  `ui.json`). Undo/redo is always free; checkpoints are named restore points.
- Inert keys (defined, copy only, zero `hasFeature`/`getLimit` reads):
  `domains.custom`, `support.priority`, `officials.per_fixture.max`,
  `stats.club_championship`. `support.priority` and `officials.auto` and
  `api.write` are rendered on the pricing matrix (`ENTITLEMENT_DOMAINS`);
  `domains.custom`, `stats.club_championship`, `officials.per_fixture.max`,
  `scoring.audit_export`, `ai.credits.*`, `branding`, `exports` are not.
- `featurePlan()` (`lib/feature-copy.ts:157-170`) is a binary set
  (`PLUS_FEATURES` → `"pro_plus"`, else `"pro"`). `plan-label.ts` is a flat
  three-entry map. `PlanKey` is a zod enum in `lib/types.ts`.
- Pass credit grant is a single constant `PASS_CREDIT_GRANT = 25`
  (`lib/pricing-cards.ts:61`), read by `lib/pass-ladder.ts:50` and pinned by
  `copy-truth.ts:486`; v17 #294 chose "same grant for L, credit machinery
  unchanged". Per-rung grants need a keyed map, the webhook grant reading the
  pass key, and the copy-truth pin widened.
- `pro_plus` appears in 33 non-test files under `apps/web/src`, 58 test
  files, 8 e2e specs (`pro-plus-tier.spec.ts` 45 hits,
  `pricing-pro-plus.spec.ts` 7), and — as the literal "Pro Plus" — in 6
  `marketing.json` + 9 `ui.json` keys per locale, all four locales in parity.
  Help tree `apps/web/content/help/**` has 33 articles mentioning
  plans/pass/upgrade.
- FKs: `subscriptions.plan_key`, `plan_entitlements.plan_key`,
  `competition_passes.pass_key` all `references plans(key)` with no cascade.
  V290 retired `business` with a row-existence guard on `subscriptions`.
- One AI run costs 1–3 credits by rung (`lib/ai-rung.ts`); joint solves up
  to 11. Monthly grant job reads `ai.credits.monthly` (`lib/credits.ts:313`).
  `ai.credits.trial` exists for `pro` (20) and never for `community`.
- Pass → Pro credit redemption is **implemented**
  (`server/usecases/pass-credit.ts`).
- **Scoring gate is still live.** `assertEntitledToScore`
  (`server/usecases/scoring.ts`) and `requiredFeatureForEvent`
  (`server/usecases/fidelity.ts`) still throw 402 on the three `scoring.*`
  fidelity keys; the batch importer (`event-import.ts`) shares the predicate.
  R9 pins the read sites, the four tests that assert today's refusals
  (`scripts/smoke.ts:5486-5525`, `fidelity.test.ts:63-79`,
  `entitlements-v2.test.ts:219-227,365,452`) and the `cricket.superover.ball`
  drift trap.
- Uncapped anywhere today: venues, courts, seasons, players, pending invites,
  API keys, exports, notification sends, device-link count.

## 1. Owner rulings (2026-09-02)

| # | Ruling |
|---|---|
| R1 | Three public offers: Free, Pro, Event Pass. Pro Plus retired. |
| R2 | No public unlimited team or squad size. AI credits capped on every public plan. |
| R3 | White label, custom domain, write API, priority support → "Contact Us". |
| R4 | Pro `teams.max` = **100**. |
| R5 | `officials.auto` on **Pro and on both Event Pass rungs** (round 2 widened round 1's "Pro"). |
| R6 | Free `competitions.max_active` 10 → **3**. Free divisions/entrants untouched. |
| R7 | Greenfield — no prod data. `pro_plus` rows are **deleted** outright, no grandfathering. |
| R8 | R9 ("scoring goes free") is included in this programme. Fidelity bands stay as a UX choice, never a price boundary. The scoring pad itself is free on every plan. |
| R9 | AI credits: Free **5**/mo, Pro **35**/mo, Pass M **+25**, Pass L **+50** (per-rung grant). |
| R10 | Staff seats (`members.max`): Free **3**, Pro **10**. |
| R11 | Device hand-over (`scoring.device_links`) is a paid feature: Pro, and both pass rungs (PO recommendation accepted by silence — see §2). |

Product-owner defaults below were presented and not overridden; treat them as
approved and change any single cell at review without touching the design.

## 2. The full matrix — every key, reviewed

Columns: Free / Pro / Pass M / Pass L / Enterprise. `–` = no row (a pass
falls through to the org's plan). `∞` = int null. Bold = changes from today.
Rationale is one line per changed row; unchanged rows say "keep".

### Scale (the Pro value metric)

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `orgs.max_owned` | 1 | 5 | – | – | ∞ | keep; extra org $9/mo add-on stays |
| `members.max` (staff) | **3** | **10** | – | – | ∞ | R10; extra seat $4/mo add-on stays |
| `scorers.max` | **2** | **10** | – | – | ∞ | pool exists (Background); 1/1 was indistinguishable from Free. Volunteer scorer logins are cheap seats; a club with ten is normal. Alternative rejected: merging into staff seats would let scorers eat the 10 staff |
| `competitions.max_active` | **3** | ∞ | +1 | +1 | ∞ | R6; Pro headline stays "unlimited competitions" |
| `dashboard.public.max` | **3** | ∞ | – | – | ∞ | growth: equals Free's 3 competitions so every free competition can be public and carry the badge. Org-level, a pass cannot lift it, which is why it must equal the comp cap |
| `divisions.per_competition.max` | 4 | **20** | 10 | 20 | ∞ | R2: bounded; 20 is a federation |
| `stages.per_division.max` | 2 | **6** | **4** | **4** | ∞ | pass today falls to Free's 2, which blocks a plate/bowl |
| `entrants.per_division.max` | 64 | 256 | 128 | **512** | ∞ | R2; size pack +32 stays |
| `teams.max` | 8 | **100** | – | – | ∞ | R4 |
| `teams.squad_max` | 20 | **40** | – | – | ∞ | cricket 15, football 23, rugby 23: Free = one matchday squad, Pro = season roster. Pass rows (20 = Free) were no-ops and are dropped |
| `clubs.max` | 5 | **25** | – | – | ∞ | bounded |
| `import.bulk` (rows) | 50 | **500** | – | – | ∞ | bounded |

### Money

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `registration.enabled` | T | T | T | T | T | keep |
| `registration.paid` | T | T | T | T | T | keep |
| `registration.fee_percent` | 8 | 2 | 5 | 5 | 1 | keep; 8% is how Free pays for itself, 5% is a pass reason, 2% a Pro reason |
| `sponsors.tiers` | F | T | T | T | T | keep (organiser monetisation = leverage) |
| `sponsors.monetize` | F | T | T | T | T | keep |

### Formats & standings

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `formats.advanced` | F | T | T | T | T | keep (americano, ladders, custom brackets, feeds) — pass trigger |
| `formats.double_elim` | **T** | T | T | T | T | growth: double-elim is the club-night format for racquet sports; gating it makes Free feel broken on night one |
| `standings.custom_points` | **T** | T | T | T | T | correctness: bonus and forfeit points are how rugby and cricket tables are *right* |
| `tiebreakers.custom` | **T** | T | T | T | T | correctness: wrong tiebreak order = wrong table |
| `standings.carry_over` | F | T | T | T | T | keep (multi-phase leagues are Pro-sized) |
| `discipline.enforced` (suspensions) | F | T | **T** | **T** | T | owner asked. Automation = leverage, stays paid; a weekend cup with cards needs it, so the pass gets it |

### Scheduling & officials

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `scheduling.board` | T | T | T | T | T | keep |
| `scheduling.constraints` | T | T | T | T | T | keep |
| `scheduling.ai` | T | T | T | T | T | keep; metered by credits |
| `scheduling.multi_division` | **T** | T | T | T | T | correctness: Free has 4 divisions; scheduling them separately guarantees venue clashes |
| `schedule.checkpoints.max` (restore points) | 2 | **10** | **5** | **5** | ∞ | owner asked. Undo/redo always free; named restore points are a safety net. 2 free, 5 for a tournament weekend, 10 for a season. Competition-scoped, so the pass can lift it |
| `schedule.versioning` (scope locks) | F | T | – | – | T | keep (multi-site operations) |
| `officials.roles_multi` | T | T | T | T | T | keep |
| `officials.marks` | T | T | T | T | T | keep |
| `officials.auto` | F | **T** | **T** | **T** | T | R5; code change: pass the division's competition id at `officials.ts:396,435` or the pass row is invisible |
| `officials.per_fixture.max` | — | — | — | — | — | **delete key**: ∞ on every plan and never read |

### Scoring & stats

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `scoring.ball_by_ball` | — | — | — | — | — | **delete key** (R9) |
| `scoring.rally_by_rally` | — | — | — | — | — | **delete key** (R9) |
| `scoring.match_timeline` | — | — | — | — | — | **delete key** (R9) |
| `scoring.device_links` (hand over a device) | F | T | **T** | **T** | T | R11. Leverage: many volunteers scoring in parallel. The strongest Free → Pass trigger ("six courts? $29"). Minted per fixture, so the overlay works |
| `scoring.audit_export` (signed audit trail) | F | T | **T** | **T** | T | tournament disputes are where the signed trail is wanted |
| `cricket.dls` | **T** | T | T | T | T | correctness: a rain-rule result is the result. Manual target "still works" is exactly the correctness paywall R9 forbids |
| `stats.player` | F | T | **T** | **T** | T | keep Pro (reach + data value); pass gets top-scorer tables for the weekend |
| `dashboard.player_profiles` | **T** | T | T | T | T | growth: a player sharing their own profile page is the cheapest acquisition loop the product has; badge on. Risk: removes a Pro bullet — accepted, Pro sells scale |
| `realtime` (live scoreboard) | F | T | T | T | T | keep paid: it has marginal cost and it is THE pass trigger ("live scores on the big screen") |

### Reach & brand

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `branding` (org logo) | T | T | T | T | T | keep |
| `dashboard.branding` (badge off) | F | T | F | F | T | D7, never moves |
| `exports` | T | T | T | T | T | keep |
| `exports.branded` | F | T | T | T | T | keep |
| `logos.bulk` | F | T | – | – | T | keep (convenience) |
| `embeds.enabled` | **T** | T | T | T | T | growth: an embed on a club website is the badge on someone else's site |
| `discovery.listed` | T | T | T | T | T | keep |
| `discovery.featured` | F | T | – | – | T | keep |
| `discovery.branding` | F | T | – | – | T | keep |
| `news.auto` (auto posts + weekly digest) | **T** | T | T | T | T | owner asked. No AI spend, cheap rows, and every auto post is shareable content with the badge on. Free |
| `clubs.hierarchy` | T | T | T | T | T | keep |

### Platform & credits

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `api.access` (read) | F | T | – | – | T | keep |
| `api.write` | F | F | – | – | T | R3 — the one real enterprise gate |
| `domains.custom` | — | — | — | — | — | **delete key**: no code behind it. Sold in the Contact-Us conversation, built later |
| `support.priority` | — | — | — | — | — | **delete key**: a label, not a gate. Lives in Contact-Us copy |
| `stats.club_championship` | — | — | — | — | — | **delete key**: inert |
| `ai.credits.monthly` | **5** | **35** | – | – | **500** (staff override per deal) | R9 |
| `ai.credits.trial` | – | 20 | – | – | 20 | keep |
| pass credit grant (constant, not a key) | | | **+25** | **+50** | | R9; per-rung map replaces `PASS_CREDIT_GRANT` |

Rule going forward: **the matrix carries only enforced keys.** Anything that
is copy-only lives in dictionaries, never in `plan_entitlements`.

## 3. Positioning — what each card says

Cards are dictionary-driven (`pricing.community.*`, `pricing.pass.*`,
`pricing.pro.*`); the feature bullets in `lib/pricing-cards.ts` are
re-derived from the matrix and guarded by `lib/copy-truth.ts`. Target copy
(English; all four locales follow):

- **Free — "Run a club night."** 1 organisation · 3 staff + 2 scorer seats ·
  3 live competitions, each public · 4 divisions, 64 entrants each · every
  sport, every scoring detail · right tables (tiebreakers, bonus points, DLS)
  · double-elimination · joint scheduling · player profiles, embeds and
  auto-drafted posts (badge on) · online registration (8% fee) · 5 AI credits
  a month.
- **Event Pass — "One tournament, fully powered."** Per competition, no
  subscription. M: 10 divisions × 128 entrants, +25 credits. L: 20 × 512,
  +50 credits. Live scoreboard · hand-over scoring devices · auto officials ·
  suspension tracking · advanced formats · top-scorer stats · branded exports
  · sponsors · 5 restore points · 5% fee · counts toward Pro if you subscribe
  within 30 days. Nudge: three L passes ($177) cost more than Pro annual
  ($159).
- **Pro — "Your whole season."** Unlimited competitions · 100 teams · squads
  of 40 · 25 clubs · 10 staff + 10 scorer seats · 5 organisations on one bill
  · everything the pass has, all season · badge removed · API (read) · 35 AI
  credits a month · 2% fee · annual = two months free.
- **Contact Us — "Your federation."** A strip, not a card: unlimited seats,
  teams and organisations · write API · 1% fee · pooled AI credits · priority
  support. Listed as *"ask us"* and never as included: custom domain, white
  label, SSO — none exist yet; `copy-truth` keeps it that way.

### Why this attracts more customers without giving the product away

- **Three share loops go free**: player profiles, embeds, auto posts. Each
  one puts the badge in front of people who are not yet customers. None of
  them has meaningful marginal cost.
- **Free is never wrong**: DLS, tiebreakers, bonus points, joint scheduling,
  double-elim. A club that gets a wrong table on night one does not come back
  to pay; a club that gets a right table on night one tells the league.
- **The pass is the tournament organiser's whole toolkit**, so a first-time
  organiser has no reason to look elsewhere for a weekend — and every pass
  buyer is 30 days from a Pro redemption.
- **Pro's reasons are unambiguous**: more people (seats), more teams, more
  season (unlimited competitions, restore points), the badge off, the API,
  and the 2% fee. Nothing on Pro is something Free needs to be correct.
- **What stays paid has marginal cost or is leverage**: realtime, pads, AI
  credits, auto officials, suspension automation, branded exports, sponsors.

## 4. Contact Us — the `enterprise` plan

- New `plans` row `enterprise`, `is_public = false`, no Stripe price ids.
  Granted only by staff through the existing comped-plan path
  (`server/usecases/admin-plan.ts`) and per-org overrides
  (`org_entitlement_overrides`). Billing for such deals is off-platform or a
  bespoke Stripe subscription mapped by `planKeyForPrice`; out of scope here.
- `featurePlan()` becomes three-valued: `ENTERPRISE_FEATURES = {api.write}`
  plus any int whose Pro value is the ceiling → `"enterprise"`; everything
  else → `"pro"`. `scorers.max` and `officials.auto` leave the set.
- `upgrade-gate.tsx` `paidPlan()` and `plan-badge.tsx` render a **"Contact
  us"** CTA (mailto `hello@seazn.club`, subject prefilled with the feature's
  human label) when the target is `enterprise`, a price otherwise. No contact
  form in this programme.
- The pricing matrix table (`lib/pricing-matrix.ts`, `PRICING_PLAN_KEYS`)
  shows the four purchasable columns `community, event_pass, event_pass_l,
  pro`. Enterprise is the strip below it, not a column.

## 5. Migration `V<next>__entitlements_v18.sql`

Latest delta at spec time is V389. R9 (W1) takes the next number for its
three-key deletion; this migration takes the one after — re-read the deltas
directory when writing it. Order matters; FKs have no cascade.

1. Insert `plans('enterprise', is_public=false)`.
2. Insert the `enterprise` column by copying every `pro_plus` row with
   `plan_key = 'enterprise'`, then set `ai.credits.monthly = 500`,
   `registration.fee_percent = 1`.
3. Apply §2 to `community`, `pro`, `event_pass`, `event_pass_l`: updates
   where a row exists, inserts for the new pass rows (`officials.auto`,
   `scoring.device_links`, `scoring.audit_export`, `stats.player`,
   `discipline.enforced`, `stages.per_division.max`,
   `schedule.checkpoints.max`), deletes for the no-op pass `teams.squad_max`
   rows. `event_pass_l` rows stay derived from M where V341 did so; the
   entrant cap is the one L-specific value.
4. Delete the inert keys on every plan: `officials.per_fixture.max`,
   `domains.custom`, `support.priority`, `stats.club_championship`. (The
   three `scoring.*` fidelity keys are already gone after W1.)
5. `update subscriptions set plan_key = 'pro' where plan_key = 'pro_plus'` —
   greenfield (R7); this only ever touches local/staging rows.
6. `delete from plan_entitlements where plan_key = 'pro_plus'`;
   `delete from plans where key = 'pro_plus'`. Unconditional, unlike V290's
   guarded delete — R7 says there is nothing to protect.
7. Existing free orgs above the new caps are handled by the freeze principle
   (`server/usecases/entitlement-freeze.ts`): readable, no new creates. No
   V270-style grandfather override.

Stripe: remove the `pro_plus` plan and the `extra_org_pro_plus` add-on from
`config/stripe-plans.json`. `stripe:sync` only ensures existence, so the
products `Seazn Club Pro Plus` / `Extra Organisation — Pro Plus` are archived
by hand in the test and prod Dashboards (ops step, recorded in the runbook).

## 6. Code changes by area

Scope is R9, the `pro_plus` footprint (33 files), the new enterprise seam,
and three small behaviour changes (officials competition id, per-rung pass
credits, inert-key removal). Nothing here changes the resolver's semantics.

- **R9 — scoring free (its own wave, its own prompt file):** remove the
  fidelity branch of `assertEntitledToScore` and delete
  `requiredFeatureForEvent` outright (decision: it dies; an always-null
  function is an inert seam — record this in the scoringpad `_INDEX.md` as
  R9 asks). Retire `fidelityTiers` from `packages/engine/src/sport/module.ts`,
  every sport module and every read site; `PadSpec.fidelity` is the single
  model. Simplify `v3/recording-chip.tsx` to a plain detail picker (no lock,
  no upsell, no entitlement read; `frontend-design` first, three widths,
  walkthrough). Drop the three keys from `ENTITLEMENT_DOMAINS.scoring`,
  `feature-copy.ts`, OpenAPI docs and the matrix. Move the four pinned tests
  deliberately, each with a comment saying what it used to assert. R9's
  instrumentation item (log refusals before removal) is **dropped**, said so
  here: with no prod data there is nothing to learn from it.
- **Officials on a pass:** `officials.ts:396,435` resolve the division's
  competition id and pass it to `requireFeature`. Test: a Free org with a
  pass on competition A can run auto-officials on A's division and is 402'd
  on competition B's.
- **Per-rung pass credits:** `PASS_CREDIT_GRANT` becomes
  `PASS_CREDIT_GRANT: Record<"event_pass" | "event_pass_l", number>`; the
  checkout-completed grant reads the pass key from session metadata;
  `pass-ladder.ts`, `copy-truth.ts` `passCreditGrantFaults`, product
  descriptions in `stripe-plans.json` and help follow.
- **Inert-key removal:** `ENTITLEMENT_DOMAINS`, `feature-copy.ts`,
  `openapi.ts`, admin entitlements page, any test fixture that seeds them.
- **Types & labels:** `lib/types.ts` `PlanKey` enum (`pro_plus` →
  `enterprise`); `lib/plan-label.ts`; `lib/feature-copy.ts` (`PaidPlan`,
  `ENTERPRISE_FEATURES`, every "Pro Plus" reason string, new reasons for the
  keys that moved to Free — those entries are deleted, not reworded);
  `lib/entitlement-admin.ts` plan list.
- **Billing plumbing:** `lib/currency.ts` (no `pro_plus` prices),
  `lib/org-addon-plans.ts` (add-on-eligible set = `{pro}`),
  `lib/billing-group-view.ts`, `lib/credits.ts` credit-tier math,
  `server/usecases/billing-events.ts`, `billing-manage.ts`, `pass-credit.ts`,
  `extra-orgs.ts`, `admin-plan.ts` (comped plans = `pro | enterprise`),
  `app/api/billing/plan/route.ts` + `preview/route.ts` request enums.
- **Surfaces:** pricing page (`(marketing)/pricing/page.tsx`): 4 cards → 3
  + enterprise strip; delete `data-plus-card`, `CELL_TONE.pro_plus`,
  `pricing.faq.proPlus`; `lib/pricing-cards.ts` drop `PLUS_CARD_FEATURES`,
  `PLUS_COMING_SOON`. Billing settings page: remove the Plus upsell block
  (435-456) and `plus@seazn.club`, ladder becomes Community / Pro + "Need
  more? Contact us"; usage rows gain scorer seats. `components/billing-manage.tsx`,
  `billing-actions.tsx`, `create-org-form.tsx`, `board/ai-out-of-credits.tsx`,
  `upgrade-gate.tsx`, `plan-badge.tsx`. `lib/email.ts` copy numbers.
- **UI bar:** the pricing page and billing settings page are re-verified by
  screenshot at 1280 / 768 / 320 with no horizontal scroll; the seven-width
  `mobile.spec.ts` matrix covers the pricing route. Two layout options for
  the enterprise strip are shown before building (standing rule).
- **Dictionaries:** all `pricing.plus.*` keys removed; 6 + 9 "Pro Plus"
  strings per locale rewritten; `news.digestUpsell` and every upsell string
  for a key that went Free deleted; new keys for the enterprise strip, the
  pass ladder nudge, the Contact-us CTA. All four locales, then `gen-keys`
  regen.
- **Help:** `content/help/billing/plans.md`, `event-pass.md`, `add-ons.md`,
  `credits.md`, `api/keys.md`, and the rest of the 33 matched articles
  rewritten to three offers + Contact Us. `help-copy-truth.test.ts` and the
  other `copy-truth.ts` consumers are the gate.
- **Copy-truth guards:** `plusDifferentiatorFaults` deleted;
  `capClaimFaults` learns that L is 512 not "unlimited";
  `passCreditGrantFaults` per rung; a new `enterpriseClaimFaults` fails any
  dictionary/help string that presents custom domain, white label or SSO as
  included; a new `freeClaimFaults` fails any string that still calls a
  now-free key "a Pro feature".

## 7. Behaviour when a cap tightens

- **Freeze, never delete** (existing rule). A Free org with 7 active
  competitions keeps them readable and scoreable; the next create returns 402
  with `competitions.max_active`. A Pro org with 60 teams keeps them; team
  101 is blocked. Squads over 40 are untouched until a new member is added.
  A Free org with 5 staff keeps them; the next invite acceptance is blocked.
- **Pass expiry** unchanged: 7-day grace, then the competition's caps fall
  back to the org's plan; over-cap rows freeze.
- **Downgrade Pro → Free** unchanged: `entitlement-freeze.ts`.
- 402 copy for every changed key names the number the customer hit and the
  next rung, or "Contact us" when the next rung is enterprise
  (`featureReason` / `upgrade-gate` share one source).

## 8. Tests (all four types, per RULES.md)

- **Unit:** matrix pin test derives expected values from §2 and asserts
  every cell against a fresh DB (never a table typed in the test that can
  drift from the migration); `featurePlan()` three-way; `PlanKey` enum has no
  `pro_plus`; no row exists for any deleted key; `copy-truth` suites green
  with the new guards; `org-addon-catalog-parity` with one add-on; credits
  grant job grants 5 / 35 / 500 and the pass grant 25 / 50 (cases where the
  right answer differs from the old constant).
- **E2E:** replace `pro-plus-tier.spec.ts` and `pricing-pro-plus.spec.ts`
  with `pricing-v18.spec.ts` (three cards, enterprise strip, no "Pro Plus"
  text anywhere on the route) and `enterprise-gate.spec.ts` (a Pro org
  creating a write-scope API key sees the Contact-us gate, not a price).
  **Pass proofs, driven through the real producer:** a Free org buys a pass,
  opens a fixture, mints a device link, scores from it; runs auto-officials
  on the pass competition and is refused on another; sees a top-scorer table.
  **Free proofs:** a Free org sets a custom tiebreaker order, publishes a
  player profile, embeds standings, generates a weekly digest, applies DLS.
  Walkthrough after each task group.
- **Smoke:** demo data and the smoke script lose every Pro Plus reference;
  the smoke org is Pro and exercises auto-officials and suspension tracking.
- **Regression:** the eight touched e2e specs (`ai-architect`,
  `payments-hardening`, `schedule-panels`, `billing`, `pricing-v3`,
  `helpers.ts`) rerun green; the seven-width mobile matrix on `/pricing`.
- **Mutation checks:** delete the `enterprise` branch in `featurePlan()` —
  the gate spec must go red; drop the competition id from the officials call
  — the pass-officials test must go red.
- **R9 acceptance (verbatim from its prompt):** a free-plan org records
  EVERY event type of EVERY sport at EVERY band through the real HTTP door
  (`api/v1/fixtures/[id]/events`) AND through the batch importer; the device
  link still may only void its own rows (the 403 in `scoring.ts` shown to
  bite); `git grep -a fidelityTiers` returns nothing; each removed guard is
  mutation-proven by restoring it and watching the new test go red;
  walkthrough — a free org, a real match, a band-3 event recorded and
  visible.

## 9. Programme shape

Sequential waves; they share `feature-copy.ts`, `entitlement-domains.ts`,
dictionaries, help and `copy-truth.ts`, so no parallel lanes.

1. **W1 — R9, scoring free:** gate removal, `fidelityTiers` retirement,
   recording chip, the three keys deleted from matrix + domains + copy +
   help, pinned tests moved. Own PR; runs first because it is independent of
   the plan change and clears the scoring rows off every pricing surface
   before W3 rewrites them. Its migration deletes the three keys' rows.
2. **W2 — matrix & plumbing:** V-next, inert-key deletion, types,
   `featurePlan`, labels, add-on sets, credits math, per-rung pass grant,
   officials competition id, `stripe-plans.json`, unit pins, copy-truth
   guards.
3. **W3 — surfaces:** pricing page, billing settings, gates, dictionaries
   ×4, emails, help, e2e replacements, screenshots at three widths.
4. **W4 — proofs & walkthrough:** pass and Free proof e2es, full product
   walkthrough on a prod build, Stripe archive ops step.

## 10. Out of scope (recorded so nobody re-derives them)

- A `scorers.max` seat add-on; a team pack add-on (R4 chose a flat 100).
- Custom domain, white label, SSO — sold in conversation, built later.
- A contact form; mailto stays.
- Capping venues, courts, seasons, players, pending invites, API-key count,
  exports, notification sends. Pending invites uncapped at creation is a
  known gap: an org can mint unlimited pending invites and only acceptance
  enforces `members.max`. Worth its own small fix, not this programme.
- Lifting org-level ints from a pass (would need a resolver change and an
  expiry story).
- Free realtime for one competition — considered, rejected: realtime has
  marginal cost and is the pass's headline.
- R9's optional refusal instrumentation — dropped, see §6.
