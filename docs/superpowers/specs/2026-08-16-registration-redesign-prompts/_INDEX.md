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

| Session | Prompt file | Depends on | Status |
|---|---|---|---|
| RS001 | `RS001-schema-and-demolition.md` | — | **DONE** — PR #592 merged `850cc630` (2026-08-17) |
| RS001b | `RS001b-org-currency-allowlist.md` | RS001 | **IN FLIGHT** — branch `feat/rs001b-org-currency` |
| RS002 | `RS002-core-usecases.md` | RS001b | TODO |
| RS003 | `RS003-public-endpoints.md` | RS002 | TODO |
| RS004 | `RS004-hub-settings-tab.md` | RS003 | TODO |
| RS005 | `RS005-hub-registrants-tab.md` | RS004 | TODO |
| RS006 | `RS006-public-stepper.md` | RS003 | TODO |
| RS007 | `RS007-status-page-join-payments.md` | RS006 | TODO |
| RS008 | `RS008-consent-claim-optout.md` | RS007 | TODO |
| RS009 | `RS009-free-agents.md` | RS005, RS003 | TODO |
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
  `V365__org_currency.sql`. Applies from zero on a clean schema (204
  migrations, verified on a second fresh DB, not just incrementally).
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
- **`schedule-build-honours-locks.test.ts` is RED ON MAIN** — 7/11 with the same
  4 failures (`expected undefined to be '2026-08-01T19:00:00.000Z'`), reproduced
  on a clean detached worktree at `252a073d` with its own fresh DB. Not caused
  by RS001, and worth someone's attention independently.

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
