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
2. **No allowlist, and a possible FX leg.** Subscription INR works because
   the platform charges itself; registration is a **destination charge**
   (`transfer_data`) — a different rule set. Owner ruling (2026-08-16):
   **same-currency rule** — a connected org's charge currency always equals
   its account's settlement currency (INR account → INR, GBP → GBP), so no
   FX leg ever exists; free allowlist choice is for UNCONNECTED (offline/
   display) orgs only. INR card payment is therefore out of reach for now
   (GB platform cannot onboard IN-settled accounts — IN is not in its
   transfer countries); INR stays selectable for offline/display orgs.

## Scope

1. **Allowlist mechanism** (`apps/web/src/lib/currency.ts`):
   `REGISTRATION_CURRENCY_EXCLUSIONS` (starts empty; the standing lever for
   delisting a registration currency without touching subscriptions) and
   derived `REGISTRATION_CURRENCIES` = `SUPPORTED_CURRENCIES` minus
   exclusions. ONE authority — subscriptions
   keep the full list; registration derives from it. Do NOT fork a second
   hand-written list (parallel vocab lists drift).
2. **Same-currency enforcement** (`server/usecases/stripe-connect.ts`,
   `syncConnectAccount`): while connected, `organizations.currency` mirrors
   the account's `default_currency` — on every sync, overwriting any manual
   choice (the lock IS the ruling; RS004 greys the select accordingly).
   When the account's `default_currency` ∉ `REGISTRATION_CURRENCIES`:
   leave `organizations.currency` untouched and set a card-unsupported
   state the settings UI can read (pattern-match how
   `stripe_disabled_reason` is stored/read; RS004 renders the message) —
   the failure surfaces at CONNECT time, never on the public pay page.
   Structured log both branches (applied / unsupported-skip).
3. **Delta migration** (`db/migration/deltas/V<next>__org_currency.sql`):
   - `organizations.currency` text NOT NULL default `'gbp'`, CHECK over the
     `REGISTRATION_CURRENCIES` codes.
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
No UI this session (RS004 ships the select + chip). No new user-facing
strings ⇒ no i18n work owed.

## Acceptance criteria

- [ ] Same-currency lock: sync overwrites a manually-set org currency with
      the account's `default_currency`; unsupported settlement currency →
      card-unsupported state set, `organizations.currency` untouched;
      unconnected org → sync never touches currency (three unit tests)
- [ ] Drift test: DB CHECK code set == `REGISTRATION_CURRENCIES` (reads
      `pg_constraint` on the test DB; list change without migration change
      goes red)
- [ ] Zero-decimal guard test: every `REGISTRATION_CURRENCIES` entry is
      2-decimal (fee inputs and stored cents do `×100` math — a zero-decimal
      currency would charge 100× the intended amount)
- [ ] `grep -a` sweep: zero references to `registration_settings.currency`
- [ ] Fresh schema (`db:apply` AND `sync:sports`) green; suite counts pasted
      from JSON reporter; `tsc EXIT=0`; lint clean

### Test types

- **Unit** — drift, zero-decimal guard, same-currency lock branches
  (DB-backed).
- **E2E/Smoke** — deferred: RS006/RS007/RS010 (no reachable surface).
- **Regression** — the drift test IS the regression net for every later
  list change.

## Gotchas

- The lock overwrites on EVERY sync, not just the first — an org that
  changes its Stripe bank/settlement currency later must converge on the
  next sync, and existing groups keep their snapshots (RS002's rule).
- `db:apply` alone is NOT a fresh schema — pair with `sync:sports` or
  `funnel.test.ts` reds on an unrelated assertion.
- rtk vitest summaries lie on collection failure — judge green only from
  `--reporter=json` counts.
- Postgres: a rejected statement aborts the whole tx — don't catch-and-
  continue inside the migration or the prefill write.

## Execution

Inline-first session (small file set: one migration, `lib/currency.ts`,
`stripe-connect.ts`, tests). Scout only for RS001's surviving read sites.
Reviewer focus: CHECK/list drift, lock-branch coverage (incl. the
unsupported-settlement path), card-unsupported state read path.

## On close

`_INDEX.md`: RS001b → DONE + PR#, the card-unsupported representation
chosen (RS004 reads it), final list as shipped. Memory + snapshot.
