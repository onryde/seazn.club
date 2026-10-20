-- V468 — Relay Release 2, Owed 67 (OWNER RULING 2026-10-20): the compositor's in-place self-restarts are capped at
-- RUNNER_RESTART_CAP = 6 per stream session; the 7th restart ends the session, through the crash cap's own path
-- (failed `machine_crash`, the Machine force-destroyed, no retry spent).
--
-- Why a cap is owed (compositor `docs/_INDEX.md` Owed 66/67; V467): a restart is not a crash, so R2003b's RUNNER_CRASH_CAP no
-- longer counts it — and a compositor stuck restarting itself every ~165 s then had NO bound: Fly's per-window restart budget
-- refills (~330 s), so the viewers got a ~15 s outage every few minutes for the rest of the stream.
--
-- What each column holds (server/relay/domain/runner.ts `RestartTally` is the authority — the crash tally's twin, V450 — and
-- the only writer is stream-sessions.ts `persist`, which writes what `decide` returned):
--   * runner_restart_count   — the SESSION's restarts, summed over its attempts (it spans the ONE retry). The cap reads it:
--                              a session survives RUNNER_RESTART_CAP and the next restart ends it.
--   * runner_restart_beats   — THIS attempt's `restart` final beats the lifecycle was handed (C07: one per run, never retried).
--   * runner_restart_exits   — THIS attempt's restart exits (75) the provider recorded, one per distinct exit instant.
--   * runner_restart_exit_at — the provider's instant of the newest restart exit counted: the identity that keeps a second
--                              read of the same exit from counting it again.
-- An attempt's restarts are max(beats, exits), never their sum: a restart seen both ways (its final beat and its exit) is one
-- restart, whichever arrives first. The two per-attempt columns reset when the next attempt is created; the count and the
-- exit identity do not. The crash tally (runner_crash_*) is independent: neither cap moves the other.
--
-- The CHECK is the domain's invariant held by the table too: the session's count includes the current attempt's.
-- Every existing row reads 0/0/0/null, which is what it was before: nothing had counted a restart.
alter table fixture_stream_sessions
  add column runner_restart_count   smallint not null default 0 check (runner_restart_count >= 0),
  add column runner_restart_beats   smallint not null default 0 check (runner_restart_beats >= 0),
  add column runner_restart_exits   smallint not null default 0 check (runner_restart_exits >= 0),
  add column runner_restart_exit_at timestamptz null,
  add constraint fixture_stream_sessions_restart_tally
    check (runner_restart_count >= greatest(runner_restart_beats, runner_restart_exits));
