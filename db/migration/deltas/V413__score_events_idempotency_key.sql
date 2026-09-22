-- =============================================================================
-- W2 — durable idempotency (design 2026-09-21 §6).
--
-- Before this, "was this tap already recorded?" was answered by a FAIL-OPEN
-- Redis cache (usecases/scoring.ts: IDEM_TTL_SECONDS = 24h, key `idemv1:`).
-- On a cache miss, a Redis outage, an Upstash eviction, or any retry more than
-- 24h late, the same tap was recorded TWICE with no constraint to catch it —
-- corruption on the money path that an umpire cannot distinguish after the
-- fact. The client resends the same key deliberately (scorepad/pipeline.ts),
-- so the whole replay protocol rested on that cache holding.
--
-- The database becomes the arbiter. Redis may stay in front as a fast path;
-- it stops being load-bearing for correctness. Rate limiting STAYS in Redis —
-- there, fail-open means "allow", which is the safe direction for a scorer.
--
-- NULLABLE on purpose: every existing row has no key, and the batch importer
-- and the rebuild paths legitimately write without one. Postgres treats NULLs
-- as DISTINCT in a unique index by default, so unlimited un-keyed rows per
-- fixture stay legal. Do NOT add `nulls not distinct` — that would refuse
-- every un-keyed write after the first.
--
-- NOT in the hash-chain canonical: V226's `score_events_hash_chain` names its
-- columns explicitly (id|fixture_id|seq|type|payload|voids_event_id|
-- recorded_by|recorded_at), so adding one here changes no existing row's
-- `row_hash`. Same treatment `device_link_id` gets.
-- =============================================================================
alter table score_events add column if not exists idempotency_key text;

-- The whole point of the wave. Scoped to the FIXTURE, not global: two scorers
-- on two courts can mint the same client-side key, and a global index would
-- refuse the second one's perfectly legitimate write.
create unique index if not exists score_events_idem_key
  on score_events (fixture_id, idempotency_key);
