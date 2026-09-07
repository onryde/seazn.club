# Entitlements v18 — W4 brief: what W3 leaves owed

Written at the W3 boundary, 2026-09-07, after W3 merged as `4d00ad9de` (PR #741).

Read this WITH `_INDEX.md` § "Named items owed to a later wave", not instead of
it. That section was written at the W1/W2 boundary and **four of its eleven
items have since closed**. Part 1 below corrects it. Part 2 is the new work.

Everything in Part 1 was re-verified against `origin/main` on 2026-09-07, by
running the tests and opening the files — not by grep alone. Where something
was NOT re-verified, it says so. Re-pin every line number before building on
it: this repo's line pins go stale within a wave.

---

## Part 1 — corrections to the standing owed list

### Now CLOSED. Do not re-open, do not re-do.

**Item 8 — `scripts/smoke.ts` seeds `pro_plus` at eight sites.** Closed.
Eight `pro_plus` occurrences remain in that file and **all eight are
comments** recording the V393 change (`:2178`, `:3688`, `:3976`, `:12128`,
`:12432`, `:12599`, `:12814`, `:12936`). No seed writes survive. The runtime
`subscriptions_plan_key_fkey` violation the item predicted cannot occur.

**Item 9 — the `event_pass_l` description claims an unlimited entrant cap.**
Closed. `plan-copy-truth.test.ts` passes. The collect failure that hid it is
repaired and the suite registers its tests.

**Item 10 — five pass features a pass holder cannot reach.** Closed, and
closed the RIGHT way, which is worth stating because the item explicitly
warned it could be closed the wrong way.

Both guards pass:

```
src/lib/__tests__/pass-scoping-guard.test.ts              PASS
src/components/__tests__/upgrade-gate-pass-features.test.ts  PASS
src/lib/__tests__/plan-copy-truth.test.ts                 PASS
33 total / 33 passed / 0 failed
```

The guard was **not weakened**: `pass-scoping-guard.test.ts` has one commit in
its whole history (`f856d118b`, #202), so nothing edited it after the item was
written. The competition ids were genuinely threaded at the named sites —
`match-reports.ts:291`, `player-stats.ts:371/374/402/405/435/715`,
`stages.ts:303`, `templates.ts:174` all now pass a competition id as the third
argument. Verified by opening the files, not by the green.

**Item 6, first half — `pricing-v18.spec.ts`.** Built in W3 and executed for
the first time (14/14, and its first run found five real contrast failures).
The second half is still owed — see N1.

### Still OPEN, with corrected pins

**Item 3 — the events route parses the body before authenticating.** Still
open, unchanged. `apps/web/src/app/api/v1/fixtures/[id]/events/route.ts:14-15`:
`parseBody(req, AppendEventRequest)` on 14, `requireFixtureActor(req, id,
"score")` on 15. The item's framing still holds — this is a repo-wide ordering
pattern across ~20 handlers, so **the job is deciding the rule, not patching
this route**. Do not fix one route and call it done.

**Item 4 — cross-fixture device-link 403s are unmetered.** Still open. **The
index gives the wrong path.** It says `auth.ts`; the file is
`apps/web/src/server/api-v1/auth.ts`, and the single `rateLimit(` call in it is
at `:260`. The ownership throw still precedes it.

**Item 5 — nine anonymous e2e contexts share the cookie-banner race.** Still
open, and the counts still match exactly: `scorepad-offline.spec.ts` 4,
`scorepad-v3-partial-amend.spec.ts` 4, `scorepad-v3-cricket.spec.ts` 1.

**Item 7 — an unrecognised org-addon rider is a silent billing path.** Still
open. `scripts/stripe-sync.ts` contains no prune, orphan or reconciliation
logic of any kind. `isOrgAddonItem` is still at `lib/org-addons.ts:80`.
The item's own deadline stands: **close it before a live Stripe catalogue
exists.**

**Items 0, 1 and 2 — NOT re-verified this session.** The distribution
baseline (0), the setbased kernel's unreachable event schemas (1), and the
relocated unguarded `padSpec` throw (2) were not checked. Treat their pins as
stale and re-verify before acting.

---

## Part 2 — new, from W3

### N1 · `enterprise-gate.spec.ts` does not exist

The file was never written. W2 deleted `pro-plus-tier.spec.ts` (505 lines,
10 tests) and `pricing-pro-plus.spec.ts` (49 lines, 2 tests) against a promise
of two replacements; W3 delivered `pricing-v18.spec.ts` and did not deliver
this one.

`_INDEX.md` item 6 already contains the full inventory of what the tree no
longer proves in a browser. **Take the cases from there, not from this
paragraph** — it lists the numbers that moved in V393 and which vehicle each
case now needs.

The three that belong specifically in this file:

- `api.write` is the ONLY bool in `ENTERPRISE_FEATURES` — the sole
  self-serve-unreachable feature in the product. Prove a read-only API key
  still mints when the write scope is refused.
- `officials.auto` is now granted on Pro AND on both pass rungs, so W2 T6's
  competition-scoped resolution is what makes the pass grant safe. **That
  scoping has no browser test.**
- `/admin/entitlements` renders a column per plan. `ADMIN_PLAN_KEYS` derives
  from `ALL_PLAN_KEYS` unfiltered, so assert the column SET matches that list
  — including `enterprise`, the one column `/pricing` deliberately omits.

Read every cap from the live matrix. Do not retype a number into the test —
the deleted spec hardcoded 2 and 5 and that is why V393 moved underneath it
silently.

*Acceptance:* the spec runs in a project CI actually executes (see N2 — check
`playwright.config.ts` project membership before assuming), each case fails
when its guard is mutated, and the run is judged from
`--reporter=json --outputFile`.

*Do not touch:* `pricing-v18.spec.ts`, the matrix-derived guards in Part 1.

---

### N2 · the Event Pass money path has never executed anywhere

**This is the highest-value item in this brief.** It is the one flow that
takes money, and no gate in the repo runs it — not locally, not in CI, and
not in the 8/8 green that authorised W3's merge.

Verified 2026-09-07:

- `event-pass.spec.ts` resolves to the **`parallel`** project. Confirmed by
  `npx playwright test --list e2e/event-pass.spec.ts` → `[parallel]`,
  21 tests. It is NOT in `SERIAL_SPECS` (grep count 0) and NOT under
  `e2e/walkthrough/`, which is what `WALKTHROUGH` matches
  (`playwright.config.ts:119` — `/[\\/]e2e[\\/]walkthrough[\\/]/`).
- `e2e.yml:289` hands the real `secrets.STRIPE_SECRET_KEY` to **`walkthrough`
  only**; every other project gets the literal `sk_test_ci_e2e_dummy`.
  Lines `:658` and `:948` hardcode the dummy for the remaining jobs.
- So `parallel` runs with a dummy key, checkout 503s on unsynced prices, and
  the money tests skip. `e2e.yml:279`'s own comment says exactly this.
- Locally the server boots from `apps/web/.env.local`, whose
  `STRIPE_SECRET_KEY` is an **`rk_test_` restricted key**. It cannot create a
  Checkout Session, so `/api/billing/pass-checkout` 5xxs and the same tests
  skip for a different reason.

The tests that have never run: `U1` (buys the pass from the gate that bit and
the gate lifts), `U6` (division 11 hits a Pro-only ceiling and the pass is
never re-sold), `U12` (billing page names the purchase and links its invoice),
`U14` (upgrading to Pro credits the pass and leaves it dormant), `U15` (a Pro
org that downgrades keeps the pass on its competition), `U16` (a full refund
revokes the pass and the offer comes back). Each is parameterised by viewport.
**W3 changed an assertion in this file** (`event-pass.spec.ts:678`) and could
not observe the result.

**This is an environment decision, not a code change.** Two routes:

1. Move `event-pass.spec.ts` into a project that receives the real key —
   which today means `e2e/walkthrough/`, and means accepting walkthrough's
   serial cost. Note `e2e.yml:490` already warns when the walkthrough money
   path is skipped for a missing secret; extend that warning to cover this.
2. Give `parallel` the real key. Cheaper to write, wider blast radius —
   every parallel spec then talks to a live Stripe test account.

Recommend (1): it keeps live-Stripe traffic in one project, and the warning
scaffolding is already there.

*Acceptance:* a CI run in which at least U1 and U16 REPORT AS RUN, not
skipped. A green that skips them is the failure this item names — check the
skip count, not the pass count.

*Do not touch:* the `rk_test_` key in `.env.local` (it is restricted on
purpose), and do not run `stripe:sync` without the owner's approval — it
writes to a shared Stripe test account.

---

### N3 · the division tab rail at 320 — UNPINNED, reproduce before fixing

Observed during W3's phone verification and **never pinned to a file**. It is
recorded here so it is not lost, explicitly labelled as an observation rather
than a diagnosis.

I could not locate the owning component with confidence this session. A search
for the division page's tab nav returned `division-settings.tsx`,
`launch-actions.tsx` and `officials-panel.tsx` — none obviously the rail. **Do
not build on those three names.**

*How to start:* drive the product, do not grep. Open a division page at 320px
in a browser, put the tab rail in view, and write down what you SEE — whether
the tabs clip, scroll, or wrap, and whether the overflow is reachable. Only
then find the component.

The distinction that decides whether this is a defect at all: **a scrolling
rail is not clipped content.** An overflow whose extra content is reachable
(`overflow-x: auto`/`scroll`) is a feature; one inside an `overflow-hidden`
box is a defect. `mobile.spec.ts`'s `overflowingIn` /
`expectScorebugNotClipped` already split on computed `overflow-x` and are the
model. If the fix makes it a scrolling region, it owes an unconditional
`tabindex="0"` plus a role and an accessible name, or axe reds at SERIOUS on
`scrollable-region-focusable` — and `tabindex` cannot be varied by media
query.

*Acceptance:* a per-screen verdict at 320 with a screenshot, plus the seven
width projects in `mobile.spec.ts` green. Not "no horizontal scroll" — that
gate cannot see layout.

---

## Standing gates for whoever runs W4

- `.github/workflows/e2e.yml` triggers on **push to `main` only**. A feature
  branch gets zero automatic e2e, ever, until it merges. Re-read the file;
  this trigger has changed three times.
- Pre-merge e2e on a branch: `gh workflow run E2E --ref <branch>`.
  `github.sha` resolves to the dispatched ref, so no workflow edit is needed.
  This is how W3 got its 8/8.
- Smoke is **PR-only**. The two triggers are disjoint and neither substitutes
  for the other.
- Judge vitest from `--reporter=json --outputFile`, reading
  `numPassedTests`/`numTotalTests`. A suite that fails to COLLECT reports
  0 tests and 0 failures — it looks clean.
- Run the matrix-derived and source-scanning guards explicitly after ANY
  `plan_entitlements` change. They go red with no application diff to point
  at, and file-based test selection never reaches them.
