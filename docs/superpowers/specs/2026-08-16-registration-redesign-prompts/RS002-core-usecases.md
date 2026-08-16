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
     generation scheme as before), N `registrations` (join_code generated for
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

## Gotchas

- A rejected SQL statement aborts the WHOLE transaction — the old code's
  row-lock pattern matters; don't catch-and-continue inside the tx.
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
