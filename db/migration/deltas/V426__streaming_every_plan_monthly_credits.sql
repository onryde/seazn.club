-- =============================================================================
-- V426 — Streaming R1 lane D, Task 14b: live streaming on EVERY plan, plus
-- monthly free match credits (owner-approved 2026-09-29: "remove it, no
-- enterprise, even community can do livestreaming by default credit per month
-- or buy adds' on").
--
-- A FORWARD delta. V402 (the dark-rollout rows) and V410 (org_stream_credits)
-- are merged and are not amended; this file changes what they left behind.
-- Next number re-derived at write time: the tree's tail and `git log --all`'s
-- tail are both V425__stream_credits_session_id_index.sql.
--
-- 1. `streaming.overlay` and `streaming.relay` become TRUE for every plan.
--    Derived from `plans`, exactly as V402 was, so a tier added later is not
--    left behind. An `org_entitlement_overrides` row can still switch either
--    key off for one org (the resolver ranks it first, lib/entitlements.ts) —
--    that is now the ONLY way a streaming gate appears.
--
-- 2. `streaming.credits.monthly` — the free match credits each plan grants per
--    calendar month (UTC), in `ai.credits.monthly`'s storage shape (V320:57,
--    bool_value NULL, int_value N). The owner's values, verbatim:
--      community 1 · pro 5 · enterprise 20 · event_pass 1 · event_pass_l 5
--    Read by server/usecases/stream-credits.ts `streamMonthlyRateByPlan`, the
--    ONE place the rate is read. Monthly credits EXPIRE at month end; bought
--    packs and staff grants never do. 1 credit = 1 match (≤ 5 h), unchanged.
--    Like the two keys above, it is NOT added to ENTITLEMENT_DOMAINS
--    (lib/entitlement-domains.ts), so /pricing does not list it — /pricing is an
--    owner question, out of this task's scope.
--
-- 3. `org_stream_credits.bucket` — 'monthly' or 'pack'. Every existing row
--    backfills to 'pack' through the column default. ADD COLUMN ... DEFAULT
--    with a constant is catalogue-only in Postgres 11+ (no table rewrite), but
--    a CHECK written inline on that ADD COLUMN is not: it validates every row
--    with a full scan while the ALTER holds ACCESS EXCLUSIVE (measured on PG17,
--    Task 14b review M1: 2M rows, 247 ms with the inline CHECK, 1 ms without).
--    So the CHECK is added NOT VALID — catalogue-only, enforced for every new
--    and updated row from that instant — and then VALIDATEd as its own step,
--    which scans under SHARE UPDATE EXCLUSIVE: writers keep writing while it
--    reads. Every row written before this migration is a purchase, a consume of a
--    purchase, a staff grant/refund/revoke, or a claw-back — none of them
--    monthly. Which writer writes which bucket is stream-credits.ts's contract:
--      grant (monthly)  → 'monthly', idempotency_key stream-monthly:{org}:{YYYY-MM}
--      expire           → 'monthly' (the month's leftover, before the new grant)
--      consume          → 'monthly' while the monthly balance is above 0, else 'pack'
--      refund (linked)  → the bucket of the consume it reverses
--      refund (goodwill), purchase, staff grant, revoke → 'pack'
--    `balance_after` keeps its meaning: the ORG total, ≥ 0 (V410's CHECK).
-- =============================================================================

update plan_entitlements
   set bool_value = true, int_value = null
 where feature_key in ('streaming.overlay', 'streaming.relay');

-- A plan V402 somehow missed still gets its row (V402's own insert form).
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p.key, k.feature_key, true, null
from plans p
cross join (values ('streaming.overlay'), ('streaming.relay')) as k(feature_key)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Joined to `plans` so a key absent from this database (none today) is skipped
-- rather than failing the plan_entitlements -> plans foreign key.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select v.plan_key, 'streaming.credits.monthly', null, v.n
from (values
  ('community',    1),
  ('pro',          5),
  ('enterprise',   20),
  ('event_pass',   1),
  ('event_pass_l', 5)
) as v(plan_key, n)
join plans p on p.key = v.plan_key
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

alter table org_stream_credits
  add column bucket text not null default 'pack';

alter table org_stream_credits
  add constraint org_stream_credits_bucket_check
    check (bucket in ('monthly', 'pack')) not valid;

alter table org_stream_credits
  validate constraint org_stream_credits_bucket_check;

comment on column org_stream_credits.bucket is
  'Which pool the row moves (V426): monthly = the plan''s free match credits for one UTC calendar month '
  '(grant rows keyed stream-monthly:{org}:{YYYY-MM}; the leftover expires before the next month''s grant); '
  'pack = bought packs and staff grants, which never expire. A consume draws monthly first; a linked refund '
  'returns to its consume''s bucket; a revoke is pack. balance_after is still the ORG total.';
