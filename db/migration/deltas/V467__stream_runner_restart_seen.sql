-- V467 — Relay Release 2, Owed 66 (compositor `docs/_INDEX.md`, C11b): the compositor's IN-PLACE RESTART (final beat
-- `exitReason: "restart"`, exit 75) is not a crash, so R2003b's crash tally must not count it.
--
-- Why a column: Fly's `restart_count` counts every non-zero exit in its window — restarts included — and the tally floors an
-- attempt's crash exits at it (F-007). "Restart, restart, crash" in one window then reads restart_count 2 on the crash's final
-- exit, a floor of 3 crashes, and RUNNER_CRASH_CAP (3) fails the session after ONE crash. The tally has to remember that this
-- attempt has READ a restart's exit (server/relay/domain/runner.ts `CrashTally.restartSeen`, the only writer is
-- stream-sessions.ts `persist`, which writes what `decide` returned) so the floor stops counting it. Nothing in the existing
-- columns can say so: the newest exit is the only one an observation carries.
--
--   * runner_crash_restart_seen — THIS attempt has read an exit 75. Idempotent (a re-read sets it again); reset with the
--                                 attempt's other per-attempt evidence when the next attempt is created (a replacement
--                                 Machine has a Fly window of its own). The session's count does not depend on it.
--
-- Every existing row reads false, which is what it was before: no restart was ever recognised as one. No CHECK: it is a flag.
alter table fixture_stream_sessions
  add column runner_crash_restart_seen boolean not null default false;
