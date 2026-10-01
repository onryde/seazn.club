-- V427 (feat/fixture-page-stream, spec 2026-09-30 §5.1, owner ruling D2): Remove = ARCHIVE.
-- A removed destination is hidden forever but never deleted: fixture_stream_sessions.target_id keeps NO ACTION, so
-- history and money rows keep the destination they streamed to. Re-adding the same key un-archives the most recent
-- archived row (server/relay/secret-columns.ts insertStreamTarget).
alter table org_stream_targets add column archived_at timestamptz null;

-- The one-destination-per-org index (V421, A19) becomes partial on ACTIVE rows too, keeping V421's own predicate, so an
-- archived row never blocks a new or re-keyed destination. insertStreamTarget's ON CONFLICT names this exact predicate
-- to INFER the index (a drifted predicate is 42P10); migration-shape.test.ts pins it as text.
drop index org_stream_targets_org_dest_fingerprint;
create unique index org_stream_targets_org_dest_fingerprint
  on org_stream_targets (org_id, dest_fingerprint)
  where dest_fingerprint is not null and archived_at is null;
