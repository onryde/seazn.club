-- =============================================================================
-- V510 — the player payment page (plan 2026-11-11-player-payment-page, Task 1).
--
-- Chase mails link a per-entry page on our domain, `/r/pay/<token>`, instead of a raw Stripe Checkout url. The token is
-- 32 random bytes (base64url) shown once inside the mail's url; only its sha256 is stored, exactly as
-- `sponsor_report_links` stores its report tokens (V492). A fresh token per mail, and every token for an entry stays
-- valid: the entry's own state, not token revocation, is what closes the page — so there is no revoked_at and no update
-- grant. A token dies with its entry (and with its org).
--
-- `registrations.pay_session_id` is the entry's OWN Checkout session pointer, minted from the page for this entry alone.
-- The cart's single `registration_groups.checkout_session_id` cannot serve: a sibling's mint overwrites it, after which a
-- second Pay press on this entry would mint a second payable session. Additive and nullable; no existing row changes.
-- =============================================================================

create table registration_pay_tokens (
  token_hash      bytea primary key,
  registration_id uuid not null references registrations(id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  created_at      timestamptz not null default now()
);
create index registration_pay_tokens_registration_idx on registration_pay_tokens (registration_id);

alter table registration_pay_tokens enable row level security;
alter table registration_pay_tokens force  row level security;
create policy registration_pay_tokens_tenant on registration_pay_tokens for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert on registration_pay_tokens to app_user;

alter table registrations add column pay_session_id text null;
