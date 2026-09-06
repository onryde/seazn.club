# Directory walkthroughs — design

Date: 2026-09-03 · Surface: `/directory` (`apps/web/src/app/directory/page.tsx`)
Folder: `apps/web/e2e/walkthrough/` · Project: `--project=walkthrough`

## 1. Problem

`/directory` is where an organiser builds the org's people, clubs, officials and
venues. It has four tabs (`page.tsx:28` — `players`, `clubs`, `officials`,
`venues`) and **no walkthrough**. What exists is per-slice and mostly
API-driven:

| spec | what it covers | what it never does |
|---|---|---|
| `officials-directory.spec.ts` | add/list/edit/delete an official, role chips | — |
| `venues.spec.ts` | ONE venue, ONE court, tags, archive | never a second court; never proves the calendar reaches a consumer |
| `person-merge.spec.ts` | merge a *suggested* duplicate, undo | never creates the duplicate through the UI; never proves a NON-duplicate is suppressed |
| `directory-labels.spec.ts` | the tab says "Players" | — |
| `clubs.spec.ts` | club hub journey | the club is seeded by API, not created through the New-club form |
| `import.spec.ts` | one CSV, 2 players, commit | never a second file; never a plan limit |
| `invite-claim.spec.ts` | ORG-MEMBER invites (`/api/orgs/{id}/invites`) | **nothing to do with person claims**; fully API-driven |

Nothing anywhere drives: creating a player through the directory form; a
duplicate *appearing* because of what was typed; a claim link being **followed**
by the wrong person; an organiser revoking or unlinking; a court restriction
reaching the scheduler; or an import refused by a plan cap.

That is the exact profile the walkthrough folder exists for — its README's own
test is "would failing halfway through this be invisible to every test that
asserts on code?" For all six, yes.

### 1.1 A finding, recorded before it is built on

`POST /api/v1/officials/import` (`app/api/v1/officials/import/route.ts:7` →
`usecases/officials.ts:278 importOfficials`) has **no `requireFeature` and no
`withinLimit` call** in either the route or the usecase, and never consults
`import.bulk`. Every other import path is gated (`imports.ts:122,301,429`). It
is API-only with no UI, which is why it has not been noticed.

This design does **not** fix it — that is a separate change with its own tests.
It is recorded here so the next session does not read the gate's absence as
intentional. See §8.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Folder | `apps/web/e2e/walkthrough/` | Auto-selected by `testMatch: /[\\/]e2e[\\/]walkthrough[\\/]/`. No config edit, no CI edit. |
| Count | **Four specs**, one per journey | A red leg should name its own subsystem. Owner-chosen 2026-09-03. |
| Shared kit | `apps/web/e2e/directory-kit.ts` — **NOT** under `walkthrough/` | `WALKTHROUGH` matches *any* file in that folder, so a helper placed there is selected as a spec and Playwright rejects it (`should not import test file`). `rs007-money-kit.ts` and `scorepad-a11y-kit.ts` already sit in `e2e/` for this reason. |
| Court restriction | Assert the conflict is **raised and advisory** | `outside_court_hours` is deliberately excluded from `isBlockingConflict` (`calendar.ts:330`, `build.ts:1729`). Asserting the placer *avoids* the window would freeze a wrong expectation. Owner-chosen 2026-09-03. |
| Role gate | Prove **both** sides | An entitlement asserted only on the allowed side is untested. Owner-chosen 2026-09-03. |
| Limit values | **Read live, never hardcoded** | The live plan catalog differs from the migrations (v18 retired `business` and `plus`). A test carrying `clubs.max = 5` asserts yesterday's catalog. §6.2. |
| Blocking | The four claim **refusals** | There is no person/user blocking feature in this codebase — the only `block` symbols are competition discovery. §3.2. |

## 3. What the product actually does

Re-pinned against `main` @ `70acb866a` on 2026-09-03. Every line below was read,
not grepped.

### 3.1 Duplicate suggestion (`server/usecases/person-duplicates.ts`)

Computed live on every read of the Players tab (`page.tsx:106` fetches
`listDuplicateCandidates` beside `listPersons`). A shared normalised name is the
entry ticket (`SCORE_NAME = 1`); `SCORE_DOB = 2` and `SCORE_SHARED_ENTRANT = 1`
raise the rank. Four rules **suppress** a pair outright rather than down-ranking
it — most importantly **differing non-null `dob`**.

