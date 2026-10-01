-- V428 (feat/fixture-page-stream, final review I-1): the organiser poll's CLAIM on a session's Cloudflare reads.
-- Every open organiser tab polls `current` every STREAM_POLL_MS (5 s), and each poll read the live input and its outputs
-- from Cloudflare: N tabs cost N × 2 reads per 5 s against an account-wide API limit. A poll now claims the read with a
-- conditional write on this column (stream-sessions.ts claimIngestPoll); a poll that finds a claim younger than the
-- claim window (STREAM_POLL_MS less a jitter allowance) reads nothing and answers from the latest poll sample. The row lock of that UPDATE is what makes two
-- concurrent claims race-safe. Null until the first claim; written on each claimed poll, never read for anything else.
alter table fixture_stream_sessions add column ingest_polled_at timestamptz null;
