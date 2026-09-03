# Settings walkthroughs — design of record

**Date:** 2026-09-03
**Status:** owner-approved (brainstorm, this session). Plan not yet written.
**Scope:** every settings surface in the product, driven by hand.

---

## 1. Why

Settings is the largest un-walked surface in the product. A scout sweep of
`apps/web/e2e/**` by behaviour (route navigations and control testids, not
filenames) found **~105 controls across five surface families** and only
**seven tests that actually change a value and assert it persisted**. Two
whole families — competition settings and `/admin/settings` — have **zero**
coverage of any kind.

The gap is not cosmetic. Settings is where the product's gating lives: nearly
every control is guarded by a role check, an entitlement check, or both, and
those guards are expressed in the client as `disabled` props. `apps/web`
vitest is `environment: "node"` and cannot see a rendered button's enabled
state at all. So the one class of defect this surface is most prone to — a
control the UI disables and the API happily accepts, or the reverse — is
invisible to every test we currently run.

One instance is already confirmed, by reading both files:

> `/admin/settings` gates the page on `requireStaff()` and the write on
> `requireSuperadmin()`. `admin-platform-settings.tsx`'s only `disabled` is
> `busy || !valid` — it knows nothing about superadmin. A staff user who is
> not a superadmin is shown an **enabled Save button that always 403s**. The
> page's own comment states the split; nothing reconciles the two.

## 2. Inventory

| Surface | Controls | Existing e2e |
|---|---|---|
| `/o/{org}/settings` — 7 tabs: organization, news, sponsors, team, api, preferences, account | ~45 | 7 change+persist, rest load-only |
| `/o/{org}/settings/{billing,connect,credits,add-ons}` | ~20 | billing suites heavy; connect/credits/add-ons thin |
| `/o/{org}/c/{comp}/settings` | 13 | **zero** |
| Division `schedule?tab=settings` + `?tab=constraints` | 18 | 2 (rename, court tags) |
| Division registration settings modal | 20 | rs010 partial |
| `/admin/settings` | 1 | **zero** |
| `/settings/*` legacy redirects (4 routes) | — | 1 (a 404 assertion) |

`/settings`, `/settings/billing`, `/settings/connect`, `/settings/payments`
render nothing — each is a `redirect()` into the org-scoped equivalent, and
each preserves its query string (`?tab=`, and Stripe's checkout/connect return
params). The real pages all live under `/o/{orgSlug}/settings/**`.

## 3. Approach — two axes per surface

Rejected: a single golden-path drive per surface. It proves each control
works for an owner on Pro and is structurally blind to the gating class above,
which is where the confirmed defect lives.

Adopted, per surface:

- **`*-drive.spec.ts`** — owner + Pro. For every control: pin the value it
  **opens at**, change it, assert it persisted, assert it renders back.
- **`*-gates.spec.ts`** — the matrix. For each gated control × each denied
  identity, assert **both** the rendered UI state and the API's own answer to
  the same write.

**Opening values are derived, never typed.** Each expected default is read
from the code's own declaration (an imported constant), so a change to the
source of truth moves the test with it instead of leaving it asserting
yesterday's number. A test that hard-codes `30` for `matchMinutes` stops
witnessing the regression it exists for the moment the fallback changes.

**Reachability proves nothing on its own.** Asserting a control exists is
satisfied by any value. Every drive spec pins the opened-at value as well as
the post-change value; where possible it picks a case whose correct answer
differs from the wrong answer's constant.

### Identity and plan isolation — three traps that reshape the matrix

The `parallel`, `walkthrough` and `serial` projects all use the same
`storageState` (`e2e/.auth/pro.json`), so **every spec in every project runs
as one shared, seeded Pro org**. `auth.setup.ts` provisions a Community state
too, but nothing wires it into those projects. Three consequences, all of them
silent:

