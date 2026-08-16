-- =============================================================================
-- V363 — registration_groups + registration_players
--
-- Registration redesign, design of record
-- `docs/superpowers/specs/2026-08-16-registration-redesign-design.md` §3.
-- The old model could not express two shapes the product now needs:
--
--   1. A club rep enters SEVERAL teams and pays ONCE. Contact details, the
--      public ref code, the access token and the entire Stripe envelope all
--      lived on the entry row, so N entries meant N carts and N payments.
--      `registration_groups` is the cart: it owns contact, ref, token and the
--      payment; every registration belongs to exactly one. A group of size 1
--      is the ordinary single-entry case, not a special case.
--
--   2. A roster player is a PERSON who consents for themselves. Rosters were a
--      jsonb array on the entry (`registrations.roster`), which has nowhere to
--      put per-player consent, a claim token, or the `person_id` created at
--      materialization — so players typed in by a captain never consented to
--      anything and could never be matched to a real person.
--      `registration_players` is a real row per player, and V364 drops the
--      jsonb.
--
-- Prod holds ZERO registration rows (owner-confirmed 2026-08-16), so neither
-- this migration nor V364 backfills anything and every constraint is strict
-- from day one.
--
-- `org_id` follows the house convention (see V118 and `persons`): a real FK to
-- organizations plus the `set_org_from_parent` trigger, so writers never have
-- to pass it and it can never disagree with the parent.
--
-- Currency: `registration_groups.currency` snapshots the org's currency at
-- submit so a later org-currency change never re-prices an existing cart. It
-- is deliberately left unconstrained here — RS001b introduces
-- `organizations.currency` and the `REGISTRATION_CURRENCIES` allowlist CHECK
-- as its own delta (design §2 addendum).
-- =============================================================================

create table registration_groups (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations(id) on delete cascade,
  competition_id           uuid not null references competitions(id) on delete cascade,

  -- Who submitted the cart. `user_id` is set when the submitter was signed in;
  -- registration never requires an account, so it stays nullable.
  contact_name             text not null,
  contact_email            text not null,
  user_id                  uuid references users(id) on delete set null,
  locale                   text,

  -- Public handles for the cart: `ref_code` is the human-quotable reference
  -- printed on the status page, `access_token_hash` authenticates a link with
  -- no login behind it. Both moved off the entry row because the cart, not the
  -- entry, is what a registrant is handed.
  ref_code                 text,
  access_token_hash        text not null unique,

  -- Payment envelope: one payment per cart (design §4 step 5). Per-entry
  -- `amount_cents` stays on `registrations` because a cart can be partially
  -- waitlisted, and waitlisted entries are not charged at submit.
  amount_cents             integer not null default 0,
  currency                 text,
  payment_method           text,
  checkout_session_id      text,
  payment_intent_id        text,
  expires_at               timestamptz,
  reminded_at              timestamptz,
  refunded_cents           integer not null default 0,
  refunded_at              timestamptz,
  disputed_at              timestamptz,
  dispute_id               text,
  offline_marked_paid_at   timestamptz,
  offline_marked_paid_by   uuid references users(id),
  fee_percent              integer,

  -- The submitter's own privacy consent for the cart. Per-PLAYER consent lives
  -- on registration_players — this is the contact's acceptance at submit time,
  -- versioned so a policy change can be told apart from an old acceptance.
  privacy_consent_at       timestamptz,
  privacy_consent_version  text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint registration_groups_amount_nonneg   check (amount_cents >= 0),
  constraint registration_groups_refunded_nonneg check (refunded_cents >= 0),
  constraint registration_groups_locale_valid
    check (locale is null or locale in ('en','fr','es','nl')),
  constraint registration_groups_payment_method_check
    check (payment_method is null or payment_method in ('offline','stripe'))
);

create trigger trg_set_org before insert on registration_groups
  for each row execute function set_org_from_parent('competitions', 'competition_id');

-- Partial unique: a ref code is quotable by the public, so it must resolve to
-- exactly one cart, but it is only minted once the cart is persisted.
create unique index registration_groups_ref_code_key
  on registration_groups (ref_code) where ref_code is not null;

-- The organiser's Registrants tab reads a competition's carts newest-first.
create index registration_groups_competition_idx
  on registration_groups (competition_id, created_at);
create index registration_groups_org_idx on registration_groups (org_id);

-- Stripe webhooks arrive keyed by session/intent; the expiry sweep scans only
-- unpaid carts that carry a deadline. Every FK below also gets its covering
-- index so a users/org delete does not sequential-scan this table.
create index registration_groups_checkout_idx
  on registration_groups (checkout_session_id) where checkout_session_id is not null;
create index registration_groups_payment_intent_idx
  on registration_groups (payment_intent_id) where payment_intent_id is not null;
create index registration_groups_expiry_idx
  on registration_groups (expires_at) where expires_at is not null;
create index registration_groups_user_idx
  on registration_groups (user_id) where user_id is not null;
create index registration_groups_offline_paid_by_idx
  on registration_groups (offline_marked_paid_by) where offline_marked_paid_by is not null;

create table registration_players (
  id                uuid primary key default gen_random_uuid(),
  registration_id   uuid not null references registrations(id) on delete cascade,
  org_id            uuid not null references organizations(id) on delete cascade,

  full_name         text not null,
  email             text,
  dob               date,
  gender            text,

  -- `captain_entered` players were typed in by someone else and have not
  -- consented yet; `self_joined` players arrived through a join link and
  -- consented for themselves in the same request.
  source            text not null,

  -- Consent is per person. `guardian` means an adult consented for a minor,
  -- and `guardian_name` records WHO — the old model captured that on the entry
  -- row (`registrations.guardian_name`) and the design's player shape had
  -- nowhere to put it, which would have lost information V364 drops.
  consent_status    text not null default 'pending',
  consent_at        timestamptz,
  guardian_name     text,

  -- Set when the player is invited to claim their row (the consent moment for
  -- captain-entered players). `person_id` is filled at materialization.
  claim_token_hash  text,
  person_id         uuid references persons(id) on delete set null,

  squad_number      integer,
  is_captain        boolean not null default false,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint registration_players_gender_check
    check (gender is null or gender in ('m','f','x')),
  constraint registration_players_source_check
    check (source in ('captain_entered','self_joined')),
  constraint registration_players_consent_status_check
    check (consent_status in ('pending','granted','guardian'))
);

create trigger trg_set_org before insert on registration_players
  for each row execute function set_org_from_parent('registrations', 'registration_id');

-- Every read of a player is "the players of this entry" (roster fill meter,
-- eligibility, materialization), so registration_id leads.
create index registration_players_registration_idx
  on registration_players (registration_id);
create index registration_players_org_idx on registration_players (org_id);

-- A claim link must resolve to exactly one player row; most rows never get one.
create unique index registration_players_claim_token_key
  on registration_players (claim_token_hash) where claim_token_hash is not null;

-- Person-merge and "where does this person appear" walk this the other way.
create index registration_players_person_idx
  on registration_players (person_id) where person_id is not null;
