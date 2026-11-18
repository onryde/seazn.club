-- V530 — a session the compositor ended by itself records its own end reason. Renumber at merge if main has moved past.
--
-- WHY. A composed runner's final beat can say `exitReason: ended` while nobody asked it to end: no organiser Stop, no
-- Stream switch turned off, no automatic stop after the result, no phone gone (each of those ends the session FIRST, so the
-- session already holds its own reason and keeps it). That unsolicited end was stored as `stopped` — the organiser's own
-- Stop — and the match's Stream panel read "Stopped by you" for a stop nobody made (court stream follow-up, device check
-- 2026-11-17). It now stores `relay_ended`, and the panel reads "Stream stopped unexpectedly".
--
-- WHAT. fixture_stream_sessions_end_reason_check (V430's list) is dropped and re-added under the SAME name in one alter,
-- V430's five copied exactly with 'relay_ended' added. fixture_stream_sessions_end_reason_state (end_reason only in
-- ending/completed) is unchanged. No row is rewritten: a past self-exit stored `stopped` stays as it was (no backfill, owner
-- 2026-11-16).
--
-- Added NOT VALID and validated in its own statement: the add takes only a brief lock (no scan under ACCESS EXCLUSIVE), and the
-- VALIDATE scans existing rows under SHARE UPDATE EXCLUSIVE, which lets reads and writes go on.
alter table fixture_stream_sessions
  drop constraint fixture_stream_sessions_end_reason_check,
  add constraint fixture_stream_sessions_end_reason_check
    check (end_reason in ('stopped','operator_stopped','auto_stopped','phone_lost','max_duration','relay_ended')) not valid;
alter table fixture_stream_sessions validate constraint fixture_stream_sessions_end_reason_check;
