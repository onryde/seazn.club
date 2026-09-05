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
| W2 | `/o/{org}/settings` 7 tabs — drive+persist (sponsors CRUD half) | **MERGED** — PR #720, squashed to `997ad225b`, all 11 CI checks green |
| W3 | `/o/{org}/settings` 7 tabs — gating matrix + first mutation sweep | **IN PLANNING** — see the W3 section below |
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
6. **The ≤60s budget HOLDS; W3-W8 restructure to fit it** (2026-09-05). Put to
   the owner with the measurement — W2 spends ~30s of a 60s programme ceiling
   and W3-W8 cover more surface — and the owner ruled for the recommendation:
   restructure the later waves rather than raise the ceiling. Concretely that
   means the gating matrix and every case that does not need a rendered page
   move to `APIRequestContext` with no browser, per `_RULES.md` §5.4, and a
   browser round trip has to earn its place. The ceiling is what has kept
   these specs from becoming the slow leg; it is not negotiable in W3.
7. **Finding E and F8 are fixed now, not deferred** (2026-09-05). Owner ruled
   on the recommendation to close both rather than carry them: the hardcoded
   English in `org-switcher.tsx` is on a customer-facing row, and an
   api-keys test that may be exercising the session instead of the key is
   coverage that reads as protection and is not.

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

**And the rebuild can MOVE the port** (stw2 went 3314 → 3315), which brings
two more failures:

- The OLD server may keep the OLD port, serving the DELETED bundle: health
  200, new `BUILD_ID`'s manifest **404**. A run there does not fail — it
  exercises PRE-FIX code and reports the fix as still broken. The orphan is
  invisible to `seazn-env status`; only `lsof -nP -iTCP:<port> -sTCP:LISTEN`
  sees it.
- **A port change silently invalidates `e2e/.auth/*.json`.** Playwright's
  storageState holds localStorage **origin-scoped, and the origin includes the
  PORT**; cookies are only domain-scoped. So the SESSION survives the move —
  logged in, 200s, right BUILD_ID — but the `seazn_cookie_consent` keys
  `auth.setup.ts:53-65` pre-writes are lost. The consent banner then renders
  everywhere and, at narrow widths (`fixed bottom-4 left-4 right-20 z-40`),
  **intercepts pointer events**: a click times out on whatever is under it.
  Seen as `RS009: the assign sheet holds at this width` failing with a 60s
  `locator.click` timeout — a test unrelated to the change under test.
  Fix: re-run `--project=setup` (3.5s).

**`--no-deps` makes that last one PERMANENT** — it is exactly what stops the
setup re-minting the state. This wave circulated `--no-deps` as a workaround
for a "red Community leg" in `auth.setup.ts`; that leg was not red, it was
this artifact, and the advice was retracted. A post-rebuild checklist is three
items: manifest probe, `lsof` the old port, and re-run setup if the port moved.

### A `mobile.spec.ts` sweep run beside a walkthrough leg reds on OTHER tests

Cost four sweeps on 2026-09-05. Three consecutive runs failed on three
DIFFERENT tests, none related to the change under test — `RS009` (assign
sheet), then portfolio panels P1/P2/P4, then `RS012` (pool summary banner) —
and every one cleared on re-run with nothing changed. Cause: shared-state
churn from a concurrent walkthrough run, confirmed by another task's artifacts
sitting in the same `test-results/` directory mid-sweep. `/o/{slug}/c/new` was
also checked directly and renders `template-gallery` fine (200, count 1), so
the portfolio red was never a live defect.

**Anyone sweeping the width matrix while a walkthrough leg runs will get a red
that looks like a product defect and is not.** Re-run before reporting one.
Failure class 8, three times in one afternoon.

### The phone fix, measured before and after

Name box, 320→430: **6→182, 46→222, 61→168, 76→183, 116→223**. It WRAPS rather
than compresses — row height 44→94, `sameLine` false at all five phone widths.

**Not monotonic, and worth knowing before anyone tunes it:** 375 lands LOWER
(168) than 320 (182), because at 375 the badge still fits on line 1 and takes
57+12 from the name, while at 320 it wraps away. Both clear the 140 floor, but
the floor is not a soft margin at 375 — a change that looks safe at 320 can
breach it at 375 first.

