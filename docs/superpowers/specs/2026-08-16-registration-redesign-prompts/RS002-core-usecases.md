# RS002 — core usecases: group submit, eligibility, approval, materialization

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS001's verdicts), then this. Backend-only session.

Branch `feat/rs002-registration-usecases` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §3, §4 (submit
semantics), §6 (materialization).

## Why

RS001 left `usecases/registrations.ts` compiling but logically hollow: no way
to create a registration exists. This session builds the entire server-side
brain — cart submit, per-player eligibility, approval transitions,
registration→entrant materialization — so RS003 endpoints are thin wrappers.

## Scope

All in `apps/web/src/server/usecases/registrations.ts` (+ split into sibling
modules if it passes ~600 lines — it was near that before) and
`usecases/__tests__/`:

1. **`submitRegistrationGroup(ctx, input)`** — input: contact
   {name,email,dob?,gender?,user_id?}, locale, entries[] each {division_id,
   entrant_kind, team_name?, free_agent?, players[]?, answers, partner_name?,
   registering_self? + self player index}. One transaction:
   - per entry: window open (`windowOpen`), settings enabled, kind matches
     division, free_agent allowed only when `allow_free_agents`
   - eligibility (see 2) for the registrant when self-playing and for **every
     player row**
   - guardian consent when the registrant is a minor; privacy consent required
     (versioned, as before)
   - capacity: row-lock per division (`FOR UPDATE` on the counted set, as the
     old code did), plan cap via `getLimit("entrants.per_division.max")`;
     over-capacity entries → `waitlisted`, others → `pending` (auto) and then
     `confirmed` if approval=`auto` and no payment due, mirroring the old
     status ladder
   - inserts: one `registration_groups` row (ref_code, access_token — same
     generation scheme as before; `currency` snapshotted from
     `organizations.currency` — the RS001b column, NOT NULL, no default, so a
     missed snapshot fails loudly at insert), N `registrations` (join_code generated for
     team entries), M `registration_players` (source=`captain_entered`,
     consent_status=`pending`, except a self row = `granted`)
   - **payable subtotal**: sum fees of non-waitlisted entries only; store on
     the group; per-entry amount_cents stays. Waitlisted entries are NEVER
     charged at submit (owner ruling 7).
2. **Eligibility**: extend `eligibilityIssues()` to read first-class
   `divisions.category`/`age_min`/`age_max` **plus** the existing jsonb rules;
   new `rosterIssues(division, players[])` — per-player age/gender checks +
   mixed composition (≥1 of each gender among gendered rows). Category
   semantics: `mens`→m, `womens`→f, `mixed`→composition rule, `x` never blocks
   a person from any category (record this as the ruling; flag disagreement in
   the PR body if the owner should revisit).
3. **Approval transitions**: `approveRegistration`, `rejectRegistration`
   (manual mode only, pending→confirmed|rejected, rejected is terminal),
   `withdrawRegistration`, `promoteFromWaitlist` (oldest-first default,
   explicit-id override; promotion of a paid division issues the
   pay-on-promotion state reusing `expires_at`). All idempotent, all
   structured-logged (standing rule: new code ships structured logging).
4. **Materialization rewrite**: confirm path creates `entrants` +
   `entrant_members` from **`registration_players`** (not roster jsonb):
   person get-or-create by (org, name[, dob]) honoring the existing persons
   identity index semantics; sets `registration_players.person_id`; new
   persons get `consent.public_name=true` (owner ruling 5). Free-agent
   confirms without a team materialize nothing until assigned (RS009).
5. **`joinTeamEntry(ctx, {join_code, player})`** — validates entry exists,
   registration not withdrawn/rejected/expired, roster below the division's
   max (squad-size config where defined, else unlimited), per-player
   eligibility; inserts `registration_players`
   (source=`self_joined`, consent_status=`granted`|`guardian`).
6. **Group read model**: `groupByRef(ref, access_token)` returning entries +
   players + per-entry status for the status page; `listRegistrations`
   cross-division filters (division, status, kind, free_agent,
   consent-pending, text) for the hub.

## Acceptance criteria

- [ ] Two concurrent submits racing the last slot: exactly one confirmed, one
      waitlisted (real concurrency test against the test DB, as the old
      capacity test did)
- [ ] Mixed division rejects an all-male roster, accepts m+f, `x` rows count
      for neither side but block nothing
- [ ] Age band: player over/under → per-player issue naming the row index
- [ ] Cart of 3 with 1 waitlisted → subtotal charges 2; group insert atomic
      (kill mid-tx test: nothing persisted)
