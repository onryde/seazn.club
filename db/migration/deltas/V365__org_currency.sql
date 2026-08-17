-- =============================================================================
-- V365 — one preferred currency per ORG, over a platform allowlist
--
-- RS001b, the currency addendum decided 2026-08-16 after RS001 was already in
-- flight (design §2 currency ruling, §3). Two design faults die here:
--
--   * Per-division currency is incompatible with the cart. The redesign mints
--     ONE Stripe checkout session per cart, and a session has ONE currency, so
--     a cart spanning two differently-priced divisions was un-payable. Currency
--     moves up to the organisation, where it is a single fact.
--
--   * Currency was a free-form 3-char text input flowing straight into Stripe
--     `price_data.currency`. An unsupported code therefore broke the PUBLIC pay
--     step rather than the organiser's settings save (the owner hit this live
--     with INR). The CHECK below is the allowlist, and it is deliberately
--     placed on the column the fee is priced from, not on the request schema —
--     a zod change alone leaves every direct DB writer (scripts, tests, later
--     usecases) free to write an unchargeable code.
--
-- The CHECK's code set MUST equal `REGISTRATION_CURRENCIES` in
-- `apps/web/src/lib/currency.ts` (= `SUPPORTED_CURRENCIES` minus
-- `REGISTRATION_CURRENCY_EXCLUSIONS`, empty today). Neither side can see the
-- other — `tsc` cannot read a SQL CHECK and Postgres cannot read a TS constant
-- — so `org-currency.test.ts` parses this constraint back out of
-- `pg_constraint` and fails if they drift. Changing one without the other is
-- the failure that test exists for.
--
-- Same-currency rule (owner ruling 2026-08-16): while an org has a connected
-- account, this column is LOCKED to that account's settlement currency by
-- `syncConnectAccount`, so a destination charge never carries an FX leg. Free
-- choice from the allowlist applies only while unconnected (offline/display
-- orgs). An account settling OUTSIDE the allowlist records its code in
-- `stripe_unsupported_currency` and leaves `currency` untouched — a clean
-- card-unsupported state at CONNECT time, never a Stripe error on a
-- registrant's pay page.
--
-- Zero prod data (owner-confirmed 2026-08-16): no backfill, no compat shim.
-- =============================================================================

alter table organizations
  add column currency text not null default 'gbp',
  -- Mirrors how `stripe_disabled_reason` is stored and read: nullable, written
  -- by the Connect sync, surfaced through `connectStatus` for the settings UI
  -- to render (RS004). Holds the ACCOUNT's settlement currency when it is
  -- outside the allowlist; null means card registration is currency-viable.
  add column stripe_unsupported_currency text;

alter table organizations add constraint organizations_currency_check
  check (currency in ('usd','eur','gbp','inr','aud'));

-- The cart's snapshot of the org currency at submit (design §3). NOT NULL with
-- NO default on purpose: RS002's group insert has to name the currency it
-- quoted, so a later org-currency change can never rewrite what an already
-- submitted cart was charged in.
--
-- Deliberately carries NO allowlist CHECK, unlike `organizations.currency`. A
-- snapshot is a historical fact; delisting a currency later must not
-- retroactively invalidate carts that were legitimately quoted in it, and a
-- future migration re-adding a tightened CHECK would fail on exactly those
-- rows.
--
-- Safe as a plain NOT NULL with no default ONLY because the table is empty:
-- `registration_groups` was created in V363 and V364 deleted every old-shape
-- registration. Do not pattern-copy this onto a populated table.
alter table registration_groups
  alter column currency set not null;

-- Per-division currency is gone: one currency per org, and a cart that spans
-- divisions must be payable. Every read site now resolves the org column.
alter table registration_settings
  drop column currency;