Consequence for the spec: same name + same dob ⇒ a candidate MUST appear. Same
name + *different* dob ⇒ a candidate MUST NOT appear. That negative is the case
that kills a "suggest everything" mutant, and it is the one no existing test has.

The score constants are module-private and the file is `import "server-only"`,
so a spec cannot import them. The spec therefore asserts on **evidence kinds**
(`name`, `dob`) and on **candidate ordering**, never on a hand-typed score.

### 3.2 Claims (`server/usecases/person-claims.ts`, `components/v2/invite-claim.tsx`)

Four refusal paths, all with real UI controls:

**Two of the four refusals below were WRONG as first written.** Both were
corrected by driving the product, and both were then verified independently.
They are kept here with their corrections because the wrong version is the one
a reader reconstructs from the schema.

- **The wrong-email refusal is NOT `assertClaimEmail`.** That was this design's
  claim and it is false. `app/claim/[token]/page.tsx:81` performs its OWN email
  comparison and simply does not render the accept button for a mismatched
  visitor — so `claim-accept.tsx:18` is never reached, `claimPerson` never runs,
  and `assertClaimEmail` cannot execute mismatched on ANY UI path. Mutating
  `assertClaimEmail` leaves the walkthrough green (proven: its throw string was
  dead-code-eliminated from the emitted JS); mutating the page branch kills it.
  The server guard is defence-in-depth, and it is already covered DB-backed at
  `person-claims.test.ts:167` (403 / `CLAIM_EMAIL_MISMATCH`). **Owner ruling
  2026-09-04: accept as-is** — the refusal a real person meets is the page
  branch, and the walkthrough pins that. No API-level spec is owed.
- **A re-invite cannot be minted from the console while one is pending.** The
  row's only verb is then "Withdraw invite" (`invite-claim.tsx:108-132`), so
  `person_claims_open_uq`'s revoke-on-mint has no UI path; reaching it needs a
  second, stale console. The DB guard is unit-covered at
  `person-claims.test.ts:138,440`. **Owner ruling 2026-09-04: record only** —
  a deliberate UI/DB asymmetry, not a gap to close, and withdraw-then-invite is
  a defensible organiser flow.
- **Unlink does not kill a LINK.** `settleClaimRow` (`person-claims.ts:233-238`)
  tests `claimed_at || user_id` before `revoked_at`, and `unlinkPerson:396-399`
  keeps `claimed_at` — so an already-claimed link keeps reading "Already
  claimed" after an unlink. Safe, but not what this design assumed.

So the walkthrough proves **three endings and one refusal**, not "four things
kill it".

| refusal | mechanism | control |
|---|---|---|
| wrong email follows the link | the PAGE's own comparison, `claim/[token]/page.tsx:81` — NOT `assertClaimEmail` | `/claim/{token}` accept page |
| organiser revokes the open invite | `revokeClaimInvite` (`:188`) | `invite-claim.tsx:113` → `DELETE /api/v1/persons/{id}/claim-invites` |
| organiser unlinks a claimed account | `unlinkPerson` (`:386`) | `invite-claim.tsx:94` → `POST /api/v1/persons/{id}/unlink` |
| a re-invite kills the previous link | `person_claims_open_uq` (V276) — one OPEN claim per person | invite again; the first copied link is now dead |

The invite dialog renders the link as **text** at
`data-testid="claim-link"` (`invite-claim.tsx:181`), on the email-send-failure
fallback — which is the normal path in e2e, there being no SMTP. So the spec
reads `textContent()` and navigates. It never touches `navigator.clipboard`
(which would need a permission grant) and never constructs the URL itself —
constructing it is how a dead link stays green.

### 3.3 Official roles (`lib/official-roles.ts`, `components/v2/officials-shared.tsx`)

`role_keys` is a jsonb array (`usecases/officials.ts:238`), so multi-role is a
data shape, not a join table. `officials.roles_multi` is a **Pro** entitlement:
`page.tsx:184` resolves `hasFeature` and passes `rolesMultiAllowed` into
`OfficialsDirectoryPanel`. On the free plan a second pick **swaps** rather than
adds, and `officials-shared.tsx:257` mounts `<UpgradeGate feature="officials.roles_multi" />`.

