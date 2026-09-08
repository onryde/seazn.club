# Entitlements v18 — W4 outcomes

Written 2026-09-08 at the W4 boundary. Branch `docs/entitlements-w4-handoff`,
16 commits `fb99bbd4c..c8e3928b8`. Final whole-branch review: **SAFE TO MERGE**.

The per-task reports, reviews and ledger live in a **gitignored** workspace
(`.superpowers/sdd/2026-09-07-entitlements-v18-w4/`) and will not survive. This
file is the durable record. Design: `2026-09-07-entitlements-v18-w4-design.md`.
Plan: `../plans/2026-09-07-entitlements-v18-w4.md`.

## What shipped

| lane | change | fix rounds |
|---|---|---|
| N4 | device-link cross-fixture refusals are now metered on their own key | 0 |
| N5 | nine anonymous e2e contexts seed consent instead of racing the banner | 1 |
| N2 | `event-pass.spec.ts` moved to `e2e/walkthrough/`, pinned serial, JSON reporter added, CI step fails the leg if the money tests skip | 0 |
| N0 | three distribution captures wired; auto-draft capture moved out of the scoring transaction | 1 |
| N1 | `enterprise-gate.spec.ts`, 13 tests, every cap read from the live matrix | 2 |
| N3 | division rail classified; regression gate added; **no product change** | 0 |

## Nine premises that did not survive contact with the tree

Recorded because each was believed by a brief, a design, or an index — and
because rule 5 keeps being right.

1. `api.write` is not the only `ENTERPRISE_FEATURES` bool; `dashboard.branding`
   joined it in V396.
2. The division rail has no accessibility defect — it is already in the axe
   sweep at all seven widths and green, because `scrollable-region-focusable`
   passes when the region contains focusable elements, and it is a `<nav>` of
   links.
3. `event-pass.spec.ts` seeds its own orgs, so N1 needed no `SERIAL_SPECS` split.
4. No JSON reporter existed, so N2's stated acceptance was unexecutable until
   one was added.
5. The `e2e.yml:489-492` "skip loudly" warning covers Connect, not the pass.
6. The cookie-banner fix lives in `scorepad-a11y-kit.ts`, not `device-links.spec.ts`.
7. Item 0 was never a query task — three of its four quantities had never been
   instrumented, so its baseline could not have been taken at any point.
8. The local `rk_test_` key CAN create a Checkout Session. The money tests are
   unrunnable locally for other reasons (`stripe:sync`, plus a full
   server/DB/browser run), not that one.
9. **`officials.auto` competition-scoping already had a browser test.** The W4
   design claimed it did not and made it a case on that basis.
   `apps/web/e2e/pass-scope-officials.spec.ts` drives two competitions over real
   HTTP in both directions against the real `competitionForDivision` resolver;
   it merged the day before the design was written.

## Four vacuous proofs caught

All four had green suites behind them. Three were caught by review, one by the
final sweep.

1. **N5's positive check could not fail.** `expectNoCookieBanner` passed under
   its own inversion: `openDeviceLink` clicks Accept itself, and under throttle
   the SSR scorebug beats the hydration-gated banner. Replaced with a
   deterministic read of the seeded `CONSENT_KEY`/`CONSENT_VERSION_KEY`; kept
   only in `scorepad-v3-cricket.spec.ts`, where it was proven to red.
2. **N0's idempotency guard was verified through the one route that cannot
   reach it.** `POST_AUTO_DRAFTED` was driven only via the weekly digest, which
   is exempt from `org_posts_auto_once`. Now driven through `refreshNews` on a
   repeated fixture, proving both directions.
3. **N1's absence assertion had no anchor.** `toHaveCount(0)` on `#upgrade`
   passes identically on a 404 — `page.goto` does not throw on non-2xx and
   `requireBillingPage` has a silent `notFound()`. Anchored on
   `[data-tour="billing-plan"]`, itself proven by a mutant that navigates to a
   nonexistent slug.
