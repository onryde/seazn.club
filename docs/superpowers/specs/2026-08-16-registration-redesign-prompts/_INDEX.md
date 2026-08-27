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
| RS003 | `RS003-public-endpoints.md` | RS002 | **DONE** — PR #615 merged `29690ec8c` (2026-08-18) |
| RS004 | `RS004-hub-settings-tab.md` | RS003 | **DONE** — merged `171df1376` (PR #641, 2026-08-25). Smoke still owed by RS010, as the PR states |
| RS005 | `RS005-hub-registrants-tab.md` | RS004 | **DONE** — merged `9d2ad39bc` (PR #651, 2026-08-26), 16/16 checks green. Known-open and stated in the PR: no pagination in the read path; `resend-confirmation` has no throttle (mirrors the pre-existing `/remind`). Smoke still owed by RS010 |
| RS006 | `RS006-public-stepper.md` | RS003 | **DONE** — merged `ec5cc6e3a` (PR #666, 2026-08-27), 9/9 checks + seven-width e2e green. Follow-ups merged `81f2198a1` (PR #668) fixed three defects found by USING the flow, none of which three review passes caught: RS005's "public sign-up page isn't live yet" notices were still telling organisers the link and QR do not work; "This is me" was not exclusive within a division (one person, two slots, charged twice); step 3 blocked with a step-wide message and no field marked. Smoke still owed by RS010 |
| RS007 | `RS007-status-page-join-payments.md` | RS006 | TODO |
| RS008 | `RS008-consent-claim-optout.md` | RS007 | TODO |
| RS009 | `RS009-free-agents.md` | RS005, RS003 | TODO |
| RS011 | `RS011-organiser-eligibility-gates.md` | RS002 | TODO — issue #412, re-homed from `L1` |
| RS010 | `RS010-closeout-e2e-smoke-help.md` | all | TODO |

Public registration was **intentionally down** between the RS001 and RS006
merges (owner-accepted; prod has zero registration usage). That window
**CLOSED on 2026-08-27** with `ec5cc6e3a`: the register page serves the real
five-step stepper, `/r/[ref]` renders the cart, and both share links and
printed QR codes work. Anything still asserting or announcing "not open" is
stale — two such notices survived the merge for an hour and had to be removed
in `81f2198a1`; check for more before trusting any copy in this area.

**Read before starting RS007** — the stepper's contract as SHIPPED, plus two
things RS007 inherits:

- Checkout returns to `/shared/<org>/<comp>/register/status?rid=…&token=…`,
  **not** `/r/<ref>`: `createRegistrationCheckout`'s `returnBase` takes the
  token branch whenever a token exists, which a cart submit always has.
  `/r/<ref>` is the token-less from-an-email route. The missed-webhook
  self-heal (`reconcileRegistrationBySession`, `registrations.ts:2522`) is
  wired into `/r/[ref]` **only** — the status page ignores it and the
  `session_id` Stripe appends for it.
- `join_code` is minted **only** for `entrant_kind === "team"`, so a `pair`
  entry has no join path at all. RS007 must decide this explicitly before
  being estimated — see its spec's "Found while using the shipped RS006 flow".

The paid path is proven end to end by
`apps/web/e2e/registration-connect-walkthrough.spec.ts` (opt-in
`RS006_CONNECT_WALKTHROUGH=1`; `WALKTHROUGH_WATCH=1` to watch it). It is the
only place `checkout.session.completed` is genuinely produced.

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

**DONE — merged 2026-08-17 as PR #607** (`4ff0bf8f`). Worktree and gate DBs
below are gone; the rulings they carry still hold.

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

### RS003 (2026-08-18) — branch `feat/rs003-registration-endpoints`

**DONE — merged 2026-08-18 as PR #615**, merge commit `29690ec8c` on `main`
(branch tip `a07184627`, now an ancestor of `main`). All six waves closed; the
worktree `.claude/worktrees/rs003` and its environment (DB `seazn_rs003b`,
prod server, placement service) were torn down after the merge.

- **Wave plan as run** (sequential — the file sets overlap, so never parallel):
  W1 schemas → W2 routes (`app/api/v1/public/.../register/**`) → W3 payment
  orchestration + webhook re-key (`registrations.ts`, `billing-events.ts`) →
  W4 deep-dive tests → W5 live Stripe probe → W6 e2e + whole-branch review.
- The session-environment notes that used to sit here (DB label `rs003b` on
  `127.0.0.1:54671`, prod server, placement port) are dropped — that environment
  is gone. The V-number-collision and watchdog rulings below are NOT
  session-local and apply to every later RS session.
- **The V-number collision recurred, one merge after RS002 recorded it.** `main`
  briefly held TWO V368s — F1's `V368__fixture_round_role.sql` (#606) and
  RS002's `V368__registration_entry_refunds.sql` (#607) — and Flyway refuses to
  run AT ALL in that state (`Found more than one migration with version 368`),
  so no fresh clone, worktree or CI Postgres job could build a schema. Both PRs
  were green in isolation; the collision existed only in the merge, because each
  renumbered off P8's V367 independently while open. Fixed on `main` by
  `604767c63` (registration refunds → **V370**; F1 keeps V368+V369 because they
  are a pair). **RS003's own deltas start at V371.** Consequence for every RS
  session: a DB built before that rebase has `V368 = registration refunds` in
  its Flyway history and CANNOT be reused after it — ours was destroyed and
  rebuilt, not migrated.
- **A 600s watchdog stall cost a full wave.** W1's first implementer ran `tsc`
  (~2.8 GB, minutes) and a broad vitest run inside its own loop, stalled
  mid-TDD-red, and died with ZERO commits — the same failure RS002 recorded
  three times. What fixed it on the retry: the brief FORBIDS the agent running
  `tsc`, lint, or the broad suite at all (the orchestrator runs those at the
  wave boundary), requires foreground-only commands, and requires a commit at
  red, at green and at contract-regen. Second attempt: three commits, no stall.

**Wave 1 CLOSED** (`c93071a3d` red, `715ce17fe` green, `fc5c6333c` review fix).
Exports: `PublicRegisterGroupRequest`/`Response`, `PublicJoinRequest`/`Response`,
plus `PublicRegisterGroupContact`/`Player`/`Entry`/`EntryResult`. Gate rerun by
the main thread: api-v1 suite **396 total / 396 passed / 0 failed / 0 failed
suites**; root `turbo typecheck` **2/2 successful**; `openapi:gen` +
`i18n:gen-keys` → `git status --porcelain` empty.

- **Bounds chosen (the brief asked for a number and said to record it): max 10
  entries per cart, max 50 players per entry.** The 10 also keeps the W3 Stripe
  metadata under the 500-char value limit if entry ids are listed there.
- **`currency` on a public REQUEST is stripped, not rejected** — never declared,
  and these schemas are not `.strict()`, matching every other public request
  schema in the file. Recorded because "reject" is the other defensible choice
  and a future reader will wonder which was meant.
- **`checkout_url` ships required-but-nullable from W1**, before W3 can fill it,
  so the wire contract never widens later.
- **Review fix, found by the orchestrator reading the diff, not by the
  implementer: the refinement defaulted a missing `self_player_index` to 0.**
  The usecase resolves `self_player_index ?? (individual && players.length === 1
  ? 0 : undefined)` and, on `undefined`, leaves `selfIndex` null and DROPS the
  self declaration silently (`registration-submit.ts:383-393`). So a TEAM or
  PAIR entry claiming `registering_self` without naming its row validated
  cleanly and fell straight into that drop — the entry submits, the registrant
  is never linked to their own player row, and no layer errors. The schema is
  the only place that can surface it, which is what its own comment claimed it
  was for. Now mirrors the usecase arm for arm.
- **Two of the three tests added with that fix do not discriminate.** Mutated
  back to `?? 0`, exactly ONE of 27 fails (the team case). The free-agent-with-
  no-players and individual-implied-0 cases hold under both rules and are
  labelled in the file as characterisation. Written down because three tests
  beside one fix reads as three proofs.
**Wave 2 CLOSED** (`cf76cd423` routes + tests, `29504f212` orchestrator fixes).
`POST .../register` and `POST .../register/join` under
`app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/`. Gate rerun by
the main thread: routes + api-v1 **416 total / 416 passed / 0 failed / 0 failed
suites**; `turbo typecheck` **2/2**; `openapi:gen` + `i18n:gen-keys` →
`git status --porcelain` clean.

- **The narrow bucket is keyed `regsubmit:${ip}:${orgSlug}:${slug}`, NOT on the
  competition slug alone.** `competitions_org_id_slug_key` is unique on
  `(org_id, slug)`, so two orgs may each run a "cup" and a slug-only key made
  one tenant's registrants spend the other's budget. The old route keyed on
  `division_id` (globally unique uuid) and could not express this bug — the
  re-key to competition scope is what introduced the ambiguity, so it is this
  session's to own. Buckets as shipped: `regsubmit:${ip}` 10/60s, then the
  honeypot, then `regsubmit:${ip}:${orgSlug}:${slug}` 5/300s; join gets
  `regjoin:${ip}` 5/300s.
- **Rate-limit tests here are vacuous unless the module is mocked.** `rateLimit`
  fails OPEN with no Redis, and vitest has none — firing 11 requests "proves"
  the limiter whether or not the route ever calls it. Both suites `vi.mock`
  `@/lib/rate-limit` and assert the exact key/config per bucket in order, plus
  a case where the limiter throws and the route must surface it rather than
  swallow it.
- **`openapi.ts`'s `ROUTES` table is not optional for a new route.**
  `openapi-coverage.test.ts` walks `route.ts` files against that table 1:1, so
  an unregistered route is a deterministic red. But registering it is only half
  — **`openapi-coverage` and `openapi-published` both pass against a STALE
  `openapi/v1.json`**, because they read the table, not the committed artifact.
  The drift gate is CI-only. W2's first commit shipped exactly that state: 17/17
  green locally, two stale spec files, a red CI job waiting. Always finish with
  `openapi:gen` + `git status --porcelain`.
- **`turbo typecheck` is the only thing that sees a test file's types.** W2's
  `join-route.test.ts` interpolated an `unknown` (`Envelope.data.player_id`)
  into the `sql` tag — `TS1320` + `TS2345` — while its own suite ran 17/17
  green, because **vitest never typechecks test files**. Consequence of the
  anti-stall rule that implementers no longer run `tsc`: the boundary gate is
  load-bearing, not ceremonial.
- **Join route ignores its own `orgSlug`/`slug` path segments, deliberately.**
  `join_code` is globally unique (RS001's partial unique index), so
  `joinTeamEntry` needs no scoping — a join link posted at the wrong org's URL
  still resolves. No security consequence (the code IS the secret), but RS007
  should not assume the path is validated.
**Wave 3 CLOSED**, split into 3a (mint) and 3b (webhook) because both write
`registrations.ts` — sequential, never parallel. Commits `d57384032`,
`dca065a27`, `7dc86c0f7`, `554d89aac`, `864154032`, `9f5ece77f`, `aac6d9679`,
`91b2ff5f5`, `7a2786cf1` (3a); `a9833d539`, `1d6ba5344`, `da9595c5c`,
`f2f5528c3` (3b). Gate rerun by the main thread with placement running:
**2993 total / 2962 passed / 0 failed / 0 failed suites / 31 pending**;
`turbo typecheck` **2/2**; lint **75 warnings / 0 errors** (main's baseline);
`openapi:gen` + `i18n:gen-keys` → porcelain empty.

- **A checkout session covers a SET of entries in ONE group, not "the cart".**
  Waitlist promotion pays for a single entry whose siblings may already be
  paid, so the unit is an explicit id list. `createRegistrationCheckout(groupId,
  registrationIds[], ctx, origin, token)` builds one line item per entry and
  computes `application_fee_amount` over the SUM. Metadata (session AND payment
  intent): `kind: "registration_group"`, `registration_group_id`,
  `registration_ids` comma-joined. A test pins the joined value under Stripe's
  500-char metadata cap for a maximal 10-entry cart, so raising the entry cap
  reds here rather than in production.
- **Currency 422 code is `REGISTRATION_CURRENCY_UNAVAILABLE`**, thrown before
  `getStripe()` is reached (asserted). **But the two conditions are not
  independently mutation-provable today**: `REGISTRATION_CURRENCY_EXCLUSIONS`
  is empty, so `REGISTRATION_CURRENCIES == SUPPORTED_CURRENCIES`, and
  `organizations.currency` carries a CHECK over that same list — any snapshot
  failing the allowlist test is structurally guaranteed to fail the equality
  test too. Both checks are real and owner-mandated (ruling 4 requires both);
  they only become separable when someone populates the exclusions list.
  Recorded so a future reader does not delete one as redundant.
- **A mint failure must NOT fail the submit.** `submitRegistrationGroup` has
  COMMITTED by the time the route mints, so a throw returned an error for a
  registration that exists — entries holding capacity, and the registrant never
  receiving the `ref_code`/`access_token` that are the only ways back to pay.
  Their retry duplicates the cart. The route now catches, logs, and returns 201
  with `checkout_url: null`; `mintGroupCheckout` still THROWS for its direct
  callers (resume-checkout, promotion), where a 422/503 is the right answer and
  nothing is lost.
- **The webhook re-key exposed a cart-total smear.** The old handler forwarded
  `session.amount_total` into a per-entry confirm — harmless while sessions were
  entry-scoped, but a group session's `amount_total` is the CART's, so every
  named entry would have taken the whole cart's sum onto its own `amount_cents`
  AND onto any late/duplicate refund, which reads the same value. Same
  cart-vs-entry confusion RS001 flagged and RS002 spent a wave fixing,
  re-entering through the webhook. Fixed, and the parameter was **removed**
  rather than passed `null`: with one non-test caller, all five
  `amountTotal ?? …` fallbacks and the `coalesce()` had an unreachable non-null
  side, three in refund math, and a dead money parameter reads like "the amount
  actually charged".
- **Fulfilment loops sequentially with NO per-id try/catch, on purpose.** Each
  `confirmPaidRegistration` is its own locked transaction; a failure partway
  must abort the rest so `billing_events.processed_at` stays null and Stripe
  retries (already-flipped entries are idempotent on replay). Swallowing one
  entry's failure would mark the event processed with that entry paid-for and
  unconfirmed forever, with nothing left to retry it.
- **`async_payment_failed` is tested through `processStripeEvent`, not by
  calling the handler** — that also proves the dispatch branch and the
  `HANDLED_EVENT_TYPES` entry. The direct import was removed; a comment says
  why, so nobody "fixes" it back and reintroduces the lint drift.
- **The gap that was open between 3a and 3b, for the record**: 3a re-keyed the
  MINT while every consumer still read `metadata.registration_id`, so on that
  intermediate commit a real payment would have landed and no entry would ever
  have flipped. Inherent to splitting a wave down the producer/consumer seam —
  if a future session splits this way, the two halves must land together.
- **FIXED IN W3b (`a9833d539`) — and it was live on `main`, not something RS003
  introduced: the registration webhook branch had no `payment_status` gate
  while every branch beside it did.** `billing-events.ts:115-117` dispatched
  `kind === "registration"` straight into `handleRegistrationCheckoutCompleted`
  (`registrations.ts:1315-1335`), which reads the metadata and calls
  `confirmPaidRegistration` unconditionally. Its neighbours in the SAME
  dispatcher all guard: `size_pack` at `:126`, the next branch at `:139`, the
  competition branch at `:213`, and even registrations' own reconcile paths at
  `registrations.ts:1731`/`:1753` (`if (session.payment_status !== "paid")
  return false`). Only the webhook entry point does not.
  Why it bites: this repo correctly omits `payment_method_types`, so dynamic
  payment methods are live, and a delayed-notification method fires
  `checkout.session.completed` while the session is still **unpaid**. The entry
  would then be confirmed and MATERIALISED into an entrant before any money
  arrived. Same family as RS002's worst finding (a rejected registration
  confirmed by a replayed webhook) — money and materialisation moving on an
  event that does not mean "paid". W3b owned this handler for the group re-key,
  so the gate was fixed inline rather than deferred (no-new-issues rule), and
  `checkout.session.async_payment_succeeded` / `_failed` were added to
  `processStripeEvent`'s switch and to `HANDLED_EVENT_TYPES` — neither existed.
  The webhook ROUTE never filtered event types; the switch was the real gap.
- **RS001's entry condition 2 is CLOSED, not outstanding.** The privacy-consent
  rule that died with the old `submitRegistration` was reimplemented by RS002:
  `registration-submit.ts:426` throws the identical
  `422 "Please agree to the privacy policy to register"`, with the guardian
  gate at `:419`. Verified this session; no RS003 work owed.

**Waves 4-5 CLOSED** — the per-currency matrix, then an approved deep-dive that
added 36 tests across five new files. Commits `27d12bda4` (W4 matrix),
`ec1c51d77` (fixture extraction), `629495a7a` (webhook fulfilment),
`b1f2a2c85`+`74dcd1dcf` (checkout guards), `ebb1dcc4f` (concurrency),
`c340fbb36`+`769834dae` (status reads). Gate rerun by the main thread with
placement up: **3030 total / 2999 passed / 0 failed / 0 failed suites /
31 pending**; `turbo typecheck` **2/2**; lint **75 warnings / 0 errors**
(main's baseline); `openapi:gen` + `i18n:gen-keys` clean.

- **New files** (fixtures now shared in `__tests__/_registration-fixtures.ts`,
  leading underscore so vitest does not collect it):
  `registration-webhook-fulfilment.test.ts` (12),
  `registration-checkout-guards.test.ts` (8),
  `registration-concurrency.test.ts` (5),
  `registration-status-read.test.ts` (11).
- **The webhook family is tested TOGETHER on purpose.** The same failure class
  hit this dispatcher twice in consecutive sessions — RS002's replayed webhook
  confirming a `rejected` registration, and W3b's missing `payment_status`
  gate. Both are "money and materialisation move on an event that does not mean
  what the code assumed". One file now holds `rejected` + `payment_status` +
  replay + async succeeded/failed + mid-loop abort, so the next change here
  cannot fix one and regress the other.
- **`groupByRef`'s doc comment made three SECURITY claims that nothing
  asserted** — identical 404 for wrong-token vs nonexistent ref, token compare
  runs either way, no existence disclosure. Now pinned: splitting the combined
  `!group || !tokenOk` guard into a distinct "invalid access token" branch reds
  the indistinguishability test. Two traps found writing it: refs carry a
  **CHECKSUM**, so an arbitrary "valid-looking" ref is rejected before any
  lookup and proves nothing (use `generateRefCode()`, which also makes the
  absent ref checksum-valid-but-unassigned — the real enumeration case); and
  hardcoded ref literals collide on rerun because the DB persists and
  `ref_code` is globally unique. A parallel agent hit the second trap
  independently, so it is a property of the fixture, not of either author.
- **Both reconcile `catch` arms had no coverage.** They run when Stripe is
  unreachable at the moment a registrant returns from checkout; without them
  the status page 500s for someone who has just paid. Proven by making both
  rethrow — exactly two tests red, one per function.
- **Real two-actor concurrency IS achievable here**, contra the RS002 note that
  it "proved unreliable in this environment" (that verdict was about ONE
  staging attempt). Races 1 and 2 are fully real on both actors by exploiting
  the caller-supplied `tx`; race 3 uses a NAMED single-column proxy, documented
  in the file header, because neither function accepts an external `tx`.
  Removing `skip locked` hangs its test to a 30s timeout — an unusual but
  genuine kill signal. The sweep-vs-webhook comment at `:2454-2456` is now
  verified in BOTH orders rather than asserted in prose.
- **ORCHESTRATOR MISTAKE, recorded so it is not repeated: three waves were run
  in parallel on "provably disjoint file sets" — but only the TEST files were
  disjoint.** All three mutation-tested the SAME production files
  (`registrations.ts`, `billing-events.ts`), so each agent's mutate/revert
  cycle ran inside the others' measurement windows. One wave lost a proof to an
  interrupted cycle and reported it; a live `for update skip locked` -> `for
  update` mutation was visible in `git status` mid-run. **Mutation testing is a
  shared-resource operation on the production tree — serialise it even when the
  test files differ.** Every critical proof (payment_status gate, RULING A
  rejected branch, `mintGroupCheckout`'s own 503) was re-run SERIALLY afterwards
  and each killed exactly its own test.
- **Mutations that did NOT discriminate, reported rather than counted:**
  dropping `regIds.length === 0` changes nothing (postgres.js tolerates an empty
  `IN ()`) — the real guard is `.filter(Boolean)` in `checkoutRegistrationIds`;
  and `entrant_id` alone cannot detect a double-confirm because `materialise`'s
  own idempotency check masks it — the audit-row count is what catches it.
- **Two checkout guards are structurally unreachable in a single
  non-concurrent call** (`entries.length === 0`, `subtotal <= 0`): both callers
  re-derive the value they pass down. They are reachable only through the real
  TOCTOU window between `mintGroupCheckout`'s `payable` read and
  `createRegistrationCheckout`'s re-query, which is how the tests drive them.
  Sound defensive code — previously untestable rather than merely untested.
- **`token === null` in `createRegistrationCheckout` is reached from
  `sweepRegistrations`, NOT from `mintGroupCheckout`/`resumeRegistrationCheckout`**
  — both of those declare `token: string`. The dispatch brief said otherwise and
  was wrong about the call graph.
- **Owner rule (2026-08-18): E2E and smoke get their own BRAINSTORM session
  before either is written.** Applies to RS006/RS007's e2e and RS010's smoke.
  A checklist line like "add an e2e for the paid flow" reliably yields one
  happy-path spec while the failure classes that actually shipped go uncovered.

**Wave 6 CLOSED — live Stripe probe, e2e, and the whole-branch review.** Branch
rebased onto `main` @ `ca3a4357a` (34 commits). Gate after the rebase:
**3046 total / 3009 passed / 0 failed / 0 failed suites / 37 pending**
(pre-rebase baseline was 3045/3008 — the +1 is main's own test, not drift);
`turbo typecheck` **2/2**; lint **75/0**; `openapi:gen` + `i18n:gen-keys` clean;
e2e **11/11** local against a prod build; live Stripe **6/6** in test mode.

- **The live probe found what four waves of mocked tests could not: amounts are
  currency-blind.** A 500+700 cart is £12.00 in gbp but ₹12.00 in inr — about
  9p — and Stripe refuses any session below its platform minimum (~30p on this
  GB platform). INR is offline-only per ruling 10, but **the same refusal is
  reachable in gbp** with an entry fee set too low, and it would surface as a
  raw Stripe error on a registrant's pay page. Now translated to a clean 422
  `REGISTRATION_AMOUNT_TOO_SMALL`, narrowly — every other Stripe failure
  rethrows, because a blanket catch hides real integration faults.
- **Live-probe constraints, both recorded in the file**:
  `organizations_stripe_account_idx` is UNIQUE, so one connected account
  attaches to exactly ONE org (an org per currency 23505s on the second) — the
  probe uses one org and rewrites its currency; and it detaches the account from
  any org a previous run left it on, because a probe that only passes on a
  virgin DB is one nobody runs twice.
- **E2E: the deferral did not survive scrutiny.** RS003's prompt deferred e2e to
  RS006/RS007 for "no UI yet", but `RULES.md:63-65` requires one anyway, and
  `payments-hardening.spec.ts` already drives money flows purely through
  `page.request`. `registration-public-api.spec.ts` ships 9 API-level cases.
  **RS006/RS007 still owe the UI-driven flows** — this is not a substitute.
- **Two e2e cases deliberately NOT written, because they would be vacuous:**
  rate limits (`e2e.yml:130` sets no `REDIS_URL` ON PURPOSE, so the limiter is
  inert and any 429 assertion passes regardless) and real `checkout_url`s (no
  `STRIPE_MOCK_HOST`, key is `sk_test_ci_e2e_dummy`, so a mint always fails —
  asserting a URL would assert the environment). Both live in the mocked unit
  suites where they can actually fail.
- **Three e2e fixture facts, each of which first presented as a code failure:**
  `sport_variants`' key is `(sport_key, key, org_scope)` so `ON CONFLICT` must
  be bare; the base-url env var is `PLAYWRIGHT_BASE`, not `PLAYWRIGHT_BASE_URL`;
  and `generic`'s lineup is `size 1`, so a team entry carrying a captain is
  ALREADY FULL and a join correctly 422s — the rep registers the team with no
  roster and shares the link, which is design §4's actual flow.
- **`next build` type-checks the whole app and caught what the wave gate had not
  been re-run to catch**: wrapping the session params in `mintOrTranslate`'s
  closure discards the narrowing from the `!org?.stripe_account_id` guard (TS
  cannot prove `org` is not reassigned). `turbo typecheck` would have caught it
  too — it simply was not re-run after that edit. Bind to a const before the
  closure.
- **Whole-branch review: 1 blocker + 3 minors, all closed.** The blocker was the
  e2e gap above. The minors: the OpenAPI summary still told integrators
  `checkout_url` is null "until wave 3 wires Stripe" (wave 3 wired it, and the
  stale text shipped in both committed contract files); `errors` listed 402,
  which nothing throws, and omitted 400, which the honeypot does; and
  `_registration-fixtures.ts` claimed `loadWithGroup` is kept "in exact
  column-list sync" with `regGroupCols` by the schema tests — it is not, that
  suite only asserts each column EXISTS against its own hand-typed array.
- **A landmine defused for RS006/RS007**: `payments-hardening.spec.ts`'s parked
  T10 told the next reader to "delete this test.skip line once the endpoint
  exists again". It exists again — but `submitPublicRegistration` still posts
  the OLD flat body, so following that instruction yields a 400 that reads
  exactly like a capacity regression. The comment now names both blockers.

### RS004 (2026-08-24) — branch `feat/rs004-registration-hub-settings`

**LIVE SESSION STATE.** Worktree `.claude/worktrees/rs004`, rebased onto `main`
@ `98c54936f`. DB label `rs004` on `127.0.0.1:54552`, schema **v375**. Scouting
done, no code yet.

**Five brief premises checked against the tree before writing anything — four
are FALSE. Each was verified with `git grep -a`/`git show`, not assumed.**

1. **The `registration.paid` gate locks nothing.** The prompt's acceptance
   criterion "fee section locked without `registration.paid`" describes a lock
   that cannot fire: `V310__community_branding_and_paid_registration.sql:49`
   seeds the entitlement **true on every plan, community included**, and there
   is **not one `UpgradeGate` call site** for it in `apps/web/src` or `e2e/`.
   The three server-side `requireFeature("registration.paid")` gates
   (`registrations.ts:1006,1155`, `registration-submit.ts:437`) are live code
   that can never deny — `stripe-connect.ts:95,110` already calls this "dead
   code twice over". What RS004 can honestly ship is the `data-feature`
   attribute on the fee section plus a test that drives the gate through a
   stubbed entitlement; what it must NOT ship is a test asserting a lock that
   only passes because it never runs.
2. **The org preferred-currency select already EXISTS** —
   `components/org-registration-currency.tsx` (select over
   `REGISTRATION_CURRENCIES`, disabled + explainer while `lockedTo` is
   non-null), mounted at `app/o/[orgSlug]/settings/page.tsx:526`, writing
   `PATCH /api/orgs/[id]` (`route.ts:56` zod `refine(isRegistrationCurrency)`,
   `:113-127` refuses the write with 409 while locked). RS001b shipped scope
   item 6 in full. What is left of that item: the **card-unsupported message
   beside the payment-method choice in the hub config panel**, and e2e
   coverage. Note the select labels are hand-written (`$ USD`, `£ GBP`…),
   **not** `Intl.DisplayNames` as the prompt says — changing them is a
   deliberate choice, not a fix.
3. **The old settings form did NOT handle timezone.** The prompt's gotcha says
   "`settings.tz` vs `orgTz` — the old form had this right, keep it". It did
   not: `registration-settings.tsx:18-27` (pre-deletion, `850cc630^`) converts
   window datetimes with bare `new Date(iso)` + `.getHours()`, i.e. **browser
   local time**, and neither that file nor `registrations-panel.tsx` mentions
   `tz` or `orgTz` at all. Rendering windows in the org timezone is NEW work
   in RS004, not a port — and it is a behaviour change worth its own test.
4. **`mobile.spec.ts` has no matrix array to append to.** Every `test()` in
   that file runs under all seven width projects automatically
   (`playwright.config.ts:126-201`, each project `testMatch:
   /mobile\.spec\.ts/`). "Add the hub to the seven-width matrix" therefore
   means "write a test in that file" — and it must mint its own org/tag
   (`mobile.spec.ts:35-41,79`, `TAG` is per process) because it mutates
   settings.
5. **TRUE, and it is the whole of W1:** none of the five columns RS001/RS002
   added has an organiser-facing API. `PutRegistrationSettings`
   (`api-v1/schemas.ts:1972-1998`) has no `approval`/`allow_free_agents`;
   `PatchDivision` (`:169-206`) has no `category`/`age_min`/`age_max`. All five
   are READ in usecases already (`registration-eligibility.ts:75-77,244-278`,
   `registration-approval.ts:121,188`, `registration-submit.ts:367,622`), so
   the hub is writing to columns the engine already honours.

**Conventions pinned from the tree** (do not re-derive):

- Guard: `requireCompetitionPage(orgSlug, compSlug, {tail})`
  (`server/page-auth.ts:192-201`); a scorer gets **`notFound()` — 404, not 403
  and not a redirect** (`:198-200`). The prompt's "403/redirect" is loose
  wording for this.
- `?tab=` is read **server-side** — the division page derives `tab` from
  `searchParams` and renders an inline `<nav>` of `<Link>`s
  (`d/[divSlug]/page.tsx:77-115,346-358`). There is no shared `TabStrip`
  component and no client tabs component; matching the repo means a server
  component, not the prompt's "client tabs".
- Overview cards: `c/[compSlug]/page.tsx:113,145` (`routes.competitionSchedule`
  / `routes.competitionSettings`), live counts already fetched server-side into
  a `Map` at `:207-212` — the Registration card's counts join that query.
- Form-fields builder to port verbatim: `FormBuilder`
  (`registration-settings.tsx:373-381`, field rows `:397-487`) over
  `FormField {key, label, kind: "text"|"select"|"checkbox", options?, required}`
  (`registrations-panel.tsx:26-32`, both pre-deletion at `850cc630^`).
- Public register link was rendered **only when
  `competition.visibility !== "private"`**, with an amber notice otherwise
  (`d/[divSlug]/registrations/page.tsx:36-72`, pre-deletion). Keep that gate.

### RS004 session log — waves, findings, rulings (2026-08-24)

Ran as W1 API surface → W2 hub shell → W3a division rows → W3b config panel →
W4 e2e → design sign-off → promotion. Every build wave and every gap pass got
a reviewer; the main thread reran the gate at each boundary.

**Owner rulings taken this session:**

1. **No paywall lock on fees.** `registration.paid` is granted on EVERY plan
   (`V310__community_branding_and_paid_registration.sql:49`) and has zero
   `UpgradeGate` call sites, so the prompt's "fee section locked without
   `registration.paid`" describes a lock that cannot fire. The fee section
   renders `data-feature="registration.paid"` (the seam survives if pricing
   ever changes) and gates nothing. What an organiser gets instead is the
   thing they actually could not see: their own platform cut, and that the
   rate LOCKS onto the competition at the first paid entry
   (`competitions.fee_percent ?? feePercentFor(org)`, first-wins).
2. **Hub is owner/admin only** — viewers get `notFound()`. This DIVERGES from
   competition settings, which renders a viewer a read-only page. Deliberate:
   RS005's Registrants tab carries names, emails and consent state.
   `requireCompetitionPage` 404s a scorer but NOT a viewer, so the page adds
   its own `canEdit` check — do not assume the helper is sufficient.
3. **Windows render and edit in the ORG timezone, labelled.** New behaviour,
   not a port: the deleted form used bare `new Date(iso).getHours()`, i.e.
   browser-local, and mentioned `tz`/`orgTz` nowhere.
4. **Division-page re-point deferred to RS005.** Design §5 wants the division
   page linking into the hub with its division pre-filtered; the filter lands
   with the real Registrants table. RS001 already removed the old link, so
   nothing is left dangling meanwhile.
5. **Row + panel treatment picked from screenshots** (owner, 2026-08-24) —
   dense "scan line" row, accordion panel with Money and Form collapsed.
   Two alternatives were built and captured; the losing two were deleted with
   their tests and the whole `?variant=` scaffold.

**False premises in the RS004 prompt — verified, not assumed:**

- The org preferred-currency select **already existed**: RS001b shipped
  `components/org-registration-currency.tsx` with the Connect lock and a 409
  on the API. Scope item 6 was mostly done before the session opened. Its
  labels are hand-written (`£ GBP`), NOT `Intl.DisplayNames`.
- **`mobile.spec.ts` has no matrix array.** Every `test()` in that file runs
  under all seven width projects (`playwright.config.ts:126-201`), so "add the
  surface to the matrix" means "write a test in that file", and a mutating one
  must fold `projectTag()` into its identity.
- The guard convention is `notFound()`, not the prompt's "403/redirect".

**Defects found that no test could see, and what each teaches:**

- `PATCH /divisions/{id}` with ONE side of the age band violated
  `divisions_age_band_check` and surfaced as a 500 with the raw constraint
  text. Zod validated only within a single body; nothing refetched to merge.
- The overview's registrant pill counted `entrants`, which exist only after
  `materialise()` — so manual-approval and waitlisted registrations read as
  ZERO, hiding exactly the people an organiser opens the hub to act on.
- **A client component imported `server-only`.** `registration-hub-division-row`
  pulled `t` from `@/lib/i18n`; vitest and `tsc` both passed, and `next build`
  refused the app outright. Client code takes `t` from `@/lib/i18n-runtime` and
  `Dict` from `@/lib/i18n-constants`.
- **An invented event type produced a crash AND hid it.** The accordion's
  `onToggle` prop was hand-typed as `(e: { currentTarget: { open: boolean } })`
  — a shape the DOM never produces. Reading `e.currentTarget.open` in a native
  `<details>` toggle (fired during commit, when `currentTarget` is unbound)
  crashed the page on the FIRST open of every division. `tsc` was satisfied by
  the invented type, the unit test fed that same invented event, and the
  seven-width scroll matrix never opens a panel that crashes. Only a
  screenshot of a real click found it. Type DOM handlers with React's own
  `ReactEventHandler<T>`.
- **The fee copy named a product that does not exist** ("Bench takes 2%", all
  four locales). It lives inside the COLLAPSED Money section, so no earlier
  capture had rendered it. Screenshot the sections a design hides by default.

**Environment ruling with teeth:** DB-gated suites may no longer run against
the dev database. `vitest.config.ts` loads `.env.local` so a bare run
exercises DB suites, and every suite gates on `!!process.env.DATABASE_URL` —
so a run with nothing exported did not skip, it wrote fixtures into the
developer's own DB. Census on 2026-08-24: **4,811 fixture organisations
created in one session**, on top of 22,634 from earlier ones, with nothing
ever failing. The config now REFUSES to start when `DATABASE_URL` came from
`.env.local` and points at port 5432. An exported URL, and CI's, are
untouched.

**Handover to RS005** (Registrants tab): the config panel is
`registration-hub-config-panel.tsx` mounted from
`registration-hub-settings-panel.tsx`; the hook is
`use-registration-hub-config.ts`; row state derives through
`registration-hub-row-derive.ts` and `-status.ts`. The Registrants tab
deliberately builds NO context and issues NO queries — build its own rather
than widening the settings one. `registrations.status` counting lives in
`card-stats.ts` (`registered` and `awaiting_confirmation`, one aggregate).

### RS005 (2026-08-25) — branch `feat/rs005-registrants-tab`

**LIVE SESSION.** Worktree `.claude/worktrees/rs005` off `origin/main` @ `9080cb959`.
DB label `rs005` on `127.0.0.1:54429`, schema **v375**; placement on `50311`.
Baseline before any edit, main thread, JSON reporter: `registrations.test.ts` +
`registration-approval.test.ts` + `card-stats-registration-counts.test.ts` +
the hub's own `__tests__/` = **168 total / 168 passed / 0 failed / 0 failed
suites**. Flyway high-water is **V375**, so any RS005 delta starts at V376 —
none is expected: this session is read-model, endpoints and UI only.

**Brief premises checked against the tree before writing anything. Most of
scope item 4 ("API: org-side endpoints for list + transitions") ALREADY
EXISTS.** What is actually missing is narrower than the prompt implies:

- Live already: `GET /api/v1/divisions/[id]/registrations` (status filter),
  `.../registrations/export` (CSV, `exports` entitlement),
  `POST /registrations/[id]/{withdraw,remind,confirm,waive,mark-paid,refund,
  waitlist}`.
- `/registrations/[id]/waitlist` is move-**to**-waitlist, NOT promote. Nothing
  in `app/` reaches `promoteFromWaitlist`, `approveRegistration` or
  `rejectRegistration` — RS002 shipped all three usecases with no HTTP surface.
- Genuinely new in RS005: competition-scoped list, `approve`, `reject`,
  `promote`, and the filter-aware CSV.
- `listRegistrations` (`registrations.ts:2684`) already implements EVERY filter
  the prompt asks for — competition-wide, kind, free_agent, consent_pending,
  text. What it lacks is the COLUMNS the table renders.

**FINDING (2026-08-25): the registration confirmation email is never sent by
any path.** `sendRegistrationEmail` (`lib/email.ts:427`) has ZERO callers —
RS001 preserved the mailer, and neither RS002's submit nor RS003's route ever
wired it. The dispute-evidence pack (`registrations.ts:3165`) rebuilds the
receipt with `registrationTemplate` under a comment saying it is
"reconstructed with the exact sender inputs" and "matches the original mail" —
there is no original mail. So a registrant today receives nothing at submit,
and the evidence pack attests to a message that was never delivered.
Owner ruling (2026-08-25): **fix inline in RS005** — wire the first send into
the submit path AND ship the resend action, per the no-new-issues rule. This
widens the session's file set to `registration-submit.ts` / the public register
route; asked and approved before starting, per `_RULES.md` §1.

**Owner rulings taken this session:**

1. **Confirmation email: send + resend, both in RS005** (above).
2. **`waitlist-queue.tsx` is ABSORBED, not wired.** Its Promote calls
   confirm/waive — pre-RS002 semantics — and its `positions` prop is
   caller-computed, so wiring it verbatim forks promotion in exactly the
   placer-vs-verifier way the prompt warns about. The waitlist becomes a
   section of the one registrants table: same positions, same `#`-in-line, same
   promote affordance, but server-computed order and `promoteFromWaitlist` as
   the only writer. The component is deleted. Its lost assertions (queue order,
   `#`-in-line, public waitlist count — they died with `reg-console.spec.ts`)
   are restored against the new section, which is the obligation RS001 handed
   over regardless of which component renders it.
3. **Widen `listRegistrations`, do not add a second hub read model.** The extra
   columns are additive, existing callers are unaffected, and it keeps the
   prompt's ONE-source rule literally true rather than approximately true.
4. **One CSV exporter, not two.** `exportRegistrationsCsv` becomes
   competition-or-division scoped, filter-aware and per-player; the existing
   division route delegates to it. A second exporter is two column contracts to
   keep in sync — the repo's recurring fork class.
5. **CSV shape: one row per PLAYER.** An N-player entry emits N rows with the
   entry columns repeated; a zero-player entry (free agent, or a team
   registered with an empty roster) emits one row with blank player columns.
   Recorded because "one row per entry with a players column" is the other
   defensible choice and RS010's help page has to document whichever shipped.
6. **Default sort stays oldest-first.** The prompt asks for newest-first, but
   flipping `listRegistrations`' default silently reorders the live
   `/api/v1/divisions/[id]/registrations` response. A `sort` filter was added
   instead, defaulting to the existing order; the hub passes `"newest"`.

**FINDING (2026-08-25, W1b prep): `rejected` does not exist anywhere in the
API contract, four RS001-dropped columns still do.** RS002 shipped `rejected`
as a terminal status and `V364:90` allows it, but:

- `apps/web/src/app/api/v1/divisions/[id]/registrations/route.ts:8`'s `STATUSES`
  allowlist is `pending|paid|confirmed|waitlisted|withdrawn`, so
  `?status=rejected` — and `?status=expired` — return **400 today**. The
  organiser cannot list the entries they refused.
- `api-v1/schemas.ts:2082` `RegistrationStatus` omits `rejected` for the same
  reason, and `openapi.ts:189` repeats the short list a third time. Three
  hand-maintained copies of one enum; the DB CHECK is the only complete one.
- `api-v1/schemas.ts:2169` `Registration` still declares `dob`, `gender`,
  `guardian_name` and `guardian_consent` — all four DROPPED from `registrations`
  by RS001 (they moved to `registration_players`). The published OpenAPI
  contract advertises four fields the table no longer has, and omits
  `free_agent`, `join_code`, `group_id` and `contact_name`, which it does.

Fixed in W1b, with the status enum reduced to ONE source rather than three.

**OWNER RULING (2026-08-25) — RS004 ruling 2 is REVERSED. Viewers get the
Registration hub, read-only.** RS004 made the whole hub owner/admin and 404'd
viewers *because* the Registrants tab carries names, emails and consent state.
W1b then established that the API never agreed: `requireResourceAuth(..., "read")`
resolves to `READ_ROLES = owner, admin, viewer` (`lib/types.ts:28`), so the
list and the CSV export have been viewer-readable all along on the division
routes, and RS005 widens that to competition scope. Asked which way to resolve
it; owner chose to widen the UI rather than narrow the API. Consequences:

- The hub page drops its own `canEdit`-or-404 check and admits `READ_ROLES`.
  This also re-converges the hub with competition settings, which already
  renders a viewer a read-only page — RS004 called that divergence deliberate;
  it is no longer.
- Both tabs render read-only for a viewer. Every mutating control is **absent**,
  not disabled: the API 403s a viewer on all of them anyway (`write` scope is
  `EDITOR_ROLES`), so a disabled button would only advertise a capability the
  server refuses.
- CSV export IS available to a viewer. That is the deliberate part of this
  ruling — it is the path that moves registrant data off-platform, and it rides
  on `read`.
- **Judgment call taken inside the ruling, flagged for override: the join code
  is hidden from viewers.** It is not a display field, it is a bearer secret —
  `join_code` is globally unique (RS001) and anyone holding it can add players
  to that team entry, which is a WRITE a viewer does not otherwise have. Read
  access to the roster does not imply the right to grant roster writes. Same
  reasoning leaves `ref_code`/`access_token` visible: those authenticate the
  REGISTRANT to their own entry and are already on the organiser's screen.

**Fixed inline (no-new-issues rule), found by W1b in its own new routes and
then confirmed in six pre-existing siblings:** `v1()` does not validate or
strip against the OpenAPI response schema — it serializes whatever the handler
returns (`api-v1/http.ts:124-149`). So the documented response type is
documentation only, and `confirm`, `mark-paid`, `waive`, `waitlist`, `withdraw`
and `refund` have all been returning `access_token_hash` to the client. Low
severity (a hash, to a caller who already holds the row) but it is a
credential-derived value that should never leave the server, and the fix is
mechanical.

**W1 CLOSED** (read model + HTTP surface). Commits `085f10ab7`, `30e2da35a`,
`621c1b71b` (W1a) · `de0551b4e`, `3f8377ffe`, `46006b73d`, `008b3da27`,
`ea687abc3` (W1b) · `72d365796`, `900afb29d` (review fixes). Boundary gate rerun
by the main thread: `src/app/api/v1` + `src/server/api-v1` +
`registration-list-read.test.ts` = **558 total / 558 passed / 0 failed / 0
failed suites**; `turbo typecheck lint` **4/4 successful, 0 errors** (119
warnings, 2 of them ours — the `{ x: _x, ...rest }` discard idiom, which is
established repo precedent at `d/[divSlug]/page.tsx:145` and two siblings that
carry the identical warning on `main`); `openapi:gen` + `i18n:gen-keys` leave
`git status --porcelain` free of artifact drift.

**W1b review BLOCKER — a cross-competition read, and an API-key pin bypass.**
`listRegistrations` derived the competition from `division_id` whenever one was
given and DISCARDED the caller's `competition_id`. A request addressed to
competition A carrying a division from competition B returned B's rows under a
200 from A's URL — and the filter's own doc comment said `competition_id` was
"ignored otherwise", so the vulnerable behaviour was documented as intended.

Same org either way (`withTenant` was never bypassed), so a session user learned
nothing they could not reach through B's own URL. The teeth are on the API-key
competition pin: `apiKeyAuth` resolves the pin from the URL PATH resource
(`resolvePinCompetition`) and never reads query parameters, so a key pinned to A
satisfied its pin on A's path and then read — and CSV EXPORTED — B's contact
names, emails, answers and payment state. The pin is the entire boundary that
endpoint sells. Guarded inside `listRegistrations` rather than in the two
routes, so the export path and every future caller inherit it; **404, not 403**,
matching the existing convention that a pin miss adds no existence oracle.
Proven: removing the guard reds exactly the two new tests and nothing else.

**Nine routes were returning the registrant's access-token hash.** `v1()`
neither validates nor strips against the OpenAPI response schema — it
serialises whatever the handler returns (`api-v1/http.ts:124-149`) — so
`S.Registration` never declaring `access_token_hash` was documentation, not
enforcement, and `tsc` sees an object with one extra string property as
assignable. The six pre-existing action routes (confirm, mark-paid, waive,
waitlist, withdraw, refund) all shipped it; W1b's three new ones each
hand-stripped it, which was already three copies of a security-relevant line.
All nine now call one `organiserRegistration()` helper
(`api-v1/registration-response.ts`), so the next secret column is removed once
rather than nine times. Proven: neutering the helper reds all five new cases
plus the three existing assertions, nothing else.
**Trap for later waves: a "no secret in the response" assertion is vacuous on a
4xx.** The mark-paid case first passed against a 422 — that route gates on the
DIVISION's `registration_settings.fee_cents`, which `rig()` never creates, not
on the entry's own `amount_cents`. Every case now asserts the 200 first.

**Also closed in W1b, from the same review:** the two competition routes parsed
an identical seven-parameter filter set through two hand-written copies; folded
onto one `parseRegistrationListQuery` (the export is the copy where a missed
validation leaks bytes rather than JSON). And `RegistrationStatus` is now a
single source with all seven DB-allowed values, so `?status=rejected` and
`?status=expired` work — proven by a reference-equality test rather than by
three copies agreeing today.

**W2a CLOSED** (Registrants read surface). Commits `1491c0c50`..`6846905af`
plus `5457db005`. Gate rerun by the main thread: registration page `__tests__/`
+ `src/components/__tests__` = **699 total / 699 passed / 0 failed / 0 failed
suites**.

**Architecture ruling: the read surface is server-rendered with ZERO
JavaScript.** Filters are a plain `<form method="GET">`; the table is a server
component calling `listRegistrations` directly rather than fetching the HTTP
endpoint W1b built (`data.ts`'s existing "no client fetch, no N+1" rule).
Consequences worth keeping: URL state is shareable and back-buttonable for
free, the seven-width e2e can drive real filtering without waiting on
hydration, and the tab works on a venue's bad wifi. Client islands arrive only
in W3, where the actions genuinely need them. Row expand (W2b) is native
`<details>` with NO toggle handler — which sidesteps RS004's invented-event
crash by construction rather than by re-typing the handler that caused it.

**RULING: there is NO separate waitlist section.** One table, one row
renderer; `waitlist_position` renders in its own column and the `waitlisted`
status filter is how an organiser scopes to the queue. A second renderer is
what deleting `waitlist-queue.tsx` was FOR — re-introducing a second section in
the same session would undo it for cosmetics.

**CORRECTION to RS001's handover, which both sides could otherwise drop:**
RS001 entry condition 3 says `waitlist-queue.tsx`'s lost coverage was "queue
order, #-in-line and the public waitlist count". The first two land here. **The
public waitlist count cannot be asserted from an organiser tab at all** — it is
a public-surface number, so it is owed by **RS006/RS007**, not by RS005. Filed
here so neither side assumes the other covered it.

**The reversal had a second victim, found by W2a and fixed in `5457db005`.**
Dropping the page-level `!canEdit` 404 admitted viewers to the SETTINGS tab
too, where `RegistrationHubDivisionRow`'s Configure button rendered
unconditionally — nobody had ever needed to gate it, because the page used to
404 everyone who could not edit. A viewer would open the config panel, change a
fee or a window, save, and get a 403: not a security hole (the API refuses them
correctly) but a dead end that reads as a broken product. `canEdit` now rides on
`RegistrationHubRowContext`; the control is ABSENT, not disabled, per the same
ruling. Proven by forcing the gate true — reds exactly the viewer case.
**Lesson for RS009/RS010: reversing a page-level guard does not just change who
reaches the page, it silently promotes every unconditional control on it into a
control a read-only role can now press.** Sweep for the whole class, not the
instance.

**Two product decisions taken inside W2a, both user-visible:**

- **A foreign or nonexistent `division_id` drops that filter and re-renders**
  rather than erroring. The read model 404s it (correctly — that is W1's
  security guard), but a PAGE has no error envelope, and an organiser opening a
  stale bookmark should see their registrants rather than a dead page.
  Malformed enum values are ignored the same way.
- **Unlimited roster renders `n/∞`** — compact enough for a table cell, and the
  symbol needs no per-locale translation; only the surrounding template does.

**Two distinct empty states, deliberately.** "No registrations at all" points at
Settings and the register link; "your filters matched nothing" offers a clear.
Shipping one for both tells an organiser their competition is empty when they
have merely over-filtered — which, on a tab whose whole job is finding people,
is the worst possible lie to tell.

**OWNER RULING (2026-08-25) — the confirmation email is CART-SHAPED.** One
email per cart, listing every entry with its own status, one total, one pay
link. Rejected: one-email-per-entry (a rep entering five teams gets five mails,
none of which shows what the single payment covered — and that one artefact is
what gets forwarded to a treasurer), and one-email-per-cart on the existing
single-entry template (silently misdescribes every multi-entry cart; a
waitlisted sibling would read as confirmed). Costs a change to
`lib/email-templates/registration.ts` and its four `emails.json` dictionaries,
which is outside RS005's stated file set — asked and approved before starting,
per `_RULES.md` §1.

Consequence that is easy to miss: **the dispute-evidence pack must reconstruct
the CART too.** `registrations.ts:3165` builds single-entry args today under a
comment claiming the result "matches the original mail". Leaving it
single-entry while the sent mail becomes cart-shaped would recreate the same
class of lie this wave exists to remove.

**Parallelism note for future sessions: `emails.json` and `ui.json` are
SEPARATE files per locale, so a mail wave and a UI wave are genuinely
file-disjoint — but `i18n-keys.ts` is GENERATED from all of them and is a
shared artefact.** Two agents running `i18n:gen-keys` concurrently race on one
file and both commit it. The rule adopted here: concurrent waves do not run
`gen-keys` at all; the orchestrator regenerates once at the wave boundary.

**FINDING (2026-08-25) — the help tree documents a console RS001 DELETED.**
`apps/web/content/help/registration/open-registration.md:31` describes "The
**Registrations** console opens on a **pulse strip** — confirmed / holding /
waitlisted counts against capacity, money collected and due, and the next
payment deadline — with the list below split into **Confirmed / Pending /
Waitlist / All** tabs", plus row actions grouped Spot vs Money and a
duplicate-contact hint. None of it exists: `registration-pulse.tsx` and
`registrations-panel.tsx` went out with RS001 on 2026-08-17, and RS005 ships a
differently shaped surface (one table, server-driven filters, approve/reject).

Cost: an organiser following help hunts for a UI that is not there. It has been
wrong for eight days and **no gate can see it** — the help tree is prose, has no
tests, and `content/help/**` is deliberately English-only so even the i18n
parity check never reads it. Nothing in CI will ever go red for this.

Related, and self-correcting as of this session: `card-payments.md:21` promises
"the confirmation email goes out". That was FALSE from RS001 until W4 wired the
sender — the docs described the product we intended while the code had silently
stopped delivering it. Worth noting as a pattern: **help prose is where an
unimplemented promise survives longest**, because it is the one artefact no
test, type or gate reads.

**Owner ruling (2026-08-25): fix the help pages AFTER W3**, so the docs describe
what actually shipped rather than what is half-built. Owed: rewrite
`open-registration.md`'s console section for the hub's two tabs and the real
action set; confirm `waitlist.md`'s "place in line" copy still matches the
`#`-position column; and RS005's CSV column list, which RS005's own prompt
defers to RS010's help pass.

**THE SESSION'S BIGGEST LESSON — reviews and tests did not find the defects an
organiser finds in twenty minutes.** By the time the owner opened the product,
this branch had four reviewers, ~10,500 green tests, a seven-width screenshot
pass and a targeted `/code-review`. They then found EIGHT real defects by
clicking: a filter that needed a button press, "Free agents only" surviving
beside "Allow solo sign-ups", a hint explaining a control that could not be
used, "You keep 92%" shown to an organiser collecting cash, a date-without-time
that saved as UNSET, a withdrawn entry that would still "resend confirmation",
a refund lock offered for offline payment, and an Approve button whose error
told them to press a Mark-paid button that did not exist.

Why the pipeline missed all eight — worth keeping, because the causes are
structural, not effort:

1. **Verification was of STRUCTURE, not USE.** The screenshots were of the
   Registrants tab only; the config panel was never opened in a browser, no
   action was ever clicked, no organiser task was completed end to end. Every
   one of the eight sits behind an interaction or inside a collapsed section.
2. **A test that asserts a string RENDERS cannot ask whether the string is
   TRUE.** "You keep 92%", "Only available for team divisions", the refund-lock
   label — each rendered exactly as designed and each was false for that
   configuration. There is no gate for "is this sentence true here", and unit
   tests structurally cannot be one.
3. **Nothing compares organiser-facing VOCABULARY across surfaces**, which is
   how "Free agents only" and "Allow solo sign-ups" coexisted three keys apart.
4. **Reviewers were given file and diff lenses.** None was asked to use the
   product as an organiser, so none did.

**What changed, and what a later session should keep doing:** drive the real
app before showing anyone screenshots. Doing it once immediately produced two
more defects ("1 extra questions"; an empty "Actions" heading over a terminal
entry's zero controls), caught a `next build` failure that `tsc` and vitest
were both blind to (a client component importing `@/server/api-v1/schemas`,
dragging gRPC and Node built-ins into the browser bundle), and stopped two
FALSE reports: a "silent no-op" that was a confirm dialog waiting, and a
"missing role=dialog" that was `role="alertdialog"` all along.

**Traps re-confirmed the hard way this session** (all already in this file or
the skill, all still cost time): vitest run from the worktree root reports
`Cannot find package '@/...'` and 54 suites failing to COLLECT; a `{total: 38}`
result with `EXIT=1` reads as green if judged on the exit code; and
`seazn-env up --server` REUSES an existing bundle and says so in one line —
skip that line and you review a build from before your own fix, which nearly
had the Approve/Mark-paid fix reported as broken.

**Late findings fixed after the reviews** (each with a test that fails without
it, each mutation-proven):

- `join_code` reached READ-ONLY roles through both list routes. The UI hid it;
  the API did not, and `read` scope is `READ_ROLES` — viewer included. A bearer
  credential that grants roster writes, handed over in one GET.
- The CSV gave a viewer per-player **dob and gender** — data no UI surface
  shows to ANY role, much of it minor-attendee personal data leaving the
  platform as a file. Columns omitted, not blanked: a blank cell under
  `player_dob` asserts "we hold no date of birth", which is false.
- The `kind` filter used a bare `rs.entrant_kind = ?` while the SELECT
  coalesced a missing settings row to `'individual'` — so an entry VISIBLY
  listed as Individual vanished when filtered for Individual.
- `consent_pending=0` was silently ignored (truthiness where its neighbour used
  `!== undefined`), so "who is fully consented" returned everyone.
- The CSV's question columns came from the RESULT rows, so the header moved
  with the filter and two exports of one competition could not feed one
  importer.
- `POST /registrations/{id}/promote` 400'd on a body-less POST, making its own
  documented default path unreachable.
- `waitlist-queue.tsx` was still present although ruling 2 above says "The
  component is deleted". It now is. **A wrong record is worse than a stray
  file** — the next session trusts it.

**Still open at close** (not silently dropped):

- **The hub advertises a public page that cannot open.** `register/page.tsx`
  renders "not open" UNCONDITIONALLY until RS006 ships the stepper, while the
  division row still offers the toggle, the URL, Copy, Open and a printable QR.
  An organiser can pin a dead QR to a noticeboard today. A notice is being
  added rather than pulling RS006 forward; the controls stay so settings can be
  configured ahead of launch.
- **No pagination anywhere in the read path.** A large competition's tab grows
  unbounded and every row mounts client islands whether expanded or not.
  Flagged as a guess by the reviewer; needs a ~300-row profile to size.
- **`resend-confirmation` has no throttle**, mirroring the pre-existing
  `/remind` route. Not a regression; now two unthrottled organiser-triggered
  mailers instead of one.

**Pinned so no wave re-derives them:**

- **Waitlist position must reproduce `promoteOldestWaitlisted`
  (`registrations.ts:799`) exactly**: `order by created_at, id` over
  `status = 'waitlisted'` within ONE division. A tuple comparison
  `(w.created_at, w.id) < (r.created_at, r.id)` reproduces it; a `row_number()`
  over an unfiltered set does not. This is the session's regression test — the
  displayed `#1` and the row the promote button actually moves are the same row
  or this feature is lying.
- **Roster fill (`5/7`) has a source already**: `registration-submit.ts:742-748`,
  `(sports.position_catalog->'lineup'->>'size')::int + coalesce(benchMax, 0)`,
  NULL = unlimited. Hand-copying that expression into the list query is the
  fork; it is extracted to one place.
- **`access_token_hash` ships to the client today.** `regGroupCols`
  (`registrations.ts:404`) includes it and the organiser list route returns the
  row verbatim. Dropped from the list path this session.
- RS004 handover honoured: the Registrants tab builds its OWN context and
  queries rather than widening `use-registration-hub-config.ts`.
- RS004 ruling 4's deferred item lands here: the division page re-points into
  the hub with its division pre-filtered.

### RS007 (2026-08-27) — branch `feat/rs007-status-join-payments`

Rulings taken at session open, from scout verification against `d165908e7`.
Both open calls went to the owner and both took the recommendation.

- **RULING — join becomes CLAIM-first, and the mint widens to pairs.**
  The pair/`join_code` question in this file (lines 57-59) turned out to be
  the smaller half of a bigger defect. `joinTeamEntry`
  (`registration-submit.ts:738`) **INSERTs** a new `registration_players` row
  (`:794-807`, `source='self_joined'`) — while submit already inserts every
  non-self roster player as a real row (`:610-639`,
  `source='captain_entered'`, `consent_status='pending'`). A captain-entered
  player who follows the join link therefore gets a SECOND row: the roster
  double-counts and the original pending consent stays pending forever.
  `git grep` finds **zero** non-test write sites that flip a
  `captain_entered` row from `pending` to `granted`, so **owner ruling 4**
  ("join/claim is the consent moment for players entered by someone else")
  is currently unimplementable. This is a defect in the DESIGN, not only the
  code — design §4 specifies join as "inserts a `registration_players` row
  (`source='self_joined'`)". §4 gets a correction line.
  Shape: the join page lists the entry's unclaimed slots and asks "which one
  are you?" — picking a name UPDATEs that row to `granted`/`guardian`;
  "I'm someone else" keeps today's INSERT path, cap-checked. A **pair** has
  exactly one unclaimed slot and no "someone else" option, so the
  fixed-at-two rule falls out of the UI with no special case, and widening
  the mint is deleting `entrant_kind === "team"` at `:565`. V364's partial
  unique index and the collision-retry loop are untouched.
  Consequence: `register.consent.rosterNotice` becomes true as written in
  all 4 locales — **no copy retreat is owed**, which reverses the
  contingency in RS007's acceptance criteria.
- **`joinTeamEntry` has no dedupe of any kind** (`:738-817`) — not by name,
  dob, `person_id` or `user_id`. The only guards are free_agent, status,
  roster cap and eligibility. The same person can join repeatedly, one fresh
  row each time. Worse, the cap comes from the sport's
  `position_catalog.lineup.size + benchMax` (`:768-775`) and **null =
  unlimited**, so on a sport with no declared lineup a leaked join code grows
  a roster without bound. Claim-first plus "a granted row 409s on re-claim"
  closes both.
- **FALSE PREMISE — "verify RS002 shipped the lapse".** It did not, and what
  exists does the opposite. `sweepRegistrations`
  (`registrations.ts:3373-3391`) matches `r.status='pending' and
  g.expires_at < now()` and sets `status='expired'`. A promoted entrant who
  misses the window is dropped permanently. **Owner call: lapse returns them
  to the waitlist TAIL and re-offers the slot** (RS007's AC as written).
- **STRUCTURAL — the promotion deadline has nowhere to live.** RS001 moved
  `expires_at` to `registration_groups`, so it is **cart-level**.
  `promoteWaitlistedRow` (`:871`) sets `status='pending'` + `promoted_at =
  now()` on the ENTRY but extends the deadline on the GROUP, so promoting one
  entry in a 3-entry cart extends every sibling's deadline and one sweep pass
  expires them together. Pay-on-promotion mints a checkout for a single
  entry, so it needs a single entry's clock. **V378** adds
  `registrations.promotion_expires_at` + a partial sweep index (Flyway
  high-water was **V377**). The sweep splits in two: the group deadline still
  expires never-paid submits, the entry deadline lapses promotions.
  `promoted_at is not null` already distinguishes the two — no new flag.
- **STALE GOTCHA — refunds are NOT cart-level.** RS007's brief warns against
  an entry-level cancel calling a cart-level refund. `refundRegistration`
  (`registrations.ts:3923`) is `(auth, regId, amountCents?)` — entry-keyed,
  writing `registrations.refunded_cents` (V368) additively and aggregating to
  the group. Entry-level cancel is safe to ship; the warning is out of date.
- **Both surfaces have ZERO width coverage.** `mobile.spec.ts` references
  neither `register/status` nor the join flow. A surface has no width
  coverage until it is inside that file.
- **RULING (FINAL, after correction) — keep the `refund_lock_at` policy;
  fix its defaults and make it VISIBLE.** Owner call 2026-08-27, retaken
  once the shipped behaviour was read correctly. The org controls refunds by
  setting a date, not by actioning each cancellation — which is the better
  deal for a volunteer club secretary than manual admin on every withdrawal.
  No shipped code is reversed. What RS007 owes instead:
  - **`refund_lock_at` NULL currently means auto-refund FOREVER** — including
    the night before the tournament, after the club has committed the money
    to a venue. That is the actual defect. Fix the default so "never set" is
    not "always refundable".
  - **The registrant must see which side of the line they are on BEFORE they
    confirm a cancel**: "cancel now and £25 is refunded" vs "refunds are at
    the organiser's discretion after 20 Aug". The behaviour is defensible;
    being unable to see it is what generates the support email.
  - Organisers likely do not know the setting exists — surface it in org
    settings with a sensible suggested default.
  An earlier version of this ruling said a paid self-cancel must NOT
  auto-refund and that the org actions every refund. That was taken on the
  false premise recorded below and is SUPERSEDED — do not reinstate it.
  **CORRECTION 2026-08-27 — the premise this ruling was taken on was wrong,
  and the ruling is therefore REOPENED (see below).** An earlier scout
  reported the auto-refund lived in the caller
  `withdrawRegistrationOrganiser`, not in `withdrawCore`. Reading the code:
  the auto-refund is **inside `withdrawCore`** at `registrations.ts:3287-3301`
  (direct `stripeRefund` call), and `withdrawRegistrationOrganiser` (`:4040`)
  is a thin wrapper around it. Consequences:
  - **A public token-authorised self-cancel ALREADY EXISTS and ALREADY
    auto-refunds.** `api/v1/public/registrations/by-ref/[ref]/withdraw/route.ts:25`
    → `withdrawRegistrationByRef` (`:2811`) → `withdrawCore` → refund. No
    session auth. So "the org refunds" is not a new policy to add — it is a
    REVERSAL of shipped behaviour, on a route that is already public.
  - **A refund policy already exists and is org-controlled**: the refund is
    gated on `refund_lock_at` — full auto-refund while the withdrawal lands
    before the org's lock date, organiser discretion after it, via the manual
    refund endpoint. The org already controls refunds, by setting a date
    rather than by actioning each one. The gating comment cites "doc 16 §1.1";
    **that document is NOT verified to exist** — this repo has form for
    comments citing documents that do not (cf. the engine's "doc 14").
  Corollary the ruling REQUIRES, or the money just sits: a paid self-cancel
  must reach the organiser — the entry shows in the hub as withdrawn + paid
  with a refund outstanding, and an email goes to the organiser. Free upside:
  `withdrawCore` already auto-promotes the next waitlisted entry
  (`:3216-3217`), so the slot recycles immediately while the club still holds
  the money. Briefly two payments against one slot — correct, and the reason
  the outstanding refund must be visible rather than implicit.
- **CRITICAL — `sweepRegistrations` HAS NO SCHEDULER. Everything on the money
  path is dead code in production.** Verified 2026-08-27 in the main checkout:
  `/api/cron/registrations/route.ts:18` is the ONLY caller of
  `sweepRegistrations`, it is `CRON_SECRET`-gated, and **nothing invokes that
  route** — six cron workflows exist (`ai-preview-sweep-stg`,
  `billing-events-stg`, `billing-grant-stg`, `billing-quantity-stg`,
  `funnel-reminders-stg`, `news-digest-stg`, all STAGING-only and all hourly),
  none for registrations; there is no `vercel.json` and no `"crons"` config
  anywhere in the repo. Consequences in production TODAY:
  - `sendPaymentReminderEmail` (`registrations.ts:3385-3396`) never fires —
    the payment-reminder feature is built, wired, idempotent, and has never
    sent a single mail.
  - Unpaid pending entries never expire, so their slots are never freed.
  - **W1a's new lapse branch is INERT** — green under test, dead in prod.
    A promotion that "lapses back to the waitlist tail" never lapses at all.
  **Owner call: add the scheduler this session** (asked first, since a new
  `.github/workflows/` file widens the stated file set). Copy the
  `funnel-reminders-stg.yml` pattern: hourly, `x-cron-secret` matching the
  app's `CRON_SECRET`, skip-with-warning when the GitHub secret is absent so
  a missing secret does not fill the Actions tab with red, fail loud on any
  non-200. Note the secret must be set in BOTH places (`gh secret set` and
  `flyctl secrets set`) or the leg is a no-op that looks scheduled.
- **Scope additions taken as product calls (2026-08-27), each beyond the
  literal brief**: (a) **per-slot claim links** — the captain copies a link
  per unclaimed player rather than one code for the team, so claims land on
  the right row and the captain stops playing switchboard; the picker stays
  as the fallback for a generic link. (b) **pre-lapse reminder** before a
  promotion expires — a silent expiry converts badly, and the whole point of
  a waitlist is that promoted entrants actually pay. RESOLVED: the mailer and
  the `reminded_at` bookkeeping already exist inside `sweepRegistrations`
  (`registrations.ts:3385-3400`), so this is pure wiring — it starts working
  the moment the scheduler above exists, and needs a promoted-entry branch
  reading `promotion_expires_at` rather than the group's `expires_at`.
  (c) **the deadline is shown** on the status page and in the promotion mail,
  which removes the "I didn't know there was a deadline" refund argument the
  organiser otherwise settles by hand.
- **RULING — RS007 ships a WALKTHROUGH, and the wave is verified VISUALLY.**
  Owner call 2026-08-27. `e2e/walkthrough/` is its own Playwright project and
  its own CI leg. The folder's rule applies verbatim here: *setup may use the
  API to REACH a state; every event that IS the thing under test must be
  TAPPED*. RS007's value is a JOURNEY — captain registers, partner claims,
  entry is promoted, money is paid, a promotion lapses — and no unit test can
  see whether that journey holds together. It is the same risk shape that put
  the folder there: two signed-off waves shipped broken deciders that no
  code-asserting surface caught.
  - Spec: `e2e/walkthrough/rs007-registration-journey.spec.ts`. Every step
    TAPPED through the real stepper, the real claim link and the real
    status page — never posted. An API-driven registration test is blind to
    a payload the stepper never builds and a control the page disabled.
  - **OWNER RULING — the walkthrough charter is GENERIC, not sport-scoped.**
    The folder landed on `main` at `addd126c5` (2026-08-27) stating its
    charter as sport-and-decider specific: "a walkthrough plays a whole match
    by hand", "a sport belongs here once it has a decider". That scoping is
    the bug. The folder's actual principle — *every other surface asserts on
    CODE; none of them had ever tapped the thing* — is domain-independent,
    and sport-scoping it leaves every non-sport journey (registration,
    payments, onboarding, venues) with no home and no CI leg. That is the
    same blindness that shipped two broken deciders, relocated to another
    domain rather than fixed.
    RS007 generalises the README: a walkthrough is ANY end-to-end journey a
    customer completes; the deciders are one instance, not the definition.
  - **Screenshots are a first-class output of EVERY walkthrough, not an
    RS007 extra.** Ships as a SHARED helper emitting step shots at
    1280 / 768 / 320 to a known directory, reusable by the existing sport
    specs and every future one. The helper must FAIL LOUDLY if it writes
    nothing — a screenshot step that silently no-ops is the same vacuous
    green as an e2e that never ran.
  - **ORDERING**: the worktree branched from `d165908e7` and does NOT contain
    `e2e/walkthrough/` at all. Rebase onto `origin/main` BEFORE any
    walkthrough work, or the spec is written against a folder that is not
    there and the wiring guard cannot see it.
  - `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` proves the project is
    dispatched and selects the files — a project nothing dispatches is
    indistinguishable from a passing one. The `WALKTHROUGH` regex is
    `/[\\/]e2e[\\/]walkthrough[\\/]/` (`playwright.config.ts:119`), deliberately
    anchored: a bare `/walkthrough\//` once matched an entire worktree at
    `.claude/worktrees/walkthrough/`. New spec MUST live in that folder.
  - Screenshots at every step, at 1280 / 768 / 320, are the review artifact —
    the owner verifies the journey by looking at it, and so does the session.
    Visual verification is not optional here and is not satisfied by green
    counts.
- **DEFECT found by LOOKING at it — a stale status link renders Next's bare
  framework 404.** Verified 2026-08-27 in a browser against the prod
  standalone build at three widths: visible text is exactly "404 This page
  could not be found", with no branding, no explanation and no route forward.
  The only designed element on screen is the cookie banner. This is the page
  **every registration email links to**, and links in this flow go stale
  routinely — an entry is cancelled, an old mail is forwarded, a token
  rotates. A registrant landing here cannot tell whether they are registered
  and is given no prompt to ask the organiser to resend.
  The 404 SHAPE is correct and must survive the fix: a wrong token and a
  never-existed group have to stay indistinguishable, or the page leaks which
  groups exist. Confirmed no data leak — a bogus rid+token body has ZERO
  visible occurrences of roster/paid/registration; all 87 hits are inside
  bundled script chunks. So the fix is a DESIGNED not-valid-link page that
  reveals nothing, not a loosening of the check.
  No horizontal scroll at 1280/768/320, so the layout bar itself passes.
- **THREE MORE DEFECTS FOUND BY DRIVING THE REAL STEPPER** (2026-08-27,
  prod standalone build, registered a team by hand and read the result).
  Every one of these passes the unit suites.
  1. **Payment instructions lose their line breaks — bank details run
     together.** The status page renders the organiser's instructions as
     markdown, where a SINGLE newline collapses to a space (the blank-line
     paragraph break survives, which is the tell). A seeded instruction of
     "Bank: … / Account name: … / Sort code: … / Account number: …" rendered
     as one run-on paragraph. At **320px it is worse than cosmetic**: wrapping
     then invents false groupings — "Account name: RS007 Seed / Org Sort code:
     12-34-56" reads as a label called "Org Sort code". These are BANK
     DETAILS on the width most people read registration email at; a transposed
     digit means a failed payment the organiser then has to chase. Render with
     line breaks preserved.
  2. **The cookie banner covers the page's primary actions.** Fixed-position,
     bottom-left. At 1280 it sits over "Cancel this entry"; at **320 it covers
     the entire roster block** — every player's status AND the claim links,
     which are the exact actions this page exists to prompt. First visit only,
     but a registration email lands on a first visit by definition.
  3. **Stepper validation timing is INVERTED across steps.** Step 2's team
     name is required, yet NEXT stays enabled with it empty and no inline
     error appears — you pass steps 3 and 4 INCLUDING GIVING CONSENT, and only
     the step-5 submit says "A team name is required", naming neither the step
     nor the entry, with the "Unnamed team" review row not clickable to fix
     it. Meanwhile step 3 shows "Choose which player on this entry is you" in
     red ON FIRST PAINT, when the roster is empty and the only option is "None
     of these" — an error you cannot satisfy, contradicting the copy directly
     above it ("or leave it blank — the organiser can fill it in later").
     So the step that CANNOT yet be satisfied complains immediately, and the
     step with a real missing value stays silent until the last click. This is
     the top of the funnel: a paying captain hits a dead end after consenting.
     NOTE: fixing this touches the RS006 stepper, widening RS007's file set.
- **SESSION STATE (2026-08-27) — resume here.** Branch
  `feat/rs007-status-join-payments`, worktree `.claude/worktrees/rs007`,
  rebased on `addd126c5`. 8 commits, tree clean. Local env: DB
  `postgresql://postgres@127.0.0.1:54515/seazn_rs007` (v379), prod server on
  `http://localhost:3355` (built FROM this worktree), placement on 50451.
  Seeded scenario: org `rs007-seed-mtblbdpu-7invf`, comp
  `rs007-seed-competition-mtblbdpu-7invf`, divisions Teams (team) + Pairs
  (pair), £25 offline, instructions carrying `{{reference}}`. A live status
  page URL is in `/tmp/rs007-status-url.txt`. Seed/driver scripts live in the
  session scratchpad (`seed-rs007.mjs`, `drive.mjs`, `shot.mjs`, `probe.mjs`).
  DONE: promotion clock + lapse-to-tail (V378), claim-not-duplicate join +
  pair join codes, sweep scheduler + per-entry reminders (V379), prod leg
  gated, refund window bounded, status page rebuilt, 3 visual defects fixed.
- **REVIEWER GAP LIST (first adversarial pass, 2026-08-27) — OPEN unless
  marked.** Six waves ran implementer-only before this; that was a process
  error and this list is what it cost.
  1. **CRITICAL — the claim links are DEAD.** `entry-card.tsx:174,:187` link
     to `/shared/{org}/{comp}/register/join`; **no such page exists** (only
     the API route, at an unrelated path). Verified by hand: 404, no page
     file. Cause is a brief error — W3 was told to render claim links AND
     told not to touch the join page. Every team/pair registrant's link
     404s. FIX = build the join page (RS007 scope item 2 all along).
  2. **Refund fallback still has the hole it claims to close**:
     `competitions.starts_on` is NULLABLE (`V207__competitions.sql:10`), so a
     competition with neither `refund_lock_at` nor `starts_on` is STILL
     refundable forever. Plus `new Date("YYYY-MM-DD")` = UTC midnight, so a US
     club's lock fires ~20h early and an APAC club's stays open past kickoff.
     Confirmed the fallback never WIDENS eligibility — direction is right,
     trigger conditions are wrong.
  3. **Reminder passes are not concurrency-safe**: `registrations.ts:3657`
     and `:3702` send-then-UPDATE with no `for update` and no CAS guard,
     unlike expire/lapse which lock and re-check. The workflow's own curl
     retries can overlap a running invocation. Contradicts the route's and
     the workflow's "idempotent/row-locked" claims — and this path runs in
     prod for the FIRST TIME because of this PR.
  4. **Claim vs organiser-withdraw TOCTOU**: the dead-status check runs on
     the initial SELECT (~`registration-submit.ts:916`); the CAS WHERE
     (`:965-979`) never re-checks status, so a withdraw landing between them
     lets a claim write consent onto a dead entry. (Claim-vs-claim on the
     same slot IS genuinely atomic — that part is clean.)
  5. **Timing oracle on two NEW routes**: `resendRegistrationConfirmationPublic`
     (`:1236`) and `reconcileRegistrationGroupBySession` (`:2671`) use
     `!group || !tokenMatchesHash(...)`, short-circuiting when no row matches.
     `buildGroupStatusView:3180` already carries the documented fix
     (`DUMMY_ACCESS_HASH`, always compares) and they did not reuse it.
  6. Reconcile-on-load has NO rate limit (`page.tsx:54`) unlike every sibling
     public mutation. Cannot be triggered for someone else's session and
     cannot double-apply — just uncapped external Stripe calls.
  7. Concurrency claims are tested SEQUENTIALLY only — nothing fires two
     claims or two sweeps in parallel, so nothing would have caught #3. The
     workflow guard also never asserts the `concurrency:` block exists.
  8. Three hardcoded English catch-block strings: `cancel-entry.tsx`,
     `pay-button.tsx`, `resend-confirmation.tsx`. All other new strings are
     present in all 4 dictionaries.
  9. FYI only, self-acknowledged: join-code enumerability (`generateRefCode`,
     not high-entropy), mitigated by the same 5/300s per-IP limit as POST.
- **CORRECTION to this file's own earlier note**: the STATUS page's bad-token
  state was NEVER the bare 404. It already renders a designed, branded "We
  couldn't find that registration", and wrong-token vs nonexistent-group are
  BYTE-IDENTICAL (same 200, same length, same visible text — verified). The
  bare framework 404 came from the ORG-SLUG layer above it, which now has a
  `not-found.tsx`. Copy nit outstanding: "Check your link and try again" asks
  the reader to fix a link someone else sent them; the actionable line is
  "ask the organiser to resend your confirmation".
- **VERIFICATION LESSON, recorded because it repeated the folder's own
  founding lesson**: 3098 unit tests were green while every claim link 404'd.
  Screenshots caught the bank-details wrap, the banner overlap and the copy
  failures — and still missed the dead links, because a screenshot proves a
  link RENDERS, never that it RESOLVES. Only tapping it does. The walkthrough
  spec this file already mandates was sequenced LAST; had it been first the
  dead links would have failed immediately. It is now sequenced right after
  the join page exists to tap.
- **Owed to RS009, deliberately NOT built here**: the organiser needs to see
  which entries still have unclaimed players ("2 teams have incomplete
  rosters") before the draw. It belongs to RS005's Registrants tab and
  reaching into it from RS007 widens the file set past this session.
- Status page as inherited is **140 lines** (`groupById(rid, token)`,
  `:64`): ref code, contact/org name, per-entry division/status/fee, cart
  subtotal. No join link, no cancel, no pay-now, and no reference to
  `session_id`, `checkout` or `reconcile`. `groupById` does not select
  `payment_instructions`, which is why the offline case states a debt and
  offers nothing — `paymentInstructionsText()`
  (`lib/payment-instructions.ts:18`) is reachable from `/r/[ref]`'s data path
  and the email builders only.

#### Eligibility consolidation — owner ruling 2026-08-27, "go"

Raised by the owner mid-RS007 ("do we have similar eligibility setting in
division creation, do we need that? or deprecate it?"), then decided once
greenfield was confirmed ("we are greenfield and no data in production").

**Two eligibility representations were live at once, both enforced,
additively** — `registration-eligibility.ts:163-174` says so in its own words
("independent and additive"):

| Axis | Wizard → jsonb | Hub panel → column |
| --- | --- | --- |
| Age | `{kind:"age",maxAgeAt,cutoff:{month,day}}` — `division-builder.tsx:286-293` | `age_min`/`age_max`, cutoff hardcoded **1 Jan** (`registration-rules.ts:182`) |
| Sex | `{kind:"gender",allowed:[m,f,x]}` multi-select — `division-builder.tsx:619-647` | `category` enum — `registration-hub-config-panel.tsx:569-583` |

Three defects fell out of that, none of which any test could see:

1. **Two age rules with two different cutoff dates both fire.** Set U16/1-Sept
   in the wizard and 15 in the hub and a player born Sept–Dec is eligible under
   one and rejected by the other. Stricter silently wins; no screen shows both.
2. **`youth` is derived from the jsonb ONLY** (`divisions.ts:97-103`,
   re-derived only on `patch.eligibility` at `:681-684`; no UI writes it
   directly). Set the age band in the registration hub instead of the wizard
   and `youth` stays false — so OG share images publish full player names
   (`og/model.ts:84-87,143`), the slideshow stops shortening them
   (`slideshow-data.ts:150`), and the public-visibility dialog skips its youth
   warning (`visibility-picker.tsx:53-55`). The replacement column was never
   wired to the derivation the original fed. **Safeguarding, live in code —
   but greenfield, so never live in production.**
3. **"Custom rule (manual, shown as a warning)" is shown nowhere.** Written at
   `division-builder.tsx:298`, and that write is the ONLY `kind:"custom"` match
   in the repo. The validator handles `age` and `gender` only — no `custom`
   branch, no fallthrough. The label makes two promises ("manual", "shown as a
   warning") and keeps neither, so an organiser types "School-registered
   students only" into a void while believing entrants get warned. The note IS
   carried in `openapi/v1.public.json:2426`, so it leaves the building by API
   while no UI renders it.

**Also confirmed dead, unrelated to the above**: the `eligibility.enforced`
plan entitlement. Seeded `V112:69-71`, bundled `V290:23`, then DELETEd by
`V319__v17_phase1_reorg.sql:47`. No `requireFeature`/`has` call site survives
anywhere in `apps/web/src` — it lives on only as paywall copy
(`feature-copy.ts:52`), i.e. we advertise unlocking a gate that no longer
exists. Safe to remove.

**RULING: remove the jsonb, do not keep both.** `RULES.md:32-34` is explicit —
"Prefer a correct schema over a backwards-compatible one; don't contort a
design to dodge a migration." Keeping both was only ever backfill avoidance,
and there is nothing to backfill. End state:

```
category                          open|mens|womens|mixed   exists
age_min / age_max                                          exists
age_cutoff_month / age_cutoff_day                NEW       recovers the wizard's cutoff
eligibility_note                  text           NEW       the custom rule, actually rendered
youth                             derived from age_max     repointed
DROP divisions.eligibility jsonb
```

The wizard's Eligibility tab keeps its UI and writes columns instead. Both
screens then edit ONE truth, so the two-surfaces problem dissolves without
deleting a surface. The dual evaluator, the additive double-firing and the
gender precedence rule below all delete with it — this is LESS code than
keeping it.

**Two behaviour changes, accepted deliberately by the owner, not refactors:**

- **Non-binary players gain access.** jsonb `allowed:["m"]` rejects a player
  whose gender is `x`; `category='mens'` deliberately allows them
  (`registration-rules.ts:147` — `person.gender !== "x" && person.gender !==
  needed`). Under today's precedence the jsonb wins, so the HARSHER rule is
  what ships. Collapsing onto `category` makes the product more inclusive.
- **The chip labelled "Mixed / other" is NOT `category='mixed'`.** The chip is
  a person's own gender; `mixed` is a ROSTER rule (the roster must contain
  both — `MIXED_NEEDS_BOTH_GENDERS`, which fires independently of any
  per-person rule). Same word, different subject. Mapping is none→`open`,
  m→`mens`, f→`womens`, and `mixed` becomes its own explicit choice rather
  than a gender chip.

**SUPERSEDES the gender precedence ruling of 2026-08-17** (recorded in this
file's RS002 rulings, implemented at `registration-eligibility.ts:163-174`:
"if the jsonb loop already emitted a gender-family code,
`categoryEligibilityIssues` is skipped entirely"). With one representation
there is no precedence left to arbitrate; delete the rule with the loop.

**Sequencing, and why it is not a follow-up.** Delta `V380`, wizard rewire,
one evaluator, the note rendered on the public entry + join pages, 4 dicts,
OpenAPI regen (dropping the column trips the pre-commit drift gate), tests,
visual pass at 1280/768/320. Lands as its own commit on the RS007 branch so
the review stays together. **It absorbs the `youth` fix rather than preceding
it** — repointing `eligibilityIsYouth` at `age_max` is one line of this
change, and doing the standalone fix first means writing it twice.

**Blocked on W5 while it was in flight**: W5 held `dictionaries/*/ui.json`,
`i18n-keys.ts`, `schemas.ts`, `registration-submit.ts` and both `openapi/*`
files dirty — every file this change needs. Only `_INDEX.md` and the new
migration were conflict-free, which is why they went first.

#### SESSION STATE at 26 commits (written for compaction, 2026-08-27)

**Branch** `feat/rs007-status-join-payments`, rebased clean on `origin/main`
(`28dda4bfd`), 26 commits, **no duplicate V-numbers** (checked post-rebase —
this programme has been bitten by two V367s surviving a clean rebase).

**Environment, all live:**
- DB `postgresql://postgres@127.0.0.1:54515/seazn_rs007`, **schema v380**,
  `divisions.eligibility` DROPPED. `sync:sports` HAS been re-run (a stale
  `benchMax: 20` was reddening 3 roster-cap suites; source says 0).
- Server `http://localhost:3355`, `seazn-env rebuild --label rs007`.
- Placement on `localhost:50451`, secret `local-rs007-secret`. **Export
  `PLACEMENT_SERVICE_HOST=localhost:50451` for any vitest run** or
  `schedule-build-honours-locks` gives 4 environmental reds.
- Scratchpad scripts (outside the repo): `sweep-eligibility.mjs` (the 275
  fixture sweep, self-checking), `tap-join.mjs`, `probe-net.mjs` (logs
  requests >=400 — this is what found the 500s), `drive.mjs`, `shot.mjs`.

**Gate, run by the main thread (not taken from an agent):** 11984 total /
11902 passed / 8 failed → all 8 resolved: 1 real regression (fixed), 3 stale
seed, 4 missing placement env. `tsc` clean, lint `✖ 124 problems (0 errors)`.

**Closed this session:** reviewer finding #1 (join page — VERIFIED BY TAPPING
a real claim link, 200 at all three widths); the public-surface 500; the
eligibility consolidation server half; the team-name client/server split; the
walkthrough charter + Connect CI wiring; seven-width coverage; the journey
walkthrough.

**OPEN, in the order I would take them:**
1. **UI-half implementer** was in flight at compaction — wizard rewire
   (`d99e5176c`), hub panel (`bce2b0726`) committed; items 3-6 (note
   rendering, `EntrantsPanel` real props, stale comment, cutoff on the public
   wire) unfinished. `tsc` had 4 errors in `entrants-panel.tsx` /
   `[divSlug]/page.tsx` — ITS in-flight edits, not defects.
2. **Rerun the gate**, then a **second reviewer** over the UI-half diff.
3. **Run the two unrun e2e specs** — `mobile.spec.ts`'s new RS007 routes and
   `walkthrough/rs007-registration-journey.spec.ts`. Both committed UNRUN and
   say so in their commit messages.
4. **Live Connect walkthrough** — `CONNECT_WALKTHROUGH=1` +
   `STRIPE_CONNECT_TEST_ACCOUNT` + `stripe listen`. Never yet run on this
   branch.
5. **First-pass reviewer findings 2-8, ALL STILL OPEN** (list above). #2
   (refund `starts_on` nullable + UTC midnight) and #3 (reminder passes with
   no lock/CAS, and that path runs in PROD for the first time because of this
   PR) are the two that touch money.
6. Whole-branch review, then the PR.

**Traps this session paid for, beyond the ones already listed in this file:**
- **A `git add` with a stale pathspec aborts WHOLESALE and stages nothing.**
  Committed a rename with none of its content; `2>/dev/null` hid the error.
  `git show --stat` after any commit whose `add` listed a moved file.
- **Two assertions written this session could not fail.** The sweep script's
  leftover check greppd the DISK during a dry run (so it reported every
  pre-existing hit and could never go red), and the CI step-ORDER assertion
  anchored on `stripe listen`, which also appears in the prose above the step
  — swapping the steps left it green. Mutation-test every guard; both were
  caught only that way.
- **An agent will misattribute your own regression as pre-existing.** The
  server-half implementer classified `stg-base-url.test.ts` as "GH-workflow
  drift". It was `registrations-sweep.yml` — added earlier in THIS session,
  the repo's first production `BASE_URL` — red for hours.
- **Sequencing a UI half into "a later wave" broke the create path silently.**
  `CreateDivision` is a NON-strict zod object, so the wizard's now-unknown
  `eligibility` key was STRIPPED with no error and every wizard-created
  division shipped with no restriction at all. The ruling above had said the
  wizard rewire lands in the same session, "not a follow-up"; overriding that
  for scheduling convenience is what opened it.

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

## RS007 ruling — the entries-step collapse is entrant-kind dependent (2026-08-27)

**Found by walking the shipped flow by hand, not by a test.** RS006 design §4
collapses step 2 when a competition has one open division, and `cart.ts`
auto-seeds that division as the only cart entry. For a TEAM division that seed
is `team_name: null, free_agent: false`, and step 2 is the ONLY surface that
renders a team-name input or the "sign up solo" choice. So the captain walked
WHO → DETAILS → CONSENT → REVIEW, saw the entry rendered as **"Unnamed team"**
beside an enabled Enter button, submitted, and got `422 A team name is
required` — with no field anywhere in the flow to answer it. Unrecoverable.
A single division is the commonest shape a small club has, so for those orgs
this was the entire public registration funnel.

**Ruling:** collapse step 2 only when the one open division needs nothing typed
or chosen — i.e. `entrant_kind === "individual"`. Team and pair keep the step.
An unknown kind does not collapse (an extra click costs less than a lost entry).
`shouldCollapseEntries` now takes the entrant kind; `buildStepOrder` passes it.

**Why no test caught it.** Three separate blind spots lined up:
- `steps.test.ts` asserted `shouldCollapseEntries(1) === true` with no entrant
  kind at all — it froze the defect as the specification. Inverted, not deleted.
- The register interaction tests mount with `DIV_OPEN` fixtures and drive the
  reducer; none of them submits, so the 422 is unreachable from unit tests.
- `validateEntries`' `teamNameMissing` gate (RS007, commit `e50c9c6f3`) lives on
  the entries step. When that step does not render, the gate never runs — the
  fix for "a nameless team is rejected at the end" only covered the path where
  the step exists.

**Second copy of the rule.** `register-stepper.tsx`'s auto-seed branch stated
the collapse condition independently as `openDivisions.length === 1` rather
than calling the predicate. Both now ask `shouldCollapseEntries`, so a
collapsed step 2 and a seeded entry cannot disagree again. (Same shape as the
"TWO vocab paths drift" trap already recorded for this repo.)

Commit `2d4d7b623`. Register component suite 304/304, from 4 red.

## CORRECTION (2026-08-27) — the "non-strict zod stripped the wizard payload" claim is FALSE

Recorded earlier this session as a CRITICAL defect, repeated in the PR body, and
used as the reasoning that made V380's lossy gender backfill look harmless. It
is wrong, and the correction matters more than the original claim.

`origin/main:apps/web/src/server/api-v1/schemas.ts:183` declares, on
`CreateDivision`:

    eligibility: z.array(z.record(z.string(), z.unknown())).default([])

The field is DECLARED, so zod never stripped it — wizard payloads were accepted
and stored in the jsonb column all along. The ~150 test files this branch edits
to delete `eligibility: []` from `createDivision` calls are themselves evidence
it was accepted. There was no "every wizard-created division ships with no
restriction" defect.

**Why the correction is load-bearing.** If wizard divisions really had shipped
empty, V380's backfill could lose nothing. They did not, so real jsonb rules
exist on dev and staging (the rolled-back dry run counted 25 divisions carrying
them) and possibly in production. V380 converts only exact `["m"]`/`["f"]` and
only when `category is null`; `["m","f"]`, `["x"]`, and any list on a division
that already had a category fall through unconverted, and the column is then
dropped with no `eligibility_note` fallback and no notice to the organiser.
Compounding it, `requiresGender` narrowed to `category in (mens, womens, mixed)`,
so those divisions stopped COLLECTING gender on the public form as well.

Being wrong about the premise is what let the backfill's losses read as
acceptable for most of this session. Recorded here rather than quietly dropped:
the greenfield stance covers registration ROWS (owner, 2026-08-16), it was never
a statement about divisions, and this session conflated the two.

Follow-up: V382 + the `requiresGender` predicate, dispatched 2026-08-27.

## RS007 FINDINGS REGISTER — `/code-review max 677`, 2026-08-27

Fifteen findings, every one marked CONFIRMED by the reviewer's own verify pass.
Recorded here verbatim-in-substance because until now they lived only in a task
notification — one compaction from being lost, while the PR body still said
"two lower-severity review findings are recorded but unfixed".

**Verdict as it stands: the branch is NOT mergeable.** Two CRITICAL money
defects and one safeguarding HIGH that re-creates the exact bug V380 exists to
fix. Statuses below are as of the moment of writing; update them in place.

| # | Severity | Location | Status |
| --- | --- | --- | --- |
| 1 | CRITICAL | `registrations.ts:3332` | OPEN — money lane |
| 2 | CRITICAL | `registrations.ts:2247` | OPEN — money lane |
| 3 | HIGH | `V380__…consolidation.sql:70` | OPEN — safeguarding |
| 4 | HIGH | `register/join/view-model.ts:119` | OPEN |
| 5 | HIGH | `registrations.ts:3983` | OPEN — money lane |
| 6 | HIGH | `registrations.ts:3768` | **FIXED** `097c1949b` |
| 7 | HIGH | `registrations.ts:3762` | OPEN — money lane |
| 8 | HIGH | `register/status/view-model.ts:59` | OPEN |
| 9 | HIGH | `registrations.ts:3740` | OPEN — money lane |
| 10 | HIGH | `register/status/view-model.ts:62` | OPEN |
| 11 | HIGH | `register/status/page.tsx:95` | **FIXED** `54b88fb9f` |
| 12 | MEDIUM | `registrations.ts:929` | OPEN — money lane |
| 13 | MEDIUM | `register/status/entry-card.tsx:98` | OPEN |
| 14 | MEDIUM | `register-stepper.tsx:209` | **FIXED** `d33ecea48` |
| 15 | MEDIUM | `register/join/page.tsx:80` | OPEN |

### The two CRITICALs

1. **A cancel can refund against someone else's payment.**
   `buildGroupStatusView` feeds the CART-level `group.payment_intent_id` into a
   PER-ENTRY `resolveRefundPolicy`, so an entry that was never charged reads
   `refundable: true`. Cart holds paid entry A (£25, sets
   `group.payment_intent_id = pi_A`) and waitlisted B; B is promoted (pending,
   2500, refunded 0); `refundable: !!paymentIntentId && remaining > 0 && …`
   (`:3526`) passes on pi_A, the CancelEntry dialog promises "£25.00 will be
   refunded", and `withdrawCore` runs a real `stripeRefund(pi_A, 2500)`. The
   organiser loses £25 and A shows a phantom refund.
   FIX: pass the ENTRY's own charge reference (or a per-entry `paid`
   predicate), never `group.payment_intent_id`.
2. **Paid, not entered, not queued, not refunded.**
   `confirmPaidRegistration`'s late-payment branch matches only
   `withdrawn|expired|rejected`, but RS007's own lapse pass parks rows in
   `waitlisted`. Promoted entry X at T+48h: the sweep sets
   `status='waitlisted'` while X's checkout is in flight; the webhook misses
   the guard at `:2247` and falls through to `update registrations set status =
   'paid'`; `promoteOldestWaitlisted` selects `status='waitlisted'` (`:850`) so
   X is gone from the queue too.
   FIX: add `waitlisted` to the terminal-status list at `:2247` so the `late`
   refund branch fires. **This defect is CREATED BY THIS BRANCH** — the
   `waitlisted` parking state is RS007's lapse pass.

### #3 — the safeguarding one, and why the V380 amendment did not cover it

`V380:70`'s `age_rule` and `gender_rule` CTEs `cross join lateral
jsonb_array_elements(...)` with **no per-division dedup** (unlike
`custom_rule`, which does have `distinct on`), and `:81` coalesces toward the
stale column. Proven in psql: `[{minAgeAt:8},{maxAgeAt:15}]` yields `UPDATE 1`
and lands `age_min=8, age_max=NULL`. `:150`'s recompute then reads
`youth = (age_max is not null and age_max < 18)` as **false**,
`resolveNameDisplay` returns `full`, and `og/model.ts:87` stops suppressing
rows — **a genuine U16 division publishes minors' full names.**

That is defect 2 from the migration's own header, re-created by the migration
written to fix it. The 2026-08-27 amendment (`625bd9eac`) did not touch it:
that amendment was scoped to the GENDER path (preserving unconvertible rules
as `eligibility_note`), and the loss here is on the AGE path and is arithmetic,
not conversion.

FIX: `distinct on (d.id) … order by d.id, r.ord` on both CTEs, and **merge
min/max across rules** rather than taking one arbitrary row — a division may
legitimately carry a min rule and a max rule as two separate objects, which is
precisely the shape that breaks.
Blast radius: staging + dev only; production is greenfield.

### The rest, in the reviewer's own terms

4. **`register/join/view-model.ts:119` — the joiner's consent is collected and
   discarded.** The join page renders a consent step and hard-blocks submit on
   privacy consent, but `buildJoinBody` sends neither `privacy_consent` nor
   `media_consent`, and `PublicJoinRequest` has no field to receive them.
   `joinTeamEntry` derives `consent_status` purely from age, and the consent
   columns live on `registration_groups` from the CAPTAIN's submit — so a
   joiner's deliberate media REFUSAL is silently overridden by the captain's
   choice, and the privacy consent is never recorded despite being a hard UI
   gate. FIX: add both fields to `PublicJoinRequest`, persist per-player.
5. **`registrations.ts:3983` — infinite re-promotion.** The lapse pass sets a
   row to `waitlisted` then calls `promoteOldestWaitlisted` in the SAME
   transaction; `for update skip locked` does **not** skip rows locked by the
   current transaction, so the just-lapsed non-payer is immediately re-promoted
   — every 48h forever, capacity never released, the sweep reporting
   `{lapsed:1, promoted:1}` each cycle. FIX: exclude the just-lapsed id, or
   promote in a separate transaction after commit.
7. **`registrations.ts:3762` — the reminder claim is GROUP-scoped, so siblings
   are never reminded.** Pass (1a) iterates PER ENTRY but claims and marks a
   group column. In a cart with pending A and B, A wins the claim and sets
   `reminded_at`; B hits `continue`, and the `g.reminded_at is null` filter
   excludes the cart from every future sweep. B expires unpaid — and since each
   mail mints a checkout for `[reg.id]` alone, B's fee is never presented to
   anyone. **V381's lease did not fix this** — the lease is still group-scoped.
   FIX: move the claim and the sent mark onto the ENTRY, as pass (1b) already
   does with `promotion_reminded_at`.
8. **`register/status/view-model.ts:59` — pay-then-refund on a stale deadline.**
   `resolveMoneyState` gates on `status === "pending" && amount_cents > 0` and
   never checks whether the deadline it is about to print has passed. The sweep
   is hourly (`cron: "37 * * * *"`), so a cart whose `expires_at` passed at
   14:00 is still pending at 14:36: the page renders a live Pay button above a
   stale "Pay by", `resumeRegistrationCheckout` has no deadline guard either and
   mints a real session, the registrant pays, and the 14:37 sweep expires the
   row and auto-refunds. Money in and straight back out. FIX: return an expired
   state when `effectivePayDeadline` is past, AND re-check server-side in
   `resumeRegistrationCheckout`.
9. **`registrations.ts:3740` — the Stripe session is minted BEFORE the claim.**
   A losing iteration still stamps `registration_groups.checkout_session_id`
   with a session nobody holds. A mints S_A, wins, emails S_A; B mints S_B
   unconditionally (stamping the group), loses, and `continue`s. The registrant
   pays via S_A and returns to `?session_id=S_A`, where
   `if (sessionId !== reg.checkout_session_id) return false` (`:2652`) refuses.
   **Registrations have no missed-webhook fallback** (billing does), so a paid
   cart renders pending with no path back. FIX: mint after the claim succeeds.
   V381 left the ordering unchanged.
10. **`register/status/view-model.ts:62` — a lapse timer with no way to pay.**
    The per-entry money state is decided from the CART-level `payment_method`,
    while V378's 48h `promotion_expires_at` is set from the DIVISION's method.
    A cart of {free manual-approval → pending} + {paid stripe → waitlisted}
    commits with `payment_method = null`; on promotion the entry gets the 48h
    clock while the group's method write is suppressed by its `not exists
    (other pending)` guard. The page reads the null cart method, renders
    `offline_due` with no PayButton and no instructions, `notifyPromoted` reads
    the same column so the email carries no pay link — and 48h later it lapses.
    FIX: resolve the money state from the DIVISION's payment method.
11. **`register/status/page.tsx:95` — the subtotal never comes down.** It
    filters only `status !== "waitlisted"`, so withdrawn, expired and rejected
    entries keep contributing their full fee **on the very page that offers the
    Cancel button**. Cancel B in a £50 cart and B is correctly badged
    "Withdrawn" with its button gone while the footer still reads £50.00 —
    `withdrawCore` never zeroes `amount_cents`. The new "Resend confirmation"
    button emails the identical inflated figure. FIX: filter on the set of
    statuses that actually owe money.
12. **`registrations.ts:929` — a second promotion is never reminded.** Neither
    `promoteWaitlistedRow` nor the lapse UPDATE clears
    `promotion_reminded_at`, but pass (1b) filters
    `and r.promotion_reminded_at is null`. A re-promoted entry is skipped
    permanently, and cannot fall back to pass (1a) either (that requires
    `r.promoted_at is null`). FIX: null it in the same UPDATE that sets a new
    `promotion_expires_at`.
13. **`register/status/entry-card.tsx:98` — the deadline shown is neither the
    registrant's clock nor the one enforced.** Rendered
    `fmtDateTime(UTC, money.deadline)` — hardcoded UTC, module-constant `en-GB`.
    An Asia/Kolkata org's cart expiring `2026-09-01T19:00Z` (00:30 on 2 Sept
    local) renders "01/09/2026, 19:00": wrong clock, wrong calendar day, no zone
    label; identical at `:114`. Separately `notifyPromoted` sends
    `payDeadline: promoted.expires_at` (`:987`) — the GROUP column — while the
    lapse pass keys strictly on the ENTRY's `promotion_expires_at`, so an
    entrant who pays by the emailed date is lapsed anyway. FIX: thread the org
    timezone already resolved as `refundTz` onto `GroupStatusView`; send the
    entry's own clock in the mail.
15. **`register/join/page.tsx:80` — a throttled teammate is told the link is
    dead.** 5 previews/300s per IP, and a throttled visit renders the terminal
    "This join link isn't valid … it may have expired" at HTTP 200 with no
    `Retry-After`. A captain sharing claim links with a team on one venue wifi
    or CGNAT egress IP burns the bucket — which is shared byte-for-byte with the
    GET route `refreshSlots()` also spends, so one visitor plus two refreshes is
    3 of the 5. On the POST side `classifyJoinFailure` has no `rateLimited` arm
    (429 is not 404, not 409, not ≥500), so it returns `rejected`, whose copy
    its own doc comment scopes to roster cap and eligibility. FIX: add a
    `rateLimited` arm and a distinct retry state.

### What the findings say about this session's own process

- **Five of these (#2, #5, #7, #9, #12) are defects RS007 CREATED**, all in
  the promotion/lapse/reminder machinery this wave added, and all in code that
  had never run in production because the sweep had no scheduler. This wave
  turns that code on. The reminder path in particular goes live for the FIRST
  TIME because of this PR — the same observation the first adversarial pass made
  about its finding #3, still true, now with five confirmed defects behind it.
- **V381 was a partial fix, twice over.** Written to stop a crash losing a
  reminder forever, it left the claim group-scoped (#7) and the mint ordering
  unchanged (#9). Both were visible in the same twenty lines. A lease that
  fixes the crash window while leaving the scoping wrong reads as "reminders are
  now safe" and is not.
- **#14 is a hole in my own fix.** `2d4d7b623` narrowed the collapse rule to
  close a 422 dead end; the hydration effect's `if (saved) … else if
  (collapseEntries)` reopened it for a restored EMPTY cart. The whole-branch
  review's probe (e) had explicitly reported "no dead path found" here — it
  tested a narrower claim (a division whose entrant kind CHANGED) than the one
  it appeared to settle. A refutation is only as strong as the case it tested.
- **No walkthrough crosses invite-and-pay.** `rs007-registration-journey` is a
  FREE division (captain enters, mate claims, no money);
  `registration-connect` is a paid entry with NO invite and NO claim. Several of
  these findings live exactly on that seam, and #4 (join consent collected then
  discarded) would very likely have failed a walkthrough that crossed it. The
  invite-and-pay-and-cancel walkthrough is the missing witness for #4, #10, #13.

### Lane closed 2026-08-27 — youth override, `ref_code`, stranded cutoff

Not part of the 15 above; these came from the gap review and were the "two
lower-severity findings recorded but unfixed" the PR body used to mention.
All three fixed, counts re-run by the main thread (80/80,
`registration-hub-config-panel.test.tsx` + `divisions.test.ts`, paths confirmed
inside the rs007 worktree).

- **Youth override no longer lost on a hub Save** (`divisions.ts`,
  `afbe8118c`). An active override is detected by comparing stored `youth`
  against `deriveYouth(stored age_max)`; a mismatch can only have come from an
  earlier explicit PATCH, so it survives. 2/4 red → 4/4.
- **`ref_code` was non-null-asserted and genuinely can be null**
  (`9cd05d9c6`). `groupById`'s own doc comment and the status page's both say a
  ref-mint-exhausted submit still commits. **The trap worth keeping: `!` erases
  at compile time, so a behavioral test passes identically with and without it**
  — 2/2 green before the fix. The only red was `tsc --noEmit`, and only after
  the declared type was widened to `string | null`: 1 error → 0. Recorded as
  `reference_non_null_assertion_red_is_tsc_only`.
- **Clearing an age band now clears its cutoff** (`c2ee0f0e6`). Not a DB
  rejection — `divisions_age_cutoff_check` enforces cutoff month/day
  both-or-neither and is indifferent to the band, so the value was silently
  stranded, and the cutoff controls `disable` once the band clears, leaving no
  UI path to remove it. 2/76 red → 76/76.

Lane-boundary note: the sibling status-page lane's concurrent edits briefly
contaminated one `tsc` run with an error on a file this lane was told not to
touch. It cleared when they committed. Two lanes in one worktree share the
index and the type graph — this is the shared-worktree contamination trap, and
it presented here as someone else's compile error inside this lane's gate.

### Lane closed 2026-08-27 — status-page money and claim links (closes #11)

Counts re-run by the main thread: **152/152, 57 suites**, every path inside the
rs007 worktree.

- **#11 subtotal — CONFIRMED, not refuted.** The agent traced all three write
  paths that end an entry — `withdrawCore` (`registrations.ts~3546`), the
  rejection path (`registration-approval.ts:210`) and the expiry sweep
  (`registrations.ts:3939`) — and **none of them clears `amount_cents`**. So a
  cancelled entry's pre-cancellation fee stayed in the total permanently. Fixed
  with `entryCountsTowardTotal` (pending/paid/confirmed only), shared by the
  Subtotal filter and each card's new per-entry fee line, so the two cannot
  drift the way the collapse rule did.
- Dead claim links, the fail-closed refund reason (new key
  `register.status.cancel.refund.noDeadline`, all 4 dicts + `i18n:gen-keys`),
  the join form losing a valid "someone else" pick across a refresh, and the
  `flex-1` → `grow` cascade fix.
- Per-fix red→green, each stated separately rather than as one final green:
  13→69/69, 5→74/74, 1→76/76, 5+1→67/67, 1→77/77.
- **The layout fix was mutation-checked by hand** — removing `flex-wrap` still
  reds the guard — and the mutation was restored from a `cp` backup, never
  `git checkout`, which in a shared worktree would have taken a sibling lane's
  uncommitted work with it.
- Both lanes ran concurrently in one worktree for ~29 minutes and neither
  cross-contaminated: every stage used explicit file pathspecs, verified clean
  after each commit. That is the mitigation that makes two lanes in one
  worktree survivable; ownership lists alone would not have.

### Lanes in flight 2026-08-27 (written for compaction)

Three implementer lanes dispatched at once, file sets provably disjoint. A
fourth (invite-pay-cancel walkthrough) was already running and owns
`apps/web/e2e/**`, which none of the three touch.

| Lane | Findings | Owns |
| --- | --- | --- |
| money | #1, #2, #5, #7, #9, #12 | `registrations.ts` + its tests, `register/status/**` if a per-entry field must reach the UI |
| migration | #3 | `V380__…consolidation.sql`, new `__tests__/v380-age-band-backfill.test.ts` |
| join | #4, #15 | `register/join/**`, `registration-submit.ts`, `schemas.ts`, `openapi/*`, dicts |

**Flyway V-numbers pre-allocated, because this programme has already shipped
two V367s through a clean rebase:** high-water is **V382**; money lane takes
**V383** (per-entry reminder claim, replacing the group-scoped one V381 left),
join lane takes **V384** (per-player consent, only if
`registration_players` has nowhere to put it). Check for duplicates before the
next rebase regardless — a clean rebase does not detect them.

**NOT yet assigned — #8, #10, #13.** All three land on the status page's money
state and would collide with the money lane: #8 wants a deadline re-check
inside `resumeRegistrationCheckout`, #10 wants the money state resolved from
the DIVISION's payment method rather than the cart's, and #13 wants the org
timezone (already resolved as `refundTz`) threaded onto `GroupStatusView` plus
the entry's own clock sent in the promotion mail. All three reach into
`registrations.ts`. They go in a fourth lane AFTER the money lane commits, not
in parallel with it.

**Instruction given to every lane, and the reason it matters here:** explicit
file pathspecs on every `git add`, never `-A`. Two lanes already ran
concurrently in this worktree for ~29 minutes without cross-contamination on
exactly that discipline. The shared git index makes "disjoint file sets" a
necessary condition, not a sufficient one.