**≥768 proven byte-identical, measured not asserted:** 768 → 478/246/44, 834 →
544/312/44, 1280 → 734/502/44, every figure the same before and after. Control
set 33 controls, identical membership, order and repeats at all eight widths.
A composition, not a groomed shrink. Full sweep: **289 passed, 5 skipped, 0
failed** across all seven projects, every run a total with zero "did not run".

### `flex-wrap` does ALL the work — `basis-40` alone buys NOTHING

Proven by mutation on 2026-09-05, and it cuts against the natural reading of
the fix. Dropping `flex-wrap` (leaving `basis-40 md:basis-0` and
`md:flex-nowrap` untouched) put the name box back to **6px** — identical to
the original defect, not the ~46px predicted. The badge absorbed nothing: it
sat at its min-content 57px exactly as before, so the name took the entire
154px of overflow alone. Under `nowrap`, a 160px basis with `flex-shrink: 1`
collapses straight back to 6.

**So anyone who later "simplifies" this by keeping the basis and dropping the
wrap lands back on the exact original defect.** Both classes are load-bearing
and neither is decoration.

The mutant also proved the `expect.soft` change: one test reported TWO
independent errors in one run — the width floor (`Expected: > 140 / Received:
6`) and the composition (`tops 252,256,264,255` — four children on one line,
no wrap anywhere). On the original red only the width half ever spoke, because
a hard first expectation aborted the test. `tablet-768` stayed 41 passed / 0
failed, so the mutation is a genuine no-op above `md`.

The composition half is therefore **runner-witnessed red**, not merely
evidenced — the earlier "evidence, not witnessed" caveat no longer applies.

### An empty `git status --porcelain` is meaningless if the pathspec missed

Nearly produced a false clean-tree signal. `git status --porcelain -- apps/web/...`
run from INSIDE `apps/web` resolves to `apps/web/apps/web/...`, prints
`warning: could not open directory` and `fatal: pathspec did not match any
files` — and the empty result reads exactly like a clean tree. Caught on the
fatal line, but the shape is nasty: **a pathspec that matches nothing produces
the same empty output as a tree with nothing to report.** Same family as the
empty-grep-from-wrong-cwd trap. Run it bare from the worktree root, or confirm
the pathspec resolved before believing the silence.

### An HTML grep for dictionary copy CANNOT see a banner — it passes in every state

The dictionary is serialised into the page payload, so `settings.emailChange.*`
copy is present in the HTML of **every** settings tab regardless of the
`email_change` param. A grep of the served HTML for the banner's text matched
the mutant URL, the control, **and** a page with no `email_change` param at
all. It is a probe that cannot fail.

Settled at the DOM instead, against the live mutant build:

| URL | banner |
|---|---|
| `?email_change=invalid` (tab dropped) | `visible=false count=0` |
| `?tab=account&email_change=invalid` | `visible=true count=1` |

Same family as this repo's existing rule that assertions on a Next HTML body
must anchor on `="`, because React serialises an omitted prop as
`"$undefined"` — a bare probe passes in both states. Copy in the payload is
the same shape of lie one level up.

### The email-change mutants — what each proves about a PERSON

Both killed, both by two independent tests (one signed in, one arriving cold
from a mail client, which is the population that actually meets this link).

- **A** (`email_change=invalid` → `nope`): a changed outcome string is caught.
  `nope` fails the page's whitelist, `emailChangeMessage` goes null, and the
  banner silently does not render — the person who clicked a dead link is told
  nothing. **The three hand-typed tests this task replaced would all have
  stayed GREEN**, because they typed `email_change=invalid` themselves and
  never asked the route what it emits.
- **B** (drop `tab=account`): the outcome arrives INTACT but lands on the
  organization tab (`page.tsx:119` falls back to `"organization"` for an
  absent or unknown tab), where the banner block is never rendered. A correct
  answer delivered to a page that never displays it — **F4's original defect
  exactly**.

Caveat kept on the record: both tests died on the URL assertion, which runs
first, so the banner assertion never executed. The kill proves the URL
contract; the user-facing claim above was settled separately, at the DOM.

### W2 findings from driving the tabs

