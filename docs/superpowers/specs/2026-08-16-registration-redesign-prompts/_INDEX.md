# Registration Redesign (RS) — session index

**One session per prompt file.** Read `_RULES.md`, then this file, then the
session's prompt. This file is the compaction anchor: every ruling, false
premise, and status change gets written here **as it happens**.

Design of record: `../2026-08-16-registration-redesign-design.md` (approved
2026-08-16 in the brainstorm session; owner rulings in its §2).

## Order

Main chain RS001 → RS001b → RS002 → RS003 is sequential (schema → currency
delta → usecases → endpoints).
After RS003 two lanes are file-disjoint and may run in either order or
interleaved: **org lane** RS004 → RS005 → RS009, **public lane** RS006 → RS007
→ RS008. RS010 is last, after both lanes.

**RS011** (organiser-side eligibility gates, re-homed from the scoringpad-v2
`L1`/#412 on 2026-08-17) depends only on RS002 and is file-disjoint from
RS004–RS009, so it runs alongside either lane, before RS010. It writes
`api-v1/schemas.ts`, which `L2`/#413 (date hardening, in the scoringpad-v2
prompts dir) also writes — those two are **sequential, never parallel**.

| Session | Prompt file | Depends on | Status |
|---|---|---|---|
| RS001 | `RS001-schema-and-demolition.md` | — | **DONE** — PR #592 merged `850cc630` (2026-08-17) |
| RS001b | `RS001b-org-currency-allowlist.md` | RS001 | **DONE** — PR #598 merged `a7cca608` (2026-08-17) |
| RS002 | `RS002-core-usecases.md` | RS001b | **DONE** — PR #607 merged `4ff0bf8f` (2026-08-17) |
| RS003 | `RS003-public-endpoints.md` | RS002 | **IN FLIGHT** — branch `feat/rs003-registration-endpoints` |
| RS004 | `RS004-hub-settings-tab.md` | RS003 | TODO |
| RS005 | `RS005-hub-registrants-tab.md` | RS004 | TODO |
| RS006 | `RS006-public-stepper.md` | RS003 | TODO |
| RS007 | `RS007-status-page-join-payments.md` | RS006 | TODO |
| RS008 | `RS008-consent-claim-optout.md` | RS007 | TODO |
| RS009 | `RS009-free-agents.md` | RS005, RS003 | TODO |
| RS011 | `RS011-organiser-eligibility-gates.md` | RS002 | TODO — issue #412, re-homed from `L1` |
| RS010 | `RS010-closeout-e2e-smoke-help.md` | all | TODO |

Public registration is **intentionally down** between the RS001 and RS006
merges (owner-accepted; prod has zero registration usage). The register page
serves its closed/unavailable state during that window.

## Owner rulings (from the 2026-08-16 brainstorm — trust these)

1. **All three new public flows**: club rep registering N teams in one cart;
   player joining an existing team entry via link; free agents into team
   divisions.
2. **Org IA**: competition-level Registration hub (`/o/.../c/[compSlug]/registration`),
   Settings + Registrants tabs. Division-level registration route deleted.
3. **Eligibility first-class**: `divisions.category` (`open|mens|womens|mixed`,
   null = open) + `age_min`/`age_max`; badges on the public page; **every roster
   player validated**, not just the submitter; mixed ⇒ roster needs both
   genders (≥1 of each).
4. **Consent per person**; join/claim is the consent moment for players entered
   by someone else.
5. **Names public by default**; registering = consent to public name, stated in
   the consent copy; opt-out later → initials on public surfaces; youth
   divisions keep `player_name_display`.
6. **Approval**: per-division `auto` (default) | `manual`; new terminal status
   `rejected`.
7. **Public flow**: stepper + cart, one payment per cart; waitlisted entries
   are **never charged** at submit (pay on promotion).
8. **Greenfield, zero prod data**: no backfill, no flags, no compat shims; old
   surfaces deleted in RS001.
9. **Org preferred currency + allowlist** (addendum 2026-08-16, decided while
   RS001 was already in flight — RS001 sessions opened before this line owe
   none of it): one currency per org (`organizations.currency`), select over
   `REGISTRATION_CURRENCIES` (= `SUPPORTED_CURRENCIES` minus exclusions);
   per-division `registration_settings.currency` dropped; offline payment
   uses the SAME restricted list; carts single-currency by construction;
   groups snapshot the currency at submit.
10. **Same-currency rule** (owner ruling 2026-08-16, supersedes the live-INR
    verify RS001b briefly carried): a connected org's charge currency always
    equals its account's settlement currency (INR→INR, GBP→GBP; no FX leg).
    Sync locks `organizations.currency` to the account `default_currency`;
    free allowlist choice is for unconnected (offline/display) orgs only;
    unsupported settlement currency → card-unsupported state at connect
    time. Consequence: INR card payment is unreachable on the GB platform
    (cannot onboard IN-settled accounts) — INR is offline/display-only.

## Session rulings

### RS001 (2026-08-16) — branch `feat/rs001-registration-schema`

- **V-numbers**: high-water mark was **V362**. RS001 ships
  `V363__registration_groups_players.sql` and `V364__registrations_regroup.sql`.
  Schema test: `apps/web/src/server/__tests__/registration-schema.test.ts`
  (13/13 on v364, **12/13 red on v362** — it genuinely gates the migration).
- **Payment-columns verdict**: the whole payment/identity envelope moves to
  `registration_groups` and is **dropped from `registrations`** —
  `contact_email`, `access_token_hash`, `ref_code`, `locale`, `user_id`,
  `payment_method`, `checkout_session_id`, `payment_intent_id`, `expires_at`,
  `reminded_at`, `refunded_cents`, `refunded_at`, `disputed_at`, `dispute_id`,
  `offline_marked_paid_at`, `offline_marked_paid_by`, `fee_percent`,
  `currency`, `privacy_consent_at`, `privacy_consent_version`. Safe: a scout
  sweep found every one read **only** inside
  `server/usecases/registrations.ts` (+ its own tests). Rationale: one payment
  per cart makes a per-entry checkout session meaningless. `amount_cents` and
  `status` stay per entry (design §3 — a cart can be partially waitlisted).
- **Extra drop, beyond the literal brief**: `dob`, `gender`, `guardian_name`,
  `guardian_consent` also leave `registrations` — per-player validation and
  per-person consent make `registration_players` the single source of truth,
  and nullable duplicates on the entry row would drift. `display_name` stays
  as the entry label (team/pair/individual name).
- **Design gap fixed**: `registration_players` gains **`guardian_name`** —
  design §3 lists `consent_status='guardian'` with nowhere to record WHO
  consented, which the old `registrations.guardian_name` did capture.
- **`join_code` is globally unique** (partial unique index where not null), not
  per-division: a `?join=<CODE>` link carries nothing else, so it must resolve
  to exactly one entry.
- **No new `(division_id, status)` index** — the existing
  `registrations_division_idx (division_id, status, created_at)` already serves
  it as a leading-column prefix.
