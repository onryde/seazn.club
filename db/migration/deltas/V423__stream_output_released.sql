-- V423 — Streaming R1: "this passthrough session's Cloudflare output is gone".
--
-- The gap (lane C final review C1, Critical): a passthrough broadcast is
-- Cloudflare simulcasting the phone's live input to the organiser's destination
-- through the ONE output the session added (`add_output`, persisted as
-- output_uid — Dg). Nothing ever removed it. Stop, the wall clock, a credit
-- refusal and every failure marked the ROW terminal while the stream kept
-- going: unpaid after `no_credits`, still public after an organiser's Stop, and
-- the next fixture on the same destination added a SECOND output to the same
-- key while the first phone still published.
--
-- Every passthrough decision that lands in a terminal state now emits
-- `release_output` (server/relay/domain/session.ts, one predicate), and the
-- usecase removes the output through IngestProvider.removeOutput — the output,
-- never the input, which carries the recording (C2). output_released_at records
-- that the removal was CONFIRMED (a 404 counts: the output is gone either way).
-- A removal that fails leaves it null; the daily sweep and the next admission on
-- the same destination retry every terminal passthrough row whose output_uid is
-- set and whose output_released_at is null.
--
-- One CHECK, two halves: released only on a TERMINAL row (a live broadcast is
-- never "released" — the mark would let both retries skip an output still
-- streaming), and only on a row that HELD an output (nothing added, nothing to
-- release). The state list is the domain's TERMINAL_STATES, exactly as V422's
-- CHECK; migration-shape.test.ts sweeps ACTIVE_STATES and TERMINAL_STATES rather
-- than a typed list. A session never leaves a terminal state and output_uid is
-- only ever set once (coalesce), so the CHECK cannot strand a row.
--
-- A FORWARD delta, not an amend: V410 is merged (PR #812). Nullable with no
-- default, so it rewrites no rows: every existing row reads "not released",
-- which is the truth — nothing has ever removed an output.
alter table fixture_stream_sessions
  add column output_released_at timestamptz null
  constraint fixture_stream_sessions_output_released
    check (output_released_at is null or (output_uid is not null and state in ('completed','failed')));