1. **A free-plan assertion is vacuous by default.** "On the free plan this
   control is gated" passes for the wrong reason on an org where the
   entitlement is already allowed, and mutating the guard would not redden it.
   Register cases 7, 8 and 9 are precisely this shape and, written naively,
   would have been decoration.
2. **Any count counts the whole run.** Owned orgs, clubs, persons and
   registrations accumulate across every project — `auth.setup.ts` says so
   itself. A bare "exactly one" assertion passes or fails on who else ran
   first: red on a clean branch, green on the retry. Every count in this
   programme is scoped to a per-spec `TAG`, never to a global total.
3. **`setOrgPlanBySql` is group-scoped, not org-scoped**, and `POST /api/orgs`
   creates an org that joins its creator's **existing** billing group. So the
   obvious isolation recipe — mint a fresh org, set its plan — silently moves
   the shared Pro org onto that plan. Every other spec in the leg then runs on
   the wrong plan and nothing in their diffs explains it. The damage lands in
   other people's specs, which is what makes it expensive.

In order of preference, therefore:

- **Prefer `setEntitlementOverrideSql(orgId, featureKey, intValue)`.** It is
  org-scoped, parallel-safe, and the same grandfathering mechanism a real
  over-cap owner gets. It is also the right tool for this matrix, which needs
  per-feature gating — `dashboard.branding`, `sponsors.tiers`,
  `sponsors.monetize`, `api.access`, `news.auto`, `discoveryBranding`,
  `scheduling.constraints`, `themeBranding` — rather than whole-plan flips.