**F8 — `e2e/api-keys.spec.ts:30` may not be testing the key at all.**
`playwright.request.newContext()` **inherits `use.storageState`**, the same
trap as a bare `browser.newContext()`. That spec's "the minted key works" 200
is therefore possibly the signed-in Pro SESSION answering, not the key. Found
by Task 3 while writing its own anonymous request and hitting the same
inheritance. Not fixed here — it is another spec's file and outside W2's
scope — but it means the existing api-keys coverage is unproven in the one
direction that matters. **Assign at the W2 boundary or W3.**

Two of the plan's own premises were also false, corrected in comments where
they are used rather than worked around silently:

- **`GET /api/users/me` returns only `{ id, org }`** — no `display_name`,
  `timezone` or `locale`.
- **`src/app/api/orgs/[id]/route.ts` exports PATCH only.** The plan's
  `apiJson(request, "/api/orgs/{id}")` persistence read is a **405**, not a
  read. Both Task 2 and Task 3 must read the column instead.

**A pinned API key 403ing on `GET /api/v1/competitions` is BY DESIGN** —
`src/server/api-v1/key-scopes.ts:47`, "a pinned key is 403 on rules without
one". Task 3 turned that into the assertion proving the pin took effect
rather than filing it as a defect.

### F9 — pre-auth existence oracle in `requireResourceAuth` (NOT fixed; owner call)

Found while closing F8. **Verified in the tree by the controller, not taken on
report.** `requireResourceAuth` (`apps/web/src/server/api-v1/auth.ts:352-360`)
resolves the resource BEFORE authenticating:

```ts
const orgId = await resourceOrg(kind, id);   // unfiltered read, throws 404
return requireOrgAuth(req, orgId, scope);    // auth happens AFTER
```

and `resourceOrg` (`:342-349`) runs `select org_id from <table> where id = $1`
with **no tenant filter**, throwing `HttpError(404)` when the row is absent.

So an **unauthenticated** caller gets **404 for an id that does not exist** and
**401 for one that does — in any org**. That is a cross-tenant existence
oracle, reachable with no credentials, on **120 route files**.

**Honest severity: LOW, and it should not be overstated.** The ids are
UUIDv4 (122 bits), so nothing is enumerable — this is not a scanning
vulnerability. What it does leak is confirmation for a caller who ALREADY
holds an id: a leaked log line, a shared URL, an ex-employee's bookmark. They
can confirm the resource still exists, and that it exists somewhere in the
platform, without any credential.

**Not fixed here, deliberately.** The blast radius is every `/api/v1` resource
route, and the fix has a real behavioural trade-off — authenticating first
turns today's 404 into a 401 for absent ids, which is the correct shape but
changes responses that clients and tests may depend on. `api-keys.spec.ts`
already carries a comment about "the pin adds no existence oracle" that
concerns a LOWER layer and does not cover this one.

**Owner call needed:** fix it in W8's fix wave, or open it as its own piece of
work. It is not a settings-walkthrough defect and should not be absorbed
silently into one.

### The whole-branch review earned its keep — one live red, one false claim

Run after every task was green and the wave gate had passed. Failure class 8
("green and pushed is not done") again, and this time it caught a defect that
would have reached `main`.

**CRITICAL, fixed (`02900f979`): `e2e/org-less-destination.spec.ts` test 2
could never have passed.** Logging in with no `next` makes `postAuthLanding`
auto-provision an org via `ensureActiveOrg`. Community `orgs.max_owned` is
**1** (`db/migration/deltas/V112__entitlements_v2.sql:23`, confirmed against
the live catalog — unchanged by V314), so the create under test was that
account's SECOND org: `assertMayOwnAnotherOrg` computed `1 + 1 > 1` and threw,
`CreateOrgForm` called `setError` instead of `router.push`, and the URL
assertion timed out at 30s. The spec's own comment — "this account is
therefore NOT org-less, which is fine" — was the false premise. **The file
lands in the `parallel` project, which runs on the merge to `main`**, so it
would have reddened CI. It is the one spec this wave shipped without ever
running; written, reasoned about, committed, and wrong.

Now signs in with `next=/dashboard`, honoured WITHOUT provisioning, so the
account stays org-less and the create is its first. First ever run: **4
passed (9.1s)** — which also closes the gap Task 6 recorded, since the
redirect chain is now proven end to end rather than merely plumbed.

