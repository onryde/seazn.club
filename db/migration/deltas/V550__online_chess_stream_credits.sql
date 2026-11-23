-- V550, Online Chess credits (spec docs/superpowers/specs/2026-11-23-online-chess-credits-design.md §7.1, §7.5): the stream
-- credit ledger's side. V549 created division_online_packages; this delta is apart from it only because it changes the
-- ledger, so it belongs to the relay suite's stream fold (its name says `stream`), whose scans hold every folded table to
-- V410's pattern: RLS enabled AND forced, no policy, no grant to app_user (relay/__tests__/rls-static.test.ts,
-- migration-shape.test.ts).
--
-- 1. org_stream_credits.online_package_id: a package debit is a `consume` row and a package return a `refund` row, each
--    naming the package and no stream session (spec §7.1). The ledger's reason CHECK is unchanged, and so are its RLS and
--    its grants: none is widened.
-- 2. stream_pack_reversals: the durable record THAT a pack's card payment was refunded or disputed, one row per intent, so
--    a refunded package can settle a claw-back that fell short (§7.5). It is not a debt. Money state: sealed exactly as
--    org_stream_credits is (V410): RLS forced, no policy, no grant to app_user; exempt by name in scripts/rls-exempt.ts.

alter table org_stream_credits
  add column online_package_id uuid null references division_online_packages(id),
  -- A row moves credits for a stream session OR for a package, never both.
  add constraint org_stream_credits_one_subject
    check (session_id is null or online_package_id is null),
  -- A package row is a debit (`consume`) or a return (`refund`), and the platform writes it: a null created_by on a refund
  -- is how the stream code tells a platform refund from staff (stream-credits.ts). Every existing row passes: the column is
  -- added by this same statement, so it is null on all of them.
  add constraint org_stream_credits_package_row_check
    check (online_package_id is null or (reason in ('consume', 'refund') and created_by is null));
-- Partial, V425's shape for session_id: only package rows are ever looked up by package (the package's own ledger read,
-- and the foreign key's check when an unpaid row is deleted).
create index org_stream_credits_online_package_id
  on org_stream_credits (online_package_id) where online_package_id is not null;

create table stream_pack_reversals (
  stripe_payment_intent_id text primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  purchased  integer not null,
  created_at timestamptz not null default now(),
  constraint stream_pack_reversals_purchased_check check (purchased > 0)
);
-- The settle step reads an org's reversals oldest first (§7.5).
create index stream_pack_reversals_org_idx on stream_pack_reversals (org_id, created_at);
alter table stream_pack_reversals enable row level security;
alter table stream_pack_reversals force  row level security;