- **Old-shape rows are deleted, not migrated** (`delete from registrations` in
  V364): prod is empty, so this only clears local/`seed:demo` rows that have no
  group and no player rows and would violate the new invariants.
- **`r/[ref]` verdict**: it **does** read registrations
  (`publicRegistrationStatusByRef` + `reconcileRegistrationBySession`) and
  `ref_code` moved to the group → RS001 gives it the closed state; RS007
  re-points it at group refs. Sibling `r/[ref]/ticket.png/route.tsx` rides along.
- **`registration-pulse.tsx` verdict**: registration-only (sole importer is
  `registrations-panel.tsx`) → deleted with the rest.
- **Currency**: untouched by RS001 (`registration_settings.currency` still
  exists; `registration_groups.currency` ships unconstrained). Ruling 9 above
  says sessions opened before the addendum owe none of it — RS001b owns it.
- **For RS001b, concretely**: the Flyway high-water mark is now **V364**, so
  start at **V365**. The column RS001b must constrain already exists and is
  `registration_groups.currency` (`text`, nullable, no CHECK) — the snapshot
  the design calls for, deliberately left unconstrained. `registration_settings.currency`
  is still present and still read by `usecases/registrations.ts`, so dropping it
  is a code change as well as a migration. And note RS001 dropped
  `registrations.currency` outright — it is already gone from the entry row.