**A CLAIM IN THIS RECORD WAS WRONG.** Finding E was reported as keeping the
English values byte-identical. It does not: the popover role badge moved from
raw `{o.role}` to the catalog, so a user sees `Owner`/`Admin` where they saw
`owner`/`admin`. Nothing selects on it — `org-switch.spec.ts:55` and
`org-management.spec.ts:39` both use the aria-label — so nothing breaks, but
the copy changed and it was not flagged. Recording it because an unflagged
copy change is how the next session's selector assumption goes stale.

**Confirmed by the review, against the tree:** the `next` contract is
reachable and not an inert seam; `safeNextPath` is untouched and reused at
both ends, reach exactly one new caller, **no widening and no security
regression**; `grow basis-0` ≡ `flex-1` so ≥768 really is byte-identical and
`org-identity-name` has no collision; every shared borrow restores in an
`afterAll` and the profile restore is itself verified.

**Recorded, not fixed** — both are follow-ups, neither is a W2 defect:

- **The shared Pro user now sits at 5 of 5 org slots** (pro base +
  `org-management` + three W2 files). A Playwright worker restart after a red
  re-runs `beforeAll` and seeds again; the sixth create would 402. Plausible,
  not observed. This is finding B's cap biting for real, and it is the
  strongest argument for W3 moving to the API-only pattern.
- `e2e/api-keys.spec.ts:41-46` creates a competition in the shared Pro org
  every run and never deletes it — unbounded row growth in the account every
  leg signs in as.

### W2 result — measured, not asserted

All five tasks closed. Wave gate run by the controller, not by a task.

| Gate | Result |
| --- | --- |
| `walkthrough` project, whole leg, 4 workers | 43 passed / 5 failed — **all 19 settings tests green**; every failure explained below |
| `mobile.spec.ts`, all seven width projects | **289 passed, 5 skipped, 0 failed**, zero "did not run" |
| `apps/web` vitest, JSON reporter | **13,760 / 13,828 passed, 0 failed, 0 suites failed**; paths confirmed inside this worktree |
| lint + typecheck (`turbo`, 0 cached, so actually run) | 0 errors, 139 warnings — **none in any file this wave touched** |

**The five walkthrough failures, each settled by re-running rather than
assumed.** Four — `scorepad-v3-r7-console-chrome` ×3 and
`scorepad-v3-tabletennis-match` — passed in isolation (25.2s/25.4s/25.6s and
green), so they are the contention effect recorded above. The fifth,
`rs012-solo-signup-pool:264`, fails in isolation too and says why:
`CRON_SECRET env var required to drive /api/cron/registrations`. A missing
local secret, self-reported by an explicit throw rather than a timeout — which
is how an environment fault should announce itself.

### Speed budget — W2's cost, and a warning for the rest of the programme

W2 adds **12 new walkthrough tests, 108.1s serial, ~27s wall-clock at 4
workers**, plus Task 5's measured **+3.3s** on the existing `settings-admin`
file. Call it **~30s of leg time**.

**The programme budget is ≤60s TOTAL across all eight waves.** W1 has already
spent some of it and W2 spends about half of what remains. W3-W8 cover more
surface than W2 did — the gating matrix, competition settings, two division
surfaces and a fix wave. **On this trajectory the budget will be exceeded,
probably by W5.**

That is a finding for the owner, not something to quietly absorb: the budget
was an explicit ruling ("walkthroughs must be optimized and fast"), and the
rule beside it says a wave that blows it gets restructured rather than the
budget raised. The choice — restructure the later waves, or revisit the
ceiling — belongs to the owner and should be put to them before W3 starts.

### Machine note

The box was carrying seven seazn-env labels at load 269 and OOM-killed a
production build (exit 137) on 2026-09-05. Six were other sessions'. A wave
that needs builds should check `seazn-env status` and the load first — and
`up --all`, never `up --server` then `up --placement`, or the server starts
without `PLACEMENT_SERVICE_HOST` and ten scheduling tests fail as
`solver_unavailable`.

## W3 — IN PLANNING (2026-09-05)

Worktree `.claude/worktrees/settings-w3`, branch `feat/settings-w3-matrix`,
based on `997ad225b` — main WITH W2 merged. Env label **`stw3`**.

**W2 is CLOSED.** Everything above is either shipped or recorded as a
follow-up below. Do not re-derive it.

### Scope

