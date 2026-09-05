# Settings walkthroughs — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-03-settings-walkthrough-design.md`
- **W1 plan:** `../../plans/2026-09-03-settings-walkthrough-w1.md`
- **Branch:** `feat/settings-walkthrough`

## Why this programme exists

~105 settings controls across five surface families; seven existing tests that
change a value and assert it persisted; zero coverage of competition settings
or `/admin/settings`. Nearly every control is gated by a role or entitlement
check expressed as a client `disabled` prop, and `apps/web` vitest is
`environment: "node"` — it cannot see a rendered button's enabled state.

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W1 | `/admin/settings` + 4 legacy redirects; `setOwnerStaffRoleSql` ships with it | **DONE** — 6 tasks, 5 fix rounds, all reviews clean |
| W2 | `/o/{org}/settings` 7 tabs — drive+persist (sponsors CRUD half) | Not started — W1's follow-ups were **closed in W1.5**, not carried here |
| W3 | `/o/{org}/settings` 7 tabs — gating matrix + first mutation sweep | Not started |
| W4 | `settings/{connect,credits,add-ons}`, billing's uncovered panels, sponsor monetize half | Not started |
| W5 | Competition settings — frozen, visibility, discoverable | Not started |
| W6 | Division schedule + constraints — full bounds table | Not started |
| W7 | Division registration settings — partial-save, money bounds | Not started |
| W8 | Fix wave + programme review + second mutation sweep | Not started |

W0 (foundations) was **folded into W1**, and `e2e/settings-support.ts` was cut
from it. A support module with no consumer is an inert seam: W1's only shared
helper needs `withDb`, so it belongs in `e2e/helpers.ts` beside
`setOwnerStaffSql`. `settings-support.ts` arrives in W2 with real consumers.

## Owner rulings

Rulings BY THE OWNER. Recommendations I made are in the next section and are
**not** interchangeable with these. Never carry either to a peer session as
the other.

1. **Scope is the whole programme**, all five surface families, both axes —
   not a thin slice and not one surface (2026-09-03).
2. **Walkthroughs must be optimized and fast** (2026-09-03). This is why the
   ≤60s budget and the seven speed rules in `_RULES.md` exist, and why the
   matrix's API half runs without a browser.
3. **Money paths run against the real Stripe sandbox**, using the connected
   account we already hold — `acct_1U8o7FBlv9TBkyYa` (2026-09-03).
4. **Sponsors is in scope** (2026-09-03), which is what split it across W2 and
   W4 — see the recommendation below.
5. **Subagent dispatches use Opus 5** (2026-09-03). Note this overrides
   `AGENTS.md`'s "never override `model:` on a dispatch".

## Recommendations I made (NOT owner rulings)

1. **Fix the two `/admin/settings` defects in W1 rather than W8.** The design
   says test-only through W7, but a knowingly-red test cannot sit in the CI
   leg for eight waves. Both fixes are a few lines on a staff-only surface.
   Owner has not ruled on this; flagged at handoff.
2. **`/admin` is de facto English-only.** `admin-platform-settings.tsx`
   hardcodes every string today. The repo rule says any new user-facing string
   ships to all four locale dictionaries, and `/admin` is not one of the two
   declared exceptions (`content/help/**`, `apps/web/src/games/**`). Adding
   one more hardcoded English string is consistent with the file and
   inconsistent with the rule. Needs an owner call.

   **RULED 2026-09-04 (owner):** "only for staff, not the enduser so don't
   spend more time on that in /admin". `/admin` is staff-only and stays
   English-only; no dictionary work is owed for it, and the two declared i18n
   exceptions are joined by a third in practice. The evidence agrees with the
   ruling: none of the five `/admin` files import `t`/`dict`, and
   `admin-credits-panel.tsx:9` says so in a comment — "English-only (no
   `t`/`dict` island)". A session in between briefly reported the opposite from
   a loose `t(` grep that matched inside unrelated identifiers; a grep is not a
   read, and the correction was the error.

## Findings

Recorded as they are found, not held to the end. Each is a hypothesis until
driven — see `_RULES.md` §8.

