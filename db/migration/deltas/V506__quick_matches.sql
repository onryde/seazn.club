-- V506 — Quick match: the `quick_matches` table, and the one system org and system user that hold every guest quick match.
-- (Spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.1-7.2, owner-approved 2026-11-06.)
-- Flyway runs with outOfOrder=false, so the version number must rise in MERGE order: it is assigned at merge (main's max + 1
-- if needed). A renumber moves three things: this file's name, the `V506` on line 1 (migration-header-truth.test.ts fails
-- a header that disagrees with its file name), and the comments and test premise messages that cite V506 by number
-- (`git grep -n V506 -- apps`). No code or test finds this file by its name.
--
-- ── The system org and its user ──
-- A guest has no account, so every quick match is a private competition in ONE platform org, "Seazn quick matches", and every
-- guest-created row (device links included: `device_links.issued_by` is NOT NULL, V222) is issued by ONE platform user. The
-- ids, slug and email are fixed, and written verbatim in `apps/web/src/lib/quick-match-constants.ts`; change one, change both.
--  * The user can never sign in: no password_hash, no google_sub, and an `.invalid` email (RFC 2606) no mail can reach.
--  * The org has NO `org_members` row. No human administers it; every read and write goes through a quick match's own
--    token, which the app checks against `quick_matches` before anything else (spec §7.1 point 3).
--  * Its billing is the shape `createOrgForUser` mints (apps/web/src/lib/auth.ts): one community subscription owned by the
--    user, quantity 1. One override only: `competitions.max_active` with a null value, which the entitlement reader treats
--    as unlimited — every guest's match shares this org, so the plan's org-wide cap would otherwise be shared by every
--    guest at once. The per-visitor cap lives in `quick_matches` instead. A null limit also freezes nothing (`frozenCompetitionIds`).
--    No other override: community already allows the one division, one stage and six sides a quick match needs, and the
--    create path bounds sides and plays itself.
--
-- ── quick_matches ──
-- One row per quick match: everything guest-specific, so the existing tables get no new column and "is this a quick match"
-- is a join. `token_hash` finds the row from the home-page token; `token_enc` is its sealed envelope. `visitor_hash` is the
-- hashed visitor cookie the per-visitor cap counts by. `expires_at` and `reminder_sent_at` drive the expiry sweep;
-- `saved_by_user_id` is set when a signed-in user keeps the match. `org_id` is denormalized, as on every tenant table, for RLS.
--
-- Runs as the migrating role, which bypasses RLS (as V489 notes), so the seed inserts reach `organizations`.
-- The seed inserts are idempotent: a re-run changes nothing. A pre-existing org holding the slug `seazn-quick-matches` under
-- another id fails the whole migration LOUDLY (the conflict target is `id` only), rather than seeding half an org.

insert into users (id, email, display_name, email_verified)
values ('00000000-0000-4000-8000-00000000a002', 'quick-matches@system.seazn.invalid', 'Seazn quick matches', false)
on conflict (id) do nothing;

-- `subscriptions` has no unique key a conflict could name (one owner may hold many groups), so idempotency is a guard.
insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
select '00000000-0000-4000-8000-00000000a002', 'community', 'active', 1
where not exists (select 1 from subscriptions where owner_user_id = '00000000-0000-4000-8000-00000000a002');

insert into organizations (id, name, slug, created_by, subscription_id)
select '00000000-0000-4000-8000-00000000a001', 'Seazn quick matches', 'seazn-quick-matches',
       '00000000-0000-4000-8000-00000000a002', s.id
from subscriptions s
where s.owner_user_id = '00000000-0000-4000-8000-00000000a002'
on conflict (id) do nothing;

-- `expires_at` (V266) stays null: the override never expires.
insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value, reason)
values ('00000000-0000-4000-8000-00000000a001', 'competitions.max_active', null, null,
        'quick match system org: per-visitor cap lives in quick_matches')
on conflict (org_id, feature_key) do nothing;

create table quick_matches (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations (id) on delete cascade,
  competition_id   uuid not null unique references competitions (id) on delete cascade,
  name             text not null,
  format           text not null check (format in ('league','knockout')),
  token_hash       text not null unique,
  token_enc        bytea not null,
  visitor_hash     text not null,
  email            text null,
  locale           text not null default 'en',
  last_activity_at timestamptz not null default now(),
  expires_at       timestamptz null,
  reminder_sent_at timestamptz null,
  saved_by_user_id uuid null references users (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index quick_matches_visitor_hash_idx     on quick_matches (visitor_hash);
create index quick_matches_saved_by_user_id_idx on quick_matches (saved_by_user_id);
create index quick_matches_expires_at_idx       on quick_matches (expires_at);

alter table quick_matches enable row level security;
alter table quick_matches force  row level security;
create policy quick_matches_tenant on quick_matches for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on quick_matches to app_user;
