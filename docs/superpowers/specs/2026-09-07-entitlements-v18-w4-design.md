# Entitlements v18 — W4 design

Written 2026-09-07, at the W3 boundary. W3 merged as `4d00ad9de` (PR #741).

Branch `docs/entitlements-w4-handoff`, worktree
`.claude/worktrees/entw3`, forked from `fb99bbd4c`.

Read this WITH `2026-09-02-entitlements-v18-prompts/W4-owed-work.md` and the
`_INDEX.md` beside it. This document is the design; those two are the
inventory. Where they disagree with this file, this file was written later and
against the tree — but re-pin before building anyway, because line pins in
this repo go stale within a wave.

Six items. N1, N2 and N3 are the W4 brief's Part 2; N0, N4 and N5 are Part 1
items folded in during this session, and they appear after N3 in the order
they were decided rather than in numeric order.

## Owner decisions taken into this design

Recorded 2026-09-07, in session, in response to explicit questions:

- **W4 scope is Part 2 plus three folded-in Part 1 items** — N1, N2, N3, then
  items 4 and 5, then item 0's instrumentation. Items 3 and 7 and the
  unverified items 1 and 2 are W5 material and are named in "Out of scope"
  below so they are not lost. (Scope opened in two steps: Part 2 only, then
  items 4 and 5 folded in, then item 0 after the finding below.)
- **Items 4 and 5 fold in; item 3 does not.** Item 3's own framing is that the
  job is deciding a repo-wide ordering rule across ~20 handlers, not patching a
  route — that needs its own wave and its own owner ruling. Item 7 (the
  org-addon rider) is roughly N1-sized and stays in W5.
- **Item 0's measurements get built in W4.** Not the baseline — that window is
  gone — but the instrumentation, so the gap does not grow another wave.
- **N2 takes route A** — move `event-pass.spec.ts` into `e2e/walkthrough/`,
  rather than granting the real Stripe key to the `parallel` project or
  standing up a new `money` project and CI leg.
- **N1 builds all five** of `_INDEX.md` item 6's live cases, not the three the
  W4 brief names.

## False premises found while designing this

The programme's own rule 5 says the brief is a hypothesis. Five of its lines
did not survive contact with the tree. Each is corrected here rather than
carried forward.

1. **`api.write` is NOT the only boolean in `ENTERPRISE_FEATURES`.** Both the
   W4 brief and `_INDEX.md` item 6 say it is the sole self-serve-unreachable
   feature. `apps/web/src/lib/feature-copy.ts:363` reads
   `new Set(["api.write", "dashboard.branding"])` — two keys. `dashboard.branding`
   was added by V396, after item 6 was written. A test asserting singleton
   membership would pin a fact that is already stale.
2. **N3's accessibility defect does not exist.** The rail at
   `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:501` carries
   no `tabindex`, `role` or `aria-label`, which by rule 23's letter reads as a
   `scrollable-region-focusable` red. It is not one. The division page is
   already in the axe sweep (`apps/web/e2e/mobile.spec.ts:1465`, tags
   `["wcag2a", "wcag2aa"]` at `:1487`, run in all seven width projects), that
   rule is `wcag2a` at SERIOUS, and the sweep is green. axe's check is
   `focusable-content`: a scrollable region passes when it *contains* focusable
   elements, and this one is a `<nav>` of `<Link>`s. Rule 23's red came from the
   scorebug meta strip, whose chips are not focusable. Adding a `tabindex` here
   would be an unconditional change to every width to fix nothing.
3. **`event-pass.spec.ts` does not touch the shared org.** The design was going
   to split N1 across two files because `AUTH_STATE` is the shared Pro org and
   `setOrgPlanBySql` is group-scoped. That split is unnecessary: the spec seeds
   its own org and owner through a local `withDb` (`:100-120`) and `seedRig`
   (`:148-`), inserting into `subscriptions` directly (`:164-167`), and its own
   comment at `:80-82` says each block seeds its own accounts and "never the
   shared Pro or community storageState accounts". N1 follows that pattern and
   stays one file in `parallel`.
4. **No JSON reporter is configured.** `apps/web/playwright.config.ts:129` is
   `process.env.CI ? [["line"], ["html", { open: "never" }]] : "list"`. N2's
   acceptance is stated in terms of a skip count read from
   `--reporter=json --outputFile`, and there is no such artifact in CI today.
   The reporter entry has to be added as part of N2.
5. **The existing "skip loudly" warning does not cover the pass.**
   `.github/workflows/e2e.yml:489-492` keys on `STRIPE_CONNECT_TEST_ACCOUNT`
   and fires only on the walkthrough leg; it is about the Connect registration
   money path. Extending coverage to the Event Pass means a new check, not a
   reuse of that step.
6. **`device-links.spec.ts` does not carry the cookie-banner fix.** Item 5 is
   described as nine contexts sharing "the cookie-banner race Task 7 fixed",
   pointing at that spec. Its `storageState: { cookies: [], origins: [] }`
   (`:39`, `:53`, `:74`, `:187`, `:308`, `:311`) solves a different problem —
   not inheriting the authed session. The actual banner fix is
   `consentedAnonymousState()` in `apps/web/e2e/scorepad-a11y-kit.ts:346-365`,
   with `cookieBanner()` at `:311-316` and `expectNoCookieBanner()` at
   `:373-379`, and it is used exactly once, at
   `apps/web/e2e/scorepad-a11y-evidence.spec.ts:463`.
7. **Item 0 was never a query task.** It reads as "take the baseline before W3
   ships". Three of its four quantities have never been instrumented, so no
   baseline could have been taken at any point. See N0.

## N1 · `enterprise-gate.spec.ts`

**File:** `apps/web/e2e/enterprise-gate.spec.ts`. **Project:** `parallel` — it
falls through `playwright.config.ts`'s `testIgnore` list the same way
`event-pass.spec.ts` does today, so no config change and no `SERIAL_SPECS`
edit. **Isolation:** seeds its own org and owner per block, as
`event-pass.spec.ts` does. It must not drive `AUTH_STATE`'s org.

**Every number comes from the live matrix.** Helpers already exist and are the
only sanctioned source: `planCapSql(featureKey, planKey)`
(`apps/web/e2e/helpers.ts:1014`), `planFlagSql(featureKey, planKey)`
(`:1029`), `communityLimit(featureKey)` (`:354`). Retyping a cap into the spec
is the exact defect that let V393 move pro's save-point ceiling from 5 to 10
underneath the deleted `pro-plus-tier.spec.ts` without a red.

The five cases:

**C1 — save points roll a window; they do not 402.** Drive
`schedule.checkpoints.max` to its ceiling and assert the oldest checkpoint is
discarded, not that the request is refused. Read at
`apps/web/src/server/usecases/history.ts:477-481`; the evict-oldest branch is
at `:548-560` under an advisory lock (`:503`). Caps as the migrations declare
them today: community 2 (`V319__v17_phase1_reorg.sql:19`), pro 10
(`V393__entitlements_v18.sql:82`), `event_pass` and `event_pass_l` 5
(`V393:104-105`), enterprise null/unlimited (`V393:33-35`). `pro_plus` is
retired (`V393:145-146`) and must not appear in this spec.

This case carries the wave's differential requirement: pro's cap of 10 differs
from the deleted spec's hardcoded 5, and the pass rungs' 5 differs from
community's 2 — so at least two rows witness a regression that a
constant-based test could not. Include community explicitly; a two-checkpoint
ceiling is the boundary row most likely to be silently satisfied.

**C2 — `api.write`, both directions.** Refusing the write scope must still mint
a read-only key. Route `apps/web/src/app/api/v1/orgs/[id]/api-keys/route.ts:18`;
the refusal is in the usecase, `apps/web/src/server/usecases/api-keys.ts:47`
(`if (scopes.some((s) => s !== "read")) await requireFeature(auth.orgId, "api.write")`),
preceded by an unconditional `requireFeature(auth.orgId, "api.access")` at
`:42`. Assert the refusal first and the successful read-only mint second — a
test that passes its positive and negative case for the same reason is the
tell. Because `requireFeature("api.access")` runs first, at least one row must
distinguish an `api.access` refusal from an `api.write` refusal, or the two
guards cover for each other and neither is tested.

**C3 — `dashboard.branding`.** The second member of `ENTERPRISE_FEATURES`,
which item 6 does not know about. Assert the enterprise set by MEMBERSHIP
against `feature-copy.ts:363` rather than asserting a count, so the next
addition moves the test instead of breaking it.

**C4 — `officials.auto` is competition-scoped. WITHDRAWN 2026-09-08: it already
has a browser test.** This section claimed the scoping was unproven in a
browser. That was wrong. `apps/web/e2e/pass-scope-officials.spec.ts` drives a
pass-holding org against TWO competitions over real HTTP, asserts the grant on
one and the refusal on the other, pins `feature_key` rather than hardcoding it,
and exercises the real `competitionForDivision` resolver at `officials.ts:496`.
That spec merged the day before this design was written, so the claim was stale
on arrival — a reminder that `_INDEX.md` item 6's inventory is a snapshot and
every line of it needs re-pinning, which is the same lesson this document's own
"false premises" section opens with. The case below is left in place for the
record; W4 does NOT rebuild it. Resolved at
`apps/web/src/server/usecases/officials.ts:496` (also `:535`, `:795`) via
`requireFeature(auth.orgId, "officials.auto", await competitionForDivision(divisionId))`,
resolver at `:474-477`. The case that matters is the *scoping*: an org holding
a pass on competition A gets `officials.auto` there and NOT on competition B.
A test that only proves the grant exists is satisfied by an unscoped grant and
witnesses nothing.

Note for the record, not for this wave: `history.ts:463-467` defines its own
duplicate `competitionForDivision`. Two independent copies of a scoping
resolver is a divergence waiting to happen; it is W5 material, flagged here so
it is not rediscovered.

**C5 — `/admin/entitlements` column set, and the billing surface's two
states.** `apps/web/src/app/admin/entitlements/page.tsx:42-44` renders
`ADMIN_PLAN_KEYS.map(...)`, and `ADMIN_PLAN_KEYS`
(`apps/web/src/lib/entitlement-admin.ts:45`) is an unfiltered alias of
`ALL_PLAN_KEYS` (`apps/web/src/lib/currency.ts:250-252` —
`community, event_pass, event_pass_l, pro, enterprise`). Assert the column SET
equals that list, `enterprise` included; `/pricing` deliberately omits it via
`PRICING_PLAN_KEYS` (`apps/web/src/lib/pricing-matrix.ts:54-57`). Check the
empty set explicitly — a set-containment assertion is vacuously true against
an empty render, which is how three "Finished" defects shipped in a sibling
programme. The billing half asserts a community org sees the priced upsell and
a paid org's upgrade grid is hidden, with `enterprise` reaching the Contact-us
CTA rather than a priced card.

`/admin` is staff-only: functional bar, no design polish.

**Acceptance.** Runs in `parallel`, which CI executes. Each case fails when its
own guard is mutated — mutate one guard at a time, since C2's two
`requireFeature` calls otherwise cover for each other. Report the killer list
per mutant, not a count: a test that dies under every mutant is not evidence.
Judge from `--reporter=json --outputFile`, reading
`numPassedTests`/`numTotalTests`.

**Do not touch:** `pricing-v18.spec.ts`, the matrix-derived guards, or
`SERIAL_SPECS`.

## N2 · the Event Pass money path

The one flow that takes money, and no gate in the repo has ever run it. Not
locally (`.env.local` holds an `rk_test_` restricted key that cannot create a
Checkout Session), not in CI (`parallel` gets the literal `sk_test_ci_e2e_dummy`
at `.github/workflows/e2e.yml:289`; only `matrix.project == 'walkthrough'`
receives `secrets.STRIPE_SECRET_KEY`), and not in the 8/8 green that authorised
W3's merge. W3 changed an assertion in this file (`:678`) and could not observe
the result.

**The move.** `apps/web/e2e/event-pass.spec.ts` →
`apps/web/e2e/walkthrough/event-pass.spec.ts`. The `walkthrough` project
matches by directory (`playwright.config.ts:119`,
`/[\\/]e2e[\\/]walkthrough[\\/]/`), so the move alone re-projects it; no
`testMatch` edit.

**The inventory.** `WALKTHROUGH_SPECS` is a hand-maintained bare-filename list
at `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:155-266`, guarded in both
directions at `:343` (names in the list that are missing from disk, and files
the `walkthrough` project fails to select) and `:364` (files on disk absent from
the list). Neither guard is a count. `event-pass.spec.ts` is not in the array
today, so the move without the entry trips `:364`.

**The serial pin — this is what makes the move mean anything.** U6, U12, U14,
U15 and U16 each `test.skip(!stripeUsable, …)` (`:631`, `:708`, `:735`, `:810`,
`:890`) on a module-scoped flag that U1 sets from a live probe (`:518`). Module
scope is per worker, and the walkthrough leg runs `--workers=3`. Moved
unchanged, U1 can land in one worker while U16 lands in another with
`stripeUsable` still false — it skips, and the leg reports green. That is
precisely the failure N2 exists to name, reintroduced by the fix. Add
`test.describe.configure({ mode: "serial" })` to the file; eight specs already
under `e2e/walkthrough/` set it per-file, so this is the established
convention rather than a project-level change.

Note also `beforeAll:470-486` throws only when the key fails
`/^(sk|rk)_test_/`, and `sk_test_ci_e2e_dummy` matches that pattern — so the
hard throw never fires in CI and the live probe is the only real gate.

**The reporter and the check.** Add a JSON reporter entry to
`playwright.config.ts:129`'s CI branch with a known `outputFile`, then add a
post-run step on the walkthrough leg that fails when U1 or U16 report as
skipped. Acceptance is a CI run in which **U1 and U16 report as RUN** —
`numPendingTests` for those two is 0. A green that skips them is the failure,
so the check reads the skip count, never the pass count.

**Do not touch:** the `rk_test_` key in `apps/web/.env.local` (restricted on
purpose), and do not run `stripe:sync` without the owner's approval — it writes
to a shared Stripe test account.

## N3 · the division tab rail at 320

Observed during W3's phone verification, never pinned. The rail is emitted
inline in the page component, not a separate file:
`apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:501`, a `<nav>`
with `class="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200"`,
tabs mapped at `:504-533`, tab list `entrants, fixtures, standings, stats`,
plus `discipline` (conditional) and `settings` for editors. `.scroll-x` is
`overflow-x: auto` (`globals.css:397`); `.scroll-x-fade` adds a right-edge
gradient to `var(--background)` (`:400-406`), so it tracks the theme rather
than assuming a light ground. No width-conditional classes anywhere on it. The
three names a prior session surfaced — `division-settings.tsx`,
`launch-actions.tsx`, `officials-panel.tsx` — remain correctly rejected.

Per false premise 2 above, the accessibility red is not real. What remains is
a coverage gap: **nothing classifies this rail's overflow.**
`expectScorebugNotClipped` (`apps/web/e2e/mobile.spec.ts:136`) is scoped to
`[data-role="v3-scorebug"]`, and the page-level no-horizontal-scroll gate
cannot see a box that scrolls inside itself. So "the tabs are reachable at 320"
is true today by accident, and nothing would catch it turning false.

**Therefore N3 is reproduce, rule, and gate — not fix-first.**

1. Drive a division page at 320 as an editor, so the rail carries six tabs and
   actually overflows. Screenshot it. Write down what is seen, not what must be
   true.
2. If the tabs scroll and the overflow is reachable, the verdict is "not a
   defect" and the deliverable is a regression assertion built on
   `overflowingIn` (`mobile.spec.ts:91` — computed `overflow-x` of
   `auto`/`scroll` is a feature; `hidden`/`visible` is a clip), asserting the
   rail is the reachable kind rather than merely that the page does not
   scroll horizontally.
3. If the browser shows clipping, a dead fade edge, or tabs unreachable by
   touch, that is the defect: bring the owner at least two options with
   screenshots before building, per standing rule.

A latent gap worth one line in the same pass: the axe sweep visits only
`?tab=standings` (`mobile.spec.ts:1465`), so the other tab states have no axe
coverage.

**Acceptance.** A per-screen verdict at 320 with a screenshot, the seven width
projects in `mobile.spec.ts` green, and the layout holding at non-100% zoom —
not merely "no horizontal scroll", which cannot see layout.

## N0 · the distribution measurements (item 0)

Item 0 asked for a baseline of embed loads, public-profile views, auto-posted
items, and how many orgs use each — taken **before** W3 shipped the surfaces,
"or the counterfactual is gone for good". W3 has shipped, and the baseline
could not have been taken in any case, because the measurements do not exist.

Verified 2026-09-07:

- Analytics exist and are used elsewhere: PostHog client at
  `apps/web/src/instrumentation-client.ts:31`, server capture at
  `apps/web/src/lib/posthog-server.ts` (`captureServer`).
- **Embed loads — not measured.** `EVENTS.EMBED_RENDERED` is defined at
  `apps/web/src/lib/analytics-events.ts:41` and has no application call site;
  its only other reference in the tree is
  `apps/web/src/lib/__tests__/analytics-events.test.ts:10`, which asserts the
  constant exists. Neither the embed route
  (`apps/web/src/app/embed/divisions/[id]/[widget]/page.tsx`) nor its loader
  (`apps/web/src/server/embed-data.ts`) captures anything. This is the
  programme's inert-seam class: declared, unit-green, wired to nothing.
- **Public-profile views — not measured.**
  `apps/web/src/app/(public)/shared/[orgSlug]/page.tsx` records nothing.
- **Auto-posted items — undercounted.** `POST_PUBLISHED` with `auto` fires at
  `apps/web/src/server/usecases/org-posts.ts:318-324`, but only inside the
  explicit `action: "publish"` branch (`:281`). The auto-draft insert
  (`insertGeneratedPost`, `:676`) leaves `status: 'draft'` and fires nothing,
  so the event counts human publishes of auto-drafts, not auto-posts.
- **No captured baseline exists** anywhere in `docs/`.

**What W4 builds: the three measurements, not the lost baseline.** Give
`EMBED_RENDERED` its call site on the embed render path; add a public-profile
view capture on the shared-org page; fire the auto-post count where the draft
is generated rather than where a human publishes it, keeping the existing
publish event intact so the two remain distinguishable.

**Constraint to record wherever these numbers are later read:** `captureServer`
is consent-gated. These are consented-traffic counts, not totals, and must not
be presented as absolute volumes.

**Acceptance.** Each of the three fires from its REAL producer — driven through
the actual route, not asserted against a fixture on both ends, which is how
`EMBED_RENDERED` came to exist without a caller in the first place. Deleting
each new call site reds a test.

## N4 · device-link refusals are unmetered (item 4)

`requireFixtureActor` at `apps/web/src/server/api-v1/auth.ts:238-296` runs
token-auth → ownership → rate-limit → context:

| line | step |
|---|---|
| `:251` | `resolveDeviceLinkToken(dlToken)` — authenticates the token |
| `:255-256` | ownership: `deviceLinkCoversFixture` → `throw new HttpError(403, "This device link is for a different fixture")` |
| `:259-260` | `rateLimit(\`dlv1:${link.id}\`, { max: 10, windowSeconds: 1 })`, gated on `intent === "score"` |

The meter is keyed per device-link id and is only reachable once ownership has
already passed, so cross-fixture refusals are never metered while grants are.
The brief's premise holds.

**Design: add a refusal meter before the ownership check; do not move the
existing call.** Moving `:259-260` above `:255` would change the success path
for every score-intent caller —
`apps/web/src/app/api/v1/fixtures/[id]/lineups/[entrantId]/route.ts:28`,
`.../finalize/route.ts:15`, `.../events/route.ts:15` — for no gain. A separate
meter on the refusal branch, keyed on the same `link.id`, closes the hole with
zero effect on legitimate traffic. Read-intent callers
(`state/route.ts:12`, `fixtures/[id]/route.ts:11`, `events/route.ts:24`,
`lineups/[entrantId]/route.ts:11`) never reach the existing limiter at all
because of the intent gate; the refusal meter should cover them, since a
cross-fixture 403 is equally free to probe at read intent.

**No test covers this path today.** `dlv1` appears exactly once in the whole
tree — the production call site itself. So the existing limiter is unproven as
well as incomplete. W4 ships a test that fails without the new meter, and the
mutant is deleting the `rateLimit` call outright: it must red.

## N5 · nine anonymous e2e contexts and the cookie-banner race (item 5)

Counts confirmed exactly: `apps/web/e2e/scorepad-offline.spec.ts:210, 266,
301, 365` (4); `apps/web/e2e/scorepad-v3-partial-amend.spec.ts:201, 363, 425,
471` (4); `apps/web/e2e/scorepad-v3-cricket.spec.ts:421` (1). All nine use
inline `storageState: undefined`.

Per false premise 6, the fix pattern is not in `device-links.spec.ts`. It is
`consentedAnonymousState()` (`apps/web/e2e/scorepad-a11y-kit.ts:346-365`),
which seeds `CONSENT_KEY` / `CONSENT_VERSION_KEY` into `localStorage` so the
banner's `useEffect` never sets `visible`. It has one caller today
(`apps/web/e2e/scorepad-a11y-evidence.spec.ts:463`) and no equivalent exists in
`apps/web/e2e/helpers.ts`.

**Design:** point all nine sites at `consentedAnonymousState()`. Whether the
helper moves to `helpers.ts` or stays in `scorepad-a11y-kit.ts` is an
implementation call — all three target specs are scorepad specs, so importing
from the kit is defensible and avoids touching a shared module. Do not
weaken any assertion to accommodate the change; a banner that no longer
intercepts should make the existing assertions pass more reliably, not
differently.

**Acceptance.** The three specs green across the projects that run them, and a
re-run three times before believing a flaky-shaped gate. `expectNoCookieBanner()`
(`scorepad-a11y-kit.ts:373-379`) is the positive check that the banner is
actually gone — without it, seeding consent and changing nothing observable
would look identical to a no-op.

## Wave shape

Six lanes. File sets, and whether they collide:

| lane | touches |
|---|---|
| N0 | `analytics-events.ts` call sites: embed route + loader, `(public)/shared/[orgSlug]/page.tsx`, `org-posts.ts` |
| N1 | `apps/web/e2e/enterprise-gate.spec.ts` (new) only |
| N2 | `e2e/walkthrough/event-pass.spec.ts` (moved), `e2e-ci-wiring.test.ts`, `playwright.config.ts:129`, `e2e.yml` |
| N3 | division `page.tsx`, `mobile.spec.ts` |
| N4 | `server/api-v1/auth.ts` + its new test |
| N5 | the three scorepad specs, possibly `scorepad-a11y-kit.ts` |

All six are disjoint, so the lanes may run in parallel. Two cautions that
override the table. **N3 and N5 both end in `mobile.spec.ts`'s neighbourhood** —
N3 edits that file directly, N5 does not, but both are judged by the same
seven width projects, so their gates must be re-run together at the wave
boundary rather than trusted individually. And **N2 owns `playwright.config.ts`
alone**: if any other lane needs a config change, it queues behind N2 rather
than editing in parallel, because a shared literal edited from two branches is
the ugliest merge shape available.

The earlier plan to sequence N1 behind N2 over a shared `SERIAL_SPECS` edit is
void — false premise 3 removed that edit.

## Verification

- vitest judged from `--reporter=json --outputFile`, reading
  `numPassedTests`/`numTotalTests`, run as `cd apps/web && vitest`. A suite that
  fails to COLLECT reports 0 tests and 0 failures and looks clean.
- The matrix-derived and source-scanning guards run explicitly after any
  `plan_entitlements` read change; file-based test selection never reaches them.
- Pre-merge e2e: `gh workflow run E2E --ref docs/entitlements-w4-handoff`.
  `e2e.yml` triggers on push to `main` only, so a feature branch gets no
  automatic e2e signal, ever, until it merges. Smoke is PR-only. The two
  triggers are disjoint and neither substitutes for the other.
- Visual sign-off on every screen change: screenshots at 320, 768 and 1280,
  phone first, before committing.

## Out of scope — W5 material, recorded so it is not lost

Items 4 and 5 moved INTO this wave as N4 and N5; item 0's instrumentation
moved in as N0. What remains for W5:

- **Item 3** — the events route parses the body before authenticating
  (`apps/web/src/app/api/v1/fixtures/[id]/events/route.ts:14-15`). A repo-wide
  ordering pattern across ~20 handlers, so the job is deciding the rule and
  then sweeping, not patching this route. Needs its own owner ruling first.
- **Item 7** — an unrecognised org-addon rider is a silent billing path;
  `scripts/stripe-sync.ts` has no prune, orphan or reconciliation logic of any
  kind, and `isOrgAddonItem` is at `apps/web/src/lib/org-addons.ts:80`. Its own
  deadline stands: **close it before a live Stripe catalogue exists.** Roughly
  N1-sized, and it writes to a shared Stripe test account, so nothing runs
  `stripe:sync` without the owner's approval.
- **Item 0's baseline itself** — unrecoverable for the pre-W3 window. Once N0
  lands, a forward baseline can be taken; it will not answer the
  growth-reversal counterfactual the item was written for. Say so plainly
  wherever those numbers are used.
- **Items 1 and 2** — not re-verified at the W3 boundary (the setbased kernel's
  unreachable event schemas; the relocated unguarded `padSpec` throw in
  `pad-host.tsx`). Treat their pins as stale and re-verify before acting.

Added by this design: the duplicate `competitionForDivision` at
`history.ts:463-467` versus `officials.ts:474-477`.
