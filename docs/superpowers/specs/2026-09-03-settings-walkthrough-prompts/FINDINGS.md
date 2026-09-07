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

**W8 note:** a fix commit naming this finding landed on this branch (`6c8e008bf`, originally `0d16fcf23`). Closure and residuals confirmed at the W8 whole-branch review.

### F2 — `addOns.cap.summaryUnlimited` has no plural rule: "Using 1 organisations"

Found: Task 2, same spec.

`addOns.cap.summaryUnlimited` is `"Using {count} organisations on this bill — your plan sets no limit."` and renders "Using 1 organisations" for a group with exactly one org — the commonest case there is. The sibling `addOns.cap.summary` ("Using {count} of {cap} organisations") reads acceptably at 1, so this is the unlimited-form key specifically. All four locale dictionaries owe the fix (repo i18n rule).

**Status:** open, not fixed this wave. Copy-only, all four dictionaries, no logic change — a good W8 batch item, or earlier if the owner wants small copy fixes to land immediately per ruling 7's precedent.

**W8 note:** a fix commit naming this finding landed on this branch (`0463d1c4e`). Closure and residuals confirmed at the W8 whole-branch review.

### F3 (documentation only, no product impact) — `org-addons.ts` documents a tier that does not exist

Found: Task 2, while deriving expected prices from the catalog.

`lib/org-addons.ts`'s module header, `orgAddonPriceMinor`'s doc comment, and `setExtraOrgs`' doc comment all describe "$9/mo Pro, $19/mo Pro Plus" and argue the two rates are load-bearing ("one flat rate would let Pro + extras undercut Pro Plus"). There is no `pro_plus` plan row today (`plans` holds `community, enterprise, event_pass, event_pass_l, pro`), and `config/stripe-plans.json`'s `org_addons` holds exactly one entry — `pro` at 699 (not 900). No live gap (every member of `PURCHASABLE_PLAN_KEYS` — just `pro` — has a rider), but the comments state a false catalog fact that a later session could build on.

**Status:** open. Comment-only fix, no test needed (nothing asserts the stale comment). Cheap enough to fix inline whenever a session next touches this file; not worth a dedicated task. The same stale claim also appears at `apps/web/src/app/api/billing/extra-orgs/route.ts:13` — both sites move together.

**W8 note:** a fix commit naming this finding landed on this branch (`da29a39a5`). Closure and residuals confirmed at the W8 whole-branch review.

### F4 (documentation only, no product impact, but it is F1's own false premise) — `add-ons-tab.ts` claims no plan grants an unlimited cap

Found: Task 2 reviewer, while confirming F1.

`add-ons-tab.ts:141-142` states "No plan grants unlimited `orgs.max_owned`, so `orgCap === null` means a staff override with a null `int_value`" and uses that to argue the `capReduced` second branch is unreachable. `V393__entitlements_v18.sql:25-26,46-48` falsified this when it added the `enterprise` plan with `orgs.max_owned` unlimited — which is the exact mechanism F1's contradictory copy runs through. The `capReduced` logic itself is still correct (the claim is about reachability, not behavior), so this is documentation-only, but a future session re-deriving F1's cause from this comment would derive it wrong.

**Status:** open, same disposition as F3 — comment-only, fix whenever the file is next touched.

**W8 note:** a fix commit naming this finding landed on this branch (`da29a39a5`). Closure and residuals confirmed at the W8 whole-branch review.

### F5 (real, moderate — PARTIALLY fixed in W8) — a Stripe outage on `/settings/billing` is indistinguishable from "no customer", and silently drops Cancel's own preconditions

Found: Task 3, `settings-billing-panels.spec.ts`.

