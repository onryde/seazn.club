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
| **Event Pass** (M $15 / L $29, one-time) | One tournament, fully powered. | competition size |
| **Pro** ($9/mo, $79/yr) | Your whole season. | organisation scale: seats, teams, squads, credits |
| **Contact Us** (dark `enterprise`) | Your federation. | unlimited + bespoke |

Prices are the R2 ladder ruled 2026-09-02 (§3a); they land in W2 with the
matrix.

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
- `scorers.max` was real (W2 T12 deleted the key; the pool below is history): `org_members.role = 'scorer'` is its own pool
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
| R13 | Extra-seat add-on is **hidden** for now (owner: "we don't have add-on for extra seat, right? so for now, hide that add-on"). Verified: `app/api/billing/extra-seats/route.ts` + `extra-seats.ts` + webhook sync exist, but no purchase control renders anywhere; only the pricing add-ons strip names it. Remove the strip line and every mention in copy/help; keep code and price dormant. |
| R12 | **Prices come down** (owner: "reduce the price"), ladder R2: Pro **$9/mo, $79/yr**; Pass M **$15**, Pass L **$29**. Five currencies stay (USD/EUR/GBP/AUD/INR), each at a **purchasing-power set point**, never an FX copy. Table in §3a. |
| R14 | **Pricing page = box office, plain Option A, with the sport rail kept as drawn.** Owner saw both hierarchy variants at 1280/768/320 and chose the version where the Event Pass keeps the glow and the only filled button; the Pro-elevated variant (Pro on the lit plate, Pass outlined) was **rejected**. The controller's counter-argument was stated first and overruled: the page therefore ranks a one-time $15 above the $9/mo recurring by design. Rail: ten sports in hairline-ruled slots (10 across at 1280, 5x2 at 768, wrapping printed ribbon at 320), sentence-case condensed, **no variant count printed** (DB says 37, `sync:sports` says 31, neither verified), `generic` as the board's foot line rather than an eleventh sport. Mockups of record: `pricing-option-a-rail.html` + its 320/768/1280 captures. |

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
| `members.max` (staff) | **3** | **10** | – | – | ∞ | R10; the extra-seat add-on is **hidden** (R13): backend and Stripe price stay dormant, nothing advertises it |
| `scorers.max` | — | — | — | — | — | **delete key** (W2 T12, owner ruling 2026-09-03): the cap meters a capability the product gives away. W1 made scoring free on every plan, and an ACCEPTED fixture official already reads AND scores with no org role at all (`requireFixtureActor`), so the seat is not separately sold. The scorer ROLE stays — deprecating it is its own wave (#707) |
| `competitions.max_active` | **3** | ∞ | +1 | +1 | ∞ | R6; Pro headline stays "unlimited competitions" |
| `dashboard.public.max` | **2** | **10** | – | – | ∞ | W2 T15, owner ruling 2026-09-03: Free 3 -> 2, Pro loses "unlimited". Org-level, so a pass cannot lift it — but a PASSED competition no longer counts against it, and neither does an archived one: `assertPublicQuota` was a flat row count with no status filter and no pass exclusion, so it metered history rather than live surfaces. Free's third active competition is what the create-path degrade (T15/F) exists for: 3 active competitions, 2 public dashboards, and a create that is never blocked |
| `divisions.per_competition.max` | 4 | **20** | 10 | 20 | ∞ | R2: bounded; 20 is a federation |
| `stages.per_division.max` | 2 | **6** | **4** | **4** | ∞ | pass today falls to Free's 2, which blocks a plate/bowl |
| `entrants.per_division.max` | 64 | 256 | 128 | **512** | ∞ | R2; size pack +32 stays |
| `teams.max` | 8 | **100** | – | – | ∞ | R4 |
| `teams.squad_max` | **23** | **40** | – | – | ∞ | Free = one matchday squad, Pro = season roster. 23 is the engine's own largest matchday squad, not a guess: `football.ts` declares `lineup: { size: 11, benchMax: 12 }` and `icehockey.ts` `{ size: 6, benchMax: 17 }`, both 23; cricket is 15 and volleyball 14, so they already fit. At 20 a football or ice-hockey club could not register its first full squad on Free at all (W2 T12; the earlier "rugby 23" rationale cited a sport the engine catalogue does not carry). Pass rows (20 = Free) were no-ops and are dropped |
| `clubs.max` | 5 | **25** | – | – | ∞ | bounded |
| `import.bulk` (rows) | 50 | **500** | – | – | ∞ | bounded |
| `import.events` (batch score import) | **T** | **T** | **T** | **T** | **T** | W2 T14, owner ruling 2026-09-03: LAUNCHED, on every plan. The key had no row at all and a `// 402 during rollout` kill-switch; R9 says scoring detail is never a price boundary and W1 already stripped the fidelity gate off this same importer, so gating it by plan would restore the boundary R9 removed. The house pattern for imports is a volume cap (`import.bulk` above), never a gate — if event-import volume needs bounding, add a CAP key. True everywhere, so it is deliberately NOT a `pricing-matrix.ts` row and not an `ENTITLEMENT_DOMAINS` entry: it differentiates nothing |

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
| `standings.carry_over` | F | T | – | – | T | keep (multi-phase leagues are Pro-sized). **Pass cells corrected 2026-09-03**: they read T, but no pass row has ever existed and Free is F, so a passed competition has never had carry-over — the row's own "Pro-sized" rationale and the §3 Event Pass card (which never lists it) both agree. Separately: nothing in the product emits `carry` at all, so this is a SOLD Pro feature with no control — F6 / issue #625, not this programme |
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
| `dashboard.player_profiles` | **F** | T | T | T | T | W2 T15, owner ruling 2026-09-03: one of the three share loops that go PAID. Reverses V392's growth cell, with the acquisition-loop argument put and overruled — value capture over the loop. The pass rows (V308) are what separate one competition from the next again, so `public-players-gate.test.ts` is back to asserting a dark unpassed competition |
| `realtime` (live scoreboard) | F | T | T | T | T | keep paid: it has marginal cost and it is THE pass trigger ("live scores on the big screen") |

### Reach & brand

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `branding` (org logo) | T | T | T | T | T | keep. An early W2 T15 draft flipped this to F on Free and the owner WITHDREW it: a free club uploads its own logo. What is sold is the removal of OUR badge — see `dashboard.branding` below |
| `dashboard.branding` (badge off) | F | **F** | F | F | T | W2 T15, owner ruling 2026-09-03: **the badge is SHOWN on every plan except enterprise.** This cell's old note read "D7, never moves" — it has now moved, deliberately, and that note is the older decision. Badge removal becomes an ENTERPRISE-only feature, which is where R3 already puts white label. Every self-serve plan carries our badge, Pro included: the acquisition loop the three share loops used to carry now runs through public dashboards instead |
| `exports` | T | T | T | T | T | keep |
| `exports.branded` | F | T | T | T | T | keep |
| `logos.bulk` | F | T | – | – | T | keep (convenience) |
| `embeds.enabled` | **F** | T | **T** | **T** | T | W2 T15, owner ruling 2026-09-03: paid on Free. The pass cells are the TRAP this row exists to record — the key had NO pass rows, because it did not need any while community granted it, so flipping Free without inserting them would have silently taken embeds off the competition an Event Pass paid for. V395 inserts both |
| `discovery.listed` | T | T | T | T | T | keep |
| `discovery.featured` | F | T | – | – | T | keep |
| `discovery.branding` | F | T | – | – | T | keep |
| `news.auto` (auto posts + weekly digest) | **F** | T | T | T | T | W2 T15, owner ruling 2026-09-03: paid on Free, reversing V392's own "owner asked" free cell. The pass rows stay, which makes this key pass-lifted — so the weekly digest, an ORG-level artefact, resolves its scope per competition (`newsAutoCompetitionScope`) instead of asking the org-wide question a pass cannot honestly answer |
| `clubs.hierarchy` | T | T | T | T | T | keep |

### Platform & credits

| key | Free | Pro | Pass M | Pass L | Ent | why |
|---|---|---|---|---|---|---|
| `api.access` (read) | F | T | – | – | T | keep |
| `api.write` | F | F | – | – | T | R3 — the one real enterprise gate |
| `domains.custom` | — | — | — | — | — | **delete key**: no code behind it. Sold in the Contact-Us conversation, built later |
| `support.priority` | — | — | — | — | — | **delete key**: a label, not a gate. Lives in Contact-Us copy |
| `stats.club_championship` | — | — | — | — | — | **delete key**: inert |
| `ai.credits.monthly` | **5** | **25** | – | – | **500** (staff override per deal) | R9; Pro re-cut 35 → 25 (W2 T12, owner ruling 2026-09-03) |
| `ai.credits.trial` | – | **15** | – | – | 20 | Pro re-cut 20 → 15 (W2 T12). Enterprise deliberately KEEPS 20 — its numbers are set per deal, so the asymmetry is intended and is not a drift to "fix" |
| pass credit grant (constant, not a key) | | | **+25** | **+35** | | R9; per-rung map replaces `PASS_CREDIT_GRANT`. L re-cut 50 → 35 with the monthly grants (W2 T12) |

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
  within 30 days. Nudge: three L passes ($87) cost more than Pro annual
  ($79).
- **Pro — "Your whole season."** Unlimited competitions · 100 teams · squads
  of 40 · 25 clubs · 10 staff + 10 scorer seats · 5 organisations on one bill
  · everything the pass has, all season · badge removed · API (read) · 35 AI
  credits a month · 2% fee · annual ≈ 8.8 months, "over three months free".

### 3a. Prices (R12) — every amount is a SET point per currency

Ladder rules that every number below satisfies and that
`org-addon-catalog-parity.test.ts` / `copy-truth.ts` keep pinned: Pass M <
Pass L < Pro annual; three L passes ≥ Pro annual; annual ≈ 8–9 months; the
graduated tier-2 (extra organisation) rate = half the base rounded DOWN to a
whole major unit (INR down to the nearest x99); pass price redeemable against
Pro within 30 days.

| Price | USD | EUR | GBP | AUD | INR |
|---|---|---|---|---|---|
| Pro monthly (tier 1) | 9 | 8 | 7 | 12 | 399 |
| Pro monthly tier 2+ / extra org add-on | 4 | 4 | 3 | 6 | 199 |
| Pro annual (tier 1) | 79 | 69 | 59 | 99 | 2,999 |
| Pro annual tier 2+ | 39 | 34 | 29 | 49 | 1,499 |
| Event Pass M | 15 | 14 | 12 | 19 | 599 |
| Event Pass L | 29 | 27 | 24 | 39 | 1,199 |
| Extra seat / month (**hidden**, R13 — catalog price kept for the dormant backend) | 2 | 2 | 2 | 3 | 99 |
| Size pack +32 (one-time) | 5 | 5 | 4 | 7 | 199 |
| AI credit packs 40 / 105 / 220 / 460 | unchanged (10 / 25 / 50 / 100 and today's set points) — credits are compute, not packaging |

Checks: 3 × L = 87 ≥ 79 (USD); 3 × 27 = 81 ≥ 69 (EUR); 3 × 24 = 72 ≥ 59
(GBP); 3 × 39 = 117 ≥ 99 (AUD); 3 × 1,199 = 3,597 ≥ 2,999 (INR). Two L passes
are cheaper than annual in every currency, so a two-tournament organiser is
never pushed into a subscription.

Why these points: INR at ₹399 is 29% of today's ₹1,399 — Indian clubs are the
volume market and were being charged near FX parity. GBP/EUR sit under USD
because club budgets there are set in whole tens. AUD sits above because AUD
prices are read against an AUD 15–20 coffee-and-court norm. Revenue per Pro
org falls 53% against today; the bet is volume plus the badge network.
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
- `featurePlan()` becomes three-valued: `ENTERPRISE_FEATURES = {api.write}`,
  and **nothing else**; everything else → `"pro"`. `scorers.max` and
  `officials.auto` leave the set.

  **CORRECTION 2026-09-03 (W2).** This bullet used to read "plus any int whose
  Pro value is the ceiling → `enterprise`". That rule is BACKWARDS and it
  shipped a regression before review caught it. `featurePlan` answers "the
  CHEAPEST plan that unlocks this key" — so if Pro is already unlimited, Pro is
  the answer. Sending `competitions.max_active` and `dashboard.public.max` to
  `enterprise` meant a Community organiser hitting the 3-competition cap saw an
  `Enterprise ◆` badge and a `mailto:` button, with the priced "Go Pro" link
  suppressed (`upgrade-gate.tsx` renders a price only for `kind: "priced"`) —
  no self-serve route out of the product's highest-volume Free→Pro gate. A key
  belongs in `ENTERPRISE_FEATURES` only when **no self-serve plan grants it at
  all**, which today is `api.write` alone (false on community, false on pro,
  true on enterprise).

  If an above-Pro int upsell is ever wanted, the correct predicate is the
  INVERSE: Pro finite and enterprise unlimited (`members.max` is pro 10,
  enterprise NULL). Even then, such a key is still `"pro"` for a Community org
  — `featurePlan` answers per KEY, not per caller's plan, so a plan-aware
  answer needs a different function, not a longer set.
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
- **Mobile is designed, not shrunk** (owner ruling 2026-09-02). The 320 view of
  every surface this programme touches is its own composition, not the desktop
  layout narrowed: information order may change, decorative structure that only
  earns its place at desktop may be dropped, primary actions sit in thumb
  reach, and type is sized for a phone read at arm's length outdoors. A 320
  capture that is the 1280 composition with smaller type is a rejection, not a
  pass. Each design says, in writing, what it decided differently at 320 and
  why — and where a decision is the same at both widths, why that is right.
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
   **Carried from W1 (2026-09-03):** widen `copy-truth.ts`'s per-locale
   paywall vocabulary. W1 built it from strings lifted out of shipped copy
   by a non-native speaker, held by a liveness floor per locale (es 148 /
   fr 115 / nl 133) so an emptied list cannot pass — but the word lists
   themselves want a native speaker. The mechanism is sound and bounded;
   it is the coverage that is thin.
3. **W3 — surfaces:** pricing page **redesigned** (owner 2026-09-02:
   "redesign price page as well, with admin ticket theme pricing card" —
   ticket-styled offer cards, the Event Pass literally a ticket stub;
   `frontend-design` first, two layout options to the owner before build,
   sign-off on screenshots at 1280/768/320), billing settings, gates,
   dictionaries ×4, emails, help, e2e replacements.
   **Carried from W1's visual pass (2026-09-03), all three seen in captures:**
   (a) the three non-Plus pricing cards are HARDCODED-ENGLISH arrays
   (`pricing/page.tsx`, grep the bullet arrays), so every bullet reaches
   fr/es/nl in English — the redesign must build them FROM THE DICTIONARIES,
   or it ships the same debt in better clothes;
   (b) at 320 the pricing MATRIX is shrunk, not composed — a 6-column desktop
   table in a horizontal scroller showing only feature + Community, so the
   width sign-off must cover the matrix and not just the cards;
   (c) at 320 the division tab rail scrolls the ACTIVE tab off-screen with no
   indicator (evidence `w1vis-upgradegate-320.png`); the billing settings rail
   solves this correctly, so copy that pattern rather than inventing one.
4. **W4 — proofs & walkthrough:** pass and Free proof e2es, full product
   walkthrough on a prod build, Stripe archive ops step.
   **Carried from W1 (2026-09-03):** sweep the nine anonymous e2e contexts
   that share the cookie-banner race W1 fixed in one spec. The banner mounts
   from a `useEffect` and is absent from SSR, so `page.goto` resolves BEFORE
   it exists and `dismissCookieBanner`'s `count()===0` early return is a
   silent no-op exactly under load (measured: banner up at 1x/6x CPU, mounting
   296–575ms late at 20x). W1's fix seeds the consent keys so the banner never
   mounts; the other nine still race, and they fail loudly rather than
   silently, which is why they were recorded rather than swept mid-wave.

## 10. Out of scope (recorded so nobody re-derives them)

- A `scorers.max` seat add-on; a team pack add-on (R4 chose a flat 100).
- A purchase control for the extra-seat add-on (R13 hides it; the backend
  stays so a later wave can surface it by mirroring the `addOns.extraOrg.*`
  control).
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
