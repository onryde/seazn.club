-- V449 — Relay Release 2, R2003b: the crash-loop cap's tally (owner approval 2026-10-16: a session fails as
-- `machine_crash` after RUNNER_CRASH_CAP = 3 fatal crashes, and spends no retry).
--
-- Why it is needed (compositor `_FINDINGS.md` F-007): Fly's `restart: on-failure` counts `max_retries` per 5-minute
-- window and refills it after ~330 s of healthy run, so a compositor that crashes more slowly than that is restarted in
-- place forever — about 120 restarts across a 300-minute match. Nothing on the row counted them.
--
-- What each column holds (server/relay/domain/runner.ts `CrashTally` is the authority, and the only writer is
-- stream-sessions.ts `persist`, which writes what `decide` returned):
--   * runner_crash_count   — the SESSION's crashes, summed over its attempts (it spans the ONE retry). The cap reads it.
--   * runner_crash_beats   — THIS attempt's final beats that said `exitReason: fatal` (C07: one per run, never retried).
--   * runner_crash_exits   — THIS attempt's crash exits the provider recorded, one per distinct exit instant and never
--                            below the provider's own restart count.
--   * runner_crash_exit_at — the provider's instant of the newest crash exit counted: the identity that keeps a second
--                            read of the same exit from counting it again.
-- An attempt's crashes are max(beats, exits), never their sum: a crash seen both ways (its final beat and its exit)
-- is one crash, whichever arrives first. The two per-attempt columns reset when the next attempt is created; the
-- count and the exit identity do not.
--
-- The CHECK is the domain's invariant held by the table too: the session's count includes the current attempt's.
-- Every existing row reads 0/0/0/null, which is what it was before: nothing had counted a crash.
alter table fixture_stream_sessions
  add column runner_crash_count   smallint not null default 0 check (runner_crash_count >= 0),
  add column runner_crash_beats   smallint not null default 0 check (runner_crash_beats >= 0),
  add column runner_crash_exits   smallint not null default 0 check (runner_crash_exits >= 0),
  add column runner_crash_exit_at timestamptz null,
  add constraint fixture_stream_sessions_crash_tally
    check (runner_crash_count >= greatest(runner_crash_beats, runner_crash_exits));
