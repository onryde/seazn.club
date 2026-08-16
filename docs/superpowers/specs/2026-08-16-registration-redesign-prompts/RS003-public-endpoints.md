# RS003 — public endpoints: group register, join, status

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS002's signatures), then this. Backend/API session.

Branch `feat/rs003-registration-endpoints` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §4 (API paragraph).

## Why

RS002's usecases have no HTTP surface. This session ships the three public
endpoints the stepper (RS006), join flow (RS007) and status page (RS007)
consume, with the same abuse protections the old single endpoint had.

## Scope

1. **Zod schemas** (`server/api-v1/schemas.ts`): `PublicRegisterGroupRequest`
   — contact {display_name, contact_email, dob?, gender?}, locale?, entries[]
   (division_id, entrant_kind, team_name?, free_agent?, players[] max 50 each
   with name/dob?/gender?/squad_number?, answers, partner_name?,
   registering_self? + self index) — max entries per group (pick a bound, e.g.
   10, record it); superRefine mirrors the old single-self coherence rule
   across the whole cart (at most one "self" row cart-wide, dob required when
   self). `PublicJoinRequest` — join_code + one player + consent fields.
   Response schemas: per-entry {registration_id, status, ref…} + group ref +
   payment redirect when payable subtotal > 0.
2. **Routes** under
   `app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/`:
   - `POST` (group submit) — both rate-limit buckets (per-IP, per-IP+comp),
     honeypot field rejected quietly, locale capture — all exactly as the old
     route did (RS001's PR body lists what existed).
   - `POST .../register/join` — own tighter rate limit.
   - `GET .../register/status?ref=&token=` (or keep it page-server-side if the
     old status page fetched server-side — match the old pattern; the page
     itself is rebuilt in RS007).
3. **Payment orchestration**: after insert, when subtotal > 0, create the
   Stripe checkout for the GROUP (one session, line items per payable entry)
   in `group.currency` — the RS001b snapshot is what gets charged — after
   validating it ∈ `REGISTRATION_CURRENCIES` AND == the org's current
   currency (the same-currency lock pins that to the connected account's
   settlement currency; a snapshot gone stale because the org's currency
   moved since submit → clean 422 with a stable error shape, no Stripe
   call — a bad currency must never surface as a Stripe error on the
   public page), reusing the existing registration payment machinery
   RS001 preserved. Public request/response schemas never carry a currency
   field — it is server-resolved. Load
   `stripe:stripe-best-practices` before touching it. Webhook path: group
   payment success → entries pending→paid/confirmed via RS002 transitions;
   verify the existing webhook handler keys by registration — rework it to key
   by group.
4. **OpenAPI**: `npm run openapi:gen` — this is api-v1 zod, drift gate is
   CI-only.

## Acceptance criteria

- [ ] API tests: full cart happy path (2 teams + 1 individual across 2
      divisions) → group + 3 entries + players persisted, statuses correct
- [ ] Validation: >max entries, duplicate self rows, missing dob-when-self,
      unknown division, kind mismatch — each a clean 4xx with a stable error
      shape (server errors stay English — no server-side i18n)
- [ ] Rate limits + honeypot proven by test (mirror the old route's tests)
- [ ] Paid cart: checkout session created for subtotal of non-waitlisted
      entries only; webhook flips the whole group; partial-waitlist cart
      charges the right amount (test with Stripe test mode)
- [ ] Per-currency: a destination-charge checkout test runs for EVERY member
      of `REGISTRATION_CURRENCIES` (test mode, parameterised over the
      constant so a list change without a matching test run goes red);
      out-of-list currency on a group → 422, no Stripe call; snapshot ≠
      current org currency → 422, no Stripe call
- [ ] join endpoint: happy, full-roster, dead-code, rate-limited
- [ ] `openapi:gen` + `i18n:gen-keys` → `git status --porcelain` empty
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean

### Test types

- **Unit** — schema refinements, route handlers (DB-backed API tests).
- **E2E** — deferred to RS006/RS007 (no UI yet). **Smoke** — deferred RS010.
- **Regression** — honeypot + rate-limit behavior preserved; webhook
  group-keying.

## Gotchas

- The old webhook almost certainly keys on a single registration id — a green
  unit suite around the NEW path proves nothing about the OLD webhook route
  still deployed; grep every consumer of the payment metadata keys.
- Live billing tests locally are owner-sanctioned; never print the key.
- Public JSON endpoints in this repo are ISR/no-auth — the status GET must
  authorize by access_token comparison (hash), not session.
- `expires_at` semantics from RS001's verdict — the group holds payment
  expiry now; don't leave a dead per-registration copy half-read.

## Execution

Sequential implementer loop (schemas.ts + routes + webhook overlap). Scout:
pin old route's rate-limit/honeypot lines from git history (`git log -p` on
the deleted route), current webhook handler file:line, payment machinery
RS001 kept. Reviewer focus: authz on status GET, webhook group transition
atomicity, error-shape stability, subtotal correctness.

## On close

`_INDEX.md`: RS003 → DONE + PR#, the max-entries bound chosen, the webhook
rework verdict, endpoint shapes RS006/RS007 consume. Memory + snapshot.