`server/usecases/billing-manage.ts:318-321` (was `:317-319` as first reported; W8's own log line shifted it) — `getBillingOverview` ended in a bare `catch { return null; }`, with no log and no distinction between "this group has no Stripe customer" and "Stripe just failed" (outage, rate limit, key rotation). **There are in fact THREE `return null` producers in this one function, not two** (found W8 Task 8 review), and a real fix owes each its own meaning: `:250` (`!sub?.stripe_customer_id`) is legitimate and correctly quiet; `:275` (`customer.deleted` — the Stripe customer was deleted out from under us) is anomalous and is STILL silent, recorded here for the first time; `:320` is the fetch-failed case, and is the only one W8 made observable. `settings/billing/page.tsx:434` (`PromoCodeBox`) and the surrounding blocks — `:475` cards, `:494` billing address and tax IDs, `:519` invoices — render only when `overview` is truthy, but `CancelSubscriptionButton` (`:430`) does not read `overview` at all and stays visible.

So during any Stripe failure, a paying customer opening `/o/{slug}/settings/billing` sees a page that says they have no card on file and no invoices, with nothing indicating anything went wrong, while still being offered Cancel subscription. AGENTS.md failure class 6 — an absent symptom that means suppressed, not safe.

**Reproduction:** seed an org with `setOrgSubscriptionSql(orgId, { plan_key: "pro", status: "active", stripe_subscription_id: "sub_e2e_x" })`, leave `stripe_customer_id` null, open `/o/{slug}/settings/billing` as the payer. Observe: Cancel subscription visible, no promo box, no card section, no invoice list, no error message. The null-customer case (never subscribed to Stripe) is legitimate to show this way; the identical rendering for a genuine Stripe failure is the defect.

**Sharper than first reported (Task 3 reviewer; every pin below re-confirmed against the live file in W8 Task 8):** `settings/billing/page.tsx:414` gates `RetryPaymentButton` (rendered `:419`) on `status === "past_due" && overview?.hasOpenInvoice`, so during a Stripe outage a `past_due` payer loses the ability to retry their payment — the one control that could get them out of the state. That one IS outage-caused. **Two corrections to the original wording (W8 Task 8):** (a) the original cited `:425-426` and `:435`; the live gates are `:414` and `:423`. (b) Cancel is not "the only money control left standing" in the `past_due` case this sentence is about — `:429` gates Cancel on `status !== "past_due"`, so that payer gets no Retry, no interval switch and no Cancel. Not literally an empty block, though: `:426-427` renders `ResumeSubscriptionButton` whenever `sub.cancel_at_period_end` is true, and that arm is NOT past_due-gated, so a past_due sub already set to cancel still gets Resume. And the interval switcher's absence at past_due is NOT this bug: `:423` excludes it via its own `status !== "past_due"` clause whether or not Stripe is reachable — only its `overview?.interval` clause is outage-sensitive. `status` and `sub` are read from the DB (`:138`, `:144`), so no Stripe failure can move them. Cancel standing alone is the ACTIVE/TRIALING payer's version of the defect, and it is real: interval switcher, promo box, cards, address and invoices all vanish and the one destructive control remains.

**Status: PARTIALLY fixed, W8** (`13ef5e062`). The outage is no longer silent — `getBillingOverview`'s catch now logs the failure with `{ err, orgId }`, covered by a test pair that also pins the legitimate no-customer return as QUIET. The page-level distinct-error-state half (Cancel staying visible for an active payer, Retry/PromoBox/IntervalSwitcher silently disappearing, no visible indication anything went wrong) is DEFERRED. **Corrected deferral reason (W8 Task 8 review):** the first draft of this line — and `docs/superpowers/plans/2026-09-07-settings-walkthrough-w8.md` before it, in FOUR places (its §0 findings-disposition table row for F5, its Task 8 preamble, the Status template that preamble handed the implementer, and item (f) of its final whole-branch-review checklist — every one now carries a marked retraction) — blamed "three callers" / "three production call sites". That is FALSE. `getBillingOverview` has exactly ONE production caller, `app/o/[orgSlug]/settings/billing/page.tsx:128` (imported `:19`); `pass-credit.ts:18` and `lib/billing.ts:491,543` only NAME it in JSDoc prose and neither imports it, and the only other importer in the tree is a test (`lib/__tests__/billing-payment-method.test.ts:71`). The real cost is not a caller count: a proper fix needs a visible distinct-error UI state on the billing page, four-locale copy for it, a re-gate of `CancelSubscriptionButton` so the destructive control is not the last one standing, and a return type that separates all THREE null producers above (legitimate-quiet `:250`, anomalous-quiet `:275`, fetch-failed-loud `:320`) — not just two. None of that is small. Recommend a dedicated future task, alongside F6/F7.

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

**W8 note:** a fix commit naming this finding landed on this branch (`853148f59`, originally `6e58adbd9`). Closure and residuals confirmed at the W8 whole-branch review.

### F9 (documentation only, assessed NOT exploitable) — `branding` writes are ungated while every read of them is gated

Found: Task 2 and the whole-branch final review, while enumerating `patchCompetition`'s `requireFeature` calls.

`patchCompetition` gates exactly two keys: `discovery.listed` (`usecases/competitions.ts:517`) and `discovery.branding` (`:520`). `PatchCompetition` accepts `branding: z.record(z.string(), z.unknown())` (`api-v1/schemas.ts:133`) and `:582` writes it, so a non-entitled org's scripted `{ branding: { colors: { primary } } }` PATCH is accepted and stored.

Every READ path is gated on `dashboard.theme`, so the stored value is inert. `public_competitions_v` returns `'{}'::jsonb` unless `org_has_feature(org_id, 'dashboard.theme')` (`deltas/V397__dashboard_theme_key.sql:71`), which covers `getPublicOrg`, `getPublicCompetition` and `embed-data.ts`; `/score/[token]/page.tsx:86` is the one place reading `c.branding` off the base table, and it applies it only behind `chrome.themed` (`:100`), itself a `hasFeature(orgId, "dashboard.theme")` call (`server/slideshow-data.ts:106-107`).

**Status:** recorded, no fix opened. Ruled a write-side asymmetry with no rendering consequence — defence-in-depth, not an entitlement bypass: a stored value can only ever take effect once the org is entitled, at which point it is theirs anyway. Recorded so a later wave does not re-derive the question and answer it wrongly in either direction. A `requireFeature` on the write would be optional hardening, not a defect fix.

### F10 (real, low severity) — `invalidateOrgEntitlements` fails open on either request

Found: the final whole-branch review's fix round, while gating W5's own calls to this helper on `REDIS_URL` to close an unrelated shared-user contention finding (Important #1, this wave).

`invalidateOrgEntitlements` (`e2e/helpers.ts`) flips an org's owner to superadmin, makes two `fetch` calls, then flips the owner back — and never checks either fetch's response status. A failed invalidation (a dropped connection, a 5xx) is silent: the caller proceeds believing the cache was cleared when it was not.

**Status:** open, not fixed. Three existing specs already call this helper as written, so a fix belongs to the helper itself, not to any one caller — out of scope for this wave, which only needed to stop calling it where it bought nothing. Recorded so W8 (or whichever wave next touches `helpers.ts`) can add the status checks without re-discovering the gap from scratch.

**W8 note:** a fix commit naming this finding landed on this branch (`df66be70a`, originally `79e098dc1`). Closure and residuals confirmed at the W8 whole-branch review.

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

### F12 (real, low severity — script-only; FIXED in W8) — an explicit `null` on ONE half of the age cutoff is accepted, and stores an orphan half

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

**Status: FIXED in W8** (Task 6, commit `d3ca862bd` — the merge-check plus two rounds of comment fixes; the guard itself landed in `1f8332a17`). Not fixed in W7, and the reasoning for deferring it stands as recorded: pinning the 200 would have frozen a live bug as the suite's expected value (AGENTS.md failure class 4), asserting the 400 it ought to give would have reddened the branch for a defect a test-only wave did not create, and patching production code mid-wave was outside that wave's remit.

The fix is the one this entry predicted: `patchDivision` (`usecases/divisions.ts`) now merges the patch against the stored row inside its own tenant transaction, exactly like the `age_min`/`age_max` block beside it, and throws its own `HttpError(422, AGE_CUTOFF_BOTH_OR_NEITHER)`. Note the STATUS: **422** from the use-case, against the **400** `checkAgeCutoff`'s ZodError still gives for a mismatched pair sent in ONE body. Same sentence, two layers, and the status is what says which one caught the request — `settings-registration-bounds.spec.ts`'s both-or-neither test now asserts both, one helper each (`expectCutoffIssue` / `expectCutoffMergeRefusal`), with the read-back that pins the guard's PLACEMENT (a check that ran after the UPDATE would 422 and still have orphaned the row). The `schemas.ts` comment that carried the false "already backstopped" premise was corrected in the same wave.

**Accepted residual, NOT fixed:** there is still no DB backstop for the both-or-neither half specifically — `divisions_age_cutoff_check` only holds the RANGE, and a one-sided orphan satisfies it (`false OR NULL` is NULL, and a CHECK passes on NULL, as this entry sets out above). So a genuine cross-request race — two concurrent PATCHes each reading the same pre-commit row, one supplying the month and the other nulling the day — could in theory still commit an orphan. Low likelihood and script-only from the product (the config panel always sends both halves), so it was accepted rather than closed. The optional rewrite this entry already names would close it — but **as an ADDITIONAL conjunct, not a replacement**: `num_nulls(age_cutoff_month, age_cutoff_day) <> 1` swapped in ALONE would drop the range enforcement the current CHECK carries and start accepting `month = 99, day = 99`. It has to be `AND`ed with the existing `(month IS NULL AND day IS NULL) OR (month BETWEEN 1 AND 12 AND day BETWEEN 1 AND 31)` clause. W8 Task 6 deliberately skipped it either way, because it is a schema migration and this wave's remit was the application-layer guard. Worth an owner call if the API is ever opened to third-party writers. See also **F19** below, a consequence of the guard for divisions that ALREADY carry an orphan.

### F13 (documented behaviour, not a defect) — an age cutoff with no age band is accepted, and is inert until a band exists

Found: Task 2, `settings-registration-bounds.spec.ts`. The W7 plan predicted this outcome from reading `checkAgeCutoff` and `patchDivision`; recorded here because it was then DRIVEN, which this programme's standing rule requires before a predicted outcome may be committed as an assertion.

**Observed live (sw7, 2026-09-07), not reasoned about.** On a division with `age_min = age_max = null`, `PATCH /api/v1/divisions/{id}` with `{ "age_cutoff_month": 9, "age_cutoff_day": 1 }` answers **200**, and the division GET reads back `age_cutoff_month: 9, age_cutoff_day: 1, age_min: null, age_max: null`. Nothing refuses a cutoff that has no band to anchor — the two are independently nullable by design (`PatchDivision`, `api-v1/schemas.ts`), and `checkAgeCutoff` only relates the cutoff's own two halves to each other.

The stored value is inert while the band is absent: `ageBandEligibilityIssues` (`lib/registration-rules.ts`) returns early on `if (division.age_min == null && division.age_max == null) return issues` before the cutoff is ever read, so such a division reports no eligibility issue and applies no rule. It becomes live the moment a band is added, which is the point of allowing the write.

**Not claimed by the spec, and deliberately so.** `ageBandEligibilityIssues` is not reachable from any read this API-only file performs — it runs inside the organiser-side roster gates (`usecases/registration-eligibility.ts`) and needs a person with a `dob` on a roster. Calling the pure function from the spec against a hand-built person would be a fixture on both ends proving only the fixture, so the test asserts the WRITE and the stored row and says in a comment what it does not cover.

**And that state is NOT covered by an existing unit test either — corrected here.** An earlier draft of this entry claimed the predicate's behaviour for a bandless division "is covered where it belongs, in `lib/__tests__/registration-rules.test.ts`". That is false: every case in that file's `ageBandEligibilityIssues` describe block (`apps/web/src/lib/__tests__/registration-rules.test.ts:110`) spreads one fixture, `const division = { age_min: 10, age_max: 15 }` — a null band is never exercised anywhere in the file. The CLAIM the entry makes is still true, but its warrant is the source, not a test: `ageBandEligibilityIssues` returns at `apps/web/src/lib/registration-rules.ts:263` (`if (division.age_min == null && division.age_max == null) return issues;`) BEFORE the cutoff is ever read, which is why a bandless cutoff is inert. Adding a null-band case to that describe block is optional cleanup, not a defect fix.

**Status:** recorded, no fix opened, no defect. Documented so a later wave does not re-open the question of whether a bandless cutoff should be refused and answer it wrongly in either direction — the write is intentional and the state is harmless. Distinct from F12 above, which is about the two cutoff HALVES coming apart and is a real defect.

### F14 (documentation only in W7; CLOSED in W8 as option (a)) — `free_agent_fee_cents`'s card-fee minimum has no coverage on either layer, and no client mirror at all

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

**Status: CLOSED in W8** (Task 7) — as **option (a)**, the server-side coverage. Documentation only in W7, as recorded: no fix, no new test, no production change there. This was always a note about a gap rather than a defect report — the server guard is correct and does refuse the write — and W8 owed a decision between (a) one API-layer case in `settings-registration-bounds.spec.ts` pinning the 422 on the no-Connect path, and (b) a client mirror rule in `validateConfigState`.

**(a) is done.** `settings-registration-bounds.spec.ts` now carries *"a solo sign-up price below 1.00 is refused ahead of the Connect gate"*, sited immediately ABOVE the `fee_cents` card-fee test because that test is what attaches the shared org's Connect account — the free-agent guard's whole distinguishing property is that it fires WITHOUT one, so it has to run first. It asserts the exact server sentence for 1/50/99, and — the part that makes those rows mean anything — asserts that 100 and 0 fall through to the CONNECT sentence instead, which is what the request does when the guard under test does not fire. Proved by mutation against a running prod build, four mutants, four kills, four DIFFERENT killer assertions: guard disabled (kills the 1/50/99 rows), `> 0` → `>= 0` (kills the 0 row), `< 100` → `< 99` (kills the 99 row), `< 100` → `<= 100` (kills the 100 row).

**(b) is NOT done, and is superseded.** The client-mirror estimate in this entry turned out to be too small: the panel has no render site for the field and cannot even route the refusal it already receives, because the two guards throw an identical sentence. That is recorded separately as **F15** below, which carries the real scope.

## W8

F-numbers continue W7's sequence so every id in this file stays unique.

W8 is the programme's FIX wave, so unlike W4–W7 it both CLOSES entries above and opens new ones. The entries below are what W8's own tasks and reviews found and did NOT fix, each with the reason. A closed entry is recorded in its OWN Status line, not here — read each entry's Status, never this preamble, for whether something is still open.

### F15 (real, low severity, documentation only — NOT fixed) — a `free_agent_fee_cents` 422 renders on the WRONG field

Found: W8 planning research, while scoping F14's option (b).

`ConfigFieldKey` (`apps/web/src/components/registration-hub-save-error.ts`, the union beginning at `:19` and ending on `"allow_free_agents"`) has no `"free_agent_fee_cents"` member, and `MESSAGE_FIELD_PATTERNS` (same file, the table opening at `:84`) carries a single `[/card entry fees must be at least/i, "fee_cents"]` row. That pattern matches BOTH the `fee_cents` guard's and the `free_agent_fee_cents` guard's error string — the two throw an IDENTICAL sentence, `"Card entry fees must be at least 1.00 (or 0 for free)"` — and routes either one unconditionally to `"fee_cents"`. So a real `free_agent_fee_cents` 422 (this wave's own Task 7 proves the server throws it) renders as a field error on `fee_cents`, the WRONG input, rather than on the free-agent fee field, which has no render site to route to anyway.

**Status:** open, not fixed this wave. A real fix needs: adding `"free_agent_fee_cents"` to `ConfigFieldKey` and `ROUTABLE_FIELDS`, a render site in the panel's money section, a `validateConfigState` mirror rule (what F14's own option (b) proposed), and disambiguating `MESSAGE_FIELD_PATTERNS`'s pattern. The client cannot tell the two apart from the message alone, so the fix likely needs the server to throw two distinguishable messages, or the client to infer from which of the two fields is non-null in the outgoing PUT body. Bigger than the "client mirror rule" F14 estimated — recommend a dedicated follow-up task, not an inline fix.

### F16 (real, low severity — NOT fixed) — two more count-boundary strings with no plural rule, the sibling keys F2 did not cover

Found: Task 2's review, immediately after F2's `addOns.cap.summaryUnlimited` fix landed.

F2 split `addOns.cap.summaryUnlimited` into `.one`/`.other`. Its two siblings on the same panel carry the same defect, in states a user reaches:

- **`addOns.cap.summary`, `en`** — `"Using {count} of {cap} organisations on this bill."` A Community group's cap is `1` (`plan_entitlements`: `community` / `orgs.max_owned` / `int_value = 1`, read live), so the ordinary Community rendering is **"Using 1 of 1 organisations on this bill."**
- **`addOns.cap.summary`, `fr`** — `"{count} organisations utilisées sur {cap} pour cette facture."` French agreement runs off `{count}` here, which is the RIGHT number to agree with; what is missing is the plural rule, so `count = 1` renders **"1 organisations utilisées sur 5"** — noun and past participle both plural for one. `es` (`"Usando {count} de {cap} organizaciones…"`) and `nl` (`"{count} van {cap} organisaties…"`) have the same shape.
- **`addOns.extraOrg.floorNote`, all four locales** — `en` reads `"You can't go below {min} — that many organisations in this group are standing on an extra organisation. Move one out of the group first."` At `min = 1` — the smallest and most common floor — it renders "that many organisations … **are** standing", plural for one.

**Status:** open, not fixed this wave. The real fix is the same one F2 shipped: a `.one`/`.other` split for BOTH keys, in all four locale dictionaries, with `gen-keys` regenerated. Deferred rather than folded into Task 2 because it is a second and third key with their own copy decisions per locale (French and Dutch agreement differ from English's), not a mechanical repeat of the fix already reviewed. Low severity: cosmetic, and every affected string still communicates the right number.

### F17 (real, low severity, ops-facing — NOT fixed) — the extra-org reprice alert hands on-call a two-rate diagnosis for a one-rate catalog

Found: Task 3's review, while confirming F3/F4's stale-comment sweep had reached every site.

`sendExtraOrgRepriceFailedAlertEmail` (`apps/web/src/lib/email.ts`) describes the failure in terms of a tier ladder that no longer exists, in TWO places:

- the doc comment (`:1127-1129`): *"that group is billing the WRONG RATE — $9 on a Pro Plus plan (the arbitrage the two rates exist to close) or $19 on Pro (an overcharge)"*;
- the runtime `bodyText` (`:1146-1149`), which is what an on-call engineer actually reads: *"The two rates ($9 Pro / $19 Pro Plus) are load-bearing: left on the Pro price, a Pro Plus group undercuts the tier ladder; left on the Pro Plus price, a Pro group is overcharged."*

The live catalog (`apps/web/src/config/stripe-plans.json`, `org_addons`) holds exactly ONE rider SKU — `extra_org_pro`, `plan_key: "pro"`, `unit_amount: 699`. There is no `pro_plus` tier and no `$19` rate; `$9` is not the Pro rate either. Wrong numbers and a wrong tier count, in the one message whose whole job is to tell someone what to change in the Stripe Dashboard.

Reachable only for `pro`-plan groups: the reprice path early-returns for any plan with no rider SKU, so nothing else can produce this alert. Ops-only, no user-facing surface, no i18n owed.

**Status:** open, not fixed this wave. Both sites need correcting to the single-tier catalog, and the runtime string should be SOURCED from `stripe-plans.json` (via `orgAddonPriceMinor`) rather than restating a literal — restating it is exactly how this claim went stale twice already, which is the same lesson F3's own fix in this wave records. Batched here rather than folded into Task 3 because Task 3's remit was the add-ons *catalog comments*, and this is a runtime string with its own copy decision.

### F18 (real, low severity, test-only — NOT fixed) — the rider's only live-catalog parity check cannot pass

Found: Task 3's review, following F17's thread into the tests that were supposed to catch it.

`apps/web/src/server/usecases/__tests__/extra-org-addon.live.test.ts`'s *"resolves BOTH live rider rates from the catalog, and Pro Plus is the dearer one"* (`:280`) asserts a two-tier catalog that no longer exists. Three separate assertions fail against the live seed, not one:

- `:285` — `expect(ORG_ADDONS.map((e) => e.planKey).sort()).toEqual(["pro", "pro_plus"])`. `ORG_ADDONS` is built from the seed's `org_addons` array (`lib/org-addons.ts:51`), which holds one entry, so this reads `["pro"]`.
- `:345` — `expect(rates.pro).toBe(900)`. The real rate is `699`.
- `:346` — `expect(rates.pro_plus).toBe(1_900)`, and `:347`'s `toBeGreaterThan`. `pro_plus` is never populated by the `for (const entry of ORG_ADDONS)` loop above, so the key is `undefined`.

The test's TITLE is stale in the same direction — there is no "BOTH" and no Pro Plus to be dearer than anything.

It is gated `describe.skipIf(!LIVE)` behind `BILLING_LIVE=1` (plus a test-mode key and a `*_test` database), so it never runs in normal CI and nothing is red today. That is the finding: this is the repo's ONLY live-catalog parity check for the rider — the one test that pins `orgAddonPriceMinor`'s seed against what the Stripe account actually holds — and the guarantee is currently unheld, silently.

**Status:** open, not fixed this wave. The repair is modelled two lines above the defect: `:326` and `:339` already derive their expectation from `orgAddonPriceMinor(entry.planKey, currency)` instead of a literal. The fix is to make the flat-rate assertion do the same, drop the `pro_plus` assertions and the ladder inequality entirely (a one-tier catalog has no ladder to arbitrage), correct `:285` to the seed's own membership, and retitle. Cheap, but it needs `BILLING_LIVE=1` against the shared Stripe test account to verify — which is why it is a task of its own rather than a fold-in.

### F19 (real, low severity, script-reachable only — NOT fixed) — a division that already carries an orphaned cutoff half can no longer be saved from the hub at all

Found: Task 6's review, assessing the blast radius of the F12 fix that same task shipped.

A division with exactly one cutoff half set — `age_cutoff_month = 9, age_cutoff_day = null`, say — is the state F12 describes and F12's fix now prevents being CREATED. Rows already in that state (only reachable via a direct script or DB write; the registration hub UI has never sent a one-sided body) become unsaveable from the hub:

- `toDivisionPatchBody` (`registration-hub-config-state.ts:119-124`) returns all six eligibility keys on EVERY save, unconditionally. So the PATCH body always carries both `age_cutoff_month` and `age_cutoff_day`, with whatever the GET loaded into state — for an orphan row, that is `{ age_cutoff_month: 9, age_cutoff_day: null }`.
- `checkAgeCutoff` (`api-v1/schemas.ts`) reads that body and fires: `(9 != null) !== (null != null)` is `true !== false`. The refusal is the pre-existing **400/VALIDATION** ZodError at path `age_cutoff_day`, live since RS007/V380 and untouched by this wave — not the 422 F12's merge-check added. So the organiser is refused no matter which field they actually meant to change: a name edit, a capacity edit, anything.
- It is worse when the division also has no age band. `hasAgeBand` (`registration-hub-config-panel.tsx:614`, `state.age_min != null || state.age_max != null`) gates the two cutoff `<select>`s `disabled` (`:699`, `:726`), so the organiser is shown a field error on a control they cannot touch, with no way to complete or clear the pair from the panel.

**Status:** open, not fixed this wave. It is a pre-existing-data problem the F12 fix makes visible rather than a defect the fix introduced — no new orphan can be created now, and the hub could never create one before. Two candidate repairs, and the choice is an owner call rather than an implementer's: (a) a one-off repair script nulling the surviving half of any existing orphan row (a data migration — needs a count of live rows first, which on this database is expected to be zero), or (b) a hub-side fallback in `toDivisionPatchBody` that OMITS an untouched cutoff half instead of always sending both, so an unrelated edit passes through. (b) is the more general fix and the riskier one — omission is how a partial patch loses an intended clear, which is the shape F12 itself was about — so it should not be taken without deciding what "untouched" means for a control the panel has disabled.

### F20 (real, low severity, coverage gap — NOT fixed) — the free-agent fee guard's `method === "stripe"` conjunct has no test witness

Found: Task 7's review, reading the mutation sweep that same task ran and noticing which half of the guard it could not reach.

Task 7 mutation-proved the free-agent card-fee guard (`apps/web/src/server/usecases/registrations.ts:1848`) with four kills — but all four move the NUMERIC half of the condition (`> 0`, `< 100`, and the guard as a whole). The `method === "stripe"` conjunct is untested on its own:

```ts
if (method === "stripe" && freeAgentFeeCents !== null && freeAgentFeeCents > 0 && freeAgentFeeCents < 100) {
```

Delete that conjunct alone and the guard starts refusing an **offline** division that charges a solo entrant between 0.01 and 0.99 — a legal setting for cash or bank transfer, where Stripe's minimum charge has no bearing. Nothing in the suite reds:

- Task 7's own e2e case only ever sends `payment_method: "stripe"` (the guard's other half is exactly what it exists to reach), so it cannot see this.
- `registration-solo-signup-fee.test.ts` is the offline fixture — its one seed helper hardcodes `payment_method: "offline"` (`:55`) — but every value it passes for the fee is legal or absent: `1000` (`:110`, `:120`, `:214`), `0` (`:140`), `null` (`:130`, `:237`, `:265`), and `-1` (`:166`, which the negative-value guard above catches first). A 1-99 offline value appears nowhere.
- Swept by behaviour, not filename: every `free_agent_fee_cents` literal across `apps/web/src` and `apps/web/e2e` is `null`, `0`, `500` (client state only, never reaching this usecase), `1000` or `-1`.

**Status:** open, not fixed this wave. This is a coverage gap, not a defect — the conjunct is correct and does what it should. The fix is one more row: an offline division sending `free_agent_fee_cents` in 1-99 and expecting acceptance, either as a fifth mutation case in the e2e file or (cheaper, and where the offline fixture already lives) an added case in `registration-solo-signup-fee.test.ts`. Recommended as a future task's pickup rather than an inline fold-in, because the e2e file's shared org has Connect attached by the time its last test runs and an offline case has to be sited with that in mind. The general lesson is AGENTS.md failure class 3 applied per-CONJUNCT: a four-mutant sweep of one operand does not test the operand beside it.

### F21 (real, low/medium severity, coverage gap — NOT fixed) — four entitlement gates that nothing in the repo tests, proved live by mutation

Found: Task 9's mutation sweep, which had to re-derive the provers the W8 plan's §0 table listed as unknown.

Four of the nine `requireFeature` gates the sweep covered have **no test anywhere — vitest, e2e or script — that reddens when the gate stops throwing**. Each was mutated to `await requireFeature(…).catch(() => undefined)` and the mutant run against every suite that touches the code path; in all four cases the only failing row was a disposable scratch spec written for the sweep and deleted afterwards:

- **`apps/web/src/server/usecases/competitions.ts:312`** — `discovery.listed` on `createCompetition`. Mutant run: 36 tests across `discovery.test.ts` + `public-dashboard-quota.test.ts` + scratch, 35 passed, only the scratch row red. The PATCH copy of this same gate (`:517`) IS proven, by `settings-competition-gates.spec.ts`; the create copy is not, even though its own source comment says showcase-at-create "follows the exact PATCH rules".
- **`apps/web/src/server/usecases/divisions.ts:647`** — `formats.advanced` on `patchDivision({auto_progress:true})`. Mutant run: 117 tests across the seven suites that call `patchDivision` + scratch, 116 passed, only scratch red. The one test that reaches this line, `format-ext.test.ts:243`, runs on a **pro** org (its `seedOrg()` defaults to `"pro"`), so the gate passes and its deletion is invisible.
- **`apps/web/src/server/usecases/divisions.ts:653`** — `news.auto` on `patchDivision({auto_posts:true})`. Mutant run: 141 tests across ten suites + scratch, 140 passed, only scratch red. `auto_posts` reaches `patchDivision` from exactly one place in the whole tree, `e2e/news.spec.ts:38`, which expects **200** on the shared Pro org; every other `auto_posts` is a direct SQL write or a `false` fixture.
- **`apps/web/src/server/usecases/registrations.ts:1804`** — `registration.enabled` on `putRegistrationSettings`. Mutant run: 300 tests across the four suites that write an `org_entitlement_overrides` deny for a registration key + scratch, 299 passed, only scratch red. `registration.enabled` is TRUE on every plan in the live matrix, so only a staff deny can reach the refusal — and no test in the repo writes one for this key.

**Not a defect: all four gates work.** The scratch spec drives each usecase directly against an org that genuinely lacks the key and asserts `{status: 402, featureKey}`; it is **5/5 green against the clean tree** (the fifth row covers `registrations.ts:1858`, which turned out to have a real prover). What is missing is the test, not the enforcement — which is exactly the state AGENTS.md failure class 3 exists to name: a guard nothing kills is not tested, and the next refactor of any of these four lines has no witness.

Severity is low/medium rather than low because two of the four sit on the paid-feature boundary of a WRITE path an organiser reaches (`auto_progress`, `auto_posts` on a division; the showcase opt-in at competition create), and because `discovery.listed` and `registration.enabled` are true on every plan today — so the only thing these two gates can ever enforce is a **staff deny**, i.e. the abuse/chargeback lever, which is precisely the case that must not silently stop working.

**Status:** open, not fixed this wave. Task 9's remit was to run the sweep and record what it found, and writing four new committed tests is a build task with its own review, not a fold-in to a sweep. The repair is small and the shape is already written: the deleted scratch spec (`src/server/usecases/__tests__/__scratch-w8t9-gates.test.ts`, reconstructable from this entry and from the sweep record in `_INDEX.md`'s "W8 Task 9" section) is four `it` blocks against a real Postgres, mirroring the seeding in `registrations-intake-gate.test.ts`. Recommend committing it as `entitlement-gate-coverage.test.ts` in a follow-up, with the two `patchDivision` cases seeded on a community org and the two override cases writing an `org_entitlement_overrides` deny plus `invalidateOrgEntitlements`. A per-gate e2e is NOT recommended for these four: the walkthrough matrix already pays for two prod builds per mutant and the usecase layer is where the guards live.

**A second, smaller finding recorded inside this one, because it is about the register rather than the product.** The W8 plan's §0 table cited a prover for gates 1, 2, 3, 8 and 9. Two of those five citations are wrong — `settings-registration-bounds.spec.ts` does NOT prove `registration.paid` (its card-fee rows assert the CONNECT_REQUIRED sentence, which fires one line ABOVE that gate), and `settings-sponsor-monetize.spec.ts` does NOT prove `sponsors.monetize` (its only touch sets the override to `true` on a Pro org, a no-op its own header comment already flags). Both corrections are recorded in `_INDEX.md`'s W8 Task 9 section. The generalisable half: **a "proven by" column in a plan is a hypothesis until a mutant has actually reddened that spec**, and a gate whose cited prover asserts a DIFFERENT refusal from the same endpoint is the easiest kind to mis-credit.