| # | Finding | Confidence | Wave |
| --- | --- | --- | --- |
| F1 | `/admin/settings` Save rendered enabled for a `support`-role staff user while `PUT` threw `AuthError` → **401**. Page gates on `requireStaff()`, route on `requireSuperadmin()`, and the component's only `disabled` was `busy \|\| !valid`. | **FIXED** — `fdbe826b5`, mutation-killed | W1 |
| F2 | Clearing the fee input saved **0%**. `Number("") === 0`, so `valid` stayed true, the button stayed live, and zod accepted 0 — the platform's entire cut on entry fees zeroed by clearing a field and one click. | **FIXED** — `f9ab8e5f7`, mutation-killed | W1 |
| F3 | `step={0.5}` is enforced by nothing — not by `valid`, not by the route's zod schema. Driven and confirmed: `2.7` is accepted end to end and stored **unrounded**. | **PINNED as behaviour**, not a defect | W1 |
| F4 | `/settings` forwards only `tab`; `/settings/billing`, `/settings/connect` and `/settings/payments` rebuild the full query string. Its searchParams is typed `{tab?: string}` and drops the rest. **Customer impact is NOT nil** — see the correction below. | **FIXED** — follow-up wave | W1.5 |
| F5 | `lib/platform-settings.ts:48` did `Number(row?.value)` on a jsonb column, so a row holding jsonb `null`/`false`/`""`/`[]` read as a finite, in-range `0` and served a **0% platform cut** to the settings page and to every checkout, overriding the fallback an ABSENT row correctly reaches. | **FIXED** — follow-up wave, mutation-killed | W1.5 |

## F7 — FIXED on this branch, with two branches still residual

`bf16ea599`. **This section previously said "Open. Not fixed on this branch",
which was true when written and false by the time a reviewer read it** — the
index is what a fresh session reads first, so a stale "open" here costs more
than no entry at all.

**What was wrong.** `/settings` forwarded the whole query, but
`requirePageAuth()` runs first and its unauthenticated branch is a bare
`redirect("/login")` carrying no destination (`page-auth.ts:37`). That is the
DEFAULT path for the one param the shim exists to carry:
`/api/auth/change-email/confirm` needs no session — it acts on the token alone —
and the link is mailed to the user's NEW address, so it is normally opened with
no cookie. The address change committed and the outcome was still discarded.

**What fixed it.** No new auth machinery. `AuthForm` already forwards a `next`
to the magic-link/signup/google routes, `safeNextPath` already validates it, and
`postAuthLanding` already honours it — `LoginPage` simply never read `?next=`
from its own URL. The shim checks auth itself so it can build the destination
from the query it is holding.

**And it opened a hole, which is the part worth remembering.** Making
`/login?next=` a reachable GET turned a latent `safeNextPath` weakness into a
live open redirect. `startsWith("/") && !startsWith("//")` treats a backslash as
an ordinary character; the URL parser normalises it to a slash in the authority
position, so `/\evil.com` passed and
`new URL("/\evil.com", "https://seazn.club").href` is `https://evil.com/` —
verified in node, not reasoned. Two live paths: a signed-in victim is thrown
off-site by the login page's own `redirect()`, and a signed-out victim completes
a real sign-in and is delivered to the attacker's page authenticated.
`safeNextPath` now validates the property actually wanted — resolves to the same
origin — instead of prefix arithmetic, and has the repo's first tests for it
(`safe-next-path.test.ts`), which fail 2/5 against the old implementation.

**A hardening change with no test is how this got here**: `safeNextPath` existed
with zero coverage anywhere in `src/` or `e2e/`.

### Residual, NOT fixed — for whoever picks this up

`requirePageAuth` drops the query on two further branches: `orgs.length === 0`
-> `/orgs/new` (`page-auth.ts:39`) and `role === "scorer"` -> `/my-matches`
(`:42`). The F7 flow makes the first MORE reachable, not less: `postAuthLanding`
returns a safe `next` **without provisioning an org** (`auth.ts:413-419`), so a
first-time signup arriving through `/login?next=/settings?...` lands org-less
and is bounced to `/orgs/new` with the outcome gone.

Not fixed here because `/orgs/new` has no `next` handling at all (checked), so
closing it means giving that page a destination contract too — a second
auth-flow change, unverified, at the end of a wave. Neither user has an
org-scoped settings page to land on, so the banner has no home for them today;
that is an explanation of the current shape, not a defence of it.

The e2e also still hand-types the URL the producer should emit. Driving
`GET /api/auth/change-email/confirm?token=<garbage>` yields the `invalid`
outcome with no seeding and would prove producer -> shim -> banner in one hop.

## W2 — IN PLANNING (2026-09-05)