4. **N0's scan guard proves text, not reachability.** `EMBED_RENDERED` and
   `PUBLIC_PROFILE_VIEWED` are asserted by source-text containment only —
   weaker than the execution test the third capture received. Not a live bug;
   both call sites are correct today. Owed: an execution-level test.

## Product findings — not test problems

- **The local server recipe posts analytics to the LIVE PostHog project.**
  `captureServer` reads `POSTHOG_KEY ?? NEXT_PUBLIC_POSTHOG_KEY`, and
  `.env.local` carries a real key that the standard launch recipe sources.
  Three real events reached production during W4 verification before it was
  caught. Repo-wide, not W4-specific: any local or e2e run touching a capture
  path does this. Blank BOTH vars in the command that starts the server.
- **`dashboard.branding` is a tier claim nothing enforces.** It sits in
  `ENTERPRISE_FEATURES` with no consumer anywhere — no gate, no `data-feature`,
  no `requireFeature`, no Contact-us CTA. The brand-colour gate moved to
  `dashboard.theme` in V397. Inert and low-risk, but it will read as real to
  whoever next prices against that list.
- **The `.scroll-x-fade` right-edge fade is structurally dead.**
  `globals.css:397-406` puts `::after { position: absolute; right: 0 }` on the
  same element that scrolls, so `right: 0` resolves against CONTENT width: the
  fade rides the scrolled content and is only visible once there is nothing
  left to scroll to. Confirmed in a browser at 320. **18 other call sites share
  the class**, including `constraints-panel.tsx:1042`; none audited.
- **Landing on a later tab shows no active tab.** Opening `?tab=settings`
  directly leaves `scrollLeft` at 0 while the active tab sits at x470-557,
  outside the rail's visible 16-304 — three visible tabs, none marked current.
  `page.tsx` is a server component with no `scrollIntoView`.

## Rulings taken during execution

- **N5:** replaced the brief-mandated `expectNoCookieBanner` with a seeded-state
  read in the two `openDeviceLink` files. Reviewer independently judged it
  sound and stronger than the brief. Cost if wrong: a "banner renders despite
  correct consent" regression is uncaught in those two files; that shape stays
  covered in cricket and `scorepad-a11y-evidence.spec.ts:146`.
- **N2:** the Step 10 finding — mutants 1-3 prove production functions, not the
  e2e assertions themselves — cannot be fixed by code. Parked against Step 11
  and the plan amended so Step 11 owes a pushed mutant that REDS U16, not just
  a non-skipped run.
- **N3:** rule 23's `tabindex` half is recorded as a tension rather than obeyed
  or dropped. The accessible-name half is owed regardless. **Owner decides.**
- Dispatches carried no `model` override, per `RULES.md`, over the SDD skill's
  contrary instruction.

## Owed, in priority order

1. **The money path has still never executed.** N2's code is done and nothing
   about it is proven. Owner-gated: push the branch, `gh workflow run E2E --ref
   docs/entitlements-w4-handoff`, confirm U1 and U16 report as RUN — then a
   second run with refund revocation broken, confirming U16 REDS. Live Stripe,
   shared test account.
2. **Owner ruling on the rail's `tabindex`**, then options for the two rail
   defects above (recommended: a `mask-image` gradient rather than a wrapper,
   because 18 unaudited call sites make DOM changes the expensive option; and
   scroll-active-into-view for the missing indicator).
3. An execution-level test for the two scan-only captures.
4. W5: item 3 (auth-before-parse across ~20 handlers — a rule decision, not a
   patch), item 7 (org-addon rider reconciliation, deadline "before a live
   Stripe catalogue exists"), items 1 and 2 (pins never re-verified), and the
   realtime-token route's missing refusal meter
   (`api/v1/public/fixtures/[id]/realtime-token/route.ts:36-42`).