The gating matrix across all seven `?tab=` panels, plus the programme's first
mutation sweep. Design-doc cases **5-9** (UI-only gating; entitlement
transitions) and **11-14** (ownership and last-actor), the latter being the
ones W2 deliberately excluded as irreversible against the shared Pro user.

### The owner rulings that bind this wave

1. **The ≤60s budget HOLDS; W3 restructures to fit it** (ruling 6 above).
   The matrix runs on `APIRequestContext` with **no browser**; a browser round
   trip has to earn its place. This is not a preference — W2 spent ~30s of the
   60s programme ceiling and six waves remain.
2. **Subagent dispatches use Opus 5** (ruling 5).

### Three constraints carried in from W2 — read before seeding anything

1. **The shared Pro user is at 5 of 5 org slots.** Pro base +
   `org-management`'s second org + three W2 spec files. `assertMayOwnAnotherOrg`
   bounds a PERSON, and `auth.setup.ts:96` lifts the cap to 50 via an
   override — but that override is on the SETUP org, so read it rather than
   assume it still applies to whatever W3 seeds. A worker restart after a red
   re-runs `beforeAll` and seeds again.
2. **`setEntitlementOverrideSql(orgId, featureKey, intValue)` is the matrix's
   tool**, not `setOrgPlanBySql`. Org-scoped, parallel-safe, and the right
   granularity per feature (`dashboard.branding`, `sponsors.tiers`,
   `sponsors.monetize`, `api.access`, `news.auto`). A plan flip is only for
   case 7's genuine Pro→Free transition, and needs the group split first.
3. **A fresh org is COMMUNITY** (`createOrgForUser` opens its own
   `plan_key='community'` subscription), so a "this is gated on Free"
   assertion on a fresh org can pass vacuously. Every negative assertion in
   the matrix must be shown to redden when its guard is mutated — that is what
   `_RULES.md` §1 exists for and it is the whole point of a gating wave.

### Follow-ups W2 recorded and did NOT fix — decide their wave

- **F9: pre-auth cross-tenant existence oracle** (`requireResourceAuth`
  resolves the resource before authenticating; 404 for an absent id, 401 for a
  real one, across 120 route files). Severity LOW — UUIDv4 ids are not
  enumerable. **Owner ruled it becomes its own work item, NOT a settings
  fix.** Do not absorb it into W3.
- `e2e/api-keys.spec.ts:41-46` creates a competition in the shared Pro org
  every run and never deletes it — unbounded row growth.
- `ROLE_BADGE` in `org-switcher.tsx` still has no `scorer` entry.

### Environment note

`pnpm install` and `seazn-env up --label stw3 --all` were kicked off at
kickoff; check `/tmp/stw3-install.log` for `EXIT=0` and `/tmp/stw3-env.log`
for `ENV_EXIT=0` before running anything. A fresh worktree has **no
`node_modules`** — the first W2 build failed for exactly that reason.

**The post-rebuild checklist is three items, and W2 paid for all three:**
manifest probe against the new BUILD_ID (never `/api/health`, which answers
200 for a DELETED bundle), `lsof` the old port for an orphan still serving
pre-fix code, and **re-run `--project=setup` if the port moved** — Playwright
stores localStorage origin-scoped and the origin includes the port, so a port
change silently voids the cookie-consent flag and the banner then intercepts
clicks. **Never `--no-deps`**: it is what stops the state re-minting.

### W3 finding 1 — the W2 merge reddened the walkthrough leg on `main`, and the
### cause was a live product defect, not a test artifact. FIXED `ad2fe615d`.

