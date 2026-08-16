# RS001b — org preferred currency + registration currency allowlist

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS001's verdicts — this session starts only after RS001's PR is MERGED), then
this. Backend/schema micro-session; payment work loads `stripe:*`.

Branch `feat/rs001b-org-currency` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §2 (currency ruling),
§3 (organizations / registration_groups / registration_settings), §8.

## Why

Addendum decided 2026-08-16 after RS001 was already in flight (so it lands as
a delta, not an RS001 edit). Registration currency today is a free-form
3-char text input flowing straight into Stripe `price_data.currency` — any
unsupported value breaks the PUBLIC pay step, not settings save (owner hit
this live with INR). Two design faults die here:

1. **Per-division currency is incompatible with the cart.** One checkout
   session per cart, and a session has ONE currency — per-division currency
   makes a multi-division cart un-payable. Currency moves to the org.
2. **No allowlist.** Subscription INR works because the platform charges
   itself; registration is a **destination charge** (`transfer_data`) — a
   different rule set. Only currencies proven through the destination-charge
   loop may be offered.

## Scope

1. **Allowlist mechanism** (`apps/web/src/lib/currency.ts`):
   `REGISTRATION_CURRENCY_EXCLUSIONS` (starts empty; INR verdict below may
   populate it) and derived `REGISTRATION_CURRENCIES` =
   `SUPPORTED_CURRENCIES` minus exclusions. ONE authority — subscriptions
   keep the full list; registration derives from it. Do NOT fork a second
   hand-written list (parallel vocab lists drift).
2. **Live INR verify — do this FIRST, it decides the migration's CHECK.**
   Owner-sanctioned live loop (never print the key): one minimal-amount live
   Checkout destination charge in `inr` to the owner's real connected
   account, paid and then refunded. Passes → INR stays. Fails → add `inr` to
   the exclusions and record the exact Stripe error in `_INDEX.md` (False
   premises if the failure contradicts this file). Test-mode INR is already
   proven green (2026-08-16, GB→GB) — test mode proves nothing here.
3. **Delta migration** (`db/migration/deltas/V<next>__org_currency.sql`):
   - `organizations.currency` text NOT NULL default `'gbp'`, CHECK over the
     final `REGISTRATION_CURRENCIES` codes.
   - `registration_groups.currency` text NOT NULL, no default (must be
     explicitly snapshotted at insert). Safe as a plain ADD only because the
     table is empty (zero-data greenfield) — do not pattern-copy this
     elsewhere.
   - Drop `registration_settings.currency`.
4. **Read-site swap**: whatever fee/currency reads RS001 preserved
   (`reg.currency`, settings reads, display helpers) now read the org
   column — `tsc` and `grep -a` sweep for the dropped column; zero refs
   remain. Group-snapshot READS stay out of scope (RS002/RS003 consume the
   column; this session only creates it).
5. **Connect prefill**: `syncConnectAccount`
   (`server/usecases/stripe-connect.ts`) additionally mirrors the connected
   account's `default_currency` into `organizations.currency` ONLY while the
   org is still at the default `'gbp'` AND the value ∈
   `REGISTRATION_CURRENCIES`. Never overwrite an explicit choice; structured
   log on apply and on skip-reason.

No UI this session (RS004 ships the select + chip). No new user-facing
strings ⇒ no i18n work owed.

## Acceptance criteria

- [ ] Live INR verdict recorded in `_INDEX.md` (pass: INR in CHECK + list;
      fail: excluded in BOTH, exact error quoted) — refund confirmed either way
- [ ] Drift test: DB CHECK code set == `REGISTRATION_CURRENCIES` (reads
      `pg_constraint` on the test DB; list change without migration change
      goes red)
- [ ] Zero-decimal guard test: every `REGISTRATION_CURRENCIES` entry is
      2-decimal (fee inputs and stored cents do `×100` math — a zero-decimal
      currency would charge 100× the intended amount)
- [ ] `grep -a` sweep: zero references to `registration_settings.currency`
- [ ] Prefill: sets while default + supported; skips when org chose
      explicitly; skips when account default is excluded (three unit tests)
- [ ] Fresh schema (`db:apply` AND `sync:sports`) green; suite counts pasted
      from JSON reporter; `tsc EXIT=0`; lint clean

### Test types

- **Unit** — drift, zero-decimal guard, prefill guards (DB-backed).
- **E2E/Smoke** — deferred: RS006/RS007/RS010 (no reachable surface).
- **Regression** — the drift test IS the regression net for every later
  list change.

## Gotchas

- The CHECK constraint is written AFTER the live INR verdict — sequencing
  inside the session matters.
- Live key handling per standing rule: run the loop, never echo the key or
  paste raw account objects into the transcript.
- `db:apply` alone is NOT a fresh schema — pair with `sync:sports` or
  `funnel.test.ts` reds on an unrelated assertion.
- rtk vitest summaries lie on collection failure — judge green only from
  `--reporter=json` counts.
- Postgres: a rejected statement aborts the whole tx — don't catch-and-
  continue inside the migration or the prefill write.

## Execution

Inline-first session (small file set: one migration, `lib/currency.ts`,
`stripe-connect.ts`, tests). Scout only for RS001's surviving read sites.
Reviewer focus: CHECK/list drift, prefill overwrite bug, live-loop hygiene.

## On close

`_INDEX.md`: RS001b → DONE + PR#, INR verdict + error text, final list as
shipped. Memory + snapshot.
