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