Worktree `.claude/worktrees/settings-w2`, branch `feat/settings-w2-tabs`, based
on `18afdf5c5` — main WITH W1.5 merged (PR #715, all 11 CI checks green).

**W1 and W1.5 are CLOSED.** Everything the earlier sections list as open is
either fixed or explicitly recorded as residual below. Do not re-derive them.

Scope, unchanged from the design doc: `/o/{org}/settings`, the seven
`?tab=` panels, drive-and-persist. **Sponsors CRUD half only** — the monetize
half (packages, invoice, refund) needs `sponsors.monetize` plus a live Connect
account and belongs to W4, serial, because smoke's sponsor-checkout suite
claims the Connect fixture with no release path. Two specs, parallel.

### Carried in from W1.5 — do these here, not later

1. **F7's residual.** `requirePageAuth` still drops the query on
   `orgs.length === 0` -> `/orgs/new` (`page-auth.ts:39`) and `role === "scorer"`
   -> `/my-matches` (`:42`). W1.5's fix made the FIRST more reachable, not less:
   `postAuthLanding` returns a safe `next` without provisioning an org
   (`auth.ts:413-419`), so a first-time signup arriving via
   `/login?next=/settings?...` lands org-less and is bounced with the outcome
   gone. `/orgs/new` has no `next` handling at all — closing this means giving
   that page a destination contract. W2 drives the account tab, so it owns this.

2. **Drive the PRODUCER, not the URL.** `settings-admin.spec.ts`'s two
   email-change tests hand-type `/settings?tab=account&email_change=...`, which
   is the URL `/api/auth/change-email/confirm` is supposed to emit. Rename the
   param or drop `tab=account` (which gates the banner,
   `o/[orgSlug]/settings/page.tsx:559`) and they stay green while every real
   confirmation breaks. `GET /api/auth/change-email/confirm?token=<garbage>`
   yields the `invalid` outcome with no seeding and drives
   producer -> shim -> banner in one hop.

### OWNER INSTRUCTION 2026-09-05 — fix the phone view in this wave

Owner sent a 320px capture of `/o/{org}/settings?tab=organization` and said
"fix the mobile view in this wave2". This is now W2 scope, not a follow-up.

**Observed in that capture — to be re-verified in a browser at 320 before
building, because a screenshot shows symptoms and not causes:**

1. **The org identity row loses its name.** The row packs avatar + org name +
   `Owner` badge + `Switch` button onto one line. At 320 the name is squeezed
   to almost nothing between the avatar and the badge — the one piece of
   information the row exists to show is the piece that disappears. Suspect the
   usual cause: a `truncate` without `min-w-0` on the whole ancestor chain, or a
   flex row that should wrap the controls onto their own line below the name.
   This is the same defect class the phone-composition programme documents for
   `detail-dock.tsx` (a name in a one-column cell inflating into a blob).

2. **The tab rail runs off the right edge** — "Organisation | News | Spons…" is
   cut. **Do NOT "fix" this before establishing which kind it is.** AGENTS.md
   failure class 23: an overflow whose content is REACHABLE by swiping is a
   feature; one inside an `overflow-hidden` box is a defect, and a
   `scrollWidth > clientWidth` scan cannot tell them apart. Split on computed
   `overflow-x` (`auto`/`scroll` vs `hidden`/`visible`) — `overflowingIn` in
   `mobile.spec.ts` already does exactly this. If it IS a rail, it owes
   `tabindex="0"` plus a role and an accessible name or axe reds at SERIOUS
   (`scrollable-region-focusable`), and `tabindex` cannot be varied by media
   query, so it is unconditional.

3. **General cramping** — the cards run close to the viewport edges.

**Rules that bind this work, from the phone-composition design of record**
(`docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md`):
ONE DOM, branched — everything below `md` (768) is `max-md:*`, everything
phone-only is `md:hidden`; never a second phone tree. **>=768 must not change.**
And `/\bmd:hidden\b/` also matches inside `max-md:hidden`, so an assertion
written that way passes on its own inversion.

**Verification bar:** screenshots at 1280, 768 and 320 with no horizontal page
scroll at any of them, and a control-set diff from the live DOM at 320 against
1280 — membership, order and repeats — NOT a comparison of box sizes. A phone
view showing the same control set at smaller sizes is a groomed shrink, which
is the thing that bar exists to catch. The seven-width `mobile.spec.ts` matrix
is the backstop; a change here can redden all five phone projects while every
unit test stays green, because `apps/web` vitest is `environment: "node"`.

### Findings that changed the W2 design before a line was written

Established 2026-09-05 by reading the tree. Two of them contradict documents
this programme otherwise defers to, and they bind. Full text and the code they
were read out of: `../../plans/2026-09-05-settings-walkthrough-w2.md`.

**A. `_RULES.md` §2 is STALE.** It says `POST /api/orgs` joins the creator's
existing billing group. That was V309. `createOrgForUser`
(`apps/web/src/lib/auth.ts:326-329`) now inserts a fresh `subscriptions` row
with `plan_key = 'community'` for every new org (#212, "individual by
default"). Two consequences: `setOrgPlanBySql` on a seeded org can no longer
drag the shared Pro org with it, and — the one that would have wrecked W2 —
**a freshly seeded org is COMMUNITY**, so every Pro-gated control on these
seven tabs renders as an upsell until the org is flipped. A spec that seeded
an org and expected the Pro surface would have asserted against the wrong
screen and called it a pass.

**B. The shared Pro user may own FIVE organisations, ever.**
`assertMayOwnAnotherOrg` (`auth.ts:223-226`) counts `org_members` rows with
`role = 'owner'` **for the user** and applies **no `deleted_at` filter**, then
refuses when `owned.length + 1 > limit` (5 on Pro,
`lib/billing-group.ts:109`). Soft-deleting an org does NOT return the slot;
only dropping the owner membership row does. The whole leg shares that user
and `org-management.spec.ts:35` already spends one per run, so **the design's
"one org per test" (§8.1) is not executable** — it exhausts the cap inside a
single spec file and 402s with `PaymentRequiredError`. Ruling: one org per
spec FILE, released in `afterAll` by a new `releaseSeededOrgSql`.

**B, CORRECTED once the mutants ran — the rule stands, the alarm does not.**
Both mechanisms are mutation-confirmed: dropping the `delete from org_members`
and keeping only the soft delete reddens the owned-count assertion
(`Expected: 1 / Received: 2`), so a soft-deleted org really does keep its slot
AND still appears in `GET /api/orgs`. But the SEVERITY written above is wrong.
`auth.setup.ts:96` calls
`setEntitlementOverrideSql(setupOrgId, "orgs.max_owned", 50)` on the shared
Pro org, and `assertMayOwnAnotherOrg` takes the BEST limit across the orgs a
user owns — so a normal e2e run has 50 slots, not 5, and nothing 402s inside
one spec file. Keep one-org-per-file: the release is proven necessary and what
it prevents is slow slot accumulation across a leg. Drop the alarm.

**A is mutation-confirmed too:** deleting the plan flip reddens the `?tab=api`
assertion, so a freshly seeded org really is community and the Pro surface is
absent rather than merely different.

**A second false premise of mine, found by Task 6.** The W2 plan told Task 6
to "build the org-less redirect from the current URL" inside
`requirePageAuth()`. That is not implementable in this Next: the helper is
zero-arg, the repo has no middleware, `next-url` is set only on client-side
RSC navigations, and `x-matched-path` is Vercel minimal-mode only. The
destination must be PASSED IN — and the only caller where the residual is
reachable is the legacy `/settings` shim, which already computes the target
for its own `/login?next=` bounce. Honouring the plan literally would have
shipped a `next` option no producer ever passes: an inert seam, on the day it
landed. Also recorded: `page.tsx` files here cannot carry arbitrary named
exports (`next-types-plugin` diffs the module against a fixed set), which is
why both helpers live in `page-auth.ts`.

**C. `POST /api/orgs` switches the active org.** `api/orgs/route.ts:29` calls
`setActiveOrgId`, and an `APIRequestContext` shares the browser context's
cookie jar — seeding moves `seazn_org` out from under the caller. Every seed
captures and restores the previous value.

**D. The tab rail in the owner's 320px capture is ALREADY CORRECT — a case
that turned out fine, not a defect.** The capture shows it cut off at the
right edge. `settings-nav.tsx:217` carries `scroll-x scroll-x-fade` inside a
`ScrollActiveTabIntoView`, and `.scroll-x` is `@apply overflow-x-auto`
(`apps/web/src/app/globals.css:396-399`). Under AGENTS.md failure class 23
that is the REACHABLE kind of overflow — a feature — and `overflowingIn`
(`e2e/mobile.spec.ts:91`) already classifies it as `scrollable` rather than
`clipped`. "Fixing" it would have broken a working control. **The real phone
defect is the identity row** (`page.tsx:288`): the name block is `flex-1`
(`flex: 1 1 0%`), the avatar is `shrink-0` and the badge and switcher size to
content, so the org name is the only child that yields and gets ~38px of a
~240px row. `min-w-0` is already present — the usual `truncate` diagnosis is
NOT the cause here.

**D, MEASURED 2026-09-05** off the live DOM at BUILD_ID `jWQtwrLaBn_2DBZk49Lnf`.
Both halves settled, and the defect is worse than the estimate above.

Org name "My organization", natural width 107px. Row inner width / name box /
name scrollWidth:

| width | row | name box | scrollWidth | |
|---|---|---|---|---|
| 320 | 238 | **6px** | 107 | clipped |
| 360 | 278 | 46px | 107 | clipped |
| 375 | 293 | 61px | 107 | clipped |
| 390 | 308 | 76px | 107 | clipped |
| 430 | 348 | 116px | 116 | not clipped, still below a readable floor |
| 768 | 478 | 246px | 246 | |
| 834 | 544 | 312px | 312 | |
| 1280 | 734 | 502px | 502 | |

**6px, not the ~38px estimated above** — the org name is a two-character
sliver. The arithmetic closes exactly and names the mechanism: at 320 the four
children measure avatar 44 + name 6 + badge 57 + switcher 95, plus three 12px
gaps = 238, the row's entire inner width. Avatar and switcher are both
`shrink-0`; the badge sits at its own min-content (57 — "Owner" is one word);
the `flex-1` name block is the only child that can yield, exactly as
`flex: 1 1 0%` requires.

**The tab rail is CONFIRMED already-correct.** Computed `overflow-x` on the
settings `<nav>` is `auto` at every phone width, scrollWidth 1300 against
clientWidth 320-430 — the reachable kind under AGENTS.md failure class 23,
i.e. the feature the owner's capture shows. At 768/834 it is 176/176 and not
overflowing at all, the rail having become the desktop column. And
`documentElement.scrollWidth <= innerWidth` at all seven widths, so the
cut-off rail costs the page no horizontal scroll. **Recorded as a case that
turned out already-correct; the markup is not to be touched.**

**E. `org-switcher.tsx` is hardcoded English on a surface this wave drives.**
Found while reading the identity row, not by looking for it:
`aria-label="Switch organisation"` (`:103`), the button label `Switch`
(`:107`) and `Switching…` (`:144`) are literals with no `t`/`dict`. That
breaks the repo's standing rule for every non-English locale, and this control
sits in the org identity row on `?tab=organization` — the exact row the owner
photographed. It is PRE-EXISTING and outside W2's stated scope, so it is
recorded rather than swept into a wave already carrying four parallel tasks;
it needs three keys across four dictionaries plus a `gen-keys` regen. Assign
it at the W2 boundary or to W8, but do not let it sit unrecorded: `/admin` is
the only surface with an English-only ruling, and this is not `/admin`.

### `/api/health` returns 200 while the bundle underneath is DELETED

Found 2026-09-05, and it is a NEW signature — a sibling of the "server already
up = old bundle" trap this repo records, but failing differently.

`seazn-env rebuild` wipes `.next` (keeping `.next/cache`) BEFORE compiling, so
for the whole build window the still-running server is serving from removed
files. During that window:

- `curl /api/health` → **200**
- `curl /_next/static/<BUILD_ID>/_buildManifest.js` → **500**
- `.next/BUILD_ID` → **empty**; `.next/standalone/apps/web/server.js` → **gone**

A Playwright run started in that window produces NO OUTPUT, or a half-served
page — and the failure reads as a broken spec, not a broken environment. It is
not a stale build serving old code; it is a deleted build still answering the
health check.

**The honest probe** — never `/api/health` alone:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:<port>/_next/static/$(cat apps/web/.next/BUILD_ID)/_buildManifest.js"
```

200 there means the bundle is really being served. This is why builds on a
shared label have ONE owner and every agent requests rather than runs one.

### Machine note

The box was carrying seven seazn-env labels at load 269 and OOM-killed a
production build (exit 137) on 2026-09-05. Six were other sessions'. A wave
that needs builds should check `seazn-env status` and the load first — and
`up --all`, never `up --server` then `up --placement`, or the server starts
without `PLACEMENT_SERVICE_HOST` and ten scheduling tests fail as
`solver_unavailable`.

## False premises found

Recorded so the next session does not re-derive them.

**F4's own severity, written by W1 and wrong.** The finding above originally
read "Customer impact today is nil — nothing links there with a second param".
Nothing links there was asserted, not checked. `/api/auth/change-email/confirm`
redirects **all five** of its outcomes through exactly that shim —
`/settings?tab=account&email_change=success|invalid|expired|taken|error`
(`confirm/route.ts:26-57`) — and the org-scoped page renders its banner off
that param alone (`o/[orgSlug]/settings/page.tsx:270,564`). Every email-change
confirmation therefore landed on an identical bannerless page: "updated
successfully", "that address is already in use" and "this link has expired"
were indistinguishable to the user. The banner code was live the whole time;
nothing reachable ever sent it a value. A grep for `/settings?` would have
found the producer in one call, and the wave routed the finding to a later
wave on the strength of a guess instead.

1. **`AuthError` maps to 401, not 403.** A first draft of W1's gate test
   asserted 403. `lib/http.ts:34` returns 401.
2. **`setOwnerStaffSql` cannot express `support`.** It hardcodes
   `staff_role = 'superadmin'`. Testing the staff-but-not-superadmin gate
   needs a new `setOwnerStaffRoleSql(orgId, role)`.
3. **`/settings/*` are not pages.** All four are `redirect()` shims into
   `/o/{orgSlug}/settings/**`, and all four preserve their query string.
4. **`settings/billing` has almost nothing that is not Stripe.** An earlier
   scoping line said W4 would take "billing's non-Stripe controls"; the actual
   uncovered set is the billing-group panel, the operator console's per-org
   credit cap editor, promo apply/remove and the cancel-reason select.

## W1 result — measured, not asserted

Full walkthrough leg at `--workers=3`, JSON reporter: 31 expected, 2
unexpected, 0 flaky, 7 skipped, **721.7s wall**, 1977.5s of test time across 40
specs. All four W1 tests pass — 2.7s + 2.2s + 3.4s + 7.4s = **15.7s**.
`e2e-ci-wiring` guard 10/10. Turbo gate 4 tasks, **0 cached**, 0 errors, and no
warning in any file this wave touched.

Both leg reds are environmental and neither is in a file this wave touched.
`rs012-solo-signup-pool` needs `CRON_SECRET`, confirmed unset in the label env
by direct check. `scorepad-v3-tennis-mtb` printed `Expected: 24 / Received: 23`
*above* `Test timeout of 300000ms exceeded` and ran 306.9s against a 300s
budget — a blown budget reporting itself as a data defect, misleading line
first.

**Gap, stated rather than papered over:** W0 was folded into W1 and the
baseline-measurement step went with it. W1's own cost is known precisely; a
true before/after leg delta was never taken. The delta is *bounded* by 15.7s
because the leg's wall clock is pinned by one 306.9s test — but a bound is not
a measurement.

## What W1 proved about the method

Four defects were found in the **plan**, none in the implementers' work: the
`fullyParallel` premise, an unarmed `borrowedOrgId` that would have made the
cleanup backstop a no-op, an assertion ordered before its cleanup, and an
untested upper boundary. Every one was caught by a review, and every one would
have shipped a green suite that proved less than it claimed.

Five traps found here are recorded in memory because they generalise past this
programme:

- On a Playwright **timeout**, `try/finally` never runs — the frame is not
  unwound. `afterEach` is honoured. Prior art existed at
  `billing-states.spec.ts:14-28` and had never reached `AGENTS.md`.
- **`page.route` is consulted on the initial navigation only**, never on a
  redirect target. The handler silently never fires and the test passes — a
  green that reads as a proof. Count the fulfils.
- **Adding a boundary row can subtract a mutant kill.** Two positives in a row
  assert nothing; a bounds table is only as strong as its alternation.
- **A URL-only assertion cannot tell a working destination from a 500.**
- **A SHA-256 taken after a run settles drift, not ordering** — hash in the
  same invocation as the run.

## W1 follow-ups — CLOSED in the follow-up wave (2026-09-04)

Branch `feat/settings-w1-followups`. All five items W1 left open are resolved.

1. **F5 — FIXED.** `lib/platform-settings.ts` no longer does `Number(row?.value)`
   on a jsonb column. A row holding jsonb `null`, `false`, `""` or `[]` decodes
   to a JS value `Number()` maps to a *finite, in-range* `0` — it clears the
   `>= 0 && <= 100` guard and is served as a 0% platform cut, overriding the
   `PLATFORM_FEE_PERCENT`/5 fallback that an ABSENT row correctly reaches.
   Reproduced against real Postgres before the fix: `expected +0 to be 11`.

2. **The Critical fix now has a permanent guard — FIXED.** `decodeFeePercent`
   is unit-tested in `src/lib/__tests__/platform-fee.test.ts`: pure, no
   `skipIf`, so it runs in every suite on every machine. Five mutants — bare
   `Number()`, dropped `typeof`, `>=0`→`>0`, `<=100`→`<100`, `null`→`0` — all
   killed. `platform-settings.test.ts` gains the real-Postgres half.

3. **RULING — the decoder lives in a NEW module, not in `platform-settings.ts`.**
   W1's item 3 said to export the predicate from `lib/platform-settings.ts` and
   import it from `e2e/helpers.ts`. That is not possible: that file starts with
   `import "server-only"` and pulls in the db and Redis clients, so importing it
   would drag the app's server runtime into the Playwright process. It lives in
   `src/lib/platform-fee.ts` instead — **zero imports of its own** — and both
   production and the fixture import it from there. Same outcome the item
   wanted (one authority for the rule, two callers); different address. Cost if
   wrong: one more small module in `lib/`.

4. **F4 — FIXED, and it was a live customer defect, not the "nil impact" shim
   nit W1 recorded.** See "False premises found" above. `/settings` now forwards
   the whole query, exactly as its three siblings do. The e2e test drives TWO
   outcomes (`taken`, `success`) and asserts each renders its own banner and not
   the other's, because one row is satisfied by a shim forwarding a constant and
   by a banner ignoring the value — both the same class of defect as the one
   fixed. Expected copy is read from `en/ui.json`, not retyped.

5. **i18n of the admin strings — CLOSED, no change.** Owner ruled `/admin` is
   staff-only and stays English-only (see the ruling above).

Still owed, smaller, and genuinely W2's: `borrowedOrgId` should become a
`Set<string>` (`billing-states.spec.ts` already has the idiom) before any test
borrows on two orgs; the per-test restore PUT writes a
`platform_fee_default_set` audit row, which constrains any future audit-trail
assertion; and two comments state the Redis staleness argument as observed when
it was only reasoned (the leg runs with no Redis, so it is unmeasurable there).

The Playwright/`page.route`/mutation traps listed above are being carried into
`AGENTS.md` by the owner, out of this session — deliberately not edited here,
because a shared instruction file taking concurrent edits from two sessions is
how a rule gets half-written.

## Session status — 2026-09-04 (handoff)

**W1.5 is complete, verified, and DELIBERATELY UNMERGED.** Owner chose "keep the
branch as-is" when offered push+PR / merge / keep. Do not push or merge it
without asking them again — that choice is theirs and does not carry forward.

- Branch: `feat/settings-w1-followups`, worktree
  `.claude/worktrees/settings-followups`, based on `d41b92ab0` (PR #712 merge).
- Commits (8 — this list goes stale, `git log --oneline d41b92ab0..HEAD` is
  the authority): `fb0100bc3` (F5 + F4 + the first guard), `106f78f25` (README),
  `287f127ec` / `f07ecae70` / `daf4813e8` / `e0df94c05` (this handoff record),
  `f2c937143` (tennis-mtb budget), `8f9cb53dc` (the review's findings — two
  further money paths, the CI-running seam guard, and a rebuild of the tennis
  budget this branch itself got wrong).
  Working tree clean.

### What was actually proven, and how

Not "tests pass" — the specific evidence, so a fresh session does not re-run it:

| Gate | Result |
|---|---|
| Full `apps/web` vitest | 13,708 passed / 13,786, every suite path under this worktree |
| The 4 reds in it | `schedule-build-honours-locks.test.ts` — **environmental**, 12/12 once the CP-SAT placement service was up. Re-proven this session, not taken from memory. |
| `settings-admin.spec.ts` vs a prod build | 5 spec tests green, + the 2 `setup` auth tests = 7 reported. The file itself has 5; earlier notes said "7/7" without saying that. |
| F4 mutant (pre-fix shim, rebuilt and re-run) | **Killed** — the new test red, the PRE-EXISTING redirect test still green. That pair is the finding: W1's own suite could not see F4. |
| `decodeFeePercent` mutants | **4 distinct kills, not the 5 first recorded.** Killed: bare `Number()`, `>=0`→`>0`, `<=100`→`<100`, `null`→`0` — each with `numTotalTests` held at 4, so none is a collection failure wearing a kill's clothes. The fifth, labelled "dropped `typeof`", did not drop it: it ADDED coercion, which is the bare-`Number()` mutant again. A true drop of either clause is an EQUIVALENT mutant — measured over 18 hand-picked values, zero behavioural differences either way, because `Number.isFinite` does not coerce (so `typeof` is redundant) and the 0..100 bounds already reject `NaN`/`±Infinity` (so `Number.isFinite` is redundant). Unkillable by definition. The clauses are kept for readability; the COUNT was inflated. |
| `platformFeeDefault` seam mutants | 2/2 killed, no DB — reverting the call site to `Number(row?.value)`, and `envFallback` to `?? "5"` (`platform-fee-seam.test.ts`). |
| F5 vs real Postgres | Reproduced against the pre-fix decode: `expected +0 to be 11` |
| tsc, eslint | clean, exit 0 |

**A worktree trap worth the next session's time:** this worktree had no root
`node_modules` and produced 22 tsc errors (`Cannot find module 'pino'`, then a
cascade of TS7006) that `main` did not have. They are not defects. `pnpm install`
— not `npm install`, which fails on `workspace:` protocol — cleared all 22.

### The full local e2e run — RESULT

Ran `parallel`, `walkthrough`, `serial`, 5 mobile widths, 2 tablet against the
prod build on the `swf` label (`gallery` skipped — capture harness, no CI job).
**709 passed, 38 failed, 125 skipped.** Then triaged by RE-RUNNING, not by
reading the error text:

| Cluster | Was | After re-run |
|---|---|---|
| Optimiser — `data-status="solver_unavailable"` | 10 red | **12/12 green** |
| Scoring — `core.start` ledger empty | 5 red | **39/39 green** |
| `competition-desk` (ECONNRESET), `player-accounts`, `rs011`, mobile-320/360 | 6 red | **green** |
| Stripe — `event-pass` + `payments-hardening` | 16 red | cannot close here |
| `rs012` — `CRON_SECRET` | 1 red | cannot close here |
| `ai-architect`, `partial-amend` ×2, `tennis-mtb` | 4 red | preconditions absent |

**None of the 38 was attributable to W1.5.** Its blast radius is the
platform-fee decode and the `/settings` shim; `settings-admin.spec.ts` passed
7/7 INSIDE the failing run, and both money specs fail on preconditions
(`needs a Stripe TEST key in STRIPE_SECRET_KEY`; a signed webhook answering 400)
before any fee arithmetic executes.

**Two of those 38 were caused by how the environment was built, and that is the
reusable lesson:**

1. **The server must be started AFTER the placement service, or restarted once
   it is up.** `seazn-env up --label X --server` then a later
   `up --label X --placement` leaves the already-running standalone server with
   no `PLACEMENT_SERVICE_HOST`, and ten tests fail asserting the real optimiser
   ran. `seazn-env rebuild --label X` fixes it. Bring it up as
   `up --label X --all` instead.
2. **`--workers=4` against one standalone server saturates it.** The symptom is
   not a timeout message — it is `apiRequestContext.fetch: read ECONNRESET` in
   one spec and an EMPTY EVENT LEDGER in five others, which reads exactly like a
   scoring defect. All five passed at `--workers=2`.

**Not verifiable on this machine, and not defects:** `STRIPE_SECRET_KEY` /
`STRIPE_WEBHOOK_SECRET` (17 tests between Stripe and the webhook signature),
`CRON_SECRET` (1), `SCHEDULING_AI_BASE_URL` + `ANTHROPIC_API_KEY` (ai-architect).
`partial-amend` is load, settled: all four of its tests pass at `--workers=1`
in **16-29s each** against a 180s budget.

**`tennis-mtb` is NOT load, and this is a real finding — F6, owed to whichever
wave owns that file (R4/MTB, #670), not to this programme.** Run alone, at
`--workers=1`, on an idle machine, it took **307.4s** against
`test.setTimeout(300_000)` (`scorepad-v3-tennis-mtb.spec.ts:142` **on `main`** — cite the symbol, not the line; this branch moved it). W1 measured
306.9s. Two measurements, two sessions, both over the line by ~2.5%: it is
reproducible, not flaky, and "it passed in CI" only means CI's runner is
fractionally faster than this one.

**That last sentence was wrong, and the correction matters.** CI does not pass
because its runner is quicker: `e2e.yml` pins
`NEXT_PUBLIC_SCOREPAD_HOLD_MS: "3000"` at job level, a QUARTER of the product
default this machine runs at. CI was never near the ceiling. Believing the
"faster runner" story is also what let the first fix ship with a `300_000`
floor that made the whole derivation inert in exactly that band.

The budget is a FLAT LITERAL beside a cost derived from `HOLD_MS` and the tap
count — exactly AGENTS.md failure class 20 ("a flat timeout beside a derived
cost is a latent red"). Its own sibling `scorepad-v3-partial-amend.spec.ts:50`
already derives its budget from the hold and says so in a comment. The fix is
to adopt that pattern here, so moving `HOLD_MS` moves this budget with it.

**FIXED — `f2c937143`, on this branch, after the owner asked for it.** The
paragraph above originally said this was deliberately left alone as another
programme's file; the owner then said to proceed, so it ships here. A reviewer
of `feat/settings-w1-followups` will therefore find one commit touching a spec
that has nothing to do with settings — that is intentional, and this is the
record of why.

The budget now derives from the constant:
`Math.max(300_000, 120_000 + TAPS * (HOLD_MS + 1_500))` — 444s at the default
12s hold. Verified by running it: **310.6s, passed**. That third measurement
(after 306.9s and 307.4s) is also the strongest evidence the old ceiling was
wrong, since all three sit above 300s while the machine was idle and
`--workers=1`.

**The generalisable half, for whoever meets this next:** distinguishing a real
budget overrun from load costs one run. Run the spec ALONE at `--workers=1`.
Load shows up as a huge margin — `partial-amend`, same family, same soft-commit
tax, came in at 16-29s against 180s. A real overrun lands just past the line,
repeatedly. Reading the error text cannot tell them apart, because a blown
budget prints whichever `expect.poll` was in flight and reports itself as a
DATA defect ("Expected: 24 / Received: 23").

**A method note worth keeping:** `ps eww -p <pid>` returns NOTHING on this
machine — zero env vars, for any process. An empty result there is not evidence
the process lacks a variable. This session briefly reported "confirmed, the
server has no placement env" on that empty output. The question was settled by
re-running the spec, which is the only thing that could settle it.

### W2 — not started, deliberately

Owner said "hold W2". Nothing is written, planned, or scaffolded for it. Its
scope is unchanged in the design doc: `/o/{org}/settings` 7 tabs, drive+persist,
sponsors CRUD half only, 2 specs.