`ALL_OFFICIAL_ROLES` (`official-roles.ts:41`) is **derived** — the union of every
sport preset's crew, plus `judge` and `scorer`. The spec imports it rather than
hardcoding role names, so a change to the presets moves the test with it.

### 3.4 Court calendar (`usecases/venues.ts`, `usecases/court-candidates.ts`)

The comment at `venues.ts:5-6` ("No consumer switch this session") is **stale** —
it describes the P8 state before P9.5 shipped. Today:

- **Placer**: `resolveCourtCalendars` (`court-candidates.ts:169`, reading
  `court_hours`/`court_exceptions` at `:178,190`) is called from
  `schedule.ts:1507`, `schedule.ts:3275` and `schedule-ai.ts:838`; the result
  reaches `packages/engine/src/scheduling/calendar.ts:566` and
  `court-windows.ts usableWindows()`, which subtracts closed hours and
  exceptions from candidate windows.
- **Verifier**: `outside_court_hours` is a real conflict kind
  (`calendar.ts:1816`), formatted at `conflict-detail-format.ts:200-204`. It is
  **advisory** — excluded from `isBlockingConflict` (`calendar.ts:330`).
- **Save response**: `PUT /api/v1/orgs/{id}/courts/{id}/calendar` returns
  server-computed `newlyStrandedFixtureCount` and `strandedFixtureCount`
  (`venues-panel.tsx:900-955` reads them; it computes nothing itself).

`newlyStrandedFixtureCount` is the assertion that proves the write reached the
engine, because it is derived from the real placement path rather than from the
form the spec just filled in.

### 3.5 Clubs tab and import

`ClubsTeamsList` (`clubs-teams-list.tsx:68`) is thin: search, New club, New team,
name draft, Create/Cancel, an adopt-into-club `<select>`, and a standalone-team
squad disclosure. **Edit name, short name, crest, contacts and delete all live on
the club hub `/clubs/[id]`** — creating a club `router.push`es there
(`clubs-teams-list.tsx:129`). There is no team-DELETE route at all; the nearest
control is Detach.

The tab's Import link (`clubs-teams-list.tsx:179`) goes to **`/import`** →
`ImportWizard` (`import-wizard.tsx:247`), a `.csv,.xlsx` file input that POSTs
`/api/v1/imports` and commits at `:181`. One participant CSV creates clubs,
teams, persons, entrants and rosters together, from `club`/`clubShort`/`clubRef`/
`team`/`teamShort` columns (`import-parse.ts:19-34` → `plan.ts:21-27`).

`commitImport` (`imports.ts:281`) is **one `withTenant` transaction,
all-or-nothing**, advisory-locked and idempotency-cached. It returns
`{importId, stats:{clubs,teams,persons,entrants,rosters}, divisionIds}` and
throws 422 if any planned issue is `severity:"error"` (`:324`).

There are **zero `data-testid`s** in `clubs-teams-list.tsx`, and every visible
string is an i18n key across four dictionaries. The e2e run locale is English
(`import.spec.ts` already matches `/commit import/i`), but the spec still
prefers locale-stable handles — `aria-expanded`, the `/clubs/{id}` href,
`role="alertdialog"` — over English text wherever one exists.

Delete confirmations use `useConfirm()` (`ui/confirm-provider.tsx`), a **React
`role="alertdialog"`, not `window.confirm`** — so `failOnNativeDialog` is safe to
arm. Two traps: `tone: "danger"` blocks Enter (click or Space only, `:189-191`),
and club-delete then does `window.location.href = "/directory?tab=clubs"`
(`overview-tab.tsx:392`), a full navigation the spec must wait on rather than a
`router.refresh`.

### 3.6 Plan limits

| key | enforced | note |
|---|---|---|
| `clubs.max` | `clubs.ts:75`; `imports.ts:301,429` | |
| `teams.max` | `teams.ts:90,97`; `imports.ts:302,433` | |
| `teams.squad_max` | `teams.ts:267,271` | |
| `import.bulk` | `imports.ts:122` | **rows per file**, checked at CREATE not commit |
| `clubs.hierarchy` | `imports.ts:300`; `clubs.ts:72`; `teams.ts:85` | boolean |
| `members.max` | `invites.ts:68` | |

