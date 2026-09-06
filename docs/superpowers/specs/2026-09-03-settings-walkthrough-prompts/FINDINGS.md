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
