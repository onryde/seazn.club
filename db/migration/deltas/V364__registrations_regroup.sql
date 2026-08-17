-- =============================================================================
-- V364 — registrations join a group; divisions and settings get first-class
--        eligibility, approval and free agents
--
-- Second half of the registration redesign schema (design §3; V363 created the
-- two new tables). Prod holds ZERO registration rows (owner-confirmed
-- 2026-08-16), so this migration deletes rather than backfills, drops columns
-- outright, and adds a NOT NULL FK with no default.
--
-- The pre-existing rows this deletes are only ever local dev / `seed:demo`
-- data in the OLD shape: no group, no player rows, a roster jsonb that is
-- about to disappear. Migrating them would produce entries that violate the
-- new invariants, so they go.
--
-- What moves and why:
--
--   * The payment envelope (`payment_method`, the Stripe refs, `expires_at`,
--     refund/dispute/offline-paid fields, `fee_percent`, `currency`) moves to
--     `registration_groups`. One payment per cart is the design ruling, which
--     makes a per-ENTRY checkout session or payment intent meaningless — two
--     entries in one cart would have had to share, or duplicate, the same
--     Stripe references. A sweep of the tree confirmed every one of these
--     columns was read only inside `server/usecases/registrations.ts`.
--
--   * Identity and access (`contact_email`, `access_token_hash`, `ref_code`,
--     `locale`, `user_id`, the privacy-consent pair) move for the same reason:
--     they describe the SUBMITTER of a cart, not one entry inside it.
--
--   * `dob`, `gender`, `guardian_name`, `guardian_consent` move to
--     `registration_players`. The design makes every roster player individually
--     validated and individually consenting, so the player row is the single
--     source of truth; leaving nullable copies on the entry would guarantee the
--     two drift apart.
--
--   * `amount_cents` and `status` deliberately STAY per entry: a cart can be
--     partially waitlisted, and waitlisted entries are not charged at submit.
--
-- Dropping a column takes its indexes, CHECKs and FKs with it, so the old
-- `registrations_access_token_hash_key`, `registrations_ref_code_key`,
-- `registrations_locale_valid`, `registrations_gender_check`,
-- `registrations_payment_method_check`, `registrations_checkout_idx`,
-- `registrations_expiry_idx`, `registrations_user_idx` and
-- `registrations_offline_paid_by_idx` need no explicit drop. No view depends on
-- `registrations`, so nothing needs CASCADE.
-- =============================================================================

-- Old-shape rows (dev/demo only — prod is empty). Nothing references
-- registrations, so this cascades nowhere; materialized entrants survive on
-- their own and are unaffected.
delete from registrations;

alter table registrations
  add column group_id uuid not null references registration_groups(id) on delete cascade,
  -- A team entry can hand out a join link so players add themselves.
  add column join_code text,
  -- A free agent is an entry with no team of its own yet, waiting to be
  -- assigned into one (design §5, organiser action).
  add column free_agent boolean not null default false;

alter table registrations
  drop column roster,
  drop column contact_email,
  drop column access_token_hash,
  drop column ref_code,
  drop column locale,
  drop column user_id,
  drop column payment_method,
  drop column checkout_session_id,
  drop column payment_intent_id,
  drop column expires_at,
  drop column reminded_at,
  drop column refunded_cents,
  drop column refunded_at,
  drop column disputed_at,
  drop column dispute_id,
  drop column offline_marked_paid_at,
  drop column offline_marked_paid_by,
  drop column fee_percent,
  drop column currency,
  drop column privacy_consent_at,
  drop column privacy_consent_version,
  drop column dob,
  drop column gender,
  drop column guardian_name,
  drop column guardian_consent;

-- `rejected` is the new terminal status, reachable only from manual approval.
alter table registrations drop constraint registrations_status_check;
alter table registrations add constraint registrations_status_check
  check (status in ('pending','paid','confirmed','waitlisted','withdrawn','expired','rejected'));

-- A `?join=<CODE>` link carries nothing but the code, so it must resolve to
-- exactly one entry across the whole platform — hence global, not per-division.
create unique index registrations_join_code_key
  on registrations (join_code) where join_code is not null;

-- Cart siblings: "the other entries in this group" is read on the status page,
-- in the Registrants tab, and by every payment transition.
create index registrations_group_idx on registrations (group_id);

-- Note: (division_id, status) needs no new index — the existing
-- `registrations_division_idx` on (division_id, status, created_at) already
-- serves it as a leading-column prefix.

-- Eligibility becomes first-class. It lived in the `eligibility` jsonb, which
-- meant the public page could not show a category or age band as a badge and
-- only found out at validation time. The jsonb stays for custom extra rules.
alter table divisions
  add column category text,
  add column age_min integer,
  add column age_max integer;

alter table divisions add constraint divisions_category_check
  check (category is null or category in ('open','mens','womens','mixed'));
alter table divisions add constraint divisions_age_band_check
  check (age_min is null or age_max is null or age_max >= age_min);

-- `auto` reproduces today's behaviour exactly, so existing divisions keep
-- working untouched; `manual` unlocks approve/reject.
alter table registration_settings
  add column approval text not null default 'auto',
  add column allow_free_agents boolean not null default false;

alter table registration_settings add constraint registration_settings_approval_check
  check (approval in ('auto','manual'));
