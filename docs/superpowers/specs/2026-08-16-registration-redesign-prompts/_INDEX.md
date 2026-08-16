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
| RS001 | `RS001-schema-and-demolition.md` | — | IN PROGRESS — `feat/rs001-registration-schema` |
| RS001b | `RS001b-org-currency-allowlist.md` | RS001 | TODO |
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

## False premises found

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
