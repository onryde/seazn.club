-- V560, Online Chess credits (spec docs/superpowers/specs/2026-11-23-online-chess-credits-design.md §7.1): the package table.
--
-- division_online_packages: one row per online chess division, the size the organiser chose (the division's entrant limit)
-- and what was paid for it in Seazn credits. Four states and nothing else (§7.1):
--   Unpaid    paid_at null, frozen_at null   a size is chosen; it is the entrant limit; round 1 cannot open
--   Paid      paid_at set,  frozen_at null   upgradable, refundable
--   Frozen    frozen_at set                  a round has opened; nothing changes (frozen + unpaid = grandfathered below)
--   Refunded  refunded_at set                history; not live
-- Written ONLY on the privileged pool (sql.begin, openRound's transaction, withTenant's privilegedEpilogue); the tenant role
-- READS it (the cap doors and the rules strip run as app_user), so it gets one org-scoped select policy and no write grant.
--
-- The rest of §7.1 is V561 (online_chess_stream_credits): the ledger's link to this table and the sealed
-- stream_pack_reversals. It is its own delta because it changes the stream credit ledger, and every delta that changes a
-- stream table belongs to the relay suite's stream fold (relay/__tests__/rls-static.test.ts), whose scans refuse any
-- policy or grant; this table's tenant read policy keeps THIS delta out of the fold, as V492's tenant tables are kept.
--
-- No grant on the ledger is widened and no security definer function is added (plan Global Constraints).

create table division_online_packages (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  -- set null, never cascade: a PAID row is the record of a payment and outlives the division.
  division_id       uuid null references divisions(id) on delete set null,
  division_name     text not null,             -- snapshot, for the credit history after a delete
  size              integer not null,
  cameras_paid      boolean null,              -- null until paid; true = the camera price was paid
  credits_paid      integer not null default 0, -- everything ever debited; only ever grows
  credits_refunded  integer not null default 0, -- everything returned to the balance
  credits_forfeited integer not null default 0, -- included credits that could not return, their month had ended (P6)
  paid_at           timestamptz null,          -- first payment; null = unpaid
  paid_by           uuid null,                 -- the organiser who paid; shown in the credit history
  frozen_at         timestamptz null,          -- first round opened (P8); null = still changeable
  refunded_at       timestamptz null,          -- set once, with the refund rows
  created_at        timestamptz not null default now(),
  -- The ladder (owner decision 2). A stored 0 or 48 is impossible, so no reader has to guard a price of 0.
  constraint division_online_packages_size_check check (size in (16, 32, 64, 128, 256)),
  constraint division_online_packages_credits_paid_check check (credits_paid >= 0),
  constraint division_online_packages_credits_refunded_check check (credits_refunded >= 0),
  constraint division_online_packages_credits_forfeited_check check (credits_forfeited >= 0),
  -- Paid means credits were debited, and the camera choice was recorded with them.
  constraint division_online_packages_paid_credits_check check ((paid_at is null) = (credits_paid = 0)),
  constraint division_online_packages_paid_cameras_check check ((paid_at is null) = (cameras_paid is null)),
  -- Nothing returns or is forfeited beyond what was debited.
  constraint division_online_packages_returned_check check (credits_refunded + credits_forfeited <= credits_paid),
  -- Only a paid row can be refunded.
  constraint division_online_packages_refunded_paid_check check (refunded_at is null or paid_at is not null),
  -- A payment names its payer, and only a payment does.
  constraint division_online_packages_paid_by_check check ((paid_at is null) = (paid_by is null)),
  -- refunded_at is the FULL refund (a move down leaves it null): everything debited came back or was forfeited.
  constraint division_online_packages_refunded_in_full_check
    check (refunded_at is null or credits_refunded + credits_forfeited = credits_paid),
  -- A frozen row is never refunded (P7: refundable only while no round has opened).
  constraint division_online_packages_frozen_refunded_check check (frozen_at is null or refunded_at is null),
  -- Frozen and unpaid is the grandfathered row of the backfill below, and only that: the backfill writes frozen_at = now()
  -- and created_at defaults to now(), the same instant in one transaction. Any later freeze needs a payment.
  constraint division_online_packages_frozen_unpaid_check
    check (paid_at is not null or frozen_at is null or frozen_at = created_at)
);
-- At most ONE live package per division. A refunded one stays as history.
create unique index division_online_packages_live
  on division_online_packages (division_id) where refunded_at is null and division_id is not null;
-- The foreign keys' own lookups: a division delete sets division_id null on EVERY row naming it (refunded history
-- included, which the partial index above does not hold), and an org delete cascades by org_id; the credit history
-- lists an org's packages newest first.
create index division_online_packages_division_idx on division_online_packages (division_id);
create index division_online_packages_org_idx on division_online_packages (org_id, created_at);

alter table division_online_packages enable row level security;
alter table division_online_packages force  row level security;
-- READ by the tenant role, org-scoped, in V271's idiom (competition_passes: the neighbouring read-only tenant table).
-- No write grant: every write runs on the privileged pool.
create policy division_online_packages_read on division_online_packages for select to app_user
  using (org_id = current_org_id());
grant select on division_online_packages to app_user;

-- Existing online divisions (census 2026-11-23: prod has none). One row each, so "online with no row" cannot exist.
-- Online = online-play.ts divisionPlaysOnline: a boardgame division with config.onlinePlay 'lichess'.
--   No round opened: unpaid, at the smallest ladder size holding the places held (P14, computed ONCE, here). Places held
--     is online-entrant-cap.ts onlineHeldSql: live entrants (not withdrawn or disqualified) plus sign-ups that hold a
--     place (pending, paid, confirmed) and are not entrants yet and not free agents. A division already over the online
--     cap of 256 (stored before the cap) has no size that holds it; it gets 256 and reads as full, as the cap reads it.
--   A round already opened (any stage_round_opens row: P8, not anyRoundOpened's `opened_at <= now`): size 256,
--     frozen_at = now(), unpaid. Grandfathered: never asked to pay.
-- schema.test.ts runs the statement between the two markers below against real divisions.
-- @backfill-begin
insert into division_online_packages (org_id, division_id, division_name, size, frozen_at)
select d.org_id,
       d.id,
       d.name,
       case
         when opened.any_open then 256
         when held.n <= 16 then 16
         when held.n <= 32 then 32
         when held.n <= 64 then 64
         when held.n <= 128 then 128
         else 256
       end,
       case when opened.any_open then now() end
  from divisions d
  cross join lateral (
    select (select count(*) from entrants e
             where e.division_id = d.id and e.status not in ('withdrawn', 'disqualified'))
         + (select count(*) from registrations r
             where r.division_id = d.id and r.status in ('pending', 'paid', 'confirmed')
               and r.entrant_id is null and r.free_agent = false) as n
  ) held
  cross join lateral (
    select exists (select 1 from stage_round_opens o join stages s on s.id = o.stage_id
                    where s.division_id = d.id) as any_open
  ) opened
 where d.sport_key = 'boardgame'
   and d.config ->> 'onlinePlay' = 'lichess';
-- @backfill-end
