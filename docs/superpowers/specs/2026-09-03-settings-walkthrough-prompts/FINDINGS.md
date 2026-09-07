# Settings walkthrough programme — findings register

Real defects found while driving the product, recorded as they are found (design §10) rather than held until W8. Each names the wave that found it, the evidence, and whether it is fixed or deferred.

## W4

### F1 — an enterprise group is told to upgrade to Pro, next to a line saying it already has no limit

Found: Task 2, `settings-add-ons-drive.spec.ts`.

An org whose group is on `plan_key = 'enterprise'` with a live subscription renders, on `/o/{slug}/settings/add-ons`, in this order:

> Using 1 organisations on this bill — your plan sets no limit.
> Add-ons are available on Pro. Upgrade to buy past the Community limit.

`enterprise` is a real row in `plans` with `plan_entitlements.orgs.max_owned = NULL` (unlimited) and no `org_addons` seed entry, so `addonAvailable` is false and `settings/add-ons/page.tsx` falls into its first branch — `addOns.communityNotice` — regardless of tier. The top tier is told to upgrade to a lower one, immediately after being told it already has no limit.

**Status:** open, not fixed this wave. `settings/add-ons/page.tsx`'s branch ladder needs a third arm (unlimited-cap tier with no addon SKU) distinct from the Community case. Deferred to W8 per design §10's default (test-only through W7); a small blast-radius fix, so worth an owner call on whether it should move earlier the way ruling 7 moved two W3 findings up.

### F2 — `addOns.cap.summaryUnlimited` has no plural rule: "Using 1 organisations"

Found: Task 2, same spec.

`addOns.cap.summaryUnlimited` is `"Using {count} organisations on this bill — your plan sets no limit."` and renders "Using 1 organisations" for a group with exactly one org — the commonest case there is. The sibling `addOns.cap.summary` ("Using {count} of {cap} organisations") reads acceptably at 1, so this is the unlimited-form key specifically. All four locale dictionaries owe the fix (repo i18n rule).

**Status:** open, not fixed this wave. Copy-only, all four dictionaries, no logic change — a good W8 batch item, or earlier if the owner wants small copy fixes to land immediately per ruling 7's precedent.

### F3 (documentation only, no product impact) — `org-addons.ts` documents a tier that does not exist

Found: Task 2, while deriving expected prices from the catalog.

`lib/org-addons.ts`'s module header, `orgAddonPriceMinor`'s doc comment, and `setExtraOrgs`' doc comment all describe "$9/mo Pro, $19/mo Pro Plus" and argue the two rates are load-bearing ("one flat rate would let Pro + extras undercut Pro Plus"). There is no `pro_plus` plan row today (`plans` holds `community, enterprise, event_pass, event_pass_l, pro`), and `config/stripe-plans.json`'s `org_addons` holds exactly one entry — `pro` at 699 (not 900). No live gap (every member of `PURCHASABLE_PLAN_KEYS` — just `pro` — has a rider), but the comments state a false catalog fact that a later session could build on.

**Status:** open. Comment-only fix, no test needed (nothing asserts the stale comment). Cheap enough to fix inline whenever a session next touches this file; not worth a dedicated task. The same stale claim also appears at `apps/web/src/app/api/billing/extra-orgs/route.ts:13` — both sites move together.

### F4 (documentation only, no product impact, but it is F1's own false premise) — `add-ons-tab.ts` claims no plan grants an unlimited cap

Found: Task 2 reviewer, while confirming F1.

`add-ons-tab.ts:141-142` states "No plan grants unlimited `orgs.max_owned`, so `orgCap === null` means a staff override with a null `int_value`" and uses that to argue the `capReduced` second branch is unreachable. `V393__entitlements_v18.sql:25-26,46-48` falsified this when it added the `enterprise` plan with `orgs.max_owned` unlimited — which is the exact mechanism F1's contradictory copy runs through. The `capReduced` logic itself is still correct (the claim is about reachability, not behavior), so this is documentation-only, but a future session re-deriving F1's cause from this comment would derive it wrong.

**Status:** open, same disposition as F3 — comment-only, fix whenever the file is next touched.

### F5 (real, moderate) — a Stripe outage on `/settings/billing` is indistinguishable from "no customer", and silently drops Cancel's own preconditions

Found: Task 3, `settings-billing-panels.spec.ts`.