`persons.max`, `venues.max` and `officials.max` **do not exist** — there is no
cap on people, venues or officials. Enforcement is
`getLimit(orgId, key, competitionId?)` / `withinLimit(...)` /
`assertWithinLimit(limit, featureKey, wouldBe)` (`lib/entitlements.ts:607/624/659`),
all throwing `PaymentRequiredError(featureKey)` = **HTTP 402** with `feature_key`
in the body (`lib/errors.ts:24-31`) and `code` undefined. A `null` limit means
unlimited; a **missing matrix row resolves to 0 and refuses**.

`UpgradeGate` (`components/upgrade-gate.tsx:162`) is mounted at
`import-wizard.tsx:260`, reading the feature from `error.feature_key`
(`:126,201`).

**The plan keys are moving under this design.** Confirmed 2026-09-03 with the
session holding `feat/entitlements-w2-matrix-plumbing` (DB at V396) — these are
facts about that in-flight branch, not an owner ruling:

- **`pro_plus` is DELETED**; `enterprise` is added (`is_public=false`,
  staff-granted). The live catalogue becomes
  `community | enterprise | event_pass | event_pass_l | pro`.
- `PRICING_PLAN_KEYS` (four purchasable columns) and `ADMIN_PLAN_KEYS` (all five)
  now **deliberately differ**, so the read of `pricing-matrix.ts:29` above is
  stale in both directions.
- All three keys this design depends on **survive**, re-valued:
  `clubs.max` Free 5 / Pro 25, `teams.max` Free 8 / Pro 100,
  `import.bulk` Free 50 / Pro 500 (Pro was previously unlimited).
- `helpers.ts:443`'s plan union still says `pro_plus` and that session has an
  outstanding fix to narrow it.

Two consequences, both already satisfied by §4.4 as written. Every spec here uses
only `"pro"` and `"community"`, which both survive. And because §4.4 reads the
limits live and sizes nothing from a literal, the re-valuations move the tests
rather than break them — which is the entire reason §2 chose that.

This design adds **no migration**; if one is ever needed, that branch occupies
V393–V397 and `main` took V391, so take **V398 or later**.

### 3.7 Org isolation — ALL FOUR specs mint their own org

`playwright.config.ts:29` sets `AUTH_STATE = "e2e/.auth/pro.json"`, and the
`walkthrough` project uses it. **Every walkthrough spec therefore runs as the
seeded PRO org**, at `fullyParallel: true` with `workers: CI ? 2 : 4`.

Three consequences, the third of which defeats the mitigation the first draft
of this design proposed:

- §4.2 cannot prove the free-plan role swap on the default state, because
  `officials.roles_multi` is already allowed there.
- §4.4 cannot flip the shared org's plan, because §4.2 would be running beside
  it and would silently see the flipped value.
- **§4.1 cannot see its own people at all.** `page.tsx:106` calls
  `listPersons(auth, { cursor: null, limit: 200 })` and `listPersons` orders by
  `created_at`, so the Players tab renders the **oldest 200** rows. The shared
  org accumulates hundreds of persons across a run, so a person created late is
  not merely hard to find — it is **not on the page**. `person-merge.spec.ts`'s
  own header records this and is why that spec already uses a fresh org.

  This is what kills "scope every assertion to a unique token". Token-scoping a
  list that never contained your row returns a confident zero, and the spec then
  reports "no duplicate was suggested" — which is the exact assertion §4.1 exists
  to make, passing for the wrong reason.

So **every one of the four specs mints its own org**, following
`person-merge.spec.ts` verbatim: `test.use({ storageState: { cookies: [], origins: [] } })`
at file scope, then `loginUi` and `POST /api/orgs`. Uniform, and it buys three
things at once — an empty roster whose counts are assertable, no interference
with or from any other spec, and the **community** plan for free, because
`createOrgForUser` inserts `plan_key 'community'`. §4.2's free-plan half
therefore needs no `setOrgPlanBySql` call at all; only its Pro half does.

The recipe:

```
const orgId = await apiJson(page.request, "/api/orgs", "POST", {...})  // fresh + activated
await setOrgPlanBySql({ orgId }, "community")
// ... journey ...
await apiJson(page.request, "/api/orgs/active", "POST", { org_id: original })
```

**A `splitOrgIntoOwnGroupSql` call is NOT needed here, and an earlier draft of
this document was wrong to require one.** The reasoning is worth keeping,
because the wrong version is the one the codebase's own comments will tell you:

