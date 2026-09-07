/**
 * What plan the VIEWER's organization already holds, as a paywall needs to
 * know it (entitlements v18 W3-B).
 *
 * `featurePlan(featureKey)` in feature-copy.ts answers a different question —
 * which tier grants a key — and it is a pure function of the KEY. It therefore
 * cannot tell "you need Pro" from "you have Pro": a Community org at 64
 * entrants and a Pro org at 256 hit the SAME feature key and need opposite
 * answers. That distinction has to arrive from outside the component.
 *
 * Deliberately COARSER than `plan_key`. A paywall's only question is "is the
 * plan I would sell you the plan you hold", and answering it needs three
 * classes, not the plan catalogue. Keeping the vocabulary small also keeps
 * plan keys out of the client bundle, which is the same reason
 * CompetitionPassProvider carries `paidPlan` as a boolean rather than a key.
 *
 * `unknown` is a real answer, not a missing one — but it currently has NO
 * production caller, and that finding is worth more than the value itself.
 *
 * It was introduced for app/directory, app/clubs/[id] and app/import, on the
 * premise that those routes render a paywall with no organization in server
 * scope. The premise was false: all three call `requirePageAuth()`, which
 * always resolves an `auth.orgId` — app/directory was already passing it to
 * `hasFeature()` a few lines from the gate. All three now resolve the real
 * plan. The premise came from a survey that answered "is this route under
 * app/o/[orgSlug]", which is a different question, and it survived into a
 * dispatch brief as though it were the answer to this one.
 *
 * Kept in the union because a route genuinely outside auth could arrive, and
 * because the honest value has to exist before it is needed. It degrades to
 * the behaviour that shipped before this prop (offer the plan) — the safe
 * direction: it can leave an upsell in front of a paying org, never withdraw
 * one from an org that needs it. `viewer-plan-coverage.test.ts` asserts the
 * production count is zero, so re-introducing one is a deliberate act.
 */
export type ViewerPlan = "community" | "pro" | "enterprise" | "unknown";

/**
 * Fold a resolved `plan_key` into the three classes a paywall reasons about.
 *
 * Takes the RESOLVED key — `lib/entitlements.ts`'s `orgPlanKey()`, degradations
 * and all — never a raw `subscriptions.plan_key`. A lapsed trial, an expired
 * staff comp and exhausted dunning all resolve to community at read time, and
 * such an org must be sold Pro: reading the raw row would classify it as paying
 * and withdraw the upsell it actually needs.
 *
 * Everything that is not community and not a name we know is `enterprise`
 * rather than `unknown`, and the direction is deliberate. Both suppress the
 * priced CTA — `enterprise` because nothing above it is self-serve, `unknown`
 * because we do not know — but only `unknown` claims ignorance, and a plan key
 * we can see is not ignorance. A plan added to the catalogue without a line
 * here is therefore treated as the top tier, which withholds a sale until
 * someone looks, rather than quoting Pro to an org that may already exceed it.
 */
export function viewerPlanFrom(planKey: string): ViewerPlan {
  if (planKey === "community") return "community";
  if (planKey === "pro") return "pro";
  return "enterprise";
}

/**
 * Does the viewer already hold the plan a paywall would otherwise sell them?
 *
 * Two independent signals, OR'd, and both are server-resolved:
 *
 *  - `viewerPlan`, the org's own resolved plan, which reaches the gate as a
 *    required prop and is the only signal available OUTSIDE a competition.
 *  - `passGateState === "paid_plan"`, resolved by the competition layout.
 *    `usePassGateState` puts that arm ahead of every other one ("a paid plan
 *    beats everything"), so inside a competition it is already authoritative.
 *
 * OR rather than a precedence order because the two cannot legitimately
 * disagree — both derive from `orgPlanKey()` — so a disagreement is a wiring
 * fault, and OR fails it towards "do not sell them what they have". The
 * alternative fails towards charging a paying customer twice.
 *
 * `unknown` contributes nothing on its own and falls through to the pass
 * signal, so a competition-scoped gate on a route with no org in server scope
 * still gets the right answer rather than none.
 */
export function planAlreadyHeld(viewerPlan: ViewerPlan, passGateState: string): boolean {
  return passGateState === "paid_plan" || viewerPlan === "pro" || viewerPlan === "enterprise";
}
