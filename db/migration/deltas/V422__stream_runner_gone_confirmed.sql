-- V422 — Streaming R1: the daily sweep's "this session's Machine is gone" mark.
--
-- The gap (lane C amendment A22(c), Task 10 minor n1): admission runs Task 12's
-- orphan rule lazily for its fixture and destination (stream-sessions.ts
-- tearDownPriorMachines) — every TERMINAL composed session there that ever held
-- a runner makes admission call the runner provider's list. A Fly outage then
-- 500s every start on that fixture, PASSTHROUGH starts included, long after the
-- old Machine was destroyed, because nothing on the row says the destroy was
-- ever CONFIRMED. `runner_state = 'destroyed'` is not that confirmation: F-A's
-- grace-forced completion sets it when the DELETE was only ISSUED.
--
-- runner_gone_confirmed_at is written ONLY by the daily sweep
-- (server/usecases/relay-sweep.ts), on a terminal composed row whose runner is
-- `destroyed` when the provider's own listing — read in the same pass, after
-- the pass destroyed every listed Machine of a terminal session — no longer
-- lists a Machine for it. Admission skips the provider for a row that is
-- `destroyed` AND carries the mark. It is CLEARED by a forced destroy that
-- fails for that session (a late create's Machine the row never learned), and
-- a row whose runner leaves `destroyed` (a late create_ok: destroyed → lost) is
-- no longer skipped whatever the column holds, because the skip reads both.
--
-- Terminal rows only, by CHECK: an active session's Machine is never "gone" in
-- this sense — it is being created, used or retried — and a mark there would
-- let admission skip a Machine that is about to exist. The state list is the
-- domain's TERMINAL_STATES (server/relay/domain/session.ts); a state added
-- there owes an edit here, which migration-shape.test.ts pins by sweeping
-- ACTIVE_STATES and TERMINAL_STATES rather than a typed list. A session never
-- leaves a terminal state, so the CHECK cannot strand a row.
--
-- A FORWARD delta, not an amend: V410 is merged (PR #812, merge b392be909) and
-- Flyway refuses an edited applied migration. Nullable with no default, so it
-- rewrites no rows: every existing row simply reads "not confirmed", which is
-- what admission did before this column existed.
alter table fixture_stream_sessions
  add column runner_gone_confirmed_at timestamptz null
  constraint fixture_stream_sessions_runner_gone_terminal
    check (runner_gone_confirmed_at is null or state in ('completed','failed'));