- `setOrgPlanBySql` really is **group-scoped** — `helpers.ts:441-449` resolves
  `requireGroupId(sql, orgId)` and updates `subscriptions ... where id = groupId`.
  That much is true, and it matters for any orgs that genuinely DO share a group.
- But **a new org does not join its creator's existing group.**
  `POST /api/orgs` (`app/api/orgs/route.ts:28`) calls `createOrgForUser`
  (`lib/auth.ts:303`), whose transaction does
  `insert into subscriptions (owner_user_id, plan_key, ...) values (..., 'community', ...)
  returning id` and stamps that NEW id onto the org it then inserts. Its own
  race-condition comment says so out loud: two concurrent creates "each minted
  an org **+ a Community group**". Three orgs minted by one e2e user are three
  groups, not one bill.
- The doc comment on `splitOrgIntoOwnGroupSql` (`helpers.ts:1066-1073`) asserts
  the opposite — "a new org joins its creator's EXISTING group (`lib/auth.ts
  createOrgForUser`)". It **contradicts the function it cites**. It references a
  fixture "V309 made necessary", so it was presumably true once and the
  behaviour changed underneath it. The only writers that attach an org to an
  existing group today are the explicit attach/detach usecases at
  `server/usecases/billing-groups.ts:975` and `:1260`.

So cross-contamination is reachable only by a spec that has **deliberately**
joined orgs into one group. None here do.

The methodological point, since this document partly exists to stop the next
session repeating it: that comment read as authoritative and was cited as
evidence for a claim about a function nobody had opened. **A comment citing a
function is a hypothesis about that function, not evidence of it.** Caught by a
peer session opening `lib/auth.ts`; it is the fourth stale comment found in this
area in one day.

`setEntitlementOverrideSql(orgId, featureKey, intValue)` (`helpers.ts:473`)
writes `org_entitlement_overrides` and is org-scoped, not group-scoped — so it is
safe without the split, and it is how §4.4 gets a small deterministic cap instead
of importing twenty clubs to reach Pro's.

## 4. The four specs

Each drives ONE journey through the real UI. Setup may use the API to REACH a
state; every step that IS the thing under test is typed, tapped or uploaded.

### 4.1 `directory-player-identity.spec.ts` — two tests

**Test A — the duplicate queue tells the truth.**
1. Create three people through `PersonsPanel`'s own form (`persons-panel.tsx:354-368`
   — full name, dob, gender): `Alex Morgan / 1990-04-02`, a second
   `Alex Morgan / 1990-04-02`, and a third `Alex Morgan / 1986-11-19`.
2. Reload the Players tab. Assert that among the candidate pairs **whose names
   carry this spec's unique token**, there is **exactly one** — the two sharing a
   dob — with evidence kinds `name` and `dob`.
3. Assert the third person appears in **no** candidate pair. This is the
   suppression rule, and it is the assertion no existing test makes.

   The token scoping in step 2 is not cosmetic. The duplicate queue is org-wide
   and the walkthrough project shares one seeded org with every other spec in the
   leg; `enroll.spec.ts`, `import.spec.ts` and the registration specs all mint
   people into it. A bare "exactly one pair in the queue" assertion would pass or
   fail on **who else ran first**, which is the worst kind of flake — it fails on
   a clean branch and passes on a retry. Every name this spec creates is
   suffixed, and every count it asserts is filtered to that suffix.
4. Merge the real pair through `MergeConfirmDialog`; assert the survivor keeps
   its identity and the absorbed row is tombstoned rather than gone.
5. Reverse it through `ReverseConfirmDialog`; assert both rows are back and the
   queue proposes the pair again.

**Test B — a claim link is not transferable.**
1. Organiser invites person P; read the link from `data-testid="claim-link"`.
2. **User B** (`newContext({storageState:{cookies:[],origins:[]}})` + `loginUi`)
   opens the link → refused (`assertClaimEmail`). Assert P is still unclaimed.
3. **User A** opens the same link → accepted. Assert the row reads *claimed*.
4. Organiser **unlinks** → assert P is unclaimed and A's session no longer owns it.
5. Organiser invites again, captures link 1; invites a **third** time, captures
   link 2. Assert link 1 is now dead and link 2 works.
6. Organiser **revokes** the open invite → assert link 2 is now dead too.

Steps 5 and 6 are the two refusals that only exist because of a DB constraint
and a DELETE route; neither has ever been driven.

### 4.2 `directory-officials-roles.spec.ts` — one test

0. Mint an isolated org by the §3.7 recipe — `POST /api/orgs`,
   `splitOrgIntoOwnGroupSql`, `setOrgPlanBySql({orgId}, "community")` — and
   restore the original active org in a `finally`. The default state is Pro, so
   without this step 2 asserts nothing.
1. Create an official through the Officials tab. Pick role 1 from
   `ALL_OFFICIAL_ROLES[0]`, then role 2 from `[1]`.
2. Assert the chip set is now **exactly `[role2]`** — it swapped, it did not add —
   and that `UpgradeGate` for `officials.roles_multi` is visible.
3. `setOrgPlanBySql({ orgId }, "pro")` on **this spec's own org**, reload.
4. Pick both roles. Assert **both** persist, and **survive a reload** (the
   jsonb write, not just the client state).
5. Invite the official; follow the claim link; accept.
6. Add a blackout date (`official_availability`); assert it reads back from
   `GET /officials/{id}/availability`.

Step 2 and step 4 are the same control asserted in opposite directions, which is
what makes the entitlement tested rather than merely exercised.

### 4.3 `directory-venues-courts.spec.ts` — one test

1. Create a venue and **three** courts through the Venues tab (`venues.spec.ts`
   has only ever done one).
2. Seed a division and generate fixtures onto those courts **via the API** — this
   is setup, not the thing under test.
3. Through the calendar editor, give court 2: weekly hours, one **closed day**,
   and one dated **exception**.
4. On save, assert the response's **`newlyStrandedFixtureCount` > 0**. This is
   the seam proof: the number is computed server-side from the real placement
   path, so it cannot be satisfied by the form the spec just filled in.
5. Reload; assert every hour range, the closed day and the exception survived.
6. Open the board; assert an **`outside_court_hours`** conflict is surfaced for
   the stranded fixture, **and that it does not block** — the fixture is still
   saveable. Asserting the advisory nature is deliberate (§2).

### 4.4 `directory-clubs-import-limits.spec.ts` — one test

Bulk import, multiple files, two different caps at two different stages.

0. Mint an isolated org by the §3.7 recipe and restore the original in a
   `finally`. This spec counts clubs, and the shared org already holds clubs from
   `clubs.spec.ts`, `enroll.spec.ts` and `import.spec.ts` — a count against it
   would be a count of the whole run.
1. Create one club through the tab's own New-club form (nothing currently does).
   Assert the `router.push` lands on `/clubs/{id}`.
2. Back on the tab, follow the **Import** link to `/import`.
3. **Assert the catalog still has the rows, then override them.** Two separate
   jobs, and conflating them is how this test would end up asserting a constant.

   a. `directory-kit.ts` exports `liveLimit(orgId, key): Promise<number | null>`,
      reading the entitlement matrix through the same `withDb` connection the
      other `*Sql` helpers use. Assert `clubs.max` and `import.bulk` each resolve
      to a **finite number or `null`**, and **throw** if the row is missing. This
      is the whole catalog assertion: a missing row resolves to **0** and refuses
      everything, so a deleted row must fail loudly here rather than surface as a
      confusing 402 three steps later. It carries no hardcoded value, so a
      re-valued row moves the test with it.

   b. Then `setEntitlementOverrideSql(orgId, "clubs.max", 3)` and
      `setEntitlementOverrideSql(orgId, "import.bulk", 5)`. Overrides are
      **org-scoped, not group-scoped** (§3.7), so they need no split and cannot
      leak into another spec's org. `CAP = 3`, `ROWS = 5`.

   Deriving the journey from the live Pro values instead would mean importing
   twenty-plus clubs to reach a cap — slow, and it pollutes a shared org. The
   override is both faster and the same tool a real grandfathered owner gets.

4. **CSV #1** — one club, in memory via `setInputFiles` with a `Buffer`. Preview,
   then commit. Assert `stats.clubs === 1`.
5. **CSV #2** — three further clubs, crossing `CAP`. Commit is refused with
   **402**, and `UpgradeGate` names **`clubs.max`**. Then assert the club count
   is **unchanged** — that is the all-or-nothing transaction (`imports.ts:281`)
   proven, not assumed.
6. **CSV #3** — `ROWS + 1` rows. Refused at **create**, not commit
   (`imports.ts:122`), naming **`import.bulk`**. A different cap, at a different
   lifecycle stage, with a different feature key. This is the case that stops the
   spec proving one gate twice.
7. Raise the override to `clubs.max = 10`; re-upload CSV #2. Now it commits, and
   the clubs appear on the tab. (Raising the override, rather than flipping the
   plan, keeps this step inside the org this spec owns.)

Step 5's "count unchanged" and step 6's different-stage refusal are what stop
this from being a test that merely watches one number go up.

## 5. Speed

The owner's requirement is that these be fast. The leg's wall clock is
`max(longest single test, total test time ÷ workers)`, with
`workers: process.env.CI ? 2 : 4` and `fullyParallel: true` inherited by the
`walkthrough` project (`playwright.config.ts:126-127,164`).

**The config's cost comment is stale and must not be trusted.** It describes
three specs totalling ~245s; the folder now holds **19 specs / ~40 tests**. So
the claim "tennis-mtb's 174s shadow makes new work free" may or may not still
hold, and this design does not assume it. The budget is a **measured gate**:

1. Time `--project=walkthrough` on the branch point. Record it.
2. Time it again with the four specs added.
3. The delta must be **≤ 10%** of the baseline wall clock. If it is not, the
   fix is to move setup off the UI, not to delete assertions.

Six rules the specs follow to earn that:

- **API to REACH, UI for the thing under test.** The folder's own rule, and the
  main lever. Divisions, fixtures and entrants in §4.3 are seeded by API; only
  the calendar editing is tapped.
- **No test exceeds the 60s default `timeout`.** A spec needing
  `test.setTimeout` has failed this budget and must be split — which is why
  §4.1 is two tests, not one.
- **Where a budget must be raised, express it as a derived cost**, never a flat
  constant: `Math.max(FLOOR, base + rows * PER_ROW)`. A flat timeout beside a
  derived cost is a latent red.
- **`expect.poll`, never `waitForTimeout`.** `registration-connect.spec.ts`
  carries ~14 fixed sleeps; that is the anti-pattern, not the model.
- **Reload only where persistence IS the assertion** (§4.2 step 4, §4.3 step 5).
- **Bulk through CSV, not through clicks.** §4.4 needs volume to reach a cap;
  one in-memory `Buffer` upload replaces dozens of form submissions. This is why
  the plan-limit journey is cheap rather than the most expensive of the four.

## 6. Traps this design has already paid for

1. **A helper under `walkthrough/` is selected as a spec.** `WALKTHROUGH` matches
   any file in the folder. The kit goes at `e2e/directory-kit.ts`.
2. **Hardcoding a plan limit asserts yesterday's catalog.** The live catalog
   differs from the migrations — v18 retired `plus` and `business`. Read
   `clubs.max` and `import.bulk` at runtime.
3. **`browser.newContext()` inherits the owner session.** Spell out
   `storageState: { cookies: [], origins: [] }` or every refusal in §4.2 passes
   vacuously against the behaviour it guards.
4. **Constructing a claim URL hides a dead link.** Read it from
   `data-testid="claim-link"` and navigate.
5. **`officials.roles_multi` asserted only on Pro is untested.** §4.2 asserts the
   swap too.
6. **`outside_court_hours` is advisory.** A spec asserting the placer avoids the
   window fails against correct behaviour.
7. **`person-duplicates.ts` is `server-only` with private constants.** Assert
   evidence kinds and ordering, not a score number.
8. **Danger-tone confirms block Enter**, and club-delete is a full page
   navigation.
9. **`AUTH_STATE` is the PRO org, and it is shared.** A free-plan assertion made
   against it is vacuous, and any COUNT made against it counts the whole run's
   leftovers. §3.7.
10. **`setOrgPlanBySql` is group-scoped, and a fresh org inherits its creator's
    group.** Setting a "fresh" org's plan moves the shared Pro org with it. Split
    the group first. This is the one mistake in this programme whose damage lands
    in other people's specs, so it is listed twice on purpose.

## 7. Testing

Per `docs/superpowers/RULES.md`, all four types:

- **E2E** — the four specs above; this is the deliverable.
- **Unit** — vitest over `directory-kit.ts`'s pure helpers: the CSV builder and
  the unique-name stamp. Real logic with real edge cases (quoting, row counts,
  collision resistance), and it runs in milliseconds.

  **Explicitly NOT a new assertion in `e2e-ci-wiring.test.ts`.** An earlier draft
  of this design called for one. That was wrong: selection is by directory regex
  (`WALKTHROUGH`, `playwright.config.ts:119`), and the guard at
  `e2e-ci-wiring.test.ts:180` already asserts the walkthrough project selects
  more than zero files and that every one lives under `walkthrough/`. Four new
  files in that directory are therefore covered **by construction**. Its only
  numeric bounds are a total-spec floor of 50 (which rises safely), the heavy
  carve-out's own list, and a count of `ref:` lines in `e2e.yml` — none counts
  walkthrough files, deliberately. Adding a count or a membership list would be
  the first such guard in the file and would need editing on every future spec
  addition, for no signal these four files do not already have.
- **Smoke** — new `scripts/smoke.ts` checks. This is genuinely uncovered ground:
  `/directory` has exactly one existing check (`:12550`, which asserts a French
  nav string and nothing about directory content) and **`/import` has none at
  all**. Add checks that `/directory` serves each of the four tabs and that
  `/import` renders its file input.
- **Regression** — each spec's negative assertion is its regression test: the
  suppressed duplicate, the swapped role chip, the unchanged club count after a
  refused commit, the dead claim link.

**Every spec is mutated until it goes red before it is trusted** — the folder's
own rule, and one of its specs passed on the first run, which is when a test
deserves the least trust. Named mutants:

| mutant | spec that must go red |
|---|---|
| delete the differing-dob suppressor | §4.1 test A step 3 |
| force `rolesMultiAllowed = true` | §4.2 step 2 |
| drop `assertClaimEmail`'s throw | §4.1 test B step 2 |
| make `commitImport` non-transactional | §4.4 step 5 |
| blank `court_exceptions` before the calendar read | §4.3 step 4 |

## 8. Out of scope, recorded

- **`POST /api/v1/officials/import` has no entitlement gate** (§1.1). Not fixed
  here. **Customer view**: an org on any plan can bulk-load unlimited officials
  through the API while the same org is capped on clubs and teams through the
  UI — the caps are inconsistent, and the API is the cheaper path around them.
  **Cost**: small — one `assertWithinLimit` call plus its tests. **Recommendation**:
  fix it, but as its own change, because adding a gate to a live endpoint needs
  its own regression test and this programme's specs must not be the first thing
  that notices.
  **Strongest argument against**: there is no `officials.max` key today, so
  gating it means inventing a cap — a pricing decision, not a bug fix. That is
  the owner's call, which is exactly why it is not folded in here.
- The **Clubs tab's club-hub surfaces** (crest upload, contacts, delete) are
  covered by `clubs.spec.ts`; §4.4 touches the hub only to prove the
  `router.push` lands.
- **Blocking a user** — no such feature exists (§2). If one is wanted, it is a
  product change, not a test gap.

## 9. Cross-programme

`feat/entitlements-w2-matrix-plumbing` is in flight and touches
`apps/web/e2e/helpers.ts`. This design **imports** from that file and never edits
it, and its own files are four new specs under `e2e/walkthrough/` plus
`e2e/directory-kit.ts` — so the trees are disjoint and no coordination is owed
beyond the plan-key facts already folded into §3.6. That session confirmed
`lib/entitlements.ts`, `V292` and `V319` are untouched.

Three changes on that branch are **not** consumed here but would break a
directory spec written naively later, so they are recorded:

- Competitions are now **public by default** (was private), and at the
  public-dashboard cap a create **degrades to private with a note** instead of
  returning 402. A spec asserting a new competition is private, or expecting a
  402 there, flips.
- `dashboard.public.max` becomes Free 2 / Pro 10, and now counts only **active**
  public competitions, excluding passed ones.
- `dashboard.player_profiles`, `embeds.enabled` and `news.auto` are no longer
  free on Community.

§4.3 seeds a division via the API and asserts nothing about competition
visibility, so it is unaffected.

That session independently confirmed the §1.1 officials-import gap and reached
the same conclusion — that gating a live API route is a product decision, not a
cleanup — and is putting it to its own owner rather than absorbing it. Neither
session should act on the other's owner. §1.1 stands as written here regardless
of which way that goes.