`server/usecases/billing-manage.ts:317-319` — `getBillingOverview` ends in a bare `catch { return null; }`, with no log and no distinction between "this group has no Stripe customer" and "Stripe just failed" (outage, rate limit, key rotation). `settings/billing/page.tsx:434` and the surrounding block render cards, invoices, billing address, tax IDs, the interval switcher and `PromoCodeBox` only when `overview` is truthy — but `Cancel subscription` does not need `overview` and stays visible.

So during any Stripe failure, a paying customer opening `/o/{slug}/settings/billing` sees a page that says they have no card on file and no invoices, with nothing indicating anything went wrong, while still being offered Cancel subscription. AGENTS.md failure class 6 — an absent symptom that means suppressed, not safe.

**Reproduction:** seed an org with `setOrgSubscriptionSql(orgId, { plan_key: "pro", status: "active", stripe_subscription_id: "sub_e2e_x" })`, leave `stripe_customer_id` null, open `/o/{slug}/settings/billing` as the payer. Observe: Cancel subscription visible, no promo box, no card section, no invoice list, no error message. The null-customer case (never subscribed to Stripe) is legitimate to show this way; the identical rendering for a genuine Stripe failure is the defect.

**Sharper than first reported (Task 3 reviewer):** `settings/billing/page.tsx:425-426` also gates `RetryPaymentButton` on `overview?.hasOpenInvoice`, and `:435` gates `PlanIntervalSwitcher` on `overview?.interval`. So during a Stripe outage, a `past_due` payer specifically loses the ability to retry their payment — the one control that could get them out of the state — while Cancel subscription, the one destructive control, is the only money control left standing.

**Status:** open, not fixed this wave. `getBillingOverview` should distinguish "no customer" from "fetch failed" (e.g. rethrow or return a tagged error the page can show), and the page should surface a visible error state rather than silently rendering the empty-customer UI. Worth a W8 fix given the money-adjacent surface; an owner call on whether it moves earlier per ruling 7's precedent.

### F6 (real, pre-existing, low/medium) — the cancel dialog and promo box are hardcoded English

Found: Task 3, same spec.

On an otherwise fully-localised surface (everything around them goes through `t(dict, …)`), `billing-manage.tsx` hardcodes: the cancel confirmation dialog's title, body copy, the five `CANCEL_REASONS` options, and its buttons (`:462-537`); and the promo box's "Have a promo code?" trigger, its `aria-label`, button labels, and two error fallbacks (`:887-944`). A Spanish, French, or Dutch payer sees an English cancellation dialog and an English promo box.