- [ ] Group insert snapshots `organizations.currency`; changing the org
      currency afterwards leaves existing groups' currency untouched
- [ ] Approval: manual division holds `pending` even when free+capacity ok;
      approve→confirmed materializes; reject terminal (approve after reject
      fails); auto division unchanged from old behavior
- [ ] Materialization idempotent (`entrant_id` set once), members =
      registration_players, persons created with `public_name=true`
- [ ] join: happy path, full-roster rejection, dead-code rejection, withdrawn
      entry rejection
- [ ] Suite counts pasted from JSON reporter; `tsc EXIT=0`; lint clean

### Test types

- **Unit** — everything above (DB-backed usecase tests).
- **E2E/Smoke** — deferred: RS006/RS007/RS010 (no reachable surface).
- **Regression** — the capacity race; idempotent materialization; waitlist
  never charged.

## Entry conditions RS001 hands over — resolve these, don't discover them

RS001 (PR #592) left three things deliberately unfinished because they need
decisions that belong to THIS session. `_INDEX.md` has the full write-up; the
short form:

1. **Cart-level money is flattened onto entry rows, and multi-entry carts are
   exactly what you are about to build.** `RegistrationWithGroupRow` merges the
   cart's payment envelope onto one entry, which is exact while carts are 1:1 —
   all that exists today — and wrong the moment a cart holds two. Three shapes
   in `usecases/registrations.ts` break, none of them at compile time; each
   carries an inline pointer to the block comment above
   `RegistrationWithGroupRow`:
   - `stripeRefund(intent, undefined)` refunds the cart's FULL remaining
     balance (withdraw path, late-payment webhook) — refunding ONE entry would
     claw back its siblings' money. Pass the entry's own `amount_cents`, as
     `refundRegistration` already does.
   - `set refunded_cents = <entry fee>` OVERWRITES the cart total instead of
     accumulating; the correct additive pattern already exists in that file
     (`greatest(refunded_cents, …)` on the dispute path).
   - `remaining = reg.amount_cents - reg.refunded_cents` mixes an entry fee
     with a cart total — a sibling's refund drives it negative and the
     organiser is told "Already fully refunded" for an untouched entry.
   **The decision RS001 did not take:** whether per-entry refunds get their own
   `registrations.refunded_cents` or are derived. Take it explicitly, record it
   in `_INDEX.md`, and note that the schema half is a one-column delta.
2. **The submit-time privacy-consent (GDPR) check went out with
   `submitRegistration`.** Its test ("rejects submissions without privacy
   consent", spec 2026-07-14) was deleted with it, so NOTHING in the tree fails
   without the rule. Reimplement it on the group submit path — this is a
   compliance rule, not a nicety — and ship the regression test that fails
   without it.
3. **Materialization now links people through `registration_players.user_id`**
   (RS001 restored the `resolvePlayerPerson` upsert that the demolition had
   silently orphaned). The producer is yours: the submitter's own player row
   must carry `user_id` at submit when they are playing ("I'm playing", design
   §4 step 1), or the #402/#404 identity dedupe stays dormant for every new
   registration.

## Gotchas

- A rejected SQL statement aborts the WHOLE transaction — the old code's
  row-lock pattern matters; don't catch-and-continue inside the tx.
- Sweep e2e specs by BEHAVIOUR, never by filename. RS001's sweep cleared every
  `registration*.spec.ts` and still shipped a red CI job, because
  `payments-hardening.spec.ts` creates registrations in raw SQL and is named
  for none of it. Use
  `git grep -a -n -E "insert into registrations|/register|registration_settings" -- apps/web/e2e`.
- `payments-hardening.spec.ts` T10 is parked under `test.skip` (its mechanism
  was the deleted public POST). Restoring it belongs to RS006/RS007, not here,
  but do not delete the frozen body.
- Persons identity index is scoped `lane='player'` — get-or-create must match
  its semantics or you'll ship duplicate persons.
- The registration→entrant path is also consumed by scheduling; entrant shape
  must not change (spec §9: no scheduling changes).
- `getLimit` entitlement read needs the org ctx — the old submit had it; keep
  the 402 semantics identical.

## Execution

One sequential implementer loop (single file family). Scout first: pin current
`registrations.ts` helper signatures RS001 kept, the persons get-or-create
precedent (person-merge #404 work), and the entitlement read call sites.
Reviewer focus: tx atomicity, race on capacity, eligibility bypass via
`x`/null dob, waitlist-charge leak, materialization idempotency.

## On close

`_INDEX.md`: RS002 → DONE + PR#, the `x`-gender ruling as recorded, any split
of `registrations.ts`, signatures RS003 will wrap. Memory + snapshot.