- **Where a genuine plan transition is the thing under test** (case 7's
  Pro→Free downgrade, case 9's switch into an org without the entitlement),
  split the group first: `POST /api/orgs` → `splitOrgIntoOwnGroupSql(orgId)`
  → `setOrgPlanBySql`, then restore the active org afterwards.
- **Never flip a plan without the split.**

This constrains W4 as well: the billing-group panel and the Pro Plus operator
console are themselves about billing groups, so a spec that splits a group to
isolate a plan must not run concurrently with one driving those panels.

## 4. Waves

Ordered so the smallest surface carrying the one confirmed defect lands
first and proves the pattern before the large surfaces adopt it.

| Wave | Surface | Specs | Notes |
|---|---|---|---|
| W0 | Foundations — `e2e/settings-support.ts`, seeding, budget harness | 0 | `pnpm install` in the worktree; measures the baseline leg time |
| W1 | `/admin/settings` + 4 legacy redirects | 1 | contains the confirmed dead-Save defect |
| W2 | `/o/{org}/settings` 7 tabs — drive+persist | 2 | sponsors **CRUD half** only |
| W3 | `/o/{org}/settings` 7 tabs — gating matrix | 1 | + first mutation sweep |
| W4 | `settings/{connect,credits,add-ons}`, billing's uncovered panels, **sponsor monetize half** | 1 | serial, real Stripe sandbox |
| W5 | Competition settings | 2 | frozen, visibility, discoverable |
| W6 | Division schedule + constraints | 2 | full bounds table |
| W7 | Division registration settings | 1 | partial-save, money bounds |
| W8 | Fix wave + programme review | — | + second mutation sweep |

### Sponsors is split across two waves, deliberately

The sponsors tab has a CRUD half (name, link, tier, scope, logo, reorder,
delete) and a monetize half (sell packages, send invoice, refund). They have
different costs and different hazards:

- CRUD needs no money and no Stripe → **W2**, parallel, cheap. The tier and
  scope selects are `sponsors.tiers` (Pro) gated, so their matrix rows go to
  W3.
- Monetize needs `sponsors.monetize` (Pro) **and** a live Connect account →
  **W4**, serial, real sandbox.

The reason the monetize half cannot go in W2 is recorded in §6: smoke's
sponsor-checkout suite claims the Connect fixture account with no release
path, and crashes the entire smoke run when another org already holds it. A
parallel sponsor-money test is exactly the org that would hold it.

## 5. Spec architecture

### The `testMatch` trap decides the file layout

The `walkthrough` Playwright project selects files with a bare directory
regex (`/[\\/]e2e[\\/]walkthrough[\\/]/`) matched against each file's
**absolute** path. `testMatch` replaces Playwright's default spec pattern
rather than intersecting with it, so **every `.ts` file under
`e2e/walkthrough/` is loaded as a spec**, helper or not. This repo has
already hit the resulting error — `test file "…" should not import test file
"helpers.ts"`.

Therefore shared support code lives at **`apps/web/e2e/settings-support.ts`**,
outside the walkthrough directory, imported as `"../settings-support"`.

### CI wiring is free

The project is directory-anchored and `.github/workflows/e2e.yml` already
carries a single `project: walkthrough` matrix entry running
`--project=walkthrough --workers=3`. Dropping a `*.spec.ts` into
`e2e/walkthrough/` is sufficient; no workflow edit, no config edit. The
`e2e-ci-wiring` guard auto-discovers recursively and needs attention only if
the project name or the regex changes.

### Helpers

- `seedSettingsOrg(request, { plan, role })` — creates an org via API and
  returns `{ orgId, slug }`. One per test.
- `openedAt(page, tab)` — snapshot of every control's initial value.
- `driveTab(page, tab, edits)` — fills, saves, reloads once, returns rendered
  values.
- `expectGate({ control, identity, expectUi, expectApi })` — the matrix
  primitive; asserts the rendered state and the route's answer together.

## 6. Stripe posture (W4)

All billing and money evidence comes from the **real Stripe sandbox** (test
mode), never the hand-written fixture server. A fixture asserts what we wrote
into the fixture; prices, `currency_options`, checkout metadata and webhook
shapes are Stripe's contract, not ours.

- Leave `STRIPE_MOCK_HOST` / `STRIPE_MOCK_PORT` unset — that selects the real
  test-mode API.
- Opt-in gate copied verbatim from the three existing Connect walkthroughs:
  `CONNECT_WALKTHROUGH=1` plus `STRIPE_CONNECT_TEST_ACCOUNT`. Each skip
  reports a **named reason**, so an unset secret reads as "not run" and never
  as a pass. CI supplies both only for `matrix.project == 'walkthrough'` and
  exports `CONNECT_WALKTHROUGH=1` through `$GITHUB_ENV` once `stripe listen`
  is up.
- Connected account: the durable fixture **`acct_1U8o7FBlv9TBkyYa`**
  (GB/GBP, charges and transfers active).

Three constraints follow, two of which cost the programme its own speed rules:

1. **The fixture account has no release path and only one org may hold it.**
   Smoke's sponsor-checkout suite crashes when another org already claims it.
   W4's Connect leg is therefore **serial, with an `afterAll` that releases
   and restores the prior holder**. This is the single place in the programme
   that does not run in parallel, and it is not negotiable.
2. **`charges_enabled` is not reachable by API for Express accounts.**
   Platform-submitted KYC is restricted to no-Dashboard accounts and Express
   is excluded; earning it means driving Stripe's hosted onboarding in a
   browser. `registration-connect.spec.ts` already owns that round trip. W4's
   scope line: it proves **how the settings surface reacts to** a connected
   account, not the onboarding itself. Attaching the real fixture id is the
   sanctioned move. Writing `stripe_charges_enabled = true` against a
   fabricated account id is the existing harness's fake and proves nothing.
3. **The fixture is GBP**, so the currency-lock cases are pinned in GBP terms.

The repo's Connect integration is **v1 Express**. A test fixture must match
the integration under test.

## 7. Edge-case register

25 cases, grouped by failure class (24 found in the inventory sweep, one more during design). Each is assigned to a wave and to the
evidence that settles it.

### Class 1 — UI-only gating (a disabled control is not a guard)

| # | Case | Wave |
|---|---|---|
| 1 | `/admin/settings` Save renders enabled for staff-non-superadmin; API 403s | W1 |
| 2 | Entry-fee currency select disabled while Connect attached — does `PATCH /api/orgs/{id}` refuse too? | W4 |
| 3 | Connect default-method `stripe` radio disabled unless `charges_enabled` — API-side check? | W4 |
| 4 | Competition form read-only when `frozen` — does `PATCH /api/v1/competitions/{id}` refuse? | W5 |
| 5 | A member (non-editor) on every tab — controls absent, disabled, or live? Does each route 403? | W3 |
| 6 | Role select is owner-only-and-not-self in the UI. `POST /members/{id}/role` on self? | W3 |

### Class 2 — entitlement transitions

| # | Case | Wave | Isolation (see §3) |
|---|---|---|---|
| 7 | Pro→Free downgrade with a brand colour already set: still rendered? still saveable? | W3 | *needs a real plan flip → split the group first (§3)* |
| 8 | `?tab=api` on a Free org — upsell, or blank? | W3 | *entitlement override on `api.access`, not a plan flip* |
| 9 | Org-switch while on `?tab=api`/`?tab=sponsors` into an org without that entitlement | W3 | *needs a second org genuinely lacking it (§3)* |
| 10 | `discoverable` is server-forced false when not public. Set public+discoverable, flip to private — is it cleared, or does a stale `true` read back? | W5 | none needed |

### Class 3 — ownership and last-actor

| # | Case | Wave |
|---|---|---|
| 11 | Last owner attempts Leave org | W3 |
| 12 | Delete account while owning an org that has other members | W3 |
| 13 | Transfer ownership when the org has exactly one member — is the control shown at all? | W3 |
| 14 | Demote the only owner to admin | W3 |

### Class 4 — validation bounds (client says X; what does the server say?)

| # | Case | Wave |
|---|---|---|
| 15 | `matchMinutes` 0 and 1441 (client `min=1 max=1440`) | W6 |
| 16 | `gapMinutes` negative; `perEntrantMinRest` negative | W6 |
| 17 | Play-from/until half-filled, and inverted | W6 |
| 18 | `ends_on < starts_on`; `endAt < startAt`; blackout `to < from` | W5, W6 |
| 19 | Age min > max; cutoff day 31 in a 30-day month; cutoff set with no age band | W7 |
| 20 | Entry fee below `cardFeeMinimum` with `payment_method = stripe` | W7 |
| 21 | Platform fee `-1`, `101`, `2.7` (client `step=0.5`; server zod `min(0).max(100)`) | W1 |
| 22 | Courts above the 50 cap | W6 |

### Class 5 — submit mechanics

| # | Case | Wave |
|---|---|---|
| 23 | Registration modal partial save: division `PATCH` succeeds, reg-settings `PUT` fails — the banner shows, but does the UI now misreport what persisted? | W7 |
| 24 | Double-submit on every Save; back-nav with unsaved edits (no dirty-guard found anywhere); `?tab=bogus`; `/settings` redirect for a user with zero orgs or a stale active-org cookie | W1, W2, W7 |

### Added during design

| # | Case | Wave |
|---|---|---|
| 25 | An org whose entry-fee currency was set to something other than GBP **before** Connect attached, then locked — does the lock strand a mismatched currency? | W4 |

## 8. Speed budget

Settings has no `HOLD_MS` soft-commit tax, so cost here is almost entirely
page loads and reloads. Rules, baked into the specs:

1. **One org per test, seeded via API** → `mode: "parallel"` is safe.
   Shared-org writes are the only reason these would have to run serially,
   and serial is what makes a leg slow. Two documented exceptions: W4's
   Connect leg (§6), and any spec that splits a billing group to isolate a
   plan (§3). A fresh org is *not* automatically isolated — it inherits its
   creator's billing group, so read §3 before seeding one.
2. **At most one `page.reload()` per tab.** Fill every field on a tab, save,
   reload once, assert all values — not reload-per-field.
3. **Split the question.** "Did it persist?" is an API read. "Does the page
   render it back?" is the one reload. Only the second needs a browser round
   trip.
4. **The matrix's API half uses `APIRequestContext`, no page.** A browser is
   needed only for the thing the API cannot answer: is the control rendered
   enabled.
5. **No `waitForTimeout`.** `expect.poll` and `waitForResponse` only.
6. **No screenshots and no axe scans** in these specs. `gallery.capture` and
   `mobile.spec.ts` already own widths and accessibility; duplicating them
   buys nothing and costs seconds.
7. **Derived timeouts**, e.g. `Math.max(60_000, PER_TAB * tabs + slack)` — a
   flat constant beside a derived cost is a latent red, and goes stale the
   moment a tab is added.

**Measured, not asserted.** W0 records the walkthrough leg's current wall
clock; every wave re-measures and reports the delta with raw numbers. Budget:
**≤60s added across the whole programme** (the leg runs `--workers=3`). A
wave that blows it gets restructured — the budget does not get quietly
raised.

## 9. Verifying the tests themselves

Four required test types per wave:

- **unit** — the bounds and defaults tables, pinned to imported constants so
  a changed default moves the test rather than silently diverging from it.
- **e2e** — the walkthroughs.
- **smoke** — the admin superadmin gate.
- **regression** — every W8 fix ships a test that fails without it.

**Mutation sweep per surface, not per test.** For each gate, remove the
server-side predicate and confirm the matrix spec reddens. A guard nothing
kills is decoration; two guards covering for each other are each untested, so
they are mutated one at a time. One sweep at W3, one at W8.

**Runner honesty.** Every green is read from `--reporter=json --outputFile`
(`numPassedTests` / `numTotalTests`), and `.testResults[].name` is checked to
confirm the paths are this worktree's. A suite that fails to collect reports
as `PASS(0) FAIL(0)` through the local wrappers.

## 10. Production changes

Test-only through W7. W8 fixes what the matrix proved broken — at minimum the
`/admin/settings` dead Save. Any new user-facing string ships to all four
locale dictionaries, and `i18n-keys.ts` is generated, so `gen-keys` is
regenerated rather than hand-edited.

Findings that turn out to be real defects are recorded in a findings file as
they are found, not held until the end.

## 11. Out of scope

- Stripe hosted onboarding (`registration-claim`/`registration-connect` own
  it).
- The existing billing suites' Stripe-heavy paths. Nearly every control on
  `settings/billing` is Stripe Elements or a Stripe API call, and those suites
  already drive them. W4 takes only the parts they leave uncovered: the
  billing-group panel, the Pro Plus operator console's per-org credit cap
  editor (neither was opened by the inventory sweep and neither has any
  walkthrough), the promo-code apply/remove pair and the cancel-reason
  select — our own UI sitting on top of Stripe.
- Width and accessibility sweeps — `mobile.spec.ts` (seven widths) and
  `gallery.capture` already own them.
- Design polish on `/admin/settings`, which is staff-only: functional bar
  only.

## 12. Risks

- **Two sibling walkthrough programmes are in flight** in other worktrees
  (`feat/directory-walkthroughs`, `feat/scheduling-walkthrough`). All three
  add files to `e2e/walkthrough/` and all three add wall clock to the same CI
  leg. File sets are disjoint, but the budget is shared — W0's baseline must
  be re-measured at merge time, not trusted from the start of the programme.
- **The Connect fixture account is a shared, unreleased resource.** Local
  runs contend with smoke. §6's release path is mandatory.
- **The shared Pro storageState makes negative assertions the default
  failure mode here.** Every "this is gated" case in §7 must be shown to
  redden when its guard is mutated, or it is proving nothing. This is the
  single most likely way for the programme to ship green and worthless.
- **The brief is a hypothesis.** Every line number and capability claim in
  this document came from a read, not a run. The edge cases in §7 are
  candidates: each is a question to settle by driving the product, and a case
  that turns out to be already-correct is a finding to record, not a failure.