E2E run `33968571673` on `997ad225b` (W2's merge commit) failed:
`settings-admin.spec.ts:661` and `:834` both landed on
`/login?next=%2Fsettings%3Ftab%3Daccount%26email_change%3Dinvalid` instead of
the org-scoped account tab. **Both are green locally, at
`--workers=3`, in the full 61-test leg.** That gap is the whole finding.

`confirm/route.ts` built all five of its redirects as
`NextResponse.redirect(new URL(path, req.url))`. **`req.url` is the server's
INTERNAL BINDING, not the address the browser is on.** `lib/oauth.ts:25-26`
already says exactly that — "Behind a reverse proxy (Fly.io), req.url is the
internal binding (http://0.0.0.0:3000)" — which is why the OAuth routes go
through `baseUrl(req)`. This route never did.

CI starts the standalone server with **no `HOSTNAME`** (`e2e.yml:527`) and Next
standalone defaults to `0.0.0.0`, so the Location read
`http://0.0.0.0:3000/settings?…` while the browser sat on
`http://localhost:3000`. The browser withholds the session cookie across that
origin hop, `/settings` finds no session, and the confirmation lands on
`/login`. Locally `seazn-env` binds `127.0.0.1` and `req.url` reports
`localhost`, the origins match, and the identical code passes.

Reproduced directly rather than inferred — a standalone server started with
`HOSTNAME=0.0.0.0` answers:

```
location: http://0.0.0.0:3399/settings?tab=account&email_change=invalid
```

**This is a live customer defect.** Behind any reverse proxy every email-change
confirmation sends the user cross-origin, and the SUCCESS outcome does it
*after* the new address has already committed — the user is bounced to a login
screen by the link that worked.

**`baseUrl(req)` is NOT the fix.** With no proxy there is no
`x-forwarded-host`, so it falls back to `new URL(req.url).origin` and
reproduces the same binding. The fix is a **relative** Location, which has no
origin to get wrong: the browser resolves it against the URL it requested.

Three rules follow, and the third is the one that let this ship green:

1. **A route-handler redirect built from `req.url` is a latent cross-origin
   bounce.** Grep for `new URL("/…", req.url)` before adding another.
2. **An origin difference is invisible to a `pathname + search` assertion.**
   Both banner tests compared exactly that, so an absolute Location satisfied
   them whenever the browser happened to be on that host — which it is,
   locally. The guard added at `settings-admin.spec.ts:943` pins the exact
   RELATIVE string with `maxRedirects: 0`; following the redirect is precisely
   what erases the evidence, since the landing URL is identical either way.
3. **`localhost` vs `0.0.0.0` is a REAL environment axis this repo's local
   harness does not cover.** Local seazn-env pins `HOSTNAME=127.0.0.1`
   (`seazn-env.sh:521`); CI pins nothing. Any redirect, absolute asset URL or
   cookie-domain behaviour can differ between them, and the local leg cannot
   see it. When CI reds on a hop the local leg passes, check the binding
   before checking the code.

Witnessed both ways: the new guard **fails** against the pre-fix server
(1 failed / 9 passed) and passes after the rebuild.

### W3 finding 2 — `_RULES.md` §2's premise is FALSE against current `main`

`_RULES.md` §2 and design §3 trap 3 both say "`POST /api/orgs` creates an org
that joins its creator's **existing** billing group", and derive from it the
"split the group first" ceremony. **`createOrgForUser` mints its own community
group per org** — `auth.ts:292-330` inserts a fresh `subscriptions` row inside
the create transaction, and the doc comment names the history: "Individual by
default (#212): every new org mints its OWN community group. The old auto-join
(V309) dropped a user's second org onto their first group; that is now opt-in."

Consequence for the matrix: `setOrgPlanBySql` on a **freshly created** org is
group-scoped to a group containing only that org, so it cannot drag the shared
Pro org. The split ceremony is harmless but unnecessary on that path. The rule
still holds for any org attached to a group through `attachOrgToGroup`.
`settings-support.ts:88-95` already documents its own split call as a retained
no-op for the retired V309 shape.

### W3 finding 3 — the shared Pro user's org cap is 50, not 5

The W3 kickoff above carries "the shared Pro user is at 5 of 5 org slots" from
W2. Verified against the tree: `assertMayOwnAnotherOrg` takes
`limit = Math.max(...limits)` over `orgs.max_owned` for **every** owned org
(`auth.ts:245-254`), and `auth.setup.ts:96` writes an
`orgs.max_owned = 50` override onto the first org `GET /api/orgs` returns. So
the effective cap is **50**, against roughly twenty orgs created across the
suite. Two caveats that keep this from being a licence to seed freely: the
override is attached to ONE org and nothing re-attaches it if that org is ever
released, and `owned` counts by `org_members.user_id` with **no `deleted_at`
filter** (`auth.ts:224-226`) — a soft-deleted org still occupies a slot, so
only `releaseSeededOrgSql`, which deletes the membership row, actually returns
one.

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