- **`registration_players.user_id`** (design gap #2, found mid-session): the old
  `materialise` linked a signed-in registrant's person to their account via
  `resolvePlayerPerson` (the `(org_id, user_id, lane='player')` upsert that
  #402/#404 identity dedupe hangs off). `registrations.user_id` moved to the
  **group** — and a group is now a club rep who may enter *other people*, so
  resolving every entry against the group's account would mis-link strangers to
  the rep. The account therefore belongs on the **player row**: set for the
  submitter's own row at submit ("I'm playing"), and at claim/join.
  Without it the demolition silently downgraded every materialised person to
  unlinked, and the sweep deleted the tests that covered the linked path —
  caught by diffing `resolvePlayerPerson`'s call sites across `6984951d..HEAD`
  (2 callers → 0). Consumer is live and tested in RS001; the producer is
  RS002/RS003 (submit) and RS008 (claim).

### RS001b (2026-08-17) — branch `feat/rs001b-org-currency`

- **V-number**: high-water mark was **V364**. RS001b ships
  `V365__org_currency.sql` **and `V366__rls_billing_org_tables.sql`** (the unplanned RLS
  fix below), so the mark is now **V366** and RS002 starts at **V368**. Applies
  from zero on a clean schema (204 migrations, verified on a second fresh DB,
  not just incrementally).
- **Card-unsupported representation — the thing RS004 reads**:
  `organizations.stripe_unsupported_currency text null`. It holds the
  CONNECTED ACCOUNT's settlement currency when that code is outside
  `REGISTRATION_CURRENCIES`, and null when card registration is
  currency-viable. Non-null therefore means *both* the flag and its reason.
  Storage/read shape deliberately mirrors `stripe_disabled_reason`: written by
  `syncConnectAccount`, read back out through `connectStatus` as
  `unsupported_currency` (added to the `ConnectStatus` zod schema, so it is in
  the OpenAPI contract).
  Why not write the offending code into `organizations.currency` and flag it
  elsewhere: it would violate the allowlist CHECK and abort the whole sync
  transaction, taking the charges/payouts/requirements mirror down with it.
- **Final list as shipped**: `REGISTRATION_CURRENCY_EXCLUSIONS` is **empty**, so
  `REGISTRATION_CURRENCIES` == `SUPPORTED_CURRENCIES` == `usd, eur, gbp, inr,
  aud`. All five are 2-decimal (guard test). INR stays selectable — it is
  offline/display-only in practice per ruling 10, and nothing in the schema
  needs to know that.
- **`registration_groups.currency` carries NO allowlist CHECK, on purpose** —
  only `NOT NULL` with no default. A snapshot is a historical fact: delisting a
  currency later must not retroactively invalidate carts legitimately quoted in
  it, and a future migration re-adding a tightened CHECK would fail on exactly
  those rows. `organizations.currency` is the moving allowlist; the group column
  is the frozen quote.
- **Promotion no longer re-snapshots currency.** `promoteOldestWaitlisted` used
  to write `settings.currency` onto the group alongside payment_method and the
  48h window. With currency org-level, writing the org's CURRENT currency there
  would silently re-denominate a cart the registrant was already shown a price
  for (design §3: a later org-currency change never touches an existing group).
  `payment_method`/`expires_at` still get written — that is RS001's flagged
  multi-entry-cart issue, unchanged.
- **The lock overwrites on EVERY sync**, and `default_currency` is absent on an
  Express account until Stripe knows its country/bank — so "no settlement
  currency yet" is a distinct branch that must leave `currency` alone rather
  than default it. Covered.
- **NOT NULL on `registration_groups.currency` is the session's real blast
  radius**: 15 group-insert sites across unit tests, `payments-hardening.spec.ts`
  (LIVE on PRs) and `scripts/smoke.ts` had to name the column. `tsc` sees none
  of them — they are raw SQL — and the unit ones only surfaced by running the
  suites. RS002+ adding another NOT NULL group column owes the same sweep:
  `git grep -a -n "insert into registration_groups" -- apps scripts`.
- **`PutRegistrationSettings` lost `currency`; `RegistrationSettings` kept it**,
  now sourced from the org via `OrgPaymentDefaults`. So the division settings
  panel can render RS004's read-only chip without a second fetch, and the field
  is read-only by construction (no request-schema counterpart). OpenAPI
  regenerated (`v1.json`, `v1.public.json`).
- **E2E deferred, explicitly**: there is no user-facing currency surface until
  RS004 (org-settings select + hub chip) and RS006/RS007 (public pay step), so
  the E2E owed here is deferred to **RS004** for the select/chip and **RS006**
  for the paid public flow. What DID ship in e2e is the fixture correction above
  — `payments-hardening.spec.ts` would 500 on the new NOT NULL otherwise.
- **Smoke shipped and RUN**: `regQueueSuite` now PUTs `currency: "usd"` at a gbp
  org and asserts the response comes back `gbp` — i.e. a per-division currency
  is ignored and the org's is quoted. That is the reachable RS001b behaviour
  today. Local full smoke against a standalone prod build on `:3210` with its
  own fresh DB: **815 passed, 5 failed**, the RS001b check among the passes. All
  5 failures are the placement/solver service, which this run never started (CI
  runs it in Docker on `:50051`) — they name it explicitly ("the solver was
  reachable in prod (not the solver_unavailable fallback)").
- **Unplanned, owner-approved (2026-08-17): the RLS guard was checking nothing.**
  `scripts/check-rls.ts` filtered on schema `public`; every table in this
  database lives in `seazn_club`. It selected **zero rows** and printed "RLS
  guard OK" — in the smoke CI job as much as locally — for its whole life. So
  the automated backstop for "a new table forgot isolation" has never once been
  able to fail. Corrected to `DB_SCHEMA ?? "seazn_club"`, it checks **54** tenant
  tables and named three with no row-level security at all:
  `org_credit_allocation` (V329), `pass_credit_redemptions` (V335),
  `pass_mint_refusals` (V342). Owner ruled: fix the script AND close the three
  here, rather than exempting them or deferring. **V366** enables+FORCEs RLS and
  adds a tenant policy on each; deliberately NO `app_user` GRANT, because their
  isolation today rests only on the absence of one — the migration tightens, it
  does not widen. `SUPERUSER_ONLY` moved to `scripts/rls-exempt.ts` so the
  script and the new vitest suite read ONE list.
  New suite `apps/web/src/server/__tests__/rls-coverage.test.ts` duplicates the
  gate in the ORDINARY test job (the script runs only in the PR-only smoke job)
  and, first assertion, fails if it is ever looking at fewer than 40 tenant
  tables — the check that would have caught the dead gate on day one. Proven red
  by disabling RLS on `pass_mint_refusals` and re-running.
- **Gate**: full `apps/web` vitest 7995 total / 7923 passed / 4 failed / 68
  pending; the 4 are `schedule-build-honours-locks.test.ts`, the pre-existing
  red on main documented below. `tsc` root EXIT=0, `lint` 0 errors (75 warnings,
  none in touched files), `i18n:check` parity OK, `openapi:gen` +
  `i18n:gen-keys` clean.

### RS002 (2026-08-17) — branch `feat/rs002-registration-usecases`

**LIVE SESSION STATE** (update this block as waves close; it is what a resumed
or compacted session reads first).

- Worktree `.claude/worktrees/rs002`, rebased onto `main` @ `c2cb1f3fb`
  (P8 venues & courts, #605). **All five waves CLOSED and reviewed.**
- **A gate DB goes STALE within a session.** Every label here — `rs002v`,
  `rs002f` — was fresh when made and wrong later: `rs002v` accumulated orgs
  until `org-posts-digest` timed out, and both predate the venues rebase, so
  they lack `venues`/`courts` entirely. Make a NEW label after any rebase that
  brings schema (`seazn-env up --label <x>`), and never diagnose a red against
  a DB older than the branch.
- Placement service (needed or `schedule-build-honours-locks` shows 4 false
  reds): `PLACEMENT_SERVICE_HOST=localhost:50805`,
  `PLACEMENT_SERVICE_SECRET=local-rs002-secret`. Started via
  `seazn-env up --label rs002 --placement`. **Tear it down at session end** —
  a stale placement service makes the NEXT session's run green against code
  that has changed.
- Waves: **W1–W5 all CLOSED**, each implementer → reviewer → gaps →
  implementer, with the main thread rerunning the gate itself. Modules
  shipped: `registration-eligibility.ts`, `registration-submit.ts`,
  `registration-approval.ts`, plus `registrations.ts` and **V370**.
- **The migration is `V370__registration_entry_refunds.sql` — renumbered
  TWICE.** It was V367, then V368, and is now V370. The second collision is
  the instructive one: RS002 (#607) and F1 (#606) both moved off V367 while
  open, both independently chose V368, and both merged. `main` then held two
  V368 files and Flyway refused to run at all — "Found more than one
  migration with version 368" — so no fresh clone, worktree or CI database
  could build a schema, while every PR had been green in isolation. The
  collision existed only in the merge. Dodging a number at write time does
  not claim it; re-verify against `origin/main` immediately before merging.
  `main` merged `V367__venues_and_courts.sql` (#605) after RS002 forked, and
  **two V367 deltas in one tree is a migration-tool collision that `git
  rebase` reports as success** — nothing flags it until Flyway runs. Only the
  whole-branch review caught it. Any RS session that forks and then rebases
  owes this check: `ls db/migration/deltas | tail`.
- **Final gate, main thread, fresh post-rebase schema + placement service:**
  `apps/web` **8569 total / 8507 passed / 0 failed / 62 pending / 0 failed
  suites**; `turbo typecheck` 2/2 (the CI gate — `tsc -p apps/web` alone
  misses `packages/engine`); `lint` ✖ 75 problems, **0 errors**, the same 75
  warnings `main` carries; `openapi:gen` + `i18n:gen-keys` + `i18n:check` all
  clean with `git status --porcelain` **empty**.
- **38 review findings, 37 fixed, 1 deliberately kept.** The keep is
  `group_refunded_cents`: it is the cart-scoped half of a split `tsc` cannot
  enforce (both sides are plain `number`), it is asserted by tests, and the
  dispute write-off writes it. Deleting the alias would leave the next reader
  of `RegistrationWithGroupRow.refunded_cents` taking the entry's number for
  the cart's — the exact bug wave 1 existed to fix.
- **The whole-branch review is not optional, and it is not the per-wave
  reviews summed.** Five per-wave reviews and a fully green 8477-test suite
  all missed: the V367 collision, a sweep expiring a free sibling that never
  had a deadline, and a paid-awaiting-approval entry that could be approved
  but never declined. Budget one at the end of every multi-wave session.
- **Agent failure modes this session, all recurring — put these in every
  brief.** Three implementers stalled by backgrounding their own vitest run
  and returning `completed` with "waiting for the monitor notification", no
  counts; `ListAgents` cannot see it, the tell is a final message with no JSON
  counts and no commit hashes. **Two then died on the 600s watchdog holding
  450+ uncommitted lines**, so briefs must say "commit after each finding, not
  at the end". Two wrote their first edits into the MAIN checkout. And one
  signed off with "stale test DB, not a code defect" over **two real reds in
  its own new file** — a fixture that seeded a stripe division without
  `stripe_charges_enabled`, tripping W4's own 503 guard. A fresh DB gave 8569
  tests with exactly two failures, both ours; a schema mismatch does not look
  like that.
- **`--reporter=verbose` is the only way to read a failure here.** Both `rtk`
  AND a bare `npx vitest --reporter=json` render the message as
  `STACK_TRACE_ERROR` with a stack into the MAIN checkout's `node_modules`,
  which additionally impersonates the worktree-resolution trap. That masking
  hid a 30s sweep timeout AND the two fixture 503s.



Worktree `.claude/worktrees/rs002`, DB label `rs002`. Baseline before any edit:
the four registration suites are **89/89 green** on `main` @ `51ab77a8`
(`registrations.test.ts`, `registrations-intake-gate.test.ts`,
`registration-user-link.test.ts`, `registration-schema.test.ts`).

Rulings taken (recorded as made):

- **Per-entry refunds get their own column** — the decision RS001 deferred.
  **V368** adds `registrations.refunded_cents int NOT NULL default 0`
  (`>= 0` check). Rationale: RS002 is the session that makes multi-entry carts
  real, and all three cart-money hazards are unfixable without an entry-level
  number — `remaining = amount_cents - refunded_cents` only type-checks as
  arithmetic, not as accounting, while one side is a cart total. The group's
  `refunded_cents` stays as the cart's accumulated total (`greatest`/additive,
  never overwritten); the entry column is what the withdraw/refund/dispute paths
  read and write. It has a DEFAULT, so unlike RS001b's `registration_groups.currency`
  this one owes no `insert into` sweep. No per-entry `refunded_at` — the cart's
  timestamp is enough and YAGNI applies.
- **Prompt premise "registrations.ts was near ~600 lines" is FALSE** — it is
  **2431** lines at `51ab77a8`. So the "split if it passes ~600" clause fires
  immediately. Split adopted is additive, not a rewrite of the existing file
  (which would bury the diff): new siblings
  `usecases/registration-eligibility.ts` (pure, imports nothing from
  `registrations.ts`), `usecases/registration-submit.ts` and
  `usecases/registration-approval.ts` (both import `registrations.ts`).
  Direction of dependency is one-way by construction, so there is no cycle;
  `registrations.ts` re-exports the moved eligibility symbols so no existing
  call site changes.
- **`x` gender never blocks** (as the prompt asked, recorded here as the
  ruling): `mens`→`m`, `womens`→`f`, `mixed`→ roster needs ≥1 `m` and ≥1 `f`;
  an `x` row satisfies neither side of the mixed rule but is never itself an
  eligibility failure, in any category. A null gender is likewise not a failure
  unless the division's rules require the field.
- **Person get-or-create does NOT dedupe on name alone** — and the prompt's
  "honouring the existing persons identity index semantics" rests on a false
  premise: the only persons identity index is
  `persons_org_user_lane_uq (org_id, user_id, lane) where user_id is not null
  and lane='player' and merged_into is null`. There is no (org, name, dob)
  unique index and RS002 does not add one. Ruling: a `registration_players` row
  with a `user_id` resolves through `resolvePlayerPerson` (unchanged); a row
  without one reuses an existing person only when **dob is present** and
  exactly ONE non-merged player-lane person in the org matches
  (`lower(trim(full_name))`, `dob`); no dob, no match, or an ambiguous match →
  mint a new person. Rationale: a duplicate person is a one-click #404 merge,
  whereas fusing two same-named people (juniors especially) silently merges
  two humans' records and is not cleanly reversible.
- **New persons are created with `consent = {"public_name": true}`** (owner
  ruling 5). RS001's `materialise` inserts persons with the column default and
  therefore ships the ruling unimplemented — this is the producer.
- **`materialise` gains the `pair` branch.** It handled `individual` and `team`
  only, so a pair entry materialised an entrant with zero members. With
  `registration_players` a pair has real player rows; pair now takes the same
  per-player path as team.
- **`materialise` writes `registration_players.person_id`** — the column exists
  (V363) and nothing sets it, so the roster→person link that RS005/RS008/#404
  all read was inert.
- **jsonb `GenderRule` wins over the `mens`/`womens` category block for the
  same person** (review ruling, 2026-08-17, `registration-eligibility.ts`): a
  division carrying BOTH a jsonb gender rule and a first-class category used
  to double-emit for one root cause — `MISSING_GENDER` from both blocks, or
  `GENDER_NOT_ALLOWED` **and** `CATEGORY_MISMATCH` together. Fixed: within one
  person's evaluation the same code never fires twice; once the jsonb loop has
  emitted a gender-family code (`MISSING_GENDER`/`GENDER_NOT_ALLOWED`) for
  that person, the category block emits nothing further for gender — the
  organiser-authored jsonb rule is the more specific statement and wins.
  Roster-level `MIXED_NEEDS_BOTH_GENDERS` is a property of the roster, not the
  person, and is unaffected — it still fires independently. Matters beyond
  this session: this file is now shared with RS011, whose override dialog
  would otherwise render two rows for one problem.

**Wave 1 CLOSED** (`130d3f6a`, `d53554e0`, `f31abc21`). V368 applies on the
session DB and from zero (206 migrations → v367). The review loop found a
**fourth** hazard of the same family that RS001's list did not name, plus two
atomicity blockers on paths that were ALREADY live before RS002:

- The late-payment and withdraw refund paths each wrote the entry total and the
  cart total as **two autocommit statements**. A failure between them leaves
  Stripe refunded, the entry marked, the cart total stale — and logs the whole
  thing as `refund_failed`. Both are one `sql.begin` now, matching
  `refundRegistration`. Reachable on a single-entry cart, i.e. today.
- **Hazard 4 (unlisted): the lost-dispute write-off** overwrote the cart total
  with the EARLIEST entry's `amount_cents` (`order by r.created_at limit 1`)
  instead of accumulating the real `dispute.amount`, which was already in scope
  and already used for the audit row two lines above. Now
  `greatest(refunded_cents, ${dispute.amount})`.
- The `late` outcome had no webhook-redelivery guard: a redelivered
  `checkout.session.completed` re-entered the additive writes and relied
  entirely on Stripe rejecting the second refund. Guarded and tested.
- `RegistrationWithGroupRow` exposes the CART's total as
  `group_refunded_cents`; the bare `refunded_cents` on that type is now the
  ENTRY's. Seven pre-existing assertions were repointed at the cart field
  (dispute write-off and the Stripe-dashboard refund mirror are genuinely
  cart-scoped). `tsc` cannot see this distinction — both are `number` — so any
  new query joining the two tables must name the columns explicitly.

Gate at the wave boundary, rerun by the main thread with the placement service
running: `src/server/usecases/__tests__/` + `registration-schema.test.ts` =
**2382 total / 2351 passed / 0 failed / zero non-passing files**;
`registrations.test.ts` 64 tests (56 baseline + 4 hazard + 4 review);
`tsc --noEmit -p apps/web` EXIT=0.

**Placement proof (settles the false premise above).** With
`seazn-env up --label rs002 --placement` and `PLACEMENT_SERVICE_HOST` exported,
`schedule-build-honours-locks.test.ts` is **11/11** on this branch. Two
environment notes bought here: the script's readiness probe **failed against a
healthy service** (40s budget vs a cold `import ortools` under test-suite load)
and then killed it — fixed in the machine-local skill (import warmed
explicitly, budget 180s); and a full `usecases/__tests__` run reports
`failedSuites: 5` for 4 failed tests because vitest counts **describe blocks**
there, not files. That is not the collection-failure trap it resembles.

**Wave 2 CLOSED** (`23371bba`, `83b87b6e`, `2726ec66`). `registration-eligibility.ts`
is a new, dependency-free module (it imports NOTHING from `registrations.ts`,
which is what keeps the later `registration-submit.ts` /
`registration-approval.ts` edges acyclic); `registrations.ts` re-exports every
moved symbol, so **zero importers changed**. Exported surface: `ageAt`,
`isMinor`, `requiresDob` (overloaded — bare rules array OR a division, and the
division form is true whenever `age_min`/`age_max` is set), `EligibilityCode`,
`EligibilityIssue`, `divisionEligibilityIssues`, `rosterIssues`,
`formatEligibilityIssues`, and the legacy `eligibilityIssues` string wrapper.
Gate at the boundary: 39 eligibility tests, 2421 total / 2389 passed;
`tsc` EXIT=0.

- **The evaluator returns CODES, not sentences** — done in response to RS011's
  entry condition 5 landing mid-wave. Display strings come from
  `formatEligibilityIssues`, which also owns the `Player <n> (<name>): ` prefix
  so RS011 can render `playerIndex`/`playerName` as separate fields.
  Deliberately **no `severity`** on the issue: RS011 calls
  `MISSING_DOB`/`MISSING_GENDER` warnings while registration submit must keep
  treating them as blocking, so classification belongs to the caller and is
  keyed off `code`. `MIXED_NEEDS_BOTH_GENDERS` is RS002's addition — RS011's
  list is individual-level and has no roster-level code.
- **A wrapper-vs-delegate test is a tautology, and one shipped here before the
  review caught it.** W2b replaced the legacy wrapper's literal-string
  assertions with `eligibilityIssues(...) === formatEligibilityIssues(
  divisionEligibilityIssues(...))` — the exact path the wrapper delegates to,
  so it cannot fail. The wrapper exists SO THAT existing callers keep seeing
  byte-identical sentences; that guarantee needs hardcoded text. Five
  literal-string tests restored, one per code.

**The `org-posts-digest.test.ts` red is the sweep-suite-on-an-accumulated-DB
trap, NOT a flake and NOT load.** It failed in three separate runs on the
session DB and passed alone, which reads like flake; the real message (visible
only via `--reporter=verbose` — both `rtk` AND a bare `npx vitest --reporter=json`
render it `STACK_TRACE_ERROR`) is `Test timed out in 30000ms`.
`sweepWeeklyDigests` walks every org in the schema, and `registrations.test.ts`
creates orgs throughout its run, so the sweep's working set grows while it
sweeps. Proof, not assertion: the same two suites on a **fresh** DB are
**71/71**. Consequence for the rest of RS002 and for RS003+: run the gate on a
fresh schema, and never read a 30s timeout in a sweep suite as an assertion
failure.

**Wave 3 CLOSED** (`3ddbb7a2`, `82d2ae93`, `8d79c9cf`). Materialisation now
implements design §6 and owner ruling 5 in full. Gate: 2438 total / 2407
passed / 0 failed, 17 materialise tests, `tsc` EXIT=0.

- **Person get-or-create, and the false premise behind the brief.** The prompt
  says to honour "the existing persons identity index semantics" for a
  `(org, name[, dob])` lookup. **No such index exists** — the only one is
  `persons_org_user_lane_uq (org_id, user_id, lane) where user_id is not null
  and lane='player' and merged_into is null`. Ruling as implemented: a player
  row WITH `user_id` resolves through `resolvePlayerPerson` (unchanged); a row
  WITHOUT one reuses a person only when the row has a **dob** and **exactly
  one** non-merged `lane='player'` person in that org matches
  `lower(trim(full_name))` AND that dob. No dob, no match, or **two or more
  matches** → new person (`matches.length === 1`, deliberately not `limit 1`).
  A duplicate person is a one-click #404 merge; fusing two same-named juniors
  is not cleanly reversible.
- **Owner ruling 5 was shipping HALF-implemented, and the brief caused it.**
  `findOrCreatePlayerPerson` set `consent.public_name = true` on the anonymous
  path, but `resolvePlayerPerson` — excluded by the wave brief — still created
  linked persons with the bare `{}` default. So a registrant who ticks the
  consent box themselves got NO consent recorded, while someone entered by a
  club rep did. Reachable from all four `materialise` call sites. Fixed: the
  insert names `consent`; the `do update` branch still never touches it,
  because a returning person may have opted out.
- **The idempotency test was measuring the caller, not the function.** Every
  `materialise` call site short-circuits first (`status === 'confirmed'` at
  `registrations.ts:2082` and its three siblings), so calling
  `confirmRegistration` twice never re-enters `materialise` — its own
  `if (reg.entrant_id) return` guard and both
  `on conflict (entrant_id, person_id) do nothing` clauses had **zero coverage
  in the repo**, and deleting the guard failed nothing. Now forced by seeding
  a row with `entrant_id` set and `status` left non-confirmed. Same class:
  `person_id` write-back was asserted only for `team`; the `individual`
  branch's own write was untested.
- `pair` shares the team path (it previously materialised an entrant with zero
  members); `squad_number` and `is_captain` both carry; `loadPlayers` now
  selects `is_captain` rather than only ordering by it.
- `persons` already has `force row level security` (V227) enforcing org
  isolation independently of the app-level `org_id` filter — which makes an
  org-leak mutation check unfalsifiable by design, not by defect. The explicit
  filter stays as defence in depth.

**Wave 5** (`ab209fdf9`, branch `feat/rs002-registration-usecases`). Approval
transitions (`registration-approval.ts`, new): `approveRegistration`/
`rejectRegistration` (manual-mode only, `rejected` terminal, idempotent,
materialise reused verbatim), `withdrawRegistration` (thin re-export of the
existing `withdrawRegistrationOrganiser` — approval transitions is meant as
the whole organiser-facing lifecycle surface, not a reimplementation of an
already-correct, already-tested withdraw), `promoteFromWaitlist`
(oldest-first default + explicit-id override, both routed through the same
fixed core). Plus the two read models: `groupByRef` (constant-time token
compare, identical 404 for a wrong token and a nonexistent ref) and
`listRegistrations` extended with competition-wide + kind/free_agent/
consent_pending/text filters — `divisionId` widened to `string | null`
(backward compatible; the live `/api/v1/divisions/[id]/registrations` route
still passes exactly 3 args unchanged).

- **The wave-4-routed promotion clobber, ruling taken:** of the two shapes the
  brief allowed, chose **scope the write, not the column** — `promoteWaitlistedRow`
  (factored out of `promoteOldestWaitlisted`) now skips the
  `registration_groups.payment_method`/`expires_at` write entirely whenever
  another entry in the same cart is still `pending` (the exact predicate
  `sweepRegistrations`' own due/overdue queries already use for "still
  watching this envelope"). Rejected the per-entry-`expires_at`-column
  alternative outright: it needs a migration, and this wave's file set
  excludes `db/migration/**`. `payment_method` is scoped the same way as
  `expires_at` even though wave 4's `assertUniformPaymentMethod` already
  makes every PAID division in one cart agree at submit time — that
  invariant is submit-time-only (a division's `payment_method` can still
  change afterwards), so it narrows the hazard but does not close it. Proven
  red against the pre-fix unconditional write via a manual mutation
  round-trip (reverted immediately after): the ROUTED MAJOR test failed with
  `expected 'offline' to be 'stripe'`, exactly the clobber the fix closes.
- **Also found and fixed, same file, same session (not separately routed):**
  none beyond the above — `materialise`'s own unconditional
  `registration_groups.expires_at = null` on confirm (same clobber CLASS,
  reachable via `approveRegistration`'s call to `materialise`) was noted but
  **deliberately left alone**: fixing it touches `materialise` itself, which
  the wave-5 file scope names only for reuse ("do not reimplement it"), and a
  multi-entry-cart confirm-time interaction is a big enough surface to want
  its own reviewed change rather than a rushed addition here. Flagged for
  whoever picks up cart-level money/expiry work next.
- Gate: `usecases/__tests__/` + `registration-schema.test.ts` = **2491 total /
  2459 passed / 1 failed** (the pre-existing `org-posts-digest.test.ts`
  accumulated-DB sweep timeout, not this wave's); narrow suite
  (`registration-approval.test.ts` + `registrations.test.ts`) **80/80**.
  `tsc --noEmit -p apps/web` EXIT=0. `lint` 75 warnings / 0 errors, none in
  touched files (unchanged from the RS001b baseline).

**Wave 5 review round** (`cf1b994b5`). 3 blockers + 4 majors, all in
`registrations.ts` — introducing `rejected` had left a set of PRE-EXISTING
writers (none of them touched by the first wave-5 commit) with no guard
against it. Two rulings from the orchestrator disambiguated intent, both
recorded here because they bind future sessions too:

- **RULING A — `rejected` is terminal from EVERY writer, no exceptions.** No
  path may move a rejected row to any other status. Closed in
  `confirmRegistration` (fell through to `materialise` — BLOCKER),
  `confirmPaidRegistration` (a rejected reg with a live `payment_intent_id`
  fell to the default branch and was silently confirmed on a late/replayed
  Stripe webhook — **the worst finding of the session**: money taken AND an
  entrant materialised for a registration the organiser had explicitly
  refused; now folded into the same withdrawn/expired dead-registration
  branch — refund, never confirm), `markRegistrationPaidOffline` and
  `confirmRegistrationWaived` (explicit guards added; their pre-existing
  status allowlists already excluded `rejected` implicitly, so this closes a
  self-documentation/defense-in-depth gap rather than a live hole — the new
  tests assert the SPECIFIC rejected message, not just the 422, since a
  revert of the new line alone does not flip the status code), and
  `withdrawCore` (silently flipped a rejected row to `withdrawn` — reachable
  from both `withdrawRegistrationOrganiser` and the public
  `withdrawRegistrationByRef` — MAJOR).
- **RULING B — manual mode blocks the AUTOMATIC confirmer, not the
  organiser.** An organiser explicitly clicking confirm/mark-paid/waive IS
  an approval decision, so `confirmRegistration`/`markRegistrationPaidOffline`/
  `confirmRegistrationWaived` are UNCHANGED — they still confirm on a manual
  division. Only `confirmPaidRegistration` (the Stripe webhook — the
  machine, not a human) got a manual-mode check: a payment landing on a
  manual-approval division now lands `paid` and stops, waiting for a human
  via `approveRegistration`. New `PayOutcome` kind
  `paid_awaiting_approval`: revalidates the public page (status genuinely
  changed) but deliberately skips the growth-loop `first_paid` earn grant —
  money moved, but nothing is confirmed yet and a reviewer can still reject
  it.
- **`promoteWaitlistedRow`'s clobber fix was still wrong in two ways the
  first wave-5 commit missed, both closed together:**
  1. The `pendingSiblings` count took no lock — a genuine TOCTOU race
     between two concurrent promotions of different waitlisted siblings in
     the same cart. Fixed by folding the guard INTO the `registration_groups`
     UPDATE itself (`case when not exists (...) then … else … end`) rather
     than a separate SELECT — one atomic statement, no window. Postgres's own
     row lock on the group row does the serializing: a second transaction's
     `not exists` subquery only evaluates after the first commits.
  2. Bigger: when the write was SKIPPED (a pending sibling existed), the
     PROMOTED entry inherited whatever envelope was already there — a
     card-fee promotion into a cart whose only prior envelope was
     offline/null got NO checkout link and NO `expires_at`, and because
     `sweepRegistrations`' overdue query requires `expires_at is not null`,
     it could never expire: a permanently unpayable, permanently
     un-expirable promotion. Fixed: `expires_at` is now MONOTONIC, not
     conditional — `greatest(coalesce(expires_at, now()), now() + 48h)`,
     always applied when the entry itself needs a Stripe window, so a
     promotion can only ever EXTEND the cart's deadline, never shorten or
     null a sibling's. `payment_method` stays `not exists`-guarded (kept
     conditional on purpose — "extend" has no meaning for a method).
- **The gap flagged and deliberately NOT fixed in the first wave-5 commit —
  `materialise`'s unconditional `registration_groups.expires_at = null` on
  confirm — turned out broader than flagged and WAS fixed this round,** per
  the orchestrator's explicit "no-new-issues rule applies" ruling: it fired
  from all FIVE confirm paths (`confirmRegistration`,
  `markRegistrationPaidOffline`, `confirmRegistrationWaived`,
  `confirmPaidRegistration`, `approveRegistration`), not just the one this
  wave added. Same `not exists` pending-sibling guard, keyed on
  `reg.group_id`; `materialise`'s signature is unchanged.
- All seven findings proven red by reverting each guard in isolation and
  rerunning its specific test (Major 2's specifically via a deterministic
  `statementCount()` delta — 3 statements fixed vs. 4 reverted — rather than
  a true concurrency test, after a genuine two-transaction lock-staging
  attempt proved unreliable in this environment; see
  `registration-approval.test.ts`'s comment on that test for why). Gate after
  the review round: **2502 total / 2470 passed / 1 failed** (same
  `org-posts-digest.test.ts`, still not this wave's); narrow suite **91/91**;
  `tsc` EXIT=0; `lint` 75/0, none in touched files.

## RS002 entry conditions (RS001 hands these over — do not start without reading)

1. **Cart-level money is flattened onto entry-level rows.** `RegistrationWithGroupRow`
   merges the cart's payment envelope onto one entry. That is exact while carts
   are 1:1 with entries — all that exists today — and wrong the moment RS002
   ships multi-entry carts. Three shapes in `usecases/registrations.ts`, none
   caught by a typecheck, all flagged inline pointing at the block comment above
   `RegistrationWithGroupRow`:
   - `stripeRefund(intent, undefined)` refunds the cart's FULL remaining balance
     (withdraw path and the late-payment webhook path) — refunding one entry
     would claw back its siblings' money. Pass the entry's own `amount_cents`,
     as `refundRegistration` already does.
   - `set refunded_cents = <entry fee>` OVERWRITES the cart total instead of
     accumulating. The correct pattern already exists in that file
     (`greatest(refunded_cents, …)` on the dispute path).
   - `remaining = reg.amount_cents - reg.refunded_cents` subtracts a cart total
     from an entry fee — a sibling's refund drives it negative and the organiser
     gets "Already fully refunded" for an untouched entry.
   **The decision RS001 deliberately did not take**: whether per-entry refunds
   get their own `registrations.refunded_cents` or are derived. It belongs with
   the group-submit design, and the schema for it is a one-column delta.
2. **The privacy-consent rule went out with `submitRegistration`.** The deleted
   test "rejects submissions without privacy consent (GDPR, spec 2026-07-14)"
   guarded a submit-time check that no longer exists anywhere. RS002/RS003 must
   reimplement it on the group submit path — this is a compliance rule, not a
   nicety, and nothing in the tree will fail without it.
3. **`waitlist-queue.tsx` is kept but unwired** (for RS005's Registrants tab)
   and its coverage died with `reg-console.spec.ts` — queue order, #-in-line and
   the public waitlist count now have no test at any level. Its view-model also
   declares `contact_email`/`payment_intent_id`, which RS005 must source from
   the CART; selecting them off `registrations` fails at runtime, not compile
   time.
4. **RS001b: the group insert must name `currency`.**
   `registration_groups.currency` is NOT NULL with NO default — an insert that
   omits it fails at RUNTIME (23502), never at compile time, because the insert
   is raw SQL. The value is `organizations.currency` read at submit, and it is
   never rewritten afterwards: not by a promotion, not by the Connect
   same-currency lock converging, not by an org changing its preference. RS003's
   checkout endpoint validates the snapshot against BOTH
   `REGISTRATION_CURRENCIES` and the org's CURRENT currency before calling
   Stripe (422, no Stripe call) — a snapshot gone stale is exactly the case that
   must not reach a registrant's pay page.

5. **RS011 consumes RS002's evaluator, so its RETURN SHAPE is a contract, not an
   implementation detail.** `eligibilityIssues()` on `main` today returns
   `string[]` — human sentences (`usecases/registrations.ts:177-181`). RS011
   needs machine codes (`AGE_TOO_OLD | AGE_TOO_YOUNG | GENDER_NOT_ALLOWED |
   CATEGORY_MISMATCH`, warnings `MISSING_DOB | MISSING_GENDER`) to fill a 422's
   `extra.violations[]` and to let the override dialog list offenders. **RS002
   should return structured issues and derive display strings at the edge.** If
   it ships strings, RS011 changes the shape and adapts RS002's call sites — the
   handover is written down here so that lands as a known cost, not a surprise.
   Likewise `rosterIssues(division, players[])` should take a plain
   `{dob, gender}` shape, not a `registration_players` row, so the organiser
   gates can call it against `persons`. **Two eligibility evaluators is the exact
   failure the RS011 re-homing exists to prevent.**

## RS003 entry conditions (RS002 hands these over — verified 2026-08-17, not asserted)

Written at RS003 kickoff after two scouts read the tree, because the RS002
close-out believed these were already recorded here and they were not. Every
claim below carries its `path:line`.

1. **Checkout minting is NOT an empty seam — it is a LIVE per-registration one.**
   `submitRegistrationGroup`'s own doc comment (`registration-submit.ts:301-303`)
   correctly says minting is RS003's job, and no group/cart-level session
   creator exists. But `createRegistrationCheckout`
   (`registrations.ts:1242-1303`) does exist, charges ONE
   `RegistrationWithGroupRow`'s `amount_cents`, and is reachable today from
   `resumeRegistrationCheckout` (`:2107`) and both waitlist-promote paths
   (`:894`, `:2299`). So RS003 is not adding minting to a blank slate; it is
   introducing a cart-scoped session alongside a live entry-scoped one. Decide
   explicitly whether the entry-scoped path is re-pointed at the group or kept,
   and make the metadata unambiguous either way — see 2.
2. **The webhook keys by a single registration id.** `billing-events.ts:115-116`
   dispatches on `session.metadata.kind === "registration"` into
   `handleRegistrationCheckoutCompleted` (`registrations.ts:1315-1335`), which
   reads `session.metadata.registration_id` and `metadata.fee_percent`, then
   calls the private `confirmPaidRegistration` (`:1348`). `createRegistrationCheckout`
   also stamps `payment_intent_data.metadata = {registration_id, org_id}`
   (`:1272-1277`, `:1291`). A group session therefore cannot simply reuse
   `kind: "registration"` with a group id in the same key — the old handler
   would take the group id for a registration id.
3. **Currency 422 rule** — unchanged, restated so RS003 does not have to find it
   under RS002's heading: validate `registration_groups.currency` against BOTH
   `REGISTRATION_CURRENCIES` and the org's CURRENT `organizations.currency`
   BEFORE any Stripe call; a stale snapshot is a clean 422 with a stable error
   shape, never a Stripe error on a registrant's pay page. The snapshot itself
   is already written correctly at submit — `registration-submit.ts:497` names
   `currency` from `organizations.currency` (RS001b's NOT NULL, no default).
4. **What the deleted route actually did**, from `git show 850cc6308^` — the
   brief says "as the old route did" without the numbers:
   - buckets: `regsubmit:${ip}` `{max:10, windowSeconds:60}`, then
     `regsubmit:${ip}:${division_id}` `{max:5, windowSeconds:300}` — the second
     fired AFTER the honeypot check, and re-keys to the competition for a cart.
   - honeypot: field **`website`**, `throw new HttpError(400, "Registration failed")`.
   - locale: `explicitLocale(req)` read cookie **`seazn_locale`**, `hasLocale`-validated,
     passed as `locale` to the usecase; null means "fall back to org default".
   - privacy gate: enforced in the USECASE, not the route —
     `HttpError(422, "Please agree to the privacy policy to register")`.
     `SubmitGroupInput.privacy_consent` (`registration-submit.ts:91-99`) is the
     RS002 replacement; confirm it still throws before trusting it.
   - response was `{registration_id, status, ref_code, access_token, checkout_url}`.
5. **FALSE PREMISE in the RS003 prompt: "mirror the old route's tests" — there are
   none to mirror.** `git grep -a` for `honeypot|website|429|rate` across the five
   deleted e2e specs and `public-register-request.test.ts` returns ZERO hits. The
   honeypot and both rate-limit buckets lived only in `route.ts` and were never
   covered at any level. RS003 writes that coverage fresh; restoring a pattern is
   not an option.
6. **Status is server-side, so RS003 owes no GET route.** Old and current tree
   both read status inside the page component (`register/status/page.tsx`,
   `r/[ref]/page.tsx`) — no HTTP status endpoint ever existed. The read model
   RS007 will consume is **`groupByRef`, and it is in `registrations.ts:2031`,
   NOT `registration-approval.ts`** (the RS002 close-out filed it under the
   wrong module). Its token compare is already correct — `tokenMatchesHash`
   (`:2014`) is `timingSafeEqual` against `DUMMY_ACCESS_HASH` (`:2003`) even for
   a nonexistent ref, and both misses throw the identical `404
   "registration not found"`. **The older `publicRegistrationStatus*` paths
   (`:1728`, `:1801`) still compare with SQL `=`** — not constant-time, and RS007
   inherits that if nobody re-points them.
7. **Entry points RS003 calls:** `submitRegistrationGroup(ctx, input)`
   (`registration-submit.ts:305`) — `ctx` is `{orgSlug, compSlug, sessionUserId?}`,
   returns `{group_id, ref_code, access_token, currency, amount_cents (subtotal,
   non-waitlisted only), entries[]}`; and `joinTeamEntry(ctx, input)`
   (`registration-submit.ts:710`). The group insert, `ref_code` retry loop,
   `access_token` minting and per-entry `join_code` (team, non-free-agent only)
   are all already inside the usecase — the endpoint must not re-do them.
8. **`schemas.ts` is 3502 lines** and already carries a comment at `L1841-1846`
   stating the old single-entry public request/response pair was deleted and that
   RS003 owns defining the group-shaped replacements. Public registration schemas
   sit at `L1803-1871`, org-authed ones at `L1690-1802`. OpenAPI generator entry:
   `api-v1/openapi.ts:10`.

## RS011 — why #412 moved here (2026-08-17)

`L1-412-w1-eligibility.md` in `../2026-08-06-scoringpad-v2-prompts/` was written
2026-08-06 against the pre-RS registration model and is now half-dead: its
evaluator, its dob/gender-on-player-input, its confirm/waive/mark-paid gates and
its confirm-panel UI are all RS002/RS003/RS005 scope, and it assumed eligibility
lived **only** in `divisions.eligibility` jsonb — RS001 made `category`/`age_min`/
`age_max` first-class columns (`V364__registrations_regroup.sql:110-116`).
Running it as written would have forked the eligibility model in two.

The surviving half — the **organiser-side** gates (`createEntrants`,
`insertMembers`, `patchEntrant`, `syncEntrantRosterFromSquad`, `setTeamSquad`,
imports, `putLineup`), the audited override, and the override dialog — touches no
file the RS lanes touch and is now `RS011-organiser-eligibility-gates.md`. Issue
**#412 stays the issue**; the old `L1` row is marked SUPERSEDED with a pointer
here. `L2`/#413's "needs L1 merged first" dependency was **file-overlap
sequencing only** and is deleted; `L2` now sequences against RS
(`api-v1/schemas.ts`), not against `L1`. `L3`/#414 was never related to either.

## False premises found

- **"Only `registrations.ts` reads the payment columns" — WRONG, and it is the
  premise the whole payment-columns verdict rested on.** The scout sweep that
  produced it searched by column name and missed three production readers that
  build the column names inside larger SQL templates:
  `usecases/competitions.ts` (~546) and `usecases/divisions.ts` (~346) guard
  deletes on `r.payment_intent_id` / `r.refunded_cents`, and
  `usecases/exports.ts` (~627) builds admit-ticket QR URLs from `r.ref_code`.
  `tsc` cannot see any of it — raw SQL strings — and every scoped test run the
  implementers did was green. Only the **full-suite rerun at the wave boundary**
  caught it: 20 failures across 7 suites. The verdict itself still stands (the
  columns do belong to the cart); what was wrong was believing the search.
  Lesson for RS002+: after any column move, grep for `from <table>` /
  `join <table>` and read each hit, not for the column names.
- **Sweeping e2e by FILENAME missed the spec that mattered.** The RS001 sweep
  worked from a scout list of `registration*.spec.ts` / `reg-console.spec.ts`
  and cleared them all — then CI failed 4 tests in
  **`payments-hardening.spec.ts`**, which creates registrations with raw SQL,
  POSTs the deleted public register endpoint, and navigates the register page
  expecting a form. Nothing in its name says "registration". Local unit runs
  could not see it either: it is Playwright-only, and the e2e job is the first
  thing that executes it. For RS002+: sweep by BEHAVIOUR
  (`git grep -a -n -E "insert into registrations|/register|registration_settings" -- apps/web/e2e`),
  never by filename — and remember `payments-hardening.spec.ts` is one of the
  four specs `e2e.yml` names explicitly, so it runs on every PR.
- **"`seed:demo` may seed registrations" (RS001 prompt gotcha) — it does not.**
  `scripts/seed-demo.ts` touches registration exactly once, a
  `registration-settings` PUT (~1085), and writes no registration rows at all.
  No seeder work was owed.
- ~~**`schedule-build-honours-locks.test.ts` is RED ON MAIN**~~ — **WRONG, and
  corrected 2026-08-17 (RS002).** The 4 failures
  (`expected undefined to be '2026-08-01T19:00:00.000Z'`) are a **missing local
  placement service**, not a code red: the suite is **11/11** with the CP-SAT
  service running (`seazn-env up --label X --placement`, see the
  `seazn-local-env` skill §3b/§5). Both RS001 and RS001b gates reported these 4
  as "red on main too" and waved them through; the reproduction on a clean
  detached worktree proved only that the *other* worktree also lacked the
  service. Any RS session seeing exactly these 4 should start the placement
  service before calling them pre-existing.

- **`seazn-local-env` skill vs `AGENTS.md`**: the skill still says "never
  enable `.github/workflows/e2e.yml`". It has been **LIVE on PRs since
  2026-08-14** (AGENTS.md is right; the skill is stale). Bearing on RS001: the
  workflow names only `mobile.spec.ts`, `payments-hardening.spec.ts`,
  `ai-architect.spec.ts` and `placement-cutover.spec.ts` by filename — no
  registration spec — but **`mobile.spec.ts` probes registration-settings**, so
  deleting that surface without editing that spec reds live CI.

## Gotchas discovered

- Test-DB ports **54329 and 54341 were both squatted** by other sessions on
  2026-08-16: `pg_ctl` exited 1 while `psql` cheerfully answered from the
  foreign server. RS001 ran on **54367** after checking `show data_directory`.
- `.env.local` (root and `apps/web`) points `DATABASE_URL` at the **dev** DB on
  `:5432`, and `vitest.globalSetup.ts` deliberately does not load it — a
  DB-backed run must pass `DATABASE_URL` explicitly or every DB suite SKIPS
  while `total` stays unchanged.
- **Run vitest from `apps/web`, not the worktree root** — the `@/` alias lives
  in `apps/web/vitest.config.ts`, so a root-launched run dies with
  `Cannot find package '@/lib/db'` and reports `total: 0` (a collection
  failure, not a pass).
- **A subagent destroyed uncommitted work**: it decided the worktree "was never
  created", wrote its files into the **main checkout**, then "repaired" by
  reverting — taking this file's uncommitted edits with it, and stalling at the
  600s watchdog. Every RS dispatch since carries an explicit "the worktree
  exists; never create/remove one; never `git checkout|restore|reset|clean|
  stash`; commit at each milestone" block.
