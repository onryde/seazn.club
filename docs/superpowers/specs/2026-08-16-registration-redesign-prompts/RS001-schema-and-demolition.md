# RS001 — schema migrations + old-surface demolition

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Backend + deletion session; no new UI.

Branch `feat/rs001-registration-schema` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §3 (data model), §7 (P1).

## Why

The new registration model (groups, per-player rows, first-class categories,
approval) is a different shape from the current one (single row, roster jsonb).
Prod has zero registration data, so the correct move is drop-and-replace, and
every old surface that reads/writes the old shape must die in the same PR the
schema changes — otherwise the tree doesn't compile or, worse, compiles against
a shape the DB no longer has.

## Scope

1. **Migrations** (Flyway deltas under `db/migration/deltas/`, next V-numbers;
   load `supabase:supabase-postgres-best-practices` first):
   - `registration_groups`: id, org_id, competition_id, contact_name,
     contact_email, user_id nullable, ref_code, access_token_hash, locale,
     amount_cents, payment fields mirroring today's registration payment
     columns (payment_method, Stripe refs, expires_at), timestamps.
   - `registration_players`: id, registration_id FK, org_id, full_name, email
     nullable, dob nullable, gender nullable (`m|f|x`), source
     (`captain_entered|self_joined`), consent_status
     (`pending|granted|guardian`), consent_at, claim_token_hash nullable,
     person_id nullable, squad_number nullable, is_captain default false.
   - `registrations`: add group_id FK **NOT NULL**, join_code nullable,
     free_agent boolean default false; status enum gains `rejected`; **drop
     `roster`**. Payment/columns that move to the group level: drop from
     registrations only if nothing else reads them — check first, record the
     verdict in the PR body.
   - `divisions`: add `category` (`open|mens|womens|mixed`, nullable),
     `age_min` int nullable, `age_max` int nullable.
   - `registration_settings`: add `approval` (`auto|manual`, default `auto`),
     `allow_free_agents` boolean default false.
   - Indexes: registrations(group_id), registration_players(registration_id),
     registration_players(person_id), registrations(division_id, status)
     if not already present. FKs get ON DELETE CASCADE from group → entries →
     players.
2. **Demolition** (delete, don't stub — except the two public pages):
   - `apps/web/src/components/public-site/register-form.tsx`
   - old `POST` handler
     `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts`
   - `PublicRegisterRequest` in `apps/web/src/server/api-v1/schemas.ts`
     (~1803–1869) + its openapi output (`npm run openapi:gen` after)
   - `apps/web/src/components/v2/registrations-panel.tsx`,
     `registration-list.tsx`, `registration-settings.tsx`,
     `registration-pulse.tsx` (verify last one is registration-only first)
   - org route `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/registrations/page.tsx`
     + the `routes.divisionRegistrations` helper + its link on the division
     page (`d/[divSlug]/page.tsx` ~:225)
   - The public pages `.../register/page.tsx` and `.../register/status/page.tsx`
     become minimal server components rendering the existing closed/unavailable
     state (reuse existing `register.*` closed keys where they fit; anything new
     → 4 locales). Check `app/(public)/r/[ref]/page.tsx` — if it reads
     registrations, give it the same treatment; record the verdict.
   - `usecases/registrations.ts`: delete `submitRegistration` and everything
     only the deleted surfaces called. Keep/adapt read-side helpers
     (`loadSettings`, list queries, waitlistPositions, the registration→entrant
     confirm path) to the new columns so they compile — **RS002 rewrites their
     logic; this session only keeps the tree green.**
3. **Server types**: `RegistrationRow`, `RegistrationSettingsRow` + new
   `RegistrationGroupRow`, `RegistrationPlayerRow` matching the new schema.
4. **Test sweep**: delete/adjust every test, e2e spec section, and
   `scripts/smoke.ts` section that drives the deleted surfaces. Park nothing
   silently — list every deleted test in the PR body; RS010 owes the
   replacements and its prompt already says so.

## Acceptance criteria

- [ ] Fresh test DB (`db:apply` + `sync:sports`) comes up; schema tests assert
      the new tables/columns/enum values and the NOT NULL + CASCADE behavior
- [ ] `git grep -a` finds zero references to `roster` (registration sense),
      `PublicRegisterRequest`, `registrations-panel`, `registration-list`,
      `divisionRegistrations` outside git history
- [ ] Register page and status page render the closed state (browser-verified,
      1280/320); no form, no POST route
- [ ] Full web suite green (JSON reporter counts pasted), `tsc EXIT=0`, lint
      `✖ 0 problems`, `openapi:gen` + `i18n:gen-keys` → `git status` clean
- [ ] PR body lists: every deleted file, every deleted test, the
      payment-columns verdict, the `r/[ref]` verdict

### Test types

- **Unit** — schema shape + constraint tests (DB-backed).
- **E2E / Smoke** — deferred: RS006/RS007 (public), RS004/RS005 (org),
  RS010 (smoke). This session only removes dead coverage and proves the closed
  state renders.
- **Regression** — closed-state page render; enum accepts `rejected`.

## Gotchas

- `db:apply` alone is NOT a fresh schema — `sync:sports` or funnel tests fail.
- The e2e workflow file is LIVE on PRs; deleting specs it names will red CI —
  check `.github/workflows/e2e.yml` *references* (do not edit the file's
  trigger structure).
- `seed:demo` may seed registrations — if it does, update the seeder in this
  session (it writes the old shape).
- Deleting user-facing strings: leave unused `register.*` keys in place unless
  `i18n:check` complains — RS006 reclaims the namespace; note leftovers in the
  PR body.

## Execution

Sequential, one implementer loop (schema → demolition → types → sweep), no
parallel agents — everything overlaps `registrations.ts`/`schemas.ts`.

**Scout (sonnet):** every reference to the deletion list above
(`git grep -a`, include `e2e/`, `scripts/`, `content/help/`), plus current
V-number high-water mark in `db/migration/deltas/`. file:line table, under 40
lines.

**Implementer / Reviewer** per `_RULES.md` §4. Reviewer's focus: does anything
still read a dropped column; is any FK missing CASCADE; did a "kept for RS002"
helper accidentally keep dead logic alive.

## On close

`_INDEX.md`: RS001 → DONE + PR#, the V-numbers used, the payment-columns and
`r/[ref]` verdicts, every deleted test listed for RS010. Memory + snapshot.
