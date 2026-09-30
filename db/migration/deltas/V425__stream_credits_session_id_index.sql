-- V425 — Streaming R1: index org_stream_credits.session_id.
--
-- Lane D (owner-approved, 2026-09-29). V410 indexed the ledger by
-- (org_id, created_at) and by stripe_checkout_session_id, never by session_id,
-- and three readers look a session's rows up by it:
--   * the organiser's poll — stream-sessions.ts `currentSession` sums the
--     session's consume + refund rows for the `creditUsed` fact (lane D D3) on
--     every 5-second read of the Phone tab. It filters org_id too, so today it
--     walks every row the org has ever written through (org_id, created_at);
--   * the credit writer — stream-credits.ts sums a session's consume and refund
--     rows before it writes a linked refund, and `reuseWindowOpen` does the same
--     per consume row it considers;
--   * the foreign key itself — session_id references fixture_stream_sessions
--     with no ON DELETE action, so every delete of a session row (the ingest
--     refusal's cleanup in `provisionSession`) checks this table for a
--     referencing row, with no org in that predicate. Without an index that
--     check is a scan of the whole ledger, every org's, which only grows.
--
-- PARTIAL on `session_id is not null`: purchases, grants and unlinked refunds
-- carry no session and are never looked up by one, so they stay out of it — the
-- same shape V410 gave stripe_checkout_session_id. migration-shape.test.ts
-- reads the index back from pg_indexes.
--
-- A FORWARD delta, not an amend: V410 is merged. CREATE INDEX (not
-- CONCURRENTLY — Flyway runs each delta in a transaction) takes a SHARE lock
-- that blocks ledger writes for the build. Streaming is dark, so the ledger is
-- small and the build instant — V420's argument for doing it now.
create index org_stream_credits_session_id
  on org_stream_credits (session_id)
  where session_id is not null;