**Status:** open, pre-existing (not introduced by W4). Fix is four locale dictionaries plus a `CANCEL_REASONS` key per reason, then `gen-keys`. Flagged rather than fixed this wave — the scope and blast radius (a user-facing money dialog's full copy, ×4 locales) is larger than the small mechanical fixes ruling 7 moved up; better suited to a dedicated task.

### F7 (real, moderate) — a sponsor's pay-now link is unrecoverable the moment the banner goes

Found: Task 4, `settings-sponsor-monetize.spec.ts`, while driving the invoice leg.

`startSponsorCheckout` (`server/usecases/sponsors.ts`) mints a real Stripe Checkout Session and returns its URL, but **nothing persists it**. `sponsor_orders` has no session column at all — `id, org_id, package_id, sponsor_name, sponsor_email, payment_intent_id, amount_cents, currency, status, sponsor_id, created_at, paid_at, disputed_at, dispute_id` (read off the live table, not off `ORDER_COLS`). The URL exists in exactly two places: the emailed invoice, and `sponsor-packages.tsx`'s `sentUrl` React state, which is cleared by a page reload, by navigating away, and explicitly by `setSentUrl(null)` on the very next Send-invoice toggle (`sponsor-packages.tsx:376`).

The orders list renders sponsor name, email, amount, a status badge, a Refund button (paid only) and an evidence link (disputed only). There is no payment link, no copy-link and no re-send on a `pending` row — so once the banner is gone the organiser cannot answer "the sponsor says they never got it" without minting a SECOND order, which the console's own duplicate dialog warns about in its own words: "Both payment links stay payable — the sponsor could pay twice."

Registrations do not have this gap: `registration_groups.checkout_session_id` is stored (`registrations.ts:347, 2440`), the mint path is re-entrant, and a superseded session is expired rather than left payable (`expireSupersededCheckoutSession`, `registrations.ts:2468-2469`). Sponsors have no equivalent on either half.

**Reproduction:** with a connected org, sell a package, send an invoice, then reload `?tab=sponsors`. Observe: the order row is present and `pending`, and there is no way from the console to reach or resend its payment link.

**Status:** open, not fixed this wave — it is a schema column plus a re-send/copy affordance plus supersede-on-remint, which is a task, not an inline fix. Not a defect in anything W4 built; found by driving the surface W2 deliberately left uncovered.

## W5

F-numbers continue W4's sequence so every id in this file stays unique.

### F8 (real, moderate) — a partial PATCH can leave a competition ending five months before it starts

Found: Task 2, `settings-competition-gates.spec.ts`, while building the ends-before-starts case.

`checkDateOrder` (`server/api-v1/schemas.ts:73-80`) is a `superRefine` on the request BODY, attached to the create and the patch schemas (`:107`, `:141`). It can therefore only compare the dates a request CARRIES. Nothing re-checks the pair against the row that is already stored: `patchCompetition` (`server/usecases/competitions.ts:471`) touches `starts_on`/`ends_on` only in a "did anything change" boolean (`:630`) and a cache-invalidation comment (`:633-635`), `ENDS_BEFORE_STARTS` appears nowhere in the use-case, and there is no CHECK constraint on the table either (no `ends_on` CHECK anywhere under `db/migration/deltas`).

So an inverted pair sent in ONE request is correctly refused 400, while the same inversion assembled across TWO requests is accepted.

**Reproduction — verified live against the running server (W5 T2 probe, 2026-09-06), not reasoned about:** with `starts_on = 2027-06-01` already stored, `PATCH /api/v1/competitions/{id}` with a body of `{ "ends_on": "2027-01-01" }` alone answers **200**, and a read-back shows the row ending five months before it starts. The settings form always sends both dates, so this is script-only — but `/api/v1` is a public API.

**It carries an F4-shaped false premise on top.** `server/api-v1/schemas.ts:65-68` states the gap is already closed — "the patch can only see the dates it CARRIES, which is why the same order is re-checked in the use-case against the stored row". No such re-check exists. A later session re-deriving this from the comment derives it wrong, which is exactly the harm F3 and F4 were recorded to prevent.

**Status:** open, deliberately NOT fixed and NOT asserted against in W5. Pinning the 200 would freeze a live bug as the suite's expected value (AGENTS.md failure class 4); asserting the 400 it ought to give would red the branch for a defect this wave did not create; and patching production code mid-review is outside a test-only wave's remit (design §10). The fix is a re-check inside `patchCompetition` against the stored row, plus correcting the `schemas.ts` comment. When it lands, its case belongs in `settings-competition-gates.spec.ts` beside the existing full-pair case, where a comment already marks the spot.

### F9 (documentation only, assessed NOT exploitable) — `branding` writes are ungated while every read of them is gated

Found: Task 2 and the whole-branch final review, while enumerating `patchCompetition`'s `requireFeature` calls.

`patchCompetition` gates exactly two keys: `discovery.listed` (`usecases/competitions.ts:517`) and `discovery.branding` (`:520`). `PatchCompetition` accepts `branding: z.record(z.string(), z.unknown())` (`api-v1/schemas.ts:133`) and `:582` writes it, so a non-entitled org's scripted `{ branding: { colors: { primary } } }` PATCH is accepted and stored.

Every READ path is gated on `dashboard.theme`, so the stored value is inert. `public_competitions_v` returns `'{}'::jsonb` unless `org_has_feature(org_id, 'dashboard.theme')` (`deltas/V397__dashboard_theme_key.sql:71`), which covers `getPublicOrg`, `getPublicCompetition` and `embed-data.ts`; `/score/[token]/page.tsx:86` is the one place reading `c.branding` off the base table, and it applies it only behind `chrome.themed` (`:100`), itself a `hasFeature(orgId, "dashboard.theme")` call (`server/slideshow-data.ts:106-107`).

**Status:** recorded, no fix opened. Ruled a write-side asymmetry with no rendering consequence — defence-in-depth, not an entitlement bypass: a stored value can only ever take effect once the org is entitled, at which point it is theirs anyway. Recorded so a later wave does not re-derive the question and answer it wrongly in either direction. A `requireFeature` on the write would be optional hardening, not a defect fix.

### F10 (real, low severity) — `invalidateOrgEntitlements` fails open on either request

Found: the final whole-branch review's fix round, while gating W5's own calls to this helper on `REDIS_URL` to close an unrelated shared-user contention finding (Important #1, this wave).

`invalidateOrgEntitlements` (`e2e/helpers.ts`) flips an org's owner to superadmin, makes two `fetch` calls, then flips the owner back — and never checks either fetch's response status. A failed invalidation (a dropped connection, a 5xx) is silent: the caller proceeds believing the cache was cleared when it was not.

**Status:** open, not fixed. Three existing specs already call this helper as written, so a fix belongs to the helper itself, not to any one caller — out of scope for this wave, which only needed to stop calling it where it bought nothing. Recorded so W8 (or whichever wave next touches `helpers.ts`) can add the status checks without re-discovering the gap from scratch.

## W6

F-numbers continue W5's sequence so every id in this file stays unique.

### F11 (documentation only, not exploitable) — `dailyHoursToWindows`'s malformed-HHMM guard is dead code

Found: Task 1, `settings-schedule-drive.spec.ts`, while mutation-testing case #17's coverage before deciding whether it owed a new unit test.

`dailyHoursToWindows` (`apps/web/src/lib/schedule-board.ts:191-192`) runs two guards in sequence: `if (!HHMM.test(fromHHMM) || !HHMM.test(toHHMM)) return null;` (line 191), then `if (fromHHMM >= toHHMM) return null;` (line 192). Mutating line 191 to `if (false) return null;` and rerunning `schedule-board.test.ts`'s existing 19-case suite left it **19/19 green** — no test distinguishes the guard's presence from its absence.

The reason is a coincidence that holds for every reachable call shape, not just the suite's own cases: any malformed HH:MM string sorts in a way that makes the SECOND guard (line 192, a plain JS string comparison) independently return null too — `"9am" >= "6pm"` is `true` because `'9' > '6'`, and an empty string (the half-filled case — one play-hours field left at the real `<option value="">` `datetime-field.tsx` always renders) sorts before any non-empty one, so `fromHHMM >= toHHMM` is `true` there as well. Separately, any malformed value also re-hits an identical `/^\d{2}:\d{2}$/` regex one level down in `isoFromZonedParts` (`zoned-datetime.ts:37`) before a window is ever produced, since `days` defaults to 14 whenever `endIso` is `null` and the day loop always runs at least once. There is no way to observe a different RETURN VALUE by deleting line 191, for any malformed or half-filled input this codebase can produce.

Verified rather than assumed: mutating line 192 instead (the genuine inversion check) reddened 1/19 tests on the exact `"18:00","09:00"`/`"09:00","09:00"` cases — confirming line 192 is the load-bearing guard and line 191 is the redundant one, not that the suite is blind to guards generally.

**Status:** recorded, not fixed. Dead code, no behavioral risk — line 191 is redundant with a deeper check inside `isoFromZonedParts`, not a missing check with a live consequence. Removing it is optional cleanup whenever `schedule-board.ts` is next touched, not a defect fix. Full mutation-testing trace: `.superpowers/sdd/2026-09-07-settings-walkthrough-w6/task-1-report.md`, "Case #17: unit test vs. the one browser assertion".

## W7

F-numbers continue W6's sequence so every id in this file stays unique.

### F12 (real, low severity — script-only, NOT fixed) — an explicit `null` on ONE half of the age cutoff is accepted, and stores an orphan half

Found: Task 2, `settings-registration-bounds.spec.ts`, while confirming the plan's Step 1 both-or-neither prediction against a running server rather than against `checkAgeCutoff`'s source.

`PATCH /api/v1/divisions/{id}` refuses a single-field cutoff patch when the field carries a VALUE — `{ "age_cutoff_month": 6 }` answers 400 with `AGE_CUTOFF_BOTH_OR_NEITHER`, which is what the wave's own test pins. It does **not** refuse the same shape when the field carries an explicit `null`.

**Reproduction — driven live against the running server (sw7, 2026-09-07), not reasoned about.** With `age_cutoff_month = 9, age_cutoff_day = 1` already stored:

- `PATCH { "age_cutoff_day": null }` → **200**, and the row reads back `age_cutoff_month: 9, age_cutoff_day: null`.
- `PATCH { "age_cutoff_month": null }` → **200**, and the row reads back `age_cutoff_month: null, age_cutoff_day: 1`.

Both are states the both-or-neither invariant says cannot exist.

**Two guards, and neither can see it.**

1. `checkAgeCutoff` (`api-v1/schemas.ts`) tests `(v.age_cutoff_month != null) !== (v.age_cutoff_day != null)`. `PatchDivision` is `.partial()`, so a field the caller omitted arrives as `undefined` and an explicit null arrives as `null` — and `!=` null collapses the two. For `{ age_cutoff_day: null }` the expression reads `false !== false`, so nothing fires. Unlike `age_min`/`age_max`, which `patchDivision` MERGES against the stored row before deciding (`usecases/divisions.ts`, the RS004 review finding-1 fix), the cutoff pair has no merge step at all — the guard only ever sees the request body.
2. The DB CHECK cannot backstop it either, for a SQL three-valued-logic reason rather than a missing clause. `divisions_age_cutoff_check` is `((month IS NULL AND day IS NULL) OR ((month >= 1 AND month <= 12) AND (day >= 1 AND day <= 31)))`. With `month = NULL, day = 1` the first disjunct is `false` and the second evaluates to `NULL`; `false OR NULL` is `NULL`, and a CHECK constraint passes on `NULL`. So `isAgeCutoffCheckViolation` (`usecases/divisions.ts:842`) never fires for a half-null row — only for a row that violates the RANGE.

**It carries an F4/F8-shaped false premise on top.** `api-v1/schemas.ts:263-267` states the gap is already covered — "usecases/divisions.ts's isAgeCutoffCheckViolation backstops the READ COMMITTED race a merge-and-validate guard can't see, same pattern as AGE_MAX_BEFORE_MIN/checkAgeBand above". It is not the same pattern: `checkAgeBand` HAS a merge-and-validate guard in the usecase and `checkAgeCutoff` has none, and the CHECK the comment leans on is structurally unable to reject a half-null row. A later session re-deriving this from the comment derives it wrong.

**Consequence, and why it is low severity.** The orphan is not inert: `ageBandEligibilityIssues` (`lib/registration-rules.ts`) resolves the cutoff as `age_cutoff_month ?? 1` / `age_cutoff_day ?? 1`, so a row left at `month = 9, day = null` keeps evaluating ages at **1 September** when the organiser's intent in clearing the day was to return to the 1 January default. (The mirror case, `month = null, day = 1`, resolves to 1 January and is harmless.) It bites only where the division also carries an `age_min`/`age_max`, since that function returns early with no band. And it is script-only from the product: the config panel always sends BOTH fields on every save (`toDivisionPatchBody`, `registration-hub-config-state.ts:129-130`) and its month `<select>` nulls the day whenever the month goes null (`registration-hub-config-panel.tsx:705`). `/api/v1` is a public API, so "the panel never sends it" bounds the blast radius rather than closing it.

**Status:** open, deliberately NOT fixed and NOT asserted against in W7 — the same call F8 records for the same shape. Pinning the 200 would freeze a live bug as the suite's expected value (AGENTS.md failure class 4); asserting the 400 it ought to give would red the branch for a defect this test-only wave did not create; and patching production code mid-wave is outside a test-only wave's remit. The fix is a merge-against-the-stored-row check for the cutoff pair inside `patchDivision`, exactly like the one `age_min`/`age_max` already has, plus correcting the `schemas.ts` comment (and, optionally, rewriting the CHECK as `num_nulls(age_cutoff_month, age_cutoff_day) <> 1` so the constraint can actually hold the invariant). When it lands, its case belongs in `settings-registration-bounds.spec.ts`'s both-or-neither test, where a comment already marks the spot.

### F13 (documented behaviour, not a defect) — an age cutoff with no age band is accepted, and is inert until a band exists

Found: Task 2, `settings-registration-bounds.spec.ts`. The W7 plan predicted this outcome from reading `checkAgeCutoff` and `patchDivision`; recorded here because it was then DRIVEN, which this programme's standing rule requires before a predicted outcome may be committed as an assertion.

**Observed live (sw7, 2026-09-07), not reasoned about.** On a division with `age_min = age_max = null`, `PATCH /api/v1/divisions/{id}` with `{ "age_cutoff_month": 9, "age_cutoff_day": 1 }` answers **200**, and the division GET reads back `age_cutoff_month: 9, age_cutoff_day: 1, age_min: null, age_max: null`. Nothing refuses a cutoff that has no band to anchor — the two are independently nullable by design (`PatchDivision`, `api-v1/schemas.ts`), and `checkAgeCutoff` only relates the cutoff's own two halves to each other.

The stored value is inert while the band is absent: `ageBandEligibilityIssues` (`lib/registration-rules.ts`) returns early on `if (division.age_min == null && division.age_max == null) return issues` before the cutoff is ever read, so such a division reports no eligibility issue and applies no rule. It becomes live the moment a band is added, which is the point of allowing the write.

**Not claimed by the spec, and deliberately so.** `ageBandEligibilityIssues` is not reachable from any read this API-only file performs — it runs inside the organiser-side roster gates (`usecases/registration-eligibility.ts`) and needs a person with a `dob` on a roster. Calling the pure function from the spec against a hand-built person would be a fixture on both ends proving only the fixture, so the test asserts the WRITE and the stored row and says in a comment what it does not cover.

**And that state is NOT covered by an existing unit test either — corrected here.** An earlier draft of this entry claimed the predicate's behaviour for a bandless division "is covered where it belongs, in `lib/__tests__/registration-rules.test.ts`". That is false: every case in that file's `ageBandEligibilityIssues` describe block (`apps/web/src/lib/__tests__/registration-rules.test.ts:110`) spreads one fixture, `const division = { age_min: 10, age_max: 15 }` — a null band is never exercised anywhere in the file. The CLAIM the entry makes is still true, but its warrant is the source, not a test: `ageBandEligibilityIssues` returns at `apps/web/src/lib/registration-rules.ts:263` (`if (division.age_min == null && division.age_max == null) return issues;`) BEFORE the cutoff is ever read, which is why a bandless cutoff is inert. Adding a null-band case to that describe block is optional cleanup, not a defect fix.

**Status:** recorded, no fix opened, no defect. Documented so a later wave does not re-open the question of whether a bandless cutoff should be refused and answer it wrongly in either direction — the write is intentional and the state is harmless. Distinct from F12 above, which is about the two cutoff HALVES coming apart and is a real defect.

### F14 (documentation only, OPEN item for W8) — `free_agent_fee_cents`'s card-fee minimum has no coverage on either layer, and no client mirror at all

Found: final whole-branch review gap-hunt. The W7 plan's §0 explicitly asked whether the `free_agent_fee_cents` half of the card-fee minimum "is realistically reachable given `allow_free_agents` also requires `entrant_kind: 'team'` … before deciding whether it's worth a second case or a one-line documentation note". Neither happened in W7 — this entry is that note, recorded so W8 inherits the question rather than losing it.

**The guard exists and is a second, independent call site.** `putRegistrationSettings` (`apps/web/src/server/usecases/registrations.ts:1848-1850`) throws the identical string as the main `fee_cents` check:

```ts
if (method === "stripe" && freeAgentFeeCents !== null && freeAgentFeeCents > 0 && freeAgentFeeCents < 100) {
  throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
}
```

**It sits AHEAD of the Connect gate, unlike the main path.** The `fee_cents` minimum lives inside the `if (method === "stripe")` block at `registrations.ts:1851+`, *after* `!org.charges_enabled` and after `requireFeature(…, "registration.paid")`, which is why W7's card-fee test had to attach a Connect account before it could reach the bound at all. The free-agent check is a standalone `if` above that block, so it fires on an org with no Connect account — a different reachability shape from the one W7 proved, not the same test with a different field.

**It is realistically reachable, not a dead branch.** The preconditions are `entrant_kind: "team"` plus `allow_free_agents: true` (`registrations.ts:1830-1831`, else 422 `allow_free_agents requires entrant_kind 'team'`) plus a non-null `free_agent_fee_cents` (`registrations.ts:1836`, else "a price for something the division does not offer"). All three are ordinary organiser settings on a team division offering solo sign-ups; a sub-1.00 solo price is exactly the mistake the main guard exists to catch.

**Coverage is absent on BOTH layers.**

- Server: `registration-solo-signup-fee.test.ts` covers the field's negative case and a valid 1000, and nothing anywhere in `apps/web/src` or `apps/web/e2e` asserts the 422 for a 1-99 `free_agent_fee_cents`. Every existing assertion on the "Card entry fees must be at least 1.00" string is about `fee_cents`.
- Client: `validateConfigState` (`apps/web/src/components/registration-hub-config-state.ts:213+`) mirrors `CARD_FEE_CENTS_MIN` for `fee_cents` only — there is no `free_agent_fee_cents` branch in it. So a sub-minimum solo sign-up fee reaches the server with no client-side warning at all, where the main fee is blocked before the network call.

**Status:** OPEN for W8, documentation only in W7 — no fix, no new test, no production change. This is a note about a gap, not a defect report: the server guard is correct and does refuse the write. What W8 owes is a decision between (a) one API-layer case in `settings-registration-bounds.spec.ts` pinning the 422 on the no-Connect path, and (b) a client mirror rule in `validateConfigState` plus its unit case, so the two fee fields warn identically. Both are cheap; (b) is a production change and therefore outside a test-only wave.
